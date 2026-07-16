// 클로드 다리 감시자 — 항상 떠 있는 초소형 서버 (localhost:11889)
// ─────────────────────────────────────────────────────────────
// 왜 필요한가: 피그마가 플러그인의 claudebridge:// 열기(window.open/iframe/openExternal)를
// 전부 소리 없이 막는 버전이 있다. fetch는 못 막으므로, 플러그인이 이 감시자에게
// POST /wake 를 보내면 감시자가 다리(claude-bridge.js)를 대신 켠다.
//
// 다리와의 차이: 감시자는 claude를 물지 않는다(자식 없음) → 클로드 앱 업데이트를 안 막고,
// 메모리 ~15MB라 로그인 시 자동 시작으로 상시 켜둬도 부담 없다 (등록: npm run build).
// 다리는 심장박동 끊기면 죽지만(플러그인과 생사 동기화), 감시자는 계속 남아 다음 깨우기를 받는다.

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const PORT = 11889;
const ROOT = path.join(__dirname, '..'); // 저장소 루트 — 다리가 recommend-examples.md를 찾는 기준

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function json(res, status, obj) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS));
  res.end(JSON.stringify(obj));
}

// claude CLI가 있는지 — 없으면 /wake 응답에 실어 플러그인이 안내할 수 있게 한다
// 로그인된 계정 읽기 — CLI가 ~/.claude.json에 기록하는 oauthAccount.emailAddress (다리의 claudeAccount와 같은 출처).
// 파일이 클 수 있어 30초 캐시. 재로그인하면 CLI가 파일을 갱신하므로 자동 반영된다.
let accountCache = { at: 0, email: null };
function claudeAccount() {
  if (Date.now() - accountCache.at < 30000) return accountCache.email;
  let email = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    email = (j && j.oauthAccount && j.oauthAccount.emailAddress) || null;
  } catch (_e) { /* 로그인 이력 없음 등 — null */ }
  accountCache = { at: Date.now(), email };
  return email;
}

function hasClaude() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try { return spawnSync(finder, ['claude'], { stdio: 'ignore', shell: true }).status === 0; } catch (_e) { return false; }
}

let waking = false; // 연타 방지 — 다리는 어차피 EADDRINUSE로 중복 정리하지만 프로세스 낭비를 줄인다
function wakeBridge() {
  if (waking) return;
  waking = true;
  setTimeout(() => { waking = false; }, 5000);
  let proc;
  if (process.platform === 'win32') {
    // Windows: cmd·vbs 경유 없이 node를 직접, windowsHide(CREATE_NO_WINDOW)로 스폰 —
    // 창 없는 숨은 콘솔이 만들어지고 다리의 자식(claude)도 그 콘솔을 물려받아 어떤 창도 안 뜬다.
    // detached는 쓰지 않는다(detached+windowsHide 조합은 콘솔 창이 노출됨 — 실측).
    // Windows에선 detached 없이도 부모(감시자)가 죽어도 자식은 살아남는다.
    proc = spawn(process.execPath, [path.join(__dirname, 'claude-bridge.js')], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true,
    });
  } else {
    // macOS/리눅스: 감시자를 띄운 node 실행 파일로 직접 스폰 (launchd 환경엔 PATH가 빈약할 수 있어 절대경로 사용)
    proc = spawn(process.execPath, [path.join(__dirname, 'claude-bridge.js')], {
      cwd: ROOT, detached: true, stdio: 'ignore',
    });
  }
  proc.unref(); // 감시자 이벤트 루프에서 분리 (감시자 종료를 막지 않게)
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
  if (req.url === '/health') {
    // v: 감시자 코드 버전 — 구버전 프로세스가 계속 돌고 있는지 밖에서 확인하는 용도
    // (v2 = 창 숨김 수정판, v3 = /account 추가판)
    return json(res, 200, { ok: true, watcher: true, v: 3 });
  }
  // 이 PC에 로그인된 클로드 계정 — 플러그인 첫 화면·홈이 "누구 계정으로 쓰는지" 보여주는 데 쓴다.
  // 감시자가 답하는 이유: 다리를 켜면 워밍업으로 클로드가 실제 호출돼 구독 사용량이 나간다.
  // 감시자는 파일만 읽으므로 사용량 0 · 대기 0 — 검토만 쓰는 사람에게 비용을 물리지 않는다.
  // 주의: 여기 계정이 보여도 입장권이 만료됐을 수 있다(유효성은 실제 호출 때만 알 수 있음 — 다리 /health의 problem 참고).
  if (req.url === '/account') {
    return json(res, 200, { ok: true, account: claudeAccount(), claude: hasClaude() });
  }
  if (req.method === 'POST' && req.url === '/wake') {
    if (!hasClaude()) return json(res, 200, { ok: false, problem: 'claude-missing' });
    wakeBridge();
    return json(res, 200, { ok: true, waking: true });
  }
  if (req.method === 'POST' && req.url === '/shutdown') {
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 200);
    return;
  }
  return json(res, 404, { error: 'Not found' });
});

// 이미 떠 있으면 조용히 종료 (자동 시작 + npm build 중복 실행 대비)
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') process.exit(0);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('[watcher] 클로드 다리 감시자 켜짐 — http://localhost:' + PORT);
});
