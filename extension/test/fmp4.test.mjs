/**
 * fMP4 트랙 합치기 테스트.
 *
 * 실제 MP4 박스를 손으로 만들어 검사한다. 네트워크는 쓰지 않는다.
 * (실제 DASH 스트림 검증은 test/download.integration.mjs)
 *
 * 실행: node --test test/fmp4.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = { console, Uint8Array, String, Math, Error };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'src/common/fmp4.js'), 'utf8'),
  sandbox, { filename: 'fmp4.js' });
const F = sandbox.CMXFmp4;

// ---------- 박스 조립 도우미 ----------

function box(type, ...parts) {
  const body = parts.flatMap((p) => Array.from(p));
  const size = 8 + body.length;
  return Uint8Array.from([
    (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...body
  ]);
}

const u32 = (n) => Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const zeros = (n) => new Uint8Array(n);

/** tkhd: version/flags(4) + creation(4) + modification(4) + track_ID(4) */
const tkhd = (id) => box('tkhd', zeros(4), zeros(8), u32(id), zeros(60));
/** trex/tfhd: version/flags(4) + track_ID(4) */
const trex = (id) => box('trex', zeros(4), u32(id), zeros(16));
const tfhd = (id, flags) => box('tfhd', Uint8Array.from([0, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]), u32(id));
const mfhd = (seq) => box('mfhd', zeros(4), u32(seq));
/** mvhd 끝 4바이트가 next_track_ID */
const mvhd = () => box('mvhd', zeros(96), u32(1));

const DEFAULT_BASE_IS_MOOF = 0x020000;

function initSegment(trackId) {
  return Uint8Array.from([
    ...box('ftyp', zeros(16)),
    ...box('moov', mvhd(), box('trak', tkhd(trackId)), box('mvex', trex(trackId)))
  ]);
}

function mediaSegment(trackId, seq, payload, flags = DEFAULT_BASE_IS_MOOF) {
  return Uint8Array.from([
    ...box('styp', zeros(8)),           // 버려져야 한다
    ...box('sidx', zeros(24)),          // 버려져야 한다 (바이트 위치를 가리킴)
    ...box('moof', mfhd(seq), box('traf', tfhd(trackId, flags))),
    ...box('mdat', payload)
  ]);
}

/** 결과 청크를 이어붙여 최상위 박스 타입 순서를 얻는다 */
function topLevelTypes(chunks) {
  const merged = Uint8Array.from(chunks.flatMap((c) => Array.from(c)));
  return F.listBoxes(merged, 0, merged.length).map((b) => b.type);
}

function readU32(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3];
}

// ---------- 테스트 ----------

test('최상위 박스를 훑는다', () => {
  const boxes = F.listBoxes(initSegment(1), 0, initSegment(1).length);
  assert.equal(boxes.map((b) => b.type).join(','), 'ftyp,moov');
});

test('중첩된 박스를 찾는다', () => {
  const init = initSegment(1);
  assert.ok(F.findBox(init, 'tkhd'));
  assert.ok(F.findBox(init, 'trex'));
  assert.equal(F.findBox(init, 'nope'), null);
});

test('tkhd와 trex의 트랙 ID를 함께 바꾼다', () => {
  const init = initSegment(1);
  F.setTrackId(init, 2);
  assert.equal(readU32(init, F.findBox(init, 'tkhd').start + 8 + 12), 2);
  assert.equal(readU32(init, F.findBox(init, 'trex').start + 8 + 4), 2);
});

test('default-base-is-moof 여부를 판별한다', () => {
  assert.equal(F.offsetsAreMoofRelative(mediaSegment(1, 1, zeros(4))), true);
  assert.equal(F.offsetsAreMoofRelative(mediaSegment(1, 1, zeros(4), 0)), false);
});

test('조각을 옮길 수 없는 형식이면 합치기를 거부한다', () => {
  assert.throws(() => F.mergeTracks({
    videoInit: initSegment(1), videoSegments: [mediaSegment(1, 1, zeros(4), 0)],
    audioInit: initSegment(1), audioSegments: [mediaSegment(1, 1, zeros(4), 0)]
  }), /MOOF_RELATIVE_UNSUPPORTED/);
});

test('두 트랙을 담은 moov 하나를 만든다', () => {
  const chunks = F.mergeTracks({
    videoInit: initSegment(1), videoSegments: [mediaSegment(1, 1, zeros(8))],
    audioInit: initSegment(1), audioSegments: [mediaSegment(1, 1, zeros(8))]
  });

  const merged = Uint8Array.from(chunks.flatMap((c) => Array.from(c)));
  const moov = F.findBox(merged, 'moov');
  assert.ok(moov);

  // trak이 두 개, trex도 두 개여야 한다
  let traks = 0;
  let trexs = 0;
  const boxes = F.listBoxes(merged, moov.start + 8, moov.start + moov.size);
  boxes.forEach((b) => { if (b.type === 'trak') traks++; });
  const mvex = F.findBox(merged, 'mvex', moov.start, moov.start + moov.size);
  F.listBoxes(merged, mvex.start + 8, mvex.start + mvex.size)
    .forEach((b) => { if (b.type === 'trex') trexs++; });

  assert.equal(traks, 2);
  assert.equal(trexs, 2);
});

