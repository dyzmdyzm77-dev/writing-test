# S1 UX Writing Assistant (Figma 플러그인)

에스원 UX Writing 검토 플러그인. 선택 영역의 텍스트를 네이버 맞춤법 + 로컬 규칙(용어집/해요체/띄어쓰기)으로 검사하고, 캔버스에 형광펜·코멘트를 표시한다.

## 빌드/실행

- `npm install` (최초 1회) → `npm run build` → Figma에서 Plugins > Development > Import plugin from manifest
- `npm run build` = glossary.md를 code.ts에 주입(`scripts/build-glossary.js`) + tsc 컴파일. **code.ts의 GLOSSARY:BEGIN/END 마커 영역은 자동 생성 — 직접 수정 금지**
- ui.html은 빌드 불필요 (플러그인 재실행만)
- 검증은 vm 샌드박스로: code.js를 `vm.runInContext`에 figma 스텁과 함께 로드해 `suggestFriendlyKorean(text, naverChecked)` 호출

## 용어집 워크플로우

- 단순 치환/합성어 보호/동작 명사/예외 표기는 **glossary.md에서 편집** → `npm run build`
- 가드(lookahead)가 필요한 규칙만 code.ts의 TERM_RULES에 직접 작성
- "X → X처럼 똑같아 보이는 제안"이 나오면 → 네이버가 합성어를 띄어 쓴 것 → glossary.md "합성어 보호"에 단어 추가
- 네이버가 표기를 바꾸는 단어(렌탈→렌털 등) → "예외 표기" 표에 추가

## 핵심 설계 결정 (바꾸기 전에 읽을 것)

- **띄어쓰기는 네이버 우선**: 부사 띄어쓰기 정규식(ADVERB_SPACING_RULES)은 네이버 실패 시 폴백 전용. COMPOUND_PROTECT_RULES가 네이버의 합성어 분리를 되돌림
- **네이버 검사는 배치**(여러 문구를 \n으로 묶어 요청 1개) + 세션 캐시(naverCache). 줄바꿈은 <br>로 보존됨(실서버 확인). 공백 구조는 alignWhitespace로 원문에 정렬 (U+2028 등 모든 줄바꿈 문자 처리 — \n만 가정하지 말 것)
- **위치 추적은 폴링 금지**: dynamic-page라 figma.on('documentchange')는 등록 실패 → `figma.currentPage.on('nodechange')` 사용. setInterval 폴링은 수천 개 어노테이션에서 캔버스 렉 유발 (제거된 이력 있음)
- **동기 getNodeById 금지** (dynamic-page에서 throw) → getNodeByIdAsync
- '해 주세요' 띄어쓰기: 동작 명사(glossary.md 목록)면 '확인해 주세요', 부사면 '같이 해주세요'
- 검토 사유는 키워드 칩(맞춤법/띄어쓰기/해요체/간결하게/용어 통일 등 10종)으로 표시
- **코멘트는 현재 네이티브 어노테이션 프로토타입** (node.annotations — 클릭해도 크기 배지 안 뜸). 초록 말풍선 복귀: `git revert b365c35` (createCommentFrame 보존돼 있음). 크기 배지를 숨기는 API는 없음(확정)

## 주의

- 검토 시 텍스트가 외부(Cloudflare Worker + 네이버)로 전송됨 — 워커 주소는 code.ts의 NAVER_PROXY_URL, manifest.json allowedDomains와 함께 변경
- 네이버 SpellerProxy는 비공식 API (passportKey 방식) — 깨지면 로컬 규칙만으로 동작
