import sys
import os
import re
import subprocess
import requests
import tempfile
import zipfile
import shutil
from bs4 import BeautifulSoup
from PyQt5.QtWidgets import (QApplication, QMainWindow, QPushButton, QFileDialog, 
                           QLabel, QVBoxLayout, QHBoxLayout, QWidget, QProgressBar, 
                           QTextEdit, QMessageBox, QCheckBox, QFrame, QMenu, QAction)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QSettings, QTimer
from PyQt5.QtGui import QFont, QIcon

# pip install packaging (버전 비교용)
try:
    from packaging import version
except ImportError:
    print("packaging 모듈이 필요합니다. pip install packaging 명령으로 설치하세요.")
    sys.exit(1)

# 앱 버전 정보
APP_VERSION = "1.0.0"
GITHUB_OWNER = "sunes26"  # 여기에 GitHub 사용자명 입력
GITHUB_REPO = "coursemos-downloader"  # 저장소 이름


class GitHubUpdateChecker(QThread):
    """GitHub에서 업데이트 확인을 위한 스레드"""
    update_available = pyqtSignal(str, str, str)  # 새 버전, 다운로드 URL, 변경 내역
    
    def __init__(self, current_version, repo_owner, repo_name):
        super().__init__()
        self.current_version = current_version
        self.repo_owner = repo_owner
        self.repo_name = repo_name
        
    def run(self):
        try:
            # GitHub API를 통해 최신 릴리스 정보 가져오기
            api_url = f"https://api.github.com/repos/{self.repo_owner}/{self.repo_name}/releases/latest"
            response = requests.get(api_url, timeout=10)
            
            if response.status_code == 200:
                release_info = response.json()
                latest_version = release_info.get('tag_name', '').lstrip('v')  # v1.0.0 -> 1.0.0
                
                # 버전 정보가 비어있으면 처리하지 않음
                if not latest_version:
                    return
                
                # 변경 내역
                release_notes = release_info.get('body', '변경 내역이 없습니다.')
                
                # 다운로드 URL 찾기 (첫 번째 zip 에셋 사용)
                download_url = None
                assets = release_info.get('assets', [])
                for asset in assets:
                    if asset.get('name', '').endswith('.zip'):
                        download_url = asset.get('browser_download_url')
                        break
                
                # 다운로드 URL이 없으면 zip 아카이브 URL 사용
                if not download_url:
                    download_url = release_info.get('zipball_url')
                
                # 버전 비교
                if version.parse(latest_version) > version.parse(self.current_version):
                    self.update_available.emit(latest_version, download_url, release_notes)
        
        except Exception as e:
            print(f"업데이트 확인 오류: {str(e)}")


