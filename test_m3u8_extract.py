"""m3u8_extract 모듈 테스트.

실행: python -m pytest test_m3u8_extract.py -v
      (pytest 없이) python test_m3u8_extract.py
"""

import unittest

from m3u8_extract import (
    extract_m3u8_urls,
    extract_page_title,
    normalize_html,
    sanitize_filename,
)

# 인천대학교 LMS 실제 구조 (lms.inu.ac.kr/mod/vod/viewer.php?id=45290)
INU_LMS_HTML = '''<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<title>[2026-1 &#44592;&#52488;&#54617;&#49845;]AI &#50689;&#50612; : AI &#47532;&#49828;&#45768; 1&#44053; 1&#52264;&#49884; | &#51064;&#52380;&#45824;&#54617;&#44368; LMS</title>
</head><body>
<div id="my-video" class="video-js" data-setup-lazy="{&quot;language&quot;:&quot;ko&quot;,&quot;sources&quot;:{&quot;src&quot;:&quot;https:\\/\\/cdn.example.com\\/hls\\/TOKEN__\\/abc-123\\/mp4\\/abc-123.mp4\\/index.m3u8&quot;,&quot;type&quot;:&quot;application\\/x-mpegURL&quot;}}">
<video id="my-video_html5_api" class="vjs-tech"></video></div>
</body></html>'''

# 기존 coursemos 스타일 (스크립트 안에 평문 URL)
PLAIN_SCRIPT_HTML = '''<html><head><title>강의 제목</title></head><body>
<script>var player = videojs("v", {sources:[{src:"https://cdn.example.com/plain/index.m3u8"}]});</script>
</body></html>'''


class TestNormalizeHtml(unittest.TestCase):

    def test_decodes_html_entities(self):
        self.assertIn('"src"', normalize_html('&quot;src&quot;'))

    def test_restores_escaped_slashes(self):
        self.assertEqual(normalize_html(r'https:\/\/a.com\/b'), 'https://a.com/b')

    def test_restores_unicode_escaped_slashes(self):
        self.assertEqual(normalize_html(r'https:/a.com'), 'https:/a.com')

    def test_empty_input_returns_empty_string(self):
        self.assertEqual(normalize_html(''), '')
        self.assertEqual(normalize_html(None), '')

    def test_does_not_mutate_original(self):
        original = r'https:\/\/a.com'
        normalize_html(original)
        self.assertEqual(original, r'https:\/\/a.com')


class TestExtractM3u8Urls(unittest.TestCase):

    def test_finds_url_in_inu_lms_encoded_attribute(self):
        urls = extract_m3u8_urls(INU_LMS_HTML)
        self.assertEqual(
            urls,
            ['https://cdn.example.com/hls/TOKEN__/abc-123/mp4/abc-123.mp4/index.m3u8'],
        )

    def test_finds_plain_url_in_script(self):
        urls = extract_m3u8_urls(PLAIN_SCRIPT_HTML)
        self.assertEqual(urls, ['https://cdn.example.com/plain/index.m3u8'])

    def test_deduplicates_repeated_urls(self):
        html = 'a https://x.com/a.m3u8 b https://x.com/a.m3u8 c'
        self.assertEqual(extract_m3u8_urls(html), ['https://x.com/a.m3u8'])

    def test_preserves_document_order(self):
        html = 'https://x.com/second.m3u8 ... https://x.com/first.m3u8'
        self.assertEqual(
            extract_m3u8_urls(html),
            ['https://x.com/second.m3u8', 'https://x.com/first.m3u8'],
        )

    def test_keeps_query_string(self):
        urls = extract_m3u8_urls('src="https://x.com/a.m3u8?token=abc&amp;e=1"')
        self.assertEqual(urls, ['https://x.com/a.m3u8?token=abc&e=1'])

    def test_returns_empty_list_when_no_urls(self):
        self.assertEqual(extract_m3u8_urls('<html><body>no video</body></html>'), [])
        self.assertEqual(extract_m3u8_urls(''), [])
        self.assertEqual(extract_m3u8_urls(None), [])

    def test_does_not_swallow_trailing_quote(self):
        urls = extract_m3u8_urls('"https://x.com/a.m3u8"')
        self.assertEqual(urls, ['https://x.com/a.m3u8'])


class TestSanitizeFilename(unittest.TestCase):

    def test_removes_invalid_characters(self):
        self.assertEqual(sanitize_filename('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij')

    def test_collapses_whitespace(self):
        self.assertEqual(sanitize_filename('a   b\n c'), 'a b c')

    def test_truncates_long_names(self):
        self.assertEqual(len(sanitize_filename('x' * 200)), 80)

    def test_falls_back_when_empty(self):
        self.assertEqual(sanitize_filename(''), 'video')
        self.assertEqual(sanitize_filename('///'), 'video')

    def test_strips_trailing_dots(self):
        self.assertEqual(sanitize_filename('name...'), 'name')


class TestExtractPageTitle(unittest.TestCase):

    def test_strips_site_suffix_and_course_prefix(self):
        self.assertEqual(extract_page_title(INU_LMS_HTML), 'AI 리스니 1강 1차시')

    def test_uses_plain_title(self):
        self.assertEqual(extract_page_title(PLAIN_SCRIPT_HTML), '강의 제목')

    def test_falls_back_to_filename_without_title(self):
        self.assertEqual(
            extract_page_title('<html></html>', '/tmp/내 강의.html'),
            '내 강의',
        )

    def test_falls_back_to_default(self):
        self.assertEqual(extract_page_title('', None), 'video')


if __name__ == '__main__':
    unittest.main(verbosity=2)
