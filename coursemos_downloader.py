import sys
import os
import re
import subprocess
import requests
import tempfile
import zipfile
import shutil
import atexit
from bs4 import BeautifulSoup

from m3u8_extract import extract_m3u8_urls, extract_page_title, sanitize_filename
from PyQt5.QtWidgets import (QApplication, QMainWindow, QPushButton, QFileDialog, 
                           QLabel, QVBoxLayout, QHBoxLayout, QWidget, QProgressBar, 
                           QTextEdit, QMessageBox, QCheckBox, QFrame, QMenu, QAction,
                           QComboBox, QInputDialog, QLineEdit)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QSettings, QTimer
from PyQt5.QtGui import QFont, QIcon, QPixmap




# pip install packaging (버전 비교용)
try:
    from packaging import version
except ImportError:
    print("packaging 모듈이 필요합니다. pip install packaging 명령으로 설치하세요.")
    sys.exit(1)

# 앱 버전 정보
APP_VERSION = "1.1.0"

# 일부 CDN이 기본 ffmpeg UA를 거부하므로 브라우저 UA를 사용
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# Windows에서 ffmpeg 실행 시 콘솔 창이 뜨지 않도록 함
CREATE_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
GITHUB_OWNER = "sunes26" 
GITHUB_REPO = "coursemos-downloader" 



class FFmpegManager:
    """ffmpeg 바이너리 관리 클래스"""
    
    def __init__(self):
        self.ffmpeg_path = None
        self.ffprobe_path = None
        self.temp_dir = None
        self.initialize()
        
    def initialize(self):
        """ffmpeg 및 ffprobe 경로 초기화"""
        # 1. 먼저 시스템 PATH에 ffmpeg가 있는지 확인
        try:
            subprocess.run(['ffmpeg', '-version'], 
                          stdout=subprocess.PIPE, 
                          stderr=subprocess.PIPE, 
                          check=True)
            subprocess.run(['ffprobe', '-version'], 
                          stdout=subprocess.PIPE, 
                          stderr=subprocess.PIPE, 
                          check=True)
            # 시스템에 설치된 ffmpeg를 사용
            self.ffmpeg_path = 'ffmpeg'
            self.ffprobe_path = 'ffprobe'
            return
        except (subprocess.SubprocessError, FileNotFoundError):
            # 시스템 PATH에 없는 경우, 내장된 ffmpeg 사용 시도
            pass
        
        # 2. 패키징된 앱 내부에서 ffmpeg 찾기
        try:
            base_path = self._get_base_path()
            
            # 번들에 포함된 경로 시도
            possible_locations = [
                # 루트 디렉토리
                base_path,
                # bin 폴더 내부
                os.path.join(base_path, "bin"),
                # 상대 경로
                os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin")
            ]
            
            ffmpeg_found = False
            for location in possible_locations:
                ffmpeg_exe = os.path.join(location, "ffmpeg.exe")
                ffprobe_exe = os.path.join(location, "ffprobe.exe")
                
                if os.path.exists(ffmpeg_exe) and os.path.exists(ffprobe_exe):
                    self.ffmpeg_path = ffmpeg_exe
                    self.ffprobe_path = ffprobe_exe
                    ffmpeg_found = True
                    break
            
            # 3. 내장된 파일을 임시 디렉토리에 추출
            if not ffmpeg_found:
                self._extract_binaries()
        except Exception as e:
            print(f"ffmpeg 초기화 오류: {str(e)}")
    
    def _get_base_path(self):
        """애플리케이션 기본 경로 가져오기"""
        try:
            # PyInstaller 번들의 경우
            base_path = sys._MEIPASS
        except Exception:
            # 일반 Python 스크립트의 경우
            base_path = os.path.abspath(".")
        return base_path
    
    def _extract_binaries(self):
        """내장된 바이너리를 임시 디렉토리에 추출"""
        try:
            # 임시 디렉토리 생성
            self.temp_dir = tempfile.mkdtemp()
            atexit.register(self._cleanup_temp_dir)  # 앱 종료 시 임시 디렉토리 삭제
            
            base_path = self._get_base_path()
            
            # ffmpeg.exe와 ffprobe.exe를 리소스에서 임시 디렉토리로 복사
            ffmpeg_resource = os.path.join(base_path, "ffmpeg.exe")
            ffprobe_resource = os.path.join(base_path, "ffprobe.exe")
            
            if os.path.exists(ffmpeg_resource) and os.path.exists(ffprobe_resource):
                ffmpeg_temp = os.path.join(self.temp_dir, "ffmpeg.exe")
                ffprobe_temp = os.path.join(self.temp_dir, "ffprobe.exe")
                
                shutil.copy2(ffmpeg_resource, ffmpeg_temp)
                shutil.copy2(ffprobe_resource, ffprobe_temp)
                
                self.ffmpeg_path = ffmpeg_temp
                self.ffprobe_path = ffprobe_temp
            
        except Exception as e:
            print(f"ffmpeg 바이너리 추출 오류: {str(e)}")
    
    def _cleanup_temp_dir(self):
        """임시 디렉토리 정리"""
        if self.temp_dir and os.path.exists(self.temp_dir):
            try:
                shutil.rmtree(self.temp_dir)
            except:
                pass
    
    def get_ffmpeg_command(self):
        """ffmpeg 명령 경로 반환"""
        return self.ffmpeg_path if self.ffmpeg_path else "ffmpeg"
    
    def get_ffprobe_command(self):
        """ffprobe 명령 경로 반환"""
        return self.ffprobe_path if self.ffprobe_path else "ffprobe"


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


