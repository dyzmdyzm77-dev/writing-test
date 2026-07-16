// 클로드 다리(Claude Bridge) — 피그마 플러그인과 Claude Code를 잇는 로컬 심부름꾼
// ─────────────────────────────────────────────────────────────
// 사용법: 클로드다리-켜기.bat 더블클릭 (또는 npm run bridge)
// 켜두면 플러그인의 [추천받기]가 Gemini 키 없이도 클로드로 AI 추천을 받는다.
//
// 속도 설계: 클로드를 요청마다 새로 시동하면 30~40초가 그냥 날아간다.
// → 다리를 켤 때 클로드 세션을 하나 열어 상시 대기시키고(stream-json 대화 모드),
//   가이드+예시(111건)는 첫 메시지로 한 번만 읽힌다. 이후 요청은 문구만 보내므로 빠르다.
// 세션은 30번 쓰면 재시작해 대화가 무한히 길어지는 것을 막는다.
//
// 전제: 이 PC에 Claude Code가 설치·로그인돼 있을 것 (claude --version 으로 확인)
// 주의: 사용량은 각자 클로드 구독 한도에서 차감된다.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// 클로드를 빈 폴더에서 실행 — 저장소에서 실행하면 프로젝트 맥락(CLAUDE.md 등)을
// 매 턴 짊어져서 45초/턴까지 느려진다 (빈 폴더 + 부가기능 차단이면 ~3초/턴).
const EMPTY_CWD = path.join(os.tmpdir(), 'claude-bridge-cwd');
try { fs.mkdirSync(EMPTY_CWD, { recursive: true }); } catch (_e) { /* 무시 */ }
const CLAUDE_ENV = Object.assign({}, process.env, {
  MAX_THINKING_TOKENS: '0',                    // 생각 모드 끔 (짧은 문구엔 불필요)
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', // 턴 요약 등 부가 호출 끔
  DISABLE_TELEMETRY: '1',
});

const PORT = Number(process.env.BRIDGE_PORT) || 11888; // BRIDGE_PORT는 테스트용 (평소엔 11888 고정)
// 기본 모델. 요청(플러그인)이 model을 지정하면 그 요청만 그 모델로 처리한다.
// haiku=빠름/가벼움, sonnet=중간, opus=기본(최고품질, 조금 느림)
const CLAUDE_MODEL = process.env.BRIDGE_MODEL || 'opus';
const ALLOWED_MODELS = ['haiku', 'sonnet', 'opus'];
const TURN_TIMEOUT_MS = 90000;   // 요청 1건 제한시간
const MAX_TURNS = 30;            // 이만큼 쓰면 세션 재시작 (대화 누적 방지)