test('styp와 sidx를 버리고 moof/mdat만 남긴다', () => {
  const chunks = F.mergeTracks({
    videoInit: initSegment(1), videoSegments: [mediaSegment(1, 1, zeros(8))],
    audioInit: initSegment(1), audioSegments: [mediaSegment(1, 1, zeros(8))]
  });
  const types = topLevelTypes(chunks).join(',');

  assert.equal(types, 'ftyp,moov,moof,mdat,moof,mdat');
  assert.ok(!types.includes('styp'));
  assert.ok(!types.includes('sidx'));
});

test('소리 조각의 트랙 ID를 2로 바꾼다', () => {
  const chunks = F.mergeTracks({
    videoInit: initSegment(1), videoSegments: [mediaSegment(1, 1, zeros(8))],
    audioInit: initSegment(1), audioSegments: [mediaSegment(1, 1, zeros(8))]
  });

  // moof는 3번째와 5번째 청크 (ftyp, moov, moof, mdat, moof, mdat)
  const videoMoof = chunks[2];
  const audioMoof = chunks[4];
  const idOf = (moof) => readU32(moof, F.findBox(moof, 'tfhd').start + 8 + 4);

  assert.equal(idOf(videoMoof), 1);
  assert.equal(idOf(audioMoof), 2);
});

test('일련번호를 파일 전체에서 증가시킨다', () => {
  const chunks = F.mergeTracks({
    videoInit: initSegment(1),
    videoSegments: [mediaSegment(1, 1, zeros(8)), mediaSegment(1, 1, zeros(8))],
    audioInit: initSegment(1),
    audioSegments: [mediaSegment(1, 1, zeros(8)), mediaSegment(1, 1, zeros(8))]
  });

  const seqs = chunks
    .filter((c) => c.length >= 8 && String.fromCharCode(c[4], c[5], c[6], c[7]) === 'moof')
    .map((moof) => readU32(moof, F.findBox(moof, 'mfhd').start + 8 + 4));

  assert.equal(seqs.join(','), '1,2,3,4');
});

test('영상·소리를 번갈아 배치한다', () => {
  const chunks = F.mergeTracks({
    videoInit: initSegment(1),
    videoSegments: [mediaSegment(1, 1, zeros(8)), mediaSegment(1, 1, zeros(8))],
    audioInit: initSegment(1),
    audioSegments: [mediaSegment(1, 1, zeros(8)), mediaSegment(1, 1, zeros(8))]
  });

  const trackOrder = chunks
    .filter((c) => c.length >= 8 && String.fromCharCode(c[4], c[5], c[6], c[7]) === 'moof')
    .map((moof) => readU32(moof, F.findBox(moof, 'tfhd').start + 8 + 4));

  assert.equal(trackOrder.join(','), '1,2,1,2');
});

test('next_track_ID를 3으로 올린다', () => {
  const chunks = F.mergeTracks({
    videoInit: initSegment(1), videoSegments: [mediaSegment(1, 1, zeros(8))],
    audioInit: initSegment(1), audioSegments: [mediaSegment(1, 1, zeros(8))]
  });
  const merged = Uint8Array.from(chunks.flatMap((c) => Array.from(c)));
  const mv = F.findBox(merged, 'mvhd');
  assert.equal(readU32(merged, mv.start + mv.size - 4), 3);
});

test('트랙이 하나뿐이면 그대로 이어붙인다', () => {
  const chunks = F.mergeTracks({
    videoInit: initSegment(1),
    videoSegments: [mediaSegment(1, 7, zeros(8)), mediaSegment(1, 9, zeros(8))],
    audioInit: null, audioSegments: []
  });

  assert.equal(topLevelTypes(chunks).join(','), 'ftyp,moov,moof,mdat,moof,mdat');

  const seqs = chunks
    .filter((c) => c.length >= 8 && String.fromCharCode(c[4], c[5], c[6], c[7]) === 'moof')
    .map((moof) => readU32(moof, F.findBox(moof, 'mfhd').start + 8 + 4));
  assert.equal(seqs.join(','), '1,2');
});

test('64비트 크기 박스를 읽는다', () => {
  // size=1 이면 뒤따르는 64비트 값이 실제 크기다
  const large = Uint8Array.from([
    0, 0, 0, 1, ...[...'mdat'].map((c) => c.charCodeAt(0)),
    0, 0, 0, 0, 0, 0, 0, 20,
    1, 2, 3, 4
  ]);
  const boxes = F.listBoxes(large, 0, large.length);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].type, 'mdat');
  assert.equal(boxes[0].size, 20);
  assert.equal(boxes[0].headerSize, 16);
});
