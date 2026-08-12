// 클로드 다리(Claude Bridge) — 피그마 플러그인과 Claude Code를 잇는 로컬 심부름꾼
// ─────────────────────────────────────────────────────────────
// 사용법: 평상시엔 감시자가 자동으로 켠다 (수동 시작은 npm run bridge)
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

// 숨김 실행(감시자 스폰은 stdio ignore)에서도 문제를 추적할 수 있게 콘솔 로그를 파일에도 남긴다.
// 위치: 임시 폴더의 claude-bridge.log (윈도우 %TEMP%, 맥 $TMPDIR). 2MB 넘으면 .old로 한 세대만 보관.
const LOG_FILE = path.join(os.tmpdir(), 'claude-bridge.log');
const _origLog = console.log.bind(console);
console.log = function () {
  const args = Array.prototype.slice.call(arguments);
  _origLog.apply(null, args);
  try {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    } catch (_e) { /* 회전 실패는 무시 */ }
    const line = '[' + new Date().toLocaleString('ko-KR') + '] ' +
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch (_e) { /* 파일 로그 실패해도 다리는 계속 */ }
};

const PORT = Number(process.env.BRIDGE_PORT) || 11888; // BRIDGE_PORT는 테스트용 (평소엔 11888 고정)
// 다리 코드 버전 — /health로 노출한다. 코드를 pull·복사해도 **이미 떠 있는 다리는 옛 코드 그대로**라
// 껐다 켜기 전엔 새 동작이 안 나온다(터미널이 뜨는 등). 플러그인이 이 값으로 구버전을 감지해 재시작시킨다.
// 동작이 바뀌는 수정을 하면 이 숫자를 올리고 code.ts의 BRIDGE_MIN_V도 같이 올린다.
const BRIDGE_V = 28;
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
// 용어집(glossary.md)은 일부러 프롬프트에 안 넣는다(2026-07 실측): 넣으면 클로드가 용어 교정을
// 주 임무로 오해해 3개 제안이 전부 "표기 고침 + 어순 변경"이 된다. 역할 분리 —
// 클로드 = 문장 다듬기(창의), 용어 통일·맞춤법 = code.ts refineAiSuggestions 후처리(기계적).
const STYLE_RULES = [
  '1. 해요체: 모든 문구는 해요체로. (보냅니다→보내요)',
  '2. 능동적 말하기: 됐어요→했어요, ~었 빼기(바뀌었어요→바꿨어요). 단, 종료·만료·연체·해지·기록·녹음 등 시스템이 주체인 결과는 수동형 유지(연체돼요, 녹음돼요).',
  '3. 긍정적 말하기: "~할 수 없어요" 대신 "~하면 할 수 있어요" 구조 우선. 단, 정책상 불가·일부 기능 제한·되돌릴 수 없는 결과·정보 보호 안심은 부정형으로 명확히.',
  '4. 캐주얼한 경어: ~하시겠어요?→~할까요?, 계시다→있다, 여쭈다→확인하다, 께→에게. ~시 빼기가 어색하면 파악하려는 정보를 주어로 문장을 다시 쓴다.',
  '5. 명사+명사 금지: 한자어를 풀어 동사로(이자 환불을 받았어요→이자를 돌려받았어요), 최소한 {명사}가 {명사}해서 형태로(잔액 부족으로→잔액이 부족해서).',
  '6. 표기: 되어요→돼요.',
  '7. 줄 구조: 원본이 한 줄이면 추천도 반드시 한 줄로. 임의로 줄을 늘리지 않는다. 단, 여러 문장을 하나의 긍정형 문장으로 합쳐 더 간결해진다면 줄 수를 줄이는 것은 환영.',
  '8. 팝업(다이얼로그) 버튼: 결과 통보는 [확인], 예/아니오 판단은 [아니오]/[네], 동작 유도는 [취소]/[{동작}]. "취소"는 동작 버튼과 짝일 때만 쓰고 "닫기·동작"처럼 짝 안 맞는 조합·단독 "취소"는 금지.',
  '9. 이름·전화번호·마스킹은 그대로 보존. 사람을 부를 땐 님을 붙여도 좋다.',
  '10. 제품 용어 유지: 입력에 쓰인 기능성 명사(변경, 지정, 등록, 해제 등)는 화면의 기능명·버튼명일 가능성이 높으므로 쉬운 말로 바꾸지 않는다. 시스템 동작과 다른 동사를 새로 만들지 않는다.',
].join('\n');

const EXAMPLES = loadExamples();

// ── 스타일 가이드 전문 로드 (ux-writing.md — 예외 규칙 세부 시나리오까지 프롬프트에 포함) ──
// STYLE_RULES 10줄 요약만으로는 예외 1~3(수동형·경어·부정형 허용 케이스)의 뉘앙스가 유실된다.
// 파일이 없으면(설치본 구버전 등) 빈 문자열 — 요약만으로 동작(fail-soft).
function loadGuide() {
  try {
    const md = fs.readFileSync(path.join(__dirname, '..', 'ux-writing.md'), 'utf8').trim();
    return md.length > 100 ? md : '';
  } catch (e) {
    console.log('[bridge] 스타일 가이드 로드 실패 (요약만으로 진행):', e.message);
    return '';
  }
}
const GUIDE = loadGuide();