// ── 예시 사전 로드 (recommend-examples.md — build-glossary.js와 같은 파서) ──
function loadExamples() {
  try {
    const md = fs.readFileSync(path.join(__dirname, '..', 'recommend-examples.md'), 'utf8');
    const secIdx = md.search(/^## 추천 예시\s*$/m);
    if (secIdx === -1) return [];
    const examples = [];
    let cur = null;
    for (const raw of md.slice(secIdx).split('\n')) {
      const line = raw.replace(/\s+$/, '');
      const h = line.match(/^###\s+(.+?)\s*$/);
      if (h) { cur = { input: h[1], suggestions: [] }; examples.push(cur); continue; }
      const b = line.match(/^\s*-\s+(.+?)\s*$/);
      if (b && cur) cur.suggestions.push(b[1].split(' / ').join(' '));
    }
    return examples.filter((e) => e.suggestions.length > 0);
  } catch (e) {
    console.log('[bridge] 예시 사전 로드 실패 (없이 진행):', e.message);
    return [];
  }
}

// ── 지시문 (서버 recommend와 같은 규칙 — 바꾸면 그쪽도 함께) ──
const STYLE_RULES = [
  '1. 해요체: 모든 문구는 해요체로. (보냅니다→보내요)',
  '2. 능동적 말하기: 됐어요→했어요, ~었 빼기(바뀌었어요→바꿨어요). 단, 종료·만료·연체·해지·기록·녹음 등 시스템이 주체인 결과는 수동형 유지(연체돼요, 녹음돼요).',
  '3. 긍정적 말하기: "~할 수 없어요" 대신 "~하면 할 수 있어요" 구조 우선. 단, 정책상 불가·일부 기능 제한·되돌릴 수 없는 결과·정보 보호 안심은 부정형으로 명확히.',
  '4. 캐주얼한 경어: ~하시겠어요?→~할까요?, 계시다→있다, 여쭈다→확인하다, 께→에게. ~시 빼기가 어색하면 파악하려는 정보를 주어로 문장을 다시 쓴다.',
  '5. 명사+명사 금지: 한자어를 풀어 동사로(이자 환불을 받았어요→이자를 돌려받았어요), 최소한 {명사}가 {명사}해서 형태로(잔액 부족으로→잔액이 부족해서).',
  '6. 표기: 되어요→돼요.',
  '7. 줄 구조: 원본이 한 줄이면 추천도 반드시 한 줄로. 임의로 줄을 늘리지 않는다. 단, 여러 문장을 하나의 긍정형 문장으로 합쳐 더 간결해진다면 줄 수를 줄이는 것은 환영.',
  '8. 다이얼로그 왼쪽 버튼 라벨은 "닫기"(취소 금지).',
  '9. 이름·전화번호·마스킹은 그대로 보존. 사람을 부를 땐 님을 붙여도 좋다.',
  '10. 제품 용어 유지: 입력에 쓰인 기능성 명사(변경, 지정, 등록, 해제 등)는 화면의 기능명·버튼명일 가능성이 높으므로 쉬운 말로 바꾸지 않는다. 시스템 동작과 다른 동사를 새로 만들지 않는다.',
].join('\n');

const EXAMPLES = loadExamples();

function instructionMessage() {
  const fewShot = EXAMPLES.map((ex) => 'Input: ' + JSON.stringify(ex.input) + '\nOutput: ' + JSON.stringify(ex.suggestions)).join('\n');
  return (
    '지금부터 너는 에스원(S-1, 보안회사)의 한국어 UX Writing 전문가로 일한다. ' +
    '내가 UI 문구를 하나씩 보내면, 아래 스타일 규칙에 맞게 다듬은 대안 3개를 제안하라.\n' +
    '요청들은 서로 무관한 별개 문구다 — 이전 문구를 참조하지 마라.\n' +
    '원래 의미와 모든 정보(이름·숫자·조건·대상)를 유지하고, 각 제안은 원본과도 서로와도 달라야 한다.\n' +
    '답은 반드시 JSON 배열만 출력한다. 마크다운·설명·코드펜스 금지:\n' +
    '[{"text": "제안 문구 (줄바꿈은 \\n)", "reason": "무엇을 왜 바꿨는지 한국어 한 문장"}, ...]\n\n' +
    '[스타일 규칙]\n' + STYLE_RULES + '\n\n' +
    (fewShot ? '[우리 목소리 예시 — 이 톤을 따를 것]\n' + fewShot + '\n\n' : '') +
    '준비됐으면 "OK"라고만 답하라.'
  );
}

// ── 상시 대기 클로드 세션 ────────────────────────────────────
let proc = null;          // 클로드 프로세스
let lineBuf = '';         // stdout 줄 버퍼
let waiter = null;        // 현재 턴의 { resolve, reject, timer }
let queue = Promise.resolve(); // 요청 직렬화 (동시 요청은 순서대로)
let turns = 0;
let warmedUp = false;
let currentModel = CLAUDE_MODEL; // 지금 세션이 물고 있는 모델 (요청이 다른 모델을 지정하면 세션 재시작)
// 시작 시 Claude Code(claude CLI)가 쓸 수 있는지 점검 — 없으면 /health로 알려 플러그인이 안내한다.
// null=확인 중, 'ok'=사용 가능, 'claude-missing'=claude 명령 없음,
// 'claude-logout'=claude는 있지만 로그인 세션 만료 (턴 실패 시 감지, 성공 턴이 오면 자동 해제)
let claudeStatus = null;
// 로그인 만료 감지 — CLI가 내는 영어 인증 오류를 사람이 알아들을 안내로 바꾼다.
// (claude --version은 로그인 없이도 성공해서 시동 점검으로는 못 잡고, 실제 턴에서만 드러난다)
// "만료"만이 아니라 "한 번도 로그인 안 함"도 같은 경로로 잡히므로 중립 표현을 쓴다
const LOGIN_GUIDE = '클로드 로그인이 필요해요(안 됐거나 만료) — [🟠 클로드 로그인 필요] 버튼을 누르면 로그인 창을 열어드려요.';
// 실측한 문구들: "Failed to authenticate: OAuth session expired and could not be refreshed"(만료),
// "Not logged in · Please run /login"(미로그인) — 둘 다 잡히게 넓힌다
function isAuthError(s) {
  return /authenticat|oauth|api key|log ?in|logged|session expired/i.test(String(s));
}
// 로그인된 계정 확인 — CLI가 ~/.claude.json에 기록하는 oauthAccount.emailAddress를 읽어
// /health로 노출한다 (플러그인이 "누구 계정으로 쓰는 중인지" 표시 — 공용 PC에서 남의 계정 오사용 방지).
// 파일이 클 수 있어(프로젝트 이력 포함) 30초 캐시. 재로그인하면 CLI가 파일을 갱신하므로 자동 반영된다.
let accountCache = { at: 0, email: null };
function claudeAccount() {
  if (Date.now() - accountCache.at < 30000) return accountCache.email;
  let email = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    email = (j && j.oauthAccount && j.oauthAccount.emailAddress) || null;
  } catch (_e) { /* 로그인 이력 없음 등 — null 유지 */ }
  accountCache = { at: Date.now(), email };
  return email;
}
function checkClaudeAvailable() {
  const probe = spawn('claude', ['--version'], { shell: true, env: CLAUDE_ENV });
  let out = '';
  probe.stdout.on('data', (d) => { out += d.toString(); });
  probe.on('error', () => { claudeStatus = 'claude-missing'; });
  probe.on('close', (code) => {
    claudeStatus = (code === 0 && /\d+\.\d+/.test(out)) ? 'ok' : 'claude-missing';
    console.log('[bridge] Claude Code 점검: ' + claudeStatus + (out ? ' (' + out.trim() + ')' : ''));
  });
}
// 처리 현황 — /health로 노출해 "정말 클로드가 답했는지" 밖에서 확인할 수 있게 한다
const stats = { served: 0, lastAt: '', lastText: '', lastSec: '' };

// ── 플러그인 생존 감지(심장박동) ─────────────────────────────
// 플러그인이 떠 있는 동안 code.ts가 5초마다 POST /heartbeat를 보낸다.
// 한 번이라도 받은 뒤 30초간 끊기면 플러그인(또는 피그마)이 닫힌 것 — 클로드까지 데리고 같이 꺼진다.
// 아직 한 번도 못 받았으면(다리만 먼저 켠 상태, 자동시작 등) 계속 대기한다.
const HEARTBEAT_DEAD_MS = 30000;
let lastBeat = 0;
setInterval(() => {
  if (lastBeat && Date.now() - lastBeat > HEARTBEAT_DEAD_MS) {
    console.log('[bridge] 플러그인 심장박동 끊김 — 피그마/플러그인이 닫힌 것으로 보고 같이 꺼집니다.');
    process.exit(0); // exit 핸들러가 killProc으로 claude 트리를 정리한다
  }
}, 5000);

// 브라우저 로그인 프로세스 (claude auth login --claudeai) — /open-login이 생성·관리.
// 브라우저가 localhost로 결과를 보내줄 때까지 숨어서 대기하다가, 완료되면 스스로 끝난다.
let loginProc = null;
let loginProcTimer = null;
function killLoginProc() {
  if (loginProcTimer) { clearTimeout(loginProcTimer); loginProcTimer = null; }
  if (!loginProc) return;
  const p = loginProc;
  loginProc = null;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-p.pid, 'SIGTERM'); } catch (_e2) { p.kill(); }
    }
  } catch (_e) { /* 무시 */ }
}

