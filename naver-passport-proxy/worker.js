// 에스원 UX Writing Checker — Cloudflare Worker (심부름꾼)
// ─────────────────────────────────────────────────────────────
// 경로별 역할:
//   GET  /            → 네이버 맞춤법 passportKey (기존 기능)
//   POST /translate   → 한국어 ↔ 영어 번역 (Gemini)
//   POST /recommend   → UX 문구 대안 3개 추천 (Gemini)
//
// 왜 워커가 필요한가:
//   1) 네이버 검색페이지는 CORS 헤더가 없어 플러그인에서 직접 못 긁는다 → 여기서 대신 긁는다.
//   2) Gemini는 CORS 때문에 플러그인에서 직접 호출이 불안정 → 워커가 대신 호출한다.
//
// ★ API 키 정책: 개인 키 방식.
//   추천/번역 요청 본문에 각 사용자의 Gemini 키(apiKey)가 실려 오고, 워커는 그 키로 호출만 한다(저장 안 함).
//   → 워커에 공유 GEMINI_API_KEY를 둘 필요가 없다. 무료 할당량도 사용자별로 각자 소모된다.
//   무료 키 발급: https://aistudio.google.com/apikey (구글 계정 로그인 → Create API key)
//
// ※ "오수정 제보" 저장/열람은 이 워커가 아니라 별도 Vercel 앱(ux-writing-reports)에서 처리한다.
//    저장: POST https://report-admin-weld.vercel.app/api/report, 관리자: https://report-admin-weld.vercel.app/

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

// 무료 등급에서 쓸 수 있는 모델. 한국어 품질이 좋고 응답이 빠르다.
// 주의: gemini-2.0-flash는 무료 할당량이 0이 되어 429가 남 (2026-07 확인) — 2.5 계열을 쓸 것.
const GEMINI_MODEL = 'gemini-2.5-flash';
// 주 모델이 혼잡(503)하거나 분당 한도(429)에 걸리면 이 예비 모델로 자동 재시도
const GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash-lite';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const path = new URL(request.url).pathname;

    if (path === '/translate') return handleTranslate(request, env);
    if (path === '/recommend') return handleRecommend(request, env);

    // 루트(/)만 네이버 passportKey 반환 (플러그인이 맞춤법 검사에 사용)
    if (path === '/') return handlePassportKey();

    // 그 외 경로는 passportKey가 새지 않도록 404
    return Response.json({ error: 'Not found' }, { status: 404, headers: CORS });
  },
};

// ── 네이버 맞춤법 passportKey ────────────────────────────────
async function handlePassportKey() {
  try {
    const res = await fetch(
      'https://search.naver.com/search.naver?query=' + encodeURIComponent('맞춤법검사기'),
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
    );
    if (!res.ok) {
      return Response.json({ error: '검색페이지 HTTP ' + res.status }, { status: 502, headers: CORS });
    }
    const html = await res.text();
    const m = html.match(/passportKey=([0-9a-zA-Z]+)/);
    if (!m) {
      return Response.json({ error: 'passportKey 못 찾음 (페이지 길이 ' + html.length + ')' }, { status: 502, headers: CORS });
    }
    return Response.json({ passportKey: m[1] }, { headers: CORS });
  } catch (e) {
    return Response.json({ error: String(e && e.message ? e.message : e) }, { status: 502, headers: CORS });
  }
}

// ── Gemini 호출 공통 ─────────────────────────────────────────
// apiKey는 요청 본문에서 온 개인 키. 주 모델로 호출하고, 혼잡(503)·분당 한도(429)면 예비 모델로 한 번 더 시도한다.
// schema를 주면 구조화 출력(responseSchema)으로 JSON 형식을 강제한다
// (추천 문구 안에 줄바꿈이 있어도 JSON이 깨지지 않는다 — 깨지면 줄 단위 폴백으로 문장이 쪼개져 보임)
// 성공 시 { text, usage } 반환 — usage는 Gemini usageMetadata(토큰 수), 플러그인이 사용량 표시에 씀.
async function callGemini(apiKey, prompt, schema) {
  if (!apiKey) {
    return { error: 'Gemini API 키가 없어요. 플러그인 설정에서 개인 키를 넣어주세요.' };
  }
  const first = await callGeminiModel(apiKey, GEMINI_MODEL, prompt, schema);
  if (!first.retryable) return first;
  const second = await callGeminiModel(apiKey, GEMINI_FALLBACK_MODEL, prompt, schema);
  return second.retryable ? { error: second.error } : second;
}

