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
                collectSelectedText().then((t) => {
                    figma.ui.postMessage({ type: 'selection-text', text: (t && t.trim()) ? t : '', popup: 0 });
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
        collectSelectedText().then((t) => {
            if (t && t.trim())
                figma.ui.postMessage({ type: 'selection-text', text: t, onEnter: true });
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
// 팝업 요소별 추천 — 선택이 '팝업 같은 구조'(isDialogLike)면 역할별로 갈라 요소마다 추천하고 true 반환.
// 아니면(단일 텍스트·카드·빈 선택 등) 처리하지 않고 false → 호출부가 일반 추천으로 넘어간다.
async function popupRecommendFlow(model) {
    const sel = figma.currentPage.selection;
    if (!sel.length || sel[0].type === "TEXT")
        return false;
    const elements = classifyPopup(sel[0]);
    if (!isDialogLike(sel[0], elements))
        return false;
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
    figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '팝업 문구를 세트로 다듬는 중이에요' });
    try {
        // 팝업 전체를 한 요청에 묶어 보내 타이틀·안내·버튼이 일관된 "세트"를 받는다.
        // (요소별로 따로 뽑아 조합하면 서로 안 맞을 수 있어 세트 단위로 받는다.)
        const data = await fetchAiPopup(elements, model);
        const sets = await refinePopupSets(data.sets || []);
        figma.ui.postMessage({ type: 'hide-loading' });
        figma.ui.postMessage({ type: 'popup-recommend-result', sets });
    }
    catch (e) {
        figma.ui.postMessage({ type: 'hide-loading' });
        figma.ui.postMessage({ type: 'popup-recommend-result', sets: [], error: errStr(e) });
    }
    refreshBridgeStatus();
    return true;
}
// AI 제안 가져오기 — 클로드 다리 전용 (Gemini/API 키 경로 제거됨).
// 성공하면 {text, reason} 배열, 실패하면 사유 메시지를 담은 Error를 던진다.
async function fetchAiSuggestions(text, model) {
    try {
        const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/recommend', { text, model }, 130000);
        const data = await res.json();
        if (res.ok && data && data.suggestions && data.suggestions.length)
            return data.suggestions;
        // 원인이 파악된 실패(problem: claude-logout/claude-missing)는 다리가 이미 사람용 안내문을 보냄 — 접두어 없이 그대로
        if (data && data.problem && data.error)
            throw new Error('BRIDGE_GUIDE:' + String(data.error));
        throw new Error('클로드 추천 실패: ' + (data && data.error ? data.error : ('HTTP ' + res.status)));
    }
    catch (e) {
        if (e instanceof Error && e.message.indexOf('BRIDGE_GUIDE:') === 0)
            throw new Error(e.message.slice('BRIDGE_GUIDE:'.length));
        if (e instanceof Error && e.message.indexOf('클로드 추천 실패') >= 0)
            throw e;
        throw new Error('클로드 추천 실패: ' + errStr(e));
    }
}
async function fetchAiPopup(elements, model) {
    try {
        const payload = elements.map((e) => ({ role: e.role, text: e.text }));
        const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/recommend-popup', { elements: payload, model }, 130000);
        const data = await res.json();
        if (res.ok && data && Array.isArray(data.sets))
            return data;
        if (data && data.problem && data.error)
            throw new Error('BRIDGE_GUIDE:' + String(data.error));
        // 200인데 sets가 없다 = 옛 버전 다리(응답 형식이 다름). 재연결이 필요하다는 신호.
        if (res.ok)
            throw new Error('BRIDGE_GUIDE:클로드가 옛 버전으로 연결돼 있어요 — 다시 눌러 새 버전으로 연결해 주세요.');
        throw new Error('클로드 추천 실패: ' + (data && data.error ? data.error : ('HTTP ' + res.status)));
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
    return sets.map((st) => ({
        reason: st.reason,
        elements: st.elements.map((el) => ({ role: el.role, text: map.get(el.text) || el.text })),
    }));
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
const BRIDGE_MIN_V = 15;
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
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21saw0KWjJVcENpOHZJT3k4bk91UmtPdXB0Q0R0bEl6cm42enF0N2pzbmJqc25aZ2dXK3kybE95eW5PdXdtK3E0c0YzcXNJQWdSMlZ0YVc1cElPMkNwQ0RzbDRic25iVHJqNFFnN1lHMDY2R2M2NU9jNjZHY0lFRkpJT3kybE95eW5PeWRoQ0Ryc0p2cmlwVHJpNlF1Q2k4dkNpOHZJT3lHamV1UGhDRHNoS1RxczRRNklPMkJ0T3Vobk91VG5PdWx2Q0RzbXBUc3NxM3JwNGpyaTZRZzdJT0k2NkdjSU95TG5PdVBtZTJWbU91cHRDQXpNSDQwTU95MGlPcXdnQ0RxdDdqcmc2VWc2NEtnN0pXRTZyQ0U2NHVrTGdvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0NpOHZJQ0FnNnJDQTdKMjA2NU9jSyt5WWlPeUxuQ2d4TVRIcXNiUXA2NHFVSU95eXF5RHJxWlRzaTV6c3A0RHJvWndnN1pXY0lPdXlpT3VuakNEc25iM3QNCm5venJpNlF1SU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjZ5NDZyV3M2NmVNSU91enRPdUN0T3V2Z091aG5DRHJ1YURycGJUcmk2UXVDaTh2SU95RXVPeUZtT3lkZ0NBek1PdXlpQ0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3WlcwSU91TWdPMlpsT3F3Z0NEcnJMVHRsWnp0bm9nZzZyaTQ3SmEwN0tlQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaTh2Q2k4dklPeWdoT3lnbkRvZzdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0NjQrOElPeWVpT3lkaENEcXNvTWdLR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3Snk4NjZHY0lPMlpsZXlkdUNrS0x5OGc3S084N0oyWU9pRHNncXpzbXFucm40bnNuWUFnNnJDQjdKNlFJTzJCdE91aG5PdVRuQ0RxdGF6cmo0VWc3WldjNjQrRTdKZVE3SVNjSU95d3FPcXdrT3VRbk91THBDNEtDbU52Ym5OMElHaDBkSEFnUFNCeVpYRjFhWEpsS0Nkb2RIUndKeWs3Q21OdmJuTjBJR1p6SUQwZ2NtVnhkV2x5WlNnblpuTW5LVHNLDQpZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdA0KWTNka0p5azdDblJ5ZVNCN0lHWnpMbTFyWkdseVUzbHVZeWhGVFZCVVdWOURWMFFzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsSUgwcE95QjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUXBqYjI1emRDQkRURUZWUkVWZlJVNVdJRDBnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnY0hKdlkyVnpjeTVsYm5Zc0lIc0tJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcENpQWdRMHhCVlVSRlgwTlBSRVZmUkVsVFFVSk1SVjlPVDA1RlUxTkZUbFJKUVV4ZlZGSkJSa1pKUXpvZ0p6RW5MQ0F2THlEdGhMUWc3SnFVN0pXOUlPdVRzU0RydG9EcXNJQWc3Wmk0N0xhY0lPdUJsQW9nSUVSSlUwRkNURVZmVkVWTVJVMUZWRkpaT2lBbk1TY3NDbjBwT3dvS1kyOXVjM1FnVUU5U1ZDQTlJRTUxYldKbGNpaHdjbTlqWlhOekxtVnUNCmRpNUNVa2xFUjBWZlVFOVNWQ2tnZkh3Z01URTRPRGc3SUM4dklFSlNTVVJIUlY5UVQxSlU2NHFVSU8yRmpPeUtwTzJLdU95YXFTQW83WStKN0lhTTdKZVVJREV4T0RnNElPcXpvT3lnbFNrS0x5OGc2NHVrNjZhc0lPeTlsT3VUbkNEcnNvVHNvSVFnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaV2M2NHVrTGlEc3ZaVHJrNXpycGJ3Z2NIVnNiTUszNjdPMTdJS3M3WlcwNjQrRUlDb3E3SjIwNjYrNElPdVdvQ0Rzbm9qcmlwUWc2NHVrNjZhczY0cVVJT3lZbXlEc3ZaVHJrNXdnNnJlNDY0eUE2NkdjS2lycm5id0tMeThnNnJ1UTY0dWtJT3k4bk9xNHNDRHNvSVRzbDVRZzdJT0lJT3VQbWV5ZWtleWR0Q0RzbFlnZzY0S1k3SmlvNjR1a0tPMkVzT3V2dU91RWtPeWR0Q0RybktqcmlwUWc2NU94S1M0ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkxzbkx6cm9ad2c2cldzNjdLRTdLQ0U3SjJFSU9xd2tPeW5nTzJWdENEc25xenNpNXpzbnBIc2k1enRncWpyaTZRdUNpOHZJT3VQbWV5ZWtleWR0Q0RyDQpzSlRyZ0l6cmlwUWc3SWlZN0tDVjdKMkVJTzJWbU91cHRDRHNuYlFnN0lpcjdKNlE2Nlc4SU95WXJPdW1yT3F6b0NCamIyUmxMblJ6N0oyWUlFSlNTVVJIUlY5TlNVNWZWdXVQaENEcXNKbnNuYlFnN0ppczY2YXc2NHVrTGdwamIyNXpkQ0JDVWtsRVIwVmZWaUE5SURFMU93b3ZMeURxdUxEcnM3Z2c2NnFvNjQyNExpRHNtcFRzc3EwbzdaU002NStzNnJlNDdKMjRLZXlkdENCdGIyUmxiT3lkaENEc3A0RHNvSlh0bFpqcnFiUWc2cmU0SU95YWxPeXlyZXVuakNEcXQ3Z2c2NnFvNjQyNDY2R2NJT3l5bU91bXJPMlZuT3VMcEM0S0x5OGdhR0ZwYTNVOTY3bWc2NmFFTCtxd2dPdXl2T3liZ0N3Z2MyOXVibVYwUGV5a2tlcXdoQ3dnYjNCMWN6M3F1TERyczdnbzdMV2M2ck9nN1pLSTdLZUlMQ0Rzb2JEcXVJZ2c2NHFRNjZhOEtRcGpiMjV6ZENCRFRFRlZSRVZmVFU5RVJVd2dQU0J3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVFU5RVJVd2dmSHdnSjI5d2RYTW5Pd3BqYjI1emRDQkJURXhQVjBWRVgwMVBSRVZNVXlBOQ0KSUZzbmFHRnBhM1VuTENBbmMyOXVibVYwSnl3Z0oyOXdkWE1uWFRzS1kyOXVjM1FnVkZWU1RsOVVTVTFGVDFWVVgwMVRJRDBnT1RBd01EQTdJQ0FnTHk4ZzdKcVU3TEt0SURIcXNiUWc3S0NjN1pXYzdJdWM2ckNFQ21OdmJuTjBJRTFCV0Y5VVZWSk9VeUE5SURNd095QWdJQ0FnSUNBZ0lDQWdJQzh2SU95ZHRPdW5qTzJCdkNEc2s3RHJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU0FvNjR5QTdabVVJT3VJaE95Z2dTRHJzS25zcDRBcENnb3ZMeURpbElEaWxJQWc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnS0hKbFkyOXRiV1Z1WkMxbGVHRnRjR3hsY3k1dFpDRGlnSlFnWW5WcGJHUXRaMnh2YzNOaGNua3VhblBzbVlBZzZyQ1o3SjJBSU8yTWpPeUVuQ2tnNHBTQTRwU0FDbVoxYm1OMGFXOXVJR3h2WVdSRmVHRnRjR3hsY3lncElIc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdiV1FnUFNCbWN5NXlaV0ZrUm1sc1pWTjVibU1vY0dGMGFDNXFiMmx1S0Y5ZlpHbHlibUZ0WlN3Z0p5NHVKeXdnSjNKbFkyOXQNCmJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW5kWFJtT0NjcE93b2dJQ0FnWTI5dWMzUWdjMlZqU1dSNElEMGdiV1F1YzJWaGNtTm9LQzllSXlNZzdMYVU3TEtjSU95WWlPeUxuRnh6S2lRdmJTazdDaUFnSUNCcFppQW9jMlZqU1dSNElEMDlQU0F0TVNrZ2NtVjBkWEp1SUZ0ZE93b2dJQ0FnWTI5dWMzUWdaWGhoYlhCc1pYTWdQU0JiWFRzS0lDQWdJR3hsZENCamRYSWdQU0J1ZFd4c093b2dJQ0FnWm05eUlDaGpiMjV6ZENCeVlYY2diMllnYldRdWMyeHBZMlVvYzJWalNXUjRLUzV6Y0d4cGRDZ25YRzRuS1NrZ2V3b2dJQ0FnSUNCamIyNXpkQ0JzYVc1bElEMGdjbUYzTG5KbGNHeGhZMlVvTDF4ekt5UXZMQ0FuSnlrN0NpQWdJQ0FnSUdOdmJuTjBJR2dnUFNCc2FXNWxMbTFoZEdOb0tDOWVJeU1qWEhNcktDNHJQeWxjY3lva0x5azdDaUFnSUNBZ0lHbG1JQ2hvS1NCN0lHTjFjaUE5SUhzZ2FXNXdkWFE2SUdoYk1WMHNJSE4xWjJkbGMzUnBiMjV6T2lCYlhTQjlPeUJsZUdGdGNHeGxjeTV3ZFhOb0tHTjFjaWs3DQpJR052Ym5ScGJuVmxPeUI5Q2lBZ0lDQWdJR052Ym5OMElHSWdQU0JzYVc1bExtMWhkR05vS0M5ZVhITXFMVnh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9ZaUFtSmlCamRYSXBJR04xY2k1emRXZG5aWE4wYVc5dWN5NXdkWE5vS0dKYk1WMHVjM0JzYVhRb0p5QXZJQ2NwTG1wdmFXNG9KeUFuS1NrN0NpQWdJQ0I5Q2lBZ0lDQnlaWFIxY200Z1pYaGhiWEJzWlhNdVptbHNkR1Z5S0NobEtTQTlQaUJsTG5OMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBK0lEQXBPd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNtSWpzaTV3ZzdJS3M3S0NFSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lYaHV5ZHRDRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z1cxMDdDaUFnZlFwOUNnb3ZMeURpbElEaWxJQWc3S2VBN0l1YzY2eTRJQ2pzaEp6cnNvUWdjbVZqYjIxdFpXNWs3Sm1BSU9xd21leWRnQ0RxdDV6c3Vaa2c0b0NVSU91dw0KbE9xK3VPdXB0Q0RxdDdqc3FyM3JqNFFnN1pXbzZydVlLU0RpbElEaWxJQUtMeThnN0pxcDdKYTA3S2VSS0dkc2IzTnpZWEo1TG0xa0tleWRnQ0RzbmJ6cnRvRHJuNndnN1pTRTY2R3M3WlNFN1lxNDdKZVFJT3lWaUNEcmhLUHJpcFRyaTZRb01qQXlOaTB3TnlEc2k2VHN1S0VwT2lEcmhLUHNuTHpycWJRZzdZRzA2NkdjNjVPYzZyQ0FJT3lhcWV5V3RDRHF0WkRzb0pYc25ZUUtMeThnN0tPOElPeWVoT3VzdE91aG5DRHNtS1R0bGJUdGxiUWdNK3F3bkNEc29KenNsWWpzbmJRZzdLQ0U2N2FBSUNMdGtaenF1TEFnNnJPZzdMbW9JQ3NnN0phMDdJaWNJT3V6Z09xeXZTTHNuYlFnNjVDYzY0dWtMaURzbDYzdGxhQWc2N2FFNjZhc0lPS0FsQW92THlEdGdiVHJvWnpyazV3Z1BTRHJyTGpzbnFVZzY0dWs2NU9zNnJpd0tPeXd2ZXlkbUNrc0lPeWFxZXlXdENEdGhyWHNuYnpDdCt1bm51eTJwT3V5bFNBOUlHTnZaR1V1ZEhNZ2NtVm1hVzVsUVdsVGRXZG5aWE4wYVc5dWN5RHRtNFRzc3BqcnBxd282cml3NnJPRTdLQ0INCktTNEtZMjl1YzNRZ1UxUlpURVZmVWxWTVJWTWdQU0JiQ2lBZ0p6RXVJTzJWdE95YWxPeXl0RG9nNjZxbzY1T2dJT3VzdU9xMXJPdUtsQ0R0bGJUc21wVHNzclRyb1p3dUlDanJzN1RyZzRYcmk0anJpNlRpaHBMcnM3VHJnclRzbXBRcEp5d0tJQ0FuTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNEb2c2NUNRN0phMDdKcVU0b2FTN1phSTdKYTA3SnFVTENCKzdKZUlJT3U1dk9xNHNDanJzSlRyZ0l6c2w0anNsclRzbXBUaWhwTHJzSlRxdjZqc2xyVHNtcFFwTGlEcmk2Z3NJT3lpaGV1ampNSzM2NmVNNjZPTXdyZnNsN0Rzc3JUQ3QrMlZ0T3luZ01LMzZyaXc2Nkdkd3JmcmhibnNuWXdnNjVPeElPeUxuT3lLcE8yRm5PeWR0Q0Rzbzd6c3NyVHNuYmdnNnJLdzZyTzg2NHFVSU95SW1PdVBtZTJZbFNEc25LRHNwNEFvN0pldzdMSzA2NCs4N0pxVUxDRHJoYm5zbll6cmo3enNtcFFwTGljc0NpQWdKek11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBNklDSis3WldnSU95SW1DRHNsNGJzbHJUc21wUWlJT3VNDQpnT3lMb0NBaWZ1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENJZzZyV3M3S0d3SU95YXNPeUVvQzRnNjR1b0xDRHNvSlhzc1lYc2c0RWc2N2FJNnJDQXdyZnNuYnpydG9BZzZyaXc2NHFsSU95Z25PMlZuTUszNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzZyS3c2ck84d3Jmc29KWHJzN1FnNjdPMDdaaTRJT3lWaU95THJPeWRnQ0RydG9Ec29KWHRtSlhzbkx6cm9ad2c2NnFGN1ptVjdaNklMaWNzQ2lBZ0p6UXVJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclE2SUg3dGxaanNpNXpxc3FEc2xyVHNtcFEvNG9hU2Z1MlZvT3E1ak95YWxEOHNJT3F6aE95TG5PdUxwT0tHa3V5ZWlPdUxwQ3dnN0plczdLMkk2NHVrNG9hUzdabVY3SjI0N1pXWTY0dWtMQ0RxdTVqaWhwTHNsNURxc293dUlIN3NpNXdnNjdtODZyaXc2ckNBSU95V3RPeURpZTJWbU91cHRDRHRqSXpzbFlYdGxaanJvS1RyaXBRZzdLQ1Y2N08wNjZXOElPeWp2T3lXdE91aG5DRHJyTGpzbnFYc25ZUWc2NHVrN0l1Y0lPeVR0T3VMcEM0bg0KTEFvZ0lDYzFMaURycW9Yc2dxd3I2NnFGN0lLc0lPcTRpT3luZ0RvZzdaV2M3SjZRN0phMDY2VzhJTzJTZ095V3RDRHJqNW5zZ3F6cm9ad283SjIwN0o2UUlPMlptT3UyaU95ZGhDRHJzSnZzbFpqc2xyVHNtcFRpaHBMc25iVHNucERycGJ3ZzY0K002NkNrNjdDYjdKV1k3SmEwN0pxVUtTd2c3TFdjN0lhTTdaV2NJSHZycW9Yc2dxeDk2ckNBSUh2cnFvWHNncXg5N1pXMDdJU2NJTzJZbGUyRG5PdWhuQ2pzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjNG9hUzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2t1Snl3S0lDQW5OaTRnN1pHYzZyaXdPaURya0pqc2xyVHNtcFRpaHBMcmo3enNtcFF1Snl3S0lDQW5OeTRnN0tTRUlPcTFyT3loc0RvZzdKdVE2N080N0oyMElPMlZuQ0RzcElUc25iVHJxYlFnN0xhVTdMS2M2NCtFSU91d21PdVRuT3lMbkNEdGxad2c3S1NFNjZHY0xpRHNub1Rzblpqcm9ad2c3S1NFN0oyRUlPdUttT3Vtck95bmdDRHNsWXJyaXBUcmk2UXVJT3VMcUN3ZzdKZXM2NStzSU91c3VPeWUNCnBleWRoQ0R0bFpqcmdwanNuWmdnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXljdk91aG5DRHRsYW5zczVBZzY0MlVJT3F3aE9xeXNPMlZ0T3luaE91THBPdXB0Q0RzcElRZzdJaVk2Nlc4SU95a2hPeWR0T3VLbENEcXNvUHNuWUFnN1ptWTdKaUJMaWNzQ2lBZ0p6Z3VJTzJNbmV5WGhTanJpNlRzbmJUc2xyenJvWnpxdDdncElPdXloTzJLdkRvZzZyS3c2ck84SU8yR3RldXp0T3VLbENCYjdabVY3SjI0WFN3ZzdKaUlMK3lWaE91TGlPeVlwQ0R0akpEcmk2anNuWUFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBzSU91UG1leWVrU0RzbktEcmo0VHJpcFFnVyt5M3FPeUdqRjB2VzN2cmo1bnNucEY5WFM0Z0l1eTNxT3lHakNMcmlwUWc2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNSU95VHNPcXpvQ0FpNjR1cjZyaXd3cmZyajVuc25wRWk3TEtZNjUrOElPeW5uU0RzbFlnZzY2ZWU2NHFVSU95aHNPMlZxY0szNjR1bzY0K0ZJQ0xzdDZqc2hvd2k2NHFVSU9xNGlPeW5nQzRuTEFvZ0lDYzVMaURzDQpuYlRycG9UQ3QreWdoTzJabE91eWlPMll1TUszNjZlSTdJcWs3WUs1N0oyQUlPcTN1T3VNZ091aG5DRHJzN1Rzb2JRdUlPeUNyT3Vlak95ZGhDRHJ0b0RycGJ3ZzY1V1FJT3VMbU95ZGhDRHJ0cG5zbDZ6cmo0UWc3S0tMNjR1a0xpY3NDaUFnSnpFd0xpRHNvSnp0a29nZzdKcXA3SmEwSU95Y29PeW5nRG9nN0o2RjY2Q2w3SmVRSU95VHNPeWR1Q0RxdUxEcmlxWHNoTEVnNjZxRjdJS3NLT3V6Z09xeXZTd2c3S2VBN0tDVkxDRHJrN0hyb1owc0lPMlZ0T3lnbkNEcms3RXA2NHFVSU8yWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhleWR2Q0Rxc0lEcmlxWHNoTEhzbmJRZzY0YVM3Snk4NjYrQTY2R2NJT3lKck95YXRDRHJwNURyb1p3ZzY3Q1U2cjY0N0tlQUlPeVZpdXVLbE91THBDNGc3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyaTZUcnBiZ2c2NCtaN0lLczY2VzhJT3lEaU91aG5DRHJwNHpyazZUc3A0QWc3SldLNjRxVTY0dWtMaWNzQ2wwdWFtOXBiaWduWEc0bktUc0tDbU52Ym5OMA0KSUVWWVFVMVFURVZUSUQwZ2JHOWhaRVY0WVcxd2JHVnpLQ2s3Q2dvdkx5RGlsSURpbElBZzdJcWs3WU9BN0oyOElPcXdnT3lkdE91VG5DRHNvSVRyckxnZzY2R2M2NU9jSUNoMWVDMTNjbWwwYVc1bkxtMWtJT0tBbENEc21JanNtYmdnNnJlYzdMbVpJT3lFdU91MmdDRHNpNXpyZ3BqcnBxenNtS1RxdVl6c3A0QWc3WlNFNjZHczdaU0U3WXE0N0plUUlPMlByTzJWcUNrZzRwU0E0cFNBQ2k4dklGTlVXVXhGWDFKVlRFVlRJREV3N0tTRUlPeWFsT3lWdmV1bmpPeWN2T3Vobk91S2xDRHNtSWpzbWJnZ01YNHpLT3lJbU91UG1lMllsY0szNnJLOTdKYTB3cmZydG9Ec29KWHRtSlVnN1plSTdKcXBJT3k4Z095ZHRPeUtwQ25zblpnZzY0bVk3SldaN0lxazZyQ0FJT3ljb095THBPdVFuT3VMcEM0S0x5OGc3WXlNN0oyODdKMjBJT3lYaHV5Y3ZPdXB0Q2pzaEtUc3VaanJzN2dnNnJXczY3S0U3S0NFSU91VHNTa2c2N21JSU91c3VPeWVrT3lYdENEaWdKUWc3SnFVN0pXOTY2ZU03Snk4NjZHY0lPdVBtZXlla1NobVlXbHMNCkxYTnZablFwTGdwbWRXNWpkR2x2YmlCc2IyRmtSM1ZwWkdVb0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzFrSUQwZ1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNzSUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNkMWRHWTRKeWt1ZEhKcGJTZ3BPd29nSUNBZ2NtVjBkWEp1SUcxa0xteGxibWQwYUNBK0lERXdNQ0EvSUcxa0lEb2dKeWM3Q2lBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnNjZHYzY1T2NJT3lMcE8yTXFDQW83SnFVN0pXOTY2ZU03Snk4NjZHY0lPeW5oTzJXaVNrNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lISmxkSFZ5YmlBbkp6c0tJQ0I5Q24wS1kyOXVjM1FnUjFWSlJFVWdQU0JzYjJGa1IzVnBaR1VvS1RzS0NtWjFibU4wYVc5dUlHbHVjM1J5ZFdOMGFXOXVUV1Z6YzJGblpTZ3BJSHNLSUNCamIyNXpkQ0JtWlhkVGFHOTBJRDBnDQpSVmhCVFZCTVJWTXViV0Z3S0NobGVDa2dQVDRnSjBsdWNIVjBPaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvWlhndWFXNXdkWFFwSUNzZ0oxeHVUM1YwY0hWME9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29aWGd1YzNWbloyVnpkR2x2Ym5NcEtTNXFiMmx1S0NkY2JpY3BPd29nSUhKbGRIVnliaUFvQ2lBZ0lDQW43S2VBNnJpSTY3YUE3WVN3SU91RWlPdUtsQ0RzbDVEc2lxVHNtNUFvVXkweExDRHJzN1RzbFlqdG1venNncXdwN0oyWUlPMlZuT3ExcmV5V3RDQlZXQ0JYY21sMGFXNW5JT3lnaE91c3VPcXdnT3VobkNEc25ienRsWnpyaTZRdUlDY2dLd29nSUNBZ0ordUN0T3F3Z0NCVlNTRHJyTGpxdGF6cnBid2c3WldZNjRLWTdKU3BJT3V6dE91Q3RPdXB0Q3dnN0pXRTY1NllJT3lLcE8yRGdPeWR2Q0RxdDV6c3VabnNsNUFnNjZlZTZyS01JT3VMcE91VHJPeWRnQ0RyaklEc2xZZ2dNK3F3bk91bHZDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNmc21wVHNzcTNyazZUc25ZQWc3SVNjNjZHYw0KSU91c3RPcTBnTzJWbkNEcnM0VHFzSndnNjZ5NDZyV3M2NHVrSU9LQWxDRHNuYlRzb0lRZzY2eTQ2cldzNjZXOElPeXd1T3loc08yVm1PeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ2ZzbTVEcm5wZ2c3SjJZNjYrNDdKbUFJT3VxcU91VG9DRHNvSlhyczdRbzdKMjA2NmFFd3Jmc2lLdnNucERDdCt5aHNPcXh0TUszNjR5QTdJT0JLZXVsdkNEc25LRHNwNER0bFpqcXM2QXNJT3F3Z1NEc29KenNsWWpzbllBZzdKdVE2N080NnJPODY0K0VJT3lFbk91aG5PeVpnT3VQaENEcmk2enJuYnpzbGJ3ZzdaV2M2NHVrTGlBbklDc0tJQ0FnSUNmc29iRHFzYlFnN1pHYzdaaUVLT3lkdE95RGdjSzM3SjIwN1pXWXdyZnNuYlRyZ3JUQ3QreTBpT3F6dk1LMzY2KzQ2NmVNd3JmcnRvRHRoTERDdCtxNWpPeW5nQ0RyazdFcDdKMkFJT3lnbGV5eGhTRHNvSlhyczdUcmk2UWc0b0NVSU91NXZPcXhzT3VDbUNEcmk2VHJwYmdnN0tHdzZyRzA3Snk4NjZHY0lPdXdsT3ErdU95bmdDRHJwNGpybmJ3b0lqWHRtb3dnN0oyMDdJT0INCkl1eWRoQ0FpTmUyYWpDTHJvWndnN0tTRTdKMjA2Nm0wSU95WXBPdUx0U2t1SUNjZ0t3b2dJQ0FnSit5YmtPdXN1T3lYa0NEc2w0YnJpcFFnNnJXczdMSzBJT3lnbGV1enRDanNvSVR0bVpUcnNvanRtTGpDdDFWU1RNSzM2cmlJN0pXaHdyZnNpNXpxc0lRZzY1T3hLZXlaZ0NEdGxiVHFzckFnNjdDcDY3S1Z3cmZzb0lqc3NLZ283SjZzN0lTazdLQ1Z3cmZyckxqc25aanNzcGpDdCt5ZXJPeUxuT3VQaENEcms3RXA2Nlc4SU95bmdPeVd0T3VDdENEcnRwbnNuYlRyaXBRZzZyS0Q3SjJBSU95Z2lPdU1nQ0RxdUlqc3A0QWc0b0NVSU95VmhPdUtsQ0Rxc0pMc25iVHJuYnpyajRRc0lPcTN1T3VmdE91VHIrMlZ0T3VQaENEc2s3RHNwNEFnNjZlSTY1MjhMbHh1SnlBckNpQWdJQ0FuTStxd25DRHNvSnpzbFlqc25ZQWc3SVNjNjZHY0lPeWdrZXEzdk95ZHRDRHJpNnpybmJ6c2xid2c3WldjNjR1a0lPS0FsQ0R0bFpqcmdwanJpcFFnN0p1UTY2eTRJT3Exck95aHNPdWx2Q0RzbktEc3A0RHRsWndnN0xXYzdJYU1JT3VMDQpwT3VUck9xNHNDd2c3WldZNjRLWTY0cVVJT3VzdU95ZXBTRHF0YXpzb2JEcnBid2c3SjZzNnJXczdJU3g3WldjSU91TWdPeVZpQ3dnSnlBckNpQWdJQ0FuNnJlNDY2YXM2ck9nSU95Z2dleVd0T3VQaENEdGxaanJncGpyaXBRZzZyTzg2ckNRN1pXY0lPeWVyT3Exck95RXNUb2c3S1NSNjdPMUlPMlJuTzJZaE95ZGhDRHJqWnpzbHJUcmdyVHFzNkFzSU95Z2xldXp0Q0RzaUp6c2hKenJwYndnN0lLczdKcXA3SjZRNnJDQUlPeVZqT3lWaE95VnZDRHRsYUFnNnJLRDY3YUE3WVN3NjZHY0lPeWVyT3loc095bmdlMlZvQ0Rxc29NdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95ZHRDRHRsYlRxc3JBZzY3Q3A2N0tWN0oyRUlPdUx0T3F6b0NEc25vanNuWVFnNjVXTTY2ZU1JQ0xzbHJUcmxydnFzb3dnN1pXWTY2bTBJT3VMcE95TG5DRHJrSnpyaTZRaTY2VzhJT3lWbnV5RXVPeWFzT3VLbENEcXVJM3NvSlh0bUpVZzdKNnM2cldzN0lTeDdKMkVJTzJWbU91ZHZDRGlnSlFnN0p1UTY2eTQ3SmVRSU8yVnRPcXlzT3l4aGV5ZA0KdENEc2w0YnNuTHpycWJRZzY2ZU02NU9rN0phMElPdTJtZXlkdE95bmdDRHJwNGpybmJ3dUlDY2dLd29nSUNBZ0orMlJuT3E0c01LMzdKcXA3SmEwNjZlTUlPcXpvT3k1bU9xem9DRHNsclRzaUp6c25ZUWc2N0NVNnI2OElPeWdsZXVQaE95ZG1DRHNvSnpzbFlqc25ZUWdNK3F3bkNEcmlwanNsclRyaHBQc3A0QWc2NmVJNjUyOElPS0FsQ0RxdDdqcXNiUWc3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeTJsT3l5bk95ZHRDRHNsWVRyaTRqcm5id2c2cldRN0tDVjdKeTg2NkdjSU91enRPeWR1T3VMcEM0Z0p5QXJDaUFnSUNBbjdKV0U2NTZZSU95WWlPeUxuT3VUcE95ZGdDRHRsWndnN0tTRTdLZWM2NmFzSU95MW5PeUdqQ0RxdFpEc29KWHNuYlFnNjZlTzdLZUE2NmVNSU9xM3VPcXh0Q0R0aHFRbzdaVzA3SnFVN0xLMHdyZnFzcjNzbHJRcDdKMllJT3Exa091enVPeWR0T3luZ0NEc2hvenF0N25zaExIc25aZ2c2cldRNjdPNDdKMjBJT3lWaE91TGlPdUxwQ0RpZ0pRZzdKZXM2NStzSU91c3VPeWVwZXlubk91bXJDRHMNCm5vWHJvS1hzbllBZzY2bVU3SXVjN0tlQUlPdUxxT3ljaE91aG5DRHJpNlRzaTV3ZzdJU2s2ck9FN1pXWTY1MjhMbHh1SnlBckNpQWdJQ0FuNjR1MTdKMkFJT3V3bU91VG5PeUxuQ0JLVTA5T0lPdXdzT3lYdE91bmpDRHN0cHpyb0tYdGxaenJpNlF1SU91bmlPMkJyT3VMcE95YXRNSzM3SVNrNjZxRndyZnN2WlRyazV6dGpwenNpcVFnNnJpSTdLZUFPbHh1SnlBckNpQWdJQ0FuVzNzaWRHVjRkQ0k2SUNMc29KenNsWWdnNjZ5NDZyV3NJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKeVpXRnpiMjRpT2lBaTY2eTA3SmVIN0oyRUlPeVpuQ0Ryc0pUcXY2anJpcFRzcDRBZzdaV2M2cld0N0phMElPMlZuQ0Ryckxqc25xVWlmU3dnTGk0dVhWeHVYRzRuSUNzS0lDQWdJQ2RiN0lxazdZT0E3SjI4SU9xM25PeTVtVjFjYmljZ0t5QlRWRmxNUlY5U1ZVeEZVeUFySUNkY2JseHVKeUFyQ2lBZ0lDQW9SMVZKUkVVZ1B5QW5XK3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJQ2gxZUMxM2NtbDBhVzVuDQpMbTFrS1NEaWdKUWc3SnlFSU9xM25PeTVtZXlkbUNEcXQ3enFzYkRzbVlBZzdKaUk3Sm00SU95TG5PdUNtT3Vtck95WXBDNGc3WXE1N1o2SUlPeVlpT3ladUNEcXQ1enN1WmtvN0lpWTY0K1o3WmlWd3JmcXNyM3NsclRDdCt1MmdPeWdsZTJZbGV5ZGhDRHNuS0RzcDREdGxiVHNsYndnN1pXWTY0cVVJT3lEZ2UyWnFTbnNuWVFnNnJlNDY0eUE2NkdjSU91VXNPdWx0T3F6b0N3ZzdKcVU3Slc5NnJPOElPeWdoT3VzdU95ZHRDRHJpNlRycGJUcnFiUWc3S0NFNjZ5NDdKMkVJT3VVc091bHVPdUxwRjFjYmljZ0t5QkhWVWxFUlNBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW9abVYzVTJodmRDQS9JQ2RiN0pxdzY2YXNJT3VxcWV5R2pPdW1yQ0RzbUlqc2k1d2c0b0NVSU95ZHRDRHRocVRzbllRZzY1U3c2Nlc4SU9xeWcxMWNiaWNnS3lCbVpYZFRhRzkwSUNzZ0oxeHVYRzRuSURvZ0p5Y3BJQ3NLSUNBZ0lDZnNwSURydVlUcmtKRHNuTHpycWJRZ0lrOUxJdXVkdk9xem9PdW5qQ0RyaTdYdGxaanJuYnd1SndvZw0KSUNrN0NuMEtDaTh2SU9LVWdPS1VnQ0RzZzRIc2k1d2c2NHlBNnJpd0lPMkJ0T3Vobk91VG5DRHNoTGpzaFpnZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUNteGxkQ0J3Y205aklEMGdiblZzYkRzZ0lDQWdJQ0FnSUNBZ0x5OGc3WUcwNjZHYzY1T2NJTzJVaE91aG5PeUV1T3lLcEFwc1pYUWdiR2x1WlVKMVppQTlJQ2NuT3lBZ0lDQWdJQ0FnSUM4dklITjBaRzkxZENEc3BJUWc2N0tFN1kyOENteGxkQ0IzWVdsMFpYSWdQU0J1ZFd4c095QWdJQ0FnSUNBZ0x5OGc3WmlFN0o2c0lPMkV0T3lkbUNCN0lISmxjMjlzZG1Vc0lISmxhbVZqZEN3Z2RHbHRaWElnZlFwc1pYUWdjWFZsZFdVZ1BTQlFjbTl0YVhObExuSmxjMjlzZG1Vb0tUc2dMeThnN0pxVTdMS3RJT3luZ2V1Z3JPMlpsQ0FvNjQrWjdJdWMNCklPeWFsT3l5cmV5ZGdDRHNpSnpzaEp6cmpJRHJvWndwQ214bGRDQjBkWEp1Y3lBOUlEQTdDbXhsZENCM1lYSnRaV1JWY0NBOUlHWmhiSE5sT3dwc1pYUWdZM1Z5Y21WdWRFMXZaR1ZzSUQwZ1EweEJWVVJGWDAxUFJFVk1PeUF2THlEc3A0RHF1SWdnN0lTNDdJV1k3SjIwSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NnFvNjQyNElDanNtcFRzc3Ezc25iUWc2NHVrNjZXNElPdXFxT3VOdU95ZGhDRHNwNERzb0pYdGxaanJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU2tLTHk4ZzdJdWM3SjZSSU95TG5DQkRiR0YxWkdVZ1EyOWtaU2hqYkdGMVpHVWdRMHhKS2Vxd2dDRHNrN2dnN0lpWUlPeWVpT3VLbE95bmdDRHNvSkRxc29BZzRvQ1VJT3lYaHV5Y3ZPdXB0Q0F2YUdWaGJIUm82NkdjSU95VmpPdWdwQ0R0bEl6cm42enF0N2pzbmJqc25iUWc3SldJNjRLMDdaV2M2NHVrTGdvdkx5QnVkV3hzUGUyWmxleWR1Q0RzcEpFc0lDZHZheWM5N0lLczdKcXBJT3F3Z091S3BTd2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6MWpiR0YxDQpaR1VnNjZxRjY2QzVJT3lYaHV5ZGpDd0tMeThnSjJOc1lYVmtaUzFzYjJkdmRYUW5QV05zWVhWa1pldUtsQ0Rzbm9qc3A0RHJwNHdnNjZHYzZyZTQ3SjI0SU95RXVPeUZtQ0RycDR6cm80d2dLTzJFdENEc2k2VHRqS2dnN0l1Y0lPcXdrT3luZ0N3ZzdJU3g2ck8xSU8yRXRPeWR0Q0RzbUtUcnFiUWc3SjZRNjQrWklPMlZ0T3lnbkNrS2JHVjBJR05zWVhWa1pWTjBZWFIxY3lBOUlHNTFiR3c3Q2k4dklPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBSU9LQWxDQkRURW5xc0lBZzY0SzA2NHFVSU95WWdleVd0Q0RzbmJqc3BwMGc3SmlrNjZXWTY2VzhJT3lDck91ZWpPeWR0Q0RzbFl6c2xZVHJrNlRzbllRZzdKV0k2NEswNjZHY0lPdXdsT3Erdk91THBDNEtMeThnS0dOc1lYVmtaU0F0TFhabGNuTnBiMjdzbllBZzY2R2M2cmU0N0oyNElPeVhodXlkdE91UGhDRHNoTEhxczdYdGxiVHNoSndnN0l1YzY0K1pJT3lna09xeWdPeWN2T3Vobk91S2xDRHJxcnNnN0o2aDZyT2dMQ0RzaTZUc29Kd2c3WVMwN0plUQ0KN0lTYzY2ZU1JT3VUbk91ZnJPdUNuT3VMcENrS0x5OGdJdXVuak91ampDTHJwNHpzbmJRZzdKV0U2NHVJNjUyOElDTHRsWndnNjdLSTY0K0VJT3Vobk9xM3VPeWR1Q0RzbFlnZzdaV29JdXVQaENEcXNKbnNuWUFnNnJLOTY2R2M2NkdjSU95ZW9lMmVpT3V2Z091aG5DRHNwSkhycHIwZzdaR2M3WmlFN0oyRUlPeVR0T3VMcEFwamIyNXpkQ0JNVDBkSlRsOUhWVWxFUlNBOUlDZnRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjQ3SjIwSU8yVmhPeWFsTzJWdE95YWxDanNsWWdnNjVDUTZyR3c2NEtZSU91bmpPdWpqQ2tnNG9DVUlGdnduNStnSU8yQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJnZzdaV0U3SnFVWFNEcnNvVHRpcnpzbllRZzY0aUU2NlcwNjZtMElPdWhuT3EzdU95ZHVDRHNzTDNzbllRZzdKZTA3SmEwNjVPYzY2Q2s3SnFVTGljN0NpOHZJT3lMcE95NG9lMlZuQ0RyckxqcXRhenJrNlE2SUNKR1lXbHNaV1FnZEc4Z1lYVjBhR1Z1ZEdsallYUmxPaUJQUVhWMGFDQnpaWE56YVc5dUlHVjRjR2x5WldRZ1lXNWsNCklHTnZkV3hrSUc1dmRDQmlaU0J5WldaeVpYTm9aV1FpS091bmpPdWpqQ2tzQ2k4dklDSk9iM1FnYkc5bloyVmtJR2x1SU1LM0lGQnNaV0Z6WlNCeWRXNGdMMnh2WjJsdUlpanJyN2pyb1p6cXQ3anNuYmdwSU9LQWxDRHJrWmdnNjR1a0lPeWVvZTJlaU9xeWpDRHJoSlB0bm96cmk2UUtablZ1WTNScGIyNGdhWE5CZFhSb1JYSnliM0lvY3lrZ2V3b2dJSEpsZEhWeWJpQXZZWFYwYUdWdWRHbGpZWFI4YjJGMWRHaDhZWEJwSUd0bGVYeHNiMmNnUDJsdWZHeHZaMmRsWkh4elpYTnphVzl1SUdWNGNHbHlaV1F2YVM1MFpYTjBLRk4wY21sdVp5aHpLU2s3Q24wS0x5OGc2NkdjNnJlNDdKMjQ2NUNjSU9xemhPeWdsU0R0bVpYc25iZ2c0b0NVSUVOTVNlcXdnQ0IrTHk1amJHRjFaR1V1YW5OdmJ1eVhrQ0RxdUxEcm9aM3RsWmpyaXBRZ2IyRjFkR2hCWTJOdmRXNTBMbVZ0WVdsc1FXUmtjbVZ6Yyt1bHZDRHNuYjNzbHJRS0x5OGdMMmhsWVd4MGFPdWhuQ0RyaGJqc3RwenRsWnpyaTZRZ0tPMlVqT3Vmck9xM3VPeWR1T3lkDQp0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFFnN0tTUjdKMjQ3S2VBSWlEdGtaenNpNXdnNG9DVUlPcXp0ZXlhcVNCUVEreVhrT3lFbkNEcmdxanNuWmdnNnJPRTdLQ1ZJT3lZcE95Q3JPeWFxU0Ryc0tuc3A0QXBMZ292THlEdGpJenNuYnpzbmJRZzdZRzBJT3lJbUNEc25vanNsclFvN1pTRTY2R2M3S0NkN1lxNElPeWR0T3VncFNEdGo2enRsYWdwSURNdzdMU0lJT3k2a095TG5DNGc3SjZzNjZHYzZyZTQ3SjI0N1pXWTY2bTBJRU5NU2Vxd2dDRHRqSXpzbmJ6c25ZUWc2ckN4N0l1ZzdaV1k2NitBNjZHY0lPeWVrT3VQbVNEcnNKanNtSUhya0p6cmk2UXVDbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93cG1kVzVqZEdsdmJpQmpiR0YxWkdWQlkyTnZkVzUwS0NrZ2V3b2dJR2xtSUNoRVlYUmxMbTV2ZHlncElDMGdZV05qYjNWdWRFTmhZMmhsTG1GMElEd2dNekF3TURBcElISmxkSFZ5YmlCaFkyTnZkVzUwUTJGamFHVXVaVzFoYVd3Nw0KQ2lBZ2JHVjBJR1Z0WVdsc0lEMGdiblZzYkRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2FpQTlJRXBUVDA0dWNHRnljMlVvWm5NdWNtVmhaRVpwYkdWVGVXNWpLSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDY3VZMnhoZFdSbExtcHpiMjRuS1N3Z0ozVjBaamduS1NrN0NpQWdJQ0JsYldGcGJDQTlJQ2hxSUNZbUlHb3ViMkYxZEdoQlkyTnZkVzUwSUNZbUlHb3ViMkYxZEdoQlkyTnZkVzUwTG1WdFlXbHNRV1JrY21WemN5a2dmSHdnYm5Wc2JEc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyb1p6cXQ3anNuYmdnN0oyMDY2Q2xJT3lYaHV5ZGpDRHJrN0VnNG9DVUlHNTFiR3dnN0p5ZzdLZUFJQ292SUgwS0lDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUJFWVhSbExtNXZkeWdwTENCbGJXRnBiQ0I5T3dvZ0lISmxkSFZ5YmlCbGJXRnBiRHNLZlFwbWRXNWpkR2x2YmlCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BJSHNLSUNCamIyNXpkQ0J3Y205aVpTQTlJSE53WVhkdUtDZGoNCmJHRjFaR1VuTENCYkp5MHRkbVZ5YzJsdmJpZGRMQ0I3SUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUVOTVFWVkVSVjlGVGxZZ2ZTazdDaUFnYkdWMElHOTFkQ0E5SUNjbk93b2dJSEJ5YjJKbExuTjBaRzkxZEM1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0lHOTFkQ0FyUFNCa0xuUnZVM1J5YVc1bktDazdJSDBwT3dvZ0lIQnliMkpsTG05dUtDZGxjbkp2Y2ljc0lDZ3BJRDArSUhzZ1kyeGhkV1JsVTNSaGRIVnpJRDBnSjJOc1lYVmtaUzF0YVhOemFXNW5KenNnZlNrN0NpQWdjSEp2WW1VdWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNoamIyUmxJRDA5UFNBd0lDWW1JQzljWkN0Y0xseGtLeTh1ZEdWemRDaHZkWFFwS1NBL0lDZHZheWNnT2lBblkyeGhkV1JsTFcxcGMzTnBibWNuT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSUVOc1lYVmtaU0JEYjJSbElPeWdrT3F5Z0RvZ0p5QXJJR05zWVhWa1pWTjBZWFIxY3lBcklDaHZkWFFnDQpQeUFuSUNnbklDc2diM1YwTG5SeWFXMG9LU0FySUNjcEp5QTZJQ2NuS1NrN0NpQWdmU2s3Q24wS0x5OGc3TEtZNjZhc0lPMlloTzJacVNEaWdKUWdMMmhsWVd4MGFPdWhuQ0RyaGJqc3RwenRsYlFnSXV5Z2xldW5rQ0R0Z2JUcm9aenJrNXpxc0lBZzY0dTE3WmFJNjRxVTdLZUFJaURyc0pic2w1RHNoSndnN1ptVjdKMjQ3WldnSU95SW1DRHNub2pxc293ZzdaV2M2NHVrQ21OdmJuTjBJSE4wWVhSeklEMGdleUJ6WlhKMlpXUTZJREFzSUd4aGMzUkJkRG9nSnljc0lHeGhjM1JVWlhoME9pQW5KeXdnYkdGemRGTmxZem9nSnljZ2ZUc0tDaTh2SU9LVWdPS1VnQ0R0bEl6cm42enF0N2pzbmJnZzdJT2Q3S0cwSU9xd2tPeW5nQ2pzaTZ6c25xWHJzSlhyajVrcElPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0Fvdkx5RHRsSXpybjZ6cXQ3anNuYmpzbmJRZw0KNjVhZ0lPeWVpT3VLbENEcmo1bnNsWWdnWTI5a1pTNTBjK3F3Z0NBMTdMU0k2NmVJNjR1a0lGQlBVMVFnTDJobFlYSjBZbVZoZE91bHZDRHJzN1RyZ3Jqcmk2UXVDaTh2SU8yVm5DRHJzb2pzbmJUcm5ienJqNFFnNjdDYjdKMkFJT3VTcENBek1PeTBpT3F3aENEcmdZcnF1TERycWJRZzdaU002NStzNnJlNDdKMjRLT3VZa091S2xDRHRsTHpxdDdqcnA0Z3A3SjIwSU91THErMmVqQ0Rxc29NZzRvQ1VJTzJCdE91aG5PdVRuT3E1ak95bmdDRHJqYkRycHF6cXM2QWc2ckNaN0oyMElPcTZ2T3luaE91THBDNEtMeThnN0pXRTdLZUJJTzJWbkNEcnNvanJqNFFnNjZxN0lPdXdtK3lWbU95Y3ZPdXB0Q2pyaTZUcnBxenJwNHdnNjZpODdLQ0FJT3k4b0NEc2c0SHRnNXdzSU95ZWtPdVBtZXlMbk95ZWtTRHJrN0VwSU9xemhPeUdqU0RyaklEcXVMRHRsWnpyaTZRdUNtTnZibk4wSUVoRlFWSlVRa1ZCVkY5RVJVRkVYMDFUSUQwZ016QXdNREE3Q214bGRDQnNZWE4wUW1WaGRDQTlJREE3Q25ObGRFbHVkR1Z5ZG1Gc0tDZ3ANCklEMCtJSHNLSUNCcFppQW9iR0Z6ZEVKbFlYUWdKaVlnUkdGMFpTNXViM2NvS1NBdElHeGhjM1JDWldGMElENGdTRVZCVWxSQ1JVRlVYMFJGUVVSZlRWTXBJSHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0bEl6cm42enF0N2pzbmJnZzdJdXM3SjZsNjdDVjY0K1pJT3VCaXVxNWdDRGlnSlFnN1pTODZyZTQ2NmVJTCsyVWpPdWZyT3EzdU95ZHVPeWR0Q0RyaTZ2dG5vd2c2cktEN0p5ODY2R2NJT3V6dE9xem9DRHFzSm5zbmJRZzZycTg3S2VSNjR1STY0dWtMaWNwT3dvZ0lDQWdjSEp2WTJWemN5NWxlR2wwS0RBcE95QXZMeUJsZUdsMElPMlZ1T3VUcE91ZnJPcXdnQ0JyYVd4c1VISnZZK3ljdk91aG5DQmpiR0YxWkdVZzdZcTQ2NmFzNjZXOElPeWdsZXVtck8yVm5PdUxwQW9nSUgwS2ZTd2dOVEF3TUNrN0Nnb3ZMeURyb1p6cXQ3anNuYmdnVlZKTTdKMkVJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSUFvNjdPMDdZYTFJT3l3dlNucm9ad2c3SmVzNjRxVUlFSlNUMWRUUlZJZzdaVzQ2NU9rDQo2NStzSU95S3BPMkJyT3VtdmUyS3VPdWx2Q0RycDR6cms2RHJpNlF1Q2k4dklHTnNZWFZrWlNCRFRFbnJpcFFnUWxKUFYxTkZVaUR0bVpqcXNyM3JzNERzaUpqcnBid2c3S0cwN0tTUjdaVzBJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNwNEhzb0pFZzdKZTA3S2VBSU95Vml1cXpvQ0RzbmJRZzdJcWs3WUdzNjZhOTdZcTQ3SmVRSUdGMWRHaHZjbWw2WlNCVlVrenNuWVFnNjRTWTZyaTA2NHVrS095THBPeTRvU0F5TURJMkxUQTNLUzRLTHk4Z2JXOWtaVDBuYzNkcGRHTm9KeWpxczRUc29KVWc3S0NFN1ptWUtTRGlocElnN0lxNTdKMjRJTzJabE91cHRPeWRoQ0Rxc2JEc3VaanNwNEFnN0pXSzZyT2dJQ29xNnJPRTdLQ1ZJT3lFb08yRG5TRHRtWlRycWJUc25MenJvWndnNjdDVTY2R2NLaW9nNjdPMDY0SzQ2NHVrTGdvdkx5QWdJT3Vobk9xM3VPeWR1T3VRbkNEc2c0SHRnNXpycWJRZ1lYVjBhRzl5YVhwbDZyQ0FJT3lLdWV5ZHVDRHRtWlRycWJUc25MenJvWndnNnJDQTZyT2dJSE5sYkdWamRFRmpZMjkxYm5ROQ0KZEhKMVpjSzNjSEp2YlhCMFBYTmxiR1ZqZEY5aFkyTnZkVzUwNjZHYzY0K0VJT3VxdXlEcm1xdnNuTHpycjREcm9ad283SXVrN0xpaEtTd0tMeThnSUNEdGxad2c3WU90SU95VmlPeVhrT3lFbkNCamJHRjFaR1V1WVdrdmJHOW5iM1YwUDNKbGRIVnlibFJ2UFR4MWNtd3RaVzVqYjJSbFpDQXZiMkYxZEdndllYVjBhRzl5YVhwbFAxRlZSVkpaS095RGdldU1nT3F5dmV1aG5Days2NkdjSU95ZWgrdUtsT3VMcERvS0x5OGdJQ0Ryb1p6cXQ3anNsWVRzbTRNbzdJUzQ3SVdZSU95bmdPeWJnQ2tnNG9hU0lHeHZaMmx1UDNObGJHVmpkRUZqWTI5MWJuUTlkSEoxWlNqcXM0VHNvSlVnN0lTZzdZT2RLZXVobkNEc25wRHJqNWtnN0xLMDdKMjA2NHVkS095THBPeTRvVG9nNjR1bzdKMjhJTzJEclNrdUlPeUt1ZXlkdUNEdG1aVHJxYlFnN1pXWTY0dW9DaTh2SUNBZ1crcXpoT3lnbFNEc29JVHRtWmhkSU91eWhPMkt2T3lkdENEdGxaanJpcFFnN0oyODZyTzhJT3F3bWV5ZGdDRHFzckRxczd3ZzRvQ1VJT3VMcE91bmpDRHMNCm1yRHJwcXpxc0lBZzZyT243SjZsSU9xM3VDRHRtWlRycWJUc25MenJvWndnNjdPMDY0SzQ2NHVrTGdvdkx5QWdJQ2pydG9Ec25wSHNtcWs2SU91NGpPdWR2T3lhc095Z2dPeWRtQ0JqYkdGMVpHVXVZV2tnN0p1NUlPdWhuT3EzdU95ZHVPdVBoQ0R0a29EcnByd2c0b0NVSU9xemhPeWdsU0Rzb0lUdG1aZ2c3SjJZNjQrRTdKbUFJT3V3cWUyV3BleWR0Q0Rxc0puc2xZUWc3SWlZN0pxcExpa0tMeThnYlc5a1pUMG5ibTl5YldGc0p5anJwNHpybzR3ZzdKNnM2NkdjNnJlNDdKMjRLU0RpaHBJZzY2R2M2cmU0N0pXRTdKdURJT3lYaHV5ZHRDRHF0N2pyZzZVZzdKZXc2NHVrS091TWdPcXduQ0Rxc0puc25ZQWc2ck9FN0tDVjdKMjA2NTI4SU95RXVPeUZtQ0RzbktEc3A0RHFzSUFnNjdtZzY2YUVLUzRLWm5WdVkzUnBiMjRnZDNKcGRHVkNjbTkzYzJWeVNHRnVaR3hsY2lodGIyUmxLU0I3Q2lBZ1kyOXVjM1FnYkc5bmIzVjBJRDBnYlc5a1pTQTlQVDBnSjNOM2FYUmphQ2M3Q2lBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoDQpkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNLSUNBZ0lHTnZibk4wSUdOdFpDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0WW5KdmQzTmxjaTBuSUNzZ2JXOWtaU0FySUNjdVkyMWtKeWs3Q2lBZ0lDQmpiMjV6ZENCd2N5QTlJR3h2WjI5MWRBb2dJQ0FnSUNBL0lDSWtkVDBrWlc1Mk9rTkNYMVZTVERzZ0pHazlKSFV1U1c1a1pYaFBaaWduYjJGMWRHZ3ZZWFYwYUc5eWFYcGxKeWs3SUdsbUtDUnBJQzFuWlNBd0tYc2dKSEpsYkQwbkx5Y3JKSFV1VTNWaWMzUnlhVzVuS0NScEtUc2dKR1Z1WXoxYlUzbHpkR1Z0TGxWeWFWMDZPa1Z6WTJGd1pVUmhkR0ZUZEhKcGJtY29KSEpsYkNrN0lGTjBZWEowTFZCeWIyTmxjM01nS0Nkb2RIUndjem92TDJOc1lYVmtaUzVoYVM5c2IyZHZkWFEvY21WMGRYSnVWRzg5Snlza1pXNWpLU0I5SUdWc2MyVWdleUJUZEdGeWRDMVFjbTlqWlhOeklDUjFJSDBpQ2lBZ0lDQWdJRG9nSjFOMFlYSjBMVkJ5YjJObGMzTWdKR1Z1ZGpwRA0KUWw5VlVrd25Pd29nSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloamJXUXNJQ2RBWldOb2J5QnZabVpjY2x4dWMyVjBJQ0pEUWw5VlVrdzlKWDR4SWx4eVhHNXdiM2RsY25Ob1pXeHNJQzFPYjFCeWIyWnBiR1VnTFVWNFpXTjFkR2x2YmxCdmJHbGplU0JDZVhCaGMzTWdMVU52YlcxaGJtUWdJaWNnS3lCd2N5QXJJQ2NpWEhKY2JpY3BPd29nSUNBZ2NtVjBkWEp1SUdOdFpEc0tJQ0I5Q2lBZ1kyOXVjM1FnYzJnZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV0p5YjNkelpYSXRKeUFySUcxdlpHVWdLeUFuTG5Ob0p5azdDaUFnWTI5dWMzUWdibTlrWlVKcGJpQTlJSEJ5YjJObGMzTXVaWGhsWTFCaGRHZzdJQzh2SU95Z2hDQlBVK3lYa0NCdWIyUmxJT3llaU95ZGpDanJpNlRycHF6cXNJQWdibTlrWmV1aG5DRHJqNDRwTGlEcnM0RHRtWmdnN0l1azdZeW9JT3lMbkNEc201RHJzN2dnVlZKTUlPcTN1T3VNZ091aG5DRHNsN0RyaTZRb1ptRnBiQzF6YjJaMEtTNEsNCklDQmpiMjV6ZENCaWIyUjVJRDBnYkc5bmIzVjBDaUFnSUNBL0lDY2pJUzlpYVc0dmMyaGNiaWNnS3dvZ0lDQWdJQ0FuVlQwa0tDSW5JQ3NnYm05a1pVSnBiaUFySUNjaUlDMWxJRnduWTI5dWMzUWdkVDF3Y205alpYTnpMbUZ5WjNaYk1WMDdZMjl1YzNRZ2FUMTFMbWx1WkdWNFQyWW9JbTloZFhSb0wyRjFkR2h2Y21sNlpTSXBPM0J5YjJObGMzTXVjM1JrYjNWMExuZHlhWFJsS0drOE1EOTFPaUpvZEhSd2N6b3ZMMk5zWVhWa1pTNWhhUzlzYjJkdmRYUS9jbVYwZFhKdVZHODlJaXRsYm1OdlpHVlZVa2xEYjIxd2IyNWxiblFvSWk4aUszVXVjMnhwWTJVb2FTa3BLVnduSUNJa01TSWdNajR2WkdWMkwyNTFiR3dwWEc0bklDc0tJQ0FnSUNBZ0oyOXdaVzRnSWlSN1ZUb3RKREY5SWx4dUp3b2dJQ0FnT2lBbkl5RXZZbWx1TDNOb1hHNXZjR1Z1SUNJa01TSmNiaWM3Q2lBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloemFDd2dZbTlrZVNrN0NpQWdabk11WTJodGIyUlRlVzVqS0hOb0xDQXdiemMxTlNrN0NpQWdjbVYwDQpkWEp1SUhOb093cDlDZ292THlEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJTzJVaE91aG5PeUV1T3lLcENBb1kyeGhkV1JsSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFTa2c0b0NVSUM5dmNHVnVMV3h2WjJsdTdKMjBJT3lEbmV5RXNjSzM2clNBNjZhc0xnb3ZMeURydUl6cm5ienNtckRzb0lEcXNJQWdiRzlqWVd4b2IzTjA2NkdjSU9xeXNPcXp2T3VsdkNEcnM3VHJnclRzcElRZzY1V002cm1NN0tlQUlPeUlxT3lXdE95RW5DRHJqSURxdUxEdGxaanJpNlRxc0lBc0lPeVpoT3Vqak91UW1PdXB0Q0RzaXFUc2lxVHJvWndnNjRHZDY0S2M2NHVrTGdwc1pYUWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVM1JoY25SbFpFRjBJRDBnTURzZ0x5OGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVnN0l1YzZyQ0JJT0tBbENEc25xenRnYlRycHEzc25iUWdKK3llck95TG5PdVBoQ2ZzbmJqcw0KcDRBZ0oreWVrT3VQbWV5WmhPdWpqQ0RzaTZUdGpLZ243SjI0N0tlQUlPcTFyT3UyaE8yVm5PdUxwQXBtZFc1amRHbHZiaUJyYVd4c1RHOW5hVzVRY205aktDa2dld29nSUdsbUlDaHNiMmRwYmxCeWIyTlVhVzFsY2lrZ2V5QmpiR1ZoY2xScGJXVnZkWFFvYkc5bmFXNVFjbTlqVkdsdFpYSXBPeUJzYjJkcGJsQnliMk5VYVcxbGNpQTlJRzUxYkd3N0lIMEtJQ0JwWmlBb0lXeHZaMmx1VUhKdll5a2djbVYwZFhKdU93b2dJR052Ym5OMElIQWdQU0JzYjJkcGJsQnliMk03Q2lBZ2JHOW5hVzVRY205aklEMGdiblZzYkRzS0lDQjBjbmtnZXdvZ0lDQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZDNhVzR6TWljcElIc0tJQ0FnSUNBZ2MzQmhkMjVUZVc1aktDZDBZWE5yYTJsc2JDY3NJRnNuTDFCSlJDY3NJRk4wY21sdVp5aHdMbkJwWkNrc0lDY3ZWQ2NzSUNjdlJpZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lIUnllU0I3SUhCeWIyTmwNCmMzTXVhMmxzYkNndGNDNXdhV1FzSUNkVFNVZFVSVkpOSnlrN0lIMGdZMkYwWTJnZ0tGOWxNaWtnZXlCd0xtdHBiR3dvS1RzZ2ZRb2dJQ0FnZlFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdXN0T3lMbkNBcUx5QjlDbjBLQ21aMWJtTjBhVzl1SUd0cGJHeFFjbTlqS0NrZ2V3b2dJR2xtSUNod2NtOWpLU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ0lDQWdJQzh2SUhOb1pXeHNPblJ5ZFdYcm9ad2c2NTJFN0p1TTdJU2NJSEJ5YjJQc25ZQWdZMjFrSU9xN2pldU5zT3E0c0NEaWdKUWdMMVRyb1p3ZzdZcTQ2NmFzN0tlNElPeWp2ZXlYck95VnZDRHNwNFRzcDV3Z1kyeGhkV1JsNnJDQUlPcXpvT3lWaE91aG5DRHNsWWdnNjRLbzY0cVU2NHVrQ2lBZ0lDQWdJQ0FnTHk4Z0tPcXpvT3lWaENCamJHRjFaR1hxc0lBZzdJU2s3TG1ZSU8yTWpPeWR2T3lkaENEcnJMenFzNkFnN0o2STdKeTg2Nm0wSU8yQnRPdWhuT3VUDQpuQ0RzbGJFZzdKZUY2NDJ3N0oyMDdZcTQ2ckNBSUNMc2dxenNtcWtnN0tTUkl1eWN2T3VobkNEcnA0bnRucGdwQ2lBZ0lDQWdJQ0FnYzNCaGQyNVRlVzVqS0NkMFlYTnJhMmxzYkNjc0lGc25MMUJKUkNjc0lGTjBjbWx1Wnlod2NtOWpMbkJwWkNrc0lDY3ZWQ2NzSUNjdlJpZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0F2THlCdFlXTlBVeS9ycHF6cmlJWHNpcVE2SUhOb1pXeHNPblJ5ZFdYcm5id2djSEp2WSt5ZHRDQnphQ0RxdTQzcmpiRHF1TERzbmJ3ZzdJaVlJT3llaU95ZGpDRGlnSlFnYzNSaGNuUlFjbTlqN0oyWUlHUmxkR0ZqYUdWazY2R2NJT3Vuak91VG9Bb2dJQ0FnSUNBZ0lDOHZJTzJVaE91aG5PeUV1T3lLcENEcXQ3anJvN2tvTFhCcFpDbnNuWVFnN1lhMTdLZTQ2NkdjSU95Z2xldW1yTzJWbk91THBDQW9kR0Z6YTJ0cGJHd2dMMVFnNjR5QTdKMlJLUW9nSUNBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0hKdg0KWXk1d2FXUXNJQ2RUU1VkVVJWSk5KeWs3SUgwZ1kyRjBZMmdnS0Y5bE1pa2dleUJ3Y205akxtdHBiR3dvS1RzZ2ZRb2dJQ0FnSUNCOUNpQWdJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFvZ0lIMEtJQ0J3Y205aklEMGdiblZzYkRzS0lDQjNZWEp0WldSVmNDQTlJR1poYkhObE93b2dJR2xtSUNoM1lXbDBaWElwSUhzZ1kyeGxZWEpVYVcxbGIzVjBLSGRoYVhSbGNpNTBhVzFsY2lrN0lIZGhhWFJsY2k1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0NmdGdiVHJvWnpyazV3ZzdJUzQ3SVdZN0oyMElPeWloZXVqak91UWtPeVd0T3lhbEM0bktTazdJSGRoYVhSbGNpQTlJRzUxYkd3N0lIMEtmUW9LWm5WdVkzUnBiMjRnYzNSaGNuUlFjbTlqS0NrZ2V3b2dJR3RwYkd4UWNtOWpLQ2s3Q2lBZ2JHbHVaVUoxWmlBOUlDY25Pd29nSUhSMWNtNXpJRDBnTURzS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RzaTV6cmo1a2c3S1NSNG9DbUlDanINCnFxanJqYmc2SUNjZ0t5QmpkWEp5Wlc1MFRXOWtaV3dnS3lBbktTY3BPd29nSUdOdmJuTjBJSFJvYVhOUWNtOWpJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuTFhBbkxDQW5MUzF0YjJSbGJDY3NJR04xY25KbGJuUk5iMlJsYkN3Z0p5MHRhVzV3ZFhRdFptOXliV0YwSnl3Z0ozTjBjbVZoYlMxcWMyOXVKeXdnSnkwdGIzVjBjSFYwTFdadmNtMWhkQ2NzSUNkemRISmxZVzB0YW5OdmJpY3NJQ2N0TFhabGNtSnZjMlVuWFN3Z2V3b2dJQ0FnYzJobGJHdzZJSFJ5ZFdVc0lHTjNaRG9nUlUxUVZGbGZRMWRFTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzQ2lBZ0lDQmtaWFJoWTJobFpEb2djSEp2WTJWemN5NXdiR0YwWm05eWJTQWhQVDBnSjNkcGJqTXlKeXdnTHk4Z1VFOVRTVmc2SU95ZWtPcTRzQ0R0bElUcm9aenNoTGpzaXFRZzZyZTQ2Nk81SU95RG5leUVzU0RpZ0pRZ2EybHNiRkJ5YjJQc25iUWc2cmU0NjZPNTdLZTRJT3lnbGV1bXJPMlZvQ0RzaUpnZzdKNkk2cktNQ2lBZ2ZTazdDaUFnY0hKdll5QTlJSFJvDQphWE5RY205ak93b2dJSEJ5YjJNdWMzUmtiM1YwTG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzS0lDQWdJR3hwYm1WQ2RXWWdLejBnWkM1MGIxTjBjbWx1WnlnbmRYUm1PQ2NwT3dvZ0lDQWdiR1YwSUdsa2VEc0tJQ0FnSUhkb2FXeGxJQ2dvYVdSNElEMGdiR2x1WlVKMVppNXBibVJsZUU5bUtDZGNiaWNwS1NBaFBUMGdMVEVwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlHeHBibVZDZFdZdWMyeHBZMlVvTUN3Z2FXUjRLUzUwY21sdEtDazdDaUFnSUNBZ0lHeHBibVZDZFdZZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0dsa2VDQXJJREVwT3dvZ0lDQWdJQ0JwWmlBb0lXeHBibVVwSUdOdmJuUnBiblZsT3dvZ0lDQWdJQ0JzWlhRZ1pYWWdQU0J1ZFd4c093b2dJQ0FnSUNCMGNua2dleUJsZGlBOUlFcFRUMDR1Y0dGeWMyVW9iR2x1WlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUdOdmJuUnBiblZsT3lCOUNpQWdJQ0FnSUdsbUlDaGxkaUFtSmlCbGRpNTBlWEJsSUQwOVBTQW5jbVZ6ZFd4MEp5QW1KaUIzWVdsMA0KWlhJcElIc0tJQ0FnSUNBZ0lDQmpiMjV6ZENCM0lEMGdkMkZwZEdWeU93b2dJQ0FnSUNBZ0lIZGhhWFJsY2lBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnWTJ4bFlYSlVhVzFsYjNWMEtIY3VkR2x0WlhJcE93b2dJQ0FnSUNBZ0lHbG1JQ2hsZGk1cGMxOWxjbkp2Y2lrZ2V3b2dJQ0FnSUNBZ0lDQWdZMjl1YzNRZ2NtRjNJRDBnVTNSeWFXNW5LR1YyTG5KbGMzVnNkQ0I4ZkNCbGRpNXpkV0owZVhCbElIeDhJQ2NuS1M1emJHbGpaU2d3TENBeU1EQXBPd29nSUNBZ0lDQWdJQ0FnYVdZZ0tHbHpRWFYwYUVWeWNtOXlLSEpoZHlrcElIc0tJQ0FnSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMk5zWVhWa1pTMXNiMmR2ZFhRbk95QXZMeUF2YUdWaGJIUm82NkdjSU8yVWpPdWZyT3EzdU95ZHVPeVhrQ0RzbFl6cnByd2c0b2FTSU91eWhPMkt2T3lkdENCYjY2R2M2cmU0N0oyNElPMlZoT3lhbEYzcm9ad2c2N0NVNjRDY0NpQWdJQ0FnSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHINCm9aenJrNXdnNjZHYzZyZTQ3SjI0SU91bmpPdWpqQ0Rxc0pEc3A0QTZKeXdnY21GM0tUc0tJQ0FnSUNBZ0lDQWdJQ0FnZHk1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0V4UFIwbE9YMGRWU1VSRktTazdDaUFnSUNBZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJQ0FnSUNCM0xuSmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNtS1RycFpnNklDY2dLeUJ5WVhjcEtUc0tJQ0FnSUNBZ0lDQWdJSDBLSUNBZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMjlySnpzZ0x5OGc3SVN4NnJPMUlEMGc3SVNrN0xtWXdyZnJvWnpxdDdqc25iZ2c2NHVrSU95Z2xleURnU0RpZ0pRZzdKYTA2NWFrSUhCeWIySnNaVzNzbmJUcms2QWc3WlcwN0tDY0lDanNucXpyb1p6cXQ3anNuYmd2N0o2czdJU2s3TG1ZSU91enRlcTNnQ2tLSUNBZ0lDQWdJQ0FnSUhjdWNtVnpiMngyWlNoVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElDY25LU2s3Q2lBZ0lDQWdJQ0FnDQpmUW9nSUNBZ0lDQjlDaUFnSUNCOUNpQWdmU2s3Q2lBZ2NISnZZeTV6ZEdSbGNuSXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdld29nSUNBZ1kyOXVjM1FnY3lBOUlHUXVkRzlUZEhKcGJtY29KM1YwWmpnbktTNTBjbWx0S0NrN0NpQWdJQ0JwWmlBb2N5QW1KaUFoY3k1cGJtTnNkV1JsY3lnblJHVndjbVZqWVhScGIyNVhZWEp1YVc1bkp5a3BJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCamJHRjFaR1VnYzNSa1pYSnlPaWNzSUhNdWMyeHBZMlVvTUN3Z01qQXdLU2s3Q2lBZ2ZTazdDaUFnY0hKdll5NXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdMeThnN0oyMDY2KzRJT3lEaUNEc2hManNoWmpzbkx6cm9ad2c2cldRN0xLMDY1Q2NJT3VTcENEc21Kc2c3SVM0N0lXWTdKMjBJT3VMcSsyZWpDRHFzYkRycWJRZzY2eTA3SXVjSUNqcnFxanJqYmdnN0tDRTdabVlJT3lMbkNEc2c0Z2c3SVM0N0lXWTdKMkVJT3lqdmV5ZHRPeW5nQ0RzbFlycXNvd3BDaUFnSUNCcFppQW9jSEp2WXlBaA0KUFQwZ2RHaHBjMUJ5YjJNcElISmxkSFZ5YmpzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzdJUzQ3SVdZSU95aWhldWpqQ0FvWTI5a1pTQW5JQ3NnWTI5a1pTQXJJQ2NwSU9LQWxDRHJpNlRzbll3ZzdKcVU3TEt0SU91VmpDRHJpNlRzaTV3ZzdJdWM2NCtaN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnYTJsc2JGQnliMk1vS1RzS0lDQjlLVHNLZlFvS1puVnVZM1JwYjI0Z2MyVnVaRlIxY200b2RHVjRkQ2tnZXdvZ0lISmxkSFZ5YmlCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpTd2djbVZxWldOMEtTQTlQaUI3Q2lBZ0lDQnBaaUFvSVhCeWIyTXBJSEpsZEhWeWJpQnlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lYaHV5V3RPeWFsQzRuS1NrN0NpQWdJQ0JwWmlBb2QyRnBkR1Z5S1NCeVpYUjFjbTRnY21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN0pXZTdJU2dJT3lhbE95eXJleWR0Q0RzcDRUdGxva2c3S1NSN0oyMDdKZVENCjdKcVVMaWNwS1RzS0lDQWdJR052Ym5OMElIUnBiV1Z5SUQwZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRoTFFnN0l1YzZyQ0VJT3kwaU9xenZDRGlnSlFnN0lTNDdJV1k3SjJFSU95ZXJPeUxuT3lla2UyVnFldUxpT3VMcEM0bktUc0tJQ0FnSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUgwc0lGUlZVazVmVkVsTlJVOVZWRjlOVXlrN0NpQWdJQ0IzWVdsMFpYSWdQU0I3SUhKbGMyOXNkbVVzSUhKbGFtVmpkQ3dnZEdsdFpYSWdmVHNLSUNBZ0lIQnliMk11YzNSa2FXNHVkM0pwZEdVb1NsTlBUaTV6ZEhKcGJtZHBabmtvZXlCMGVYQmxPaUFuZFhObGNpY3NJRzFsYzNOaFoyVTZJSHNnY205c1pUb2dKM1Z6WlhJbkxDQmpiMjUwWlc1ME9pQjBaWGgwSUgwZ2ZTa2dLeUFuWEc0bkxDQW5kWFJtT0NjcE93b2dJSDBwT3dwOUNnb3ZMeURxc0puc25ZQWc2Nnk0NnJXczY2VzhJT3VxaHlEcnNvanNwN2dnNjZ5NzY0cVU3S2VBSU9xNHNPeVd0U0RpDQpnSlFnN0o2czdKcVU3TEt0N0oyMDY2bTBJQ0xzbmJUc29JVHFzN3dnNjR1azY2VzRJT3lEaUNEc29KenNsWWdpN0oyRUlPeWFsT3Exck8yVm5PdUxwQW92THlBbzdKV0lJT3EzdU91ZnJPdXB0Q0R0Z2JUcm9aenJrNXpxc0lBZzdJU3g3SXVrN1pXWTZyS01JT3F3bWV5ZGdDRHJpN1hzbllRZzY1aVFJT3VDdE95RW5DQmJRVWtnN0xhVTdMS2NJT3VObENEcnNKdnF1TEJkNnJDQUlPdXN0T3lkbU91dnVPMlZ0T3luaE91THBDa0tZMjl1YzNRZ1lYTnJaV1JEYjNWdWRDQTlJRzVsZHlCTllYQW9LVHNLQ2k4dklPeUV1T3lGbUNEc3BJRHJ1WVFvN0l1YzY0K1pLK3luZ095TG5PdXN1Q0Rzbzd6c25vVXA2Nlc4SU91enRPeWVwZTJWbkNEcmtxUWc3WldjSU8yRXRDRHNpNlR0bG9rZzRvQ1VJT3VxcU91VG9DRHRtTGpzdHB6c25ZQWdjWFZsZFdYcm9ad2c3S2VCNjZDczdabVVMZ292THlCdGIyUmxiT3lkaENEc283enJxYlFnNnJlNElPdXFxT3VOdU91aG5DQW82NHVrNjZXMDY2bTBJT3lFdU95Rm1DRHNucXpzaTV6cw0KbnBFcExpRHRsWndnNjZxbzY0MjQ3SjJFSU9xemhPeUdqU0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3SjJBSU95MW5PeTBpQ0F4N1pxTTY3K1FMZ3BtZFc1amRHbHZiaUJ5ZFc1VWRYSnVLR0oxYVd4a1FYTnJMQ0J0YjJSbGJDa2dld29nSUdOdmJuTjBJR3B2WWlBOUlIRjFaWFZsTG5Sb1pXNG9ZWE41Ym1NZ0tDa2dQVDRnZXdvZ0lDQWdhV1lnS0cxdlpHVnNJQ1ltSUVGTVRFOVhSVVJmVFU5RVJVeFRMbWx1WkdWNFQyWW9iVzlrWld3cElDRTlQU0F0TVNBbUppQnRiMlJsYkNBaFBUMGdZM1Z5Y21WdWRFMXZaR1ZzS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJxcWpyamJnZzY3T0E2cks5T2lBbklDc2dZM1Z5Y21WdWRFMXZaR1ZzSUNzZ0p5RGlocElnSnlBcklHMXZaR1ZzS1RzS0lDQWdJQ0FnWTNWeWNtVnVkRTF2WkdWc0lEMGdiVzlrWld3N0NpQWdJQ0FnSUhOMFlYSjBVSEp2WXlncE95QXZMeURzZzRnZzY2cW82NDI0NjZHY0lPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdUwNCnBPeWRqQ0RzbTR6cnNJM3NsNFhzbDVEc2hKd2c3S2VBN0l1YzY2eTRJT3llck95anZPeWVoU2tLSUNBZ0lIMEtJQ0FnSUdsbUlDaDBkWEp1Y3lBK1BTQk5RVmhmVkZWU1RsTWdmSHdnSVhCeWIyTXBJSE4wWVhKMFVISnZZeWdwT3dvZ0lDQWdhV1lnS0NGM1lYSnRaV1JWY0NrZ2V3b2dJQ0FnSUNCamIyNXpkQ0IwTUNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNBZ0lHRjNZV2wwSUhObGJtUlVkWEp1S0dsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncEtUc0tJQ0FnSUNBZ2QyRnliV1ZrVlhBZ1BTQjBjblZsT3dvZ0lDQWdJQ0IwZFhKdWN5c3JPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0lTNDdJV1lJT3lrZ091NWhDRHNtWVRybzR3Z0tDY2dLeUFvS0VSaGRHVXVibTkzS0NrZ0xTQjBNQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwSUNzZ0ozTXBJT0tBbENEc25iVHRtNFFnN0pxVTdMS3Q3SjJBSU91NXFPdWR2T3lhbEM0bktUc0tJQ0FnSUgwS0lDQWdJSFIxY201ekt5czdDaUFnDQpJQ0J5WlhSMWNtNGdjMlZ1WkZSMWNtNG9ZblZwYkdSQmMyc29LU2s3Q2lBZ2ZTazdDaUFnTHk4ZzdaV2NJT3lhbE95eXJleWR0Q0RzaTZUdGpLanRsYlRyajRRZzY0dWs3SjJNSU95YWxPeXlyZXlkdENEc25iVHNsclRzcDREcmo0VHJvWjBnN1lHUTY0cVVJTzJWcmV5RGdTRHNoTEhxczdYc25MenJvWndnN0tDVjY2YXNDaUFnY1hWbGRXVWdQU0JxYjJJdVkyRjBZMmdvS0NrZ1BUNGdlMzBwT3dvZ0lISmxkSFZ5YmlCcWIySTdDbjBLQ2k4dklPdXN1T3ExckNEc3RwVHNzcHdnN1lTMENtWjFibU4wYVc5dUlHRnphME5zWVhWa1pTaDBaWGgwTENCdGIyUmxiQ2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lHTnZibk4wSUdGMGRHVnRjSFFnUFNBb1lYTnJaV1JEYjNWdWRDNW5aWFFvZEdWNGRDa2dmSHdnTUNrZ0t5QXhPd29nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvZEdWNGRDd2dZWFIwWlcxd2RDazdDaUFnSUNCcFppQW9ZWE5yWldSRGIzVnVkQzV6YVhwbElENGdNakF3S1NCaA0KYzJ0bFpFTnZkVzUwTG1Oc1pXRnlLQ2s3SUM4dklPdXN0TzJWbk8yZWlDRHNqSlBzbmJUc3A0QWc3SldLNnJLTUNpQWdJQ0J5WlhSMWNtNGdZWFIwWlcxd2RDQStJREVLSUNBZ0lDQWdQeUFuNnJDWjdKMkFJT3VzdU9xMXJPdWx2Q0RyaTZUc2k1d2c3SnFVN0xLdDdaV2M2NHVrTGlEc25iUWc3SVM0N0lXWTdKZVE3SVNjSU95ZHRPeWdoT3lYa0NEc29KenNsWWp0bG9qcmpaZ2c2cktENjVPazZyTzhJT3F5dWV5NW1PeW5nQ0RzbFlycmlwUXNJT3Exck95aHNPdUNtQ0RzbHJUdG5KanFzSUFnN1ptVjdJdWs3WjZJSU91THBPdWx1Q0RzZzRqcm9aenNtclFnNjR5QTdKV0lJRFBxc0p6cnBid2c2cmVjN0xtWjY0eUE2NkdjSUVwVFQwNGc2N0N3N0plMDY2R2M2NmVNT2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb2RHVjRkQ2tLSUNBZ0lDQWdPaUFuNjR1azdKMk1JRlZKSU91c3VPcTFyT3lkbUNEcmpJRHNsWWdnTStxd25PdWx2Q0RxdDV6c3VabnJqSURyb1p3Z1NsTlBUaURyc0xEc2w3VHJvWnpycDR3NklDY2cNCkt5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLVHNLSUNCOUxDQnRiMlJsYkNrN0NuMEtDaTh2SU91eWlPeVhyU0R0aExRZzRvQ1VJT3F3bWV5ZGdDRHNoTGpzaFpqc25ZUWc3Sk93NjVDWUxDRHNuYlRyc29nZzdZUzA2NmVNSU95MmxPeXluQ0R0bUpYc2k1MG9TbE5QVGlEcnNMRHNsN1FwSU91TWdPeUxvQ0Ryc29qc2w2MGc3WmlWN0l1ZEtFcFRUMDRnNnJDZDdMSzBLZXlkaENEc21wVHF0YXp0bFp6cmk2UUtablZ1WTNScGIyNGdZWE5yVkhKaGJuTnNZWFJsS0hSbGVIUXNJRzF2WkdWc0tTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z0tBb2dJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnNjdLSTdKZXRJT3lla2V5WGhleWR0T3VMcENBbzY2eTQ2cldzSU91THBPdVRyT3E0c0NEc2xZVHJpNWdnNG9DVUlPdU1nT3lWaUNBejZyQ2NJT3Ezbk95NW1leWRnQ0RzbmJUcnNvZ2c3WVMwN0plUUlPeWdnZXlhcWUyVm1PeW5nQ0RzbFlycmlwVHJpNlFwTGlBbklDc0tJQ0FnSUNmcmk2VHNuWXdnDQpWVWtnNjZ5NDZyV3M2ckNBSU8yVm5PcTFyZXlXdE91cHRDRHNucERzbDdEc2lxVHJuNnpzbXJRZzdKaUI3SmEwNjZHY0xDRHNtSUhzbHJUcnFiUWc3SjZRN0pldzdJcWs2NStzN0pxMElPMlZuT3ExcmV5V3RPdWhuQ0Ryc29qc2w2M3RsWmpybmJ3dUlDY2dLd29nSUNBZ0oxVkpJT3VzdU9xMXJPdUxwT3lhdENEcXNJVHFzckR0bFp3ZzdaR2M3WmlFN0oyRUlPeVRzT3F6b0N3ZzdKMjA2NmFFd3Jmc2lLdnNucERDdCt1bmlPeUtwTzJDdWNLMzdaU002NkNJN0oyMDdJcWs3Wm1BNjQyVTY0cVVJT3EzdU91TWdPdWhuQ0RyczdUc29iVHRsWnpyaTZRdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95ZG1DRHNwSVFnN0lpWTY2VzhJT3EzdU91TWdPdWhuQ0RzbktEc3A0RHRsWnpyaTZRZzRvQ1VJT3lia091c3VPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPdXlpT3lYcmV1UGhDRHRsWndnN0tTRTY2R2NMQ0RzcElUcnNKVHF2NGpzbllRZzdKNkU3SjJZNjZHY0lPeTJsT3F3Z08yVm1PeW5nQ0RzbFlycmlwVHJpNlF1SUNjZw0KS3dvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1VnNnJpSTdLZUFPaUFuSUNzS0lDQWdJQ2Q3SW5SeVlXNXpiR0YwWldRaU9pQWk2N0tJN0pldDY2eTRJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKa2FYSmxZM1JwYjI0aU9pQWlhMi9paHBKbGJpRHJtSkRyaXBRZ1pXN2locEpyYnlKOU9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29kR1Y0ZENrS0lDQXBMQ0J0YjJSbGJDazdDbjBLQ2k4dklPdU1nTzJabE8yWWxTRHJyTGpxdGF3ZzdLQ2M3SjZSSU8yRXRDRGlnSlFnN0lLczdKcXA3SjZRNnJDQUlPeURnZTJacWV5ZGhDRHNoS1RycW9YdGxaanJxYlFnNjZlbDY1Mjk3SmVRSU91bm51dUtsQ0RyckxqcXRhenJwYndnNjZlTTY1T2s3SmEwN0tTQTY0dWtMZ292THlCdFpYTnpZV2RsY3pvZ1czdHliMnhsT2lkMWMyVnlKM3duWVhOemFYTjBZVzUwSnl3Z2RHVjQNCmRIMWRJT3lnaE95eXRDRHJqSUR0bVpUcnBid2c2NmVrNjdLSUlPdXdtK3VLbE91THBDanJpNlRycHF6cmlwUWc2NnkwN0lPQjdZT2NJT0tBbEFvdkx5RHNtNHpyc0kzc2w0VWc3S2VBN0l1YzY2eTQ3SjJZSUNMc21wVHNzcTNyazZUc25ZQWc3SVNjNjZHY0lPdXN0T3EwZ0NJZzdLQ0U3S0NjNjZXOElPeW5nTzJDcE9xNHNDRHNuSVR0bGJRZzY0eUE3Wm1VSU91bnBldWR2ZXlkaENEdGhMUWc3SldJN0plUUlPdXF2ZXVWaFNEc2k2UHJpcFRyaTZRcExncG1kVzVqZEdsdmJpQmhjMnREYjIxd2IzTmxLRzFsYzNOaFoyVnpMQ0J0YjJSbGJDa2dld29nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJSFJ5WVc1elkzSnBjSFFnUFNBb2JXVnpjMkZuWlhNZ2ZId2dXMTBwTG0xaGNDZ29iU2tnUFQ0S0lDQWdJQ0FnS0cwdWNtOXNaU0E5UFQwZ0oyRnpjMmx6ZEdGdWRDY2dQeUFuN0phMDdJdWM3SXFrN1lTMDdZcTRPaUFuSURvZ0oreUNyT3lhcWV5ZWtEb2dKeWtnS3lCVGRISnBibWNvDQpiUzUwWlhoMElIeDhJQ2NuS1M1emJHbGpaU2d3TENBeE5UQXdLUW9nSUNBZ0tTNXFiMmx1S0NkY2JpY3BPd29nSUNBZ2NtVjBkWEp1SUNnS0lDQWdJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnSXV1TWdPMlpsTzJZbFNEcnJManF0YXdnN0tDYzdKNlJJdXlkdE91THBDQW82cml3N0tHMElPdXN1T3ExckNEcmk2VHJrNnpxdUxBZzdKV0U2NHVZSU9LQWxDRHNsWVRybnBnZzY0eUE3Wm1VNnJDQUlPeWR0T3V5aUNEdGhMVHNuWmdnN0tDRTdMSzBJT3VucGV1ZHZleWR0T3VMcENrdUlDY2dLd29nSUNBZ0lDQW43SUtzN0pxcDdKNlE2ckNBSU8yWmxPdXB0Q0RzZzRIdG1hbkN0K3VucGV1ZHZleWRoQ0RzaEtUcnFvWHRsWmpycWJRc0lPeUtwTzJEZ095ZHZDRHF0NXpzdVpucXM3d2c3SmlJN0l1Y0lPMkdwT3lYa0NEcnA1N3JpcFFnVlVrZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2NmVsNjUyOTdKMjBJT3VzdU9xMXJPdWx2Q0RzazdEcQ0KdUxEc2w1QWc2N2FBN0tHeDdaV1k2Nm0wS095V3RPdUtrQ0R0bVpUcnFiVHNuYmpzcDRBc0lPdXN0T3lLcUNEc2c0SHRtYW5zbmJqc3A0QWc2NU94S1NEcXZLMGc3WldFN0pxVTdaV2NJT3F5Z3lBeDZyQ0E3S2VBNjZlTUlPeW5wK3F5akNEcmtKanJyTHpzbHJUcm5id3VJT3lkdE91VmpDQnpkV2RuWlhOMGFXOXVjK3VLbENEcnVZZ2c2N0N3N0plMExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU91c3VPcTFyT3VsdkNEc29KenNsWWp0bGFBZzY1V1FJT3lFbk91aG5DRHNvSkhxdDd6c25iUWc2NHVrNjZXNElESitNK3F3bkM0ZzZyQ0JJT3lnbk95VmlPeVhsQ0RzbVp3ZzZyZTQ2NkNINnJLTUlPeU52T3VLbE95bmdDRHNuYlRzbktEcnBid2c2N2FaN0oyNDY0dWtMbHh1SnlBckNpQWdJQ0FnSUNjdElPeUNyT3lhcWV5ZWtPcXdnQ0RzbHJqcXVJbnRsWmpzcDRBZzdKV0s3SjJBSU9xMXJPeXl0Q0Rzb0pYcnM3UW83S0NFN1ptVTY3S0k3Wmk0d3JkVlVrekN0K3E0aU95Vm9jSzM3WnFmN0lpWUlPdVRzU25ycGJ3ZzdLZUENCjdKYTA2NEswSU91RW8reW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSnkwZzdadUU3SWFOSU95YWxPeXlyU2dpNjQyVUlPeW5wK3F5akNJc0lDTHJzb1R0aXJ6c21xbnNuTHpyb1p3aUlPdVRzU25zbmJUcnFiUWc3S2VCN0tDRUlPeWduT3lWaU95ZGhDRHF0N2dnNjdDcDdaYWw3Snk4NjZHY0lPcXpvT3l6a0NEcmk2VHNpNXdnN0tDYzdKV0k3WldZNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzZyQ2Q3TEswSU8yVm1PdUNtT3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUxwT3lhdE1LMzdJU2s2NnFGSU9xNGlPeW5nRG9nSnlBckNpQWdJQ0FnSUNkN0luSmxjR3g1SWpvZ0l1dU1nTzJabENEc25aSHJpN1VnN1pXYzY1R1FJT3VzdU95ZXBTQW83WlcwN0pxVTdMSzBLU0lzSUNKemRXZG5aWE4wYVc5dWN5STZJRnQ3SW5SbGVIUWlPaUFpNjZ5NDZyV3NJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKeVpXRnpiMjRpT2lBaTdKMjA3SnlnDQpJTzJWbkNEcnJManNucVVpZlYxOVhHNWNiaWNnS3dvZ0lDQWdJQ0FuVyt1TWdPMlpsRjFjYmljZ0t5QjBjbUZ1YzJOeWFYQjBDaUFnSUNBcE93b2dJSDBzSUcxdlpHVnNLVHNLZlFvS0x5OGc3WXlkN0plRklPeUV1TzJLdUNEc3RwVHNzcHdnN1lTMElPS0FsQ0R0bFp3ZzdZeWQ3SmVGN0oyWUlPcTFyT3lFc2V5YWxPeUdqQ2pzbDYzdGxhQXI2Nnk0NnJXc0tldWx2Q0R0bFp3ZzY3S0k3SmVRSU91enRPdUN0T3F6b0N3S0x5OGc3SnFVN0lhTTY3T0VJT3VDc2Vxd25PcXdnQ0RzbFlUcmk0anJuYndnS2lyc21ZVHNoTEhya0p3ZzdZeWQ3SmVGSU95RXVPMkt1Q2pzdklEc25iVHNpcVFwSURKK00rcXduQ29xNjZXOElPMkd0ZXljdk91aG5DRHJzSnZyaXBUcmk2UXVDaTh2SU8yRGdPeWR0TzJMZ01LMzdKV0k2NEswd3JmcnNvVHRpcnpzbmJRZzdaV2NJT3VxdU95Y3ZPdWhuQ0RzbmJ6cXRJRHJqN3pzbGJ3ZzdaV1k2NitBNjZHY0tPdVVzT3VobkNEcnZaSHNsWVFnN0tHdzdaV3A3WldZNjZtMElPeVd0T3E0aSt1Qw0Kbk91THBDa2c3SVM0N1lxNElPdUxxT3ljaE91aG5DRHNvSnpzbFlqdGxaanFzb3dnN1pXYzY0dWtMZ292THlCbGJHVnRaVzUwY3pvZ1czdHliMnhsTENCMFpYaDBmVjBnS08yWmxPdXB0Q0RzbklUaWhwTHNsWVRybnBnZzdJaWNLUzRLWm5WdVkzUnBiMjRnWVhOclVHOXdkWEFvWld4bGJXVnVkSE1zSUcxdlpHVnNLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnY205c1pYTWdQU0FvWld4bGJXVnVkSE1nZkh3Z1cxMHBMbTFoY0Nnb1pTa2dQVDRnVTNSeWFXNW5LQ2hsSUNZbUlHVXVjbTlzWlNrZ2ZId2dKeWNwS1M1cWIybHVLQ2NzSUNjcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlDaGxiR1Z0Wlc1MGN5QjhmQ0JiWFNrdWJXRndLQ2hsTENCcEtTQTlQZ29nSUNBZ0lDQW9hU0FySURFcElDc2dKeTRnV3ljZ0t5QlRkSEpwYm1jb0tHVWdKaVlnWlM1eWIyeGxLU0I4ZkNBbkp5a2dLeUFuWFNBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb1UzUnlhVzVuS0NobElDWW0NCklHVXVkR1Y0ZENrZ2ZId2dKeWNwS1FvZ0lDQWdLUzVxYjJsdUtDZGNiaWNwT3dvZ0lDQWdjbVYwZFhKdUlDZ0tJQ0FnSUNBZ0oreWR0T3V5aUNEc21wVHNzcTNzbllBZ0l1Mk1uZXlYaFNqcmk2VHNuYlRzbHJ6cm9aenF0N2dwSU95RXVPMkt1Q0RyaTZUcms2enF1TEFpNjR1a0xpRHNsWVRybnBqcmlwUWc3WldjSU8yTW5leVhoZXlkaENEc25JVGlocExzbFlUcm5wanJvWndnNjRLWTdKZTA3WldjSU9xMXJPeUVzZXlhbE95R2pPdVRwT3lkdE91THBDanNoSnpyb1p3ZzY2eTA2clNBN1pXY0lPdXpoT3F3bkNEcnJManF0YXpxc0lBZzdKV0U2NHVJNjR1a0tTNGdKeUFyQ2lBZ0lDQWdJQ2ZzbXBUc2hvenJwYndnNjRLeDZyQ2M2NkdjSU9xem9PeTVtT3luZ0NEcnA1RHFzNkFzSUNvcTdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdk95ZHRDRHNoSnpyb1p3ZzdKMjg2clNBNjVDY0lDTHNtWVRzaExIcmtKd2c3WXlkN0plRklPeUV1TzJLdUNJZ01uNHo2ckNjS2lycnBid2c3S0NjN0pXSTdaV1k2NTI4DQpMaURxc0lFZzdJUzQ3WXE0NjRxVUlPeUVuT3VobkNEcmk2VHJwYmdnN0tDUjZyZTg3SjIwN0phMDdKVzhJTzJWbk91THBDNWNiaWNnS3dvZ0lDQWdJQ0FuNnJDQklPeUV1TzJLdU91S2xDRHNub1hyb0tYcXM3d2dLaXJxc0puc25ZQWc3SmV0N1pXZ3dyZnFzSm5zbllBZzZyQ2M3SWlZd3JmcXNKbnNuWUFnN0lpYzdJU2NLaXJzblpnZzdKcVU3SWFNNjZXOElPdXFxT3VSa0NEdGo2enRsYWp0bFp6cmk2UXVJT3lFdU8yS3VDRHNsWWpzbDVEc2hKd2c3WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZPeWRnQ0R0bFp3ZzY2cTQ3Snk4NjZHY0lPdW5udXlWaE91V3FPeVd0T3lndU95VnZDRHRsWnpyaTZRbzdKaUlPaURyczdqcnJManNuYlFnSW43dGxhRHF1WXpzbXBRL0l1dXB0Q0Ryc29UdGlyenNuWUFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBwTGx4dUp5QXJDaUFnSUNBZ0lDZGI3WXlkN0plRklPdXN1T3l5dENEcXQ1enN1WmtnNG9DVUlPeWNoQ0RzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jN0oyWQ0KSUNJNExpRHRqSjNzbDRVaUlPeUV1ZXlGbU95ZGhDRHJsTERycGJqcmk2UmRYRzRuSUNzS0lDQWdJQ0FnSnkwZzdZT0E3SjIwN1l1QU9pRHNwNmZzbllBZzY2cUY3SUtzNnJXc0tESitOT3lXdE95Z2lDa3NJT3lpaGVxeXNPeVd0T3V2dU1LMzY2ZUk3TG1vN1pHY0lPeVhodXlkdENoKzdKcVVMMzdyaTZRdmZ1cTVqT3lhbEQ4ZzZyaUk3S2VBS1M0ZzY3Q1k2NU9jN0l1Y0lPeVZpT3VDdENqcnM3anJyTGdwSU91bnBldWR2ZXlkaENEc21wVHNsYjN0bGJRZzdZT0E3SjIwN1l1QTY2ZU1JT3Uwa091UGhDRHJyTFRzaXFnZzdZeWQ3SmVGN0oyNDdLZUFJT3lWak9xeWpDRHRsWmpybmJ3dUlPeWJrT3V6dU95ZHRDQWk3SldNNjZhOEwrMlpsZXlkdUNMc3NwanJuN3dnNjZlSjdKZXc3WldZNjZtMElPdXp1T3VzdU95ZGhDRHF0N3pxc2JEcm9ad2c2cldzN0xLMDdabVU3WldZNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU95VmlPdUN0Q2pyczdqcnJMZ3BPaUR0bGJUc21wVHNzclF1SU8yTWtPdUxxT3lkdENEdGxZVHMNCm1wVHRsWmpycWJRZ0luN3RsYURxdVl6c21wUS9JdXVobkNEcnJMdnFzNkFzSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPeWNoTzJYbUNqc2dxM3NvSnpDdCsyRGlPMkh0Q0RyazdFcDdKMkFJT3F5c09xenZPdWx2Q0RycUx6c29JQWc2cks5NnJPZzdaV2M2NHVrTGlEcXNyRHFzN3pDdCt5RGdlMkRuQ0R0aHJYcnM3VHJxYlFnN0lTYzdJaWc3WmlWN0p5ODY2R2NJT3lWak91bXNPdUxwQzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHJzb1R0aXJ3NklPdXp1T3VzdU95ZHRDQWlmdTJWb09xNWpPeWFsRDhpNjZtMElGdnNsWVRyaTRqc21LUmRMMXZyaEtSZExDRHJzN2pyckxqc25iUWc3SU9CN1ptcDdKMkVJT3lFbk95SW9PMlZtT3F6b0NEc25iUWc2N0tFN1lxODdKMjBJT3lMcE95Z25DRHJqNW5zbnBIc25iVHJxYlFnNjQrWjdKNlJJT3VQbWV5Q3JDanNncTNzb0p3djdLQ0E3SjZsTCt5WHNPcXlzQ0R0bGJUc29Kd2c2NU94S1N3ZzdZYTE2N08wSU8yTW5leVhoZXlkbUNEcmk2anNuYndnNjdLRTdZcTg3SjIwDQo2Nm0wSUNMdG1aWHNuYmdpTGlBaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenJwNHdzSUNMcmk2dnF1TERDdCt1UG1leWVrU0lnN0tHdzdaV3BJT3E0aU95bmdDNGc3Wm1VNjZtMElPcTRzT3VLcGV1cWhTanJzNERxc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bklDc0tJQ0FnSUNBZ0p5MGc3SnVRNjZ5NDdKMllJT3lnbGV1enRNSzM3S0d3NnJHMEtPeUlxK3lla01LMzdKMjA3SU9CTCt5ZHRPMlZtTUszNjR5QTdJT0JLZXlkZ0NEc25LRHNwNER0bFpqcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTaw0KNjZxRndyZnN2WlRyazV6dGpwenNpcVFnNnJpSTdLZUFPbHh1SnlBckNpQWdJQ0FnSUNkN0luTmxkSE1pT2lCYmV5SnlaV0Z6YjI0aU9pQWk3SjIwSU95RXVPMkt1T3lkbUNEcnNLbnRscVhzbllRZzdaV2M2cld0N0phMElPMlZuQ0Ryckxqc25xWHNuTHpyb1p3aUxDQWlaV3hsYldWdWRITWlPaUJiZXlKeWIyeGxJam9nSXV5WHJlMlZvQ0lzSUNKMFpYaDBJam9nSXV1c3VPcTFyQ0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpZlN3Z0xpNHVYWDBzSUM0dUxsMTlYRzRuSUNzS0lDQWdJQ0FnSit5WHJlMlZvT3lkZ0NEc25vWHJvS1VnN0lpYzdJU2M2NHlBNjZHY09pQW5JQ3NnY205c1pYTWdLeUFuWEc1Y2JpY2dLd29nSUNBZ0lDQW5XKzJNbmV5WGhTRHNtcFRzaG94ZFhHNG5JQ3NnYkdsemRBb2dJQ0FnS1RzS0lDQjlMQ0J0YjJSbGJDazdDbjBLQ2k4dklPMk1uZXlYaFNEc25aSHJpN1hzbDVEc2hKd2dlM05sZEhNNklGdDdjbVZoYzI5dUxDQmxiR1Z0Wlc1MGN6cGJlM0p2YkdVc2RHVjRkSDFkZlYxOUlPeTINCmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlFiM0IxY0NoeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzhnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ1kyOXVjM1FnYzJWMGMwbHVJRDBnUVhKeVlYa3VhWE5CY25KaGVTaHZJQ1ltSUc4dWMyVjBjeWtnUHlCdkxuTmxkSE1nT2lCYlhUc0tJQ0FnSUdOdmJuTjBJSE5sZEhNZ1BTQnpaWFJ6U1c0S0lDQWdJQ0FnTG0xaGNDZ29jM1FwSUQwK0lDaDdDaUFnSUNBZ0lDQWdjbVZoYzI5dU9pQlRkSEpwYm1jb0tITjBJQ1ltDQpJSE4wTG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTd0tJQ0FnSUNBZ0lDQmxiR1Z0Wlc1MGN6b2dRWEp5WVhrdWFYTkJjbkpoZVNoemRDQW1KaUJ6ZEM1bGJHVnRaVzUwY3lrS0lDQWdJQ0FnSUNBZ0lEOGdjM1F1Wld4bGJXVnVkSE1LSUNBZ0lDQWdJQ0FnSUNBZ0lDQXViV0Z3S0NobGJDa2dQVDRnS0hzZ2NtOXNaVG9nVTNSeWFXNW5LQ2hsYkNBbUppQmxiQzV5YjJ4bEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCMFpYaDBPaUJUZEhKcGJtY29LR1ZzSUNZbUlHVnNMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcENpQWdJQ0FnSUNBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvWld3cElEMCtJR1ZzTG5SbGVIUXBDaUFnSUNBZ0lDQWdJQ0E2SUZ0ZExBb2dJQ0FnSUNCOUtTa0tJQ0FnSUNBZ0xtWnBiSFJsY2lnb2MzUXBJRDArSUhOMExtVnNaVzFsYm5SekxteGxibWQwYUNrN0NpQWdJQ0J5WlhSMWNtNGdjMlYwY3k1c1pXNW5kR2dnUHlCelpYUnpJRG9nYm5Wc2JEc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZw0KZXdvZ0lDQWdjbVYwZFhKdUlHNTFiR3c3Q2lBZ2ZRcDlDZ292THlEcmpJRHRtWlR0bUpVZzdLQ2M3SjZSSU95ZGtldUx0ZXlYa095RW5DQjdjbVZ3Ykhrc0lITjFaMmRsYzNScGIyNXpXMTE5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVkRiMjF3YjNObEtISmhkeWtnZXdvZ0lHeGxkQ0J6SUQwZ1UzUnlhVzVuS0hKaGR5a3VkSEpwYlNncExuSmxjR3hoWTJVb0wxNWdZR0FvUHpwcWMyOXVLVDljY3lvdmFTd2dKeWNwTG5KbGNHeGhZMlVvTDF4ekttQmdZQ1F2YVN3Z0p5Y3BPd29nSUdOdmJuTjBJRzBnUFNCekxtMWhkR05vS0M5Y2UxdGNjMXhUWFNwY2ZTOHBPd29nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYnlBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3Q2lBZ0lDQmpiMjV6ZENCeVpYQnNlU0E5SUZOMGNtbHVaeWdvYnlBbUppQnZMbkpsY0d4NUtTQjhmQ0FuSnlrdWRISnANCmJTZ3BPd29nSUNBZ1kyOXVjM1FnYzNWbloyVnpkR2x2Ym5NZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTV6ZFdkblpYTjBhVzl1Y3lrS0lDQWdJQ0FnUHlCdkxuTjFaMmRsYzNScGIyNXpDaUFnSUNBZ0lDQWdJQ0F1YldGd0tDaDRLU0E5UGlBb2V5QjBaWGgwT2lCVGRISnBibWNvS0hnZ0ppWWdlQzUwWlhoMEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCeVpXRnpiMjQ2SUZOMGNtbHVaeWdvZUNBbUppQjRMbkpsWVhOdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa0tJQ0FnSUNBZ0lDQWdJQzVtYVd4MFpYSW9LSGdwSUQwK0lIZ3VkR1Y0ZENrS0lDQWdJQ0FnT2lCYlhUc0tJQ0FnSUdsbUlDaHlaWEJzZVNCOGZDQnpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ3BJSEpsZEhWeWJpQjdJSEpsY0d4NUxDQnpkV2RuWlhOMGFXOXVjeUI5T3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUc1MWJHdzdDbjBLQ2k4dklPdXlpT3lYclNEc25aSHJpN1hzDQpsNURzaEp3Z2UzUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZibjBnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpWUnlZVzV6YkdGMFpTaHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdZMjl1YzNRZ2RISmhibk5zWVhSbFpDQTlJRk4wY21sdVp5Z29ieUFtSmlCdkxuUnlZVzV6YkdGMFpXUXBJSHg4SUNjbktTNTBjbWx0S0NrN0NpQWdJQ0JwWmlBb2RISmhibk5zWVhSbFpDa2djbVYwZFhKdUlIc2dkSEpoYm5Ocw0KWVhSbFpDd2daR2x5WldOMGFXOXVPaUJUZEhKcGJtY29LRzhnSmlZZ2J5NWthWEpsWTNScGIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURzbFlUcm5wanJvWndnS2k4Z2ZRb2dJSEpsZEhWeWJpQnVkV3hzT3dwOUNnb3ZMeURzblpIcmk3WHNsNURzaEp3Z2UzUmxlSFFzSUhKbFlYTnZibjBnNjdDdzdKZTBJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa0tablZ1WTNScGIyNGdjR0Z5YzJWVGRXZG5aWE4wYVc5dWN5aHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhGdGJYSE5jVTEwcVhGMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnYNCmJuTjBJR0Z5Y2lBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3Q2lBZ0lDQnBaaUFvUVhKeVlYa3VhWE5CY25KaGVTaGhjbklwS1NCN0NpQWdJQ0FnSUhKbGRIVnliaUJoY25JS0lDQWdJQ0FnSUNBdWJXRndLQ2g0S1NBOVBpQW9leUIwWlhoME9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1MFpYaDBLU0I4ZkNBbkp5a3VkSEpwYlNncExDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tLSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOVBpQjRMblJsZUhRcE93b2dJQ0FnZlFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUZ0ZE93cDlDZ292THlEcm9aenF0N2pzbmJnZzdaV0U3SnFVSU95RGdlMkRuT3lkdkNEcmxZd2dMMmhsWVd4MGFDRHNvYkR0bW96cXNJQWc3SmlrNjZtMElPdVNwT3lYa095RW5DRHNtNHpyc0kzc2w0WHNuWVFnNjR1azdJdWNJT3lMbk91UGhPMlZ0T3V6dU91THBDQW9NekRzDQp0SWpzbDVBZ01ldXlpT3VuakNrdUNpOHZJT3lFc2VxenRlMlZtT3VwdENEcXNyRHFzN3dnN1pXNDY1T2s2NStzNnJDQUlHTnNZWFZrWlZOMFlYUjFjejBuYjJzbjY2R2NJT3VRbU91UGpPdW1yT3V2Z091aG5Dd2c3SjZzNjZHYzZyZTQ3SjI0SU8yYmhDRHJzb1R0aXJ6c25iUWc3S0NBN0tDSTY2R2NJUENmbjZMc25MenJvWndnNjdPMTZyZUE3WldjNjR1a0xnb3ZMeUFvN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc3SmV3SU91U3BDRHNvN3pxdUxEc29JSHNuTHpyb1p3Z0wyaGxZV3gwYU91bHZDRHNvYkR0bW96dGxaanJpcFFnNnJLRDZyTzhJT3lubmV5ZGhDRHNuYlRybzZ6cmk2UXBDbXhsZENCc1lYTjBRWFYwYUZKbGRISjVRWFFnUFNBd093cG1kVzVqZEdsdmJpQnlaWFJ5ZVVGMWRHaEpaazVsWldSbFpDZ3BJSHNLSUNCcFppQW9ZMnhoZFdSbFUzUmhkSFZ6SUNFOVBTQW5ZMnhoZFdSbExXeHZaMjkxZENjcElISmxkSFZ5YmpzS0lDQnBaaUFvZDJGcGRHVnlJSHg4SUVSaA0KZEdVdWJtOTNLQ2tnTFNCc1lYTjBRWFYwYUZKbGRISjVRWFFnUENBek1EQXdNQ2tnY21WMGRYSnVPeUF2THlEc3A0VHRsb2tnN0tTUklPMkV0Q0Ryc0tudGxiUWc2cmlJN0tlQUlDc2dNekRzdElnZzZyQ0U2cktwQ2lBZ2JHRnpkRUYxZEdoU1pYUnllVUYwSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNElPeWVyTzJabGV5ZHVDRHNpNXpyajRUaWdLWW5LVHNLSUNCeWRXNVVkWEp1S0NncElEMCtJQ2Zyb1p6cXQ3anNuYmdnN1ptVjdKMjQ3SnFwN0oyMDY0dWtMaUFpVDBzaTY1Mjg2ck9nNjZlTUlPdUx0ZTJWbU91ZHZDNG5LUzUwYUdWdUtBb2dJQ0FnS0NrZ1BUNGdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEdG1aWHNuYmpya0tnZzRvQ1VJT3lnbGV5RGdTRHNnNEh0ZzV6cm9ad2c2N08xNnJlQUxpY3BMQW9nSUNBZ0tHVXBJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNsWVRzcDRFZzY2R2MNCjZyZTQ3SjI0SU95VmlDRHJrS2c2Snl3Z1UzUnlhVzVuS0dVdWJXVnpjMkZuWlNrdWMyeHBZMlVvTUN3Z09EQXBLUW9nSUNrN0NuMEtDaTh2SU95THBPMk1xQ0RzblpIcmk3WHNuWVFnN0lLczY1Nk03SnFwSU95VmlPdUN0T3VobkNEcnM0RHRtWmdnNG9DVUlPeWJrT3lkdUNqcm9aenF0N2pzbmJndjdJU2s3TG1ZS2V5ZHRDRHRqSXpzbFlYcmtKd2c2cks5N0pxdzdKZVVJT3EzdUNEc2xZanJnclRycGJ3c0lPeVZoT3VMaU91cHRDRHNvSkhya1pEc2xyUXI3SnVRNjZ5NDdKMkVJT3V6dE91Q3VPdUxwQXBtZFc1amRHbHZiaUJtY21sbGJtUnNlVVZ5Y205eUtHVXNJSEJ5WldacGVDa2dld29nSUdsbUlDaGxJQ1ltSUdVdWJXVnpjMkZuWlNBOVBUMGdURTlIU1U1ZlIxVkpSRVVwSUhKbGRIVnliaUI3SUdWeWNtOXlPaUJNVDBkSlRsOUhWVWxFUlN3Z2NISnZZbXhsYlRvZ0oyTnNZWFZrWlMxc2IyZHZkWFFuSUgwN0NpQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjJOc1lYVmtaUzF0YVhOemFXNW5KeWtnDQpld29nSUNBZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUNmc25iUWdVRVBzbDVBZ1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbEtlcXdnQ0RzaEtUc3VaanJqN3dnN0o2STdLZUFJT3lWaXV5VmhPeWFsQ0RpZ0pRZzdJU2s3TG1ZN1pXWTZyT2dJT3Vobk9xM3VPeWR1TzJWbkNEcmtxUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeXdnY0hKdllteGxiVG9nSjJOc1lYVmtaUzF0YVhOemFXNW5KeUI5T3dvZ0lIMEtJQ0J5WlhSMWNtNGdleUJsY25KdmNqb2djSEpsWm1sNElDc2dLR1VnSmlZZ1pTNXRaWE56WVdkbElEOGdaUzV0WlhOellXZGxJRG9nVTNSeWFXNW5LR1VwS1NCOU93cDlDZ3BtZFc1amRHbHZiaUJ5WldGa1FtOWtlU2h5WlhFcElIc0tJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVVwSUQwK0lIc0tJQ0FnSUd4bGRDQmliMlI1SUQwZ0p5YzdDaUFnSUNCeVpYRXViMjRvSjJSaGRHRW5MQ0FvWXlrZ1BUNGdleUJpYjJSNUlDczlJR003SUgwcE93b2dJQ0FnY21WeA0KTG05dUtDZGxibVFuTENBb0tTQTlQaUI3Q2lBZ0lDQWdJSFJ5ZVNCN0lISmxjMjlzZG1Vb1NsTlBUaTV3WVhKelpTaGliMlI1S1NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGMyOXNkbVVvZTMwcE95QjlDaUFnSUNCOUtUc0tJQ0I5S1RzS2ZRb0tZMjl1YzNRZ1EwOVNVMTlJUlVGRVJWSlRJRDBnZXdvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFQY21sbmFXNG5PaUFuS2ljc0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFUxbGRHaHZaSE1uT2lBblIwVlVMQ0JRVDFOVUxDQlBVRlJKVDA1VEp5d0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFNHVmhaR1Z5Y3ljNklDZERiMjUwWlc1MExWUjVjR1VuTEFwOU93cG1kVzVqZEdsdmJpQnFjMjl1S0hKbGN5d2djM1JoZEhWekxDQnZZbW9wSUhzS0lDQnlaWE11ZDNKcGRHVklaV0ZrS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MFpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2cNClkyaGhjbk5sZEQxMWRHWXRPQ2NnZlN3Z1EwOVNVMTlJUlVGRVJWSlRLU2s3Q2lBZ2NtVnpMbVZ1WkNoS1UwOU9Mbk4wY21sdVoybG1lU2h2WW1vcEtUc0tmUW9LWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9ZWE41Ym1NZ0tISmxjU3dnY21WektTQTlQaUI3Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFBVRlJKVDA1VEp5a2dleUJ5WlhNdWQzSnBkR1ZJWldGa0tESXdOQ3dnUTA5U1UxOUlSVUZFUlZKVEtUc2djbVYwZFhKdUlISmxjeTVsYm1Rb0tUc2dmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblIwVlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMmhsWVd4MGFDY3BJSHNLSUNBZ0lISmxkSEo1UVhWMGFFbG1UbVZsWkdWa0tDazdJQzh2SU91aG5PcTN1T3lkdUNEdGxZVHNtcFFnN0lPQjdZT2M2Nm0wSU95ZXJPMlpsZXlkdUNEc2k1enJqNFFnNG9DVUlPeWVyT3Vobk9xM3VPeWR1T3lkdENEcmdaM3JncXpzbkx6cnFiUWc2NHVrN0oyTUlPeWhzTzJhDQpqT3UyZ08yRXNDQndjbTlpYkdWdDdKMjBJTzJTZ091bXNPdUxwQW9nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNLSUNBZ0lDQWdiMnM2SUhSeWRXVXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY3NJSFk2SUVKU1NVUkhSVjlXTENCa2FYSTZJRjlmWkdseWJtRnRaU3dnTHk4Z2RzSzNaR2x5T2lEcXRhenJzb1Rzb0lRdjdKZUo2NXF4N1pXY0lPeUNyT3V6dU95ZHRDRHJscUFnN0o2STY0cVU3S2VBSU95bmhPdUxxT3lhcVFvZ0lDQWdJQ0J0YjJSbGJEb2dZM1Z5Y21WdWRFMXZaR1ZzTENCdGIyUmxiSE02SUVGTVRFOVhSVVJmVFU5RVJVeFRMQ0JsZUdGdGNHeGxjem9nUlZoQlRWQk1SVk11YkdWdVozUm9MQ0JuZFdsa1pUb2dSMVZKUkVVdWJHVnVaM1JvTENCeVpXRmtlVG9nZDJGeWJXVmtWWEFzQ2lBZ0lDQWdJSEJ5YjJKc1pXMDZJQ2hqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJQ2R2YXljZ2ZId2dZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQnVkV3hzS1NBL0lHNTFiR3dnT2lCamJHRjFaR1ZUZEdGMA0KZFhNc0NpQWdJQ0FnSUdGalkyOTFiblE2SUdOc1lYVmtaVUZqWTI5MWJuUW9LU3dLSUNBZ0lDQWdjMlZ5ZG1Wa09pQnpkR0YwY3k1elpYSjJaV1FzSUd4aGMzUkJkRG9nYzNSaGRITXViR0Z6ZEVGMExDQnNZWE4wVkdWNGREb2djM1JoZEhNdWJHRnpkRlJsZUhRc0lHeGhjM1JUWldNNklITjBZWFJ6TG14aGMzUlRaV01zQ2lBZ0lDQjlLVHNLSUNCOUNpQWdMeThnN1pTTTY1K3M2cmU0N0oyNElPeUxyT3llcGV1d2xldVBtU0RpZ0pRZzY0R0s2cml3NjZtMElPeWNoQ0Rxc0pEc2k1d2c3WU9BN0oyMDY2aTQ2ckNBSU91THBPdW1yT3VsdkNEcmdZanJpNlFLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YUdWaGNuUmlaV0YwSnlrZ2V3b2dJQ0FnYkdGemRFSmxZWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ2ZRb2dJQzh2SU91aG5PcTN1T3lkdUNEaWdKUWcNCjdaU002NStzNnJlNDdKMjQ3SjJZSUZ2d241K2dJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNuYmdnN1pXRTdKcVVYY0szVy9DZmxKRmRJT3V5aE8yS3ZPeWR0Q0R0bUxqc3RwenRsWnpyaTZRdUNpQWdMeThnNnJpdzY3TzRLT3U0ak91ZHZPeWFzT3lnZ0NEc3A0SHRsb2twT2lCZ1kyeGhkV1JsSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFXRHJwYndnN0lpbzdKMkFJTzJVaE91aG5PeUV1T3lLcE91aG5DRHNpNlR0bG9rZzRvQ1VJT3VwbE91SnRDRHNsNGJzbmJRZzZyT243SjZsSU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUcXM2QXNDaUFnTHk4Z0lDQnNiMk5oYkdodmMzUWc3SWlZN0l1Z0lPMlByTzJLdU91aG5DRHFzckRxczd6cnBid2c3SjZRNjQrWklPeUltT3VndWUyVm5PdUxwQ2pzaTZUc3VLRTZJTzJYcE91VG5PdW1yT3lLcE95WGtPeUVuT3VQaENEcnVJenJuYnpzbXJEc29JQWc3SmUwNjZhOElDc2dURWxUVkVWT0lPMlpsZXlkdUN3Z01qQXlOaTB3TnlrdUNpQWdMeThnSUNEdGhMRHJyN2pyDQpoSkRzbmJRZzdabVU2Nm0wN0plUUlPeWdoTzJZZ0NEc2xZZ2c2NXlzNjR1a0xpRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0NjZlTUlPMlZtT3VwdENEcmdaMHVDaUFnTHk4ZzdZKzA2N0N4S08yRXNPdXZ1T3VFa0NrNklPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzY2ZUo3WjZNSU8yWm1PcXl2U2pydUl6cm5ienNtckRzb0lEcXNJQWdiRzlqWVd4b2IzTjA3SmVRSU91cXV5RHJpNy9zbFlRZzdMMlU2NU9jNnJDQUlPdXp0T3lkdE91S2xDRHFzcjNzbXJBcDdKZVE3SVNjQ2lBZ0x5OGdJQ0Ryb1p6cXQ3anNuYmdnNjR5QTZyaXdJT3lra1NEcnNvVHRpcnpzbllRZzY1aVFJT3VJaE91bHRPdXB0Q3dnN0wyVTY1T2M2Nlc4SU91Mm1leVhyT3VFbyt5ZGhDRHNpSmdnN0o2STY0cVVJTzJFc091dnVPdUVrQ0Ryc0tuc2k1M3NuTHpyb1p3ZzdLQ0U3Wm1ZN1pXYzY0dWtMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl2Y0dWdUxXeHZaMmx1SnlrZw0KZXdvZ0lDQWdZMjl1YzNRZ1ltOWtlU0E5SUdGM1lXbDBJSEpsWVdSQ2IyUjVLSEpsY1NrN0NpQWdJQ0JqYjI1emRDQnpkMmwwWTJoTmIyUmxJRDBnSVNFb1ltOWtlU0FtSmlCaWIyUjVMbk4zYVhSamFFRmpZMjkxYm5RcE95QXZMeURxczRUc29KVWc3S0NFN1ptWUlEMGc3SXVjN1lHczY2YS9JT3l3dmV5Y3ZPdWhuQ0RzbDdUc2xyUWc2ck9FN0tDVjdKMkVJT3F6b091bHZDRHNpSmdnN0o2STZyS01DaUFnSUNCMGNua2dld29nSUNBZ0lDQXZMeUJqYkdGMVpHWHFzSUFnN0plRzdKeTg2Nm0wSU95WHJPcTRzT3lFbkNEcmdZcnJpcFRyaTZRdUlITm9aV3hzT25SeWRXWHJuYndnWTJ4aGRXUmw2ckNBSU95WGh1eVd0T3VQaENEc2hianNuWUFnN0tDVjdJT0JJT3lMcE8yV2lldVB2QW9nSUNBZ0lDQXZMeUJ6Y0dGM2J1eWRtQ0FuWlhKeWIzSW42ckNBSU95VmlDRHJuS2pxczZBc0lPeVlpT3lnaE95WGxDRHF0N2pyaklEcm9ad2diMnM2ZEhKMVpldWx2Q0RyajR6cm9LVHNwS3pyaTZRZzRvQ1VDaUFnSUNBZ0lDOHYNCklPMlVqT3Vmck9xM3VPeWR1T3lkZ0NBaTY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95WHRPeVhpT3lXdE95YWxDTHJuYnpxczZBZzdaV1k2NHFVNjQyd0lPeUxwT3lnbk91aG5PdUtsQ0RzbFlUcnJMVHFzb1ByajRRZzdKV0lJT3VjcU91S2xDRHNnNEh0ZzV6cXNJQWc2NUNRNjR1a0tPeUxwT3lnbkNEc2k2RHFzNkFwTGdvZ0lDQWdJQ0JwWmlBb1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBblkyeGhkV1JsTFcxcGMzTnBibWNuS1NCN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ERXNJSHNLSUNBZ0lDQWdJQ0FnSUdWeWNtOXlPaUFuN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lYaHV5V3RPeWFsQ0RpZ0pRZzdZU3c2Nis0NjRTUTdKZVE3SVNjSUdOc1lYVmtaU0F0TFhabGNuTnBiMjRnN0oyMElPdVFtT3VLbE95bmdDRHRtWlhzbmJqdGxiUWc3S084N0lTNDdKcVVMaWNzQ2lBZ0lDQWdJQ0FnSUNCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuTEFvZ0lDQWdJQ0FnDQpJSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJQzh2SU95bmhPMldpU0RzcEpIc25ianJqYkFnNjVpUUlPdUlqT3VnZ091THBDRGlnSlFnNnJpSTY3Q3BLRFl3N0xTSUlPdUN0Q2tnNjR1azdJdWNJT3VJaE91bHVDRHFzYlFnSXV5d3ZleWRoQ0RyaTZ2c2xaanJpNlF2NjZxN0lPdTBwT3VMcENMc2w1QWc2ckNBNnJtTTdKcXc2NitBNjZHY0lPdTRqT3Vkdk95YXNPeWdnT3VobkNEc25xenNpNXpyajRUdGxaenJpNlF1Q2lBZ0lDQWdJQzh2SU8yVm5PeXd1Q0Rya3FUc2w1RHJqNFFnNjVpUUlPdUloT3VsdE91S2xDRHFzYlFnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJR3h2WTJGc2FHOXpkQ0Rzdlp6cnNMSHNsNUFnNjZxN0lPdUx2K3lWaENEc25wRHJqNWtnN0ptRTY2T002ckNBSU95VmlDRHJrSmpyaXBRZzdabVk2cks5N0oyOElPeUltQ0Rzbm9qc25MenJpNGdLSUNBZ0lDQWdMeThnNnJlNDY1V002NmVNSU95OWxPdVRuT3VsdkNEcnRwbnNsNnpyaEtQc25ZUWc3SWlZSU95ZWlPdUtsQ0R0aExEcnI3anJoSkFnNjdDcA0KN0l1ZDdKeTg2NkdjSU8yUHRPdXdzZTJWbk91THBDQW82NUdRSU91eWlPeW51Q0R0Z2JUcnBxM3NsNUFnN1lTdzY2KzQ2NFNRN0oyMElPMktnT3lXdE91Q21PeVlwT3VwdENEcmk3bnRtYW5zaXFUcm43M3JpNlFwTGdvZ0lDQWdJQ0JqYjI1emRDQnpkR0ZzWlNBOUlHeHZaMmx1VUhKdll5QW1KaUFvUkdGMFpTNXViM2NvS1NBdElHeHZaMmx1VTNSaGNuUmxaRUYwSUQ0Z05qQXdNREFwT3dvZ0lDQWdJQ0JwWmlBb2JHOW5hVzVRY205aklDWW1JSE4wWVd4bEtTQjdDaUFnSUNBZ0lDQWdhMmxzYkV4dloybHVVSEp2WXlncE93b2dJQ0FnSUNBZ0lHbG1JQ2doYjNCbGJreHZaMmx1VkdWeWJXbHVZV3dvS1NrZ2V3b2dJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNREVzSUhzZ1pYSnliM0k2SUNmc25iUWdUMVBzbDVEc2hLQWc3SjZRNjQrWjdKeTg2NkdjSU91cXV5RHNsN1RzbHJUc21wUWc0b0NVSU8yRXNPdXZ1T3VFa095WGtPeUVuQ0JqYkdGMVpHVWc3SXVrN1phSklPMmJoQ0F2Ykc5bmFXNGcNCjdaVzBJT3lqdk95RXVPeWFsQzRuSUgwcE93b2dJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3Q2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHRqN1Ryc0xFZzRvQ1VJTzJFc091dnVPdUVrQ0Ryc0tuc2k1M3NuTHpyb1p3ZzdLQ0U3Wm1ZTGljcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCdGIyUmxPaUFuZEdWeWJXbHVZV3duSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNnTHk4ZzdKV2U3SVNnSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianNuYlFnNjR5QTZyaXdJT3lra2V5ZHRPdXB0Q0Rzb0pIcXM2QWc3SU9JNjZHY0lPeVhzT3VMcENBbzdMQzk3SjJFSU91THEreVZtT3F4c091Q21DRHJpNlRzaTV3ZzY0aUU2Nlc0SU9xeXZleWFzQ2tLSUNBZ0lDQWdiRzluDQphVzVUZEdGeWRHVmtRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNBdkx5QkNVazlYVTBWUzY2VzhJT3lhc091bXJDRHRsYmpyazZUcm42enJvWndnN0tlQTdLQ1ZJT0tBbENCRFRFbnFzSUFnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN1RzcDRBZzdKV0s2ck9nSUZWU1RPdW5qQ0RyaEpqcXNxanNwSURyaTZRdUNpQWdJQ0FnSUM4dklPMlZ1T3VUcE91ZnJPcXdnQ0RzaTZUdGpLanRsWmpxc2JEcmdwZ2dRMHhKNnJDQUlFSlNUMWRUUlZMcnBid2c2NnkwN0l1YzdaVzA2NCtFSUVOTVNlcXdnQ0RzbFl6c2xZVHNoSndnNnJpdzY3TzRJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RycjREcm9ad2c2NkdjNnJlNDdKMjQ3SjJBSU91UW5PdUxwQ2htWVdsc0xYTnZablFwTGdvZ0lDQWdJQ0JqYjI1emRDQnNiMmRwYmtWdWRpQTlJRTlpYW1WamRDNWhjM05wWjI0b2UzMHNJRU5NUVZWRVJWOUZUbFlzSUhzZ1FsSlBWMU5GVWpvZ2QzSnBkR1ZDY205M2MyVnlTR0Z1Wkd4bGNpaHpkMmwwWTJoTg0KYjJSbElEOGdKM04zYVhSamFDY2dPaUFuYm05eWJXRnNKeWtnZlNrN0NpQWdJQ0FnSUdOdmJuTjBJSFJvYVhOTWIyZHBiaUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSjJGMWRHZ25MQ0FuYkc5bmFXNG5MQ0FuTFMxamJHRjFaR1ZoYVNkZExDQjdDaUFnSUNBZ0lDQWdjMmhsYkd3NklIUnlkV1VzSUdWdWRqb2diRzluYVc1RmJuWXNJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVXNDaUFnSUNBZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzSUM4dklHdHBiR3hNYjJkcGJsQnliMlBzblpnZzZyZTQ2Nk81SUd0cGJHenNtcWtnS0d0cGJHeFFjbTlqNnJPOElPdVBtZXlkdkNEdGpLanRoTFFwQ2lBZ0lDQWdJSDBwT3dvZ0lDQWdJQ0JzYjJkcGJsQnliMk1nUFNCMGFHbHpURzluYVc0N0NpQWdJQ0FnSUhSb2FYTk1iMmRwYmk1dmJpZ25aWEp5YjNJbkxDQW9LU0E5UGlCN0lHbG1JQ2hzYjJkcGJsQnliMk1nUFQwOUlIUm8NCmFYTk1iMmRwYmlrZ2JHOW5hVzVRY205aklEMGdiblZzYkRzZ2ZTazdDaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdJVDA5SUhSb2FYTk1iMmRwYmlrZ2NtVjBkWEp1T3dvZ0lDQWdJQ0FnSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnYVdZZ0tHeHZaMmx1VUhKdlkxUnBiV1Z5S1NCN0lHTnNaV0Z5VkdsdFpXOTFkQ2hzYjJkcGJsQnliMk5VYVcxbGNpazdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdiblZzYkRzZ2ZRb2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQzh2SU95RGlDRHFzNFRzb0pYc25id2c3SWlZSU95ZWlPeWN2T3VMaUNEcmk2VHNuWXdnTDJobFlXeDBhQ0RybFl3ZzY0dWs3SXVjSU95ZHZlcTRzQW9nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJT3lnaU95d3FDRHNvb1hyDQpvNHdnS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93b2dJQ0FnSUNBZ0lDOHZJT3lDck91ZWpPeWR0Q0Ryb1p6cXQ3anNuYmp0bGFBZzdJdWM2ckNFNjQrRUlPeVhodXlkdENEcXM2ZnJzSlRyb1p3ZzdJdWs3WXlvNjZHY0lPdUJuZXVDck91THBDQTlJR05zWVhWa1plcXdnQ0RzbDRicXNiRHJncGdnN0l1azdaYUo3SjIwSU95VmlDRHJrSndnNnJLRExnb2dJQ0FnSUNBZ0lDOHZJT3lka2V1THRleWRnQ0RzbmJUcnI3Z2c2N08wNjRPSTdKeTg2NHVJSU95RGdlMkRuT3VsdkNEcmk2VHNpNXdnN0o2czdJU2NJQzlvWldGc2RHanJvWndnN0pXTTY2YXc2NHVrSUNqdGxJenJuNnpxdDdqc25ianNuYlFnNjR5QTZyaXdJTzJabE91cHRPeWRoQ0RzaTZUdGpLanJvWndnNjdDVTZyNjg2NHVrS1M0S0lDQWdJQ0FnSUNCcFppQW9ZMjlrWlNBaFBUMGdNQ0FtSmlCRVlYUmxMbTV2ZHlncElDMGdiRzluYVc1VGRHRnlkR1ZrUVhRZ1BDQTFNREF3S1NCN0NpQWdJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeQ0KYVdSblpWMGc2NkdjNnJlNDdKMjQ3SjIwSU95bWlleUxuQ0RzaTZUdGpLanJvWndnNjRHZDY0S29JT0tBbENCRGJHRjFaR1VnUTI5a1pTRHNoS1RzdVpnZzdJT0I3WU9jNjZXOElPdUxwT3lMbkNEc29KRHFzb0R0bGFucmk0anJpNlF1SnlrN0NpQWdJQ0FnSUNBZ0lDQmphR1ZqYTBOc1lYVmtaVUYyWVdsc1lXSnNaU2dwT3dvZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnZlNrN0NpQWdJQ0FnSUd4dloybHVVSEp2WTFScGJXVnlJRDBnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3SUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25iZ2dNVERydG9RZzZySzk2ck84SU9LQWxDRHJqSURxdUxBZzdaU0U2NkdjN0lTNDdJcWtJT3lnbGV1bXJDNG5LVHNnYTJsc2JFeHZaMmx1VUhKdll5Z3BPeUI5TENBMk1EQXdNREFwT3dvZ0lDQWdJQ0F2THlEcmdxSHNuWUFnN0o2RjdKNmw2cmFNN0oyRUlPdXN2T3F6b0NEc25vanJpcFFnNjR5QTZyaXdJT3lFdU95Rm1PeWRnQ0Ryc29UcnByRHJpNlFnNG9DVUlPeWUNCnJPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzZzRnZzdJUzQ3SVdZS095RGlDRHNub1hzbnFYcXRvd3A3Snk4NjZHY0lPeUxuT3lla2UyVm1PcXlqQW9nSUNBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFbklDc2dLSE4zYVhSamFFMXZaR1VnUHlBbklDanFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDRHNpNXp0Z2F6cnByOGc3TEM5S1NjZ09pQW5KeWtnS3lBbklPS0FsQ0Ryb1p6cXQ3anNuYmp0bFpqcnFiUWc3SjZRNjQrWklPeVhzT3F5c091UXFldUxpT3VMcEM0bktUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUcxdlpHVTZJSE4zYVhSamFFMXZaR1VnUHlBblluSnZkM05sY2kxemQybDBZMmduSURvZ0oySnliM2R6WlhJbklIMHBPd29nDQpJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJsY25KdmNqb2dKK3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc2NnE3SU95WHRPeVhpT3lXdE95YWxEb2dKeUFySUdVdWJXVnpjMkZuWlNCOUtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4Z0tPMkVzT3V2dU91RWtDRHRqN1Ryc0xFZzZyV3M3WmlFNjdhQUlPS0FsQ0RydUl6cm5ienNtckRzb0lBZzdKNlE2NCtaSU95WmhPdWpqT3F3Z0NEc2xZZ2c2NUNZNjRxVUlPMlptT3F5dlNEc29JVHNtcWtwQ2lBZ1puVnVZM1JwYjI0Z2IzQmxia3h2WjJsdVZHVnliV2x1WVd3b0tTQjdDaUFnSUNCN0NpQWdJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJQ0FnTHk4Z2MzUmhjblRxc0lBZzdJT0lJT3k5bU95R2xDRHNzTDNzbllRZzY2ZU02NU9nNjR1a0lDanJpNlRycHF6c25aZ2c3SWlvN0oyQUlPeTltT3lHbE9xenZDRHJyTFRxdElEdGxaanFzb3dnN0lLcw0KN0pxcDdKNlE3SmVRNnJLTUlPdXp0T3llaENrdUNpQWdJQ0FnSUNBZ0x5OGc3SjIwN0phMDdJU2NJRkJ2ZDJWeVUyaGxiR3dvTG5Cek1TbnNuYlFnTmV5MGlDRHJrcVFnNnJlNElPeXd2ZXlYa0NEc2w1VHRoTERycGJ3ZzY3TzA2NEswSURIcnNvZ282cldzNjQrRklPcXpoT3lnbFNuc25ZUWc3SjZRNjQrWklPeUVvTzJEbmUyVm1PcXpvQ3dLSUNBZ0lDQWdJQ0F2THlEc3NMM3NuWVFnN0xXYzdJYU03Wm1VN1pXMElPeUNyT3lhcWV5ZWtDRHJpSWpzbDVRZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1T3VuakNEcmdxanFzb3dnN1pXYzY0dWtMaURzc0wzc25ZUWc2NnE3SU95d3Z1eWN2T3VwdENEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU8yVm5PdUxwQW9nSUNBZ0lDQWdJQzh2SUNqcmk2VHJwYmdnN0xDOUlPeVlwT3llaGV1Z3BTRHJzS25zcDRBZzRvQ1VJT3EzdUNEcXNyM3NtckFnNjZtVTY0bTA2ckNBSU91enRPeWR0T3VLbENEc3NZVHJvWndnNjRLbzZyT2dJT3lDck95YXFleWVrT3F3Z0NEc2w1VHQNCmhMQWc3WldjSU91eWlDRHJpSVRycGJUcnFiUWc2NUNvS1M0S0lDQWdJQ0FnSUNBdkx5RHNvN3pzblpnNklHTnNZWFZrWmVxd2dDRHN2WmpzaHBRZzdLQ2M2NnFwN0oyRUlPdXdsT3ErdU91cHRDQkJjSEJCWTNScGRtRjBaUzlHYVc1a1YybHVaRzkzNnJDQUlPdXF1eURzc0w3c25ZUWc3SWlZSU95ZWlPeWRqQ0RpZ0pRZzdKeUk2NCtFN0pxd0lPeUxwT3E0c095WGtPeUVuQ0R0bVpYc25iZ2c3WldFN0pxVUxnb2dJQ0FnSUNBZ0lHTnZibk4wSUhCek1TQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ykc5bmFXNHVjSE14SnlrN0NpQWdJQ0FnSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXlod2N6RXNJRnNLSUNBZ0lDQWdJQ0FnSUNkVGRHRnlkQzFUYkdWbGNDQXRVMlZqYjI1a2N5QTFKeXdLSUNBZ0lDQWdJQ0FnSUNja2QzTWdQU0JPWlhjdFQySnFaV04wSUMxRGIyMVBZbXBsWTNRZ1YxTmpjbWx3ZEM1VGFHVnNiQ2NzQ2lBZ0lDQWdJQ0FnSUNBaWFXWWdLQ1IzDQpjeTVCY0hCQlkzUnBkbUYwWlNnblkyeGhkV1JsTFd4dloybHVKeWtwSUhzaUxBb2dJQ0FnSUNBZ0lDQWdJaUFnSkhkekxsTmxibVJMWlhsektDZCtKeWtpTEFvZ0lDQWdJQ0FnSUNBZ0p5QWdVM1JoY25RdFUyeGxaWEFnTFZObFkyOXVaSE1nTWljc0NpQWdJQ0FnSUNBZ0lDQWlJQ0JCWkdRdFZIbHdaU0F0VG1GdFpYTndZV05sSUZVZ0xVNWhiV1VnVnlBdFRXVnRZbVZ5UkdWbWFXNXBkR2x2YmlBblcwUnNiRWx0Y0c5eWRDaGNJblZ6WlhJek1pNWtiR3hjSWlsZElIQjFZbXhwWXlCemRHRjBhV01nWlhoMFpYSnVJRk41YzNSbGJTNUpiblJRZEhJZ1JtbHVaRmRwYm1SdmR5aHpkSEpwYm1jZ1l5d2djM1J5YVc1bklIUXBPeUJiUkd4c1NXMXdiM0owS0Z3aWRYTmxjak15TG1Sc2JGd2lLVjBnY0hWaWJHbGpJSE4wWVhScFl5QmxlSFJsY200Z1ltOXZiQ0JUYUc5M1YybHVaRzkzS0ZONWMzUmxiUzVKYm5SUWRISWdhQ3dnYVc1MElHNHBPeWNpTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdKR2dnUFNCYlZTNVhYVG82Um1sdQ0KWkZkcGJtUnZkeWhiVG5Wc2JGTjBjbWx1WjEwNk9sWmhiSFZsTENBblkyeGhkV1JsTFd4dloybHVKeWtpTEFvZ0lDQWdJQ0FnSUNBZ0p5QWdhV1lnS0NSb0lDMXVaU0JiVTNsemRHVnRMa2x1ZEZCMGNsMDZPbHBsY204cElIc2dXM1p2YVdSZFcxVXVWMTA2T2xOb2IzZFhhVzVrYjNjb0pHZ3NJRFlwSUgwbkxDQXZMeUEySUQwZ1UxZGZUVWxPU1UxSldrVUtJQ0FnSUNBZ0lDQWdJQ2Q5Snl3S0lDQWdJQ0FnSUNCZExtcHZhVzRvSjF4eVhHNG5LU0FySUNkY2NseHVKeWs3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdZbUYwSUQwZ2NHRjBhQzVxYjJsdUtHOXpMblJ0Y0dScGNpZ3BMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTMXNiMmRwYmk1aVlYUW5LVHNLSUNBZ0lDQWdJQ0JtY3k1M2NtbDBaVVpwYkdWVGVXNWpLR0poZEN3Z0owQmxZMmh2SUc5bVpseHlYRzRuSUNzS0lDQWdJQ0FnSUNBZ0lDZHpkR0Z5ZENBaVkyeGhkV1JsTFd4dloybHVJaUJqYldRZ0wyc2dZMnhoZFdSbElDOXNiMmRwYmx4eVhHNG5JQ3NLSUNBZ0lDQWcNCklDQWdJQ2R3YjNkbGNuTm9aV3hzSUMxT2IxQnliMlpwYkdVZ0xVVjRaV04xZEdsdmJsQnZiR2xqZVNCQ2VYQmhjM01nTFVacGJHVWdJaWNnS3lCd2N6RWdLeUFuSWx4eVhHNG5LVHNLSUNBZ0lDQWdJQ0J6Y0dGM2JpZ25ZMjFrSnl3Z1d5Y3ZZeWNzSUdKaGRGMHNJSHNnWlc1Mk9pQkRURUZWUkVWZlJVNVdMQ0J6ZEdScGJ6b2dKMmxuYm05eVpTY3NJSGRwYm1SdmQzTklhV1JsT2lCMGNuVmxJSDBwT3dvZ0lDQWdJQ0I5SUdWc2MyVWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZGtZWEozYVc0bktTQjdDaUFnSUNBZ0lDQWdMeThnY0hSNUtHVjRjR1ZqZENucm9ad2c2N08wNjRLNElPMkNwT3lYa0NEdGdiVHJvWnpyazV3Z1ZGVko2ckNBSU91c3RPdXdtT3lka2V5ZHVDRHFzb1BzbmJRZzdJdWs3TGloSU8yWmxleWR1T3VRcUNneU1ESTJMVEEzTENEc25ienJzSmdnWEhMQ3QydHBkSFI1SU95OWxPdVRuQ0RycXFqcmtaQXBJT0tBbEFvZ0lDQWdJQ0FnSUM4dklPeWNvT3lkdk8yVm5DRHNucERyDQpqNW50bVpRZzZySzk2NkdjNjRxVUlGTjVjM1JsYlNCRmRtVnVkSFBzblpnZzdLZUU3S2VjSU8yQ3BDRHNub1hyb0tVdUlPeWdrZXEzdk95RXNTRHF0b3p0bFp6c25iUWc3SjZJN0p5ODY2bTBJRGJzdElnZzY1S2tJT3lYbE8yRXNPcXdnQ0RzbnBEcmo1a2c3SjZGNjZDbDY0KzhDaUFnSUNBZ0lDQWdMeThnTWV1eWlDanF0YXpyajRVZzZyT0U3S0NWS2V5ZHRDRHNoS0R0ZzUzcmtKanFzNkFzSU9xMmpPMlZuT3lkdENEc2w0YnNuTHpycWJRZ2EyVjVjM1J5YjJ0bElPeWtoT3VuakNEc29iRHNtcW50bm9nZzdJdWs3WXlvN1pXMElPeUNyT3lhcWV5ZWtPcXdnQ0RzbDVUdGhMQWc3WldjSU91eWlDRHJpSVRycGJUcnFiUWc2NUNjNjR1a0tHWmhhV3d0YzI5bWRDa3VDaUFnSUNBZ0lDQWdMeThnN0plVTdZU3dJT3luZ2V5Z2hPeVhrQ0JVWlhKdGFXNWhiT3lkaENEcmk2VHNpNXdnN0pXZTdKeTg2NkdjSU9xd2dPeWd1T3laZ0NEcmk2VHJwYmdnN0pXeDdKZVFJTzJDcE9xd2dDRHJrNlRzbHJUcXNJRHJpcFFnNnJLRA0KN0oyRUlPdW5pZXVLbE91THBDNEtJQ0FnSUNBZ0lDQnpjR0YzYmlnbmIzTmhjMk55YVhCMEp5d2dXd29nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbFJsY20xcGJtRnNJaUIwYnlCa2J5QnpZM0pwY0hRZ0ltTnNZWFZrWlNBdmJHOW5hVzRpSnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdZV04wYVhaaGRHVW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlEWW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbFJsY20xcGJtRnNJaUIwYnlCaFkzUnBkbUYwWlNjc0NpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBblpHVnNZWGtnTUM0ekp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlRlWE4wWlcwZ1JYWmxiblJ6SWlCMGJ5QnJaWGx6ZEhKdmEyVWdjbVYwZFhKdUp5d0tJQ0FnSUNBZ0lDQWdJQzh2SU95WGxPMkUNCnNPcXdnQ0RzaTZUc29KenJvWndnNjVPazdKYTA2ckNFSU9xeXZleWFzT3lYa091bmpDRHNsNnpxdUxBZzY0K0U2NHVzS09xMmpPMlZuQ0RzbDRic25MenJxYlFnN0p5RTdKZVE3SVNjSU95a2tldUxxQ2tnNG9DVUlPMkVzT3V2dU91RWtPeWRoQ0RzdVpqc200d2c2N2lNNjUyODdKcXc3S0NBNjZlTUlPdUNxT3E0dE91THBBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURFdU5TY3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlWR1Z5YldsdVlXd2lJSFJ2SUhObGRDQnRhVzVwWVhSMWNtbDZaV1FnYjJZZ1puSnZiblFnZDJsdVpHOTNJSFJ2SUhSeWRXVW5MQW9nSUNBZ0lDQWdJRjBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE93b2dJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJtWVd4elpUc2dMeThnN0tlQTdKdVFJT3lWaUNEdGxaanJpcFFnVDFNS0lDQWdJQ0FnZlFvZ0lDQWdJQ0J5WlhSMWNtNGdkSEoxWlRzS0lDQWdJSDBLDQpJQ0I5Q2lBZ0x5OGc3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRHJvWnpxdDdqc2xZVHNtNE1nNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0R0bVlqc25aZ2dXK3Vobk9xM3VPeVZoT3liZzEwZzY3S0U3WXE4N0oyMElPMll1T3kybkM0Z1kyeGhkV1JsSUdGMWRHZ2diRzluYjNWMDdKeTg2NkdjSUVOTVNTRHJvWnpxdDdqc25ianNuWVFnN1pXMDdLQ2M3WldjNjR1a0xnb2dJQzh2SUNqc25iUWdVRVBzblpnZzdLQ0E3SjZsNjVDY0lPeWVrT3F5cWV5bW5ldXFoZXlkaENEc3A0RHNtclRyaTZRZzRvQ1VJT3VMcE95TG5DRHNrN0Ryb0tUcnFiUWc3SjZzNjZHYzZyZTQ3SjI0SU8yVmhPeWFsQzRwSU91aG5PcTN1T3lWaE95Ymd5RHRtNFRzbDVRZzdJUzQ3SVdZd3JmcXM0VHNvSlhzdXBEc2k1enJwYndnN0tDVjY2YXM3WldjNjR1a0xnb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OWpiR0YxWkdVdGJHOW5iM1YwSnlrZ2V3b2dJQ0FnWTI5dWMzUWdiRzhnUFNCeg0KY0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjI5MWRDZGRMQ0I3SUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUVOTVFWVkVSVjlGVGxZc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbElIMHBPd29nSUNBZ2JHVjBJR1Z5Y2lBOUlDY25Pd29nSUNBZ2JHOHVjM1JrWlhKeUxtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc2daWEp5SUNzOUlHUXVkRzlUZEhKcGJtY29LVHNnZlNrN0NpQWdJQ0JzYnk1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V5QnFjMjl1S0hKbGN5d2dOVEF3TENCN0lHOXJPaUJtWVd4elpTd2daWEp5YjNJNklDZnJvWnpxdDdqc2xZVHNtNE1nN0l1azdaYUpJT3lMcE8yTXFEb2dKeUFySUdVdWJXVnpjMkZuWlNCOUtUc2dmU2s3Q2lBZ0lDQnNieTV2YmlnblkyeHZjMlVuTENBb1kyOWtaU2tnUFQ0Z2V3b2dJQ0FnSUNCcmFXeHNVSEp2WXlncE95QWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0x5OGc2NkdjNnJlNDdKV0U3SnVENjVDY0lPcXpoT3lnbGV5ZGhDRHJyTHpyalpnZzY0eUENCjZyaXdJT3lFdU95Rm1PeWRoQ0Ryc29UcnByRHJpNlFLSUNBZ0lDQWdZV05qYjNWdWRFTmhZMmhsTG1GMElEMGdNRHNnSUNBZ0lDQWdJQzh2SU91THBPeWRqQ0F2WVdOamIzVnVkTUszTDJobFlXeDBhT3lYa095RW5DRHFzNFRzb0pYc25ZUWc3SU9JNjZHY0tEM3NsNGJzbll6c25MenJvWndwSU95ZHZlcXlqQW9nSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNCdWRXeHNPeUFnSUNBZ0lDQWdMeThnN0lPQjdZT2NJT3llck8yTWtPeWdsU2pyaTZUc25Zd2c3WVMwN0plUTdJU2NJT3V2dU91aG5PcTN1T3lkdUNEcXNKRHNwNEFwQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0pXRTdKdURJQ2hqYjJSbElDY2dLeUJqYjJSbElDc2dKeWtuS1RzS0lDQWdJQ0FnYVdZZ0tISmxjeTVvWldGa1pYSnpVMlZ1ZENrZ2NtVjBkWEp1T3lBdkx5Qmxjbkp2Y2lEdGxianJrNlRybjZ6cXNJQWc3SjIwNjYrNElPeWRrZXVMdGUyV2lPeWN2T3VwdENEc3BKSHJzN1VnDQo2N0NwN0tlQUNpQWdJQ0FnSUdsbUlDaGpiMlJsSUQwOVBTQXdLU0JxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxJSDBwT3dvZ0lDQWdJQ0JsYkhObElHcHpiMjRvY21WekxDQTFNREFzSUhzZ2IyczZJR1poYkhObExDQmxjbkp2Y2pvZ0tHVnljaTUwY21sdEtDa3VjMnhwWTJVb01Dd2dNVFV3S1NrZ2ZId2dLQ2Zzb29Ycm80d2c3TDJVNjVPY0lDY2dLeUJqYjJSbEtTQjlLVHNLSUNBZ0lIMHBPd29nSUNBZ2NtVjBkWEp1T3dvZ0lIMEtJQ0F2THlEc25wRHF1TEFnN0tLRjY2T01JT0tBbENEdGxJenJuNnpxdDdqc25iZ2dVMVJQVUY5Q1VrbEVSMFV2N1pXWTdZcTQ2N21FN1lxNDZyQ0FJTzJZdU95Mm5PMlZuT3VMcENBbzY2R2M3THVzN0plUTdJU2M2NmVNSU95Z2tlcTN2Q0Rxc0lEcmlxWHRsWmpyaTRnZzdKV0k3S0NFS1FvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5emFIVjBaRzkzYmljcElIc0tJQ0FnSUdwemIyNG9jbVZ6TENBeQ0KTURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tLRjY2T01JT3lhbE95eXJTRHJzSnZzbll3ZzRvQ1VJT3VMcE91bXJPdWx2Q0RyZ1pYcmk0anJpNlF1SnlrN0NpQWdJQ0JyYVd4c1VISnZZeWdwT3dvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrc0lESXdNQ2s3Q2lBZ0lDQnlaWFIxY200N0NpQWdmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl5WldOdmJXMWxibVFuS1NCN0NpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ2FXWWdLQ0YwWlhoMElIeDhJQ0ZUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKK3kybE95eW5PdXdtK3lkaENEcnJManF0YXpxc0lBZzY3bUU3SmEwSU95ZWlPeUsNCnRldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdMYVU3TEtjSU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnl3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NtRjNJRDBnWVhkaGFYUWdZWE5yUTJ4aGRXUmxLRk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2tzSUcxdlpHVnNLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MzVm5aMlZ6ZEdsdmJuTWdQU0J3WVhKelpWTjFaMmRsYzNScGIyNXpLSEpoZHlrN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnpkV2RuDQpaWE4wYVc5dWN5NXNaVzVuZEdncElIc0tJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5TTdJdXhJT3lMcE8yTXFDQW9KeUFySUhObFl5QXJJQ2R6S1RvbkxDQlRkSEpwYm1jb2NtRjNLUzV6YkdsalpTZ3dMQ0F5TURBcEtUc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c2xZZ2dKeUFySUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBcklDZnFzSndnS0NjZ0t5QnpaV01nS3lBbmN5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3dvZ0lDQWdJQ0J6ZEdGMA0KY3k1c1lYTjBWR1Y0ZENBOUlGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0F6TUNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJSE4xWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUNmdGdiVHJvWnpyazV3ZzdaaTQ3TGFjSU95THBPMk1xRG9nSnlrcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlEdGpKM3NsNFVnN0pxVTdJYU02N09FSU95MmxPeXluQ0RpZ0pRZzdaV2NJTzJNbmV5WGhleWRtQ0RxdGF6c2hMSHNtcFRzaG93bzdKZXQ3WldnSyt1c3VPcTFyQ25ycGJ3ZzdaV2NJT3V5aU95WGtDRHJzSnZzbFlRZzdKZXQNCjdaV2c2N09FNjZHY0lPdUxwT3VUck91S2xPdUxwQzRLSUNBdkx5RHNtcFRzaG96cnBid2c3WldvNnJ1WUlPdXp0T3VDdE95VnZDRHRnNERzbmJUdGk0RHNuYlFnNjdPNDY2eTRJT3VucGV1ZHZleWRoQ0Rzc0xqc29iRHRsYUFnN0lpWUlPeWVpT3VMcENqc21wVHNob3pyczRRZzZyQ2M2N09FSU95YWxPeXlyZXF6dk95ZG1DRHNzS2pzbmJRcExnb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXlaV052YlcxbGJtUXRjRzl3ZFhBbktTQjdDaUFnSUNCamIyNXpkQ0I3SUdWc1pXMWxiblJ6TENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0dWc1pXMWxiblJ6S1NBL0lHVnNaVzFsYm5SekxtWnBiSFJsY2lnb1pTa2dQVDRnWlNBbUppQlRkSEpwYm1jb1pTNTBaWGgwSUh4OElDY25LUzUwY21sdEtDa3BJRG9nVzEwN0NpQWdJQ0JwWmlBb2JHbHpkQzVzDQpaVzVuZEdnZ1BDQXlLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0orMk1uZXlYaFNEc21wVHNob3pxc0lBZzY3YUE3S0d4N1pXcDY0dUk2NHVrTGljZ2ZTazdDaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpKM3NsNFVnN0xhVTdMS2NJT3lhbE95eXJUb2c3SnFVN0lhTUlDY2dLeUJzYVhOMExteGxibWQwYUNBcklDZnFzSnduTENCdGIyUmxiQ0EvSUNjbzY2cW82NDI0T2lBbklDc2diVzlrWld3Z0t5QW5LU2NnT2lBbkp5azdDaUFnSUNCMGNua2dld29nSUNBZ0lDQmpiMjV6ZENCeVlYY2dQU0JoZDJGcGRDQmhjMnRRYjNCMWNDaHNhWE4wTENCdGIyUmxiQ2s3Q2lBZ0lDQWdJR052Ym5OMElITmxkSE1nUFNCd1lYSnpaVkJ2Y0hWd0tISmhkeWs3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobA0KWkNneEtUc0tJQ0FnSUNBZ2FXWWdLQ0Z6WlhSektTQjdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTW5leVhoU0R0akl6c2k3RWc3SXVrN1l5b0lDZ25JQ3NnYzJWaklDc2dKM01wT2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJREl3TUNrcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNbmV5WGhTRHNoTGp0aXJnZ0p5QXJJSE5sZEhNdWJHVnVaM1JvSUNzZ0orcXduQ0FvSnlBcklITmxZeUFySUNkektTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFMNCkp5azdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ0oxdnRqSjNzbDRWZElDY2dLeUJUZEhKcGJtY29LR3hwYzNSYk1GMGdKaVlnYkdsemRGc3dYUzUwWlhoMEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z01qUXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCelpYUnpMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZeWQ3SmVGSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFZzRvQ1VJT3lEZ2UyWnFleWRoQ0RzDQpoS1RycW9YdGxaanJxYlFnNjZ5NDZyV3M2Nlc4SU91bmpPdVRwT3lXdE95a2dPdUxwQ0FvN0xhVTdMS2M2ck84SU9xd21leWRnQ0RzaExqc2haZ3NJT3VNZ08yWmxPdUtsQ0RycDZRZzdKcVU3TEt0N0plUUlPMkd0ZXludU91aG5DRHNpNlRycHJ3cENpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyTnZiWEJ2YzJVbktTQjdDaUFnSUNCamIyNXpkQ0I3SUcxbGMzTmhaMlZ6TENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0cxbGMzTmhaMlZ6S1NBL0lHMWxjM05oWjJWekxtWnBiSFJsY2lnb2JTa2dQVDRnYlNBbUppQlRkSEpwYm1jb2JTNTBaWGgwSUh4OElDY25LUzUwY21sdEtDa3BJRG9nVzEwN0NpQWdJQ0JwWmlBb0lXeHBjM1F1YkdWdVozUm9LU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0ordU1nTzJabENEcg0KZ3JUc21xbnNuYlFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emRDQnNZWE4wVlhObGNpQTlJRnN1TGk1c2FYTjBYUzV5WlhabGNuTmxLQ2t1Wm1sdVpDZ29iU2tnUFQ0Z2JTNXliMnhsSUNFOVBTQW5ZWE56YVhOMFlXNTBKeWs3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJT3VNZ08yWmxDRHNtcFRzc3EwNkp5d2dVM1J5YVc1bktDaHNZWE4wVlhObGNpQW1KaUJzWVhOMFZYTmxjaTUwWlhoMEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z05UQXBMbkpsY0d4aFkyVW9MMXh1TDJjc0lDY2dKeWtnS3lBbjRvQ21JQ2pyaklEdG1aUWdKeUFySUd4cGMzUXViR1Z1WjNSb0lDc2dKK3F3bkNrbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhKaGR5QTlJR0YzWVdsMElHRnphME52YlhCdmMyVW9iR2x6ZEM1emJHbGpaU2d0TVRJcExDQnRiMlJsYkNrN0lDOHYNCklPdU1nTzJabE9xd2dDRHF1TGpzbHJUc3A0RHJxYlFnN0xXYzZyZThJREV5NnJDYzY2ZU1JQ2p0bElUcm9henRsSVR0aXJnZzdZK3Q3S084SU91d3FleW5nQ2tLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY0dGeWMyVkRiMjF3YjNObEtISmhkeWs3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGdmRYUXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU8yTWpPeUxzU0RzaTZUdGpLZ2dLQ2NnS3lCelpXTWdLeUFuY3lrNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTWpBd0tTazdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nDQpJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPeWRrZXVMdFNBb0p5QXJJSE5sWXlBcklDZHpMQ0Rzb0p6c2xZZ2dKeUFySUc5MWRDNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dLeUFuNnJDY0tTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktDaHNZWE4wVlhObGNpQW1KaUJzWVhOMFZYTmxjaTUwWlhoMEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCeVpYQnNlVG9nYjNWMExuSmxjR3g1TENCemRXZG5aWE4wYVc5dWN6b2diM1YwTG5OMVoyZGxjM1JwYjI1ekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbg0KSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU8yWXVPeTJuQ0RzaTZUdGpLZzZJQ2NwS1RzS0lDQWdJSDBLSUNCOUNpQWdMeThnNjdLSTdKZXRJT0tBbENEdGxaenF0YTNzbHJRZzRvYVVJT3lZZ2V5V3RDRHNucERyajVrZ0tPeTJsT3l5bk9xenZDRHFzSm5zbllBZzdJUzQ3SVdZSU95Q3JPeWFxU2tLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZEhKaGJuTnNZWFJsSnlrZ2V3b2dJQ0FnWTI5dWMzUWdleUIwWlhoMExDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHbG1JQ2doZEdWNGRDQjhmQ0FoVTNSeWFXNW5LSFJsZUhRcExuUnkNCmFXMG9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnJzb2pzbDYzdGxhQWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTI5dWMzUWdjbUYzSUQwZ1lYZGhhWFFnWVhOclZISmhibk5zWVhSbEtGTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3NJRzF2WkdWc0tUc0tJQ0FnSUNBZ1kyOXVjM1FnYjNWMElEMGdjR0Z5YzJWVWNtRnVjMnhoZEdVb2NtRjNLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwDQplR1ZrS0RFcE93b2dJQ0FnSUNCcFppQW9JVzkxZENrZ2V3b2dJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryc29qc2w2MGc3WXlNN0l1eElPeUxwTzJNcUNBb0p5QXJJSE5sWXlBcklDZHpLVG9uTENCVGRISnBibWNvY21GM0tTNXpiR2xqWlNnd0xDQXlNREFwS1RzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVRuQ0Ryc29qc2w2MGc3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95WmhPdWpqQ0FvSnlBcklITmxZeUFySUNkekxDQW5JQ3NnS0c5MWRDNWthWEpsWTNScGIyNGdmSHdnSno4bktTQXJJQ2NwSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbk5sY25abFpDc3JPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bA0KVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCMGNtRnVjMnhoZEdWa09pQnZkWFF1ZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dU9pQnZkWFF1WkdseVpXTjBhVzl1TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N0tJN0pldElPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzaTZUdGpLZzZJQ2NwS1RzS0lDQWdJSDBLSUNCOUNpQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTANCk1EUXNJSHNnWlhKeWIzSTZJQ2RPYjNRZ1ptOTFibVFuSUgwcE93cDlLVHNLQ2k4dklPeWR0T3V2dUNEcmk2VHJwcXpxc0lBZzY1YWdJT3llaU91S2xPdU5zQ0RybUpBZzdMeWM2cml3NnJDQUlPdVRwT3lXdE95WXBPdXB0Q2pzb0p6c2lxVHNzcGdnN0o2UTY0K1pJT3k4bk9xNHNDRHNwSkhyczdVZzY1T3hLU0Rzb2JEc21xbnRub2dnN0tLRjY2T01JT0tBbENEcmo0enJqWmdnNjR1azY2YXM2NHFVSU9xM3VPdU1nT3VobkNEc25LRHNwNEFLYzJWeWRtVnlMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUI3Q2lBZ2FXWWdLR1VnSmlZZ1pTNWpiMlJsSUQwOVBTQW5SVUZFUkZKSlRsVlRSU2NwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc25iVHJyN2dnN0x5YzdLQzRJT3llaU95V3RPeWFsQ2p0ajZ6dGlyZ2dKeUFySUZCUFVsUWdLeUFuSU95Q3JPeWFxU0RzcEpFcElPS0FsQ0RzbmJRZzdKMjQ3SXFrN1lTMDdJcWs2NHFVSU95aWhldWpqTzJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJSEJ5DQpiMk5sYzNNdVpYaHBkQ2d3S1RzS0lDQjlDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUVuT3V5aENEc21LVHJwWmc2Snl3Z1pTQW1KaUJsTG0xbGMzTmhaMlVwT3dvZ0lIQnliMk5sYzNNdVpYaHBkQ2d4S1RzS2ZTazdDaTh2SU95V3RPdVdwQ0Rxc3Izcm9aenJvWndnN0tPOTY1T2dLT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFzSUVOMGNtd3JReXdnTDNOb2RYUmtiM2R1TENEc21LVHJwWmdwSUdOc1lYVmtaU0RzbnBEc2k1M3NuWVFnNjRLbzZyaXc3S2VBSU95Vml1dUtsT3VMcEFwd2NtOWpaWE56TG05dUtDZGxlR2wwSnl3Z0tDa2dQVDRnZXlCcmFXeHNVSEp2WXlncE95QnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lIMHBPd3B3Y205alpYTnpMbTl1S0NkVFNVZEpUbFFuTENBb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3BPd3B3Y205alpYTnpMbTl1S0NkVFNVZFVSVkpOSnl3Z0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBLVHNLQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Zw0KSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzS0lDQmpiMjV6YjJ4bExteHZaeWduNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0p5RHRnYlRyb1p6cms1d2c2NHVrNjZhc0lPeThuT3lua0NEaWdKUWdhSFIwY0RvdkwyeHZZMkZzYUc5emREb25JQ3NnVUU5U1ZDazdDaUFnWTI5dWMyOXNaUzVzYjJjb0p5RHJxcWpyamJnNklDY2dLeUJEVEVGVlJFVmZUVTlFUlV3Z0t5QW5JTUszSU95WWlPeUxuQ0FuSUNzZ1JWaEJUVkJNUlZNdWJHVnVaM1JvSUNzZ0orcXh0Q0RzbnFYc3NLa25LVHNLSUNCamIyNXpiMnhsTG14dlp5Z25JT3lkdENEc3NMM3NuWVFnN0x5YzY1R1VJT3VQbWV5VmlDRHQNCmxMenF0N2pycDRnZzdaU002NStzNnJlNDdKMjQ3SjIwSU8yQnRPdWhuT3VUbk91aG5DRHN0cFRzc3B6dGxhbnJpNGpyaTZRdUp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0orS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTm9aV05yUTJ4aGRXUmxRWFpoYVd4aFlteGxLQ2s3SUM4dklFTnNZWFZrWlNCRGIyUmxJT3lDck95YXFTRHFzSURyaXFVZzdKZXM2N2FBSU95Z2tPcXlnQ0FvN1pTTTY1K3M2cmU0N0oyNElPeVZpT3VDdE95YXFTa0tJQ0F2THlEcnI3anJwcXdnN0l1YzY0K1pJQ3NnN0tlQTdJdWM2Nnk0SU95anZPeWVoU0RpZ0pRZzdMS3JJT3kybE95eW5PdTJnTzJFc0NEcnVhRHJwYlRxc293S0lDQmhjMnREDQpiR0YxWkdVb0oreWJqT3V3amV5WGhUb2dJdXlnZ095ZXBTRHJrSmpzbDRqc2lyWHJpNGpyaTZRaUp5a3VkR2hsYmlnS0lDQWdJQ2dwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbTR6cnNJM3NsNFVnN0ptRTY2T01JT0tBbENEc3RwVHNzcHdnN0tTQTY3bUVJT3VCblM0bktTd0tJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeUxwTzJNcUNBbzdMS3JJT3lhbE95eXJTRHJsWXdnN0o2czdJdWM2NCtFS1RvbkxDQmxMbTFsYzNOaFoyVXBDaUFnS1RzS2ZTazdDZz09DQo6OkVYQU1QTEVTOjoNCkl5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzDQpwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydA0KbGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWENCmxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVDQo3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TA0Kbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXkNCmhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVDQo3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3Zw0KN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVcNCnRPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWDQptT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIcw0KbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0kNCjdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnDQo3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvag0KSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVANCm1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyDQpvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8ySw0KdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVYNCmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyDQppNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Qw0KdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXcNCmdDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzDQpuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRQ0KN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHMNCm5JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhDQpsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMA0KSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzMNCjZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzDQppSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEcw0KaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGcNCjdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhDQpxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqcw0KbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjANCklPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVoDQpuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMA0KN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTANCjY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RyDQpwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZw0KNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXcNCnZ1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLDQpMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZw0KN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHINCnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVDQpQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aA0KbkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0NCjo6R1VJREU6Og0KSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5Bb0tJeU1nTVM0ZzdaVzA3SnFVN0xLMENncnNvSnp0a29nZzdKV0k3SjJZSU91cXFPdVRvQ0RyckxqcXRhenJpcFFnSisyVnRPeWFsT3l5dENmcm9ad2c3STJvN0pxVUxncnNuYnpxdElEc2hMRWc3SjZJNjRxVUlPeUNyT3lhcWV5ZWtDRHFzcjN0bDVqc25ZUWc2NmVNNjVPa0lPeUltQ0Rzbm9qcmo0VHJvWjBnS2lyc2c0SHRtYWtzSU91bnBldWR2ZXlkaENEcnRvanJyTGp0bFpqcXM2QWc2NnFvNjVPZ0lPdXN1T3Exck95WGtDRHRsYlRzbXBUc3NyVHJwYndnN0tDQjdKcXA3WlcwN0tPODdJUzQ3SnFVTGlvcUNncnNtSWdwQ2kwZzY3TzA2NE9GNjR1STY0dWtJT0tHa2lEcnM3VHJncnpxc296c21wUUtDaW9xS2dvS0l5TWdNaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0FvSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEc3RaenJqSUR0bFp3Z0tpcnJpcVhyajVudG1KVWc2Nnk0N0o2bEtpcnNuWVFnN0kybzdLTzg3SVM0N0pxVUxpRHNpSmpyajVudG1KVWcNCjY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRFdDdJaVk2NCtaN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2s3RHJpcFFnNnJLTUlPeWlpK3lWaE95YWxDNEtDaU1qSXlEcmtKRHNsclRzbXBRZzRvYVNJTzJXaU95V3RPeWFsQW9LN0ppSUtRb3RJT3lFcE95Z2xldVFrT3lXdE95YWxDRGlocElnN0lTazdLQ1Y3WmFJN0phMDdKcVVDZ29qSXlNZ0ozN3NsNGduSU91NXZPcTRzQW9LN0ppSUtRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVUNnb2pJeU1nNjQrWjdJS3NJT3V3bE9xL2xPeVRzT3E0c0FvSzdKaUlLUW90SU91R2t1eVZoT3loak95V3RPeWFsQ0RpaHBJZzdKaXM2NTZRN0phMDdKcVVDZ29xS2lvS0NpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBS0N1eWduTzJTaUNEc2xZanNsNURzaEp3ZzY3YUE3S0NWN0tDQklPeTdwT3V1DQpwT3VMaU95OGdPeWR0T3lGbU95ZGhDRHN0WnpyaklEdGxad2c3S1NFN0oyMDZyT2dJT3E0amV5Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzdLTzg3SVM0N0pxVUxncnJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUTXQ2N2FBN0tDVjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNqYWpzbXBRdUNncnNtSWdnT2lEc2xZZ2c2NCs4N0pxVUxDRHNsNGJzbHJUc21wUWdLRmdwSU9LR2tpQis3WldZNjZtMElPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUlDaFBLUW9LSXlNaklPeVhodXlXdE95YWxDRGlocElnN0o2STdKYTA3SnFVQ2dyc21JZ3BDaTBnNjdPMDdaaTQ3SjZRNnJDQUlPMlhpT3VkdmUyVm1PcTRzQ0Rzb0lUc2w1RHJpcFFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUWc0b2FTSU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQQ0KN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRS0NpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFDZ3JzbDVEcm42d2c3SU9CN1ptcDdKZVE3SVNjNjQrRUlDTHRsYlRxc3JBZzY3Q3A2N0tWSXV5ZGhDRHJxTHpzb0lBZzdKV002NkNrN0tPODY0cVVJT3E0amV5Z2xlMllsU0RxdGF6c29iRHJvWndnN0kybzdKcVVMZ29LN0ppSUtRb3RJT3luZ09xNGlDRHJzb1Rzb0lUc2w1RHNoSnpyaXBRZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeVZzZXlkaENEc3RaenNpNkFnNjdLRTdLQ0U3Snk4NjZHY0lPeVhoZXVOc095ZHRPMkt1Q0R0bGJUc283enNoTGpzbXBRdUlPS0draURzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMDdLTzg3SVM0N0pxVUxpRHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2pvNk9pQjBhWEFnN1l5ZDdKZUZJT3V5aE8yS3ZPeWQNCmdDQmJPQzRnN1l5ZDdKZUZYU0RxdDV6c3VabnNuWVFnNjVTdzY1Mjg3SnFVQ3UyTW5leVhoU2pyaTZUc25iVHNscnpyb1p6cXQ3Z3BJT3V5aE8yS3ZDRHJyTGpxdGF6cmlwUWc3SldFNjU2WUlDb3FPQzRnN1l5ZDdKZUZLaW9nN0lTNTdJV1lJT3Ezbk95NW1leWRoQ0RybExEcm5ienNtcFFnNG9DVUlPMkd0ZXV6dE91S2xDQmI3Wm1WN0oyNFhTd2c3SmlJTCt5VmhPdUxpT3lZcENEdGpKRHJpNmpzbllBZ1creVZoT3VMaU95WXBGM0N0MXZyaEtSZExDRHJqNW5zbnBFZzdKeWc2NCtFNjRxVUlGdnN0NmpzaG94ZHdyZGI2NCtaN0o2UlhTNGdJdXkzcU95R2pDTHJpcFFnNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUlPeVRzT3F6b0N3Z0l1dUxxK3E0c0NEQ3R5RHJqNW5zbnBFaTdMS1k2NSs4SU95bm5leWR0Q0RzbFlnZzY2ZWU2NHFVSU95aHNPMlZxZXlkZ0NEc2s3RHNwNEFnN0pXSzdKV0U3SnFVTGdvNk9qb0tDaU1qSXlEdG1KenRnNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzDQpuWVFnNjVXTUNncnNtSWdwQ2kwZzY2cW83SjZFN0tlQTdKdVE2cmlJSU95WGh1eWR0Q0RycXFqc25vVHRoclhzbnFYc25ZUWc2NmVNNjVPazZybU03SnFVUHlEc3A0RHF1SWdnNjdDYjdLZUFJT3lWaXV5Y3ZPdXB0Q0RycXFqc25vVHNwNERzbTVEcXVJanNuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUlPS0draURzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRtSnp0ZzUwZzY0eUE3SU9CSU95VmlPdUN0QW9LS2lyc2hKenJ1WVRzaXFUcmlwUWc3Sk80SU95SW1DRHNub2pzcDREcnA0d3NJTzJLdWV5Z2xTRHRtSnp0ZzUzc25ZQWc2N0NiN0oyRUlPeUltQ0RzbDRic25ZUWc2NVdNSU9LR2tpRHF1STNzb0pYdG1KVWc2Nnk0N0o2bDdKeTg2NkdjSU95TnFPeWFsQzRxS2dyc2dxenNtcW5zbnBEcmlwUWc2Nnk0NnJXczY2VzhJT3E4dk9xOHZPMmVpQ0RzbmIzc3A0QWc3SldLNnJPZw0KSU8yYmtleVd0T3V6dE9xNHNDanNpcVRzdXBRcElPdVZqT3VzdU95WGtDd2c2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeVRzT3VwdENEc29KenRrb2dnN0tDRTdMSzA2Nlc4SU95VHVDRHNpSmdnN0plRzY0dWs2ck9nSU95WXBPMlZ0TzJWbU9xNHNDRHNpYXpzbTR6c21wUXVDZ3JzbUlncENpMGc2ck9FN0tLTUlPcXduT3lFcENEdG1KenRnNTNzbllBZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVJT0tHa2lBMExqVWxJT3E0aU91bXJDRHRtSnp0ZzUzcnA0d2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvcUtpb0tDaU1qSURRdUlPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUUtDdXlnbk8yU2lDRHNsWWpzbDVEc2hKd2dKMzdzaTV6cXNxRHNsclRzbXBRL0p5d2dKK3lMbk91Q21PeWFsRDhuTENBbmZ1cTdtQ2NnNnJDWjdKMkFJT3F6dk91UGhPMlZuQ0Rxc3Izc2xyVHJwYndnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzRLN0xXYzY0eUE3WldjSU95NmtPeWp2T3lXdk8yVm1PcXpvQ0RzdVp6cXQ3enQNCmxad2c2NmVRN1lpczY2VzhJT3lUc091S2xDRHFzb3dnN0tLTDdKV0U3SnFVTGdycXNyM3NsclRyaXBRZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TWkzcXNyM3NsclRycGJ3dDdJMm82NCtFTGV1UW1PdUtsQzNxc3Izc21yQXA3SmVRSU8yVnRPdUx1ZTJWb0NEcmxZenJwNHdnN0kybzdKcVVMZ29LSXlNaklPdVBtZXlDck95WGtPeUVuQ0FuZnV5TG5DY2c2N204NnJpd0NncnNtSWdwQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm1PeUxuT3F5b095V3RPeWFsRDhnNG9hU0lPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxhRHF1WXpzbXBRL0NpMGc3SXVjN0o2UjdaV1k3SXVjNjRxVUlPdTJoT3lYa09xeWpDQTFMREF3TU95YmtPeWRoQ0RyazV6cm9LVHNtcFF1SU9LR2tpRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSUNmcXM0VHNpNXpyaTZRbklPS0draUFuN0o2STY0dWtKd29LN0ppSUtRb3RJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxDQpzNkFnNnJPRTdJdWM2NEtZN0pxVVB5RGlocElnN0o2UTY0K1o3TENvNnJDQUlPeWVpT3VDbU95YWxEOEtMU0RycDZUcmk2d2c2N08wN1plWTY2T01JT3lXdk91bmlPeVVxU0RyZ3JUcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdUtsQ0RzbHJ6cnA0anNuYmpxc0lEc21wUS9JQ29vNjR1bzdJaWNJT3k1bU8yWm1PeWR0Q0RzbFlUcmk0anJuYndnNjZ5NDdKNmw3SjJFSU95RGlPdWhuQ0RzazdRZzdJS3M2NkdBN0ppSTdKcVVLU29LQ2lNakl5QW43SmVzN0sySTY0dWtKeURpaHBJZ0orMlpsZXlkdU8yVm1PdUxwQ3dnNjZ5NzY0dWtKd29LN0ppSUtRb3RJT3lWaU95Z2hPMlZuQ0Rxc0p6dGhyWHNuWVFnN0p5RTdaVzBJT3VxaCtxd2dPeW5nQ0RyaTZUc2k1d2c3SmVzN0syazY3Tzg2cktNN0pxVUxpRGlocElnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSDZyQ0E3S2VBSU91THBPeUxuQ0R0bVpYc25ianRsYURxc296c21wUXVDZ29qSXlNZw0KSitxN21DY2c0b2FTSUNmc2w1RHFzb3duQ2dyc21JZ3BDaTBnN1ptTjZyaTQ2NCtaNjR1WTZydVlJT3VDb095VmhPcXdnT3F6b0NEc25vanNsclRzbXBRdUlPS0draUR0bVkzcXVManJqNW5yaTVqc2w1RHFzb3dnNjRLZzdKV0U2ckNBNnJPZ0lPeWVpT3lXdE95YWxDNEtDaU1qSXlEcXNyM3NsclRycGJ3ZzY3cVE3SjJFSU91VmpDRHNsclRzZzRudGxad2c2cks5N0pxd0NncnNncXpzbXFuc25wRHNuWmdnN0tDVjY3TzA2Nlc4SU91d20rdUtsQ0RzcDRqcnJManNsNURzaEp3ZzZyaXc2ck9FN0tDQjdKeTg2NkdjSUNkKzdJdWNKK3VsdkNEcnVwRHNuWVFnNjVXTUlPdXN1T3llcGV5ZHRDRHNsclRzZzRudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0tpcnRqSXpzbFlYdGxaanFzNkFnN0l1MjdKMkFJT3lnbGV1enRPdWx2Q0FuN0tPODdKYTBKK3VobkNEc2phanNoSndnNjZ5NDdKNmw3SjJFSU95RGlPdWhyZXF5akNEc2phanJzN1RzaExqc21wUXVLaW9LQ3V5WWlDa0tMU0RzbHJUcmxxUWc2NnFwN0tDQjdKeTgNCjY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VNZ095Mm5DRHJxcW5zb0lIc25iUWc2NnkwN0plSDdKMjQ2ckNBN0pxVVB3b3RJT3lXdE91V3BDRHNuYlRzbktEcm9ad2c3SXVnNnJPZzdaV1k3SXVjNjRLWTdKcVVQeURpaHBJZzdJdWc2ck9nSU95ZHRPeWNvT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tLaW9xQ2dvakl5QTFMaUFuZSt1cWhleUNySDBnS3lCNzY2cUY3SUtzZlNjZzdKT3c3S2VBSU95Vml1cTRzQW9LSXlNaklPMlZuT3lla095V3RDRHRrb0RzbHJUc2s3RHF1TEFLQ3UyVm5PeWVrT3lXdENEcnFvWHNncXpycGJ3ZzdaS0E3SmEwN0lTY0lPdVBtZXlDckNEdG1KWHRnNXpyb1p3ZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdKMjA3SjZRSU8yWm1PdTJpT3lkaENEcnNKdnNsWmpzbHJUc21wUWc0b2FTSU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRS0xTRHJnclRzbmJ3ZzdMbTA2NU9jNnJDUzdKMjBJT3F5DQpzT3lnbk91UW9DRHNtSWpzb0pYc25iVHNsNURzbXBRZzRvYVNJT3VDdE95ZHZPeWRnQ0RzdWJUcms1enFzSklnNjRLWTZyQ0E2NHFVSU91Q29PeWR0T3lYa095YWxBb0tJeU1qSU8yVm5PeWVrT3lXdE91bHZDRHRrb0RzbHJUc2s3RHF1TEFnN0phMDY2Q2s3SnE0SU9xeXZleWFzQW9LSjN2cnFvWHNncXg5NnJDQUlIdnJxb1hzZ3F4OTdaVzA3SVNjSnlEdG1KWHRnNXpyb1p6cnA0d2c3WktBN0phMDdLU1k2NCtFSU91TmxDRHN1cERzbzd6c2xyenRsWmpxc293ZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUlPS0draURzbnBUc2xhSHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPcTFyT3VucE8yVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRS0Npb3FLZ29LSXlNZ05pNGc3WkdjNnJpd0lPMkd0ZXlkdkFvS0l5TWpJT3VRbU95V3RPeWFsQ0FvV0NrZzRvYVNJT3VQdk95YWxDQW9UeWtLQ3V1cQ0KcU91d2xPeWR2Q0R0bVpUcnFiVHNuWmdnN0tLQjdKMkFJT3F6dGVxd2hPeWRoQ0RxczZEcm9LVHRsYlFnSit1UW1PeVd0T3lhbENmcmlwUWc2NnFvNjVHUUlDZnJqN3pzbXBRbjY2R2NJTzJHdGV5ZHZPMlZ0T3lFbkNEc2phanNvN3pzaExqc21wUXVDZ29xS2lvS0NpTWpJRGN1SU91Q29PeW5uTUszN0l1YzZyQ0V3cmZzaUt2c25wQWc3WkdjNnJpd0NncnJncURzcDV6Q3QreUxuT3F3aE1LMzY3S0k3Wmk0NjRxVUlPeVZoT3VlbUNEdG1KWHNpNTNzbkx6cm9ad2c3WWExN0oyODdaVzA3SVNjSU95TnFPeWFsQzRLQ2lNakl5RHJncURzcDV6Q3QreUxuT3F3aE1LMzZyaXc2ckNFQ2dwOElPMlZyZXVxcVNCOElPMllsZXlMblNCOElPeVlpT3lMbkNCOENud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdLZkNEcmdxRHNwNXdnZkNEcXVMRHJzN2dnWUZsWldWa3VUVTB1UkVSZ0lDOGc3S2VuNnJLTUlHQk5UUzVFUkdBZ2ZDQXlNREkxTGpBeExqQXhMQ0F5TlM0d01TNHdNU0I4Q253ZzdJdWM2ckNFSUh3ZzZyaXcNCjY3TzRJR0JJU0RwTlRUcFRVMkFnTHlEc3A2ZnFzb3dnWUVoSU9rMU5ZQ0FvN0ppazdLQ0VMK3lZcE8yYmhDRHNsWWdnN0pTQUtTQjhJREUwT2pNd09qRXhMQ0F4TXpvek1DQjhDbndnNnJpdzZyQ0VJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFZmxsWldWa3VUVTB1UkVSZ0lDOGc3S2VuNnJLTUlHQlpXVmxaTGsxTkxrUkVmazFOTGtSRVlDQjhJREl3TWpVdU1ERXVNREYrTWpBeU5TNHdNUzR6TVN3Z01qQXlOUzR3TVM0d01YNHdNUzR6TVNCOENud2c2NEtnN0tlY0lDc2c3SXVjNnJDRUlId2dZRmxaV1ZrdVRVMHVSRVFnU0VnNlRVMWdJSHdnTWpBeU5TNHdNUzR3TVNBeE5Eb3pNQ0I4Q253ZzdKcVU3SjI4SUh3Z1lGbFpXVmt1VFUwdVJFUW83SnFVN0oyOEtXQWc0b0NVSU95YmxDL3RtWlF2N0lpWUwrdXFxUy9xdUlndjdZYWdMK3lkdkNCOElESXdNalV1TURFdU1ERW83SWlZS1NCOENnb3FLdXlMbk9xd2hDRHNtSWpzbWJncUtqb2c3SUtzN0pxcDdKNlE2ckNBSU95bmdleWdrU0RxczZEcnBiVHJpcFFnDQo2N0NwNjZ5NHdyZnNtSWpzbGIwZzdJdWM2ckNFN0oyQUlHRHNtS1Rzb0lRdjdKaWs3WnVFSUVnNlRVMWc3SjJFSU95TnFPdVBoQ0Ryajd6c21wUXVDdXlZaUNrZzdKaWs3WnVFSURFNk1EQUtDaU1qSXlEcnJManNucVVnN0lhTklPeVhzT3libE95ZHZBb0s2Nnk0N0o2bElPeVZpT3lYa095RW5PdUtsQ0FxS3V5YmxNSzM3SjI4SU95Vm51eWRtQ0F3N0oyRUlPdTV2T3F6b0NvcUlPeU5xT3lhbEM0S0N1eVlpQ2tLTFNBeU1ESTI2NFdFSURBNDdKdVVJREExN0oyOElPeWVoZXVMaU91THBDNGc0b2FTSURJd01qYnJoWVFnT095YmxDQTE3SjI4SU95ZWhldUxpT3VMcEM0S0NpTWpJeURzZzRIcmpJQWc3SXVjNnJDRUlDanJoYmpzdHB6c21xa3BDZ3A4SU95aHNPcXh0Q0I4SU8yUm5PcTRzQ0I4Q253dExTMHRMUzE4TFMwdExTMHRmQXA4SURZdzdMU0lJT3V2dU91bmpDQjhJT3V3cWVxNGlDRHNvSVFnZkFwOElEWXc2N2FFSU91dnVPdW5qQ0I4SUU3cnRvUWc3S0NFSUh3S2ZDQXlOT3lMbk9xd2hDRHJyN2pycDR3Zw0KZkNCTzdJdWM2ckNFSU95Z2hDQjhDbndnTXpEc25id2c2Nis0NjZlTUlId2dUdXlkdkNEc29JUWdmQXA4SURFeTZyQ2M3SnVVSU91dnVPdW5qQ0I4SUU3cXNKenNtNVFnN0tDRUlId0tmQ0F4TXVxd25PeWJsQ0RzbmJUc2c0RWdmQ0JPNjRXRUlPeWdoQ0I4Q2dyc21JZ3BJT3V3cWVxNGlDRHNvSVFzSURYcnRvUWc3S0NFTENBeTdJdWM2ckNFSU95Z2hDd2dNK3lkdkNEc29JUXNJRGJxc0p6c201UWc3S0NFTENBeTY0V0VJT3lnaEFvS0l5TWpJT3VuaU9xd2tNSzM2cml3NnJDRUlPdW5qT3VqakFvS1lFUXRUbUFvVHV5ZHZDRHJncWpzbll3cElDOGdZRVF0TUdBbzdKaWs2NHFZSU91bmlPcXdrQ2tnTHlCZ1JDdE9ZQ2hPN0oyOElPcXl2ZXF6dkNrSzdKaUlLU0JFTFRjc0lFUXRNU3dnUkMwd0xDQkVLekVLQ2lNakl5RHJzb2p0bUxnZzdaR2M2cml3SUNqdGxaanNuYlR0bElqc25MenJvWndnNnJXczY3YUVLUW9LZkNEdGxhM3JxcWtnZkNEdG1KWHNpNTBnZkNEc21JanNpNXdnZkFwOExTMHRMUzB0ZkMwdExTMHQNCkxYd3RMUzB0TFMxOENud2c3S0NFN1ptVTY3S0k3Wmk0SUh3ZzdaV1k3SjIwN1pTSUlPcTFyT3UyaENCOElEQXlMVEV5TXpRdE5UWTNPQ3dnTURFd0xURXlNelF0TlRZM09DQjhDbndnN0xtMDY1T2M2N0tJN1ppNElId2dOT3lla091bXJPeVVxU0R0bFpqc25iVHRsSWdnZkNBeE1qTTBMVFUyTnpndE9UQXhNaTB6TkRVMklId0tmQ0RxczRUc29venJzb2p0bUxnZ2ZDRHRsWmpzbmJUdGxJZ2c2cldzNjdhRUlId2dNVEl6TFRRMU5pMDNPRGt3TVRJZ2ZBcDhJT3lqdk91dnZPdVRzZXVobmV1eWlPMll1Q0I4SU95Vm5pQTI3SjZRNjZhc0xldVNwQ0EzN0o2UTY2YXNJSHdnTVRJek5EVTJMVEV5TXpRMU5qY2dmQXA4SU95Q3JPeVhoZXlla091VHNldWhuZXV5aU8yWXVDQjhJREV3N0o2UTY2YXNJTzJWbU95ZHRPMlVpQ0I4SURBeExUSXpOQzAxTmpjNE9TQjhDZ29qSXlNZzdKT3c2Nm0wSU95VmlDRHJrSmpyaXBRZzdaR2M2cml3Q2dvdElPdUNvT3lubk95WGtDRHRsWmpzbmJUdGxJakN0K3U1bCtxNGlEb2c0cDJNDQpJREl3TWpVdE1ERXRNREVzSURBeEx6QXhDaTBnN0l1YzZyQ0U3SmVRSU95WXBPeWdoQy9zbUtUdG00UTZJT0tkakNEc21LVHNvSVFnTWV5TG5DQXFLT3VMcUN3ZzdJS3M3SnFwN0o2UTZyQ0FJT3luZ2V5Z2tTRHFzNkRycGJUcmlwUWc2N0NwNjZ5NHdyZnNtSWpzbGIwZzdJdWM2ckNFN0oyQUlPeVlpT3ladUNrcUNnb3FLaW9LQ2lNaklEZ3VJTzJNbmV5WGhTanJpNlRzbmJUc2xyenJvWnpxdDdncENncnRqSjNzbDRVZzY2eTQ2cldzNjRxVUlDb3E3SmV0N1pXZ0tpb283WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZDbnFzN3dnS2lyc25LRHRtSlVxS2lqdGhyWHJzN1F2N1l5UTY0dW9LZXlYa0NEcmxMRHJuYndnNjZ5NDdMSzA2ckNBSU91THJPdWR2T3lhbEM0ZzdZT0E3SjIwN1l1QTdKMkVJT3VMcE91VHJPeWRoQ0RybFpBZzY3Q1k2NU9jN0l1Y0lPeVZpT3VDdENqcnM3anJyTGdwNnJtTTdLZUFJT3F3bWV5ZHRDRHJzN1RxczZBc0lPdXp1T3VzdUNEcnA2WHJuYjNzbllRZzY0dTA3SldFN0pXOA0KSU8yVnRPeWFsQzRLQ2lNakl5QXc2NHVvNnJPRUlPS0FsQ0R0aXJqcnBxenFzYkRydG9EdGhMQWc2N1NRN0pxVUNncnRqSjNzbDRYc25iUWc3SUtzN0pxcDdKNlE3SjJZSU95V3RPdVdwQ0R0bG9ucmo1a2c2NUtrN0plUUlPdWNxT3VLbE95bmdDRHJxTHpzb0lBZzdZeU03SldGN1pXMDdKcVVMZ29LTFNEdGxvbnJqNW5zbllRZ0tpcnFzSURyb1p6cnA0bnFzYkRyZ3BnZzdZeVE2NHVvN0oyRUlPeWFsT3ExckNvcUtPeWR0TzJEaU1LMzdJS3Q3S0Njd3Jmcm9aenF0N2pzbFlUc200UEN0K3lpaGV1ampDa2c0b2FTSUNvcTdZeVE2NHVvN1ppVktpb2dLT3Vzdk95V3RPdTBrT3lhbENrS0xTRHFzckRxczd6Q3QreURnZTJEbk91bHZDQXFLdTJHdGV1enRPdW5qQ29xSUNqc21ZVHJvNHpDdCt5THBPMk1xQ2tnNG9hU0lDb3E3SldJNjRLMDdaaVZLaW9nS095VmpPdWdwT3lrbU95YWxDa0tDaU1qSXlEdGc0RHNuYlR0aTRBZzRvQ1VJT3lucCt5ZGdDRHJxb1hzZ3F6cXRhd0tDaTBnNjZxRjdJS3M3WmlWN0p5ODY2R2MNCklPdUJuZXVDdE95YWxDNGc3S0tGNnJLdzdKYTA2Nis0d3JmcnA0anN1YWp0a1p6cnBid2c3Sk93N0tlQUlPeVZpdXlWaE95YWxDQW9mdXlhbENBdklIN3JpNlFnTHlCKzZybU03SnFVUHlEaW5Zd3BMZ290SURKK05PeVd0T3lnaU91aG5DRHNwNmZxczZBZzdJbTk2cktNTGlEdGxaenNucERzbHJUQ3QreUltT3lMbmV5ZGhDRHF1TGpxc293ZzdJeVQ3S2VBSU95Vml1eVZoT3lhbEM0S0xTRHNsWWpyZ3JRbzY3TzQ2Nnk0S1NEcnA2WHJuYjNzbllRZzdKcVU3Slc5N1pXMExDQXFLdTJEZ095ZHRPMkxnT3VuakNEcnRKRHJqNFFnNjZ5MDdJcW9JTzJNbmV5WGhleWR1T3luZ0NvcUlPeVZqT3F5akNEdGxiVHNtcFF1SU95YmtPdXp1T3lkdENBbjdKV002NmE4d3JmdG1aWHNuYmduN0xLWTY1KzhJT3VuaWV5WHNPMlZtT3VwdENEcnM3anJyTGpzbllRZzZyZTg2ckd3NjZHY0lPcTFyT3l5dE8yWmxPMlZ0T3lhbEM0S0Nud2c3SjIwNjZDSDZyS01JT3Vua09xem9DQjhJT3lkdE91Z2grcXlqQ0I4Q253dExTMThMUzB0DQpmQXA4SU95Z2dPeWVwZTJWbU95bmdDRHNsWXJxczZBZzY0S1k2ckNBN0l1YzZyS2c3SmEwN0pxVVB5QjhJT3lnZ095ZXBTRHNsWWdnN1pXY0lPdUN0T3lhcVNCOENud2c3SldNNjZhOElId2c2ckt3N0tDY0lPeVpoT3VqakNCOENud2c3S0NWNjZlUUlPeUNyZXlnbk8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4Z2ZDRHJqYkRzbmJUdGhMQWc3SUt0N0tDY0lId0tDaU1qSXlEc2xZanJnclFvNjdPNDY2eTRLU0RpZ0pRZzdaVzA3SnFVN0xLMENnb3RJQ29xN1l5UTY0dW83WmlWS2lyc25ZQWdKMzd0bGFEcXVZenNtcFEvSit1aG5DRHJyTHpzbHJUc21wUXVJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc2NHFVSU95Y2hPMlhtQ2pzZ3Ezc29KekN0KzJEaU8ySHRDRHJrN0VwN0oyQUlPcXlzT3F6dk91bHZDRHJxTHpzb0lBZzZySzk2ck9nN1pXMDdKcVVMZ290SUNvcTdKV0k2NEswN1ppVktpcnNuWUFnN0lLczdJdWs3SjJFSU95RW5PeUlvTzJWdE95YWxDNEtMU0RycDRqc3VhanRrWnpycGJ3ZzdJMm83SnFVTGlEcw0KaUt2c25wREN0K3loc09xeHRDanNuYlRzZzRIQ3QreWR0TzJWbU1LMzdKMjA2NEswSU91VHNTbnNuWUFnNnJlNDY0eUE2NkdjSU91UmtPcXpvQ3dnN0p1UTY2eTQ3SmVRSU95WGh1dUtsQ0Rzb0pYcnM3VEN0K3lnaU95d3FNSzM3SmV3NjUyOTdMS1k2Nlc4SU95bmdPeVd0T3VDdE95bmdDRHNsWXJzbFlUc21wUXVDZ29qSXlNZzY3S0U3WXE4SU9LQWxDRHNsWWpyZ3JRZzY2eTQ2NmVsN0oyMElPeWdsZTJWdE95YWxBb0tmQ0RyczdqcnJManNuYlFnN0oyMDY2Q0g2NHVrSUh3ZzY3S0U3WXE4SUh3S2ZDMHRMWHd0TFMxOENud2c2ckt3NnJPOHdyZnNnNEh0ZzV6cnBid2c3WWExNjdPMElId2dXKzJabGV5ZHVGMGdmQXA4SUNkKzdaV2c2cm1NN0pxVVB5ZnJvWndnNjZ5ODdKMk1JSHdnVyt5VmhPdUxpT3lZcEYwZ3dyY2dXK3VFcEYwZ2ZBcDhJT3lEZ2UyWnFTRHNoSnpzaUtBZ0t5RHNtS1RycGJqc3FyM3NuYlFnN0l1azdLQ2NJT3VQbWV5ZWtTQjhJRnZzdDZqc2hveGRJTUszSUZ0NzY0K1o3SjZSZlYwZ2ZBb0sNCkxTQW43TGVvN0lhTUordUtsQ0FxS3V1UG1leWVrU0Ryc29UdGlyenFzN3dnN0tlZDdKMjhJT3VWak91bmpDb3FJT3lOcU95YWxDQW83SmlJT2lCYjdMZW83SWFNWGNLM1creUNyZXlnbkYwcExpQW42NHVyNnJpd0lNSzNJT3VQbWV5ZWtTZnNzcGpybjd3ZzdLZWQ3SjIwSU95VmlDRHJwNTdyaXBRZzdLR3c3WldwN0oyMDY0S1lJT3VMcU91UGhTQW43TGVvN0lhTUordUtsQ0RzazdEc3A0QWc3SldLN0pXRTdKcVVMZ290SU91eWhPMkt2T3lkbUNEcmo1bnNucEVnN0oyMDY2YUU3SjJBSU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGhDRHF0N2pyaklEcm9ad2c3SUswNjZDazdKcVVMZ29LSXlNaklPMkd0ZXlubkNEc21JanNpNXdLQ2lvcTdZeVE2NHVvN1ppVklPS0FsQ0RzbmJUdGc0Z3FLZ290SU8yRGdPeWR0TzJMZ0RvZzdLQ0E3SjZsSU95VmlDRHRsWndnNjRLMDdKcXBDaTBnN0pXSTY0SzBPaURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1DQpqT3lhbEQ4ZzdKNkY2NkNsN1pXY0lPdUN0T3lhcWV5ZHRDRHNncXpybmJ6c29ManNtcFF1Q2kwZzY3S0U3WXE4T2lEc2xZVHJpNGpzbUtRZ3dyY2c2NFNrQ2dvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0lLdDdLQ2NJQ2pzbklUdGw1Z3BLaW9LTFNEdGc0RHNuYlR0aTRBNklPdU5zT3lkdE8yRXNDRHNncTNzb0p3S0xTRHNsWWpyZ3JRNklPeUNyZXlnbk8yVm1PdXB0Q0RyaTZUc2k1d2c3SUswNjZhMElPeUltQ0RzbDRic2xyVHNtcFF1SU95Q3JleWduTzJWb09xNWpPeWFsRDhLTFNEcnNvVHRpcnc2SU95VmhPdUxpT3lZcENEQ3R5RHJoS1FLQ2lvcTY0K1o3SjZSN1ppVklPS0FsQ0RzaEp6c2lLQWdLeURyajVuc25wRWc2N0tFN1lxOEtpb0tMU0R0ZzREc25iVHRpNEE2SU9xNHNPcTRzQ0RzbDdEcXNyQWc3WlcwN0tDY0NpMGc3SldJNjRLME9pRHNoS0R0ZzUzdGxad2c2cml3NnJpdzdKMllJT3lYc09xeXNPeWRoQ0RyZ1lyc2xyVHNtcFF1Q2kwZzY3S0U3WXE4T2lEc3Q2anNob3dnd3JjZzdKZXc2ckt3SU8yVg0KdE95Z25Bb0tLaXJzbFlqcmdyVHRtSlVnNG9DVUlPeVpoT3VqakNEdGhyWHJzN1FxS2dvdElPMkRnT3lkdE8yTGdEb2c2ckt3N0tDY0lPeVpoT3VqakFvdElPeVZpT3VDdERvZzZyS3c3S0NjNnJDQUlPeWdsZXlEZ1NEc3NwanJwcXpya0pEc2xyVHNtcFF1Q2kwZzY3S0U3WXE4T2lEdG1aWHNuYmdLQ2lvcUtnb0tJeURzbUlqc21iZ2c2cmVjN0xtWkNncnNtNURzdVprbzY0cWw2NCtad3JmcXVJM3NvSlhDdCt5NmtPeWp2T3lXdkNucnM3VHJpNlFnN0ppSTdKbTQ2ckNBSU91TmxDRHJxb1h0bVpYdGxad2c3THVrNjY2azY0dUk3THlBN0oyMDdJV1k3SjJFSU91bmpPdVRuT3VLbENEcXNyM3NtckRzbUlqc21wUXVDZ29qSXlEc21JanNtYmdnTVM0ZzdJaVk2NCtaN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzY1Q1k2NHFVSU9xeXZleWFzQW9LSXlNaklPeUVuT3U1aE95S3BDRHNvb1hybzR3c0lPcTRzT3F3aENEcnA0enJvNHdLQ3V5SW1PdVBtZTJZbGV5Y3ZPdWhuQ0RzazdEcnFiUWc3S084N0phMEtPeWkNCmhldWpqQ0RzaEp6cnVZVHNpcVFzSU9xNHNPcXdoQ0RyazdFcDY2VzhJT3F3bGV5aHNPMlZvQ0RzaUpnZzdKNkk2ck9nTENBbjdLS0Y2Nk9NSit5WmdDQW42NmVNNjZPTUoreWRtQ0RyaVpqc2xabnNpcVRycGJ3ZzdLQ1Y3Wm1WN1o2SUlPeWdoT3VMck8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SUU5UFR5RHNoSnpydVlUc2lxUWc3S0tGNjZPTUlPeVZpT3VDdENEaWdKUWdNRERzbTVRZ01ERHNuYnpydG9EdGhMQWc3SVNjNjdtRTdJcWs2ckNBSU95aWhldWpqT3VQdk95YWxDNGc3SjZRN0lTNDdaV2NJT3VDdE95YXFleWRoQ0RzbFl6cm9LVHJrNXpyb0tUc21wUXVDaTBnN0o2UTdJS3dJT3loc08yYWpDRHF1TERxc0lUc25iUWc2ck9uSU91bmpPdWpqT3VQdk95YWxDNEtDdXVMcUN3Z0tpcnNvN3pxdUxEc29JSHNuTHpyb1p3ZzdLS0Y2Nk9NNnJDQUlPdXdtT3V6dGV1UW1PdUtsQ0Rzb0p6dGtvZ3FLdXlYa091S2xDQW43S0tGNjZPTTY0Kzg3SnFVSit1bHZDRHNrN0RzcDRBZzdKV0s3SldFDQo3SnFVTGdvSzdKaUlLUW90SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3lpaGV1ampPdVB2T3lhbENEaWhwSWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzY0R2Q2NEtZN0pxVUNnb2pJeU1nN0lLczdKcXA3SjZRN0plUTZyS01JT3V2dU95NW1PdUtsQ0RzbUlIdGxxWHNuWVFnN0pXTTY2Q2s3S1NFSU91VmpBb0tLT3lqdk95YWxDRHJqNW5zZ3F3Z09pRHNsN0Rzc3JRc0lPMlZ0T3luZ0N3ZzdLQ0I3SnFwSU91VHNTa0tDdXlJbU91UG1lMllsZXljdk91aG5DRHNrN0RycWJRZzdKMjQ2ck84SU9xMGdPcXpoT3VsdkNEcnFvWHRtWlh0bFpqcXNvd2c3SVNrNjZxRjdaV1k2ck9nTENBbjdJS3M3SnFwN0o2UTdKMllJTzJXaWV1UG1leVhrQ0RybExEcm5ienNtS1RyaXBRZzZyS3c2ck84Sit1ZHZPdUtsQ0Rzb0pEc25ZUWc3SldNNjZDazdLU0VJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdKaWs2NHFZNnJtTTdLZUFJT3VDdE95bmdDRHNsWXJzbkx6cnFiUWc3SmV3N0xLMA0KNjQrODdKcVVMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUN0T3lqdk95RXVPeWFsQzRLTFNEcmpJRHN0cHpzbllRZzZyQ0k3SldFN1lPQTY2bTBJT3lia091ZW1DRHJqSURzdHB6c25iUWc3WlcwN0tlQTY0Kzg3SnFVTGlEc21LVHJpcGdnNjRLZzdLZWM2cm1NN0tlQTdKMllJT3lkdE95ZWtPdWx2Q0RzbllEdGxvbnNsNUFnNjRLMDdKVzhJTzJWdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBBZzdKV0k3SXVzSUNqc2lKanJqNW50bUpVcENnb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3SXVjN0lxazdZV2M3SjIwSU95ZWtPdVBtZXljdk91aG5DRHNzcGpycHF6dGxaenJpNlRyaXBRZzdLQ1FLaXJzbllRZzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LN0ppSUtRb3RJT3lkdE95Z25PdTINCmdPMkVzQ0R0bVkzcXVManJqNW5yaTVqc25aZ2c2ckNjN0oyNDdLQ1Y2N08wSU95ZHRPeWFxU0RyZ3JUc2w2M3NuYlFnNnJpdzY2R2Q2NCs4N0pxVUNpMGc2NDJVSU95aWkreWRnQ0RzZzRIcmk3VHNuWVFnN0p5RTdaVzBJTzJHdGUyWmxDRHJnclRzbXFuc25ZQWc2NFc1N0oyTTY0Kzg3SnFVQ2dvakl5RHNtSWpzbWJnZ01pNGc2cks5N0phMDY2VzhJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3Q2dydGlybnNvSlVnN0lPQjdabXA3SmVRN0lTY0lPeWduTzJWbk95Z2dleWN2T3VobkNBbjdJdWM2NEtZN0pxVVB5d2c3SVdvNjRLWTdKcVVQeWNnN0oyWTY2eTQ3WmlWSU95V3RPdXZ1T3VsdkNEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzZ3F6c21xbnNucERzblpnZzY2ZWw2NTI5N0oyRUlPMlpuT3lhcWUyVnRPeUVuQ0RzcDRqcnJManRsYUFnNjVXTUNnb243SXVjNjRLWTdKcVVQeWNzSUNmc2hhanJncGpzbXBRL0p5RHRtSlh0ZzV6c25aZ2c2cks5N0phMDY2VzhJTzJabk95YXFlMlZ0T3lFDQpuQ0RzZ3F6c21xbnNucERzblpnZzY0dTU3Wm1wN0lxazY1K3M3SnVBN0oyRUlPeWtoT3lkdkNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LN0ppSUtRb3RJTzJaamVxNHVPdVBtZXVMbUN3Z1QwOVBJT3VMcE91RmdPeVlwT3lGcU91Q21PeWFsRDhLTFNEc3RxbnNvSVR0bFpqcm42d2c3WTY0N0oyWTdLQ1FJT3F3Z095TG5PdUNtT3lhbEQ4S0NpTWpJeURzZ3F6c21xbnNucERzblpnZzdJT0I3Wm1wN0oyRUlPeTJsT3lnbGUyVm9DRHJsWXdLQ3V1cWhlMlpsZTJWbkNEc29KWHJzN1Rxc0lBZzdKZUc3SmEwN0lTY0lPeUNyT3lhcWV5ZWtPeVhrT3F5akNEc3A0SHNvSkVnN1l5UTY0dW83WldZNnJLTUlPMlZ0T3lWdkNEdGxhQWc2NVdNSU9xeXZleVd0T3VobkNEc29KWHNwSkh0bFpqcXNvd2c3S2VJNjZ5NDdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdMbTA2NU9jNjZXOElPdXdtK3ljdk95RnFPdUNtT3lhbEQ4ZzY1T3g2NkdkN1pXWTY2bTBJT3k2a095TG5PdXdzU0R0bUp6dGc1M3NuWVFnNjdDYg0KN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SUtzN0pxcDdKNlE3SjJZSU95RW9PeWRtT3F3Z0NEdGxZVHNtcFR0bGFBZzY1V01DZ3JzaEtUcnJManNvYkRzZ3F6c3NwanJuN3dnN0lLczdKcXA3SjZRN0oyWUlPeUVvT3lkbU91bHZDRHF1TERyaklEdGxiVHNsYndnN1pXZ0lPdVZqQ0Rxc3Izc2xyVHJvWndnN0tDVjdLU1I3WldZNnJLTUlPeW5pT3VzdU8yVnRPeWFsQzRLQ3V5WWlDa0tMU0RzbmJUcnNvZ2c2NHVzN0plUUlPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsWmpycWJUc2hKd2c3SmE4NjZlSTY0S1lJT3Vuak95aHNlMlZtT3lGcU91Q21PeWFsRDhLQ2lNaklPeVlpT3ladUNBekxpRHJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkVJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3Q2dyc2dxenNtcW5zbnBEc2w1RHFzb3dnNjZxRjdabVY3WldZNnJLTUlPdTJnT3lnbGV5Z2dleWR1Q0RyZ3JUc21xbnNuWVFnN0pXTTY2Q2s3S1NZN0pXOElPMlZvQ0RybFl6cmlwUWc2N2FBN0tDVjdaaVYNCklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzdLS0w3SldFN0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcE91bHZDRHNvSlhzc1lYc2c0RWc3Sk80SU95SW1DRHNsNGJzbllRZzY1V01DZ3JydG9Ec29KWHRtSlhzbkx6cm9ad2c3STJvN0pXOElPeUNyT3lhcWV5ZWtPeVhrT3F5akNEc2c0SHRtYW5zbllRZzY2cUY3Wm1WN1pXWTZyS01JT3lkdU95bmdPeUxuTzJDckNEc2lKZ2c3SjZJN0phMDdKcVVMaUFxS3V5VHVDRHNpSmdnN0plRzY0cVVJT3lkdE95Y29PdWx2Q0R0bGFqcXU1Z2c3SldJNjRLMDdaVzA3S084N0lTNDdKcVVMaW9xQ2dyc21JZ3BDaTBnN0tlQTZyaUk3SjJBSU9xd2dPeWVoZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YWxDNEtMU0RxczdYcnJMVHNtNURzbllBZzdadUU3SnVRNnJpSTdKMkVJT3V6dE91Q3ZDRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lkDQp2T3UyZ0NEcXVMRHJpcVhycDR3ZzdKTzRJT3lJbUNEc2w0YnNuWVFnNjVXTUNncnJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzdJMm83Slc4SU95Q3JPeWFxZXlla09xd2dDRHNsclRybHFRZzZyaXc2NHFsN0oyRUlPeVR1Q0RzaUpnZzdKZUc2NHFVN0tlQUlPdXFoZTJabGUyVm1PcXlqQ0RzbmJqc3A0RHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHNvSkRxc29BZzZyaXc2ckNFSU91UG1leVZpQ0RzaEp6cnVZVHNpcVRycGJ3ZzdKMjA3SnFwN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdJdWc2N2FFN0thZElPMlpsZXlkdU91UW1PcTRzQ0Rzb0lUcXVZenNwNEFnN0lhaDZyaUk2ck84SU9xeXNPeWduT3VsdkNEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZ3F6c21xbnNucEFnN0lTZzdZT2Q3SjJZSU9xeXNPcXp2T3VsdkNEc2xZanJnclR0bGFBZzY1V01DZ3Jya0pqcmo0enJwclFnN0lpWUlPeVhodXVLbENEc2hLRHRnNTNzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cQ0KaGUyWmxlMlZtT3F5akNEc2xZenJvS1RzbXBRdUNncnNtSWdwQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNncXpzbXFuc25wQWc3SldJN0l1c0lDanJ0b0Rzb0pYdG1KVXBDZ29uN0tDVjY3TzBJT3lJbU95bmtTRHNsWWpyZ3JRbklPdVRzZXlkbUNEcnI3enFzSkR0bFp3ZzdJT0I3Wm1wN0plUTdJU2NJQ29xN0tDVjY3TzA2ckNBSU91enRPMll1T3VRbk91THBPdUtsQ0Rzb0pBcUt1eWRoQ0RydG9Ec29KWHRtSlhzbkx6cm9ad2c3SldNNjZDa0lPeUNyT3lhcWV5ZWtPdWx2Q0RzbFlqc2k2enRsWmpxc293ZzdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdJT0I2NHUwN0oyMElPdUJuZXVDbU91cHRDRHNvSVRyckxqcXNJRHJqNFFnN1ptTjZyaTQ2NCtaNjR1WTdKMllJT3lnbGV1enRPdWx2Q0Ryczd3ZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEdG1ZM3F1TGpyajVucmk1anMNCm5aZ2c3S0NWNjdPMDZyQ0FJT3E0c091aG5ldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUNnb2pJeURzbUlqc21iZ2dOQzRnN0tDYzdaS0lJT3lhcWV5V3RPdUtsQ0Ryc0pUcXZyanNwNEFnN0pXSzZyaXdDZ29uNnJDRTZyS3c3WldZNnJPZ0lPeUpyT3lhdENEcnA1QW5JT3lia095NW1ldXp0T3VMcENBcUt1MlpsT3VwdE95ZG1DRHF1TERyaXFYcnFvWEN0K3V5aE8yS3ZPdXFoZXF6dk95ZG1DRHNtcW5zbHJRZzdKMjg3TG1ZS2lycXNJQWc3SnF3N0lTZzdKMjA3SmVRN0pxVUxncnF1TERyaXFYcnFvWHNsNUFnN0pPdzdKMjRJT3VMcU95V3RDanJzNERxc3Iwc0lPeW5nT3lnbFN3ZzY1T3g2NkdkSU91VHNTbnJwYndnN0pXSTY0SzBJT3VzdU9xMXJPeVhrT3lFbkNEcmk2VHJwYmdnNjZlUTY2R2NJT3V3bE9xK3VPdXB0Q0RzZ3F6c21xbnNucERxc0lBZzY0dWs2Nlc0SU9xNHNPdUtwZXljdk91aG5DRHNtS1R0bGJUdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0N1eVlpQ2tnSitxMmpPMlZuQ0RyczREcXNyMG5JT3E0DQpzT3VLcGV5ZG1DRHNsWWpyZ3JRZzY2eTQ2cldzQ2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZtT3VwdENEcnNKVHF2NEFnN0lpWUlPeWVpT3lXdE95YWxDQW9XQ2tLTFNEcmk2VHJwYmdnN0lLczY1Nk03SjJFSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcm9ad2c3S2VBN0tDVjdaV1k2Nm0wSU91emdPcXl2ZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVJQ2hQS1FvS0l5TWc3SmlJN0ptNElEVXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JDRHNrN0RzcDRBZzdKV0s2cml3Q2dycnJManF0YXpycGJ3ZzdKV0U2NnkwNjZhc0lPdW5wT3VCaE91ZnZlcXlqQ0RyaTZUcms2enNsclRyajRRZ0tpcnNpNlRzb0p3ZzdJdWM3SXFrN1lXY0lPdVBtZXlla2VxenZDRHJpNlRycGJnZzY0K1o3SUtzS2lycnBid2c3Sk93NjZtMElPeWVtT3VxdSt1UW5DRHJyTGpxdGF6c21JanNtcFF1Q2dyc21JZ3BJT3VuaU95Sw0KcE8yRXNDRHF0SURycHF6c25wRHJwYndnSit5MmxPcXdnQ0RzcDREc29KVW43WldZNjRxVUlPeUxuT3lLcE8yRm5PeVhrT3lFbkNBbzdKMjA3S0NFd3Jmc2xwSHJqNFFnNnJpdzY0cWw3SjIwSU95VmhPdUxtQ2tLTFNEcmk2VHJwYmdnN0lLczY1Nk03SmVRNnJLTUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJwYndnNjRTWTZyS283S084N0lTNDdKcVVJQ2hZSU9LQWxDRHNsNGJyaXBRZ0ordUVtT3E0c09xNHNDY2c2cml3NjRxbDdKMkVJT3lWbE95TG5Da0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXMElPeWp2T3lFdU95YWxDQW9UeWtLDQo6OkxBVU5DSEVSOjoNCi8vNG5BQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkNBSElBYVFCa0FHY0FaUUFnQUd3QVlRQjFBRzRBWXdCb0FHVUFjZ0FnQUJRZ0lBRG9zc1NzeEx3Z0FDVEJGY2dnQUJESWdLd2dBTVRXSUFEa3NxeTVJQURrd29uVkNnQW5BQ0FBWXdCc0FHRUFkUUJrQUdVQVlnQnlBR2tBWkFCbkFHVUFPZ0F2QUM4QUlBQUUxVnk0b05GY3ozVEhJQUIweHlBQUROTjh4MFRISUFDQXZYaTU1TElnQUNnQThiUmR1RG9BSUFCdUFIQUFiUUFnQUdrQWJnQnpBSFFBWVFCc0FHd0FJQUFRdHBTeUlBQWlBSFRRWExqY3RDQUE1TTRsc1REUklnQWdBQ1RCV000Z0FBelRmTWNwQUM0QUNnQW5BQ0FBVkxzQXJDQUFZTDQ0eUNBQWlNYzh4M1M2SUFCYzFTQUFpTHpReFNBQVdOV1lzQ25GSUFCSXhiU3dXTlhnckN3QUlBRGtzaUFBQU1sRXZoaTBkTG9nQU9TeXJMbDh1U0FBUGN3Z0FNYkZkTWNnQU9UQ2lkVmMxZVN5TGdBS0FGTUFaUUIwQUNBQVpnQnpBRzhBSUFBOUFDQUFRd0J5QUdVQVlRQjBBR1VBVHdCaUFHb0FaUUJqQUhRQUtBQWlBRk1BDQpZd0J5QUdrQWNBQjBBR2tBYmdCbkFDNEFSZ0JwQUd3QVpRQlRBSGtBY3dCMEFHVUFiUUJQQUdJQWFnQmxBR01BZEFBaUFDa0FDZ0JUQUdVQWRBQWdBSE1BYUFBZ0FEMEFJQUJEQUhJQVpRQmhBSFFBWlFCUEFHSUFhZ0JsQUdNQWRBQW9BQ0lBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRk1BYUFCbEFHd0FiQUFpQUNrQUNnQmtBR2tBY2dBZ0FEMEFJQUJtQUhNQWJ3QXVBRWNBWlFCMEFGQUFZUUJ5QUdVQWJnQjBBRVlBYndCc0FHUUFaUUJ5QUU0QVlRQnRBR1VBS0FCWEFGTUFZd0J5QUdrQWNBQjBBQzRBVXdCakFISUFhUUJ3QUhRQVJnQjFBR3dBYkFCT0FHRUFiUUJsQUNrQUNnQnpBR2dBTGdCREFIVUFjZ0J5QUdVQWJnQjBBRVFBYVFCeUFHVUFZd0IwQUc4QWNnQjVBQ0FBUFFBZ0FHUUFhUUJ5QUFvQUNnQW5BQ0FBTVFBdkFESUFLUUFnQUU0QWJ3QmtBR1VBTGdCcUFITUFJQUFReUlDc0lBQVVJQ0FBeHNVOHgzUzZJQURrc3JUR1hMamN0Q0FBbU5OMHg4REpmTGtnQVBURnRNVUF5ZVN5Q2dCSkFHWUFJQUJ6QUdnQQ0KTGdCU0FIVUFiZ0FvQUNJQVl3QnRBR1FBSUFBdkFHTUFJQUIzQUdnQVpRQnlBR1VBSUFCdUFHOEFaQUJsQUNJQUxBQWdBREFBTEFBZ0FGUUFjZ0IxQUdVQUtRQWdBRHdBUGdBZ0FEQUFJQUJVQUdnQVpRQnVBQW9BSUFBZ0FFa0FaZ0FnQUUwQWN3Qm5BRUlBYndCNEFDZ0FJZ0JPQUc4QVpBQmxBQzRBYWdCekFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGk0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQmJBRlhXZU1kZEFFVEhJQUFFc25TNWRMb2dBT1N5dE1aY3VOeTBJQUNZMDNUSHdNa0FyQ0FBOU1XOXVjaXk1TEl1QUNBQUpNRll6bnk1SUFESXVWek9JQUNrdEN3QUlBQU0xZXkzK0sxNHg5REZITUVnQUhUUVhMamN0Q0FBaEx5ODBrVEhJQURrc3R6Q0lBQU1zdXkzSUFEOHlEakJsTVl1QUNJQUxBQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUENCklBQjJBR0lBVHdCTEFFTUFZUUJ1QUdNQVpRQnNBQ0FBS3dBZ0FIWUFZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FERUFMd0F5QUNrQUlBQVVJQ0FBVGdCdkFHUUFaUUF1QUdvQWN3QWlBQ2tBSUFBOUFDQUFkZ0JpQUU4QVN3QWdBRlFBYUFCbEFHNEFDZ0FnQUNBQUlBQWdBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQm9BSFFBZEFCd0FITUFPZ0F2QUM4QWJnQnZBR1FBWlFCcUFITUFMZ0J2QUhJQVp3QXZBR3NBYndBdkFHUUFid0IzQUc0QWJBQnZBR0VBWkFBaUFBb0FJQUFnQUVVQWJnQmtBQ0FBU1FCbUFBb0FJQUFnQUZjQVV3QmpBSElBYVFCd0FIUUFMZ0JSQUhVQWFRQjBBQW9BUlFCdUFHUUFJQUJKQUdZQUNnQUtBQ2NBSUFBeUFDOEFNZ0FwQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0FBRU1pQXJDQUFGQ0FnQU1iRlBNZDB1aUFBSk1GWXpyY0FYTGo0clhqSElBQXB2Slc4Uk1jZ0FFakZ0TEJjMWVTeUNnQkpBR1lBDQpJQUJ6QUdnQUxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BSUFCM0FHZ0FaUUJ5QUdVQUlBQmpBR3dBWVFCMUFHUUFaUUFpQUN3QUlBQXdBQ3dBSUFCVUFISUFkUUJsQUNrQUlBQThBRDRBSUFBd0FDQUFWQUJvQUdVQWJnQUtBQ0FBSUFCTkFITUFad0JDQUc4QWVBQWdBQ0lBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGlBQUtBQVF0cFN5SUFCUUFFRUFWQUJJQU5ERklBREd4YlRGbE1ZcEFDNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdBdzBmaTdFTEhReFJ6QklBQkV4WmkzZkxrZ0FDVEJXTTYzQUZ5NCtLMTR4MXpWSUFDa3RDd0FJQUIwMEZ5NDNMUWdBSVM4dk5KRXh5QUE1TExjd2lBQURMTHN0eUFBL01nNHdaVEdPZ0FpQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQQ0KSmdBZ0FGOEFDZ0FnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFpQUNBQUlBQnVBSEFBYlFBZ0FHa0FiZ0J6QUhRQVlRQnNBR3dBSUFBdEFHY0FJQUJBQUdFQWJnQjBBR2dBY2dCdkFIQUFhUUJqQUMwQVlRQnBBQzhBWXdCc0FHRUFkUUJrQUdVQUxRQmpBRzhBWkFCbEFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBSUFBZ0FHTUFiQUJoQUhVQVpBQmxBQ0FBYkFCdkFHY0FhUUJ1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFWZFo0eHlBQUtieVZ2RG9BSUFBdzBmaTdFTEhReFJ6QklBQmpBR3dBWVFCMUFHUUFaUUFnQUMwQUxRQjJBR1VBY2dCekFHa0Fid0J1QUNBQWRNY2dBSVM4Qk1oRXh5QUFuTTBsdUZqVmRMb2dBQURKUkw0Z0FFVEd6TGlGeDhpeTVMSXVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUENClh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBS0FDc3dLbkd5YmRBeHlBQWRNY2dBRkFBUXdEUXhTQUFYTGo0clhqSEhMUWdBSFRRWExqY3RDQUFiSzNGc3lBQVhOWEVzOURGSE1FZ0FDak1FS3dwdE1peTVMSXVBQ2tBSWdBc0FDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUhZQVlnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURJQUx3QXlBQ2tBSUFBVUlDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNJQUNnQWdBQ0FBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRkVBZFFCcEFIUUFDZ0JGQUc0QVpBQWdBRWtBWmdBS0FBb0FKd0FnQUFESlJMNGdBRVRHekxnZ0FCUWdJQURrc3F5NWZMa2dBRDNNSUFER3hYVEhJQURrd29uVklBQW9BQXpWN0xmNHJYakhkTWNnQU9lc0lBQ1F4OW16SUFBUXJNREpLUUFLQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JqQUcwQVpBQWdBQzhBWXdBZ0FHNEFid0JrQUdVQUlBQnpBR01BDQpjZ0JwQUhBQWRBQnpBRndBWXdCc0FHRUFkUUJrQUdVQUxRQmlBSElBYVFCa0FHY0FaUUF1QUdvQWN3QWlBQ3dBSUFBd0FDd0FJQUJHQUdFQWJBQnpBR1VBQ2dBPQ0KOjpXQVRDSEVSOjoNCkx5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tLTHk4ZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU95Wm5DRHRsWVRzbXBUdGxaenFzSUE2SU8yVXZPcTN1T3VuaU9xd2dDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1kyeGhkV1JsWW5KcFpHZGxPaTh2SU95WHRPcTRzQ2gzYVc1a2IzY3ViM0JsYmk5cFpuSmhiV1V2YjNCbGJrVjRkR1Z5Ym1Gc0tldWx2QW92DQpMeURzb0lUcnRvQWc3SWFNNjZhc0lPeVhodXlkdENEcnA0bnJpcFFnNjdLRTdLQ0U3SjIwSU95ZWlPdUxwQzRnWm1WMFkyanJpcFFnNjZxN0lPdW5pZXljdk91dmdPdWhuQ3dnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKRHNpNXpzbnBEc2w1RHFzb3dLTHk4Z1VFOVRWQ0F2ZDJGclpTRHJwYndnNjdPMDY0SzA2Nm0wSU9xd2tPeUxuT3lla09xd2dDRHJpNlRycHF3b1kyeGhkV1JsTFdKeWFXUm5aUzVxY3lucnBid2c2NHlBN0l1Z0lPeThvT3VMcEM0S0x5OEtMeThnNjR1azY2YXM3Sm1BN0oyWUlPeXdxT3lkdERvZzZyQ1E3SXVjN0o2UTY0cVVJR05zWVhWa1pldWx2Q0Ryckx6c3A0QWc3SldLNjRxVTY0dWtLT3lla095TG5TRHNsNGJzbll3cElPS0draUR0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3VsdkNEc2xZZ2c2NmVKNnJPZ0xBb3ZMeURycVpUcnFxanJwcXdnZmpFMVRVTHJuYndnNjZHYzZyZTQ3SjI0SU95TG5DRHNucERyajVrZzdJdWM3SjZSN0p5ODY2R2NJT3lEZ2V5TA0KbkNEc3ZKenJrYXpyajRRZzY3YUE2NHUwSU95WGh1dUxwQ0FvNjVPeDY2R2RPaUJ1Y0cwZ2NuVnVJR0oxYVd4a0tTNEtMeThnNjR1azY2YXM2NHFVSU95THJPeWVwZXV3bGV1UG1TRHJnWXJxdUxEcnFiUWc3S085N0tlQTY2ZU1LTzJVak91ZnJPcTN1T3lkdU9xenZDRHNnNTNzZ3F3ZzY0K1o2cml3N1ptVUtTd2c2ckNRN0l1YzdKNlE2NHFVSU9xemhPeUdqU0RyZ3Fqc2xZUWc2NHVrN0oyTUlPcTVxT3lhc09xNHNPdWx2Q0Ryc0p2cmlwVHJpNlF1Q2dwamIyNXpkQ0JvZEhSd0lEMGdjbVZ4ZFdseVpTZ25hSFIwY0NjcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQm1jeUE5SUhKbGNYVnBjbVVvSjJaekp5azdDbU52Ym5OMElHOXpJRDBnY21WeGRXbHlaU2duYjNNbktUc0tZMjl1YzNRZ2V5QnpjR0YzYml3Z2MzQmhkMjVUZVc1aklIMGdQU0J5WlhGMWFYSmxLQ2RqYUdsc1pGOXdjbTlqWlhOekp5azdDZ3BqYjI1emRDQlFUMUpVSUQwZ01URTRPRGs3Q21OdmJuTjANCklGSlBUMVFnUFNCd1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5MaTRuS1RzZ0x5OGc3S0NBN0o2bDdJYU1JT3VqcU8yS3VDRGlnSlFnNjR1azY2YXM2ckNBSUhKbFkyOXRiV1Z1WkMxbGVHRnRjR3hsY3k1dFpPdWx2Q0Rzc0w3cmlwUWc2cml3N0tTQUNncGpiMjV6ZENCRFQxSlRYMGhGUVVSRlVsTWdQU0I3Q2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVTl5YVdkcGJpYzZJQ2NxSnl3S0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxSVpXRmtaWEp6SnpvZ0owTnZiblJsYm5RdFZIbHdaU2NzQ24wN0NtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXdvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxDQpjMjl1T3lCamFHRnljMlYwUFhWMFppMDRKeUI5TENCRFQxSlRYMGhGUVVSRlVsTXBLVHNLSUNCeVpYTXVaVzVrS0VwVFQwNHVjM1J5YVc1bmFXWjVLRzlpYWlrcE93cDlDZ292THlCamJHRjFaR1VnUTB4SjZyQ0FJT3llaU91S2xPeW5nQ0RpZ0pRZzdKZUc3Snk4NjZtMElDOTNZV3RsSU95ZGtldUx0ZXlYa0NEc2k2VHNsclFnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPeWR2ZXE0c0NEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpJQ2pyaTZUcnBxenNuWmdnWTJ4aGRXUmxRV05qYjNWdWRPeVpnQ0Rxc0puc25ZQWc3TGFjN0xLWUtTNEtMeThnN1l5TTdKMjg3SjIwSU8yQnRDRHNpSmdnN0o2STdKYTBJRE13N0xTSUlPeTZrT3lMbkM0ZzdKNnM2NkdjNnJlNDdKMjQ3WldZNjZtMA0KSUVOTVNlcXdnQ0R0akl6c25ienNuWVFnNnJDeDdJdWc3WldZNjYrQTY2R2NJT3lla091UG1TRHJzSmpzbUlIcmtKenJpNlF1Q2k4dklPeTZrT3lMbkNBMTdMU0lJT0tBbENEcm9aenF0N2pzbmJnZzdLZUI3WnVFSU95RGlDRHFzNFRzb0pYc25iUWc2ck9uNjdDVTY2R2NJT3llb2UyWWdPeVZ2Q0R0bEl6cm42enF0N2pzbmJqc25iUWc2NkdjNnJlNDdKMjRJTzJabE91cHRPeVhrT3lFbkNEdG1ZanNuTHpyb1p3ZzY0U1k3SmEwNnJDRTY0dWtLRE13N0xTSTY2bTBJT3VFaU91c3RDRHJpcWJzbll3cENteGxkQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lBd0xDQmxiV0ZwYkRvZ2JuVnNiQ0I5T3dwbWRXNWpkR2x2YmlCamJHRjFaR1ZCWTJOdmRXNTBLQ2tnZXdvZ0lHbG1JQ2hFWVhSbExtNXZkeWdwSUMwZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUR3Z05UQXdNQ2tnY21WMGRYSnVJR0ZqWTI5MWJuUkRZV05vWlM1bGJXRnBiRHNLSUNCc1pYUWdaVzFoYVd3Z1BTQnVkV3hzT3dvZ0lIUnllU0I3Q2lBZ0lDQmoNCmIyNXpkQ0JxSUQwZ1NsTlBUaTV3WVhKelpTaG1jeTV5WldGa1JtbHNaVk41Ym1Nb2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSnk1amJHRjFaR1V1YW5OdmJpY3BMQ0FuZFhSbU9DY3BLVHNLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdWhuT3EzdU95ZHVDRHNuYlRyb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDQXFMeUI5Q2lBZ1lXTmpiM1Z1ZEVOaFkyaGxJRDBnZXlCaGREb2dSR0YwWlM1dWIzY29LU3dnWlcxaGFXd2dmVHNLSUNCeVpYUjFjbTRnWlcxaGFXdzdDbjBLQ21aMWJtTjBhVzl1SUdoaGMwTnNZWFZrWlNncElIc0tJQ0JqYjI1emRDQm1hVzVrWlhJZ1BTQndjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5JRDhnSjNkb1pYSmxKeUE2SUNkM2FHbGphQ2M3Q2lBZ2RISjVJSHNnDQpjbVYwZFhKdUlITndZWGR1VTNsdVl5aG1hVzVrWlhJc0lGc25ZMnhoZFdSbEoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0J6YUdWc2JEb2dkSEoxWlNCOUtTNXpkR0YwZFhNZ1BUMDlJREE3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJSEpsZEhWeWJpQm1ZV3h6WlRzZ2ZRcDlDZ3BzWlhRZ2QyRnJhVzVuSUQwZ1ptRnNjMlU3SUM4dklPeVhzTzJEZ0NEcnNLbnNwNEFnNG9DVUlPdUxwT3Vtck91S2xDRHNsclRzc0tqdGxMd2dSVUZFUkZKSlRsVlRSZXVobkNEc3BKSHJzN1VnN0tDVjY2YXM3WldZN0tlQTY2ZU1JTzJVaE91aG5PeUV1T3lLcENEcmdxM3J1WVRycGJ3ZzdLU0U3SjI0NjR1a0NtWjFibU4wYVc5dUlIZGhhMlZDY21sa1oyVW9LU0I3Q2lBZ2FXWWdLSGRoYTJsdVp5a2djbVYwZFhKdU93b2dJSGRoYTJsdVp5QTlJSFJ5ZFdVN0NpQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJSGRoYTJsdVp5QTlJR1poYkhObE95QjlMQ0ExTURBd0tUc0tJQ0JzWlhRZ2NISnZZenNLSUNCcFppQW9jSEp2WTJWeg0KY3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ0x5OGdWMmx1Wkc5M2N6b2dZMjFrd3JkMlluTWc2cks5N0p5Z0lPeVhodXlkdENCdWIyUmw2Nlc4SU95bmdleWdrU3dnZDJsdVpHOTNjMGhwWkdVb1ExSkZRVlJGWDA1UFgxZEpUa1JQVnlucm9ad2c3SXFrN1krd0lPS0FsQW9nSUNBZ0x5OGc3TEM5SU95WGh1dUtsQ0RzaUtqc25ZQWc3TDJZN0lhVTdKMjBJT3Vuak91VHBPeVd0T3luZ09xem9DRHJpNlRycHF6c25aZ2c3SjZRN0l1ZEtHTnNZWFZrWlNucmo0UWc2cmU0SU95OW1PeUdsT3lkaENEcnJMenJvS1Ryc0p2c2xZUWc3SmEwNjVha0lPeXd2ZXVQaENEc2xZZ2c2NXlzNjR1a0xnb2dJQ0FnTHk4Z1pHVjBZV05vWldUcmlwUWc3Sk93N0tlQUlPeVZpdXVLbE91THBDaGtaWFJoWTJobFpDdDNhVzVrYjNkelNHbGtaU0Rzb2JEdGxhbnNuWUFnN0wyWTdJYVVJT3l3dmV5ZHRDRHJoYmpzdHB6cmtLZ2c0b0NVSU95THBPeTRvU2t1Q2lBZ0lDQXZMeUJYYVc1a2IzZHo3SmVRN0lTZ0lHUmwNCmRHRmphR1ZrSU95WGh1eWR0T3VQaENEcnRvRHJxcWdvNnJDUTdJdWM3SjZRS2Vxd2dDRHNvNzNzbHJUcmo0UWc3SjZRN0l1ZDdKMkFJT3lDdE95VmhPdUNxT3VLbE91THBDNEtJQ0FnSUhCeWIyTWdQU0J6Y0dGM2JpaHdjbTlqWlhOekxtVjRaV05RWVhSb0xDQmJjR0YwYUM1cWIybHVLRjlmWkdseWJtRnRaU3dnSjJOc1lYVmtaUzFpY21sa1oyVXVhbk1uS1Ywc0lIc0tJQ0FnSUNBZ1kzZGtPaUJTVDA5VUxDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbExBb2dJQ0FnZlNrN0NpQWdmU0JsYkhObElIc0tJQ0FnSUM4dklHMWhZMDlUTCt1bXJPdUloZXlLcERvZzZyQ1E3SXVjN0o2UTY2VzhJT3VkaE95YXRDQnViMlJsSU95THBPMldpU0R0akl6c25ienJvWndnN0tlQjdLQ1JJT3lLcE8yUHNDQW9iR0YxYm1Ob1pDRHRtWmpxc3Izc2w1UWdVRUZVU09xd2dDRHJ1WWpzbGIzdGxhQWc3SWlZSU95ZWlPeVd0Q0Rzb0lqcmpJRHFzcjNyb1p3ZzdJS3M3SnFwS1FvZ0lDQWdjSEp2DQpZeUE5SUhOd1lYZHVLSEJ5YjJObGMzTXVaWGhsWTFCaGRHZ3NJRnR3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBblkyeGhkV1JsTFdKeWFXUm5aUzVxY3ljcFhTd2dld29nSUNBZ0lDQmpkMlE2SUZKUFQxUXNJR1JsZEdGamFHVmtPaUIwY25WbExDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0NpQWdJQ0I5S1RzS0lDQjlDaUFnY0hKdll5NTFibkpsWmlncE95QXZMeURxc0pEc2k1enNucEFnN0oyMDY3S2s3WXE0SU91anFPMlVoT3lYa095RW5DRHJ0b1RycHF3Z0tPcXdrT3lMbk95ZWtDRHNvb1hybzR6cnBid2c2NmVKN0tlQUlPeVZpdXF5akNrS2ZRb0tMeThnN0oyMElGQkQ2Nlc4SUNmc2hLVHN1WmdnN0tDRUtPeURpQ0JRUXlrbklPeURnZTJEbk91aG5DRHJrSmpyajR6cnByRHJpNlFnNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0JiN0xTSTZyaXc3Wm1VWFNEcnNvVHRpcndvVUU5VFZDQXZkVzVwYm5OMFlXeHNLZXlkdENEcnRvRHJwYmpyaTZRdUNpOHZJSEpsWjJsemRHVnlMWEJ5YjNSdlkyOXNMbXB6NnJDQQ0KSU95RXBPeTVtTzJWbkNEcXNvUHNuWVFnNnJlNDY0eUE2NkdjSU91UW1PdVBqT3Vtc091THBEb2c2ckNRN0l1YzdKNlFJT3lla091UG1leUxuT3lla1NBcklDanNub2pzbkx6cnFiUXBJT3lFcE95NW1DRHRqN1RyalpRdUNpOHZJT0thb08rNGp5RHJzSmpyazV6c2k1d2dTRlJVVUNEc25aSHJpN1hzbllRZzY2aTg3S0NBSU91enRPdUN1Q0Rya3FRZzdaaTQ3TGFjN1pXZ0lPcXlneURpZ0pRZ2JXRmpUMU1nYkdGMWJtTm9ZM1JzSUdKdmIzUnZkWFRzbmJRZzdKMjBJTzJVaE91aG5PeUV1T3lLcE91bHZDRHNwb25zaTV3ZzdLS0Y2Nk9NN0l1YzdZS3NJT3lJbUNEc25vanJpNlF1Q2k4dklDQWdJT3EzdU91ZW1PeUVuQ0R0akl6c25id29jR3hwYzNUQ3QreUVwT3k1bUNEdGo3VHJqWlFwN0oyRUlHeGhkVzVqYUdOMGJPdXp0T3VMcENEcnFMenNvSUFnN0tlQTdKcTA2NHVrSU9LQWxDQmliMjkwYjNWMDdKMjBJT3lhc091bXJPdWx2Q0Rzbzczc2w2enJqNFFnN0o2UTY0K1o3SXVjN0o2UjdKMkFJT3lkdE91dnVDRHMNCmdxenJuYnpzcDRUcmk2UXVDbVoxYm1OMGFXOXVJSFZ1YVc1emRHRnNiRk5sYkdZb0tTQjdDaUFnWTI5dWMzUWdjbVZ0YjNabFpDQTlJRnRkT3dvZ0lIUnllU0I3Q2lBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0oyUmhjbmRwYmljcElIc0tJQ0FnSUNBZ1kyOXVjM1FnVEVGQ1JVd2dQU0FuWTI5dExtTnNZWFZrWldKeWFXUm5aUzUzWVhSamFHVnlKenNLSUNBZ0lDQWdZMjl1YzNRZ2NHeHBjM1FnUFNCd1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuVEdsaWNtRnllU2NzSUNkTVlYVnVZMmhCWjJWdWRITW5MQ0JNUVVKRlRDQXJJQ2N1Y0d4cGMzUW5LVHNLSUNBZ0lDQWdZMjl1YzNRZ2FXNXpkQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2RNYVdKeVlYSjVKeXdnSjBGd2NHeHBZMkYwYVc5dUlGTjFjSEJ2Y25RbkxDQW5RMnhoZFdSbFFuSnBaR2RsSnlrN0NpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLSEJzYVhOMEtTa2dleUJtDQpjeTUxYm14cGJtdFRlVzVqS0hCc2FYTjBLVHNnY21WdGIzWmxaQzV3ZFhOb0tIQnNhWE4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwS0lDQWdJQ0FnZEhKNUlIc2dhV1lnS0daekxtVjRhWE4wYzFONWJtTW9hVzV6ZENrcElIc2dabk11Y20xVGVXNWpLR2x1YzNRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbExDQm1iM0pqWlRvZ2RISjFaU0I5S1RzZ2NtVnRiM1psWkM1d2RYTm9LR2x1YzNRcE95QjlJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRb2dJQ0FnSUNCMGNua2dleUJ6Y0dGM2JsTjVibU1vSjJ4aGRXNWphR04wYkNjc0lGc25ZbTl2ZEc5MWRDY3NJQ2RuZFdrdkp5QXJJSEJ5YjJObGMzTXVaMlYwZFdsa0tDa2dLeUFuTHljZ0t5Qk1RVUpGVEYwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2UzMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0Nkc1lYVnVZMmhqZEd3bkxDQmJKM0psYlc5MlpTY3NJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eQ0KWlNjZ2ZTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRb2dJQ0FnZlNCbGJITmxJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdDaUFnSUNBZ0lIUnllU0I3SUhOd1lYZHVVM2x1WXlnbmNtVm5KeXdnV3lka1pXeGxkR1VuTENBblNFdERWVnhjVTI5bWRIZGhjbVZjWEUxcFkzSnZjMjltZEZ4Y1YybHVaRzkzYzF4Y1EzVnljbVZ1ZEZabGNuTnBiMjVjWEZKMWJpY3NJQ2N2ZGljc0lDZERiR0YxWkdWQ2NtbGtaMlZYWVhSamFHVnlKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KK3lla091UG1leUxuT3lla1NoRGJHRjFaR1ZDY21sa1oyVlhZWFJqYUdWeUtTY3BPeUI5SUdOaGRHTm9JQ2hmWlNrZ2UzMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0NkeVpXY25MQ0JiSjJSbGJHVjBaU2NzSUNkSVMwTlZYRnhUYjJaMGQyRnlaVnhjUTJ4aGMzTmxjMXhjWTJ4aGRXUmxZbkpwWkdkbEp5d2dKeTltSjEwc0lIc2cNCmMzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE95QnlaVzF2ZG1Wa0xuQjFjMmdvSjJOc1lYVmtaV0p5YVdSblpUb3ZMeURyazdIcm9aMG5LVHNnZlNCallYUmphQ0FvWDJVcElIdDlDaUFnSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdhVzV6ZENBOUlIQmhkR2d1YW05cGJpaHdjbTlqWlhOekxtVnVkaTVNVDBOQlRFRlFVRVJCVkVFZ2ZId2djR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0owRndjRVJoZEdFbkxDQW5URzlqWVd3bktTd2dKME5zWVhWa1pVSnlhV1JuWlNjcE93b2dJQ0FnSUNBZ0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWdmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZRb2dJQ0FnSUNCOUlHTmhkR05vSUNoZlpTa2dlMzBLSUNBZ0lIMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUJtWVdsc0xYTnZablFnNG9DVUlPdXF1eURzDQpwNERzbXJRZzZyS01JT3llaU95V3RPdVBoQ0R0bEl6cm42enF0N2pzbmJnZzdLcTlJT3E0c095V3RTRHNncTNzb0p6cmlwUWc3SjIwNjYrNElPdUJuZXVDck91THBDQXFMeUI5Q2lBZ2NtVjBkWEp1SUhKbGJXOTJaV1E3Q24wS0NpOHZJT3VMcE91bXJDZ3hNVGc0T0NucXNJQWc2NWFnSU95ZWlPeWN2T3VwdENEcmdZanJpNlFnNG9DVUlPeTBpT3E0c08yWmxDRHNpNXdnNjRLbzdKMkFJT3lFdU95Rm1DRHNvSlhycHF3Z0tPeVhodXljdk91cHRDRHNvYkRzbXFudG5vZ2c3SXVrN1l5b0tRcG1kVzVqZEdsdmJpQnphSFYwWkc5M2JrSnlhV1JuWlNncElIc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdjaUE5SUdoMGRIQXVjbVZ4ZFdWemRDaDdJR2h2YzNRNklDY3hNamN1TUM0d0xqRW5MQ0J3YjNKME9pQXhNVGc0T0N3Z2NHRjBhRG9nSnk5emFIVjBaRzkzYmljc0lHMWxkR2h2WkRvZ0oxQlBVMVFuTENCMGFXMWxiM1YwT2lBeE5UQXdJSDBzSUNncElEMCtJSHQ5S1RzS0lDQWdJSEl1YjI0b0oyVnljbTl5Snl3Zw0KS0NrZ1BUNGdlMzBwT3dvZ0lDQWdjaTV2YmlnbmRHbHRaVzkxZENjc0lDZ3BJRDArSUhzZ2RISjVJSHNnY2k1a1pYTjBjbTk1S0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlNCOUtUc0tJQ0FnSUhJdVpXNWtLQ2s3Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5Q24wS0NtTnZibk4wSUhObGNuWmxjaUE5SUdoMGRIQXVZM0psWVhSbFUyVnlkbVZ5S0NoeVpYRXNJSEpsY3lrZ1BUNGdld29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIMEtJQ0JwWmlBb2NtVnhMblZ5YkNBOVBUMGdKeTlvWldGc2RHZ25LU0I3Q2lBZ0lDQXZMeUIyT2lEcXNKRHNpNXpzbnBBZzdMMlU2NU9jSU91eWhPeWdoQ0RpZ0pRZzZyV3M2N0tFN0tDRUlPMlVoT3Vobk95RXVPeUtwT3F3Z0NEcXM0VHNobzBnNjQrTTZyT2dJT3llaU91S2xPeW5nQ0Ryc0pic2w1RHNoSndnN1ptVjdKMjQNCjdaV1k2NHFVSU95YXFldVBoQW9nSUNBZ0x5OGdLSFl5SUQwZzdMQzlJT3lJcU9xNWdDRHNpSmpzb0pYdGpKQXNJSFl6SUQwZ0wyRmpZMjkxYm5RZzdMYVU2ckNBN1l5UUxDQjJOQ0E5SUM5MWJtbHVjM1JoYkd3ZzdMYVU2ckNBN1l5UUtRb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJSGRoZEdOb1pYSTZJSFJ5ZFdVc0lIWTZJRFFnZlNrN0NpQWdmUW9nSUM4dklPeWR0Q0JRUSt5WGtDRHJvWnpxdDdqc25ianJrSndnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0RpZ0pRZzdaU002NStzNnJlNDdKMjRJT3l5cXlEdG1aVHJxYlRDdCsyWmlPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFRzcDRBaUlPdXp0T3lYck95anZPdUtsQ0RyamJBZzdKTzA2NHVrTGdvZ0lDOHZJT3F3a095TG5PeWVrT3F3Z0NEcmk3WHRsWmpyaXBRZzdKMjA3SnlnT2lEcmk2VHJwcXpycGJ3ZzdMeWM2Nm0wSU95YmpPdXdqZXlYaGV5Y3ZPdWhuQ0R0Z2JUcm9aenJrNXpxDQpzSUFnN0l1azdLQ2NJTzJZdU95Mm5PdVB2Q0RxdGF6cmo0VWc3SUtzN0pxcDY1K0o3SjIwSU91Q21PcXdoT3VMcEM0S0lDQXZMeURxc0pEc2k1enNucERyaXBRZzdZeU03SjI4NjZlTUlPeWR2ZXljdk91dmdPdWhuQ0RzZ3F6c21xbnJuNGtnTUNEQ3R5RHJqSURxdUxBZ01DRGlnSlFnNnJLQTdZYWc2NmVNSU95VHNPdUtsQ0RzZ3F6cm5venNsNURxc293ZzY3bUU3SnFwN0oyRUlPdXN2T3Vtck95bmdDRHNsWXJyaXBUcmk2UXVDaUFnTHk4ZzdLTzg3SjJZT2lEc2w2enF1TEFnNnJPRTdLQ1Y3SjIwSU91enRPeVhyT3VQaENEc25vWHNucVhxdG96c25iUWc2NmVNNjZPTTY1Q1E3SjJFSU95SW1DRHNub2pyaTZRbzdKeWc3WnFvN0lTeDdKMkFJT3lMcE95Z25DRHRtTGpzdHB3ZzY1V002NmVNSU95VmpDRHNpSmdnN0o2STdKMk1JT0tBbENEcmk2VHJwcXdnTDJobFlXeDBhT3lkbUNCd2NtOWliR1Z0SU95d3VPcXpvQ2t1Q2lBZ2FXWWdLSEpsY1M1MWNtd2dQVDA5SUNjdllXTmpiM1Z1ZENjcElIc0tJQ0FnSUhKbA0KZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQmhZMk52ZFc1ME9pQmpiR0YxWkdWQlkyTnZkVzUwS0Nrc0lHTnNZWFZrWlRvZ2FHRnpRMnhoZFdSbEtDa2dmU2s3Q2lBZ2ZRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OTNZV3RsSnlrZ2V3b2dJQ0FnYVdZZ0tDRm9ZWE5EYkdGMVpHVW9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUdaaGJITmxMQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25JSDBwT3dvZ0lDQWdkMkZyWlVKeWFXUm5aU2dwT3dvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lIZGhhMmx1WnpvZ2RISjFaU0I5S1RzS0lDQjlDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM05vZFhSa2IzZHVKeWtnZXdvZ0lDQWdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnYNCmF6b2dkSEoxWlNCOUtUc0tJQ0FnSUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBMQ0F5TURBcE93b2dJQ0FnY21WMGRYSnVPd29nSUgwS0lDQXZMeURzdElqcXVMRHRtWlFnNG9DVUlPeWR0Q0JRUSt1bHZDQW43SU9JSUZCREp5RHNnNEh0ZzV6cm9ad2c2NUNZNjQrTTY2YXc2NHVrSUNqdGxJenJuNnpxdDdqc25iZ2dXK3kwaU9xNHNPMlpsRjBnNjdLRTdZcThLUzRLSUNBdkx5RHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPMmRtT3VncE91enRPdUN1Q0Rya3FRZzdLQ1Y2NmFzN1pXYzY0dWtJT0tBbENCaWIyOTBiM1YwN0oyMElPeWFzT3Vtck91bHZDRHNwb25zaTV3ZzdLTzk3SmVzNjQrRUlPMmFqT3lMb095ZGdDRHJqNFRzc0tudGxaenJpNlF1Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNWdWFXNXpkR0ZzYkNjcElIc0tJQ0FnSUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUhCc1lYUm1iM0p0DQpPaUJ3Y205alpYTnpMbkJzWVhSbWIzSnRJSDBwT3dvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdDaUFnSUNBZ0lITm9kWFJrYjNkdVFuSnBaR2RsS0NrN0NpQWdJQ0FnSUdOdmJuTjBJSEpsYlc5MlpXUWdQU0IxYm1sdWMzUmhiR3hUWld4bUtDazdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiZDJGMFkyaGxjbDBnN0xTSTZyaXc3Wm1VS0hWdWFXNXpkR0ZzYkNrZzRvQ1VJT3lnbk9xeHNEb25MQ0J5WlcxdmRtVmtMbXB2YVc0b0p5d2dKeWtnZkh3Z0p5anNsNGJzbll3cEp5azdDaUFnSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwTENBeU1EQXBPd29nSUNBZ2ZTd2dNalV3S1RzS0lDQWdJSEpsZEhWeWJqc0tJQ0I5Q2lBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EUXNJSHNnWlhKeWIzSTZJQ2RPYjNRZ1ptOTFibVFuSUgwcE93cDlLVHNLQ2k4dklPeWR0T3V2dUNEcmxxQWc3SjZJN0p5ODY2bTBJT3loc095YXFlMmVpQ0Rzb29Ycm80d2dLT3lla091UA0KbVNEc2k1enNucEVnS3lCdWNHMGdZblZwYkdRZzdLU1I2N08xSU95THBPMldpU0RyaklEcnVZUXBDbk5sY25abGNpNXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdld29nSUdsbUlDaGxJQ1ltSUdVdVkyOWtaU0E5UFQwZ0owVkJSRVJTU1U1VlUwVW5LU0J3Y205alpYTnpMbVY0YVhRb01DazdDaUFnY0hKdlkyVnpjeTVsZUdsMEtERXBPd3A5S1RzS2MyVnlkbVZ5TG14cGMzUmxiaWhRVDFKVUxDQW5NVEkzTGpBdU1DNHhKeXdnS0NrZ1BUNGdld29nSUdOdmJuTnZiR1V1Ykc5bktDZGJkMkYwWTJobGNsMGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc3THljN0tlUUlPS0FsQ0JvZEhSd09pOHZiRzlqWVd4b2IzTjBPaWNnS3lCUVQxSlVLVHNLZlNrN0NnPT0NCjo6V1NJTEVOVDo6DQpKeUJEYkdGMVpHVWdRbkpwWkdkbElIZGhkR05vWlhJZ2MybHNaVzUwSUd4aGRXNWphR1Z5SUNodWJ5QjNhVzVrYjNjcElDMGdjbVZuYVhOMFpYSmxaQ0IwYnlCeWRXNGdZWFFnYkc5bmFXNEtVMlYwSUdaemJ5QTlJRU55WldGMFpVOWlhbVZqZENnaVUyTnlhWEIwYVc1bkxrWnBiR1ZUZVhOMFpXMVBZbXBsWTNRaUtRcFRaWFFnYzJnZ1BTQkRjbVZoZEdWUFltcGxZM1FvSWxkVFkzSnBjSFF1VTJobGJHd2lLUXBrYVhJZ1BTQm1jMjh1UjJWMFVHRnlaVzUwUm05c1pHVnlUbUZ0WlNoWFUyTnlhWEIwTGxOamNtbHdkRVoxYkd4T1lXMWxLUXB6YUM1RGRYSnlaVzUwUkdseVpXTjBiM0o1SUQwZ1pHbHlDbk5vTGxKMWJpQWlZMjFrSUM5aklHNXZaR1VnYzJOeWFYQjBjMXhpY21sa1oyVXRkMkYwWTJobGNpNXFjeUlzSURBc0lFWmhiSE5sQ2c9PQ0KOjpFTkQ6Og0K";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAABsB7xve/EBAHvxAQAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21sa1oyVXBDaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdUNpOHZDaTh2SU95R2pldVBoQ0RzaEtUcXM0UTZJTzJCdE91aG5PdVRuT3VsdkNEc21wVHNzcTNycDRqcmk2UWc3SU9JNjZHY0lPeUxuT3VQbWUyVm1PdXB0Q0F6TUg0ME1PeTBpT3F3Z0NEcXQ3anJnNlVnNjRLZzdKV0U2ckNFNjR1a0xnb3ZMeURpaHBJZzY0dWs2NmFzNjZXOElPeThwQ0RybFl3ZzdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZGhDRHRsWmpyZ3BnZzdKZTA3SmEwSU95RGdleUxuQ0RyaklEcXVMRHNpNXp0Z3FUcXM2QW9jM1J5WldGdExXcHpiMjRnNjR5QTdabVVJT3VxcU91VG5Da3NDaTh2SUNBZzZyQ0E3SjIwNjVPY0sreVlpT3lMbkNneE1USHFzYlFwNjRxVUlPeXlxeURycVpUc2k1enNwNERyb1p3ZzdaV2NJT3V5aU91bmpDRHNuYjN0bm96cmk2UXVJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2Nnk0NnJXczY2ZU1JT3V6dE91Q3RPdXZnT3VobkNEcnVhRHJwYlRyaTZRdUNpOHZJT3lFdU95Rm1PeWRnQ0F6TU91eWlDRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdaVzBJT3VNZ08yWmxPcXdnQ0RyckxUdGxaenRub2dnNnJpNDdKYTA3S2VBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpOHZDaTh2SU95Z2hPeWduRG9nN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPeWRoQ0Rxc29NZ0tHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKeTg2NkdjSU8yWmxleWR1Q2tLTHk4ZzdLTzg3SjJZT2lEc2dxenNtcW5ybjRuc25ZQWc2ckNCN0o2UUlPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFuT3VMcEM0S0NtTnZibk4wSUdoMGRIQWdQU0J5WlhGMWFYSmxLQ2RvZEhSd0p5azdDbU52Ym5OMElHWnpJRDBnY21WeGRXbHlaU2duWm5NbktUc0tZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3Q25SeWVTQjdJR1p6TG0xclpHbHlVM2x1WXloRlRWQlVXVjlEVjBRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbElIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwamIyNXpkQ0JEVEVGVlJFVmZSVTVXSUQwZ1QySnFaV04wTG1GemMybG5iaWg3ZlN3Z2NISnZZMlZ6Y3k1bGJuWXNJSHNLSUNCTlFWaGZWRWhKVGt0SlRrZGZWRTlMUlU1VE9pQW5NQ2NzSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNnNTNxc0lFZzY2cW82NU9jSU91QmxDQW83S2VuN0oyQUlPdXN1T3Exck95WGxDRHJ0b2p0bFlUc21wUXBDaUFnUTB4QlZVUkZYME5QUkVWZlJFbFRRVUpNUlY5T1QwNUZVMU5GVGxSSlFVeGZWRkpCUmtaSlF6b2dKekVuTENBdkx5RHRoTFFnN0pxVTdKVzlJT3VUc1NEcnRvRHFzSUFnN1ppNDdMYWNJT3VCbEFvZ0lFUkpVMEZDVEVWZlZFVk1SVTFGVkZKWk9pQW5NU2NzQ24wcE93b0tZMjl1YzNRZ1VFOVNWQ0E5SUU1MWJXSmxjaWh3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVUU5U1ZDa2dmSHdnTVRFNE9EZzdJQzh2SUVKU1NVUkhSVjlRVDFKVTY0cVVJTzJGak95S3BPMkt1T3lhcVNBbzdZK0o3SWFNN0plVUlERXhPRGc0SU9xem9PeWdsU2tLTHk4ZzY0dWs2NmFzSU95OWxPdVRuQ0Ryc29Uc29JUWc0b0NVSUM5b1pXRnNkR2pyb1p3ZzY0VzQ3TGFjN1pXYzY0dWtMaURzdlpUcms1enJwYndnY0hWc2JNSzM2N08xN0lLczdaVzA2NCtFSUNvcTdKMjA2Nis0SU91V29DRHNub2pyaXBRZzY0dWs2NmFzNjRxVUlPeVlteURzdlpUcms1d2c2cmU0NjR5QTY2R2NLaXJybmJ3S0x5OGc2cnVRNjR1a0lPeThuT3E0c0NEc29JVHNsNVFnN0lPSUlPdVBtZXlla2V5ZHRDRHNsWWdnNjRLWTdKaW82NHVrS08yRXNPdXZ1T3VFa095ZHRDRHJuS2pyaXBRZzY1T3hLUzRnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKTHNuTHpyb1p3ZzZyV3M2N0tFN0tDRTdKMkVJT3F3a095bmdPMlZ0Q0RzbnF6c2k1enNucEhzaTV6dGdxanJpNlF1Q2k4dklPdVBtZXlla2V5ZHRDRHJzSlRyZ0l6cmlwUWc3SWlZN0tDVjdKMkVJTzJWbU91cHRDRHNuYlFnN0lpcjdKNlE2Nlc4SU95WXJPdW1yT3F6b0NCamIyUmxMblJ6N0oyWUlFSlNTVVJIUlY5TlNVNWZWdXVQaENEcXNKbnNuYlFnN0ppczY2YXc2NHVrTGdwamIyNXpkQ0JDVWtsRVIwVmZWaUE5SURFMU93b3ZMeURxdUxEcnM3Z2c2NnFvNjQyNExpRHNtcFRzc3EwbzdaU002NStzNnJlNDdKMjRLZXlkdENCdGIyUmxiT3lkaENEc3A0RHNvSlh0bFpqcnFiUWc2cmU0SU95YWxPeXlyZXVuakNEcXQ3Z2c2NnFvNjQyNDY2R2NJT3l5bU91bXJPMlZuT3VMcEM0S0x5OGdhR0ZwYTNVOTY3bWc2NmFFTCtxd2dPdXl2T3liZ0N3Z2MyOXVibVYwUGV5a2tlcXdoQ3dnYjNCMWN6M3F1TERyczdnbzdMV2M2ck9nN1pLSTdLZUlMQ0Rzb2JEcXVJZ2c2NHFRNjZhOEtRcGpiMjV6ZENCRFRFRlZSRVZmVFU5RVJVd2dQU0J3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVFU5RVJVd2dmSHdnSjI5d2RYTW5Pd3BqYjI1emRDQkJURXhQVjBWRVgwMVBSRVZNVXlBOUlGc25hR0ZwYTNVbkxDQW5jMjl1Ym1WMEp5d2dKMjl3ZFhNblhUc0tZMjl1YzNRZ1ZGVlNUbDlVU1UxRlQxVlVYMDFUSUQwZ09UQXdNREE3SUNBZ0x5OGc3SnFVN0xLdElESHFzYlFnN0tDYzdaV2M3SXVjNnJDRUNtTnZibk4wSUUxQldGOVVWVkpPVXlBOUlETXdPeUFnSUNBZ0lDQWdJQ0FnSUM4dklPeWR0T3Vuak8yQnZDRHNrN0RycWJRZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NBbzY0eUE3Wm1VSU91SWhPeWdnU0Ryc0tuc3A0QXBDZ292THlEaWxJRGlsSUFnN0ppSTdJdWNJT3lDck95Z2hDRHJvWnpyazV3Z0tISmxZMjl0YldWdVpDMWxlR0Z0Y0d4bGN5NXRaQ0RpZ0pRZ1luVnBiR1F0WjJ4dmMzTmhjbmt1YW5Qc21ZQWc2ckNaN0oyQUlPMk1qT3lFbkNrZzRwU0E0cFNBQ21aMWJtTjBhVzl1SUd4dllXUkZlR0Z0Y0d4bGN5Z3BJSHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYldRZ1BTQm1jeTV5WldGa1JtbHNaVk41Ym1Nb2NHRjBhQzVxYjJsdUtGOWZaR2x5Ym1GdFpTd2dKeTR1Snl3Z0ozSmxZMjl0YldWdVpDMWxlR0Z0Y0d4bGN5NXRaQ2NwTENBbmRYUm1PQ2NwT3dvZ0lDQWdZMjl1YzNRZ2MyVmpTV1I0SUQwZ2JXUXVjMlZoY21Ob0tDOWVJeU1nN0xhVTdMS2NJT3lZaU95TG5GeHpLaVF2YlNrN0NpQWdJQ0JwWmlBb2MyVmpTV1I0SUQwOVBTQXRNU2tnY21WMGRYSnVJRnRkT3dvZ0lDQWdZMjl1YzNRZ1pYaGhiWEJzWlhNZ1BTQmJYVHNLSUNBZ0lHeGxkQ0JqZFhJZ1BTQnVkV3hzT3dvZ0lDQWdabTl5SUNoamIyNXpkQ0J5WVhjZ2IyWWdiV1F1YzJ4cFkyVW9jMlZqU1dSNEtTNXpjR3hwZENnblhHNG5LU2tnZXdvZ0lDQWdJQ0JqYjI1emRDQnNhVzVsSUQwZ2NtRjNMbkpsY0d4aFkyVW9MMXh6S3lRdkxDQW5KeWs3Q2lBZ0lDQWdJR052Ym5OMElHZ2dQU0JzYVc1bExtMWhkR05vS0M5ZUl5TWpYSE1yS0M0clB5bGNjeW9rTHlrN0NpQWdJQ0FnSUdsbUlDaG9LU0I3SUdOMWNpQTlJSHNnYVc1d2RYUTZJR2hiTVYwc0lITjFaMmRsYzNScGIyNXpPaUJiWFNCOU95QmxlR0Z0Y0d4bGN5NXdkWE5vS0dOMWNpazdJR052Ym5ScGJuVmxPeUI5Q2lBZ0lDQWdJR052Ym5OMElHSWdQU0JzYVc1bExtMWhkR05vS0M5ZVhITXFMVnh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9ZaUFtSmlCamRYSXBJR04xY2k1emRXZG5aWE4wYVc5dWN5NXdkWE5vS0dKYk1WMHVjM0JzYVhRb0p5QXZJQ2NwTG1wdmFXNG9KeUFuS1NrN0NpQWdJQ0I5Q2lBZ0lDQnlaWFIxY200Z1pYaGhiWEJzWlhNdVptbHNkR1Z5S0NobEtTQTlQaUJsTG5OMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBK0lEQXBPd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNtSWpzaTV3ZzdJS3M3S0NFSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lYaHV5ZHRDRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z1cxMDdDaUFnZlFwOUNnb3ZMeURpbElEaWxJQWc3S2VBN0l1YzY2eTRJQ2pzaEp6cnNvUWdjbVZqYjIxdFpXNWs3Sm1BSU9xd21leWRnQ0RxdDV6c3Vaa2c0b0NVSU91d2xPcSt1T3VwdENEcXQ3anNxcjNyajRRZzdaV282cnVZS1NEaWxJRGlsSUFLTHk4ZzdKcXA3SmEwN0tlUktHZHNiM056WVhKNUxtMWtLZXlkZ0NEc25ienJ0b0RybjZ3ZzdaU0U2NkdzN1pTRTdZcTQ3SmVRSU95VmlDRHJoS1ByaXBUcmk2UW9NakF5Tmkwd055RHNpNlRzdUtFcE9pRHJoS1Bzbkx6cnFiUWc3WUcwNjZHYzY1T2M2ckNBSU95YXFleVd0Q0RxdFpEc29KWHNuWVFLTHk4ZzdLTzhJT3llaE91c3RPdWhuQ0RzbUtUdGxiVHRsYlFnTStxd25DRHNvSnpzbFlqc25iUWc3S0NFNjdhQUlDTHRrWnpxdUxBZzZyT2c3TG1vSUNzZzdKYTA3SWljSU91emdPcXl2U0xzbmJRZzY1Q2M2NHVrTGlEc2w2M3RsYUFnNjdhRTY2YXNJT0tBbEFvdkx5RHRnYlRyb1p6cms1d2dQU0Ryckxqc25xVWc2NHVrNjVPczZyaXdLT3l3dmV5ZG1Da3NJT3lhcWV5V3RDRHRoclhzbmJ6Q3QrdW5udXkycE91eWxTQTlJR052WkdVdWRITWdjbVZtYVc1bFFXbFRkV2RuWlhOMGFXOXVjeUR0bTRUc3NwanJwcXdvNnJpdzZyT0U3S0NCS1M0S1kyOXVjM1FnVTFSWlRFVmZVbFZNUlZNZ1BTQmJDaUFnSnpFdUlPMlZ0T3lhbE95eXREb2c2NnFvNjVPZ0lPdXN1T3Exck91S2xDRHRsYlRzbXBUc3NyVHJvWnd1SUNqcnM3VHJnNFhyaTRqcmk2VGlocExyczdUcmdyVHNtcFFwSnl3S0lDQW5NaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0RvZzY1Q1E3SmEwN0pxVTRvYVM3WmFJN0phMDdKcVVMQ0IrN0plSUlPdTV2T3E0c0NqcnNKVHJnSXpzbDRqc2xyVHNtcFRpaHBMcnNKVHF2NmpzbHJUc21wUXBMaURyaTZnc0lPeWloZXVqak1LMzY2ZU02Nk9Nd3Jmc2w3RHNzclRDdCsyVnRPeW5nTUszNnJpdzY2R2R3cmZyaGJuc25Zd2c2NU94SU95TG5PeUtwTzJGbk95ZHRDRHNvN3pzc3JUc25iZ2c2ckt3NnJPODY0cVVJT3lJbU91UG1lMllsU0RzbktEc3A0QW83SmV3N0xLMDY0Kzg3SnFVTENEcmhibnNuWXpyajd6c21wUXBMaWNzQ2lBZ0p6TXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEE2SUNKKzdaV2dJT3lJbUNEc2w0YnNsclRzbXBRaUlPdU1nT3lMb0NBaWZ1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENJZzZyV3M3S0d3SU95YXNPeUVvQzRnNjR1b0xDRHNvSlhzc1lYc2c0RWc2N2FJNnJDQXdyZnNuYnpydG9BZzZyaXc2NHFsSU95Z25PMlZuTUszNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzZyS3c2ck84d3Jmc29KWHJzN1FnNjdPMDdaaTRJT3lWaU95THJPeWRnQ0RydG9Ec29KWHRtSlhzbkx6cm9ad2c2NnFGN1ptVjdaNklMaWNzQ2lBZ0p6UXVJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclE2SUg3dGxaanNpNXpxc3FEc2xyVHNtcFEvNG9hU2Z1MlZvT3E1ak95YWxEOHNJT3F6aE95TG5PdUxwT0tHa3V5ZWlPdUxwQ3dnN0plczdLMkk2NHVrNG9hUzdabVY3SjI0N1pXWTY0dWtMQ0RxdTVqaWhwTHNsNURxc293dUlIN3NpNXdnNjdtODZyaXc2ckNBSU95V3RPeURpZTJWbU91cHRDRHRqSXpzbFlYdGxaanJvS1RyaXBRZzdLQ1Y2N08wNjZXOElPeWp2T3lXdE91aG5DRHJyTGpzbnFYc25ZUWc2NHVrN0l1Y0lPeVR0T3VMcEM0bkxBb2dJQ2MxTGlEcnFvWHNncXdyNjZxRjdJS3NJT3E0aU95bmdEb2c3WldjN0o2UTdKYTA2Nlc4SU8yU2dPeVd0Q0RyajVuc2dxenJvWndvN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBUaWhwTHNuYlRzbnBEcnBid2c2NCtNNjZDazY3Q2I3SldZN0phMDdKcVVLU3dnN0xXYzdJYU03WldjSUh2cnFvWHNncXg5NnJDQUlIdnJxb1hzZ3F4OTdaVzA3SVNjSU8yWWxlMkRuT3VobkNqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrdUp5d0tJQ0FuTmk0ZzdaR2M2cml3T2lEcmtKanNsclRzbXBUaWhwTHJqN3pzbXBRdUp5d0tJQ0FuTnk0ZzdLU0VJT3Exck95aHNEb2c3SnVRNjdPNDdKMjBJTzJWbkNEc3BJVHNuYlRycWJRZzdMYVU3TEtjNjQrRUlPdXdtT3VUbk95TG5DRHRsWndnN0tTRTY2R2NMaURzbm9Uc25aanJvWndnN0tTRTdKMkVJT3VLbU91bXJPeW5nQ0RzbFlycmlwVHJpNlF1SU91THFDd2c3SmVzNjUrc0lPdXN1T3llcGV5ZGhDRHRsWmpyZ3Bqc25aZ2c2cmlON0tDVjdaaVZJT3VzdU95ZXBleWN2T3VobkNEdGxhbnNzNUFnNjQyVUlPcXdoT3F5c08yVnRPeW5oT3VMcE91cHRDRHNwSVFnN0lpWTY2VzhJT3lraE95ZHRPdUtsQ0Rxc29Qc25ZQWc3Wm1ZN0ppQkxpY3NDaUFnSnpndUlPMk1uZXlYaFNqcmk2VHNuYlRzbHJ6cm9aenF0N2dwSU91eWhPMkt2RG9nNnJLdzZyTzhJTzJHdGV1enRPdUtsQ0JiN1ptVjdKMjRYU3dnN0ppSUwreVZoT3VMaU95WXBDRHRqSkRyaTZqc25ZQWdXK3lWaE91TGlPeVlwRjB2Vyt1RXBGMHNJT3VQbWV5ZWtTRHNuS0RyajRUcmlwUWdXK3kzcU95R2pGMHZXM3ZyajVuc25wRjlYUzRnSXV5M3FPeUdqQ0xyaXBRZzY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1JT3lUc09xem9DQWk2NHVyNnJpd3dyZnJqNW5zbnBFaTdMS1k2NSs4SU95bm5TRHNsWWdnNjZlZTY0cVVJT3loc08yVnFjSzM2NHVvNjQrRklDTHN0NmpzaG93aTY0cVVJT3E0aU95bmdDNG5MQW9nSUNjNUxpRHNuYlRycG9UQ3QreWdoTzJabE91eWlPMll1TUszNjZlSTdJcWs3WUs1N0oyQUlPcTN1T3VNZ091aG5DRHJzN1Rzb2JRdUlPeUNyT3Vlak95ZGhDRHJ0b0RycGJ3ZzY1V1FJT3VMbU95ZGhDRHJ0cG5zbDZ6cmo0UWc3S0tMNjR1a0xpY3NDaUFnSnpFd0xpRHNvSnp0a29nZzdKcXA3SmEwSU95Y29PeW5nRG9nN0o2RjY2Q2w3SmVRSU95VHNPeWR1Q0RxdUxEcmlxWHNoTEVnNjZxRjdJS3NLT3V6Z09xeXZTd2c3S2VBN0tDVkxDRHJrN0hyb1owc0lPMlZ0T3lnbkNEcms3RXA2NHFVSU8yWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhleWR2Q0Rxc0lEcmlxWHNoTEhzbmJRZzY0YVM3Snk4NjYrQTY2R2NJT3lKck95YXRDRHJwNURyb1p3ZzY3Q1U2cjY0N0tlQUlPeVZpdXVLbE91THBDNGc3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyaTZUcnBiZ2c2NCtaN0lLczY2VzhJT3lEaU91aG5DRHJwNHpyazZUc3A0QWc3SldLNjRxVTY0dWtMaWNzQ2wwdWFtOXBiaWduWEc0bktUc0tDbU52Ym5OMElFVllRVTFRVEVWVElEMGdiRzloWkVWNFlXMXdiR1Z6S0NrN0Nnb3ZMeURpbElEaWxJQWc3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Rzb0lUcnJMZ2c2NkdjNjVPY0lDaDFlQzEzY21sMGFXNW5MbTFrSU9LQWxDRHNtSWpzbWJnZzZyZWM3TG1aSU95RXVPdTJnQ0RzaTV6cmdwanJwcXpzbUtUcXVZenNwNEFnN1pTRTY2R3M3WlNFN1lxNDdKZVFJTzJQck8yVnFDa2c0cFNBNHBTQUNpOHZJRk5VV1V4RlgxSlZURVZUSURFdzdLU0VJT3lhbE95VnZldW5qT3ljdk91aG5PdUtsQ0RzbUlqc21iZ2dNWDR6S095SW1PdVBtZTJZbGNLMzZySzk3SmEwd3JmcnRvRHNvSlh0bUpVZzdaZUk3SnFwSU95OGdPeWR0T3lLcENuc25aZ2c2NG1ZN0pXWjdJcWs2ckNBSU95Y29PeUxwT3VRbk91THBDNEtMeThnN1l5TTdKMjg3SjIwSU95WGh1eWN2T3VwdENqc2hLVHN1WmpyczdnZzZyV3M2N0tFN0tDRUlPdVRzU2tnNjdtSUlPdXN1T3lla095WHRDRGlnSlFnN0pxVTdKVzk2NmVNN0p5ODY2R2NJT3VQbWV5ZWtTaG1ZV2xzTFhOdlpuUXBMZ3BtZFc1amRHbHZiaUJzYjJGa1IzVnBaR1VvS1NCN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHMWtJRDBnWm5NdWNtVmhaRVpwYkdWVGVXNWpLSEJoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNjdUxpY3NJQ2QxZUMxM2NtbDBhVzVuTG0xa0p5a3NJQ2QxZEdZNEp5a3VkSEpwYlNncE93b2dJQ0FnY21WMGRYSnVJRzFrTG14bGJtZDBhQ0ErSURFd01DQS9JRzFrSURvZ0p5YzdDaUFnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUtwTzJEZ095ZHZDRHFzSURzbmJUcms1d2c2NkdjNjVPY0lPeUxwTzJNcUNBbzdKcVU3Slc5NjZlTTdKeTg2NkdjSU95bmhPMldpU2s2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUhKbGRIVnliaUFuSnpzS0lDQjlDbjBLWTI5dWMzUWdSMVZKUkVVZ1BTQnNiMkZrUjNWcFpHVW9LVHNLQ21aMWJtTjBhVzl1SUdsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncElIc0tJQ0JqYjI1emRDQm1aWGRUYUc5MElEMGdSVmhCVFZCTVJWTXViV0Z3S0NobGVDa2dQVDRnSjBsdWNIVjBPaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvWlhndWFXNXdkWFFwSUNzZ0oxeHVUM1YwY0hWME9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29aWGd1YzNWbloyVnpkR2x2Ym5NcEtTNXFiMmx1S0NkY2JpY3BPd29nSUhKbGRIVnliaUFvQ2lBZ0lDQW43S2VBNnJpSTY3YUE3WVN3SU91RWlPdUtsQ0RzbDVEc2lxVHNtNUFvVXkweExDRHJzN1RzbFlqdG1venNncXdwN0oyWUlPMlZuT3ExcmV5V3RDQlZXQ0JYY21sMGFXNW5JT3lnaE91c3VPcXdnT3VobkNEc25ienRsWnpyaTZRdUlDY2dLd29nSUNBZ0ordUN0T3F3Z0NCVlNTRHJyTGpxdGF6cnBid2c3WldZNjRLWTdKU3BJT3V6dE91Q3RPdXB0Q3dnN0pXRTY1NllJT3lLcE8yRGdPeWR2Q0RxdDV6c3VabnNsNUFnNjZlZTZyS01JT3VMcE91VHJPeWRnQ0RyaklEc2xZZ2dNK3F3bk91bHZDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNmc21wVHNzcTNyazZUc25ZQWc3SVNjNjZHY0lPdXN0T3EwZ08yVm5DRHJzNFRxc0p3ZzY2eTQ2cldzNjR1a0lPS0FsQ0RzbmJUc29JUWc2Nnk0NnJXczY2VzhJT3l3dU95aHNPMlZtT3luZ0NEcnA0anJuYnd1WEc0bklDc0tJQ0FnSUNmc201RHJucGdnN0oyWTY2KzQ3Sm1BSU91cXFPdVRvQ0Rzb0pYcnM3UW83SjIwNjZhRXdyZnNpS3ZzbnBEQ3QreWhzT3F4dE1LMzY0eUE3SU9CS2V1bHZDRHNuS0RzcDREdGxaanFzNkFzSU9xd2dTRHNvSnpzbFlqc25ZQWc3SnVRNjdPNDZyTzg2NCtFSU95RW5PdWhuT3laZ091UGhDRHJpNnpybmJ6c2xid2c3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnNvYkRxc2JRZzdaR2M3WmlFS095ZHRPeURnY0szN0oyMDdaV1l3cmZzbmJUcmdyVEN0K3kwaU9xenZNSzM2Nis0NjZlTXdyZnJ0b0R0aExEQ3QrcTVqT3luZ0NEcms3RXA3SjJBSU95Z2xleXhoU0Rzb0pYcnM3VHJpNlFnNG9DVUlPdTV2T3F4c091Q21DRHJpNlRycGJnZzdLR3c2ckcwN0p5ODY2R2NJT3V3bE9xK3VPeW5nQ0RycDRqcm5id29Jalh0bW93ZzdKMjA3SU9CSXV5ZGhDQWlOZTJhakNMcm9ad2c3S1NFN0oyMDY2bTBJT3lZcE91THRTa3VJQ2NnS3dvZ0lDQWdKK3lia091c3VPeVhrQ0RzbDRicmlwUWc2cldzN0xLMElPeWdsZXV6dENqc29JVHRtWlRyc29qdG1MakN0MVZTVE1LMzZyaUk3Sldod3Jmc2k1enFzSVFnNjVPeEtleVpnQ0R0bGJUcXNyQWc2N0NwNjdLVndyZnNvSWpzc0tnbzdKNnM3SVNrN0tDVndyZnJyTGpzblpqc3NwakN0K3llck95TG5PdVBoQ0RyazdFcDY2VzhJT3luZ095V3RPdUN0Q0RydHBuc25iVHJpcFFnNnJLRDdKMkFJT3lnaU91TWdDRHF1SWpzcDRBZzRvQ1VJT3lWaE91S2xDRHFzSkxzbmJUcm5ienJqNFFzSU9xM3VPdWZ0T3VUcisyVnRPdVBoQ0RzazdEc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQW5NK3F3bkNEc29KenNsWWpzbllBZzdJU2M2NkdjSU95Z2tlcTN2T3lkdENEcmk2enJuYnpzbGJ3ZzdaV2M2NHVrSU9LQWxDRHRsWmpyZ3BqcmlwUWc3SnVRNjZ5NElPcTFyT3loc091bHZDRHNuS0RzcDREdGxad2c3TFdjN0lhTUlPdUxwT3VUck9xNHNDd2c3WldZNjRLWTY0cVVJT3VzdU95ZXBTRHF0YXpzb2JEcnBid2c3SjZzNnJXczdJU3g3WldjSU91TWdPeVZpQ3dnSnlBckNpQWdJQ0FuNnJlNDY2YXM2ck9nSU95Z2dleVd0T3VQaENEdGxaanJncGpyaXBRZzZyTzg2ckNRN1pXY0lPeWVyT3Exck95RXNUb2c3S1NSNjdPMUlPMlJuTzJZaE95ZGhDRHJqWnpzbHJUcmdyVHFzNkFzSU95Z2xldXp0Q0RzaUp6c2hKenJwYndnN0lLczdKcXA3SjZRNnJDQUlPeVZqT3lWaE95VnZDRHRsYUFnNnJLRDY3YUE3WVN3NjZHY0lPeWVyT3loc095bmdlMlZvQ0Rxc29NdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95ZHRDRHRsYlRxc3JBZzY3Q3A2N0tWN0oyRUlPdUx0T3F6b0NEc25vanNuWVFnNjVXTTY2ZU1JQ0xzbHJUcmxydnFzb3dnN1pXWTY2bTBJT3VMcE95TG5DRHJrSnpyaTZRaTY2VzhJT3lWbnV5RXVPeWFzT3VLbENEcXVJM3NvSlh0bUpVZzdKNnM2cldzN0lTeDdKMkVJTzJWbU91ZHZDRGlnSlFnN0p1UTY2eTQ3SmVRSU8yVnRPcXlzT3l4aGV5ZHRDRHNsNGJzbkx6cnFiUWc2NmVNNjVPazdKYTBJT3UybWV5ZHRPeW5nQ0RycDRqcm5id3VJQ2NnS3dvZ0lDQWdKKzJSbk9xNHNNSzM3SnFwN0phMDY2ZU1JT3F6b095NW1PcXpvQ0RzbHJUc2lKenNuWVFnNjdDVTZyNjhJT3lnbGV1UGhPeWRtQ0Rzb0p6c2xZanNuWVFnTStxd25DRHJpcGpzbHJUcmhwUHNwNEFnNjZlSTY1MjhJT0tBbENEcXQ3anFzYlFnN0lLczdKcXA3SjZRN0plUTZyS01JT3kybE95eW5PeWR0Q0RzbFlUcmk0anJuYndnNnJXUTdLQ1Y3Snk4NjZHY0lPdXp0T3lkdU91THBDNGdKeUFyQ2lBZ0lDQW43SldFNjU2WUlPeVlpT3lMbk91VHBPeWRnQ0R0bFp3ZzdLU0U3S2VjNjZhc0lPeTFuT3lHakNEcXRaRHNvSlhzbmJRZzY2ZU83S2VBNjZlTUlPcTN1T3F4dENEdGhxUW83WlcwN0pxVTdMSzB3cmZxc3Izc2xyUXA3SjJZSU9xMWtPdXp1T3lkdE95bmdDRHNob3pxdDduc2hMSHNuWmdnNnJXUTY3TzQ3SjIwSU95VmhPdUxpT3VMcENEaWdKUWc3SmVzNjUrc0lPdXN1T3llcGV5bm5PdW1yQ0Rzbm9Ycm9LWHNuWUFnNjZtVTdJdWM3S2VBSU91THFPeWNoT3VobkNEcmk2VHNpNXdnN0lTazZyT0U3WldZNjUyOExseHVKeUFyQ2lBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU91d3NPeVh0T3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUxwT3lhdE1LMzdJU2s2NnFGd3Jmc3ZaVHJrNXp0anB6c2lxUWc2cmlJN0tlQU9seHVKeUFyQ2lBZ0lDQW5XM3NpZEdWNGRDSTZJQ0xzb0p6c2xZZ2c2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0p5WldGemIyNGlPaUFpNjZ5MDdKZUg3SjJFSU95Wm5DRHJzSlRxdjZqcmlwVHNwNEFnN1pXYzZyV3Q3SmEwSU8yVm5DRHJyTGpzbnFVaWZTd2dMaTR1WFZ4dVhHNG5JQ3NLSUNBZ0lDZGI3SXFrN1lPQTdKMjhJT3Ezbk95NW1WMWNiaWNnS3lCVFZGbE1SVjlTVlV4RlV5QXJJQ2RjYmx4dUp5QXJDaUFnSUNBb1IxVkpSRVVnUHlBblcreUtwTzJEZ095ZHZDRHFzSURzbmJUcms1d2c3S0NFNjZ5NElDaDFlQzEzY21sMGFXNW5MbTFrS1NEaWdKUWc3SnlFSU9xM25PeTVtZXlkbUNEcXQ3enFzYkRzbVlBZzdKaUk3Sm00SU95TG5PdUNtT3Vtck95WXBDNGc3WXE1N1o2SUlPeVlpT3ladUNEcXQ1enN1WmtvN0lpWTY0K1o3WmlWd3JmcXNyM3NsclRDdCt1MmdPeWdsZTJZbGV5ZGhDRHNuS0RzcDREdGxiVHNsYndnN1pXWTY0cVVJT3lEZ2UyWnFTbnNuWVFnNnJlNDY0eUE2NkdjSU91VXNPdWx0T3F6b0N3ZzdKcVU3Slc5NnJPOElPeWdoT3VzdU95ZHRDRHJpNlRycGJUcnFiUWc3S0NFNjZ5NDdKMkVJT3VVc091bHVPdUxwRjFjYmljZ0t5QkhWVWxFUlNBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW9abVYzVTJodmRDQS9JQ2RiN0pxdzY2YXNJT3VxcWV5R2pPdW1yQ0RzbUlqc2k1d2c0b0NVSU95ZHRDRHRocVRzbllRZzY1U3c2Nlc4SU9xeWcxMWNiaWNnS3lCbVpYZFRhRzkwSUNzZ0oxeHVYRzRuSURvZ0p5Y3BJQ3NLSUNBZ0lDZnNwSURydVlUcmtKRHNuTHpycWJRZ0lrOUxJdXVkdk9xem9PdW5qQ0RyaTdYdGxaanJuYnd1SndvZ0lDazdDbjBLQ2k4dklPS1VnT0tVZ0NEc2c0SHNpNXdnNjR5QTZyaXdJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDbXhsZENCd2NtOWpJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDQWdMeThnN1lHMDY2R2M2NU9jSU8yVWhPdWhuT3lFdU95S3BBcHNaWFFnYkdsdVpVSjFaaUE5SUNjbk95QWdJQ0FnSUNBZ0lDOHZJSE4wWkc5MWRDRHNwSVFnNjdLRTdZMjhDbXhsZENCM1lXbDBaWElnUFNCdWRXeHNPeUFnSUNBZ0lDQWdMeThnN1ppRTdKNnNJTzJFdE95ZG1DQjdJSEpsYzI5c2RtVXNJSEpsYW1WamRDd2dkR2x0WlhJZ2ZRcHNaWFFnY1hWbGRXVWdQU0JRY205dGFYTmxMbkpsYzI5c2RtVW9LVHNnTHk4ZzdKcVU3TEt0SU95bmdldWdyTzJabENBbzY0K1o3SXVjSU95YWxPeXlyZXlkZ0NEc2lKenNoSnpyaklEcm9ad3BDbXhsZENCMGRYSnVjeUE5SURBN0NteGxkQ0IzWVhKdFpXUlZjQ0E5SUdaaGJITmxPd3BzWlhRZ1kzVnljbVZ1ZEUxdlpHVnNJRDBnUTB4QlZVUkZYMDFQUkVWTU95QXZMeURzcDREcXVJZ2c3SVM0N0lXWTdKMjBJT3Vzdk9xem9DRHNub2pyaXBRZzY2cW82NDI0SUNqc21wVHNzcTNzbmJRZzY0dWs2Nlc0SU91cXFPdU51T3lkaENEc3A0RHNvSlh0bFpqcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTa0tMeThnN0l1YzdKNlJJT3lMbkNCRGJHRjFaR1VnUTI5a1pTaGpiR0YxWkdVZ1EweEpLZXF3Z0NEc2s3Z2c3SWlZSU95ZWlPdUtsT3luZ0NEc29KRHFzb0FnNG9DVUlPeVhodXljdk91cHRDQXZhR1ZoYkhSbzY2R2NJT3lWak91Z3BDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdKV0k2NEswN1pXYzY0dWtMZ292THlCdWRXeHNQZTJabGV5ZHVDRHNwSkVzSUNkdmF5Yzk3SUtzN0pxcElPcXdnT3VLcFN3Z0oyTnNZWFZrWlMxdGFYTnphVzVuSnoxamJHRjFaR1VnNjZxRjY2QzVJT3lYaHV5ZGpDd0tMeThnSjJOc1lYVmtaUzFzYjJkdmRYUW5QV05zWVhWa1pldUtsQ0Rzbm9qc3A0RHJwNHdnNjZHYzZyZTQ3SjI0SU95RXVPeUZtQ0RycDR6cm80d2dLTzJFdENEc2k2VHRqS2dnN0l1Y0lPcXdrT3luZ0N3ZzdJU3g2ck8xSU8yRXRPeWR0Q0RzbUtUcnFiUWc3SjZRNjQrWklPMlZ0T3lnbkNrS2JHVjBJR05zWVhWa1pWTjBZWFIxY3lBOUlHNTFiR3c3Q2k4dklPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBSU9LQWxDQkRURW5xc0lBZzY0SzA2NHFVSU95WWdleVd0Q0RzbmJqc3BwMGc3SmlrNjZXWTY2VzhJT3lDck91ZWpPeWR0Q0RzbFl6c2xZVHJrNlRzbllRZzdKV0k2NEswNjZHY0lPdXdsT3Erdk91THBDNEtMeThnS0dOc1lYVmtaU0F0TFhabGNuTnBiMjdzbllBZzY2R2M2cmU0N0oyNElPeVhodXlkdE91UGhDRHNoTEhxczdYdGxiVHNoSndnN0l1YzY0K1pJT3lna09xeWdPeWN2T3Vobk91S2xDRHJxcnNnN0o2aDZyT2dMQ0RzaTZUc29Kd2c3WVMwN0plUTdJU2M2NmVNSU91VG5PdWZyT3VDbk91THBDa0tMeThnSXV1bmpPdWpqQ0xycDR6c25iUWc3SldFNjR1STY1MjhJQ0x0bFp3ZzY3S0k2NCtFSU91aG5PcTN1T3lkdUNEc2xZZ2c3WldvSXV1UGhDRHFzSm5zbllBZzZySzk2NkdjNjZHY0lPeWVvZTJlaU91dmdPdWhuQ0RzcEpIcnByMGc3WkdjN1ppRTdKMkVJT3lUdE91THBBcGpiMjV6ZENCTVQwZEpUbDlIVlVsRVJTQTlJQ2Z0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0N0oyMElPMlZoT3lhbE8yVnRPeWFsQ2pzbFlnZzY1Q1E2ckd3NjRLWUlPdW5qT3VqakNrZzRvQ1VJRnZ3bjUrZ0lPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c3WldFN0pxVVhTRHJzb1R0aXJ6c25ZUWc2NGlFNjZXMDY2bTBJT3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc3SmUwN0phMDY1T2M2NkNrN0pxVUxpYzdDaTh2SU95THBPeTRvZTJWbkNEcnJManF0YXpyazZRNklDSkdZV2xzWldRZ2RHOGdZWFYwYUdWdWRHbGpZWFJsT2lCUFFYVjBhQ0J6WlhOemFXOXVJR1Y0Y0dseVpXUWdZVzVrSUdOdmRXeGtJRzV2ZENCaVpTQnlaV1p5WlhOb1pXUWlLT3Vuak91ampDa3NDaTh2SUNKT2IzUWdiRzluWjJWa0lHbHVJTUszSUZCc1pXRnpaU0J5ZFc0Z0wyeHZaMmx1SWlqcnI3anJvWnpxdDdqc25iZ3BJT0tBbENEcmtaZ2c2NHVrSU95ZW9lMmVpT3F5akNEcmhKUHRub3pyaTZRS1puVnVZM1JwYjI0Z2FYTkJkWFJvUlhKeWIzSW9jeWtnZXdvZ0lISmxkSFZ5YmlBdllYVjBhR1Z1ZEdsallYUjhiMkYxZEdoOFlYQnBJR3RsZVh4c2IyY2dQMmx1Zkd4dloyZGxaSHh6WlhOemFXOXVJR1Y0Y0dseVpXUXZhUzUwWlhOMEtGTjBjbWx1WnloektTazdDbjBLTHk4ZzY2R2M2cmU0N0oyNDY1Q2NJT3F6aE95Z2xTRHRtWlhzbmJnZzRvQ1VJRU5NU2Vxd2dDQitMeTVqYkdGMVpHVXVhbk52YnV5WGtDRHF1TERyb1ozdGxaanJpcFFnYjJGMWRHaEJZMk52ZFc1MExtVnRZV2xzUVdSa2NtVnpjK3VsdkNEc25iM3NsclFLTHk4Z0wyaGxZV3gwYU91aG5DRHJoYmpzdHB6dGxaenJpNlFnS08yVWpPdWZyT3EzdU95ZHVPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFFnN0tTUjdKMjQ3S2VBSWlEdGtaenNpNXdnNG9DVUlPcXp0ZXlhcVNCUVEreVhrT3lFbkNEcmdxanNuWmdnNnJPRTdLQ1ZJT3lZcE95Q3JPeWFxU0Ryc0tuc3A0QXBMZ292THlEdGpJenNuYnpzbmJRZzdZRzBJT3lJbUNEc25vanNsclFvN1pTRTY2R2M3S0NkN1lxNElPeWR0T3VncFNEdGo2enRsYWdwSURNdzdMU0lJT3k2a095TG5DNGc3SjZzNjZHYzZyZTQ3SjI0N1pXWTY2bTBJRU5NU2Vxd2dDRHRqSXpzbmJ6c25ZUWc2ckN4N0l1ZzdaV1k2NitBNjZHY0lPeWVrT3VQbVNEcnNKanNtSUhya0p6cmk2UXVDbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93cG1kVzVqZEdsdmJpQmpiR0YxWkdWQlkyTnZkVzUwS0NrZ2V3b2dJR2xtSUNoRVlYUmxMbTV2ZHlncElDMGdZV05qYjNWdWRFTmhZMmhsTG1GMElEd2dNekF3TURBcElISmxkSFZ5YmlCaFkyTnZkVzUwUTJGamFHVXVaVzFoYVd3N0NpQWdiR1YwSUdWdFlXbHNJRDBnYm5Wc2JEc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdhaUE5SUVwVFQwNHVjR0Z5YzJVb1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxMbXB6YjI0bktTd2dKM1YwWmpnbktTazdDaUFnSUNCbGJXRnBiQ0E5SUNocUlDWW1JR291YjJGMWRHaEJZMk52ZFc1MElDWW1JR291YjJGMWRHaEJZMk52ZFc1MExtVnRZV2xzUVdSa2NtVnpjeWtnZkh3Z2JuVnNiRHNLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcm9aenF0N2pzbmJnZzdKMjA2NkNsSU95WGh1eWRqQ0RyazdFZzRvQ1VJRzUxYkd3ZzdKeWc3S2VBSUNvdklIMEtJQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lCRVlYUmxMbTV2ZHlncExDQmxiV0ZwYkNCOU93b2dJSEpsZEhWeWJpQmxiV0ZwYkRzS2ZRcG1kVzVqZEdsdmJpQmphR1ZqYTBOc1lYVmtaVUYyWVdsc1lXSnNaU2dwSUhzS0lDQmpiMjV6ZENCd2NtOWlaU0E5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSnkwdGRtVnljMmx2YmlkZExDQjdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlnZlNrN0NpQWdiR1YwSUc5MWRDQTlJQ2NuT3dvZ0lIQnliMkpsTG5OMFpHOTFkQzV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3SUc5MWRDQXJQU0JrTG5SdlUzUnlhVzVuS0NrN0lIMHBPd29nSUhCeWIySmxMbTl1S0NkbGNuSnZjaWNzSUNncElEMCtJSHNnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMk5zWVhWa1pTMXRhWE56YVc1bkp6c2dmU2s3Q2lBZ2NISnZZbVV1YjI0b0oyTnNiM05sSnl3Z0tHTnZaR1VwSUQwK0lIc0tJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2hqYjJSbElEMDlQU0F3SUNZbUlDOWNaQ3RjTGx4a0t5OHVkR1Z6ZENodmRYUXBLU0EvSUNkdmF5Y2dPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25Pd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJRU5zWVhWa1pTQkRiMlJsSU95Z2tPcXlnRG9nSnlBcklHTnNZWFZrWlZOMFlYUjFjeUFySUNodmRYUWdQeUFuSUNnbklDc2diM1YwTG5SeWFXMG9LU0FySUNjcEp5QTZJQ2NuS1NrN0NpQWdmU2s3Q24wS0x5OGc3TEtZNjZhc0lPMlloTzJacVNEaWdKUWdMMmhsWVd4MGFPdWhuQ0RyaGJqc3RwenRsYlFnSXV5Z2xldW5rQ0R0Z2JUcm9aenJrNXpxc0lBZzY0dTE3WmFJNjRxVTdLZUFJaURyc0pic2w1RHNoSndnN1ptVjdKMjQ3WldnSU95SW1DRHNub2pxc293ZzdaV2M2NHVrQ21OdmJuTjBJSE4wWVhSeklEMGdleUJ6WlhKMlpXUTZJREFzSUd4aGMzUkJkRG9nSnljc0lHeGhjM1JVWlhoME9pQW5KeXdnYkdGemRGTmxZem9nSnljZ2ZUc0tDaTh2SU9LVWdPS1VnQ0R0bEl6cm42enF0N2pzbmJnZzdJT2Q3S0cwSU9xd2tPeW5nQ2pzaTZ6c25xWHJzSlhyajVrcElPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0Fvdkx5RHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY1YWdJT3llaU91S2xDRHJqNW5zbFlnZ1kyOWtaUzUwYytxd2dDQTE3TFNJNjZlSTY0dWtJRkJQVTFRZ0wyaGxZWEowWW1WaGRPdWx2Q0RyczdUcmdyanJpNlF1Q2k4dklPMlZuQ0Ryc29qc25iVHJuYnpyajRRZzY3Q2I3SjJBSU91U3BDQXpNT3kwaU9xd2hDRHJnWXJxdUxEcnFiUWc3WlNNNjUrczZyZTQ3SjI0S091WWtPdUtsQ0R0bEx6cXQ3anJwNGdwN0oyMElPdUxxKzJlakNEcXNvTWc0b0NVSU8yQnRPdWhuT3VUbk9xNWpPeW5nQ0RyamJEcnBxenFzNkFnNnJDWjdKMjBJT3E2dk95bmhPdUxwQzRLTHk4ZzdKV0U3S2VCSU8yVm5DRHJzb2pyajRRZzY2cTdJT3V3bSt5Vm1PeWN2T3VwdENqcmk2VHJwcXpycDR3ZzY2aTg3S0NBSU95OG9DRHNnNEh0ZzV3c0lPeWVrT3VQbWV5TG5PeWVrU0RyazdFcElPcXpoT3lHalNEcmpJRHF1TER0bFp6cmk2UXVDbU52Ym5OMElFaEZRVkpVUWtWQlZGOUVSVUZFWDAxVElEMGdNekF3TURBN0NteGxkQ0JzWVhOMFFtVmhkQ0E5SURBN0NuTmxkRWx1ZEdWeWRtRnNLQ2dwSUQwK0lIc0tJQ0JwWmlBb2JHRnpkRUpsWVhRZ0ppWWdSR0YwWlM1dWIzY29LU0F0SUd4aGMzUkNaV0YwSUQ0Z1NFVkJVbFJDUlVGVVgwUkZRVVJmVFZNcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRsSXpybjZ6cXQ3anNuYmdnN0l1czdKNmw2N0NWNjQrWklPdUJpdXE1Z0NEaWdKUWc3WlM4NnJlNDY2ZUlMKzJVak91ZnJPcTN1T3lkdU95ZHRDRHJpNnZ0bm93ZzZyS0Q3Snk4NjZHY0lPdXp0T3F6b0NEcXNKbnNuYlFnNnJxODdLZVI2NHVJNjR1a0xpY3BPd29nSUNBZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3lBdkx5QmxlR2wwSU8yVnVPdVRwT3Vmck9xd2dDQnJhV3hzVUhKdlkreWN2T3VobkNCamJHRjFaR1VnN1lxNDY2YXM2Nlc4SU95Z2xldW1yTzJWbk91THBBb2dJSDBLZlN3Z05UQXdNQ2s3Q2dvdkx5RHJvWnpxdDdqc25iZ2dWVkpNN0oyRUlPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JQW82N08wN1lhMUlPeXd2U25yb1p3ZzdKZXM2NHFVSUVKU1QxZFRSVklnN1pXNDY1T2s2NStzSU95S3BPMkJyT3VtdmUyS3VPdWx2Q0RycDR6cms2RHJpNlF1Q2k4dklHTnNZWFZrWlNCRFRFbnJpcFFnUWxKUFYxTkZVaUR0bVpqcXNyM3JzNERzaUpqcnBid2c3S0cwN0tTUjdaVzBJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNwNEhzb0pFZzdKZTA3S2VBSU95Vml1cXpvQ0RzbmJRZzdJcWs3WUdzNjZhOTdZcTQ3SmVRSUdGMWRHaHZjbWw2WlNCVlVrenNuWVFnNjRTWTZyaTA2NHVrS095THBPeTRvU0F5TURJMkxUQTNLUzRLTHk4Z2JXOWtaVDBuYzNkcGRHTm9KeWpxczRUc29KVWc3S0NFN1ptWUtTRGlocElnN0lxNTdKMjRJTzJabE91cHRPeWRoQ0Rxc2JEc3VaanNwNEFnN0pXSzZyT2dJQ29xNnJPRTdLQ1ZJT3lFb08yRG5TRHRtWlRycWJUc25MenJvWndnNjdDVTY2R2NLaW9nNjdPMDY0SzQ2NHVrTGdvdkx5QWdJT3Vobk9xM3VPeWR1T3VRbkNEc2c0SHRnNXpycWJRZ1lYVjBhRzl5YVhwbDZyQ0FJT3lLdWV5ZHVDRHRtWlRycWJUc25MenJvWndnNnJDQTZyT2dJSE5sYkdWamRFRmpZMjkxYm5ROWRISjFaY0szY0hKdmJYQjBQWE5sYkdWamRGOWhZMk52ZFc1MDY2R2M2NCtFSU91cXV5RHJtcXZzbkx6cnI0RHJvWndvN0l1azdMaWhLU3dLTHk4Z0lDRHRsWndnN1lPdElPeVZpT3lYa095RW5DQmpiR0YxWkdVdVlXa3ZiRzluYjNWMFAzSmxkSFZ5YmxSdlBUeDFjbXd0Wlc1amIyUmxaQ0F2YjJGMWRHZ3ZZWFYwYUc5eWFYcGxQMUZWUlZKWktPeURnZXVNZ09xeXZldWhuQ2srNjZHY0lPeWVoK3VLbE91THBEb0tMeThnSUNEcm9aenF0N2pzbFlUc200TW83SVM0N0lXWUlPeW5nT3liZ0NrZzRvYVNJR3h2WjJsdVAzTmxiR1ZqZEVGalkyOTFiblE5ZEhKMVpTanFzNFRzb0pVZzdJU2c3WU9kS2V1aG5DRHNucERyajVrZzdMSzA3SjIwNjR1ZEtPeUxwT3k0b1RvZzY0dW83SjI4SU8yRHJTa3VJT3lLdWV5ZHVDRHRtWlRycWJRZzdaV1k2NHVvQ2k4dklDQWdXK3F6aE95Z2xTRHNvSVR0bVpoZElPdXloTzJLdk95ZHRDRHRsWmpyaXBRZzdKMjg2ck84SU9xd21leWRnQ0Rxc3JEcXM3d2c0b0NVSU91THBPdW5qQ0RzbXJEcnBxenFzSUFnNnJPbjdKNmxJT3EzdUNEdG1aVHJxYlRzbkx6cm9ad2c2N08wNjRLNDY0dWtMZ292THlBZ0lDanJ0b0RzbnBIc21xazZJT3U0ak91ZHZPeWFzT3lnZ095ZG1DQmpiR0YxWkdVdVlXa2c3SnU1SU91aG5PcTN1T3lkdU91UGhDRHRrb0RycHJ3ZzRvQ1VJT3F6aE95Z2xTRHNvSVR0bVpnZzdKMlk2NCtFN0ptQUlPdXdxZTJXcGV5ZHRDRHFzSm5zbFlRZzdJaVk3SnFwTGlrS0x5OGdiVzlrWlQwbmJtOXliV0ZzSnlqcnA0enJvNHdnN0o2czY2R2M2cmU0N0oyNEtTRGlocElnNjZHYzZyZTQ3SldFN0p1RElPeVhodXlkdENEcXQ3anJnNlVnN0pldzY0dWtLT3VNZ09xd25DRHFzSm5zbllBZzZyT0U3S0NWN0oyMDY1MjhJT3lFdU95Rm1DRHNuS0RzcDREcXNJQWc2N21nNjZhRUtTNEtablZ1WTNScGIyNGdkM0pwZEdWQ2NtOTNjMlZ5U0dGdVpHeGxjaWh0YjJSbEtTQjdDaUFnWTI5dWMzUWdiRzluYjNWMElEMGdiVzlrWlNBOVBUMGdKM04zYVhSamFDYzdDaUFnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNLSUNBZ0lHTnZibk4wSUdOdFpDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0WW5KdmQzTmxjaTBuSUNzZ2JXOWtaU0FySUNjdVkyMWtKeWs3Q2lBZ0lDQmpiMjV6ZENCd2N5QTlJR3h2WjI5MWRBb2dJQ0FnSUNBL0lDSWtkVDBrWlc1Mk9rTkNYMVZTVERzZ0pHazlKSFV1U1c1a1pYaFBaaWduYjJGMWRHZ3ZZWFYwYUc5eWFYcGxKeWs3SUdsbUtDUnBJQzFuWlNBd0tYc2dKSEpsYkQwbkx5Y3JKSFV1VTNWaWMzUnlhVzVuS0NScEtUc2dKR1Z1WXoxYlUzbHpkR1Z0TGxWeWFWMDZPa1Z6WTJGd1pVUmhkR0ZUZEhKcGJtY29KSEpsYkNrN0lGTjBZWEowTFZCeWIyTmxjM01nS0Nkb2RIUndjem92TDJOc1lYVmtaUzVoYVM5c2IyZHZkWFEvY21WMGRYSnVWRzg5Snlza1pXNWpLU0I5SUdWc2MyVWdleUJUZEdGeWRDMVFjbTlqWlhOeklDUjFJSDBpQ2lBZ0lDQWdJRG9nSjFOMFlYSjBMVkJ5YjJObGMzTWdKR1Z1ZGpwRFFsOVZVa3duT3dvZ0lDQWdabk11ZDNKcGRHVkdhV3hsVTNsdVl5aGpiV1FzSUNkQVpXTm9ieUJ2Wm1aY2NseHVjMlYwSUNKRFFsOVZVa3c5Slg0eElseHlYRzV3YjNkbGNuTm9aV3hzSUMxT2IxQnliMlpwYkdVZ0xVVjRaV04xZEdsdmJsQnZiR2xqZVNCQ2VYQmhjM01nTFVOdmJXMWhibVFnSWljZ0t5QndjeUFySUNjaVhISmNiaWNwT3dvZ0lDQWdjbVYwZFhKdUlHTnRaRHNLSUNCOUNpQWdZMjl1YzNRZ2MyZ2dQU0J3WVhSb0xtcHZhVzRvYjNNdWRHMXdaR2x5S0Nrc0lDZGpiR0YxWkdVdFluSnBaR2RsTFdKeWIzZHpaWEl0SnlBcklHMXZaR1VnS3lBbkxuTm9KeWs3Q2lBZ1kyOXVjM1FnYm05a1pVSnBiaUE5SUhCeWIyTmxjM011WlhobFkxQmhkR2c3SUM4dklPeWdoQ0JQVSt5WGtDQnViMlJsSU95ZWlPeWRqQ2pyaTZUcnBxenFzSUFnYm05a1pldWhuQ0RyajQ0cExpRHJzNER0bVpnZzdJdWs3WXlvSU95TG5DRHNtNURyczdnZ1ZWSk1JT3EzdU91TWdPdWhuQ0RzbDdEcmk2UW9abUZwYkMxemIyWjBLUzRLSUNCamIyNXpkQ0JpYjJSNUlEMGdiRzluYjNWMENpQWdJQ0EvSUNjaklTOWlhVzR2YzJoY2JpY2dLd29nSUNBZ0lDQW5WVDBrS0NJbklDc2dibTlrWlVKcGJpQXJJQ2NpSUMxbElGd25ZMjl1YzNRZ2RUMXdjbTlqWlhOekxtRnlaM1piTVYwN1kyOXVjM1FnYVQxMUxtbHVaR1Y0VDJZb0ltOWhkWFJvTDJGMWRHaHZjbWw2WlNJcE8zQnliMk5sYzNNdWMzUmtiM1YwTG5keWFYUmxLR2s4TUQ5MU9pSm9kSFJ3Y3pvdkwyTnNZWFZrWlM1aGFTOXNiMmR2ZFhRL2NtVjBkWEp1Vkc4OUlpdGxibU52WkdWVlVrbERiMjF3YjI1bGJuUW9JaThpSzNVdWMyeHBZMlVvYVNrcEtWd25JQ0lrTVNJZ01qNHZaR1YyTDI1MWJHd3BYRzRuSUNzS0lDQWdJQ0FnSjI5d1pXNGdJaVI3VlRvdEpERjlJbHh1SndvZ0lDQWdPaUFuSXlFdlltbHVMM05vWEc1dmNHVnVJQ0lrTVNKY2JpYzdDaUFnWm5NdWQzSnBkR1ZHYVd4bFUzbHVZeWh6YUN3Z1ltOWtlU2s3Q2lBZ1puTXVZMmh0YjJSVGVXNWpLSE5vTENBd2J6YzFOU2s3Q2lBZ2NtVjBkWEp1SUhOb093cDlDZ292THlEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJTzJVaE91aG5PeUV1T3lLcENBb1kyeGhkV1JsSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFTa2c0b0NVSUM5dmNHVnVMV3h2WjJsdTdKMjBJT3lEbmV5RXNjSzM2clNBNjZhc0xnb3ZMeURydUl6cm5ienNtckRzb0lEcXNJQWdiRzlqWVd4b2IzTjA2NkdjSU9xeXNPcXp2T3VsdkNEcnM3VHJnclRzcElRZzY1V002cm1NN0tlQUlPeUlxT3lXdE95RW5DRHJqSURxdUxEdGxaanJpNlRxc0lBc0lPeVpoT3Vqak91UW1PdXB0Q0RzaXFUc2lxVHJvWndnNjRHZDY0S2M2NHVrTGdwc1pYUWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVM1JoY25SbFpFRjBJRDBnTURzZ0x5OGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVnN0l1YzZyQ0JJT0tBbENEc25xenRnYlRycHEzc25iUWdKK3llck95TG5PdVBoQ2ZzbmJqc3A0QWdKK3lla091UG1leVpoT3VqakNEc2k2VHRqS2duN0oyNDdLZUFJT3Exck91MmhPMlZuT3VMcEFwbWRXNWpkR2x2YmlCcmFXeHNURzluYVc1UWNtOWpLQ2tnZXdvZ0lHbG1JQ2hzYjJkcGJsQnliMk5VYVcxbGNpa2dleUJqYkdWaGNsUnBiV1Z2ZFhRb2JHOW5hVzVRY205alZHbHRaWElwT3lCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUc1MWJHdzdJSDBLSUNCcFppQW9JV3h2WjJsdVVISnZZeWtnY21WMGRYSnVPd29nSUdOdmJuTjBJSEFnUFNCc2IyZHBibEJ5YjJNN0NpQWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tJQ0IwY25rZ2V3b2dJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNLSUNBZ0lDQWdjM0JoZDI1VGVXNWpLQ2QwWVhOcmEybHNiQ2NzSUZzbkwxQkpSQ2NzSUZOMGNtbHVaeWh3TG5CcFpDa3NJQ2N2VkNjc0lDY3ZSaWRkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnlCOUtUc0tJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0M1d2FXUXNJQ2RUU1VkVVJWSk5KeWs3SUgwZ1kyRjBZMmdnS0Y5bE1pa2dleUJ3TG10cGJHd29LVHNnZlFvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91c3RPeUxuQ0FxTHlCOUNuMEtDbVoxYm1OMGFXOXVJR3RwYkd4UWNtOWpLQ2tnZXdvZ0lHbG1JQ2h3Y205aktTQjdDaUFnSUNCMGNua2dld29nSUNBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSE5vWld4c09uUnlkV1hyb1p3ZzY1MkU3SnVNN0lTY0lIQnliMlBzbllBZ1kyMWtJT3E3amV1TnNPcTRzQ0RpZ0pRZ0wxVHJvWndnN1lxNDY2YXM3S2U0SU95anZleVhyT3lWdkNEc3A0VHNwNXdnWTJ4aGRXUmw2ckNBSU9xem9PeVZoT3VobkNEc2xZZ2c2NEtvNjRxVTY0dWtDaUFnSUNBZ0lDQWdMeThnS09xem9PeVZoQ0JqYkdGMVpHWHFzSUFnN0lTazdMbVlJTzJNak95ZHZPeWRoQ0Ryckx6cXM2QWc3SjZJN0p5ODY2bTBJTzJCdE91aG5PdVRuQ0RzbGJFZzdKZUY2NDJ3N0oyMDdZcTQ2ckNBSUNMc2dxenNtcWtnN0tTUkl1eWN2T3VobkNEcnA0bnRucGdwQ2lBZ0lDQWdJQ0FnYzNCaGQyNVRlVzVqS0NkMFlYTnJhMmxzYkNjc0lGc25MMUJKUkNjc0lGTjBjbWx1Wnlod2NtOWpMbkJwWkNrc0lDY3ZWQ2NzSUNjdlJpZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0F2THlCdFlXTlBVeS9ycHF6cmlJWHNpcVE2SUhOb1pXeHNPblJ5ZFdYcm5id2djSEp2WSt5ZHRDQnphQ0RxdTQzcmpiRHF1TERzbmJ3ZzdJaVlJT3llaU95ZGpDRGlnSlFnYzNSaGNuUlFjbTlqN0oyWUlHUmxkR0ZqYUdWazY2R2NJT3Vuak91VG9Bb2dJQ0FnSUNBZ0lDOHZJTzJVaE91aG5PeUV1T3lLcENEcXQ3anJvN2tvTFhCcFpDbnNuWVFnN1lhMTdLZTQ2NkdjSU95Z2xldW1yTzJWbk91THBDQW9kR0Z6YTJ0cGJHd2dMMVFnNjR5QTdKMlJLUW9nSUNBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0hKdll5NXdhV1FzSUNkVFNVZFVSVkpOSnlrN0lIMGdZMkYwWTJnZ0tGOWxNaWtnZXlCd2NtOWpMbXRwYkd3b0tUc2dmUW9nSUNBZ0lDQjlDaUFnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRb2dJSDBLSUNCd2NtOWpJRDBnYm5Wc2JEc0tJQ0IzWVhKdFpXUlZjQ0E5SUdaaGJITmxPd29nSUdsbUlDaDNZV2wwWlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0hkaGFYUmxjaTUwYVcxbGNpazdJSGRoYVhSbGNpNXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lpaGV1ampPdVFrT3lXdE95YWxDNG5LU2s3SUhkaGFYUmxjaUE5SUc1MWJHdzdJSDBLZlFvS1puVnVZM1JwYjI0Z2MzUmhjblJRY205aktDa2dld29nSUd0cGJHeFFjbTlqS0NrN0NpQWdiR2x1WlVKMVppQTlJQ2NuT3dvZ0lIUjFjbTV6SUQwZ01Ec0tJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPeUV1T3lGbUNEc2k1enJqNWtnN0tTUjRvQ21JQ2pycXFqcmpiZzZJQ2NnS3lCamRYSnlaVzUwVFc5a1pXd2dLeUFuS1NjcE93b2dJR052Ym5OMElIUm9hWE5RY205aklEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25MWEFuTENBbkxTMXRiMlJsYkNjc0lHTjFjbkpsYm5STmIyUmxiQ3dnSnkwdGFXNXdkWFF0Wm05eWJXRjBKeXdnSjNOMGNtVmhiUzFxYzI5dUp5d2dKeTB0YjNWMGNIVjBMV1p2Y20xaGRDY3NJQ2R6ZEhKbFlXMHRhbk52Ymljc0lDY3RMWFpsY21KdmMyVW5YU3dnZXdvZ0lDQWdjMmhsYkd3NklIUnlkV1VzSUdOM1pEb2dSVTFRVkZsZlExZEVMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWXNDaUFnSUNCa1pYUmhZMmhsWkRvZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBaFBUMGdKM2RwYmpNeUp5d2dMeThnVUU5VFNWZzZJT3lla09xNHNDRHRsSVRyb1p6c2hManNpcVFnNnJlNDY2TzVJT3lEbmV5RXNTRGlnSlFnYTJsc2JGQnliMlBzbmJRZzZyZTQ2Nk81N0tlNElPeWdsZXVtck8yVm9DRHNpSmdnN0o2STZyS01DaUFnZlNrN0NpQWdjSEp2WXlBOUlIUm9hWE5RY205ak93b2dJSEJ5YjJNdWMzUmtiM1YwTG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzS0lDQWdJR3hwYm1WQ2RXWWdLejBnWkM1MGIxTjBjbWx1WnlnbmRYUm1PQ2NwT3dvZ0lDQWdiR1YwSUdsa2VEc0tJQ0FnSUhkb2FXeGxJQ2dvYVdSNElEMGdiR2x1WlVKMVppNXBibVJsZUU5bUtDZGNiaWNwS1NBaFBUMGdMVEVwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlHeHBibVZDZFdZdWMyeHBZMlVvTUN3Z2FXUjRLUzUwY21sdEtDazdDaUFnSUNBZ0lHeHBibVZDZFdZZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0dsa2VDQXJJREVwT3dvZ0lDQWdJQ0JwWmlBb0lXeHBibVVwSUdOdmJuUnBiblZsT3dvZ0lDQWdJQ0JzWlhRZ1pYWWdQU0J1ZFd4c093b2dJQ0FnSUNCMGNua2dleUJsZGlBOUlFcFRUMDR1Y0dGeWMyVW9iR2x1WlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUdOdmJuUnBiblZsT3lCOUNpQWdJQ0FnSUdsbUlDaGxkaUFtSmlCbGRpNTBlWEJsSUQwOVBTQW5jbVZ6ZFd4MEp5QW1KaUIzWVdsMFpYSXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emRDQjNJRDBnZDJGcGRHVnlPd29nSUNBZ0lDQWdJSGRoYVhSbGNpQTlJRzUxYkd3N0NpQWdJQ0FnSUNBZ1kyeGxZWEpVYVcxbGIzVjBLSGN1ZEdsdFpYSXBPd29nSUNBZ0lDQWdJR2xtSUNobGRpNXBjMTlsY25KdmNpa2dld29nSUNBZ0lDQWdJQ0FnWTI5dWMzUWdjbUYzSUQwZ1UzUnlhVzVuS0dWMkxuSmxjM1ZzZENCOGZDQmxkaTV6ZFdKMGVYQmxJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlNREFwT3dvZ0lDQWdJQ0FnSUNBZ2FXWWdLR2x6UVhWMGFFVnljbTl5S0hKaGR5a3BJSHNLSUNBZ0lDQWdJQ0FnSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnSjJOc1lYVmtaUzFzYjJkdmRYUW5PeUF2THlBdmFHVmhiSFJvNjZHY0lPMlVqT3Vmck9xM3VPeWR1T3lYa0NEc2xZenJwcndnNG9hU0lPdXloTzJLdk95ZHRDQmI2NkdjNnJlNDdKMjRJTzJWaE95YWxGM3JvWndnNjdDVTY0Q2NDaUFnSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJT3Vuak91ampDRHFzSkRzcDRBNkp5d2djbUYzS1RzS0lDQWdJQ0FnSUNBZ0lDQWdkeTV5WldwbFkzUW9ibVYzSUVWeWNtOXlLRXhQUjBsT1gwZFZTVVJGS1NrN0NpQWdJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNBZ0lDQWdJQ0IzTG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSisyQnRPdWhuT3VUbkNEc21LVHJwWmc2SUNjZ0t5QnlZWGNwS1RzS0lDQWdJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNBZ0lDQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ0oyOXJKenNnTHk4ZzdJU3g2ck8xSUQwZzdJU2s3TG1Zd3Jmcm9aenF0N2pzbmJnZzY0dWtJT3lnbGV5RGdTRGlnSlFnN0phMDY1YWtJSEJ5YjJKc1pXM3NuYlRyazZBZzdaVzA3S0NjSUNqc25xenJvWnpxdDdqc25iZ3Y3SjZzN0lTazdMbVlJT3V6dGVxM2dDa0tJQ0FnSUNBZ0lDQWdJSGN1Y21WemIyeDJaU2hUZEhKcGJtY29aWFl1Y21WemRXeDBJSHg4SUNjbktTazdDaUFnSUNBZ0lDQWdmUW9nSUNBZ0lDQjlDaUFnSUNCOUNpQWdmU2s3Q2lBZ2NISnZZeTV6ZEdSbGNuSXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdld29nSUNBZ1kyOXVjM1FnY3lBOUlHUXVkRzlUZEhKcGJtY29KM1YwWmpnbktTNTBjbWx0S0NrN0NpQWdJQ0JwWmlBb2N5QW1KaUFoY3k1cGJtTnNkV1JsY3lnblJHVndjbVZqWVhScGIyNVhZWEp1YVc1bkp5a3BJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCamJHRjFaR1VnYzNSa1pYSnlPaWNzSUhNdWMyeHBZMlVvTUN3Z01qQXdLU2s3Q2lBZ2ZTazdDaUFnY0hKdll5NXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdMeThnN0oyMDY2KzRJT3lEaUNEc2hManNoWmpzbkx6cm9ad2c2cldRN0xLMDY1Q2NJT3VTcENEc21Kc2c3SVM0N0lXWTdKMjBJT3VMcSsyZWpDRHFzYkRycWJRZzY2eTA3SXVjSUNqcnFxanJqYmdnN0tDRTdabVlJT3lMbkNEc2c0Z2c3SVM0N0lXWTdKMkVJT3lqdmV5ZHRPeW5nQ0RzbFlycXNvd3BDaUFnSUNCcFppQW9jSEp2WXlBaFBUMGdkR2hwYzFCeWIyTXBJSEpsZEhWeWJqc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c3SVM0N0lXWUlPeWloZXVqakNBb1kyOWtaU0FuSUNzZ1kyOWtaU0FySUNjcElPS0FsQ0RyaTZUc25Zd2c3SnFVN0xLdElPdVZqQ0RyaTZUc2k1d2c3SXVjNjQrWjdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0I5S1RzS2ZRb0tablZ1WTNScGIyNGdjMlZ1WkZSMWNtNG9kR1Y0ZENrZ2V3b2dJSEpsZEhWeWJpQnVaWGNnVUhKdmJXbHpaU2dvY21WemIyeDJaU3dnY21WcVpXTjBLU0E5UGlCN0NpQWdJQ0JwWmlBb0lYQnliMk1wSUhKbGRIVnliaUJ5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2Z0Z2JUcm9aenJrNXdnN0lTNDdJV1k3SjIwSU95WGh1eVd0T3lhbEM0bktTazdDaUFnSUNCcFppQW9kMkZwZEdWeUtTQnlaWFIxY200Z2NtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdKV2U3SVNnSU95YWxPeXlyZXlkdENEc3A0VHRsb2tnN0tTUjdKMjA3SmVRN0pxVUxpY3BLVHNLSUNBZ0lHTnZibk4wSUhScGJXVnlJRDBnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGhMUWc3SXVjNnJDRUlPeTBpT3F6dkNEaWdKUWc3SVM0N0lXWTdKMkVJT3llck95TG5PeWVrZTJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJQ0FnYTJsc2JGQnliMk1vS1RzS0lDQWdJSDBzSUZSVlVrNWZWRWxOUlU5VlZGOU5VeWs3Q2lBZ0lDQjNZV2wwWlhJZ1BTQjdJSEpsYzI5c2RtVXNJSEpsYW1WamRDd2dkR2x0WlhJZ2ZUc0tJQ0FnSUhCeWIyTXVjM1JrYVc0dWQzSnBkR1VvU2xOUFRpNXpkSEpwYm1kcFpua29leUIwZVhCbE9pQW5kWE5sY2ljc0lHMWxjM05oWjJVNklIc2djbTlzWlRvZ0ozVnpaWEluTENCamIyNTBaVzUwT2lCMFpYaDBJSDBnZlNrZ0t5QW5YRzRuTENBbmRYUm1PQ2NwT3dvZ0lIMHBPd3A5Q2dvdkx5RHFzSm5zbllBZzY2eTQ2cldzNjZXOElPdXFoeURyc29qc3A3Z2c2Nnk3NjRxVTdLZUFJT3E0c095V3RTRGlnSlFnN0o2czdKcVU3TEt0N0oyMDY2bTBJQ0xzbmJUc29JVHFzN3dnNjR1azY2VzRJT3lEaUNEc29KenNsWWdpN0oyRUlPeWFsT3Exck8yVm5PdUxwQW92THlBbzdKV0lJT3EzdU91ZnJPdXB0Q0R0Z2JUcm9aenJrNXpxc0lBZzdJU3g3SXVrN1pXWTZyS01JT3F3bWV5ZGdDRHJpN1hzbllRZzY1aVFJT3VDdE95RW5DQmJRVWtnN0xhVTdMS2NJT3VObENEcnNKdnF1TEJkNnJDQUlPdXN0T3lkbU91dnVPMlZ0T3luaE91THBDa0tZMjl1YzNRZ1lYTnJaV1JEYjNWdWRDQTlJRzVsZHlCTllYQW9LVHNLQ2k4dklPeUV1T3lGbUNEc3BJRHJ1WVFvN0l1YzY0K1pLK3luZ095TG5PdXN1Q0Rzbzd6c25vVXA2Nlc4SU91enRPeWVwZTJWbkNEcmtxUWc3WldjSU8yRXRDRHNpNlR0bG9rZzRvQ1VJT3VxcU91VG9DRHRtTGpzdHB6c25ZQWdjWFZsZFdYcm9ad2c3S2VCNjZDczdabVVMZ292THlCdGIyUmxiT3lkaENEc283enJxYlFnNnJlNElPdXFxT3VOdU91aG5DQW82NHVrNjZXMDY2bTBJT3lFdU95Rm1DRHNucXpzaTV6c25wRXBMaUR0bFp3ZzY2cW82NDI0N0oyRUlPcXpoT3lHalNEc2s3RHJxYlFnN0o2czdJdWM3SjZSN0oyQUlPeTFuT3kwaUNBeDdacU02NytRTGdwbWRXNWpkR2x2YmlCeWRXNVVkWEp1S0dKMWFXeGtRWE5yTENCdGIyUmxiQ2tnZXdvZ0lHTnZibk4wSUdwdllpQTlJSEYxWlhWbExuUm9aVzRvWVhONWJtTWdLQ2tnUFQ0Z2V3b2dJQ0FnYVdZZ0tHMXZaR1ZzSUNZbUlFRk1URTlYUlVSZlRVOUVSVXhUTG1sdVpHVjRUMllvYlc5a1pXd3BJQ0U5UFNBdE1TQW1KaUJ0YjJSbGJDQWhQVDBnWTNWeWNtVnVkRTF2WkdWc0tTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RycXFqcmpiZ2c2N09BNnJLOU9pQW5JQ3NnWTNWeWNtVnVkRTF2WkdWc0lDc2dKeURpaHBJZ0p5QXJJRzF2WkdWc0tUc0tJQ0FnSUNBZ1kzVnljbVZ1ZEUxdlpHVnNJRDBnYlc5a1pXdzdDaUFnSUNBZ0lITjBZWEowVUhKdll5Z3BPeUF2THlEc2c0Z2c2NnFvNjQyNDY2R2NJT3lFdU95Rm1DRHNucXpzaTV6c25wRWdLT3VMcE95ZGpDRHNtNHpyc0kzc2w0WHNsNURzaEp3ZzdLZUE3SXVjNjZ5NElPeWVyT3lqdk95ZWhTa0tJQ0FnSUgwS0lDQWdJR2xtSUNoMGRYSnVjeUErUFNCTlFWaGZWRlZTVGxNZ2ZId2dJWEJ5YjJNcElITjBZWEowVUhKdll5Z3BPd29nSUNBZ2FXWWdLQ0YzWVhKdFpXUlZjQ2tnZXdvZ0lDQWdJQ0JqYjI1emRDQjBNQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0FnSUdGM1lXbDBJSE5sYm1SVWRYSnVLR2x1YzNSeWRXTjBhVzl1VFdWemMyRm5aU2dwS1RzS0lDQWdJQ0FnZDJGeWJXVmtWWEFnUFNCMGNuVmxPd29nSUNBZ0lDQjBkWEp1Y3lzck93b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SVM0N0lXWUlPeWtnT3U1aENEc21ZVHJvNHdnS0NjZ0t5QW9LRVJoZEdVdWJtOTNLQ2tnTFNCME1Da2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBJQ3NnSjNNcElPS0FsQ0RzbmJUdG00UWc3SnFVN0xLdDdKMkFJT3U1cU91ZHZPeWFsQzRuS1RzS0lDQWdJSDBLSUNBZ0lIUjFjbTV6S3lzN0NpQWdJQ0J5WlhSMWNtNGdjMlZ1WkZSMWNtNG9ZblZwYkdSQmMyc29LU2s3Q2lBZ2ZTazdDaUFnTHk4ZzdaV2NJT3lhbE95eXJleWR0Q0RzaTZUdGpLanRsYlRyajRRZzY0dWs3SjJNSU95YWxPeXlyZXlkdENEc25iVHNsclRzcDREcmo0VHJvWjBnN1lHUTY0cVVJTzJWcmV5RGdTRHNoTEhxczdYc25MenJvWndnN0tDVjY2YXNDaUFnY1hWbGRXVWdQU0JxYjJJdVkyRjBZMmdvS0NrZ1BUNGdlMzBwT3dvZ0lISmxkSFZ5YmlCcWIySTdDbjBLQ2k4dklPdXN1T3ExckNEc3RwVHNzcHdnN1lTMENtWjFibU4wYVc5dUlHRnphME5zWVhWa1pTaDBaWGgwTENCdGIyUmxiQ2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lHTnZibk4wSUdGMGRHVnRjSFFnUFNBb1lYTnJaV1JEYjNWdWRDNW5aWFFvZEdWNGRDa2dmSHdnTUNrZ0t5QXhPd29nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvZEdWNGRDd2dZWFIwWlcxd2RDazdDaUFnSUNCcFppQW9ZWE5yWldSRGIzVnVkQzV6YVhwbElENGdNakF3S1NCaGMydGxaRU52ZFc1MExtTnNaV0Z5S0NrN0lDOHZJT3VzdE8yVm5PMmVpQ0RzakpQc25iVHNwNEFnN0pXSzZyS01DaUFnSUNCeVpYUjFjbTRnWVhSMFpXMXdkQ0ErSURFS0lDQWdJQ0FnUHlBbjZyQ1o3SjJBSU91c3VPcTFyT3VsdkNEcmk2VHNpNXdnN0pxVTdMS3Q3WldjNjR1a0xpRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3lnaE95WGtDRHNvSnpzbFlqdGxvanJqWmdnNnJLRDY1T2s2ck84SU9xeXVleTVtT3luZ0NEc2xZcnJpcFFzSU9xMXJPeWhzT3VDbUNEc2xyVHRuSmpxc0lBZzdabVY3SXVrN1o2SUlPdUxwT3VsdUNEc2c0anJvWnpzbXJRZzY0eUE3SldJSURQcXNKenJwYndnNnJlYzdMbVo2NHlBNjZHY0lFcFRUMDRnNjdDdzdKZTA2NkdjNjZlTU9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29kR1Y0ZENrS0lDQWdJQ0FnT2lBbjY0dWs3SjJNSUZWSklPdXN1T3Exck95ZG1DRHJqSURzbFlnZ00rcXduT3VsdkNEcXQ1enN1Wm5yaklEcm9ad2dTbE5QVGlEcnNMRHNsN1Ryb1p6cnA0dzZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtUc0tJQ0I5TENCdGIyUmxiQ2s3Q24wS0NpOHZJT3V5aU95WHJTRHRoTFFnNG9DVUlPcXdtZXlkZ0NEc2hManNoWmpzbllRZzdKT3c2NUNZTENEc25iVHJzb2dnN1lTMDY2ZU1JT3kybE95eW5DRHRtSlhzaTUwb1NsTlBUaURyc0xEc2w3UXBJT3VNZ095TG9DRHJzb2pzbDYwZzdaaVY3SXVkS0VwVFQwNGc2ckNkN0xLMEtleWRoQ0RzbXBUcXRhenRsWnpyaTZRS1puVnVZM1JwYjI0Z1lYTnJWSEpoYm5Oc1lYUmxLSFJsZUhRc0lHMXZaR1ZzS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnS0FvZ0lDQWdKK3lkdE91eWlDRHNtcFRzc3Ezc25ZQWc2N0tJN0pldElPeWVrZXlYaGV5ZHRPdUxwQ0FvNjZ5NDZyV3NJT3VMcE91VHJPcTRzQ0RzbFlUcmk1Z2c0b0NVSU91TWdPeVZpQ0F6NnJDY0lPcTNuT3k1bWV5ZGdDRHNuYlRyc29nZzdZUzA3SmVRSU95Z2dleWFxZTJWbU95bmdDRHNsWXJyaXBUcmk2UXBMaUFuSUNzS0lDQWdJQ2ZyaTZUc25Zd2dWVWtnNjZ5NDZyV3M2ckNBSU8yVm5PcTFyZXlXdE91cHRDRHNucERzbDdEc2lxVHJuNnpzbXJRZzdKaUI3SmEwNjZHY0xDRHNtSUhzbHJUcnFiUWc3SjZRN0pldzdJcWs2NStzN0pxMElPMlZuT3ExcmV5V3RPdWhuQ0Ryc29qc2w2M3RsWmpybmJ3dUlDY2dLd29nSUNBZ0oxVkpJT3VzdU9xMXJPdUxwT3lhdENEcXNJVHFzckR0bFp3ZzdaR2M3WmlFN0oyRUlPeVRzT3F6b0N3ZzdKMjA2NmFFd3Jmc2lLdnNucERDdCt1bmlPeUtwTzJDdWNLMzdaU002NkNJN0oyMDdJcWs3Wm1BNjQyVTY0cVVJT3EzdU91TWdPdWhuQ0RyczdUc29iVHRsWnpyaTZRdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95ZG1DRHNwSVFnN0lpWTY2VzhJT3EzdU91TWdPdWhuQ0RzbktEc3A0RHRsWnpyaTZRZzRvQ1VJT3lia091c3VPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPdXlpT3lYcmV1UGhDRHRsWndnN0tTRTY2R2NMQ0RzcElUcnNKVHF2NGpzbllRZzdKNkU3SjJZNjZHY0lPeTJsT3F3Z08yVm1PeW5nQ0RzbFlycmlwVHJpNlF1SUNjZ0t3b2dJQ0FnSit1THRleWRnQ0Ryc0pqcms1enNpNXdnU2xOUFRpRHFzSjNzc3JRZzdaV1k2NEtZNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9VZzZyaUk3S2VBT2lBbklDc0tJQ0FnSUNkN0luUnlZVzV6YkdGMFpXUWlPaUFpNjdLSTdKZXQ2Nnk0SUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSmthWEpsWTNScGIyNGlPaUFpYTIvaWhwSmxiaURybUpEcmlwUWdaVzdpaHBKcmJ5SjlPaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvZEdWNGRDa0tJQ0FwTENCdGIyUmxiQ2s3Q24wS0NpOHZJT3VNZ08yWmxPMllsU0RyckxqcXRhd2c3S0NjN0o2UklPMkV0Q0RpZ0pRZzdJS3M3SnFwN0o2UTZyQ0FJT3lEZ2UyWnFleWRoQ0RzaEtUcnFvWHRsWmpycWJRZzY2ZWw2NTI5N0plUUlPdW5udXVLbENEcnJManF0YXpycGJ3ZzY2ZU02NU9rN0phMDdLU0E2NHVrTGdvdkx5QnRaWE56WVdkbGN6b2dXM3R5YjJ4bE9pZDFjMlZ5SjN3bllYTnphWE4wWVc1MEp5d2dkR1Y0ZEgxZElPeWdoT3l5dENEcmpJRHRtWlRycGJ3ZzY2ZWs2N0tJSU91d20rdUtsT3VMcENqcmk2VHJwcXpyaXBRZzY2eTA3SU9CN1lPY0lPS0FsQW92THlEc200enJzSTNzbDRVZzdLZUE3SXVjNjZ5NDdKMllJQ0xzbXBUc3NxM3JrNlRzbllBZzdJU2M2NkdjSU91c3RPcTBnQ0lnN0tDRTdLQ2M2Nlc4SU95bmdPMkNwT3E0c0NEc25JVHRsYlFnNjR5QTdabVVJT3VucGV1ZHZleWRoQ0R0aExRZzdKV0k3SmVRSU91cXZldVZoU0RzaTZQcmlwVHJpNlFwTGdwbWRXNWpkR2x2YmlCaGMydERiMjF3YjNObEtHMWxjM05oWjJWekxDQnRiMlJsYkNrZ2V3b2dJSEpsZEhWeWJpQnlkVzVVZFhKdUtDZ3BJRDArSUhzS0lDQWdJR052Ym5OMElIUnlZVzV6WTNKcGNIUWdQU0FvYldWemMyRm5aWE1nZkh3Z1cxMHBMbTFoY0Nnb2JTa2dQVDRLSUNBZ0lDQWdLRzB1Y205c1pTQTlQVDBnSjJGemMybHpkR0Z1ZENjZ1B5QW43SmEwN0l1YzdJcWs3WVMwN1lxNE9pQW5JRG9nSit5Q3JPeWFxZXlla0RvZ0p5a2dLeUJUZEhKcGJtY29iUzUwWlhoMElIeDhJQ2NuS1M1emJHbGpaU2d3TENBeE5UQXdLUW9nSUNBZ0tTNXFiMmx1S0NkY2JpY3BPd29nSUNBZ2NtVjBkWEp1SUNnS0lDQWdJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnSXV1TWdPMlpsTzJZbFNEcnJManF0YXdnN0tDYzdKNlJJdXlkdE91THBDQW82cml3N0tHMElPdXN1T3ExckNEcmk2VHJrNnpxdUxBZzdKV0U2NHVZSU9LQWxDRHNsWVRybnBnZzY0eUE3Wm1VNnJDQUlPeWR0T3V5aUNEdGhMVHNuWmdnN0tDRTdMSzBJT3VucGV1ZHZleWR0T3VMcENrdUlDY2dLd29nSUNBZ0lDQW43SUtzN0pxcDdKNlE2ckNBSU8yWmxPdXB0Q0RzZzRIdG1hbkN0K3VucGV1ZHZleWRoQ0RzaEtUcnFvWHRsWmpycWJRc0lPeUtwTzJEZ095ZHZDRHF0NXpzdVpucXM3d2c3SmlJN0l1Y0lPMkdwT3lYa0NEcnA1N3JpcFFnVlVrZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2NmVsNjUyOTdKMjBJT3VzdU9xMXJPdWx2Q0RzazdEcXVMRHNsNUFnNjdhQTdLR3g3WldZNjZtMEtPeVd0T3VLa0NEdG1aVHJxYlRzbmJqc3A0QXNJT3VzdE95S3FDRHNnNEh0bWFuc25ianNwNEFnNjVPeEtTRHF2SzBnN1pXRTdKcVU3WldjSU9xeWd5QXg2ckNBN0tlQTY2ZU1JT3lucCtxeWpDRHJrSmpyckx6c2xyVHJuYnd1SU95ZHRPdVZqQ0J6ZFdkblpYTjBhVzl1Yyt1S2xDRHJ1WWdnNjdDdzdKZTBMbHh1SnlBckNpQWdJQ0FnSUNjdElPdXN1T3Exck91bHZDRHNvSnpzbFlqdGxhQWc2NVdRSU95RW5PdWhuQ0Rzb0pIcXQ3enNuYlFnNjR1azY2VzRJREorTStxd25DNGc2ckNCSU95Z25PeVZpT3lYbENEc21ad2c2cmU0NjZDSDZyS01JT3lOdk91S2xPeW5nQ0RzbmJUc25LRHJwYndnNjdhWjdKMjQ2NHVrTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lDck95YXFleWVrT3F3Z0NEc2xyanF1SW50bFpqc3A0QWc3SldLN0oyQUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN1pxZjdJaVlJT3VUc1NucnBid2c3S2VBN0phMDY0SzBJT3VFbyt5bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN1p1RTdJYU5JT3lhbE95eXJTZ2k2NDJVSU95bnArcXlqQ0lzSUNMcnNvVHRpcnpzbXFuc25MenJvWndpSU91VHNTbnNuYlRycWJRZzdLZUI3S0NFSU95Z25PeVZpT3lkaENEcXQ3Z2c2N0NwN1phbDdKeTg2NkdjSU9xem9PeXprQ0RyaTZUc2k1d2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZJT3E0aU95bmdEb2dKeUFyQ2lBZ0lDQWdJQ2Q3SW5KbGNHeDVJam9nSXV1TWdPMlpsQ0RzblpIcmk3VWc3WldjNjVHUUlPdXN1T3llcFNBbzdaVzA3SnFVN0xLMEtTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0p5WldGemIyNGlPaUFpN0oyMDdKeWdJTzJWbkNEcnJManNucVVpZlYxOVhHNWNiaWNnS3dvZ0lDQWdJQ0FuVyt1TWdPMlpsRjFjYmljZ0t5QjBjbUZ1YzJOeWFYQjBDaUFnSUNBcE93b2dJSDBzSUcxdlpHVnNLVHNLZlFvS0x5OGc3WXlkN0plRklPeUV1TzJLdUNEc3RwVHNzcHdnN1lTMElPS0FsQ0R0bFp3ZzdZeWQ3SmVGN0oyWUlPcTFyT3lFc2V5YWxPeUdqQ2pzbDYzdGxhQXI2Nnk0NnJXc0tldWx2Q0R0bFp3ZzY3S0k3SmVRSU91enRPdUN0T3F6b0N3S0x5OGc3SnFVN0lhTTY3T0VJT3VDc2Vxd25PcXdnQ0RzbFlUcmk0anJuYndnS2lyc21ZVHNoTEhya0p3ZzdZeWQ3SmVGSU95RXVPMkt1Q2pzdklEc25iVHNpcVFwSURKK00rcXduQ29xNjZXOElPMkd0ZXljdk91aG5DRHJzSnZyaXBUcmk2UXVDaTh2SU8yRGdPeWR0TzJMZ01LMzdKV0k2NEswd3JmcnNvVHRpcnpzbmJRZzdaV2NJT3VxdU95Y3ZPdWhuQ0RzbmJ6cXRJRHJqN3pzbGJ3ZzdaV1k2NitBNjZHY0tPdVVzT3VobkNEcnZaSHNsWVFnN0tHdzdaV3A3WldZNjZtMElPeVd0T3E0aSt1Q25PdUxwQ2tnN0lTNDdZcTRJT3VMcU95Y2hPdWhuQ0Rzb0p6c2xZanRsWmpxc293ZzdaV2M2NHVrTGdvdkx5QmxiR1Z0Wlc1MGN6b2dXM3R5YjJ4bExDQjBaWGgwZlYwZ0tPMlpsT3VwdENEc25JVGlocExzbFlUcm5wZ2c3SWljS1M0S1puVnVZM1JwYjI0Z1lYTnJVRzl3ZFhBb1pXeGxiV1Z1ZEhNc0lHMXZaR1ZzS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ2NtOXNaWE1nUFNBb1pXeGxiV1Z1ZEhNZ2ZId2dXMTBwTG0xaGNDZ29aU2tnUFQ0Z1UzUnlhVzVuS0NobElDWW1JR1V1Y205c1pTa2dmSHdnSnljcEtTNXFiMmx1S0Njc0lDY3BPd29nSUNBZ1kyOXVjM1FnYkdsemRDQTlJQ2hsYkdWdFpXNTBjeUI4ZkNCYlhTa3ViV0Z3S0NobExDQnBLU0E5UGdvZ0lDQWdJQ0FvYVNBcklERXBJQ3NnSnk0Z1d5Y2dLeUJUZEhKcGJtY29LR1VnSmlZZ1pTNXliMnhsS1NCOGZDQW5KeWtnS3lBblhTQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29VM1J5YVc1bktDaGxJQ1ltSUdVdWRHVjRkQ2tnZkh3Z0p5Y3BLUW9nSUNBZ0tTNXFiMmx1S0NkY2JpY3BPd29nSUNBZ2NtVjBkWEp1SUNnS0lDQWdJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnSXUyTW5leVhoU2pyaTZUc25iVHNscnpyb1p6cXQ3Z3BJT3lFdU8yS3VDRHJpNlRyazZ6cXVMQWk2NHVrTGlEc2xZVHJucGpyaXBRZzdaV2NJTzJNbmV5WGhleWRoQ0RzbklUaWhwTHNsWVRybnBqcm9ad2c2NEtZN0plMDdaV2NJT3Exck95RXNleWFsT3lHak91VHBPeWR0T3VMcENqc2hKenJvWndnNjZ5MDZyU0E3WldjSU91emhPcXduQ0RyckxqcXRhenFzSUFnN0pXRTY0dUk2NHVrS1M0Z0p5QXJDaUFnSUNBZ0lDZnNtcFRzaG96cnBid2c2NEt4NnJDYzY2R2NJT3F6b095NW1PeW5nQ0RycDVEcXM2QXNJQ29xN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2T3lkdENEc2hKenJvWndnN0oyODZyU0E2NUNjSUNMc21ZVHNoTEhya0p3ZzdZeWQ3SmVGSU95RXVPMkt1Q0lnTW40ejZyQ2NLaXJycGJ3ZzdLQ2M3SldJN1pXWTY1MjhMaURxc0lFZzdJUzQ3WXE0NjRxVUlPeUVuT3VobkNEcmk2VHJwYmdnN0tDUjZyZTg3SjIwN0phMDdKVzhJTzJWbk91THBDNWNiaWNnS3dvZ0lDQWdJQ0FuNnJDQklPeUV1TzJLdU91S2xDRHNub1hyb0tYcXM3d2dLaXJxc0puc25ZQWc3SmV0N1pXZ3dyZnFzSm5zbllBZzZyQ2M3SWlZd3JmcXNKbnNuWUFnN0lpYzdJU2NLaXJzblpnZzdKcVU3SWFNNjZXOElPdXFxT3VSa0NEdGo2enRsYWp0bFp6cmk2UXVJT3lFdU8yS3VDRHNsWWpzbDVEc2hKd2c3WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZPeWRnQ0R0bFp3ZzY2cTQ3Snk4NjZHY0lPdW5udXlWaE91V3FPeVd0T3lndU95VnZDRHRsWnpyaTZRbzdKaUlPaURyczdqcnJManNuYlFnSW43dGxhRHF1WXpzbXBRL0l1dXB0Q0Ryc29UdGlyenNuWUFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBwTGx4dUp5QXJDaUFnSUNBZ0lDZGI3WXlkN0plRklPdXN1T3l5dENEcXQ1enN1WmtnNG9DVUlPeWNoQ0RzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jN0oyWUlDSTRMaUR0akozc2w0VWlJT3lFdWV5Rm1PeWRoQ0RybExEcnBianJpNlJkWEc0bklDc0tJQ0FnSUNBZ0p5MGc3WU9BN0oyMDdZdUFPaURzcDZmc25ZQWc2NnFGN0lLczZyV3NLREorTk95V3RPeWdpQ2tzSU95aWhlcXlzT3lXdE91dnVNSzM2NmVJN0xtbzdaR2NJT3lYaHV5ZHRDaCs3SnFVTDM3cmk2UXZmdXE1ak95YWxEOGc2cmlJN0tlQUtTNGc2N0NZNjVPYzdJdWNJT3lWaU91Q3RDanJzN2pyckxncElPdW5wZXVkdmV5ZGhDRHNtcFRzbGIzdGxiUWc3WU9BN0oyMDdZdUE2NmVNSU91MGtPdVBoQ0RyckxUc2lxZ2c3WXlkN0plRjdKMjQ3S2VBSU95VmpPcXlqQ0R0bFpqcm5id3VJT3lia091enVPeWR0Q0FpN0pXTTY2YThMKzJabGV5ZHVDTHNzcGpybjd3ZzY2ZUo3SmV3N1pXWTY2bTBJT3V6dU91c3VPeWRoQ0RxdDd6cXNiRHJvWndnNnJXczdMSzA3Wm1VN1pXWTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPeVZpT3VDdENqcnM3anJyTGdwT2lEdGxiVHNtcFRzc3JRdUlPMk1rT3VMcU95ZHRDRHRsWVRzbXBUdGxaanJxYlFnSW43dGxhRHF1WXpzbXBRL0l1dWhuQ0Ryckx2cXM2QXNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc2NHFVSU95Y2hPMlhtQ2pzZ3Ezc29KekN0KzJEaU8ySHRDRHJrN0VwN0oyQUlPcXlzT3F6dk91bHZDRHJxTHpzb0lBZzZySzk2ck9nN1pXYzY0dWtMaURxc3JEcXM3ekN0K3lEZ2UyRG5DRHRoclhyczdUcnFiUWc3SVNjN0lpZzdaaVY3Snk4NjZHY0lPeVZqT3Vtc091THBDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcnNvVHRpcnc2SU91enVPdXN1T3lkdENBaWZ1MlZvT3E1ak95YWxEOGk2Nm0wSUZ2c2xZVHJpNGpzbUtSZEwxdnJoS1JkTENEcnM3anJyTGpzbmJRZzdJT0I3Wm1wN0oyRUlPeUVuT3lJb08yVm1PcXpvQ0RzbmJRZzY3S0U3WXE4N0oyMElPeUxwT3lnbkNEcmo1bnNucEhzbmJUcnFiUWc2NCtaN0o2UklPdVBtZXlDckNqc2dxM3NvSnd2N0tDQTdKNmxMK3lYc09xeXNDRHRsYlRzb0p3ZzY1T3hLU3dnN1lhMTY3TzBJTzJNbmV5WGhleWRtQ0RyaTZqc25id2c2N0tFN1lxODdKMjA2Nm0wSUNMdG1aWHNuYmdpTGlBaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenJwNHdzSUNMcmk2dnF1TERDdCt1UG1leWVrU0lnN0tHdzdaV3BJT3E0aU95bmdDNGc3Wm1VNjZtMElPcTRzT3VLcGV1cWhTanJzNERxc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bklDc0tJQ0FnSUNBZ0p5MGc3SnVRNjZ5NDdKMllJT3lnbGV1enRNSzM3S0d3NnJHMEtPeUlxK3lla01LMzdKMjA3SU9CTCt5ZHRPMlZtTUszNjR5QTdJT0JLZXlkZ0NEc25LRHNwNER0bFpqcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZ3cmZzdlpUcms1enRqcHpzaXFRZzZyaUk3S2VBT2x4dUp5QXJDaUFnSUNBZ0lDZDdJbk5sZEhNaU9pQmJleUp5WldGemIyNGlPaUFpN0oyMElPeUV1TzJLdU95ZG1DRHJzS250bHFYc25ZUWc3WldjNnJXdDdKYTBJTzJWbkNEcnJManNucVhzbkx6cm9ad2lMQ0FpWld4bGJXVnVkSE1pT2lCYmV5SnliMnhsSWpvZ0l1eVhyZTJWb0NJc0lDSjBaWGgwSWpvZ0l1dXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraWZTd2dMaTR1WFgwc0lDNHVMbDE5WEc0bklDc0tJQ0FnSUNBZ0oreVhyZTJWb095ZGdDRHNub1hyb0tVZzdJaWM3SVNjNjR5QTY2R2NPaUFuSUNzZ2NtOXNaWE1nS3lBblhHNWNiaWNnS3dvZ0lDQWdJQ0FuVysyTW5leVhoU0RzbXBUc2hveGRYRzRuSUNzZ2JHbHpkQW9nSUNBZ0tUc0tJQ0I5TENCdGIyUmxiQ2s3Q24wS0NpOHZJTzJNbmV5WGhTRHNuWkhyaTdYc2w1RHNoSndnZTNObGRITTZJRnQ3Y21WaGMyOXVMQ0JsYkdWdFpXNTBjenBiZTNKdmJHVXNkR1Y0ZEgxZGZWMTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa0tablZ1WTNScGIyNGdjR0Z5YzJWUWIzQjFjQ2h5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYSHRiWEhOY1UxMHFYSDB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93b2dJQ0FnWTI5dWMzUWdjMlYwYzBsdUlEMGdRWEp5WVhrdWFYTkJjbkpoZVNodklDWW1JRzh1YzJWMGN5a2dQeUJ2TG5ObGRITWdPaUJiWFRzS0lDQWdJR052Ym5OMElITmxkSE1nUFNCelpYUnpTVzRLSUNBZ0lDQWdMbTFoY0Nnb2MzUXBJRDArSUNoN0NpQWdJQ0FnSUNBZ2NtVmhjMjl1T2lCVGRISnBibWNvS0hOMElDWW1JSE4wTG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTd0tJQ0FnSUNBZ0lDQmxiR1Z0Wlc1MGN6b2dRWEp5WVhrdWFYTkJjbkpoZVNoemRDQW1KaUJ6ZEM1bGJHVnRaVzUwY3lrS0lDQWdJQ0FnSUNBZ0lEOGdjM1F1Wld4bGJXVnVkSE1LSUNBZ0lDQWdJQ0FnSUNBZ0lDQXViV0Z3S0NobGJDa2dQVDRnS0hzZ2NtOXNaVG9nVTNSeWFXNW5LQ2hsYkNBbUppQmxiQzV5YjJ4bEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCMFpYaDBPaUJUZEhKcGJtY29LR1ZzSUNZbUlHVnNMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcENpQWdJQ0FnSUNBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvWld3cElEMCtJR1ZzTG5SbGVIUXBDaUFnSUNBZ0lDQWdJQ0E2SUZ0ZExBb2dJQ0FnSUNCOUtTa0tJQ0FnSUNBZ0xtWnBiSFJsY2lnb2MzUXBJRDArSUhOMExtVnNaVzFsYm5SekxteGxibWQwYUNrN0NpQWdJQ0J5WlhSMWNtNGdjMlYwY3k1c1pXNW5kR2dnUHlCelpYUnpJRG9nYm5Wc2JEc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V3b2dJQ0FnY21WMGRYSnVJRzUxYkd3N0NpQWdmUXA5Q2dvdkx5RHJqSUR0bVpUdG1KVWc3S0NjN0o2UklPeWRrZXVMdGV5WGtPeUVuQ0I3Y21Wd2JIa3NJSE4xWjJkbGMzUnBiMjV6VzExOUlPeTJsT3kybkNBbzdMMlU2NU9jN1k2YzdJcWt3cmZzbFo3cmtxUWc3SjZoNjR1MElPMlhpT3lhcVNrS1puVnVZM1JwYjI0Z2NHRnljMlZEYjIxd2IzTmxLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQnlaWEJzZVNBOUlGTjBjbWx1Wnlnb2J5QW1KaUJ2TG5KbGNHeDVLU0I4ZkNBbkp5a3VkSEpwYlNncE93b2dJQ0FnWTI5dWMzUWdjM1ZuWjJWemRHbHZibk1nUFNCQmNuSmhlUzVwYzBGeWNtRjVLRzhnSmlZZ2J5NXpkV2RuWlhOMGFXOXVjeWtLSUNBZ0lDQWdQeUJ2TG5OMVoyZGxjM1JwYjI1ekNpQWdJQ0FnSUNBZ0lDQXViV0Z3S0NoNEtTQTlQaUFvZXlCMFpYaDBPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNTBaWGgwS1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQ0J5WldGemIyNDZJRk4wY21sdVp5Z29lQ0FtSmlCNExuSmxZWE52YmlrZ2ZId2dKeWNwTG5SeWFXMG9LU0I5S1NrS0lDQWdJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tIZ3BJRDArSUhndWRHVjRkQ2tLSUNBZ0lDQWdPaUJiWFRzS0lDQWdJR2xtSUNoeVpYQnNlU0I4ZkNCemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElISmxkSFZ5YmlCN0lISmxjR3g1TENCemRXZG5aWE4wYVc5dWN5QjlPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95VmhPdWVtT3VobkNBcUx5QjlDaUFnY21WMGRYSnVJRzUxYkd3N0NuMEtDaTh2SU91eWlPeVhyU0RzblpIcmk3WHNsNURzaEp3Z2UzUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZibjBnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpWUnlZVzV6YkdGMFpTaHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdZMjl1YzNRZ2RISmhibk5zWVhSbFpDQTlJRk4wY21sdVp5Z29ieUFtSmlCdkxuUnlZVzV6YkdGMFpXUXBJSHg4SUNjbktTNTBjbWx0S0NrN0NpQWdJQ0JwWmlBb2RISmhibk5zWVhSbFpDa2djbVYwZFhKdUlIc2dkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1T2lCVGRISnBibWNvS0c4Z0ppWWdieTVrYVhKbFkzUnBiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmVHNLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc2xZVHJucGpyb1p3Z0tpOGdmUW9nSUhKbGRIVnliaUJ1ZFd4c093cDlDZ292THlEc25aSHJpN1hzbDVEc2hKd2dlM1JsZUhRc0lISmxZWE52Ym4wZzY3Q3c3SmUwSU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlRkV2RuWlhOMGFXOXVjeWh5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYRnRiWEhOY1UxMHFYRjB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHRnljaUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCcFppQW9RWEp5WVhrdWFYTkJjbkpoZVNoaGNuSXBLU0I3Q2lBZ0lDQWdJSEpsZEhWeWJpQmhjbklLSUNBZ0lDQWdJQ0F1YldGd0tDaDRLU0E5UGlBb2V5QjBaWGgwT2lCVGRISnBibWNvS0hnZ0ppWWdlQzUwWlhoMEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCeVpXRnpiMjQ2SUZOMGNtbHVaeWdvZUNBbUppQjRMbkpsWVhOdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa0tJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaDRLU0E5UGlCNExuUmxlSFFwT3dvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95VmhPdWVtT3VobkNBcUx5QjlDaUFnY21WMGRYSnVJRnRkT3dwOUNnb3ZMeURyb1p6cXQ3anNuYmdnN1pXRTdKcVVJT3lEZ2UyRG5PeWR2Q0RybFl3Z0wyaGxZV3gwYUNEc29iRHRtb3pxc0lBZzdKaWs2Nm0wSU91U3BPeVhrT3lFbkNEc200enJzSTNzbDRYc25ZUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRPdXp1T3VMcENBb016RHN0SWpzbDVBZ01ldXlpT3VuakNrdUNpOHZJT3lFc2VxenRlMlZtT3VwdENEcXNyRHFzN3dnN1pXNDY1T2s2NStzNnJDQUlHTnNZWFZrWlZOMFlYUjFjejBuYjJzbjY2R2NJT3VRbU91UGpPdW1yT3V2Z091aG5Dd2c3SjZzNjZHYzZyZTQ3SjI0SU8yYmhDRHJzb1R0aXJ6c25iUWc3S0NBN0tDSTY2R2NJUENmbjZMc25MenJvWndnNjdPMTZyZUE3WldjNjR1a0xnb3ZMeUFvN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc3SmV3SU91U3BDRHNvN3pxdUxEc29JSHNuTHpyb1p3Z0wyaGxZV3gwYU91bHZDRHNvYkR0bW96dGxaanJpcFFnNnJLRDZyTzhJT3lubmV5ZGhDRHNuYlRybzZ6cmk2UXBDbXhsZENCc1lYTjBRWFYwYUZKbGRISjVRWFFnUFNBd093cG1kVzVqZEdsdmJpQnlaWFJ5ZVVGMWRHaEpaazVsWldSbFpDZ3BJSHNLSUNCcFppQW9ZMnhoZFdSbFUzUmhkSFZ6SUNFOVBTQW5ZMnhoZFdSbExXeHZaMjkxZENjcElISmxkSFZ5YmpzS0lDQnBaaUFvZDJGcGRHVnlJSHg4SUVSaGRHVXVibTkzS0NrZ0xTQnNZWE4wUVhWMGFGSmxkSEo1UVhRZ1BDQXpNREF3TUNrZ2NtVjBkWEp1T3lBdkx5RHNwNFR0bG9rZzdLU1JJTzJFdENEcnNLbnRsYlFnNnJpSTdLZUFJQ3NnTXpEc3RJZ2c2ckNFNnJLcENpQWdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJT3llck8yWmxleWR1Q0RzaTV6cmo0VGlnS1luS1RzS0lDQnlkVzVVZFhKdUtDZ3BJRDArSUNmcm9aenF0N2pzbmJnZzdabVY3SjI0N0pxcDdKMjA2NHVrTGlBaVQwc2k2NTI4NnJPZzY2ZU1JT3VMdGUyVm1PdWR2QzRuS1M1MGFHVnVLQW9nSUNBZ0tDa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHRtWlhzbmJqcmtLZ2c0b0NVSU95Z2xleURnU0RzZzRIdGc1enJvWndnNjdPMTZyZUFMaWNwTEFvZ0lDQWdLR1VwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbFlUc3A0RWc2NkdjNnJlNDdKMjRJT3lWaUNEcmtLZzZKeXdnVTNSeWFXNW5LR1V1YldWemMyRm5aU2t1YzJ4cFkyVW9NQ3dnT0RBcEtRb2dJQ2s3Q24wS0NpOHZJT3lMcE8yTXFDRHNuWkhyaTdYc25ZUWc3SUtzNjU2TTdKcXBJT3lWaU91Q3RPdWhuQ0RyczREdG1aZ2c0b0NVSU95YmtPeWR1Q2pyb1p6cXQ3anNuYmd2N0lTazdMbVlLZXlkdENEdGpJenNsWVhya0p3ZzZySzk3SnF3N0plVUlPcTN1Q0RzbFlqcmdyVHJwYndzSU95VmhPdUxpT3VwdENEc29KSHJrWkRzbHJRcjdKdVE2Nnk0N0oyRUlPdXp0T3VDdU91THBBcG1kVzVqZEdsdmJpQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lIQnlaV1pwZUNrZ2V3b2dJR2xtSUNobElDWW1JR1V1YldWemMyRm5aU0E5UFQwZ1RFOUhTVTVmUjFWSlJFVXBJSEpsZEhWeWJpQjdJR1Z5Y205eU9pQk1UMGRKVGw5SFZVbEVSU3dnY0hKdllteGxiVG9nSjJOc1lYVmtaUzFzYjJkdmRYUW5JSDA3Q2lBZ2FXWWdLR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdKMk5zWVhWa1pTMXRhWE56YVc1bkp5a2dld29nSUNBZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUNmc25iUWdVRVBzbDVBZ1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbEtlcXdnQ0RzaEtUc3VaanJqN3dnN0o2STdLZUFJT3lWaXV5VmhPeWFsQ0RpZ0pRZzdJU2s3TG1ZN1pXWTZyT2dJT3Vobk9xM3VPeWR1TzJWbkNEcmtxUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeXdnY0hKdllteGxiVG9nSjJOc1lYVmtaUzF0YVhOemFXNW5KeUI5T3dvZ0lIMEtJQ0J5WlhSMWNtNGdleUJsY25KdmNqb2djSEpsWm1sNElDc2dLR1VnSmlZZ1pTNXRaWE56WVdkbElEOGdaUzV0WlhOellXZGxJRG9nVTNSeWFXNW5LR1VwS1NCOU93cDlDZ3BtZFc1amRHbHZiaUJ5WldGa1FtOWtlU2h5WlhFcElIc0tJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVVwSUQwK0lIc0tJQ0FnSUd4bGRDQmliMlI1SUQwZ0p5YzdDaUFnSUNCeVpYRXViMjRvSjJSaGRHRW5MQ0FvWXlrZ1BUNGdleUJpYjJSNUlDczlJR003SUgwcE93b2dJQ0FnY21WeExtOXVLQ2RsYm1RbkxDQW9LU0E5UGlCN0NpQWdJQ0FnSUhSeWVTQjdJSEpsYzI5c2RtVW9TbE5QVGk1d1lYSnpaU2hpYjJSNUtTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lISmxjMjlzZG1Vb2UzMHBPeUI5Q2lBZ0lDQjlLVHNLSUNCOUtUc0tmUW9LWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3b2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxUGNtbG5hVzRuT2lBbktpY3NDaUFnSjBGalkyVnpjeTFEYjI1MGNtOXNMVUZzYkc5M0xVMWxkR2h2WkhNbk9pQW5SMFZVTENCUVQxTlVMQ0JQVUZSSlQwNVRKeXdLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RTR1ZoWkdWeWN5YzZJQ2REYjI1MFpXNTBMVlI1Y0dVbkxBcDlPd3BtZFc1amRHbHZiaUJxYzI5dUtISmxjeXdnYzNSaGRIVnpMQ0J2WW1vcElIc0tJQ0J5WlhNdWQzSnBkR1ZJWldGa0tITjBZWFIxY3l3Z1QySnFaV04wTG1GemMybG5iaWg3SUNkRGIyNTBaVzUwTFZSNWNHVW5PaUFuWVhCd2JHbGpZWFJwYjI0dmFuTnZianNnWTJoaGNuTmxkRDExZEdZdE9DY2dmU3dnUTA5U1UxOUlSVUZFUlZKVEtTazdDaUFnY21WekxtVnVaQ2hLVTA5T0xuTjBjbWx1WjJsbWVTaHZZbW9wS1RzS2ZRb0tZMjl1YzNRZ2MyVnlkbVZ5SUQwZ2FIUjBjQzVqY21WaGRHVlRaWEoyWlhJb1lYTjVibU1nS0hKbGNTd2djbVZ6S1NBOVBpQjdDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUFVGUkpUMDVUSnlrZ2V5QnlaWE11ZDNKcGRHVklaV0ZrS0RJd05Dd2dRMDlTVTE5SVJVRkVSVkpUS1RzZ2NtVjBkWEp1SUhKbGN5NWxibVFvS1RzZ2ZRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuUjBWVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyaGxZV3gwYUNjcElIc0tJQ0FnSUhKbGRISjVRWFYwYUVsbVRtVmxaR1ZrS0NrN0lDOHZJT3Vobk9xM3VPeWR1Q0R0bFlUc21wUWc3SU9CN1lPYzY2bTBJT3llck8yWmxleWR1Q0RzaTV6cmo0UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVPeWR0Q0RyZ1ozcmdxenNuTHpycWJRZzY0dWs3SjJNSU95aHNPMmFqT3UyZ08yRXNDQndjbTlpYkdWdDdKMjBJTzJTZ091bXNPdUxwQW9nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNLSUNBZ0lDQWdiMnM2SUhSeWRXVXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY3NJSFk2SUVKU1NVUkhSVjlXTENCa2FYSTZJRjlmWkdseWJtRnRaU3dnTHk4Z2RzSzNaR2x5T2lEcXRhenJzb1Rzb0lRdjdKZUo2NXF4N1pXY0lPeUNyT3V6dU95ZHRDRHJscUFnN0o2STY0cVU3S2VBSU95bmhPdUxxT3lhcVFvZ0lDQWdJQ0J0YjJSbGJEb2dZM1Z5Y21WdWRFMXZaR1ZzTENCdGIyUmxiSE02SUVGTVRFOVhSVVJmVFU5RVJVeFRMQ0JsZUdGdGNHeGxjem9nUlZoQlRWQk1SVk11YkdWdVozUm9MQ0JuZFdsa1pUb2dSMVZKUkVVdWJHVnVaM1JvTENCeVpXRmtlVG9nZDJGeWJXVmtWWEFzQ2lBZ0lDQWdJSEJ5YjJKc1pXMDZJQ2hqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJQ2R2YXljZ2ZId2dZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQnVkV3hzS1NBL0lHNTFiR3dnT2lCamJHRjFaR1ZUZEdGMGRYTXNDaUFnSUNBZ0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3S0lDQWdJQ0FnYzJWeWRtVmtPaUJ6ZEdGMGN5NXpaWEoyWldRc0lHeGhjM1JCZERvZ2MzUmhkSE11YkdGemRFRjBMQ0JzWVhOMFZHVjRkRG9nYzNSaGRITXViR0Z6ZEZSbGVIUXNJR3hoYzNSVFpXTTZJSE4wWVhSekxteGhjM1JUWldNc0NpQWdJQ0I5S1RzS0lDQjlDaUFnTHk4ZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEaWdKUWc2NEdLNnJpdzY2bTBJT3ljaENEcXNKRHNpNXdnN1lPQTdKMjA2Nmk0NnJDQUlPdUxwT3Vtck91bHZDRHJnWWpyaTZRS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmFHVmhjblJpWldGMEp5a2dld29nSUNBZ2JHRnpkRUpsWVhRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0NpQWdmUW9nSUM4dklPdWhuT3EzdU95ZHVDRGlnSlFnN1pTTTY1K3M2cmU0N0oyNDdKMllJRnZ3bjUrZ0lPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c3WldFN0pxVVhjSzNXL0NmbEpGZElPdXloTzJLdk95ZHRDRHRtTGpzdHB6dGxaenJpNlF1Q2lBZ0x5OGc2cml3NjdPNEtPdTRqT3Vkdk95YXNPeWdnQ0RzcDRIdGxva3BPaUJnWTJ4aGRXUmxJR0YxZEdnZ2JHOW5hVzRnTFMxamJHRjFaR1ZoYVdEcnBid2c3SWlvN0oyQUlPMlVoT3Vobk95RXVPeUtwT3VobkNEc2k2VHRsb2tnNG9DVUlPdXBsT3VKdENEc2w0YnNuYlFnNnJPbjdKNmxJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RxczZBc0NpQWdMeThnSUNCc2IyTmhiR2h2YzNRZzdJaVk3SXVnSU8yUHJPMkt1T3VobkNEcXNyRHFzN3pycGJ3ZzdKNlE2NCtaSU95SW1PdWd1ZTJWbk91THBDanNpNlRzdUtFNklPMlhwT3VUbk91bXJPeUtwT3lYa095RW5PdVBoQ0RydUl6cm5ienNtckRzb0lBZzdKZTA2NmE4SUNzZ1RFbFRWRVZPSU8yWmxleWR1Q3dnTWpBeU5pMHdOeWt1Q2lBZ0x5OGdJQ0R0aExEcnI3anJoSkRzbmJRZzdabVU2Nm0wN0plUUlPeWdoTzJZZ0NEc2xZZ2c2NXlzNjR1a0xpRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0NjZlTUlPMlZtT3VwdENEcmdaMHVDaUFnTHk4ZzdZKzA2N0N4S08yRXNPdXZ1T3VFa0NrNklPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzY2ZUo3WjZNSU8yWm1PcXl2U2pydUl6cm5ienNtckRzb0lEcXNJQWdiRzlqWVd4b2IzTjA3SmVRSU91cXV5RHJpNy9zbFlRZzdMMlU2NU9jNnJDQUlPdXp0T3lkdE91S2xDRHFzcjNzbXJBcDdKZVE3SVNjQ2lBZ0x5OGdJQ0Ryb1p6cXQ3anNuYmdnNjR5QTZyaXdJT3lra1NEcnNvVHRpcnpzbllRZzY1aVFJT3VJaE91bHRPdXB0Q3dnN0wyVTY1T2M2Nlc4SU91Mm1leVhyT3VFbyt5ZGhDRHNpSmdnN0o2STY0cVVJTzJFc091dnVPdUVrQ0Ryc0tuc2k1M3NuTHpyb1p3ZzdLQ0U3Wm1ZN1pXYzY0dWtMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl2Y0dWdUxXeHZaMmx1SnlrZ2V3b2dJQ0FnWTI5dWMzUWdZbTlrZVNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdDaUFnSUNCamIyNXpkQ0J6ZDJsMFkyaE5iMlJsSUQwZ0lTRW9ZbTlrZVNBbUppQmliMlI1TG5OM2FYUmphRUZqWTI5MWJuUXBPeUF2THlEcXM0VHNvSlVnN0tDRTdabVlJRDBnN0l1YzdZR3M2NmEvSU95d3ZleWN2T3VobkNEc2w3VHNsclFnNnJPRTdLQ1Y3SjJFSU9xem9PdWx2Q0RzaUpnZzdKNkk2cktNQ2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0F2THlCamJHRjFaR1hxc0lBZzdKZUc3Snk4NjZtMElPeVhyT3E0c095RW5DRHJnWXJyaXBUcmk2UXVJSE5vWld4c09uUnlkV1hybmJ3Z1kyeGhkV1JsNnJDQUlPeVhodXlXdE91UGhDRHNoYmpzbllBZzdLQ1Y3SU9CSU95THBPMldpZXVQdkFvZ0lDQWdJQ0F2THlCemNHRjNidXlkbUNBblpYSnliM0luNnJDQUlPeVZpQ0RybktqcXM2QXNJT3lZaU95Z2hPeVhsQ0RxdDdqcmpJRHJvWndnYjJzNmRISjFaZXVsdkNEcmo0enJvS1RzcEt6cmk2UWc0b0NVQ2lBZ0lDQWdJQzh2SU8yVWpPdWZyT3EzdU95ZHVPeWRnQ0FpNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lYdE95WGlPeVd0T3lhbENMcm5ienFzNkFnN1pXWTY0cVU2NDJ3SU95THBPeWduT3Vobk91S2xDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPdWNxT3VLbENEc2c0SHRnNXpxc0lBZzY1Q1E2NHVrS095THBPeWduQ0RzaTZEcXM2QXBMZ29nSUNBZ0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25LU0I3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURFc0lIc0tJQ0FnSUNBZ0lDQWdJR1Z5Y205eU9pQW43SjIwSUZCRDdKZVFJRU5zWVhWa1pTQkRiMlJsNnJDQUlPeVhodXlXdE95YWxDRGlnSlFnN1lTdzY2KzQ2NFNRN0plUTdJU2NJR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3SjIwSU91UW1PdUtsT3luZ0NEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxpY3NDaUFnSUNBZ0lDQWdJQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25MQW9nSUNBZ0lDQWdJSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJQzh2SU95bmhPMldpU0RzcEpIc25ianJqYkFnNjVpUUlPdUlqT3VnZ091THBDRGlnSlFnNnJpSTY3Q3BLRFl3N0xTSUlPdUN0Q2tnNjR1azdJdWNJT3VJaE91bHVDRHFzYlFnSXV5d3ZleWRoQ0RyaTZ2c2xaanJpNlF2NjZxN0lPdTBwT3VMcENMc2w1QWc2ckNBNnJtTTdKcXc2NitBNjZHY0lPdTRqT3Vkdk95YXNPeWdnT3VobkNEc25xenNpNXpyajRUdGxaenJpNlF1Q2lBZ0lDQWdJQzh2SU8yVm5PeXd1Q0Rya3FUc2w1RHJqNFFnNjVpUUlPdUloT3VsdE91S2xDRHFzYlFnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJR3h2WTJGc2FHOXpkQ0Rzdlp6cnNMSHNsNUFnNjZxN0lPdUx2K3lWaENEc25wRHJqNWtnN0ptRTY2T002ckNBSU95VmlDRHJrSmpyaXBRZzdabVk2cks5N0oyOElPeUltQ0Rzbm9qc25MenJpNGdLSUNBZ0lDQWdMeThnNnJlNDY1V002NmVNSU95OWxPdVRuT3VsdkNEcnRwbnNsNnpyaEtQc25ZUWc3SWlZSU95ZWlPdUtsQ0R0aExEcnI3anJoSkFnNjdDcDdJdWQ3Snk4NjZHY0lPMlB0T3V3c2UyVm5PdUxwQ0FvNjVHUUlPdXlpT3ludUNEdGdiVHJwcTNzbDVBZzdZU3c2Nis0NjRTUTdKMjBJTzJLZ095V3RPdUNtT3lZcE91cHRDRHJpN250bWFuc2lxVHJuNzNyaTZRcExnb2dJQ0FnSUNCamIyNXpkQ0J6ZEdGc1pTQTlJR3h2WjJsdVVISnZZeUFtSmlBb1JHRjBaUzV1YjNjb0tTQXRJR3h2WjJsdVUzUmhjblJsWkVGMElENGdOakF3TURBcE93b2dJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpJQ1ltSUhOMFlXeGxLU0I3Q2lBZ0lDQWdJQ0FnYTJsc2JFeHZaMmx1VUhKdll5Z3BPd29nSUNBZ0lDQWdJR2xtSUNnaGIzQmxia3h2WjJsdVZHVnliV2x1WVd3b0tTa2dld29nSUNBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURFc0lIc2daWEp5YjNJNklDZnNuYlFnVDFQc2w1RHNoS0FnN0o2UTY0K1o3Snk4NjZHY0lPdXF1eURzbDdUc2xyVHNtcFFnNG9DVUlPMkVzT3V2dU91RWtPeVhrT3lFbkNCamJHRjFaR1VnN0l1azdaYUpJTzJiaENBdmJHOW5hVzRnN1pXMElPeWp2T3lFdU95YWxDNG5JSDBwT3dvZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEdGo3VHJzTEVnNG9DVUlPMkVzT3V2dU91RWtDRHJzS25zaTUzc25MenJvWndnN0tDRTdabVlMaWNwT3dvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQW5kR1Z5YldsdVlXd25JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc2dMeThnN0pXZTdJU2dJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqc25iUWc2NHlBNnJpd0lPeWtrZXlkdE91cHRDRHNvSkhxczZBZzdJT0k2NkdjSU95WHNPdUxwQ0FvN0xDOTdKMkVJT3VMcSt5Vm1PcXhzT3VDbUNEcmk2VHNpNXdnNjRpRTY2VzRJT3F5dmV5YXNDa0tJQ0FnSUNBZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNBdkx5QkNVazlYVTBWUzY2VzhJT3lhc091bXJDRHRsYmpyazZUcm42enJvWndnN0tlQTdLQ1ZJT0tBbENCRFRFbnFzSUFnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN1RzcDRBZzdKV0s2ck9nSUZWU1RPdW5qQ0RyaEpqcXNxanNwSURyaTZRdUNpQWdJQ0FnSUM4dklPMlZ1T3VUcE91ZnJPcXdnQ0RzaTZUdGpLanRsWmpxc2JEcmdwZ2dRMHhKNnJDQUlFSlNUMWRUUlZMcnBid2c2NnkwN0l1YzdaVzA2NCtFSUVOTVNlcXdnQ0RzbFl6c2xZVHNoSndnNnJpdzY3TzRJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RycjREcm9ad2c2NkdjNnJlNDdKMjQ3SjJBSU91UW5PdUxwQ2htWVdsc0xYTnZablFwTGdvZ0lDQWdJQ0JqYjI1emRDQnNiMmRwYmtWdWRpQTlJRTlpYW1WamRDNWhjM05wWjI0b2UzMHNJRU5NUVZWRVJWOUZUbFlzSUhzZ1FsSlBWMU5GVWpvZ2QzSnBkR1ZDY205M2MyVnlTR0Z1Wkd4bGNpaHpkMmwwWTJoTmIyUmxJRDhnSjNOM2FYUmphQ2NnT2lBbmJtOXliV0ZzSnlrZ2ZTazdDaUFnSUNBZ0lHTnZibk4wSUhSb2FYTk1iMmRwYmlBOUlITndZWGR1S0NkamJHRjFaR1VuTENCYkoyRjFkR2duTENBbmJHOW5hVzRuTENBbkxTMWpiR0YxWkdWaGFTZGRMQ0I3Q2lBZ0lDQWdJQ0FnYzJobGJHdzZJSFJ5ZFdVc0lHVnVkam9nYkc5bmFXNUZibllzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzQ2lBZ0lDQWdJQ0FnWkdWMFlXTm9aV1E2SUhCeWIyTmxjM011Y0d4aGRHWnZjbTBnSVQwOUlDZDNhVzR6TWljc0lDOHZJR3RwYkd4TWIyZHBibEJ5YjJQc25aZ2c2cmU0NjZPNUlHdHBiR3pzbXFrZ0tHdHBiR3hRY205ajZyTzhJT3VQbWV5ZHZDRHRqS2p0aExRcENpQWdJQ0FnSUgwcE93b2dJQ0FnSUNCc2IyZHBibEJ5YjJNZ1BTQjBhR2x6VEc5bmFXNDdDaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR2xtSUNoc2IyZHBibEJ5YjJNZ1BUMDlJSFJvYVhOTWIyZHBiaWtnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNnZlNrN0NpQWdJQ0FnSUhSb2FYTk1iMmRwYmk1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGdld29nSUNBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJNZ0lUMDlJSFJvYVhOTWIyZHBiaWtnY21WMGRYSnVPd29nSUNBZ0lDQWdJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdDaUFnSUNBZ0lDQWdhV1lnS0d4dloybHVVSEp2WTFScGJXVnlLU0I3SUdOc1pXRnlWR2x0Wlc5MWRDaHNiMmRwYmxCeWIyTlVhVzFsY2lrN0lHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2JuVnNiRHNnZlFvZ0lDQWdJQ0FnSUdGalkyOTFiblJEWVdOb1pTNWhkQ0E5SURBN0lDOHZJT3lEaUNEcXM0VHNvSlhzbmJ3ZzdJaVlJT3llaU95Y3ZPdUxpQ0RyaTZUc25Zd2dMMmhsWVd4MGFDRHJsWXdnNjR1azdJdWNJT3lkdmVxNHNBb2dJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeWdpT3l3cUNEc29vWHJvNHdnS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93b2dJQ0FnSUNBZ0lDOHZJT3lDck91ZWpPeWR0Q0Ryb1p6cXQ3anNuYmp0bGFBZzdJdWM2ckNFNjQrRUlPeVhodXlkdENEcXM2ZnJzSlRyb1p3ZzdJdWs3WXlvNjZHY0lPdUJuZXVDck91THBDQTlJR05zWVhWa1plcXdnQ0RzbDRicXNiRHJncGdnN0l1azdaYUo3SjIwSU95VmlDRHJrSndnNnJLRExnb2dJQ0FnSUNBZ0lDOHZJT3lka2V1THRleWRnQ0RzbmJUcnI3Z2c2N08wNjRPSTdKeTg2NHVJSU95RGdlMkRuT3VsdkNEcmk2VHNpNXdnN0o2czdJU2NJQzlvWldGc2RHanJvWndnN0pXTTY2YXc2NHVrSUNqdGxJenJuNnpxdDdqc25ianNuYlFnNjR5QTZyaXdJTzJabE91cHRPeWRoQ0RzaTZUdGpLanJvWndnNjdDVTZyNjg2NHVrS1M0S0lDQWdJQ0FnSUNCcFppQW9ZMjlrWlNBaFBUMGdNQ0FtSmlCRVlYUmxMbTV2ZHlncElDMGdiRzluYVc1VGRHRnlkR1ZrUVhRZ1BDQTFNREF3S1NCN0NpQWdJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0N0oyMElPeW1pZXlMbkNEc2k2VHRqS2pyb1p3ZzY0R2Q2NEtvSU9LQWxDQkRiR0YxWkdVZ1EyOWtaU0RzaEtUc3VaZ2c3SU9CN1lPYzY2VzhJT3VMcE95TG5DRHNvSkRxc29EdGxhbnJpNGpyaTZRdUp5azdDaUFnSUNBZ0lDQWdJQ0JqYUdWamEwTnNZWFZrWlVGMllXbHNZV0pzWlNncE93b2dJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ2ZTazdDaUFnSUNBZ0lHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryb1p6cXQ3anNuYmdnTVREcnRvUWc2cks5NnJPOElPS0FsQ0RyaklEcXVMQWc3WlNFNjZHYzdJUzQ3SXFrSU95Z2xldW1yQzRuS1RzZ2EybHNiRXh2WjJsdVVISnZZeWdwT3lCOUxDQTJNREF3TURBcE93b2dJQ0FnSUNBdkx5RHJncUhzbllBZzdKNkY3SjZsNnJhTTdKMkVJT3Vzdk9xem9DRHNub2pyaXBRZzY0eUE2cml3SU95RXVPeUZtT3lkZ0NEcnNvVHJwckRyaTZRZzRvQ1VJT3llck91aG5PcTN1T3lkdUNEdG00UWc2NHVrN0oyTUlPeWFsT3l5cmV5ZHRDRHNnNGdnN0lTNDdJV1lLT3lEaUNEc25vWHNucVhxdG93cDdKeTg2NkdjSU95TG5PeWVrZTJWbU9xeWpBb2dJQ0FnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd093b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVuSUNzZ0tITjNhWFJqYUUxdlpHVWdQeUFuSUNqcXM0VHNvSlVnN0tDRTdabVlJT0tBbENEc2k1enRnYXpycHI4ZzdMQzlLU2NnT2lBbkp5a2dLeUFuSU9LQWxDRHJvWnpxdDdqc25ianRsWmpycWJRZzdKNlE2NCtaSU95WHNPcXlzT3VRcWV1TGlPdUxwQzRuS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJRzF2WkdVNklITjNhWFJqYUUxdlpHVWdQeUFuWW5KdmQzTmxjaTF6ZDJsMFkyZ25JRG9nSjJKeWIzZHpaWEluSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJsY25KdmNqb2dKK3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc2NnE3SU95WHRPeVhpT3lXdE95YWxEb2dKeUFySUdVdWJXVnpjMkZuWlNCOUtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4Z0tPMkVzT3V2dU91RWtDRHRqN1Ryc0xFZzZyV3M3WmlFNjdhQUlPS0FsQ0RydUl6cm5ienNtckRzb0lBZzdKNlE2NCtaSU95WmhPdWpqT3F3Z0NEc2xZZ2c2NUNZNjRxVUlPMlptT3F5dlNEc29JVHNtcWtwQ2lBZ1puVnVZM1JwYjI0Z2IzQmxia3h2WjJsdVZHVnliV2x1WVd3b0tTQjdDaUFnSUNCN0NpQWdJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJQ0FnTHk4Z2MzUmhjblRxc0lBZzdJT0lJT3k5bU95R2xDRHNzTDNzbllRZzY2ZU02NU9nNjR1a0lDanJpNlRycHF6c25aZ2c3SWlvN0oyQUlPeTltT3lHbE9xenZDRHJyTFRxdElEdGxaanFzb3dnN0lLczdKcXA3SjZRN0plUTZyS01JT3V6dE95ZWhDa3VDaUFnSUNBZ0lDQWdMeThnN0oyMDdKYTA3SVNjSUZCdmQyVnlVMmhsYkd3b0xuQnpNU25zbmJRZ05leTBpQ0Rya3FRZzZyZTRJT3l3dmV5WGtDRHNsNVR0aExEcnBid2c2N08wNjRLMElESHJzb2dvNnJXczY0K0ZJT3F6aE95Z2xTbnNuWVFnN0o2UTY0K1pJT3lFb08yRG5lMlZtT3F6b0N3S0lDQWdJQ0FnSUNBdkx5RHNzTDNzbllRZzdMV2M3SWFNN1ptVTdaVzBJT3lDck95YXFleWVrQ0RyaUlqc2w1UWc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdU91bmpDRHJncWpxc293ZzdaV2M2NHVrTGlEc3NMM3NuWVFnNjZxN0lPeXd2dXljdk91cHRDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPMlZuT3VMcEFvZ0lDQWdJQ0FnSUM4dklDanJpNlRycGJnZzdMQzlJT3lZcE95ZWhldWdwU0Ryc0tuc3A0QWc0b0NVSU9xM3VDRHFzcjNzbXJBZzY2bVU2NG0wNnJDQUlPdXp0T3lkdE91S2xDRHNzWVRyb1p3ZzY0S282ck9nSU95Q3JPeWFxZXlla09xd2dDRHNsNVR0aExBZzdaV2NJT3V5aUNEcmlJVHJwYlRycWJRZzY1Q29LUzRLSUNBZ0lDQWdJQ0F2THlEc283enNuWmc2SUdOc1lYVmtaZXF3Z0NEc3ZaanNocFFnN0tDYzY2cXA3SjJFSU91d2xPcSt1T3VwdENCQmNIQkJZM1JwZG1GMFpTOUdhVzVrVjJsdVpHOTM2ckNBSU91cXV5RHNzTDdzbllRZzdJaVlJT3llaU95ZGpDRGlnSlFnN0p5STY0K0U3SnF3SU95THBPcTRzT3lYa095RW5DRHRtWlhzbmJnZzdaV0U3SnFVTGdvZ0lDQWdJQ0FnSUdOdmJuTjBJSEJ6TVNBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRiRzluYVc0dWNITXhKeWs3Q2lBZ0lDQWdJQ0FnWm5NdWQzSnBkR1ZHYVd4bFUzbHVZeWh3Y3pFc0lGc0tJQ0FnSUNBZ0lDQWdJQ2RUZEdGeWRDMVRiR1ZsY0NBdFUyVmpiMjVrY3lBMUp5d0tJQ0FnSUNBZ0lDQWdJQ2NrZDNNZ1BTQk9aWGN0VDJKcVpXTjBJQzFEYjIxUFltcGxZM1FnVjFOamNtbHdkQzVUYUdWc2JDY3NDaUFnSUNBZ0lDQWdJQ0FpYVdZZ0tDUjNjeTVCY0hCQlkzUnBkbUYwWlNnblkyeGhkV1JsTFd4dloybHVKeWtwSUhzaUxBb2dJQ0FnSUNBZ0lDQWdJaUFnSkhkekxsTmxibVJMWlhsektDZCtKeWtpTEFvZ0lDQWdJQ0FnSUNBZ0p5QWdVM1JoY25RdFUyeGxaWEFnTFZObFkyOXVaSE1nTWljc0NpQWdJQ0FnSUNBZ0lDQWlJQ0JCWkdRdFZIbHdaU0F0VG1GdFpYTndZV05sSUZVZ0xVNWhiV1VnVnlBdFRXVnRZbVZ5UkdWbWFXNXBkR2x2YmlBblcwUnNiRWx0Y0c5eWRDaGNJblZ6WlhJek1pNWtiR3hjSWlsZElIQjFZbXhwWXlCemRHRjBhV01nWlhoMFpYSnVJRk41YzNSbGJTNUpiblJRZEhJZ1JtbHVaRmRwYm1SdmR5aHpkSEpwYm1jZ1l5d2djM1J5YVc1bklIUXBPeUJiUkd4c1NXMXdiM0owS0Z3aWRYTmxjak15TG1Sc2JGd2lLVjBnY0hWaWJHbGpJSE4wWVhScFl5QmxlSFJsY200Z1ltOXZiQ0JUYUc5M1YybHVaRzkzS0ZONWMzUmxiUzVKYm5SUWRISWdhQ3dnYVc1MElHNHBPeWNpTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdKR2dnUFNCYlZTNVhYVG82Um1sdVpGZHBibVJ2ZHloYlRuVnNiRk4wY21sdVoxMDZPbFpoYkhWbExDQW5ZMnhoZFdSbExXeHZaMmx1SnlraUxBb2dJQ0FnSUNBZ0lDQWdKeUFnYVdZZ0tDUm9JQzF1WlNCYlUzbHpkR1Z0TGtsdWRGQjBjbDA2T2xwbGNtOHBJSHNnVzNadmFXUmRXMVV1VjEwNk9sTm9iM2RYYVc1a2IzY29KR2dzSURZcElIMG5MQ0F2THlBMklEMGdVMWRmVFVsT1NVMUpXa1VLSUNBZ0lDQWdJQ0FnSUNkOUp5d0tJQ0FnSUNBZ0lDQmRMbXB2YVc0b0oxeHlYRzRuS1NBcklDZGNjbHh1SnlrN0NpQWdJQ0FnSUNBZ1kyOXVjM1FnWW1GMElEMGdjR0YwYUM1cWIybHVLRzl6TG5SdGNHUnBjaWdwTENBblkyeGhkV1JsTFdKeWFXUm5aUzFzYjJkcGJpNWlZWFFuS1RzS0lDQWdJQ0FnSUNCbWN5NTNjbWwwWlVacGJHVlRlVzVqS0dKaGRDd2dKMEJsWTJodklHOW1abHh5WEc0bklDc0tJQ0FnSUNBZ0lDQWdJQ2R6ZEdGeWRDQWlZMnhoZFdSbExXeHZaMmx1SWlCamJXUWdMMnNnWTJ4aGRXUmxJQzlzYjJkcGJseHlYRzRuSUNzS0lDQWdJQ0FnSUNBZ0lDZHdiM2RsY25Ob1pXeHNJQzFPYjFCeWIyWnBiR1VnTFVWNFpXTjFkR2x2YmxCdmJHbGplU0JDZVhCaGMzTWdMVVpwYkdVZ0lpY2dLeUJ3Y3pFZ0t5QW5JbHh5WEc0bktUc0tJQ0FnSUNBZ0lDQnpjR0YzYmlnblkyMWtKeXdnV3ljdll5Y3NJR0poZEYwc0lIc2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbElIMHBPd29nSUNBZ0lDQjlJR1ZzYzJVZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNka1lYSjNhVzRuS1NCN0NpQWdJQ0FnSUNBZ0x5OGdjSFI1S0dWNGNHVmpkQ25yb1p3ZzY3TzA2NEs0SU8yQ3BPeVhrQ0R0Z2JUcm9aenJrNXdnVkZWSjZyQ0FJT3VzdE91d21PeWRrZXlkdUNEcXNvUHNuYlFnN0l1azdMaWhJTzJabGV5ZHVPdVFxQ2d5TURJMkxUQTNMQ0RzbmJ6cnNKZ2dYSExDdDJ0cGRIUjVJT3k5bE91VG5DRHJxcWpya1pBcElPS0FsQW9nSUNBZ0lDQWdJQzh2SU95Y29PeWR2TzJWbkNEc25wRHJqNW50bVpRZzZySzk2NkdjNjRxVUlGTjVjM1JsYlNCRmRtVnVkSFBzblpnZzdLZUU3S2VjSU8yQ3BDRHNub1hyb0tVdUlPeWdrZXEzdk95RXNTRHF0b3p0bFp6c25iUWc3SjZJN0p5ODY2bTBJRGJzdElnZzY1S2tJT3lYbE8yRXNPcXdnQ0RzbnBEcmo1a2c3SjZGNjZDbDY0KzhDaUFnSUNBZ0lDQWdMeThnTWV1eWlDanF0YXpyajRVZzZyT0U3S0NWS2V5ZHRDRHNoS0R0ZzUzcmtKanFzNkFzSU9xMmpPMlZuT3lkdENEc2w0YnNuTHpycWJRZ2EyVjVjM1J5YjJ0bElPeWtoT3VuakNEc29iRHNtcW50bm9nZzdJdWs3WXlvN1pXMElPeUNyT3lhcWV5ZWtPcXdnQ0RzbDVUdGhMQWc3WldjSU91eWlDRHJpSVRycGJUcnFiUWc2NUNjNjR1a0tHWmhhV3d0YzI5bWRDa3VDaUFnSUNBZ0lDQWdMeThnN0plVTdZU3dJT3luZ2V5Z2hPeVhrQ0JVWlhKdGFXNWhiT3lkaENEcmk2VHNpNXdnN0pXZTdKeTg2NkdjSU9xd2dPeWd1T3laZ0NEcmk2VHJwYmdnN0pXeDdKZVFJTzJDcE9xd2dDRHJrNlRzbHJUcXNJRHJpcFFnNnJLRDdKMkVJT3VuaWV1S2xPdUxwQzRLSUNBZ0lDQWdJQ0J6Y0dGM2JpZ25iM05oYzJOeWFYQjBKeXdnV3dvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QmtieUJ6WTNKcGNIUWdJbU5zWVhWa1pTQXZiRzluYVc0aUp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWVdOMGFYWmhkR1VuTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjJSbGJHRjVJRFluTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QmhZM1JwZG1GMFpTY3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5aR1ZzWVhrZ01DNHpKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pUZVhOMFpXMGdSWFpsYm5SeklpQjBieUJyWlhsemRISnZhMlVnY21WMGRYSnVKeXdLSUNBZ0lDQWdJQ0FnSUM4dklPeVhsTzJFc09xd2dDRHNpNlRzb0p6cm9ad2c2NU9rN0phMDZyQ0VJT3F5dmV5YXNPeVhrT3VuakNEc2w2enF1TEFnNjQrRTY0dXNLT3Eyak8yVm5DRHNsNGJzbkx6cnFiUWc3SnlFN0plUTdJU2NJT3lra2V1THFDa2c0b0NVSU8yRXNPdXZ1T3VFa095ZGhDRHN1WmpzbTR3ZzY3aU02NTI4N0pxdzdLQ0E2NmVNSU91Q3FPcTR0T3VMcEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjJSbGJHRjVJREV1TlNjc0NpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBbmRHVnNiQ0JoY0hCc2FXTmhkR2x2YmlBaVZHVnliV2x1WVd3aUlIUnZJSE5sZENCdGFXNXBZWFIxY21sNlpXUWdiMllnWm5KdmJuUWdkMmx1Wkc5M0lIUnZJSFJ5ZFdVbkxBb2dJQ0FnSUNBZ0lGMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3dvZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJSEpsZEhWeWJpQm1ZV3h6WlRzZ0x5OGc3S2VBN0p1UUlPeVZpQ0R0bFpqcmlwUWdUMU1LSUNBZ0lDQWdmUW9nSUNBZ0lDQnlaWFIxY200Z2RISjFaVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRHJvWnpxdDdqc2xZVHNtNE1nNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0R0bVlqc25aZ2dXK3Vobk9xM3VPeVZoT3liZzEwZzY3S0U3WXE4N0oyMElPMll1T3kybkM0Z1kyeGhkV1JsSUdGMWRHZ2diRzluYjNWMDdKeTg2NkdjSUVOTVNTRHJvWnpxdDdqc25ianNuWVFnN1pXMDdLQ2M3WldjNjR1a0xnb2dJQzh2SUNqc25iUWdVRVBzblpnZzdLQ0E3SjZsNjVDY0lPeWVrT3F5cWV5bW5ldXFoZXlkaENEc3A0RHNtclRyaTZRZzRvQ1VJT3VMcE95TG5DRHNrN0Ryb0tUcnFiUWc3SjZzNjZHYzZyZTQ3SjI0SU8yVmhPeWFsQzRwSU91aG5PcTN1T3lWaE95Ymd5RHRtNFRzbDVRZzdJUzQ3SVdZd3JmcXM0VHNvSlhzdXBEc2k1enJwYndnN0tDVjY2YXM3WldjNjR1a0xnb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OWpiR0YxWkdVdGJHOW5iM1YwSnlrZ2V3b2dJQ0FnWTI5dWMzUWdiRzhnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3lkaGRYUm9KeXdnSjJ4dloyOTFkQ2RkTENCN0lITm9aV3hzT2lCMGNuVmxMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWXNJSGRwYm1SdmQzTklhV1JsT2lCMGNuVmxJSDBwT3dvZ0lDQWdiR1YwSUdWeWNpQTlJQ2NuT3dvZ0lDQWdiRzh1YzNSa1pYSnlMbTl1S0Nka1lYUmhKeXdnS0dRcElEMCtJSHNnWlhKeUlDczlJR1F1ZEc5VGRISnBibWNvS1RzZ2ZTazdDaUFnSUNCc2J5NXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdleUJxYzI5dUtISmxjeXdnTlRBd0xDQjdJRzlyT2lCbVlXeHpaU3dnWlhKeWIzSTZJQ2Zyb1p6cXQ3anNsWVRzbTRNZzdJdWs3WmFKSU95THBPMk1xRG9nSnlBcklHVXViV1Z6YzJGblpTQjlLVHNnZlNrN0NpQWdJQ0JzYnk1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGdld29nSUNBZ0lDQnJhV3hzVUhKdll5Z3BPeUFnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdMeThnNjZHYzZyZTQ3SldFN0p1RDY1Q2NJT3F6aE95Z2xleWRoQ0Ryckx6cmpaZ2c2NHlBNnJpd0lPeUV1T3lGbU95ZGhDRHJzb1RycHJEcmk2UUtJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec2dJQ0FnSUNBZ0lDOHZJT3VMcE95ZGpDQXZZV05qYjNWdWRNSzNMMmhsWVd4MGFPeVhrT3lFbkNEcXM0VHNvSlhzbllRZzdJT0k2NkdjS0Qzc2w0YnNuWXpzbkx6cm9ad3BJT3lkdmVxeWpBb2dJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c095QWdJQ0FnSUNBZ0x5OGc3SU9CN1lPY0lPeWVyTzJNa095Z2xTanJpNlRzbll3ZzdZUzA3SmVRN0lTY0lPdXZ1T3Vobk9xM3VPeWR1Q0Rxc0pEc3A0QXBDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SldFN0p1RElDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a25LVHNLSUNBZ0lDQWdhV1lnS0hKbGN5NW9aV0ZrWlhKelUyVnVkQ2tnY21WMGRYSnVPeUF2THlCbGNuSnZjaUR0bGJqcms2VHJuNnpxc0lBZzdKMjA2Nis0SU95ZGtldUx0ZTJXaU95Y3ZPdXB0Q0RzcEpIcnM3VWc2N0NwN0tlQUNpQWdJQ0FnSUdsbUlDaGpiMlJsSUQwOVBTQXdLU0JxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxJSDBwT3dvZ0lDQWdJQ0JsYkhObElHcHpiMjRvY21WekxDQTFNREFzSUhzZ2IyczZJR1poYkhObExDQmxjbkp2Y2pvZ0tHVnljaTUwY21sdEtDa3VjMnhwWTJVb01Dd2dNVFV3S1NrZ2ZId2dLQ2Zzb29Ycm80d2c3TDJVNjVPY0lDY2dLeUJqYjJSbEtTQjlLVHNLSUNBZ0lIMHBPd29nSUNBZ2NtVjBkWEp1T3dvZ0lIMEtJQ0F2THlEc25wRHF1TEFnN0tLRjY2T01JT0tBbENEdGxJenJuNnpxdDdqc25iZ2dVMVJQVUY5Q1VrbEVSMFV2N1pXWTdZcTQ2N21FN1lxNDZyQ0FJTzJZdU95Mm5PMlZuT3VMcENBbzY2R2M3THVzN0plUTdJU2M2NmVNSU95Z2tlcTN2Q0Rxc0lEcmlxWHRsWmpyaTRnZzdKV0k3S0NFS1FvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5emFIVjBaRzkzYmljcElIc0tJQ0FnSUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLS0Y2Nk9NSU95YWxPeXlyU0Ryc0p2c25Zd2c0b0NVSU91THBPdW1yT3VsdkNEcmdaWHJpNGpyaTZRdUp5azdDaUFnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJREl3TUNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5eVpXTnZiVzFsYm1RbktTQjdDaUFnSUNCamIyNXpkQ0I3SUhSbGVIUXNJRzF2WkdWc0lIMGdQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3dvZ0lDQWdhV1lnS0NGMFpYaDBJSHg4SUNGVGRISnBibWNvZEdWNGRDa3VkSEpwYlNncEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdNQ3dnZXlCbGNuSnZjam9nSit5MmxPeXluT3V3bSt5ZGhDRHJyTGpxdGF6cXNJQWc2N21FN0phMElPeWVpT3lLdGV1TGlPdUxwQzRuSUgwcE93b2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0xhVTdMS2NJT3lhbE95eXJUb25MQ0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z05UQXBMbkpsY0d4aFkyVW9MMXh1TDJjc0lDY2dKeWtnS3lBbjRvQ21KeXdnYlc5a1pXd2dQeUFuS091cXFPdU51RG9nSnlBcklHMXZaR1ZzSUNzZ0p5a25JRG9nSnljcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ1kyOXVjM1FnY21GM0lEMGdZWGRoYVhRZ1lYTnJRMnhoZFdSbEtGTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3NJRzF2WkdWc0tUc0tJQ0FnSUNBZ1kyOXVjM1FnYzNWbloyVnpkR2x2Ym5NZ1BTQndZWEp6WlZOMVoyZGxjM1JwYjI1ektISmhkeWs3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElIc0tJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5TTdJdXhJT3lMcE8yTXFDQW9KeUFySUhObFl5QXJJQ2R6S1RvbkxDQlRkSEpwYm1jb2NtRjNLUzV6YkdsalpTZ3dMQ0F5TURBcEtUc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c2xZZ2dKeUFySUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBcklDZnFzSndnS0NjZ0t5QnpaV01nS3lBbmN5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVkdWNGRDQTlJRk4wY21sdVp5aDBaWGgwS1M1emJHbGpaU2d3TENBek1DazdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhOMVoyZGxjM1JwYjI1ekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lDZnRnYlRyb1p6cms1d2c3Wmk0N0xhY0lPeUxwTzJNcURvZ0p5a3BPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5RHRqSjNzbDRVZzdKcVU3SWFNNjdPRUlPeTJsT3l5bkNEaWdKUWc3WldjSU8yTW5leVhoZXlkbUNEcXRhenNoTEhzbXBUc2hvd283SmV0N1pXZ0srdXN1T3ExckNucnBid2c3WldjSU91eWlPeVhrQ0Ryc0p2c2xZUWc3SmV0N1pXZzY3T0U2NkdjSU91THBPdVRyT3VLbE91THBDNEtJQ0F2THlEc21wVHNob3pycGJ3ZzdaV282cnVZSU91enRPdUN0T3lWdkNEdGc0RHNuYlR0aTREc25iUWc2N080NjZ5NElPdW5wZXVkdmV5ZGhDRHNzTGpzb2JEdGxhQWc3SWlZSU95ZWlPdUxwQ2pzbXBUc2hvenJzNFFnNnJDYzY3T0VJT3lhbE95eXJlcXp2T3lkbUNEc3NLanNuYlFwTGdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5eVpXTnZiVzFsYm1RdGNHOXdkWEFuS1NCN0NpQWdJQ0JqYjI1emRDQjdJR1ZzWlcxbGJuUnpMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR052Ym5OMElHeHBjM1FnUFNCQmNuSmhlUzVwYzBGeWNtRjVLR1ZzWlcxbGJuUnpLU0EvSUdWc1pXMWxiblJ6TG1acGJIUmxjaWdvWlNrZ1BUNGdaU0FtSmlCVGRISnBibWNvWlM1MFpYaDBJSHg4SUNjbktTNTBjbWx0S0NrcElEb2dXMTA3Q2lBZ0lDQnBaaUFvYkdsemRDNXNaVzVuZEdnZ1BDQXlLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0orMk1uZXlYaFNEc21wVHNob3pxc0lBZzY3YUE3S0d4N1pXcDY0dUk2NHVrTGljZ2ZTazdDaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpKM3NsNFVnN0xhVTdMS2NJT3lhbE95eXJUb2c3SnFVN0lhTUlDY2dLeUJzYVhOMExteGxibWQwYUNBcklDZnFzSnduTENCdGIyUmxiQ0EvSUNjbzY2cW82NDI0T2lBbklDc2diVzlrWld3Z0t5QW5LU2NnT2lBbkp5azdDaUFnSUNCMGNua2dld29nSUNBZ0lDQmpiMjV6ZENCeVlYY2dQU0JoZDJGcGRDQmhjMnRRYjNCMWNDaHNhWE4wTENCdGIyUmxiQ2s3Q2lBZ0lDQWdJR052Ym5OMElITmxkSE1nUFNCd1lYSnpaVkJ2Y0hWd0tISmhkeWs3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGelpYUnpLU0I3Q2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1uZXlYaFNEdGpJenNpN0VnN0l1azdZeW9JQ2duSUNzZ2MyVmpJQ3NnSjNNcE9pY3NJRk4wY21sdVp5aHlZWGNwTG5Oc2FXTmxLREFzSURJd01Da3BPd29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTW5leVhoU0RzaExqdGlyZ2dKeUFySUhObGRITXViR1Z1WjNSb0lDc2dKK3F3bkNBb0p5QXJJSE5sWXlBcklDZHpLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnSjF2dGpKM3NsNFZkSUNjZ0t5QlRkSEpwYm1jb0tHeHBjM1JiTUYwZ0ppWWdiR2x6ZEZzd1hTNTBaWGgwS1NCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTWpRcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ6WlhSekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5ZDdKZUZJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzY0eUE3Wm1VN1ppVklPdXN1T3ExckNEc29KenNucEVnNG9DVUlPeURnZTJacWV5ZGhDRHNoS1RycW9YdGxaanJxYlFnNjZ5NDZyV3M2Nlc4SU91bmpPdVRwT3lXdE95a2dPdUxwQ0FvN0xhVTdMS2M2ck84SU9xd21leWRnQ0RzaExqc2haZ3NJT3VNZ08yWmxPdUtsQ0RycDZRZzdKcVU3TEt0N0plUUlPMkd0ZXludU91aG5DRHNpNlRycHJ3cENpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyTnZiWEJ2YzJVbktTQjdDaUFnSUNCamIyNXpkQ0I3SUcxbGMzTmhaMlZ6TENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0cxbGMzTmhaMlZ6S1NBL0lHMWxjM05oWjJWekxtWnBiSFJsY2lnb2JTa2dQVDRnYlNBbUppQlRkSEpwYm1jb2JTNTBaWGgwSUh4OElDY25LUzUwY21sdEtDa3BJRG9nVzEwN0NpQWdJQ0JwWmlBb0lXeHBjM1F1YkdWdVozUm9LU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0ordU1nTzJabENEcmdyVHNtcW5zbmJRZzY3bUU3SmEwSU95ZWlPeUt0ZXVMaU91THBDNG5JSDBwT3dvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCamIyNXpkQ0JzWVhOMFZYTmxjaUE5SUZzdUxpNXNhWE4wWFM1eVpYWmxjbk5sS0NrdVptbHVaQ2dvYlNrZ1BUNGdiUzV5YjJ4bElDRTlQU0FuWVhOemFYTjBZVzUwSnlrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU91TWdPMlpsQ0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LQ2hzWVhOMFZYTmxjaUFtSmlCc1lYTjBWWE5sY2k1MFpYaDBLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSUNqcmpJRHRtWlFnSnlBcklHeHBjM1F1YkdWdVozUm9JQ3NnSitxd25Da25LVHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJR052Ym5OMElISmhkeUE5SUdGM1lXbDBJR0Z6YTBOdmJYQnZjMlVvYkdsemRDNXpiR2xqWlNndE1USXBMQ0J0YjJSbGJDazdJQzh2SU91TWdPMlpsT3F3Z0NEcXVManNsclRzcDREcnFiUWc3TFdjNnJlOElERXk2ckNjNjZlTUlDanRsSVRyb2F6dGxJVHRpcmdnN1krdDdLTzhJT3V3cWV5bmdDa0tJQ0FnSUNBZ1kyOXVjM1FnYjNWMElEMGdjR0Z5YzJWRGIyMXdiM05sS0hKaGR5azdDaUFnSUNBZ0lHTnZibk4wSUhObFl5QTlJQ2dvUkdGMFpTNXViM2NvS1NBdElITjBZWEowWldRcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtUc0tJQ0FnSUNBZ2FXWWdLQ0Z2ZFhRcElIc0tJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJTzJNak95THNTRHNpNlR0aktnZ0tDY2dLeUJ6WldNZ0t5QW5jeWs2Snl3Z1UzUnlhVzVuS0hKaGR5a3VjMnhwWTJVb01Dd2dNakF3S1NrN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJSHNnWlhKeWIzSTZJQ2Z0Z2JUcm9aenJrNXdnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPeWRrZXVMdFNBb0p5QXJJSE5sWXlBcklDZHpMQ0Rzb0p6c2xZZ2dKeUFySUc5MWRDNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dLeUFuNnJDY0tTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktDaHNZWE4wVlhObGNpQW1KaUJzWVhOMFZYTmxjaTUwWlhoMEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCeVpYQnNlVG9nYjNWMExuSmxjR3g1TENCemRXZG5aWE4wYVc5dWN6b2diM1YwTG5OMVoyZGxjM1JwYjI1ekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzY3S0k3SmV0SU9LQWxDRHRsWnpxdGEzc2xyUWc0b2FVSU95WWdleVd0Q0RzbnBEcmo1a2dLT3kybE95eW5PcXp2Q0Rxc0puc25ZQWc3SVM0N0lXWUlPeUNyT3lhcVNrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmRISmhibk5zWVhSbEp5a2dld29nSUNBZ1kyOXVjM1FnZXlCMFpYaDBMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmcnNvanNsNjN0bGFBZzY2eTQ2cldzNnJDQUlPdTVoT3lXdENEc25vanNpclhyaTRqcmk2UXVKeUI5S1RzS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNtcFRzc3EwNkp5d2dVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURVd0tTNXlaWEJzWVdObEtDOWNiaTluTENBbklDY3BJQ3NnSitLQXBpY3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NtRjNJRDBnWVhkaGFYUWdZWE5yVkhKaGJuTnNZWFJsS0ZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0Nrc0lHMXZaR1ZzS1RzS0lDQWdJQ0FnWTI5dWMzUWdiM1YwSUQwZ2NHRnljMlZVY21GdWMyeGhkR1VvY21GM0tUc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93b2dJQ0FnSUNCcFppQW9JVzkxZENrZ2V3b2dJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryc29qc2w2MGc3WXlNN0l1eElPeUxwTzJNcUNBb0p5QXJJSE5sWXlBcklDZHpLVG9uTENCVGRISnBibWNvY21GM0tTNXpiR2xqWlNnd0xDQXlNREFwS1RzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVRuQ0Ryc29qc2w2MGc3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95WmhPdWpqQ0FvSnlBcklITmxZeUFySUNkekxDQW5JQ3NnS0c5MWRDNWthWEpsWTNScGIyNGdmSHdnSno4bktTQXJJQ2NwSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbk5sY25abFpDc3JPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dNekFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QjBjbUZ1YzJ4aGRHVmtPaUJ2ZFhRdWRISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVPaUJ2ZFhRdVpHbHlaV04wYVc5dUxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdLSTdKZXRJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPdXlpT3lYclNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURRc0lIc2daWEp5YjNJNklDZE9iM1FnWm05MWJtUW5JSDBwT3dwOUtUc0tDaTh2SU95ZHRPdXZ1Q0RyaTZUcnBxenFzSUFnNjVhZ0lPeWVpT3VLbE91TnNDRHJtSkFnN0x5YzZyaXc2ckNBSU91VHBPeVd0T3lZcE91cHRDanNvSnpzaXFUc3NwZ2c3SjZRNjQrWklPeThuT3E0c0NEc3BKSHJzN1VnNjVPeEtTRHNvYkRzbXFudG5vZ2c3S0tGNjZPTUlPS0FsQ0RyajR6cmpaZ2c2NHVrNjZhczY0cVVJT3EzdU91TWdPdWhuQ0RzbktEc3A0QUtjMlZ5ZG1WeUxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQjdDaUFnYVdZZ0tHVWdKaVlnWlM1amIyUmxJRDA5UFNBblJVRkVSRkpKVGxWVFJTY3BJSHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbmJUcnI3Z2c3THljN0tDNElPeWVpT3lXdE95YWxDanRqNnp0aXJnZ0p5QXJJRkJQVWxRZ0t5QW5JT3lDck95YXFTRHNwSkVwSU9LQWxDRHNuYlFnN0oyNDdJcWs3WVMwN0lxazY0cVVJT3lpaGV1ampPMlZxZXVMaU91THBDNG5LVHNLSUNBZ0lIQnliMk5sYzNNdVpYaHBkQ2d3S1RzS0lDQjlDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUVuT3V5aENEc21LVHJwWmc2Snl3Z1pTQW1KaUJsTG0xbGMzTmhaMlVwT3dvZ0lIQnliMk5sYzNNdVpYaHBkQ2d4S1RzS2ZTazdDaTh2SU95V3RPdVdwQ0Rxc3Izcm9aenJvWndnN0tPOTY1T2dLT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFzSUVOMGNtd3JReXdnTDNOb2RYUmtiM2R1TENEc21LVHJwWmdwSUdOc1lYVmtaU0RzbnBEc2k1M3NuWVFnNjRLbzZyaXc3S2VBSU95Vml1dUtsT3VMcEFwd2NtOWpaWE56TG05dUtDZGxlR2wwSnl3Z0tDa2dQVDRnZXlCcmFXeHNVSEp2WXlncE95QnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lIMHBPd3B3Y205alpYTnpMbTl1S0NkVFNVZEpUbFFuTENBb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3BPd3B3Y205alpYTnpMbTl1S0NkVFNVZFVSVkpOSnl3Z0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBLVHNLQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc0tJQ0JqYjI1emIyeGxMbXh2WnlnbjRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FKeWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeUR0Z2JUcm9aenJrNXdnNjR1azY2YXNJT3k4bk95bmtDRGlnSlFnYUhSMGNEb3ZMMnh2WTJGc2FHOXpkRG9uSUNzZ1VFOVNWQ2s3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeURycXFqcmpiZzZJQ2NnS3lCRFRFRlZSRVZmVFU5RVJVd2dLeUFuSU1LM0lPeVlpT3lMbkNBbklDc2dSVmhCVFZCTVJWTXViR1Z1WjNSb0lDc2dKK3F4dENEc25xWHNzS2tuS1RzS0lDQmpiMjV6YjJ4bExteHZaeWduSU95ZHRDRHNzTDNzbllRZzdMeWM2NUdVSU91UG1leVZpQ0R0bEx6cXQ3anJwNGdnN1pTTTY1K3M2cmU0N0oyNDdKMjBJTzJCdE91aG5PdVRuT3VobkNEc3RwVHNzcHp0bGFucmk0anJpNlF1SnlrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSitLVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdDY3BPd29nSUdOb1pXTnJRMnhoZFdSbFFYWmhhV3hoWW14bEtDazdJQzh2SUVOc1lYVmtaU0JEYjJSbElPeUNyT3lhcVNEcXNJRHJpcVVnN0plczY3YUFJT3lna09xeWdDQW83WlNNNjUrczZyZTQ3SjI0SU95VmlPdUN0T3lhcVNrS0lDQXZMeURycjdqcnBxd2c3SXVjNjQrWklDc2c3S2VBN0l1YzY2eTRJT3lqdk95ZWhTRGlnSlFnN0xLcklPeTJsT3l5bk91MmdPMkVzQ0RydWFEcnBiVHFzb3dLSUNCaGMydERiR0YxWkdVb0oreWJqT3V3amV5WGhUb2dJdXlnZ095ZXBTRHJrSmpzbDRqc2lyWHJpNGpyaTZRaUp5a3VkR2hsYmlnS0lDQWdJQ2dwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbTR6cnNJM3NsNFVnN0ptRTY2T01JT0tBbENEc3RwVHNzcHdnN0tTQTY3bUVJT3VCblM0bktTd0tJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeUxwTzJNcUNBbzdMS3JJT3lhbE95eXJTRHJsWXdnN0o2czdJdWM2NCtFS1RvbkxDQmxMbTFsYzNOaFoyVXBDaUFnS1RzS2ZTazdDZz09JwpCNjRfV0FUQ0hFUj0nTHk4ZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzRvQ1VJTzJWcmV5RGdTRHJscUFnN0o2STY0cVVJT3kwaU95R2pPMllsU0RzaEp6cnNvUWdLR3h2WTJGc2FHOXpkRG94TVRnNE9Ta0tMeThnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUNpOHZJT3labkNEdGxZVHNtcFR0bFp6cXNJQTZJTzJVdk9xM3VPdW5pT3F3Z0NEdGxJenJuNnpxdDdqc25ianNuWmdnWTJ4aGRXUmxZbkpwWkdkbE9pOHZJT3lYdE9xNHNDaDNhVzVrYjNjdWIzQmxiaTlwWm5KaGJXVXZiM0JsYmtWNGRHVnlibUZzS2V1bHZBb3ZMeURzb0lUcnRvQWc3SWFNNjZhc0lPeVhodXlkdENEcnA0bnJpcFFnNjdLRTdLQ0U3SjIwSU95ZWlPdUxwQzRnWm1WMFkyanJpcFFnNjZxN0lPdW5pZXljdk91dmdPdWhuQ3dnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKRHNpNXpzbnBEc2w1RHFzb3dLTHk4Z1VFOVRWQ0F2ZDJGclpTRHJwYndnNjdPMDY0SzA2Nm0wSU9xd2tPeUxuT3lla09xd2dDRHJpNlRycHF3b1kyeGhkV1JsTFdKeWFXUm5aUzVxY3lucnBid2c2NHlBN0l1Z0lPeThvT3VMcEM0S0x5OEtMeThnNjR1azY2YXM3Sm1BN0oyWUlPeXdxT3lkdERvZzZyQ1E3SXVjN0o2UTY0cVVJR05zWVhWa1pldWx2Q0Ryckx6c3A0QWc3SldLNjRxVTY0dWtLT3lla095TG5TRHNsNGJzbll3cElPS0draUR0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3VsdkNEc2xZZ2c2NmVKNnJPZ0xBb3ZMeURycVpUcnFxanJwcXdnZmpFMVRVTHJuYndnNjZHYzZyZTQ3SjI0SU95TG5DRHNucERyajVrZzdJdWM3SjZSN0p5ODY2R2NJT3lEZ2V5TG5DRHN2Snpya2F6cmo0UWc2N2FBNjR1MElPeVhodXVMcENBbzY1T3g2NkdkT2lCdWNHMGdjblZ1SUdKMWFXeGtLUzRLTHk4ZzY0dWs2NmFzNjRxVUlPeUxyT3llcGV1d2xldVBtU0RyZ1lycXVMRHJxYlFnN0tPOTdLZUE2NmVNS08yVWpPdWZyT3EzdU95ZHVPcXp2Q0RzZzUzc2dxd2c2NCtaNnJpdzdabVVLU3dnNnJDUTdJdWM3SjZRNjRxVUlPcXpoT3lHalNEcmdxanNsWVFnNjR1azdKMk1JT3E1cU95YXNPcTRzT3VsdkNEcnNKdnJpcFRyaTZRdUNncGpiMjV6ZENCb2RIUndJRDBnY21WeGRXbHlaU2duYUhSMGNDY3BPd3BqYjI1emRDQndZWFJvSUQwZ2NtVnhkV2x5WlNnbmNHRjBhQ2NwT3dwamIyNXpkQ0JtY3lBOUlISmxjWFZwY21Vb0oyWnpKeWs3Q21OdmJuTjBJRzl6SUQwZ2NtVnhkV2x5WlNnbmIzTW5LVHNLWTI5dWMzUWdleUJ6Y0dGM2Jpd2djM0JoZDI1VGVXNWpJSDBnUFNCeVpYRjFhWEpsS0NkamFHbHNaRjl3Y205alpYTnpKeWs3Q2dwamIyNXpkQ0JRVDFKVUlEMGdNVEU0T0RrN0NtTnZibk4wSUZKUFQxUWdQU0J3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5LVHNnTHk4ZzdLQ0E3SjZsN0lhTUlPdWpxTzJLdUNEaWdKUWc2NHVrNjZhczZyQ0FJSEpsWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0Wk91bHZDRHNzTDdyaXBRZzZyaXc3S1NBQ2dwamIyNXpkQ0JEVDFKVFgwaEZRVVJGVWxNZ1BTQjdDaUFnSjBGalkyVnpjeTFEYjI1MGNtOXNMVUZzYkc5M0xVOXlhV2RwYmljNklDY3FKeXdLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEFvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFJWldGa1pYSnpKem9nSjBOdmJuUmxiblF0Vkhsd1pTY3NDbjA3Q21aMWJtTjBhVzl1SUdwemIyNG9jbVZ6TENCemRHRjBkWE1zSUc5aWFpa2dld29nSUhKbGN5NTNjbWwwWlVobFlXUW9jM1JoZEhWekxDQlBZbXBsWTNRdVlYTnphV2R1S0hzZ0owTnZiblJsYm5RdFZIbHdaU2M2SUNkaGNIQnNhV05oZEdsdmJpOXFjMjl1T3lCamFHRnljMlYwUFhWMFppMDRKeUI5TENCRFQxSlRYMGhGUVVSRlVsTXBLVHNLSUNCeVpYTXVaVzVrS0VwVFQwNHVjM1J5YVc1bmFXWjVLRzlpYWlrcE93cDlDZ292THlCamJHRjFaR1VnUTB4SjZyQ0FJT3llaU91S2xPeW5nQ0RpZ0pRZzdKZUc3Snk4NjZtMElDOTNZV3RsSU95ZGtldUx0ZXlYa0NEc2k2VHNsclFnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPeWR2ZXE0c0NEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpJQ2pyaTZUcnBxenNuWmdnWTJ4aGRXUmxRV05qYjNWdWRPeVpnQ0Rxc0puc25ZQWc3TGFjN0xLWUtTNEtMeThnN1l5TTdKMjg3SjIwSU8yQnRDRHNpSmdnN0o2STdKYTBJRE13N0xTSUlPeTZrT3lMbkM0ZzdKNnM2NkdjNnJlNDdKMjQ3WldZNjZtMElFTk1TZXF3Z0NEdGpJenNuYnpzbllRZzZyQ3g3SXVnN1pXWTY2K0E2NkdjSU95ZWtPdVBtU0Ryc0pqc21JSHJrSnpyaTZRdUNpOHZJT3k2a095TG5DQTE3TFNJSU9LQWxDRHJvWnpxdDdqc25iZ2c3S2VCN1p1RUlPeURpQ0RxczRUc29KWHNuYlFnNnJPbjY3Q1U2NkdjSU95ZW9lMllnT3lWdkNEdGxJenJuNnpxdDdqc25ianNuYlFnNjZHYzZyZTQ3SjI0SU8yWmxPdXB0T3lYa095RW5DRHRtWWpzbkx6cm9ad2c2NFNZN0phMDZyQ0U2NHVrS0RNdzdMU0k2Nm0wSU91RWlPdXN0Q0RyaXFic25Zd3BDbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93cG1kVzVqZEdsdmJpQmpiR0YxWkdWQlkyTnZkVzUwS0NrZ2V3b2dJR2xtSUNoRVlYUmxMbTV2ZHlncElDMGdZV05qYjNWdWRFTmhZMmhsTG1GMElEd2dOVEF3TUNrZ2NtVjBkWEp1SUdGalkyOTFiblJEWVdOb1pTNWxiV0ZwYkRzS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnFJRDBnU2xOUFRpNXdZWEp6WlNobWN5NXlaV0ZrUm1sc1pWTjVibU1vY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKeTVqYkdGMVpHVXVhbk52YmljcExDQW5kWFJtT0NjcEtUc0tJQ0FnSUdWdFlXbHNJRDBnS0dvZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpLU0I4ZkNCdWRXeHNPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91aG5PcTN1T3lkdUNEc25iVHJvS1VnN0plRzdKMk1JT3VUc1NEaWdKUWdiblZzYkNBcUx5QjlDaUFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ1JHRjBaUzV1YjNjb0tTd2daVzFoYVd3Z2ZUc0tJQ0J5WlhSMWNtNGdaVzFoYVd3N0NuMEtDbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzS0lDQmpiMjV6ZENCbWFXNWtaWElnUFNCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbklEOGdKM2RvWlhKbEp5QTZJQ2QzYUdsamFDYzdDaUFnZEhKNUlIc2djbVYwZFhKdUlITndZWGR1VTNsdVl5aG1hVzVrWlhJc0lGc25ZMnhoZFdSbEoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0J6YUdWc2JEb2dkSEoxWlNCOUtTNXpkR0YwZFhNZ1BUMDlJREE3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJSEpsZEhWeWJpQm1ZV3h6WlRzZ2ZRcDlDZ3BzWlhRZ2QyRnJhVzVuSUQwZ1ptRnNjMlU3SUM4dklPeVhzTzJEZ0NEcnNLbnNwNEFnNG9DVUlPdUxwT3Vtck91S2xDRHNsclRzc0tqdGxMd2dSVUZFUkZKSlRsVlRSZXVobkNEc3BKSHJzN1VnN0tDVjY2YXM3WldZN0tlQTY2ZU1JTzJVaE91aG5PeUV1T3lLcENEcmdxM3J1WVRycGJ3ZzdLU0U3SjI0NjR1a0NtWjFibU4wYVc5dUlIZGhhMlZDY21sa1oyVW9LU0I3Q2lBZ2FXWWdLSGRoYTJsdVp5a2djbVYwZFhKdU93b2dJSGRoYTJsdVp5QTlJSFJ5ZFdVN0NpQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJSGRoYTJsdVp5QTlJR1poYkhObE95QjlMQ0ExTURBd0tUc0tJQ0JzWlhRZ2NISnZZenNLSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdMeThnVjJsdVpHOTNjem9nWTIxa3dyZDJZbk1nNnJLOTdKeWdJT3lYaHV5ZHRDQnViMlJsNjZXOElPeW5nZXlna1N3Z2QybHVaRzkzYzBocFpHVW9RMUpGUVZSRlgwNVBYMWRKVGtSUFZ5bnJvWndnN0lxazdZK3dJT0tBbEFvZ0lDQWdMeThnN0xDOUlPeVhodXVLbENEc2lLanNuWUFnN0wyWTdJYVU3SjIwSU91bmpPdVRwT3lXdE95bmdPcXpvQ0RyaTZUcnBxenNuWmdnN0o2UTdJdWRLR05zWVhWa1pTbnJqNFFnNnJlNElPeTltT3lHbE95ZGhDRHJyTHpyb0tUcnNKdnNsWVFnN0phMDY1YWtJT3l3dmV1UGhDRHNsWWdnNjV5czY0dWtMZ29nSUNBZ0x5OGdaR1YwWVdOb1pXVHJpcFFnN0pPdzdLZUFJT3lWaXV1S2xPdUxwQ2hrWlhSaFkyaGxaQ3QzYVc1a2IzZHpTR2xrWlNEc29iRHRsYW5zbllBZzdMMlk3SWFVSU95d3ZleWR0Q0RyaGJqc3RwenJrS2dnNG9DVUlPeUxwT3k0b1NrdUNpQWdJQ0F2THlCWGFXNWtiM2R6N0plUTdJU2dJR1JsZEdGamFHVmtJT3lYaHV5ZHRPdVBoQ0RydG9EcnFxZ282ckNRN0l1YzdKNlFLZXF3Z0NEc283M3NsclRyajRRZzdKNlE3SXVkN0oyQUlPeUN0T3lWaE91Q3FPdUtsT3VMcEM0S0lDQWdJSEJ5YjJNZ1BTQnpjR0YzYmlod2NtOWpaWE56TG1WNFpXTlFZWFJvTENCYmNHRjBhQzVxYjJsdUtGOWZaR2x5Ym1GdFpTd2dKMk5zWVhWa1pTMWljbWxrWjJVdWFuTW5LVjBzSUhzS0lDQWdJQ0FnWTNka09pQlNUMDlVTENCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsTEFvZ0lDQWdmU2s3Q2lBZ2ZTQmxiSE5sSUhzS0lDQWdJQzh2SUcxaFkwOVRMK3Vtck91SWhleUtwRG9nNnJDUTdJdWM3SjZRNjZXOElPdWRoT3lhdENCdWIyUmxJT3lMcE8yV2lTRHRqSXpzbmJ6cm9ad2c3S2VCN0tDUklPeUtwTzJQc0NBb2JHRjFibU5vWkNEdG1aanFzcjNzbDVRZ1VFRlVTT3F3Z0NEcnVZanNsYjN0bGFBZzdJaVlJT3llaU95V3RDRHNvSWpyaklEcXNyM3JvWndnN0lLczdKcXBLUW9nSUNBZ2NISnZZeUE5SUhOd1lYZHVLSEJ5YjJObGMzTXVaWGhsWTFCaGRHZ3NJRnR3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBblkyeGhkV1JsTFdKeWFXUm5aUzVxY3ljcFhTd2dld29nSUNBZ0lDQmpkMlE2SUZKUFQxUXNJR1JsZEdGamFHVmtPaUIwY25WbExDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0NpQWdJQ0I5S1RzS0lDQjlDaUFnY0hKdll5NTFibkpsWmlncE95QXZMeURxc0pEc2k1enNucEFnN0oyMDY3S2s3WXE0SU91anFPMlVoT3lYa095RW5DRHJ0b1RycHF3Z0tPcXdrT3lMbk95ZWtDRHNvb1hybzR6cnBid2c2NmVKN0tlQUlPeVZpdXF5akNrS2ZRb0tMeThnN0oyMElGQkQ2Nlc4SUNmc2hLVHN1WmdnN0tDRUtPeURpQ0JRUXlrbklPeURnZTJEbk91aG5DRHJrSmpyajR6cnByRHJpNlFnNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0JiN0xTSTZyaXc3Wm1VWFNEcnNvVHRpcndvVUU5VFZDQXZkVzVwYm5OMFlXeHNLZXlkdENEcnRvRHJwYmpyaTZRdUNpOHZJSEpsWjJsemRHVnlMWEJ5YjNSdlkyOXNMbXB6NnJDQUlPeUVwT3k1bU8yVm5DRHFzb1BzbllRZzZyZTQ2NHlBNjZHY0lPdVFtT3VQak91bXNPdUxwRG9nNnJDUTdJdWM3SjZRSU95ZWtPdVBtZXlMbk95ZWtTQXJJQ2pzbm9qc25MenJxYlFwSU95RXBPeTVtQ0R0ajdUcmpaUXVDaTh2SU9LYW9PKzRqeURyc0pqcms1enNpNXdnU0ZSVVVDRHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPdXp0T3VDdUNEcmtxUWc3Wmk0N0xhYzdaV2dJT3F5Z3lEaWdKUWdiV0ZqVDFNZ2JHRjFibU5vWTNSc0lHSnZiM1J2ZFhUc25iUWc3SjIwSU8yVWhPdWhuT3lFdU95S3BPdWx2Q0RzcG9uc2k1d2c3S0tGNjZPTTdJdWM3WUtzSU95SW1DRHNub2pyaTZRdUNpOHZJQ0FnSU9xM3VPdWVtT3lFbkNEdGpJenNuYndvY0d4cGMzVEN0K3lFcE95NW1DRHRqN1RyalpRcDdKMkVJR3hoZFc1amFHTjBiT3V6dE91THBDRHJxTHpzb0lBZzdLZUE3SnEwNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc283M3NsNnpyajRRZzdKNlE2NCtaN0l1YzdKNlI3SjJBSU95ZHRPdXZ1Q0RzZ3F6cm5ienNwNFRyaTZRdUNtWjFibU4wYVc5dUlIVnVhVzV6ZEdGc2JGTmxiR1lvS1NCN0NpQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlGdGRPd29nSUhSeWVTQjdDaUFnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjJSaGNuZHBiaWNwSUhzS0lDQWdJQ0FnWTI5dWMzUWdURUZDUlV3Z1BTQW5ZMjl0TG1Oc1lYVmtaV0p5YVdSblpTNTNZWFJqYUdWeUp6c0tJQ0FnSUNBZ1kyOXVjM1FnY0d4cGMzUWdQU0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5UR2xpY21GeWVTY3NJQ2RNWVhWdVkyaEJaMlZ1ZEhNbkxDQk1RVUpGVENBcklDY3VjR3hwYzNRbktUc0tJQ0FnSUNBZ1kyOXVjM1FnYVc1emRDQTlJSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDZE1hV0p5WVhKNUp5d2dKMEZ3Y0d4cFkyRjBhVzl1SUZOMWNIQnZjblFuTENBblEyeGhkV1JsUW5KcFpHZGxKeWs3Q2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktIQnNhWE4wS1NrZ2V5Qm1jeTUxYm14cGJtdFRlVzVqS0hCc2FYTjBLVHNnY21WdGIzWmxaQzV3ZFhOb0tIQnNhWE4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwS0lDQWdJQ0FnZEhKNUlIc2dhV1lnS0daekxtVjRhWE4wYzFONWJtTW9hVzV6ZENrcElIc2dabk11Y20xVGVXNWpLR2x1YzNRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbExDQm1iM0pqWlRvZ2RISjFaU0I5S1RzZ2NtVnRiM1psWkM1d2RYTm9LR2x1YzNRcE95QjlJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRb2dJQ0FnSUNCMGNua2dleUJ6Y0dGM2JsTjVibU1vSjJ4aGRXNWphR04wYkNjc0lGc25ZbTl2ZEc5MWRDY3NJQ2RuZFdrdkp5QXJJSEJ5YjJObGMzTXVaMlYwZFdsa0tDa2dLeUFuTHljZ0t5Qk1RVUpGVEYwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2UzMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0Nkc1lYVnVZMmhqZEd3bkxDQmJKM0psYlc5MlpTY3NJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUW9nSUNBZ2ZTQmxiSE5sSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJSFJ5ZVNCN0lITndZWGR1VTNsdVl5Z25jbVZuSnl3Z1d5ZGtaV3hsZEdVbkxDQW5TRXREVlZ4Y1UyOW1kSGRoY21WY1hFMXBZM0p2YzI5bWRGeGNWMmx1Wkc5M2MxeGNRM1Z5Y21WdWRGWmxjbk5wYjI1Y1hGSjFiaWNzSUNjdmRpY3NJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5Snl3Z0p5OW1KMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE95QnlaVzF2ZG1Wa0xuQjFjMmdvSit5ZWtPdVBtZXlMbk95ZWtTaERiR0YxWkdWQ2NtbGtaMlZYWVhSamFHVnlLU2NwT3lCOUlHTmhkR05vSUNoZlpTa2dlMzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KMk5zWVhWa1pXSnlhV1JuWlRvdkx5RHJrN0hyb1owbktUc2dmU0JqWVhSamFDQW9YMlVwSUh0OUNpQWdJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lDQWdZMjl1YzNRZ2FXNXpkQ0E5SUhCaGRHZ3VhbTlwYmlod2NtOWpaWE56TG1WdWRpNU1UME5CVEVGUVVFUkJWRUVnZkh3Z2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSjBGd2NFUmhkR0VuTENBblRHOWpZV3duS1N3Z0owTnNZWFZrWlVKeWFXUm5aU2NwT3dvZ0lDQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlFvZ0lDQWdJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2UzMEtJQ0FnSUgwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpQm1ZV2xzTFhOdlpuUWc0b0NVSU91cXV5RHNwNERzbXJRZzZyS01JT3llaU95V3RPdVBoQ0R0bEl6cm42enF0N2pzbmJnZzdLcTlJT3E0c095V3RTRHNncTNzb0p6cmlwUWc3SjIwNjYrNElPdUJuZXVDck91THBDQXFMeUI5Q2lBZ2NtVjBkWEp1SUhKbGJXOTJaV1E3Q24wS0NpOHZJT3VMcE91bXJDZ3hNVGc0T0NucXNJQWc2NWFnSU95ZWlPeWN2T3VwdENEcmdZanJpNlFnNG9DVUlPeTBpT3E0c08yWmxDRHNpNXdnNjRLbzdKMkFJT3lFdU95Rm1DRHNvSlhycHF3Z0tPeVhodXljdk91cHRDRHNvYkRzbXFudG5vZ2c3SXVrN1l5b0tRcG1kVzVqZEdsdmJpQnphSFYwWkc5M2JrSnlhV1JuWlNncElIc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdjaUE5SUdoMGRIQXVjbVZ4ZFdWemRDaDdJR2h2YzNRNklDY3hNamN1TUM0d0xqRW5MQ0J3YjNKME9pQXhNVGc0T0N3Z2NHRjBhRG9nSnk5emFIVjBaRzkzYmljc0lHMWxkR2h2WkRvZ0oxQlBVMVFuTENCMGFXMWxiM1YwT2lBeE5UQXdJSDBzSUNncElEMCtJSHQ5S1RzS0lDQWdJSEl1YjI0b0oyVnljbTl5Snl3Z0tDa2dQVDRnZTMwcE93b2dJQ0FnY2k1dmJpZ25kR2x0Wlc5MWRDY3NJQ2dwSUQwK0lIc2dkSEo1SUhzZ2NpNWtaWE4wY205NUtDazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZTQjlLVHNLSUNBZ0lISXVaVzVrS0NrN0NpQWdmU0JqWVhSamFDQW9YMlVwSUh0OUNuMEtDbU52Ym5OMElITmxjblpsY2lBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtDaHlaWEVzSUhKbGN5a2dQVDRnZXdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5UMUJVU1U5T1V5Y3BJSHNnY21WekxuZHlhWFJsU0dWaFpDZ3lNRFFzSUVOUFVsTmZTRVZCUkVWU1V5azdJSEpsZEhWeWJpQnlaWE11Wlc1a0tDazdJSDBLSUNCcFppQW9jbVZ4TG5WeWJDQTlQVDBnSnk5b1pXRnNkR2duS1NCN0NpQWdJQ0F2THlCMk9pRHFzSkRzaTV6c25wQWc3TDJVNjVPY0lPdXloT3lnaENEaWdKUWc2cldzNjdLRTdLQ0VJTzJVaE91aG5PeUV1T3lLcE9xd2dDRHFzNFRzaG8wZzY0K002ck9nSU95ZWlPdUtsT3luZ0NEcnNKYnNsNURzaEp3ZzdabVY3SjI0N1pXWTY0cVVJT3lhcWV1UGhBb2dJQ0FnTHk4Z0tIWXlJRDBnN0xDOUlPeUlxT3E1Z0NEc2lKanNvSlh0akpBc0lIWXpJRDBnTDJGalkyOTFiblFnN0xhVTZyQ0E3WXlRTENCMk5DQTlJQzkxYm1sdWMzUmhiR3dnN0xhVTZyQ0E3WXlRS1FvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lIZGhkR05vWlhJNklIUnlkV1VzSUhZNklEUWdmU2s3Q2lBZ2ZRb2dJQzh2SU95ZHRDQlFRK3lYa0NEcm9aenF0N2pzbmJqcmtKd2c3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRGlnSlFnN1pTTTY1K3M2cmU0N0oyNElPeXlxeUR0bVpUcnFiVEN0KzJaaU95ZHRDQWk2NGlFNnJXc0lPcXpoT3lnbGV5Y3ZPdWhuQ0RzazdEcmlwVHNwNEFpSU91enRPeVhyT3lqdk91S2xDRHJqYkFnN0pPMDY0dWtMZ29nSUM4dklPcXdrT3lMbk95ZWtPcXdnQ0RyaTdYdGxaanJpcFFnN0oyMDdKeWdPaURyaTZUcnBxenJwYndnN0x5YzY2bTBJT3liak91d2pleVhoZXljdk91aG5DRHRnYlRyb1p6cms1enFzSUFnN0l1azdLQ2NJTzJZdU95Mm5PdVB2Q0RxdGF6cmo0VWc3SUtzN0pxcDY1K0o3SjIwSU91Q21PcXdoT3VMcEM0S0lDQXZMeURxc0pEc2k1enNucERyaXBRZzdZeU03SjI4NjZlTUlPeWR2ZXljdk91dmdPdWhuQ0RzZ3F6c21xbnJuNGtnTUNEQ3R5RHJqSURxdUxBZ01DRGlnSlFnNnJLQTdZYWc2NmVNSU95VHNPdUtsQ0RzZ3F6cm5venNsNURxc293ZzY3bUU3SnFwN0oyRUlPdXN2T3Vtck95bmdDRHNsWXJyaXBUcmk2UXVDaUFnTHk4ZzdLTzg3SjJZT2lEc2w2enF1TEFnNnJPRTdLQ1Y3SjIwSU91enRPeVhyT3VQaENEc25vWHNucVhxdG96c25iUWc2NmVNNjZPTTY1Q1E3SjJFSU95SW1DRHNub2pyaTZRbzdKeWc3WnFvN0lTeDdKMkFJT3lMcE95Z25DRHRtTGpzdHB3ZzY1V002NmVNSU95VmpDRHNpSmdnN0o2STdKMk1JT0tBbENEcmk2VHJwcXdnTDJobFlXeDBhT3lkbUNCd2NtOWliR1Z0SU95d3VPcXpvQ2t1Q2lBZ2FXWWdLSEpsY1M1MWNtd2dQVDA5SUNjdllXTmpiM1Z1ZENjcElIc0tJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0JoWTJOdmRXNTBPaUJqYkdGMVpHVkJZMk52ZFc1MEtDa3NJR05zWVhWa1pUb2dhR0Z6UTJ4aGRXUmxLQ2tnZlNrN0NpQWdmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkzWVd0bEp5a2dld29nSUNBZ2FXWWdLQ0ZvWVhORGJHRjFaR1VvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklHWmhiSE5sTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuSUgwcE93b2dJQ0FnZDJGclpVSnlhV1JuWlNncE93b2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJSGRoYTJsdVp6b2dkSEoxWlNCOUtUc0tJQ0I5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNOb2RYUmtiM2R1SnlrZ2V3b2dJQ0FnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU0I5S1RzS0lDQWdJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdjSEp2WTJWemN5NWxlR2wwS0RBcExDQXlNREFwT3dvZ0lDQWdjbVYwZFhKdU93b2dJSDBLSUNBdkx5RHN0SWpxdUxEdG1aUWc0b0NVSU95ZHRDQlFRK3VsdkNBbjdJT0lJRkJESnlEc2c0SHRnNXpyb1p3ZzY1Q1k2NCtNNjZhdzY0dWtJQ2p0bEl6cm42enF0N2pzbmJnZ1creTBpT3E0c08yWmxGMGc2N0tFN1lxOEtTNEtJQ0F2THlEc25aSHJpN1hzbllRZzY2aTg3S0NBSU8yZG1PdWdwT3V6dE91Q3VDRHJrcVFnN0tDVjY2YXM3WldjNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc3BvbnNpNXdnN0tPOTdKZXM2NCtFSU8yYWpPeUxvT3lkZ0NEcmo0VHNzS250bFp6cmk2UXVDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM1Z1YVc1emRHRnNiQ2NwSUhzS0lDQWdJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJSEJzWVhSbWIzSnRPaUJ3Y205alpYTnpMbkJzWVhSbWIzSnRJSDBwT3dvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdDaUFnSUNBZ0lITm9kWFJrYjNkdVFuSnBaR2RsS0NrN0NpQWdJQ0FnSUdOdmJuTjBJSEpsYlc5MlpXUWdQU0IxYm1sdWMzUmhiR3hUWld4bUtDazdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiZDJGMFkyaGxjbDBnN0xTSTZyaXc3Wm1VS0hWdWFXNXpkR0ZzYkNrZzRvQ1VJT3lnbk9xeHNEb25MQ0J5WlcxdmRtVmtMbXB2YVc0b0p5d2dKeWtnZkh3Z0p5anNsNGJzbll3cEp5azdDaUFnSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwTENBeU1EQXBPd29nSUNBZ2ZTd2dNalV3S1RzS0lDQWdJSEpsZEhWeWJqc0tJQ0I5Q2lBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EUXNJSHNnWlhKeWIzSTZJQ2RPYjNRZ1ptOTFibVFuSUgwcE93cDlLVHNLQ2k4dklPeWR0T3V2dUNEcmxxQWc3SjZJN0p5ODY2bTBJT3loc095YXFlMmVpQ0Rzb29Ycm80d2dLT3lla091UG1TRHNpNXpzbnBFZ0t5QnVjRzBnWW5WcGJHUWc3S1NSNjdPMUlPeUxwTzJXaVNEcmpJRHJ1WVFwQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXdvZ0lHbG1JQ2hsSUNZbUlHVXVZMjlrWlNBOVBUMGdKMFZCUkVSU1NVNVZVMFVuS1NCd2NtOWpaWE56TG1WNGFYUW9NQ2s3Q2lBZ2NISnZZMlZ6Y3k1bGVHbDBLREVwT3dwOUtUc0tjMlZ5ZG1WeUxteHBjM1JsYmloUVQxSlVMQ0FuTVRJM0xqQXVNQzR4Snl3Z0tDa2dQVDRnZXdvZ0lHTnZibk52YkdVdWJHOW5LQ2RiZDJGMFkyaGxjbDBnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rxc0pEc2k1enNucEFnN0x5YzdLZVFJT0tBbENCb2RIUndPaTh2Ykc5allXeG9iM04wT2ljZ0t5QlFUMUpVS1RzS2ZTazdDZz09JwpCNjRfRVhBTVBMRVM9J0l5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzcElUc25ZUWc2N0NVNnI2NDZyT2dJT3lMdHV5Y3ZPdXB0Q0JnSUM4Z1lDQW83SldlNjVLa0lPcXp0ZXV3c1NEdGo2enRsYWdnN0lxczY1Nlk3SXVjS1NvcUlPdWhuQ0R0a1p6c2k1enRsWmpzaExqc21wUXVJTzJVak91ZnJPcTN1T3lkdU95WGtPeUVuQ0Rya1pBZzdLU0U2NkdjSU91enRPeVhyT3lua2V1TGlPdUxwQzRLTFNEc2dxenNtcW5zbnBEcXNJQWc3SjZGNjZDbDdaV2NJT3VzdU9xMXJPcXdnQ0JnN0p1UTY3TzRZT3F6dkNBbzZyTzE2N0N4d3JmcnJManNucVhydG9EdG1MZ2c2NnkwN0l1YzdaV1k2ck9nS1NEcXNKbnFzYkRyZ3Bnc0lPeUVuT3VobkNEdGo2enRsYWp0bFpqcnFiUWc2cmU0SU95MmxPeXluT3lWaU91VHBPeWRoQ0RyczdUc2w2enNwSTNyaTRqcmk2UXVDaTBnNjZlazdMbXQ3WldnSU91VmpDQXFLdXVuaU95S3BPMkN1ZXVRbkNEc25iVHJwb1FvN1ptTlhDcnJqNWtwTENEc2lLdnNucEFvN0tDRTdabVU2N0tJN1ppNHdyY2k3Sm00SURMcnFvVWlJT3VUc1NucmlwUWc2NnkwN0l1Y0tpcnRsYW5yaTRqcmk2UWc0b0NVSU95ZHRPdW1oTUszN0lpWTY1K0p3cmZyc29qdG1ManJwNHdnNjR1azY2VzRJT3VzdU9xMXJPdVBoQ0Rxc0puc25ZQWc3SmlJN0l1YzY2R2NJT3llb2UyWWdPeWFsQzRnNjR1b0xDRHN0cFRzc3B6c2xZanNsNUFnN0tDQjdKYTA2NUdVSU95ZHRPdW1oTUszN0lpcjdKNlE2NHFVSU9xM3VPdU1nT3VobkNEcmdwanNtS1RyaTRnZzdJdWs3S0NjSU9xd2t1eVhrQ0RycDU3cXNvd2c2ck9nN0xPUUlPeVRzT3lFdU95YWxDNEtMU0Rzb0p6cnFxa29ZQ01qWUNucXM3d2dZQ01qSTJBc0lHQXRZQ0RxdUxEdG1ManJpcFFnN1ppVjdJdWQ3SjIwNjR1SUlPdXdsT3ErdU95bmdDRHJwNGpzaExqc21wUXVDZ29qSXlEc2lxVHRnNERzbmJ3ZzdKdVE3TG1aSUNqc3NManFzNkFnNG9DVUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZQWdkWGd0ZDNKcGRHbHVaeTV0WkNEcXNJRHNuYlRyazV3cENnb3RJTzJWdE95YWxPeXl0Q3dnNjdhQTY1T2M2NStzN0pxMElPeWloZXF5c0NoZ2Z1eWVpT3lXdE95YWxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrS0xTRHFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NBbzdLQ0U3SWFoNG9hUzY3TzA2NEswNjR1a0tTd2c2N2FBN0tDVklPeURnZTJacWV1UGhDRHJsTEhybExIdGxaanNwNEFnN0pXSzZyS01LQ0xzc0w3cXVMQWc3SXVrN1l5b0l1S2RqQ0FpN0xDKzdKMkVJT3lJbUNEc2w0YnNsclRzbXBRaTRweUZLUW9LSXlNZzdMYVU3TEtjSU95WWlPeUxuQW9LSXlNaklPeW5oTzJXaWUyVm1PdU5tQ0RzbnBIc2w0WHNuYlFnN0o2STdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3S2VFN1phSklPeWtrZXlkdUNEcmdyVHNsNjNzbmJRZzdKNkk3SmEwN0pxVUxpQXZJT3lkdE95V3RPeUVuQ0RzcDRUdGxvbnRsYURxdVl6c21wUS9DZ29qSXlNZzZyTzE3SnlnSU95YWxPeXlyZXlkaENEc3Q2anNob3p0bFpqcnFiUWc3SnFVN0xLdElPdUN0T3lYcmV5ZHRDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTNxT3lHak8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHN0NmpzaG96dGxhQWc2cks5N0pxd0lPeWFsT3l5clNEcmdyVHNsNjNyajRRZzdJS3Q3S0NjNjQrODdKcVVMaUF2SU9xenRleWNvQ0RzbXBUc3NxM3NuWVFnN0xlbzdJYU03WldnNnJtTTdKcVVQd29LSXlNaklPcTRzT3E0c091bHZDRHNzTDdzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXWTdJUzQ3SnFVTGdvdElPcTRzT3E0c091bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaV1k2cml3SU95Z2hPeVhrT3VLbENEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQTdKNkY3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDaTBnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxnb0tJeU1qSU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c3Sm00SURMcnFvWHNsNURxc293ZzZyYU03WldjSU95Q3JleWduQ0RzbFl6cnByenRocUhzbllRZzdLQ0U3SWFoN1pXZzZybU03SnFVUHdvdElPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdE91Z3BPcXpvQ0R0bGJUc21wUXVJQzhnN1ptTkt1dVBtU2d3TVRBdE1USXpOQzAxTmpjNEtTRHJpNWdnN0ptNElETHJxb1hzbDVEcXNvd2c2N08wNjRLODZybU03SnFVUHdvdElPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnNjR1WUlPeVp1Q0F5NjZxRjdKZVE2cktNSU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN2T3E1ak95YWxEOEtMU0RxdG96dGxad2c3SUt0N0tDY0lPeVZqT3Vtdk8yR29leWRoQ0R0bVkwcTY0K1pLREF4TUMweE1qTTBMVFUyTnpncElPdUxtQ0RzbWJnZ011dXFoZXlYa09xeWpDRHJzN1RyZ3J6cXVZenNtcFEvQ2dvakl5TWpJTzJabGV5ZHVNSzM2ckt3N0tDVklPMk1uZXlYaFFvS0l5TWpJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeUNyZXlnbk91UW5DRHJqYkRzbmJUdGhMRHJpcFFnNjdPMTZyV3M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHJrSmpyajR6cnByUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNvSlhycDVBZzdJS3Q3S0NjN1pXZzZybU03SnFVUHdvS0l5TWpJT3V6Z09xeXZleUNyTzJWcmV5ZHRDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdKV1k3SXExNjR1STY0dWtMaURyZ3BqcXNJRHNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SldFN0tlQklPeWdnT3llcGUyVm1PeW5nQ0RzbFlyc25ZQWc2NEswN0pxcDdKMjBJT3llaU95V3RPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpyajd6c21wUXVJQzhnN0xTSTZyaXc3Wm1VN1pXZzZybU03SnFVUHdvS0l5TWpJeURzbDVEcm42ekN0K3lMcE8yTXFBb0tJeU1qSU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU91RXBPMkt1T3liak8yQnJPeVhrQ0RzbDdEcXNyRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzbDdEcXNyQWc3SU9CN1lPYzY2VzhJTzJabGV5ZHVPMlZtT3F6b0NEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPdXduT3lEbmUyV2lPeUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU95RG5lcXl2T3lXdE95YWxDNGdMeURzbnFEc2k1d2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWaE95ZHRPdVVsQ0RybUpEcmlwUWc2N21FNjdDQTY3S0k3Wmk0NnJDQUlPeWR2T3k1bU8yVm1PeW5nQ0RzbFlyc2lyWHJpNGpyaTZRdUNpMGc3SldFN0oyMDY1U1VJT3VZa091S2xDRHJ1WVRyc0lEcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDNyc29qdG1ManFzSUFnN0oyODdMbVk3WldZN0tlQUlPeVZpdXlLdGV1TGlPdUxwQzRLTFNEc25ianNwcDNyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3kwaU9xenZPdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKMjQ3S2FkNjdLSTdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnN0plRjY2R2M2NU9jN0plUUlPeUxwTzJNcU8yV2lPeUt0ZXVMaU91THBDNEtMU0R0akl6c25ienNuWVFnN0ppczY2YXM3S2VBSU91cXUrMldpT3lXdE95YWxDNGdMeURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3S0NRNnJLQUlPeWtrZXllaGV1TGlPdUxwQzRnN0oyMDdKcXA3SmVRSU91MmlPMk91T3lkaENEcms1enJvS1FnN0tPRTdJYWg3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEc2hKenJ1WVRzaXFUcnBid2c3S0NRNnJLQTdaV1k2ck9nSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSkRxc29Ec25iUWc2NEdkNjRLWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bFlUc2lKZ2c3SjZGNjZDbElPMlZyZXVxcWV5ZWhldUxpT3VMcEM0S0xTRHF2SzBnN0o2RjY2Q2w3WlcwN0pXOElPMlZtT3VLbENEdGxhM3JxcW5zbmJUc2w1RHNtcFF1Q2dvakl5TWpJT3Eyak8yVm5NSzM3SVNrN0tDVkNnb2pJeU1nN0xtMDY2bVU2NTI4SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdJcTE2NHVJNjR1a0xpRHNoS1Rzb0pYc2w1RHNoSndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU95THJleUxuT3lZcEM0S0xTRHN1YlRycVpUcm5id2c2cmFNN1pXYzdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0xtMDY2bVU2NTI4SU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmpPdW12Q0RxdG96dGxaenNuYlFnNnJHdzY3YUE2NUNZN0phMElPeVZqT3Vtdk95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHNsWXpycHJ3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PdXB0Q0RzaG96c2k1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUlDOGc3SVNrN0tDVjdKZVE3SVNjSU95VmpPdW12T3lkaENEc3ZKd2c3S084N0lTNDdKcVVMZ29LSXlNaklPeWNoT3k1bUNEc29KWHJzN1FnN0oyMDdKcXA3SmVRSU91UG1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyb1ozc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdVRzZXVobmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWc3SUt0N0tDYzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeUNyZXlnbk8yV2lPeVd0T3lhbEM0S0NpTWpJeUR0Z2JUcnByM3JzN1RyazV6c2w1QWc2N08xN0lLczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0ZXlDck8yV2lPeVd0T3lhbEM0S0NpTWpJeURzbXBUc3NxM3NuWVFnN0xLWTY2YXNJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKcVU3TEt0N0oyRUlPeXltT3Vtck8yVm1PcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPeVZpT3VDdE1LMzdKeWc2NCtFQ2dvakl5TWc3SU9JNjZHYzdKcTBJT3V5aE95Z2hPeWR0Q0RzdHB6c2k1enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlPeVhoZXVOc095ZHRPMkt1Q0R0bTRRZzdKMjA3SnFwSU9xd2dPdUtwZTJWcWV1TGlPdUxwQzRLTFNEc2c0Z2c2N0tFN0tDRTdKMjBJT3VDbU95WmxPeVd0T3lhbEM0Z0x5RHNsNFhyamJEc25iVHRpcmp0bFpqcnFiUWc3SU9JSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0oyMDdKcXA3SjJFSU95Y2hPMlZ0Q0RzbGIzcXRJQWc2NCtaN0oyWTZyQ0FJTzJWaE95YWxPMlZxZXVMaU91THBDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzaTV6c25wSHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25xWHNpNXpxc0lRZzY2KzQ3SUtzN0pxcDdKeTg2NkdjSU95ZWtPdVBtU0Ryb1p6cXQ3anNsWVRzbTRNZzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3lZcE91ZXErdVBtZXlWaUNEc2dxenNtcW50bFpqc3A0QWc3SldLN0pXRUlPdWhuT3EzdU95VmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyaTRqcmk2UXVJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbllRZzdabVY3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3E0c09xNHNPcXdnQ0RyaEtUdGlyanNtNHp0Z2F6c2w1QWc3SmV3NnJLdzY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJpdzZyaXc3SjJZSU95WHNPcXlzQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbUlIc2c0SHNuWVFnNjdhSTY1K3M3SmlrNjRxVUlPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0ppQjdJT0I3SjJFSU91MmlPdWZyT3lZcE9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3kzcU95R2pPMlZtT3lMcENEcXNyM3NtckFnN0l1ZzdMS3Q3WldZN0l1Z0lPdUN0T3lhcWV5ZGdDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdJcTE2NHVJNjR1a0xnb3RJT3kzcU95R2pPMlZtT3VwdENEc2k2RHNzcTN0bFp3ZzY0SzA3SnFwN0oyMElPeWdnT3llcGV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvQ2kwZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvSUM4ZzdMZW83SWFNN1pXWTY2bTBJT3llaGV1Z3BlMlZuQ0RyZ3JUc21xbnNuYlFnN0lLczY1Mjg3S0M0N0pxVUxnb0tJeU1qSXlEcXNJRHNuYlRyazV3ZzdKaUk3SXVjSUNoMWVDMTNjbWwwYVc1bkxtMWs3SmVRN0lTY0lPeVlydXE1Z0NEaWdKUWc2cmVjN0xtWjdKeTg2NkdjSU95ZWtPdVBtZTJabENEcnFyc2c3WldZNjRxVUlPdXN1T3llcFNEc25xenF0YXpzaExFZzdJS3M2NkdBS1FvS0l5TWpJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxczZBZzZyT0U3SXVjNjRLWTdKcVVQd290SU95ZWtPdVBtZXl3cU9xd2dDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUxnb3RJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFF1Q2dvakl5TWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVMZ290SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQzRLQ2lNakl5RHF1SWpzbmJ6cXVZenNwNEFnNjYrNDY0S3BJT3lMbkNEc2w3RHNzclFnN0xLWTY2YXM2NUNwNjR1STY0dWtMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUNxZXUyZ08yVm1PeUxuT3E0c0NEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUF2SU8yYmhPdTJpT3F5c095Z25DRHF1SWpzbGFIc25ZUWc2NEswN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lna09xeWdDRHF1TERxc0lUc2w1RHJpcFFnN0lTYzY3bUU3SXFrSU95ZHRPeWFxZXlkdENEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUxvT3UyaE95bW5TRHRtWlhzbmJnZzdLQ0U3SmVRNjRxVUlPeUdvZXE0aUNEcnNJOGc2ckt3N0tDYzZyQ0FJT3UyaU9xd2dPMlZxZXVMaU91THBDNEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPdXpnT3F5dlNEc2k1d2c3THFRN0l1YzY3Q3hJT3llck95bmdPcTRpZXlkZ0NEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNnNEhyaTdRZzdaS0k3S2VJSU8yV3BleURnZXlkaENEc25JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhbEM0S0NpTWpJeU1nNnJPRTdLQ1Z3cmZzbm9Ycm9LVUtDaU1qSXlEc2xZVHNuYlRybEpRZzY1aVE2NHFVSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWR0T3lEZ1NEc25wanJxcnNnN0o2RjY2Q2w3WldZN0plc0lPcXpoT3lnbGV5ZHRDRHNucURxdUlnZzdMS1k2NmFzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWVtT3VxdXlEc25vWHJvS1h0bGJUc2hKd2c2ck9FN0tDVjdKMjBJT3llb09xeXZPeVd0T3lhbEM0Z0x5RHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzdKNnM3SVNrN0tDVjdaV1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25iVHJyN2dnN0lLczdKcXBJT3lra2V5ZHVDRHNsWVRzbmJUcmxKVHNub1hyaTRqcmk2UXVDaTBnN0oyMDY2KzRJT3lUc09xem9DRHNub2pyaXBRZzdKV0U3SjIwNjVTVTdKaUk3SnFVTGlBdklPdUxwT3VsdUNEc2xZVHNuYlRybEpUcnBid2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNncXpzbXFudGxhQWc3SWlZSU95WGh1dUtsQ0RydVlUcnNJRHJzb2p0bUxqc25vWHJpNGpyaTZRdUlPeVlnZXVzdUN3ZzdJaXI3SjZRTENEdGlybnNpSmpyckxqc25wRHJwYndnN1krczdaV283WldZN0plc0lEanNucEFnN0oyMDdJT0JJT3llaGV1Z3BlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc21JSHJyTGdzSU95SXEreWVrQ3dnN1lxNTdJaVk2Nnk0N0o2UTY2VzhJTzJQck8yVnFPMlZ0Q0E0N0o2UUlPeWR0T3lEZ1NEc25vWHJvS1h0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95ZWhldWdwU0Rxc0lEcmlxWHRsWndnNnJpQTdKNlFJT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzdKNkY2NkNsN1pXZ0lPeUltQ0Rzbm9qcmlwUWc2cmlBN0o2UUlPeUltT3VsdkNEcmhKanNsNGpzbHJUc21wUXVJQzhnNjRLMDdKcXA3SjJFSU95aHNPcTRpQ0RzcElUc2w2d2c3S084N0lTNDdKcVVMZ29LSXlNakl5RHRqSXpzbmJ6Q3QrcXlzT3lnbk1LMzZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzaUpqcmk2anNuWVFnN1ptVjdKMjQ3WldZNnJPZ0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WldZN0plc0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xenRlcXdoT3lkaENEdG1aWHJzN1R0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BDRHNwSURydVlRZzdLU1I3SjZGNjR1STY0dWtMZ290SU95a2dPdTVoTzJWbU9xem9DRHNub2pyaXBRZzZyaXc2NHFsN0oyMDdKZVE3SnFVTGlBdklPeWhzT3E0aU91bmpDRHF1TERyaTZUcm9LUWc3S084N0lTNDdKcVVMZ29LSXlNaklPdVRzZXVoblNEcXNJRHJpcVh0bFp3ZzdMV2M2NHlBSU9xd25PeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnNjQyVUlPdVRzZXVobmUyVm1PdWdwT3VwdENEcXVMRHNvYlFnN1pXdDY2cXA3SjJFSU95Q3JleWduTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095MmxPcXdnQ2tLQ2lNakl5RHN0cHpyajVrZzdKcVU3TEt0N0oyMElPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0xhYzY0K1pJT3lhbE95eXJleWRoQ0Rzb0pIc2lKanRsb2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLOTY3bUVJT3lEZ2UyRG5PdWx2Q0R0bVpYc25ianRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPcXl2ZXU1aENEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3SUNqc2w0YnNsclRzbXBRZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUXBDZ29qSXlNZzY3TzQ3SjI0SU95ZHVPeW1uZXlkaENEdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0Ryczdqc25iZ2c3SjI0N0thZDdKMkVJTzJWbU91cHRDRHJxcWpyazZBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95ZHRPdXBsT3lkdkNEc25ianNwcDBnN0tDRTdKZVE2NHFVSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lkdE91cGxPeWR2Q0RzbmJqc3BwM3NuWVFnNjZlSTdMbVk2Nm0wSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3kvb08yUHNPeWRnQ0Ryb1p6cXQ3anNuYmdnN1p1RTdKZVE2NmVNSU95Q3JPeWFxU0Rxc0lEcmlxWHRsYW5yaTRqcmk2UXVDaTBnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3kvb08yUHNPeWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJyN2pzaExIcmhZVHNucERyaXBRZzY3TzA3Wmk0N0o2UUlPdVBtZXlkbUNEc2w0YnNuYlFnNnJLdzdLQ2M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzY3TzA3Wmk0N0o2UTZyQ0FJT3VQbWV5ZG1PMlZtT3VwdENEcXNyRHNvSnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsSVRyb1p6dGxZVHNuWVFnNjVPeDY2R2Q3WldZN0tlQUlPeVZpdXljdk91cHRDRHNuYlRzbXFuc25iUWc3S0NjN1pXYzY1Q3A2NHVJNjR1a0xnb3RJTzJVaE91aG5PMlZoT3lkaENEcms3SHJvWjN0bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2xiRWc2N0tFN0tDRTdKMjBJT3VDcnV5VmhDRHNuYnpydG9BZzZyaXc2NHFsN0oyMElPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVobmV1UW1PeW5nQ0RzbFlyc2xZUWc3SUtzN0pxcDdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0xhYzdKNkZJT3k1dE91VG5PdWx2Q0RyazdIcm9aM3RsWmpycWJRZzY3Q1U2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3SUNqc21ZVHJvNHdnN0pXSTY0SzBLUW9LSXlNaklPMmFqT3lia09xd2dPeWVoZXlkdENEc21ZVHJvNHpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNnJDQTdKNkY3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEc21JanNsYjNzbmJRZzdMZW83SWFNNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95WWlPeVZ2ZXlkaENEc3Q2anNob3p0bG9qc2xyVHNtcFF1Q2dvakl5TWc2Nnk0N0oyWTZyQ0FJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdJaWM3TENvN0tDQjdKeTg2NkdjSU91THRldXpnT3VUbk91bXJPcXlvT3lLdGV1TGlPdUxwQzRLTFNEcnJManNuWmpycGJ3ZzdLQ1I3SWlZN1phSTdKYTA3SnFVTGlBdklPeUluT3lFbk91TWdPdWhuQ0RyaTdYcnM0RHJrNXpycHJUcXNvenNtcFF1Q2dvakl5TWc3SVNrN0tDVjdKMjBJT3kwaU9xNHNPMlpsT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzaEtUc29KWHNuWVFnN0xTSTZyaXc3Wm1VN1phSTdKYTA3SnFVTGdvS0l5TWpJT3U1aE91d2dPdXlpTzJZdU9xd2dDRHJzNERxc3IzcmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SU91d2xPcS9xT3lXdE95YWxDNEtDaU1qSXlEc25ianNwcDNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHVPeW1uZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNaklPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUWdLT3luaU91c3VDRHNucXpxdGF6c2hMRXBDZ29qSXlNZzdKYTQ3S0NjSU91d3FldXN1TzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEcnNLbnJyTGdnNjRLZzdLZWM2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0phMDY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RycDR6cm80enJvWndnN0oyMDdKcXA3SjIwSU95a2tleW5nT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzbmJUc21xa2c2cml3NnJDRTdKMjBJT3VCbmV1Q21PeUVuQ0RzcDREcXVJanNuWUFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SnFwNjUrSklPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0lEc25xWHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lnZ095ZXBlMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVDZ29qSXlNZzdZYTE3SXVnSU95WXBPdWxtT3VobkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXWTdKaUE3SXExNjR1STY0dWtMZ290SU8yR3RleUxvT3lkdENEc201RHRtWnp0bFpqc3A0QWc3SldLN0pXRUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0pIcXQ3enNuYlFnNnJHdzY3YUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0phMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RxdG96dGxaenNuWVFnN0pxVTdMS3Q3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nN0lPQjdabXBJT3lWaU91Q3RDQW9NdXVMcUNEcXRhenNvYkFwQ2dvakl5TWc3SjZGNjZDbDdaV1k3SXVnSU95anZPeUdqT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnNjR1azdJdWNJTzJabGV5ZHVDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdLTzg3SWFNNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU91THBPeUxuQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lhbE95eXJlMlZtT3lMb0NEdGpwanNuYlRzcDREcnBid2c3TEMrN0oyRUlPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3WTZZN0oyMDdLZUE2Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEdGc0anRoN1R0bFpqcnFiUWc2NnFvNjVPZ0lPdU5zT3lkdE8yRXNPcXdnQ0RzZ3Ezc29KenJrSmpxczZBZzY0dWs3SXVjSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95Z2xldW5rQ0R0ZzRqdGg3VHRsYURxdVl6c21wUS9DZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeURnZTJacVNEc2xZanJnclFwQ2dvakl5TWc2N2FBN0o2c0lPeWtrU0Ryc0tucnJManNucERxc0lBZzZyQ1E3S2VBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91MmdPeWVyQ0RzcEpIc2w1QWc2N0NwNjZ5NDdKNlE2ckNBSU95ZWlPeVhpT3lXdE95YWxDNGdMeURzbUlIc2c0SHNuWVFnN1ptVjdKMjQ3WlcwSU91enRPeUV1T3lhbEM0S0NpTWpJeURxc3IzcnVZUWc3WlcwN0tDY0lPcTJqTzJWbk95ZHRDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZySzk2N21FSU8yVnRPeWduQ0RxdG96dGxaenNuYlFnN1pXRTdKcVU3WlcwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHNtcFRzc3EzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPMlpsT3llckNEcXNKRHNwNERxdUxBZzY3Q3c3WVN3NjZhczZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNEtMU0R0bVpUc25xd2c2ckNRN0tlQTZyaXdJT3V3c08yRXNPdW1yT3F3Z0NEc2xyenJwNGdnN0plRzdKYTA3SnFVTGlBdklPdXdzTzJFc091bXJPdWx2Q0RxdFpEc3NyVHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzdHBYc2xiMGdLeURxdUkzc29KVWc3S0NFN1ptWUlDanJrWkFnNjZ5NDdKNmxJT0tHa2lEcXVJM3NvSlh0bUpVZzdaV2NJT3VzdU95ZXBTa0tDaU1qSXlEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVUHlEc2xZenJwcnpzbllRZzdMeWM3S2VBSU95Vml1eWN2T3VwdENEc3BKSHNtcFR0bFp3ZzdJYU03SXVkN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU95VmpPdW12T3lkaENEc3ZKenJxYlFnN0tTUjdKcVU3WldjSU95R2pPeUxuZXlkaENEcnNKVHJvWndnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0o2UTY0K1o3SjIwN0xLMDY2VzhJT3VUc2V1aG5lMlZtT3luZ0NEc2xZcnFzNkFnNjRTWTdKYTA2ckNJNnJtTTdKcVVQeURyazdIcm9aM3RsWmpzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc25wRHJqNW5zbmJUc3NyVHJwYndnNjVPeDY2R2Q3WldZNjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJzN2dnNnJPRTdKVzk3SjJZSU95Y29PeWR2TzJWbkNEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3lkdk91d21PcTBnT3Vtck95ZWtPdWhuQ0RxdG96dGxaenJzNERxc3Izc25ZUWc3WldZN0l1a0lPeUltQ0RzbDRic2xyVHNtcFF1SU95ZHZPdXdtQ0RxdElEcnBxenNucERyb1p3ZzZyYU03WldjSU91emdPcXl2ZXlkaENEc201RHRsWmpzaTZRZzZySzk3SnF3SU91THBPdWx1Q0RzZ3F6cm5venNsNURxc293ZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtDRHF0b3p0bFp6c25ZUWc3S2VBN0tDVjdaVzBJT3lqdk95TG9DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZuQ0Rya3FRZzdKMjg2N0NZSU9xMGdPdW1yT3lla091aG5DRHJzNERxc3IzdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXpnT3F5dmUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvPScKQjY0X0dVSURFPSdJeUJWV0NCWGNtbDBhVzVuSU9xd2dPeWR0T3VUbkFvS0l5TWdNUzRnN1pXMDdKcVU3TEswQ2dyc29KenRrb2dnN0pXSTdKMllJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWdKKzJWdE95YWxPeXl0Q2Zyb1p3ZzdJMm83SnFVTGdyc25ienF0SURzaExFZzdKNkk2NHFVSU95Q3JPeWFxZXlla0NEcXNyM3RsNWpzbllRZzY2ZU02NU9rSU95SW1DRHNub2pyajRUcm9aMGdLaXJzZzRIdG1ha3NJT3VucGV1ZHZleWRoQ0RydG9qcnJManRsWmpxczZBZzY2cW82NU9nSU91c3VPcTFyT3lYa0NEdGxiVHNtcFRzc3JUcnBid2c3S0NCN0pxcDdaVzA3S084N0lTNDdKcVVMaW9xQ2dyc21JZ3BDaTBnNjdPMDY0T0Y2NHVJNjR1a0lPS0draURyczdUcmdyenFzb3pzbXBRS0Npb3FLZ29LSXlNZ01pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzQW9LN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RzdFp6cmpJRHRsWndnS2lycmlxWHJqNW50bUpVZzY2eTQ3SjZsS2lyc25ZUWc3STJvN0tPODdJUzQ3SnFVTGlEc2lKanJqNW50bUpVZzY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRFdDdJaVk2NCtaN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2s3RHJpcFFnNnJLTUlPeWlpK3lWaE95YWxDNEtDaU1qSXlEcmtKRHNsclRzbXBRZzRvYVNJTzJXaU95V3RPeWFsQW9LN0ppSUtRb3RJT3lFcE95Z2xldVFrT3lXdE95YWxDRGlocElnN0lTazdLQ1Y3WmFJN0phMDdKcVVDZ29qSXlNZ0ozN3NsNGduSU91NXZPcTRzQW9LN0ppSUtRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVUNnb2pJeU1nNjQrWjdJS3NJT3V3bE9xL2xPeVRzT3E0c0FvSzdKaUlLUW90SU91R2t1eVZoT3loak95V3RPeWFsQ0RpaHBJZzdKaXM2NTZRN0phMDdKcVVDZ29xS2lvS0NpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBS0N1eWduTzJTaUNEc2xZanNsNURzaEp3ZzY3YUE3S0NWN0tDQklPeTdwT3V1cE91TGlPeThnT3lkdE95Rm1PeWRoQ0RzdFp6cmpJRHRsWndnN0tTRTdKMjA2ck9nSU9xNGpleWdsZTJZbFNEcnJManNucVhzbllRZzdJMm83S084N0lTNDdKcVVMZ3JydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVE10NjdhQTdLQ1Y3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzamFqc21wUXVDZ3JzbUlnZ09pRHNsWWdnNjQrODdKcVVMQ0RzbDRic2xyVHNtcFFnS0ZncElPS0draUIrN1pXWTY2bTBJTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVJQ2hQS1FvS0l5TWpJT3lYaHV5V3RPeWFsQ0RpaHBJZzdKNkk3SmEwN0pxVUNncnNtSWdwQ2kwZzY3TzA3Wmk0N0o2UTZyQ0FJTzJYaU91ZHZlMlZtT3E0c0NEc29JVHNsNURyaXBRZzZyQ0E3SjZGN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFFnNG9hU0lPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFLQ2lNakl5RHNsNURybjZ3ZzY2bVU3SXVjN0tlQUNncnNsNURybjZ3ZzdJT0I3Wm1wN0plUTdJU2M2NCtFSUNMdGxiVHFzckFnNjdDcDY3S1ZJdXlkaENEcnFMenNvSUFnN0pXTTY2Q2s3S084NjRxVUlPcTRqZXlnbGUyWWxTRHF0YXpzb2JEcm9ad2c3STJvN0pxVUxnb0s3SmlJS1FvdElPeW5nT3E0aUNEcnNvVHNvSVRzbDVEc2hKenJpcFFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95VnNleWRoQ0RzdFp6c2k2QWc2N0tFN0tDRTdKeTg2NkdjSU95WGhldU5zT3lkdE8yS3VDRHRsYlRzbzd6c2hManNtcFF1SU9LR2tpRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwN0tPODdJUzQ3SnFVTGlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDam82T2lCMGFYQWc3WXlkN0plRklPdXloTzJLdk95ZGdDQmJPQzRnN1l5ZDdKZUZYU0RxdDV6c3VabnNuWVFnNjVTdzY1Mjg3SnFVQ3UyTW5leVhoU2pyaTZUc25iVHNscnpyb1p6cXQ3Z3BJT3V5aE8yS3ZDRHJyTGpxdGF6cmlwUWc3SldFNjU2WUlDb3FPQzRnN1l5ZDdKZUZLaW9nN0lTNTdJV1lJT3Ezbk95NW1leWRoQ0RybExEcm5ienNtcFFnNG9DVUlPMkd0ZXV6dE91S2xDQmI3Wm1WN0oyNFhTd2c3SmlJTCt5VmhPdUxpT3lZcENEdGpKRHJpNmpzbllBZ1creVZoT3VMaU95WXBGM0N0MXZyaEtSZExDRHJqNW5zbnBFZzdKeWc2NCtFNjRxVUlGdnN0NmpzaG94ZHdyZGI2NCtaN0o2UlhTNGdJdXkzcU95R2pDTHJpcFFnNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUlPeVRzT3F6b0N3Z0l1dUxxK3E0c0NEQ3R5RHJqNW5zbnBFaTdMS1k2NSs4SU95bm5leWR0Q0RzbFlnZzY2ZWU2NHFVSU95aHNPMlZxZXlkZ0NEc2s3RHNwNEFnN0pXSzdKV0U3SnFVTGdvNk9qb0tDaU1qSXlEdG1KenRnNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzbllRZzY1V01DZ3JzbUlncENpMGc2NnFvN0o2RTdLZUE3SnVRNnJpSUlPeVhodXlkdENEcnFxanNub1R0aHJYc25xWHNuWVFnNjZlTTY1T2s2cm1NN0pxVVB5RHNwNERxdUlnZzY3Q2I3S2VBSU95Vml1eWN2T3VwdENEcnFxanNub1RzcDREc201RHF1SWpzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVJT0tHa2lEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bUp6dGc1MGc2NHlBN0lPQklPeVZpT3VDdEFvS0tpcnNoSnpydVlUc2lxVHJpcFFnN0pPNElPeUltQ0Rzbm9qc3A0RHJwNHdzSU8yS3VleWdsU0R0bUp6dGc1M3NuWUFnNjdDYjdKMkVJT3lJbUNEc2w0YnNuWVFnNjVXTUlPS0draURxdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPeU5xT3lhbEM0cUtncnNncXpzbXFuc25wRHJpcFFnNjZ5NDZyV3M2Nlc4SU9xOHZPcTh2TzJlaUNEc25iM3NwNEFnN0pXSzZyT2dJTzJia2V5V3RPdXp0T3E0c0Nqc2lxVHN1cFFwSU91VmpPdXN1T3lYa0N3ZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU95VHNPdXB0Q0Rzb0p6dGtvZ2c3S0NFN0xLMDY2VzhJT3lUdUNEc2lKZ2c3SmVHNjR1azZyT2dJT3lZcE8yVnRPMlZtT3E0c0NEc2lhenNtNHpzbXBRdUNncnNtSWdwQ2kwZzZyT0U3S0tNSU9xd25PeUVwQ0R0bUp6dGc1M3NuWUFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUlPS0draUEwTGpVbElPcTRpT3VtckNEdG1KenRnNTNycDR3ZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29xS2lvS0NpTWpJRFF1SU95NmtPeWp2T3lXdk8yVm5DRHFzcjNzbHJRS0N1eWduTzJTaUNEc2xZanNsNURzaEp3Z0ozN3NpNXpxc3FEc2xyVHNtcFEvSnl3Z0oreUxuT3VDbU95YWxEOG5MQ0FuZnVxN21DY2c2ckNaN0oyQUlPcXp2T3VQaE8yVm5DRHFzcjNzbHJUcnBid2c3Sk93N0tlQUlPeVZpdXlWaE95YWxDNEs3TFdjNjR5QTdaV2NJT3k2a095anZPeVd2TzJWbU9xem9DRHN1WnpxdDd6dGxad2c2NmVRN1lpczY2VzhJT3lUc091S2xDRHFzb3dnN0tLTDdKV0U3SnFVTGdycXNyM3NsclRyaXBRZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TWkzcXNyM3NsclRycGJ3dDdJMm82NCtFTGV1UW1PdUtsQzNxc3Izc21yQXA3SmVRSU8yVnRPdUx1ZTJWb0NEcmxZenJwNHdnN0kybzdKcVVMZ29LSXlNaklPdVBtZXlDck95WGtPeUVuQ0FuZnV5TG5DY2c2N204NnJpd0NncnNtSWdwQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm1PeUxuT3F5b095V3RPeWFsRDhnNG9hU0lPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxhRHF1WXpzbXBRL0NpMGc3SXVjN0o2UjdaV1k3SXVjNjRxVUlPdTJoT3lYa09xeWpDQTFMREF3TU95YmtPeWRoQ0RyazV6cm9LVHNtcFF1SU9LR2tpRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSUNmcXM0VHNpNXpyaTZRbklPS0draUFuN0o2STY0dWtKd29LN0ppSUtRb3RJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxczZBZzZyT0U3SXVjNjRLWTdKcVVQeURpaHBJZzdKNlE2NCtaN0xDbzZyQ0FJT3llaU91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NSU95V3ZPdW5pT3lVcVNEcmdyVHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB5RGlocElnNjZlazY0dXNJT3V6dE8yWG1PdWpqT3VLbENEc2xyenJwNGpzbmJqcXNJRHNtcFEvSUNvbzY0dW83SWljSU95NW1PMlptT3lkdENEc2xZVHJpNGpybmJ3ZzY2eTQ3SjZsN0oyRUlPeURpT3VobkNEc2s3UWc3SUtzNjZHQTdKaUk3SnFVS1NvS0NpTWpJeUFuN0plczdLMkk2NHVrSnlEaWhwSWdKKzJabGV5ZHVPMlZtT3VMcEN3ZzY2eTc2NHVrSndvSzdKaUlLUW90SU95VmlPeWdoTzJWbkNEcXNKenRoclhzbllRZzdKeUU3WlcwSU91cWgrcXdnT3luZ0NEcmk2VHNpNXdnN0plczdLMms2N084NnJLTTdKcVVMaURpaHBJZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUg2ckNBN0tlQUlPdUxwT3lMbkNEdG1aWHNuYmp0bGFEcXNvenNtcFF1Q2dvakl5TWdKK3E3bUNjZzRvYVNJQ2ZzbDVEcXNvd25DZ3JzbUlncENpMGc3Wm1ONnJpNDY0K1o2NHVZNnJ1WUlPdUNvT3lWaE9xd2dPcXpvQ0Rzbm9qc2xyVHNtcFF1SU9LR2tpRHRtWTNxdUxqcmo1bnJpNWpzbDVEcXNvd2c2NEtnN0pXRTZyQ0E2ck9nSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURxc3Izc2xyVHJwYndnNjdxUTdKMkVJT3VWakNEc2xyVHNnNG50bFp3ZzZySzk3SnF3Q2dyc2dxenNtcW5zbnBEc25aZ2c3S0NWNjdPMDY2VzhJT3V3bSt1S2xDRHNwNGpyckxqc2w1RHNoSndnNnJpdzZyT0U3S0NCN0p5ODY2R2NJQ2QrN0l1Y0ordWx2Q0RydXBEc25ZUWc2NVdNSU91c3VPeWVwZXlkdENEc2xyVHNnNG50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLS2lydGpJenNsWVh0bFpqcXM2QWc3SXUyN0oyQUlPeWdsZXV6dE91bHZDQW43S084N0phMEordWhuQ0RzamFqc2hKd2c2Nnk0N0o2bDdKMkVJT3lEaU91aHJlcXlqQ0RzamFqcnM3VHNoTGpzbXBRdUtpb0tDdXlZaUNrS0xTRHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VNZ095Mm5DRHJxcW5zb0lIc25iUWc2NnkwN0plSDdKMjQ2ckNBN0pxVVB3b3RJT3lXdE91V3BDRHNuYlRzbktEcm9ad2c3SXVnNnJPZzdaV1k3SXVjNjRLWTdKcVVQeURpaHBJZzdJdWc2ck9nSU95ZHRPeWNvT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tLaW9xQ2dvakl5QTFMaUFuZSt1cWhleUNySDBnS3lCNzY2cUY3SUtzZlNjZzdKT3c3S2VBSU95Vml1cTRzQW9LSXlNaklPMlZuT3lla095V3RDRHRrb0RzbHJUc2s3RHF1TEFLQ3UyVm5PeWVrT3lXdENEcnFvWHNncXpycGJ3ZzdaS0E3SmEwN0lTY0lPdVBtZXlDckNEdG1KWHRnNXpyb1p3ZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdKMjA3SjZRSU8yWm1PdTJpT3lkaENEcnNKdnNsWmpzbHJUc21wUWc0b2FTSU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRS0xTRHJnclRzbmJ3ZzdMbTA2NU9jNnJDUzdKMjBJT3F5c095Z25PdVFvQ0RzbUlqc29KWHNuYlRzbDVEc21wUWc0b2FTSU91Q3RPeWR2T3lkZ0NEc3ViVHJrNXpxc0pJZzY0S1k2ckNBNjRxVUlPdUNvT3lkdE95WGtPeWFsQW9LSXlNaklPMlZuT3lla095V3RPdWx2Q0R0a29Ec2xyVHNrN0RxdUxBZzdKYTA2NkNrN0pxNElPcXl2ZXlhc0FvS0ozdnJxb1hzZ3F4OTZyQ0FJSHZycW9Yc2dxeDk3WlcwN0lTY0p5RHRtSlh0ZzV6cm9aenJwNHdnN1pLQTdKYTA3S1NZNjQrRUlPdU5sQ0RzdXBEc283enNscnp0bFpqcXNvd2c3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ3JzbUlncENpMGc3SjZVN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVJT0tHa2lEc25wVHNsYUhzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3Exck91bnBPMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUUtDaW9xS2dvS0l5TWdOaTRnN1pHYzZyaXdJTzJHdGV5ZHZBb0tJeU1qSU91UW1PeVd0T3lhbENBb1dDa2c0b2FTSU91UHZPeWFsQ0FvVHlrS0N1dXFxT3V3bE95ZHZDRHRtWlRycWJUc25aZ2c3S0tCN0oyQUlPcXp0ZXF3aE95ZGhDRHFzNkRyb0tUdGxiUWdKK3VRbU95V3RPeWFsQ2ZyaXBRZzY2cW82NUdRSUNmcmo3enNtcFFuNjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc283enNoTGpzbXBRdUNnb3FLaW9LQ2lNaklEY3VJT3VDb095bm5NSzM3SXVjNnJDRXdyZnNpS3ZzbnBBZzdaR2M2cml3Q2dycmdxRHNwNXpDdCt5TG5PcXdoTUszNjdLSTdaaTQ2NHFVSU95VmhPdWVtQ0R0bUpYc2k1M3NuTHpyb1p3ZzdZYTE3SjI4N1pXMDdJU2NJT3lOcU95YWxDNEtDaU1qSXlEcmdxRHNwNXpDdCt5TG5PcXdoTUszNnJpdzZyQ0VDZ3A4SU8yVnJldXFxU0I4SU8yWWxleUxuU0I4SU95WWlPeUxuQ0I4Q253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd0tmQ0RyZ3FEc3A1d2dmQ0RxdUxEcnM3Z2dZRmxaV1ZrdVRVMHVSRVJnSUM4ZzdLZW42cktNSUdCTlRTNUVSR0FnZkNBeU1ESTFMakF4TGpBeExDQXlOUzR3TVM0d01TQjhDbndnN0l1YzZyQ0VJSHdnNnJpdzY3TzRJR0JJU0RwTlRUcFRVMkFnTHlEc3A2ZnFzb3dnWUVoSU9rMU5ZQ0FvN0ppazdLQ0VMK3lZcE8yYmhDRHNsWWdnN0pTQUtTQjhJREUwT2pNd09qRXhMQ0F4TXpvek1DQjhDbndnNnJpdzZyQ0VJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFZmxsWldWa3VUVTB1UkVSZ0lDOGc3S2VuNnJLTUlHQlpXVmxaTGsxTkxrUkVmazFOTGtSRVlDQjhJREl3TWpVdU1ERXVNREYrTWpBeU5TNHdNUzR6TVN3Z01qQXlOUzR3TVM0d01YNHdNUzR6TVNCOENud2c2NEtnN0tlY0lDc2c3SXVjNnJDRUlId2dZRmxaV1ZrdVRVMHVSRVFnU0VnNlRVMWdJSHdnTWpBeU5TNHdNUzR3TVNBeE5Eb3pNQ0I4Q253ZzdKcVU3SjI4SUh3Z1lGbFpXVmt1VFUwdVJFUW83SnFVN0oyOEtXQWc0b0NVSU95YmxDL3RtWlF2N0lpWUwrdXFxUy9xdUlndjdZYWdMK3lkdkNCOElESXdNalV1TURFdU1ERW83SWlZS1NCOENnb3FLdXlMbk9xd2hDRHNtSWpzbWJncUtqb2c3SUtzN0pxcDdKNlE2ckNBSU95bmdleWdrU0RxczZEcnBiVHJpcFFnNjdDcDY2eTR3cmZzbUlqc2xiMGc3SXVjNnJDRTdKMkFJR0RzbUtUc29JUXY3SmlrN1p1RUlFZzZUVTFnN0oyRUlPeU5xT3VQaENEcmo3enNtcFF1Q3V5WWlDa2c3SmlrN1p1RUlERTZNREFLQ2lNakl5RHJyTGpzbnFVZzdJYU5JT3lYc095YmxPeWR2QW9LNjZ5NDdKNmxJT3lWaU95WGtPeUVuT3VLbENBcUt1eWJsTUszN0oyOElPeVZudXlkbUNBdzdKMkVJT3U1dk9xem9Db3FJT3lOcU95YWxDNEtDdXlZaUNrS0xTQXlNREkyNjRXRUlEQTQ3SnVVSURBMTdKMjhJT3llaGV1TGlPdUxwQzRnNG9hU0lESXdNamJyaFlRZ09PeWJsQ0ExN0oyOElPeWVoZXVMaU91THBDNEtDaU1qSXlEc2c0SHJqSUFnN0l1YzZyQ0VJQ2pyaGJqc3RwenNtcWtwQ2dwOElPeWhzT3F4dENCOElPMlJuT3E0c0NCOENud3RMUzB0TFMxOExTMHRMUzB0ZkFwOElEWXc3TFNJSU91dnVPdW5qQ0I4SU91d3FlcTRpQ0Rzb0lRZ2ZBcDhJRFl3NjdhRUlPdXZ1T3VuakNCOElFN3J0b1FnN0tDRUlId0tmQ0F5Tk95TG5PcXdoQ0RycjdqcnA0d2dmQ0JPN0l1YzZyQ0VJT3lnaENCOENud2dNekRzbmJ3ZzY2KzQ2NmVNSUh3Z1R1eWR2Q0Rzb0lRZ2ZBcDhJREV5NnJDYzdKdVVJT3V2dU91bmpDQjhJRTdxc0p6c201UWc3S0NFSUh3S2ZDQXhNdXF3bk95YmxDRHNuYlRzZzRFZ2ZDQk82NFdFSU95Z2hDQjhDZ3JzbUlncElPdXdxZXE0aUNEc29JUXNJRFhydG9RZzdLQ0VMQ0F5N0l1YzZyQ0VJT3lnaEN3Z00reWR2Q0Rzb0lRc0lEYnFzSnpzbTVRZzdLQ0VMQ0F5NjRXRUlPeWdoQW9LSXlNaklPdW5pT3F3a01LMzZyaXc2ckNFSU91bmpPdWpqQW9LWUVRdFRtQW9UdXlkdkNEcmdxanNuWXdwSUM4Z1lFUXRNR0FvN0ppazY0cVlJT3VuaU9xd2tDa2dMeUJnUkN0T1lDaE83SjI4SU9xeXZlcXp2Q2tLN0ppSUtTQkVMVGNzSUVRdE1Td2dSQzB3TENCRUt6RUtDaU1qSXlEcnNvanRtTGdnN1pHYzZyaXdJQ2p0bFpqc25iVHRsSWpzbkx6cm9ad2c2cldzNjdhRUtRb0tmQ0R0bGEzcnFxa2dmQ0R0bUpYc2k1MGdmQ0RzbUlqc2k1d2dmQXA4TFMwdExTMHRmQzB0TFMwdExYd3RMUzB0TFMxOENud2c3S0NFN1ptVTY3S0k3Wmk0SUh3ZzdaV1k3SjIwN1pTSUlPcTFyT3UyaENCOElEQXlMVEV5TXpRdE5UWTNPQ3dnTURFd0xURXlNelF0TlRZM09DQjhDbndnN0xtMDY1T2M2N0tJN1ppNElId2dOT3lla091bXJPeVVxU0R0bFpqc25iVHRsSWdnZkNBeE1qTTBMVFUyTnpndE9UQXhNaTB6TkRVMklId0tmQ0RxczRUc29venJzb2p0bUxnZ2ZDRHRsWmpzbmJUdGxJZ2c2cldzNjdhRUlId2dNVEl6TFRRMU5pMDNPRGt3TVRJZ2ZBcDhJT3lqdk91dnZPdVRzZXVobmV1eWlPMll1Q0I4SU95Vm5pQTI3SjZRNjZhc0xldVNwQ0EzN0o2UTY2YXNJSHdnTVRJek5EVTJMVEV5TXpRMU5qY2dmQXA4SU95Q3JPeVhoZXlla091VHNldWhuZXV5aU8yWXVDQjhJREV3N0o2UTY2YXNJTzJWbU95ZHRPMlVpQ0I4SURBeExUSXpOQzAxTmpjNE9TQjhDZ29qSXlNZzdKT3c2Nm0wSU95VmlDRHJrSmpyaXBRZzdaR2M2cml3Q2dvdElPdUNvT3lubk95WGtDRHRsWmpzbmJUdGxJakN0K3U1bCtxNGlEb2c0cDJNSURJd01qVXRNREV0TURFc0lEQXhMekF4Q2kwZzdJdWM2ckNFN0plUUlPeVlwT3lnaEMvc21LVHRtNFE2SU9LZGpDRHNtS1Rzb0lRZ01leUxuQ0FxS091THFDd2c3SUtzN0pxcDdKNlE2ckNBSU95bmdleWdrU0RxczZEcnBiVHJpcFFnNjdDcDY2eTR3cmZzbUlqc2xiMGc3SXVjNnJDRTdKMkFJT3lZaU95WnVDa3FDZ29xS2lvS0NpTWpJRGd1SU8yTW5leVhoU2pyaTZUc25iVHNscnpyb1p6cXQ3Z3BDZ3J0akozc2w0VWc2Nnk0NnJXczY0cVVJQ29xN0pldDdaV2dLaW9vN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2Q25xczd3Z0tpcnNuS0R0bUpVcUtpanRoclhyczdRdjdZeVE2NHVvS2V5WGtDRHJsTERybmJ3ZzY2eTQ3TEswNnJDQUlPdUxyT3Vkdk95YWxDNGc3WU9BN0oyMDdZdUE3SjJFSU91THBPdVRyT3lkaENEcmxaQWc2N0NZNjVPYzdJdWNJT3lWaU91Q3RDanJzN2pyckxncDZybU03S2VBSU9xd21leWR0Q0RyczdUcXM2QXNJT3V6dU91c3VDRHJwNlhybmIzc25ZUWc2NHUwN0pXRTdKVzhJTzJWdE95YWxDNEtDaU1qSXlBdzY0dW82ck9FSU9LQWxDRHRpcmpycHF6cXNiRHJ0b0R0aExBZzY3U1E3SnFVQ2dydGpKM3NsNFhzbmJRZzdJS3M3SnFwN0o2UTdKMllJT3lXdE91V3BDRHRsb25yajVrZzY1S2s3SmVRSU91Y3FPdUtsT3luZ0NEcnFMenNvSUFnN1l5TTdKV0Y3WlcwN0pxVUxnb0tMU0R0bG9ucmo1bnNuWVFnS2lycXNJRHJvWnpycDRucXNiRHJncGdnN1l5UTY0dW83SjJFSU95YWxPcTFyQ29xS095ZHRPMkRpTUszN0lLdDdLQ2N3cmZyb1p6cXQ3anNsWVRzbTRQQ3QreWloZXVqakNrZzRvYVNJQ29xN1l5UTY0dW83WmlWS2lvZ0tPdXN2T3lXdE91MGtPeWFsQ2tLTFNEcXNyRHFzN3pDdCt5RGdlMkRuT3VsdkNBcUt1Mkd0ZXV6dE91bmpDb3FJQ2pzbVlUcm80ekN0K3lMcE8yTXFDa2c0b2FTSUNvcTdKV0k2NEswN1ppVktpb2dLT3lWak91Z3BPeWttT3lhbENrS0NpTWpJeUR0ZzREc25iVHRpNEFnNG9DVUlPeW5wK3lkZ0NEcnFvWHNncXpxdGF3S0NpMGc2NnFGN0lLczdaaVY3Snk4NjZHY0lPdUJuZXVDdE95YWxDNGc3S0tGNnJLdzdKYTA2Nis0d3JmcnA0anN1YWp0a1p6cnBid2c3Sk93N0tlQUlPeVZpdXlWaE95YWxDQW9mdXlhbENBdklIN3JpNlFnTHlCKzZybU03SnFVUHlEaW5Zd3BMZ290SURKK05PeVd0T3lnaU91aG5DRHNwNmZxczZBZzdJbTk2cktNTGlEdGxaenNucERzbHJUQ3QreUltT3lMbmV5ZGhDRHF1TGpxc293ZzdJeVQ3S2VBSU95Vml1eVZoT3lhbEM0S0xTRHNsWWpyZ3JRbzY3TzQ2Nnk0S1NEcnA2WHJuYjNzbllRZzdKcVU3Slc5N1pXMExDQXFLdTJEZ095ZHRPMkxnT3VuakNEcnRKRHJqNFFnNjZ5MDdJcW9JTzJNbmV5WGhleWR1T3luZ0NvcUlPeVZqT3F5akNEdGxiVHNtcFF1SU95YmtPdXp1T3lkdENBbjdKV002NmE4d3JmdG1aWHNuYmduN0xLWTY1KzhJT3VuaWV5WHNPMlZtT3VwdENEcnM3anJyTGpzbllRZzZyZTg2ckd3NjZHY0lPcTFyT3l5dE8yWmxPMlZ0T3lhbEM0S0Nud2c3SjIwNjZDSDZyS01JT3Vua09xem9DQjhJT3lkdE91Z2grcXlqQ0I4Q253dExTMThMUzB0ZkFwOElPeWdnT3llcGUyVm1PeW5nQ0RzbFlycXM2QWc2NEtZNnJDQTdJdWM2cktnN0phMDdKcVVQeUI4SU95Z2dPeWVwU0RzbFlnZzdaV2NJT3VDdE95YXFTQjhDbndnN0pXTTY2YThJSHdnNnJLdzdLQ2NJT3laaE91ampDQjhDbndnN0tDVjY2ZVFJT3lDcmV5Z25PMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOGdmQ0RyamJEc25iVHRoTEFnN0lLdDdLQ2NJSHdLQ2lNakl5RHNsWWpyZ3JRbzY3TzQ2Nnk0S1NEaWdKUWc3WlcwN0pxVTdMSzBDZ290SUNvcTdZeVE2NHVvN1ppVktpcnNuWUFnSjM3dGxhRHF1WXpzbXBRL0ordWhuQ0Ryckx6c2xyVHNtcFF1SU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPeWNoTzJYbUNqc2dxM3NvSnpDdCsyRGlPMkh0Q0RyazdFcDdKMkFJT3F5c09xenZPdWx2Q0RycUx6c29JQWc2cks5NnJPZzdaVzA3SnFVTGdvdElDb3E3SldJNjRLMDdaaVZLaXJzbllBZzdJS3M3SXVrN0oyRUlPeUVuT3lJb08yVnRPeWFsQzRLTFNEcnA0anN1YWp0a1p6cnBid2c3STJvN0pxVUxpRHNpS3ZzbnBEQ3QreWhzT3F4dENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzBJT3VUc1Nuc25ZQWc2cmU0NjR5QTY2R2NJT3VSa09xem9Dd2c3SnVRNjZ5NDdKZVFJT3lYaHV1S2xDRHNvSlhyczdUQ3QreWdpT3l3cU1LMzdKZXc2NTI5N0xLWTY2VzhJT3luZ095V3RPdUN0T3luZ0NEc2xZcnNsWVRzbXBRdUNnb2pJeU1nNjdLRTdZcThJT0tBbENEc2xZanJnclFnNjZ5NDY2ZWw3SjIwSU95Z2xlMlZ0T3lhbEFvS2ZDRHJzN2pyckxqc25iUWc3SjIwNjZDSDY0dWtJSHdnNjdLRTdZcThJSHdLZkMwdExYd3RMUzE4Q253ZzZyS3c2ck84d3Jmc2c0SHRnNXpycGJ3ZzdZYTE2N08wSUh3Z1crMlpsZXlkdUYwZ2ZBcDhJQ2QrN1pXZzZybU03SnFVUHlmcm9ad2c2Nnk4N0oyTUlId2dXK3lWaE91TGlPeVlwRjBnd3JjZ1crdUVwRjBnZkFwOElPeURnZTJacVNEc2hKenNpS0FnS3lEc21LVHJwYmpzcXIzc25iUWc3SXVrN0tDY0lPdVBtZXlla1NCOElGdnN0NmpzaG94ZElNSzNJRnQ3NjQrWjdKNlJmVjBnZkFvS0xTQW43TGVvN0lhTUordUtsQ0FxS3V1UG1leWVrU0Ryc29UdGlyenFzN3dnN0tlZDdKMjhJT3VWak91bmpDb3FJT3lOcU95YWxDQW83SmlJT2lCYjdMZW83SWFNWGNLM1creUNyZXlnbkYwcExpQW42NHVyNnJpd0lNSzNJT3VQbWV5ZWtTZnNzcGpybjd3ZzdLZWQ3SjIwSU95VmlDRHJwNTdyaXBRZzdLR3c3WldwN0oyMDY0S1lJT3VMcU91UGhTQW43TGVvN0lhTUordUtsQ0RzazdEc3A0QWc3SldLN0pXRTdKcVVMZ290SU91eWhPMkt2T3lkbUNEcmo1bnNucEVnN0oyMDY2YUU3SjJBSU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGhDRHF0N2pyaklEcm9ad2c3SUswNjZDazdKcVVMZ29LSXlNaklPMkd0ZXlubkNEc21JanNpNXdLQ2lvcTdZeVE2NHVvN1ppVklPS0FsQ0RzbmJUdGc0Z3FLZ290SU8yRGdPeWR0TzJMZ0RvZzdLQ0E3SjZsSU95VmlDRHRsWndnNjRLMDdKcXBDaTBnN0pXSTY0SzBPaURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1ak95YWxEOGc3SjZGNjZDbDdaV2NJT3VDdE95YXFleWR0Q0RzZ3F6cm5ienNvTGpzbXBRdUNpMGc2N0tFN1lxOE9pRHNsWVRyaTRqc21LUWd3cmNnNjRTa0Nnb3FLdTJNa091THFPMllsU0RpZ0pRZzdJS3Q3S0NjSUNqc25JVHRsNWdwS2lvS0xTRHRnNERzbmJUdGk0QTZJT3VOc095ZHRPMkVzQ0RzZ3Ezc29Kd0tMU0RzbFlqcmdyUTZJT3lDcmV5Z25PMlZtT3VwdENEcmk2VHNpNXdnN0lLMDY2YTBJT3lJbUNEc2w0YnNsclRzbXBRdUlPeUNyZXlnbk8yVm9PcTVqT3lhbEQ4S0xTRHJzb1R0aXJ3NklPeVZoT3VMaU95WXBDREN0eURyaEtRS0Npb3E2NCtaN0o2UjdaaVZJT0tBbENEc2hKenNpS0FnS3lEcmo1bnNucEVnNjdLRTdZcThLaW9LTFNEdGc0RHNuYlR0aTRBNklPcTRzT3E0c0NEc2w3RHFzckFnN1pXMDdLQ2NDaTBnN0pXSTY0SzBPaURzaEtEdGc1M3RsWndnNnJpdzZyaXc3SjJZSU95WHNPcXlzT3lkaENEcmdZcnNsclRzbXBRdUNpMGc2N0tFN1lxOE9pRHN0NmpzaG93Z3dyY2c3SmV3NnJLd0lPMlZ0T3lnbkFvS0tpcnNsWWpyZ3JUdG1KVWc0b0NVSU95WmhPdWpqQ0R0aHJYcnM3UXFLZ290SU8yRGdPeWR0TzJMZ0RvZzZyS3c3S0NjSU95WmhPdWpqQW90SU95VmlPdUN0RG9nNnJLdzdLQ2M2ckNBSU95Z2xleURnU0Rzc3BqcnBxenJrSkRzbHJUc21wUXVDaTBnNjdLRTdZcThPaUR0bVpYc25iZ0tDaW9xS2dvS0l5RHNtSWpzbWJnZzZyZWM3TG1aQ2dyc201RHN1WmtvNjRxbDY0K1p3cmZxdUkzc29KWEN0K3k2a095anZPeVd2Q25yczdUcmk2UWc3SmlJN0ptNDZyQ0FJT3VObENEcnFvWHRtWlh0bFp3ZzdMdWs2NjZrNjR1STdMeUE3SjIwN0lXWTdKMkVJT3Vuak91VG5PdUtsQ0Rxc3Izc21yRHNtSWpzbXBRdUNnb2pJeURzbUlqc21iZ2dNUzRnN0lpWTY0K1o3WmlWSU91c3VPeWVwZXlkaENEc2phanJqNFFnNjVDWTY0cVVJT3F5dmV5YXNBb0tJeU1qSU95RW5PdTVoT3lLcENEc29vWHJvNHdzSU9xNHNPcXdoQ0RycDR6cm80d0tDdXlJbU91UG1lMllsZXljdk91aG5DRHNrN0RycWJRZzdLTzg3SmEwS095aWhldWpqQ0RzaEp6cnVZVHNpcVFzSU9xNHNPcXdoQ0RyazdFcDY2VzhJT3F3bGV5aHNPMlZvQ0RzaUpnZzdKNkk2ck9nTENBbjdLS0Y2Nk9NSit5WmdDQW42NmVNNjZPTUoreWRtQ0RyaVpqc2xabnNpcVRycGJ3ZzdLQ1Y3Wm1WN1o2SUlPeWdoT3VMck8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SUU5UFR5RHNoSnpydVlUc2lxUWc3S0tGNjZPTUlPeVZpT3VDdENEaWdKUWdNRERzbTVRZ01ERHNuYnpydG9EdGhMQWc3SVNjNjdtRTdJcWs2ckNBSU95aWhldWpqT3VQdk95YWxDNGc3SjZRN0lTNDdaV2NJT3VDdE95YXFleWRoQ0RzbFl6cm9LVHJrNXpyb0tUc21wUXVDaTBnN0o2UTdJS3dJT3loc08yYWpDRHF1TERxc0lUc25iUWc2ck9uSU91bmpPdWpqT3VQdk95YWxDNEtDdXVMcUN3Z0tpcnNvN3pxdUxEc29JSHNuTHpyb1p3ZzdLS0Y2Nk9NNnJDQUlPdXdtT3V6dGV1UW1PdUtsQ0Rzb0p6dGtvZ3FLdXlYa091S2xDQW43S0tGNjZPTTY0Kzg3SnFVSit1bHZDRHNrN0RzcDRBZzdKV0s3SldFN0pxVUxnb0s3SmlJS1FvdElPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU95aWhldWpqT3VQdk95YWxDRGlocElnN0ppazY0cVk3SjJZSU8yQXRPeW1pT3F3Z0NEcXM2Y2c2NEdkNjRLWTdKcVVDZ29qSXlNZzdJS3M3SnFwN0o2UTdKZVE2cktNSU91dnVPeTVtT3VLbENEc21JSHRscVhzbllRZzdKV002NkNrN0tTRUlPdVZqQW9LS095anZPeWFsQ0RyajVuc2dxd2dPaURzbDdEc3NyUXNJTzJWdE95bmdDd2c3S0NCN0pxcElPdVRzU2tLQ3V5SW1PdVBtZTJZbGV5Y3ZPdWhuQ0RzazdEcnFiUWc3SjI0NnJPOElPcTBnT3F6aE91bHZDRHJxb1h0bVpYdGxaanFzb3dnN0lTazY2cUY3WldZNnJPZ0xDQW43SUtzN0pxcDdKNlE3SjJZSU8yV2lldVBtZXlYa0NEcmxMRHJuYnpzbUtUcmlwUWc2ckt3NnJPOEordWR2T3VLbENEc29KRHNuWVFnN0pXTTY2Q2s3S1NFSU95SW1DRHNub2pzbHJUc21wUXVDZ3JzbUlncENpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3RPeWp2T3lFdU95YWxDNEtMU0RyaklEc3RwenNuWVFnNnJDSTdKV0U3WU9BNjZtMElPeWJrT3VlbUNEcmpJRHN0cHpzbmJRZzdaVzA3S2VBNjQrODdKcVVMaURzbUtUcmlwZ2c2NEtnN0tlYzZybU03S2VBN0oyWUlPeWR0T3lla091bHZDRHNuWUR0bG9uc2w1QWc2NEswN0pXOElPMlZ0T3lhbEM0S0NpTWpJeURzZ3F6c21xbnNucEFnN0pXSTdJdXNJQ2pzaUpqcmo1bnRtSlVwQ2dvbjdLQ1Y2N08wSU95SW1PeW5rU0RzbFlqcmdyUW5JT3VUc2V5ZG1DRHJyN3pxc0pEdGxad2c3SU9CN1ptcDdKZVE3SVNjSUNvcTdJdWM3SXFrN1lXYzdKMjBJT3lla091UG1leWN2T3VobkNEc3NwanJwcXp0bFp6cmk2VHJpcFFnN0tDUUtpcnNuWVFnN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1FvdElPeWR0T3lnbk91MmdPMkVzQ0R0bVkzcXVManJqNW5yaTVqc25aZ2c2ckNjN0oyNDdLQ1Y2N08wSU95ZHRPeWFxU0RyZ3JUc2w2M3NuYlFnNnJpdzY2R2Q2NCs4N0pxVUNpMGc2NDJVSU95aWkreWRnQ0RzZzRIcmk3VHNuWVFnN0p5RTdaVzBJTzJHdGUyWmxDRHJnclRzbXFuc25ZQWc2NFc1N0oyTTY0Kzg3SnFVQ2dvakl5RHNtSWpzbWJnZ01pNGc2cks5N0phMDY2VzhJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3Q2dydGlybnNvSlVnN0lPQjdabXA3SmVRN0lTY0lPeWduTzJWbk95Z2dleWN2T3VobkNBbjdJdWM2NEtZN0pxVVB5d2c3SVdvNjRLWTdKcVVQeWNnN0oyWTY2eTQ3WmlWSU95V3RPdXZ1T3VsdkNEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzZ3F6c21xbnNucERzblpnZzY2ZWw2NTI5N0oyRUlPMlpuT3lhcWUyVnRPeUVuQ0RzcDRqcnJManRsYUFnNjVXTUNnb243SXVjNjRLWTdKcVVQeWNzSUNmc2hhanJncGpzbXBRL0p5RHRtSlh0ZzV6c25aZ2c2cks5N0phMDY2VzhJTzJabk95YXFlMlZ0T3lFbkNEc2dxenNtcW5zbnBEc25aZ2c2NHU1N1ptcDdJcWs2NStzN0p1QTdKMkVJT3lraE95ZHZDRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SU8yWmplcTR1T3VQbWV1TG1Dd2dUMDlQSU91THBPdUZnT3lZcE95RnFPdUNtT3lhbEQ4S0xTRHN0cW5zb0lUdGxaanJuNndnN1k2NDdKMlk3S0NRSU9xd2dPeUxuT3VDbU95YWxEOEtDaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SU9CN1ptcDdKMkVJT3kybE95Z2xlMlZvQ0RybFl3S0N1dXFoZTJabGUyVm5DRHNvSlhyczdUcXNJQWc3SmVHN0phMDdJU2NJT3lDck95YXFleWVrT3lYa09xeWpDRHNwNEhzb0pFZzdZeVE2NHVvN1pXWTZyS01JTzJWdE95VnZDRHRsYUFnNjVXTUlPcXl2ZXlXdE91aG5DRHNvSlhzcEpIdGxaanFzb3dnN0tlSTY2eTQ3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ3JzbUlncENpMGc3TG0wNjVPYzY2VzhJT3V3bSt5Y3ZPeUZxT3VDbU95YWxEOGc2NU94NjZHZDdaV1k2Nm0wSU95NmtPeUxuT3V3c1NEdG1KenRnNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdJS3M3SnFwN0o2UTdKMllJT3lFb095ZG1PcXdnQ0R0bFlUc21wVHRsYUFnNjVXTUNncnNoS1Ryckxqc29iRHNncXpzc3Bqcm43d2c3SUtzN0pxcDdKNlE3SjJZSU95RW9PeWRtT3VsdkNEcXVMRHJqSUR0bGJUc2xid2c3WldnSU91VmpDRHFzcjNzbHJUcm9ad2c3S0NWN0tTUjdaV1k2cktNSU95bmlPdXN1TzJWdE95YWxDNEtDdXlZaUNrS0xTRHNuYlRyc29nZzY0dXM3SmVRSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxaanJxYlRzaEp3ZzdKYTg2NmVJNjRLWUlPdW5qT3loc2UyVm1PeUZxT3VDbU95YWxEOEtDaU1qSU95WWlPeVp1Q0F6TGlEcnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyRUlPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdDZ3JzZ3F6c21xbnNucERzbDVEcXNvd2c2NnFGN1ptVjdaV1k2cktNSU91MmdPeWdsZXlnZ2V5ZHVDRHJnclRzbXFuc25ZUWc3SldNNjZDazdLU1k3Slc4SU8yVm9DRHJsWXpyaXBRZzY3YUE3S0NWN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzdLS0w3SldFN0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcE91bHZDRHNvSlhzc1lYc2c0RWc3Sk80SU95SW1DRHNsNGJzbllRZzY1V01DZ3JydG9Ec29KWHRtSlhzbkx6cm9ad2c3STJvN0pXOElPeUNyT3lhcWV5ZWtPeVhrT3F5akNEc2c0SHRtYW5zbllRZzY2cUY3Wm1WN1pXWTZyS01JT3lkdU95bmdPeUxuTzJDckNEc2lKZ2c3SjZJN0phMDdKcVVMaUFxS3V5VHVDRHNpSmdnN0plRzY0cVVJT3lkdE95Y29PdWx2Q0R0bGFqcXU1Z2c3SldJNjRLMDdaVzA3S084N0lTNDdKcVVMaW9xQ2dyc21JZ3BDaTBnN0tlQTZyaUk3SjJBSU9xd2dPeWVoZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YWxDNEtMU0RxczdYcnJMVHNtNURzbllBZzdadUU3SnVRNnJpSTdKMkVJT3V6dE91Q3ZDRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lkdk91MmdDRHF1TERyaXFYcnA0d2c3Sk80SU95SW1DRHNsNGJzbllRZzY1V01DZ3JydG9Ec29KWHRtSlhzbkx6cm9ad2c3STJvN0pXOElPeUNyT3lhcWV5ZWtPcXdnQ0RzbHJUcmxxUWc2cml3NjRxbDdKMkVJT3lUdUNEc2lKZ2c3SmVHNjRxVTdLZUFJT3VxaGUyWmxlMlZtT3F5akNEc25ianNwNER0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ3V5WWlDa0tMU0Rzb0pEcXNvQWc2cml3NnJDRUlPdVBtZXlWaUNEc2hKenJ1WVRzaXFUcnBid2c3SjIwN0pxcDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUNpMGc3SXVnNjdhRTdLYWRJTzJabGV5ZHVPdVFtT3E0c0NEc29JVHF1WXpzcDRBZzdJYWg2cmlJNnJPOElPcXlzT3lnbk91bHZDRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBBZzdJU2c3WU9kN0oyWUlPcXlzT3F6dk91bHZDRHNsWWpyZ3JUdGxhQWc2NVdNQ2dycmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHNoS0R0ZzUzc25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyVm1PcXlqQ0RzbFl6cm9LVHNtcFF1Q2dyc21JZ3BDaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBBZzdKV0k3SXVzSUNqcnRvRHNvSlh0bUpVcENnb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3S0NWNjdPMDZyQ0FJT3V6dE8yWXVPdVFuT3VMcE91S2xDRHNvSkFxS3V5ZGhDRHJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzdKV002NkNrSU95Q3JPeWFxZXlla091bHZDRHNsWWpzaTZ6dGxaanFzb3dnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0lPQjY0dTA3SjIwSU91Qm5ldUNtT3VwdENEc29JVHJyTGpxc0lEcmo0UWc3Wm1ONnJpNDY0K1o2NHVZN0oyWUlPeWdsZXV6dE91bHZDRHJzN3dnN0lpWUlPeVhodXlXdE95YWxDNEtMU0R0bVkzcXVManJqNW5yaTVqc25aZ2c3S0NWNjdPMDZyQ0FJT3E0c091aG5ldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUNnb2pJeURzbUlqc21iZ2dOQzRnN0tDYzdaS0lJT3lhcWV5V3RPdUtsQ0Ryc0pUcXZyanNwNEFnN0pXSzZyaXdDZ29uNnJDRTZyS3c3WldZNnJPZ0lPeUpyT3lhdENEcnA1QW5JT3lia095NW1ldXp0T3VMcENBcUt1MlpsT3VwdE95ZG1DRHF1TERyaXFYcnFvWEN0K3V5aE8yS3ZPdXFoZXF6dk95ZG1DRHNtcW5zbHJRZzdKMjg3TG1ZS2lycXNJQWc3SnF3N0lTZzdKMjA3SmVRN0pxVUxncnF1TERyaXFYcnFvWHNsNUFnN0pPdzdKMjRJT3VMcU95V3RDanJzNERxc3Iwc0lPeW5nT3lnbFN3ZzY1T3g2NkdkSU91VHNTbnJwYndnN0pXSTY0SzBJT3VzdU9xMXJPeVhrT3lFbkNEcmk2VHJwYmdnNjZlUTY2R2NJT3V3bE9xK3VPdXB0Q0RzZ3F6c21xbnNucERxc0lBZzY0dWs2Nlc0SU9xNHNPdUtwZXljdk91aG5DRHNtS1R0bGJUdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0N1eVlpQ2tnSitxMmpPMlZuQ0RyczREcXNyMG5JT3E0c091S3BleWRtQ0RzbFlqcmdyUWc2Nnk0NnJXc0NpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbU91cHRDRHJzSlRxdjRBZzdJaVlJT3llaU95V3RPeWFsQ0FvV0NrS0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXpnT3F5dmUyVm9DRHNpSmdnN0o2STdKYTA3SnFVSUNoUEtRb0tJeU1nN0ppSTdKbTRJRFV1SU95TG5PeUtwTzJGbkNEcmo1bnNucEhxczd3ZzY0dWs2Nlc0SU91UG1leUNyQ0RzazdEc3A0QWc3SldLNnJpd0NncnJyTGpxdGF6cnBid2c3SldFNjZ5MDY2YXNJT3VucE91QmhPdWZ2ZXF5akNEcmk2VHJrNnpzbHJUcmo0UWdLaXJzaTZUc29Kd2c3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyaTZUcnBiZ2c2NCtaN0lLc0tpcnJwYndnN0pPdzY2bTBJT3llbU91cXUrdVFuQ0RyckxqcXRhenNtSWpzbXBRdUNncnNtSWdwSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcnBid2dKK3kybE9xd2dDRHNwNERzb0pVbjdaV1k2NHFVSU95TG5PeUtwTzJGbk95WGtPeUVuQ0FvN0oyMDdLQ0V3cmZzbHBIcmo0UWc2cml3NjRxbDdKMjBJT3lWaE91TG1Da0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKZVE2cktNSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcnBid2c2NFNZNnJLbzdLTzg3SVM0N0pxVUlDaFlJT0tBbENEc2w0YnJpcFFnSit1RW1PcTRzT3E0c0NjZzZyaXc2NHFsN0oyRUlPeVZsT3lMbkNrS0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WlcwSU95anZPeUV1T3lhbENBb1R5a0snCkRJUj0iJEhPTUUvTGlicmFyeS9BcHBsaWNhdGlvbiBTdXBwb3J0L0NsYXVkZUJyaWRnZSIKcHV0KCkgeyBwcmludGYgJXMgIiQxIiB8IGJhc2U2NCAtRCA+ICIkMiI7IH0KIyDsnbQgLmNvbW1hbmTqsIAg64+E64qUIO2EsOuvuOuEkCDssL3rp4wg6rOo6528IOuLq+uKlOuLpCh0dHkg66ek7LmtKS4gYmFzaOqwgCDrgZ3rgpgg7YOt7J20IGlkbGXrkJwgMey0iCDrkqTsl5Ag64ur7JWECiMgIu2UhOuhnOyEuOyKpCDsi6Ttlokg7KSRIiDqsr3qs6Drpbwg7ZS87ZWc64ukIOKAlCBkaXNvd27snLzroZwg7Iqk7YGs66a97Yq46rCAIGV4aXTtlbTrj4Qg64ur6riwIOyekeyXheydgCDsgrTslYTrgqjripTri6QuICjrp6Ug7Iuk6riwIOqygOymnSDtlYTsmpQpCk1ZVFRZPSIkKHBzIC1vIHR0eT0gLXAgJCQgMj4vZGV2L251bGwgfCB0ciAtZCAiICIpIgpjbG9zZV90ZXJtaW5hbCgpIHsKICBbIC16ICIkTVlUVFkiIF0gJiYgcmV0dXJuCiAgKCBzbGVlcCAxCiAgICAvdXNyL2Jpbi9vc2FzY3JpcHQgPi9kZXYvbnVsbCAyPiYxIDw8T1NBCnRlbGwgYXBwbGljYXRpb24gIlRlcm1pbmFsIgogIHJlcGVhdCB3aXRoIHcgaW4gd2luZG93cwogICAgdHJ5CiAgICAgIHJlcGVhdCB3aXRoIHQgaW4gdGFicyBvZiB3CiAgICAgICAgaWYgdHR5IG9mIHQgaXMgIi9kZXYvJE1ZVFRZIiB0aGVuIGNsb3NlIHcgc2F2aW5nIG5vCiAgICAgIGVuZCByZXBlYXQKICAgIGVuZCB0cnkKICBlbmQgcmVwZWF0CmVuZCB0ZWxsCk9TQQogICkgJiBkaXNvd24gMj4vZGV2L251bGwgfHwgdHJ1ZQp9CiMg7JWI64K064qUIO2UjOufrOq3uOyduOydtCDrs7Tsl6zspIDri6Qg4oCUIO2EsOuvuOuEkOydgCDshKTsuZjCt+ygkOqygOunjCDtlZjqs6Ag7Iqk7Iqk66GcIOuLq+2ejOuLpC4KZmluaXNoKCkgeyBjbG9zZV90ZXJtaW5hbDsgZXhpdCAiJDEiOyB9CmVjaG8gIu2BtOuhnOuTnCDsu6TrhKXthLDrpbwg7ISk7LmY7ZWY6rOgIOyeiOyWtOyalOKApiDsnqDsi5wg7ZuEIOydtCDssL3snYAg7J6Q64+Z7Jy866GcIOuLq+2YgOyalC4iCm1rZGlyIC1wICIkRElSL3NjcmlwdHMiIHx8IHsgZWNobyAi7Y+0642UIOyDneyEsSDsi6TtjKg6ICRESVIiOyBmaW5pc2ggMTsgfQpwdXQgIiRCNjRfQlJJREdFIiAgICIkRElSL3NjcmlwdHMvY2xhdWRlLWJyaWRnZS5qcyIKcHV0ICIkQjY0X1dBVENIRVIiICAiJERJUi9zY3JpcHRzL2JyaWRnZS13YXRjaGVyLmpzIgpwdXQgIiRCNjRfRVhBTVBMRVMiICIkRElSL3JlY29tbWVuZC1leGFtcGxlcy5tZCIKcHV0ICIkQjY0X0dVSURFIiAgICAiJERJUi91eC13cml0aW5nLm1kIgplY2hvICLinIUg7YyM7J28IOyEpOy5mDogJERJUiIKIyBHVUnsl5DshJwg7JewIFRlcm1pbmFs7J2AIFBBVEjqsIAg7KKB7J2EIOyImCDsnojslrQg7Z2U7ZWcIOyEpOy5mCDqsr3roZzrpbwg67O07YOg64ukCmV4cG9ydCBQQVRIPSIkSE9NRS8ubG9jYWwvYmluOi9vcHQvaG9tZWJyZXcvYmluOi91c3IvbG9jYWwvYmluOiRQQVRIIgojIG5vZGXqsIAg7JeG7Jy866m0IOqwkOyLnOyekCg9bm9kZSkg7J6Q7LK06rCAIOuquyDrj4zslYQg7ZSM65+s6re47J247JeQIOyVjOumtCDrsKnrspXsnbQg7JeG64ukIOKGkiDsnbQg6rK97Jqw66eMIOuEpOydtO2LsOu4jCDtjJ3sl4XsnLzroZwg7JWI64K07ZWc64ukCmlmICEgY29tbWFuZCAtdiBub2RlID4vZGV2L251bGwgMj4mMTsgdGhlbgogIG9zYXNjcmlwdCAtZSAnZGlzcGxheSBkaWFsb2cgIuydtCBNYWPsl5AgTm9kZS5qc+qwgCDsl4bslrTsmpQuIFvtmZXsnbhd7J2EIOuIhOultOuptCDri6TsmrTroZzrk5wg7Y6Y7J207KeA6rCAIOyXtOugpOyalC4gTm9kZS5qcyhMVFMp66W8IOyEpOy5mO2VnCDrkqQg7J20IOyEpOy5mCDtjIzsnbzsnYQg64uk7IucIOyLpO2Wie2VtCDso7zshLjsmpQuIiB3aXRoIHRpdGxlICLtgbTroZzrk5wg7Luk64Sl7YSwIOKAlCBOb2RlLmpzIO2VhOyalCIgYnV0dG9ucyB7Iu2ZleyduCJ9IGRlZmF1bHQgYnV0dG9uIDEgd2l0aCBpY29uIGNhdXRpb24gZ2l2aW5nIHVwIGFmdGVyIDE4MCcgPi9kZXYvbnVsbCAyPiYxCiAgb3BlbiAiaHR0cHM6Ly9ub2RlanMub3JnL2tvL2Rvd25sb2FkIiAyPi9kZXYvbnVsbAogIGZpbmlzaCAwCmZpCk5PREVfQklOPSIkKGNvbW1hbmQgLXYgbm9kZSkiCmVjaG8gIuKchSBOb2RlLmpzOiAkKG5vZGUgLS12ZXJzaW9uKSIKIyDqsJDsi5zsnpAgbGF1bmNoZCDrk7HroZ0gKOuhnOq3uOyduCDsnpDrj5nsi5zsnpEgKyDsp4DquIgg6riw64+ZKS4gUEFUSOulvCBwbGlzdOyXkCDqtbPtmIAg64Sj64qU64ukIOKAlCBsYXVuY2hkIOq4sOuzuCBQQVRI7JeUIGNsYXVkZeqwgCDsl4bri6QuClBMSVNUPSIkSE9NRS9MaWJyYXJ5L0xhdW5jaEFnZW50cy9jb20uY2xhdWRlYnJpZGdlLndhdGNoZXIucGxpc3QiCm1rZGlyIC1wICIkSE9NRS9MaWJyYXJ5L0xhdW5jaEFnZW50cyIKU0FGRV9QQVRIPSIke1BBVEgvLyYvJmFtcDt9IgpjYXQgPiAiJFBMSVNUIiA8PFBMSVNURU9GCjw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjwhRE9DVFlQRSBwbGlzdCBQVUJMSUMgIi0vL0FwcGxlLy9EVEQgUExJU1QgMS4wLy9FTiIgImh0dHA6Ly93d3cuYXBwbGUuY29tL0RURHMvUHJvcGVydHlMaXN0LTEuMC5kdGQiPgo8cGxpc3QgdmVyc2lvbj0iMS4wIj4KPGRpY3Q+CiAgPGtleT5MYWJlbDwva2V5PjxzdHJpbmc+Y29tLmNsYXVkZWJyaWRnZS53YXRjaGVyPC9zdHJpbmc+CiAgPGtleT5Qcm9ncmFtQXJndW1lbnRzPC9rZXk+CiAgPGFycmF5PgogICAgPHN0cmluZz4kTk9ERV9CSU48L3N0cmluZz4KICAgIDxzdHJpbmc+JERJUi9zY3JpcHRzL2JyaWRnZS13YXRjaGVyLmpzPC9zdHJpbmc+CiAgPC9hcnJheT4KICA8a2V5PkVudmlyb25tZW50VmFyaWFibGVzPC9rZXk+CiAgPGRpY3Q+PGtleT5QQVRIPC9rZXk+PHN0cmluZz4kU0FGRV9QQVRIPC9zdHJpbmc+PC9kaWN0PgogIDxrZXk+UnVuQXRMb2FkPC9rZXk+PHRydWUvPgogIDxrZXk+S2VlcEFsaXZlPC9rZXk+PGRpY3Q+PGtleT5TdWNjZXNzZnVsRXhpdDwva2V5PjxmYWxzZS8+PC9kaWN0Pgo8L2RpY3Q+CjwvcGxpc3Q+ClBMSVNURU9GCmxhdW5jaGN0bCBib290b3V0ICJndWkvJChpZCAtdSkvY29tLmNsYXVkZWJyaWRnZS53YXRjaGVyIiAyPi9kZXYvbnVsbApsYXVuY2hjdGwgYm9vdHN0cmFwICJndWkvJChpZCAtdSkiICIkUExJU1QiIDI+L2Rldi9udWxsIHx8IGxhdW5jaGN0bCBsb2FkIC13ICIkUExJU1QiIDI+L2Rldi9udWxsCiMgY2xhdWRlIOycoOustMK366Gc6re47J24IOyXrOu2gOuKlCDsl6zquLDshJwg7JWM66as7KeAIOyViuuKlOuLpCDigJQg6rCQ7Iuc7J6Q6rCAIOq3uCDsg4Htg5zrpbwg7ZSM65+s6re47J247JeQIOyghOuLrO2VtAojIOqzhOyglSDtmZTrqbTsnbQgIuyEpOy5mCDtlYTsmpQgLyDroZzqt7jsnbgg7ZWE7JqUIC8g7KSA67mEIOyZhOujjCLroZwg64W47Lac7ZWc64ukKO2EsOuvuOuEkOydtCDssYTrhJDsnbQg7JWE64uYKS4KIyDshKTsuZjCt+ygkOqygCDrgZ0g4oaSIOywveydhCDsiqTsiqTroZwg64ur64qU64ukLgpmaW5pc2ggMApQSwECHgMUAAAIAAAAAAAAbAe8b3vxAQB78QEAGwAAAAAAAAAAAAAA7YEAAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kUEsFBgAAAAABAAEASQAAALTxAQAAAA==";
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
            const suggestions = await refineAiSuggestions(await fetchAiSuggestions(text, msg.model));
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
        if (!messages.length) {
            figma.ui.postMessage({ type: 'compose-result', ok: false, error: '설명할 내용을 입력해주세요.' });
            return;
        }
        const bh = await bridgeHealth();
        if (!bh.alive) {
            figma.ui.postMessage({ type: 'compose-result', ok: false, error: '클로드가 연동돼 있지 않아요 — [클로드] 버튼으로 연결해 주세요.' });
            return;
        }
        // 계정 확인 게이트 (추천과 동일)
        if (needsAccountConfirm(bh)) {
            figma.ui.postMessage({ type: 'account-confirm-needed', account: bh.account });
            figma.ui.postMessage({ type: 'compose-result', ok: false, error: '어느 클로드 계정으로 쓸지 먼저 확인해 주세요.' });
            return;
        }
        try {
            const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/compose', { messages, model: msg.model }, 130000);
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) {
                const guided = data && data.problem && data.error; // 로그인/설치 안내는 그대로 노출
                figma.ui.postMessage({ type: 'compose-result', ok: false, error: guided ? String(data.error) : ('클로드 호출 실패: ' + (data && data.error ? data.error : ('HTTP ' + res.status))) });
                refreshBridgeStatus();
                return;
            }
            // 제안 문구는 추천과 동일하게 용어집·맞춤법 후처리를 거친다 (프롬프트 위반 안전망)
            const suggestions = Array.isArray(data.suggestions) && data.suggestions.length
                ? await refineAiSuggestions(data.suggestions)
                : [];
            figma.ui.postMessage({ type: 'compose-result', ok: true, reply: String(data.reply || ''), suggestions });
        }
        catch (e) {
            figma.ui.postMessage({ type: 'compose-result', ok: false, error: '클로드 호출 실패: ' + errStr(e) });
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
        figma.ui.postMessage({ type: 'selection-text', text: (t && t.trim()) ? t : '', onEnter: true });
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
