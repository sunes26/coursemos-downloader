import sys
import os
import tempfile
import subprocess
import requests
import zipfile
import shutil
import time
from packaging import version
from PyQt5.QtCore import QThread, pyqtSignal, QTimer

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
            
            # GitHub에서 받은 ZIP 파일 내부 구조 확인
            # 일반적으로 [username]-[repo]-[hash] 형태의 폴더가 있음
            # 예: sunes26-coursemos-downloader-9d05b37/
            github_repo_dir = None
            extracted_items = os.listdir(extract_dir)
            
            for item in extracted_items:
                item_path = os.path.join(extract_dir, item)
                if os.path.isdir(item_path):
                    # 하위 디렉토리 확인 (GitHub 레포지토리 구조)
                    self.update_progress.emit(f"발견된 디렉토리: {item}", 75)
                    if any(file.endswith('.py') for file in os.listdir(item_path)):
                        github_repo_dir = item_path
                        break
            
            if not github_repo_dir:
                # 폴더가 발견되지 않으면 추출 디렉토리 자체를 사용
                github_repo_dir = extract_dir
                self.update_progress.emit("GitHub 레포지토리 구조를 감지할 수 없습니다. 추출 디렉토리 사용.", 75)
            
            # 중요 파일 확인
            main_file_found = os.path.exists(os.path.join(github_repo_dir, "coursemos_downloader.py"))
            if not main_file_found:
                # 중요 파일이 없으면 오류
                self.update_completed.emit(False, "업데이트 파일에 필요한 파일(coursemos_downloader.py)이 없습니다.")
                return
            
            self.update_progress.emit("업데이트 배치 파일 생성 중...", 80)
            
            # 윈도우용 업데이트 스크립트 작성
            if sys.platform.startswith('win'):
                batch_file = os.path.join(temp_dir, "update.bat")
                with open(batch_file, 'w') as f:
                    f.write('@echo off\n')
                    f.write('echo Coursemos Downloader 업데이트 중...\n')
                    f.write('echo 잠시만 기다려주세요...\n')
                    f.write('timeout /t 3 /nobreak > nul\n')  # 3초 대기
                    
                    # 파일 복사 전 디렉토리 준비 상태 확인
                    f.write(f'echo 원본 파일 백업 중...\n')
                    f.write(f'cd /d "{app_dir}"\n')  # 앱 디렉토리로 이동
                    
                    if is_exe:
                        # 실행 파일 백업
                        f.write(f'if exist coursemos_downloader.exe.bak del coursemos_downloader.exe.bak\n')
                        f.write(f'if exist coursemos_downloader.exe rename coursemos_downloader.exe coursemos_downloader.exe.bak\n')
                    else:
                        # 파이썬 스크립트 백업
                        f.write(f'if exist coursemos_downloader.py.bak del coursemos_downloader.py.bak\n')
                        f.write(f'if exist coursemos_downloader.py rename coursemos_downloader.py coursemos_downloader.py.bak\n')
                    
                    # 새 파일 복사 전 디렉토리 확인
                    f.write(f'echo 새 파일 복사 중...\n')
                    f.write(f'if not exist "{github_repo_dir}" (\n')
                    f.write(f'  echo 오류: 소스 디렉토리를 찾을 수 없습니다\n')
                    f.write(f'  goto error\n')
                    f.write(f')\n')
                    
                    # 파일 복사 (xcopy의 /i 옵션은 대상이 디렉터리라고 가정하고, /y는 덮어쓰기 자동 확인)
                    f.write(f'xcopy "{github_repo_dir}\\*" "{app_dir}" /e /i /y\n')
                    f.write(f'if errorlevel 1 goto error\n')
                    
                    f.write(f'echo 업데이트 완료!\n')
                    
                    # 파일 복사 성공 후 원본 앱 시작
                    if is_exe:
                        f.write(f'start "" "{app_dir}\\coursemos_downloader.exe"\n')
                    else:
                        f.write(f'start "" python "{app_dir}\\coursemos_downloader.py"\n')
                    
                    # 임시 파일 정리
                    f.write(f'goto cleanup\n')
                    
                    # 오류 처리 섹션
                    f.write(f':error\n')
                    f.write(f'echo 업데이트 중 오류가 발생했습니다\n')
                    f.write(f'echo 원본 파일 복원 중...\n')
                    
                    # 백업 파일이 있으면 복원
                    if is_exe:
                        f.write(f'if exist coursemos_downloader.exe.bak rename coursemos_downloader.exe.bak coursemos_downloader.exe\n')
                        f.write(f'start "" "{app_dir}\\coursemos_downloader.exe"\n')
                    else:
                        f.write(f'if exist coursemos_downloader.py.bak rename coursemos_downloader.py.bak coursemos_downloader.py\n')
                        f.write(f'start "" python "{app_dir}\\coursemos_downloader.py"\n')
                    
                    # 임시 파일 정리 섹션
                    f.write(f':cleanup\n')
                    f.write(f'timeout /t 2 /nobreak > nul\n')  # 2초 더 대기
                    f.write(f'rmdir /s /q "{temp_dir}"\n')
                
                self.update_progress.emit("업데이트 설치 준비 완료...", 90)
                
                # 배치 파일 실행 (별도 프로세스)
                subprocess.Popen([batch_file], shell=True)
                
                self.update_progress.emit("업데이트 설치 중...", 95)
                self.update_completed.emit(True, "업데이트가 설치됩니다. 잠시 후 프로그램이 재시작됩니다.")
                
                # 현재 프로세스 종료 (약간의 지연 후)
                QTimer.singleShot(3000, lambda: sys.exit(0))
                
            # macOS 및 Linux 업데이트 스크립트 (추가 필요)
            # 이 부분은 윈도우와 비슷하게 수정 가능
                
        except Exception as e:
            self.update_completed.emit(False, f"업데이트 오류: {str(e)}")


class GitHubUpdaterManager:
    """GitHub 업데이트 관리자"""
    
    def __init__(self, parent, current_version, repo_owner, repo_name):
        """
        parent: 부모 윈도우 (QMainWindow)
        current_version: 현재 앱 버전 (예: "1.0.0")
        repo_owner: GitHub 저장소 소유자
        repo_name: GitHub 저장소 이름
        """
        self.parent = parent
        self.current_version = current_version
        self.repo_owner = repo_owner
        self.repo_name = repo_name
        
    def check_for_updates(self, silent=False):
        """업데이트 확인 시작"""
        self.checker = GitHubUpdateChecker(self.current_version, self.repo_owner, self.repo_name)
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
        from PyQt5.QtWidgets import QMessageBox
        detail_text = f"변경 사항:\n\n{release_notes}" if release_notes else ""
        
        msg_box = QMessageBox(self.parent)
        msg_box.setWindowTitle("업데이트 가능")
        msg_box.setText(f"새 버전({new_version})이 있습니다. 현재 버전: {self.current_version}")
        msg_box.setInformativeText("지금 업데이트하시겠습니까?")
        if detail_text:
            msg_box.setDetailedText(detail_text)
        msg_box.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
        msg_box.setDefaultButton(QMessageBox.Yes)
        
        if msg_box.exec() == QMessageBox.Yes:
            self.download_and_install_update(download_url)
    
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
        from PyQt5.QtWidgets import QMessageBox
        
        if success:
            QMessageBox.information(self.parent, "업데이트", message)
        else:
            QMessageBox.warning(self.parent, "업데이트 실패", message)
            self.parent.progress_bar.setVisible(False)