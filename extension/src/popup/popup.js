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
    selected: new Set(),   // 다중 선택 가능 — Set<index>
    format: 'mp4'
  };

  function $(id) { return document.getElementById(id); }

  function cacheElements() {
    ['view-empty', 'view-ready', 'view-progress', 'view-result',
     'video-list', 'list-header', 'list-count', 'filename', 'filename-field', 'extension',
     'download', 'cancel', 'rescan', 'manual-url', 'watch-site', 'format-field',
     'multi-select-hint',
     'progress-title', 'progress-stage', 'progress-percent', 'progress-fill',
     'progress-detail', 'progress-rate', 'progress-queue',
     'result-glyph', 'result-title', 'result-detail',
     'result-primary', 'result-secondary',
     'status-dot', 'status-text', 'version-text'
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
      el['list-count'].textContent = '감지된 영상 ' + videos.length + '개' +
        (state.selected.size > 1 ? ' · ' + state.selected.size + '개 선택' : '');
    }

    videos.forEach(function (video, index) {
      var li = document.createElement('li');
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'card' + (state.selected.has(index) ? ' is-selected' : '');

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
      // 재생 길이를 알면 그걸 보여주고, 모르면 주소로 대신한다.
      // HLS/DASH 같은 전송 방식은 사용자에게 의미가 없어 보여주지 않는다.
      var duration = video.duration ? CMX.formatDuration(video.duration) : null;
      sub.textContent = duration || hostOf(video.url);

      meta.appendChild(title);
      meta.appendChild(sub);

      var check = document.createElement('span');
      check.className = 'checkbox';
      check.innerHTML = CHECK_SVG;

      card.appendChild(thumb);
      card.appendChild(meta);
      card.appendChild(check);

      card.addEventListener('click', function () {
        toggleSelection(index, videos.length);
      });

      li.appendChild(card);
      el['video-list'].appendChild(li);
    });
  }

  /**
   * 영상이 하나뿐이면 계속 선택된 채로 둔다 — 다운로드 버튼이 비활성화될
   * 이유가 없다. 여러 개일 땐 자유롭게 켜고 끌 수 있다(전부 꺼도 된다).
   */
  function toggleSelection(index, totalCount) {
    if (totalCount <= 1) return;

    if (state.selected.has(index)) {
      state.selected.delete(index);
    } else {
      state.selected.add(index);
    }
    renderVideoList();
    updateSelectionUI();
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return '스트림'; }
  }

  function selectedIndices() {
    return Array.from(state.selected).sort(function (a, b) { return a - b; });
  }

  /** 선택이 정확히 하나일 때만 의미 있는 "그 영상". */
  function singleSelectedVideo() {
    var indices = selectedIndices();
    if (indices.length !== 1 || !state.detection) return null;
    return state.detection.videos[indices[0]];
  }

  /**
   * 선택 개수에 따라 파일명 입력창 / 형식 선택 / 다운로드 버튼 문구를 갱신한다.
   * 하나만 선택했을 때는 지금까지처럼 파일명을 직접 고칠 수 있고,
   * 여럿을 선택했을 때는 각자의 제목으로 자동 저장된다.
   */
  function updateSelectionUI() {
    var indices = selectedIndices();
    var count = indices.length;

    el['download'].disabled = count === 0;
    el['download'].textContent = count > 1 ? ('선택한 ' + count + '개 다운로드') : '다운로드';

    var anyFile = indices.some(function (i) {
      return state.detection.videos[i].kind === 'file';
    });
    el['format-field'].hidden = anyFile || count === 0;

    var single = singleSelectedVideo();
    el['filename-field'].hidden = !single;
    el['multi-select-hint'].hidden = count <= 1;

    if (single) {
      el['filename'].value = single.title;
    }
    updateExtension();
  }

  function renderReady() {
    showView('ready');
    renderVideoList();
    updateSelectionUI();
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

    // 대기열 배치 중이면 "2 / 5"처럼 몇 번째인지 보여준다
    var inQueue = job.queueTotal > 1;
    el['progress-queue'].hidden = !inQueue;
    if (inQueue) {
      el['progress-queue'].textContent = job.queueIndex + ' / ' + job.queueTotal;
    }

    el['progress-detail'].textContent = job.segmentsTotal
      ? '세그먼트 ' + job.segmentsDone + ' / ' + job.segmentsTotal
      : '';

    var parts = [];
    if (job.bytes) parts.push(CMX.formatBytes(job.bytes));
    if (job.bytesPerSecond > 0) parts.push(CMX.formatBytes(job.bytesPerSecond) + '/s');
    el['progress-rate'].textContent = parts.join(' · ');

    setStatus(inQueue ? '다운로드 중… (' + job.queueIndex + '/' + job.queueTotal + ')' : '다운로드 중…', 'busy');
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
    var single = singleSelectedVideo();
    if (single && single.kind === 'file') {
      el['extension'].textContent = '.' + CMX.fileExtensionOf(single.url);
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
    if (state.detection && state.detection.videos.length) {
      // 기본은 첫 번째(대개 지금 재생 중인) 영상 하나만 — 기존 동작과 같다.
      // 나머지는 사용자가 직접 체크해서 큐에 추가한다.
      if (!state.selected.size) {
        state.selected.add(0);
      }
      renderReady();
    } else {
      state.selected = new Set();
      renderEmpty();
    }
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
    state.selected = new Set();
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
    state.selected = new Set([0]);
    renderReady();
  }

  /**
   * 선택된 영상들을 모두 큐에 올린다.
   * 하나만 선택했으면 지금까지처럼 파일 이름을 직접 고칠 수 있고,
   * 여럿이면 각 영상의 제목을 그대로 파일명으로 쓴다.
   */
  async function startDownload() {
    var indices = selectedIndices();
    if (!indices.length) return;

    var items = indices.map(function (index) {
      var video = state.detection.videos[index];
      var filename = (indices.length === 1)
        ? (CMX.sanitizeFilename(el['filename'].value) || 'video')
        : (CMX.sanitizeFilename(video.title) || 'video');
      return {
        url: video.url,
        kind: video.kind || 'hls',
        format: state.format,
        filename: filename
      };
    });

    el['download'].disabled = true;

    var response = await chrome.runtime.sendMessage({
      type: 'CMX_START_DOWNLOAD',
      payload: { tabId: state.tabId, items: items }
    });

    if (response && !response.ok) {
      el['download'].disabled = false;
      setStatus(response.error, 'error');
    }
  }

  async function clearJob() {
    state.selected = new Set();
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
        if (msg.payload) {
          apply({ detection: state.detection, job: msg.payload });
        } else {
          // 취소됨 — 진행 화면을 닫고 최신 감지 상태로 되돌아간다.
          // state.detection 이 비어 있을 수 있어(팝업을 진행 중에 열었을 때)
          // 그냥 재조회한다.
          state.selected = new Set();
          refresh();
        }
        return false;
      }
      return false;
    });
  }

  async function init() {
    cacheElements();
    bindEvents();
    el['version-text'].textContent = 'v' + chrome.runtime.getManifest().version;
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tabId = tabs[0] && tabs[0].id;
    state.pageUrl = tabs[0] && tabs[0].url;
    refresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
