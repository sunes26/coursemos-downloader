# Coursemos Downloader

코스모스(이러닝) 강의 동영상 다운로더. 강의 페이지에서 HLS(`.m3u8`) 스트림을 찾아
MP4 또는 오디오로 저장한다.

두 가지로 쓸 수 있다.

| | [Chrome 확장](extension/) (권장) | 데스크톱 앱 |
|---|---|---|
| 설치 | 확장 하나 | Python + ffmpeg |
| HTML 저장 단계 | 불필요 — 페이지에서 바로 감지 | 필요 |
| 변환 | 재인코딩 없음 (리먹스, ~1초) | ffmpeg 재인코딩 |
| 형식 | MP4 / M4A | MP4 / MP3 |

아래 내용은 **데스크톱 앱**에 대한 것이다. 확장은 [`extension/README.md`](extension/README.md) 참고.

## 지원 확인된 사이트

| 사이트 | 상태 | 비고 |
|---|---|---|
| Coursemos 계열 LMS | 지원 | 스크립트 내 평문 m3u8 |
| 인천대학교 LMS (`lms.inu.ac.kr/mod/vod/viewer.php`) | 지원 | video.js `data-setup-lazy` 속성 (HTML 엔티티 + JSON 이스케이프 이중 인코딩) |

## 설치

```bash
pip install -r requirements.txt
```

ffmpeg가 필요하다. 시스템 PATH에 있으면 그대로 쓰고, 없으면 실행 파일과 같은 폴더
또는 `bin/` 폴더의 `ffmpeg.exe` / `ffprobe.exe`를 사용한다.

## 사용법

1. 브라우저에서 강의 영상 페이지를 연다.
2. `Ctrl+S` → **웹페이지, 전체(Webpage, Complete)** 로 HTML 저장.
3. 프로그램 실행 후 `Select HTML File`로 저장한 HTML 선택.
4. m3u8 URL이 자동으로 추출된다. 여러 개면 목록에서 선택.
5. MP4 / MP3 체크 후 `Download`.

HTML 저장이 번거로우면 `Enter m3u8 URL` 버튼으로 스트림 주소를 직접 붙여넣어도 된다.
(브라우저 개발자 도구 → Network → `m3u8` 필터)

## 실행

```bash
python coursemos_downloader.py
```

## 테스트

```bash
python test_m3u8_extract.py
```

## 구조

- `coursemos_downloader.py` — PyQt5 GUI, ffmpeg 실행, GitHub 자동 업데이트
- `m3u8_extract.py` — HTML에서 m3u8 URL·제목 추출 (순수 함수, 테스트 대상)
- `test_m3u8_extract.py` — 추출 로직 단위 테스트

## 주의

본인이 수강 중인 강의의 개인 학습용 복제에만 사용할 것. 다운로드한 강의 자료의
재배포·공유는 저작권 침해에 해당할 수 있으며, 소속 기관의 학칙·이용약관을 따를 것.
