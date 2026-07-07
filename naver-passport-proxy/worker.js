// 에스원 UX Writing Checker — Cloudflare Worker (심부름꾼)
// ─────────────────────────────────────────────────────────────
// 경로별 역할:
//   GET  /            → 네이버 맞춤법 passportKey (기존 기능)
//   POST /translate   → 한국어 ↔ 영어 번역 (Gemini)
//   POST /recommend   → UX 문구 대안 3개 추천 (Gemini)
//   POST /report      → "이 수정안 잘못됐어요" 오수정 제보 저장 (Cloudflare KV)
//   GET  /admin       → 저장된 제보를 모아 보는 관리자 웹페이지 (키 없이 접속)
//
// 왜 워커가 필요한가:
//   1) 네이버 검색페이지는 CORS 헤더가 없어 플러그인에서 직접 못 긁는다 → 여기서 대신 긁는다.
//   2) Gemini API 키를 플러그인(클라이언트)에 노출하지 않으려고 서버(=워커)에서만 호출한다.
//   3) 제보를 어딘가 쌓아두고(=KV) 관리자만 모아 볼 수 있게 한다.
//
// 배포 & 설정 (Cloudflare 대시보드 → Workers & Pages → 이 워커 → Settings):
//   1) Variables and Secrets 에 GEMINI_API_KEY (무료 키, Encrypt 권장) 추가.
//      무료 키 발급: https://aistudio.google.com/apikey (구글 로그인 → Create API key)
//   2) 제보 저장소용 KV 만들기: Storage & Databases → KV → Create namespace (예: ux-writing-reports).
//      그런 다음 이 워커 → Settings → Bindings → Add → KV namespace,
//      Variable name 은 반드시 REPORTS 로 지정하고 위에서 만든 namespace 선택.
//   3) 관리자 페이지는 별도 키 없이  https://<워커주소>/admin  으로 접속(누구나 열람 가능).
//   설정 후 이 파일을 붙여넣어 Deploy.

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
    if (path === '/report') return handleReport(request, env);
    if (path === '/admin') return handleAdmin(request, env);

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

// ── 오수정 제보 저장 (Cloudflare KV) ─────────────────────────
async function handleReport(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'POST만 허용됩니다.' }, { status: 405, headers: CORS });
  }
  if (!env || !env.REPORTS) {
    return Response.json(
      { error: 'KV(REPORTS) 미설정 — 워커 Settings > Bindings 에서 KV namespace를 REPORTS로 연결하세요.' },
      { status: 500, headers: CORS }
    );
  }
  let body;
  try {
    body = await request.json();
  } catch (_e) {
    return Response.json({ error: '본문 JSON 파싱 실패' }, { status: 400, headers: CORS });
  }
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, 4000);
  const record = {
    nodeId: str(body.nodeId),
    before: str(body.before),
    after: str(body.after),
    reason: str(body.reason),
    comment: str(body.comment),
    fileName: str(body.fileName),
    ts: new Date().toISOString(),
  };
  if (!record.before && !record.after && !record.comment) {
    return Response.json({ error: '저장할 내용이 없습니다.' }, { status: 400, headers: CORS });
  }
  // 키를 시간 역순 정렬이 쉽도록: 큰 수(=최신)가 먼저 오게 (MAX_TS - now)
  const inv = String(9999999999999 - Date.now()).padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  const key = 'report:' + inv + '-' + rand;
  try {
    await env.REPORTS.put(key, JSON.stringify(record));
  } catch (e) {
    return Response.json({ error: 'KV 저장 실패: ' + String(e && e.message ? e.message : e) }, { status: 502, headers: CORS });
  }
  return Response.json({ ok: true }, { headers: CORS });
}

