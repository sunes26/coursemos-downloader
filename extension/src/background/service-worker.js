/**
 * 서비스 워커 — 감지 상태 보관, 배지 갱신, 다운로드 작업 조율.
 *
 * 실제 내려받기와 리먹스는 offscreen 문서에서 한다.
 * 서비스 워커는 언제든 종료될 수 있어 Blob URL을 만들 수 없고,
 * 팝업은 닫히면 스크립트가 죽기 때문에 둘 다 작업 주체로 쓸 수 없다.
 */

// 클래식 스크립트지만 import하면 globalThis.CMX 를 채워준다
import '../common/extract.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** 탭별 감지 결과: tabId -> { title, pageHost, videos } */
const detections = new Map();

/**
 * 서비스 워커는 30초쯤 놀면 종료되고 위 Map은 사라진다.
 * 세션 스토리지에 같이 써 두고 깨어날 때 복구한다.
 * (팝업도 페이지에 직접 물어보므로 이건 배지 유지를 위한 이중 안전장치다)
 */
const SESSION_KEY = 'cmx_detections';
let hydrated = false;

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const saved = stored[SESSION_KEY];
    if (saved) {
      for (const [tabId, value] of Object.entries(saved)) {
        detections.set(Number(tabId), value);
      }
    }
  } catch (e) {
    // 세션 스토리지를 못 읽어도 팝업이 페이지에서 다시 찾는다
  }
}

function persist() {
  const plain = {};
  detections.forEach((value, tabId) => { plain[tabId] = value; });
  chrome.storage.session.set({ [SESSION_KEY]: plain }).catch(() => {});
}

/** 진행 중인 작업 하나 (동시 다운로드는 지원하지 않는다) */
let job = null;

// ---------- 배지 ----------

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text: text || '' });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color });
    }
  } catch (e) {
    // 탭이 이미 닫힌 경우 — 무시
  }
}

function refreshBadge(tabId) {
  if (job && job.tabId === tabId) {
    const pct = Math.round(job.progress * 100);
    setBadge(tabId, String(pct), '#3F6AD8');
    return;
  }
  const found = detections.get(tabId);
  const count = found ? found.videos.length : 0;
  setBadge(tabId, count ? String(count) : '', '#3F6AD8');
}

// ---------- offscreen 문서 ----------

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS'],
    justification: '영상 세그먼트를 내려받아 MP4/M4A로 묶고 저장용 Blob URL을 만듭니다.'
  });
}

async function closeOffscreen() {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existing.length > 0) await chrome.offscreen.closeDocument();
  } catch (e) {
    // 이미 닫힌 경우 — 무시
  }
}

// ---------- 작업 수명 주기 ----------

async function startDownload(request) {
  if (job && job.status === 'running') {
    return { ok: false, error: '이미 다운로드가 진행 중입니다.' };
  }

  job = {
    id: 'job_' + Date.now(),
    tabId: request.tabId,
    url: request.url,
    kind: request.kind || 'hls',      // 'hls' | 'dash' | 'file'
    format: request.format,           // 'mp4' | 'm4a'
    filename: request.filename,
    status: 'running',
    progress: 0,
    stage: '플레이리스트 확인 중',
    segmentsDone: 0,
    segmentsTotal: 0,
    bytes: 0,
    bytesPerSecond: 0,
    error: null
  };
  broadcast();
  refreshBadge(job.tabId);

  // 통짜 파일은 브라우저 다운로드에 그대로 넘긴다.
  // 디스크로 바로 흘려보내므로 메모리를 쓰지 않고 이어받기도 된다.
  if (job.kind === 'file') {
    await downloadDirectFile();
    return { ok: true, job: publicJob() };
  }

  await ensureOffscreen();
  chrome.runtime.sendMessage({
    type: 'CMX_OFFSCREEN_START',
    payload: {
      jobId: job.id,
      url: job.url,
      kind: job.kind,
      format: job.format
    }
  });

  return { ok: true, job: publicJob() };
}