async function callGeminiModel(apiKey, model, prompt, schema) {
  try {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      model +
      ':generateContent?key=' +
      apiKey;
    // thinkingBudget 0: 2.5 모델의 '생각' 단계를 꺼서 응답을 ~8배 빠르게 (7초 → 1초, 짧은 문구 작업엔 품질 차이 미미)
    const generationConfig = { temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } };
    if (schema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = schema;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return {
        error: 'Gemini(' + model + ') HTTP ' + res.status + ': ' + detail.slice(0, 300),
        retryable: res.status === 503 || res.status === 429, // 혼잡/한도 → 예비 모델로 재시도 가능
      };
    }
    const data = await res.json();
    const text =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;
    if (!text) return { error: 'Gemini 응답 비어 있음' };
    const um = data && data.usageMetadata;
    const usage = {
      prompt: (um && um.promptTokenCount) || 0,
      output: (um && um.candidatesTokenCount) || 0,
      total: (um && um.totalTokenCount) || 0,
      model: model,
    };
    return { text: String(text).trim(), usage };
  } catch (e) {
    return { error: 'Gemini 호출 실패: ' + String(e && e.message ? e.message : e) };
  }
}

// 요청 본문에서 text / apiKey 안전하게 꺼내기
async function readBody(request) {
  try {
    const body = await request.json();
    return {
      text: body && typeof body.text === 'string' ? body.text : '',
      apiKey: body && typeof body.apiKey === 'string' ? body.apiKey.trim() : '',
    };
  } catch (_e) {
    return { text: '', apiKey: '' };
  }
}

// ── 번역 (한국어 ↔ 영어 자동) ────────────────────────────────
async function handleTranslate(request, _env) {
  const { text: rawText, apiKey } = await readBody(request);
  const text = rawText.trim();
  if (!text) {
    return Response.json({ error: '번역할 텍스트가 비어 있습니다.' }, { status: 400, headers: CORS });
  }
  const prompt =
    'You are a translator for app/UI microcopy. Detect the language of the input text. ' +
    'If it is Korean, translate it into natural, concise English suitable for a mobile/app UI. ' +
    'If it is English (or any non-Korean), translate it into natural Korean using a polite "해요체" tone suitable for a UI. ' +
    'Preserve line breaks. Do not add quotes, labels, or explanations. ' +
    'Return ONLY the translated text.\n\n' +
    'Input:\n' +
    text;
  const out = await callGemini(apiKey, prompt);
  if (out.error) {
    return Response.json({ error: out.error }, { status: 502, headers: CORS });
  }
  // 한글 포함 여부로 방향 라벨만 붙여줌 (표시용)
  const hadKorean = /[가-힣]/.test(text);
  return Response.json(
    { translated: out.text, direction: hadKorean ? 'ko->en' : 'en->ko', usage: out.usage || null },
    { headers: CORS }
  );
}

// ── 문구 추천 (UX writing 대안 3개) ──────────────────────────

