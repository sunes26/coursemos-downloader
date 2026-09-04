/**
 * DASH 매니페스트 파서 테스트.
 * 실행: node --test test/dash.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = { console, URL, parseInt, parseFloat, isNaN, Math, String, Number };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'src/common/dash.js'), 'utf8'),
  sandbox, { filename: 'dash.js' });
const D = sandbox.CMXDash;

const MANIFEST_URL = 'https://cdn.example.com/media/manifest.mpd';

// dash.akamaized.net 실제 구조를 줄인 것 — 영상·소리가 별도 AdaptationSet
const LIVE_PROFILE = `<MPD mediaPresentationDuration="PT634.566S" type="static">
 <BaseURL>./</BaseURL>
 <Period>
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <SegmentTemplate duration="120" timescale="30" media="$RepresentationID$/$RepresentationID$_$Number$.m4v" startNumber="1" initialization="$RepresentationID$/$RepresentationID$_0.m4v"/>
   <Representation id="v720" codecs="avc1.64001f" bandwidth="4952892" width="1280" height="720"/>
   <Representation id="v1080" codecs="avc1.640028" bandwidth="9914554" width="1920" height="1080"/>
   <Representation id="v360" codecs="avc1.64001e" bandwidth="1254758" width="640" height="360"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio">
   <SegmentTemplate duration="192512" timescale="48000" media="$RepresentationID$/$RepresentationID$_$Number$.m4a" startNumber="1" initialization="$RepresentationID$/$RepresentationID$_0.m4a"/>
   <Representation id="a64k" codecs="mp4a.40.5" bandwidth="67071" audioSamplingRate="48000"/>
  </AdaptationSet>
 </Period>
</MPD>`;

test('ISO 8601 기간을 초로 바꾼다', () => {
  assert.equal(D.parseDuration('PT634.566S'), 634.566);
  assert.equal(D.parseDuration('PT1H2M3S'), 3723);
  assert.equal(D.parseDuration('PT10M'), 600);
  assert.equal(D.parseDuration(''), 0);
  assert.equal(D.parseDuration('garbage'), 0);
});

test('자기닫힘 태그를 개별 요소로 센다', () => {
  // 속성부가 끝의 '/'를 삼키면 전부 하나로 뭉쳐 보인다 — 회귀 방지
  const reps = D.findElements(LIVE_PROFILE, 'Representation');
  assert.equal(reps.length, 4);
  assert.equal(reps[0].attrs.id, 'v720');
});

test('영상 표현을 대역폭 내림차순으로 정렬한다', () => {
  const r = D.parseMpd(LIVE_PROFILE, MANIFEST_URL);
  // VM 실현체가 달라 배열 자체 비교는 못 하므로 문자열로 맞춘다
  assert.equal(r.video.map((v) => v.id).join(','), 'v1080,v720,v360');
  assert.equal(r.video[0].height, 1080);
});

test('영상과 소리를 따로 담는다', () => {
  const r = D.parseMpd(LIVE_PROFILE, MANIFEST_URL);
  assert.equal(r.video.length, 3);
  assert.equal(r.audio.length, 1);
  assert.equal(r.audio[0].id, 'a64k');
});

test('세그먼트 개수를 재생 시간으로 계산한다', () => {
  const r = D.parseMpd(LIVE_PROFILE, MANIFEST_URL);
  // 634.566초 / (120/30초) = 158.6 → 159개
  assert.equal(r.video[0].segmentUrls.length, 159);
  assert.equal(r.duration, 634.566);
});

test('자리표시자를 채워 절대 URL을 만든다', () => {
  const r = D.parseMpd(LIVE_PROFILE, MANIFEST_URL);
  assert.equal(r.video[0].initUrl, 'https://cdn.example.com/media/v1080/v1080_0.m4v');
  assert.equal(r.video[0].segmentUrls[0], 'https://cdn.example.com/media/v1080/v1080_1.m4v');
  assert.equal(r.audio[0].initUrl, 'https://cdn.example.com/media/a64k/a64k_0.m4a');
});

test('$Number%05d$ 자리수 채우기를 지원한다', () => {
  assert.equal(D.fillTemplate('seg-$Number%05d$.m4s', { Number: 42 }), 'seg-00042.m4s');
  assert.equal(D.fillTemplate('$RepresentationID$/x', { RepresentationID: 'v1' }), 'v1/x');
  assert.equal(D.fillTemplate('b$Bandwidth$', { Bandwidth: 1000 }), 'b1000');
});

test('SegmentTimeline을 펼친다', () => {
  const xml = `<MPD mediaPresentationDuration="PT12S"><Period>
   <AdaptationSet contentType="video">
    <SegmentTemplate timescale="1000" media="s-$Time$.m4s" initialization="init.m4s">
     <SegmentTimeline><S t="0" d="4000" r="2"/></SegmentTimeline>
    </SegmentTemplate>
    <Representation id="v" bandwidth="1000" width="640" height="360"/>
   </AdaptationSet>
  </Period></MPD>`;
  const r = D.parseMpd(xml, MANIFEST_URL);

  assert.equal(r.video[0].segmentUrls.length, 3);
  assert.equal(r.video[0].segmentUrls[0], 'https://cdn.example.com/media/s-0.m4s');
  assert.equal(r.video[0].segmentUrls[2], 'https://cdn.example.com/media/s-8000.m4s');
});

test('BaseURL을 매니페스트 주소에 이어 붙인다', () => {
  const xml = LIVE_PROFILE.replace('<BaseURL>./</BaseURL>', '<BaseURL>v2/</BaseURL>');
  const r = D.parseMpd(xml, MANIFEST_URL);
  assert.equal(r.video[0].initUrl, 'https://cdn.example.com/media/v2/v1080/v1080_0.m4v');
});

test('DRM이 걸린 매니페스트를 표시한다', () => {
  const xml = LIVE_PROFILE.replace('<Representation id="v720"',
    '<ContentProtection schemeIdUri="urn:uuid:EDEF8BA9"/><Representation id="v720"');
  assert.equal(D.parseMpd(xml, MANIFEST_URL).encrypted, true);
  assert.equal(D.parseMpd(LIVE_PROFILE, MANIFEST_URL).encrypted, false);
});

test('빈 입력을 견딘다', () => {
  const r = D.parseMpd('<MPD></MPD>', MANIFEST_URL);
  assert.equal(r.video.length, 0);
  assert.equal(r.audio.length, 0);
});
