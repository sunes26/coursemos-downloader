/**
 * fMP4(조각난 MP4) 트랙 합치기.
 *
 * DASH는 영상과 소리를 서로 다른 트랙으로 따로 내려준다. 둘 다 이미 MP4 조각이라
 * 다시 인코딩할 필요는 없지만, 그냥 이어붙이면 두 파일이 뒤섞인 쓰레기가 된다.
 * 하나의 재생 가능한 MP4로 만들려면 세 가지를 손봐야 한다.
 *
 *  1. 두 init의 moov를 합쳐 trak을 둘 다 가진 moov 하나로 만든다
 *  2. 양쪽 트랙 ID가 모두 1이므로 소리 트랙을 2로 바꾼다
 *     (tkhd, trex, 그리고 모든 조각의 tfhd)
 *  3. moof의 일련번호를 파일 전체에서 증가하도록 다시 매기고
 *     조각을 영상·소리 번갈아 배치한다
 *
 * 조각 안의 데이터 오프셋은 건드리지 않아도 된다. DASH 조각은 tfhd에
 * default-base-is-moof 플래그가 켜져 있어 오프셋이 moof 시작점 기준이기 때문이다.
 * 즉 moof/mdat 쌍을 통째로 옮기는 건 안전하다. 이 플래그가 없으면 합치기를
 * 거부한다 — 잘못 옮기면 재생이 깨진다.
 *
 * 클래식 스크립트로 로드되며 globalThis.CMXFmp4 네임스페이스에 붙는다.
 */
