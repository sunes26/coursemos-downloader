/**
 * 공유 추출 유틸리티 (content script + offscreen 문서에서 함께 사용).
 *
 * LMS 페이지는 플레이어 설정을 태그 속성에 JSON으로 넣어두는 경우가 많다.
 * 이때 URL은 HTML 엔티티(&quot;)와 JSON 이스케이프(\/)가 이중으로 적용되어 있어
 * 원본 텍스트에 정규식을 그대로 적용하면 찾지 못한다.
 *
 * 예) 인천대학교 LMS (lms.inu.ac.kr/mod/vod/viewer.php)
 *   <div id="my-video" data-setup-lazy="{&quot;src&quot;:&quot;https:\/\/...\/index.m3u8&quot;}">
 *
 * 클래식 스크립트로 로드되며 globalThis.CMX 네임스페이스에 붙는다.
 */
(function (root) {
  'use strict';

  var M3U8_PATTERN = /https?:\/\/[^\s'"<>\\]+\.m3u8[^\s'"<>\\]*/g;
  var MPD_PATTERN = /https?:\/\/[^\s'"<>\\]+\.mpd[^\s'"<>\\]*/g;

  // 확장자 뒤가 경로 끝이거나 쿼리여야 한다.
  // 그래야 ".../abc.mp4/index.m3u8" 같은 HLS 경로를 파일로 오인하지 않는다.
  var MEDIA_FILE_PATTERN =
    /https?:\/\/[^\s'"<>\\]+\.(?:mp4|m4v|webm|mov|mkv|m4a|mp3)(?![\w\/])[^\s'"<>\\]*/g;

  // fMP4 조각은 확장자가 .mp4여도 단독 재생이 안 되므로 제외한다
  var SEGMENT_LIKE = /(?:^|[\/_-])(?:init|chunk|seg|segment|frag)[^\/]*$|[_-]\d{1,6}\.(?:mp4|m4v|m4s|m4a)(?=$|[?#])/i;
  var INVALID_FILENAME_CHARS = /[\\/*?:"<>|\r\n\t]/g;
  var TITLE_SUFFIX_SEPARATORS = ['|', '｜', ' - '];
  var MAX_FILENAME_LENGTH = 80;

  /** HTML 엔티티와 JSON 이스케이프를 풀어 정규식 검색이 가능한 형태로 만든다. */
  function normalizeHtml(text) {
    if (!text) return '';
    return decodeEntities(text)
      .replace(/\\\//g, '/')
      .replace(/\\u002[fF]/g, '/');
  }

  /** DOMParser 없이 동작해야 하므로 자주 쓰이는 엔티티만 직접 치환한다. */
  function decodeEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#0?34;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x2F;/gi, '/')
      .replace(/&#0?47;/g, '/')
      .replace(/&amp;/g, '&');
  }

  /** 텍스트에서 m3u8 URL 목록을 뽑는다 (등장 순서 유지, 중복 제거). */
  function extractM3u8Urls(text) {
    return matchAll(text, M3U8_PATTERN);
  }

  function matchAll(text, pattern) {
    if (!text) return [];
    var found = [];
    var current = text;
    // 엔티티가 두 번 인코딩된 경우(&amp;quot;)까지 대응하기 위해 두 단계로 정규화
    for (var pass = 0; pass < 2; pass++) {
      current = normalizeHtml(current);
      var matches = current.match(pattern);
      if (matches) found = found.concat(matches);
    }
    return dedupe(found);
  }

  function dedupe(urls) {
    var seen = Object.create(null);
    var unique = [];
    for (var i = 0; i < urls.length; i++) {
      var url = urls[i].replace(/[\\,;)]+$/, '');
      if (url && !seen[url]) {
        seen[url] = true;
        unique.push(url);
      }
    }
    return unique;
  }

  /** DASH 매니페스트(.mpd) URL을 뽑는다. */
  function extractMpdUrls(text) {
    return matchAll(text, MPD_PATTERN);
  }

  /**
   * 통째로 받을 수 있는 미디어 파일 URL을 뽑는다.
   * HLS/DASH 조각처럼 단독으로 재생되지 않는 것은 걸러낸다.
   */
  function extractMediaFileUrls(text) {
    return matchAll(text, MEDIA_FILE_PATTERN).filter(function (url) {
      return !SEGMENT_LIKE.test(url.split(/[?#]/)[0]);
    });
  }

  /** URL을 보고 어떤 방식으로 받아야 하는지 판별한다. */
  function classifyUrl(url) {
    if (!url) return null;
    var path = String(url).split(/[?#]/)[0];
    if (/\.m3u8$/i.test(path)) return 'hls';
    if (/\.mpd$/i.test(path)) return 'dash';
    if (/\.(?:mp4|m4v|webm|mov|mkv|m4a|mp3)$/i.test(path)) return 'file';
    // 확장자가 없는 플레이리스트도 있으므로 경로 힌트를 본다
    if (/\.m3u8/i.test(url)) return 'hls';
    if (/\.mpd/i.test(url)) return 'dash';
    return null;
  }

  /** 직접 받는 파일의 확장자를 URL에서 얻는다. */
  function fileExtensionOf(url) {
    var path = String(url || '').split(/[?#]/)[0];
    var match = /\.([a-z0-9]{2,4})$/i.exec(path);
    return match ? match[1].toLowerCase() : 'mp4';
  }

  /** 파일명에 쓸 수 없는 문자를 없애고 길이를 제한한다. */
  function sanitizeFilename(name, maxLength) {
    var limit = maxLength || MAX_FILENAME_LENGTH;
    if (!name) return 'video';

    var cleaned = String(name)
      .replace(INVALID_FILENAME_CHARS, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '');

    if (!cleaned) return 'video';
    if (cleaned.length > limit) cleaned = cleaned.slice(0, limit).trim();
    return cleaned;
  }

  /**
   * 문서 제목에서 강의 차시명을 뽑는다.
   * LMS 제목은 보통 '과목명 : 차시명 | 학교 LMS' 형태다.
   */
  function extractPageTitle(rawTitle) {
    if (!rawTitle) return 'video';
    var title = decodeEntities(String(rawTitle)).trim();

    for (var i = 0; i < TITLE_SUFFIX_SEPARATORS.length; i++) {
      var sep = TITLE_SUFFIX_SEPARATORS[i];
      if (title.indexOf(sep) !== -1) title = title.split(sep)[0].trim();
    }
    if (title.indexOf(' : ') !== -1) {
      var parts = title.split(' : ');
      title = parts[parts.length - 1].trim();
    }
    return sanitizeFilename(title);
  }

  function resolveUrl(line, baseUrl) {
    if (/^https?:/i.test(line)) return line;
    try {
      return new URL(line, baseUrl).href;
    } catch (e) {
      return baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1) + line;
    }
  }

  /**
   * m3u8 플레이리스트를 파싱한다.
   * 마스터 플레이리스트면 variants를, 미디어 플레이리스트면 segments를 채운다.
   */
  function parsePlaylist(text, baseUrl) {
    var lines = text.split('\n').map(function (l) { return l.trim(); });
    var isMaster = /#EXT-X-STREAM-INF/.test(text);

    var result = {
      isMaster: isMaster,
      encrypted: /#EXT-X-KEY:(?!METHOD=NONE)/.test(text),
      variants: [],
      segments: [],
      totalDuration: 0
    };

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;

      if (isMaster) {
        if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
          var bw = /BANDWIDTH=(\d+)/.exec(line);
          var res = /RESOLUTION=(\d+x\d+)/.exec(line);
          var uri = lines[i + 1];
          if (uri && uri.charAt(0) !== '#') {
            result.variants.push({
              url: resolveUrl(uri, baseUrl),
              bandwidth: bw ? parseInt(bw[1], 10) : 0,
              resolution: res ? res[1] : null
            });
          }
        }
        continue;
      }

      if (line.indexOf('#EXTINF:') === 0) {
        var dur = parseFloat(line.slice(8));
        if (!isNaN(dur)) result.totalDuration += dur;
        continue;
      }
      if (line.charAt(0) === '#') continue;

      result.segments.push(resolveUrl(line, baseUrl));
    }

    // 대역폭이 가장 높은 variant를 앞에 둔다
    result.variants.sort(function (a, b) { return b.bandwidth - a.bandwidth; });
    return result;
  }

  /**
   * 세그먼트(.ts) URL 목록에서 플레이리스트 위치를 추론한다.
   *
   * 플레이리스트 요청을 놓쳤지만 세그먼트 요청은 보이는 경우를 위한 마지막 수단이다.
   * HLS는 관례상 플레이리스트와 세그먼트가 같은 디렉터리에 있다.
   * 우연히 걸린 .ts 하나에 반응하지 않도록 최소 개수를 넘긴 디렉터리만 쓴다.
   */
  function guessPlaylistsFromSegments(urls, minSegments) {
    var threshold = minSegments || 3;
    if (!urls || !urls.length) return [];

    var counts = Object.create(null);
    for (var i = 0; i < urls.length; i++) {
      var url = urls[i];
      if (!url || !/\.ts(\?|#|$)/.test(url)) continue;

      var withoutQuery = url.split(/[?#]/)[0];
      var slash = withoutQuery.lastIndexOf('/');
      if (slash === -1) continue;

      var dir = withoutQuery.slice(0, slash + 1);
      counts[dir] = (counts[dir] || 0) + 1;
    }

    return Object.keys(counts)
      .filter(function (dir) { return counts[dir] >= threshold; })
      .map(function (dir) { return dir + 'index.m3u8'; });
  }

  /** 초 단위를 mm:ss 또는 h:mm:ss로 표시한다. */
  function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '';
    var s = Math.round(seconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }

  root.CMX = {
    normalizeHtml: normalizeHtml,
    extractM3u8Urls: extractM3u8Urls,
    extractMpdUrls: extractMpdUrls,
    extractMediaFileUrls: extractMediaFileUrls,
    classifyUrl: classifyUrl,
    fileExtensionOf: fileExtensionOf,
    sanitizeFilename: sanitizeFilename,
    extractPageTitle: extractPageTitle,
    parsePlaylist: parsePlaylist,
    guessPlaylistsFromSegments: guessPlaylistsFromSegments,
    resolveUrl: resolveUrl,
    formatDuration: formatDuration,
    formatBytes: formatBytes
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