function killProc() {
  if (proc) {
    try {
      if (process.platform === 'win32') {
        // shell:true로 띄워서 proc은 cmd 껍데기 — /T로 트리째 죽여야 진짜 claude가 고아로 안 남는다
        // (고아 claude가 설치 파일을 물고 있으면 클로드 앱 업데이트가 "사용 중"으로 막힘)
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        // macOS/리눅스: shell:true라 proc이 sh 껍데기일 수 있음 — startProc의 detached로 만든
        // 프로세스 그룹(-pid)을 통째로 정리한다 (taskkill /T 대응)
        try { process.kill(-proc.pid, 'SIGTERM'); } catch (_e2) { proc.kill(); }
      }
    } catch (_e) { /* 무시 */ }
  }
  proc = null;
  warmedUp = false;
  if (waiter) { clearTimeout(waiter.timer); waiter.reject(new Error('클로드 세션이 종료됐어요.')); waiter = null; }
}

function startProc() {
  killProc();
  lineBuf = '';
  turns = 0;
  console.log('[bridge] 클로드 세션 시동 중… (모델: ' + currentModel + ')');
  const thisProc = spawn('claude', ['-p', '--model', currentModel, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
    shell: true, cwd: EMPTY_CWD, env: CLAUDE_ENV,
    detached: process.platform !== 'win32', // POSIX: 자기 프로세스 그룹 생성 — killProc이 그룹째 정리할 수 있게
  });
  proc = thisProc;
  proc.stdout.on('data', (d) => {
    lineBuf += d.toString('utf8');
    let idx;
    while ((idx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch (_e) { continue; }
      if (ev && ev.type === 'result' && waiter) {
        const w = waiter;
        waiter = null;
        clearTimeout(w.timer);
        if (ev.is_error) {
          const raw = String(ev.result || ev.subtype || '').slice(0, 200);
          if (isAuthError(raw)) {
            claudeStatus = 'claude-logout'; // /health로 플러그인에 알림 → 버튼이 [로그인 필요]로 바뀜
            console.log('[bridge] 클로드 로그인 만료 감지:', raw);
            w.reject(new Error(LOGIN_GUIDE));
          } else {
            w.reject(new Error('클로드 오류: ' + raw));
          }
        } else {
          claudeStatus = 'ok'; // 성공 = 설치·로그인 다 정상 — 어떤 problem이든 해제 (재로그인/재설치 복귀)
          w.resolve(String(ev.result || ''));
        }
      }
    }
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString('utf8').trim();
    if (s && !s.includes('DeprecationWarning')) console.log('[bridge] claude stderr:', s.slice(0, 200));
  });
  proc.on('close', (code) => {
    // 이미 새 세션으로 교체된 뒤 옛 세션이 닫힌 거면 무시 (모델 전환 시 새 세션을 죽이지 않게)
    if (proc !== thisProc) return;
    console.log('[bridge] 클로드 세션 종료 (code ' + code + ') — 다음 요청 때 다시 시동합니다.');
    killProc();
  });
}

function sendTurn(text) {
  return new Promise((resolve, reject) => {
    if (!proc) return reject(new Error('클로드 세션이 없어요.'));
    if (waiter) return reject(new Error('앞선 요청이 진행 중이에요.'));
    const timer = setTimeout(() => {
      console.log('[bridge] 턴 시간 초과 — 세션을 재시작합니다.');
      killProc();
    }, TURN_TIMEOUT_MS);
    waiter = { resolve, reject, timer };
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n', 'utf8');
  });
}

// 같은 문구를 몇 번째 묻는지 기억 — 재요청이면 "이전과 다른 새 제안"을 요구한다
// (안 그러면 클로드가 성실하게 같은 답을 또 내서 [AI 추천 더 받기]가 무의미해진다)
const askedCount = new Map();

// 세션 준비(시동+지시문 주입)를 보장한 뒤 한 턴 실행 — 모든 호출은 queue로 직렬화.
// model을 주면 그 모델로 (다르면 세션 재시작). 한 모델을 계속 쓰면 재시작은 최초 1회뿐.
function runTurn(buildAsk, model) {
  const job = queue.then(async () => {
    if (model && ALLOWED_MODELS.indexOf(model) !== -1 && model !== currentModel) {
      console.log('[bridge] 모델 변경: ' + currentModel + ' → ' + model);
      currentModel = model;
      startProc(); // 새 모델로 세션 재시작 (다음 워밍업에서 지시문 재주입)
    }
    if (turns >= MAX_TURNS || !proc) startProc();
    if (!warmedUp) {
      const t0 = Date.now();
      await sendTurn(instructionMessage());
      warmedUp = true;
      turns++;
      console.log('[bridge] 세션 준비 완료 (' + ((Date.now() - t0) / 1000).toFixed(1) + 's) — 이후 요청은 빨라요.');
    }
    turns++;
    return sendTurn(buildAsk());
  });
  // 한 요청이 실패해도 다음 요청이 이어지도록 큐는 항상 성공으로 정리
  queue = job.catch(() => {});
  return job;
}

// 문구 추천 턴
function askClaude(text, model) {
  return runTurn(() => {
    const attempt = (askedCount.get(text) || 0) + 1;
    askedCount.set(text, attempt);
    if (askedCount.size > 200) askedCount.clear(); // 무한히 쌓이지 않게
    return attempt > 1
      ? '같은 문구를 다시 요청한다. 이 세션에서 이전에 제안했던 것들과 겹치지 않는, 구조나 어휘가 확실히 다른 새로운 대안 3개를 규칙대로 JSON 배열로만: ' + JSON.stringify(text)
      : '다음 UI 문구의 대안 3개를 규칙대로 JSON 배열로만: ' + JSON.stringify(text);
  }, model);
}

// 번역 턴 — 같은 세션을 쓰되, 이번 턴만 추천 형식(JSON 배열) 대신 번역 형식(JSON 객체)을 요구한다
function askTranslate(text, model) {
  return runTurn(() => (
    '이번 요청은 번역 작업이다 (문구 다듬기 아님 — 대안 3개 규칙은 이번 턴에 적용하지 않는다). ' +
    '다음 UI 문구가 한국어면 자연스러운 영어로, 영어면 자연스러운 한국어로 번역하라. ' +
    'UI 문구다운 간결한 표현을 쓰고, 이름·숫자·마스킹·플레이스홀더는 그대로 보존한다. ' +
    '원문의 줄 수를 그대로 유지한다 — 원문이 한 줄이면 번역도 한 줄로, 줄바꿈을 임의로 추가하지 않는다. ' +
    '답은 반드시 JSON 객체 하나만 출력한다. 마크다운·설명 금지: ' +
    '{"translated": "번역문 (줄바꿈은 \\n)", "direction": "ko→en 또는 en→ko"}: ' + JSON.stringify(text)
  ), model);
}

// 번역 응답에서 {translated, direction} 추출 (코드펜스·앞뒤 잡담 허용)
function parseTranslate(raw) {
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try {
    const o = JSON.parse(s);
    const translated = String((o && o.translated) || '').trim();
    if (translated) return { translated, direction: String((o && o.direction) || '').trim() };
  } catch (_e) { /* 아래로 */ }
  return null;
}

// 응답에서 {text, reason} 배열 추출 (코드펜스·앞뒤 잡담 허용)
function parseSuggestions(raw) {
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const m = s.match(/\[[\s\S]*\]/);
  if (m) s = m[0];
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return arr
        .map((x) => ({ text: String((x && x.text) || '').trim(), reason: String((x && x.reason) || '').trim() }))
        .filter((x) => x.text);
    }
  } catch (_e) { /* 아래로 */ }
  return [];
}

