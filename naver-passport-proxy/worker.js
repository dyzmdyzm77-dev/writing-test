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
// ★ API 키 정책: 개인 키 우선 + 서버 공용 키 폴백.
//   추천/번역 요청 본문에 개인 Gemini 키(apiKey)가 있으면 그 키로 호출(저장 안 함),
//   없으면 환경변수 GEMINI_API_KEY(팀 공용 키)로 호출 — 키 없는 팀원도 플러그인만 켜면 AI를 쓴다.
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
    return { error: 'AI 키가 없어요. 관리자가 서버에 공용 키를 등록하기 전까지는 개인 키를 설정에 넣어 주세요.', noKey: true };
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
async function handleTranslate(request, env) {
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
  const out = await callGemini(apiKey || (env && env.GEMINI_API_KEY) || '', prompt);
  if (out.error) {
    return Response.json({ error: out.error, noKey: !!out.noKey }, { status: 502, headers: CORS });
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
  { input: "보호자가 허락하기 전에는 가입할 수 없어요", suggestions: ["보호자가 허락해야 가입할 수 있어요."] },
  { input: "지금 버전에서는 쓸 수 없어요. 생체 인증을 쓰려면 앱을 최신 버전으로 업데이트 해주세요.", suggestions: ["앱을 업데이트해 주세요.\n생체 인증을 쓰려면 최신 버전이 필요해요."] },
  { input: "어떤 목적으로 대출받으시나요?", suggestions: ["대출 목적이 무엇인가요?"] },
  { input: "어떤 이유로 신고하시나요?", suggestions: ["신고 이유를 선택해 주세요."] },
  { input: "잔액 부족으로 구매하지 못했어요", suggestions: ["잔액이 부족해서 구매하지 못했어요."] },
  { input: "홍*동(010-1234-5678) 외 2명에게 권한 삭제 알림톡을 전송할까요?", suggestions: ["권한 삭제 알림톡을 보내려고 해요.\n홍*동(010-1234-5678) 님 외 2명에게 보낼까요?","홍*동(010-1234-5678) 님 외 2명에게 권한 삭제 알림톡을 보낼까요?","권한 삭제 알림톡을 홍*동(010-1234-5678) 님 외 2명에게 보낼까요?"] },
  { input: "정말 삭제하시겠습니까? 삭제된 데이터는 복구할 수 없습니다.", suggestions: ["삭제하면 다시 되돌릴 수 없어요.\n정말 삭제할까요?"] },
  { input: "변경사항이 저장되지 않았습니다. 나가시겠습니까?", suggestions: ["아직 저장하지 않은 내용이 있어요.\n저장하지 않고 나갈까요?"] },
  { input: "로그아웃 하시겠습니까?", suggestions: ["로그아웃할까요?"] },
  { input: "앱을 종료하시겠습니까?", suggestions: ["앱을 종료할까요?"] },
  { input: "한 번 변경하면 다시 변경할 수 없습니다. 계속하시겠습니까?", suggestions: ["한 번 바꾸면 다시 바꿀 수 없어요.\n계속할까요?"] },
  { input: "입력한 내용이 모두 삭제됩니다. 초기화하시겠습니까?", suggestions: ["입력한 내용이 모두 삭제돼요.\n초기화할까요?"] },
  { input: "네트워크 연결에 실패했습니다. 다시 시도하십시오.", suggestions: ["네트워크에 연결할 수 없어요.\n연결 상태를 확인하고 다시 시도해 주세요."] },
  { input: "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주십시오.", suggestions: ["일시적인 오류가 생겼어요.\n잠시 후 다시 시도해 주세요."] },
  { input: "아이디 또는 비밀번호가 일치하지 않습니다.", suggestions: ["아이디 또는 비밀번호가 맞지 않아요.\n다시 확인해 주세요."] },
  { input: "인증번호가 일치하지 않습니다.", suggestions: ["인증번호가 맞지 않아요.\n다시 입력해 주세요."] },
  { input: "인증 시간이 초과되었습니다. 인증번호를 재발송하십시오.", suggestions: ["인증 시간이 지났어요.\n인증번호를 다시 받아 주세요."] },
  { input: "검색 결과가 없습니다.", suggestions: ["검색 결과가 없어요.\n다른 검색어로 다시 찾아보세요."] },
  { input: "정보를 불러오지 못했습니다. 다시 시도해 주십시오.", suggestions: ["정보를 불러올 수 없어요.\n잠시 후 다시 시도해 주세요."] },
  { input: "파일 업로드에 실패했습니다.", suggestions: ["파일을 올리지 못했어요.\n다시 시도해 주세요."] },
  { input: "서비스 점검 중입니다. 이용에 불편을 드려 죄송합니다.", suggestions: ["지금은 서비스를 점검하고 있어요.\n점검이 끝나면 다시 이용할 수 있어요."] },
  { input: "필수 입력 항목입니다.", suggestions: ["꼭 입력해야 하는 항목이에요."] },
  { input: "카메라 접근 권한이 없습니다. 설정에서 권한을 허용하십시오.", suggestions: ["카메라 권한이 필요해요.\n설정에서 카메라 접근을 허용해 주세요."] },
  { input: "알림 권한이 거부되어 알림을 받을 수 없습니다.", suggestions: ["알림 권한을 허용하면 소식을 받을 수 있어요.\n설정에서 알림을 켜 주세요."] },
  { input: "위치 정보 이용에 동의하지 않아 일부 기능이 제한됩니다.", suggestions: ["위치 정보를 허용하면 모든 기능을 쓸 수 있어요.\n설정에서 위치 접근을 허용해 주세요."] },
  { input: "저장되었습니다.", suggestions: ["저장했어요."] },
  { input: "변경사항이 적용되었습니다.", suggestions: ["변경 내용을 적용했어요."] },
  { input: "전송이 완료되었습니다.", suggestions: ["보냈어요."] },
  { input: "등록이 완료되었습니다.", suggestions: ["등록을 마쳤어요."] },
  { input: "삭제되었습니다.", suggestions: ["삭제했어요."] },
  { input: "클립보드에 복사되었습니다.", suggestions: ["복사했어요."] },
  { input: "요청을 처리 중입니다. 잠시만 기다려 주십시오.", suggestions: ["요청을 처리하고 있어요.\n잠시만 기다려 주세요."] },
  { input: "새로운 버전이 출시되었습니다. 업데이트 후 이용 가능합니다.", suggestions: ["새 버전이 나왔어요.\n업데이트하면 새 기능을 쓸 수 있어요."] },
  { input: "서비스 이용을 위해 약관 동의가 필요합니다.", suggestions: ["약관에 동의하면 서비스를 시작할 수 있어요."] },
  { input: "장시간 미사용으로 자동 로그아웃 되었습니다. 다시 로그인하십시오.", suggestions: ["오랫동안 사용하지 않아 로그아웃됐어요.\n다시 로그인해 주세요."] },
  { input: "보안을 위해 비밀번호를 변경해 주시기 바랍니다.", suggestions: ["안전한 사용을 위해 비밀번호를 바꿔 주세요."] },
  { input: "경비를 개시하시겠습니까?", suggestions: ["경비를 시작할까요?"] },
  { input: "경비를 해제하시겠습니까?", suggestions: ["경비를 해제할까요?"] },
  { input: "기기가 오프라인 상태입니다. 네트워크 연결을 확인하십시오.", suggestions: ["기기가 네트워크에 연결돼 있지 않아요.\n기기의 연결 상태를 확인해 주세요."] },
  { input: "영상을 불러오는 중입니다. 잠시만 기다려 주십시오.", suggestions: ["영상을 불러오고 있어요.\n잠시만 기다려 주세요."] },
  { input: "권한 신청을 취소하시겠습니까? 취소하실 경우 신청하신 내용은 저장되지 않습니다.", suggestions: ["취소하면 신청한 내용이 저장되지 않아요.\n권한 신청을 취소할까요?","권한 신청을 취소할까요?\n취소하면 입력한 내용이 사라져요."] },
  { input: "자동차를 가지고 계시나요?", suggestions: ["자동차가 있나요?"] },
  { input: "매달 보험료를 얼마씩 내고 계시나요?", suggestions: ["매달 보험료는 얼마인가요?"] },
  { input: "안전한 개통을 위해 몇 가지 다시 여쭤볼게요.", suggestions: ["안전한 개통을 위해 몇 가지 다시 확인할게요."] },
  { input: "카드를 해지하시겠어요?", suggestions: ["카드를 해지할까요?"] },
  { input: "시작하시는 분에게 5,000원을 드려요.", suggestions: ["시작하면 5,000원을 드려요."] },
  { input: "이자 환불을 받았어요.", suggestions: ["이자를 돌려받았어요."] },
  { input: "오늘의 퀴즈가 곧 종료돼요.", suggestions: ["오늘의 퀴즈가 곧 끝나요."] },
  { input: "금일까지 미납 시 연체 처리됩니다. 후불결제 금액을 납부하시기 바랍니다.", suggestions: ["오늘까지 내지 않으면 연체돼요.\n후불결제 금액을 내주세요."] },
  { input: "점검 기간에는 서비스 이용이 불가합니다.", suggestions: ["점검 기간 동안 서비스를 이용할 수 없어요."] },
  { input: "신분증 확인 전에는 송금 및 결제가 불가합니다.", suggestions: ["신분증 확인되기 전까지 송금과 결제를 할 수 없어요."] },
  { input: "변경 시 캐시백 재지급은 불가합니다.", suggestions: ["한 번 바꾸면 캐시백은 다시 받을 수 없어요."] },
  { input: "상담 품질 향상을 위해 통화 내용이 녹음됩니다.", suggestions: ["더 좋은 상담을 위해 통화 내용은 녹음돼요."] },
  { input: "고객님의 개인정보 이용 내역은 기록 관리됩니다.", suggestions: ["이제부터 개인정보 이용 내역이 기록돼요."] },
  { input: "청소년은 서비스 가입이 불가합니다.", suggestions: ["지금은 가입할 수 없어요.\n청소년을 위한 서비스는 아직 준비 중이에요."] },
  { input: "아이디 또는 비밀번호를 5회 이상 잘못 입력하여 계정이 잠금 처리되었습니다.", suggestions: ["비밀번호를 5회 잘못 입력해서 계정이 잠겼어요.\n비밀번호를 재설정하면 다시 이용할 수 있어요."] },
  { input: "이미 사용 중인 아이디입니다.", suggestions: ["이미 쓰고 있는 아이디예요.\n다른 아이디를 입력해 주세요."] },
  { input: "사용할 수 없는 비밀번호입니다. 영문, 숫자, 특수문자를 포함하여 8자 이상 입력하십시오.", suggestions: ["영문, 숫자, 특수문자를 포함해 8자 이상 입력해 주세요."] },
  { input: "입력 가능한 글자 수를 초과하였습니다.", suggestions: ["입력할 수 있는 글자 수를 넘었어요.\n내용을 조금 줄여 주세요."] },
  { input: "파일 용량이 초과되었습니다. 10MB 이하의 파일만 업로드 가능합니다.", suggestions: ["10MB 이하 파일만 올릴 수 있어요.\n파일 용량을 확인해 주세요."] },
  { input: "다운로드가 완료되었습니다.", suggestions: ["다운로드를 마쳤어요."] },
  { input: "결제에 실패하였습니다. 다시 시도해 주시기 바랍니다.", suggestions: ["결제하지 못했어요.\n결제 수단을 확인하고 다시 시도해 주세요."] },
  { input: "저장 공간이 부족하여 설치할 수 없습니다.", suggestions: ["저장 공간이 부족해서 설치할 수 없어요.\n공간을 확보한 뒤 다시 시도해 주세요."] },
  { input: "서비스 준비 중입니다.", suggestions: ["준비하고 있는 기능이에요.\n조금만 기다려 주세요."] },
  { input: "등록 가능한 최대 개수를 초과하였습니다.", suggestions: ["더 등록하려면 기존 항목을 삭제해 주세요."] },
  { input: "출동 요청이 접수되었습니다. 잠시만 기다려 주십시오.", suggestions: ["출동 요청을 접수했어요.\n잠시만 기다려 주세요."] },
  { input: "경비 상태를 확인할 수 없습니다. 잠시 후 다시 시도하십시오.", suggestions: ["경비 상태를 확인할 수 없어요.\n잠시 후 다시 시도해 주세요."] },
  { input: "외출 모드로 전환하시겠습니까?", suggestions: ["외출 모드로 바꿀까요?"] },
  { input: "방문 예약이 완료되었습니다.", suggestions: ["방문 예약을 마쳤어요."] },
  { input: "비밀번호 5회 오류로 계정이 잠금 처리되었습니다.", suggestions: ["비밀번호를 5회 잘못 입력해서 계정이 잠겼어요.\n비밀번호를 재설정하면 다시 이용할 수 있어요."] },
  { input: "본인 인증을 하지 않으면 서비스를 이용할 수 없습니다.", suggestions: ["본인 인증을 하면 모든 서비스를 이용할 수 있어요."] },
  { input: "이메일 인증 전에는 로그인할 수 없습니다.", suggestions: ["이메일 인증을 마치면 로그인할 수 있어요."] },
  { input: "쿠폰은 로그인 후에만 사용 가능합니다.", suggestions: ["로그인하면 쿠폰을 쓸 수 있어요."] },
  { input: "미성년자는 보호자 동의 없이 결제할 수 없습니다.", suggestions: ["보호자가 동의하면 결제할 수 있어요."] },
  { input: "프로필을 등록하지 않으면 이용이 제한됩니다.", suggestions: ["프로필을 등록하면 모든 기능을 쓸 수 있어요."] },
  { input: "앱 버전이 낮아 일부 기능이 제한됩니다.", suggestions: ["앱을 업데이트하면 모든 기능을 쓸 수 있어요."] },
  { input: "블루투스가 꺼져 있어 기기를 연결할 수 없습니다.", suggestions: ["블루투스를 켜면 기기를 연결할 수 있어요."] },
  { input: "비상 연락처가 등록되지 않았습니다.", suggestions: ["비상 연락처를 등록하면 긴급할 때 빠르게 연락드릴 수 있어요."] },
  { input: "출입 카드가 등록되지 않아 사용할 수 없습니다.", suggestions: ["출입 카드를 등록하면 바로 쓸 수 있어요."] },
  { input: "회원가입이 완료되었습니다.", suggestions: ["가입을 마쳤어요."] },
  { input: "예약이 취소되었습니다.", suggestions: ["예약을 취소했어요."] },
  { input: "문의가 접수되었습니다. 순차적으로 답변드리겠습니다.", suggestions: ["문의를 접수했어요.\n순서대로 답변드릴게요."] },
  { input: "설정이 초기화되었습니다.", suggestions: ["설정을 초기화했어요."] },
  { input: "비밀번호가 변경되었습니다.", suggestions: ["비밀번호를 바꿨어요."] },
  { input: "인증이 완료되었습니다.", suggestions: ["인증을 마쳤어요."] },
  { input: "언제 방문하시겠습니까?", suggestions: ["방문 날짜를 선택해 주세요."] },
  { input: "어떤 방법으로 인증하시겠습니까?", suggestions: ["인증 방법을 선택해 주세요."] },
  { input: "결제하실 카드를 선택해 주십시오.", suggestions: ["결제할 카드를 선택해 주세요."] },
  { input: "원하시는 서비스를 선택하세요.", suggestions: ["원하는 서비스를 선택해 주세요."] },
  { input: "주소를 알고 계신가요?", suggestions: ["주소를 알고 있나요?"] },
  { input: "기간 만료로 이용이 중지되었습니다.", suggestions: ["이용 기간이 끝나서 지금은 쓸 수 없어요."] },
  { input: "용량 부족으로 저장에 실패했습니다.", suggestions: ["저장 공간이 부족해서 저장하지 못했어요."] },
  { input: "통신 오류로 요청이 실패하였습니다.", suggestions: ["통신이 원활하지 않아 요청을 처리하지 못했어요.\n잠시 후 다시 시도해 주세요."] },
  { input: "권한 부족으로 접근이 거부되었습니다.", suggestions: ["접근 권한이 없어요.\n관리자에게 권한을 요청해 주세요."] },
  { input: "입력하신 주소를 찾을 수 없습니다. 다시 확인 바랍니다.", suggestions: ["주소를 찾을 수 없어요.\n다시 확인해 주세요."] },
  { input: "요청하신 페이지를 찾을 수 없습니다.", suggestions: ["페이지를 찾을 수 없어요.\n주소를 확인하거나 홈으로 이동해 주세요."] },
  { input: "동일한 요청이 처리 중입니다. 잠시 후 확인해 주십시오.", suggestions: ["같은 요청을 처리하고 있어요.\n잠시 후 확인해 주세요."] },
  { input: "이벤트가 종료되었습니다.", suggestions: ["이벤트가 끝났어요."] },
  { input: "탈퇴 시 모든 데이터가 삭제되며 복구할 수 없습니다.", suggestions: ["탈퇴하면 모든 데이터가 삭제되고 다시 되돌릴 수 없어요.\n정말 탈퇴할까요?"] },
  { input: "부재 중 방문자가 감지되었습니다.", suggestions: ["부재 중에 방문자가 있었어요.\n영상을 확인해 보세요."] },
  { input: "경비 해제 권한이 없습니다.", suggestions: ["경비 해제 권한이 필요해요.\n관리자에게 요청해 주세요."] },
  { input: "화재 감지기 배터리가 부족합니다.", suggestions: ["화재 감지기 배터리가 얼마 없어요.\n배터리를 교체해 주세요."] },
  { input: "모임지원금 없이 모임통장을 만들까요? 지금 받지 않으면 모임지원금을 받을 수 없어요.", suggestions: ["약관에 동의하면 모임지원금을 받을 수 있어요."] },
  { input: "혜택 없이 가입할까요? 지금 신청하지 않으면 웰컴 혜택을 받을 수 없어요.", suggestions: ["지금 신청하면 웰컴 혜택을 받을 수 있어요."] },
  { input: "쿠폰 없이 결제할까요? 지금 받지 않으면 할인 쿠폰을 받을 수 없어요.", suggestions: ["쿠폰을 받으면 더 저렴하게 결제할 수 있어요."] },
  { input: "알림 없이 시작할까요? 알림을 켜지 않으면 중요한 소식을 받을 수 없어요.", suggestions: ["알림을 켜면 중요한 소식을 바로 받을 수 있어요."] },
  { input: "자동이체를 등록하지 않고 넘어갈까요? 등록하지 않으면 할인을 받을 수 없어요.", suggestions: ["자동이체를 등록하면 할인을 받을 수 있어요."] },
  { input: "본 계약의 유일한 마스터 관리자로 일반관리자로 권한변경을 하실 수 없어요. 일반 관리자로 권한 변경을 원하실 경우 다른 사람에게 마스터 관리자 권한을 지정해 주신 후 다시 시도해 주세요.", suggestions: ["다른 사람을 마스터 관리자로 지정한 뒤 일반 관리자로 변경할 수 있어요.","다른 사람을 마스터 관리자로 지정하면 변경할 수 있어요."] },
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
  '7. 줄 구조: 원본이 한 줄이면 추천도 반드시 한 줄로. 임의로 줄을 늘리지 않는다. 단, 여러 문장을 하나의 긍정형 문장으로 합쳐 더 간결해진다면 줄 수를 줄이는 것은 환영(모임지원금 없이 만들까요? 지금 받지 않으면 받을 수 없어요. → 약관에 동의하면 모임지원금을 받을 수 있어요.).',
  '8. 다이얼로그 왼쪽 버튼 라벨은 "닫기"(취소 금지).',
  '9. 이름·전화번호·마스킹(홍*동, 010-1234-5678)은 그대로 보존. 사람을 부를 땐 님을 붙여도 좋다.',
  '10. 제품 용어 유지: 입력에 쓰인 기능성 명사(변경, 지정, 등록, 해제 등)는 화면의 기능명·버튼명일 가능성이 높으므로 쉬운 말로 바꾸지 않는다(권한 변경 맥락이면 "바꿀 수 있어요" X → "변경할 수 있어요" O). 시스템 동작과 다른 동사를 새로 만들지 않는다(추가 지정을 "넘기기"로 바꾸면 안 됨).',
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

async function handleRecommend(request, env) {
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
  const out = await callGemini(apiKey || (env && env.GEMINI_API_KEY) || '', prompt, RECOMMEND_SCHEMA);
  if (out.error) {
    return Response.json({ error: out.error, noKey: !!out.noKey }, { status: 502, headers: CORS });
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
