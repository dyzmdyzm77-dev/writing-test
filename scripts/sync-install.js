// 저장소의 최신 코드를 이 PC의 '설치본' 폴더로 옮기고, 낡은 다리·감시자를 재기동한다.
// (npm run build에 포함 — 받기만 하고 갱신을 잊는 일을 없애려고 붙였다.)
//
// 왜 필요한가: 저장소를 git pull해도 실제로 돌아가는 건 설치본
// (win32 %LOCALAPPDATA%\ClaudeBridge / darwin ~/Library/Application Support/ClaudeBridge)이라
// 파일이 안 따라온다. 게다가 파일을 복사해도 '이미 떠 있는 다리는 옛 코드 그대로'여서
// 껐다 켜지 않으면 새 동작이 안 나온다(CLAUDE.md 구버전 다리 감지). 실제로 설치본 파일이
// v40인데 돌고 있는 건 v22인 상태가 발견됐다 — 그래서 복사와 재기동을 한 묶음으로 한다.
//
// 설치본이 없는 PC(저장소만 쓰는 개발 PC)에서는 조용히 통과한다. 실패해도 빌드는 계속(fail-soft).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
// 설치본에 들어가는 파일 — 클로드-커넥터(설치 파일)가 넣는 것과 같은 구성
const FILES = [
  'scripts/claude-bridge.js',
  'scripts/bridge-watcher.js',
  'recommend-examples.md',
  'ux-writing.md',
  'claude-bridge-silent.vbs',
  'claude-watcher-silent.vbs',
];

function installDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA;
    return base ? path.join(base, 'ClaudeBridge') : null;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeBridge');
  }
  return null;
}

// 파일에서 버전 숫자를 뽑는다 — 없으면 null(비교를 건너뛴다)
function readNum(file, re) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(re);
    return m ? Number(m[1]) : null;
  } catch (_e) {
    return null;
  }
}
const BRIDGE_V_RE = /const\s+BRIDGE_V\s*=\s*(\d+)/;
const WATCHER_V_RE = /watcher:\s*true,\s*v:\s*(\d+)/;

async function health(port, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // localhost라 프록시 환경변수는 타지 않는다(--use-env-proxy 없이 그대로 쓴다)
    const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function post(port, route, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch('http://127.0.0.1:' + port + route, { method: 'POST', signal: ac.signal });
    return res.ok;
  } catch (_e) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 감시자를 띄운다 — 창이 안 뜨는 경로만 쓴다(CLAUDE.md: 창 안 뜨게 하는 규칙)
function startWatcher(dir) {
  try {
    if (process.platform === 'win32') {
      const p = spawn('wscript.exe', [path.join(dir, 'claude-watcher-silent.vbs')], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      p.unref();
      return true;
    }
    const uid = process.getuid();
    const r = spawnSync('launchctl', ['kickstart', '-k', 'gui/' + uid + '/com.claudebridge.watcher'], { stdio: 'ignore' });
    return r.status === 0;
  } catch (_e) {
    return false;
  }
}

async function main() {
  const dir = installDir();
  if (!dir || !fs.existsSync(dir)) {
    console.log('[sync] 설치본 폴더가 없어 건너뜀 (저장소로만 쓰는 PC)');
    return;
  }

  // 1) 달라진 파일만 복사
  const copied = [];
  for (const rel of FILES) {
    const src = path.join(REPO, rel);
    const dst = path.join(dir, rel);
    if (!fs.existsSync(src)) continue;
    try {
      const a = fs.readFileSync(src);
      const same = fs.existsSync(dst) && Buffer.compare(a, fs.readFileSync(dst)) === 0;
      if (same) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, a); // 바이트 그대로 — vbs의 UTF-16LE도 보존된다
      copied.push(rel);
    } catch (e) {
      console.log('[sync] 복사 실패 ' + rel + ': ' + e.message);
    }
  }
  console.log(copied.length ? '[sync] 설치본 갱신 ' + copied.length + '개: ' + copied.join(', ') : '[sync] 설치본은 이미 최신');

  // 2) 떠 있는 감시자가 낡았으면 재기동
  const wantW = readNum(path.join(REPO, 'scripts/bridge-watcher.js'), WATCHER_V_RE);
  const w = await health(11889, 2000);
  if (w && wantW && typeof w.v === 'number' && w.v < wantW) {
    console.log('[sync] 감시자 v' + w.v + ' → v' + wantW + ' 재기동');
    await post(11889, '/shutdown', 3000);
    await sleep(1000);
    startWatcher(dir);
    await sleep(2000);
  } else if (!w) {
    startWatcher(dir); // 안 떠 있으면 그냥 띄운다(이미 떠 있으면 EADDRINUSE로 조용히 물러남)
  }

  // 3) 떠 있는 다리가 낡았으면 내린다 — 다음 요청 때 감시자가 새 코드로 켠다.
  //    여기서 미리 켜지 않는 이유: 워밍업이 클로드를 실제 호출해 구독 사용량이 나간다.
  const wantB = readNum(path.join(REPO, 'scripts/claude-bridge.js'), BRIDGE_V_RE);
  const b = await health(11888, 2000);
  if (b && wantB && !(typeof b.v === 'number' && b.v >= wantB)) {
    console.log('[sync] 다리 v' + (b.v || '?') + ' → v' + wantB + ' — 내림(다음 요청 때 새 코드로 켜짐)');
    await post(11888, '/shutdown', 5000);
  } else if (b) {
    console.log('[sync] 다리 v' + b.v + ' — 이미 최신');
  }
}

main().catch((e) => {
  console.log('[sync] 건너뜀(빌드는 계속): ' + e.message);
});
