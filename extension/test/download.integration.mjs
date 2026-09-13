/**
 * 통합 테스트 — 실제 offscreen 작업자 코드를 진짜 HLS 스트림에 그대로 돌린다.
 *
 * 네트워크가 필요하므로 단위 테스트와 분리해 둔다.
 *   node test/download.integration.mjs <m3u8-url> <mp4|m4a> <출력경로>
 *
 * chrome.* API만 최소한으로 흉내내고, 나머지(플레이리스트 파싱, 동시 다운로드,
 * 순서 보장, 리먹스)는 확장에 실제로 실리는 코드가 그대로 실행된다.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [url, format = 'mp4', outPath = 'out.mp4'] = process.argv.slice(2);
if (!url) {
  console.error('사용법: node test/download.integration.mjs <m3u8-url> [mp4|m4a] [출력경로]');
  process.exit(2);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------- 브라우저 비슷한 실행 환경 ----------

const listeners = [];
let finished = null;
let lastProgress = null;

// 스텁 환경에는 Blob URL이 없으므로 Blob 자체를 가로챈다
let capturedBlob = null;
class URLShim extends URL {}
URLShim.createObjectURL = (blob) => { capturedBlob = blob; return 'blob:test/captured'; };
URLShim.revokeObjectURL = () => {};

const sandbox = {
  console, fetch, Blob, AbortController, URL: URLShim, TextDecoder, TextEncoder,
  setTimeout, clearTimeout, Date, Math, JSON, Promise, Error, TypeError, RangeError,
  Uint8Array, Uint32Array, Int32Array, Uint16Array, Int16Array, Int8Array,
  Float32Array, Float64Array, ArrayBuffer, DataView,
  Object, Array, String, Number, Boolean, Function, Symbol, Map, Set, RegExp,
  isNaN, parseInt, parseFloat,

  chrome: {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg) => {
        if (msg.type === 'CMX_PROGRESS') lastProgress = Object.assign(lastProgress || {}, msg.payload.patch);
        if (msg.type === 'CMX_OFFSCREEN_DONE') finished = msg.payload;
        return Promise.resolve();
      }
    }
  }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 확장이 로드하는 순서 그대로 (offscreen.html 참고)
vm.runInContext(read('vendor/mux-mp4.min.js'), sandbox, { filename: 'mux-mp4.min.js' });
vm.runInContext(read('src/common/extract.js'), sandbox, { filename: 'extract.js' });
vm.runInContext(read('src/common/dash.js'), sandbox, { filename: 'dash.js' });
vm.runInContext(read('src/common/fmp4.js'), sandbox, { filename: 'fmp4.js' });
vm.runInContext(read('src/offscreen/offscreen.js'), sandbox, { filename: 'offscreen.js' });

// ---------- 실행 ----------

const started = Date.now();
let ticks = 0;
const progressTimer = setInterval(() => {
  if (!lastProgress) return;
  ticks++;
  const pct = Math.round((lastProgress.progress || 0) * 100);
  process.stdout.write(
    `\r  ${lastProgress.stage || ''} ${pct}%  ` +
    `${lastProgress.segmentsDone || 0}/${lastProgress.segmentsTotal || 0}   `);
}, 250);

console.log(`format=${format}\nurl=${url.slice(0, 78)}…\n`);
listeners.forEach((fn) => fn({
  type: 'CMX_OFFSCREEN_START',
  payload: { jobId: 'test', url, format, kind: sandbox.CMX.classifyUrl(url) || 'hls' }
}));

while (!finished) await new Promise((r) => setTimeout(r, 100));
clearInterval(progressTimer);
process.stdout.write('\r' + ' '.repeat(70) + '\r');

if (!finished.ok) {
  console.error('FAILED:', finished.error);
  process.exit(1);
}

const bytes = Buffer.from(await capturedBlob.arrayBuffer());
fs.writeFileSync(outPath, bytes);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`OK  ${outPath}`);
console.log(`    ${(bytes.length / 1048576).toFixed(1)} MB in ${elapsed}s`);
console.log(`    세그먼트 ${lastProgress.segmentsTotal}개, 진행 보고 ${ticks}회 관측`);
