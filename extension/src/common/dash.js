/**
 * DASH 매니페스트(.mpd) 파서.
 *
 * DOMParser를 쓰지 않는다. 서비스 워커에는 없고, Node 테스트에서도 못 쓰기 때문에
 * 필요한 만큼만 훑는 작은 스캐너를 직접 둔다. MPD 구조는 얕고 규칙적이라
 * 이 정도로 충분하다.
 *
 * MPD > Period > AdaptationSet > Representation
 *
 * DASH는 보통 영상과 소리를 **서로 다른 AdaptationSet**으로 나눠 담는다.
 * 그래서 하나의 MP4로 만들려면 두 트랙을 합치는 단계가 따로 필요하다.
 * (fmp4merge.js 참고)
 *
 * 클래식 스크립트로 로드되며 globalThis.CMXDash 네임스페이스에 붙는다.
 */
(function (root) {
  'use strict';

  /** ISO 8601 기간("PT1H2M3.5S")을 초로 바꾼다. */
  function parseDuration(text) {
    if (!text) return 0;
    var m = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/
      .exec(String(text).trim());
    if (!m) return 0;

    var days = (parseFloat(m[1]) || 0) * 365 + (parseFloat(m[2]) || 0) * 30 + (parseFloat(m[3]) || 0);
    return days * 86400 +
      (parseFloat(m[4]) || 0) * 3600 +
      (parseFloat(m[5]) || 0) * 60 +
      (parseFloat(m[6]) || 0);
  }

  /** 태그 하나의 속성 문자열을 {이름: 값} 으로 만든다. */
  function parseAttrs(attrText) {
    var attrs = {};
    var re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
    var m;
    while ((m = re.exec(attrText)) !== null) {
      if (m[1] !== undefined) attrs[m[1]] = m[2];
      else attrs[m[3]] = m[4];
    }
    return attrs;
  }

  /**
   * 주어진 XML 조각에서 특정 태그의 요소들을 찾아 반환한다.
   * 같은 태그가 중첩되는 경우까지 세어 짝을 맞춘다.
   */
  function findElements(xml, tag) {
    var results = [];
    // 속성부는 게으르게 잡아야 자기닫힘의 끝 '/'를 삼키지 않는다
    var pattern = '<(/?)' + tag + '((?:\\s[^>]*?)?)\\s*(/?)>';
    var open = new RegExp(pattern, 'g');
    var m;

    while ((m = open.exec(xml)) !== null) {
      if (m[1]) continue;               // </Tag> — 열림을 찾는 중이므로 건너뛴다

      var attrs = parseAttrs(m[2] || '');

      if (m[3]) {                       // <Tag ... />
        results.push({ attrs: attrs, inner: '' });
        continue;
      }

      var depth = 1;
      var scan = new RegExp(pattern, 'g');
      scan.lastIndex = open.lastIndex;
      var innerStart = open.lastIndex;
      var innerEnd = -1;
      var s;

      while ((s = scan.exec(xml)) !== null) {
        if (s[3]) continue;             // 자기닫힘은 깊이에 영향 없음
        depth += s[1] ? -1 : 1;
        if (depth === 0) { innerEnd = s.index; break; }
      }

      if (innerEnd === -1) innerEnd = xml.length;
      results.push({ attrs: attrs, inner: xml.slice(innerStart, innerEnd) });
      open.lastIndex = innerEnd;
    }

    return results;
  }

  /** <BaseURL> 값을 이어 붙여 기준 URL을 만든다. */
  function applyBaseUrl(current, xml) {
    var m = /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/.exec(xml);
    if (!m) return current;
    var value = m[1].trim();
    if (!value) return current;
    try {
      return new URL(value, current).href;
    } catch (e) {
      return current;
    }
  }

  /** $Number$, $RepresentationID$ 같은 자리표시자를 채운다. */
  function fillTemplate(template, values) {
    return String(template).replace(/\$(\w+)(?:%0(\d+)d)?\$/g, function (whole, name, pad) {
      if (name === '$') return '$';
      var value = values[name];
      if (value === undefined || value === null) return whole;
      var text = String(value);
      if (pad) {
        while (text.length < parseInt(pad, 10)) text = '0' + text;
      }
      return text;
    });
  }

  /** SegmentTimeline의 <S t= d= r=> 목록을 시작 시각 배열로 편다. */
  function expandTimeline(inner) {
    var entries = findElements(inner, 'S');
    var times = [];
    var time = 0;

    for (var i = 0; i < entries.length; i++) {
      var a = entries[i].attrs;
      if (a.t !== undefined) time = parseInt(a.t, 10);
      var d = parseInt(a.d, 10);
      var repeat = a.r ? parseInt(a.r, 10) : 0;
      if (isNaN(d)) continue;

      for (var k = 0; k <= repeat; k++) {
        times.push(time);
        time += d;
      }
    }
    return times;
  }

  /** SegmentTemplate 하나로부터 init URL과 세그먼트 URL 목록을 만든다. */
  function buildSegments(template, representation, baseUrl, totalDuration) {
    var attrs = template.attrs;
    var values = {
      RepresentationID: representation.id,
      Bandwidth: representation.bandwidth
    };

    var initUrl = attrs.initialization
      ? new URL(fillTemplate(attrs.initialization, values), baseUrl).href
      : null;

    if (!attrs.media) return { initUrl: initUrl, segmentUrls: [] };

    var startNumber = attrs.startNumber ? parseInt(attrs.startNumber, 10) : 1;
    var timescale = attrs.timescale ? parseInt(attrs.timescale, 10) : 1;
    var urls = [];
    var timeline = template.inner ? expandTimeline(template.inner) : [];

    if (timeline.length) {
      for (var i = 0; i < timeline.length; i++) {
        urls.push(new URL(fillTemplate(attrs.media, {
          RepresentationID: representation.id,
          Bandwidth: representation.bandwidth,
          Number: startNumber + i,
          Time: timeline[i]
        }), baseUrl).href);
      }
      return { initUrl: initUrl, segmentUrls: urls };
    }

    var segDuration = parseFloat(attrs.duration);
    if (!segDuration || !totalDuration) return { initUrl: initUrl, segmentUrls: [] };

    var count = Math.ceil(totalDuration / (segDuration / timescale));
    for (var n = 0; n < count; n++) {
      urls.push(new URL(fillTemplate(attrs.media, {
        RepresentationID: representation.id,
        Bandwidth: representation.bandwidth,
        Number: startNumber + n
      }), baseUrl).href);
    }
    return { initUrl: initUrl, segmentUrls: urls };
  }

  function contentTypeOf(attrs) {
    if (attrs.contentType) return attrs.contentType;
    var mime = attrs.mimeType || '';
    if (mime.indexOf('video') === 0) return 'video';
    if (mime.indexOf('audio') === 0) return 'audio';
    return 'unknown';
  }

  /**
   * MPD 문서를 파싱한다.
   * 반환된 각 트랙의 representations는 대역폭 내림차순이다.
   */
  function parseMpd(xml, manifestUrl) {
    var result = {
      duration: 0,
      encrypted: /<ContentProtection/i.test(xml),
      video: [],
      audio: []
    };

    var mpd = findElements(xml, 'MPD')[0];
    if (!mpd) return result;

    result.duration = parseDuration(mpd.attrs.mediaPresentationDuration);

    var mpdBase = applyBaseUrl(manifestUrl, mpd.inner);
    var periods = findElements(mpd.inner, 'Period');
    if (!periods.length) return result;

    // 여러 Period는 아직 다루지 않는다 — 첫 번째만 쓴다
    var period = periods[0];
    var periodBase = applyBaseUrl(mpdBase, period.inner);
    if (!result.duration) result.duration = parseDuration(period.attrs.duration);

    var sets = findElements(period.inner, 'AdaptationSet');

    for (var i = 0; i < sets.length; i++) {
      var set = sets[i];
      var kind = contentTypeOf(set.attrs);
      if (kind !== 'video' && kind !== 'audio') continue;

      var setBase = applyBaseUrl(periodBase, set.inner);
      var setTemplate = findElements(set.inner, 'SegmentTemplate')[0] || null;
      var reps = findElements(set.inner, 'Representation');

      for (var j = 0; j < reps.length; j++) {
        var rep = reps[j];
        var repBase = applyBaseUrl(setBase, rep.inner);
        var template = findElements(rep.inner, 'SegmentTemplate')[0] || setTemplate;
        if (!template) continue;

        var info = {
          id: rep.attrs.id || '',
          bandwidth: parseInt(rep.attrs.bandwidth, 10) || 0,
          width: parseInt(rep.attrs.width, 10) || null,
          height: parseInt(rep.attrs.height, 10) || null,
          codecs: rep.attrs.codecs || set.attrs.codecs || null,
          mimeType: rep.attrs.mimeType || set.attrs.mimeType || null
        };

        var built = buildSegments(template, info, repBase, result.duration);
        info.initUrl = built.initUrl;
        info.segmentUrls = built.segmentUrls;

        if (info.segmentUrls.length) result[kind].push(info);
      }
    }

    var byBandwidth = function (a, b) { return b.bandwidth - a.bandwidth; };
    result.video.sort(byBandwidth);
    result.audio.sort(byBandwidth);
    return result;
  }

  root.CMXDash = {
    parseMpd: parseMpd,
    parseDuration: parseDuration,
    fillTemplate: fillTemplate,
    findElements: findElements
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