// 로그인 필요 상태일 때 /health 조회가 오면 뒤에서 워밍업을 다시 시도해본다 (30초에 1번만).
// 성공하면 결과 핸들러가 claudeStatus='ok'로 되돌리므로, 재로그인 후 버튼이 저절로 🟢으로 복귀한다.
// (플러그인이 로그인 창을 연 뒤 주기적으로 /health를 조회하는 것과 짝을 이룬다)
let lastAuthRetryAt = 0;
function retryAuthIfNeeded() {
  if (claudeStatus !== 'claude-logout') return;
  if (waiter || Date.now() - lastAuthRetryAt < 30000) return; // 진행 중 턴 방해 금지 + 30초 간격
  lastAuthRetryAt = Date.now();
  console.log('[bridge] 로그인 재확인 시도…');
  runTurn(() => '로그인 확인용이다. "OK"라고만 답하라.').then(
    () => console.log('[bridge] 로그인 확인됨 — 정상 상태로 복귀.'),
    (e) => console.log('[bridge] 아직 로그인 안 됨:', String(e.message).slice(0, 80))
  );
}

// 실패 응답을 사람용 안내로 변환 — 원인(로그인/설치)이 파악된 경우엔 그 안내를, 아니면 접두어+원문을 보낸다
function friendlyError(e, prefix) {
  if (e && e.message === LOGIN_GUIDE) return { error: LOGIN_GUIDE, problem: 'claude-logout' };
  if (claudeStatus === 'claude-missing') {
    return { error: '이 PC에 Claude Code(claude)가 설치돼 있지 않아요 — 설치하고 로그인한 뒤 다시 시도해 주세요.', problem: 'claude-missing' };
  }
  return { error: prefix + (e && e.message ? e.message : String(e)) };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (_e) { resolve({}); }
    });
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function json(res, status, obj) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS));
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
  if (req.method === 'GET' && req.url === '/health') {
    retryAuthIfNeeded(); // 로그인 필요 상태면 재확인 시도 — 재로그인이 끝났으면 다음 조회부터 problem이 풀린다
    return json(res, 200, {
      ok: true, engine: 'claude', model: currentModel, models: ALLOWED_MODELS, examples: EXAMPLES.length, ready: warmedUp,
      problem: (claudeStatus === 'ok' || claudeStatus === null) ? null : claudeStatus,
      account: claudeAccount(),
      served: stats.served, lastAt: stats.lastAt, lastText: stats.lastText, lastSec: stats.lastSec,
    });
  }
  // 플러그인 심장박동 — 끊기면 위 감시 타이머가 다리를 끈다
  if (req.method === 'POST' && req.url === '/heartbeat') {
    lastBeat = Date.now();
    return json(res, 200, { ok: true });
  }
  // 로그인 — 플러그인의 [🟠 클로드 로그인 필요]·[🔑] 버튼이 호출한다.
  // 기본(브라우저 직행): `claude auth login --claudeai`를 숨은 프로세스로 실행 — 메뉴 없이 곧장 브라우저를 열고,
  //   localhost 수신 포트로 결과를 자동 수령한다(실측: 헤드리스에서도 브라우저 열림 + LISTEN 확인, 2026-07).
  //   터미널이 화면에 전혀 안 뜬다. 브라우저 로그인만 하면 끝.
  // 폴백(터미널): 자동 완료가 막힌 환경(브라우저가 localhost에 못 닿아 코드가 보이는 경우)에서
  //   로그인 대기 중 버튼을 또 누르면, 코드를 붙여넣을 수 있는 터미널 방식으로 전환한다.
  if (req.method === 'POST' && req.url === '/open-login') {
    try {
      if (loginProc) {
        // 브라우저 방식이 진행 중인데 또 눌림 = 자동 완료가 안 되는 환경일 수 있음 — 터미널 방식으로 폴백
        killLoginProc();
        if (!openLoginTerminal()) {
          return json(res, 501, { error: '이 OS에선 자동으로 못 열어요 — 터미널에서 claude 실행 후 /login 해 주세요.' });
        }
        killProc();
        accountCache.at = 0;
        console.log('[bridge] 로그인 폴백 — 터미널 방식으로 전환.');
        return json(res, 200, { ok: true, mode: 'terminal' });
      }
      const thisLogin = spawn('claude', ['auth', 'login', '--claudeai'], {
        shell: true, env: CLAUDE_ENV, stdio: 'ignore', windowsHide: true,
        detached: process.platform !== 'win32', // killLoginProc의 그룹 kill용 (killProc과 동일 패턴)
      });
      loginProc = thisLogin;
      thisLogin.on('error', () => { if (loginProc === thisLogin) loginProc = null; });
      thisLogin.on('close', (code) => {
        if (loginProc !== thisLogin) return;
        loginProc = null;
        if (loginProcTimer) { clearTimeout(loginProcTimer); loginProcTimer = null; }
        accountCache.at = 0; // 새 계정일 수 있으니 다음 /health 때 다시 읽기
        console.log('[bridge] 브라우저 로그인 절차 종료 (code ' + code + ')');
      });
      loginProcTimer = setTimeout(() => { console.log('[bridge] 로그인 10분 경과 — 대기 프로세스 정리.'); killLoginProc(); }, 600000);
      // 낡은 입장권을 물고 있는 대기 세션은 버린다 — 재로그인 후 다음 요청이 새 세션(새 입장권)으로 시작하게
      killProc();
      accountCache.at = 0;
      console.log('[bridge] 브라우저 로그인 시작 — 브라우저에서 로그인하면 자동 연결됩니다.');
      return json(res, 200, { ok: true, mode: 'browser' });
    } catch (e) {
      return json(res, 500, { error: '로그인 창을 못 열었어요: ' + e.message });
    }
  }
  // (터미널 폴백 구현부 — 브라우저 자동 완료가 안 되는 환경 전용)
  function openLoginTerminal() {
    {
      if (process.platform === 'win32') {
        // start가 새 콘솔 창을 만든다 (다리의 숨은 콘솔과 무관하게 사용자에게 보임).
        // 이어서 PowerShell(.ps1)이 5초 뒤 그 창에 엔터를 보내 1번(구독 계정)을 자동 선택하고,
        // 창을 최소화해 사용자 눈엔 브라우저 로그인만 남게 한다. 창을 못 찾으면 아무것도 안 한다
        // (다른 창 오입력 방지 — 그 경우 메뉴가 보이는 채로 남고 사용자가 엔터 한 번 누르면 됨).
        // 주의: claude가 콘솔 제목을 바꾸면 AppActivate/FindWindow가 못 찾을 수 있음 — 윈도우 실기에서 확인 필요.
        const ps1 = path.join(os.tmpdir(), 'claude-bridge-login.ps1');
        fs.writeFileSync(ps1, [
          'Start-Sleep -Seconds 5',
          '$ws = New-Object -ComObject WScript.Shell',
          "if ($ws.AppActivate('claude-login')) {",
          "  $ws.SendKeys('~')",
          '  Start-Sleep -Seconds 2',
          "  Add-Type -Namespace U -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr FindWindow(string c, string t); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int n);'",
          "  $h = [U.W]::FindWindow([NullString]::Value, 'claude-login')",
          '  if ($h -ne [System.IntPtr]::Zero) { [void][U.W]::ShowWindow($h, 6) }', // 6 = SW_MINIMIZE
          '}',
        ].join('\r\n') + '\r\n');
        const bat = path.join(os.tmpdir(), 'claude-bridge-login.bat');
        fs.writeFileSync(bat, '@echo off\r\n' +
          'start "claude-login" cmd /k claude /login\r\n' +
          'powershell -NoProfile -ExecutionPolicy Bypass -File "' + ps1 + '"\r\n');
        spawn('cmd', ['/c', bat], { env: CLAUDE_ENV, stdio: 'ignore', windowsHide: true });
      } else if (process.platform === 'darwin') {
        // pty(expect)로 보낸 키에 클로드 TUI가 무반응인 것이 실측 확인됨(2026-07, 일반 \r·kitty 코드 모두) —
        // 유일한 자동화 경로는 System Events의 진짜 키 입력. 접근성 권한이 있으면 6초 뒤 엔터가 자동 입력돼
        // 1번(구독 계정)이 선택되고, 권한이 없으면 keystroke 줄만 조용히 실패해 사용자가 엔터 한 번 누르면 된다(fail-soft).
        // 엔터 직전에 Terminal을 다시 앞으로 가져와 다른 앱에 키가 들어가는 것을 막는다.
        spawn('osascript', [
          '-e', 'tell application "Terminal" to do script "claude /login"',
          '-e', 'tell application "Terminal" to activate',
          '-e', 'delay 6',
          '-e', 'tell application "Terminal" to activate',
          '-e', 'delay 0.3',
          '-e', 'tell application "System Events" to keystroke return',
          // 엔터가 실제로 들어간 경우에만 여기 도달(권한 없으면 위에서 중단) — 터미널을 치워 브라우저만 남긴다
          '-e', 'delay 1.5',
          '-e', 'tell application "Terminal" to set miniaturized of front window to true',
        ], { stdio: 'ignore' });
      } else {
        return false; // 지원 안 하는 OS
      }
      return true;
    }
  }
  // 자기 종료 — 클로드다리-끄기.bat이 호출한다 (로컬에서만 접근 가능하니 안전)
  if (req.method === 'POST' && req.url === '/shutdown') {
    json(res, 200, { ok: true });
    console.log('[bridge] 종료 요청 받음 — 다리를 끕니다.');
    killProc();
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (req.method === 'POST' && req.url === '/recommend') {
    const { text, model } = await readBody(req);
    if (!text || !String(text).trim()) return json(res, 400, { error: '추천받을 문구가 비어 있습니다.' });
    const started = Date.now();
    console.log('[bridge] 추천 요청:', String(text).slice(0, 50).replace(/\n/g, ' ') + '…', model ? '(모델: ' + model + ')' : '');
    try {
      const raw = await askClaude(String(text).trim(), model);
      const suggestions = parseSuggestions(raw);
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      if (!suggestions.length) {
        console.log('[bridge] 파싱 실패 (' + sec + 's):', String(raw).slice(0, 200));
        return json(res, 502, { error: '클로드 응답을 해석하지 못했어요.' });
      }
      console.log('[bridge] 제안 ' + suggestions.length + '개 (' + sec + 's)');
      stats.served++;
      stats.lastAt = new Date().toLocaleTimeString('ko-KR');
      stats.lastText = String(text).slice(0, 30);
      stats.lastSec = sec;
      return json(res, 200, { suggestions, engine: 'claude' });
    } catch (e) {
      console.log('[bridge] 실패:', e.message);
      return json(res, 502, friendlyError(e, '클로드 호출 실패: '));
    }
  }
  // 번역 — 한국어 ↔ 영어 자동 (추천과 같은 세션 사용)
  if (req.method === 'POST' && req.url === '/translate') {
    const { text, model } = await readBody(req);
    if (!text || !String(text).trim()) return json(res, 400, { error: '번역할 문구가 비어 있습니다.' });
    const started = Date.now();
    console.log('[bridge] 번역 요청:', String(text).slice(0, 50).replace(/\n/g, ' ') + '…');
    try {
      const raw = await askTranslate(String(text).trim(), model);
      const out = parseTranslate(raw);
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      if (!out) {
        console.log('[bridge] 번역 파싱 실패 (' + sec + 's):', String(raw).slice(0, 200));
        return json(res, 502, { error: '클로드 번역 응답을 해석하지 못했어요.' });
      }
      console.log('[bridge] 번역 완료 (' + sec + 's, ' + (out.direction || '?') + ')');
      stats.served++;
      stats.lastAt = new Date().toLocaleTimeString('ko-KR');
      stats.lastText = String(text).slice(0, 30);
      stats.lastSec = sec;
      return json(res, 200, { translated: out.translated, direction: out.direction, engine: 'claude' });
    } catch (e) {
      console.log('[bridge] 번역 실패:', e.message);
      return json(res, 502, friendlyError(e, '클로드 번역 실패: '));
    }
  }
  return json(res, 404, { error: 'Not found' });
});

