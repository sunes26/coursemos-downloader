/**
 * 웹스토어 업로드용 zip 패키지 생성기.
 *
 * 왜 직접 만드나:
 * 윈도우의 Compress-Archive 는 zip 안의 경로를 역슬래시로 적는다. zip 규격은
 * 슬래시를 요구하기 때문에 그렇게 만든 파일은 스토어에서 폴더 구조가 깨지거나
 * 거부될 수 있다. 그래서 zlib 만 써서 규격대로 직접 쓴다.
 *
 * 개발용 파일(test, tools, package.json, README)은 넣지 않는다.
 * vendor/mux.js-LICENSE 는 Apache-2.0 고지 의무가 있어 반드시 넣는다.
 *
 * 실행: node tools/make-package.mjs [출력경로]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 배포에 들어가는 것만 명시한다. 빼먹는 쪽보다 넣지 말아야 할 걸 넣는 쪽이 위험하다. */
const INCLUDE = ['manifest.json', 'icons', 'src', 'vendor'];

function collect(relative) {
  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];

  return fs.readdirSync(absolute)
    .flatMap((entry) => collect(path.join(relative, entry)));
}

// ---------- zip 쓰기 ----------

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 날짜를 고정하면 내용이 같을 때 zip도 같아져 비교가 쉬워진다 */
const DOS_TIME = 0;
const DOS_DATE = (2024 - 1980) << 9 | (1 << 5) | 1;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    // zip 규격은 경로 구분자로 슬래시만 허용한다
    const name = Buffer.from(entry.name.split(path.sep).join('/'), 'utf8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(8, 8);             // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE(0, 38);          // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------- 실행 ----------

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const outPath = process.argv[2] ||
  path.join(root, '..', `coursemos-downloader-${manifest.version}.zip`);

const files = INCLUDE.flatMap(collect).sort();
if (!files.includes('manifest.json')) {
  throw new Error('manifest.json 이 패키지에 없습니다.');
}

const entries = files.map((name) => ({
  name,
  data: fs.readFileSync(path.join(root, name))
}));

const zip = buildZip(entries);
fs.writeFileSync(outPath, zip);

console.log(`이름 : ${manifest.name}`);
console.log(`버전 : ${manifest.version}`);
console.log(`파일 : ${entries.length}개`);
for (const entry of entries) {
  console.log(`   ${entry.name.split(path.sep).join('/')}`);
}
console.log(`\n출력 : ${outPath}`);
console.log(`크기 : ${(zip.length / 1024).toFixed(1)} KB`);