// ===== RECOMMEND:BEGIN — 자동 생성 영역. 직접 수정하지 말고 recommend-examples.md를 고친 뒤 npm run build =====
const RECOMMEND_EXAMPLES = [
  { input: "진행하던 작업이 있습니다. 계속하시겠습니까?", suggestions: ["진행 중인 내역이 있어요.\n이어서 진행할까요?"] },
  { input: "공유 요청을 취소하면 요청 내역이 삭제됩니다. 취소하시겠습니까?", suggestions: ["취소할 경우 요청 내역도 삭제돼요.\n공유 요청을 취소할까요?"] },
  { input: "기기를 찾지 못했습니다. QR코드를 다시 스캔하세요.", suggestions: ["기기를 찾을 수 없어요.\nQR코드를 다시 스캔해 주세요."] },
  { input: "보호자가 허락하기 전에는 가입할 수 없어요", suggestions: ["보호자가 허락해야 가입할 수 있어요"] },
  { input: "지금 버전에서는 쓸 수 없어요. 생체 인증을 쓰려면 앱을 최신 버전으로 업데이트 해주세요.", suggestions: ["앱을 업데이트해주세요.\n생체 인증을 쓰려면 최신 버전이 필요해요."] },
  { input: "어떤 목적으로 대출받으시나요?", suggestions: ["대출 목적이 무엇인가요?"] },
  { input: "어떤 이유로 신고하시나요?", suggestions: ["신고 이유를 선택해 주세요."] },
  { input: "잔액 부족으로 구매하지 못했어요", suggestions: ["잔액이 부족해서 구매하지 못했어요"] },
  { input: "홍*동(010-1234-5678) 외 2명에게 권한 삭제 알림톡을 전송할까요?", suggestions: ["권한 삭제 알림톡을 보내려고 해요.\n홍*동(010-1234-5678) 님 외 2명에게 보낼까요?","홍*동(010-1234-5678) 님 외 2명에게 권한 삭제 알림톡을 보낼까요?","권한 삭제 알림톡을 홍*동(010-1234-5678) 님 외 2명에게 보낼까요?"] },
];
// ===== RECOMMEND:END =====

// UX 라이팅 기준 (ux-writing.md 가이드 요약 — 프롬프트에 포함)
const STYLE_RULES = [
  '1. 해요체: 모든 문구는 해요체로. (보냅니다→보내요)',
  '2. 능동적 말하기: 됐어요→했어요, ~었 빼기(바뀌었어요→바꿨어요). 단, 종료·만료·연체·해지·기록·녹음 등 시스템이 주체인 결과는 수동형 유지(연체돼요, 녹음돼요).',
  '3. 긍정적 말하기: "~할 수 없어요" 대신 "~하면 할 수 있어요" 구조 우선. 단, 정책상 불가·일부 기능 제한·되돌릴 수 없는 결과·정보 보호 안심은 부정형으로 명확히.',
  '4. 캐주얼한 경어: ~하시겠어요?→~할까요?, 계시다→있다, 여쭈다→확인하다, 께→에게. ~시 빼기가 어색하면 파악하려는 정보를 주어로 문장을 다시 쓴다(어떤 목적으로 대출받으시나요?→대출 목적이 무엇인가요?). 단, 사용자의 맥락·추정·선의가 필요한 질문은 셨나요? 허용.',
  '5. 명사+명사 금지: 한자어를 풀어 동사로(이자 환불을 받았어요→이자를 돌려받았어요), 최소한 {명사}가 {명사}해서 형태로(잔액 부족으로→잔액이 부족해서).',
  '6. 표기: 되어요→돼요. 알림톡·2명처럼 붙여 쓰는 표기 유지.',
  '7. 줄 구조는 원본을 따른다: 원본이 한 줄이면 추천도 반드시 한 줄로. 원본에 줄바꿈이 있으면 그 구조를 유지. 임의로 줄을 나누지 않는다.',
  '8. 다이얼로그 왼쪽 버튼 라벨은 "닫기"(취소 금지).',
  '9. 이름·전화번호·마스킹(홍*동, 010-1234-5678)은 그대로 보존. 사람을 부를 땐 님을 붙여도 좋다.',
].join('\n');

// 추천 응답 형식 강제: 정확히 {text, reason} 객체 배열 (Gemini 구조화 출력)
const RECOMMEND_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      text: { type: 'STRING', description: '제안 문구. 원본에 줄바꿈이 있으면 같은 위치에 줄바꿈 유지' },
      reason: { type: 'STRING', description: '무엇을 왜 바꿨는지 — 한국어 한 문장' },
    },
    required: ['text', 'reason'],
  },
};

