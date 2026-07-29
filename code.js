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
            if (popupEls.length >= 2) {
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
    if (popupEls.length >= 2) {
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
// 팝업 요소별 추천 — 선택이 '텍스트 2개 이상 든 컴포넌트'면 역할별로 갈라 요소마다 추천하고 true 반환.
// 아니면(단일 텍스트·빈 선택 등) 처리하지 않고 false → 호출부가 일반 추천으로 넘어간다.
async function popupRecommendFlow(model) {
    const sel = figma.currentPage.selection;
    if (!sel.length || sel[0].type === "TEXT")
        return false;
    const elements = classifyPopup(sel[0]);
    if (elements.length < 2)
        return false;
    const bh = await bridgeHealth();
    if (!bh.alive) {
        figma.ui.postMessage({ type: 'show-toast', message: '클로드가 연동돼 있지 않아요 — [클로드] 버튼으로 연결한 뒤 다시 눌러 주세요.' });
        return true;
    }
    if (needsAccountConfirm(bh)) {
        figma.ui.postMessage({ type: 'account-confirm-needed', account: bh.account });
        return true;
    }
    figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '팝업 문구를 요소별로 다듬는 중이에요' });
    const results = [];
    for (const el of elements) {
        try {
            const s = await refineAiSuggestions(await fetchAiSuggestions(el.text, model));
            results.push({ role: el.role, original: el.text, suggestions: s });
        }
        catch (e) {
            results.push({ role: el.role, original: el.text, suggestions: [], error: errStr(e) });
        }
    }
    figma.ui.postMessage({ type: 'hide-loading' });
    figma.ui.postMessage({ type: 'popup-recommend-result', elements: results });
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
            figma.ui.postMessage({ type: 'show-toast', message: failNote + ' — 예시·규칙 기반 추천으로 대신했어요.' });
    }
    else if (failNote) {
        figma.ui.postMessage({ type: 'show-toast', message: failNote });
    }
    else {
        figma.ui.postMessage({ type: 'show-toast', message: emptyNote || '예시·규칙으로 다듬을 곳을 찾지 못했어요. AI 추천을 쓰려면 [클로드] 버튼으로 클로드를 연결해 주세요.' });
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
const BRIDGE_MIN_V = 13;
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
// 클로드다리 설치 파일 — 다리+예시+런처를 내장한 자기완결 bat. UI의 [🔧 설치 파일 받기]가 다운로드로 내려준다.
// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.bat을 base64로 주입) =====
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21saw0KWjJVcENpOHZJT3k4bk91UmtPdXB0Q0R0bEl6cm42enF0N2pzbmJqc25aZ2dXK3kybE95eW5PdXdtK3E0c0YzcXNJQWdSMlZ0YVc1cElPMkNwQ0RzbDRic25iVHJqNFFnN1lHMDY2R2M2NU9jNjZHY0lFRkpJT3kybE95eW5PeWRoQ0Ryc0p2cmlwVHJpNlF1Q2k4dkNpOHZJT3lHamV1UGhDRHNoS1RxczRRNklPMkJ0T3Vobk91VG5PdWx2Q0RzbXBUc3NxM3JwNGpyaTZRZzdJT0k2NkdjSU95TG5PdVBtZTJWbU91cHRDQXpNSDQwTU95MGlPcXdnQ0RxdDdqcmc2VWc2NEtnN0pXRTZyQ0U2NHVrTGdvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0NpOHZJQ0FnNnJDQTdKMjA2NU9jSyt5WWlPeUxuQ2d4TVRIcXNiUXA2NHFVSU95eXF5RHJxWlRzaTV6c3A0RHJvWndnN1pXY0lPdXlpT3VuakNEc25iM3QNCm5venJpNlF1SU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjZ5NDZyV3M2NmVNSU91enRPdUN0T3V2Z091aG5DRHJ1YURycGJUcmk2UXVDaTh2SU95RXVPeUZtT3lkZ0NBek1PdXlpQ0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3WlcwSU91TWdPMlpsT3F3Z0NEcnJMVHRsWnp0bm9nZzZyaTQ3SmEwN0tlQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaTh2Q2k4dklPeWdoT3lnbkRvZzdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0NjQrOElPeWVpT3lkaENEcXNvTWdLR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3Snk4NjZHY0lPMlpsZXlkdUNrS0x5OGc3S084N0oyWU9pRHNncXpzbXFucm40bnNuWUFnNnJDQjdKNlFJTzJCdE91aG5PdVRuQ0RxdGF6cmo0VWc3WldjNjQrRTdKZVE3SVNjSU95d3FPcXdrT3VRbk91THBDNEtDbU52Ym5OMElHaDBkSEFnUFNCeVpYRjFhWEpsS0Nkb2RIUndKeWs3Q21OdmJuTjBJR1p6SUQwZ2NtVnhkV2x5WlNnblpuTW5LVHNLDQpZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdA0KWTNka0p5azdDblJ5ZVNCN0lHWnpMbTFyWkdseVUzbHVZeWhGVFZCVVdWOURWMFFzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsSUgwcE95QjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUXBqYjI1emRDQkRURUZWUkVWZlJVNVdJRDBnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnY0hKdlkyVnpjeTVsYm5Zc0lIc0tJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcENpQWdRMHhCVlVSRlgwTlBSRVZmUkVsVFFVSk1SVjlPVDA1RlUxTkZUbFJKUVV4ZlZGSkJSa1pKUXpvZ0p6RW5MQ0F2THlEdGhMUWc3SnFVN0pXOUlPdVRzU0RydG9EcXNJQWc3Wmk0N0xhY0lPdUJsQW9nSUVSSlUwRkNURVZmVkVWTVJVMUZWRkpaT2lBbk1TY3NDbjBwT3dvS1kyOXVjM1FnVUU5U1ZDQTlJRTUxYldKbGNpaHdjbTlqWlhOekxtVnUNCmRpNUNVa2xFUjBWZlVFOVNWQ2tnZkh3Z01URTRPRGc3SUM4dklFSlNTVVJIUlY5UVQxSlU2NHFVSU8yRmpPeUtwTzJLdU95YXFTQW83WStKN0lhTTdKZVVJREV4T0RnNElPcXpvT3lnbFNrS0x5OGc2NHVrNjZhc0lPeTlsT3VUbkNEcnNvVHNvSVFnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaV2M2NHVrTGlEc3ZaVHJrNXpycGJ3Z2NIVnNiTUszNjdPMTdJS3M3WlcwNjQrRUlDb3E3SjIwNjYrNElPdVdvQ0Rzbm9qcmlwUWc2NHVrNjZhczY0cVVJT3lZbXlEc3ZaVHJrNXdnNnJlNDY0eUE2NkdjS2lycm5id0tMeThnNnJ1UTY0dWtJT3k4bk9xNHNDRHNvSVRzbDVRZzdJT0lJT3VQbWV5ZWtleWR0Q0RzbFlnZzY0S1k3SmlvNjR1a0tPMkVzT3V2dU91RWtPeWR0Q0RybktqcmlwUWc2NU94S1M0ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkxzbkx6cm9ad2c2cldzNjdLRTdLQ0U3SjJFSU9xd2tPeW5nTzJWdENEc25xenNpNXpzbnBIc2k1enRncWpyaTZRdUNpOHZJT3VQbWV5ZWtleWR0Q0RyDQpzSlRyZ0l6cmlwUWc3SWlZN0tDVjdKMkVJTzJWbU91cHRDRHNuYlFnN0lpcjdKNlE2Nlc4SU95WXJPdW1yT3F6b0NCamIyUmxMblJ6N0oyWUlFSlNTVVJIUlY5TlNVNWZWdXVQaENEcXNKbnNuYlFnN0ppczY2YXc2NHVrTGdwamIyNXpkQ0JDVWtsRVIwVmZWaUE5SURFek93b3ZMeURxdUxEcnM3Z2c2NnFvNjQyNExpRHNtcFRzc3EwbzdaU002NStzNnJlNDdKMjRLZXlkdENCdGIyUmxiT3lkaENEc3A0RHNvSlh0bFpqcnFiUWc2cmU0SU95YWxPeXlyZXVuakNEcXQ3Z2c2NnFvNjQyNDY2R2NJT3l5bU91bXJPMlZuT3VMcEM0S0x5OGdhR0ZwYTNVOTY3bWc2NmFFTCtxd2dPdXl2T3liZ0N3Z2MyOXVibVYwUGV5a2tlcXdoQ3dnYjNCMWN6M3F1TERyczdnbzdMV2M2ck9nN1pLSTdLZUlMQ0Rzb2JEcXVJZ2c2NHFRNjZhOEtRcGpiMjV6ZENCRFRFRlZSRVZmVFU5RVJVd2dQU0J3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVFU5RVJVd2dmSHdnSjI5d2RYTW5Pd3BqYjI1emRDQkJURXhQVjBWRVgwMVBSRVZNVXlBOQ0KSUZzbmFHRnBhM1VuTENBbmMyOXVibVYwSnl3Z0oyOXdkWE1uWFRzS1kyOXVjM1FnVkZWU1RsOVVTVTFGVDFWVVgwMVRJRDBnT1RBd01EQTdJQ0FnTHk4ZzdKcVU3TEt0SURIcXNiUWc3S0NjN1pXYzdJdWM2ckNFQ21OdmJuTjBJRTFCV0Y5VVZWSk9VeUE5SURNd095QWdJQ0FnSUNBZ0lDQWdJQzh2SU95ZHRPdW5qTzJCdkNEc2s3RHJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU0FvNjR5QTdabVVJT3VJaE95Z2dTRHJzS25zcDRBcENnb3ZMeURpbElEaWxJQWc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnS0hKbFkyOXRiV1Z1WkMxbGVHRnRjR3hsY3k1dFpDRGlnSlFnWW5WcGJHUXRaMnh2YzNOaGNua3VhblBzbVlBZzZyQ1o3SjJBSU8yTWpPeUVuQ2tnNHBTQTRwU0FDbVoxYm1OMGFXOXVJR3h2WVdSRmVHRnRjR3hsY3lncElIc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdiV1FnUFNCbWN5NXlaV0ZrUm1sc1pWTjVibU1vY0dGMGFDNXFiMmx1S0Y5ZlpHbHlibUZ0WlN3Z0p5NHVKeXdnSjNKbFkyOXQNCmJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW5kWFJtT0NjcE93b2dJQ0FnWTI5dWMzUWdjMlZqU1dSNElEMGdiV1F1YzJWaGNtTm9LQzllSXlNZzdMYVU3TEtjSU95WWlPeUxuRnh6S2lRdmJTazdDaUFnSUNCcFppQW9jMlZqU1dSNElEMDlQU0F0TVNrZ2NtVjBkWEp1SUZ0ZE93b2dJQ0FnWTI5dWMzUWdaWGhoYlhCc1pYTWdQU0JiWFRzS0lDQWdJR3hsZENCamRYSWdQU0J1ZFd4c093b2dJQ0FnWm05eUlDaGpiMjV6ZENCeVlYY2diMllnYldRdWMyeHBZMlVvYzJWalNXUjRLUzV6Y0d4cGRDZ25YRzRuS1NrZ2V3b2dJQ0FnSUNCamIyNXpkQ0JzYVc1bElEMGdjbUYzTG5KbGNHeGhZMlVvTDF4ekt5UXZMQ0FuSnlrN0NpQWdJQ0FnSUdOdmJuTjBJR2dnUFNCc2FXNWxMbTFoZEdOb0tDOWVJeU1qWEhNcktDNHJQeWxjY3lva0x5azdDaUFnSUNBZ0lHbG1JQ2hvS1NCN0lHTjFjaUE5SUhzZ2FXNXdkWFE2SUdoYk1WMHNJSE4xWjJkbGMzUnBiMjV6T2lCYlhTQjlPeUJsZUdGdGNHeGxjeTV3ZFhOb0tHTjFjaWs3DQpJR052Ym5ScGJuVmxPeUI5Q2lBZ0lDQWdJR052Ym5OMElHSWdQU0JzYVc1bExtMWhkR05vS0M5ZVhITXFMVnh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9ZaUFtSmlCamRYSXBJR04xY2k1emRXZG5aWE4wYVc5dWN5NXdkWE5vS0dKYk1WMHVjM0JzYVhRb0p5QXZJQ2NwTG1wdmFXNG9KeUFuS1NrN0NpQWdJQ0I5Q2lBZ0lDQnlaWFIxY200Z1pYaGhiWEJzWlhNdVptbHNkR1Z5S0NobEtTQTlQaUJsTG5OMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBK0lEQXBPd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNtSWpzaTV3ZzdJS3M3S0NFSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lYaHV5ZHRDRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z1cxMDdDaUFnZlFwOUNnb3ZMeURpbElEaWxJQWc3S2VBN0l1YzY2eTRJQ2pzaEp6cnNvUWdjbVZqYjIxdFpXNWs3Sm1BSU9xd21leWRnQ0RxdDV6c3Vaa2c0b0NVSU91dw0KbE9xK3VPdXB0Q0RxdDdqc3FyM3JqNFFnN1pXbzZydVlLU0RpbElEaWxJQUtMeThnN0pxcDdKYTA3S2VSS0dkc2IzTnpZWEo1TG0xa0tleWRnQ0RzbmJ6cnRvRHJuNndnN1pTRTY2R3M3WlNFN1lxNDdKZVFJT3lWaUNEcmhLUHJpcFRyaTZRb01qQXlOaTB3TnlEc2k2VHN1S0VwT2lEcmhLUHNuTHpycWJRZzdZRzA2NkdjNjVPYzZyQ0FJT3lhcWV5V3RDRHF0WkRzb0pYc25ZUUtMeThnN0tPOElPeWVoT3VzdE91aG5DRHNtS1R0bGJUdGxiUWdNK3F3bkNEc29KenNsWWpzbmJRZzdLQ0U2N2FBSUNMdGtaenF1TEFnNnJPZzdMbW9JQ3NnN0phMDdJaWNJT3V6Z09xeXZTTHNuYlFnNjVDYzY0dWtMaURzbDYzdGxhQWc2N2FFNjZhc0lPS0FsQW92THlEdGdiVHJvWnpyazV3Z1BTRHJyTGpzbnFVZzY0dWs2NU9zNnJpd0tPeXd2ZXlkbUNrc0lPeWFxZXlXdENEdGhyWHNuYnpDdCt1bm51eTJwT3V5bFNBOUlHTnZaR1V1ZEhNZ2NtVm1hVzVsUVdsVGRXZG5aWE4wYVc5dWN5RHRtNFRzc3BqcnBxd282cml3NnJPRTdLQ0INCktTNEtZMjl1YzNRZ1UxUlpURVZmVWxWTVJWTWdQU0JiQ2lBZ0p6RXVJTzJWdE95YWxPeXl0RG9nNjZxbzY1T2dJT3VzdU9xMXJPdUtsQ0R0bGJUc21wVHNzclRyb1p3dUlDanJzN1RyZzRYcmk0anJpNlRpaHBMcnM3VHJnclRzbXBRcEp5d0tJQ0FuTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNEb2c2NUNRN0phMDdKcVU0b2FTN1phSTdKYTA3SnFVTENCKzdKZUlJT3U1dk9xNHNDanJzSlRyZ0l6c2w0anNsclRzbXBUaWhwTHJzSlRxdjZqc2xyVHNtcFFwTGlEcmk2Z3NJT3lpaGV1ampNSzM2NmVNNjZPTXdyZnNsN0Rzc3JUQ3QrMlZ0T3luZ01LMzZyaXc2Nkdkd3JmcmhibnNuWXdnNjVPeElPeUxuT3lLcE8yRm5PeWR0Q0Rzbzd6c3NyVHNuYmdnNnJLdzZyTzg2NHFVSU95SW1PdVBtZTJZbFNEc25LRHNwNEFvN0pldzdMSzA2NCs4N0pxVUxDRHJoYm5zbll6cmo3enNtcFFwTGljc0NpQWdKek11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBNklDSis3WldnSU95SW1DRHNsNGJzbHJUc21wUWlJT3VNDQpnT3lMb0NBaWZ1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENJZzZyV3M3S0d3SU95YXNPeUVvQzRnNjR1b0xDRHNvSlhzc1lYc2c0RWc2N2FJNnJDQXdyZnNuYnpydG9BZzZyaXc2NHFsSU95Z25PMlZuTUszNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzZyS3c2ck84d3Jmc29KWHJzN1FnNjdPMDdaaTRJT3lWaU95THJPeWRnQ0RydG9Ec29KWHRtSlhzbkx6cm9ad2c2NnFGN1ptVjdaNklMaWNzQ2lBZ0p6UXVJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclE2SUg3dGxaanNpNXpxc3FEc2xyVHNtcFEvNG9hU2Z1MlZvT3E1ak95YWxEOHNJT3F6aE95TG5PdUxwT0tHa3V5ZWlPdUxwQ3dnN0plczdLMkk2NHVrNG9hUzdabVY3SjI0N1pXWTY0dWtMQ0RxdTVqaWhwTHNsNURxc293dUlIN3NpNXdnNjdtODZyaXc2ckNBSU95V3RPeURpZTJWbU91cHRDRHRqSXpzbFlYdGxaanJvS1RyaXBRZzdLQ1Y2N08wNjZXOElPeWp2T3lXdE91aG5DRHJyTGpzbnFYc25ZUWc2NHVrN0l1Y0lPeVR0T3VMcEM0bg0KTEFvZ0lDYzFMaURycW9Yc2dxd3I2NnFGN0lLc0lPcTRpT3luZ0RvZzdaV2M3SjZRN0phMDY2VzhJTzJTZ095V3RDRHJqNW5zZ3F6cm9ad283SjIwN0o2UUlPMlptT3UyaU95ZGhDRHJzSnZzbFpqc2xyVHNtcFRpaHBMc25iVHNucERycGJ3ZzY0K002NkNrNjdDYjdKV1k3SmEwN0pxVUtTd2c3TFdjN0lhTTdaV2NJSHZycW9Yc2dxeDk2ckNBSUh2cnFvWHNncXg5N1pXMDdJU2NJTzJZbGUyRG5PdWhuQ2pzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjNG9hUzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2t1Snl3S0lDQW5OaTRnN1pHYzZyaXdPaURya0pqc2xyVHNtcFRpaHBMcmo3enNtcFF1Snl3S0lDQW5OeTRnN0tTRUlPcTFyT3loc0RvZzdKdVE2N080N0oyMElPMlZuQ0RzcElUc25iVHJxYlFnN0xhVTdMS2M2NCtFSU91d21PdVRuT3lMbkNEdGxad2c3S1NFNjZHY0xpRHNub1Rzblpqcm9ad2c3S1NFN0oyRUlPdUttT3Vtck95bmdDRHNsWXJyaXBUcmk2UXVJT3VMcUN3ZzdKZXM2NStzSU91c3VPeWUNCnBleWRoQ0R0bFpqcmdwanNuWmdnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXljdk91aG5DRHRsYW5zczVBZzY0MlVJT3F3aE9xeXNPMlZ0T3luaE91THBPdXB0Q0RzcElRZzdJaVk2Nlc4SU95a2hPeWR0T3VLbENEcXNvUHNuWUFnN1ptWTdKaUJMaWNzQ2lBZ0p6Z3VJT3VMcE95ZHRPeVd2T3Vobk9xM3VDRHNtYnpzcXIwZzY3S0U3WXE4SU91ZHZPdXlxT3lkZ0NBaTY0dXI2cml3SWlqc3Q2anNob3dnNnJpSTdLZUFLUzRuTEFvZ0lDYzVMaURzbmJUcnBvVEN0K3lnaE8yWmxPdXlpTzJZdU1LMzY2ZUk3SXFrN1lLNTdKMkFJT3EzdU91TWdPdWhuQ0RyczdUc29iUXVJT3lDck91ZWpPeWRoQ0RydG9EcnBid2c2NVdRSU91TG1PeWRoQ0RydHBuc2w2enJqNFFnN0tLTDY0dWtMaWNzQ2lBZ0p6RXdMaURzb0p6dGtvZ2c3SnFwN0phMElPeWNvT3luZ0RvZzdKNkY2NkNsN0plUUlPeVRzT3lkdUNEcXVMRHJpcVhzaExFZzY2cUY3SUtzS091emdPcXl2U3dnN0tlQTdLQ1ZMQ0RyazdIcm9aMHNJTzJWdE95Z25DRHJrN0VwDQo2NHFVSU8yWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhleWR2Q0Rxc0lEcmlxWHNoTEhzbmJRZzY0YVM3Snk4NjYrQTY2R2NJT3lKck95YXRDRHJwNURyb1p3ZzY3Q1U2cjY0N0tlQUlPeVZpdXVLbE91THBDNGc3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyaTZUcnBiZ2c2NCtaN0lLczY2VzhJT3lEaU91aG5DRHJwNHpyazZUc3A0QWc3SldLNjRxVTY0dWtMaWNzQ2wwdWFtOXBiaWduWEc0bktUc0tDbU52Ym5OMElFVllRVTFRVEVWVElEMGdiRzloWkVWNFlXMXdiR1Z6S0NrN0Nnb3ZMeURpbElEaWxJQWc3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Rzb0lUcnJMZ2c2NkdjNjVPY0lDaDFlQzEzY21sMGFXNW5MbTFrSU9LQWxDRHNtSWpzbWJnZzZyZWM3TG1aSU95RXVPdTJnQ0RzaTV6cmdwanJwcXpzbUtUcXVZenNwNEFnN1pTRTY2R3M3WlNFN1lxNDdKZVFJTzJQck8yVnFDa2c0cFNBNHBTQUNpOHZJRk5VV1V4RlgxSlZURVZUSURFdzdLU0VJT3lhbE95VnZldW5qT3ljdk91aA0Kbk91S2xDRHNtSWpzbWJnZ01YNHpLT3lJbU91UG1lMllsY0szNnJLOTdKYTB3cmZydG9Ec29KWHRtSlVnN1plSTdKcXBJT3k4Z095ZHRPeUtwQ25zblpnZzY0bVk3SldaN0lxazZyQ0FJT3ljb095THBPdVFuT3VMcEM0S0x5OGc3WXlNN0oyODdKMjBJT3lYaHV5Y3ZPdXB0Q2pzaEtUc3VaanJzN2dnNnJXczY3S0U3S0NFSU91VHNTa2c2N21JSU91c3VPeWVrT3lYdENEaWdKUWc3SnFVN0pXOTY2ZU03Snk4NjZHY0lPdVBtZXlla1NobVlXbHNMWE52Wm5RcExncG1kVzVqZEdsdmJpQnNiMkZrUjNWcFpHVW9LU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZDFlQzEzY21sMGFXNW5MbTFrSnlrc0lDZDFkR1k0SnlrdWRISnBiU2dwT3dvZ0lDQWdjbVYwZFhKdUlHMWtMbXhsYm1kMGFDQStJREV3TUNBL0lHMWtJRG9nSnljN0NpQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdZMjl1YzI5c1pTNXMNCmIyY29KMXRpY21sa1oyVmRJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnNjZHYzY1T2NJT3lMcE8yTXFDQW83SnFVN0pXOTY2ZU03Snk4NjZHY0lPeW5oTzJXaVNrNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lISmxkSFZ5YmlBbkp6c0tJQ0I5Q24wS1kyOXVjM1FnUjFWSlJFVWdQU0JzYjJGa1IzVnBaR1VvS1RzS0NtWjFibU4wYVc5dUlHbHVjM1J5ZFdOMGFXOXVUV1Z6YzJGblpTZ3BJSHNLSUNCamIyNXpkQ0JtWlhkVGFHOTBJRDBnUlZoQlRWQk1SVk11YldGd0tDaGxlQ2tnUFQ0Z0owbHVjSFYwT2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb1pYZ3VhVzV3ZFhRcElDc2dKMXh1VDNWMGNIVjBPaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvWlhndWMzVm5aMlZ6ZEdsdmJuTXBLUzVxYjJsdUtDZGNiaWNwT3dvZ0lISmxkSFZ5YmlBb0NpQWdJQ0FuN0tlQTZyaUk2N2FBN1lTd0lPdUVpT3VLbENEc2w1RHNpcVRzbTVBb1V5MHhMQ0RyczdUc2xZanRtb3pzZ3F3cDdKMllJTzJWbk9xMXJleVd0Q0JWDQpXQ0JYY21sMGFXNW5JT3lnaE91c3VPcXdnT3VobkNEc25ienRsWnpyaTZRdUlDY2dLd29nSUNBZ0ordUN0T3F3Z0NCVlNTRHJyTGpxdGF6cnBid2c3WldZNjRLWTdKU3BJT3V6dE91Q3RPdXB0Q3dnN0pXRTY1NllJT3lLcE8yRGdPeWR2Q0RxdDV6c3VabnNsNUFnNjZlZTZyS01JT3VMcE91VHJPeWRnQ0RyaklEc2xZZ2dNK3F3bk91bHZDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNmc21wVHNzcTNyazZUc25ZQWc3SVNjNjZHY0lPdXN0T3EwZ08yVm5DRHJzNFRxc0p3ZzY2eTQ2cldzNjR1a0lPS0FsQ0RzbmJUc29JUWc2Nnk0NnJXczY2VzhJT3l3dU95aHNPMlZtT3luZ0NEcnA0anJuYnd1WEc0bklDc0tJQ0FnSUNmc201RHJucGdnN0oyWTY2KzQ3Sm1BSU91cXFPdVRvQ0Rzb0pYcnM3UW83SjIwNjZhRXdyZnNpS3ZzbnBEQ3QreWhzT3F4dE1LMzY0eUE3SU9CS2V1bHZDRHNuS0RzcDREdGxaanFzNkFzSU9xd2dTRHNvSnpzbFlqc25ZQWc3SnVRNjdPNDZyTzg2NCtFSU95RW5PdWhuT3laZ091UA0KaENEcmk2enJuYnpzbGJ3ZzdaV2M2NHVrTGlBbklDc0tJQ0FnSUNmc29iRHFzYlFnN1pHYzdaaUVLT3lkdE95RGdjSzM3SjIwN1pXWXdyZnNuYlRyZ3JUQ3QreTBpT3F6dk1LMzY2KzQ2NmVNd3JmcnRvRHRoTERDdCtxNWpPeW5nQ0RyazdFcDdKMkFJT3lnbGV5eGhTRHNvSlhyczdUcmk2UWc0b0NVSU91NXZPcXhzT3VDbUNEcmk2VHJwYmdnN0tHdzZyRzA3Snk4NjZHY0lPdXdsT3ErdU95bmdDRHJwNGpybmJ3b0lqWHRtb3dnN0oyMDdJT0JJdXlkaENBaU5lMmFqQ0xyb1p3ZzdLU0U3SjIwNjZtMElPeVlwT3VMdFNrdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95WGtDRHNsNGJyaXBRZzZyV3M3TEswSU95Z2xldXp0Q2pzb0lUdG1aVHJzb2p0bUxqQ3QxVlNUTUszNnJpSTdKV2h3cmZzaTV6cXNJUWc2NU94S2V5WmdDRHRsYlRxc3JBZzY3Q3A2N0tWd3Jmc29JanNzS2dvN0o2czdJU2s3S0NWd3JmcnJManNuWmpzc3BqQ3QreWVyT3lMbk91UGhDRHJrN0VwNjZXOElPeW5nT3lXdE91Q3RDRHJ0cG5zbmJUcmlwUWcNCjZyS0Q3SjJBSU95Z2lPdU1nQ0RxdUlqc3A0QWc0b0NVSU95VmhPdUtsQ0Rxc0pMc25iVHJuYnpyajRRc0lPcTN1T3VmdE91VHIrMlZ0T3VQaENEc2s3RHNwNEFnNjZlSTY1MjhMbHh1SnlBckNpQWdJQ0FuTStxd25DRHNvSnpzbFlqc25ZQWc3SVNjNjZHY0lPeWdrZXEzdk95ZHRDRHJpNnpybmJ6c2xid2c3WldjNjR1a0lPS0FsQ0R0bFpqcmdwanJpcFFnN0p1UTY2eTRJT3Exck95aHNPdWx2Q0RzbktEc3A0RHRsWndnN0xXYzdJYU1JT3VMcE91VHJPcTRzQ3dnN1pXWTY0S1k2NHFVSU91c3VPeWVwU0RxdGF6c29iRHJwYndnN0o2czZyV3M3SVN4N1pXY0lPdU1nT3lWaUN3Z0p5QXJDaUFnSUNBbjZyZTQ2NmFzNnJPZ0lPeWdnZXlXdE91UGhDRHRsWmpyZ3BqcmlwUWc2ck84NnJDUTdaV2NJT3llck9xMXJPeUVzVG9nN0tTUjY3TzFJTzJSbk8yWWhPeWRoQ0Ryalp6c2xyVHJnclRxczZBc0lPeWdsZXV6dENEc2lKenNoSnpycGJ3ZzdJS3M3SnFwN0o2UTZyQ0FJT3lWak95VmhPeVZ2Q0R0bGFBZzZyS0Q2N2FBDQo3WVN3NjZHY0lPeWVyT3loc095bmdlMlZvQ0Rxc29NdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95ZHRDRHRsYlRxc3JBZzY3Q3A2N0tWN0oyRUlPdUx0T3F6b0NEc25vanNuWVFnNjVXTTY2ZU1JQ0xzbHJUcmxydnFzb3dnN1pXWTY2bTBJT3VMcE95TG5DRHJrSnpyaTZRaTY2VzhJT3lWbnV5RXVPeWFzT3VLbENEcXVJM3NvSlh0bUpVZzdKNnM2cldzN0lTeDdKMkVJTzJWbU91ZHZDRGlnSlFnN0p1UTY2eTQ3SmVRSU8yVnRPcXlzT3l4aGV5ZHRDRHNsNGJzbkx6cnFiUWc2NmVNNjVPazdKYTBJT3UybWV5ZHRPeW5nQ0RycDRqcm5id3VJQ2NnS3dvZ0lDQWdKKzJSbk9xNHNNSzM3SnFwN0phMDY2ZU1JT3F6b095NW1PcXpvQ0RzbHJUc2lKenNuWVFnNjdDVTZyNjhJT3lnbGV1UGhPeWRtQ0Rzb0p6c2xZanNuWVFnTStxd25DRHJpcGpzbHJUcmhwUHNwNEFnNjZlSTY1MjhJT0tBbENEcXQ3anFzYlFnN0lLczdKcXA3SjZRN0plUTZyS01JT3kybE95eW5PeWR0Q0RzbFlUcmk0anJuYndnNnJXUTdLQ1Y3Snk4NjZHYw0KSU91enRPeWR1T3VMcEM0Z0p5QXJDaUFnSUNBbjdKV0U2NTZZSU95WWlPeUxuT3VUcE95ZGdDRHRsWndnN0tTRTdLZWM2NmFzSU95MW5PeUdqQ0RxdFpEc29KWHNuYlFnNjZlTzdLZUE2NmVNSU9xM3VPcXh0Q0R0aHFRbzdaVzA3SnFVN0xLMHdyZnFzcjNzbHJRcDdKMllJT3Exa091enVPeWR0T3luZ0NEc2hvenF0N25zaExIc25aZ2c2cldRNjdPNDdKMjBJT3lWaE91TGlPdUxwQ0RpZ0pRZzdKZXM2NStzSU91c3VPeWVwZXlubk91bXJDRHNub1hyb0tYc25ZQWc2Nm1VN0l1YzdLZUFJT3VMcU95Y2hPdWhuQ0RyaTZUc2k1d2c3SVNrNnJPRTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3V3c095WHRPdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZ3cmZzdlpUcms1enRqcHpzaXFRZzZyaUk3S2VBT2x4dUp5QXJDaUFnSUNBblczc2lkR1Y0ZENJNklDTHNvSnpzbFlnZzY2eTQ2cldzSUNqc3BJVHJzSlRxdjRqc25ZQWcNClhGeHVLU0lzSUNKeVpXRnpiMjRpT2lBaTY2eTA3SmVIN0oyRUlPeVpuQ0Ryc0pUcXY2anJpcFRzcDRBZzdaV2M2cld0N0phMElPMlZuQ0Ryckxqc25xVWlmU3dnTGk0dVhWeHVYRzRuSUNzS0lDQWdJQ2RiN0lxazdZT0E3SjI4SU9xM25PeTVtVjFjYmljZ0t5QlRWRmxNUlY5U1ZVeEZVeUFySUNkY2JseHVKeUFyQ2lBZ0lDQW9SMVZKUkVVZ1B5QW5XK3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJQ2gxZUMxM2NtbDBhVzVuTG0xa0tTRGlnSlFnN0p5RUlPcTNuT3k1bWV5ZG1DRHF0N3pxc2JEc21ZQWc3SmlJN0ptNElPeUxuT3VDbU91bXJPeVlwQzRnN1lxNTdaNklJT3lZaU95WnVDRHF0NXpzdVprbzdJaVk2NCtaN1ppVndyZnFzcjNzbHJUQ3QrdTJnT3lnbGUyWWxleWRoQ0RzbktEc3A0RHRsYlRzbGJ3ZzdaV1k2NHFVSU95RGdlMlpxU25zbllRZzZyZTQ2NHlBNjZHY0lPdVVzT3VsdE9xem9Dd2c3SnFVN0pXOTZyTzhJT3lnaE91c3VPeWR0Q0RyaTZUcnBiVHJxYlFnN0tDRTY2eTQ3SjJFDQpJT3VVc091bHVPdUxwRjFjYmljZ0t5QkhWVWxFUlNBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW9abVYzVTJodmRDQS9JQ2RiN0pxdzY2YXNJT3VxcWV5R2pPdW1yQ0RzbUlqc2k1d2c0b0NVSU95ZHRDRHRocVRzbllRZzY1U3c2Nlc4SU9xeWcxMWNiaWNnS3lCbVpYZFRhRzkwSUNzZ0oxeHVYRzRuSURvZ0p5Y3BJQ3NLSUNBZ0lDZnNwSURydVlUcmtKRHNuTHpycWJRZ0lrOUxJdXVkdk9xem9PdW5qQ0RyaTdYdGxaanJuYnd1SndvZ0lDazdDbjBLQ2k4dklPS1VnT0tVZ0NEc2c0SHNpNXdnNjR5QTZyaXdJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDbXhsZENCd2NtOWpJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDQWdMeThnN1lHMDY2R2M2NU9jSU8yVQ0KaE91aG5PeUV1T3lLcEFwc1pYUWdiR2x1WlVKMVppQTlJQ2NuT3lBZ0lDQWdJQ0FnSUM4dklITjBaRzkxZENEc3BJUWc2N0tFN1kyOENteGxkQ0IzWVdsMFpYSWdQU0J1ZFd4c095QWdJQ0FnSUNBZ0x5OGc3WmlFN0o2c0lPMkV0T3lkbUNCN0lISmxjMjlzZG1Vc0lISmxhbVZqZEN3Z2RHbHRaWElnZlFwc1pYUWdjWFZsZFdVZ1BTQlFjbTl0YVhObExuSmxjMjlzZG1Vb0tUc2dMeThnN0pxVTdMS3RJT3luZ2V1Z3JPMlpsQ0FvNjQrWjdJdWNJT3lhbE95eXJleWRnQ0RzaUp6c2hKenJqSURyb1p3cENteGxkQ0IwZFhKdWN5QTlJREE3Q214bGRDQjNZWEp0WldSVmNDQTlJR1poYkhObE93cHNaWFFnWTNWeWNtVnVkRTF2WkdWc0lEMGdRMHhCVlVSRlgwMVBSRVZNT3lBdkx5RHNwNERxdUlnZzdJUzQ3SVdZN0oyMElPdXN2T3F6b0NEc25vanJpcFFnNjZxbzY0MjRJQ2pzbXBUc3NxM3NuYlFnNjR1azY2VzRJT3VxcU91TnVPeWRoQ0RzcDREc29KWHRsWmpycWJRZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NrS0x5OGcNCjdJdWM3SjZSSU95TG5DQkRiR0YxWkdVZ1EyOWtaU2hqYkdGMVpHVWdRMHhKS2Vxd2dDRHNrN2dnN0lpWUlPeWVpT3VLbE95bmdDRHNvSkRxc29BZzRvQ1VJT3lYaHV5Y3ZPdXB0Q0F2YUdWaGJIUm82NkdjSU95VmpPdWdwQ0R0bEl6cm42enF0N2pzbmJqc25iUWc3SldJNjRLMDdaV2M2NHVrTGdvdkx5QnVkV3hzUGUyWmxleWR1Q0RzcEpFc0lDZHZheWM5N0lLczdKcXBJT3F3Z091S3BTd2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6MWpiR0YxWkdVZzY2cUY2NkM1SU95WGh1eWRqQ3dLTHk4Z0oyTnNZWFZrWlMxc2IyZHZkWFFuUFdOc1lYVmtaZXVLbENEc25vanNwNERycDR3ZzY2R2M2cmU0N0oyNElPeUV1T3lGbUNEcnA0enJvNHdnS08yRXRDRHNpNlR0aktnZzdJdWNJT3F3a095bmdDd2c3SVN4NnJPMUlPMkV0T3lkdENEc21LVHJxYlFnN0o2UTY0K1pJTzJWdE95Z25Da0tiR1YwSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0NpOHZJT3Vobk9xM3VPeWR1Q0RycDR6cm80d2c2ckNRN0tlQUlPS0FsQ0JEDQpURW5xc0lBZzY0SzA2NHFVSU95WWdleVd0Q0RzbmJqc3BwMGc3SmlrNjZXWTY2VzhJT3lDck91ZWpPeWR0Q0RzbFl6c2xZVHJrNlRzbllRZzdKV0k2NEswNjZHY0lPdXdsT3Erdk91THBDNEtMeThnS0dOc1lYVmtaU0F0TFhabGNuTnBiMjdzbllBZzY2R2M2cmU0N0oyNElPeVhodXlkdE91UGhDRHNoTEhxczdYdGxiVHNoSndnN0l1YzY0K1pJT3lna09xeWdPeWN2T3Vobk91S2xDRHJxcnNnN0o2aDZyT2dMQ0RzaTZUc29Kd2c3WVMwN0plUTdJU2M2NmVNSU91VG5PdWZyT3VDbk91THBDa0tMeThnSXV1bmpPdWpqQ0xycDR6c25iUWc3SldFNjR1STY1MjhJQ0x0bFp3ZzY3S0k2NCtFSU91aG5PcTN1T3lkdUNEc2xZZ2c3WldvSXV1UGhDRHFzSm5zbllBZzZySzk2NkdjNjZHY0lPeWVvZTJlaU91dmdPdWhuQ0RzcEpIcnByMGc3WkdjN1ppRTdKMkVJT3lUdE91THBBcGpiMjV6ZENCTVQwZEpUbDlIVlVsRVJTQTlJQ2Z0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0N0oyMElPMlZoT3lhbE8yVnRPeWFsQ2pzbFlnZw0KNjVDUTZyR3c2NEtZSU91bmpPdWpqQ2tnNG9DVUlGdnduNStnSU8yQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJnZzdaV0U3SnFVWFNEcnNvVHRpcnpzbllRZzY0aUU2NlcwNjZtMElPdWhuT3EzdU95ZHVDRHNzTDNzbllRZzdKZTA3SmEwNjVPYzY2Q2s3SnFVTGljN0NpOHZJT3lMcE95NG9lMlZuQ0RyckxqcXRhenJrNlE2SUNKR1lXbHNaV1FnZEc4Z1lYVjBhR1Z1ZEdsallYUmxPaUJQUVhWMGFDQnpaWE56YVc5dUlHVjRjR2x5WldRZ1lXNWtJR052ZFd4a0lHNXZkQ0JpWlNCeVpXWnlaWE5vWldRaUtPdW5qT3VqakNrc0NpOHZJQ0pPYjNRZ2JHOW5aMlZrSUdsdUlNSzNJRkJzWldGelpTQnlkVzRnTDJ4dloybHVJaWpycjdqcm9aenF0N2pzbmJncElPS0FsQ0Rya1pnZzY0dWtJT3llb2UyZWlPcXlqQ0RyaEpQdG5venJpNlFLWm5WdVkzUnBiMjRnYVhOQmRYUm9SWEp5YjNJb2N5a2dld29nSUhKbGRIVnliaUF2WVhWMGFHVnVkR2xqWVhSOGIyRjFkR2g4WVhCcElHdGxlWHhzYjJjZ1AybHVmR3h2WjJkbFpIeHoNClpYTnphVzl1SUdWNGNHbHlaV1F2YVM1MFpYTjBLRk4wY21sdVp5aHpLU2s3Q24wS0x5OGc2NkdjNnJlNDdKMjQ2NUNjSU9xemhPeWdsU0R0bVpYc25iZ2c0b0NVSUVOTVNlcXdnQ0IrTHk1amJHRjFaR1V1YW5OdmJ1eVhrQ0RxdUxEcm9aM3RsWmpyaXBRZ2IyRjFkR2hCWTJOdmRXNTBMbVZ0WVdsc1FXUmtjbVZ6Yyt1bHZDRHNuYjNzbHJRS0x5OGdMMmhsWVd4MGFPdWhuQ0RyaGJqc3RwenRsWnpyaTZRZ0tPMlVqT3Vmck9xM3VPeWR1T3lkdENBaTY0aUU2cldzSU9xemhPeWdsZXljdk91aG5DRHNrN0RyaXBRZzdLU1I3SjI0N0tlQUlpRHRrWnpzaTV3ZzRvQ1VJT3F6dGV5YXFTQlFRK3lYa095RW5DRHJncWpzblpnZzZyT0U3S0NWSU95WXBPeUNyT3lhcVNEcnNLbnNwNEFwTGdvdkx5RHRqSXpzbmJ6c25iUWc3WUcwSU95SW1DRHNub2pzbHJRbzdaU0U2NkdjN0tDZDdZcTRJT3lkdE91Z3BTRHRqNnp0bGFncElETXc3TFNJSU95NmtPeUxuQzRnN0o2czY2R2M2cmU0N0oyNDdaV1k2Nm0wSUVOTVNlcXdnQ0R0DQpqSXpzbmJ6c25ZUWc2ckN4N0l1ZzdaV1k2NitBNjZHY0lPeWVrT3VQbVNEcnNKanNtSUhya0p6cmk2UXVDbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93cG1kVzVqZEdsdmJpQmpiR0YxWkdWQlkyTnZkVzUwS0NrZ2V3b2dJR2xtSUNoRVlYUmxMbTV2ZHlncElDMGdZV05qYjNWdWRFTmhZMmhsTG1GMElEd2dNekF3TURBcElISmxkSFZ5YmlCaFkyTnZkVzUwUTJGamFHVXVaVzFoYVd3N0NpQWdiR1YwSUdWdFlXbHNJRDBnYm5Wc2JEc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdhaUE5SUVwVFQwNHVjR0Z5YzJVb1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxMbXB6YjI0bktTd2dKM1YwWmpnbktTazdDaUFnSUNCbGJXRnBiQ0E5SUNocUlDWW1JR291YjJGMWRHaEJZMk52ZFc1MElDWW1JR291YjJGMWRHaEJZMk52ZFc1MExtVnRZV2xzUVdSa2NtVnpjeWtnZkh3Z2JuVnNiRHNLSUNCOQ0KSUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyb1p6cXQ3anNuYmdnN0oyMDY2Q2xJT3lYaHV5ZGpDRHJrN0VnNG9DVUlHNTFiR3dnN0p5ZzdLZUFJQ292SUgwS0lDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUJFWVhSbExtNXZkeWdwTENCbGJXRnBiQ0I5T3dvZ0lISmxkSFZ5YmlCbGJXRnBiRHNLZlFwbWRXNWpkR2x2YmlCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BJSHNLSUNCamIyNXpkQ0J3Y205aVpTQTlJSE53WVhkdUtDZGpiR0YxWkdVbkxDQmJKeTB0ZG1WeWMybHZiaWRkTENCN0lITm9aV3hzT2lCMGNuVmxMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWWdmU2s3Q2lBZ2JHVjBJRzkxZENBOUlDY25Pd29nSUhCeWIySmxMbk4wWkc5MWRDNXZiaWduWkdGMFlTY3NJQ2hrS1NBOVBpQjdJRzkxZENBclBTQmtMblJ2VTNSeWFXNW5LQ2s3SUgwcE93b2dJSEJ5YjJKbExtOXVLQ2RsY25KdmNpY3NJQ2dwSUQwK0lIc2dZMnhoZFdSbFUzUmhkSFZ6SUQwZ0oyTnNZWFZrWlMxdGFYTnphVzVuSnpzZ2ZTazcNCkNpQWdjSEp2WW1VdWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNoamIyUmxJRDA5UFNBd0lDWW1JQzljWkN0Y0xseGtLeTh1ZEdWemRDaHZkWFFwS1NBL0lDZHZheWNnT2lBblkyeGhkV1JsTFcxcGMzTnBibWNuT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSUVOc1lYVmtaU0JEYjJSbElPeWdrT3F5Z0RvZ0p5QXJJR05zWVhWa1pWTjBZWFIxY3lBcklDaHZkWFFnUHlBbklDZ25JQ3NnYjNWMExuUnlhVzBvS1NBcklDY3BKeUE2SUNjbktTazdDaUFnZlNrN0NuMEtMeThnN0xLWTY2YXNJTzJZaE8yWnFTRGlnSlFnTDJobFlXeDBhT3VobkNEcmhianN0cHp0bGJRZ0l1eWdsZXVua0NEdGdiVHJvWnpyazV6cXNJQWc2NHUxN1phSTY0cVU3S2VBSWlEcnNKYnNsNURzaEp3ZzdabVY3SjI0N1pXZ0lPeUltQ0Rzbm9qcXNvd2c3WldjNjR1a0NtTnZibk4wSUhOMFlYUnpJRDBnZXlCelpYSjJaV1E2SURBc0lHeGhjM1JCZERvZ0p5Y3NJR3hoDQpjM1JVWlhoME9pQW5KeXdnYkdGemRGTmxZem9nSnljZ2ZUc0tDaTh2SU9LVWdPS1VnQ0R0bEl6cm42enF0N2pzbmJnZzdJT2Q3S0cwSU9xd2tPeW5nQ2pzaTZ6c25xWHJzSlhyajVrcElPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0Fvdkx5RHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY1YWdJT3llaU91S2xDRHJqNW5zbFlnZ1kyOWtaUzUwYytxd2dDQTE3TFNJNjZlSTY0dWtJRkJQVTFRZ0wyaGxZWEowWW1WaGRPdWx2Q0RyczdUcmdyanJpNlF1Q2k4dklPMlZuQ0Ryc29qc25iVHJuYnpyajRRZzY3Q2I3SjJBSU91U3BDQXpNT3kwaU9xd2hDRHJnWXJxdUxEcnFiUWc3WlNNNjUrczZyZTQ3SjI0S091WWtPdUtsQ0R0bEx6cXQ3anJwNGdwN0oyMElPdUxxKzJlakNEcXNvTWc0b0NVSU8yQnRPdWhuT3VUbk9xNWpPeW5nQ0RyamJEcnBxenFzNkFnNnJDWg0KN0oyMElPcTZ2T3luaE91THBDNEtMeThnN0pXRTdLZUJJTzJWbkNEcnNvanJqNFFnNjZxN0lPdXdtK3lWbU95Y3ZPdXB0Q2pyaTZUcnBxenJwNHdnNjZpODdLQ0FJT3k4b0NEc2c0SHRnNXdzSU95ZWtPdVBtZXlMbk95ZWtTRHJrN0VwSU9xemhPeUdqU0RyaklEcXVMRHRsWnpyaTZRdUNtTnZibk4wSUVoRlFWSlVRa1ZCVkY5RVJVRkVYMDFUSUQwZ016QXdNREE3Q214bGRDQnNZWE4wUW1WaGRDQTlJREE3Q25ObGRFbHVkR1Z5ZG1Gc0tDZ3BJRDArSUhzS0lDQnBaaUFvYkdGemRFSmxZWFFnSmlZZ1JHRjBaUzV1YjNjb0tTQXRJR3hoYzNSQ1pXRjBJRDRnU0VWQlVsUkNSVUZVWDBSRlFVUmZUVk1wSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJenJuNnpxdDdqc25iZ2c3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTVnQ0RpZ0pRZzdaUzg2cmU0NjZlSUwrMlVqT3Vmck9xM3VPeWR1T3lkdENEcmk2dnRub3dnNnJLRDdKeTg2NkdjSU91enRPcXpvQ0Rxc0puc25iUWc2cnE4N0tlUjY0dUkNCjY0dWtMaWNwT3dvZ0lDQWdjSEp2WTJWemN5NWxlR2wwS0RBcE95QXZMeUJsZUdsMElPMlZ1T3VUcE91ZnJPcXdnQ0JyYVd4c1VISnZZK3ljdk91aG5DQmpiR0YxWkdVZzdZcTQ2NmFzNjZXOElPeWdsZXVtck8yVm5PdUxwQW9nSUgwS2ZTd2dOVEF3TUNrN0Nnb3ZMeURyb1p6cXQ3anNuYmdnVlZKTTdKMkVJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSUFvNjdPMDdZYTFJT3l3dlNucm9ad2c3SmVzNjRxVUlFSlNUMWRUUlZJZzdaVzQ2NU9rNjUrc0lPeUtwTzJCck91bXZlMkt1T3VsdkNEcnA0enJrNkRyaTZRdUNpOHZJR05zWVhWa1pTQkRURW5yaXBRZ1FsSlBWMU5GVWlEdG1aanFzcjNyczREc2lKanJwYndnN0tHMDdLU1I3WlcwSU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzcDRIc29KRWc3SmUwN0tlQUlPeVZpdXF6b0NEc25iUWc3SXFrN1lHczY2YTk3WXE0N0plUUlHRjFkR2h2Y21sNlpTQlZVa3pzbllRZzY0U1k2cmkwNjR1a0tPeUxwT3k0b1NBeU1ESTJMVEEzS1M0S0x5OGdiVzlrWlQwbmMzZHBkR05vDQpKeWpxczRUc29KVWc3S0NFN1ptWUtTRGlocElnN0lxNTdKMjRJTzJabE91cHRPeWRoQ0Rxc2JEc3VaanNwNEFnN0pXSzZyT2dJQ29xNnJPRTdLQ1ZJT3lFb08yRG5TRHRtWlRycWJUc25MenJvWndnNjdDVTY2R2NLaW9nNjdPMDY0SzQ2NHVrTGdvdkx5QWdJT3Vobk9xM3VPeWR1T3VRbkNEc2c0SHRnNXpycWJRZ1lYVjBhRzl5YVhwbDZyQ0FJT3lLdWV5ZHVDRHRtWlRycWJUc25MenJvWndnNnJDQTZyT2dJSE5sYkdWamRFRmpZMjkxYm5ROWRISjFaY0szY0hKdmJYQjBQWE5sYkdWamRGOWhZMk52ZFc1MDY2R2M2NCtFSU91cXV5RHJtcXZzbkx6cnI0RHJvWndvN0l1azdMaWhLU3dLTHk4Z0lDRHRsWndnN1lPdElPeVZpT3lYa095RW5DQmpiR0YxWkdVdVlXa3ZiRzluYjNWMFAzSmxkSFZ5YmxSdlBUeDFjbXd0Wlc1amIyUmxaQ0F2YjJGMWRHZ3ZZWFYwYUc5eWFYcGxQMUZWUlZKWktPeURnZXVNZ09xeXZldWhuQ2srNjZHY0lPeWVoK3VLbE91THBEb0tMeThnSUNEcm9aenF0N2pzbFlUc200TW83SVM0N0lXWQ0KSU95bmdPeWJnQ2tnNG9hU0lHeHZaMmx1UDNObGJHVmpkRUZqWTI5MWJuUTlkSEoxWlNqcXM0VHNvSlVnN0lTZzdZT2RLZXVobkNEc25wRHJqNWtnN0xLMDdKMjA2NHVkS095THBPeTRvVG9nNjR1bzdKMjhJTzJEclNrdUlPeUt1ZXlkdUNEdG1aVHJxYlFnN1pXWTY0dW9DaTh2SUNBZ1crcXpoT3lnbFNEc29JVHRtWmhkSU91eWhPMkt2T3lkdENEdGxaanJpcFFnN0oyODZyTzhJT3F3bWV5ZGdDRHFzckRxczd3ZzRvQ1VJT3VMcE91bmpDRHNtckRycHF6cXNJQWc2ck9uN0o2bElPcTN1Q0R0bVpUcnFiVHNuTHpyb1p3ZzY3TzA2NEs0NjR1a0xnb3ZMeUFnSUNqcnRvRHNucEhzbXFrNklPdTRqT3Vkdk95YXNPeWdnT3lkbUNCamJHRjFaR1V1WVdrZzdKdTVJT3Vobk9xM3VPeWR1T3VQaENEdGtvRHJwcndnNG9DVUlPcXpoT3lnbFNEc29JVHRtWmdnN0oyWTY0K0U3Sm1BSU91d3FlMldwZXlkdENEcXNKbnNsWVFnN0lpWTdKcXBMaWtLTHk4Z2JXOWtaVDBuYm05eWJXRnNKeWpycDR6cm80d2c3SjZzNjZHYzZyZTQNCjdKMjRLU0RpaHBJZzY2R2M2cmU0N0pXRTdKdURJT3lYaHV5ZHRDRHF0N2pyZzZVZzdKZXc2NHVrS091TWdPcXduQ0Rxc0puc25ZQWc2ck9FN0tDVjdKMjA2NTI4SU95RXVPeUZtQ0RzbktEc3A0RHFzSUFnNjdtZzY2YUVLUzRLWm5WdVkzUnBiMjRnZDNKcGRHVkNjbTkzYzJWeVNHRnVaR3hsY2lodGIyUmxLU0I3Q2lBZ1kyOXVjM1FnYkc5bmIzVjBJRDBnYlc5a1pTQTlQVDBnSjNOM2FYUmphQ2M3Q2lBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzS0lDQWdJR052Ym5OMElHTnRaQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFluSnZkM05sY2kwbklDc2diVzlrWlNBcklDY3VZMjFrSnlrN0NpQWdJQ0JqYjI1emRDQndjeUE5SUd4dloyOTFkQW9nSUNBZ0lDQS9JQ0lrZFQwa1pXNTJPa05DWDFWU1REc2dKR2s5SkhVdVNXNWtaWGhQWmlnbmIyRjFkR2d2WVhWMGFHOXlhWHBsSnlrN0lHbG1LQ1JwSUMxblpTQXdLWHNnDQpKSEpsYkQwbkx5Y3JKSFV1VTNWaWMzUnlhVzVuS0NScEtUc2dKR1Z1WXoxYlUzbHpkR1Z0TGxWeWFWMDZPa1Z6WTJGd1pVUmhkR0ZUZEhKcGJtY29KSEpsYkNrN0lGTjBZWEowTFZCeWIyTmxjM01nS0Nkb2RIUndjem92TDJOc1lYVmtaUzVoYVM5c2IyZHZkWFEvY21WMGRYSnVWRzg5Snlza1pXNWpLU0I5SUdWc2MyVWdleUJUZEdGeWRDMVFjbTlqWlhOeklDUjFJSDBpQ2lBZ0lDQWdJRG9nSjFOMFlYSjBMVkJ5YjJObGMzTWdKR1Z1ZGpwRFFsOVZVa3duT3dvZ0lDQWdabk11ZDNKcGRHVkdhV3hsVTNsdVl5aGpiV1FzSUNkQVpXTm9ieUJ2Wm1aY2NseHVjMlYwSUNKRFFsOVZVa3c5Slg0eElseHlYRzV3YjNkbGNuTm9aV3hzSUMxT2IxQnliMlpwYkdVZ0xVVjRaV04xZEdsdmJsQnZiR2xqZVNCQ2VYQmhjM01nTFVOdmJXMWhibVFnSWljZ0t5QndjeUFySUNjaVhISmNiaWNwT3dvZ0lDQWdjbVYwZFhKdUlHTnRaRHNLSUNCOUNpQWdZMjl1YzNRZ2MyZ2dQU0J3WVhSb0xtcHZhVzRvYjNNdWRHMXdaR2x5S0Nrcw0KSUNkamJHRjFaR1V0WW5KcFpHZGxMV0p5YjNkelpYSXRKeUFySUcxdlpHVWdLeUFuTG5Ob0p5azdDaUFnWTI5dWMzUWdibTlrWlVKcGJpQTlJSEJ5YjJObGMzTXVaWGhsWTFCaGRHZzdJQzh2SU95Z2hDQlBVK3lYa0NCdWIyUmxJT3llaU95ZGpDanJpNlRycHF6cXNJQWdibTlrWmV1aG5DRHJqNDRwTGlEcnM0RHRtWmdnN0l1azdZeW9JT3lMbkNEc201RHJzN2dnVlZKTUlPcTN1T3VNZ091aG5DRHNsN0RyaTZRb1ptRnBiQzF6YjJaMEtTNEtJQ0JqYjI1emRDQmliMlI1SUQwZ2JHOW5iM1YwQ2lBZ0lDQS9JQ2NqSVM5aWFXNHZjMmhjYmljZ0t3b2dJQ0FnSUNBblZUMGtLQ0luSUNzZ2JtOWtaVUpwYmlBcklDY2lJQzFsSUZ3blkyOXVjM1FnZFQxd2NtOWpaWE56TG1GeVozWmJNVjA3WTI5dWMzUWdhVDExTG1sdVpHVjRUMllvSW05aGRYUm9MMkYxZEdodmNtbDZaU0lwTzNCeWIyTmxjM011YzNSa2IzVjBMbmR5YVhSbEtHazhNRDkxT2lKb2RIUndjem92TDJOc1lYVmtaUzVoYVM5c2IyZHZkWFEvY21WMGRYSnUNClZHODlJaXRsYm1OdlpHVlZVa2xEYjIxd2IyNWxiblFvSWk4aUszVXVjMnhwWTJVb2FTa3BLVnduSUNJa01TSWdNajR2WkdWMkwyNTFiR3dwWEc0bklDc0tJQ0FnSUNBZ0oyOXdaVzRnSWlSN1ZUb3RKREY5SWx4dUp3b2dJQ0FnT2lBbkl5RXZZbWx1TDNOb1hHNXZjR1Z1SUNJa01TSmNiaWM3Q2lBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloemFDd2dZbTlrZVNrN0NpQWdabk11WTJodGIyUlRlVzVqS0hOb0xDQXdiemMxTlNrN0NpQWdjbVYwZFhKdUlITm9Pd3A5Q2dvdkx5RHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU8yVWhPdWhuT3lFdU95S3BDQW9ZMnhoZFdSbElHRjFkR2dnYkc5bmFXNGdMUzFqYkdGMVpHVmhhU2tnNG9DVUlDOXZjR1Z1TFd4dloybHU3SjIwSU95RG5leUVzY0szNnJTQTY2YXNMZ292THlEcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHJzN1RyZ3JUc3BJUWc2NVdNNnJtTTdLZUFJT3lJcU95V3RPeUVuQ0RyaklEcXVMRHRsWmpyDQppNlRxc0lBc0lPeVpoT3Vqak91UW1PdXB0Q0RzaXFUc2lxVHJvWndnNjRHZDY0S2M2NHVrTGdwc1pYUWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVM1JoY25SbFpFRjBJRDBnTURzZ0x5OGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVnN0l1YzZyQ0JJT0tBbENEc25xenRnYlRycHEzc25iUWdKK3llck95TG5PdVBoQ2ZzbmJqc3A0QWdKK3lla091UG1leVpoT3VqakNEc2k2VHRqS2duN0oyNDdLZUFJT3Exck91MmhPMlZuT3VMcEFwbWRXNWpkR2x2YmlCcmFXeHNURzluYVc1UWNtOWpLQ2tnZXdvZ0lHbG1JQ2hzYjJkcGJsQnliMk5VYVcxbGNpa2dleUJqYkdWaGNsUnBiV1Z2ZFhRb2JHOW5hVzVRY205alZHbHRaWElwT3lCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUc1MWJHdzdJSDBLSUNCcFppQW9JV3h2WjJsdVVISnZZeWtnY21WMGRYSnVPd29nSUdOdmJuTjBJSEFnUFNCc2IyZHBibEJ5YjJNNw0KQ2lBZ2JHOW5hVzVRY205aklEMGdiblZzYkRzS0lDQjBjbmtnZXdvZ0lDQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZDNhVzR6TWljcElIc0tJQ0FnSUNBZ2MzQmhkMjVUZVc1aktDZDBZWE5yYTJsc2JDY3NJRnNuTDFCSlJDY3NJRk4wY21sdVp5aHdMbkJwWkNrc0lDY3ZWQ2NzSUNjdlJpZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lIUnllU0I3SUhCeWIyTmxjM011YTJsc2JDZ3RjQzV3YVdRc0lDZFRTVWRVUlZKTkp5azdJSDBnWTJGMFkyZ2dLRjlsTWlrZ2V5QndMbXRwYkd3b0tUc2dmUW9nSUNBZ2ZRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3VzdE95TG5DQXFMeUI5Q24wS0NtWjFibU4wYVc5dUlHdHBiR3hRY205aktDa2dld29nSUdsbUlDaHdjbTlqS1NCN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdJQ0FnSUM4dklITm8NClpXeHNPblJ5ZFdYcm9ad2c2NTJFN0p1TTdJU2NJSEJ5YjJQc25ZQWdZMjFrSU9xN2pldU5zT3E0c0NEaWdKUWdMMVRyb1p3ZzdZcTQ2NmFzN0tlNElPeWp2ZXlYck95VnZDRHNwNFRzcDV3Z1kyeGhkV1JsNnJDQUlPcXpvT3lWaE91aG5DRHNsWWdnNjRLbzY0cVU2NHVrQ2lBZ0lDQWdJQ0FnTHk4Z0tPcXpvT3lWaENCamJHRjFaR1hxc0lBZzdJU2s3TG1ZSU8yTWpPeWR2T3lkaENEcnJMenFzNkFnN0o2STdKeTg2Nm0wSU8yQnRPdWhuT3VUbkNEc2xiRWc3SmVGNjQydzdKMjA3WXE0NnJDQUlDTHNncXpzbXFrZzdLU1JJdXljdk91aG5DRHJwNG50bnBncENpQWdJQ0FnSUNBZ2MzQmhkMjVUZVc1aktDZDBZWE5yYTJsc2JDY3NJRnNuTDFCSlJDY3NJRk4wY21sdVp5aHdjbTlqTG5CcFpDa3NJQ2N2VkNjc0lDY3ZSaWRkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnlCOUtUc0tJQ0FnSUNBZ2ZTQmxiSE5sSUhzS0lDQWdJQ0FnSUNBdkx5QnRZV05QVXkvcnBxenJpSVhzaXFRNklITm9aV3hzT25SeWRXWHJuYndnDQpjSEp2WSt5ZHRDQnphQ0RxdTQzcmpiRHF1TERzbmJ3ZzdJaVlJT3llaU95ZGpDRGlnSlFnYzNSaGNuUlFjbTlqN0oyWUlHUmxkR0ZqYUdWazY2R2NJT3Vuak91VG9Bb2dJQ0FnSUNBZ0lDOHZJTzJVaE91aG5PeUV1T3lLcENEcXQ3anJvN2tvTFhCcFpDbnNuWVFnN1lhMTdLZTQ2NkdjSU95Z2xldW1yTzJWbk91THBDQW9kR0Z6YTJ0cGJHd2dMMVFnNjR5QTdKMlJLUW9nSUNBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0hKdll5NXdhV1FzSUNkVFNVZFVSVkpOSnlrN0lIMGdZMkYwWTJnZ0tGOWxNaWtnZXlCd2NtOWpMbXRwYkd3b0tUc2dmUW9nSUNBZ0lDQjlDaUFnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRb2dJSDBLSUNCd2NtOWpJRDBnYm5Wc2JEc0tJQ0IzWVhKdFpXUlZjQ0E5SUdaaGJITmxPd29nSUdsbUlDaDNZV2wwWlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0hkaGFYUmxjaTUwYVcxbGNpazdJSGRoYVhSbGNpNXlaV3BsWTNRb2JtVjNJRVZ5Y205eQ0KS0NmdGdiVHJvWnpyazV3ZzdJUzQ3SVdZN0oyMElPeWloZXVqak91UWtPeVd0T3lhbEM0bktTazdJSGRoYVhSbGNpQTlJRzUxYkd3N0lIMEtmUW9LWm5WdVkzUnBiMjRnYzNSaGNuUlFjbTlqS0NrZ2V3b2dJR3RwYkd4UWNtOWpLQ2s3Q2lBZ2JHbHVaVUoxWmlBOUlDY25Pd29nSUhSMWNtNXpJRDBnTURzS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RzaTV6cmo1a2c3S1NSNG9DbUlDanJxcWpyamJnNklDY2dLeUJqZFhKeVpXNTBUVzlrWld3Z0t5QW5LU2NwT3dvZ0lHTnZibk4wSUhSb2FYTlFjbTlqSUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbkxYQW5MQ0FuTFMxdGIyUmxiQ2NzSUdOMWNuSmxiblJOYjJSbGJDd2dKeTB0YVc1d2RYUXRabTl5YldGMEp5d2dKM04wY21WaGJTMXFjMjl1Snl3Z0p5MHRiM1YwY0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzSUNjdExYWmxjbUp2YzJVblhTd2dld29nSUNBZ2MyaGxiR3c2SUhSeWRXVXMNCklHTjNaRG9nUlUxUVZGbGZRMWRFTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzQ2lBZ0lDQmtaWFJoWTJobFpEb2djSEp2WTJWemN5NXdiR0YwWm05eWJTQWhQVDBnSjNkcGJqTXlKeXdnTHk4Z1VFOVRTVmc2SU95ZWtPcTRzQ0R0bElUcm9aenNoTGpzaXFRZzZyZTQ2Nk81SU95RG5leUVzU0RpZ0pRZ2EybHNiRkJ5YjJQc25iUWc2cmU0NjZPNTdLZTRJT3lnbGV1bXJPMlZvQ0RzaUpnZzdKNkk2cktNQ2lBZ2ZTazdDaUFnY0hKdll5QTlJSFJvYVhOUWNtOWpPd29nSUhCeWIyTXVjM1JrYjNWMExtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc0tJQ0FnSUd4cGJtVkNkV1lnS3owZ1pDNTBiMU4wY21sdVp5Z25kWFJtT0NjcE93b2dJQ0FnYkdWMElHbGtlRHNLSUNBZ0lIZG9hV3hsSUNnb2FXUjRJRDBnYkdsdVpVSjFaaTVwYm1SbGVFOW1LQ2RjYmljcEtTQWhQVDBnTFRFcElIc0tJQ0FnSUNBZ1kyOXVjM1FnYkdsdVpTQTlJR3hwYm1WQ2RXWXVjMnhwWTJVb01Dd2dhV1I0S1M1MGNtbHRLQ2s3Q2lBZ0lDQWdJR3hwDQpibVZDZFdZZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0dsa2VDQXJJREVwT3dvZ0lDQWdJQ0JwWmlBb0lXeHBibVVwSUdOdmJuUnBiblZsT3dvZ0lDQWdJQ0JzWlhRZ1pYWWdQU0J1ZFd4c093b2dJQ0FnSUNCMGNua2dleUJsZGlBOUlFcFRUMDR1Y0dGeWMyVW9iR2x1WlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUdOdmJuUnBiblZsT3lCOUNpQWdJQ0FnSUdsbUlDaGxkaUFtSmlCbGRpNTBlWEJsSUQwOVBTQW5jbVZ6ZFd4MEp5QW1KaUIzWVdsMFpYSXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emRDQjNJRDBnZDJGcGRHVnlPd29nSUNBZ0lDQWdJSGRoYVhSbGNpQTlJRzUxYkd3N0NpQWdJQ0FnSUNBZ1kyeGxZWEpVYVcxbGIzVjBLSGN1ZEdsdFpYSXBPd29nSUNBZ0lDQWdJR2xtSUNobGRpNXBjMTlsY25KdmNpa2dld29nSUNBZ0lDQWdJQ0FnWTI5dWMzUWdjbUYzSUQwZ1UzUnlhVzVuS0dWMkxuSmxjM1ZzZENCOGZDQmxkaTV6ZFdKMGVYQmxJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlNREFwT3dvZ0lDQWdJQ0FnSUNBZw0KYVdZZ0tHbHpRWFYwYUVWeWNtOXlLSEpoZHlrcElIc0tJQ0FnSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMk5zWVhWa1pTMXNiMmR2ZFhRbk95QXZMeUF2YUdWaGJIUm82NkdjSU8yVWpPdWZyT3EzdU95ZHVPeVhrQ0RzbFl6cnByd2c0b2FTSU91eWhPMkt2T3lkdENCYjY2R2M2cmU0N0oyNElPMlZoT3lhbEYzcm9ad2c2N0NVNjRDY0NpQWdJQ0FnSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0oyNElPdW5qT3VqakNEcXNKRHNwNEE2Snl3Z2NtRjNLVHNLSUNBZ0lDQWdJQ0FnSUNBZ2R5NXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtFeFBSMGxPWDBkVlNVUkZLU2s3Q2lBZ0lDQWdJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9KKzJCdE91aG5PdVRuQ0RzbUtUcnBaZzZJQ2NnS3lCeVlYY3BLVHNLSUNBZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWcNCklDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMjlySnpzZ0x5OGc3SVN4NnJPMUlEMGc3SVNrN0xtWXdyZnJvWnpxdDdqc25iZ2c2NHVrSU95Z2xleURnU0RpZ0pRZzdKYTA2NWFrSUhCeWIySnNaVzNzbmJUcms2QWc3WlcwN0tDY0lDanNucXpyb1p6cXQ3anNuYmd2N0o2czdJU2s3TG1ZSU91enRlcTNnQ2tLSUNBZ0lDQWdJQ0FnSUhjdWNtVnpiMngyWlNoVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElDY25LU2s3Q2lBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0I5Q2lBZ0lDQjlDaUFnZlNrN0NpQWdjSEp2WXk1emRHUmxjbkl1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ2N5QTlJR1F1ZEc5VGRISnBibWNvSjNWMFpqZ25LUzUwY21sdEtDazdDaUFnSUNCcFppQW9jeUFtSmlBaGN5NXBibU5zZFdSbGN5Z25SR1Z3Y21WallYUnBiMjVYWVhKdWFXNW5KeWtwSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQmpiR0YxWkdVZ2MzUmtaWEp5T2ljc0lITXVjMnhwWTJVb01Dd2dNakF3DQpLU2s3Q2lBZ2ZTazdDaUFnY0hKdll5NXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdMeThnN0oyMDY2KzRJT3lEaUNEc2hManNoWmpzbkx6cm9ad2c2cldRN0xLMDY1Q2NJT3VTcENEc21Kc2c3SVM0N0lXWTdKMjBJT3VMcSsyZWpDRHFzYkRycWJRZzY2eTA3SXVjSUNqcnFxanJqYmdnN0tDRTdabVlJT3lMbkNEc2c0Z2c3SVM0N0lXWTdKMkVJT3lqdmV5ZHRPeW5nQ0RzbFlycXNvd3BDaUFnSUNCcFppQW9jSEp2WXlBaFBUMGdkR2hwYzFCeWIyTXBJSEpsZEhWeWJqc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c3SVM0N0lXWUlPeWloZXVqakNBb1kyOWtaU0FuSUNzZ1kyOWtaU0FySUNjcElPS0FsQ0RyaTZUc25Zd2c3SnFVN0xLdElPdVZqQ0RyaTZUc2k1d2c3SXVjNjQrWjdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0I5S1RzS2ZRb0tablZ1WTNScGIyNGdjMlZ1WkZSMWNtNG9kR1Y0ZENrZ2V3b2dJSEpsZEhWeQ0KYmlCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpTd2djbVZxWldOMEtTQTlQaUI3Q2lBZ0lDQnBaaUFvSVhCeWIyTXBJSEpsZEhWeWJpQnlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lYaHV5V3RPeWFsQzRuS1NrN0NpQWdJQ0JwWmlBb2QyRnBkR1Z5S1NCeVpYUjFjbTRnY21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN0pXZTdJU2dJT3lhbE95eXJleWR0Q0RzcDRUdGxva2c3S1NSN0oyMDdKZVE3SnFVTGljcEtUc0tJQ0FnSUdOdmJuTjBJSFJwYldWeUlEMGdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0aExRZzdJdWM2ckNFSU95MGlPcXp2Q0RpZ0pRZzdJUzQ3SVdZN0oyRUlPeWVyT3lMbk95ZWtlMlZxZXVMaU91THBDNG5LVHNLSUNBZ0lDQWdhMmxzYkZCeWIyTW9LVHNLSUNBZ0lIMHNJRlJWVWs1ZlZFbE5SVTlWVkY5TlV5azdDaUFnSUNCM1lXbDBaWElnUFNCN0lISmxjMjlzZG1Vc0lISmwNCmFtVmpkQ3dnZEdsdFpYSWdmVHNLSUNBZ0lIQnliMk11YzNSa2FXNHVkM0pwZEdVb1NsTlBUaTV6ZEhKcGJtZHBabmtvZXlCMGVYQmxPaUFuZFhObGNpY3NJRzFsYzNOaFoyVTZJSHNnY205c1pUb2dKM1Z6WlhJbkxDQmpiMjUwWlc1ME9pQjBaWGgwSUgwZ2ZTa2dLeUFuWEc0bkxDQW5kWFJtT0NjcE93b2dJSDBwT3dwOUNnb3ZMeURxc0puc25ZQWc2Nnk0NnJXczY2VzhJT3VxaHlEcnNvanNwN2dnNjZ5NzY0cVU3S2VBSU9xNHNPeVd0U0RpZ0pRZzdKNnM3SnFVN0xLdDdKMjA2Nm0wSUNMc25iVHNvSVRxczd3ZzY0dWs2Nlc0SU95RGlDRHNvSnpzbFlnaTdKMkVJT3lhbE9xMXJPMlZuT3VMcEFvdkx5QW83SldJSU9xM3VPdWZyT3VwdENEdGdiVHJvWnpyazV6cXNJQWc3SVN4N0l1azdaV1k2cktNSU9xd21leWRnQ0RyaTdYc25ZUWc2NWlRSU91Q3RPeUVuQ0JiUVVrZzdMYVU3TEtjSU91TmxDRHJzSnZxdUxCZDZyQ0FJT3VzdE95ZG1PdXZ1TzJWdE95bmhPdUxwQ2tLWTI5dWMzUWdZWE5yWldSRGIzVnVkQ0E5DQpJRzVsZHlCTllYQW9LVHNLQ2k4dklPeUV1T3lGbUNEc3BJRHJ1WVFvN0l1YzY0K1pLK3luZ095TG5PdXN1Q0Rzbzd6c25vVXA2Nlc4SU91enRPeWVwZTJWbkNEcmtxUWc3WldjSU8yRXRDRHNpNlR0bG9rZzRvQ1VJT3VxcU91VG9DRHRtTGpzdHB6c25ZQWdjWFZsZFdYcm9ad2c3S2VCNjZDczdabVVMZ292THlCdGIyUmxiT3lkaENEc283enJxYlFnNnJlNElPdXFxT3VOdU91aG5DQW82NHVrNjZXMDY2bTBJT3lFdU95Rm1DRHNucXpzaTV6c25wRXBMaUR0bFp3ZzY2cW82NDI0N0oyRUlPcXpoT3lHalNEc2s3RHJxYlFnN0o2czdJdWM3SjZSN0oyQUlPeTFuT3kwaUNBeDdacU02NytRTGdwbWRXNWpkR2x2YmlCeWRXNVVkWEp1S0dKMWFXeGtRWE5yTENCdGIyUmxiQ2tnZXdvZ0lHTnZibk4wSUdwdllpQTlJSEYxWlhWbExuUm9aVzRvWVhONWJtTWdLQ2tnUFQ0Z2V3b2dJQ0FnYVdZZ0tHMXZaR1ZzSUNZbUlFRk1URTlYUlVSZlRVOUVSVXhUTG1sdVpHVjRUMllvYlc5a1pXd3BJQ0U5UFNBdE1TQW1KaUJ0YjJSbA0KYkNBaFBUMGdZM1Z5Y21WdWRFMXZaR1ZzS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJxcWpyamJnZzY3T0E2cks5T2lBbklDc2dZM1Z5Y21WdWRFMXZaR1ZzSUNzZ0p5RGlocElnSnlBcklHMXZaR1ZzS1RzS0lDQWdJQ0FnWTNWeWNtVnVkRTF2WkdWc0lEMGdiVzlrWld3N0NpQWdJQ0FnSUhOMFlYSjBVSEp2WXlncE95QXZMeURzZzRnZzY2cW82NDI0NjZHY0lPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdUxwT3lkakNEc200enJzSTNzbDRYc2w1RHNoSndnN0tlQTdJdWM2Nnk0SU95ZXJPeWp2T3llaFNrS0lDQWdJSDBLSUNBZ0lHbG1JQ2gwZFhKdWN5QStQU0JOUVZoZlZGVlNUbE1nZkh3Z0lYQnliMk1wSUhOMFlYSjBVSEp2WXlncE93b2dJQ0FnYVdZZ0tDRjNZWEp0WldSVmNDa2dld29nSUNBZ0lDQmpiMjV6ZENCME1DQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQWdJR0YzWVdsMElITmxibVJVZFhKdUtHbHVjM1J5ZFdOMGFXOXVUV1Z6YzJGblpTZ3BLVHNLSUNBZ0lDQWcNCmQyRnliV1ZrVlhBZ1BTQjBjblZsT3dvZ0lDQWdJQ0IwZFhKdWN5c3JPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0lTNDdJV1lJT3lrZ091NWhDRHNtWVRybzR3Z0tDY2dLeUFvS0VSaGRHVXVibTkzS0NrZ0xTQjBNQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwSUNzZ0ozTXBJT0tBbENEc25iVHRtNFFnN0pxVTdMS3Q3SjJBSU91NXFPdWR2T3lhbEM0bktUc0tJQ0FnSUgwS0lDQWdJSFIxY201ekt5czdDaUFnSUNCeVpYUjFjbTRnYzJWdVpGUjFjbTRvWW5WcGJHUkJjMnNvS1NrN0NpQWdmU2s3Q2lBZ0x5OGc3WldjSU95YWxPeXlyZXlkdENEc2k2VHRqS2p0bGJUcmo0UWc2NHVrN0oyTUlPeWFsT3l5cmV5ZHRDRHNuYlRzbHJUc3A0RHJqNFRyb1owZzdZR1E2NHFVSU8yVnJleURnU0RzaExIcXM3WHNuTHpyb1p3ZzdLQ1Y2NmFzQ2lBZ2NYVmxkV1VnUFNCcWIySXVZMkYwWTJnb0tDa2dQVDRnZTMwcE93b2dJSEpsZEhWeWJpQnFiMkk3Q24wS0NpOHZJT3VzdU9xMXJDRHN0cFRzDQpzcHdnN1lTMENtWjFibU4wYVc5dUlHRnphME5zWVhWa1pTaDBaWGgwTENCdGIyUmxiQ2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lHTnZibk4wSUdGMGRHVnRjSFFnUFNBb1lYTnJaV1JEYjNWdWRDNW5aWFFvZEdWNGRDa2dmSHdnTUNrZ0t5QXhPd29nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvZEdWNGRDd2dZWFIwWlcxd2RDazdDaUFnSUNCcFppQW9ZWE5yWldSRGIzVnVkQzV6YVhwbElENGdNakF3S1NCaGMydGxaRU52ZFc1MExtTnNaV0Z5S0NrN0lDOHZJT3VzdE8yVm5PMmVpQ0RzakpQc25iVHNwNEFnN0pXSzZyS01DaUFnSUNCeVpYUjFjbTRnWVhSMFpXMXdkQ0ErSURFS0lDQWdJQ0FnUHlBbjZyQ1o3SjJBSU91c3VPcTFyT3VsdkNEcmk2VHNpNXdnN0pxVTdMS3Q3WldjNjR1a0xpRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3lnaE95WGtDRHNvSnpzbFlqdGxvanJqWmdnNnJLRDY1T2s2ck84SU9xeXVleTVtT3luZ0NEc2xZcnJpcFFzSU9xMXJPeWhzT3VDbUNEcw0KbHJUdG5KanFzSUFnN1ptVjdJdWs3WjZJSU91THBPdWx1Q0RzZzRqcm9aenNtclFnNjR5QTdKV0lJRFBxc0p6cnBid2c2cmVjN0xtWjY0eUE2NkdjSUVwVFQwNGc2N0N3N0plMDY2R2M2NmVNT2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb2RHVjRkQ2tLSUNBZ0lDQWdPaUFuNjR1azdKMk1JRlZKSU91c3VPcTFyT3lkbUNEcmpJRHNsWWdnTStxd25PdWx2Q0RxdDV6c3VabnJqSURyb1p3Z1NsTlBUaURyc0xEc2w3VHJvWnpycDR3NklDY2dLeUJLVTA5T0xuTjBjbWx1WjJsbWVTaDBaWGgwS1RzS0lDQjlMQ0J0YjJSbGJDazdDbjBLQ2k4dklPdXlpT3lYclNEdGhMUWc0b0NVSU9xd21leWRnQ0RzaExqc2haanNuWVFnN0pPdzY1Q1lMQ0RzbmJUcnNvZ2c3WVMwNjZlTUlPeTJsT3l5bkNEdG1KWHNpNTBvU2xOUFRpRHJzTERzbDdRcElPdU1nT3lMb0NEcnNvanNsNjBnN1ppVjdJdWRLRXBUVDA0ZzZyQ2Q3TEswS2V5ZGhDRHNtcFRxdGF6dGxaenJpNlFLWm5WdVkzUnBiMjRnWVhOclZISmhibk5zWVhSbEtIUmwNCmVIUXNJRzF2WkdWc0tTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z0tBb2dJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnNjdLSTdKZXRJT3lla2V5WGhleWR0T3VMcENBbzY2eTQ2cldzSU91THBPdVRyT3E0c0NEc2xZVHJpNWdnNG9DVUlPdU1nT3lWaUNBejZyQ2NJT3Ezbk95NW1leWRnQ0RzbmJUcnNvZ2c3WVMwN0plUUlPeWdnZXlhcWUyVm1PeW5nQ0RzbFlycmlwVHJpNlFwTGlBbklDc0tJQ0FnSUNmcmk2VHNuWXdnVlVrZzY2eTQ2cldzNnJDQUlPMlZuT3ExcmV5V3RPdXB0Q0RzbnBEc2w3RHNpcVRybjZ6c21yUWc3SmlCN0phMDY2R2NMQ0RzbUlIc2xyVHJxYlFnN0o2UTdKZXc3SXFrNjUrczdKcTBJTzJWbk9xMXJleVd0T3VobkNEcnNvanNsNjN0bFpqcm5id3VJQ2NnS3dvZ0lDQWdKMVZKSU91c3VPcTFyT3VMcE95YXRDRHFzSVRxc3JEdGxad2c3WkdjN1ppRTdKMkVJT3lUc09xem9Dd2c3SjIwNjZhRXdyZnNpS3ZzbnBEQ3QrdW5pT3lLcE8yQ3VjSzM3WlNNNjZDSTdKMjA3SXFrDQo3Wm1BNjQyVTY0cVVJT3EzdU91TWdPdWhuQ0RyczdUc29iVHRsWnpyaTZRdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95ZG1DRHNwSVFnN0lpWTY2VzhJT3EzdU91TWdPdWhuQ0RzbktEc3A0RHRsWnpyaTZRZzRvQ1VJT3lia091c3VPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPdXlpT3lYcmV1UGhDRHRsWndnN0tTRTY2R2NMQ0RzcElUcnNKVHF2NGpzbllRZzdKNkU3SjJZNjZHY0lPeTJsT3F3Z08yVm1PeW5nQ0RzbFlycmlwVHJpNlF1SUNjZ0t3b2dJQ0FnSit1THRleWRnQ0Ryc0pqcms1enNpNXdnU2xOUFRpRHFzSjNzc3JRZzdaV1k2NEtZNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9VZzZyaUk3S2VBT2lBbklDc0tJQ0FnSUNkN0luUnlZVzV6YkdGMFpXUWlPaUFpNjdLSTdKZXQ2Nnk0SUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSmthWEpsWTNScGIyNGlPaUFpYTIvaWhwSmxiaURybUpEcmlwUWdaVzdpaHBKcmJ5SjlPaUFuSUNzZ1NsTlBUaTV6ZEhKcA0KYm1kcFpua29kR1Y0ZENrS0lDQXBMQ0J0YjJSbGJDazdDbjBLQ2k4dklPdU1nTzJabE8yWWxTRHJyTGpxdGF3ZzdLQ2M3SjZSSU8yRXRDRGlnSlFnN0lLczdKcXA3SjZRNnJDQUlPeURnZTJacWV5ZGhDRHNoS1RycW9YdGxaanJxYlFnNjZlbDY1Mjk3SmVRSU91bm51dUtsQ0RyckxqcXRhenJwYndnNjZlTTY1T2s3SmEwN0tTQTY0dWtMZ292THlCdFpYTnpZV2RsY3pvZ1czdHliMnhsT2lkMWMyVnlKM3duWVhOemFYTjBZVzUwSnl3Z2RHVjRkSDFkSU95Z2hPeXl0Q0RyaklEdG1aVHJwYndnNjZlazY3S0lJT3V3bSt1S2xPdUxwQ2pyaTZUcnBxenJpcFFnNjZ5MDdJT0I3WU9jSU9LQWxBb3ZMeURzbTR6cnNJM3NsNFVnN0tlQTdJdWM2Nnk0N0oyWUlDTHNtcFRzc3Ezcms2VHNuWUFnN0lTYzY2R2NJT3VzdE9xMGdDSWc3S0NFN0tDYzY2VzhJT3luZ08yQ3BPcTRzQ0RzbklUdGxiUWc2NHlBN1ptVUlPdW5wZXVkdmV5ZGhDRHRoTFFnN0pXSTdKZVFJT3VxdmV1VmhTRHNpNlByaXBUcmk2UXBMZ3BtZFc1amRHbHYNCmJpQmhjMnREYjIxd2IzTmxLRzFsYzNOaFoyVnpMQ0J0YjJSbGJDa2dld29nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJSFJ5WVc1elkzSnBjSFFnUFNBb2JXVnpjMkZuWlhNZ2ZId2dXMTBwTG0xaGNDZ29iU2tnUFQ0S0lDQWdJQ0FnS0cwdWNtOXNaU0E5UFQwZ0oyRnpjMmx6ZEdGdWRDY2dQeUFuN0phMDdJdWM3SXFrN1lTMDdZcTRPaUFuSURvZ0oreUNyT3lhcWV5ZWtEb2dKeWtnS3lCVGRISnBibWNvYlM1MFpYaDBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXhOVEF3S1FvZ0lDQWdLUzVxYjJsdUtDZGNiaWNwT3dvZ0lDQWdjbVYwZFhKdUlDZ0tJQ0FnSUNBZ0oreWR0T3V5aUNEc21wVHNzcTNzbllBZ0l1dU1nTzJabE8yWWxTRHJyTGpxdGF3ZzdLQ2M3SjZSSXV5ZHRPdUxwQ0FvNnJpdzdLRzBJT3VzdU9xMXJDRHJpNlRyazZ6cXVMQWc3SldFNjR1WUlPS0FsQ0RzbFlUcm5wZ2c2NHlBN1ptVTZyQ0FJT3lkdE91eWlDRHRoTFRzblpnZzdLQ0U3TEswSU91bnBldWR2ZXlkDQp0T3VMcENrdUlDY2dLd29nSUNBZ0lDQW43SUtzN0pxcDdKNlE2ckNBSU8yWmxPdXB0Q0RzZzRIdG1hbkN0K3VucGV1ZHZleWRoQ0RzaEtUcnFvWHRsWmpycWJRc0lPeUtwTzJEZ095ZHZDRHF0NXpzdVpucXM3d2c3SmlJN0l1Y0lPMkdwT3lYa0NEcnA1N3JpcFFnVlVrZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2NmVsNjUyOTdKMjBJT3VzdU9xMXJPdWx2Q0RzazdEcXVMRHNsNUFnNjdhQTdLR3g3WldZNjZtMEtPeVd0T3VLa0NEdG1aVHJxYlRzbmJqc3A0QXNJT3VzdE95S3FDRHNnNEh0bWFuc25ianNwNEFnNjVPeEtTRHF2SzBnN1pXRTdKcVU3WldjSU9xeWd5QXg2ckNBN0tlQTY2ZU1JT3lucCtxeWpDRHJrSmpyckx6c2xyVHJuYnd1SU95ZHRPdVZqQ0J6ZFdkblpYTjBhVzl1Yyt1S2xDRHJ1WWdnNjdDdzdKZTBMbHh1SnlBckNpQWdJQ0FnSUNjdElPdXN1T3Exck91bHZDRHNvSnpzbFlqdGxhQWc2NVdRSU95RW5PdWhuQ0Rzb0pIcQ0KdDd6c25iUWc2NHVrNjZXNElESitNK3F3bkM0ZzZyQ0JJT3lnbk95VmlPeVhsQ0RzbVp3ZzZyZTQ2NkNINnJLTUlPeU52T3VLbE95bmdDRHNuYlRzbktEcnBid2c2N2FaN0oyNDY0dWtMbHh1SnlBckNpQWdJQ0FnSUNjdElPeUNyT3lhcWV5ZWtPcXdnQ0RzbHJqcXVJbnRsWmpzcDRBZzdKV0s3SjJBSU9xMXJPeXl0Q0Rzb0pYcnM3UW83S0NFN1ptVTY3S0k3Wmk0d3JkVlVrekN0K3E0aU95Vm9jSzM3WnFmN0lpWUlPdVRzU25ycGJ3ZzdLZUE3SmEwNjRLMElPdUVvK3luZ0NEcnA0anJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc3WnVFN0lhTklPeWFsT3l5clNnaTY0MlVJT3lucCtxeWpDSXNJQ0xyc29UdGlyenNtcW5zbkx6cm9ad2lJT3VUc1Nuc25iVHJxYlFnN0tlQjdLQ0VJT3lnbk95VmlPeWRoQ0RxdDdnZzY3Q3A3WmFsN0p5ODY2R2NJT3F6b095emtDRHJpNlRzaTV3ZzdLQ2M3SldJN1pXWTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNmcmk3WHNuWUFnNjdDWTY1T2M3SXVjSUVwVFQwNGc2ckNkN0xLMElPMlYNCm1PdUNtT3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUxwT3lhdE1LMzdJU2s2NnFGSU9xNGlPeW5nRG9nSnlBckNpQWdJQ0FnSUNkN0luSmxjR3g1SWpvZ0l1dU1nTzJabENEc25aSHJpN1VnN1pXYzY1R1FJT3VzdU95ZXBTQW83WlcwN0pxVTdMSzBLU0lzSUNKemRXZG5aWE4wYVc5dWN5STZJRnQ3SW5SbGVIUWlPaUFpNjZ5NDZyV3NJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKeVpXRnpiMjRpT2lBaTdKMjA3SnlnSU8yVm5DRHJyTGpzbnFVaWZWMTlYRzVjYmljZ0t3b2dJQ0FnSUNBblcrdU1nTzJabEYxY2JpY2dLeUIwY21GdWMyTnlhWEIwQ2lBZ0lDQXBPd29nSUgwc0lHMXZaR1ZzS1RzS2ZRb0tMeThnNjR5QTdabVU3WmlWSU95Z25PeWVrU0RzblpIcmk3WHNsNURzaEp3Z2UzSmxjR3g1TENCemRXZG5aWE4wYVc5dWMxdGRmU0RzdHBUc3Rwd2dLT3k5bE91VG5PMk9uT3lLcE1LMzdKV2U2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3BDbVoxYm1OMGFXOXVJSEJoY25ObFEyOXRjRzl6DQpaU2h5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYSHRiWEhOY1UxMHFYSDB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93b2dJQ0FnWTI5dWMzUWdjbVZ3YkhrZ1BTQlRkSEpwYm1jb0tHOGdKaVlnYnk1eVpYQnNlU2tnZkh3Z0p5Y3BMblJ5YVcwb0tUc0tJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ1FYSnlZWGt1YVhOQmNuSmhlU2h2SUNZbUlHOHVjM1ZuWjJWemRHbHZibk1wQ2lBZ0lDQWdJRDhnYnk1emRXZG5aWE4wYVc5dWN3b2dJQ0FnSUNBZ0lDQWdMbTFoY0Nnb2VDa2dQVDRnS0hzZ2RHVjRkRG9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VkR1Y0ZENrZ2ZId2dKeWNwTG5SeQ0KYVcwb0tTd2djbVZoYzI5dU9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmU2twQ2lBZ0lDQWdJQ0FnSUNBdVptbHNkR1Z5S0NoNEtTQTlQaUI0TG5SbGVIUXBDaUFnSUNBZ0lEb2dXMTA3Q2lBZ0lDQnBaaUFvY21Wd2JIa2dmSHdnYzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvS1NCeVpYUjFjbTRnZXlCeVpYQnNlU3dnYzNWbloyVnpkR2x2Ym5NZ2ZUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURzbFlUcm5wanJvWndnS2k4Z2ZRb2dJSEpsZEhWeWJpQnVkV3hzT3dwOUNnb3ZMeURyc29qc2w2MGc3SjJSNjR1MTdKZVE3SVNjSUh0MGNtRnVjMnhoZEdWa0xDQmthWEpsWTNScGIyNTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa0tablZ1WTNScGIyNGdjR0Z5YzJWVWNtRnVjMnhoZEdVb2NtRjNLU0I3Q2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmcNCllDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXg3VzF4elhGTmRLbHg5THlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnZJRDBnU2xOUFRpNXdZWEp6WlNoektUc0tJQ0FnSUdOdmJuTjBJSFJ5WVc1emJHRjBaV1FnUFNCVGRISnBibWNvS0c4Z0ppWWdieTUwY21GdWMyeGhkR1ZrS1NCOGZDQW5KeWt1ZEhKcGJTZ3BPd29nSUNBZ2FXWWdLSFJ5WVc1emJHRjBaV1FwSUhKbGRIVnliaUI3SUhSeVlXNXpiR0YwWldRc0lHUnBjbVZqZEdsdmJqb2dVM1J5YVc1bktDaHZJQ1ltSUc4dVpHbHlaV04wYVc5dUtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwN0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3SldFNjU2WTY2R2NJQ292SUgwS0lDQnlaWFIxY200Z2JuVnNiRHNLZlFvS0x5OGc3SjJSNjR1MTdKZVE3SVNjSUh0MFpYaDBMQ0J5WldGemIyNTlJT3V3DQpzT3lYdENEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxVM1ZuWjJWemRHbHZibk1vY21GM0tTQjdDaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXhiVzF4elhGTmRLbHhkTHlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQmhjbklnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ2FXWWdLRUZ5Y21GNUxtbHpRWEp5WVhrb1lYSnlLU2tnZXdvZ0lDQWdJQ0J5WlhSMWNtNGdZWEp5Q2lBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIc2dkR1Y0ZERvZ1UzUnlhVzVuS0NoNElDWW1JSGd1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lCVA0KZEhKcGJtY29LSGdnSmlZZ2VDNXlaV0Z6YjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcENpQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb2VDa2dQVDRnZUM1MFpYaDBLVHNLSUNBZ0lIMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURzbFlUcm5wanJvWndnS2k4Z2ZRb2dJSEpsZEhWeWJpQmJYVHNLZlFvS0x5OGc2NkdjNnJlNDdKMjRJTzJWaE95YWxDRHNnNEh0ZzV6c25id2c2NVdNSUM5b1pXRnNkR2dnN0tHdzdacU02ckNBSU95WXBPdXB0Q0Rya3FUc2w1RHNoSndnN0p1TTY3Q043SmVGN0oyRUlPdUxwT3lMbkNEc2k1enJqNFR0bGJUcnM3anJpNlFnS0RNdzdMU0k3SmVRSURIcnNvanJwNHdwTGdvdkx5RHNoTEhxczdYdGxaanJxYlFnNnJLdzZyTzhJTzJWdU91VHBPdWZyT3F3Z0NCamJHRjFaR1ZUZEdGMGRYTTlKMjlySit1aG5DRHJrSmpyajR6cnBxenJyNERyb1p3c0lPeWVyT3Vobk9xM3VPeWR1Q0R0bTRRZzY3S0U3WXE4N0oyMElPeWdnT3lnaU91aG5DRHduNStpN0p5ODY2R2NJT3V6dGVxM2dPMlYNCm5PdUxwQzRLTHk4Z0tPMlVqT3Vmck9xM3VPeWR1T3lkdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHNDRHJrcVFnN0tPODZyaXc3S0NCN0p5ODY2R2NJQzlvWldGc2RHanJwYndnN0tHdzdacU03WldZNjRxVUlPcXlnK3F6dkNEc3A1M3NuWVFnN0oyMDY2T3M2NHVrS1Fwc1pYUWdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEMGdNRHNLWm5WdVkzUnBiMjRnY21WMGNubEJkWFJvU1daT1pXVmtaV1FvS1NCN0NpQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QWhQVDBnSjJOc1lYVmtaUzFzYjJkdmRYUW5LU0J5WlhSMWNtNDdDaUFnYVdZZ0tIZGhhWFJsY2lCOGZDQkVZWFJsTG01dmR5Z3BJQzBnYkdGemRFRjFkR2hTWlhSeWVVRjBJRHdnTXpBd01EQXBJSEpsZEhWeWJqc2dMeThnN0tlRTdaYUpJT3lra1NEdGhMUWc2N0NwN1pXMElPcTRpT3luZ0NBcklETXc3TFNJSU9xd2hPcXlxUW9nSUd4aGMzUkJkWFJvVW1WMGNubEJkQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkDQpJT3Vobk9xM3VPeWR1Q0RzbnF6dG1aWHNuYmdnN0l1YzY0K0U0b0NtSnlrN0NpQWdjblZ1VkhWeWJpZ29LU0E5UGlBbjY2R2M2cmU0N0oyNElPMlpsZXlkdU95YXFleWR0T3VMcEM0Z0lrOUxJdXVkdk9xem9PdW5qQ0RyaTdYdGxaanJuYnd1SnlrdWRHaGxiaWdLSUNBZ0lDZ3BJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25iZ2c3Wm1WN0oyNDY1Q29JT0tBbENEc29KWHNnNEVnN0lPQjdZT2M2NkdjSU91enRlcTNnQzRuS1N3S0lDQWdJQ2hsS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0pXRTdLZUJJT3Vobk9xM3VPeWR1Q0RzbFlnZzY1Q29PaWNzSUZOMGNtbHVaeWhsTG0xbGMzTmhaMlVwTG5Oc2FXTmxLREFzSURnd0tTa0tJQ0FwT3dwOUNnb3ZMeURzaTZUdGpLZ2c3SjJSNjR1MTdKMkVJT3lDck91ZWpPeWFxU0RzbFlqcmdyVHJvWndnNjdPQTdabVlJT0tBbENEc201RHNuYmdvNjZHYzZyZTQ3SjI0TCt5RXBPeTVtQ25zbmJRZzdZeU03SldGNjVDYw0KSU9xeXZleWFzT3lYbENEcXQ3Z2c3SldJNjRLMDY2VzhMQ0RzbFlUcmk0anJxYlFnN0tDUjY1R1E3SmEwSyt5YmtPdXN1T3lkaENEcnM3VHJncmpyaTZRS1puVnVZM1JwYjI0Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENCd2NtVm1hWGdwSUhzS0lDQnBaaUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQVDA5SUV4UFIwbE9YMGRWU1VSRktTQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ1RFOUhTVTVmUjFWSlJFVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiRzluYjNWMEp5QjlPd29nSUdsbUlDaGpiR0YxWkdWVGRHRjBkWE1nUFQwOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljcElIc0tJQ0FnSUhKbGRIVnliaUI3SUdWeWNtOXlPaUFuN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbEtHTnNZWFZrWlNucXNJQWc3SVNrN0xtWTY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUWc0b0NVSU95RXBPeTVtTzJWbU9xem9DRHJvWnpxdDdqc25ianRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3MNCklIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1WnljZ2ZUc0tJQ0I5Q2lBZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUhCeVpXWnBlQ0FySUNobElDWW1JR1V1YldWemMyRm5aU0EvSUdVdWJXVnpjMkZuWlNBNklGTjBjbWx1WnlobEtTa2dmVHNLZlFvS1puVnVZM1JwYjI0Z2NtVmhaRUp2Wkhrb2NtVnhLU0I3Q2lBZ2NtVjBkWEp1SUc1bGR5QlFjbTl0YVhObEtDaHlaWE52YkhabEtTQTlQaUI3Q2lBZ0lDQnNaWFFnWW05a2VTQTlJQ2NuT3dvZ0lDQWdjbVZ4TG05dUtDZGtZWFJoSnl3Z0tHTXBJRDArSUhzZ1ltOWtlU0FyUFNCak95QjlLVHNLSUNBZ0lISmxjUzV2YmlnblpXNWtKeXdnS0NrZ1BUNGdld29nSUNBZ0lDQjBjbmtnZXlCeVpYTnZiSFpsS0VwVFQwNHVjR0Z5YzJVb1ltOWtlU2twT3lCOUlHTmhkR05vSUNoZlpTa2dleUJ5WlhOdmJIWmxLSHQ5S1RzZ2ZRb2dJQ0FnZlNrN0NpQWdmU2s3Q24wS0NtTnZibk4wSUVOUFVsTmZTRVZCUkVWU1V5QTlJSHNLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0DQpRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MU5aWFJvYjJSekp6b2dKMGRGVkN3Z1VFOVRWQ3dnVDFCVVNVOU9VeWNzQ2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVWhsWVdSbGNuTW5PaUFuUTI5dWRHVnVkQzFVZVhCbEp5d0tmVHNLWm5WdVkzUnBiMjRnYW5OdmJpaHlaWE1zSUhOMFlYUjFjeXdnYjJKcUtTQjdDaUFnY21WekxuZHlhWFJsU0dWaFpDaHpkR0YwZFhNc0lFOWlhbVZqZEM1aGMzTnBaMjRvZXlBblEyOXVkR1Z1ZEMxVWVYQmxKem9nSjJGd2NHeHBZMkYwYVc5dUwycHpiMjQ3SUdOb1lYSnpaWFE5ZFhSbUxUZ25JSDBzSUVOUFVsTmZTRVZCUkVWU1V5a3BPd29nSUhKbGN5NWxibVFvU2xOUFRpNXpkSEpwYm1kcFpua29iMkpxS1NrN0NuMEtDbU52Ym5OMElITmxjblpsY2lBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtHRnplVzVqSUNoeVpYRXNJSEpsY3lrZ1BUNGdld29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBbg0KVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMGRGVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5b1pXRnNkR2duS1NCN0NpQWdJQ0J5WlhSeWVVRjFkR2hKWms1bFpXUmxaQ2dwT3lBdkx5RHJvWnpxdDdqc25iZ2c3WldFN0pxVUlPeURnZTJEbk91cHRDRHNucXp0bVpYc25iZ2c3SXVjNjQrRUlPS0FsQ0RzbnF6cm9aenF0N2pzbmJqc25iUWc2NEdkNjRLczdKeTg2Nm0wSU91THBPeWRqQ0Rzb2JEdG1venJ0b0R0aExBZ2NISnZZbXhsYmV5ZHRDRHRrb0RycHJEcmk2UUtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdDaUFnSUNBZ0lHOXJPaUIwY25WbExDQmxibWRwYm1VNklDZGpiR0YxWkdVbkxDQjJPaUJDVWtsRVIwVmZWaXdnWkdseU9pQmZYMlJwY201aGJXVXNJQzh2SUhiQ3QyUnBjam9nNnJXczY3S0U3S0NFTCt5WGlldWENCnNlMlZuQ0RzZ3F6cnM3anNuYlFnNjVhZ0lPeWVpT3VLbE95bmdDRHNwNFRyaTZqc21xa0tJQ0FnSUNBZ2JXOWtaV3c2SUdOMWNuSmxiblJOYjJSbGJDd2diVzlrWld4ek9pQkJURXhQVjBWRVgwMVBSRVZNVXl3Z1pYaGhiWEJzWlhNNklFVllRVTFRVEVWVExteGxibWQwYUN3Z1ozVnBaR1U2SUVkVlNVUkZMbXhsYm1kMGFDd2djbVZoWkhrNklIZGhjbTFsWkZWd0xBb2dJQ0FnSUNCd2NtOWliR1Z0T2lBb1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBbmIyc25JSHg4SUdOc1lYVmtaVk4wWVhSMWN5QTlQVDBnYm5Wc2JDa2dQeUJ1ZFd4c0lEb2dZMnhoZFdSbFUzUmhkSFZ6TEFvZ0lDQWdJQ0JoWTJOdmRXNTBPaUJqYkdGMVpHVkJZMk52ZFc1MEtDa3NDaUFnSUNBZ0lITmxjblpsWkRvZ2MzUmhkSE11YzJWeWRtVmtMQ0JzWVhOMFFYUTZJSE4wWVhSekxteGhjM1JCZEN3Z2JHRnpkRlJsZUhRNklITjBZWFJ6TG14aGMzUlVaWGgwTENCc1lYTjBVMlZqT2lCemRHRjBjeTVzWVhOMFUyVmpMQW9nSUNBZ2ZTazdDaUFnDQpmUW9nSUM4dklPMlVqT3Vmck9xM3VPeWR1Q0RzaTZ6c25xWHJzSlhyajVrZzRvQ1VJT3VCaXVxNHNPdXB0Q0RzbklRZzZyQ1E3SXVjSU8yRGdPeWR0T3VvdU9xd2dDRHJpNlRycHF6cnBid2c2NEdJNjR1a0NpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyaGxZWEowWW1WaGRDY3BJSHNLSUNBZ0lHeGhjM1JDWldGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJSDBLSUNBdkx5RHJvWnpxdDdqc25iZ2c0b0NVSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGM0N0MXZ3bjVTUlhTRHJzb1R0aXJ6c25iUWc3Wmk0N0xhYzdaV2M2NHVrTGdvZ0lDOHZJT3E0c091enVDanJ1SXpybmJ6c21yRHNvSUFnN0tlQjdaYUpLVG9nWUdOc1lYVmtaU0JoZFhSb0lHeHZaMmx1SUMwdFkyeGhkV1JsWVdsZw0KNjZXOElPeUlxT3lkZ0NEdGxJVHJvWnpzaExqc2lxVHJvWndnN0l1azdaYUpJT0tBbENEcnFaVHJpYlFnN0plRzdKMjBJT3F6cCt5ZXBTRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA2ck9nTEFvZ0lDOHZJQ0FnYkc5allXeG9iM04wSU95SW1PeUxvQ0R0ajZ6dGlyanJvWndnNnJLdzZyTzg2Nlc4SU95ZWtPdVBtU0RzaUpqcm9MbnRsWnpyaTZRbzdJdWs3TGloT2lEdGw2VHJrNXpycHF6c2lxVHNsNURzaEp6cmo0UWc2N2lNNjUyODdKcXc3S0NBSU95WHRPdW12Q0FySUV4SlUxUkZUaUR0bVpYc25iZ3NJREl3TWpZdE1EY3BMZ29nSUM4dklDQWc3WVN3NjYrNDY0U1E3SjIwSU8yWmxPdXB0T3lYa0NEc29JVHRtSUFnN0pXSUlPdWNyT3VMcEM0ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1T3VuakNEdGxaanJxYlFnNjRHZExnb2dJQzh2SU8yUHRPdXdzU2p0aExEcnI3anJoSkFwT2lEc25wRHJqNWtnN0ptRTY2T002ckNBSU91bmllMmVqQ0R0bVpqcXNyMG82N2lNNjUyODdKcXc3S0NBNnJDQUlHeHYNClkyRnNhRzl6ZE95WGtDRHJxcnNnNjR1LzdKV0VJT3k5bE91VG5PcXdnQ0RyczdUc25iVHJpcFFnNnJLOTdKcXdLZXlYa095RW5Bb2dJQzh2SUNBZzY2R2M2cmU0N0oyNElPdU1nT3E0c0NEc3BKRWc2N0tFN1lxODdKMkVJT3VZa0NEcmlJVHJwYlRycWJRc0lPeTlsT3VUbk91bHZDRHJ0cG5zbDZ6cmhLUHNuWVFnN0lpWUlPeWVpT3VLbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJT3lnaE8yWm1PMlZuT3VMcEM0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmIzQmxiaTFzYjJkcGJpY3BJSHNLSUNBZ0lHTnZibk4wSUdKdlpIa2dQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3dvZ0lDQWdZMjl1YzNRZ2MzZHBkR05vVFc5a1pTQTlJQ0VoS0dKdlpIa2dKaVlnWW05a2VTNXpkMmwwWTJoQlkyTnZkVzUwS1RzZ0x5OGc2ck9FN0tDVklPeWdoTzJabUNBOUlPeUxuTzJCck91bXZ5RHNzTDNzbkx6cm9ad2c3SmUwN0phMElPcXpoT3lnDQpsZXlkaENEcXM2RHJwYndnN0lpWUlPeWVpT3F5akFvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnTHk4Z1kyeGhkV1JsNnJDQUlPeVhodXljdk91cHRDRHNsNnpxdUxEc2hKd2c2NEdLNjRxVTY0dWtMaUJ6YUdWc2JEcDBjblZsNjUyOElHTnNZWFZrWmVxd2dDRHNsNGJzbHJUcmo0UWc3SVc0N0oyQUlPeWdsZXlEZ1NEc2k2VHRsb25yajd3S0lDQWdJQ0FnTHk4Z2MzQmhkMjdzblpnZ0oyVnljbTl5Sitxd2dDRHNsWWdnNjV5bzZyT2dMQ0RzbUlqc29JVHNsNVFnNnJlNDY0eUE2NkdjSUc5ck9uUnlkV1hycGJ3ZzY0K002NkNrN0tTczY0dWtJT0tBbEFvZ0lDQWdJQ0F2THlEdGxJenJuNnpxdDdqc25ianNuWUFnSXV1NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUc2w0anNsclRzbXBRaTY1Mjg2ck9nSU8yVm1PdUtsT3VOc0NEc2k2VHNvSnpyb1p6cmlwUWc3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHJuS2pyaXBRZzdJT0I3WU9jNnJDQUlPdVFrT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLSUNBZ0lDQWdhV1lnS0dOcw0KWVhWa1pWTjBZWFIxY3lBOVBUMGdKMk5zWVhWa1pTMXRhWE56YVc1bkp5a2dld29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF4TENCN0NpQWdJQ0FnSUNBZ0lDQmxjbkp2Y2pvZ0oreWR0Q0JRUSt5WGtDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZzRvQ1VJTzJFc091dnVPdUVrT3lYa095RW5DQmpiR0YxWkdVZ0xTMTJaWEp6YVc5dUlPeWR0Q0Rya0pqcmlwVHNwNEFnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0bkxBb2dJQ0FnSUNBZ0lDQWdjSEp2WW14bGJUb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp5d0tJQ0FnSUNBZ0lDQjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQXZMeURzcDRUdGxva2c3S1NSN0oyNDY0MndJT3VZa0NEcmlJenJvSURyaTZRZzRvQ1VJT3E0aU91d3FTZzJNT3kwaUNEcmdyUXBJT3VMcE95TG5DRHJpSVRycGJnZzZyRzBJQ0xzc0wzc25ZUWc2NHVyN0pXWTY0dWtMK3VxdXlEcnRLVHJpNlFpN0plUUlPcXdnT3E1ak95YXNPdXZnT3VobkNEcnVJenINCm5ienNtckRzb0lEcm9ad2c3SjZzN0l1YzY0K0U3WldjNjR1a0xnb2dJQ0FnSUNBdkx5RHRsWnpzc0xnZzY1S2s3SmVRNjQrRUlPdVlrQ0RyaUlUcnBiVHJpcFFnNnJHMElPdTRqT3Vkdk95YXNPeWdnT3F3Z0NCc2IyTmhiR2h2YzNRZzdMMmM2N0N4N0plUUlPdXF1eURyaTcvc2xZUWc3SjZRNjQrWklPeVpoT3Vqak9xd2dDRHNsWWdnNjVDWTY0cVVJTzJabU9xeXZleWR2Q0RzaUpnZzdKNkk3Snk4NjR1SUNpQWdJQ0FnSUM4dklPcTN1T3VWak91bmpDRHN2WlRyazV6cnBid2c2N2FaN0plczY0U2o3SjJFSU95SW1DRHNub2pyaXBRZzdZU3c2Nis0NjRTUUlPdXdxZXlMbmV5Y3ZPdWhuQ0R0ajdUcnNMSHRsWnpyaTZRZ0tPdVJrQ0Ryc29qc3A3Z2c3WUcwNjZhdDdKZVFJTzJFc091dnVPdUVrT3lkdENEdGlvRHNsclRyZ3Bqc21LVHJxYlFnNjR1NTdabXA3SXFrNjUrOTY0dWtLUzRLSUNBZ0lDQWdZMjl1YzNRZ2MzUmhiR1VnUFNCc2IyZHBibEJ5YjJNZ0ppWWdLRVJoZEdVdWJtOTNLQ2tnTFNCc2IyZHBibE4wDQpZWEowWldSQmRDQStJRFl3TURBd0tUc0tJQ0FnSUNBZ2FXWWdLR3h2WjJsdVVISnZZeUFtSmlCemRHRnNaU2tnZXdvZ0lDQWdJQ0FnSUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNLSUNBZ0lDQWdJQ0JwWmlBb0lXOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa3BJSHNLSUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeExDQjdJR1Z5Y205eU9pQW43SjIwSUU5VDdKZVE3SVNnSU95ZWtPdVBtZXljdk91aG5DRHJxcnNnN0plMDdKYTA3SnFVSU9LQWxDRHRoTERycjdqcmhKRHNsNURzaEp3Z1kyeGhkV1JsSU95THBPMldpU0R0bTRRZ0wyeHZaMmx1SU8yVnRDRHNvN3pzaExqc21wUXVKeUI5S1RzS0lDQWdJQ0FnSUNCOUNpQWdJQ0FnSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPd29nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdZKzA2N0N4SU9LQWxDRHRoTERycjdqcmhKQWc2N0NwN0l1ZA0KN0p5ODY2R2NJT3lnaE8yWm1DNG5LVHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2diVzlrWlRvZ0ozUmxjbTFwYm1Gc0p5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lDOHZJT3lWbnV5RW9DRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0N0oyMElPdU1nT3E0c0NEc3BKSHNuYlRycWJRZzdLQ1I2ck9nSU95RGlPdWhuQ0RzbDdEcmk2UWdLT3l3dmV5ZGhDRHJpNnZzbFpqcXNiRHJncGdnNjR1azdJdWNJT3VJaE91bHVDRHFzcjNzbXJBcENpQWdJQ0FnSUd4dloybHVVM1JoY25SbFpFRjBJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJQ0FnTHk4Z1FsSlBWMU5GVXV1bHZDRHNtckRycHF3ZzdaVzQ2NU9rNjUrczY2R2NJT3luZ095Z2xTRGlnSlFnUTB4SjZyQ0FJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNwNEhzb0pFZzdKZTA3S2VBSU95Vml1cXpvQ0JWVWt6cnA0d2c2NFNZNnJLbzdLU0E2NHVrTGdvZ0lDQWcNCklDQXZMeUR0bGJqcms2VHJuNnpxc0lBZzdJdWs3WXlvN1pXWTZyR3c2NEtZSUVOTVNlcXdnQ0JDVWs5WFUwVlM2Nlc4SU91c3RPeUxuTzJWdE91UGhDQkRURW5xc0lBZzdKV003SldFN0lTY0lPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJwYndnN0plMDY2K0E2NkdjSU91aG5PcTN1T3lkdU95ZGdDRHJrSnpyaTZRb1ptRnBiQzF6YjJaMEtTNEtJQ0FnSUNBZ1kyOXVjM1FnYkc5bmFXNUZibllnUFNCUFltcGxZM1F1WVhOemFXZHVLSHQ5TENCRFRFRlZSRVZmUlU1V0xDQjdJRUpTVDFkVFJWSTZJSGR5YVhSbFFuSnZkM05sY2toaGJtUnNaWElvYzNkcGRHTm9UVzlrWlNBL0lDZHpkMmwwWTJnbklEb2dKMjV2Y20xaGJDY3BJSDBwT3dvZ0lDQWdJQ0JqYjI1emRDQjBhR2x6VEc5bmFXNGdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjJsdUp5d2dKeTB0WTJ4aGRXUmxZV2tuWFN3Z2V3b2dJQ0FnSUNBZ0lITm9aV3hzT2lCMGNuVmxMQ0JsYm5ZNklHeHZaMmx1Ulc1MkxDQnpkR1JwDQpiem9nSjJsbmJtOXlaU2NzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsTEFvZ0lDQWdJQ0FnSUdSbGRHRmphR1ZrT2lCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUNFOVBTQW5kMmx1TXpJbkxDQXZMeUJyYVd4c1RHOW5hVzVRY205ajdKMllJT3EzdU91anVTQnJhV3hzN0pxcElDaHJhV3hzVUhKdlkrcXp2Q0RyajVuc25id2c3WXlvN1lTMEtRb2dJQ0FnSUNCOUtUc0tJQ0FnSUNBZ2JHOW5hVzVRY205aklEMGdkR2hwYzB4dloybHVPd29nSUNBZ0lDQjBhR2x6VEc5bmFXNHViMjRvSjJWeWNtOXlKeXdnS0NrZ1BUNGdleUJwWmlBb2JHOW5hVzVRY205aklEMDlQU0IwYUdselRHOW5hVzRwSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3SUgwcE93b2dJQ0FnSUNCMGFHbHpURzluYVc0dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lDQWdJQ0JwWmlBb2JHOW5hVzVRY205aklDRTlQU0IwYUdselRHOW5hVzRwSUhKbGRIVnlianNLSUNBZ0lDQWdJQ0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPd29nSUNBZw0KSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk5VYVcxbGNpa2dleUJqYkdWaGNsUnBiV1Z2ZFhRb2JHOW5hVzVRY205alZHbHRaWElwT3lCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUc1MWJHdzdJSDBLSUNBZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQU0F3T3lBdkx5RHNnNGdnNnJPRTdLQ1Y3SjI4SU95SW1DRHNub2pzbkx6cmk0Z2c2NHVrN0oyTUlDOW9aV0ZzZEdnZzY1V01JT3VMcE95TG5DRHNuYjNxdUxBS0lDQWdJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc29JanNzS2dnN0tLRjY2T01JQ2hqYjJSbElDY2dLeUJqYjJSbElDc2dKeWtuS1RzS0lDQWdJQ0FnSUNBdkx5RHNncXpybm96c25iUWc2NkdjNnJlNDdKMjQ3WldnSU95TG5PcXdoT3VQaENEc2w0YnNuYlFnNnJPbjY3Q1U2NkdjSU95THBPMk1xT3VobkNEcmdaM3JncXpyaTZRZ1BTQmpiR0YxWkdYcXNJQWc3SmVHNnJHdzY0S1lJT3lMcE8yV2lleWR0Q0RzbFlnZzY1Q2MNCklPcXlneTRLSUNBZ0lDQWdJQ0F2THlEc25aSHJpN1hzbllBZzdKMjA2Nis0SU91enRPdURpT3ljdk91TGlDRHNnNEh0ZzV6cnBid2c2NHVrN0l1Y0lPeWVyT3lFbkNBdmFHVmhiSFJvNjZHY0lPeVZqT3Vtc091THBDQW83WlNNNjUrczZyZTQ3SjI0N0oyMElPdU1nT3E0c0NEdG1aVHJxYlRzbllRZzdJdWs3WXlvNjZHY0lPdXdsT3Erdk91THBDa3VDaUFnSUNBZ0lDQWdhV1lnS0dOdlpHVWdJVDA5SURBZ0ppWWdSR0YwWlM1dWIzY29LU0F0SUd4dloybHVVM1JoY25SbFpFRjBJRHdnTlRBd01Da2dld29nSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVPeWR0Q0RzcG9uc2k1d2c3SXVrN1l5bzY2R2NJT3VCbmV1Q3FDRGlnSlFnUTJ4aGRXUmxJRU52WkdVZzdJU2s3TG1ZSU95RGdlMkRuT3VsdkNEcmk2VHNpNXdnN0tDUTZyS0E3WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdJQ0FnSUNBZ1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LVHNLSUNBZ0lDQWdJQ0I5DQpDaUFnSUNBZ0lIMHBPd29nSUNBZ0lDQnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V5QmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SURFdzY3YUVJT3F5dmVxenZDRGlnSlFnNjR5QTZyaXdJTzJVaE91aG5PeUV1T3lLcENEc29KWHJwcXd1SnlrN0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ2ZTd2dOakF3TURBd0tUc0tJQ0FnSUNBZ0x5OGc2NEtoN0oyQUlPeWVoZXllcGVxMmpPeWRoQ0Ryckx6cXM2QWc3SjZJNjRxVUlPdU1nT3E0c0NEc2hManNoWmpzbllBZzY3S0U2NmF3NjR1a0lPS0FsQ0RzbnF6cm9aenF0N2pzbmJnZzdadUVJT3VMcE95ZGpDRHNtcFRzc3Ezc25iUWc3SU9JSU95RXVPeUZtQ2pzZzRnZzdKNkY3SjZsNnJhTUtleWN2T3VobkNEc2k1enNucEh0bFpqcXNvd0tJQ0FnSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21saw0KWjJWZElPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN0l1YzdKNlJKeUFySUNoemQybDBZMmhOYjJSbElEOGdKeUFvNnJPRTdLQ1ZJT3lnaE8yWm1DRGlnSlFnN0l1YzdZR3M2NmEvSU95d3ZTa25JRG9nSnljcElDc2dKeURpZ0pRZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95ZWtPdVBtU0RzbDdEcXNyRHJrS25yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQnRiMlJsT2lCemQybDBZMmhOYjJSbElEOGdKMkp5YjNkelpYSXRjM2RwZEdOb0p5QTZJQ2RpY205M2MyVnlKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2daWEp5YjNJNklDZnJvWnpxdDdqc25iZ2c3TEM5N0oyRUlPdXF1eURzbDdUc2w0anNsclRzbXBRNklDY2dLeUJsTG0xbGMzTmhaMlVnZlNrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SUNqdGhMRHJyN2pyaEpBZzdZKzA2N0N4SU9xMXJPMlkNCmhPdTJnQ0RpZ0pRZzY3aU02NTI4N0pxdzdLQ0FJT3lla091UG1TRHNtWVRybzR6cXNJQWc3SldJSU91UW1PdUtsQ0R0bVpqcXNyMGc3S0NFN0pxcEtRb2dJR1oxYm1OMGFXOXVJRzl3Wlc1TWIyZHBibFJsY20xcGJtRnNLQ2tnZXdvZ0lDQWdld29nSUNBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSE4wWVhKMDZyQ0FJT3lEaUNEc3ZaanNocFFnN0xDOTdKMkVJT3Vuak91VG9PdUxwQ0FvNjR1azY2YXM3SjJZSU95SXFPeWRnQ0Rzdlpqc2hwVHFzN3dnNjZ5MDZyU0E3WldZNnJLTUlPeUNyT3lhcWV5ZWtPeVhrT3F5akNEcnM3VHNub1FwTGdvZ0lDQWdJQ0FnSUM4dklPeWR0T3lXdE95RW5DQlFiM2RsY2xOb1pXeHNLQzV3Y3pFcDdKMjBJRFhzdElnZzY1S2tJT3EzdUNEc3NMM3NsNUFnN0plVTdZU3c2Nlc4SU91enRPdUN0Q0F4NjdLSUtPcTFyT3VQaFNEcXM0VHNvSlVwN0oyRUlPeWVrT3VQbVNEc2hLRHRnNTN0bFpqcXM2QXNDaUFnDQpJQ0FnSUNBZ0x5OGc3TEM5N0oyRUlPeTFuT3lHak8yWmxPMlZ0Q0RzZ3F6c21xbnNucEFnNjRpSTdKZVVJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqcnA0d2c2NEtvNnJLTUlPMlZuT3VMcEM0ZzdMQzk3SjJFSU91cXV5RHNzTDdzbkx6cnFiUWc3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHRsWnpyaTZRS0lDQWdJQ0FnSUNBdkx5QW82NHVrNjZXNElPeXd2U0RzbUtUc25vWHJvS1VnNjdDcDdLZUFJT0tBbENEcXQ3Z2c2cks5N0pxd0lPdXBsT3VKdE9xd2dDRHJzN1RzbmJUcmlwUWc3TEdFNjZHY0lPdUNxT3F6b0NEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFxQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdLTzg3SjJZT2lCamJHRjFaR1hxc0lBZzdMMlk3SWFVSU95Z25PdXFxZXlkaENEcnNKVHF2cmpycWJRZ1FYQndRV04wYVhaaGRHVXZSbWx1WkZkcGJtUnZkK3F3Z0NEcnFyc2c3TEMrN0oyRUlPeUltQ0Rzbm9qc25Zd2c0b0NVSU95Y2lPdVBoT3lhc0NEcw0KaTZUcXVMRHNsNURzaEp3ZzdabVY3SjI0SU8yVmhPeWFsQzRLSUNBZ0lDQWdJQ0JqYjI1emRDQndjekVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExXeHZaMmx1TG5Cek1TY3BPd29nSUNBZ0lDQWdJR1p6TG5keWFYUmxSbWxzWlZONWJtTW9jSE14TENCYkNpQWdJQ0FnSUNBZ0lDQW5VM1JoY25RdFUyeGxaWEFnTFZObFkyOXVaSE1nTlNjc0NpQWdJQ0FnSUNBZ0lDQW5KSGR6SUQwZ1RtVjNMVTlpYW1WamRDQXRRMjl0VDJKcVpXTjBJRmRUWTNKcGNIUXVVMmhsYkd3bkxBb2dJQ0FnSUNBZ0lDQWdJbWxtSUNna2QzTXVRWEJ3UVdOMGFYWmhkR1VvSjJOc1lYVmtaUzFzYjJkcGJpY3BLU0I3SWl3S0lDQWdJQ0FnSUNBZ0lDSWdJQ1IzY3k1VFpXNWtTMlY1Y3lnbmZpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lGTjBZWEowTFZOc1pXVndJQzFUWldOdmJtUnpJREluTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdRV1JrTFZSNWNHVWdMVTVoYldWemNHRmpaU0JWSUMxT1lXMWwNCklGY2dMVTFsYldKbGNrUmxabWx1YVhScGIyNGdKMXRFYkd4SmJYQnZjblFvWENKMWMyVnlNekl1Wkd4c1hDSXBYU0J3ZFdKc2FXTWdjM1JoZEdsaklHVjRkR1Z5YmlCVGVYTjBaVzB1U1c1MFVIUnlJRVpwYm1SWGFXNWtiM2NvYzNSeWFXNW5JR01zSUhOMGNtbHVaeUIwS1RzZ1cwUnNiRWx0Y0c5eWRDaGNJblZ6WlhJek1pNWtiR3hjSWlsZElIQjFZbXhwWXlCemRHRjBhV01nWlhoMFpYSnVJR0p2YjJ3Z1UyaHZkMWRwYm1SdmR5aFRlWE4wWlcwdVNXNTBVSFJ5SUdnc0lHbHVkQ0J1S1Rzbklpd0tJQ0FnSUNBZ0lDQWdJQ0lnSUNSb0lEMGdXMVV1VjEwNk9rWnBibVJYYVc1a2IzY29XMDUxYkd4VGRISnBibWRkT2pwV1lXeDFaU3dnSjJOc1lYVmtaUzFzYjJkcGJpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lHbG1JQ2drYUNBdGJtVWdXMU41YzNSbGJTNUpiblJRZEhKZE9qcGFaWEp2S1NCN0lGdDJiMmxrWFZ0VkxsZGRPanBUYUc5M1YybHVaRzkzS0NSb0xDQTJLU0I5Snl3Z0x5OGdOaUE5SUZOWFgwMUpUa2xODQpTVnBGQ2lBZ0lDQWdJQ0FnSUNBbmZTY3NDaUFnSUNBZ0lDQWdYUzVxYjJsdUtDZGNjbHh1SnlrZ0t5QW5YSEpjYmljcE93b2dJQ0FnSUNBZ0lHTnZibk4wSUdKaGRDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ykc5bmFXNHVZbUYwSnlrN0NpQWdJQ0FnSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloaVlYUXNJQ2RBWldOb2J5QnZabVpjY2x4dUp5QXJDaUFnSUNBZ0lDQWdJQ0FuYzNSaGNuUWdJbU5zWVhWa1pTMXNiMmRwYmlJZ1kyMWtJQzlySUdOc1lYVmtaU0F2Ykc5bmFXNWNjbHh1SnlBckNpQWdJQ0FnSUNBZ0lDQW5jRzkzWlhKemFHVnNiQ0F0VG05UWNtOW1hV3hsSUMxRmVHVmpkWFJwYjI1UWIyeHBZM2tnUW5sd1lYTnpJQzFHYVd4bElDSW5JQ3NnY0hNeElDc2dKeUpjY2x4dUp5azdDaUFnSUNBZ0lDQWdjM0JoZDI0b0oyTnRaQ2NzSUZzbkwyTW5MQ0JpWVhSZExDQjdJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2djM1JrYVc4NklDZHBaMjV2Y21Vbg0KTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc0tJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXdvZ0lDQWdJQ0FnSUM4dklIQjBlU2hsZUhCbFkzUXA2NkdjSU91enRPdUN1Q0R0Z3FUc2w1QWc3WUcwNjZHYzY1T2NJRlJWU2Vxd2dDRHJyTFRyc0pqc25aSHNuYmdnNnJLRDdKMjBJT3lMcE95NG9TRHRtWlhzbmJqcmtLZ29NakF5Tmkwd055d2c3SjI4NjdDWUlGeHl3cmRyYVhSMGVTRHN2WlRyazV3ZzY2cW82NUdRS1NEaWdKUUtJQ0FnSUNBZ0lDQXZMeURzbktEc25ienRsWndnN0o2UTY0K1o3Wm1VSU9xeXZldWhuT3VLbENCVGVYTjBaVzBnUlhabGJuUno3SjJZSU95bmhPeW5uQ0R0Z3FRZzdKNkY2NkNsTGlEc29KSHF0N3pzaExFZzZyYU03WldjN0oyMElPeWVpT3ljdk91cHRDQTI3TFNJSU91U3BDRHNsNVR0aExEcXNJQWc3SjZRNjQrWklPeWVoZXVncGV1UHZBb2dJQ0FnSUNBZ0lDOHZJREhyc29nbzZyV3M2NCtGSU9xemhPeWcNCmxTbnNuYlFnN0lTZzdZT2Q2NUNZNnJPZ0xDRHF0b3p0bFp6c25iUWc3SmVHN0p5ODY2bTBJR3RsZVhOMGNtOXJaU0RzcElUcnA0d2c3S0d3N0pxcDdaNklJT3lMcE8yTXFPMlZ0Q0RzZ3F6c21xbnNucERxc0lBZzdKZVU3WVN3SU8yVm5DRHJzb2dnNjRpRTY2VzA2Nm0wSU91UW5PdUxwQ2htWVdsc0xYTnZablFwTGdvZ0lDQWdJQ0FnSUM4dklPeVhsTzJFc0NEc3A0SHNvSVRzbDVBZ1ZHVnliV2x1WVd6c25ZUWc2NHVrN0l1Y0lPeVZudXljdk91aG5DRHFzSURzb0xqc21ZQWc2NHVrNjZXNElPeVZzZXlYa0NEdGdxVHFzSUFnNjVPazdKYTA2ckNBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpQWdJQ0FnSUNBZ2MzQmhkMjRvSjI5ellYTmpjbWx3ZENjc0lGc0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWkc4Z2MyTnlhWEIwSUNKamJHRjFaR1VnTDJ4dloybHVJaWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzDQphV05oZEdsdmJpQWlWR1Z5YldsdVlXd2lJSFJ2SUdGamRHbDJZWFJsSnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0EySnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdZV04wYVhaaGRHVW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlEQXVNeWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVTNsemRHVnRJRVYyWlc1MGN5SWdkRzhnYTJWNWMzUnliMnRsSUhKbGRIVnliaWNzQ2lBZ0lDQWdJQ0FnSUNBdkx5RHNsNVR0aExEcXNJQWc3SXVrN0tDYzY2R2NJT3VUcE95V3RPcXdoQ0Rxc3Izc21yRHNsNURycDR3ZzdKZXM2cml3SU91UGhPdUxyQ2pxdG96dGxad2c3SmVHN0p5ODY2bTBJT3ljaE95WGtPeUVuQ0RzcEpIcmk2Z3BJT0tBbENEdGhMRHJyN2pyaEpEc25ZUWc3TG1ZN0p1TUlPdTRqT3Vkdk95YXNPeWdnT3VuakNEcmdxanF1TFRyaTZRS0lDQWdJQ0FnSUNBZw0KSUNjdFpTY3NJQ2RrWld4aGVTQXhMalVuTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QnpaWFFnYldsdWFXRjBkWEpwZW1Wa0lHOW1JR1p5YjI1MElIZHBibVJ2ZHlCMGJ5QjBjblZsSnl3S0lDQWdJQ0FnSUNCZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNLSUNBZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z1ptRnNjMlU3SUM4dklPeW5nT3lia0NEc2xZZ2c3WldZNjRxVUlFOVRDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2NtVjBkWEp1SUhSeWRXVTdDaUFnSUNCOUNpQWdmUW9nSUM4dklPMkJ0T3Vobk91VG5DRHFzNFRzb0pVZzY2R2M2cmU0N0pXRTdKdURJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3Wm1JN0oyWUlGdnJvWnpxdDdqc2xZVHNtNE5kSU91eWhPMkt2T3lkdENEdG1ManN0cHd1SUdOc1lYVmtaU0JoZFhSb0lHeHZaMjkxZE95Y3ZPdWhuQ0JEVEVrZzY2R2M2cmU0N0oyNDdKMkVJTzJWdE95Z25PMlYNCm5PdUxwQzRLSUNBdkx5QW83SjIwSUZCRDdKMllJT3lnZ095ZXBldVFuQ0RzbnBEcXNxbnNwcDNycW9Yc25ZUWc3S2VBN0pxMDY0dWtJT0tBbENEcmk2VHNpNXdnN0pPdzY2Q2s2Nm0wSU95ZXJPdWhuT3EzdU95ZHVDRHRsWVRzbXBRdUtTRHJvWnpxdDdqc2xZVHNtNE1nN1p1RTdKZVVJT3lFdU95Rm1NSzM2ck9FN0tDVjdMcVE3SXVjNjZXOElPeWdsZXVtck8yVm5PdUxwQzRLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2WTJ4aGRXUmxMV3h2WjI5MWRDY3BJSHNLSUNBZ0lHTnZibk4wSUd4dklEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25ZWFYwYUNjc0lDZHNiMmR2ZFhRblhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc0tJQ0FnSUd4bGRDQmxjbklnUFNBbkp6c0tJQ0FnSUd4dkxuTjBaR1Z5Y2k1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0lHVnljaUFyDQpQU0JrTG5SdlUzUnlhVzVuS0NrN0lIMHBPd29nSUNBZ2JHOHViMjRvSjJWeWNtOXlKeXdnS0dVcElEMCtJSHNnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUdWeWNtOXlPaUFuNjZHYzZyZTQ3SldFN0p1RElPeUxwTzJXaVNEc2k2VHRqS2c2SUNjZ0t5QmxMbTFsYzNOaFoyVWdmU2s3SUgwcE93b2dJQ0FnYkc4dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lDQWdhMmxzYkZCeWIyTW9LVHNnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQzh2SU91aG5PcTN1T3lWaE95YmcrdVFuQ0RxczRUc29KWHNuWVFnNjZ5ODY0MllJT3VNZ09xNHNDRHNoTGpzaFpqc25ZUWc2N0tFNjZhdzY0dWtDaUFnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQ0FnSUNBZ0lDQXZMeURyaTZUc25Zd2dMMkZqWTI5MWJuVEN0eTlvWldGc2RHanNsNURzaEp3ZzZyT0U3S0NWN0oyRUlPeURpT3VobkNnOTdKZUc3SjJNN0p5ODY2R2NLU0RzbmIzcXNvd0tJQ0FnSUNBZ1kyeGhkV1JsVTNSaA0KZEhWeklEMGdiblZzYkRzZ0lDQWdJQ0FnSUM4dklPeURnZTJEbkNEc25xenRqSkRzb0pVbzY0dWs3SjJNSU8yRXRPeVhrT3lFbkNEcnI3anJvWnpxdDdqc25iZ2c2ckNRN0tlQUtRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WUcwNjZHYzY1T2NJT3Vobk9xM3VPeVZoT3liZ3lBb1kyOWtaU0FuSUNzZ1kyOWtaU0FySUNjcEp5azdDaUFnSUNBZ0lHbG1JQ2h5WlhNdWFHVmhaR1Z5YzFObGJuUXBJSEpsZEhWeWJqc2dMeThnWlhKeWIzSWc3Wlc0NjVPazY1K3M2ckNBSU95ZHRPdXZ1Q0RzblpIcmk3WHRsb2pzbkx6cnFiUWc3S1NSNjdPMUlPdXdxZXluZ0FvZ0lDQWdJQ0JwWmlBb1kyOWtaU0E5UFQwZ01Da2dhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTQjlLVHNLSUNBZ0lDQWdaV3h6WlNCcWMyOXVLSEpsY3l3Z05UQXdMQ0I3SUc5ck9pQm1ZV3h6WlN3Z1pYSnliM0k2SUNobGNuSXVkSEpwYlNncExuTnNhV05sS0RBc0lERTFNQ2twSUh4OElDZ243S0tGNjZPTUlPeTkNCmxPdVRuQ0FuSUNzZ1kyOWtaU2tnZlNrN0NpQWdJQ0I5S1RzS0lDQWdJSEpsZEhWeWJqc0tJQ0I5Q2lBZ0x5OGc3SjZRNnJpd0lPeWloZXVqakNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SUZOVVQxQmZRbEpKUkVkRkwrMlZtTzJLdU91NWhPMkt1T3F3Z0NEdG1ManN0cHp0bFp6cmk2UWdLT3Vobk95N3JPeVhrT3lFbk91bmpDRHNvSkhxdDd3ZzZyQ0E2NHFsN1pXWTY0dUlJT3lWaU95Z2hDa0tJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjMmgxZEdSdmQyNG5LU0I3Q2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lpaGV1ampDRHNtcFRzc3EwZzY3Q2I3SjJNSU9LQWxDRHJpNlRycHF6cnBid2c2NEdWNjR1STY0dWtMaWNwT3dvZ0lDQWdhMmxzYkZCeWIyTW9LVHNLSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwDQpMQ0F5TURBcE93b2dJQ0FnY21WMGRYSnVPd29nSUgwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0p5a2dld29nSUNBZ1kyOXVjM1FnZXlCMFpYaDBMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmc3RwVHNzcHpyc0p2c25ZUWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95MmxPeXluQ0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNzSUcxdg0KWkdWc0lEOGdKeWpycXFqcmpiZzZJQ2NnS3lCdGIyUmxiQ0FySUNjcEp5QTZJQ2NuS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSEpoZHlBOUlHRjNZV2wwSUdGemEwTnNZWFZrWlNoVGRISnBibWNvZEdWNGRDa3VkSEpwYlNncExDQnRiMlJsYkNrN0NpQWdJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ2NHRnljMlZUZFdkblpYTjBhVzl1Y3loeVlYY3BPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvS1NCN0NpQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNak95THNTRHNpNlR0aktnZ0tDY2dLeUJ6WldNZ0t5QW5jeWs2Snl3Z1UzUnlhVzVuS0hKaGR5a3VjMnhwWTJVb01Dd2dNakF3S1NrN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJSHNnWlhKeWIzSTYNCklDZnRnYlRyb1p6cms1d2c3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SldJSUNjZ0t5QnpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dLeUFuNnJDY0lDZ25JQ3NnYzJWaklDc2dKM01wSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbk5sY25abFpDc3JPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dNekFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnpkV2RuWlhOMGFXOXVjeXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwDQpJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFZzRvQ1VJT3lEZ2UyWnFleWRoQ0RzaEtUcnFvWHRsWmpycWJRZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RPeWtnT3VMcENBbzdMYVU3TEtjNnJPOElPcXdtZXlkZ0NEc2hManNoWmdzSU91TWdPMlpsT3VLbENEcnA2UWc3SnFVN0xLdDdKZVFJTzJHdGV5bnVPdWhuQ0RzaTZUcnByd3BDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMk52YlhCdmMyVW5LU0I3Q2lBZ0lDQmpiMjV6ZENCN0lHMWxjM05oWjJWekxDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZw0KY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0cxbGMzTmhaMlZ6S1NBL0lHMWxjM05oWjJWekxtWnBiSFJsY2lnb2JTa2dQVDRnYlNBbUppQlRkSEpwYm1jb2JTNTBaWGgwSUh4OElDY25LUzUwY21sdEtDa3BJRG9nVzEwN0NpQWdJQ0JwWmlBb0lXeHBjM1F1YkdWdVozUm9LU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0ordU1nTzJabENEcmdyVHNtcW5zbmJRZzY3bUU3SmEwSU95ZWlPeUt0ZXVMaU91THBDNG5JSDBwT3dvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCamIyNXpkQ0JzWVhOMFZYTmxjaUE5SUZzdUxpNXNhWE4wWFM1eVpYWmxjbk5sS0NrdVptbHVaQ2dvYlNrZ1BUNGdiUzV5YjJ4bElDRTlQU0FuWVhOemFYTjBZVzUwSnlrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU91TWdPMlpsQ0RzbXBUc3NxMDZKeXdnVTNSeWFXNW4NCktDaHNZWE4wVlhObGNpQW1KaUJzWVhOMFZYTmxjaTUwWlhoMEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z05UQXBMbkpsY0d4aFkyVW9MMXh1TDJjc0lDY2dKeWtnS3lBbjRvQ21JQ2pyaklEdG1aUWdKeUFySUd4cGMzUXViR1Z1WjNSb0lDc2dKK3F3bkNrbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhKaGR5QTlJR0YzWVdsMElHRnphME52YlhCdmMyVW9iR2x6ZEM1emJHbGpaU2d0TVRJcExDQnRiMlJsYkNrN0lDOHZJT3VNZ08yWmxPcXdnQ0RxdUxqc2xyVHNwNERycWJRZzdMV2M2cmU4SURFeTZyQ2M2NmVNSUNqdGxJVHJvYXp0bElUdGlyZ2c3WSt0N0tPOElPdXdxZXluZ0NrS0lDQWdJQ0FnWTI5dWMzUWdiM1YwSUQwZ2NHRnljMlZEYjIxd2IzTmxLSEpoZHlrN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnZkWFFwSUhzS0lDQWdJQ0FnSUNCamIyNXpiMnhsDQpMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU8yTWpPeUxzU0RzaTZUdGpLZ2dLQ2NnS3lCelpXTWdLeUFuY3lrNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTWpBd0tTazdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJT3lka2V1THRTQW9KeUFySUhObFl5QXJJQ2R6TENEc29KenNsWWdnSnlBcklHOTFkQzV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dnS3lBbjZyQ2NLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVQ0KWlhoMElEMGdVM1J5YVc1bktDaHNZWE4wVlhObGNpQW1KaUJzWVhOMFZYTmxjaTUwWlhoMEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCeVpYQnNlVG9nYjNWMExuSmxjR3g1TENCemRXZG5aWE4wYVc5dWN6b2diM1YwTG5OMVoyZGxjM1JwYjI1ekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzY3S0k3SmV0SU9LQWxDRHRsWnpxdGEzc2xyUWc0b2FVSU95WWdleVcNCnRDRHNucERyajVrZ0tPeTJsT3l5bk9xenZDRHFzSm5zbllBZzdJUzQ3SVdZSU95Q3JPeWFxU2tLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZEhKaGJuTnNZWFJsSnlrZ2V3b2dJQ0FnWTI5dWMzUWdleUIwWlhoMExDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHbG1JQ2doZEdWNGRDQjhmQ0FoVTNSeWFXNW5LSFJsZUhRcExuUnlhVzBvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2Zyc29qc2w2M3RsYUFnNjZ5NDZyV3M2ckNBSU91NWhPeVd0Q0Rzbm9qc2lyWHJpNGpyaTZRdUp5QjlLVHNLSUNBZ0lHTnZibk4wSUhOMFlYSjBaV1FnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdXlpT3lYclNEc21wVHNzcTA2Snl3Z1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRFV3S1M1eVpYQnNZV05sS0M5Y2JpOW5MQ0FuDQpJQ2NwSUNzZ0orS0FwaWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTI5dWMzUWdjbUYzSUQwZ1lYZGhhWFFnWVhOclZISmhibk5zWVhSbEtGTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3NJRzF2WkdWc0tUc0tJQ0FnSUNBZ1kyOXVjM1FnYjNWMElEMGdjR0Z5YzJWVWNtRnVjMnhoZEdVb2NtRjNLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVc5MWRDa2dld29nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnNvanNsNjBnN1l5TTdJdXhJT3lMcE8yTXFDQW9KeUFySUhObFl5QXJJQ2R6S1RvbkxDQlRkSEpwYm1jb2NtRjNLUzV6YkdsalpTZ3dMQ0F5TURBcEtUc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEcnNvanNsNjBnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bg0KZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95WmhPdWpqQ0FvSnlBcklITmxZeUFySUNkekxDQW5JQ3NnS0c5MWRDNWthWEpsWTNScGIyNGdmSHdnSno4bktTQXJJQ2NwSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbk5sY25abFpDc3JPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dNekFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QjBjbUZ1YzJ4aGRHVmtPaUJ2ZFhRdWRISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVPaUJ2ZFhRdVpHbHlaV04wYVc5dUxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHANCk93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N0tJN0pldElPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzaTZUdGpLZzZJQ2NwS1RzS0lDQWdJSDBLSUNCOUNpQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNRFFzSUhzZ1pYSnliM0k2SUNkT2IzUWdabTkxYm1RbklIMHBPd3A5S1RzS0NpOHZJT3lkdE91dnVDRHJpNlRycHF6cXNJQWc2NWFnSU95ZWlPdUtsT3VOc0NEcm1KQWc3THljNnJpdzZyQ0FJT3VUcE95V3RPeVlwT3VwdENqc29KenNpcVRzc3BnZzdKNlE2NCtaSU95OG5PcTRzQ0RzcEpIcnM3VWc2NU94S1NEc29iRHNtcW50bm9nZzdLS0Y2Nk9NSU9LQWxDRHJqNHpyalpnZzY0dWs2NmFzNjRxVUlPcTN1T3VNZ091aG5DRHNuS0RzcDRBS2MyVnlkbVZ5TG05dUtDZGxjbkp2DQpjaWNzSUNobEtTQTlQaUI3Q2lBZ2FXWWdLR1VnSmlZZ1pTNWpiMlJsSUQwOVBTQW5SVUZFUkZKSlRsVlRSU2NwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc25iVHJyN2dnN0x5YzdLQzRJT3llaU95V3RPeWFsQ2p0ajZ6dGlyZ2dKeUFySUZCUFVsUWdLeUFuSU95Q3JPeWFxU0RzcEpFcElPS0FsQ0RzbmJRZzdKMjQ3SXFrN1lTMDdJcWs2NHFVSU95aWhldWpqTzJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJSEJ5YjJObGMzTXVaWGhwZENnd0tUc0tJQ0I5Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFbk91eWhDRHNtS1RycFpnNkp5d2daU0FtSmlCbExtMWxjM05oWjJVcE93b2dJSEJ5YjJObGMzTXVaWGhwZENneEtUc0tmU2s3Q2k4dklPeVd0T3VXcENEcXNyM3JvWnpyb1p3ZzdLTzk2NU9nS095THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBc0lFTjBjbXdyUXl3Z0wzTm9kWFJrYjNkdUxDRHNtS1RycFpncElHTnNZWFZrWlNEc25wRHNpNTNzbllRZzY0S282cml3N0tlQQ0KSU95Vml1dUtsT3VMcEFwd2NtOWpaWE56TG05dUtDZGxlR2wwSnl3Z0tDa2dQVDRnZXlCcmFXeHNVSEp2WXlncE95QnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lIMHBPd3B3Y205alpYTnpMbTl1S0NkVFNVZEpUbFFuTENBb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3BPd3B3Y205alpYTnpMbTl1S0NkVFNVZFVSVkpOSnl3Z0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBLVHNLQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc0tJQ0JqYjI1emIyeGxMbXh2WnlnbjRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FKeWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeUR0Z2JUcm9aenINCms1d2c2NHVrNjZhc0lPeThuT3lua0NEaWdKUWdhSFIwY0RvdkwyeHZZMkZzYUc5emREb25JQ3NnVUU5U1ZDazdDaUFnWTI5dWMyOXNaUzVzYjJjb0p5RHJxcWpyamJnNklDY2dLeUJEVEVGVlJFVmZUVTlFUlV3Z0t5QW5JTUszSU95WWlPeUxuQ0FuSUNzZ1JWaEJUVkJNUlZNdWJHVnVaM1JvSUNzZ0orcXh0Q0RzbnFYc3NLa25LVHNLSUNCamIyNXpiMnhsTG14dlp5Z25JT3lkdENEc3NMM3NuWVFnN0x5YzY1R1VJT3VQbWV5VmlDRHRsTHpxdDdqcnA0Z2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPMkJ0T3Vobk91VG5PdWhuQ0RzdHBUc3NwenRsYW5yaTRqcmk2UXVKeWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KK0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVDQpnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTm9aV05yUTJ4aGRXUmxRWFpoYVd4aFlteGxLQ2s3SUM4dklFTnNZWFZrWlNCRGIyUmxJT3lDck95YXFTRHFzSURyaXFVZzdKZXM2N2FBSU95Z2tPcXlnQ0FvN1pTTTY1K3M2cmU0N0oyNElPeVZpT3VDdE95YXFTa0tJQ0F2THlEcnI3anJwcXdnN0l1YzY0K1pJQ3NnN0tlQTdJdWM2Nnk0SU95anZPeWVoU0RpZ0pRZzdMS3JJT3kybE95eW5PdTJnTzJFc0NEcnVhRHJwYlRxc293S0lDQmhjMnREYkdGMVpHVW9KK3liak91d2pleVhoVG9nSXV5Z2dPeWVwU0Rya0pqc2w0anNpclhyaTRqcmk2UWlKeWt1ZEdobGJpZ0tJQ0FnSUNncElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc200enJzSTNzbDRVZzdKbUU2Nk9NSU9LQWxDRHN0cFRzc3B3ZzdLU0E2N21FSU91Qm5TNG5LU3dLSUNBZ0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SnVNNjdDTjdKZUZJT3lMcE8yTXFDQW83TEtySU95YWxPeXlyU0RybFl3ZzdKNnM3SXVjNjQrRQ0KS1RvbkxDQmxMbTFsYzNOaFoyVXBDaUFnS1RzS2ZTazdDZz09DQo6OkVYQU1QTEVTOjoNCkl5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzDQpwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydA0KbGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWENCmxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVDQo3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TA0Kbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXkNCmhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVDQo3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3Zw0KN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVcNCnRPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWDQptT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIcw0KbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0kNCjdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnDQo3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvag0KSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVANCm1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyDQpvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8ySw0KdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVYNCmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyDQppNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Qw0KdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXcNCmdDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzDQpuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRQ0KN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHMNCm5JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhDQpsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMA0KSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzMNCjZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzDQppSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEcw0KaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGcNCjdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhDQpxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqcw0KbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjANCklPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVoDQpuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMA0KN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTANCjY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RyDQpwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZw0KNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXcNCnZ1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLDQpMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZw0KN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHINCnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVDQpQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aA0KbkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0NCjo6R1VJREU6Og0KSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5Bb0tJeU1nTVM0ZzdaVzA3SnFVN0xLMENncnNvSnp0a29nZzdKV0k3SjJZSU91cXFPdVRvQ0RyckxqcXRhenJpcFFnSisyVnRPeWFsT3l5dENmcm9ad2c3STJvN0pxVUxncnNuYnpxdElEc2hMRWc3SjZJNjRxVUlPeUNyT3lhcWV5ZWtDRHFzcjN0bDVqc25ZUWc2NmVNNjVPa0lPeUltQ0Rzbm9qcmo0VHJvWjBnS2lyc2c0SHRtYWtzSU91bnBldWR2ZXlkaENEcnRvanJyTGp0bFpqcXM2QWc2NnFvNjVPZ0lPdXN1T3Exck95WGtDRHRsYlRzbXBUc3NyVHJwYndnN0tDQjdKcXA3WlcwN0tPODdJUzQ3SnFVTGlvcUNncnNtSWdwQ2kwZzY3TzA2NE9GNjR1STY0dWtJT0tHa2lEcnM3VHJncnpxc296c21wUUtDaW9xS2dvS0l5TWdNaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0FvSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEc3RaenJqSUR0bFp3Z0tpcnJpcVhyajVudG1KVWc2Nnk0N0o2bEtpcnNuWVFnN0kybzdLTzg3SVM0N0pxVUxpRHNpSmpyajVudG1KVWcNCjY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRFdDdJaVk2NCtaN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2s3RHJpcFFnNnJLTUlPeWlpK3lWaE95YWxDNEtDaU1qSXlEcmtKRHNsclRzbXBRZzRvYVNJTzJXaU95V3RPeWFsQW9LN0ppSUtRb3RJT3lFcE95Z2xldVFrT3lXdE95YWxDRGlocElnN0lTazdLQ1Y3WmFJN0phMDdKcVVDZ29qSXlNZ0ozN3NsNGduSU91NXZPcTRzQW9LN0ppSUtRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVUNnb2pJeU1nNjQrWjdJS3NJT3V3bE9xL2xPeVRzT3E0c0FvSzdKaUlLUW90SU91R2t1eVZoT3loak95V3RPeWFsQ0RpaHBJZzdKaXM2NTZRN0phMDdKcVVDZ29xS2lvS0NpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBS0N1eWduTzJTaUNEc2xZanNsNURzaEp3ZzY3YUE3S0NWN0tDQklPeTdwT3V1DQpwT3VMaU95OGdPeWR0T3lGbU95ZGhDRHN0WnpyaklEdGxad2c3S1NFN0oyMDZyT2dJT3E0amV5Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzdLTzg3SVM0N0pxVUxncnJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUTXQ2N2FBN0tDVjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNqYWpzbXBRdUNncnNtSWdnT2lEc2xZZ2c2NCs4N0pxVUxDRHNsNGJzbHJUc21wUWdLRmdwSU9LR2tpQis3WldZNjZtMElPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUlDaFBLUW9LSXlNaklPeVhodXlXdE95YWxDRGlocElnN0o2STdKYTA3SnFVQ2dyc21JZ3BDaTBnNjdPMDdaaTQ3SjZRNnJDQUlPMlhpT3VkdmUyVm1PcTRzQ0Rzb0lUc2w1RHJpcFFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUWc0b2FTSU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQQ0KN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRS0NpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFDZ3JzbDVEcm42d2c3SU9CN1ptcDdKZVE3SVNjNjQrRUlDTHRsYlRxc3JBZzY3Q3A2N0tWSXV5ZGhDRHJxTHpzb0lBZzdKV002NkNrN0tPODY0cVVJT3E0amV5Z2xlMllsU0RxdGF6c29iRHJvWndnN0kybzdKcVVMZ29LN0ppSUtRb3RJT3luZ09xNGlDRHJzb1Rzb0lUc2w1RHNoSnpyaXBRZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeVZzZXlkaENEc3RaenNpNkFnNjdLRTdLQ0U3Snk4NjZHY0lPeVhoZXVOc095ZHRPMkt1Q0R0bGJUc283enNoTGpzbXBRdUlPS0draURzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMDdLTzg3SVM0N0pxVUxpRHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2pvNk9pQjBhWEFnNjR1azdKMjA3SmE4NjZHYzZyZTQNCklPeVp2T3lxdlNEcnNvVHRpcnpzbllBZ1crdUxxK3E0c0YwSzY0dWs3SjIwN0phODY2R2M2cmU0SU95WnZPeXF2U0Ryc29UdGlyenNuWUFnS2lycmk2dnF1TEFxS3V1aG5DRHJyTGpxdGF6cnBid2c3WWExN0oyODdaVzA3SnFVTGlBcUt1eTNxT3lHakNvcTY0cVVJT3lDck95YXFleWVrT3F3Z0NEdGxaanFzNkFnN0o2STY0cVVJT3lla2V5WGhleWR0Q0RzdDZqc2hvenJrSnpyaTZUcXM2QWc3SmlrN1pXMDdaV2dJT3lJbUNEc25vanNsclFnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzRLT2pvNkNnb2pJeU1nN1ppYzdZT2Q3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SjJFSU91VmpBb0s3SmlJS1FvdElPdXFxT3llaE95bmdPeWJrT3E0aUNEc2w0YnNuYlFnNjZxbzdKNkU3WWExN0o2bDdKMkVJT3Vuak91VHBPcTVqT3lhbEQ4ZzdLZUE2cmlJSU91d20reW5nQ0RzbFlyc25MenJxYlFnNjZxbzdKNkU3S2VBN0p1UTZyaUk3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnN0pXOTZyU0E3SmVRDQpJT3VQbWV5ZG1PMlZtT3VwdENEcnFxanNub1RzcDREc201RHF1SWpzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdaaWM3WU9kSU91TWdPeURnU0RzbFlqcmdyUUtDaW9xN0lTYzY3bUU3SXFrNjRxVUlPeVR1Q0RzaUpnZzdKNkk3S2VBNjZlTUxDRHRpcm5zb0pVZzdaaWM3WU9kN0oyQUlPdXdtK3lkaENEc2lKZ2c3SmVHN0oyRUlPdVZqQ0RpaHBJZzZyaU43S0NWN1ppVklPdXN1T3llcGV5Y3ZPdWhuQ0RzamFqc21wUXVLaW9LN0lLczdKcXA3SjZRNjRxVUlPdXN1T3Exck91bHZDRHF2THpxdkx6dG5vZ2c3SjI5N0tlQUlPeVZpdXF6b0NEdG01SHNsclRyczdUcXVMQW83SXFrN0xxVUtTRHJsWXpyckxqc2w1QXNJT3UyZ095Z2xlMllsZXljdk91aG5DRHNrN0RycWJRZzdLQ2M3WktJSU95Z2hPeXl0T3VsdkNEc2s3Z2c3SWlZSU95WGh1dUxwT3F6b0NEc21LVHRsYlR0bFpqcXVMQWc3SW1zN0p1TTdKcVVMZ29LN0ppSUtRb3RJT3F6aE95aWpDRHFzSnpzaEtRZzdaaWM3WU9kN0oyQQ0KSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnTkM0MUpTRHF1SWpycHF3ZzdaaWM3WU9kNjZlTUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZ29LS2lvcUNnb2pJeUEwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phMENncnNvSnp0a29nZzdKV0k3SmVRN0lTY0lDZCs3SXVjNnJLZzdKYTA3SnFVUHljc0lDZnNpNXpyZ3Bqc21wUS9KeXdnSjM3cXU1Z25JT3F3bWV5ZGdDRHFzN3pyajRUdGxad2c2cks5N0phMDY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVDdXkxbk91TWdPMlZuQ0RzdXBEc283enNscnp0bFpqcXM2QWc3TG1jNnJlODdaV2NJT3Vua08ySXJPdWx2Q0RzazdEcmlwUWc2cktNSU95aWkreVZoT3lhbEM0SzZySzk3SmEwNjRxVUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRJdDZySzk3SmEwNjZXOExleU5xT3VQaEMzcmtKanJpcFF0NnJLOTdKcXdLZXlYa0NEdGxiVHJpN250bGFBZzY1V002NmVNSU95TnFPeWFsQzRLQ2lNakl5RHJqNW5zZ3F6c2w1RHMNCmhKd2dKMzdzaTV3bklPdTV2T3E0c0FvSzdKaUlLUW90SU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bFpqc2k1enFzcURzbHJUc21wUS9JT0tHa2lEc3ViVHJrNXpycGJ3ZzdaVzA3S2VBN1pXZzZybU03SnFVUHdvdElPeUxuT3lla2UyVm1PeUxuT3VLbENEcnRvVHNsNURxc293Z05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMaURpaHBJZzdJdWM3SjZSN1pXWTY2bTBJRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0NpTWpJeUFuNnJPRTdJdWM2NHVrSnlEaWhwSWdKK3llaU91THBDY0tDdXlZaUNrS0xTRHNucERyajVuc3NLanJwYndnNnJDQTdLZUE2ck9nSU9xemhPeUxuT3VDbU95YWxEOGc0b2FTSU95ZWtPdVBtZXl3cU9xd2dDRHNub2pyZ3Bqc21wUS9DaTBnNjZlazY0dXNJT3V6dE8yWG1PdWpqQ0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VucE91THJDRHJzN1R0bDVqcm80enJpcFFnN0phODY2ZUk3SjI0NnJDQTdKcVVQeUFxS091THFPeUluQ0RzDQp1Wmp0bVpqc25iUWc3SldFNjR1STY1MjhJT3VzdU95ZXBleWRoQ0RzZzRqcm9ad2c3Sk8wSU95Q3JPdWhnT3lZaU95YWxDa3FDZ29qSXlNZ0oreVhyT3l0aU91THBDY2c0b2FTSUNmdG1aWHNuYmp0bFpqcmk2UXNJT3VzdSt1THBDY0tDdXlZaUNrS0xTRHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2Zxc0lEc3A0QWc2NHVrN0l1Y0lPeVhyT3l0cE91enZPcXlqT3lhbEM0ZzRvYVNJT3lWaU95Z2hPMlZuQ0Rxc0p6dGhyWHNuWVFnN0p5RTdaVzBJT3VxaCtxd2dPeW5nQ0RyaTZUc2k1d2c3Wm1WN0oyNDdaV2c2cktNN0pxVUxnb0tJeU1qSUNmcXU1Z25JT0tHa2lBbjdKZVE2cktNSndvSzdKaUlLUW90SU8yWmplcTR1T3VQbWV1TG1PcTdtQ0RyZ3FEc2xZVHFzSURxczZBZzdKNkk3SmEwN0pxVUxpRGlocElnN1ptTjZyaTQ2NCtaNjR1WTdKZVE2cktNSU91Q29PeVZoT3F3Z09xem9DRHNub2pzbHJUc21wUXVDZ29qSXlNZzZySzk3SmEwNjZXOElPdTZrT3lkaENEcmxZd2c3SmEwN0lPSg0KN1pXY0lPcXl2ZXlhc0FvSzdJS3M3SnFwN0o2UTdKMllJT3lnbGV1enRPdWx2Q0Ryc0p2cmlwUWc3S2VJNjZ5NDdKZVE3SVNjSU9xNHNPcXpoT3lnZ2V5Y3ZPdWhuQ0FuZnV5TG5DZnJwYndnNjdxUTdKMkVJT3VWakNEcnJManNucVhzbmJRZzdKYTA3SU9KN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2lvcTdZeU03SldGN1pXWTZyT2dJT3lMdHV5ZGdDRHNvSlhyczdUcnBid2dKK3lqdk95V3RDZnJvWndnN0kybzdJU2NJT3VzdU95ZXBleWRoQ0RzZzRqcm9hM3Fzb3dnN0kybzY3TzA3SVM0N0pxVUxpb3FDZ3JzbUlncENpMGc3SmEwNjVha0lPdXFxZXlnZ2V5Y3ZPdWhuQ0RyaklEc3RwenJzSnZzbkx6c2k1enJncGpzbXBRL0lPS0draURyaklEc3Rwd2c2NnFwN0tDQjdKMjBJT3VzdE95WGgreWR1T3F3Z095YWxEOEtMU0RzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhnNG9hU0lPeUxvT3F6b0NEc25iVHNuS0RycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lFdU95YWxDNEsNCkNpb3FLZ29LSXlNZ05TNGdKM3ZycW9Yc2dxeDlJQ3NnZSt1cWhleUNySDBuSU95VHNPeW5nQ0RzbFlycXVMQUtDaU1qSXlEdGxaenNucERzbHJRZzdaS0E3SmEwN0pPdzZyaXdDZ3J0bFp6c25wRHNsclFnNjZxRjdJS3M2Nlc4SU8yU2dPeVd0T3lFbkNEcmo1bnNncXdnN1ppVjdZT2M2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUlPS0draURzbmJUc25wRHJwYndnNjQrTTY2Q2s2N0NiN0pXWTdKYTA3SnFVQ2kwZzY0SzA3SjI4SU95NXRPdVRuT3F3a3V5ZHRDRHFzckRzb0p6cmtLQWc3SmlJN0tDVjdKMjA3SmVRN0pxVUlPS0draURyZ3JUc25ienNuWUFnN0xtMDY1T2M2ckNTSU91Q21PcXdnT3VLbENEcmdxRHNuYlRzbDVEc21wUUtDaU1qSXlEdGxaenNucERzbHJUcnBid2c3WktBN0phMDdKT3c2cml3SU95V3RPdWdwT3lhdUNEcXNyM3NtckFLQ2lkNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFDQpuQ2NnN1ppVjdZT2M2NkdjNjZlTUlPMlNnT3lXdE95a21PdVBoQ0RyalpRZzdMcVE3S084N0phODdaV1k2cktNSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SU95ZWxPeVZvU0RydG9Ec29iSHNuTHpyb1p3ZzZyV3M2NmVrN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbENEaWhwSWc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVQ2dvcUtpb0tDaU1qSURZdUlPMlJuT3E0c0NEdGhyWHNuYndLQ2lNakl5RHJrSmpzbHJUc21wUWdLRmdwSU9LR2tpRHJqN3pzbXBRZ0tFOHBDZ3JycXFqcnNKVHNuYndnN1ptVTY2bTA3SjJZSU95aWdleWRnQ0RxczdYcXNJVHNuWVFnNnJPZzY2Q2s3WlcwSUNmcmtKanNsclRzbXBRbjY0cVVJT3VxcU91UmtDQW42NCs4N0pxVUordWhuQ0R0aHJYc25ienRsYlRzaEp3ZzdJMm83S084N0lTNDdKcVVMZ29LS2lvcUNnb2pJeUEzTGlEcmdxRHNwNXpDdCt5TG5PcXdoTUszN0lpcjdKNlFJTzJSbk9xNA0Kc0FvSzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt1eWlPMll1T3VLbENEc2xZVHJucGdnN1ppVjdJdWQ3Snk4NjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc21wUXVDZ29qSXlNZzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCtxNHNPcXdoQW9LZkNEdGxhM3JxcWtnZkNEdG1KWHNpNTBnZkNEc21JanNpNXdnZkFwOExTMHRMUzB0ZkMwdExTMHRMWHd0TFMwdExTMThDbndnNjRLZzdLZWNJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1RVMHVSRVJnSUh3Z01qQXlOUzR3TVM0d01Td2dNalV1TURFdU1ERWdmQXA4SU95TG5PcXdoQ0I4SU9xNHNPdXp1Q0JnU0VnNlRVMDZVMU5nSUM4ZzdLZW42cktNSUdCSVNEcE5UV0FnS095WXBPeWdoQy9zbUtUdG00UWc3SldJSU95VWdDa2dmQ0F4TkRvek1Eb3hNU3dnTVRNNk16QWdmQXA4SU9xNHNPcXdoQ0I4SU9xNHNPdXp1Q0JnV1ZsWldTNU5UUzVFUkg1WldWbFpMazFOTGtSRVlDQXZJT3lucCtxeWpDQmdXVmxaV1M1TlRTNUVSSDVOVFM1RVJHQWcNCmZDQXlNREkxTGpBeExqQXhmakl3TWpVdU1ERXVNekVzSURJd01qVXVNREV1TURGK01ERXVNekVnZkFwOElPdUNvT3lubkNBcklPeUxuT3F3aENCOElHQlpXVmxaTGsxTkxrUkVJRWhJT2sxTllDQjhJREl3TWpVdU1ERXVNREVnTVRRNk16QWdmQXA4SU95YWxPeWR2Q0I4SUdCWldWbFpMazFOTGtSRUtPeWFsT3lkdkNsZ0lPS0FsQ0RzbTVRdjdabVVMK3lJbUMvcnFxa3Y2cmlJTCsyR29DL3NuYndnZkNBeU1ESTFMakF4TGpBeEtPeUltQ2tnZkFvS0tpcnNpNXpxc0lRZzdKaUk3Sm00S2lvNklPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDQmc3SmlrN0tDRUwreVlwTzJiaENCSU9rMU5ZT3lkaENEc2phanJqNFFnNjQrODdKcVVMZ3JzbUlncElPeVlwTzJiaENBeE9qQXdDZ29qSXlNZzY2eTQ3SjZsSU95R2pTRHNsN0RzbTVUc25id0tDdXVzdU95ZXBTRHNsWWpzbDVEc2hKenJpcFFnS2lyc201VEN0K3lkdkNEc2xaN3NuWmdnDQpNT3lkaENEcnVienFzNkFxS2lEc2phanNtcFF1Q2dyc21JZ3BDaTBnTWpBeU51dUZoQ0F3T095YmxDQXdOZXlkdkNEc25vWHJpNGpyaTZRdUlPS0draUF5TURJMjY0V0VJRGpzbTVRZ05leWR2Q0Rzbm9Ycmk0anJpNlF1Q2dvakl5TWc3SU9CNjR5QUlPeUxuT3F3aENBbzY0VzQ3TGFjN0pxcEtRb0tmQ0Rzb2JEcXNiUWdmQ0R0a1p6cXVMQWdmQXA4TFMwdExTMHRmQzB0TFMwdExYd0tmQ0EyTU95MGlDRHJyN2pycDR3Z2ZDRHJzS25xdUlnZzdLQ0VJSHdLZkNBMk1PdTJoQ0RycjdqcnA0d2dmQ0JPNjdhRUlPeWdoQ0I4Q253Z01qVHNpNXpxc0lRZzY2KzQ2NmVNSUh3Z1R1eUxuT3F3aENEc29JUWdmQXA4SURNdzdKMjhJT3V2dU91bmpDQjhJRTdzbmJ3ZzdLQ0VJSHdLZkNBeE11cXduT3libENEcnI3anJwNHdnZkNCTzZyQ2M3SnVVSU95Z2hDQjhDbndnTVRMcXNKenNtNVFnN0oyMDdJT0JJSHdnVHV1RmhDRHNvSVFnZkFvSzdKaUlLU0Ryc0tucXVJZ2c3S0NFTENBMTY3YUVJT3lnaEN3Z011eUxuT3F3aENEcw0Kb0lRc0lEUHNuYndnN0tDRUxDQTI2ckNjN0p1VUlPeWdoQ3dnTXV1RmhDRHNvSVFLQ2lNakl5RHJwNGpxc0pEQ3QrcTRzT3F3aENEcnA0enJvNHdLQ21CRUxVNWdLRTdzbmJ3ZzY0S283SjJNS1NBdklHQkVMVEJnS095WXBPdUttQ0RycDRqcXNKQXBJQzhnWUVRclRtQW9UdXlkdkNEcXNyM3FzN3dwQ3V5WWlDa2dSQzAzTENCRUxURXNJRVF0TUN3Z1JDc3hDZ29qSXlNZzY3S0k3Wmk0SU8yUm5PcTRzQ0FvN1pXWTdKMjA3WlNJN0p5ODY2R2NJT3Exck91MmhDa0tDbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdLZkMwdExTMHRMWHd0TFMwdExTMThMUzB0TFMwdGZBcDhJT3lnaE8yWmxPdXlpTzJZdUNCOElPMlZtT3lkdE8yVWlDRHF0YXpydG9RZ2ZDQXdNaTB4TWpNMExUVTJOemdzSURBeE1DMHhNak0wTFRVMk56Z2dmQXA4SU95NXRPdVRuT3V5aU8yWXVDQjhJRFRzbnBEcnBxenNsS2tnN1pXWTdKMjA3WlNJSUh3Z01USXpOQzAxTmpjNExUa3dNVEl0TXpRMU5pQjhDbndnNnJPRTdLS00NCjY3S0k3Wmk0SUh3ZzdaV1k3SjIwN1pTSUlPcTFyT3UyaENCOElERXlNeTAwTlRZdE56ZzVNREV5SUh3S2ZDRHNvN3pycjd6cms3SHJvWjNyc29qdG1MZ2dmQ0RzbFo0Z051eWVrT3VtckMzcmtxUWdOK3lla091bXJDQjhJREV5TXpRMU5pMHhNak0wTlRZM0lId0tmQ0RzZ3F6c2w0WHNucERyazdIcm9aM3Jzb2p0bUxnZ2ZDQXhNT3lla091bXJDRHRsWmpzbmJUdGxJZ2dmQ0F3TVMweU16UXROVFkzT0RrZ2ZBb0tJeU1qSU95VHNPdXB0Q0RzbFlnZzY1Q1k2NHFVSU8yUm5PcTRzQW9LTFNEcmdxRHNwNXpzbDVBZzdaV1k3SjIwN1pTSXdyZnJ1WmZxdUlnNklPS2RqQ0F5TURJMUxUQXhMVEF4TENBd01TOHdNUW90SU95TG5PcXdoT3lYa0NEc21LVHNvSVF2N0ppazdadUVPaURpbll3ZzdKaWs3S0NFSURIc2k1d2dLaWpyaTZnc0lPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDRHNtSWpzbWJncEtnb0tLaW9xQ2dvaklPeVlpT3laDQp1Q0RxdDV6c3Vaa0tDdXlia095NW1TanJpcVhyajVuQ3QrcTRqZXlnbGNLMzdMcVE3S084N0phOEtldXp0T3VMcENEc21JanNtYmpxc0lBZzY0MlVJT3VxaGUyWmxlMlZuQ0RzdTZUcnJxVHJpNGpzdklEc25iVHNoWmpzbllRZzY2ZU02NU9jNjRxVUlPcXl2ZXlhc095WWlPeWFsQzRLQ2lNaklPeVlpT3ladUNBeExpRHNpSmpyajVudG1KVWc2Nnk0N0o2bDdKMkVJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3Q2dvakl5TWc3SVNjNjdtRTdJcWtJT3lpaGV1ampDd2c2cml3NnJDRUlPdW5qT3VqakFvSzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VHNPdXB0Q0Rzbzd6c2xyUW83S0tGNjZPTUlPeUVuT3U1aE95S3BDd2c2cml3NnJDRUlPdVRzU25ycGJ3ZzZyQ1Y3S0d3N1pXZ0lPeUltQ0Rzbm9qcXM2QXNJQ2Zzb29Ycm80d243Sm1BSUNmcnA0enJvNHduN0oyWUlPdUptT3lWbWV5S3BPdWx2Q0Rzb0pYdG1aWHRub2dnN0tDRTY0dXM3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ3JzbUlncENpMGdUMDlQSU95RQ0Kbk91NWhPeUtwQ0Rzb29Ycm80d2c3SldJNjRLMElPS0FsQ0F3TU95YmxDQXdNT3lkdk91MmdPMkVzQ0RzaEp6cnVZVHNpcVRxc0lBZzdLS0Y2Nk9NNjQrODdKcVVMaURzbnBEc2hManRsWndnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3VUbk91Z3BPeWFsQzRLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZ29LNjR1b0xDQXFLdXlqdk9xNHNPeWdnZXljdk91aG5DRHNvb1hybzR6cXNJQWc2N0NZNjdPMTY1Q1k2NHFVSU95Z25PMlNpQ29xN0plUTY0cVVJQ2Zzb29Ycm80enJqN3pzbXBRbjY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVDZ3JzbUlncENpMGc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVJT0tHa2lEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURyZ1ozcmdwanNtcFFLQ2lNakl5RHNncXpzbXFuc25wRHNsNURxc293ZzY2KzQ3TG1ZNjRxVUlPeVlnZTJXcGV5ZGhDRHNsWXpyb0tUc3BJUWcNCjY1V01DZ29vN0tPODdKcVVJT3VQbWV5Q3JDQTZJT3lYc095eXRDd2c3WlcwN0tlQUxDRHNvSUhzbXFrZzY1T3hLUW9LN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lUc091cHRDRHNuYmpxczd3ZzZyU0E2ck9FNjZXOElPdXFoZTJabGUyVm1PcXlqQ0RzaEtUcnFvWHRsWmpxczZBc0lDZnNncXpzbXFuc25wRHNuWmdnN1phSjY0K1o3SmVRSU91VXNPdWR2T3lZcE91S2xDRHFzckRxczd3bjY1Mjg2NHFVSU95Z2tPeWRoQ0RzbFl6cm9LVHNwSVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHNtS1RyaXBqcXVZenNwNEFnNjRLMDdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbDdEc3NyVHJqN3pzbXBRdUlPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb3RJT3VNZ095Mm5PeWRoQ0Rxc0lqc2xZVHRnNERycWJRZzdKdVE2NTZZSU91TWdPeTJuT3lkdENEdGxiVHNwNERyajd6c21wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXDQppZXlYa0NEcmdyVHNsYndnN1pXMDdKcVVMZ29LSXlNaklPeUNyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPeUltT3VQbWUyWWxTa0tDaWZzb0pYcnM3UWc3SWlZN0tlUklPeVZpT3VDdENjZzY1T3g3SjJZSU91dnZPcXdrTzJWbkNEc2c0SHRtYW5zbDVEc2hKd2dLaXJzaTV6c2lxVHRoWnpzbmJRZzdKNlE2NCtaN0p5ODY2R2NJT3l5bU91bXJPMlZuT3VMcE91S2xDRHNvSkFxS3V5ZGhDRHNpSmpyajVudG1KWHNuTHpyb1p3ZzdKV002NkNrSU95Q3JPeWFxZXlla091bHZDRHNsWWpzaTZ6dGxaanFzb3dnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0oyMDdLQ2M2N2FBN1lTd0lPMlpqZXE0dU91UG1ldUxtT3lkbUNEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFFLTFNEcmpaUWc3S0tMN0oyQUlPeURnZXVMdE95ZGhDRHNuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkZ0NEcmhibnNuWXpyajd6c21wUUtDaU1qSU95WWlPeVp1Q0F5TGlEcQ0Kc3Izc2xyVHJwYndnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBS0N1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla095ZG1DRHJwNlhybmIzc25ZUWc3Wm1jN0pxcDdaVzA3SVNjSU95bmlPdXN1TzJWb0NEcmxZd0tDaWZzaTV6cmdwanNtcFEvSnl3Z0oreUZxT3VDbU95YWxEOG5JTzJZbGUyRG5PeWRtQ0Rxc3Izc2xyVHJwYndnN1ptYzdKcXA3WlcwN0lTY0lPeUNyT3lhcWV5ZWtPeWRtQ0RyaTdudG1hbnNpcVRybjZ6c200RHNuWVFnN0tTRTdKMjhJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdabU42cmk0NjQrWjY0dVlMQ0JQVDA4ZzY0dWs2NFdBN0ppazdJV282NEtZN0pxVVB3b3RJT3kycWV5Z2hPMlZtT3VmckNEdGpyanNuWmpzb0pBZzZyQ0E3SXVjNjRLWTdKcVUNClB3b0tJeU1qSU95Q3JPeWFxZXlla095ZG1DRHNnNEh0bWFuc25ZUWc3TGFVN0tDVjdaV2dJT3VWakFvSzY2cUY3Wm1WN1pXY0lPeWdsZXV6dE9xd2dDRHNsNGJzbHJUc2hKd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeW5nZXlna1NEdGpKRHJpNmp0bFpqcXNvd2c3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHN1YlRyazV6cnBid2c2N0NiN0p5ODdJV282NEtZN0pxVVB5RHJrN0hyb1ozdGxaanJxYlFnN0xxUTdJdWM2N0N4SU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SVNnN0oyWTZyQ0FJTzJWaE95YWxPMlZvQ0RybFl3S0N1eUVwT3VzdU95aHNPeUNyT3l5bU91ZnZDRHNncXpzbXFuc25wRHNuWmdnN0lTZzdKMlk2Nlc4SU9xNHNPdU1nTzJWdE95VnZDRHRsYUFnNjVXTUlPcXl2ZXlXdE91aG5DRHNvSlhzDQpwSkh0bFpqcXNvd2c3S2VJNjZ5NDdaVzA3SnFVTGdvSzdKaUlLUW90SU95ZHRPdXlpQ0RyaTZ6c2w1QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWbU91cHRPeUVuQ0RzbHJ6cnA0anJncGdnNjZlTTdLR3g3WldZN0lXbzY0S1k3SnFVUHdvS0l5TWc3SmlJN0ptNElETXVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBS0N1eUNyT3lhcWV5ZWtPeVhrT3F5akNEcnFvWHRtWlh0bFpqcXNvd2c2N2FBN0tDVjdLQ0I3SjI0SU91Q3RPeWFxZXlkaENEc2xZenJvS1RzcEpqc2xid2c3WldnSU91VmpPdUtsQ0RydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJFSU95TnFPdVBoQ0Rzb292c2xZVHNtcFF1Q2dvakl5TWc3SVNjNjdtRTdJcWs2Nlc4SU95Z2xleXhoZXlEZ1NEc2s3Z2c3SWlZSU95WGh1eWRoQ0RybFl3S0N1dTJnT3lnbGUyWWxleWN2T3VobkNEc2phanNsYndnN0lLczdKcXA3SjZRN0plUTZyS01JT3lEZ2UyWnFleWRoQ0RycW9YdG1aWHRsWmpxc293Zw0KN0oyNDdLZUE3SXVjN1lLc0lPeUltQ0Rzbm9qc2xyVHNtcFF1SUNvcTdKTzRJT3lJbUNEc2w0YnJpcFFnN0oyMDdKeWc2Nlc4SU8yVnFPcTdtQ0RzbFlqcmdyVHRsYlRzbzd6c2hManNtcFF1S2lvS0N1eVlpQ2tLTFNEc3A0RHF1SWpzbllBZzZyQ0E3SjZGN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SU95eXJleUdqT3VGaE95ZGhDRHNuSVR0bFp3ZzdJU2M2N21FN0lxazY0cVVJT3lWaE95bmdTRHNwSURydVlRZzdLU1I3SjIwN0plUTdKcVVMZ290SU9xenRldXN0T3lia095ZGdDRHRtNFRzbTVEcXVJanNuWVFnNjdPMDY0SzhJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdLQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE2ckNBSU95V3RPdVdwQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0RzbDRicmlwVHNwNEFnNjZxRjdabVY3WldZNnJLTUlPeWR1T3luZ08yVm9DRHNpSmdnN0o2STdKYTANCjdKcVVMZ29LN0ppSUtRb3RJT3lna09xeWdDRHF1TERxc0lRZzY0K1o3SldJSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla0NEc2hLRHRnNTNzblpnZzZyS3c2ck84NjZXOElPeVZpT3VDdE8yVm9DRHJsWXdLQ3V1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPeUVvTzJEbmV5ZGdDRHJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzY2cUY3Wm1WN1pXWTZyS01JT3lWak91Z3BPeWFsQzRLQ3V5WWlDa0tMU0R0bFp3ZzY3S0lJT3V3bE9xK3VPdXB0Q0RzdXBEc2k1enJzTEhzbllBZzY0dWs3SXVjSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrS0NpZnNvSlhyczdRZzdJaVk3S2VSDQpJT3lWaU91Q3RDY2c2NU94N0oyWUlPdXZ2T3F3a08yVm5DRHNnNEh0bWFuc2w1RHNoSndnS2lyc29KWHJzN1Rxc0lBZzY3TzA3Wmk0NjVDYzY0dWs2NHFVSU95Z2tDb3E3SjJFSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzbFl6cm9LUWc3SUtzN0pxcDdKNlE2Nlc4SU95VmlPeUxyTzJWbU9xeWpDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHNnNEhyaTdUc25iUWc2NEdkNjRLWTY2bTBJT3lnaE91c3VPcXdnT3VQaENEdG1ZM3F1TGpyajVucmk1anNuWmdnN0tDVjY3TzA2Nlc4SU91enZDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1Rxc0lBZzZyaXc2NkdkNjVDWTdLZUFJT3lWaXV5VmhPeWFsQzRLQ2lNaklPeVlpT3ladUNBMExpRHNvSnp0a29nZzdKcXA3SmEwNjRxVUlPdXdsT3ErdU95bmdDRHNsWXJxdUxBS0NpZnFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NjZzdKdVE3TG1aNjdPMDY0dWtJQ29xN1ptVTY2bTA3SjJZSU9xNA0Kc091S3BldXFoY0szNjdLRTdZcTg2NnFGNnJPODdKMllJT3lhcWV5V3RDRHNuYnpzdVpncUt1cXdnQ0RzbXJEc2hLRHNuYlRzbDVEc21wUXVDdXE0c091S3BldXFoZXlYa0NEc2s3RHNuYmdnNjR1bzdKYTBLT3V6Z09xeXZTd2c3S2VBN0tDVkxDRHJrN0hyb1owZzY1T3hLZXVsdkNEc2xZanJnclFnNjZ5NDZyV3M3SmVRN0lTY0lPdUxwT3VsdUNEcnA1RHJvWndnNjdDVTZyNjQ2Nm0wSU95Q3JPeWFxZXlla09xd2dDRHJpNlRycGJnZzZyaXc2NHFsN0p5ODY2R2NJT3lZcE8yVnRPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1NBbjZyYU03WldjSU91emdPcXl2U2NnNnJpdzY0cWw3SjJZSU95VmlPdUN0Q0RyckxqcXRhd0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V3bE9xL2dDRHNpSmdnN0o2STdKYTA3SnFVSUNoWUtRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWUNCmtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3T0E2cks5N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cENnb2pJeURzbUlqc21iZ2dOUzRnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NJT3lUc095bmdDRHNsWXJxdUxBS0N1dXN1T3Exck91bHZDRHNsWVRyckxUcnBxd2c2NmVrNjRHRTY1Kzk2cktNSU91THBPdVRyT3lXdE91UGhDQXFLdXlMcE95Z25DRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F3cUt1dWx2Q0RzazdEcnFiUWc3SjZZNjZxNzY1Q2NJT3VzdU9xMXJPeVlpT3lhbEM0S0N1eVlpQ2tnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDQW43TGFVNnJDQUlPeW5nT3lnbFNmdGxaanJpcFFnN0l1YzdJcWs3WVdjN0plUTdJU2NJQ2pzbmJUc29JVEN0K3lXa2V1UGhDRHF1TERyaXFYc25iUWc3SldFNjR1WUtRb3RJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDRHJoSmpxDQpzcWpzbzd6c2hManNtcFFnS0ZnZzRvQ1VJT3lYaHV1S2xDQW42NFNZNnJpdzZyaXdKeURxdUxEcmlxWHNuWVFnN0pXVTdJdWNLUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxiUWc3S084N0lTNDdKcVVJQ2hQS1FvPQ0KOjpMQVVOQ0hFUjo6DQovLzRuQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJDQUhJQWFRQmtBR2NBWlFBZ0FHd0FZUUIxQUc0QVl3Qm9BR1VBY2dBZ0FCUWdJQURvc3NTc3hMd2dBQ1RCRmNnZ0FCRElnS3dnQU1UV0lBRGtzcXk1SUFEa3dvblZDZ0FuQUNBQVl3QnNBR0VBZFFCa0FHVUFZZ0J5QUdrQVpBQm5BR1VBT2dBdkFDOEFJQUFFMVZ5NG9ORmN6M1RISUFCMHh5QUFETk44eDBUSElBQ0F2WGk1NUxJZ0FDZ0E4YlJkdURvQUlBQnVBSEFBYlFBZ0FHa0FiZ0J6QUhRQVlRQnNBR3dBSUFBUXRwU3lJQUFpQUhUUVhMamN0Q0FBNU00bHNURFJJZ0FnQUNUQldNNGdBQXpUZk1jcEFDNEFDZ0FuQUNBQVZMc0FyQ0FBWUw0NHlDQUFpTWM4eDNTNklBQmMxU0FBaUx6UXhTQUFXTldZc0NuRklBQkl4YlN3V05YZ3JDd0FJQURrc2lBQUFNbEV2aGkwZExvZ0FPU3lyTGw4dVNBQVBjd2dBTWJGZE1jZ0FPVENpZFZjMWVTeUxnQUtBRk1BWlFCMEFDQUFaZ0J6QUc4QUlBQTlBQ0FBUXdCeUFHVUFZUUIwQUdVQVR3QmlBR29BWlFCakFIUUFLQUFpQUZNQQ0KWXdCeUFHa0FjQUIwQUdrQWJnQm5BQzRBUmdCcEFHd0FaUUJUQUhrQWN3QjBBR1VBYlFCUEFHSUFhZ0JsQUdNQWRBQWlBQ2tBQ2dCVEFHVUFkQUFnQUhNQWFBQWdBRDBBSUFCREFISUFaUUJoQUhRQVpRQlBBR0lBYWdCbEFHTUFkQUFvQUNJQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZNQWFBQmxBR3dBYkFBaUFDa0FDZ0JrQUdrQWNnQWdBRDBBSUFCbUFITUFid0F1QUVjQVpRQjBBRkFBWVFCeUFHVUFiZ0IwQUVZQWJ3QnNBR1FBWlFCeUFFNEFZUUJ0QUdVQUtBQlhBRk1BWXdCeUFHa0FjQUIwQUM0QVV3QmpBSElBYVFCd0FIUUFSZ0IxQUd3QWJBQk9BR0VBYlFCbEFDa0FDZ0J6QUdnQUxnQkRBSFVBY2dCeUFHVUFiZ0IwQUVRQWFRQnlBR1VBWXdCMEFHOEFjZ0I1QUNBQVBRQWdBR1FBYVFCeUFBb0FDZ0FuQUNBQU1RQXZBRElBS1FBZ0FFNEFid0JrQUdVQUxnQnFBSE1BSUFBUXlJQ3NJQUFVSUNBQXhzVTh4M1M2SUFEa3NyVEdYTGpjdENBQW1OTjB4OERKZkxrZ0FQVEZ0TVVBeWVTeUNnQkpBR1lBSUFCekFHZ0ENCkxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BSUFCM0FHZ0FaUUJ5QUdVQUlBQnVBRzhBWkFCbEFDSUFMQUFnQURBQUxBQWdBRlFBY2dCMUFHVUFLUUFnQUR3QVBnQWdBREFBSUFCVUFHZ0FaUUJ1QUFvQUlBQWdBRWtBWmdBZ0FFMEFjd0JuQUVJQWJ3QjRBQ2dBSWdCT0FHOEFaQUJsQUM0QWFnQnpBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0JiQUZYV2VNZGRBRVRISUFBRXNuUzVkTG9nQU9TeXRNWmN1TnkwSUFDWTAzVEh3TWtBckNBQTlNVzl1Y2l5NUxJdUFDQUFKTUZZem55NUlBREl1VnpPSUFDa3RDd0FJQUFNMWV5MytLMTR4OURGSE1FZ0FIVFFYTGpjdENBQWhMeTgwa1RISUFEa3N0ekNJQUFNc3V5M0lBRDh5RGpCbE1ZdUFDSUFMQUFnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBDQpJQUIyQUdJQVR3QkxBRU1BWVFCdUFHTUFaUUJzQUNBQUt3QWdBSFlBWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BREVBTHdBeUFDa0FJQUFVSUNBQVRnQnZBR1FBWlFBdUFHb0Fjd0FpQUNrQUlBQTlBQ0FBZGdCaUFFOEFTd0FnQUZRQWFBQmxBRzRBQ2dBZ0FDQUFJQUFnQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JvQUhRQWRBQndBSE1BT2dBdkFDOEFiZ0J2QUdRQVpRQnFBSE1BTGdCdkFISUFad0F2QUdzQWJ3QXZBR1FBYndCM0FHNEFiQUJ2QUdFQVpBQWlBQW9BSUFBZ0FFVUFiZ0JrQUNBQVNRQm1BQW9BSUFBZ0FGY0FVd0JqQUhJQWFRQndBSFFBTGdCUkFIVUFhUUIwQUFvQVJRQnVBR1FBSUFCSkFHWUFDZ0FLQUNjQUlBQXlBQzhBTWdBcEFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNBQUVNaUFyQ0FBRkNBZ0FNYkZQTWQwdWlBQUpNRll6cmNBWExqNHJYakhJQUFwdkpXOFJNY2dBRWpGdExCYzFlU3lDZ0JKQUdZQQ0KSUFCekFHZ0FMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQUlBQjNBR2dBWlFCeUFHVUFJQUJqQUd3QVlRQjFBR1FBWlFBaUFDd0FJQUF3QUN3QUlBQlVBSElBZFFCbEFDa0FJQUE4QUQ0QUlBQXdBQ0FBVkFCb0FHVUFiZ0FLQUNBQUlBQk5BSE1BWndCQ0FHOEFlQUFnQUNJQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpQUFLQUFRdHBTeUlBQlFBRUVBVkFCSUFOREZJQURHeGJURmxNWXBBQzRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQXcwZmk3RUxIUXhSekJJQUJFeFppM2ZMa2dBQ1RCV002M0FGeTQrSzE0eDF6VklBQ2t0Q3dBSUFCMDBGeTQzTFFnQUlTOHZOSkV4eUFBNUxMY3dpQUFETExzdHlBQS9NZzR3WlRHT2dBaUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUENCkpnQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBaUFDQUFJQUJ1QUhBQWJRQWdBR2tBYmdCekFIUUFZUUJzQUd3QUlBQXRBR2NBSUFCQUFHRUFiZ0IwQUdnQWNnQnZBSEFBYVFCakFDMEFZUUJwQUM4QVl3QnNBR0VBZFFCa0FHVUFMUUJqQUc4QVpBQmxBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUlBQWdBR01BYkFCaEFIVUFaQUJsQUNBQWJBQnZBR2NBYVFCdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBVmRaNHh5QUFLYnlWdkRvQUlBQXcwZmk3RUxIUXhSekJJQUJqQUd3QVlRQjFBR1FBWlFBZ0FDMEFMUUIyQUdVQWNnQnpBR2tBYndCdUFDQUFkTWNnQUlTOEJNaEV4eUFBbk0wbHVGalZkTG9nQUFESlJMNGdBRVRHekxpRng4aXk1TEl1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBDQpYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUtBQ3N3S25HeWJkQXh5QUFkTWNnQUZBQVF3RFF4U0FBWExqNHJYakhITFFnQUhUUVhMamN0Q0FBYkszRnN5QUFYTlhFczlERkhNRWdBQ2pNRUt3cHRNaXk1TEl1QUNrQUlnQXNBQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FIWUFZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FESUFMd0F5QUNrQUlBQVVJQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDSUFDZ0FnQUNBQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZFQWRRQnBBSFFBQ2dCRkFHNEFaQUFnQUVrQVpnQUtBQW9BSndBZ0FBREpSTDRnQUVUR3pMZ2dBQlFnSUFEa3NxeTVmTGtnQUQzTUlBREd4WFRISUFEa3dvblZJQUFvQUF6VjdMZjRyWGpIZE1jZ0FPZXNJQUNReDlteklBQVFyTURKS1FBS0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCakFHMEFaQUFnQUM4QVl3QWdBRzRBYndCa0FHVUFJQUJ6QUdNQQ0KY2dCcEFIQUFkQUJ6QUZ3QVl3QnNBR0VBZFFCa0FHVUFMUUJpQUhJQWFRQmtBR2NBWlFBdUFHb0Fjd0FpQUN3QUlBQXdBQ3dBSUFCR0FHRUFiQUJ6QUdVQUNnQT0NCjo6V0FUQ0hFUjo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rxc0pEc2k1enNucEFnNG9DVUlPMlZyZXlEZ1NEcmxxQWc3SjZJNjRxVUlPeTBpT3lHak8yWWxTRHNoSnpyc29RZ0tHeHZZMkZzYUc5emREb3hNVGc0T1NrS0x5OGc0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBQ2k4dklPeVpuQ0R0bFlUc21wVHRsWnpxc0lBNklPMlV2T3EzdU91bmlPcXdnQ0R0bEl6cm42enF0N2pzbmJqc25aZ2dZMnhoZFdSbFluSnBaR2RsT2k4dklPeVh0T3E0c0NoM2FXNWtiM2N1YjNCbGJpOXBabkpoYldVdmIzQmxia1Y0ZEdWeWJtRnNLZXVsdkFvdg0KTHlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293S0x5OGdVRTlUVkNBdmQyRnJaU0RycGJ3ZzY3TzA2NEswNjZtMElPcXdrT3lMbk95ZWtPcXdnQ0RyaTZUcnBxd29ZMnhoZFdSbExXSnlhV1JuWlM1cWN5bnJwYndnNjR5QTdJdWdJT3k4b091THBDNEtMeThLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQW92THlEcnFaVHJxcWpycHF3Z2ZqRTFUVUxybmJ3ZzY2R2M2cmU0N0oyNElPeUxuQ0RzbnBEcmo1a2c3SXVjN0o2UjdKeTg2NkdjSU95RGdleUwNCm5DRHN2Snpya2F6cmo0UWc2N2FBNjR1MElPeVhodXVMcENBbzY1T3g2NkdkT2lCdWNHMGdjblZ1SUdKMWFXeGtLUzRLTHk4ZzY0dWs2NmFzNjRxVUlPeUxyT3llcGV1d2xldVBtU0RyZ1lycXVMRHJxYlFnN0tPOTdLZUE2NmVNS08yVWpPdWZyT3EzdU95ZHVPcXp2Q0RzZzUzc2dxd2c2NCtaNnJpdzdabVVLU3dnNnJDUTdJdWM3SjZRNjRxVUlPcXpoT3lHalNEcmdxanNsWVFnNjR1azdKMk1JT3E1cU95YXNPcTRzT3VsdkNEcnNKdnJpcFRyaTZRdUNncGpiMjV6ZENCb2RIUndJRDBnY21WeGRXbHlaU2duYUhSMGNDY3BPd3BqYjI1emRDQndZWFJvSUQwZ2NtVnhkV2x5WlNnbmNHRjBhQ2NwT3dwamIyNXpkQ0JtY3lBOUlISmxjWFZwY21Vb0oyWnpKeWs3Q21OdmJuTjBJRzl6SUQwZ2NtVnhkV2x5WlNnbmIzTW5LVHNLWTI5dWMzUWdleUJ6Y0dGM2Jpd2djM0JoZDI1VGVXNWpJSDBnUFNCeVpYRjFhWEpsS0NkamFHbHNaRjl3Y205alpYTnpKeWs3Q2dwamIyNXpkQ0JRVDFKVUlEMGdNVEU0T0RrN0NtTnZibk4wDQpJRkpQVDFRZ1BTQndZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bktUc2dMeThnN0tDQTdKNmw3SWFNSU91anFPMkt1Q0RpZ0pRZzY0dWs2NmFzNnJDQUlISmxZMjl0YldWdVpDMWxlR0Z0Y0d4bGN5NXRaT3VsdkNEc3NMN3JpcFFnNnJpdzdLU0FDZ3BqYjI1emRDQkRUMUpUWDBoRlFVUkZVbE1nUFNCN0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFU5eWFXZHBiaWM2SUNjcUp5d0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFRXVjBhRzlrY3ljNklDZEhSVlFzSUZCUFUxUXNJRTlRVkVsUFRsTW5MQW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MUlaV0ZrWlhKekp6b2dKME52Ym5SbGJuUXRWSGx3WlNjc0NuMDdDbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3b2dJSEpsY3k1M2NtbDBaVWhsWVdRb2MzUmhkSFZ6TENCUFltcGxZM1F1WVhOemFXZHVLSHNnSjBOdmJuUmxiblF0Vkhsd1pTYzZJQ2RoY0hCc2FXTmhkR2x2Ymk5cQ0KYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzS0lDQnlaWE11Wlc1a0tFcFRUMDR1YzNSeWFXNW5hV1o1S0c5aWFpa3BPd3A5Q2dvdkx5QmpiR0YxWkdVZ1EweEo2ckNBSU95ZWlPdUtsT3luZ0NEaWdKUWc3SmVHN0p5ODY2bTBJQzkzWVd0bElPeWRrZXVMdGV5WGtDRHNpNlRzbHJRZzdaU002NStzNnJlNDdKMjQ3SjIwSU95VmlPdUN0TzJWb0NEc2lKZ2c3SjZJNnJLTUlPMlZuT3VMcEFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzRLTHk4ZzdZeU03SjI4N0oyMElPMkJ0Q0RzaUpnZzdKNkk3SmEwSURNdzdMU0lJT3k2a095TG5DNGc3SjZzNjZHYzZyZTQ3SjI0N1pXWTY2bTANCklFTk1TZXF3Z0NEdGpJenNuYnpzbllRZzZyQ3g3SXVnN1pXWTY2K0E2NkdjSU95ZWtPdVBtU0Ryc0pqc21JSHJrSnpyaTZRdUNpOHZJT3k2a095TG5DQTE3TFNJSU9LQWxDRHJvWnpxdDdqc25iZ2c3S2VCN1p1RUlPeURpQ0RxczRUc29KWHNuYlFnNnJPbjY3Q1U2NkdjSU95ZW9lMllnT3lWdkNEdGxJenJuNnpxdDdqc25ianNuYlFnNjZHYzZyZTQ3SjI0SU8yWmxPdXB0T3lYa095RW5DRHRtWWpzbkx6cm9ad2c2NFNZN0phMDZyQ0U2NHVrS0RNdzdMU0k2Nm0wSU91RWlPdXN0Q0RyaXFic25Zd3BDbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93cG1kVzVqZEdsdmJpQmpiR0YxWkdWQlkyTnZkVzUwS0NrZ2V3b2dJR2xtSUNoRVlYUmxMbTV2ZHlncElDMGdZV05qYjNWdWRFTmhZMmhsTG1GMElEd2dOVEF3TUNrZ2NtVjBkWEp1SUdGalkyOTFiblJEWVdOb1pTNWxiV0ZwYkRzS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093b2dJSFJ5ZVNCN0NpQWdJQ0JqDQpiMjV6ZENCcUlEMGdTbE5QVGk1d1lYSnpaU2htY3k1eVpXRmtSbWxzWlZONWJtTW9jR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0p5NWpiR0YxWkdVdWFuTnZiaWNwTENBbmRYUm1PQ2NwS1RzS0lDQWdJR1Z0WVdsc0lEMGdLR29nSmlZZ2FpNXZZWFYwYUVGalkyOTFiblFnSmlZZ2FpNXZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOektTQjhmQ0J1ZFd4c093b2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3Vobk9xM3VPeWR1Q0RzbmJUcm9LVWc3SmVHN0oyTUlPdVRzU0RpZ0pRZ2JuVnNiQ0FxTHlCOUNpQWdZV05qYjNWdWRFTmhZMmhsSUQwZ2V5QmhkRG9nUkdGMFpTNXViM2NvS1N3Z1pXMWhhV3dnZlRzS0lDQnlaWFIxY200Z1pXMWhhV3c3Q24wS0NtWjFibU4wYVc5dUlHaGhjME5zWVhWa1pTZ3BJSHNLSUNCamIyNXpkQ0JtYVc1a1pYSWdQU0J3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluSUQ4Z0ozZG9aWEpsSnlBNklDZDNhR2xqYUNjN0NpQWdkSEo1SUhzZw0KY21WMGRYSnVJSE53WVhkdVUzbHVZeWhtYVc1a1pYSXNJRnNuWTJ4aGRXUmxKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuTENCemFHVnNiRG9nZEhKMVpTQjlLUzV6ZEdGMGRYTWdQVDA5SURBN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGRIVnliaUJtWVd4elpUc2dmUXA5Q2dwc1pYUWdkMkZyYVc1bklEMGdabUZzYzJVN0lDOHZJT3lYc08yRGdDRHJzS25zcDRBZzRvQ1VJT3VMcE91bXJPdUtsQ0RzbHJUc3NLanRsTHdnUlVGRVJGSkpUbFZUUmV1aG5DRHNwSkhyczdVZzdLQ1Y2NmFzN1pXWTdLZUE2NmVNSU8yVWhPdWhuT3lFdU95S3BDRHJncTNydVlUcnBid2c3S1NFN0oyNDY0dWtDbVoxYm1OMGFXOXVJSGRoYTJWQ2NtbGtaMlVvS1NCN0NpQWdhV1lnS0hkaGEybHVaeWtnY21WMGRYSnVPd29nSUhkaGEybHVaeUE5SUhSeWRXVTdDaUFnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3SUhkaGEybHVaeUE5SUdaaGJITmxPeUI5TENBMU1EQXdLVHNLSUNCc1pYUWdjSEp2WXpzS0lDQnBaaUFvY0hKdlkyVnoNCmN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdMeThnVjJsdVpHOTNjem9nWTIxa3dyZDJZbk1nNnJLOTdKeWdJT3lYaHV5ZHRDQnViMlJsNjZXOElPeW5nZXlna1N3Z2QybHVaRzkzYzBocFpHVW9RMUpGUVZSRlgwNVBYMWRKVGtSUFZ5bnJvWndnN0lxazdZK3dJT0tBbEFvZ0lDQWdMeThnN0xDOUlPeVhodXVLbENEc2lLanNuWUFnN0wyWTdJYVU3SjIwSU91bmpPdVRwT3lXdE95bmdPcXpvQ0RyaTZUcnBxenNuWmdnN0o2UTdJdWRLR05zWVhWa1pTbnJqNFFnNnJlNElPeTltT3lHbE95ZGhDRHJyTHpyb0tUcnNKdnNsWVFnN0phMDY1YWtJT3l3dmV1UGhDRHNsWWdnNjV5czY0dWtMZ29nSUNBZ0x5OGdaR1YwWVdOb1pXVHJpcFFnN0pPdzdLZUFJT3lWaXV1S2xPdUxwQ2hrWlhSaFkyaGxaQ3QzYVc1a2IzZHpTR2xrWlNEc29iRHRsYW5zbllBZzdMMlk3SWFVSU95d3ZleWR0Q0RyaGJqc3RwenJrS2dnNG9DVUlPeUxwT3k0b1NrdUNpQWdJQ0F2THlCWGFXNWtiM2R6N0plUTdJU2dJR1JsDQpkR0ZqYUdWa0lPeVhodXlkdE91UGhDRHJ0b0RycXFnbzZyQ1E3SXVjN0o2UUtlcXdnQ0Rzbzczc2xyVHJqNFFnN0o2UTdJdWQ3SjJBSU95Q3RPeVZoT3VDcU91S2xPdUxwQzRLSUNBZ0lIQnliMk1nUFNCemNHRjNiaWh3Y205alpYTnpMbVY0WldOUVlYUm9MQ0JiY0dGMGFDNXFiMmx1S0Y5ZlpHbHlibUZ0WlN3Z0oyTnNZWFZrWlMxaWNtbGtaMlV1YW5NbktWMHNJSHNLSUNBZ0lDQWdZM2RrT2lCU1QwOVVMQ0J6ZEdScGJ6b2dKMmxuYm05eVpTY3NJSGRwYm1SdmQzTklhV1JsT2lCMGNuVmxMQW9nSUNBZ2ZTazdDaUFnZlNCbGJITmxJSHNLSUNBZ0lDOHZJRzFoWTA5VEwrdW1yT3VJaGV5S3BEb2c2ckNRN0l1YzdKNlE2Nlc4SU91ZGhPeWF0Q0J1YjJSbElPeUxwTzJXaVNEdGpJenNuYnpyb1p3ZzdLZUI3S0NSSU95S3BPMlBzQ0FvYkdGMWJtTm9aQ0R0bVpqcXNyM3NsNVFnVUVGVVNPcXdnQ0RydVlqc2xiM3RsYUFnN0lpWUlPeWVpT3lXdENEc29JanJqSURxc3Izcm9ad2c3SUtzN0pxcEtRb2dJQ0FnY0hKdg0KWXlBOUlITndZWGR1S0hCeWIyTmxjM011WlhobFkxQmhkR2dzSUZ0d1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5ZMnhoZFdSbExXSnlhV1JuWlM1cWN5Y3BYU3dnZXdvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUdSbGRHRmphR1ZrT2lCMGNuVmxMQ0J6ZEdScGJ6b2dKMmxuYm05eVpTY3NDaUFnSUNCOUtUc0tJQ0I5Q2lBZ2NISnZZeTUxYm5KbFppZ3BPeUF2THlEcXNKRHNpNXpzbnBBZzdKMjA2N0trN1lxNElPdWpxTzJVaE95WGtPeUVuQ0RydG9UcnBxd2dLT3F3a095TG5PeWVrQ0Rzb29Ycm80enJwYndnNjZlSjdLZUFJT3lWaXVxeWpDa0tmUW9LTHk4ZzdKMjBJRkJENjZXOElDZnNoS1RzdVpnZzdLQ0VLT3lEaUNCUVF5a25JT3lEZ2UyRG5PdWhuQ0Rya0pqcmo0enJwckRyaTZRZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNCYjdMU0k2cml3N1ptVVhTRHJzb1R0aXJ3b1VFOVRWQ0F2ZFc1cGJuTjBZV3hzS2V5ZHRDRHJ0b0RycGJqcmk2UXVDaTh2SUhKbFoybHpkR1Z5TFhCeWIzUnZZMjlzTG1wejZyQ0ENCklPeUVwT3k1bU8yVm5DRHFzb1BzbllRZzZyZTQ2NHlBNjZHY0lPdVFtT3VQak91bXNPdUxwRG9nNnJDUTdJdWM3SjZRSU95ZWtPdVBtZXlMbk95ZWtTQXJJQ2pzbm9qc25MenJxYlFwSU95RXBPeTVtQ0R0ajdUcmpaUXVDaTh2SU9LYW9PKzRqeURyc0pqcms1enNpNXdnU0ZSVVVDRHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPdXp0T3VDdUNEcmtxUWc3Wmk0N0xhYzdaV2dJT3F5Z3lEaWdKUWdiV0ZqVDFNZ2JHRjFibU5vWTNSc0lHSnZiM1J2ZFhUc25iUWc3SjIwSU8yVWhPdWhuT3lFdU95S3BPdWx2Q0RzcG9uc2k1d2c3S0tGNjZPTTdJdWM3WUtzSU95SW1DRHNub2pyaTZRdUNpOHZJQ0FnSU9xM3VPdWVtT3lFbkNEdGpJenNuYndvY0d4cGMzVEN0K3lFcE95NW1DRHRqN1RyalpRcDdKMkVJR3hoZFc1amFHTjBiT3V6dE91THBDRHJxTHpzb0lBZzdLZUE3SnEwNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc283M3NsNnpyajRRZzdKNlE2NCtaN0l1YzdKNlI3SjJBSU95ZHRPdXZ1Q0RzDQpncXpybmJ6c3A0VHJpNlF1Q21aMWJtTjBhVzl1SUhWdWFXNXpkR0ZzYkZObGJHWW9LU0I3Q2lBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUZ0ZE93b2dJSFJ5ZVNCN0NpQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKMlJoY25kcGJpY3BJSHNLSUNBZ0lDQWdZMjl1YzNRZ1RFRkNSVXdnUFNBblkyOXRMbU5zWVhWa1pXSnlhV1JuWlM1M1lYUmphR1Z5SnpzS0lDQWdJQ0FnWTI5dWMzUWdjR3hwYzNRZ1BTQndZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBblRHbGljbUZ5ZVNjc0lDZE1ZWFZ1WTJoQloyVnVkSE1uTENCTVFVSkZUQ0FySUNjdWNHeHBjM1FuS1RzS0lDQWdJQ0FnWTI5dWMzUWdhVzV6ZENBOUlIQmhkR2d1YW05cGJpaHZjeTVvYjIxbFpHbHlLQ2tzSUNkTWFXSnlZWEo1Snl3Z0owRndjR3hwWTJGMGFXOXVJRk4xY0hCdmNuUW5MQ0FuUTJ4aGRXUmxRbkpwWkdkbEp5azdDaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0hCc2FYTjBLU2tnZXlCbQ0KY3k1MWJteHBibXRUZVc1aktIQnNhWE4wS1RzZ2NtVnRiM1psWkM1d2RYTm9LSEJzYVhOMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzMEtJQ0FnSUNBZ2RISjVJSHNnYVdZZ0tHWnpMbVY0YVhOMGMxTjVibU1vYVc1emRDa3BJSHNnWm5NdWNtMVRlVzVqS0dsdWMzUXNJSHNnY21WamRYSnphWFpsT2lCMGNuVmxMQ0JtYjNKalpUb2dkSEoxWlNCOUtUc2djbVZ0YjNabFpDNXdkWE5vS0dsdWMzUXBPeUI5SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUW9nSUNBZ0lDQjBjbmtnZXlCemNHRjNibE41Ym1Nb0oyeGhkVzVqYUdOMGJDY3NJRnNuWW05dmRHOTFkQ2NzSUNkbmRXa3ZKeUFySUhCeWIyTmxjM011WjJWMGRXbGtLQ2tnS3lBbkx5Y2dLeUJNUVVKRlRGMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCOUlHTmhkR05vSUNoZlpTa2dlMzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHNZWFZ1WTJoamRHd25MQ0JiSjNKbGJXOTJaU2NzSUV4QlFrVk1YU3dnZXlCemRHUnBiem9nSjJsbmJtOXkNClpTY2dmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUW9nSUNBZ2ZTQmxiSE5sSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJSFJ5ZVNCN0lITndZWGR1VTNsdVl5Z25jbVZuSnl3Z1d5ZGtaV3hsZEdVbkxDQW5TRXREVlZ4Y1UyOW1kSGRoY21WY1hFMXBZM0p2YzI5bWRGeGNWMmx1Wkc5M2MxeGNRM1Z5Y21WdWRGWmxjbk5wYjI1Y1hGSjFiaWNzSUNjdmRpY3NJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5Snl3Z0p5OW1KMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE95QnlaVzF2ZG1Wa0xuQjFjMmdvSit5ZWtPdVBtZXlMbk95ZWtTaERiR0YxWkdWQ2NtbGtaMlZYWVhSamFHVnlLU2NwT3lCOUlHTmhkR05vSUNoZlpTa2dlMzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnDQpjM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPeUJ5WlcxdmRtVmtMbkIxYzJnb0oyTnNZWFZrWldKeWFXUm5aVG92THlEcms3SHJvWjBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5Q2lBZ0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUNBZ1kyOXVjM1FnYVc1emRDQTlJSEJoZEdndWFtOXBiaWh3Y205alpYTnpMbVZ1ZGk1TVQwTkJURUZRVUVSQlZFRWdmSHdnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMEZ3Y0VSaGRHRW5MQ0FuVEc5allXd25LU3dnSjBOc1lYVmtaVUp5YVdSblpTY3BPd29nSUNBZ0lDQWdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLR2x1YzNRcEtTQjdJR1p6TG5KdFUzbHVZeWhwYm5OMExDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTd2dabTl5WTJVNklIUnlkV1VnZlNrN0lISmxiVzkyWldRdWNIVnphQ2hwYm5OMEtUc2dmUW9nSUNBZ0lDQjlJR05oZEdOb0lDaGZaU2tnZTMwS0lDQWdJSDBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lCbVlXbHNMWE52Wm5RZzRvQ1VJT3VxdXlEcw0KcDREc21yUWc2cktNSU95ZWlPeVd0T3VQaENEdGxJenJuNnpxdDdqc25iZ2c3S3E5SU9xNHNPeVd0U0RzZ3Ezc29KenJpcFFnN0oyMDY2KzRJT3VCbmV1Q3JPdUxwQ0FxTHlCOUNpQWdjbVYwZFhKdUlISmxiVzkyWldRN0NuMEtDaTh2SU91THBPdW1yQ2d4TVRnNE9DbnFzSUFnNjVhZ0lPeWVpT3ljdk91cHRDRHJnWWpyaTZRZzRvQ1VJT3kwaU9xNHNPMlpsQ0RzaTV3ZzY0S283SjJBSU95RXVPeUZtQ0Rzb0pYcnBxd2dLT3lYaHV5Y3ZPdXB0Q0Rzb2JEc21xbnRub2dnN0l1azdZeW9LUXBtZFc1amRHbHZiaUJ6YUhWMFpHOTNia0p5YVdSblpTZ3BJSHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnY2lBOUlHaDBkSEF1Y21WeGRXVnpkQ2g3SUdodmMzUTZJQ2N4TWpjdU1DNHdMakVuTENCd2IzSjBPaUF4TVRnNE9Dd2djR0YwYURvZ0p5OXphSFYwWkc5M2JpY3NJRzFsZEdodlpEb2dKMUJQVTFRbkxDQjBhVzFsYjNWME9pQXhOVEF3SUgwc0lDZ3BJRDArSUh0OUtUc0tJQ0FnSUhJdWIyNG9KMlZ5Y205eUp5d2cNCktDa2dQVDRnZTMwcE93b2dJQ0FnY2k1dmJpZ25kR2x0Wlc5MWRDY3NJQ2dwSUQwK0lIc2dkSEo1SUhzZ2NpNWtaWE4wY205NUtDazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZTQjlLVHNLSUNBZ0lISXVaVzVrS0NrN0NpQWdmU0JqWVhSamFDQW9YMlVwSUh0OUNuMEtDbU52Ym5OMElITmxjblpsY2lBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtDaHlaWEVzSUhKbGN5a2dQVDRnZXdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5UMUJVU1U5T1V5Y3BJSHNnY21WekxuZHlhWFJsU0dWaFpDZ3lNRFFzSUVOUFVsTmZTRVZCUkVWU1V5azdJSEpsZEhWeWJpQnlaWE11Wlc1a0tDazdJSDBLSUNCcFppQW9jbVZ4TG5WeWJDQTlQVDBnSnk5b1pXRnNkR2duS1NCN0NpQWdJQ0F2THlCMk9pRHFzSkRzaTV6c25wQWc3TDJVNjVPY0lPdXloT3lnaENEaWdKUWc2cldzNjdLRTdLQ0VJTzJVaE91aG5PeUV1T3lLcE9xd2dDRHFzNFRzaG8wZzY0K002ck9nSU95ZWlPdUtsT3luZ0NEcnNKYnNsNURzaEp3ZzdabVY3SjI0DQo3WldZNjRxVUlPeWFxZXVQaEFvZ0lDQWdMeThnS0hZeUlEMGc3TEM5SU95SXFPcTVnQ0RzaUpqc29KWHRqSkFzSUhZeklEMGdMMkZqWTI5MWJuUWc3TGFVNnJDQTdZeVFMQ0IyTkNBOUlDOTFibWx1YzNSaGJHd2c3TGFVNnJDQTdZeVFLUW9nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUhkaGRHTm9aWEk2SUhSeWRXVXNJSFk2SURRZ2ZTazdDaUFnZlFvZ0lDOHZJT3lkdENCUVEreVhrQ0Ryb1p6cXQ3anNuYmpya0p3ZzdZRzA2NkdjNjVPY0lPcXpoT3lnbFNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SU95eXF5RHRtWlRycWJUQ3QrMlppT3lkdENBaTY0aUU2cldzSU9xemhPeWdsZXljdk91aG5DRHNrN0RyaXBUc3A0QWlJT3V6dE95WHJPeWp2T3VLbENEcmpiQWc3Sk8wNjR1a0xnb2dJQzh2SU9xd2tPeUxuT3lla09xd2dDRHJpN1h0bFpqcmlwUWc3SjIwN0p5Z09pRHJpNlRycHF6cnBid2c3THljNjZtMElPeWJqT3V3amV5WGhleWN2T3VobkNEdGdiVHJvWnpyazV6cQ0Kc0lBZzdJdWs3S0NjSU8yWXVPeTJuT3VQdkNEcXRhenJqNFVnN0lLczdKcXA2NStKN0oyMElPdUNtT3F3aE91THBDNEtJQ0F2THlEcXNKRHNpNXpzbnBEcmlwUWc3WXlNN0oyODY2ZU1JT3lkdmV5Y3ZPdXZnT3VobkNEc2dxenNtcW5ybjRrZ01DREN0eURyaklEcXVMQWdNQ0RpZ0pRZzZyS0E3WWFnNjZlTUlPeVRzT3VLbENEc2dxenJub3pzbDVEcXNvd2c2N21FN0pxcDdKMkVJT3Vzdk91bXJPeW5nQ0RzbFlycmlwVHJpNlF1Q2lBZ0x5OGc3S084N0oyWU9pRHNsNnpxdUxBZzZyT0U3S0NWN0oyMElPdXp0T3lYck91UGhDRHNub1hzbnFYcXRvenNuYlFnNjZlTTY2T002NUNRN0oyRUlPeUltQ0Rzbm9qcmk2UW83SnlnN1pxbzdJU3g3SjJBSU95THBPeWduQ0R0bUxqc3Rwd2c2NVdNNjZlTUlPeVZqQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHJpNlRycHF3Z0wyaGxZV3gwYU95ZG1DQndjbTlpYkdWdElPeXd1T3F6b0NrdUNpQWdhV1lnS0hKbGNTNTFjbXdnUFQwOUlDY3ZZV05qYjNWdWRDY3BJSHNLSUNBZ0lISmwNCmRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0JoWTJOdmRXNTBPaUJqYkdGMVpHVkJZMk52ZFc1MEtDa3NJR05zWVhWa1pUb2dhR0Z6UTJ4aGRXUmxLQ2tnZlNrN0NpQWdmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkzWVd0bEp5a2dld29nSUNBZ2FXWWdLQ0ZvWVhORGJHRjFaR1VvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklHWmhiSE5sTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuSUgwcE93b2dJQ0FnZDJGclpVSnlhV1JuWlNncE93b2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJSGRoYTJsdVp6b2dkSEoxWlNCOUtUc0tJQ0I5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNOb2RYUmtiM2R1SnlrZ2V3b2dJQ0FnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2DQphem9nZEhKMVpTQjlLVHNLSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwTENBeU1EQXBPd29nSUNBZ2NtVjBkWEp1T3dvZ0lIMEtJQ0F2THlEc3RJanF1TER0bVpRZzRvQ1VJT3lkdENCUVErdWx2Q0FuN0lPSUlGQkRKeURzZzRIdGc1enJvWndnNjVDWTY0K002NmF3NjR1a0lDanRsSXpybjZ6cXQ3anNuYmdnVyt5MGlPcTRzTzJabEYwZzY3S0U3WXE4S1M0S0lDQXZMeURzblpIcmk3WHNuWVFnNjZpODdLQ0FJTzJkbU91Z3BPdXp0T3VDdUNEcmtxUWc3S0NWNjZhczdaV2M2NHVrSU9LQWxDQmliMjkwYjNWMDdKMjBJT3lhc091bXJPdWx2Q0RzcG9uc2k1d2c3S085N0plczY0K0VJTzJhak95TG9PeWRnQ0RyajRUc3NLbnRsWnpyaTZRdUNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzVnVhVzV6ZEdGc2JDY3BJSHNLSUNBZ0lHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lIQnNZWFJtYjNKdA0KT2lCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUgwcE93b2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3Q2lBZ0lDQWdJSE5vZFhSa2IzZHVRbkpwWkdkbEtDazdDaUFnSUNBZ0lHTnZibk4wSUhKbGJXOTJaV1FnUFNCMWJtbHVjM1JoYkd4VFpXeG1LQ2s3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYmQyRjBZMmhsY2wwZzdMU0k2cml3N1ptVUtIVnVhVzV6ZEdGc2JDa2c0b0NVSU95Z25PcXhzRG9uTENCeVpXMXZkbVZrTG1wdmFXNG9KeXdnSnlrZ2ZId2dKeWpzbDRic25Zd3BKeWs3Q2lBZ0lDQWdJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdjSEp2WTJWemN5NWxlR2wwS0RBcExDQXlNREFwT3dvZ0lDQWdmU3dnTWpVd0tUc0tJQ0FnSUhKbGRIVnlianNLSUNCOUNpQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNRFFzSUhzZ1pYSnliM0k2SUNkT2IzUWdabTkxYm1RbklIMHBPd3A5S1RzS0NpOHZJT3lkdE91dnVDRHJscUFnN0o2STdKeTg2Nm0wSU95aHNPeWFxZTJlaUNEc29vWHJvNHdnS095ZWtPdVANCm1TRHNpNXpzbnBFZ0t5QnVjRzBnWW5WcGJHUWc3S1NSNjdPMUlPeUxwTzJXaVNEcmpJRHJ1WVFwQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXdvZ0lHbG1JQ2hsSUNZbUlHVXVZMjlrWlNBOVBUMGdKMFZCUkVSU1NVNVZVMFVuS1NCd2NtOWpaWE56TG1WNGFYUW9NQ2s3Q2lBZ2NISnZZMlZ6Y3k1bGVHbDBLREVwT3dwOUtUc0tjMlZ5ZG1WeUxteHBjM1JsYmloUVQxSlVMQ0FuTVRJM0xqQXVNQzR4Snl3Z0tDa2dQVDRnZXdvZ0lHTnZibk52YkdVdWJHOW5LQ2RiZDJGMFkyaGxjbDBnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rxc0pEc2k1enNucEFnN0x5YzdLZVFJT0tBbENCb2RIUndPaTh2Ykc5allXeG9iM04wT2ljZ0t5QlFUMUpVS1RzS2ZTazdDZz09DQo6OldTSUxFTlQ6Og0KSnlCRGJHRjFaR1VnUW5KcFpHZGxJSGRoZEdOb1pYSWdjMmxzWlc1MElHeGhkVzVqYUdWeUlDaHVieUIzYVc1a2IzY3BJQzBnY21WbmFYTjBaWEpsWkNCMGJ5QnlkVzRnWVhRZ2JHOW5hVzRLVTJWMElHWnpieUE5SUVOeVpXRjBaVTlpYW1WamRDZ2lVMk55YVhCMGFXNW5Ma1pwYkdWVGVYTjBaVzFQWW1wbFkzUWlLUXBUWlhRZ2MyZ2dQU0JEY21WaGRHVlBZbXBsWTNRb0lsZFRZM0pwY0hRdVUyaGxiR3dpS1Fwa2FYSWdQU0JtYzI4dVIyVjBVR0Z5Wlc1MFJtOXNaR1Z5VG1GdFpTaFhVMk55YVhCMExsTmpjbWx3ZEVaMWJHeE9ZVzFsS1FwemFDNURkWEp5Wlc1MFJHbHlaV04wYjNKNUlEMGdaR2x5Q25Ob0xsSjFiaUFpWTIxa0lDOWpJRzV2WkdVZ2MyTnlhWEIwYzF4aWNtbGtaMlV0ZDJGMFkyaGxjaTVxY3lJc0lEQXNJRVpoYkhObENnPT0NCjo6RU5EOjoNCg==";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAAA4wEfrt8UBALfFAQAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21sa1oyVXBDaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdUNpOHZDaTh2SU95R2pldVBoQ0RzaEtUcXM0UTZJTzJCdE91aG5PdVRuT3VsdkNEc21wVHNzcTNycDRqcmk2UWc3SU9JNjZHY0lPeUxuT3VQbWUyVm1PdXB0Q0F6TUg0ME1PeTBpT3F3Z0NEcXQ3anJnNlVnNjRLZzdKV0U2ckNFNjR1a0xnb3ZMeURpaHBJZzY0dWs2NmFzNjZXOElPeThwQ0RybFl3ZzdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZGhDRHRsWmpyZ3BnZzdKZTA3SmEwSU95RGdleUxuQ0RyaklEcXVMRHNpNXp0Z3FUcXM2QW9jM1J5WldGdExXcHpiMjRnNjR5QTdabVVJT3VxcU91VG5Da3NDaTh2SUNBZzZyQ0E3SjIwNjVPY0sreVlpT3lMbkNneE1USHFzYlFwNjRxVUlPeXlxeURycVpUc2k1enNwNERyb1p3ZzdaV2NJT3V5aU91bmpDRHNuYjN0bm96cmk2UXVJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2Nnk0NnJXczY2ZU1JT3V6dE91Q3RPdXZnT3VobkNEcnVhRHJwYlRyaTZRdUNpOHZJT3lFdU95Rm1PeWRnQ0F6TU91eWlDRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdaVzBJT3VNZ08yWmxPcXdnQ0RyckxUdGxaenRub2dnNnJpNDdKYTA3S2VBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpOHZDaTh2SU95Z2hPeWduRG9nN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPeWRoQ0Rxc29NZ0tHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKeTg2NkdjSU8yWmxleWR1Q2tLTHk4ZzdLTzg3SjJZT2lEc2dxenNtcW5ybjRuc25ZQWc2ckNCN0o2UUlPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFuT3VMcEM0S0NtTnZibk4wSUdoMGRIQWdQU0J5WlhGMWFYSmxLQ2RvZEhSd0p5azdDbU52Ym5OMElHWnpJRDBnY21WeGRXbHlaU2duWm5NbktUc0tZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3Q25SeWVTQjdJR1p6TG0xclpHbHlVM2x1WXloRlRWQlVXVjlEVjBRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbElIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwamIyNXpkQ0JEVEVGVlJFVmZSVTVXSUQwZ1QySnFaV04wTG1GemMybG5iaWg3ZlN3Z2NISnZZMlZ6Y3k1bGJuWXNJSHNLSUNCTlFWaGZWRWhKVGt0SlRrZGZWRTlMUlU1VE9pQW5NQ2NzSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNnNTNxc0lFZzY2cW82NU9jSU91QmxDQW83S2VuN0oyQUlPdXN1T3Exck95WGxDRHJ0b2p0bFlUc21wUXBDaUFnUTB4QlZVUkZYME5QUkVWZlJFbFRRVUpNUlY5T1QwNUZVMU5GVGxSSlFVeGZWRkpCUmtaSlF6b2dKekVuTENBdkx5RHRoTFFnN0pxVTdKVzlJT3VUc1NEcnRvRHFzSUFnN1ppNDdMYWNJT3VCbEFvZ0lFUkpVMEZDVEVWZlZFVk1SVTFGVkZKWk9pQW5NU2NzQ24wcE93b0tZMjl1YzNRZ1VFOVNWQ0E5SUU1MWJXSmxjaWh3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVUU5U1ZDa2dmSHdnTVRFNE9EZzdJQzh2SUVKU1NVUkhSVjlRVDFKVTY0cVVJTzJGak95S3BPMkt1T3lhcVNBbzdZK0o3SWFNN0plVUlERXhPRGc0SU9xem9PeWdsU2tLTHk4ZzY0dWs2NmFzSU95OWxPdVRuQ0Ryc29Uc29JUWc0b0NVSUM5b1pXRnNkR2pyb1p3ZzY0VzQ3TGFjN1pXYzY0dWtMaURzdlpUcms1enJwYndnY0hWc2JNSzM2N08xN0lLczdaVzA2NCtFSUNvcTdKMjA2Nis0SU91V29DRHNub2pyaXBRZzY0dWs2NmFzNjRxVUlPeVlteURzdlpUcms1d2c2cmU0NjR5QTY2R2NLaXJybmJ3S0x5OGc2cnVRNjR1a0lPeThuT3E0c0NEc29JVHNsNVFnN0lPSUlPdVBtZXlla2V5ZHRDRHNsWWdnNjRLWTdKaW82NHVrS08yRXNPdXZ1T3VFa095ZHRDRHJuS2pyaXBRZzY1T3hLUzRnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKTHNuTHpyb1p3ZzZyV3M2N0tFN0tDRTdKMkVJT3F3a095bmdPMlZ0Q0RzbnF6c2k1enNucEhzaTV6dGdxanJpNlF1Q2k4dklPdVBtZXlla2V5ZHRDRHJzSlRyZ0l6cmlwUWc3SWlZN0tDVjdKMkVJTzJWbU91cHRDRHNuYlFnN0lpcjdKNlE2Nlc4SU95WXJPdW1yT3F6b0NCamIyUmxMblJ6N0oyWUlFSlNTVVJIUlY5TlNVNWZWdXVQaENEcXNKbnNuYlFnN0ppczY2YXc2NHVrTGdwamIyNXpkQ0JDVWtsRVIwVmZWaUE5SURFek93b3ZMeURxdUxEcnM3Z2c2NnFvNjQyNExpRHNtcFRzc3EwbzdaU002NStzNnJlNDdKMjRLZXlkdENCdGIyUmxiT3lkaENEc3A0RHNvSlh0bFpqcnFiUWc2cmU0SU95YWxPeXlyZXVuakNEcXQ3Z2c2NnFvNjQyNDY2R2NJT3l5bU91bXJPMlZuT3VMcEM0S0x5OGdhR0ZwYTNVOTY3bWc2NmFFTCtxd2dPdXl2T3liZ0N3Z2MyOXVibVYwUGV5a2tlcXdoQ3dnYjNCMWN6M3F1TERyczdnbzdMV2M2ck9nN1pLSTdLZUlMQ0Rzb2JEcXVJZ2c2NHFRNjZhOEtRcGpiMjV6ZENCRFRFRlZSRVZmVFU5RVJVd2dQU0J3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVFU5RVJVd2dmSHdnSjI5d2RYTW5Pd3BqYjI1emRDQkJURXhQVjBWRVgwMVBSRVZNVXlBOUlGc25hR0ZwYTNVbkxDQW5jMjl1Ym1WMEp5d2dKMjl3ZFhNblhUc0tZMjl1YzNRZ1ZGVlNUbDlVU1UxRlQxVlVYMDFUSUQwZ09UQXdNREE3SUNBZ0x5OGc3SnFVN0xLdElESHFzYlFnN0tDYzdaV2M3SXVjNnJDRUNtTnZibk4wSUUxQldGOVVWVkpPVXlBOUlETXdPeUFnSUNBZ0lDQWdJQ0FnSUM4dklPeWR0T3Vuak8yQnZDRHNrN0RycWJRZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NBbzY0eUE3Wm1VSU91SWhPeWdnU0Ryc0tuc3A0QXBDZ292THlEaWxJRGlsSUFnN0ppSTdJdWNJT3lDck95Z2hDRHJvWnpyazV3Z0tISmxZMjl0YldWdVpDMWxlR0Z0Y0d4bGN5NXRaQ0RpZ0pRZ1luVnBiR1F0WjJ4dmMzTmhjbmt1YW5Qc21ZQWc2ckNaN0oyQUlPMk1qT3lFbkNrZzRwU0E0cFNBQ21aMWJtTjBhVzl1SUd4dllXUkZlR0Z0Y0d4bGN5Z3BJSHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYldRZ1BTQm1jeTV5WldGa1JtbHNaVk41Ym1Nb2NHRjBhQzVxYjJsdUtGOWZaR2x5Ym1GdFpTd2dKeTR1Snl3Z0ozSmxZMjl0YldWdVpDMWxlR0Z0Y0d4bGN5NXRaQ2NwTENBbmRYUm1PQ2NwT3dvZ0lDQWdZMjl1YzNRZ2MyVmpTV1I0SUQwZ2JXUXVjMlZoY21Ob0tDOWVJeU1nN0xhVTdMS2NJT3lZaU95TG5GeHpLaVF2YlNrN0NpQWdJQ0JwWmlBb2MyVmpTV1I0SUQwOVBTQXRNU2tnY21WMGRYSnVJRnRkT3dvZ0lDQWdZMjl1YzNRZ1pYaGhiWEJzWlhNZ1BTQmJYVHNLSUNBZ0lHeGxkQ0JqZFhJZ1BTQnVkV3hzT3dvZ0lDQWdabTl5SUNoamIyNXpkQ0J5WVhjZ2IyWWdiV1F1YzJ4cFkyVW9jMlZqU1dSNEtTNXpjR3hwZENnblhHNG5LU2tnZXdvZ0lDQWdJQ0JqYjI1emRDQnNhVzVsSUQwZ2NtRjNMbkpsY0d4aFkyVW9MMXh6S3lRdkxDQW5KeWs3Q2lBZ0lDQWdJR052Ym5OMElHZ2dQU0JzYVc1bExtMWhkR05vS0M5ZUl5TWpYSE1yS0M0clB5bGNjeW9rTHlrN0NpQWdJQ0FnSUdsbUlDaG9LU0I3SUdOMWNpQTlJSHNnYVc1d2RYUTZJR2hiTVYwc0lITjFaMmRsYzNScGIyNXpPaUJiWFNCOU95QmxlR0Z0Y0d4bGN5NXdkWE5vS0dOMWNpazdJR052Ym5ScGJuVmxPeUI5Q2lBZ0lDQWdJR052Ym5OMElHSWdQU0JzYVc1bExtMWhkR05vS0M5ZVhITXFMVnh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9ZaUFtSmlCamRYSXBJR04xY2k1emRXZG5aWE4wYVc5dWN5NXdkWE5vS0dKYk1WMHVjM0JzYVhRb0p5QXZJQ2NwTG1wdmFXNG9KeUFuS1NrN0NpQWdJQ0I5Q2lBZ0lDQnlaWFIxY200Z1pYaGhiWEJzWlhNdVptbHNkR1Z5S0NobEtTQTlQaUJsTG5OMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBK0lEQXBPd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNtSWpzaTV3ZzdJS3M3S0NFSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lYaHV5ZHRDRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z1cxMDdDaUFnZlFwOUNnb3ZMeURpbElEaWxJQWc3S2VBN0l1YzY2eTRJQ2pzaEp6cnNvUWdjbVZqYjIxdFpXNWs3Sm1BSU9xd21leWRnQ0RxdDV6c3Vaa2c0b0NVSU91d2xPcSt1T3VwdENEcXQ3anNxcjNyajRRZzdaV282cnVZS1NEaWxJRGlsSUFLTHk4ZzdKcXA3SmEwN0tlUktHZHNiM056WVhKNUxtMWtLZXlkZ0NEc25ienJ0b0RybjZ3ZzdaU0U2NkdzN1pTRTdZcTQ3SmVRSU95VmlDRHJoS1ByaXBUcmk2UW9NakF5Tmkwd055RHNpNlRzdUtFcE9pRHJoS1Bzbkx6cnFiUWc3WUcwNjZHYzY1T2M2ckNBSU95YXFleVd0Q0RxdFpEc29KWHNuWVFLTHk4ZzdLTzhJT3llaE91c3RPdWhuQ0RzbUtUdGxiVHRsYlFnTStxd25DRHNvSnpzbFlqc25iUWc3S0NFNjdhQUlDTHRrWnpxdUxBZzZyT2c3TG1vSUNzZzdKYTA3SWljSU91emdPcXl2U0xzbmJRZzY1Q2M2NHVrTGlEc2w2M3RsYUFnNjdhRTY2YXNJT0tBbEFvdkx5RHRnYlRyb1p6cms1d2dQU0Ryckxqc25xVWc2NHVrNjVPczZyaXdLT3l3dmV5ZG1Da3NJT3lhcWV5V3RDRHRoclhzbmJ6Q3QrdW5udXkycE91eWxTQTlJR052WkdVdWRITWdjbVZtYVc1bFFXbFRkV2RuWlhOMGFXOXVjeUR0bTRUc3NwanJwcXdvNnJpdzZyT0U3S0NCS1M0S1kyOXVjM1FnVTFSWlRFVmZVbFZNUlZNZ1BTQmJDaUFnSnpFdUlPMlZ0T3lhbE95eXREb2c2NnFvNjVPZ0lPdXN1T3Exck91S2xDRHRsYlRzbXBUc3NyVHJvWnd1SUNqcnM3VHJnNFhyaTRqcmk2VGlocExyczdUcmdyVHNtcFFwSnl3S0lDQW5NaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0RvZzY1Q1E3SmEwN0pxVTRvYVM3WmFJN0phMDdKcVVMQ0IrN0plSUlPdTV2T3E0c0NqcnNKVHJnSXpzbDRqc2xyVHNtcFRpaHBMcnNKVHF2NmpzbHJUc21wUXBMaURyaTZnc0lPeWloZXVqak1LMzY2ZU02Nk9Nd3Jmc2w3RHNzclRDdCsyVnRPeW5nTUszNnJpdzY2R2R3cmZyaGJuc25Zd2c2NU94SU95TG5PeUtwTzJGbk95ZHRDRHNvN3pzc3JUc25iZ2c2ckt3NnJPODY0cVVJT3lJbU91UG1lMllsU0RzbktEc3A0QW83SmV3N0xLMDY0Kzg3SnFVTENEcmhibnNuWXpyajd6c21wUXBMaWNzQ2lBZ0p6TXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEE2SUNKKzdaV2dJT3lJbUNEc2w0YnNsclRzbXBRaUlPdU1nT3lMb0NBaWZ1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENJZzZyV3M3S0d3SU95YXNPeUVvQzRnNjR1b0xDRHNvSlhzc1lYc2c0RWc2N2FJNnJDQXdyZnNuYnpydG9BZzZyaXc2NHFsSU95Z25PMlZuTUszNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzZyS3c2ck84d3Jmc29KWHJzN1FnNjdPMDdaaTRJT3lWaU95THJPeWRnQ0RydG9Ec29KWHRtSlhzbkx6cm9ad2c2NnFGN1ptVjdaNklMaWNzQ2lBZ0p6UXVJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclE2SUg3dGxaanNpNXpxc3FEc2xyVHNtcFEvNG9hU2Z1MlZvT3E1ak95YWxEOHNJT3F6aE95TG5PdUxwT0tHa3V5ZWlPdUxwQ3dnN0plczdLMkk2NHVrNG9hUzdabVY3SjI0N1pXWTY0dWtMQ0RxdTVqaWhwTHNsNURxc293dUlIN3NpNXdnNjdtODZyaXc2ckNBSU95V3RPeURpZTJWbU91cHRDRHRqSXpzbFlYdGxaanJvS1RyaXBRZzdLQ1Y2N08wNjZXOElPeWp2T3lXdE91aG5DRHJyTGpzbnFYc25ZUWc2NHVrN0l1Y0lPeVR0T3VMcEM0bkxBb2dJQ2MxTGlEcnFvWHNncXdyNjZxRjdJS3NJT3E0aU95bmdEb2c3WldjN0o2UTdKYTA2Nlc4SU8yU2dPeVd0Q0RyajVuc2dxenJvWndvN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBUaWhwTHNuYlRzbnBEcnBid2c2NCtNNjZDazY3Q2I3SldZN0phMDdKcVVLU3dnN0xXYzdJYU03WldjSUh2cnFvWHNncXg5NnJDQUlIdnJxb1hzZ3F4OTdaVzA3SVNjSU8yWWxlMkRuT3VobkNqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrdUp5d0tJQ0FuTmk0ZzdaR2M2cml3T2lEcmtKanNsclRzbXBUaWhwTHJqN3pzbXBRdUp5d0tJQ0FuTnk0ZzdLU0VJT3Exck95aHNEb2c3SnVRNjdPNDdKMjBJTzJWbkNEc3BJVHNuYlRycWJRZzdMYVU3TEtjNjQrRUlPdXdtT3VUbk95TG5DRHRsWndnN0tTRTY2R2NMaURzbm9Uc25aanJvWndnN0tTRTdKMkVJT3VLbU91bXJPeW5nQ0RzbFlycmlwVHJpNlF1SU91THFDd2c3SmVzNjUrc0lPdXN1T3llcGV5ZGhDRHRsWmpyZ3Bqc25aZ2c2cmlON0tDVjdaaVZJT3VzdU95ZXBleWN2T3VobkNEdGxhbnNzNUFnNjQyVUlPcXdoT3F5c08yVnRPeW5oT3VMcE91cHRDRHNwSVFnN0lpWTY2VzhJT3lraE95ZHRPdUtsQ0Rxc29Qc25ZQWc3Wm1ZN0ppQkxpY3NDaUFnSnpndUlPdUxwT3lkdE95V3ZPdWhuT3EzdUNEc21ienNxcjBnNjdLRTdZcThJT3Vkdk91eXFPeWRnQ0FpNjR1cjZyaXdJaWpzdDZqc2hvd2c2cmlJN0tlQUtTNG5MQW9nSUNjNUxpRHNuYlRycG9UQ3QreWdoTzJabE91eWlPMll1TUszNjZlSTdJcWs3WUs1N0oyQUlPcTN1T3VNZ091aG5DRHJzN1Rzb2JRdUlPeUNyT3Vlak95ZGhDRHJ0b0RycGJ3ZzY1V1FJT3VMbU95ZGhDRHJ0cG5zbDZ6cmo0UWc3S0tMNjR1a0xpY3NDaUFnSnpFd0xpRHNvSnp0a29nZzdKcXA3SmEwSU95Y29PeW5nRG9nN0o2RjY2Q2w3SmVRSU95VHNPeWR1Q0RxdUxEcmlxWHNoTEVnNjZxRjdJS3NLT3V6Z09xeXZTd2c3S2VBN0tDVkxDRHJrN0hyb1owc0lPMlZ0T3lnbkNEcms3RXA2NHFVSU8yWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhleWR2Q0Rxc0lEcmlxWHNoTEhzbmJRZzY0YVM3Snk4NjYrQTY2R2NJT3lKck95YXRDRHJwNURyb1p3ZzY3Q1U2cjY0N0tlQUlPeVZpdXVLbE91THBDNGc3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyaTZUcnBiZ2c2NCtaN0lLczY2VzhJT3lEaU91aG5DRHJwNHpyazZUc3A0QWc3SldLNjRxVTY0dWtMaWNzQ2wwdWFtOXBiaWduWEc0bktUc0tDbU52Ym5OMElFVllRVTFRVEVWVElEMGdiRzloWkVWNFlXMXdiR1Z6S0NrN0Nnb3ZMeURpbElEaWxJQWc3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Rzb0lUcnJMZ2c2NkdjNjVPY0lDaDFlQzEzY21sMGFXNW5MbTFrSU9LQWxDRHNtSWpzbWJnZzZyZWM3TG1aSU95RXVPdTJnQ0RzaTV6cmdwanJwcXpzbUtUcXVZenNwNEFnN1pTRTY2R3M3WlNFN1lxNDdKZVFJTzJQck8yVnFDa2c0cFNBNHBTQUNpOHZJRk5VV1V4RlgxSlZURVZUSURFdzdLU0VJT3lhbE95VnZldW5qT3ljdk91aG5PdUtsQ0RzbUlqc21iZ2dNWDR6S095SW1PdVBtZTJZbGNLMzZySzk3SmEwd3JmcnRvRHNvSlh0bUpVZzdaZUk3SnFwSU95OGdPeWR0T3lLcENuc25aZ2c2NG1ZN0pXWjdJcWs2ckNBSU95Y29PeUxwT3VRbk91THBDNEtMeThnN1l5TTdKMjg3SjIwSU95WGh1eWN2T3VwdENqc2hLVHN1WmpyczdnZzZyV3M2N0tFN0tDRUlPdVRzU2tnNjdtSUlPdXN1T3lla095WHRDRGlnSlFnN0pxVTdKVzk2NmVNN0p5ODY2R2NJT3VQbWV5ZWtTaG1ZV2xzTFhOdlpuUXBMZ3BtZFc1amRHbHZiaUJzYjJGa1IzVnBaR1VvS1NCN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHMWtJRDBnWm5NdWNtVmhaRVpwYkdWVGVXNWpLSEJoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNjdUxpY3NJQ2QxZUMxM2NtbDBhVzVuTG0xa0p5a3NJQ2QxZEdZNEp5a3VkSEpwYlNncE93b2dJQ0FnY21WMGRYSnVJRzFrTG14bGJtZDBhQ0ErSURFd01DQS9JRzFrSURvZ0p5YzdDaUFnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUtwTzJEZ095ZHZDRHFzSURzbmJUcms1d2c2NkdjNjVPY0lPeUxwTzJNcUNBbzdKcVU3Slc5NjZlTTdKeTg2NkdjSU95bmhPMldpU2s2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUhKbGRIVnliaUFuSnpzS0lDQjlDbjBLWTI5dWMzUWdSMVZKUkVVZ1BTQnNiMkZrUjNWcFpHVW9LVHNLQ21aMWJtTjBhVzl1SUdsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncElIc0tJQ0JqYjI1emRDQm1aWGRUYUc5MElEMGdSVmhCVFZCTVJWTXViV0Z3S0NobGVDa2dQVDRnSjBsdWNIVjBPaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvWlhndWFXNXdkWFFwSUNzZ0oxeHVUM1YwY0hWME9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29aWGd1YzNWbloyVnpkR2x2Ym5NcEtTNXFiMmx1S0NkY2JpY3BPd29nSUhKbGRIVnliaUFvQ2lBZ0lDQW43S2VBNnJpSTY3YUE3WVN3SU91RWlPdUtsQ0RzbDVEc2lxVHNtNUFvVXkweExDRHJzN1RzbFlqdG1venNncXdwN0oyWUlPMlZuT3ExcmV5V3RDQlZXQ0JYY21sMGFXNW5JT3lnaE91c3VPcXdnT3VobkNEc25ienRsWnpyaTZRdUlDY2dLd29nSUNBZ0ordUN0T3F3Z0NCVlNTRHJyTGpxdGF6cnBid2c3WldZNjRLWTdKU3BJT3V6dE91Q3RPdXB0Q3dnN0pXRTY1NllJT3lLcE8yRGdPeWR2Q0RxdDV6c3VabnNsNUFnNjZlZTZyS01JT3VMcE91VHJPeWRnQ0RyaklEc2xZZ2dNK3F3bk91bHZDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNmc21wVHNzcTNyazZUc25ZQWc3SVNjNjZHY0lPdXN0T3EwZ08yVm5DRHJzNFRxc0p3ZzY2eTQ2cldzNjR1a0lPS0FsQ0RzbmJUc29JUWc2Nnk0NnJXczY2VzhJT3l3dU95aHNPMlZtT3luZ0NEcnA0anJuYnd1WEc0bklDc0tJQ0FnSUNmc201RHJucGdnN0oyWTY2KzQ3Sm1BSU91cXFPdVRvQ0Rzb0pYcnM3UW83SjIwNjZhRXdyZnNpS3ZzbnBEQ3QreWhzT3F4dE1LMzY0eUE3SU9CS2V1bHZDRHNuS0RzcDREdGxaanFzNkFzSU9xd2dTRHNvSnpzbFlqc25ZQWc3SnVRNjdPNDZyTzg2NCtFSU95RW5PdWhuT3laZ091UGhDRHJpNnpybmJ6c2xid2c3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnNvYkRxc2JRZzdaR2M3WmlFS095ZHRPeURnY0szN0oyMDdaV1l3cmZzbmJUcmdyVEN0K3kwaU9xenZNSzM2Nis0NjZlTXdyZnJ0b0R0aExEQ3QrcTVqT3luZ0NEcms3RXA3SjJBSU95Z2xleXhoU0Rzb0pYcnM3VHJpNlFnNG9DVUlPdTV2T3F4c091Q21DRHJpNlRycGJnZzdLR3c2ckcwN0p5ODY2R2NJT3V3bE9xK3VPeW5nQ0RycDRqcm5id29Jalh0bW93ZzdKMjA3SU9CSXV5ZGhDQWlOZTJhakNMcm9ad2c3S1NFN0oyMDY2bTBJT3lZcE91THRTa3VJQ2NnS3dvZ0lDQWdKK3lia091c3VPeVhrQ0RzbDRicmlwUWc2cldzN0xLMElPeWdsZXV6dENqc29JVHRtWlRyc29qdG1MakN0MVZTVE1LMzZyaUk3Sldod3Jmc2k1enFzSVFnNjVPeEtleVpnQ0R0bGJUcXNyQWc2N0NwNjdLVndyZnNvSWpzc0tnbzdKNnM3SVNrN0tDVndyZnJyTGpzblpqc3NwakN0K3llck95TG5PdVBoQ0RyazdFcDY2VzhJT3luZ095V3RPdUN0Q0RydHBuc25iVHJpcFFnNnJLRDdKMkFJT3lnaU91TWdDRHF1SWpzcDRBZzRvQ1VJT3lWaE91S2xDRHFzSkxzbmJUcm5ienJqNFFzSU9xM3VPdWZ0T3VUcisyVnRPdVBoQ0RzazdEc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQW5NK3F3bkNEc29KenNsWWpzbllBZzdJU2M2NkdjSU95Z2tlcTN2T3lkdENEcmk2enJuYnpzbGJ3ZzdaV2M2NHVrSU9LQWxDRHRsWmpyZ3BqcmlwUWc3SnVRNjZ5NElPcTFyT3loc091bHZDRHNuS0RzcDREdGxad2c3TFdjN0lhTUlPdUxwT3VUck9xNHNDd2c3WldZNjRLWTY0cVVJT3VzdU95ZXBTRHF0YXpzb2JEcnBid2c3SjZzNnJXczdJU3g3WldjSU91TWdPeVZpQ3dnSnlBckNpQWdJQ0FuNnJlNDY2YXM2ck9nSU95Z2dleVd0T3VQaENEdGxaanJncGpyaXBRZzZyTzg2ckNRN1pXY0lPeWVyT3Exck95RXNUb2c3S1NSNjdPMUlPMlJuTzJZaE95ZGhDRHJqWnpzbHJUcmdyVHFzNkFzSU95Z2xldXp0Q0RzaUp6c2hKenJwYndnN0lLczdKcXA3SjZRNnJDQUlPeVZqT3lWaE95VnZDRHRsYUFnNnJLRDY3YUE3WVN3NjZHY0lPeWVyT3loc095bmdlMlZvQ0Rxc29NdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95ZHRDRHRsYlRxc3JBZzY3Q3A2N0tWN0oyRUlPdUx0T3F6b0NEc25vanNuWVFnNjVXTTY2ZU1JQ0xzbHJUcmxydnFzb3dnN1pXWTY2bTBJT3VMcE95TG5DRHJrSnpyaTZRaTY2VzhJT3lWbnV5RXVPeWFzT3VLbENEcXVJM3NvSlh0bUpVZzdKNnM2cldzN0lTeDdKMkVJTzJWbU91ZHZDRGlnSlFnN0p1UTY2eTQ3SmVRSU8yVnRPcXlzT3l4aGV5ZHRDRHNsNGJzbkx6cnFiUWc2NmVNNjVPazdKYTBJT3UybWV5ZHRPeW5nQ0RycDRqcm5id3VJQ2NnS3dvZ0lDQWdKKzJSbk9xNHNNSzM3SnFwN0phMDY2ZU1JT3F6b095NW1PcXpvQ0RzbHJUc2lKenNuWVFnNjdDVTZyNjhJT3lnbGV1UGhPeWRtQ0Rzb0p6c2xZanNuWVFnTStxd25DRHJpcGpzbHJUcmhwUHNwNEFnNjZlSTY1MjhJT0tBbENEcXQ3anFzYlFnN0lLczdKcXA3SjZRN0plUTZyS01JT3kybE95eW5PeWR0Q0RzbFlUcmk0anJuYndnNnJXUTdLQ1Y3Snk4NjZHY0lPdXp0T3lkdU91THBDNGdKeUFyQ2lBZ0lDQW43SldFNjU2WUlPeVlpT3lMbk91VHBPeWRnQ0R0bFp3ZzdLU0U3S2VjNjZhc0lPeTFuT3lHakNEcXRaRHNvSlhzbmJRZzY2ZU83S2VBNjZlTUlPcTN1T3F4dENEdGhxUW83WlcwN0pxVTdMSzB3cmZxc3Izc2xyUXA3SjJZSU9xMWtPdXp1T3lkdE95bmdDRHNob3pxdDduc2hMSHNuWmdnNnJXUTY3TzQ3SjIwSU95VmhPdUxpT3VMcENEaWdKUWc3SmVzNjUrc0lPdXN1T3llcGV5bm5PdW1yQ0Rzbm9Ycm9LWHNuWUFnNjZtVTdJdWM3S2VBSU91THFPeWNoT3VobkNEcmk2VHNpNXdnN0lTazZyT0U3WldZNjUyOExseHVKeUFyQ2lBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU91d3NPeVh0T3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUxwT3lhdE1LMzdJU2s2NnFGd3Jmc3ZaVHJrNXp0anB6c2lxUWc2cmlJN0tlQU9seHVKeUFyQ2lBZ0lDQW5XM3NpZEdWNGRDSTZJQ0xzb0p6c2xZZ2c2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0p5WldGemIyNGlPaUFpNjZ5MDdKZUg3SjJFSU95Wm5DRHJzSlRxdjZqcmlwVHNwNEFnN1pXYzZyV3Q3SmEwSU8yVm5DRHJyTGpzbnFVaWZTd2dMaTR1WFZ4dVhHNG5JQ3NLSUNBZ0lDZGI3SXFrN1lPQTdKMjhJT3Ezbk95NW1WMWNiaWNnS3lCVFZGbE1SVjlTVlV4RlV5QXJJQ2RjYmx4dUp5QXJDaUFnSUNBb1IxVkpSRVVnUHlBblcreUtwTzJEZ095ZHZDRHFzSURzbmJUcms1d2c3S0NFNjZ5NElDaDFlQzEzY21sMGFXNW5MbTFrS1NEaWdKUWc3SnlFSU9xM25PeTVtZXlkbUNEcXQ3enFzYkRzbVlBZzdKaUk3Sm00SU95TG5PdUNtT3Vtck95WXBDNGc3WXE1N1o2SUlPeVlpT3ladUNEcXQ1enN1WmtvN0lpWTY0K1o3WmlWd3JmcXNyM3NsclRDdCt1MmdPeWdsZTJZbGV5ZGhDRHNuS0RzcDREdGxiVHNsYndnN1pXWTY0cVVJT3lEZ2UyWnFTbnNuWVFnNnJlNDY0eUE2NkdjSU91VXNPdWx0T3F6b0N3ZzdKcVU3Slc5NnJPOElPeWdoT3VzdU95ZHRDRHJpNlRycGJUcnFiUWc3S0NFNjZ5NDdKMkVJT3VVc091bHVPdUxwRjFjYmljZ0t5QkhWVWxFUlNBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW9abVYzVTJodmRDQS9JQ2RiN0pxdzY2YXNJT3VxcWV5R2pPdW1yQ0RzbUlqc2k1d2c0b0NVSU95ZHRDRHRocVRzbllRZzY1U3c2Nlc4SU9xeWcxMWNiaWNnS3lCbVpYZFRhRzkwSUNzZ0oxeHVYRzRuSURvZ0p5Y3BJQ3NLSUNBZ0lDZnNwSURydVlUcmtKRHNuTHpycWJRZ0lrOUxJdXVkdk9xem9PdW5qQ0RyaTdYdGxaanJuYnd1SndvZ0lDazdDbjBLQ2k4dklPS1VnT0tVZ0NEc2c0SHNpNXdnNjR5QTZyaXdJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDbXhsZENCd2NtOWpJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDQWdMeThnN1lHMDY2R2M2NU9jSU8yVWhPdWhuT3lFdU95S3BBcHNaWFFnYkdsdVpVSjFaaUE5SUNjbk95QWdJQ0FnSUNBZ0lDOHZJSE4wWkc5MWRDRHNwSVFnNjdLRTdZMjhDbXhsZENCM1lXbDBaWElnUFNCdWRXeHNPeUFnSUNBZ0lDQWdMeThnN1ppRTdKNnNJTzJFdE95ZG1DQjdJSEpsYzI5c2RtVXNJSEpsYW1WamRDd2dkR2x0WlhJZ2ZRcHNaWFFnY1hWbGRXVWdQU0JRY205dGFYTmxMbkpsYzI5c2RtVW9LVHNnTHk4ZzdKcVU3TEt0SU95bmdldWdyTzJabENBbzY0K1o3SXVjSU95YWxPeXlyZXlkZ0NEc2lKenNoSnpyaklEcm9ad3BDbXhsZENCMGRYSnVjeUE5SURBN0NteGxkQ0IzWVhKdFpXUlZjQ0E5SUdaaGJITmxPd3BzWlhRZ1kzVnljbVZ1ZEUxdlpHVnNJRDBnUTB4QlZVUkZYMDFQUkVWTU95QXZMeURzcDREcXVJZ2c3SVM0N0lXWTdKMjBJT3Vzdk9xem9DRHNub2pyaXBRZzY2cW82NDI0SUNqc21wVHNzcTNzbmJRZzY0dWs2Nlc0SU91cXFPdU51T3lkaENEc3A0RHNvSlh0bFpqcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTa0tMeThnN0l1YzdKNlJJT3lMbkNCRGJHRjFaR1VnUTI5a1pTaGpiR0YxWkdVZ1EweEpLZXF3Z0NEc2s3Z2c3SWlZSU95ZWlPdUtsT3luZ0NEc29KRHFzb0FnNG9DVUlPeVhodXljdk91cHRDQXZhR1ZoYkhSbzY2R2NJT3lWak91Z3BDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdKV0k2NEswN1pXYzY0dWtMZ292THlCdWRXeHNQZTJabGV5ZHVDRHNwSkVzSUNkdmF5Yzk3SUtzN0pxcElPcXdnT3VLcFN3Z0oyTnNZWFZrWlMxdGFYTnphVzVuSnoxamJHRjFaR1VnNjZxRjY2QzVJT3lYaHV5ZGpDd0tMeThnSjJOc1lYVmtaUzFzYjJkdmRYUW5QV05zWVhWa1pldUtsQ0Rzbm9qc3A0RHJwNHdnNjZHYzZyZTQ3SjI0SU95RXVPeUZtQ0RycDR6cm80d2dLTzJFdENEc2k2VHRqS2dnN0l1Y0lPcXdrT3luZ0N3ZzdJU3g2ck8xSU8yRXRPeWR0Q0RzbUtUcnFiUWc3SjZRNjQrWklPMlZ0T3lnbkNrS2JHVjBJR05zWVhWa1pWTjBZWFIxY3lBOUlHNTFiR3c3Q2k4dklPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBSU9LQWxDQkRURW5xc0lBZzY0SzA2NHFVSU95WWdleVd0Q0RzbmJqc3BwMGc3SmlrNjZXWTY2VzhJT3lDck91ZWpPeWR0Q0RzbFl6c2xZVHJrNlRzbllRZzdKV0k2NEswNjZHY0lPdXdsT3Erdk91THBDNEtMeThnS0dOc1lYVmtaU0F0TFhabGNuTnBiMjdzbllBZzY2R2M2cmU0N0oyNElPeVhodXlkdE91UGhDRHNoTEhxczdYdGxiVHNoSndnN0l1YzY0K1pJT3lna09xeWdPeWN2T3Vobk91S2xDRHJxcnNnN0o2aDZyT2dMQ0RzaTZUc29Kd2c3WVMwN0plUTdJU2M2NmVNSU91VG5PdWZyT3VDbk91THBDa0tMeThnSXV1bmpPdWpqQ0xycDR6c25iUWc3SldFNjR1STY1MjhJQ0x0bFp3ZzY3S0k2NCtFSU91aG5PcTN1T3lkdUNEc2xZZ2c3WldvSXV1UGhDRHFzSm5zbllBZzZySzk2NkdjNjZHY0lPeWVvZTJlaU91dmdPdWhuQ0RzcEpIcnByMGc3WkdjN1ppRTdKMkVJT3lUdE91THBBcGpiMjV6ZENCTVQwZEpUbDlIVlVsRVJTQTlJQ2Z0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0N0oyMElPMlZoT3lhbE8yVnRPeWFsQ2pzbFlnZzY1Q1E2ckd3NjRLWUlPdW5qT3VqakNrZzRvQ1VJRnZ3bjUrZ0lPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c3WldFN0pxVVhTRHJzb1R0aXJ6c25ZUWc2NGlFNjZXMDY2bTBJT3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc3SmUwN0phMDY1T2M2NkNrN0pxVUxpYzdDaTh2SU95THBPeTRvZTJWbkNEcnJManF0YXpyazZRNklDSkdZV2xzWldRZ2RHOGdZWFYwYUdWdWRHbGpZWFJsT2lCUFFYVjBhQ0J6WlhOemFXOXVJR1Y0Y0dseVpXUWdZVzVrSUdOdmRXeGtJRzV2ZENCaVpTQnlaV1p5WlhOb1pXUWlLT3Vuak91ampDa3NDaTh2SUNKT2IzUWdiRzluWjJWa0lHbHVJTUszSUZCc1pXRnpaU0J5ZFc0Z0wyeHZaMmx1SWlqcnI3anJvWnpxdDdqc25iZ3BJT0tBbENEcmtaZ2c2NHVrSU95ZW9lMmVpT3F5akNEcmhKUHRub3pyaTZRS1puVnVZM1JwYjI0Z2FYTkJkWFJvUlhKeWIzSW9jeWtnZXdvZ0lISmxkSFZ5YmlBdllYVjBhR1Z1ZEdsallYUjhiMkYxZEdoOFlYQnBJR3RsZVh4c2IyY2dQMmx1Zkd4dloyZGxaSHh6WlhOemFXOXVJR1Y0Y0dseVpXUXZhUzUwWlhOMEtGTjBjbWx1WnloektTazdDbjBLTHk4ZzY2R2M2cmU0N0oyNDY1Q2NJT3F6aE95Z2xTRHRtWlhzbmJnZzRvQ1VJRU5NU2Vxd2dDQitMeTVqYkdGMVpHVXVhbk52YnV5WGtDRHF1TERyb1ozdGxaanJpcFFnYjJGMWRHaEJZMk52ZFc1MExtVnRZV2xzUVdSa2NtVnpjK3VsdkNEc25iM3NsclFLTHk4Z0wyaGxZV3gwYU91aG5DRHJoYmpzdHB6dGxaenJpNlFnS08yVWpPdWZyT3EzdU95ZHVPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFFnN0tTUjdKMjQ3S2VBSWlEdGtaenNpNXdnNG9DVUlPcXp0ZXlhcVNCUVEreVhrT3lFbkNEcmdxanNuWmdnNnJPRTdLQ1ZJT3lZcE95Q3JPeWFxU0Ryc0tuc3A0QXBMZ292THlEdGpJenNuYnpzbmJRZzdZRzBJT3lJbUNEc25vanNsclFvN1pTRTY2R2M3S0NkN1lxNElPeWR0T3VncFNEdGo2enRsYWdwSURNdzdMU0lJT3k2a095TG5DNGc3SjZzNjZHYzZyZTQ3SjI0N1pXWTY2bTBJRU5NU2Vxd2dDRHRqSXpzbmJ6c25ZUWc2ckN4N0l1ZzdaV1k2NitBNjZHY0lPeWVrT3VQbVNEcnNKanNtSUhya0p6cmk2UXVDbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93cG1kVzVqZEdsdmJpQmpiR0YxWkdWQlkyTnZkVzUwS0NrZ2V3b2dJR2xtSUNoRVlYUmxMbTV2ZHlncElDMGdZV05qYjNWdWRFTmhZMmhsTG1GMElEd2dNekF3TURBcElISmxkSFZ5YmlCaFkyTnZkVzUwUTJGamFHVXVaVzFoYVd3N0NpQWdiR1YwSUdWdFlXbHNJRDBnYm5Wc2JEc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdhaUE5SUVwVFQwNHVjR0Z5YzJVb1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxMbXB6YjI0bktTd2dKM1YwWmpnbktTazdDaUFnSUNCbGJXRnBiQ0E5SUNocUlDWW1JR291YjJGMWRHaEJZMk52ZFc1MElDWW1JR291YjJGMWRHaEJZMk52ZFc1MExtVnRZV2xzUVdSa2NtVnpjeWtnZkh3Z2JuVnNiRHNLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcm9aenF0N2pzbmJnZzdKMjA2NkNsSU95WGh1eWRqQ0RyazdFZzRvQ1VJRzUxYkd3ZzdKeWc3S2VBSUNvdklIMEtJQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lCRVlYUmxMbTV2ZHlncExDQmxiV0ZwYkNCOU93b2dJSEpsZEhWeWJpQmxiV0ZwYkRzS2ZRcG1kVzVqZEdsdmJpQmphR1ZqYTBOc1lYVmtaVUYyWVdsc1lXSnNaU2dwSUhzS0lDQmpiMjV6ZENCd2NtOWlaU0E5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSnkwdGRtVnljMmx2YmlkZExDQjdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlnZlNrN0NpQWdiR1YwSUc5MWRDQTlJQ2NuT3dvZ0lIQnliMkpsTG5OMFpHOTFkQzV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3SUc5MWRDQXJQU0JrTG5SdlUzUnlhVzVuS0NrN0lIMHBPd29nSUhCeWIySmxMbTl1S0NkbGNuSnZjaWNzSUNncElEMCtJSHNnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMk5zWVhWa1pTMXRhWE56YVc1bkp6c2dmU2s3Q2lBZ2NISnZZbVV1YjI0b0oyTnNiM05sSnl3Z0tHTnZaR1VwSUQwK0lIc0tJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2hqYjJSbElEMDlQU0F3SUNZbUlDOWNaQ3RjTGx4a0t5OHVkR1Z6ZENodmRYUXBLU0EvSUNkdmF5Y2dPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25Pd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJRU5zWVhWa1pTQkRiMlJsSU95Z2tPcXlnRG9nSnlBcklHTnNZWFZrWlZOMFlYUjFjeUFySUNodmRYUWdQeUFuSUNnbklDc2diM1YwTG5SeWFXMG9LU0FySUNjcEp5QTZJQ2NuS1NrN0NpQWdmU2s3Q24wS0x5OGc3TEtZNjZhc0lPMlloTzJacVNEaWdKUWdMMmhsWVd4MGFPdWhuQ0RyaGJqc3RwenRsYlFnSXV5Z2xldW5rQ0R0Z2JUcm9aenJrNXpxc0lBZzY0dTE3WmFJNjRxVTdLZUFJaURyc0pic2w1RHNoSndnN1ptVjdKMjQ3WldnSU95SW1DRHNub2pxc293ZzdaV2M2NHVrQ21OdmJuTjBJSE4wWVhSeklEMGdleUJ6WlhKMlpXUTZJREFzSUd4aGMzUkJkRG9nSnljc0lHeGhjM1JVWlhoME9pQW5KeXdnYkdGemRGTmxZem9nSnljZ2ZUc0tDaTh2SU9LVWdPS1VnQ0R0bEl6cm42enF0N2pzbmJnZzdJT2Q3S0cwSU9xd2tPeW5nQ2pzaTZ6c25xWHJzSlhyajVrcElPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0Fvdkx5RHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY1YWdJT3llaU91S2xDRHJqNW5zbFlnZ1kyOWtaUzUwYytxd2dDQTE3TFNJNjZlSTY0dWtJRkJQVTFRZ0wyaGxZWEowWW1WaGRPdWx2Q0RyczdUcmdyanJpNlF1Q2k4dklPMlZuQ0Ryc29qc25iVHJuYnpyajRRZzY3Q2I3SjJBSU91U3BDQXpNT3kwaU9xd2hDRHJnWXJxdUxEcnFiUWc3WlNNNjUrczZyZTQ3SjI0S091WWtPdUtsQ0R0bEx6cXQ3anJwNGdwN0oyMElPdUxxKzJlakNEcXNvTWc0b0NVSU8yQnRPdWhuT3VUbk9xNWpPeW5nQ0RyamJEcnBxenFzNkFnNnJDWjdKMjBJT3E2dk95bmhPdUxwQzRLTHk4ZzdKV0U3S2VCSU8yVm5DRHJzb2pyajRRZzY2cTdJT3V3bSt5Vm1PeWN2T3VwdENqcmk2VHJwcXpycDR3ZzY2aTg3S0NBSU95OG9DRHNnNEh0ZzV3c0lPeWVrT3VQbWV5TG5PeWVrU0RyazdFcElPcXpoT3lHalNEcmpJRHF1TER0bFp6cmk2UXVDbU52Ym5OMElFaEZRVkpVUWtWQlZGOUVSVUZFWDAxVElEMGdNekF3TURBN0NteGxkQ0JzWVhOMFFtVmhkQ0E5SURBN0NuTmxkRWx1ZEdWeWRtRnNLQ2dwSUQwK0lIc0tJQ0JwWmlBb2JHRnpkRUpsWVhRZ0ppWWdSR0YwWlM1dWIzY29LU0F0SUd4aGMzUkNaV0YwSUQ0Z1NFVkJVbFJDUlVGVVgwUkZRVVJmVFZNcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRsSXpybjZ6cXQ3anNuYmdnN0l1czdKNmw2N0NWNjQrWklPdUJpdXE1Z0NEaWdKUWc3WlM4NnJlNDY2ZUlMKzJVak91ZnJPcTN1T3lkdU95ZHRDRHJpNnZ0bm93ZzZyS0Q3Snk4NjZHY0lPdXp0T3F6b0NEcXNKbnNuYlFnNnJxODdLZVI2NHVJNjR1a0xpY3BPd29nSUNBZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3lBdkx5QmxlR2wwSU8yVnVPdVRwT3Vmck9xd2dDQnJhV3hzVUhKdlkreWN2T3VobkNCamJHRjFaR1VnN1lxNDY2YXM2Nlc4SU95Z2xldW1yTzJWbk91THBBb2dJSDBLZlN3Z05UQXdNQ2s3Q2dvdkx5RHJvWnpxdDdqc25iZ2dWVkpNN0oyRUlPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JQW82N08wN1lhMUlPeXd2U25yb1p3ZzdKZXM2NHFVSUVKU1QxZFRSVklnN1pXNDY1T2s2NStzSU95S3BPMkJyT3VtdmUyS3VPdWx2Q0RycDR6cms2RHJpNlF1Q2k4dklHTnNZWFZrWlNCRFRFbnJpcFFnUWxKUFYxTkZVaUR0bVpqcXNyM3JzNERzaUpqcnBid2c3S0cwN0tTUjdaVzBJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNwNEhzb0pFZzdKZTA3S2VBSU95Vml1cXpvQ0RzbmJRZzdJcWs3WUdzNjZhOTdZcTQ3SmVRSUdGMWRHaHZjbWw2WlNCVlVrenNuWVFnNjRTWTZyaTA2NHVrS095THBPeTRvU0F5TURJMkxUQTNLUzRLTHk4Z2JXOWtaVDBuYzNkcGRHTm9KeWpxczRUc29KVWc3S0NFN1ptWUtTRGlocElnN0lxNTdKMjRJTzJabE91cHRPeWRoQ0Rxc2JEc3VaanNwNEFnN0pXSzZyT2dJQ29xNnJPRTdLQ1ZJT3lFb08yRG5TRHRtWlRycWJUc25MenJvWndnNjdDVTY2R2NLaW9nNjdPMDY0SzQ2NHVrTGdvdkx5QWdJT3Vobk9xM3VPeWR1T3VRbkNEc2c0SHRnNXpycWJRZ1lYVjBhRzl5YVhwbDZyQ0FJT3lLdWV5ZHVDRHRtWlRycWJUc25MenJvWndnNnJDQTZyT2dJSE5sYkdWamRFRmpZMjkxYm5ROWRISjFaY0szY0hKdmJYQjBQWE5sYkdWamRGOWhZMk52ZFc1MDY2R2M2NCtFSU91cXV5RHJtcXZzbkx6cnI0RHJvWndvN0l1azdMaWhLU3dLTHk4Z0lDRHRsWndnN1lPdElPeVZpT3lYa095RW5DQmpiR0YxWkdVdVlXa3ZiRzluYjNWMFAzSmxkSFZ5YmxSdlBUeDFjbXd0Wlc1amIyUmxaQ0F2YjJGMWRHZ3ZZWFYwYUc5eWFYcGxQMUZWUlZKWktPeURnZXVNZ09xeXZldWhuQ2srNjZHY0lPeWVoK3VLbE91THBEb0tMeThnSUNEcm9aenF0N2pzbFlUc200TW83SVM0N0lXWUlPeW5nT3liZ0NrZzRvYVNJR3h2WjJsdVAzTmxiR1ZqZEVGalkyOTFiblE5ZEhKMVpTanFzNFRzb0pVZzdJU2c3WU9kS2V1aG5DRHNucERyajVrZzdMSzA3SjIwNjR1ZEtPeUxwT3k0b1RvZzY0dW83SjI4SU8yRHJTa3VJT3lLdWV5ZHVDRHRtWlRycWJRZzdaV1k2NHVvQ2k4dklDQWdXK3F6aE95Z2xTRHNvSVR0bVpoZElPdXloTzJLdk95ZHRDRHRsWmpyaXBRZzdKMjg2ck84SU9xd21leWRnQ0Rxc3JEcXM3d2c0b0NVSU91THBPdW5qQ0RzbXJEcnBxenFzSUFnNnJPbjdKNmxJT3EzdUNEdG1aVHJxYlRzbkx6cm9ad2c2N08wNjRLNDY0dWtMZ292THlBZ0lDanJ0b0RzbnBIc21xazZJT3U0ak91ZHZPeWFzT3lnZ095ZG1DQmpiR0YxWkdVdVlXa2c3SnU1SU91aG5PcTN1T3lkdU91UGhDRHRrb0RycHJ3ZzRvQ1VJT3F6aE95Z2xTRHNvSVR0bVpnZzdKMlk2NCtFN0ptQUlPdXdxZTJXcGV5ZHRDRHFzSm5zbFlRZzdJaVk3SnFwTGlrS0x5OGdiVzlrWlQwbmJtOXliV0ZzSnlqcnA0enJvNHdnN0o2czY2R2M2cmU0N0oyNEtTRGlocElnNjZHYzZyZTQ3SldFN0p1RElPeVhodXlkdENEcXQ3anJnNlVnN0pldzY0dWtLT3VNZ09xd25DRHFzSm5zbllBZzZyT0U3S0NWN0oyMDY1MjhJT3lFdU95Rm1DRHNuS0RzcDREcXNJQWc2N21nNjZhRUtTNEtablZ1WTNScGIyNGdkM0pwZEdWQ2NtOTNjMlZ5U0dGdVpHeGxjaWh0YjJSbEtTQjdDaUFnWTI5dWMzUWdiRzluYjNWMElEMGdiVzlrWlNBOVBUMGdKM04zYVhSamFDYzdDaUFnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNLSUNBZ0lHTnZibk4wSUdOdFpDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0WW5KdmQzTmxjaTBuSUNzZ2JXOWtaU0FySUNjdVkyMWtKeWs3Q2lBZ0lDQmpiMjV6ZENCd2N5QTlJR3h2WjI5MWRBb2dJQ0FnSUNBL0lDSWtkVDBrWlc1Mk9rTkNYMVZTVERzZ0pHazlKSFV1U1c1a1pYaFBaaWduYjJGMWRHZ3ZZWFYwYUc5eWFYcGxKeWs3SUdsbUtDUnBJQzFuWlNBd0tYc2dKSEpsYkQwbkx5Y3JKSFV1VTNWaWMzUnlhVzVuS0NScEtUc2dKR1Z1WXoxYlUzbHpkR1Z0TGxWeWFWMDZPa1Z6WTJGd1pVUmhkR0ZUZEhKcGJtY29KSEpsYkNrN0lGTjBZWEowTFZCeWIyTmxjM01nS0Nkb2RIUndjem92TDJOc1lYVmtaUzVoYVM5c2IyZHZkWFEvY21WMGRYSnVWRzg5Snlza1pXNWpLU0I5SUdWc2MyVWdleUJUZEdGeWRDMVFjbTlqWlhOeklDUjFJSDBpQ2lBZ0lDQWdJRG9nSjFOMFlYSjBMVkJ5YjJObGMzTWdKR1Z1ZGpwRFFsOVZVa3duT3dvZ0lDQWdabk11ZDNKcGRHVkdhV3hsVTNsdVl5aGpiV1FzSUNkQVpXTm9ieUJ2Wm1aY2NseHVjMlYwSUNKRFFsOVZVa3c5Slg0eElseHlYRzV3YjNkbGNuTm9aV3hzSUMxT2IxQnliMlpwYkdVZ0xVVjRaV04xZEdsdmJsQnZiR2xqZVNCQ2VYQmhjM01nTFVOdmJXMWhibVFnSWljZ0t5QndjeUFySUNjaVhISmNiaWNwT3dvZ0lDQWdjbVYwZFhKdUlHTnRaRHNLSUNCOUNpQWdZMjl1YzNRZ2MyZ2dQU0J3WVhSb0xtcHZhVzRvYjNNdWRHMXdaR2x5S0Nrc0lDZGpiR0YxWkdVdFluSnBaR2RsTFdKeWIzZHpaWEl0SnlBcklHMXZaR1VnS3lBbkxuTm9KeWs3Q2lBZ1kyOXVjM1FnYm05a1pVSnBiaUE5SUhCeWIyTmxjM011WlhobFkxQmhkR2c3SUM4dklPeWdoQ0JQVSt5WGtDQnViMlJsSU95ZWlPeWRqQ2pyaTZUcnBxenFzSUFnYm05a1pldWhuQ0RyajQ0cExpRHJzNER0bVpnZzdJdWs3WXlvSU95TG5DRHNtNURyczdnZ1ZWSk1JT3EzdU91TWdPdWhuQ0RzbDdEcmk2UW9abUZwYkMxemIyWjBLUzRLSUNCamIyNXpkQ0JpYjJSNUlEMGdiRzluYjNWMENpQWdJQ0EvSUNjaklTOWlhVzR2YzJoY2JpY2dLd29nSUNBZ0lDQW5WVDBrS0NJbklDc2dibTlrWlVKcGJpQXJJQ2NpSUMxbElGd25ZMjl1YzNRZ2RUMXdjbTlqWlhOekxtRnlaM1piTVYwN1kyOXVjM1FnYVQxMUxtbHVaR1Y0VDJZb0ltOWhkWFJvTDJGMWRHaHZjbWw2WlNJcE8zQnliMk5sYzNNdWMzUmtiM1YwTG5keWFYUmxLR2s4TUQ5MU9pSm9kSFJ3Y3pvdkwyTnNZWFZrWlM1aGFTOXNiMmR2ZFhRL2NtVjBkWEp1Vkc4OUlpdGxibU52WkdWVlVrbERiMjF3YjI1bGJuUW9JaThpSzNVdWMyeHBZMlVvYVNrcEtWd25JQ0lrTVNJZ01qNHZaR1YyTDI1MWJHd3BYRzRuSUNzS0lDQWdJQ0FnSjI5d1pXNGdJaVI3VlRvdEpERjlJbHh1SndvZ0lDQWdPaUFuSXlFdlltbHVMM05vWEc1dmNHVnVJQ0lrTVNKY2JpYzdDaUFnWm5NdWQzSnBkR1ZHYVd4bFUzbHVZeWh6YUN3Z1ltOWtlU2s3Q2lBZ1puTXVZMmh0YjJSVGVXNWpLSE5vTENBd2J6YzFOU2s3Q2lBZ2NtVjBkWEp1SUhOb093cDlDZ292THlEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJTzJVaE91aG5PeUV1T3lLcENBb1kyeGhkV1JsSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFTa2c0b0NVSUM5dmNHVnVMV3h2WjJsdTdKMjBJT3lEbmV5RXNjSzM2clNBNjZhc0xnb3ZMeURydUl6cm5ienNtckRzb0lEcXNJQWdiRzlqWVd4b2IzTjA2NkdjSU9xeXNPcXp2T3VsdkNEcnM3VHJnclRzcElRZzY1V002cm1NN0tlQUlPeUlxT3lXdE95RW5DRHJqSURxdUxEdGxaanJpNlRxc0lBc0lPeVpoT3Vqak91UW1PdXB0Q0RzaXFUc2lxVHJvWndnNjRHZDY0S2M2NHVrTGdwc1pYUWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVM1JoY25SbFpFRjBJRDBnTURzZ0x5OGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVnN0l1YzZyQ0JJT0tBbENEc25xenRnYlRycHEzc25iUWdKK3llck95TG5PdVBoQ2ZzbmJqc3A0QWdKK3lla091UG1leVpoT3VqakNEc2k2VHRqS2duN0oyNDdLZUFJT3Exck91MmhPMlZuT3VMcEFwbWRXNWpkR2x2YmlCcmFXeHNURzluYVc1UWNtOWpLQ2tnZXdvZ0lHbG1JQ2hzYjJkcGJsQnliMk5VYVcxbGNpa2dleUJqYkdWaGNsUnBiV1Z2ZFhRb2JHOW5hVzVRY205alZHbHRaWElwT3lCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUc1MWJHdzdJSDBLSUNCcFppQW9JV3h2WjJsdVVISnZZeWtnY21WMGRYSnVPd29nSUdOdmJuTjBJSEFnUFNCc2IyZHBibEJ5YjJNN0NpQWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tJQ0IwY25rZ2V3b2dJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNLSUNBZ0lDQWdjM0JoZDI1VGVXNWpLQ2QwWVhOcmEybHNiQ2NzSUZzbkwxQkpSQ2NzSUZOMGNtbHVaeWh3TG5CcFpDa3NJQ2N2VkNjc0lDY3ZSaWRkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnlCOUtUc0tJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0M1d2FXUXNJQ2RUU1VkVVJWSk5KeWs3SUgwZ1kyRjBZMmdnS0Y5bE1pa2dleUJ3TG10cGJHd29LVHNnZlFvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91c3RPeUxuQ0FxTHlCOUNuMEtDbVoxYm1OMGFXOXVJR3RwYkd4UWNtOWpLQ2tnZXdvZ0lHbG1JQ2h3Y205aktTQjdDaUFnSUNCMGNua2dld29nSUNBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSE5vWld4c09uUnlkV1hyb1p3ZzY1MkU3SnVNN0lTY0lIQnliMlBzbllBZ1kyMWtJT3E3amV1TnNPcTRzQ0RpZ0pRZ0wxVHJvWndnN1lxNDY2YXM3S2U0SU95anZleVhyT3lWdkNEc3A0VHNwNXdnWTJ4aGRXUmw2ckNBSU9xem9PeVZoT3VobkNEc2xZZ2c2NEtvNjRxVTY0dWtDaUFnSUNBZ0lDQWdMeThnS09xem9PeVZoQ0JqYkdGMVpHWHFzSUFnN0lTazdMbVlJTzJNak95ZHZPeWRoQ0Ryckx6cXM2QWc3SjZJN0p5ODY2bTBJTzJCdE91aG5PdVRuQ0RzbGJFZzdKZUY2NDJ3N0oyMDdZcTQ2ckNBSUNMc2dxenNtcWtnN0tTUkl1eWN2T3VobkNEcnA0bnRucGdwQ2lBZ0lDQWdJQ0FnYzNCaGQyNVRlVzVqS0NkMFlYTnJhMmxzYkNjc0lGc25MMUJKUkNjc0lGTjBjbWx1Wnlod2NtOWpMbkJwWkNrc0lDY3ZWQ2NzSUNjdlJpZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0F2THlCdFlXTlBVeS9ycHF6cmlJWHNpcVE2SUhOb1pXeHNPblJ5ZFdYcm5id2djSEp2WSt5ZHRDQnphQ0RxdTQzcmpiRHF1TERzbmJ3ZzdJaVlJT3llaU95ZGpDRGlnSlFnYzNSaGNuUlFjbTlqN0oyWUlHUmxkR0ZqYUdWazY2R2NJT3Vuak91VG9Bb2dJQ0FnSUNBZ0lDOHZJTzJVaE91aG5PeUV1T3lLcENEcXQ3anJvN2tvTFhCcFpDbnNuWVFnN1lhMTdLZTQ2NkdjSU95Z2xldW1yTzJWbk91THBDQW9kR0Z6YTJ0cGJHd2dMMVFnNjR5QTdKMlJLUW9nSUNBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0hKdll5NXdhV1FzSUNkVFNVZFVSVkpOSnlrN0lIMGdZMkYwWTJnZ0tGOWxNaWtnZXlCd2NtOWpMbXRwYkd3b0tUc2dmUW9nSUNBZ0lDQjlDaUFnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRb2dJSDBLSUNCd2NtOWpJRDBnYm5Wc2JEc0tJQ0IzWVhKdFpXUlZjQ0E5SUdaaGJITmxPd29nSUdsbUlDaDNZV2wwWlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0hkaGFYUmxjaTUwYVcxbGNpazdJSGRoYVhSbGNpNXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lpaGV1ampPdVFrT3lXdE95YWxDNG5LU2s3SUhkaGFYUmxjaUE5SUc1MWJHdzdJSDBLZlFvS1puVnVZM1JwYjI0Z2MzUmhjblJRY205aktDa2dld29nSUd0cGJHeFFjbTlqS0NrN0NpQWdiR2x1WlVKMVppQTlJQ2NuT3dvZ0lIUjFjbTV6SUQwZ01Ec0tJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPeUV1T3lGbUNEc2k1enJqNWtnN0tTUjRvQ21JQ2pycXFqcmpiZzZJQ2NnS3lCamRYSnlaVzUwVFc5a1pXd2dLeUFuS1NjcE93b2dJR052Ym5OMElIUm9hWE5RY205aklEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25MWEFuTENBbkxTMXRiMlJsYkNjc0lHTjFjbkpsYm5STmIyUmxiQ3dnSnkwdGFXNXdkWFF0Wm05eWJXRjBKeXdnSjNOMGNtVmhiUzFxYzI5dUp5d2dKeTB0YjNWMGNIVjBMV1p2Y20xaGRDY3NJQ2R6ZEhKbFlXMHRhbk52Ymljc0lDY3RMWFpsY21KdmMyVW5YU3dnZXdvZ0lDQWdjMmhsYkd3NklIUnlkV1VzSUdOM1pEb2dSVTFRVkZsZlExZEVMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWXNDaUFnSUNCa1pYUmhZMmhsWkRvZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBaFBUMGdKM2RwYmpNeUp5d2dMeThnVUU5VFNWZzZJT3lla09xNHNDRHRsSVRyb1p6c2hManNpcVFnNnJlNDY2TzVJT3lEbmV5RXNTRGlnSlFnYTJsc2JGQnliMlBzbmJRZzZyZTQ2Nk81N0tlNElPeWdsZXVtck8yVm9DRHNpSmdnN0o2STZyS01DaUFnZlNrN0NpQWdjSEp2WXlBOUlIUm9hWE5RY205ak93b2dJSEJ5YjJNdWMzUmtiM1YwTG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzS0lDQWdJR3hwYm1WQ2RXWWdLejBnWkM1MGIxTjBjbWx1WnlnbmRYUm1PQ2NwT3dvZ0lDQWdiR1YwSUdsa2VEc0tJQ0FnSUhkb2FXeGxJQ2dvYVdSNElEMGdiR2x1WlVKMVppNXBibVJsZUU5bUtDZGNiaWNwS1NBaFBUMGdMVEVwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlHeHBibVZDZFdZdWMyeHBZMlVvTUN3Z2FXUjRLUzUwY21sdEtDazdDaUFnSUNBZ0lHeHBibVZDZFdZZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0dsa2VDQXJJREVwT3dvZ0lDQWdJQ0JwWmlBb0lXeHBibVVwSUdOdmJuUnBiblZsT3dvZ0lDQWdJQ0JzWlhRZ1pYWWdQU0J1ZFd4c093b2dJQ0FnSUNCMGNua2dleUJsZGlBOUlFcFRUMDR1Y0dGeWMyVW9iR2x1WlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUdOdmJuUnBiblZsT3lCOUNpQWdJQ0FnSUdsbUlDaGxkaUFtSmlCbGRpNTBlWEJsSUQwOVBTQW5jbVZ6ZFd4MEp5QW1KaUIzWVdsMFpYSXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emRDQjNJRDBnZDJGcGRHVnlPd29nSUNBZ0lDQWdJSGRoYVhSbGNpQTlJRzUxYkd3N0NpQWdJQ0FnSUNBZ1kyeGxZWEpVYVcxbGIzVjBLSGN1ZEdsdFpYSXBPd29nSUNBZ0lDQWdJR2xtSUNobGRpNXBjMTlsY25KdmNpa2dld29nSUNBZ0lDQWdJQ0FnWTI5dWMzUWdjbUYzSUQwZ1UzUnlhVzVuS0dWMkxuSmxjM1ZzZENCOGZDQmxkaTV6ZFdKMGVYQmxJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlNREFwT3dvZ0lDQWdJQ0FnSUNBZ2FXWWdLR2x6UVhWMGFFVnljbTl5S0hKaGR5a3BJSHNLSUNBZ0lDQWdJQ0FnSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnSjJOc1lYVmtaUzFzYjJkdmRYUW5PeUF2THlBdmFHVmhiSFJvNjZHY0lPMlVqT3Vmck9xM3VPeWR1T3lYa0NEc2xZenJwcndnNG9hU0lPdXloTzJLdk95ZHRDQmI2NkdjNnJlNDdKMjRJTzJWaE95YWxGM3JvWndnNjdDVTY0Q2NDaUFnSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJT3Vuak91ampDRHFzSkRzcDRBNkp5d2djbUYzS1RzS0lDQWdJQ0FnSUNBZ0lDQWdkeTV5WldwbFkzUW9ibVYzSUVWeWNtOXlLRXhQUjBsT1gwZFZTVVJGS1NrN0NpQWdJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNBZ0lDQWdJQ0IzTG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSisyQnRPdWhuT3VUbkNEc21LVHJwWmc2SUNjZ0t5QnlZWGNwS1RzS0lDQWdJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNBZ0lDQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ0oyOXJKenNnTHk4ZzdJU3g2ck8xSUQwZzdJU2s3TG1Zd3Jmcm9aenF0N2pzbmJnZzY0dWtJT3lnbGV5RGdTRGlnSlFnN0phMDY1YWtJSEJ5YjJKc1pXM3NuYlRyazZBZzdaVzA3S0NjSUNqc25xenJvWnpxdDdqc25iZ3Y3SjZzN0lTazdMbVlJT3V6dGVxM2dDa0tJQ0FnSUNBZ0lDQWdJSGN1Y21WemIyeDJaU2hUZEhKcGJtY29aWFl1Y21WemRXeDBJSHg4SUNjbktTazdDaUFnSUNBZ0lDQWdmUW9nSUNBZ0lDQjlDaUFnSUNCOUNpQWdmU2s3Q2lBZ2NISnZZeTV6ZEdSbGNuSXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdld29nSUNBZ1kyOXVjM1FnY3lBOUlHUXVkRzlUZEhKcGJtY29KM1YwWmpnbktTNTBjbWx0S0NrN0NpQWdJQ0JwWmlBb2N5QW1KaUFoY3k1cGJtTnNkV1JsY3lnblJHVndjbVZqWVhScGIyNVhZWEp1YVc1bkp5a3BJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCamJHRjFaR1VnYzNSa1pYSnlPaWNzSUhNdWMyeHBZMlVvTUN3Z01qQXdLU2s3Q2lBZ2ZTazdDaUFnY0hKdll5NXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdMeThnN0oyMDY2KzRJT3lEaUNEc2hManNoWmpzbkx6cm9ad2c2cldRN0xLMDY1Q2NJT3VTcENEc21Kc2c3SVM0N0lXWTdKMjBJT3VMcSsyZWpDRHFzYkRycWJRZzY2eTA3SXVjSUNqcnFxanJqYmdnN0tDRTdabVlJT3lMbkNEc2c0Z2c3SVM0N0lXWTdKMkVJT3lqdmV5ZHRPeW5nQ0RzbFlycXNvd3BDaUFnSUNCcFppQW9jSEp2WXlBaFBUMGdkR2hwYzFCeWIyTXBJSEpsZEhWeWJqc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c3SVM0N0lXWUlPeWloZXVqakNBb1kyOWtaU0FuSUNzZ1kyOWtaU0FySUNjcElPS0FsQ0RyaTZUc25Zd2c3SnFVN0xLdElPdVZqQ0RyaTZUc2k1d2c3SXVjNjQrWjdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0I5S1RzS2ZRb0tablZ1WTNScGIyNGdjMlZ1WkZSMWNtNG9kR1Y0ZENrZ2V3b2dJSEpsZEhWeWJpQnVaWGNnVUhKdmJXbHpaU2dvY21WemIyeDJaU3dnY21WcVpXTjBLU0E5UGlCN0NpQWdJQ0JwWmlBb0lYQnliMk1wSUhKbGRIVnliaUJ5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2Z0Z2JUcm9aenJrNXdnN0lTNDdJV1k3SjIwSU95WGh1eVd0T3lhbEM0bktTazdDaUFnSUNCcFppQW9kMkZwZEdWeUtTQnlaWFIxY200Z2NtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdKV2U3SVNnSU95YWxPeXlyZXlkdENEc3A0VHRsb2tnN0tTUjdKMjA3SmVRN0pxVUxpY3BLVHNLSUNBZ0lHTnZibk4wSUhScGJXVnlJRDBnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGhMUWc3SXVjNnJDRUlPeTBpT3F6dkNEaWdKUWc3SVM0N0lXWTdKMkVJT3llck95TG5PeWVrZTJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJQ0FnYTJsc2JGQnliMk1vS1RzS0lDQWdJSDBzSUZSVlVrNWZWRWxOUlU5VlZGOU5VeWs3Q2lBZ0lDQjNZV2wwWlhJZ1BTQjdJSEpsYzI5c2RtVXNJSEpsYW1WamRDd2dkR2x0WlhJZ2ZUc0tJQ0FnSUhCeWIyTXVjM1JrYVc0dWQzSnBkR1VvU2xOUFRpNXpkSEpwYm1kcFpua29leUIwZVhCbE9pQW5kWE5sY2ljc0lHMWxjM05oWjJVNklIc2djbTlzWlRvZ0ozVnpaWEluTENCamIyNTBaVzUwT2lCMFpYaDBJSDBnZlNrZ0t5QW5YRzRuTENBbmRYUm1PQ2NwT3dvZ0lIMHBPd3A5Q2dvdkx5RHFzSm5zbllBZzY2eTQ2cldzNjZXOElPdXFoeURyc29qc3A3Z2c2Nnk3NjRxVTdLZUFJT3E0c095V3RTRGlnSlFnN0o2czdKcVU3TEt0N0oyMDY2bTBJQ0xzbmJUc29JVHFzN3dnNjR1azY2VzRJT3lEaUNEc29KenNsWWdpN0oyRUlPeWFsT3Exck8yVm5PdUxwQW92THlBbzdKV0lJT3EzdU91ZnJPdXB0Q0R0Z2JUcm9aenJrNXpxc0lBZzdJU3g3SXVrN1pXWTZyS01JT3F3bWV5ZGdDRHJpN1hzbllRZzY1aVFJT3VDdE95RW5DQmJRVWtnN0xhVTdMS2NJT3VObENEcnNKdnF1TEJkNnJDQUlPdXN0T3lkbU91dnVPMlZ0T3luaE91THBDa0tZMjl1YzNRZ1lYTnJaV1JEYjNWdWRDQTlJRzVsZHlCTllYQW9LVHNLQ2k4dklPeUV1T3lGbUNEc3BJRHJ1WVFvN0l1YzY0K1pLK3luZ095TG5PdXN1Q0Rzbzd6c25vVXA2Nlc4SU91enRPeWVwZTJWbkNEcmtxUWc3WldjSU8yRXRDRHNpNlR0bG9rZzRvQ1VJT3VxcU91VG9DRHRtTGpzdHB6c25ZQWdjWFZsZFdYcm9ad2c3S2VCNjZDczdabVVMZ292THlCdGIyUmxiT3lkaENEc283enJxYlFnNnJlNElPdXFxT3VOdU91aG5DQW82NHVrNjZXMDY2bTBJT3lFdU95Rm1DRHNucXpzaTV6c25wRXBMaUR0bFp3ZzY2cW82NDI0N0oyRUlPcXpoT3lHalNEc2s3RHJxYlFnN0o2czdJdWM3SjZSN0oyQUlPeTFuT3kwaUNBeDdacU02NytRTGdwbWRXNWpkR2x2YmlCeWRXNVVkWEp1S0dKMWFXeGtRWE5yTENCdGIyUmxiQ2tnZXdvZ0lHTnZibk4wSUdwdllpQTlJSEYxWlhWbExuUm9aVzRvWVhONWJtTWdLQ2tnUFQ0Z2V3b2dJQ0FnYVdZZ0tHMXZaR1ZzSUNZbUlFRk1URTlYUlVSZlRVOUVSVXhUTG1sdVpHVjRUMllvYlc5a1pXd3BJQ0U5UFNBdE1TQW1KaUJ0YjJSbGJDQWhQVDBnWTNWeWNtVnVkRTF2WkdWc0tTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RycXFqcmpiZ2c2N09BNnJLOU9pQW5JQ3NnWTNWeWNtVnVkRTF2WkdWc0lDc2dKeURpaHBJZ0p5QXJJRzF2WkdWc0tUc0tJQ0FnSUNBZ1kzVnljbVZ1ZEUxdlpHVnNJRDBnYlc5a1pXdzdDaUFnSUNBZ0lITjBZWEowVUhKdll5Z3BPeUF2THlEc2c0Z2c2NnFvNjQyNDY2R2NJT3lFdU95Rm1DRHNucXpzaTV6c25wRWdLT3VMcE95ZGpDRHNtNHpyc0kzc2w0WHNsNURzaEp3ZzdLZUE3SXVjNjZ5NElPeWVyT3lqdk95ZWhTa0tJQ0FnSUgwS0lDQWdJR2xtSUNoMGRYSnVjeUErUFNCTlFWaGZWRlZTVGxNZ2ZId2dJWEJ5YjJNcElITjBZWEowVUhKdll5Z3BPd29nSUNBZ2FXWWdLQ0YzWVhKdFpXUlZjQ2tnZXdvZ0lDQWdJQ0JqYjI1emRDQjBNQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0FnSUdGM1lXbDBJSE5sYm1SVWRYSnVLR2x1YzNSeWRXTjBhVzl1VFdWemMyRm5aU2dwS1RzS0lDQWdJQ0FnZDJGeWJXVmtWWEFnUFNCMGNuVmxPd29nSUNBZ0lDQjBkWEp1Y3lzck93b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SVM0N0lXWUlPeWtnT3U1aENEc21ZVHJvNHdnS0NjZ0t5QW9LRVJoZEdVdWJtOTNLQ2tnTFNCME1Da2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBJQ3NnSjNNcElPS0FsQ0RzbmJUdG00UWc3SnFVN0xLdDdKMkFJT3U1cU91ZHZPeWFsQzRuS1RzS0lDQWdJSDBLSUNBZ0lIUjFjbTV6S3lzN0NpQWdJQ0J5WlhSMWNtNGdjMlZ1WkZSMWNtNG9ZblZwYkdSQmMyc29LU2s3Q2lBZ2ZTazdDaUFnTHk4ZzdaV2NJT3lhbE95eXJleWR0Q0RzaTZUdGpLanRsYlRyajRRZzY0dWs3SjJNSU95YWxPeXlyZXlkdENEc25iVHNsclRzcDREcmo0VHJvWjBnN1lHUTY0cVVJTzJWcmV5RGdTRHNoTEhxczdYc25MenJvWndnN0tDVjY2YXNDaUFnY1hWbGRXVWdQU0JxYjJJdVkyRjBZMmdvS0NrZ1BUNGdlMzBwT3dvZ0lISmxkSFZ5YmlCcWIySTdDbjBLQ2k4dklPdXN1T3ExckNEc3RwVHNzcHdnN1lTMENtWjFibU4wYVc5dUlHRnphME5zWVhWa1pTaDBaWGgwTENCdGIyUmxiQ2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lHTnZibk4wSUdGMGRHVnRjSFFnUFNBb1lYTnJaV1JEYjNWdWRDNW5aWFFvZEdWNGRDa2dmSHdnTUNrZ0t5QXhPd29nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvZEdWNGRDd2dZWFIwWlcxd2RDazdDaUFnSUNCcFppQW9ZWE5yWldSRGIzVnVkQzV6YVhwbElENGdNakF3S1NCaGMydGxaRU52ZFc1MExtTnNaV0Z5S0NrN0lDOHZJT3VzdE8yVm5PMmVpQ0RzakpQc25iVHNwNEFnN0pXSzZyS01DaUFnSUNCeVpYUjFjbTRnWVhSMFpXMXdkQ0ErSURFS0lDQWdJQ0FnUHlBbjZyQ1o3SjJBSU91c3VPcTFyT3VsdkNEcmk2VHNpNXdnN0pxVTdMS3Q3WldjNjR1a0xpRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3lnaE95WGtDRHNvSnpzbFlqdGxvanJqWmdnNnJLRDY1T2s2ck84SU9xeXVleTVtT3luZ0NEc2xZcnJpcFFzSU9xMXJPeWhzT3VDbUNEc2xyVHRuSmpxc0lBZzdabVY3SXVrN1o2SUlPdUxwT3VsdUNEc2c0anJvWnpzbXJRZzY0eUE3SldJSURQcXNKenJwYndnNnJlYzdMbVo2NHlBNjZHY0lFcFRUMDRnNjdDdzdKZTA2NkdjNjZlTU9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29kR1Y0ZENrS0lDQWdJQ0FnT2lBbjY0dWs3SjJNSUZWSklPdXN1T3Exck95ZG1DRHJqSURzbFlnZ00rcXduT3VsdkNEcXQ1enN1Wm5yaklEcm9ad2dTbE5QVGlEcnNMRHNsN1Ryb1p6cnA0dzZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtUc0tJQ0I5TENCdGIyUmxiQ2s3Q24wS0NpOHZJT3V5aU95WHJTRHRoTFFnNG9DVUlPcXdtZXlkZ0NEc2hManNoWmpzbllRZzdKT3c2NUNZTENEc25iVHJzb2dnN1lTMDY2ZU1JT3kybE95eW5DRHRtSlhzaTUwb1NsTlBUaURyc0xEc2w3UXBJT3VNZ095TG9DRHJzb2pzbDYwZzdaaVY3SXVkS0VwVFQwNGc2ckNkN0xLMEtleWRoQ0RzbXBUcXRhenRsWnpyaTZRS1puVnVZM1JwYjI0Z1lYTnJWSEpoYm5Oc1lYUmxLSFJsZUhRc0lHMXZaR1ZzS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnS0FvZ0lDQWdKK3lkdE91eWlDRHNtcFRzc3Ezc25ZQWc2N0tJN0pldElPeWVrZXlYaGV5ZHRPdUxwQ0FvNjZ5NDZyV3NJT3VMcE91VHJPcTRzQ0RzbFlUcmk1Z2c0b0NVSU91TWdPeVZpQ0F6NnJDY0lPcTNuT3k1bWV5ZGdDRHNuYlRyc29nZzdZUzA3SmVRSU95Z2dleWFxZTJWbU95bmdDRHNsWXJyaXBUcmk2UXBMaUFuSUNzS0lDQWdJQ2ZyaTZUc25Zd2dWVWtnNjZ5NDZyV3M2ckNBSU8yVm5PcTFyZXlXdE91cHRDRHNucERzbDdEc2lxVHJuNnpzbXJRZzdKaUI3SmEwNjZHY0xDRHNtSUhzbHJUcnFiUWc3SjZRN0pldzdJcWs2NStzN0pxMElPMlZuT3ExcmV5V3RPdWhuQ0Ryc29qc2w2M3RsWmpybmJ3dUlDY2dLd29nSUNBZ0oxVkpJT3VzdU9xMXJPdUxwT3lhdENEcXNJVHFzckR0bFp3ZzdaR2M3WmlFN0oyRUlPeVRzT3F6b0N3ZzdKMjA2NmFFd3Jmc2lLdnNucERDdCt1bmlPeUtwTzJDdWNLMzdaU002NkNJN0oyMDdJcWs3Wm1BNjQyVTY0cVVJT3EzdU91TWdPdWhuQ0RyczdUc29iVHRsWnpyaTZRdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95ZG1DRHNwSVFnN0lpWTY2VzhJT3EzdU91TWdPdWhuQ0RzbktEc3A0RHRsWnpyaTZRZzRvQ1VJT3lia091c3VPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPdXlpT3lYcmV1UGhDRHRsWndnN0tTRTY2R2NMQ0RzcElUcnNKVHF2NGpzbllRZzdKNkU3SjJZNjZHY0lPeTJsT3F3Z08yVm1PeW5nQ0RzbFlycmlwVHJpNlF1SUNjZ0t3b2dJQ0FnSit1THRleWRnQ0Ryc0pqcms1enNpNXdnU2xOUFRpRHFzSjNzc3JRZzdaV1k2NEtZNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9VZzZyaUk3S2VBT2lBbklDc0tJQ0FnSUNkN0luUnlZVzV6YkdGMFpXUWlPaUFpNjdLSTdKZXQ2Nnk0SUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSmthWEpsWTNScGIyNGlPaUFpYTIvaWhwSmxiaURybUpEcmlwUWdaVzdpaHBKcmJ5SjlPaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvZEdWNGRDa0tJQ0FwTENCdGIyUmxiQ2s3Q24wS0NpOHZJT3VNZ08yWmxPMllsU0RyckxqcXRhd2c3S0NjN0o2UklPMkV0Q0RpZ0pRZzdJS3M3SnFwN0o2UTZyQ0FJT3lEZ2UyWnFleWRoQ0RzaEtUcnFvWHRsWmpycWJRZzY2ZWw2NTI5N0plUUlPdW5udXVLbENEcnJManF0YXpycGJ3ZzY2ZU02NU9rN0phMDdLU0E2NHVrTGdvdkx5QnRaWE56WVdkbGN6b2dXM3R5YjJ4bE9pZDFjMlZ5SjN3bllYTnphWE4wWVc1MEp5d2dkR1Y0ZEgxZElPeWdoT3l5dENEcmpJRHRtWlRycGJ3ZzY2ZWs2N0tJSU91d20rdUtsT3VMcENqcmk2VHJwcXpyaXBRZzY2eTA3SU9CN1lPY0lPS0FsQW92THlEc200enJzSTNzbDRVZzdLZUE3SXVjNjZ5NDdKMllJQ0xzbXBUc3NxM3JrNlRzbllBZzdJU2M2NkdjSU91c3RPcTBnQ0lnN0tDRTdLQ2M2Nlc4SU95bmdPMkNwT3E0c0NEc25JVHRsYlFnNjR5QTdabVVJT3VucGV1ZHZleWRoQ0R0aExRZzdKV0k3SmVRSU91cXZldVZoU0RzaTZQcmlwVHJpNlFwTGdwbWRXNWpkR2x2YmlCaGMydERiMjF3YjNObEtHMWxjM05oWjJWekxDQnRiMlJsYkNrZ2V3b2dJSEpsZEhWeWJpQnlkVzVVZFhKdUtDZ3BJRDArSUhzS0lDQWdJR052Ym5OMElIUnlZVzV6WTNKcGNIUWdQU0FvYldWemMyRm5aWE1nZkh3Z1cxMHBMbTFoY0Nnb2JTa2dQVDRLSUNBZ0lDQWdLRzB1Y205c1pTQTlQVDBnSjJGemMybHpkR0Z1ZENjZ1B5QW43SmEwN0l1YzdJcWs3WVMwN1lxNE9pQW5JRG9nSit5Q3JPeWFxZXlla0RvZ0p5a2dLeUJUZEhKcGJtY29iUzUwWlhoMElIeDhJQ2NuS1M1emJHbGpaU2d3TENBeE5UQXdLUW9nSUNBZ0tTNXFiMmx1S0NkY2JpY3BPd29nSUNBZ2NtVjBkWEp1SUNnS0lDQWdJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnSXV1TWdPMlpsTzJZbFNEcnJManF0YXdnN0tDYzdKNlJJdXlkdE91THBDQW82cml3N0tHMElPdXN1T3ExckNEcmk2VHJrNnpxdUxBZzdKV0U2NHVZSU9LQWxDRHNsWVRybnBnZzY0eUE3Wm1VNnJDQUlPeWR0T3V5aUNEdGhMVHNuWmdnN0tDRTdMSzBJT3VucGV1ZHZleWR0T3VMcENrdUlDY2dLd29nSUNBZ0lDQW43SUtzN0pxcDdKNlE2ckNBSU8yWmxPdXB0Q0RzZzRIdG1hbkN0K3VucGV1ZHZleWRoQ0RzaEtUcnFvWHRsWmpycWJRc0lPeUtwTzJEZ095ZHZDRHF0NXpzdVpucXM3d2c3SmlJN0l1Y0lPMkdwT3lYa0NEcnA1N3JpcFFnVlVrZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2NmVsNjUyOTdKMjBJT3VzdU9xMXJPdWx2Q0RzazdEcXVMRHNsNUFnNjdhQTdLR3g3WldZNjZtMEtPeVd0T3VLa0NEdG1aVHJxYlRzbmJqc3A0QXNJT3VzdE95S3FDRHNnNEh0bWFuc25ianNwNEFnNjVPeEtTRHF2SzBnN1pXRTdKcVU3WldjSU9xeWd5QXg2ckNBN0tlQTY2ZU1JT3lucCtxeWpDRHJrSmpyckx6c2xyVHJuYnd1SU95ZHRPdVZqQ0J6ZFdkblpYTjBhVzl1Yyt1S2xDRHJ1WWdnNjdDdzdKZTBMbHh1SnlBckNpQWdJQ0FnSUNjdElPdXN1T3Exck91bHZDRHNvSnpzbFlqdGxhQWc2NVdRSU95RW5PdWhuQ0Rzb0pIcXQ3enNuYlFnNjR1azY2VzRJREorTStxd25DNGc2ckNCSU95Z25PeVZpT3lYbENEc21ad2c2cmU0NjZDSDZyS01JT3lOdk91S2xPeW5nQ0RzbmJUc25LRHJwYndnNjdhWjdKMjQ2NHVrTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lDck95YXFleWVrT3F3Z0NEc2xyanF1SW50bFpqc3A0QWc3SldLN0oyQUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN1pxZjdJaVlJT3VUc1NucnBid2c3S2VBN0phMDY0SzBJT3VFbyt5bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN1p1RTdJYU5JT3lhbE95eXJTZ2k2NDJVSU95bnArcXlqQ0lzSUNMcnNvVHRpcnpzbXFuc25MenJvWndpSU91VHNTbnNuYlRycWJRZzdLZUI3S0NFSU95Z25PeVZpT3lkaENEcXQ3Z2c2N0NwN1phbDdKeTg2NkdjSU9xem9PeXprQ0RyaTZUc2k1d2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZJT3E0aU95bmdEb2dKeUFyQ2lBZ0lDQWdJQ2Q3SW5KbGNHeDVJam9nSXV1TWdPMlpsQ0RzblpIcmk3VWc3WldjNjVHUUlPdXN1T3llcFNBbzdaVzA3SnFVN0xLMEtTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0p5WldGemIyNGlPaUFpN0oyMDdKeWdJTzJWbkNEcnJManNucVVpZlYxOVhHNWNiaWNnS3dvZ0lDQWdJQ0FuVyt1TWdPMlpsRjFjYmljZ0t5QjBjbUZ1YzJOeWFYQjBDaUFnSUNBcE93b2dJSDBzSUcxdlpHVnNLVHNLZlFvS0x5OGc2NHlBN1ptVTdaaVZJT3lnbk95ZWtTRHNuWkhyaTdYc2w1RHNoSndnZTNKbGNHeDVMQ0J6ZFdkblpYTjBhVzl1YzF0ZGZTRHN0cFRzdHB3Z0tPeTlsT3VUbk8yT25PeUtwTUszN0pXZTY1S2tJT3llb2V1THRDRHRsNGpzbXFrcENtWjFibU4wYVc5dUlIQmhjbk5sUTI5dGNHOXpaU2h5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYSHRiWEhOY1UxMHFYSDB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93b2dJQ0FnWTI5dWMzUWdjbVZ3YkhrZ1BTQlRkSEpwYm1jb0tHOGdKaVlnYnk1eVpYQnNlU2tnZkh3Z0p5Y3BMblJ5YVcwb0tUc0tJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ1FYSnlZWGt1YVhOQmNuSmhlU2h2SUNZbUlHOHVjM1ZuWjJWemRHbHZibk1wQ2lBZ0lDQWdJRDhnYnk1emRXZG5aWE4wYVc5dWN3b2dJQ0FnSUNBZ0lDQWdMbTFoY0Nnb2VDa2dQVDRnS0hzZ2RHVjRkRG9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VkR1Y0ZENrZ2ZId2dKeWNwTG5SeWFXMG9LU3dnY21WaGMyOXVPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNXlaV0Z6YjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcENpQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaDRLU0E5UGlCNExuUmxlSFFwQ2lBZ0lDQWdJRG9nVzEwN0NpQWdJQ0JwWmlBb2NtVndiSGtnZkh3Z2MzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0tTQnlaWFIxY200Z2V5QnlaWEJzZVN3Z2MzVm5aMlZ6ZEdsdmJuTWdmVHNLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc2xZVHJucGpyb1p3Z0tpOGdmUW9nSUhKbGRIVnliaUJ1ZFd4c093cDlDZ292THlEcnNvanNsNjBnN0oyUjY0dTE3SmVRN0lTY0lIdDBjbUZ1YzJ4aGRHVmtMQ0JrYVhKbFkzUnBiMjU5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlVjbUZ1YzJ4aGRHVW9jbUYzS1NCN0NpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3Q2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwWTJnb0wxeDdXMXh6WEZOZEtseDlMeWs3Q2lBZ2FXWWdLRzBwSUhNZ1BTQnRXekJkT3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdklEMGdTbE5QVGk1d1lYSnpaU2h6S1RzS0lDQWdJR052Ym5OMElIUnlZVzV6YkdGMFpXUWdQU0JUZEhKcGJtY29LRzhnSmlZZ2J5NTBjbUZ1YzJ4aGRHVmtLU0I4ZkNBbkp5a3VkSEpwYlNncE93b2dJQ0FnYVdZZ0tIUnlZVzV6YkdGMFpXUXBJSEpsZEhWeWJpQjdJSFJ5WVc1emJHRjBaV1FzSUdScGNtVmpkR2x2YmpvZ1UzUnlhVzVuS0NodklDWW1JRzh1WkdseVpXTjBhVzl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDA3Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzdKV0U2NTZZNjZHY0lDb3ZJSDBLSUNCeVpYUjFjbTRnYm5Wc2JEc0tmUW9LTHk4ZzdKMlI2NHUxN0plUTdJU2NJSHQwWlhoMExDQnlaV0Z6YjI1OUlPdXdzT3lYdENEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxVM1ZuWjJWemRHbHZibk1vY21GM0tTQjdDaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXhiVzF4elhGTmRLbHhkTHlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQmhjbklnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ2FXWWdLRUZ5Y21GNUxtbHpRWEp5WVhrb1lYSnlLU2tnZXdvZ0lDQWdJQ0J5WlhSMWNtNGdZWEp5Q2lBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIc2dkR1Y0ZERvZ1UzUnlhVzVuS0NoNElDWW1JSGd1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lCVGRISnBibWNvS0hnZ0ppWWdlQzV5WldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZTa3BDaUFnSUNBZ0lDQWdMbVpwYkhSbGNpZ29lQ2tnUFQ0Z2VDNTBaWGgwS1RzS0lDQWdJSDBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc2xZVHJucGpyb1p3Z0tpOGdmUW9nSUhKbGRIVnliaUJiWFRzS2ZRb0tMeThnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsQ0RzZzRIdGc1enNuYndnNjVXTUlDOW9aV0ZzZEdnZzdLR3c3WnFNNnJDQUlPeVlwT3VwdENEcmtxVHNsNURzaEp3ZzdKdU02N0NON0plRjdKMkVJT3VMcE95TG5DRHNpNXpyajRUdGxiVHJzN2pyaTZRZ0tETXc3TFNJN0plUUlESHJzb2pycDR3cExnb3ZMeURzaExIcXM3WHRsWmpycWJRZzZyS3c2ck84SU8yVnVPdVRwT3Vmck9xd2dDQmpiR0YxWkdWVGRHRjBkWE05SjI5ckordWhuQ0Rya0pqcmo0enJwcXpycjREcm9ad3NJT3llck91aG5PcTN1T3lkdUNEdG00UWc2N0tFN1lxODdKMjBJT3lnZ095Z2lPdWhuQ0R3bjUraTdKeTg2NkdjSU91enRlcTNnTzJWbk91THBDNEtMeThnS08yVWpPdWZyT3EzdU95ZHVPeWR0Q0Ryb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3lYc0NEcmtxUWc3S084NnJpdzdLQ0I3Snk4NjZHY0lDOW9aV0ZzZEdqcnBid2c3S0d3N1pxTTdaV1k2NHFVSU9xeWcrcXp2Q0RzcDUzc25ZUWc3SjIwNjZPczY0dWtLUXBzWlhRZ2JHRnpkRUYxZEdoU1pYUnllVUYwSUQwZ01Ec0tablZ1WTNScGIyNGdjbVYwY25sQmRYUm9TV1pPWldWa1pXUW9LU0I3Q2lBZ2FXWWdLR05zWVhWa1pWTjBZWFIxY3lBaFBUMGdKMk5zWVhWa1pTMXNiMmR2ZFhRbktTQnlaWFIxY200N0NpQWdhV1lnS0hkaGFYUmxjaUI4ZkNCRVlYUmxMbTV2ZHlncElDMGdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEd2dNekF3TURBcElISmxkSFZ5YmpzZ0x5OGc3S2VFN1phSklPeWtrU0R0aExRZzY3Q3A3WlcwSU9xNGlPeW5nQ0FySURNdzdMU0lJT3F3aE9xeXFRb2dJR3hoYzNSQmRYUm9VbVYwY25sQmRDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0RzbnF6dG1aWHNuYmdnN0l1YzY0K0U0b0NtSnlrN0NpQWdjblZ1VkhWeWJpZ29LU0E5UGlBbjY2R2M2cmU0N0oyNElPMlpsZXlkdU95YXFleWR0T3VMcEM0Z0lrOUxJdXVkdk9xem9PdW5qQ0RyaTdYdGxaanJuYnd1SnlrdWRHaGxiaWdLSUNBZ0lDZ3BJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25iZ2c3Wm1WN0oyNDY1Q29JT0tBbENEc29KWHNnNEVnN0lPQjdZT2M2NkdjSU91enRlcTNnQzRuS1N3S0lDQWdJQ2hsS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0pXRTdLZUJJT3Vobk9xM3VPeWR1Q0RzbFlnZzY1Q29PaWNzSUZOMGNtbHVaeWhsTG0xbGMzTmhaMlVwTG5Oc2FXTmxLREFzSURnd0tTa0tJQ0FwT3dwOUNnb3ZMeURzaTZUdGpLZ2c3SjJSNjR1MTdKMkVJT3lDck91ZWpPeWFxU0RzbFlqcmdyVHJvWndnNjdPQTdabVlJT0tBbENEc201RHNuYmdvNjZHYzZyZTQ3SjI0TCt5RXBPeTVtQ25zbmJRZzdZeU03SldGNjVDY0lPcXl2ZXlhc095WGxDRHF0N2dnN0pXSTY0SzA2Nlc4TENEc2xZVHJpNGpycWJRZzdLQ1I2NUdRN0phMEsreWJrT3VzdU95ZGhDRHJzN1RyZ3Jqcmk2UUtablZ1WTNScGIyNGdabkpwWlc1a2JIbEZjbkp2Y2lobExDQndjbVZtYVhncElIc0tJQ0JwWmlBb1pTQW1KaUJsTG0xbGMzTmhaMlVnUFQwOUlFeFBSMGxPWDBkVlNVUkZLU0J5WlhSMWNtNGdleUJsY25KdmNqb2dURTlIU1U1ZlIxVkpSRVVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0Ykc5bmIzVjBKeUI5T3dvZ0lHbG1JQ2hqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y3BJSHNLSUNBZ0lISmxkSFZ5YmlCN0lHVnljbTl5T2lBbjdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmxLR05zWVhWa1pTbnFzSUFnN0lTazdMbVk2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFFnNG9DVUlPeUVwT3k1bU8yVm1PcXpvQ0Ryb1p6cXQ3anNuYmp0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMaWNzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNnZlRzS0lDQjlDaUFnY21WMGRYSnVJSHNnWlhKeWIzSTZJSEJ5WldacGVDQXJJQ2hsSUNZbUlHVXViV1Z6YzJGblpTQS9JR1V1YldWemMyRm5aU0E2SUZOMGNtbHVaeWhsS1NrZ2ZUc0tmUW9LWm5WdVkzUnBiMjRnY21WaFpFSnZaSGtvY21WeEtTQjdDaUFnY21WMGRYSnVJRzVsZHlCUWNtOXRhWE5sS0NoeVpYTnZiSFpsS1NBOVBpQjdDaUFnSUNCc1pYUWdZbTlrZVNBOUlDY25Pd29nSUNBZ2NtVnhMbTl1S0Nka1lYUmhKeXdnS0dNcElEMCtJSHNnWW05a2VTQXJQU0JqT3lCOUtUc0tJQ0FnSUhKbGNTNXZiaWduWlc1a0p5d2dLQ2tnUFQ0Z2V3b2dJQ0FnSUNCMGNua2dleUJ5WlhOdmJIWmxLRXBUVDA0dWNHRnljMlVvWW05a2VTa3BPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QnlaWE52YkhabEtIdDlLVHNnZlFvZ0lDQWdmU2s3Q2lBZ2ZTazdDbjBLQ21OdmJuTjBJRU5QVWxOZlNFVkJSRVZTVXlBOUlIc0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MU5aWFJvYjJSekp6b2dKMGRGVkN3Z1VFOVRWQ3dnVDFCVVNVOU9VeWNzQ2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVWhsWVdSbGNuTW5PaUFuUTI5dWRHVnVkQzFVZVhCbEp5d0tmVHNLWm5WdVkzUnBiMjRnYW5OdmJpaHlaWE1zSUhOMFlYUjFjeXdnYjJKcUtTQjdDaUFnY21WekxuZHlhWFJsU0dWaFpDaHpkR0YwZFhNc0lFOWlhbVZqZEM1aGMzTnBaMjRvZXlBblEyOXVkR1Z1ZEMxVWVYQmxKem9nSjJGd2NHeHBZMkYwYVc5dUwycHpiMjQ3SUdOb1lYSnpaWFE5ZFhSbUxUZ25JSDBzSUVOUFVsTmZTRVZCUkVWU1V5a3BPd29nSUhKbGN5NWxibVFvU2xOUFRpNXpkSEpwYm1kcFpua29iMkpxS1NrN0NuMEtDbU52Ym5OMElITmxjblpsY2lBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtHRnplVzVqSUNoeVpYRXNJSEpsY3lrZ1BUNGdld29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjBkRlZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OW9aV0ZzZEdnbktTQjdDaUFnSUNCeVpYUnllVUYxZEdoSlprNWxaV1JsWkNncE95QXZMeURyb1p6cXQ3anNuYmdnN1pXRTdKcVVJT3lEZ2UyRG5PdXB0Q0RzbnF6dG1aWHNuYmdnN0l1YzY0K0VJT0tBbENEc25xenJvWnpxdDdqc25ianNuYlFnNjRHZDY0S3M3Snk4NjZtMElPdUxwT3lkakNEc29iRHRtb3pydG9EdGhMQWdjSEp2WW14bGJleWR0Q0R0a29EcnByRHJpNlFLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3Q2lBZ0lDQWdJRzlyT2lCMGNuVmxMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5MQ0IyT2lCQ1VrbEVSMFZmVml3Z1pHbHlPaUJmWDJScGNtNWhiV1VzSUM4dklIYkN0MlJwY2pvZzZyV3M2N0tFN0tDRUwreVhpZXVhc2UyVm5DRHNncXpyczdqc25iUWc2NWFnSU95ZWlPdUtsT3luZ0NEc3A0VHJpNmpzbXFrS0lDQWdJQ0FnYlc5a1pXdzZJR04xY25KbGJuUk5iMlJsYkN3Z2JXOWtaV3h6T2lCQlRFeFBWMFZFWDAxUFJFVk1VeXdnWlhoaGJYQnNaWE02SUVWWVFVMVFURVZUTG14bGJtZDBhQ3dnWjNWcFpHVTZJRWRWU1VSRkxteGxibWQwYUN3Z2NtVmhaSGs2SUhkaGNtMWxaRlZ3TEFvZ0lDQWdJQ0J3Y205aWJHVnRPaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuYjJzbklIeDhJR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdiblZzYkNrZ1B5QnVkV3hzSURvZ1kyeGhkV1JsVTNSaGRIVnpMQW9nSUNBZ0lDQmhZMk52ZFc1ME9pQmpiR0YxWkdWQlkyTnZkVzUwS0Nrc0NpQWdJQ0FnSUhObGNuWmxaRG9nYzNSaGRITXVjMlZ5ZG1Wa0xDQnNZWE4wUVhRNklITjBZWFJ6TG14aGMzUkJkQ3dnYkdGemRGUmxlSFE2SUhOMFlYUnpMbXhoYzNSVVpYaDBMQ0JzWVhOMFUyVmpPaUJ6ZEdGMGN5NXNZWE4wVTJWakxBb2dJQ0FnZlNrN0NpQWdmUW9nSUM4dklPMlVqT3Vmck9xM3VPeWR1Q0RzaTZ6c25xWHJzSlhyajVrZzRvQ1VJT3VCaXVxNHNPdXB0Q0RzbklRZzZyQ1E3SXVjSU8yRGdPeWR0T3VvdU9xd2dDRHJpNlRycHF6cnBid2c2NEdJNjR1a0NpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyaGxZWEowWW1WaGRDY3BJSHNLSUNBZ0lHeGhjM1JDWldGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJSDBLSUNBdkx5RHJvWnpxdDdqc25iZ2c0b0NVSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGM0N0MXZ3bjVTUlhTRHJzb1R0aXJ6c25iUWc3Wmk0N0xhYzdaV2M2NHVrTGdvZ0lDOHZJT3E0c091enVDanJ1SXpybmJ6c21yRHNvSUFnN0tlQjdaYUpLVG9nWUdOc1lYVmtaU0JoZFhSb0lHeHZaMmx1SUMwdFkyeGhkV1JsWVdsZzY2VzhJT3lJcU95ZGdDRHRsSVRyb1p6c2hManNpcVRyb1p3ZzdJdWs3WmFKSU9LQWxDRHJxWlRyaWJRZzdKZUc3SjIwSU9xenAreWVwU0RydUl6cm5ienNtckRzb0lEcnBid2c3SmUwNnJPZ0xBb2dJQzh2SUNBZ2JHOWpZV3hvYjNOMElPeUltT3lMb0NEdGo2enRpcmpyb1p3ZzZyS3c2ck84NjZXOElPeWVrT3VQbVNEc2lKanJvTG50bFp6cmk2UW83SXVrN0xpaE9pRHRsNlRyazV6cnBxenNpcVRzbDVEc2hKenJqNFFnNjdpTTY1Mjg3SnF3N0tDQUlPeVh0T3VtdkNBcklFeEpVMVJGVGlEdG1aWHNuYmdzSURJd01qWXRNRGNwTGdvZ0lDOHZJQ0FnN1lTdzY2KzQ2NFNRN0oyMElPMlpsT3VwdE95WGtDRHNvSVR0bUlBZzdKV0lJT3Vjck91THBDNGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdU91bmpDRHRsWmpycWJRZzY0R2RMZ29nSUM4dklPMlB0T3V3c1NqdGhMRHJyN2pyaEpBcE9pRHNucERyajVrZzdKbUU2Nk9NNnJDQUlPdW5pZTJlakNEdG1aanFzcjBvNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJR3h2WTJGc2FHOXpkT3lYa0NEcnFyc2c2NHUvN0pXRUlPeTlsT3VUbk9xd2dDRHJzN1RzbmJUcmlwUWc2cks5N0pxd0tleVhrT3lFbkFvZ0lDOHZJQ0FnNjZHYzZyZTQ3SjI0SU91TWdPcTRzQ0RzcEpFZzY3S0U3WXE4N0oyRUlPdVlrQ0RyaUlUcnBiVHJxYlFzSU95OWxPdVRuT3VsdkNEcnRwbnNsNnpyaEtQc25ZUWc3SWlZSU95ZWlPdUtsQ0R0aExEcnI3anJoSkFnNjdDcDdJdWQ3Snk4NjZHY0lPeWdoTzJabU8yVm5PdUxwQzRLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YjNCbGJpMXNiMmRwYmljcElIc0tJQ0FnSUdOdmJuTjBJR0p2WkhrZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ1kyOXVjM1FnYzNkcGRHTm9UVzlrWlNBOUlDRWhLR0p2WkhrZ0ppWWdZbTlrZVM1emQybDBZMmhCWTJOdmRXNTBLVHNnTHk4ZzZyT0U3S0NWSU95Z2hPMlptQ0E5SU95TG5PMkJyT3VtdnlEc3NMM3NuTHpyb1p3ZzdKZTA3SmEwSU9xemhPeWdsZXlkaENEcXM2RHJwYndnN0lpWUlPeWVpT3F5akFvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnTHk4Z1kyeGhkV1JsNnJDQUlPeVhodXljdk91cHRDRHNsNnpxdUxEc2hKd2c2NEdLNjRxVTY0dWtMaUJ6YUdWc2JEcDBjblZsNjUyOElHTnNZWFZrWmVxd2dDRHNsNGJzbHJUcmo0UWc3SVc0N0oyQUlPeWdsZXlEZ1NEc2k2VHRsb25yajd3S0lDQWdJQ0FnTHk4Z2MzQmhkMjdzblpnZ0oyVnljbTl5Sitxd2dDRHNsWWdnNjV5bzZyT2dMQ0RzbUlqc29JVHNsNVFnNnJlNDY0eUE2NkdjSUc5ck9uUnlkV1hycGJ3ZzY0K002NkNrN0tTczY0dWtJT0tBbEFvZ0lDQWdJQ0F2THlEdGxJenJuNnpxdDdqc25ianNuWUFnSXV1NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUc2w0anNsclRzbXBRaTY1Mjg2ck9nSU8yVm1PdUtsT3VOc0NEc2k2VHNvSnpyb1p6cmlwUWc3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHJuS2pyaXBRZzdJT0I3WU9jNnJDQUlPdVFrT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLSUNBZ0lDQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjJOc1lYVmtaUzF0YVhOemFXNW5KeWtnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeExDQjdDaUFnSUNBZ0lDQWdJQ0JsY25KdmNqb2dKK3lkdENCUVEreVhrQ0JEYkdGMVpHVWdRMjlrWmVxd2dDRHNsNGJzbHJUc21wUWc0b0NVSU8yRXNPdXZ1T3VFa095WGtPeUVuQ0JqYkdGMVpHVWdMUzEyWlhKemFXOXVJT3lkdENEcmtKanJpcFRzcDRBZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNG5MQW9nSUNBZ0lDQWdJQ0FnY0hKdllteGxiVG9nSjJOc1lYVmtaUzF0YVhOemFXNW5KeXdLSUNBZ0lDQWdJQ0I5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0F2THlEc3A0VHRsb2tnN0tTUjdKMjQ2NDJ3SU91WWtDRHJpSXpyb0lEcmk2UWc0b0NVSU9xNGlPdXdxU2cyTU95MGlDRHJnclFwSU91THBPeUxuQ0RyaUlUcnBiZ2c2ckcwSUNMc3NMM3NuWVFnNjR1cjdKV1k2NHVrTCt1cXV5RHJ0S1RyaTZRaTdKZVFJT3F3Z09xNWpPeWFzT3V2Z091aG5DRHJ1SXpybmJ6c21yRHNvSURyb1p3ZzdKNnM3SXVjNjQrRTdaV2M2NHVrTGdvZ0lDQWdJQ0F2THlEdGxaenNzTGdnNjVLazdKZVE2NCtFSU91WWtDRHJpSVRycGJUcmlwUWc2ckcwSU91NGpPdWR2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1FnN0wyYzY3Q3g3SmVRSU91cXV5RHJpNy9zbFlRZzdKNlE2NCtaSU95WmhPdWpqT3F3Z0NEc2xZZ2c2NUNZNjRxVUlPMlptT3F5dmV5ZHZDRHNpSmdnN0o2STdKeTg2NHVJQ2lBZ0lDQWdJQzh2SU9xM3VPdVZqT3VuakNEc3ZaVHJrNXpycGJ3ZzY3YVo3SmVzNjRTajdKMkVJT3lJbUNEc25vanJpcFFnN1lTdzY2KzQ2NFNRSU91d3FleUxuZXljdk91aG5DRHRqN1Ryc0xIdGxaenJpNlFnS091UmtDRHJzb2pzcDdnZzdZRzA2NmF0N0plUUlPMkVzT3V2dU91RWtPeWR0Q0R0aW9Ec2xyVHJncGpzbUtUcnFiUWc2NHU1N1ptcDdJcWs2NSs5NjR1a0tTNEtJQ0FnSUNBZ1kyOXVjM1FnYzNSaGJHVWdQU0JzYjJkcGJsQnliMk1nSmlZZ0tFUmhkR1V1Ym05M0tDa2dMU0JzYjJkcGJsTjBZWEowWldSQmRDQStJRFl3TURBd0tUc0tJQ0FnSUNBZ2FXWWdLR3h2WjJsdVVISnZZeUFtSmlCemRHRnNaU2tnZXdvZ0lDQWdJQ0FnSUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNLSUNBZ0lDQWdJQ0JwWmlBb0lXOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa3BJSHNLSUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeExDQjdJR1Z5Y205eU9pQW43SjIwSUU5VDdKZVE3SVNnSU95ZWtPdVBtZXljdk91aG5DRHJxcnNnN0plMDdKYTA3SnFVSU9LQWxDRHRoTERycjdqcmhKRHNsNURzaEp3Z1kyeGhkV1JsSU95THBPMldpU0R0bTRRZ0wyeHZaMmx1SU8yVnRDRHNvN3pzaExqc21wUXVKeUI5S1RzS0lDQWdJQ0FnSUNCOUNpQWdJQ0FnSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPd29nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdZKzA2N0N4SU9LQWxDRHRoTERycjdqcmhKQWc2N0NwN0l1ZDdKeTg2NkdjSU95Z2hPMlptQzRuS1RzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnYlc5a1pUb2dKM1JsY20xcGJtRnNKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JyYVd4c1RHOW5hVzVRY205aktDazdJQzh2SU95Vm51eUVvQ0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNDdKMjBJT3VNZ09xNHNDRHNwSkhzbmJUcnFiUWc3S0NSNnJPZ0lPeURpT3VobkNEc2w3RHJpNlFnS095d3ZleWRoQ0RyaTZ2c2xaanFzYkRyZ3BnZzY0dWs3SXVjSU91SWhPdWx1Q0Rxc3Izc21yQXBDaUFnSUNBZ0lHeHZaMmx1VTNSaGNuUmxaRUYwSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUNBZ0x5OGdRbEpQVjFORlV1dWx2Q0RzbXJEcnBxd2c3Wlc0NjVPazY1K3M2NkdjSU95bmdPeWdsU0RpZ0pRZ1EweEo2ckNBSU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzcDRIc29KRWc3SmUwN0tlQUlPeVZpdXF6b0NCVlVrenJwNHdnNjRTWTZyS283S1NBNjR1a0xnb2dJQ0FnSUNBdkx5RHRsYmpyazZUcm42enFzSUFnN0l1azdZeW83WldZNnJHdzY0S1lJRU5NU2Vxd2dDQkNVazlYVTBWUzY2VzhJT3VzdE95TG5PMlZ0T3VQaENCRFRFbnFzSUFnN0pXTTdKV0U3SVNjSU9xNHNPdXp1Q0RydUl6cm5ienNtckRzb0lEcnBid2c3SmUwNjYrQTY2R2NJT3Vobk9xM3VPeWR1T3lkZ0NEcmtKenJpNlFvWm1GcGJDMXpiMlowS1M0S0lDQWdJQ0FnWTI5dWMzUWdiRzluYVc1RmJuWWdQU0JQWW1wbFkzUXVZWE56YVdkdUtIdDlMQ0JEVEVGVlJFVmZSVTVXTENCN0lFSlNUMWRUUlZJNklIZHlhWFJsUW5KdmQzTmxja2hoYm1Sc1pYSW9jM2RwZEdOb1RXOWtaU0EvSUNkemQybDBZMmduSURvZ0oyNXZjbTFoYkNjcElIMHBPd29nSUNBZ0lDQmpiMjV6ZENCMGFHbHpURzluYVc0Z1BTQnpjR0YzYmlnblkyeGhkV1JsSnl3Z1d5ZGhkWFJvSnl3Z0oyeHZaMmx1Snl3Z0p5MHRZMnhoZFdSbFlXa25YU3dnZXdvZ0lDQWdJQ0FnSUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUd4dloybHVSVzUyTENCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsTEFvZ0lDQWdJQ0FnSUdSbGRHRmphR1ZrT2lCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUNFOVBTQW5kMmx1TXpJbkxDQXZMeUJyYVd4c1RHOW5hVzVRY205ajdKMllJT3EzdU91anVTQnJhV3hzN0pxcElDaHJhV3hzVUhKdlkrcXp2Q0RyajVuc25id2c3WXlvN1lTMEtRb2dJQ0FnSUNCOUtUc0tJQ0FnSUNBZ2JHOW5hVzVRY205aklEMGdkR2hwYzB4dloybHVPd29nSUNBZ0lDQjBhR2x6VEc5bmFXNHViMjRvSjJWeWNtOXlKeXdnS0NrZ1BUNGdleUJwWmlBb2JHOW5hVzVRY205aklEMDlQU0IwYUdselRHOW5hVzRwSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3SUgwcE93b2dJQ0FnSUNCMGFHbHpURzluYVc0dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lDQWdJQ0JwWmlBb2JHOW5hVzVRY205aklDRTlQU0IwYUdselRHOW5hVzRwSUhKbGRIVnlianNLSUNBZ0lDQWdJQ0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPd29nSUNBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJOVWFXMWxjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9iRzluYVc1UWNtOWpWR2x0WlhJcE95QnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlHNTFiR3c3SUgwS0lDQWdJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QXZMeURzZzRnZzZyT0U3S0NWN0oyOElPeUltQ0Rzbm9qc25MenJpNGdnNjR1azdKMk1JQzlvWldGc2RHZ2c2NVdNSU91THBPeUxuQ0RzbmIzcXVMQUtJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNvSWpzc0tnZzdLS0Y2Nk9NSUNoamIyUmxJQ2NnS3lCamIyUmxJQ3NnSnlrbktUc0tJQ0FnSUNBZ0lDQXZMeURzZ3F6cm5venNuYlFnNjZHYzZyZTQ3SjI0N1pXZ0lPeUxuT3F3aE91UGhDRHNsNGJzbmJRZzZyT242N0NVNjZHY0lPeUxwTzJNcU91aG5DRHJnWjNyZ3F6cmk2UWdQU0JqYkdGMVpHWHFzSUFnN0plRzZyR3c2NEtZSU95THBPMldpZXlkdENEc2xZZ2c2NUNjSU9xeWd5NEtJQ0FnSUNBZ0lDQXZMeURzblpIcmk3WHNuWUFnN0oyMDY2KzRJT3V6dE91RGlPeWN2T3VMaUNEc2c0SHRnNXpycGJ3ZzY0dWs3SXVjSU95ZXJPeUVuQ0F2YUdWaGJIUm82NkdjSU95VmpPdW1zT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSU91TWdPcTRzQ0R0bVpUcnFiVHNuWVFnN0l1azdZeW82NkdjSU91d2xPcSt2T3VMcENrdUNpQWdJQ0FnSUNBZ2FXWWdLR052WkdVZ0lUMDlJREFnSmlZZ1JHRjBaUzV1YjNjb0tTQXRJR3h2WjJsdVUzUmhjblJsWkVGMElEd2dOVEF3TUNrZ2V3b2dJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdU95ZHRDRHNwb25zaTV3ZzdJdWs3WXlvNjZHY0lPdUJuZXVDcUNEaWdKUWdRMnhoZFdSbElFTnZaR1VnN0lTazdMbVlJT3lEZ2UyRG5PdWx2Q0RyaTZUc2k1d2c3S0NRNnJLQTdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ0lDQWdJQ0FnWTJobFkydERiR0YxWkdWQmRtRnBiR0ZpYkdVb0tUc0tJQ0FnSUNBZ0lDQjlDaUFnSUNBZ0lIMHBPd29nSUNBZ0lDQnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V5QmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SURFdzY3YUVJT3F5dmVxenZDRGlnSlFnNjR5QTZyaXdJTzJVaE91aG5PeUV1T3lLcENEc29KWHJwcXd1SnlrN0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ2ZTd2dOakF3TURBd0tUc0tJQ0FnSUNBZ0x5OGc2NEtoN0oyQUlPeWVoZXllcGVxMmpPeWRoQ0Ryckx6cXM2QWc3SjZJNjRxVUlPdU1nT3E0c0NEc2hManNoWmpzbllBZzY3S0U2NmF3NjR1a0lPS0FsQ0RzbnF6cm9aenF0N2pzbmJnZzdadUVJT3VMcE95ZGpDRHNtcFRzc3Ezc25iUWc3SU9JSU95RXVPeUZtQ2pzZzRnZzdKNkY3SjZsNnJhTUtleWN2T3VobkNEc2k1enNucEh0bFpqcXNvd0tJQ0FnSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJnZzdJdWM3SjZSSnlBcklDaHpkMmwwWTJoTmIyUmxJRDhnSnlBbzZyT0U3S0NWSU95Z2hPMlptQ0RpZ0pRZzdJdWM3WUdzNjZhL0lPeXd2U2tuSURvZ0p5Y3BJQ3NnSnlEaWdKUWc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeWVrT3VQbVNEc2w3RHFzckRya0tucmk0anJpNlF1SnlrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQnpkMmwwWTJoTmIyUmxJRDhnSjJKeWIzZHpaWEl0YzNkcGRHTm9KeUE2SUNkaWNtOTNjMlZ5SnlCOUtUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1EQXNJSHNnWlhKeWIzSTZJQ2Zyb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3VxdXlEc2w3VHNsNGpzbHJUc21wUTZJQ2NnS3lCbExtMWxjM05oWjJVZ2ZTazdDaUFnSUNCOUNpQWdmUW9nSUM4dklDanRoTERycjdqcmhKQWc3WSswNjdDeElPcTFyTzJZaE91MmdDRGlnSlFnNjdpTTY1Mjg3SnF3N0tDQUlPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzdKV0lJT3VRbU91S2xDRHRtWmpxc3IwZzdLQ0U3SnFwS1FvZ0lHWjFibU4wYVc5dUlHOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa2dld29nSUNBZ2V3b2dJQ0FnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdJQ0FnSUM4dklITjBZWEowNnJDQUlPeURpQ0Rzdlpqc2hwUWc3TEM5N0oyRUlPdW5qT3VUb091THBDQW82NHVrNjZhczdKMllJT3lJcU95ZGdDRHN2WmpzaHBUcXM3d2c2NnkwNnJTQTdaV1k2cktNSU95Q3JPeWFxZXlla095WGtPcXlqQ0RyczdUc25vUXBMZ29nSUNBZ0lDQWdJQzh2SU95ZHRPeVd0T3lFbkNCUWIzZGxjbE5vWld4c0tDNXdjekVwN0oyMElEWHN0SWdnNjVLa0lPcTN1Q0Rzc0wzc2w1QWc3SmVVN1lTdzY2VzhJT3V6dE91Q3RDQXg2N0tJS09xMXJPdVBoU0RxczRUc29KVXA3SjJFSU95ZWtPdVBtU0RzaEtEdGc1M3RsWmpxczZBc0NpQWdJQ0FnSUNBZ0x5OGc3TEM5N0oyRUlPeTFuT3lHak8yWmxPMlZ0Q0RzZ3F6c21xbnNucEFnNjRpSTdKZVVJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqcnA0d2c2NEtvNnJLTUlPMlZuT3VMcEM0ZzdMQzk3SjJFSU91cXV5RHNzTDdzbkx6cnFiUWc3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHRsWnpyaTZRS0lDQWdJQ0FnSUNBdkx5QW82NHVrNjZXNElPeXd2U0RzbUtUc25vWHJvS1VnNjdDcDdLZUFJT0tBbENEcXQ3Z2c2cks5N0pxd0lPdXBsT3VKdE9xd2dDRHJzN1RzbmJUcmlwUWc3TEdFNjZHY0lPdUNxT3F6b0NEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFxQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdLTzg3SjJZT2lCamJHRjFaR1hxc0lBZzdMMlk3SWFVSU95Z25PdXFxZXlkaENEcnNKVHF2cmpycWJRZ1FYQndRV04wYVhaaGRHVXZSbWx1WkZkcGJtUnZkK3F3Z0NEcnFyc2c3TEMrN0oyRUlPeUltQ0Rzbm9qc25Zd2c0b0NVSU95Y2lPdVBoT3lhc0NEc2k2VHF1TERzbDVEc2hKd2c3Wm1WN0oyNElPMlZoT3lhbEM0S0lDQWdJQ0FnSUNCamIyNXpkQ0J3Y3pFZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV3h2WjJsdUxuQnpNU2NwT3dvZ0lDQWdJQ0FnSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vY0hNeExDQmJDaUFnSUNBZ0lDQWdJQ0FuVTNSaGNuUXRVMnhsWlhBZ0xWTmxZMjl1WkhNZ05TY3NDaUFnSUNBZ0lDQWdJQ0FuSkhkeklEMGdUbVYzTFU5aWFtVmpkQ0F0UTI5dFQySnFaV04wSUZkVFkzSnBjSFF1VTJobGJHd25MQW9nSUNBZ0lDQWdJQ0FnSW1sbUlDZ2tkM011UVhCd1FXTjBhWFpoZEdVb0oyTnNZWFZrWlMxc2IyZHBiaWNwS1NCN0lpd0tJQ0FnSUNBZ0lDQWdJQ0lnSUNSM2N5NVRaVzVrUzJWNWN5Z25maWNwSWl3S0lDQWdJQ0FnSUNBZ0lDY2dJRk4wWVhKMExWTnNaV1Z3SUMxVFpXTnZibVJ6SURJbkxBb2dJQ0FnSUNBZ0lDQWdJaUFnUVdSa0xWUjVjR1VnTFU1aGJXVnpjR0ZqWlNCVklDMU9ZVzFsSUZjZ0xVMWxiV0psY2tSbFptbHVhWFJwYjI0Z0oxdEViR3hKYlhCdmNuUW9YQ0oxYzJWeU16SXVaR3hzWENJcFhTQndkV0pzYVdNZ2MzUmhkR2xqSUdWNGRHVnliaUJUZVhOMFpXMHVTVzUwVUhSeUlFWnBibVJYYVc1a2IzY29jM1J5YVc1bklHTXNJSE4wY21sdVp5QjBLVHNnVzBSc2JFbHRjRzl5ZENoY0luVnpaWEl6TWk1a2JHeGNJaWxkSUhCMVlteHBZeUJ6ZEdGMGFXTWdaWGgwWlhKdUlHSnZiMndnVTJodmQxZHBibVJ2ZHloVGVYTjBaVzB1U1c1MFVIUnlJR2dzSUdsdWRDQnVLVHNuSWl3S0lDQWdJQ0FnSUNBZ0lDSWdJQ1JvSUQwZ1cxVXVWMTA2T2tacGJtUlhhVzVrYjNjb1cwNTFiR3hUZEhKcGJtZGRPanBXWVd4MVpTd2dKMk5zWVhWa1pTMXNiMmRwYmljcElpd0tJQ0FnSUNBZ0lDQWdJQ2NnSUdsbUlDZ2thQ0F0Ym1VZ1cxTjVjM1JsYlM1SmJuUlFkSEpkT2pwYVpYSnZLU0I3SUZ0MmIybGtYVnRWTGxkZE9qcFRhRzkzVjJsdVpHOTNLQ1JvTENBMktTQjlKeXdnTHk4Z05pQTlJRk5YWDAxSlRrbE5TVnBGQ2lBZ0lDQWdJQ0FnSUNBbmZTY3NDaUFnSUNBZ0lDQWdYUzVxYjJsdUtDZGNjbHh1SnlrZ0t5QW5YSEpjYmljcE93b2dJQ0FnSUNBZ0lHTnZibk4wSUdKaGRDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ykc5bmFXNHVZbUYwSnlrN0NpQWdJQ0FnSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloaVlYUXNJQ2RBWldOb2J5QnZabVpjY2x4dUp5QXJDaUFnSUNBZ0lDQWdJQ0FuYzNSaGNuUWdJbU5zWVhWa1pTMXNiMmRwYmlJZ1kyMWtJQzlySUdOc1lYVmtaU0F2Ykc5bmFXNWNjbHh1SnlBckNpQWdJQ0FnSUNBZ0lDQW5jRzkzWlhKemFHVnNiQ0F0VG05UWNtOW1hV3hsSUMxRmVHVmpkWFJwYjI1UWIyeHBZM2tnUW5sd1lYTnpJQzFHYVd4bElDSW5JQ3NnY0hNeElDc2dKeUpjY2x4dUp5azdDaUFnSUNBZ0lDQWdjM0JoZDI0b0oyTnRaQ2NzSUZzbkwyTW5MQ0JpWVhSZExDQjdJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2djM1JrYVc4NklDZHBaMjV2Y21VbkxDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNLSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBblpHRnlkMmx1SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSEIwZVNobGVIQmxZM1FwNjZHY0lPdXp0T3VDdUNEdGdxVHNsNUFnN1lHMDY2R2M2NU9jSUZSVlNlcXdnQ0RyckxUcnNKanNuWkhzbmJnZzZyS0Q3SjIwSU95THBPeTRvU0R0bVpYc25ianJrS2dvTWpBeU5pMHdOeXdnN0oyODY3Q1lJRnh5d3JkcmFYUjBlU0RzdlpUcms1d2c2NnFvNjVHUUtTRGlnSlFLSUNBZ0lDQWdJQ0F2THlEc25LRHNuYnp0bFp3ZzdKNlE2NCtaN1ptVUlPcXl2ZXVobk91S2xDQlRlWE4wWlcwZ1JYWmxiblJ6N0oyWUlPeW5oT3lubkNEdGdxUWc3SjZGNjZDbExpRHNvSkhxdDd6c2hMRWc2cmFNN1pXYzdKMjBJT3llaU95Y3ZPdXB0Q0EyN0xTSUlPdVNwQ0RzbDVUdGhMRHFzSUFnN0o2UTY0K1pJT3llaGV1Z3BldVB2QW9nSUNBZ0lDQWdJQzh2SURIcnNvZ282cldzNjQrRklPcXpoT3lnbFNuc25iUWc3SVNnN1lPZDY1Q1k2ck9nTENEcXRvenRsWnpzbmJRZzdKZUc3Snk4NjZtMElHdGxlWE4wY205clpTRHNwSVRycDR3ZzdLR3c3SnFwN1o2SUlPeUxwTzJNcU8yVnRDRHNncXpzbXFuc25wRHFzSUFnN0plVTdZU3dJTzJWbkNEcnNvZ2c2NGlFNjZXMDY2bTBJT3VRbk91THBDaG1ZV2xzTFhOdlpuUXBMZ29nSUNBZ0lDQWdJQzh2SU95WGxPMkVzQ0RzcDRIc29JVHNsNUFnVkdWeWJXbHVZV3pzbllRZzY0dWs3SXVjSU95Vm51eWN2T3VobkNEcXNJRHNvTGpzbVlBZzY0dWs2Nlc0SU95VnNleVhrQ0R0Z3FUcXNJQWc2NU9rN0phMDZyQ0E2NHFVSU9xeWcreWRoQ0RycDRucmlwVHJpNlF1Q2lBZ0lDQWdJQ0FnYzNCaGQyNG9KMjl6WVhOamNtbHdkQ2NzSUZzS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdaRzhnYzJOeWFYQjBJQ0pqYkdGMVpHVWdMMnh2WjJsdUlpY3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlWR1Z5YldsdVlXd2lJSFJ2SUdGamRHbDJZWFJsSnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0EySnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdZV04wYVhaaGRHVW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlEQXVNeWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVTNsemRHVnRJRVYyWlc1MGN5SWdkRzhnYTJWNWMzUnliMnRsSUhKbGRIVnliaWNzQ2lBZ0lDQWdJQ0FnSUNBdkx5RHNsNVR0aExEcXNJQWc3SXVrN0tDYzY2R2NJT3VUcE95V3RPcXdoQ0Rxc3Izc21yRHNsNURycDR3ZzdKZXM2cml3SU91UGhPdUxyQ2pxdG96dGxad2c3SmVHN0p5ODY2bTBJT3ljaE95WGtPeUVuQ0RzcEpIcmk2Z3BJT0tBbENEdGhMRHJyN2pyaEpEc25ZUWc3TG1ZN0p1TUlPdTRqT3Vkdk95YXNPeWdnT3VuakNEcmdxanF1TFRyaTZRS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0F4TGpVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJ6WlhRZ2JXbHVhV0YwZFhKcGVtVmtJRzltSUdaeWIyNTBJSGRwYm1SdmR5QjBieUIwY25WbEp5d0tJQ0FnSUNBZ0lDQmRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdabUZzYzJVN0lDOHZJT3luZ095YmtDRHNsWWdnN1pXWTY0cVVJRTlUQ2lBZ0lDQWdJSDBLSUNBZ0lDQWdjbVYwZFhKdUlIUnlkV1U3Q2lBZ0lDQjlDaUFnZlFvZ0lDOHZJTzJCdE91aG5PdVRuQ0RxczRUc29KVWc2NkdjNnJlNDdKV0U3SnVESU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnN1ptSTdKMllJRnZyb1p6cXQ3anNsWVRzbTROZElPdXloTzJLdk95ZHRDRHRtTGpzdHB3dUlHTnNZWFZrWlNCaGRYUm9JR3h2WjI5MWRPeWN2T3VobkNCRFRFa2c2NkdjNnJlNDdKMjQ3SjJFSU8yVnRPeWduTzJWbk91THBDNEtJQ0F2THlBbzdKMjBJRkJEN0oyWUlPeWdnT3llcGV1UW5DRHNucERxc3Fuc3BwM3Jxb1hzbllRZzdLZUE3SnEwNjR1a0lPS0FsQ0RyaTZUc2k1d2c3Sk93NjZDazY2bTBJT3llck91aG5PcTN1T3lkdUNEdGxZVHNtcFF1S1NEcm9aenF0N2pzbFlUc200TWc3WnVFN0plVUlPeUV1T3lGbU1LMzZyT0U3S0NWN0xxUTdJdWM2Nlc4SU95Z2xldW1yTzJWbk91THBDNEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZZMnhoZFdSbExXeHZaMjkxZENjcElIc0tJQ0FnSUdOdmJuTjBJR3h2SUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbllYVjBhQ2NzSUNkc2IyZHZkWFFuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdMQ0IzYVc1a2IzZHpTR2xrWlRvZ2RISjFaU0I5S1RzS0lDQWdJR3hsZENCbGNuSWdQU0FuSnpzS0lDQWdJR3h2TG5OMFpHVnljaTV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3SUdWeWNpQXJQU0JrTG5SdlUzUnlhVzVuS0NrN0lIMHBPd29nSUNBZ2JHOHViMjRvSjJWeWNtOXlKeXdnS0dVcElEMCtJSHNnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUdWeWNtOXlPaUFuNjZHYzZyZTQ3SldFN0p1RElPeUxwTzJXaVNEc2k2VHRqS2c2SUNjZ0t5QmxMbTFsYzNOaFoyVWdmU2s3SUgwcE93b2dJQ0FnYkc4dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lDQWdhMmxzYkZCeWIyTW9LVHNnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQzh2SU91aG5PcTN1T3lWaE95YmcrdVFuQ0RxczRUc29KWHNuWVFnNjZ5ODY0MllJT3VNZ09xNHNDRHNoTGpzaFpqc25ZUWc2N0tFNjZhdzY0dWtDaUFnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQ0FnSUNBZ0lDQXZMeURyaTZUc25Zd2dMMkZqWTI5MWJuVEN0eTlvWldGc2RHanNsNURzaEp3ZzZyT0U3S0NWN0oyRUlPeURpT3VobkNnOTdKZUc3SjJNN0p5ODY2R2NLU0RzbmIzcXNvd0tJQ0FnSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDOHZJT3lEZ2UyRG5DRHNucXp0akpEc29KVW82NHVrN0oyTUlPMkV0T3lYa095RW5DRHJyN2pyb1p6cXQ3anNuYmdnNnJDUTdLZUFLUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lWaE95Ymd5QW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BKeWs3Q2lBZ0lDQWdJR2xtSUNoeVpYTXVhR1ZoWkdWeWMxTmxiblFwSUhKbGRIVnlianNnTHk4Z1pYSnliM0lnN1pXNDY1T2s2NStzNnJDQUlPeWR0T3V2dUNEc25aSHJpN1h0bG9qc25MenJxYlFnN0tTUjY3TzFJT3V3cWV5bmdBb2dJQ0FnSUNCcFppQW9ZMjlrWlNBOVBUMGdNQ2tnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU0I5S1RzS0lDQWdJQ0FnWld4elpTQnFjMjl1S0hKbGN5d2dOVEF3TENCN0lHOXJPaUJtWVd4elpTd2daWEp5YjNJNklDaGxjbkl1ZEhKcGJTZ3BMbk5zYVdObEtEQXNJREUxTUNrcElIeDhJQ2duN0tLRjY2T01JT3k5bE91VG5DQW5JQ3NnWTI5a1pTa2dmU2s3Q2lBZ0lDQjlLVHNLSUNBZ0lISmxkSFZ5YmpzS0lDQjlDaUFnTHk4ZzdKNlE2cml3SU95aWhldWpqQ0RpZ0pRZzdaU002NStzNnJlNDdKMjRJRk5VVDFCZlFsSkpSRWRGTCsyVm1PMkt1T3U1aE8yS3VPcXdnQ0R0bUxqc3RwenRsWnpyaTZRZ0tPdWhuT3k3ck95WGtPeUVuT3VuakNEc29KSHF0N3dnNnJDQTY0cWw3WldZNjR1SUlPeVZpT3lnaENrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmMyaDFkR1J2ZDI0bktTQjdDaUFnSUNCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWloZXVqakNEc21wVHNzcTBnNjdDYjdKMk1JT0tBbENEcmk2VHJwcXpycGJ3ZzY0R1Y2NHVJNjR1a0xpY3BPd29nSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBMQ0F5TURBcE93b2dJQ0FnY21WMGRYSnVPd29nSUgwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0p5a2dld29nSUNBZ1kyOXVjM1FnZXlCMFpYaDBMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmc3RwVHNzcHpyc0p2c25ZUWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95MmxPeXluQ0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNzSUcxdlpHVnNJRDhnSnlqcnFxanJqYmc2SUNjZ0t5QnRiMlJsYkNBcklDY3BKeUE2SUNjbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhKaGR5QTlJR0YzWVdsMElHRnphME5zWVhWa1pTaFRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BMQ0J0YjJSbGJDazdDaUFnSUNBZ0lHTnZibk4wSUhOMVoyZGxjM1JwYjI1eklEMGdjR0Z5YzJWVGRXZG5aWE4wYVc5dWN5aHlZWGNwT3dvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBb0tFUmhkR1V1Ym05M0tDa2dMU0J6ZEdGeWRHVmtLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2s3Q2lBZ0lDQWdJR2xtSUNnaGMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0tTQjdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTWpPeUxzU0RzaTZUdGpLZ2dLQ2NnS3lCelpXTWdLeUFuY3lrNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTWpBd0tTazdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKV0lJQ2NnS3lCemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3Q2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCemRXZG5aWE4wYVc5dWN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFZzRvQ1VJT3lEZ2UyWnFleWRoQ0RzaEtUcnFvWHRsWmpycWJRZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RPeWtnT3VMcENBbzdMYVU3TEtjNnJPOElPcXdtZXlkZ0NEc2hManNoWmdzSU91TWdPMlpsT3VLbENEcnA2UWc3SnFVN0xLdDdKZVFJTzJHdGV5bnVPdWhuQ0RzaTZUcnByd3BDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMk52YlhCdmMyVW5LU0I3Q2lBZ0lDQmpiMjV6ZENCN0lHMWxjM05oWjJWekxDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHTnZibk4wSUd4cGMzUWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHMWxjM05oWjJWektTQS9JRzFsYzNOaFoyVnpMbVpwYkhSbGNpZ29iU2tnUFQ0Z2JTQW1KaUJUZEhKcGJtY29iUzUwWlhoMElIeDhJQ2NuS1M1MGNtbHRLQ2twSURvZ1cxMDdDaUFnSUNCcFppQW9JV3hwYzNRdWJHVnVaM1JvS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKK3VNZ08yWmxDRHJnclRzbXFuc25iUWc2N21FN0phMElPeWVpT3lLdGV1TGlPdUxwQzRuSUgwcE93b2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6ZENCc1lYTjBWWE5sY2lBOUlGc3VMaTVzYVhOMFhTNXlaWFpsY25ObEtDa3VabWx1WkNnb2JTa2dQVDRnYlM1eWIyeGxJQ0U5UFNBbllYTnphWE4wWVc1MEp5azdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPdU1nTzJabENEc21wVHNzcTA2Snl3Z1UzUnlhVzVuS0Noc1lYTjBWWE5sY2lBbUppQnNZWE4wVlhObGNpNTBaWGgwS1NCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTlRBcExuSmxjR3hoWTJVb0wxeHVMMmNzSUNjZ0p5a2dLeUFuNG9DbUlDanJqSUR0bVpRZ0p5QXJJR3hwYzNRdWJHVnVaM1JvSUNzZ0orcXduQ2tuS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSEpoZHlBOUlHRjNZV2wwSUdGemEwTnZiWEJ2YzJVb2JHbHpkQzV6YkdsalpTZ3RNVElwTENCdGIyUmxiQ2s3SUM4dklPdU1nTzJabE9xd2dDRHF1TGpzbHJUc3A0RHJxYlFnN0xXYzZyZThJREV5NnJDYzY2ZU1JQ2p0bElUcm9henRsSVR0aXJnZzdZK3Q3S084SU91d3FleW5nQ2tLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY0dGeWMyVkRiMjF3YjNObEtISmhkeWs3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGdmRYUXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU8yTWpPeUxzU0RzaTZUdGpLZ2dLQ2NnS3lCelpXTWdLeUFuY3lrNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTWpBd0tTazdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJT3lka2V1THRTQW9KeUFySUhObFl5QXJJQ2R6TENEc29KenNsWWdnSnlBcklHOTFkQzV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dnS3lBbjZyQ2NLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnVTNSeWFXNW5LQ2hzWVhOMFZYTmxjaUFtSmlCc1lYTjBWWE5sY2k1MFpYaDBLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNekFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnlaWEJzZVRvZ2IzVjBMbkpsY0d4NUxDQnpkV2RuWlhOMGFXOXVjem9nYjNWMExuTjFaMmRsYzNScGIyNXpMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc2N0tJN0pldElPS0FsQ0R0bFp6cXRhM3NsclFnNG9hVUlPeVlnZXlXdENEc25wRHJqNWtnS095MmxPeXluT3F6dkNEcXNKbnNuWUFnN0lTNDdJV1lJT3lDck95YXFTa0tJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZkSEpoYm5Oc1lYUmxKeWtnZXdvZ0lDQWdZMjl1YzNRZ2V5QjBaWGgwTENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdsbUlDZ2hkR1Y0ZENCOGZDQWhVM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnJzb2pzbDYzdGxhQWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTI5dWMzUWdjbUYzSUQwZ1lYZGhhWFFnWVhOclZISmhibk5zWVhSbEtGTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3NJRzF2WkdWc0tUc0tJQ0FnSUNBZ1kyOXVjM1FnYjNWMElEMGdjR0Z5YzJWVWNtRnVjMnhoZEdVb2NtRjNLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVc5MWRDa2dld29nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnNvanNsNjBnN1l5TTdJdXhJT3lMcE8yTXFDQW9KeUFySUhObFl5QXJJQ2R6S1RvbkxDQlRkSEpwYm1jb2NtRjNLUzV6YkdsalpTZ3dMQ0F5TURBcEtUc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEcnNvanNsNjBnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N0tJN0pldElPeVpoT3VqakNBb0p5QXJJSE5sWXlBcklDZHpMQ0FuSUNzZ0tHOTFkQzVrYVhKbFkzUnBiMjRnZkh3Z0p6OG5LU0FySUNjcEp5azdDaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQlRkSEpwYm1jb2RHVjRkQ2t1YzJ4cFkyVW9NQ3dnTXpBcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUIwY21GdWMyeGhkR1ZrT2lCdmRYUXVkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1T2lCdmRYUXVaR2x5WldOMGFXOXVMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJT3V5aU95WHJTRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EUXNJSHNnWlhKeWIzSTZJQ2RPYjNRZ1ptOTFibVFuSUgwcE93cDlLVHNLQ2k4dklPeWR0T3V2dUNEcmk2VHJwcXpxc0lBZzY1YWdJT3llaU91S2xPdU5zQ0RybUpBZzdMeWM2cml3NnJDQUlPdVRwT3lXdE95WXBPdXB0Q2pzb0p6c2lxVHNzcGdnN0o2UTY0K1pJT3k4bk9xNHNDRHNwSkhyczdVZzY1T3hLU0Rzb2JEc21xbnRub2dnN0tLRjY2T01JT0tBbENEcmo0enJqWmdnNjR1azY2YXM2NHFVSU9xM3VPdU1nT3VobkNEc25LRHNwNEFLYzJWeWRtVnlMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUI3Q2lBZ2FXWWdLR1VnSmlZZ1pTNWpiMlJsSUQwOVBTQW5SVUZFUkZKSlRsVlRSU2NwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc25iVHJyN2dnN0x5YzdLQzRJT3llaU95V3RPeWFsQ2p0ajZ6dGlyZ2dKeUFySUZCUFVsUWdLeUFuSU95Q3JPeWFxU0RzcEpFcElPS0FsQ0RzbmJRZzdKMjQ3SXFrN1lTMDdJcWs2NHFVSU95aWhldWpqTzJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJSEJ5YjJObGMzTXVaWGhwZENnd0tUc0tJQ0I5Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFbk91eWhDRHNtS1RycFpnNkp5d2daU0FtSmlCbExtMWxjM05oWjJVcE93b2dJSEJ5YjJObGMzTXVaWGhwZENneEtUc0tmU2s3Q2k4dklPeVd0T3VXcENEcXNyM3JvWnpyb1p3ZzdLTzk2NU9nS095THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBc0lFTjBjbXdyUXl3Z0wzTm9kWFJrYjNkdUxDRHNtS1RycFpncElHTnNZWFZrWlNEc25wRHNpNTNzbllRZzY0S282cml3N0tlQUlPeVZpdXVLbE91THBBcHdjbTlqWlhOekxtOXVLQ2RsZUdsMEp5d2dLQ2tnUFQ0Z2V5QnJhV3hzVUhKdll5Z3BPeUJyYVd4c1RHOW5hVzVRY205aktDazdJSDBwT3dwd2NtOWpaWE56TG05dUtDZFRTVWRKVGxRbkxDQW9LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2twT3dwd2NtOWpaWE56TG05dUtDZFRTVWRVUlZKTkp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwS1RzS0NuTmxjblpsY2k1c2FYTjBaVzRvVUU5U1ZDd2dKekV5Tnk0d0xqQXVNU2NzSUNncElEMCtJSHNLSUNCamIyNXpiMnhsTG14dlp5Z240cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBSnlrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSnlEdGdiVHJvWnpyazV3ZzY0dWs2NmFzSU95OG5PeW5rQ0RpZ0pRZ2FIUjBjRG92TDJ4dlkyRnNhRzl6ZERvbklDc2dVRTlTVkNrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSnlEcnFxanJqYmc2SUNjZ0t5QkRURUZWUkVWZlRVOUVSVXdnS3lBbklNSzNJT3lZaU95TG5DQW5JQ3NnUlZoQlRWQk1SVk11YkdWdVozUm9JQ3NnSitxeHRDRHNucVhzc0trbktUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPeWR0Q0Rzc0wzc25ZUWc3THljNjVHVUlPdVBtZXlWaUNEdGxMenF0N2pycDRnZzdaU002NStzNnJlNDdKMjQ3SjIwSU8yQnRPdWhuT3VUbk91aG5DRHN0cFRzc3B6dGxhbnJpNGpyaTZRdUp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0orS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTm9aV05yUTJ4aGRXUmxRWFpoYVd4aFlteGxLQ2s3SUM4dklFTnNZWFZrWlNCRGIyUmxJT3lDck95YXFTRHFzSURyaXFVZzdKZXM2N2FBSU95Z2tPcXlnQ0FvN1pTTTY1K3M2cmU0N0oyNElPeVZpT3VDdE95YXFTa0tJQ0F2THlEcnI3anJwcXdnN0l1YzY0K1pJQ3NnN0tlQTdJdWM2Nnk0SU95anZPeWVoU0RpZ0pRZzdMS3JJT3kybE95eW5PdTJnTzJFc0NEcnVhRHJwYlRxc293S0lDQmhjMnREYkdGMVpHVW9KK3liak91d2pleVhoVG9nSXV5Z2dPeWVwU0Rya0pqc2w0anNpclhyaTRqcmk2UWlKeWt1ZEdobGJpZ0tJQ0FnSUNncElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc200enJzSTNzbDRVZzdKbUU2Nk9NSU9LQWxDRHN0cFRzc3B3ZzdLU0E2N21FSU91Qm5TNG5LU3dLSUNBZ0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SnVNNjdDTjdKZUZJT3lMcE8yTXFDQW83TEtySU95YWxPeXlyU0RybFl3ZzdKNnM3SXVjNjQrRUtUb25MQ0JsTG0xbGMzTmhaMlVwQ2lBZ0tUc0tmU2s3Q2c9PScKQjY0X1dBVENIRVI9J0x5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tLTHk4ZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU95Wm5DRHRsWVRzbXBUdGxaenFzSUE2SU8yVXZPcTN1T3VuaU9xd2dDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1kyeGhkV1JsWW5KcFpHZGxPaTh2SU95WHRPcTRzQ2gzYVc1a2IzY3ViM0JsYmk5cFpuSmhiV1V2YjNCbGJrVjRkR1Z5Ym1Gc0tldWx2QW92THlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293S0x5OGdVRTlUVkNBdmQyRnJaU0RycGJ3ZzY3TzA2NEswNjZtMElPcXdrT3lMbk95ZWtPcXdnQ0RyaTZUcnBxd29ZMnhoZFdSbExXSnlhV1JuWlM1cWN5bnJwYndnNjR5QTdJdWdJT3k4b091THBDNEtMeThLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQW92THlEcnFaVHJxcWpycHF3Z2ZqRTFUVUxybmJ3ZzY2R2M2cmU0N0oyNElPeUxuQ0RzbnBEcmo1a2c3SXVjN0o2UjdKeTg2NkdjSU95RGdleUxuQ0Rzdkp6cmthenJqNFFnNjdhQTY0dTBJT3lYaHV1THBDQW82NU94NjZHZE9pQnVjRzBnY25WdUlHSjFhV3hrS1M0S0x5OGc2NHVrNjZhczY0cVVJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1TERycWJRZzdLTzk3S2VBNjZlTUtPMlVqT3Vmck9xM3VPeWR1T3F6dkNEc2c1M3NncXdnNjQrWjZyaXc3Wm1VS1N3ZzZyQ1E3SXVjN0o2UTY0cVVJT3F6aE95R2pTRHJncWpzbFlRZzY0dWs3SjJNSU9xNXFPeWFzT3E0c091bHZDRHJzSnZyaXBUcmk2UXVDZ3BqYjI1emRDQm9kSFJ3SUQwZ2NtVnhkV2x5WlNnbmFIUjBjQ2NwT3dwamIyNXpkQ0J3WVhSb0lEMGdjbVZ4ZFdseVpTZ25jR0YwYUNjcE93cGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0NtTnZibk4wSUc5eklEMGdjbVZ4ZFdseVpTZ25iM01uS1RzS1kyOXVjM1FnZXlCemNHRjNiaXdnYzNCaGQyNVRlVzVqSUgwZ1BTQnlaWEYxYVhKbEtDZGphR2xzWkY5d2NtOWpaWE56SnlrN0NncGpiMjV6ZENCUVQxSlVJRDBnTVRFNE9EazdDbU52Ym5OMElGSlBUMVFnUFNCd1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5MaTRuS1RzZ0x5OGc3S0NBN0o2bDdJYU1JT3VqcU8yS3VDRGlnSlFnNjR1azY2YXM2ckNBSUhKbFkyOXRiV1Z1WkMxbGVHRnRjR3hsY3k1dFpPdWx2Q0Rzc0w3cmlwUWc2cml3N0tTQUNncGpiMjV6ZENCRFQxSlRYMGhGUVVSRlVsTWdQU0I3Q2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVTl5YVdkcGJpYzZJQ2NxSnl3S0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxSVpXRmtaWEp6SnpvZ0owTnZiblJsYm5RdFZIbHdaU2NzQ24wN0NtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXdvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzS0lDQnlaWE11Wlc1a0tFcFRUMDR1YzNSeWFXNW5hV1o1S0c5aWFpa3BPd3A5Q2dvdkx5QmpiR0YxWkdVZ1EweEo2ckNBSU95ZWlPdUtsT3luZ0NEaWdKUWc3SmVHN0p5ODY2bTBJQzkzWVd0bElPeWRrZXVMdGV5WGtDRHNpNlRzbHJRZzdaU002NStzNnJlNDdKMjQ3SjIwSU95VmlPdUN0TzJWb0NEc2lKZ2c3SjZJNnJLTUlPMlZuT3VMcEFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzRLTHk4ZzdZeU03SjI4N0oyMElPMkJ0Q0RzaUpnZzdKNkk3SmEwSURNdzdMU0lJT3k2a095TG5DNGc3SjZzNjZHYzZyZTQ3SjI0N1pXWTY2bTBJRU5NU2Vxd2dDRHRqSXpzbmJ6c25ZUWc2ckN4N0l1ZzdaV1k2NitBNjZHY0lPeWVrT3VQbVNEcnNKanNtSUhya0p6cmk2UXVDaTh2SU95NmtPeUxuQ0ExN0xTSUlPS0FsQ0Ryb1p6cXQ3anNuYmdnN0tlQjdadUVJT3lEaUNEcXM0VHNvSlhzbmJRZzZyT242N0NVNjZHY0lPeWVvZTJZZ095VnZDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95WGtPeUVuQ0R0bVlqc25MenJvWndnNjRTWTdKYTA2ckNFNjR1a0tETXc3TFNJNjZtMElPdUVpT3VzdENEcmlxYnNuWXdwQ214bGRDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUF3TENCbGJXRnBiRG9nYm5Wc2JDQjlPd3BtZFc1amRHbHZiaUJqYkdGMVpHVkJZMk52ZFc1MEtDa2dld29nSUdsbUlDaEVZWFJsTG01dmR5Z3BJQzBnWVdOamIzVnVkRU5oWTJobExtRjBJRHdnTlRBd01Da2djbVYwZFhKdUlHRmpZMjkxYm5SRFlXTm9aUzVsYldGcGJEc0tJQ0JzWlhRZ1pXMWhhV3dnUFNCdWRXeHNPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0JxSUQwZ1NsTlBUaTV3WVhKelpTaG1jeTV5WldGa1JtbHNaVk41Ym1Nb2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSnk1amJHRjFaR1V1YW5OdmJpY3BMQ0FuZFhSbU9DY3BLVHNLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdWhuT3EzdU95ZHVDRHNuYlRyb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDQXFMeUI5Q2lBZ1lXTmpiM1Z1ZEVOaFkyaGxJRDBnZXlCaGREb2dSR0YwWlM1dWIzY29LU3dnWlcxaGFXd2dmVHNLSUNCeVpYUjFjbTRnWlcxaGFXdzdDbjBLQ21aMWJtTjBhVzl1SUdoaGMwTnNZWFZrWlNncElIc0tJQ0JqYjI1emRDQm1hVzVrWlhJZ1BTQndjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5JRDhnSjNkb1pYSmxKeUE2SUNkM2FHbGphQ2M3Q2lBZ2RISjVJSHNnY21WMGRYSnVJSE53WVhkdVUzbHVZeWhtYVc1a1pYSXNJRnNuWTJ4aGRXUmxKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuTENCemFHVnNiRG9nZEhKMVpTQjlLUzV6ZEdGMGRYTWdQVDA5SURBN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGRIVnliaUJtWVd4elpUc2dmUXA5Q2dwc1pYUWdkMkZyYVc1bklEMGdabUZzYzJVN0lDOHZJT3lYc08yRGdDRHJzS25zcDRBZzRvQ1VJT3VMcE91bXJPdUtsQ0RzbHJUc3NLanRsTHdnUlVGRVJGSkpUbFZUUmV1aG5DRHNwSkhyczdVZzdLQ1Y2NmFzN1pXWTdLZUE2NmVNSU8yVWhPdWhuT3lFdU95S3BDRHJncTNydVlUcnBid2c3S1NFN0oyNDY0dWtDbVoxYm1OMGFXOXVJSGRoYTJWQ2NtbGtaMlVvS1NCN0NpQWdhV1lnS0hkaGEybHVaeWtnY21WMGRYSnVPd29nSUhkaGEybHVaeUE5SUhSeWRXVTdDaUFnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3SUhkaGEybHVaeUE5SUdaaGJITmxPeUI5TENBMU1EQXdLVHNLSUNCc1pYUWdjSEp2WXpzS0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnTHk4Z1YybHVaRzkzY3pvZ1kyMWt3cmQyWW5NZzZySzk3SnlnSU95WGh1eWR0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTd2dkMmx1Wkc5M2MwaHBaR1VvUTFKRlFWUkZYMDVQWDFkSlRrUlBWeW5yb1p3ZzdJcWs3WSt3SU9LQWxBb2dJQ0FnTHk4ZzdMQzlJT3lYaHV1S2xDRHNpS2pzbllBZzdMMlk3SWFVN0oyMElPdW5qT3VUcE95V3RPeW5nT3F6b0NEcmk2VHJwcXpzblpnZzdKNlE3SXVkS0dOc1lYVmtaU25yajRRZzZyZTRJT3k5bU95R2xPeWRoQ0Ryckx6cm9LVHJzSnZzbFlRZzdKYTA2NWFrSU95d3ZldVBoQ0RzbFlnZzY1eXM2NHVrTGdvZ0lDQWdMeThnWkdWMFlXTm9aV1RyaXBRZzdKT3c3S2VBSU95Vml1dUtsT3VMcENoa1pYUmhZMmhsWkN0M2FXNWtiM2R6U0dsa1pTRHNvYkR0bGFuc25ZQWc3TDJZN0lhVUlPeXd2ZXlkdENEcmhianN0cHpya0tnZzRvQ1VJT3lMcE95NG9Ta3VDaUFnSUNBdkx5QlhhVzVrYjNkejdKZVE3SVNnSUdSbGRHRmphR1ZrSU95WGh1eWR0T3VQaENEcnRvRHJxcWdvNnJDUTdJdWM3SjZRS2Vxd2dDRHNvNzNzbHJUcmo0UWc3SjZRN0l1ZDdKMkFJT3lDdE95VmhPdUNxT3VLbE91THBDNEtJQ0FnSUhCeWIyTWdQU0J6Y0dGM2JpaHdjbTlqWlhOekxtVjRaV05RWVhSb0xDQmJjR0YwYUM1cWIybHVLRjlmWkdseWJtRnRaU3dnSjJOc1lYVmtaUzFpY21sa1oyVXVhbk1uS1Ywc0lIc0tJQ0FnSUNBZ1kzZGtPaUJTVDA5VUxDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbExBb2dJQ0FnZlNrN0NpQWdmU0JsYkhObElIc0tJQ0FnSUM4dklHMWhZMDlUTCt1bXJPdUloZXlLcERvZzZyQ1E3SXVjN0o2UTY2VzhJT3VkaE95YXRDQnViMlJsSU95THBPMldpU0R0akl6c25ienJvWndnN0tlQjdLQ1JJT3lLcE8yUHNDQW9iR0YxYm1Ob1pDRHRtWmpxc3Izc2w1UWdVRUZVU09xd2dDRHJ1WWpzbGIzdGxhQWc3SWlZSU95ZWlPeVd0Q0Rzb0lqcmpJRHFzcjNyb1p3ZzdJS3M3SnFwS1FvZ0lDQWdjSEp2WXlBOUlITndZWGR1S0hCeWIyTmxjM011WlhobFkxQmhkR2dzSUZ0d1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5ZMnhoZFdSbExXSnlhV1JuWlM1cWN5Y3BYU3dnZXdvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUdSbGRHRmphR1ZrT2lCMGNuVmxMQ0J6ZEdScGJ6b2dKMmxuYm05eVpTY3NDaUFnSUNCOUtUc0tJQ0I5Q2lBZ2NISnZZeTUxYm5KbFppZ3BPeUF2THlEcXNKRHNpNXpzbnBBZzdKMjA2N0trN1lxNElPdWpxTzJVaE95WGtPeUVuQ0RydG9UcnBxd2dLT3F3a095TG5PeWVrQ0Rzb29Ycm80enJwYndnNjZlSjdLZUFJT3lWaXVxeWpDa0tmUW9LTHk4ZzdKMjBJRkJENjZXOElDZnNoS1RzdVpnZzdLQ0VLT3lEaUNCUVF5a25JT3lEZ2UyRG5PdWhuQ0Rya0pqcmo0enJwckRyaTZRZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNCYjdMU0k2cml3N1ptVVhTRHJzb1R0aXJ3b1VFOVRWQ0F2ZFc1cGJuTjBZV3hzS2V5ZHRDRHJ0b0RycGJqcmk2UXVDaTh2SUhKbFoybHpkR1Z5TFhCeWIzUnZZMjlzTG1wejZyQ0FJT3lFcE95NW1PMlZuQ0Rxc29Qc25ZUWc2cmU0NjR5QTY2R2NJT3VRbU91UGpPdW1zT3VMcERvZzZyQ1E3SXVjN0o2UUlPeWVrT3VQbWV5TG5PeWVrU0FySUNqc25vanNuTHpycWJRcElPeUVwT3k1bUNEdGo3VHJqWlF1Q2k4dklPS2FvTys0anlEcnNKanJrNXpzaTV3Z1NGUlVVQ0RzblpIcmk3WHNuWVFnNjZpODdLQ0FJT3V6dE91Q3VDRHJrcVFnN1ppNDdMYWM3WldnSU9xeWd5RGlnSlFnYldGalQxTWdiR0YxYm1Ob1kzUnNJR0p2YjNSdmRYVHNuYlFnN0oyMElPMlVoT3Vobk95RXVPeUtwT3VsdkNEc3BvbnNpNXdnN0tLRjY2T003SXVjN1lLc0lPeUltQ0Rzbm9qcmk2UXVDaTh2SUNBZ0lPcTN1T3VlbU95RW5DRHRqSXpzbmJ3b2NHeHBjM1RDdCt5RXBPeTVtQ0R0ajdUcmpaUXA3SjJFSUd4aGRXNWphR04wYk91enRPdUxwQ0RycUx6c29JQWc3S2VBN0pxMDY0dWtJT0tBbENCaWIyOTBiM1YwN0oyMElPeWFzT3Vtck91bHZDRHNvNzNzbDZ6cmo0UWc3SjZRNjQrWjdJdWM3SjZSN0oyQUlPeWR0T3V2dUNEc2dxenJuYnpzcDRUcmk2UXVDbVoxYm1OMGFXOXVJSFZ1YVc1emRHRnNiRk5sYkdZb0tTQjdDaUFnWTI5dWMzUWdjbVZ0YjNabFpDQTlJRnRkT3dvZ0lIUnllU0I3Q2lBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0oyUmhjbmRwYmljcElIc0tJQ0FnSUNBZ1kyOXVjM1FnVEVGQ1JVd2dQU0FuWTI5dExtTnNZWFZrWldKeWFXUm5aUzUzWVhSamFHVnlKenNLSUNBZ0lDQWdZMjl1YzNRZ2NHeHBjM1FnUFNCd1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuVEdsaWNtRnllU2NzSUNkTVlYVnVZMmhCWjJWdWRITW5MQ0JNUVVKRlRDQXJJQ2N1Y0d4cGMzUW5LVHNLSUNBZ0lDQWdZMjl1YzNRZ2FXNXpkQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2RNYVdKeVlYSjVKeXdnSjBGd2NHeHBZMkYwYVc5dUlGTjFjSEJ2Y25RbkxDQW5RMnhoZFdSbFFuSnBaR2RsSnlrN0NpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLSEJzYVhOMEtTa2dleUJtY3k1MWJteHBibXRUZVc1aktIQnNhWE4wS1RzZ2NtVnRiM1psWkM1d2RYTm9LSEJzYVhOMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzMEtJQ0FnSUNBZ2RISjVJSHNnYVdZZ0tHWnpMbVY0YVhOMGMxTjVibU1vYVc1emRDa3BJSHNnWm5NdWNtMVRlVzVqS0dsdWMzUXNJSHNnY21WamRYSnphWFpsT2lCMGNuVmxMQ0JtYjNKalpUb2dkSEoxWlNCOUtUc2djbVZ0YjNabFpDNXdkWE5vS0dsdWMzUXBPeUI5SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUW9nSUNBZ0lDQjBjbmtnZXlCemNHRjNibE41Ym1Nb0oyeGhkVzVqYUdOMGJDY3NJRnNuWW05dmRHOTFkQ2NzSUNkbmRXa3ZKeUFySUhCeWIyTmxjM011WjJWMGRXbGtLQ2tnS3lBbkx5Y2dLeUJNUVVKRlRGMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCOUlHTmhkR05vSUNoZlpTa2dlMzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHNZWFZ1WTJoamRHd25MQ0JiSjNKbGJXOTJaU2NzSUV4QlFrVk1YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlFvZ0lDQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUhSeWVTQjdJSE53WVhkdVUzbHVZeWduY21Wbkp5d2dXeWRrWld4bGRHVW5MQ0FuU0V0RFZWeGNVMjltZEhkaGNtVmNYRTFwWTNKdmMyOW1kRnhjVjJsdVpHOTNjMXhjUTNWeWNtVnVkRlpsY25OcGIyNWNYRkoxYmljc0lDY3ZkaWNzSUNkRGJHRjFaR1ZDY21sa1oyVlhZWFJqYUdWeUp5d2dKeTltSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPeUJ5WlcxdmRtVmtMbkIxYzJnb0oreWVrT3VQbWV5TG5PeWVrU2hEYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5S1NjcE95QjlJR05oZEdOb0lDaGZaU2tnZTMwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5WldjbkxDQmJKMlJsYkdWMFpTY3NJQ2RJUzBOVlhGeFRiMlowZDJGeVpWeGNRMnhoYzNObGMxeGNZMnhoZFdSbFluSnBaR2RsSnl3Z0p5OW1KMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE95QnlaVzF2ZG1Wa0xuQjFjMmdvSjJOc1lYVmtaV0p5YVdSblpUb3ZMeURyazdIcm9aMG5LVHNnZlNCallYUmphQ0FvWDJVcElIdDlDaUFnSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdhVzV6ZENBOUlIQmhkR2d1YW05cGJpaHdjbTlqWlhOekxtVnVkaTVNVDBOQlRFRlFVRVJCVkVFZ2ZId2djR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0owRndjRVJoZEdFbkxDQW5URzlqWVd3bktTd2dKME5zWVhWa1pVSnlhV1JuWlNjcE93b2dJQ0FnSUNBZ0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWdmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZRb2dJQ0FnSUNCOUlHTmhkR05vSUNoZlpTa2dlMzBLSUNBZ0lIMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUJtWVdsc0xYTnZablFnNG9DVUlPdXF1eURzcDREc21yUWc2cktNSU95ZWlPeVd0T3VQaENEdGxJenJuNnpxdDdqc25iZ2c3S3E5SU9xNHNPeVd0U0RzZ3Ezc29KenJpcFFnN0oyMDY2KzRJT3VCbmV1Q3JPdUxwQ0FxTHlCOUNpQWdjbVYwZFhKdUlISmxiVzkyWldRN0NuMEtDaTh2SU91THBPdW1yQ2d4TVRnNE9DbnFzSUFnNjVhZ0lPeWVpT3ljdk91cHRDRHJnWWpyaTZRZzRvQ1VJT3kwaU9xNHNPMlpsQ0RzaTV3ZzY0S283SjJBSU95RXVPeUZtQ0Rzb0pYcnBxd2dLT3lYaHV5Y3ZPdXB0Q0Rzb2JEc21xbnRub2dnN0l1azdZeW9LUXBtZFc1amRHbHZiaUJ6YUhWMFpHOTNia0p5YVdSblpTZ3BJSHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnY2lBOUlHaDBkSEF1Y21WeGRXVnpkQ2g3SUdodmMzUTZJQ2N4TWpjdU1DNHdMakVuTENCd2IzSjBPaUF4TVRnNE9Dd2djR0YwYURvZ0p5OXphSFYwWkc5M2JpY3NJRzFsZEdodlpEb2dKMUJQVTFRbkxDQjBhVzFsYjNWME9pQXhOVEF3SUgwc0lDZ3BJRDArSUh0OUtUc0tJQ0FnSUhJdWIyNG9KMlZ5Y205eUp5d2dLQ2tnUFQ0Z2UzMHBPd29nSUNBZ2NpNXZiaWduZEdsdFpXOTFkQ2NzSUNncElEMCtJSHNnZEhKNUlIc2djaTVrWlhOMGNtOTVLQ2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmU0I5S1RzS0lDQWdJSEl1Wlc1a0tDazdDaUFnZlNCallYUmphQ0FvWDJVcElIdDlDbjBLQ21OdmJuTjBJSE5sY25abGNpQTlJR2gwZEhBdVkzSmxZWFJsVTJWeWRtVnlLQ2h5WlhFc0lISmxjeWtnUFQ0Z2V3b2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwS0lDQnBaaUFvY21WeExuVnliQ0E5UFQwZ0p5OW9aV0ZzZEdnbktTQjdDaUFnSUNBdkx5QjJPaURxc0pEc2k1enNucEFnN0wyVTY1T2NJT3V5aE95Z2hDRGlnSlFnNnJXczY3S0U3S0NFSU8yVWhPdWhuT3lFdU95S3BPcXdnQ0RxczRUc2hvMGc2NCtNNnJPZ0lPeWVpT3VLbE95bmdDRHJzSmJzbDVEc2hKd2c3Wm1WN0oyNDdaV1k2NHFVSU95YXFldVBoQW9nSUNBZ0x5OGdLSFl5SUQwZzdMQzlJT3lJcU9xNWdDRHNpSmpzb0pYdGpKQXNJSFl6SUQwZ0wyRmpZMjkxYm5RZzdMYVU2ckNBN1l5UUxDQjJOQ0E5SUM5MWJtbHVjM1JoYkd3ZzdMYVU2ckNBN1l5UUtRb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJSGRoZEdOb1pYSTZJSFJ5ZFdVc0lIWTZJRFFnZlNrN0NpQWdmUW9nSUM4dklPeWR0Q0JRUSt5WGtDRHJvWnpxdDdqc25ianJrSndnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0RpZ0pRZzdaU002NStzNnJlNDdKMjRJT3l5cXlEdG1aVHJxYlRDdCsyWmlPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFRzcDRBaUlPdXp0T3lYck95anZPdUtsQ0RyamJBZzdKTzA2NHVrTGdvZ0lDOHZJT3F3a095TG5PeWVrT3F3Z0NEcmk3WHRsWmpyaXBRZzdKMjA3SnlnT2lEcmk2VHJwcXpycGJ3ZzdMeWM2Nm0wSU95YmpPdXdqZXlYaGV5Y3ZPdWhuQ0R0Z2JUcm9aenJrNXpxc0lBZzdJdWs3S0NjSU8yWXVPeTJuT3VQdkNEcXRhenJqNFVnN0lLczdKcXA2NStKN0oyMElPdUNtT3F3aE91THBDNEtJQ0F2THlEcXNKRHNpNXpzbnBEcmlwUWc3WXlNN0oyODY2ZU1JT3lkdmV5Y3ZPdXZnT3VobkNEc2dxenNtcW5ybjRrZ01DREN0eURyaklEcXVMQWdNQ0RpZ0pRZzZyS0E3WWFnNjZlTUlPeVRzT3VLbENEc2dxenJub3pzbDVEcXNvd2c2N21FN0pxcDdKMkVJT3Vzdk91bXJPeW5nQ0RzbFlycmlwVHJpNlF1Q2lBZ0x5OGc3S084N0oyWU9pRHNsNnpxdUxBZzZyT0U3S0NWN0oyMElPdXp0T3lYck91UGhDRHNub1hzbnFYcXRvenNuYlFnNjZlTTY2T002NUNRN0oyRUlPeUltQ0Rzbm9qcmk2UW83SnlnN1pxbzdJU3g3SjJBSU95THBPeWduQ0R0bUxqc3Rwd2c2NVdNNjZlTUlPeVZqQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHJpNlRycHF3Z0wyaGxZV3gwYU95ZG1DQndjbTlpYkdWdElPeXd1T3F6b0NrdUNpQWdhV1lnS0hKbGNTNTFjbXdnUFQwOUlDY3ZZV05qYjNWdWRDY3BJSHNLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCaFkyTnZkVzUwT2lCamJHRjFaR1ZCWTJOdmRXNTBLQ2tzSUdOc1lYVmtaVG9nYUdGelEyeGhkV1JsS0NrZ2ZTazdDaUFnZlFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5M1lXdGxKeWtnZXdvZ0lDQWdhV1lnS0NGb1lYTkRiR0YxWkdVb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJR1poYkhObExDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXMXBjM05wYm1jbklIMHBPd29nSUNBZ2QyRnJaVUp5YVdSblpTZ3BPd29nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUhkaGEybHVaem9nZEhKMVpTQjlLVHNLSUNCOUNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dld29nSUNBZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlNCOUtUc0tJQ0FnSUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBMQ0F5TURBcE93b2dJQ0FnY21WMGRYSnVPd29nSUgwS0lDQXZMeURzdElqcXVMRHRtWlFnNG9DVUlPeWR0Q0JRUSt1bHZDQW43SU9JSUZCREp5RHNnNEh0ZzV6cm9ad2c2NUNZNjQrTTY2YXc2NHVrSUNqdGxJenJuNnpxdDdqc25iZ2dXK3kwaU9xNHNPMlpsRjBnNjdLRTdZcThLUzRLSUNBdkx5RHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPMmRtT3VncE91enRPdUN1Q0Rya3FRZzdLQ1Y2NmFzN1pXYzY0dWtJT0tBbENCaWIyOTBiM1YwN0oyMElPeWFzT3Vtck91bHZDRHNwb25zaTV3ZzdLTzk3SmVzNjQrRUlPMmFqT3lMb095ZGdDRHJqNFRzc0tudGxaenJpNlF1Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNWdWFXNXpkR0ZzYkNjcElIc0tJQ0FnSUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUhCc1lYUm1iM0p0T2lCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUgwcE93b2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3Q2lBZ0lDQWdJSE5vZFhSa2IzZHVRbkpwWkdkbEtDazdDaUFnSUNBZ0lHTnZibk4wSUhKbGJXOTJaV1FnUFNCMWJtbHVjM1JoYkd4VFpXeG1LQ2s3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYmQyRjBZMmhsY2wwZzdMU0k2cml3N1ptVUtIVnVhVzV6ZEdGc2JDa2c0b0NVSU95Z25PcXhzRG9uTENCeVpXMXZkbVZrTG1wdmFXNG9KeXdnSnlrZ2ZId2dKeWpzbDRic25Zd3BKeWs3Q2lBZ0lDQWdJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdjSEp2WTJWemN5NWxlR2wwS0RBcExDQXlNREFwT3dvZ0lDQWdmU3dnTWpVd0tUc0tJQ0FnSUhKbGRIVnlianNLSUNCOUNpQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNRFFzSUhzZ1pYSnliM0k2SUNkT2IzUWdabTkxYm1RbklIMHBPd3A5S1RzS0NpOHZJT3lkdE91dnVDRHJscUFnN0o2STdKeTg2Nm0wSU95aHNPeWFxZTJlaUNEc29vWHJvNHdnS095ZWtPdVBtU0RzaTV6c25wRWdLeUJ1Y0cwZ1luVnBiR1FnN0tTUjY3TzFJT3lMcE8yV2lTRHJqSURydVlRcENuTmxjblpsY2k1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V3b2dJR2xtSUNobElDWW1JR1V1WTI5a1pTQTlQVDBnSjBWQlJFUlNTVTVWVTBVbktTQndjbTlqWlhOekxtVjRhWFFvTUNrN0NpQWdjSEp2WTJWemN5NWxlR2wwS0RFcE93cDlLVHNLYzJWeWRtVnlMbXhwYzNSbGJpaFFUMUpVTENBbk1USTNMakF1TUM0eEp5d2dLQ2tnUFQ0Z2V3b2dJR052Ym5OdmJHVXViRzluS0NkYmQyRjBZMmhsY2wwZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzdMeWM3S2VRSU9LQWxDQm9kSFJ3T2k4dmJHOWpZV3hvYjNOME9pY2dLeUJRVDFKVUtUc0tmU2s3Q2c9PScKQjY0X0VYQU1QTEVTPSdJeURyckxqcXRhd2c3TGFVN0xLY0lPeVlpT3lMbkFvS0l1dXN1T3ExckNEc3RwVHNzcHpyc0p2cXVMQWk2ckNBSU95Q3JPeWFxZTJWbU91S2xDRHNtSWpzaTV3ZzY2cW83SjJNN0o2RjY0dUk2NHVrTGlBcUt1eWR0Q0R0akl6c25ienNuWVFnN0lpWTdLQ1Y3WldjSU91U3BDRHRoTERycjdqcmhKRHNsNURzaEp3Z1lHNXdiU0J5ZFc0Z1luVnBiR1JnNjZXOElPeUxwTzJXaWUyVm1PcXpvQ3dnUm1sbmJXSHNsNURzaEp3ZzdaU002NStzNnJlNDdKMjQ3SjJFSU91THBPeUxuQ0RzaTZUdGxvbnRsWmpycWJRZzY3Q1k3SmlCNjVDcDY0dUk2NHVrTGlvcUNnb2pJeURzbnBIc2hMRWc2N0NwNjdLVkNnb3RJT3lZaU95TG5DRHRsWmpyZ3BqcmlwUWdLaXBnSXlNaklPeWJrT3V6dUdBcUtpRHRsWndnN0tTRTZyTzhMQ0RxdDdnZzdKV0U2NTZZSUNvcVlDMGc3TGFVN0xLYzdKV0lZQ29xSU95WHJPdWZyQ0Rxc0p6cm9ad2c3SjIwNjZTRTdLZVI2NHVJNjR1a0xnb3RJT3kybE95eW5PeVZpQ0RzbFlqc2w1RHNoSndnS2lyc3BJVHNuWVFnNjdDVTZyNjQ2ck9nSU95THR1eWN2T3VwdENCZ0lDOGdZQ0FvN0pXZTY1S2tJT3F6dGV1d3NTRHRqNnp0bGFnZzdJcXM2NTZZN0l1Y0tTb3FJT3VobkNEdGtaenNpNXp0bFpqc2hManNtcFF1SU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEcmtaQWc3S1NFNjZHY0lPdXp0T3lYck95bmtldUxpT3VMcEM0S0xTRHNncXpzbXFuc25wRHFzSUFnN0o2RjY2Q2w3WldjSU91c3VPcTFyT3F3Z0NCZzdKdVE2N080WU9xenZDQW82ck8xNjdDeHdyZnJyTGpzbnFYcnRvRHRtTGdnNjZ5MDdJdWM3WldZNnJPZ0tTRHFzSm5xc2JEcmdwZ3NJT3lFbk91aG5DRHRqNnp0bGFqdGxaanJxYlFnNnJlNElPeTJsT3l5bk95VmlPdVRwT3lkaENEcnM3VHNsNnpzcEkzcmk0anJpNlF1Q2kwZzY2ZWs3TG10N1pXZ0lPdVZqQ0FxS3V1bmlPeUtwTzJDdWV1UW5DRHNuYlRycG9RbzdabU5YQ3JyajVrcExDRHNpS3ZzbnBBbzdLQ0U3Wm1VNjdLSTdaaTR3cmNpN0ptNElETHJxb1VpSU91VHNTbnJpcFFnNjZ5MDdJdWNLaXJ0bGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWFsR0FnWUg3cmo3enNtcFJnSUdCKzdKZUc3SmEwN0pxVVlDQmdmdTJWdENEc283enNoTGpzbXBSZ0tRb3RJRExyaTZnZzZyV3M3S0d3T2lBcUt1eXlxeURzcElROTdJT0I3Wm1wSU95RXBPdXFoU0RpaHBJZzY1R1k3S2U0SU95a2hEM3JpNlRzbll3ZzdaYUo2NCtaS2lvbzZyS3c3S0NWN0oyQUlHQis3WldnNnJtTTdKcVVQMkFzSU8yV2lldVBtU0RzbktEcmo0VHJpcFFnWUg3dGxiUWc3S084N0lTNDdKcVVZQ2tLTFNEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0tPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ2tzSU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBbzdKZUc3SmEwN0pxVTRvYVNmdTJWbU91cHRDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDa0tMU0RzdXBEc283enNscnp0bFp3ZzZySzk3SmEwS0g3c2k1enFzcURzbHJUc21wUS80b2FTZnUyVm9PcTVqT3lhbEQ4cExDRHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNDanNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2M0b2FTN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5Da0tMU0Rxc0lUcXNyRHRsWmpxczZBZzdJbXM3SnEwSU91bmtDQW83S0NFN0lhaDRvYVM2N08wNjRLMDY0dWtLU3dnNjdhQTdLQ1ZJT3lEZ2UyWnFldVBoQ0RybExIcmxMSHRsWmpzcDRBZzdKV0s2cktNS0NMc3NMN3F1TEFnN0l1azdZeW9JdUtkakNBaTdMQys3SjJFSU95SW1DRHNsNGJzbHJUc21wUWk0cHlGS1FvS0l5TWc3TGFVN0xLY0lPeVlpT3lMbkFvS0l5TWpJT3luaE8yV2llMlZtT3VObUNEc25wSHNsNFhzbmJRZzdKNkk3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0tlRTdaYUpJT3lra2V5ZHVDRHJnclRzbDYzc25iUWc3SjZJN0phMDdKcVVMaUF2SU95ZHRPeVd0T3lFbkNEc3A0VHRsb250bGFEcXVZenNtcFEvQ2dvakl5TWc2ck8xN0p5Z0lPeWFsT3l5cmV5ZGhDRHN0NmpzaG96dGxaanJxYlFnN0pxVTdMS3RJT3VDdE95WHJleWR0Q0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kzcU95R2pPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXloT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwSU95anZPeUV1T3lhbEM0Z0x5RHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2lNakl5RHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4S0xTRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhLTFNEc2k2RHFzNkFnN0oyMDdKeWc2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0o2VTdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVQ2kwZzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMZ29LSXlNaklPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnN0ptNElETHJxb1hzbDVEcXNvd2c2cmFNN1pXY0lPeUNyZXlnbkNEc2xZenJwcnp0aHFIc25ZUWc3S0NFN0lhaDdaV2c2cm1NN0pxVVB3b3RJT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3RPdWdwT3F6b0NEdGxiVHNtcFF1SUM4ZzdabU5LdXVQbVNnd01UQXRNVEl6TkMwMU5qYzRLU0RyaTVnZzdKbTRJRExycW9Yc2w1RHFzb3dnNjdPMDY0Szg2cm1NN0pxVVB3b3RJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzY0dVlJT3ladUNBeTY2cUY3SmVRNnJLTUlPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdk9xNWpPeWFsRDhLTFNEcXRvenRsWndnN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4S0NpTWpJeURyb1p6cXQ3anNsWVRzbTRNZzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3Vobk9xM3VPeVZoT3liZysyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbGJIc25ZUWc3S0tGNjZPTTdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3lWc2V5ZGhDRHNvb1hybzR6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nN1pXY0lPdXlpQ0RyczREcXNyM3RsWmpycWJRZzY0dWs3SXVjSU91emdPcXl2ZTJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzY0dWs3SXVjSU91d2xPcS9nQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6aE95R2plMlZvT3E1ak95YWxEOEtDaU1qSXlEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpya0tucmk0anJpNlF1SU95MGlPcTRzTzJabE8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmo3enNtcFF1SUM4ZzdMU0k2cml3N1ptVTdaV2c2cm1NN0pxVVB3b0tJeU1qSXlEc2w1RHJuNnpDdCt5THBPMk1xQW9LSXlNaklPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPdUVwTzJLdU95YmpPMkJyT3lYa0NEc2w3RHFzckR0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc2w3RHFzckFnN0lPQjdZT2M2Nlc4SU8yWmxleWR1TzJWbU9xem9DRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ienNpNXpzb0lIc25iZ2c3SmlrNjZXWTZyQ0FJT3V3bk95RG5lMldpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0RzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0k3Wmk0NjZXOElPeWVyT3V3bk95R29lMlZtT3lMcmV5TG5PeVlwQzRLTFNEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95bmdPdUNyT3lXdE95YWxDNGdMeURzbmJqc3BwM3Jzb2p0bUxqcnBid2c2NHVrN0l1Y0lPdXdtK3lWaENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzbHJUc21wUXVJQzhnNjR1azY2VzRJT3F5Z095RGlleVd0T3VobkNEcmk2VHNpNXdnN0xDKzdKV0U2N08wN0lTNDdKcVVMZ29LSXlNaklPeWdsZXV6dE91bHZDRHJ0b2pybjZ6c21LVHNwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNvSlhyczdUcnBid2c2N2FJNjUrczdKaXNJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHRqSXpzbmJ3ZzdKZUY2NkdjNjVPYzdKZVFJT3lMcE8yTXFPMldpT3lLdGV1TGlPdUxwQzRLTFNEdGpJenNuYnpzbllRZzdKaXM2NmFzN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRnTHlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0tDUTZyS0FJT3lra2V5ZWhldUxpT3VMcEM0ZzdKMjA3SnFwN0plUUlPdTJpTzJPdU95ZGhDRHJrNXpyb0tRZzdLT0U3SWFoN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHNoSnpydVlUc2lxVHJwYndnN0tDUTZyS0E3WldZNnJPZ0lPeWVpT3lXdE95YWxDNGdMeURzb0pEcXNvRHNuYlFnNjRHZDY0S1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxZVHNpSmdnN0o2RjY2Q2xJTzJWcmV1cXFleWVoZXVMaU91THBDNEtMU0RxdkswZzdKNkY2NkNsN1pXMDdKVzhJTzJWbU91S2xDRHRsYTNycXFuc25iVHNsNURzbXBRdUNnb2pJeU1qSU9xMmpPMlZuTUszN0lTazdLQ1ZDZ29qSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVBtZXlkbU8yVm1PeW5nQ0RzbFlyc2xZUWc3SjI4NjdhQUlPcTRzT3VLcGV5ZHRDRHNvSnp0bFp6cmtLbnJpNGpyaTZRdUNpMGc3SnlFN0xtWUlPeWdsZXV6dE91bHZDRHRsNGpzbXFudGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3SnlFN0xtWUlPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHNtWVRybzR6Q3QreW5oTzJXaVFvS0l5TWpJT3lnZ095ZXBldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNvSURzbnFYdGxvanNsclRzbXBRdUNnb2pJeU1nNjdPQTZySzk3SUtzN1pXdDdKMjBJT3lnZ2V5YXFldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzNERxc3IwZzY0SzA3SnFwN0oyRUlPeWdnZXlhcWUyV2lPeVd0T3lhbEM0S0NpTWpJeURzb0lUc2hxSHNuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dE91RGlPeVd0T3lhbEM0S0NpTWpJeURyazdIcm9aM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3VUc2V1aG5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1nN0lLdDdLQ2M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lDcmV5Z25PMldpT3lXdE95YWxDNEtDaU1qSXlEdGdiVHJwcjNyczdUcms1enNsNUFnNjdPMTdJS3M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dGV5Q3JPMldpT3lXdE95YWxDNEtDaU1qSXlEc21wVHNzcTNzbllRZzdMS1k2NmFzSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SnFVN0xLdDdKMkVJT3l5bU91bXJPMlZtT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3lWaU91Q3RNSzM3SnlnNjQrRUNnb2pJeU1nN0lPSTY2R2M3SnEwSU91eWhPeWdoT3lkdENEc3RwenNpNXpya0pqc2w0anNpclhyaTRqcmk2UXVJT3lYaGV1TnNPeWR0TzJLdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVZoT3liZyt1UWtPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1RzbFlqc25ZUWc3SnlFN1pXMElPdTVoT3V3Z091eWlPMll1T3VsdkNEcnM0RHFzcjN0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEc2xZanNvSVR0bFp3ZzdJS3M3SnFwN0oyRUlPeWNoTzJWdENEcnVZVHJzSURyc29qdG1ManJwYndnNjdDVTZyK1VJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc2N08wN0pXSUlPeUVuT3U1aE95S3BBb0tJeU1qSU9xeXZldTVoT3VsdkNEcXNKenNpNXp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzZySzk2N21FNjZXOElPeUxuT3lla2UyVm9PcTVqT3lhbEQ4S0NpTWpJeURxc3IzcnVZVHJwYndnN1pXMDdLQ2M3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU9xeXZldTVoT3VsdkNEdGxiVHNvSnp0bGFEcXVZenNtcFEvQ2dvakl5TWc2cml3NnJpdzZyQ0FJT3lZcE8yVWhPdWR2T3lkdUNEc2c0SHRnNXpzbm9Ycmk0anJpNlF1SU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc25ZUWc3Wm1WN0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU9xNHNPcTRzT3F3Z0NEcmhLVHRpcmpzbTR6dGdhenNsNUFnN0pldzZyS3c2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyaXc2cml3N0oyWUlPeVhzT3F5c0NEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21JSHNnNEhzbllRZzY3YUk2NStzN0ppazY0cVVJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKaUI3SU9CN0oyRUlPdTJpT3Vmck95WXBPcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95M3FPeUdqTzJWbU95THBDRHFzcjNzbXJBZzdJdWc3TEt0N1pXWTdJdWdJT3VDdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXdnQ0Rzbm9qcmdwanNtcFEvQ2dvakl5TWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdWx2Q0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTTY0cVVJT3lXdk91bmlPeWR1T3F3Z095YWxEOEtDaU1qSXlEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvY2c2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1Q2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUhJT3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsWmpzaTV6cXNxRHNsclRzbXBRL0NpMGc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOEtDaU1qSXlEc2k1enNucEh0bFpqc2k1enJpcFFnNjdhRTdKZVE2cktNSURVc01EQXc3SnVRN0oyRUlPdVRuT3VncE95YWxDNEtMU0RzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMZ29LSXlNaklPeWR0T3lla0NEdG1aanJ0b2pzbllRZzY3Q2I3SldZN0phMDdKcVVMZ290SU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRdUNnb2pJeU1nN0ppazY0cVk3SjJZSU8yQXRPeW1pT3F3Z0NEcXM2Y2c3S0tGNjZPTTY0Kzg3SnFVTGdvdElPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEM0S0NpTWpJeURxdUlqc25ienF1WXpzcDRBZzY2KzQ2NEtwSU95TG5DRHNsN0Rzc3JRZzdMS1k2NmFzNjVDcDY0dUk2NHVrTGlEdG00VHJ0b2pxc3JEc29Kd2c2cmlJN0pXaDdKMkVJT3VDcWV1MmdPMlZtT3lMbk9xNHNDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdKaWs2NHFZNnJtTTdLZUFJT3VDdE95bmdDRHNsWXJzbkx6cnFiUWc3SmV3N0xLMDY0Kzg3SnFVTGlBdklPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2tPcXlnQ0RxdUxEcXNJVHNsNURyaXBRZzdJU2M2N21FN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHNuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkdENEcmhibnNuWXpya0tucmk0anJpNlF1Q2kwZzY0MlVJT3lpaSt5ZGdDRHNnNEhyaTdUc25ZUWc3SnlFN1pXMElPMkd0ZTJabENEcmdyVHNtcW5zbllBZzY0VzU3SjJNNjQrODdKcVVMZ29LSXlNaklPcXpvT3F3bmV1TG1PeWRtQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkZ0NEcXVMRHJvWjBnNnJTQTY2YXM2NUNwNjR1STY0dWtMZ290SU95ZHRPeWduT3UyZ08yRXNDRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWR0Q0RxdUxEcm9aM3JqN3pzbXBRdUNnb2pJeU1nN0xLdDdJYU02NFdFN0oyQUlPeUVuT3U1aE95S3BDRHFzSURzbm9Yc25iUWc2N2FJNnJDQTdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YWxDNEtDaU1qSXlNZzZyT0U3S0NWd3Jmc25vWHJvS1VLQ2lNakl5RHNsWVRzbmJUcmxKUWc2NWlRNjRxVUlPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3lkdE95RGdTRHNucGpycXJzZzdKNkY2NkNsN1pXWTdKZXNJT3F6aE95Z2xleWR0Q0RzbnFEcXVJZ2c3TEtZNjZhczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3llbU91cXV5RHNub1hyb0tYdGxiVHNoSndnNnJPRTdLQ1Y3SjIwSU95ZW9PcXl2T3lXdE95YWxDNGdMeURydVlUcnNJRHJzb2p0bUxqcnBid2c3SjZzN0lTazdLQ1Y3WldZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNuYlRycjdnZzdJS3M3SnFwSU95a2tleWR1Q0RzbFlUc25iVHJsSlRzbm9Ycmk0anJpNlF1Q2kwZzdKMjA2Nis0SU95VHNPcXpvQ0Rzbm9qcmlwUWc3SldFN0oyMDY1U1U3SmlJN0pxVUxpQXZJT3VMcE91bHVDRHNsWVRzbmJUcmxKVHJwYndnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzM2cml3N1lPQUNnb2pJeU1nN1l5TTdKMjhJT3lhcWV1ZmlleWR0Q0RzdElqcXM3enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlERXdUVUlnN0oyMDdaV1k3SjJZSU8yTWpPeWR2T3VuakNEc2w0WHJvWnpyazV3ZzZyQ0E2NHFsN1pXcDY0dUk2NHVrTGdvdElERXdUVUlnN0oyMDdaV1lJTzJNak95ZHZPdW5qQ0RzbUt6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHRqSXpzbmJ3ZzdKcXA2NStKN0oyRUlPMlpsZXlkdU8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0dWs3SnEwNjZHYzY1T2M2ckNBSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyaTZUc21yVHJvWnpyazV6cnBid2c2NmVJN0xPazdKYTA3SnFVTGdvS0l5TWpJT3F5c095Z25PeVhrQ0RzaTZUdGpLanRsWmpzbUlEc2lyWHJpNGpyaTZRdUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEcXNyRHNvSnp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPcXlzT3lnbkNEc2lKanJpNmpzbllRZzdabVY3SjI0N1pXWTZyT2dJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXWTdKZXNJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXp0ZXF3aE95ZGhDRHRtWlhyczdUdGxad2c2NUtrSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lFbk91NWhPeUtwQ0RzcElEcnVZUWc3S1NSN0o2RjY0dUk2NHVrTGdvdElPeWtnT3U1aE8yVm1PcXpvQ0Rzbm9qcmlwUWc2cml3NjRxbDdKMjA3SmVRN0pxVUxpQXZJT3loc09xNGlPdW5qQ0RxdUxEcmk2VHJvS1FnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3VUc2V1aG5TRHFzSURyaXFYdGxad2c3TFdjNjR5QUlPcXduT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPeWdoTzJabU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPdXdsT3EvZ09xNWpPeWFsRDhLQ2lNakl5RHJzS25yckxnZzdKaUk3Slc5N0oyMElPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnNLbnJyTGdnN0ppSTdKVzk3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEcnVZVHJzSURyc29qdG1MZ2dOZTJhakNEc21LVHJwWmpyb1p3ZzZyT0U3S0NWN0oyMElPeWVvT3E0aUNEc3NwanJwcXpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJRFh0bW93ZzdKNlk2NnE3SU95ZWhldWdwZTJWdE95RW5DRHFzNFRzb0pYc25iUWc3SjZnNnJLODdKYTA3SnFVTGlBdklPdTVoT3V3Z091eWlPMll1T3VsdkNEc25xenNoS1Rzb0pYdGxaanJxYlFnNjR1azdJdWNJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd0lDanNsNGJzbHJUc21wUWc0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFwQ2dvakl5TWc2N080N0oyNElPeWR1T3ltbmV5ZGhDRHRsWmpzcDRBZzdKV0s3Snk4NjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEcnM3anNuYmdnN0oyNDdLYWQ3SjJFSU8yVm1PdXB0Q0RycXFqcms2QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeWR0T3VwbE95ZHZDRHNuYmpzcHAwZzdLQ0U3SmVRNjRxVUlPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95ZHRPdXBsT3lkdkNEc25ianNwcDNzbllRZzY2ZUk3TG1ZNjZtMElPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95L29PMlBzT3lkZ0NEcm9aenF0N2pzbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjBJT3lnbk8yVm5PdVFxZXVMaU91THBDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXWTY2bTBJT3VxcU91VG9DRHF1TERyaXFYc25ZUWc3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzY3aVU2Nk9vN1lpczdJcWs2ckNBSU9xNnZPeWd1Q0Rzbm9qc2xyUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU91NGxPdWpxTzJJck95S3BPdWx2Q0Rzdkp6cnFiUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU91NWhPeURnU0RzbDdEcm5iM3NzcGpxc0lBZzY1T3g2NkdkNjVDWTdLZUFJT3lWaXV5Vm1PeUt0ZXVMaU91THBDNEtMU0RydVlUc2c0RWc3SmV3NjUyOTdMS1k2Nlc4SU91VHNldWhuZTJWbU91cHRDRHF1TFRxdUludGxhQWc2NVdNSU91NW9PdWx0T3F5akNEc2w3RHJuYjNyazV6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzdHB6c25vVWc3TG0wNjVPYzZyQ0FJT3VUc2V1aG5ldVFtT3luZ0NEc2xZcnNsWVFnN0lLczdKcXA3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdMYWM3SjZGSU95NXRPdVRuT3VsdkNEcms3SHJvWjN0bFpqcnFiUWc2N0NVNjZHY0lPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0lDanNtWVRybzR3ZzdKV0k2NEswS1FvS0l5TWpJTzJhak95YmtPcXdnT3llaGV5ZHRDRHNtWVRybzR6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzZyQ0E3SjZGN0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHNtSWpzbGIzc25iUWc3TGVvN0lhTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeVlpT3lWdmV5ZGhDRHN0NmpzaG96dGxvanNsclRzbXBRdUNnb2pJeU1nNjZ5NDdKMlk2ckNBSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SWljN0xDbzdLQ0I3Snk4NjZHY0lPdUx0ZXV6Z091VG5PdW1yT3F5b095S3RldUxpT3VMcEM0S0xTRHJyTGpzblpqcnBid2c3S0NSN0lpWTdaYUk3SmEwN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTA2NWFrSU91d3FldXlsZXljdk91aG5DRHNuYmpzcHAzdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SjI0N0thZElPdXdxZXV5bGV5ZGhDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPcXlzT3lnbk8yVm1PeUxwQ0RzdWJUcms1enJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rxc3JEc29KenRsYUFnN0xtMDY1T2M2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0p1UTdaV1k3SXVjNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsWmpzaExqc21wUXVDaTBnN0p1UTdaV1k2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWp2T3lHak91bHZDRHNsWXpxczZBZzZyT0U3SXVnNnJDQTdKcVVQd290SU95anZPeUdqT3VsdkNEc2xZenFzNkFnN0o2STY0S1k3SnFVUHdvS0l5TWpJeURycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQW9LSXlNaklPcTRzT3F3aENEcnA0enJvNHpyb1p3ZzdKMjA3SnFwN0oyMElPeWtrZXluZ091UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc25iVHNtcWtnNnJpdzZyQ0U3SjIwSU91Qm5ldUNtT3lFbkNEc3A0RHF1SWpzbllBZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0pxcDY1K0pJT3UyZ095aHNleWN2T3VobkNEc29JRHNucVhzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95Z2dPeWVwZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1Q2dvakl5TWc3WWExN0l1Z0lPeVlwT3VsbU91aG5DRHNtcFRzc3Ezc25iUWc3SXVrN1l5bzdaV1k3SmlBN0lxMTY0dUk2NHVrTGdvdElPMkd0ZXlMb095ZHRDRHNtNUR0bVp6dGxaanNwNEFnN0pXSzdKV0VJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95anZPeUdqT3VsdkNEdG1aWHNuYmp0bFpqcXNiRHJncGdnN1ptSTdKeTg2NkdjSU95ZHRPdVBtZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjQrWjdKMjg3WldjSU95YWxPeXlyZXlkdENEc3NwanJwcXdnN0tTUjdKNkY2NHVJNjR1a0xpRHNucURzaTV3ZzdadUVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc2ckNaN0oyQUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanFzNkFnN0o2STdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYlRyc3FUdGlyanFzSUFnN0tLRjY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdE91eXBPMkt1T3F3Z0NEcmdaM3JncXpzbHJUc21wUXVDZ29qSXlNZzdZT0k3WWUwSU95TG5DRHJxcWpyazZBZzY0Mnc3SjIwN1lTdzZyQ0FJT3lDcmV5Z25PdVFtT3Vwc0NEcnM3WHF0YXp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHRnNGp0aDdUdGxaanJxYlFnNjZxbzY1T2dJT3VOc095ZHRPMkVzT3F3Z0NEc2dxM3NvSnpya0pqcXM2QWc2NHVrN0l1Y0lPdVFtT3VQak91bXRDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWdsZXVua0NEdGc0anRoN1R0bGFEcXVZenNtcFEvQ2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3lEZ2UyWnFTRHNsWWpyZ3JRcENnb2pJeU1nNjdhQTdKNnNJT3lra1NEcnNLbnJyTGpzbnBEcXNJQWc2ckNRN0tlQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTJnT3llckNEc3BKSHNsNUFnNjdDcDY2eTQ3SjZRNnJDQUlPeWVpT3lYaU95V3RPeWFsQzRnTHlEc21JSHNnNEhzbllRZzdabVY3SjI0N1pXMElPdXp0T3lFdU95YWxDNEtDaU1qSXlEcXNyM3J1WVFnN1pXMDdLQ2NJT3Eyak8yVm5PeWR0Q0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cks5NjdtRUlPMlZ0T3lnbkNEcXRvenRsWnpzbmJRZzdaV0U3SnFVN1pXMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RzbXBUc3NxM3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRtSnp0ZzUwZzdKZUc3SjIwSU9xd2dPeWVoZTJWb09xNWpPeWFsRDhnN0tlQTZyaUlJT3lMb095eXJlMlZtT3luZ0NEc2xZcnNuTHpycWJRZzdKdXc3THUwSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzcDREcXVJZ2c3SXVnN0xLdDdaV1k2Nm0wSU95YnNPeTd0Q0R0bUp6dGc1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0wrZzdZK3dJT3lYaHV5ZHRDRHFzckRzb0p6dGxhRHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1Q0RzdjZEdGo3RHNuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUNpMGc3TCtnN1krdzdKMkVJT3V3bSt5Y3ZPdXB0Q0RyalpRZzdLQ0E2NkMwN1pXWTZyS01JT3F5c095Z25PMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95VmpPdW12Q0RzbDRic25iUWc3SXVjN0o2UjdaV2c2cm1NN0pxVVB5RHNsWXpycHJ6c25ZUWc3THljN0tlQUlPeVZpdXljdk91cHRDRHNwSkhzbXBUdGxad2c3SWFNN0l1ZDdKMkVJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPeVZqT3Vtdk95ZGhDRHN2SnpycWJRZzdLU1I3SnFVN1pXY0lPeUdqT3lMbmV5ZGhDRHJzSlRyb1p3ZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdKNlE2NCtaN0oyMDdMSzA2Nlc4SU91VHNldWhuZTJWbU95bmdDRHNsWXJxczZBZzY0U1k3SmEwNnJDSTZybU03SnFVUHlEcms3SHJvWjN0bFpqc3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNucERyajVuc25iVHNzclRycGJ3ZzY1T3g2NkdkN1pXWTY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURyczdnZzZyT0U3Slc5N0oyWUlPeWNvT3lkdk8yVm5DRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95ZHZPdXdtT3EwZ091bXJPeWVrT3VobkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0nCkI2NF9HVUlERT0nSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5Bb0tJeU1nTVM0ZzdaVzA3SnFVN0xLMENncnNvSnp0a29nZzdKV0k3SjJZSU91cXFPdVRvQ0RyckxqcXRhenJpcFFnSisyVnRPeWFsT3l5dENmcm9ad2c3STJvN0pxVUxncnNuYnpxdElEc2hMRWc3SjZJNjRxVUlPeUNyT3lhcWV5ZWtDRHFzcjN0bDVqc25ZUWc2NmVNNjVPa0lPeUltQ0Rzbm9qcmo0VHJvWjBnS2lyc2c0SHRtYWtzSU91bnBldWR2ZXlkaENEcnRvanJyTGp0bFpqcXM2QWc2NnFvNjVPZ0lPdXN1T3Exck95WGtDRHRsYlRzbXBUc3NyVHJwYndnN0tDQjdKcXA3WlcwN0tPODdJUzQ3SnFVTGlvcUNncnNtSWdwQ2kwZzY3TzA2NE9GNjR1STY0dWtJT0tHa2lEcnM3VHJncnpxc296c21wUUtDaW9xS2dvS0l5TWdNaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0FvSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEc3RaenJqSUR0bFp3Z0tpcnJpcVhyajVudG1KVWc2Nnk0N0o2bEtpcnNuWVFnN0kybzdLTzg3SVM0N0pxVUxpRHNpSmpyajVudG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExURXQ3SWlZNjQrWjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNrN0RyaXBRZzZyS01JT3lpaSt5VmhPeWFsQzRLQ2lNakl5RHJrSkRzbHJUc21wUWc0b2FTSU8yV2lPeVd0T3lhbEFvSzdKaUlLUW90SU95RXBPeWdsZXVRa095V3RPeWFsQ0RpaHBJZzdJU2s3S0NWN1phSTdKYTA3SnFVQ2dvakl5TWdKMzdzbDRnbklPdTV2T3E0c0FvSzdKaUlLUW90SU91d2xPdUFqT3lYaU95V3RPeWFsQ0RpaHBJZzY3Q1U2citvN0phMDdKcVVDZ29qSXlNZzY0K1o3SUtzSU91d2xPcS9sT3lUc09xNHNBb0s3SmlJS1FvdElPdUdrdXlWaE95aGpPeVd0T3lhbENEaWhwSWc3SmlzNjU2UTdKYTA3SnFVQ2dvcUtpb0tDaU1qSURNdUlPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQUtDdXlnbk8yU2lDRHNsWWpzbDVEc2hKd2c2N2FBN0tDVjdLQ0JJT3k3cE91dXBPdUxpT3k4Z095ZHRPeUZtT3lkaENEc3RaenJqSUR0bFp3ZzdLU0U3SjIwNnJPZ0lPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvN0tPODdJUzQ3SnFVTGdycnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRNdDY3YUE3S0NWN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2phanNtcFF1Q2dyc21JZ2dPaURzbFlnZzY0Kzg3SnFVTENEc2w0YnNsclRzbXBRZ0tGZ3BJT0tHa2lCKzdaV1k2Nm0wSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVSUNoUEtRb0tJeU1qSU95WGh1eVd0T3lhbENEaWhwSWc3SjZJN0phMDdKcVVDZ3JzbUlncENpMGc2N08wN1ppNDdKNlE2ckNBSU8yWGlPdWR2ZTJWbU9xNHNDRHNvSVRzbDVEcmlwUWc2ckNBN0o2RjdaV2dJT3lJbUNEc2w0YnNsclRzbXBRZzRvYVNJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRS0NpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFDZ3JzbDVEcm42d2c3SU9CN1ptcDdKZVE3SVNjNjQrRUlDTHRsYlRxc3JBZzY3Q3A2N0tWSXV5ZGhDRHJxTHpzb0lBZzdKV002NkNrN0tPODY0cVVJT3E0amV5Z2xlMllsU0RxdGF6c29iRHJvWndnN0kybzdKcVVMZ29LN0ppSUtRb3RJT3luZ09xNGlDRHJzb1Rzb0lUc2w1RHNoSnpyaXBRZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeVZzZXlkaENEc3RaenNpNkFnNjdLRTdLQ0U3Snk4NjZHY0lPeVhoZXVOc095ZHRPMkt1Q0R0bGJUc283enNoTGpzbXBRdUlPS0draURzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMDdLTzg3SVM0N0pxVUxpRHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2pvNk9pQjBhWEFnNjR1azdKMjA3SmE4NjZHYzZyZTRJT3ladk95cXZTRHJzb1R0aXJ6c25ZQWdXK3VMcStxNHNGMEs2NHVrN0oyMDdKYTg2NkdjNnJlNElPeVp2T3lxdlNEcnNvVHRpcnpzbllBZ0tpcnJpNnZxdUxBcUt1dWhuQ0RyckxqcXRhenJwYndnN1lhMTdKMjg3WlcwN0pxVUxpQXFLdXkzcU95R2pDb3E2NHFVSU95Q3JPeWFxZXlla09xd2dDRHRsWmpxczZBZzdKNkk2NHFVSU95ZWtleVhoZXlkdENEc3Q2anNob3pya0p6cmk2VHFzNkFnN0ppazdaVzA3WldnSU95SW1DRHNub2pzbHJRZzdKT3c3S2VBSU95Vml1eVZoT3lhbEM0S09qbzZDZ29qSXlNZzdaaWM3WU9kN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0oyRUlPdVZqQW9LN0ppSUtRb3RJT3VxcU95ZWhPeW5nT3lia09xNGlDRHNsNGJzbmJRZzY2cW83SjZFN1lhMTdKNmw3SjJFSU91bmpPdVRwT3E1ak95YWxEOGc3S2VBNnJpSUlPdXdtK3luZ0NEc2xZcnNuTHpycWJRZzY2cW83SjZFN0tlQTdKdVE2cmlJN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMaURpaHBJZzdKVzk2clNBN0plUUlPdVBtZXlkbU8yVm1PdXB0Q0RycXFqc25vVHNwNERzbTVEcXVJanNuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN1ppYzdZT2RJT3VNZ095RGdTRHNsWWpyZ3JRS0Npb3E3SVNjNjdtRTdJcWs2NHFVSU95VHVDRHNpSmdnN0o2STdLZUE2NmVNTENEdGlybnNvSlVnN1ppYzdZT2Q3SjJBSU91d20reWRoQ0RzaUpnZzdKZUc3SjJFSU91VmpDRGlocElnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXljdk91aG5DRHNqYWpzbXBRdUtpb0s3SUtzN0pxcDdKNlE2NHFVSU91c3VPcTFyT3VsdkNEcXZMenF2THp0bm9nZzdKMjk3S2VBSU95Vml1cXpvQ0R0bTVIc2xyVHJzN1RxdUxBbzdJcWs3THFVS1NEcmxZenJyTGpzbDVBc0lPdTJnT3lnbGUyWWxleWN2T3VobkNEc2s3RHJxYlFnN0tDYzdaS0lJT3lnaE95eXRPdWx2Q0RzazdnZzdJaVlJT3lYaHV1THBPcXpvQ0RzbUtUdGxiVHRsWmpxdUxBZzdJbXM3SnVNN0pxVUxnb0s3SmlJS1FvdElPcXpoT3lpakNEcXNKenNoS1FnN1ppYzdZT2Q3SjJBSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnTkM0MUpTRHF1SWpycHF3ZzdaaWM3WU9kNjZlTUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZ29LS2lvcUNnb2pJeUEwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phMENncnNvSnp0a29nZzdKV0k3SmVRN0lTY0lDZCs3SXVjNnJLZzdKYTA3SnFVUHljc0lDZnNpNXpyZ3Bqc21wUS9KeXdnSjM3cXU1Z25JT3F3bWV5ZGdDRHFzN3pyajRUdGxad2c2cks5N0phMDY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVDdXkxbk91TWdPMlZuQ0RzdXBEc283enNscnp0bFpqcXM2QWc3TG1jNnJlODdaV2NJT3Vua08ySXJPdWx2Q0RzazdEcmlwUWc2cktNSU95aWkreVZoT3lhbEM0SzZySzk3SmEwNjRxVUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRJdDZySzk3SmEwNjZXOExleU5xT3VQaEMzcmtKanJpcFF0NnJLOTdKcXdLZXlYa0NEdGxiVHJpN250bGFBZzY1V002NmVNSU95TnFPeWFsQzRLQ2lNakl5RHJqNW5zZ3F6c2w1RHNoSndnSjM3c2k1d25JT3U1dk9xNHNBb0s3SmlJS1FvdElPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvSU9LR2tpRHN1YlRyazV6cnBid2c3WlcwN0tlQTdaV2c2cm1NN0pxVVB3b3RJT3lMbk95ZWtlMlZtT3lMbk91S2xDRHJ0b1RzbDVEcXNvd2dOU3d3TUREc201RHNuWVFnNjVPYzY2Q2s3SnFVTGlEaWhwSWc3SXVjN0o2UjdaV1k2Nm0wSURVc01EQXc3SnVRN0oyRUlPdVRuT3VncE95YWxDNEtDaU1qSXlBbjZyT0U3SXVjNjR1a0p5RGlocElnSit5ZWlPdUxwQ2NLQ3V5WWlDa0tMU0RzbnBEcmo1bnNzS2pycGJ3ZzZyQ0E3S2VBNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhnNG9hU0lPeWVrT3VQbWV5d3FPcXdnQ0Rzbm9qcmdwanNtcFEvQ2kwZzY2ZWs2NHVzSU91enRPMlhtT3VqakNEc2xyenJwNGpzbEtrZzY0SzA2ck9nSU9xemhPeUxuT3VDbU95YWxEOGc0b2FTSU91bnBPdUxyQ0RyczdUdGw1anJvNHpyaXBRZzdKYTg2NmVJN0oyNDZyQ0E3SnFVUHlBcUtPdUxxT3lJbkNEc3VaanRtWmpzbmJRZzdKV0U2NHVJNjUyOElPdXN1T3llcGV5ZGhDRHNnNGpyb1p3ZzdKTzBJT3lDck91aGdPeVlpT3lhbENrcUNnb2pJeU1nSit5WHJPeXRpT3VMcENjZzRvYVNJQ2Z0bVpYc25ianRsWmpyaTZRc0lPdXN1K3VMcENjS0N1eVlpQ2tLTFNEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvZnFzSURzcDRBZzY0dWs3SXVjSU95WHJPeXRwT3V6dk9xeWpPeWFsQzRnNG9hU0lPeVZpT3lnaE8yVm5DRHFzSnp0aHJYc25ZUWc3SnlFN1pXMElPdXFoK3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJQ2ZxdTVnbklPS0draUFuN0plUTZyS01Kd29LN0ppSUtRb3RJTzJaamVxNHVPdVBtZXVMbU9xN21DRHJncURzbFlUcXNJRHFzNkFnN0o2STdKYTA3SnFVTGlEaWhwSWc3Wm1ONnJpNDY0K1o2NHVZN0plUTZyS01JT3VDb095VmhPcXdnT3F6b0NEc25vanNsclRzbXBRdUNnb2pJeU1nNnJLOTdKYTA2Nlc4SU91NmtPeWRoQ0RybFl3ZzdKYTA3SU9KN1pXY0lPcXl2ZXlhc0FvSzdJS3M3SnFwN0o2UTdKMllJT3lnbGV1enRPdWx2Q0Ryc0p2cmlwUWc3S2VJNjZ5NDdKZVE3SVNjSU9xNHNPcXpoT3lnZ2V5Y3ZPdWhuQ0FuZnV5TG5DZnJwYndnNjdxUTdKMkVJT3VWakNEcnJManNucVhzbmJRZzdKYTA3SU9KN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2lvcTdZeU03SldGN1pXWTZyT2dJT3lMdHV5ZGdDRHNvSlhyczdUcnBid2dKK3lqdk95V3RDZnJvWndnN0kybzdJU2NJT3VzdU95ZXBleWRoQ0RzZzRqcm9hM3Fzb3dnN0kybzY3TzA3SVM0N0pxVUxpb3FDZ3JzbUlncENpMGc3SmEwNjVha0lPdXFxZXlnZ2V5Y3ZPdWhuQ0RyaklEc3RwenJzSnZzbkx6c2k1enJncGpzbXBRL0lPS0draURyaklEc3Rwd2c2NnFwN0tDQjdKMjBJT3VzdE95WGgreWR1T3F3Z095YWxEOEtMU0RzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhnNG9hU0lPeUxvT3F6b0NEc25iVHNuS0RycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lFdU95YWxDNEtDaW9xS2dvS0l5TWdOUzRnSjN2cnFvWHNncXg5SUNzZ2UrdXFoZXlDckgwbklPeVRzT3luZ0NEc2xZcnF1TEFLQ2lNakl5RHRsWnpzbnBEc2xyUWc3WktBN0phMDdKT3c2cml3Q2dydGxaenNucERzbHJRZzY2cUY3SUtzNjZXOElPMlNnT3lXdE95RW5DRHJqNW5zZ3F3ZzdaaVY3WU9jNjZHY0lPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1FvdElPeWR0T3lla0NEdG1aanJ0b2pzbllRZzY3Q2I3SldZN0phMDdKcVVJT0tHa2lEc25iVHNucERycGJ3ZzY0K002NkNrNjdDYjdKV1k3SmEwN0pxVUNpMGc2NEswN0oyOElPeTV0T3VUbk9xd2t1eWR0Q0Rxc3JEc29KenJrS0FnN0ppSTdLQ1Y3SjIwN0plUTdKcVVJT0tHa2lEcmdyVHNuYnpzbllBZzdMbTA2NU9jNnJDU0lPdUNtT3F3Z091S2xDRHJncURzbmJUc2w1RHNtcFFLQ2lNakl5RHRsWnpzbnBEc2xyVHJwYndnN1pLQTdKYTA3Sk93NnJpd0lPeVd0T3VncE95YXVDRHFzcjNzbXJBS0NpZDc2NnFGN0lLc2ZlcXdnQ0I3NjZxRjdJS3NmZTJWdE95RW5DY2c3WmlWN1lPYzY2R2M2NmVNSU8yU2dPeVd0T3lrbU91UGhDRHJqWlFnN0xxUTdLTzg3SmE4N1pXWTZyS01JT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LN0ppSUtRb3RJT3llbE95Vm9TRHJ0b0Rzb2JIc25MenJvWndnNnJXczY2ZWs3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQ0RpaHBJZzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDZ29xS2lvS0NpTWpJRFl1SU8yUm5PcTRzQ0R0aHJYc25id0tDaU1qSXlEcmtKanNsclRzbXBRZ0tGZ3BJT0tHa2lEcmo3enNtcFFnS0U4cENncnJxcWpyc0pUc25id2c3Wm1VNjZtMDdKMllJT3lpZ2V5ZGdDRHFzN1hxc0lUc25ZUWc2ck9nNjZDazdaVzBJQ2Zya0pqc2xyVHNtcFFuNjRxVUlPdXFxT3VSa0NBbjY0Kzg3SnFVSit1aG5DRHRoclhzbmJ6dGxiVHNoSndnN0kybzdLTzg3SVM0N0pxVUxnb0tLaW9xQ2dvakl5QTNMaURyZ3FEc3A1ekN0K3lMbk9xd2hNSzM3SWlyN0o2UUlPMlJuT3E0c0FvSzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt1eWlPMll1T3VLbENEc2xZVHJucGdnN1ppVjdJdWQ3Snk4NjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc21wUXVDZ29qSXlNZzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCtxNHNPcXdoQW9LZkNEdGxhM3JxcWtnZkNEdG1KWHNpNTBnZkNEc21JanNpNXdnZkFwOExTMHRMUzB0ZkMwdExTMHRMWHd0TFMwdExTMThDbndnNjRLZzdLZWNJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1RVMHVSRVJnSUh3Z01qQXlOUzR3TVM0d01Td2dNalV1TURFdU1ERWdmQXA4SU95TG5PcXdoQ0I4SU9xNHNPdXp1Q0JnU0VnNlRVMDZVMU5nSUM4ZzdLZW42cktNSUdCSVNEcE5UV0FnS095WXBPeWdoQy9zbUtUdG00UWc3SldJSU95VWdDa2dmQ0F4TkRvek1Eb3hNU3dnTVRNNk16QWdmQXA4SU9xNHNPcXdoQ0I4SU9xNHNPdXp1Q0JnV1ZsWldTNU5UUzVFUkg1WldWbFpMazFOTGtSRVlDQXZJT3lucCtxeWpDQmdXVmxaV1M1TlRTNUVSSDVOVFM1RVJHQWdmQ0F5TURJMUxqQXhMakF4ZmpJd01qVXVNREV1TXpFc0lESXdNalV1TURFdU1ERitNREV1TXpFZ2ZBcDhJT3VDb095bm5DQXJJT3lMbk9xd2hDQjhJR0JaV1ZsWkxrMU5Ma1JFSUVoSU9rMU5ZQ0I4SURJd01qVXVNREV1TURFZ01UUTZNekFnZkFwOElPeWFsT3lkdkNCOElHQlpXVmxaTGsxTkxrUkVLT3lhbE95ZHZDbGdJT0tBbENEc201UXY3Wm1VTCt5SW1DL3JxcWt2NnJpSUwrMkdvQy9zbmJ3Z2ZDQXlNREkxTGpBeExqQXhLT3lJbUNrZ2ZBb0tLaXJzaTV6cXNJUWc3SmlJN0ptNEtpbzZJT3lDck95YXFleWVrT3F3Z0NEc3A0SHNvSkVnNnJPZzY2VzA2NHFVSU91d3FldXN1TUszN0ppSTdKVzlJT3lMbk9xd2hPeWRnQ0JnN0ppazdLQ0VMK3lZcE8yYmhDQklPazFOWU95ZGhDRHNqYWpyajRRZzY0Kzg3SnFVTGdyc21JZ3BJT3lZcE8yYmhDQXhPakF3Q2dvakl5TWc2Nnk0N0o2bElPeUdqU0RzbDdEc201VHNuYndLQ3V1c3VPeWVwU0RzbFlqc2w1RHNoSnpyaXBRZ0tpcnNtNVRDdCt5ZHZDRHNsWjdzblpnZ01PeWRoQ0RydWJ6cXM2QXFLaURzamFqc21wUXVDZ3JzbUlncENpMGdNakF5TnV1RmhDQXdPT3libENBd05leWR2Q0Rzbm9Ycmk0anJpNlF1SU9LR2tpQXlNREkyNjRXRUlEanNtNVFnTmV5ZHZDRHNub1hyaTRqcmk2UXVDZ29qSXlNZzdJT0I2NHlBSU95TG5PcXdoQ0FvNjRXNDdMYWM3SnFwS1FvS2ZDRHNvYkRxc2JRZ2ZDRHRrWnpxdUxBZ2ZBcDhMUzB0TFMwdGZDMHRMUzB0TFh3S2ZDQTJNT3kwaUNEcnI3anJwNHdnZkNEcnNLbnF1SWdnN0tDRUlId0tmQ0EyTU91MmhDRHJyN2pycDR3Z2ZDQk82N2FFSU95Z2hDQjhDbndnTWpUc2k1enFzSVFnNjYrNDY2ZU1JSHdnVHV5TG5PcXdoQ0Rzb0lRZ2ZBcDhJRE13N0oyOElPdXZ1T3VuakNCOElFN3NuYndnN0tDRUlId0tmQ0F4TXVxd25PeWJsQ0RycjdqcnA0d2dmQ0JPNnJDYzdKdVVJT3lnaENCOENud2dNVExxc0p6c201UWc3SjIwN0lPQklId2dUdXVGaENEc29JUWdmQW9LN0ppSUtTRHJzS25xdUlnZzdLQ0VMQ0ExNjdhRUlPeWdoQ3dnTXV5TG5PcXdoQ0Rzb0lRc0lEUHNuYndnN0tDRUxDQTI2ckNjN0p1VUlPeWdoQ3dnTXV1RmhDRHNvSVFLQ2lNakl5RHJwNGpxc0pEQ3QrcTRzT3F3aENEcnA0enJvNHdLQ21CRUxVNWdLRTdzbmJ3ZzY0S283SjJNS1NBdklHQkVMVEJnS095WXBPdUttQ0RycDRqcXNKQXBJQzhnWUVRclRtQW9UdXlkdkNEcXNyM3FzN3dwQ3V5WWlDa2dSQzAzTENCRUxURXNJRVF0TUN3Z1JDc3hDZ29qSXlNZzY3S0k3Wmk0SU8yUm5PcTRzQ0FvN1pXWTdKMjA3WlNJN0p5ODY2R2NJT3Exck91MmhDa0tDbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdLZkMwdExTMHRMWHd0TFMwdExTMThMUzB0TFMwdGZBcDhJT3lnaE8yWmxPdXlpTzJZdUNCOElPMlZtT3lkdE8yVWlDRHF0YXpydG9RZ2ZDQXdNaTB4TWpNMExUVTJOemdzSURBeE1DMHhNak0wTFRVMk56Z2dmQXA4SU95NXRPdVRuT3V5aU8yWXVDQjhJRFRzbnBEcnBxenNsS2tnN1pXWTdKMjA3WlNJSUh3Z01USXpOQzAxTmpjNExUa3dNVEl0TXpRMU5pQjhDbndnNnJPRTdLS002N0tJN1ppNElId2c3WldZN0oyMDdaU0lJT3Exck91MmhDQjhJREV5TXkwME5UWXROemc1TURFeUlId0tmQ0Rzbzd6cnI3enJrN0hyb1ozcnNvanRtTGdnZkNEc2xaNGdOdXlla091bXJDM3JrcVFnTit5ZWtPdW1yQ0I4SURFeU16UTFOaTB4TWpNME5UWTNJSHdLZkNEc2dxenNsNFhzbnBEcms3SHJvWjNyc29qdG1MZ2dmQ0F4TU95ZWtPdW1yQ0R0bFpqc25iVHRsSWdnZkNBd01TMHlNelF0TlRZM09Ea2dmQW9LSXlNaklPeVRzT3VwdENEc2xZZ2c2NUNZNjRxVUlPMlJuT3E0c0FvS0xTRHJncURzcDV6c2w1QWc3WldZN0oyMDdaU0l3cmZydVpmcXVJZzZJT0tkakNBeU1ESTFMVEF4TFRBeExDQXdNUzh3TVFvdElPeUxuT3F3aE95WGtDRHNtS1Rzb0lRdjdKaWs3WnVFT2lEaW5Zd2c3SmlrN0tDRUlESHNpNXdnS2lqcmk2Z3NJT3lDck95YXFleWVrT3F3Z0NEc3A0SHNvSkVnNnJPZzY2VzA2NHFVSU91d3FldXN1TUszN0ppSTdKVzlJT3lMbk9xd2hPeWRnQ0RzbUlqc21iZ3BLZ29LS2lvcUNnb2pJT3lZaU95WnVDRHF0NXpzdVprS0N1eWJrT3k1bVNqcmlxWHJqNW5DdCtxNGpleWdsY0szN0xxUTdLTzg3SmE4S2V1enRPdUxwQ0RzbUlqc21ianFzSUFnNjQyVUlPdXFoZTJabGUyVm5DRHN1NlRycnFUcmk0anN2SURzbmJUc2haanNuWVFnNjZlTTY1T2M2NHFVSU9xeXZleWFzT3lZaU95YWxDNEtDaU1qSU95WWlPeVp1Q0F4TGlEc2lKanJqNW50bUpVZzY2eTQ3SjZsN0oyRUlPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdDZ29qSXlNZzdJU2M2N21FN0lxa0lPeWloZXVqakN3ZzZyaXc2ckNFSU91bmpPdWpqQW9LN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lUc091cHRDRHNvN3pzbHJRbzdLS0Y2Nk9NSU95RW5PdTVoT3lLcEN3ZzZyaXc2ckNFSU91VHNTbnJwYndnNnJDVjdLR3c3WldnSU95SW1DRHNub2pxczZBc0lDZnNvb1hybzR3bjdKbUFJQ2ZycDR6cm80d243SjJZSU91Sm1PeVZtZXlLcE91bHZDRHNvSlh0bVpYdG5vZ2c3S0NFNjR1czdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZ1QwOVBJT3lFbk91NWhPeUtwQ0Rzb29Ycm80d2c3SldJNjRLMElPS0FsQ0F3TU95YmxDQXdNT3lkdk91MmdPMkVzQ0RzaEp6cnVZVHNpcVRxc0lBZzdLS0Y2Nk9NNjQrODdKcVVMaURzbnBEc2hManRsWndnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3VUbk91Z3BPeWFsQzRLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZ29LNjR1b0xDQXFLdXlqdk9xNHNPeWdnZXljdk91aG5DRHNvb1hybzR6cXNJQWc2N0NZNjdPMTY1Q1k2NHFVSU95Z25PMlNpQ29xN0plUTY0cVVJQ2Zzb29Ycm80enJqN3pzbXBRbjY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVDZ3JzbUlncENpMGc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVJT0tHa2lEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURyZ1ozcmdwanNtcFFLQ2lNakl5RHNncXpzbXFuc25wRHNsNURxc293ZzY2KzQ3TG1ZNjRxVUlPeVlnZTJXcGV5ZGhDRHNsWXpyb0tUc3BJUWc2NVdNQ2dvbzdLTzg3SnFVSU91UG1leUNyQ0E2SU95WHNPeXl0Q3dnN1pXMDdLZUFMQ0Rzb0lIc21xa2c2NU94S1FvSzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VHNPdXB0Q0RzbmJqcXM3d2c2clNBNnJPRTY2VzhJT3VxaGUyWmxlMlZtT3F5akNEc2hLVHJxb1h0bFpqcXM2QXNJQ2ZzZ3F6c21xbnNucERzblpnZzdaYUo2NCtaN0plUUlPdVVzT3Vkdk95WXBPdUtsQ0Rxc3JEcXM3d242NTI4NjRxVUlPeWdrT3lkaENEc2xZenJvS1RzcElRZzdJaVlJT3llaU95V3RPeWFsQzRLQ3V5WWlDa0tMU0RzbUtUcmlwanF1WXpzcDRBZzY0SzA3S2VBSU95Vml1eWN2T3VwdENEc2w3RHNzclRyajd6c21wUXVJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ290SU91TWdPeTJuT3lkaENEcXNJanNsWVR0ZzREcnFiUWc3SnVRNjU2WUlPdU1nT3kybk95ZHRDRHRsYlRzcDREcmo3enNtcFF1SU95WXBPdUttQ0RyZ3FEc3A1enF1WXpzcDREc25aZ2c3SjIwN0o2UTY2VzhJT3lkZ08yV2lleVhrQ0RyZ3JUc2xid2c3WlcwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS095SW1PdVBtZTJZbFNrS0NpZnNvSlhyczdRZzdJaVk3S2VSSU95VmlPdUN0Q2NnNjVPeDdKMllJT3V2dk9xd2tPMlZuQ0RzZzRIdG1hbnNsNURzaEp3Z0tpcnNpNXpzaXFUdGhaenNuYlFnN0o2UTY0K1o3Snk4NjZHY0lPeXltT3Vtck8yVm5PdUxwT3VLbENEc29KQXFLdXlkaENEc2lKanJqNW50bUpYc25MenJvWndnN0pXTTY2Q2tJT3lDck95YXFleWVrT3VsdkNEc2xZanNpNnp0bFpqcXNvd2c3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ3JzbUlncENpMGc3SjIwN0tDYzY3YUE3WVN3SU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkdENEcXVMRHJvWjNyajd6c21wUUtMU0RyalpRZzdLS0w3SjJBSU95RGdldUx0T3lkaENEc25JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWRnQ0RyaGJuc25ZenJqN3pzbXBRS0NpTWpJT3lZaU95WnVDQXlMaURxc3Izc2xyVHJwYndnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBS0N1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla095ZG1DRHJwNlhybmIzc25ZUWc3Wm1jN0pxcDdaVzA3SVNjSU95bmlPdXN1TzJWb0NEcmxZd0tDaWZzaTV6cmdwanNtcFEvSnl3Z0oreUZxT3VDbU95YWxEOG5JTzJZbGUyRG5PeWRtQ0Rxc3Izc2xyVHJwYndnN1ptYzdKcXA3WlcwN0lTY0lPeUNyT3lhcWV5ZWtPeWRtQ0RyaTdudG1hbnNpcVRybjZ6c200RHNuWVFnN0tTRTdKMjhJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdabU42cmk0NjQrWjY0dVlMQ0JQVDA4ZzY0dWs2NFdBN0ppazdJV282NEtZN0pxVVB3b3RJT3kycWV5Z2hPMlZtT3VmckNEdGpyanNuWmpzb0pBZzZyQ0E3SXVjNjRLWTdKcVVQd29LSXlNaklPeUNyT3lhcWV5ZWtPeWRtQ0RzZzRIdG1hbnNuWVFnN0xhVTdLQ1Y3WldnSU91VmpBb0s2NnFGN1ptVjdaV2NJT3lnbGV1enRPcXdnQ0RzbDRic2xyVHNoSndnN0lLczdKcXA3SjZRN0plUTZyS01JT3luZ2V5Z2tTRHRqSkRyaTZqdGxaanFzb3dnN1pXMDdKVzhJTzJWb0NEcmxZd2c2cks5N0phMDY2R2NJT3lnbGV5a2tlMlZtT3F5akNEc3A0anJyTGp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ3V5WWlDa0tMU0RzdWJUcms1enJwYndnNjdDYjdKeTg3SVdvNjRLWTdKcVVQeURyazdIcm9aM3RsWmpycWJRZzdMcVE3SXVjNjdDeElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNncXpzbXFuc25wRHNuWmdnN0lTZzdKMlk2ckNBSU8yVmhPeWFsTzJWb0NEcmxZd0tDdXlFcE91c3VPeWhzT3lDck95eW1PdWZ2Q0RzZ3F6c21xbnNucERzblpnZzdJU2c3SjJZNjZXOElPcTRzT3VNZ08yVnRPeVZ2Q0R0bGFBZzY1V01JT3F5dmV5V3RPdWhuQ0Rzb0pYc3BKSHRsWmpxc293ZzdLZUk2Nnk0N1pXMDdKcVVMZ29LN0ppSUtRb3RJT3lkdE91eWlDRHJpNnpzbDVBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZtT3VwdE95RW5DRHNscnpycDRqcmdwZ2c2NmVNN0tHeDdaV1k3SVdvNjRLWTdKcVVQd29LSXlNZzdKaUk3Sm00SURNdUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPdVFtT3VLbENEcXNyM3NtckFLQ3V5Q3JPeWFxZXlla095WGtPcXlqQ0RycW9YdG1aWHRsWmpxc293ZzY3YUE3S0NWN0tDQjdKMjRJT3VDdE95YXFleWRoQ0RzbFl6cm9LVHNwSmpzbGJ3ZzdaV2dJT3VWak91S2xDRHJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkVJT3lOcU91UGhDRHNvb3ZzbFlUc21wUXVDZ29qSXlNZzdJU2M2N21FN0lxazY2VzhJT3lnbGV5eGhleURnU0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdLQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeURnZTJacWV5ZGhDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3SXVjN1lLc0lPeUltQ0Rzbm9qc2xyVHNtcFF1SUNvcTdKTzRJT3lJbUNEc2w0YnJpcFFnN0oyMDdKeWc2Nlc4SU8yVnFPcTdtQ0RzbFlqcmdyVHRsYlRzbzd6c2hManNtcFF1S2lvS0N1eVlpQ2tLTFNEc3A0RHF1SWpzbllBZzZyQ0E3SjZGN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SU95eXJleUdqT3VGaE95ZGhDRHNuSVR0bFp3ZzdJU2M2N21FN0lxazY0cVVJT3lWaE95bmdTRHNwSURydVlRZzdLU1I3SjIwN0plUTdKcVVMZ290SU9xenRldXN0T3lia095ZGdDRHRtNFRzbTVEcXVJanNuWVFnNjdPMDY0SzhJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdLQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE2ckNBSU95V3RPdVdwQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0RzbDRicmlwVHNwNEFnNjZxRjdabVY3WldZNnJLTUlPeWR1T3luZ08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SU95Z2tPcXlnQ0RxdUxEcXNJUWc2NCtaN0pXSUlPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsYUFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUNyT3lhcWV5ZWtDRHNoS0R0ZzUzc25aZ2c2ckt3NnJPODY2VzhJT3lWaU91Q3RPMlZvQ0RybFl3S0N1dVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3lFb08yRG5leWRnQ0RydG9Ec29KWHRtSlhzbkx6cm9ad2c2NnFGN1ptVjdaV1k2cktNSU95VmpPdWdwT3lhbEM0S0N1eVlpQ2tLTFNEdGxad2c2N0tJSU91d2xPcSt1T3VwdENEc3VwRHNpNXpyc0xIc25ZQWc2NHVrN0l1Y0lPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUNyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPdTJnT3lnbGUyWWxTa0tDaWZzb0pYcnM3UWc3SWlZN0tlUklPeVZpT3VDdENjZzY1T3g3SjJZSU91dnZPcXdrTzJWbkNEc2c0SHRtYW5zbDVEc2hKd2dLaXJzb0pYcnM3VHFzSUFnNjdPMDdaaTQ2NUNjNjR1azY0cVVJT3lna0NvcTdKMkVJT3UyZ095Z2xlMllsZXljdk91aG5DRHNsWXpyb0tRZzdJS3M3SnFwN0o2UTY2VzhJT3lWaU95THJPMlZtT3F5akNEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0N1eVlpQ2tLTFNEc2c0SHJpN1RzbmJRZzY0R2Q2NEtZNjZtMElPeWdoT3VzdU9xd2dPdVBoQ0R0bVkzcXVManJqNW5yaTVqc25aZ2c3S0NWNjdPMDY2VzhJT3V6dkNEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHFzSUFnNnJpdzY2R2Q2NUNZN0tlQUlPeVZpdXlWaE95YWxDNEtDaU1qSU95WWlPeVp1Q0EwTGlEc29KenRrb2dnN0pxcDdKYTA2NHFVSU91d2xPcSt1T3luZ0NEc2xZcnF1TEFLQ2lmcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ2NnN0p1UTdMbVo2N08wNjR1a0lDb3E3Wm1VNjZtMDdKMllJT3E0c091S3BldXFoY0szNjdLRTdZcTg2NnFGNnJPODdKMllJT3lhcWV5V3RDRHNuYnpzdVpncUt1cXdnQ0RzbXJEc2hLRHNuYlRzbDVEc21wUXVDdXE0c091S3BldXFoZXlYa0NEc2s3RHNuYmdnNjR1bzdKYTBLT3V6Z09xeXZTd2c3S2VBN0tDVkxDRHJrN0hyb1owZzY1T3hLZXVsdkNEc2xZanJnclFnNjZ5NDZyV3M3SmVRN0lTY0lPdUxwT3VsdUNEcnA1RHJvWndnNjdDVTZyNjQ2Nm0wSU95Q3JPeWFxZXlla09xd2dDRHJpNlRycGJnZzZyaXc2NHFsN0p5ODY2R2NJT3lZcE8yVnRPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1NBbjZyYU03WldjSU91emdPcXl2U2NnNnJpdzY0cWw3SjJZSU95VmlPdUN0Q0RyckxqcXRhd0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V3bE9xL2dDRHNpSmdnN0o2STdKYTA3SnFVSUNoWUtRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N09BNnJLOTdaV2dJT3lJbUNEc25vanNsclRzbXBRZ0tFOHBDZ29qSXlEc21JanNtYmdnTlM0ZzdJdWM3SXFrN1lXY0lPdVBtZXlla2VxenZDRHJpNlRycGJnZzY0K1o3SUtzSU95VHNPeW5nQ0RzbFlycXVMQUtDdXVzdU9xMXJPdWx2Q0RzbFlUcnJMVHJwcXdnNjZlazY0R0U2NSs5NnJLTUlPdUxwT3VUck95V3RPdVBoQ0FxS3V5THBPeWduQ0RzaTV6c2lxVHRoWndnNjQrWjdKNlI2ck84SU91THBPdWx1Q0RyajVuc2dxd3FLdXVsdkNEc2s3RHJxYlFnN0o2WTY2cTc2NUNjSU91c3VPcTFyT3lZaU95YWxDNEtDdXlZaUNrZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWx2Q0FuN0xhVTZyQ0FJT3luZ095Z2xTZnRsWmpyaXBRZzdJdWM3SXFrN1lXYzdKZVE3SVNjSUNqc25iVHNvSVRDdCt5V2tldVBoQ0RxdUxEcmlxWHNuYlFnN0pXRTY0dVlLUW90SU91THBPdWx1Q0RzZ3F6cm5venNsNURxc293ZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWx2Q0RyaEpqcXNxanNvN3pzaExqc21wUWdLRmdnNG9DVUlPeVhodXVLbENBbjY0U1k2cml3NnJpd0p5RHF1TERyaXFYc25ZUWc3SldVN0l1Y0tRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bGJRZzdLTzg3SVM0N0pxVUlDaFBLUW89JwpESVI9IiRIT01FL0xpYnJhcnkvQXBwbGljYXRpb24gU3VwcG9ydC9DbGF1ZGVCcmlkZ2UiCnB1dCgpIHsgcHJpbnRmICVzICIkMSIgfCBiYXNlNjQgLUQgPiAiJDIiOyB9CiMg7J20IC5jb21tYW5k6rCAIOuPhOuKlCDthLDrr7jrhJAg7LC966eMIOqzqOudvCDri6vripTri6QodHR5IOunpOy5rSkuIGJhc2jqsIAg64Gd64KYIO2DreydtCBpZGxl65CcIDHstIgg65Kk7JeQIOuLq+yVhAojICLtlITroZzshLjsiqQg7Iuk7ZaJIOykkSIg6rK96rOg66W8IO2UvO2VnOuLpCDigJQgZGlzb3du7Jy866GcIOyKpO2BrOumve2KuOqwgCBleGl07ZW064+EIOuLq+q4sCDsnpHsl4XsnYAg7IK07JWE64Ko64qU64ukLiAo66elIOyLpOq4sCDqsoDspp0g7ZWE7JqUKQpNWVRUWT0iJChwcyAtbyB0dHk9IC1wICQkIDI+L2Rldi9udWxsIHwgdHIgLWQgIiAiKSIKY2xvc2VfdGVybWluYWwoKSB7CiAgWyAteiAiJE1ZVFRZIiBdICYmIHJldHVybgogICggc2xlZXAgMQogICAgL3Vzci9iaW4vb3Nhc2NyaXB0ID4vZGV2L251bGwgMj4mMSA8PE9TQQp0ZWxsIGFwcGxpY2F0aW9uICJUZXJtaW5hbCIKICByZXBlYXQgd2l0aCB3IGluIHdpbmRvd3MKICAgIHRyeQogICAgICByZXBlYXQgd2l0aCB0IGluIHRhYnMgb2YgdwogICAgICAgIGlmIHR0eSBvZiB0IGlzICIvZGV2LyRNWVRUWSIgdGhlbiBjbG9zZSB3IHNhdmluZyBubwogICAgICBlbmQgcmVwZWF0CiAgICBlbmQgdHJ5CiAgZW5kIHJlcGVhdAplbmQgdGVsbApPU0EKICApICYgZGlzb3duIDI+L2Rldi9udWxsIHx8IHRydWUKfQojIOyViOuCtOuKlCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukIOKAlCDthLDrr7jrhJDsnYAg7ISk7LmYwrfsoJDqsoDrp4wg7ZWY6rOgIOyKpOyKpOuhnCDri6vtnozri6QuCmZpbmlzaCgpIHsgY2xvc2VfdGVybWluYWw7IGV4aXQgIiQxIjsgfQplY2hvICLtgbTroZzrk5wg7Luk64Sl7YSw66W8IOyEpOy5mO2VmOqzoCDsnojslrTsmpTigKYg7J6g7IucIO2bhCDsnbQg7LC97J2AIOyekOuPmeycvOuhnCDri6vtmIDsmpQuIgpta2RpciAtcCAiJERJUi9zY3JpcHRzIiB8fCB7IGVjaG8gIu2PtOuNlCDsg53shLEg7Iuk7YyoOiAkRElSIjsgZmluaXNoIDE7IH0KcHV0ICIkQjY0X0JSSURHRSIgICAiJERJUi9zY3JpcHRzL2NsYXVkZS1icmlkZ2UuanMiCnB1dCAiJEI2NF9XQVRDSEVSIiAgIiRESVIvc2NyaXB0cy9icmlkZ2Utd2F0Y2hlci5qcyIKcHV0ICIkQjY0X0VYQU1QTEVTIiAiJERJUi9yZWNvbW1lbmQtZXhhbXBsZXMubWQiCnB1dCAiJEI2NF9HVUlERSIgICAgIiRESVIvdXgtd3JpdGluZy5tZCIKZWNobyAi4pyFIO2MjOydvCDshKTsuZg6ICRESVIiCiMgR1VJ7JeQ7IScIOyXsCBUZXJtaW5hbOydgCBQQVRI6rCAIOyigeydhCDsiJgg7J6I7Ja0IO2dlO2VnCDshKTsuZgg6rK966Gc66W8IOuztO2DoOuLpApleHBvcnQgUEFUSD0iJEhPTUUvLmxvY2FsL2Jpbjovb3B0L2hvbWVicmV3L2JpbjovdXNyL2xvY2FsL2JpbjokUEFUSCIKIyBub2Rl6rCAIOyXhuycvOuptCDqsJDsi5zsnpAoPW5vZGUpIOyekOyytOqwgCDrqrsg64+M7JWEIO2UjOufrOq3uOyduOyXkCDslYzrprQg67Cp67KV7J20IOyXhuuLpCDihpIg7J20IOqyveyasOunjCDrhKTsnbTti7DruIwg7Yyd7JeF7Jy866GcIOyViOuCtO2VnOuLpAppZiAhIGNvbW1hbmQgLXYgbm9kZSA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICBvc2FzY3JpcHQgLWUgJ2Rpc3BsYXkgZGlhbG9nICLsnbQgTWFj7JeQIE5vZGUuanPqsIAg7JeG7Ja07JqULiBb7ZmV7J24XeydhCDriITrpbTrqbQg64uk7Jq066Gc65OcIO2OmOydtOyngOqwgCDsl7TroKTsmpQuIE5vZGUuanMoTFRTKeulvCDshKTsuZjtlZwg65KkIOydtCDshKTsuZgg7YyM7J287J2EIOuLpOyLnCDsi6TtlontlbQg7KO87IS47JqULiIgd2l0aCB0aXRsZSAi7YG066Gc65OcIOy7pOuEpe2EsCDigJQgTm9kZS5qcyDtlYTsmpQiIGJ1dHRvbnMgeyLtmZXsnbgifSBkZWZhdWx0IGJ1dHRvbiAxIHdpdGggaWNvbiBjYXV0aW9uIGdpdmluZyB1cCBhZnRlciAxODAnID4vZGV2L251bGwgMj4mMQogIG9wZW4gImh0dHBzOi8vbm9kZWpzLm9yZy9rby9kb3dubG9hZCIgMj4vZGV2L251bGwKICBmaW5pc2ggMApmaQpOT0RFX0JJTj0iJChjb21tYW5kIC12IG5vZGUpIgplY2hvICLinIUgTm9kZS5qczogJChub2RlIC0tdmVyc2lvbikiCiMg6rCQ7Iuc7J6QIGxhdW5jaGQg65Ox66GdICjroZzqt7jsnbgg7J6Q64+Z7Iuc7J6RICsg7KeA6riIIOq4sOuPmSkuIFBBVEjrpbwgcGxpc3Tsl5Ag6rWz7ZiAIOuEo+uKlOuLpCDigJQgbGF1bmNoZCDquLDrs7ggUEFUSOyXlCBjbGF1ZGXqsIAg7JeG64ukLgpQTElTVD0iJEhPTUUvTGlicmFyeS9MYXVuY2hBZ2VudHMvY29tLmNsYXVkZWJyaWRnZS53YXRjaGVyLnBsaXN0Igpta2RpciAtcCAiJEhPTUUvTGlicmFyeS9MYXVuY2hBZ2VudHMiClNBRkVfUEFUSD0iJHtQQVRILy8mLyZhbXA7fSIKY2F0ID4gIiRQTElTVCIgPDxQTElTVEVPRgo8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCI/Pgo8IURPQ1RZUEUgcGxpc3QgUFVCTElDICItLy9BcHBsZS8vRFREIFBMSVNUIDEuMC8vRU4iICJodHRwOi8vd3d3LmFwcGxlLmNvbS9EVERzL1Byb3BlcnR5TGlzdC0xLjAuZHRkIj4KPHBsaXN0IHZlcnNpb249IjEuMCI+CjxkaWN0PgogIDxrZXk+TGFiZWw8L2tleT48c3RyaW5nPmNvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlcjwvc3RyaW5nPgogIDxrZXk+UHJvZ3JhbUFyZ3VtZW50czwva2V5PgogIDxhcnJheT4KICAgIDxzdHJpbmc+JE5PREVfQklOPC9zdHJpbmc+CiAgICA8c3RyaW5nPiRESVIvc2NyaXB0cy9icmlkZ2Utd2F0Y2hlci5qczwvc3RyaW5nPgogIDwvYXJyYXk+CiAgPGtleT5FbnZpcm9ubWVudFZhcmlhYmxlczwva2V5PgogIDxkaWN0PjxrZXk+UEFUSDwva2V5PjxzdHJpbmc+JFNBRkVfUEFUSDwvc3RyaW5nPjwvZGljdD4KICA8a2V5PlJ1bkF0TG9hZDwva2V5Pjx0cnVlLz4KICA8a2V5PktlZXBBbGl2ZTwva2V5PjxkaWN0PjxrZXk+U3VjY2Vzc2Z1bEV4aXQ8L2tleT48ZmFsc2UvPjwvZGljdD4KPC9kaWN0Pgo8L3BsaXN0PgpQTElTVEVPRgpsYXVuY2hjdGwgYm9vdG91dCAiZ3VpLyQoaWQgLXUpL2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlciIgMj4vZGV2L251bGwKbGF1bmNoY3RsIGJvb3RzdHJhcCAiZ3VpLyQoaWQgLXUpIiAiJFBMSVNUIiAyPi9kZXYvbnVsbCB8fCBsYXVuY2hjdGwgbG9hZCAtdyAiJFBMSVNUIiAyPi9kZXYvbnVsbAojIGNsYXVkZSDsnKDrrLTCt+uhnOq3uOyduCDsl6zrtoDripQg7Jes6riw7IScIOyVjOumrOyngCDslYrripTri6Qg4oCUIOqwkOyLnOyekOqwgCDqt7gg7IOB7YOc66W8IO2UjOufrOq3uOyduOyXkCDsoITri6ztlbQKIyDqs4TsoJUg7ZmU66m07J20ICLshKTsuZgg7ZWE7JqUIC8g66Gc6re47J24IO2VhOyalCAvIOykgOu5hCDsmYTro4wi66GcIOuFuOy2nO2VnOuLpCjthLDrr7jrhJDsnbQg7LGE64SQ7J20IOyVhOuLmCkuCiMg7ISk7LmYwrfsoJDqsoAg64GdIOKGkiDssL3snYQg7Iqk7Iqk66GcIOuLq+uKlOuLpC4KZmluaXNoIDAKUEsBAh4DFAAACAAAAAAAADjAR+u3xQEAt8UBABsAAAAAAAAAAAAAAO2BAAAAAO2BtOuhnOuTnC3su6TrhKXthLAuY29tbWFuZFBLBQYAAAAAAQABAEkAAADwxQEAAAA=";
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
                message: '수정이 필요한 항목이 없습니다.'
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
                message: '네이버 맞춤법 미작동: ' + (naverDiag || '원인 미상') + ' (톤·을/를 검사만 진행)'
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
                    ? '변경이 완료되었어요.'
                    : `${changedNodeIds.size}건이 변경 완료되었어요.`;
            }
            else if (changedNodeIds.size > 0) {
                message = `${changedNodeIds.size}건 적용 완료. ${skippedCount}건은 검토 후 텍스트가 바뀌었거나 삭제되어 적용하지 못했어요.`;
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
                message: '적용 중 오류가 발생했어요: ' + errStr(e)
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
        const bh = await bridgeHealth();
        if (!bh.alive) {
            // 클로드를 못 쓰는 상태 — 예시·규칙 폴백 (forceAi여도 폴백이라도 보여준다)
            postRecommendFallback(text, '');
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
    if (msg.type === "GET_SELECTION_TEXT") {
        // 팝업(텍스트 여러 개 든 컴포넌트)이면 입력창을 채우지 않고 팝업 신호만 보낸다
        const s0 = figma.currentPage.selection[0];
        const popupEls = (s0 && s0.type !== 'TEXT') ? classifyPopup(s0) : [];
        if (popupEls.length >= 2) {
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
