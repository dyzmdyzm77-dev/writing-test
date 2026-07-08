// 제보 저장소(report-admin)에 쌓인 데이터를 내려받아 예시 후보 파일(feedback-candidates.md)을 만든다.
// 사용: npm run sync-feedback  (또는 node scripts/sync-feedback.js)
//
// 무엇을 하나:
//   1) https://report-admin-weld.vercel.app/api/list 에서 전체 항목을 가져온다
//   2) reason === '추천 좋아요' → 좋아요한 추천 (code.ts LIKE_SUGGESTION이 보낸 것)
//      그 외                    → 오수정 제보 (잘못된 수정안 신고)
//   3) 좋아요는 recommend-examples.md에 이미 있는 예시와 중복 제거 후,
//      바로 붙여넣을 수 있는 "### 원본 / - 추천안" 형식으로 feedback-candidates.md에 쓴다
//   4) 오수정 제보는 규칙(ux-writing.md·glossary.md) 보완 검토용 목록으로 함께 쓴다
//
// ★ 자동으로 recommend-examples.md를 고치지 않는다 — 사람이 후보를 읽고 골라 옮기는 반자동 환류.
//    옮긴 뒤 npm run build 해야 플러그인에 반영된다.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const LIST_URL = 'https://report-admin-weld.vercel.app/api/list';
const LIKE_MARKER = '추천 좋아요'; // code.ts LIKE_SUGGESTION의 reason 값과 같아야 한다
const OUT_PATH = path.join(root, 'feedback-candidates.md');
const EXAMPLES_PATH = path.join(root, 'recommend-examples.md');

