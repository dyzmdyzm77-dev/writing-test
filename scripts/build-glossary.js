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

// "권장 문구" 표 파싱: | 기존 | 권장 | — 용어가 아닌 말투·어미 규칙 (칩: "권장 문구"). 섹션이 없으면 빈 목록
const phrases = [];
try {
  for (const line of section('권장 문구').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').map((c) => c.trim()).filter((c, i, arr) => i > 0 && i < arr.length - 1);
    if (cells.length < 2) continue;
    if (cells[0] === '기존' || /^-+$/.test(cells[0])) continue; // 헤더/구분선
    phrases.push({ from: cells[0], to: cells[1] });
  }
} catch (_e) {
  // 섹션 없음 — 빈 목록 유지
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
  'const GLOSSARY_PHRASES: Array<{ from: string; to: string }> = [',
  ...phrases.map((t) => `  { from: ${JSON.stringify(t.from)}, to: ${JSON.stringify(t.to)} },`),
  '];',
  '// ===== GLOSSARY:END =====',
].join('\n');

let src = fs.readFileSync(tsPath, 'utf8');
const re = /\/\/ ===== GLOSSARY:BEGIN[\s\S]*?\/\/ ===== GLOSSARY:END =====/;
if (!re.test(src)) {
  throw new Error('code.ts에서 GLOSSARY 마커를 찾을 수 없습니다.');
}
src = src.replace(re, gen);

