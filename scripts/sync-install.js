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

  // 2) 감시자를 다시 띄운다 — 파일이 바뀌었거나, 켜져 있는 다리가 낡았을 때.
  //    ⚠️ 감시자 버전만 보고 판단하면 안 된다(2026-08 실측): 설치본 파일이 v41인데 **오래 떠 있던 감시자가
  //    옛 코드(v22)의 다리를 계속 켜는** 상태가 있었다. 감시자 버전은 최신이라 예전 규칙은 건너뛰었고,
  //    다리만 껐다 켜니 켜 주는 쪽이 그대로여서 영원히 옛 버전 + 재시작마다 워밍업(구독 사용량)만 나갔다.
  //    감시자는 claude를 안 물어 재기동 비용이 0이므로, 의심스러우면 그냥 새로 띄운다.
  const wantW = readNum(path.join(REPO, 'scripts/bridge-watcher.js'), WATCHER_V_RE);
  const wantB = readNum(path.join(REPO, 'scripts/claude-bridge.js'), BRIDGE_V_RE);
  const w = await health(11889, 2000);
  const b0 = await health(11888, 2000);
  const bridgeOld = !!(b0 && wantB && !(typeof b0.v === 'number' && b0.v >= wantB));
  const watcherOld = !!(w && wantW && typeof w.v === 'number' && w.v < wantW);

  if (!w) {
    startWatcher(dir); // 안 떠 있으면 그냥 띄운다(이미 떠 있으면 EADDRINUSE로 조용히 물러남)
  } else if (watcherOld || copied.length || bridgeOld) {
    const why = watcherOld ? '감시자 v' + w.v + ' → v' + wantW
      : bridgeOld ? '켜져 있는 다리가 v' + (b0.v || '?') + ' (옛 코드를 켜는 감시자일 수 있음)'
        : '설치본 파일이 바뀜';
    console.log('[sync] 감시자 재기동 — ' + why);
    if (typeof w.v === 'number' && w.v >= 7) {
      await post(11889, '/restart', 3000); // v7+: 스스로 새 코드로 다시 뜬다(다리도 같이 내린다)
    } else {
      await post(11889, '/shutdown', 3000);
      await sleep(1000);
      startWatcher(dir);
    }
    // 새 감시자는 옛 인스턴스가 포트를 놓을 때까지 재시도하므로 **한 번만 확인하면 안 된다**
    // (실측: 3초 뒤 조회에서 안 잡혀 "감시자가 안 떠 있음"이라고 잘못 알렸는데 그 직후 정상 기동).
    let w2 = null;
    for (let i = 0; i < 10 && !w2; i++) {
      await sleep(1000);
      w2 = await health(11889, 1500);
    }
    if (!w2) { // 못 살아났으면 직접 띄워 본다 — 아무도 안 남는 상태가 최악이다
      startWatcher(dir);
      for (let i = 0; i < 5 && !w2; i++) {
        await sleep(1000);
        w2 = await health(11889, 1500);
      }
    }
    console.log(w2 ? '[sync] 감시자 v' + w2.v + ' 준비됨' : '[sync] 감시자가 안 떠 있음 — 다음 로그인 자동시작이 살립니다');
  }

  // 3) 떠 있는 다리가 낡았으면 내린다 — 다음 요청 때 감시자가 새 코드로 켠다.
  //    여기서 미리 켜지 않는 이유: 워밍업이 클로드를 실제 호출해 구독 사용량이 나간다.
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
