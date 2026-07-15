// 이 PC의 클로드 연결을 자동 설정한다 (npm install / npm run build에 포함).
// 1) claudebridge:// 프로토콜 등록 (구경로 — 피그마 버전에 따라 막힐 수 있어 보조용)
// 2) 감시자(bridge-watcher, 포트 11889) 로그인 자동시작 등록 + 지금 바로 기동 (주경로 —
//    피그마가 프로토콜 열기를 막아도 플러그인 fetch는 못 막으므로 감시자가 다리를 대신 켠다)
// 새 PC에 플러그인을 설치하려면 어차피 npm을 한 번 돌려야 하므로, 그 순간에 설정이 끝난다.
// HKCU라 관리자 권한 불필요. 실패해도 빌드는 계속(fail-soft).
const path = require('path');
const { spawn, spawnSync } = require('child_process');

if (process.platform === 'darwin') {
  // macOS: 감시자(bridge-watcher)를 launchd 로그인 자동시작으로 등록 + 즉시 기동.
  // claudebridge:// 프로토콜은 등록하지 않는다 — 피그마가 프로토콜 열기를 전부 막는 것이
  // 실측 확인돼(CLAUDE.md), 어차피 유일한 동작 경로가 감시자 fetch(11889)이므로 감시자만으로 충분.
  const os = require('os');
  const fs = require('fs');
  const LABEL = 'com.claudebridge.watcher';
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(agentsDir, LABEL + '.plist');
  const watcherJs = path.join(__dirname, 'bridge-watcher.js');
  // launchd 기본 PATH엔 /usr/local/bin 등이 없어 다리가 claude를 못 찾는다 —
  // 등록 시점(사용자 셸)의 PATH를 plist에 굳혀 넣는다.
  const pathEnv = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key><string>' + LABEL + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>' + xml(process.execPath) + '</string>',
    '    <string>' + xml(watcherJs) + '</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict><key>PATH</key><string>' + xml(pathEnv) + '</string></dict>',
    '  <key>RunAtLoad</key><true/>',
    // 비정상 종료 시에만 재시동 — EADDRINUSE(exit 0) 중복 기동이 무한 재시작으로 번지지 않게
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(plistPath, plist);
    const uid = process.getuid();
    // 재등록 대비: 기존 등록을 내리고(bootout, 없으면 조용히 실패) 다시 올린다.
    spawnSync('launchctl', ['bootout', 'gui/' + uid + '/' + LABEL], { stdio: 'ignore' });
    const boot = spawnSync('launchctl', ['bootstrap', 'gui/' + uid, plistPath], { stdio: 'ignore' });
    if (boot.status !== 0) spawnSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' }); // 구버전 macOS 폴백
    console.log('[watcher] macOS 감시자 자동시작 등록(launchd) + 기동 — ' + plistPath);
  } catch (e) {
    console.log('[watcher] macOS 등록 실패(빌드는 계속):', e.message);
  }
  process.exit(0);
}

if (process.platform !== 'win32') {
  process.exit(0); // Windows/macOS 외 OS — 조용히 통과
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
