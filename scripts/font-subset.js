// ui.html에 내장된 Pretendard 폰트를 서브셋으로 다시 만든다.
//   node scripts/font-subset.js <PretendardVariable.woff2 경로>
//   (npm run font:subset -- <경로>)
// 왜: 원본(2.0MB, 한글 11,172자)을 통째 내장하면 플러그인을 열 때마다 그만큼 CSS를 읽는다.
//     화면·AI 문구는 상용 한글이라 KS X 1001 2,350자 + 라틴 + UI 기호만 남기면 470KB로 준다(2026-09).
// 원본 폰트는 저장소에 없다(2MB 바이너리를 ZIP 배포에 싣지 않으려고) — Pretendard 배포본에서 PretendardVariable.woff2를 받아 넘긴다.
// 상용 밖 글자는 시스템 글꼴로 대체돼 보인다(깨지지 않음). 화면 고정 문구(ui.html·code.ts)에 쓰인 한글은 상용 밖이어도 자동으로 포함한다.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('사용법: node scripts/font-subset.js <PretendardVariable.woff2 경로>');
  process.exit(1);
}
let subsetFont;
try { subsetFont = require('subset-font'); } catch (_e) {
  console.error('subset-font가 없어요 → npm install (devDependencies에 있음)');
  process.exit(1);
}

// 1) KS X 1001 완성형 한글 2,350자 — EUC-KR 한글 영역(선두 0xB0~0xC8, 후속 0xA1~0xFE)을 디코드해 얻는다
const dec = new TextDecoder('euc-kr');
let chars = '';
for (let lead = 0xb0; lead <= 0xc8; lead++) for (let trail = 0xa1; trail <= 0xfe; trail++) {
  const ch = dec.decode(Uint8Array.from([lead, trail]));
  if (/^[가-힣]$/.test(ch)) chars += ch;
}
// 2) ASCII · Latin-1 · 한글 호환 자모 · UI에서 쓰는 기호
for (let c = 0x20; c <= 0x7e; c++) chars += String.fromCharCode(c);
for (let c = 0xa0; c <= 0xff; c++) chars += String.fromCharCode(c);
for (let c = 0x3131; c <= 0x3163; c++) chars += String.fromCharCode(c);
for (let c = 0x2460; c <= 0x2473; c++) chars += String.fromCharCode(c); // ①~⑳
chars += '‘’“”–—…·•→←↑↓›‹※○●◎△▲▽▼□■◇◆★☆✓✔✕✗✳✨⚠⚫🟢🟠🔌🔧🔑👍│─┌┐└┘├┤┬┴┼№℃‰′″€₩';
// 3) 화면 고정 문구에 등장하는 한글은 상용 밖이어도 포함 (절대 대체되지 않게)
const uiPath = path.join(root, 'ui.html');
const html = fs.readFileSync(uiPath, 'utf8');
const code = fs.readFileSync(path.join(root, 'code.ts'), 'utf8');
for (const ch of new Set([...(html + code)].filter((c) => /[가-힣]/.test(c)))) if (!chars.includes(ch)) chars += ch;
chars = [...new Set([...chars])].join('');

(async () => {
  const orig = fs.readFileSync(src);
  const out = await subsetFont(orig, chars, { targetFormat: 'woff2' });
  console.log('원본 ' + Math.round(orig.length / 1024) + ' KB → 서브셋 ' + Math.round(out.length / 1024) + ' KB (글자 ' + [...chars].length + '자)');
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'out', 'Pretendard-subset.woff2'), out);
  // 4) ui.html의 @font-face 교체 — local()을 앞에 둬 설치된 PC는 내장 데이터를 디코드하지 않는다
  const b64 = out.toString('base64');
  const re = /(@font-face\s*\{)([\s\S]*?)(\})/;
  if (!re.test(html)) { console.error('ui.html에 @font-face가 없어요'); process.exit(1); }
  const block = [
    '',
    '        /* Pretendard 가변 폰트 — 미설치 PC에서도 같은 글꼴로 보이게 base64로 내장.',
    '           KS X 1001 상용 한글 2,350자 + 라틴 + UI 기호 서브셋(scripts/font-subset.js로 재생성). 상용 밖 글자는 시스템 글꼴로 대체.',
    '           PC에 Pretendard가 설치돼 있으면 local()이 먼저 잡혀 내장 폰트를 디코드하지 않는다. */',
    "        font-family: 'Pretendard';",
    '        font-weight: 45 920;',
    '        font-style: normal;',
    '        font-display: swap;',
    "        src: local('Pretendard Variable'), local('PretendardVariable'), local('Pretendard'),",
    "             url(data:font/woff2;base64," + b64 + ") format('woff2');",
    '      ',
  ].join('\n');
  const next = html.replace(re, (_, open, _body, close) => open + block + close);
  fs.writeFileSync(uiPath, next, 'utf8');
  console.log('ui.html ' + Math.round(html.length / 1024) + ' KB → ' + Math.round(next.length / 1024) + ' KB');
})().catch((e) => { console.error('서브셋 실패:', e && e.message ? e.message : e); process.exit(1); });