async function handleRecommend(request, _env) {
  const { text: rawText, apiKey } = await readBody(request);
  const text = rawText.trim();
  if (!text) {
    return Response.json({ error: '추천받을 문구가 비어 있습니다.' }, { status: 400, headers: CORS });
  }
  // 예시(few-shot): recommend-examples.md에서 자동 주입된 원본→추천 쌍을 보여줘 톤을 고정한다.
  // 예시의 줄바꿈은 화면 레이아웃용이므로 공백으로 펴서 보여준다 — AI가 "줄 쪼개기"를 배우지 않게 (줄 구조는 규칙 7이 결정)
  const fewShot = RECOMMEND_EXAMPLES.map((ex) =>
    'Input: ' + JSON.stringify(ex.input) +
    '\nOutput: ' + JSON.stringify(ex.suggestions.map((s) => s.replace(/\n/g, ' ')))
  ).join('\n\n');
  const prompt =
    'You are a Korean UX writing expert for 에스원(S-1), a security company. ' +
    'Given a UI text, propose 3 improved Korean alternatives that are clearer, more concise, ' +
    'and follow the style rules below. Keep the original meaning.\n' +
    'NEVER drop information: every name, number, condition, target, and clause in the input must appear in EVERY suggestion (rephrased is fine, omitted is not).\n' +
    'Every suggestion MUST differ from the input text AND from each other — never return the input unchanged. ' +
    'If the input already follows the rules well, still offer genuinely different alternatives ' +
    '(different sentence structure, warmth, or a more helpful angle).\n\n' +
    '[Style rules]\n' + STYLE_RULES + '\n\n' +
    (fewShot ? '[Examples of our voice — match this tone]\n' + fewShot + '\n\n' : '') +
    'Return ONLY a JSON array of exactly 3 objects, no markdown, no code fences:\n' +
    '[{"text": "제안 문구", "reason": "무엇을 왜 바꿨는지 — 한국어 한 문장, 적용한 규칙 언급"}, ...]\n' +
    'reason examples: "딱딱한 한자어를 풀어 썼어요 (잠금 처리→잠겼어요)", "과도한 경어를 뺐어요 (~하시겠어요?→~할까요?)", "상황을 먼저 알리고 행동을 묻는 구조로 바꿨어요".\n\n' +
    'Text:\n' +
    text;
  const out = await callGemini(apiKey, prompt, RECOMMEND_SCHEMA);
  if (out.error) {
    return Response.json({ error: out.error }, { status: 502, headers: CORS });
  }
  // 안전망: 원본과 같은 제안·중복 제안은 걸러낸다 (모델이 "고칠 게 없다"며 원본을 반납하는 경우)
  const normalize = (s) => s.replace(/\s+/g, ' ').trim();
  const inputNorm = normalize(text);
  const seen = new Set();
  const suggestions = parseSuggestions(out.text).filter((s) => {
    const k = normalize(s.text);
    if (!k || k === inputNorm || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!suggestions.length) {
    // Gemini는 호출됐으므로(할당량 소모) usage를 함께 내려 플러그인이 사용량을 반영하게 한다
    return Response.json({ error: '원본이 이미 가이드 기준에 잘 맞는 문구예요.', usage: out.usage || null }, { status: 200, headers: CORS });
  }
  return Response.json({ suggestions, usage: out.usage || null }, { headers: CORS });
}

// Gemini가 준 텍스트에서 {text, reason} 배열 추출 (JSON 우선, 실패하면 줄 단위 폴백)
function parseSuggestions(raw) {
  let s = String(raw).trim();
  // ```json ... ``` 같은 코드펜스 제거
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return arr
        .map((x) => {
          if (typeof x === 'string') return { text: x.trim(), reason: '' };
          if (x && typeof x.text === 'string') return { text: x.text.trim(), reason: String(x.reason || '').trim() };
          return null;
        })
        .filter((x) => x && x.text)
        .slice(0, 3);
    }
  } catch (_e) {
    // 폴백: 줄 단위로 나누고 앞의 번호/기호 제거
  }
  return s
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((t) => ({ text: t, reason: '' }));
}