// 문구 비교용 정규화 (공백 무시)
function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// recommend-examples.md에서 이미 있는 원본(### 제목)들을 모은다 — 중복 후보 거르기용
function existingOriginals() {
  const set = new Set();
  try {
    const md = fs.readFileSync(EXAMPLES_PATH, 'utf8');
    for (const m of md.matchAll(/^### (.+)$/gm)) set.add(norm(m[1]));
  } catch (_e) {
    console.warn('[sync] recommend-examples.md를 읽지 못했어요 — 중복 검사 없이 진행합니다.');
  }
  return set;
}

// 플러그인 표시용 줄바꿈 → 예시 파일 형식(' / ')
function toExampleLine(s) {
  return String(s || '').replace(/\r/g, '').split('\n').map((t) => t.trim()).filter(Boolean).join(' / ');
}

async function fetchAllItems() {
  const res = await fetch(LIST_URL);
  if (!res.ok) throw new Error('/api/list HTTP ' + res.status);
  const body = await res.json();
  const items = (body && body.items) || [];
  const out = [];
  const failures = [];
  for (const it of items) {
    // list가 내용(data)을 채워주면 그대로 쓰고, 비어 있으면 blob URL에서 직접 읽는다
    let data = it && it.data;
    if (!data || Object.keys(data).length === 0) {
      try {
        const r = await fetch(it.url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const text = await r.text();
        data = JSON.parse(text);
      } catch (e) {
        failures.push({ key: it && it.key, error: String((e && e.message) || e) });
        continue;
      }
    }
    out.push({ key: it.key, data });
  }
  return { items: out, failures };
}

function fmtDateFromKey(key) {
  // 키 형식: reports/<timestamp>-<rand>.json — timestamp가 있으면 날짜로
  const m = String(key || '').match(/reports\/(\d{10,})/);
  if (!m) return '';
  const d = new Date(Number(m[1]));
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

async function main() {
  console.log('[sync] 제보 저장소에서 내려받는 중…');
  const { items, failures } = await fetchAllItems();

  const likes = [];
  const reports = [];
  for (const { key, data } of items) {
    const entry = {
      key,
      date: fmtDateFromKey(key),
      before: String(data.before || ''),
      after: String(data.after || ''),
      reason: String(data.reason || ''),
      comment: String(data.comment || ''),
      fileName: String(data.fileName || ''),
    };
    if (entry.reason === LIKE_MARKER) likes.push(entry);
    else reports.push(entry);
  }

  // 좋아요: 같은 원본은 하나로 모으고(추천안 여러 개), 기존 예시에 있는 원본은 제외
  const known = existingOriginals();
  const grouped = new Map(); // norm(before) → { before, afters:Set }
  let skippedKnown = 0;
  for (const l of likes) {
    if (!l.before || !l.after) continue;
    const k = norm(l.before);
    if (known.has(k)) { skippedKnown++; continue; }
    if (!grouped.has(k)) grouped.set(k, { before: l.before, afters: new Set() });
    grouped.get(k).afters.add(toExampleLine(l.after));
  }

  // 출력 파일 구성
  const lines = [];
  lines.push('# 피드백 후보 (자동 생성)');
  lines.push('');
  lines.push('`npm run sync-feedback`가 제보 저장소에서 만든 파일입니다. **직접 커밋하지 말고**, 아래 후보를 검토해서:');
  lines.push('');
  lines.push('- 좋아요 후보 → 좋은 것만 `recommend-examples.md`의 "## 추천 예시"에 붙여넣기');
  lines.push('- 오수정 제보 → `ux-writing.md`(규칙)나 `glossary.md`(용어) 보완 검토');
  lines.push('');
  lines.push('옮긴 뒤 `npm run build` 해야 플러그인에 반영됩니다.');
  lines.push('');
  lines.push('## 좋아요 후보 (' + grouped.size + '건' + (skippedKnown ? ', 기존 예시와 중복 ' + skippedKnown + '건 제외' : '') + ')');
  lines.push('');
  if (grouped.size === 0) {
    lines.push('_아직 없음_');
    lines.push('');
  } else {
    for (const { before, afters } of grouped.values()) {
      lines.push('### ' + toExampleLine(before));
      for (const a of afters) lines.push('- ' + a);
      lines.push('');
    }
  }
  lines.push('## 오수정 제보 (' + reports.length + '건) — 규칙 보완 검토용');
  lines.push('');
  if (reports.length === 0) {
    lines.push('_아직 없음_');
    lines.push('');
  } else {
    lines.push('| 날짜 | 원문 | 플러그인 수정안 | 사유 | 코멘트 | 파일 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    const esc = (s) => toExampleLine(s).replace(/\|/g, '\\|');
    for (const r of reports) {
      lines.push('| ' + [r.date, esc(r.before), esc(r.after), esc(r.reason), esc(r.comment), esc(r.fileName)].join(' | ') + ' |');
    }
    lines.push('');
  }
  if (failures.length) {
    lines.push('## 내려받기 실패 (' + failures.length + '건)');
    lines.push('');
    lines.push('저장소(Vercel Blob) 상태를 확인하세요 — "Your store is blocked"면 Vercel 대시보드에서 차단 해제 필요.');
    lines.push('');
    for (const f of failures) lines.push('- `' + f.key + '` — ' + f.error);
    lines.push('');
  }

  fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf8');
  console.log('[sync] 좋아요 후보 ' + grouped.size + '건' + (skippedKnown ? ' (중복 ' + skippedKnown + '건 제외)' : '') +
    ', 오수정 제보 ' + reports.length + '건' + (failures.length ? ', 실패 ' + failures.length + '건' : ''));
  console.log('[sync] → ' + path.relative(root, OUT_PATH) + ' 생성. 검토 후 recommend-examples.md로 옮기고 npm run build 하세요.');
}

main().catch((e) => {
  console.error('[sync] 실패:', (e && e.message) || e);
  if (String(e && e.message).includes('fetch failed')) {
    console.error('[sync] 사내 프록시 환경이면 node에 --use-env-proxy 플래그가 필요해요 (Node 24+).');
    console.error('       npm run sync-feedback 으로 실행하면 자동으로 붙습니다.');
  }
  process.exit(1);
});