(function (root) {
  'use strict';

  var TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
  var AUDIO_TRACK_ID = 2;

  function u32(bytes, offset) {
    return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) + bytes[offset + 3];
  }

  function writeU32(bytes, offset, value) {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  }

  function typeOf(bytes, offset) {
    return String.fromCharCode(bytes[offset + 4], bytes[offset + 5],
      bytes[offset + 6], bytes[offset + 7]);
  }

  /** 한 단계 아래 박스들을 훑는다. 64비트 크기와 "끝까지" 크기를 모두 처리한다. */
  function listBoxes(bytes, start, end) {
    var boxes = [];
    var p = start === undefined ? 0 : start;
    var limit = end === undefined ? bytes.length : end;

    while (p + 8 <= limit) {
      var size = u32(bytes, p);
      var headerSize = 8;

      if (size === 1) {
        // 64비트 크기 — 상위 32비트는 브라우저가 다룰 크기에서 항상 0이다
        if (p + 16 > limit) break;
        size = u32(bytes, p + 12);
        headerSize = 16;
      } else if (size === 0) {
        size = limit - p;
      }

      if (size < headerSize || p + size > limit) break;

      boxes.push({ type: typeOf(bytes, p), start: p, size: size, headerSize: headerSize });
      p += size;
    }
    return boxes;
  }

  var CONTAINERS = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf'];

  /** 컨테이너 박스를 재귀적으로 돌며 매 박스마다 콜백을 부른다. */
  function walk(bytes, start, end, visit) {
    var boxes = listBoxes(bytes, start, end);
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      visit(box);
      if (CONTAINERS.indexOf(box.type) !== -1) {
        walk(bytes, box.start + box.headerSize, box.start + box.size, visit);
      }
    }
  }

  function findBox(bytes, type, start, end) {
    var found = null;
    walk(bytes, start === undefined ? 0 : start,
      end === undefined ? bytes.length : end, function (box) {
        if (!found && box.type === type) found = box;
      });
    return found;
  }

  function slice(bytes, box) {
    return bytes.slice(box.start, box.start + box.size);
  }

  /** 복사된 조각 안의 tkhd / trex / tfhd 트랙 ID를 모두 바꾼다. */
  function setTrackId(bytes, newId) {
    walk(bytes, 0, bytes.length, function (box) {
      var body = box.start + box.headerSize;
      if (box.type === 'tkhd') {
        // version 1은 생성/수정 시각이 64비트라 track_ID 위치가 밀린다
        var version = bytes[body];
        writeU32(bytes, body + (version === 1 ? 20 : 12), newId);
      } else if (box.type === 'trex' || box.type === 'tfhd') {
        writeU32(bytes, body + 4, newId);
      }
    });
  }

  /** 모든 tfhd가 default-base-is-moof를 켜 두었는지 확인한다. */
  function offsetsAreMoofRelative(segment) {
    var ok = true;
    var seen = false;
    walk(segment, 0, segment.length, function (box) {
      if (box.type !== 'tfhd') return;
      seen = true;
      var flags = u32(segment, box.start + box.headerSize) & 0xffffff;
      if (!(flags & TFHD_DEFAULT_BASE_IS_MOOF)) ok = false;
    });
    return seen && ok;
  }

  /** 조각에서 moof/mdat 쌍만 꺼낸다 (styp, sidx는 버린다). */
  function mediaBoxes(segment) {
    var kept = [];
    var boxes = listBoxes(segment, 0, segment.length);
    for (var i = 0; i < boxes.length; i++) {
      // sidx는 파일 안 바이트 위치를 가리키므로 재배치하면 틀려진다 — 버린다
      if (boxes[i].type === 'moof' || boxes[i].type === 'mdat') {
        kept.push(slice(segment, boxes[i]));
      }
    }
    return kept;
  }

  function setSequenceNumber(moof, value) {
    var mfhd = findBox(moof, 'mfhd', 0, moof.length);
    if (mfhd) writeU32(moof, mfhd.start + mfhd.headerSize + 4, value);
  }

  /**
   * init 조각 하나와 미디어 조각들을 그대로 이어붙인다.
   * 트랙이 하나뿐일 때(영상만, 소리만) 쓴다.
   */
  function buildSingleTrack(init, segments) {
    var chunks = [init];
    var sequence = 1;

    for (var i = 0; i < segments.length; i++) {
      var boxes = mediaBoxes(segments[i]);
      for (var j = 0; j < boxes.length; j++) {
        if (typeOf(boxes[j], 0) === 'moof') setSequenceNumber(boxes[j], sequence++);
        chunks.push(boxes[j]);
      }
    }
    return chunks;
  }

  /**
   * 영상 트랙과 소리 트랙을 하나의 MP4로 합친다.
   * Blob에 그대로 넘길 수 있는 Uint8Array 배열을 돌려준다.
   */
  function mergeTracks(input) {
    var videoInit = input.videoInit;
    var audioInit = input.audioInit;

    if (!videoInit) return buildSingleTrack(audioInit, input.audioSegments || []);
    if (!audioInit) return buildSingleTrack(videoInit, input.videoSegments || []);

    var videoSegments = input.videoSegments || [];
    var audioSegments = input.audioSegments || [];

    // 조각을 옮겨도 안전한 형식인지 먼저 확인한다
    var sample = videoSegments[0] || audioSegments[0];
    if (sample && !offsetsAreMoofRelative(sample)) {
      throw new Error('MOOF_RELATIVE_UNSUPPORTED');
    }

    var videoFtyp = findBox(videoInit, 'ftyp');
    var videoMoov = findBox(videoInit, 'moov');
    var audioMoov = findBox(audioInit, 'moov');
    if (!videoMoov || !audioMoov) throw new Error('INIT_MOOV_MISSING');

    var mvhd = findBox(videoInit, 'mvhd', videoMoov.start, videoMoov.start + videoMoov.size);
    var videoTrak = findBox(videoInit, 'trak', videoMoov.start, videoMoov.start + videoMoov.size);
    var audioTrak = findBox(audioInit, 'trak', audioMoov.start, audioMoov.start + audioMoov.size);
    var videoMvex = findBox(videoInit, 'mvex', videoMoov.start, videoMoov.start + videoMoov.size);
    var audioTrex = findBox(audioInit, 'trex', audioMoov.start, audioMoov.start + audioMoov.size);
    if (!mvhd || !videoTrak || !audioTrak) throw new Error('INIT_TRAK_MISSING');

    // 소리 트랙을 2번으로 옮긴다 (양쪽 다 1번을 쓰고 있다)
    var audioTrakBytes = slice(audioInit, audioTrak);
    setTrackId(audioTrakBytes, AUDIO_TRACK_ID);

    var mvhdBytes = slice(videoInit, mvhd);
    // next_track_ID는 mvhd의 마지막 4바이트다
    writeU32(mvhdBytes, mvhdBytes.length - 4, AUDIO_TRACK_ID + 1);

    var mvexBytes = null;
    if (videoMvex && audioTrex) {
      var audioTrexBytes = slice(audioInit, audioTrex);
      setTrackId(audioTrexBytes, AUDIO_TRACK_ID);
      mvexBytes = appendInsideBox(slice(videoInit, videoMvex), audioTrexBytes);
    } else if (videoMvex) {
      mvexBytes = slice(videoInit, videoMvex);
    }

    var moovParts = [mvhdBytes, slice(videoInit, videoTrak), audioTrakBytes];
    if (mvexBytes) moovParts.push(mvexBytes);

    var chunks = [];
    if (videoFtyp) chunks.push(slice(videoInit, videoFtyp));
    chunks.push(wrapBox('moov', moovParts));

    // 조각을 영상·소리 번갈아 배치하고 일련번호를 다시 매긴다
    var sequence = 1;
    var count = Math.max(videoSegments.length, audioSegments.length);

    for (var i = 0; i < count; i++) {
      sequence = pushSegment(chunks, videoSegments[i], null, sequence);
      sequence = pushSegment(chunks, audioSegments[i], AUDIO_TRACK_ID, sequence);
    }
    return chunks;
  }

  function pushSegment(chunks, segment, trackId, sequence) {
    if (!segment) return sequence;

    var boxes = mediaBoxes(segment);
    for (var i = 0; i < boxes.length; i++) {
      if (typeOf(boxes[i], 0) === 'moof') {
        if (trackId !== null) setTrackId(boxes[i], trackId);
        setSequenceNumber(boxes[i], sequence++);
      }
      chunks.push(boxes[i]);
    }
    return sequence;
  }

  /** 기존 박스 끝에 자식 박스를 덧붙이고 크기를 다시 쓴다. */
  function appendInsideBox(boxBytes, childBytes) {
    var merged = new Uint8Array(boxBytes.length + childBytes.length);
    merged.set(boxBytes, 0);
    merged.set(childBytes, boxBytes.length);
    writeU32(merged, 0, merged.length);
    return merged;
  }

  /** 자식 조각들을 새 박스로 감싼다. */
  function wrapBox(type, parts) {
    var total = 8;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;

    var out = new Uint8Array(total);
    writeU32(out, 0, total);
    for (var c = 0; c < 4; c++) out[4 + c] = type.charCodeAt(c);

    var offset = 8;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], offset);
      offset += parts[j].length;
    }
    return out;
  }

  root.CMXFmp4 = {
    mergeTracks: mergeTracks,
    buildSingleTrack: buildSingleTrack,
    listBoxes: listBoxes,
    findBox: findBox,
    setTrackId: setTrackId,
    offsetsAreMoofRelative: offsetsAreMoofRelative
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
