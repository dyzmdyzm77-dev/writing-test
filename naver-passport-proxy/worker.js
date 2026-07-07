// 에스원 UX Writing Checker — Cloudflare Worker (심부름꾼)
// ─────────────────────────────────────────────────────────────
// 경로별 역할:
//   GET  /            → 네이버 맞춤법 passportKey (기존 기능)
//   POST /translate   → 한국어 ↔ 영어 번역 (Gemini)
//   POST /recommend   → UX 문구 대안 3개 추천 (Gemini)
//
// 왜 워커가 필요한가:
//   1) 네이버 검색페이지는 CORS 헤더가 없어 플러그인에서 직접 못 긁는다 → 여기서 대신 긁는다.
//   2) Gemini API 키를 플러그인(클라이언트)에 노출하지 않으려고 서버(=워커)에서만 호출한다.
//
// ※ "오수정 제보" 저장/열람은 이 워커가 아니라 별도 Vercel 앱(ux-writing-reports)에서 처리한다.
//    저장: POST https://report-admin-weld.vercel.app/api/report, 관리자: https://report-admin-weld.vercel.app/
//
// 배포:
//   Cloudflare 대시보드 → Workers & Pages → 이 워커 → Settings → Variables and Secrets
//   에 GEMINI_API_KEY 라는 이름으로 무료 키를 넣고(Encrypt 권장), 이 파일을 붙여넣어 Deploy.
//   무료 키 발급: https://aistudio.google.com/apikey (구글 계정 로그인 → Create API key)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

// 무료 등급에서 쓸 수 있는 모델. 한국어 품질이 좋고 응답이 빠르다.
const GEMINI_MODEL = 'gemini-2.0-flash';

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
async function callGemini(env, prompt) {
  if (!env || !env.GEMINI_API_KEY) {
    return { error: 'GEMINI_API_KEY 미설정 (워커 Variables에 키를 추가하세요)' };
  }
  try {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      GEMINI_MODEL +
      ':generateContent?key=' +
      env.GEMINI_API_KEY;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7 },
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return { error: 'Gemini HTTP ' + res.status + ': ' + detail.slice(0, 300) };
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
    return { text: String(text).trim() };
  } catch (e) {
    return { error: 'Gemini 호출 실패: ' + String(e && e.message ? e.message : e) };
  }
}

// 요청 본문에서 text 안전하게 꺼내기
async function readText(request) {
  try {
    const body = await request.json();
    return body && typeof body.text === 'string' ? body.text : '';
  } catch (_e) {
    return '';
  }
}

// ── 번역 (한국어 ↔ 영어 자동) ────────────────────────────────
async function handleTranslate(request, env) {
  const text = (await readText(request)).trim();
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
  const out = await callGemini(env, prompt);
  if (out.error) {
    return Response.json({ error: out.error }, { status: 502, headers: CORS });
  }
  // 한글 포함 여부로 방향 라벨만 붙여줌 (표시용)
  const hadKorean = /[가-힣]/.test(text);
  return Response.json(
    { translated: out.text, direction: hadKorean ? 'ko->en' : 'en->ko' },
    { headers: CORS }
  );
}

// ── 문구 추천 (UX writing 대안 3개) ──────────────────────────
async function handleRecommend(request, env) {
  const text = (await readText(request)).trim();
  if (!text) {
    return Response.json({ error: '추천받을 문구가 비어 있습니다.' }, { status: 400, headers: CORS });
  }
  const prompt =
    'You are a Korean UX writing expert for 에스원(S-1), a security company. ' +
    'Given a UI text, propose 3 improved Korean alternatives that are clearer, more concise, ' +
    'and use a polite "해요체" tone appropriate for an app UI. Keep the original meaning. ' +
    'Return ONLY a JSON array of exactly 3 strings in Korean. ' +
    'No markdown, no code fences, no explanation.\n\n' +
    'Text:\n' +
    text;
  const out = await callGemini(env, prompt);
  if (out.error) {
    return Response.json({ error: out.error }, { status: 502, headers: CORS });
  }
  return Response.json({ suggestions: parseSuggestions(out.text) }, { headers: CORS });
}

// Gemini가 준 텍스트에서 문자열 배열 추출 (JSON 우선, 실패하면 줄 단위 폴백)
function parseSuggestions(raw) {
  let s = String(raw).trim();
  // ```json ... ``` 같은 코드펜스 제거
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
    }
  } catch (_e) {
    // 폴백: 줄 단위로 나누고 앞의 번호/기호 제거
  }
  return s
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}