class GitHubUpdater(QThread):
    """GitHub 릴리스에서 업데이트 다운로드 및 설치를 위한 스레드"""
    update_progress = pyqtSignal(str, int)  # 메시지, 진행률(%)
    update_completed = pyqtSignal(bool, str)
    
    def __init__(self, download_url, app_path):
        super().__init__()
        self.download_url = download_url
        self.app_path = app_path
        
    def run(self):
        try:
            # 현재 실행 중인 프로세스 ID 가져오기 (구버전 종료용)
            current_pid = os.getpid()
            
            # 임시 디렉토리 생성
            temp_dir = tempfile.mkdtemp()
            temp_file = os.path.join(temp_dir, "update.zip")
            
            self.update_progress.emit("업데이트 다운로드 중...", 10)
            
            # 릴리스 파일 다운로드
            response = requests.get(self.download_url, stream=True)
            total_size = int(response.headers.get('content-length', 0))
            
            with open(temp_file, 'wb') as f:
                downloaded = 0
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        percent = int(downloaded / total_size * 100) if total_size > 0 else 0
                        self.update_progress.emit(f"다운로드 중... {percent}%", 10 + percent // 2)
            
            self.update_progress.emit("압축 파일 해제 중...", 60)
            
            # 압축 해제 디렉토리
            extract_dir = os.path.join(temp_dir, "extracted")
            os.makedirs(extract_dir, exist_ok=True)
            
            # ZIP 파일 압축 해제
            with zipfile.ZipFile(temp_file, 'r') as zip_ref:
                zip_ref.extractall(extract_dir)
            
            self.update_progress.emit("최신 소스 파일 찾는 중...", 70)
            
            # 앱 경로 결정
            if getattr(sys, 'frozen', False):
                app_dir = os.path.dirname(sys.executable)
                is_exe = True
            else:
                app_dir = os.path.dirname(os.path.abspath(__file__))
                is_exe = False
            
            # GitHub에서 받은 ZIP 파일 내부 구조 분석 및 처리
            self.update_progress.emit("GitHub 저장소 구조 분석 중...", 75)
            
            # 모든 디렉토리 탐색하여 필요한 파일 찾기
            github_repo_dir = None
            py_files_found = []
            
            # 재귀적으로 모든 .py 파일을 찾는 함수
            def find_py_files(directory, file_list):
                for item in os.listdir(directory):
                    item_path = os.path.join(directory, item)
                    if os.path.isdir(item_path):
                        find_py_files(item_path, file_list)
                    elif item.endswith('.py'):
                        file_list.append(item_path)
            
            # 추출된 디렉토리에서 .py 파일 찾기
            find_py_files(extract_dir, py_files_found)
            
            if not py_files_found:
                self.update_completed.emit(False, "업데이트 파일에 필요한 Python 파일을 찾을 수 없습니다.")
                return
                
            # coursemos_downloader.py 파일 찾기
            main_file_path = None
            for py_file in py_files_found:
                if os.path.basename(py_file) == "coursemos_downloader.py":
                    main_file_path = py_file
                    github_repo_dir = os.path.dirname(py_file)
                    break
                    
            if not main_file_path:
                self.update_completed.emit(False, "coursemos_downloader.py 파일을 찾을 수 없습니다.")
                return
                
            self.update_progress.emit(f"소스 파일 발견: {main_file_path}", 80)
            
            # 윈도우용 업데이트 스크립트 작성
            if sys.platform.startswith('win'):
                batch_file = os.path.join(temp_dir, "update.bat")
                with open(batch_file, 'w') as f:
                    f.write('@echo off\n')
                    f.write('echo Coursemos Downloader 업데이트 중...\n')
                    
                    # 구버전 프로그램 종료 (PID 기반)
                    f.write(f'echo 현재 실행 중인 프로그램 종료 중 (PID: {current_pid})...\n')
                    f.write(f'taskkill /F /PID {current_pid} /T > nul 2>&1\n')
                    f.write('timeout /t 2 /nobreak > nul\n')  # 2초 대기
                    
                    # 자세한 로그를 위한 설정
                    f.write('echo 현재 작업 디렉토리: %CD%\n')
                    f.write('echo 앱 디렉토리: "' + app_dir + '"\n')
                    f.write('echo GitHub 저장소 디렉토리: "' + github_repo_dir + '"\n')
                    f.write('echo 메인 파일 경로: "' + main_file_path + '"\n')
                    
                    # 파일 복사 전 디렉토리 준비 상태 확인
                    f.write(f'echo 앱 디렉토리로 이동 중...\n')
                    f.write(f'cd /d "{app_dir}" || (\n')
                    f.write(f'  echo 앱 디렉토리로 이동할 수 없습니다: {app_dir}\n')
                    f.write(f'  goto error\n')
                    f.write(f')\n')
                    
                    # 백업
                    f.write('echo 원본 파일 백업 중...\n')
                    if is_exe:
                        f.write(f'if exist coursemos_downloader.exe.bak del /f /q coursemos_downloader.exe.bak\n')
                        f.write(f'if exist coursemos_downloader.exe rename coursemos_downloader.exe coursemos_downloader.exe.bak\n')
                    else:
                        f.write(f'if exist coursemos_downloader.py.bak del /f /q coursemos_downloader.py.bak\n')
                        f.write(f'if exist coursemos_downloader.py (\n')
                        f.write(f'  echo 백업 파일 생성: coursemos_downloader.py.bak\n')
                        f.write(f'  rename coursemos_downloader.py coursemos_downloader.py.bak\n')
                        f.write(f')\n')
                    
                    # 메인 파일이 존재하는지 확인
                    f.write(f'echo 소스 파일 확인 중...\n')
                    f.write(f'if not exist "{main_file_path}" (\n')
                    f.write(f'  echo 오류: 메인 파일을 찾을 수 없습니다: {main_file_path}\n')
                    f.write(f'  goto error\n')
                    f.write(f')\n')
                    
                    # 단일 파일 복사 옵션 (xcopy 대신 개별 파일 복사)
                    f.write('echo 개별 파일 복사 중...\n')
                    
                    # 메인 파일 복사
                    f.write(f'echo coursemos_downloader.py 복사 중...\n')
                    f.write(f'copy /y "{main_file_path}" "{app_dir}\\coursemos_downloader.py" || (\n')
                    f.write(f'  echo coursemos_downloader.py 파일 복사 실패\n')
                    f.write(f'  goto error\n')
                    f.write(f')\n')
                    
                    # 추가 파일이 있는지 확인하고 복사 (README.md 등)
                    f.write(f'echo 추가 파일 복사 중...\n')
                    readme_path = os.path.join(github_repo_dir, "README.md")
                    if os.path.exists(readme_path):
                        f.write(f'echo README.md 복사 중...\n')
                        f.write(f'copy /y "{readme_path}" "{app_dir}\\README.md" || echo README.md 복사 실패 (무시됨)\n')
                    
                    # 다른 필요한 .py 파일이 있는지 확인하고 복사
                    for py_file in py_files_found:
                        if py_file != main_file_path:
                            filename = os.path.basename(py_file)
                            f.write(f'echo {filename} 복사 중...\n')
                            f.write(f'copy /y "{py_file}" "{app_dir}\\{filename}" || echo {filename} 복사 실패 (무시됨)\n')
                    
                    f.write('echo 파일 복사 완료!\n')
                    
                    # 성공적인 복사 후
                    f.write('echo 업데이트 성공적으로 완료!\n')
                    
                    # 앱 재시작
                    if is_exe:
                        f.write(f'start "" "{app_dir}\\coursemos_downloader.exe"\n')
                    else:
                        f.write(f'start "" python "{app_dir}\\coursemos_downloader.py"\n')
                    
                    f.write('goto cleanup\n')
                    
                    # 오류 처리 섹션
                    f.write(':error\n')
                    f.write('echo [오류] 업데이트 중 문제가 발생했습니다!\n')
                    f.write('echo 원본 파일 복원 중...\n')
                    
                    # 백업 파일이 있으면 복원
                    if is_exe:
                        f.write('if exist coursemos_downloader.exe.bak (\n')
                        f.write('  echo 백업에서 복원 중: coursemos_downloader.exe\n')
                        f.write('  rename coursemos_downloader.exe.bak coursemos_downloader.exe\n')
                        f.write(')\n')
                        f.write('start "" "' + app_dir + '\\coursemos_downloader.exe"\n')
                    else:
                        f.write('if exist coursemos_downloader.py.bak (\n')
                        f.write('  echo 백업에서 복원 중: coursemos_downloader.py\n')
                        f.write('  rename coursemos_downloader.py.bak coursemos_downloader.py\n')
                        f.write(')\n')
                        f.write('start "" python "' + app_dir + '\\coursemos_downloader.py"\n')
                    
                    # 임시 파일 정리 섹션
                    f.write(':cleanup\n')
                    f.write('echo 임시 파일 정리 중...\n')
                    f.write('timeout /t 2 /nobreak > nul\n')  # 2초 더 대기
                    f.write(f'rmdir /s /q "{temp_dir}"\n')
                    f.write('echo 완료.\n')
                    
                    # 창 자동 닫기
                    f.write('exit\n')
                
                self.update_progress.emit("업데이트 설치 준비 완료...", 90)
                
                # 배치 파일을 자동으로 닫히는 모드로 실행
                # CREATE_NO_WINDOW 플래그를 사용하여 창 표시 없이 실행
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 0  # SW_HIDE
                
                # 배치 파일 실행
                subprocess.Popen(['cmd', '/c', batch_file], startupinfo=si)
                
                self.update_progress.emit("업데이트 설치 중...", 95)
                self.update_completed.emit(True, "업데이트가 설치됩니다. 프로그램이 재시작됩니다.")
                
                # 현재 프로세스는 배치 파일에서 강제 종료됨 (taskkill 명령으로)
                # 따라서 sys.exit()는 필요하지 않음
                
            elif sys.platform == 'darwin':  # macOS
                # 쉘 스크립트 생성
                shell_script = os.path.join(temp_dir, "update.sh")
                with open(shell_script, 'w') as f:
                    f.write('#!/bin/bash\n')
                    f.write('echo "Coursemos Downloader 업데이트 중..."\n')
                    f.write(f'echo "현재 프로세스(PID: {current_pid}) 종료 중..."\n')
                    f.write(f'kill -9 {current_pid} >/dev/null 2>&1\n')
                    f.write('sleep 3\n')  # 3초 대기
                    
                    # 앱 디렉토리로 이동
                    f.write(f'cd "{app_dir}" || {{ echo "앱 디렉토리로 이동할 수 없습니다"; exit 1; }}\n')
                    
                    # 스크립트 백업 & 교체
                    f.write(f'[ -f coursemos_downloader.py.bak ] && rm coursemos_downloader.py.bak\n')
                    f.write(f'[ -f coursemos_downloader.py ] && mv coursemos_downloader.py coursemos_downloader.py.bak\n')
                    
                    # 새 파일 복사
                    f.write(f'if [ ! -f "{main_file_path}" ]; then\n')
                    f.write(f'  echo "오류: 소스 파일을 찾을 수 없습니다."\n')
                    f.write(f'  if [ -f coursemos_downloader.py.bak ]; then\n')
                    f.write(f'    mv coursemos_downloader.py.bak coursemos_downloader.py\n')
                    f.write(f'    python3 "{app_dir}/coursemos_downloader.py" &\n')
                    f.write(f'  fi\n')
                    f.write(f'  exit 1\n')
                    f.write(f'fi\n')
                    
                    # 메인 파일 복사
                    f.write(f'echo "coursemos_downloader.py 복사 중..."\n')
                    f.write(f'cp "{main_file_path}" "{app_dir}/coursemos_downloader.py" || {{ \n')
                    f.write(f'  echo "파일 복사 실패"; \n')
                    f.write(f'  if [ -f coursemos_downloader.py.bak ]; then\n')
                    f.write(f'    mv coursemos_downloader.py.bak coursemos_downloader.py\n')
                    f.write(f'  fi\n')
                    f.write(f'  python3 "{app_dir}/coursemos_downloader.py" &\n')
                    f.write(f'  exit 1; \n')
                    f.write(f'}}\n')
                    
                    # README.md 파일 복사
                    readme_path = os.path.join(github_repo_dir, "README.md")
                    if os.path.exists(readme_path):
                        f.write(f'echo "README.md 복사 중..."\n')
                        f.write(f'cp "{readme_path}" "{app_dir}/README.md" || echo "README.md 복사 실패 (무시됨)"\n')
                    
                    # 다른 .py 파일 복사
                    for py_file in py_files_found:
                        if py_file != main_file_path:
                            filename = os.path.basename(py_file)
                            f.write(f'echo "{filename} 복사 중..."\n')
                            f.write(f'cp "{py_file}" "{app_dir}/{filename}" || echo "{filename} 복사 실패 (무시됨)"\n')
                    
                    f.write(f'echo "업데이트 완료!"\n')
                    
                    # 앱 재시작
                    f.write(f'python3 "{app_dir}/coursemos_downloader.py" &\n')
                    
                    # 임시 파일 정리
                    f.write(f'sleep 2\n')
                    f.write(f'rm -rf "{temp_dir}"\n')
                
                # 실행 권한 부여
                os.chmod(shell_script, 0o755)
                
                # 쉘 스크립트 실행
                subprocess.Popen(['bash', shell_script])
                
                self.update_progress.emit("업데이트 설치 중...", 95)
                self.update_completed.emit(True, "업데이트가 설치됩니다. 프로그램이 재시작됩니다.")
                
                # 현재 프로세스는 쉘 스크립트에서 강제 종료됨
                
            else:  # Linux 등 다른 UNIX 계열
                # 쉘 스크립트 생성 (macOS와 유사)
                shell_script = os.path.join(temp_dir, "update.sh")
                with open(shell_script, 'w') as f:
                    f.write('#!/bin/bash\n')
                    f.write('echo "Coursemos Downloader 업데이트 중..."\n')
                    f.write(f'echo "현재 프로세스(PID: {current_pid}) 종료 중..."\n')
                    f.write(f'kill -9 {current_pid} >/dev/null 2>&1\n')
                    f.write('sleep 3\n')
                    
                    # 앱 디렉토리로 이동
                    f.write(f'cd "{app_dir}" || {{ echo "앱 디렉토리로 이동할 수 없습니다"; exit 1; }}\n')
                    
                    # 스크립트 백업 & 교체
                    f.write(f'[ -f coursemos_downloader.py.bak ] && rm coursemos_downloader.py.bak\n')
                    f.write(f'[ -f coursemos_downloader.py ] && mv coursemos_downloader.py coursemos_downloader.py.bak\n')
                    
                    # 새 파일 복사
                    f.write(f'if [ ! -f "{main_file_path}" ]; then\n')
                    f.write(f'  echo "오류: 소스 파일을 찾을 수 없습니다."\n')
                    f.write(f'  if [ -f coursemos_downloader.py.bak ]; then\n')
                    f.write(f'    mv coursemos_downloader.py.bak coursemos_downloader.py\n')
                    f.write(f'    python3 "{app_dir}/coursemos_downloader.py" &\n')
                    f.write(f'  fi\n')
                    f.write(f'  exit 1\n')
                    f.write(f'fi\n')
                    
                    # 메인 파일 복사
                    f.write(f'echo "coursemos_downloader.py 복사 중..."\n')
                    f.write(f'cp "{main_file_path}" "{app_dir}/coursemos_downloader.py" || {{ \n')
                    f.write(f'  echo "파일 복사 실패"; \n')
                    f.write(f'  if [ -f coursemos_downloader.py.bak ]; then\n')
                    f.write(f'    mv coursemos_downloader.py.bak coursemos_downloader.py\n')
                    f.write(f'  fi\n')
                    f.write(f'  python3 "{app_dir}/coursemos_downloader.py" &\n')
                    f.write(f'  exit 1; \n')
                    f.write(f'}}\n')
                    
                    # README.md 파일 복사
                    readme_path = os.path.join(github_repo_dir, "README.md")
                    if os.path.exists(readme_path):
                        f.write(f'echo "README.md 복사 중..."\n')
                        f.write(f'cp "{readme_path}" "{app_dir}/README.md" || echo "README.md 복사 실패 (무시됨)"\n')
                    
                    # 다른 .py 파일 복사
                    for py_file in py_files_found:
                        if py_file != main_file_path:
                            filename = os.path.basename(py_file)
                            f.write(f'echo "{filename} 복사 중..."\n')
                            f.write(f'cp "{py_file}" "{app_dir}/{filename}" || echo "{filename} 복사 실패 (무시됨)"\n')
                    
                    f.write(f'echo "업데이트 완료!"\n')
                    
                    # 앱 재시작
                    f.write(f'python3 "{app_dir}/coursemos_downloader.py" &\n')
                    
                    # 임시 파일 정리
                    f.write(f'sleep 2\n')
                    f.write(f'rm -rf "{temp_dir}"\n')
                
                # 실행 권한 부여
                os.chmod(shell_script, 0o755)
                
                # 쉘 스크립트 실행
                subprocess.Popen(['bash', shell_script])
                
                self.update_progress.emit("업데이트 설치 중...", 95)
                self.update_completed.emit(True, "업데이트가 설치됩니다. 프로그램이 재시작됩니다.")
                
                # 현재 프로세스는 쉘 스크립트에서 강제 종료됨
                
        except Exception as e:
            self.update_completed.emit(False, f"업데이트 오류: {str(e)}")


def format_time(seconds):
    """초 단위 시간을 시:분:초 형식으로 변환"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    seconds = int(seconds % 60)
    
    if hours > 0:
        return f"{hours}시간 {minutes}분 {seconds}초"
    elif minutes > 0:
        return f"{minutes}분 {seconds}초"
    else:
        return f"{seconds}초"


class FFmpegThread(QThread):
    """ffmpeg 처리를 위한 스레드"""
    progress_update = pyqtSignal(str)
    progress_percent = pyqtSignal(int)  # 백분율 진행 상황
    conversion_finished = pyqtSignal(bool, str, str)  # 성공여부, 메시지, 파일경로
    
    def __init__(self, m3u8_url, output_path, output_format):
        super().__init__()
        self.m3u8_url = m3u8_url
        self.output_path = output_path
        self.output_format = output_format
        self.duration_ms = None  # 총 재생 시간 (밀리초)
        
    def run(self):
        try:
            # 먼저 duration 정보 가져오기
            self.get_duration()
            
            # 출력 형식에 따른 명령어 설정
            if self.output_format == 'mp3':
                # MP3로 변환할 때는 오디오만 추출
                command = [
                    'ffmpeg',
                    '-i', self.m3u8_url,
                    '-b:a', '192k',  # 기본 비트레이트
                    '-codec:a', 'libmp3lame',  # MP3 인코더 사용
                    self.output_path
                ]
            else:
                # MP4로 변환 (기본 방식)
                command = [
                    'ffmpeg',
                    '-i', self.m3u8_url,
                    '-c', 'copy',  # 코덱 복사
                    '-bsf:a', 'aac_adtstoasc',  # AAC 필터
                    self.output_path
                ]
                
            self.progress_update.emit(f"실행 명령어: {' '.join(command)}")
            
            # 프로세스 실행 및 출력 캡처 (인코딩 명시)
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
                encoding='utf-8',
                errors='replace'
            )
            
            # 출력 모니터링
            while process.poll() is None:
                output = process.stderr.readline()
                if output:
                    self.progress_update.emit(output.strip())
                    
                    # 진행률 추출 및 업데이트
                    if self.duration_ms:
                        time_match = re.search(r'time=(\d+):(\d+):(\d+)\.(\d+)', output)
                        if time_match:
                            hours, minutes, seconds, ms = map(int, time_match.groups())
                            current_ms = hours * 3600000 + minutes * 60000 + seconds * 1000 + ms * 10
                            percent = min(int(current_ms / self.duration_ms * 100), 100)
                            self.progress_percent.emit(percent)
            
            # 완료 확인
            return_code = process.poll()
            if return_code == 0:
                self.progress_percent.emit(100)  # 완료 시 100%로 설정
                self.conversion_finished.emit(True, "변환 완료!", self.output_path)
            else:
                try:
                    error_output = process.stderr.read()
                    self.conversion_finished.emit(False, f"변환 실패: {error_output}", "")
                except UnicodeDecodeError:
                    self.conversion_finished.emit(False, "변환 실패: 인코딩 오류가 발생했습니다", "")
                    
        except Exception as e:
            self.conversion_finished.emit(False, f"오류 발생: {str(e)}", "")
    
    def get_duration(self):
        """미디어 파일의 총 재생 시간을 가져옵니다."""
        try:
            command = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', 
                      '-of', 'default=noprint_wrappers=1:nokey=1', self.m3u8_url]
            
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace')
            
            if result.returncode == 0 and result.stdout.strip():
                # 초 단위 -> 밀리초 단위로 변환
                try:
                    duration_sec = float(result.stdout.strip())
                    self.duration_ms = int(duration_sec * 1000)
                    self.progress_update.emit(f"총 재생 시간: {format_time(duration_sec)}")
                except ValueError:
                    self.progress_update.emit("재생 시간을 파싱할 수 없습니다.")
            else:
                self.progress_update.emit("재생 시간을 가져올 수 없습니다.")
        except Exception as e:
            self.progress_update.emit(f"재생 시간 정보 가져오기 오류: {str(e)}")


class GitHubUpdaterManager:
    """GitHub 업데이트 관리자"""
    
    def __init__(self, parent):
        """
        parent: 부모 윈도우 (QMainWindow)
        """
        self.parent = parent
        
    def check_for_updates(self, silent=False):
        """업데이트 확인 시작"""
        self.checker = GitHubUpdateChecker(APP_VERSION, GITHUB_OWNER, GITHUB_REPO)
        self.checker.update_available.connect(
            lambda version, url, notes: self.on_update_available(version, url, notes, silent)
        )
        self.checker.start()
    
    def on_update_available(self, new_version, download_url, release_notes, silent):
        """새 업데이트가 있을 때 호출"""
        if silent:
            # 백그라운드 확인 시 알림만 표시
            self.parent.show_update_notification(new_version)
            return
        
        # 사용자에게 업데이트 물어보기
        detail_text = f"변경 사항:\n\n{release_notes}" if release_notes else ""
    
        msg_box = QMessageBox(self.parent)
        msg_box.setWindowTitle("업데이트 가능")
        msg_box.setText(f"새 버전({new_version})이 있습니다. 현재 버전: {APP_VERSION}")
        msg_box.setInformativeText(
            "지금 업데이트하시겠습니까?\n\n"
            "참고: 업데이트를 진행하면 프로그램이 자동으로 종료되고, "
            "업데이트 완료 후 새 버전이 자동으로 실행됩니다."
            )
        if detail_text:
            msg_box.setDetailedText(detail_text)
        msg_box.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
        msg_box.setDefaultButton(QMessageBox.Yes)
    
        if msg_box.exec() == QMessageBox.Yes:
            self.parent.status_text.append("업데이트를 시작합니다. 프로그램이 잠시 후 재시작됩니다.")
            QTimer.singleShot(2000, lambda: self.download_and_install_update(download_url))


def on_update_completed(self, success, message):
    """업데이트 완료 또는 실패 처리"""
    if success:
        QMessageBox.information(
            self.parent, 
            "업데이트", 
            message + "\n\n프로그램이 잠시 후 종료되고 업데이트된 버전이 자동으로 실행됩니다."
        )
    else:
        QMessageBox.warning(self.parent, "업데이트 실패", message)
        self.parent.progress_bar.setVisible(False)
    
    def download_and_install_update(self, download_url):
        """업데이트 다운로드 및 설치"""
        app_path = os.path.abspath(sys.argv[0])
        
        self.updater = GitHubUpdater(download_url, app_path)
        self.updater.update_progress.connect(self.parent.show_update_progress)
        self.updater.update_completed.connect(self.on_update_completed)
        self.updater.start()
        
        self.parent.status_text.append("업데이트 다운로드 중...")
    
    def on_update_completed(self, success, message):
        """업데이트 완료 또는 실패 처리"""
        if success:
            QMessageBox.information(self.parent, "업데이트", message)
        else:
            QMessageBox.warning(self.parent, "업데이트 실패", message)
            self.parent.progress_bar.setVisible(False)


class CoursemosDownloader(QMainWindow):
    """Coursemos 다운로더 메인 윈도우"""
    
    def __init__(self):
        super().__init__()
        self.m3u8_urls = []
        self.selected_url = None
        self.ffmpeg_thread = None
        self.save_folder = os.path.expanduser("~/Downloads")  # 기본 다운로드 폴더
        self.settings = QSettings("CoursemosDownloader", "Settings")
        self.load_settings()
        self.init_ui()
        
        # 업데이트 관리자 초기화
        self.updater_manager = GitHubUpdaterManager(self)
        
        # 앱 시작 시 자동 업데이트 확인
        QTimer.singleShot(1000, lambda: self.updater_manager.check_for_updates(silent=True))
        
    def init_ui(self):
        # 메인 윈도우 설정
        self.setWindowTitle(f'Coursemos Downloader v{APP_VERSION}')
        self.setGeometry(100, 100, 1000, 500)
        
        # 메인 레이아웃 - 좌측과 우측 패널 (좌측 1:2 우측 비율)
        main_layout = QHBoxLayout()
        
        # 좌측 패널
        left_panel = QFrame()
        left_panel.setFrameShape(QFrame.StyledPanel)
        left_layout = QVBoxLayout(left_panel)
        left_panel.setStyleSheet("background-color: #f0f0f0;")
        
        # 타이틀
        title_label = QLabel("Coursemos Downloader")
        title_label.setFont(QFont("Arial", 18, QFont.Bold))
        title_label.setStyleSheet("margin-top: 10px; margin-bottom: 20px;")
        left_layout.addWidget(title_label)
        
        # 버전 정보 표시
        version_label = QLabel(f"버전: {APP_VERSION}")
        version_label.setStyleSheet("color: #666;")
        left_layout.addWidget(version_label)
        
        # 간격 추가
        left_layout.addSpacing(20)
        
        # 파일 선택 버튼
        self.select_file_btn = QPushButton("Select HTML File")
        self.select_file_btn.setFixedHeight(40)
        self.select_file_btn.setStyleSheet("background-color: #3498db; color: white;")
        self.select_file_btn.clicked.connect(self.select_html_file)
        left_layout.addWidget(self.select_file_btn)
        
        # 선택된 파일 표시
        self.selected_file_label = QLabel("Selected: ")
        left_layout.addWidget(self.selected_file_label)
        
        # 간격 추가
        left_layout.addSpacing(20)
        
        # MP4/MP3 체크박스
        format_layout = QHBoxLayout()
        
        self.mp4_checkbox = QCheckBox("MP4")
        self.mp4_checkbox.setChecked(True)
        self.mp3_checkbox = QCheckBox("MP3")
        
        format_layout.addWidget(self.mp4_checkbox)
        format_layout.addWidget(self.mp3_checkbox)
        left_layout.addLayout(format_layout)
        
        # 간격 추가
        left_layout.addSpacing(20)
        
        # 다운로드 버튼
        self.download_btn = QPushButton("Download")
        self.download_btn.setFixedHeight(40)
        self.download_btn.setStyleSheet("background-color: #3498db; color: white;")
        self.download_btn.clicked.connect(self.start_download)
        self.download_btn.setEnabled(False)
        left_layout.addWidget(self.download_btn)
        
        # 저장 경로 표시 및 선택
        save_layout = QHBoxLayout()
        self.save_path_label = QLabel(f"Save to: {self.save_folder}")
        self.select_folder_btn = QPushButton("Select Folder")
        self.select_folder_btn.setStyleSheet("background-color: #3498db; color: white;")
        self.select_folder_btn.clicked.connect(self.select_save_folder)
        
        save_layout.addWidget(self.save_path_label, 1)
        save_layout.addWidget(self.select_folder_btn)
        
        left_layout.addSpacing(20)
        left_layout.addLayout(save_layout)
        
        # 업데이트 확인 버튼
        self.check_update_btn = QPushButton("Check for Updates")
        self.check_update_btn.clicked.connect(self.check_for_updates)
        left_layout.addWidget(self.check_update_btn)
        
        # 좌측 패널에 빈 공간 추가
        left_layout.addStretch()
        
        # 우측 패널 - 상태 메시지 및 로그
        right_panel = QFrame()
        right_panel.setFrameShape(QFrame.StyledPanel)
        right_layout = QVBoxLayout(right_panel)
        
        # 상태 메시지
        self.status_text = QTextEdit()
        self.status_text.setReadOnly(True)
        right_layout.addWidget(self.status_text)
        
        # 진행 상태바
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_bar.setVisible(True)
        right_layout.addWidget(self.progress_bar)
        
        # 패널 추가
        main_layout.addWidget(left_panel, 1)
        main_layout.addWidget(right_panel, 2)
        
        # 메인 위젯 설정
        main_widget = QWidget()
        main_widget.setLayout(main_layout)
        self.setCentralWidget(main_widget)
        
        # 초기 상태 메시지
        self.status_text.append("Coursemos Downloader가 시작되었습니다.")
        self.status_text.append("HTML 파일을 선택하여 시작하세요.")
        self.status_text.append(f"저장 경로: {self.save_folder}")
    
    def select_html_file(self):
        """HTML 파일 선택 다이얼로그"""
        file_path, _ = QFileDialog.getOpenFileName(
            self, "HTML 파일 선택", "", "HTML 파일 (*.html *.htm)"
        )
        
        if file_path:
            self.status_text.clear()
            file_name = os.path.basename(file_path)
            self.selected_file_label.setText(f"Selected: {file_name}")
            self.html_file_path = file_path
            self.status_text.append(f"HTML 파일을 선택했습니다: {file_path}")
            
            # URL 추출 시작
            self.status_text.append("m3u8 링크를 찾을 수 없습니다. HTML 파일을 확인해주세요.")
            
            # 자동으로 URL 추출 실행
            self.extract_urls()
    
    def select_save_folder(self):
        """저장 폴더 선택 다이얼로그"""
        folder_path = QFileDialog.getExistingDirectory(
            self, "저장 폴더 선택", self.save_folder
        )
        
        if folder_path:
            self.save_folder = folder_path
            self.save_path_label.setText(f"Save to: {folder_path}")
            self.status_text.append(f"저장 폴더가 설정되었습니다: {folder_path}")
            
            # 설정 저장
            self.settings.setValue("save_folder", folder_path)
    
    def sanitize_filename(self, filename):
        """파일명에 사용할 수 없는 문자 제거"""
        # 파일명으로 사용할 수 없는 문자 제거
        invalid_chars = r'[\\/*?:"<>|]'
        sanitized = re.sub(invalid_chars, '', filename)
        # 긴 파일명은 축약
        if len(sanitized) > 50:
            sanitized = sanitized[:47] + '...'
        return sanitized
    
    def extract_urls(self):
        """HTML 파일에서 m3u8 URL 추출"""
        if not hasattr(self, 'html_file_path'):
            self.status_text.append("HTML 파일을 먼저 선택해주세요.")
            return
            
        try:
            # 여러 인코딩을 시도
            encodings = ['utf-8', 'cp949', 'euc-kr']
            html_content = None
            
            for encoding in encodings:
                try:
                    with open(self.html_file_path, 'r', encoding=encoding) as file:
                        html_content = file.read()
                    break  # 성공적으로 읽었으면 반복 중단
                except UnicodeDecodeError:
                    continue
                    
            if html_content is None:
                raise Exception("HTML 파일을 읽을 수 없습니다. 지원되지 않는 인코딩입니다.")
                
            # BeautifulSoup으로 파싱
            soup = BeautifulSoup(html_content, 'html.parser')
            
            # 페이지 제목 추출 (자동 파일명 생성용)
            title_tag = soup.find('title')
            if title_tag and title_tag.string:
                self.page_title = self.sanitize_filename(title_tag.string.strip())
            else:
                # 제목이 없으면 HTML 파일명을 기반으로 제목 설정
                self.page_title = self.sanitize_filename(os.path.splitext(os.path.basename(self.html_file_path))[0])
            
            # m3u8 URL 정규식 패턴
            m3u8_pattern = r'https?://[^\s\'\"]+\.m3u8[^\s\'\"]*'
            
            # HTML에서 스크립트와 소스 속성 검색
            self.m3u8_urls = []
            
            # 스크립트 내용에서 검색
            for script in soup.find_all('script'):
                if script.string:
                    urls = re.findall(m3u8_pattern, script.string)
                    self.m3u8_urls.extend(urls)
            
            # 소스 태그에서 검색
            for source in soup.find_all('source'):
                if source.get('src'):
                    url = source.get('src')
                    if '.m3u8' in url:
                        self.m3u8_urls.append(url)
            
            # video 태그에서 검색
            for video in soup.find_all('video'):
                if video.get('src'):
                    url = video.get('src')
                    if '.m3u8' in url:
                        self.m3u8_urls.append(url)
            
            # 전체 HTML 텍스트에서 추가 검색
            additional_urls = re.findall(m3u8_pattern, html_content)
            self.m3u8_urls.extend(additional_urls)
            
            # 중복 제거
            self.m3u8_urls = list(set(self.m3u8_urls))
            
            # 결과 표시
            if self.m3u8_urls:
                self.status_text.clear()
                self.status_text.append(f"HTML 파일을 선택했습니다: {self.html_file_path}")
                self.status_text.append(f"m3u8 링크를 찾을 수 있습니다.")
                self.status_text.append(f"{len(self.m3u8_urls)}개의 m3u8 URL을 발견했습니다.")
                
                for i, url in enumerate(self.m3u8_urls):
                    self.status_text.append(f"{i+1}. {url}")
                
                # 첫 번째 URL 선택
                self.selected_url = self.m3u8_urls[0]
                self.download_btn.setEnabled(True)
            else:
                self.status_text.clear()
                self.status_text.append("m3u8 URL을 찾을 수 없습니다. HTML 파일을 확인해주세요.")
                self.download_btn.setEnabled(False)
                
        except Exception as e:
            self.status_text.append(f"URL 추출 중 오류가 발생했습니다: {str(e)}")
    
    def start_download(self):
        """다운로드 시작"""
        if not self.mp4_checkbox.isChecked() and not self.mp3_checkbox.isChecked():
            QMessageBox.warning(self, "경고", "MP4 또는 MP3 형식을 하나 이상 선택해주세요.")
            return
            
        if not hasattr(self, 'selected_url') or not self.selected_url:
            QMessageBox.warning(self, "경고", "변환할 URL이 선택되지 않았습니다.")
            return
            
        # ffmpeg 확인
        try:
            subprocess.run(['ffmpeg', '-version'], 
                          stdout=subprocess.PIPE, 
                          stderr=subprocess.PIPE, 
                          check=True)
        except (subprocess.SubprocessError, FileNotFoundError):
            QMessageBox.critical(
                self, 
                "오류", 
                "ffmpeg가 설치되어 있지 않거나 실행할 수 없습니다. "
                "ffmpeg를 설치하고 시스템 경로에 추가해주세요."
            )
            return
        
        # 선택된 형식에 따라 다운로드 시작
        if self.mp4_checkbox.isChecked():
            self._download_file('mp4')
        
        if self.mp3_checkbox.isChecked():
            if not self.mp4_checkbox.isChecked():  # MP4가 선택되지 않은 경우에만 바로 시작
                self._download_file('mp3')
            else:
                # MP4 변환이 완료된 후 MP3 변환 시작 (conversion_finished 시그널에서 처리)
                pass
    
    def _download_file(self, format_type):
        """파일 다운로드 공통 처리 로직"""
        # 출력 파일 경로 설정
        output_path = os.path.join(self.save_folder, f"{self.page_title}.{format_type}")
        
        # 변환 시작
        self.status_text.append(f"{format_type.upper()} 변환 시작: {self.selected_url}")
        self.progress_bar.setVisible(True)
        self.progress_bar.setValue(0)
        self.download_btn.setEnabled(False)
        
        # 변환 스레드 시작
        self.ffmpeg_thread = FFmpegThread(self.selected_url, output_path, format_type)
        self.ffmpeg_thread.progress_update.connect(self.update_progress)
        self.ffmpeg_thread.progress_percent.connect(self.update_progress_bar)
        self.ffmpeg_thread.conversion_finished.connect(self.conversion_completed)
        self.ffmpeg_thread.start()
    
    def update_progress(self, message):
        """변환 진행 상황 업데이트"""
        try:
            self.status_text.append(message)
            # 스크롤을 항상 아래로 유지
            self.status_text.verticalScrollBar().setValue(
                self.status_text.verticalScrollBar().maximum()
            )
        except Exception as e:
            self.status_text.append(f"로그 업데이트 중 오류: {str(e)}")
    
    def update_progress_bar(self, percent):
        """진행률 업데이트"""
        self.progress_bar.setValue(percent)
    
    def conversion_completed(self, success, message, file_path):
        """변환 완료 처리"""
        # 현재 변환 형식 확인
        current_format = "MP3" if hasattr(self, 'ffmpeg_thread') and self.ffmpeg_thread.output_format == 'mp3' else "MP4"
        
        if success:
            self.progress_bar.setValue(100)
            self.status_text.append(f"{current_format} 변환 완료: {file_path}")
            
            # MP4 변환 완료 후 MP3도 선택되어 있는 경우
            if current_format == "MP4" and self.mp3_checkbox.isChecked():
                self._download_file('mp3')
                return
        else:
            self.status_text.append(f"{current_format} 변환 실패: {message}")
        
        # 모든 변환이 완료되거나 실패한 경우
        self.download_btn.setEnabled(True)
        
        if success and current_format == "MP3" and self.mp4_checkbox.isChecked():
            # MP4와 MP3 모두 선택되어 있고, MP3까지 완료된 경우
            QMessageBox.information(self, "완료", "모든 다운로드가 완료되었습니다.")
        elif success and ((current_format == "MP4" and not self.mp3_checkbox.isChecked()) or 
                          (current_format == "MP3" and not self.mp4_checkbox.isChecked())):
            # 하나의 형식만 선택되어 있고 완료된 경우
            QMessageBox.information(self, "완료", f"{current_format} 다운로드가 완료되었습니다.")
    
    def check_for_updates(self):
        """사용자가 요청한 업데이트 확인"""
        self.status_text.append("GitHub에서 업데이트를 확인하는 중...")
        self.updater_manager.check_for_updates(silent=False)
    
    def show_update_notification(self, new_version):
        """새 버전 알림 표시"""
        self.status_text.append(f"새 버전({new_version})이 있습니다. 업데이트하려면 'Check for Updates' 버튼을 클릭하세요.")
    
    def show_update_progress(self, message, percent):
        """업데이트 진행 상황 표시"""
        self.status_text.append(message)
        self.progress_bar.setValue(percent)
    
    def load_settings(self):
        """설정 불러오기"""
        if self.settings.contains("save_folder"):
            save_folder = self.settings.value("save_folder")
            if os.path.exists(save_folder):
                self.save_folder = save_folder
    
    def closeEvent(self, event):
        """앱 종료 시 설정 저장"""
        self.settings.setValue("save_folder", self.save_folder)
        event.accept()


if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setStyle('Fusion')  # 모던한 스타일 적용
    downloader = CoursemosDownloader()
    downloader.show()
    sys.exit(app.exec_())
