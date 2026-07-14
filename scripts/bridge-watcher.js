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
function hasClaude() {
  try { return spawnSync('where', ['claude'], { stdio: 'ignore', shell: true }).status === 0; } catch (_e) { return false; }
}

let waking = false; // 연타 방지 — 다리는 어차피 EADDRINUSE로 중복 정리하지만 프로세스 낭비를 줄인다
function wakeBridge() {
  if (waking) return;
  waking = true;
  setTimeout(() => { waking = false; }, 5000);
  const proc = spawn('cmd', ['/c', 'node', 'scripts\\claude-bridge.js'], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  });
  proc.unref(); // 감시자가 죽어도 다리는 남게 분리
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
  if (req.url === '/health') {
    return json(res, 200, { ok: true, watcher: true });
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
