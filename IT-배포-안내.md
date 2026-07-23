# 클로드 다리 — IT 배포 안내 (PC 관리 도구용)

S-1 UX Writing 피그마 플러그인의 AI 추천 기능은 각 사용자 PC에서 개인 클로드 구독으로 동작합니다.
피그마 플러그인은 샌드박스라 아래 구성요소를 스스로 설치할 수 없습니다 — PC 관리 도구(MDM 등)로
사전 배포하면 **사용자는 플러그인에서 [클로드 로그인] 버튼 하나만 누르면 됩니다.**

## 배포할 것 (3가지)

1. **Node.js LTS** — 표준 패키지로 배포 (nodejs.org 또는 사내 저장소)
2. **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
   (로그인은 각 사용자가 브라우저로 직접 — 개인 구독이므로 IT가 대신할 수 없음)
3. **클로드 다리 감시자** — 아래 중 한 가지 방법

## 감시자 배포 방법

### 방법 A (권장·간단): 설치 스크립트를 사용자 로그인 컨텍스트에서 1회 실행

관리 도구로 각 사용자당 한 번, 사용자 권한으로 실행:

- **맥**:
  ```bash
  curl -fsSL https://report-admin-amber.vercel.app/api/bridge-setup | bash
  ```
  (오프라인 배포면 저장소의 `클로드다리-설치.command`를 대신 실행 — 같은 내용)
  결과: `~/Library/Application Support/ClaudeBridge`에 파일 설치 + 사용자 LaunchAgent
  (`com.claudebridge.watcher`) 등록. 관리자 권한 불필요.

- **윈도우**: 저장소의 `클로드다리-설치.bat`을 사용자 컨텍스트에서 1회 실행 (`CB_SILENT=1` 환경변수를 주면 팝업 없이 조용히 설치).
  결과: `%LOCALAPPDATA%\ClaudeBridge` 설치 + HKCU Run 자동시작 + `claudebridge://` 등록.

### 방법 B (전역): 시스템 영역에 밀어 넣기 (맥)

모든 사용자에게 한 번에 적용하려면:

1. 파일 4개를 `/Library/Application Support/ClaudeBridge/`에 복사 (root 소유, 읽기 전용 권장):
   - `scripts/claude-bridge.js`, `scripts/bridge-watcher.js`, `recommend-examples.md`, `ux-writing.md`
   (저장소의 같은 경로에서 그대로 복사)
2. `/Library/LaunchAgents/com.claudebridge.watcher.plist` 배포:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.claudebridge.watcher</string>
     <key>ProgramArguments</key>
     <array>
       <string>/usr/local/bin/node</string>
       <string>/Library/Application Support/ClaudeBridge/scripts/bridge-watcher.js</string>
     </array>
     <key>EnvironmentVariables</key>
     <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
   </dict>
   </plist>
   ```
   (node 경로는 배포한 Node.js 위치에 맞출 것. `/Library/LaunchAgents`는 모든 사용자 로그인 시 각자 세션에서 실행됨)

## 동작 확인

배포된 PC에서:
```bash
curl -s http://localhost:11889/health
```
→ `{"ok":true,"watcher":true,...}` 가 나오면 정상.

## 보안 참고

- 감시자(약 15MB 상주)와 다리는 **localhost 전용**(127.0.0.1 바인딩) — 외부 접속 불가.
- 다리는 피그마 플러그인이 닫히면 30초 내 자동 종료. 감시자만 상주.
- AI 호출은 각 사용자의 개인 클로드 구독으로만 나감 — 서버 API 키 없음.
- 검토(맞춤법) 기능은 이 배포 없이도 동작. 이 배포는 AI 추천·번역 전용.

## 배포 후 사용자 경험

1. 피그마에서 플러그인 열기
2. [클로드 로그인] → 브라우저에서 개인 계정 로그인 (최초 1회)
3. 끝 — 이후 추천을 누르면 자동으로 연결됩니다