class DirectUpdater(QThread):
    """기존 파일을 직접 업데이트하는 스레드"""
    progress_update = pyqtSignal(str, int)  # 메시지, 진행률
    update_completed = pyqtSignal(bool, str)  # 성공 여부, 메시지
    
    def __init__(self, download_url, current_file):
        super().__init__()
        self.download_url = download_url
        self.current_file = current_file  # 현재 실행 중인 파일 경로
    
    def run(self):
        try:
            self.progress_update.emit("업데이트 시작...", 0)
            
            # 임시 폴더 생성
            temp_dir = tempfile.mkdtemp()
            temp_zip = os.path.join(temp_dir, "update.zip")
            
            # 1. 업데이트 파일 다운로드
            self.progress_update.emit("업데이트 다운로드 중...", 10)
            response = requests.get(self.download_url, stream=True)
            total_size = int(response.headers.get('content-length', 0))
            
            with open(temp_zip, 'wb') as f:
                downloaded = 0
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total_size > 0:
                            percent = int(downloaded / total_size * 100)
                            self.progress_update.emit(f"다운로드 중... {percent}%", 10 + percent // 2)
            
            # 2. ZIP 파일 압축 해제
            self.progress_update.emit("ZIP 파일 압축 해제 중...", 60)
            extract_dir = os.path.join(temp_dir, "extracted")
            os.makedirs(extract_dir, exist_ok=True)
            
            with zipfile.ZipFile(temp_zip, 'r') as zip_ref:
                zip_ref.extractall(extract_dir)
            
            # 디버깅: ZIP 파일 구조 출력
            self.progress_update.emit("ZIP 구조 분석 중...", 65)
            
            # 3. 파일 찾기 - 확장자 확인
            self.progress_update.emit("업데이트 파일 찾는 중...", 70)
            
            # 현재 파일 이름과 경로
            current_filename = os.path.basename(self.current_file)
            current_dir = os.path.dirname(self.current_file)
            
            # 현재 실행 파일이 .exe인지 확인
            if not current_filename.lower().endswith('.exe'):
                self.progress_update.emit("업데이트 지원되지 않음: 현재 실행 파일이 EXE가 아닙니다.", 0)
                self.update_completed.emit(False, "현재 실행 파일이 EXE가 아니라 업데이트할 수 없습니다.")
                return
            
            self.progress_update.emit(f"현재 실행 파일: {current_filename}", 71)
            
            # 기본 파일명 추출 (확장자 제외)
            base_name = os.path.splitext(current_filename)[0]
            
            # 가능한 EXE 파일 이름들 (대소문자, 하이픈/언더스코어 차이 허용)
            possible_names = [
                current_filename,
                base_name.replace('_', '-') + '.exe',
                base_name.replace('-', '_') + '.exe',
                base_name.lower() + '.exe',
                base_name.lower().replace('_', '-') + '.exe',
                base_name.lower().replace('-', '_') + '.exe'
            ]
            
            self.progress_update.emit(f"검색할 파일명: {', '.join(possible_names)}", 72)
            
            # EXE 파일 찾기
            main_file_path = None
            
            # 재귀적으로 모든 폴더 탐색
            for root, dirs, files in os.walk(extract_dir):
                for file in files:
                    # EXE 파일만 처리
                    if file.lower().endswith('.exe'):
                        self.progress_update.emit(f"발견된 EXE 파일: {file}", 73)
                        # 가능한 이름 중 하나와 일치하는지 확인
                        if file in possible_names or file.lower() in [name.lower() for name in possible_names]:
                            main_file_path = os.path.join(root, file)
                            self.progress_update.emit(f"실행 파일을 찾았습니다: {file}", 75)
                            break
                
                # 파일을 찾았다면 루프 종료
                if main_file_path:
                    break
            
            # EXE 파일을 찾지 못한 경우
            if not main_file_path:
                # 업데이트 패키지에 Python 파일이 있는지 확인
                py_file_exists = False
                py_file_name = None
                
                for root, dirs, files in os.walk(extract_dir):
                    for file in files:
                        if file.lower().endswith('.py'):
                            py_file_exists = True
                            py_file_name = file
                            break
                    if py_file_exists:
                        break
                
                if py_file_exists:
                    self.progress_update.emit(f"EXE 파일을 찾을 수 없고 Python 파일({py_file_name})만 있습니다.", 0)
                    self.update_completed.emit(False, 
                        f"업데이트 패키지에 EXE 파일이 없고 Python 파일({py_file_name})만 포함되어 있습니다.\n"
                        f"EXE 파일 전용 업데이트만 지원되므로 업데이트를 진행할 수 없습니다.\n\n"
                        f"GitHub 릴리스에 EXE 파일이 포함된 업데이트 패키지를 요청하세요."
                    )
                else:
                    self.progress_update.emit("EXE 파일을 찾을 수 없습니다.", 0)
                    self.update_completed.emit(False, 
                        f"업데이트 패키지에서 EXE 파일을 찾을 수 없습니다.\n"
                        f"GitHub 릴리스에 EXE 파일이 포함된 업데이트 패키지를 요청하세요."
                    )
                return
            
            # 4. 새 버전을 _new 파일로 복사
            self.progress_update.emit("업데이트 파일 준비 중...", 80)
            new_file_path = os.path.splitext(self.current_file)[0] + "_new.exe"
            
            try:
                shutil.copy2(main_file_path, new_file_path)
            except Exception as e:
                self.progress_update.emit(f"업데이트 파일 복사 실패: {str(e)}", 0)
                self.update_completed.emit(False, f"새 버전 파일을 복사하는 데 실패했습니다: {str(e)}")
                return
            
            # 5. 업데이트 배치 파일 생성
            batch_path = os.path.join(current_dir, "update.bat")
            
            try:
                with open(batch_path, 'w') as batch_file:
                    batch_file.write('@echo off\n')
                    batch_file.write('echo Coursemos Downloader 업데이트 중...\n')
                    batch_file.write('echo 잠시만 기다려주세요...\n\n')
                    batch_file.write('timeout /t 2 /nobreak > nul\n\n')
                    batch_file.write(f'if exist "%~dp0{current_filename}.bak" (\n')
                    batch_file.write(f'    del "%~dp0{current_filename}.bak"\n')
                    batch_file.write(')\n\n')
                    batch_file.write(f'if not exist "%~dp0{base_name}_new.exe" (\n')
                    batch_file.write('    echo 업데이트 파일을 찾을 수 없습니다.\n')
                    batch_file.write('    goto :error\n')
                    batch_file.write(')\n\n')
                    batch_file.write(f'ren "%~dp0{current_filename}" "{current_filename}.bak"\n')
                    batch_file.write('if errorlevel 1 goto :error\n\n')
                    batch_file.write(f'ren "%~dp0{base_name}_new.exe" "{current_filename}"\n')
                    batch_file.write('if errorlevel 1 goto :error\n\n')
                    batch_file.write('echo 업데이트가 성공적으로 완료되었습니다!\n')
                    batch_file.write('echo 프로그램을 다시 시작합니다...\n\n')
                    batch_file.write(f'start "" "%~dp0{current_filename}"\n')
                    batch_file.write('goto :end\n\n')
                    batch_file.write(':error\n')
                    batch_file.write('echo 업데이트 중 오류가 발생했습니다.\n')
                    batch_file.write('echo 관리자에게 문의하세요.\n')
                    batch_file.write('pause\n\n')
                    batch_file.write(':end\n')
                    batch_file.write('exit\n')
            except Exception as e:
                self.progress_update.emit(f"업데이트 스크립트 생성 실패: {str(e)}", 0)
                self.update_completed.emit(False, f"업데이트 스크립트 생성에 실패했습니다: {str(e)}")
                return
            
            # 6. 임시 파일 정리
            try:
                shutil.rmtree(temp_dir)
            except:
                pass  # 임시 파일 삭제 실패는 무시
            
            # 7. 업데이트 완료 - 성공 메시지 전송
            self.progress_update.emit("업데이트 파일 준비 완료", 100)
            self.update_completed.emit(True, f"업데이트 파일이 준비되었습니다. 프로그램 종료 후 업데이트를 완료합니다.")
            
        except Exception as e:
            self.progress_update.emit(f"업데이트 오류: {str(e)}", 0)
            self.update_completed.emit(False, f"업데이트 중 오류가 발생했습니다: {str(e)}")


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
    
    def __init__(self, m3u8_url, output_path, output_format, ffmpeg_manager):
        super().__init__()
        self.m3u8_url = m3u8_url
        self.output_path = output_path
        self.output_format = output_format
        self.duration_ms = None  # 총 재생 시간 (밀리초)
        self.ffmpeg_manager = ffmpeg_manager
        
    def run(self):
        try:
            # 먼저 duration 정보 가져오기
            self.get_duration()
            
            # 출력 형식에 따른 명령어 설정
            ffmpeg_cmd = self.ffmpeg_manager.get_ffmpeg_command()
            
            if self.output_format == 'mp3':
                # MP3로 변환할 때는 오디오만 추출
                command = [
                    ffmpeg_cmd,
                    '-y',           # 기존 파일 덮어쓰기 (대화형 프롬프트 방지)
                    '-nostdin',     # stdin 대기 금지
                    '-user_agent', USER_AGENT,
                    '-i', self.m3u8_url,
                    '-b:a', '192k',  # 기본 비트레이트
                    '-codec:a', 'libmp3lame',  # MP3 인코더 사용
                    self.output_path
                ]
            else:
                # MP4로 변환 (기본 방식)
                command = [
                    ffmpeg_cmd,
                    '-y',           # 기존 파일 덮어쓰기 (대화형 프롬프트 방지)
                    '-nostdin',     # stdin 대기 금지
                    '-user_agent', USER_AGENT,
                    '-i', self.m3u8_url,
                    '-c', 'copy',  # 코덱 복사
                    '-bsf:a', 'aac_adtstoasc',  # AAC 필터
                    self.output_path
                ]
                
            self.progress_update.emit(f"실행 명령어: {' '.join(command)}")
            
            # 프로세스 실행 및 출력 캡처 (인코딩 명시)
            process = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,  # 읽지 않는 파이프는 데드락 원인이 됨
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                universal_newlines=True,
                encoding='utf-8',
                errors='replace',
                creationflags=CREATE_NO_WINDOW
            )
            
            # 출력 모니터링 (EOF까지 읽어 마지막 줄 유실 방지)
            error_lines = []
            for output in process.stderr:
                if output:
                    error_lines.append(output)
                    if len(error_lines) > 50:
                        error_lines.pop(0)
                    self.progress_update.emit(output.strip())
                    
                    # 진행률 추출 및 업데이트
                    if self.duration_ms:
                        time_match = re.search(r'time=(\d+):(\d+):(\d+)\.(\d{1,3})', output)
                        if time_match:
                            hours, minutes, seconds, frac = time_match.groups()
                            # 소수부 자릿수에 맞춰 밀리초로 환산 (2자리=센티초)
                            frac_ms = int(frac) * (10 ** (3 - len(frac)))
                            current_ms = (int(hours) * 3600000 + int(minutes) * 60000
                                          + int(seconds) * 1000 + frac_ms)
                            percent = min(int(current_ms / self.duration_ms * 100), 100)
                            self.progress_percent.emit(percent)
            
            # 완료 확인
            return_code = process.wait()
            if return_code == 0:
                self.progress_percent.emit(100)  # 완료 시 100%로 설정
                self.conversion_finished.emit(True, "변환 완료!", self.output_path)
            else:
                error_output = ''.join(error_lines).strip()
                self.conversion_finished.emit(
                    False, f"변환 실패 (코드 {return_code}): {error_output}", "")
                    
        except Exception as e:
            self.conversion_finished.emit(False, f"오류 발생: {str(e)}", "")
    
    def get_duration(self):
        """미디어 파일의 총 재생 시간을 가져옵니다."""
        try:
            ffprobe_cmd = self.ffmpeg_manager.get_ffprobe_command()
            
            command = [ffprobe_cmd, '-v', 'error', '-user_agent', USER_AGENT,
                      '-show_entries', 'format=duration',
                      '-of', 'default=noprint_wrappers=1:nokey=1', self.m3u8_url]
            
            result = subprocess.run(command, capture_output=True, text=True,
                                    encoding='utf-8', errors='replace',
                                    creationflags=CREATE_NO_WINDOW)
            
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
        # silent 파라미터를 무시하고 항상 업데이트 대화상자 표시
        detail_text = f"변경 사항:\n\n{release_notes}" if release_notes else ""
        
        msg_box = QMessageBox(self.parent)
        msg_box.setWindowTitle("업데이트 가능")
        msg_box.setText(f"새 버전({new_version})이 있습니다. 현재 버전: {APP_VERSION}")
        msg_box.setInformativeText(
            "지금 업데이트하시겠습니까?\n\n"
            "업데이트가 완료되면 프로그램을 재시작해야 합니다."
        )
        if detail_text:
            msg_box.setDetailedText(detail_text)
        msg_box.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
        msg_box.setDefaultButton(QMessageBox.Yes)
        
        if msg_box.exec() == QMessageBox.Yes:
            self.parent.status_text.append(f"새 버전 v{new_version} 업데이트를 시작합니다...")
            self._start_update(download_url, new_version)
    
    def _start_update(self, download_url, version):
        """업데이트 시작"""
        # 현재 스크립트 경로
        current_file = os.path.abspath(sys.argv[0])
        
        # 중복 인스턴스 확인
        try:
            script_name = os.path.basename(current_file)
            import psutil
            
            count = 0
            for proc in psutil.process_iter(['name', 'cmdline']):
                try:
                    cmdline = proc.info.get('cmdline', [])
                    if len(cmdline) > 1 and script_name in cmdline[-1]:
                        count += 1
                except:
                    pass
                    
            if count > 1:
                QMessageBox.warning(
                    self.parent,
                    "업데이트 불가",
                    "이 프로그램의 다른 인스턴스가 실행 중입니다.\n모든 인스턴스를 종료한 후에 업데이트를 진행해주세요."
                )
                return
        except:
            pass  # psutil 모듈이 없어도 계속 진행
        
        # 업데이트 스레드 시작
        self.updater = DirectUpdater(download_url, current_file)
        self.updater.progress_update.connect(self.parent.show_update_progress)
        self.updater.update_completed.connect(self.on_update_completed)
        self.updater.start()
        
        self.parent.status_text.append("업데이트 파일 다운로드 중...")
    
    def on_update_completed(self, success, message):
        """업데이트 완료 처리"""
        if success:
            result = QMessageBox.information(
                self.parent,
                "업데이트 준비 완료",
                f"{message}\n\n지금 프로그램을 종료하고 업데이트를 진행하시겠습니까?",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.Yes
            )
        
            if result == QMessageBox.Yes:
                # 현재 디렉토리의 update.bat 실행 후 프로그램 종료
                update_bat = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "update.bat")
                if os.path.exists(update_bat):
                    subprocess.Popen([update_bat], shell=True)
                    QApplication.quit()  # 프로그램 종료
        else:
            QMessageBox.warning(self.parent, "업데이트 실패", message)

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
        
        # ffmpeg 관리자 초기화
        self.ffmpeg_manager = FFmpegManager()
        
        # 로고 설정
        icon_path = self.resource_path("logo.png")  # 로고 파일 경로
        if os.path.exists(icon_path):
            self.setWindowIcon(QIcon(icon_path))
        
        self.init_ui()
        
        # 업데이트 관리자 초기화
        self.updater_manager = GitHubUpdaterManager(self)
        
        # 앱 시작 시 자동 업데이트 확인
        QTimer.singleShot(1000, lambda: self.updater_manager.check_for_updates())
    
    def resource_path(self, relative_path):
        """애플리케이션 리소스 파일의 절대 경로를 반환합니다.
        PyInstaller로 패키징된 경우와 일반 Python 실행 시 모두 작동합니다."""
        try:
            # PyInstaller가 생성한 임시 폴더 경로
            base_path = sys._MEIPASS
        except Exception:
            # 일반적인 Python 실행 시 스크립트 위치 기준
            base_path = os.path.abspath(".")
        
        return os.path.join(base_path, relative_path)
        
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
        
        # 로고 추가
        logo_label = QLabel()
        logo_path = self.resource_path("logo.png")  # 로고 파일 경로
        if os.path.exists(logo_path):
            logo_pixmap = QPixmap(logo_path)
            # 로고 크기 조정 (너비 150px에 맞추고 비율 유지)
            logo_pixmap = logo_pixmap.scaled(150, 150, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            logo_label.setPixmap(logo_pixmap)
            logo_label.setAlignment(Qt.AlignCenter)
            left_layout.addWidget(logo_label)
            left_layout.addSpacing(10)  # 로고와 타이틀 사이 간격
        
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
        self.selected_file_label.setWordWrap(True)
        left_layout.addWidget(self.selected_file_label)
        
        # m3u8 URL을 직접 입력하는 대체 경로
        self.manual_url_btn = QPushButton("Enter m3u8 URL")
        self.manual_url_btn.setFixedHeight(30)
        self.manual_url_btn.clicked.connect(self.enter_url_manually)
        left_layout.addWidget(self.manual_url_btn)
        
        left_layout.addSpacing(10)
        
        # 발견된 URL 선택 (여러 개일 때만 활성화)
        left_layout.addWidget(QLabel("Video URL:"))
        self.url_combo = QComboBox()
        self.url_combo.setEnabled(False)
        self.url_combo.currentIndexChanged.connect(self.on_url_selected)
        left_layout.addWidget(self.url_combo)
        
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
        """파일명에 사용할 수 없는 문자 제거 (m3u8_extract 모듈에 위임)"""
        return sanitize_filename(filename)

    def read_html_file(self, file_path):
        """여러 인코딩을 시도해 HTML 파일을 읽는다."""
        for encoding in ('utf-8', 'utf-8-sig', 'cp949', 'euc-kr'):
            try:
                with open(file_path, 'r', encoding=encoding) as file:
                    return file.read()
            except UnicodeDecodeError:
                continue

        # 마지막 수단: 깨진 문자를 대체하여 읽기 (URL은 ASCII라 추출에 지장 없음)
        with open(file_path, 'r', encoding='utf-8', errors='replace') as file:
            return file.read()

    def set_m3u8_urls(self, urls, source_label):
        """찾은 URL 목록을 UI에 반영한다."""
        self.m3u8_urls = urls
        self.url_combo.clear()

        if not urls:
            self.selected_url = None
            self.url_combo.setEnabled(False)
            self.download_btn.setEnabled(False)
            self.status_text.append(
                "m3u8 URL을 찾을 수 없습니다. "
                "브라우저에서 '다른 이름으로 저장 > 웹페이지, 전체'로 "
                "저장했는지 확인해주세요. "
                "또는 'Enter m3u8 URL' 버튼으로 URL을 직접 입력할 수 있습니다."
            )
            return

        for index, url in enumerate(urls):
            self.url_combo.addItem(f"{index + 1}. {url}", url)

        self.url_combo.setEnabled(len(urls) > 1)
        self.url_combo.setCurrentIndex(0)
        self.selected_url = urls[0]
        self.download_btn.setEnabled(True)

        self.status_text.append(f"{len(urls)}개의 m3u8 URL을 발견했습니다. ({source_label})")
        for index, url in enumerate(urls):
            self.status_text.append(f"{index + 1}. {url}")
        if len(urls) > 1:
            self.status_text.append("여러 개가 있으면 목록에서 원하는 URL을 선택하세요.")

    def on_url_selected(self, index):
        """URL 콤보박스 선택 변경 처리"""
        if index < 0:
            return
        url = self.url_combo.itemData(index)
        if url:
            self.selected_url = url

    def enter_url_manually(self):
        """m3u8 URL 직접 입력"""
        url, ok = QInputDialog.getText(
            self, "m3u8 URL 입력",
            "동영상 스트림(.m3u8) 주소를 붙여넣으세요:",
            QLineEdit.Normal, ""
        )

        if not ok:
            return

        url = url.strip()
        if not url:
            return

        if '.m3u8' not in url:
            QMessageBox.warning(self, "경고", "m3u8 주소가 아닌 것 같습니다. 다시 확인해주세요.")
            return

        if not hasattr(self, 'page_title') or not self.page_title:
            self.page_title = 'video'

        self.status_text.append("URL을 직접 입력했습니다.")
        self.set_m3u8_urls([url], "직접 입력")

        # 직접 입력한 경우 파일명을 물어본다
        name, ok = QInputDialog.getText(
            self, "파일명", "저장할 파일 이름:", QLineEdit.Normal, self.page_title
        )
        if ok and name.strip():
            self.page_title = self.sanitize_filename(name)
        self.status_text.append(f"저장할 파일 이름: {self.page_title}")

    def extract_urls(self):
        """HTML 파일에서 m3u8 URL 추출"""
        if not hasattr(self, 'html_file_path'):
            self.status_text.append("HTML 파일을 먼저 선택해주세요.")
            return

        try:
            html_content = self.read_html_file(self.html_file_path)

            # 페이지 제목 -> 저장 파일명
            self.page_title = extract_page_title(html_content, self.html_file_path)
            self.status_text.append(f"저장할 파일 이름: {self.page_title}")

            # URL 추출: 원본 텍스트 + BeautifulSoup 속성값 양쪽에서 검색
            urls = extract_m3u8_urls(html_content)
            urls.extend(self._extract_urls_from_attributes(html_content))
            urls = list(dict.fromkeys(urls))  # 순서 유지 중복 제거

            self.set_m3u8_urls(urls, os.path.basename(self.html_file_path))

        except Exception as e:
            self.status_text.append(f"URL 추출 중 오류가 발생했습니다: {str(e)}")
            self.download_btn.setEnabled(False)

    def _extract_urls_from_attributes(self, html_content):
        """BeautifulSoup으로 파싱한 뒤 모든 태그 속성값에서 m3u8을 찾는다.

        data-setup / data-setup-lazy / src / data-src 등 플레이어 설정이
        속성에 들어 있는 경우를 잡아낸다. (예: 인천대 LMS video.js)
        """
        found = []

        try:
            soup = BeautifulSoup(html_content, 'html.parser')
        except Exception:
            return found

        for tag in soup.find_all(True):
            for value in tag.attrs.values():
                if isinstance(value, list):
                    value = ' '.join(value)
                if isinstance(value, str) and '.m3u8' in value:
                    found.extend(extract_m3u8_urls(value))

        for script in soup.find_all('script'):
            if script.string and '.m3u8' in script.string:
                found.extend(extract_m3u8_urls(script.string))

        return found

    def start_download(self):
        """다운로드 시작"""
        if not self.mp4_checkbox.isChecked() and not self.mp3_checkbox.isChecked():
            QMessageBox.warning(self, "경고", "MP4 또는 MP3 형식을 하나 이상 선택해주세요.")
            return
            
        if not hasattr(self, 'selected_url') or not self.selected_url:
            QMessageBox.warning(self, "경고", "변환할 URL이 선택되지 않았습니다.")
            return
            
        # 내장된 ffmpeg 사용
        if not self.ffmpeg_manager.ffmpeg_path:
            QMessageBox.critical(
                self, 
                "오류", 
                "ffmpeg를 찾을 수 없습니다. 프로그램 설치에 문제가 있을 수 있습니다."
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
        
        # 변환 스레드 시작 (ffmpeg_manager 추가)
        self.ffmpeg_thread = FFmpegThread(self.selected_url, output_path, format_type, self.ffmpeg_manager)
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
    
    def show_update_notification(self, new_version):
        """새 버전 알림 표시"""
        self.status_text.append(f"새 버전({new_version})이 있습니다.")
    
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
