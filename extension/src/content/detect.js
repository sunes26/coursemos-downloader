/**
 * 콘텐츠 스크립트 — 페이지에서 m3u8 스트림을 찾아 서비스 워커에 보고하고,
 * 플레이어 위에 "이 영상 저장" 플로팅 버튼을 띄운다.
 *
 * 플레이어(video.js)가 늦게 초기화되므로 MutationObserver로 계속 지켜본다.
 */
(function () {
  'use strict';

  // 팝업이 열릴 때마다 이 파일을 다시 주입하므로 중복 실행을 막는다.
  // 없으면 MutationObserver와 플로팅 버튼이 겹겹이 쌓인다.
  if (globalThis.__cmxContentLoaded) return;
  globalThis.__cmxContentLoaded = true;

  var CMX = globalThis.CMX;
  var BUTTON_ID = 'cmx-save-button';

  var state = {
    videos: [],
    signature: '',
    buttonAttached: false,
    downloading: false
  };

  /**
   * 페이지가 실제로 요청한 네트워크 기록에서 m3u8을 찾는다.
   *
   * DOM 검색만으로는 hls.js처럼 플레이리스트를 JS로만 가져가고
   * DOM에는 아무것도 남기지 않는 플레이어를 놓친다. Resource Timing에는
   * 지금까지의 모든 요청 URL이 남아 있어 소급 감지가 되고,
   * 추가 권한도 필요 없다.
   */
  function collectFromNetworkLog() {
    var urls = [];
    var names = networkLogUrls();
    for (var i = 0; i < names.length; i++) {
      if (names[i] && names[i].indexOf('.m3u8') !== -1) {
        urls = urls.concat(CMX.extractM3u8Urls(names[i]));
      }
    }
    return urls;
  }

  /** Resource Timing에 남은 모든 요청 URL을 돌려준다. */
  function networkLogUrls() {
    if (!globalThis.performance || !performance.getEntriesByType) return [];
    try {
      return performance.getEntriesByType('resource').map(function (e) { return e.name; });
    } catch (e) {
      return [];
    }
  }

  /** 문서 텍스트와 네트워크 기록 양쪽에 주어진 추출기를 돌린다. */
  function scanEverything(extractor) {
    var urls = [];

    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var attrs = all[i].attributes;
      for (var j = 0; j < attrs.length; j++) {
        urls = urls.concat(extractor(attrs[j].value));
      }
    }

    var scripts = document.querySelectorAll('script:not([src])');
    for (var k = 0; k < scripts.length; k++) {
      urls = urls.concat(extractor(scripts[k].textContent));
    }

    var names = networkLogUrls();
    for (var n = 0; n < names.length; n++) urls = urls.concat(extractor(names[n]));

    return urls;
  }

  /**
   * 통째로 받을 수 있는 파일(.mp4 등)과 DASH 매니페스트(.mpd)를 찾는다.
   * HLS가 이미 잡혔으면 조각 파일을 파일로 오인할 위험이 있어 건너뛴다.
   */
  function collectOtherSources() {
    var mpd = scanEverything(CMX.extractMpdUrls);
    var files = mpd.length ? [] : scanEverything(CMX.extractMediaFileUrls);
    return mpd.concat(files);
  }

  /** 문서와 네트워크 기록 양쪽에서 m3u8 URL을 수집한다. */
  function collectUrls() {
    var urls = [];

    // 1) 모든 태그의 속성값 — video.js는 data-setup / data-setup-lazy를 쓴다
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var attrs = all[i].attributes;
      for (var j = 0; j < attrs.length; j++) {
        var value = attrs[j].value;
        if (value && value.indexOf('.m3u8') !== -1) {
          urls = urls.concat(CMX.extractM3u8Urls(value));
        }
      }
    }

    // 2) 인라인 스크립트 본문
    var scripts = document.querySelectorAll('script:not([src])');
    for (var k = 0; k < scripts.length; k++) {
      var text = scripts[k].textContent;
      if (text && text.indexOf('.m3u8') !== -1) {
        urls = urls.concat(CMX.extractM3u8Urls(text));
      }
    }

    // 3) 페이지가 실제로 요청한 URL — DOM에 안 남는 플레이어를 잡는다
    urls = urls.concat(collectFromNetworkLog());

    // 4) 최후의 수단 — 직렬화된 문서 전체
    if (!urls.length && document.documentElement) {
      var html = document.documentElement.outerHTML;
      if (html.indexOf('.m3u8') !== -1) {
        urls = urls.concat(CMX.extractM3u8Urls(html));
      }
    }

    // 5) HLS가 없으면 DASH 매니페스트나 직접 받을 수 있는 파일을 찾는다
    if (!urls.length) urls = urls.concat(collectOtherSources());

    // 6) 그래도 없으면 세그먼트 경로에서 플레이리스트를 추론한다
    if (!urls.length) {
      urls = urls.concat(CMX.guessPlaylistsFromSegments(networkLogUrls()));
    }

    var seen = Object.create(null);
    return urls.filter(function (u) {
      if (seen[u]) return false;
      seen[u] = true;
      return true;
    });
  }

  /** 페이지에 보이는 강의 제목을 우선 쓰고, 없으면 document.title에서 뽑는다. */
  function guessTitle() {
    var candidates = [
      '.vod-title', '.course-title', '#vod_title',
      'h1.title', '.content-title', '.viewer-title'
    ];
    for (var i = 0; i < candidates.length; i++) {
      var el = document.querySelector(candidates[i]);
      if (el && el.textContent.trim()) {
        return CMX.sanitizeFilename(el.textContent.trim());
      }
    }
    return CMX.extractPageTitle(document.title);
  }

  var THUMB_WIDTH = 160;

  /**
   * 재생 중인 <video>에서 현재 프레임을 캡처해 작은 JPEG 데이터 URL로 만든다.
   *
   * 세그먼트를 따로 받지 않으므로 비용이 거의 없다.
   * 아직 프레임이 없으면(readyState < 2) video.js 포스터를 대신 쓴다.
   */
  function captureThumbnail() {
    var video = document.querySelector('video');

    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      var ratio = video.videoHeight / video.videoWidth;
      var canvas = document.createElement('canvas');
      canvas.width = THUMB_WIDTH;
      canvas.height = Math.round(THUMB_WIDTH * ratio) || 90;

      try {
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        // 다른 출처의 미디어면 캔버스가 오염돼 여기서 SecurityError가 난다
        return canvas.toDataURL('image/jpeg', 0.6);
      } catch (e) {
        // 캡처 실패 — 아래 포스터로 넘어간다
      }
    }

    return findPosterUrl(video);
  }

  /** <video poster> 또는 video.js 포스터 div의 배경 이미지를 찾는다. */
  function findPosterUrl(video) {
    if (video && video.poster) return video.poster;

    var poster = document.querySelector('.vjs-poster');
    if (poster) {
      var image = poster.style.backgroundImage ||
        getComputedStyle(poster).backgroundImage;
      var match = image && /url\(["']?(.+?)["']?\)/.exec(image);
      if (match && match[1] && match[1] !== 'none') return match[1];
    }

    var meta = document.querySelector('meta[property="og:image"]');
    return meta ? meta.getAttribute('content') : null;
  }

  /**
   * withThumbnail 은 팝업이 물어볼 때만 켠다.
   * 주기적인 감지 보고(400ms마다)에서까지 프레임을 인코딩할 이유가 없다.
   */
  function buildReport(withThumbnail) {
    var urls = collectUrls();
    var title = guessTitle();

    // 플레이어가 실제로 틀고 있는 건 하나뿐이라 첫 번째 영상에만 붙인다.
    // 나머지에 같은 그림을 붙이면 다른 차시를 잘못 보여주게 된다.
    var thumbnail = (withThumbnail && urls.length) ? captureThumbnail() : null;

    return {
      pageUrl: location.href,
      pageHost: location.host,
      title: title,
      videos: urls.map(function (url, index) {
        return {
          url: url,
          kind: CMX.classifyUrl(url),
          // 영상이 여러 개면 파일명이 겹치지 않도록 번호를 붙인다
          title: urls.length > 1 ? title + ' (' + (index + 1) + ')' : title,
          thumbnail: index === 0 ? thumbnail : null
        };
      })
    };
  }

  function report(force) {
    var data = buildReport(false);
    var signature = data.videos.map(function (v) { return v.url; }).join('|');
    if (!force && signature === state.signature) return;

    state.signature = signature;
    state.videos = data.videos;

    try {
      chrome.runtime.sendMessage({ type: 'CMX_DETECTED', payload: data });
    } catch (e) {
      // 확장이 다시 로드되면 컨텍스트가 무효화된다 — 다음 스캔에서 복구된다
    }

    if (data.videos.length) attachButton();
    else removeButton();
  }

  // ---------- 인페이지 플로팅 버튼 ----------

  function findPlayerHost() {
    return document.querySelector('.video-js') ||
      document.querySelector('video') ||
      null;
  }

  function attachButton() {
    if (state.buttonAttached && document.getElementById(BUTTON_ID)) return;

    var host = findPlayerHost();
    if (!host) return;

    var anchor = host.parentElement || document.body;
    if (getComputedStyle(anchor).position === 'static') {
      anchor.style.position = 'relative';
    }

    var btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.className = 'cmx-save-button';
    btn.addEventListener('click', startQuickDownload);

    anchor.appendChild(btn);
    state.buttonAttached = true;
    setButton('idle', '이 영상 저장');
  }

  var DOWNLOAD_ICON =
    '<svg width="14" height="16" viewBox="0 0 14 16" fill="none" aria-hidden="true">' +
    '<path d="M7 1v9M2.5 6.5L7 11l4.5-4.5M1 14.5h12" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function setButton(mode, label) {
    var btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    btn.className = 'cmx-save-button cmx-save-button--' + mode;
    btn.innerHTML = (mode === 'running' ? '' : DOWNLOAD_ICON) +
      '<span>' + label + '</span>';
  }

  /**
   * 버튼만으로 다운로드를 끝낸다.
   *
   * 팝업 없이 열리는 창(툴바가 없는 window.open)에서는 확장 아이콘을 누를 수
   * 없다. 그런 창에서도 이 버튼 하나로 저장이 되어야 한다.
   */
  function startQuickDownload() {
    if (state.downloading) return;

    var video = state.videos[0];
    if (!video) return;

    state.downloading = true;
    setButton('running', '준비 중…');

    chrome.runtime.sendMessage({
      type: 'CMX_QUICK_DOWNLOAD',
      payload: {
        url: video.url,
        kind: video.kind || 'hls',
        filename: video.title,
        format: 'mp4'
      }
    }).catch(function () {
      state.downloading = false;
      setButton('error', '확장을 다시 불러와 주세요');
    });
  }

  /** 서비스 워커가 탭으로 밀어주는 작업 상태를 버튼에 반영한다. */
  function applyJobToButton(job) {
    if (!job) return;

    if (job.status === 'running') {
      state.downloading = true;
      var pct = Math.round((job.progress || 0) * 100);
      setButton('running', job.segmentsTotal ? pct + '%' : (job.stage || '준비 중…'));
      return;
    }

    state.downloading = false;

    if (job.status === 'done') {
      setButton('done', '저장 완료');
      setTimeout(function () { setButton('idle', '이 영상 저장'); }, 4000);
      return;
    }
    if (job.status === 'error') {
      setButton('error', '실패 · 다시 시도');
      setTimeout(function () { setButton('idle', '이 영상 저장'); }, 5000);
      return;
    }
    setButton('idle', '이 영상 저장');
  }

  function removeButton() {
    var existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();
    state.buttonAttached = false;
  }

  // ---------- 수명 주기 ----------

  // 팝업이 프레임마다 직접 호출한다. 서비스 워커 캐시에 의존하지 않고
  // 열린 시점의 페이지 상태를 그대로 읽기 위한 통로다.
  globalThis.__cmxReport = function () { return buildReport(true); };

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'CMX_RESCAN') {
      sendResponse(buildReport(true));
      return true;
    }
    if (msg && msg.type === 'CMX_JOB_UPDATE') {
      applyJobToButton(msg.payload);
      return false;
    }
    return false;
  });

  // 플레이어는 비동기로 초기화되므로 DOM 변화를 지켜본다
  var scheduled = null;
  var observer = new MutationObserver(function () {
    if (scheduled) return;
    scheduled = setTimeout(function () {
      scheduled = null;
      report(false);
    }, 400);
  });

  function start() {
    report(true);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'data-setup', 'data-setup-lazy']
    });
    // 느린 플레이어를 위한 보정 스캔
    [1000, 3000, 6000].forEach(function (delay) {
      setTimeout(function () { report(false); }, delay);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