function instructionMessage() {
  const fewShot = EXAMPLES.map((ex) => 'Input: ' + JSON.stringify(ex.input) + '\nOutput: ' + JSON.stringify(ex.suggestions)).join('\n');
  return (
    '지금부터 너는 에스원(S-1, 보안회사)의 한국어 UX Writing 전문가로 일한다. ' +
    '내가 UI 문구를 하나씩 보내면, 아래 스타일 규칙에 맞게 다듬은 대안 3개를 제안하라.\n' +
    '요청들은 서로 무관한 별개 문구다 — 이전 문구를 참조하지 마라.\n' +
    '원래 의미와 모든 정보(이름·숫자·조건·대상)를 유지하고, 각 제안은 원본과도 서로와도 달라야 한다. ' +
    '조건 표현(이상·이하·이내·초과·미만·부터·까지 등)은 정책 정보다 — 빼거나 다른 조건으로 바꾸지 마라("5회 이상"을 "5회"로 줄이면 오답). ' +
    '원문에 없는 구체 정보(전화번호·URL·금액·시간 등)와 해결 방법·절차(재설정·문의처·재시도 등)를 지어내 붙이는 것은 절대 금지 — 아는 값이라도, 그럴듯해도 쓰지 마라.\n' +
    '3개 제안은 서로 접근이 달라야 한다 — 하나는 원문 구조를 유지한 최소 다듬기, 하나는 문장 구조를 재구성한 대안, ' +
    '그리고 적어도 하나는 과감한 재구성: 중복 표현을 덜어내고, 정보 순서를 사용자가 알아야 할 것부터로 재조직할 것. ' +
    '원문이 해결 방법을 담고 있을 때만 "어떻게 하면 다시 된다"를 앞세우는 긍정형 재구성을 하라 — 원문에 해결책이 없으면 만들어 붙이지 마라. ' +
    '표기·용어만 고치고 어순을 바꾼 정도의 제안을 3개 늘어놓지 마라 — 그건 사용자에게 추천이 아니라 교정으로 보인다. ' +
    '아래 예시들은 한 줄짜리 최소 교정이 많지만 그건 톤(해요체·경어)의 교본이지 소극성의 교본이 아니다 — 여러 문장짜리 입력은 메시지 단위로 다시 설계하라.\n' +
    '답은 반드시 JSON 배열만 출력한다. 마크다운·설명·코드펜스 금지:\n' +
    '[{"text": "제안 문구 (줄바꿈은 \\n)", "reason": "무엇을 왜 바꿨는지 한국어 한 문장"}, ...]\n\n' +
    '[스타일 규칙]\n' + STYLE_RULES + '\n\n' +
    (GUIDE ? '[스타일 가이드 전문 (ux-writing.md) — 위 규칙의 근거와 예외 시나리오. 특히 예외 규칙(수동형·경어·부정형을 유지해야 하는 상황)을 그대로 따르고, 요약과 전문이 다르면 전문을 따른다]\n' + GUIDE + '\n\n' : '') +
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
// 'claude-limit'=로그인은 됐지만 사용 한도 초과 (조치가 재로그인이 아니라 한도 인상·계정 전환)
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
// 사용 한도 초과 감지 — 로그인은 멀쩡한데 "더 못 쓴다"는 경우. 로그인 만료와 조치가 달라서 따로 잡는다.
// 실측(2026-08, 회사 엔터프라이즈 좌석): "You've hit your individual spend limit · run /usage-credits
// to ask your admin for a higher limit" — 관리자가 사람별로 걸어 둔 상한이라 플랜 사용량이 남아도 걸린다.
// 이 케이스가 없던 탓에 영어 원문이 그대로 토스트돼 "왜 안 되는지" 알 수 없었다(실제 신고).
const LIMIT_GUIDE = '클로드 사용 한도를 다 썼어요 — 회사 계정이면 관리자에게 한도를 올려 달라고 요청하고, 아니면 [🟠 클로드 한도 초과] 버튼을 눌러 다른 계정으로 로그인해 주세요.';
// '한도'로 뭉뚱그리면 안 된다 — 잠깐 몰릴 때 나는 rate limit이나 문맥 길이 초과까지 잡아
// 엉뚱하게 "다른 계정으로 로그인하라"고 안내하게 된다. 지출·사용량 상한 문구만 좁혀서 본다
function isLimitError(s) {
  return /spend limit|usage-credits|usage limit (reached|exceeded)/i.test(String(s));
}
// 로그인된 계정 확인 — CLI가 ~/.claude.json에 기록하는 oauthAccount.emailAddress를 읽어
// /health로 노출한다 (플러그인이 "누구 계정으로 쓰는 중인지" 표시 — 공용 PC에서 남의 계정 오사용 방지).
// 파일이 클 수 있어(프로젝트 이력 포함) 30초 캐시. 재로그인하면 CLI가 파일을 갱신하므로 자동 반영된다.
let accountCache = { at: 0, email: null };
// 지금 떠 있는 claude 세션이 어느 계정으로 시동됐는지 (startProc에서 기록).
// 세션은 시동할 때 받은 입장권을 계속 쓰므로, 밖에서 계정을 바꾸면 이 값과 파일의 계정이 어긋난다
let sessionAccount = null;
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

// ── 계정 전환은 시크릿 창으로 (2026-08, BRIDGE_V=27) ────────────────
// [계정 전환]을 눌렀는데 "Claude Code님이 …연결을 요청했습니다"(승인 화면)가 뜨는 게 불만이었다.
// 브라우저에 옛 계정 claude.ai 세션이 남아 있으면 authorize URL은 계정을 묻지 않고 그 계정으로
// 승인만 묻는다. URL에 selectAccount·prompt를 씌우거나 logout?returnTo로 잇는 건 전부 실패했다
// (아래 'BROWSER 가로채기' 주석의 히스토리). **세션이 없는 창에서 열면 로그인 화면이 그냥 나온다** —
// 외부 사이트의 리다이렉트 규칙에 기대지 않는 유일한 방법이라 이걸 쓴다.
// 성립 근거(2026-08 실측): ① CLI는 authorize URL 전문을 **stdout에 찍는다**("If the browser didn't
// open, visit: …") ② BROWSER를 아무것도 안 하는 스크립트로 지정하면 CLI가 자기 브라우저를 열지 않으면서도
// **localhost 자동 수령은 유지**한다(127.0.0.1 LISTEN 확인) → 코드 붙여넣기 없이 끝난다.
// **URL은 stdout에서 가져올 것** — BROWSER 핸들러의 인자로 받으면 cmd가 `&`에서 잘라먹는다(실측:
// ARGS_ALL이 ?code=true에서 끝나고 client_id 이후가 사라짐 = "잘못된 OAuth 요청"의 진짜 원인).
// 브라우저는 인자로 직접 넘긴다(shell 경유 금지 — 같은 잘림을 당한다).
function writeNoopBrowser() {
  if (process.platform === 'win32') {
    const p = path.join(os.tmpdir(), 'claude-bridge-noop.cmd');
    fs.writeFileSync(p, '@echo off\r\nexit /b 0\r\n');
    return p;
  }
  const p = path.join(os.tmpdir(), 'claude-bridge-noop.sh');
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(p, 0o755);
  return p;
}
// 시크릿/InPrivate 창으로 URL을 연다. 못 열면 false — 호출한 쪽이 기본 브라우저로 폴백한다
// (폴백이 없으면 아무 창도 안 떠서 사용자가 막힌다 — BROWSER를 no-op으로 막아 뒀기 때문).
// 기본 브라우저 실행 파일을 찾는다(win32) — https 연결 프로그램의 ProgId → shell\open\command.
// **기본 브라우저를 먼저 쓰는 게 중요하다**: 안 그러면 평소 안 쓰는 브라우저가 열려 당황스럽다
// (실측 신고: 기본이 삼성 인터넷인데 크롬이 열렸다). reg.exe로 읽어 PowerShell 의존을 피한다.
function winDefaultBrowserExe() {
  try {
    const q = spawnSync('reg', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { encoding: 'utf8' });
    const prog = (q.stdout || '').match(/ProgId\s+REG_SZ\s+(\S+)/);
    if (!prog) return null;
    for (const root of ['HKCU\\SOFTWARE\\Classes', 'HKLM\\SOFTWARE\\Classes']) {
      const c = spawnSync('reg', ['query', root + '\\' + prog[1] + '\\shell\\open\\command', '/ve'], { encoding: 'utf8' });
      const line = (c.stdout || '').match(/REG_SZ\s+(.+)/);
      if (!line) continue;
      const hit = line[1].trim().match(/^"([^"]+)"/) || line[1].trim().match(/^(\S+\.exe)/i);
      if (hit && fs.existsSync(hit[1])) return hit[1];
    }
  } catch (_e) { /* 못 찾으면 아래 후보 목록으로 */ }
  return null;
}
// 브라우저별 시크릿 창 인자 — 엣지·파이어폭스만 다르고, 나머지 크로미움 계열
// (크롬·웨일·삼성 인터넷·브레이브·비발디…)은 --incognito를 쓴다
function privateFlagFor(exe) {
  const n = path.basename(exe).toLowerCase();
  if (n.indexOf('msedge') !== -1) return '--inprivate';
  if (n.indexOf('firefox') !== -1) return '-private-window';
  return '--incognito';
}
const WIN_PRIVATE_BROWSERS = [
  { exe: (process.env.ProgramFiles || 'C:\\Program Files') + '\\Google\\Chrome\\Application\\chrome.exe', flag: '--incognito' },
  { exe: (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)') + '\\Google\\Chrome\\Application\\chrome.exe', flag: '--incognito' },
  { exe: (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)') + '\\Microsoft\\Edge\\Application\\msedge.exe', flag: '--inprivate' },
  { exe: (process.env.ProgramFiles || 'C:\\Program Files') + '\\Microsoft\\Edge\\Application\\msedge.exe', flag: '--inprivate' },
];
function openPrivateWindow(url) {
  try {
    if (process.platform === 'win32') {
      // 기본 브라우저를 먼저 — 못 찾을 때만 크롬·엣지로 폴백
      const def = winDefaultBrowserExe();
      const cands = def ? [{ exe: def, flag: privateFlagFor(def) }].concat(WIN_PRIVATE_BROWSERS) : WIN_PRIVATE_BROWSERS;
      for (const b of cands) {
        if (!fs.existsSync(b.exe)) continue;
        spawn(b.exe, [b.flag, url], { stdio: 'ignore', windowsHide: false }).unref();
        console.log('[bridge] 시크릿 창으로 로그인 화면을 열었어요: ' + path.basename(b.exe) + ' ' + b.flag
          + (def && b.exe === def ? ' (기본 브라우저)' : ' (기본 브라우저를 못 찾아 폴백)'));
        return true;
      }
      return false;
    }
    // macOS — 크롬이 있으면 시크릿 창, 없으면 폴백(사파리는 CLI로 개인정보 보호 창을 못 연다)
    const r = spawnSync('open', ['-na', 'Google Chrome', '--args', '--incognito', url], { stdio: 'ignore' });
    if (r.status === 0) { console.log('[bridge] 시크릿 창으로 로그인 화면을 열었어요 (Chrome)'); return true; }
    return false;
  } catch (_e) { return false; }
}
// 기본 브라우저로 열기(폴백). win32는 rundll32로 — cmd를 안 거쳐서 URL의 &가 안 잘린다
function openDefaultBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true }).unref();
    else spawn('open', [url], { stdio: 'ignore' }).unref();
    console.log('[bridge] 기본 브라우저로 로그인 화면을 열었어요(시크릿 창 실패 폴백).');
    return true;
  } catch (_e) { return false; }
}

