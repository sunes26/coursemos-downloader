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
APP_VERSION = "1.0.14"
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
            
            # 3. 메인 파일 찾기
            self.progress_update.emit("업데이트 파일 찾는 중...", 70)
            
            # 현재 파일 이름과 경로
            current_filename = os.path.basename(self.current_file)
            current_dir = os.path.dirname(self.current_file)
            
            # GitHub 압축 파일 구조 확인 (최상위 폴더 찾기)
            extracted_items = os.listdir(extract_dir)
            source_dir = extract_dir
            
            # GitHub 구조: 보통 하나의 최상위 폴더가 있음
            if len(extracted_items) == 1 and os.path.isdir(os.path.join(extract_dir, extracted_items[0])):
                source_dir = os.path.join(extract_dir, extracted_items[0])
            
            # 메인 파일 찾기
            main_file_path = None
            for root, dirs, files in os.walk(source_dir):
                for file in files:
                    if file == current_filename:
                        main_file_path = os.path.join(root, file)
                        break
                if main_file_path:
                    break
            
            if not main_file_path:
                self.progress_update.emit(f"{current_filename} 파일을 찾을 수 없습니다.", 0)
                self.update_completed.emit(False, f"업데이트 패키지에서 {current_filename} 파일을 찾을 수 없습니다.")
                return
            
            # 4. 파일 백업
            self.progress_update.emit("현재 파일 백업 중...", 80)
            backup_file = self.current_file + ".bak"
            
            # 이미 백업 파일이 있다면 삭제
            if os.path.exists(backup_file):
                os.remove(backup_file)
            
            # 현재 파일 백업
            shutil.copy2(self.current_file, backup_file)
            
            # 5. 새 파일 복사 - 재시도 로직 포함
            self.progress_update.emit("파일 업데이트 중...", 90)
            
            max_retries = 5
            for attempt in range(max_retries):
                try:
                    # 기존 파일 덮어쓰기
                    shutil.copy2(main_file_path, self.current_file)
                    break
                except PermissionError:
                    if attempt < max_retries - 1:
                        self.progress_update.emit(f"권한 오류, 재시도 중... ({attempt+1}/{max_retries})", 90)
                        time.sleep(1)  # 잠시 대기 후 재시도
                    else:
                        self.progress_update.emit("파일 업데이트 실패: 권한 오류", 0)
                        self.update_completed.emit(False, "파일 쓰기 권한이 없습니다. 관리자 권한으로 실행해보세요.")
                        return
            
            # 6. 업데이트 완료
            self.progress_update.emit("업데이트 완료", 100)
            self.update_completed.emit(True, f"업데이트가 성공적으로 완료되었습니다. 프로그램을 재시작하세요.")
            
            # 7. 임시 파일 정리
            try:
                shutil.rmtree(temp_dir)
            except:
                pass  # 임시 파일 삭제 실패는 무시
            
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
        
        # 쓰기 권한 확인
        try:
            with open(current_file, 'a'):
                pass
        except:
            QMessageBox.warning(
                self.parent,
                "업데이트 불가",
                "현재 파일에 쓰기 권한이 없습니다.\n관리자 권한으로 프로그램을 실행하거나, 파일 권한을 확인해주세요."
            )
            return
        
        # 업데이트 스레드 시작
        self.updater = DirectUpdater(download_url, current_file)
        self.updater.progress_update.connect(self.parent.show_update_progress)
        self.updater.update_completed.connect(self.on_update_completed)
        self.updater.start()
        
        self.parent.status_text.append("업데이트 파일 다운로드 중...")
    
    def on_update_completed(self, success, message):
        """업데이트 완료 처리"""
        if success:
            QMessageBox.information(
                self.parent,
                "업데이트 완료",
                f"{message}\n\n프로그램을 종료 후 다시 실행하면 새 버전으로 실행됩니다."
            )
        else:
            QMessageBox.warning(self.parent, "업데이트 실패", message)

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
        icon_path = self.resource_path("logo.png")  # 로고 파일 경로
        if os.path.exists(icon_path):
            self.setWindowIcon(QIcon(icon_path))
        self.init_ui()
        
        # 업데이트 관리자 초기화
        self.updater_manager = GitHubUpdaterManager(self)
        
        # 앱 시작 시 자동 업데이트 확인
        QTimer.singleShot(1000, lambda: self.updater_manager.check_for_updates())
        
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
