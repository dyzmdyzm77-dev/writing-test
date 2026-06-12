// glossary.md를 읽어 code.ts의 GLOSSARY 자동 생성 영역을 갱신한다.
// 사용: node scripts/build-glossary.js  (npm run build에 포함돼 있음)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mdPath = path.join(root, 'glossary.md');
const tsPath = path.join(root, 'code.ts');

const md = fs.readFileSync(mdPath, 'utf8');

// 섹션별로 분리 (## 제목 기준)
function section(title) {
  const re = new RegExp('^## ' + title + '\\s*$', 'm');
  const m = md.match(re);
  if (!m) throw new Error(`glossary.md에서 "## ${title}" 섹션을 찾을 수 없습니다. 제목을 바꾸지 마세요.`);
  const start = m.index + m[0].length;
  const next = md.slice(start).search(/^## /m);
  return next === -1 ? md.slice(start) : md.slice(start, start + next);
}

// "용어 통일" 표 파싱: | 기존 | 권장 |
const terms = [];
for (const line of section('용어 통일').split('\n')) {
  const t = line.trim();
  if (!t.startsWith('|')) continue;
  const cells = t.split('|').map((c) => c.trim()).filter((c, i, arr) => i > 0 && i < arr.length - 1);
  if (cells.length < 2) continue;
  if (cells[0] === '기존' || /^-+$/.test(cells[0])) continue; // 헤더/구분선
  terms.push({ from: cells[0], to: cells[1] });
}

// 목록 파싱: "- 단어"
function listItems(title) {
  const out = [];
  for (const line of section(title).split('\n')) {
    const m = line.match(/^\s*-\s+(.+?)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}
const compounds = listItems('합성어 보호');
const actionNouns = listItems('동작 명사');

// "예외 표기" 표 파싱: | 유지할 표기 | 네이버가 바꾸는 표기 | (섹션이 없으면 빈 목록)
const keepSpellings = [];
try {
  for (const line of section('예외 표기').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').map((c) => c.trim()).filter((c, i, arr) => i > 0 && i < arr.length - 1);
    if (cells.length < 2) continue;
    if (cells[0] === '유지할 표기' || /^-+$/.test(cells[0])) continue;
    keepSpellings.push({ keep: cells[0], naver: cells[1] });
  }
} catch (_e) {
  // 섹션 없음 — 빈 목록 유지
}

if (terms.length === 0 || compounds.length === 0 || actionNouns.length === 0) {
  throw new Error('glossary.md 파싱 결과가 비어 있습니다. 표/목록 형식을 확인하세요.');
}

// 합성어는 긴 단어 먼저 (고객인증번호가 인증번호보다 먼저 매칭되도록)
compounds.sort((a, b) => b.length - a.length);

const gen = [
  '// ===== GLOSSARY:BEGIN — 자동 생성 영역. 직접 수정하지 말고 glossary.md를 고친 뒤 npm run build =====',
  'const GLOSSARY_TERMS: Array<{ from: string; to: string }> = [',
  ...terms.map((t) => `  { from: ${JSON.stringify(t.from)}, to: ${JSON.stringify(t.to)} },`),
  '];',
  'const GLOSSARY_COMPOUNDS: string[] = [',
  ...compounds.map((w) => `  ${JSON.stringify(w)},`),
  '];',
  'const GLOSSARY_ACTION_NOUNS: string[] = [',
  ...actionNouns.map((w) => `  ${JSON.stringify(w)},`),
  '];',
  'const GLOSSARY_KEEP_SPELLINGS: Array<{ keep: string; naver: string }> = [',
  ...keepSpellings.map((k) => `  { keep: ${JSON.stringify(k.keep)}, naver: ${JSON.stringify(k.naver)} },`),
  '];',
  '// ===== GLOSSARY:END =====',
].join('\n');

const src = fs.readFileSync(tsPath, 'utf8');
const re = /\/\/ ===== GLOSSARY:BEGIN[\s\S]*?\/\/ ===== GLOSSARY:END =====/;
if (!re.test(src)) {
  throw new Error('code.ts에서 GLOSSARY 마커를 찾을 수 없습니다.');
}
fs.writeFileSync(tsPath, src.replace(re, gen), 'utf8');
console.log(`[glossary] 용어 ${terms.length}건, 합성어 ${compounds.length}건, 동작 명사 ${actionNouns.length}건, 예외 표기 ${keepSpellings.length}건 반영`);