// ── 관리자 페이지 (키 없이 열람) ─────────────────────────────
async function handleAdmin(request, env) {
  const url = new URL(request.url);

  if (!env || !env.REPORTS) {
    return htmlResponse(adminNotice('KV(REPORTS) 미설정', '워커 Settings > Bindings 에서 KV namespace를 <code>REPORTS</code> 로 연결하세요.'), 500);
  }

  // 삭제 요청 처리 (POST /admin&del=<reportKey>)
  if (request.method === 'POST') {
    const form = await request.formData().catch(() => null);
    const del = form && form.get('del');
    if (del) {
      try { await env.REPORTS.delete(String(del)); } catch (_e) {}
      return Response.redirect(url.origin + '/admin', 303);
    }
  }

  // 목록 조회 (키가 이미 최신순으로 정렬돼 있음)
  let items = [];
  try {
    const list = await env.REPORTS.list({ prefix: 'report:', limit: 1000 });
    const entries = await Promise.all(
      list.keys.map(async (k) => {
        const raw = await env.REPORTS.get(k.name);
        let data = {};
        try { data = JSON.parse(raw); } catch (_e) {}
        return { key: k.name, data };
      })
    );
    items = entries;
  } catch (e) {
    return htmlResponse(adminNotice('목록 조회 실패', esc(String(e && e.message ? e.message : e))), 502);
  }

  return htmlResponse(adminPage(items), 200);
}

// ── HTML 헬퍼 ────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlResponse(inner, status) {
  const html =
    '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>오수정 제보 관리자</title>' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",Roboto,sans-serif;margin:0;background:#f5f6f8;color:#222;}' +
    '.wrap{max-width:1100px;margin:0 auto;padding:24px 16px 64px;}' +
    'h1{font-size:20px;margin:8px 0 4px;}' +
    '.count{color:#666;font-size:13px;margin-bottom:16px;}' +
    'table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);}' +
    'th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top;font-size:13px;}' +
    'th{background:#fafafa;color:#555;font-weight:600;white-space:nowrap;}' +
    'td.before{color:#b00020;}td.after{color:#0a7a2f;}' +
    '.reason{display:inline-block;background:#eef3ff;color:#2f5fd0;border-radius:4px;padding:1px 6px;margin:1px 2px 1px 0;font-size:12px;}' +
    '.comment{white-space:pre-wrap;}' +
    '.meta{color:#999;font-size:12px;white-space:nowrap;}' +
    '.empty{background:#fff;border-radius:10px;padding:40px;text-align:center;color:#888;}' +
    '.del{background:#fff;border:1px solid #ddd;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;color:#b00020;}' +
    '.notice{background:#fff;border-radius:10px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08);}' +
    '.notice code{background:#f0f0f0;padding:1px 5px;border-radius:4px;}' +
    'input[type=password]{padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:14px;}' +
    'button.primary{padding:8px 14px;border:0;border-radius:6px;background:#2f88ff;color:#fff;font-size:14px;cursor:pointer;}' +
    '</style></head><body><div class="wrap">' +
    inner +
    '</div></body></html>';
  return new Response(html, {
    status: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function adminNotice(title, msg) {
  return '<h1>' + esc(title) + '</h1><div class="notice">' + msg + '</div>';
}

function adminPage(items) {
  const head =
    '<h1>오수정 제보 관리자</h1>' +
    '<div class="count">총 ' + items.length + '건 · 최신순</div>';
  if (!items.length) {
    return head + '<div class="empty">아직 접수된 제보가 없어요.</div>';
  }
  const rows = items
    .map((it) => {
      const d = it.data || {};
      const reasons = (d.reason || '')
        .split(' - ')
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => '<span class="reason">' + esc(r) + '</span>')
        .join('');
      const when = d.ts ? esc(d.ts.replace('T', ' ').slice(0, 19)) : '';
      return (
        '<tr>' +
        '<td class="meta">' + when + (d.fileName ? '<br>' + esc(d.fileName) : '') + '</td>' +
        '<td class="before">' + esc(d.before) + '</td>' +
        '<td class="after">' + esc(d.after) + '</td>' +
        '<td>' + reasons + '</td>' +
        '<td class="comment">' + esc(d.comment) + '</td>' +
        '<td><form method="post" action="/admin" onsubmit="return confirm(\'이 제보를 삭제할까요?\')">' +
        '<input type="hidden" name="del" value="' + esc(it.key) + '">' +
        '<button class="del" type="submit">삭제</button></form></td>' +
        '</tr>'
      );
    })
    .join('');
  return (
    head +
    '<table><thead><tr>' +
    '<th>시각 / 파일</th><th>원문</th><th>수정안</th><th>검토 사유</th><th>제보 코멘트</th><th></th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table>'
  );
}