async function downloadDirectFile() {
  const extension = globalThis.CMX.fileExtensionOf(job.url);
  try {
    await chrome.downloads.download({
      url: job.url,
      filename: `${job.filename}.${extension}`,
      saveAs: false
    });
    job.status = 'done';
    job.progress = 1;
    job.stage = '브라우저 다운로드로 넘김';
    job.directFile = true;
  } catch (e) {
    job.status = 'error';
    job.error = '파일 저장에 실패했습니다: ' + e.message;
  }

  broadcast();
  if (job.tabId != null) {
    setBadge(job.tabId, job.status === 'done' ? '✓' : '!',
      job.status === 'done' ? '#17A26B' : '#E0483E');
  }
}

async function finishDownload(payload) {
  if (!job || job.id !== payload.jobId) return;

  if (!payload.ok) {
    job.status = 'error';
    job.error = payload.error || '알 수 없는 오류';
    broadcast();
    refreshBadge(job.tabId);
    await closeOffscreen();
    return;
  }

  const extension = job.format === 'm4a' ? 'm4a' : 'mp4';
  try {
    await chrome.downloads.download({
      url: payload.blobUrl,
      filename: `${job.filename}.${extension}`,
      saveAs: false
    });
    job.status = 'done';
    job.progress = 1;
    job.stage = '저장 완료';
    job.totalBytes = payload.totalBytes;
  } catch (e) {
    job.status = 'error';
    job.error = '파일 저장에 실패했습니다: ' + e.message;
  }

  broadcast();
  if (job.tabId != null) {
    setBadge(job.tabId, job.status === 'done' ? '✓' : '!',
      job.status === 'done' ? '#17A26B' : '#E0483E');
  }

  // Blob URL 회수는 offscreen 문서를 닫으면 함께 정리된다.
  // 다운로드가 실제로 시작된 뒤에 닫아야 하므로 잠시 뒤로 미룬다.
  setTimeout(closeOffscreen, 5000);
}

function cancelDownload() {
  if (!job || job.status !== 'running') return { ok: false };
  chrome.runtime.sendMessage({ type: 'CMX_OFFSCREEN_CANCEL', payload: { jobId: job.id } });
  job.status = 'cancelled';
  job.stage = '취소됨';
  broadcast();
  if (job.tabId != null) refreshBadge(job.tabId);
  closeOffscreen();
  return { ok: true };
}

function publicJob() {
  return job ? { ...job } : null;
}

/**
 * 작업 상태를 팝업과 인페이지 버튼 양쪽에 알린다.
 *
 * runtime.sendMessage 는 콘텐츠 스크립트에 닿지 않으므로
 * 탭에는 tabs.sendMessage 로 따로 보내야 한다.
 */
function broadcast() {
  const payload = publicJob();
  chrome.runtime.sendMessage({ type: 'CMX_JOB_UPDATE', payload }).catch(() => {});

  if (payload && payload.tabId != null) {
    chrome.tabs.sendMessage(payload.tabId, { type: 'CMX_JOB_UPDATE', payload })
      .catch(() => {});
  }
}

// ---------- 사이트 상시 감지 ----------

const DETECT_FILES = ['src/common/extract.js', 'src/content/detect.js'];
const DETECT_CSS = ['src/content/inpage.css'];

/** origin 패턴("https://example.com/*")을 안정적인 스크립트 id로 바꾼다. */
function scriptIdFor(origin) {
  return 'cmx-' + origin.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * 사용자가 권한을 준 사이트에 탐지 스크립트를 상시 등록한다.
 * 등록하지 않아도 아이콘을 누르면 activeTab으로 그때그때 감지되지만,
 * 등록해두면 페이지를 열자마자 배지와 인페이지 버튼이 뜬다.
 */
async function registerSite(origin) {
  if (!origin) return { ok: false, error: 'origin이 없습니다.' };

  const id = scriptIdFor(origin);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length) return { ok: true, alreadyRegistered: true };
  } catch (e) {
    // 아직 등록된 게 없으면 조회가 실패할 수 있다 — 그대로 등록으로 진행
  }

  try {
    await chrome.scripting.registerContentScripts([{
      id,
      matches: [origin],
      js: DETECT_FILES,
      css: DETECT_CSS,
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true
    }]);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // 이미 열려 있는 탭에도 지금 넣어준다
  await injectIntoOpenTabs([origin]);
  return { ok: true };
}

