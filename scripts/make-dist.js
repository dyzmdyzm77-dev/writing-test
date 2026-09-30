// 배포용 zip 만들기 — 사용자가 쓰는 데 필요한 파일만 담는다.
//   npm run dist   →  out/S1-UX-Writing-Agent-V<버전>.zip  (버전은 ui.html의 #appVersion에서 읽는다)
// 개발용(code.ts, CLAUDE.md, glossary.md, package.json, scripts/build-*.js …)은 뺀다.
// ⚠️ package.json을 넣으면 안 된다 — 감시자 /update가 "저장소에서 도는 중"으로 보고 자동 갱신을 거절한다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const root = path.join(__dirname, '..');

const ui = fs.readFileSync(path.join(root, 'ui.html'), 'utf8');
const ver = (ui.match(/id="appVersion"[^>]*>\s*(V[\d.]+)\s*</) || [, 'V0'])[1];
const folder = 'S1-UX-Writing-Agent';

// 담을 파일 (zip 안 경로 → 저장소 경로)
const FILES = [
  'manifest.json', 'code.js', 'ui.html',                      // 플러그인 본체
  '설치.bat',                                                  // 커넥터 설치 (숨긴 코드 없는 얇은 파일)
  'claude-bridge-silent.vbs', 'claude-watcher-silent.vbs',     // 런처 (UTF-16LE 바이트 그대로)
  'scripts/claude-bridge.js', 'scripts/bridge-watcher.js', 'scripts/register-protocol.js',
  'recommend-examples.md', 'ux-writing.md',                    // 다리가 실행 중 읽는 규칙·예시
];
const readme = [
  `S-1 S/W UX Writing Agent ${ver} — 설치 방법`,
  '',
  '1. 이 폴더를 지우지 않을 곳에 두세요 (예: 문서 폴더). 커넥터가 이 폴더의 파일을 실행합니다.',
  '2. [윈도우] 설치.bat 을 더블클릭하세요.',
  '   [맥]    터미널에서 이 폴더로 이동한 뒤  node scripts/register-protocol.js  를 실행하세요.',
  '   - Node.js 가 필요합니다. 없으면 https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행하세요.',
  '   - 문구 추천·번역·대화를 쓰려면 Claude Code 로그인이 필요합니다 (검토만 쓰면 없어도 됩니다).',
  '     npm install -g @anthropic-ai/claude-code  →  claude login',
  '3. 피그마 데스크톱 → Plugins → Development → Import plugin from manifest → 이 폴더의 manifest.json',
  '',
  '업데이트: 새 버전 zip을 받아 이 폴더에 덮어쓰고 플러그인을 다시 실행하세요.',
  '          커넥터(감시자·다리)는 플러그인이 알아서 갱신합니다. 홈 화면 오른쪽 위 숫자가 현재 버전입니다.',
  '',
  '이 폴더의 파일은 모두 평범한 스크립트입니다 (숨긴 코드·다운로드 없음).',
  '',
].join('\r\n');

// ── zip 라이터 (deflate) ──
function crc32(buf) {
  let c, table = crc32.t || (crc32.t = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })());
  c = -1; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function zip(entries) {
  const parts = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), data = e.data, comp = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0x0800, 6); lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(0, 10); lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(comp.length, 18); lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26); lfh.writeUInt16LE(0, 28);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(0x031E, 4); cdh.writeUInt16LE(20, 6); cdh.writeUInt16LE(0x0800, 8); cdh.writeUInt16LE(8, 10);
    cdh.writeUInt32LE(0, 12); cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(comp.length, 20); cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(name.length, 28); cdh.writeUInt32LE((((e.exec ? 0o100755 : 0o100644) << 16) >>> 0), 38); cdh.writeUInt32LE(offset, 42);
    parts.push(lfh, name, comp); central.push(cdh, name); offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(parts), cd, eocd]);
}

const entries = FILES.map((f) => {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) throw new Error('배포에 넣을 파일이 없어요: ' + f);
  return { name: folder + '/' + f, data: fs.readFileSync(p) };
});
entries.unshift({ name: folder + '/읽어주세요.txt', data: Buffer.from('﻿' + readme, 'utf8') }); // 메모장용 BOM
const out = zip(entries);
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
const outPath = path.join(root, 'out', `${folder}-${ver}.zip`);
fs.writeFileSync(outPath, out);
const raw = entries.reduce((a, e) => a + e.data.length, 0);
console.log(`[dist] ${path.relative(root, outPath)} — ${entries.length}개 파일, 원본 ${Math.round(raw / 1024)} KB → zip ${Math.round(out.length / 1024)} KB`);
