/**
 * 서비스 워커 — 감지 상태 보관, 배지/아이콘 갱신, 다운로드 큐 조율.
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

/** 현재/가장 최근 작업 하나. 대기열은 아래 queue 배열에 따로 쌓인다. */
let job = null;

/** 아직 시작하지 않은 작업들. 하나가 끝나면 자동으로 다음 걸 시작한다. */
let queue = [];

/**
 * 배치(한 번에 받기 누른 묶음) 진행률 표시용 카운터.
 * 큐와 job이 모두 비면 다음 배치를 위해 초기화된다.
 */
let queueStats = { total: 0, completed: 0 };

// ---------- 배지 & 툴바 아이콘 ----------

const ICON_ACTIVE = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png'
};
const ICON_INACTIVE = {
  16: 'icons/icon16-inactive.png',
  32: 'icons/icon32-inactive.png',
  48: 'icons/icon48-inactive.png',
  128: 'icons/icon128-inactive.png'
};

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

/** 감지/진행 여부에 따라 탭별로 컬러/회색조 아이콘을 바꾼다. */
async function setToolbarIcon(tabId, active) {
  try {
    await chrome.action.setIcon({ tabId, path: active ? ICON_ACTIVE : ICON_INACTIVE });
  } catch (e) {
    // 탭이 이미 닫힌 경우 — 무시
  }
}

function refreshBadge(tabId) {
  if (job && job.tabId === tabId && job.status === 'running') {
    const pct = Math.round(job.progress * 100);
    setBadge(tabId, String(pct), '#3F6AD8');
    setToolbarIcon(tabId, true);
    return;
  }
  const found = detections.get(tabId);
  const count = found ? found.videos.length : 0;
  setBadge(tabId, count ? String(count) : '', '#3F6AD8');
  setToolbarIcon(tabId, count > 0);
}

// ---------- 다운로드 완료 알림 ----------

/**
 * 팝업을 계속 띄워두지 않아도 완료/실패를 알 수 있도록 OS 알림을 띄운다.
 * 사용자가 직접 취소한 경우는 알릴 필요가 없어 제외한다.
 */
function notifyJobResult(finishedJob) {
  if (!finishedJob || finishedJob.status === 'cancelled') return;

  const ok = finishedJob.status === 'done';
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: ok ? '다운로드 완료' : '다운로드 실패',
    message: ok
      ? `${finishedJob.filename} 저장을 마쳤습니다.`
      : (finishedJob.error || '알 수 없는 오류로 실패했습니다.')
  }).catch(() => {
    // 알림 권한이 막혀 있어도 다운로드 자체는 계속 진행된다
  });
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

// ---------- 큐 ----------

/**
 * 요청 하나(팝업의 다중 선택 또는 인페이지 버튼의 단건)를 큐에 쌓는다.
 * 아무것도 돌고 있지 않으면 바로 시작한다.
 */
function enqueue(tabId, items) {
  if (!items || !items.length) {
    return { ok: false, error: '선택된 영상이 없습니다.' };
  }

  // 큐와 현재 작업이 모두 비어 있었다면 새 배치로 취급해 카운터를 새로 센다.
  if (!queue.length && (!job || job.status !== 'running')) {
    queueStats = { total: 0, completed: 0 };
  }
  queueStats.total += items.length;

  const queued = items.map((item, i) => ({
    id: 'job_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 7),
    tabId,
    url: item.url,
    kind: item.kind || 'hls',
    format: item.format,
    filename: item.filename
  }));
  queue = queue.concat(queued);

  if (job && job.status === 'running') {
    broadcast(); // 대기열 길이만 갱신해서 알려준다
    return { ok: true, job: publicJob() };
  }

  processQueue();
  return { ok: true, job: publicJob() };
}

/** 큐에서 다음 작업을 꺼내 실행한다. 이미 뭔가 돌고 있으면 아무것도 안 한다. */
async function processQueue() {
  if (job && job.status === 'running') return;
  if (!queue.length) return;

  const next = queue.shift();
  job = {
    ...next,
    status: 'running',
    progress: 0,
    stage: '플레이리스트 확인 중',
    segmentsDone: 0,
    segmentsTotal: 0,
    bytes: 0,
    bytesPerSecond: 0,
    error: null,
    queueIndex: queueStats.completed + 1,
    queueTotal: queueStats.total
  };

  broadcast();
  refreshBadge(job.tabId);

  if (job.kind === 'file') {
    await downloadDirectFile();
    return;
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
}

/** 작업 하나가 끝난 뒤 — 다음 큐 항목을 잇거나 offscreen 문서를 정리한다. */
function afterJobSettled() {
  queueStats.completed += 1;

  if (queue.length > 0) {
    // 완료 화면이 잠깐이라도 보이도록 살짝 텀을 둔 뒤 다음 항목으로 넘어간다
    setTimeout(processQueue, 900);
  } else if (job && job.kind !== 'file') {
    setTimeout(closeOffscreen, 5000);
  }
}

// ---------- 작업 수명 주기 ----------

/**
 * 팝업(다중 선택 가능) · 인페이지 버튼(단건) 양쪽에서 들어오는 다운로드 요청.
 * request.items 가 있으면 배치로, 없으면 단건 호출을 배치 1개짜리로 감싼다.
 */
async function startDownload(request) {
  const items = (request.items && request.items.length)
    ? request.items
    : [{
        url: request.url,
        kind: request.kind || 'hls',
        format: request.format,
        filename: request.filename
      }];

  return enqueue(request.tabId, items);
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
    setToolbarIcon(job.tabId, true);
  }
  notifyJobResult(job);
  afterJobSettled();
}

async function finishDownload(payload) {
  if (!job || job.id !== payload.jobId) return;

  if (!payload.ok) {
    job.status = 'error';
    job.error = payload.error || '알 수 없는 오류';
    broadcast();
    refreshBadge(job.tabId);
    notifyJobResult(job);
    afterJobSettled();
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
    setToolbarIcon(job.tabId, true);
  }
  notifyJobResult(job);
  afterJobSettled();

  // Blob URL 회수는 offscreen 문서를 닫으면 함께 정리된다.
  // afterJobSettled 이 다음 큐 항목으로 넘어가지 않을 때만 여기서 닫힌다.
}

function cancelDownload() {
  if (!job || job.status !== 'running') return { ok: false };
  const cancelledTabId = job.tabId;
  chrome.runtime.sendMessage({ type: 'CMX_OFFSCREEN_CANCEL', payload: { jobId: job.id } });

  // 남은 대기열도 함께 취소한다 — 부분 취소는 헷갈리기만 한다
  queue = [];
  queueStats = { total: 0, completed: 0 };

  // "취소됨" 결과 화면 없이 바로 기본 화면(감지 목록)으로 돌아간다.
  // job을 완전히 비워두면, 취소 직후 offscreen 쪽에서 뒤늦게 도착하는
  // 실패 응답(finishDownload)도 job.id가 안 맞아 자동으로 무시된다.
  job = null;

  broadcast();
  if (cancelledTabId != null) refreshBadge(cancelledTabId);
  closeOffscreen();
  return { ok: true };
}

function publicJob() {
  if (!job) return null;
  return { ...job, queueRemaining: queue.length };
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
  queue = queue.filter((item) => item.tabId !== tabId);
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
