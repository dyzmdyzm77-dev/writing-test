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
const { spawn } = require('child_process');

// 클로드를 빈 폴더에서 실행 — 저장소에서 실행하면 프로젝트 맥락(CLAUDE.md 등)을
// 매 턴 짊어져서 45초/턴까지 느려진다 (빈 폴더 + 부가기능 차단이면 ~3초/턴).
const EMPTY_CWD = path.join(os.tmpdir(), 'claude-bridge-cwd');
try { fs.mkdirSync(EMPTY_CWD, { recursive: true }); } catch (_e) { /* 무시 */ }
const CLAUDE_ENV = Object.assign({}, process.env, {
  MAX_THINKING_TOKENS: '0',                    // 생각 모드 끔 (짧은 문구엔 불필요)
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', // 턴 요약 등 부가 호출 끔
  DISABLE_TELEMETRY: '1',
});

const PORT = 11888;
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
// null=확인 중, 'ok'=사용 가능, 'claude-missing'=claude 명령 없음/로그인 안 됨
let claudeStatus = null;
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

function killProc() {
  if (proc) { try { proc.kill(); } catch (_e) { /* 무시 */ } }
  proc = null;
  warmedUp = false;
  if (waiter) { clearTimeout(waiter.timer); waiter.reject(new Error('클로드 세션이 종료됐어요.')); waiter = null; }
}

function startProc() {
  killProc();
  lineBuf = '';
  turns = 0;
  console.log('[bridge] 클로드 세션 시동 중… (모델: ' + currentModel + ')');
  const thisProc = spawn('claude', ['-p', '--model', currentModel, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { shell: true, cwd: EMPTY_CWD, env: CLAUDE_ENV });
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
        if (ev.is_error) w.reject(new Error('클로드 오류: ' + String(ev.result || ev.subtype || '').slice(0, 200)));
        else w.resolve(String(ev.result || ''));
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

// 세션 준비(시동+지시문 주입)를 보장한 뒤 문구 요청 — 모든 호출은 queue로 직렬화.
// model을 주면 그 모델로 (다르면 세션 재시작). 한 모델을 계속 쓰면 재시작은 최초 1회뿐.
function askClaude(text, model) {
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
    const attempt = (askedCount.get(text) || 0) + 1;
    askedCount.set(text, attempt);
    if (askedCount.size > 200) askedCount.clear(); // 무한히 쌓이지 않게
    const ask = attempt > 1
      ? '같은 문구를 다시 요청한다. 이 세션에서 이전에 제안했던 것들과 겹치지 않는, 구조나 어휘가 확실히 다른 새로운 대안 3개를 규칙대로 JSON 배열로만: ' + JSON.stringify(text)
      : '다음 UI 문구의 대안 3개를 규칙대로 JSON 배열로만: ' + JSON.stringify(text);
    return sendTurn(ask);
  });
  // 한 요청이 실패해도 다음 요청이 이어지도록 큐는 항상 성공으로 정리
  queue = job.catch(() => {});
  return job;
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
    return json(res, 200, {
      ok: true, engine: 'claude', model: currentModel, models: ALLOWED_MODELS, examples: EXAMPLES.length, ready: warmedUp,
      problem: claudeStatus === 'claude-missing' ? 'claude-missing' : null,
      served: stats.served, lastAt: stats.lastAt, lastText: stats.lastText, lastSec: stats.lastSec,
    });
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
      return json(res, 502, { error: '클로드 호출 실패: ' + e.message });
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
