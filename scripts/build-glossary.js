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

// ── 클로드다리-설치.bat 생성 + code.ts 주입 ──────────────────
// 플러그인의 [🔧 설치 파일 받기] 버튼이 이 bat을 다운로드로 내려준다 (폴더 찾아갈 필요 없음).
// bat은 자기완결형: 다리 js + 예시 md + 런처 vbs를 base64로 품고, 실행하면
// %LOCALAPPDATA%\ClaudeBridge에 설치 + claudebridge:// 등록 + node/claude 점검 + 다리 켜기까지 전부 한다.
const bridgeBytes = fs.readFileSync(path.join(root, 'scripts', 'claude-bridge.js'));
const launcherBytes = fs.readFileSync(path.join(root, 'claude-bridge-silent.vbs')); // UTF-16LE 바이트 그대로
const watcherBytes = fs.readFileSync(path.join(root, 'scripts', 'bridge-watcher.js'));
const watcherVbsBytes = fs.readFileSync(path.join(root, 'claude-watcher-silent.vbs'));
// 설치 로직 (PowerShell, bat 안에 base64로 내장). 마커 문자열은 자기 자신과 매칭되지 않게 조각내서 만든다.
const psScript = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$silent = ($env:CB_SILENT -eq '1')  # 자동 테스트용 — 팝업 생략",
  "function Box($text, $title, $icon) { if (-not $silent) { [void][System.Windows.Forms.MessageBox]::Show($text, $title, 'OK', $icon) } }",
  "$raw = [IO.File]::ReadAllText($env:CB_SELF)",
  "function Part($name, $next) {",
  "  $m = [regex]::Match($raw, '(?s)' + [regex]::Escape(':'+':'+$name+':'+':') + '(.*?)' + [regex]::Escape(':'+':'+$next+':'+':'))",
  "  if (-not $m.Success) { throw ('설치 파일이 손상됐어요: ' + $name) }",
  "  return [Convert]::FromBase64String(($m.Groups[1].Value -replace '[^A-Za-z0-9+/=]', ''))",
  "}",
  "$dir = Join-Path $env:LOCALAPPDATA 'ClaudeBridge'",
  "New-Item -ItemType Directory -Force -Path (Join-Path $dir 'scripts') | Out-Null",
  "[IO.File]::WriteAllBytes((Join-Path $dir 'scripts\\claude-bridge.js'), (Part 'BRIDGE' 'EXAMPLES'))",
  "[IO.File]::WriteAllBytes((Join-Path $dir 'recommend-examples.md'), (Part 'EXAMPLES' 'LAUNCHER'))",
  "$launcher = Join-Path $dir 'claude-bridge-silent.vbs'",
  "[IO.File]::WriteAllBytes($launcher, (Part 'LAUNCHER' 'WATCHER'))",
  "[IO.File]::WriteAllBytes((Join-Path $dir 'scripts\\bridge-watcher.js'), (Part 'WATCHER' 'WSILENT'))",
  "$wvbs = Join-Path $dir 'claude-watcher-silent.vbs'",
  "[IO.File]::WriteAllBytes($wvbs, (Part 'WSILENT' 'END'))",
  "# 감시자: 로그인 자동시작 + 지금 기동 (플러그인 fetch가 다리를 켤 수 있게 — 피그마가 프로토콜 열기를 막는 버전 대응)",
  "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ClaudeBridgeWatcher' -Value ('wscript.exe \"' + $wvbs + '\"')",
  "Start-Process -FilePath 'wscript.exe' -ArgumentList ('\"' + $wvbs + '\"')",
  "New-Item -Path 'HKCU:\\Software\\Classes\\claudebridge\\shell\\open\\command' -Force | Out-Null",
  "Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\claudebridge' -Name '(default)' -Value 'URL:Claude Bridge'",
  "Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\claudebridge' -Name 'URL Protocol' -Value ''",
  "Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\claudebridge\\shell\\open\\command' -Name '(default)' -Value ('wscript.exe \"' + $launcher + '\"')",
  "if (-not (Get-Command node -ErrorAction SilentlyContinue)) {",
  "  if (-not $silent) {",
  "    $r = [System.Windows.Forms.MessageBox]::Show(\"설치는 끝났어요. 그런데 Node.js가 없어요.`n`n[확인]을 누르면 다운로드 페이지가 열립니다.`nNode.js 설치를 마친 뒤 이 파일을 다시 실행해 주세요.\", '클로드 다리 설치 (1/2) — Node.js', 'OKCancel', 'Warning')",
  "    if ($r -eq 'OK') { Start-Process 'https://nodejs.org/ko/download' }",
  "  }",
  "  exit",
  "}",
  "if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {",
  "  Box \"설치는 끝났어요. 그런데 Claude Code가 없어요 (또는 PATH에 없어요).`n`n터미널에서 아래를 설치·로그인한 뒤 이 파일을 다시 실행해 주세요:`n`n  npm install -g @anthropic-ai/claude-code`n  claude login`n`n확인: 터미널에서 claude --version 이 버전을 출력하면 준비 완료.`n(사용량은 이 PC에 로그인된 클로드 구독 한도에서 차감됩니다.)\" '클로드 다리 설치 (2/2) — Claude Code' 'Warning'",
  "  exit",
  "}",
  "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c node scripts\\claude-bridge.js' -WorkingDirectory $dir -WindowStyle Hidden",
  "Box \"설치 완료! 클로드 다리를 켰어요.`n`n이제 피그마 플러그인으로 돌아가 [추천받기]를 누르면 클로드가 답해요.`n다음부터는 플러그인에서 추천·번역 화면에 들어가면 자동으로 켜집니다.\" '클로드 다리 — 준비 완료' 'Information'",
].join('\n');
const b64lines = (buf) => buf.toString('base64').match(/.{1,512}/g).join('\r\n');
// 부트스트랩의 마커도 조각내서 payload 마커와 자기 매칭되지 않게 한다
const bootstrap = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$t=[IO.File]::ReadAllText($env:CB_SELF);$a=':'+':PS:'+':';$b=':'+':BRIDGE:'+':';$m=[regex]::Match($t,'(?s)'+[regex]::Escape($a)+'(.*?)'+[regex]::Escape($b));iex([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($m.Groups[1].Value -replace '[^A-Za-z0-9+/=]',''))))\"";
const batContent = [
  '@echo off',
  'rem S1 UX Writing - Claude Bridge one-shot installer (generated by npm run build - do not edit)',
  'setlocal',
  'set "CB_SELF=%~f0"',
  bootstrap,
  'endlocal',
  'exit /b',
  '::PS::',
  b64lines(Buffer.from(psScript, 'utf8')),
  '::BRIDGE::',
  b64lines(bridgeBytes),
  '::EXAMPLES::',
  b64lines(Buffer.from(recMd, 'utf8')),
  '::LAUNCHER::',
  b64lines(launcherBytes),
  '::WATCHER::',
  b64lines(watcherBytes),
  '::WSILENT::',
  b64lines(watcherVbsBytes),
  '::END::',
  '',
].join('\r\n');
fs.writeFileSync(path.join(root, '클로드다리-설치.bat'), batContent, 'utf8');
const instGen = [
  '// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드다리-설치.bat을 base64로 주입) =====',
  `const INSTALLER_B64 = ${JSON.stringify(Buffer.from(batContent, 'utf8').toString('base64'))};`,
  '// ===== INSTALLER:END =====',
].join('\n');
const reInst = /\/\/ ===== INSTALLER:BEGIN[\s\S]*?\/\/ ===== INSTALLER:END =====/;
if (!reInst.test(src)) {
  throw new Error('code.ts에서 INSTALLER 마커를 찾을 수 없습니다.');
}
src = src.replace(reInst, instGen);