async function injectIntoOpenTabs(matches) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: matches });
  } catch (e) {
    return;
  }
  for (const tab of tabs) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: DETECT_FILES
    }).catch(() => {});
    chrome.scripting.insertCSS({
      target: { tabId: tab.id, allFrames: true },
      files: DETECT_CSS
    }).catch(() => {});
  }
}

/** 사용자가 설정에서 권한을 회수하면 등록된 스크립트도 지운다. */
chrome.permissions.onRemoved.addListener(async (permissions) => {
  for (const origin of permissions.origins || []) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptIdFor(origin)] });
    } catch (e) {
      // 등록돼 있지 않았다면 무시
    }
  }
});

// ---------- 메시지 라우팅 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case 'CMX_DETECTED': {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) return false;
      // 프레임이 여러 개면 영상을 찾은 프레임의 결과를 우선한다
      const previous = detections.get(tabId);
      if (!previous || msg.payload.videos.length >= previous.videos.length) {
        detections.set(tabId, msg.payload);
        persist();
      }
      refreshBadge(tabId);
      return false;
    }

    case 'CMX_DETECTED_FROM_POPUP': {
      // 팝업이 페이지에서 직접 읽어온 결과 — 캐시보다 최신이므로 덮어쓴다
      if (msg.tabId == null) return false;
      detections.set(msg.tabId, msg.payload);
      persist();
      refreshBadge(msg.tabId);
      return false;
    }

    case 'CMX_GET_STATE': {
      const tabId = msg.tabId;
      hydrate().then(() => {
        sendResponse({
          detection: detections.get(tabId) || null,
          job: publicJob()
        });
      });
      return true;
    }

    case 'CMX_START_DOWNLOAD':
      startDownload(msg.payload).then(sendResponse);
      return true;

    case 'CMX_QUICK_DOWNLOAD': {
      // 인페이지 버튼에서 온 요청 — 탭 정보는 발신자에게서 얻는다
      const tabId = sender.tab && sender.tab.id;
      startDownload({ ...msg.payload, tabId }).then(sendResponse);
      return true;
    }

    case 'CMX_CANCEL_DOWNLOAD':
      sendResponse(cancelDownload());
      return true;

    case 'CMX_CLEAR_JOB':
      job = null;
      if (msg.tabId != null) refreshBadge(msg.tabId);
      sendResponse({ ok: true });
      return true;

    case 'CMX_PROGRESS': {
      if (job && job.id === msg.payload.jobId) {
        Object.assign(job, msg.payload.patch);
        broadcast();
        if (job.tabId != null) refreshBadge(job.tabId);
      }
      return false;
    }

    case 'CMX_OFFSCREEN_DONE':
      finishDownload(msg.payload);
      return false;

    case 'CMX_WATCH_SITE':
      registerSite(msg.origin).then(sendResponse);
      return true;

    case 'CMX_OPEN_POPUP_REQUEST':
      // Chrome 127+ 에서만 프로그램적으로 팝업을 열 수 있다.
      if (chrome.action.openPopup) {
        chrome.action.openPopup().catch(() => {});
      }
      return false;

    default:
      return false;
  }
});

// ---------- 정리 ----------

chrome.tabs.onRemoved.addListener((tabId) => {
  detections.delete(tabId);
  persist();
  if (job && job.tabId === tabId && job.status === 'running') cancelDownload();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detections.delete(tabId);
    persist();
    refreshBadge(tabId);
  }
});

/**
 * 확장을 새로 설치하거나 업데이트하면 이미 열려 있는 탭에는
 * 콘텐츠 스크립트가 자동으로 들어가지 않는다. 직접 넣어준다.
 * (넣지 않으면 사용자가 페이지를 새로고침해야 배지가 뜬다)
 */
chrome.runtime.onInstalled.addListener(async () => {
  const matches = [];

  for (const script of chrome.runtime.getManifest().content_scripts || []) {
    matches.push(...script.matches);
  }

  // 사용자가 이전에 켜 둔 사이트들
  try {
    const granted = await chrome.permissions.getAll();
    matches.push(...(granted.origins || []));
  } catch (e) {
    // 권한 목록을 못 읽어도 매니페스트 쪽은 계속 진행한다
  }

  if (matches.length) await injectIntoOpenTabs(matches);
});
