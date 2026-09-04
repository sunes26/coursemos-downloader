/**
 * 팝업 — 감지 결과를 보여주고 다운로드를 시작한다.
 *
 * 팝업은 닫히면 스크립트가 죽으므로 상태를 들고 있지 않는다.
 * 진실의 출처는 항상 서비스 워커이고, 팝업은 열릴 때마다 다시 읽어온다.
 */
(function () {
  'use strict';

  var CMX = globalThis.CMX;

  var CHECK_SVG =
    '<svg width="10" height="8" viewBox="0 0 10 8" fill="none">' +
    '<path d="M1 4.2 3.5 6.7 9 1.2" stroke="#fff" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var PLAY_SVG =
    '<svg width="11" height="13" viewBox="0 0 9 10" fill="none">' +
    '<path d="M8.5 5 0 9.8V.2L8.5 5Z" fill="#fff"/></svg>';

  var el = {};
  var state = {
    tabId: null,
    pageUrl: null,
    detection: null,
    selectedIndex: 0,
    format: 'mp4'
  };

  function $(id) { return document.getElementById(id); }

  function cacheElements() {
    ['view-empty', 'view-ready', 'view-progress', 'view-result',
     'video-list', 'list-header', 'list-count', 'filename', 'extension',
     'download', 'cancel', 'rescan', 'manual-url', 'watch-site', 'format-field',
     'progress-title', 'progress-stage', 'progress-percent', 'progress-fill',
     'progress-detail', 'progress-rate',
     'result-glyph', 'result-title', 'result-detail',
     'result-primary', 'result-secondary',
     'status-dot', 'status-text'
    ].forEach(function (id) {
      el[id] = $(id);
    });
  }

  function showView(name) {
    ['empty', 'ready', 'progress', 'result'].forEach(function (v) {
      el['view-' + v].hidden = (v !== name);
    });
  }

  function setStatus(text, tone) {
    el['status-text'].textContent = text;
    el['status-dot'].className = 'dot' + (tone ? ' dot--' + tone : '');
  }

  // ---------- 렌더링 ----------

  function renderVideoList() {
    var videos = state.detection.videos;
    el['video-list'].innerHTML = '';

    el['list-header'].hidden = videos.length < 2;
    if (videos.length >= 2) {
      el['list-count'].textContent = '감지된 영상 ' + videos.length + '개';
    }

    videos.forEach(function (video, index) {
      var li = document.createElement('li');
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'card' + (index === state.selectedIndex ? ' is-selected' : '');

      var thumb = document.createElement('span');
      thumb.className = 'thumb';
      if (video.thumbnail) {
        var img = document.createElement('img');
        img.src = video.thumbnail;
        img.alt = '';
        // 이미지가 깨지면 재생 아이콘으로 되돌린다
        img.addEventListener('error', function () {
          thumb.innerHTML = PLAY_SVG;
        });
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = PLAY_SVG;
      }

      var meta = document.createElement('span');
      meta.className = 'card__meta';

      var title = document.createElement('span');
      title.className = 'text-strong text-clip';
      title.textContent = video.title;

      var sub = document.createElement('span');
      sub.className = 'text-muted text-clip';
      sub.textContent = hostOf(video.url) + ' · ' + kindLabel(video.kind);

      meta.appendChild(title);
      meta.appendChild(sub);

      var check = document.createElement('span');
      check.className = 'checkbox';
      check.innerHTML = CHECK_SVG;

      card.appendChild(thumb);
      card.appendChild(meta);
      card.appendChild(check);

      card.addEventListener('click', function () {
        state.selectedIndex = index;
        el['filename'].value = video.title;
        el['format-field'].hidden = video.kind === 'file';
        updateExtension();
        renderVideoList();
      });

      li.appendChild(card);
      el['video-list'].appendChild(li);
    });
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return '스트림'; }
  }

  function kindLabel(kind) {
    if (kind === 'dash') return 'DASH';
    if (kind === 'file') return '파일';
    return 'HLS';
  }

  function selectedVideo() {
    return state.detection && state.detection.videos[state.selectedIndex];
  }

  function renderReady() {
    showView('ready');
    renderVideoList();
    var selected = selectedVideo();
    el['filename'].value = selected ? selected.title : 'video';

    // 통짜 파일은 그대로 받는 것 말고 선택지가 없다
    el['format-field'].hidden = !!(selected && selected.kind === 'file');
    updateExtension();
    setStatus(state.detection.pageHost + ' · ' +
      state.detection.videos.length + '개 감지됨', 'on');
  }

  function renderEmpty() {
    showView('empty');
    setStatus('감지된 영상 없음', null);
    updateWatchSiteButton();
  }

  /**
   * 이 사이트를 상시 감시하도록 켤 수 있는지 확인한다.
   * 이미 권한이 있거나 http(s)가 아니면 버튼을 숨긴다.
   */
  async function updateWatchSiteButton() {
    var button = el['watch-site'];
    button.hidden = true;

    var origin = originPattern(state.pageUrl);
    if (!origin) return;

    try {
      var granted = await chrome.permissions.contains({ origins: [origin] });
      button.hidden = granted;
    } catch (e) {
      button.hidden = true;
    }
  }

  function originPattern(pageUrl) {
    if (!pageUrl) return null;
    try {
      var parsed = new URL(pageUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      return parsed.origin + '/*';
    } catch (e) {
      return null;
    }
  }

  /**
   * 현재 사이트에 대한 상시 감지를 켠다.
   *
   * 켜지 않아도 아이콘을 누르면 activeTab 권한으로 그때그때 감지된다.
   * 켜면 페이지를 열자마자 배지와 인페이지 버튼이 뜬다.
   */
  async function watchSite() {
    var origin = originPattern(state.pageUrl);
    if (!origin) return;

    var granted;
    try {
      // 사용자 제스처 안에서 호출해야 한다 — 팝업 버튼 클릭이 그 역할을 한다
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      setStatus('권한 요청에 실패했습니다', 'error');
      return;
    }
    if (!granted) return;

    await chrome.runtime.sendMessage({ type: 'CMX_WATCH_SITE', origin: origin });
    setStatus('이 사이트를 자동 감지합니다', 'on');
    await refresh();
  }

  function renderProgress(job) {
    showView('progress');
    var pct = Math.round((job.progress || 0) * 100);

    el['progress-title'].textContent = job.filename;
    el['progress-stage'].textContent = job.stage || '';
    el['progress-percent'].textContent = pct + '%';
    el['progress-fill'].style.transform = 'scaleX(' + (pct / 100) + ')';

    el['progress-detail'].textContent = job.segmentsTotal
      ? '세그먼트 ' + job.segmentsDone + ' / ' + job.segmentsTotal
      : '';

    var parts = [];
    if (job.bytes) parts.push(CMX.formatBytes(job.bytes));
    if (job.bytesPerSecond > 0) parts.push(CMX.formatBytes(job.bytesPerSecond) + '/s');
    el['progress-rate'].textContent = parts.join(' · ');

    setStatus('다운로드 중…', 'busy');
  }

  function renderResult(job) {
    showView('result');
    var ok = job.status === 'done';

    el['result-glyph'].className = 'glyph ' + (ok ? 'glyph--success' : 'glyph--error');
    el['result-glyph'].innerHTML = ok
      ? '<svg width="20" height="14" viewBox="0 0 20 14" fill="none">' +
        '<path d="M1 7l6 6L19 1" stroke="#17A26B" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '!';

    if (ok) {
      var ext = job.directFile
        ? '.' + CMX.fileExtensionOf(job.url)
        : (job.format === 'm4a' ? '.m4a' : '.mp4');
      el['result-title'].textContent = '다운로드 완료';
      el['result-detail'].textContent = job.filename + ext +
        (job.totalBytes ? ' · ' + CMX.formatBytes(job.totalBytes) : '');
      el['result-secondary'].textContent = '다운로드 폴더 열기';
      el['result-primary'].textContent = '다음 영상 받기';
      setStatus('다운로드 폴더에 저장됨', 'on');
    } else {
      el['result-title'].textContent = job.status === 'cancelled'
        ? '다운로드를 취소했습니다'
        : '다운로드에 실패했습니다';
      el['result-detail'].textContent = job.error || '';
      el['result-secondary'].textContent = '닫기';
      el['result-primary'].textContent = '다시 시도';
      setStatus(job.status === 'cancelled' ? '취소됨' : '실패', 'error');
    }
  }

  function updateExtension() {
    var selected = selectedVideo();
    if (selected && selected.kind === 'file') {
      el['extension'].textContent = '.' + CMX.fileExtensionOf(selected.url);
      return;
    }
    el['extension'].textContent = state.format === 'm4a' ? '.m4a' : '.mp4';
  }

  /** 서비스 워커 상태를 화면에 반영한다. */
  function apply(response) {
    var job = response.job;
    if (job && (job.status === 'running')) { renderProgress(job); return; }
    if (job && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
      renderResult(job); return;
    }

    state.detection = response.detection;
    if (state.detection && state.detection.videos.length) renderReady();
    else renderEmpty();
  }

  // ---------- 동작 ----------

  /**
   * 페이지에 직접 물어 감지 결과를 가져온다.
   *
   * 서비스 워커 캐시를 믿지 않는 이유가 둘 있다.
   *  - MV3 서비스 워커는 30초쯤 놀면 종료되고 메모리 상태가 사라진다
   *  - 확장 설치 이전부터 열려 있던 탭에는 콘텐츠 스크립트가 주입되지 않는다
   * 둘 다 팝업이 열릴 때 직접 주입하고 조회하면 해결된다.
   */
  async function collectFromPage() {
    if (state.tabId == null) return null;

    // 이미 들어가 있으면 detect.js 의 중복 실행 가드가 막아준다
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.tabId, allFrames: true },
        files: ['src/common/extract.js', 'src/content/detect.js']
      });
    } catch (e) {
      return null; // chrome:// 등 주입이 금지된 페이지
    }

    var frames;
    try {
      frames = await chrome.scripting.executeScript({
        target: { tabId: state.tabId, allFrames: true },
        func: function () {
          return globalThis.__cmxReport ? globalThis.__cmxReport() : null;
        }
      });
    } catch (e) {
      return null;
    }

    // 영상이 iframe 안에 있을 수 있으므로 가장 많이 찾은 프레임을 고른다
    var best = null;
    frames.forEach(function (frame) {
      var report = frame && frame.result;
      if (!report || !report.videos) return;
      if (!best || report.videos.length > best.videos.length) best = report;
    });
    return best;
  }

  async function refresh() {
    var response = await chrome.runtime.sendMessage({
      type: 'CMX_GET_STATE', tabId: state.tabId
    });
    response = response || { detection: null, job: null };

    // 진행 중이거나 방금 끝난 작업이 있으면 그 화면이 우선이다
    if (response.job) { apply(response); return; }

    var fresh = await collectFromPage();
    if (fresh && fresh.pageUrl && !state.pageUrl) state.pageUrl = fresh.pageUrl;

    if (fresh && fresh.videos.length) {
      chrome.runtime.sendMessage({ type: 'CMX_DETECTED_FROM_POPUP', tabId: state.tabId, payload: fresh })
        .catch(function () {});
      apply({ detection: fresh, job: null });
      return;
    }

    apply({ detection: fresh || response.detection, job: null });
  }

  async function rescan() {
    setStatus('다시 검색하는 중…', 'busy');
    await refresh();
  }

  function manualUrl() {
    var url = prompt('영상 주소를 붙여넣으세요 (.m3u8 · .mpd · .mp4):');
    if (!url) return;
    url = url.trim();
    if (!CMX.classifyUrl(url)) {
      setStatus('지원하지 않는 주소입니다 (m3u8 · mpd · mp4)', 'error');
      return;
    }
    state.detection = {
      pageHost: hostOf(url),
      title: 'video',
      videos: [{ url: url, title: 'video', kind: CMX.classifyUrl(url) || 'hls' }]
    };
    state.selectedIndex = 0;
    renderReady();
  }

  async function startDownload() {
    var video = selectedVideo();
    if (!video) return;

    var filename = CMX.sanitizeFilename(el['filename'].value) || 'video';
    el['download'].disabled = true;

    var response = await chrome.runtime.sendMessage({
      type: 'CMX_START_DOWNLOAD',
      payload: {
        tabId: state.tabId,
        url: video.url,
        kind: video.kind || 'hls',
        format: state.format,
        filename: filename
      }
    });

    el['download'].disabled = false;
    if (response && !response.ok) setStatus(response.error, 'error');
  }

  async function clearJob() {
    await chrome.runtime.sendMessage({ type: 'CMX_CLEAR_JOB', tabId: state.tabId });
    refresh();
  }

  function bindEvents() {
    document.querySelectorAll('.segment').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.segment').forEach(function (b) {
          b.classList.remove('is-active');
          b.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('is-active');
        btn.setAttribute('aria-checked', 'true');
        state.format = btn.dataset.format;
        updateExtension();
      });
    });

    el['download'].addEventListener('click', startDownload);
    el['rescan'].addEventListener('click', rescan);
    el['manual-url'].addEventListener('click', manualUrl);
    el['watch-site'].addEventListener('click', watchSite);

    el['cancel'].addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: 'CMX_CANCEL_DOWNLOAD' });
    });

    el['result-primary'].addEventListener('click', clearJob);
    el['result-secondary'].addEventListener('click', function () {
      if (el['result-secondary'].textContent.indexOf('폴더') !== -1) {
        chrome.downloads.showDefaultFolder();
      } else {
        clearJob();
      }
    });

    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'CMX_JOB_UPDATE') {
        if (msg.payload) apply({ detection: state.detection, job: msg.payload });
        return false;
      }
      return false;
    });
  }

  async function init() {
    cacheElements();
    bindEvents();
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tabId = tabs[0] && tabs[0].id;
    state.pageUrl = tabs[0] && tabs[0].url;
    refresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
