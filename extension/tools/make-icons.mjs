/**
 * 확장 아이콘 생성기 — Figma의 C01 Faithful 안을 그대로 그린다.
 *
 * 파란 마름모(45도 돌린 둥근 정사각형) + 흰색 C.
 * 좌표는 Figma 128×128 프레임의 값을 그대로 옮겼다. 값을 고칠 일이 있으면
 * Figma 파일(Icon Drafts — C mark › C01 Faithful)과 함께 맞춰야 한다.
 *
 * 외부 이미지 라이브러리 없이 zlib만으로 PNG를 직접 만든다.
 * 실행: node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BRAND = [0x3f, 0x6a, 0xd8];
const WHITE = [0xff, 0xff, 0xff];
const SIZES = [16, 32, 48, 128];

// 한 픽셀당 SUPERSAMPLE² 번 표본을 뽑아 계단현상을 없앤다
const SUPERSAMPLE = 6;

// ---------- Figma 128×128 프레임 기준 도형 ----------

const CANVAS = 128;

// 마름모: 한 변 83.4 정사각형을 45도 회전, 모서리 반경 10, 중심 (64, 64)
const DIAMOND = { cx: 64, cy: 64, half: 83.4 / 2, radius: 10, angle: Math.PI / 4 };

// C: 지름 58 원의 고리를 부분만 그린 것. 오른쪽이 열려 있다.
// 중심은 (67, 64) — 잘려나간 오른쪽 때문에 눈에 보이는 잉크의 중심은 x=61이 된다.
const LETTER_C = {
  cx: 67,
  cy: 64,
  outer: 29,
  inner: 29 * 0.66,
  startAngle: Math.PI * 0.3,
  endAngle: Math.PI * 1.7
};

/**
 * 작은 크기 전용 보정.
 *
 * C의 흰 획은 128px 기준 9.9단위다. 그대로 줄이면 16px에서 1.2px가 되어
 * 획이 사라지고 파란 덩어리로 보인다. 16px에서만 고리를 키우고 굵혀
 * 획이 2px대를 유지하게 한다. 큰 크기는 Figma 값 그대로 쓴다.
 *
 * FAITHFUL=1 로 실행하면 보정을 끄고 모든 크기를 원본 비율로 그린다.
 */
const SIZE_TUNING = {
  16: { outer: 33, inner: 15.4 }
};

function letterFor(size) {
  const tuning = process.env.FAITHFUL ? null : SIZE_TUNING[size];
  return tuning ? { ...LETTER_C, ...tuning } : LETTER_C;
}

/** 45도 돌린 둥근 정사각형 내부인지 판정한다. */
function insideDiamond(x, y) {
  const dx = x - DIAMOND.cx;
  const dy = y - DIAMOND.cy;

  // 정사각형의 지역 좌표로 되돌린다 (회전을 반대로 적용)
  const cos = Math.cos(-DIAMOND.angle);
  const sin = Math.sin(-DIAMOND.angle);
  const lx = Math.abs(dx * cos - dy * sin);
  const ly = Math.abs(dx * sin + dy * cos);

  // 둥근 사각형까지의 거리 — 모서리는 반경 안쪽이어야 한다
  const edge = DIAMOND.half - DIAMOND.radius;
  const qx = Math.max(lx - edge, 0);
  const qy = Math.max(ly - edge, 0);
  return Math.hypot(qx, qy) <= DIAMOND.radius;
}

/** C(부분 고리) 내부인지 판정한다. */
function insideC(x, y, letter) {
  const dx = x - letter.cx;
  const dy = y - letter.cy;
  const distance = Math.hypot(dx, dy);
  if (distance < letter.inner || distance > letter.outer) return false;

  // 화면 좌표는 y가 아래로 향하므로 각도는 3시 방향에서 시계방향으로 커진다
  let angle = Math.atan2(dy, dx);
  if (angle < 0) angle += Math.PI * 2;
  return angle >= letter.startAngle && angle <= letter.endAngle;
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const scale = CANVAS / size;
  const letter = letterFor(size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let plateHits = 0;
      let letterHits = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) * scale;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) * scale;

          const onPlate = insideDiamond(x, y);
          if (onPlate) plateHits++;
          // C는 마름모 안에 완전히 들어가지만, 혹시 어긋나도 튀어나오지 않게 막는다
          if (onPlate && insideC(x, y, letter)) letterHits++;
        }
      }

      if (plateHits === 0) continue;

      const alpha = plateHits / samples;
      const letterRatio = letterHits / plateHits;
      const offset = (py * size + px) * 4;

      for (let c = 0; c < 3; c++) {
        pixels[offset + c] = Math.round(
          BRAND[c] * (1 - letterRatio) + WHITE[c] * letterRatio);
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return pixels;
}

// ---------- PNG 인코딩 ----------

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

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
  return c ^ -1;
}

function encodePng(pixels, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of SIZES) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(renderIcon(size), size));

  const letter = letterFor(size);
  const strokePx = ((letter.outer - letter.inner) * size / CANVAS).toFixed(2);
  const tuned = letter !== LETTER_C ? '  (작은 크기 보정)' : '';
  console.log(`${path.basename(file).padEnd(14)} ${String(fs.statSync(file).size).padStart(5)} B` +
    `   C 획 ${strokePx}px${tuned}`);
}
