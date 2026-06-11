// 네이버 맞춤법 passportKey 심부름꾼 (Cloudflare Worker)
// ─────────────────────────────────────────────────────────────
// 왜 필요한가:
//   네이버 검색페이지(search.naver.com)는 CORS 헤더를 안 줘서
//   Figma 플러그인(브라우저)에서 직접 못 긁는다 → "Failed to fetch".
//   이 워커가 서버에서 대신 긁어 passportKey만 CORS 허용해서 돌려준다.
//   (맞춤법 검사 본 API인 SpellerProxy는 이미 CORS가 열려 있어 그대로 호출 가능)
//
// 배포: Cloudflare 대시보드 → Workers & Pages → Create → 이 파일 내용 붙여넣기 → Deploy
//       배포 후 나오는 주소(https://xxxx.workers.dev)를 code.ts의 NAVER_PROXY_URL에 넣는다.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
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
  },
};
