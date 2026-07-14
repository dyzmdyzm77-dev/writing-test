// 이 PC의 클로드 연결을 자동 설정한다 (npm install / npm run build에 포함).
// 1) claudebridge:// 프로토콜 등록 (구경로 — 피그마 버전에 따라 막힐 수 있어 보조용)
// 2) 감시자(bridge-watcher, 포트 11889) 로그인 자동시작 등록 + 지금 바로 기동 (주경로 —
//    피그마가 프로토콜 열기를 막아도 플러그인 fetch는 못 막으므로 감시자가 다리를 대신 켠다)
// 새 PC에 플러그인을 설치하려면 어차피 npm을 한 번 돌려야 하므로, 그 순간에 설정이 끝난다.
// HKCU라 관리자 권한 불필요. 실패해도 빌드는 계속(fail-soft).
const path = require('path');
const { spawn, spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  process.exit(0); // Windows 전용 — 다른 OS에선 조용히 통과
}

const launcher = path.join(__dirname, '..', 'claude-bridge-silent.vbs');
const watcherVbs = path.join(__dirname, '..', 'claude-watcher-silent.vbs');
const cmd = 'wscript.exe "' + launcher + '"';

function reg(args) {
  return spawnSync('reg', args, { stdio: 'ignore' }).status === 0;
}

const ok =
  reg(['add', 'HKCU\\Software\\Classes\\claudebridge', '/ve', '/d', 'URL:Claude Bridge', '/f']) &&
  reg(['add', 'HKCU\\Software\\Classes\\claudebridge', '/v', 'URL Protocol', '/d', '', '/f']) &&
  reg(['add', 'HKCU\\Software\\Classes\\claudebridge\\shell\\open\\command', '/ve', '/d', cmd, '/f']);

if (ok) {
  console.log('[protocol] claudebridge:// 등록 완료 → ' + launcher);
} else {
  console.log('[protocol] claudebridge:// 등록 실패 — 플러그인의 [설치 파일 받기] 또는 클로드다리-원클릭연결.vbs로 등록하세요.');
}

// 감시자: 로그인 자동시작 등록 + 지금 바로 기동 (이미 떠 있으면 EADDRINUSE로 조용히 물러남)
const watcherOk = reg(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'ClaudeBridgeWatcher', '/d', 'wscript.exe "' + watcherVbs + '"', '/f']);
try {
  const p = spawn('wscript.exe', [watcherVbs], { detached: true, stdio: 'ignore' });
  p.unref();
  console.log('[watcher] 감시자 ' + (watcherOk ? '자동시작 등록 + ' : '') + '기동 (포트 11889)');
} catch (e) {
  console.log('[watcher] 기동 실패(자동시작 등록은 ' + (watcherOk ? '됨' : '실패') + '):', e.message);
}
