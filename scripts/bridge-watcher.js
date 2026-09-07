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
// 캐시 5초 — 로그인 직후 새 계정이 곧바로 잡혀야 플러그인이 로그인 화면에서 홈으로 넘어간다(30초면 너무 늦음)
let accountCache = { at: 0, email: null };
// 실제 로그인 여부는 자격증명 파일로 판단한다 — ~/.claude.json의 oauthAccount는 **로그아웃해도 남는다**
// (실측: claude auth status는 loggedIn:false인데 그 필드는 그대로 → 플러그인이 로그인된 것처럼 표시했다).
// 파일만 읽으므로 비용 0. claude auth status가 정확하지만 프로세스를 띄워야 해서 조회마다 쓰기엔 무겁다.
function hasClaudeCredentials() {
  try {
    const f = path.join(os.homedir(), '.claude', '.credentials.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && j.claudeAiOauth && j.claudeAiOauth.accessToken) return true;
  } catch (_e) { /* 파일 없음·못 읽음 — 맥이면 키체인을 마저 본다 */ }
  // **맥은 자격증명을 파일이 아니라 키체인에 넣는다** (2026-08 실측, 다리 v41 / 감시자 v6).
  // 맥의 Claude Code는 ~/.claude/.credentials.json을 아예 만들지 않고 키체인 항목
  // 'Claude Code-credentials'에 저장한다 → 파일만 보면 멀쩡히 로그인된 맥이 늘 '로그인 안 됨'이 되고,
  // 로그인 대기 화면이 영영 돈다(눌러도 CLI가 "이미 로그인됨"으로 즉시 끝나 브라우저조차 안 열린다).
  // **존재만 확인한다(-w 없음)** — 비밀번호 값을 읽으면 키체인 접근 허용 팝업이 뜰 수 있다. 약 30ms.
  // CB_NO_KEYCHAIN=1이면 파일만 본다 (모의 홈으로 '로그인 없음'을 재현하는 테스트용 — 키체인은 HOME을 안 따른다).
  if (process.platform !== 'darwin' || process.env.CB_NO_KEYCHAIN === '1') return false;
  try {
    const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore', timeout: 3000 });
    return r.status === 0;
  } catch (_e) { return false; } // security를 못 부름 = 로그인 안 됨으로 본다
}
function claudeAccount() {
  if (Date.now() - accountCache.at < 5000) return accountCache.email;
  let email = null;
  try {
    if (hasClaudeCredentials()) { // 자격증명이 없으면 남은 이메일은 무시한다
      const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
      email = (j && j.oauthAccount && j.oauthAccount.emailAddress) || null;
    }
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

// 이 PC를 '설치 전(새 PC)' 상태로 되돌린다 — 플러그인 [초기화] 버튼(POST /uninstall)이 부른다.
// register-protocol.js가 설치한 것을 그대로 되돌린다: 감시자 자동시작 + (있으면) 설치 폴더.
// ⚠️ 반드시 HTTP 응답을 먼저 보낸 뒤 호출할 것 — macOS launchctl bootout이 이 프로세스를 즉시 종료시킬 수 있다.
//    그래서 파일(plist·설치 폴더)을 launchctl보다 먼저 지운다 — bootout이 우리를 죽여도 자동시작은 이미 사라진다.
function uninstallSelf() {
  const removed = [];
  try {
    if (process.platform === 'darwin') {
      const LABEL = 'com.claudebridge.watcher';
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
      const inst = path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeBridge');
      try { if (fs.existsSync(plist)) { fs.unlinkSync(plist); removed.push(plist); } } catch (_e) {}
      try { if (fs.existsSync(inst)) { fs.rmSync(inst, { recursive: true, force: true }); removed.push(inst); } } catch (_e) {}
      try { spawnSync('launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'ignore' }); } catch (_e) {}
      try { spawnSync('launchctl', ['remove', LABEL], { stdio: 'ignore' }); } catch (_e) {}
    } else if (process.platform === 'win32') {
      try { spawnSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'ClaudeBridgeWatcher', '/f'], { stdio: 'ignore' }); removed.push('자동시작(ClaudeBridgeWatcher)'); } catch (_e) {}
      try { spawnSync('reg', ['delete', 'HKCU\\Software\\Classes\\claudebridge', '/f'], { stdio: 'ignore' }); removed.push('claudebridge:// 등록'); } catch (_e) {}
      try {
        const inst = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ClaudeBridge');
        if (fs.existsSync(inst)) { fs.rmSync(inst, { recursive: true, force: true }); removed.push(inst); }
      } catch (_e) {}
    }
  } catch (_e) { /* fail-soft — 못 지운 게 있어도 플러그인 쪽 기억 삭제는 이미 끝났다 */ }
  return removed;
}

// 감시자 자신을 새 코드로 다시 띄운다 — POST /restart 가 부른다.
// 왜 필요한가(2026-08 실측): 설치본 파일이 새것이어도 **오래 떠 있던 감시자가 옛 코드의 다리를 계속 켜는**
// 상태가 있었다(파일 v41 / 켜지는 다리 v22). 이러면 플러그인이 [업데이트 필요]로 다리를 껐다 켜도
// 켜 주는 쪽이 그대로라 영원히 옛 버전이고, 재시작마다 워밍업(구독 사용량)만 나갔다.
// 그래서 "다리만 껐다 켜기"로 안 풀리면 켜 주는 감시자부터 새로 띄운다. 감시자는 claude를 안 물어 비용 0.
// 순서 주의: 새 인스턴스가 먼저 뜨면 포트를 못 잡는데, 아래 listen 재시도가 우리가 빠질 때까지 기다려 준다.
function restartSelf() {
  try {
    if (process.platform === 'win32') {
      const vbs = path.join(ROOT, 'claude-watcher-silent.vbs');
      if (fs.existsSync(vbs)) {
        const p = spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true });
        p.unref();
      } else {
        // vbs가 없으면 node를 직접 — 창 안 뜨게 하는 규칙은 다리 스폰과 같다(windowsHide, detached 금지)
        const p = spawn(process.execPath, [__filename], { stdio: 'ignore', windowsHide: true });
        p.unref();
      }
      return;
    }
    // macOS: launchd가 우리를 관리한다 — kickstart -k가 껐다 켜 준다(우리를 죽이므로 아래 exit까지 안 올 수도 있다)
    const uid = process.getuid();
    const r = spawnSync('launchctl', ['kickstart', '-k', 'gui/' + uid + '/com.claudebridge.watcher'], { stdio: 'ignore' });
    if (r.status !== 0) {
      const p = spawn(process.execPath, [__filename], { detached: true, stdio: 'ignore' });
      p.unref();
    }
  } catch (_e) { /* fail-soft — 못 띄웠으면 다음 로그인 자동시작이 살린다 */ }
}

// ── 설치본 자동 갱신 (POST /update) ──────────────────────────────────────
// 왜 필요한가(2026-09): 설치 파일로만 세팅한 PC는 설치본이 그 시점 코드로 굳는다. 감시자는 **자기 폴더의**
// 다리를 켜므로, 플러그인이 [업데이트 필요]를 감지해 껐다 켜도 또 같은 옛 코드가 올라온다 — 빠져나갈 길이 없다.
// 새 코드를 어디서 구하나: **플러그인이 이미 갖고 있다.** 빌드가 자기완결 설치 파일(클로드-커넥터.bat)을
// code.js에 base64로 심어 두므로(INSTALLER 마커), 플러그인이 그걸 통째로 보내면 여기서 섹션을 풀어 파일만 갈면 된다.
// 네트워크·사용자 클릭이 필요 없다(사내 프록시도 안 탄다).
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 40 * 1024 * 1024) { s = ''; req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (_e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
// 커넥터 zip에서 파일을 꺼낸다 — 무압축(stored)만 지원하므로 외부 라이브러리·zlib이 필요 없다.
// (빌드의 zipFiles가 stored로만 만든다. 압축된 항목이 오면 그 항목은 건너뛴다.)
function unzipStored(buf) {
  const files = {};
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    if (method === 0) files[name] = buf.slice(start, start + size);
    i = start + size;
  }
  return files;
}
// 설치본 파일을 새 코드로 교체한다. 바뀐 파일 이름 목록을 돌려준다(같으면 안 쓴다 — 멱등).
function applyInstaller(installerB64) {
  const zip = Buffer.from(String(installerB64 || '').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  const f = unzipStored(zip);
  const parts = [
    { name: '다리',   buf: f['scripts/claude-bridge.js'],  dst: path.join(__dirname, 'claude-bridge.js') },
    { name: '감시자', buf: f['scripts/bridge-watcher.js'], dst: path.join(__dirname, 'bridge-watcher.js') },
    { name: '설치',   buf: f['scripts/register-protocol.js'], dst: path.join(__dirname, 'register-protocol.js') },
    { name: '예시',   buf: f['recommend-examples.md'],     dst: path.join(ROOT, 'recommend-examples.md') },
    { name: '가이드', buf: f['ux-writing.md'],             dst: path.join(ROOT, 'ux-writing.md') },
  ].filter((p) => p.buf && p.buf.length);
  if (!parts.length) throw new Error('설치 파일에서 코드를 찾지 못했어요');
  const changed = [];
  let watcherChanged = false;
  for (const p of parts) {
    let same = false;
    try { same = fs.existsSync(p.dst) && Buffer.compare(fs.readFileSync(p.dst), p.buf) === 0; } catch (_e) {}
    if (same) continue;
    fs.mkdirSync(path.dirname(p.dst), { recursive: true });
    fs.writeFileSync(p.dst, p.buf); // 바이트 그대로 — 인코딩 변환 금지
    changed.push(p.name);
    if (p.name === '감시자') watcherChanged = true;
  }
  const bridgeSrc = parts.filter((p) => p.name === '다리')[0];
  const vm = bridgeSrc ? bridgeSrc.buf.toString('utf8').match(/const BRIDGE_V = (\d+)/) : null;
  return { changed, watcherChanged, bridgeV: vm ? Number(vm[1]) : null };
}

// 다리(11888)가 떠 있으면 끈다 — 초기화 시 남은 세션 정리 (없으면 조용히 실패)
function shutdownBridge() {
  try {
    const r = http.request({ host: '127.0.0.1', port: 11888, path: '/shutdown', method: 'POST', timeout: 1500 }, () => {});
    r.on('error', () => {});
    r.on('timeout', () => { try { r.destroy(); } catch (_e) {} });
    r.end();
  } catch (_e) {}
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
  if (req.url === '/health') {
    // v: 감시자 코드 버전 — 구버전 프로세스가 계속 돌고 있는지 밖에서 확인하는 용도
    // (v2 = 창 숨김 수정판, v3 = /account 추가판, v4 = /uninstall 추가판,
    //  v5 = 계정을 자격증명 유무로 판정 — 로그아웃 뒤 남은 이메일을 로그인으로 오해하지 않게,
    //  v6 = 맥은 자격증명이 키체인에 있어 파일 검사만으로는 '로그인 안 됨'이 되던 것 대응,
    //  v7 = /restart 추가 + 포트 재시도 — 옛 감시자가 옛 다리를 계속 켜던 것 대응,
    //  v8 = /update 추가 — 플러그인이 들고 있는 설치 파일로 설치본을 스스로 갱신,
    //  v9 = /update 입력을 bat 페이로드에서 **커넥터 zip**으로 교체 (백신 오탐 회피))
    return json(res, 200, { ok: true, watcher: true, v: 9 });
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
  // 감시자를 새 코드로 다시 띄운다 — 다리를 껐다 켜도 계속 옛 버전이 켜질 때(위 restartSelf 주석) 쓴다.
  // 응답을 먼저 보낸 뒤 새 인스턴스를 띄우고 우리는 빠진다 — 새 쪽은 포트가 빌 때까지 재시도한다.
  if (req.method === 'POST' && req.url === '/restart') {
    json(res, 200, { ok: true, restarting: true, v: 9 });
    setTimeout(() => {
      shutdownBridge(); // 옛 코드로 떠 있는 다리도 같이 내린다 — 다음 요청 때 새 감시자가 새 코드로 켠다
      restartSelf();
      setTimeout(() => process.exit(0), 300);
    }, 200);
    return;
  }
  // 설치본 자동 갱신 — 플러그인이 자기가 들고 있는 설치 파일(base64)을 보내면 그 코드로 갈아끼운다.
  // 저장소에서 돌고 있으면 거절한다: 소스 폴더를 빌드 산출물로 덮어쓰면 작업 중인 코드가 날아간다
  // (저장소 PC는 npm run build의 sync-install.js가 담당한다).
  if (req.method === 'POST' && req.url === '/update') {
    const body = await readBody(req);
    if (fs.existsSync(path.join(ROOT, 'package.json'))) {
      return json(res, 200, { ok: false, reason: 'repo', dir: ROOT });
    }
    let r;
    try { r = applyInstaller(body && body.installer); }
    catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    console.log('[watcher] 설치본 갱신 — 바뀐 파일:', r.changed.join(', ') || '(없음)', '다리 v' + r.bridgeV);
    json(res, 200, { ok: true, changed: r.changed, bridgeV: r.bridgeV, watcherChanged: r.watcherChanged, dir: ROOT });
    if (!r.changed.length) return; // 이미 최신 — 떠 있는 다리를 굳이 끊지 않는다
    setTimeout(() => {
      shutdownBridge(); // 옛 코드로 떠 있는 다리를 내린다 — 다음 /wake가 새 코드로 켠다
      if (r.watcherChanged) { restartSelf(); setTimeout(() => process.exit(0), 300); } // 우리도 새 코드로
    }, 200);
    return;
  }
  // 초기화 — 이 PC를 '새 PC' 상태로 되돌린다 (플러그인 [초기화] 버튼).
  // 응답을 먼저 흘려보낸 뒤 정리한다 — bootout이 우리를 즉시 죽여도 회신은 도착한다.
  if (req.method === 'POST' && req.url === '/uninstall') {
    json(res, 200, { ok: true, platform: process.platform });
    setTimeout(() => {
      shutdownBridge();
      const removed = uninstallSelf();
      console.log('[watcher] 초기화(uninstall) — 제거:', removed.join(', ') || '(없음)');
      setTimeout(() => process.exit(0), 200);
    }, 250);
    return;
  }
  return json(res, 404, { error: 'Not found' });
});

// 포트가 잡혀 있으면 잠깐 기다렸다 다시 시도하고, 그래도 안 되면 조용히 종료
// (자동 시작 + npm build 중복 실행 대비). 재시도가 필요한 이유: /restart는 새 인스턴스를 먼저 띄우고
// 옛 인스턴스가 빠지므로, 첫 시도에서 물러나 버리면 아무도 안 남는다.
let bindTries = 0;
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE' && bindTries < 6) {
    bindTries++;
    setTimeout(() => server.listen(PORT, '127.0.0.1'), 1000);
    return;
  }
  if (e && e.code === 'EADDRINUSE') process.exit(0);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('[watcher] 클로드 다리 감시자 켜짐 — http://localhost:' + PORT);
});
// IPv6 루프백(::1)에도 함께 듣는다 — 'localhost'가 ::1로 먼저 해석되는 환경에서
// 피그마 fetch가 IPv4로 폴백하지 않아 다리 깨우기·계정 조회가 조용히 실패하던 문제 대응(다리와 동일).
const server6 = http.createServer(server.listeners('request')[0]);
// ::1을 못 잡아도(EADDRINUSE·IPv6 없음) IPv4만으로 계속 동작 — 다만 /restart 직후엔 옛 인스턴스가
// 아직 ::1을 물고 있어 첫 시도가 실패한다. 'localhost'가 ::1로 먼저 풀리는 환경에서 그대로 두면
// 피그마 fetch가 조용히 실패하므로 IPv4와 같은 횟수만큼 재시도한다.
let bindTries6 = 0;
server6.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE' && bindTries6 < 6) {
    bindTries6++;
    setTimeout(() => server6.listen(PORT, '::1'), 1000);
  }
});
server6.listen(PORT, '::1');
