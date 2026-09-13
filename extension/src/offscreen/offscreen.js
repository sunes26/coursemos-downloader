/**
 * offscreen 작업자 — 스트림을 내려받아 하나의 파일로 묶는다.
 *
 * 재인코딩은 하지 않는다. 세 가지 방식을 다룬다.
 *
 *  HLS (.m3u8)  MPEG-TS 조각 → mux.js로 MP4/M4A 리먹스
 *  DASH (.mpd)  이미 MP4 조각이므로 영상·소리 트랙을 합치기만 한다
 *  파일 (.mp4)  서비스 워커가 브라우저 다운로드로 바로 넘긴다 (여기 오지 않는다)
 */
(function () {
  'use strict';

  var CMX = globalThis.CMX;
  var CMXDash = globalThis.CMXDash;
  var CMXFmp4 = globalThis.CMXFmp4;
  var muxjs = globalThis.muxjs;

  // 세그먼트 동시 요청 수 — 순서는 유지하되 대기 시간을 줄인다
  var CONCURRENCY = 6;

  // 완성 파일을 메모리에 들고 있어야 하므로 기본 화질 상한을 둔다.
  // 4K 10분이면 1GB를 넘겨 브라우저가 버티지 못한다.
  var MAX_HEIGHT = 1080;

  var current = null;

  // ---------- 진행률 보고 ----------

  function reportProgress(patch) {
    if (!current) return;
    chrome.runtime.sendMessage({
      type: 'CMX_PROGRESS',
      payload: { jobId: current.jobId, patch: patch }
    }).catch(function () {});
  }

  function reportDone(payload) {
    chrome.runtime.sendMessage({ type: 'CMX_OFFSCREEN_DONE', payload: payload })
      .catch(function () {});
  }

  // ---------- 네트워크 ----------

  async function fetchText(url) {
    var res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + url.split('/').pop());
    return res.text();
  }

  async function fetchBytes(url, signal) {
    var res = await fetch(url, { credentials: 'omit', signal: signal });
    if (!res.ok) throw new Error('세그먼트 요청 실패 (HTTP ' + res.status + ')');
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * 순서를 지키면서 여러 세그먼트를 동시에 받는다.
   * 완료 순서가 아니라 인덱스 순서로 콜백을 호출해야 뒤에서 묶을 때 깨지지 않는다.
   */
  async function fetchAllInOrder(urls, signal, onSegment) {
    var buffers = new Array(urls.length);
    var nextToStart = 0;
    var nextToEmit = 0;
    var failure = null;

    async function worker() {
      while (true) {
        if (failure || signal.aborted) return;
        var index = nextToStart++;
        if (index >= urls.length) return;

        try {
          buffers[index] = await fetchBytes(urls[index], signal);
        } catch (e) {
          if (!failure) failure = e;
          return;
        }

        while (nextToEmit < urls.length && buffers[nextToEmit]) {
          var data = buffers[nextToEmit];
          buffers[nextToEmit] = null; // 메모리 조기 해제
          onSegment(data, nextToEmit);
          nextToEmit++;
        }
      }
    }

    var workers = [];
    for (var i = 0; i < Math.min(CONCURRENCY, urls.length); i++) workers.push(worker());
    await Promise.all(workers);

    if (failure) throw failure;
    if (signal.aborted) throw new Error('CANCELLED');
    if (nextToEmit < urls.length) throw new Error('일부 세그먼트를 받지 못했습니다.');
  }

  /** 진행률을 초당 여덟 번 정도로 제한해 메시지 폭주를 막는다. */
  function makeReporter(total) {
    var startedAt = Date.now();
    var bytes = 0;
    var done = 0;
    var lastReport = 0;

    return function (chunk, force) {
      bytes += chunk ? chunk.byteLength : 0;
      done += 1;

      var now = Date.now();
      if (!force && now - lastReport < 120 && done < total) return;
      lastReport = now;

      var elapsed = (now - startedAt) / 1000;
      reportProgress({
        stage: '내려받는 중',
        segmentsDone: done,
        segmentsTotal: total,
        bytes: bytes,
        bytesPerSecond: elapsed > 0 ? bytes / elapsed : 0,
        progress: done / total
      });
    };
  }

  // ---------- HLS ----------

  function createCollector(wantAudioOnly) {
    // remux:false 로 두면 트랙별로 나뉘어 나와 소리만 골라낼 수 있다
    var transmuxer = new muxjs.Transmuxer({ remux: !wantAudioOnly });
    var initSegment = null;
    var chunks = [];

    transmuxer.on('data', function (segment) {
      if (wantAudioOnly && segment.type !== 'audio') return;
      if (!initSegment) {
        initSegment = new Uint8Array(segment.initSegment);
        chunks.push(initSegment);
      }
      chunks.push(new Uint8Array(segment.data));
    });

    return {
      push: function (data) { transmuxer.push(data); transmuxer.flush(); },
      hasOutput: function () { return initSegment !== null; },
      chunks: function () { return chunks; }
    };
  }

  async function runHls(request, signal) {
    reportProgress({ stage: '플레이리스트 확인 중', progress: 0 });

    var text = await fetchText(request.url);
    var playlist = CMX.parsePlaylist(text, request.url);

    if (playlist.isMaster) {
      if (!playlist.variants.length) throw new Error('재생 가능한 스트림을 찾지 못했습니다.');
      var best = playlist.variants[0];
      reportProgress({ stage: '화질 선택: ' + (best.resolution || '최고 화질') });
      text = await fetchText(best.url);
      playlist = CMX.parsePlaylist(text, best.url);
    }

    if (playlist.encrypted) throw new Error('암호화된 스트림(DRM)은 저장할 수 없습니다.');
    if (!playlist.segments.length) throw new Error('플레이리스트에 세그먼트가 없습니다.');

    var wantAudioOnly = request.format === 'm4a';
    var collector = createCollector(wantAudioOnly);
    var report = makeReporter(playlist.segments.length);

    reportProgress({
      stage: '내려받는 중', segmentsTotal: playlist.segments.length,
      segmentsDone: 0, progress: 0
    });

    await fetchAllInOrder(playlist.segments, signal, function (data) {
      collector.push(data);
      report(data, false);
    });

    if (!collector.hasOutput()) {
      throw new Error(wantAudioOnly
        ? '오디오 트랙을 찾지 못했습니다.' : '영상 트랙을 찾지 못했습니다.');
    }
    return collector.chunks();
  }

  // ---------- DASH ----------

  /** 메모리에 담을 수 있는 범위에서 가장 좋은 화질을 고른다. */
  function pickVideo(representations) {
    if (!representations.length) return null;
    var withinCap = representations.filter(function (r) {
      return !r.height || r.height <= MAX_HEIGHT;
    });
    return withinCap.length ? withinCap[0] : representations[representations.length - 1];
  }

  async function runDash(request, signal) {
    reportProgress({ stage: '매니페스트 확인 중', progress: 0 });

    var mpd = CMXDash.parseMpd(await fetchText(request.url), request.url);
    if (mpd.encrypted) throw new Error('DRM이 걸린 스트림은 저장할 수 없습니다.');

    var wantAudioOnly = request.format === 'm4a';
    var video = wantAudioOnly ? null : pickVideo(mpd.video);
    var audio = mpd.audio[0] || null;

    if (!video && !audio) throw new Error('재생 가능한 트랙을 찾지 못했습니다.');
    if (wantAudioOnly && !audio) throw new Error('오디오 트랙을 찾지 못했습니다.');

    if (video) {
      reportProgress({
        stage: '화질 선택: ' + (video.height ? video.width + 'x' + video.height : '최고 화질')
      });
    }

    var videoUrls = video ? video.segmentUrls : [];
    var audioUrls = audio ? audio.segmentUrls : [];
    var report = makeReporter(videoUrls.length + audioUrls.length);

    reportProgress({
      stage: '내려받는 중',
      segmentsTotal: videoUrls.length + audioUrls.length,
      segmentsDone: 0, progress: 0
    });

    var videoInit = video && video.initUrl ? await fetchBytes(video.initUrl, signal) : null;
    var audioInit = audio && audio.initUrl ? await fetchBytes(audio.initUrl, signal) : null;

    var videoSegments = [];
    var audioSegments = [];

    if (videoUrls.length) {
      await fetchAllInOrder(videoUrls, signal, function (data) {
        videoSegments.push(data);
        report(data, false);
      });
    }
    if (audioUrls.length) {
      await fetchAllInOrder(audioUrls, signal, function (data) {
        audioSegments.push(data);
        report(data, false);
      });
    }

    reportProgress({ stage: '트랙을 하나로 합치는 중', progress: 1 });

    try {
      return CMXFmp4.mergeTracks({
        videoInit: videoInit, videoSegments: videoSegments,
        audioInit: audioInit, audioSegments: audioSegments
      });
    } catch (e) {
      if (e && e.message === 'MOOF_RELATIVE_UNSUPPORTED') {
        throw new Error('이 DASH 스트림은 조각 구조가 달라 아직 합칠 수 없습니다.');
      }
      throw e;
    }
  }

  // ---------- 작업 실행 ----------

  async function run(request) {
    var controller = new AbortController();
    current = { jobId: request.jobId, controller: controller };

    try {
      var chunks = request.kind === 'dash'
        ? await runDash(request, controller.signal)
        : await runHls(request, controller.signal);

      reportProgress({ stage: '파일로 묶는 중', progress: 1 });

      var mime = request.format === 'm4a' ? 'audio/mp4' : 'video/mp4';
      var blob = new Blob(chunks, { type: mime });

      reportDone({
        jobId: request.jobId,
        ok: true,
        blobUrl: URL.createObjectURL(blob),
        totalBytes: blob.size
      });
    } catch (e) {
      var message = e && e.message === 'CANCELLED'
        ? '사용자가 취소했습니다.'
        : (e && e.message) || String(e);
      reportDone({ jobId: request.jobId, ok: false, error: message });
    } finally {
      current = null;
    }
  }

  // ---------- 메시지 ----------

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !msg.type) return false;

    if (msg.type === 'CMX_OFFSCREEN_START') {
      run(msg.payload);
      return false;
    }
    if (msg.type === 'CMX_OFFSCREEN_CANCEL') {
      if (current && current.jobId === msg.payload.jobId) current.controller.abort();
      return false;
    }
    return false;
  });
})();