// ── 문구 추천 예시(recommend-examples.md) 파싱 → RECOMMEND_EXAMPLES 주입 ──
const recMdPath = path.join(root, 'recommend-examples.md');
const recMd = fs.readFileSync(recMdPath, 'utf8');
const recSecIdx = recMd.search(/^## 추천 예시\s*$/m);
if (recSecIdx === -1) {
  throw new Error('recommend-examples.md에서 "## 추천 예시" 섹션을 찾을 수 없습니다.');
}
const examples = [];
let cur = null;
for (const raw of recMd.slice(recSecIdx).split('\n')) {
  const line = raw.replace(/\s+$/, '');
  const h = line.match(/^###\s+(.+?)\s*$/);
  if (h) { cur = { input: h[1], suggestions: [] }; examples.push(cur); continue; }
  const b = line.match(/^\s*-\s+(.+?)\s*$/);
  if (b && cur) { cur.suggestions.push(b[1].split(' / ').join('\n')); } // " / " → 줄바꿈
}
const validExamples = examples.filter((e) => e.suggestions.length > 0);

const recGen = [
  '// ===== RECOMMEND:BEGIN — 자동 생성 영역. 직접 수정하지 말고 recommend-examples.md를 고친 뒤 npm run build =====',
  'const RECOMMEND_EXAMPLES: Array<{ input: string; suggestions: string[] }> = [',
  ...validExamples.map((e) => `  { input: ${JSON.stringify(e.input)}, suggestions: ${JSON.stringify(e.suggestions)} },`),
  '];',
  '// ===== RECOMMEND:END =====',
].join('\n');
const reRec = /\/\/ ===== RECOMMEND:BEGIN[\s\S]*?\/\/ ===== RECOMMEND:END =====/;
if (!reRec.test(src)) {
  throw new Error('code.ts에서 RECOMMEND 마커를 찾을 수 없습니다.');
}
src = src.replace(reRec, recGen);

// ── 커넥터 배포본(zip) 재료 ───────────────────────────────
// 예전의 payload 내장 .bat/.command 생성은 2026-09 제거 — 백신(V3)이 드로퍼로 격리해 배포 수단으로 쓸 수 없었다.
// 지금은 아래 파일들을 평범한 그대로 담은 커넥터 zip 하나만 만든다 (연결 흐름은 CLAUDE.md "설치본 자동 갱신" 참고).
const bridgeBytes = fs.readFileSync(path.join(root, 'scripts', 'claude-bridge.js'));
const launcherBytes = fs.readFileSync(path.join(root, 'claude-bridge-silent.vbs')); // UTF-16LE 바이트 그대로
const watcherBytes = fs.readFileSync(path.join(root, 'scripts', 'bridge-watcher.js'));
const watcherVbsBytes = fs.readFileSync(path.join(root, 'claude-watcher-silent.vbs'));
const outDir = path.join(root, 'out'); // gitignore — 배포 산출물은 저장소에 두지 않는다
fs.mkdirSync(outDir, { recursive: true });
// 플러그인이 들고 다니는 커넥터 배포본 = **평범한 파일들이 든 zip** (2026-09).
// 예전엔 base64를 품은 .bat 한 장이었는데 백신(V3)이 드로퍼로 격리했다 → 받아도 실행이 안 됐다.
// 이 zip은 ① [설치 파일 받기] 다운로드 ② 감시자 /update 자동 갱신, 두 곳에서 같이 쓴다.
// 압축 해제하면 저장소와 같은 배치(scripts/ + 루트 md·vbs)라 설치.bat이 그대로 동작한다.
// 맥용 얇은 설치 스크립트 — 숨긴 코드 없이 옆의 register-protocol.js만 실행한다
const macThinInstaller = [
  '#!/bin/bash',
  '# 클로드 커넥터 설치 — 이 폴더의 scripts/register-protocol.js 를 실행할 뿐입니다.',
  'cd "$(dirname "$0")"',
  'if ! command -v node >/dev/null 2>&1; then',
  '  echo "Node.js가 필요해요 — https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행해 주세요."',
  '  read -n 1 -s -r -p "아무 키나 누르면 닫혀요."; exit 1',
  'fi',
  'node scripts/register-protocol.js || { echo "설치에 실패했어요. 위 메시지를 개발자에게 알려 주세요."; read -n 1 -s -r; exit 1; }',
  'if ! command -v claude >/dev/null 2>&1; then',
  '  echo ""; echo "설정은 끝났어요. 다만 이 Mac에 Claude Code가 없어요. 터미널에서 아래를 실행해 주세요:"',
  '  echo "  npm install -g @anthropic-ai/claude-code"; echo "  claude login"',
  'else',
  '  echo ""; echo "준비 끝! 피그마에서 플러그인을 열고 [추천받기]를 누르면 돼요."',
  'fi',
  'read -n 1 -s -r -p "아무 키나 누르면 닫혀요."',
  '',
].join('\n');
const connectorReadme = [
  '클로드 커넥터 설치 방법',
  '',
  '[윈도우]  설치.bat 을 더블클릭하세요.',
  '[맥]      설치.command 를 우클릭 → [열기] 하세요. (더블클릭은 Gatekeeper가 막습니다)',
  '',
  '- Node.js와 Claude Code가 필요합니다. 없으면 설치 중에 안내가 나옵니다.',
  '- 이 폴더를 지우거나 옮기면 연결이 끊깁니다. 옮겼으면 설치 파일을 다시 실행해 주세요.',
  '- 추천·번역은 이 PC에 로그인된 본인 클로드 구독 사용량을 씁니다.',
  '',
  '안에 든 파일은 모두 평범한 스크립트입니다(숨긴 코드·다운로드 없음).',
  '',
].join('\r\n');
const connectorZip = zipFiles([
  { name: '설치.bat', data: fs.readFileSync(path.join(root, '설치.bat')) },
  { name: '설치.command', data: Buffer.from(macThinInstaller, 'utf8'), exec: true },
  { name: '읽어주세요.txt', data: Buffer.from(connectorReadme, 'utf8') },
  { name: 'scripts/claude-bridge.js', data: bridgeBytes },
  { name: 'scripts/bridge-watcher.js', data: watcherBytes },
  { name: 'scripts/register-protocol.js', data: fs.readFileSync(path.join(root, 'scripts', 'register-protocol.js')) },
  { name: 'recommend-examples.md', data: Buffer.from(recMd, 'utf8') },
  { name: 'ux-writing.md', data: fs.readFileSync(path.join(root, 'ux-writing.md')) },
  { name: 'claude-bridge-silent.vbs', data: launcherBytes },
  { name: 'claude-watcher-silent.vbs', data: watcherVbsBytes },
]);
fs.writeFileSync(path.join(outDir, '클로드-커넥터.zip'), connectorZip);
const instGen = [
  '// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.zip을 base64로 주입) =====',
  `const INSTALLER_B64 = ${JSON.stringify(connectorZip.toString('base64'))};`,
  '// ===== INSTALLER:END =====',
].join('\n');
const reInst = /\/\/ ===== INSTALLER:BEGIN[\s\S]*?\/\/ ===== INSTALLER:END =====/;
if (!reInst.test(src)) {
  throw new Error('code.ts에서 INSTALLER 마커를 찾을 수 없습니다.');
}
src = src.replace(reInst, instGen);


// 실행 권한(0755)을 실은 단일 항목 zip — 외부 의존성 없이 직접 만든다 (stored, 무압축)
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// 여러 파일을 담는 zip (stored, 무압축) — 커넥터 배포용.
// **왜 zip인가**: 예전엔 코드를 base64로 품은 .bat 한 장을 내려줬는데, 그 모양이 드로퍼와 같아
// 백신(V3)이 악성코드로 격리했다(2026-09 실측). zip 안에 평범한 .js/.md/.bat을 그대로 넣으면
// 백신이 내용을 그대로 보고 판단하므로 오탐이 크게 준다. 무압축(stored)인 이유는 감시자가
// /update 에서 외부 라이브러리 없이 항목을 잘라 읽기 때문(zlib 불필요).
// entries: [{ name, data, exec }] — exec=true면 유닉스 실행 권한(0755)을 실어 맥에서 복원된다.
function zipFiles(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);   // UTF-8 파일명
    lfh.writeUInt16LE(0, 8);        // stored
    lfh.writeUInt32LE(0, 10);       // 시각/날짜 0 — 재현 가능한 빌드
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(0x031E, 4);   // made by unix — 외부 속성의 권한이 유효
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt32LE(0, 12);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE((((e.exec ? 0o100755 : 0o100644) << 16) >>> 0), 38);
    cdh.writeUInt32LE(offset, 42);
    parts.push(lfh, nameBuf, data);
    central.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(parts), cdBuf, eocd]);
}


fs.writeFileSync(tsPath, src, 'utf8');

// (Vercel 제보 앱 ux-writing-reports로의 내보내기 — api/bridge-setup.js·api/recommend.js 주입 — 는 2026-09 제거.
//  사내 프록시가 Vercel을 막아 서버를 더 쓰지 않는다. 복구는 git 히스토리.)

console.log(`[glossary] 용어 ${terms.length}건, 권장 문구 ${phrases.length}건, 합성어 ${compounds.length}건, 동작 명사 ${actionNouns.length}건, 예외 표기 ${keepSpellings.length}건 반영`);
console.log(`[recommend] 추천 예시 ${validExamples.length}건 반영 (code.ts)`);