// ── BROWSER 가로채기는 제거됐다 (2026-08, BRIDGE_V=25) ──────────────
// 예전엔 BROWSER 환경변수에 임시 스크립트를 꽂아 CLI가 준 authorize URL을 우리가 받아서 열었다.
// 목적은 하나뿐이었다 — 계정 전환용으로 URL을 claude.ai/logout?returnTo=…로 재작성해
// 승인 화면을 건너뛰고 계정 선택 화면에 직행시키기. 그 재작성을 폐기하자(사용자 결정) 핸들러는
// 목적이 없어졌고, **남겨 두면 오히려 로그인을 망가뜨린다**:
//   CLI가 URL을 따옴표 없이 넘기면 cmd가 `&`에서 URL을 잘라 버려(윈도우) client_id 같은 뒤쪽
//   매개변수가 사라지고, 브라우저엔 "잘못된 OAuth 요청 · client_id 매개변수가 누락되었습니다"가 뜬다.
//   심하면 브라우저가 아예 안 열린다(실측 2026-08: CLI 프로세스는 대기 중인데 창이 안 뜸).
// 이제 BROWSER를 건드리지 않는다 → claude CLI가 기본 브라우저를 직접 연다(CLI 기본 동작).
// **이 경로에 URL 가공·중간 스크립트를 다시 넣지 말 것.** 계정 전환은 승인 화면 하단 [계정 전환] 버튼으로.

// 브라우저 로그인 프로세스 (claude auth login --claudeai) — /open-login이 생성·관리.
// 브라우저가 localhost로 결과를 보내줄 때까지 숨어서 대기하다가, 완료되면 스스로 끝난다.
let loginProc = null;
let loginProcTimer = null;
let loginStartedAt = 0; // 브라우저 로그인 시작 시각 — 재클릭이 '재시도'인지 '자동완료 실패'인지 구분한다
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

// 턴 도중 클로드 프로세스가 죽었을 때의 실패 메시지 — runTurn이 이 메시지일 때만 1회 자동 재시도한다
const SESSION_DIED = '클로드 세션이 종료됐어요.';
let shuttingDown = false; // /shutdown 진행 중 — 재시도로 세션을 되살리지 않게 표시

// reason을 주면 '의도적 종료'(계정 전환·로그아웃 등) — 진행 중이던 턴을 그 메시지로 끝내서
// runTurn의 SESSION_DIED 자동 재시도가 옛 자격증명으로 세션을 되살리지 않게 한다.
// (안 그러면 계정 전환 직후 옛 계정 세션이 부활해 MAX_TURNS까지 계속 쓰이는 버그 — 2026-07 리뷰에서 확인)
function killProc(reason) {
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
  if (waiter) { clearTimeout(waiter.timer); waiter.reject(new Error(reason || SESSION_DIED)); waiter = null; }
}

