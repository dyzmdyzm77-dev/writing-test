// claudebridge:// 프로토콜을 이 PC에 자동 등록한다 (npm install / npm run build에 포함).
// 새 PC에 플러그인을 설치하려면 어차피 npm을 한 번 돌려야 하므로, 그 순간에 등록이 끝난다
// → vbs/bat을 따로 더블클릭할 필요 없음. HKCU라 관리자 권한 불필요. 실패해도 빌드는 계속(fail-soft).
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  process.exit(0); // Windows 전용 — 다른 OS에선 조용히 통과
}

const launcher = path.join(__dirname, '..', 'claude-bridge-silent.vbs');
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