fs.writeFileSync(tsPath, src, 'utf8');

// 워커(worker.js)의 RECOMMEND 마커에도 같은 예시를 주입 — AI 추천 프롬프트의 few-shot으로 쓰인다
const workerPath = path.join(root, 'naver-passport-proxy', 'worker.js');
if (fs.existsSync(workerPath)) {
  const workerGen = [
    '// ===== RECOMMEND:BEGIN — 자동 생성 영역. 직접 수정하지 말고 recommend-examples.md를 고친 뒤 npm run build =====',
    'const RECOMMEND_EXAMPLES = [',
    ...validExamples.map((e) => `  { input: ${JSON.stringify(e.input)}, suggestions: ${JSON.stringify(e.suggestions)} },`),
    '];',
    '// ===== RECOMMEND:END =====',
  ].join('\n');
  let workerSrc = fs.readFileSync(workerPath, 'utf8');
  if (reRec.test(workerSrc)) {
    fs.writeFileSync(workerPath, workerSrc.replace(reRec, workerGen), 'utf8');
  }

  // Vercel 제보 앱(ux-writing-reports)의 api/recommend.js에도 주입 — 현재 실서버 (옆 폴더에 클론돼 있을 때만).
  // 주입 후 그쪽 저장소에서 커밋+푸시해야 Vercel에 배포된다.
  const vercelRecPath = path.join(root, '..', 'ux-writing-reports', 'api', 'recommend.js');
  if (fs.existsSync(vercelRecPath)) {
    const vercelSrc = fs.readFileSync(vercelRecPath, 'utf8');
    if (reRec.test(vercelSrc)) {
      fs.writeFileSync(vercelRecPath, vercelSrc.replace(reRec, workerGen), 'utf8');
      console.log('[recommend] ux-writing-reports/api/recommend.js에도 반영 — 그쪽 저장소에서 커밋+푸시 필요');
    }
  }
}

console.log(`[glossary] 용어 ${terms.length}건, 권장 문구 ${phrases.length}건, 합성어 ${compounds.length}건, 동작 명사 ${actionNouns.length}건, 예외 표기 ${keepSpellings.length}건 반영`);
console.log(`[recommend] 추천 예시 ${validExamples.length}건 반영 (code.ts + worker.js)`);
