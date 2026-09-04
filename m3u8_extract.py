"""HTML에서 m3u8 스트림 URL과 강의 제목을 추출하는 모듈.

LMS(무들 계열) 강의 페이지는 플레이어 설정을 태그 속성에 JSON으로 넣어두는 경우가 많다.
이때 URL은 HTML 엔티티(&quot;)와 JSON 이스케이프(\\/)가 이중으로 적용되어 있어
원본 텍스트에 정규식을 그대로 적용하면 찾지 못한다. 이 모듈은 정규화 후 검색한다.

예) 인천대학교 LMS (lms.inu.ac.kr/mod/vod/viewer.php)
    <div id="my-video" data-setup-lazy="{&quot;sources&quot;:{&quot;src&quot;:&quot;https:\\/\\/...\\/index.m3u8&quot;}}">
"""

import html as html_module
import os
import re

# m3u8 URL 정규식 (정규화된 텍스트에 적용)
M3U8_PATTERN = r'https?://[^\s\'"<>\\]+\.m3u8[^\s\'"<>\\]*'

# 사이트 이름 등 제목 뒤에 붙는 꼬리표 구분자
TITLE_SUFFIX_SEPARATORS = ('|', '｜', ' - ')

# 파일명에 사용할 수 없는 문자
INVALID_FILENAME_CHARS = r'[\\/*?:"<>|\r\n\t]'

MAX_FILENAME_LENGTH = 80


def normalize_html(html_content):
    """정규식 검색이 가능하도록 HTML 텍스트를 정규화한다.

    1. HTML 엔티티 디코딩: &quot; -> " , &amp; -> &
    2. JSON 이스케이프된 슬래시 복원: \\/ -> /
    3. 유니코드 이스케이프 복원: \\u002F -> /

    원본을 변형하지 않고 새 문자열을 반환한다.
    """
    if not html_content:
        return ''

    normalized = html_module.unescape(html_content)
    normalized = normalized.replace('\\/', '/')
    normalized = re.sub(r'\\u002[fF]', '/', normalized)
    return normalized


def extract_m3u8_urls(html_content):
    """HTML 텍스트에서 m3u8 URL 목록을 추출한다 (등장 순서 유지, 중복 제거)."""
    if not html_content:
        return []

    # 엔티티가 두 번 인코딩된 경우(&amp;quot;)까지 대응하기 위해 두 단계로 정규화
    candidates = []
    text = html_content
    for _ in range(2):
        text = normalize_html(text)
        candidates.extend(re.findall(M3U8_PATTERN, text))

    return _dedupe_preserving_order(candidates)


def _dedupe_preserving_order(urls):
    """등장 순서를 유지하면서 중복을 제거한다."""
    seen = set()
    unique = []
    for url in urls:
        cleaned = url.rstrip('\\,;)')
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            unique.append(cleaned)
    return unique


def sanitize_filename(filename, max_length=MAX_FILENAME_LENGTH):
    """파일명에 사용할 수 없는 문자를 제거하고 길이를 제한한다."""
    if not filename:
        return 'video'

    sanitized = re.sub(INVALID_FILENAME_CHARS, '', filename)
    sanitized = re.sub(r'\s+', ' ', sanitized).strip(' .')

    if not sanitized:
        return 'video'

    if len(sanitized) > max_length:
        sanitized = sanitized[:max_length].rstrip()

    return sanitized


def extract_page_title(html_content, fallback_path=None):
    """HTML <title>에서 강의 제목을 뽑아 파일명으로 쓸 수 있게 정리한다.

    LMS 제목은 보통 '과목명 : 차시명 | 학교 LMS' 형태다.
    사이트 꼬리표를 제거하고 마지막 ':' 뒤의 차시명을 우선 사용한다.
    """
    title = None

    if html_content:
        match = re.search(r'<title[^>]*>(.*?)</title>', html_content,
                          re.IGNORECASE | re.DOTALL)
        if match:
            title = html_module.unescape(match.group(1)).strip()

    if not title:
        if fallback_path:
            return sanitize_filename(os.path.splitext(os.path.basename(fallback_path))[0])
        return 'video'

    # '| 인천대학교 LMS' 같은 사이트 꼬리표 제거
    for separator in TITLE_SUFFIX_SEPARATORS:
        if separator in title:
            title = title.split(separator)[0].strip()

    # '과목명 : 차시명' 이면 차시명 사용
    if ' : ' in title:
        title = title.split(' : ')[-1].strip()

    return sanitize_filename(title)
