/**
 * 공유 추출 유틸리티 테스트.
 * 실행: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// extract.js 는 클래식 스크립트라 브라우저처럼 전역에 붙여 로드한다
const sandbox = { console };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'src/common/extract.js'), 'utf8'),
  sandbox, { filename: 'extract.js' });
const raw = sandbox.CMX;

// VM 실현체(realm)가 달라 배열 프로토타입이 다르므로 호스트 배열로 옮겨 비교한다
const CMX = Object.assign(Object.create(null), raw, {
  extractM3u8Urls: (input) => Array.from(raw.extractM3u8Urls(input)),
  guessPlaylistsFromSegments: (urls, n) =>
    Array.from(raw.guessPlaylistsFromSegments(urls, n)).sort()
});

// 인천대학교 LMS 실제 구조 (data-setup-lazy: HTML 엔티티 + JSON 이스케이프 이중 인코딩)
const INU_HTML = `<!DOCTYPE html><html lang="ko"><head>
<title>[2026-1 기초학습]AI와 함께하는 영어 리스닝-011 : AI 리스닝 클리닉 1강 1차시 | 인천대학교 LMS</title>
</head><body>
<div id="my-video" class="video-js" data-setup-lazy="{&quot;language&quot;:&quot;ko&quot;,&quot;sources&quot;:{&quot;src&quot;:&quot;https:\\/\\/cdn.example.com\\/hls\\/TOKEN__\\/abc-123\\/mp4\\/abc-123.mp4\\/index.m3u8&quot;,&quot;type&quot;:&quot;application\\/x-mpegURL&quot;}}">
<video id="my-video_html5_api" class="vjs-tech"></video></div></body></html>`;

test('이중 인코딩된 속성에서 m3u8을 찾는다', () => {
  assert.deepEqual(CMX.extractM3u8Urls(INU_HTML),
    ['https://cdn.example.com/hls/TOKEN__/abc-123/mp4/abc-123.mp4/index.m3u8']);
});

test('스크립트 안의 평문 URL도 찾는다', () => {
  const html = '<script>var s = "https://cdn.example.com/plain/index.m3u8";</script>';
  assert.deepEqual(CMX.extractM3u8Urls(html), ['https://cdn.example.com/plain/index.m3u8']);
});

test('중복을 제거하고 등장 순서를 지킨다', () => {
  const html = 'https://x.com/b.m3u8 https://x.com/a.m3u8 https://x.com/b.m3u8';
  assert.deepEqual(CMX.extractM3u8Urls(html), ['https://x.com/b.m3u8', 'https://x.com/a.m3u8']);
});

test('쿼리 문자열을 보존한다', () => {
  assert.deepEqual(CMX.extractM3u8Urls('src="https://x.com/a.m3u8?token=t&amp;e=1"'),
    ['https://x.com/a.m3u8?token=t&e=1']);
});

test('영상이 없으면 빈 배열', () => {
  assert.deepEqual(CMX.extractM3u8Urls('<html><body>none</body></html>'), []);
  assert.deepEqual(CMX.extractM3u8Urls(''), []);
  assert.deepEqual(CMX.extractM3u8Urls(null), []);
});

test('제목에서 사이트 꼬리표와 과목명을 걷어낸다', () => {
  const title = INU_HTML.match(/<title[^>]*>(.*?)<\/title>/s)[1];
  assert.equal(CMX.extractPageTitle(title), 'AI 리스닝 클리닉 1강 1차시');
});

test('파일명에서 금지 문자를 없앤다', () => {
  assert.equal(CMX.sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(CMX.sanitizeFilename('  이름...  '), '이름');
  assert.equal(CMX.sanitizeFilename(''), 'video');
  assert.equal(CMX.sanitizeFilename('x'.repeat(200)).length, 80);
});

test('미디어 플레이리스트를 파싱한다', () => {
  const text = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:10.000,', 'segment-1.ts',
    '#EXTINF:9.500,', 'segment-2.ts',
    '#EXT-X-ENDLIST'
  ].join('\n');
  const r = CMX.parsePlaylist(text, 'https://cdn.example.com/hls/x/index.m3u8');

  assert.equal(r.isMaster, false);
  assert.equal(r.encrypted, false);
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0], 'https://cdn.example.com/hls/x/segment-1.ts');
  assert.equal(r.totalDuration, 19.5);
});

test('마스터 플레이리스트는 대역폭 내림차순으로 정렬한다', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720', 'high.m3u8'
  ].join('\n');
  const r = CMX.parsePlaylist(text, 'https://cdn.example.com/hls/index.m3u8');

  assert.equal(r.isMaster, true);
  assert.equal(r.variants[0].resolution, '1280x720');
  assert.equal(r.variants[0].url, 'https://cdn.example.com/hls/high.m3u8');
});

test('절대 URL 세그먼트를 그대로 둔다', () => {
  const text = '#EXTM3U\n#EXTINF:10.0,\nhttps://other.cdn.com/s1.ts';
  const r = CMX.parsePlaylist(text, 'https://cdn.example.com/hls/index.m3u8');
  assert.equal(r.segments[0], 'https://other.cdn.com/s1.ts');
});

test('암호화된 스트림을 표시한다', () => {
  const enc = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:10.0,\ns1.ts';
  assert.equal(CMX.parsePlaylist(enc, 'https://x.com/i.m3u8').encrypted, true);

  const none = '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:10.0,\ns1.ts';
  assert.equal(CMX.parsePlaylist(none, 'https://x.com/i.m3u8').encrypted, false);
});

test('시간과 용량을 사람이 읽는 형태로 만든다', () => {
  assert.equal(CMX.formatDuration(869), '14:29');
  assert.equal(CMX.formatDuration(3661), '1:01:01');
  assert.equal(CMX.formatBytes(0), '0 B');
  assert.equal(CMX.formatBytes(1536), '1.5 KB');
  assert.equal(CMX.formatBytes(224 * 1048576), '224.0 MB');
});

// ---------- 다른 사이트 일반화 ----------

test('Resource Timing에 남은 URL에서 m3u8을 뽑는다', () => {
  // 플레이어가 DOM에 아무것도 남기지 않고 fetch만 한 경우
  const entries = [
    'https://cdn.site.com/app.js',
    'https://cdn.site.com/hls/master.m3u8?token=abc',
    'https://cdn.site.com/hls/720p/seg-1.ts'
  ];
  const found = entries
    .filter((u) => u.includes('.m3u8'))
    .flatMap((u) => Array.from(CMX.extractM3u8Urls(u)));
  assert.deepEqual(found, ['https://cdn.site.com/hls/master.m3u8?token=abc']);
});

test('세그먼트가 충분히 모인 디렉터리에서 플레이리스트를 추론한다', () => {
  const urls = [
    'https://cdn.site.com/v/720/seg-1.ts',
    'https://cdn.site.com/v/720/seg-2.ts',
    'https://cdn.site.com/v/720/seg-3.ts',
    'https://cdn.site.com/other/app.js'
  ];
  assert.deepEqual(CMX.guessPlaylistsFromSegments(urls),
    ['https://cdn.site.com/v/720/index.m3u8']);
});

test('세그먼트가 적으면 추론하지 않는다', () => {
  const urls = ['https://cdn.site.com/v/seg-1.ts', 'https://cdn.site.com/v/seg-2.ts'];
  assert.deepEqual(CMX.guessPlaylistsFromSegments(urls), []);
});

test('세그먼트 추론에서 쿼리 문자열을 무시한다', () => {
  const urls = [
    'https://cdn.site.com/v/s1.ts?t=1',
    'https://cdn.site.com/v/s2.ts?t=2',
    'https://cdn.site.com/v/s3.ts?t=3'
  ];
  assert.deepEqual(CMX.guessPlaylistsFromSegments(urls),
    ['https://cdn.site.com/v/index.m3u8']);
});

test('.ts 가 아닌 URL은 추론에서 제외한다', () => {
  const urls = [
    'https://cdn.site.com/v/a.tsx',
    'https://cdn.site.com/v/b.tsx',
    'https://cdn.site.com/v/c.tsx'
  ];
  assert.deepEqual(CMX.guessPlaylistsFromSegments(urls), []);
});

test('빈 입력을 견딘다', () => {
  assert.deepEqual(CMX.guessPlaylistsFromSegments([]), []);
  assert.deepEqual(CMX.guessPlaylistsFromSegments(null), []);
});

test('mux 테스트 스트림 형태의 마스터에서 최고 화질을 고른다', () => {
  // 실제 test-streams.mux.dev 구조 — 파일 순서가 대역폭 순이 아니다
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=2149280,RESOLUTION=1280x720', 'url_0/hd.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=246440,RESOLUTION=320x184', 'url_2/ld.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=6221600,RESOLUTION=1920x1080', 'url_8/fhd.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=836280,RESOLUTION=848x480', 'url_6/hq.m3u8'
  ].join(String.fromCharCode(10));
  const r = CMX.parsePlaylist(text, 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8');

  assert.equal(r.isMaster, true);
  assert.equal(r.variants.length, 4);
  assert.equal(r.variants[0].resolution, '1920x1080');
  assert.equal(r.variants[0].url, 'https://test-streams.mux.dev/x36xhzz/url_8/fhd.m3u8');
});