// 이미 다리가 떠 있는데 또 켜기가 들어오면(제스처 자동 켜기 중복 등) 조용히 종료 — 돌던 다리는 그대로 유지
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('[bridge] 이미 켜져 있어요(포트 ' + PORT + ' 사용 중) — 이 인스턴스는 종료합니다.');
    process.exit(0);
  }
  console.log('[bridge] 서버 오류:', e && e.message);
  process.exit(1);
});
// 어떤 경로로 죽든(심장박동 끊김, Ctrl+C, /shutdown, 오류) claude 자식을 남기지 않는다
process.on('exit', () => { killProc(); killLoginProc(); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

server.listen(PORT, '127.0.0.1', () => {
  console.log('──────────────────────────────────────────────');
  console.log(' 클로드 다리 켜짐 — http://localhost:' + PORT);
  console.log(' 모델: ' + CLAUDE_MODEL + ' · 예시 ' + EXAMPLES.length + '건 장착');
  console.log(' 이 창을 켜둔 동안 피그마 플러그인이 클로드로 추천합니다.');
  console.log('──────────────────────────────────────────────');
  checkClaudeAvailable(); // Claude Code 사용 가능 여부 점검 (플러그인 안내용)
  // 미리 시동 + 지시문 주입 — 첫 추천부터 빠르게
  askClaude('워밍업: "저장 되었습니다"').then(
    () => console.log('[bridge] 워밍업 완료 — 추천 준비 끝.'),
    (e) => console.log('[bridge] 워밍업 실패 (첫 요청 때 재시도):', e.message)
  );
});
