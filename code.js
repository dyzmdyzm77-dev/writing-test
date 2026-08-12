/// <reference types="@figma/plugin-typings" />
// UI 띄우기
const UI_INIT_W = 400;
const UI_INIT_H = 780;
figma.showUI(__html__, { width: UI_INIT_W, height: UI_INIT_H });
// 직전 UI 크기 추적 (리사이즈 시 반대쪽 가장자리 고정 계산용)
let uiLastW = UI_INIT_W;
let uiLastH = UI_INIT_H;
// 코멘트 말풍선을 클릭하면 우리가 곧바로 선택을 비운다(크기 배지 숨김용).
// 그때 되돌아오는 빈 선택 메아리(selectionchange)는 흐려짐 상태를 유지한 채 무시해야 한다.
let suppressSelectionReset = false;
// 선택 상태 변경 감지
figma.on('selectionchange', () => {
    const selection = figma.currentPage.selection;
    // 우리가 말풍선 클릭 직후 비운 선택의 메아리 → 흐려짐/포커스 상태를 그대로 두고 종료
    if (suppressSelectionReset) {
        suppressSelectionReset = false;
        return;
    }
    // 캔버스에서 코멘트(어노테이션)를 직접 클릭한 경우 → 그것만 선명, 나머지는 흐리게 + 맨 앞으로
    try {
        const annNodeIds = [];
        const annSegIds = [];
        const regularNodes = [];
        for (const n of selection || []) {
            const p = parseAnnNode(n);
            if (p) {
                annNodeIds.push(p.nodeId);
                annSegIds.push(annSegId(p.key));
            }
            else {
                regularNodes.push(n);
            }
        }
        // 말풍선(코멘트)만 클릭한 경우: 그것만 선명 + 목록 동기화 후 즉시 선택 해제 → 배지가 뜰 새 없이 사라진다.
        // (코멘트는 콘텐츠 선택이 아니므로 selection-changed는 보내지 않아 검토 버튼 상태가 흔들리지 않는다)
        if (annSegIds.length > 0 && regularNodes.length === 0) {
            updateAnnotationOpacityBySeg(annSegIds);
            bringAnnotationsToFront(annNodeIds);
            figma.ui.postMessage({ type: 'canvas-selection', nodeIds: Array.from(new Set(annNodeIds)) });
            suppressSelectionReset = true;
            figma.currentPage.selection = []; // 흐려짐은 opacity로 노드에 남고, 선택만 비워 배지 숨김
            return;
        }
        // 그 외(일반 노드 / 혼합 / 빈 선택): UI에 선택 상태 전송
        figma.ui.postMessage({
            type: 'selection-changed',
            hasSelection: selection && selection.length > 0
        });
        if (annSegIds.length > 0) {
            // 코멘트+일반 혼합 선택(드묾) — 세그먼트 단위로 처리
            updateAnnotationOpacityBySeg(annSegIds);
            bringAnnotationsToFront(annNodeIds);
        }
        else {
            // 일반 노드 선택 시: 관련 코멘트 투명도 갱신 + 앞으로
            updateAnnotationOpacityFromCanvas(selection || []);
        }
        // 캔버스 선택 → 검토 목록에서도 같은 항목을 선택 표시하도록 nodeId 목록 전송
        const targetIds = new Set();
        for (const id of annNodeIds)
            targetIds.add(id); // 코멘트를 직접 클릭한 경우 그 대상 노드
        if (regularNodes.length > 0) {
            const selIds = new Set();
            for (const n of regularNodes)
                if (n && n.id)
                    selIds.add(n.id);
            // 선택한 노드(또는 그 프레임) 안에 있는 검토 대상 노드들을 찾는다
            for (const [nodeId, ancestors] of annotationAncestorIds) {
                for (const id of selIds) {
                    if (ancestors.has(id)) {
                        targetIds.add(nodeId);
                        break;
                    }
                }
            }
        }
        figma.ui.postMessage({ type: 'canvas-selection', nodeIds: Array.from(targetIds) });
        // 추천/번역 화면 자동 입력용: 선택 영역(프레임/텍스트) 안의 문구를 UI로 전달.
        // 선택 해제(빈 선택) 시엔 빈 문자열을 보내 입력창도 비울 수 있게 한다.
        if (regularNodes.length > 0) {
            // '텍스트 여러 개 든 컴포넌트'(팝업)면 입력창을 채우지 않고 팝업 신호만 — [추천받기]가 요소별로 갈린다.
            const sel0 = selection && selection[0];
            const popupEls = (sel0 && sel0.type !== 'TEXT') ? classifyPopup(sel0) : [];
            if (isDialogLike(sel0, popupEls)) {
                figma.ui.postMessage({ type: 'selection-text', text: '', popup: popupEls.length, popupElements: popupEls });
            }
            else {
                // 팝업이 아니면 문구를 입력창에 채우고, '프레임 안 프레임'이면 하위 프레임별 묶음도 함께 보낸다.
                // 버튼을 고른 경우엔 역할(버튼)도 실어 보낸다 — 버튼 문구는 문장이 아니라 동작 이름이라 규칙이 다르다.
                const groups = frameGroupsForSelection(selection);
                const role = (selection.length === 1 && detectButtonRole(sel0)) ? '버튼' : undefined;
                collectSelectedText().then((t) => {
                    figma.ui.postMessage({ type: 'selection-text', text: (t && t.trim()) ? t : '', popup: 0, groups, role });
                }).catch(() => { });
            }
        }
        else if (!selection || selection.length === 0) {
            figma.ui.postMessage({ type: 'selection-text', text: '', popup: 0 });
        }
    }
    catch (_e) { }
});
// 초기 선택 상태 전송
const initialSelection = figma.currentPage.selection;
figma.ui.postMessage({
    type: 'selection-changed',
    hasSelection: initialSelection && initialSelection.length > 0
});
// 플러그인을 열 때 이미 프레임이 선택돼 있으면 그 문구를 미리 잡아둔다 (추천/번역 입력창 자동 채움용).
// 초기엔 selectionchange가 안 울려서 이걸 안 하면 첫 진입 때 입력창이 비어 버린다.
if (initialSelection && initialSelection.length > 0) {
    const s0 = initialSelection[0];
    const popupEls = (s0 && s0.type !== 'TEXT') ? classifyPopup(s0) : [];
    if (isDialogLike(s0, popupEls)) {
        figma.ui.postMessage({ type: 'selection-text', text: '', popup: popupEls.length, popupElements: popupEls, onEnter: true });
    }
    else {
        const groups0 = frameGroupsForSelection(initialSelection);
        const role0 = (initialSelection.length === 1 && detectButtonRole(s0)) ? '버튼' : undefined;
        collectSelectedText().then((t) => {
            if (t && t.trim())
                figma.ui.postMessage({ type: 'selection-text', text: t, groups: groups0, role: role0, onEnter: true });
        }).catch(() => { });
    }
}
const UX_PATTERNS = [
    { pattern: "됩니다", replacement: "돼요", description: "해요체", tag: "tone" },
    { pattern: "합니다", replacement: "해요", description: "해요체", tag: "tone" },
    { pattern: "있습니다", replacement: "있어요", description: "해요체", tag: "tone" },
    { pattern: "하시면", replacement: "하면", description: "간결하게", tag: "shorten" },
    { pattern: "하십시오", replacement: "해주세요", description: "해요체", tag: "tone" },
];
// (용어 통일 규칙은 TERM_RULES로 이동 — 톤 변환보다 먼저 적용해야 권장 문구 패턴이 맞는다)
// ===============================
// 유틸리티 함수
// ===============================
// 정규식 특수문자 이스케이프 함수
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// 한글 글자의 받침 유무 확인 함수
function hasJongseong(char) {
    const code = char.charCodeAt(0);
    // 한글 유니코드 범위: 가(0xAC00) ~ 힣(0xD7A3)
    if (code >= 0xAC00 && code <= 0xD7A3) {
        // 받침이 있으면: (charCode - 0xAC00) % 28 > 0
        return (code - 0xAC00) % 28 > 0;
    }
    return false;
}
const TYPO_RULES = [
    // 맞춤법
    { pattern: /\b되요\b/g, replacement: "돼요", reason: "맞춤법", tags: ["typo", "tone"] },
    { pattern: /안되(?=[\s.,!?]|$)/g, replacement: "안 돼", reason: "맞춤법", tags: ["typo", "spacing"] },
    { pattern: /\b몇일\b/g, replacement: "며칠", reason: "맞춤법", tags: ["typo"] },
    { pattern: /\b웬지\b/g, replacement: "왠지", reason: "맞춤법", tags: ["typo"] },
    // 띄어쓰기 - 조사 앞 (명사+조사 다음에 명사/동사가 올 때)
    // 주의: 외래어나 합성어에 잘못 적용되지 않도록 제한적으로 적용
    // 일반 단어에 잘못 적용되는 문제로 주석 처리
    // { pattern: /([가-힣]{2,})(의)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기", tags: ["spacing"] },
    // { pattern: /([가-힣]{2,})(을|를)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기", tags: ["spacing"] },
    // { pattern: /([가-힣]{2,})(이|가)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기", tags: ["spacing"] },
    // { pattern: /([가-힣]{2,})(은|는)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기", tags: ["spacing"] },
    // { pattern: /([가-힣]{2,})(와|과)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기", tags: ["spacing"] },
    // "에" 조사는 외래어(크리에이터 등)와 구분하기 위해 제외
    // { pattern: /([가-힣]{2,})(에|에서|에게|에게서|로|으로|만|도|까지|부터|처럼|같이|보다|커녕)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기", tags: ["spacing"] },
    // 띄어쓰기 - "-하다" 형용사 + 종결어미 (불가능합니다, 가능해요 등 - 붙여쓰기)
    { pattern: /(불가능|가능|필요|불필요) (합니다|해요)/g, replacement: "$1$2", reason: "띄어쓰기", tags: ["spacing"] },
    // 띄어쓰기 - 보조동사/의존명사
    { pattern: /할수/g, replacement: "할 수", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /될수/g, replacement: "될 수", reason: "띄어쓰기", tags: ["spacing"] },
    // "~할 수 있", "~길어질 수 있" 등: 앞 단어 + 의존명사 "수" + "있" 분리 (할수있, 수있보다 먼저 적용)
    { pattern: /([가-힣]{1,})(수)(있)/g, replacement: "$1 $2 $3", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /수있/g, replacement: "수 있", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /하시는게/g, replacement: "하는 게", reason: "띄어쓰기", tags: ["spacing", "tone"] },
    { pattern: /하는게/g, replacement: "하는 게", reason: "띄어쓰기", tags: ["spacing"] },
    // 일반 단어에 잘못 적용되는 문제로 주석 처리
    // { pattern: /([가-힣])(것|수|때|곳|데|줄|지|뿐|만큼|대로|듯이|만|뿐)([가-힣])/g, replacement: "$1$2 $3", reason: "띄어쓰기", tags: ["spacing"] },
    // { pattern: /([가-힣])(있다|없다|주다|보내다|받다|주시다|드리다|보이다|되다|하다)([가-힣])/g, replacement: "$1 $2$3", reason: "띄어쓰기", tags: ["spacing"] },
    // (부사 뒤 띄어쓰기 규칙은 오탐이 있어 ADVERB_SPACING_RULES로 분리 —
    //  네이버 맞춤법 검사가 실패한 텍스트에만 폴백으로 적용한다)
    // 띄어쓰기 - 층수 + 장소명 (7층 사무실, 3층 회의실 등)
    { pattern: /([0-9]+층)(사무실|회의실|휴게실|복도)([가-힣])/g, replacement: "$1 $2 $3", reason: "띄어쓰기", tags: ["spacing"] },
    // 띄어쓰기 - 수사 + 단위명사 (두 줄)
    { pattern: /두줄/g, replacement: "두 줄", reason: "띄어쓰기", tags: ["spacing"] },
    // 띄어쓰기 - 조사 "로/으로" + 동사 "들어갈"
    { pattern: /(로|으로)(들어갈)/g, replacement: "$1 $2", reason: "띄어쓰기", tags: ["spacing"] },
    // 띄어쓰기 - "정도로" 뒤 (정도로 길어질)
    { pattern: /정도로([가-힣])/g, replacement: "정도로 $1", reason: "띄어쓰기", tags: ["spacing"] },
    // 띄어쓰기 - 일반적인 동사/명사 앞 띄어쓰기
    // 주의: 외래어(크리에이터 등)에 잘못 적용되지 않도록 제한적으로 적용
    // { pattern: /([가-힣]{2,})(시작|종료|완료|중지|재개|변경|수정|삭제|추가|생성|등록|확인|조회|검색|저장|업로드|다운로드|열기|닫기|보기|보내기|받기|전송|수신|발송|접수|처리|승인|거부|반려|취소|해제|설정|해제|초기화|복구|백업|복원|이동|복사|붙여넣기|잠금|잠금해제|공유|다운로드|인쇄|출력|보관|삭제|복원|복구|수정|편집|저장|불러오기|내보내기|가져오기|연결|연결해제|접속|접속해제|로그인|로그아웃|가입|탈퇴|신청|취소|결제|환불|교환|반품|배송|수령|확인|리뷰|평가|추천|신고|차단|해제|차단해제|팔로우|언팔로우|구독|구독해제|알림|알림해제|공지|이벤트|쿠폰|적립|사용|적용|해제|적용해제|변경|변경해제|수정|수정해제|삭제|삭제해제|추가|추가해제|생성|생성해제|등록|등록해제|확인|확인해제|조회|조회해제|검색|검색해제|저장|저장해제|업로드|업로드해제|다운로드|다운로드해제)/g, replacement: "$1 $2", reason: "띄어쓰기", tags: ["spacing"] },
    // 띄어쓰기 - 수사 + 단위명사
    // 주의: "2026년", "6000억원" 등은 일반적으로 붙여쓰기도 허용되므로 주석 처리
    // { pattern: /([0-9]+)(개|명|장|권|대|마리|벌|자루|개월|년|일|시간|분|초|원|달러|엔|위안|파운드|유로|킬로|그램|리터|미터|센티미터|킬로미터|평|제곱미터|세제곱미터)/g, replacement: "$1 $2", reason: "띄어쓰기", tags: ["spacing"] },
    // { pattern: /([일이삼사오육칠팔구십백천만억조]+)(개|명|장|권|대|마리|벌|자루|개월|년|일|시간|분|초|원|달러|엔|위안|파운드|유로|킬로|그램|리터|미터|센티미터|킬로미터|평|제곱미터|세제곱미터)/g, replacement: "$1 $2", reason: "띄어쓰기", tags: ["spacing"] },
];
// ===============================
// 부사 뒤 띄어쓰기 규칙 (폴백 전용)
// 형태소 분석 없는 정규식이라 오탐이 있다 ("다시마"→"다시 마", "함께하는"→"함께 하는" 등).
// 띄어쓰기는 네이버 맞춤법 검사 결과를 우선하고, 이 규칙들은
// 네이버 검사가 실패/불가한 텍스트(프록시 장애, 500자 초과 등)에만 적용한다.
// ===============================
const ADVERB_SPACING_RULES = [
    { pattern: /지금([가-힣]{2,})/g, replacement: "지금 $1", reason: "띄어쓰기", tags: ["spacing"] },
    // "이미" + 다음 단어 (부사) - "이미지"(image)는 예외
    { pattern: /이미(?!지)([가-힣]{2,})/g, replacement: "이미 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /아직([가-힣]{2,})/g, replacement: "아직 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /곧([가-힣]{2,})/g, replacement: "곧 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /다시([가-힣]{2,})/g, replacement: "다시 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /계속([가-힣]{2,})/g, replacement: "계속 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /항상([가-힣]{2,})/g, replacement: "항상 $1", reason: "띄어쓰기", tags: ["spacing"] },
    // "보통" + 다음 단어 - "정보통신망" 등 합성어는 예외
    { pattern: /보통(?!신)([가-힣]{2,})/g, replacement: "보통 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /가끔([가-힣]{2,})/g, replacement: "가끔 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /자주([가-힣]{2,})/g, replacement: "자주 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /때때로([가-힣]{2,})/g, replacement: "때때로 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /빨리([가-힣]{2,})/g, replacement: "빨리 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /천천히([가-힣]{2,})/g, replacement: "천천히 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /갑자기([가-힣]{2,})/g, replacement: "갑자기 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /같이([가-힣]{2,})/g, replacement: "같이 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /함께([가-힣]{2,})/g, replacement: "함께 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /혼자([가-힣]{2,})/g, replacement: "혼자 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /먼저([가-힣]{2,})/g, replacement: "먼저 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /나중에([가-힣]{2,})/g, replacement: "나중에 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /처음([가-힣]{2,})/g, replacement: "처음 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /마지막([가-힣]{2,})/g, replacement: "마지막 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /오늘([가-힣]{2,})/g, replacement: "오늘 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /내일([가-힣]{2,})/g, replacement: "내일 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /어제([가-힣]{2,})/g, replacement: "어제 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /내년([가-힣]{2,})/g, replacement: "내년 $1", reason: "띄어쓰기", tags: ["spacing"] },
    { pattern: /작년([가-힣]{2,})/g, replacement: "작년 $1", reason: "띄어쓰기", tags: ["spacing"] },
];
// ===============================
// 날짜·시간 표기 규칙 (ux-writing.md "7. 날짜·시간·숫자 표기" — 항상 적용)
// 오탐 없이 결정적으로 고칠 수 있는 것만 자동화한다.
// - 번호(전화/카드/계좌): raw 숫자만으론 구분 위치를 확정할 수 없어 제외
// - 오전/오후: "사용자가 직접 고르는 방문·예약 시간" 예외를 텍스트만으론 구분 못 해 제외
// ===============================
const DATE_FORMAT_RULES = [
    // 날짜 구분자 통일: YYYY-MM-DD, YYYY/MM/DD, YYYY.M.D → YYYY.MM.DD (0 채움)
    // 월(1~12)·일(1~31) 범위를 벗어나면 날짜가 아니라고 보고 그대로 둔다.
    // \b(\d{4}) 로 4자리 연도만 잡아 카드번호·버전 문자열(10.0.x 등)을 건드리지 않는다.
    {
        pattern: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g,
        replacement: (_m, y, mo, d) => {
            const mn = parseInt(mo, 10), dn = parseInt(d, 10);
            if (mn < 1 || mn > 12 || dn < 1 || dn > 31)
                return _m; // 날짜 아님 → 그대로
            const pad = (n) => (n < 10 ? "0" + n : String(n));
            return `${y}.${pad(mn)}.${pad(dn)}`;
        },
        reason: "날짜 표기",
        tags: ["format"],
    },
    // 문장 속 연월일: 월/일 앞의 0 제거 (2026년 08월 05일 → 2026년 8월 5일)
    // 앞이 숫자면(108월 등) 건드리지 않는다. 01~09만 대상(10~12는 0 없음).
    { pattern: /(^|[^0-9])0([1-9])월/g, replacement: "$1$2월", reason: "날짜 표기", tags: ["format"] },
    { pattern: /(^|[^0-9])0([1-9])일/g, replacement: "$1$2일", reason: "날짜 표기", tags: ["format"] },
];
// ===== GLOSSARY:BEGIN — 자동 생성 영역. 직접 수정하지 말고 glossary.md를 고친 뒤 npm run build =====
const GLOSSARY_TERMS = [
    { from: "개인 사용자 조회", to: "개별 사용자 조회" },
    { from: "자격선택", to: "권한설정" },
    { from: "단순 출입정보", to: "일반 출입정보" },
    { from: "개인별 로그 정보", to: "개인별 사용 이력" },
    { from: "자격별", to: "권한별" },
    { from: "관리자 리스트", to: "관리자 목록" },
    { from: "총 사용자", to: "전체 사용자" },
    { from: "재부팅", to: "재시작" },
    { from: "에러", to: "오류" },
    { from: "테스트", to: "시험" },
    { from: "F/W", to: "펌웨어" },
    { from: "업그레이드", to: "업데이트" },
    { from: "이름 출력", to: "이름 표시" },
    { from: "패스워드", to: "비밀번호" },
    { from: "콜센터", to: "고객센터" },
    { from: "문개폐", to: "문 열림" },
    { from: "방범구역", to: "경비구역" },
    { from: "세콤 시스템", to: "경비 시스템" },
    { from: "지문 획득", to: "지문 스캔" },
];
const GLOSSARY_COMPOUNDS = [
    "고객인증번호",
    "휴대전화번호",
    "긴급연락처",
    "사용자번호",
    "휴대전화",
    "인증번호",
    "출입정보",
    "권한설정",
    "자격선택",
    "메뉴진입",
    "방범구역",
    "경비구역",
    "배경화면",
    "상단정보",
    "부팅중",
    "풍수재",
    "알림톡",
];
const GLOSSARY_ACTION_NOUNS = [
    "확인",
    "문의",
    "저장",
    "삭제",
    "등록",
    "입력",
    "선택",
    "설정",
    "변경",
    "수정",
    "추가",
    "취소",
    "신청",
    "동의",
    "인증",
    "연결",
    "해제",
    "시도",
    "사용",
    "적용",
    "이동",
    "클릭",
    "터치",
    "검색",
    "조회",
    "작성",
    "제출",
    "첨부",
    "업로드",
    "다운로드",
    "로그인",
    "로그아웃",
    "재시작",
    "시작",
    "종료",
    "갱신",
    "예약",
    "결제",
    "가입",
    "인쇄",
    "출력",
    "복사",
    "백업",
    "복원",
    "차단",
    "허용",
];
const GLOSSARY_KEEP_SPELLINGS = [
    { keep: "렌탈", naver: "렌털" },
];
const GLOSSARY_PHRASES = [
    { from: "되어요", to: "돼요" },
    { from: "되었어요", to: "됐어요" },
    { from: "되었습니다", to: "됐어요" },
    { from: "하시겠어요", to: "할까요" },
    { from: "계시나요", to: "있나요" },
    { from: "여쭤볼게요", to: "확인할게요" },
    { from: "보냅니다", to: "보내요" },
];
// ===== GLOSSARY:END =====
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
    { input: "홍*동(010-1234-5678) 외 2명에게 권한 삭제 알림톡을 전송할까요?", suggestions: ["권한 삭제 알림톡을 보내려고 해요.\n홍*동(010-1234-5678) 님 외 2명에게 보낼까요?", "홍*동(010-1234-5678) 님 외 2명에게 권한 삭제 알림톡을 보낼까요?", "권한 삭제 알림톡을 홍*동(010-1234-5678) 님 외 2명에게 보낼까요?"] },
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
    { input: "권한 신청을 취소하시겠습니까? 취소하실 경우 신청하신 내용은 저장되지 않습니다.", suggestions: ["취소하면 신청한 내용이 저장되지 않아요.\n권한 신청을 취소할까요?", "권한 신청을 취소할까요?\n취소하면 입력한 내용이 사라져요."] },
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
    { input: "본 계약의 유일한 마스터 관리자로 일반관리자로 권한변경을 하실 수 없어요. 일반 관리자로 권한 변경을 원하실 경우 다른 사람에게 마스터 관리자 권한을 지정해 주신 후 다시 시도해 주세요.", suggestions: ["다른 사람을 마스터 관리자로 지정한 뒤 일반 관리자로 변경할 수 있어요.", "다른 사람을 마스터 관리자로 지정하면 변경할 수 있어요."] },
];
// ===== RECOMMEND:END =====
// 문구 추천 — 예시 사전 기반 (서버 없이 로컬에서 동작).
// 입력을 정규화한 뒤 recommend-examples.md의 원본과
// ① 완전히 같거나 ② 서로 포함하면 그 예시의 추천안을 돌려준다. 없으면 빈 배열.
// 정규화 시 마스킹된 이름(홍*동)·"이름(번호)" 묶음(홍길동(010-… / ***) 포함)·숫자·공백·문장부호를
// 무시하므로 이름/수량/번호만 다른 가변 문구도 같은 예시로 매칭된다.
function normalizeForMatch(s) {
    return s
        .replace(/[가-힣][가-힣*]{1,3}\s*\([*0-9\-\s]*\)/g, '') // 이름(전화번호/마스킹) 묶음 — 실명도 커버
        .replace(/[가-힣]\*[가-힣]+/g, '') // 마스킹된 이름 (홍*동) — 문장부호 제거 전에 먼저
        .replace(/[0-9]+/g, '') // 숫자 (전화번호·수량·버전 등)
        .replace(/[\s\p{P}]/gu, '')
        .toLowerCase();
}
// ── 키 없이 동작하는 로컬 추천 폴백 ──────────────────────────
// 개인 Gemini 키가 없거나 AI 호출이 실패해도(프록시 차단 등) 추천이 비지 않게 한다.
// ① 유사 예시: 예시 사전과 완전 일치는 아니어도 충분히 비슷하면 그 예시의 추천안을 제시
// ② 규칙 기반: 검토 규칙(해요체·용어 통일 등)으로 다듬은 문장을 추천으로 제시
function bigramSet(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++)
        set.add(s.slice(i, i + 2));
    return set;
}
// 두 문자열의 바이그램(연속 2글자 조각) Dice 유사도: 0(다름)~1(같음)
function diceSimilarity(a, b) {
    if (a.length < 2 || b.length < 2)
        return a === b ? 1 : 0;
    const A = bigramSet(a);
    const B = bigramSet(b);
    let inter = 0;
    A.forEach((g) => { if (B.has(g))
        inter++; });
    return (2 * inter) / (A.size + B.size);
}
// 문장 끝 어미(습니다/할까요/해주세요 등) — 유사도 비교 전에 잘라내는 보조 정규화용.
// 어미 차이("~하시겠습니까?" vs "~할까요?")는 추천 관점에선 같은 문장인데 바이그램 점수를
// 크게 깎아서, 어미를 뗀 몸통끼리도 한 번 더 비교한다. 긴 어미가 먼저 매칭되도록 순서 유지.
const SENTENCE_ENDING_RE = /(해 주시기 바랍니다|주시기 바랍니다|하시겠습니까|하시겠어요|시겠습니까|시겠어요|되었습니다|하였습니다|였습니다|았습니다|었습니다|했습니다|됐습니다|바랍니다|해주십시오|하십시오|해주세요|해 주세요|입니다|합니다|됩니다|습니다|습니까|합니까|할까요|될까요|주세요|십시오|하세요|이에요|예요|세요|어요|아요|해요|돼요|네요|죠)\s*$/;
function normalizeForSimilarity(s) {
    return s
        // 같은 뜻의 다른 표현을 한 형태로 통일 — "이용이 불가합니다" ↔ "이용할 수 없습니다"가
        // 같은 문장으로 비교되게 한다 (유사도 비교 전용 — 완전 일치 매칭에는 영향 없음)
        .replace(/불가능합니다|불가능해요|불가합니다|불가해요/g, '할 수 없습니다')
        .replace(/가능합니다|가능해요/g, '할 수 있습니다')
        .replace(/하시/g, '하') // 경어 '시' 무시 (하시면→하면)
        .replace(/([가-힣])\s+시\s+/g, '$1하면 ') // "탈퇴 시" ↔ "탈퇴하면" (숫자+시(時)는 공백 조건 때문에 안 걸림)
        .split(/[.!?…\n\u2028\u2029]+/) // 문장 단위로 쪼개서
        .map((seg) => seg.trim().replace(SENTENCE_ENDING_RE, '')) // 각 문장의 끝 어미 제거
        .join(' ')
        .replace(/[가-힣][가-힣*]{1,3}\s*\([*0-9\-\s]*\)/g, '') // 이름(전화번호/마스킹) 묶음 — normalizeForMatch와 동일
        .replace(/[가-힣]\*[가-힣]+/g, '')
        .replace(/[0-9]+/g, '')
        .replace(/[\s\p{P}]/gu, '')
        .toLowerCase();
}
// 전체 비교는 0.75, 어미 뗀 몸통 비교는 0.8 이상이어야 같은 문장으로 취급.
// (몸통 비교는 정보가 줄어든 상태라 문턱을 더 높게 잡아 오매칭을 막는다)
const FUZZY_RECOMMEND_THRESHOLD = 0.75;
const FUZZY_STRIPPED_THRESHOLD = 0.8;
// 문턱을 넘는 예시를 유사도 순으로 최대 3개까지 모아 그 추천안들을 합쳐 돌려준다
// (1개만 꺼내면 새 문장에 카드가 1~2장뿐이라 제안이 빈약해짐 — 다양성 확보)
const FUZZY_MAX_EXAMPLES = 3;
function fuzzyRecommend(text) {
    const q = normalizeForMatch(text);
    if (q.length < 8)
        return []; // 짧은 문장은 우연히 비슷해질 확률이 높아 제외
    const qs = normalizeForSimilarity(text);
    const hits = [];
    for (const ex of RECOMMEND_EXAMPLES) {
        const n = normalizeForMatch(ex.input);
        if (n.length < 8)
            continue;
        const full = diceSimilarity(q, n);
        let stripped = 0;
        if (qs.length >= 5) {
            const ns = normalizeForSimilarity(ex.input);
            if (ns.length >= 5)
                stripped = diceSimilarity(qs, ns);
        }
        if (full >= FUZZY_RECOMMEND_THRESHOLD || stripped >= FUZZY_STRIPPED_THRESHOLD) {
            hits.push({ score: Math.max(full, stripped), suggestions: ex.suggestions });
        }
    }
    hits.sort((a, b) => b.score - a.score);
    const out = [];
    for (const h of hits.slice(0, FUZZY_MAX_EXAMPLES)) {
        for (const s of h.suggestions) {
            if (out.indexOf(s) === -1)
                out.push(s);
        }
    }
    return out;
}
// 예시 추천안을 입력 문구의 실제 값으로 각색한다.
// 예시 사전의 더미 값("홍*동(…)", "외 2명")이 그대로 노출되지 않도록,
// 입력에서 같은 유형의 토큰을 찾아 순서대로 끼워 넣는다 (입력에 없으면 예시 값 유지).
const NAME_PHONE_RE = /[가-힣][가-힣*]{1,3}\s*\(\s*[*0-9\-\s]+\s*\)/g; // 이름(전화번호/마스킹)
const PERSON_COUNT_RE = /외\s*[0-9]+\s*명/g; // 외 N명
function adaptSuggestionToInput(suggestion, input) {
    let out = suggestion;
    const names = input.match(NAME_PHONE_RE);
    if (names && names.length) {
        let i = 0;
        out = out.replace(NAME_PHONE_RE, () => names[Math.min(i++, names.length - 1)]);
    }
    const counts = input.match(PERSON_COUNT_RE);
    if (counts && counts.length) {
        let j = 0;
        out = out.replace(PERSON_COUNT_RE, () => counts[Math.min(j++, counts.length - 1)]);
    }
    return out;
}
// 검토 규칙으로 다듬은 문장을 추천 카드 형태로 — 바뀐 곳이 없으면 빈 배열
function ruleBasedRecommend(text) {
    try {
        const s = suggestFriendlyKorean(text, false);
        if (s.length && s[0].after && s[0].after !== text) {
            return [{ text: s[0].after, reason: '규칙 기반 다듬기 — ' + s[0].reason }];
        }
    }
    catch (e) {
        console.log('[RECOMMEND] 규칙 기반 추천 실패', e);
    }
    return [];
}
// 유사 예시 + 규칙 기반을 합친 로컬 폴백 (같은 문장 중복 제거)
function localFallbackRecommend(text) {
    const out = [];
    for (const s of fuzzyRecommend(text))
        out.push({ text: adaptSuggestionToInput(s, text), reason: '비슷한 예시 기반' });
    for (const r of ruleBasedRecommend(text)) {
        if (!out.some((o) => o.text === r.text))
            out.push(r);
    }
    return out;
}
// 팝업(컨테이너) 안의 텍스트를 스타일로 역할 분류 → [{role, text}] (화면 위→아래 순).
// 규칙: 버튼 컴포넌트 안 = 버튼(채움색이 흰색 아니면 주요), 나머지 중 제일 큰/위 = 타이틀, 그 외 = 안내.
function classifyPopup(root) {
    const hexOf = (node) => {
        const f = node.fills;
        if (Array.isArray(f) && f[0] && f[0].type === 'SOLID' && f[0].visible !== false) {
            const c = f[0].color;
            const h = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
            return ('#' + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
        }
        return null;
    };
    const isWhite = (hex) => !!hex && (hex === '#FFFFFF' || hex === '#FEFEFE');
    const isNameButton = (node) => (node.type === 'INSTANCE' || node.type === 'COMPONENT' || node.type === 'FRAME' || node.type === 'GROUP') && /button|btn|버튼|cta|action/i.test(node.name || '');
    const isContainer = (node) => node.type === 'INSTANCE' || node.type === 'COMPONENT' || node.type === 'FRAME' || node.type === 'GROUP';
    // 노드 '자기' 배경: 채움 페인트가 있으면 has=true. 솔리드면 hex, 그라디언트/이미지면 hex=null(색은 몰라도 배경은 있음).
    const nodeBg = (node) => {
        const f = node.fills;
        if (!Array.isArray(f))
            return { has: false, hex: null };
        const vis = f.filter((p) => p && p.visible !== false);
        if (!vis.length)
            return { has: false, hex: null };
        return { has: true, hex: hexOf(node) };
    };
    // 버튼 상자의 대표 배경: 자기 배경 우선, 없으면 자식(주로 배경 사각형) 중 '가장 큰' 배경.
    // 아이콘 같은 작은 색을 안 줍고 진짜 배경을 잡으려고 면적 최대를 고른다.
    const boxBg = (node) => {
        const own = nodeBg(node);
        if (own.has)
            return own;
        let best = null, bestArea = -1;
        const walk = (n) => {
            if (n !== node && n.type !== 'TEXT') {
                const bg = nodeBg(n);
                if (bg.has) {
                    const bb = n.absoluteBoundingBox;
                    const a = bb ? bb.width * bb.height : 0;
                    if (a > bestArea) {
                        bestArea = a;
                        best = bg;
                    }
                }
            }
            if ('children' in n && n.children)
                n.children.forEach(walk);
        };
        walk(node);
        return best || { has: false, hex: null };
    };
    const isBold = (s) => /bold|semibold|heavy|black/i.test(s || '');
    const lumOf = (hex) => {
        if (!hex)
            return null;
        const n = parseInt(hex.slice(1), 16);
        if (isNaN(n))
            return null;
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255; // 0=검정 … 1=흰색
    };
    const rootBB = root.absoluteBoundingBox;
    const oy = rootBB ? rootBB.y : 0;
    const rootH = rootBB ? rootBB.height : 9999;
    // 버튼 컨테이너 판정: (1)이름에 button/버튼 등이 있거나, (2)이름이 없어도 '채움색 있는 작은 상자(버튼 높이)'면 버튼.
    // 루트(팝업 배경)는 흰색 큰 상자라 제외 — 높이로 걸러진다.
    //  버튼 상자 판정: (1)이름 규칙, 또는 (2)이름 없이도 '배경 있는 컨테이너 중 팝업보다 확실히 낮은 것'.
    //  루트(팝업 배경)는 크고 하나뿐이라 높이 비율(0.7)에서 걸러진다.
    const isButtonContainer = (node, isRoot) => {
        if (isRoot)
            return false;
        if (isNameButton(node))
            return true; // 이름 규칙(button/버튼/cta…)은 FRAME이어도 인정
        // 이름이 없으면 '재사용 컴포넌트(인스턴스)'만 버튼 후보로 본다 — 배경만 있는 레이아웃 FRAME을 버튼으로 오인하지 않게.
        // (버튼은 컴포넌트로 만든다는 전제. 배경 있고 팝업보다 확실히 낮은 인스턴스면 버튼.)
        if (node.type === 'INSTANCE' || node.type === 'COMPONENT') {
            const bb = node.absoluteBoundingBox;
            if (bb && bb.height > 0 && bb.height < rootH * 0.7 && boxBg(node).has)
                return true;
        }
        return false;
    };
    const texts = [];
    const collect = (node, inBtn, bf, isRoot) => {
        let ib = inBtn, fill = bf;
        if (!inBtn && isButtonContainer(node, isRoot)) {
            ib = true;
            fill = boxBg(node).hex;
        }
        if (node.type === 'TEXT' && node.characters && node.characters.trim()) {
            const bb = node.absoluteBoundingBox;
            const style = (node.fontName && node.fontName !== figma.mixed) ? node.fontName.style : '';
            texts.push({ text: node.characters.trim(), fontSize: (typeof node.fontSize === 'number') ? node.fontSize : 0, bold: isBold(style), lum: lumOf(hexOf(node)), y: bb ? bb.y - oy : 0, inBtn: ib, btnFill: fill });
        }
        if ('children' in node && node.children)
            node.children.forEach((c) => collect(c, ib, fill, false));
    };
    collect(root, false, null, true);
    // 버튼 판정에 '글자색'을 더한다(사용자 기준):
    //   흰 글씨 = 주요 버튼(본문·타이틀은 흰색일 리 없어 확실). 그 외 버튼 후보(컴포넌트 안)는 검정 글씨 = 일반 버튼.
    const isWhiteText = (t) => t.lum != null && t.lum > 0.72;
    const isBtn = (t) => t.inBtn || isWhiteText(t);
    const nonBtn = texts.filter(t => !isBtn(t));
    // 타이틀은 크기·두께·색(진하기)을 모두 보고 '확실히 구분될 때만' 지정한다.
    //   후보 = 큰 글씨 → 동률이면 볼드 → 그다음 진한 색 → 그다음 위쪽.
    //   타이틀 인정: 셋 중 하나로라도 나머지와 구분될 때 — 더 작은 본문이 있거나 / 후보만 볼드거나 / 후보가 더 진할 때.
    //   셋 다 아니면(예: 회색 본문 한 줄만) 타이틀 없음 → 전부 안내. (안내를 타이틀로 오인하지 않게)
    let titleIdx = -1;
    if (nonBtn.length) {
        let best = 0;
        nonBtn.forEach((t, i) => {
            const a = nonBtn[best];
            const tl = t.lum == null ? 0 : t.lum, al = a.lum == null ? 0 : a.lum;
            const better = t.fontSize > a.fontSize
                || (t.fontSize === a.fontSize && t.bold && !a.bold)
                || (t.fontSize === a.fontSize && t.bold === a.bold && tl + 0.001 < al)
                || (t.fontSize === a.fontSize && t.bold === a.bold && Math.abs(tl - al) <= 0.001 && t.y < a.y);
            if (better)
                best = i;
        });
        const cand = nonBtn[best];
        const cl = cand.lum;
        const distinguishable = nonBtn.some(t => t.fontSize < cand.fontSize) // 크기로 구분
            || (cand.bold && nonBtn.some(t => !t.bold)) // 두께로 구분
            || (cl != null && nonBtn.some(t => t.lum != null && t.lum - cl > 0.12)); // 색: 더 연한 본문이 있음
        if (distinguishable)
            titleIdx = best;
    }
    const out = [];
    nonBtn.forEach((t, i) => out.push({ role: i === titleIdx ? '타이틀' : '안내', text: t.text, y: t.y }));
    // 버튼의 주요/일반은 '글자색'으로: 흰 글씨 = 주요, 검정(진한) 글씨 = 일반.
    texts.filter(t => isBtn(t)).forEach(t => out.push({ role: isWhiteText(t) ? '버튼(주요)' : '버튼(일반)', text: t.text, y: t.y }));
    out.sort((a, b) => a.y - b.y);
    return out.map(o => ({ role: o.role, text: o.text }));
}
// 팝업(다이얼로그)으로 볼지 판정 — 텍스트만 여러 개인 카드·섹션·리스트를 걸러낸다.
// 여러 기준을 "한꺼번에" 충족해야 팝업으로 본다 (텍스트 2개 이상만으로는 오탐이 많아서):
//   (1) 텍스트가 2개 이상
//   (2) 크기·두께·색으로 본문과 확실히 구분되는 '타이틀'이 있다
//       (classifyPopup은 크기↑ 또는 볼드 또는 진한 색으로 구분될 때만 '타이틀' 역할을 준다 — 동일 크기 나열이면 타이틀 없음)
//   (3) 액션 '버튼'이 1개 이상 (확인·취소 등)
// 셋을 모두 만족할 때만 팝업 → 버튼 없는 카드, 타이틀 구분 없는 텍스트 나열은 일반 추천으로 빠진다.
function isDialogLike(root, elements) {
    if (!elements || elements.length < 2)
        return false;
    // 이름 신호가 1차 기준 — 아무 프레임이나 '텍스트 여러 개'만으로 잡던 오탐을 없앤다.
    // 팝업/모달/다이얼로그 등으로 명명된 컨테이너만 팝업으로 본다. (이름 없으면 일반 텍스트로 처리)
    const name = String((root && root.name) || '');
    const named = /pop[\s_-]?up|modal|dialog|alert|toast|snackbar|팝업|모달|다이얼로그|얼럿|바텀시트/i.test(name);
    if (!named)
        return false;
    // 2차 — 이름이 팝업이어도 타이틀·버튼 같은 구조가 하나라도 있어야 (단순 배너/이미지 컨테이너 제외)
    const hasTitle = elements.some((e) => e.role === '타이틀');
    const hasButton = elements.some((e) => e.role.indexOf('버튼') === 0);
    return hasTitle || hasButton;
}
// 마지막으로 추천받은 팝업의 구성요소 — [케이스 더 받기]가 이걸로 다시 요청한다.
// 결과를 보는 동안 캔버스 선택이 풀리거나 바뀔 수 있어(초기화·다른 프레임 클릭) 선택에 의존하면 안 된다.
let lastPopupElements = null;
// 하위 프레임별 문구 묶음 — 화면·섹션처럼 '프레임 안에 프레임이 여럿'인 것을 눌렀을 때,
// 어떤 문구가 어느 하위 프레임 것인지 다듬기 미리보기에서 구분해 보여주기 위한 그룹핑.
// **끝까지 내려가 '문구를 직접 담은 프레임' 단위로 나눈다**(2026-08 수정): 처음엔 갈라지는 첫 층만
// 그룹으로 썼는데, 그 층 안에 또 나뉜 프레임들의 문구가 한 그룹으로 합쳐져 "다른 프레임인데 같은
// 프레임으로 나온다"는 신고가 있었다. 이름은 조상 프레임 이름을 이어 '헤더 › 타이틀' 경로로 보여준다.
// 숨긴 노드는 건너뛴다 (findAllTextNodes와 같은 기준 — 입력창에 담기는 문구와 어긋나면 안 된다).
// 고른 것이 '버튼'인지 알아본다 — 버튼 문구는 문장이 아니라 동작 이름이라(마침표·종결어미 없음)
// 추천 규칙이 아예 다르다. 팝업(classifyPopup)은 여러 요소를 스타일로 견줘 역할을 주지만,
// 버튼 하나만 고른 경우엔 견줄 대상이 없어 이름·구조로 판단한다.
// 오탐을 막는 조건: 문구가 2개 이하 + 각 문구가 짧을 때만 버튼으로 본다
// (이름에 CTA·action이 든 카드·섹션을 버튼으로 오인하면 카드 본문이 버튼 규칙으로 다듬어진다).
function detectButtonRole(node) {
    if (!node)
        return false;
    const NAME_RE = /button|btn|버튼|cta|action/i;
    const MAX_LABEL = 14; // 버튼 라벨 길이 상한 (이보다 길면 문장으로 본다)
    const texts = [];
    const collect = (n) => {
        if (!n || n.visible === false || texts.length > 2)
            return;
        if (n.type === 'TEXT') {
            const t = String(n.characters || '').trim();
            if (t)
                texts.push(t);
            return;
        }
        if ('children' in n && n.children)
            n.children.forEach(collect);
    };
    collect(node);
    if (!texts.length || texts.length > 2)
        return false;
    if (texts.some((t) => t.length > MAX_LABEL || /[.!?]$/.test(t)))
        return false; // 문장부호로 끝나면 문장
    // 자기 또는 위로 3단까지의 이름에 button/버튼/cta…
    let cur = node, up = 0;
    while (cur && up <= 3) {
        if (NAME_RE.test(String(cur.name || '')))
            return true;
        try {
            cur = cur.parent;
        }
        catch (_e) {
            break;
        }
        up++;
    }
    // 이름 규칙이 없으면 '배경 있는 작은 컴포넌트'만 버튼 후보로 (버튼은 컴포넌트로 만든다는 전제)
    const hasFill = (n) => Array.isArray(n.fills) && n.fills.some((f) => f && f.visible !== false);
    const box = node.type === 'TEXT' ? node.parent : node;
    if (box && (box.type === 'INSTANCE' || box.type === 'COMPONENT') && hasFill(box)) {
        const bb = box.absoluteBoundingBox;
        if (bb && bb.height > 0 && bb.height <= 80)
            return true;
    }
    return false;
}
function classifyFrameGroups(root) {
    if (!root || root.type === 'TEXT')
        return [];
    const MAX_DEPTH = 12; // 아주 깊게 중첩된 파일에서 무한정 내려가지 않게
    const MAX_GROUPS = 60; // 목록이 끝없이 길어지지 않게 (넘으면 그 뒤는 버린다)
    const isContainer = (n) => !!n && (n.type === 'FRAME' || n.type === 'GROUP' || n.type === 'COMPONENT' || n.type === 'INSTANCE' || n.type === 'SECTION');
    const yOf = (n) => { const bb = n.absoluteBoundingBox; return bb ? bb.y : 0; };
    const xOf = (n) => { const bb = n.absoluteBoundingBox; return bb ? bb.x : 0; };
    const kidsOf = (n) => (('children' in n && n.children) ? n.children.filter((k) => k && k.visible !== false) : []);
    // 이 프레임 아래(자기 직속 문구 제외)에 문구가 있나 — 자식 그룹이 생길지 판단용
    const anyTextInside = (n) => {
        const stack = kidsOf(n).filter(isContainer);
        let guard = 0;
        while (stack.length && guard++ < 5000) {
            const cur = stack.pop();
            const kids = kidsOf(cur);
            if (kids.some((k) => k.type === 'TEXT' && String(k.characters || '').trim()))
                return true;
            kids.filter(isContainer).forEach((c) => stack.push(c));
        }
        return false;
    };
    // 이름이 뻔한 래퍼(Frame 12, Auto layout, Group…)는 경로에서 뺀다 — '헤더 › 타이틀'처럼 읽히게
    const isPlainName = (s) => !s || /^(frame|group|auto[\s_-]?layout|autolayout|container|wrapper|content|div|rect(angle)?|vector|layer|컨테이너|그룹|프레임)[\s_-]*\d*$/i.test(s.trim());
    const out = [];
    const walk = (node, path, depth) => {
        if (out.length >= MAX_GROUPS)
            return;
        const kids = kidsOf(node);
        // 이 프레임이 '직접' 든 문구 = 이 프레임의 그룹 (더 안쪽 프레임 문구는 각자 자기 그룹으로)
        const ownTexts = kids.filter((k) => k.type === 'TEXT' && String(k.characters || '').trim());
        if (ownTexts.length) {
            const sorted = ownTexts.slice().sort((a, b) => (yOf(a) - yOf(b)) || (xOf(a) - xOf(b)));
            const label = path.filter((p) => !isPlainName(p)).join(' › ')
                || String(path[path.length - 1] || node.name || '프레임'); // 죄다 뻔한 이름이면 마지막 이름이라도
            const isBtn = detectButtonRole(node); // 버튼 영역이면 버튼 규칙으로 다듬게 표시
            out.push({
                name: label,
                texts: sorted.map((t) => String(t.characters).trim()),
                own: anyTextInside(node), // 자식 그룹도 생기는 프레임이면 '이 프레임 문구'로 구분해 표시
                role: isBtn ? '버튼' : undefined,
                y: yOf(sorted[0]),
                x: xOf(sorted[0]),
            });
        }
        if (depth >= MAX_DEPTH)
            return;
        kidsOf(node).filter(isContainer).forEach((c) => walk(c, path.concat([String(c.name || '')]), depth + 1));
    };
    walk(root, [], 0);
    // 화면에 보이는 순서(위→아래, 같으면 왼→오른쪽)로 — 레이어 순서보다 눈으로 찾기 쉽다
    out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const groups = out.map((g) => ({ name: g.name, texts: g.texts, own: g.own, role: g.role }));
    return groups.length >= 2 ? groups : []; // 둘 이상으로 갈려야 '구분'이 의미 있다
}
// 선택 상태를 UI로 보낼 때 쓰는 그룹 목록 — 단일 선택(텍스트 아님)일 때만 계산한다.
// (여러 개를 한꺼번에 고른 경우엔 어느 프레임 기준인지 정할 수 없어 그룹핑하지 않는다)
function frameGroupsForSelection(selection) {
    if (!selection || selection.length !== 1)
        return [];
    try {
        return classifyFrameGroups(selection[0]);
    }
    catch (_e) {
        return [];
    }
}
// 팝업 요소별 추천 — 선택이 '팝업 같은 구조'(isDialogLike)면 역할별로 갈라 요소마다 추천하고 true 반환.
// 아니면(단일 텍스트·카드·빈 선택 등) 처리하지 않고 false → 호출부가 일반 추천으로 넘어간다.
// opts.elements를 주면(=[케이스 더 받기]) 선택을 보지 않고 그 요소로 다시 추천하고, 결과는 기존 카드 아래에 덧붙인다.
async function popupRecommendFlow(model, opts) {
    const more = !!(opts && opts.elements && opts.elements.length);
    let elements;
    if (more) {
        elements = opts.elements;
    }
    else {
        const sel = figma.currentPage.selection;
        if (!sel.length || sel[0].type === "TEXT")
            return false;
        elements = classifyPopup(sel[0]);
        if (!isDialogLike(sel[0], elements))
            return false;
        lastPopupElements = elements; // [케이스 더 받기]가 쓸 요소 기억
    }
    const append = !!(opts && opts.append);
    let bh = await bridgeHealth();
    if (!bh.alive) {
        figma.ui.postMessage({ type: 'show-toast', message: '클로드가 연동돼 있지 않아요 — [클로드] 버튼으로 연결한 뒤 다시 눌러 주세요.' });
        return true;
    }
    // 다리가 구버전이면 사용자가 [업데이트] 버튼을 안 눌러도 여기서 자동으로 재연결한다.
    bh = await autoUpgradeIfOld(bh);
    if (!bh.alive || bh.problem === 'bridge-old') {
        figma.ui.postMessage({ type: 'hide-loading' });
        figma.ui.postMessage({ type: 'show-toast', message: bh.problem === 'bridge-old'
                ? ('아직 옛 버전이 연결돼요. 이 폴더예요: ' + (bh.dir || '경로 불명') + ' — 최신 코드로 업데이트해 주세요.')
                : '클로드를 다시 연결하지 못했어요 — 잠시 후 다시 눌러 주세요.' });
        return true;
    }
    if (needsAccountConfirm(bh)) {
        figma.ui.postMessage({ type: 'account-confirm-needed', account: bh.account });
        return true;
    }
    figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '문구를 다듬는 중이에요.' });
    try {
        // 팝업 전체를 한 요청에 묶어 보내 타이틀·안내·버튼이 일관된 "세트"를 받는다.
        // (요소별로 따로 뽑아 조합하면 서로 안 맞을 수 있어 세트 단위로 받는다.)
        const data = await fetchAiPopup(elements, model, more);
        const sets = await refinePopupSets(data.sets || []);
        figma.ui.postMessage({ type: 'hide-loading' });
        figma.ui.postMessage({ type: 'popup-recommend-result', sets, append });
    }
    catch (e) {
        figma.ui.postMessage({ type: 'hide-loading' });
        // 더 받기 실패는 이미 화면에 있는 카드를 지우면 안 된다 → 토스트만 (append=true면 UI가 카드를 유지)
        if (append)
            figma.ui.postMessage({ type: 'show-toast', message: errStr(e) });
        else
            figma.ui.postMessage({ type: 'popup-recommend-result', sets: [], error: errStr(e) });
    }
    refreshBridgeStatus();
    return true;
}
// 버튼 라벨 안전망 — 버튼엔 마침표·물음표·종결어미를 쓰지 않는다(ux-writing.md "8. 팝업" 버튼 규칙).
// 프롬프트에도 같은 규칙을 넣지만 모델이 문장형('확인했어요')을 섞어 내는 일이 있어(실측) 여기서 잡는다:
//   ① 끝의 문장부호는 뗀다 ② 종결어미로 끝나는 제안은 버린다 — 단 2개 이상 남을 때만
//      (다 버려서 빈손이 되는 것보다 문장형이라도 보여주는 게 낫다)
// '네'·'아니오'는 걸리지 않는다(길이 2 이하 / '오' 끝).
function refineButtonSuggestions(list, role) {
    if (role !== '버튼')
        return list;
    const cleaned = list.map((s) => {
        const t = s.text.replace(/\s*[.!?。]+\s*$/, '');
        return t !== s.text ? Object.assign({}, s, { text: t }) : s;
    });
    const looksSentence = (t) => t.length > 2 && /(요|다|까)$/.test(t);
    const keep = cleaned.filter((s) => !looksSentence(s.text));
    return keep.length >= 2 ? keep : cleaned;
}
async function fetchAiGroups(groups, model, more) {
    try {
        const payload = groups.map((g) => ({ name: g.name, texts: g.texts, role: g.role }));
        const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/recommend-groups', { groups: payload, model, more: !!more }, 130000);
        const data = await res.json();
        if (res.ok && data && Array.isArray(data.groups))
            return data.groups;
        if (data && data.error)
            throw new Error('BRIDGE_GUIDE:' + String(data.error));
        // 200인데 groups가 없다 = 옛 버전 다리(이 경로를 모른다)
        if (res.ok)
            throw new Error('BRIDGE_GUIDE:클로드가 옛 버전으로 연결돼 있어요 — 다시 눌러 새 버전으로 연결해 주세요.');
        throw new Error('클로드 추천 실패: HTTP ' + res.status);
    }
    catch (e) {
        if (e instanceof Error && e.message.indexOf('BRIDGE_GUIDE:') === 0)
            throw new Error(e.message.slice('BRIDGE_GUIDE:'.length));
        if (e instanceof Error && e.message.indexOf('클로드 추천 실패') >= 0)
            throw e;
        throw new Error('클로드 추천 실패: ' + errStr(e));
    }
}
// 하위 프레임 묶음이 있는 선택에서 [전체]로 추천받을 때 — 영역마다 따로 결과를 만든다.
// 한 덩어리로 다듬으면 화면 전체가 한 문구처럼 섞여 나와 어느 영역 것인지 알 수 없다(사용자 지적).
const MAX_RECOMMEND_GROUPS = 10; // 한 번에 보낼 영역 수 상한 (프롬프트·응답 폭주 방지)
async function groupsRecommendFlow(groups, model, more) {
    let bh = await bridgeHealth();
    if (!bh.alive) {
        figma.ui.postMessage({ type: 'show-toast', message: '클로드가 연동돼 있지 않아요 — [클로드] 버튼으로 연결한 뒤 다시 눌러 주세요.' });
        figma.ui.postMessage({ type: 'groups-recommend-end' });
        return;
    }
    bh = await autoUpgradeIfOld(bh);
    if (!bh.alive || bh.problem === 'bridge-old') {
        figma.ui.postMessage({ type: 'hide-loading' });
        figma.ui.postMessage({ type: 'show-toast', message: bh.problem === 'bridge-old'
                ? ('아직 옛 버전이 연결돼요. 이 폴더예요: ' + (bh.dir || '경로 불명') + ' — 최신 코드로 업데이트해 주세요.')
                : '클로드를 다시 연결하지 못했어요 — 잠시 후 다시 눌러 주세요.' });
        figma.ui.postMessage({ type: 'groups-recommend-end' });
        return;
    }
    if (needsAccountConfirm(bh)) {
        figma.ui.postMessage({ type: 'account-confirm-needed', account: bh.account });
        figma.ui.postMessage({ type: 'groups-recommend-end' });
        return;
    }
    // 영역이 너무 많으면 앞에서부터 잘라 보내고, 자른 사실을 알린다 (조용히 빼먹지 않는다)
    const send = groups.slice(0, MAX_RECOMMEND_GROUPS);
    const dropped = groups.length - send.length;
    figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '영역마다 문구를 다듬는 중이에요.' });
    try {
        const raw = await fetchAiGroups(send, model, more);
        // 각 영역 제안도 용어집·맞춤법으로 한 번 더 다듬는다 (단일 추천과 같은 안전망)
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            const g = raw[i];
            // 버튼 영역이면 문장부호를 떼는 안전망까지 (단일 추천과 같은 처리)
            const suggestions = refineButtonSuggestions(await refineAiSuggestions(g.suggestions || []), send[i] && send[i].role);
            // 이름은 클로드 응답보다 우리가 보낸 것을 신뢰한다 (모델이 이름을 바꿔 적는 일이 있다)
            out.push({ name: (send[i] && send[i].name) || g.name || ('영역 ' + (i + 1)), suggestions });
        }
        figma.ui.postMessage({ type: 'hide-loading' });
        figma.ui.postMessage({ type: 'groups-recommend-result', groups: out, sent: send });
        if (dropped > 0) {
            figma.ui.postMessage({ type: 'show-toast', message: '영역이 많아 위에서부터 ' + send.length + '개만 다듬었어요. 나머지 ' + dropped + '개는 그 영역을 눌러 따로 받아 주세요.' });
        }
    }
    catch (e) {
        figma.ui.postMessage({ type: 'hide-loading' });
        figma.ui.postMessage({ type: 'groups-recommend-result', groups: [], error: errStr(e) });
        refreshBridgeStatus();
    }
}
// AI 제안 가져오기 — 클로드 다리 전용 (Gemini/API 키 경로 제거됨).
// 성공하면 {text, reason} 배열, 실패하면 사유 메시지를 담은 Error를 던진다.
async function fetchAiSuggestions(text, model, role) {
    try {
        // role='버튼'이면 다리가 버튼 규칙(동작 이름·마침표 없음)을 프롬프트에 얹는다
        const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/recommend', { text, model, role }, 130000);
        const data = await res.json();
        if (res.ok && data && data.suggestions && data.suggestions.length)
            return data.suggestions;
        // 다리의 error는 이미 사람용 안내문(자체 접두어 포함) — 여기서 또 접두어를 붙이면 "실패: 실패:"로 겹친다
        if (data && data.error)
            throw new Error('BRIDGE_GUIDE:' + String(data.error));
        throw new Error('클로드 추천 실패: HTTP ' + res.status);
    }
    catch (e) {
        if (e instanceof Error && e.message.indexOf('BRIDGE_GUIDE:') === 0)
            throw new Error(e.message.slice('BRIDGE_GUIDE:'.length));
        if (e instanceof Error && e.message.indexOf('클로드 추천 실패') >= 0)
            throw e;
        throw new Error('클로드 추천 실패: ' + errStr(e));
    }
}
async function fetchAiPopup(elements, model, more) {
    try {
        const payload = elements.map((e) => ({ role: e.role, text: e.text }));
        // more=true면 다리가 "앞서 낸 세트와 겹치지 않는 새 세트"를 요구한다 (같은 세션 기억 활용)
        const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/recommend-popup', { elements: payload, model, more: !!more }, 130000);
        const data = await res.json();
        if (res.ok && data && Array.isArray(data.sets))
            return data;
        // 다리의 error는 이미 사람용 안내문(자체 접두어 포함) — 여기서 또 접두어를 붙이면 "실패: 실패:"로 겹친다
        if (data && data.error)
            throw new Error('BRIDGE_GUIDE:' + String(data.error));
        // 200인데 sets가 없다 = 옛 버전 다리(응답 형식이 다름). 재연결이 필요하다는 신호.
        if (res.ok)
            throw new Error('BRIDGE_GUIDE:클로드가 옛 버전으로 연결돼 있어요 — 다시 눌러 새 버전으로 연결해 주세요.');
        throw new Error('클로드 추천 실패: HTTP ' + res.status);
    }
    catch (e) {
        if (e instanceof Error && e.message.indexOf('BRIDGE_GUIDE:') === 0)
            throw new Error(e.message.slice('BRIDGE_GUIDE:'.length));
        if (e instanceof Error && e.message.indexOf('클로드 추천 실패') >= 0)
            throw e;
        throw new Error('클로드 추천 실패: ' + errStr(e));
    }
}
// 팝업 세트 후처리 — 각 세트의 모든 문구에 사내 용어집(치환) + 네이버 맞춤법(검수)을 통과시킨다.
// refineAiSuggestions와 같은 안전망이지만, 세트는 역할이 다른 문구들이라 중복 제거는 하지 않는다
// (같은 버튼 문구가 여러 세트에 겹쳐도 각 세트를 온전히 유지해야 하므로).
async function refinePopupSets(sets) {
    // 1) 용어집 치환: 원문 → 치환문 매핑
    const map = new Map();
    for (const st of sets) {
        for (const el of st.elements) {
            if (map.has(el.text))
                continue;
            const protect = applyRules(el.text, COMPOUND_PROTECT_RULES);
            const term = applyRules(protect.text, TERM_RULES);
            map.set(el.text, term.text);
        }
    }
    // 2) 치환문에 네이버 맞춤법 검수 (실패해도 추천을 막지 않는다)
    try {
        const spell = await naverSpellCheckAll(Array.from(new Set(Array.from(map.values()))));
        for (const [orig, termed] of map) {
            const r = spell.get(termed);
            if (r && r.checked && r.text)
                map.set(orig, r.text);
        }
    }
    catch (e) {
        console.log('[POPUP] 세트 맞춤법 검수 실패 — 교정 없이 표시', e);
    }
    return sets.map((st) => alignPopupButtons({
        reason: st.reason,
        elements: st.elements.map((el) => ({ role: el.role, text: map.get(el.text) || el.text })),
    }));
}
// 세트 일관성 안전망 — 안내(본문)가 '~할까요?'로 물으면 버튼 두 개는 [아니오]·[네]여야 한다
// (ux-writing.md "8. 팝업" 버튼 표). 다리 프롬프트에도 같은 지시가 있지만 모델이 [취소]·[동작]이나
// [확인]으로 어기는 일이 있어(실측) 여기서 맞춘다 — refineAiSuggestions와 같은 성격의 후처리.
// 손대는 조건을 좁게 둔다: 물음표 본문 + 버튼이 정확히 2개일 때만. 버튼 1개(통보)나 3개 이상은
// 무엇을 긍정으로 볼지 정할 수 없어 그대로 두고, 서술형 본문도 동작 동사를 지어낼 수 없어 건드리지 않는다.
function alignPopupButtons(set) {
    const asking = set.elements.some((el) => el.role === '안내' && /까요\s*\?/.test(el.text));
    if (!asking)
        return set;
    const btnIdx = [];
    set.elements.forEach((el, i) => { if (el.role.indexOf('버튼') === 0)
        btnIdx.push(i); });
    if (btnIdx.length !== 2)
        return set;
    // 긍정(=네)은 주요 버튼. 둘 다 같은 역할이면 나중(오른쪽·아래)을 긍정으로 본다 — 확인 버튼이 오른쪽인 관례.
    const primaryPos = set.elements[btnIdx[0]].role === '버튼(주요)' ? 0
        : set.elements[btnIdx[1]].role === '버튼(주요)' ? 1 : 1;
    const want = [primaryPos === 0 ? '네' : '아니오', primaryPos === 0 ? '아니오' : '네'];
    if (btnIdx.every((idx, k) => set.elements[idx].text === want[k]))
        return set; // 이미 맞음
    const elements = set.elements.map((el) => ({ role: el.role, text: el.text }));
    btnIdx.forEach((idx, k) => { elements[idx].text = want[k]; });
    console.log('[POPUP] 물음형 본문 — 버튼을 [아니오]·[네]로 맞춤:', set.elements.map((e) => e.text).join(' / '));
    return { reason: set.reason, elements };
}
// AI 추천 후처리 — 클로드 결과에도 사내 용어집(치환)과 네이버 맞춤법(검수)을 한 번 통과시킨다.
// 다리 프롬프트에도 용어 규칙이 들어가지만(instructionMessage의 glossaryRules), 모델이 어겨도 여기서 잡는 안전망.
// 톤·문장 구조 규칙(REWRITE_RULES 등)은 AI가 이미 다룬 영역이라 건드리지 않는다 — 검사 파이프라인 0단계(합성어 보호→용어 통일)만 적용.
async function refineAiSuggestions(list) {
    // 1) 용어집 치환 (suggestFriendlyKorean 0단계와 같은 순서 — 보호가 먼저 돌아야 띄어 쓰인 변형도 걸린다)
    const termed = list.map((s) => {
        const protect = applyRules(s.text, COMPOUND_PROTECT_RULES);
        const term = applyRules(protect.text, TERM_RULES);
        return term.text !== s.text ? { text: term.text, reason: s.reason + ' · 용어집 반영' } : s;
    });
    // 2) 네이버 맞춤법 최종 검수 — 실패해도 추천을 막지 않는다.
    //    합성어·예외 표기 보호(protectCompounds/revertKeptSpellings)와 캐시는 naverSpellCheckAll이 처리.
    let out = termed;
    try {
        const spell = await naverSpellCheckAll(Array.from(new Set(termed.map((s) => s.text))));
        out = termed.map((s) => {
            const r = spell.get(s.text);
            return r && r.checked && r.text !== s.text ? { text: r.text, reason: s.reason + ' · 맞춤법 교정' } : s;
        });
    }
    catch (e) {
        console.log('[RECOMMEND] AI 결과 맞춤법 검수 실패 — 교정 없이 표시', e);
    }
    // 교정으로 같은 문장이 된 제안 중복 제거
    const seen = new Set();
    return out.filter((s) => (seen.has(s.text) ? false : (seen.add(s.text), true)));
}
// 폴백 결과를 UI로 전송. failNote가 있으면(AI 실패) 토스트로 함께 알린다.
// emptyNote: 폴백 결과도 없을 때 보여줄 안내 (기본은 키 등록 안내)
// canAskAi: true면 카드 밑에 [AI 추천 더 받기] 버튼 노출 (AI 실패 후 재시도용)
function postRecommendFallback(text, failNote, emptyNote, canAskAi) {
    const fallback = localFallbackRecommend(text);
    if (fallback.length) {
        figma.ui.postMessage({ type: 'recommend-result', original: text, suggestions: fallback, canAskAi: !!canAskAi });
        if (failNote)
            figma.ui.postMessage({ type: 'show-toast', message: 'AI 추천은 실패했어요. 예시와 규칙 기반으로 검토했어요. (' + failNote + ')' });
    }
    else if (failNote) {
        figma.ui.postMessage({ type: 'show-toast', message: failNote });
    }
    else {
        figma.ui.postMessage({ type: 'show-toast', message: emptyNote || '예시·규칙으로 다듬을 곳을 찾지 못했어요.' });
    }
}
// ===============================
// 용어 통일 + 권장 문구 규칙 (사내 용어집 기반 — 항상 적용)
// 단순 "기존 → 권장" 치환은 glossary.md에서 관리한다 (위 자동 생성 영역에 반영됨).
// 이 배열에는 예외 처리(가드)가 필요한 규칙만 직접 작성한다.
// 톤 변환(REWRITE_RULES 등)보다 먼저 적용한다.
// 먼저 돌지 않으면 "~하십시오" 등이 먼저 변환돼 권장 문구 패턴이 안 맞게 된다.
// 주의: 치환 결과가 원래 패턴을 다시 포함하는 항목(고객인증번호, 등록 품질 검사 등)은
//       이미 권장 표기인 텍스트가 이중 치환되지 않도록 가드를 둔다.
// 자동화에서 뺀 항목: "관리자/담당자"(역할 안내라 치환 불가),
//                  "일요일"(휴일/공휴일 중 무엇으로 바꿀지 문맥 필요),
//                  "사용→사용함" 류 긍정형(사용자·사용법 등 오탐 위험; 부정형 미사용→사용 안함만 자동화),
//                  "됐어요→했어요"·"바뀌었어요→바꿨어요" 능동형 전환(연체돼요·종료돼요 등 수동형 예외가 많고,
//                  자동사→타동사 전환은 주어가 사물이면 문법이 깨짐("설정이 바꿨어요") — ux-writing 가이드 예외 규칙 참고)
// ===============================
const TERM_RULES = [
    // --- 용어 통일 (glossary.md "용어 통일" 표에서 자동 생성) ---
    ...GLOSSARY_TERMS.map((t) => ({
        pattern: new RegExp(escapeRegex(t.from), 'g'),
        replacement: t.to,
        reason: "용어 통일",
        tags: ["term"],
    })),
    // --- 권장 문구 (glossary.md "권장 문구" 표에서 자동 생성 — 말투·어미 규칙) ---
    ...GLOSSARY_PHRASES.map((t) => ({
        pattern: new RegExp(escapeRegex(t.from), 'g'),
        replacement: t.to,
        reason: "권장 문구",
        tags: ["term"],
    })),
    // --- 예외 처리가 필요한 용어 규칙 (정규식 — 여기서 직접 수정) ---
    // 이미 "지문등록 품질 검사"인 텍스트는 건너뜀 (앞 글자 '문' 가드)
    { pattern: /(^|[^문])등록 품질 검사/g, replacement: "$1지문등록 품질 검사", reason: "용어 통일", tags: ["term"] },
    // 이미 "사용자번호(고객인증번호)"로 쓴 경우 이중 치환 방지 (여는 괄호 가드)
    { pattern: /(^|[^(])고객인증번호/g, replacement: "$1사용자번호(고객인증번호)", reason: "용어 통일", tags: ["term"] },
    { pattern: /사용자 DB ?정보/g, replacement: "사용자 데이터 정보", reason: "용어 통일", tags: ["term"] },
    // 캐주얼한 경어: '께'→'에게' — '님' 뒤에서만 치환("함께" 오탐 방지), 주격 조사 '님께서'는 제외
    { pattern: /님께(?!서)/g, replacement: "님에게", reason: "권장 문구", tags: ["term"] },
    // "미사용자/미등록자" 등 사람을 가리키는 합성어는 제외 (라벨 토글 용어만 치환)
    { pattern: /미사용(?!자)/g, replacement: "사용 안함", reason: "용어 통일", tags: ["term"] },
    { pattern: /미동의(?!자)/g, replacement: "동의 안함", reason: "용어 통일", tags: ["term"] },
    { pattern: /미표시(?!자)/g, replacement: "표시 안함", reason: "용어 통일", tags: ["term"] },
    { pattern: /미등록(?!자)/g, replacement: "등록 안됨", reason: "용어 통일", tags: ["term"] },
    // "출입 가능성/출입 불가능"의 일부를 잘라먹지 않도록 가드
    { pattern: /출입 가능(?!성)/g, replacement: "출입 허용", reason: "용어 통일", tags: ["term"] },
    { pattern: /출입 불가(?!능)/g, replacement: "출입 제한", reason: "용어 통일", tags: ["term"] },
    { pattern: /얼굴\(지문\) ?\+ ?카드 인증/g, replacement: "얼굴(지문)/카드 모두 인증", reason: "용어 통일", tags: ["term"] },
    { pattern: /얼굴\(지문\) ?or ?카드 인증/gi, replacement: "얼굴(지문) 또는 카드 인증", reason: "용어 통일", tags: ["term"] },
    { pattern: /\b(?:Error|Erorr)\b/g, replacement: "오류", reason: "용어 통일", tags: ["term"] },
    { pattern: /음성 (설정|조절)/g, replacement: "소리 $1", reason: "용어 통일", tags: ["term"] },
    { pattern: /IP ?Address/gi, replacement: "IP 주소", reason: "용어 통일", tags: ["term"] },
    // "암호화"는 다른 뜻이므로 예외
    { pattern: /암호(?!화)/g, replacement: "비밀번호", reason: "용어 통일", tags: ["term"] },
    // "사용자 배경화면"을 먼저 치환해야 "사용자 사용자 이미지"가 안 된다
    { pattern: /사용자 ?배경화면/g, replacement: "사용자 이미지", reason: "용어 통일", tags: ["term"] },
    { pattern: /배경화면/g, replacement: "사용자 이미지", reason: "용어 통일", tags: ["term"] },
    { pattern: /에스원 (기술사원|관리자)/g, replacement: "에스원 담당자", reason: "용어 통일", tags: ["term"] },
    // 휴대폰 계열은 긴 패턴부터 (휴대폰번호 → 휴대폰 → 폰번호 순서 중요)
    { pattern: /휴대폰 ?번호/g, replacement: "휴대전화번호", reason: "용어 통일", tags: ["term"] },
    { pattern: /휴대폰/g, replacement: "휴대전화", reason: "용어 통일", tags: ["term"] },
    { pattern: /폰번호/g, replacement: "휴대전화번호", reason: "용어 통일", tags: ["term"] },
    // --- 권장 문구 (안내 메시지) ---
    // "얼굴 또는 카드를 입력해 주세요"는 용어집상 그대로 두므로(좌동),
    // 카드/지문 단독 문구는 노드 전체가 그 문장일 때만 바꾼다 (^…$ 앵커)
    { pattern: /^카드를 입력해 주세요[.!]?\s*$/g, replacement: "카드를 대주세요", reason: "권장 문구", tags: ["tone"] },
    { pattern: /^지문을 입력해 주세요[.!]?\s*$/g, replacement: "지문을 대주세요", reason: "권장 문구", tags: ["tone"] },
    { pattern: /^부팅\s*중[.\s]*잠시만 기다려 주십시오[.!]?\s*$/g, replacement: "기기 부팅중입니다. 잠시만 기다려 주세요", reason: "권장 문구", tags: ["tone"] },
    { pattern: /^관리자가 아닙니다[.!]?\s*$/g, replacement: "관리자만 메뉴진입이 가능합니다", reason: "권장 문구", tags: ["tone"] },
    { pattern: /^사용자 삭제 실패[.!]?\s*$/g, replacement: "사용자 삭제를 실패하였습니다", reason: "권장 문구", tags: ["tone"] },
    { pattern: /^컨트롤러 수량 초과 실패[.!]?\s*$/g, replacement: "컨트롤러 수량 초과로 실패하였습니다", reason: "권장 문구", tags: ["tone"] },
    { pattern: /문의하십시오/g, replacement: "문의해 주세요", reason: "권장 문구", tags: ["tone"] },
    { pattern: /시도하세요/g, replacement: "시도해 주세요", reason: "권장 문구", tags: ["tone"] },
];
// ===============================
// 도메인 합성어 보호 (용어집 표기 우선)
// 네이버 맞춤법은 합성어를 표준대로 띄어 쓴다 ("고객인증번호"→"고객 인증번호",
// "출입정보"→"출입 정보"). 그대로 두면 ① 공백만 다른 무의미한 제안이 생기고
// ② 띄어쓰기가 바뀐 탓에 TERM_RULES가 매칭되지 않는다.
// → 네이버 교정 직후와 변환 파이프라인 맨 앞에서 용어집 표기(붙여쓰기)로 되돌린다.
// 새 합성어가 "X → X 같이 보이는 제안"으로 나타나면 glossary.md "합성어 보호" 목록에 추가할 것.
// (긴 단어 우선 정렬은 빌드 스크립트가 처리한다)
// ===============================
const COMPOUND_PROTECT_RULES = GLOSSARY_COMPOUNDS.map((w) => ({
    // 글자 사이 어디에 공백이 끼어도 인식해 용어집 표기로 되돌린다 (예: "출입 정보" → "출입정보")
    pattern: new RegExp(w.split('').map(escapeRegex).join(' ?'), 'g'),
    replacement: w,
    reason: "용어 통일",
    tags: ["term"],
})).concat([
    // 아라비아 숫자 + 단위 '명'은 붙여 쓴다("3명"). 네이버가 "3 명"으로 띄우면 되돌린다.
    // 한글 수사(세 명)는 띄어쓰기가 표준이라 건드리지 않는다.
    // 뒤에 명령·명단·명세 등 '명'으로 시작하는 다른 단어가 이어지면 제외 (조사 '의'는 제외 안 함 → "3명의 …" 유지)
    { pattern: /([0-9]+)\s+명(?![령단세함목칭예중작소])/g, replacement: "$1명", reason: "띄어쓰기", tags: ["spacing"] },
]);
// 합성어 보호만 조용히 적용 (네이버 교정 직후에 사용 — 사유 없이 텍스트만 복원)
function protectCompounds(s) {
    let t = s;
    for (const r of COMPOUND_PROTECT_RULES) {
        r.pattern.lastIndex = 0;
        t = t.replace(r.pattern, r.replacement);
    }
    return t;
}
// 예외 표기 보호 (glossary.md "예외 표기"): 네이버가 표준 표기로 바꾼 단어를 우리 표기로 되돌린다.
// 예: 렌탈 → (네이버) 렌털 → 렌탈 복원. 원문에 우리 표기가 쓰였을 때만 되돌리므로
// 원문이 처음부터 표준 표기(렌털)면 그대로 둔다 — 양쪽 표기 모두 허용.
function revertKeptSpellings(original, corrected) {
    let t = corrected;
    for (const k of GLOSSARY_KEEP_SPELLINGS) {
        if (original.indexOf(k.keep) !== -1 && original.indexOf(k.naver) === -1) {
            t = t.split(k.naver).join(k.keep);
        }
    }
    return t;
}
// Figma 텍스트의 줄바꿈은 \n 외에도 U+2028(LINE SEPARATOR), U+2029, \r\n일 수 있다.
// 줄바꿈/특수 공백을 모두 인식해야 네이버가 잘라낸 것을 정확히 복원할 수 있다.
const LINE_BREAK_CHARS = /[\n\r\u2028\u2029]/;
// 줄 안에서 앞뒤에 붙을 수 있는 공백류 (NBSP, zero-width 포함)
const EDGE_WS_LEAD = /^[ \t\u00A0\u200B\uFEFF]*/;
const EDGE_WS_TRAIL = /[ \t\u00A0\u200B\uFEFF]*$/;
// 줄바꿈 문자 종류를 보존하며 줄로 분해 (lines.length === seps.length + 1)
function splitLinesKeepSeps(s) {
    const lines = [];
    const seps = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\r') {
            lines.push(cur);
            cur = '';
            if (s[i + 1] === '\n') {
                seps.push('\r\n');
                i++;
            }
            else {
                seps.push('\r');
            }
        }
        else if (ch === '\n' || ch === '\u2028' || ch === '\u2029') {
            lines.push(cur);
            cur = '';
            seps.push(ch);
        }
        else {
            cur += ch;
        }
    }
    lines.push(cur);
    return { lines, seps };
}
// 네이버는 교정문에서 앞뒤 공백/줄바꿈을 잘라서 돌려준다.
// 그대로 두면 "출입정보 " → "출입정보"처럼 눈에 안 보이는(똑같아 보이는) 제안이 생기므로
// 원문의 앞뒤 공백을 교정문에 그대로 복원한다.
function restoreEdgeWhitespace(original, corrected) {
    const lead = (original.match(EDGE_WS_LEAD) || [''])[0];
    const trail = (original.match(EDGE_WS_TRAIL) || [''])[0];
    return lead + corrected.replace(EDGE_WS_LEAD, '').replace(EDGE_WS_TRAIL, '') + trail;
}
// 네이버 교정문의 공백 구조를 원문에 맞춘다 (여러 줄 텍스트 대응):
// - 줄 수가 달라졌으면(줄바꿈 손실/병합) 네이버 교정을 통째로 버리고 원문 유지
//   → "조회⏎ → 조회" 같은 줄바꿈 제거 제안이 생기지 않는다
// - 줄 수가 같으면 원문의 줄바꿈 문자(\n, U+2028 등)를 그대로 쓰고
//   각 줄의 앞뒤 공백도 원문대로 복원
function alignWhitespace(original, corrected) {
    const o = splitLinesKeepSeps(original);
    const cLines = corrected.split('\n'); // 네이버 응답은 \n으로 통일돼 돌아온다
    if (o.lines.length !== cLines.length)
        return original;
    let out = '';
    for (let i = 0; i < o.lines.length; i++) {
        out += restoreEdgeWhitespace(o.lines[i], cLines[i]);
        if (i < o.seps.length)
            out += o.seps[i];
    }
    return out;
}
// ===============================
// '~해 주세요' 띄어쓰기 통일 (모든 변환이 끝난 뒤 마지막에 적용)
// 기준은 '해' 앞 단어의 품사:
// - '하다'가 붙는 동작 명사면 '해'를 명사에 붙인다:
//     "문의해주세요" → "문의해 주세요", "확인 해 주세요" → "확인해 주세요"
// - 부사 등 그 외 단어면 '해주세요'를 한 덩어리로 붙인다:
//     "같이 해 주세요" → "같이 해주세요" ("같이해 주세요"는 말이 안 됨)
// 품사는 정규식으로 구분할 수 없어 동작 명사 목록으로 판별한다.
// 목록은 glossary.md "동작 명사" 섹션에서 관리한다.
// ===============================
const ACTION_NOUNS = GLOSSARY_ACTION_NOUNS.join('|');
const HAEJUSEYO_RULES = [
    // 1) '해' 앞에 단어가 붙어 있으면 '주세요'를 띄움: "문의해주세요" → "문의해 주세요"
    { pattern: /([가-힣])해주세요/g, replacement: "$1해 주세요", reason: "띄어쓰기", tags: ["spacing"] },
    // 2) 동작 명사 + 해 주세요: '해'를 명사에 붙임: "확인 해 주세요" → "확인해 주세요"
    { pattern: new RegExp('(' + ACTION_NOUNS + ') ?해 ?주세요', 'g'), replacement: "$1해 주세요", reason: "띄어쓰기", tags: ["spacing"] },
    // 3) 그 외(부사 등) 뒤의 '해 주세요'는 붙임: "같이 해 주세요" → "같이 해주세요"
    { pattern: /(^|\s)해 주세요/g, replacement: "$1해주세요", reason: "띄어쓰기", tags: ["spacing"] },
];
// ===============================
// 문장 레벨 변환 규칙 (문맥 기반 자연스러운 표현)
// ===============================
const REWRITE_RULES = [
    // 격식 높임말을 친근하게 바꾸는 패턴들 (더 구체적인 패턴을 먼저 적용)
    // ~하시거나 → ~하거나
    {
        pattern: /하시거나/g,
        replacement: "하거나",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시려고 → ~하려고
    {
        pattern: /하시려고/g,
        replacement: "하려고",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시려면 → ~하려면
    {
        pattern: /하시려면/g,
        replacement: "하려면",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시려는 → ~하려는
    {
        pattern: /하시려는/g,
        replacement: "하려는",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시다가 → ~하다가
    {
        pattern: /하시다가/g,
        replacement: "하다가",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시던 → ~하던
    {
        pattern: /하시던/g,
        replacement: "하던",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하셨더라도 → ~하더라도
    {
        pattern: /하셨더라도/g,
        replacement: "하더라도",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시고 → ~하고
    {
        pattern: /하시고/g,
        replacement: "하고",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시지만 → ~하지만
    {
        pattern: /하시지만/g,
        replacement: "하지만",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시는지 → ~하는지
    {
        pattern: /하시는지/g,
        replacement: "하는지",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시는가 → ~하는가
    {
        pattern: /하시는가/g,
        replacement: "하는가",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시게 → ~하게
    {
        pattern: /하시게/g,
        replacement: "하게",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시기 → ~하기
    {
        pattern: /하시기/g,
        replacement: "하기",
        reason: "해요체",
        tags: ["tone"],
    },
    // 격식 높임말을 친근하게: ~하시는 → ~하는 (일반 패턴)
    {
        pattern: /하시는/g,
        replacement: "하는",
        reason: "해요체",
        tags: ["tone"],
    },
    // 구조 변환: ~하시면 ~됩니다 → ~하면 ~돼요
    {
        pattern: /(.+?)하시면\s+(.+?)됩니다/g,
        replacement: "$1하면 $2돼요",
        reason: "간결하게",
        tags: ["shorten", "tone"],
    },
    // ~할 수 있습니다 → ~할 수 있어요
    {
        pattern: /할 수 있습니다/g,
        replacement: "할 수 있어요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~가능합니다 → ~가능해요
    {
        pattern: /가능합니다/g,
        replacement: "가능해요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시겠습니까? → ~할까요?
    {
        pattern: /하시겠습니까\?/g,
        replacement: "할까요?",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하기 바랍니다 → ~해주세요 (위 규칙보다 앞의 '하시기→하기' 변환을 거친 경우 잡기)
    {
        pattern: /하기 바랍니다/g,
        replacement: "해주세요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하십시오 → ~해주세요 (이미 UX_PATTERNS에 있지만 문장 레벨에서도 처리)
    {
        pattern: /하십시오/g,
        replacement: "해주세요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~주십시오 → ~주세요 (기다려 주십시오 등)
    {
        pattern: /주십시오/g,
        replacement: "주세요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~입니까? → ~인가요? / ~예요?
    {
        pattern: /([가-힣]+)입니까\?/g,
        replacement: (match, p1) => {
            const lastChar = p1[p1.length - 1];
            return hasJongseong(lastChar) ? `${p1}인가요?` : `${p1}예요?`;
        },
        reason: "해요체",
        tags: ["tone"],
    },
    // ~되어야 합니다 → ~되어야 해요
    {
        pattern: /되어야 합니다/g,
        replacement: "되어야 해요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~해야 합니다 → ~해야 해요
    {
        pattern: /해야 합니다/g,
        replacement: "해야 해요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하지 않으면 안 됩니다 → ~해야 해요
    {
        pattern: /하지 않으면 안 됩니다/g,
        replacement: "해야 해요",
        reason: "간결하게",
        tags: ["shorten", "tone"],
    },
    // ~하지 않으면 안 돼요 → ~해야 해요
    {
        pattern: /하지 않으면 안 돼요/g,
        replacement: "해야 해요",
        reason: "간결하게",
        tags: ["shorten"],
    },
    // ~할 수 없습니다 → ~할 수 없어요
    {
        pattern: /할 수 없습니다/g,
        replacement: "할 수 없어요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하지 마십시오 → ~하지 마세요
    {
        pattern: /하지 마십시오/g,
        replacement: "하지 마세요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하도록 하십시오 → ~하세요
    {
        pattern: /하도록 하십시오/g,
        replacement: "하세요",
        reason: "간결하게",
        tags: ["shorten", "tone"],
    },
    // ~하는 것이 좋습니다 → ~하는 게 좋아요
    {
        pattern: /하는 것이 좋습니다/g,
        replacement: "하는 게 좋아요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하는 것이 좋아요 → ~하는 게 좋아요
    {
        pattern: /하는 것이 좋아요/g,
        replacement: "하는 게 좋아요",
        reason: "간결하게",
        tags: ["shorten"],
    },
    // ~하는 것이 → ~하는 게
    {
        pattern: /하는 것이/g,
        replacement: "하는 게",
        reason: "간결하게",
        tags: ["shorten"],
    },
    // ~하는 것을 → ~하는 걸
    {
        pattern: /하는 것을/g,
        replacement: "하는 걸",
        reason: "간결하게",
        tags: ["shorten"],
    },
    // ~하는 것으로 → ~하는 걸로
    {
        pattern: /하는 것으로/g,
        replacement: "하는 걸로",
        reason: "간결하게",
        tags: ["shorten"],
    },
    // ~하는 것도 → ~하는 것도 (변경 없음, 예시용)
    // ~하는 것만 → ~하는 것만 (변경 없음, 예시용)
    // 더 많은 자연스러운 표현 패턴
    // ~해주시기 바랍니다 → ~해주세요
    {
        pattern: /해주시기 바랍니다/g,
        replacement: "해주세요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~해주시기 바라요 → ~해주세요
    {
        pattern: /해주시기 바라요/g,
        replacement: "해주세요",
        reason: "간결하게",
        tags: ["tone"],
    },
    // ~하기 바라요 → ~해주세요 (하시기→하기 변환을 거친 형태를 잡는다)
    {
        pattern: /하기 바라요/g,
        replacement: "해주세요",
        reason: "간결하게",
        tags: ["tone"],
    },
    // ~해주시면 됩니다 → ~해주시면 돼요
    {
        pattern: /해주시면 됩니다/g,
        replacement: "해주시면 돼요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하시면 됩니다 → ~하면 돼요
    {
        pattern: /하시면 됩니다/g,
        replacement: "하면 돼요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하실 경우 → ~하면 (캐주얼한 경어 + 간결하게: "취소하실 경우" → "취소하면")
    {
        pattern: /하실 경우/g,
        replacement: "하면",
        reason: "간결하게",
        tags: ["shorten"],
    },
    // ~하실 수 있습니다 → ~하실 수 있어요
    {
        pattern: /하실 수 있습니다/g,
        replacement: "하실 수 있어요",
        reason: "해요체",
        tags: ["tone"],
    },
    // ~하실 수 없습니다 → ~하실 수 없어요
    {
        pattern: /하실 수 없습니다/g,
        replacement: "하실 수 없어요",
        reason: "해요체",
        tags: ["tone"],
    },
    // --- 해요체 통일 (일반 규칙 — 구체 패턴들이 먼저 처리된 뒤 남은 것을 잡는다) ---
    // ~았/었/했/겠습니다 → ~았/었/했/겠어요 (앞 글자 받침이 ㅆ일 때만)
    {
        pattern: /([가-힣])습니다/g,
        replacement: (m, p1) => (jongseongCode(p1) === 20 ? p1 + "어요" : m),
        reason: "해요체",
        tags: ["tone"],
    },
    { pattern: /아닙니다/g, replacement: "아니에요", reason: "해요체", tags: ["tone"] },
    { pattern: /않습니다/g, replacement: "않아요", reason: "해요체", tags: ["tone"] },
    { pattern: /없습니다/g, replacement: "없어요", reason: "해요체", tags: ["tone"] },
    { pattern: /같습니다/g, replacement: "같아요", reason: "해요체", tags: ["tone"] },
    { pattern: /좋습니다/g, replacement: "좋아요", reason: "해요체", tags: ["tone"] },
    // ~옵니다/갑니다 → ~와요/가요 (가져옵니다, 들어갑니다 등)
    { pattern: /([가-힣])옵니다/g, replacement: "$1와요", reason: "해요체", tags: ["tone"] },
    { pattern: /([가-힣])갑니다/g, replacement: "$1가요", reason: "해요체", tags: ["tone"] },
];
// ===============================
// 핵심 변환 함수들
// ===============================
function replaceImnidaWithYeyo(text) {
    if (!text.includes("입니다"))
        return text;
    let t = text;
    const regex = /\s*입니다/g;
    const matches = [];
    let m;
    while ((m = regex.exec(t)) !== null) {
        matches.push({ index: m.index, length: m[0].length });
    }
    for (let i = matches.length - 1; i >= 0; i--) {
        const { index, length } = matches[i];
        let replacement = "이에요";
        if (index > 0) {
            // "방법 입니다"처럼 공백이 있으면 앞 단어의 마지막 글자 확인 (받침 있으면 이에요, 없으면 예요)
            let j = index - 1;
            while (j >= 0 && /\s/.test(t[j]))
                j--;
            const prev = j >= 0 ? t[j] : "";
            replacement = /[가-힣]/.test(prev) && hasJongseong(prev) ? "이에요" : "예요";
        }
        t = t.slice(0, index) + replacement + t.slice(index + length);
    }
    return t;
}
function applyPatternDB(text) {
    let t = text;
    const tags = new Set();
    const reasons = [];
    // "입니다"는 별도 처리
    const beforeImnida = t;
    t = replaceImnidaWithYeyo(t);
    if (t !== beforeImnida) {
        tags.add("tone");
        reasons.push("해요체");
    }
    for (const p of UX_PATTERNS) {
        if (!t.includes(p.pattern))
            continue;
        const next = t.replace(new RegExp(escapeRegex(p.pattern), "g"), p.replacement);
        if (next !== t) {
            t = next;
            if (p.tag)
                tags.add(p.tag);
            reasons.push(p.description);
        }
    }
    // "가능 해요" 등 UX_PATTERNS "합니다"→"해요" 적용 시 생긴 띄어쓰기 보정 (가능해요, 불가능해요 등)
    const spacingFix = /(불가능|가능|필요|불필요) (해요)/g;
    if (spacingFix.test(t)) {
        spacingFix.lastIndex = 0;
        t = t.replace(spacingFix, "$1$2");
        tags.add("spacing");
        if (!reasons.includes("띄어쓰기"))
            reasons.push("띄어쓰기");
    }
    return { text: t, tags: Array.from(tags), reasons };
}
function applyRules(text, rules) {
    let t = text;
    const tags = new Set();
    const reasons = [];
    for (const r of rules) {
        if (!r.pattern.test(t)) {
            // RegExp가 global이면 test 이후 lastIndex가 변할 수 있어 reset
            r.pattern.lastIndex = 0;
            continue;
        }
        r.pattern.lastIndex = 0;
        const next = typeof r.replacement === 'function'
            ? t.replace(r.pattern, r.replacement)
            : t.replace(r.pattern, r.replacement);
        if (next !== t) {
            t = next;
            r.tags.forEach((tg) => tags.add(tg));
            reasons.push(r.reason);
        }
    }
    return { text: t, tags: Array.from(tags), reasons };
}
function buildSuggestion(before, after, reasonParts, tags) {
    if (before === after)
        return null;
    // reason 중복 제거 + 너무 길면 줄이기
    const uniq = Array.from(new Set(reasonParts)).slice(0, 3);
    const reason = uniq.length ? uniq.join(" - ") : "다듬기";
    // tags 중복 제거
    const t = Array.from(new Set(tags));
    return { before, after, reason, tags: t };
}
/**
 * 마침표 추가 규칙 적용 (별도 함수로 분리)
 */
const ENDS_WITH_PUNCTUATION = /[.!?．！？]\s*$/;
function applyPeriodRule(text, originalText) {
    let t = text;
    const reasons = [];
    // 이미 문장 끝에 마침표/느낌표/물음표가 있으면 마침표 추가 건너뜀 (불필요한 안내 방지)
    // 현재 텍스트 또는 원본 중 하나라도 마침표가 있으면 reason 추가 안 함
    if (ENDS_WITH_PUNCTUATION.test(t)) {
        return { text: t, reasons };
    }
    if (originalText != null && ENDS_WITH_PUNCTUATION.test(originalText)) {
        return { text: t, reasons };
    }
    // ~요로 끝나는 문장에 마침표 추가 (이미 마침표가 없을 때만)
    // 해요체 종결어미 전반을 커버한다 (어요=했어요/있어요, 아요=같아요, 에요=아니에요/이에요,
    // 세요=주세요/하세요, 와요/가요/네요/까요 등). '필요', '중요' 같은 명사는 안 걸린다.
    const periodPattern = /(해요|돼요|에요|예요|어요|아요|와요|가요|네요|세요|까요)(\s+)(?![.,!?])([가-힣])/g;
    const periodPatternEnd = /(해요|돼요|에요|예요|어요|아요|와요|가요|네요|세요|까요)(?![.,!?])(?=\s*$)/g;
    // 중간에 있는 경우: "돼요  안되" → "돼요.  안되"
    if (periodPattern.test(t)) {
        periodPattern.lastIndex = 0;
        const next = t.replace(periodPattern, "$1.$2$3");
        if (next !== t) {
            t = next;
            if (reasons.length === 0) {
                reasons.push("마침표");
            }
        }
    }
    // 문장 끝인 경우: "돼요" → "돼요."
    if (periodPatternEnd.test(t)) {
        periodPatternEnd.lastIndex = 0;
        const next = t.replace(periodPatternEnd, "$1.");
        if (next !== t) {
            t = next;
            if (reasons.length === 0) {
                reasons.push("마침표");
            }
        }
    }
    return { text: t, reasons };
}
// ===============================
// 조사 교정 (받침 기반 — 오프라인). 충돌이 적은 을/를만 처리.
// (이/가·와/과·(으)로는 효과/종로/국가 같은 진짜 단어와 충돌이 많아 제외)
// ===============================
// '을/를'로 끝나지만 실제로는 한 단어라 건드리면 안 되는 흔한 경우
const PARTICLE_FALSE_POSITIVES = new Set(['마을', '가을', '노을']);
// 받침 종성 코드 (0 = 받침 없음). -1 = 한글 음절 아님
function jongseongCode(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3)
        return (code - 0xAC00) % 28;
    return -1;
}
// 단어 경계(공백/문장부호/끝) 앞의 을/를을, 앞 글자 받침에 맞게 교정
function fixParticles(text) {
    let changed = false;
    const BOUNDARY = `(?=[\\s.,!?)\\]"'»」』]|$)`;
    const re = new RegExp(`([가-힣])(을|를)${BOUNDARY}`, 'g');
    const t = text.replace(re, (m, prev, particle) => {
        const jong = jongseongCode(prev);
        if (jong < 0)
            return m;
        if (PARTICLE_FALSE_POSITIVES.has(prev + particle))
            return m; // 흔한 단어는 건너뜀
        const correct = jong > 0 ? '을' : '를';
        if (particle !== correct) {
            changed = true;
            return prev + correct;
        }
        return m;
    });
    return { text: t, reasons: changed ? ['맞춤법'] : [] };
}
// ===============================
// 네이버 맞춤법 검사 (비공식 — py-hanspell 방식: 검색페이지에서 passportKey 추출 후 SpellerProxy 호출)
// 공식 API 아님 → 네이버가 바꾸면 깨질 수 있음. 실패 시 조용히 건너뜀(로컬 규칙은 그대로 동작).
// ===============================
let naverPassportKey = null;
let naverDiag = ''; // 실패 원인 진단용 (토스트/콘솔로 노출)
let naverOkCount = 0; // 이번 검토에서 SpellerProxy 정상 응답 건수
// 심부름꾼 서버 주소 (passportKey 긁기 + AI 추천/번역).
// 검색페이지는 CORS가 막혀 플러그인에서 직접 못 긁으므로 서버가 대신 긁어 CORS 허용해서 돌려준다.
// 원래 Cloudflare Worker였지만 사내 프록시가 workers.dev를 차단해서(1회성 사용 안내 페이지)
// 제보 앱과 같은 Vercel(ux-writing-reports)로 이사함 — 2026-07. 구 워커 코드는 삭제됨(git 히스토리에서 복구 가능).
// 경로: GET {URL}passport / POST {URL}recommend / POST {URL}translate
// ↓ 주소를 바꾸면 manifest.json allowedDomains에도 같은 도메인 추가할 것.
const NAVER_PROXY_URL = 'https://report-admin-amber.vercel.app/api/';
// 오수정 제보 저장/열람은 별도 Vercel 앱(ux-writing-reports)에서 처리한다.
// 저장 API: POST /api/report, 관리자 페이지: https://report-admin-amber.vercel.app/
// (manifest.json allowedDomains에도 이 도메인 추가)
const REPORT_URL = 'https://report-admin-amber.vercel.app/api/report';
// ── 클로드 다리 (같은 PC의 Claude Code 브리지 — scripts/claude-bridge.js) ──
// `npm run bridge`로 켜두면 Gemini 키 없이도 클로드가 AI 추천을 만든다.
// 우선순위: 예시 사전 → 클로드 다리 → Gemini(개인 키) → 로컬 폴백(유사 예시+규칙).
// manifest.json allowedDomains에 http://localhost:11888 등록돼 있음.
const CLAUDE_BRIDGE_URL = 'http://localhost:11888';
// 감시자(scripts/bridge-watcher.js) — 항상 떠 있는 초소형 서버. POST /wake로 다리를 대신 켠다
// (피그마가 claudebridge:// 열기를 막는 버전 대응 — manifest devAllowedDomains에 11889 등록됨)
const WATCHER_URL = 'http://localhost:11889';
// 이 플러그인이 요구하는 다리 코드 버전 (claude-bridge.js의 BRIDGE_V와 짝 — 동작이 바뀌면 둘 다 올린다).
// 코드를 pull·복사해도 이미 떠 있는 다리는 옛 코드라, 이 검사가 없으면 "고쳤는데 왜 그대로냐"가 반복된다.
const BRIDGE_MIN_V = 35;
async function bridgeHealth() {
    try {
        // 피그마의 네트워크 중계가 첫 요청에 느릴 수 있어 여유 있게 (다리 없으면 연결 거부라 즉시 실패함)
        const res = await fetchWithTimeout(CLAUDE_BRIDGE_URL + '/health', 3000);
        if (!res.ok)
            return { alive: false, ready: false };
        const d = await res.json().catch(() => ({}));
        // 11888을 우리 다리가 아닌 다른 앱이 점유한 경우 — 켜짐으로 착각하지 않는다
        if (!d || d.ok !== true || d.engine !== 'claude')
            return { alive: false, ready: false };
        // 구버전 다리가 떠 있음(코드는 새것인데 프로세스가 옛것) — 다른 problem보다 먼저 알린다.
        // 이걸 안 잡으면 새 코드의 동작을 기대한 사용자가 옛 동작을 보고 원인을 못 찾는다.
        if (!(typeof d.v === 'number' && d.v >= BRIDGE_MIN_V)) {
            return { alive: true, ready: !!d.ready, model: d.model, problem: 'bridge-old', account: d.account || undefined, dir: d.dir };
        }
        return { alive: true, ready: !!d.ready, model: d.model, problem: d.problem, account: d.account || undefined, dir: d.dir };
    }
    catch (e) {
        console.log('[BRIDGE] 다리 확인 실패 (꺼져 있거나 접근 불가):', errStr(e));
        return { alive: false, ready: false };
    }
}
// ── 계정 확인 게이트 ──
// PC에 남아 있는 로그인을 묻지도 않고 쓰지 않는다: 사용자가 "이 계정 쓸게요"라고 확인한 계정만 AI에 쓴다.
// 확인한 계정은 figma.clientStorage에 저장(피그마 사용자·기기 단위) — 계정이 바뀌면 다시 묻는다.
const CONFIRMED_ACCOUNT_KEY = 'confirmedClaudeAccount';
// 대화로 만들기 최근 대화 목록 (UI가 통째로 저장/복원 — clientStorage는 code 쪽에서만 접근 가능)
const COMPOSE_HISTORY_KEY = 'composeHistory';
let confirmedClaudeAccount = null;
// 저장된 확인 계정을 읽어 UI에 알린다 — UI는 이 값으로 첫 화면을 정한다
// (확인된 계정이 그대로면 계정 화면을 건너뛰고 홈으로).
const confirmedAccountLoaded = figma.clientStorage.getAsync(CONFIRMED_ACCOUNT_KEY).then((v) => {
    confirmedClaudeAccount = (typeof v === 'string' && v) ? v : null;
    figma.ui.postMessage({ type: 'confirmed-account', account: confirmedClaudeAccount });
}).catch(() => { figma.ui.postMessage({ type: 'confirmed-account', account: null }); });
function accountNeedsConfirm(account) {
    return !!(account && account !== confirmedClaudeAccount);
}
// 확인 배너를 띄울 상황인가 — 계정을 알 수 있고(다리가 알려줌) 아직 확인 안 된 계정일 때.
// bridge-old는 다리가 낡았을 뿐 계정·추천은 정상 동작하므로 확인 대상에 포함한다
// (로그인 필요·설치 필요 상태에선 계정 확인보다 그 안내가 먼저라 제외).
function needsAccountConfirm(h) {
    if (!h.alive)
        return false;
    if (h.problem && h.problem !== 'bridge-old')
        return false;
    return accountNeedsConfirm(h.account);
}
// 다리 상태를 다시 조회해 UI 버튼에 반영 — AI 호출 실패 직후 호출해서
// 로그인 만료(claude-logout) 같은 problem이 [클로드 켜짐] 표시를 바로 갱신하게 한다.
function refreshBridgeStatus(periodic) {
    bridgeHealth().then((h) => {
        // periodic=true(주기 갱신)이면 UI가 일회성 토스트(껐어요/켜졌어요)를 건너뛰고 라벨만 갱신한다
        figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem, account: h.account, needConfirm: needsAccountConfirm(h), periodic: !!periodic });
    });
}
// 다리를 새 코드로 재시작한다 — /shutdown → 감시자 /wake → /health 폴링. 재시작 후 health를 돌려준다.
// bridge-old(구버전 다리)일 때 사용자가 버튼을 누르지 않아도 자동 업그레이드하는 데 쓴다.
async function restartBridge() {
    try {
        await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/shutdown', {}, 3000);
    }
    catch (_e) { /* 이미 꺼졌으면 무시 */ }
    await new Promise((r) => setTimeout(r, 1200)); // 옛 다리가 스스로 종료할 시간
    try {
        await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000);
    }
    catch (_e) {
        try {
            figma.openExternal('claudebridge://start');
        }
        catch (_e2) { /* 보조 경로도 실패 — 아래 상태 확인이 알려준다 */ }
    }
    let h = await bridgeHealth();
    for (let i = 0; i < 6 && (!h.alive || h.problem === 'bridge-old'); i++) {
        await new Promise((r) => setTimeout(r, 1500));
        h = await bridgeHealth();
    }
    return h;
}
// 추천/팝업/번역 등 AI 동작 직전 호출 — 다리가 구버전(bridge-old)이면 로딩을 띄우고 자동으로 재연결한다.
// 반환: 재연결까지 마친 최신 health (여전히 old/죽음이면 그대로 반환 — 호출부가 안내).
async function autoUpgradeIfOld(bh) {
    if (!bh.alive || bh.problem !== 'bridge-old')
        return bh;
    figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '클로드를 새 버전으로 다시 연결하는 중이에요…' });
    const h = await restartBridge();
    refreshBridgeStatus();
    return h;
}
// 클로드다리 설치 파일 — 다리+예시+런처를 내장한 자기완결 bat. UI의 [🔧 설치 파일 받기]가 다운로드로 내려준다.
// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.bat을 base64로 주입) =====
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21saw0KWjJVcENpOHZJT3k4bk91UmtPdXB0Q0R0bEl6cm42enF0N2pzbmJqc25aZ2dXK3kybE95eW5PdXdtK3E0c0YzcXNJQWdSMlZ0YVc1cElPMkNwQ0RzbDRic25iVHJqNFFnN1lHMDY2R2M2NU9jNjZHY0lFRkpJT3kybE95eW5PeWRoQ0Ryc0p2cmlwVHJpNlF1Q2k4dkNpOHZJT3lHamV1UGhDRHNoS1RxczRRNklPMkJ0T3Vobk91VG5PdWx2Q0RzbXBUc3NxM3JwNGpyaTZRZzdJT0k2NkdjSU95TG5PdVBtZTJWbU91cHRDQXpNSDQwTU95MGlPcXdnQ0RxdDdqcmc2VWc2NEtnN0pXRTZyQ0U2NHVrTGdvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0NpOHZJQ0FnNnJDQTdKMjA2NU9jSyt5WWlPeUxuQ2d4TVRIcXNiUXA2NHFVSU95eXF5RHJxWlRzaTV6c3A0RHJvWndnN1pXY0lPdXlpT3VuakNEc25iM3QNCm5venJpNlF1SU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjZ5NDZyV3M2NmVNSU91enRPdUN0T3V2Z091aG5DRHJ1YURycGJUcmk2UXVDaTh2SU95RXVPeUZtT3lkZ0NBek1PdXlpQ0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3WlcwSU91TWdPMlpsT3F3Z0NEcnJMVHRsWnp0bm9nZzZyaTQ3SmEwN0tlQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaTh2Q2k4dklPeWdoT3lnbkRvZzdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0NjQrOElPeWVpT3lkaENEcXNvTWdLR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3Snk4NjZHY0lPMlpsZXlkdUNrS0x5OGc3S084N0oyWU9pRHNncXpzbXFucm40bnNuWUFnNnJDQjdKNlFJTzJCdE91aG5PdVRuQ0RxdGF6cmo0VWc3WldjNjQrRTdKZVE3SVNjSU95d3FPcXdrT3VRbk91THBDNEtDbU52Ym5OMElHaDBkSEFnUFNCeVpYRjFhWEpsS0Nkb2RIUndKeWs3Q21OdmJuTjBJR1p6SUQwZ2NtVnhkV2x5WlNnblpuTW5LVHNLDQpZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdA0KWTNka0p5azdDblJ5ZVNCN0lHWnpMbTFyWkdseVUzbHVZeWhGVFZCVVdWOURWMFFzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsSUgwcE95QjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUXBqYjI1emRDQkRURUZWUkVWZlJVNVdJRDBnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnY0hKdlkyVnpjeTVsYm5Zc0lIc0tJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcENpQWdRMHhCVlVSRlgwTlBSRVZmUkVsVFFVSk1SVjlPVDA1RlUxTkZUbFJKUVV4ZlZGSkJSa1pKUXpvZ0p6RW5MQ0F2THlEdGhMUWc3SnFVN0pXOUlPdVRzU0RydG9EcXNJQWc3Wmk0N0xhY0lPdUJsQW9nSUVSSlUwRkNURVZmVkVWTVJVMUZWRkpaT2lBbk1TY3NDbjBwT3dvS0x5OGc3SWlvNnJtQUlPeUxwTzJXaVNqcXNKRHNpNXpzbnBBZzdJcWsNCjdZK3c3SjJBSUhOMFpHbHZJR2xuYm05eVpTbnNsNURzaEp6cmo0UWc2Nnk0N0tDYzY2VzhJT3kybE95Z2dlMlZvQ0RzaUpnZzdKNkk2cktNSU95OW1PeUdsQ0Ryb1p6cXQ3anJwYndnN1l5TTdKMjg3SmVRNjQrRUlPdUNxT3E0dE91THBDNEtMeThnN0p5RTdMbVlPaURzbm9Uc2k1d2c3WSswNjQyVTdKMllJR05zWVhWa1pTMWljbWxrWjJVdWJHOW5JQ2pzbklqcmo0VHNtckFnSlZSRlRWQWxMQ0RycDZVZ0pGUk5VRVJKVWlrdUlESk5RaURyaEpqc25MenJxYlFnTG05c1pPdWhuQ0R0bFp3ZzdJUzQ2NHlBNjZlTUlPdXp0T3EwZ0M0S1kyOXVjM1FnVEU5SFgwWkpURVVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExteHZaeWNwT3dwamIyNXpkQ0JmYjNKcFoweHZaeUE5SUdOdmJuTnZiR1V1Ykc5bkxtSnBibVFvWTI5dWMyOXNaU2s3Q21OdmJuTnZiR1V1Ykc5bklEMGdablZ1WTNScGIyNGdLQ2tnZXdvZ0lHTnZibk4wSUdGeVozTWdQU0JCY25KaGVTNXdjbTkwDQpiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bg0KYVdaNUtHRXBLU2t1YW05cGJpZ25JQ2NwSUNzZ0oxeHVKenNLSUNBZ0lHWnpMbUZ3Y0dWdVpFWnBiR1ZUZVc1aktFeFBSMTlHU1V4RkxDQnNhVzVsS1RzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHRqSXpzbmJ3ZzY2R2M2cmU0SU95THBPMk1xTzJWdE91UGhDRHJpNlRycHF6cmlwUWc2ck9FN0lhTklDb3ZJSDBLZlRzS0NtTnZibk4wSUZCUFVsUWdQU0JPZFcxaVpYSW9jSEp2WTJWemN5NWxibll1UWxKSlJFZEZYMUJQVWxRcElIeDhJREV4T0RnNE95QXZMeUJDVWtsRVIwVmZVRTlTVk91S2xDRHRoWXpzaXFUdGlyanNtcWtnS08yUGlleUdqT3lYbENBeE1UZzRPQ0RxczZEc29KVXBDaTh2SU91THBPdW1yQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0F2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDNGc3TDJVNjVPYzY2VzhJSEIxYkd6Q3QrdXp0ZXlDck8yVnRPdVBoQ0FxS3V5ZHRPdXZ1Q0RybHFBZzdKNkk2NHFVSU91THBPdW1yT3VLbENEc21Kc2c3TDJVNjVPY0lPcTN1T3VNZ091aG5Db3ENCjY1MjhDaTh2SU9xN2tPdUxwQ0Rzdkp6cXVMQWc3S0NFN0plVUlPeURpQ0RyajVuc25wSHNuYlFnN0pXSUlPdUNtT3lZcU91THBDanRoTERycjdqcmhKRHNuYlFnNjV5bzY0cVVJT3VUc1NrdUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEc25iUWc2ckNTN0p5ODY2R2NJT3Exck91eWhPeWdoT3lkaENEcXNKRHNwNER0bGJRZzdKNnM3SXVjN0o2UjdJdWM3WUtvNjR1a0xnb3ZMeURyajVuc25wSHNuYlFnNjdDVTY0Q002NHFVSU95SW1PeWdsZXlkaENEdGxaanJxYlFnN0oyMElPeUlxK3lla091bHZDRHNtS3pycHF6cXM2QWdZMjlrWlM1MGMreWRtQ0JDVWtsRVIwVmZUVWxPWDFicmo0UWc2ckNaN0oyMElPeVlyT3Vtc091THBDNEtZMjl1YzNRZ1FsSkpSRWRGWDFZZ1BTQXpOVHNLTHk4ZzZyaXc2N080SU91cXFPdU51QzRnN0pxVTdMS3RLTzJVak91ZnJPcTN1T3lkdUNuc25iUWdiVzlrWld6c25ZUWc3S2VBN0tDVjdaV1k2Nm0wSU9xM3VDRHNtcFRzc3EzcnA0d2c2cmU0SU91cXFPdU51T3VobkNEc3NwanJwcXp0DQpsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPYw0KSUNoeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUWc0b0NVSUdKMWFXeGtMV2RzYjNOellYSjVMbXB6N0ptQUlPcXdtZXlkZ0NEdGpJenNoSndwSU9LVWdPS1VnQXBtZFc1amRHbHZiaUJzYjJGa1JYaGhiWEJzWlhNb0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzFrSUQwZ1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNzSUNkeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUW5LU3dnSjNWMFpqZ25LVHNLSUNBZ0lHTnZibk4wSUhObFkwbGtlQ0E5SUcxa0xuTmxZWEpqYUNndlhpTWpJT3kybE95eW5DRHNtSWpzaTV4Y2N5b2tMMjBwT3dvZ0lDQWdhV1lnS0hObFkwbGtlQ0E5UFQwZ0xURXBJSEpsZEhWeWJpQmJYVHNLSUNBZ0lHTnZibk4wSUdWNFlXMXdiR1Z6SUQwZ1cxMDdDaUFnSUNCc1pYUWdZM1Z5SUQwZ2JuVnNiRHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjbUYzSUc5bUlHMWtMbk5zYVdObEtITmxZMGxrZUNrdWMzQnNhWFFvSjF4dUp5a3ANCklIc0tJQ0FnSUNBZ1kyOXVjM1FnYkdsdVpTQTlJSEpoZHk1eVpYQnNZV05sS0M5Y2N5c2tMeXdnSnljcE93b2dJQ0FnSUNCamIyNXpkQ0JvSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYaU1qSTF4ekt5Z3VLejhwWEhNcUpDOHBPd29nSUNBZ0lDQnBaaUFvYUNrZ2V5QmpkWElnUFNCN0lHbHVjSFYwT2lCb1d6RmRMQ0J6ZFdkblpYTjBhVzl1Y3pvZ1cxMGdmVHNnWlhoaGJYQnNaWE11Y0hWemFDaGpkWElwT3lCamIyNTBhVzUxWlRzZ2ZRb2dJQ0FnSUNCamIyNXpkQ0JpSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYbHh6S2kxY2N5c29MaXMvS1Z4ektpUXZLVHNLSUNBZ0lDQWdhV1lnS0dJZ0ppWWdZM1Z5S1NCamRYSXVjM1ZuWjJWemRHbHZibk11Y0hWemFDaGlXekZkTG5Od2JHbDBLQ2NnTHlBbktTNXFiMmx1S0NjZ0p5a3BPd29nSUNBZ2ZRb2dJQ0FnY21WMGRYSnVJR1Y0WVcxd2JHVnpMbVpwYkhSbGNpZ29aU2tnUFQ0Z1pTNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dQaUF3S1RzS0lDQjlJR05oZEdOb0lDaGxLU0I3DQpDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpdw0KSU9xem9PeTVxQ0FySU95V3RPeUluQ0RyczREcXNyMGk3SjIwSU91UW5PdUxwQzRnN0pldDdaV2dJT3UyaE91bXJDRGlnSlFLTHk4ZzdZRzA2NkdjNjVPY0lEMGc2Nnk0N0o2bElPdUxwT3VUck9xNHNDanNzTDNzblpncExDRHNtcW5zbHJRZzdZYTE3SjI4d3JmcnA1N3N0cVRyc3BVZ1BTQmpiMlJsTG5SeklISmxabWx1WlVGcFUzVm5aMlZ6ZEdsdmJuTWc3WnVFN0xLWTY2YXNLT3E0c09xemhPeWdnU2t1Q21OdmJuTjBJRk5VV1V4RlgxSlZURVZUSUQwZ1d3b2dJQ2N4TGlEdGxiVHNtcFRzc3JRNklPdXFxT3VUb0NEcnJManF0YXpyaXBRZzdaVzA3SnFVN0xLMDY2R2NMaUFvNjdPMDY0T0Y2NHVJNjR1azRvYVM2N08wNjRLMDdKcVVLU2NzQ2lBZ0p6SXVJT3VLcGV1UG1leWdnU0RycDVEdGxaanF1TEE2SU91UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDd2dmdXlYaUNEcnVienF1TEFvNjdDVTY0Q003SmVJN0phMDdKcVU0b2FTNjdDVTZyK283SmEwN0pxVUtTNGc2NHVvTENEc29vWHJvNHpDdCt1bmpPdWoNCmpNSzM3SmV3N0xLMHdyZnRsYlRzcDREQ3QrcTRzT3VobmNLMzY0VzU3SjJNSU91VHNTRHNpNXpzaXFUdGhaenNuYlFnN0tPODdMSzA3SjI0SU9xeXNPcXp2T3VLbENEc2lKanJqNW50bUpVZzdKeWc3S2VBS095WHNPeXl0T3VQdk95YWxDd2c2NFc1N0oyTTY0Kzg3SnFVS1M0bkxBb2dJQ2N6TGlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd09pQWlmdTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVJaURyaklEc2k2QWdJbjd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWlJT3Exck95aHNDRHNtckRzaEtBdUlPdUxxQ3dnN0tDVjdMR0Y3SU9CSU91MmlPcXdnTUszN0oyODY3YUFJT3E0c091S3BTRHNvSnp0bFp6Q3QrdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3F5c09xenZNSzM3S0NWNjdPMElPdXp0TzJZdUNEc2xZanNpNnpzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJlaUM0bkxBb2dJQ2MwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phME9pQis3WldZN0l1YzZyS2c3SmEwDQo3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cA0KTGljc0NpQWdKell1SU8yUm5PcTRzRG9nNjVDWTdKYTA3SnFVNG9hUzY0Kzg3SnFVTGljc0NpQWdKemN1SU95a2hDRHF0YXpzb2JBNklPeWJrT3V6dU95ZHRDRHRsWndnN0tTRTdKMjA2Nm0wSU95MmxPeXluT3VQaENEcnNKanJrNXpzaTV3ZzdaV2NJT3lraE91aG5DNGc3SjZFN0oyWTY2R2NJT3lraE95ZGhDRHJpcGpycHF6c3A0QWc3SldLNjRxVTY0dWtMaURyaTZnc0lPeVhyT3VmckNEcnJManNucVhzbllRZzdaV1k2NEtZN0oyWUlPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25MenJvWndnN1pXcDdMT1FJT3VObENEcXNJVHFzckR0bGJUc3A0VHJpNlRycWJRZzdLU0VJT3lJbU91bHZDRHNwSVRzbmJUcmlwUWc2cktEN0oyQUlPMlptT3lZZ1M0bkxBb2dJQ2M0TGlEdGpKM3NsNFVvNjR1azdKMjA3SmE4NjZHYzZyZTRLU0Ryc29UdGlydzZJT3F5c09xenZDRHRoclhyczdUcmlwUWdXKzJabGV5ZHVGMHNJT3lZaUMvc2xZVHJpNGpzbUtRZzdZeVE2NHVvN0oyQUlGdnNsWVRyaTRqc21LUmRMMXZyaEtSZExDRHINCmo1bnNucEVnN0p5ZzY0K0U2NHFVSUZ2c3Q2anNob3hkTDF0NzY0K1o3SjZSZlYwdUlDTHN0NmpzaG93aTY0cVVJT3VQbWV5ZWtTRHJzb1R0aXJ6cXM3d2c3S2VkN0oyOElPdVZqT3VuakNEc2s3RHFzNkFnSXV1THErcTRzTUszNjQrWjdKNlJJdXl5bU91ZnZDRHNwNTBnN0pXSUlPdW5udXVLbENEc29iRHRsYW5DdCt1THFPdVBoU0FpN0xlbzdJYU1JdXVLbENEcXVJanNwNEF1Snl3S0lDQW5PUzRnN0oyMDY2YUV3cmZzb0lUdG1aVHJzb2p0bUxqQ3QrdW5pT3lLcE8yQ3VleWRnQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzBMaURzZ3F6cm5venNuWVFnNjdhQTY2VzhJT3VWa0NEcmk1anNuWVFnNjdhWjdKZXM2NCtFSU95aWkrdUxwQzRuTEFvZ0lDY3hNQzRnN0tDYzdaS0lJT3lhcWV5V3RDRHNuS0RzcDRBNklPeWVoZXVncGV5WGtDRHNrN0RzbmJnZzZyaXc2NHFsN0lTeElPdXFoZXlDckNqcnM0RHFzcjBzSU95bmdPeWdsU3dnNjVPeDY2R2RMQ0R0bGJUc29Kd2c2NU94S2V1S2xDRHRtWlRycWJUc25aZ2c2cml3DQo2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqcw0KaUpqcmo1bnRtSlhDdCtxeXZleVd0TUszNjdhQTdLQ1Y3WmlWSU8yWGlPeWFxU0RzdklEc25iVHNpcVFwN0oyWUlPdUptT3lWbWV5S3BPcXdnQ0RzbktEc2k2VHJrSnpyaTZRdUNpOHZJTzJNak95ZHZPeWR0Q0RzbDRic25MenJxYlFvN0lTazdMbVk2N080SU9xMXJPdXloT3lnaENEcms3RXBJT3U1aUNEcnJManNucERzbDdRZzRvQ1VJT3lhbE95VnZldW5qT3ljdk91aG5DRHJqNW5zbnBFb1ptRnBiQzF6YjJaMEtTNEtablZ1WTNScGIyNGdiRzloWkVkMWFXUmxLQ2tnZXdvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdFpDQTlJR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bkxDQW5kWGd0ZDNKcGRHbHVaeTV0WkNjcExDQW5kWFJtT0NjcExuUnlhVzBvS1RzS0lDQWdJSEpsZEhWeWJpQnRaQzVzWlc1bmRHZ2dQaUF4TURBZ1B5QnRaQ0E2SUNjbk93b2dJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2lxVHQNCmc0RHNuYndnNnJDQTdKMjA2NU9jSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lhbE95VnZldW5qT3ljdk91aG5DRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z0p5YzdDaUFnZlFwOUNtTnZibk4wSUVkVlNVUkZJRDBnYkc5aFpFZDFhV1JsS0NrN0NncG1kVzVqZEdsdmJpQnBibk4wY25WamRHbHZiazFsYzNOaFoyVW9LU0I3Q2lBZ1kyOXVjM1FnWm1WM1UyaHZkQ0E5SUVWWVFVMVFURVZUTG0xaGNDZ29aWGdwSUQwK0lDZEpibkIxZERvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtHVjRMbWx1Y0hWMEtTQXJJQ2RjYms5MWRIQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExuTjFaMmRsYzNScGIyNXpLU2t1YW05cGJpZ25YRzRuS1RzS0lDQnlaWFIxY200Z0tBb2dJQ0FnSit5bmdPcTRpT3UyZ08yRXNDRHJoSWpyaXBRZzdKZVE3SXFrN0p1UUtGTXRNU3dnNjdPMDdKV0k3WnFNN0lLc0tleWRtQ0R0bFp6cXRhM3NsclFnVlZnZ1YzSnBkR2x1WnlEc29JVHJyTGpxDQpzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91TA0KcEM0Z0p5QXJDaUFnSUNBbjdLR3c2ckcwSU8yUm5PMlloQ2pzbmJUc2c0SEN0K3lkdE8yVm1NSzM3SjIwNjRLMHdyZnN0SWpxczd6Q3QrdXZ1T3Vuak1LMzY3YUE3WVN3d3JmcXVZenNwNEFnNjVPeEtleWRnQ0Rzb0pYc3NZVWc3S0NWNjdPMDY0dWtJT0tBbENEcnVienFzYkRyZ3BnZzY0dWs2Nlc0SU95aHNPcXh0T3ljdk91aG5DRHJzSlRxdnJqc3A0QWc2NmVJNjUyOEtDSTE3WnFNSU95ZHRPeURnU0xzbllRZ0lqWHRtb3dpNjZHY0lPeWtoT3lkdE91cHRDRHNtS1RyaTdVcExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc2w1QWc3SmVHNjRxVUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN0l1YzZyQ0VJT3VUc1Nuc21ZQWc3WlcwNnJLd0lPdXdxZXV5bGNLMzdLQ0k3TENvS095ZXJPeUVwT3lnbGNLMzY2eTQ3SjJZN0xLWXdyZnNucXpzaTV6cmo0UWc2NU94S2V1bHZDRHNwNERzbHJUcmdyUWc2N2FaN0oyMDY0cVVJT3F5Zyt5ZGdDRHNvSWpyaklBZzZyaUkNCjdLZUFJT0tBbENEc2xZVHJpcFFnNnJDUzdKMjA2NTI4NjQrRUxDRHF0N2pybjdUcms2L3RsYlRyajRRZzdKT3c3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSnpQcXNKd2c3S0NjN0pXSTdKMkFJT3lFbk91aG5DRHNvSkhxdDd6c25iUWc2NHVzNjUyODdKVzhJTzJWbk91THBDRGlnSlFnN1pXWTY0S1k2NHFVSU95YmtPdXN1Q0RxdGF6c29iRHJwYndnN0p5ZzdLZUE3WldjSU95MW5PeUdqQ0RyaTZUcms2enF1TEFzSU8yVm1PdUNtT3VLbENEcnJManNucVVnNnJXczdLR3c2Nlc4SU95ZXJPcTFyT3lFc2UyVm5DRHJqSURzbFlnc0lDY2dLd29nSUNBZ0orcTN1T3Vtck9xem9DRHNvSUhzbHJUcmo0UWc3WldZNjRLWTY0cVVJT3F6dk9xd2tPMlZuQ0RzbnF6cXRhenNoTEU2SU95a2tldXp0U0R0a1p6dG1JVHNuWVFnNjQyYzdKYTA2NEswNnJPZ0xDRHNvSlhyczdRZzdJaWM3SVNjNjZXOElPeUNyT3lhcWV5ZWtPcXdnQ0RzbFl6c2xZVHNsYndnN1pXZ0lPcXlnK3UyZ08yRXNPdWhuQ0RzbnF6c29iRHNwNEh0DQpsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZw0KSUNBZ0oreVZoT3VlbUNEc21JanNpNXpyazZUc25ZQWc3WldjSU95a2hPeW5uT3VtckNEc3RaenNob3dnNnJXUTdLQ1Y3SjIwSU91bmp1eW5nT3VuakNEcXQ3anFzYlFnN1lha0tPMlZ0T3lhbE95eXRNSzM2cks5N0phMEtleWRtQ0RxdFpEcnM3anNuYlRzcDRBZzdJYU02cmU1N0lTeDdKMllJT3Exa091enVPeWR0Q0RzbFlUcmk0anJpNlFnNG9DVUlPeVhyT3VmckNEcnJManNucVhzcDV6cnBxd2c3SjZGNjZDbDdKMkFJT3VwbE95TG5PeW5nQ0RyaTZqc25JVHJvWndnNjR1azdJdWNJT3lFcE9xemhPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURyc0xEc2w3VHJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoY0szN0wyVTY1T2M3WTZjN0lxa0lPcTRpT3luZ0RwY2JpY2dLd29nSUNBZ0oxdDdJblJsZUhRaU9pQWk3S0NjN0pXSUlPdXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2cNCkl1dXN0T3lYaCt5ZGhDRHNtWndnNjdDVTZyK282NHFVN0tlQUlPMlZuT3ExcmV5V3RDRHRsWndnNjZ5NDdKNmxJbjBzSUM0dUxsMWNibHh1SnlBckNpQWdJQ0FuVyt5S3BPMkRnT3lkdkNEcXQ1enN1WmxkWEc0bklDc2dVMVJaVEVWZlVsVk1SVk1nS3lBblhHNWNiaWNnS3dvZ0lDQWdLRWRWU1VSRklEOGdKMXZzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jSU95Z2hPdXN1Q0FvZFhndGQzSnBkR2x1Wnk1dFpDa2c0b0NVSU95Y2hDRHF0NXpzdVpuc25aZ2c2cmU4NnJHdzdKbUFJT3lZaU95WnVDRHNpNXpyZ3BqcnBxenNtS1F1SU8yS3VlMmVpQ0RzbUlqc21iZ2c2cmVjN0xtWktPeUltT3VQbWUyWWxjSzM2cks5N0phMHdyZnJ0b0Rzb0pYdG1KWHNuWVFnN0p5ZzdLZUE3WlcwN0pXOElPMlZtT3VLbENEc2c0SHRtYWtwN0oyRUlPcTN1T3VNZ091aG5DRHJsTERycGJUcXM2QXNJT3lhbE95VnZlcXp2Q0Rzb0lUcnJManNuYlFnNjR1azY2VzA2Nm0wSU95Z2hPdXN1T3lkaENEcmxMRHJwYmpyaTZSZFhHNG5JQ3NnDQpSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cA0KYm1WQ2RXWWdQU0FuSnpzZ0lDQWdJQ0FnSUNBdkx5QnpkR1J2ZFhRZzdLU0VJT3V5aE8yTnZBcHNaWFFnZDJGcGRHVnlJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDOHZJTzJZaE95ZXJDRHRoTFRzblpnZ2V5QnlaWE52YkhabExDQnlaV3BsWTNRc0lIUnBiV1Z5SUgwS2JHVjBJSEYxWlhWbElEMGdVSEp2YldselpTNXlaWE52YkhabEtDazdJQzh2SU95YWxPeXlyU0RzcDRIcm9LenRtWlFnS091UG1leUxuQ0RzbXBUc3NxM3NuWUFnN0lpYzdJU2M2NHlBNjZHY0tRcHNaWFFnZEhWeWJuTWdQU0F3T3dwc1pYUWdkMkZ5YldWa1ZYQWdQU0JtWVd4elpUc0tiR1YwSUdOMWNuSmxiblJOYjJSbGJDQTlJRU5NUVZWRVJWOU5UMFJGVERzZ0x5OGc3S2VBNnJpSUlPeUV1T3lGbU95ZHRDRHJyTHpxczZBZzdKNkk2NHFVSU91cXFPdU51Q0FvN0pxVTdMS3Q3SjIwSU91THBPdWx1Q0RycXFqcmpianNuWVFnN0tlQTdLQ1Y3WldZNjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFcENpOHZJT3lMbk95ZWtTRHNpNXdnUTJ4aGRXUmwNCklFTnZaR1VvWTJ4aGRXUmxJRU5NU1NucXNJQWc3Sk80SU95SW1DRHNub2pyaXBUc3A0QWc3S0NRNnJLQUlPS0FsQ0RzbDRic25MenJxYlFnTDJobFlXeDBhT3VobkNEc2xZenJvS1FnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZuT3VMcEM0S0x5OGdiblZzYkQzdG1aWHNuYmdnN0tTUkxDQW5iMnNuUGV5Q3JPeWFxU0Rxc0lEcmlxVXNJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzlZMnhoZFdSbElPdXFoZXVndVNEc2w0YnNuWXdzQ2k4dklDZGpiR0YxWkdVdGJHOW5iM1YwSnoxamJHRjFaR1hyaXBRZzdKNkk3S2VBNjZlTUlPdWhuT3EzdU95ZHVDRHNoTGpzaFpnZzY2ZU02Nk9NSUNqdGhMUWc3SXVrN1l5b0lPeUxuQ0Rxc0pEc3A0QXNJT3lFc2VxenRTRHRoTFRzbmJRZzdKaWs2Nm0wSU95ZWtPdVBtU0R0bGJUc29Kd3BDaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzDQpucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWg0KN0oyQUlPcXl2ZXVobk91aG5DRHNucUh0bm9qcnI0RHJvWndnN0tTUjY2YTlJTzJSbk8yWWhPeWRoQ0RzazdUcmk2UUtZMjl1YzNRZ1RFOUhTVTVmUjFWSlJFVWdQU0FuN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdU95ZHRDRHRsWVRzbXBUdGxiVHNtcFFvN0pXSUlPdVFrT3F4c091Q21DRHJwNHpybzR3cElPS0FsQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGMGc2N0tFN1lxODdKMkVJT3VJaE91bHRPdXB0Q0Ryb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3lYdE95V3RPdVRuT3VncE95YWxDNG5Pd292THlEc2k2VHN1S0h0bFp3ZzY2eTQ2cldzNjVPa09pQWlSbUZwYkdWa0lIUnZJR0YxZEdobGJuUnBZMkYwWlRvZ1QwRjFkR2dnYzJWemMybHZiaUJsZUhCcGNtVmtJR0Z1WkNCamIzVnNaQ0J1YjNRZ1ltVWdjbVZtY21WemFHVmtJaWpycDR6cm80d3BMQW92THlBaVRtOTBJR3h2WjJkbFpDQnBiaURDdHlCUWJHVmhjMlVnY25WdUlDOXNiMmRwYmlJbzY2KzQ2NkdjNnJlNDdKMjQNCktTRGlnSlFnNjVHWUlPdUxwQ0RzbnFIdG5vanFzb3dnNjRTVDdaNk02NHVrQ21aMWJtTjBhVzl1SUdselFYVjBhRVZ5Y205eUtITXBJSHNLSUNCeVpYUjFjbTRnTDJGMWRHaGxiblJwWTJGMGZHOWhkWFJvZkdGd2FTQnJaWGw4Ykc5bklEOXBibnhzYjJkblpXUjhjMlZ6YzJsdmJpQmxlSEJwY21Wa0wya3VkR1Z6ZENoVGRISnBibWNvY3lrcE93cDlDaTh2SU95Q3JPeWFxU0R0bFp6cmo0UWc3TFNJNnJPOElPcXdrT3luZ0NEaWdKUWc2NkdjNnJlNDdKMjQ3SjJBSU91cGdPeXBvZTJWbk91TnNDQWk2NDJVSU91cXV5RHNrN1RyaTZRaTY0cVVJT3F5dmV5YXNDNGc2NkdjNnJlNDdKMjRJT3Vuak91ampPeVpnQ0Rzb2JEc3VaanFzSUFnNjR1czY1Mjg3SVNjSU91VXNPdWhuQ0RzbnFIcmlwVHJpNlF1Q2k4dklPeUxwT3k0b1NneU1ESTJMVEE0TENEdG1venNncXdnN0plVTdZU3c3WlNFNjUyODdKMjA3S2FJSU95aWpPeUVuU2s2SUNKWmIzVW5kbVVnYUdsMElIbHZkWElnYVc1a2FYWnBaSFZoYkNCemNHVnVaQ0JzDQphVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6cw0KbnBEc2w1RHFzb3dnN1pXYzY0K0U2Nlc4SU95WXJPdWdwQ0RyaTZ6cm5ienFzNkFnN0pxVTdMS3Q3WldZNnJPZ0xDRHNsWVRyaTRqcnFiUWdXL0NmbjZBZzdZRzA2NkdjNjVPY0lPMlZuT3VQaENEc3RJanFzN3hkSU91eWhPMkt2T3lkaENEcmlJenJuNndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxiUWc3S084N0lTNDdKcVVMaWM3Q2k4dklDZnRsWnpyajRRbjY2R2NJT3V0aWV1YXNlcTN1T3Vtck91cHRDRHNsWWdnNjVDYzY0dWtJT0tBbENEc25xRHF1WkFnNjZxdzY2YTBJT3VWakNEcmdwanJpcFFnY21GMFpTQnNhVzFwZE95ZHRPdUNtQ0RyckxqcnA2VWc2cmk0N0oyMElPeTBpT3F6dk9xNWpPeW5nQ0RzbnFIc2xZUUtMeThnN0plSjY1cXg3WldZNnJLTUlDTHJpNlRycGJnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJWbU91ZHZDTHFzNkFnN0pXSTY0SzA3WldZNnJLTUlPdVFuT3VMcEM0ZzdLZUE3TGFjd3Jmc2dxenNtcW5ybjRrZzdJT0I3WldjSU91c3VPcTENCnJPdW5qQ0Rzb29IdG1JRHNoSndnNjdPNDY0dWtDbVoxYm1OMGFXOXVJR2x6VEdsdGFYUkZjbkp2Y2loektTQjdDaUFnY21WMGRYSnVJQzl6Y0dWdVpDQnNhVzFwZEh4MWMyRm5aUzFqY21Wa2FYUnpmSFZ6WVdkbElHeHBiV2wwSUNoeVpXRmphR1ZrZkdWNFkyVmxaR1ZrS1M5cExuUmxjM1FvVTNSeWFXNW5LSE1wS1RzS2ZRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU8yWmxleWR1Q0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOejY2VzhJT3lkdmV5V3RBb3ZMeUF2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDQW83WlNNNjUrczZyZTQ3SjI0N0oyMElDTHJpSVRxdGF3ZzZyT0U3S0NWN0p5ODY2R2NJT3lUc091S2xDRHNwSkhzbmJqc3A0QWlJTzJSbk95TG5DRGlnSlFnNnJPMTdKcXBJRkJEN0plUTdJU2NJT3VDcU95ZG1DRHFzNFRzb0pVZzdKaWs3SUtzN0pxcElPdXdxZXluDQpnQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMA0KSU95ZHRDRHFzSkxxczd3ZzdZeU03SjI4N0oyWUlPcXpoT3lnbGV5ZHRDRHNsclRxdUl2cmdwenJpNlFLYkdWMElITmxjM05wYjI1QlkyTnZkVzUwSUQwZ2JuVnNiRHNLWm5WdVkzUnBiMjRnWTJ4aGRXUmxRV05qYjNWdWRDZ3BJSHNLSUNCcFppQW9SR0YwWlM1dWIzY29LU0F0SUdGalkyOTFiblJEWVdOb1pTNWhkQ0E4SURNd01EQXdLU0J5WlhSMWNtNGdZV05qYjNWdWRFTmhZMmhsTG1WdFlXbHNPd29nSUd4bGRDQmxiV0ZwYkNBOUlHNTFiR3c3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3dvZ0lDQWdaVzFoYVd3Z1BTQW9haUFtSmlCcUxtOWhkWFJvUVdOamIzVnVkQ0FtSmlCcUxtOWhkWFJvUVdOamIzVnVkQzVsYldGcGJFRmtaSEpsYzNNcElIeDhJRzUxYkd3N0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2cNCjY2R2M2cmU0N0oyNElPeWR0T3VncFNEc2w0YnNuWXdnNjVPeElPS0FsQ0J1ZFd4c0lPeWNvT3luZ0NBcUx5QjlDaUFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ1JHRjBaUzV1YjNjb0tTd2daVzFoYVd3Z2ZUc0tJQ0J5WlhSMWNtNGdaVzFoYVd3N0NuMEtablZ1WTNScGIyNGdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1NCN0NpQWdZMjl1YzNRZ2NISnZZbVVnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3ljdExYWmxjbk5wYjI0blhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXSUgwcE93b2dJR3hsZENCdmRYUWdQU0FuSnpzS0lDQndjbTlpWlM1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXlCdmRYUWdLejBnWkM1MGIxTjBjbWx1WnlncE95QjlLVHNLSUNCd2NtOWlaUzV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzdJSDBwT3dvZ0lIQnliMkpsTG05dUtDZGpiRzl6DQpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVA0KWldNNklDY25JSDA3Q2dvdkx5RGlsSURpbElBZzdaU002NStzNnJlNDdKMjRJT3lEbmV5aHRDRHFzSkRzcDRBbzdJdXM3SjZsNjdDVjY0K1pLU0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQUtMeThnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3VXb0NEc25vanJpcFFnNjQrWjdKV0lJR052WkdVdWRIUHFzSUFnTmV5MGlPdW5pT3VMcENCUVQxTlVJQzlvWldGeWRHSmxZWFRycGJ3ZzY3TzA2NEs0NjR1a0xnb3ZMeUR0bFp3ZzY3S0k3SjIwNjUyODY0K0VJT3V3bSt5ZGdDRHJrcVFnTXpEc3RJanFzSVFnNjRHSzZyaXc2Nm0wSU8yVWpPdWZyT3EzdU95ZHVDanJtSkRyaXBRZzdaUzg2cmU0NjZlSUtleWR0Q0RyaTZ2dG5vd2c2cktESU9LQWxDRHRnYlRyb1p6cms1enF1WXpzcDRBZzY0Mnc2NmFzNnJPZ0lPcXdtZXlkdENEcXVyenNwNFRyaTZRdUNpOHYNCklPeVZoT3luZ1NEdGxad2c2N0tJNjQrRUlPdXF1eURyc0p2c2xaanNuTHpycWJRbzY0dWs2NmFzNjZlTUlPdW92T3lnZ0NEc3ZLQWc3SU9CN1lPY0xDRHNucERyajVuc2k1enNucEVnNjVPeEtTRHFzNFRzaG8wZzY0eUE2cml3N1pXYzY0dWtMZ3BqYjI1emRDQklSVUZTVkVKRlFWUmZSRVZCUkY5TlV5QTlJRE13TURBd093cHNaWFFnYkdGemRFSmxZWFFnUFNBd093cHpaWFJKYm5SbGNuWmhiQ2dvS1NBOVBpQjdDaUFnYVdZZ0tHeGhjM1JDWldGMElDWW1JRVJoZEdVdWJtOTNLQ2tnTFNCc1lYTjBRbVZoZENBK0lFaEZRVkpVUWtWQlZGOUVSVUZFWDAxVEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNNNjUrczZyZTQ3SjI0SU95THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBZzRvQ1VJTzJVdk9xM3VPdW5pQy90bEl6cm42enF0N2pzbmJqc25iUWc2NHVyN1o2TUlPcXlnK3ljdk91aG5DRHJzN1RxczZBZzZyQ1o3SjIwSU9xNnZPeW5rZXVMaU91THBDNG5LVHNLSUNBZ0lIQnliMk5sDQpjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQc25MenJvWndnWTJ4aGRXUmxJTzJLdU91bXJPdWx2Q0Rzb0pYcnBxenRsWnpyaTZRS0lDQjlDbjBzSURVd01EQXBPd29LTHk4ZzRwcWc3N2lQSU91aG5PcTN1T3lkdUNEcXNyM3JvWnpzbDVEc2hKd2dLaXBDVWs5WFUwVlM2Nlc4SU9xeHRPdVRuT3Vtck91cHRDRHNsWWdnNjVDYzY0dWtLaW9nS0RJd01qWXRNRGdnN0l1azdMaWhJREx0bW96cm9ad2c3Wm1WN0tDVktUb0tMeThnSUNCQ1VrOVhVMFZTNjZXOElPeUVwT3lnbGUyVm1PdXB0Q2pyZ3JUc21xbnNuYlFnNjZ5MDdKZUg3SjIwNjVPZ0xDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPMlZtT3VLbENCdWJ5MXZjT3lkdE95V3RPdVBoQ2tnWTJ4aGRXUmxJRU5NU2Vxd2dDRHJ1SXpybmJ6c21yRHNvSUFnN1pXNDY1T2M3SmlrN1pTRTY2VzhDaTh2SUNBZzdZK3M2cml3N1pXWTZyT2dJQ29xSXV5ZHVPeW1uU0RzdlpUcms1enJwYndnUTJ4aGRXUmxJRU52WkdYcw0KbDVBZzY3YVo3SmVzNjRTajdKeTg3SVM0N0pxVUlpRHJzS25zaTUzc25MenJvWndnNjdDVTY0Q1E2NHVrS2lvdUlPdUxwT3Vtck91S2xDRHJvWnpxdDdqc25iZ2c3WlNFNjZHYzdJUzQ3SXFrNjZXOENpOHZJQ0FnN0lpbzZyS283SVNjSUhOMFpHbHVJT3lYaHV5ZHRDRHJuWVRzbXJEcnI0RHJvWndnNjdhWjdKZXM2NFNqN0oyRUlPcXpzK3lkdENEc2w0YnNsclFnNjZHYzZyZTQ3SjI0N0oyMElPeVZoT3lZaUNEcnRvanFzSURyaXFYdGxiVHNwNFRyaTZRdUNpOHZJQ0FnS0d4dlkyRnNhRzl6ZENCTVNWTlVSVTdzbmJRZzY1YWdJT3llaU91S2xDRHFzb1BycDR3ZzY3TzA2ck9nSU95ZWtPdVBtU0RzaUpqcm9MbnNuYlFnN0p5ZzdLZUE2NUNjNjR1azZyT2dJTzJNa091THFPMldpT3VObUNEcXNvd2c3SmlrN0tlRTdKMjA3SmVJNjR1a0xpa0tMeThnSUNEaWhwSWc2cmU0NjU2WTdJU2NJQ0x0ZzYwZ01lcXduQ0FySU9xemhPeWdsU0RzaEtEdGc1MGc3Wm1VNjZtMEl1eWRnQ0RzbmJRZ1EweEo2NkdjSU91MmlPcXcNCmdPdUtwZTJWbU91THBEb2c3WldjSU8yRHJleWN2T3VobkNEc25vZnNucERycWJRZ1EweEo3SjJZSU95WHRPcTRzT3VsdkNEcnA0bnNsWVRzbGJ3S0x5OGdJQ0R0bFpqcXM2QXNJT3VuaWV5Y3ZPdXB0Q0RzdlpUcms1d2c2N2FaN0plczY0U2o2cml3NnJDQUlPdVFuT3VMcEM0ZzY2R2M2cmU0N0pXRTdKdUQ3SjJFSU91VXNPdWhuQ0RzbDdUcnFiUWc3WU90N0oyMElETHFzSnpxc0lBZzY1Q2M2NHVrTGdvdkx5QWdJT3F5c091aG9DanNncXpzbXFuc25wQWc2ckt3N0tDVktUb2dLaXJ0ZzYwZ01lcXduQ0FySU95S3VleWR1Q0R0bVpUcnFiUXFLdXlkaENEc2s3RHFzNkFzSU9xemhPeWdsU0Rzb0lUdG1aanNuWUFnNnJlNElPMlpsT3VwdE95ZG1DQmI2ck9FN0tDVklPeWdoTzJabUYwZzY3S0U3WXE4N0p5ODY2R2NJTzJWbk91THBDNEtMeThnSUNEc2dxM3NvSnpya0p3ZzdJdWM2NCtFNjVPa09pQjNjbWwwWlU1dmIzQkNjbTkzYzJWeUlDOGdiM0JsYmxWeWJFbHVSR1ZtWVhWc2RFSnliM2R6WlhJZ0x5QmlkV2xzDQpaRXh2WjI5MWRFTm9ZV2x1VlhKc0lDanJzN1hxdGF6cmlwUWdaMmwwSU8yZWlPeUtwTzJHb091bXJDa3VDaTh2SU9LVWdPS1VnQ0Ryb1p6cXQ3anNuYmpzbllBZ1EweEo2ckNBSU9xNHNPdXp1Q0RydUl6cm5ienNtckRzb0lEcnBid2c3S2VCN0tDUklPeVh0T3F5akNEdGxaenJpNlFnS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRNd0tTRGlsSURpbElBS0x5OGc3SnF3NjZhczZyQ0FJRUpTVDFkVFJWTHJwYndnNnJDQTY2R2M3TEdFNnJHdzY0S1lJT3l3dmV5ZGhDRHFzNmpybmJ3ZzdKZXM2NHFVSU95TG5PdVBoT3VLbENBcUt1eWdoT3UyZ0NEc2k2VHRqS2p0bGJUc2hKd2c2NUNZNjQrTTY2QzQ2NHVrS2lvdUlPdUNxT3E0dENEcXRaRHRtNGc2Q2k4dklDQWc0cEdnSUVKU1QxZFRSVklnN1pXNDY1T2s2NStzNjZHY0lGVlNUT3lkaENEcnNKdnNuTHpycWJRZ1kyMWs2ckNBSUdBbVlPeVhrT3lFbkNEc25wanJuYnpycUxucmlwVHJpNlFnNG9hU0lHTnNhV1Z1ZEY5cFpDRHNob3pzaTZRb0l1eWVtT3VxdSt1UQ0KbkNCUFFYVjBhQ0RzbXBUc3NxMGlLUzRLTHk4Z0lDRGlrYUVnUWxKUFYxTkZVdXVsdkNCdWJ5MXZjT3ljdk91aG5DRHJwNG5xczZBZ2MzUmtiM1YwN0oyWUlGVlNUT3lkaENEc21yRHJwcXpxc0lBZzdKZTA2Nm0wSUNvcTdJcTU3SjI0SU91U3BDRHNuYmpzcHAzc3ZaVHJrNXpycGJ3ZzY3YVo3SmVzNjRTajdKeTg2NTI4NjRxVUlPMlpsT3VwdENvcTdKMjBDaTh2SUNBZ0lDQWc2NXlzNjR1a0tPeUxwT3k0b1NEc2k2RHFzNkE2SUNMc25iVHJuN0FnNnJHd0lPeVhodXlYaU91S2xPdU5zQ0Rxc0pIc25wRHF1TEFnN0ptY0lPeURuZXF5cUNJcElPS0FsQ0RzbnBEcmo1a2c3SWlZNjZDNTdKMjBJT3E1cU95bmhPdUxwQzRLTHk4Z0lDRGlrYUlnN0l1YzdZR3M2NmEvSU95d3ZleWN2T3VobkNEc2w3VHJvS1RycWJRZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95YXNPdW1yT3F3Z0NEcXM2anJuYnpzbGJ3ZzdaVzA3SVNjSUNvcTZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPcXdnQ0RzbFlUcmk0d2c3WUdzNjZHc3dyZnMNCmw2UHNwNERxc0lBZzdKZTA2NmF3NjR1a0tpb0tMeThnSUNBZ0lDQW83SXVrN0xpaElPeUxvT3F6b0RvZ0l1eVpuQ0R0Z2F6cm9henNuTHpyb1p3ZzdKZTA2NkNrSWl3Z0l1cTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJvWndnN1pXWTY1Mjg2NHVJNnJtTUlpa3VJT3F5ak91THBPcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNnJDQUlPeUxuTzJCck91bXZ3b3ZMeUFnSUNBZ0lPeWR1T3lla091bHZDRHJyTFRzaTV6dGxaanJxYlFvN0lLODdJU3hJT3lkdU8yRXNPdUV0eURzaTZUc3VLRXBJT3lkdk91d21DRHNzTDNzbmJRZzY1YWdJT3lLdWV5ZHVDRHRtWlRycWJUc25iUWc2cmU0NjR5QTY2R2M2NHVrTGdvdkx5RHF0N2pybnBqc2hKd2dLaXBDVWs5WFUwVlM2Nlc4SU9xeHRPdVRuT3Vtck95bmdDRHNsWXJyaXBUcmk2UXFLaURpZ0pRZ1kyeGhkV1JsSUVOTVNlcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNjZXOElPeVh0T3F6b0NCc2IyTmhiR2h2YzNUcm9ad2c2ckt3NnJPODY2VzhJT3llDQprT3VQbVFvdkx5RHNpSmpyb0xudGxaenJpNlFvN0wyVTY1T2NJT3UybWV5WHJPdUVvK3E0c0NEc2w0YnNuWXdwTGlEcXM0VHNvSlVnN0tDRTdabVk3SjJBSU95S3VleWR1Q0R0bVpUcnFiUWc3WldZNjR1b0lGdnFzNFRzb0pVZzdLQ0U3Wm1ZWFNEcnNvVHRpcnpzbkx6cm9ad2c3WldjNjR1a0xnb3ZMeUFxS3V5ZHRDRHFzcjNyb1p6c2w1QWdWVkpNSU9xd2dPcXp0Y0szN0tTUjZyQ0VJT3lLcE8yQnJPdW12ZTJLdU1LMzY3aU02NTI4N0pxdzdLQ0FJT3luZ095Z2xleWRoQ0RyaTZUc2k1d2c2NFNqN0tlQUlPdW5rQ0Rxc29NdUtpb0tDaTh2SU9LVWdPS1VnQ0JDVWs5WFUwVlNJT3F3Z091aG5PeXhoT3E0c091S2xDRHNvSnpxc2JEcmtKRHJpNlFnS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRJMUtTRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SmlJN0tDRTdKZVVJRUpTVDFkVFJWSWc3Wm1ZNnJLOTY3T0E3SWlZN0plUUlPeWVoT3lMbkNEcw0KaXFUdGdhenJwcjN0aXJqcnBid2c2cjJDN0pXRUlFTk1TZXF3Z0NEc3BJQWdZWFYwYUc5eWFYcGxJRlZTVE95ZGhDRHNtckRycHF6cXNJQWc2N0NiN0pXRTdJU2NJT3lYdE95WGlPdUxwQzRLTHk4ZzY2cXA3S0NCN0oyQUlPMlZtT3VDbU91L2tPeWR0T3lYaU91THBDRGlnSlFnNnJPRTdLQ1ZJT3lnaE8yWm1PeWFxZXljdk91aG5DQlZVa3pzbllRZ1kyeGhkV1JsTG1GcEwyeHZaMjkxZEQ5eVpYUjFjbTVVYnozaWdLYnJvWndnN0o2czdKNlI3SVN4N1pXMENpOHZJT3lLdWV5ZHVDRHRtWlRycWJUc25ZUWc2ckcwNjRTSTY1dXc2ck9nSU9xemhPeWdsU0RzaEtEdGc1MGc3Wm1VNjZtMDdKZVFJT3luZ2UyV2lleUxuTzJDcE9xNHNDNGc2cmU0SU95ZXJPeWVrZXlFc2V5ZGhDRHRqNURxdUxEdGxaanNucEFvN0lLczdKcXA3SjZRSU9xeXNPeWdsU2tnN1pXNDY1T2s2NStzNjRxVUNpOHZJT3VxcWV5Z2dleWR0Q0RzbDRic2xyVHNvWXpxczZBc0lDb3E2NEtvNnJLb0lPdVJrT3VwdENEc21LVHRub2pyb0tRZzY2R2MNCjZyZTQ3SjI0N0oyRUlPdW5uZXF3Z091Y3FPdW1zT3VMcENvcU9nb3ZMeUFnSUVOTVNlcXdnQ0JWVWt6c25ZUWc2NVN3N0ppMDdaR2NJT3lYaHV5ZHRDRHJoSmpxdUxEcnFiUWdZMjFrNnJDQUlHQW1ZT3lYa095RW5DQlZVa3pzbllRZzdKNlk2NTI4SU91eWhPdWdwQ2pzbklqcmo0VHNtckFwSUdOc2FXVnVkRjlwWkNEcXNKbnNuWUFnNjVLazdLcTlDaTh2SUNBZzY2ZWs2ckNjNjdPQTdJaVk2ckNBSU95Q3JPdWR2T3luZ09xem9Dd2c2N2lNNjUyODdKcXc3S0NBN0plVUlDTHNucGpycXJ2cmtKd2dUMEYxZEdnZzdKcVU3TEt0SU1LM0lHTnNhV1Z1ZEY5cFpDRHJwNlRxc0p6cnM0RHNpSmpxc0lBZzY0aUU2NTI5NjVDWTdKZUk3SXExNjR1STY0dWtJdXF3Z0NEcm5LenJpNlF1Q2k4dklDQWc3SXVzN1pXWTY2bTBJT3U0ak91ZHZPeWFzT3lnZ09xd2dDRHNsWVRzbUlnZzdKV0lJT3lYdE91bXNPdUxwQ2pzaTZUc3VLRWdNakF5Tmkwd09Eb2dRMHhKSU8yVWhPdWhuT3lFdU95S3BPdUtsQ0RyaklEcXVMQWc3S1NSDQo3SjI0NjQyd0lPeXd2ZXlkdENEc2xZZ2c2NXk0S1M0S0x5OGc3SjIwN0tDY0lFSlNUMWRUUlZMcnBid2c2ckcwNjVPYzY2YXM3S2VBSU95Vml1dUtsT3VMcENEaWhwSWdZMnhoZFdSbElFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN0RyaTZRb1EweEpJT3E0c091enVDRHJqNW5zbnBFcExnb3ZMeUFxS3V5ZHRDRHFzcjNyb1p6c2w1QWdWVkpNSU9xd2dPcXp0Y0szN0tTUjZyQ0VJT3lLcE8yQnJPdW12ZTJLdU91bHZDRHJpNlRzaTV3ZzY0U2o3S2VBSU91bmtDRHFzb011S2lvZzZyT0U3S0NWSU95Z2hPMlptT3lkZ0NEc2lybnNuYmdnN1ptVTY2bTBJTzJWbU91THFDQmI2ck9FN0tDVklPeWdoTzJabUYwZzY3S0U3WXE4N0p5ODY2R2NMZ29LTHk4ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1Q0R0bElUcm9aenNoTGpzaXFRZ0tHTnNZWFZrWlNCaGRYUm9JR3h2WjJsdUlDMHRZMnhoZFdSbFlXa3BJT0tBbENBdmIzQmxiaTFzYjJkcGJ1eWR0Q0RzZzUzcw0KaExIQ3QrcTBnT3VtckM0S0x5OGc2N2lNNjUyODdKcXc3S0NBNnJDQUlHeHZZMkZzYUc5emRPdWhuQ0Rxc3JEcXM3enJwYndnNjdPMDY0SzA3S1NFSU91VmpPcTVqT3luZ0NEc2lLanNsclRzaEp3ZzY0eUE2cml3N1pXWTY0dWs2ckNBTENEc21ZVHJvNHpya0pqcnFiUWc3SXFrN0lxazY2R2NJT3VCbmV1Q25PdUxwQzRLYkdWMElHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0NteGxkQ0JzYjJkcGJsQnliMk5VYVcxbGNpQTlJRzUxYkd3N0NteGxkQ0JzYjJkcGJsTjBZWEowWldSQmRDQTlJREE3SUM4dklPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN0l1YzdKNlJJT3lMbk9xd2dTRGlnSlFnN0o2czdZRzA2NmF0N0oyMElDZnNucXpzaTV6cmo0UW43SjI0N0tlQUlDZnNucERyajVuc21ZVHJvNHdnN0l1azdZeW9KK3lkdU95bmdDRHF0YXpydG9UdGxaenJpNlFLTHk4ZzdKMjA2N0tJSU91aG5PcTN1T3lkdU95WGtPeUVuQ0RydUl6cm5ienNtckRzb0lBZzdMQzk3SjJFSU95THBPeWduT3VobkNEcm5ZVHMNCm02RHJpcFRxc0lBZzRvQ1VJTzJFc091dnVPdUVrQ0R0ajdUcnNMSHNuWUFnN0oyMDZyS01JR1poYkhObDdKMjhJT3VWak91bmpDRHNrN1RyaTZRS0x5OGdLT3lMbk9xd2hPdW5qT3ljdk91aG5DRHRqSkRyaTZqdGxaanJxYlFnN0tDVjdJT0JJT3llck8yQnRPdW1yZXlYa091UGhDQmpiV1FnN0xDOTdKMjBJTzJLZ095V3RPdUNtT3lZcU91THBDa0tiR1YwSUd4dloybHVWMmx1Wkc5M1QzQmxibVZrSUQwZ1ptRnNjMlU3Q21aMWJtTjBhVzl1SUd0cGJHeE1iMmRwYmxCeWIyTW9LU0I3Q2lBZ2FXWWdLR3h2WjJsdVVISnZZMVJwYldWeUtTQjdJR05zWldGeVZHbHRaVzkxZENoc2IyZHBibEJ5YjJOVWFXMWxjaWs3SUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc2dmUW9nSUdsbUlDZ2hiRzluYVc1UWNtOWpLU0J5WlhSMWNtNDdDaUFnWTI5dWMzUWdjQ0E5SUd4dloybHVVSEp2WXpzS0lDQnNiMmRwYmxCeWIyTWdQU0J1ZFd4c093b2dJSFJ5ZVNCN0NpQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5DQpiU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNCemNHRjNibE41Ym1Nb0ozUmhjMnRyYVd4c0p5d2dXeWN2VUVsRUp5d2dVM1J5YVc1bktIQXVjR2xrS1N3Z0p5OVVKeXdnSnk5R0oxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3dvZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ2RISjVJSHNnY0hKdlkyVnpjeTVyYVd4c0tDMXdMbkJwWkN3Z0oxTkpSMVJGVWswbktUc2dmU0JqWVhSamFDQW9YMlV5S1NCN0lIQXVhMmxzYkNncE95QjlDaUFnSUNCOUNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c2NnkwN0l1Y0lDb3ZJSDBLZlFvS0x5OGc3WVMwSU91UGhPeWtrU0R0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lqdmV5WGlPeWRoQ0RybFl6c25aZ2c3SXVrN1l5b0lPdXBsT3lMbk95bmdDRGlnSlFnY25WdVZIVnlidXlkdENEc25iUWc2Nm1VN0l1YzdLZUE3SjI4SU91VmpPdW5qQ0F4N1pxTUlPeWVrT3VQbVNEc25xenNpNXpyajRUdGxaenJpNlFLWTI5dWMzUWdVMFZUVTBsUA0KVGw5RVNVVkVJRDBnSisyQnRPdWhuT3VUbkNEc2hManNoWmpzbmJRZzdLS0Y2Nk9NNjVDUTdKYTA3SnFVTGljN0NteGxkQ0J6YUhWMGRHbHVaMFJ2ZDI0Z1BTQm1ZV3h6WlRzZ0x5OGdMM05vZFhSa2IzZHVJT3luaE8yV2lTRHNwSkVnNG9DVUlPeWVyT3lMbk91UGhPdWhuQ0RzaExqc2haanNuWVFnNjVDWTdJSzA2NmFzN0tlQUlPeVZpdXF5akNEdGtaenNpNXdLQ2k4dklISmxZWE52YnV5ZGhDRHNvN3pycWJRZ0oreWRtT3VQaE95Z2dTRHNvb1hybzR3bktPcXpoT3lnbFNEc29JVHRtWmpDdCt1aG5PcTN1T3lWaE95Ymd5RHJrN0VwSU9LQWxDRHNwNFR0bG9rZzdLU1I3SjIwNjQyWUlPMkV0T3lkaENEcXQ3Z2c2Nm1VN0l1YzdLZUE2NkdjSU91Qm5ldUN0T3lFbkFvdkx5QnlkVzVVZFhKdTdKMllJRk5GVTFOSlQwNWZSRWxGUkNEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURzbnBEcXNxbnNwcDNycW9Yc25MenJvWndnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtck95bmdDRHNsWXJxc293ZzdaV2MNCjY0dWtMZ292THlBbzdKV0lJT3EzdU91ZnJPdXB0Q0RxczRUc29KVWc3S0NFN1ptWUlPeW5nZTJiaENEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZHRDRHJ0b0R0bVp6dGxiUWdUVUZZWDFSVlVrNVQ2cm1NN0tlQUlPcXpoT3lHalNEc2s3RHNuYlRyaXBRZzY3S0U2cmU0SU9LQWxDQXlNREkyTFRBM0lPdW1yT3Uzc095WGtPeUVuQ0R0bVpYc25iZ3BDbVoxYm1OMGFXOXVJR3RwYkd4UWNtOWpLSEpsWVhOdmJpa2dld29nSUdsbUlDaHdjbTlqS1NCN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdJQ0FnSUM4dklITm9aV3hzT25SeWRXWHJvWndnNjUyRTdKdU03SVNjSUhCeWIyUHNuWUFnWTIxa0lPcTdqZXVOc09xNHNDRGlnSlFnTDFUcm9ad2c3WXE0NjZhczdLZTRJT3lqdmV5WHJPeVZ2Q0RzcDRUc3A1d2dZMnhoZFdSbDZyQ0FJT3F6b095VmhPdWhuQ0RzbFlnZzY0S282NHFVNjR1a0NpQWdJQ0FnSUNBZ0x5OGdLT3F6DQpvT3lWaENCamJHRjFaR1hxc0lBZzdJU2s3TG1ZSU8yTWpPeWR2T3lkaENEcnJMenFzNkFnN0o2STdKeTg2Nm0wSU8yQnRPdWhuT3VUbkNEc2xiRWc3SmVGNjQydzdKMjA3WXE0NnJDQUlDTHNncXpzbXFrZzdLU1JJdXljdk91aG5DRHJwNG50bnBncENpQWdJQ0FnSUNBZ2MzQmhkMjVUZVc1aktDZDBZWE5yYTJsc2JDY3NJRnNuTDFCSlJDY3NJRk4wY21sdVp5aHdjbTlqTG5CcFpDa3NJQ2N2VkNjc0lDY3ZSaWRkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnlCOUtUc0tJQ0FnSUNBZ2ZTQmxiSE5sSUhzS0lDQWdJQ0FnSUNBdkx5QnRZV05QVXkvcnBxenJpSVhzaXFRNklITm9aV3hzT25SeWRXWHJuYndnY0hKdlkreWR0Q0J6YUNEcXU0M3JqYkRxdUxEc25id2c3SWlZSU95ZWlPeWRqQ0RpZ0pRZ2MzUmhjblJRY205ajdKMllJR1JsZEdGamFHVms2NkdjSU91bmpPdVRvQW9nSUNBZ0lDQWdJQzh2SU8yVWhPdWhuT3lFdU95S3BDRHF0N2pybzdrb0xYQnBaQ25zbllRZzdZYTE3S2U0NjZHY0lPeWdsZXVtck8yVg0Kbk91THBDQW9kR0Z6YTJ0cGJHd2dMMVFnNjR5QTdKMlJLUW9nSUNBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0hKdll5NXdhV1FzSUNkVFNVZFVSVkpOSnlrN0lIMGdZMkYwWTJnZ0tGOWxNaWtnZXlCd2NtOWpMbXRwYkd3b0tUc2dmUW9nSUNBZ0lDQjlDaUFnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRb2dJSDBLSUNCd2NtOWpJRDBnYm5Wc2JEc0tJQ0IzWVhKdFpXUlZjQ0E5SUdaaGJITmxPd29nSUdsbUlDaDNZV2wwWlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0hkaGFYUmxjaTUwYVcxbGNpazdJSGRoYVhSbGNpNXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtISmxZWE52YmlCOGZDQlRSVk5UU1U5T1gwUkpSVVFwS1RzZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnZlFwOUNncG1kVzVqZEdsdmJpQnpkR0Z5ZEZCeWIyTW9LU0I3Q2lBZ2EybHNiRkJ5YjJNb0tUc0tJQ0JzYVc1bFFuVm1JRDBnSnljN0NpQWdkSFZ5Ym5NZ1BTQXdPd29nSUM4dklPeWR0Q0RzaExqc2haanMNCm5iUWc3SmEwNjRxUUlPcXpoT3lnbGV5ZG1DRHNub1hzbnFYcXRvenNuTHpyb1p3ZzY0K0U2NHFVN0tlQUlPcTRzT3VoblNEaWdKUWc2N0NXN0plUTdJU2NJT3F6aE95Z2xleWR0Q0Ryc0pUcmdJenNsNGpyaXBUc3A0QWc2N21FNnJXUTdaV1k2NHFVSU9xNHNPeWtnQW9nSUhObGMzTnBiMjVCWTJOdmRXNTBJRDBnWTJ4aGRXUmxRV05qYjNWdWRDZ3BPd29nSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c3SVM0N0lXWUlPeUxuT3VQbVNEc3BKSGlnS1lnS091cXFPdU51RG9nSnlBcklHTjFjbkpsYm5STmIyUmxiQ0FySUNjcEp5azdDaUFnWTI5dWMzUWdkR2hwYzFCeWIyTWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0Y0Njc0lDY3RMVzF2WkdWc0p5d2dZM1Z5Y21WdWRFMXZaR1ZzTENBbkxTMXBibkIxZEMxbWIzSnRZWFFuTENBbmMzUnlaV0Z0TFdwemIyNG5MQ0FuTFMxdmRYUndkWFF0Wm05eWJXRjBKeXdnSjNOMGNtVmhiUzFxYzI5dUp5d2dKeTB0ZG1WeVltOXpaU2RkDQpMQ0I3Q2lBZ0lDQnphR1ZzYkRvZ2RISjFaU3dnWTNka09pQkZUVkJVV1Y5RFYwUXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd0tJQ0FnSUdSbGRHRmphR1ZrT2lCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUNFOVBTQW5kMmx1TXpJbkxDQXZMeUJRVDFOSldEb2c3SjZRNnJpd0lPMlVoT3Vobk95RXVPeUtwQ0RxdDdqcm83a2c3SU9kN0lTeElPS0FsQ0JyYVd4c1VISnZZK3lkdENEcXQ3anJvN25zcDdnZzdLQ1Y2NmFzN1pXZ0lPeUltQ0Rzbm9qcXNvd0tJQ0I5S1RzS0lDQndjbTlqSUQwZ2RHaHBjMUJ5YjJNN0NpQWdjSEp2WXk1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXdvZ0lDQWdiR2x1WlVKMVppQXJQU0JrTG5SdlUzUnlhVzVuS0NkMWRHWTRKeWs3Q2lBZ0lDQnNaWFFnYVdSNE93b2dJQ0FnZDJocGJHVWdLQ2hwWkhnZ1BTQnNhVzVsUW5WbUxtbHVaR1Y0VDJZb0oxeHVKeWtwSUNFOVBTQXRNU2tnZXdvZ0lDQWdJQ0JqYjI1emRDQnNhVzVsSUQwZ2JHbHVaVUoxWmk1emJHbGpaU2d3TENCcA0KWkhncExuUnlhVzBvS1RzS0lDQWdJQ0FnYkdsdVpVSjFaaUE5SUd4cGJtVkNkV1l1YzJ4cFkyVW9hV1I0SUNzZ01TazdDaUFnSUNBZ0lHbG1JQ2doYkdsdVpTa2dZMjl1ZEdsdWRXVTdDaUFnSUNBZ0lHeGxkQ0JsZGlBOUlHNTFiR3c3Q2lBZ0lDQWdJSFJ5ZVNCN0lHVjJJRDBnU2xOUFRpNXdZWEp6WlNoc2FXNWxLVHNnZlNCallYUmphQ0FvWDJVcElIc2dZMjl1ZEdsdWRXVTdJSDBLSUNBZ0lDQWdhV1lnS0dWMklDWW1JR1YyTG5SNWNHVWdQVDA5SUNkeVpYTjFiSFFuSUNZbUlIZGhhWFJsY2lrZ2V3b2dJQ0FnSUNBZ0lHTnZibk4wSUhjZ1BTQjNZV2wwWlhJN0NpQWdJQ0FnSUNBZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNLSUNBZ0lDQWdJQ0JqYkdWaGNsUnBiV1Z2ZFhRb2R5NTBhVzFsY2lrN0NpQWdJQ0FnSUNBZ2FXWWdLR1YyTG1selgyVnljbTl5S1NCN0NpQWdJQ0FnSUNBZ0lDQmpiMjV6ZENCeVlYY2dQU0JUZEhKcGJtY29aWFl1Y21WemRXeDBJSHg4SUdWMkxuTjFZblI1Y0dVZ2ZId2dKeWNwTG5Oc2FXTmwNCktEQXNJREl3TUNrN0NpQWdJQ0FnSUNBZ0lDQXZMeUR0bFp6cmo0UWc3TFNJNnJPODY2VzhJT3Vvdk95Z2dDRHJzN2pyaTZRZzRvQ1VJT3Vobk9xM3VPeWR1Q0RzbUtUcnBaZ2c3S0NWNnJlYzdJdWQ3SjIwSU91RWsreVd0T3lFbkNoc2IyY2dQMmx1SU91VHNTa2c2Nnk0NnJXczZyQ0FJT3V3bE91QWpPdXB0Q0RzZ3J6dGdxd2c3SWlZSU95ZWlPdUxwQW9nSUNBZ0lDQWdJQ0FnYVdZZ0tHbHpUR2x0YVhSRmNuSnZjaWh5WVhjcEtTQjdDaUFnSUNBZ0lDQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiR2x0YVhRbk95QXZMeUF2YUdWaGJIUm82NkdjSU95VmpPdW12Q0RpaHBJZzY3S0U3WXE4N0oyMElGdnRsWnpyajRRZzdMU0k2ck84WGV1aG5DRHJzSlRyZ0l6cXM2QWc2ck9FN0tDVklPeWdoTzJabU95ZGhDRHNsWWpyZ3JRS0lDQWdJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yQnRPdWhuT3VUbkNEc2dxenNtcWtnN1pXYzY0K0VJT3kwaU9xenZDRHFzSkRzDQpwNEE2Snl3Z2NtRjNLVHNLSUNBZ0lDQWdJQ0FnSUNBZ2R5NXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtFeEpUVWxVWDBkVlNVUkZLU2s3Q2lBZ0lDQWdJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tHbHpRWFYwYUVWeWNtOXlLSEpoZHlrcElIc0tJQ0FnSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMk5zWVhWa1pTMXNiMmR2ZFhRbk95QXZMeUF2YUdWaGJIUm82NkdjSU8yVWpPdWZyT3EzdU95ZHVPeVhrQ0RzbFl6cnByd2c0b2FTSU91eWhPMkt2T3lkdENCYjY2R2M2cmU0N0oyNElPMlZoT3lhbEYzcm9ad2c2N0NVNjRDY0NpQWdJQ0FnSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0oyNElPdW5qT3VqakNEcXNKRHNwNEE2Snl3Z2NtRjNLVHNLSUNBZ0lDQWdJQ0FnSUNBZ2R5NXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtFeFBSMGxPWDBkVlNVUkZLU2s3Q2lBZ0lDQWdJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1Wag0KZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNtS1RycFpnNklDY2dLeUJ5WVhjcEtUc0tJQ0FnSUNBZ0lDQWdJSDBLSUNBZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMjlySnpzZ0x5OGc3SVN4NnJPMUlEMGc3SVNrN0xtWXdyZnJvWnpxdDdqc25iZ2c2NHVrSU95Z2xleURnU0RpZ0pRZzdKYTA2NWFrSUhCeWIySnNaVzNzbmJUcms2QWc3WlcwN0tDY0lDanNucXpyb1p6cXQ3anNuYmd2N0o2czdJU2s3TG1ZSU91enRlcTNnQ2tLSUNBZ0lDQWdJQ0FnSUhjdWNtVnpiMngyWlNoVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElDY25LU2s3Q2lBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0I5Q2lBZ0lDQjlDaUFnZlNrN0NpQWdjSEp2WXk1emRHUmxjbkl1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ2N5QTlJR1F1ZEc5VGRISnBibWNvSjNWMFpqZ25LUzUwY21sdEtDazdDaUFnSUNCcFppQW9jeUFtSmlBaGN5NXBibU5zZFdSbGN5Z24NClJHVndjbVZqWVhScGIyNVhZWEp1YVc1bkp5a3BJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCamJHRjFaR1VnYzNSa1pYSnlPaWNzSUhNdWMyeHBZMlVvTUN3Z01qQXdLU2s3Q2lBZ2ZTazdDaUFnY0hKdll5NXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdMeThnN0oyMDY2KzRJT3lEaUNEc2hManNoWmpzbkx6cm9ad2c2cldRN0xLMDY1Q2NJT3VTcENEc21Kc2c3SVM0N0lXWTdKMjBJT3VMcSsyZWpDRHFzYkRycWJRZzY2eTA3SXVjSUNqcnFxanJqYmdnN0tDRTdabVlJT3lMbkNEc2c0Z2c3SVM0N0lXWTdKMkVJT3lqdmV5ZHRPeW5nQ0RzbFlycXNvd3BDaUFnSUNCcFppQW9jSEp2WXlBaFBUMGdkR2hwYzFCeWIyTXBJSEpsZEhWeWJqc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c3SVM0N0lXWUlPeWloZXVqakNBb1kyOWtaU0FuSUNzZ1kyOWtaU0FySUNjcElPS0FsQ0RyaTZUc25Zd2c3SnFVN0xLdElPdVZqQ0RyaTZUc2k1d2c3SXVjDQo2NCtaN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnYTJsc2JGQnliMk1vS1RzS0lDQjlLVHNLZlFvS1puVnVZM1JwYjI0Z2MyVnVaRlIxY200b2RHVjRkQ2tnZXdvZ0lISmxkSFZ5YmlCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpTd2djbVZxWldOMEtTQTlQaUI3Q2lBZ0lDQnBaaUFvSVhCeWIyTXBJSEpsZEhWeWJpQnlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lYaHV5V3RPeWFsQzRuS1NrN0NpQWdJQ0JwWmlBb2QyRnBkR1Z5S1NCeVpYUjFjbTRnY21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN0pXZTdJU2dJT3lhbE95eXJleWR0Q0RzcDRUdGxva2c3S1NSN0oyMDdKZVE3SnFVTGljcEtUc0tJQ0FnSUdOdmJuTjBJSFJwYldWeUlEMGdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0aExRZzdJdWM2ckNFSU95MGlPcXp2Q0RpZ0pRZzdJUzQ3SVdZN0oyRUlPeWVyT3lMbk95ZWtlMlZxZXVMaU91TA0KcEM0bktUc0tJQ0FnSUNBZ0x5OGc3SXVjNnJDRUlPeTBpT3F6dk91S2xDQW43SVM0N0lXWUlPeWloZXVqakNmc21ZQWc2cldzNjdhRTY1Q1k2NHFVSU95Z25DRHJxWlRzaTV6c3A0RHJvWndnNjRHZDY0SzQ2NHVrSU9LQWxDQnJhV3hzVUhKdlkreWRtQ0RzaExqc2haZ2c3S0tGNjZPTUlISmxhbVZqZE9xd2dBb2dJQ0FnSUNBdkx5QnlkVzVVZFhKdTdKMllJT3lla091UG1TRHNucXpzaTV6cmo0VHJwYndnNjdhQTY2VzA2Nm0wSU95VmlDRHJrSmpxdUxBZzY1V002Nnk0S091S2tPdW1zQ0R0aExUc25ZUWc2NUdRSU91eWlDRHJqNHpycWJRZzdaU002NStzNnJlNDdKMjRJREV6TU95MGlDRHNvSnp0bFp6c25ZUWc2NFNZNnJpMDY0dWtLUW9nSUNBZ0lDQnBaaUFvZDJGcGRHVnlLU0I3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdkeUE5SUhkaGFYUmxjanNnZDJGcGRHVnlJRDBnYm5Wc2JEc0tJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9KKzJCdE91aG5PdVRuQ0RzblpIcmk3WHNuYlFnNjRTSTY2eTANCklPeVlwT3VlbUNEcXNianJvS1FnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQ0RpZ0pRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUp5a3BPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHdHBiR3hRY205aktDazdDaUFnSUNCOUxDQlVWVkpPWDFSSlRVVlBWVlJmVFZNcE93b2dJQ0FnZDJGcGRHVnlJRDBnZXlCeVpYTnZiSFpsTENCeVpXcGxZM1FzSUhScGJXVnlJSDA3Q2lBZ0lDQndjbTlqTG5OMFpHbHVMbmR5YVhSbEtFcFRUMDR1YzNSeWFXNW5hV1o1S0hzZ2RIbHdaVG9nSjNWelpYSW5MQ0J0WlhOellXZGxPaUI3SUhKdmJHVTZJQ2QxYzJWeUp5d2dZMjl1ZEdWdWREb2dkR1Y0ZENCOUlIMHBJQ3NnSjF4dUp5d2dKM1YwWmpnbktUc0tJQ0I5S1RzS2ZRb0tMeThnNnJDWjdKMkFJT3VzdU9xMXJPdWx2Q0RycW9jZzY3S0k3S2U0SU91c3UrdUtsT3luZ0NEcXVMRHNsclVnNG9DVUlPeWVyT3lhbE95eXJleWR0T3VwdENBaTdKMjA3S0NFNnJPOElPdUxwT3VsdUNEc2c0Z2c3S0NjDQo3SldJSXV5ZGhDRHNtcFRxdGF6dGxaenJpNlFLTHk4Z0tPeVZpQ0RxdDdqcm42enJxYlFnN1lHMDY2R2M2NU9jNnJDQUlPeUVzZXlMcE8yVm1PcXlqQ0Rxc0puc25ZQWc2NHUxN0oyRUlPdVlrQ0RyZ3JUc2hKd2dXMEZKSU95MmxPeXluQ0RyalpRZzY3Q2I2cml3WGVxd2dDRHJyTFRzblpqcnI3anRsYlRzcDRUcmk2UXBDbU52Ym5OMElHRnphMlZrUTI5MWJuUWdQU0J1WlhjZ1RXRndLQ2s3Q2dvdkx5RHNoTGpzaFpnZzdLU0E2N21FS095TG5PdVBtU3ZzcDREc2k1enJyTGdnN0tPODdKNkZLZXVsdkNEcnM3VHNucVh0bFp3ZzY1S2tJTzJWbkNEdGhMUWc3SXVrN1phSklPS0FsQ0RycXFqcms2QWc3Wmk0N0xhYzdKMkFJSEYxWlhWbDY2R2NJT3luZ2V1Z3JPMlpsQzRLTHk4Z2JXOWtaV3pzbllRZzdLTzg2Nm0wSU9xM3VDRHJxcWpyamJqcm9ad2dLT3VMcE91bHRPdXB0Q0RzaExqc2haZ2c3SjZzN0l1YzdKNlJLUzRnN1pXY0lPdXFxT3VOdU95ZGhDRHFzNFRzaG8wZzdKT3c2Nm0wSU95ZXJPeUxuT3lla2V5ZA0KZ0NEc3RaenN0SWdnTWUyYWpPdS9rQzRLTHk4Z2NtVndZWEp6WlQxN2NHRnljMlVzSUdadmNtMWhkRVJsYzJOOTY2VzhJT3lqdk91cHRDRHRqSXpzaTdIcXVZenNwNEFnN0oyMElPeWVvU0RzbFlqc2w1RHNoSndnN0xLWTY2YXM3WldZNnJPZ0lIdHlZWGNzSUhCaGNuTmxaSDNycGJ3ZzY0K002NkNrN0tTQTY0dWtPZ292THlEdG1KWHNpNTBnN0oyMDdZT0lJT3lMbkNEcXNKbnNuWUFnN0lTNDdJV1k3SmVRSUNMdG1KWHNpNTNyaklEcm9ad2c2NHVrN0l1Y0l1dWx2Q0RzbXBUcXRhenRsWmpyaXBRZzdKNnM3SnFVN0xLdElPMkV0T3lkaENBcUt1cXdtZXlkZ0NEdGdaQWc3SjZoSU95VmlPeVhrT3lFbkNvcUlPdTJtZXlkdU91THBDNEtMeThnNjdPRTY0K0VJT3llb2V5Y3ZPdWhuQ0RydWJ6cnFiUWdLR0VwSU95Q3JPeWR0T3lYa0NEcmk2VHJwYmdnN0pxVTdMS3RJTzJFdE95ZHRDRHJnYnpzbHJRZ0ordXdxZXE0aUNEcmk3VW43SjIwSU91Q3FPeWRtQ0RyaTdYc25iUWc2NUNZNnJPZ0tPdUN0T3lhcVNEc21LVHMNCmw3d3BMQW92THlBb1lpa2dUVUZZWDFSVlVrNVRJT3F5dmVxemhPeVhrT3lFbkNEc2hManNoWmpzbmJRZzdKNnM3SXVjN0o2UjY0KzhJQ2Zyc0tucXVJZ2c2NHUxSit5ZHRDRHNsNGJyaXBRZzdJT0lJT3lFdU95Rm1PeWR0Q0RyZ3JUc21xbnNuWVFnN0tlQTdKYTA2NEs4SU95SW1DRHNub2pyaTZRZ0tESXdNall0TURjZzY2YXM2N2V3N0plUTdJU2NJTzJabGV5ZHVDa3VDbU52Ym5OMElGSkZVRUZTVTBWZlFrRkVJRDBnS0hZcElEMCtJSFlnUFQwZ2JuVnNiQ0I4ZkNBb1FYSnlZWGt1YVhOQmNuSmhlU2gyS1NBbUppQjJMbXhsYm1kMGFDQTlQVDBnTUNrN0NtWjFibU4wYVc5dUlISjFibFIxY200b1luVnBiR1JCYzJzc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1NCN0NpQWdZMjl1YzNRZ2FtOWlJRDBnY1hWbGRXVXVkR2hsYmloaGMzbHVZeUFvS1NBOVBpQjdDaUFnSUNCamIyNXpkQ0JxYjJKVGRHRnlkQ0E5SUVSaGRHVXVibTkzS0NrN0lDOHZJT3lMbk9xd2hDRHNtSWpzZ3JBZzRvQ1VJTzJVak91ZnJPcTN1T3lkDQp1Q0RzcXIwZzdLQ2M3WldjS0RFek1PeTBpQ25zbllRZzY0U1k2cmk0SU95ZXJPeUxuT3VQaE91S2xDRHRqNnpxdUxEdGxaenJpNlFLSUNBZ0lHbG1JQ2h0YjJSbGJDQW1KaUJCVEV4UFYwVkVYMDFQUkVWTVV5NXBibVJsZUU5bUtHMXZaR1ZzS1NBaFBUMGdMVEVnSmlZZ2JXOWtaV3dnSVQwOUlHTjFjbkpsYm5STmIyUmxiQ2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2cW82NDI0SU91emdPcXl2VG9nSnlBcklHTjFjbkpsYm5STmIyUmxiQ0FySUNjZzRvYVNJQ2NnS3lCdGIyUmxiQ2s3Q2lBZ0lDQWdJR04xY25KbGJuUk5iMlJsYkNBOUlHMXZaR1ZzT3dvZ0lDQWdJQ0J6ZEdGeWRGQnliMk1vS1RzZ0x5OGc3SU9JSU91cXFPdU51T3VobkNEc2hManNoWmdnN0o2czdJdWM3SjZSSUNqcmk2VHNuWXdnN0p1TTY3Q043SmVGN0plUTdJU2NJT3luZ095TG5PdXN1Q0RzbnF6c283enNub1VwQ2lBZ0lDQjlDaUFnSUNCcFppQW9kSFZ5Ym5NZ1BqMGdUVUZZWDFSVlVrNVRJSHg4SUNGdw0KY205aktTQnpkR0Z5ZEZCeWIyTW9LVHNLSUNBZ0lHbG1JQ2doZDJGeWJXVmtWWEFwSUhzS0lDQWdJQ0FnWTI5dWMzUWdkREFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhwYm5OMGNuVmpkR2x2YmsxbGMzTmhaMlVvS1NrN0NpQWdJQ0FnSUhkaGNtMWxaRlZ3SUQwZ2RISjFaVHNLSUNBZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFdU95Rm1DRHNwSURydVlRZzdKbUU2Nk9NSUNnbklDc2dLQ2hFWVhSbExtNXZkeWdwSUMwZ2REQXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLU0FySUNkektTRGlnSlFnN0oyMDdadUVJT3lhbE95eXJleWRnQ0RydWFqcm5ienNtcFF1SnlrN0NpQWdJQ0I5Q2lBZ0lDQjBkWEp1Y3lzck93b2dJQ0FnWTI5dWMzUWdZWE5ySUQwZ1luVnBiR1JCYzJzb0tUc2dMeThnN0o2czdJdWM2NCtFSU91VmpDRHFzSm5zbllBZzdLZUk2Nnk0N0oyRUlPdUxwT3lMbkNEc2s3VHJpNlFnS0dGemEyVmsNClEyOTFiblFnN0oyMDdLU1JJT3ltbmVxd2dDRHJzS25zcDRBcENpQWdJQ0JzWlhRZ2NtRjNPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdjbUYzSUQwZ1lYZGhhWFFnYzJWdVpGUjFjbTRvWVhOcktUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUNBZ0x5OGc3WVMwSU91UGhPeWtrU0R0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lqdmV5ZGdDRHFzcjNzbXJBb1UwVlRVMGxQVGw5RVNVVkVLU0F4N1pxTUlPeWVrT3VQbVNEc25xenNpNXpyajRRZzRvQ1VJT3lDck95YXFleWVrT3lYa09xeWtDRHNpNlR0aktqcm9ad2c3SldJSU91enRPeWR0T3F5akM0S0lDQWdJQ0FnTHk4ZzdJdWM2ckNFSU95MGlPcXp2TUszNjZHYzZyZTQ3SjI0SU91bmpPdWpqTUszN1lHMDY2R2M2NU9jSU95WXBPdWxtTUszN0oyWTY0K0U3S0NCSU95aWhldWpqQ2pxczRUc29KVWc3S0NFN1ptWUwrdWhuT3EzdU95VmhPeWJneXdnYTJsc2JGQnliMk1vY21WaGMyOXVLU25yaXBRS0lDQWdJQ0FnTHk4ZzdLQ2NJT3VwDQpsT3lMbk95bmdPcXdnQ0RybExEcm9ad2c3SjZJN0phMElPeVhyT3E0c0NEc2xZZ2c2ckc0NjZhdzY0dWtMaURzb29Ycm80d2c3SnFVN0xLdElPeWtrZXlkdE9xeHNPdUNtQ0RzaTV6cXNJUWc3SmlJN0lLdzdKMjBJT3lXdk91bmlDRHNsWWdnNjRLbzdKV1k3Snk4NjZtMElPdVFtT3lDdE91bXJPeW5nQ0RzbFlycmlwVHJpNlF1Q2lBZ0lDQWdJR2xtSUNoemFIVjBkR2x1WjBSdmQyNGdmSHdnSVNobElDWW1JR1V1YldWemMyRm5aU0E5UFQwZ1UwVlRVMGxQVGw5RVNVVkVLU0I4ZkNCRVlYUmxMbTV2ZHlncElDMGdhbTlpVTNSaGNuUWdQaUEwTURBd01Da2dkR2h5YjNjZ1pUc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFdU95Rm1PeWR0Q0R0aExRZzY0K0U3S1NSSU91Qml1cTVnQ0RpZ0pRZzdKNnM3SXVjNjQrWklPMmJoQ0F4N1pxTUlPeWVyT3lMbk91UGhPMlZxZXVMaU91THBDNG5LVHNLSUNBZ0lDQWdjM1JoY25SUWNtOWpLQ2s3Q2lBZ0lDQWdJR0YzWVdsMElITmxibVJVZFhKdQ0KS0dsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncEtUc0tJQ0FnSUNBZ2QyRnliV1ZrVlhBZ1BTQjBjblZsT3dvZ0lDQWdJQ0IwZFhKdWN5QTlJREk3SUM4dklPeWJqT3V3amV5WGhTQXhJQ3NnN0oyMDY3S0lJTzJFdENBb2MzUmhjblJRY205ajdKMjBJRERzbkx6cm9ad2c3TFNJNnJpdzdabVVLUW9nSUNBZ0lDQnlZWGNnUFNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhoYzJzcE93b2dJQ0FnZlFvZ0lDQWdhV1lnS0NGeVpYQmhjbk5sS1NCeVpYUjFjbTRnY21GM093b2dJQ0FnYkdWMElIQmhjbk5sWkNBOUlISmxjR0Z5YzJVdWNHRnljMlVvY21GM0tUc0tJQ0FnSUM4dklPMllsZXlMblNEc25iVHRnNGpzbmJUcnFiUWc2ckNaN0oyQUlPeUV1T3lGbU1LMzZyQ1o3SjJBSU95ZW9leVhrT3lFbkNEcXM2ZnNucVVnN0o2czdKcVU3TEt0SU9LQWxDRHNuYlFnN1lTMDdKMjBJT3lqdmV5Y3ZPdXB0Q0RzZzRnZzdJUzQ3SVdZN0oyQUlDZnJzS25xdUlnZzY0dTFKK3lkaENEcnFyRHJuYndLSUNBZ0lDOHZJT3luZ095V3RPdUMNCnZDRHNpSmdnN0o2STdKeTg2NitBNjZHY0lPeUV1T3lGbUNEc2dxenJwNTBnN0o2czdJdWM2NCtFNjRxVUlPMlZtT3luZ0NEc2xZcnFzNkFnNnJlNDY0eUE2NkdjSU95THBPMk1xT3lMbk8yQ3FPdUxwQ2p0akl6c2k3RWc3SXVrN1l5bzY2R2NJT3EzZ09xeXNDa3VDaUFnSUNCcFppQW9Va1ZRUVZKVFJWOUNRVVFvY0dGeWMyVmtLU0FtSmlCRVlYUmxMbTV2ZHlncElDMGdhbTlpVTNSaGNuUWdQQ0EzTURBd01Da2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5TTdJdXhJT3lMcE8yTXFDRGlnSlFnN1ppVjdJdWRJT3llck95YWxPeXlyVG9uTENCVGRISnBibWNvY21GM0tTNXpiR2xqWlNnd0xDQXpNREFwS1RzS0lDQWdJQ0FnZEhWeWJuTXJLenNLSUNBZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnSUNCeVlYY2dQU0JoZDJGcGRDQnpaVzVrVkhWeWJpZ242N0NwNnJpSUlPdUx0ZXlkdENEc21wVHF0YXp0bFp3ZzdaaVY3SXVkN0plUUlPeVd0T3E0aSt1Q3JPdUxwQzRnNjdDcDZyaUlJT3VMDQp0ZTJWbkNEcmdyVHNtcW5zbllRZzdJU2s2NnFGd3Jmc2dxenFzN3pDdCt5OWxPdVRuTzJPbk95S3BDRHNsNGJzbmJRZzdKV0U2NTZZSUVwVFQwN3NuTHpyb1p6cnA0d2c2NHVrN0l1Y0lPeTJuT3VncGUyVm1PdWR2RG9nSnlBcklISmxjR0Z5YzJVdVptOXliV0YwUkdWell5azdDaUFnSUNBZ0lDQWdjR0Z5YzJWa0lEMGdjbVZ3WVhKelpTNXdZWEp6WlNoeVlYY3BPd29nSUNBZ0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNucXpzbXBUc3NxMGc3SXVrN1l5b0lPS0FsQ0RzbFlUcm5wanNsNURzaEp3ZzdZeU03SXV4SU95THBPMk1xT3VobkNEc3NwanJwcXdnS2k4Z2ZRb2dJQ0FnZlFvZ0lDQWdhV1lnS0ZKRlVFRlNVMFZmUWtGRUtIQmhjbk5sWkNrcElHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0akl6c2k3RWc3SXVrN1l5b0lDanNucXpzbXBUc3NxMGc3WnVFN0plUTY0K0VLVG9uTENCVGRISnBibWNvY21GM0tTNXpiR2xqWlNnd0xDQXpNREFwS1RzS0lDQWdJSEpsZEhWeWJpQjdJSEpoZHl3Zw0KY0dGeWMyVmtPaUJTUlZCQlVsTkZYMEpCUkNod1lYSnpaV1FwSUQ4Z2JuVnNiQ0E2SUhCaGNuTmxaQ0I5T3dvZ0lIMHBPd29nSUM4dklPMlZuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WlcwNjQrRUlPdUxwT3lkakNEc21wVHNzcTNzbmJRZzdKMjA3SmEwN0tlQTY0K0U2NkdkSU8yQmtPdUtsQ0R0bGEzc2c0RWc3SVN4NnJPMTdKeTg2NkdjSU95Z2xldW1yQW9nSUhGMVpYVmxJRDBnYW05aUxtTmhkR05vS0NncElEMCtJSHQ5S1RzS0lDQnlaWFIxY200Z2FtOWlPd3A5Q2dvdkx5RHJzb1R0aXJ3ZzY1Mjg2N0tvSU9xM25PeTVtU0RpZ0pRZzdaU002NStzNnJlNDdKMjQ3SjIwSUNmcnNvVHRpcnpzbllRZzZyT282NTZRNjR1a0orcXpvQ0RzbFl6cm9LVHNwSVFnNjVXTTY2ZU1JT3lXdWV1S2xPdUxwQzRLTHk4ZzY3S0U3WXE4SU91c3VPcTFyT3VLbENEcnJManNucVhzbmJRZzdKV0U2NHVJNjUyOElPdVBtZXlla1NEc25iVHJwb1RzbmJUc2xyVHNoSndzSU95ZHRDRHNwNERzaTV6cXNJQWc3SmVHN0p5ODY2bTANCklPdXN1T3llcGUyWWxTRHJqSURzbFlqc25iUWc3SVNlN0plc0lPdUNtT3lZcU91THBDNEtZMjl1YzNRZ1FsVlVWRTlPWDFKVlRFVWdQUW9nSUNmc25iUWc2Nnk0NnJXczY0cVVJQ29xNjdLRTdZcThJT3Vkdk91eXFDb3E3SjIwNjR1a0xpRHJyTGpzbnFYc25iUWc3SldFNjR1STY1MjhJT3VQbWV5ZWtTRHNuYlRycG9Uc25iVHJyNERyb1p3NklPdW5pT3k1cU8yUm5NSzM2Nnk4N0oyTTdaR2N3cmZzb29YcXNyRHNsclRycjdnb2Z1eWFsQzkrNjR1a0wzN3F1WXpzbXBRcElPcTRpT3luZ0N3Z0p5QXJDaUFnSit1UW1PdVBoT3VoblNEc3A2ZnNuWUFnNjQrWjdKNlJJT3VxaGV5Q3JDanNvSURzbnFYQ3QreUNyZXlnbk1LMzdKZXc2ckt3SU8yVnRPeWduQ0RyazdFcDY2R2NMQ0R0aHJYcnM3VHNoTEVnNjR1bzdKMjhJT3V5aE8yS3ZPeWR0T3VwdENBaTdabVY3SjI0SWk0Z0p5QXJDaUFnSnlMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ0RzazdEcXM2QXNJTzJaDQpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRnQ0RxdDdqcmpJRHJvWndnNjVHVTY0dWtMbHh1SnpzS0NpOHZJT3VzdU9xMXJDRHN0cFRzc3B3ZzdZUzBJQ2h5YjJ4bFBTZnJzb1R0aXJ3bjdKMjA2Nm0wSU91eWhPMkt2Q0RxdDV6c3VabnNuWVFnN0phNTY0cVU2NHVrS1FwbWRXNWpkR2x2YmlCaGMydERiR0YxWkdVb2RHVjRkQ3dnYlc5a1pXd3NJSEpsY0dGeWMyVXNJSEp2YkdVcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0NpQWdJQ0JqYjI1emRDQmhkSFJsYlhCMElEMGdLR0Z6YTJWa1EyOTFiblF1WjJWMEtIUmxlSFFwSUh4OElEQXBJQ3NnTVRzS0lDQWdJR0Z6YTJWa1EyOTFiblF1YzJWMEtIUmxlSFFzSUdGMGRHVnRjSFFwT3dvZ0lDQWdhV1lnS0dGemEyVmtRMjkxYm5RdWMybDZaU0ErSURJd01Da2dZWE5yWldSRGIzVnVkQzVqYkdWaGNpZ3BPeUF2THlEcnJMVHRsWnp0bm9nZzdJeVQ3SjIwN0tlQUlPeVZpdXF5akFvZ0lDQWdZMjl1YzNRZw0KY25Wc1pTQTlJSEp2YkdVZ1BUMDlJQ2Zyc29UdGlyd25JRDhnUWxWVVZFOU9YMUpWVEVVZ09pQW5KenNLSUNBZ0lISmxkSFZ5YmlCeWRXeGxJQ3NnS0dGMGRHVnRjSFFnUGlBeENpQWdJQ0FnSUQ4Z0orcXdtZXlkZ0NEcnJManF0YXpycGJ3ZzY0dWs3SXVjSU95YWxPeXlyZTJWbk91THBDNGc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRzb0lUc2w1QWc3S0NjN0pXSTdaYUk2NDJZSU9xeWcrdVRwT3F6dkNEcXNybnN1WmpzcDRBZzdKV0s2NHFVTENEcXRhenNvYkRyZ3BnZzdKYTA3WnlZNnJDQUlPMlpsZXlMcE8yZWlDRHJpNlRycGJnZzdJT0k2NkdjN0pxMElPdU1nT3lWaUNBejZyQ2M2Nlc4SU9xM25PeTVtZXVNZ091aG5DQktVMDlPSU91d3NPeVh0T3Vobk91bmpEb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLSFJsZUhRcENpQWdJQ0FnSURvZ0ordUxwT3lkakNCVlNTRHJyTGpxdGF6c25aZ2c2NHlBN0pXSUlEUHFzSnpycGJ3ZzZyZWM3TG1aNjR5QTY2R2NJRXBUVDA0ZzY3Q3c3SmUwNjZHYzY2ZU0NCk9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29kR1Y0ZENrcE93b2dJSDBzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLVHNLZlFvS0x5OGc2N0tJN0pldElPMkV0Q0RpZ0pRZzZyQ1o3SjJBSU95RXVPeUZtT3lkaENEc2s3RHJrSmdzSU95ZHRPdXlpQ0R0aExUcnA0d2c3TGFVN0xLY0lPMllsZXlMblNoS1UwOU9JT3V3c095WHRDa2c2NHlBN0l1Z0lPdXlpT3lYclNEdG1KWHNpNTBvU2xOUFRpRHFzSjNzc3JRcDdKMkVJT3lhbE9xMXJPMlZuT3VMcEFwbWRXNWpkR2x2YmlCaGMydFVjbUZ1YzJ4aGRHVW9kR1Y0ZEN3Z2JXOWtaV3dzSUhKbGNHRnljMlVwSUhzS0lDQnlaWFIxY200Z2NuVnVWSFZ5Ymlnb0tTQTlQaUFvQ2lBZ0lDQW43SjIwNjdLSUlPeWFsT3l5cmV5ZGdDRHJzb2pzbDYwZzdKNlI3SmVGN0oyMDY0dWtJQ2pyckxqcXRhd2c2NHVrNjVPczZyaXdJT3lWaE91TG1DRGlnSlFnNjR5QTdKV0lJRFBxc0p3ZzZyZWM3TG1aN0oyQUlPeWR0T3V5aUNEdGhMVHNsNUFnN0tDQjdKcXA3WldZN0tlQUlPeVZpdXVLDQpsT3VMcENrdUlDY2dLd29nSUNBZ0ordUxwT3lkakNCVlNTRHJyTGpxdGF6cXNJQWc3WldjNnJXdDdKYTA2Nm0wSU95ZWtPeVhzT3lLcE91ZnJPeWF0Q0RzbUlIc2xyVHJvWndzSU95WWdleVd0T3VwdENEc25wRHNsN0RzaXFUcm42enNtclFnN1pXYzZyV3Q3SmEwNjZHY0lPdXlpT3lYcmUyVm1PdWR2QzRnSnlBckNpQWdJQ0FuVlVrZzY2eTQ2cldzNjR1azdKcTBJT3F3aE9xeXNPMlZuQ0R0a1p6dG1JVHNuWVFnN0pPdzZyT2dMQ0RzbmJUcnBvVEN0K3lJcSt5ZWtNSzM2NmVJN0lxazdZSzV3cmZ0bEl6cm9JanNuYlRzaXFUdG1ZRHJqWlRyaXBRZzZyZTQ2NHlBNjZHY0lPdXp0T3lodE8yVm5PdUxwQzRnSnlBckNpQWdJQ0FuN0p1UTY2eTQ3SjJZSU95a2hDRHNpSmpycGJ3ZzZyZTQ2NHlBNjZHY0lPeWNvT3luZ08yVm5PdUxwQ0RpZ0pRZzdKdVE2Nnk0N0oyMElPMlZuQ0RzcElUc25iVHJxYlFnNjdLSTdKZXQ2NCtFSU8yVm5DRHNwSVRyb1p3c0lPeWtoT3V3bE9xL2lPeWRoQ0Rzbm9Uc25aanJvWndnN0xhVQ0KNnJDQTdaV1k3S2VBSU95Vml1dUtsT3VMcEM0Z0p5QXJDaUFnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhTRHF1SWpzcDRBNklDY2dLd29nSUNBZ0ozc2lkSEpoYm5Oc1lYUmxaQ0k2SUNMcnNvanNsNjNyckxnZ0tPeWtoT3V3bE9xL2lPeWRnQ0JjWEc0cElpd2dJbVJwY21WamRHbHZiaUk2SUNKcmIrS0drbVZ1SU91WWtPdUtsQ0JsYnVLR2ttdHZJbjA2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLUW9nSUNrc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzS2ZRb0tMeThnNjR5QTdabVU3WmlWSU91c3VPcTFyQ0Rzb0p6c25wRWc3WVMwSU9LQWxDRHNncXpzbXFuc25wRHFzSUFnN0lPQjdabXA3SjJFSU95RXBPdXFoZTJWbU91cHRDRHJwNlhybmIzc2w1QWc2NmVlNjRxVUlPdXN1T3Exck91bHZDRHJwNHpyazZUc2xyVHNwSURyaTZRdUNpOHZJRzFsYzNOaFoyVnoNCk9pQmJlM0p2YkdVNkozVnpaWEluZkNkaGMzTnBjM1JoYm5RbkxDQjBaWGgwZlYwZzdLQ0U3TEswSU91TWdPMlpsT3VsdkNEcnA2VHJzb2dnNjdDYjY0cVU2NHVrS091THBPdW1yT3VLbENEcnJMVHNnNEh0ZzV3ZzRvQ1VDaTh2SU95YmpPdXdqZXlYaFNEc3A0RHNpNXpyckxqc25aZ2dJdXlhbE95eXJldVRwT3lkZ0NEc2hKenJvWndnNjZ5MDZyU0FJaURzb0lUc29KenJwYndnN0tlQTdZS2s2cml3SU95Y2hPMlZ0Q0RyaklEdG1aUWc2NmVsNjUyOTdKMkVJTzJFdENEc2xZanNsNUFnNjZxOTY1V0ZJT3lMbyt1S2xPdUxwQ2t1Q21aMWJtTjBhVzl1SUdGemEwTnZiWEJ2YzJVb2JXVnpjMkZuWlhNc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ2RISmhibk5qY21sd2RDQTlJQ2h0WlhOellXZGxjeUI4ZkNCYlhTa3ViV0Z3S0NodEtTQTlQZ29nSUNBZ0lDQW9iUzV5YjJ4bElEMDlQU0FuWVhOemFYTjBZVzUwSnlBL0lDZnNsclRzDQppNXpzaXFUdGhMVHRpcmc2SUNjZ09pQW43SUtzN0pxcDdKNlFPaUFuS1NBcklGTjBjbWx1WnlodExuUmxlSFFnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJREUxTURBcENpQWdJQ0FwTG1wdmFXNG9KMXh1SnlrN0NpQWdJQ0J5WlhSMWNtNGdLQW9nSUNBZ0lDQW43SjIwNjdLSUlPeWFsT3l5cmV5ZGdDQWk2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFaTdKMjA2NHVrSUNqcXVMRHNvYlFnNjZ5NDZyV3NJT3VMcE91VHJPcTRzQ0RzbFlUcmk1Z2c0b0NVSU95VmhPdWVtQ0RyaklEdG1aVHFzSUFnN0oyMDY3S0lJTzJFdE95ZG1DRHNvSVRzc3JRZzY2ZWw2NTI5N0oyMDY0dWtLUzRnSnlBckNpQWdJQ0FnSUNmc2dxenNtcW5zbnBEcXNJQWc3Wm1VNjZtMElPeURnZTJacWNLMzY2ZWw2NTI5N0oyRUlPeUVwT3VxaGUyVm1PdXB0Q3dnN0lxazdZT0E3SjI4SU9xM25PeTVtZXF6dkNEc21JanNpNXdnN1lhazdKZVFJT3VubnV1S2xDQlZTU0RyckxqcXRhenJwYndnNjZlTTY1T2s3SmEwSU95Z25PeVZpTzJWbU91ZA0KdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RycDZYcm5iM3NuYlFnNjdhQTdLR3g3WldZNjZtMElPMk91TzJWbU9xeWpDRHJrSmpyckx6c2xyVHJuYnc2SU95V3RPdVdwQ0R0bVpUcnFiVEN0K3E0c091S3BleWRtQ0RyckxqcXRhenNuYmpzcDRBc0lPdVRwT3lXdE9xd2lDRHNucERycHF6cmlwUWc3SmEwNjVTVTdKMjQ3S2VBS08yTW5leVhoU0R0ZzREc25iVHRpNEF2NjdPNDY2eTRMK3V5aE8yS3ZDd2c3WWFnN0lxazdZcTRMQ0RydVlnZzdabVU2Nm0wSU95VmlPdUN0Q3dnNjdDdzY0U0lJT3VUc1Nrc0lPeVd0T3VXcENEc2c0SHRtYW5zbmJqc3A0QW83SVN4NnJPMUlPMkd0ZXV6dEMvc21LVHJwWmd2N1ptVjdKMjRJT3lhbE95eXJTL3NsWWpyZ3JRcElPcXdtZXlkZ0NEcXNvTXVJT3E4clNEdGxZVHNtcFR0bFp3ZzZyS0Q2NmVNSU9xenFPdWR2Q0R0bFp3ZzY3S0k3SmVRSU95MW5PdU1nQ0F5NnJDYzZybU03S2VBTENEc3A2ZnFzb3d1SU95ZHRPdVZqQ0J6ZFdkblpYTjBhVzl1Yyt1S2xDRHJ1WWdnNjdDdzdKZTANCkxseHVKeUFyQ2lBZ0lDQWdJQ2N0SU9xd2tPeWR0Q0RzbHJUcmlwQWc3S0NWNjQrRUlPeVlwT3VwdENEcnJMdnF1TERycDR3ZzdaV1k3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyQ0E3S0NWN0oyRUlPeUV1T3lhc09xem9DRHN0SWpzbFlnZ2MzVm5aMlZ6ZEdsdmJuUHJwYndnN1pXbzZydVlJT3VDdE91cHRPeUVuQ3dnY21Wd2JIbnNsNUFnNnJDQTdLQ1Y3SjJFSU91d25lMmVpT3F6b0NEcnJMVHNsNGZzbllRZzdKV002NkNrN0tPODY2bTBJT3VObENEcnA1N3N0cHdnN0lpWUlPeWVpT3VLbE95bmdDRHRsWndnNjZ5NDdKNmw3Snk4NjZHY0lPdU5wK3UybWV5WHJPdWR2Q2pzbUlnNklDTHRtWlhzbmJnZzdZeWQ3SmVGN0oyMDY1Mjg2ck9nSU9xd2dPeWdsZTJXaU95V3RPeWFsQ0RpZ0pRZzdZYWc3SXFrN1lxNDY1Mjg2Nm0wSU95VmpPdWdwT3lqdk95RXVPeWFsQ0lwTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3VzdU9xMXJPdWx2Q0Rzb0p6c2xZanRsYUFnNjVXUUlPeUVuT3VobkNEc29KSHF0N3pzbmJRZzY0dWs2Nlc0DQpJREorTStxd25DNGc2ckNCSU95Z25PeVZpT3lYbENEc21ad2c2cmU0NjZDSDZyS01JT3lOdk91S2xPeW5nQ0RzbmJUc25LRHJwYndnNjdhWjdKMjQ2NHVrTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lDck95YXFleWVrT3F3Z0NEc2xyanF1SW50bFpqc3A0QWc3SldLN0oyQUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN1pxZjdJaVlJT3VUc1NucnBid2c3S2VBN0phMDY0SzBJT3VFbyt5bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN1p1RTdJYU5JT3lhbE95eXJTZ2k2NDJVSU95bnArcXlqQ0lzSUNMcnNvVHRpcnpzbXFuc25MenJvWndpSU91VHNTbnNuYlRycWJRZzdLZUI3S0NFSU95Z25PeVZpT3lkaENEcXQ3Z2c2N0NwN1phbDdKeTg2NkdjSU9xem9PeXprQ0RyaTZUc2k1d2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cg0Kb0tYdGxaenJpNlF1SU91bmlPMkJyT3VMcE95YXRNSzM3SVNrNjZxRklPcTRpT3luZ0RvZ0p5QXJDaUFnSUNBZ0lDZDdJbkpsY0d4NUlqb2dJdXVNZ08yWmxDRHNuWkhyaTdVZzdaV2M2NUdRSU91c3VPeWVwU0FvN1pXMDdKcVU3TEswS1NJc0lDSnpkV2RuWlhOMGFXOXVjeUk2SUZ0N0luUmxlSFFpT2lBaTY2eTQ2cldzSUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSnlaV0Z6YjI0aU9pQWk3SjIwN0p5Z0lPMlZuQ0Ryckxqc25xVWlmVjE5WEc1Y2JpY2dLd29nSUNBZ0lDQW5XK3VNZ08yWmxGMWNiaWNnS3lCMGNtRnVjMk55YVhCMENpQWdJQ0FwT3dvZ0lIMHNJRzF2WkdWc0xDQnlaWEJoY25ObEtUc0tmUW9LTHk4ZzdaU0U2NkNJN0o2RTY3T0VLTzJWbU95Y2hDRHRsSVRyb0lqc25vUWc2NnkyN0oyTUtTRHN0cFRzc3B3ZzdZUzBJT0tBbENEdGxad2c3Wm1VNjZtMDdKMkVJTzJWbU95Y2hDRHRsSVRyb0lqc25vUWc2NHVvN0p5RTY2R2NJT3VDbU91SW9DRHJzN1RyZ3JUcXM2QXNDaTh2SUNvcTdaU0UNCjY2Q0k3SjZFNjZlSTY0dWtJT3VVc091aG5Db3FJT3VNZ095VmlPeWRoQ0Ryc0p2cmlwVHJpNlF1SU8yVm5DRHNtcFRzc3Ezc2w1QWc2NHVrSU95THBPeVd0Q0RyczdUcmdyVHJpcFFnNnJLRDdKMjBJTzJWdGV5THJEb0tMeThnN1pTRTY2Q0k3SjZFSU95SW1PdW5qTzJCdkNEc21wVHNzcTNzbllRZzdLcTg2ckNjNjZtMElPcTN1T3Vuak8yQnZDRHJpcERyb0tUc3A0RHFzNkFvNnJDQklEVitNVERzdElncElPcTFyT3VQaFNEc2dxenNtcW5ybjRucmo0UWc2cmU0NjZlTTdZRzhJT3VDbU9xd2hPdUxwQzRLTHk4Z1ozSnZkWEJ6T2lCYmUyNWhiV1VzSUhSbGVIUnpPbHRkZlYwZ0tPMlpsT3VwdENEc25JVGlocExzbFlUcm5wZ2c3SWljS1M0S1puVnVZM1JwYjI0Z1lYTnJSM0p2ZFhCektHZHliM1Z3Y3l3Z2JXOWtaV3dzSUhKbGNHRnljMlVzSUcxdmNtVXBJSHNLSUNCeVpYUjFjbTRnY25WdVZIVnliaWdvS1NBOVBpQjdDaUFnSUNBdkx5RHJzb1R0aXJ3ZzdKaUI3SmV0N0oyQUlDanJzb1R0aXJ3cDdKeTg2NkdjDQpJT3l3amV5V3RDRHJzN1RyZ3Jqcmk2UWc0b0NVSU91eWhPMkt2Q0RyckxqcXRhenJpcFFnNjZ5NDdKNmw3SjIwSU95VmhPdUxpT3VkdkNEcmo1bnNucEVnN0oyMDY2YUU3SjIwNjUyOElPcTNuT3k1bWV5ZHRDRHJpNlRycGJUcmk2UUtJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQW9aM0p2ZFhCeklIeDhJRnRkS1M1dFlYQW9LR2NzSUdrcElEMCtDaUFnSUNBZ0lDZGJKeUFySUNocElDc2dNU2tnS3lBblhTQW5JQ3NnVTNSeWFXNW5LQ2huSUNZbUlHY3VibUZ0WlNrZ2ZId2dLQ2ZxdDdqcm83a25JQ3NnS0drZ0t5QXhLU2twSUNzZ0tHY2dKaVlnWnk1eWIyeGxJRDA5UFNBbjY3S0U3WXE4SnlBL0lDY2dLT3V5aE8yS3ZDa25JRG9nSnljcElDc2dKMXh1SnlBckNpQWdJQ0FnSUNobklDWW1JRUZ5Y21GNUxtbHpRWEp5WVhrb1p5NTBaWGgwY3lrZ1B5Qm5MblJsZUhSeklEb2dXMTBwTG0xaGNDZ29kQ2tnUFQ0Z0p5QWdMU0FuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvVTNSeWFXNW5LSFFnZkh3Z0p5Y3BLU2t1YW05cA0KYmlnblhHNG5LUW9nSUNBZ0tTNXFiMmx1S0NkY2JpY3BPd29nSUNBZ1kyOXVjM1FnYUdGelFuUnVJRDBnS0dkeWIzVndjeUI4ZkNCYlhTa3VjMjl0WlNnb1p5a2dQVDRnWnlBbUppQm5Mbkp2YkdVZ1BUMDlJQ2Zyc29UdGlyd25LVHNLSUNBZ0lHTnZibk4wSUd0bGVTQTlJQ2RuY205MWNITW5JQ3NnS0dkeWIzVndjeUI4ZkNCYlhTa3ViV0Z3S0NobktTQTlQaUFvWnlBbUppQm5MblJsZUhSeklEOGdaeTUwWlhoMGN5NXFiMmx1S0NjbktTQTZJQ2NuS1NrdWFtOXBiaWduSnlrN0NpQWdJQ0JqYjI1emRDQmhkSFJsYlhCMElEMGdLR0Z6YTJWa1EyOTFiblF1WjJWMEtHdGxlU2tnZkh3Z01Da2dLeUF4T3dvZ0lDQWdZWE5yWldSRGIzVnVkQzV6WlhRb2EyVjVMQ0JoZEhSbGJYQjBLVHNLSUNBZ0lHbG1JQ2hoYzJ0bFpFTnZkVzUwTG5OcGVtVWdQaUF5TURBcElHRnphMlZrUTI5MWJuUXVZMnhsWVhJb0tUc0tJQ0FnSUdOdmJuTjBJR0ZuWVdsdUlEMGdiVzl5WlNCOGZDQmhkSFJsYlhCMElENGdNUW9nSUNBZ0lDQS8NCklDZnNuYlFnN1ptVTY2bTA3SjJBSU95ZHRDRHNoTGpzaFpqc2w1RHNoSndnN0oyMDY2KzRJT3VMcE91a21PdUxwQzRnN0pXZTdJU2NJT3VDdUNEcmpJRHNsWWpxczd3ZzdKYTA3WnlZd3JmcXRhenNvYkRxc0lBZzdabVY3SXVrN1o2SUlPdUxwT3VsdUNEc2c0Z2c2NHlBN0pXSTY2ZU1JT3VDdE91ZHZDNWNiaWNLSUNBZ0lDQWdPaUFuSnpzS0lDQWdJSEpsZEhWeWJpQW9DaUFnSUNBZ0lHRm5ZV2x1SUNzS0lDQWdJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnSXUyWmxPdXB0T3lkaENEdGxaanNuSVFnN1pTRTY2Q0k3SjZFNjdPRTY2R2NJT3VDbU91SW9DRHJpNlRyazZ6cXVMQWk2NHVrTGlEc2xZVHJucGpyaXBRZzdaV2NJTzJabE91cHRPeWRtQ0RyckxqcXRhenJwYndnN1pXWTdKeUVJTzJVaE91Z2lPeWVoQ2pzbUlIc2w2MHBJT3VMcU95Y2hPdWhuQ0Ryckxic25ZQWc2cktEN0oyMDY0dWtMbHh1SnlBckNpQWdJQ0FnSUNjcUt1eVlnZXlYcmV1bmlPdUxwQ0RybExEcm9ad3FLaURyaklEc2xZanNuWVFnDQo2NEswNjUyOElPS0FsQ0RzbUlIc2w2M3NuWVFnN0lTYzY2R2NJTzJWcWV5NW1PcXhzT3VDbUNEc2lKenNoSnpycGJ3ZzY3Q1U2cjY0N0tlQUlPdW5pT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0Rxc0lFZzdKaUI3SmV0N0plUUlPdU1nT3lWaUNBeTZyQ2NMaURxdDdnZzdKaUI3SmV0N0oyMElPeVhyT3VmckNEc3BJVHNuYlRycWJRZzY0eUE3SldJNjQrRUlDb3E2ckNaN0oyQUlPeWtoQ0RzaUpncUt1dWhuQ2pzcElUcnNKVHF2NGdnWEZ4dTdKeTg2NkdjSU9xMXJPdTJoQ3dnN0tTRUlPeUluT3lFbkNEc25LRHNwNEFwTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lZZ2V5WHJleWRtQ0RzbDYzdGxhQW83WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZDRHJrN0VwNnJPOElPeWJrT3VzdU95ZG1DRHNvSlhyczdUQ3QreWhzT3F4dENqc2lLdnNucERDdCt1TWdPeURnY0szN0tHdzZyRzBLZXlkZ0NEc25LRHNwNER0bFpqcXM2QXNJT3lYaHV1S2xDRHNvSlhyczdUcnBid2c3S2VBN0phMDY0SzA3S2VBSU91bg0KaU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcXM2RHN1YUFnNnJLTUlPeVhodXVLbENEc21JSHNsNjNzbmJUcnFiUWc2NHlBN0pXSUlESHFzSnpycDR3ZzY0SzA2ckd3NjRLWUlPdTVpQ0Ryc0xEc2w3VHJvWndnNjVHUTdKYTA2NCtFSU91UW5PdUxwQ0RpZ0pRZzdKYTE3S2VBNjZHY0lPdXdsT3ErdU95bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN1ptVTY2bTBJT3E0c091S3BldXFoU2pyczREcXNyM0N0KzJWdE95Z25DRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWlRyaTZRdVhHNG5JQ3NLSUNBZ0lDQWdLR2hoYzBKMGJpQS9JQ2N0SUNqcnNvVHRpcndwN0p5ODY2R2NJTzJSbk95TG5PdVFuQ0RzbUlIc2w2M3NuWUFnSnlBcklFSlZWRlJQVGw5U1ZVeEZJRG9nSnljcElDc0tJQ0FnSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURxc0ozc3NyUWc3WldZNjRLWTY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvWEN0K3k5bE91VG5PMk8NCm5PeUtwQ0RxdUlqc3A0QTZYRzRuSUNzS0lDQWdJQ0FnSjNzaVozSnZkWEJ6SWpvZ1czc2libUZ0WlNJNklDTHNtSUhzbDYwZzdKMjA2NmFFS095ZWhldWdwZXF6dkNEcmo1bnNuYndwSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcmpJRHNsWWdnNjZ5NDZyV3NJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKeVpXRnpiMjRpT2lBaTdKMjA3SnlnSU8yVm5DRHJyTGpzbnFVaWZWMTlYWDFjYmljZ0t3b2dJQ0FnSUNBbjdKaUI3SmV0N0oyQUlPeWVoZXVncFNEc2lKenNoSnpDdCtxd25PeUltT3VsdkNEcXQ3anJqSURyb1p3ZzdLZUE3WUtvNjR1a0xseHVYRzRuSUNzS0lDQWdJQ0FnSjF2c21JSHNsNjNyczRRZzY2eTQ2cldzWFZ4dUp5QXJJR3hwYzNRS0lDQWdJQ2s3Q2lBZ2ZTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93cDlDZ292THlEdGxJVHJvSWpzbm9UcnM0UWc3TGFVN0xLY0lPeWRrZXVMdGV5WGtPeUVuQ0JiZTI1aGJXVXNJSE4xWjJkbGMzUnBiMjV6T2x0N2RHVjRkQ3dnDQpjbVZoYzI5dWZWMTlYU0RzdHBUc3Rwd0tablZ1WTNScGIyNGdjR0Z5YzJWSGNtOTFjSE1vY21GM0tTQjdDaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXg3VzF4elhGTmRLbHg5THlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnZJRDBnU2xOUFRpNXdZWEp6WlNoektUc0tJQ0FnSUdOdmJuTjBJR0Z5Y2lBOUlFRnljbUY1TG1selFYSnlZWGtvYnlBbUppQnZMbWR5YjNWd2N5a2dQeUJ2TG1keWIzVndjeUE2SUZ0ZE93b2dJQ0FnWTI5dWMzUWdaM0p2ZFhCeklEMGdZWEp5TG0xaGNDZ29aeWtnUFQ0Z0tIc0tJQ0FnSUNBZ2JtRnRaVG9nVTNSeWFXNW5LQ2huSUNZbUlHY3VibUZ0WlNrZ2ZId2dKeWNwTG5SeWFXMG9LU3dLSUNBZ0lDQWdjM1ZuWjJWeg0KZEdsdmJuTTZJRUZ5Y21GNUxtbHpRWEp5WVhrb1p5QW1KaUJuTG5OMVoyZGxjM1JwYjI1ektRb2dJQ0FnSUNBZ0lEOGdaeTV6ZFdkblpYTjBhVzl1Y3dvZ0lDQWdJQ0FnSUNBZ0lDQXViV0Z3S0NoNEtTQTlQaUFvZEhsd1pXOW1JSGdnUFQwOUlDZHpkSEpwYm1jbkNpQWdJQ0FnSUNBZ0lDQWdJQ0FnUHlCN0lIUmxlSFE2SUhndWRISnBiU2dwTENCeVpXRnpiMjQ2SUNjbklIMEtJQ0FnSUNBZ0lDQWdJQ0FnSUNBNklIc2dkR1Y0ZERvZ1UzUnlhVzVuS0NoNElDWW1JSGd1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lCVGRISnBibWNvS0hnZ0ppWWdlQzV5WldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZTa3BDaUFnSUNBZ0lDQWdJQ0FnSUM1bWFXeDBaWElvS0hncElEMCtJSGd1ZEdWNGRDa0tJQ0FnSUNBZ0lDQTZJRnRkTEFvZ0lDQWdmU2twT3dvZ0lDQWdMeThnN0oyMDY2YUU3S0d3N0xDb0lPeVhodXF6b0NEc29KenNsWWpyajRRZzdKZUc2NHFVSU9xN2pldU5zT3E0c091bmpDRHMNCm1aVHNuTHpycWJRZzdaaVY3SXVkSU95ZHRPMkRpT3VobkNEcnM3anJpNlFvNnJDWjdKMkFJT3lFdU95Rm1PeVhrQ0RzbnF6c21wVHNzcTBwQ2lBZ0lDQnlaWFIxY200Z1ozSnZkWEJ6TG5OdmJXVW9LR2NwSUQwK0lHY3VjM1ZuWjJWemRHbHZibk11YkdWdVozUm9LU0EvSUdkeWIzVndjeUE2SUc1MWJHdzdDaUFnZlNCallYUmphQ0FvWDJVcElIc0tJQ0FnSUhKbGRIVnliaUJ1ZFd4c093b2dJSDBLZlFvS0x5OGc3WXlkN0plRklPeUV1TzJLdUNEc3RwVHNzcHdnN1lTMElPS0FsQ0R0bFp3ZzdZeWQ3SmVGN0oyWUlPcTFyT3lFc2V5YWxPeUdqQ2pzbDYzdGxhQXI2Nnk0NnJXc0tldWx2Q0R0bFp3ZzY3S0k3SmVRSU91enRPdUN0T3F6b0N3S0x5OGc3SnFVN0lhTTY3T0VJT3VDc2Vxd25PcXdnQ0RzbFlUcmk0anJuYndnS2lyc21ZVHNoTEhya0p3ZzdZeWQ3SmVGSU95RXVPMkt1Q2pzdklEc25iVHNpcVFwSURKK00rcXduQ29xNjZXOElPMkd0ZXljdk91aG5DRHJzSnZyaXBUcmk2UXVDaTh2SU8yRGdPeWR0TzJMDQpnTUszN0pXSTY0SzB3cmZyc29UdGlyenNuYlFnN1pXY0lPdXF1T3ljdk91aG5DRHNuYnpxdElEcmo3enNsYndnN1pXWTY2K0E2NkdjS091VXNPdWhuQ0RydlpIc2xZUWc3S0d3N1pXcDdaV1k2Nm0wSU95V3RPcTRpK3VDbk91THBDa2c3SVM0N1lxNElPdUxxT3ljaE91aG5DRHNvSnpzbFlqdGxaanFzb3dnN1pXYzY0dWtMZ292THlCbGJHVnRaVzUwY3pvZ1czdHliMnhsTENCMFpYaDBmVjBnS08yWmxPdXB0Q0RzbklUaWhwTHNsWVRybnBnZzdJaWNLUzRLTHk4Z2JXOXlaVDEwY25WbEtGdnN2SURzbmJUc2lxUWc2NDJVSU91d20rcTRzRjBwNjZtMElPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA2Nis0SU91Q3VDRHNoTGp0aXJqc21ZQWc2cks1N0xtWTdLZUFJT3lWaXV1S2xDRHNnNGdnN0lTNDdZcTQ2Nlc4SU95YWxPcTFyTzJWbk91THBDNEtablZ1WTNScGIyNGdZWE5yVUc5d2RYQW9aV3hsYldWdWRITXNJRzF2WkdWc0xDQnlaWEJoY25ObExDQnRiM0psS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200bw0KS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnY205c1pYTWdQU0FvWld4bGJXVnVkSE1nZkh3Z1cxMHBMbTFoY0Nnb1pTa2dQVDRnVTNSeWFXNW5LQ2hsSUNZbUlHVXVjbTlzWlNrZ2ZId2dKeWNwS1M1cWIybHVLQ2NzSUNjcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlDaGxiR1Z0Wlc1MGN5QjhmQ0JiWFNrdWJXRndLQ2hsTENCcEtTQTlQZ29nSUNBZ0lDQW9hU0FySURFcElDc2dKeTRnV3ljZ0t5QlRkSEpwYm1jb0tHVWdKaVlnWlM1eWIyeGxLU0I4ZkNBbkp5a2dLeUFuWFNBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb1UzUnlhVzVuS0NobElDWW1JR1V1ZEdWNGRDa2dmSHdnSnljcEtRb2dJQ0FnS1M1cWIybHVLQ2RjYmljcE93b2dJQ0FnTHk4ZzZyQ1o3SjJBSU8yTW5leVhoZXlkaENEcnFvY2c2N0tJN0tlNElPdXN1K3VLbE95bmdDRHF1TERzbHJVZzRvQ1VJT3llck95YWxPeXlyZXlkdE91cHRDQWk3SjIwN0tDRTZyTzhJT3VMcE91bHVDRHNoTGp0aXJnaTY2VzhJT3lhbE9xMXJPMlZuT3VMcEFvZ0lDQWcNCkx5OGdLR0Z6YTBOc1lYVmtaZXlaZ0NEcXNKbnNuWUFnN0oyMDdKeWdPaURzbFlnZzZyZTQ2NStzNjZtMElPMkJ0T3Vobk91VG5PcXdnQ0Rxc0puc25ZQWc3SVM0N1lxNDY2VzhJT3VZa0NEcmdyVHNoSndnVyt5OGdPeWR0T3lLcENEcmpaUWc2N0NiNnJpd1hlcXdnQ0RyckxUc25aanJyN2p0bGJUc3A0VHJpNlFwQ2lBZ0lDQmpiMjV6ZENCclpYa2dQU0FuY0c5d2RYQUJKeUFySUNobGJHVnRaVzUwY3lCOGZDQmJYU2t1YldGd0tDaGxLU0E5UGlCVGRISnBibWNvS0dVZ0ppWWdaUzUwWlhoMEtTQjhmQ0FuSnlrcExtcHZhVzRvSndFbktUc0tJQ0FnSUdOdmJuTjBJR0YwZEdWdGNIUWdQU0FvWVhOclpXUkRiM1Z1ZEM1blpYUW9hMlY1S1NCOGZDQXdLU0FySURFN0NpQWdJQ0JoYzJ0bFpFTnZkVzUwTG5ObGRDaHJaWGtzSUdGMGRHVnRjSFFwT3dvZ0lDQWdhV1lnS0dGemEyVmtRMjkxYm5RdWMybDZaU0ErSURJd01Da2dZWE5yWldSRGIzVnVkQzVqYkdWaGNpZ3BPeUF2THlEcnJMVHRsWnp0bm9nZzdJeVQ3SjIwDQo3S2VBSU95Vml1cXlqQW9nSUNBZ1kyOXVjM1FnWVdkaGFXNGdQU0J0YjNKbElIeDhJR0YwZEdWdGNIUWdQaUF4Q2lBZ0lDQWdJRDhnSit5ZHRDRHRqSjNzbDRYc25ZQWc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRycjdnZzY0dWs2NlNZNjR1a0xpRHNsWjdzaEp3ZzdLQ2M3SldJN1pXY0lPeUV1TzJLdU91VHBPcXp2Q0FxS3V5Z2tlcTN2TUszN0phMDdaeVk2ckNBSU8yWmxleUxwTzJlaUNEcmk2VHJwYmdnN0lPSUlPeUV1TzJLdUNvcTY2ZU1JT3VDdE91ZHZDanFzSm5zbllBZzdJUzQ3WXE0SU91d21PdXp0U0RxdUlqc3A0QXBMbHh1SndvZ0lDQWdJQ0E2SUNjbk93b2dJQ0FnY21WMGRYSnVJQ2dLSUNBZ0lDQWdZV2RoYVc0Z0t3b2dJQ0FnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTdZeWQ3SmVGS091THBPeWR0T3lXdk91aG5PcTN1Q2tnN0lTNDdZcTRJT3VMcE91VHJPcTRzQ0xyaTZRdUlPeVZoT3VlbU91S2xDRHRsWndnN1l5ZDdKZUY3SjJFSU95Y2hPS0drdXlWaE91ZW1PdWhuQ0RyZ3Bqcw0KbDdUdGxad2c2cldzN0lTeDdKcVU3SWFNNjVPazdKMjA2NHVrS095RW5PdWhuQ0RyckxUcXRJRHRsWndnNjdPRTZyQ2NJT3VzdU9xMXJPcXdnQ0RzbFlUcmk0anJpNlFwTGlBbklDc0tJQ0FnSUNBZ0oreWFsT3lHak91bHZDRHJnckhxc0p6cm9ad2c2ck9nN0xtWTdLZUFJT3Vua09xem9Dd2dLaXJ0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcTg3SjIwSU95RW5PdWhuQ0RzbmJ6cXRJRHJrSndnSXV5WmhPeUVzZXVRbkNEdGpKM3NsNFVnN0lTNDdZcTRJaUF5ZmpQcXNKd3FLdXVsdkNEc29KenNsWWp0bFpqcm5id3VJT3F3Z1NEc2hManRpcmpyaXBRZzdJU2M2NkdjSU91THBPdWx1Q0Rzb0pIcXQ3enNuYlRzbHJUc2xid2c3WldjNjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2Zxc0lFZzdJUzQ3WXE0NjRxVUlPeWVoZXVncGVxenZDQXFLdXF3bWV5ZGdDRHNsNjN0bGFEQ3QrcXdtZXlkZ0NEcXNKenNpSmpDdCtxd21leWRnQ0RzaUp6c2hKd3FLdXlkbUNEc21wVHNob3pycGJ3ZzY2cW82NUdRSU8yUHJPMlYNCnFPMlZuT3VMcEM0ZzdJUzQ3WXE0SU95VmlPeVhrT3lFbkNEdGc0RHNuYlR0aTREQ3QreVZpT3VDdE1LMzY3S0U3WXE4N0oyQUlPMlZuQ0RycXJqc25MenJvWndnNjZlZTdKV0U2NWFvN0phMDdLQzQ3Slc4SU8yVm5PdUxwQ2pzbUlnNklPdXp1T3VzdU95ZHRDQWlmdTJWb09xNWpPeWFsRDhpNjZtMElPdXloTzJLdk95ZGdDQmI3SldFNjR1STdKaWtYUzliNjRTa1hTa3VYRzRuSUNzS0lDQWdJQ0FnSjF2dGpKM3NsNFVnNjZ5NDdMSzBJT3Ezbk95NW1TRGlnSlFnN0p5RUlPeUtwTzJEZ095ZHZDRHFzSURzbmJUcms1enNuWmdnSWpndUlPMk1uZXlYaFNJZzdJUzU3SVdZN0oyRUlPdVVzT3VsdU91THBGMWNiaWNnS3dvZ0lDQWdJQ0FuTFNEdGc0RHNuYlR0aTRBNklPeW5wK3lkZ0NEcnFvWHNncXpxdGF3b01uNDA3SmEwN0tDSUtTd2c3S0tGNnJLdzdKYTA2Nis0d3JmcnA0anN1YWp0a1p3ZzdKZUc3SjIwS0g3c21wUXZmdXVMcEM5KzZybU03SnFVUHlEcXVJanNwNEFwTGlEcnNKanJrNXpzaTV3ZzdKV0k2NEswDQpLT3V6dU91c3VDa2c2NmVsNjUyOTdKMkVJT3lhbE95VnZlMlZ0Q0R0ZzREc25iVHRpNERycDR3ZzY3U1E2NCtFSU91c3RPeUtxQ0R0akozc2w0WHNuYmpzcDRBZzdKV002cktNSU8yVm1PdWR2QzRnN0p1UTY3TzQ3SjIwSUNMc2xZenJwcnd2N1ptVjdKMjRJdXl5bU91ZnZDRHJwNG5zbDdEdGxaanJxYlFnNjdPNDY2eTQ3SjJFSU9xM3ZPcXhzT3VobkNEcXRhenNzclR0bVpUdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc3SldJNjRLMEtPdXp1T3VzdUNrNklPMlZ0T3lhbE95eXRDNGc3WXlRNjR1bzdKMjBJTzJWaE95YWxPMlZtT3VwdENBaWZ1MlZvT3E1ak95YWxEOGk2NkdjSU91c3UrcXpvQ3dnNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzdKeUU3WmVZS095Q3JleWduTUszN1lPSTdZZTBJT3VUc1Nuc25ZQWc2ckt3NnJPODY2VzhJT3Vvdk95Z2dDRHFzcjNxczZEdGxaenJpNlF1SU9xeXNPcXp2TUszN0lPQjdZT2NJTzJHdGV1enRPdXB0Q0RzaEp6c2lLRHRtSlhzbkx6cm9ad2c3SldNNjZhdw0KNjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2N0SU91eWhPMkt2RG9nNjdPNDY2eTQ3SjIwSUNKKzdaV2c2cm1NN0pxVVB5THJxYlFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBzSU91enVPdXN1T3lkdENEc2c0SHRtYW5zbllRZzdJU2M3SWlnN1pXWTZyT2dJT3lkdENEcnNvVHRpcnpzbmJRZzdJdWs3S0NjSU91UG1leWVrZXlkdE91cHRDRHJqNW5zbnBFZzY0K1o3SUtzS095Q3JleWduQy9zb0lEc25xVXY3SmV3NnJLd0lPMlZ0T3lnbkNEcms3RXBMQ0R0aHJYcnM3UWc3WXlkN0plRjdKMllJT3VMcU95ZHZDRHJzb1R0aXJ6c25iVHJxYlFnSXUyWmxleWR1Q0l1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ3dnSXV1THErcTRzTUszNjQrWjdKNlJJaURzb2JEdGxha2c2cmlJN0tlQUxpRHRtWlRycWJRZzZyaXc2NHFsNjZxRktPdXpnT3F5dmNLMzdaVzA3S0NjSU91VHNTbnNuWUFnNnJlNDY0eUE2NkdjSU91UmxPdUxwQzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHMNCm01RHJyTGpzblpnZzdLQ1Y2N08wd3Jmc29iRHFzYlFvN0lpcjdKNlF3cmZzbmJUc2c0RXY3SjIwN1pXWXdyZnJqSURzZzRFcDdKMkFJT3ljb095bmdPMlZtT3F6b0N3ZzdKdVE2Nnk0N0plUUlPeVhodXVLbENEc29KWHJzN1RDdCt5Z2lPeXdxTUszN0pldzY1Mjk3TEtZNjZXOElPeW5nT3lXdE91Q3RPeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSit1THRleWRnQ0Ryc0pqcms1enNpNXdnU2xOUFRpRHFzSjNzc3JRZzdaV1k2NEtZNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9YQ3QreTlsT3VUbk8yT25PeUtwQ0RxdUlqc3A0QTZYRzRuSUNzS0lDQWdJQ0FnSjNzaWMyVjBjeUk2SUZ0N0luSmxZWE52YmlJNklDTHNuYlFnN0lTNDdZcTQ3SjJZSU91d3FlMldwZXlkaENEdGxaenF0YTNzbHJRZzdaV2NJT3VzdU95ZXBleWN2T3VobkNJc0lDSmxiR1Z0Wlc1MGN5STZJRnQ3SW5KdmJHVWlPaUFpN0pldDdaV2dJaXdnSW5SbGVIUWlPaUFpNjZ5NDZyV3NJQ2pzDQpwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSjlMQ0F1TGk1ZGZTd2dMaTR1WFgxY2JpY2dLd29nSUNBZ0lDQW43SmV0N1pXZzdKMkFJT3llaGV1Z3BTRHNpSnpzaEp6cmpJRHJvWnc2SUNjZ0t5QnliMnhsY3lBcklDZGNibHh1SnlBckNpQWdJQ0FnSUNkYjdZeWQ3SmVGSU95YWxPeUdqRjFjYmljZ0t5QnNhWE4wQ2lBZ0lDQXBPd29nSUgwc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzS2ZRb0tMeThnN1l5ZDdKZUZJT3lka2V1THRleVhrT3lFbkNCN2MyVjBjem9nVzN0eVpXRnpiMjRzSUdWc1pXMWxiblJ6T2x0N2NtOXNaU3gwWlhoMGZWMTlYWDBnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpWQnZjSFZ3S0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcA0KT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQnpaWFJ6U1c0Z1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTV6WlhSektTQS9JRzh1YzJWMGN5QTZJRnRkT3dvZ0lDQWdZMjl1YzNRZ2MyVjBjeUE5SUhObGRITkpiZ29nSUNBZ0lDQXViV0Z3S0NoemRDa2dQVDRnS0hzS0lDQWdJQ0FnSUNCeVpXRnpiMjQ2SUZOMGNtbHVaeWdvYzNRZ0ppWWdjM1F1Y21WaGMyOXVLU0I4ZkNBbkp5a3VkSEpwYlNncExBb2dJQ0FnSUNBZ0lHVnNaVzFsYm5Sek9pQkJjbkpoZVM1cGMwRnljbUY1S0hOMElDWW1JSE4wTG1Wc1pXMWxiblJ6S1FvZ0lDQWdJQ0FnSUNBZ1B5QnpkQzVsYkdWdFpXNTBjd29nSUNBZ0lDQWdJQ0FnSUNBZ0lDNXRZWEFvS0dWc0tTQTlQaUFvZXlCeWIyeGxPaUJUZEhKcGJtY29LR1ZzSUNZbUlHVnMNCkxuSnZiR1VwSUh4OElDY25LUzUwY21sdEtDa3NJSFJsZUhRNklGTjBjbWx1Wnlnb1pXd2dKaVlnWld3dWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tLSUNBZ0lDQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaGxiQ2tnUFQ0Z1pXd3VkR1Y0ZENrS0lDQWdJQ0FnSUNBZ0lEb2dXMTBzQ2lBZ0lDQWdJSDBwS1FvZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2h6ZENrZ1BUNGdjM1F1Wld4bGJXVnVkSE11YkdWdVozUm9LVHNLSUNBZ0lISmxkSFZ5YmlCelpYUnpMbXhsYm1kMGFDQS9JSE5sZEhNZ09pQnVkV3hzT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3Q2lBZ0lDQnlaWFIxY200Z2JuVnNiRHNLSUNCOUNuMEtDaTh2SU91TWdPMlpsTzJZbFNEc29KenNucEVnN0oyUjY0dTE3SmVRN0lTY0lIdHlaWEJzZVN3Z2MzVm5aMlZ6ZEdsdmJuTmJYWDBnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpVTnZiWEJ2YzJVb2NtRjNLU0I3DQpDaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXg3VzF4elhGTmRLbHg5THlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnZJRDBnU2xOUFRpNXdZWEp6WlNoektUc0tJQ0FnSUdOdmJuTjBJSEpsY0d4NUlEMGdVM1J5YVc1bktDaHZJQ1ltSUc4dWNtVndiSGtwSUh4OElDY25LUzUwY21sdEtDazdDaUFnSUNCamIyNXpkQ0J6ZFdkblpYTjBhVzl1Y3lBOUlFRnljbUY1TG1selFYSnlZWGtvYnlBbUppQnZMbk4xWjJkbGMzUnBiMjV6S1FvZ0lDQWdJQ0EvSUc4dWMzVm5aMlZ6ZEdsdmJuTUtJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tIZ3BJRDArSUNoN0lIUmxlSFE2SUZOMGNtbHVaeWdvZUNBbUppQjRMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tzSUhKbA0KWVhOdmJqb2dVM1J5YVc1bktDaDRJQ1ltSUhndWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1FvZ0lDQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb2VDa2dQVDRnZUM1MFpYaDBLUW9nSUNBZ0lDQTZJRnRkT3dvZ0lDQWdhV1lnS0hKbGNHeDVJSHg4SUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNrZ2NtVjBkWEp1SUhzZ2NtVndiSGtzSUhOMVoyZGxjM1JwYjI1eklIMDdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIMEtJQ0J5WlhSMWNtNGdiblZzYkRzS2ZRb0tMeThnNjdLSTdKZXRJT3lka2V1THRleVhrT3lFbkNCN2RISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVmU0RzdHBUc3Rwd2dLT3k5bE91VG5PMk9uT3lLcE1LMzdKV2U2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3BDbVoxYm1OMGFXOXVJSEJoY25ObFZISmhibk5zWVhSbEtISmhkeWtnZXdvZ0lHeGxkQ0J6SUQwZ1UzUnlhVzVuS0hKaGR5a3VkSEpwYlNncExuSmxjR3hoWTJVb0wxNWdZR0FvUHpwcWMyOXUNCktUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdieUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCamIyNXpkQ0IwY21GdWMyeGhkR1ZrSUQwZ1UzUnlhVzVuS0NodklDWW1JRzh1ZEhKaGJuTnNZWFJsWkNrZ2ZId2dKeWNwTG5SeWFXMG9LVHNLSUNBZ0lHbG1JQ2gwY21GdWMyeGhkR1ZrS1NCeVpYUjFjbTRnZXlCMGNtRnVjMnhoZEdWa0xDQmthWEpsWTNScGIyNDZJRk4wY21sdVp5Z29ieUFtSmlCdkxtUnBjbVZqZEdsdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOU93b2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3lWaE91ZW1PdWhuQ0FxTHlCOUNpQWdjbVYwZFhKdUlHNTFiR3c3Q24wS0NpOHZJT3lka2V1THRleVhrT3lFbkNCN2RHVjRkQ3dnY21WaGMyOXVmU0Ryc0xEc2w3UWc3TGFVDQo3TGFjSUNqc3ZaVHJrNXp0anB6c2lxVEN0K3lWbnV1U3BDRHNucUhyaTdRZzdaZUk3SnFwS1FwbWRXNWpkR2x2YmlCd1lYSnpaVk4xWjJkbGMzUnBiMjV6S0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljVzF0Y2MxeFRYU3BjWFM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdZWEp5SUQwZ1NsTlBUaTV3WVhKelpTaHpLVHNLSUNBZ0lHbG1JQ2hCY25KaGVTNXBjMEZ5Y21GNUtHRnljaWtwSUhzS0lDQWdJQ0FnY21WMGRYSnVJR0Z5Y2dvZ0lDQWdJQ0FnSUM1dFlYQW9LSGdwSUQwK0lDaDdJSFJsZUhRNklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5SbGVIUXBJSHg4SUNjbktTNTBjbWx0S0Nrc0lISmxZWE52YmpvZ1UzUnlhVzVuS0NoNA0KSUNZbUlIZ3VjbVZoYzI5dUtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwcEtRb2dJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tIZ3BJRDArSUhndWRHVjRkQ2s3Q2lBZ0lDQjlDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIMEtJQ0J5WlhSMWNtNGdXMTA3Q24wS0NpOHZJT3Vobk9xM3VPeWR1Q0R0bFlUc21wVEN0KzJWbk91UGhDRHN0SWpxczd3ZzdJT0I3WU9jN0oyOElPdVZqQ0F2YUdWaGJIUm9JT3loc08yYWpPcXdnQ0RzbUtUcnFiUWc2NUtrN0plUTdJU2NJT3liak91d2pleVhoZXlkaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwNjdPNDY0dWtJQ2d6TU95MGlPeVhrQ0F4NjdLSTY2ZU1LUzRLTHk4ZzdJU3g2ck8xN1pXWTY2bTBJT3F5c09xenZDRHRsYmpyazZUcm42enFzSUFnWTJ4aGRXUmxVM1JoZEhWelBTZHZheWZyb1p3ZzY1Q1k2NCtNNjZhczY2K0E2NkdjTENEc25xenJvWnpxdDdqc25iZ2c3WnVFSU91eWhPMkt2T3lkdENEc29JRHNvSWpyb1p3ZzhKK2ZvdXljdk91aG5DRHINCnM3WHF0NER0bFp6cmk2UXVDaTh2SUNqdGxJenJuNnpxdDdqc25ianNuYlFnNjZHYzZyZTQ3SjI0SU95d3ZleWRoQ0RzbDdBZzY1S2tJT3lqdk9xNHNPeWdnZXljdk91aG5DQXZhR1ZoYkhSbzY2VzhJT3loc08yYWpPMlZtT3VLbENEcXNvUHFzN3dnN0tlZDdKMkVJT3lkdE91anJPdUxwQ2tLTHk4ZzdaV2M2NCtFSU95MGlPcXp2T3VQaENEcXNKbnNuWUFnNnJLOTY2R2M2NkdjSU91enRlcTNnT3lMbk8yQ3FPdUxwQ0RpZ0pRZzZyU0E2NmFzN0o2UTZyQ0FJTzJWbk91UGhPdWx2Q0RzbUt6cm9LVHNvN3pxc2JEcmdwZ2c3WldjNjQrRTZyQ0FJT3kwaU9xNHNPMlpsT3VRbU91cHRBb3ZMeURzZ3F6c21xbnNucERxc0lBZzdKV0U2NnkwNnJLRDY0K0VJT3lWaUNEcmlJenJuNnpyajRRZzY3S0U3WXE4N0oyMElQQ2ZuNkxzbkx6cm9ad2c2NCtNN0pXRTdKaW82NHVrTGlEdGxaenJqNFRzbDVBZzZyRzQ2NmF3SU8yWXVPeTJuT3lkZ0NEcXNiRHNvSWpya0pqcnI0RHJvWndnN0lLczdKcXA2NStKN0oyQUlPeVZpQ0RyDQpncGpxc0lUcmk2UUtMeThnNnJPRTdLQ1Y3SjIwSUNvcTY3Q1c3SmVRN0lTY0tpb2c2N0NVNjRDUUlPcXlnK3lkaENEc2xZenNsWVRzc1lqcmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVEkyS1M0S0x5OGc3WVN3NjYrNDY0U1E3SjIwNjRLWUlPdTRqT3Vkdk95YXNPeWdnT3lYa095RW5DRHJpNlRycGJnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJWbU91cHRDRHNucERxc3Fuc3BwM3Jxb1VnN1l5TTdKMjg3SjJBSU91d2xPdUFqT3luZ091bmpDd2c3SjIwNjYrNElPdVdvQ0Rzbm9qcmlwUWdZMnhoZFdSbENpOHZJT3lFdU95Rm1PeWRnQ0RzaTV6cmo1bnRsYUFnNjVXTUlPdXdtK3lkZ0NEc21Kc2c2ck9FN0tDVklPeWVoZXllcGVxMmpPeWRoQ0RxdDdqcmpJRHJvWndnN0pPMDY0dWtJT0tHa2lEc2c0Z2c2ck9FN0tDVjdKZVFJT3lDck95YXFldWZpZXlkdENEcmdxanNsWVFnN0o2STdKYTA2NCtFSUNMdGxaenJqNFFnN0xTSTZyTzhJdXF3Z0Fvdkx5RHFzNFRzaG8wZzY0S1k3SmlvNjR1aw0KS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Eb2dJdXlEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NkdjNnJlNDdKMjQ3WmFJNjRxVTY0MndJT3labkNEcXQ3Z2c2ck9FN0tDVklPeUNyT3lhcWV1ZmlleWRoQ0RycXJzZzdKT3c2NE9RSWlrdUNpOHZJTzJVak91ZnJPcTN1T3lkdU95ZGhDRHFzYkRzdVp3ZzY2R2M2cmU0N0oyNHdyZnJvWnpxdDdqc2xZVHNtNE1vTDI5d1pXNHRiRzluYVc3Q3R5OWpiR0YxWkdVdGJHOW5iM1YwS2V5ZGdDQnJhV3hzVUhKdlkreWN2T3VobkNEc2hManNoWmpzbllRZzY3S0U2NkNrN0lTY0lPeWR0Q0Ryckxqc29KenFzSUFLTHk4ZzdKZUc3SmVJNjRxVTY0MndMQ0Ryc0pic2w1RHNoSndnNjdDVTZyNjQ2Nm0wSU91THBPdW1yT3F3Z0NEc2xZd2c2N0NwNjdLVjdKMjBJT3lYaHV5WGlPdUxwQzRnNnJlNDY1Nlk3SVNjSUM5b1pXRnNkR2dnN0tHdzdacU02NmVJNjR1a0lPMk1qT3lkdk95ZG1DRHFzNFRzb0pYcXM3d2c2N21FNnJXUTdaV2M2NHVrTGdvdkx5RHJ1WVRzbXFrZ01DanQNCmpJenNuYnpycDR3ZzdKMjk2ck9nTENCamJHRjFaR1ZCWTJOdmRXNTA3SjJZSURNdzdMU0lJT3k2a095TG5PdWx2Q0RxdDdqcmpJRHJvWndnN0pPMDY0dWtJT0tBbENBdVkyeGhkV1JsTG1wemIyN3NuYlFnN0x1azdJU2NJT3VucE91eWlDRHNuYjNzcDRBZzdKV0s2NHFVNjR1a0tTNEtMeThnNnJPRTdLQ1ZJT3llaU95ZGpDRGlocElnN0plRzdKMk1LT3Vobk9xM3VPeVZoT3liZ3lrZzY3Q3A3WmFsN0oyQUlPcXh0T3VUbk91bXJPeW5nQ0RzbFlycmlwVHJpNlE2SU8yTWpPeWR2T3lkaENEcmphN3NsclRzazdEcmlwUWc3SWljNnJDRUlPeWVvT3E1a0NEcnFyc2c3SjI5NjRxVUlPcXlnK3F6dkFvdkx5RHF0YXpydG9UcmtKanNwNEFnN0pXSzdKV0VJTzJYbXlEc25xenNpNXpzbnBIc25ZUWc2N2FBNjZXMDZyT2dMQ0RxdDdnZzY3Q3A3WmFsN0oyQUlPeWR1T3ltblNEc21LVHJwWmdnNnJLOTY2R2NLR2x6UVhWMGFFVnljbTl5S2Vxd2dDRHNuYlRycjdnZzdMS1k2NmFzN1pXYzY0dWtMZ3BtZFc1amRHbHZiaUJ5DQpaWE4wWVhKMFNXWkJZMk52ZFc1MFEyaGhibWRsWkNncElIc0tJQ0JwWmlBb0lYQnliMk1nZkh3Z2QyRnBkR1Z5S1NCeVpYUjFjbTQ3SUNBZ0lDQWdJQ0FnTHk4ZzdJUzQ3SVdZSU95WGh1eWRqQ2pyaTZUc25Zd2c3WVMwN0oyMElPeURpT3VobkNEc2k1enJqNWtwSUM4ZzdZUzBJT3luaE8yV2lTRHNwSkhzbmJUcnFiUWc2NHVrN0oyTUlPeWhzTzJhak95WGtPeUVuQW9nSUdOdmJuTjBJRzV2ZHlBOUlHTnNZWFZrWlVGalkyOTFiblFvS1RzS0lDQnBaaUFvSVc1dmR5QjhmQ0J1YjNjZ1BUMDlJSE5sYzNOcGIyNUJZMk52ZFc1MEtTQnlaWFIxY200N0NpQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU9xemhPeWdsZXlkdENEcnNKVHJnSXpzbDRqc2xyVHNtcFFnS0NjZ0t5QW9jMlZ6YzJsdmJrRmpZMjkxYm5RZ2ZId2dKK3lYaHV5ZGpDY3BJQ3NnSnlEaWhwSWdKeUFySUc1dmR5QXJJQ2NwSU9LQWxDRHNtSnNnNnJPRTdLQ1ZJT3lFdU95Rm1PeWRoQ0Ryc29UcnBxenFzNkFnN0lPSUlPcXpoT3lnbGV5Yw0Kdk91aG5DRHJpNlRzaTV3ZzdJdWM3SjZSN1pXcDY0dUk2NHVrTGljcE93b2dJQzh2SU95ZG1PdVBoT3lnZ1NEc29vWHJvNHdvY21WaGMyOXVJT3luZ095Z2xTa2c0b0NVSUZORlUxTkpUMDVmUkVsRlJPdWhuQ0RyZ1ozcmdyVHJxYlFnN0o2UTY0K1pJT3llck95TG5PdVBoT3F3Z0NEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcnByRHJpNlFLSUNCcmFXeHNVSEp2WXlnbjZyT0U3S0NWN0oyMElPdXdsT3VBak95V3RPeUVuQ0RzaExqc2haanNuWVFnN0lPSTY2R2NJT3lMbk95ZWtlMldpT3lXdE95YWxDRGlnSlFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1SnlrN0NpQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ2JuVnNiRHNnTHk4ZzdaV2M2NCtFd3Jmcm9aenF0N2pzbmJnZzdJT0I3WU9jNjRxVUlPcXpoT3lnbGV1bmlPdUxwQ0RyaTZUcnBiVHJpNlFnNG9DVUlPeURpQ0RxczRUc29KWHNuTHpyb1p3ZzY0dWs3SXVjSU8yTWtPeWdsZTJWbU9xeWpBb2dJSE5sYzNOcGIyNUINClkyTnZkVzUwSUQwZ2JtOTNPd3A5Q2dwc1pYUWdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEMGdNRHNLWm5WdVkzUnBiMjRnY21WMGNubEJkWFJvU1daT1pXVmtaV1FvS1NCN0NpQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QWhQVDBnSjJOc1lYVmtaUzFzYjJkdmRYUW5JQ1ltSUdOc1lYVmtaVk4wWVhSMWN5QWhQVDBnSjJOc1lYVmtaUzFzYVcxcGRDY3BJSEpsZEhWeWJqc0tJQ0JwWmlBb2QyRnBkR1Z5SUh4OElFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQQ0F6TURBd01Da2djbVYwZFhKdU95QXZMeURzcDRUdGxva2c3S1NSSU8yRXRDRHJzS250bGJRZzZyaUk3S2VBSUNzZ016RHN0SWdnNnJDRTZyS3BDaUFnYkdGemRFRjFkR2hTWlhSeWVVRjBJRDBnUkdGMFpTNXViM2NvS1RzS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU95ZXJPMlpsZXlkdUNEc2k1enJqNFRpZ0tZbktUc0tJQ0J5ZFc1VWRYSnVLQ2dwSUQwK0lDZnJvWnpxdDdqc25iZ2c3Wm1WDQo3SjI0N0pxcDdKMjA2NHVrTGlBaVQwc2k2NTI4NnJPZzY2ZU1JT3VMdGUyVm1PdWR2QzRuS1M1MGFHVnVLQW9nSUNBZ0tDa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHRtWlhzbmJqcmtLZ2c0b0NVSU95Z2xleURnU0RzZzRIdGc1enJvWndnNjdPMTZyZUFMaWNwTEFvZ0lDQWdLR1VwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbFlUc3A0RWc2NkdjNnJlNDdKMjRJT3lWaUNEcmtLZzZKeXdnVTNSeWFXNW5LR1V1YldWemMyRm5aU2t1YzJ4cFkyVW9NQ3dnT0RBcEtRb2dJQ2s3Q24wS0NpOHZJT3lMcE8yTXFDRHNuWkhyaTdYc25ZUWc3SUtzNjU2TTdKcXBJT3lWaU91Q3RPdWhuQ0RyczREdG1aZ2c0b0NVSU95YmtPeWR1Q2pyb1p6cXQ3anNuYmd2N0lTazdMbVlLZXlkdENEdGpJenNsWVhya0p3ZzZySzk3SnF3N0plVUlPcTN1Q0RzbFlqcmdyVHJwYndzSU95VmhPdUxpT3VwdENEc29KSHJrWkRzbHJRcjdKdVE2Nnk0N0oyRUlPdXp0T3VDdU91TA0KcEFwbWRXNWpkR2x2YmlCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUhCeVpXWnBlQ2tnZXdvZ0lHbG1JQ2hsSUNZbUlHVXViV1Z6YzJGblpTQTlQVDBnVEU5SFNVNWZSMVZKUkVVcElISmxkSFZ5YmlCN0lHVnljbTl5T2lCTVQwZEpUbDlIVlVsRVJTd2djSEp2WW14bGJUb2dKMk5zWVhWa1pTMXNiMmR2ZFhRbklIMDdDaUFnYVdZZ0tHVWdKaVlnWlM1dFpYTnpZV2RsSUQwOVBTQk1TVTFKVkY5SFZVbEVSU2tnY21WMGRYSnVJSHNnWlhKeWIzSTZJRXhKVFVsVVgwZFZTVVJGTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFd4cGJXbDBKeUI5T3dvZ0lHbG1JQ2hqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y3BJSHNLSUNBZ0lISmxkSFZ5YmlCN0lHVnljbTl5T2lBbjdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmxLR05zWVhWa1pTbnFzSUFnN0lTazdMbVk2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFFnNG9DVUlPeUVwT3k1bU8yVm1PcXpvQ0Ryb1p6cXQ3anNuYmp0bFp3ZzY1S2sNCklPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3NJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y2dmVHNLSUNCOUNpQWdjbVYwZFhKdUlIc2daWEp5YjNJNklIQnlaV1pwZUNBcklDaGxJQ1ltSUdVdWJXVnpjMkZuWlNBL0lHVXViV1Z6YzJGblpTQTZJRk4wY21sdVp5aGxLU2tnZlRzS2ZRb0tablZ1WTNScGIyNGdjbVZoWkVKdlpIa29jbVZ4S1NCN0NpQWdjbVYwZFhKdUlHNWxkeUJRY205dGFYTmxLQ2h5WlhOdmJIWmxLU0E5UGlCN0NpQWdJQ0JzWlhRZ1ltOWtlU0E5SUNjbk93b2dJQ0FnY21WeExtOXVLQ2RrWVhSaEp5d2dLR01wSUQwK0lIc2dZbTlrZVNBclBTQmpPeUI5S1RzS0lDQWdJSEpsY1M1dmJpZ25aVzVrSnl3Z0tDa2dQVDRnZXdvZ0lDQWdJQ0IwY25rZ2V5QnlaWE52YkhabEtFcFRUMDR1Y0dGeWMyVW9ZbTlrZVNrcE95QjlJR05oZEdOb0lDaGZaU2tnZXlCeVpYTnZiSFpsS0h0OUtUc2dmUW9nSUNBZ2ZTazdDaUFnZlNrN0NuMEtDbU52Ym5OMElFTlBVbE5mDQpTRVZCUkVWU1V5QTlJSHNLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUM0pwWjJsdUp6b2dKeW9uTEFvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFOWlhSb2IyUnpKem9nSjBkRlZDd2dVRTlUVkN3Z1QxQlVTVTlPVXljc0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFVobFlXUmxjbk1uT2lBblEyOXVkR1Z1ZEMxVWVYQmxKeXdLZlRzS1puVnVZM1JwYjI0Z2FuTnZiaWh5WlhNc0lITjBZWFIxY3l3Z2IySnFLU0I3Q2lBZ2NtVnpMbmR5YVhSbFNHVmhaQ2h6ZEdGMGRYTXNJRTlpYW1WamRDNWhjM05wWjI0b2V5QW5RMjl1ZEdWdWRDMVVlWEJsSnpvZ0oyRndjR3hwWTJGMGFXOXVMMnB6YjI0N0lHTm9ZWEp6WlhROWRYUm1MVGduSUgwc0lFTlBVbE5mU0VWQlJFVlNVeWtwT3dvZ0lISmxjeTVsYm1Rb1NsTlBUaTV6ZEhKcGJtZHBabmtvYjJKcUtTazdDbjBLQ21OdmJuTjBJSE5sY25abGNpQTlJR2gwZEhBdVkzSmxZWFJsVTJWeWRtVnlLR0Z6ZVc1aklDaHlaWEVzSUhKbA0KY3lrZ1BUNGdld29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjBkRlZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OW9aV0ZzZEdnbktTQjdDaUFnSUNCeVpYTjBZWEowU1daQlkyTnZkVzUwUTJoaGJtZGxaQ2dwT3lBdkx5RHJzSmJzbDVEc2hKd2c2ck9FN0tDVjdKMkVJT3V3bE9xL3FPeWN2T3VwdENEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJxTHpzb0lBZzY3S0U2NmF3NjR1a0lDanNsWVRybnBnZzdKdU02N0NON0plRjdKMjBJT3lZbXlEcXM0VHNvSlhzbkx6cm9ad2c2NCtNN0tlQUlPeVZpdXF5akNrS0lDQWdJSEpsZEhKNVFYVjBhRWxtVG1WbFpHVmtLQ2s3SUM4dklPdWhuT3EzdU95ZHVDRHRsWVRzbXBRZzdJT0I3WU9jNjZtMElPeWVyTzJabGV5ZHVDRHNpNXpyajRRZzRvQ1UNCklPeWVyT3Vobk9xM3VPeWR1T3lkdENEcmdaM3JncXpzbkx6cnFiUWc2NHVrN0oyTUlPeWhzTzJhak91MmdPMkVzQ0J3Y205aWJHVnQ3SjIwSU8yU2dPdW1zT3VMcEFvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzS0lDQWdJQ0FnYjJzNklIUnlkV1VzSUdWdVoybHVaVG9nSjJOc1lYVmtaU2NzSUhZNklFSlNTVVJIUlY5V0xDQmthWEk2SUY5ZlpHbHlibUZ0WlN3Z0x5OGdkc0szWkdseU9pRHF0YXpyc29Uc29JUXY3SmVKNjVxeDdaV2NJT3lDck91enVPeWR0Q0RybHFBZzdKNkk2NHFVN0tlQUlPeW5oT3VMcU95YXFRb2dJQ0FnSUNCdGIyUmxiRG9nWTNWeWNtVnVkRTF2WkdWc0xDQnRiMlJsYkhNNklFRk1URTlYUlVSZlRVOUVSVXhUTENCbGVHRnRjR3hsY3pvZ1JWaEJUVkJNUlZNdWJHVnVaM1JvTENCbmRXbGtaVG9nUjFWSlJFVXViR1Z1WjNSb0xDQnlaV0ZrZVRvZ2QyRnliV1ZrVlhBc0NpQWdJQ0FnSUhCeWIySnNaVzA2SUNoamJHRjFaR1ZUZEdGMGRYTWdQVDA5SUNkdmF5Y2dmSHdnDQpZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQnVkV3hzS1NBL0lHNTFiR3dnT2lCamJHRjFaR1ZUZEdGMGRYTXNDaUFnSUNBZ0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3S0lDQWdJQ0FnYzJWeWRtVmtPaUJ6ZEdGMGN5NXpaWEoyWldRc0lHeGhjM1JCZERvZ2MzUmhkSE11YkdGemRFRjBMQ0JzWVhOMFZHVjRkRG9nYzNSaGRITXViR0Z6ZEZSbGVIUXNJR3hoYzNSVFpXTTZJSE4wWVhSekxteGhjM1JUWldNc0NpQWdJQ0I5S1RzS0lDQjlDaUFnTHk4ZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEaWdKUWc2NEdLNnJpdzY2bTBJT3ljaENEcXNKRHNpNXdnN1lPQTdKMjA2Nmk0NnJDQUlPdUxwT3Vtck91bHZDRHJnWWpyaTZRS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmFHVmhjblJpWldGMEp5a2dld29nSUNBZ2JHRnpkRUpsWVhRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeQ0KTURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ2ZRb2dJQzh2SU91aG5PcTN1T3lkdUNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0N0oyWUlGdnduNStnSU8yQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJnZzdaV0U3SnFVWGNLM1cvQ2ZsSkZkSU91eWhPMkt2T3lkdENEdG1ManN0cHp0bFp6cmk2UXVDaUFnTHk4ZzZyaXc2N080S091NGpPdWR2T3lhc095Z2dDRHNwNEh0bG9rcE9pQmdZMnhoZFdSbElHRjFkR2dnYkc5bmFXNGdMUzFqYkdGMVpHVmhhV0RycGJ3ZzdJaW83SjJBSU8yVWhPdWhuT3lFdU95S3BPdWhuQ0RzaTZUdGxva2c0b0NVSU91cGxPdUp0Q0RzbDRic25iUWc2ck9uN0o2bElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHFzNkFzQ2lBZ0x5OGdJQ0JzYjJOaGJHaHZjM1FnN0lpWTdJdWdJTzJQck8yS3VPdWhuQ0Rxc3JEcXM3enJwYndnN0o2UTY0K1pJT3lJbU91Z3VlMlZuT3VMcENqc2k2VHN1S0U2SU8yWHBPdVRuT3Vtck95S3BPeVhrT3lFbk91UGhDRHJ1SXpybmJ6c21yRHNvSUFnN0plMDY2YTgNCklDc2dURWxUVkVWT0lPMlpsZXlkdUN3Z01qQXlOaTB3TnlrdUNpQWdMeThnSUNEdGhMRHJyN2pyaEpEc25iUWc3Wm1VNjZtMDdKZVFJT3lnaE8yWWdDRHNsWWdnNjV5czY0dWtMaURydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNDY2ZU1JTzJWbU91cHRDRHJnWjB1Q2lBZ0x5OGc3WSswNjdDeEtPMkVzT3V2dU91RWtDazZJT3lla091UG1TRHNtWVRybzR6cXNJQWc2NmVKN1o2TUlPMlptT3F5dlNqcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wN0plUUlPdXF1eURyaTcvc2xZUWc3TDJVNjVPYzZyQ0FJT3V6dE95ZHRPdUtsQ0Rxc3Izc21yQXA3SmVRN0lTY0NpQWdMeThnSUNEcm9aenF0N2pzbmJnZzY0eUE2cml3SU95a2tTRHJzb1R0aXJ6c25ZUWc2NWlRSU91SWhPdWx0T3VwdEN3ZzdMMlU2NU9jNjZXOElPdTJtZXlYck91RW8reWRoQ0RzaUpnZzdKNkk2NHFVSU8yRXNPdXZ1T3VFa0NEcnNLbnNpNTNzbkx6cm9ad2c3S0NFN1ptWTdaV2M2NHVrTGdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrDQpJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl2Y0dWdUxXeHZaMmx1SnlrZ2V3b2dJQ0FnWTI5dWMzUWdZbTlrZVNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdDaUFnSUNCamIyNXpkQ0J6ZDJsMFkyaE5iMlJsSUQwZ0lTRW9ZbTlrZVNBbUppQmliMlI1TG5OM2FYUmphRUZqWTI5MWJuUXBPeUF2THlEcXM0VHNvSlVnN0tDRTdabVlJRDBnN0l1YzdZR3M2NmEvSU95d3ZleWN2T3VobkNEc2w3VHNsclFnNnJPRTdLQ1Y3SjJFSU9xem9PdWx2Q0RzaUpnZzdKNkk2cktNQ2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0F2THlCamJHRjFaR1hxc0lBZzdKZUc3Snk4NjZtMElPeVhyT3E0c095RW5DRHJnWXJyaXBUcmk2UXVJSE5vWld4c09uUnlkV1hybmJ3Z1kyeGhkV1JsNnJDQUlPeVhodXlXdE91UGhDRHNoYmpzbllBZzdLQ1Y3SU9CSU95THBPMldpZXVQdkFvZ0lDQWdJQ0F2THlCemNHRjNidXlkbUNBblpYSnliM0luNnJDQUlPeVZpQ0RybktqcXM2QXNJT3lZaU95Z2hPeVhsQ0RxdDdqcg0KaklEcm9ad2diMnM2ZEhKMVpldWx2Q0RyajR6cm9LVHNwS3pyaTZRZzRvQ1VDaUFnSUNBZ0lDOHZJTzJVak91ZnJPcTN1T3lkdU95ZGdDQWk2N2lNNjUyODdKcXc3S0NBNjZXOElPeVh0T3lYaU95V3RPeWFsQ0xybmJ6cXM2QWc3WldZNjRxVTY0MndJT3lMcE95Z25PdWhuT3VLbENEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU91Y3FPdUtsQ0RzZzRIdGc1enFzSUFnNjVDUTY0dWtLT3lMcE95Z25DRHNpNkRxczZBcExnb2dJQ0FnSUNCcFppQW9ZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQW5ZMnhoZFdSbExXMXBjM05wYm1jbktTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNREVzSUhzS0lDQWdJQ0FnSUNBZ0lHVnljbTl5T2lBbjdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95WGh1eVd0T3lhbENEaWdKUWc3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKMjBJT3VRbU91S2xPeW5nQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGljc0NpQWcNCklDQWdJQ0FnSUNCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuTEFvZ0lDQWdJQ0FnSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUM4dklPeW5oTzJXaVNEc3BKSHNuYmpyamJBZzY1aVFJT3VJak91Z2dPdUxwQ0RpZ0pRZzdKdVE3TG1aN0oyQUlDTHJ1SXpybmJ6c21yRHNvSURyb1p3ZzY0dWs3SXVjSU95WHRPcTRzQ0xyaTZRdUlPMkVzT3V2dU91RWtPeWRnQ0FxS3V5d3ZleWRoQ0RzbFlUcnJMVHFzb1ByajRRZzY2cTdJT3VkaE95Ym9PeWRoQ0RybFl6cnA0d3FLaTRLSUNBZ0lDQWdMeThnN0ppSTdLQ0U3SmVVSUNjMk1PeTBpQ0RyaEpqcXNvd2c2NHlBNnJpd0lPeWtrZXlkdE91cHRDRHRoTERycjdqcmhKQW43SjIwN0plSTY0cVU2NDJ3TENEcm9aenF0N2pzbmJnZzdabVU2Nm0wN0oyRUlPeWR2ZXF4c091Q21DRHNucURxdVpBZzY1UzBJT3lkdkNEdGxaanJpNlFnNjR1azdJdWNJT3VJaE91bHVBb2dJQ0FnSUNBdkx5RHNvSlhzZzRIc29JSHNuYmdnNnJLOTdKcXc3SmVRNjQrRUlHTnRaQ0RzDQpzTDNzbmJRZzdZcUE3SmEwNjRLWTdKbVU2NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Eb2dJdTJFc091dnVPdUVrQ0R0bVpUcnFiVHNuWUFnN0ptY0lPdVdvQ0Rxc0pIc25wRHF1TEFpS1M0S0lDQWdJQ0FnTHk4ZzdKMjA3S0NjSU95YXNPdW1yT3F3Z0NEc3NMM3NuWVFnN0tlQjdLQ1JJT3lYdE9xem9DRHNoTEhxczdVZzdKZXM2N2FBS0d4dloybHVWMmx1Wkc5M1QzQmxibVZrS2V1bHZDRHNsWVRyaTRqcXVZd3NJT3lMbk9xd2hPeWR0Q0RzbFlUcmk0anJuYndnNnJlNElPeUNyT3lMcE91aG5DRHRqSkRyaTZqdGxaenJpNlF1Q2lBZ0lDQWdJR052Ym5OMElITjBZV3hsSUQwZ2JHOW5hVzVRY205aklDWW1JQ0ZzYjJkcGJsZHBibVJ2ZDA5d1pXNWxaQ0FtSmlBb1JHRjBaUzV1YjNjb0tTQXRJR3h2WjJsdVUzUmhjblJsWkVGMElENGdNakF3TURBcE93b2dJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpJQ1ltSUhOMFlXeGxLU0I3Q2lBZ0lDQWdJQ0FnYTJsc2JFeHZaMmx1VUhKdll5Z3BPd29nSUNBZw0KSUNBZ0lHbG1JQ2doYjNCbGJreHZaMmx1VkdWeWJXbHVZV3dvS1NrZ2V3b2dJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNREVzSUhzZ1pYSnliM0k2SUNmc25iUWdUMVBzbDVEc2hLQWc3SjZRNjQrWjdKeTg2NkdjSU91cXV5RHNsN1RzbHJUc21wUWc0b0NVSU8yRXNPdXZ1T3VFa095WGtPeUVuQ0JqYkdGMVpHVWc3SXVrN1phSklPMmJoQ0F2Ykc5bmFXNGc3WlcwSU95anZPeUV1T3lhbEM0bklIMHBPd29nSUNBZ0lDQWdJSDBLSUNBZ0lDQWdJQ0F2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NS0hKbFlYTnZiaURzcDREc29KVXBJT0tBbENEc3A0VHRsb2tnN0tTUklPMkV0T3lkaENCVFJWTlRTVTlPWDBSSlJVVHJvWndnNjRHZDY0SzA2Nm0wSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRxc0lBZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2YXc2NHVrQ2lBZ0lDQWdJQ0FnYTJsc2JGQnliMk1vSit1aG5PcTN1T3lkdU95ZGhDRHNwNFR0bG9udGxaanJpcFFnN0tTUjdKMjANCjY1MjhJT3lhbE95eXJleWRoQ0RzcEpIcmk2anRsb2pzbHJUc21wUWc0b0NVSU91aG5PcTN1T3lkdUNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeWs3Q2lBZ0lDQWdJQ0FnWVdOamIzVnVkRU5oWTJobExtRjBJRDBnTURzS0lDQWdJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJTzJQdE91d3NTRGlnSlFnN1lTdzY2KzQ2NFNRSU91d3FleUxuZXljdk91aG5DRHNvSVR0bVpndUp5azdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHMXZaR1U2SUNkMFpYSnRhVzVoYkNjZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ0x5OGc2N0NwNnJpSUlPeUxuT3lla2UyVm5DRHJvWnpxdDdqc25ianNuYlFnN0lLMDdKV0VJT3llaU95Y3ZPdXB0Q0RzaHBEcmpJRHNwNEFnN0pXSzY0cVU2NHVrSU9LQWxDRHNvNzNzbmJUcnFiUWc3SUtzN0pxcDdKNlE2ckNBSU91enRPcXpvQ0Rzbm9qcmlwUWc3WU90DQo3SjJZSU95OW5PdXdzU0R0ajZ6dGlyanFzSUFLSUNBZ0lDQWdMeThnNjR1cjdaaUFJQ0pzYjJOaGJHaHZjM1RzbDVEc2hKd2c3SmV3NnJLdzdKMkVJT3F4c091MmdPMldpT3lLdGV1TGlPdUxwQ0xxc0lBZzY1eXM2NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Da3VDaUFnSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk1nSmlZZ1JHRjBaUzV1YjNjb0tTQXRJR3h2WjJsdVUzUmhjblJsWkVGMElEd2dNVFV3TURBcElIc0tJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU95d3ZleWR0Q0RzbmJUcnI3Z2c3SmUwNjZDa0lPeWVpT3lXdE95YWxDRGlnSlFnN0lPSTY2R2NJT3lYdE95bmdDRHNsWXJxczZBZzZyZTRJT3l3dmV5ZGhDRHNrN0RzaExqc21wUXVKeWs3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJRzF2WkdVNklDZGhiSEpsWVdSNUxXOXdaVzRuSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUd0cA0KYkd4TWIyZHBibEJ5YjJNb0tUc2dMeThnN0pXZTdJU2dJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqc25iUWc2NHlBNnJpd0lPeWtrZXlkdE91cHRDRHNvSkhxczZBZzdJT0k2NkdjSU95WHNPdUxwQ0FvN0xDOTdKMkVJT3VMcSt5Vm1PcXhzT3VDbUNEcmk2VHNpNXdnNjRpRTY2VzRJT3F5dmV5YXNDa0tJQ0FnSUNBZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNCc2IyZHBibGRwYm1SdmQwOXdaVzVsWkNBOUlHWmhiSE5sT3lBdkx5RHNuYlRyc29nZzdJdWM2NCtFN0oyWUlPeXd2U0RzbDdUcXVMQWc3SVN4NnJPMUlPeVhyT3UyZ0NEaWdKUWc3SldFNjU2WTdKZVE3SVNjSU95RXVPeWF0T3VMcEFvZ0lDQWdJQ0F2THlCQ1VrOVhVMFZTNjRxVUlPcXh0T3VUbk91bXJPeW5nQ0RzbFlycmlwVHJpNlFnNG9DVUlFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lYdE9xem9DQnNiMk5oYkdodmMzVHJvWndnNnJLdzZyTzg2Nlc4SU95ZWtPdVANCm1TRHNpSmpyb0xudGxaenJpNlFLSUNBZ0lDQWdMeThnS095Y2hDQW42NkdjNnJlNDdKMjQ3SjJBSUVOTVNlcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNjZXOElPeW5nZXlna1NEc2w3VHFzb3dnN1pXYzY0dWtKeURzbzd6c2hKMGc0b0NVSU9xd2dPdWhuT3l4aE91cHRDRHN2WlRyazV3ZzY3YVo3SmVzNjRTajZyaXdJTzJabE91cHRPeWR0Q0Rybkt6cmk2UXBMZ29nSUNBZ0lDQXZMeUFxS3VxemhPeWdsU0Rzb0lUdG1aanNuWUFnN0p1NUlPdWhuT3EzdU95VmhPeWJnK3lkaENEcnFMenNvSUFnN0pldzY0dWtLaW9vTWpBeU5pMHdPQ3dnUWxKSlJFZEZYMVk5TXpFcE9pRHJ1SXpybmJ6c21yRHNvSURzbDVBZzdJUzQ3SVdZN0oyMElPdUNxT3lWaENEc25vanNuTHpycWJRS0lDQWdJQ0FnTHk4Z1lYVjBhRzl5YVhwbDZyQ0FJT3F6aE95Z2xleWRoQ0Ryckx2c3A0QWc3SldLNnJPZ0lPeUt1ZXlkdUNEdG1aVHJxYlRycDR3ZzY1MkU3SnEwNjR1a0tDTHNpcm5zbmJnZzdabVU2Nm0wSU91bmtPcXpvQ0RyDQpvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKeTg2NkdjSU9xd2dPcXpvQ0RzaTdicmk2UWlJT3lhbE9xMXJDa3VDaUFnSUNBZ0lDOHZJT3lFdU95Rm1PeWRoQ0RzcDREc21yUWc2NUtrSU95WHRPdXB0Q0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA2N2FBN1lTd0lPdUNtT3lZcU91THBDRGlnSlFnVlZKTTdKMkVJT3F3Z09xenRlMlZtT3luZ091UGhDanNzclRzbmJUcmk1MGc3SXVrN1l5b0tTd2dRbEpQVjFORlV1dWx2Q0Rxc0lEcm9aenNzWVRzcDREcmo0UUtJQ0FnSUNBZ0x5OGdLT3k5bE91VG5DRHJ0cG5zbDZ6cmhLUHF1TEFnN0p5ZzY3Q2NLU3dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3F6b091bHRPeW5nT3VQaENqcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQUlPeVZoT3VMbUNrZzdKV0s2NHFVSU95Y29PeWR2TzJWbkNEcnNLbnJzcFV1Q2lBZ0lDQWdJQzh2SU91MmdPeWVrZXlhcVRvZzY3aU02NTI4N0pxdzdLQ0E3SjJZSUdOc1lYVmtaU0RzbTdrZzY2R2M2cmU0N0oyNDY0K0VJTzJTZ091bXNPdUxwQ0RpZ0pRZw0KNnJPRTdLQ1Y3SjJFSU91d2xPcSt1T3VncE91S2xDRHNuWmpyajRUc21ZQWc2N0NwN1phbDdKMjBJT3F3bWV5VmhDRHNpSmpzbXFrdUNpQWdJQ0FnSUdOdmJuTjBJSE4wWVhKMFRHOW5hVzRnUFNBb0tTQTlQaUI3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdkR2hwYzB4dloybHVJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuWVhWMGFDY3NJQ2RzYjJkcGJpY3NJQ2N0TFdOc1lYVmtaV0ZwSjEwc0lIc0tJQ0FnSUNBZ0lDQWdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzQ2lBZ0lDQWdJQ0FnSUNCa1pYUmhZMmhsWkRvZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBaFBUMGdKM2RwYmpNeUp5d2dMeThnYTJsc2JFeHZaMmx1VUhKdlkreWRtQ0RxdDdqcm83a2dhMmxzYk95YXFTQW9hMmxzYkZCeWIyUHFzN3dnNjQrWjdKMjhJTzJNcU8yRXRDa0tJQ0FnSUNBZ0lDQjlLVHNLSUNBZ0lDQWdJQ0JzYjJkcGJsQnkNCmIyTWdQU0IwYUdselRHOW5hVzQ3Q2lBZ0lDQWdJQ0FnYkc5bmFXNVhhVzVrYjNkUGNHVnVaV1FnUFNCMGNuVmxPeUF2THlCRFRFbnFzSUFnN0plczY0cVVJT3F4dENEcXRJRHNzTER0bGFBZzdJaVlJT3lYaHV5Y3ZPdUxpQ0RzbDdUcnByQWc2cktEN0p5ODY2R2NJT3V6dU91THBDQW83SjZzN1lHMDY2YXQ3SmVRSU8yRXNPdXZ1T3VFa0NEcnNLbnNwNEFwQ2lBZ0lDQWdJQ0FnZEdocGMweHZaMmx1TG05dUtDZGxjbkp2Y2ljc0lDZ3BJRDArSUhzZ2FXWWdLR3h2WjJsdVVISnZZeUE5UFQwZ2RHaHBjMHh2WjJsdUtTQnNiMmRwYmxCeWIyTWdQU0J1ZFd4c095QjlLVHNLSUNBZ0lDQWdJQ0IwYUdselRHOW5hVzR1YjI0b0oyTnNiM05sSnl3Z0tHTnZaR1VwSUQwK0lIc0tJQ0FnSUNBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJNZ0lUMDlJSFJvYVhOTWIyZHBiaWtnY21WMGRYSnVPd29nSUNBZ0lDQWdJQ0FnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNLSUNBZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTlVhVzFsDQpjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9iRzluYVc1UWNtOWpWR2x0WlhJcE95QnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlHNTFiR3c3SUgwS0lDQWdJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQzh2SU95RGlDRHFzNFRzb0pYc25id2c3SWlZSU95ZWlPeWN2T3VMaUNEcmk2VHNuWXdnTDJobFlXeDBhQ0RybFl3ZzY0dWs3SXVjSU95ZHZlcTRzQW9nSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN0tDSTdMQ29JT3lpaGV1ampDQW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BKeWs3Q2lBZ0lDQWdJQ0FnSUNBdkx5RHNncXpybm96c25iUWc2NkdjNnJlNDdKMjQ3WldnSU95TG5PcXdoT3VQaENEc2w0YnNuYlFnNnJPbjY3Q1U2NkdjSU95THBPMk1xT3VobkNEcmdaM3JncXpyaTZRZ1BTQmpiR0YxWkdYcXNJQWc3SmVHNnJHdzY0S1lJT3lMcE8yV2lleWR0Q0RzbFlnZzY1Q2NJT3F5Z3k0S0lDQWdJQ0FnSUNBZw0KSUM4dklPeWRrZXVMdGV5ZGdDRHNuYlRycjdnZzY3TzA2NE9JN0p5ODY0dUlJT3lEZ2UyRG5PdWx2Q0RyaTZUc2k1d2c3SjZzN0lTY0lDOW9aV0ZzZEdqcm9ad2c3SldNNjZhdzY0dWtJQ2p0bEl6cm42enF0N2pzbmJqc25iUWc2NHlBNnJpd0lPMlpsT3VwdE95ZGhDRHNpNlR0aktqcm9ad2c2N0NVNnI2ODY0dWtLUzRLSUNBZ0lDQWdJQ0FnSUdsbUlDaGpiMlJsSUNFOVBTQXdJQ1ltSUVSaGRHVXVibTkzS0NrZ0xTQnNiMmRwYmxOMFlYSjBaV1JCZENBOElEVXdNREFwSUhzS0lDQWdJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdU95ZHRDRHNwb25zaTV3ZzdJdWs3WXlvNjZHY0lPdUJuZXVDcUNEaWdKUWdRMnhoZFdSbElFTnZaR1VnN0lTazdMbVlJT3lEZ2UyRG5PdWx2Q0RyaTZUc2k1d2c3S0NRNnJLQTdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ0lDQWdJQ0FnSUNCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BPd29nSUNBZ0lDQWdJQ0FnZlFvZ0lDQWcNCklDQWdJSDBwT3dvZ0lDQWdJQ0FnSUM4dklETXc2N2FFSU9LQWxDRHNuYlFnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lqdmV5Y3ZPdXB0Q0RydUl6cm5ienNtckRzb0lBZzdMMmM2N0N4N0oyMElPcXdpQ0JzYjJOaGJHaHZjM1FnN1krczdZcTQ2NCtFSU91THErMllnQ0FuN0pldzZyS3c3SjJFSU9xeHNPdTJnTzJXaU95S3RldUxpT3VMcENmcXNJQWc2NXlzNjR1a0xnb2dJQ0FnSUNBZ0lDOHZJT3lZaU95Z2hDQXhNT3UyaE95ZGdDRHNwNmZzbFlUc2hKd3NJT3Vobk9xM3VPeWR1TzJWbU91THBDRHNucURxdVpBZzY0dWs2Nlc0SU95ZHZPeWRoQ0R0bFpqcnFiUWc3WU90N0oyMElPdXN0TzJhcU9xd2dDRHJrSkRyaTZRb01qQXlOaTB3T0NEc2k2VHN1S0VnN0l1ZzZyT2dLUzRLSUNBZ0lDQWdJQ0JzYjJkcGJsQnliMk5VYVcxbGNpQTlJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdleUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNElETXc2N2FFSU9xeXZlcXp2Q0RpZ0pRZzY0eUE2cml3DQpJTzJVaE91aG5PeUV1T3lLcENEc29KWHJwcXd1SnlrN0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ2ZTd2dNVGd3TURBd01DazdDaUFnSUNBZ0lIMDdDaUFnSUNBZ0lDOHZJT3F6aE95Z2xTRHNvSVR0bVpqcmo0UWc2ckNaN0oyQUlPcXl2ZXVobk91THBDRGlnSlFnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdLZUI3S0NSSU95WHNPdUxwQ2p0ZzYwZ01lcXduQ3dnN0o2UTY0K1pJT3laaE91ampDa3VDaUFnSUNBZ0lDOHZJT3lLdWV5ZHVDRHRtWlRycWJUc25iUWc2NXlvNjZtMElPcTN1Q0R0bVpUcnFiUWc3WldZNjR1b0lGdnFzNFRzb0pVZzdLQ0U3Wm1ZWGV5Y3ZPdWhuQ0RyaTZUcnBiZ2c2ck9FN0tDVjdKMkVJT3F6b091bHVPdUxwQzRnN0oyMDdKeWc2NHFVSU95Y2hDRHNvN3pzaEowZzdMQzQ2ck9nTGdvZ0lDQWdJQ0J6ZEdGeWRFeHZaMmx1S0NrN0NpQWdJQ0FnSUM4dklPdUNvZXlkZ0NEc25vWHNucVhxdG96c25ZUWc2Nnk4NnJPZ0lPeWVpT3VLbENEcmpJRHF1TEFnN0lTNA0KN0lXWTdKMkFJT3V5aE91bXNPdUxwQ0RpZ0pRZzdKNnM2NkdjNnJlNDdKMjRJTzJiaENEcmk2VHNuWXdnN0pxVTdMS3Q3SjIwSU95RGlDRHNoTGpzaFpnbzdJT0lJT3llaGV5ZXBlcTJqQ25zbkx6cm9ad2c3SXVjN0o2UjdaV1k2cktNTGdvZ0lDQWdJQ0F2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NS0hKbFlYTnZiaURzcDREc29KVXBJT0tBbENCVFJWTlRTVTlPWDBSSlJVVHJvWndnNjRHZDY0SzA2Nm0wSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRxc0lBZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2Q2tDaUFnSUNBZ0lDOHZJT3llck91aG5PcTN1T3lkdUNEcmtxVHNsNURyajRRZ1RVRllYMVJWVWs1VDZybU03S2VBSU95WW15RHFzNFRzb0pYc25MenJvWndnN0xLWTY2YXM2NUNZNjRxVUlPdXloT3EzdU9xd2dDRHJrSnpyaTZRZ0tESXdNall0TURjZzY2YXM2N2V3N0plUTdJU2NJTzJabGV5ZHVDa0tJQ0FnSUNBZ2EybHNiRkJ5YjJNb0ordWhuT3EzdU95ZHVPeWRoQ0RzcDRUdGxvbnQNCmxaanJpcFFnN0tTUjdKMjA2NTI4SU95YWxPeXlyZXlkaENEc3BKSHJpNmp0bG9qc2xyVHNtcFFnNG9DVUlPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1SnlrN0NpQWdJQ0FnSUdGalkyOTFiblJEWVdOb1pTNWhkQ0E5SURBN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU95TG5PeWVrU2NnS3lBb2MzZHBkR05vVFc5a1pTQS9JQ2NnS09xemhPeWdsU0Rzb0lUdG1aZ2c0b0NVSU95S3VleWR1Q0R0bVpUcnFiVHNuYlFnNjV5bzY2bTBJT3EzdUNEdG1aVHJxYlFnN1pXWTY0dW9JRnZxczRUc29KVWc3S0NFN1ptWVhleWN2T3VobkNEcmk2VHJwYmdnNnJPRTdLQ1Y3SjJFSU9xem9PdWx2Q0RzaUpnZzdKNkk3SmEwN0pxVUtTY2dPaUFuSnlrZ0t5QW5JT0tBbENEcm9aenF0N2pzbmJqdGxaanJxYlFnN0o2UTY0K1pJT3lYc09xeXNPdVFxZXVMaU91THBDNG5LVHNLSUNBZ0lDQWdjbVYwDQpkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUcxdlpHVTZJSE4zYVhSamFFMXZaR1VnUHlBblluSnZkM05sY2kxemQybDBZMmduSURvZ0oySnliM2R6WlhJbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNQ3dnZXlCbGNuSnZjam9nSit1aG5PcTN1T3lkdUNEc3NMM3NuWVFnNjZxN0lPeVh0T3lYaU95V3RPeWFsRG9nSnlBcklHVXViV1Z6YzJGblpTQjlLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGdLTzJFc091dnVPdUVrQ0R0ajdUcnNMRWc2cldzN1ppRTY3YUFJT0tBbENEcnVJenJuYnpzbXJEc29JQWc3SjZRNjQrWklPeVpoT3Vqak9xd2dDRHNsWWdnNjVDWTY0cVVJTzJabU9xeXZTRHNvSVRzbXFrcENpQWdablZ1WTNScGIyNGdiM0JsYmt4dloybHVWR1Z5YldsdVlXd29LU0I3Q2lBZ0lDQjdDaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUNBZw0KTHk4Z2MzUmhjblRxc0lBZzdJT0lJT3k5bU95R2xDRHNzTDNzbllRZzY2ZU02NU9nNjR1a0lDanJpNlRycHF6c25aZ2c3SWlvN0oyQUlPeTltT3lHbE9xenZDRHJyTFRxdElEdGxaanFzb3dnN0lLczdKcXA3SjZRN0plUTZyS01JT3V6dE95ZWhDa3VDaUFnSUNBZ0lDQWdMeThnN0oyMDdKYTA3SVNjSUZCdmQyVnlVMmhsYkd3b0xuQnpNU25zbmJRZ05leTBpQ0Rya3FRZzZyZTRJT3l3dmV5WGtDRHNsNVR0aExEcnBid2c2N08wNjRLMElESHJzb2dvNnJXczY0K0ZJT3F6aE95Z2xTbnNuWVFnN0o2UTY0K1pJT3lFb08yRG5lMlZtT3F6b0N3S0lDQWdJQ0FnSUNBdkx5RHNzTDNzbllRZzdMV2M3SWFNN1ptVTdaVzBJT3lDck95YXFleWVrQ0RyaUlqc2w1UWc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdU91bmpDRHJncWpxc293ZzdaV2M2NHVrTGlEc3NMM3NuWVFnNjZxN0lPeXd2dXljdk91cHRDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPMlZuT3VMcEFvZ0lDQWdJQ0FnSUM4dklDanJpNlRycGJnZzdMQzkNCklPeVlwT3llaGV1Z3BTRHJzS25zcDRBZzRvQ1VJT3EzdUNEcXNyM3NtckFnNjZtVTY0bTA2ckNBSU91enRPeWR0T3VLbENEc3NZVHJvWndnNjRLbzZyT2dJT3lDck95YXFleWVrT3F3Z0NEc2w1VHRoTEFnN1pXY0lPdXlpQ0RyaUlUcnBiVHJxYlFnNjVDb0tTNEtJQ0FnSUNBZ0lDQXZMeURzbzd6c25aZzZJR05zWVhWa1plcXdnQ0Rzdlpqc2hwUWc3S0NjNjZxcDdKMkVJT3V3bE9xK3VPdXB0Q0JCY0hCQlkzUnBkbUYwWlM5R2FXNWtWMmx1Wkc5MzZyQ0FJT3VxdXlEc3NMN3NuWVFnN0lpWUlPeWVpT3lkakNEaWdKUWc3SnlJNjQrRTdKcXdJT3lMcE9xNHNPeVhrT3lFbkNEdG1aWHNuYmdnN1pXRTdKcVVMZ29nSUNBZ0lDQWdJR052Ym5OMElIQnpNU0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdGJHOW5hVzR1Y0hNeEp5azdDaUFnSUNBZ0lDQWdabk11ZDNKcGRHVkdhV3hsVTNsdVl5aHdjekVzSUZzS0lDQWdJQ0FnSUNBZ0lDZFRkR0Z5ZEMxVGJHVmxjQ0F0DQpVMlZqYjI1a2N5QTFKeXdLSUNBZ0lDQWdJQ0FnSUNja2QzTWdQU0JPWlhjdFQySnFaV04wSUMxRGIyMVBZbXBsWTNRZ1YxTmpjbWx3ZEM1VGFHVnNiQ2NzQ2lBZ0lDQWdJQ0FnSUNBaWFXWWdLQ1IzY3k1QmNIQkJZM1JwZG1GMFpTZ25ZMnhoZFdSbExXeHZaMmx1SnlrcElIc2lMQW9nSUNBZ0lDQWdJQ0FnSWlBZ0pIZHpMbE5sYm1STFpYbHpLQ2QrSnlraUxBb2dJQ0FnSUNBZ0lDQWdKeUFnVTNSaGNuUXRVMnhsWlhBZ0xWTmxZMjl1WkhNZ01pY3NDaUFnSUNBZ0lDQWdJQ0FpSUNCQlpHUXRWSGx3WlNBdFRtRnRaWE53WVdObElGVWdMVTVoYldVZ1Z5QXRUV1Z0WW1WeVJHVm1hVzVwZEdsdmJpQW5XMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUZONWMzUmxiUzVKYm5SUWRISWdSbWx1WkZkcGJtUnZkeWh6ZEhKcGJtY2dZeXdnYzNSeWFXNW5JSFFwT3lCYlJHeHNTVzF3YjNKMEtGd2lkWE5sY2pNeUxtUnNiRndpS1YwZ2NIVmliR2xqSUhOMA0KWVhScFl5QmxlSFJsY200Z1ltOXZiQ0JUYUc5M1YybHVaRzkzS0ZONWMzUmxiUzVKYm5SUWRISWdhQ3dnYVc1MElHNHBPeWNpTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdKR2dnUFNCYlZTNVhYVG82Um1sdVpGZHBibVJ2ZHloYlRuVnNiRk4wY21sdVoxMDZPbFpoYkhWbExDQW5ZMnhoZFdSbExXeHZaMmx1SnlraUxBb2dJQ0FnSUNBZ0lDQWdKeUFnYVdZZ0tDUm9JQzF1WlNCYlUzbHpkR1Z0TGtsdWRGQjBjbDA2T2xwbGNtOHBJSHNnVzNadmFXUmRXMVV1VjEwNk9sTm9iM2RYYVc1a2IzY29KR2dzSURZcElIMG5MQ0F2THlBMklEMGdVMWRmVFVsT1NVMUpXa1VLSUNBZ0lDQWdJQ0FnSUNkOUp5d0tJQ0FnSUNBZ0lDQmRMbXB2YVc0b0oxeHlYRzRuS1NBcklDZGNjbHh1SnlrN0NpQWdJQ0FnSUNBZ1kyOXVjM1FnWW1GMElEMGdjR0YwYUM1cWIybHVLRzl6TG5SdGNHUnBjaWdwTENBblkyeGhkV1JsTFdKeWFXUm5aUzFzYjJkcGJpNWlZWFFuS1RzS0lDQWdJQ0FnSUNCbWN5NTNjbWwwWlVacGJHVlRlVzVqS0dKaGRDd2cNCkowQmxZMmh2SUc5bVpseHlYRzRuSUNzS0lDQWdJQ0FnSUNBZ0lDZHpkR0Z5ZENBaVkyeGhkV1JsTFd4dloybHVJaUJqYldRZ0wyc2dZMnhoZFdSbElDOXNiMmRwYmx4eVhHNG5JQ3NLSUNBZ0lDQWdJQ0FnSUNkd2IzZGxjbk5vWld4c0lDMU9iMUJ5YjJacGJHVWdMVVY0WldOMWRHbHZibEJ2YkdsamVTQkNlWEJoYzNNZ0xVWnBiR1VnSWljZ0t5QndjekVnS3lBbklseHlYRzRuS1RzS0lDQWdJQ0FnSUNCemNHRjNiaWduWTIxa0p5d2dXeWN2WXljc0lHSmhkRjBzSUhzZ1pXNTJPaUJEVEVGVlJFVmZSVTVXTENCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcE93b2dJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2RrWVhKM2FXNG5LU0I3Q2lBZ0lDQWdJQ0FnTHk4Z2NIUjVLR1Y0Y0dWamRDbnJvWndnNjdPMDY0SzRJTzJDcE95WGtDRHRnYlRyb1p6cms1d2dWRlZKNnJDQUlPdXN0T3V3bU95ZGtleWR1Q0Rxc29Qc25iUWc3SXVrDQo3TGloSU8yWmxleWR1T3VRcUNneU1ESTJMVEEzTENEc25ienJzSmdnWEhMQ3QydHBkSFI1SU95OWxPdVRuQ0RycXFqcmtaQXBJT0tBbEFvZ0lDQWdJQ0FnSUM4dklPeWNvT3lkdk8yVm5DRHNucERyajVudG1aUWc2cks5NjZHYzY0cVVJRk41YzNSbGJTQkZkbVZ1ZEhQc25aZ2c3S2VFN0tlY0lPMkNwQ0Rzbm9Ycm9LVXVJT3lna2VxM3ZPeUVzU0RxdG96dGxaenNuYlFnN0o2STdKeTg2Nm0wSURic3RJZ2c2NUtrSU95WGxPMkVzT3F3Z0NEc25wRHJqNWtnN0o2RjY2Q2w2NCs4Q2lBZ0lDQWdJQ0FnTHk4Z01ldXlpQ2pxdGF6cmo0VWc2ck9FN0tDVktleWR0Q0RzaEtEdGc1M3JrSmpxczZBc0lPcTJqTzJWbk95ZHRDRHNsNGJzbkx6cnFiUWdhMlY1YzNSeWIydGxJT3lraE91bmpDRHNvYkRzbXFudG5vZ2c3SXVrN1l5bzdaVzBJT3lDck95YXFleWVrT3F3Z0NEc2w1VHRoTEFnN1pXY0lPdXlpQ0RyaUlUcnBiVHJxYlFnNjVDYzY0dWtLR1poYVd3dGMyOW1kQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdKZVU3WVN3SU95bg0KZ2V5Z2hPeVhrQ0JVWlhKdGFXNWhiT3lkaENEcmk2VHNpNXdnN0pXZTdKeTg2NkdjSU9xd2dPeWd1T3laZ0NEcmk2VHJwYmdnN0pXeDdKZVFJTzJDcE9xd2dDRHJrNlRzbHJUcXNJRHJpcFFnNnJLRDdKMkVJT3VuaWV1S2xPdUxwQzRLSUNBZ0lDQWdJQ0J6Y0dGM2JpZ25iM05oYzJOeWFYQjBKeXdnV3dvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QmtieUJ6WTNKcGNIUWdJbU5zWVhWa1pTQXZiRzluYVc0aUp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWVdOMGFYWmhkR1VuTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjJSbGJHRjVJRFluTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QmhZM1JwZG1GMFpTY3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5aR1ZzWVhrZ01DNHpKeXdLSUNBZ0lDQWcNCklDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlRlWE4wWlcwZ1JYWmxiblJ6SWlCMGJ5QnJaWGx6ZEhKdmEyVWdjbVYwZFhKdUp5d0tJQ0FnSUNBZ0lDQWdJQzh2SU95WGxPMkVzT3F3Z0NEc2k2VHNvSnpyb1p3ZzY1T2s3SmEwNnJDRUlPcXl2ZXlhc095WGtPdW5qQ0RzbDZ6cXVMQWc2NCtFNjR1c0tPcTJqTzJWbkNEc2w0YnNuTHpycWJRZzdKeUU3SmVRN0lTY0lPeWtrZXVMcUNrZzRvQ1VJTzJFc091dnVPdUVrT3lkaENEc3VaanNtNHdnNjdpTTY1Mjg3SnF3N0tDQTY2ZU1JT3VDcU9xNHRPdUxwQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlERXVOU2NzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklITmxkQ0J0YVc1cFlYUjFjbWw2WldRZ2IyWWdabkp2Ym5RZ2QybHVaRzkzSUhSdklIUnlkV1VuTEFvZ0lDQWdJQ0FnSUYwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPd29nSUNBZ0lDQjlJR1ZzDQpjMlVnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJtWVd4elpUc2dMeThnN0tlQTdKdVFJT3lWaUNEdGxaanJpcFFnVDFNS0lDQWdJQ0FnZlFvZ0lDQWdJQ0J5WlhSMWNtNGdkSEoxWlRzS0lDQWdJSDBLSUNCOUNpQWdMeThnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0Ryb1p6cXQ3anNsWVRzbTRNZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNEdG1ZanNuWmdnVyt1aG5PcTN1T3lWaE95YmcxMGc2N0tFN1lxODdKMjBJTzJZdU95Mm5DNGdZMnhoZFdSbElHRjFkR2dnYkc5bmIzVjA3Snk4NjZHY0lFTk1TU0Ryb1p6cXQ3anNuYmpzbllRZzdaVzA3S0NjN1pXYzY0dWtMZ29nSUM4dklDanNuYlFnVUVQc25aZ2c3S0NBN0o2bDY1Q2NJT3lla09xeXFleW1uZXVxaGV5ZGhDRHNwNERzbXJUcmk2UWc0b0NVSU91THBPeUxuQ0RzazdEcm9LVHJxYlFnN0o2czY2R2M2cmU0N0oyNElPMlZoT3lhbEM0cElPdWhuT3EzdU95VmhPeWJneUR0bTRUc2w1UWc3SVM0N0lXWXdyZnFzNFRzb0pYc3VwRHNpNXpycGJ3ZzdLQ1Y2NmFzN1pXYw0KNjR1a0xnb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OWpiR0YxWkdVdGJHOW5iM1YwSnlrZ2V3b2dJQ0FnWTI5dWMzUWdiRzhnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3lkaGRYUm9KeXdnSjJ4dloyOTFkQ2RkTENCN0lITm9aV3hzT2lCMGNuVmxMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWXNJSGRwYm1SdmQzTklhV1JsT2lCMGNuVmxJSDBwT3dvZ0lDQWdiR1YwSUdWeWNpQTlJQ2NuT3dvZ0lDQWdiRzh1YzNSa1pYSnlMbTl1S0Nka1lYUmhKeXdnS0dRcElEMCtJSHNnWlhKeUlDczlJR1F1ZEc5VGRISnBibWNvS1RzZ2ZTazdDaUFnSUNCc2J5NXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdleUJxYzI5dUtISmxjeXdnTlRBd0xDQjdJRzlyT2lCbVlXeHpaU3dnWlhKeWIzSTZJQ2Zyb1p6cXQ3anNsWVRzbTRNZzdJdWs3WmFKSU95THBPMk1xRG9nSnlBcklHVXViV1Z6YzJGblpTQjlLVHNnZlNrN0NpQWdJQ0JzYnk1dmJpZ25ZMnh2YzJVbkxDQW8NClkyOWtaU2tnUFQ0Z2V3b2dJQ0FnSUNCcmFXeHNVSEp2WXlnbjY2R2M2cmU0N0pXRTdKdUQ3WlcwN0lTY0lPeWFsT3l5cmV5ZGhDRHNwSkhyaTZqdGxvanNsclRzbXBRdUp5azdJQzh2SU95ZG1PdVBoT3lnZ1NEc29vWHJvNHdnNG9DVUlPeWVrT3VQbVNEc25xenNpNXpyajRUcXNJQWc3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1yT3VwdENEc2xZZ2c2NUNvQ2lBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3SUNBZ0lDQWdJQ0F2THlEcmk2VHNuWXdnTDJGalkyOTFiblRDdHk5b1pXRnNkR2pzbDVEc2hKd2c2ck9FN0tDVjdKMkVJT3lEaU91aG5DZzk3SmVHN0oyTTdKeTg2NkdjS1NEc25iM3Fzb3dLSUNBZ0lDQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQzh2SU95RGdlMkRuQ0RzbnF6dGpKRHNvSlVvNjR1azdKMk1JTzJFdE95WGtPeUVuQ0Rycjdqcm9aenF0N2pzbmJnZzZyQ1E3S2VBS1FvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjDQo2NU9jSU91aG5PcTN1T3lWaE95Ymd5QW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BKeWs3Q2lBZ0lDQWdJR2xtSUNoeVpYTXVhR1ZoWkdWeWMxTmxiblFwSUhKbGRIVnlianNnTHk4Z1pYSnliM0lnN1pXNDY1T2s2NStzNnJDQUlPeWR0T3V2dUNEc25aSHJpN1h0bG9qc25MenJxYlFnN0tTUjY3TzFJT3V3cWV5bmdBb2dJQ0FnSUNCcFppQW9ZMjlrWlNBOVBUMGdNQ2tnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU0I5S1RzS0lDQWdJQ0FnWld4elpTQnFjMjl1S0hKbGN5d2dOVEF3TENCN0lHOXJPaUJtWVd4elpTd2daWEp5YjNJNklDaGxjbkl1ZEhKcGJTZ3BMbk5zYVdObEtEQXNJREUxTUNrcElIeDhJQ2duN0tLRjY2T01JT3k5bE91VG5DQW5JQ3NnWTI5a1pTa2dmU2s3Q2lBZ0lDQjlLVHNLSUNBZ0lISmxkSFZ5YmpzS0lDQjlDaUFnTHk4ZzdKNlE2cml3SU95aWhldWpqQ0RpZ0pRZzdaU002NStzNnJlNDdKMjRJRk5VVDFCZlFsSkpSRWRGTCsyVm1PMkt1T3U1aE8yS3VPcXdnQ0R0bUxqcw0KdHB6dGxaenJpNlFnS091aG5PeTdyT3lYa095RW5PdW5qQ0Rzb0pIcXQ3d2c2ckNBNjRxbDdaV1k2NHVJSU95VmlPeWdoQ2tLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YzJoMWRHUnZkMjRuS1NCN0NpQWdJQ0JxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxJSDBwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95aWhldWpqQ0RzbXBUc3NxMGc2N0NiN0oyTUlPS0FsQ0RyaTZUcnBxenJwYndnNjRHVjY0dUk2NHVrTGljcE93b2dJQ0FnYzJoMWRIUnBibWRFYjNkdUlEMGdkSEoxWlRzS0lDQWdJR3RwYkd4UWNtOWpLQ2s3Q2lBZ0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1N3Z01qQXdLVHNLSUNBZ0lISmxkSFZ5YmpzS0lDQjlDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM0psWTI5dGJXVnVaQ2NwSUhzS0lDQWcNCklHTnZibk4wSUhzZ2RHVjRkQ3dnYlc5a1pXd3NJSEp2YkdVZ2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQnBaaUFvSVhSbGVIUWdmSHdnSVZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0NrcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuN0xhVTdMS2M2N0NiN0oyRUlPdXN1T3Exck9xd2dDRHJ1WVRzbHJRZzdKNkk3SXExNjR1STY0dWtMaWNnZlNrN0NpQWdJQ0JqYjI1emRDQnpkR0Z5ZEdWa0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzdHBUc3Nwd2c3SnFVN0xLdE9pY3NJRk4wY21sdVp5aDBaWGgwS1M1emJHbGpaU2d3TENBMU1Da3VjbVZ3YkdGalpTZ3ZYRzR2Wnl3Z0p5QW5LU0FySUNmaWdLWW5MQ0J5YjJ4bElEOGdKMXNuSUNzZ2NtOXNaU0FySUNkZEp5QTZJQ2NuTENCdGIyUmxiQ0EvSUNjbzY2cW82NDI0T2lBbklDc2diVzlrWld3Z0t5QW5LU2NnT2lBbkp5azdDaUFnSUNCMGNua2dld29nDQpJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclEyeGhkV1JsS0ZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0Nrc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVk4xWjJkbGMzUnBiMjV6TENCbWIzSnRZWFJFWlhOak9pQW5XM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0o5TENBdUxpNWRKeUI5TENCeWIyeGxLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MzVm5aMlZ6ZEdsdmJuTWdQU0J5TG5CaGNuTmxaQ0I4ZkNCYlhUc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93b2dJQ0FnSUNCcFppQW9JWE4xWjJkbGMzUnBiMjV6TG14bGJtZDBhQ2tnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrNw0KQ2lBZ0lDQWdJSDBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeVZpQ0FuSUNzZ2MzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lDc2dKK3F3bkNBb0p5QXJJSE5sWXlBcklDZHpLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lETXdLVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRk5sWXlBOUlITmxZenNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2MzVm5aMlZ6ZEdsdmJuTXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY2dmU2s3Q2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2k2VHRqS2c2Snl3Z1pTNXRaWE56WVdkbEtUc0sNCklDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdDaUFnSUNCOUNpQWdmUW9nSUM4dklPMlVoT3VnaU95ZWhPdXpoQ0RzdHBUc3Nwd2c0b0NVSU8yVm5DRHRtWlRycWJUc25ZUWc3WldZN0p5RUlPMlVoT3VnaU95ZWhDanNtSUhzbDYwcElPdUxxT3ljaE91aG5DRHJncGpyaUtBZzY3Q2I2ck9nTENEc21JSHNsNjNycDRqcmk2UWc2NVN3NjZHY0lPdU1nT3lWaU95ZGhDRHJncmpyaTZRdUNpQWdMeThnN0ppQjdKZXRJT3lJbU91bmpPMkJ2Q0RzbXBUc3NxM3NuWVFnN0txODZyQ2M3S2VBSU95Vml1dUtsQ0Rxc29Qc25iUWc3WlcxN0l1c0lDanJpcERyb0tUc3A0RHFzNkFnN0lLczdKcXA2NStKNjQrRUlPcTN1T3Vuak8yQnZDRHJncGpxc0lUcmk2UXBMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl5WldOdmJXMWxibVF0DQpaM0p2ZFhCekp5a2dld29nSUNBZ1kyOXVjM1FnZXlCbmNtOTFjSE1zSUcxdlpHVnNMQ0J0YjNKbElIMGdQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3dvZ0lDQWdZMjl1YzNRZ2JHbHpkQ0E5SUVGeWNtRjVMbWx6UVhKeVlYa29aM0p2ZFhCektRb2dJQ0FnSUNBL0lHZHliM1Z3Y3dvZ0lDQWdJQ0FnSUNBZ0xtMWhjQ2dvWnlrZ1BUNGdLSHNLSUNBZ0lDQWdJQ0FnSUNBZ2JtRnRaVG9nVTNSeWFXNW5LQ2huSUNZbUlHY3VibUZ0WlNrZ2ZId2dKeWNwTG5SeWFXMG9LU3dLSUNBZ0lDQWdJQ0FnSUNBZ2RHVjRkSE02SUNobklDWW1JRUZ5Y21GNUxtbHpRWEp5WVhrb1p5NTBaWGgwY3lrZ1B5Qm5MblJsZUhSeklEb2dXMTBwTG0xaGNDZ29kQ2tnUFQ0Z1UzUnlhVzVuS0hRZ2ZId2dKeWNwTG5SeWFXMG9LU2t1Wm1sc2RHVnlLRUp2YjJ4bFlXNHBMQW9nSUNBZ0lDQWdJQ0FnSUNCeWIyeGxPaUFvWnlBbUppQm5Mbkp2YkdVcElEOGdVM1J5YVc1bktHY3VjbTlzWlNrZ09pQjFibVJsWm1sdVpXUXNDaUFnSUNBZw0KSUNBZ0lDQjlLU2tLSUNBZ0lDQWdJQ0FnSUM1bWFXeDBaWElvS0djcElEMCtJR2N1ZEdWNGRITXViR1Z1WjNSb0tRb2dJQ0FnSUNBNklGdGRPd29nSUNBZ2FXWWdLR3hwYzNRdWJHVnVaM1JvSUR3Z01pa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmc21JSHNsNjNzbmJRZzY3YUE3S0d4N1pXcDY0dUk2NHVrTGljZ2ZTazdDaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJVHJvSWpzbm9UcnM0UWc3TGFVN0xLY0lPeWFsT3l5clRvZzdKaUI3SmV0SUNjZ0t5QnNhWE4wTG14bGJtZDBhQ0FySUNmcXNKd25JQ3NnS0cxdmNtVWdQeUFuSUNqcmpaUWc2N0NiNnJpd0tTY2dPaUFuSnlrc0lHMXZaR1ZzSUQ4Z0p5anJxcWpyamJnNklDY2dLeUJ0YjJSbGJDQXJJQ2NwSnlBNklDY25LVHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJR052Ym5OMElISWdQU0JoZDJGcGRDQmhjMnRIY205MWNITW8NCmJHbHpkQ3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFIzSnZkWEJ6TENCbWIzSnRZWFJFWlhOak9pQW5leUpuY205MWNITWlPaUJiZXlKdVlXMWxJam9nSXV5WWdleVhyU0RzbmJUcnBvUWlMQ0FpYzNWbloyVnpkR2x2Ym5NaU9pQmJleUowWlhoMElqb2dJdXVNZ095VmlDSXNJQ0p5WldGemIyNGlPaUFpN0oyMDdKeWdJbjFkZlYxOUp5QjlMQ0FoSVcxdmNtVXBPd29nSUNBZ0lDQmpiMjV6ZENCdmRYUWdQU0J5TG5CaGNuTmxaRHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVc5MWRDa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yVWhPdWdpT3llDQpoT3V6aENEc29KenNsWWdnSnlBcklHOTFkQzV5WldSMVkyVW9LRzRzSUdjcElEMCtJRzRnS3lCbkxuTjFaMmRsYzNScGIyNXpMbXhsYm1kMGFDd2dNQ2tnS3lBbjZyQ2NJQzhnN0ppQjdKZXRJQ2NnS3lCdmRYUXViR1Z1WjNSb0lDc2dKK3F3bkNBb0p5QXJJSE5sWXlBcklDZHpLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnSjF2dGxJVHJvSWpzbm9UcnM0UmRJQ2NnS3lCVGRISnBibWNvS0d4cGMzUmJNRjBnSmlZZ2JHbHpkRnN3WFM1MFpYaDBjMXN3WFNrZ2ZId2dKeWNwTG5Oc2FXTmxLREFzSURJMEtUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGTmxZeUE5SUhObFl6c0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnWjNKdmRYQnpPaUJ2ZFhRc0lHVnVaMmx1WlRvZw0KSjJOc1lYVmtaU2NnZlNrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRsSVRyb0lqc25vVHJzNFFnN0xhVTdMS2NJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzdZeWQ3SmVGSU95YWxPeUdqT3V6aENEc3RwVHNzcHdnNG9DVUlPMlZuQ0R0akozc2w0WHNuWmdnNnJXczdJU3g3SnFVN0lhTUtPeVhyZTJWb0N2cnJManF0YXdwNjZXOElPMlZuQ0Ryc29qc2w1QWc2N0NiN0pXRUlPeVhyZTJWb091emhPdWhuQ0RyaTZUcms2enJpcFRyaTZRdUNpQWdMeThnN0pxVTdJYU02Nlc4SU8yVnFPcTdtQ0RyczdUcmdyVHNsYndnN1lPQTdKMjA3WXVBN0oyMElPdXp1T3VzdUNEcnA2WHJuYjNzbllRZzdMQzQ3S0d3N1pXZ0lPeUkNCm1DRHNub2pyaTZRbzdKcVU3SWFNNjdPRUlPcXduT3V6aENEc21wVHNzcTNxczd6c25aZ2c3TENvN0oyMEtTNEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjbVZqYjIxdFpXNWtMWEJ2Y0hWd0p5a2dld29nSUNBZ1kyOXVjM1FnZXlCbGJHVnRaVzUwY3l3Z2JXOWtaV3dzSUcxdmNtVWdmU0E5SUdGM1lXbDBJSEpsWVdSQ2IyUjVLSEpsY1NrN0NpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ1FYSnlZWGt1YVhOQmNuSmhlU2hsYkdWdFpXNTBjeWtnUHlCbGJHVnRaVzUwY3k1bWFXeDBaWElvS0dVcElEMCtJR1VnSmlZZ1UzUnlhVzVuS0dVdWRHVjRkQ0I4ZkNBbkp5a3VkSEpwYlNncEtTQTZJRnRkT3dvZ0lDQWdhV1lnS0d4cGMzUXViR1Z1WjNSb0lEd2dNaWtnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnRqSjNzbDRVZzdKcVU3SWFNNnJDQUlPdTJnT3loc2UyVnFldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnDQpjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5ZDdKZUZJT3kybE95eW5DRHNtcFRzc3EwNklPeWFsT3lHakNBbklDc2diR2x6ZEM1c1pXNW5kR2dnS3lBbjZyQ2NKeUFySUNodGIzSmxJRDhnSnlBbzY0MlVJT3V3bStxNHNDa25JRG9nSnljcExDQnRiMlJsYkNBL0lDY282NnFvNjQyNE9pQW5JQ3NnYlc5a1pXd2dLeUFuS1NjZ09pQW5KeWs3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yVUc5d2RYQW9iR2x6ZEN3Z2JXOWtaV3dzSUhzZ2NHRnljMlU2SUhCaGNuTmxVRzl3ZFhBc0lHWnZjbTFoZEVSbGMyTTZJQ2Q3SW5ObGRITWlPaUJiZXlKeVpXRnpiMjRpT2lBaTY3Q3A3WmFsSU8yVm5DRHJyTGpzbnFVaUxDQWlaV3hsYldWdWRITWlPaUJiZXlKeWIyeGxJam9nSXV5WHJlMlZvQ0lzSUNKMFpYaDBJam9nSXV1c3VPcTFyQ0o5TENBdUxpNWRmU3dnTGk0dVhYMG5JSDBzSUNFaGJXOXlaU2s3Q2lBZw0KSUNBZ0lHTnZibk4wSUhObGRITWdQU0J5TG5CaGNuTmxaRHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVhObGRITXBJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z2V5Qmxjbkp2Y2pvZ0orMkJ0T3Vobk91VG5DRHNuWkhyaTdYc25ZUWc3WlcwN0lTZDdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpKM3NsNFVnN0lTNDdZcTRJQ2NnS3lCelpYUnpMbXhsYm1kMGFDQXJJQ2Zxc0p3Z0tDY2dLeUJ6WldNZ0t5QW5jeWtuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjANCmN5NXNZWE4wVkdWNGRDQTlJQ2RiN1l5ZDdKZUZYU0FuSUNzZ1UzUnlhVzVuS0Noc2FYTjBXekJkSUNZbUlHeHBjM1JiTUYwdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJREkwS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djMlYwY3l3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnlCOUtUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNbmV5WGhTRHNpNlR0aktnNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEdG1ManN0cHdnN0l1azdZeW9PaUFuS1NrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SU91TWdPMlpsTzJZbFNEcnJManF0YXdnN0tDYzdKNlJJT0tBbENEc2c0SHRtYW5zbllRZzdJU2s2NnFGN1pXWTY2bTBJT3VzDQp1T3Exck91bHZDRHJwNHpyazZUc2xyVHNwSURyaTZRZ0tPeTJsT3l5bk9xenZDRHFzSm5zbllBZzdJUzQ3SVdZTENEcmpJRHRtWlRyaXBRZzY2ZWtJT3lhbE95eXJleVhrQ0R0aHJYc3A3anJvWndnN0l1azY2YThLUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTlqYjIxd2IzTmxKeWtnZXdvZ0lDQWdZMjl1YzNRZ2V5QnRaWE56WVdkbGN5d2diVzlrWld3Z2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQmpiMjV6ZENCc2FYTjBJRDBnUVhKeVlYa3VhWE5CY25KaGVTaHRaWE56WVdkbGN5a2dQeUJ0WlhOellXZGxjeTVtYVd4MFpYSW9LRzBwSUQwK0lHMGdKaVlnVTNSeWFXNW5LRzB1ZEdWNGRDQjhmQ0FuSnlrdWRISnBiU2dwS1NBNklGdGRPd29nSUNBZ2FXWWdLQ0ZzYVhOMExteGxibWQwYUNrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZyaklEdG1aUWc2NEswN0pxcDdKMjBJT3U1aE95Vw0KdENEc25vanNpclhyaTRqcmk2UXVKeUI5S1RzS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ1kyOXVjM1FnYkdGemRGVnpaWElnUFNCYkxpNHViR2x6ZEYwdWNtVjJaWEp6WlNncExtWnBibVFvS0cwcElEMCtJRzB1Y205c1pTQWhQVDBnSjJGemMybHpkR0Z1ZENjcE93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lla1NEcmpJRHRtWlFnN0pxVTdMS3RPaWNzSUZOMGNtbHVaeWdvYkdGemRGVnpaWElnSmlZZ2JHRnpkRlZ6WlhJdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJRFV3S1M1eVpYQnNZV05sS0M5Y2JpOW5MQ0FuSUNjcElDc2dKK0tBcGlBbzY0eUE3Wm1VSUNjZ0t5QnNhWE4wTG14bGJtZDBhQ0FySUNmcXNKd3BKeWs3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0F2THlEcmpJRHRtWlRxc0lBZzZyaTQ3SmEwN0tlQTY2bTBJT3kxbk9xM3ZDQXhNdXF3bk91bmpDQW83WlNFNjZHczdaU0U3WXE0SU8yUHJleWp2Q0Ryc0tuc3A0QXANCkNpQWdJQ0FnSUdOdmJuTjBJSElnUFNCaGQyRnBkQ0JoYzJ0RGIyMXdiM05sS0d4cGMzUXVjMnhwWTJVb0xURXlLU3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFEyOXRjRzl6WlN3Z1ptOXliV0YwUkdWell6b2dKM3NpY21Wd2JIa2lPaUFpNjR5QTdabVVJT3lka2V1THRTRHRsWnpya1pBZzY2eTQ3SjZsSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcnJManF0YXdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOUxDQXVMaTVkZlNjZ2ZTazdDaUFnSUNBZ0lHTnZibk4wSUc5MWRDQTlJSEl1Y0dGeWMyVmtPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RyDQpxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPeWRrZXVMdFNBb0p5QXJJSE5sWXlBcklDZHpMQ0Rzb0p6c2xZZ2dKeUFySUc5MWRDNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dLeUFuNnJDY0tTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktDaHNZWE4wVlhObGNpQW1KaUJzWVhOMFZYTmxjaTUwWlhoMEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCeVpYQnNlVG9nYjNWMExuSmxjR3g1TENCemRXZG5aWE4wYVc5dWN6b2diM1YwTG5OMQ0KWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU8yWXVPeTJuQ0RzaTZUdGpLZzZJQ2NwS1RzS0lDQWdJSDBLSUNCOUNpQWdMeThnNjdLSTdKZXRJT0tBbENEdGxaenF0YTNzbHJRZzRvYVVJT3lZZ2V5V3RDRHNucERyajVrZ0tPeTJsT3l5bk9xenZDRHFzSm5zbllBZzdJUzQ3SVdZSU95Q3JPeWFxU2tLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZEhKaGJuTnNZWFJsSnlrZ2V3b2dJQ0FnWTI5dWMzUWdleUIwWlhoMExDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHbG0NCklDZ2hkR1Y0ZENCOGZDQWhVM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnJzb2pzbDYzdGxhQWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTI5dWMzUWdjaUE5SUdGM1lXbDBJR0Z6YTFSeVlXNXpiR0YwWlNoVGRISnBibWNvZEdWNGRDa3VkSEpwYlNncExDQnRiMlJsYkN3Z2V5QndZWEp6WlRvZ2NHRnljMlZVY21GdWMyeGhkR1VzSUdadmNtMWhkRVJsYzJNNklDZDdJblJ5WVc1emJHRjBaV1FpT2lBaTY3S0k3SmV0NjZ5NElDanNwSVRyDQpzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSmthWEpsWTNScGIyNGlPaUFpYTIvaWhwSmxiaURybUpEcmlwUWdaVzdpaHBKcmJ5SjlKeUI5S1RzS0lDQWdJQ0FnWTI5dWMzUWdiM1YwSUQwZ2NpNXdZWEp6WldRN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnZkWFFwSUhzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVRuQ0Ryc29qc2w2MGc3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95WmhPdWpqQ0FvSnlBcklITmxZeUFySUNkekxDQW5JQ3NnS0c5MWRDNWthWEpsWTNScGIyNGdmSHdnSno4bktTQXJJQ2NwSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbk5sY25abA0KWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCMGNtRnVjMnhoZEdWa09pQnZkWFF1ZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dU9pQnZkWFF1WkdseVpXTjBhVzl1TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N0tJN0pldElPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU91eWlPeVgNCnJTRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EUXNJSHNnWlhKeWIzSTZJQ2RPYjNRZ1ptOTFibVFuSUgwcE93cDlLVHNLQ2k4dklPeWR0T3V2dUNEcmk2VHJwcXpxc0lBZzY1YWdJT3llaU91S2xPdU5zQ0RybUpBZzdMeWM2cml3NnJDQUlPdVRwT3lXdE95WXBPdXB0Q2pzb0p6c2lxVHNzcGdnN0o2UTY0K1pJT3k4bk9xNHNDRHNwSkhyczdVZzY1T3hLU0Rzb2JEc21xbnRub2dnN0tLRjY2T01JT0tBbENEcmo0enJqWmdnNjR1azY2YXM2NHFVSU9xM3VPdU1nT3VobkNEc25LRHNwNEFLYzJWeWRtVnlMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUI3Q2lBZ2FXWWdLR1VnSmlZZ1pTNWpiMlJsSUQwOVBTQW5SVUZFUkZKSlRsVlRSU2NwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc25iVHJyN2dnN0x5YzdLQzRJT3llaU95V3RPeWFsQ2p0ajZ6dGlyZ2dKeUFySUZCUFVsUWdLeUFuSU95Q3JPeWFxU0RzcEpFcElPS0FsQ0RzDQpuYlFnN0oyNDdJcWs3WVMwN0lxazY0cVVJT3lpaGV1ampPMlZxZXVMaU91THBDNG5LVHNLSUNBZ0lIQnliMk5sYzNNdVpYaHBkQ2d3S1RzS0lDQjlDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUVuT3V5aENEc21LVHJwWmc2Snl3Z1pTQW1KaUJsTG0xbGMzTmhaMlVwT3dvZ0lIQnliMk5sYzNNdVpYaHBkQ2d4S1RzS2ZTazdDaTh2SU95V3RPdVdwQ0Rxc3Izcm9aenJvWndnN0tPOTY1T2dLT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFzSUVOMGNtd3JReXdnTDNOb2RYUmtiM2R1TENEc21LVHJwWmdwSUdOc1lYVmtaU0RzbnBEc2k1M3NuWVFnNjRLbzZyaXc3S2VBSU95Vml1dUtsT3VMcEFwd2NtOWpaWE56TG05dUtDZGxlR2wwSnl3Z0tDa2dQVDRnZXlCcmFXeHNVSEp2WXlncE95QnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lIMHBPd3B3Y205alpYTnpMbTl1S0NkVFNVZEpUbFFuTENBb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3BPd3B3Y205alpYTnpMbTl1S0NkVFNVZFVSVkpOSnl3Zw0KS0NrZ1BUNGdjSEp2WTJWemN5NWxlR2wwS0RBcEtUc0tDbk5sY25abGNpNXNhWE4wWlc0b1VFOVNWQ3dnSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzS0lDQmpiMjV6YjJ4bExteHZaeWduNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0p5RHRnYlRyb1p6cms1d2c2NHVrNjZhc0lPeThuT3lua0NEaWdKUWdhSFIwY0RvdkwyeHZZMkZzYUc5emREb25JQ3NnVUU5U1ZDazdDaUFnWTI5dWMyOXNaUzVzYjJjb0p5RHJxcWpyamJnNklDY2dLeUJEVEVGVlJFVmZUVTlFUlV3Z0t5QW5JTUszSU95WWlPeUxuQ0FuSUNzZ1JWaEJUVkJNUlZNdWJHVnVaM1JvSUNzZ0orcXh0Q0RzbnFYc3NLa24NCktUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPeWR0Q0Rzc0wzc25ZUWc3THljNjVHVUlPdVBtZXlWaUNEdGxMenF0N2pycDRnZzdaU002NStzNnJlNDdKMjQ3SjIwSU8yQnRPdWhuT3VUbk91aG5DRHN0cFRzc3B6dGxhbnJpNGpyaTZRdUp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0orS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTm9aV05yUTJ4aGRXUmxRWFpoYVd4aFlteGxLQ2s3SUM4dklFTnNZWFZrWlNCRGIyUmxJT3lDck95YXFTRHFzSURyaXFVZzdKZXM2N2FBSU95Z2tPcXlnQ0FvN1pTTTY1K3M2cmU0N0oyNElPeVZpT3VDdE95YXFTa0tJQ0F2THlEcnI3anJwcXdnN0l1YzY0K1pJQ3NnN0tlQTdJdWM2Nnk0DQpJT3lqdk95ZWhTRGlnSlFnN0xLcklPeTJsT3l5bk91MmdPMkVzQ0RydWFEcnBiVHFzb3dLSUNCaGMydERiR0YxWkdVb0oreWJqT3V3amV5WGhUb2dJdXlnZ095ZXBTRHJrSmpzbDRqc2lyWHJpNGpyaTZRaUp5a3VkR2hsYmlnS0lDQWdJQ2dwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbTR6cnNJM3NsNFVnN0ptRTY2T01JT0tBbENEc3RwVHNzcHdnN0tTQTY3bUVJT3VCblM0bktTd0tJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeUxwTzJNcUNBbzdMS3JJT3lhbE95eXJTRHJsWXdnN0o2czdJdWM2NCtFS1RvbkxDQmxMbTFsYzNOaFoyVXBDaUFnS1RzS2ZTazdDaTh2SUVsUWRqWWc2Nk9vN1pTRTY3Q3hLRG82TVNuc2w1RHJqNFFnN1pXbzZydVlJT3VUbyt1S2xPdUxwQ0RpZ0pRZ2JXRmpUMU1nNjVPeDdKZVE3SVNjSUNkc2IyTmhiR2h2YzNRbjZyQ0FJRG82TWV1aG5DRHJxTHpzb0lBZzdaVzA3SVNkNjVDWTY0cVU2NDJ3Q2k4dg0KSU8yVXZPcTN1T3VuaUNoRmJHVmpkSEp2YmlrZ1ptVjBZMmpyaXBRZ1kzVnliT3F6dkNEcmk2enJwcXdnU1ZCMk5PdWhuQ0RzbnBEcmo1a2c3WSswNjdDeDdaV1k3S2VBSU95Vml1eVZoQ3dnU1ZCMk5PdW5qQ0RyazZQcmpaZ2c2NHVrNjZhczdKZVFJT3lYc09xeXNPeWR0Q0Rxc2JEcnRvRHJqN3dLTHk4ZzdMYVU3TEtjd3JmdGw2enNpcVRzc3JUdGdhenFzSUFnN0tHdzdKcXA3WjZJSU95THBPMk1xTzJXaU91THBDanNpNlRzdUtFZ01qQXlOaTB3TnlrdUlPcXdtZXlkZ0NEc21wVHNzcTBnN1pXNDY1T2s2NStzNjZXOElFbFFkallnNjZPbzdaU0U2N0N4N0plUTY0K0VJT3lXdWV1S2xPdUxwQzRLWTI5dWMzUWdjMlZ5ZG1WeU5pQTlJR2gwZEhBdVkzSmxZWFJsVTJWeWRtVnlLSE5sY25abGNpNXNhWE4wWlc1bGNuTW9KM0psY1hWbGMzUW5LVnN3WFNrN0NuTmxjblpsY2pZdWIyNG9KMlZ5Y205eUp5d2dLR1VwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0JKVUhZMktEbzZNU2tnNjZhczdJcW8NCklPeURuZXVldFNEaWdKUWdTVkIyTk91bmpDRHNncXpzbXFrNkp5d2daU0FtSmlCbExtMWxjM05oWjJVcEtUc0tjMlZ5ZG1WeU5pNXNhWE4wWlc0b1VFOVNWQ3dnSnpvNk1TY3BPd289DQo6OkVYQU1QTEVTOjoNCkl5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzDQpwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydA0KbGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWENCmxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVDQo3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TA0Kbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXkNCmhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVDQo3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3Zw0KN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVcNCnRPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWDQptT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIcw0KbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0kNCjdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnDQo3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvag0KSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVANCm1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyDQpvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8ySw0KdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVYNCmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyDQppNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Qw0KdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXcNCmdDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzDQpuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRQ0KN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHMNCm5JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhDQpsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMA0KSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzMNCjZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzDQppSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEcw0KaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGcNCjdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhDQpxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqcw0KbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjANCklPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVoDQpuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMA0KN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTANCjY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RyDQpwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZw0KNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXcNCnZ1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLDQpMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZw0KN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHINCnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVDQpQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aA0KbkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0NCjo6R1VJREU6Og0KSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5BMEtEUW9qSXlBeExpRHRsYlRzbXBUc3NyUU5DZzBLN0tDYzdaS0lJT3lWaU95ZG1DRHJxcWpyazZBZzY2eTQ2cldzNjRxVUlDZnRsYlRzbXBUc3NyUW42NkdjSU95TnFPeWFsQzROQ3V5ZHZPcTBnT3lFc1NEc25vanJpcFFnN0lLczdKcXA3SjZRSU9xeXZlMlhtT3lkaENEcnA0enJrNlFnN0lpWUlPeWVpT3VQaE91aG5TQXFLdXlEZ2UyWnFTd2c2NmVsNjUyOTdKMkVJT3UyaU91c3VPMlZtT3F6b0NEcnFxanJrNkFnNjZ5NDZyV3M3SmVRSU8yVnRPeWFsT3l5dE91bHZDRHNvSUhzbXFudGxiVHNvN3pzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEcnM3VHJnNFhyaTRqcmk2UWc0b2FTSU91enRPdUN2T3F5ak95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJT3kxbk91TWdPMlZuQ0FxS3V1S3BldVBtZTJZbFNEcnJManNucVVxS3V5ZGhDRHNqYWpzbzd6c2hManMNCm1wUXVJT3lJbU91UG1lMllsU0Ryckxqc25xWHNuWUFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNUzNzaUpqcmo1bnRtSlV0NjZ5NDdKNmw3SjJFTGV5TnFPdVBoQzNya0pqcmlwUXQ2cks5N0pxd0tleVhrQ0R0bGJUcmk3bnRsYUFnNjVXTTY2ZU1JT3lUc091S2xDRHFzb3dnN0tLTDdKV0U3SnFVTGcwS0RRb2pJeU1nNjVDUTdKYTA3SnFVSU9LR2tpRHRsb2pzbHJUc21wUU5DZzBLN0ppSUtRMEtMU0RzaEtUc29KWHJrSkRzbHJUc21wUWc0b2FTSU95RXBPeWdsZTJXaU95V3RPeWFsQTBLRFFvakl5TWdKMzdzbDRnbklPdTV2T3E0c0EwS0RRcnNtSWdwRFFvdElPdXdsT3VBak95WGlPeVd0T3lhbENEaWhwSWc2N0NVNnIrbzdKYTA3SnFVRFFvTkNpTWpJeURyajVuc2dxd2c2N0NVNnIrVTdKT3c2cml3RFFvTkN1eVlpQ2tOQ2kwZzY0YVM3SldFN0tHTTdKYTA3SnFVSU9LR2tpRHNtS3pybnBEc2xyVHNtcFFOQ2cwS0tpb3FEUW9OQ2lNaklETXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFODQpDZzBLN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RydG9Ec29KWHNvSUVnN0x1azY2Nms2NHVJN0x5QTdKMjA3SVdZN0oyRUlPeTFuT3VNZ08yVm5DRHNwSVRzbmJUcXM2QWc2cmlON0tDVjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqc283enNoTGpzbXBRdURRcnJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUTXQ2N2FBN0tDVjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNqYWpzbXBRdURRb05DdXlZaUNBNklPeVZpQ0Ryajd6c21wUXNJT3lYaHV5V3RPeWFsQ0FvV0NrZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJeURzbDRic2xyVHNtcFFnNG9hU0lPeWVpT3lXdE95YWxBMEtEUXJzbUlncERRb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bFpqcXVMQWc3S0NFN0plUTY0cVVJT3F3Z095ZWhlMlZvQ0RzaUpnZw0KN0plRzdKYTA3SnFVSU9LR2tpRHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WlcwN0pXOElPcXdnT3llaGUyVm9DRHNpSmdnN0o2STdKYTA3SnFVRFFvTkNpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFEUW9OQ3V5WGtPdWZyQ0RzZzRIdG1hbnNsNURzaEp6cmo0UWdJdTJWdE9xeXNDRHJzS25yc3BVaTdKMkVJT3Vvdk95Z2dDRHNsWXpyb0tUc283enJpcFFnNnJpTjdLQ1Y3WmlWSU9xMXJPeWhzT3VobkNEc2phanNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRnNG9hU0lPeVZzZXlkaENEc2w0WHJqYkRzbmJUdGlyanRsYlRzbzd6c2hManNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95MW5PeUwNCm9DRHJzb1Rzb0lUc25iUWc3WldFN0pxVTdaVzA3SnFVTGcwS0RRbzZPam9nZEdsd0lPMk1uZXlYaFNEcnNvVHRpcnpzbllBZ1d6Z3VJTzJNbmV5WGhWMGc2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQTBLN1l5ZDdKZUZLT3VMcE95ZHRPeVd2T3Vobk9xM3VDa2c2N0tFN1lxOElPdXN1T3Exck91S2xDRHNsWVRybnBnZ0tpbzRMaUR0akozc2w0VXFLaURzaExuc2haZ2c2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQ0RpZ0pRZzdZYTE2N08wNjRxVUlGdnRtWlhzbmJoZExDRHNtSWd2N0pXRTY0dUk3SmlrSU8yTWtPdUxxT3lkZ0NCYjdKV0U2NHVJN0ppa1hjSzNXK3VFcEYwc0lPdVBtZXlla1NEc25LRHJqNFRyaXBRZ1creTNxT3lHakYzQ3QxdnJqNW5zbnBGZExpQWk3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3ZzdKT3c2ck9nTENBaTY0dXI2cml3SU1LM0lPdVBtZXlla1NMc3NwanJuN3dnN0tlZDdKMjBJT3lWaUNEcnA1N3JpcFFnN0tHdzdaV3A3SjJBDQpJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW82T2pvTkNnMEtJeU1qSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLN0ppSUtRMEtMU0RycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnNG9hU0lPeVZ2ZXEwZ095WGtDRHJqNW5zblpqdGxaanJxYlFnNjZxbzdKNkU3S2VBN0p1UTZyaUk3SjJFSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdaaWM3WU9kSU91TWdPeURnU0RzbFlqcmdyUU5DZzBLS2lyc2hKenJ1WVRzaXFUcmlwUWc3Sk80SU95SW1DRHNub2pzcDREcnA0d3NJTzJLdWV5Z2xTRHRtSnp0ZzUzc25ZQWc2N0NiN0oyRUlPeUltQ0RzbDRic25ZUWc2NVdNSU9LR2tpRHF1STNzb0pYdG1KVWc2Nnk0N0o2bA0KN0p5ODY2R2NJT3lOcU95YWxDNHFLZzBLN0lLczdKcXA3SjZRNjRxVUlPdXN1T3Exck91bHZDRHF2THpxdkx6dG5vZ2c3SjI5N0tlQUlPeVZpdXF6b0NEdG01SHNsclRyczdUcXVMQW83SXFrN0xxVUtTRHJsWXpyckxqc2w1QXNJT3UyZ095Z2xlMllsZXljdk91aG5DRHNrN0RycWJRZzdLQ2M3WktJSU95Z2hPeXl0T3VsdkNEc2s3Z2c3SWlZSU95WGh1dUxwT3F6b0NEc21LVHRsYlR0bFpqcXVMQWc3SW1zN0p1TTdKcVVMZzBLRFFyc21JZ3BEUW90SU9xemhPeWlqQ0Rxc0p6c2hLUWc3WmljN1lPZDdKMkFJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlEaWhwSWdOQzQxSlNEcXVJanJwcXdnN1ppYzdZT2Q2NmVNSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTkM0ZzdMcVE3S084N0phODdaV2NJT3F5dmV5V3RBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJQ2QrN0l1YzZyS2c3SmEwN0pxVVB5Y3NJQ2ZzaTV6cmdwanNtcFEvSnl3Z0ozN3F1NWduSU9xd21leWQNCmdDRHFzN3pyajRUdGxad2c2cks5N0phMDY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUXJzdFp6cmpJRHRsWndnN0xxUTdLTzg3SmE4N1pXWTZyT2dJT3k1bk9xM3ZPMlZuQ0RycDVEdGlLenJwYndnN0pPdzY0cVVJT3F5akNEc29vdnNsWVRzbXBRdURRcnFzcjNzbHJUcmlwUWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1pM3FzcjNzbHJUcnBid3Q3STJvNjQrRUxldVFtT3VLbEMzcXNyM3NtckFwN0plUUlPMlZ0T3VMdWUyVm9DRHJsWXpycDR3ZzdJMm83SnFVTGcwS0RRb2pJeU1nNjQrWjdJS3M3SmVRN0lTY0lDZCs3SXVjSnlEcnVienF1TEFOQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzdaVzA3S2VBN1pXWTdJdWM2cktnN0phMDdKcVVQeURpaHBJZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4TkNpMGc3SXVjN0o2UjdaV1k3SXVjNjRxVUlPdTJoT3lYa09xeWpDQTFMREF3TU95YmtPeWRoQ0RyazV6cm9LVHNtcFF1SU9LR2tpRHNpNXpzbnBIdGxaanJxYlFnDQpOU3d3TUREc201RHNuWVFnNjVPYzY2Q2s3SnFVTGcwS0RRb2pJeU1nSitxemhPeUxuT3VMcENjZzRvYVNJQ2Zzbm9qcmk2UW5EUW9OQ3V5WWlDa05DaTBnN0o2UTY0K1o3TENvNjZXOElPcXdnT3luZ09xem9DRHFzNFRzaTV6cmdwanNtcFEvSU9LR2tpRHNucERyajVuc3NLanFzSUFnN0o2STY0S1k3SnFVUHcwS0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTUlPeVd2T3VuaU95VXFTRHJnclRxczZBZzZyT0U3SXVjNjRLWTdKcVVQeURpaHBJZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91S2xDRHNscnpycDRqc25ianFzSURzbXBRL0lDb282NHVvN0lpY0lPeTVtTzJabU95ZHRDRHNsWVRyaTRqcm5id2c2Nnk0N0o2bDdKMkVJT3lEaU91aG5DRHNrN1FnN0lLczY2R0E3SmlJN0pxVUtTb05DZzBLSXlNaklDZnNsNnpzcllqcmk2UW5JT0tHa2lBbjdabVY3SjI0N1pXWTY0dWtMQ0Ryckx2cmk2UW5EUW9OQ3V5WWlDa05DaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSDZyQ0E3S2VBSU91TA0KcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUlPS0draURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9mcXNJRHNwNEFnNjR1azdJdWNJTzJabGV5ZHVPMlZvT3F5ak95YWxDNE5DZzBLSXlNaklDZnF1NWduSU9LR2tpQW43SmVRNnJLTUp3MEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbU9xN21DRHJncURzbFlUcXNJRHFzNkFnN0o2STdKYTA3SnFVTGlEaWhwSWc3Wm1ONnJpNDY0K1o2NHVZN0plUTZyS01JT3VDb095VmhPcXdnT3F6b0NEc25vanNsclRzbXBRdURRb05DaU1qSXlEcXNyM3NsclRycGJ3ZzY3cVE3SjJFSU91VmpDRHNsclRzZzRudGxad2c2cks5N0pxd0RRb05DdXlDck95YXFleWVrT3lkbUNEc29KWHJzN1RycGJ3ZzY3Q2I2NHFVSU95bmlPdXN1T3lYa095RW5DRHF1TERxczRUc29JSHNuTHpyb1p3Z0ozN3NpNXduNjZXOElPdTZrT3lkaENEcmxZd2c2Nnk0N0o2bDdKMjBJT3lXdE95RGllMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtLaXJ0akl6c2xZWHQNCmxaanFzNkFnN0l1MjdKMkFJT3lnbGV1enRPdWx2Q0FuN0tPODdKYTBKK3VobkNEc2phanNoSndnNjZ5NDdKNmw3SjJFSU95RGlPdWhyZXF5akNEc2phanJzN1RzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhnNG9hU0lPdU1nT3kybkNEcnFxbnNvSUhzbmJRZzY2eTA3SmVIN0oyNDZyQ0E3SnFVUHcwS0xTRHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOGc0b2FTSU95TG9PcXpvQ0RzbmJUc25LRHJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUV1T3lhbEM0TkNnMEtLaW9xRFFvTkNpTWpJRFV1SUNkNzY2cUY3SUtzZlNBcklIdnJxb1hzZ3F4OUp5RHNrN0RzcDRBZzdKV0s2cml3RFFvTkNpTWpJeUR0bFp6c25wRHNsclFnN1pLQTdKYTA3Sk93NnJpd0RRb05DdTJWbk95ZWtPeVd0Q0RycW9Yc2dxenJwYndnN1pLQTdKYTA3SVNjSU91UG1leUNyQ0R0bUpYdGc1enJvWndnDQo3Sk80SU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBRZzRvYVNJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFFOQ2kwZzY0SzA3SjI4SU95NXRPdVRuT3F3a3V5ZHRDRHFzckRzb0p6cmtLQWc3SmlJN0tDVjdKMjA3SmVRN0pxVUlPS0draURyZ3JUc25ienNuWUFnN0xtMDY1T2M2ckNTSU91Q21PcXdnT3VLbENEcmdxRHNuYlRzbDVEc21wUU5DZzBLSXlNaklPMlZuT3lla095V3RPdWx2Q0R0a29Ec2xyVHNrN0RxdUxBZzdKYTA2NkNrN0pxNElPcXl2ZXlhc0EwS0RRb25lK3VxaGV5Q3JIM3FzSUFnZSt1cWhleUNySDN0bGJUc2hKd25JTzJZbGUyRG5PdWhuT3VuakNEdGtvRHNsclRzcEpqcmo0UWc2NDJVSU95NmtPeWp2T3lXdk8yVm1PcXlqQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHY0lPcTFyT3VucE8yVm1PeW5nQ0RycXJ2dA0KbG9qc2xyVHNtcFFnNG9hU0lPeWVsT3lWb2V5ZHRDRHJ0b0Rzb2JIdGxiVHNoSndnNnJXczY2ZWs3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ05pNGc3WkdjNnJpd0lPMkd0ZXlkdkEwS0RRb2pJeU1nNjVDWTdKYTA3SnFVSUNoWUtTRGlocElnNjQrODdKcVVJQ2hQS1EwS0RRcnJxcWpyc0pUc25id2c3Wm1VNjZtMDdKMllJT3lpZ2V5ZGdDRHFzN1hxc0lUc25ZUWc2ck9nNjZDazdaVzBJQ2Zya0pqc2xyVHNtcFFuNjRxVUlPdXFxT3VSa0NBbjY0Kzg3SnFVSit1aG5DRHRoclhzbmJ6dGxiVHNoSndnN0kybzdLTzg3SVM0N0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTnk0ZzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt5SXEreWVrQ0R0a1p6cXVMQU5DZzBLNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3V5aU8yWXVPdUtsQ0RzbFlUcm5wZ2c3WmlWN0l1ZDdKeTg2NkdjSU8yR3RleWR2TzJWdE95RW5DRHNqYWpzbXBRdURRb05DaU1qSXlEcmdxRHNwNXpDdCt5TG5PcXdoTUszNnJpdzZyQ0UNCkRRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnNjRLZzdLZWNJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1RVMHVSRVJnSUh3Z01qQXlOUzR3TVM0d01Td2dNalV1TURFdU1ERWdmQTBLZkNEc2k1enFzSVFnZkNEcXVMRHJzN2dnWUVoSU9rMU5PbE5UWUNBdklPeW5wK3F5akNCZ1NFZzZUVTFnSUNqc21LVHNvSVF2N0ppazdadUVJT3lWaUNEc2xJQXBJSHdnTVRRNk16QTZNVEVzSURFek9qTXdJSHdOQ253ZzZyaXc2ckNFSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRWZsbFpXVmt1VFUwdVJFUmdJQzhnN0tlbjZyS01JR0JaV1ZsWkxrMU5Ma1JFZmsxTkxrUkVZQ0I4SURJd01qVXVNREV1TURGK01qQXlOUzR3TVM0ek1Td2dNakF5TlM0d01TNHdNWDR3TVM0ek1TQjhEUXA4SU91Q29PeW5uQ0FySU95TG5PcXdoQ0I4SUdCWldWbFpMazFOTGtSRUlFaElPazFOWUNCOElESXdNalV1DQpNREV1TURFZ01UUTZNekFnZkEwS2ZDRHNtcFRzbmJ3Z2ZDQmdXVmxaV1M1TlRTNUVSQ2pzbXBUc25id3BZQ0RpZ0pRZzdKdVVMKzJabEMvc2lKZ3Y2NnFwTCtxNGlDL3RocUF2N0oyOElId2dNakF5TlM0d01TNHdNU2pzaUpncElId05DZzBLS2lyc2k1enFzSVFnN0ppSTdKbTRLaW82SU95Q3JPeWFxZXlla09xd2dDRHNwNEhzb0pFZzZyT2c2NlcwNjRxVUlPdXdxZXVzdU1LMzdKaUk3Slc5SU95TG5PcXdoT3lkZ0NCZzdKaWs3S0NFTCt5WXBPMmJoQ0JJT2sxTllPeWRoQ0RzamFqcmo0UWc2NCs4N0pxVUxnMEs3SmlJS1NEc21LVHRtNFFnTVRvd01BMEtEUW9qSXlNZzY2eTQ3SjZsSU95R2pTRHNsN0RzbTVUc25id05DZzBLNjZ5NDdKNmxJT3lWaU95WGtPeUVuT3VLbENBcUt1eWJsTUszN0oyOElPeVZudXlkbUNBdzdKMkVJT3U1dk9xem9Db3FJT3lOcU95YWxDNE5DZzBLN0ppSUtRMEtMU0F5TURJMjY0V0VJREE0N0p1VUlEQTE3SjI4SU95ZWhldUxpT3VMcEM0ZzRvYVNJREl3TWpicmhZUWdPT3libENBMQ0KN0oyOElPeWVoZXVMaU91THBDNE5DZzBLSXlNaklPeURnZXVNZ0NEc2k1enFzSVFnS091RnVPeTJuT3lhcVNrTkNnMEtmQ0Rzb2JEcXNiUWdmQ0R0a1p6cXVMQWdmQTBLZkMwdExTMHRMWHd0TFMwdExTMThEUXA4SURZdzdMU0lJT3V2dU91bmpDQjhJT3V3cWVxNGlDRHNvSVFnZkEwS2ZDQTJNT3UyaENEcnI3anJwNHdnZkNCTzY3YUVJT3lnaENCOERRcDhJREkwN0l1YzZyQ0VJT3V2dU91bmpDQjhJRTdzaTV6cXNJUWc3S0NFSUh3TkNud2dNekRzbmJ3ZzY2KzQ2NmVNSUh3Z1R1eWR2Q0Rzb0lRZ2ZBMEtmQ0F4TXVxd25PeWJsQ0RycjdqcnA0d2dmQ0JPNnJDYzdKdVVJT3lnaENCOERRcDhJREV5NnJDYzdKdVVJT3lkdE95RGdTQjhJRTdyaFlRZzdLQ0VJSHdOQ2cwSzdKaUlLU0Ryc0tucXVJZ2c3S0NFTENBMTY3YUVJT3lnaEN3Z011eUxuT3F3aENEc29JUXNJRFBzbmJ3ZzdLQ0VMQ0EyNnJDYzdKdVVJT3lnaEN3Z011dUZoQ0Rzb0lRTkNnMEtJeU1qSU91bmlPcXdrTUszNnJpdzZyQ0VJT3Vuak91ampBMEsNCkRRcGdSQzFPWUNoTzdKMjhJT3VDcU95ZGpDa2dMeUJnUkMwd1lDanNtS1RyaXBnZzY2ZUk2ckNRS1NBdklHQkVLMDVnS0U3c25id2c2cks5NnJPOEtRMEs3SmlJS1NCRUxUY3NJRVF0TVN3Z1JDMHdMQ0JFS3pFTkNnMEtJeU1qSU91eWlPMll1Q0R0a1p6cXVMQWdLTzJWbU95ZHRPMlVpT3ljdk91aG5DRHF0YXpydG9RcERRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnN0tDRTdabVU2N0tJN1ppNElId2c3WldZN0oyMDdaU0lJT3Exck91MmhDQjhJREF5TFRFeU16UXROVFkzT0N3Z01ERXdMVEV5TXpRdE5UWTNPQ0I4RFFwOElPeTV0T3VUbk91eWlPMll1Q0I4SURUc25wRHJwcXpzbEtrZzdaV1k3SjIwN1pTSUlId2dNVEl6TkMwMU5qYzRMVGt3TVRJdE16UTFOaUI4RFFwOElPcXpoT3lpak91eWlPMll1Q0I4SU8yVm1PeWR0TzJVaUNEcXRhenJ0b1FnZkNBeE1qTXRORFUyTFRjNE9UQXhNaUI4RFFwOElPeWp2T3V2DQp2T3VUc2V1aG5ldXlpTzJZdUNCOElPeVZuaUEyN0o2UTY2YXNMZXVTcENBMzdKNlE2NmFzSUh3Z01USXpORFUyTFRFeU16UTFOamNnZkEwS2ZDRHNncXpzbDRYc25wRHJrN0hyb1ozcnNvanRtTGdnZkNBeE1PeWVrT3VtckNEdGxaanNuYlR0bElnZ2ZDQXdNUzB5TXpRdE5UWTNPRGtnZkEwS0RRb2pJeU1nN0pPdzY2bTBJT3lWaUNEcmtKanJpcFFnN1pHYzZyaXdEUW9OQ2kwZzY0S2c3S2VjN0plUUlPMlZtT3lkdE8yVWlNSzM2N21YNnJpSU9pRGluWXdnTWpBeU5TMHdNUzB3TVN3Z01ERXZNREVOQ2kwZzdJdWM2ckNFN0plUUlPeVlwT3lnaEMvc21LVHRtNFE2SU9LZGpDRHNtS1Rzb0lRZ01leUxuQ0FxS091THFDd2c3SUtzN0pxcDdKNlE2ckNBSU95bmdleWdrU0RxczZEcnBiVHJpcFFnNjdDcDY2eTR3cmZzbUlqc2xiMGc3SXVjNnJDRTdKMkFJT3lZaU95WnVDa3FEUW9OQ2lvcUtnMEtEUW9qSXlBNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1EwS0RRcnRqSjNzbDRVZzY2eTQ2cldzNjRxVQ0KSUNvcTdKZXQ3WldnS2lvbzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdkNucXM3d2dLaXJzbktEdG1KVXFLaWp0aHJYcnM3UXY3WXlRNjR1b0tleVhrQ0RybExEcm5id2c2Nnk0N0xLMDZyQ0FJT3VMck91ZHZPeWFsQzRnN1lPQTdKMjA3WXVBN0oyRUlPdUxwT3VUck95ZGhDRHJsWkFnNjdDWTY1T2M3SXVjSU95VmlPdUN0Q2pyczdqcnJMZ3A2cm1NN0tlQUlPcXdtZXlkdENEcnM3VHFzNkFzSU91enVPdXN1Q0RycDZYcm5iM3NuWVFnNjR1MDdKV0U3Slc4SU8yVnRPeWFsQzROQ2cwS0l5TWpJRERyaTZqcXM0UWc0b0NVSU8yS3VPdW1yT3F4c091MmdPMkVzQ0RydEpEc21wUU5DZzBLN1l5ZDdKZUY3SjIwSU95Q3JPeWFxZXlla095ZG1DRHNsclRybHFRZzdaYUo2NCtaSU91U3BPeVhrQ0RybktqcmlwVHNwNEFnNjZpODdLQ0FJTzJNak95VmhlMlZ0T3lhbEM0TkNnMEtMU0R0bG9ucmo1bnNuWVFnS2lycXNJRHJvWnpycDRucXNiRHJncGdnN1l5UTY0dW83SjJFSU95YWxPcTFyQ29xS095ZHRPMkQNCmlNSzM3SUt0N0tDY3dyZnJvWnpxdDdqc2xZVHNtNFBDdCt5aWhldWpqQ2tnNG9hU0lDb3E3WXlRNjR1bzdaaVZLaW9nS091c3ZPeVd0T3Uwa095YWxDa05DaTBnNnJLdzZyTzh3cmZzZzRIdGc1enJwYndnS2lydGhyWHJzN1RycDR3cUtpQW83Sm1FNjZPTXdyZnNpNlR0aktncElPS0draUFxS3V5VmlPdUN0TzJZbFNvcUlDanNsWXpyb0tUc3BKanNtcFFwRFFvTkNpTWpJeUR0ZzREc25iVHRpNEFnNG9DVUlPeW5wK3lkZ0NEcnFvWHNncXpxdGF3TkNnMEtMU0RycW9Yc2dxenRtSlhzbkx6cm9ad2c2NEdkNjRLMDdKcVVMaURzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5PdWx2Q0RzazdEc3A0QWc3SldLN0pXRTdKcVVJQ2grN0pxVUlDOGdmdXVMcENBdklIN3F1WXpzbXBRL0lPS2RqQ2t1RFFvdElESitOT3lXdE95Z2lPdWhuQ0RzcDZmcXM2QWc3SW05NnJLTUxpRHRsWnpzbnBEc2xyVEN0K3lJbU95TG5leWRoQ0RxdUxqcXNvd2c3SXlUN0tlQUlPeVZpdXlWaE95YWxDNE5DaTBnN0pXSTY0SzBLT3V6DQp1T3VzdUNrZzY2ZWw2NTI5N0oyRUlPeWFsT3lWdmUyVnRDd2dLaXJ0ZzREc25iVHRpNERycDR3ZzY3U1E2NCtFSU91c3RPeUtxQ0R0akozc2w0WHNuYmpzcDRBcUtpRHNsWXpxc293ZzdaVzA3SnFVTGlEc201RHJzN2pzbmJRZ0oreVZqT3Vtdk1LMzdabVY3SjI0Sit5eW1PdWZ2Q0RycDRuc2w3RHRsWmpycWJRZzY3TzQ2Nnk0N0oyRUlPcTN2T3F4c091aG5DRHF0YXpzc3JUdG1aVHRsYlRzbXBRdURRb05DbndnN0oyMDY2Q0g2cktNSU91bmtPcXpvQ0I4SU95ZHRPdWdoK3F5akNCOERRcDhMUzB0ZkMwdExYd05DbndnN0tDQTdKNmw3WldZN0tlQUlPeVZpdXF6b0NEcmdwanFzSURzaTV6cXNxRHNsclRzbXBRL0lId2c3S0NBN0o2bElPeVZpQ0R0bFp3ZzY0SzA3SnFwSUh3TkNud2c3SldNNjZhOElId2c2ckt3N0tDY0lPeVpoT3VqakNCOERRcDhJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lId2c2NDJ3N0oyMDdZU3dJT3lDcmV5Z25DQjhEUW9OQ2lNakl5RHNsWWpyZ3JRbw0KNjdPNDY2eTRLU0RpZ0pRZzdaVzA3SnFVN0xLMERRb05DaTBnS2lydGpKRHJpNmp0bUpVcUt1eWRnQ0FuZnUyVm9PcTVqT3lhbEQ4bjY2R2NJT3Vzdk95V3RPeWFsQzRnNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzdKeUU3WmVZS095Q3JleWduTUszN1lPSTdZZTBJT3VUc1Nuc25ZQWc2ckt3NnJPODY2VzhJT3Vvdk95Z2dDRHFzcjNxczZEdGxiVHNtcFF1RFFvdElDb3E3SldJNjRLMDdaaVZLaXJzbllBZzdJS3M3SXVrN0oyRUlPeUVuT3lJb08yVnRPeWFsQzROQ2kwZzY2ZUk3TG1vN1pHYzY2VzhJT3lOcU95YWxDNGc3SWlyN0o2UXdyZnNvYkRxc2JRbzdKMjA3SU9Cd3Jmc25iVHRsWmpDdCt5ZHRPdUN0Q0RyazdFcDdKMkFJT3EzdU91TWdPdWhuQ0Rya1pEcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzdKV0s3SldFN0pxVUxnMEtEUW9qSXlNZzY3S0U3WXE4SU9LQWxDRHNsWWpyZ3JRZzY2eTQNCjY2ZWw3SjIwSU95Z2xlMlZ0T3lhbEEwS0RRcDhJT3V6dU91c3VPeWR0Q0RzbmJUcm9JZnJpNlFnZkNEcnNvVHRpcndnZkEwS2ZDMHRMWHd0TFMxOERRcDhJT3F5c09xenZNSzM3SU9CN1lPYzY2VzhJTzJHdGV1enRDQjhJRnZ0bVpYc25iaGRJSHdOQ253Z0ozN3RsYURxdVl6c21wUS9KK3VobkNEcnJMenNuWXdnZkNCYjdKV0U2NHVJN0ppa1hTREN0eUJiNjRTa1hTQjhEUXA4SU95RGdlMlpxU0RzaEp6c2lLQWdLeURzbUtUcnBianNxcjNzbmJRZzdJdWs3S0NjSU91UG1leWVrU0I4SUZ2c3Q2anNob3hkSU1LM0lGdDc2NCtaN0o2UmZWMGdmQTBLRFFvdElDZnN0NmpzaG93bjY0cVVJQ29xNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUtpb2c3STJvN0pxVUlDanNtSWc2SUZ2c3Q2anNob3hkd3JkYjdJS3Q3S0NjWFNrdUlDZnJpNnZxdUxBZ3dyY2c2NCtaN0o2UkoreXltT3VmdkNEc3A1M3NuYlFnN0pXSUlPdW5udXVLbENEc29iRHRsYW5zbmJUcmdwZ2c2NHVvNjQrRklDZnN0NmpzDQpob3duNjRxVUlPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRb3RJT3V5aE8yS3ZPeWRtQ0RyajVuc25wRWc3SjIwNjZhRTdKMkFJTzJabE91cHRDRHF1TERyaXFYcnFvVW82N09BNnJLOXdyZnRsYlRzb0p3ZzY1T3hLZXlkaENEcXQ3anJqSURyb1p3ZzdJSzA2NkNrN0pxVUxnMEtEUW9qSXlNZzdZYTE3S2VjSU95WWlPeUxuQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0oyMDdZT0lLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHNvSURzbnFVZzdKV0lJTzJWbkNEcmdyVHNtcWtOQ2kwZzdKV0k2NEswT2lEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhnN0o2RjY2Q2w3WldjSU91Q3RPeWFxZXlkdENEc2dxenJuYnpzb0xqc21wUXVEUW90SU91eWhPMkt2RG9nN0pXRTY0dUk3SmlrSU1LM0lPdUVwQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0lLdDdLQ2NJQ2pzbklUdGw1Z3BLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHJqYkRzbmJUdGhMQWc3SUt0N0tDY0RRb3RJT3lWaU91Qw0KdERvZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHNnclRycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lLdDdLQ2M3WldnNnJtTTdKcVVQdzBLTFNEcnNvVHRpcnc2SU95VmhPdUxpT3lZcENEQ3R5RHJoS1FOQ2cwS0tpcnJqNW5zbnBIdG1KVWc0b0NVSU95RW5PeUlvQ0FySU91UG1leWVrU0Ryc29UdGlyd3FLZzBLTFNEdGc0RHNuYlR0aTRBNklPcTRzT3E0c0NEc2w3RHFzckFnN1pXMDdLQ2NEUW90SU95VmlPdUN0RG9nN0lTZzdZT2Q3WldjSU9xNHNPcTRzT3lkbUNEc2w3RHFzckRzbllRZzY0R0s3SmEwN0pxVUxnMEtMU0Ryc29UdGlydzZJT3kzcU95R2pDREN0eURzbDdEcXNyQWc3WlcwN0tDY0RRb05DaW9xN0pXSTY0SzA3WmlWSU9LQWxDRHNtWVRybzR3ZzdZYTE2N08wS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURxc3JEc29Kd2c3Sm1FNjZPTURRb3RJT3lWaU91Q3REb2c2ckt3N0tDYzZyQ0FJT3lnbGV5RGdTRHNzcGpycHF6cmtKRHNsclRzbXBRdURRb3RJT3V5aE8yS3ZEb2c3Wm1WN0oyNERRb04NCkNpb3FLZzBLRFFvaklPeVlpT3ladUNEcXQ1enN1WmtOQ2cwSzdKdVE3TG1aS091S3BldVBtY0szNnJpTjdLQ1Z3cmZzdXBEc283enNscndwNjdPMDY0dWtJT3lZaU95WnVPcXdnQ0RyalpRZzY2cUY3Wm1WN1pXY0lPeTdwT3V1cE91TGlPeThnT3lkdE95Rm1PeWRoQ0RycDR6cms1enJpcFFnNnJLOTdKcXc3SmlJN0pxVUxnMEtEUW9qSXlEc21JanNtYmdnTVM0ZzdJaVk2NCtaN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzY1Q1k2NHFVSU9xeXZleWFzQTBLRFFvakl5TWc3SVNjNjdtRTdJcWtJT3lpaGV1ampDd2c2cml3NnJDRUlPdW5qT3VqakEwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95anZPeVd0Q2pzb29Ycm80d2c3SVNjNjdtRTdJcWtMQ0RxdUxEcXNJUWc2NU94S2V1bHZDRHFzSlhzb2JEdGxhQWc3SWlZSU95ZWlPcXpvQ3dnSit5aWhldWpqQ2ZzbVlBZ0ordW5qT3VqakNmc25aZ2c2NG1ZN0pXWjdJcWs2Nlc4SU95Z2xlMlpsZTJlaUNEc29JVHJpNnp0bGFBZzdJaVlJT3llDQppT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0JQVDA4ZzdJU2M2N21FN0lxa0lPeWloZXVqakNEc2xZanJnclFnNG9DVUlEQXc3SnVVSURBdzdKMjg2N2FBN1lTd0lPeUVuT3U1aE95S3BPcXdnQ0Rzb29Ycm80enJqN3pzbXBRdUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZUWc3SldNNjZDazY1T2M2NkNrN0pxVUxnMEtMU0RzbnBEc2dyQWc3S0d3N1pxTUlPcTRzT3F3aE95ZHRDRHFzNmNnNjZlTTY2T002NCs4N0pxVUxnMEtEUXJyaTZnc0lDb3E3S084NnJpdzdLQ0I3Snk4NjZHY0lPeWloZXVqak9xd2dDRHJzSmpyczdYcmtKanJpcFFnN0tDYzdaS0lLaXJzbDVEcmlwUWdKK3lpaGV1ampPdVB2T3lhbENmcnBid2c3Sk93N0tlQUlPeVZpdXlWaE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbUtUcmlwanNuWmdnN1lDMDdLYUk2ckNBSU9xenB5RHNvb1hybzR6cmo3enNtcFFnNG9hU0lPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEEwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0plUQ0KNnJLTUlPdXZ1T3k1bU91S2xDRHNtSUh0bHFYc25ZUWc3SldNNjZDazdLU0VJT3VWakEwS0RRb283S084N0pxVUlPdVBtZXlDckNBNklPeVhzT3l5dEN3ZzdaVzA3S2VBTENEc29JSHNtcWtnNjVPeEtRMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWR1T3F6dkNEcXRJRHFzNFRycGJ3ZzY2cUY3Wm1WN1pXWTZyS01JT3lFcE91cWhlMlZtT3F6b0N3Z0oreUNyT3lhcWV5ZWtPeWRtQ0R0bG9ucmo1bnNsNUFnNjVTdzY1Mjg3SmlrNjRxVUlPcXlzT3F6dkNmcm5ienJpcFFnN0tDUTdKMkVJT3lWak91Z3BPeWtoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lZcE91S21PcTVqT3luZ0NEcmdyVHNwNEFnN0pXSzdKeTg2Nm0wSU95WHNPeXl0T3VQdk95YWxDNGc3WnVFNjdhSTZyS3c3S0NjSU9xNGlPeVZvZXlkaENEcmdyVHNvN3pzaExqc21wUXVEUW90SU91TWdPeTJuT3lkaENEcXNJanNsWVR0ZzREcnFiUWc3SnVRNjU2WUlPdU1nT3kybk95ZHRDRHRsYlRzcDREcmo3enMNCm1wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXaWV5WGtDRHJnclRzbGJ3ZzdaVzA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95VmlPeUxyQ0FvN0lpWTY0K1o3WmlWS1EwS0RRb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3SXVjN0lxazdZV2M3SjIwSU95ZWtPdVBtZXljdk91aG5DRHNzcGpycHF6dGxaenJpNlRyaXBRZzdLQ1FLaXJzbllRZzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95ZHRPeWduT3UyZ08yRXNDRHRtWTNxdUxqcmo1bnJpNWpzblpnZzZyQ2M3SjI0N0tDVjY3TzBJT3lkdE95YXFTRHJnclRzbDYzc25iUWc2cml3NjZHZDY0Kzg3SnFVRFFvdElPdU5sQ0Rzb292c25ZQWc3SU9CNjR1MDdKMkVJT3ljDQpoTzJWdENEdGhyWHRtWlFnNjRLMDdKcXA3SjJBSU91RnVleWRqT3VQdk95YWxBMEtEUW9qSXlEc21JanNtYmdnTWk0ZzZySzk3SmEwNjZXOElPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdEUW9OQ3UyS3VleWdsU0RzZzRIdG1hbnNsNURzaEp3ZzdLQ2M3WldjN0tDQjdKeTg2NkdjSUNmc2k1enJncGpzbXBRL0xDRHNoYWpyZ3Bqc21wUS9KeURzblpqcnJManRtSlVnN0phMDY2KzQ2Nlc4SU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0oyWUlPdW5wZXVkdmV5ZGhDRHRtWnpzbXFudGxiVHNoSndnN0tlSTY2eTQ3WldnSU91VmpBMEtEUW9uN0l1YzY0S1k3SnFVUHljc0lDZnNoYWpyZ3Bqc21wUS9KeUR0bUpYdGc1enNuWmdnNnJLOTdKYTA2Nlc4SU8yWm5PeWFxZTJWdE95RW5DRHNncXpzbXFuc25wRHNuWmdnNjR1NTdabXA3SXFrNjUrczdKdUE3SjJFSU95a2hPeWR2Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbUN3Zw0KVDA5UElPdUxwT3VGZ095WXBPeUZxT3VDbU95YWxEOE5DaTBnN0xhcDdLQ0U3WldZNjUrc0lPMk91T3lkbU95Z2tDRHFzSURzaTV6cmdwanNtcFEvRFFvTkNpTWpJeURzZ3F6c21xbnNucERzblpnZzdJT0I3Wm1wN0oyRUlPeTJsT3lnbGUyVm9DRHJsWXdOQ2cwSzY2cUY3Wm1WN1pXY0lPeWdsZXV6dE9xd2dDRHNsNGJzbHJUc2hKd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeW5nZXlna1NEdGpKRHJpNmp0bFpqcXNvd2c3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzdWJUcms1enJwYndnNjdDYjdKeTg3SVdvNjRLWTdKcVVQeURyazdIcm9aM3RsWmpycWJRZzdMcVE3SXVjNjdDeElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwS0l5TWpJT3lDck95YXFleWVrT3lkbUNEc2hLRHNuWmpxc0lBZzdaV0U3SnFVN1pXZ0lPdVZqQTBLRFFyc2hLVHINCnJManNvYkRzZ3F6c3NwanJuN3dnN0lLczdKcXA3SjZRN0oyWUlPeUVvT3lkbU91bHZDRHF1TERyaklEdGxiVHNsYndnN1pXZ0lPdVZqQ0Rxc3Izc2xyVHJvWndnN0tDVjdLU1I3WldZNnJLTUlPeW5pT3VzdU8yVnRPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25iVHJzb2dnNjR1czdKZVFJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bFpqcnFiVHNoSndnN0phODY2ZUk2NEtZSU91bmpPeWhzZTJWbU95RnFPdUNtT3lhbEQ4TkNnMEtJeU1nN0ppSTdKbTRJRE11SU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU91UW1PdUtsQ0Rxc3Izc21yQU5DZzBLN0lLczdKcXA3SjZRN0plUTZyS01JT3VxaGUyWmxlMlZtT3F5akNEcnRvRHNvSlhzb0lIc25iZ2c2NEswN0pxcDdKMkVJT3lWak91Z3BPeWttT3lWdkNEdGxhQWc2NVdNNjRxVUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPeWlpK3lWaE95YWxDNE5DZzBLSXlNaklPeUVuT3U1aE95S3BPdWx2Q0Rzb0pYc3NZWHNnNEVnDQo3Sk80SU95SW1DRHNsNGJzbllRZzY1V01EUW9OQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeURnZTJacWV5ZGhDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3SXVjN1lLc0lPeUltQ0Rzbm9qc2xyVHNtcFF1SUNvcTdKTzRJT3lJbUNEc2w0YnJpcFFnN0oyMDdKeWc2Nlc4SU8yVnFPcTdtQ0RzbFlqcmdyVHRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNwNERxdUlqc25ZQWc2ckNBN0o2RjdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlPeXlyZXlHak91RmhPeWRoQ0RzbklUdGxad2c3SVNjNjdtRTdJcWs2NHFVSU95VmhPeW5nU0RzcElEcnVZUWc3S1NSN0oyMDdKZVE3SnFVTGcwS0xTRHFzN1hyckxUc201RHNuWUFnN1p1RTdKdVE2cmlJN0oyRUlPdXp0T3VDdkNEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SjI4NjdhQUlPcTRzT3VLcGV1bmpDRHNrN2dnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLNjdhQTdLQ1Y3WmlWN0p5OA0KNjZHY0lPeU5xT3lWdkNEc2dxenNtcW5zbnBEcXNJQWc3SmEwNjVha0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeVhodXVLbE95bmdDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3WldnSU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlFJT3lFb08yRG5leWRtQ0Rxc3JEcXM3enJwYndnN0pXSTY0SzA3WldnSU91VmpBMEtEUXJya0pqcmo0enJwclFnN0lpWUlPeVhodXVLbENEc2hLRHRnNTNzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJWbU9xeWpDRHNsWXpyb0tUc21wUXVEUW9OQ3V5WWlDa05DaTBnN1pXY0lPdXkNCmlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrTkNnMEtKK3lnbGV1enRDRHNpSmpzcDVFZzdKV0k2NEswSnlEcms3SHNuWmdnNjYrODZyQ1E3WldjSU95RGdlMlpxZXlYa095RW5DQXFLdXlnbGV1enRPcXdnQ0RyczdUdG1ManJrSnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeURnZXVMdE95ZHRDRHJnWjNyZ3BqcnFiUWc3S0NFNjZ5NDZyQ0E2NCtFSU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHJwYndnNjdPOElPeUltQ0RzbDRic2xyVHNtcFF1RFFvdElPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1Rxc0lBZzZyaXc2NkdkNjVDWTdLZUFJT3lWDQppdXlWaE95YWxDNE5DZzBLSXlNZzdKaUk3Sm00SURRdUlPeWduTzJTaUNEc21xbnNsclRyaXBRZzY3Q1U2cjY0N0tlQUlPeVZpdXE0c0EwS0RRb242ckNFNnJLdzdaV1k2ck9nSU95SnJPeWF0Q0RycDVBbklPeWJrT3k1bWV1enRPdUxwQ0FxS3UyWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhlcXp2T3lkbUNEc21xbnNsclFnN0oyODdMbVlLaXJxc0lBZzdKcXc3SVNnN0oyMDdKZVE3SnFVTGcwSzZyaXc2NHFsNjZxRjdKZVFJT3lUc095ZHVDRHJpNmpzbHJRbzY3T0E2cks5TENEc3A0RHNvSlVzSU91VHNldWhuU0RyazdFcDY2VzhJT3lWaU91Q3RDRHJyTGpxdGF6c2w1RHNoSndnNjR1azY2VzRJT3Vua091aG5DRHJzSlRxdnJqcnFiUWc3SUtzN0pxcDdKNlE2ckNBSU91THBPdWx1Q0RxdUxEcmlxWHNuTHpyb1p3ZzdKaWs3WlcwN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tnSitxMmpPMlZuQ0RyczREcXNyMG5JT3E0c091S3BleWRtQ0RzbFlqcmdyUWc2Nnk0NnJXcw0KRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3Q1U2citBSU95SW1DRHNub2pzbHJUc21wUWdLRmdwRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3T0E2cks5N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSU95WWlPeVp1Q0ExTGlEc2k1enNpcVR0aFp3ZzY0K1o3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXdnN0pPdzdLZUFJT3lWaXVxNHNBMEtEUXJyckxqcXRhenJwYndnN0pXRTY2eTA2NmFzSU91bnBPdUJoT3VmdmVxeWpDRHJpNlRyazZ6c2xyVHJqNFFnS2lyc2k2VHNvSndnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NLaXJycGJ3ZzdKT3c2Nm0wSU95ZW1PdXF1K3VRbkNEcnJManF0YXpzbUlqc21wUXVEUW9OQ3V5WWlDa2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWUNCmtPdWx2Q0FuN0xhVTZyQ0FJT3luZ095Z2xTZnRsWmpyaXBRZzdJdWM3SXFrN1lXYzdKZVE3SVNjSUNqc25iVHNvSVRDdCt5V2tldVBoQ0RxdUxEcmlxWHNuYlFnN0pXRTY0dVlLUTBLTFNEcmk2VHJwYmdnN0lLczY1Nk03SmVRNnJLTUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJwYndnNjRTWTZyS283S084N0lTNDdKcVVJQ2hZSU9LQWxDRHNsNGJyaXBRZ0ordUVtT3E0c09xNHNDY2c2cml3NjRxbDdKMkVJT3lWbE95TG5Da05DaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVnRDRHNvN3pzaExqc21wUWdLRThwRFFvPQ0KOjpMQVVOQ0hFUjo6DQovLzRuQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJDQUhJQWFRQmtBR2NBWlFBZ0FHd0FZUUIxQUc0QVl3Qm9BR1VBY2dBZ0FCUWdJQURvc3NTc3hMd2dBQ1RCRmNnZ0FCRElnS3dnQU1UV0lBRGtzcXk1SUFEa3dvblZDZ0FuQUNBQVl3QnNBR0VBZFFCa0FHVUFZZ0J5QUdrQVpBQm5BR1VBT2dBdkFDOEFJQUFFMVZ5NG9ORmN6M1RISUFCMHh5QUFETk44eDBUSElBQ0F2WGk1NUxJZ0FDZ0E4YlJkdURvQUlBQnVBSEFBYlFBZ0FHa0FiZ0J6QUhRQVlRQnNBR3dBSUFBUXRwU3lJQUFpQUhUUVhMamN0Q0FBNU00bHNURFJJZ0FnQUNUQldNNGdBQXpUZk1jcEFDNEFDZ0FuQUNBQVZMc0FyQ0FBWUw0NHlDQUFpTWM4eDNTNklBQmMxU0FBaUx6UXhTQUFXTldZc0NuRklBQkl4YlN3V05YZ3JDd0FJQURrc2lBQUFNbEV2aGkwZExvZ0FPU3lyTGw4dVNBQVBjd2dBTWJGZE1jZ0FPVENpZFZjMWVTeUxnQUtBRk1BWlFCMEFDQUFaZ0J6QUc4QUlBQTlBQ0FBUXdCeUFHVUFZUUIwQUdVQVR3QmlBR29BWlFCakFIUUFLQUFpQUZNQQ0KWXdCeUFHa0FjQUIwQUdrQWJnQm5BQzRBUmdCcEFHd0FaUUJUQUhrQWN3QjBBR1VBYlFCUEFHSUFhZ0JsQUdNQWRBQWlBQ2tBQ2dCVEFHVUFkQUFnQUhNQWFBQWdBRDBBSUFCREFISUFaUUJoQUhRQVpRQlBBR0lBYWdCbEFHTUFkQUFvQUNJQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZNQWFBQmxBR3dBYkFBaUFDa0FDZ0JrQUdrQWNnQWdBRDBBSUFCbUFITUFid0F1QUVjQVpRQjBBRkFBWVFCeUFHVUFiZ0IwQUVZQWJ3QnNBR1FBWlFCeUFFNEFZUUJ0QUdVQUtBQlhBRk1BWXdCeUFHa0FjQUIwQUM0QVV3QmpBSElBYVFCd0FIUUFSZ0IxQUd3QWJBQk9BR0VBYlFCbEFDa0FDZ0J6QUdnQUxnQkRBSFVBY2dCeUFHVUFiZ0IwQUVRQWFRQnlBR1VBWXdCMEFHOEFjZ0I1QUNBQVBRQWdBR1FBYVFCeUFBb0FDZ0FuQUNBQU1RQXZBRElBS1FBZ0FFNEFid0JrQUdVQUxnQnFBSE1BSUFBUXlJQ3NJQUFVSUNBQXhzVTh4M1M2SUFEa3NyVEdYTGpjdENBQW1OTjB4OERKZkxrZ0FQVEZ0TVVBeWVTeUNnQkpBR1lBSUFCekFHZ0ENCkxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BSUFCM0FHZ0FaUUJ5QUdVQUlBQnVBRzhBWkFCbEFDSUFMQUFnQURBQUxBQWdBRlFBY2dCMUFHVUFLUUFnQUR3QVBnQWdBREFBSUFCVUFHZ0FaUUJ1QUFvQUlBQWdBRWtBWmdBZ0FFMEFjd0JuQUVJQWJ3QjRBQ2dBSWdCT0FHOEFaQUJsQUM0QWFnQnpBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0JiQUZYV2VNZGRBRVRISUFBRXNuUzVkTG9nQU9TeXRNWmN1TnkwSUFDWTAzVEh3TWtBckNBQTlNVzl1Y2l5NUxJdUFDQUFKTUZZem55NUlBREl1VnpPSUFDa3RDd0FJQUFNMWV5MytLMTR4OURGSE1FZ0FIVFFYTGpjdENBQWhMeTgwa1RISUFEa3N0ekNJQUFNc3V5M0lBRDh5RGpCbE1ZdUFDSUFMQUFnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBDQpJQUIyQUdJQVR3QkxBRU1BWVFCdUFHTUFaUUJzQUNBQUt3QWdBSFlBWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BREVBTHdBeUFDa0FJQUFVSUNBQVRnQnZBR1FBWlFBdUFHb0Fjd0FpQUNrQUlBQTlBQ0FBZGdCaUFFOEFTd0FnQUZRQWFBQmxBRzRBQ2dBZ0FDQUFJQUFnQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JvQUhRQWRBQndBSE1BT2dBdkFDOEFiZ0J2QUdRQVpRQnFBSE1BTGdCdkFISUFad0F2QUdzQWJ3QXZBR1FBYndCM0FHNEFiQUJ2QUdFQVpBQWlBQW9BSUFBZ0FFVUFiZ0JrQUNBQVNRQm1BQW9BSUFBZ0FGY0FVd0JqQUhJQWFRQndBSFFBTGdCUkFIVUFhUUIwQUFvQVJRQnVBR1FBSUFCSkFHWUFDZ0FLQUNjQUlBQXlBQzhBTWdBcEFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNBQUVNaUFyQ0FBRkNBZ0FNYkZQTWQwdWlBQUpNRll6cmNBWExqNHJYakhJQUFwdkpXOFJNY2dBRWpGdExCYzFlU3lDZ0JKQUdZQQ0KSUFCekFHZ0FMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQUlBQjNBR2dBWlFCeUFHVUFJQUJqQUd3QVlRQjFBR1FBWlFBaUFDd0FJQUF3QUN3QUlBQlVBSElBZFFCbEFDa0FJQUE4QUQ0QUlBQXdBQ0FBVkFCb0FHVUFiZ0FLQUNBQUlBQk5BSE1BWndCQ0FHOEFlQUFnQUNJQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpQUFLQUFRdHBTeUlBQlFBRUVBVkFCSUFOREZJQURHeGJURmxNWXBBQzRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQXcwZmk3RUxIUXhSekJJQUJFeFppM2ZMa2dBQ1RCV002M0FGeTQrSzE0eDF6VklBQ2t0Q3dBSUFCMDBGeTQzTFFnQUlTOHZOSkV4eUFBNUxMY3dpQUFETExzdHlBQS9NZzR3WlRHT2dBaUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUENCkpnQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBaUFDQUFJQUJ1QUhBQWJRQWdBR2tBYmdCekFIUUFZUUJzQUd3QUlBQXRBR2NBSUFCQUFHRUFiZ0IwQUdnQWNnQnZBSEFBYVFCakFDMEFZUUJwQUM4QVl3QnNBR0VBZFFCa0FHVUFMUUJqQUc4QVpBQmxBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUlBQWdBR01BYkFCaEFIVUFaQUJsQUNBQWJBQnZBR2NBYVFCdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBVmRaNHh5QUFLYnlWdkRvQUlBQXcwZmk3RUxIUXhSekJJQUJqQUd3QVlRQjFBR1FBWlFBZ0FDMEFMUUIyQUdVQWNnQnpBR2tBYndCdUFDQUFkTWNnQUlTOEJNaEV4eUFBbk0wbHVGalZkTG9nQUFESlJMNGdBRVRHekxpRng4aXk1TEl1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBDQpYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUtBQ3N3S25HeWJkQXh5QUFkTWNnQUZBQVF3RFF4U0FBWExqNHJYakhITFFnQUhUUVhMamN0Q0FBYkszRnN5QUFYTlhFczlERkhNRWdBQ2pNRUt3cHRNaXk1TEl1QUNrQUlnQXNBQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FIWUFZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FESUFMd0F5QUNrQUlBQVVJQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDSUFDZ0FnQUNBQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZFQWRRQnBBSFFBQ2dCRkFHNEFaQUFnQUVrQVpnQUtBQW9BSndBZ0FBREpSTDRnQUVUR3pMZ2dBQlFnSUFEa3NxeTVmTGtnQUQzTUlBREd4WFRISUFEa3dvblZJQUFvQUF6VjdMZjRyWGpIZE1jZ0FPZXNJQUNReDlteklBQVFyTURKS1FBS0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCakFHMEFaQUFnQUM4QVl3QWdBRzRBYndCa0FHVUFJQUJ6QUdNQQ0KY2dCcEFIQUFkQUJ6QUZ3QVl3QnNBR0VBZFFCa0FHVUFMUUJpQUhJQWFRQmtBR2NBWlFBdUFHb0Fjd0FpQUN3QUlBQXdBQ3dBSUFCR0FHRUFiQUJ6QUdVQUNnQT0NCjo6V0FUQ0hFUjo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rxc0pEc2k1enNucEFnNG9DVUlPMlZyZXlEZ1NEcmxxQWc3SjZJNjRxVUlPeTBpT3lHak8yWWxTRHNoSnpyc29RZ0tHeHZZMkZzYUc5emREb3hNVGc0T1NrTkNpOHZJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0EwS0x5OGc3Sm1jSU8yVmhPeWFsTzJWbk9xd2dEb2c3WlM4NnJlNDY2ZUk2ckNBSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JqYkdGMVpHVmljbWxrWjJVNkx5OGc3SmUwNnJpd0tIZHBibVJ2ZHk1dmNHVnVMMmxtY21GdFpTOXZjR1Z1UlhoMFpYSnVZV3dwNjZXOA0KRFFvdkx5RHNvSVRydG9BZzdJYU02NmFzSU95WGh1eWR0Q0RycDRucmlwUWc2N0tFN0tDRTdKMjBJT3llaU91THBDNGdabVYwWTJqcmlwUWc2NnE3SU91bmlleWN2T3V2Z091aG5Dd2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPeWR0Q0Rxc0pEc2k1enNucERzbDVEcXNvd05DaTh2SUZCUFUxUWdMM2RoYTJVZzY2VzhJT3V6dE91Q3RPdXB0Q0Rxc0pEc2k1enNucERxc0lBZzY0dWs2NmFzS0dOc1lYVmtaUzFpY21sa1oyVXVhbk1wNjZXOElPdU1nT3lMb0NEc3ZLRHJpNlF1RFFvdkx3MEtMeThnNjR1azY2YXM3Sm1BN0oyWUlPeXdxT3lkdERvZzZyQ1E3SXVjN0o2UTY0cVVJR05zWVhWa1pldWx2Q0Ryckx6c3A0QWc3SldLNjRxVTY0dWtLT3lla095TG5TRHNsNGJzbll3cElPS0draUR0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3VsdkNEc2xZZ2c2NmVKNnJPZ0xBMEtMeThnNjZtVTY2cW82NmFzSUg0eE5VMUM2NTI4SU91aG5PcTN1T3lkdUNEc2k1d2c3SjZRNjQrWklPeUxuT3lla2V5Y3ZPdWgNCm5DRHNnNEhzaTV3ZzdMeWM2NUdzNjQrRUlPdTJnT3VMdENEc2w0YnJpNlFnS091VHNldWhuVG9nYm5CdElISjFiaUJpZFdsc1pDa3VEUW92THlEcmk2VHJwcXpyaXBRZzdJdXM3SjZsNjdDVjY0K1pJT3VCaXVxNHNPdXB0Q0Rzbzczc3A0RHJwNHdvN1pTTTY1K3M2cmU0N0oyNDZyTzhJT3lEbmV5Q3JDRHJqNW5xdUxEdG1aUXBMQ0Rxc0pEc2k1enNucERyaXBRZzZyT0U3SWFOSU91Q3FPeVZoQ0RyaTZUc25Zd2c2cm1vN0pxdzZyaXc2Nlc4SU91d20rdUtsT3VMcEM0TkNnMEtZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNOQ21OdmJuTjBJSEJoZEdnZ1BTQnlaWEYxYVhKbEtDZHdZWFJvSnlrN0RRcGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0RRcGpiMjV6ZENCdmN5QTlJSEpsY1hWcGNtVW9KMjl6SnlrN0RRcGpiMjV6ZENCN0lITndZWGR1TENCemNHRjNibE41Ym1NZ2ZTQTlJSEpsY1hWcGNtVW9KMk5vYVd4a1gzQnliMk5sYzNNbktUc05DZzBLWTI5dWMzUWdVRTlTDQpWQ0E5SURFeE9EZzVPdzBLWTI5dWMzUWdVazlQVkNBOUlIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljcE95QXZMeURzb0lEc25xWHNob3dnNjZPbzdZcTRJT0tBbENEcmk2VHJwcXpxc0lBZ2NtVmpiMjF0Wlc1a0xXVjRZVzF3YkdWekxtMWs2Nlc4SU95d3Z1dUtsQ0RxdUxEc3BJQU5DZzBLWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3MEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0U0dWaFpHVnljeWM2SUNkRGIyNTBaVzUwTFZSNWNHVW5MQTBLZlRzTkNtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXcwS0lDQnlaWE11ZDNKcGRHVklaV0ZrS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MA0KWlc1MExWUjVjR1VuT2lBbllYQndiR2xqWVhScGIyNHZhbk52YmpzZ1kyaGhjbk5sZEQxMWRHWXRPQ2NnZlN3Z1EwOVNVMTlJUlVGRVJWSlRLU2s3RFFvZ0lISmxjeTVsYm1Rb1NsTlBUaTV6ZEhKcGJtZHBabmtvYjJKcUtTazdEUXA5RFFvTkNpOHZJR05zWVhWa1pTQkRURW5xc0lBZzdKNkk2NHFVN0tlQUlPS0FsQ0RzbDRic25MenJxYlFnTDNkaGEyVWc3SjJSNjR1MTdKZVFJT3lMcE95V3RDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdKV0k2NEswN1pXZ0lPeUltQ0Rzbm9qcXNvd2c3WldjNjR1a0RRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU95ZHZlcTRzQ0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOeklDanJpNlRycHF6c25aZ2dZMnhoZFdSbFFXTmpiM1Z1ZE95WmdDRHFzSm5zbllBZzdMYWM3TEtZS1M0TkNpOHZJTzJNak95ZHZPeWR0Q0R0Z2JRZzdJaVlJT3llaU95V3RDQXoNCk1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLTHk4ZzdMcVE3SXVjSURYc3RJZ2c0b0NVSU91aG5PcTN1T3lkdUNEc3A0SHRtNFFnN0lPSUlPcXpoT3lnbGV5ZHRDRHFzNmZyc0pUcm9ad2c3SjZoN1ppQTdKVzhJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKZVE3SVNjSU8yWmlPeWN2T3VobkNEcmhKanNsclRxc0lUcmk2UW9NekRzdElqcnFiUWc2NFNJNjZ5MElPdUtwdXlkakNrTkNteGxkQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lBd0xDQmxiV0ZwYkRvZ2JuVnNiQ0I5T3cwS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzTkNpQWdhV1lnS0VSaGRHVXVibTkzS0NrZ0xTQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BDQTFNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzDQpPdzBLSUNCc1pYUWdaVzFoYVd3Z1BTQnVkV3hzT3cwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTNXFjMjl1Snlrc0lDZDFkR1k0SnlrcE93MEtJQ0FnSUdWdFlXbHNJRDBnS0dvZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpLU0I4ZkNCdWRXeHNPdzBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcm9aenF0N2pzbmJnZzdKMjA2NkNsSU95WGh1eWRqQ0RyazdFZzRvQ1VJRzUxYkd3Z0tpOGdmUTBLSUNCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQkVZWFJsTG01dmR5Z3BMQ0JsYldGcGJDQjlPdzBLSUNCeVpYUjFjbTRnWlcxaGFXdzdEUXA5RFFvTkNtWjFibU4wYVc5dUlHaGhjME5zWVhWa1pTZ3BJSHNOQ2lBZ1kyOXVjM1FnWm1sdVpHVnlJRDBnY0hKdlkyVnpjeTV3YkdGMA0KWm05eWJTQTlQVDBnSjNkcGJqTXlKeUEvSUNkM2FHVnlaU2NnT2lBbmQyaHBZMmduT3cwS0lDQjBjbmtnZXlCeVpYUjFjbTRnYzNCaGQyNVRlVzVqS0dacGJtUmxjaXdnV3lkamJHRjFaR1VuWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lITm9aV3hzT2lCMGNuVmxJSDBwTG5OMFlYUjFjeUE5UFQwZ01Ec2dmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVjBkWEp1SUdaaGJITmxPeUI5RFFwOURRb05DbXhsZENCM1lXdHBibWNnUFNCbVlXeHpaVHNnTHk4ZzdKZXc3WU9BSU91d3FleW5nQ0RpZ0pRZzY0dWs2NmFzNjRxVUlPeVd0T3l3cU8yVXZDQkZRVVJFVWtsT1ZWTkY2NkdjSU95a2tldXp0U0Rzb0pYcnBxenRsWmpzcDREcnA0d2c3WlNFNjZHYzdJUzQ3SXFrSU91Q3JldTVoT3VsdkNEc3BJVHNuYmpyaTZRTkNtWjFibU4wYVc5dUlIZGhhMlZDY21sa1oyVW9LU0I3RFFvZ0lHbG1JQ2gzWVd0cGJtY3BJSEpsZEhWeWJqc05DaUFnZDJGcmFXNW5JRDBnZEhKMVpUc05DaUFnYzJWMFZHbHRaVzkxZENnb0tTQTkNClBpQjdJSGRoYTJsdVp5QTlJR1poYkhObE95QjlMQ0ExTURBd0tUc05DaUFnYkdWMElIQnliMk03RFFvZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2dJQ0FnTHk4Z1YybHVaRzkzY3pvZ1kyMWt3cmQyWW5NZzZySzk3SnlnSU95WGh1eWR0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTd2dkMmx1Wkc5M2MwaHBaR1VvUTFKRlFWUkZYMDVQWDFkSlRrUlBWeW5yb1p3ZzdJcWs3WSt3SU9LQWxBMEtJQ0FnSUM4dklPeXd2U0RzbDRicmlwUWc3SWlvN0oyQUlPeTltT3lHbE95ZHRDRHJwNHpyazZUc2xyVHNwNERxczZBZzY0dWs2NmFzN0oyWUlPeWVrT3lMblNoamJHRjFaR1VwNjQrRUlPcTN1Q0Rzdlpqc2hwVHNuWVFnNjZ5ODY2Q2s2N0NiN0pXRUlPeVd0T3VXcENEc3NMM3JqNFFnN0pXSUlPdWNyT3VMcEM0TkNpQWdJQ0F2THlCa1pYUmhZMmhsWk91S2xDRHNrN0RzcDRBZzdKV0s2NHFVNjR1a0tHUmxkR0ZqYUdWa0szZHBibVJ2ZDNOSWFXUmxJT3loc08yVnFleWRnQ0RzDQp2WmpzaHBRZzdMQzk3SjIwSU91RnVPeTJuT3VRcUNEaWdKUWc3SXVrN0xpaEtTNE5DaUFnSUNBdkx5QlhhVzVrYjNkejdKZVE3SVNnSUdSbGRHRmphR1ZrSU95WGh1eWR0T3VQaENEcnRvRHJxcWdvNnJDUTdJdWM3SjZRS2Vxd2dDRHNvNzNzbHJUcmo0UWc3SjZRN0l1ZDdKMkFJT3lDdE95VmhPdUNxT3VLbE91THBDNE5DaUFnSUNCd2NtOWpJRDBnYzNCaGQyNG9jSEp2WTJWemN5NWxlR1ZqVUdGMGFDd2dXM0JoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNkamJHRjFaR1V0WW5KcFpHZGxMbXB6SnlsZExDQjdEUW9nSUNBZ0lDQmpkMlE2SUZKUFQxUXNJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVXNEUW9nSUNBZ2ZTazdEUW9nSUgwZ1pXeHpaU0I3RFFvZ0lDQWdMeThnYldGalQxTXY2NmFzNjRpRjdJcWtPaURxc0pEc2k1enNucERycGJ3ZzY1MkU3SnEwSUc1dlpHVWc3SXVrN1phSklPMk1qT3lkdk91aG5DRHNwNEhzb0pFZzdJcWs3WSt3SUNoc1lYVnVZMmhrSU8yWg0KbU9xeXZleVhsQ0JRUVZSSTZyQ0FJT3U1aU95VnZlMlZvQ0RzaUpnZzdKNkk3SmEwSU95Z2lPdU1nT3F5dmV1aG5DRHNncXpzbXFrcERRb2dJQ0FnY0hKdll5QTlJSE53WVhkdUtIQnliMk5sYzNNdVpYaGxZMUJoZEdnc0lGdHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTNXFjeWNwWFN3Z2V3MEtJQ0FnSUNBZ1kzZGtPaUJTVDA5VUxDQmtaWFJoWTJobFpEb2dkSEoxWlN3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTEEwS0lDQWdJSDBwT3cwS0lDQjlEUW9nSUhCeWIyTXVkVzV5WldZb0tUc2dMeThnNnJDUTdJdWM3SjZRSU95ZHRPdXlwTzJLdUNEcm82anRsSVRzbDVEc2hKd2c2N2FFNjZhc0lDanFzSkRzaTV6c25wQWc3S0tGNjZPTTY2VzhJT3VuaWV5bmdDRHNsWXJxc293cERRcDlEUW9OQ2k4dklPeWR0Q0JRUSt1bHZDQW43SVNrN0xtWUlPeWdoQ2pzZzRnZ1VFTXBKeURzZzRIdGc1enJvWndnNjVDWTY0K002NmF3NjR1a0lPS0FsQ0R0bEl6cm42enF0N2pzbmJnZ1creTANCmlPcTRzTzJabEYwZzY3S0U3WXE4S0ZCUFUxUWdMM1Z1YVc1emRHRnNiQ25zbmJRZzY3YUE2Nlc0NjR1a0xnMEtMeThnY21WbmFYTjBaWEl0Y0hKdmRHOWpiMnd1YW5QcXNJQWc3SVNrN0xtWTdaV2NJT3F5Zyt5ZGhDRHF0N2pyaklEcm9ad2c2NUNZNjQrTTY2YXc2NHVrT2lEcXNKRHNpNXpzbnBBZzdKNlE2NCtaN0l1YzdKNlJJQ3NnS095ZWlPeWN2T3VwdENrZzdJU2s3TG1ZSU8yUHRPdU5sQzROQ2k4dklPS2FvTys0anlEcnNKanJrNXpzaTV3Z1NGUlVVQ0RzblpIcmk3WHNuWVFnNjZpODdLQ0FJT3V6dE91Q3VDRHJrcVFnN1ppNDdMYWM3WldnSU9xeWd5RGlnSlFnYldGalQxTWdiR0YxYm1Ob1kzUnNJR0p2YjNSdmRYVHNuYlFnN0oyMElPMlVoT3Vobk95RXVPeUtwT3VsdkNEc3BvbnNpNXdnN0tLRjY2T003SXVjN1lLc0lPeUltQ0Rzbm9qcmk2UXVEUW92THlBZ0lDRHF0N2pybnBqc2hKd2c3WXlNN0oyOEtIQnNhWE4wd3Jmc2hLVHN1WmdnN1krMDY0MlVLZXlkaENCc1lYVnVZMmhqZEd6cnM3VHJpNlFnDQo2Nmk4N0tDQUlPeW5nT3lhdE91THBDRGlnSlFnWW05dmRHOTFkT3lkdENEc21yRHJwcXpycGJ3ZzdLTzk3SmVzNjQrRUlPeWVrT3VQbWV5TG5PeWVrZXlkZ0NEc25iVHJyN2dnN0lLczY1Mjg3S2VFNjR1a0xnMEtablZ1WTNScGIyNGdkVzVwYm5OMFlXeHNVMlZzWmlncElIc05DaUFnWTI5dWMzUWdjbVZ0YjNabFpDQTlJRnRkT3cwS0lDQjBjbmtnZXcwS0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5aR0Z5ZDJsdUp5a2dldzBLSUNBZ0lDQWdZMjl1YzNRZ1RFRkNSVXdnUFNBblkyOXRMbU5zWVhWa1pXSnlhV1JuWlM1M1lYUmphR1Z5SnpzTkNpQWdJQ0FnSUdOdmJuTjBJSEJzYVhOMElEMGdjR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0oweHBZbkpoY25rbkxDQW5UR0YxYm1Ob1FXZGxiblJ6Snl3Z1RFRkNSVXdnS3lBbkxuQnNhWE4wSnlrN0RRb2dJQ0FnSUNCamIyNXpkQ0JwYm5OMElEMGdjR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0oweHBZbkpoY25rbg0KTENBblFYQndiR2xqWVhScGIyNGdVM1Z3Y0c5eWRDY3NJQ2REYkdGMVpHVkNjbWxrWjJVbktUc05DaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0hCc2FYTjBLU2tnZXlCbWN5NTFibXhwYm10VGVXNWpLSEJzYVhOMEtUc2djbVZ0YjNabFpDNXdkWE5vS0hCc2FYTjBLVHNnZlNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWdmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNpQWdJQ0FnSUhSeWVTQjdJSE53WVhkdVUzbHVZeWduYkdGMWJtTm9ZM1JzSnl3Z1d5ZGliMjkwYjNWMEp5d2dKMmQxYVM4bklDc2djSEp2WTJWemN5NW5aWFIxYVdRb0tTQXJJQ2N2SnlBcklFeEJRa1ZNWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazcNCklIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2RzWVhWdVkyaGpkR3duTENCYkozSmxiVzkyWlNjc0lFeEJRa1ZNWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dldzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1RXbGpjbTl6YjJaMFhGeFhhVzVrYjNkelhGeERkWEp5Wlc1MFZtVnljMmx2Ymx4Y1VuVnVKeXdnSnk5Mkp5d2dKME5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWEluTENBbkwyWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lISmxiVzkyWldRdWNIVnphQ2duN0o2UTY0K1o3SXVjN0o2UktFTnNZWFZrWlVKeWFXUm5aVmRoZEdOb1pYSXBKeWs3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLDQpJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0NkeVpXY25MQ0JiSjJSbGJHVjBaU2NzSUNkSVMwTlZYRnhUYjJaMGQyRnlaVnhjUTJ4aGMzTmxjMXhjWTJ4aGRXUmxZbkpwWkdkbEp5d2dKeTltSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPeUJ5WlcxdmRtVmtMbkIxYzJnb0oyTnNZWFZrWldKeWFXUm5aVG92THlEcms3SHJvWjBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdJQ0IwY25rZ2V3MEtJQ0FnSUNBZ0lDQmpiMjV6ZENCcGJuTjBJRDBnY0dGMGFDNXFiMmx1S0hCeWIyTmxjM011Wlc1MkxreFBRMEZNUVZCUVJFRlVRU0I4ZkNCd1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuUVhCd1JHRjBZU2NzSUNkTWIyTmhiQ2NwTENBblEyeGhkV1JsUW5KcFpHZGxKeWs3RFFvZ0lDQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZw0KZlNrN0lISmxiVzkyWldRdWNIVnphQ2hwYm5OMEtUc2dmUTBLSUNBZ0lDQWdmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnZlEwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpQm1ZV2xzTFhOdlpuUWc0b0NVSU91cXV5RHNwNERzbXJRZzZyS01JT3llaU95V3RPdVBoQ0R0bEl6cm42enF0N2pzbmJnZzdLcTlJT3E0c095V3RTRHNncTNzb0p6cmlwUWc3SjIwNjYrNElPdUJuZXVDck91THBDQXFMeUI5RFFvZ0lISmxkSFZ5YmlCeVpXMXZkbVZrT3cwS2ZRMEtEUW92THlEcmk2VHJwcXdvTVRFNE9EZ3A2ckNBSU91V29DRHNub2pzbkx6cnFiUWc2NEdJNjR1a0lPS0FsQ0RzdElqcXVMRHRtWlFnN0l1Y0lPdUNxT3lkZ0NEc2hManNoWmdnN0tDVjY2YXNJQ2pzbDRic25MenJxYlFnN0tHdzdKcXA3WjZJSU95THBPMk1xQ2tOQ21aMWJtTjBhVzl1SUhOb2RYUmtiM2R1UW5KcFpHZGxLQ2tnZXcwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElISWdQU0JvZEhSd0xuSmxjWFZsYzNRb2V5Qm9iM04wT2lBbk1USTMNCkxqQXVNQzR4Snl3Z2NHOXlkRG9nTVRFNE9EZ3NJSEJoZEdnNklDY3ZjMmgxZEdSdmQyNG5MQ0J0WlhSb2IyUTZJQ2RRVDFOVUp5d2dkR2x0Wlc5MWREb2dNVFV3TUNCOUxDQW9LU0E5UGlCN2ZTazdEUW9nSUNBZ2NpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnbmRHbHRaVzkxZENjc0lDZ3BJRDArSUhzZ2RISjVJSHNnY2k1a1pYTjBjbTk1S0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlNCOUtUc05DaUFnSUNCeUxtVnVaQ2dwT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNuME5DZzBLWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9LSEpsY1N3Z2NtVnpLU0E5UGlCN0RRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwTkNpQWdhV1lnS0hKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoDQpiSFJvSnlrZ2V3MEtJQ0FnSUM4dklIWTZJT3F3a095TG5PeWVrQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0RxdGF6cnNvVHNvSVFnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3F6aE95R2pTRHJqNHpxczZBZzdKNkk2NHFVN0tlQUlPdXdsdXlYa095RW5DRHRtWlhzbmJqdGxaanJpcFFnN0pxcDY0K0VEUW9nSUNBZ0x5OGdLSFl5SUQwZzdMQzlJT3lJcU9xNWdDRHNpSmpzb0pYdGpKQXNJSFl6SUQwZ0wyRmpZMjkxYm5RZzdMYVU2ckNBN1l5UUxDQjJOQ0E5SUM5MWJtbHVjM1JoYkd3ZzdMYVU2ckNBN1l5UUtRMEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0IzWVhSamFHVnlPaUIwY25WbExDQjJPaUEwSUgwcE93MEtJQ0I5RFFvZ0lDOHZJT3lkdENCUVEreVhrQ0Ryb1p6cXQ3anNuYmpya0p3ZzdZRzA2NkdjNjVPY0lPcXpoT3lnbFNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SU95eXF5RHRtWlRycWJUQ3QrMlppT3lkdENBaTY0aUU2cldzSU9xemhPeWdsZXljdk91aA0KbkNEc2s3RHJpcFRzcDRBaUlPdXp0T3lYck95anZPdUtsQ0RyamJBZzdKTzA2NHVrTGcwS0lDQXZMeURxc0pEc2k1enNucERxc0lBZzY0dTE3WldZNjRxVUlPeWR0T3ljb0RvZzY0dWs2NmFzNjZXOElPeThuT3VwdENEc200enJzSTNzbDRYc25MenJvWndnN1lHMDY2R2M2NU9jNnJDQUlPeUxwT3lnbkNEdG1ManN0cHpyajd3ZzZyV3M2NCtGSU95Q3JPeWFxZXVmaWV5ZHRDRHJncGpxc0lUcmk2UXVEUW9nSUM4dklPcXdrT3lMbk95ZWtPdUtsQ0R0akl6c25ienJwNHdnN0oyOTdKeTg2NitBNjZHY0lPeUNyT3lhcWV1ZmlTQXdJTUszSU91TWdPcTRzQ0F3SU9LQWxDRHFzb0R0aHFEcnA0d2c3Sk93NjRxVUlPeUNyT3Vlak95WGtPcXlqQ0RydVlUc21xbnNuWVFnNjZ5ODY2YXM3S2VBSU95Vml1dUtsT3VMcEM0TkNpQWdMeThnN0tPODdKMllPaURzbDZ6cXVMQWc2ck9FN0tDVjdKMjBJT3V6dE95WHJPdVBoQ0Rzbm9Yc25xWHF0b3pzbmJRZzY2ZU02Nk9NNjVDUTdKMkVJT3lJbUNEc25vanJpNlFvN0p5ZzdacW8NCjdJU3g3SjJBSU95THBPeWduQ0R0bUxqc3Rwd2c2NVdNNjZlTUlPeVZqQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHJpNlRycHF3Z0wyaGxZV3gwYU95ZG1DQndjbTlpYkdWdElPeXd1T3F6b0NrdURRb2dJR2xtSUNoeVpYRXVkWEpzSUQwOVBTQW5MMkZqWTI5MWJuUW5LU0I3RFFvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3Z1kyeGhkV1JsT2lCb1lYTkRiR0YxWkdVb0tTQjlLVHNOQ2lBZ2ZRMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZkMkZyWlNjcElIc05DaUFnSUNCcFppQW9JV2hoYzBOc1lYVmtaU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNnZlNrN0RRb2dJQ0FnZDJGclpVSnlhV1JuWlNncE93MEtJQ0FnSUhKbGRIVnliaUJxDQpjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQjNZV3RwYm1jNklIUnlkV1VnZlNrN0RRb2dJSDBOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNOb2RYUmtiM2R1SnlrZ2V3MEtJQ0FnSUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0RRb2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJREl3TUNrN0RRb2dJQ0FnY21WMGRYSnVPdzBLSUNCOURRb2dJQzh2SU95MGlPcTRzTzJabENEaWdKUWc3SjIwSUZCRDY2VzhJQ2ZzZzRnZ1VFTW5JT3lEZ2UyRG5PdWhuQ0Rya0pqcmo0enJwckRyaTZRZ0tPMlVqT3Vmck9xM3VPeWR1Q0JiN0xTSTZyaXc3Wm1VWFNEcnNvVHRpcndwTGcwS0lDQXZMeURzblpIcmk3WHNuWVFnNjZpODdLQ0FJTzJkbU91Z3BPdXp0T3VDdUNEcmtxUWc3S0NWNjZhczdaV2M2NHVrSU9LQWxDQmliMjkwYjNWMDdKMjBJT3lhc091bXJPdWx2Q0RzcG9ucw0KaTV3ZzdLTzk3SmVzNjQrRUlPMmFqT3lMb095ZGdDRHJqNFRzc0tudGxaenJpNlF1RFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5MWJtbHVjM1JoYkd3bktTQjdEUW9nSUNBZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2NHeGhkR1p2Y20wNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0RRb2dJQ0FnSUNCemFIVjBaRzkzYmtKeWFXUm5aU2dwT3cwS0lDQWdJQ0FnWTI5dWMzUWdjbVZ0YjNabFpDQTlJSFZ1YVc1emRHRnNiRk5sYkdZb0tUc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiZDJGMFkyaGxjbDBnN0xTSTZyaXc3Wm1VS0hWdWFXNXpkR0ZzYkNrZzRvQ1VJT3lnbk9xeHNEb25MQ0J5WlcxdmRtVmtMbXB2YVc0b0p5d2dKeWtnZkh3Z0p5anNsNGJzbll3cEp5azdEUW9nSUNBZ0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHANCmRDZ3dLU3dnTWpBd0tUc05DaUFnSUNCOUxDQXlOVEFwT3cwS0lDQWdJSEpsZEhWeWJqc05DaUFnZlEwS0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdOQ3dnZXlCbGNuSnZjam9nSjA1dmRDQm1iM1Z1WkNjZ2ZTazdEUXA5S1RzTkNnMEtMeThnN0oyMDY2KzRJT3VXb0NEc25vanNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeWloZXVqakNBbzdKNlE2NCtaSU95TG5PeWVrU0FySUc1d2JTQmlkV2xzWkNEc3BKSHJzN1VnN0l1azdaYUpJT3VNZ091NWhDa05Dbk5sY25abGNpNXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdldzBLSUNCcFppQW9aU0FtSmlCbExtTnZaR1VnUFQwOUlDZEZRVVJFVWtsT1ZWTkZKeWtnY0hKdlkyVnpjeTVsZUdsMEtEQXBPdzBLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3RFFwOUtUc05Dbk5sY25abGNpNXNhWE4wWlc0b1VFOVNWQ3dnSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzTkNpQWdZMjl1YzI5c1pTNXNiMmNvSjF0M1lYUmphR1Z5WFNEdGdiVHJvWnpyazV3ZzY0dWs2NmFzDQpJT3F3a095TG5PeWVrQ0Rzdkp6c3A1QWc0b0NVSUdoMGRIQTZMeTlzYjJOaGJHaHZjM1E2SnlBcklGQlBVbFFwT3cwS2ZTazdEUW92THlCSlVIWTJJT3VqcU8yVWhPdXdzU2c2T2pFcDdKZVE2NCtFSU8yVnFPcTdtQ0RyazZQcmlwVHJpNlFnNG9DVUlDZHNiMk5oYkdodmMzUW42ckNBSURvNk1ldWhuQ0RycUx6c29JQWc3WlcwN0lTZDY1Q1k2NHFVSU8yWm1PcXl2ZXlYa095RW5BMEtMeThnN1pTODZyZTQ2NmVJSUdabGRHTm82ckNBSUVsUWRqVHJvWndnN1krMDY3Q3g3WldZN0tlQUlPeVZpdXlWaENEcmk2VHJwcXdnNnJtbzdKcXc2cml3d3JmcXM0VHNvSlVnN0tHdzdacU02ckNBSU95aHNPeWFxZTJlaUNEc2k2VHRqS2p0bFpqcmpaZ2c2Nnk0N0tDY0lPdU1nT3lka1Nqcmk2VHJwcXpzbVlBZzY0K1o3SjI4S1M0TkNtTnZibk4wSUhObGNuWmxjallnUFNCb2RIUndMbU55WldGMFpWTmxjblpsY2loelpYSjJaWEl1YkdsemRHVnVaWEp6S0NkeVpYRjFaWE4wSnlsYk1GMHBPdzBLYzJWeWRtVnlOaTV2Ymlnbg0KWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3SUM4dklEbzZNZXlkaENEcnFyc2c3SjZoN0pXRTY0K0VLRVZCUkVSU1NVNVZVMFhDdDBsUWRqWWc3SmVHN0oyTUtTQkpVSFkwNjZlTTdKeTg2NkdjSU9xemhPeUdqU0RyajVuc25wRU5Dbk5sY25abGNqWXViR2x6ZEdWdUtGQlBVbFFzSUNjNk9qRW5LVHNOQ2c9PQ0KOjpXU0lMRU5UOjoNCkp5QkRiR0YxWkdVZ1FuSnBaR2RsSUhkaGRHTm9aWElnYzJsc1pXNTBJR3hoZFc1amFHVnlJQ2h1YnlCM2FXNWtiM2NwSUMwZ2NtVm5hWE4wWlhKbFpDQjBieUJ5ZFc0Z1lYUWdiRzluYVc0S1UyVjBJR1p6YnlBOUlFTnlaV0YwWlU5aWFtVmpkQ2dpVTJOeWFYQjBhVzVuTGtacGJHVlRlWE4wWlcxUFltcGxZM1FpS1FwVFpYUWdjMmdnUFNCRGNtVmhkR1ZQWW1wbFkzUW9JbGRUWTNKcGNIUXVVMmhsYkd3aUtRcGthWElnUFNCbWMyOHVSMlYwVUdGeVpXNTBSbTlzWkdWeVRtRnRaU2hYVTJOeWFYQjBMbE5qY21sd2RFWjFiR3hPWVcxbEtRcHphQzVEZFhKeVpXNTBSR2x5WldOMGIzSjVJRDBnWkdseUNuTm9MbEoxYmlBaVkyMWtJQzlqSUc1dlpHVWdjMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5SXNJREFzSUVaaGJITmxDZz09DQo6OkVORDo6DQo=";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAACFbcKA12sCANdrAgAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21sa1oyVXBDaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdUNpOHZDaTh2SU95R2pldVBoQ0RzaEtUcXM0UTZJTzJCdE91aG5PdVRuT3VsdkNEc21wVHNzcTNycDRqcmk2UWc3SU9JNjZHY0lPeUxuT3VQbWUyVm1PdXB0Q0F6TUg0ME1PeTBpT3F3Z0NEcXQ3anJnNlVnNjRLZzdKV0U2ckNFNjR1a0xnb3ZMeURpaHBJZzY0dWs2NmFzNjZXOElPeThwQ0RybFl3ZzdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZGhDRHRsWmpyZ3BnZzdKZTA3SmEwSU95RGdleUxuQ0RyaklEcXVMRHNpNXp0Z3FUcXM2QW9jM1J5WldGdExXcHpiMjRnNjR5QTdabVVJT3VxcU91VG5Da3NDaTh2SUNBZzZyQ0E3SjIwNjVPY0sreVlpT3lMbkNneE1USHFzYlFwNjRxVUlPeXlxeURycVpUc2k1enNwNERyb1p3ZzdaV2NJT3V5aU91bmpDRHNuYjN0bm96cmk2UXVJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2Nnk0NnJXczY2ZU1JT3V6dE91Q3RPdXZnT3VobkNEcnVhRHJwYlRyaTZRdUNpOHZJT3lFdU95Rm1PeWRnQ0F6TU91eWlDRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdaVzBJT3VNZ08yWmxPcXdnQ0RyckxUdGxaenRub2dnNnJpNDdKYTA3S2VBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpOHZDaTh2SU95Z2hPeWduRG9nN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPeWRoQ0Rxc29NZ0tHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKeTg2NkdjSU8yWmxleWR1Q2tLTHk4ZzdLTzg3SjJZT2lEc2dxenNtcW5ybjRuc25ZQWc2ckNCN0o2UUlPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFuT3VMcEM0S0NtTnZibk4wSUdoMGRIQWdQU0J5WlhGMWFYSmxLQ2RvZEhSd0p5azdDbU52Ym5OMElHWnpJRDBnY21WeGRXbHlaU2duWm5NbktUc0tZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3Q25SeWVTQjdJR1p6TG0xclpHbHlVM2x1WXloRlRWQlVXVjlEVjBRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbElIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwamIyNXpkQ0JEVEVGVlJFVmZSVTVXSUQwZ1QySnFaV04wTG1GemMybG5iaWg3ZlN3Z2NISnZZMlZ6Y3k1bGJuWXNJSHNLSUNCTlFWaGZWRWhKVGt0SlRrZGZWRTlMUlU1VE9pQW5NQ2NzSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNnNTNxc0lFZzY2cW82NU9jSU91QmxDQW83S2VuN0oyQUlPdXN1T3Exck95WGxDRHJ0b2p0bFlUc21wUXBDaUFnUTB4QlZVUkZYME5QUkVWZlJFbFRRVUpNUlY5T1QwNUZVMU5GVGxSSlFVeGZWRkpCUmtaSlF6b2dKekVuTENBdkx5RHRoTFFnN0pxVTdKVzlJT3VUc1NEcnRvRHFzSUFnN1ppNDdMYWNJT3VCbEFvZ0lFUkpVMEZDVEVWZlZFVk1SVTFGVkZKWk9pQW5NU2NzQ24wcE93b0tMeThnN0lpbzZybUFJT3lMcE8yV2lTanFzSkRzaTV6c25wQWc3SXFrN1krdzdKMkFJSE4wWkdsdklHbG5ibTl5WlNuc2w1RHNoSnpyajRRZzY2eTQ3S0NjNjZXOElPeTJsT3lnZ2UyVm9DRHNpSmdnN0o2STZyS01JT3k5bU95R2xDRHJvWnpxdDdqcnBid2c3WXlNN0oyODdKZVE2NCtFSU91Q3FPcTR0T3VMcEM0S0x5OGc3SnlFN0xtWU9pRHNub1RzaTV3ZzdZKzA2NDJVN0oyWUlHTnNZWFZrWlMxaWNtbGtaMlV1Ykc5bklDanNuSWpyajRUc21yQWdKVlJGVFZBbExDRHJwNlVnSkZSTlVFUkpVaWt1SURKTlFpRHJoSmpzbkx6cnFiUWdMbTlzWk91aG5DRHRsWndnN0lTNDY0eUE2NmVNSU91enRPcTBnQzRLWTI5dWMzUWdURTlIWDBaSlRFVWdQU0J3WVhSb0xtcHZhVzRvYjNNdWRHMXdaR2x5S0Nrc0lDZGpiR0YxWkdVdFluSnBaR2RsTG14dlp5Y3BPd3BqYjI1emRDQmZiM0pwWjB4dlp5QTlJR052Ym5OdmJHVXViRzluTG1KcGJtUW9ZMjl1YzI5c1pTazdDbU52Ym5OdmJHVXViRzluSUQwZ1puVnVZM1JwYjI0Z0tDa2dld29nSUdOdmJuTjBJR0Z5WjNNZ1BTQkJjbkpoZVM1d2NtOTBiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bmFXWjVLR0VwS1NrdWFtOXBiaWduSUNjcElDc2dKMXh1SnpzS0lDQWdJR1p6TG1Gd2NHVnVaRVpwYkdWVGVXNWpLRXhQUjE5R1NVeEZMQ0JzYVc1bEtUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUR0akl6c25id2c2NkdjNnJlNElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUcnBxenJpcFFnNnJPRTdJYU5JQ292SUgwS2ZUc0tDbU52Ym5OMElGQlBVbFFnUFNCT2RXMWlaWElvY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDFCUFVsUXBJSHg4SURFeE9EZzRPeUF2THlCQ1VrbEVSMFZmVUU5U1ZPdUtsQ0R0aFl6c2lxVHRpcmpzbXFrZ0tPMlBpZXlHak95WGxDQXhNVGc0T0NEcXM2RHNvSlVwQ2k4dklPdUxwT3VtckNEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVm5PdUxwQzRnN0wyVTY1T2M2Nlc4SUhCMWJHekN0K3V6dGV5Q3JPMlZ0T3VQaENBcUt1eWR0T3V2dUNEcmxxQWc3SjZJNjRxVUlPdUxwT3Vtck91S2xDRHNtSnNnN0wyVTY1T2NJT3EzdU91TWdPdWhuQ29xNjUyOENpOHZJT3E3a091THBDRHN2SnpxdUxBZzdLQ0U3SmVVSU95RGlDRHJqNW5zbnBIc25iUWc3SldJSU91Q21PeVlxT3VMcENqdGhMRHJyN2pyaEpEc25iUWc2NXlvNjRxVUlPdVRzU2t1SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RzbmJRZzZyQ1M3Snk4NjZHY0lPcTFyT3V5aE95Z2hPeWRoQ0Rxc0pEc3A0RHRsYlFnN0o2czdJdWM3SjZSN0l1YzdZS282NHVrTGdvdkx5RHJqNW5zbnBIc25iUWc2N0NVNjRDTTY0cVVJT3lJbU95Z2xleWRoQ0R0bFpqcnFiUWc3SjIwSU95SXEreWVrT3VsdkNEc21LenJwcXpxczZBZ1kyOWtaUzUwYyt5ZG1DQkNVa2xFUjBWZlRVbE9YMWJyajRRZzZyQ1o3SjIwSU95WXJPdW1zT3VMcEM0S1kyOXVjM1FnUWxKSlJFZEZYMVlnUFNBek5Uc0tMeThnNnJpdzY3TzRJT3VxcU91TnVDNGc3SnFVN0xLdEtPMlVqT3Vmck9xM3VPeWR1Q25zbmJRZ2JXOWtaV3pzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3EzdUNEc21wVHNzcTNycDR3ZzZyZTRJT3VxcU91TnVPdWhuQ0Rzc3BqcnBxenRsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPY0lDaHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FnNG9DVUlHSjFhV3hrTFdkc2IzTnpZWEo1TG1wejdKbUFJT3F3bWV5ZGdDRHRqSXpzaEp3cElPS1VnT0tVZ0FwbWRXNWpkR2x2YmlCc2IyRmtSWGhoYlhCc1pYTW9LU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FuS1N3Z0ozVjBaamduS1RzS0lDQWdJR052Ym5OMElITmxZMGxrZUNBOUlHMWtMbk5sWVhKamFDZ3ZYaU1qSU95MmxPeXluQ0RzbUlqc2k1eGNjeW9rTDIwcE93b2dJQ0FnYVdZZ0tITmxZMGxrZUNBOVBUMGdMVEVwSUhKbGRIVnliaUJiWFRzS0lDQWdJR052Ym5OMElHVjRZVzF3YkdWeklEMGdXMTA3Q2lBZ0lDQnNaWFFnWTNWeUlEMGdiblZzYkRzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnY21GM0lHOW1JRzFrTG5Oc2FXTmxLSE5sWTBsa2VDa3VjM0JzYVhRb0oxeHVKeWtwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlISmhkeTV5WlhCc1lXTmxLQzljY3lza0x5d2dKeWNwT3dvZ0lDQWdJQ0JqYjI1emRDQm9JRDBnYkdsdVpTNXRZWFJqYUNndlhpTWpJMXh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9hQ2tnZXlCamRYSWdQU0I3SUdsdWNIVjBPaUJvV3pGZExDQnpkV2RuWlhOMGFXOXVjem9nVzEwZ2ZUc2daWGhoYlhCc1pYTXVjSFZ6YUNoamRYSXBPeUJqYjI1MGFXNTFaVHNnZlFvZ0lDQWdJQ0JqYjI1emRDQmlJRDBnYkdsdVpTNXRZWFJqYUNndlhseHpLaTFjY3lzb0xpcy9LVnh6S2lRdktUc0tJQ0FnSUNBZ2FXWWdLR0lnSmlZZ1kzVnlLU0JqZFhJdWMzVm5aMlZ6ZEdsdmJuTXVjSFZ6YUNoaVd6RmRMbk53YkdsMEtDY2dMeUFuS1M1cWIybHVLQ2NnSnlrcE93b2dJQ0FnZlFvZ0lDQWdjbVYwZFhKdUlHVjRZVzF3YkdWekxtWnBiSFJsY2lnb1pTa2dQVDRnWlM1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ1BpQXdLVHNLSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpd0lPcXpvT3k1cUNBcklPeVd0T3lJbkNEcnM0RHFzcjBpN0oyMElPdVFuT3VMcEM0ZzdKZXQ3WldnSU91MmhPdW1yQ0RpZ0pRS0x5OGc3WUcwNjZHYzY1T2NJRDBnNjZ5NDdKNmxJT3VMcE91VHJPcTRzQ2pzc0wzc25aZ3BMQ0RzbXFuc2xyUWc3WWExN0oyOHdyZnJwNTdzdHFUcnNwVWdQU0JqYjJSbExuUnpJSEpsWm1sdVpVRnBVM1ZuWjJWemRHbHZibk1nN1p1RTdMS1k2NmFzS09xNHNPcXpoT3lnZ1NrdUNtTnZibk4wSUZOVVdVeEZYMUpWVEVWVElEMGdXd29nSUNjeExpRHRsYlRzbXBUc3NyUTZJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWc3WlcwN0pxVTdMSzA2NkdjTGlBbzY3TzA2NE9GNjR1STY0dWs0b2FTNjdPMDY0SzA3SnFVS1Njc0NpQWdKekl1SU91S3BldVBtZXlnZ1NEcnA1RHRsWmpxdUxBNklPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ3dnZnV5WGlDRHJ1YnpxdUxBbzY3Q1U2NENNN0plSTdKYTA3SnFVNG9hUzY3Q1U2citvN0phMDdKcVVLUzRnNjR1b0xDRHNvb1hybzR6Q3QrdW5qT3Vqak1LMzdKZXc3TEswd3JmdGxiVHNwNERDdCtxNHNPdWhuY0szNjRXNTdKMk1JT3VUc1NEc2k1enNpcVR0aFp6c25iUWc3S084N0xLMDdKMjRJT3F5c09xenZPdUtsQ0RzaUpqcmo1bnRtSlVnN0p5ZzdLZUFLT3lYc095eXRPdVB2T3lhbEN3ZzY0VzU3SjJNNjQrODdKcVVLUzRuTEFvZ0lDY3pMaURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3T2lBaWZ1MlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlpRHJqSURzaTZBZ0luN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRaUlPcTFyT3loc0NEc21yRHNoS0F1SU91THFDd2c3S0NWN0xHRjdJT0JJT3UyaU9xd2dNSzM3SjI4NjdhQUlPcTRzT3VLcFNEc29KenRsWnpDdCt1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPcXlzT3F6dk1LMzdLQ1Y2N08wSU91enRPMll1Q0RzbFlqc2k2enNuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMmVpQzRuTEFvZ0lDYzBMaURzdXBEc283enNscnp0bFp3ZzZySzk3SmEwT2lCKzdaV1k3SXVjNnJLZzdKYTA3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cExpY3NDaUFnSnpZdUlPMlJuT3E0c0RvZzY1Q1k3SmEwN0pxVTRvYVM2NCs4N0pxVUxpY3NDaUFnSnpjdUlPeWtoQ0RxdGF6c29iQTZJT3lia091enVPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPeTJsT3l5bk91UGhDRHJzSmpyazV6c2k1d2c3WldjSU95a2hPdWhuQzRnN0o2RTdKMlk2NkdjSU95a2hPeWRoQ0RyaXBqcnBxenNwNEFnN0pXSzY0cVU2NHVrTGlEcmk2Z3NJT3lYck91ZnJDRHJyTGpzbnFYc25ZUWc3WldZNjRLWTdKMllJT3E0amV5Z2xlMllsU0Ryckxqc25xWHNuTHpyb1p3ZzdaV3A3TE9RSU91TmxDRHFzSVRxc3JEdGxiVHNwNFRyaTZUcnFiUWc3S1NFSU95SW1PdWx2Q0RzcElUc25iVHJpcFFnNnJLRDdKMkFJTzJabU95WWdTNG5MQW9nSUNjNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1NEcnNvVHRpcnc2SU9xeXNPcXp2Q0R0aHJYcnM3VHJpcFFnVysyWmxleWR1RjBzSU95WWlDL3NsWVRyaTRqc21LUWc3WXlRNjR1bzdKMkFJRnZzbFlUcmk0anNtS1JkTDF2cmhLUmRMQ0RyajVuc25wRWc3SnlnNjQrRTY0cVVJRnZzdDZqc2hveGRMMXQ3NjQrWjdKNlJmVjB1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ0RzazdEcXM2QWdJdXVMcStxNHNNSzM2NCtaN0o2Ukl1eXltT3VmdkNEc3A1MGc3SldJSU91bm51dUtsQ0Rzb2JEdGxhbkN0K3VMcU91UGhTQWk3TGVvN0lhTUl1dUtsQ0RxdUlqc3A0QXVKeXdLSUNBbk9TNGc3SjIwNjZhRXdyZnNvSVR0bVpUcnNvanRtTGpDdCt1bmlPeUtwTzJDdWV5ZGdDRHF0N2pyaklEcm9ad2c2N08wN0tHMExpRHNncXpybm96c25ZUWc2N2FBNjZXOElPdVZrQ0RyaTVqc25ZUWc2N2FaN0plczY0K0VJT3lpaSt1THBDNG5MQW9nSUNjeE1DNGc3S0NjN1pLSUlPeWFxZXlXdENEc25LRHNwNEE2SU95ZWhldWdwZXlYa0NEc2s3RHNuYmdnNnJpdzY0cWw3SVN4SU91cWhleUNyQ2pyczREcXNyMHNJT3luZ095Z2xTd2c2NU94NjZHZExDRHRsYlRzb0p3ZzY1T3hLZXVLbENEdG1aVHJxYlRzblpnZzZyaXc2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqc2lKanJqNW50bUpYQ3QrcXl2ZXlXdE1LMzY3YUE3S0NWN1ppVklPMlhpT3lhcVNEc3ZJRHNuYlRzaXFRcDdKMllJT3VKbU95Vm1leUtwT3F3Z0NEc25LRHNpNlRya0p6cmk2UXVDaTh2SU8yTWpPeWR2T3lkdENEc2w0YnNuTHpycWJRbzdJU2s3TG1ZNjdPNElPcTFyT3V5aE95Z2hDRHJrN0VwSU91NWlDRHJyTGpzbnBEc2w3UWc0b0NVSU95YWxPeVZ2ZXVuak95Y3ZPdWhuQ0RyajVuc25wRW9abUZwYkMxemIyWjBLUzRLWm5WdVkzUnBiMjRnYkc5aFpFZDFhV1JsS0NrZ2V3b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuZFhndGQzSnBkR2x1Wnk1dFpDY3BMQ0FuZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUhKbGRIVnliaUJ0WkM1c1pXNW5kR2dnUGlBeE1EQWdQeUJ0WkNBNklDY25Pd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3Vobk91VG5DRHNpNlR0aktnZ0tPeWFsT3lWdmV1bmpPeWN2T3VobkNEc3A0VHRsb2twT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNCeVpYUjFjbTRnSnljN0NpQWdmUXA5Q21OdmJuTjBJRWRWU1VSRklEMGdiRzloWkVkMWFXUmxLQ2s3Q2dwbWRXNWpkR2x2YmlCcGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTQjdDaUFnWTI5dWMzUWdabVYzVTJodmRDQTlJRVZZUVUxUVRFVlRMbTFoY0Nnb1pYZ3BJRDArSUNkSmJuQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExtbHVjSFYwS1NBcklDZGNiazkxZEhCMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG5OMVoyZGxjM1JwYjI1ektTa3VhbTlwYmlnblhHNG5LVHNLSUNCeVpYUjFjbTRnS0FvZ0lDQWdKK3luZ09xNGlPdTJnTzJFc0NEcmhJanJpcFFnN0plUTdJcWs3SnVRS0ZNdE1Td2c2N08wN0pXSTdacU03SUtzS2V5ZG1DRHRsWnpxdGEzc2xyUWdWVmdnVjNKcGRHbHVaeURzb0lUcnJManFzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91THBDNGdKeUFyQ2lBZ0lDQW43S0d3NnJHMElPMlJuTzJZaENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzB3cmZzdElqcXM3ekN0K3V2dU91bmpNSzM2N2FBN1lTd3dyZnF1WXpzcDRBZzY1T3hLZXlkZ0NEc29KWHNzWVVnN0tDVjY3TzA2NHVrSU9LQWxDRHJ1Ynpxc2JEcmdwZ2c2NHVrNjZXNElPeWhzT3F4dE95Y3ZPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhLQ0kxN1pxTUlPeWR0T3lEZ1NMc25ZUWdJalh0bW93aTY2R2NJT3lraE95ZHRPdXB0Q0RzbUtUcmk3VXBMaUFuSUNzS0lDQWdJQ2ZzbTVEcnJManNsNUFnN0plRzY0cVVJT3Exck95eXRDRHNvSlhyczdRbzdLQ0U3Wm1VNjdLSTdaaTR3cmRWVWt6Q3QrcTRpT3lWb2NLMzdJdWM2ckNFSU91VHNTbnNtWUFnN1pXMDZyS3dJT3V3cWV1eWxjSzM3S0NJN0xDb0tPeWVyT3lFcE95Z2xjSzM2Nnk0N0oyWTdMS1l3cmZzbnF6c2k1enJqNFFnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjdhWjdKMjA2NHFVSU9xeWcreWRnQ0Rzb0lqcmpJQWc2cmlJN0tlQUlPS0FsQ0RzbFlUcmlwUWc2ckNTN0oyMDY1Mjg2NCtFTENEcXQ3anJuN1RyazYvdGxiVHJqNFFnN0pPdzdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdKelBxc0p3ZzdLQ2M3SldJN0oyQUlPeUVuT3VobkNEc29KSHF0N3pzbmJRZzY0dXM2NTI4N0pXOElPMlZuT3VMcENEaWdKUWc3WldZNjRLWTY0cVVJT3lia091c3VDRHF0YXpzb2JEcnBid2c3SnlnN0tlQTdaV2NJT3kxbk95R2pDRHJpNlRyazZ6cXVMQXNJTzJWbU91Q21PdUtsQ0Ryckxqc25xVWc2cldzN0tHdzY2VzhJT3llck9xMXJPeUVzZTJWbkNEcmpJRHNsWWdzSUNjZ0t3b2dJQ0FnSitxM3VPdW1yT3F6b0NEc29JSHNsclRyajRRZzdaV1k2NEtZNjRxVUlPcXp2T3F3a08yVm5DRHNucXpxdGF6c2hMRTZJT3lra2V1enRTRHRrWnp0bUlUc25ZUWc2NDJjN0phMDY0SzA2ck9nTENEc29KWHJzN1FnN0lpYzdJU2M2Nlc4SU95Q3JPeWFxZXlla09xd2dDRHNsWXpzbFlUc2xid2c3WldnSU9xeWcrdTJnTzJFc091aG5DRHNucXpzb2JEc3A0SHRsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZ0lDQWdKK3lWaE91ZW1DRHNtSWpzaTV6cms2VHNuWUFnN1pXY0lPeWtoT3lubk91bXJDRHN0WnpzaG93ZzZyV1E3S0NWN0oyMElPdW5qdXluZ091bmpDRHF0N2pxc2JRZzdZYWtLTzJWdE95YWxPeXl0TUszNnJLOTdKYTBLZXlkbUNEcXRaRHJzN2pzbmJUc3A0QWc3SWFNNnJlNTdJU3g3SjJZSU9xMWtPdXp1T3lkdENEc2xZVHJpNGpyaTZRZzRvQ1VJT3lYck91ZnJDRHJyTGpzbnFYc3A1enJwcXdnN0o2RjY2Q2w3SjJBSU91cGxPeUxuT3luZ0NEcmk2anNuSVRyb1p3ZzY0dWs3SXVjSU95RXBPcXpoTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcnNMRHNsN1RycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaGNLMzdMMlU2NU9jN1k2YzdJcWtJT3E0aU95bmdEcGNiaWNnS3dvZ0lDQWdKMXQ3SW5SbGVIUWlPaUFpN0tDYzdKV0lJT3VzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV1c3RPeVhoK3lkaENEc21ad2c2N0NVNnIrbzY0cVU3S2VBSU8yVm5PcTFyZXlXdENEdGxad2c2Nnk0N0o2bEluMHNJQzR1TGwxY2JseHVKeUFyQ2lBZ0lDQW5XK3lLcE8yRGdPeWR2Q0RxdDV6c3VabGRYRzRuSUNzZ1UxUlpURVZmVWxWTVJWTWdLeUFuWEc1Y2JpY2dLd29nSUNBZ0tFZFZTVVJGSUQ4Z0oxdnNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3lnaE91c3VDQW9kWGd0ZDNKcGRHbHVaeTV0WkNrZzRvQ1VJT3ljaENEcXQ1enN1Wm5zblpnZzZyZTg2ckd3N0ptQUlPeVlpT3ladUNEc2k1enJncGpycHF6c21LUXVJTzJLdWUyZWlDRHNtSWpzbWJnZzZyZWM3TG1aS095SW1PdVBtZTJZbGNLMzZySzk3SmEwd3JmcnRvRHNvSlh0bUpYc25ZUWc3SnlnN0tlQTdaVzA3Slc4SU8yVm1PdUtsQ0RzZzRIdG1ha3A3SjJFSU9xM3VPdU1nT3VobkNEcmxMRHJwYlRxczZBc0lPeWFsT3lWdmVxenZDRHNvSVRyckxqc25iUWc2NHVrNjZXMDY2bTBJT3lnaE91c3VPeWRoQ0RybExEcnBianJpNlJkWEc0bklDc2dSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cGJtVkNkV1lnUFNBbkp6c2dJQ0FnSUNBZ0lDQXZMeUJ6ZEdSdmRYUWc3S1NFSU91eWhPMk52QXBzWlhRZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQzh2SU8yWWhPeWVyQ0R0aExUc25aZ2dleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIMEtiR1YwSUhGMVpYVmxJRDBnVUhKdmJXbHpaUzV5WlhOdmJIWmxLQ2s3SUM4dklPeWFsT3l5clNEc3A0SHJvS3p0bVpRZ0tPdVBtZXlMbkNEc21wVHNzcTNzbllBZzdJaWM3SVNjNjR5QTY2R2NLUXBzWlhRZ2RIVnlibk1nUFNBd093cHNaWFFnZDJGeWJXVmtWWEFnUFNCbVlXeHpaVHNLYkdWMElHTjFjbkpsYm5STmIyUmxiQ0E5SUVOTVFWVkVSVjlOVDBSRlREc2dMeThnN0tlQTZyaUlJT3lFdU95Rm1PeWR0Q0Ryckx6cXM2QWc3SjZJNjRxVUlPdXFxT3VOdUNBbzdKcVU3TEt0N0oyMElPdUxwT3VsdUNEcnFxanJqYmpzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3lFdU95Rm1DRHNucXpzaTV6c25wRXBDaTh2SU95TG5PeWVrU0RzaTV3Z1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbElFTk1TU25xc0lBZzdKTzRJT3lJbUNEc25vanJpcFRzcDRBZzdLQ1E2cktBSU9LQWxDRHNsNGJzbkx6cnFiUWdMMmhsWVd4MGFPdWhuQ0RzbFl6cm9LUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeVZpT3VDdE8yVm5PdUxwQzRLTHk4Z2JuVnNiRDN0bVpYc25iZ2c3S1NSTENBbmIyc25QZXlDck95YXFTRHFzSURyaXFVc0lDZGpiR0YxWkdVdGJXbHpjMmx1WnljOVkyeGhkV1JsSU91cWhldWd1U0RzbDRic25Zd3NDaTh2SUNkamJHRjFaR1V0Ykc5bmIzVjBKejFqYkdGMVpHWHJpcFFnN0o2STdLZUE2NmVNSU91aG5PcTN1T3lkdUNEc2hManNoWmdnNjZlTTY2T01JQ2p0aExRZzdJdWs3WXlvSU95TG5DRHFzSkRzcDRBc0lPeUVzZXF6dFNEdGhMVHNuYlFnN0ppazY2bTBJT3lla091UG1TRHRsYlRzb0p3cENpOHZJQ2RqYkdGMVpHVXRiR2x0YVhRblBldWhuT3EzdU95ZHVPeWRnQ0Rya0pEc3A0RHJwNHdnN0lLczdKcXBJTzJWbk91UGhDRHN0SWpxczd3Z0tPeWhzT3k1bU9xd2dDRHNucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWjdKMkFJT3F5dmV1aG5PdWhuQ0RzbnFIdG5vanJyNERyb1p3ZzdLU1I2NmE5SU8yUm5PMlloT3lkaENEc2s3VHJpNlFLWTI5dWMzUWdURTlIU1U1ZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVPeWR0Q0R0bFlUc21wVHRsYlRzbXBRbzdKV0lJT3VRa09xeHNPdUNtQ0RycDR6cm80d3BJT0tBbENCYjhKK2ZvQ0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjBnNjdLRTdZcTg3SjJFSU91SWhPdWx0T3VwdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHRPeVd0T3VUbk91Z3BPeWFsQzRuT3dvdkx5RHNpNlRzdUtIdGxad2c2Nnk0NnJXczY1T2tPaUFpUm1GcGJHVmtJSFJ2SUdGMWRHaGxiblJwWTJGMFpUb2dUMEYxZEdnZ2MyVnpjMmx2YmlCbGVIQnBjbVZrSUdGdVpDQmpiM1ZzWkNCdWIzUWdZbVVnY21WbWNtVnphR1ZrSWlqcnA0enJvNHdwTEFvdkx5QWlUbTkwSUd4dloyZGxaQ0JwYmlEQ3R5QlFiR1ZoYzJVZ2NuVnVJQzlzYjJkcGJpSW82Nis0NjZHYzZyZTQ3SjI0S1NEaWdKUWc2NUdZSU91THBDRHNucUh0bm9qcXNvd2c2NFNUN1o2TTY0dWtDbVoxYm1OMGFXOXVJR2x6UVhWMGFFVnljbTl5S0hNcElIc0tJQ0J5WlhSMWNtNGdMMkYxZEdobGJuUnBZMkYwZkc5aGRYUm9mR0Z3YVNCclpYbDhiRzluSUQ5cGJueHNiMmRuWldSOGMyVnpjMmx2YmlCbGVIQnBjbVZrTDJrdWRHVnpkQ2hUZEhKcGJtY29jeWtwT3dwOUNpOHZJT3lDck95YXFTRHRsWnpyajRRZzdMU0k2ck84SU9xd2tPeW5nQ0RpZ0pRZzY2R2M2cmU0N0oyNDdKMkFJT3VwZ095cG9lMlZuT3VOc0NBaTY0MlVJT3VxdXlEc2s3VHJpNlFpNjRxVUlPcXl2ZXlhc0M0ZzY2R2M2cmU0N0oyNElPdW5qT3Vqak95WmdDRHNvYkRzdVpqcXNJQWc2NHVzNjUyODdJU2NJT3VVc091aG5DRHNucUhyaXBUcmk2UXVDaTh2SU95THBPeTRvU2d5TURJMkxUQTRMQ0R0bW96c2dxd2c3SmVVN1lTdzdaU0U2NTI4N0oyMDdLYUlJT3lpak95RW5TazZJQ0paYjNVbmRtVWdhR2wwSUhsdmRYSWdhVzVrYVhacFpIVmhiQ0J6Y0dWdVpDQnNhVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6c25wRHNsNURxc293ZzdaV2M2NCtFNjZXOElPeVlyT3VncENEcmk2enJuYnpxczZBZzdKcVU3TEt0N1pXWTZyT2dMQ0RzbFlUcmk0anJxYlFnVy9DZm42QWc3WUcwNjZHYzY1T2NJTzJWbk91UGhDRHN0SWpxczd4ZElPdXloTzJLdk95ZGhDRHJpSXpybjZ3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsYlFnN0tPODdJUzQ3SnFVTGljN0NpOHZJQ2Z0bFp6cmo0UW42NkdjSU91dGlldWFzZXEzdU91bXJPdXB0Q0RzbFlnZzY1Q2M2NHVrSU9LQWxDRHNucURxdVpBZzY2cXc2NmEwSU91VmpDRHJncGpyaXBRZ2NtRjBaU0JzYVcxcGRPeWR0T3VDbUNEcnJManJwNlVnNnJpNDdKMjBJT3kwaU9xenZPcTVqT3luZ0NEc25xSHNsWVFLTHk4ZzdKZUo2NXF4N1pXWTZyS01JQ0xyaTZUcnBiZ2c2ck9FN0tDVjdKeTg2NkdjSU91aG5PcTN1T3lkdU8yVm1PdWR2Q0xxczZBZzdKV0k2NEswN1pXWTZyS01JT3VRbk91THBDNGc3S2VBN0xhY3dyZnNncXpzbXFucm40a2c3SU9CN1pXY0lPdXN1T3Exck91bmpDRHNvb0h0bUlEc2hKd2c2N080NjR1a0NtWjFibU4wYVc5dUlHbHpUR2x0YVhSRmNuSnZjaWh6S1NCN0NpQWdjbVYwZFhKdUlDOXpjR1Z1WkNCc2FXMXBkSHgxYzJGblpTMWpjbVZrYVhSemZIVnpZV2RsSUd4cGJXbDBJQ2h5WldGamFHVmtmR1Y0WTJWbFpHVmtLUzlwTG5SbGMzUW9VM1J5YVc1bktITXBLVHNLZlFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56NjZXOElPeWR2ZXlXdEFvdkx5QXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZuT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbENEc3BKSHNuYmpzcDRBaUlPMlJuT3lMbkNEaWdKUWc2ck8xN0pxcElGQkQ3SmVRN0lTY0lPdUNxT3lkbUNEcXM0VHNvSlVnN0ppazdJS3M3SnFwSU91d3FleW5nQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMElPeWR0Q0Rxc0pMcXM3d2c3WXlNN0oyODdKMllJT3F6aE95Z2xleWR0Q0RzbHJUcXVJdnJncHpyaTZRS2JHVjBJSE5sYzNOcGIyNUJZMk52ZFc1MElEMGdiblZzYkRzS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzS0lDQnBaaUFvUkdGMFpTNXViM2NvS1NBdElHRmpZMjkxYm5SRFlXTm9aUzVoZENBOElETXdNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3dvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTNXFjMjl1Snlrc0lDZDFkR1k0SnlrcE93b2dJQ0FnWlcxaGFXd2dQU0FvYWlBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZENBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZEM1bGJXRnBiRUZrWkhKbGMzTXBJSHg4SUc1MWJHdzdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nNjZHYzZyZTQ3SjI0SU95ZHRPdWdwU0RzbDRic25Zd2c2NU94SU9LQWxDQnVkV3hzSU95Y29PeW5nQ0FxTHlCOUNpQWdZV05qYjNWdWRFTmhZMmhsSUQwZ2V5QmhkRG9nUkdGMFpTNXViM2NvS1N3Z1pXMWhhV3dnZlRzS0lDQnlaWFIxY200Z1pXMWhhV3c3Q24wS1puVnVZM1JwYjI0Z1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LU0I3Q2lBZ1kyOXVjM1FnY0hKdlltVWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0TFhabGNuTnBiMjRuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdJSDBwT3dvZ0lHeGxkQ0J2ZFhRZ1BTQW5KenNLSUNCd2NtOWlaUzV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJ2ZFhRZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc0tJQ0J3Y205aVpTNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljN0lIMHBPd29nSUhCeWIySmxMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVFpXTTZJQ2NuSUgwN0Nnb3ZMeURpbElEaWxJQWc3WlNNNjUrczZyZTQ3SjI0SU95RG5leWh0Q0Rxc0pEc3A0QW83SXVzN0o2bDY3Q1Y2NCtaS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdaU002NStzNnJlNDdKMjQ3SjIwSU91V29DRHNub2pyaXBRZzY0K1o3SldJSUdOdlpHVXVkSFBxc0lBZ05leTBpT3VuaU91THBDQlFUMU5VSUM5b1pXRnlkR0psWVhUcnBid2c2N08wNjRLNDY0dWtMZ292THlEdGxad2c2N0tJN0oyMDY1Mjg2NCtFSU91d20reWRnQ0Rya3FRZ016RHN0SWpxc0lRZzY0R0s2cml3NjZtMElPMlVqT3Vmck9xM3VPeWR1Q2pybUpEcmlwUWc3WlM4NnJlNDY2ZUlLZXlkdENEcmk2dnRub3dnNnJLRElPS0FsQ0R0Z2JUcm9aenJrNXpxdVl6c3A0QWc2NDJ3NjZhczZyT2dJT3F3bWV5ZHRDRHF1cnpzcDRUcmk2UXVDaTh2SU95VmhPeW5nU0R0bFp3ZzY3S0k2NCtFSU91cXV5RHJzSnZzbFpqc25MenJxYlFvNjR1azY2YXM2NmVNSU91b3ZPeWdnQ0RzdktBZzdJT0I3WU9jTENEc25wRHJqNW5zaTV6c25wRWc2NU94S1NEcXM0VHNobzBnNjR5QTZyaXc3WldjNjR1a0xncGpiMjV6ZENCSVJVRlNWRUpGUVZSZlJFVkJSRjlOVXlBOUlETXdNREF3T3dwc1pYUWdiR0Z6ZEVKbFlYUWdQU0F3T3dwelpYUkpiblJsY25aaGJDZ29LU0E5UGlCN0NpQWdhV1lnS0d4aGMzUkNaV0YwSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFtVmhkQ0ErSUVoRlFWSlVRa1ZCVkY5RVJVRkVYMDFUS1NCN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFnNG9DVUlPMlV2T3EzdU91bmlDL3RsSXpybjZ6cXQ3anNuYmpzbmJRZzY0dXI3WjZNSU9xeWcreWN2T3VobkNEcnM3VHFzNkFnNnJDWjdKMjBJT3E2dk95bmtldUxpT3VMcEM0bktUc0tJQ0FnSUhCeWIyTmxjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQc25MenJvWndnWTJ4aGRXUmxJTzJLdU91bXJPdWx2Q0Rzb0pYcnBxenRsWnpyaTZRS0lDQjlDbjBzSURVd01EQXBPd29LTHk4ZzRwcWc3N2lQSU91aG5PcTN1T3lkdUNEcXNyM3JvWnpzbDVEc2hKd2dLaXBDVWs5WFUwVlM2Nlc4SU9xeHRPdVRuT3Vtck91cHRDRHNsWWdnNjVDYzY0dWtLaW9nS0RJd01qWXRNRGdnN0l1azdMaWhJREx0bW96cm9ad2c3Wm1WN0tDVktUb0tMeThnSUNCQ1VrOVhVMFZTNjZXOElPeUVwT3lnbGUyVm1PdXB0Q2pyZ3JUc21xbnNuYlFnNjZ5MDdKZUg3SjIwNjVPZ0xDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPMlZtT3VLbENCdWJ5MXZjT3lkdE95V3RPdVBoQ2tnWTJ4aGRXUmxJRU5NU2Vxd2dDRHJ1SXpybmJ6c21yRHNvSUFnN1pXNDY1T2M3SmlrN1pTRTY2VzhDaTh2SUNBZzdZK3M2cml3N1pXWTZyT2dJQ29xSXV5ZHVPeW1uU0RzdlpUcms1enJwYndnUTJ4aGRXUmxJRU52WkdYc2w1QWc2N2FaN0plczY0U2o3Snk4N0lTNDdKcVVJaURyc0tuc2k1M3NuTHpyb1p3ZzY3Q1U2NENRNjR1a0tpb3VJT3VMcE91bXJPdUtsQ0Ryb1p6cXQ3anNuYmdnN1pTRTY2R2M3SVM0N0lxazY2VzhDaTh2SUNBZzdJaW82cktvN0lTY0lITjBaR2x1SU95WGh1eWR0Q0RybllUc21yRHJyNERyb1p3ZzY3YVo3SmVzNjRTajdKMkVJT3F6cyt5ZHRDRHNsNGJzbHJRZzY2R2M2cmU0N0oyNDdKMjBJT3lWaE95WWlDRHJ0b2pxc0lEcmlxWHRsYlRzcDRUcmk2UXVDaTh2SUNBZ0tHeHZZMkZzYUc5emRDQk1TVk5VUlU3c25iUWc2NWFnSU95ZWlPdUtsQ0Rxc29QcnA0d2c2N08wNnJPZ0lPeWVrT3VQbVNEc2lKanJvTG5zbmJRZzdKeWc3S2VBNjVDYzY0dWs2ck9nSU8yTWtPdUxxTzJXaU91Tm1DRHFzb3dnN0ppazdLZUU3SjIwN0plSTY0dWtMaWtLTHk4Z0lDRGlocElnNnJlNDY1Nlk3SVNjSUNMdGc2MGdNZXF3bkNBcklPcXpoT3lnbFNEc2hLRHRnNTBnN1ptVTY2bTBJdXlkZ0NEc25iUWdRMHhKNjZHY0lPdTJpT3F3Z091S3BlMlZtT3VMcERvZzdaV2NJTzJEcmV5Y3ZPdWhuQ0Rzbm9mc25wRHJxYlFnUTB4SjdKMllJT3lYdE9xNHNPdWx2Q0RycDRuc2xZVHNsYndLTHk4Z0lDRHRsWmpxczZBc0lPdW5pZXljdk91cHRDRHN2WlRyazV3ZzY3YVo3SmVzNjRTajZyaXc2ckNBSU91UW5PdUxwQzRnNjZHYzZyZTQ3SldFN0p1RDdKMkVJT3VVc091aG5DRHNsN1RycWJRZzdZT3Q3SjIwSURMcXNKenFzSUFnNjVDYzY0dWtMZ292THlBZ0lPcXlzT3Vob0Nqc2dxenNtcW5zbnBBZzZyS3c3S0NWS1RvZ0tpcnRnNjBnTWVxd25DQXJJT3lLdWV5ZHVDRHRtWlRycWJRcUt1eWRoQ0RzazdEcXM2QXNJT3F6aE95Z2xTRHNvSVR0bVpqc25ZQWc2cmU0SU8yWmxPdXB0T3lkbUNCYjZyT0U3S0NWSU95Z2hPMlptRjBnNjdLRTdZcTg3Snk4NjZHY0lPMlZuT3VMcEM0S0x5OGdJQ0RzZ3Ezc29KenJrSndnN0l1YzY0K0U2NU9rT2lCM2NtbDBaVTV2YjNCQ2NtOTNjMlZ5SUM4Z2IzQmxibFZ5YkVsdVJHVm1ZWFZzZEVKeWIzZHpaWElnTHlCaWRXbHNaRXh2WjI5MWRFTm9ZV2x1VlhKc0lDanJzN1hxdGF6cmlwUWdaMmwwSU8yZWlPeUtwTzJHb091bXJDa3VDaTh2SU9LVWdPS1VnQ0Ryb1p6cXQ3anNuYmpzbllBZ1EweEo2ckNBSU9xNHNPdXp1Q0RydUl6cm5ienNtckRzb0lEcnBid2c3S2VCN0tDUklPeVh0T3F5akNEdGxaenJpNlFnS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRNd0tTRGlsSURpbElBS0x5OGc3SnF3NjZhczZyQ0FJRUpTVDFkVFJWTHJwYndnNnJDQTY2R2M3TEdFNnJHdzY0S1lJT3l3dmV5ZGhDRHFzNmpybmJ3ZzdKZXM2NHFVSU95TG5PdVBoT3VLbENBcUt1eWdoT3UyZ0NEc2k2VHRqS2p0bGJUc2hKd2c2NUNZNjQrTTY2QzQ2NHVrS2lvdUlPdUNxT3E0dENEcXRaRHRtNGc2Q2k4dklDQWc0cEdnSUVKU1QxZFRSVklnN1pXNDY1T2s2NStzNjZHY0lGVlNUT3lkaENEcnNKdnNuTHpycWJRZ1kyMWs2ckNBSUdBbVlPeVhrT3lFbkNEc25wanJuYnpycUxucmlwVHJpNlFnNG9hU0lHTnNhV1Z1ZEY5cFpDRHNob3pzaTZRb0l1eWVtT3VxdSt1UW5DQlBRWFYwYUNEc21wVHNzcTBpS1M0S0x5OGdJQ0Rpa2FFZ1FsSlBWMU5GVXV1bHZDQnVieTF2Y095Y3ZPdWhuQ0RycDRucXM2QWdjM1JrYjNWMDdKMllJRlZTVE95ZGhDRHNtckRycHF6cXNJQWc3SmUwNjZtMElDb3E3SXE1N0oyNElPdVNwQ0RzbmJqc3BwM3N2WlRyazV6cnBid2c2N2FaN0plczY0U2o3Snk4NjUyODY0cVVJTzJabE91cHRDb3E3SjIwQ2k4dklDQWdJQ0FnNjV5czY0dWtLT3lMcE95NG9TRHNpNkRxczZBNklDTHNuYlRybjdBZzZyR3dJT3lYaHV5WGlPdUtsT3VOc0NEcXNKSHNucERxdUxBZzdKbWNJT3lEbmVxeXFDSXBJT0tBbENEc25wRHJqNWtnN0lpWTY2QzU3SjIwSU9xNXFPeW5oT3VMcEM0S0x5OGdJQ0Rpa2FJZzdJdWM3WUdzNjZhL0lPeXd2ZXljdk91aG5DRHNsN1Ryb0tUcnFiUWc2N2lNNjUyODdKcXc3S0NBNjZXOElPeWFzT3Vtck9xd2dDRHFzNmpybmJ6c2xid2c3WlcwN0lTY0lDb3E2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3F3Z0NEc2xZVHJpNHdnN1lHczY2R3N3cmZzbDZQc3A0RHFzSUFnN0plMDY2YXc2NHVrS2lvS0x5OGdJQ0FnSUNBbzdJdWs3TGloSU95TG9PcXpvRG9nSXV5Wm5DRHRnYXpyb2F6c25MenJvWndnN0plMDY2Q2tJaXdnSXVxNHNPdXp1Q0RydUl6cm5ienNtckRzb0lEcm9ad2c3WldZNjUyODY0dUk2cm1NSWlrdUlPcXlqT3VMcE9xd2dDRHF1TERyczdnZzY3aU02NTI4N0pxdzdLQ0E2ckNBSU95TG5PMkJyT3Vtdndvdkx5QWdJQ0FnSU95ZHVPeWVrT3VsdkNEcnJMVHNpNXp0bFpqcnFiUW83SUs4N0lTeElPeWR1TzJFc091RXR5RHNpNlRzdUtFcElPeWR2T3V3bUNEc3NMM3NuYlFnNjVhZ0lPeUt1ZXlkdUNEdG1aVHJxYlRzbmJRZzZyZTQ2NHlBNjZHYzY0dWtMZ292THlEcXQ3anJucGpzaEp3Z0tpcENVazlYVTBWUzY2VzhJT3F4dE91VG5PdW1yT3luZ0NEc2xZcnJpcFRyaTZRcUtpRGlnSlFnWTJ4aGRXUmxJRU5NU2Vxd2dDRHF1TERyczdnZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95WHRPcXpvQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPeWVrT3VQbVFvdkx5RHNpSmpyb0xudGxaenJpNlFvN0wyVTY1T2NJT3UybWV5WHJPdUVvK3E0c0NEc2w0YnNuWXdwTGlEcXM0VHNvSlVnN0tDRTdabVk3SjJBSU95S3VleWR1Q0R0bVpUcnFiUWc3WldZNjR1b0lGdnFzNFRzb0pVZzdLQ0U3Wm1ZWFNEcnNvVHRpcnpzbkx6cm9ad2c3WldjNjR1a0xnb3ZMeUFxS3V5ZHRDRHFzcjNyb1p6c2w1QWdWVkpNSU9xd2dPcXp0Y0szN0tTUjZyQ0VJT3lLcE8yQnJPdW12ZTJLdU1LMzY3aU02NTI4N0pxdzdLQ0FJT3luZ095Z2xleWRoQ0RyaTZUc2k1d2c2NFNqN0tlQUlPdW5rQ0Rxc29NdUtpb0tDaTh2SU9LVWdPS1VnQ0JDVWs5WFUwVlNJT3F3Z091aG5PeXhoT3E0c091S2xDRHNvSnpxc2JEcmtKRHJpNlFnS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRJMUtTRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SmlJN0tDRTdKZVVJRUpTVDFkVFJWSWc3Wm1ZNnJLOTY3T0E3SWlZN0plUUlPeWVoT3lMbkNEc2lxVHRnYXpycHIzdGlyanJwYndnNnIyQzdKV0VJRU5NU2Vxd2dDRHNwSUFnWVhWMGFHOXlhWHBsSUZWU1RPeWRoQ0RzbXJEcnBxenFzSUFnNjdDYjdKV0U3SVNjSU95WHRPeVhpT3VMcEM0S0x5OGc2NnFwN0tDQjdKMkFJTzJWbU91Q21PdS9rT3lkdE95WGlPdUxwQ0RpZ0pRZzZyT0U3S0NWSU95Z2hPMlptT3lhcWV5Y3ZPdWhuQ0JWVWt6c25ZUWdZMnhoZFdSbExtRnBMMnh2WjI5MWREOXlaWFIxY201VWJ6M2lnS2Jyb1p3ZzdKNnM3SjZSN0lTeDdaVzBDaTh2SU95S3VleWR1Q0R0bVpUcnFiVHNuWVFnNnJHMDY0U0k2NXV3NnJPZ0lPcXpoT3lnbFNEc2hLRHRnNTBnN1ptVTY2bTA3SmVRSU95bmdlMldpZXlMbk8yQ3BPcTRzQzRnNnJlNElPeWVyT3lla2V5RXNleWRoQ0R0ajVEcXVMRHRsWmpzbnBBbzdJS3M3SnFwN0o2UUlPcXlzT3lnbFNrZzdaVzQ2NU9rNjUrczY0cVVDaTh2SU91cXFleWdnZXlkdENEc2w0YnNsclRzb1l6cXM2QXNJQ29xNjRLbzZyS29JT3VSa091cHRDRHNtS1R0bm9qcm9LUWc2NkdjNnJlNDdKMjQ3SjJFSU91bm5lcXdnT3VjcU91bXNPdUxwQ29xT2dvdkx5QWdJRU5NU2Vxd2dDQlZVa3pzbllRZzY1U3c3SmkwN1pHY0lPeVhodXlkdENEcmhKanF1TERycWJRZ1kyMWs2ckNBSUdBbVlPeVhrT3lFbkNCVlVrenNuWVFnN0o2WTY1MjhJT3V5aE91Z3BDanNuSWpyajRUc21yQXBJR05zYVdWdWRGOXBaQ0Rxc0puc25ZQWc2NUtrN0txOUNpOHZJQ0FnNjZlazZyQ2M2N09BN0lpWTZyQ0FJT3lDck91ZHZPeW5nT3F6b0N3ZzY3aU02NTI4N0pxdzdLQ0E3SmVVSUNMc25wanJxcnZya0p3Z1QwRjFkR2dnN0pxVTdMS3RJTUszSUdOc2FXVnVkRjlwWkNEcnA2VHFzSnpyczREc2lKanFzSUFnNjRpRTY1Mjk2NUNZN0plSTdJcTE2NHVJNjR1a0l1cXdnQ0Rybkt6cmk2UXVDaTh2SUNBZzdJdXM3WldZNjZtMElPdTRqT3Vkdk95YXNPeWdnT3F3Z0NEc2xZVHNtSWdnN0pXSUlPeVh0T3Vtc091THBDanNpNlRzdUtFZ01qQXlOaTB3T0RvZ1EweEpJTzJVaE91aG5PeUV1T3lLcE91S2xDRHJqSURxdUxBZzdLU1I3SjI0NjQyd0lPeXd2ZXlkdENEc2xZZ2c2NXk0S1M0S0x5OGc3SjIwN0tDY0lFSlNUMWRUUlZMcnBid2c2ckcwNjVPYzY2YXM3S2VBSU95Vml1dUtsT3VMcENEaWhwSWdZMnhoZFdSbElFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN0RyaTZRb1EweEpJT3E0c091enVDRHJqNW5zbnBFcExnb3ZMeUFxS3V5ZHRDRHFzcjNyb1p6c2w1QWdWVkpNSU9xd2dPcXp0Y0szN0tTUjZyQ0VJT3lLcE8yQnJPdW12ZTJLdU91bHZDRHJpNlRzaTV3ZzY0U2o3S2VBSU91bmtDRHFzb011S2lvZzZyT0U3S0NWSU95Z2hPMlptT3lkZ0NEc2lybnNuYmdnN1ptVTY2bTBJTzJWbU91THFDQmI2ck9FN0tDVklPeWdoTzJabUYwZzY3S0U3WXE4N0p5ODY2R2NMZ29LTHk4ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1Q0R0bElUcm9aenNoTGpzaXFRZ0tHTnNZWFZrWlNCaGRYUm9JR3h2WjJsdUlDMHRZMnhoZFdSbFlXa3BJT0tBbENBdmIzQmxiaTFzYjJkcGJ1eWR0Q0RzZzUzc2hMSEN0K3EwZ091bXJDNEtMeThnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJR3h2WTJGc2FHOXpkT3VobkNEcXNyRHFzN3pycGJ3ZzY3TzA2NEswN0tTRUlPdVZqT3E1ak95bmdDRHNpS2pzbHJUc2hKd2c2NHlBNnJpdzdaV1k2NHVrNnJDQUxDRHNtWVRybzR6cmtKanJxYlFnN0lxazdJcWs2NkdjSU91Qm5ldUNuT3VMcEM0S2JHVjBJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdDbXhsZENCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUc1MWJHdzdDbXhsZENCc2IyZHBibE4wWVhKMFpXUkJkQ0E5SURBN0lDOHZJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJnZzdJdWM3SjZSSU95TG5PcXdnU0RpZ0pRZzdKNnM3WUcwNjZhdDdKMjBJQ2ZzbnF6c2k1enJqNFFuN0oyNDdLZUFJQ2ZzbnBEcmo1bnNtWVRybzR3ZzdJdWs3WXlvSit5ZHVPeW5nQ0RxdGF6cnRvVHRsWnpyaTZRS0x5OGc3SjIwNjdLSUlPdWhuT3EzdU95ZHVPeVhrT3lFbkNEcnVJenJuYnpzbXJEc29JQWc3TEM5N0oyRUlPeUxwT3lnbk91aG5DRHJuWVRzbTZEcmlwVHFzSUFnNG9DVUlPMkVzT3V2dU91RWtDRHRqN1Ryc0xIc25ZQWc3SjIwNnJLTUlHWmhiSE5sN0oyOElPdVZqT3VuakNEc2s3VHJpNlFLTHk4Z0tPeUxuT3F3aE91bmpPeWN2T3VobkNEdGpKRHJpNmp0bFpqcnFiUWc3S0NWN0lPQklPeWVyTzJCdE91bXJleVhrT3VQaENCamJXUWc3TEM5N0oyMElPMktnT3lXdE91Q21PeVlxT3VMcENrS2JHVjBJR3h2WjJsdVYybHVaRzkzVDNCbGJtVmtJRDBnWm1Gc2MyVTdDbVoxYm1OMGFXOXVJR3RwYkd4TWIyZHBibEJ5YjJNb0tTQjdDaUFnYVdZZ0tHeHZaMmx1VUhKdlkxUnBiV1Z5S1NCN0lHTnNaV0Z5VkdsdFpXOTFkQ2hzYjJkcGJsQnliMk5VYVcxbGNpazdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdiblZzYkRzZ2ZRb2dJR2xtSUNnaGJHOW5hVzVRY205aktTQnlaWFIxY200N0NpQWdZMjl1YzNRZ2NDQTlJR3h2WjJsdVVISnZZenNLSUNCc2IyZHBibEJ5YjJNZ1BTQnVkV3hzT3dvZ0lIUnllU0I3Q2lBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNCemNHRjNibE41Ym1Nb0ozUmhjMnRyYVd4c0p5d2dXeWN2VUVsRUp5d2dVM1J5YVc1bktIQXVjR2xrS1N3Z0p5OVVKeXdnSnk5R0oxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3dvZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ2RISjVJSHNnY0hKdlkyVnpjeTVyYVd4c0tDMXdMbkJwWkN3Z0oxTkpSMVJGVWswbktUc2dmU0JqWVhSamFDQW9YMlV5S1NCN0lIQXVhMmxzYkNncE95QjlDaUFnSUNCOUNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c2NnkwN0l1Y0lDb3ZJSDBLZlFvS0x5OGc3WVMwSU91UGhPeWtrU0R0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lqdmV5WGlPeWRoQ0RybFl6c25aZ2c3SXVrN1l5b0lPdXBsT3lMbk95bmdDRGlnSlFnY25WdVZIVnlidXlkdENEc25iUWc2Nm1VN0l1YzdLZUE3SjI4SU91VmpPdW5qQ0F4N1pxTUlPeWVrT3VQbVNEc25xenNpNXpyajRUdGxaenJpNlFLWTI5dWMzUWdVMFZUVTBsUFRsOUVTVVZFSUQwZ0orMkJ0T3Vobk91VG5DRHNoTGpzaFpqc25iUWc3S0tGNjZPTTY1Q1E3SmEwN0pxVUxpYzdDbXhsZENCemFIVjBkR2x1WjBSdmQyNGdQU0JtWVd4elpUc2dMeThnTDNOb2RYUmtiM2R1SU95bmhPMldpU0RzcEpFZzRvQ1VJT3llck95TG5PdVBoT3VobkNEc2hManNoWmpzbllRZzY1Q1k3SUswNjZhczdLZUFJT3lWaXVxeWpDRHRrWnpzaTV3S0NpOHZJSEpsWVhOdmJ1eWRoQ0Rzbzd6cnFiUWdKK3lkbU91UGhPeWdnU0Rzb29Ycm80d25LT3F6aE95Z2xTRHNvSVR0bVpqQ3QrdWhuT3EzdU95VmhPeWJneURyazdFcElPS0FsQ0RzcDRUdGxva2c3S1NSN0oyMDY0MllJTzJFdE95ZGhDRHF0N2dnNjZtVTdJdWM3S2VBNjZHY0lPdUJuZXVDdE95RW5Bb3ZMeUJ5ZFc1VWRYSnU3SjJZSUZORlUxTkpUMDVmUkVsRlJDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEc25wRHFzcW5zcHAzcnFvWHNuTHpyb1p3ZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91bXJPeW5nQ0RzbFlycXNvd2c3WldjNjR1a0xnb3ZMeUFvN0pXSUlPcTN1T3Vmck91cHRDRHFzNFRzb0pVZzdLQ0U3Wm1ZSU95bmdlMmJoQ0RzbUpzZzZyT0U3S0NWSU95RXVPeUZtT3lkdENEcnRvRHRtWnp0bGJRZ1RVRllYMVJWVWs1VDZybU03S2VBSU9xemhPeUdqU0RzazdEc25iVHJpcFFnNjdLRTZyZTRJT0tBbENBeU1ESTJMVEEzSU91bXJPdTNzT3lYa095RW5DRHRtWlhzbmJncENtWjFibU4wYVc5dUlHdHBiR3hRY205aktISmxZWE52YmlrZ2V3b2dJR2xtSUNod2NtOWpLU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ0lDQWdJQzh2SUhOb1pXeHNPblJ5ZFdYcm9ad2c2NTJFN0p1TTdJU2NJSEJ5YjJQc25ZQWdZMjFrSU9xN2pldU5zT3E0c0NEaWdKUWdMMVRyb1p3ZzdZcTQ2NmFzN0tlNElPeWp2ZXlYck95VnZDRHNwNFRzcDV3Z1kyeGhkV1JsNnJDQUlPcXpvT3lWaE91aG5DRHNsWWdnNjRLbzY0cVU2NHVrQ2lBZ0lDQWdJQ0FnTHk4Z0tPcXpvT3lWaENCamJHRjFaR1hxc0lBZzdJU2s3TG1ZSU8yTWpPeWR2T3lkaENEcnJMenFzNkFnN0o2STdKeTg2Nm0wSU8yQnRPdWhuT3VUbkNEc2xiRWc3SmVGNjQydzdKMjA3WXE0NnJDQUlDTHNncXpzbXFrZzdLU1JJdXljdk91aG5DRHJwNG50bnBncENpQWdJQ0FnSUNBZ2MzQmhkMjVUZVc1aktDZDBZWE5yYTJsc2JDY3NJRnNuTDFCSlJDY3NJRk4wY21sdVp5aHdjbTlqTG5CcFpDa3NJQ2N2VkNjc0lDY3ZSaWRkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnlCOUtUc0tJQ0FnSUNBZ2ZTQmxiSE5sSUhzS0lDQWdJQ0FnSUNBdkx5QnRZV05QVXkvcnBxenJpSVhzaXFRNklITm9aV3hzT25SeWRXWHJuYndnY0hKdlkreWR0Q0J6YUNEcXU0M3JqYkRxdUxEc25id2c3SWlZSU95ZWlPeWRqQ0RpZ0pRZ2MzUmhjblJRY205ajdKMllJR1JsZEdGamFHVms2NkdjSU91bmpPdVRvQW9nSUNBZ0lDQWdJQzh2SU8yVWhPdWhuT3lFdU95S3BDRHF0N2pybzdrb0xYQnBaQ25zbllRZzdZYTE3S2U0NjZHY0lPeWdsZXVtck8yVm5PdUxwQ0FvZEdGemEydHBiR3dnTDFRZzY0eUE3SjJSS1FvZ0lDQWdJQ0FnSUhSeWVTQjdJSEJ5YjJObGMzTXVhMmxzYkNndGNISnZZeTV3YVdRc0lDZFRTVWRVUlZKTkp5azdJSDBnWTJGMFkyZ2dLRjlsTWlrZ2V5QndjbTlqTG10cGJHd29LVHNnZlFvZ0lDQWdJQ0I5Q2lBZ0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUW9nSUgwS0lDQndjbTlqSUQwZ2JuVnNiRHNLSUNCM1lYSnRaV1JWY0NBOUlHWmhiSE5sT3dvZ0lHbG1JQ2gzWVdsMFpYSXBJSHNnWTJ4bFlYSlVhVzFsYjNWMEtIZGhhWFJsY2k1MGFXMWxjaWs3SUhkaGFYUmxjaTV5WldwbFkzUW9ibVYzSUVWeWNtOXlLSEpsWVhOdmJpQjhmQ0JUUlZOVFNVOU9YMFJKUlVRcEtUc2dkMkZwZEdWeUlEMGdiblZzYkRzZ2ZRcDlDZ3BtZFc1amRHbHZiaUJ6ZEdGeWRGQnliMk1vS1NCN0NpQWdhMmxzYkZCeWIyTW9LVHNLSUNCc2FXNWxRblZtSUQwZ0p5YzdDaUFnZEhWeWJuTWdQU0F3T3dvZ0lDOHZJT3lkdENEc2hManNoWmpzbmJRZzdKYTA2NHFRSU9xemhPeWdsZXlkbUNEc25vWHNucVhxdG96c25MenJvWndnNjQrRTY0cVU3S2VBSU9xNHNPdWhuU0RpZ0pRZzY3Q1c3SmVRN0lTY0lPcXpoT3lnbGV5ZHRDRHJzSlRyZ0l6c2w0anJpcFRzcDRBZzY3bUU2cldRN1pXWTY0cVVJT3E0c095a2dBb2dJSE5sYzNOcGIyNUJZMk52ZFc1MElEMGdZMnhoZFdSbFFXTmpiM1Z1ZENncE93b2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzdJUzQ3SVdZSU95TG5PdVBtU0RzcEpIaWdLWWdLT3VxcU91TnVEb2dKeUFySUdOMWNuSmxiblJOYjJSbGJDQXJJQ2NwSnlrN0NpQWdZMjl1YzNRZ2RHaHBjMUJ5YjJNZ1BTQnpjR0YzYmlnblkyeGhkV1JsSnl3Z1d5Y3RjQ2NzSUNjdExXMXZaR1ZzSnl3Z1kzVnljbVZ1ZEUxdlpHVnNMQ0FuTFMxcGJuQjFkQzFtYjNKdFlYUW5MQ0FuYzNSeVpXRnRMV3B6YjI0bkxDQW5MUzF2ZFhSd2RYUXRabTl5YldGMEp5d2dKM04wY21WaGJTMXFjMjl1Snl3Z0p5MHRkbVZ5WW05elpTZGRMQ0I3Q2lBZ0lDQnphR1ZzYkRvZ2RISjFaU3dnWTNka09pQkZUVkJVV1Y5RFYwUXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd0tJQ0FnSUdSbGRHRmphR1ZrT2lCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUNFOVBTQW5kMmx1TXpJbkxDQXZMeUJRVDFOSldEb2c3SjZRNnJpd0lPMlVoT3Vobk95RXVPeUtwQ0RxdDdqcm83a2c3SU9kN0lTeElPS0FsQ0JyYVd4c1VISnZZK3lkdENEcXQ3anJvN25zcDdnZzdLQ1Y2NmFzN1pXZ0lPeUltQ0Rzbm9qcXNvd0tJQ0I5S1RzS0lDQndjbTlqSUQwZ2RHaHBjMUJ5YjJNN0NpQWdjSEp2WXk1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXdvZ0lDQWdiR2x1WlVKMVppQXJQU0JrTG5SdlUzUnlhVzVuS0NkMWRHWTRKeWs3Q2lBZ0lDQnNaWFFnYVdSNE93b2dJQ0FnZDJocGJHVWdLQ2hwWkhnZ1BTQnNhVzVsUW5WbUxtbHVaR1Y0VDJZb0oxeHVKeWtwSUNFOVBTQXRNU2tnZXdvZ0lDQWdJQ0JqYjI1emRDQnNhVzVsSUQwZ2JHbHVaVUoxWmk1emJHbGpaU2d3TENCcFpIZ3BMblJ5YVcwb0tUc0tJQ0FnSUNBZ2JHbHVaVUoxWmlBOUlHeHBibVZDZFdZdWMyeHBZMlVvYVdSNElDc2dNU2s3Q2lBZ0lDQWdJR2xtSUNnaGJHbHVaU2tnWTI5dWRHbHVkV1U3Q2lBZ0lDQWdJR3hsZENCbGRpQTlJRzUxYkd3N0NpQWdJQ0FnSUhSeWVTQjdJR1YySUQwZ1NsTlBUaTV3WVhKelpTaHNhVzVsS1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnWTI5dWRHbHVkV1U3SUgwS0lDQWdJQ0FnYVdZZ0tHVjJJQ1ltSUdWMkxuUjVjR1VnUFQwOUlDZHlaWE4xYkhRbklDWW1JSGRoYVhSbGNpa2dld29nSUNBZ0lDQWdJR052Ym5OMElIY2dQU0IzWVdsMFpYSTdDaUFnSUNBZ0lDQWdkMkZwZEdWeUlEMGdiblZzYkRzS0lDQWdJQ0FnSUNCamJHVmhjbFJwYldWdmRYUW9keTUwYVcxbGNpazdDaUFnSUNBZ0lDQWdhV1lnS0dWMkxtbHpYMlZ5Y205eUtTQjdDaUFnSUNBZ0lDQWdJQ0JqYjI1emRDQnlZWGNnUFNCVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElHVjJMbk4xWW5SNWNHVWdmSHdnSnljcExuTnNhV05sS0RBc0lESXdNQ2s3Q2lBZ0lDQWdJQ0FnSUNBdkx5RHRsWnpyajRRZzdMU0k2ck84NjZXOElPdW92T3lnZ0NEcnM3anJpNlFnNG9DVUlPdWhuT3EzdU95ZHVDRHNtS1RycFpnZzdLQ1Y2cmVjN0l1ZDdKMjBJT3VFayt5V3RPeUVuQ2hzYjJjZ1AybHVJT3VUc1NrZzY2eTQ2cldzNnJDQUlPdXdsT3VBak91cHRDRHNncnp0Z3F3ZzdJaVlJT3llaU91THBBb2dJQ0FnSUNBZ0lDQWdhV1lnS0dselRHbHRhWFJGY25KdmNpaHlZWGNwS1NCN0NpQWdJQ0FnSUNBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJHbHRhWFFuT3lBdkx5QXZhR1ZoYkhSbzY2R2NJT3lWak91bXZDRGlocElnNjdLRTdZcTg3SjIwSUZ2dGxaenJqNFFnN0xTSTZyTzhYZXVobkNEcnNKVHJnSXpxczZBZzZyT0U3S0NWSU95Z2hPMlptT3lkaENEc2xZanJnclFLSUNBZ0lDQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzZ3F6c21xa2c3WldjNjQrRUlPeTBpT3F6dkNEcXNKRHNwNEE2Snl3Z2NtRjNLVHNLSUNBZ0lDQWdJQ0FnSUNBZ2R5NXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtFeEpUVWxVWDBkVlNVUkZLU2s3Q2lBZ0lDQWdJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tHbHpRWFYwYUVWeWNtOXlLSEpoZHlrcElIc0tJQ0FnSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMk5zWVhWa1pTMXNiMmR2ZFhRbk95QXZMeUF2YUdWaGJIUm82NkdjSU8yVWpPdWZyT3EzdU95ZHVPeVhrQ0RzbFl6cnByd2c0b2FTSU91eWhPMkt2T3lkdENCYjY2R2M2cmU0N0oyNElPMlZoT3lhbEYzcm9ad2c2N0NVNjRDY0NpQWdJQ0FnSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0oyNElPdW5qT3VqakNEcXNKRHNwNEE2Snl3Z2NtRjNLVHNLSUNBZ0lDQWdJQ0FnSUNBZ2R5NXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtFeFBSMGxPWDBkVlNVUkZLU2s3Q2lBZ0lDQWdJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9KKzJCdE91aG5PdVRuQ0RzbUtUcnBaZzZJQ2NnS3lCeVlYY3BLVHNLSUNBZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnSjI5ckp6c2dMeThnN0lTeDZyTzFJRDBnN0lTazdMbVl3cmZyb1p6cXQ3anNuYmdnNjR1a0lPeWdsZXlEZ1NEaWdKUWc3SmEwNjVha0lIQnliMkpzWlczc25iVHJrNkFnN1pXMDdLQ2NJQ2pzbnF6cm9aenF0N2pzbmJndjdKNnM3SVNrN0xtWUlPdXp0ZXEzZ0NrS0lDQWdJQ0FnSUNBZ0lIY3VjbVZ6YjJ4MlpTaFRkSEpwYm1jb1pYWXVjbVZ6ZFd4MElIeDhJQ2NuS1NrN0NpQWdJQ0FnSUNBZ2ZRb2dJQ0FnSUNCOUNpQWdJQ0I5Q2lBZ2ZTazdDaUFnY0hKdll5NXpkR1JsY25JdWIyNG9KMlJoZEdFbkxDQW9aQ2tnUFQ0Z2V3b2dJQ0FnWTI5dWMzUWdjeUE5SUdRdWRHOVRkSEpwYm1jb0ozVjBaamduS1M1MGNtbHRLQ2s3Q2lBZ0lDQnBaaUFvY3lBbUppQWhjeTVwYm1Oc2RXUmxjeWduUkdWd2NtVmpZWFJwYjI1WFlYSnVhVzVuSnlrcElHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0JqYkdGMVpHVWdjM1JrWlhKeU9pY3NJSE11YzJ4cFkyVW9NQ3dnTWpBd0tTazdDaUFnZlNrN0NpQWdjSEp2WXk1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGdld29nSUNBZ0x5OGc3SjIwNjYrNElPeURpQ0RzaExqc2haanNuTHpyb1p3ZzZyV1E3TEswNjVDY0lPdVNwQ0RzbUpzZzdJUzQ3SVdZN0oyMElPdUxxKzJlakNEcXNiRHJxYlFnNjZ5MDdJdWNJQ2pycXFqcmpiZ2c3S0NFN1ptWUlPeUxuQ0RzZzRnZzdJUzQ3SVdZN0oyRUlPeWp2ZXlkdE95bmdDRHNsWXJxc293cENpQWdJQ0JwWmlBb2NISnZZeUFoUFQwZ2RHaHBjMUJ5YjJNcElISmxkSFZ5YmpzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzdJUzQ3SVdZSU95aWhldWpqQ0FvWTI5a1pTQW5JQ3NnWTI5a1pTQXJJQ2NwSU9LQWxDRHJpNlRzbll3ZzdKcVU3TEt0SU91VmpDRHJpNlRzaTV3ZzdJdWM2NCtaN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnYTJsc2JGQnliMk1vS1RzS0lDQjlLVHNLZlFvS1puVnVZM1JwYjI0Z2MyVnVaRlIxY200b2RHVjRkQ2tnZXdvZ0lISmxkSFZ5YmlCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpTd2djbVZxWldOMEtTQTlQaUI3Q2lBZ0lDQnBaaUFvSVhCeWIyTXBJSEpsZEhWeWJpQnlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lYaHV5V3RPeWFsQzRuS1NrN0NpQWdJQ0JwWmlBb2QyRnBkR1Z5S1NCeVpYUjFjbTRnY21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN0pXZTdJU2dJT3lhbE95eXJleWR0Q0RzcDRUdGxva2c3S1NSN0oyMDdKZVE3SnFVTGljcEtUc0tJQ0FnSUdOdmJuTjBJSFJwYldWeUlEMGdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0aExRZzdJdWM2ckNFSU95MGlPcXp2Q0RpZ0pRZzdJUzQ3SVdZN0oyRUlPeWVyT3lMbk95ZWtlMlZxZXVMaU91THBDNG5LVHNLSUNBZ0lDQWdMeThnN0l1YzZyQ0VJT3kwaU9xenZPdUtsQ0FuN0lTNDdJV1lJT3lpaGV1ampDZnNtWUFnNnJXczY3YUU2NUNZNjRxVUlPeWduQ0RycVpUc2k1enNwNERyb1p3ZzY0R2Q2NEs0NjR1a0lPS0FsQ0JyYVd4c1VISnZZK3lkbUNEc2hManNoWmdnN0tLRjY2T01JSEpsYW1WamRPcXdnQW9nSUNBZ0lDQXZMeUJ5ZFc1VWRYSnU3SjJZSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRycGJ3ZzY3YUE2NlcwNjZtMElPeVZpQ0Rya0pqcXVMQWc2NVdNNjZ5NEtPdUtrT3Vtc0NEdGhMVHNuWVFnNjVHUUlPdXlpQ0RyajR6cnFiUWc3WlNNNjUrczZyZTQ3SjI0SURFek1PeTBpQ0Rzb0p6dGxaenNuWVFnNjRTWTZyaTA2NHVrS1FvZ0lDQWdJQ0JwWmlBb2QyRnBkR1Z5S1NCN0NpQWdJQ0FnSUNBZ1kyOXVjM1FnZHlBOUlIZGhhWFJsY2pzZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNLSUNBZ0lDQWdJQ0IzTG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbmJRZzY0U0k2NnkwSU95WXBPdWVtQ0Rxc2Jqcm9LUWc3SnFVN0xLdDdKMkVJT3lra2V1THFPMldpT3lXdE95YWxDRGlnSlFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1SnlrcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUd0cGJHeFFjbTlqS0NrN0NpQWdJQ0I5TENCVVZWSk9YMVJKVFVWUFZWUmZUVk1wT3dvZ0lDQWdkMkZwZEdWeUlEMGdleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIMDdDaUFnSUNCd2NtOWpMbk4wWkdsdUxuZHlhWFJsS0VwVFQwNHVjM1J5YVc1bmFXWjVLSHNnZEhsd1pUb2dKM1Z6WlhJbkxDQnRaWE56WVdkbE9pQjdJSEp2YkdVNklDZDFjMlZ5Snl3Z1kyOXVkR1Z1ZERvZ2RHVjRkQ0I5SUgwcElDc2dKMXh1Snl3Z0ozVjBaamduS1RzS0lDQjlLVHNLZlFvS0x5OGc2ckNaN0oyQUlPdXN1T3Exck91bHZDRHJxb2NnNjdLSTdLZTRJT3VzdSt1S2xPeW5nQ0RxdUxEc2xyVWc0b0NVSU95ZXJPeWFsT3l5cmV5ZHRPdXB0Q0FpN0oyMDdLQ0U2ck84SU91THBPdWx1Q0RzZzRnZzdLQ2M3SldJSXV5ZGhDRHNtcFRxdGF6dGxaenJpNlFLTHk4Z0tPeVZpQ0RxdDdqcm42enJxYlFnN1lHMDY2R2M2NU9jNnJDQUlPeUVzZXlMcE8yVm1PcXlqQ0Rxc0puc25ZQWc2NHUxN0oyRUlPdVlrQ0RyZ3JUc2hKd2dXMEZKSU95MmxPeXluQ0RyalpRZzY3Q2I2cml3WGVxd2dDRHJyTFRzblpqcnI3anRsYlRzcDRUcmk2UXBDbU52Ym5OMElHRnphMlZrUTI5MWJuUWdQU0J1WlhjZ1RXRndLQ2s3Q2dvdkx5RHNoTGpzaFpnZzdLU0E2N21FS095TG5PdVBtU3ZzcDREc2k1enJyTGdnN0tPODdKNkZLZXVsdkNEcnM3VHNucVh0bFp3ZzY1S2tJTzJWbkNEdGhMUWc3SXVrN1phSklPS0FsQ0RycXFqcms2QWc3Wmk0N0xhYzdKMkFJSEYxWlhWbDY2R2NJT3luZ2V1Z3JPMlpsQzRLTHk4Z2JXOWtaV3pzbllRZzdLTzg2Nm0wSU9xM3VDRHJxcWpyamJqcm9ad2dLT3VMcE91bHRPdXB0Q0RzaExqc2haZ2c3SjZzN0l1YzdKNlJLUzRnN1pXY0lPdXFxT3VOdU95ZGhDRHFzNFRzaG8wZzdKT3c2Nm0wSU95ZXJPeUxuT3lla2V5ZGdDRHN0WnpzdElnZ01lMmFqT3Uva0M0S0x5OGdjbVZ3WVhKelpUMTdjR0Z5YzJVc0lHWnZjbTFoZEVSbGMyTjk2Nlc4SU95anZPdXB0Q0R0akl6c2k3SHF1WXpzcDRBZzdKMjBJT3llb1NEc2xZanNsNURzaEp3ZzdMS1k2NmFzN1pXWTZyT2dJSHR5WVhjc0lIQmhjbk5sWkgzcnBid2c2NCtNNjZDazdLU0E2NHVrT2dvdkx5RHRtSlhzaTUwZzdKMjA3WU9JSU95TG5DRHFzSm5zbllBZzdJUzQ3SVdZN0plUUlDTHRtSlhzaTUzcmpJRHJvWndnNjR1azdJdWNJdXVsdkNEc21wVHF0YXp0bFpqcmlwUWc3SjZzN0pxVTdMS3RJTzJFdE95ZGhDQXFLdXF3bWV5ZGdDRHRnWkFnN0o2aElPeVZpT3lYa095RW5Db3FJT3UybWV5ZHVPdUxwQzRLTHk4ZzY3T0U2NCtFSU95ZW9leWN2T3VobkNEcnVienJxYlFnS0dFcElPeUNyT3lkdE95WGtDRHJpNlRycGJnZzdKcVU3TEt0SU8yRXRPeWR0Q0RyZ2J6c2xyUWdKK3V3cWVxNGlDRHJpN1VuN0oyMElPdUNxT3lkbUNEcmk3WHNuYlFnNjVDWTZyT2dLT3VDdE95YXFTRHNtS1RzbDd3cExBb3ZMeUFvWWlrZ1RVRllYMVJWVWs1VElPcXl2ZXF6aE95WGtPeUVuQ0RzaExqc2haanNuYlFnN0o2czdJdWM3SjZSNjQrOElDZnJzS25xdUlnZzY0dTFKK3lkdENEc2w0YnJpcFFnN0lPSUlPeUV1T3lGbU95ZHRDRHJnclRzbXFuc25ZUWc3S2VBN0phMDY0SzhJT3lJbUNEc25vanJpNlFnS0RJd01qWXRNRGNnNjZhczY3ZXc3SmVRN0lTY0lPMlpsZXlkdUNrdUNtTnZibk4wSUZKRlVFRlNVMFZmUWtGRUlEMGdLSFlwSUQwK0lIWWdQVDBnYm5Wc2JDQjhmQ0FvUVhKeVlYa3VhWE5CY25KaGVTaDJLU0FtSmlCMkxteGxibWQwYUNBOVBUMGdNQ2s3Q21aMWJtTjBhVzl1SUhKMWJsUjFjbTRvWW5WcGJHUkJjMnNzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLU0I3Q2lBZ1kyOXVjM1FnYW05aUlEMGdjWFZsZFdVdWRHaGxiaWhoYzNsdVl5QW9LU0E5UGlCN0NpQWdJQ0JqYjI1emRDQnFiMkpUZEdGeWRDQTlJRVJoZEdVdWJtOTNLQ2s3SUM4dklPeUxuT3F3aENEc21JanNnckFnNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0RzcXIwZzdLQ2M3WldjS0RFek1PeTBpQ25zbllRZzY0U1k2cmk0SU95ZXJPeUxuT3VQaE91S2xDRHRqNnpxdUxEdGxaenJpNlFLSUNBZ0lHbG1JQ2h0YjJSbGJDQW1KaUJCVEV4UFYwVkVYMDFQUkVWTVV5NXBibVJsZUU5bUtHMXZaR1ZzS1NBaFBUMGdMVEVnSmlZZ2JXOWtaV3dnSVQwOUlHTjFjbkpsYm5STmIyUmxiQ2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2cW82NDI0SU91emdPcXl2VG9nSnlBcklHTjFjbkpsYm5STmIyUmxiQ0FySUNjZzRvYVNJQ2NnS3lCdGIyUmxiQ2s3Q2lBZ0lDQWdJR04xY25KbGJuUk5iMlJsYkNBOUlHMXZaR1ZzT3dvZ0lDQWdJQ0J6ZEdGeWRGQnliMk1vS1RzZ0x5OGc3SU9JSU91cXFPdU51T3VobkNEc2hManNoWmdnN0o2czdJdWM3SjZSSUNqcmk2VHNuWXdnN0p1TTY3Q043SmVGN0plUTdJU2NJT3luZ095TG5PdXN1Q0RzbnF6c283enNub1VwQ2lBZ0lDQjlDaUFnSUNCcFppQW9kSFZ5Ym5NZ1BqMGdUVUZZWDFSVlVrNVRJSHg4SUNGd2NtOWpLU0J6ZEdGeWRGQnliMk1vS1RzS0lDQWdJR2xtSUNnaGQyRnliV1ZrVlhBcElIc0tJQ0FnSUNBZ1kyOXVjM1FnZERBZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ0lDQmhkMkZwZENCelpXNWtWSFZ5YmlocGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTazdDaUFnSUNBZ0lIZGhjbTFsWkZWd0lEMGdkSEoxWlRzS0lDQWdJQ0FnZEhWeWJuTXJLenNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95RXVPeUZtQ0RzcElEcnVZUWc3Sm1FNjZPTUlDZ25JQ3NnS0NoRVlYUmxMbTV2ZHlncElDMGdkREFwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1NBcklDZHpLU0RpZ0pRZzdKMjA3WnVFSU95YWxPeXlyZXlkZ0NEcnVhanJuYnpzbXBRdUp5azdDaUFnSUNCOUNpQWdJQ0IwZFhKdWN5c3JPd29nSUNBZ1kyOXVjM1FnWVhOcklEMGdZblZwYkdSQmMyc29LVHNnTHk4ZzdKNnM3SXVjNjQrRUlPdVZqQ0Rxc0puc25ZQWc3S2VJNjZ5NDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRZ0tHRnphMlZrUTI5MWJuUWc3SjIwN0tTUklPeW1uZXF3Z0NEcnNLbnNwNEFwQ2lBZ0lDQnNaWFFnY21GM093b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ2NtRjNJRDBnWVhkaGFYUWdjMlZ1WkZSMWNtNG9ZWE5yS1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnTHk4ZzdZUzBJT3VQaE95a2tTRHRnYlRyb1p6cms1d2c3WlNFNjZHYzdJUzQ3SXFrNnJDQUlPeWp2ZXlkZ0NEcXNyM3NtckFvVTBWVFUwbFBUbDlFU1VWRUtTQXg3WnFNSU95ZWtPdVBtU0RzbnF6c2k1enJqNFFnNG9DVUlPeUNyT3lhcWV5ZWtPeVhrT3F5a0NEc2k2VHRqS2pyb1p3ZzdKV0lJT3V6dE95ZHRPcXlqQzRLSUNBZ0lDQWdMeThnN0l1YzZyQ0VJT3kwaU9xenZNSzM2NkdjNnJlNDdKMjRJT3Vuak91ampNSzM3WUcwNjZHYzY1T2NJT3lZcE91bG1NSzM3SjJZNjQrRTdLQ0JJT3lpaGV1ampDanFzNFRzb0pVZzdLQ0U3Wm1ZTCt1aG5PcTN1T3lWaE95Ymd5d2dhMmxzYkZCeWIyTW9jbVZoYzI5dUtTbnJpcFFLSUNBZ0lDQWdMeThnN0tDY0lPdXBsT3lMbk95bmdPcXdnQ0RybExEcm9ad2c3SjZJN0phMElPeVhyT3E0c0NEc2xZZ2c2ckc0NjZhdzY0dWtMaURzb29Ycm80d2c3SnFVN0xLdElPeWtrZXlkdE9xeHNPdUNtQ0RzaTV6cXNJUWc3SmlJN0lLdzdKMjBJT3lXdk91bmlDRHNsWWdnNjRLbzdKV1k3Snk4NjZtMElPdVFtT3lDdE91bXJPeW5nQ0RzbFlycmlwVHJpNlF1Q2lBZ0lDQWdJR2xtSUNoemFIVjBkR2x1WjBSdmQyNGdmSHdnSVNobElDWW1JR1V1YldWemMyRm5aU0E5UFQwZ1UwVlRVMGxQVGw5RVNVVkVLU0I4ZkNCRVlYUmxMbTV2ZHlncElDMGdhbTlpVTNSaGNuUWdQaUEwTURBd01Da2dkR2h5YjNjZ1pUc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFdU95Rm1PeWR0Q0R0aExRZzY0K0U3S1NSSU91Qml1cTVnQ0RpZ0pRZzdKNnM3SXVjNjQrWklPMmJoQ0F4N1pxTUlPeWVyT3lMbk91UGhPMlZxZXVMaU91THBDNG5LVHNLSUNBZ0lDQWdjM1JoY25SUWNtOWpLQ2s3Q2lBZ0lDQWdJR0YzWVdsMElITmxibVJVZFhKdUtHbHVjM1J5ZFdOMGFXOXVUV1Z6YzJGblpTZ3BLVHNLSUNBZ0lDQWdkMkZ5YldWa1ZYQWdQU0IwY25WbE93b2dJQ0FnSUNCMGRYSnVjeUE5SURJN0lDOHZJT3liak91d2pleVhoU0F4SUNzZzdKMjA2N0tJSU8yRXRDQW9jM1JoY25SUWNtOWo3SjIwSUREc25MenJvWndnN0xTSTZyaXc3Wm1VS1FvZ0lDQWdJQ0J5WVhjZ1BTQmhkMkZwZENCelpXNWtWSFZ5YmloaGMyc3BPd29nSUNBZ2ZRb2dJQ0FnYVdZZ0tDRnlaWEJoY25ObEtTQnlaWFIxY200Z2NtRjNPd29nSUNBZ2JHVjBJSEJoY25ObFpDQTlJSEpsY0dGeWMyVXVjR0Z5YzJVb2NtRjNLVHNLSUNBZ0lDOHZJTzJZbGV5TG5TRHNuYlR0ZzRqc25iVHJxYlFnNnJDWjdKMkFJT3lFdU95Rm1NSzM2ckNaN0oyQUlPeWVvZXlYa095RW5DRHFzNmZzbnFVZzdKNnM3SnFVN0xLdElPS0FsQ0RzbmJRZzdZUzA3SjIwSU95anZleWN2T3VwdENEc2c0Z2c3SVM0N0lXWTdKMkFJQ2Zyc0tucXVJZ2c2NHUxSit5ZGhDRHJxckRybmJ3S0lDQWdJQzh2SU95bmdPeVd0T3VDdkNEc2lKZ2c3SjZJN0p5ODY2K0E2NkdjSU95RXVPeUZtQ0RzZ3F6cnA1MGc3SjZzN0l1YzY0K0U2NHFVSU8yVm1PeW5nQ0RzbFlycXM2QWc2cmU0NjR5QTY2R2NJT3lMcE8yTXFPeUxuTzJDcU91THBDanRqSXpzaTdFZzdJdWs3WXlvNjZHY0lPcTNnT3F5c0NrdUNpQWdJQ0JwWmlBb1VrVlFRVkpUUlY5Q1FVUW9jR0Z5YzJWa0tTQW1KaUJFWVhSbExtNXZkeWdwSUMwZ2FtOWlVM1JoY25RZ1BDQTNNREF3TUNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlNN0l1eElPeUxwTzJNcUNEaWdKUWc3WmlWN0l1ZElPeWVyT3lhbE95eXJUb25MQ0JUZEhKcGJtY29jbUYzS1M1emJHbGpaU2d3TENBek1EQXBLVHNLSUNBZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUNBZ2RISjVJSHNLSUNBZ0lDQWdJQ0J5WVhjZ1BTQmhkMkZwZENCelpXNWtWSFZ5YmlnbjY3Q3A2cmlJSU91THRleWR0Q0RzbXBUcXRhenRsWndnN1ppVjdJdWQ3SmVRSU95V3RPcTRpK3VDck91THBDNGc2N0NwNnJpSUlPdUx0ZTJWbkNEcmdyVHNtcW5zbllRZzdJU2s2NnFGd3Jmc2dxenFzN3pDdCt5OWxPdVRuTzJPbk95S3BDRHNsNGJzbmJRZzdKV0U2NTZZSUVwVFQwN3NuTHpyb1p6cnA0d2c2NHVrN0l1Y0lPeTJuT3VncGUyVm1PdWR2RG9nSnlBcklISmxjR0Z5YzJVdVptOXliV0YwUkdWell5azdDaUFnSUNBZ0lDQWdjR0Z5YzJWa0lEMGdjbVZ3WVhKelpTNXdZWEp6WlNoeVlYY3BPd29nSUNBZ0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNucXpzbXBUc3NxMGc3SXVrN1l5b0lPS0FsQ0RzbFlUcm5wanNsNURzaEp3ZzdZeU03SXV4SU95THBPMk1xT3VobkNEc3NwanJwcXdnS2k4Z2ZRb2dJQ0FnZlFvZ0lDQWdhV1lnS0ZKRlVFRlNVMFZmUWtGRUtIQmhjbk5sWkNrcElHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0akl6c2k3RWc3SXVrN1l5b0lDanNucXpzbXBUc3NxMGc3WnVFN0plUTY0K0VLVG9uTENCVGRISnBibWNvY21GM0tTNXpiR2xqWlNnd0xDQXpNREFwS1RzS0lDQWdJSEpsZEhWeWJpQjdJSEpoZHl3Z2NHRnljMlZrT2lCU1JWQkJVbE5GWDBKQlJDaHdZWEp6WldRcElEOGdiblZzYkNBNklIQmhjbk5sWkNCOU93b2dJSDBwT3dvZ0lDOHZJTzJWbkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXMDY0K0VJT3VMcE95ZGpDRHNtcFRzc3Ezc25iUWc3SjIwN0phMDdLZUE2NCtFNjZHZElPMkJrT3VLbENEdGxhM3NnNEVnN0lTeDZyTzE3Snk4NjZHY0lPeWdsZXVtckFvZ0lIRjFaWFZsSUQwZ2FtOWlMbU5oZEdOb0tDZ3BJRDArSUh0OUtUc0tJQ0J5WlhSMWNtNGdhbTlpT3dwOUNnb3ZMeURyc29UdGlyd2c2NTI4NjdLb0lPcTNuT3k1bVNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElDZnJzb1R0aXJ6c25ZUWc2ck9vNjU2UTY0dWtKK3F6b0NEc2xZenJvS1RzcElRZzY1V002NmVNSU95V3VldUtsT3VMcEM0S0x5OGc2N0tFN1lxOElPdXN1T3Exck91S2xDRHJyTGpzbnFYc25iUWc3SldFNjR1STY1MjhJT3VQbWV5ZWtTRHNuYlRycG9Uc25iVHNsclRzaEp3c0lPeWR0Q0RzcDREc2k1enFzSUFnN0plRzdKeTg2Nm0wSU91c3VPeWVwZTJZbFNEcmpJRHNsWWpzbmJRZzdJU2U3SmVzSU91Q21PeVlxT3VMcEM0S1kyOXVjM1FnUWxWVVZFOU9YMUpWVEVVZ1BRb2dJQ2ZzbmJRZzY2eTQ2cldzNjRxVUlDb3E2N0tFN1lxOElPdWR2T3V5cUNvcTdKMjA2NHVrTGlEcnJManNucVhzbmJRZzdKV0U2NHVJNjUyOElPdVBtZXlla1NEc25iVHJwb1RzbmJUcnI0RHJvWnc2SU91bmlPeTVxTzJSbk1LMzY2eTg3SjJNN1pHY3dyZnNvb1hxc3JEc2xyVHJyN2dvZnV5YWxDOSs2NHVrTDM3cXVZenNtcFFwSU9xNGlPeW5nQ3dnSnlBckNpQWdKK3VRbU91UGhPdWhuU0RzcDZmc25ZQWc2NCtaN0o2UklPdXFoZXlDckNqc29JRHNucVhDdCt5Q3JleWduTUszN0pldzZyS3dJTzJWdE95Z25DRHJrN0VwNjZHY0xDRHRoclhyczdUc2hMRWc2NHVvN0oyOElPdXloTzJLdk95ZHRPdXB0Q0FpN1ptVjdKMjRJaTRnSnlBckNpQWdKeUxzdDZqc2hvd2k2NHFVSU91UG1leWVrU0Ryc29UdGlyenFzN3dnN0tlZDdKMjhJT3VWak91bmpDRHNrN0RxczZBc0lPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRnQ0RxdDdqcmpJRHJvWndnNjVHVTY0dWtMbHh1SnpzS0NpOHZJT3VzdU9xMXJDRHN0cFRzc3B3ZzdZUzBJQ2h5YjJ4bFBTZnJzb1R0aXJ3bjdKMjA2Nm0wSU91eWhPMkt2Q0RxdDV6c3VabnNuWVFnN0phNTY0cVU2NHVrS1FwbWRXNWpkR2x2YmlCaGMydERiR0YxWkdVb2RHVjRkQ3dnYlc5a1pXd3NJSEpsY0dGeWMyVXNJSEp2YkdVcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0NpQWdJQ0JqYjI1emRDQmhkSFJsYlhCMElEMGdLR0Z6YTJWa1EyOTFiblF1WjJWMEtIUmxlSFFwSUh4OElEQXBJQ3NnTVRzS0lDQWdJR0Z6YTJWa1EyOTFiblF1YzJWMEtIUmxlSFFzSUdGMGRHVnRjSFFwT3dvZ0lDQWdhV1lnS0dGemEyVmtRMjkxYm5RdWMybDZaU0ErSURJd01Da2dZWE5yWldSRGIzVnVkQzVqYkdWaGNpZ3BPeUF2THlEcnJMVHRsWnp0bm9nZzdJeVQ3SjIwN0tlQUlPeVZpdXF5akFvZ0lDQWdZMjl1YzNRZ2NuVnNaU0E5SUhKdmJHVWdQVDA5SUNmcnNvVHRpcnduSUQ4Z1FsVlVWRTlPWDFKVlRFVWdPaUFuSnpzS0lDQWdJSEpsZEhWeWJpQnlkV3hsSUNzZ0tHRjBkR1Z0Y0hRZ1BpQXhDaUFnSUNBZ0lEOGdKK3F3bWV5ZGdDRHJyTGpxdGF6cnBid2c2NHVrN0l1Y0lPeWFsT3l5cmUyVm5PdUxwQzRnN0oyMElPeUV1T3lGbU95WGtPeUVuQ0RzbmJUc29JVHNsNUFnN0tDYzdKV0k3WmFJNjQyWUlPcXlnK3VUcE9xenZDRHFzcm5zdVpqc3A0QWc3SldLNjRxVUxDRHF0YXpzb2JEcmdwZ2c3SmEwN1p5WTZyQ0FJTzJabGV5THBPMmVpQ0RyaTZUcnBiZ2c3SU9JNjZHYzdKcTBJT3VNZ095VmlDQXo2ckNjNjZXOElPcTNuT3k1bWV1TWdPdWhuQ0JLVTA5T0lPdXdzT3lYdE91aG5PdW5qRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0hSbGVIUXBDaUFnSUNBZ0lEb2dKK3VMcE95ZGpDQlZTU0RyckxqcXRhenNuWmdnNjR5QTdKV0lJRFBxc0p6cnBid2c2cmVjN0xtWjY0eUE2NkdjSUVwVFQwNGc2N0N3N0plMDY2R2M2NmVNT2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb2RHVjRkQ2twT3dvZ0lIMHNJRzF2WkdWc0xDQnlaWEJoY25ObEtUc0tmUW9LTHk4ZzY3S0k3SmV0SU8yRXRDRGlnSlFnNnJDWjdKMkFJT3lFdU95Rm1PeWRoQ0RzazdEcmtKZ3NJT3lkdE91eWlDRHRoTFRycDR3ZzdMYVU3TEtjSU8yWWxleUxuU2hLVTA5T0lPdXdzT3lYdENrZzY0eUE3SXVnSU91eWlPeVhyU0R0bUpYc2k1MG9TbE5QVGlEcXNKM3NzclFwN0oyRUlPeWFsT3Exck8yVm5PdUxwQXBtZFc1amRHbHZiaUJoYzJ0VWNtRnVjMnhoZEdVb2RHVjRkQ3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBJSHNLSUNCeVpYUjFjbTRnY25WdVZIVnliaWdvS1NBOVBpQW9DaUFnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NEcnNvanNsNjBnN0o2UjdKZUY3SjIwNjR1a0lDanJyTGpxdGF3ZzY0dWs2NU9zNnJpd0lPeVZoT3VMbUNEaWdKUWc2NHlBN0pXSUlEUHFzSndnNnJlYzdMbVo3SjJBSU95ZHRPdXlpQ0R0aExUc2w1QWc3S0NCN0pxcDdaV1k3S2VBSU95Vml1dUtsT3VMcENrdUlDY2dLd29nSUNBZ0ordUxwT3lkakNCVlNTRHJyTGpxdGF6cXNJQWc3WldjNnJXdDdKYTA2Nm0wSU95ZWtPeVhzT3lLcE91ZnJPeWF0Q0RzbUlIc2xyVHJvWndzSU95WWdleVd0T3VwdENEc25wRHNsN0RzaXFUcm42enNtclFnN1pXYzZyV3Q3SmEwNjZHY0lPdXlpT3lYcmUyVm1PdWR2QzRnSnlBckNpQWdJQ0FuVlVrZzY2eTQ2cldzNjR1azdKcTBJT3F3aE9xeXNPMlZuQ0R0a1p6dG1JVHNuWVFnN0pPdzZyT2dMQ0RzbmJUcnBvVEN0K3lJcSt5ZWtNSzM2NmVJN0lxazdZSzV3cmZ0bEl6cm9JanNuYlRzaXFUdG1ZRHJqWlRyaXBRZzZyZTQ2NHlBNjZHY0lPdXp0T3lodE8yVm5PdUxwQzRnSnlBckNpQWdJQ0FuN0p1UTY2eTQ3SjJZSU95a2hDRHNpSmpycGJ3ZzZyZTQ2NHlBNjZHY0lPeWNvT3luZ08yVm5PdUxwQ0RpZ0pRZzdKdVE2Nnk0N0oyMElPMlZuQ0RzcElUc25iVHJxYlFnNjdLSTdKZXQ2NCtFSU8yVm5DRHNwSVRyb1p3c0lPeWtoT3V3bE9xL2lPeWRoQ0Rzbm9Uc25aanJvWndnN0xhVTZyQ0E3WldZN0tlQUlPeVZpdXVLbE91THBDNGdKeUFyQ2lBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU9xd25leXl0Q0R0bFpqcmdwanJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoU0RxdUlqc3A0QTZJQ2NnS3dvZ0lDQWdKM3NpZEhKaGJuTnNZWFJsWkNJNklDTHJzb2pzbDYzcnJMZ2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW1ScGNtVmpkR2x2YmlJNklDSnJiK0tHa21WdUlPdVlrT3VLbENCbGJ1S0drbXR2SW4wNklDY2dLeUJLVTA5T0xuTjBjbWx1WjJsbWVTaDBaWGgwS1FvZ0lDa3NJRzF2WkdWc0xDQnlaWEJoY25ObEtUc0tmUW9LTHk4ZzY0eUE3Wm1VN1ppVklPdXN1T3ExckNEc29KenNucEVnN1lTMElPS0FsQ0RzZ3F6c21xbnNucERxc0lBZzdJT0I3Wm1wN0oyRUlPeUVwT3VxaGUyVm1PdXB0Q0RycDZYcm5iM3NsNUFnNjZlZTY0cVVJT3VzdU9xMXJPdWx2Q0RycDR6cms2VHNsclRzcElEcmk2UXVDaTh2SUcxbGMzTmhaMlZ6T2lCYmUzSnZiR1U2SjNWelpYSW5mQ2RoYzNOcGMzUmhiblFuTENCMFpYaDBmVjBnN0tDRTdMSzBJT3VNZ08yWmxPdWx2Q0RycDZUcnNvZ2c2N0NiNjRxVTY0dWtLT3VMcE91bXJPdUtsQ0RyckxUc2c0SHRnNXdnNG9DVUNpOHZJT3liak91d2pleVhoU0RzcDREc2k1enJyTGpzblpnZ0l1eWFsT3l5cmV1VHBPeWRnQ0RzaEp6cm9ad2c2NnkwNnJTQUlpRHNvSVRzb0p6cnBid2c3S2VBN1lLazZyaXdJT3ljaE8yVnRDRHJqSUR0bVpRZzY2ZWw2NTI5N0oyRUlPMkV0Q0RzbFlqc2w1QWc2NnE5NjVXRklPeUxvK3VLbE91THBDa3VDbVoxYm1OMGFXOXVJR0Z6YTBOdmJYQnZjMlVvYldWemMyRm5aWE1zSUcxdlpHVnNMQ0J5WlhCaGNuTmxLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnZEhKaGJuTmpjbWx3ZENBOUlDaHRaWE56WVdkbGN5QjhmQ0JiWFNrdWJXRndLQ2h0S1NBOVBnb2dJQ0FnSUNBb2JTNXliMnhsSUQwOVBTQW5ZWE56YVhOMFlXNTBKeUEvSUNmc2xyVHNpNXpzaXFUdGhMVHRpcmc2SUNjZ09pQW43SUtzN0pxcDdKNlFPaUFuS1NBcklGTjBjbWx1WnlodExuUmxlSFFnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJREUxTURBcENpQWdJQ0FwTG1wdmFXNG9KMXh1SnlrN0NpQWdJQ0J5WlhSMWNtNGdLQW9nSUNBZ0lDQW43SjIwNjdLSUlPeWFsT3l5cmV5ZGdDQWk2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFaTdKMjA2NHVrSUNqcXVMRHNvYlFnNjZ5NDZyV3NJT3VMcE91VHJPcTRzQ0RzbFlUcmk1Z2c0b0NVSU95VmhPdWVtQ0RyaklEdG1aVHFzSUFnN0oyMDY3S0lJTzJFdE95ZG1DRHNvSVRzc3JRZzY2ZWw2NTI5N0oyMDY0dWtLUzRnSnlBckNpQWdJQ0FnSUNmc2dxenNtcW5zbnBEcXNJQWc3Wm1VNjZtMElPeURnZTJacWNLMzY2ZWw2NTI5N0oyRUlPeUVwT3VxaGUyVm1PdXB0Q3dnN0lxazdZT0E3SjI4SU9xM25PeTVtZXF6dkNEc21JanNpNXdnN1lhazdKZVFJT3VubnV1S2xDQlZTU0RyckxqcXRhenJwYndnNjZlTTY1T2s3SmEwSU95Z25PeVZpTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcnA2WHJuYjNzbmJRZzY3YUE3S0d4N1pXWTY2bTBJTzJPdU8yVm1PcXlqQ0Rya0pqcnJMenNsclRybmJ3NklPeVd0T3VXcENEdG1aVHJxYlRDdCtxNHNPdUtwZXlkbUNEcnJManF0YXpzbmJqc3A0QXNJT3VUcE95V3RPcXdpQ0RzbnBEcnBxenJpcFFnN0phMDY1U1U3SjI0N0tlQUtPMk1uZXlYaFNEdGc0RHNuYlR0aTRBdjY3TzQ2Nnk0TCt1eWhPMkt2Q3dnN1lhZzdJcWs3WXE0TENEcnVZZ2c3Wm1VNjZtMElPeVZpT3VDdEN3ZzY3Q3c2NFNJSU91VHNTa3NJT3lXdE91V3BDRHNnNEh0bWFuc25ianNwNEFvN0lTeDZyTzFJTzJHdGV1enRDL3NtS1RycFpndjdabVY3SjI0SU95YWxPeXlyUy9zbFlqcmdyUXBJT3F3bWV5ZGdDRHFzb011SU9xOHJTRHRsWVRzbXBUdGxad2c2cktENjZlTUlPcXpxT3VkdkNEdGxad2c2N0tJN0plUUlPeTFuT3VNZ0NBeTZyQ2M2cm1NN0tlQUxDRHNwNmZxc293dUlPeWR0T3VWakNCemRXZG5aWE4wYVc5dWMrdUtsQ0RydVlnZzY3Q3c3SmUwTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3F3a095ZHRDRHNsclRyaXBBZzdLQ1Y2NCtFSU95WXBPdXB0Q0Ryckx2cXVMRHJwNHdnN1pXWTdLZUFJT3VuaU91ZHZDRGlnSlFnNnJDQTdLQ1Y3SjJFSU95RXVPeWFzT3F6b0NEc3RJanNsWWdnYzNWbloyVnpkR2x2Ym5QcnBid2c3WldvNnJ1WUlPdUN0T3VwdE95RW5Dd2djbVZ3Ykhuc2w1QWc2ckNBN0tDVjdKMkVJT3V3bmUyZWlPcXpvQ0RyckxUc2w0ZnNuWVFnN0pXTTY2Q2s3S084NjZtMElPdU5sQ0RycDU3c3Rwd2c3SWlZSU95ZWlPdUtsT3luZ0NEdGxad2c2Nnk0N0o2bDdKeTg2NkdjSU91TnArdTJtZXlYck91ZHZDanNtSWc2SUNMdG1aWHNuYmdnN1l5ZDdKZUY3SjIwNjUyODZyT2dJT3F3Z095Z2xlMldpT3lXdE95YWxDRGlnSlFnN1lhZzdJcWs3WXE0NjUyODY2bTBJT3lWak91Z3BPeWp2T3lFdU95YWxDSXBMbHh1SnlBckNpQWdJQ0FnSUNjdElPdXN1T3Exck91bHZDRHNvSnpzbFlqdGxhQWc2NVdRSU95RW5PdWhuQ0Rzb0pIcXQ3enNuYlFnNjR1azY2VzRJREorTStxd25DNGc2ckNCSU95Z25PeVZpT3lYbENEc21ad2c2cmU0NjZDSDZyS01JT3lOdk91S2xPeW5nQ0RzbmJUc25LRHJwYndnNjdhWjdKMjQ2NHVrTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lDck95YXFleWVrT3F3Z0NEc2xyanF1SW50bFpqc3A0QWc3SldLN0oyQUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN1pxZjdJaVlJT3VUc1NucnBid2c3S2VBN0phMDY0SzBJT3VFbyt5bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN1p1RTdJYU5JT3lhbE95eXJTZ2k2NDJVSU95bnArcXlqQ0lzSUNMcnNvVHRpcnpzbXFuc25MenJvWndpSU91VHNTbnNuYlRycWJRZzdLZUI3S0NFSU95Z25PeVZpT3lkaENEcXQ3Z2c2N0NwN1phbDdKeTg2NkdjSU9xem9PeXprQ0RyaTZUc2k1d2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZJT3E0aU95bmdEb2dKeUFyQ2lBZ0lDQWdJQ2Q3SW5KbGNHeDVJam9nSXV1TWdPMlpsQ0RzblpIcmk3VWc3WldjNjVHUUlPdXN1T3llcFNBbzdaVzA3SnFVN0xLMEtTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0p5WldGemIyNGlPaUFpN0oyMDdKeWdJTzJWbkNEcnJManNucVVpZlYxOVhHNWNiaWNnS3dvZ0lDQWdJQ0FuVyt1TWdPMlpsRjFjYmljZ0t5QjBjbUZ1YzJOeWFYQjBDaUFnSUNBcE93b2dJSDBzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLVHNLZlFvS0x5OGc3WlNFNjZDSTdKNkU2N09FS08yVm1PeWNoQ0R0bElUcm9JanNub1FnNjZ5MjdKMk1LU0RzdHBUc3Nwd2c3WVMwSU9LQWxDRHRsWndnN1ptVTY2bTA3SjJFSU8yVm1PeWNoQ0R0bElUcm9JanNub1FnNjR1bzdKeUU2NkdjSU91Q21PdUlvQ0RyczdUcmdyVHFzNkFzQ2k4dklDb3E3WlNFNjZDSTdKNkU2NmVJNjR1a0lPdVVzT3VobkNvcUlPdU1nT3lWaU95ZGhDRHJzSnZyaXBUcmk2UXVJTzJWbkNEc21wVHNzcTNzbDVBZzY0dWtJT3lMcE95V3RDRHJzN1RyZ3JUcmlwUWc2cktEN0oyMElPMlZ0ZXlMckRvS0x5OGc3WlNFNjZDSTdKNkVJT3lJbU91bmpPMkJ2Q0RzbXBUc3NxM3NuWVFnN0txODZyQ2M2Nm0wSU9xM3VPdW5qTzJCdkNEcmlwRHJvS1RzcDREcXM2QW82ckNCSURWK01URHN0SWdwSU9xMXJPdVBoU0RzZ3F6c21xbnJuNG5yajRRZzZyZTQ2NmVNN1lHOElPdUNtT3F3aE91THBDNEtMeThnWjNKdmRYQnpPaUJiZTI1aGJXVXNJSFJsZUhSek9sdGRmVjBnS08yWmxPdXB0Q0RzbklUaWhwTHNsWVRybnBnZzdJaWNLUzRLWm5WdVkzUnBiMjRnWVhOclIzSnZkWEJ6S0dkeWIzVndjeXdnYlc5a1pXd3NJSEpsY0dGeWMyVXNJRzF2Y21VcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0NpQWdJQ0F2THlEcnNvVHRpcndnN0ppQjdKZXQ3SjJBSUNqcnNvVHRpcndwN0p5ODY2R2NJT3l3amV5V3RDRHJzN1RyZ3Jqcmk2UWc0b0NVSU91eWhPMkt2Q0RyckxqcXRhenJpcFFnNjZ5NDdKNmw3SjIwSU95VmhPdUxpT3VkdkNEcmo1bnNucEVnN0oyMDY2YUU3SjIwNjUyOElPcTNuT3k1bWV5ZHRDRHJpNlRycGJUcmk2UUtJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQW9aM0p2ZFhCeklIeDhJRnRkS1M1dFlYQW9LR2NzSUdrcElEMCtDaUFnSUNBZ0lDZGJKeUFySUNocElDc2dNU2tnS3lBblhTQW5JQ3NnVTNSeWFXNW5LQ2huSUNZbUlHY3VibUZ0WlNrZ2ZId2dLQ2ZxdDdqcm83a25JQ3NnS0drZ0t5QXhLU2twSUNzZ0tHY2dKaVlnWnk1eWIyeGxJRDA5UFNBbjY3S0U3WXE4SnlBL0lDY2dLT3V5aE8yS3ZDa25JRG9nSnljcElDc2dKMXh1SnlBckNpQWdJQ0FnSUNobklDWW1JRUZ5Y21GNUxtbHpRWEp5WVhrb1p5NTBaWGgwY3lrZ1B5Qm5MblJsZUhSeklEb2dXMTBwTG0xaGNDZ29kQ2tnUFQ0Z0p5QWdMU0FuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvVTNSeWFXNW5LSFFnZkh3Z0p5Y3BLU2t1YW05cGJpZ25YRzRuS1FvZ0lDQWdLUzVxYjJsdUtDZGNiaWNwT3dvZ0lDQWdZMjl1YzNRZ2FHRnpRblJ1SUQwZ0tHZHliM1Z3Y3lCOGZDQmJYU2t1YzI5dFpTZ29aeWtnUFQ0Z1p5QW1KaUJuTG5KdmJHVWdQVDA5SUNmcnNvVHRpcnduS1RzS0lDQWdJR052Ym5OMElHdGxlU0E5SUNkbmNtOTFjSE1uSUNzZ0tHZHliM1Z3Y3lCOGZDQmJYU2t1YldGd0tDaG5LU0E5UGlBb1p5QW1KaUJuTG5SbGVIUnpJRDhnWnk1MFpYaDBjeTVxYjJsdUtDY25LU0E2SUNjbktTa3VhbTlwYmlnbkp5azdDaUFnSUNCamIyNXpkQ0JoZEhSbGJYQjBJRDBnS0dGemEyVmtRMjkxYm5RdVoyVjBLR3RsZVNrZ2ZId2dNQ2tnS3lBeE93b2dJQ0FnWVhOclpXUkRiM1Z1ZEM1elpYUW9hMlY1TENCaGRIUmxiWEIwS1RzS0lDQWdJR2xtSUNoaGMydGxaRU52ZFc1MExuTnBlbVVnUGlBeU1EQXBJR0Z6YTJWa1EyOTFiblF1WTJ4bFlYSW9LVHNLSUNBZ0lHTnZibk4wSUdGbllXbHVJRDBnYlc5eVpTQjhmQ0JoZEhSbGJYQjBJRDRnTVFvZ0lDQWdJQ0EvSUNmc25iUWc3Wm1VNjZtMDdKMkFJT3lkdENEc2hManNoWmpzbDVEc2hKd2c3SjIwNjYrNElPdUxwT3VrbU91THBDNGc3SldlN0lTY0lPdUN1Q0RyaklEc2xZanFzN3dnN0phMDdaeVl3cmZxdGF6c29iRHFzSUFnN1ptVjdJdWs3WjZJSU91THBPdWx1Q0RzZzRnZzY0eUE3SldJNjZlTUlPdUN0T3VkdkM1Y2JpY0tJQ0FnSUNBZ09pQW5KenNLSUNBZ0lISmxkSFZ5YmlBb0NpQWdJQ0FnSUdGbllXbHVJQ3NLSUNBZ0lDQWdKK3lkdE91eWlDRHNtcFRzc3Ezc25ZQWdJdTJabE91cHRPeWRoQ0R0bFpqc25JUWc3WlNFNjZDSTdKNkU2N09FNjZHY0lPdUNtT3VJb0NEcmk2VHJrNnpxdUxBaTY0dWtMaURzbFlUcm5wanJpcFFnN1pXY0lPMlpsT3VwdE95ZG1DRHJyTGpxdGF6cnBid2c3WldZN0p5RUlPMlVoT3VnaU95ZWhDanNtSUhzbDYwcElPdUxxT3ljaE91aG5DRHJyTGJzbllBZzZyS0Q3SjIwNjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2NxS3V5WWdleVhyZXVuaU91THBDRHJsTERyb1p3cUtpRHJqSURzbFlqc25ZUWc2NEswNjUyOElPS0FsQ0RzbUlIc2w2M3NuWVFnN0lTYzY2R2NJTzJWcWV5NW1PcXhzT3VDbUNEc2lKenNoSnpycGJ3ZzY3Q1U2cjY0N0tlQUlPdW5pT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0Rxc0lFZzdKaUI3SmV0N0plUUlPdU1nT3lWaUNBeTZyQ2NMaURxdDdnZzdKaUI3SmV0N0oyMElPeVhyT3VmckNEc3BJVHNuYlRycWJRZzY0eUE3SldJNjQrRUlDb3E2ckNaN0oyQUlPeWtoQ0RzaUpncUt1dWhuQ2pzcElUcnNKVHF2NGdnWEZ4dTdKeTg2NkdjSU9xMXJPdTJoQ3dnN0tTRUlPeUluT3lFbkNEc25LRHNwNEFwTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lZZ2V5WHJleWRtQ0RzbDYzdGxhQW83WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZDRHJrN0VwNnJPOElPeWJrT3VzdU95ZG1DRHNvSlhyczdUQ3QreWhzT3F4dENqc2lLdnNucERDdCt1TWdPeURnY0szN0tHdzZyRzBLZXlkZ0NEc25LRHNwNER0bFpqcXM2QXNJT3lYaHV1S2xDRHNvSlhyczdUcnBid2c3S2VBN0phMDY0SzA3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHFzNkRzdWFBZzZyS01JT3lYaHV1S2xDRHNtSUhzbDYzc25iVHJxYlFnNjR5QTdKV0lJREhxc0p6cnA0d2c2NEswNnJHdzY0S1lJT3U1aUNEcnNMRHNsN1Ryb1p3ZzY1R1E3SmEwNjQrRUlPdVFuT3VMcENEaWdKUWc3SmExN0tlQTY2R2NJT3V3bE9xK3VPeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSnkwZzdabVU2Nm0wSU9xNHNPdUtwZXVxaFNqcnM0RHFzcjNDdCsyVnRPeWduQ0RyazdFcDdKMkFJT3EzdU91TWdPdWhuQ0Rya1pUcmk2UXVYRzRuSUNzS0lDQWdJQ0FnS0doaGMwSjBiaUEvSUNjdElDanJzb1R0aXJ3cDdKeTg2NkdjSU8yUm5PeUxuT3VRbkNEc21JSHNsNjNzbllBZ0p5QXJJRUpWVkZSUFRsOVNWVXhGSURvZ0p5Y3BJQ3NLSUNBZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1hDdCt5OWxPdVRuTzJPbk95S3BDRHF1SWpzcDRBNlhHNG5JQ3NLSUNBZ0lDQWdKM3NpWjNKdmRYQnpJam9nVzNzaWJtRnRaU0k2SUNMc21JSHNsNjBnN0oyMDY2YUVLT3llaGV1Z3BlcXp2Q0RyajVuc25id3BJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyaklEc2xZZ2c2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0p5WldGemIyNGlPaUFpN0oyMDdKeWdJTzJWbkNEcnJManNucVVpZlYxOVhYMWNiaWNnS3dvZ0lDQWdJQ0FuN0ppQjdKZXQ3SjJBSU95ZWhldWdwU0RzaUp6c2hKekN0K3F3bk95SW1PdWx2Q0RxdDdqcmpJRHJvWndnN0tlQTdZS282NHVrTGx4dVhHNG5JQ3NLSUNBZ0lDQWdKMXZzbUlIc2w2M3JzNFFnNjZ5NDZyV3NYVnh1SnlBcklHeHBjM1FLSUNBZ0lDazdDaUFnZlN3Z2JXOWtaV3dzSUhKbGNHRnljMlVwT3dwOUNnb3ZMeUR0bElUcm9JanNub1RyczRRZzdMYVU3TEtjSU95ZGtldUx0ZXlYa095RW5DQmJlMjVoYldVc0lITjFaMmRsYzNScGIyNXpPbHQ3ZEdWNGRDd2djbVZoYzI5dWZWMTlYU0RzdHBUc3Rwd0tablZ1WTNScGIyNGdjR0Z5YzJWSGNtOTFjSE1vY21GM0tTQjdDaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXg3VzF4elhGTmRLbHg5THlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnZJRDBnU2xOUFRpNXdZWEp6WlNoektUc0tJQ0FnSUdOdmJuTjBJR0Z5Y2lBOUlFRnljbUY1TG1selFYSnlZWGtvYnlBbUppQnZMbWR5YjNWd2N5a2dQeUJ2TG1keWIzVndjeUE2SUZ0ZE93b2dJQ0FnWTI5dWMzUWdaM0p2ZFhCeklEMGdZWEp5TG0xaGNDZ29aeWtnUFQ0Z0tIc0tJQ0FnSUNBZ2JtRnRaVG9nVTNSeWFXNW5LQ2huSUNZbUlHY3VibUZ0WlNrZ2ZId2dKeWNwTG5SeWFXMG9LU3dLSUNBZ0lDQWdjM1ZuWjJWemRHbHZibk02SUVGeWNtRjVMbWx6UVhKeVlYa29aeUFtSmlCbkxuTjFaMmRsYzNScGIyNXpLUW9nSUNBZ0lDQWdJRDhnWnk1emRXZG5aWE4wYVc5dWN3b2dJQ0FnSUNBZ0lDQWdJQ0F1YldGd0tDaDRLU0E5UGlBb2RIbHdaVzltSUhnZ1BUMDlJQ2R6ZEhKcGJtY25DaUFnSUNBZ0lDQWdJQ0FnSUNBZ1B5QjdJSFJsZUhRNklIZ3VkSEpwYlNncExDQnlaV0Z6YjI0NklDY25JSDBLSUNBZ0lDQWdJQ0FnSUNBZ0lDQTZJSHNnZEdWNGREb2dVM1J5YVc1bktDaDRJQ1ltSUhndWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd2djbVZoYzI5dU9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmU2twQ2lBZ0lDQWdJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tIZ3BJRDArSUhndWRHVjRkQ2tLSUNBZ0lDQWdJQ0E2SUZ0ZExBb2dJQ0FnZlNrcE93b2dJQ0FnTHk4ZzdKMjA2NmFFN0tHdzdMQ29JT3lYaHVxem9DRHNvSnpzbFlqcmo0UWc3SmVHNjRxVUlPcTdqZXVOc09xNHNPdW5qQ0RzbVpUc25MenJxYlFnN1ppVjdJdWRJT3lkdE8yRGlPdWhuQ0Ryczdqcmk2UW82ckNaN0oyQUlPeUV1T3lGbU95WGtDRHNucXpzbXBUc3NxMHBDaUFnSUNCeVpYUjFjbTRnWjNKdmRYQnpMbk52YldVb0tHY3BJRDArSUdjdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0tTQS9JR2R5YjNWd2N5QTZJRzUxYkd3N0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzS0lDQWdJSEpsZEhWeWJpQnVkV3hzT3dvZ0lIMEtmUW9LTHk4ZzdZeWQ3SmVGSU95RXVPMkt1Q0RzdHBUc3Nwd2c3WVMwSU9LQWxDRHRsWndnN1l5ZDdKZUY3SjJZSU9xMXJPeUVzZXlhbE95R2pDanNsNjN0bGFBcjY2eTQ2cldzS2V1bHZDRHRsWndnNjdLSTdKZVFJT3V6dE91Q3RPcXpvQ3dLTHk4ZzdKcVU3SWFNNjdPRUlPdUNzZXF3bk9xd2dDRHNsWVRyaTRqcm5id2dLaXJzbVlUc2hMSHJrSndnN1l5ZDdKZUZJT3lFdU8yS3VDanN2SURzbmJUc2lxUXBJREorTStxd25Db3E2Nlc4SU8yR3RleWN2T3VobkNEcnNKdnJpcFRyaTZRdUNpOHZJTzJEZ095ZHRPMkxnTUszN0pXSTY0SzB3cmZyc29UdGlyenNuYlFnN1pXY0lPdXF1T3ljdk91aG5DRHNuYnpxdElEcmo3enNsYndnN1pXWTY2K0E2NkdjS091VXNPdWhuQ0RydlpIc2xZUWc3S0d3N1pXcDdaV1k2Nm0wSU95V3RPcTRpK3VDbk91THBDa2c3SVM0N1lxNElPdUxxT3ljaE91aG5DRHNvSnpzbFlqdGxaanFzb3dnN1pXYzY0dWtMZ292THlCbGJHVnRaVzUwY3pvZ1czdHliMnhsTENCMFpYaDBmVjBnS08yWmxPdXB0Q0RzbklUaWhwTHNsWVRybnBnZzdJaWNLUzRLTHk4Z2JXOXlaVDEwY25WbEtGdnN2SURzbmJUc2lxUWc2NDJVSU91d20rcTRzRjBwNjZtMElPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA2Nis0SU91Q3VDRHNoTGp0aXJqc21ZQWc2cks1N0xtWTdLZUFJT3lWaXV1S2xDRHNnNGdnN0lTNDdZcTQ2Nlc4SU95YWxPcTFyTzJWbk91THBDNEtablZ1WTNScGIyNGdZWE5yVUc5d2RYQW9aV3hsYldWdWRITXNJRzF2WkdWc0xDQnlaWEJoY25ObExDQnRiM0psS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ2NtOXNaWE1nUFNBb1pXeGxiV1Z1ZEhNZ2ZId2dXMTBwTG0xaGNDZ29aU2tnUFQ0Z1UzUnlhVzVuS0NobElDWW1JR1V1Y205c1pTa2dmSHdnSnljcEtTNXFiMmx1S0Njc0lDY3BPd29nSUNBZ1kyOXVjM1FnYkdsemRDQTlJQ2hsYkdWdFpXNTBjeUI4ZkNCYlhTa3ViV0Z3S0NobExDQnBLU0E5UGdvZ0lDQWdJQ0FvYVNBcklERXBJQ3NnSnk0Z1d5Y2dLeUJUZEhKcGJtY29LR1VnSmlZZ1pTNXliMnhsS1NCOGZDQW5KeWtnS3lBblhTQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29VM1J5YVc1bktDaGxJQ1ltSUdVdWRHVjRkQ2tnZkh3Z0p5Y3BLUW9nSUNBZ0tTNXFiMmx1S0NkY2JpY3BPd29nSUNBZ0x5OGc2ckNaN0oyQUlPMk1uZXlYaGV5ZGhDRHJxb2NnNjdLSTdLZTRJT3VzdSt1S2xPeW5nQ0RxdUxEc2xyVWc0b0NVSU95ZXJPeWFsT3l5cmV5ZHRPdXB0Q0FpN0oyMDdLQ0U2ck84SU91THBPdWx1Q0RzaExqdGlyZ2k2Nlc4SU95YWxPcTFyTzJWbk91THBBb2dJQ0FnTHk4Z0tHRnphME5zWVhWa1pleVpnQ0Rxc0puc25ZQWc3SjIwN0p5Z09pRHNsWWdnNnJlNDY1K3M2Nm0wSU8yQnRPdWhuT3VUbk9xd2dDRHFzSm5zbllBZzdJUzQ3WXE0NjZXOElPdVlrQ0RyZ3JUc2hKd2dXK3k4Z095ZHRPeUtwQ0RyalpRZzY3Q2I2cml3WGVxd2dDRHJyTFRzblpqcnI3anRsYlRzcDRUcmk2UXBDaUFnSUNCamIyNXpkQ0JyWlhrZ1BTQW5jRzl3ZFhBQkp5QXJJQ2hsYkdWdFpXNTBjeUI4ZkNCYlhTa3ViV0Z3S0NobEtTQTlQaUJUZEhKcGJtY29LR1VnSmlZZ1pTNTBaWGgwS1NCOGZDQW5KeWtwTG1wdmFXNG9Kd0VuS1RzS0lDQWdJR052Ym5OMElHRjBkR1Z0Y0hRZ1BTQW9ZWE5yWldSRGIzVnVkQzVuWlhRb2EyVjVLU0I4ZkNBd0tTQXJJREU3Q2lBZ0lDQmhjMnRsWkVOdmRXNTBMbk5sZENoclpYa3NJR0YwZEdWdGNIUXBPd29nSUNBZ2FXWWdLR0Z6YTJWa1EyOTFiblF1YzJsNlpTQStJREl3TUNrZ1lYTnJaV1JEYjNWdWRDNWpiR1ZoY2lncE95QXZMeURyckxUdGxaenRub2dnN0l5VDdKMjA3S2VBSU95Vml1cXlqQW9nSUNBZ1kyOXVjM1FnWVdkaGFXNGdQU0J0YjNKbElIeDhJR0YwZEdWdGNIUWdQaUF4Q2lBZ0lDQWdJRDhnSit5ZHRDRHRqSjNzbDRYc25ZQWc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRycjdnZzY0dWs2NlNZNjR1a0xpRHNsWjdzaEp3ZzdLQ2M3SldJN1pXY0lPeUV1TzJLdU91VHBPcXp2Q0FxS3V5Z2tlcTN2TUszN0phMDdaeVk2ckNBSU8yWmxleUxwTzJlaUNEcmk2VHJwYmdnN0lPSUlPeUV1TzJLdUNvcTY2ZU1JT3VDdE91ZHZDanFzSm5zbllBZzdJUzQ3WXE0SU91d21PdXp0U0RxdUlqc3A0QXBMbHh1SndvZ0lDQWdJQ0E2SUNjbk93b2dJQ0FnY21WMGRYSnVJQ2dLSUNBZ0lDQWdZV2RoYVc0Z0t3b2dJQ0FnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTdZeWQ3SmVGS091THBPeWR0T3lXdk91aG5PcTN1Q2tnN0lTNDdZcTRJT3VMcE91VHJPcTRzQ0xyaTZRdUlPeVZoT3VlbU91S2xDRHRsWndnN1l5ZDdKZUY3SjJFSU95Y2hPS0drdXlWaE91ZW1PdWhuQ0RyZ3Bqc2w3VHRsWndnNnJXczdJU3g3SnFVN0lhTTY1T2s3SjIwNjR1a0tPeUVuT3VobkNEcnJMVHF0SUR0bFp3ZzY3T0U2ckNjSU91c3VPcTFyT3F3Z0NEc2xZVHJpNGpyaTZRcExpQW5JQ3NLSUNBZ0lDQWdKK3lhbE95R2pPdWx2Q0RyZ3JIcXNKenJvWndnNnJPZzdMbVk3S2VBSU91bmtPcXpvQ3dnS2lydGc0RHNuYlR0aTREQ3QreVZpT3VDdE1LMzY3S0U3WXE4N0oyMElPeUVuT3VobkNEc25ienF0SURya0p3Z0l1eVpoT3lFc2V1UW5DRHRqSjNzbDRVZzdJUzQ3WXE0SWlBeWZqUHFzSndxS3V1bHZDRHNvSnpzbFlqdGxaanJuYnd1SU9xd2dTRHNoTGp0aXJqcmlwUWc3SVNjNjZHY0lPdUxwT3VsdUNEc29KSHF0N3pzbmJUc2xyVHNsYndnN1pXYzY0dWtMbHh1SnlBckNpQWdJQ0FnSUNmcXNJRWc3SVM0N1lxNDY0cVVJT3llaGV1Z3BlcXp2Q0FxS3Vxd21leWRnQ0RzbDYzdGxhREN0K3F3bWV5ZGdDRHFzSnpzaUpqQ3QrcXdtZXlkZ0NEc2lKenNoSndxS3V5ZG1DRHNtcFRzaG96cnBid2c2NnFvNjVHUUlPMlByTzJWcU8yVm5PdUxwQzRnN0lTNDdZcTRJT3lWaU95WGtPeUVuQ0R0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcTg3SjJBSU8yVm5DRHJxcmpzbkx6cm9ad2c2NmVlN0pXRTY1YW83SmEwN0tDNDdKVzhJTzJWbk91THBDanNtSWc2SU91enVPdXN1T3lkdENBaWZ1MlZvT3E1ak95YWxEOGk2Nm0wSU91eWhPMkt2T3lkZ0NCYjdKV0U2NHVJN0ppa1hTOWI2NFNrWFNrdVhHNG5JQ3NLSUNBZ0lDQWdKMXZ0akozc2w0VWc2Nnk0N0xLMElPcTNuT3k1bVNEaWdKUWc3SnlFSU95S3BPMkRnT3lkdkNEcXNJRHNuYlRyazV6c25aZ2dJamd1SU8yTW5leVhoU0lnN0lTNTdJV1k3SjJFSU91VXNPdWx1T3VMcEYxY2JpY2dLd29nSUNBZ0lDQW5MU0R0ZzREc25iVHRpNEE2SU95bnAreWRnQ0RycW9Yc2dxenF0YXdvTW40MDdKYTA3S0NJS1N3ZzdLS0Y2ckt3N0phMDY2KzR3cmZycDRqc3VhanRrWndnN0plRzdKMjBLSDdzbXBRdmZ1dUxwQzkrNnJtTTdKcVVQeURxdUlqc3A0QXBMaURyc0pqcms1enNpNXdnN0pXSTY0SzBLT3V6dU91c3VDa2c2NmVsNjUyOTdKMkVJT3lhbE95VnZlMlZ0Q0R0ZzREc25iVHRpNERycDR3ZzY3U1E2NCtFSU91c3RPeUtxQ0R0akozc2w0WHNuYmpzcDRBZzdKV002cktNSU8yVm1PdWR2QzRnN0p1UTY3TzQ3SjIwSUNMc2xZenJwcnd2N1ptVjdKMjRJdXl5bU91ZnZDRHJwNG5zbDdEdGxaanJxYlFnNjdPNDY2eTQ3SjJFSU9xM3ZPcXhzT3VobkNEcXRhenNzclR0bVpUdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc3SldJNjRLMEtPdXp1T3VzdUNrNklPMlZ0T3lhbE95eXRDNGc3WXlRNjR1bzdKMjBJTzJWaE95YWxPMlZtT3VwdENBaWZ1MlZvT3E1ak95YWxEOGk2NkdjSU91c3UrcXpvQ3dnNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzdKeUU3WmVZS095Q3JleWduTUszN1lPSTdZZTBJT3VUc1Nuc25ZQWc2ckt3NnJPODY2VzhJT3Vvdk95Z2dDRHFzcjNxczZEdGxaenJpNlF1SU9xeXNPcXp2TUszN0lPQjdZT2NJTzJHdGV1enRPdXB0Q0RzaEp6c2lLRHRtSlhzbkx6cm9ad2c3SldNNjZhdzY0dWtMbHh1SnlBckNpQWdJQ0FnSUNjdElPdXloTzJLdkRvZzY3TzQ2Nnk0N0oyMElDSis3WldnNnJtTTdKcVVQeUxycWJRZ1creVZoT3VMaU95WXBGMHZXK3VFcEYwc0lPdXp1T3VzdU95ZHRDRHNnNEh0bWFuc25ZUWc3SVNjN0lpZzdaV1k2ck9nSU95ZHRDRHJzb1R0aXJ6c25iUWc3SXVrN0tDY0lPdVBtZXlla2V5ZHRPdXB0Q0RyajVuc25wRWc2NCtaN0lLc0tPeUNyZXlnbkMvc29JRHNucVV2N0pldzZyS3dJTzJWdE95Z25DRHJrN0VwTENEdGhyWHJzN1FnN1l5ZDdKZUY3SjJZSU91THFPeWR2Q0Ryc29UdGlyenNuYlRycWJRZ0l1MlpsZXlkdUNJdUlDTHN0NmpzaG93aTY0cVVJT3VQbWV5ZWtTRHJzb1R0aXJ6cXM3d2c3S2VkN0oyOElPdVZqT3VuakN3Z0l1dUxxK3E0c01LMzY0K1o3SjZSSWlEc29iRHRsYWtnNnJpSTdLZUFMaUR0bVpUcnFiUWc2cml3NjRxbDY2cUZLT3V6Z09xeXZjSzM3WlcwN0tDY0lPdVRzU25zbllBZzZyZTQ2NHlBNjZHY0lPdVJsT3VMcEM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RzbTVEcnJManNuWmdnN0tDVjY3TzB3cmZzb2JEcXNiUW83SWlyN0o2UXdyZnNuYlRzZzRFdjdKMjA3WldZd3JmcmpJRHNnNEVwN0oyQUlPeWNvT3luZ08yVm1PcXpvQ3dnN0p1UTY2eTQ3SmVRSU95WGh1dUtsQ0Rzb0pYcnM3VEN0K3lnaU95d3FNSzM3SmV3NjUyOTdMS1k2Nlc4SU95bmdPeVd0T3VDdE95bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1hDdCt5OWxPdVRuTzJPbk95S3BDRHF1SWpzcDRBNlhHNG5JQ3NLSUNBZ0lDQWdKM3NpYzJWMGN5STZJRnQ3SW5KbFlYTnZiaUk2SUNMc25iUWc3SVM0N1lxNDdKMllJT3V3cWUyV3BleWRoQ0R0bFp6cXRhM3NsclFnN1pXY0lPdXN1T3llcGV5Y3ZPdWhuQ0lzSUNKbGJHVnRaVzUwY3lJNklGdDdJbkp2YkdVaU9pQWk3SmV0N1pXZ0lpd2dJblJsZUhRaU9pQWk2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSjlMQ0F1TGk1ZGZTd2dMaTR1WFgxY2JpY2dLd29nSUNBZ0lDQW43SmV0N1pXZzdKMkFJT3llaGV1Z3BTRHNpSnpzaEp6cmpJRHJvWnc2SUNjZ0t5QnliMnhsY3lBcklDZGNibHh1SnlBckNpQWdJQ0FnSUNkYjdZeWQ3SmVGSU95YWxPeUdqRjFjYmljZ0t5QnNhWE4wQ2lBZ0lDQXBPd29nSUgwc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzS2ZRb0tMeThnN1l5ZDdKZUZJT3lka2V1THRleVhrT3lFbkNCN2MyVjBjem9nVzN0eVpXRnpiMjRzSUdWc1pXMWxiblJ6T2x0N2NtOXNaU3gwWlhoMGZWMTlYWDBnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpWQnZjSFZ3S0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdieUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCamIyNXpkQ0J6WlhSelNXNGdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHOGdKaVlnYnk1elpYUnpLU0EvSUc4dWMyVjBjeUE2SUZ0ZE93b2dJQ0FnWTI5dWMzUWdjMlYwY3lBOUlITmxkSE5KYmdvZ0lDQWdJQ0F1YldGd0tDaHpkQ2tnUFQ0Z0tIc0tJQ0FnSUNBZ0lDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2MzUWdKaVlnYzNRdWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQW9nSUNBZ0lDQWdJR1ZzWlcxbGJuUnpPaUJCY25KaGVTNXBjMEZ5Y21GNUtITjBJQ1ltSUhOMExtVnNaVzFsYm5SektRb2dJQ0FnSUNBZ0lDQWdQeUJ6ZEM1bGJHVnRaVzUwY3dvZ0lDQWdJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tHVnNLU0E5UGlBb2V5QnliMnhsT2lCVGRISnBibWNvS0dWc0lDWW1JR1ZzTG5KdmJHVXBJSHg4SUNjbktTNTBjbWx0S0Nrc0lIUmxlSFE2SUZOMGNtbHVaeWdvWld3Z0ppWWdaV3d1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa0tJQ0FnSUNBZ0lDQWdJQ0FnSUNBdVptbHNkR1Z5S0NobGJDa2dQVDRnWld3dWRHVjRkQ2tLSUNBZ0lDQWdJQ0FnSURvZ1cxMHNDaUFnSUNBZ0lIMHBLUW9nSUNBZ0lDQXVabWxzZEdWeUtDaHpkQ2tnUFQ0Z2MzUXVaV3hsYldWdWRITXViR1Z1WjNSb0tUc0tJQ0FnSUhKbGRIVnliaUJ6WlhSekxteGxibWQwYUNBL0lITmxkSE1nT2lCdWRXeHNPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdDaUFnSUNCeVpYUjFjbTRnYm5Wc2JEc0tJQ0I5Q24wS0NpOHZJT3VNZ08yWmxPMllsU0Rzb0p6c25wRWc3SjJSNjR1MTdKZVE3SVNjSUh0eVpYQnNlU3dnYzNWbloyVnpkR2x2Ym5OYlhYMGc3TGFVN0xhY0lDanN2WlRyazV6dGpwenNpcVRDdCt5Vm51dVNwQ0RzbnFIcmk3UWc3WmVJN0pxcEtRcG1kVzVqZEdsdmJpQndZWEp6WlVOdmJYQnZjMlVvY21GM0tTQjdDaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXg3VzF4elhGTmRLbHg5THlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnZJRDBnU2xOUFRpNXdZWEp6WlNoektUc0tJQ0FnSUdOdmJuTjBJSEpsY0d4NUlEMGdVM1J5YVc1bktDaHZJQ1ltSUc4dWNtVndiSGtwSUh4OElDY25LUzUwY21sdEtDazdDaUFnSUNCamIyNXpkQ0J6ZFdkblpYTjBhVzl1Y3lBOUlFRnljbUY1TG1selFYSnlZWGtvYnlBbUppQnZMbk4xWjJkbGMzUnBiMjV6S1FvZ0lDQWdJQ0EvSUc4dWMzVm5aMlZ6ZEdsdmJuTUtJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tIZ3BJRDArSUNoN0lIUmxlSFE2SUZOMGNtbHVaeWdvZUNBbUppQjRMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tzSUhKbFlYTnZiam9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VjbVZoYzI5dUtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwcEtRb2dJQ0FnSUNBZ0lDQWdMbVpwYkhSbGNpZ29lQ2tnUFQ0Z2VDNTBaWGgwS1FvZ0lDQWdJQ0E2SUZ0ZE93b2dJQ0FnYVdZZ0tISmxjR3g1SUh4OElITjFaMmRsYzNScGIyNXpMbXhsYm1kMGFDa2djbVYwZFhKdUlIc2djbVZ3Ykhrc0lITjFaMmRsYzNScGIyNXpJSDA3Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzdKV0U2NTZZNjZHY0lDb3ZJSDBLSUNCeVpYUjFjbTRnYm5Wc2JEc0tmUW9LTHk4ZzY3S0k3SmV0SU95ZGtldUx0ZXlYa095RW5DQjdkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1ZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxWSEpoYm5Oc1lYUmxLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQjBjbUZ1YzJ4aGRHVmtJRDBnVTNSeWFXNW5LQ2h2SUNZbUlHOHVkSEpoYm5Oc1lYUmxaQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tUc0tJQ0FnSUdsbUlDaDBjbUZ1YzJ4aGRHVmtLU0J5WlhSMWNtNGdleUIwY21GdWMyeGhkR1ZrTENCa2FYSmxZM1JwYjI0NklGTjBjbWx1Wnlnb2J5QW1KaUJ2TG1ScGNtVmpkR2x2YmlrZ2ZId2dKeWNwTG5SeWFXMG9LU0I5T3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUc1MWJHdzdDbjBLQ2k4dklPeWRrZXVMdGV5WGtPeUVuQ0I3ZEdWNGRDd2djbVZoYzI5dWZTRHJzTERzbDdRZzdMYVU3TGFjSUNqc3ZaVHJrNXp0anB6c2lxVEN0K3lWbnV1U3BDRHNucUhyaTdRZzdaZUk3SnFwS1FwbWRXNWpkR2x2YmlCd1lYSnpaVk4xWjJkbGMzUnBiMjV6S0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljVzF0Y2MxeFRYU3BjWFM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdZWEp5SUQwZ1NsTlBUaTV3WVhKelpTaHpLVHNLSUNBZ0lHbG1JQ2hCY25KaGVTNXBjMEZ5Y21GNUtHRnljaWtwSUhzS0lDQWdJQ0FnY21WMGRYSnVJR0Z5Y2dvZ0lDQWdJQ0FnSUM1dFlYQW9LSGdwSUQwK0lDaDdJSFJsZUhRNklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5SbGVIUXBJSHg4SUNjbktTNTBjbWx0S0Nrc0lISmxZWE52YmpvZ1UzUnlhVzVuS0NoNElDWW1JSGd1Y21WaGMyOXVLU0I4ZkNBbkp5a3VkSEpwYlNncElIMHBLUW9nSUNBZ0lDQWdJQzVtYVd4MFpYSW9LSGdwSUQwK0lIZ3VkR1Y0ZENrN0NpQWdJQ0I5Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzdKV0U2NTZZNjZHY0lDb3ZJSDBLSUNCeVpYUjFjbTRnVzEwN0NuMEtDaTh2SU91aG5PcTN1T3lkdUNEdGxZVHNtcFRDdCsyVm5PdVBoQ0RzdElqcXM3d2c3SU9CN1lPYzdKMjhJT3VWakNBdmFHVmhiSFJvSU95aHNPMmFqT3F3Z0NEc21LVHJxYlFnNjVLazdKZVE3SVNjSU95YmpPdXdqZXlYaGV5ZGhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMDY3TzQ2NHVrSUNnek1PeTBpT3lYa0NBeDY3S0k2NmVNS1M0S0x5OGc3SVN4NnJPMTdaV1k2Nm0wSU9xeXNPcXp2Q0R0bGJqcms2VHJuNnpxc0lBZ1kyeGhkV1JsVTNSaGRIVnpQU2R2YXlmcm9ad2c2NUNZNjQrTTY2YXM2NitBNjZHY0xDRHNucXpyb1p6cXQ3anNuYmdnN1p1RUlPdXloTzJLdk95ZHRDRHNvSURzb0lqcm9ad2c4Sitmb3V5Y3ZPdWhuQ0RyczdYcXQ0RHRsWnpyaTZRdUNpOHZJQ2p0bEl6cm42enF0N2pzbmJqc25iUWc2NkdjNnJlNDdKMjRJT3l3dmV5ZGhDRHNsN0FnNjVLa0lPeWp2T3E0c095Z2dleWN2T3VobkNBdmFHVmhiSFJvNjZXOElPeWhzTzJhak8yVm1PdUtsQ0Rxc29QcXM3d2c3S2VkN0oyRUlPeWR0T3Vqck91THBDa0tMeThnN1pXYzY0K0VJT3kwaU9xenZPdVBoQ0Rxc0puc25ZQWc2cks5NjZHYzY2R2NJT3V6dGVxM2dPeUxuTzJDcU91THBDRGlnSlFnNnJTQTY2YXM3SjZRNnJDQUlPMlZuT3VQaE91bHZDRHNtS3pyb0tUc283enFzYkRyZ3BnZzdaV2M2NCtFNnJDQUlPeTBpT3E0c08yWmxPdVFtT3VwdEFvdkx5RHNncXpzbXFuc25wRHFzSUFnN0pXRTY2eTA2cktENjQrRUlPeVZpQ0RyaUl6cm42enJqNFFnNjdLRTdZcTg3SjIwSVBDZm42THNuTHpyb1p3ZzY0K003SldFN0ppbzY0dWtMaUR0bFp6cmo0VHNsNUFnNnJHNDY2YXdJTzJZdU95Mm5PeWRnQ0Rxc2JEc29JanJrSmpycjREcm9ad2c3SUtzN0pxcDY1K0o3SjJBSU95VmlDRHJncGpxc0lUcmk2UUtMeThnNnJPRTdLQ1Y3SjIwSUNvcTY3Q1c3SmVRN0lTY0tpb2c2N0NVNjRDUUlPcXlnK3lkaENEc2xZenNsWVRzc1lqcmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVEkyS1M0S0x5OGc3WVN3NjYrNDY0U1E3SjIwNjRLWUlPdTRqT3Vkdk95YXNPeWdnT3lYa095RW5DRHJpNlRycGJnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJWbU91cHRDRHNucERxc3Fuc3BwM3Jxb1VnN1l5TTdKMjg3SjJBSU91d2xPdUFqT3luZ091bmpDd2c3SjIwNjYrNElPdVdvQ0Rzbm9qcmlwUWdZMnhoZFdSbENpOHZJT3lFdU95Rm1PeWRnQ0RzaTV6cmo1bnRsYUFnNjVXTUlPdXdtK3lkZ0NEc21Kc2c2ck9FN0tDVklPeWVoZXllcGVxMmpPeWRoQ0RxdDdqcmpJRHJvWndnN0pPMDY0dWtJT0tHa2lEc2c0Z2c2ck9FN0tDVjdKZVFJT3lDck95YXFldWZpZXlkdENEcmdxanNsWVFnN0o2STdKYTA2NCtFSUNMdGxaenJqNFFnN0xTSTZyTzhJdXF3Z0Fvdkx5RHFzNFRzaG8wZzY0S1k3SmlvNjR1a0tESXdNall0TURnZzdJdWs3TGloSU95TG9PcXpvRG9nSXV5RGlDRHFzNFRzb0pYc25MenJvWndnNjZHYzZyZTQ3SjI0N1phSTY0cVU2NDJ3SU95Wm5DRHF0N2dnNnJPRTdLQ1ZJT3lDck95YXFldWZpZXlkaENEcnFyc2c3Sk93NjRPUUlpa3VDaTh2SU8yVWpPdWZyT3EzdU95ZHVPeWRoQ0Rxc2JEc3Vad2c2NkdjNnJlNDdKMjR3cmZyb1p6cXQ3anNsWVRzbTRNb0wyOXdaVzR0Ykc5bmFXN0N0eTlqYkdGMVpHVXRiRzluYjNWMEtleWRnQ0JyYVd4c1VISnZZK3ljdk91aG5DRHNoTGpzaFpqc25ZUWc2N0tFNjZDazdJU2NJT3lkdENEcnJManNvSnpxc0lBS0x5OGc3SmVHN0plSTY0cVU2NDJ3TENEcnNKYnNsNURzaEp3ZzY3Q1U2cjY0NjZtMElPdUxwT3Vtck9xd2dDRHNsWXdnNjdDcDY3S1Y3SjIwSU95WGh1eVhpT3VMcEM0ZzZyZTQ2NTZZN0lTY0lDOW9aV0ZzZEdnZzdLR3c3WnFNNjZlSTY0dWtJTzJNak95ZHZPeWRtQ0RxczRUc29KWHFzN3dnNjdtRTZyV1E3WldjNjR1a0xnb3ZMeURydVlUc21xa2dNQ2p0akl6c25ienJwNHdnN0oyOTZyT2dMQ0JqYkdGMVpHVkJZMk52ZFc1MDdKMllJRE13N0xTSUlPeTZrT3lMbk91bHZDRHF0N2pyaklEcm9ad2c3Sk8wNjR1a0lPS0FsQ0F1WTJ4aGRXUmxMbXB6YjI3c25iUWc3THVrN0lTY0lPdW5wT3V5aUNEc25iM3NwNEFnN0pXSzY0cVU2NHVrS1M0S0x5OGc2ck9FN0tDVklPeWVpT3lkakNEaWhwSWc3SmVHN0oyTUtPdWhuT3EzdU95VmhPeWJneWtnNjdDcDdaYWw3SjJBSU9xeHRPdVRuT3Vtck95bmdDRHNsWXJyaXBUcmk2UTZJTzJNak95ZHZPeWRoQ0RyamE3c2xyVHNrN0RyaXBRZzdJaWM2ckNFSU95ZW9PcTVrQ0RycXJzZzdKMjk2NHFVSU9xeWcrcXp2QW92THlEcXRhenJ0b1Rya0pqc3A0QWc3SldLN0pXRUlPMlhteURzbnF6c2k1enNucEhzbllRZzY3YUE2NlcwNnJPZ0xDRHF0N2dnNjdDcDdaYWw3SjJBSU95ZHVPeW1uU0RzbUtUcnBaZ2c2cks5NjZHY0tHbHpRWFYwYUVWeWNtOXlLZXF3Z0NEc25iVHJyN2dnN0xLWTY2YXM3WldjNjR1a0xncG1kVzVqZEdsdmJpQnlaWE4wWVhKMFNXWkJZMk52ZFc1MFEyaGhibWRsWkNncElIc0tJQ0JwWmlBb0lYQnliMk1nZkh3Z2QyRnBkR1Z5S1NCeVpYUjFjbTQ3SUNBZ0lDQWdJQ0FnTHk4ZzdJUzQ3SVdZSU95WGh1eWRqQ2pyaTZUc25Zd2c3WVMwN0oyMElPeURpT3VobkNEc2k1enJqNWtwSUM4ZzdZUzBJT3luaE8yV2lTRHNwSkhzbmJUcnFiUWc2NHVrN0oyTUlPeWhzTzJhak95WGtPeUVuQW9nSUdOdmJuTjBJRzV2ZHlBOUlHTnNZWFZrWlVGalkyOTFiblFvS1RzS0lDQnBaaUFvSVc1dmR5QjhmQ0J1YjNjZ1BUMDlJSE5sYzNOcGIyNUJZMk52ZFc1MEtTQnlaWFIxY200N0NpQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU9xemhPeWdsZXlkdENEcnNKVHJnSXpzbDRqc2xyVHNtcFFnS0NjZ0t5QW9jMlZ6YzJsdmJrRmpZMjkxYm5RZ2ZId2dKK3lYaHV5ZGpDY3BJQ3NnSnlEaWhwSWdKeUFySUc1dmR5QXJJQ2NwSU9LQWxDRHNtSnNnNnJPRTdLQ1ZJT3lFdU95Rm1PeWRoQ0Ryc29UcnBxenFzNkFnN0lPSUlPcXpoT3lnbGV5Y3ZPdWhuQ0RyaTZUc2k1d2c3SXVjN0o2UjdaV3A2NHVJNjR1a0xpY3BPd29nSUM4dklPeWRtT3VQaE95Z2dTRHNvb1hybzR3b2NtVmhjMjl1SU95bmdPeWdsU2tnNG9DVUlGTkZVMU5KVDA1ZlJFbEZST3VobkNEcmdaM3JnclRycWJRZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE9xd2dDRHNtSnNnNnJPRTdLQ1ZJT3lFdU95Rm1PeWRoQ0Rya0pqc2dyVHJwckRyaTZRS0lDQnJhV3hzVUhKdll5Z242ck9FN0tDVjdKMjBJT3V3bE91QWpPeVd0T3lFbkNEc2hManNoWmpzbllRZzdJT0k2NkdjSU95TG5PeWVrZTJXaU95V3RPeWFsQ0RpZ0pRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUp5azdDaUFnWTJ4aGRXUmxVM1JoZEhWeklEMGdiblZzYkRzZ0x5OGc3WldjNjQrRXdyZnJvWnpxdDdqc25iZ2c3SU9CN1lPYzY0cVVJT3F6aE95Z2xldW5pT3VMcENEcmk2VHJwYlRyaTZRZzRvQ1VJT3lEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NHVrN0l1Y0lPMk1rT3lnbGUyVm1PcXlqQW9nSUhObGMzTnBiMjVCWTJOdmRXNTBJRDBnYm05M093cDlDZ3BzWlhRZ2JHRnpkRUYxZEdoU1pYUnllVUYwSUQwZ01Ec0tablZ1WTNScGIyNGdjbVYwY25sQmRYUm9TV1pPWldWa1pXUW9LU0I3Q2lBZ2FXWWdLR05zWVhWa1pWTjBZWFIxY3lBaFBUMGdKMk5zWVhWa1pTMXNiMmR2ZFhRbklDWW1JR05zWVhWa1pWTjBZWFIxY3lBaFBUMGdKMk5zWVhWa1pTMXNhVzFwZENjcElISmxkSFZ5YmpzS0lDQnBaaUFvZDJGcGRHVnlJSHg4SUVSaGRHVXVibTkzS0NrZ0xTQnNZWE4wUVhWMGFGSmxkSEo1UVhRZ1BDQXpNREF3TUNrZ2NtVjBkWEp1T3lBdkx5RHNwNFR0bG9rZzdLU1JJTzJFdENEcnNLbnRsYlFnNnJpSTdLZUFJQ3NnTXpEc3RJZ2c2ckNFNnJLcENpQWdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJT3llck8yWmxleWR1Q0RzaTV6cmo0VGlnS1luS1RzS0lDQnlkVzVVZFhKdUtDZ3BJRDArSUNmcm9aenF0N2pzbmJnZzdabVY3SjI0N0pxcDdKMjA2NHVrTGlBaVQwc2k2NTI4NnJPZzY2ZU1JT3VMdGUyVm1PdWR2QzRuS1M1MGFHVnVLQW9nSUNBZ0tDa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHRtWlhzbmJqcmtLZ2c0b0NVSU95Z2xleURnU0RzZzRIdGc1enJvWndnNjdPMTZyZUFMaWNwTEFvZ0lDQWdLR1VwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbFlUc3A0RWc2NkdjNnJlNDdKMjRJT3lWaUNEcmtLZzZKeXdnVTNSeWFXNW5LR1V1YldWemMyRm5aU2t1YzJ4cFkyVW9NQ3dnT0RBcEtRb2dJQ2s3Q24wS0NpOHZJT3lMcE8yTXFDRHNuWkhyaTdYc25ZUWc3SUtzNjU2TTdKcXBJT3lWaU91Q3RPdWhuQ0RyczREdG1aZ2c0b0NVSU95YmtPeWR1Q2pyb1p6cXQ3anNuYmd2N0lTazdMbVlLZXlkdENEdGpJenNsWVhya0p3ZzZySzk3SnF3N0plVUlPcTN1Q0RzbFlqcmdyVHJwYndzSU95VmhPdUxpT3VwdENEc29KSHJrWkRzbHJRcjdKdVE2Nnk0N0oyRUlPdXp0T3VDdU91THBBcG1kVzVqZEdsdmJpQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lIQnlaV1pwZUNrZ2V3b2dJR2xtSUNobElDWW1JR1V1YldWemMyRm5aU0E5UFQwZ1RFOUhTVTVmUjFWSlJFVXBJSEpsZEhWeWJpQjdJR1Z5Y205eU9pQk1UMGRKVGw5SFZVbEVSU3dnY0hKdllteGxiVG9nSjJOc1lYVmtaUzFzYjJkdmRYUW5JSDA3Q2lBZ2FXWWdLR1VnSmlZZ1pTNXRaWE56WVdkbElEMDlQU0JNU1UxSlZGOUhWVWxFUlNrZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUV4SlRVbFVYMGRWU1VSRkxDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXeHBiV2wwSnlCOU93b2dJR2xtSUNoamJHRjFaR1ZUZEdGMGRYTWdQVDA5SUNkamJHRjFaR1V0YldsemMybHVaeWNwSUhzS0lDQWdJSEpsZEhWeWJpQjdJR1Z5Y205eU9pQW43SjIwSUZCRDdKZVFJRU5zWVhWa1pTQkRiMlJsS0dOc1lYVmtaU25xc0lBZzdJU2s3TG1ZNjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRZzRvQ1VJT3lFcE95NW1PMlZtT3F6b0NEcm9aenF0N2pzbmJqdGxad2c2NUtrSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljc0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1WnljZ2ZUc0tJQ0I5Q2lBZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUhCeVpXWnBlQ0FySUNobElDWW1JR1V1YldWemMyRm5aU0EvSUdVdWJXVnpjMkZuWlNBNklGTjBjbWx1WnlobEtTa2dmVHNLZlFvS1puVnVZM1JwYjI0Z2NtVmhaRUp2Wkhrb2NtVnhLU0I3Q2lBZ2NtVjBkWEp1SUc1bGR5QlFjbTl0YVhObEtDaHlaWE52YkhabEtTQTlQaUI3Q2lBZ0lDQnNaWFFnWW05a2VTQTlJQ2NuT3dvZ0lDQWdjbVZ4TG05dUtDZGtZWFJoSnl3Z0tHTXBJRDArSUhzZ1ltOWtlU0FyUFNCak95QjlLVHNLSUNBZ0lISmxjUzV2YmlnblpXNWtKeXdnS0NrZ1BUNGdld29nSUNBZ0lDQjBjbmtnZXlCeVpYTnZiSFpsS0VwVFQwNHVjR0Z5YzJVb1ltOWtlU2twT3lCOUlHTmhkR05vSUNoZlpTa2dleUJ5WlhOdmJIWmxLSHQ5S1RzZ2ZRb2dJQ0FnZlNrN0NpQWdmU2s3Q24wS0NtTnZibk4wSUVOUFVsTmZTRVZCUkVWU1V5QTlJSHNLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUM0pwWjJsdUp6b2dKeW9uTEFvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFOWlhSb2IyUnpKem9nSjBkRlZDd2dVRTlUVkN3Z1QxQlVTVTlPVXljc0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFVobFlXUmxjbk1uT2lBblEyOXVkR1Z1ZEMxVWVYQmxKeXdLZlRzS1puVnVZM1JwYjI0Z2FuTnZiaWh5WlhNc0lITjBZWFIxY3l3Z2IySnFLU0I3Q2lBZ2NtVnpMbmR5YVhSbFNHVmhaQ2h6ZEdGMGRYTXNJRTlpYW1WamRDNWhjM05wWjI0b2V5QW5RMjl1ZEdWdWRDMVVlWEJsSnpvZ0oyRndjR3hwWTJGMGFXOXVMMnB6YjI0N0lHTm9ZWEp6WlhROWRYUm1MVGduSUgwc0lFTlBVbE5mU0VWQlJFVlNVeWtwT3dvZ0lISmxjeTVsYm1Rb1NsTlBUaTV6ZEhKcGJtZHBabmtvYjJKcUtTazdDbjBLQ21OdmJuTjBJSE5sY25abGNpQTlJR2gwZEhBdVkzSmxZWFJsVTJWeWRtVnlLR0Z6ZVc1aklDaHlaWEVzSUhKbGN5a2dQVDRnZXdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5UMUJVU1U5T1V5Y3BJSHNnY21WekxuZHlhWFJsU0dWaFpDZ3lNRFFzSUVOUFVsTmZTRVZCUkVWU1V5azdJSEpsZEhWeWJpQnlaWE11Wlc1a0tDazdJSDBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0owZEZWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTlvWldGc2RHZ25LU0I3Q2lBZ0lDQnlaWE4wWVhKMFNXWkJZMk52ZFc1MFEyaGhibWRsWkNncE95QXZMeURyc0pic2w1RHNoSndnNnJPRTdLQ1Y3SjJFSU91d2xPcS9xT3ljdk91cHRDRHNtSnNnNnJPRTdLQ1ZJT3lFdU95Rm1PeWRoQ0RycUx6c29JQWc2N0tFNjZhdzY0dWtJQ2pzbFlUcm5wZ2c3SnVNNjdDTjdKZUY3SjIwSU95WW15RHFzNFRzb0pYc25MenJvWndnNjQrTTdLZUFJT3lWaXVxeWpDa0tJQ0FnSUhKbGRISjVRWFYwYUVsbVRtVmxaR1ZrS0NrN0lDOHZJT3Vobk9xM3VPeWR1Q0R0bFlUc21wUWc3SU9CN1lPYzY2bTBJT3llck8yWmxleWR1Q0RzaTV6cmo0UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVPeWR0Q0RyZ1ozcmdxenNuTHpycWJRZzY0dWs3SjJNSU95aHNPMmFqT3UyZ08yRXNDQndjbTlpYkdWdDdKMjBJTzJTZ091bXNPdUxwQW9nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNLSUNBZ0lDQWdiMnM2SUhSeWRXVXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY3NJSFk2SUVKU1NVUkhSVjlXTENCa2FYSTZJRjlmWkdseWJtRnRaU3dnTHk4Z2RzSzNaR2x5T2lEcXRhenJzb1Rzb0lRdjdKZUo2NXF4N1pXY0lPeUNyT3V6dU95ZHRDRHJscUFnN0o2STY0cVU3S2VBSU95bmhPdUxxT3lhcVFvZ0lDQWdJQ0J0YjJSbGJEb2dZM1Z5Y21WdWRFMXZaR1ZzTENCdGIyUmxiSE02SUVGTVRFOVhSVVJmVFU5RVJVeFRMQ0JsZUdGdGNHeGxjem9nUlZoQlRWQk1SVk11YkdWdVozUm9MQ0JuZFdsa1pUb2dSMVZKUkVVdWJHVnVaM1JvTENCeVpXRmtlVG9nZDJGeWJXVmtWWEFzQ2lBZ0lDQWdJSEJ5YjJKc1pXMDZJQ2hqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJQ2R2YXljZ2ZId2dZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQnVkV3hzS1NBL0lHNTFiR3dnT2lCamJHRjFaR1ZUZEdGMGRYTXNDaUFnSUNBZ0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3S0lDQWdJQ0FnYzJWeWRtVmtPaUJ6ZEdGMGN5NXpaWEoyWldRc0lHeGhjM1JCZERvZ2MzUmhkSE11YkdGemRFRjBMQ0JzWVhOMFZHVjRkRG9nYzNSaGRITXViR0Z6ZEZSbGVIUXNJR3hoYzNSVFpXTTZJSE4wWVhSekxteGhjM1JUWldNc0NpQWdJQ0I5S1RzS0lDQjlDaUFnTHk4ZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEaWdKUWc2NEdLNnJpdzY2bTBJT3ljaENEcXNKRHNpNXdnN1lPQTdKMjA2Nmk0NnJDQUlPdUxwT3Vtck91bHZDRHJnWWpyaTZRS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmFHVmhjblJpWldGMEp5a2dld29nSUNBZ2JHRnpkRUpsWVhRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0NpQWdmUW9nSUM4dklPdWhuT3EzdU95ZHVDRGlnSlFnN1pTTTY1K3M2cmU0N0oyNDdKMllJRnZ3bjUrZ0lPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c3WldFN0pxVVhjSzNXL0NmbEpGZElPdXloTzJLdk95ZHRDRHRtTGpzdHB6dGxaenJpNlF1Q2lBZ0x5OGc2cml3NjdPNEtPdTRqT3Vkdk95YXNPeWdnQ0RzcDRIdGxva3BPaUJnWTJ4aGRXUmxJR0YxZEdnZ2JHOW5hVzRnTFMxamJHRjFaR1ZoYVdEcnBid2c3SWlvN0oyQUlPMlVoT3Vobk95RXVPeUtwT3VobkNEc2k2VHRsb2tnNG9DVUlPdXBsT3VKdENEc2w0YnNuYlFnNnJPbjdKNmxJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RxczZBc0NpQWdMeThnSUNCc2IyTmhiR2h2YzNRZzdJaVk3SXVnSU8yUHJPMkt1T3VobkNEcXNyRHFzN3pycGJ3ZzdKNlE2NCtaSU95SW1PdWd1ZTJWbk91THBDanNpNlRzdUtFNklPMlhwT3VUbk91bXJPeUtwT3lYa095RW5PdVBoQ0RydUl6cm5ienNtckRzb0lBZzdKZTA2NmE4SUNzZ1RFbFRWRVZPSU8yWmxleWR1Q3dnTWpBeU5pMHdOeWt1Q2lBZ0x5OGdJQ0R0aExEcnI3anJoSkRzbmJRZzdabVU2Nm0wN0plUUlPeWdoTzJZZ0NEc2xZZ2c2NXlzNjR1a0xpRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0NjZlTUlPMlZtT3VwdENEcmdaMHVDaUFnTHk4ZzdZKzA2N0N4S08yRXNPdXZ1T3VFa0NrNklPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzY2ZUo3WjZNSU8yWm1PcXl2U2pydUl6cm5ienNtckRzb0lEcXNJQWdiRzlqWVd4b2IzTjA3SmVRSU91cXV5RHJpNy9zbFlRZzdMMlU2NU9jNnJDQUlPdXp0T3lkdE91S2xDRHFzcjNzbXJBcDdKZVE3SVNjQ2lBZ0x5OGdJQ0Ryb1p6cXQ3anNuYmdnNjR5QTZyaXdJT3lra1NEcnNvVHRpcnpzbllRZzY1aVFJT3VJaE91bHRPdXB0Q3dnN0wyVTY1T2M2Nlc4SU91Mm1leVhyT3VFbyt5ZGhDRHNpSmdnN0o2STY0cVVJTzJFc091dnVPdUVrQ0Ryc0tuc2k1M3NuTHpyb1p3ZzdLQ0U3Wm1ZN1pXYzY0dWtMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl2Y0dWdUxXeHZaMmx1SnlrZ2V3b2dJQ0FnWTI5dWMzUWdZbTlrZVNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdDaUFnSUNCamIyNXpkQ0J6ZDJsMFkyaE5iMlJsSUQwZ0lTRW9ZbTlrZVNBbUppQmliMlI1TG5OM2FYUmphRUZqWTI5MWJuUXBPeUF2THlEcXM0VHNvSlVnN0tDRTdabVlJRDBnN0l1YzdZR3M2NmEvSU95d3ZleWN2T3VobkNEc2w3VHNsclFnNnJPRTdLQ1Y3SjJFSU9xem9PdWx2Q0RzaUpnZzdKNkk2cktNQ2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0F2THlCamJHRjFaR1hxc0lBZzdKZUc3Snk4NjZtMElPeVhyT3E0c095RW5DRHJnWXJyaXBUcmk2UXVJSE5vWld4c09uUnlkV1hybmJ3Z1kyeGhkV1JsNnJDQUlPeVhodXlXdE91UGhDRHNoYmpzbllBZzdLQ1Y3SU9CSU95THBPMldpZXVQdkFvZ0lDQWdJQ0F2THlCemNHRjNidXlkbUNBblpYSnliM0luNnJDQUlPeVZpQ0RybktqcXM2QXNJT3lZaU95Z2hPeVhsQ0RxdDdqcmpJRHJvWndnYjJzNmRISjFaZXVsdkNEcmo0enJvS1RzcEt6cmk2UWc0b0NVQ2lBZ0lDQWdJQzh2SU8yVWpPdWZyT3EzdU95ZHVPeWRnQ0FpNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lYdE95WGlPeVd0T3lhbENMcm5ienFzNkFnN1pXWTY0cVU2NDJ3SU95THBPeWduT3Vobk91S2xDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPdWNxT3VLbENEc2c0SHRnNXpxc0lBZzY1Q1E2NHVrS095THBPeWduQ0RzaTZEcXM2QXBMZ29nSUNBZ0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25LU0I3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURFc0lIc0tJQ0FnSUNBZ0lDQWdJR1Z5Y205eU9pQW43SjIwSUZCRDdKZVFJRU5zWVhWa1pTQkRiMlJsNnJDQUlPeVhodXlXdE95YWxDRGlnSlFnN1lTdzY2KzQ2NFNRN0plUTdJU2NJR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3SjIwSU91UW1PdUtsT3luZ0NEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxpY3NDaUFnSUNBZ0lDQWdJQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25MQW9nSUNBZ0lDQWdJSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJQzh2SU95bmhPMldpU0RzcEpIc25ianJqYkFnNjVpUUlPdUlqT3VnZ091THBDRGlnSlFnN0p1UTdMbVo3SjJBSUNMcnVJenJuYnpzbXJEc29JRHJvWndnNjR1azdJdWNJT3lYdE9xNHNDTHJpNlF1SU8yRXNPdXZ1T3VFa095ZGdDQXFLdXl3dmV5ZGhDRHNsWVRyckxUcXNvUHJqNFFnNjZxN0lPdWRoT3lib095ZGhDRHJsWXpycDR3cUtpNEtJQ0FnSUNBZ0x5OGc3SmlJN0tDRTdKZVVJQ2MyTU95MGlDRHJoSmpxc293ZzY0eUE2cml3SU95a2tleWR0T3VwdENEdGhMRHJyN2pyaEpBbjdKMjA3SmVJNjRxVTY0MndMQ0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA3SjJFSU95ZHZlcXhzT3VDbUNEc25xRHF1WkFnNjVTMElPeWR2Q0R0bFpqcmk2UWc2NHVrN0l1Y0lPdUloT3VsdUFvZ0lDQWdJQ0F2THlEc29KWHNnNEhzb0lIc25iZ2c2cks5N0pxdzdKZVE2NCtFSUdOdFpDRHNzTDNzbmJRZzdZcUE3SmEwNjRLWTdKbVU2NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Eb2dJdTJFc091dnVPdUVrQ0R0bVpUcnFiVHNuWUFnN0ptY0lPdVdvQ0Rxc0pIc25wRHF1TEFpS1M0S0lDQWdJQ0FnTHk4ZzdKMjA3S0NjSU95YXNPdW1yT3F3Z0NEc3NMM3NuWVFnN0tlQjdLQ1JJT3lYdE9xem9DRHNoTEhxczdVZzdKZXM2N2FBS0d4dloybHVWMmx1Wkc5M1QzQmxibVZrS2V1bHZDRHNsWVRyaTRqcXVZd3NJT3lMbk9xd2hPeWR0Q0RzbFlUcmk0anJuYndnNnJlNElPeUNyT3lMcE91aG5DRHRqSkRyaTZqdGxaenJpNlF1Q2lBZ0lDQWdJR052Ym5OMElITjBZV3hsSUQwZ2JHOW5hVzVRY205aklDWW1JQ0ZzYjJkcGJsZHBibVJ2ZDA5d1pXNWxaQ0FtSmlBb1JHRjBaUzV1YjNjb0tTQXRJR3h2WjJsdVUzUmhjblJsWkVGMElENGdNakF3TURBcE93b2dJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpJQ1ltSUhOMFlXeGxLU0I3Q2lBZ0lDQWdJQ0FnYTJsc2JFeHZaMmx1VUhKdll5Z3BPd29nSUNBZ0lDQWdJR2xtSUNnaGIzQmxia3h2WjJsdVZHVnliV2x1WVd3b0tTa2dld29nSUNBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURFc0lIc2daWEp5YjNJNklDZnNuYlFnVDFQc2w1RHNoS0FnN0o2UTY0K1o3Snk4NjZHY0lPdXF1eURzbDdUc2xyVHNtcFFnNG9DVUlPMkVzT3V2dU91RWtPeVhrT3lFbkNCamJHRjFaR1VnN0l1azdaYUpJTzJiaENBdmJHOW5hVzRnN1pXMElPeWp2T3lFdU95YWxDNG5JSDBwT3dvZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnSUNBdkx5RHNuWmpyajRUc29JRWc3S0tGNjZPTUtISmxZWE52YmlEc3A0RHNvSlVwSU9LQWxDRHNwNFR0bG9rZzdLU1JJTzJFdE95ZGhDQlRSVk5UU1U5T1gwUkpSVVRyb1p3ZzY0R2Q2NEswNjZtMElPeWVrT3VQbVNEc25xenNpNXpyajRUcXNJQWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuWVFnNjVDWTdJSzA2NmF3NjR1a0NpQWdJQ0FnSUNBZ2EybHNiRkJ5YjJNb0ordWhuT3EzdU95ZHVPeWRoQ0RzcDRUdGxvbnRsWmpyaXBRZzdLU1I3SjIwNjUyOElPeWFsT3l5cmV5ZGhDRHNwSkhyaTZqdGxvanNsclRzbXBRZzRvQ1VJT3Vobk9xM3VPeWR1Q0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUp5azdDaUFnSUNBZ0lDQWdZV05qYjNWdWRFTmhZMmhsTG1GMElEMGdNRHNLSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNElPMlB0T3V3c1NEaWdKUWc3WVN3NjYrNDY0U1FJT3V3cWV5TG5leWN2T3VobkNEc29JVHRtWmd1SnlrN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUcxdlpHVTZJQ2QwWlhKdGFXNWhiQ2NnZlNrN0NpQWdJQ0FnSUgwS0lDQWdJQ0FnTHk4ZzY3Q3A2cmlJSU95TG5PeWVrZTJWbkNEcm9aenF0N2pzbmJqc25iUWc3SUswN0pXRUlPeWVpT3ljdk91cHRDRHNocERyaklEc3A0QWc3SldLNjRxVTY0dWtJT0tBbENEc283M3NuYlRycWJRZzdJS3M3SnFwN0o2UTZyQ0FJT3V6dE9xem9DRHNub2pyaXBRZzdZT3Q3SjJZSU95OW5PdXdzU0R0ajZ6dGlyanFzSUFLSUNBZ0lDQWdMeThnNjR1cjdaaUFJQ0pzYjJOaGJHaHZjM1RzbDVEc2hKd2c3SmV3NnJLdzdKMkVJT3F4c091MmdPMldpT3lLdGV1TGlPdUxwQ0xxc0lBZzY1eXM2NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Da3VDaUFnSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk1nSmlZZ1JHRjBaUzV1YjNjb0tTQXRJR3h2WjJsdVUzUmhjblJsWkVGMElEd2dNVFV3TURBcElIc0tJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU95d3ZleWR0Q0RzbmJUcnI3Z2c3SmUwNjZDa0lPeWVpT3lXdE95YWxDRGlnSlFnN0lPSTY2R2NJT3lYdE95bmdDRHNsWXJxczZBZzZyZTRJT3l3dmV5ZGhDRHNrN0RzaExqc21wUXVKeWs3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJRzF2WkdVNklDZGhiSEpsWVdSNUxXOXdaVzRuSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNnTHk4ZzdKV2U3SVNnSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianNuYlFnNjR5QTZyaXdJT3lra2V5ZHRPdXB0Q0Rzb0pIcXM2QWc3SU9JNjZHY0lPeVhzT3VMcENBbzdMQzk3SjJFSU91THEreVZtT3F4c091Q21DRHJpNlRzaTV3ZzY0aUU2Nlc0SU9xeXZleWFzQ2tLSUNBZ0lDQWdiRzluYVc1VGRHRnlkR1ZrUVhRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ0lDQnNiMmRwYmxkcGJtUnZkMDl3Wlc1bFpDQTlJR1poYkhObE95QXZMeURzbmJUcnNvZ2c3SXVjNjQrRTdKMllJT3l3dlNEc2w3VHF1TEFnN0lTeDZyTzFJT3lYck91MmdDRGlnSlFnN0pXRTY1Nlk3SmVRN0lTY0lPeUV1T3lhdE91THBBb2dJQ0FnSUNBdkx5QkNVazlYVTBWUzY0cVVJT3F4dE91VG5PdW1yT3luZ0NEc2xZcnJpcFRyaTZRZzRvQ1VJRU5NU2Vxd2dDRHF1TERyczdnZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95WHRPcXpvQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPeWVrT3VQbVNEc2lKanJvTG50bFp6cmk2UUtJQ0FnSUNBZ0x5OGdLT3ljaENBbjY2R2M2cmU0N0oyNDdKMkFJRU5NU2Vxd2dDRHF1TERyczdnZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95bmdleWdrU0RzbDdUcXNvd2c3WldjNjR1a0p5RHNvN3pzaEowZzRvQ1VJT3F3Z091aG5PeXhoT3VwdENEc3ZaVHJrNXdnNjdhWjdKZXM2NFNqNnJpd0lPMlpsT3VwdE95ZHRDRHJuS3pyaTZRcExnb2dJQ0FnSUNBdkx5QXFLdXF6aE95Z2xTRHNvSVR0bVpqc25ZQWc3SnU1SU91aG5PcTN1T3lWaE95YmcreWRoQ0RycUx6c29JQWc3SmV3NjR1a0tpb29NakF5Tmkwd09Dd2dRbEpKUkVkRlgxWTlNekVwT2lEcnVJenJuYnpzbXJEc29JRHNsNUFnN0lTNDdJV1k3SjIwSU91Q3FPeVZoQ0Rzbm9qc25MenJxYlFLSUNBZ0lDQWdMeThnWVhWMGFHOXlhWHBsNnJDQUlPcXpoT3lnbGV5ZGhDRHJyTHZzcDRBZzdKV0s2ck9nSU95S3VleWR1Q0R0bVpUcnFiVHJwNHdnNjUyRTdKcTA2NHVrS0NMc2lybnNuYmdnN1ptVTY2bTBJT3Vua09xem9DRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKeTg2NkdjSU9xd2dPcXpvQ0RzaTdicmk2UWlJT3lhbE9xMXJDa3VDaUFnSUNBZ0lDOHZJT3lFdU95Rm1PeWRoQ0RzcDREc21yUWc2NUtrSU95WHRPdXB0Q0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA2N2FBN1lTd0lPdUNtT3lZcU91THBDRGlnSlFnVlZKTTdKMkVJT3F3Z09xenRlMlZtT3luZ091UGhDanNzclRzbmJUcmk1MGc3SXVrN1l5b0tTd2dRbEpQVjFORlV1dWx2Q0Rxc0lEcm9aenNzWVRzcDREcmo0UUtJQ0FnSUNBZ0x5OGdLT3k5bE91VG5DRHJ0cG5zbDZ6cmhLUHF1TEFnN0p5ZzY3Q2NLU3dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3F6b091bHRPeW5nT3VQaENqcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQUlPeVZoT3VMbUNrZzdKV0s2NHFVSU95Y29PeWR2TzJWbkNEcnNLbnJzcFV1Q2lBZ0lDQWdJQzh2SU91MmdPeWVrZXlhcVRvZzY3aU02NTI4N0pxdzdLQ0E3SjJZSUdOc1lYVmtaU0RzbTdrZzY2R2M2cmU0N0oyNDY0K0VJTzJTZ091bXNPdUxwQ0RpZ0pRZzZyT0U3S0NWN0oyRUlPdXdsT3ErdU91Z3BPdUtsQ0Rzblpqcmo0VHNtWUFnNjdDcDdaYWw3SjIwSU9xd21leVZoQ0RzaUpqc21xa3VDaUFnSUNBZ0lHTnZibk4wSUhOMFlYSjBURzluYVc0Z1BTQW9LU0E5UGlCN0NpQWdJQ0FnSUNBZ1kyOXVjM1FnZEdocGMweHZaMmx1SUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbllYVjBhQ2NzSUNkc2IyZHBiaWNzSUNjdExXTnNZWFZrWldGcEoxMHNJSHNLSUNBZ0lDQWdJQ0FnSUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUVOTVFWVkVSVjlGVGxZc0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2QybHVaRzkzYzBocFpHVTZJSFJ5ZFdVc0NpQWdJQ0FnSUNBZ0lDQmtaWFJoWTJobFpEb2djSEp2WTJWemN5NXdiR0YwWm05eWJTQWhQVDBnSjNkcGJqTXlKeXdnTHk4Z2EybHNiRXh2WjJsdVVISnZZK3lkbUNEcXQ3anJvN2tnYTJsc2JPeWFxU0FvYTJsc2JGQnliMlBxczd3ZzY0K1o3SjI4SU8yTXFPMkV0Q2tLSUNBZ0lDQWdJQ0I5S1RzS0lDQWdJQ0FnSUNCc2IyZHBibEJ5YjJNZ1BTQjBhR2x6VEc5bmFXNDdDaUFnSUNBZ0lDQWdiRzluYVc1WGFXNWtiM2RQY0dWdVpXUWdQU0IwY25WbE95QXZMeUJEVEVucXNJQWc3SmVzNjRxVUlPcXh0Q0RxdElEc3NMRHRsYUFnN0lpWUlPeVhodXljdk91TGlDRHNsN1RycHJBZzZyS0Q3Snk4NjZHY0lPdXp1T3VMcENBbzdKNnM3WUcwNjZhdDdKZVFJTzJFc091dnVPdUVrQ0Ryc0tuc3A0QXBDaUFnSUNBZ0lDQWdkR2hwYzB4dloybHVMbTl1S0NkbGNuSnZjaWNzSUNncElEMCtJSHNnYVdZZ0tHeHZaMmx1VUhKdll5QTlQVDBnZEdocGMweHZaMmx1S1NCc2IyZHBibEJ5YjJNZ1BTQnVkV3hzT3lCOUtUc0tJQ0FnSUNBZ0lDQjBhR2x6VEc5bmFXNHViMjRvSjJOc2IzTmxKeXdnS0dOdlpHVXBJRDArSUhzS0lDQWdJQ0FnSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk1nSVQwOUlIUm9hWE5NYjJkcGJpa2djbVYwZFhKdU93b2dJQ0FnSUNBZ0lDQWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tJQ0FnSUNBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJOVWFXMWxjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9iRzluYVc1UWNtOWpWR2x0WlhJcE95QnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlHNTFiR3c3SUgwS0lDQWdJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQzh2SU95RGlDRHFzNFRzb0pYc25id2c3SWlZSU95ZWlPeWN2T3VMaUNEcmk2VHNuWXdnTDJobFlXeDBhQ0RybFl3ZzY0dWs3SXVjSU95ZHZlcTRzQW9nSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN0tDSTdMQ29JT3lpaGV1ampDQW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BKeWs3Q2lBZ0lDQWdJQ0FnSUNBdkx5RHNncXpybm96c25iUWc2NkdjNnJlNDdKMjQ3WldnSU95TG5PcXdoT3VQaENEc2w0YnNuYlFnNnJPbjY3Q1U2NkdjSU95THBPMk1xT3VobkNEcmdaM3JncXpyaTZRZ1BTQmpiR0YxWkdYcXNJQWc3SmVHNnJHdzY0S1lJT3lMcE8yV2lleWR0Q0RzbFlnZzY1Q2NJT3F5Z3k0S0lDQWdJQ0FnSUNBZ0lDOHZJT3lka2V1THRleWRnQ0RzbmJUcnI3Z2c2N08wNjRPSTdKeTg2NHVJSU95RGdlMkRuT3VsdkNEcmk2VHNpNXdnN0o2czdJU2NJQzlvWldGc2RHanJvWndnN0pXTTY2YXc2NHVrSUNqdGxJenJuNnpxdDdqc25ianNuYlFnNjR5QTZyaXdJTzJabE91cHRPeWRoQ0RzaTZUdGpLanJvWndnNjdDVTZyNjg2NHVrS1M0S0lDQWdJQ0FnSUNBZ0lHbG1JQ2hqYjJSbElDRTlQU0F3SUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JzYjJkcGJsTjBZWEowWldSQmRDQThJRFV3TURBcElIc0tJQ0FnSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVPeWR0Q0RzcG9uc2k1d2c3SXVrN1l5bzY2R2NJT3VCbmV1Q3FDRGlnSlFnUTJ4aGRXUmxJRU52WkdVZzdJU2s3TG1ZSU95RGdlMkRuT3VsdkNEcmk2VHNpNXdnN0tDUTZyS0E3WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdJQ0FnSUNBZ0lDQmphR1ZqYTBOc1lYVmtaVUYyWVdsc1lXSnNaU2dwT3dvZ0lDQWdJQ0FnSUNBZ2ZRb2dJQ0FnSUNBZ0lIMHBPd29nSUNBZ0lDQWdJQzh2SURNdzY3YUVJT0tBbENEc25iUWc3WlNFNjZHYzdJUzQ3SXFrNnJDQUlPeWp2ZXljdk91cHRDRHJ1SXpybmJ6c21yRHNvSUFnN0wyYzY3Q3g3SjIwSU9xd2lDQnNiMk5oYkdodmMzUWc3WStzN1lxNDY0K0VJT3VMcSsyWWdDQW43SmV3NnJLdzdKMkVJT3F4c091MmdPMldpT3lLdGV1TGlPdUxwQ2Zxc0lBZzY1eXM2NHVrTGdvZ0lDQWdJQ0FnSUM4dklPeVlpT3lnaENBeE1PdTJoT3lkZ0NEc3A2ZnNsWVRzaEp3c0lPdWhuT3EzdU95ZHVPMlZtT3VMcENEc25xRHF1WkFnNjR1azY2VzRJT3lkdk95ZGhDRHRsWmpycWJRZzdZT3Q3SjIwSU91c3RPMmFxT3F3Z0NEcmtKRHJpNlFvTWpBeU5pMHdPQ0RzaTZUc3VLRWc3SXVnNnJPZ0tTNEtJQ0FnSUNBZ0lDQnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V5QmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SURNdzY3YUVJT3F5dmVxenZDRGlnSlFnNjR5QTZyaXdJTzJVaE91aG5PeUV1T3lLcENEc29KWHJwcXd1SnlrN0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ2ZTd2dNVGd3TURBd01DazdDaUFnSUNBZ0lIMDdDaUFnSUNBZ0lDOHZJT3F6aE95Z2xTRHNvSVR0bVpqcmo0UWc2ckNaN0oyQUlPcXl2ZXVobk91THBDRGlnSlFnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdLZUI3S0NSSU95WHNPdUxwQ2p0ZzYwZ01lcXduQ3dnN0o2UTY0K1pJT3laaE91ampDa3VDaUFnSUNBZ0lDOHZJT3lLdWV5ZHVDRHRtWlRycWJUc25iUWc2NXlvNjZtMElPcTN1Q0R0bVpUcnFiUWc3WldZNjR1b0lGdnFzNFRzb0pVZzdLQ0U3Wm1ZWGV5Y3ZPdWhuQ0RyaTZUcnBiZ2c2ck9FN0tDVjdKMkVJT3F6b091bHVPdUxwQzRnN0oyMDdKeWc2NHFVSU95Y2hDRHNvN3pzaEowZzdMQzQ2ck9nTGdvZ0lDQWdJQ0J6ZEdGeWRFeHZaMmx1S0NrN0NpQWdJQ0FnSUM4dklPdUNvZXlkZ0NEc25vWHNucVhxdG96c25ZUWc2Nnk4NnJPZ0lPeWVpT3VLbENEcmpJRHF1TEFnN0lTNDdJV1k3SjJBSU91eWhPdW1zT3VMcENEaWdKUWc3SjZzNjZHYzZyZTQ3SjI0SU8yYmhDRHJpNlRzbll3ZzdKcVU3TEt0N0oyMElPeURpQ0RzaExqc2haZ283SU9JSU95ZWhleWVwZXEyakNuc25MenJvWndnN0l1YzdKNlI3WldZNnJLTUxnb2dJQ0FnSUNBdkx5RHNuWmpyajRUc29JRWc3S0tGNjZPTUtISmxZWE52YmlEc3A0RHNvSlVwSU9LQWxDQlRSVk5UU1U5T1gwUkpSVVRyb1p3ZzY0R2Q2NEswNjZtMElPeWVrT3VQbVNEc25xenNpNXpyajRUcXNJQWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuWVFnNjVDWTdJSzA2NkNrQ2lBZ0lDQWdJQzh2SU95ZXJPdWhuT3EzdU95ZHVDRHJrcVRzbDVEcmo0UWdUVUZZWDFSVlVrNVQ2cm1NN0tlQUlPeVlteURxczRUc29KWHNuTHpyb1p3ZzdMS1k2NmFzNjVDWTY0cVVJT3V5aE9xM3VPcXdnQ0Rya0p6cmk2UWdLREl3TWpZdE1EY2c2NmFzNjdldzdKZVE3SVNjSU8yWmxleWR1Q2tLSUNBZ0lDQWdhMmxzYkZCeWIyTW9KK3Vobk9xM3VPeWR1T3lkaENEc3A0VHRsb250bFpqcmlwUWc3S1NSN0oyMDY1MjhJT3lhbE95eXJleWRoQ0RzcEpIcmk2anRsb2pzbHJUc21wUWc0b0NVSU91aG5PcTN1T3lkdUNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeWs3Q2lBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJT3lMbk95ZWtTY2dLeUFvYzNkcGRHTm9UVzlrWlNBL0lDY2dLT3F6aE95Z2xTRHNvSVR0bVpnZzRvQ1VJT3lLdWV5ZHVDRHRtWlRycWJUc25iUWc2NXlvNjZtMElPcTN1Q0R0bVpUcnFiUWc3WldZNjR1b0lGdnFzNFRzb0pVZzdLQ0U3Wm1ZWGV5Y3ZPdWhuQ0RyaTZUcnBiZ2c2ck9FN0tDVjdKMkVJT3F6b091bHZDRHNpSmdnN0o2STdKYTA3SnFVS1NjZ09pQW5KeWtnS3lBbklPS0FsQ0Ryb1p6cXQ3anNuYmp0bFpqcnFiUWc3SjZRNjQrWklPeVhzT3F5c091UXFldUxpT3VMcEM0bktUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUcxdlpHVTZJSE4zYVhSamFFMXZaR1VnUHlBblluSnZkM05sY2kxemQybDBZMmduSURvZ0oySnliM2R6WlhJbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNQ3dnZXlCbGNuSnZjam9nSit1aG5PcTN1T3lkdUNEc3NMM3NuWVFnNjZxN0lPeVh0T3lYaU95V3RPeWFsRG9nSnlBcklHVXViV1Z6YzJGblpTQjlLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGdLTzJFc091dnVPdUVrQ0R0ajdUcnNMRWc2cldzN1ppRTY3YUFJT0tBbENEcnVJenJuYnpzbXJEc29JQWc3SjZRNjQrWklPeVpoT3Vqak9xd2dDRHNsWWdnNjVDWTY0cVVJTzJabU9xeXZTRHNvSVRzbXFrcENpQWdablZ1WTNScGIyNGdiM0JsYmt4dloybHVWR1Z5YldsdVlXd29LU0I3Q2lBZ0lDQjdDaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUNBZ0x5OGdjM1JoY25UcXNJQWc3SU9JSU95OW1PeUdsQ0Rzc0wzc25ZUWc2NmVNNjVPZzY0dWtJQ2pyaTZUcnBxenNuWmdnN0lpbzdKMkFJT3k5bU95R2xPcXp2Q0RyckxUcXRJRHRsWmpxc293ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU91enRPeWVoQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdKMjA3SmEwN0lTY0lGQnZkMlZ5VTJobGJHd29MbkJ6TVNuc25iUWdOZXkwaUNEcmtxUWc2cmU0SU95d3ZleVhrQ0RzbDVUdGhMRHJwYndnNjdPMDY0SzBJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbllRZzdKNlE2NCtaSU95RW9PMkRuZTJWbU9xem9Dd0tJQ0FnSUNBZ0lDQXZMeURzc0wzc25ZUWc3TFdjN0lhTTdabVU3WlcwSU95Q3JPeWFxZXlla0NEcmlJanNsNVFnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVPdW5qQ0RyZ3FqcXNvd2c3WldjNjR1a0xpRHNzTDNzbllRZzY2cTdJT3l3dnV5Y3ZPdXB0Q0RzbFlUcnJMVHFzb1ByajRRZzdKV0lJTzJWbk91THBBb2dJQ0FnSUNBZ0lDOHZJQ2pyaTZUcnBiZ2c3TEM5SU95WXBPeWVoZXVncFNEcnNLbnNwNEFnNG9DVUlPcTN1Q0Rxc3Izc21yQWc2Nm1VNjRtMDZyQ0FJT3V6dE95ZHRPdUtsQ0Rzc1lUcm9ad2c2NEtvNnJPZ0lPeUNyT3lhcWV5ZWtPcXdnQ0RzbDVUdGhMQWc3WldjSU91eWlDRHJpSVRycGJUcnFiUWc2NUNvS1M0S0lDQWdJQ0FnSUNBdkx5RHNvN3pzblpnNklHTnNZWFZrWmVxd2dDRHN2WmpzaHBRZzdLQ2M2NnFwN0oyRUlPdXdsT3ErdU91cHRDQkJjSEJCWTNScGRtRjBaUzlHYVc1a1YybHVaRzkzNnJDQUlPdXF1eURzc0w3c25ZUWc3SWlZSU95ZWlPeWRqQ0RpZ0pRZzdKeUk2NCtFN0pxd0lPeUxwT3E0c095WGtPeUVuQ0R0bVpYc25iZ2c3WldFN0pxVUxnb2dJQ0FnSUNBZ0lHTnZibk4wSUhCek1TQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ykc5bmFXNHVjSE14SnlrN0NpQWdJQ0FnSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXlod2N6RXNJRnNLSUNBZ0lDQWdJQ0FnSUNkVGRHRnlkQzFUYkdWbGNDQXRVMlZqYjI1a2N5QTFKeXdLSUNBZ0lDQWdJQ0FnSUNja2QzTWdQU0JPWlhjdFQySnFaV04wSUMxRGIyMVBZbXBsWTNRZ1YxTmpjbWx3ZEM1VGFHVnNiQ2NzQ2lBZ0lDQWdJQ0FnSUNBaWFXWWdLQ1IzY3k1QmNIQkJZM1JwZG1GMFpTZ25ZMnhoZFdSbExXeHZaMmx1SnlrcElIc2lMQW9nSUNBZ0lDQWdJQ0FnSWlBZ0pIZHpMbE5sYm1STFpYbHpLQ2QrSnlraUxBb2dJQ0FnSUNBZ0lDQWdKeUFnVTNSaGNuUXRVMnhsWlhBZ0xWTmxZMjl1WkhNZ01pY3NDaUFnSUNBZ0lDQWdJQ0FpSUNCQlpHUXRWSGx3WlNBdFRtRnRaWE53WVdObElGVWdMVTVoYldVZ1Z5QXRUV1Z0WW1WeVJHVm1hVzVwZEdsdmJpQW5XMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUZONWMzUmxiUzVKYm5SUWRISWdSbWx1WkZkcGJtUnZkeWh6ZEhKcGJtY2dZeXdnYzNSeWFXNW5JSFFwT3lCYlJHeHNTVzF3YjNKMEtGd2lkWE5sY2pNeUxtUnNiRndpS1YwZ2NIVmliR2xqSUhOMFlYUnBZeUJsZUhSbGNtNGdZbTl2YkNCVGFHOTNWMmx1Wkc5M0tGTjVjM1JsYlM1SmJuUlFkSElnYUN3Z2FXNTBJRzRwT3ljaUxBb2dJQ0FnSUNBZ0lDQWdJaUFnSkdnZ1BTQmJWUzVYWFRvNlJtbHVaRmRwYm1SdmR5aGJUblZzYkZOMGNtbHVaMTA2T2xaaGJIVmxMQ0FuWTJ4aGRXUmxMV3h2WjJsdUp5a2lMQW9nSUNBZ0lDQWdJQ0FnSnlBZ2FXWWdLQ1JvSUMxdVpTQmJVM2x6ZEdWdExrbHVkRkIwY2wwNk9scGxjbThwSUhzZ1czWnZhV1JkVzFVdVYxMDZPbE5vYjNkWGFXNWtiM2NvSkdnc0lEWXBJSDBuTENBdkx5QTJJRDBnVTFkZlRVbE9TVTFKV2tVS0lDQWdJQ0FnSUNBZ0lDZDlKeXdLSUNBZ0lDQWdJQ0JkTG1wdmFXNG9KMXh5WEc0bktTQXJJQ2RjY2x4dUp5azdDaUFnSUNBZ0lDQWdZMjl1YzNRZ1ltRjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxc2IyZHBiaTVpWVhRbktUc0tJQ0FnSUNBZ0lDQm1jeTUzY21sMFpVWnBiR1ZUZVc1aktHSmhkQ3dnSjBCbFkyaHZJRzltWmx4eVhHNG5JQ3NLSUNBZ0lDQWdJQ0FnSUNkemRHRnlkQ0FpWTJ4aGRXUmxMV3h2WjJsdUlpQmpiV1FnTDJzZ1kyeGhkV1JsSUM5c2IyZHBibHh5WEc0bklDc0tJQ0FnSUNBZ0lDQWdJQ2R3YjNkbGNuTm9aV3hzSUMxT2IxQnliMlpwYkdVZ0xVVjRaV04xZEdsdmJsQnZiR2xqZVNCQ2VYQmhjM01nTFVacGJHVWdJaWNnS3lCd2N6RWdLeUFuSWx4eVhHNG5LVHNLSUNBZ0lDQWdJQ0J6Y0dGM2JpZ25ZMjFrSnl3Z1d5Y3ZZeWNzSUdKaGRGMHNJSHNnWlc1Mk9pQkRURUZWUkVWZlJVNVdMQ0J6ZEdScGJ6b2dKMmxuYm05eVpTY3NJSGRwYm1SdmQzTklhV1JsT2lCMGNuVmxJSDBwT3dvZ0lDQWdJQ0I5SUdWc2MyVWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZGtZWEozYVc0bktTQjdDaUFnSUNBZ0lDQWdMeThnY0hSNUtHVjRjR1ZqZENucm9ad2c2N08wNjRLNElPMkNwT3lYa0NEdGdiVHJvWnpyazV3Z1ZGVko2ckNBSU91c3RPdXdtT3lka2V5ZHVDRHFzb1BzbmJRZzdJdWs3TGloSU8yWmxleWR1T3VRcUNneU1ESTJMVEEzTENEc25ienJzSmdnWEhMQ3QydHBkSFI1SU95OWxPdVRuQ0RycXFqcmtaQXBJT0tBbEFvZ0lDQWdJQ0FnSUM4dklPeWNvT3lkdk8yVm5DRHNucERyajVudG1aUWc2cks5NjZHYzY0cVVJRk41YzNSbGJTQkZkbVZ1ZEhQc25aZ2c3S2VFN0tlY0lPMkNwQ0Rzbm9Ycm9LVXVJT3lna2VxM3ZPeUVzU0RxdG96dGxaenNuYlFnN0o2STdKeTg2Nm0wSURic3RJZ2c2NUtrSU95WGxPMkVzT3F3Z0NEc25wRHJqNWtnN0o2RjY2Q2w2NCs4Q2lBZ0lDQWdJQ0FnTHk4Z01ldXlpQ2pxdGF6cmo0VWc2ck9FN0tDVktleWR0Q0RzaEtEdGc1M3JrSmpxczZBc0lPcTJqTzJWbk95ZHRDRHNsNGJzbkx6cnFiUWdhMlY1YzNSeWIydGxJT3lraE91bmpDRHNvYkRzbXFudG5vZ2c3SXVrN1l5bzdaVzBJT3lDck95YXFleWVrT3F3Z0NEc2w1VHRoTEFnN1pXY0lPdXlpQ0RyaUlUcnBiVHJxYlFnNjVDYzY0dWtLR1poYVd3dGMyOW1kQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdKZVU3WVN3SU95bmdleWdoT3lYa0NCVVpYSnRhVzVoYk95ZGhDRHJpNlRzaTV3ZzdKV2U3Snk4NjZHY0lPcXdnT3lndU95WmdDRHJpNlRycGJnZzdKV3g3SmVRSU8yQ3BPcXdnQ0RyazZUc2xyVHFzSURyaXBRZzZyS0Q3SjJFSU91bmlldUtsT3VMcEM0S0lDQWdJQ0FnSUNCemNHRjNiaWduYjNOaGMyTnlhWEIwSnl3Z1d3b2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJrYnlCelkzSnBjSFFnSW1Oc1lYVmtaU0F2Ykc5bmFXNGlKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWhiQ0lnZEc4Z1lXTjBhWFpoZEdVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURZbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJoWTNScGRtRjBaU2NzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuWkdWc1lYa2dNQzR6Snl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVGVYTjBaVzBnUlhabGJuUnpJaUIwYnlCclpYbHpkSEp2YTJVZ2NtVjBkWEp1Snl3S0lDQWdJQ0FnSUNBZ0lDOHZJT3lYbE8yRXNPcXdnQ0RzaTZUc29KenJvWndnNjVPazdKYTA2ckNFSU9xeXZleWFzT3lYa091bmpDRHNsNnpxdUxBZzY0K0U2NHVzS09xMmpPMlZuQ0RzbDRic25MenJxYlFnN0p5RTdKZVE3SVNjSU95a2tldUxxQ2tnNG9DVUlPMkVzT3V2dU91RWtPeWRoQ0RzdVpqc200d2c2N2lNNjUyODdKcXc3S0NBNjZlTUlPdUNxT3E0dE91THBBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURFdU5TY3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlWR1Z5YldsdVlXd2lJSFJ2SUhObGRDQnRhVzVwWVhSMWNtbDZaV1FnYjJZZ1puSnZiblFnZDJsdVpHOTNJSFJ2SUhSeWRXVW5MQW9nSUNBZ0lDQWdJRjBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE93b2dJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJtWVd4elpUc2dMeThnN0tlQTdKdVFJT3lWaUNEdGxaanJpcFFnVDFNS0lDQWdJQ0FnZlFvZ0lDQWdJQ0J5WlhSMWNtNGdkSEoxWlRzS0lDQWdJSDBLSUNCOUNpQWdMeThnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0Ryb1p6cXQ3anNsWVRzbTRNZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNEdG1ZanNuWmdnVyt1aG5PcTN1T3lWaE95YmcxMGc2N0tFN1lxODdKMjBJTzJZdU95Mm5DNGdZMnhoZFdSbElHRjFkR2dnYkc5bmIzVjA3Snk4NjZHY0lFTk1TU0Ryb1p6cXQ3anNuYmpzbllRZzdaVzA3S0NjN1pXYzY0dWtMZ29nSUM4dklDanNuYlFnVUVQc25aZ2c3S0NBN0o2bDY1Q2NJT3lla09xeXFleW1uZXVxaGV5ZGhDRHNwNERzbXJUcmk2UWc0b0NVSU91THBPeUxuQ0RzazdEcm9LVHJxYlFnN0o2czY2R2M2cmU0N0oyNElPMlZoT3lhbEM0cElPdWhuT3EzdU95VmhPeWJneUR0bTRUc2w1UWc3SVM0N0lXWXdyZnFzNFRzb0pYc3VwRHNpNXpycGJ3ZzdLQ1Y2NmFzN1pXYzY0dWtMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTlqYkdGMVpHVXRiRzluYjNWMEp5a2dld29nSUNBZ1kyOXVjM1FnYkc4Z1BTQnpjR0YzYmlnblkyeGhkV1JsSnl3Z1d5ZGhkWFJvSnl3Z0oyeHZaMjkxZENkZExDQjdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcE93b2dJQ0FnYkdWMElHVnljaUE5SUNjbk93b2dJQ0FnYkc4dWMzUmtaWEp5TG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzZ1pYSnlJQ3M5SUdRdWRHOVRkSEpwYm1jb0tUc2dmU2s3Q2lBZ0lDQnNieTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXlCcWMyOXVLSEpsY3l3Z05UQXdMQ0I3SUc5ck9pQm1ZV3h6WlN3Z1pYSnliM0k2SUNmcm9aenF0N2pzbFlUc200TWc3SXVrN1phSklPeUxwTzJNcURvZ0p5QXJJR1V1YldWemMyRm5aU0I5S1RzZ2ZTazdDaUFnSUNCc2J5NXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdJQ0JyYVd4c1VISnZZeWduNjZHYzZyZTQ3SldFN0p1RDdaVzA3SVNjSU95YWxPeXlyZXlkaENEc3BKSHJpNmp0bG9qc2xyVHNtcFF1SnlrN0lDOHZJT3lkbU91UGhPeWdnU0Rzb29Ycm80d2c0b0NVSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRxc0lBZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91bXJPdXB0Q0RzbFlnZzY1Q29DaUFnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQ0FnSUNBZ0lDQXZMeURyaTZUc25Zd2dMMkZqWTI5MWJuVEN0eTlvWldGc2RHanNsNURzaEp3ZzZyT0U3S0NWN0oyRUlPeURpT3VobkNnOTdKZUc3SjJNN0p5ODY2R2NLU0RzbmIzcXNvd0tJQ0FnSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDOHZJT3lEZ2UyRG5DRHNucXp0akpEc29KVW82NHVrN0oyTUlPMkV0T3lYa095RW5DRHJyN2pyb1p6cXQ3anNuYmdnNnJDUTdLZUFLUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lWaE95Ymd5QW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BKeWs3Q2lBZ0lDQWdJR2xtSUNoeVpYTXVhR1ZoWkdWeWMxTmxiblFwSUhKbGRIVnlianNnTHk4Z1pYSnliM0lnN1pXNDY1T2s2NStzNnJDQUlPeWR0T3V2dUNEc25aSHJpN1h0bG9qc25MenJxYlFnN0tTUjY3TzFJT3V3cWV5bmdBb2dJQ0FnSUNCcFppQW9ZMjlrWlNBOVBUMGdNQ2tnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU0I5S1RzS0lDQWdJQ0FnWld4elpTQnFjMjl1S0hKbGN5d2dOVEF3TENCN0lHOXJPaUJtWVd4elpTd2daWEp5YjNJNklDaGxjbkl1ZEhKcGJTZ3BMbk5zYVdObEtEQXNJREUxTUNrcElIeDhJQ2duN0tLRjY2T01JT3k5bE91VG5DQW5JQ3NnWTI5a1pTa2dmU2s3Q2lBZ0lDQjlLVHNLSUNBZ0lISmxkSFZ5YmpzS0lDQjlDaUFnTHk4ZzdKNlE2cml3SU95aWhldWpqQ0RpZ0pRZzdaU002NStzNnJlNDdKMjRJRk5VVDFCZlFsSkpSRWRGTCsyVm1PMkt1T3U1aE8yS3VPcXdnQ0R0bUxqc3RwenRsWnpyaTZRZ0tPdWhuT3k3ck95WGtPeUVuT3VuakNEc29KSHF0N3dnNnJDQTY0cWw3WldZNjR1SUlPeVZpT3lnaENrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmMyaDFkR1J2ZDI0bktTQjdDaUFnSUNCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWloZXVqakNEc21wVHNzcTBnNjdDYjdKMk1JT0tBbENEcmk2VHJwcXpycGJ3ZzY0R1Y2NHVJNjR1a0xpY3BPd29nSUNBZ2MyaDFkSFJwYm1kRWIzZHVJRDBnZEhKMVpUc0tJQ0FnSUd0cGJHeFFjbTlqS0NrN0NpQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSEJ5YjJObGMzTXVaWGhwZENnd0tTd2dNakF3S1RzS0lDQWdJSEpsZEhWeWJqc0tJQ0I5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNKbFkyOXRiV1Z1WkNjcElIc0tJQ0FnSUdOdmJuTjBJSHNnZEdWNGRDd2diVzlrWld3c0lISnZiR1VnZlNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdDaUFnSUNCcFppQW9JWFJsZUhRZ2ZId2dJVk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2twSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW43TGFVN0xLYzY3Q2I3SjJFSU91c3VPcTFyT3F3Z0NEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHN0cFRzc3B3ZzdKcVU3TEt0T2ljc0lGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0ExTUNrdWNtVndiR0ZqWlNndlhHNHZaeXdnSnlBbktTQXJJQ2ZpZ0tZbkxDQnliMnhsSUQ4Z0oxc25JQ3NnY205c1pTQXJJQ2RkSnlBNklDY25MQ0J0YjJSbGJDQS9JQ2NvNjZxbzY0MjRPaUFuSUNzZ2JXOWtaV3dnS3lBbktTY2dPaUFuSnlrN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclEyeGhkV1JsS0ZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0Nrc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVk4xWjJkbGMzUnBiMjV6TENCbWIzSnRZWFJFWlhOak9pQW5XM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0o5TENBdUxpNWRKeUI5TENCeWIyeGxLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MzVm5aMlZ6ZEdsdmJuTWdQU0J5TG5CaGNuTmxaQ0I4ZkNCYlhUc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93b2dJQ0FnSUNCcFppQW9JWE4xWjJkbGMzUnBiMjV6TG14bGJtZDBhQ2tnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0NpQWdJQ0FnSUgwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lWaUNBbklDc2djM1ZuWjJWemRHbHZibk11YkdWdVozUm9JQ3NnSitxd25DQW9KeUFySUhObFl5QXJJQ2R6S1NjcE93b2dJQ0FnSUNCemRHRjBjeTV6WlhKMlpXUXJLenNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRUYwSUQwZ2JtVjNJRVJoZEdVb0tTNTBiMHh2WTJGc1pWUnBiV1ZUZEhKcGJtY29KMnR2TFV0U0p5azdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djM1ZuWjJWemRHbHZibk1zSUdWdVoybHVaVG9nSjJOc1lYVmtaU2NnZlNrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNpNlR0aktnNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEdG1ManN0cHdnN0l1azdZeW9PaUFuS1NrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SU8yVWhPdWdpT3llaE91emhDRHN0cFRzc3B3ZzRvQ1VJTzJWbkNEdG1aVHJxYlRzbllRZzdaV1k3SnlFSU8yVWhPdWdpT3llaENqc21JSHNsNjBwSU91THFPeWNoT3VobkNEcmdwanJpS0FnNjdDYjZyT2dMQ0RzbUlIc2w2M3JwNGpyaTZRZzY1U3c2NkdjSU91TWdPeVZpT3lkaENEcmdyanJpNlF1Q2lBZ0x5OGc3SmlCN0pldElPeUltT3Vuak8yQnZDRHNtcFRzc3Ezc25ZUWc3S3E4NnJDYzdLZUFJT3lWaXV1S2xDRHFzb1BzbmJRZzdaVzE3SXVzSUNqcmlwRHJvS1RzcDREcXM2QWc3SUtzN0pxcDY1K0o2NCtFSU9xM3VPdW5qTzJCdkNEcmdwanFzSVRyaTZRcExnb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXlaV052YlcxbGJtUXRaM0p2ZFhCekp5a2dld29nSUNBZ1kyOXVjM1FnZXlCbmNtOTFjSE1zSUcxdlpHVnNMQ0J0YjNKbElIMGdQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3dvZ0lDQWdZMjl1YzNRZ2JHbHpkQ0E5SUVGeWNtRjVMbWx6UVhKeVlYa29aM0p2ZFhCektRb2dJQ0FnSUNBL0lHZHliM1Z3Y3dvZ0lDQWdJQ0FnSUNBZ0xtMWhjQ2dvWnlrZ1BUNGdLSHNLSUNBZ0lDQWdJQ0FnSUNBZ2JtRnRaVG9nVTNSeWFXNW5LQ2huSUNZbUlHY3VibUZ0WlNrZ2ZId2dKeWNwTG5SeWFXMG9LU3dLSUNBZ0lDQWdJQ0FnSUNBZ2RHVjRkSE02SUNobklDWW1JRUZ5Y21GNUxtbHpRWEp5WVhrb1p5NTBaWGgwY3lrZ1B5Qm5MblJsZUhSeklEb2dXMTBwTG0xaGNDZ29kQ2tnUFQ0Z1UzUnlhVzVuS0hRZ2ZId2dKeWNwTG5SeWFXMG9LU2t1Wm1sc2RHVnlLRUp2YjJ4bFlXNHBMQW9nSUNBZ0lDQWdJQ0FnSUNCeWIyeGxPaUFvWnlBbUppQm5Mbkp2YkdVcElEOGdVM1J5YVc1bktHY3VjbTlzWlNrZ09pQjFibVJsWm1sdVpXUXNDaUFnSUNBZ0lDQWdJQ0I5S1NrS0lDQWdJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tHY3BJRDArSUdjdWRHVjRkSE11YkdWdVozUm9LUW9nSUNBZ0lDQTZJRnRkT3dvZ0lDQWdhV1lnS0d4cGMzUXViR1Z1WjNSb0lEd2dNaWtnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnNtSUhzbDYzc25iUWc2N2FBN0tHeDdaV3A2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRsSVRyb0lqc25vVHJzNFFnN0xhVTdMS2NJT3lhbE95eXJUb2c3SmlCN0pldElDY2dLeUJzYVhOMExteGxibWQwYUNBcklDZnFzSnduSUNzZ0tHMXZjbVVnUHlBbklDanJqWlFnNjdDYjZyaXdLU2NnT2lBbkp5a3NJRzF2WkdWc0lEOGdKeWpycXFqcmpiZzZJQ2NnS3lCdGIyUmxiQ0FySUNjcEp5QTZJQ2NuS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSElnUFNCaGQyRnBkQ0JoYzJ0SGNtOTFjSE1vYkdsemRDd2diVzlrWld3c0lIc2djR0Z5YzJVNklIQmhjbk5sUjNKdmRYQnpMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5Sm5jbTkxY0hNaU9pQmJleUp1WVcxbElqb2dJdXlZZ2V5WHJTRHNuYlRycG9RaUxDQWljM1ZuWjJWemRHbHZibk1pT2lCYmV5SjBaWGgwSWpvZ0l1dU1nT3lWaUNJc0lDSnlaV0Z6YjI0aU9pQWk3SjIwN0p5Z0luMWRmVjE5SnlCOUxDQWhJVzF2Y21VcE93b2dJQ0FnSUNCamIyNXpkQ0J2ZFhRZ1BTQnlMbkJoY25ObFpEc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93b2dJQ0FnSUNCcFppQW9JVzkxZENrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJSHNnWlhKeWIzSTZJQ2Z0Z2JUcm9aenJrNXdnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJVaE91Z2lPeWVoT3V6aENEc29KenNsWWdnSnlBcklHOTFkQzV5WldSMVkyVW9LRzRzSUdjcElEMCtJRzRnS3lCbkxuTjFaMmRsYzNScGIyNXpMbXhsYm1kMGFDd2dNQ2tnS3lBbjZyQ2NJQzhnN0ppQjdKZXRJQ2NnS3lCdmRYUXViR1Z1WjNSb0lDc2dKK3F3bkNBb0p5QXJJSE5sWXlBcklDZHpLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnSjF2dGxJVHJvSWpzbm9UcnM0UmRJQ2NnS3lCVGRISnBibWNvS0d4cGMzUmJNRjBnSmlZZ2JHbHpkRnN3WFM1MFpYaDBjMXN3WFNrZ2ZId2dKeWNwTG5Oc2FXTmxLREFzSURJMEtUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGTmxZeUE5SUhObFl6c0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnWjNKdmRYQnpPaUJ2ZFhRc0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjZ2ZTazdDaUFnSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0bElUcm9JanNub1RyczRRZzdMYVU3TEtjSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc3WXlkN0plRklPeWFsT3lHak91emhDRHN0cFRzc3B3ZzRvQ1VJTzJWbkNEdGpKM3NsNFhzblpnZzZyV3M3SVN4N0pxVTdJYU1LT3lYcmUyVm9DdnJyTGpxdGF3cDY2VzhJTzJWbkNEcnNvanNsNUFnNjdDYjdKV0VJT3lYcmUyVm9PdXpoT3VobkNEcmk2VHJrNnpyaXBUcmk2UXVDaUFnTHk4ZzdKcVU3SWFNNjZXOElPMlZxT3E3bUNEcnM3VHJnclRzbGJ3ZzdZT0E3SjIwN1l1QTdKMjBJT3V6dU91c3VDRHJwNlhybmIzc25ZUWc3TEM0N0tHdzdaV2dJT3lJbUNEc25vanJpNlFvN0pxVTdJYU02N09FSU9xd25PdXpoQ0RzbXBUc3NxM3FzN3pzblpnZzdMQ283SjIwS1M0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0xYQnZjSFZ3SnlrZ2V3b2dJQ0FnWTI5dWMzUWdleUJsYkdWdFpXNTBjeXdnYlc5a1pXd3NJRzF2Y21VZ2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQmpiMjV6ZENCc2FYTjBJRDBnUVhKeVlYa3VhWE5CY25KaGVTaGxiR1Z0Wlc1MGN5a2dQeUJsYkdWdFpXNTBjeTVtYVd4MFpYSW9LR1VwSUQwK0lHVWdKaVlnVTNSeWFXNW5LR1V1ZEdWNGRDQjhmQ0FuSnlrdWRISnBiU2dwS1NBNklGdGRPd29nSUNBZ2FXWWdLR3hwYzNRdWJHVnVaM1JvSUR3Z01pa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmdGpKM3NsNFVnN0pxVTdJYU02ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRuSUgwcE93b2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5ZDdKZUZJT3kybE95eW5DRHNtcFRzc3EwNklPeWFsT3lHakNBbklDc2diR2x6ZEM1c1pXNW5kR2dnS3lBbjZyQ2NKeUFySUNodGIzSmxJRDhnSnlBbzY0MlVJT3V3bStxNHNDa25JRG9nSnljcExDQnRiMlJsYkNBL0lDY282NnFvNjQyNE9pQW5JQ3NnYlc5a1pXd2dLeUFuS1NjZ09pQW5KeWs3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yVUc5d2RYQW9iR2x6ZEN3Z2JXOWtaV3dzSUhzZ2NHRnljMlU2SUhCaGNuTmxVRzl3ZFhBc0lHWnZjbTFoZEVSbGMyTTZJQ2Q3SW5ObGRITWlPaUJiZXlKeVpXRnpiMjRpT2lBaTY3Q3A3WmFsSU8yVm5DRHJyTGpzbnFVaUxDQWlaV3hsYldWdWRITWlPaUJiZXlKeWIyeGxJam9nSXV5WHJlMlZvQ0lzSUNKMFpYaDBJam9nSXV1c3VPcTFyQ0o5TENBdUxpNWRmU3dnTGk0dVhYMG5JSDBzSUNFaGJXOXlaU2s3Q2lBZ0lDQWdJR052Ym5OMElITmxkSE1nUFNCeUxuQmhjbk5sWkRzS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3dvZ0lDQWdJQ0JwWmlBb0lYTmxkSE1wSUhzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVRuQ0RzblpIcmk3WHNuWVFnN1pXMDdJU2Q3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRqSjNzbDRVZzdJUzQ3WXE0SUNjZ0t5QnpaWFJ6TG14bGJtZDBhQ0FySUNmcXNKd2dLQ2NnS3lCelpXTWdLeUFuY3lrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlDZGI3WXlkN0plRlhTQW5JQ3NnVTNSeWFXNW5LQ2hzYVhOMFd6QmRJQ1ltSUd4cGMzUmJNRjB1ZEdWNGRDa2dmSHdnSnljcExuTnNhV05sS0RBc0lESTBLVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRk5sWXlBOUlITmxZenNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2MyVjBjeXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1uZXlYaFNEc2k2VHRqS2c2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5LU2s3Q2lBZ0lDQjlDaUFnZlFvZ0lDOHZJT3VNZ08yWmxPMllsU0RyckxqcXRhd2c3S0NjN0o2UklPS0FsQ0RzZzRIdG1hbnNuWVFnN0lTazY2cUY3WldZNjZtMElPdXN1T3Exck91bHZDRHJwNHpyazZUc2xyVHNwSURyaTZRZ0tPeTJsT3l5bk9xenZDRHFzSm5zbllBZzdJUzQ3SVdZTENEcmpJRHRtWlRyaXBRZzY2ZWtJT3lhbE95eXJleVhrQ0R0aHJYc3A3anJvWndnN0l1azY2YThLUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTlqYjIxd2IzTmxKeWtnZXdvZ0lDQWdZMjl1YzNRZ2V5QnRaWE56WVdkbGN5d2diVzlrWld3Z2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQmpiMjV6ZENCc2FYTjBJRDBnUVhKeVlYa3VhWE5CY25KaGVTaHRaWE56WVdkbGN5a2dQeUJ0WlhOellXZGxjeTVtYVd4MFpYSW9LRzBwSUQwK0lHMGdKaVlnVTNSeWFXNW5LRzB1ZEdWNGRDQjhmQ0FuSnlrdWRISnBiU2dwS1NBNklGdGRPd29nSUNBZ2FXWWdLQ0ZzYVhOMExteGxibWQwYUNrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZyaklEdG1aUWc2NEswN0pxcDdKMjBJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzNRZ2JHRnpkRlZ6WlhJZ1BTQmJMaTR1YkdsemRGMHVjbVYyWlhKelpTZ3BMbVpwYm1Rb0tHMHBJRDArSUcwdWNtOXNaU0FoUFQwZ0oyRnpjMmx6ZEdGdWRDY3BPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lnbk95ZWtTRHJqSUR0bVpRZzdKcVU3TEt0T2ljc0lGTjBjbWx1Wnlnb2JHRnpkRlZ6WlhJZ0ppWWdiR0Z6ZEZWelpYSXVkR1Y0ZENrZ2ZId2dKeWNwTG5Oc2FXTmxLREFzSURVd0tTNXlaWEJzWVdObEtDOWNiaTluTENBbklDY3BJQ3NnSitLQXBpQW82NHlBN1ptVUlDY2dLeUJzYVhOMExteGxibWQwYUNBcklDZnFzSndwSnlrN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNBdkx5RHJqSUR0bVpUcXNJQWc2cmk0N0phMDdLZUE2Nm0wSU95MW5PcTN2Q0F4TXVxd25PdW5qQ0FvN1pTRTY2R3M3WlNFN1lxNElPMlByZXlqdkNEcnNLbnNwNEFwQ2lBZ0lDQWdJR052Ym5OMElISWdQU0JoZDJGcGRDQmhjMnREYjIxd2IzTmxLR3hwYzNRdWMyeHBZMlVvTFRFeUtTd2diVzlrWld3c0lIc2djR0Z5YzJVNklIQmhjbk5sUTI5dGNHOXpaU3dnWm05eWJXRjBSR1Z6WXpvZ0ozc2ljbVZ3YkhraU9pQWk2NHlBN1ptVUlPeWRrZXVMdFNEdGxaenJrWkFnNjZ5NDdKNmxJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0o5TENBdUxpNWRmU2NnZlNrN0NpQWdJQ0FnSUdOdmJuTjBJRzkxZENBOUlISXVjR0Z5YzJWa093b2dJQ0FnSUNCamIyNXpkQ0J6WldNZ1BTQW9LRVJoZEdVdWJtOTNLQ2tnTFNCemRHRnlkR1ZrS1NBdklERXdNREFwTG5SdlJtbDRaV1FvTVNrN0NpQWdJQ0FnSUdsbUlDZ2hiM1YwS1NCN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJSHNnWlhKeWIzSTZJQ2Z0Z2JUcm9aenJrNXdnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPeWRrZXVMdFNBb0p5QXJJSE5sWXlBcklDZHpMQ0Rzb0p6c2xZZ2dKeUFySUc5MWRDNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dLeUFuNnJDY0tTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktDaHNZWE4wVlhObGNpQW1KaUJzWVhOMFZYTmxjaTUwWlhoMEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCeVpYQnNlVG9nYjNWMExuSmxjR3g1TENCemRXZG5aWE4wYVc5dWN6b2diM1YwTG5OMVoyZGxjM1JwYjI1ekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzY3S0k3SmV0SU9LQWxDRHRsWnpxdGEzc2xyUWc0b2FVSU95WWdleVd0Q0RzbnBEcmo1a2dLT3kybE95eW5PcXp2Q0Rxc0puc25ZQWc3SVM0N0lXWUlPeUNyT3lhcVNrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmRISmhibk5zWVhSbEp5a2dld29nSUNBZ1kyOXVjM1FnZXlCMFpYaDBMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmcnNvanNsNjN0bGFBZzY2eTQ2cldzNnJDQUlPdTVoT3lXdENEc25vanNpclhyaTRqcmk2UXVKeUI5S1RzS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNtcFRzc3EwNkp5d2dVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURVd0tTNXlaWEJzWVdObEtDOWNiaTluTENBbklDY3BJQ3NnSitLQXBpY3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NpQTlJR0YzWVdsMElHRnphMVJ5WVc1emJHRjBaU2hUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwTENCdGIyUmxiQ3dnZXlCd1lYSnpaVG9nY0dGeWMyVlVjbUZ1YzJ4aGRHVXNJR1p2Y20xaGRFUmxjMk02SUNkN0luUnlZVzV6YkdGMFpXUWlPaUFpNjdLSTdKZXQ2Nnk0SUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSmthWEpsWTNScGIyNGlPaUFpYTIvaWhwSmxiaURybUpEcmlwUWdaVzdpaHBKcmJ5SjlKeUI5S1RzS0lDQWdJQ0FnWTI5dWMzUWdiM1YwSUQwZ2NpNXdZWEp6WldRN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnZkWFFwSUhzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVRuQ0Ryc29qc2w2MGc3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95WmhPdWpqQ0FvSnlBcklITmxZeUFySUNkekxDQW5JQ3NnS0c5MWRDNWthWEpsWTNScGIyNGdmSHdnSno4bktTQXJJQ2NwSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbk5sY25abFpDc3JPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dNekFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QjBjbUZ1YzJ4aGRHVmtPaUJ2ZFhRdWRISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVPaUJ2ZFhRdVpHbHlaV04wYVc5dUxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdLSTdKZXRJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPdXlpT3lYclNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURRc0lIc2daWEp5YjNJNklDZE9iM1FnWm05MWJtUW5JSDBwT3dwOUtUc0tDaTh2SU95ZHRPdXZ1Q0RyaTZUcnBxenFzSUFnNjVhZ0lPeWVpT3VLbE91TnNDRHJtSkFnN0x5YzZyaXc2ckNBSU91VHBPeVd0T3lZcE91cHRDanNvSnpzaXFUc3NwZ2c3SjZRNjQrWklPeThuT3E0c0NEc3BKSHJzN1VnNjVPeEtTRHNvYkRzbXFudG5vZ2c3S0tGNjZPTUlPS0FsQ0RyajR6cmpaZ2c2NHVrNjZhczY0cVVJT3EzdU91TWdPdWhuQ0RzbktEc3A0QUtjMlZ5ZG1WeUxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQjdDaUFnYVdZZ0tHVWdKaVlnWlM1amIyUmxJRDA5UFNBblJVRkVSRkpKVGxWVFJTY3BJSHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbmJUcnI3Z2c3THljN0tDNElPeWVpT3lXdE95YWxDanRqNnp0aXJnZ0p5QXJJRkJQVWxRZ0t5QW5JT3lDck95YXFTRHNwSkVwSU9LQWxDRHNuYlFnN0oyNDdJcWs3WVMwN0lxazY0cVVJT3lpaGV1ampPMlZxZXVMaU91THBDNG5LVHNLSUNBZ0lIQnliMk5sYzNNdVpYaHBkQ2d3S1RzS0lDQjlDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUVuT3V5aENEc21LVHJwWmc2Snl3Z1pTQW1KaUJsTG0xbGMzTmhaMlVwT3dvZ0lIQnliMk5sYzNNdVpYaHBkQ2d4S1RzS2ZTazdDaTh2SU95V3RPdVdwQ0Rxc3Izcm9aenJvWndnN0tPOTY1T2dLT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFzSUVOMGNtd3JReXdnTDNOb2RYUmtiM2R1TENEc21LVHJwWmdwSUdOc1lYVmtaU0RzbnBEc2k1M3NuWVFnNjRLbzZyaXc3S2VBSU95Vml1dUtsT3VMcEFwd2NtOWpaWE56TG05dUtDZGxlR2wwSnl3Z0tDa2dQVDRnZXlCcmFXeHNVSEp2WXlncE95QnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lIMHBPd3B3Y205alpYTnpMbTl1S0NkVFNVZEpUbFFuTENBb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3BPd3B3Y205alpYTnpMbTl1S0NkVFNVZFVSVkpOSnl3Z0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBLVHNLQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc0tJQ0JqYjI1emIyeGxMbXh2WnlnbjRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FKeWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeUR0Z2JUcm9aenJrNXdnNjR1azY2YXNJT3k4bk95bmtDRGlnSlFnYUhSMGNEb3ZMMnh2WTJGc2FHOXpkRG9uSUNzZ1VFOVNWQ2s3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeURycXFqcmpiZzZJQ2NnS3lCRFRFRlZSRVZmVFU5RVJVd2dLeUFuSU1LM0lPeVlpT3lMbkNBbklDc2dSVmhCVFZCTVJWTXViR1Z1WjNSb0lDc2dKK3F4dENEc25xWHNzS2tuS1RzS0lDQmpiMjV6YjJ4bExteHZaeWduSU95ZHRDRHNzTDNzbllRZzdMeWM2NUdVSU91UG1leVZpQ0R0bEx6cXQ3anJwNGdnN1pTTTY1K3M2cmU0N0oyNDdKMjBJTzJCdE91aG5PdVRuT3VobkNEc3RwVHNzcHp0bGFucmk0anJpNlF1SnlrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSitLVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdDY3BPd29nSUdOb1pXTnJRMnhoZFdSbFFYWmhhV3hoWW14bEtDazdJQzh2SUVOc1lYVmtaU0JEYjJSbElPeUNyT3lhcVNEcXNJRHJpcVVnN0plczY3YUFJT3lna09xeWdDQW83WlNNNjUrczZyZTQ3SjI0SU95VmlPdUN0T3lhcVNrS0lDQXZMeURycjdqcnBxd2c3SXVjNjQrWklDc2c3S2VBN0l1YzY2eTRJT3lqdk95ZWhTRGlnSlFnN0xLcklPeTJsT3l5bk91MmdPMkVzQ0RydWFEcnBiVHFzb3dLSUNCaGMydERiR0YxWkdVb0oreWJqT3V3amV5WGhUb2dJdXlnZ095ZXBTRHJrSmpzbDRqc2lyWHJpNGpyaTZRaUp5a3VkR2hsYmlnS0lDQWdJQ2dwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbTR6cnNJM3NsNFVnN0ptRTY2T01JT0tBbENEc3RwVHNzcHdnN0tTQTY3bUVJT3VCblM0bktTd0tJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeUxwTzJNcUNBbzdMS3JJT3lhbE95eXJTRHJsWXdnN0o2czdJdWM2NCtFS1RvbkxDQmxMbTFsYzNOaFoyVXBDaUFnS1RzS2ZTazdDaTh2SUVsUWRqWWc2Nk9vN1pTRTY3Q3hLRG82TVNuc2w1RHJqNFFnN1pXbzZydVlJT3VUbyt1S2xPdUxwQ0RpZ0pRZ2JXRmpUMU1nNjVPeDdKZVE3SVNjSUNkc2IyTmhiR2h2YzNRbjZyQ0FJRG82TWV1aG5DRHJxTHpzb0lBZzdaVzA3SVNkNjVDWTY0cVU2NDJ3Q2k4dklPMlV2T3EzdU91bmlDaEZiR1ZqZEhKdmJpa2dabVYwWTJqcmlwUWdZM1Z5Yk9xenZDRHJpNnpycHF3Z1NWQjJOT3VobkNEc25wRHJqNWtnN1krMDY3Q3g3WldZN0tlQUlPeVZpdXlWaEN3Z1NWQjJOT3VuakNEcms2UHJqWmdnNjR1azY2YXM3SmVRSU95WHNPcXlzT3lkdENEcXNiRHJ0b0Ryajd3S0x5OGc3TGFVN0xLY3dyZnRsNnpzaXFUc3NyVHRnYXpxc0lBZzdLR3c3SnFwN1o2SUlPeUxwTzJNcU8yV2lPdUxwQ2pzaTZUc3VLRWdNakF5Tmkwd055a3VJT3F3bWV5ZGdDRHNtcFRzc3EwZzdaVzQ2NU9rNjUrczY2VzhJRWxRZGpZZzY2T283WlNFNjdDeDdKZVE2NCtFSU95V3VldUtsT3VMcEM0S1kyOXVjM1FnYzJWeWRtVnlOaUE5SUdoMGRIQXVZM0psWVhSbFUyVnlkbVZ5S0hObGNuWmxjaTVzYVhOMFpXNWxjbk1vSjNKbGNYVmxjM1FuS1Zzd1hTazdDbk5sY25abGNqWXViMjRvSjJWeWNtOXlKeXdnS0dVcElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCSlVIWTJLRG82TVNrZzY2YXM3SXFvSU95RG5ldWV0U0RpZ0pRZ1NWQjJOT3VuakNEc2dxenNtcWs2Snl3Z1pTQW1KaUJsTG0xbGMzTmhaMlVwS1RzS2MyVnlkbVZ5Tmk1c2FYTjBaVzRvVUU5U1ZDd2dKem82TVNjcE93bz0nCkI2NF9XQVRDSEVSPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rxc0pEc2k1enNucEFnNG9DVUlPMlZyZXlEZ1NEcmxxQWc3SjZJNjRxVUlPeTBpT3lHak8yWWxTRHNoSnpyc29RZ0tHeHZZMkZzYUc5emREb3hNVGc0T1NrTkNpOHZJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0EwS0x5OGc3Sm1jSU8yVmhPeWFsTzJWbk9xd2dEb2c3WlM4NnJlNDY2ZUk2ckNBSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JqYkdGMVpHVmljbWxrWjJVNkx5OGc3SmUwNnJpd0tIZHBibVJ2ZHk1dmNHVnVMMmxtY21GdFpTOXZjR1Z1UlhoMFpYSnVZV3dwNjZXOERRb3ZMeURzb0lUcnRvQWc3SWFNNjZhc0lPeVhodXlkdENEcnA0bnJpcFFnNjdLRTdLQ0U3SjIwSU95ZWlPdUxwQzRnWm1WMFkyanJpcFFnNjZxN0lPdW5pZXljdk91dmdPdWhuQ3dnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKRHNpNXpzbnBEc2w1RHFzb3dOQ2k4dklGQlBVMVFnTDNkaGEyVWc2Nlc4SU91enRPdUN0T3VwdENEcXNKRHNpNXpzbnBEcXNJQWc2NHVrNjZhc0tHTnNZWFZrWlMxaWNtbGtaMlV1YW5NcDY2VzhJT3VNZ095TG9DRHN2S0RyaTZRdURRb3ZMdzBLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQTBLTHk4ZzY2bVU2NnFvNjZhc0lINHhOVTFDNjUyOElPdWhuT3EzdU95ZHVDRHNpNXdnN0o2UTY0K1pJT3lMbk95ZWtleWN2T3VobkNEc2c0SHNpNXdnN0x5YzY1R3M2NCtFSU91MmdPdUx0Q0RzbDRicmk2UWdLT3VUc2V1aG5Ub2dibkJ0SUhKMWJpQmlkV2xzWkNrdURRb3ZMeURyaTZUcnBxenJpcFFnN0l1czdKNmw2N0NWNjQrWklPdUJpdXE0c091cHRDRHNvNzNzcDREcnA0d283WlNNNjUrczZyZTQ3SjI0NnJPOElPeURuZXlDckNEcmo1bnF1TER0bVpRcExDRHFzSkRzaTV6c25wRHJpcFFnNnJPRTdJYU5JT3VDcU95VmhDRHJpNlRzbll3ZzZybW83SnF3NnJpdzY2VzhJT3V3bSt1S2xPdUxwQzROQ2cwS1kyOXVjM1FnYUhSMGNDQTlJSEpsY1hWcGNtVW9KMmgwZEhBbktUc05DbU52Ym5OMElIQmhkR2dnUFNCeVpYRjFhWEpsS0Nkd1lYUm9KeWs3RFFwamIyNXpkQ0JtY3lBOUlISmxjWFZwY21Vb0oyWnpKeWs3RFFwamIyNXpkQ0J2Y3lBOUlISmxjWFZwY21Vb0oyOXpKeWs3RFFwamIyNXpkQ0I3SUhOd1lYZHVMQ0J6Y0dGM2JsTjVibU1nZlNBOUlISmxjWFZwY21Vb0oyTm9hV3hrWDNCeWIyTmxjM01uS1RzTkNnMEtZMjl1YzNRZ1VFOVNWQ0E5SURFeE9EZzVPdzBLWTI5dWMzUWdVazlQVkNBOUlIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljcE95QXZMeURzb0lEc25xWHNob3dnNjZPbzdZcTRJT0tBbENEcmk2VHJwcXpxc0lBZ2NtVmpiMjF0Wlc1a0xXVjRZVzF3YkdWekxtMWs2Nlc4SU95d3Z1dUtsQ0RxdUxEc3BJQU5DZzBLWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3MEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0U0dWaFpHVnljeWM2SUNkRGIyNTBaVzUwTFZSNWNHVW5MQTBLZlRzTkNtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXcwS0lDQnlaWE11ZDNKcGRHVklaV0ZrS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MFpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2dZMmhoY25ObGREMTFkR1l0T0NjZ2ZTd2dRMDlTVTE5SVJVRkVSVkpUS1NrN0RRb2dJSEpsY3k1bGJtUW9TbE5QVGk1emRISnBibWRwWm5rb2IySnFLU2s3RFFwOURRb05DaTh2SUdOc1lYVmtaU0JEVEVucXNJQWc3SjZJNjRxVTdLZUFJT0tBbENEc2w0YnNuTHpycWJRZ0wzZGhhMlVnN0oyUjY0dTE3SmVRSU95THBPeVd0Q0R0bEl6cm42enF0N2pzbmJqc25iUWc3SldJNjRLMDdaV2dJT3lJbUNEc25vanFzb3dnN1pXYzY0dWtEUW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPeWR2ZXE0c0NEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpJQ2pyaTZUcnBxenNuWmdnWTJ4aGRXUmxRV05qYjNWdWRPeVpnQ0Rxc0puc25ZQWc3TGFjN0xLWUtTNE5DaTh2SU8yTWpPeWR2T3lkdENEdGdiUWc3SWlZSU95ZWlPeVd0Q0F6TU95MGlDRHN1cERzaTV3dUlPeWVyT3Vobk9xM3VPeWR1TzJWbU91cHRDQkRURW5xc0lBZzdZeU03SjI4N0oyRUlPcXdzZXlMb08yVm1PdXZnT3VobkNEc25wRHJqNWtnNjdDWTdKaUI2NUNjNjR1a0xnMEtMeThnN0xxUTdJdWNJRFhzdElnZzRvQ1VJT3Vobk9xM3VPeWR1Q0RzcDRIdG00UWc3SU9JSU9xemhPeWdsZXlkdENEcXM2ZnJzSlRyb1p3ZzdKNmg3WmlBN0pXOElPMlVqT3Vmck9xM3VPeWR1T3lkdENEcm9aenF0N2pzbmJnZzdabVU2Nm0wN0plUTdJU2NJTzJaaU95Y3ZPdWhuQ0RyaEpqc2xyVHFzSVRyaTZRb016RHN0SWpycWJRZzY0U0k2NnkwSU91S3B1eWRqQ2tOQ214bGRDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUF3TENCbGJXRnBiRG9nYm5Wc2JDQjlPdzBLWm5WdVkzUnBiMjRnWTJ4aGRXUmxRV05qYjNWdWRDZ3BJSHNOQ2lBZ2FXWWdLRVJoZEdVdWJtOTNLQ2tnTFNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUENBMU1EQXdLU0J5WlhSMWNtNGdZV05qYjNWdWRFTmhZMmhsTG1WdFlXbHNPdzBLSUNCc1pYUWdaVzFoYVd3Z1BTQnVkV3hzT3cwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTNXFjMjl1Snlrc0lDZDFkR1k0SnlrcE93MEtJQ0FnSUdWdFlXbHNJRDBnS0dvZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpLU0I4ZkNCdWRXeHNPdzBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcm9aenF0N2pzbmJnZzdKMjA2NkNsSU95WGh1eWRqQ0RyazdFZzRvQ1VJRzUxYkd3Z0tpOGdmUTBLSUNCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQkVZWFJsTG01dmR5Z3BMQ0JsYldGcGJDQjlPdzBLSUNCeVpYUjFjbTRnWlcxaGFXdzdEUXA5RFFvTkNtWjFibU4wYVc5dUlHaGhjME5zWVhWa1pTZ3BJSHNOQ2lBZ1kyOXVjM1FnWm1sdVpHVnlJRDBnY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlBL0lDZDNhR1Z5WlNjZ09pQW5kMmhwWTJnbk93MEtJQ0IwY25rZ2V5QnlaWFIxY200Z2MzQmhkMjVUZVc1aktHWnBibVJsY2l3Z1d5ZGpiR0YxWkdVblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY3NJSE5vWld4c09pQjBjblZsSUgwcExuTjBZWFIxY3lBOVBUMGdNRHNnZlNCallYUmphQ0FvWDJVcElIc2djbVYwZFhKdUlHWmhiSE5sT3lCOURRcDlEUW9OQ214bGRDQjNZV3RwYm1jZ1BTQm1ZV3h6WlRzZ0x5OGc3SmV3N1lPQUlPdXdxZXluZ0NEaWdKUWc2NHVrNjZhczY0cVVJT3lXdE95d3FPMlV2Q0JGUVVSRVVrbE9WVk5GNjZHY0lPeWtrZXV6dFNEc29KWHJwcXp0bFpqc3A0RHJwNHdnN1pTRTY2R2M3SVM0N0lxa0lPdUNyZXU1aE91bHZDRHNwSVRzbmJqcmk2UU5DbVoxYm1OMGFXOXVJSGRoYTJWQ2NtbGtaMlVvS1NCN0RRb2dJR2xtSUNoM1lXdHBibWNwSUhKbGRIVnlianNOQ2lBZ2QyRnJhVzVuSUQwZ2RISjFaVHNOQ2lBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0lIZGhhMmx1WnlBOUlHWmhiSE5sT3lCOUxDQTFNREF3S1RzTkNpQWdiR1YwSUhCeWIyTTdEUW9nSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3RFFvZ0lDQWdMeThnVjJsdVpHOTNjem9nWTIxa3dyZDJZbk1nNnJLOTdKeWdJT3lYaHV5ZHRDQnViMlJsNjZXOElPeW5nZXlna1N3Z2QybHVaRzkzYzBocFpHVW9RMUpGUVZSRlgwNVBYMWRKVGtSUFZ5bnJvWndnN0lxazdZK3dJT0tBbEEwS0lDQWdJQzh2SU95d3ZTRHNsNGJyaXBRZzdJaW83SjJBSU95OW1PeUdsT3lkdENEcnA0enJrNlRzbHJUc3A0RHFzNkFnNjR1azY2YXM3SjJZSU95ZWtPeUxuU2hqYkdGMVpHVXA2NCtFSU9xM3VDRHN2WmpzaHBUc25ZUWc2Nnk4NjZDazY3Q2I3SldFSU95V3RPdVdwQ0Rzc0wzcmo0UWc3SldJSU91Y3JPdUxwQzROQ2lBZ0lDQXZMeUJrWlhSaFkyaGxaT3VLbENEc2s3RHNwNEFnN0pXSzY0cVU2NHVrS0dSbGRHRmphR1ZrSzNkcGJtUnZkM05JYVdSbElPeWhzTzJWcWV5ZGdDRHN2WmpzaHBRZzdMQzk3SjIwSU91RnVPeTJuT3VRcUNEaWdKUWc3SXVrN0xpaEtTNE5DaUFnSUNBdkx5QlhhVzVrYjNkejdKZVE3SVNnSUdSbGRHRmphR1ZrSU95WGh1eWR0T3VQaENEcnRvRHJxcWdvNnJDUTdJdWM3SjZRS2Vxd2dDRHNvNzNzbHJUcmo0UWc3SjZRN0l1ZDdKMkFJT3lDdE95VmhPdUNxT3VLbE91THBDNE5DaUFnSUNCd2NtOWpJRDBnYzNCaGQyNG9jSEp2WTJWemN5NWxlR1ZqVUdGMGFDd2dXM0JoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNkamJHRjFaR1V0WW5KcFpHZGxMbXB6SnlsZExDQjdEUW9nSUNBZ0lDQmpkMlE2SUZKUFQxUXNJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVXNEUW9nSUNBZ2ZTazdEUW9nSUgwZ1pXeHpaU0I3RFFvZ0lDQWdMeThnYldGalQxTXY2NmFzNjRpRjdJcWtPaURxc0pEc2k1enNucERycGJ3ZzY1MkU3SnEwSUc1dlpHVWc3SXVrN1phSklPMk1qT3lkdk91aG5DRHNwNEhzb0pFZzdJcWs3WSt3SUNoc1lYVnVZMmhrSU8yWm1PcXl2ZXlYbENCUVFWUkk2ckNBSU91NWlPeVZ2ZTJWb0NEc2lKZ2c3SjZJN0phMElPeWdpT3VNZ09xeXZldWhuQ0RzZ3F6c21xa3BEUW9nSUNBZ2NISnZZeUE5SUhOd1lYZHVLSEJ5YjJObGMzTXVaWGhsWTFCaGRHZ3NJRnR3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBblkyeGhkV1JsTFdKeWFXUm5aUzVxY3ljcFhTd2dldzBLSUNBZ0lDQWdZM2RrT2lCU1QwOVVMQ0JrWlhSaFkyaGxaRG9nZEhKMVpTd2djM1JrYVc4NklDZHBaMjV2Y21VbkxBMEtJQ0FnSUgwcE93MEtJQ0I5RFFvZ0lIQnliMk11ZFc1eVpXWW9LVHNnTHk4ZzZyQ1E3SXVjN0o2UUlPeWR0T3V5cE8yS3VDRHJvNmp0bElUc2w1RHNoSndnNjdhRTY2YXNJQ2pxc0pEc2k1enNucEFnN0tLRjY2T002Nlc4SU91bmlleW5nQ0RzbFlycXNvd3BEUXA5RFFvTkNpOHZJT3lkdENCUVErdWx2Q0FuN0lTazdMbVlJT3lnaENqc2c0Z2dVRU1wSnlEc2c0SHRnNXpyb1p3ZzY1Q1k2NCtNNjZhdzY0dWtJT0tBbENEdGxJenJuNnpxdDdqc25iZ2dXK3kwaU9xNHNPMlpsRjBnNjdLRTdZcThLRkJQVTFRZ0wzVnVhVzV6ZEdGc2JDbnNuYlFnNjdhQTY2VzQ2NHVrTGcwS0x5OGdjbVZuYVhOMFpYSXRjSEp2ZEc5amIyd3VhblBxc0lBZzdJU2s3TG1ZN1pXY0lPcXlnK3lkaENEcXQ3anJqSURyb1p3ZzY1Q1k2NCtNNjZhdzY0dWtPaURxc0pEc2k1enNucEFnN0o2UTY0K1o3SXVjN0o2UklDc2dLT3llaU95Y3ZPdXB0Q2tnN0lTazdMbVlJTzJQdE91TmxDNE5DaTh2SU9LYW9PKzRqeURyc0pqcms1enNpNXdnU0ZSVVVDRHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPdXp0T3VDdUNEcmtxUWc3Wmk0N0xhYzdaV2dJT3F5Z3lEaWdKUWdiV0ZqVDFNZ2JHRjFibU5vWTNSc0lHSnZiM1J2ZFhUc25iUWc3SjIwSU8yVWhPdWhuT3lFdU95S3BPdWx2Q0RzcG9uc2k1d2c3S0tGNjZPTTdJdWM3WUtzSU95SW1DRHNub2pyaTZRdURRb3ZMeUFnSUNEcXQ3anJucGpzaEp3ZzdZeU03SjI4S0hCc2FYTjB3cmZzaEtUc3VaZ2c3WSswNjQyVUtleWRoQ0JzWVhWdVkyaGpkR3pyczdUcmk2UWc2Nmk4N0tDQUlPeW5nT3lhdE91THBDRGlnSlFnWW05dmRHOTFkT3lkdENEc21yRHJwcXpycGJ3ZzdLTzk3SmVzNjQrRUlPeWVrT3VQbWV5TG5PeWVrZXlkZ0NEc25iVHJyN2dnN0lLczY1Mjg3S2VFNjR1a0xnMEtablZ1WTNScGIyNGdkVzVwYm5OMFlXeHNVMlZzWmlncElIc05DaUFnWTI5dWMzUWdjbVZ0YjNabFpDQTlJRnRkT3cwS0lDQjBjbmtnZXcwS0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5aR0Z5ZDJsdUp5a2dldzBLSUNBZ0lDQWdZMjl1YzNRZ1RFRkNSVXdnUFNBblkyOXRMbU5zWVhWa1pXSnlhV1JuWlM1M1lYUmphR1Z5SnpzTkNpQWdJQ0FnSUdOdmJuTjBJSEJzYVhOMElEMGdjR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0oweHBZbkpoY25rbkxDQW5UR0YxYm1Ob1FXZGxiblJ6Snl3Z1RFRkNSVXdnS3lBbkxuQnNhWE4wSnlrN0RRb2dJQ0FnSUNCamIyNXpkQ0JwYm5OMElEMGdjR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0oweHBZbkpoY25rbkxDQW5RWEJ3YkdsallYUnBiMjRnVTNWd2NHOXlkQ2NzSUNkRGJHRjFaR1ZDY21sa1oyVW5LVHNOQ2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktIQnNhWE4wS1NrZ2V5Qm1jeTUxYm14cGJtdFRlVzVqS0hCc2FYTjBLVHNnY21WdGIzWmxaQzV3ZFhOb0tIQnNhWE4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLR2x1YzNRcEtTQjdJR1p6TG5KdFUzbHVZeWhwYm5OMExDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTd2dabTl5WTJVNklIUnlkV1VnZlNrN0lISmxiVzkyWldRdWNIVnphQ2hwYm5OMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DaUFnSUNBZ0lIUnllU0I3SUhOd1lYZHVVM2x1WXlnbmJHRjFibU5vWTNSc0p5d2dXeWRpYjI5MGIzVjBKeXdnSjJkMWFTOG5JQ3NnY0hKdlkyVnpjeTVuWlhSMWFXUW9LU0FySUNjdkp5QXJJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHNZWFZ1WTJoamRHd25MQ0JiSjNKbGJXOTJaU2NzSUV4QlFrVk1YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwS0lDQWdJSDBnWld4elpTQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3MEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0NkeVpXY25MQ0JiSjJSbGJHVjBaU2NzSUNkSVMwTlZYRnhUYjJaMGQyRnlaVnhjVFdsamNtOXpiMlowWEZ4WGFXNWtiM2R6WEZ4RGRYSnlaVzUwVm1WeWMybHZibHhjVW5WdUp5d2dKeTkySnl3Z0owTnNZWFZrWlVKeWFXUm5aVmRoZEdOb1pYSW5MQ0FuTDJZblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUhKbGJXOTJaV1F1Y0hWemFDZ243SjZRNjQrWjdJdWM3SjZSS0VOc1lYVmtaVUp5YVdSblpWZGhkR05vWlhJcEp5azdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0NkeVpXY25MQ0JiSjJSbGJHVjBaU2NzSUNkSVMwTlZYRnhUYjJaMGQyRnlaVnhjUTJ4aGMzTmxjMXhjWTJ4aGRXUmxZbkpwWkdkbEp5d2dKeTltSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPeUJ5WlcxdmRtVmtMbkIxYzJnb0oyTnNZWFZrWldKeWFXUm5aVG92THlEcms3SHJvWjBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdJQ0IwY25rZ2V3MEtJQ0FnSUNBZ0lDQmpiMjV6ZENCcGJuTjBJRDBnY0dGMGFDNXFiMmx1S0hCeWIyTmxjM011Wlc1MkxreFBRMEZNUVZCUVJFRlVRU0I4ZkNCd1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuUVhCd1JHRjBZU2NzSUNkTWIyTmhiQ2NwTENBblEyeGhkV1JsUW5KcFpHZGxKeWs3RFFvZ0lDQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlEwS0lDQWdJQ0FnZlNCallYUmphQ0FvWDJVcElIdDlEUW9nSUNBZ2ZRMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUJtWVdsc0xYTnZablFnNG9DVUlPdXF1eURzcDREc21yUWc2cktNSU95ZWlPeVd0T3VQaENEdGxJenJuNnpxdDdqc25iZ2c3S3E5SU9xNHNPeVd0U0RzZ3Ezc29KenJpcFFnN0oyMDY2KzRJT3VCbmV1Q3JPdUxwQ0FxTHlCOURRb2dJSEpsZEhWeWJpQnlaVzF2ZG1Wa093MEtmUTBLRFFvdkx5RHJpNlRycHF3b01URTRPRGdwNnJDQUlPdVdvQ0Rzbm9qc25MenJxYlFnNjRHSTY0dWtJT0tBbENEc3RJanF1TER0bVpRZzdJdWNJT3VDcU95ZGdDRHNoTGpzaFpnZzdLQ1Y2NmFzSUNqc2w0YnNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeUxwTzJNcUNrTkNtWjFibU4wYVc5dUlITm9kWFJrYjNkdVFuSnBaR2RsS0NrZ2V3MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJSElnUFNCb2RIUndMbkpsY1hWbGMzUW9leUJvYjNOME9pQW5NVEkzTGpBdU1DNHhKeXdnY0c5eWREb2dNVEU0T0Rnc0lIQmhkR2c2SUNjdmMyaDFkR1J2ZDI0bkxDQnRaWFJvYjJRNklDZFFUMU5VSnl3Z2RHbHRaVzkxZERvZ01UVXdNQ0I5TENBb0tTQTlQaUI3ZlNrN0RRb2dJQ0FnY2k1dmJpZ25aWEp5YjNJbkxDQW9LU0E5UGlCN2ZTazdEUW9nSUNBZ2NpNXZiaWduZEdsdFpXOTFkQ2NzSUNncElEMCtJSHNnZEhKNUlIc2djaTVrWlhOMGNtOTVLQ2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmU0I5S1RzTkNpQWdJQ0J5TG1WdVpDZ3BPdzBLSUNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ24wTkNnMEtZMjl1YzNRZ2MyVnlkbVZ5SUQwZ2FIUjBjQzVqY21WaGRHVlRaWEoyWlhJb0tISmxjU3dnY21WektTQTlQaUI3RFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5UMUJVU1U5T1V5Y3BJSHNnY21WekxuZHlhWFJsU0dWaFpDZ3lNRFFzSUVOUFVsTmZTRVZCUkVWU1V5azdJSEpsZEhWeWJpQnlaWE11Wlc1a0tDazdJSDBOQ2lBZ2FXWWdLSEpsY1M1MWNtd2dQVDA5SUNjdmFHVmhiSFJvSnlrZ2V3MEtJQ0FnSUM4dklIWTZJT3F3a095TG5PeWVrQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0RxdGF6cnNvVHNvSVFnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3F6aE95R2pTRHJqNHpxczZBZzdKNkk2NHFVN0tlQUlPdXdsdXlYa095RW5DRHRtWlhzbmJqdGxaanJpcFFnN0pxcDY0K0VEUW9nSUNBZ0x5OGdLSFl5SUQwZzdMQzlJT3lJcU9xNWdDRHNpSmpzb0pYdGpKQXNJSFl6SUQwZ0wyRmpZMjkxYm5RZzdMYVU2ckNBN1l5UUxDQjJOQ0E5SUM5MWJtbHVjM1JoYkd3ZzdMYVU2ckNBN1l5UUtRMEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0IzWVhSamFHVnlPaUIwY25WbExDQjJPaUEwSUgwcE93MEtJQ0I5RFFvZ0lDOHZJT3lkdENCUVEreVhrQ0Ryb1p6cXQ3anNuYmpya0p3ZzdZRzA2NkdjNjVPY0lPcXpoT3lnbFNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SU95eXF5RHRtWlRycWJUQ3QrMlppT3lkdENBaTY0aUU2cldzSU9xemhPeWdsZXljdk91aG5DRHNrN0RyaXBUc3A0QWlJT3V6dE95WHJPeWp2T3VLbENEcmpiQWc3Sk8wNjR1a0xnMEtJQ0F2THlEcXNKRHNpNXpzbnBEcXNJQWc2NHUxN1pXWTY0cVVJT3lkdE95Y29Eb2c2NHVrNjZhczY2VzhJT3k4bk91cHRDRHNtNHpyc0kzc2w0WHNuTHpyb1p3ZzdZRzA2NkdjNjVPYzZyQ0FJT3lMcE95Z25DRHRtTGpzdHB6cmo3d2c2cldzNjQrRklPeUNyT3lhcWV1ZmlleWR0Q0RyZ3BqcXNJVHJpNlF1RFFvZ0lDOHZJT3F3a095TG5PeWVrT3VLbENEdGpJenNuYnpycDR3ZzdKMjk3Snk4NjYrQTY2R2NJT3lDck95YXFldWZpU0F3SU1LM0lPdU1nT3E0c0NBd0lPS0FsQ0Rxc29EdGhxRHJwNHdnN0pPdzY0cVVJT3lDck91ZWpPeVhrT3F5akNEcnVZVHNtcW5zbllRZzY2eTg2NmFzN0tlQUlPeVZpdXVLbE91THBDNE5DaUFnTHk4ZzdLTzg3SjJZT2lEc2w2enF1TEFnNnJPRTdLQ1Y3SjIwSU91enRPeVhyT3VQaENEc25vWHNucVhxdG96c25iUWc2NmVNNjZPTTY1Q1E3SjJFSU95SW1DRHNub2pyaTZRbzdKeWc3WnFvN0lTeDdKMkFJT3lMcE95Z25DRHRtTGpzdHB3ZzY1V002NmVNSU95VmpDRHNpSmdnN0o2STdKMk1JT0tBbENEcmk2VHJwcXdnTDJobFlXeDBhT3lkbUNCd2NtOWliR1Z0SU95d3VPcXpvQ2t1RFFvZ0lHbG1JQ2h5WlhFdWRYSnNJRDA5UFNBbkwyRmpZMjkxYm5RbktTQjdEUW9nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUdGalkyOTFiblE2SUdOc1lYVmtaVUZqWTI5MWJuUW9LU3dnWTJ4aGRXUmxPaUJvWVhORGJHRjFaR1VvS1NCOUtUc05DaUFnZlEwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmQyRnJaU2NwSUhzTkNpQWdJQ0JwWmlBb0lXaGhjME5zWVhWa1pTZ3BLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nWm1Gc2MyVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y2dmU2s3RFFvZ0lDQWdkMkZyWlVKeWFXUm5aU2dwT3cwS0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQjNZV3RwYm1jNklIUnlkV1VnZlNrN0RRb2dJSDBOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNOb2RYUmtiM2R1SnlrZ2V3MEtJQ0FnSUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0RRb2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJREl3TUNrN0RRb2dJQ0FnY21WMGRYSnVPdzBLSUNCOURRb2dJQzh2SU95MGlPcTRzTzJabENEaWdKUWc3SjIwSUZCRDY2VzhJQ2ZzZzRnZ1VFTW5JT3lEZ2UyRG5PdWhuQ0Rya0pqcmo0enJwckRyaTZRZ0tPMlVqT3Vmck9xM3VPeWR1Q0JiN0xTSTZyaXc3Wm1VWFNEcnNvVHRpcndwTGcwS0lDQXZMeURzblpIcmk3WHNuWVFnNjZpODdLQ0FJTzJkbU91Z3BPdXp0T3VDdUNEcmtxUWc3S0NWNjZhczdaV2M2NHVrSU9LQWxDQmliMjkwYjNWMDdKMjBJT3lhc091bXJPdWx2Q0RzcG9uc2k1d2c3S085N0plczY0K0VJTzJhak95TG9PeWRnQ0RyajRUc3NLbnRsWnpyaTZRdURRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OTFibWx1YzNSaGJHd25LU0I3RFFvZ0lDQWdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2djR3hoZEdadmNtMDZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdmU2s3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdEUW9nSUNBZ0lDQnphSFYwWkc5M2JrSnlhV1JuWlNncE93MEtJQ0FnSUNBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUhWdWFXNXpkR0ZzYkZObGJHWW9LVHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYmQyRjBZMmhsY2wwZzdMU0k2cml3N1ptVUtIVnVhVzV6ZEdGc2JDa2c0b0NVSU95Z25PcXhzRG9uTENCeVpXMXZkbVZrTG1wdmFXNG9KeXdnSnlrZ2ZId2dKeWpzbDRic25Zd3BKeWs3RFFvZ0lDQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSEJ5YjJObGMzTXVaWGhwZENnd0tTd2dNakF3S1RzTkNpQWdJQ0I5TENBeU5UQXBPdzBLSUNBZ0lISmxkSFZ5YmpzTkNpQWdmUTBLSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd05Dd2dleUJsY25KdmNqb2dKMDV2ZENCbWIzVnVaQ2NnZlNrN0RRcDlLVHNOQ2cwS0x5OGc3SjIwNjYrNElPdVdvQ0Rzbm9qc25MenJxYlFnN0tHdzdKcXA3WjZJSU95aWhldWpqQ0FvN0o2UTY0K1pJT3lMbk95ZWtTQXJJRzV3YlNCaWRXbHNaQ0RzcEpIcnM3VWc3SXVrN1phSklPdU1nT3U1aENrTkNuTmxjblpsY2k1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V3MEtJQ0JwWmlBb1pTQW1KaUJsTG1OdlpHVWdQVDA5SUNkRlFVUkVVa2xPVlZORkp5a2djSEp2WTJWemN5NWxlR2wwS0RBcE93MEtJQ0J3Y205alpYTnpMbVY0YVhRb01TazdEUXA5S1RzTkNuTmxjblpsY2k1c2FYTjBaVzRvVUU5U1ZDd2dKekV5Tnk0d0xqQXVNU2NzSUNncElEMCtJSHNOQ2lBZ1kyOXVjMjlzWlM1c2IyY29KMXQzWVhSamFHVnlYU0R0Z2JUcm9aenJrNXdnNjR1azY2YXNJT3F3a095TG5PeWVrQ0Rzdkp6c3A1QWc0b0NVSUdoMGRIQTZMeTlzYjJOaGJHaHZjM1E2SnlBcklGQlBVbFFwT3cwS2ZTazdEUW92THlCSlVIWTJJT3VqcU8yVWhPdXdzU2c2T2pFcDdKZVE2NCtFSU8yVnFPcTdtQ0RyazZQcmlwVHJpNlFnNG9DVUlDZHNiMk5oYkdodmMzUW42ckNBSURvNk1ldWhuQ0RycUx6c29JQWc3WlcwN0lTZDY1Q1k2NHFVSU8yWm1PcXl2ZXlYa095RW5BMEtMeThnN1pTODZyZTQ2NmVJSUdabGRHTm82ckNBSUVsUWRqVHJvWndnN1krMDY3Q3g3WldZN0tlQUlPeVZpdXlWaENEcmk2VHJwcXdnNnJtbzdKcXc2cml3d3JmcXM0VHNvSlVnN0tHdzdacU02ckNBSU95aHNPeWFxZTJlaUNEc2k2VHRqS2p0bFpqcmpaZ2c2Nnk0N0tDY0lPdU1nT3lka1Nqcmk2VHJwcXpzbVlBZzY0K1o3SjI4S1M0TkNtTnZibk4wSUhObGNuWmxjallnUFNCb2RIUndMbU55WldGMFpWTmxjblpsY2loelpYSjJaWEl1YkdsemRHVnVaWEp6S0NkeVpYRjFaWE4wSnlsYk1GMHBPdzBLYzJWeWRtVnlOaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3ZlNrN0lDOHZJRG82TWV5ZGhDRHJxcnNnN0o2aDdKV0U2NCtFS0VWQlJFUlNTVTVWVTBYQ3QwbFFkallnN0plRzdKMk1LU0JKVUhZMDY2ZU03Snk4NjZHY0lPcXpoT3lHalNEcmo1bnNucEVOQ25ObGNuWmxjall1YkdsemRHVnVLRkJQVWxRc0lDYzZPakVuS1RzTkNnPT0nCkI2NF9FWEFNUExFUz0nSXlEcnJManF0YXdnN0xhVTdMS2NJT3lZaU95TG5Bb0tJdXVzdU9xMXJDRHN0cFRzc3B6cnNKdnF1TEFpNnJDQUlPeUNyT3lhcWUyVm1PdUtsQ0RzbUlqc2k1d2c2NnFvN0oyTTdKNkY2NHVJNjR1a0xpQXFLdXlkdENEdGpJenNuYnpzbllRZzdJaVk3S0NWN1pXY0lPdVNwQ0R0aExEcnI3anJoSkRzbDVEc2hKd2dZRzV3YlNCeWRXNGdZblZwYkdSZzY2VzhJT3lMcE8yV2llMlZtT3F6b0N3Z1JtbG5iV0hzbDVEc2hKd2c3WlNNNjUrczZyZTQ3SjI0N0oyRUlPdUxwT3lMbkNEc2k2VHRsb250bFpqcnFiUWc2N0NZN0ppQjY1Q3A2NHVJNjR1a0xpb3FDZ29qSXlEc25wSHNoTEVnNjdDcDY3S1ZDZ290SU95WWlPeUxuQ0R0bFpqcmdwanJpcFFnS2lwZ0l5TWpJT3lia091enVHQXFLaUR0bFp3ZzdLU0U2ck84TENEcXQ3Z2c3SldFNjU2WUlDb3FZQzBnN0xhVTdMS2M3SldJWUNvcUlPeVhyT3VmckNEcXNKenJvWndnN0oyMDY2U0U3S2VSNjR1STY0dWtMZ290SU95MmxPeXluT3lWaUNEc2xZanNsNURzaEp3Z0tpcnNwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydGxhbnJpNGpyaTZRZzRvQ1VJT3lkdE91bWhNSzM3SWlZNjUrSndyZnJzb2p0bUxqcnA0d2c2NHVrNjZXNElPdXN1T3Exck91UGhDRHFzSm5zbllBZzdKaUk3SXVjNjZHY0lPeWVvZTJZZ095YWxDNGc2NHVvTENEc3RwVHNzcHpzbFlqc2w1QWc3S0NCN0phMDY1R1VJT3lkdE91bWhNSzM3SWlyN0o2UTY0cVVJT3EzdU91TWdPdWhuQ0RyZ3Bqc21LVHJpNGdnN0l1azdLQ2NJT3F3a3V5WGtDRHJwNTdxc293ZzZyT2c3TE9RSU95VHNPeUV1T3lhbEM0S0xTRHNvSnpycXFrb1lDTWpZQ25xczd3Z1lDTWpJMkFzSUdBdFlDRHF1TER0bUxqcmlwUWc3WmlWN0l1ZDdKMjA2NHVJSU91d2xPcSt1T3luZ0NEcnA0anNoTGpzbXBRdUNnb2pJeURzaXFUdGc0RHNuYndnN0p1UTdMbVpJQ2pzc0xqcXM2QWc0b0NVSU95ZWtPeUV1TzJWbkNEcmdyVHNtcW5zbllBZ2RYZ3RkM0pwZEdsdVp5NXRaQ0Rxc0lEc25iVHJrNXdwQ2dvdElPMlZ0T3lhbE95eXRDd2c2N2FBNjVPYzY1K3M3SnEwSU95aWhlcXlzQ2hnZnV5ZWlPeVd0T3lhbEdBZ1lIN3JqN3pzbXBSZ0lHQis3SmVHN0phMDdKcVVZQ0JnZnUyVnRDRHNvN3pzaExqc21wUmdLUW90SURMcmk2Z2c2cldzN0tHd09pQXFLdXl5cXlEc3BJUTk3SU9CN1ptcElPeUVwT3VxaFNEaWhwSWc2NUdZN0tlNElPeWtoRDNyaTZUc25Zd2c3WmFKNjQrWktpb282ckt3N0tDVjdKMkFJR0IrN1pXZzZybU03SnFVUDJBc0lPMldpZXVQbVNEc25LRHJqNFRyaXBRZ1lIN3RsYlFnN0tPODdJUzQ3SnFVWUNrS0xTRHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdLT3VRa095V3RPeWFsT0tHa3UyV2lPeVd0T3lhbENrc0lPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQW83SmVHN0phMDdKcVU0b2FTZnUyVm1PdXB0Q0R0bGFBZzdJaVlJT3llaU95V3RPeWFsQ2tLTFNEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phMEtIN3NpNXpxc3FEc2xyVHNtcFEvNG9hU2Z1MlZvT3E1ak95YWxEOHBMQ0RycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQ2pzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjNG9hUzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc3Q2anNob3p0bGFBZzZySzk3SnF3SU95YWxPeXlyU0RyZ3JUc2w2M3JqNFFnN0lLdDdLQ2M2NCs4N0pxVUxpQXZJT3F6dGV5Y29DRHNtcFRzc3Ezc25ZUWc3TGVvN0lhTTdaV2c2cm1NN0pxVVB3b0tJeU1qSU9xNHNPcTRzT3VsdkNEc3NMN3NwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WldZN0lTNDdKcVVMZ290SU9xNHNPcTRzT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlXdE95YWxDNGdMeUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXWTZyaXdJT3lnaE95WGtPdUtsQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxBb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0tlQTZyaUlJT3V5aE95Z2hPeVhrT3lFbk91S2xDRHNrN2dnN0lpWUlPeVhodXlXdE95YWxDNGc3SU9kN0xLMElPeWR1T3ltbmV5ZGhDRHNrN0Ryb0tUcnFiUWc3Sld4N0oyRUlPeTFuT3lMb0NEcnNvVHNvSVRzbkx6cm9ad2c3SmVGNjQydzdKMjA3WXE0SU8yVnRPeWp2T3lFdU95YWxDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMElPeWp2T3lFdU95YWxDNGdMeURzZzUzc3NyUWc3SjI0N0thZDdKMkVJT3lUc091Z3BPdXB0Q0RzdFp6c2k2QWc2N0tFN0tDRTdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0S0NpTWpJeURzbHJUcmxxUWc2NnFwN0tDQjdKeTg2NkdjSU91TWdPeTJuT3V3bSt5Y3ZPeUxuT3VDbU95YWxEOEtMU0RyaklEc3Rwd2c2NnFwN0tDQjdKMjBJT3VzdE95WGgreWR1T3F3Z095YWxEOEtDaU1qSXlEc2xyVHJscVFnN0oyMDdKeWc2NkdjSU95TG9PcXpvTzJWbU95TG5PdUNtT3lhbEQ4S0xTRHNpNkRxczZBZzdKMjA3SnlnNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3ZzdJS3Q3S0NjSU95VmpPdW12TzJHb2V5ZGhDRHRtWTBxNjQrWktEQXhNQzB4TWpNMExUVTJOemdwSU91TG1DRHNtYmdnTXV1cWhleVhrT3F5akNEcnM3VHJncnpxdVl6c21wUS9DZ29qSXlNaklPMlpsZXlkdU1LMzZyS3c3S0NWSU8yTW5leVhoUW9LSXlNaklPeWdsZXVua0NEc2dxM3NvSnp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95Q3JleWduT3VRbkNEcmpiRHNuYlR0aExEcmlwUWc2N08xNnJXczdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEcmtKanJqNHpycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc29KWHJwNUFnN0lLdDdLQ2M3WldnNnJtTTdKcVVQd29LSXlNaklPdXpnT3F5dmV5Q3JPMlZyZXlkdENEc29JRHNucVhya0pqc3A0QWc3SldLN0pXWTdJcTE2NHVJNjR1a0xpRHJncGpxc0lEc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKV0U3S2VCSU95Z2dPeWVwZTJWbU95bmdDRHNsWXJzbllBZzY0SzA3SnFwN0oyMElPeWVpT3lXdE95YWxDNGdMeURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1ak95YWxEOEtDaU1qSXlEcm9aenF0N2pzbFlUc200TWc3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU91aG5PcTN1T3lWaE95YmcrMlZvT3E1ak95YWxEOEtDaU1qSXlEc2xiSHNuWVFnN0tLRjY2T003WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU95VnNleWRoQ0Rzb29Ycm80enRsYURxdVl6c21wUS9DZ29qSXlNZzdaV2NJT3V5aUNEcnM0RHFzcjN0bFpqcnFiUWc2NHVrN0l1Y0lPdXpnT3F5dmUyVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc2NHVrN0l1Y0lPdXdsT3EvZ0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xemhPeUdqZTJWb09xNWpPeWFsRDhLQ2lNakl5RHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTBpT3E0c08yWmxPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIc25iZ2c3SmlrNjZXWTZyQ0FJT3lEbmVxeXZPeVd0T3lhbEM0Z0x5RHNucURzaTV3ZzdadUVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZoT3lkdE91VWxDRHJtSkRyaXBRZzY3bUU2N0NBNjdLSTdaaTQ2ckNBSU95ZHZPeTVtTzJWbU95bmdDRHNsWXJzaXJYcmk0anJpNlF1Q2kwZzdKV0U3SjIwNjVTVUlPdVlrT3VLbENEcnVZVHJzSURyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwM3Jzb2p0bUxqcXNJQWc3SjI4N0xtWTdaV1k3S2VBSU95Vml1eUt0ZXVMaU91THBDNEtMU0RzbmJqc3BwM3Jzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeTBpT3F6dk91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0oyNDdLYWQ2N0tJN1ppNDY2VzhJT3llck91d25PeUdvZTJWbU95THJleUxuT3lZcEM0S0xTRHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeW5nT3VDck95V3RPeWFsQzRnTHlEc25ianNwcDNyc29qdG1ManJwYndnNjR1azdJdWNJT3V3bSt5VmhDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2xyVHNtcFF1SUM4ZzY0dWs2Nlc0SU9xeWdPeURpZXlXdE91aG5DRHJpNlRzaTV3ZzdMQys3SldFNjdPMDdJUzQ3SnFVTGdvS0l5TWpJT3lnbGV1enRPdWx2Q0RydG9qcm42enNtS1RzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rzb0pYcnM3VHJwYndnNjdhSTY1K3M3SmlzSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeUR0akl6c25id2c3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvakl5TWc3TG0wNjZtVTY1MjhJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0lxMTY0dUk2NHVrTGlEc2hLVHNvSlhzbDVEc2hKd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc3ViVHJxWlRybmJ3ZzZyYU03WldjN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3TG0wNjZtVTY1MjhJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWak91bXZDRHF0b3p0bFp6c25iUWc2ckd3NjdhQTY1Q1k3SmEwSU95VmpPdW12T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEc2xZenJwcndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU91cHRDRHNob3pzaTUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdJU2s3S0NWN0plUTdJU2NJT3lWak91bXZPeWRoQ0Rzdkp3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Y2hPeTVtQ0Rzb0pYcnM3UWc3SjIwN0pxcDdKZVFJT3VQbWV5ZG1PMlZtT3luZ0NEc2xZcnNsWVFnN0oyODY3YUFJT3E0c091S3BleWR0Q0Rzb0p6dGxaenJrS25yaTRqcmk2UXVDaTBnN0p5RTdMbVlJT3lnbGV1enRPdWx2Q0R0bDRqc21xbnRsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0p5RTdMbVlJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzbVlUcm80ekN0K3luaE8yV2lRb0tJeU1qSU95Z2dPeWVwZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Rzb0lEc25xWHRsb2pzbHJUc21wUXVDZ29qSXlNZzY3T0E2cks5N0lLczdaV3Q3SjIwSU95Z2dleWFxZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyczREcXNyMGc2NEswN0pxcDdKMkVJT3lnZ2V5YXFlMldpT3lXdE95YWxDNEtDaU1qSXlEc29JVHNocUhzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRPdURpT3lXdE95YWxDNEtDaU1qSXlEcms3SHJvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8yS3VDRHRtNFFnN0oyMDdKcXBJT3F3Z091S3BlMlZxZXVMaU91THBDNEtMU0RzZzRnZzY3S0U3S0NFN0oyMElPdUNtT3labE95V3RPeWFsQzRnTHlEc2w0WHJqYkRzbmJUdGlyanRsWmpycWJRZzdJT0lJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3SjIwN0pxcDdKMkVJT3ljaE8yVnRDRHNsYjNxdElBZzY0K1o3SjJZNnJDQUlPMlZoT3lhbE8yVnFldUxpT3VMcEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNpNXpzbnBIdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbnFYc2k1enFzSVFnNjYrNDdJS3M3SnFwN0p5ODY2R2NJT3lla091UG1TRHJvWnpxdDdqc2xZVHNtNE1nNjVDWTdKZUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPeVlwT3VlcSt1UG1leVZpQ0RzZ3F6c21xbnRsWmpzcDRBZzdKV0s3SldFSU91aG5PcTN1T3lWaE95YmcrdVFrT3lXdE95YWxDNGdMeURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUc2xZanNuWVFnN0p5RTdaVzBJT3U1aE91d2dPdXlpTzJZdU91bHZDRHJzNERxc3IzdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHNsWWpzb0lUdGxad2c3SUtzN0pxcDdKMkVJT3ljaE8yVnRDRHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzY3Q1U2citVSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nNjdPMDdKV0lJT3lFbk91NWhPeUtwQW9LSXlNaklPcXl2ZXU1aE91bHZDRHFzSnpzaTV6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc2cks5NjdtRTY2VzhJT3lMbk95ZWtlMlZvT3E1ak95YWxEOEtDaU1qSXlEcXNyM3J1WVRycGJ3ZzdaVzA3S0NjN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPcXl2ZXU1aE91bHZDRHRsYlRzb0p6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJpdzZyaXc2ckNBSU95WXBPMlVoT3Vkdk95ZHVDRHNnNEh0ZzV6c25vWHJpNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Q3RPeWFxZXlkZ0NEc29JRHNucVhya0pqc3A0QWc3SldLN0lxMTY0dUk2NHVrTGdvdElPeTNxT3lHak8yVm1PdXB0Q0RzaTZEc3NxM3RsWndnNjRLMDdKcXA3SjIwSU95Z2dPeWVwZXVRbU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9DaTBnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9JQzhnN0xlbzdJYU03WldZNjZtMElPeWVoZXVncGUyVm5DRHJnclRzbXFuc25iUWc3SUtzNjUyODdLQzQ3SnFVTGdvS0l5TWpJeURxc0lEc25iVHJrNXdnN0ppSTdJdWNJQ2gxZUMxM2NtbDBhVzVuTG0xazdKZVE3SVNjSU95WXJ1cTVnQ0RpZ0pRZzZyZWM3TG1aN0p5ODY2R2NJT3lla091UG1lMlpsQ0RycXJzZzdaV1k2NHFVSU91c3VPeWVwU0RzbnF6cXRhenNoTEVnN0lLczY2R0FLUW9LSXlNaklPeWVrT3VQbWV5d3FPdWx2Q0Rxc0lEc3A0RHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB3b3RJT3lla091UG1leXdxT3F3Z0NEc25vanJncGpzbXBRL0Nnb2pJeU1nNjZlazY0dXNJT3V6dE8yWG1PdWpqT3VsdkNEc2xyenJwNGpzbEtrZzY0SzA2ck9nSU9xemhPeUxuT3VDbU95YWxEOEtMU0RycDZUcmk2d2c2N08wN1plWTY2T002NHFVSU95V3ZPdW5pT3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2NnNnJDQTdLZUFJT3VMcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUNpMGc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFISU9xd2dPeW5nQ0RyaTZUc2k1d2c3Wm1WN0oyNDdaV2c2cktNN0pxVUxnb0tJeU1qSU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bFpqc2k1enFzcURzbHJUc21wUS9DaTBnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWb09xNWpPeWFsRDhLQ2lNakl5RHNpNXpzbnBIdGxaanNpNXpyaXBRZzY3YUU3SmVRNnJLTUlEVXNNREF3N0p1UTdKMkVJT3VUbk91Z3BPeWFsQzRLTFNEc2k1enNucEh0bFpqcnFiUWdOU3d3TUREc201RHNuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRTdJcWtJT3lkdE95YXFleWR0Q0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95TG9PdTJoT3ltblNEdG1aWHNuYmdnN0tDRTdKZVE2NHFVSU95R29lcTRpQ0Ryc0k4ZzZyS3c3S0NjNnJDQUlPdTJpT3F3Z08yVnFldUxpT3VMcEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU91emdPcXl2U0RzaTV3ZzdMcVE3SXVjNjdDeElPeWVyT3luZ09xNGlleWRnQ0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtDaU1qSXlEc2c0SHJpN1FnN1pLSTdLZUlJTzJXcGV5RGdleWRoQ0RzbklUdGxiUWc3WWExN1ptVUlPdUN0T3lhcWV5ZHRDRHJoYm5zbll6cmtLbnJpNGpyaTZRdUNpMGc2NDJVSU95aWkreWRnQ0RzZzRIcmk3VHNuWVFnN0p5RTdaVzBJTzJHdGUyWmxDRHJnclRzbXFuc25ZQWc2NFc1N0oyTTY0Kzg3SnFVTGdvS0l5TWpJT3F6b09xd25ldUxtT3lkbUNEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZGdDRHF1TERyb1owZzZyU0E2NmFzNjVDcDY0dUk2NHVrTGdvdElPeWR0T3lnbk91MmdPMkVzQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkdENEcXVMRHJvWjNyajd6c21wUXVDZ29qSXlNZzdMS3Q3SWFNNjRXRTdKMkFJT3lFbk91NWhPeUtwQ0Rxc0lEc25vWHNuYlFnNjdhSTZyQ0E3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc3NxM3Nob3pyaFlUc25ZUWc3SnlFN1pXY0lPeUVuT3U1aE95S3BPdUtsQ0RzbFlUc3A0RWc3S1NBNjdtRUlPeWtrZXlkdE95WGtPeWFsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2dxenNtcW50bGFBZzdJaVlJT3lYaHV1S2xDRHJ1WVRyc0lEcnNvanRtTGpzbm9Ycmk0anJpNlF1SU95WWdldXN1Q3dnN0lpcjdKNlFMQ0R0aXJuc2lKanJyTGpzbnBEcnBid2c3WStzN1pXbzdaV1k3SmVzSURqc25wQWc3SjIwN0lPQklPeWVoZXVncGUyVm1PeUxyZXlMbk95WXBDNEtMU0RzbUlIcnJMZ3NJT3lJcSt5ZWtDd2c3WXE1N0lpWTY2eTQ3SjZRNjZXOElPMlByTzJWcU8yVnRDQTQ3SjZRSU95ZHRPeURnU0Rzbm9Ycm9LWHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3llaGV1Z3BTRHFzSURyaXFYdGxad2c2cmlBN0o2UUlPeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnN0o2RjY2Q2w3WldnSU95SW1DRHNub2pyaXBRZzZyaUE3SjZRSU95SW1PdWx2Q0RyaEpqc2w0anNsclRzbXBRdUlDOGc2NEswN0pxcDdKMkVJT3loc09xNGlDRHNwSVRzbDZ3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEdGpJenNuYnpDdCtxeXNPeWduTUszNnJpdzdZT0FDZ29qSXlNZzdZeU03SjI4SU95YXFldWZpZXlkdENEc3RJanFzN3pya0pqc2w0anNpclhyaTRqcmk2UXVJREV3VFVJZzdKMjA3WldZN0oyWUlPMk1qT3lkdk91bmpDRHNsNFhyb1p6cms1d2c2ckNBNjRxbDdaV3A2NHVJNjR1a0xnb3RJREV3VFVJZzdKMjA3WldZSU8yTWpPeWR2T3VuakNEc21LenJwclFnN0lpWUlPeWVpT3lXdE95YWxDNGdMeUR0akl6c25id2c3SnFwNjUrSjdKMkVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NHVrN0pxMDY2R2M2NU9jNnJDQUlPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcmk2VHNtclRyb1p6cms1enJwYndnNjZlSTdMT2s3SmEwN0pxVUxnb0tJeU1qSU9xeXNPeWduT3lYa0NEc2k2VHRqS2p0bFpqc21JRHNpclhyaTRqcmk2UXVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHFzckRzb0p6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3F5c095Z25DRHNpSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc2NDJVSU91VHNldWhuZTJWbU91Z3BPdXB0Q0RxdUxEc29iUWc3Wld0NjZxcDdKMkVJT3lDcmV5Z25PMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3kybE9xd2dDa0tDaU1qSXlEc3RwenJqNWtnN0pxVTdMS3Q3SjIwSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3TGFjNjQrWklPeWFsT3l5cmV5ZGhDRHNvSkhzaUpqdGxvanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cks5NjdtRUlPeURnZTJEbk91bHZDRHRtWlhzbmJqdGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU9xeXZldTVoQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3lnaE8yWm1PMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3V3bE9xL2dPcTVqT3lhbEQ4S0NpTWpJeURyc0tucnJMZ2c3SmlJN0pXOTdKMjBJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzS25yckxnZzdKaUk3Slc5N0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHJ1WVRyc0lEcnNvanRtTGdnTmUyYWpDRHNtS1RycFpqcm9ad2c2ck9FN0tDVjdKMjBJT3llb09xNGlDRHNzcGpycHF6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SURYdG1vd2c3SjZZNjZxN0lPeWVoZXVncGUyVnRPeUVuQ0RxczRUc29KWHNuYlFnN0o2ZzZySzg3SmEwN0pxVUxpQXZJT3U1aE91d2dPdXlpTzJZdU91bHZDRHNucXpzaEtUc29KWHRsWmpycWJRZzY0dWs3SXVjSU95ZHRPeWFxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqc25iZ2c3WnVFN0plUTY2ZU1JT3lDck95YXFTRHFzSURyaXFYdGxhbnJpNGpyaTZRdUNpMGc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeS9vTzJQc095ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnI3anNoTEhyaFlUc25wRHJpcFFnNjdPMDdaaTQ3SjZRSU91UG1leWRtQ0RzbDRic25iUWc2ckt3N0tDYzdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnNjdPMDdaaTQ3SjZRNnJDQUlPdVBtZXlkbU8yVm1PdXB0Q0Rxc3JEc29KenRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxJVHJvWnp0bFlUc25ZUWc2NU94NjZHZDdaV1k3S2VBSU95Vml1eWN2T3VwdENEc25iVHNtcW5zbmJRZzdLQ2M3WldjNjVDcDY0dUk2NHVrTGdvdElPMlVoT3Vobk8yVmhPeWRoQ0RyazdIcm9aM3RsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbGJFZzY3S0U3S0NFN0oyMElPdUNydXlWaENEc25ienJ0b0FnNnJpdzY0cWw3SjIwSU95Z25PMlZuT3VRcWV1TGlPdUxwQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaV1k2Nm0wSU91cXFPdVRvQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc2N2lVNjZPbzdZaXM3SXFrNnJDQUlPcTZ2T3lndUNEc25vanNsclFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPdTRsT3VqcU8ySXJPeUtwT3VsdkNEc3ZKenJxYlFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPdTVoT3lEZ1NEc2w3RHJuYjNzc3BqcXNJQWc2NU94NjZHZDY1Q1k3S2VBSU95Vml1eVZtT3lLdGV1TGlPdUxwQzRLTFNEcnVZVHNnNEVnN0pldzY1Mjk3TEtZNjZXOElPdVRzZXVobmUyVm1PdXB0Q0RxdUxUcXVJbnRsYUFnNjVXTUlPdTVvT3VsdE9xeWpDRHNsN0RybmIzcms1enJwclFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc3RwenNub1VnN0xtMDY1T2M2ckNBSU91VHNldWhuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMDdKcVVMaUF2SU95SW5PeUVuT3VNZ091aG5DRHJpN1hyczREcms1enJwclRxc296c21wUXVDZ29qSXlNZzdJU2s3S0NWN0oyMElPeTBpT3E0c08yWmxPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNoS1Rzb0pYc25ZUWc3TFNJNnJpdzdabVU3WmFJN0phMDdKcVVMZ29LSXlNaklPdTVoT3V3Z091eWlPMll1T3F3Z0NEcnM0RHFzcjNya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJT3V3bE9xL3FPeVd0T3lhbEM0S0NpTWpJeURzbmJqc3BwM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdU95bW5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1qSU95NmtPeWp2T3lXdk8yVm5DRHFzcjNzbHJRZ0tPeW5pT3VzdUNEc25xenF0YXpzaExFcENnb2pJeU1nN0phNDdLQ2NJT3V3cWV1c3VPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Ryc0tucnJMZ2c2NEtnN0tlYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SmEwNjVha0lPdXdxZXV5bGV5Y3ZPdWhuQ0RzbmJqc3BwM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0oyNDdLYWRJT3V3cWV1eWxleWRoQ0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3F5c095Z25PMlZtT3lMcENEc3ViVHJrNXpycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEcXNyRHNvSnp0bGFBZzdMbTA2NU9jNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKdVE3WldZN0l1YzY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bFpqc2hManNtcFF1Q2kwZzdKdVE3WldZNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc2ck9FN0l1ZzZyQ0E3SnFVUHdvdElPeWp2T3lHak91bHZDRHNsWXpxczZBZzdKNkk2NEtZN0pxVVB3b0tJeU1qSXlEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0FvS0l5TWpJT3E0c09xd2hDRHJwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyYU03WldjSU91MmdPeWhzZXljdk91aG5DRHNvSkhxdDd6c25iUWc2ckd3NjdhQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SmEwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHF0b3p0bFp6c25ZUWc3SnFVN0xLdDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc3SU9CN1ptcElPeVZpT3VDdENBb011dUxxQ0RxdGF6c29iQXBDZ29qSXlNZzdKNkY2NkNsN1pXWTdJdWdJT3lqdk95R2pPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc2NHVrN0l1Y0lPMlpsZXlkdUNEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0tPODdJYU02Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3VMcE95TG5DRHRtWlhzbmJqdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWFsT3l5cmUyVm1PeUxvQ0R0anBqc25iVHNwNERycGJ3ZzdMQys3SjJFSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdZNlk3SjIwN0tlQTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWp2T3lHak91bHZDRHRtWlhzbmJqdGxaanFzYkRyZ3BnZzdabUk3Snk4NjZHY0lPeWR0T3VQbWUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0K1o3SjI4N1pXY0lPeWFsT3l5cmV5ZHRDRHNzcGpycHF3ZzdLU1I3SjZGNjR1STY0dWtMaURzbnFEc2k1d2c3WnVFSU8yWmxleWR1TzJWdENEc283enNpNjNzaTV6c21LUXVDaTBnNnJDWjdKMkFJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpxczZBZzdKNkk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJUcnNxVHRpcmpxc0lBZzdLS0Y2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHRPdXlwTzJLdU9xd2dDRHJnWjNyZ3F6c2xyVHNtcFF1Q2dvakl5TWc3WU9JN1llMElPeUxuQ0RycXFqcms2QWc2NDJ3N0oyMDdZU3c2ckNBSU95Q3JleWduT3VRbU91cHNDRHJzN1hxdGF6dGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU8yWmxPeWVyQ0Rxc0pEc3A0RHF1TEFnNjdDdzdZU3c2NmFzNnJDQUlPdTJnT3loc2UyVnFldUxpT3VMcEM0S0xTRHRtWlRzbnF3ZzZyQ1E3S2VBNnJpd0lPdXdzTzJFc091bXJPcXdnQ0RzbHJ6cnA0Z2c3SmVHN0phMDdKcVVMaUF2SU91d3NPMkVzT3Vtck91bHZDRHF0WkRzc3JUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHN0cFhzbGIwZ0t5RHF1STNzb0pVZzdLQ0U3Wm1ZSUNqcmtaQWc2Nnk0N0o2bElPS0draURxdUkzc29KWHRtSlVnN1pXY0lPdXN1T3llcFNrS0NpTWpJeURycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bUp6dGc1MGc3SmVHN0oyMElPcXdnT3llaGUyVm9PcTVqT3lhbEQ4ZzdLZUE2cmlJSU95TG9PeXlyZTJWbU95bmdDRHNsWXJzbkx6cnFiUWc3SnV3N0x1MElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc3A0RHF1SWdnN0l1ZzdMS3Q3WldZNjZtMElPeWJzT3k3dENEdG1KenRnNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdMK2c3WSt3SU95WGh1eWR0Q0Rxc3JEc29KenRsYURxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdUNEc3Y2RHRqN0RzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVDaTBnN0wrZzdZK3c3SjJFSU91d20reWN2T3VwdENEcmpaUWc3S0NBNjZDMDdaV1k2cktNSU9xeXNPeWduTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEc2w0YnNuYlFnN0l1YzdKNlI3WldnNnJtTTdKcVVQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aG5DRHF0b3p0bFp6cnM0RHFzcjNzbllRZzdaV1k3SXVrSU95SW1DRHNsNGJzbHJUc21wUXVJT3lkdk91d21DRHF0SURycHF6c25wRHJvWndnNnJhTTdaV2NJT3V6Z09xeXZleWRoQ0RzbTVEdGxaanNpNlFnNnJLOTdKcXdJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla0NEcXRvenRsWnpzbllRZzdLZUE3S0NWN1pXMElPeWp2T3lMb0NEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVm5DRHJrcVFnN0oyODY3Q1lJT3EwZ091bXJPeWVrT3VobkNEcnM0RHFzcjN0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLTFNEcmk2VHJwYmdnN0lLczY1Nk03SjJFSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcm9ad2c3S2VBN0tDVjdaV1k2Nm0wSU91emdPcXl2ZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ289JwpCNjRfR1VJREU9J0l5QlZXQ0JYY21sMGFXNW5JT3F3Z095ZHRPdVRuQTBLRFFvakl5QXhMaUR0bGJUc21wVHNzclFOQ2cwSzdLQ2M3WktJSU95VmlPeWRtQ0RycXFqcms2QWc2Nnk0NnJXczY0cVVJQ2Z0bGJUc21wVHNzclFuNjZHY0lPeU5xT3lhbEM0TkN1eWR2T3EwZ095RXNTRHNub2pyaXBRZzdJS3M3SnFwN0o2UUlPcXl2ZTJYbU95ZGhDRHJwNHpyazZRZzdJaVlJT3llaU91UGhPdWhuU0FxS3V5RGdlMlpxU3dnNjZlbDY1Mjk3SjJFSU91MmlPdXN1TzJWbU9xem9DRHJxcWpyazZBZzY2eTQ2cldzN0plUUlPMlZ0T3lhbE95eXRPdWx2Q0Rzb0lIc21xbnRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHJzN1RyZzRYcmk0anJpNlFnNG9hU0lPdXp0T3VDdk9xeWpPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ01pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzQTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSU95MW5PdU1nTzJWbkNBcUt1dUtwZXVQbWUyWWxTRHJyTGpzbnFVcUt1eWRoQ0RzamFqc283enNoTGpzbXBRdUlPeUltT3VQbWUyWWxTRHJyTGpzbnFYc25ZQWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1TM3NpSmpyajVudG1KVXQ2Nnk0N0o2bDdKMkVMZXlOcU91UGhDM3JrSmpyaXBRdDZySzk3SnF3S2V5WGtDRHRsYlRyaTdudGxhQWc2NVdNNjZlTUlPeVRzT3VLbENEcXNvd2c3S0tMN0pXRTdKcVVMZzBLRFFvakl5TWc2NUNRN0phMDdKcVVJT0tHa2lEdGxvanNsclRzbXBRTkNnMEs3SmlJS1EwS0xTRHNoS1Rzb0pYcmtKRHNsclRzbXBRZzRvYVNJT3lFcE95Z2xlMldpT3lXdE95YWxBMEtEUW9qSXlNZ0ozN3NsNGduSU91NXZPcTRzQTBLRFFyc21JZ3BEUW90SU91d2xPdUFqT3lYaU95V3RPeWFsQ0RpaHBJZzY3Q1U2citvN0phMDdKcVVEUW9OQ2lNakl5RHJqNW5zZ3F3ZzY3Q1U2citVN0pPdzZyaXdEUW9OQ3V5WWlDa05DaTBnNjRhUzdKV0U3S0dNN0phMDdKcVVJT0tHa2lEc21LenJucERzbHJUc21wUU5DZzBLS2lvcURRb05DaU1qSURNdUlPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQU5DZzBLN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RydG9Ec29KWHNvSUVnN0x1azY2Nms2NHVJN0x5QTdKMjA3SVdZN0oyRUlPeTFuT3VNZ08yVm5DRHNwSVRzbmJUcXM2QWc2cmlON0tDVjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqc283enNoTGpzbXBRdURRcnJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUTXQ2N2FBN0tDVjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNqYWpzbXBRdURRb05DdXlZaUNBNklPeVZpQ0Ryajd6c21wUXNJT3lYaHV5V3RPeWFsQ0FvV0NrZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJeURzbDRic2xyVHNtcFFnNG9hU0lPeWVpT3lXdE95YWxBMEtEUXJzbUlncERRb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bFpqcXVMQWc3S0NFN0plUTY0cVVJT3F3Z095ZWhlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlPS0draURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXMDdKVzhJT3F3Z095ZWhlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVURRb05DaU1qSXlEc2w1RHJuNndnNjZtVTdJdWM3S2VBRFFvTkN1eVhrT3VmckNEc2c0SHRtYW5zbDVEc2hKenJqNFFnSXUyVnRPcXlzQ0Ryc0tucnNwVWk3SjJFSU91b3ZPeWdnQ0RzbFl6cm9LVHNvN3pyaXBRZzZyaU43S0NWN1ppVklPcTFyT3loc091aG5DRHNqYWpzbXBRdURRb05DdXlZaUNrTkNpMGc3S2VBNnJpSUlPdXloT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0ZzRvYVNJT3lWc2V5ZGhDRHNsNFhyamJEc25iVHRpcmp0bGJUc283enNoTGpzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeTFuT3lMb0NEcnNvVHNvSVRzbmJRZzdaV0U3SnFVN1pXMDdKcVVMZzBLRFFvNk9qb2dkR2x3SU8yTW5leVhoU0Ryc29UdGlyenNuWUFnV3pndUlPMk1uZXlYaFYwZzZyZWM3TG1aN0oyRUlPdVVzT3Vkdk95YWxBMEs3WXlkN0plRktPdUxwT3lkdE95V3ZPdWhuT3EzdUNrZzY3S0U3WXE4SU91c3VPcTFyT3VLbENEc2xZVHJucGdnS2lvNExpRHRqSjNzbDRVcUtpRHNoTG5zaFpnZzZyZWM3TG1aN0oyRUlPdVVzT3Vkdk95YWxDRGlnSlFnN1lhMTY3TzA2NHFVSUZ2dG1aWHNuYmhkTENEc21JZ3Y3SldFNjR1STdKaWtJTzJNa091THFPeWRnQ0JiN0pXRTY0dUk3SmlrWGNLM1crdUVwRjBzSU91UG1leWVrU0RzbktEcmo0VHJpcFFnVyt5M3FPeUdqRjNDdDF2cmo1bnNucEZkTGlBaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenJwNHdnN0pPdzZyT2dMQ0FpNjR1cjZyaXdJTUszSU91UG1leWVrU0xzc3Bqcm43d2c3S2VkN0oyMElPeVZpQ0RycDU3cmlwUWc3S0d3N1pXcDdKMkFJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW82T2pvTkNnMEtJeU1qSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLN0ppSUtRMEtMU0RycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnNG9hU0lPeVZ2ZXEwZ095WGtDRHJqNW5zblpqdGxaanJxYlFnNjZxbzdKNkU3S2VBN0p1UTZyaUk3SjJFSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdaaWM3WU9kSU91TWdPeURnU0RzbFlqcmdyUU5DZzBLS2lyc2hKenJ1WVRzaXFUcmlwUWc3Sk80SU95SW1DRHNub2pzcDREcnA0d3NJTzJLdWV5Z2xTRHRtSnp0ZzUzc25ZQWc2N0NiN0oyRUlPeUltQ0RzbDRic25ZUWc2NVdNSU9LR2tpRHF1STNzb0pYdG1KVWc2Nnk0N0o2bDdKeTg2NkdjSU95TnFPeWFsQzRxS2cwSzdJS3M3SnFwN0o2UTY0cVVJT3VzdU9xMXJPdWx2Q0Rxdkx6cXZMenRub2dnN0oyOTdLZUFJT3lWaXVxem9DRHRtNUhzbHJUcnM3VHF1TEFvN0lxazdMcVVLU0RybFl6cnJManNsNUFzSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzazdEcnFiUWc3S0NjN1pLSUlPeWdoT3l5dE91bHZDRHNrN2dnN0lpWUlPeVhodXVMcE9xem9DRHNtS1R0bGJUdGxaanF1TEFnN0ltczdKdU03SnFVTGcwS0RRcnNtSWdwRFFvdElPcXpoT3lpakNEcXNKenNoS1FnN1ppYzdZT2Q3SjJBSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnTkM0MUpTRHF1SWpycHF3ZzdaaWM3WU9kNjZlTUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ05DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0QTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSUNkKzdJdWM2cktnN0phMDdKcVVQeWNzSUNmc2k1enJncGpzbXBRL0p5d2dKMzdxdTVnbklPcXdtZXlkZ0NEcXM3enJqNFR0bFp3ZzZySzk3SmEwNjZXOElPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRcnN0WnpyaklEdGxad2c3THFRN0tPODdKYTg3WldZNnJPZ0lPeTVuT3Ezdk8yVm5DRHJwNUR0aUt6cnBid2c3Sk93NjRxVUlPcXlqQ0Rzb292c2xZVHNtcFF1RFFycXNyM3NsclRyaXBRZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TWkzcXNyM3NsclRycGJ3dDdJMm82NCtFTGV1UW1PdUtsQzNxc3Izc21yQXA3SmVRSU8yVnRPdUx1ZTJWb0NEcmxZenJwNHdnN0kybzdKcVVMZzBLRFFvakl5TWc2NCtaN0lLczdKZVE3SVNjSUNkKzdJdWNKeURydWJ6cXVMQU5DZzBLN0ppSUtRMEtMU0RzdWJUcms1enJwYndnN1pXMDdLZUE3WldZN0l1YzZyS2c3SmEwN0pxVVB5RGlocElnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWb09xNWpPeWFsRDhOQ2kwZzdJdWM3SjZSN1pXWTdJdWM2NHFVSU91MmhPeVhrT3F5akNBMUxEQXdNT3lia095ZGhDRHJrNXpyb0tUc21wUXVJT0tHa2lEc2k1enNucEh0bFpqcnFiUWdOU3d3TUREc201RHNuWVFnNjVPYzY2Q2s3SnFVTGcwS0RRb2pJeU1nSitxemhPeUxuT3VMcENjZzRvYVNJQ2Zzbm9qcmk2UW5EUW9OQ3V5WWlDa05DaTBnN0o2UTY0K1o3TENvNjZXOElPcXdnT3luZ09xem9DRHFzNFRzaTV6cmdwanNtcFEvSU9LR2tpRHNucERyajVuc3NLanFzSUFnN0o2STY0S1k3SnFVUHcwS0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTUlPeVd2T3VuaU95VXFTRHJnclRxczZBZzZyT0U3SXVjNjRLWTdKcVVQeURpaHBJZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91S2xDRHNscnpycDRqc25ianFzSURzbXBRL0lDb282NHVvN0lpY0lPeTVtTzJabU95ZHRDRHNsWVRyaTRqcm5id2c2Nnk0N0o2bDdKMkVJT3lEaU91aG5DRHNrN1FnN0lLczY2R0E3SmlJN0pxVUtTb05DZzBLSXlNaklDZnNsNnpzcllqcmk2UW5JT0tHa2lBbjdabVY3SjI0N1pXWTY0dWtMQ0Ryckx2cmk2UW5EUW9OQ3V5WWlDa05DaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSDZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVJT0tHa2lEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvZnFzSURzcDRBZzY0dWs3SXVjSU8yWmxleWR1TzJWb09xeWpPeWFsQzROQ2cwS0l5TWpJQ2ZxdTVnbklPS0draUFuN0plUTZyS01KdzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1PcTdtQ0RyZ3FEc2xZVHFzSURxczZBZzdKNkk3SmEwN0pxVUxpRGlocElnN1ptTjZyaTQ2NCtaNjR1WTdKZVE2cktNSU91Q29PeVZoT3F3Z09xem9DRHNub2pzbHJUc21wUXVEUW9OQ2lNakl5RHFzcjNzbHJUcnBid2c2N3FRN0oyRUlPdVZqQ0RzbHJUc2c0bnRsWndnNnJLOTdKcXdEUW9OQ3V5Q3JPeWFxZXlla095ZG1DRHNvSlhyczdUcnBid2c2N0NiNjRxVUlPeW5pT3VzdU95WGtPeUVuQ0RxdUxEcXM0VHNvSUhzbkx6cm9ad2dKMzdzaTV3bjY2VzhJT3U2a095ZGhDRHJsWXdnNjZ5NDdKNmw3SjIwSU95V3RPeURpZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLS2lydGpJenNsWVh0bFpqcXM2QWc3SXUyN0oyQUlPeWdsZXV6dE91bHZDQW43S084N0phMEordWhuQ0RzamFqc2hKd2c2Nnk0N0o2bDdKMkVJT3lEaU91aHJlcXlqQ0RzamFqcnM3VHNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RzbHJUcmxxUWc2NnFwN0tDQjdKeTg2NkdjSU91TWdPeTJuT3V3bSt5Y3ZPeUxuT3VDbU95YWxEOGc0b2FTSU91TWdPeTJuQ0RycXFuc29JSHNuYlFnNjZ5MDdKZUg3SjI0NnJDQTdKcVVQdzBLTFNEc2xyVHJscVFnN0oyMDdKeWc2NkdjSU95TG9PcXpvTzJWbU95TG5PdUNtT3lhbEQ4ZzRvYVNJT3lMb09xem9DRHNuYlRzbktEcnBid2c3SVNnN1lPZDdaVzBJT3lqdk95RXVPeWFsQzROQ2cwS0tpb3FEUW9OQ2lNaklEVXVJQ2Q3NjZxRjdJS3NmU0FySUh2cnFvWHNncXg5SnlEc2s3RHNwNEFnN0pXSzZyaXdEUW9OQ2lNakl5RHRsWnpzbnBEc2xyUWc3WktBN0phMDdKT3c2cml3RFFvTkN1MlZuT3lla095V3RDRHJxb1hzZ3F6cnBid2c3WktBN0phMDdJU2NJT3VQbWV5Q3JDRHRtSlh0ZzV6cm9ad2c3Sk80SU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBRZzRvYVNJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFFOQ2kwZzY0SzA3SjI4SU95NXRPdVRuT3F3a3V5ZHRDRHFzckRzb0p6cmtLQWc3SmlJN0tDVjdKMjA3SmVRN0pxVUlPS0draURyZ3JUc25ienNuWUFnN0xtMDY1T2M2ckNTSU91Q21PcXdnT3VLbENEcmdxRHNuYlRzbDVEc21wUU5DZzBLSXlNaklPMlZuT3lla095V3RPdWx2Q0R0a29Ec2xyVHNrN0RxdUxBZzdKYTA2NkNrN0pxNElPcXl2ZXlhc0EwS0RRb25lK3VxaGV5Q3JIM3FzSUFnZSt1cWhleUNySDN0bGJUc2hKd25JTzJZbGUyRG5PdWhuT3VuakNEdGtvRHNsclRzcEpqcmo0UWc2NDJVSU95NmtPeWp2T3lXdk8yVm1PcXlqQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHY0lPcTFyT3VucE8yVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRZzRvYVNJT3llbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3ZzZyV3M2NmVrN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEEwS0RRb3FLaW9OQ2cwS0l5TWdOaTRnN1pHYzZyaXdJTzJHdGV5ZHZBMEtEUW9qSXlNZzY1Q1k3SmEwN0pxVUlDaFlLU0RpaHBJZzY0Kzg3SnFVSUNoUEtRMEtEUXJycXFqcnNKVHNuYndnN1ptVTY2bTA3SjJZSU95aWdleWRnQ0RxczdYcXNJVHNuWVFnNnJPZzY2Q2s3WlcwSUNmcmtKanNsclRzbXBRbjY0cVVJT3VxcU91UmtDQW42NCs4N0pxVUordWhuQ0R0aHJYc25ienRsYlRzaEp3ZzdJMm83S084N0lTNDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ055NGc2NEtnN0tlY3dyZnNpNXpxc0lUQ3QreUlxK3lla0NEdGtaenF1TEFOQ2cwSzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt1eWlPMll1T3VLbENEc2xZVHJucGdnN1ppVjdJdWQ3Snk4NjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc21wUXVEUW9OQ2lNakl5RHJncURzcDV6Q3QreUxuT3F3aE1LMzZyaXc2ckNFRFFvTkNud2c3Wld0NjZxcElId2c3WmlWN0l1ZElId2c3SmlJN0l1Y0lId05Dbnd0TFMwdExTMThMUzB0TFMwdGZDMHRMUzB0TFh3TkNud2c2NEtnN0tlY0lId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVZQ0F2SU95bnArcXlqQ0JnVFUwdVJFUmdJSHdnTWpBeU5TNHdNUzR3TVN3Z01qVXVNREV1TURFZ2ZBMEtmQ0RzaTV6cXNJUWdmQ0RxdUxEcnM3Z2dZRWhJT2sxTk9sTlRZQ0F2SU95bnArcXlqQ0JnU0VnNlRVMWdJQ2pzbUtUc29JUXY3SmlrN1p1RUlPeVZpQ0RzbElBcElId2dNVFE2TXpBNk1URXNJREV6T2pNd0lId05DbndnNnJpdzZyQ0VJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFZmxsWldWa3VUVTB1UkVSZ0lDOGc3S2VuNnJLTUlHQlpXVmxaTGsxTkxrUkVmazFOTGtSRVlDQjhJREl3TWpVdU1ERXVNREYrTWpBeU5TNHdNUzR6TVN3Z01qQXlOUzR3TVM0d01YNHdNUzR6TVNCOERRcDhJT3VDb095bm5DQXJJT3lMbk9xd2hDQjhJR0JaV1ZsWkxrMU5Ma1JFSUVoSU9rMU5ZQ0I4SURJd01qVXVNREV1TURFZ01UUTZNekFnZkEwS2ZDRHNtcFRzbmJ3Z2ZDQmdXVmxaV1M1TlRTNUVSQ2pzbXBUc25id3BZQ0RpZ0pRZzdKdVVMKzJabEMvc2lKZ3Y2NnFwTCtxNGlDL3RocUF2N0oyOElId2dNakF5TlM0d01TNHdNU2pzaUpncElId05DZzBLS2lyc2k1enFzSVFnN0ppSTdKbTRLaW82SU95Q3JPeWFxZXlla09xd2dDRHNwNEhzb0pFZzZyT2c2NlcwNjRxVUlPdXdxZXVzdU1LMzdKaUk3Slc5SU95TG5PcXdoT3lkZ0NCZzdKaWs3S0NFTCt5WXBPMmJoQ0JJT2sxTllPeWRoQ0RzamFqcmo0UWc2NCs4N0pxVUxnMEs3SmlJS1NEc21LVHRtNFFnTVRvd01BMEtEUW9qSXlNZzY2eTQ3SjZsSU95R2pTRHNsN0RzbTVUc25id05DZzBLNjZ5NDdKNmxJT3lWaU95WGtPeUVuT3VLbENBcUt1eWJsTUszN0oyOElPeVZudXlkbUNBdzdKMkVJT3U1dk9xem9Db3FJT3lOcU95YWxDNE5DZzBLN0ppSUtRMEtMU0F5TURJMjY0V0VJREE0N0p1VUlEQTE3SjI4SU95ZWhldUxpT3VMcEM0ZzRvYVNJREl3TWpicmhZUWdPT3libENBMTdKMjhJT3llaGV1TGlPdUxwQzROQ2cwS0l5TWpJT3lEZ2V1TWdDRHNpNXpxc0lRZ0tPdUZ1T3kybk95YXFTa05DZzBLZkNEc29iRHFzYlFnZkNEdGtaenF1TEFnZkEwS2ZDMHRMUzB0TFh3dExTMHRMUzE4RFFwOElEWXc3TFNJSU91dnVPdW5qQ0I4SU91d3FlcTRpQ0Rzb0lRZ2ZBMEtmQ0EyTU91MmhDRHJyN2pycDR3Z2ZDQk82N2FFSU95Z2hDQjhEUXA4SURJMDdJdWM2ckNFSU91dnVPdW5qQ0I4SUU3c2k1enFzSVFnN0tDRUlId05DbndnTXpEc25id2c2Nis0NjZlTUlId2dUdXlkdkNEc29JUWdmQTBLZkNBeE11cXduT3libENEcnI3anJwNHdnZkNCTzZyQ2M3SnVVSU95Z2hDQjhEUXA4SURFeTZyQ2M3SnVVSU95ZHRPeURnU0I4SUU3cmhZUWc3S0NFSUh3TkNnMEs3SmlJS1NEcnNLbnF1SWdnN0tDRUxDQTE2N2FFSU95Z2hDd2dNdXlMbk9xd2hDRHNvSVFzSURQc25id2c3S0NFTENBMjZyQ2M3SnVVSU95Z2hDd2dNdXVGaENEc29JUU5DZzBLSXlNaklPdW5pT3F3a01LMzZyaXc2ckNFSU91bmpPdWpqQTBLRFFwZ1JDMU9ZQ2hPN0oyOElPdUNxT3lkakNrZ0x5QmdSQzB3WUNqc21LVHJpcGdnNjZlSTZyQ1FLU0F2SUdCRUswNWdLRTdzbmJ3ZzZySzk2ck84S1EwSzdKaUlLU0JFTFRjc0lFUXRNU3dnUkMwd0xDQkVLekVOQ2cwS0l5TWpJT3V5aU8yWXVDRHRrWnpxdUxBZ0tPMlZtT3lkdE8yVWlPeWN2T3VobkNEcXRhenJ0b1FwRFFvTkNud2c3Wld0NjZxcElId2c3WmlWN0l1ZElId2c3SmlJN0l1Y0lId05Dbnd0TFMwdExTMThMUzB0TFMwdGZDMHRMUzB0TFh3TkNud2c3S0NFN1ptVTY3S0k3Wmk0SUh3ZzdaV1k3SjIwN1pTSUlPcTFyT3UyaENCOElEQXlMVEV5TXpRdE5UWTNPQ3dnTURFd0xURXlNelF0TlRZM09DQjhEUXA4SU95NXRPdVRuT3V5aU8yWXVDQjhJRFRzbnBEcnBxenNsS2tnN1pXWTdKMjA3WlNJSUh3Z01USXpOQzAxTmpjNExUa3dNVEl0TXpRMU5pQjhEUXA4SU9xemhPeWlqT3V5aU8yWXVDQjhJTzJWbU95ZHRPMlVpQ0RxdGF6cnRvUWdmQ0F4TWpNdE5EVTJMVGM0T1RBeE1pQjhEUXA4SU95anZPdXZ2T3VUc2V1aG5ldXlpTzJZdUNCOElPeVZuaUEyN0o2UTY2YXNMZXVTcENBMzdKNlE2NmFzSUh3Z01USXpORFUyTFRFeU16UTFOamNnZkEwS2ZDRHNncXpzbDRYc25wRHJrN0hyb1ozcnNvanRtTGdnZkNBeE1PeWVrT3VtckNEdGxaanNuYlR0bElnZ2ZDQXdNUzB5TXpRdE5UWTNPRGtnZkEwS0RRb2pJeU1nN0pPdzY2bTBJT3lWaUNEcmtKanJpcFFnN1pHYzZyaXdEUW9OQ2kwZzY0S2c3S2VjN0plUUlPMlZtT3lkdE8yVWlNSzM2N21YNnJpSU9pRGluWXdnTWpBeU5TMHdNUzB3TVN3Z01ERXZNREVOQ2kwZzdJdWM2ckNFN0plUUlPeVlwT3lnaEMvc21LVHRtNFE2SU9LZGpDRHNtS1Rzb0lRZ01leUxuQ0FxS091THFDd2c3SUtzN0pxcDdKNlE2ckNBSU95bmdleWdrU0RxczZEcnBiVHJpcFFnNjdDcDY2eTR3cmZzbUlqc2xiMGc3SXVjNnJDRTdKMkFJT3lZaU95WnVDa3FEUW9OQ2lvcUtnMEtEUW9qSXlBNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1EwS0RRcnRqSjNzbDRVZzY2eTQ2cldzNjRxVUlDb3E3SmV0N1pXZ0tpb283WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZDbnFzN3dnS2lyc25LRHRtSlVxS2lqdGhyWHJzN1F2N1l5UTY0dW9LZXlYa0NEcmxMRHJuYndnNjZ5NDdMSzA2ckNBSU91THJPdWR2T3lhbEM0ZzdZT0E3SjIwN1l1QTdKMkVJT3VMcE91VHJPeWRoQ0RybFpBZzY3Q1k2NU9jN0l1Y0lPeVZpT3VDdENqcnM3anJyTGdwNnJtTTdLZUFJT3F3bWV5ZHRDRHJzN1RxczZBc0lPdXp1T3VzdUNEcnA2WHJuYjNzbllRZzY0dTA3SldFN0pXOElPMlZ0T3lhbEM0TkNnMEtJeU1qSUREcmk2anFzNFFnNG9DVUlPMkt1T3Vtck9xeHNPdTJnTzJFc0NEcnRKRHNtcFFOQ2cwSzdZeWQ3SmVGN0oyMElPeUNyT3lhcWV5ZWtPeWRtQ0RzbHJUcmxxUWc3WmFKNjQrWklPdVNwT3lYa0NEcm5LanJpcFRzcDRBZzY2aTg3S0NBSU8yTWpPeVZoZTJWdE95YWxDNE5DZzBLTFNEdGxvbnJqNW5zbllRZ0tpcnFzSURyb1p6cnA0bnFzYkRyZ3BnZzdZeVE2NHVvN0oyRUlPeWFsT3ExckNvcUtPeWR0TzJEaU1LMzdJS3Q3S0Njd3Jmcm9aenF0N2pzbFlUc200UEN0K3lpaGV1ampDa2c0b2FTSUNvcTdZeVE2NHVvN1ppVktpb2dLT3Vzdk95V3RPdTBrT3lhbENrTkNpMGc2ckt3NnJPOHdyZnNnNEh0ZzV6cnBid2dLaXJ0aHJYcnM3VHJwNHdxS2lBbzdKbUU2Nk9Nd3Jmc2k2VHRqS2dwSU9LR2tpQXFLdXlWaU91Q3RPMllsU29xSUNqc2xZenJvS1RzcEpqc21wUXBEUW9OQ2lNakl5RHRnNERzbmJUdGk0QWc0b0NVSU95bnAreWRnQ0RycW9Yc2dxenF0YXdOQ2cwS0xTRHJxb1hzZ3F6dG1KWHNuTHpyb1p3ZzY0R2Q2NEswN0pxVUxpRHNvb1hxc3JEc2xyVHJyN2pDdCt1bmlPeTVxTzJSbk91bHZDRHNrN0RzcDRBZzdKV0s3SldFN0pxVUlDaCs3SnFVSUM4Z2Z1dUxwQ0F2SUg3cXVZenNtcFEvSU9LZGpDa3VEUW90SURKK05PeVd0T3lnaU91aG5DRHNwNmZxczZBZzdJbTk2cktNTGlEdGxaenNucERzbHJUQ3QreUltT3lMbmV5ZGhDRHF1TGpxc293ZzdJeVQ3S2VBSU95Vml1eVZoT3lhbEM0TkNpMGc3SldJNjRLMEtPdXp1T3VzdUNrZzY2ZWw2NTI5N0oyRUlPeWFsT3lWdmUyVnRDd2dLaXJ0ZzREc25iVHRpNERycDR3ZzY3U1E2NCtFSU91c3RPeUtxQ0R0akozc2w0WHNuYmpzcDRBcUtpRHNsWXpxc293ZzdaVzA3SnFVTGlEc201RHJzN2pzbmJRZ0oreVZqT3Vtdk1LMzdabVY3SjI0Sit5eW1PdWZ2Q0RycDRuc2w3RHRsWmpycWJRZzY3TzQ2Nnk0N0oyRUlPcTN2T3F4c091aG5DRHF0YXpzc3JUdG1aVHRsYlRzbXBRdURRb05DbndnN0oyMDY2Q0g2cktNSU91bmtPcXpvQ0I4SU95ZHRPdWdoK3F5akNCOERRcDhMUzB0ZkMwdExYd05DbndnN0tDQTdKNmw3WldZN0tlQUlPeVZpdXF6b0NEcmdwanFzSURzaTV6cXNxRHNsclRzbXBRL0lId2c3S0NBN0o2bElPeVZpQ0R0bFp3ZzY0SzA3SnFwSUh3TkNud2c3SldNNjZhOElId2c2ckt3N0tDY0lPeVpoT3VqakNCOERRcDhJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lId2c2NDJ3N0oyMDdZU3dJT3lDcmV5Z25DQjhEUW9OQ2lNakl5RHNsWWpyZ3JRbzY3TzQ2Nnk0S1NEaWdKUWc3WlcwN0pxVTdMSzBEUW9OQ2kwZ0tpcnRqSkRyaTZqdG1KVXFLdXlkZ0NBbmZ1MlZvT3E1ak95YWxEOG42NkdjSU91c3ZPeVd0T3lhbEM0ZzY1Q1k2NCtNNjZhMElPeUltQ0RzbDRicmlwUWc3SnlFN1plWUtPeUNyZXlnbk1LMzdZT0k3WWUwSU91VHNTbnNuWUFnNnJLdzZyTzg2Nlc4SU91b3ZPeWdnQ0Rxc3IzcXM2RHRsYlRzbXBRdURRb3RJQ29xN0pXSTY0SzA3WmlWS2lyc25ZQWc3SUtzN0l1azdKMkVJT3lFbk95SW9PMlZ0T3lhbEM0TkNpMGc2NmVJN0xtbzdaR2M2Nlc4SU95TnFPeWFsQzRnN0lpcjdKNlF3cmZzb2JEcXNiUW83SjIwN0lPQndyZnNuYlR0bFpqQ3QreWR0T3VDdENEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaRHFzNkFzSU95YmtPdXN1T3lYa0NEc2w0YnJpcFFnN0tDVjY3TzB3cmZzb0lqc3NLakN0K3lYc091ZHZleXltT3VsdkNEc3A0RHNsclRyZ3JUc3A0QWc3SldLN0pXRTdKcVVMZzBLRFFvakl5TWc2N0tFN1lxOElPS0FsQ0RzbFlqcmdyUWc2Nnk0NjZlbDdKMjBJT3lnbGUyVnRPeWFsQTBLRFFwOElPdXp1T3VzdU95ZHRDRHNuYlRyb0lmcmk2UWdmQ0Ryc29UdGlyd2dmQTBLZkMwdExYd3RMUzE4RFFwOElPcXlzT3F6dk1LMzdJT0I3WU9jNjZXOElPMkd0ZXV6dENCOElGdnRtWlhzbmJoZElId05DbndnSjM3dGxhRHF1WXpzbXBRL0ordWhuQ0Ryckx6c25Zd2dmQ0JiN0pXRTY0dUk3SmlrWFNEQ3R5QmI2NFNrWFNCOERRcDhJT3lEZ2UyWnFTRHNoSnpzaUtBZ0t5RHNtS1RycGJqc3FyM3NuYlFnN0l1azdLQ2NJT3VQbWV5ZWtTQjhJRnZzdDZqc2hveGRJTUszSUZ0NzY0K1o3SjZSZlYwZ2ZBMEtEUW90SUNmc3Q2anNob3duNjRxVUlDb3E2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNS2lvZzdJMm83SnFVSUNqc21JZzZJRnZzdDZqc2hveGR3cmRiN0lLdDdLQ2NYU2t1SUNmcmk2dnF1TEFnd3JjZzY0K1o3SjZSSit5eW1PdWZ2Q0RzcDUzc25iUWc3SldJSU91bm51dUtsQ0Rzb2JEdGxhbnNuYlRyZ3BnZzY0dW82NCtGSUNmc3Q2anNob3duNjRxVUlPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRb3RJT3V5aE8yS3ZPeWRtQ0RyajVuc25wRWc3SjIwNjZhRTdKMkFJTzJabE91cHRDRHF1TERyaXFYcnFvVW82N09BNnJLOXdyZnRsYlRzb0p3ZzY1T3hLZXlkaENEcXQ3anJqSURyb1p3ZzdJSzA2NkNrN0pxVUxnMEtEUW9qSXlNZzdZYTE3S2VjSU95WWlPeUxuQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0oyMDdZT0lLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHNvSURzbnFVZzdKV0lJTzJWbkNEcmdyVHNtcWtOQ2kwZzdKV0k2NEswT2lEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhnN0o2RjY2Q2w3WldjSU91Q3RPeWFxZXlkdENEc2dxenJuYnpzb0xqc21wUXVEUW90SU91eWhPMkt2RG9nN0pXRTY0dUk3SmlrSU1LM0lPdUVwQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0lLdDdLQ2NJQ2pzbklUdGw1Z3BLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHJqYkRzbmJUdGhMQWc3SUt0N0tDY0RRb3RJT3lWaU91Q3REb2c3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0RzZ3JUcnByUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzdJS3Q3S0NjN1pXZzZybU03SnFVUHcwS0xTRHJzb1R0aXJ3NklPeVZoT3VMaU95WXBDREN0eURyaEtRTkNnMEtLaXJyajVuc25wSHRtSlVnNG9DVUlPeUVuT3lJb0NBcklPdVBtZXlla1NEcnNvVHRpcndxS2cwS0xTRHRnNERzbmJUdGk0QTZJT3E0c09xNHNDRHNsN0Rxc3JBZzdaVzA3S0NjRFFvdElPeVZpT3VDdERvZzdJU2c3WU9kN1pXY0lPcTRzT3E0c095ZG1DRHNsN0Rxc3JEc25ZUWc2NEdLN0phMDdKcVVMZzBLTFNEcnNvVHRpcnc2SU95M3FPeUdqQ0RDdHlEc2w3RHFzckFnN1pXMDdLQ2NEUW9OQ2lvcTdKV0k2NEswN1ppVklPS0FsQ0RzbVlUcm80d2c3WWExNjdPMEtpb05DaTBnN1lPQTdKMjA3WXVBT2lEcXNyRHNvSndnN0ptRTY2T01EUW90SU95VmlPdUN0RG9nNnJLdzdLQ2M2ckNBSU95Z2xleURnU0Rzc3BqcnBxenJrSkRzbHJUc21wUXVEUW90SU91eWhPMkt2RG9nN1ptVjdKMjREUW9OQ2lvcUtnMEtEUW9qSU95WWlPeVp1Q0RxdDV6c3Vaa05DZzBLN0p1UTdMbVpLT3VLcGV1UG1jSzM2cmlON0tDVndyZnN1cERzbzd6c2xyd3A2N08wNjR1a0lPeVlpT3ladU9xd2dDRHJqWlFnNjZxRjdabVY3WldjSU95N3BPdXVwT3VMaU95OGdPeWR0T3lGbU95ZGhDRHJwNHpyazV6cmlwUWc2cks5N0pxdzdKaUk3SnFVTGcwS0RRb2pJeURzbUlqc21iZ2dNUzRnN0lpWTY0K1o3WmlWSU91c3VPeWVwZXlkaENEc2phanJqNFFnNjVDWTY0cVVJT3F5dmV5YXNBMEtEUW9qSXlNZzdJU2M2N21FN0lxa0lPeWloZXVqakN3ZzZyaXc2ckNFSU91bmpPdWpqQTBLRFFyc2lKanJqNW50bUpYc25MenJvWndnN0pPdzY2bTBJT3lqdk95V3RDanNvb1hybzR3ZzdJU2M2N21FN0lxa0xDRHF1TERxc0lRZzY1T3hLZXVsdkNEcXNKWHNvYkR0bGFBZzdJaVlJT3llaU9xem9Dd2dKK3lpaGV1ampDZnNtWUFnSit1bmpPdWpqQ2ZzblpnZzY0bVk3SldaN0lxazY2VzhJT3lnbGUyWmxlMmVpQ0Rzb0lUcmk2enRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0JQVDA4ZzdJU2M2N21FN0lxa0lPeWloZXVqakNEc2xZanJnclFnNG9DVUlEQXc3SnVVSURBdzdKMjg2N2FBN1lTd0lPeUVuT3U1aE95S3BPcXdnQ0Rzb29Ycm80enJqN3pzbXBRdUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZUWc3SldNNjZDazY1T2M2NkNrN0pxVUxnMEtMU0RzbnBEc2dyQWc3S0d3N1pxTUlPcTRzT3F3aE95ZHRDRHFzNmNnNjZlTTY2T002NCs4N0pxVUxnMEtEUXJyaTZnc0lDb3E3S084NnJpdzdLQ0I3Snk4NjZHY0lPeWloZXVqak9xd2dDRHJzSmpyczdYcmtKanJpcFFnN0tDYzdaS0lLaXJzbDVEcmlwUWdKK3lpaGV1ampPdVB2T3lhbENmcnBid2c3Sk93N0tlQUlPeVZpdXlWaE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbUtUcmlwanNuWmdnN1lDMDdLYUk2ckNBSU9xenB5RHNvb1hybzR6cmo3enNtcFFnNG9hU0lPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEEwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0plUTZyS01JT3V2dU95NW1PdUtsQ0RzbUlIdGxxWHNuWVFnN0pXTTY2Q2s3S1NFSU91VmpBMEtEUW9vN0tPODdKcVVJT3VQbWV5Q3JDQTZJT3lYc095eXRDd2c3WlcwN0tlQUxDRHNvSUhzbXFrZzY1T3hLUTBLRFFyc2lKanJqNW50bUpYc25MenJvWndnN0pPdzY2bTBJT3lkdU9xenZDRHF0SURxczRUcnBid2c2NnFGN1ptVjdaV1k2cktNSU95RXBPdXFoZTJWbU9xem9Dd2dKK3lDck95YXFleWVrT3lkbUNEdGxvbnJqNW5zbDVBZzY1U3c2NTI4N0ppazY0cVVJT3F5c09xenZDZnJuYnpyaXBRZzdLQ1E3SjJFSU95VmpPdWdwT3lraENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95WXBPdUttT3E1ak95bmdDRHJnclRzcDRBZzdKV0s3Snk4NjZtMElPeVhzT3l5dE91UHZPeWFsQzRnN1p1RTY3YUk2ckt3N0tDY0lPcTRpT3lWb2V5ZGhDRHJnclRzbzd6c2hManNtcFF1RFFvdElPdU1nT3kybk95ZGhDRHFzSWpzbFlUdGc0RHJxYlFnN0p1UTY1NllJT3VNZ095Mm5PeWR0Q0R0bGJUc3A0RHJqN3pzbXBRdUlPeVlwT3VLbUNEcmdxRHNwNXpxdVl6c3A0RHNuWmdnN0oyMDdKNlE2Nlc4SU95ZGdPMldpZXlYa0NEcmdyVHNsYndnN1pXMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlFJT3lWaU95THJDQW83SWlZNjQrWjdaaVZLUTBLRFFvbjdLQ1Y2N08wSU95SW1PeW5rU0RzbFlqcmdyUW5JT3VUc2V5ZG1DRHJyN3pxc0pEdGxad2c3SU9CN1ptcDdKZVE3SVNjSUNvcTdJdWM3SXFrN1lXYzdKMjBJT3lla091UG1leWN2T3VobkNEc3NwanJwcXp0bFp6cmk2VHJpcFFnN0tDUUtpcnNuWVFnN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lkdE95Z25PdTJnTzJFc0NEdG1ZM3F1TGpyajVucmk1anNuWmdnNnJDYzdKMjQ3S0NWNjdPMElPeWR0T3lhcVNEcmdyVHNsNjNzbmJRZzZyaXc2NkdkNjQrODdKcVVEUW90SU91TmxDRHNvb3ZzbllBZzdJT0I2NHUwN0oyRUlPeWNoTzJWdENEdGhyWHRtWlFnNjRLMDdKcXA3SjJBSU91RnVleWRqT3VQdk95YWxBMEtEUW9qSXlEc21JanNtYmdnTWk0ZzZySzk3SmEwNjZXOElPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdEUW9OQ3UyS3VleWdsU0RzZzRIdG1hbnNsNURzaEp3ZzdLQ2M3WldjN0tDQjdKeTg2NkdjSUNmc2k1enJncGpzbXBRL0xDRHNoYWpyZ3Bqc21wUS9KeURzblpqcnJManRtSlVnN0phMDY2KzQ2Nlc4SU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0oyWUlPdW5wZXVkdmV5ZGhDRHRtWnpzbXFudGxiVHNoSndnN0tlSTY2eTQ3WldnSU91VmpBMEtEUW9uN0l1YzY0S1k3SnFVUHljc0lDZnNoYWpyZ3Bqc21wUS9KeUR0bUpYdGc1enNuWmdnNnJLOTdKYTA2Nlc4SU8yWm5PeWFxZTJWdE95RW5DRHNncXpzbXFuc25wRHNuWmdnNjR1NTdabXA3SXFrNjUrczdKdUE3SjJFSU95a2hPeWR2Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbUN3Z1QwOVBJT3VMcE91RmdPeVlwT3lGcU91Q21PeWFsRDhOQ2kwZzdMYXA3S0NFN1pXWTY1K3NJTzJPdU95ZG1PeWdrQ0Rxc0lEc2k1enJncGpzbXBRL0RRb05DaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SU9CN1ptcDdKMkVJT3kybE95Z2xlMlZvQ0RybFl3TkNnMEs2NnFGN1ptVjdaV2NJT3lnbGV1enRPcXdnQ0RzbDRic2xyVHNoSndnN0lLczdKcXA3SjZRN0plUTZyS01JT3luZ2V5Z2tTRHRqSkRyaTZqdGxaanFzb3dnN1pXMDdKVzhJTzJWb0NEcmxZd2c2cks5N0phMDY2R2NJT3lnbGV5a2tlMlZtT3F5akNEc3A0anJyTGp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzY3Q2I3Snk4N0lXbzY0S1k3SnFVUHlEcms3SHJvWjN0bFpqcnFiUWc3THFRN0l1YzY3Q3hJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla095ZG1DRHNoS0RzblpqcXNJQWc3WldFN0pxVTdaV2dJT3VWakEwS0RRcnNoS1Ryckxqc29iRHNncXpzc3Bqcm43d2c3SUtzN0pxcDdKNlE3SjJZSU95RW9PeWRtT3VsdkNEcXVMRHJqSUR0bGJUc2xid2c3WldnSU91VmpDRHFzcjNzbHJUcm9ad2c3S0NWN0tTUjdaV1k2cktNSU95bmlPdXN1TzJWdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbmJUcnNvZ2c2NHVzN0plUUlPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsWmpycWJUc2hKd2c3SmE4NjZlSTY0S1lJT3Vuak95aHNlMlZtT3lGcU91Q21PeWFsRDhOQ2cwS0l5TWc3SmlJN0ptNElETXVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBTkNnMEs3SUtzN0pxcDdKNlE3SmVRNnJLTUlPdXFoZTJabGUyVm1PcXlqQ0RydG9Ec29KWHNvSUhzbmJnZzY0SzA3SnFwN0oyRUlPeVZqT3VncE95a21PeVZ2Q0R0bGFBZzY1V002NHFVSU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU95aWkreVZoT3lhbEM0TkNnMEtJeU1qSU95RW5PdTVoT3lLcE91bHZDRHNvSlhzc1lYc2c0RWc3Sk80SU95SW1DRHNsNGJzbllRZzY1V01EUW9OQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeURnZTJacWV5ZGhDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3SXVjN1lLc0lPeUltQ0Rzbm9qc2xyVHNtcFF1SUNvcTdKTzRJT3lJbUNEc2w0YnJpcFFnN0oyMDdKeWc2Nlc4SU8yVnFPcTdtQ0RzbFlqcmdyVHRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNwNERxdUlqc25ZQWc2ckNBN0o2RjdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlPeXlyZXlHak91RmhPeWRoQ0RzbklUdGxad2c3SVNjNjdtRTdJcWs2NHFVSU95VmhPeW5nU0RzcElEcnVZUWc3S1NSN0oyMDdKZVE3SnFVTGcwS0xTRHFzN1hyckxUc201RHNuWUFnN1p1RTdKdVE2cmlJN0oyRUlPdXp0T3VDdkNEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SjI4NjdhQUlPcTRzT3VLcGV1bmpDRHNrN2dnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3lOcU95VnZDRHNncXpzbXFuc25wRHFzSUFnN0phMDY1YWtJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3lYaHV1S2xPeW5nQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95RW9PMkRuZXlkbUNEcXNyRHFzN3pycGJ3ZzdKV0k2NEswN1pXZ0lPdVZqQTBLRFFycmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHNoS0R0ZzUzc25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyVm1PcXlqQ0RzbFl6cm9LVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzROQ2cwS0l5TWpJT3lDck95YXFleWVrQ0RzbFlqc2k2d2dLT3UyZ095Z2xlMllsU2tOQ2cwS0oreWdsZXV6dENEc2lKanNwNUVnN0pXSTY0SzBKeURyazdIc25aZ2c2Nis4NnJDUTdaV2NJT3lEZ2UyWnFleVhrT3lFbkNBcUt1eWdsZXV6dE9xd2dDRHJzN1R0bUxqcmtKenJpNlRyaXBRZzdLQ1FLaXJzbllRZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95RGdldUx0T3lkdENEcmdaM3JncGpycWJRZzdLQ0U2Nnk0NnJDQTY0K0VJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHNvSlhyczdUcnBid2c2N084SU95SW1DRHNsNGJzbHJUc21wUXVEUW90SU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHFzSUFnNnJpdzY2R2Q2NUNZN0tlQUlPeVZpdXlWaE95YWxDNE5DZzBLSXlNZzdKaUk3Sm00SURRdUlPeWduTzJTaUNEc21xbnNsclRyaXBRZzY3Q1U2cjY0N0tlQUlPeVZpdXE0c0EwS0RRb242ckNFNnJLdzdaV1k2ck9nSU95SnJPeWF0Q0RycDVBbklPeWJrT3k1bWV1enRPdUxwQ0FxS3UyWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhlcXp2T3lkbUNEc21xbnNsclFnN0oyODdMbVlLaXJxc0lBZzdKcXc3SVNnN0oyMDdKZVE3SnFVTGcwSzZyaXc2NHFsNjZxRjdKZVFJT3lUc095ZHVDRHJpNmpzbHJRbzY3T0E2cks5TENEc3A0RHNvSlVzSU91VHNldWhuU0RyazdFcDY2VzhJT3lWaU91Q3RDRHJyTGpxdGF6c2w1RHNoSndnNjR1azY2VzRJT3Vua091aG5DRHJzSlRxdnJqcnFiUWc3SUtzN0pxcDdKNlE2ckNBSU91THBPdWx1Q0RxdUxEcmlxWHNuTHpyb1p3ZzdKaWs3WlcwN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tnSitxMmpPMlZuQ0RyczREcXNyMG5JT3E0c091S3BleWRtQ0RzbFlqcmdyUWc2Nnk0NnJXc0RRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N0NVNnIrQUlPeUltQ0Rzbm9qc2xyVHNtcFFnS0ZncERRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N09BNnJLOTdaV2dJT3lJbUNEc25vanNsclRzbXBRZ0tFOHBEUW9OQ2lNaklPeVlpT3ladUNBMUxpRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F3ZzdKT3c3S2VBSU95Vml1cTRzQTBLRFFycnJManF0YXpycGJ3ZzdKV0U2NnkwNjZhc0lPdW5wT3VCaE91ZnZlcXlqQ0RyaTZUcms2enNsclRyajRRZ0tpcnNpNlRzb0p3ZzdJdWM3SXFrN1lXY0lPdVBtZXlla2VxenZDRHJpNlRycGJnZzY0K1o3SUtzS2lycnBid2c3Sk93NjZtMElPeWVtT3VxdSt1UW5DRHJyTGpxdGF6c21JanNtcFF1RFFvTkN1eVlpQ2tnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDQW43TGFVNnJDQUlPeW5nT3lnbFNmdGxaanJpcFFnN0l1YzdJcWs3WVdjN0plUTdJU2NJQ2pzbmJUc29JVEN0K3lXa2V1UGhDRHF1TERyaXFYc25iUWc3SldFNjR1WUtRMEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKZVE2cktNSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcnBid2c2NFNZNnJLbzdLTzg3SVM0N0pxVUlDaFlJT0tBbENEc2w0YnJpcFFnSit1RW1PcTRzT3E0c0NjZzZyaXc2NHFsN0oyRUlPeVZsT3lMbkNrTkNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWdENEc283enNoTGpzbXBRZ0tFOHBEUW89JwpESVI9IiRIT01FL0xpYnJhcnkvQXBwbGljYXRpb24gU3VwcG9ydC9DbGF1ZGVCcmlkZ2UiCnB1dCgpIHsgcHJpbnRmICVzICIkMSIgfCBiYXNlNjQgLUQgPiAiJDIiOyB9CiMg7J20IC5jb21tYW5k6rCAIOuPhOuKlCDthLDrr7jrhJAg7LC966eMIOqzqOudvCDri6vripTri6QodHR5IOunpOy5rSkuIGJhc2jqsIAg64Gd64KYIO2DreydtCBpZGxl65CcIDHstIgg65Kk7JeQIOuLq+yVhAojICLtlITroZzshLjsiqQg7Iuk7ZaJIOykkSIg6rK96rOg66W8IO2UvO2VnOuLpCDigJQgZGlzb3du7Jy866GcIOyKpO2BrOumve2KuOqwgCBleGl07ZW064+EIOuLq+q4sCDsnpHsl4XsnYAg7IK07JWE64Ko64qU64ukLiAo66elIOyLpOq4sCDqsoDspp0g7ZWE7JqUKQpNWVRUWT0iJChwcyAtbyB0dHk9IC1wICQkIDI+L2Rldi9udWxsIHwgdHIgLWQgIiAiKSIKY2xvc2VfdGVybWluYWwoKSB7CiAgWyAteiAiJE1ZVFRZIiBdICYmIHJldHVybgogICggc2xlZXAgMQogICAgL3Vzci9iaW4vb3Nhc2NyaXB0ID4vZGV2L251bGwgMj4mMSA8PE9TQQp0ZWxsIGFwcGxpY2F0aW9uICJUZXJtaW5hbCIKICByZXBlYXQgd2l0aCB3IGluIHdpbmRvd3MKICAgIHRyeQogICAgICByZXBlYXQgd2l0aCB0IGluIHRhYnMgb2YgdwogICAgICAgIGlmIHR0eSBvZiB0IGlzICIvZGV2LyRNWVRUWSIgdGhlbiBjbG9zZSB3IHNhdmluZyBubwogICAgICBlbmQgcmVwZWF0CiAgICBlbmQgdHJ5CiAgZW5kIHJlcGVhdAplbmQgdGVsbApPU0EKICApICYgZGlzb3duIDI+L2Rldi9udWxsIHx8IHRydWUKfQojIOyViOuCtOuKlCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukIOKAlCDthLDrr7jrhJDsnYAg7ISk7LmYwrfsoJDqsoDrp4wg7ZWY6rOgIOyKpOyKpOuhnCDri6vtnozri6QuCmZpbmlzaCgpIHsgY2xvc2VfdGVybWluYWw7IGV4aXQgIiQxIjsgfQplY2hvICLtgbTroZzrk5wg7Luk64Sl7YSw66W8IOyEpOy5mO2VmOqzoCDsnojslrTsmpTigKYg7J6g7IucIO2bhCDsnbQg7LC97J2AIOyekOuPmeycvOuhnCDri6vtmIDsmpQuIgpta2RpciAtcCAiJERJUi9zY3JpcHRzIiB8fCB7IGVjaG8gIu2PtOuNlCDsg53shLEg7Iuk7YyoOiAkRElSIjsgZmluaXNoIDE7IH0KcHV0ICIkQjY0X0JSSURHRSIgICAiJERJUi9zY3JpcHRzL2NsYXVkZS1icmlkZ2UuanMiCnB1dCAiJEI2NF9XQVRDSEVSIiAgIiRESVIvc2NyaXB0cy9icmlkZ2Utd2F0Y2hlci5qcyIKcHV0ICIkQjY0X0VYQU1QTEVTIiAiJERJUi9yZWNvbW1lbmQtZXhhbXBsZXMubWQiCnB1dCAiJEI2NF9HVUlERSIgICAgIiRESVIvdXgtd3JpdGluZy5tZCIKZWNobyAi4pyFIO2MjOydvCDshKTsuZg6ICRESVIiCiMgR1VJ7JeQ7IScIOyXsCBUZXJtaW5hbOydgCBQQVRI6rCAIOyigeydhCDsiJgg7J6I7Ja0IO2dlO2VnCDshKTsuZgg6rK966Gc66W8IOuztO2DoOuLpApleHBvcnQgUEFUSD0iJEhPTUUvLmxvY2FsL2Jpbjovb3B0L2hvbWVicmV3L2JpbjovdXNyL2xvY2FsL2JpbjokUEFUSCIKIyBub2Rl6rCAIOyXhuycvOuptCDqsJDsi5zsnpAoPW5vZGUpIOyekOyytOqwgCDrqrsg64+M7JWEIO2UjOufrOq3uOyduOyXkCDslYzrprQg67Cp67KV7J20IOyXhuuLpCDihpIg7J20IOqyveyasOunjCDrhKTsnbTti7DruIwg7Yyd7JeF7Jy866GcIOyViOuCtO2VnOuLpAppZiAhIGNvbW1hbmQgLXYgbm9kZSA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICBvc2FzY3JpcHQgLWUgJ2Rpc3BsYXkgZGlhbG9nICLsnbQgTWFj7JeQIE5vZGUuanPqsIAg7JeG7Ja07JqULiBb7ZmV7J24XeydhCDriITrpbTrqbQg64uk7Jq066Gc65OcIO2OmOydtOyngOqwgCDsl7TroKTsmpQuIE5vZGUuanMoTFRTKeulvCDshKTsuZjtlZwg65KkIOydtCDshKTsuZgg7YyM7J287J2EIOuLpOyLnCDsi6TtlontlbQg7KO87IS47JqULiIgd2l0aCB0aXRsZSAi7YG066Gc65OcIOy7pOuEpe2EsCDigJQgTm9kZS5qcyDtlYTsmpQiIGJ1dHRvbnMgeyLtmZXsnbgifSBkZWZhdWx0IGJ1dHRvbiAxIHdpdGggaWNvbiBjYXV0aW9uIGdpdmluZyB1cCBhZnRlciAxODAnID4vZGV2L251bGwgMj4mMQogIG9wZW4gImh0dHBzOi8vbm9kZWpzLm9yZy9rby9kb3dubG9hZCIgMj4vZGV2L251bGwKICBmaW5pc2ggMApmaQpOT0RFX0JJTj0iJChjb21tYW5kIC12IG5vZGUpIgplY2hvICLinIUgTm9kZS5qczogJChub2RlIC0tdmVyc2lvbikiCiMg6rCQ7Iuc7J6QIGxhdW5jaGQg65Ox66GdICjroZzqt7jsnbgg7J6Q64+Z7Iuc7J6RICsg7KeA6riIIOq4sOuPmSkuIFBBVEjrpbwgcGxpc3Tsl5Ag6rWz7ZiAIOuEo+uKlOuLpCDigJQgbGF1bmNoZCDquLDrs7ggUEFUSOyXlCBjbGF1ZGXqsIAg7JeG64ukLgpQTElTVD0iJEhPTUUvTGlicmFyeS9MYXVuY2hBZ2VudHMvY29tLmNsYXVkZWJyaWRnZS53YXRjaGVyLnBsaXN0Igpta2RpciAtcCAiJEhPTUUvTGlicmFyeS9MYXVuY2hBZ2VudHMiClNBRkVfUEFUSD0iJHtQQVRILy8mLyZhbXA7fSIKY2F0ID4gIiRQTElTVCIgPDxQTElTVEVPRgo8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCI/Pgo8IURPQ1RZUEUgcGxpc3QgUFVCTElDICItLy9BcHBsZS8vRFREIFBMSVNUIDEuMC8vRU4iICJodHRwOi8vd3d3LmFwcGxlLmNvbS9EVERzL1Byb3BlcnR5TGlzdC0xLjAuZHRkIj4KPHBsaXN0IHZlcnNpb249IjEuMCI+CjxkaWN0PgogIDxrZXk+TGFiZWw8L2tleT48c3RyaW5nPmNvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlcjwvc3RyaW5nPgogIDxrZXk+UHJvZ3JhbUFyZ3VtZW50czwva2V5PgogIDxhcnJheT4KICAgIDxzdHJpbmc+JE5PREVfQklOPC9zdHJpbmc+CiAgICA8c3RyaW5nPiRESVIvc2NyaXB0cy9icmlkZ2Utd2F0Y2hlci5qczwvc3RyaW5nPgogIDwvYXJyYXk+CiAgPGtleT5FbnZpcm9ubWVudFZhcmlhYmxlczwva2V5PgogIDxkaWN0PjxrZXk+UEFUSDwva2V5PjxzdHJpbmc+JFNBRkVfUEFUSDwvc3RyaW5nPjwvZGljdD4KICA8a2V5PlJ1bkF0TG9hZDwva2V5Pjx0cnVlLz4KICA8a2V5PktlZXBBbGl2ZTwva2V5PjxkaWN0PjxrZXk+U3VjY2Vzc2Z1bEV4aXQ8L2tleT48ZmFsc2UvPjwvZGljdD4KPC9kaWN0Pgo8L3BsaXN0PgpQTElTVEVPRgpsYXVuY2hjdGwgYm9vdG91dCAiZ3VpLyQoaWQgLXUpL2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlciIgMj4vZGV2L251bGwKbGF1bmNoY3RsIGJvb3RzdHJhcCAiZ3VpLyQoaWQgLXUpIiAiJFBMSVNUIiAyPi9kZXYvbnVsbCB8fCBsYXVuY2hjdGwgbG9hZCAtdyAiJFBMSVNUIiAyPi9kZXYvbnVsbAojIGNsYXVkZSDsnKDrrLTCt+uhnOq3uOyduCDsl6zrtoDripQg7Jes6riw7IScIOyVjOumrOyngCDslYrripTri6Qg4oCUIOqwkOyLnOyekOqwgCDqt7gg7IOB7YOc66W8IO2UjOufrOq3uOyduOyXkCDsoITri6ztlbQKIyDqs4TsoJUg7ZmU66m07J20ICLshKTsuZgg7ZWE7JqUIC8g66Gc6re47J24IO2VhOyalCAvIOykgOu5hCDsmYTro4wi66GcIOuFuOy2nO2VnOuLpCjthLDrr7jrhJDsnbQg7LGE64SQ7J20IOyVhOuLmCkuCiMg7ISk7LmYwrfsoJDqsoAg64GdIOKGkiDssL3snYQg7Iqk7Iqk66GcIOuLq+uKlOuLpC4KZmluaXNoIDAKUEsBAh4DFAAACAAAAAAAAIVtwoDXawIA12sCABsAAAAAAAAAAAAAAO2BAAAAAO2BtOuhnOuTnC3su6TrhKXthLAuY29tbWFuZFBLBQYAAAAAAQABAEkAAAAQbAIAAAA=";
// ===== INSTALLER_MAC:END =====
// 다리 심장박동 — 플러그인이 떠 있는 동안 5초마다 생존 신호를 보낸다.
// 플러그인/피그마가 닫혀 박동이 30초 끊기면 다리가 claude와 함께 스스로 꺼진다 (claude-bridge.js /heartbeat).
// 다리가 꺼져 있으면 그냥 실패 — 심장박동이 다리를 켜지는 않는다 (켜기는 ensureBridgeFromGesture 담당).
function sendHeartbeat() {
    postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/heartbeat', {}, 3000).catch(() => { });
}
sendHeartbeat();
// 박동과 함께 다리 상태도 주기적으로 갱신한다 — 안 하면 백그라운드에서 다리가 꺼지거나 켜져도
// 버튼 라벨이 옛 상태로 남는다(화면 진입·버튼 클릭 때만 조회했음). /health는 로컬 호출이라 비용 무시 가능.
setInterval(() => { sendHeartbeat(); refreshBridgeStatus(true); }, 5000);
// 타임아웃 있는 fetch — 한 요청이 멈춰도 그 슬롯이 영원히 막히지 않게 한다.
// Figma 플러그인 런타임엔 AbortController가 없어 Promise.race로 구현 (느린 fetch는 버려지고 슬롯만 푼다).
function fetchWithTimeout(url, ms) {
    return Promise.race([
        fetch(url),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('타임아웃 ' + ms + 'ms')), ms)),
    ]);
}
// 에러 객체에서 사람이 읽을 메시지 추출 ([object Object] 방지)
function errStr(e) {
    if (!e)
        return 'unknown';
    if (typeof e === 'string')
        return e;
    if (e.message)
        return String(e.message);
    try {
        return JSON.stringify(e);
    }
    catch (_e) {
        return String(e);
    }
}
// ── AI 기능(문구 추천 / 번역) — 같은 서버의 다른 경로로 POST 요청 ──
// NAVER_PROXY_URL은 끝에 '/'가 있으므로 경로를 그대로 이어 붙인다.
async function postJsonWithTimeout(url, body, ms) {
    return Promise.race([
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('타임아웃 ' + ms + 'ms')), ms)),
    ]);
}
// 현재 선택 영역 안의 모든 텍스트를 하나의 문자열로 모은다 (직접 입력이 없을 때 사용)
async function collectSelectedText() {
    const selection = figma.currentPage.selection;
    if (!selection || selection.length === 0)
        return '';
    const parts = [];
    for (const node of selection) {
        if (node.type === 'TEXT') {
            parts.push(node.characters);
        }
        else {
            const found = await findAllTextNodes(node, 10000);
            for (const t of found)
                parts.push(t.characters);
        }
    }
    return parts.join('\n').trim();
}
// 진행 중인 키 요청 공유 — 동시 작업들이 각자 키를 다시 가져오지 않게 한다
let naverKeyPromise = null;
async function getNaverPassportKey(force = false) {
    if (naverPassportKey && !force)
        return naverPassportKey;
    if (naverKeyPromise && !force)
        return naverKeyPromise;
    naverKeyPromise = fetchNaverPassportKey();
    try {
        return await naverKeyPromise;
    }
    finally {
        naverKeyPromise = null;
    }
}
async function fetchNaverPassportKey() {
    try {
        const res = await fetchWithTimeout(NAVER_PROXY_URL + 'passport', 8000);
        if (!res.ok) {
            naverDiag = '프록시 HTTP ' + res.status;
            console.log('[UX-SPELL]', naverDiag);
            return null;
        }
        const data = await res.json();
        naverPassportKey = (data && typeof data.passportKey === 'string') ? data.passportKey : null;
        if (!naverPassportKey) {
            naverDiag = 'passportKey 못 받음: ' + (data && data.error ? data.error : '알 수 없음');
            console.log('[UX-SPELL]', naverDiag);
        }
        else {
            console.log('[UX-SPELL] passportKey OK:', naverPassportKey.slice(0, 10) + '…');
        }
        return naverPassportKey;
    }
    catch (e) {
        naverDiag = '프록시 fetch 실패: ' + errStr(e);
        console.log('[UX-SPELL] proxy fetch error', e);
        return null;
    }
}
function decodeEntities(s) {
    // 네이버 notag_html은 줄바꿈을 <br> 태그로 돌려준다 → 실제 줄바꿈으로 복원
    return s.replace(/<br\s*\/?>/gi, '\n')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
// 네이버 교정 유형(색깔 클래스) → 한글 라벨. 4종으로 분류된다.
const NAVER_TYPE_LABEL = {
    red_text: '맞춤법',
    green_text: '띄어쓰기',
    violet_text: '표준어 의심',
    blue_text: '통계적 교정',
};
// 변경점으로 취급하지 않을 교정 유형(클래스). 통계적 교정은 우리 기준과 안 맞아 제외한다.
const NAVER_EXCLUDED_CLASSES = new Set(['blue_text']);
// 네이버 교정 유형 라벨 → 로컬 규칙과 같은 문장형 사유
function naverReasonSentence(typeLabel) {
    switch (typeLabel) {
        case '맞춤법': return '맞춤법';
        case '띄어쓰기': return '띄어쓰기';
        case '표준어 의심': return '표준어';
        default: return '맞춤법·띄어쓰기'; // 정의된 4유형 외에는 도달하지 않음
    }
}
// result.html에서 교정 유형 라벨을 등장 순서대로(중복 제거) 추출. 제외 유형은 빼고 반환.
function extractNaverTypes(html) {
    const types = [];
    const re = /<em\s+class='([a-z_]+)'>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (NAVER_EXCLUDED_CLASSES.has(m[1]))
            continue;
        const label = NAVER_TYPE_LABEL[m[1]];
        if (label && types.indexOf(label) === -1)
            types.push(label);
    }
    return types;
}
// 교정문 재조립: 제외 유형(통계적 교정) 구간은 원문(origin_html) 그대로 되돌리고 나머지는 교정 적용.
// origin_html의 밑줄 구간과 html의 <em> 구간은 같은 순서로 1:1 대응한다.
function buildCorrectedExcluding(originHtml, html) {
    const origins = [];
    const oRe = /<span class='result_underline'>([\s\S]*?)<\/span>/gi;
    let om;
    while ((om = oRe.exec(originHtml)) !== null)
        origins.push(om[1]);
    let i = 0;
    const out = html.replace(/<em\s+class='([a-z_]+)'>([\s\S]*?)<\/em>/gi, (_full, cls, corrected) => {
        const original = origins[i] !== undefined ? origins[i] : corrected;
        i++;
        return NAVER_EXCLUDED_CLASSES.has(cls) ? original : corrected;
    });
    return decodeEntities(out);
}
// SpellerProxy 호출 공통 부분: URL 조립 → fetch → JSON 파싱 → 오류 검사까지.
// 성공하면 data.message.result(notag_html 포함)를 돌려주고, 실패는 null + naverDiag 설정.
// 단건(naverSpellChunk)과 배치(naverSpellChunkLines)가 이 헬퍼를 공유한다.
async function fetchSpellerResult(q, key) {
    try {
        const url = 'https://m.search.naver.com/p/csearch/ocontent/util/SpellerProxy'
            + '?passportKey=' + encodeURIComponent(key)
            + '&color_blindness=0&q=' + encodeURIComponent(q);
        const res = await fetchWithTimeout(url, 8000);
        if (!res.ok) {
            naverDiag = 'SpellerProxy HTTP ' + res.status;
            console.log('[UX-SPELL]', naverDiag);
            return null;
        }
        const raw = await res.text();
        let data = null;
        try {
            data = JSON.parse(raw);
        }
        catch (_e) {
            naverDiag = 'SpellerProxy 응답 JSON 파싱 실패';
            console.log('[UX-SPELL]', naverDiag, raw.slice(0, 120));
            return null;
        }
        if (!data || !data.message || data.message.error) {
            naverDiag = 'SpellerProxy 오류: ' + (data && data.message && data.message.error ? data.message.error : '알 수 없음');
            console.log('[UX-SPELL]', naverDiag);
            return null;
        }
        const result = data.message.result;
        if (!result || typeof result.notag_html !== 'string')
            return null;
        naverOkCount++; // 정상 응답 1건
        return result;
    }
    catch (e) {
        naverDiag = 'SpellerProxy fetch 실패: ' + errStr(e);
        console.log('[UX-SPELL] SpellerProxy fetch error', e);
        return null;
    }
}
// ≤500자 한 덩어리 검사. 반환: {corrected, errata, types} 또는 null(실패/키만료)
async function naverSpellChunk(text, key) {
    const result = await fetchSpellerResult(text, key);
    if (!result)
        return null;
    // html + origin_html이 있으면 통계적 교정을 제외하고 재조립, 없으면 notag_html 그대로
    const corrected = (typeof result.html === 'string' && typeof result.origin_html === 'string')
        ? buildCorrectedExcluding(result.origin_html, result.html)
        : decodeEntities(result.notag_html);
    const types = typeof result.html === 'string' ? extractNaverTypes(result.html) : [];
    return { corrected, errata: result.errata_count || 0, types };
}
async function naverSpellCheck(text) {
    if (!text || !text.trim() || text.length > 500)
        return { text, reasons: [], checked: false };
    // 한글이 없으면(숫자·영문·기호만) 맞춤법 검사할 게 없으니 네트워크 요청 생략
    if (!/[가-힣]/.test(text))
        return { text, reasons: [], checked: false };
    let key = await getNaverPassportKey();
    if (!key)
        return { text, reasons: [], checked: false };
    // 네이버에는 모든 줄바꿈을 \n으로 통일해 보낸다
    // (U+2028 등을 그대로 보내면 일반 공백으로 뭉개져 "보이지 않는 차이" 제안이 생긴다)
    const sendText = text.replace(/\r\n|[\r\u2028\u2029]/g, '\n');
    let r = await naverSpellChunk(sendText, key);
    if (r === null) {
        // 키 만료 가능 → 1회 재발급 후 재시도
        key = await getNaverPassportKey(true);
        if (key)
            r = await naverSpellChunk(sendText, key);
    }
    if (r === null)
        return { text, reasons: [], checked: false };
    // 네이버가 합성어를 띄어 쓰거나 예외 표기를 바꾼 경우 용어집 표기로 되돌린다
    // — 되돌려서 원문과 같아지면 제안 자체가 사라진다.
    // 공백 구조(줄바꿈·각 줄 앞뒤 공백)도 원문대로 복원 (네이버가 잘라내면 똑같아 보이는 제안이 생김)
    const cleaned = r.errata > 0 ? revertKeptSpellings(text, protectCompounds(r.corrected)) : r.corrected;
    const corrected = alignWhitespace(text, cleaned);
    let reasons = [];
    if (corrected !== text && r.errata > 0) {
        // 네이버가 분류한 교정 유형을 로컬 규칙처럼 문장형 사유로 (유형별 한 줄)
        reasons = r.types.length
            ? r.types.map(naverReasonSentence)
            : ['맞춤법·띄어쓰기'];
    }
    return { text: corrected, reasons, checked: true };
}
// 여러 문구를 \n으로 이어 한 번에 검사하고 줄 단위로 분해해 돌려준다.
// 네이버는 줄바꿈을 <br>로 보존하므로 줄별 교정문/유형을 복원할 수 있다 (실서버 확인됨).
// 줄 수가 안 맞으면 null (호출자가 단건 검사로 폴백).
async function naverSpellChunkLines(joined, key, lineCount) {
    try {
        const result = await fetchSpellerResult(joined, key);
        if (!result)
            return null;
        // html + origin_html이 있으면 줄별로 통계 교정 제외 + 유형 추출
        if (typeof result.html === 'string' && typeof result.origin_html === 'string') {
            const hLines = result.html.split(/<br\s*\/?>/i);
            const oLines = result.origin_html.split(/<br\s*\/?>/i);
            if (hLines.length === lineCount && oLines.length === lineCount) {
                const outLines = [];
                for (let i = 0; i < lineCount; i++) {
                    outLines.push({
                        corrected: buildCorrectedExcluding(oLines[i], hLines[i]),
                        types: extractNaverTypes(hLines[i]),
                    });
                }
                return outLines;
            }
        }
        // 폴백: notag_html을 줄로 분해 (유형 정보는 없음)
        const plain = decodeEntities(result.notag_html).split('\n');
        if (plain.length === lineCount)
            return plain.map((c) => ({ corrected: c, types: [] }));
        naverDiag = '배치 응답 줄 수 불일치';
        return null;
    }
    catch (e) {
        naverDiag = 'SpellerProxy fetch 실패: ' + errStr(e);
        return null;
    }
}
// 네이버 검사 결과 캐시 (플러그인 세션 동안 유지) — 재검토 시 같은 문구는 네트워크를 생략한다
const naverCache = new Map();
// 동시 실행 개수를 제한해 비동기 작업 처리 (네트워크 과다 호출 방지)
async function mapWithConcurrency(items, limit, fn, onProgress) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let done = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i], i);
            done++;
            if (onProgress)
                onProgress(done);
        }
    }
    const workers = [];
    for (let w = 0; w < Math.min(limit, items.length); w++)
        workers.push(worker());
    await Promise.all(workers);
    return results;
}
// 여러 텍스트를 한 번에 검사: 캐시 → 배치(여러 문구를 \n으로 묶어 요청 1개) → 실패 시 단건 폴백.
// 문구당 요청 1개씩 보내던 방식 대비 요청 수가 1/N로 줄어 검토가 크게 빨라진다.
async function naverSpellCheckAll(uniqueTexts, onProgress) {
    const out = new Map();
    let done = 0;
    const report = (n) => { done += n; if (onProgress)
        onProgress(done); };
    const setResult = (t, r) => {
        out.set(t, r);
        if (r.checked)
            naverCache.set(t, r); // 성공한 결과만 캐시 (실패는 다음 검토 때 재시도)
    };
    const toCheck = [];
    for (const t of uniqueTexts) {
        const cached = naverCache.get(t);
        if (cached) {
            out.set(t, cached);
            report(1);
            continue;
        }
        if (!t || !t.trim() || t.length > 500 || !/[가-힣]/.test(t)) {
            out.set(t, { text: t, reasons: [], checked: false });
            report(1);
            continue;
        }
        toCheck.push(t);
    }
    if (toCheck.length === 0)
        return out;
    // 줄바꿈(\n, \r, U+2028, U+2029) 포함 텍스트는 단건 검사
    // (배치 구분자로 \n을 쓰므로 섞으면 줄 복원이 모호해진다)
    const singles = toCheck.filter((t) => LINE_BREAK_CHARS.test(t));
    const flats = toCheck.filter((t) => !LINE_BREAK_CHARS.test(t));
    // 한 줄짜리 문구들을 450자/30개 한도로 묶는다
    const batches = [];
    let cur = [];
    let curLen = 0;
    for (const t of flats) {
        if (cur.length > 0 && (curLen + 1 + t.length > 450 || cur.length >= 30)) {
            batches.push(cur);
            cur = [];
            curLen = 0;
        }
        cur.push(t);
        curLen += t.length + 1;
    }
    if (cur.length > 0)
        batches.push(cur);
    // 배치 1개 처리: 줄 복원이 안 되면 단건 검사로 폴백
    const runBatch = async (texts) => {
        if (texts.length === 1) {
            setResult(texts[0], await naverSpellCheck(texts[0]));
            report(1);
            return;
        }
        let key = await getNaverPassportKey();
        let lines = key ? await naverSpellChunkLines(texts.join('\n'), key, texts.length) : null;
        if (lines === null && key) {
            // 키 만료 가능 → 1회 재발급 후 재시도
            key = await getNaverPassportKey(true);
            if (key)
                lines = await naverSpellChunkLines(texts.join('\n'), key, texts.length);
        }
        if (lines === null) {
            for (const t of texts) {
                setResult(t, await naverSpellCheck(t));
                report(1);
            }
            return;
        }
        for (let i = 0; i < texts.length; i++) {
            const t = texts[i];
            // 네이버가 합성어를 띄어 쓰거나 예외 표기를 바꾼 경우 되돌린다 (단건 검사와 동일) + 공백 구조 복원
            const corrected = alignWhitespace(t, lines[i].corrected !== t ? revertKeptSpellings(t, protectCompounds(lines[i].corrected)) : lines[i].corrected);
            const reasons = corrected !== t
                ? (lines[i].types.length ? lines[i].types.map(naverReasonSentence) : ['맞춤법·띄어쓰기'])
                : [];
            setResult(t, { text: corrected, reasons, checked: true });
        }
        report(texts.length);
    };
    const jobs = [];
    for (const b of batches)
        jobs.push(() => runBatch(b));
    for (const t of singles)
        jobs.push(async () => { setResult(t, await naverSpellCheck(t)); report(1); });
    await mapWithConcurrency(jobs, 6, (job) => job());
    return out;
}
/**
 * 새로운 엔진: 텍스트에 대한 제안 생성
 * naverChecked: 이 텍스트가 네이버 맞춤법 검사를 통과했으면 true.
 *               띄어쓰기는 네이버 결과를 우선하므로 부사 띄어쓰기 폴백 규칙을 건너뛴다.
 */
function suggestFriendlyKorean(text, naverChecked = false) {
    const original = text;
    // 0) 합성어 보호 → 용어 통일 + 권장 문구 (사내 용어집 — 톤 변환 전에 먼저 적용해야 패턴이 맞는다)
    //    합성어 보호가 먼저 돌아야 띄어 쓰인 변형("고객 인증번호")도 TERM_RULES에 걸린다
    const protect = applyRules(original, COMPOUND_PROTECT_RULES);
    const term = applyRules(protect.text, TERM_RULES);
    // 1) 오타/띄어쓰기(가벼운 룰)
    let typo = applyRules(term.text, TYPO_RULES);
    // 1-1) 부사 띄어쓰기 — 네이버 검사가 안 된 텍스트에만 폴백으로 적용 (오탐 위험 규칙)
    if (!naverChecked) {
        const adverb = applyRules(typo.text, ADVERB_SPACING_RULES);
        typo = {
            text: adverb.text,
            tags: Array.from(new Set([...typo.tags, ...adverb.tags])),
            reasons: [...typo.reasons, ...adverb.reasons],
        };
    }
    // 1-2) 날짜·시간 표기 (구분자·연월일 0 제거 — 네이버와 무관하게 항상 적용)
    const dateFmt = applyRules(typo.text, DATE_FORMAT_RULES);
    // 2) 조사 교정 (받침 기반: 을/를)
    const particle = fixParticles(dateFmt.text);
    // 3) 구조 변환(문장 레벨)
    const structural = applyRules(particle.text, REWRITE_RULES);
    // 4) 패턴 DB(해요체+용어 통일)
    const pattern = applyPatternDB(structural.text);
    // 4-1) '~해 주세요' 띄어쓰기 통일 (모든 톤 변환 결과에 일괄 적용)
    const hae = applyRules(pattern.text, HAEJUSEYO_RULES);
    // 5) 마침표 추가 (패턴 적용 후) - 원본에 마침표가 있으면 reason 추가 안 함
    const period = applyPeriodRule(hae.text, original);
    // 최종 after (문장일 때)
    const finalAfter = period.text;
    // reason/tags 합치기
    const mergedReasons = [...protect.reasons, ...term.reasons, ...typo.reasons, ...dateFmt.reasons, ...particle.reasons, ...structural.reasons, ...pattern.reasons, ...hae.reasons, ...period.reasons];
    const mergedTags = [...protect.tags, ...term.tags, ...typo.tags, ...dateFmt.tags, ...structural.tags, ...pattern.tags, ...hae.tags];
    const suggestions = [];
    const mainSuggestion = buildSuggestion(original, finalAfter, mergedReasons, mergedTags);
    if (mainSuggestion)
        suggestions.push(mainSuggestion);
    return suggestions;
}
// 자식을 가질 수 있는 노드 타입 (최적화를 위해 미리 정의)
const CONTAINER_NODE_TYPES = new Set([
    "FRAME", "GROUP", "COMPONENT", "INSTANCE", "SECTION", "PAGE"
]);
// 선택된 노드 내부의 모든 텍스트 노드를 재귀적으로 찾기 (최적화 버전 - 비동기)
async function findAllTextNodes(node, maxNodes = 10000, onProgress) {
    const textNodes = [];
    const stack = [node]; // 스택 기반 반복 방식으로 재귀 최적화
    let processedCount = 0;
    const CHUNK_SIZE = 100; // 100개씩 처리 후 yield (성능 최적화)
    let lastProgressUpdateTime = Date.now();
    const PROGRESS_UPDATE_TIME_INTERVAL = 50; // 50ms마다 시간 기반 업데이트
    // 스택이 빌 때까지 반복
    while (stack.length > 0 && textNodes.length < maxNodes) {
        const current = stack.pop();
        processedCount++;
        // 비활성화된 노드는 스킵 (최적화)
        if ('visible' in current && current.visible === false) {
            continue;
        }
        // 현재 노드가 텍스트 노드인 경우
        if (current.type === "TEXT") {
            textNodes.push(current);
            continue; // 텍스트 노드는 자식이 없으므로 다음으로
        }
        // 자식을 가질 수 있는 노드 타입만 처리 (최적화)
        if (CONTAINER_NODE_TYPES.has(current.type)) {
            // 자식 노드가 있는 경우 스택에 추가
            if ('children' in current && current.children) {
                const children = current.children;
                // 역순으로 추가하여 순서 유지 (pop이 마지막 요소를 반환하므로)
                for (let i = children.length - 1; i >= 0; i--) {
                    stack.push(children[i]);
                }
            }
        }
        // 진행률 업데이트 (시간 기반만, 성능 최적화)
        if (onProgress && (processedCount % CHUNK_SIZE === 0)) {
            const now = Date.now();
            if ((now - lastProgressUpdateTime) >= PROGRESS_UPDATE_TIME_INTERVAL) {
                // 단순한 진행률 계산: 처리된 노드 수와 남은 스택 크기 기반
                const totalEstimated = processedCount + stack.length;
                const estimatedProgress = totalEstimated > 0
                    ? Math.min(95, (processedCount / totalEstimated) * 100)
                    : 95;
                onProgress(estimatedProgress);
                lastProgressUpdateTime = now;
            }
        }
        // 일정 개수 처리 후 yield하여 UI 블로킹 방지
        if (processedCount % CHUNK_SIZE === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    return textNodes;
}
// 캐릭터 레벨 스타일을 저장하는 헬퍼
function saveRangeStyle(node, pos) {
    const style = {};
    try {
        if (node.getRangeFills) {
            const v = node.getRangeFills(pos, pos + 1);
            if (v !== figma.mixed)
                style.fills = v;
        }
        if (node.getRangeFontName) {
            const v = node.getRangeFontName(pos, pos + 1);
            if (v !== figma.mixed)
                style.fontName = v;
        }
        if (node.getRangeFontSize) {
            const v = node.getRangeFontSize(pos, pos + 1);
            if (v !== figma.mixed)
                style.fontSize = v;
        }
        if (node.getRangeLetterSpacing) {
            const v = node.getRangeLetterSpacing(pos, pos + 1);
            if (v !== figma.mixed)
                style.letterSpacing = v;
        }
        if (node.getRangeTextDecoration) {
            const v = node.getRangeTextDecoration(pos, pos + 1);
            if (v !== figma.mixed)
                style.textDecoration = v;
        }
    }
    catch (_a) { }
    return style;
}
// 저장된 스타일을 범위에 복원하는 헬퍼
function restoreRangeStyle(node, start, end, style) {
    try {
        if (style.fills && node.setRangeFills)
            node.setRangeFills(start, end, style.fills);
        if (style.fontName && node.setRangeFontName)
            node.setRangeFontName(start, end, style.fontName);
        if (style.fontSize && node.setRangeFontSize)
            node.setRangeFontSize(start, end, style.fontSize);
        if (style.letterSpacing && node.setRangeLetterSpacing)
            node.setRangeLetterSpacing(start, end, style.letterSpacing);
        if (style.textDecoration && node.setRangeTextDecoration)
            node.setRangeTextDecoration(start, end, style.textDecoration);
    }
    catch (_a) { }
}
// 노드에 변경 적용하는 헬퍼 함수 (캐릭터 레벨 포매팅 보존)
function applyChangeToNode(node, previewMap, changedNodeIds, _errors) {
    const previewItem = previewMap.get(node.id);
    if (!previewItem)
        return;
    if (node.characters !== previewItem.before)
        return;
    const before = previewItem.before;
    const after = previewItem.after;
    // 변경된 앞/뒤 경계 찾기
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) {
        start++;
    }
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
        endBefore--;
        endAfter--;
    }
    const toInsert = after.slice(start, endAfter);
    // 삭제 전에 해당 범위의 스타일 저장
    const savedStyle = endBefore > start ? saveRangeStyle(node, start) : {};
    // 변경 구간만 교체
    if (endBefore > start && node.deleteCharacters) {
        node.deleteCharacters(start, endBefore);
    }
    if (toInsert.length > 0 && node.insertCharacters) {
        // useStyle은 공식 API 기준 'BEFORE' | 'AFTER' (이전의 'BEFORE_CHARACTER'는 잘못된 값)
        node.insertCharacters(start, toInsert, 'BEFORE');
        // 저장해둔 스타일 복원
        restoreRangeStyle(node, start, start + toInsert.length, savedStyle);
    }
    changedNodeIds.add(node.id);
}
// ===============================
// 캔버스 어노테이션
// ===============================
const ANNOTATION_PREFIX = "__UX_ANN__";
// 형광펜 하이라이트 노드 이름: ANNOTATION_PREFIX + HL_INFIX + nodeId
const HL_INFIX = "HL__";
// 한 노드의 여러 변경을 구분하는 세그먼트 구분자
const SEG_SEP = "##";
// 한 세그먼트가 여러 줄에 걸칠 때 줄별 형광펜을 구분하는 구분자 (SEG_SEP과 겹치면 안 됨)
const LINE_SEP = "~";
// 추적 키는 노드 "이름"이 아니라 pluginData에 저장한다.
// (프레임 노드는 캔버스에 이름표가 떠서, 내부용 키가 이름으로 노출되면 지저분하기 때문)
const PLUGIN_DATA_KEY = 'uxAnnKey';
// 캔버스에 보일 깔끔한 표시 이름
const HL_DISPLAY_NAME = 'UX 형광 표시';
const COMMENT_DISPLAY_NAME = '수정 제안';
// 어노테이션 노드에 키를 심는다
function tagAnnotation(node, key) {
    try {
        node.setPluginData(PLUGIN_DATA_KEY, key);
    }
    catch (_e) { }
}
// 노드에서 어노테이션 키를 읽는다 (pluginData 우선, 옛 버전의 이름 기반도 폴백 인식)
function getAnnNodeKey(node) {
    try {
        const k = node.getPluginData(PLUGIN_DATA_KEY);
        if (k)
            return k;
    }
    catch (_e) { }
    if (typeof node.name === 'string' && node.name.startsWith(ANNOTATION_PREFIX)) {
        return node.name.slice(ANNOTATION_PREFIX.length);
    }
    return '';
}
function isAnnotationNode(node) {
    return getAnnNodeKey(node) !== '';
}
// 키 문자열 파싱 -> { kind, nodeId, seg, key }
// 키 형식: [HL_INFIX] + nodeId + SEG_SEP + segIndex (+ LINE_SEP + lineIndex)
function parseAnnKey(key) {
    if (!key)
        return null;
    let rest = key;
    let kind = 'tooltip';
    if (rest.startsWith(HL_INFIX)) {
        kind = 'hl';
        rest = rest.slice(HL_INFIX.length);
    }
    const sep = rest.lastIndexOf(SEG_SEP);
    const nodeId = sep >= 0 ? rest.slice(0, sep) : rest;
    const seg = sep >= 0 ? rest.slice(sep + SEG_SEP.length) : '0';
    return { kind, nodeId, seg, key };
}
// 노드 파싱
function parseAnnNode(node) {
    return parseAnnKey(getAnnNodeKey(node));
}
// 어노테이션이 속한 "세그먼트(코멘트) 식별자" = nodeId##segIndex.
// 형광펜(HL_INFIX)·줄 접미사(LINE_SEP)를 떼서, 같은 변경의 코멘트와 형광펜이 같은 값을 갖게 한다.
function annSegId(key) {
    let rest = key || '';
    if (rest.startsWith(HL_INFIX))
        rest = rest.slice(HL_INFIX.length);
    const li = rest.indexOf(LINE_SEP);
    if (li >= 0)
        rest = rest.slice(0, li);
    return rest;
}
// nodeId -> 대상 노드 참조 캐시 (폴링 시 동기적으로 위치 읽기용)
const annotationNodeCache = new Map();
// nodeId -> 대상 노드 자신 + 조상 노드 id 집합 (캔버스 선택 매칭용)
const annotationAncestorIds = new Map();
// 조상 노드 id -> 그 아래에 있는 추적 대상 텍스트 nodeId 집합 (documentchange에서 역방향 조회용)
// 프레임 하나가 움직이면 이 인덱스로 영향받는 텍스트만 골라 위치를 갱신한다.
const ancestorToTracked = new Map();
// 어노테이션 노드 id -> 대상 텍스트 nodeId (코멘트를 손으로 끌면 제자리로 되돌리기 위한 역추적)
const annIdToTracked = new Map();
// 어노테이션 key(이름에서 PREFIX 뗀 부분) -> 대상 노드 기준 상대 위치 (프레임 이동 시 위치 갱신용)
// 코멘트/형광펜 모두 이 맵으로 위치를 따라감
const annotationOffset = new Map();
// nodeId -> 그 노드의 어노테이션 노드들.
// 생성/제거/위치추적 모두 이 인덱스를 사용해 페이지 전수 스캔(getAllAnnotations)을 피한다.
// op: 마지막으로 쓴 투명도 (같은 값이면 다시 쓰지 않아 수천 개일 때 브리지 호출을 줄인다)
const annotationsByNode = new Map();
// 방금 만든 어노테이션을 인덱스에 등록
function registerAnnotation(ann) {
    const p = parseAnnNode(ann);
    if (!p)
        return;
    let arr = annotationsByNode.get(p.nodeId);
    if (!arr) {
        arr = [];
        annotationsByNode.set(p.nodeId, arr);
    }
    arr.push({ ann, key: p.key, op: 1 }); // 생성 시 불투명(1)
    try {
        if (ann.id)
            annIdToTracked.set(ann.id, p.nodeId);
    }
    catch (_e) { }
}
// 형광펜 색 (노란 형광)
const HIGHLIGHT_COLOR = { r: 1, g: 0.92, b: 0.2 };
// 어노테이션 폰트 캐시
let annotationFontName = null;
async function ensureAnnotationFont() {
    if (annotationFontName)
        return annotationFontName;
    for (const font of [{ family: "Inter", style: "Medium" }, { family: "Roboto", style: "Medium" }]) {
        try {
            await figma.loadFontAsync(font);
            annotationFontName = font;
            return font;
        }
        catch (_a) { }
    }
    return null;
}
// 특정 노드의 어노테이션이 하나라도 있는지 검색 (인덱스 사용 — 텍스트 편집마다 호출되므로 전수 스캔 회피)
function findAnnotation(nodeId) {
    const arr = annotationsByNode.get(nodeId);
    if (arr) {
        for (const { ann } of arr) {
            if (ann && !ann.removed)
                return ann;
        }
    }
    return null;
}
// 특정 노드의 모든 어노테이션(코멘트 + 형광펜, 모든 세그먼트) 제거
// 인덱스(annotationsByNode)로 바로 찾으므로 페이지 전수 스캔이 없다.
function removeAnnotationByNodeId(nodeId) {
    // 역방향 인덱스 정리
    const ancestors = annotationAncestorIds.get(nodeId);
    if (ancestors) {
        for (const aid of ancestors) {
            const set = ancestorToTracked.get(aid);
            if (set) {
                set.delete(nodeId);
                if (set.size === 0)
                    ancestorToTracked.delete(aid);
            }
        }
        annotationAncestorIds.delete(nodeId);
    }
    const arr = annotationsByNode.get(nodeId);
    if (!arr)
        return;
    for (const { ann, key } of arr) {
        annotationOffset.delete(key);
        try {
            if (ann && ann.id)
                annIdToTracked.delete(ann.id);
        }
        catch (_e) { }
        try {
            ann.remove();
        }
        catch (_e) { }
    }
    annotationsByNode.delete(nodeId);
}
// 모든 어노테이션 노드 수집 (제거/토글용 — pluginData 태그 또는 옛 이름 기반 모두 인식)
function getAllAnnotations() {
    const result = [];
    for (const child of figma.currentPage.children) {
        if (isAnnotationNode(child)) {
            result.push(child);
        }
        if (child.children) {
            for (const gc of child.children) {
                if (isAnnotationNode(gc)) {
                    result.push(gc);
                }
            }
        }
    }
    return result;
}
// 선택되지 않은 어노테이션의 흐림 정도 (낮을수록 더 흐림)
const DIM_OPACITY = 0.15;
// 선택 상태에 따라 어노테이션 투명도 조절 (노드 단위 — 목록 항목 선택 등에 사용)
// selectedIds가 비어있으면 전부 불투명, 아니면 선택된 노드만 불투명/나머지는 반투명
function updateAnnotationOpacity(selectedIds) {
    const selected = new Set(selectedIds);
    for (const [nodeId, arr] of annotationsByNode) {
        const op = (selected.size === 0 || selected.has(nodeId)) ? 1 : DIM_OPACITY;
        for (const entry of arr) {
            if (entry.op === op)
                continue; // 같은 값이면 브리지 호출 생략 (수천 개일 때 중요)
            try {
                if (entry.ann && !entry.ann.removed) {
                    entry.ann.opacity = op;
                    entry.op = op;
                }
            }
            catch (_e) { }
        }
    }
}
// 세그먼트(코멘트) 단위 투명도 조절 — 같은 노드에 여러 코멘트가 있어도 선택한 것만 선명.
// selectedSegIds가 비어있으면 전부 불투명.
function updateAnnotationOpacityBySeg(selectedSegIds) {
    const selected = new Set(selectedSegIds);
    for (const [, arr] of annotationsByNode) {
        for (const entry of arr) {
            const op = (selected.size === 0 || selected.has(annSegId(entry.key))) ? 1 : DIM_OPACITY;
            if (entry.op === op)
                continue;
            try {
                if (entry.ann && !entry.ann.removed) {
                    entry.ann.opacity = op;
                    entry.op = op;
                }
            }
            catch (_e) { }
        }
    }
}
// 캔버스 선택에 따라 어노테이션 투명도 조절
// 선택된 노드 자신 또는 그 하위에 대상 텍스트가 있으면 해당 코멘트를 불투명 처리
function updateAnnotationOpacityFromCanvas(selection) {
    // 선택된 노드들의 id 집합
    const selectedIds = new Set();
    for (const n of selection) {
        if (n && n.id)
            selectedIds.add(n.id);
    }
    // 각 어노테이션의 대상 노드가 선택 범위(자신/조상)에 속하는지 판정
    // (생성 시점에 캐시해 둔 조상 id 집합과 교집합으로 판정 — dynamic-page에서도 안정적)
    const matched = [];
    if (selectedIds.size > 0) {
        for (const nodeId of annotationsByNode.keys()) {
            const ancestors = annotationAncestorIds.get(nodeId);
            if (!ancestors)
                continue;
            for (const id of selectedIds) {
                if (ancestors.has(id)) {
                    matched.push(nodeId);
                    break;
                }
            }
        }
    }
    // 관련된 코멘트가 하나도 없으면 전부 불투명(평상 상태) 유지
    updateAnnotationOpacity(matched);
    // 선택된 노드의 코멘트/형광펜을 맨 앞으로 (겹칠 때 가려지지 않도록)
    bringAnnotationsToFront(matched);
}
// 지정한 노드들의 어노테이션을 z-order 맨 앞으로 올린다 (페이지 끝에 다시 붙이면 최상단)
function raiseAnnotations(nodeIds) {
    for (const nodeId of nodeIds) {
        const arr = annotationsByNode.get(nodeId);
        if (!arr)
            continue;
        // 생성 순서(형광펜 → 배경 → 텍스트)대로 다시 붙여 상대 순서 유지 (텍스트가 위)
        for (const { ann } of arr) {
            try {
                if (ann && !ann.removed)
                    figma.currentPage.appendChild(ann);
            }
            catch (_e) { }
        }
    }
}
let raiseRetryTimer = null;
function bringAnnotationsToFront(nodeIds) {
    raiseAnnotations(nodeIds);
    // 선택 이벤트는 마우스를 누르는 순간 발생해, 클릭 제스처 중의 순서 변경을
    // Figma가 되돌리는 경우가 있다 → 클릭이 끝난 시점에 한 번 더 올린다
    const ids = nodeIds.slice();
    if (raiseRetryTimer !== null)
        clearTimeout(raiseRetryTimer);
    raiseRetryTimer = setTimeout(() => {
        raiseRetryTimer = null;
        raiseAnnotations(ids);
    }, 120);
}
// LCS 기반 diff로 "변경 구간"을 모두 추출 (한 텍스트의 여러 변경을 각각 분리)
// 반환: 각 구간의 before/after 인덱스 범위
function diffSegments(before, after) {
    const n = before.length;
    const m = after.length;
    if (n === 0 && m === 0)
        return [];
    // dp[i][j] = LCS length of before[i:], after[j:]
    const dp = [];
    for (let i = 0; i <= n; i++)
        dp.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            if (before[i] === after[j])
                dp[i][j] = dp[i + 1][j + 1] + 1;
            else
                dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    // 백트래킹으로 연속된 비-동일 구간을 세그먼트로 묶기
    const segments = [];
    let i = 0;
    let j = 0;
    let cur = null;
    const close = () => { if (cur) {
        segments.push(cur);
        cur = null;
    } };
    while (i < n && j < m) {
        if (before[i] === after[j]) {
            close();
            i++;
            j++;
        }
        else {
            if (!cur)
                cur = { bStart: i, bEnd: i, aStart: j, aEnd: j };
            if (dp[i + 1][j] >= dp[i][j + 1]) {
                i++;
                cur.bEnd = i;
            }
            else {
                j++;
                cur.aEnd = j;
            }
        }
    }
    while (i < n) {
        if (!cur)
            cur = { bStart: i, bEnd: i, aStart: j, aEnd: j };
        i++;
        cur.bEnd = i;
    }
    while (j < m) {
        if (!cur)
            cur = { bStart: i, bEnd: i, aStart: j, aEnd: j };
        j++;
        cur.aEnd = j;
    }
    close();
    return segments;
}
// 변경 구간 사이의 "공통(안 바뀐) 글자"가 이 이하면 한 덩어리로 합친다.
// LCS가 중간에 우연히 겹치는 한두 글자(예: "하시겠습니까"→"할까요"의 "까") 때문에
// 변경이 둘로 쪼개져 표시되는 걸 방지 — 미리보기 목록처럼 하나로 보이게 한다.
const SEGMENT_MERGE_GAP = 3;
function mergeCloseSegments(segs, gap, before, after) {
    if (segs.length <= 1)
        return segs;
    const merged = [Object.assign({}, segs[0])];
    for (let i = 1; i < segs.length; i++) {
        const prev = merged[merged.length - 1];
        const cur = segs[i];
        const bGap = cur.bStart - prev.bEnd; // 두 변경 사이 안 바뀐 글자 수 (before 기준)
        const aGap = cur.aStart - prev.aEnd; // (after 기준)
        // 변경 사이에 줄바꿈이 있으면 다른 문장/줄로 보고 합치지 않는다 (빈 줄까지 끌려와 한 코멘트로 뭉치는 것 방지)
        const crossesLine = LINE_BREAK_CHARS.test(before.slice(prev.bEnd, cur.bStart)) ||
            LINE_BREAK_CHARS.test(after.slice(prev.aEnd, cur.aStart));
        if (!crossesLine && Math.min(bGap, aGap) <= gap) {
            // 사이의 공통 글자까지 포함해 하나로 확장
            prev.bEnd = cur.bEnd;
            prev.aEnd = cur.aEnd;
        }
        else {
            merged.push(Object.assign({}, cur));
        }
    }
    return merged;
}
function isSpaceChar(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r'
        || c === '\u00A0' || c === '\u2028' || c === '\u2029';
}
// 변경 구간을 단어 경계까지 넓힌다.
// "방범구역"→"경비구역"이 "방범 → 경비"로 조각나거나, "업그레이드"→"업데이트"가
// "그레이드 → 데이트"로 보이지 않게, 양옆의 안 바뀐 글자를 공백/줄바꿈 전까지 포함해
// 단어 전체를 표시한다. (마침표만 바뀐 "(없음) → ." 표시 문제도 함께 해결)
function expandSegmentToWord(s, before, after) {
    let { bStart, bEnd, aStart, aEnd } = s;
    while (bStart > 0 && aStart > 0 && before[bStart - 1] === after[aStart - 1] && !isSpaceChar(before[bStart - 1])) {
        bStart--;
        aStart--;
    }
    while (bEnd < before.length && aEnd < after.length && before[bEnd] === after[aEnd] && !isSpaceChar(before[bEnd])) {
        bEnd++;
        aEnd++;
    }
    return { bStart, bEnd, aStart, aEnd };
}
// 단어 확장으로 끌려온 "변경과 무관한 꼬리 조사"는 표시에서 떼어낸다.
// 예: "고객인증번호를 → 사용자번호(고객인증번호)를"의 '를' — 양쪽 끝의 공통 글자가
// 조사일 때만 자르므로 실제 변경 내용은 잘리지 않는다. (표시 전용 — 적용 텍스트와 무관)
const TRAILING_PARTICLES = /(에게서|에서|에게|까지|부터|처럼|보다|으로|이나|라도|마저|조차|[을를이가은는과와도만의에로])$/;
function shrinkTrailingParticle(s, before, after) {
    const { bStart, bEnd, aStart, aEnd } = s;
    // 끝에서부터 양쪽이 같은(=확장으로 끌려온) 글자 수
    let common = 0;
    while (common < bEnd - bStart && common < aEnd - aStart &&
        before[bEnd - 1 - common] === after[aEnd - 1 - common])
        common++;
    if (common === 0)
        return s;
    const m = before.slice(bEnd - common, bEnd).match(TRAILING_PARTICLES);
    if (!m)
        return s;
    const cut = m[0].length;
    // 조사를 떼고도 양쪽에 내용이 남을 때만 (세그먼트가 비어버리지 않게)
    if (cut >= bEnd - bStart || cut >= aEnd - aStart)
        return s;
    // 조사를 떼고 남는 차이가 공백뿐이면(따옴표 뒤 띄어쓰기 등) 조사를 남긴다
    // — 안 그러면 '세금계산서” → 세금계산서”'처럼 차이가 안 보이는 표시가 된다
    const stripWs = (str) => str.replace(/[\s\u00A0\u200B]/g, '');
    if (stripWs(before.slice(bStart, bEnd - cut)) === stripWs(after.slice(aStart, aEnd - cut)))
        return s;
    return { bStart, bEnd: bEnd - cut, aStart, aEnd: aEnd - cut };
}
// 단어 경계로 넓힌 뒤 겹치거나 맞닿은 구간을 하나로 합친다.
// 예: "고객인증번호"→"사용자번호(고객인증번호)"는 앞뒤 삽입 2개가 같은 단어로 넓혀져 겹친다.
function mergeOverlappingSegments(segs) {
    if (segs.length <= 1)
        return segs;
    const sorted = segs.slice().sort((a, b) => (a.bStart - b.bStart) || (a.aStart - b.aStart));
    const out = [Object.assign({}, sorted[0])];
    for (let i = 1; i < sorted.length; i++) {
        const prev = out[out.length - 1];
        const cur = sorted[i];
        if (cur.bStart <= prev.bEnd && cur.aStart <= prev.aEnd) {
            prev.bEnd = Math.max(prev.bEnd, cur.bEnd);
            prev.aEnd = Math.max(prev.aEnd, cur.aEnd);
        }
        else {
            out.push(Object.assign({}, cur));
        }
    }
    return out;
}
// 세그먼트 라벨: "원래 → 변경" (줄바꿈은 ↵로 표시해 차이가 눈에 보이게)
function buildSegmentLabel(beforeSeg, afterSeg) {
    const clip = (s) => {
        const t = s.replace(/[\n\r\u2028\u2029]/g, '↵');
        return t.length > 24 ? t.slice(0, 24) + '…' : t;
    };
    const b = beforeSeg ? clip(beforeSeg) : '(없음)';
    const a = afterSeg ? clip(afterSeg) : '(삭제)';
    return b + ' → ' + a;
}
// 이미 로드한 폰트는 다시 await하지 않는다 (로드 자체는 idempotent지만 매번 await하면 누적 비용이 큼)
const loadedFontKeys = new Set();
async function loadFontCached(f) {
    if (!f || !f.family)
        return;
    const k = f.family + ' ' + f.style;
    if (loadedFontKeys.has(k))
        return;
    try {
        await figma.loadFontAsync(f);
        loadedFontKeys.add(k);
    }
    catch (_e) { }
}
// 노드에 사용된 모든 폰트 로드 (setRangeFills 전 필요)
async function loadAllNodeFonts(node) {
    try {
        const len = node.characters ? node.characters.length : 0;
        if (len === 0)
            return;
        const fonts = node.getRangeAllFontNames(0, len);
        for (const f of fonts) {
            await loadFontCached(f);
        }
    }
    catch (_e) { }
}
// 변경 구간의 기준 스타일 추출
function getRangeStyle(node, idx) {
    const MIXED = figma.mixed;
    let font = node.fontName;
    if (font === MIXED) {
        try {
            font = node.getRangeFontName(idx, idx + 1);
        }
        catch (_e) {
            font = null;
        }
        if (!font || font === MIXED) {
            try {
                font = node.getRangeAllFontNames(0, node.characters.length)[0];
            }
            catch (_e) {
                font = null;
            }
        }
    }
    let size = node.fontSize;
    if (size === MIXED) {
        try {
            size = node.getRangeFontSize(idx, idx + 1);
        }
        catch (_e) {
            size = 16;
        }
        if (size === MIXED)
            size = 16;
    }
    let ls = node.letterSpacing;
    if (ls === MIXED) {
        try {
            ls = node.getRangeLetterSpacing(idx, idx + 1);
        }
        catch (_e) {
            ls = null;
        }
        if (ls === MIXED)
            ls = null;
    }
    let lineHeight = node.lineHeight;
    if (lineHeight === MIXED) {
        try {
            lineHeight = node.getRangeLineHeight(idx, idx + 1);
        }
        catch (_e) {
            lineHeight = null;
        }
        if (lineHeight === MIXED)
            lineHeight = null;
    }
    let textCase = node.textCase;
    if (textCase === MIXED) {
        try {
            textCase = node.getRangeTextCase(idx, idx + 1);
        }
        catch (_e) {
            textCase = null;
        }
        if (textCase === MIXED)
            textCase = null;
    }
    return { font, size, ls, lineHeight, textCase };
}
async function measureSegments(node, before, segs, absX, absY, scratch) {
    const out = segs.map(() => null);
    let clone = null;
    // 임시 측정 노드는 호출자가 만들어 재사용한다 (항목마다 createText/remove하면 매우 느림)
    const t = scratch;
    try {
        await loadAllNodeFonts(node);
        const { font, size, ls, lineHeight, textCase } = getRangeStyle(node, 0);
        const align = node.textAlignHorizontal;
        const vAlign = node.textAlignVertical;
        const origW = node.width;
        const nodeH = node.height;
        const len = before.length;
        // 단일 라인 폭/높이 측정 (폰트 메트릭 기반) — 재사용 노드를 이 노드 스타일로 다시 설정
        if (font)
            t.fontName = font;
        t.fontSize = size || 16;
        if (ls) {
            try {
                t.letterSpacing = ls;
            }
            catch (_e) { }
        }
        if (lineHeight) {
            try {
                t.lineHeight = lineHeight;
            }
            catch (_e) { }
        }
        if (textCase) {
            try {
                t.textCase = textCase;
            }
            catch (_e) { }
        }
        t.textAutoResize = 'WIDTH_AND_HEIGHT';
        const ANCHOR = " ";
        t.characters = ANCHOR;
        const anchorW = t.width;
        const lineH = t.height || (size || 16) * 1.3;
        const adv = (s) => {
            if (!s)
                return 0;
            t.characters = s + ANCHOR;
            return t.width - anchorW;
        };
        // 한 줄에 들어가는 텍스트면 클론/줄바꿈 계산을 통째로 건너뛴다 (대부분의 UX 문구가 한 줄 → 큰 속도 이득).
        const fullW = adv(before);
        const singleLine = before.indexOf('\n') === -1 && fullW <= origW + 1;
        let realLineH = lineH;
        let totalLines = 1;
        // 줄바꿈 계산용(멀티라인일 때만 채워짐)
        let linesUpTo = () => 1;
        let firstK = () => 0;
        let lineTopOffset = () => 0;
        if (!singleLine) {
            // 줄바꿈을 원본과 동일하게 재현하기 위한 클론 (너비 고정)
            clone = node.clone();
            figma.currentPage.appendChild(clone);
            try {
                clone.effects = [];
            }
            catch (_e) { }
            try {
                clone.strokes = [];
            }
            catch (_e) { }
            // 잘림/최대 줄 수가 걸려 있으면 자동 높이가 안 먹어 클론 높이가 박스 전체로 측정된다.
            try {
                clone.textTruncation = 'DISABLED';
            }
            catch (_e) { }
            try {
                clone.maxLines = null;
            }
            catch (_e) { }
            try {
                clone.textAutoResize = 'HEIGHT';
            }
            catch (_e) { }
            try {
                clone.resize(origW, clone.height);
            }
            catch (_e) { }
            // 줄 높이: 한 줄인 임시 노드 기준. 클론으로 재보되 비정상(>1.8배)이면 버린다.
            try {
                clone.characters = '가';
                const ch = clone.height;
                if (ch > 0 && ch < lineH * 1.8)
                    realLineH = ch;
            }
            catch (_e) { }
            // clone.characters 대입은 매번 레이아웃을 다시 계산해 비싸다.
            // 같은 인덱스를 이진 탐색이 반복 조회하므로 결과를 메모이즈해 대입 횟수를 줄인다.
            const linesMemo = new Map();
            linesUpTo = (p) => {
                if (p <= 0)
                    return 0;
                const hit = linesMemo.get(p);
                if (hit !== undefined)
                    return hit;
                clone.characters = before.slice(0, p);
                const v = Math.max(1, Math.round(clone.height / realLineH));
                linesMemo.set(p, v);
                return v;
            };
            const firstKMemo = new Map();
            firstK = (L) => {
                const hit = firstKMemo.get(L);
                if (hit !== undefined)
                    return hit;
                let lo = 0, hi = len;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (linesUpTo(mid) >= L)
                        hi = mid;
                    else
                        lo = mid + 1;
                }
                firstKMemo.set(L, lo);
                return lo;
            };
            // 줄 L의 상단 y 오프셋 = 그 앞의 (L-1)개 줄 높이.
            // firstK(L)은 'L번째 줄의 첫 글자' 인덱스라, 그 글자를 빼야(=firstK(L)-1) (L-1)줄 높이가 된다.
            const offsetMemo = new Map();
            lineTopOffset = (L) => {
                if (L <= 1)
                    return 0;
                const hit = offsetMemo.get(L);
                if (hit !== undefined)
                    return hit;
                const k = Math.max(0, firstK(L) - 1);
                let v = 0;
                if (k > 0) {
                    clone.characters = before.slice(0, k);
                    v = clone.height;
                }
                offsetMemo.set(L, v);
                return v;
            };
            totalLines = Math.max(1, linesUpTo(len));
        }
        // 세로 기준점(텍스트 맨 위). 원본 노드는 이미 렌더돼 있어 absoluteRenderBounds를 쓸 수 있다.
        // null이면 박스 높이 + 세로정렬로 폴백.
        let textTop = absY;
        {
            let extraTop = 0;
            const textH = totalLines * realLineH;
            const extra = Math.max(0, nodeH - textH);
            if (vAlign === 'CENTER')
                extraTop = extra / 2;
            else if (vAlign === 'BOTTOM')
                extraTop = extra;
            textTop = absY + extraTop;
            let rb = null;
            try {
                rb = node.absoluteRenderBounds;
            }
            catch (_e) { }
            if (rb && typeof rb.y === 'number' && typeof rb.height === 'number') {
                const inkPerLine = rb.height / Math.max(1, totalLines);
                const topGap = Math.max(0, (realLineH - inkPerLine) / 2);
                textTop = rb.y - topGap;
            }
        }
        // 한 줄 [a,e) 안에서 [segStart, segEnd] 구간이 차지하는 박스 (y는 호출자가 전달)
        const makeBox = (a, e, segStart, segEnd, yTop) => {
            if (before[a] === '\n')
                a += 1; // 줄 경계의 \n은 다음 줄 시작 문자이므로 건너뜀
            const cs = Math.min(Math.max(segStart, a), e);
            const ce = Math.min(Math.max(segEnd, a), e);
            const xStartInLine = adv(before.slice(a, cs));
            const xEndInLine = adv(before.slice(a, ce));
            const lineW = (a === 0 && e === len) ? fullW : adv(before.slice(a, e));
            let leftEdge = 0;
            if (align === 'CENTER')
                leftEdge = (origW - lineW) / 2;
            else if (align === 'RIGHT')
                leftEdge = origW - lineW;
            return { x: absX + leftEdge + xStartInLine, y: yTop, w: Math.max(1, xEndInLine - xStartInLine), h: realLineH };
        };
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            const startPos = s.bStart;
            const endPos = Math.max(s.bEnd, s.bStart);
            const rects = [];
            if (singleLine) {
                // 클론 없이 한 박스로
                rects.push(makeBox(0, len, startPos, endPos, textTop));
            }
            else {
                const Lstart = startPos < len ? Math.max(1, linesUpTo(startPos + 1)) : totalLines;
                const Lend = endPos > startPos ? Math.max(1, linesUpTo(endPos)) : Lstart;
                // 구간이 걸친 각 줄마다 박스를 따로 (멀티라인일 때 프레임 전체를 덮지 않도록)
                for (let L = Lstart; L <= Lend; L++) {
                    const a = Math.max(0, firstK(L) - 1);
                    const e = L < totalLines ? Math.max(0, firstK(L + 1) - 1) : len;
                    rects.push(makeBox(a, e, startPos, endPos, textTop + lineTopOffset(L)));
                }
            }
            out[i] = { anchor: rects[0], rects };
        }
    }
    catch (e) {
        console.log('[UX-HL] measureSegments error', e);
    }
    finally {
        if (clone) {
            try {
                clone.remove();
            }
            catch (_e) { }
        }
        // 재사용 노드(t)는 여기서 지우지 않는다 — 호출자가 마지막에 한 번만 제거
    }
    return out;
}
// 형광펜 박스 생성 (key = HL_INFIX + nodeId + SEG_SEP + segIdx)
// geom은 해당 줄의 영역(높이=lineH). 줄 높이를 넘지 않게 살짝만 여백.
function createHighlightRect(key, geom, absX, absY) {
    try {
        const padX = 1;
        const boxX = geom.x - padX;
        const boxY = geom.y;
        const boxW = Math.max(1, geom.w + padX * 2);
        const boxH = Math.max(1, geom.h);
        const hl = figma.createRectangle();
        hl.name = HL_DISPLAY_NAME;
        tagAnnotation(hl, key);
        hl.fills = [{ type: 'SOLID', color: HIGHLIGHT_COLOR }];
        hl.blendMode = 'MULTIPLY';
        hl.cornerRadius = 2;
        figma.currentPage.appendChild(hl);
        hl.resize(boxW, boxH);
        hl.x = boxX;
        hl.y = boxY;
        hl.locked = true;
        annotationOffset.set(key, { dx: boxX - absX, dy: boxY - absY });
        registerAnnotation(hl);
    }
    catch (_e) { }
}
// 코멘트 말풍선 생성 (해당 세그먼트 바로 위에 배치)
// 배경 사각형 + 텍스트를 "그룹"으로 묶는다. 그룹은 프레임과 달리 캔버스에 상시 이름표가 안 뜨고
// (선택/호버 시에만 잠깐 보임), 클릭 한 번에 통째로 선택돼 앞으로 가져오기 좋다.
function createCommentFrame(key, label, fontName, anchorX, anchorY, absX, absY) {
    try {
        const padX = 10;
        const padY = 6;
        // 텍스트 (먼저 만들어 크기를 잰다)
        const text = figma.createText();
        text.name = COMMENT_DISPLAY_NAME;
        text.fontName = fontName;
        text.characters = label;
        text.fontSize = 12;
        text.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        text.textAutoResize = 'WIDTH_AND_HEIGHT';
        const tw = text.width;
        const th = text.height;
        // 배경 사각형 (둥근 모서리 + 1px 검정 테두리)
        const bg = figma.createRectangle();
        bg.name = COMMENT_DISPLAY_NAME;
        bg.resize(tw + padX * 2, th + padY * 2);
        bg.cornerRadius = 8;
        bg.fills = [{ type: 'SOLID', color: { r: 0.2, g: 0.78, b: 0.35 } }];
        bg.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
        bg.strokeWeight = 1;
        // 배경 → 텍스트 순서로 추가해야 텍스트가 위에 그려진다
        figma.currentPage.appendChild(bg);
        figma.currentPage.appendChild(text);
        const bx = anchorX;
        const by = anchorY - (th + padY * 2) - 6;
        bg.x = bx;
        bg.y = by;
        text.x = bx + padX;
        text.y = by + padY;
        // 배경+텍스트를 하나의 그룹으로 묶기 (클릭 시 통째로 선택)
        const group = figma.group([bg, text], figma.currentPage);
        group.name = COMMENT_DISPLAY_NAME;
        // 잠그지 않는다: 클릭으로 선택돼야 "그 코멘트만 선명" 동작이 작동한다.
        // 클릭 직후 selectionchange 핸들러가 선택을 즉시 비워 크기 배지는 뜨지 않는다.
        group.locked = false;
        // 그룹 하나만 추적 (배경/텍스트는 그룹 안에 있어 함께 이동·제거됨)
        tagAnnotation(group, key);
        annotationOffset.set(key, { dx: group.x - absX, dy: group.y - absY });
        registerAnnotation(group);
    }
    catch (_e) { }
}
async function measureAnnotation(item, scratch) {
    // 기존 어노테이션(코멘트 + 형광펜, 모든 세그먼트) 제거
    removeAnnotationByNodeId(item.nodeId);
    let node = null;
    try {
        node = await figma.getNodeByIdAsync(item.nodeId);
    }
    catch (_e) { }
    if (!node)
        return null;
    annotationNodeCache.set(item.nodeId, node);
    const ancestors = new Set();
    let cur = node;
    while (cur && cur.type !== 'PAGE') {
        if (cur.id)
            ancestors.add(cur.id);
        cur = cur.parent;
    }
    annotationAncestorIds.set(item.nodeId, ancestors);
    // 역방향 인덱스 갱신 (documentchange에서 "움직인 프레임 → 영향받는 텍스트" 조회용)
    for (const aid of ancestors) {
        let set = ancestorToTracked.get(aid);
        if (!set) {
            set = new Set();
            ancestorToTracked.set(aid, set);
        }
        set.add(item.nodeId);
    }
    const absX = item.x;
    const absY = item.y;
    const segs = mergeOverlappingSegments(mergeCloseSegments(diffSegments(item.before, item.after), SEGMENT_MERGE_GAP, item.before, item.after)
        .map((s) => expandSegmentToWord(s, item.before, item.after))).map((s) => shrinkTrailingParticle(s, item.before, item.after));
    if (segs.length === 0)
        return null;
    const geoms = await measureSegments(node, item.before, segs, absX, absY, scratch);
    const job = { nodeId: item.nodeId, absX, absY, highlights: [], comments: [] };
    let idx = 0;
    for (const s of segs) {
        const bSeg = item.before.slice(s.bStart, s.bEnd);
        const aSeg = item.after.slice(s.aStart, s.aEnd);
        const label = buildSegmentLabel(bSeg, aSeg);
        const segKey = item.nodeId + SEG_SEP + idx;
        const measured = geoms[idx];
        const fallback = { x: absX, y: absY, w: 1, h: 16 };
        const rects = measured ? measured.rects : [fallback];
        const anchor = measured ? measured.anchor : fallback;
        // 변경된 기존 글자가 있을 때만 형광펜 박스 (걸친 줄마다 따로)
        if (s.bEnd > s.bStart) {
            rects.forEach((r, li) => {
                job.highlights.push({ key: HL_INFIX + segKey + LINE_SEP + li, geom: r });
            });
        }
        // 코멘트는 해당 세그먼트(첫 줄) 바로 위에
        job.comments.push({ key: segKey, label, anchorX: anchor.x, anchorY: anchor.y });
        idx++;
    }
    return job;
}
async function createAnnotations(previewData, onProgress) {
    const fontName = await ensureAnnotationFont();
    if (!fontName)
        return;
    // 1) 측정 단계 (비동기): 위치만 계산하고 화면엔 아무것도 안 그린다
    // 임시 측정 노드를 하나만 만들어 모든 항목이 재사용 (항목마다 createText/remove 하던 비용 제거)
    const jobs = [];
    const total = previewData.length;
    const scratch = figma.createText();
    try {
        for (let i = 0; i < total; i++) {
            const job = await measureAnnotation(previewData[i], scratch);
            if (job)
                jobs.push(job);
            if (onProgress && (i + 1 === total || (i + 1) % 5 === 0))
                onProgress(i + 1, total);
        }
    }
    finally {
        try {
            scratch.remove();
        }
        catch (_e) { }
    }
    // 2) 생성 단계 (동기): 한 번에 전부 그린다 → 하나씩 뿅뿅이 아니라 한 프레임에 다같이 나타남
    for (const job of jobs) {
        for (const h of job.highlights) {
            createHighlightRect(h.key, h.geom, job.absX, job.absY);
        }
        // 코멘트는 캔버스 말풍선(씬 노드)으로 그린다. 네이티브 어노테이션(node.annotations)은
        // Dev Mode 전용이라 일반 디자인 모드에서 안 보여서, 세그먼트별 초록 말풍선으로 표시한다.
        // (클릭 시 Figma 크기 배지가 함께 뜨는 건 알려진 트레이드오프)
        for (const c of job.comments) {
            createCommentFrame(c.key, c.label, fontName, c.anchorX, c.anchorY, job.absX, job.absY);
        }
    }
    // 위치 추적은 documentchange 이벤트가 담당 (별도 폴링 없음)
}
function removeAnnotations() {
    cancelPendingReposition();
    annotationFontName = null;
    annotationNodeCache.clear();
    annotationAncestorIds.clear();
    ancestorToTracked.clear();
    annIdToTracked.clear();
    annotationOffset.clear();
    annotationsByNode.clear();
    for (const ann of getAllAnnotations()) {
        ann.remove();
    }
}
// APPLY 중인 노드 ID 추적 (documentchange에서 오탐 방지)
const applyingNodeIds = new Set();
// 어노테이션 위치 추적 — 폴링이 아니라 documentchange 이벤트 기반.
// (예전 250ms 폴링은 어노테이션이 수천 개면 캔버스가 가만히 있어도 매 틱마다
//  좌표 읽기/비교 브리지 호출을 쏟아내 100개 화면 검토 시 캔버스 렉의 원인이 됐다.
//  이제 실제로 노드가 움직였을 때, 영향받는 텍스트의 어노테이션만 갱신한다.)
let repositionPending = null;
let repositionFlushTimer = null;
// 지정한 대상 노드들의 어노테이션만 위치 갱신
function repositionAnnotationsFor(nodeIds) {
    for (const nodeId of nodeIds) {
        const arr = annotationsByNode.get(nodeId);
        if (!arr)
            continue;
        const node = annotationNodeCache.get(nodeId);
        let pos = null;
        if (node) {
            try {
                if (node.removed) {
                    annotationNodeCache.delete(nodeId);
                }
                else {
                    const at = node.absoluteTransform;
                    pos = at ? { x: at[0][2], y: at[1][2] } : { x: node.x || 0, y: node.y || 0 };
                }
            }
            catch (_e) {
                annotationNodeCache.delete(nodeId);
            }
        }
        // 살아있는 어노테이션만 남기며(제거된 건 정리) 위치 갱신
        let alive = 0;
        for (let i = 0; i < arr.length; i++) {
            const entry = arr[i];
            if (!entry.ann || entry.ann.removed)
                continue;
            arr[alive++] = entry;
            if (!pos)
                continue;
            const off = annotationOffset.get(entry.key);
            if (!off)
                continue;
            const newX = pos.x + off.dx;
            const newY = pos.y + off.dy;
            try {
                // 달라졌을 때만 쓴다 — 우리가 쓴 좌표가 다시 documentchange를 일으켜도
                // 다음 갱신에서 값이 같아 멈춘다 (이벤트 루프 방지)
                if (Math.abs(entry.ann.x - newX) > 0.5 || Math.abs(entry.ann.y - newY) > 0.5) {
                    entry.ann.x = newX;
                    entry.ann.y = newY;
                }
            }
            catch (_e) { }
        }
        arr.length = alive;
        if (alive === 0)
            annotationsByNode.delete(nodeId);
    }
}
// 움직인 노드들을 모아 100ms에 한 번만 갱신 (드래그 중 이벤트 폭주 대비)
function scheduleReposition(nodeIds) {
    if (!repositionPending)
        repositionPending = new Set();
    for (const id of nodeIds)
        repositionPending.add(id);
    if (repositionFlushTimer)
        return;
    repositionFlushTimer = setTimeout(() => {
        repositionFlushTimer = null;
        const ids = repositionPending;
        repositionPending = null;
        if (ids && ids.size > 0)
            repositionAnnotationsFor(Array.from(ids));
    }, 100);
}
function cancelPendingReposition() {
    if (repositionFlushTimer !== null) {
        clearTimeout(repositionFlushTimer);
        repositionFlushTimer = null;
    }
    repositionPending = null;
}
// 노드 변경 감지:
// ① 텍스트 외부 변경(Ctrl+Z 등) → 해당 어노테이션 제거
// ② 프레임/노드 이동·리사이즈 → 영향받는 어노테이션 위치 갱신 (폴링 대체)
// 주의: documentAccess가 dynamic-page일 때 figma.on('documentchange')는
//       loadAllPagesAsync() 없이는 등록이 실패한다 (이전 코드에선 try/catch에 조용히
//       먹혀 한 번도 동작하지 않았음). 페이지 단위 'nodechange' 이벤트를 써야 한다.
const GEOMETRY_PROPS = new Set(['x', 'y', 'width', 'height', 'parent', 'rotation']);
function handleNodeChanges(changes) {
    var _a;
    const moved = new Set();
    for (const change of changes) {
        if (!change || change.type !== 'PROPERTY_CHANGE')
            continue;
        const props = Array.isArray(change.properties) ? change.properties : [];
        // ② 기하 변경 → 이 노드를 조상으로 둔 추적 텍스트들만 골라 위치 갱신 예약
        if (ancestorToTracked.size > 0 && props.some((p) => GEOMETRY_PROPS.has(p))) {
            const tracked = ancestorToTracked.get(change.id);
            if (tracked) {
                for (const t of tracked)
                    moved.add(t);
            }
            // 코멘트/형광펜 자체를 끌었으면 제자리로 되돌리기 위해 갱신 예약
            const byAnn = annIdToTracked.get(change.id);
            if (byAnn)
                moved.add(byAnn);
        }
        // ① 텍스트 내용 변경 → 어노테이션 제거
        if (((_a = change.node) === null || _a === void 0 ? void 0 : _a.type) === 'TEXT' &&
            props.includes('characters')) {
            const nodeId = change.node.id;
            if (applyingNodeIds.has(nodeId))
                continue;
            if (findAnnotation(nodeId)) {
                removeAnnotationByNodeId(nodeId);
                figma.ui.postMessage({ type: 'remove-changed-items', changedNodeIds: [nodeId] });
            }
        }
    }
    if (moved.size > 0)
        scheduleReposition(moved);
}
// 페이지별 nodechange 구독 (중복 구독 방지). 페이지를 옮기면 새 페이지도 구독한다.
const nodeChangeSubscribedPages = new Set();
function subscribeNodeChange(page) {
    if (!page || !page.id || nodeChangeSubscribedPages.has(page.id))
        return;
    try {
        page.on('nodechange', (event) => {
            if (event && event.nodeChanges)
                handleNodeChanges(event.nodeChanges);
        });
        nodeChangeSubscribedPages.add(page.id);
    }
    catch (e) {
        console.log('[UX-ANN] nodechange 구독 실패', e);
    }
}
subscribeNodeChange(figma.currentPage);
try {
    figma.on('currentpagechange', () => subscribeNodeChange(figma.currentPage));
}
catch (_e) { }
// 플러그인 닫힐 때 어노테이션 자동 제거
figma.on('close', () => {
    removeAnnotations();
});
// PREVIEW에서 찾은 노드들을 캐시 (FOCUS_NODE에서 사용)
const previewNodeCache = new Map();
// 메시지 수신: UI 버튼 클릭 → 실행
figma.ui.onmessage = async (msg) => {
    var _a;
    // 미리보기 모드
    if (msg.type === "PREVIEW") {
        // 로딩 표시
        figma.ui.postMessage({
            type: 'show-loading'
        });
        const selection = figma.currentPage.selection;
        if (!selection || selection.length === 0) {
            // 로딩 숨기기
            figma.ui.postMessage({
                type: 'hide-loading'
            });
            return;
        }
        // 진행률 업데이트 (노드 찾기 시작)
        figma.ui.postMessage({
            type: 'update-progress',
            progress: 5,
            status: '텍스트 노드 찾는 중...'
        });
        // 선택된 노드 내부의 모든 텍스트 노드 찾기 (비동기로 처리하여 UI 블로킹 방지)
        const textNodes = [];
        const totalSelectionNodes = selection.length;
        // 각 선택된 노드에 대해 진행률 업데이트하면서 찾기
        for (let i = 0; i < selection.length; i++) {
            const node = selection[i];
            const nodeIndex = i; // 클로저 문제 방지
            // 진행률 업데이트 콜백 함수
            const progressCallback = (nodeProgress) => {
                // 전체 진행률 계산: 5% ~ 25% 범위
                const baseProgress = 5 + (nodeIndex / totalSelectionNodes) * 20;
                const nodeProgressRatio = nodeProgress / 100;
                const currentProgress = baseProgress + (nodeProgressRatio * (20 / totalSelectionNodes));
                figma.ui.postMessage({
                    type: 'update-progress',
                    progress: Math.min(currentProgress, 25),
                    status: `텍스트 노드 찾는 중... (${nodeIndex + 1}/${totalSelectionNodes})`
                });
            };
            // 노드 찾기 시작 시 진행률 업데이트
            const startProgress = 5 + (nodeIndex / totalSelectionNodes) * 20;
            figma.ui.postMessage({
                type: 'update-progress',
                progress: Math.min(startProgress, 25),
                status: `텍스트 노드 찾는 중... (${nodeIndex + 1}/${totalSelectionNodes})`
            });
            const foundNodes = await findAllTextNodes(node, 10000, progressCallback);
            textNodes.push(...foundNodes);
            // 진행률 업데이트 (5% ~ 25%)
            const progress = 5 + ((i + 1) / totalSelectionNodes) * 20;
            figma.ui.postMessage({
                type: 'update-progress',
                progress: Math.min(progress, 25),
                status: `텍스트 노드 찾는 중... (${i + 1}/${totalSelectionNodes})`
            });
        }
        // 진행률 업데이트 (노드 찾기 완료)
        figma.ui.postMessage({
            type: 'update-progress',
            progress: 30,
            status: '텍스트 변환 중...'
        });
        if (textNodes.length === 0) {
            // 로딩 숨기기
            figma.ui.postMessage({
                type: 'hide-loading'
            });
            // 변경점이 없음을 UI에 알림
            figma.ui.postMessage({
                type: 'preview-result',
                data: []
            });
            // 토스트 알림 표시
            figma.ui.postMessage({
                type: 'show-toast',
                message: '수정이 필요한 항목이 없어요.'
            });
            return;
        }
        // 캐시 초기화
        previewNodeCache.clear();
        const previewData = [];
        const nodesToSelect = [];
        const CHUNK_SIZE = 50; // 50개씩 처리 후 yield
        let lastProgressUpdateTime = Date.now();
        const PROGRESS_UPDATE_TIME_INTERVAL = 100; // 100ms마다 시간 기반 업데이트
        const totalTextNodes = textNodes.length;
        // 0) 네이버 맞춤법 검사 — 캐시 + 배치(여러 문구를 요청 1개로) 처리. (실패 시 원문 유지 → 로컬 규칙만)
        naverOkCount = 0;
        naverDiag = '';
        figma.ui.postMessage({ type: 'update-progress', progress: 30, status: '맞춤법 검사 중...' });
        // 같은 문구는 한 번만 검사 (반복되는 버튼·라벨이 많아 중복 제거 효과가 큼)
        const uniqueTexts = Array.from(new Set(textNodes.map((n) => n.characters)));
        const totalUnique = uniqueTexts.length;
        const spellByText = await naverSpellCheckAll(uniqueTexts, (done) => {
            const p = 30 + (totalUnique > 0 ? (done / totalUnique) * 30 : 0); // 30~60%
            figma.ui.postMessage({
                type: 'update-progress',
                progress: Math.min(p, 60),
                status: `맞춤법 검사 중... (${done}/${totalUnique})`
            });
        });
        const spellCorrections = textNodes.map((n) => spellByText.get(n.characters) || { text: n.characters, reasons: [], checked: false });
        // 검사 대상이 있었는데 한 건도 성공 못 했으면 원인과 함께 안내 — 로컬 규칙으로는 계속 진행.
        // (캐시 히트도 성공으로 친다 — 재검토 때 네트워크 0건이어도 오탐하지 않도록)
        const spellEligible = uniqueTexts.some((t) => t && t.trim() && t.length <= 500 && /[가-힣]/.test(t));
        const spellAnyOk = uniqueTexts.some((t) => { const r = spellByText.get(t); return !!(r && r.checked); });
        if (spellEligible && !spellAnyOk) {
            figma.ui.postMessage({
                type: 'show-toast',
                message: '맞춤법 검사기가 작동하지 않아요. 관리자에게 문의해 주세요.'
            });
        }
        // 텍스트 변환 처리 (청크 단위로 나누어 처리하여 UI 블로킹 방지)
        for (let i = 0; i < textNodes.length; i++) {
            const node = textNodes[i];
            const before = node.characters;
            // 맞춤법 교정본 위에 오타/조사/톤/표현 규칙 적용 (suggestFriendlyKorean 안에서 조사 교정도 수행)
            // 네이버 검사를 통과한 텍스트는 띄어쓰기를 네이버 결과에 맡긴다 (부사 폴백 규칙 미적용)
            const spell = spellCorrections[i] || { text: before, reasons: [], checked: false };
            const suggestions = suggestFriendlyKorean(spell.text, spell.checked);
            const preferredSuggestion = (_a = suggestions.find((s) => s.tags.includes("button"))) !== null && _a !== void 0 ? _a : suggestions[0];
            const after = preferredSuggestion ? preferredSuggestion.after : spell.text;
            // 사유: 맞춤법(네이버) + 톤/규칙 사유 합치기 (UI는 ' - '로 분리 표시)
            const reasonParts = spell.reasons.slice();
            if (preferredSuggestion && preferredSuggestion.reason)
                reasonParts.push(preferredSuggestion.reason);
            const reason = reasonParts.join(' - ');
            if (before !== after) {
                // 노드를 캐시에 저장 (FOCUS_NODE에서 사용)
                previewNodeCache.set(node.id, node);
                // 노드의 위치 정보 저장 (y 좌표 우선, 그 다음 x 좌표)
                // absoluteTransform이 있으면 사용, 없으면 node.x/y 사용
                let x = 0;
                let y = 0;
                try {
                    const absoluteTransform = node.absoluteTransform;
                    if (absoluteTransform) {
                        x = absoluteTransform[0][2];
                        y = absoluteTransform[1][2];
                    }
                    else {
                        x = node.x || 0;
                        y = node.y || 0;
                    }
                }
                catch (e) {
                    // 위치 정보 가져오기 실패 시 기본값 사용
                    x = 0;
                    y = 0;
                }
                // 최상위 프레임(페이지 직속 부모) 정보 — 목록을 화면 단위로 묶어 보여주기 위함
                let frameId = node.id;
                let frameName = node.name;
                let frameX = x;
                let frameY = y;
                try {
                    let cur = node;
                    while (cur.parent && cur.parent.type !== 'PAGE')
                        cur = cur.parent;
                    if (cur && cur.id) {
                        frameId = cur.id;
                        frameName = cur.name || '';
                        // 페이지 직속 노드라 x/y가 곧 캔버스 좌표
                        if (typeof cur.x === 'number')
                            frameX = cur.x;
                        if (typeof cur.y === 'number')
                            frameY = cur.y;
                    }
                }
                catch (_e) { }
                previewData.push({
                    nodeId: node.id,
                    nodeName: node.name,
                    before: before,
                    after: after,
                    reason: reason,
                    y: y,
                    x: x,
                    frameId: frameId,
                    frameName: frameName,
                    frameX: frameX,
                    frameY: frameY
                });
                nodesToSelect.push(node);
            }
            // 진행률 업데이트 (60% ~ 90%) - 처리량 기반 (맞춤법 검사가 30~60% 사용)
            const now = Date.now();
            const progress = 60 + (i + 1) / totalTextNodes * 30;
            const shouldUpdateProgress = (i + 1) % 10 === 0 ||
                i === textNodes.length - 1 ||
                (now - lastProgressUpdateTime) >= PROGRESS_UPDATE_TIME_INTERVAL;
            if (shouldUpdateProgress) {
                figma.ui.postMessage({
                    type: 'update-progress',
                    progress: Math.min(progress, 90),
                    status: `텍스트 변환 중... (${i + 1}/${totalTextNodes})`
                });
                lastProgressUpdateTime = now;
            }
            // 일정 개수 처리 후 yield하여 UI 블로킹 방지
            if ((i + 1) % CHUNK_SIZE === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        // 진행률 업데이트 (정렬 및 완료)
        figma.ui.postMessage({
            type: 'update-progress',
            progress: 95,
            status: '정렬 중...'
        });
        // 위치 기준으로 정렬: 프레임(화면) 단위 먼저 (위→아래, 왼쪽→오른쪽), 같은 프레임 안에서는 텍스트 위치순
        previewData.sort((a, b) => {
            if (a.frameId !== b.frameId) {
                if (Math.abs(a.frameY - b.frameY) > 1)
                    return a.frameY - b.frameY;
                if (Math.abs(a.frameX - b.frameX) > 1)
                    return a.frameX - b.frameX;
            }
            if (Math.abs(a.y - b.y) > 1)
                return a.y - b.y;
            return a.x - b.x;
        });
        // 변경점이 있는 텍스트 노드들을 자동으로 선택
        if (nodesToSelect.length > 0) {
            figma.currentPage.selection = nodesToSelect;
            figma.viewport.scrollAndZoomIntoView(nodesToSelect);
        }
        // 새 결과를 먼저 누적 방식으로 UI에 전송 (어노테이션 생성 실패와 무관하게 검토 결과 표시)
        figma.ui.postMessage({
            type: 'preview-add',
            data: previewData
        });
        // 캔버스에 어노테이션 생성 (누적) — 이 작업도 로딩에 포함시킨다 (끝나기 전엔 로딩 유지)
        figma.ui.postMessage({
            type: 'update-progress',
            progress: 96,
            status: '표시 생성 중...'
        });
        try {
            await createAnnotations(previewData, (done, total) => {
                // 96% → 99% 사이를 생성 진행도로 채움
                const p = total > 0 ? 96 + Math.floor((done / total) * 3) : 99;
                figma.ui.postMessage({
                    type: 'update-progress',
                    progress: p,
                    status: `표시 생성 중... (${done}/${total})`
                });
            });
        }
        catch (annErr) {
            console.error('어노테이션 생성 실패:', annErr);
        }
        // 모든 생성까지 끝난 뒤에야 완료 + 로딩 숨김
        figma.ui.postMessage({
            type: 'update-progress',
            progress: 100,
            status: '완료!'
        });
        figma.ui.postMessage({
            type: 'hide-loading'
        });
        // 새로 검토한 영역에서 수정 항목이 없으면 토스트
        if (previewData.length === 0) {
            figma.ui.postMessage({
                type: 'show-toast',
                message: '선택한 영역에 수정이 필요한 항목이 없어요.'
            });
        }
        return;
    }
    // 실제 변경 적용 모드
    if (msg.type === "APPLY") {
        try {
            const previewData = msg.data;
            if (!previewData || previewData.length === 0) {
                // 로딩 숨기기
                figma.ui.postMessage({
                    type: 'hide-loading'
                });
                return;
            }
            // 전송된 previewData에 있는 노드 ID만 처리 (선택된 항목만)
            const targetNodeIds = new Set();
            for (const item of previewData) {
                targetNodeIds.add(item.nodeId);
            }
            // 미리보기 데이터를 맵으로 변환 (nodeId를 키로)
            const previewMap = new Map();
            for (const item of previewData) {
                previewMap.set(item.nodeId, { before: item.before, after: item.after });
            }
            const changedNodeIds = new Set();
            // 진행률 업데이트 (노드 찾기 시작)
            figma.ui.postMessage({
                type: 'update-progress',
                progress: 10,
                status: '변경할 노드 찾는 중...'
            });
            // 변경할 노드들 수집 (dynamic-page에서는 동기 getNodeById가 동작 안 함 → async 사용)
            // getNodeByIdAsync는 선택 상태와 무관하게 id로 찾으므로, 못 찾으면 노드가 삭제된 것 → 건너뛰고 나중에 알림
            const nodesToChange = [];
            const totalTargetNodes = targetNodeIds.size;
            let processedCount = 0;
            for (const nodeId of targetNodeIds) {
                try {
                    const nodeById = await figma.getNodeByIdAsync(nodeId);
                    if (nodeById && nodeById.type === "TEXT") {
                        nodesToChange.push(nodeById);
                    }
                }
                catch (e) {
                    // 노드 조회 실패 → 적용 불가 항목으로 집계됨
                }
                processedCount++;
                // 진행률 업데이트 (10% ~ 30%)
                if (processedCount % 10 === 0 || processedCount === totalTargetNodes) {
                    const progress = 10 + (processedCount / totalTargetNodes) * 20;
                    figma.ui.postMessage({
                        type: 'update-progress',
                        progress: Math.min(progress, 30),
                        status: `변경할 노드 찾는 중... (${processedCount}/${totalTargetNodes})`
                    });
                }
            }
            // 모든 노드의 폰트를 먼저 수집하여 병렬로 로드
            const fontsToLoad = new Map();
            for (const node of nodesToChange) {
                if (node.fontName !== figma.mixed) {
                    const font = node.fontName;
                    const key = font.family + "::" + font.style;
                    fontsToLoad.set(key, font);
                }
                else {
                    // mixed 폰트: 글자 단위로 모든 폰트 수집
                    try {
                        const len = node.characters.length;
                        for (let i = 0; i < len; i++) {
                            const fn = node.getRangeFontName(i, i + 1);
                            if (fn !== figma.mixed) {
                                const font = fn;
                                const key = font.family + "::" + font.style;
                                fontsToLoad.set(key, font);
                            }
                        }
                    }
                    catch (_e) {
                        // 폰트 정보 가져오기 실패 시 무시하고 계속 진행
                    }
                }
            }
            // 진행률 업데이트 (폰트 로딩 시작)
            figma.ui.postMessage({
                type: 'update-progress',
                progress: 40,
                status: `폰트 로딩 중... (${fontsToLoad.size}개)`
            });
            // 모든 폰트를 병렬로 로드
            if (fontsToLoad.size > 0) {
                await Promise.all(Array.from(fontsToLoad.values()).map(f => figma.loadFontAsync(f)));
            }
            // 진행률 업데이트 (폰트 로딩 완료)
            figma.ui.postMessage({
                type: 'update-progress',
                progress: 60,
                status: '텍스트 변경 적용 중...'
            });
            // 각 노드에 변경 적용 (폰트는 이미 로드됨)
            const totalNodesToChange = nodesToChange.length;
            let lastProgressUpdateTime = Date.now();
            const PROGRESS_UPDATE_TIME_INTERVAL = 100; // 100ms마다 시간 기반 업데이트
            for (let i = 0; i < nodesToChange.length; i++) {
                const node = nodesToChange[i];
                applyingNodeIds.add(node.id);
                try {
                    applyChangeToNode(node, previewMap, changedNodeIds, []);
                }
                catch (_e) {
                    // 개별 노드 변경 실패 시 계속 진행
                }
                finally {
                    applyingNodeIds.delete(node.id);
                }
                // 진행률 업데이트 (60% ~ 95%) - 처리량 기반 또는 시간 기반
                const now = Date.now();
                const progress = 60 + ((i + 1) / totalNodesToChange) * 35;
                const shouldUpdateProgress = (i + 1) % 5 === 0 ||
                    i === nodesToChange.length - 1 ||
                    (now - lastProgressUpdateTime) >= PROGRESS_UPDATE_TIME_INTERVAL;
                if (shouldUpdateProgress) {
                    figma.ui.postMessage({
                        type: 'update-progress',
                        progress: Math.min(progress, 95),
                        status: `텍스트 변경 적용 중... (${i + 1}/${totalNodesToChange})`
                    });
                    lastProgressUpdateTime = now;
                }
            }
            // 진행률 업데이트 (완료)
            figma.ui.postMessage({
                type: 'update-progress',
                progress: 100,
                status: '완료!'
            });
            // 로딩 숨기기
            figma.ui.postMessage({
                type: 'hide-loading'
            });
            // 변경 완료된 노드의 어노테이션(코멘트 + 형광펜) 제거
            for (const nodeId of changedNodeIds) {
                removeAnnotationByNodeId(nodeId);
            }
            // 적용 결과 알림 — 건너뛴 항목(검토 후 텍스트 변경/노드 삭제)도 숨기지 않고 알려준다
            const skippedCount = targetNodeIds.size - changedNodeIds.size;
            let message;
            if (changedNodeIds.size > 0 && skippedCount === 0) {
                message = changedNodeIds.size === 1
                    ? '변경됐어요.'
                    : `${changedNodeIds.size}건이 변경됐어요.`;
            }
            else if (changedNodeIds.size > 0) {
                message = `${changedNodeIds.size}건이 변경됐어요. ${skippedCount}건은 검토 후 텍스트가 바뀌었거나 삭제되어 적용하지 못했어요.`;
            }
            else {
                message = '적용하지 못했어요. 검토 후 텍스트가 바뀌었거나 삭제된 항목이에요. 다시 검토해 주세요.';
            }
            figma.ui.postMessage({
                type: 'show-toast',
                message: message
            });
            // 변경된 항목 ID를 UI에 전송하여 UI에서 필터링하도록 함 (건너뛴 항목은 목록에 남는다)
            if (changedNodeIds.size > 0) {
                figma.ui.postMessage({
                    type: 'remove-changed-items',
                    changedNodeIds: Array.from(changedNodeIds)
                });
            }
        }
        catch (e) {
            // 에러 발생 시에도 로딩 숨기기 + 알림
            figma.ui.postMessage({
                type: 'hide-loading'
            });
            figma.ui.postMessage({
                type: 'show-toast',
                message: '적용 중 오류가 발생했어요. 다시 시도해 주세요.'
            });
        }
        return;
    }
    // 플러그인 창 크기 조절
    if (msg.type === "RESIZE_UI") {
        const w = Math.max(300, Math.min(800, msg.width || 360));
        const h = Math.max(400, Math.min(1200, msg.height || 780));
        // 왼쪽/위쪽으로 늘릴 때는 반대쪽 가장자리를 고정하기 위해 창을 그만큼 이동.
        // reposition/getPosition은 '캔버스 좌표'를 쓰므로, 창 픽셀 변화량을 zoom으로 나눠 캔버스 단위로 변환한다.
        if (msg.anchorRight || msg.anchorBottom) {
            let pos = null;
            try {
                pos = figma.ui.getPosition().canvasSpace;
            }
            catch (_e) {
                pos = null;
            }
            figma.ui.resize(w, h);
            if (pos) {
                const zoom = figma.viewport.zoom || 1;
                let nx = pos.x;
                let ny = pos.y;
                if (msg.anchorRight)
                    nx = pos.x + (uiLastW - w) / zoom; // 오른쪽 가장자리 고정 → 왼쪽으로 확장
                if (msg.anchorBottom)
                    ny = pos.y + (uiLastH - h) / zoom; // 아래 가장자리 고정 → 위로 확장
                try {
                    figma.ui.reposition(nx, ny);
                }
                catch (_e) { }
            }
        }
        else {
            figma.ui.resize(w, h);
        }
        uiLastW = w;
        uiLastH = h;
        return;
    }
    // 취소: 어노테이션 제거
    if (msg.type === "CANCEL") {
        removeAnnotations();
        return;
    }
    // 노드로 포커스 이동 및 스트로크 추가
    if (msg.type === "FOCUS_NODE") {
        try {
            const nodeId = msg.nodeId;
            if (!nodeId) {
                return;
            }
            // 1. 먼저 캐시에서 찾기 (PREVIEW에서 찾은 노드)
            let node = previewNodeCache.get(nodeId) || null;
            // 2. 캐시에 없으면 getNodeByIdAsync로 찾기 (dynamic-page에서는 동기 getNodeById가 동작 안 함)
            if (!node) {
                try {
                    const nodeById = await figma.getNodeByIdAsync(nodeId);
                    if (nodeById && nodeById.type === "TEXT") {
                        node = nodeById;
                    }
                }
                catch (e) {
                    // 조회 실패 시 무시
                }
            }
            // 3. 노드를 찾았으면 선택 및 뷰포트 이동
            if (node && node.type === "TEXT" && !node.removed) {
                // 해당 노드 선택
                figma.currentPage.selection = [node];
                // 뷰포트 이동 및 확대
                figma.viewport.scrollAndZoomIntoView([node]);
                // 해당 코멘트를 맨 앞으로 (selectionchange에 의존하지 않고 직접 호출)
                bringAnnotationsToFront([nodeId]);
            }
        }
        catch (e) {
            console.error("[FOCUS] 노드 포커스 오류:", e);
        }
        return;
    }
    // 선택된 노드들을 Figma에서도 선택
    if (msg.type === "SELECT_NODES") {
        try {
            const nodeIds = msg.nodeIds || [];
            // 선택 상태에 따라 코멘트 투명도 갱신 (선택=불투명, 미선택=반투명)
            updateAnnotationOpacity(nodeIds);
            // 선택된 코멘트를 맨 앞으로 (겹칠 때 가려지지 않도록)
            bringAnnotationsToFront(nodeIds);
            if (nodeIds.length === 0) {
                // 선택 해제
                figma.currentPage.selection = [];
                return;
            }
            // 캐시에서 노드 찾기
            const nodesToSelect = [];
            for (const nodeId of nodeIds) {
                // 1. 캐시에서 찾기
                let node = previewNodeCache.get(nodeId) || null;
                // 2. 캐시에 없으면 getNodeByIdAsync로 찾기 (dynamic-page에서는 동기 getNodeById가 동작 안 함)
                if (!node) {
                    try {
                        const nodeById = await figma.getNodeByIdAsync(nodeId);
                        if (nodeById && nodeById.type === "TEXT") {
                            node = nodeById;
                        }
                    }
                    catch (e) {
                        // 무시
                    }
                }
                if (node && !node.removed) {
                    nodesToSelect.push(node);
                }
            }
            // 선택된 노드들을 Figma에서 선택
            // (뷰포트 이동은 하지 않는다 — 전체 선택 시 캔버스가 첫 노드로 튕기는 문제.
            //  카드 클릭으로 이동하는 건 FOCUS_NODE가 담당)
            if (nodesToSelect.length > 0) {
                figma.currentPage.selection = nodesToSelect;
            }
        }
        catch (e) {
            console.error("[SELECT_NODES] 오류:", e);
        }
        return;
    }
    // 팝업 [케이스 더 받기] — 방금 추천받은 팝업 요소로 다시 요청해 세트를 아래에 덧붙인다.
    // 캔버스 선택이 아니라 기억해 둔 요소(lastPopupElements)를 쓴다 — 결과를 보는 동안 선택이 풀릴 수 있어서.
    if (msg.type === "RECOMMEND_POPUP_MORE") {
        const els = lastPopupElements;
        if (!els || els.length < 2) {
            figma.ui.postMessage({ type: 'show-toast', message: '팝업을 다시 선택한 뒤 추천을 받아 주세요.' });
            figma.ui.postMessage({ type: 'popup-more-end' });
            return;
        }
        await popupRecommendFlow(msg.model, { elements: els, append: true });
        figma.ui.postMessage({ type: 'popup-more-end' }); // 실패로 끝났으면 버튼을 원상 복구
        return;
    }
    // 프레임별 추천 — 하위 프레임 묶음이 있는 선택에서 [전체]로 받을 때 (UI가 보여주는 묶음을 그대로 보낸다)
    if (msg.type === "RECOMMEND_GROUPS") {
        const groups = Array.isArray(msg.groups)
            ? msg.groups
                .map((g) => ({
                name: String((g && g.name) || ''),
                texts: (g && Array.isArray(g.texts) ? g.texts : []).map((t) => String(t || '').trim()).filter(Boolean),
                own: !!(g && g.own), // '이 프레임 문구' 표시 — 결과 화면도 미리보기와 같게 보이게 되돌려 준다
                role: (g && g.role) ? String(g.role) : undefined, // '버튼' 영역이면 버튼 규칙으로
            }))
                .filter((g) => g.texts.length)
            : [];
        if (groups.length < 2) {
            figma.ui.postMessage({ type: 'show-toast', message: '나눠진 영역을 찾지 못했어요 — 프레임을 다시 선택해 주세요.' });
            figma.ui.postMessage({ type: 'groups-recommend-end' });
            return;
        }
        await groupsRecommendFlow(groups, msg.model, !!msg.more);
        return;
    }
    // 문구 추천 — 직접 입력이 있으면 그걸, 없으면 선택 영역 텍스트를 대상으로 한다
    if (msg.type === "RECOMMEND") {
        // 추천 = AI 추천 하나로 통일. AI를 쓸 수 있으면 AI 결과만 띄우고,
        // AI를 못 쓸 때만(다리 꺼짐 + 키·공용키 없음) 예시·규칙 폴백으로 빈손을 면한다.
        // 예시 사전은 화면 카드로는 안 나오지만 AI 프롬프트의 톤 교재(few-shot)로 계속 쓰인다.
        // 직접 입력이 없고 '텍스트 여러 개 든 컴포넌트'(팝업)를 선택했으면 → 요소별 추천으로 자동 전환.
        if (!(msg.text && msg.text.trim())) {
            if (await popupRecommendFlow(msg.model))
                return;
        }
        const text = (msg.text && msg.text.trim()) ? msg.text.trim() : await collectSelectedText();
        if (!text) {
            figma.ui.postMessage({ type: 'show-toast', message: '문구를 입력하거나 텍스트를 선택해주세요.' });
            return;
        }
        // AI 엔진은 클로드 다리 하나 (API 키 경로 제거됨)
        let bh = await bridgeHealth();
        if (!bh.alive) {
            // 클로드를 못 쓰는 상태 — 예시·규칙 폴백 (forceAi여도 폴백이라도 보여준다)
            postRecommendFallback(text, '');
            return;
        }
        // 다리가 구버전이면 사용자가 [업데이트] 버튼을 안 눌러도 여기서 자동으로 재연결한다.
        bh = await autoUpgradeIfOld(bh);
        if (!bh.alive || bh.problem === 'bridge-old') {
            figma.ui.postMessage({ type: 'hide-loading' });
            if (!bh.alive) {
                postRecommendFallback(text, '');
                return;
            }
            figma.ui.postMessage({ type: 'show-toast', message: '아직 옛 버전이 연결돼요. 이 폴더예요: ' + (bh.dir || '경로 불명') + ' — 최신 코드로 업데이트해 주세요.' });
            return;
        }
        // 계정 확인 게이트 — 이 PC에 저장된 계정을 사용자가 아직 확인 안 했으면 AI를 부르지 않는다
        if (needsAccountConfirm(bh)) {
            figma.ui.postMessage({ type: 'account-confirm-needed', account: bh.account });
            postRecommendFallback(text, '', '어느 클로드 계정으로 쓸지 위에서 먼저 확인해 주세요.', false);
            return;
        }
        // AI 추천은 진행률을 알 수 없다(다 만들어지면 한 번에 옴) → 가짜 %가 아니라 경과 시간 기반 표시.
        figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '클로드가 문구를 다듬는 중이에요' });
        try {
            // 클로드 결과를 용어집·네이버 맞춤법으로 한 번 더 다듬는다 (프롬프트 위반 안전망)
            // 버튼이면 문장부호를 떼는 안전망까지 (버튼 라벨엔 마침표·물음표를 쓰지 않는다)
            const suggestions = refineButtonSuggestions(await refineAiSuggestions(await fetchAiSuggestions(text, msg.model, msg.role)), msg.role);
            figma.ui.postMessage({ type: 'hide-loading' });
            // forceAi([AI 추천 더 받기])면 기존 결과 아래에 덧붙이고, 아니면 새로 표시
            figma.ui.postMessage({ type: 'recommend-result', original: text, suggestions, appendAi: !!msg.forceAi });
        }
        catch (e) {
            figma.ui.postMessage({ type: 'hide-loading' });
            if (msg.forceAi)
                figma.ui.postMessage({ type: 'show-toast', message: errStr(e) });
            else
                postRecommendFallback(text, errStr(e), undefined, true); // AI 실패 → 폴백 + 재시도 버튼
            refreshBridgeStatus(); // 로그인 만료 등이면 [클로드] 버튼을 바로 [로그인 필요]로
        }
        return;
    }
    // 대화형 문구 제작 — 상황을 설명하면 클로드가 맥락에 맞는 문구를 만들어준다.
    // 대화(messages)는 UI가 통째로 보내고, 다리가 매 턴 전체 맥락을 실어 클로드에 전달한다(무상태).
    if (msg.type === "COMPOSE") {
        const messages = Array.isArray(msg.messages) ? msg.messages : [];
        // 어느 대화의 요청인지 UI가 실어 보낸 id — 응답에 그대로 되돌려줘서, 답이 오기 전에
        // 사용자가 다른 대화로 바꿔도 UI가 원래 대화(히스토리)에 답을 붙일 수 있게 한다
        const convoId = msg.convoId ? String(msg.convoId) : '';
        if (!messages.length) {
            figma.ui.postMessage({ type: 'compose-result', ok: false, convoId, error: '설명할 내용을 입력해주세요.' });
            return;
        }
        const bh = await bridgeHealth();
        if (!bh.alive) {
            figma.ui.postMessage({ type: 'compose-result', ok: false, convoId, error: '클로드가 연동돼 있지 않아요 — [클로드] 버튼으로 연결해 주세요.' });
            return;
        }
        // 계정 확인 게이트 (추천과 동일)
        if (needsAccountConfirm(bh)) {
            figma.ui.postMessage({ type: 'account-confirm-needed', account: bh.account });
            figma.ui.postMessage({ type: 'compose-result', ok: false, convoId, error: '어느 클로드 계정으로 쓸지 먼저 확인해 주세요.' });
            return;
        }
        try {
            const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/compose', { messages, model: msg.model }, 130000);
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) {
                // 다리의 error는 이미 사람용 안내문(자체 접두어 포함) — 여기서 또 접두어를 붙이면 "실패: 실패:"로 겹친다
                figma.ui.postMessage({ type: 'compose-result', ok: false, convoId, error: (data && data.error) ? String(data.error) : ('클로드 호출 실패: HTTP ' + res.status) });
                refreshBridgeStatus();
                return;
            }
            // 제안 문구는 추천과 동일하게 용어집·맞춤법 후처리를 거친다 (프롬프트 위반 안전망)
            const suggestions = Array.isArray(data.suggestions) && data.suggestions.length
                ? await refineAiSuggestions(data.suggestions)
                : [];
            figma.ui.postMessage({ type: 'compose-result', ok: true, convoId, reply: String(data.reply || ''), suggestions });
        }
        catch (e) {
            figma.ui.postMessage({ type: 'compose-result', ok: false, convoId, error: '클로드 호출 실패: ' + errStr(e) });
            refreshBridgeStatus();
        }
        return;
    }
    // 오수정 제보 — "이 수정안이 잘못됐다"는 신고를 워커(/report)로 보내 관리자 페이지에 저장한다
    if (msg.type === "REPORT") {
        try {
            const payload = {
                nodeId: msg.nodeId || '',
                before: msg.before || '',
                after: msg.after || '',
                reason: msg.reason || '',
                comment: msg.comment || '',
                fileName: (figma.root && figma.root.name) || '',
            };
            const res = await postJsonWithTimeout(REPORT_URL, payload, 15000);
            const data = await res.json().catch(() => ({}));
            if (!res.ok || (data && data.error)) {
                figma.ui.postMessage({ type: 'report-result', key: msg.key, ok: false, error: (data && data.error) ? data.error : ('HTTP ' + res.status) });
                return;
            }
            figma.ui.postMessage({ type: 'report-result', key: msg.key, ok: true });
        }
        catch (e) {
            figma.ui.postMessage({ type: 'report-result', key: msg.key, ok: false, error: errStr(e) });
        }
        return;
    }
    // 추천 좋아요 — 마음에 든 추천을 제보 저장소에 모은다 (reason='추천 좋아요' 마커).
    // 나중에 scripts/sync-feedback.js가 이 마커로 걸러 recommend-examples.md 후보로 만든다.
    if (msg.type === "LIKE_SUGGESTION") {
        try {
            const payload = {
                nodeId: '',
                before: msg.before || '', // 원본 문구
                after: msg.after || '', // 좋아요한 추천 문구
                reason: '추천 좋아요', // sync-feedback.js가 이 값으로 좋아요를 식별한다 — 바꾸면 스크립트도 같이
                comment: msg.comment || '', // AI가 붙인 추천 사유
                fileName: (figma.root && figma.root.name) || '',
            };
            const res = await postJsonWithTimeout(REPORT_URL, payload, 15000);
            const data = await res.json().catch(() => ({}));
            const ok = res.ok && !(data && data.error);
            figma.ui.postMessage({ type: 'like-result', key: msg.key, ok, error: ok ? '' : ((data && data.error) || ('HTTP ' + res.status)) });
        }
        catch (e) {
            figma.ui.postMessage({ type: 'like-result', key: msg.key, ok: false, error: errStr(e) });
        }
        return;
    }
    // 클로드 다리 상태 조회 — UI의 [🔌 클로드] 버튼 표시/깨우기 피드백용
    if (msg.type === "CHECK_BRIDGE") {
        const h = await bridgeHealth();
        figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem, account: h.account, needConfirm: needsAccountConfirm(h) });
        return;
    }
    // 클로드 로그인 창 열기 — [🟠 클로드 로그인 필요] 버튼이 호출. 다리가 claude 터미널을 대신 열어준다
    if (msg.type === "OPEN_CLAUDE_LOGIN") {
        // 로그인 창을 여는 건 다리다. 계정 화면은 비용 때문에 다리를 안 켜두므로, 여기서 로그인 직전에 다리를 확실히 깨운다.
        // (안 그러면 "다리 꺼짐?" 오류가 난다 — 사용자는 로그인 버튼을 눌렀을 뿐인데.)
        const switchAccount = !!msg.switchAccount;
        async function tryOpenLogin() {
            try {
                const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/open-login', { switchAccount }, 5000);
                const data = await res.json().catch(() => ({}));
                return { ok: res.ok, data };
            }
            catch (_e) {
                return { ok: false, data: null };
            }
        }
        let r = await tryOpenLogin();
        if (!r.ok && !r.data) {
            // 다리가 꺼져 있었다 — 감시자로 깨우고(claudebridge:// 보조), 뜰 때까지 기다렸다 다시 시도한다.
            // 감시자까지 없으면(=이 PC에 아직 아무것도 설치 안 됨) 오래 기다려도 다리는 안 뜬다 →
            // 12초 헛스피너 대신 짧게만 기다리고 곧장 '설치 필요'로 넘겨 다운로드 안내를 띄운다.
            let watcherWoke = false;
            figma.ui.postMessage({ type: 'show-toast', message: '클로드를 연결하는 중이에요 — 잠시 후 로그인 창이 열려요.' });
            try {
                await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000);
                watcherWoke = true;
            }
            catch (_e) {
                try {
                    figma.openExternal('claudebridge://start');
                }
                catch (_e2) { /* 둘 다 실패 — 아래 재시도가 알려준다 */ }
            }
            // 감시자가 응답했으면 다리 기동을 최대 12초 기다린다. 감시자도 없으면(새 PC) 프로토콜 보조만 믿고 3초 뒤 포기 → 설치 안내.
            const tries = watcherWoke ? 8 : 3;
            const gap = watcherWoke ? 1500 : 1000;
            for (let i = 0; i < tries && (!r.ok && !r.data); i++) {
                await new Promise((res) => setTimeout(res, gap));
                if ((await bridgeHealth()).alive)
                    r = await tryOpenLogin();
            }
        }
        // UI의 로그인 대기 화면이 결과를 알아야 한다 — 토스트만 보내면 대기 화면에 가려 안 보이고,
        // 사용자는 브라우저가 안 뜬 채 스피너만 도는 걸 보게 된다(다리 없는 PC에서 실제 발생).
        figma.ui.postMessage({
            type: 'login-open-result',
            ok: !!r.ok,
            mode: (r.data && r.data.mode) || '',
            noBridge: !r.ok && !r.data,
            error: (!r.ok && !r.data)
                ? '이 PC에 클로드가 연결돼 있지 않아요. 설치 파일을 한 번 실행하면 다음부터 바로 열려요.'
                : (!r.ok ? ((r.data && r.data.error) || '터미널에서 claude 실행 후 /login 해 주세요.') : ''),
        });
        figma.ui.postMessage({
            type: 'show-toast',
            message: (!r.ok && !r.data)
                ? '로그인 창을 못 열었어요 — 클로드가 이 PC에 연결됐는지 확인해 주세요(꺼져 있으면 [클로드] 버튼으로 켜기).'
                : !r.ok
                    ? ((r.data && r.data.error) || '로그인 창을 못 열었어요 — 터미널에서 claude 실행 후 /login 해 주세요.')
                    : r.data && r.data.mode === 'terminal'
                        ? '이번엔 터미널 로그인 창을 열었어요 — 안내에 따라 진행하고, 브라우저에 코드가 보이면 터미널에 붙여넣으세요.'
                        : r.data && r.data.mode === 'browser-switch'
                            ? '브라우저에 계정 선택 화면을 열었어요 — 잠깐 기다렸다가 쓰려는 계정을 고르면 자동으로 바뀌어요.'
                            : '브라우저에 클로드 로그인 페이지를 열었어요 — 로그인하면 자동으로 연결돼요. 완료가 안 되면 버튼을 한 번 더 누르세요.',
        });
        return;
    }
    // 구버전 다리 재시작 — [🟠 다리 업데이트 필요] 클릭. 옛 프로세스를 끄고 감시자로 새 코드를 켠다.
    // (코드를 pull·복사해도 떠 있던 다리는 옛 코드 그대로라 껐다 켜야 새 동작이 나온다)
    if (msg.type === "RESTART_BRIDGE") {
        figma.ui.postMessage({ type: 'show-toast', message: '클로드를 새 버전으로 다시 연결하는 중이에요…' });
        try {
            await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/shutdown', {}, 3000);
        }
        catch (_e) { /* 이미 꺼졌으면 무시 */ }
        await new Promise((r) => setTimeout(r, 1200)); // 옛 다리가 스스로 종료할 시간
        try {
            await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000);
        }
        catch (e) {
            try {
                figma.openExternal('claudebridge://start');
            }
            catch (_e2) { /* 보조 경로도 실패 — 아래 상태 확인이 알려준다 */ }
        }
        // 새 다리가 뜨고 /health가 응답할 때까지 잠깐 기다렸다 결과를 알린다
        let h = await bridgeHealth();
        for (let i = 0; i < 6 && (!h.alive || h.problem === 'bridge-old'); i++) {
            await new Promise((r) => setTimeout(r, 1500));
            h = await bridgeHealth();
        }
        // UI가 '연결하는 중' 덮개를 걷고(성공) 실패면 조치 화면으로 바꿀 수 있게 끝을 알린다 —
        // 재시작엔 켜기 폴링이 없어서 이 신호가 없으면 덮개가 영영 돈다.
        figma.ui.postMessage({ type: 'bridge-restart-done', ok: h.alive && h.problem !== 'bridge-old', alive: h.alive, problem: h.problem || null });
        if (h.alive && h.problem !== 'bridge-old') {
            figma.ui.postMessage({ type: 'show-toast', message: '새 버전으로 연결됐어요! 이제 추천받기를 누르면 돼요.' });
        }
        else if (h.problem === 'bridge-old') {
            // 재시작했는데도 옛 코드 = 감시자가 다른 폴더(설치본 등)의 다리를 켜고 있다 — 경로를 알려준다
            figma.ui.postMessage({ type: 'show-toast', message: '아직 옛 버전이 연결돼요. 이 폴더에서 실행 중이에요: ' + (h.dir || '경로 불명') + ' — 이 폴더를 최신 코드로 업데이트해 주세요.' });
        }
        else {
            figma.ui.postMessage({ type: 'show-toast', message: '클로드를 다시 연결하지 못했어요 — [클로드 연동 안 됨] 버튼으로 직접 연결해 주세요.' });
        }
        refreshBridgeStatus();
        return;
    }
    // 추천/번역 화면에 들어올 때 UI가 요청 — 지금 캔버스에서 선택된 프레임/텍스트의 문구를 돌려준다.
    // (초기 선택이나 selectionchange 타이밍에 안 잡히는 경우를 위해 화면 진입 시 직접 조회한다)
    // 팝업 미리보기 [초기화] — 캔버스 선택을 풀어 초기 입력 화면으로 되돌린다.
    // 선택이 비면 위 selectionchange가 selection-text(popup:0)를 보내 UI가 입력창을 복원한다.
    if (msg.type === "CLEAR_SELECTION") {
        try {
            figma.currentPage.selection = [];
        }
        catch (_e) { /* 무시 */ }
        return;
    }
    if (msg.type === "GET_SELECTION_TEXT") {
        // 팝업(텍스트 여러 개 든 컴포넌트)이면 입력창을 채우지 않고 팝업 신호만 보낸다
        const s0 = figma.currentPage.selection[0];
        const popupEls = (s0 && s0.type !== 'TEXT') ? classifyPopup(s0) : [];
        if (isDialogLike(s0, popupEls)) {
            figma.ui.postMessage({ type: 'selection-text', text: '', popup: popupEls.length, popupElements: popupEls, onEnter: true });
            return;
        }
        let t = '';
        try {
            t = await collectSelectedText();
        }
        catch (_e) { /* 선택 없음 등 */ }
        const sel = figma.currentPage.selection;
        figma.ui.postMessage({
            type: 'selection-text',
            text: (t && t.trim()) ? t : '',
            groups: frameGroupsForSelection(sel),
            role: (sel.length === 1 && detectButtonRole(sel[0])) ? '버튼' : undefined,
            onEnter: true,
        });
        return;
    }
    // 이 PC의 클로드 계정 조회 — 감시자(항상 떠 있음)가 파일만 읽어 답한다.
    // 다리를 켜지 않는 것이 핵심: 다리는 켜질 때 워밍업으로 클로드를 실제 호출해 구독 사용량이 나가므로,
    // 검토만 쓰는 사람에게 비용을 물리지 않으려면 계정 표시용으로 다리를 켜면 안 된다.
    // 클로드 로그아웃 — 홈의 [로그아웃] 버튼. 다리가 claude auth logout으로 CLI 로그인을 해제한다.
    // 다리가 꺼져 있으면 로그아웃할 것도 없지만, 확실히 하려고 깨워서 실행한다.
    if (msg.type === "LOGOUT_CLAUDE") {
        async function tryLogout() {
            try {
                const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/claude-logout', {}, 10000);
                const d = await res.json().catch(() => ({}));
                return { ok: res.ok && d && d.ok, error: d && d.error };
            }
            catch (_e) {
                return null;
            }
        }
        let r = await tryLogout();
        if (r === null) {
            // 다리가 꺼져 있었다 — 깨우고 재시도
            try {
                await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000);
            }
            catch (_e) { /* 감시자도 없으면 아래에서 실패 보고 */ }
            for (let i = 0; i < 6 && r === null; i++) {
                await new Promise((res) => setTimeout(res, 1500));
                if ((await bridgeHealth()).alive)
                    r = await tryLogout();
            }
        }
        if (r && r.ok) {
            confirmedClaudeAccount = null; // 확인했던 계정도 무효화 — 다시 로그인하면 새로 확인받는다
            try {
                await figma.clientStorage.setAsync(CONFIRMED_ACCOUNT_KEY, '');
            }
            catch (_e) { /* 무시 */ }
        }
        figma.ui.postMessage({ type: 'logout-result', ok: !!(r && r.ok), error: r ? r.error : '클로드가 이 PC에 연결되지 않았어요.' });
        return;
    }
    // 이 PC를 '새 PC' 상태로 되돌린다 — 계정 화면의 [초기화] 버튼이 호출(2단계 확인 후).
    // 감시자에게 자기 제거(자동시작·설치 폴더 삭제 + 다리 종료 + 자기 종료)를 시키고,
    // 플러그인 쪽 기억(확인한 계정)도 함께 지운다 → 다음에 열 때 '첫 PC'로 인식된다.
    // claude 로그인(~/.claude.json)은 건드리지 않는다 — 다시 연결하면 그대로 잡힌다.
    if (msg.type === "RESET_FRESH") {
        let watcherReached = false;
        let removed = [];
        try {
            const res = await postJsonWithTimeout(WATCHER_URL + '/uninstall', {}, 6000);
            if (res.ok) {
                watcherReached = true; // 감시자가 자기 제거를 수행함(자동시작·설치 삭제). 감시자는 곧 스스로 종료
                const d = await res.json().catch(() => ({}));
                if (Array.isArray(d && d.removed))
                    removed = d.removed;
            }
            // 404 등(구버전 감시자엔 /uninstall 없음) → watcherReached=false로 두고 아래 안내에 반영
        }
        catch (_e) {
            // 감시자가 이미 꺼져 있음 = 되돌릴 자동시작이 안 떠 있는 것 → 정상(플러그인 기억만 지우면 됨)
        }
        // 구버전 감시자(/uninstall 없음)는 위에서 404라 못 지웠다 — 최소한 /shutdown으로 꺼서 이 세션에선 '새 PC'가 되게 한다.
        // (자동시작 등록은 플러그인 fetch로 못 지워 재부팅/재로그인 때 되살아날 수 있음 — 완전 제거는 최신 커넥터로 갱신 후 초기화)
        if (!watcherReached) {
            try {
                await postJsonWithTimeout(WATCHER_URL + '/shutdown', {}, 2000);
            }
            catch (_e) { /* 감시자 자체가 없음 — 정상 */ }
        }
        // 감시자 없이 다리만 떠 있을 수도 있으니 직접 한 번 더 끈다 (best-effort)
        try {
            await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/shutdown', {}, 2000);
        }
        catch (_e) { /* 이미 꺼짐 */ }
        // 플러그인 기억(확인한 계정)은 감시자 성패와 무관하게 항상 지운다
        confirmedClaudeAccount = null;
        try {
            await figma.clientStorage.setAsync(CONFIRMED_ACCOUNT_KEY, '');
        }
        catch (_e) { /* 무시 */ }
        // 감시자(/uninstall 응답 후 자기 종료 ~0.45초)·다리(/shutdown 후 ~0.2초)가 실제로 죽을 때까지 잠깐 기다린다.
        // 이래야 UI의 다음 계정조회가 '계정 없음'을 받아 진짜 새 PC 화면으로 떨어진다(살아있으면 계정이 잡혀 확인 팝업이 뜬다).
        await new Promise((r) => setTimeout(r, 900));
        figma.ui.postMessage({ type: 'reset-result', ok: true, watcherReached, removed });
        return;
    }
    if (msg.type === "CHECK_ACCOUNT") {
        await confirmedAccountLoaded; // 저장된 확인 계정을 읽은 뒤 답해야 UI가 첫 화면을 옳게 정한다
        let account = null;
        let claudeInstalled = null;
        let source = 'none';
        let watcherOld = false;
        // ① 감시자 /account (비용 0). 단, 옛 감시자(v2)는 이 경로가 없어 404를 준다 — 그건 '답 못 함'이지 '계정 없음'이 아니다.
        try {
            const res = await fetchWithTimeout(WATCHER_URL + '/account', 3000);
            if (res.ok) {
                const d = await res.json().catch(() => ({}));
                if (d && d.ok === true && ('account' in d)) {
                    account = d.account || null;
                    claudeInstalled = (typeof d.claude === 'boolean') ? d.claude : null;
                    source = 'watcher'; // v3 감시자가 확정적으로 답함(계정이 null이어도 '로그인 없음'으로 확정)
                }
                else {
                    watcherOld = true; // 응답은 하는데 /account 형식이 아님 = 구버전
                }
            }
            else {
                watcherOld = true; // 404 등 = 구버전 감시자(경로 없음)
            }
        }
        catch (_e) { /* 감시자 꺼짐 — 아래 다리 폴백으로 */ }
        // ② 다리에도 물어본다 — (a)감시자가 답을 못 했거나(구버전·꺼짐), (b)감시자는 '계정 없음'이라는데
        //    감시자 캐시(30초)가 낡아서일 수 있는 경우. 다리는 로그인 시 캐시를 비우므로 더 최신이다.
        //    이게 없으면 로그인 직후에도 최대 30초간 '로그인 안 됨'으로 보인다(로그인 화면에 계속 머무름).
        if (!account) {
            try {
                const h = await bridgeHealth();
                if (h.alive && h.account) {
                    account = h.account;
                    claudeInstalled = true;
                    source = 'bridge';
                }
            }
            catch (_e2) { /* 둘 다 없으면 계정 모름 — UI가 '확인 불가'로 안내 */ }
        }
        figma.ui.postMessage({ type: 'account-info', account, claudeInstalled, source, watcherOld, confirmed: confirmedClaudeAccount });
        return;
    }
    // 계정 확인 — UI의 [이 계정 사용] 버튼이 호출. 확인된 계정만 AI 추천·번역에 쓴다
    if (msg.type === "CONFIRM_ACCOUNT") {
        const acct = msg.account ? String(msg.account) : '';
        if (acct) {
            confirmedClaudeAccount = acct;
            try {
                await figma.clientStorage.setAsync(CONFIRMED_ACCOUNT_KEY, acct);
            }
            catch (_e) { /* 저장 실패해도 세션 중엔 유효 */ }
            figma.ui.postMessage({ type: 'show-toast', message: acct + ' 계정으로 쓸게요 — 이제 추천받기를 누르면 클로드가 답해요.' });
            refreshBridgeStatus();
        }
        return;
    }
    // 대화로 만들기 최근 대화 목록 — UI가 목록을 통째로 저장/복원한다 (병합 로직은 UI 담당)
    if (msg.type === "LOAD_COMPOSE_HISTORY") {
        let list = [];
        try {
            const raw = await figma.clientStorage.getAsync(COMPOSE_HISTORY_KEY);
            if (Array.isArray(raw))
                list = raw;
        }
        catch (_e) { /* 저장 이력 없음 등 — 빈 목록 */ }
        figma.ui.postMessage({ type: 'compose-history', list });
        return;
    }
    if (msg.type === "SAVE_COMPOSE_HISTORY") {
        const list = Array.isArray(msg.list) ? msg.list : [];
        try {
            await figma.clientStorage.setAsync(COMPOSE_HISTORY_KEY, list);
        }
        catch (_e) { /* 저장 실패해도 이 세션 메모리엔 남아 있음 */ }
        return;
    }
    // 클로드 다리 끄기 — [🟢 클로드 켜짐] 버튼을 다시 누르면 호출 (다리의 자기 종료 API)
    if (msg.type === "STOP_BRIDGE") {
        try {
            await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/shutdown', {}, 3000);
        }
        catch (_e) { /* 이미 꺼져 있으면 무시 */ }
        // 다리는 응답 후 스스로 종료(약 200ms) — 잠깐 기다렸다 실제로 꺼졌는지 확인해 회신
        await new Promise((r) => setTimeout(r, 700));
        let h = await bridgeHealth();
        if (h.alive) {
            await new Promise((r) => setTimeout(r, 800));
            h = await bridgeHealth();
        }
        figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem, account: h.account, needConfirm: needsAccountConfirm(h), stopped: !h.alive });
        return;
    }
    // 클로드다리 설치 파일 요청 — UI가 base64를 받아 다운로드로 내려준다 (새 PC 첫 설정용).
    // 맥이면 .command를 zip으로(다운로드가 실행 권한을 못 날라서), 윈도우면 .bat을 그대로.
    if (msg.type === "GET_INSTALLER") {
        if (msg.mac) {
            figma.ui.postMessage({ type: 'installer-file', b64: INSTALLER_MAC_ZIP_B64, name: '클로드-커넥터.zip', mime: 'application/zip' });
        }
        else {
            figma.ui.postMessage({ type: 'installer-file', b64: INSTALLER_B64, name: '클로드-커넥터.bat', mime: 'application/octet-stream' });
        }
        return;
    }
    // 다리 깨우기 — 주경로: 감시자(11889) fetch. 피그마가 프로토콜 열기를 다 막아도 fetch는 못 막는다.
    if (msg.type === "WAKE_BRIDGE") {
        // 보조 경로(claudebridge:// 프로토콜)는 감시자 실패 시에만 쓴다 — 병행하면 프로토콜이 안 막힌
        // 피그마에서 다리가 이중 기동되며 그쪽 창(런처의 숨김이 안 먹는 환경)이 사용자에게 보일 수 있다.
        try {
            await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000);
        }
        catch (e) {
            console.log('[BRIDGE] 감시자 깨우기 실패(감시자 꺼짐?) — 프로토콜 보조 경로 시도:', errStr(e));
            try {
                figma.openExternal('claudebridge://start');
            }
            catch (e2) {
                console.log('[BRIDGE] openExternal 실패:', errStr(e2));
            }
        }
        return;
    }
};