function startProc() {
  killProc();
  lineBuf = '';
  turns = 0;
  // 이 세션이 어느 계정의 입장권으로 도는지 기록 — 밖에서 계정이 바뀌었는지 비교하는 기준
  sessionAccount = claudeAccount();
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
          // 한도 초과를 먼저 본다 — 로그인 오류 정규식이 넓어서(log ?in 등) 문구가 바뀌면 삼킬 수 있다
          if (isLimitError(raw)) {
            claudeStatus = 'claude-limit'; // /health로 알림 → 버튼이 [한도 초과]로 바뀌고 계정 전환을 안내
            console.log('[bridge] 클로드 사용 한도 초과 감지:', raw);
            w.reject(new Error(LIMIT_GUIDE));
          } else if (isAuthError(raw)) {
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
      // 시간 초과는 '세션 종료'와 구분되는 제 메시지로 끝낸다 — killProc의 세션 종료 reject가
      // runTurn의 자동 재시도를 부르면 안 되기 때문(느린 턴을 두 번 돌면 플러그인 130초 제한을 넘긴다)
      if (waiter) {
        const w = waiter; waiter = null;
        w.reject(new Error('클로드 응답이 너무 오래 걸려 요청을 중단했어요 — 다시 시도해 주세요.'));
      }
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
// reparse={parse, formatDesc}를 주면 파싱까지 이 잡 안에서 처리하고 {raw, parsed}를 돌려준다:
// 형식 이탈 시 같은 세션에 "형식대로 다시"를 요구하는 재요청 턴을 **같은 큐 잡 안에서** 붙인다.
// 별도 잡으로 빼면 (a) 사이에 다른 요청 턴이 끼어 '방금 답'이 남의 답이 되고(내용 오염),
// (b) MAX_TURNS 경계에서 세션이 재시작돼 '방금 답'이 없는 새 세션이 내용을 지어낼 수 있다 (2026-07 리뷰에서 확인).
const REPARSE_BAD = (v) => v == null || (Array.isArray(v) && v.length === 0);
function runTurn(buildAsk, model, reparse) {
  const job = queue.then(async () => {
    const jobStart = Date.now(); // 시간 예산 — 플러그인 쪽 제한(130초)을 넘길 재시도는 포기한다
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
    const ask = buildAsk(); // 재시도 때 같은 질문을 다시 쓴다 (askedCount 이중 증가 방지)
    let raw;
    try {
      raw = await sendTurn(ask);
    } catch (e) {
      // 턴 도중 클로드 프로세스가 죽은 경우(SESSION_DIED) 1회 자동 재시도 — 사용자에겐 실패로 안 보이게.
      // 시간 초과·로그인 만료·클로드 오류·의도적 종료(계정 전환/로그아웃, killProc(reason))는
      // 제 메시지가 따로 있어 여기 안 걸린다. 종료 요청 중이거나 시간 예산이 얼마 안 남았으면 되살리지 않는다.
      if (shuttingDown || !(e && e.message === SESSION_DIED) || Date.now() - jobStart > 40000) throw e;
      console.log('[bridge] 세션이 턴 도중 끊김 — 재시동 후 1회 재시도합니다.');
      startProc();
      await sendTurn(instructionMessage());
      warmedUp = true;
      turns = 2; // 워밍업 1 + 이번 턴 (startProc이 0으로 초기화)
      raw = await sendTurn(ask);
    }
    if (!reparse) return raw;
    let parsed = reparse.parse(raw);
    // 형식 이탈이면 같은 세션·같은 잡에서 곧장 재요청 — 이 턴이 죽으면 새 세션은 '방금 답'을 몰라
    // 지어낼 수 있으므로 세션 사망 재시도는 하지 않고 그대로 실패시킨다(파싱 실패로 귀결).
    if (REPARSE_BAD(parsed) && Date.now() - jobStart < 70000) {
      console.log('[bridge] 파싱 실패 — 형식 재요청:', String(raw).slice(0, 300));
      turns++;
      try {
        raw = await sendTurn('방금 답이 요구한 형식에 어긋났다. 방금 답한 내용을 설명·사과·코드펜스 없이 아래 JSON으로만 다시 출력하라: ' + reparse.formatDesc);
        parsed = reparse.parse(raw);
      } catch (_e) { /* 재요청 실패 — 아래에서 파싱 실패로 처리 */ }
    }
    if (REPARSE_BAD(parsed)) console.log('[bridge] 파싱 실패 (재요청 후에도):', String(raw).slice(0, 300));
    return { raw, parsed: REPARSE_BAD(parsed) ? null : parsed };
  });
  // 한 요청이 실패해도 다음 요청이 이어지도록 큐는 항상 성공으로 정리
  queue = job.catch(() => {});
  return job;
}

// 버튼 라벨 규칙 — 플러그인이 '버튼을 골랐다'고 알려줄 때만 얹는다.
// 버튼 문구는 문장이 아니라 동작 이름이어서, 이 지시가 없으면 문장형 대안이 섞여 나온다.
const BUTTON_RULE =
  '이 문구는 **버튼 라벨**이다. 문장이 아니라 동작 이름이므로: 마침표·물음표·종결어미(~요/~다/~까요) 금지, ' +
  '되도록 짧은 동작 명사(저장·삭제·연결 해제 등)로, 통보성 단일 버튼이면 "확인". ' +
  '"취소"는 동작 버튼과 짝일 때만 쓰고, 화면 기능명(변경·해제 등)은 그대로 둔다.\n';

// 문구 추천 턴 (role='버튼'이면 버튼 규칙을 얹는다)
function askClaude(text, model, reparse, role) {
  return runTurn(() => {
    const attempt = (askedCount.get(text) || 0) + 1;
    askedCount.set(text, attempt);
    if (askedCount.size > 200) askedCount.clear(); // 무한히 쌓이지 않게
    const rule = role === '버튼' ? BUTTON_RULE : '';
    return rule + (attempt > 1
      ? '같은 문구를 다시 요청한다. 이 세션에서 이전에 제안했던 것들과 겹치지 않는, 구조나 어휘가 확실히 다른 새로운 대안 3개를 규칙대로 JSON 배열로만: ' + JSON.stringify(text)
      : '다음 UI 문구의 대안 3개를 규칙대로 JSON 배열로만: ' + JSON.stringify(text));
  }, model, reparse);
}

// 번역 턴 — 같은 세션을 쓰되, 이번 턴만 추천 형식(JSON 배열) 대신 번역 형식(JSON 객체)을 요구한다
function askTranslate(text, model, reparse) {
  return runTurn(() => (
    '이번 요청은 번역 작업이다 (문구 다듬기 아님 — 대안 3개 규칙은 이번 턴에 적용하지 않는다). ' +
    '다음 UI 문구가 한국어면 자연스러운 영어로, 영어면 자연스러운 한국어로 번역하라. ' +
    'UI 문구다운 간결한 표현을 쓰고, 이름·숫자·마스킹·플레이스홀더는 그대로 보존한다. ' +
    '원문의 줄 수를 그대로 유지한다 — 원문이 한 줄이면 번역도 한 줄로, 줄바꿈을 임의로 추가하지 않는다. ' +
    '답은 반드시 JSON 객체 하나만 출력한다. 마크다운·설명 금지: ' +
    '{"translated": "번역문 (줄바꿈은 \\n)", "direction": "ko→en 또는 en→ko"}: ' + JSON.stringify(text)
  ), model, reparse);
}

// 대화형 문구 제작 턴 — 사용자가 상황을 설명하면 맥락에 맞는 문구를 만들어준다.
// messages: [{role:'user'|'assistant', text}] 전체 대화를 매번 받는다(다리는 무상태 —
// 워밍업 지시문의 "요청들은 서로 무관" 전제를 지키기 위해 대화 맥락을 턴 안에 몽땅 싣는다).
function askCompose(messages, model, reparse) {
  return runTurn(() => {
    const transcript = (messages || []).map((m) =>
      (m.role === 'assistant' ? '어시스턴트: ' : '사용자: ') + String(m.text || '').slice(0, 1500)
    ).join('\n');
    return (
      '이번 요청은 "대화형 문구 제작"이다 (기존 문구 다듬기 아님 — 아래 대화가 이번 턴의 전체 맥락이다). ' +
      '사용자가 화면 상황·맥락을 설명하면, 스타일 규칙과 예시 톤에 맞는 UI 문구를 만들어 제안하라.\n' +
      '- 맥락이 부족하면 편하게 되물어라: 어떤 화면·기능의 문구인지, 들어갈 자리는 어디인지(팝업 타이틀/본문/버튼, 토스트, 빈 화면 안내, 배너 등), 어떤 상황인지(성공 통보/오류/확인 요청/안내) 같은 것. 꼭 필요한 것만 골라 한 번에 최대 2개까지, 짧게. 이때 suggestions는 빈 배열.\n' +
      '- 감이 어느 정도 오면 묻기만 하지 마라 — 가정을 세우고 초안 suggestions를 함께 내면서, reply에 가정을 밝히고 무엇을 알려주면 더 맞출 수 있는지 한 문장으로 덧붙여라(예: "확인 팝업이라고 가정했어요 — 토스트라면 알려주세요").\n' +
      '- 문구를 제안할 땐 서로 접근이 다른 2~3개. 각 제안엔 왜 그렇게 썼는지 이유를 붙인다.\n' +
      '- 사용자가 언급하지 않은 구체 정보(전화번호·URL·금액·횟수 등)를 지어내 넣지 마라.\n' +
      '- 후속 요청("더 짧게", "버튼용으로" 등)이면 직전 제안을 그 방향으로 고쳐 다시 제안하라.\n' +
      '답은 반드시 JSON 객체 하나만 출력한다. 마크다운·설명 금지: ' +
      '{"reply": "대화 응답 한두 문장 (해요체)", "suggestions": [{"text": "문구 (줄바꿈은 \\n)", "reason": "이유 한 문장"}]}\n\n' +
      '[대화]\n' + transcript
    );
  }, model, reparse);
}

// 프레임별(하위 프레임 묶음) 추천 턴 — 한 화면을 하위 프레임 단위로 나눠 보내고,
// **프레임마다 따로** 대안을 받는다. 한 요청에 다 실어 보내는 것이 핵심:
// 프레임 수만큼 요청을 쪼개면 그만큼 느려지고(각 5~10초) 구독 사용량도 그만큼 나간다.
// groups: [{name, texts:[]}] (화면 위→아래 순).
function askGroups(groups, model, reparse, more) {
  return runTurn(() => {
    // 버튼 영역은 (버튼)으로 찍어 보낸다 — 버튼 문구는 문장이 아니라 동작 이름이라 규칙이 다르다
    const list = (groups || []).map((g, i) =>
      '[' + (i + 1) + '] ' + String((g && g.name) || ('그룹' + (i + 1))) + (g && g.role === '버튼' ? ' (버튼)' : '') + '\n' +
      (g && Array.isArray(g.texts) ? g.texts : []).map((t) => '  - ' + JSON.stringify(String(t || ''))).join('\n')
    ).join('\n');
    const hasBtn = (groups || []).some((g) => g && g.role === '버튼');
    const key = 'groups' + (groups || []).map((g) => (g && g.texts ? g.texts.join('') : '')).join('');
    const attempt = (askedCount.get(key) || 0) + 1;
    askedCount.set(key, attempt);
    if (askedCount.size > 200) askedCount.clear();
    const again = more || attempt > 1
      ? '이 화면은 이 세션에서 이미 다뤘다. 앞서 낸 대안과 어휘·구조가 확실히 다른 새 대안만 내라.\n'
      : '';
    return (
      again +
      '이번 요청은 "화면을 하위 프레임별로 나눠 다듬기"다. 아래는 한 화면의 문구를 하위 프레임(영역) 단위로 묶은 것이다.\n' +
      '**영역마다 따로** 대안을 내라 — 영역을 서로 합치거나 순서를 바꾸지 마라.\n' +
      '- 각 영역에 대안 2개. 그 영역이 여러 줄이면 대안도 **같은 줄 수**로(줄바꿈 \\n으로 구분, 줄 순서 유지).\n' +
      '- 영역의 역할(타이틀·안내·버튼 등)과 원문의 정보·조건(숫자·대상·조건)은 유지하고, 없는 정보를 지어내지 마라.\n' +
      '- 고칠 게 없는 영역이면 대안 1개만 내거나 빈 배열로 두어도 된다 — 억지로 바꾸지 마라.\n' +
      '- 화면 기능명(변경·해제 등)은 그대로 둔다.\n' +
      (hasBtn ? '- (버튼)으로 표시된 영역은 ' + BUTTON_RULE : '') +
      '답은 반드시 JSON 객체 하나만 출력한다. 마크다운·설명·코드펜스 금지:\n' +
      '{"groups": [{"name": "영역 이름(입력과 동일)", "suggestions": [{"text": "대안 문구 (줄바꿈은 \\n)", "reason": "이유 한 문장"}]}]}\n' +
      '영역은 입력 순서·개수를 그대로 지킨다.\n\n' +
      '[영역별 문구]\n' + list
    );
  }, model, reparse);
}

// 프레임별 추천 응답에서 [{name, suggestions:[{text, reason}]}] 추출
function parseGroups(raw) {
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try {
    const o = JSON.parse(s);
    const arr = Array.isArray(o && o.groups) ? o.groups : [];
    const groups = arr.map((g) => ({
      name: String((g && g.name) || '').trim(),
      suggestions: Array.isArray(g && g.suggestions)
        ? g.suggestions
            .map((x) => (typeof x === 'string'
              ? { text: x.trim(), reason: '' }
              : { text: String((x && x.text) || '').trim(), reason: String((x && x.reason) || '').trim() }))
            .filter((x) => x.text)
        : [],
    }));
    // 이름조차 없고 제안도 없는 껍데기만 왔으면 형식 이탈로 본다(같은 세션에 재요청)
    return groups.some((g) => g.suggestions.length) ? groups : null;
  } catch (_e) {
    return null;
  }
}

// 팝업 세트 추천 턴 — 한 팝업의 구성요소(역할+문구)를 한 번에 보내고,
// 요소별 낱개가 아니라 **완성된 팝업 세트(케이스) 2~3개**를 통으로 받는다.
// 타이틀·안내·버튼이 한 몸으로 일관돼야 하므로(따로 뽑아 조합하면 어긋난다) 세트 단위로 제안하게 한다.
// elements: [{role, text}] (화면 위→아래 순).
// more=true([케이스 더 받기])면 이 세션에서 이미 낸 세트와 겹치지 않는 새 세트를 요구한다.
function askPopup(elements, model, reparse, more) {
  return runTurn(() => {
    const roles = (elements || []).map((e) => String((e && e.role) || '')).join(', ');
    const list = (elements || []).map((e, i) =>
      (i + 1) + '. [' + String((e && e.role) || '') + '] ' + JSON.stringify(String((e && e.text) || ''))
    ).join('\n');
    // 같은 팝업을 몇 번째 묻는지 기억 — 재요청이면 "이전과 다른 세트"를 요구한다
    // (askClaude와 같은 이유: 안 그러면 클로드가 같은 세트를 또 내서 [케이스 더 받기]가 무의미해진다)
    const key = 'popup' + (elements || []).map((e) => String((e && e.text) || '')).join('');
    const attempt = (askedCount.get(key) || 0) + 1;
    askedCount.set(key, attempt);
    if (askedCount.size > 200) askedCount.clear(); // 무한히 쌓이지 않게
    const again = more || attempt > 1
      ? '이 팝업은 이 세션에서 이미 다뤘다. 앞서 제안한 세트들과 **접근·어휘가 확실히 다른 새 세트**만 내라(같은 세트 반복 금지).\n'
      : '';
    return (
      again +
      '이번 요청은 "팝업(다이얼로그) 세트 다듬기"다. 아래는 한 팝업을 위→아래로 나열한 구성요소들이다(서로 무관한 별개 문구가 아니다). ' +
      '요소를 낱개로 고치지 말고, **타이틀·안내·버튼이 서로 일관된 "완성된 팝업 세트" 2~3개**를 제안하라. 각 세트는 서로 다른 접근이어야 한다.\n' +
      '각 세트는 입력과 **같은 역할·같은 개수·같은 순서**의 요소를 모두 포함한다. 세트 안에서 타이틀·안내·버튼은 한 몸으로 맞아떨어져야 한다(예: 본문이 "~할까요?"면 버튼은 [아니오]/[네]).\n' +
      '[팝업 문체 규칙 — 위 스타일 가이드의 "8. 팝업" 섹션을 따른다]\n' +
      '- 타이틀: 짧은 명사구(2~4어절), 종결어미·마침표 없이(~요/~다/~까요? 금지). 반드시 안내(본문) 맥락을 요약해 타이틀만 봐도 무슨 팝업인지 알게 하라. 원본이 "알림/확인"처럼 막연하면 본문을 근거로 구체화하라.\n' +
      '- 안내(본문): 해요체. 판단이 필요하면 "~할까요?"로 묻고, 되돌릴 수 없는 위험(삭제·탈퇴 등)은 결과를 먼저 경고한다. 결과·상태 통보면 서술형으로 알린다.\n' +
      '- 버튼: 본문이 "~할까요?"면 [아니오]/[네], 본문이 상황을 서술하고 이 버튼이 실제 동작이면 동작 동사(삭제/저장/연결 해제 등), 통보 팝업의 단일 버튼이면 "확인". "취소"는 동작 버튼과 짝일 때만, "닫기·동작" 조합 금지. 화면 기능명(변경·해제 등)은 그대로 둔다.\n' +
      '- 원문의 정보·조건(숫자·이상/이하·대상)은 유지하고, 원문에 없는 정보·절차·연락처를 지어내지 마라.\n' +
      '답은 반드시 JSON 객체 하나만 출력한다. 마크다운·설명·코드펜스 금지:\n' +
      '{"sets": [{"reason": "이 세트의 방향을 한국어 한 문장으로", "elements": [{"role": "역할", "text": "문구 (줄바꿈은 \\n)"}, ...]}, ...]}\n' +
      '역할은 입력 순서대로: ' + roles + '\n\n' +
      '[팝업 요소]\n' + list
    );
  }, model, reparse);
}

// 팝업 응답에서 {sets: [{reason, elements:[{role,text}]}]} 추출 (코드펜스·앞뒤 잡담 허용)
function parsePopup(raw) {
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try {
    const o = JSON.parse(s);
    const setsIn = Array.isArray(o && o.sets) ? o.sets : [];
    const sets = setsIn
      .map((st) => ({
        reason: String((st && st.reason) || '').trim(),
        elements: Array.isArray(st && st.elements)
          ? st.elements
              .map((el) => ({ role: String((el && el.role) || '').trim(), text: String((el && el.text) || '').trim() }))
              .filter((el) => el.text)
          : [],
      }))
      .filter((st) => st.elements.length);
    return sets.length ? sets : null;
  } catch (_e) {
    return null;
  }
}

// 대화형 제작 응답에서 {reply, suggestions[]} 추출 (코드펜스·앞뒤 잡담 허용)
function parseCompose(raw) {
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try {
    const o = JSON.parse(s);
    const reply = String((o && o.reply) || '').trim();
    const suggestions = Array.isArray(o && o.suggestions)
      ? o.suggestions
          .map((x) => ({ text: String((x && x.text) || '').trim(), reason: String((x && x.reason) || '').trim() }))
          .filter((x) => x.text)
      : [];
    if (reply || suggestions.length) return { reply, suggestions };
  } catch (_e) { /* 아래로 */ }
  return null;
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

// 로그인 필요·한도 초과 상태일 때 /health 조회가 오면 뒤에서 워밍업을 다시 시도해본다 (30초에 1번만).
// 성공하면 결과 핸들러가 claudeStatus='ok'로 되돌리므로, 재로그인 후 버튼이 저절로 🟢으로 복귀한다.
// (플러그인이 로그인 창을 연 뒤 주기적으로 /health를 조회하는 것과 짝을 이룬다)
// 한도 초과도 같은 경로로 복귀시킨다 — 관리자가 한도를 올려주거나 한도가 초기화되면
// 사용자가 아무것도 안 눌러도 버튼이 🟢으로 돌아온다. 한도에 걸린 호출은 거절되므로 사용량은 안 나간다
// 계정이 **밖에서** 바뀐 것을 알아챈다 (2026-08, BRIDGE_V=26).
// 터미널이나 브라우저에서 다른 계정으로 로그인하면 자격증명 파일은 바뀌지만, 이미 떠 있는 claude
// 세션은 시동할 때 받은 옛 계정 입장권을 그대로 쓴다 → 새 계정에 사용량이 남아 있어도 "한도 초과"가
// 계속 나온다(2026-08 실측 신고: "새 계정으로 로그인했는데 왜 그 계정 사용량을 못 쓰냐").
// 플러그인을 거친 로그인·로그아웃(/open-login·/claude-logout)은 killProc으로 세션을 버려서 이 문제가
// 없었는데, 밖에서 바꾸면 다리가 알 방법이 없었다. 그래서 /health 조회마다 파일의 계정과 비교한다.
// 비용 0(파일만 읽고, claudeAccount의 30초 캐시를 그대로 쓴다 — .claude.json이 커서 매번 읽지 않는다).
// 계정 있음 → 없음(로그아웃) 방향은 건드리지 않는다: 파일을 덮어쓰는 순간 잠깐 못 읽는 것과
// 구분되지 않아 헛 재시작을 부르고, 그 방향은 인증 오류 경로(isAuthError)가 이미 처리한다.
function restartIfAccountChanged() {
  if (!proc || waiter) return;         // 세션 없음(다음 턴이 새로 시동) / 턴 진행 중이면 다음 조회에서
  const now = claudeAccount();
  if (!now || now === sessionAccount) return;
  console.log('[bridge] 계정이 바뀌었어요 (' + (sessionAccount || '없음') + ' → ' + now + ') — 옛 계정 세션을 버리고 새 계정으로 다시 시작합니다.');
  // 의도적 종료(reason 지정) — SESSION_DIED로 끝내면 자동 재시도가 옛 계정 세션을 되살린다
  killProc('계정이 바뀌어서 세션을 새로 시작했어요 — 다시 시도해 주세요.');
  claudeStatus = null; // 한도·로그인 상태는 계정마다 다르다 — 새 계정으로 다시 판정하게
  sessionAccount = now;
}

let lastAuthRetryAt = 0;
function retryAuthIfNeeded() {
  if (claudeStatus !== 'claude-logout' && claudeStatus !== 'claude-limit') return;
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
  if (e && e.message === LIMIT_GUIDE) return { error: LIMIT_GUIDE, problem: 'claude-limit' };
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
    restartIfAccountChanged(); // 밖에서 계정을 바꿨으면 옛 계정 세션을 먼저 버린다 (아래 워밍업이 옛 계정으로 돌지 않게)
    retryAuthIfNeeded(); // 로그인 필요 상태면 재확인 시도 — 재로그인이 끝났으면 다음 조회부터 problem이 풀린다
    return json(res, 200, {
      ok: true, engine: 'claude', v: BRIDGE_V, dir: __dirname, // v·dir: 구버전/엉뚱한 사본이 떠 있는지 진단용
      model: currentModel, models: ALLOWED_MODELS, examples: EXAMPLES.length, guide: GUIDE.length, ready: warmedUp,
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
    const body = await readBody(req);
    const switchMode = !!(body && body.switchAccount); // 계정 전환 = 시크릿 창으로 열어 계정을 고를 수 있게
    try {
      // claude가 없으면 여기서 끊는다. shell:true라 claude가 없어도 셸은 정상 실행돼
      // spawn의 'error'가 안 뜨고, 예전엔 그대로 ok:true를 돌려줬다 —
      // 플러그인은 "브라우저를 열었어요"라고 하는데 실제로는 아무것도 안 뜨는 상태가 됐다(실제 신고).
      if (claudeStatus === 'claude-missing') {
        return json(res, 501, {
          error: '이 PC에 Claude Code가 없어요 — 터미널에서 claude --version 이 되는지 확인해 주세요.',
          problem: 'claude-missing',
        });
      }
      // 진행 중인데 또 눌렀다 — 금방(60초 내) 다시 누른 건 "창을 닫았다/못 봤다"에 가까우므로 브라우저로 재시도한다.
      // 한참 뒤에도 또 누르는 건 브라우저가 localhost 콜백에 못 닿아 자동 완료가 안 되는 환경일 수 있으니
      // 그때만 코드를 붙여넣을 수 있는 터미널 방식으로 폴백한다 (두 번째 클릭에 터미널이 튀어나오면 당황스럽다).
      const stale = loginProc && (Date.now() - loginStartedAt > 60000);
      if (loginProc && stale) {
        killLoginProc();
        if (!openLoginTerminal()) {
          return json(res, 501, { error: '이 OS에선 자동으로 못 열어요 — 터미널에서 claude 실행 후 /login 해 주세요.' });
        }
        // 의도적 종료(reason 지정) — 진행 중 턴을 SESSION_DIED로 끝내면 자동 재시도가 옛 계정 세션을 되살린다
        killProc('로그인을 진행하는 중이라 요청을 중단했어요 — 로그인 후 다시 시도해 주세요.');
        accountCache.at = 0;
        console.log('[bridge] 로그인 폴백 — 터미널 방식으로 전환.');
        return json(res, 200, { ok: true, mode: 'terminal' });
      }
      killLoginProc(); // 앞선 브라우저 로그인이 대기 중이면 접고 새로 연다 (창을 닫았거나 다시 누른 경우)
      loginStartedAt = Date.now();
      // 계정 전환이면 우리가 시크릿 창으로 연다(위 '계정 전환은 시크릿 창으로' 주석):
      //   BROWSER=no-op으로 CLI의 브라우저 열기를 막고, stdout에 찍히는 URL 전문을 잡아서 우리가 연다.
      // 만료 재로그인(normal)은 같은 계정이라 세션이 남아 있는 게 빠르다 → 건드리지 않고 CLI가 직접 연다.
      const privateLogin = !!switchMode;
      const thisLogin = spawn('claude', ['auth', 'login', '--claudeai'], {
        shell: true,
        env: privateLogin ? Object.assign({}, CLAUDE_ENV, { BROWSER: writeNoopBrowser() }) : CLAUDE_ENV,
        stdio: privateLogin ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        windowsHide: true,
        detached: process.platform !== 'win32', // killLoginProc의 그룹 kill용 (killProc과 동일 패턴)
      });
      loginProc = thisLogin;
      if (privateLogin) {
        let out = '';
        let opened = false;
        const scan = (chunk) => {
          if (opened) return;
          out += chunk.toString();
          const m = out.match(/https:\/\/\S*\/oauth\/authorize\?\S+/);
          if (!m) return;
          opened = true;
          // 끝에 붙은 따옴표·괄호류만 떼어낸다 (URL 자체엔 안 쓰이는 문자들)
          const url = m[0].replace(/["'<>)\]]+$/, '');
          if (!openPrivateWindow(url) && !openDefaultBrowser(url)) {
            console.log('[bridge] 로그인 화면을 못 열었어요 — 이 주소로 직접 로그인해 주세요: ' + url);
          }
        };
        thisLogin.stdout.on('data', scan);
        thisLogin.stderr.on('data', scan);
        // URL이 안 잡히면(출력 형식이 바뀐 등) 아무 창도 안 뜬 채 막힌다 — BROWSER를 no-op으로 막아 뒀기 때문.
        // 그 경우 한 번만 옛 방식(CLI가 직접 열기)으로 다시 시도한다.
        setTimeout(() => {
          if (opened || loginProc !== thisLogin) return;
          console.log('[bridge] 로그인 URL을 못 찾았어요 — CLI가 직접 브라우저를 여는 방식으로 다시 시도합니다.');
          killLoginProc();
          const retry = spawn('claude', ['auth', 'login', '--claudeai'], {
            shell: true, env: CLAUDE_ENV, stdio: 'ignore', windowsHide: true,
            detached: process.platform !== 'win32',
          });
          loginProc = retry;
          retry.on('error', () => { if (loginProc === retry) loginProc = null; });
          retry.on('close', () => { if (loginProc === retry) { loginProc = null; accountCache.at = 0; } });
        }, 15000);
      }
      thisLogin.on('error', () => { if (loginProc === thisLogin) loginProc = null; });
      thisLogin.on('close', (code) => {
        if (loginProc !== thisLogin) return;
        loginProc = null;
        if (loginProcTimer) { clearTimeout(loginProcTimer); loginProcTimer = null; }
        accountCache.at = 0; // 새 계정일 수 있으니 다음 /health 때 다시 읽기
        console.log('[bridge] 브라우저 로그인 절차 종료 (code ' + code + ')');
        // 사람이 로그인할 시간도 없이 곧바로 실패로 끝났다 = claude가 없거나 실행이 안 된 것.
        // 응답은 이미 보냈으니 상태를 다시 재서 /health로 알린다 (플러그인이 대기 화면을 실패로 바꾼다).
        if (code !== 0 && Date.now() - loginStartedAt < 5000) {
          console.log('[bridge] 로그인이 즉시 실패로 끝남 — Claude Code 설치 상태를 다시 점검합니다.');
          checkClaudeAvailable();
        }
      });
      loginProcTimer = setTimeout(() => { console.log('[bridge] 로그인 10분 경과 — 대기 프로세스 정리.'); killLoginProc(); }, 600000);
      // 낡은 입장권을 물고 있는 대기 세션은 버린다 — 재로그인 후 다음 요청이 새 세션(새 입장권)으로 시작하게.
      // 의도적 종료(reason 지정) — SESSION_DIED로 끝내면 자동 재시도가 옛 계정 세션을 되살려
      // 재로그인 뒤에도 MAX_TURNS까지 옛 계정으로 처리되는 버그가 된다 (2026-07 리뷰에서 확인)
      killProc('로그인을 진행하는 중이라 요청을 중단했어요 — 로그인 후 다시 시도해 주세요.');
      accountCache.at = 0;
      console.log('[bridge] 브라우저 로그인 시작' + (switchMode ? ' (계정 전환 — 시크릿 창으로 열어 로그인 화면부터 보여줍니다)' : '') + ' — 로그인하면 자동 연결됩니다.');
      return json(res, 200, { ok: true, mode: switchMode ? 'browser-switch' : 'browser' });
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
  // 클로드 계정 로그아웃 — 플러그인 홈의 [로그아웃] 버튼이 호출. claude auth logout으로 CLI 로그인을 해제한다.
  // (이 PC의 저장된 자격증명을 지운다 — 다시 쓰려면 재로그인 필요.) 로그아웃 후엔 세션·계정캐시를 정리한다.
  if (req.method === 'POST' && req.url === '/claude-logout') {
    const lo = spawn('claude', ['auth', 'logout'], { shell: true, env: CLAUDE_ENV, windowsHide: true });
    let err = '';
    lo.stderr.on('data', (d) => { err += d.toString(); });
    lo.on('error', (e) => { json(res, 500, { ok: false, error: '로그아웃 실행 실패: ' + e.message }); });
    lo.on('close', (code) => {
      killProc('로그아웃해서 요청을 중단했어요.'); // 의도적 종료 — 자동 재시도가 세션을 되살리면 안 됨
      accountCache.at = 0;        // 다음 /account·/health에서 계정을 새로(=없음으로) 읽게
      claudeStatus = null;        // 상태 재판정(다음 턴에서 미로그인 감지)
      console.log('[bridge] 클로드 로그아웃 (code ' + code + ')');
      if (res.headersSent) return; // error 핸들러가 이미 응답했으면 중복 방지
      if (code === 0) json(res, 200, { ok: true });
      else json(res, 500, { ok: false, error: (err.trim().slice(0, 150)) || ('종료 코드 ' + code) });
    });
    return;
  }
  // 자기 종료 — 플러그인 STOP_BRIDGE/하트비트가 호출한다 (로컬에서만 접근 가능하니 안전)
  if (req.method === 'POST' && req.url === '/shutdown') {
    json(res, 200, { ok: true });
    console.log('[bridge] 종료 요청 받음 — 다리를 끕니다.');
    shuttingDown = true;
    killProc();
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (req.method === 'POST' && req.url === '/recommend') {
    const { text, model, role } = await readBody(req);
    if (!text || !String(text).trim()) return json(res, 400, { error: '추천받을 문구가 비어 있습니다.' });
    const started = Date.now();
    console.log('[bridge] 추천 요청:', String(text).slice(0, 50).replace(/\n/g, ' ') + '…', role ? '[' + role + ']' : '', model ? '(모델: ' + model + ')' : '');
    try {
      const r = await askClaude(String(text).trim(), model, { parse: parseSuggestions, formatDesc: '[{"text": "문구", "reason": "이유"}, ...]' }, role);
      const suggestions = r.parsed || [];
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      if (!suggestions.length) {
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
  // 프레임별 추천 — 한 화면을 하위 프레임(영역) 단위로 나눠 받고, 영역마다 따로 대안을 낸다.
  // 영역 수만큼 요청을 쪼개지 않는 것이 핵심 (느려지고 사용량도 그만큼 나간다).
  if (req.method === 'POST' && req.url === '/recommend-groups') {
    const { groups, model, more } = await readBody(req);
    const list = Array.isArray(groups)
      ? groups
          .map((g) => ({
            name: String((g && g.name) || '').trim(),
            texts: (g && Array.isArray(g.texts) ? g.texts : []).map((t) => String(t || '').trim()).filter(Boolean),
            role: (g && g.role) ? String(g.role) : undefined,
          }))
          .filter((g) => g.texts.length)
      : [];
    if (list.length < 2) return json(res, 400, { error: '영역이 부족합니다.' });
    const started = Date.now();
    console.log('[bridge] 프레임별 추천 요청: 영역 ' + list.length + '개' + (more ? ' (더 받기)' : ''), model ? '(모델: ' + model + ')' : '');
    try {
      const r = await askGroups(list, model, { parse: parseGroups, formatDesc: '{"groups": [{"name": "영역 이름", "suggestions": [{"text": "대안", "reason": "이유"}]}]}' }, !!more);
      const out = r.parsed;
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      if (!out) return json(res, 502, { error: '클로드 응답을 해석하지 못했어요.' });
      console.log('[bridge] 프레임별 제안 ' + out.reduce((n, g) => n + g.suggestions.length, 0) + '개 / 영역 ' + out.length + '개 (' + sec + 's)');
      stats.served++;
      stats.lastAt = new Date().toLocaleTimeString('ko-KR');
      stats.lastText = '[프레임별] ' + String((list[0] && list[0].texts[0]) || '').slice(0, 24);
      stats.lastSec = sec;
      return json(res, 200, { groups: out, engine: 'claude' });
    } catch (e) {
      console.log('[bridge] 프레임별 추천 실패:', e.message);
      return json(res, 502, friendlyError(e, '클로드 호출 실패: '));
    }
  }
  // 팝업 요소별 추천 — 한 팝업의 구성요소(역할+문구)를 한 번에 받아 역할별로 다듬는다.
  // 요소를 함께 보내야 타이틀이 본문 맥락을 참조할 수 있다(요소별 개별 요청과의 차이).
  if (req.method === 'POST' && req.url === '/recommend-popup') {
    const { elements, model, more } = await readBody(req);
    const list = Array.isArray(elements) ? elements.filter((e) => e && String(e.text || '').trim()) : [];
    if (list.length < 2) return json(res, 400, { error: '팝업 요소가 부족합니다.' });
    const started = Date.now();
    console.log('[bridge] 팝업 추천 요청: 요소 ' + list.length + '개' + (more ? ' (더 받기)' : ''), model ? '(모델: ' + model + ')' : '');
    try {
      const r = await askPopup(list, model, { parse: parsePopup, formatDesc: '{"sets": [{"reason": "방향 한 문장", "elements": [{"role": "역할", "text": "문구"}, ...]}, ...]}' }, !!more);
      const sets = r.parsed;
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      if (!sets) {
        return json(res, 502, { error: '클로드 응답을 해석하지 못했어요.' });
      }
      console.log('[bridge] 팝업 세트 ' + sets.length + '개 (' + sec + 's)');
      stats.served++;
      stats.lastAt = new Date().toLocaleTimeString('ko-KR');
      stats.lastText = '[팝업] ' + String((list[0] && list[0].text) || '').slice(0, 24);
      stats.lastSec = sec;
      return json(res, 200, { sets, engine: 'claude' });
    } catch (e) {
      console.log('[bridge] 팝업 실패:', e.message);
      return json(res, 502, friendlyError(e, '클로드 호출 실패: '));
    }
  }
  // 대화형 문구 제작 — 상황을 설명하면 문구를 만들어준다 (추천과 같은 세션, 대화는 매 요청에 통째로 실림)
  if (req.method === 'POST' && req.url === '/compose') {
    const { messages, model } = await readBody(req);
    const list = Array.isArray(messages) ? messages.filter((m) => m && String(m.text || '').trim()) : [];
    if (!list.length) return json(res, 400, { error: '대화 내용이 비어 있습니다.' });
    const started = Date.now();
    const lastUser = [...list].reverse().find((m) => m.role !== 'assistant');
    console.log('[bridge] 제작 대화 요청:', String((lastUser && lastUser.text) || '').slice(0, 50).replace(/\n/g, ' ') + '… (대화 ' + list.length + '개)');
    try {
      // 대화가 길어지면 최근 12개만 (프롬프트 폭주 방지)
      const r = await askCompose(list.slice(-12), model, { parse: parseCompose, formatDesc: '{"reply": "대화 응답 한두 문장", "suggestions": [{"text": "문구", "reason": "이유"}, ...]}' });
      const out = r.parsed;
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      if (!out) {
        return json(res, 502, { error: '클로드 응답을 해석하지 못했어요.' });
      }
      console.log('[bridge] 제작 응답 (' + sec + 's, 제안 ' + out.suggestions.length + '개)');
      stats.served++;
      stats.lastAt = new Date().toLocaleTimeString('ko-KR');
      stats.lastText = String((lastUser && lastUser.text) || '').slice(0, 30);
      stats.lastSec = sec;
      return json(res, 200, { reply: out.reply, suggestions: out.suggestions, engine: 'claude' });
    } catch (e) {
      console.log('[bridge] 제작 실패:', e.message);
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
      const r = await askTranslate(String(text).trim(), model, { parse: parseTranslate, formatDesc: '{"translated": "번역문 (줄바꿈은 \\n)", "direction": "ko→en 또는 en→ko"}' });
      const out = r.parsed;
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      if (!out) {
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
// IPv6 루프백(::1)에도 함께 듣는다 — macOS 등에서 'localhost'가 ::1로 먼저 해석되는데
// 피그마(Electron) fetch는 curl과 달리 IPv4로 자동 폴백하지 않아, IPv4만 듣던 다리에 연결이 거부돼
// 추천·헬스체크가 조용히 실패했다(실측 2026-07). 같은 요청 핸들러를 IPv6 루프백에도 얹는다.
const server6 = http.createServer(server.listeners('request')[0]);
server6.on('error', (e) => console.log('[bridge] IPv6(::1) 리슨 생략 — IPv4만 사용:', e && e.message));
server6.listen(PORT, '::1');
