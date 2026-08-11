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
const BRIDGE_MIN_V = 25;
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
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBMEtMeThnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQURRb3ZMeURzZ3F6c21xbnJzcFU2SU8yUGlleURnZXlMbk95WGxDRHFzSkRzaTV6c25wRHFzSUFnN0o2UTY0K1o3Snk4NjZHY0lPeThvT3VMcENBbzdJaVk2NCtaSU95TG5PeWVrZXlkZ0NCdWNHMGdjblZ1SUdKeQ0KYVdSblpTa05DaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdURRb3ZMdzBLTHk4ZzdJYU42NCtFSU95RXBPcXpoRG9nN1lHMDY2R2M2NU9jNjZXOElPeWFsT3l5cmV1bmlPdUxwQ0RzZzRqcm9ad2c3SXVjNjQrWjdaV1k2Nm0wSURNd2ZqUXc3TFNJNnJDQUlPcTN1T3VEcFNEcmdxRHNsWVRxc0lUcmk2UXVEUW92THlEaWhwSWc2NHVrNjZhczY2VzhJT3k4cENEcmxZd2c3WUcwNjZHYzY1T2NJT3lFdU95Rm1PeWRoQ0R0bFpqcmdwZ2c3SmUwN0phMElPeURnZXlMbkNEcmpJRHF1TERzaTV6dGdxVHFzNkFvYzNSeVpXRnRMV3B6YjI0ZzY0eUE3Wm1VSU91cXFPdVRuQ2tzRFFvdkx5QWdJT3F3Z095ZHRPdVRuQ3ZzbUlqc2k1d29NVEV4NnJHMEtldUtsQ0Rzc3FzZzY2bVU3SXVjN0tlQTY2R2NJTzJWbkNEcnNvanINCnA0d2c3SjI5N1o2TTY0dWtMaURzbmJUdG00UWc3SnFVN0xLdDdKMkFJT3VzdU9xMXJPdW5qQ0RyczdUcmdyVHJyNERyb1p3ZzY3bWc2NlcwNjR1a0xnMEtMeThnN0lTNDdJV1k3SjJBSURNdzY3S0lJT3lUc091cHRDRHNucXpzaTV6c25wSHRsYlFnNjR5QTdabVU2ckNBSU91c3RPMlZuTzJlaUNEcXVManNsclRzcDREcmlwUWc2cktEN0oyRUlPdW5pZXVLbE91THBDNE5DaTh2RFFvdkx5RHNvSVRzb0p3NklPeWR0Q0JRUSt5WGtDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2hLVHN1WmpDdCt1aG5PcTN1T3lkdU91UHZDRHNub2pzbllRZzZyS0RJQ2hqYkdGMVpHVWdMUzEyWlhKemFXOXVJT3ljdk91aG5DRHRtWlhzbmJncERRb3ZMeURzbzd6c25aZzZJT3lDck95YXFldWZpZXlkZ0NEcXNJSHNucEFnN1lHMDY2R2M2NU9jSU9xMXJPdVBoU0R0bFp6cmo0VHNsNURzaEp3ZzdMQ282ckNRNjVDYzY0dWtMZzBLRFFwamIyNXpkQ0JvZEhSd0lEMGdjbVZ4ZFdseVpTZ25hSFIwY0NjcE93MEtZMjl1YzNRZ1puTWdQU0J5DQpaWEYxYVhKbEtDZG1jeWNwT3cwS1kyOXVjM1FnYjNNZ1BTQnlaWEYxYVhKbEtDZHZjeWNwT3cwS1kyOXVjM1FnY0dGMGFDQTlJSEpsY1hWcGNtVW9KM0JoZEdnbktUc05DbU52Ym5OMElIc2djM0JoZDI0c0lITndZWGR1VTNsdVl5QjlJRDBnY21WeGRXbHlaU2duWTJocGJHUmZjSEp2WTJWemN5Y3BPdzBLRFFvdkx5RHRnYlRyb1p6cms1enJwYndnNjdtSUlPMlB0T3VObE95WGtPeUVuQ0RzaTZUdGxva2c0b0NVSU95Z2dPeWVwZXlHak95WGtPeUVuQ0RzaTZUdGxvbnRsWmpycWJRZzdaU0U2NkdjN0tDZDdZcTRJT3VucGV1ZHZTaERURUZWUkVVdWJXUWc2NU94S2V5ZGhBMEtMeThnNjZla0lPMkV0Q0RzcDRyc2xyVHNvTGpzaEp3Z05EWHN0SWd2N1lTMDZybU03S2VBSU91S2tPdWdwT3luaE91THBDQW82N21JSU8yUHRPdU5sQ0FySU91MmdPcXdnT3E0c091S3BTRHNzS2pyaTZqc25iVHJxYlFnZmpQc3RJZ3Y3WVMwS1M0TkNtTnZibk4wSUVWTlVGUlpYME5YUkNBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCaw0KYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3RFFwMGNua2dleUJtY3k1dGEyUnBjbE41Ym1Nb1JVMVFWRmxmUTFkRUxDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTQjlLVHNnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nNjZ5MDdJdWNJQ292SUgwTkNtTnZibk4wSUVOTVFWVkVSVjlGVGxZZ1BTQlBZbXBsWTNRdVlYTnphV2R1S0h0OUxDQndjbTlqWlhOekxtVnVkaXdnZXcwS0lDQk5RVmhmVkVoSlRrdEpUa2RmVkU5TFJVNVRPaUFuTUNjc0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQXZMeURzZzUzcXNJRWc2NnFvNjVPY0lPdUJsQ0FvN0tlbjdKMkFJT3VzdU9xMXJPeVhsQ0RydG9qdGxZVHNtcFFwRFFvZ0lFTk1RVlZFUlY5RFQwUkZYMFJKVTBGQ1RFVmZUazlPUlZOVFJVNVVTVUZNWDFSU1FVWkdTVU02SUNjeEp5d2dMeThnN1lTMElPeWFsT3lWdlNEcms3RWc2N2FBNnJDQUlPMll1T3kybkNEcmdaUU5DaUFnUkVsVFFVSk1SVjlVUlV4RlRVVlVVbGs2SUNjeEp5d05DbjBwT3cwS0RRb3YNCkx5RHNpS2pxdVlBZzdJdWs3WmFKS09xd2tPeUxuT3lla0NEc2lxVHRqN0RzbllBZ2MzUmthVzhnYVdkdWIzSmxLZXlYa095RW5PdVBoQ0Ryckxqc29KenJwYndnN0xhVTdLQ0I3WldnSU95SW1DRHNub2pxc293ZzdMMlk3SWFVSU91aG5PcTN1T3VsdkNEdGpJenNuYnpzbDVEcmo0UWc2NEtvNnJpMDY0dWtMZzBLTHk4ZzdKeUU3TG1ZT2lEc25vVHNpNXdnN1krMDY0MlU3SjJZSUdOc1lYVmtaUzFpY21sa1oyVXViRzluSUNqc25JanJqNFRzbXJBZ0pWUkZUVkFsTENEcnA2VWdKRlJOVUVSSlVpa3VJREpOUWlEcmhKanNuTHpycWJRZ0xtOXNaT3VobkNEdGxad2c3SVM0NjR5QTY2ZU1JT3V6dE9xMGdDNE5DbU52Ym5OMElFeFBSMTlHU1V4RklEMGdjR0YwYUM1cWIybHVLRzl6TG5SdGNHUnBjaWdwTENBblkyeGhkV1JsTFdKeWFXUm5aUzVzYjJjbktUc05DbU52Ym5OMElGOXZjbWxuVEc5bklEMGdZMjl1YzI5c1pTNXNiMmN1WW1sdVpDaGpiMjV6YjJ4bEtUc05DbU52Ym5OdmJHVXViRzluSUQwZ1puVnVZM1JwDQpiMjRnS0NrZ2V3MEtJQ0JqYjI1emRDQmhjbWR6SUQwZ1FYSnlZWGt1Y0hKdmRHOTBlWEJsTG5Oc2FXTmxMbU5oYkd3b1lYSm5kVzFsYm5SektUc05DaUFnWDI5eWFXZE1iMmN1WVhCd2JIa29iblZzYkN3Z1lYSm5jeWs3RFFvZ0lIUnllU0I3RFFvZ0lDQWdkSEo1SUhzTkNpQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0V4UFIxOUdTVXhGS1NBbUppQm1jeTV6ZEdGMFUzbHVZeWhNVDBkZlJrbE1SU2t1YzJsNlpTQStJRElnS2lBeE1ESTBJQ29nTVRBeU5Da2dabk11Y21WdVlXMWxVM2x1WXloTVQwZGZSa2xNUlN3Z1RFOUhYMFpKVEVVZ0t5QW5MbTlzWkNjcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU8yYWpPeWdoQ0RzaTZUdGpLanJpcFFnNjZ5MDdJdWNJQ292SUgwTkNpQWdJQ0JqYjI1emRDQnNhVzVsSUQwZ0oxc25JQ3NnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZOMGNtbHVaeWduYTI4dFMxSW5LU0FySUNkZElDY2dLdzBLSUNBZ0lDQWdZWEpuY3k1dFlYQW9LR0VwSUQwKw0KSUNoMGVYQmxiMllnWVNBOVBUMGdKM04wY21sdVp5Y2dQeUJoSURvZ1NsTlBUaTV6ZEhKcGJtZHBabmtvWVNrcEtTNXFiMmx1S0NjZ0p5a2dLeUFuWEc0bk93MEtJQ0FnSUdaekxtRndjR1Z1WkVacGJHVlRlVzVqS0V4UFIxOUdTVXhGTENCc2FXNWxLVHNOQ2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzdZeU03SjI4SU91aG5PcTN1Q0RzaTZUdGpLanRsYlRyajRRZzY0dWs2NmFzNjRxVUlPcXpoT3lHalNBcUx5QjlEUXA5T3cwS0RRcGpiMjV6ZENCUVQxSlVJRDBnVG5WdFltVnlLSEJ5YjJObGMzTXVaVzUyTGtKU1NVUkhSVjlRVDFKVUtTQjhmQ0F4TVRnNE9Ec2dMeThnUWxKSlJFZEZYMUJQVWxUcmlwUWc3WVdNN0lxazdZcTQ3SnFwSUNqdGo0bnNob3pzbDVRZ01URTRPRGdnNnJPZzdLQ1ZLUTBLTHk4ZzY0dWs2NmFzSU95OWxPdVRuQ0Ryc29Uc29JUWc0b0NVSUM5b1pXRnNkR2pyb1p3ZzY0VzQ3TGFjN1pXYzY0dWtMaURzdlpUcms1enJwYndnY0hWc2JNSzM2N08xN0lLczdaVzA2NCtFSUNvcTdKMjANCjY2KzRJT3VXb0NEc25vanJpcFFnNjR1azY2YXM2NHFVSU95WW15RHN2WlRyazV3ZzZyZTQ2NHlBNjZHY0tpcnJuYndOQ2k4dklPcTdrT3VMcENEc3ZKenF1TEFnN0tDRTdKZVVJT3lEaUNEcmo1bnNucEhzbmJRZzdKV0lJT3VDbU95WXFPdUxwQ2p0aExEcnI3anJoSkRzbmJRZzY1eW82NHFVSU91VHNTa3VJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHNuYlFnNnJDUzdKeTg2NkdjSU9xMXJPdXloT3lnaE95ZGhDRHFzSkRzcDREdGxiUWc3SjZzN0l1YzdKNlI3SXVjN1lLbzY0dWtMZzBLTHk4ZzY0K1o3SjZSN0oyMElPdXdsT3VBak91S2xDRHNpSmpzb0pYc25ZUWc3WldZNjZtMElPeWR0Q0RzaUt2c25wRHJwYndnN0ppczY2YXM2ck9nSUdOdlpHVXVkSFBzblpnZ1FsSkpSRWRGWDAxSlRsOVc2NCtFSU9xd21leWR0Q0RzbUt6cnByRHJpNlF1RFFwamIyNXpkQ0JDVWtsRVIwVmZWaUE5SURJMU93MEtMeThnNnJpdzY3TzRJT3VxcU91TnVDNGc3SnFVN0xLdEtPMlVqT3Vmck9xM3VPeWR1Q25zbmJRZ2JXOWtaV3pzDQpuWVFnN0tlQTdLQ1Y3WldZNjZtMElPcTN1Q0RzbXBUc3NxM3JwNHdnNnJlNElPdXFxT3VOdU91aG5DRHNzcGpycHF6dGxaenJpNlF1RFFvdkx5Qm9ZV2xyZFQzcnVhRHJwb1F2NnJDQTY3Szg3SnVBTENCemIyNXVaWFE5N0tTUjZyQ0VMQ0J2Y0hWelBlcTRzT3V6dUNqc3RaenFzNkR0a29qc3A0Z3NJT3loc09xNGlDRHJpcERycHJ3cERRcGpiMjV6ZENCRFRFRlZSRVZmVFU5RVJVd2dQU0J3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVFU5RVJVd2dmSHdnSjI5d2RYTW5PdzBLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdEUXBqYjI1emRDQlVWVkpPWDFSSlRVVlBWVlJmVFZNZ1BTQTVNREF3TURzZ0lDQXZMeURzbXBUc3NxMGdNZXF4dENEc29KenRsWnpzaTV6cXNJUU5DbU52Ym5OMElFMUJXRjlVVlZKT1V5QTlJRE13T3lBZ0lDQWdJQ0FnSUNBZ0lDOHZJT3lkdE91bmpPMkJ2Q0RzazdEcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZQ0Ka1NBbzY0eUE3Wm1VSU91SWhPeWdnU0Ryc0tuc3A0QXBEUW9OQ2k4dklPS1VnT0tVZ0NEc21JanNpNXdnN0lLczdLQ0VJT3Vobk91VG5DQW9jbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrSU9LQWxDQmlkV2xzWkMxbmJHOXpjMkZ5ZVM1cWMreVpnQ0Rxc0puc25ZQWc3WXlNN0lTY0tTRGlsSURpbElBTkNtWjFibU4wYVc5dUlHeHZZV1JGZUdGdGNHeGxjeWdwSUhzTkNpQWdkSEo1SUhzTkNpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xa0p5a3NJQ2QxZEdZNEp5azdEUW9nSUNBZ1kyOXVjM1FnYzJWalNXUjRJRDBnYldRdWMyVmhjbU5vS0M5ZUl5TWc3TGFVN0xLY0lPeVlpT3lMbkZ4ektpUXZiU2s3RFFvZ0lDQWdhV1lnS0hObFkwbGtlQ0E5UFQwZ0xURXBJSEpsZEhWeWJpQmJYVHNOQ2lBZ0lDQmpiMjV6ZENCbGVHRnRjR3hsY3lBOUlGdGRPdzBLSUNBZ0lHeGwNCmRDQmpkWElnUFNCdWRXeHNPdzBLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjbUYzSUc5bUlHMWtMbk5zYVdObEtITmxZMGxrZUNrdWMzQnNhWFFvSjF4dUp5a3BJSHNOQ2lBZ0lDQWdJR052Ym5OMElHeHBibVVnUFNCeVlYY3VjbVZ3YkdGalpTZ3ZYSE1ySkM4c0lDY25LVHNOQ2lBZ0lDQWdJR052Ym5OMElHZ2dQU0JzYVc1bExtMWhkR05vS0M5ZUl5TWpYSE1yS0M0clB5bGNjeW9rTHlrN0RRb2dJQ0FnSUNCcFppQW9hQ2tnZXlCamRYSWdQU0I3SUdsdWNIVjBPaUJvV3pGZExDQnpkV2RuWlhOMGFXOXVjem9nVzEwZ2ZUc2daWGhoYlhCc1pYTXVjSFZ6YUNoamRYSXBPeUJqYjI1MGFXNTFaVHNnZlEwS0lDQWdJQ0FnWTI5dWMzUWdZaUE5SUd4cGJtVXViV0YwWTJnb0wxNWNjeW90WEhNcktDNHJQeWxjY3lva0x5azdEUW9nSUNBZ0lDQnBaaUFvWWlBbUppQmpkWElwSUdOMWNpNXpkV2RuWlhOMGFXOXVjeTV3ZFhOb0tHSmJNVjB1YzNCc2FYUW9KeUF2SUNjcExtcHZhVzRvSnlBbktTazdEUW9nSUNBZ2ZRMEtJQ0FnDQpJSEpsZEhWeWJpQmxlR0Z0Y0d4bGN5NW1hV3gwWlhJb0tHVXBJRDArSUdVdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lENGdNQ2s3RFFvZ0lIMGdZMkYwWTJnZ0tHVXBJSHNOQ2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0ppSTdJdWNJT3lDck95Z2hDRHJvWnpyazV3ZzdJdWs3WXlvSUNqc2w0YnNuYlFnN0tlRTdaYUpLVG9uTENCbExtMWxjM05oWjJVcE93MEtJQ0FnSUhKbGRIVnliaUJiWFRzTkNpQWdmUTBLZlEwS0RRb3ZMeURpbElEaWxJQWc3S2VBN0l1YzY2eTRJQ2pzaEp6cnNvUWdjbVZqYjIxdFpXNWs3Sm1BSU9xd21leWRnQ0RxdDV6c3Vaa2c0b0NVSU91d2xPcSt1T3VwdENEcXQ3anNxcjNyajRRZzdaV282cnVZS1NEaWxJRGlsSUFOQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aA0Kbk91VG5PcXdnQ0RzbXFuc2xyUWc2cldRN0tDVjdKMkVEUW92THlEc283d2c3SjZFNjZ5MDY2R2NJT3lZcE8yVnRPMlZ0Q0F6NnJDY0lPeWduT3lWaU95ZHRDRHNvSVRydG9BZ0l1MlJuT3E0c0NEcXM2RHN1YWdnS3lEc2xyVHNpSndnNjdPQTZySzlJdXlkdENEcmtKenJpNlF1SU95WHJlMlZvQ0RydG9UcnBxd2c0b0NVRFFvdkx5RHRnYlRyb1p6cms1d2dQU0Ryckxqc25xVWc2NHVrNjVPczZyaXdLT3l3dmV5ZG1Da3NJT3lhcWV5V3RDRHRoclhzbmJ6Q3QrdW5udXkycE91eWxTQTlJR052WkdVdWRITWdjbVZtYVc1bFFXbFRkV2RuWlhOMGFXOXVjeUR0bTRUc3NwanJwcXdvNnJpdzZyT0U3S0NCS1M0TkNtTnZibk4wSUZOVVdVeEZYMUpWVEVWVElEMGdXdzBLSUNBbk1TNGc3WlcwN0pxVTdMSzBPaURycXFqcms2QWc2Nnk0NnJXczY0cVVJTzJWdE95YWxPeXl0T3VobkM0Z0tPdXp0T3VEaGV1TGlPdUxwT0tHa3V1enRPdUN0T3lhbENrbkxBMEtJQ0FuTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNEb2cNCjY1Q1E3SmEwN0pxVTRvYVM3WmFJN0phMDdKcVVMQ0IrN0plSUlPdTV2T3E0c0NqcnNKVHJnSXpzbDRqc2xyVHNtcFRpaHBMcnNKVHF2NmpzbHJUc21wUXBMaURyaTZnc0lPeWloZXVqak1LMzY2ZU02Nk9Nd3Jmc2w3RHNzclRDdCsyVnRPeW5nTUszNnJpdzY2R2R3cmZyaGJuc25Zd2c2NU94SU95TG5PeUtwTzJGbk95ZHRDRHNvN3pzc3JUc25iZ2c2ckt3NnJPODY0cVVJT3lJbU91UG1lMllsU0RzbktEc3A0QW83SmV3N0xLMDY0Kzg3SnFVTENEcmhibnNuWXpyajd6c21wUXBMaWNzRFFvZ0lDY3pMaURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3T2lBaWZ1MlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlpRHJqSURzaTZBZ0luN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRaUlPcTFyT3loc0NEc21yRHNoS0F1SU91THFDd2c3S0NWN0xHRjdJT0JJT3UyaU9xd2dNSzM3SjI4NjdhQUlPcTRzT3VLcFNEc29KenRsWnpDdCt1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPcXlzT3F6dk1LMzdLQ1Y2N08wDQpJT3V6dE8yWXVDRHNsWWpzaTZ6c25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyZWlDNG5MQTBLSUNBbk5DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0RG9nZnUyVm1PeUxuT3F5b095V3RPeWFsRC9paHBKKzdaV2c2cm1NN0pxVVB5d2c2ck9FN0l1YzY0dWs0b2FTN0o2STY0dWtMQ0RzbDZ6c3JZanJpNlRpaHBMdG1aWHNuYmp0bFpqcmk2UXNJT3E3bU9LR2t1eVhrT3F5akM0Z2Z1eUxuQ0RydWJ6cXVMRHFzSUFnN0phMDdJT0o3WldZNjZtMElPMk1qT3lWaGUyVm1PdWdwT3VLbENEc29KWHJzN1RycGJ3ZzdLTzg3SmEwNjZHY0lPdXN1T3llcGV5ZGhDRHJpNlRzaTV3ZzdKTzA2NHVrTGljc0RRb2dJQ2MxTGlEcnFvWHNncXdyNjZxRjdJS3NJT3E0aU95bmdEb2c3WldjN0o2UTdKYTA2Nlc4SU8yU2dPeVd0Q0RyajVuc2dxenJvWndvN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBUaWhwTHNuYlRzbnBEcnBid2c2NCtNNjZDazY3Q2I3SldZN0phMDdKcVVLU3dnN0xXYw0KN0lhTTdaV2NJSHZycW9Yc2dxeDk2ckNBSUh2cnFvWHNncXg5N1pXMDdJU2NJTzJZbGUyRG5PdWhuQ2pzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjNG9hUzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2t1Snl3TkNpQWdKell1SU8yUm5PcTRzRG9nNjVDWTdKYTA3SnFVNG9hUzY0Kzg3SnFVTGljc0RRb2dJQ2MzTGlEc3BJUWc2cldzN0tHd09pRHNtNURyczdqc25iUWc3WldjSU95a2hPeWR0T3VwdENEc3RwVHNzcHpyajRRZzY3Q1k2NU9jN0l1Y0lPMlZuQ0RzcElUcm9ad3VJT3llaE95ZG1PdWhuQ0RzcElUc25ZUWc2NHFZNjZhczdLZUFJT3lWaXV1S2xPdUxwQzRnNjR1b0xDRHNsNnpybjZ3ZzY2eTQ3SjZsN0oyRUlPMlZtT3VDbU95ZG1DRHF1STNzb0pYdG1KVWc2Nnk0N0o2bDdKeTg2NkdjSU8yVnFleXprQ0RyalpRZzZyQ0U2ckt3N1pXMDdLZUU2NHVrNjZtMElPeWtoQ0RzaUpqcnBid2c3S1NFN0oyMDY0cVVJT3F5Zyt5ZGdDRHRtWmpzbUlFdUp5d05DaUFnSnpndUlPMk1uZXlYaFNqcmk2VHMNCm5iVHNscnpyb1p6cXQ3Z3BJT3V5aE8yS3ZEb2c2ckt3NnJPOElPMkd0ZXV6dE91S2xDQmI3Wm1WN0oyNFhTd2c3SmlJTCt5VmhPdUxpT3lZcENEdGpKRHJpNmpzbllBZ1creVZoT3VMaU95WXBGMHZXK3VFcEYwc0lPdVBtZXlla1NEc25LRHJqNFRyaXBRZ1creTNxT3lHakYwdlczdnJqNW5zbnBGOVhTNGdJdXkzcU95R2pDTHJpcFFnNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUlPeVRzT3F6b0NBaTY0dXI2cml3d3Jmcmo1bnNucEVpN0xLWTY1KzhJT3lublNEc2xZZ2c2NmVlNjRxVUlPeWhzTzJWcWNLMzY0dW82NCtGSUNMc3Q2anNob3dpNjRxVUlPcTRpT3luZ0M0bkxBMEtJQ0FuT1M0ZzdKMjA2NmFFd3Jmc29JVHRtWlRyc29qdG1MakN0K3VuaU95S3BPMkN1ZXlkZ0NEcXQ3anJqSURyb1p3ZzY3TzA3S0cwTGlEc2dxenJub3pzbllRZzY3YUE2Nlc4SU91VmtDRHJpNWpzbllRZzY3YVo3SmVzNjQrRUlPeWlpK3VMcEM0bkxBMEtJQ0FuTVRBdUlPeWduTzJTaUNEc21xbnNsclFnDQo3SnlnN0tlQU9pRHNub1hyb0tYc2w1QWc3Sk93N0oyNElPcTRzT3VLcGV5RXNTRHJxb1hzZ3F3bzY3T0E2cks5TENEc3A0RHNvSlVzSU91VHNldWhuU3dnN1pXMDdLQ2NJT3VUc1NucmlwUWc3Wm1VNjZtMDdKMllJT3E0c091S3BldXFoY0szNjdLRTdZcTg2NnFGN0oyOElPcXdnT3VLcGV5RXNleWR0Q0RyaHBMc25MenJyNERyb1p3ZzdJbXM3SnEwSU91bmtPdWhuQ0Ryc0pUcXZyanNwNEFnN0pXSzY0cVU2NHVrTGlEc2k1enNpcVR0aFp3ZzY0K1o3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXpycGJ3ZzdJT0k2NkdjSU91bmpPdVRwT3luZ0NEc2xZcnJpcFRyaTZRdUp5d05DbDB1YW05cGJpZ25YRzRuS1RzTkNnMEtZMjl1YzNRZ1JWaEJUVkJNUlZNZ1BTQnNiMkZrUlhoaGJYQnNaWE1vS1RzTkNnMEtMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1Yw0KNjRLWTY2YXM3SmlrNnJtTTdLZUFJTzJVaE91aHJPMlVoTzJLdU95WGtDRHRqNnp0bGFncElPS1VnT0tVZ0EwS0x5OGdVMVJaVEVWZlVsVk1SVk1nTVREc3BJUWc3SnFVN0pXOTY2ZU03Snk4NjZHYzY0cVVJT3lZaU95WnVDQXhmak1vN0lpWTY0K1o3WmlWd3JmcXNyM3NsclRDdCt1MmdPeWdsZTJZbFNEdGw0anNtcWtnN0x5QTdKMjA3SXFrS2V5ZG1DRHJpWmpzbFpuc2lxVHFzSUFnN0p5ZzdJdWs2NUNjNjR1a0xnMEtMeThnN1l5TTdKMjg3SjIwSU95WGh1eWN2T3VwdENqc2hLVHN1WmpyczdnZzZyV3M2N0tFN0tDRUlPdVRzU2tnNjdtSUlPdXN1T3lla095WHRDRGlnSlFnN0pxVTdKVzk2NmVNN0p5ODY2R2NJT3VQbWV5ZWtTaG1ZV2xzTFhOdlpuUXBMZzBLWm5WdVkzUnBiMjRnYkc5aFpFZDFhV1JsS0NrZ2V3MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJRzFrSUQwZ1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNzSUNkMWVDMTNjbWwwYVc1bkxtMWsNCkp5a3NJQ2QxZEdZNEp5a3VkSEpwYlNncE93MEtJQ0FnSUhKbGRIVnliaUJ0WkM1c1pXNW5kR2dnUGlBeE1EQWdQeUJ0WkNBNklDY25PdzBLSUNCOUlHTmhkR05vSUNobEtTQjdEUW9nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnNjZHYzY1T2NJT3lMcE8yTXFDQW83SnFVN0pXOTY2ZU03Snk4NjZHY0lPeW5oTzJXaVNrNkp5d2daUzV0WlhOellXZGxLVHNOQ2lBZ0lDQnlaWFIxY200Z0p5YzdEUW9nSUgwTkNuME5DbU52Ym5OMElFZFZTVVJGSUQwZ2JHOWhaRWQxYVdSbEtDazdEUW9OQ21aMWJtTjBhVzl1SUdsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncElIc05DaUFnWTI5dWMzUWdabVYzVTJodmRDQTlJRVZZUVUxUVRFVlRMbTFoY0Nnb1pYZ3BJRDArSUNkSmJuQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExtbHVjSFYwS1NBcklDZGNiazkxZEhCMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG5OMVoyZGxjM1JwDQpiMjV6S1NrdWFtOXBiaWduWEc0bktUc05DaUFnY21WMGRYSnVJQ2dOQ2lBZ0lDQW43S2VBNnJpSTY3YUE3WVN3SU91RWlPdUtsQ0RzbDVEc2lxVHNtNUFvVXkweExDRHJzN1RzbFlqdG1venNncXdwN0oyWUlPMlZuT3ExcmV5V3RDQlZXQ0JYY21sMGFXNW5JT3lnaE91c3VPcXdnT3VobkNEc25ienRsWnpyaTZRdUlDY2dLdzBLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJEUW9nSUNBZ0oreWFsT3l5cmV1VHBPeWRnQ0RzaEp6cm9ad2c2NnkwNnJTQTdaV2NJT3V6aE9xd25DRHJyTGpxdGF6cmk2UWc0b0NVSU95ZHRPeWdoQ0RyckxqcXRhenJwYndnN0xDNDdLR3c3WldZN0tlQUlPdW5pT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDZnNtNURybnBnZzdKMlk2Nis0N0ptQQ0KSU91cXFPdVRvQ0Rzb0pYcnM3UW83SjIwNjZhRXdyZnNpS3ZzbnBEQ3QreWhzT3F4dE1LMzY0eUE3SU9CS2V1bHZDRHNuS0RzcDREdGxaanFzNkFzSU9xd2dTRHNvSnpzbFlqc25ZQWc3SnVRNjdPNDZyTzg2NCtFSU95RW5PdWhuT3laZ091UGhDRHJpNnpybmJ6c2xid2c3WldjNjR1a0xpQW5JQ3NOQ2lBZ0lDQW43S0d3NnJHMElPMlJuTzJZaENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzB3cmZzdElqcXM3ekN0K3V2dU91bmpNSzM2N2FBN1lTd3dyZnF1WXpzcDRBZzY1T3hLZXlkZ0NEc29KWHNzWVVnN0tDVjY3TzA2NHVrSU9LQWxDRHJ1Ynpxc2JEcmdwZ2c2NHVrNjZXNElPeWhzT3F4dE95Y3ZPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhLQ0kxN1pxTUlPeWR0T3lEZ1NMc25ZUWdJalh0bW93aTY2R2NJT3lraE95ZHRPdXB0Q0RzbUtUcmk3VXBMaUFuSUNzTkNpQWdJQ0FuN0p1UTY2eTQ3SmVRSU95WGh1dUtsQ0RxdGF6c3NyUWc3S0NWNjdPMEtPeWdoTzJabE91eWlPMll1TUszVlZKTXdyZnENCnVJanNsYUhDdCt5TG5PcXdoQ0RyazdFcDdKbUFJTzJWdE9xeXNDRHJzS25yc3BYQ3QreWdpT3l3cUNqc25xenNoS1Rzb0pYQ3QrdXN1T3lkbU95eW1NSzM3SjZzN0l1YzY0K0VJT3VUc1NucnBid2c3S2VBN0phMDY0SzBJT3UybWV5ZHRPdUtsQ0Rxc29Qc25ZQWc3S0NJNjR5QUlPcTRpT3luZ0NEaWdKUWc3SldFNjRxVUlPcXdrdXlkdE91ZHZPdVBoQ3dnNnJlNDY1KzA2NU92N1pXMDY0K0VJT3lUc095bmdDRHJwNGpybmJ3dVhHNG5JQ3NOQ2lBZ0lDQW5NK3F3bkNEc29KenNsWWpzbllBZzdJU2M2NkdjSU95Z2tlcTN2T3lkdENEcmk2enJuYnpzbGJ3ZzdaV2M2NHVrSU9LQWxDRHRsWmpyZ3BqcmlwUWc3SnVRNjZ5NElPcTFyT3loc091bHZDRHNuS0RzcDREdGxad2c3TFdjN0lhTUlPdUxwT3VUck9xNHNDd2c3WldZNjRLWTY0cVVJT3VzdU95ZXBTRHF0YXpzb2JEcnBid2c3SjZzNnJXczdJU3g3WldjSU91TWdPeVZpQ3dnSnlBckRRb2dJQ0FnSitxM3VPdW1yT3F6b0NEc29JSHNsclRyajRRZzdaV1k2NEtZDQo2NHFVSU9xenZPcXdrTzJWbkNEc25xenF0YXpzaExFNklPeWtrZXV6dFNEdGtaenRtSVRzbllRZzY0MmM3SmEwNjRLMDZyT2dMQ0Rzb0pYcnM3UWc3SWljN0lTYzY2VzhJT3lDck95YXFleWVrT3F3Z0NEc2xZenNsWVRzbGJ3ZzdaV2dJT3F5Zyt1MmdPMkVzT3VobkNEc25xenNvYkRzcDRIdGxhQWc2cktETGlBbklDc05DaUFnSUNBbjdKdVE2Nnk0N0oyMElPMlZ0T3F5c0NEcnNLbnJzcFhzbllRZzY0dTA2ck9nSU95ZWlPeWRoQ0RybFl6cnA0d2dJdXlXdE91V3UrcXlqQ0R0bFpqcnFiUWc2NHVrN0l1Y0lPdVFuT3VMcENMcnBid2c3SldlN0lTNDdKcXc2NHFVSU9xNGpleWdsZTJZbFNEc25xenF0YXpzaExIc25ZUWc3WldZNjUyOElPS0FsQ0RzbTVEcnJManNsNUFnN1pXMDZyS3c3TEdGN0oyMElPeVhodXljdk91cHRDRHJwNHpyazZUc2xyUWc2N2FaN0oyMDdLZUFJT3VuaU91ZHZDNGdKeUFyRFFvZ0lDQWdKKzJSbk9xNHNNSzM3SnFwN0phMDY2ZU1JT3F6b095NW1PcXpvQ0RzbHJUc2lKenNuWVFnNjdDVQ0KNnI2OElPeWdsZXVQaE95ZG1DRHNvSnpzbFlqc25ZUWdNK3F3bkNEcmlwanNsclRyaHBQc3A0QWc2NmVJNjUyOElPS0FsQ0RxdDdqcXNiUWc3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeTJsT3l5bk95ZHRDRHNsWVRyaTRqcm5id2c2cldRN0tDVjdKeTg2NkdjSU91enRPeWR1T3VMcEM0Z0p5QXJEUW9nSUNBZ0oreVZoT3VlbUNEc21JanNpNXpyazZUc25ZQWc3WldjSU95a2hPeW5uT3VtckNEc3RaenNob3dnNnJXUTdLQ1Y3SjIwSU91bmp1eW5nT3VuakNEcXQ3anFzYlFnN1lha0tPMlZ0T3lhbE95eXRNSzM2cks5N0phMEtleWRtQ0RxdFpEcnM3anNuYlRzcDRBZzdJYU02cmU1N0lTeDdKMllJT3Exa091enVPeWR0Q0RzbFlUcmk0anJpNlFnNG9DVUlPeVhyT3VmckNEcnJManNucVhzcDV6cnBxd2c3SjZGNjZDbDdKMkFJT3VwbE95TG5PeW5nQ0RyaTZqc25JVHJvWndnNjR1azdJdWNJT3lFcE9xemhPMlZtT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNjdDdzdKZTANCjY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvWEN0K3k5bE91VG5PMk9uT3lLcENEcXVJanNwNEE2WEc0bklDc05DaUFnSUNBblczc2lkR1Y0ZENJNklDTHNvSnpzbFlnZzY2eTQ2cldzSUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSnlaV0Z6YjI0aU9pQWk2NnkwN0plSDdKMkVJT3labkNEcnNKVHF2NmpyaXBUc3A0QWc3WldjNnJXdDdKYTBJTzJWbkNEcnJManNucVVpZlN3Z0xpNHVYVnh1WEc0bklDc05DaUFnSUNBblcreUtwTzJEZ095ZHZDRHF0NXpzdVpsZFhHNG5JQ3NnVTFSWlRFVmZVbFZNUlZNZ0t5QW5YRzVjYmljZ0t3MEtJQ0FnSUNoSFZVbEVSU0EvSUNkYjdJcWs3WU9BN0oyOElPcXdnT3lkdE91VG5DRHNvSVRyckxnZ0tIVjRMWGR5YVhScGJtY3ViV1FwSU9LQWxDRHNuSVFnNnJlYzdMbVo3SjJZSU9xM3ZPcXhzT3laZ0NEc21JanNtYmdnN0l1YzY0S1k2NmFzN0ppa0xpRHRpcm50bm9nZzdKaUk3Sm00SU9xM25PeTVtU2pzaUpqcmo1bnRtSlhDDQp0K3F5dmV5V3RNSzM2N2FBN0tDVjdaaVY3SjJFSU95Y29PeW5nTzJWdE95VnZDRHRsWmpyaXBRZzdJT0I3Wm1wS2V5ZGhDRHF0N2pyaklEcm9ad2c2NVN3NjZXMDZyT2dMQ0RzbXBUc2xiM3FzN3dnN0tDRTY2eTQ3SjIwSU91THBPdWx0T3VwdENEc29JVHJyTGpzbllRZzY1U3c2Nlc0NjR1a1hWeHVKeUFySUVkVlNVUkZJQ3NnSjF4dVhHNG5JRG9nSnljcElDc05DaUFnSUNBb1ptVjNVMmh2ZENBL0lDZGI3SnF3NjZhc0lPdXFxZXlHak91bXJDRHNtSWpzaTV3ZzRvQ1VJT3lkdENEdGhxVHNuWVFnNjVTdzY2VzhJT3F5ZzExY2JpY2dLeUJtWlhkVGFHOTBJQ3NnSjF4dVhHNG5JRG9nSnljcElDc05DaUFnSUNBbjdLU0E2N21FNjVDUTdKeTg2Nm0wSUNKUFN5THJuYnpxczZEcnA0d2c2NHUxN1pXWTY1MjhMaWNOQ2lBZ0tUc05DbjBOQ2cwS0x5OGc0cFNBNHBTQUlPeURnZXlMbkNEcmpJRHF1TEFnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaQ0KbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQU5DbXhsZENCd2NtOWpJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDQWdMeThnN1lHMDY2R2M2NU9jSU8yVWhPdWhuT3lFdU95S3BBMEtiR1YwSUd4cGJtVkNkV1lnUFNBbkp6c2dJQ0FnSUNBZ0lDQXZMeUJ6ZEdSdmRYUWc3S1NFSU91eWhPMk52QTBLYkdWMElIZGhhWFJsY2lBOUlHNTFiR3c3SUNBZ0lDQWdJQ0F2THlEdG1JVHNucXdnN1lTMDdKMllJSHNnY21WemIyeDJaU3dnY21WcVpXTjBMQ0IwYVcxbGNpQjlEUXBzWlhRZ2NYVmxkV1VnUFNCUWNtOXRhWE5sTG5KbGMyOXNkbVVvS1RzZ0x5OGc3SnFVN0xLdElPeW5nZXVnck8yWmxDQW82NCtaN0l1Y0lPeWFsT3l5cmV5ZGdDRHNpSnpzaEp6cmpJRHJvWndwRFFwc1pYUWdkSFZ5Ym5NZ1BTQXdPdzBLYkdWMElIZGhjbTFsWkZWd0lEMGdabUZzYzJVN0RRcHNaWFFnWTNWeWNtVnUNCmRFMXZaR1ZzSUQwZ1EweEJWVVJGWDAxUFJFVk1PeUF2THlEc3A0RHF1SWdnN0lTNDdJV1k3SjIwSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NnFvNjQyNElDanNtcFRzc3Ezc25iUWc2NHVrNjZXNElPdXFxT3VOdU95ZGhDRHNwNERzb0pYdGxaanJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU2tOQ2k4dklPeUxuT3lla1NEc2k1d2dRMnhoZFdSbElFTnZaR1VvWTJ4aGRXUmxJRU5NU1NucXNJQWc3Sk80SU95SW1DRHNub2pyaXBUc3A0QWc3S0NRNnJLQUlPS0FsQ0RzbDRic25MenJxYlFnTDJobFlXeDBhT3VobkNEc2xZenJvS1FnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZuT3VMcEM0TkNpOHZJRzUxYkd3OTdabVY3SjI0SU95a2tTd2dKMjlySnozc2dxenNtcWtnNnJDQTY0cWxMQ0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25QV05zWVhWa1pTRHJxb1hyb0xrZzdKZUc3SjJNTEEwS0x5OGdKMk5zWVhWa1pTMXNiMmR2ZFhRblBXTnNZWFZrWmV1S2xDRHNub2pzcDREcnA0d2c2NkdjNnJlNDdKMjRJT3lFDQp1T3lGbUNEcnA0enJvNHdnS08yRXRDRHNpNlR0aktnZzdJdWNJT3F3a095bmdDd2c3SVN4NnJPMUlPMkV0T3lkdENEc21LVHJxYlFnN0o2UTY0K1pJTzJWdE95Z25Da05DaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzbnF6cm9aenF0N2pzbmJqc25iUWc3SldFNjR1STY1MjhJTzJWbk91UGhDRHNuYmpzZzRIQ3QrcXpoT3lnbFNEc29JVHRtWmdwRFFwc1pYUWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ2JuVnNiRHNOQ2k4dklPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBSU9LQWxDQkRURW5xc0lBZzY0SzA2NHFVSU95WWdleVd0Q0RzbmJqc3BwMGc3SmlrNjZXWTY2VzhJT3lDck91ZWpPeWR0Q0RzbFl6c2xZVHJrNlRzbllRZzdKV0k2NEswNjZHY0lPdXdsT3Erdk91THBDNE5DaTh2SUNoamJHRjFaR1VnTFMxMlpYSnphVzl1N0oyQUlPdWhuT3EzdU95ZHVDRHNsNGJzbmJUcg0KajRRZzdJU3g2ck8xN1pXMDdJU2NJT3lMbk91UG1TRHNvSkRxc29Ec25MenJvWnpyaXBRZzY2cTdJT3llb2Vxem9Dd2c3SXVrN0tDY0lPMkV0T3lYa095RW5PdW5qQ0RyazV6cm42enJncHpyaTZRcERRb3ZMeUFpNjZlTTY2T01JdXVuak95ZHRDRHNsWVRyaTRqcm5id2dJdTJWbkNEcnNvanJqNFFnNjZHYzZyZTQ3SjI0SU95VmlDRHRsYWdpNjQrRUlPcXdtZXlkZ0NEcXNyM3JvWnpyb1p3ZzdKNmg3WjZJNjYrQTY2R2NJT3lra2V1bXZTRHRrWnp0bUlUc25ZUWc3Sk8wNjR1a0RRcGpiMjV6ZENCTVQwZEpUbDlIVlVsRVJTQTlJQ2Z0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0N0oyMElPMlZoT3lhbE8yVnRPeWFsQ2pzbFlnZzY1Q1E2ckd3NjRLWUlPdW5qT3VqakNrZzRvQ1VJRnZ3bjUrZ0lPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c3WldFN0pxVVhTRHJzb1R0aXJ6c25ZUWc2NGlFNjZXMDY2bTBJT3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc3SmUwN0phMDY1T2M2NkNrN0pxVUxpYzdEUW92THlEc2k2VHMNCnVLSHRsWndnNjZ5NDZyV3M2NU9rT2lBaVJtRnBiR1ZrSUhSdklHRjFkR2hsYm5ScFkyRjBaVG9nVDBGMWRHZ2djMlZ6YzJsdmJpQmxlSEJwY21Wa0lHRnVaQ0JqYjNWc1pDQnViM1FnWW1VZ2NtVm1jbVZ6YUdWa0lpanJwNHpybzR3cExBMEtMeThnSWs1dmRDQnNiMmRuWldRZ2FXNGd3cmNnVUd4bFlYTmxJSEoxYmlBdmJHOW5hVzRpS091dnVPdWhuT3EzdU95ZHVDa2c0b0NVSU91Um1DRHJpNlFnN0o2aDdaNkk2cktNSU91RWsrMmVqT3VMcEEwS1puVnVZM1JwYjI0Z2FYTkJkWFJvUlhKeWIzSW9jeWtnZXcwS0lDQnlaWFIxY200Z0wyRjFkR2hsYm5ScFkyRjBmRzloZFhSb2ZHRndhU0JyWlhsOGJHOW5JRDlwYm54c2IyZG5aV1I4YzJWemMybHZiaUJsZUhCcGNtVmtMMmt1ZEdWemRDaFRkSEpwYm1jb2N5a3BPdzBLZlEwS0x5OGc3SUtzN0pxcElPMlZuT3VQaENEc3RJanFzN3dnNnJDUTdLZUFJT0tBbENEcm9aenF0N2pzbmJqc25ZQWc2Nm1BN0ttaDdaV2M2NDJ3SUNMcmpaUWc2NnE3SU95VHRPdUxwQ0xyDQppcFFnNnJLOTdKcXdMaURyb1p6cXQ3anNuYmdnNjZlTTY2T003Sm1BSU95aHNPeTVtT3F3Z0NEcmk2enJuYnpzaEp3ZzY1U3c2NkdjSU95ZW9ldUtsT3VMcEM0TkNpOHZJT3lMcE95NG9TZ3lNREkyTFRBNExDRHRtb3pzZ3F3ZzdKZVU3WVN3N1pTRTY1Mjg3SjIwN0thSUlPeWlqT3lFblNrNklDSlpiM1VuZG1VZ2FHbDBJSGx2ZFhJZ2FXNWthWFpwWkhWaGJDQnpjR1Z1WkNCc2FXMXBkQ0RDdHlCeWRXNGdMM1Z6WVdkbExXTnlaV1JwZEhNTkNpOHZJSFJ2SUdGemF5QjViM1Z5SUdGa2JXbHVJR1p2Y2lCaElHaHBaMmhsY2lCc2FXMXBkQ0lnNG9DVUlPcTBnT3Vtck95ZWtPcXdnQ0RzZ3F6cm5venJzNFRyb1p3ZzZyRzQ3SmEwSU91UmxDRHNnNEh0bFp6c25iVHJuYndnN1pTTTY1NmNJT3lDck95YXFldWZpZXlkdENEcmdxanNsWVRyajRRZzZyRzQ2NmF3NjR1a0xnMEtMeThnN0oyMElPeThnT3lkdE95S3BPcXdnQ0RzbDRicmpaZ2c3WU9UN0plUUlPeVlnZXlXdENEc201RHJyTGpzbmJRZzZyZTQ2NHlBNjZHYw0KSU8yR29PeUtwTzJLdU91UHZDQWk3Sm1jSU95VmlDRHJrSmpyaXBUc3A0QWlJT3lWakNEc2lKZ2c3SmVHN0plSTY0dWtLT3lMcE95Z25DRHNpNkRxczZBcExnMEtZMjl1YzNRZ1RFbE5TVlJmUjFWSlJFVWdQU0FuN1lHMDY2R2M2NU9jSU95Q3JPeWFxU0R0bFp6cmo0VHJwYndnNjR1a0lPeU52T3lXdE95YWxDRGlnSlFnN1pxTTdJS3NJT3F6aE95Z2xleWR0T3VwdENEcXRJRHJwcXpzbnBEc2w1RHFzb3dnN1pXYzY0K0U2Nlc4SU95WXJPdWdwQ0RyaTZ6cm5ienFzNkFnN0pxVTdMS3Q3WldZNnJPZ0xDRHNsWVRyaTRqcnFiUWdXL0NmbjZBZzdZRzA2NkdjNjVPY0lPMlZuT3VQaENEc3RJanFzN3hkSU91eWhPMkt2T3lkaENEcmlJenJuNndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxiUWc3S084N0lTNDdKcVVMaWM3RFFvdkx5QW43WldjNjQrRUordWhuQ0Rycllucm1ySHF0N2pycHF6cnFiUWc3SldJSU91UW5PdUxwQ0RpZ0pRZzdKNmc2cm1RSU91cXNPdW10Q0RybFl3ZzY0S1kNCjY0cVVJSEpoZEdVZ2JHbHRhWFRzbmJUcmdwZ2c2Nnk0NjZlbElPcTR1T3lkdENEc3RJanFzN3pxdVl6c3A0QWc3SjZoN0pXRURRb3ZMeURzbDRucm1ySHRsWmpxc293Z0l1dUxwT3VsdUNEcXM0VHNvSlhzbkx6cm9ad2c2NkdjNnJlNDdKMjQ3WldZNjUyOEl1cXpvQ0RzbFlqcmdyVHRsWmpxc293ZzY1Q2M2NHVrTGlEc3A0RHN0cHpDdCt5Q3JPeWFxZXVmaVNEc2c0SHRsWndnNjZ5NDZyV3M2NmVNSU95aWdlMllnT3lFbkNEcnM3anJpNlFOQ21aMWJtTjBhVzl1SUdselRHbHRhWFJGY25KdmNpaHpLU0I3RFFvZ0lISmxkSFZ5YmlBdmMzQmxibVFnYkdsdGFYUjhkWE5oWjJVdFkzSmxaR2wwYzN4MWMyRm5aU0JzYVcxcGRDQW9jbVZoWTJobFpIeGxlR05sWldSbFpDa3ZhUzUwWlhOMEtGTjBjbWx1WnloektTazdEUXA5RFFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqDQpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTno2Nlc4SU95ZHZleVd0QTBLTHk4Z0wyaGxZV3gwYU91aG5DRHJoYmpzdHB6dGxaenJpNlFnS08yVWpPdWZyT3EzdU95ZHVPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFFnN0tTUjdKMjQ3S2VBSWlEdGtaenNpNXdnNG9DVUlPcXp0ZXlhcVNCUVEreVhrT3lFbkNEcmdxanNuWmdnNnJPRTdLQ1ZJT3lZcE95Q3JPeWFxU0Ryc0tuc3A0QXBMZzBLTHk4ZzdZeU03SjI4N0oyMElPMkJ0Q0RzaUpnZzdKNkk3SmEwS08yVWhPdWhuT3lnbmUyS3VDRHNuYlRyb0tVZzdZK3M3WldvS1NBek1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdEUXBtZFc1amRHbHZiaUJqYkdGMVpHVkJZMk52ZFc1MA0KS0NrZ2V3MEtJQ0JwWmlBb1JHRjBaUzV1YjNjb0tTQXRJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQThJRE13TURBd0tTQnlaWFIxY200Z1lXTmpiM1Z1ZEVOaFkyaGxMbVZ0WVdsc093MEtJQ0JzWlhRZ1pXMWhhV3dnUFNCdWRXeHNPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3cwS0lDQWdJR1Z0WVdsc0lEMGdLR29nSmlZZ2FpNXZZWFYwYUVGalkyOTFiblFnSmlZZ2FpNXZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOektTQjhmQ0J1ZFd4c093MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyb1p6cXQ3anNuYmdnN0oyMDY2Q2xJT3lYaHV5ZGpDRHJrN0VnNG9DVUlHNTFiR3dnN0p5ZzdLZUFJQ292SUgwTkNpQWdZV05qYjNWdWRFTmhZMmhsSUQwZ2V5QmhkRG9nUkdGMFpTNXViM2NvS1N3Z1pXMWgNCmFXd2dmVHNOQ2lBZ2NtVjBkWEp1SUdWdFlXbHNPdzBLZlEwS1puVnVZM1JwYjI0Z1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LU0I3RFFvZ0lHTnZibk4wSUhCeWIySmxJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuTFMxMlpYSnphVzl1SjEwc0lIc2djMmhsYkd3NklIUnlkV1VzSUdWdWRqb2dRMHhCVlVSRlgwVk9WaUI5S1RzTkNpQWdiR1YwSUc5MWRDQTlJQ2NuT3cwS0lDQndjbTlpWlM1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXlCdmRYUWdLejBnWkM1MGIxTjBjbWx1WnlncE95QjlLVHNOQ2lBZ2NISnZZbVV1YjI0b0oyVnljbTl5Snl3Z0tDa2dQVDRnZXlCamJHRjFaR1ZUZEdGMGRYTWdQU0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25PeUI5S1RzTkNpQWdjSEp2WW1VdWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNOQ2lBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNBb1kyOWtaU0E5UFQwZ01DQW1KaUF2WEdRclhDNWNaQ3N2TG5SbGMzUW9iM1YwS1NrZ1B5QW5iMnNuDQpJRG9nSjJOc1lYVmtaUzF0YVhOemFXNW5KenNOQ2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnUTJ4aGRXUmxJRU52WkdVZzdLQ1E2cktBT2lBbklDc2dZMnhoZFdSbFUzUmhkSFZ6SUNzZ0tHOTFkQ0EvSUNjZ0tDY2dLeUJ2ZFhRdWRISnBiU2dwSUNzZ0p5a25JRG9nSnljcEtUc05DaUFnZlNrN0RRcDlEUW92THlEc3NwanJwcXdnN1ppRTdabXBJT0tBbENBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVnRDQWk3S0NWNjZlUUlPMkJ0T3Vobk91VG5PcXdnQ0RyaTdYdGxvanJpcFRzcDRBaUlPdXdsdXlYa095RW5DRHRtWlhzbmJqdGxhQWc3SWlZSU95ZWlPcXlqQ0R0bFp6cmk2UU5DbU52Ym5OMElITjBZWFJ6SUQwZ2V5QnpaWEoyWldRNklEQXNJR3hoYzNSQmREb2dKeWNzSUd4aGMzUlVaWGgwT2lBbkp5d2diR0Z6ZEZObFl6b2dKeWNnZlRzTkNnMEtMeThnNHBTQTRwU0FJTzJVak91ZnJPcTN1T3lkdUNEc2c1M3NvYlFnNnJDUTdLZUFLT3lMck95ZXBldXdsZXVQbVNrZzRwU0E0cFNBNHBTQQ0KNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FEUW92THlEdGxJenJuNnpxdDdqc25ianNuYlFnNjVhZ0lPeWVpT3VLbENEcmo1bnNsWWdnWTI5a1pTNTBjK3F3Z0NBMTdMU0k2NmVJNjR1a0lGQlBVMVFnTDJobFlYSjBZbVZoZE91bHZDRHJzN1RyZ3Jqcmk2UXVEUW92THlEdGxad2c2N0tJN0oyMDY1Mjg2NCtFSU91d20reWRnQ0Rya3FRZ016RHN0SWpxc0lRZzY0R0s2cml3NjZtMElPMlVqT3Vmck9xM3VPeWR1Q2pybUpEcmlwUWc3WlM4NnJlNDY2ZUlLZXlkdENEcmk2dnRub3dnNnJLRElPS0FsQ0R0Z2JUcm9aenJrNXpxdVl6c3A0QWc2NDJ3NjZhczZyT2dJT3F3bWV5ZHRDRHF1cnpzcDRUcmk2UXVEUW92THlEc2xZVHNwNEVnN1pXY0lPdXlpT3VQaENEcnFyc2c2N0NiN0pXWTdKeTg2Nm0wS091THBPdW1yT3VuakNEcnFMenNvSUFnN0x5Z0lPeURnZTJEbkN3ZzdKNlENCjY0K1o3SXVjN0o2UklPdVRzU2tnNnJPRTdJYU5JT3VNZ09xNHNPMlZuT3VMcEM0TkNtTnZibk4wSUVoRlFWSlVRa1ZCVkY5RVJVRkVYMDFUSUQwZ016QXdNREE3RFFwc1pYUWdiR0Z6ZEVKbFlYUWdQU0F3T3cwS2MyVjBTVzUwWlhKMllXd29LQ2tnUFQ0Z2V3MEtJQ0JwWmlBb2JHRnpkRUpsWVhRZ0ppWWdSR0YwWlM1dWIzY29LU0F0SUd4aGMzUkNaV0YwSUQ0Z1NFVkJVbFJDUlVGVVgwUkZRVVJmVFZNcElIc05DaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNNNjUrczZyZTQ3SjI0SU95THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBZzRvQ1VJTzJVdk9xM3VPdW5pQy90bEl6cm42enF0N2pzbmJqc25iUWc2NHVyN1o2TUlPcXlnK3ljdk91aG5DRHJzN1RxczZBZzZyQ1o3SjIwSU9xNnZPeW5rZXVMaU91THBDNG5LVHNOQ2lBZ0lDQndjbTlqWlhOekxtVjRhWFFvTUNrN0lDOHZJR1Y0YVhRZzdaVzQ2NU9rNjUrczZyQ0FJR3RwYkd4UWNtOWo3Snk4NjZHY0lHTnNZWFZrWlNEdGlyanJwcXpyDQpwYndnN0tDVjY2YXM3WldjNjR1a0RRb2dJSDBOQ24wc0lEVXdNREFwT3cwS0RRb3ZMeURpbElEaWxJQWdRbEpQVjFORlVpRHFzSURyb1p6c3NZVHF1TERyaXBRZzdLQ2M2ckd3NjVDUTY0dWtJQ2d5TURJMkxUQTRMQ0JDVWtsRVIwVmZWajB5TlNrZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBRFFvdkx5RHNtSWpzb0lUc2w1UWdRbEpQVjFORlVpRHRtWmpxc3IzcnM0RHNpSmpzbDVBZzdKNkU3SXVjSU95S3BPMkJyT3VtdmUyS3VPdWx2Q0RxdllMc2xZUWdRMHhKNnJDQUlPeWtnQ0JoZFhSb2IzSnBlbVVnVlZKTTdKMkVJT3lhc091bXJPcXdnQ0Ryc0p2c2xZVHNoSndnN0plMDdKZUk2NHVrTGcwS0x5OGc2NnFwN0tDQjdKMkFJTzJWbU91Q21PdS9rT3lkdE95WGlPdUxwQ0RpZ0pRZzZyT0U3S0NWSU95Z2hPMlptT3lhcWV5Y3ZPdWhuQ0JWVWt6c25ZUWdZMnhoZFdSbExtRnBMMnh2WjI5MWREOXlaWFIxY201VWJ6M2lnS2Jyb1p3ZzdKNnM3SjZSN0lTeA0KN1pXMERRb3ZMeURzaXJuc25iZ2c3Wm1VNjZtMDdKMkVJT3F4dE91RWlPdWJzT3F6b0NEcXM0VHNvSlVnN0lTZzdZT2RJTzJabE91cHRPeVhrQ0RzcDRIdGxvbnNpNXp0Z3FUcXVMQXVJT3EzdUNEc25xenNucEhzaExIc25ZUWc3WStRNnJpdzdaV1k3SjZRS095Q3JPeWFxZXlla0NEcXNyRHNvSlVwSU8yVnVPdVRwT3Vmck91S2xBMEtMeThnNjZxcDdLQ0I3SjIwSU95WGh1eVd0T3loak9xem9Dd2dLaXJyZ3FqcXNxZ2c2NUdRNjZtMElPeVlwTzJlaU91Z3BDRHJvWnpxdDdqc25ianNuWVFnNjZlZDZyQ0E2NXlvNjZhdzY0dWtLaW82RFFvdkx5QWdJRU5NU2Vxd2dDQlZVa3pzbllRZzY1U3c3SmkwN1pHY0lPeVhodXlkdENEcmhKanF1TERycWJRZ1kyMWs2ckNBSUdBbVlPeVhrT3lFbkNCVlVrenNuWVFnN0o2WTY1MjhJT3V5aE91Z3BDanNuSWpyajRUc21yQXBJR05zYVdWdWRGOXBaQ0Rxc0puc25ZQWc2NUtrN0txOURRb3ZMeUFnSU91bnBPcXduT3V6Z095SW1PcXdnQ0RzZ3F6cm5ienNwNERxczZBc0lPdTQNCmpPdWR2T3lhc095Z2dPeVhsQ0FpN0o2WTY2cTc2NUNjSUU5QmRYUm9JT3lhbE95eXJTREN0eUJqYkdsbGJuUmZhV1FnNjZlazZyQ2M2N09BN0lpWTZyQ0FJT3VJaE91ZHZldVFtT3lYaU95S3RldUxpT3VMcENMcXNJQWc2NXlzNjR1a0xnMEtMeThnSUNEc2k2enRsWmpycWJRZzY3aU02NTI4N0pxdzdLQ0E2ckNBSU95VmhPeVlpQ0RzbFlnZzdKZTA2NmF3NjR1a0tPeUxwT3k0b1NBeU1ESTJMVEE0T2lCRFRFa2c3WlNFNjZHYzdJUzQ3SXFrNjRxVUlPdU1nT3E0c0NEc3BKSHNuYmpyamJBZzdMQzk3SjIwSU95VmlDRHJuTGdwTGcwS0x5OGc3SjIwN0tDY0lFSlNUMWRUUlZMcnBid2c2ckcwNjVPYzY2YXM3S2VBSU95Vml1dUtsT3VMcENEaWhwSWdZMnhoZFdSbElFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN0RyaTZRb1EweEpJT3E0c091enVDRHJqNW5zbnBFcExnMEtMeThnS2lyc25iUWc2cks5NjZHYzdKZVFJRlZTVENEcXNJRHFzN1hDdCt5a2tlcXdoQ0RzDQppcVR0Z2F6cnByM3RpcmpycGJ3ZzY0dWs3SXVjSU91RW8reW5nQ0RycDVBZzZyS0RMaW9xSU9xemhPeWdsU0Rzb0lUdG1aanNuWUFnN0lxNTdKMjRJTzJabE91cHRDRHRsWmpyaTZnZ1crcXpoT3lnbFNEc29JVHRtWmhkSU91eWhPMkt2T3ljdk91aG5DNE5DZzBLTHk4ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1Q0R0bElUcm9aenNoTGpzaXFRZ0tHTnNZWFZrWlNCaGRYUm9JR3h2WjJsdUlDMHRZMnhoZFdSbFlXa3BJT0tBbENBdmIzQmxiaTFzYjJkcGJ1eWR0Q0RzZzUzc2hMSEN0K3EwZ091bXJDNE5DaTh2SU91NGpPdWR2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPdXp0T3VDdE95a2hDRHJsWXpxdVl6c3A0QWc3SWlvN0phMDdJU2NJT3VNZ09xNHNPMlZtT3VMcE9xd2dDd2c3Sm1FNjZPTTY1Q1k2Nm0wSU95S3BPeUtwT3VobkNEcmdaM3JncHpyaTZRdURRcHNaWFFnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNOQ214bGRDQnNiMmRwYmxCeWIyTlVhVzFsY2lBOQ0KSUc1MWJHdzdEUXBzWlhRZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNBd095QXZMeURydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeUxuT3lla1NEc2k1enFzSUVnNG9DVUlPeWVyTzJCdE91bXJleWR0Q0FuN0o2czdJdWM2NCtFSit5ZHVPeW5nQ0FuN0o2UTY0K1o3Sm1FNjZPTUlPeUxwTzJNcUNmc25ianNwNEFnNnJXczY3YUU3WldjNjR1a0RRcG1kVzVqZEdsdmJpQnJhV3hzVEc5bmFXNVFjbTlqS0NrZ2V3MEtJQ0JwWmlBb2JHOW5hVzVRY205alZHbHRaWElwSUhzZ1kyeGxZWEpVYVcxbGIzVjBLR3h2WjJsdVVISnZZMVJwYldWeUtUc2diRzluYVc1UWNtOWpWR2x0WlhJZ1BTQnVkV3hzT3lCOURRb2dJR2xtSUNnaGJHOW5hVzVRY205aktTQnlaWFIxY200N0RRb2dJR052Ym5OMElIQWdQU0JzYjJkcGJsQnliMk03RFFvZ0lHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNOQ2lBZ0lDQWcNCklITndZWGR1VTNsdVl5Z25kR0Z6YTJ0cGJHd25MQ0JiSnk5UVNVUW5MQ0JUZEhKcGJtY29jQzV3YVdRcExDQW5MMVFuTENBbkwwWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0RRb2dJQ0FnZlNCbGJITmxJSHNOQ2lBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0M1d2FXUXNJQ2RUU1VkVVJWSk5KeWs3SUgwZ1kyRjBZMmdnS0Y5bE1pa2dleUJ3TG10cGJHd29LVHNnZlEwS0lDQWdJSDBOQ2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIME5DbjBOQ2cwS0x5OGc3WVMwSU91UGhPeWtrU0R0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lqdmV5WGlPeWRoQ0RybFl6c25aZ2c3SXVrN1l5b0lPdXBsT3lMbk95bmdDRGlnSlFnY25WdVZIVnlidXlkdENEc25iUWc2Nm1VN0l1YzdLZUE3SjI4SU91VmpPdW5qQ0F4N1pxTUlPeWVrT3VQbVNEc25xenNpNXpyajRUdGxaenJpNlFOQ21OdmJuTjBJRk5GVTFOSlQwNWZSRWxGUkNBOUlDZnRnYlRyDQpvWnpyazV3ZzdJUzQ3SVdZN0oyMElPeWloZXVqak91UWtPeVd0T3lhbEM0bk93MEtiR1YwSUhOb2RYUjBhVzVuUkc5M2JpQTlJR1poYkhObE95QXZMeUF2YzJoMWRHUnZkMjRnN0tlRTdaYUpJT3lra1NEaWdKUWc3SjZzN0l1YzY0K0U2NkdjSU95RXVPeUZtT3lkaENEcmtKanNnclRycHF6c3A0QWc3SldLNnJLTUlPMlJuT3lMbkEwS0RRb3ZMeUJ5WldGemIyN3NuWVFnN0tPODY2bTBJQ2Zzblpqcmo0VHNvSUVnN0tLRjY2T01KeWpxczRUc29KVWc3S0NFN1ptWXdyZnJvWnpxdDdqc2xZVHNtNE1nNjVPeEtTRGlnSlFnN0tlRTdaYUpJT3lra2V5ZHRPdU5tQ0R0aExUc25ZUWc2cmU0SU91cGxPeUxuT3luZ091aG5DRHJnWjNyZ3JUc2hKd05DaTh2SUhKMWJsUjFjbTdzblpnZ1UwVlRVMGxQVGw5RVNVVkVJT3lla091UG1TRHNucXpzaTV6cmo0VHFzSUFnN0ppYklPeWVrT3F5cWV5bW5ldXFoZXljdk91aG5DRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2YXM3S2VBSU95Vml1cXlqQ0R0bFp6cmk2UXVEUW92THlBbw0KN0pXSUlPcTN1T3Vmck91cHRDRHFzNFRzb0pVZzdLQ0U3Wm1ZSU95bmdlMmJoQ0RzbUpzZzZyT0U3S0NWSU95RXVPeUZtT3lkdENEcnRvRHRtWnp0bGJRZ1RVRllYMVJWVWs1VDZybU03S2VBSU9xemhPeUdqU0RzazdEc25iVHJpcFFnNjdLRTZyZTRJT0tBbENBeU1ESTJMVEEzSU91bXJPdTNzT3lYa095RW5DRHRtWlhzbmJncERRcG1kVzVqZEdsdmJpQnJhV3hzVUhKdll5aHlaV0Z6YjI0cElIc05DaUFnYVdZZ0tIQnliMk1wSUhzTkNpQWdJQ0IwY25rZ2V3MEtJQ0FnSUNBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzTkNpQWdJQ0FnSUNBZ0x5OGdjMmhsYkd3NmRISjFaZXVobkNEcm5ZVHNtNHpzaEp3Z2NISnZZK3lkZ0NCamJXUWc2cnVONjQydzZyaXdJT0tBbENBdlZPdWhuQ0R0aXJqcnBxenNwN2dnN0tPOTdKZXM3Slc4SU95bmhPeW5uQ0JqYkdGMVpHWHFzSUFnNnJPZzdKV0U2NkdjSU95VmlDRHJncWpyaXBUcmk2UU5DaUFnSUNBZ0lDQWdMeThnS09xem9PeVYNCmhDQmpiR0YxWkdYcXNJQWc3SVNrN0xtWUlPMk1qT3lkdk95ZGhDRHJyTHpxczZBZzdKNkk3Snk4NjZtMElPMkJ0T3Vobk91VG5DRHNsYkVnN0plRjY0Mnc3SjIwN1lxNDZyQ0FJQ0xzZ3F6c21xa2c3S1NSSXV5Y3ZPdWhuQ0RycDRudG5wZ3BEUW9nSUNBZ0lDQWdJSE53WVhkdVUzbHVZeWduZEdGemEydHBiR3duTENCYkp5OVFTVVFuTENCVGRISnBibWNvY0hKdll5NXdhV1FwTENBbkwxUW5MQ0FuTDBZblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3RFFvZ0lDQWdJQ0I5SUdWc2MyVWdldzBLSUNBZ0lDQWdJQ0F2THlCdFlXTlBVeS9ycHF6cmlJWHNpcVE2SUhOb1pXeHNPblJ5ZFdYcm5id2djSEp2WSt5ZHRDQnphQ0RxdTQzcmpiRHF1TERzbmJ3ZzdJaVlJT3llaU95ZGpDRGlnSlFnYzNSaGNuUlFjbTlqN0oyWUlHUmxkR0ZqYUdWazY2R2NJT3Vuak91VG9BMEtJQ0FnSUNBZ0lDQXZMeUR0bElUcm9aenNoTGpzaXFRZzZyZTQ2Nk81S0Mxd2FXUXA3SjJFSU8yR3RleW51T3VobkNEc29KWHJwcXp0DQpsWnpyaTZRZ0tIUmhjMnRyYVd4c0lDOVVJT3VNZ095ZGtTa05DaUFnSUNBZ0lDQWdkSEo1SUhzZ2NISnZZMlZ6Y3k1cmFXeHNLQzF3Y205akxuQnBaQ3dnSjFOSlIxUkZVazBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3SUhCeWIyTXVhMmxzYkNncE95QjlEUW9nSUNBZ0lDQjlEUW9nSUNBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIME5DaUFnZlEwS0lDQndjbTlqSUQwZ2JuVnNiRHNOQ2lBZ2QyRnliV1ZrVlhBZ1BTQm1ZV3h6WlRzTkNpQWdhV1lnS0hkaGFYUmxjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9kMkZwZEdWeUxuUnBiV1Z5S1RzZ2QyRnBkR1Z5TG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvY21WaGMyOXVJSHg4SUZORlUxTkpUMDVmUkVsRlJDa3BPeUIzWVdsMFpYSWdQU0J1ZFd4c095QjlEUXA5RFFvTkNtWjFibU4wYVc5dUlITjBZWEowVUhKdll5Z3BJSHNOQ2lBZ2EybHNiRkJ5YjJNb0tUc05DaUFnYkdsdVpVSjFaaUE5SUNjbk93MEtJQ0IwZFhKdWN5QTlJREE3RFFvZw0KSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c3SVM0N0lXWUlPeUxuT3VQbVNEc3BKSGlnS1lnS091cXFPdU51RG9nSnlBcklHTjFjbkpsYm5STmIyUmxiQ0FySUNjcEp5azdEUW9nSUdOdmJuTjBJSFJvYVhOUWNtOWpJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuTFhBbkxDQW5MUzF0YjJSbGJDY3NJR04xY25KbGJuUk5iMlJsYkN3Z0p5MHRhVzV3ZFhRdFptOXliV0YwSnl3Z0ozTjBjbVZoYlMxcWMyOXVKeXdnSnkwdGIzVjBjSFYwTFdadmNtMWhkQ2NzSUNkemRISmxZVzB0YW5OdmJpY3NJQ2N0TFhabGNtSnZjMlVuWFN3Z2V3MEtJQ0FnSUhOb1pXeHNPaUIwY25WbExDQmpkMlE2SUVWTlVGUlpYME5YUkN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTEEwS0lDQWdJR1JsZEdGamFHVmtPaUJ3Y205alpYTnpMbkJzWVhSbWIzSnRJQ0U5UFNBbmQybHVNekluTENBdkx5QlFUMU5KV0RvZzdKNlE2cml3SU8yVWhPdWhuT3lFdU95S3BDRHF0N2pybzdrZzdJT2Q3SVN4SU9LQWxDQnINCmFXeHNVSEp2WSt5ZHRDRHF0N2pybzduc3A3Z2c3S0NWNjZhczdaV2dJT3lJbUNEc25vanFzb3dOQ2lBZ2ZTazdEUW9nSUhCeWIyTWdQU0IwYUdselVISnZZenNOQ2lBZ2NISnZZeTV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdldzBLSUNBZ0lHeHBibVZDZFdZZ0t6MGdaQzUwYjFOMGNtbHVaeWduZFhSbU9DY3BPdzBLSUNBZ0lHeGxkQ0JwWkhnN0RRb2dJQ0FnZDJocGJHVWdLQ2hwWkhnZ1BTQnNhVzVsUW5WbUxtbHVaR1Y0VDJZb0oxeHVKeWtwSUNFOVBTQXRNU2tnZXcwS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlHeHBibVZDZFdZdWMyeHBZMlVvTUN3Z2FXUjRLUzUwY21sdEtDazdEUW9nSUNBZ0lDQnNhVzVsUW5WbUlEMGdiR2x1WlVKMVppNXpiR2xqWlNocFpIZ2dLeUF4S1RzTkNpQWdJQ0FnSUdsbUlDZ2hiR2x1WlNrZ1kyOXVkR2x1ZFdVN0RRb2dJQ0FnSUNCc1pYUWdaWFlnUFNCdWRXeHNPdzBLSUNBZ0lDQWdkSEo1SUhzZ1pYWWdQU0JLVTA5T0xuQmhjbk5sS0d4cGJtVXBPeUI5DQpJR05oZEdOb0lDaGZaU2tnZXlCamIyNTBhVzUxWlRzZ2ZRMEtJQ0FnSUNBZ2FXWWdLR1YySUNZbUlHVjJMblI1Y0dVZ1BUMDlJQ2R5WlhOMWJIUW5JQ1ltSUhkaGFYUmxjaWtnZXcwS0lDQWdJQ0FnSUNCamIyNXpkQ0IzSUQwZ2QyRnBkR1Z5T3cwS0lDQWdJQ0FnSUNCM1lXbDBaWElnUFNCdWRXeHNPdzBLSUNBZ0lDQWdJQ0JqYkdWaGNsUnBiV1Z2ZFhRb2R5NTBhVzFsY2lrN0RRb2dJQ0FnSUNBZ0lHbG1JQ2hsZGk1cGMxOWxjbkp2Y2lrZ2V3MEtJQ0FnSUNBZ0lDQWdJR052Ym5OMElISmhkeUE5SUZOMGNtbHVaeWhsZGk1eVpYTjFiSFFnZkh3Z1pYWXVjM1ZpZEhsd1pTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z01qQXdLVHNOQ2lBZ0lDQWdJQ0FnSUNBdkx5RHRsWnpyajRRZzdMU0k2ck84NjZXOElPdW92T3lnZ0NEcnM3anJpNlFnNG9DVUlPdWhuT3EzdU95ZHVDRHNtS1RycFpnZzdLQ1Y2cmVjN0l1ZDdKMjBJT3VFayt5V3RPeUVuQ2hzYjJjZ1AybHVJT3VUc1NrZzY2eTQ2cldzNnJDQUlPdXdsT3VBak91cA0KdENEc2dyenRncXdnN0lpWUlPeWVpT3VMcEEwS0lDQWdJQ0FnSUNBZ0lHbG1JQ2hwYzB4cGJXbDBSWEp5YjNJb2NtRjNLU2tnZXcwS0lDQWdJQ0FnSUNBZ0lDQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ0oyTnNZWFZrWlMxc2FXMXBkQ2M3SUM4dklDOW9aV0ZzZEdqcm9ad2c3SldNNjZhOElPS0draURyc29UdGlyenNuYlFnVysyVm5PdVBoQ0RzdElqcXM3eGQ2NkdjSU91d2xPdUFqT3F6b0NEcXM0VHNvSlVnN0tDRTdabVk3SjJFSU95VmlPdUN0QTBLSUNBZ0lDQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzZ3F6c21xa2c3WldjNjQrRUlPeTBpT3F6dkNEcXNKRHNwNEE2Snl3Z2NtRjNLVHNOQ2lBZ0lDQWdJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpaE1TVTFKVkY5SFZVbEVSU2twT3cwS0lDQWdJQ0FnSUNBZ0lIMGdaV3h6WlNCcFppQW9hWE5CZFhSb1JYSnliM0lvY21GM0tTa2dldzBLSUNBZ0lDQWdJQ0FnSUNBZ1kyeGhkV1JsVTNSaGRIVnoNCklEMGdKMk5zWVhWa1pTMXNiMmR2ZFhRbk95QXZMeUF2YUdWaGJIUm82NkdjSU8yVWpPdWZyT3EzdU95ZHVPeVhrQ0RzbFl6cnByd2c0b2FTSU91eWhPMkt2T3lkdENCYjY2R2M2cmU0N0oyNElPMlZoT3lhbEYzcm9ad2c2N0NVNjRDY0RRb2dJQ0FnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBT2ljc0lISmhkeWs3RFFvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9URTlIU1U1ZlIxVkpSRVVwS1RzTkNpQWdJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2V3MEtJQ0FnSUNBZ0lDQWdJQ0FnZHk1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0NmdGdiVHJvWnpyazV3ZzdKaWs2NldZT2lBbklDc2djbUYzS1NrN0RRb2dJQ0FnSUNBZ0lDQWdmUTBLSUNBZ0lDQWdJQ0I5SUdWc2MyVWdldzBLSUNBZ0lDQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2R2YXljN0lDOHZJT3lFc2VxenRTQTlJT3lFDQpwT3k1bU1LMzY2R2M2cmU0N0oyNElPdUxwQ0Rzb0pYc2c0RWc0b0NVSU95V3RPdVdwQ0J3Y205aWJHVnQ3SjIwNjVPZ0lPMlZ0T3lnbkNBbzdKNnM2NkdjNnJlNDdKMjRMK3llck95RXBPeTVtQ0RyczdYcXQ0QXBEUW9nSUNBZ0lDQWdJQ0FnZHk1eVpYTnZiSFpsS0ZOMGNtbHVaeWhsZGk1eVpYTjFiSFFnZkh3Z0p5Y3BLVHNOQ2lBZ0lDQWdJQ0FnZlEwS0lDQWdJQ0FnZlEwS0lDQWdJSDBOQ2lBZ2ZTazdEUW9nSUhCeWIyTXVjM1JrWlhKeUxtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc05DaUFnSUNCamIyNXpkQ0J6SUQwZ1pDNTBiMU4wY21sdVp5Z25kWFJtT0NjcExuUnlhVzBvS1RzTkNpQWdJQ0JwWmlBb2N5QW1KaUFoY3k1cGJtTnNkV1JsY3lnblJHVndjbVZqWVhScGIyNVhZWEp1YVc1bkp5a3BJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCamJHRjFaR1VnYzNSa1pYSnlPaWNzSUhNdWMyeHBZMlVvTUN3Z01qQXdLU2s3RFFvZ0lIMHBPdzBLSUNCd2NtOWpMbTl1S0NkamJHOXpaU2NzSUNoag0KYjJSbEtTQTlQaUI3RFFvZ0lDQWdMeThnN0oyMDY2KzRJT3lEaUNEc2hManNoWmpzbkx6cm9ad2c2cldRN0xLMDY1Q2NJT3VTcENEc21Kc2c3SVM0N0lXWTdKMjBJT3VMcSsyZWpDRHFzYkRycWJRZzY2eTA3SXVjSUNqcnFxanJqYmdnN0tDRTdabVlJT3lMbkNEc2c0Z2c3SVM0N0lXWTdKMkVJT3lqdmV5ZHRPeW5nQ0RzbFlycXNvd3BEUW9nSUNBZ2FXWWdLSEJ5YjJNZ0lUMDlJSFJvYVhOUWNtOWpLU0J5WlhSMWNtNDdEUW9nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c3S0tGNjZPTUlDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a2c0b0NVSU91THBPeWRqQ0RzbXBUc3NxMGc2NVdNSU91THBPeUxuQ0RzaTV6cmo1bnRsYW5yaTRqcmk2UXVKeWs3RFFvZ0lDQWdhMmxzYkZCeWIyTW9LVHNOQ2lBZ2ZTazdEUXA5RFFvTkNtWjFibU4wYVc5dUlITmxibVJVZFhKdUtIUmxlSFFwSUhzTkNpQWdjbVYwZFhKdUlHNWxkeUJRY205dGFYTmxLQ2h5WlhOdmJIWmwNCkxDQnlaV3BsWTNRcElEMCtJSHNOQ2lBZ0lDQnBaaUFvSVhCeWIyTXBJSEpsZEhWeWJpQnlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lYaHV5V3RPeWFsQzRuS1NrN0RRb2dJQ0FnYVdZZ0tIZGhhWFJsY2lrZ2NtVjBkWEp1SUhKbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSit5Vm51eUVvQ0RzbXBUc3NxM3NuYlFnN0tlRTdaYUpJT3lra2V5ZHRPeVhrT3lhbEM0bktTazdEUW9nSUNBZ1kyOXVjM1FnZEdsdFpYSWdQU0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGhMUWc3SXVjNnJDRUlPeTBpT3F6dkNEaWdKUWc3SVM0N0lXWTdKMkVJT3llck95TG5PeWVrZTJWcWV1TGlPdUxwQzRuS1RzTkNpQWdJQ0FnSUM4dklPeUxuT3F3aENEc3RJanFzN3pyaXBRZ0oreUV1T3lGbUNEc29vWHJvNHduN0ptQUlPcTFyT3UyaE91UW1PdUtsQ0Rzb0p3ZzY2bVU3SXVjN0tlQTY2R2NJT3VCbmV1Q3VPdUxwQ0RpDQpnSlFnYTJsc2JGQnliMlBzblpnZzdJUzQ3SVdZSU95aWhldWpqQ0J5WldwbFkzVHFzSUFOQ2lBZ0lDQWdJQzh2SUhKMWJsUjFjbTdzblpnZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE91bHZDRHJ0b0RycGJUcnFiUWc3SldJSU91UW1PcTRzQ0RybFl6cnJMZ282NHFRNjZhd0lPMkV0T3lkaENEcmtaQWc2N0tJSU91UGpPdXB0Q0R0bEl6cm42enF0N2pzbmJnZ01UTXc3TFNJSU95Z25PMlZuT3lkaENEcmhKanF1TFRyaTZRcERRb2dJQ0FnSUNCcFppQW9kMkZwZEdWeUtTQjdEUW9nSUNBZ0lDQWdJR052Ym5OMElIY2dQU0IzWVdsMFpYSTdJSGRoYVhSbGNpQTlJRzUxYkd3N0RRb2dJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243WUcwNjZHYzY1T2NJT3lka2V1THRleWR0Q0RyaElqcnJMUWc3SmlrNjU2WUlPcXh1T3VncENEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5LU2s3RFFvZ0lDQWdJQ0I5RFFvZw0KSUNBZ0lDQnJhV3hzVUhKdll5Z3BPdzBLSUNBZ0lIMHNJRlJWVWs1ZlZFbE5SVTlWVkY5TlV5azdEUW9nSUNBZ2QyRnBkR1Z5SUQwZ2V5QnlaWE52YkhabExDQnlaV3BsWTNRc0lIUnBiV1Z5SUgwN0RRb2dJQ0FnY0hKdll5NXpkR1JwYmk1M2NtbDBaU2hLVTA5T0xuTjBjbWx1WjJsbWVTaDdJSFI1Y0dVNklDZDFjMlZ5Snl3Z2JXVnpjMkZuWlRvZ2V5QnliMnhsT2lBbmRYTmxjaWNzSUdOdmJuUmxiblE2SUhSbGVIUWdmU0I5S1NBcklDZGNiaWNzSUNkMWRHWTRKeWs3RFFvZ0lIMHBPdzBLZlEwS0RRb3ZMeURxc0puc25ZQWc2Nnk0NnJXczY2VzhJT3VxaHlEcnNvanNwN2dnNjZ5NzY0cVU3S2VBSU9xNHNPeVd0U0RpZ0pRZzdKNnM3SnFVN0xLdDdKMjA2Nm0wSUNMc25iVHNvSVRxczd3ZzY0dWs2Nlc0SU95RGlDRHNvSnpzbFlnaTdKMkVJT3lhbE9xMXJPMlZuT3VMcEEwS0x5OGdLT3lWaUNEcXQ3anJuNnpycWJRZzdZRzA2NkdjNjVPYzZyQ0FJT3lFc2V5THBPMlZtT3F5akNEcXNKbnNuWUFnNjR1MTdKMkUNCklPdVlrQ0RyZ3JUc2hKd2dXMEZKSU95MmxPeXluQ0RyalpRZzY3Q2I2cml3WGVxd2dDRHJyTFRzblpqcnI3anRsYlRzcDRUcmk2UXBEUXBqYjI1emRDQmhjMnRsWkVOdmRXNTBJRDBnYm1WM0lFMWhjQ2dwT3cwS0RRb3ZMeURzaExqc2haZ2c3S1NBNjdtRUtPeUxuT3VQbVN2c3A0RHNpNXpyckxnZzdLTzg3SjZGS2V1bHZDRHJzN1RzbnFYdGxad2c2NUtrSU8yVm5DRHRoTFFnN0l1azdaYUpJT0tBbENEcnFxanJrNkFnN1ppNDdMYWM3SjJBSUhGMVpYVmw2NkdjSU95bmdldWdyTzJabEM0TkNpOHZJRzF2WkdWczdKMkVJT3lqdk91cHRDRHF0N2dnNjZxbzY0MjQ2NkdjSUNqcmk2VHJwYlRycWJRZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NrdUlPMlZuQ0RycXFqcmpianNuWVFnNnJPRTdJYU5JT3lUc091cHRDRHNucXpzaTV6c25wSHNuWUFnN0xXYzdMU0lJREh0bW96cnY1QXVEUW92THlCeVpYQmhjbk5sUFh0d1lYSnpaU3dnWm05eWJXRjBSR1Z6WTMzcnBid2c3S084NjZtMElPMk1qT3lMc2VxNWpPeW5nQ0RzDQpuYlFnN0o2aElPeVZpT3lYa095RW5DRHNzcGpycHF6dGxaanFzNkFnZTNKaGR5d2djR0Z5YzJWa2ZldWx2Q0RyajR6cm9LVHNwSURyaTZRNkRRb3ZMeUR0bUpYc2k1MGc3SjIwN1lPSUlPeUxuQ0Rxc0puc25ZQWc3SVM0N0lXWTdKZVFJQ0x0bUpYc2k1M3JqSURyb1p3ZzY0dWs3SXVjSXV1bHZDRHNtcFRxdGF6dGxaanJpcFFnN0o2czdKcVU3TEt0SU8yRXRPeWRoQ0FxS3Vxd21leWRnQ0R0Z1pBZzdKNmhJT3lWaU95WGtPeUVuQ29xSU91Mm1leWR1T3VMcEM0TkNpOHZJT3V6aE91UGhDRHNucUhzbkx6cm9ad2c2N204NjZtMElDaGhLU0RzZ3F6c25iVHNsNUFnNjR1azY2VzRJT3lhbE95eXJTRHRoTFRzbmJRZzY0Rzg3SmEwSUNmcnNLbnF1SWdnNjR1MUoreWR0Q0RyZ3Fqc25aZ2c2NHUxN0oyMElPdVFtT3F6b0NqcmdyVHNtcWtnN0ppazdKZThLU3dOQ2k4dklDaGlLU0JOUVZoZlZGVlNUbE1nNnJLOTZyT0U3SmVRN0lTY0lPeUV1T3lGbU95ZHRDRHNucXpzaTV6c25wSHJqN3dnSit1d3FlcTRpQ0RyaTdVbg0KN0oyMElPeVhodXVLbENEc2c0Z2c3SVM0N0lXWTdKMjBJT3VDdE95YXFleWRoQ0RzcDREc2xyVHJncndnN0lpWUlPeWVpT3VMcENBb01qQXlOaTB3TnlEcnBxenJ0N0RzbDVEc2hKd2c3Wm1WN0oyNEtTNE5DbU52Ym5OMElGSkZVRUZTVTBWZlFrRkVJRDBnS0hZcElEMCtJSFlnUFQwZ2JuVnNiQ0I4ZkNBb1FYSnlZWGt1YVhOQmNuSmhlU2gyS1NBbUppQjJMbXhsYm1kMGFDQTlQVDBnTUNrN0RRcG1kVzVqZEdsdmJpQnlkVzVVZFhKdUtHSjFhV3hrUVhOckxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrZ2V3MEtJQ0JqYjI1emRDQnFiMklnUFNCeGRXVjFaUzUwYUdWdUtHRnplVzVqSUNncElEMCtJSHNOQ2lBZ0lDQmpiMjV6ZENCcWIySlRkR0Z5ZENBOUlFUmhkR1V1Ym05M0tDazdJQzh2SU95TG5PcXdoQ0RzbUlqc2dyQWc0b0NVSU8yVWpPdWZyT3EzdU95ZHVDRHNxcjBnN0tDYzdaV2NLREV6TU95MGlDbnNuWVFnNjRTWTZyaTRJT3llck95TG5PdVBoT3VLbENEdGo2enF1TER0bFp6cmk2UU5DaUFnSUNCcFppQW8NCmJXOWtaV3dnSmlZZ1FVeE1UMWRGUkY5TlQwUkZURk11YVc1a1pYaFBaaWh0YjJSbGJDa2dJVDA5SUMweElDWW1JRzF2WkdWc0lDRTlQU0JqZFhKeVpXNTBUVzlrWld3cElIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RycXFqcmpiZ2c2N09BNnJLOU9pQW5JQ3NnWTNWeWNtVnVkRTF2WkdWc0lDc2dKeURpaHBJZ0p5QXJJRzF2WkdWc0tUc05DaUFnSUNBZ0lHTjFjbkpsYm5STmIyUmxiQ0E5SUcxdlpHVnNPdzBLSUNBZ0lDQWdjM1JoY25SUWNtOWpLQ2s3SUM4dklPeURpQ0RycXFqcmpianJvWndnN0lTNDdJV1lJT3llck95TG5PeWVrU0FvNjR1azdKMk1JT3liak91d2pleVhoZXlYa095RW5DRHNwNERzaTV6cnJMZ2c3SjZzN0tPODdKNkZLUTBLSUNBZ0lIME5DaUFnSUNCcFppQW9kSFZ5Ym5NZ1BqMGdUVUZZWDFSVlVrNVRJSHg4SUNGd2NtOWpLU0J6ZEdGeWRGQnliMk1vS1RzTkNpQWdJQ0JwWmlBb0lYZGhjbTFsWkZWd0tTQjdEUW9nSUNBZ0lDQmpiMjV6ZENCME1DQTlJRVJoDQpkR1V1Ym05M0tDazdEUW9nSUNBZ0lDQmhkMkZwZENCelpXNWtWSFZ5YmlocGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTazdEUW9nSUNBZ0lDQjNZWEp0WldSVmNDQTlJSFJ5ZFdVN0RRb2dJQ0FnSUNCMGRYSnVjeXNyT3cwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUV1T3lGbUNEc3BJRHJ1WVFnN0ptRTY2T01JQ2duSUNzZ0tDaEVZWFJsTG01dmR5Z3BJQzBnZERBcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtTQXJJQ2R6S1NEaWdKUWc3SjIwN1p1RUlPeWFsT3l5cmV5ZGdDRHJ1YWpybmJ6c21wUXVKeWs3RFFvZ0lDQWdmUTBLSUNBZ0lIUjFjbTV6S3lzN0RRb2dJQ0FnWTI5dWMzUWdZWE5ySUQwZ1luVnBiR1JCYzJzb0tUc2dMeThnN0o2czdJdWM2NCtFSU91VmpDRHFzSm5zbllBZzdLZUk2Nnk0N0oyRUlPdUxwT3lMbkNEc2s3VHJpNlFnS0dGemEyVmtRMjkxYm5RZzdKMjA3S1NSSU95bW5lcXdnQ0Ryc0tuc3A0QXBEUW9nSUNBZ2JHVjBJSEpoZHpzTkNpQWdJQ0IwY25rZw0KZXcwS0lDQWdJQ0FnY21GM0lEMGdZWGRoYVhRZ2MyVnVaRlIxY200b1lYTnJLVHNOQ2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3RFFvZ0lDQWdJQ0F2THlEdGhMUWc2NCtFN0tTUklPMkJ0T3Vobk91VG5DRHRsSVRyb1p6c2hManNpcVRxc0lBZzdLTzk3SjJBSU9xeXZleWFzQ2hUUlZOVFNVOU9YMFJKUlVRcElESHRtb3dnN0o2UTY0K1pJT3llck95TG5PdVBoQ0RpZ0pRZzdJS3M3SnFwN0o2UTdKZVE2cktRSU95THBPMk1xT3VobkNEc2xZZ2c2N08wN0oyMDZyS01MZzBLSUNBZ0lDQWdMeThnN0l1YzZyQ0VJT3kwaU9xenZNSzM2NkdjNnJlNDdKMjRJT3Vuak91ampNSzM3WUcwNjZHYzY1T2NJT3lZcE91bG1NSzM3SjJZNjQrRTdLQ0JJT3lpaGV1ampDanFzNFRzb0pVZzdLQ0U3Wm1ZTCt1aG5PcTN1T3lWaE95Ymd5d2dhMmxzYkZCeWIyTW9jbVZoYzI5dUtTbnJpcFFOQ2lBZ0lDQWdJQzh2SU95Z25DRHJxWlRzaTV6c3A0RHFzSUFnNjVTdzY2R2NJT3llaU95V3RDRHNsNnpxdUxBZzdKV0lJT3F4dU91bXNPdUwNCnBDNGc3S0tGNjZPTUlPeWFsT3l5clNEc3BKSHNuYlRxc2JEcmdwZ2c3SXVjNnJDRUlPeVlpT3lDc095ZHRDRHNscnpycDRnZzdKV0lJT3VDcU95Vm1PeWN2T3VwdENEcmtKanNnclRycHF6c3A0QWc3SldLNjRxVTY0dWtMZzBLSUNBZ0lDQWdhV1lnS0hOb2RYUjBhVzVuUkc5M2JpQjhmQ0FoS0dVZ0ppWWdaUzV0WlhOellXZGxJRDA5UFNCVFJWTlRTVTlPWDBSSlJVUXBJSHg4SUVSaGRHVXVibTkzS0NrZ0xTQnFiMkpUZEdGeWRDQStJRFF3TURBd0tTQjBhSEp2ZHlCbE93MEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFdU95Rm1PeWR0Q0R0aExRZzY0K0U3S1NSSU91Qml1cTVnQ0RpZ0pRZzdKNnM3SXVjNjQrWklPMmJoQ0F4N1pxTUlPeWVyT3lMbk91UGhPMlZxZXVMaU91THBDNG5LVHNOQ2lBZ0lDQWdJSE4wWVhKMFVISnZZeWdwT3cwS0lDQWdJQ0FnWVhkaGFYUWdjMlZ1WkZSMWNtNG9hVzV6ZEhKMVkzUnBiMjVOWlhOellXZGxLQ2twT3cwS0lDQWdJQ0FnZDJGeWJXVmtWWEFnDQpQU0IwY25WbE93MEtJQ0FnSUNBZ2RIVnlibk1nUFNBeU95QXZMeURzbTR6cnNJM3NsNFVnTVNBcklPeWR0T3V5aUNEdGhMUWdLSE4wWVhKMFVISnZZK3lkdENBdzdKeTg2NkdjSU95MGlPcTRzTzJabENrTkNpQWdJQ0FnSUhKaGR5QTlJR0YzWVdsMElITmxibVJVZFhKdUtHRnpheWs3RFFvZ0lDQWdmUTBLSUNBZ0lHbG1JQ2doY21Wd1lYSnpaU2tnY21WMGRYSnVJSEpoZHpzTkNpQWdJQ0JzWlhRZ2NHRnljMlZrSUQwZ2NtVndZWEp6WlM1d1lYSnpaU2h5WVhjcE93MEtJQ0FnSUM4dklPMllsZXlMblNEc25iVHRnNGpzbmJUcnFiUWc2ckNaN0oyQUlPeUV1T3lGbU1LMzZyQ1o3SjJBSU95ZW9leVhrT3lFbkNEcXM2ZnNucVVnN0o2czdKcVU3TEt0SU9LQWxDRHNuYlFnN1lTMDdKMjBJT3lqdmV5Y3ZPdXB0Q0RzZzRnZzdJUzQ3SVdZN0oyQUlDZnJzS25xdUlnZzY0dTFKK3lkaENEcnFyRHJuYndOQ2lBZ0lDQXZMeURzcDREc2xyVHJncndnN0lpWUlPeWVpT3ljdk91dmdPdWhuQ0RzaExqc2haZ2c3SUtzNjZlZA0KSU95ZXJPeUxuT3VQaE91S2xDRHRsWmpzcDRBZzdKV0s2ck9nSU9xM3VPdU1nT3VobkNEc2k2VHRqS2pzaTV6dGdxanJpNlFvN1l5TTdJdXhJT3lMcE8yTXFPdWhuQ0RxdDREcXNyQXBMZzBLSUNBZ0lHbG1JQ2hTUlZCQlVsTkZYMEpCUkNod1lYSnpaV1FwSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JxYjJKVGRHRnlkQ0E4SURjd01EQXdLU0I3RFFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZeU03SXV4SU95THBPMk1xQ0RpZ0pRZzdaaVY3SXVkSU95ZXJPeWFsT3l5clRvbkxDQlRkSEpwYm1jb2NtRjNLUzV6YkdsalpTZ3dMQ0F6TURBcEtUc05DaUFnSUNBZ0lIUjFjbTV6S3lzN0RRb2dJQ0FnSUNCMGNua2dldzBLSUNBZ0lDQWdJQ0J5WVhjZ1BTQmhkMkZwZENCelpXNWtWSFZ5YmlnbjY3Q3A2cmlJSU91THRleWR0Q0RzbXBUcXRhenRsWndnN1ppVjdJdWQ3SmVRSU95V3RPcTRpK3VDck91THBDNGc2N0NwNnJpSUlPdUx0ZTJWbkNEcmdyVHNtcW5zbllRZzdJU2s2NnFGd3Jmc2dxenENCnM3ekN0K3k5bE91VG5PMk9uT3lLcENEc2w0YnNuYlFnN0pXRTY1NllJRXBUVDA3c25MenJvWnpycDR3ZzY0dWs3SXVjSU95Mm5PdWdwZTJWbU91ZHZEb2dKeUFySUhKbGNHRnljMlV1Wm05eWJXRjBSR1Z6WXlrN0RRb2dJQ0FnSUNBZ0lIQmhjbk5sWkNBOUlISmxjR0Z5YzJVdWNHRnljMlVvY21GM0tUc05DaUFnSUNBZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeWVyT3lhbE95eXJTRHNpNlR0aktnZzRvQ1VJT3lWaE91ZW1PeVhrT3lFbkNEdGpJenNpN0VnN0l1azdZeW82NkdjSU95eW1PdW1yQ0FxTHlCOURRb2dJQ0FnZlEwS0lDQWdJR2xtSUNoU1JWQkJVbE5GWDBKQlJDaHdZWEp6WldRcEtTQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5TTdJdXhJT3lMcE8yTXFDQW83SjZzN0pxVTdMS3RJTzJiaE95WGtPdVBoQ2s2Snl3Z1UzUnlhVzVuS0hKaGR5a3VjMnhwWTJVb01Dd2dNekF3S1NrN0RRb2dJQ0FnY21WMGRYSnVJSHNnY21GM0xDQndZWEp6WldRNklGSkZVRUZTVTBWZlFrRkVLSEJoDQpjbk5sWkNrZ1B5QnVkV3hzSURvZ2NHRnljMlZrSUgwN0RRb2dJSDBwT3cwS0lDQXZMeUR0bFp3ZzdKcVU3TEt0N0oyMElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUc25Zd2c3SnFVN0xLdDdKMjBJT3lkdE95V3RPeW5nT3VQaE91aG5TRHRnWkRyaXBRZzdaV3Q3SU9CSU95RXNlcXp0ZXljdk91aG5DRHNvSlhycHF3TkNpQWdjWFZsZFdVZ1BTQnFiMkl1WTJGMFkyZ29LQ2tnUFQ0Z2UzMHBPdzBLSUNCeVpYUjFjbTRnYW05aU93MEtmUTBLRFFvdkx5RHJzb1R0aXJ3ZzY1Mjg2N0tvSU9xM25PeTVtU0RpZ0pRZzdaU002NStzNnJlNDdKMjQ3SjIwSUNmcnNvVHRpcnpzbllRZzZyT282NTZRNjR1a0orcXpvQ0RzbFl6cm9LVHNwSVFnNjVXTTY2ZU1JT3lXdWV1S2xPdUxwQzROQ2k4dklPdXloTzJLdkNEcnJManF0YXpyaXBRZzY2eTQ3SjZsN0oyMElPeVZoT3VMaU91ZHZDRHJqNW5zbnBFZzdKMjA2NmFFN0oyMDdKYTA3SVNjTENEc25iUWc3S2VBN0l1YzZyQ0FJT3lYaHV5Y3ZPdXB0Q0Ryckxqc25xWHRtSlVnNjR5QQ0KN0pXSTdKMjBJT3lFbnV5WHJDRHJncGpzbUtqcmk2UXVEUXBqYjI1emRDQkNWVlJVVDA1ZlVsVk1SU0E5RFFvZ0lDZnNuYlFnNjZ5NDZyV3M2NHFVSUNvcTY3S0U3WXE4SU91ZHZPdXlxQ29xN0oyMDY0dWtMaURyckxqc25xWHNuYlFnN0pXRTY0dUk2NTI4SU91UG1leWVrU0RzbmJUcnBvVHNuYlRycjREcm9adzZJT3VuaU95NXFPMlJuTUszNjZ5ODdKMk03Wkdjd3Jmc29vWHFzckRzbHJUcnI3Z29mdXlhbEM5KzY0dWtMMzdxdVl6c21wUXBJT3E0aU95bmdDd2dKeUFyRFFvZ0lDZnJrSmpyajRUcm9aMGc3S2VuN0oyQUlPdVBtZXlla1NEcnFvWHNncXdvN0tDQTdKNmx3cmZzZ3Ezc29KekN0K3lYc09xeXNDRHRsYlRzb0p3ZzY1T3hLZXVobkN3ZzdZYTE2N08wN0lTeElPdUxxT3lkdkNEcnNvVHRpcnpzbmJUcnFiUWdJdTJabGV5ZHVDSXVJQ2NnS3cwS0lDQW5JdXkzcU95R2pDTHJpcFFnNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUlPeVRzT3F6b0N3ZzdabVU2Nm0wSU9xNHNPdUsNCnBldXFoU2pyczREcXNyM0N0KzJWdE95Z25DRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWlRyaTZRdVhHNG5PdzBLRFFvdkx5RHJyTGpxdGF3ZzdMYVU3TEtjSU8yRXRDQW9jbTlzWlQwbjY3S0U3WXE4Sit5ZHRPdXB0Q0Ryc29UdGlyd2c2cmVjN0xtWjdKMkVJT3lXdWV1S2xPdUxwQ2tOQ21aMWJtTjBhVzl1SUdGemEwTnNZWFZrWlNoMFpYaDBMQ0J0YjJSbGJDd2djbVZ3WVhKelpTd2djbTlzWlNrZ2V3MEtJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0RRb2dJQ0FnWTI5dWMzUWdZWFIwWlcxd2RDQTlJQ2hoYzJ0bFpFTnZkVzUwTG1kbGRDaDBaWGgwS1NCOGZDQXdLU0FySURFN0RRb2dJQ0FnWVhOclpXUkRiM1Z1ZEM1elpYUW9kR1Y0ZEN3Z1lYUjBaVzF3ZENrN0RRb2dJQ0FnYVdZZ0tHRnphMlZrUTI5MWJuUXVjMmw2WlNBK0lESXdNQ2tnWVhOclpXUkRiM1Z1ZEM1amJHVmhjaWdwT3lBdkx5RHJyTFR0bFp6dG5vZ2c3SXlUN0oyMDdLZUFJT3lWaXVxeWpBMEtJQ0FnSUdOdmJuTjBJSEoxDQpiR1VnUFNCeWIyeGxJRDA5UFNBbjY3S0U3WXE4SnlBL0lFSlZWRlJQVGw5U1ZVeEZJRG9nSnljN0RRb2dJQ0FnY21WMGRYSnVJSEoxYkdVZ0t5QW9ZWFIwWlcxd2RDQStJREVOQ2lBZ0lDQWdJRDhnSitxd21leWRnQ0RyckxqcXRhenJwYndnNjR1azdJdWNJT3lhbE95eXJlMlZuT3VMcEM0ZzdKMjBJT3lFdU95Rm1PeVhrT3lFbkNEc25iVHNvSVRzbDVBZzdLQ2M3SldJN1phSTY0MllJT3F5Zyt1VHBPcXp2Q0Rxc3Juc3VaanNwNEFnN0pXSzY0cVVMQ0RxdGF6c29iRHJncGdnN0phMDdaeVk2ckNBSU8yWmxleUxwTzJlaUNEcmk2VHJwYmdnN0lPSTY2R2M3SnEwSU91TWdPeVZpQ0F6NnJDYzY2VzhJT3Ezbk95NW1ldU1nT3VobkNCS1UwOU9JT3V3c095WHRPdWhuT3VuakRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwRFFvZ0lDQWdJQ0E2SUNmcmk2VHNuWXdnVlVrZzY2eTQ2cldzN0oyWUlPdU1nT3lWaUNBejZyQ2M2Nlc4SU9xM25PeTVtZXVNZ091aG5DQktVMDlPSU91d3NPeVh0T3Vobk91bg0KakRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwS1RzTkNpQWdmU3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBPdzBLZlEwS0RRb3ZMeURyc29qc2w2MGc3WVMwSU9LQWxDRHFzSm5zbllBZzdJUzQ3SVdZN0oyRUlPeVRzT3VRbUN3ZzdKMjA2N0tJSU8yRXRPdW5qQ0RzdHBUc3Nwd2c3WmlWN0l1ZEtFcFRUMDRnNjdDdzdKZTBLU0RyaklEc2k2QWc2N0tJN0pldElPMllsZXlMblNoS1UwOU9JT3F3bmV5eXRDbnNuWVFnN0pxVTZyV3M3WldjNjR1a0RRcG1kVzVqZEdsdmJpQmhjMnRVY21GdWMyeGhkR1VvZEdWNGRDd2diVzlrWld3c0lISmxjR0Z5YzJVcElIc05DaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z0tBMEtJQ0FnSUNmc25iVHJzb2dnN0pxVTdMS3Q3SjJBSU91eWlPeVhyU0RzbnBIc2w0WHNuYlRyaTZRZ0tPdXN1T3ExckNEcmk2VHJrNnpxdUxBZzdKV0U2NHVZSU9LQWxDRHJqSURzbFlnZ00rcXduQ0RxdDV6c3VabnNuWUFnN0oyMDY3S0lJTzJFdE95WGtDRHNvSUhzbXFudGxaanMNCnA0QWc3SldLNjRxVTY0dWtLUzRnSnlBckRRb2dJQ0FnSit1THBPeWRqQ0JWU1NEcnJManF0YXpxc0lBZzdaV2M2cld0N0phMDY2bTBJT3lla095WHNPeUtwT3Vmck95YXRDRHNtSUhzbHJUcm9ad3NJT3lZZ2V5V3RPdXB0Q0RzbnBEc2w3RHNpcVRybjZ6c21yUWc3WldjNnJXdDdKYTA2NkdjSU91eWlPeVhyZTJWbU91ZHZDNGdKeUFyRFFvZ0lDQWdKMVZKSU91c3VPcTFyT3VMcE95YXRDRHFzSVRxc3JEdGxad2c3WkdjN1ppRTdKMkVJT3lUc09xem9Dd2c3SjIwNjZhRXdyZnNpS3ZzbnBEQ3QrdW5pT3lLcE8yQ3VjSzM3WlNNNjZDSTdKMjA3SXFrN1ptQTY0MlU2NHFVSU9xM3VPdU1nT3VobkNEcnM3VHNvYlR0bFp6cmk2UXVJQ2NnS3cwS0lDQWdJQ2ZzbTVEcnJManNuWmdnN0tTRUlPeUltT3VsdkNEcXQ3anJqSURyb1p3ZzdKeWc3S2VBN1pXYzY0dWtJT0tBbENEc201RHJyTGpzbmJRZzdaV2NJT3lraE95ZHRPdXB0Q0Ryc29qc2w2M3JqNFFnN1pXY0lPeWtoT3VobkN3ZzdLU0U2N0NVNnIrSTdKMkVJT3llDQpoT3lkbU91aG5DRHN0cFRxc0lEdGxaanNwNEFnN0pXSzY0cVU2NHVrTGlBbklDc05DaUFnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhTRHF1SWpzcDRBNklDY2dLdzBLSUNBZ0lDZDdJblJ5WVc1emJHRjBaV1FpT2lBaTY3S0k3SmV0NjZ5NElDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0prYVhKbFkzUnBiMjRpT2lBaWEyL2locEpsYmlEcm1KRHJpcFFnWlc3aWhwSnJieUo5T2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb2RHVjRkQ2tOQ2lBZ0tTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93MEtmUTBLRFFvdkx5RHJqSUR0bVpUdG1KVWc2Nnk0NnJXc0lPeWduT3lla1NEdGhMUWc0b0NVSU95Q3JPeWFxZXlla09xd2dDRHNnNEh0bWFuc25ZUWc3SVNrNjZxRjdaV1k2Nm0wSU91bnBldWR2ZXlYa0NEcnA1N3JpcFFnNjZ5NDZyV3M2Nlc4SU91bmpPdVRwT3lXdE95aw0KZ091THBDNE5DaTh2SUcxbGMzTmhaMlZ6T2lCYmUzSnZiR1U2SjNWelpYSW5mQ2RoYzNOcGMzUmhiblFuTENCMFpYaDBmVjBnN0tDRTdMSzBJT3VNZ08yWmxPdWx2Q0RycDZUcnNvZ2c2N0NiNjRxVTY0dWtLT3VMcE91bXJPdUtsQ0RyckxUc2c0SHRnNXdnNG9DVURRb3ZMeURzbTR6cnNJM3NsNFVnN0tlQTdJdWM2Nnk0N0oyWUlDTHNtcFRzc3Ezcms2VHNuWUFnN0lTYzY2R2NJT3VzdE9xMGdDSWc3S0NFN0tDYzY2VzhJT3luZ08yQ3BPcTRzQ0RzbklUdGxiUWc2NHlBN1ptVUlPdW5wZXVkdmV5ZGhDRHRoTFFnN0pXSTdKZVFJT3VxdmV1VmhTRHNpNlByaXBUcmk2UXBMZzBLWm5WdVkzUnBiMjRnWVhOclEyOXRjRzl6WlNodFpYTnpZV2RsY3l3Z2JXOWtaV3dzSUhKbGNHRnljMlVwSUhzTkNpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnZXcwS0lDQWdJR052Ym5OMElIUnlZVzV6WTNKcGNIUWdQU0FvYldWemMyRm5aWE1nZkh3Z1cxMHBMbTFoY0Nnb2JTa2dQVDROQ2lBZ0lDQWdJQ2h0TG5KdmJHVWcNClBUMDlJQ2RoYzNOcGMzUmhiblFuSUQ4Z0oreVd0T3lMbk95S3BPMkV0TzJLdURvZ0p5QTZJQ2ZzZ3F6c21xbnNucEE2SUNjcElDc2dVM1J5YVc1bktHMHVkR1Y0ZENCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTVRVd01Da05DaUFnSUNBcExtcHZhVzRvSjF4dUp5azdEUW9nSUNBZ2NtVjBkWEp1SUNnTkNpQWdJQ0FnSUNmc25iVHJzb2dnN0pxVTdMS3Q3SjJBSUNMcmpJRHRtWlR0bUpVZzY2eTQ2cldzSU95Z25PeWVrU0xzbmJUcmk2UWdLT3E0c095aHRDRHJyTGpxdGF3ZzY0dWs2NU9zNnJpd0lPeVZoT3VMbUNEaWdKUWc3SldFNjU2WUlPdU1nTzJabE9xd2dDRHNuYlRyc29nZzdZUzA3SjJZSU95Z2hPeXl0Q0RycDZYcm5iM3NuYlRyaTZRcExpQW5JQ3NOQ2lBZ0lDQWdJQ2ZzZ3F6c21xbnNucERxc0lBZzdabVU2Nm0wSU95RGdlMlpxY0szNjZlbDY1Mjk3SjJFSU95RXBPdXFoZTJWbU91cHRDd2c3SXFrN1lPQTdKMjhJT3Ezbk95NW1lcXp2Q0RzbUlqc2k1d2c3WWFrN0plUUlPdW5udXVLbENCVlNTRHJyTGpxDQp0YXpycGJ3ZzY2ZU02NU9rN0phMElPeWduT3lWaU8yVm1PdWR2QzVjYmljZ0t3MEtJQ0FnSUNBZ0p5MGc2NmVsNjUyOTdKMjBJT3UyZ095aHNlMlZtT3VwdENEdGpyanRsWmpxc293ZzY1Q1k2Nnk4N0phMDY1MjhPaURzbHJUcmxxUWc3Wm1VNjZtMHdyZnF1TERyaXFYc25aZ2c2Nnk0NnJXczdKMjQ3S2VBTENEcms2VHNsclRxc0lnZzdKNlE2NmFzNjRxVUlPeVd0T3VVbE95ZHVPeW5nQ2p0akozc2w0VWc3WU9BN0oyMDdZdUFMK3V6dU91c3VDL3Jzb1R0aXJ3c0lPMkdvT3lLcE8yS3VDd2c2N21JSU8yWmxPdXB0Q0RzbFlqcmdyUXNJT3V3c091RWlDRHJrN0VwTENEc2xyVHJscVFnN0lPQjdabXA3SjI0N0tlQUtPeUVzZXF6dFNEdGhyWHJzN1F2N0ppazY2V1lMKzJabGV5ZHVDRHNtcFRzc3EwdjdKV0k2NEswS1NEcXNKbnNuWUFnNnJLRExpRHF2SzBnN1pXRTdKcVU3WldjSU9xeWcrdW5qQ0RxczZqcm5id2c3WldjSU91eWlPeVhrQ0RzdFp6cmpJQWdNdXF3bk9xNWpPeW5nQ3dnN0tlbjZyS01MaURzbmJUcg0KbFl3Z2MzVm5aMlZ6ZEdsdmJuUHJpcFFnNjdtSUlPdXdzT3lYdEM1Y2JpY2dLdzBLSUNBZ0lDQWdKeTBnNnJDUTdKMjBJT3lXdE91S2tDRHNvSlhyajRRZzdKaWs2Nm0wSU91c3UrcTRzT3VuakNEdGxaanNwNEFnNjZlSTY1MjhJT0tBbENEcXNJRHNvSlhzbllRZzdJUzQ3SnF3NnJPZ0lPeTBpT3lWaUNCemRXZG5aWE4wYVc5dWMrdWx2Q0R0bGFqcXU1Z2c2NEswNjZtMDdJU2NMQ0J5WlhCc2VleVhrQ0Rxc0lEc29KWHNuWVFnNjdDZDdaNkk2ck9nSU91c3RPeVhoK3lkaENEc2xZenJvS1Rzbzd6cnFiUWc2NDJVSU91bm51eTJuQ0RzaUpnZzdKNkk2NHFVN0tlQUlPMlZuQ0Ryckxqc25xWHNuTHpyb1p3ZzY0Mm42N2FaN0plczY1MjhLT3lZaURvZ0l1MlpsZXlkdUNEdGpKM3NsNFhzbmJUcm5ienFzNkFnNnJDQTdLQ1Y3WmFJN0phMDdKcVVJT0tBbENEdGhxRHNpcVR0aXJqcm5ienJxYlFnN0pXTTY2Q2s3S084N0lTNDdKcVVJaWt1WEc0bklDc05DaUFnSUNBZ0lDY3RJT3VzdU9xMXJPdWx2Q0Rzb0p6c2xZanQNCmxhQWc2NVdRSU95RW5PdWhuQ0Rzb0pIcXQ3enNuYlFnNjR1azY2VzRJREorTStxd25DNGc2ckNCSU95Z25PeVZpT3lYbENEc21ad2c2cmU0NjZDSDZyS01JT3lOdk91S2xPeW5nQ0RzbmJUc25LRHJwYndnNjdhWjdKMjQ2NHVrTGx4dUp5QXJEUW9nSUNBZ0lDQW5MU0RzZ3F6c21xbnNucERxc0lBZzdKYTQ2cmlKN1pXWTdLZUFJT3lWaXV5ZGdDRHF0YXpzc3JRZzdLQ1Y2N08wS095Z2hPMlpsT3V5aU8yWXVNSzNWVkpNd3JmcXVJanNsYUhDdCsyYW4reUltQ0RyazdFcDY2VzhJT3luZ095V3RPdUN0Q0RyaEtQc3A0QWc2NmVJNjUyOExseHVKeUFyRFFvZ0lDQWdJQ0FuTFNEdG00VHNobzBnN0pxVTdMS3RLQ0xyalpRZzdLZW42cktNSWl3Z0l1dXloTzJLdk95YXFleWN2T3VobkNJZzY1T3hLZXlkdE91cHRDRHNwNEhzb0lRZzdLQ2M3SldJN0oyRUlPcTN1Q0Ryc0tudGxxWHNuTHpyb1p3ZzZyT2c3TE9RSU91THBPeUxuQ0Rzb0p6c2xZanRsWmpybmJ3dVhHNG5JQ3NOQ2lBZ0lDQWdJQ2ZyaTdYc25ZQWc2N0NZDQo2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZJT3E0aU95bmdEb2dKeUFyRFFvZ0lDQWdJQ0FuZXlKeVpYQnNlU0k2SUNMcmpJRHRtWlFnN0oyUjY0dTFJTzJWbk91UmtDRHJyTGpzbnFVZ0tPMlZ0T3lhbE95eXRDa2lMQ0FpYzNWbloyVnpkR2x2Ym5NaU9pQmJleUowWlhoMElqb2dJdXVzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0R0bFp3ZzY2eTQ3SjZsSW4xZGZWeHVYRzRuSUNzTkNpQWdJQ0FnSUNkYjY0eUE3Wm1VWFZ4dUp5QXJJSFJ5WVc1elkzSnBjSFFOQ2lBZ0lDQXBPdzBLSUNCOUxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0RRcDlEUW9OQ2k4dklPMlVoT3VnaU95ZWhPdXpoQ2p0bFpqc25JUWc3WlNFNjZDSTdKNkVJT3VzdHV5ZGpDa2c3TGFVN0xLY0lPMkV0Q0RpZ0pRZzdaV2NJTzJabE91cHRPeWRoQ0R0bFpqc25JUWc3WlNFNjZDSQ0KN0o2RUlPdUxxT3ljaE91aG5DRHJncGpyaUtBZzY3TzA2NEswNnJPZ0xBMEtMeThnS2lydGxJVHJvSWpzbm9UcnA0anJpNlFnNjVTdzY2R2NLaW9nNjR5QTdKV0k3SjJFSU91d20rdUtsT3VMcEM0ZzdaV2NJT3lhbE95eXJleVhrQ0RyaTZRZzdJdWs3SmEwSU91enRPdUN0T3VLbENEcXNvUHNuYlFnN1pXMTdJdXNPZzBLTHk4ZzdaU0U2NkNJN0o2RUlPeUltT3Vuak8yQnZDRHNtcFRzc3Ezc25ZUWc3S3E4NnJDYzY2bTBJT3EzdU91bmpPMkJ2Q0RyaXBEcm9LVHNwNERxczZBbzZyQ0JJRFYrTVREc3RJZ3BJT3Exck91UGhTRHNncXpzbXFucm40bnJqNFFnNnJlNDY2ZU03WUc4SU91Q21PcXdoT3VMcEM0TkNpOHZJR2R5YjNWd2N6b2dXM3R1WVcxbExDQjBaWGgwY3pwYlhYMWRJQ2p0bVpUcnFiUWc3SnlFNG9hUzdKV0U2NTZZSU95SW5Da3VEUXBtZFc1amRHbHZiaUJoYzJ0SGNtOTFjSE1vWjNKdmRYQnpMQ0J0YjJSbGJDd2djbVZ3WVhKelpTd2diVzl5WlNrZ2V3MEtJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ28NCktTQTlQaUI3RFFvZ0lDQWdMeThnNjdLRTdZcThJT3lZZ2V5WHJleWRnQ0FvNjdLRTdZcThLZXljdk91aG5DRHNzSTNzbHJRZzY3TzA2NEs0NjR1a0lPS0FsQ0Ryc29UdGlyd2c2Nnk0NnJXczY0cVVJT3VzdU95ZXBleWR0Q0RzbFlUcmk0anJuYndnNjQrWjdKNlJJT3lkdE91bWhPeWR0T3VkdkNEcXQ1enN1Wm5zbmJRZzY0dWs2NlcwNjR1a0RRb2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlDaG5jbTkxY0hNZ2ZId2dXMTBwTG0xaGNDZ29aeXdnYVNrZ1BUNE5DaUFnSUNBZ0lDZGJKeUFySUNocElDc2dNU2tnS3lBblhTQW5JQ3NnVTNSeWFXNW5LQ2huSUNZbUlHY3VibUZ0WlNrZ2ZId2dLQ2ZxdDdqcm83a25JQ3NnS0drZ0t5QXhLU2twSUNzZ0tHY2dKaVlnWnk1eWIyeGxJRDA5UFNBbjY3S0U3WXE4SnlBL0lDY2dLT3V5aE8yS3ZDa25JRG9nSnljcElDc2dKMXh1SnlBckRRb2dJQ0FnSUNBb1p5QW1KaUJCY25KaGVTNXBjMEZ5Y21GNUtHY3VkR1Y0ZEhNcElEOGdaeTUwWlhoMGN5QTZJRnRkS1M1dFlYQW9LSFFwDQpJRDArSUNjZ0lDMGdKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLRk4wY21sdVp5aDBJSHg4SUNjbktTa3BMbXB2YVc0b0oxeHVKeWtOQ2lBZ0lDQXBMbXB2YVc0b0oxeHVKeWs3RFFvZ0lDQWdZMjl1YzNRZ2FHRnpRblJ1SUQwZ0tHZHliM1Z3Y3lCOGZDQmJYU2t1YzI5dFpTZ29aeWtnUFQ0Z1p5QW1KaUJuTG5KdmJHVWdQVDA5SUNmcnNvVHRpcnduS1RzTkNpQWdJQ0JqYjI1emRDQnJaWGtnUFNBblozSnZkWEJ6SnlBcklDaG5jbTkxY0hNZ2ZId2dXMTBwTG0xaGNDZ29aeWtnUFQ0Z0tHY2dKaVlnWnk1MFpYaDBjeUEvSUdjdWRHVjRkSE11YW05cGJpZ25KeWtnT2lBbkp5a3BMbXB2YVc0b0p5Y3BPdzBLSUNBZ0lHTnZibk4wSUdGMGRHVnRjSFFnUFNBb1lYTnJaV1JEYjNWdWRDNW5aWFFvYTJWNUtTQjhmQ0F3S1NBcklERTdEUW9nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvYTJWNUxDQmhkSFJsYlhCMEtUc05DaUFnSUNCcFppQW9ZWE5yWldSRGIzVnVkQzV6YVhwbElENGdNakF3S1NCaGMydGxaRU52ZFc1MA0KTG1Oc1pXRnlLQ2s3RFFvZ0lDQWdZMjl1YzNRZ1lXZGhhVzRnUFNCdGIzSmxJSHg4SUdGMGRHVnRjSFFnUGlBeERRb2dJQ0FnSUNBL0lDZnNuYlFnN1ptVTY2bTA3SjJBSU95ZHRDRHNoTGpzaFpqc2w1RHNoSndnN0oyMDY2KzRJT3VMcE91a21PdUxwQzRnN0pXZTdJU2NJT3VDdUNEcmpJRHNsWWpxczd3ZzdKYTA3WnlZd3JmcXRhenNvYkRxc0lBZzdabVY3SXVrN1o2SUlPdUxwT3VsdUNEc2c0Z2c2NHlBN0pXSTY2ZU1JT3VDdE91ZHZDNWNiaWNOQ2lBZ0lDQWdJRG9nSnljN0RRb2dJQ0FnY21WMGRYSnVJQ2dOQ2lBZ0lDQWdJR0ZuWVdsdUlDc05DaUFnSUNBZ0lDZnNuYlRyc29nZzdKcVU3TEt0N0oyQUlDTHRtWlRycWJUc25ZUWc3WldZN0p5RUlPMlVoT3VnaU95ZWhPdXpoT3VobkNEcmdwanJpS0FnNjR1azY1T3M2cml3SXV1THBDNGc3SldFNjU2WTY0cVVJTzJWbkNEdG1aVHJxYlRzblpnZzY2eTQ2cldzNjZXOElPMlZtT3ljaENEdGxJVHJvSWpzbm9RbzdKaUI3SmV0S1NEcmk2anNuSVRyb1p3ZzY2eTINCjdKMkFJT3F5Zyt5ZHRPdUxwQzVjYmljZ0t3MEtJQ0FnSUNBZ0p5b3E3SmlCN0pldDY2ZUk2NHVrSU91VXNPdWhuQ29xSU91TWdPeVZpT3lkaENEcmdyVHJuYndnNG9DVUlPeVlnZXlYcmV5ZGhDRHNoSnpyb1p3ZzdaV3A3TG1ZNnJHdzY0S1lJT3lJbk95RW5PdWx2Q0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhMbHh1SnlBckRRb2dJQ0FnSUNBbkxTRHFzSUVnN0ppQjdKZXQ3SmVRSU91TWdPeVZpQ0F5NnJDY0xpRHF0N2dnN0ppQjdKZXQ3SjIwSU95WHJPdWZyQ0RzcElUc25iVHJxYlFnNjR5QTdKV0k2NCtFSUNvcTZyQ1o3SjJBSU95a2hDRHNpSmdxS3V1aG5DanNwSVRyc0pUcXY0Z2dYRnh1N0p5ODY2R2NJT3Exck91MmhDd2c3S1NFSU95SW5PeUVuQ0RzbktEc3A0QXBMbHh1SnlBckRRb2dJQ0FnSUNBbkxTRHNtSUhzbDYzc25aZ2c3SmV0N1pXZ0tPMkRnT3lkdE8yTGdNSzM3SldJNjRLMHdyZnJzb1R0aXJ3ZzY1T3hLZXF6dkNEc201RHJyTGpzblpnZzdLQ1Y2N08wd3Jmc29iRHFzYlFvN0lpcjdKNlF3cmZyDQpqSURzZzRIQ3QreWhzT3F4dENuc25ZQWc3SnlnN0tlQTdaV1k2ck9nTENEc2w0YnJpcFFnN0tDVjY3TzA2Nlc4SU95bmdPeVd0T3VDdE95bmdDRHJwNGpybmJ3dVhHNG5JQ3NOQ2lBZ0lDQWdJQ2N0SU9xem9PeTVvQ0Rxc293ZzdKZUc2NHFVSU95WWdleVhyZXlkdE91cHRDRHJqSURzbFlnZ01lcXduT3VuakNEcmdyVHFzYkRyZ3BnZzY3bUlJT3V3c095WHRPdWhuQ0Rya1pEc2xyVHJqNFFnNjVDYzY0dWtJT0tBbENEc2xyWHNwNERyb1p3ZzY3Q1U2cjY0N0tlQUlPdW5pT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDQWdKeTBnN1ptVTY2bTBJT3E0c091S3BldXFoU2pyczREcXNyM0N0KzJWdE95Z25DRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWlRyaTZRdVhHNG5JQ3NOQ2lBZ0lDQWdJQ2hvWVhOQ2RHNGdQeUFuTFNBbzY3S0U3WXE4S2V5Y3ZPdWhuQ0R0a1p6c2k1enJrSndnN0ppQjdKZXQ3SjJBSUNjZ0t5QkNWVlJVVDA1ZlVsVk1SU0E2SUNjbktTQXJEUW9nSUNBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TA0KbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhjSzM3TDJVNjVPYzdZNmM3SXFrSU9xNGlPeW5nRHBjYmljZ0t3MEtJQ0FnSUNBZ0ozc2laM0p2ZFhCeklqb2dXM3NpYm1GdFpTSTZJQ0xzbUlIc2w2MGc3SjIwNjZhRUtPeWVoZXVncGVxenZDRHJqNW5zbmJ3cElpd2dJbk4xWjJkbGMzUnBiMjV6SWpvZ1czc2lkR1Y0ZENJNklDTHJqSURzbFlnZzY2eTQ2cldzSUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSnlaV0Z6YjI0aU9pQWk3SjIwN0p5Z0lPMlZuQ0Ryckxqc25xVWlmVjE5WFgxY2JpY2dLdzBLSUNBZ0lDQWdKK3lZZ2V5WHJleWRnQ0Rzbm9Ycm9LVWc3SWljN0lTY3dyZnFzSnpzaUpqcnBid2c2cmU0NjR5QTY2R2NJT3luZ08yQ3FPdUxwQzVjYmx4dUp5QXJEUW9nSUNBZ0lDQW5XK3lZZ2V5WHJldXpoQ0RyckxqcXRheGRYRzRuSUNzZ2JHbHpkQTBLSUNBZ0lDazdEUW9nSUgwc0lHMXZaR1ZzTENCeVpYQmgNCmNuTmxLVHNOQ24wTkNnMEtMeThnN1pTRTY2Q0k3SjZFNjdPRUlPeTJsT3l5bkNEc25aSHJpN1hzbDVEc2hKd2dXM3R1WVcxbExDQnpkV2RuWlhOMGFXOXVjenBiZTNSbGVIUXNJSEpsWVhOdmJuMWRmVjBnN0xhVTdMYWNEUXBtZFc1amRHbHZiaUJ3WVhKelpVZHliM1Z3Y3loeVlYY3BJSHNOQ2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdEUW9nSUdOdmJuTjBJRzBnUFNCekxtMWhkR05vS0M5Y2UxdGNjMXhUWFNwY2ZTOHBPdzBLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3RFFvZ0lIUnllU0I3RFFvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0RRb2dJQ0FnWTI5dWMzUWdZWEp5SUQwZ1FYSnlZWGt1YVhOQmNuSmhlU2h2SUNZbUlHOHVaM0p2ZFhCektTQS9JRzh1WjNKdmRYQnpJRG9nVzEwN0RRb2dJQ0FnWTI5dWMzUWdaM0p2DQpkWEJ6SUQwZ1lYSnlMbTFoY0Nnb1p5a2dQVDRnS0hzTkNpQWdJQ0FnSUc1aGJXVTZJRk4wY21sdVp5Z29aeUFtSmlCbkxtNWhiV1VwSUh4OElDY25LUzUwY21sdEtDa3NEUW9nSUNBZ0lDQnpkV2RuWlhOMGFXOXVjem9nUVhKeVlYa3VhWE5CY25KaGVTaG5JQ1ltSUdjdWMzVm5aMlZ6ZEdsdmJuTXBEUW9nSUNBZ0lDQWdJRDhnWnk1emRXZG5aWE4wYVc5dWN3MEtJQ0FnSUNBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIUjVjR1Z2WmlCNElEMDlQU0FuYzNSeWFXNW5KdzBLSUNBZ0lDQWdJQ0FnSUNBZ0lDQS9JSHNnZEdWNGREb2dlQzUwY21sdEtDa3NJSEpsWVhOdmJqb2dKeWNnZlEwS0lDQWdJQ0FnSUNBZ0lDQWdJQ0E2SUhzZ2RHVjRkRG9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VkR1Y0ZENrZ2ZId2dKeWNwTG5SeWFXMG9LU3dnY21WaGMyOXVPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNXlaV0Z6YjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcERRb2dJQ0FnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOQ0KUGlCNExuUmxlSFFwRFFvZ0lDQWdJQ0FnSURvZ1cxMHNEUW9nSUNBZ2ZTa3BPdzBLSUNBZ0lDOHZJT3lkdE91bWhPeWhzT3l3cUNEc2w0YnFzNkFnN0tDYzdKV0k2NCtFSU95WGh1dUtsQ0RxdTQzcmpiRHF1TERycDR3ZzdKbVU3Snk4NjZtMElPMllsZXlMblNEc25iVHRnNGpyb1p3ZzY3TzQ2NHVrS09xd21leWRnQ0RzaExqc2haanNsNUFnN0o2czdKcVU3TEt0S1EwS0lDQWdJSEpsZEhWeWJpQm5jbTkxY0hNdWMyOXRaU2dvWnlrZ1BUNGdaeTV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dwSUQ4Z1ozSnZkWEJ6SURvZ2JuVnNiRHNOQ2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNOQ2lBZ0lDQnlaWFIxY200Z2JuVnNiRHNOQ2lBZ2ZRMEtmUTBLRFFvdkx5RHRqSjNzbDRVZzdJUzQ3WXE0SU95MmxPeXluQ0R0aExRZzRvQ1VJTzJWbkNEdGpKM3NsNFhzblpnZzZyV3M3SVN4N0pxVTdJYU1LT3lYcmUyVm9DdnJyTGpxdGF3cDY2VzhJTzJWbkNEcnNvanNsNUFnNjdPMDY0SzA2ck9nTEEwS0x5OGc3SnFVN0lhTTY3T0UNCklPdUNzZXF3bk9xd2dDRHNsWVRyaTRqcm5id2dLaXJzbVlUc2hMSHJrSndnN1l5ZDdKZUZJT3lFdU8yS3VDanN2SURzbmJUc2lxUXBJREorTStxd25Db3E2Nlc4SU8yR3RleWN2T3VobkNEcnNKdnJpcFRyaTZRdURRb3ZMeUR0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcTg3SjIwSU8yVm5DRHJxcmpzbkx6cm9ad2c3SjI4NnJTQTY0Kzg3Slc4SU8yVm1PdXZnT3VobkNqcmxMRHJvWndnNjcyUjdKV0VJT3loc08yVnFlMlZtT3VwdENEc2xyVHF1SXZyZ3B6cmk2UXBJT3lFdU8yS3VDRHJpNmpzbklUcm9ad2c3S0NjN0pXSTdaV1k2cktNSU8yVm5PdUxwQzROQ2k4dklHVnNaVzFsYm5Sek9pQmJlM0p2YkdVc0lIUmxlSFI5WFNBbzdabVU2Nm0wSU95Y2hPS0drdXlWaE91ZW1DRHNpSndwTGcwS0x5OGdiVzl5WlQxMGNuVmxLRnZzdklEc25iVHNpcVFnNjQyVUlPdXdtK3E0c0YwcDY2bTBJT3lkdENEc2hManNoWmpzbDVEc2hKd2c3SjIwNjYrNElPdUN1Q0RzaExqdGlyanNtWUFnNnJLNTdMbVk3S2VBDQpJT3lWaXV1S2xDRHNnNGdnN0lTNDdZcTQ2Nlc4SU95YWxPcTFyTzJWbk91THBDNE5DbVoxYm1OMGFXOXVJR0Z6YTFCdmNIVndLR1ZzWlcxbGJuUnpMQ0J0YjJSbGJDd2djbVZ3WVhKelpTd2diVzl5WlNrZ2V3MEtJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0RRb2dJQ0FnWTI5dWMzUWdjbTlzWlhNZ1BTQW9aV3hsYldWdWRITWdmSHdnVzEwcExtMWhjQ2dvWlNrZ1BUNGdVM1J5YVc1bktDaGxJQ1ltSUdVdWNtOXNaU2tnZkh3Z0p5Y3BLUzVxYjJsdUtDY3NJQ2NwT3cwS0lDQWdJR052Ym5OMElHeHBjM1FnUFNBb1pXeGxiV1Z1ZEhNZ2ZId2dXMTBwTG0xaGNDZ29aU3dnYVNrZ1BUNE5DaUFnSUNBZ0lDaHBJQ3NnTVNrZ0t5QW5MaUJiSnlBcklGTjBjbWx1Wnlnb1pTQW1KaUJsTG5KdmJHVXBJSHg4SUNjbktTQXJJQ2RkSUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoVGRISnBibWNvS0dVZ0ppWWdaUzUwWlhoMEtTQjhmQ0FuSnlrcERRb2dJQ0FnS1M1cWIybHVLQ2RjYmljcE93MEtJQ0FnSUM4dg0KSU9xd21leWRnQ0R0akozc2w0WHNuWVFnNjZxSElPdXlpT3ludUNEcnJMdnJpcFRzcDRBZzZyaXc3SmExSU9LQWxDRHNucXpzbXBUc3NxM3NuYlRycWJRZ0l1eWR0T3lnaE9xenZDRHJpNlRycGJnZzdJUzQ3WXE0SXV1bHZDRHNtcFRxdGF6dGxaenJpNlFOQ2lBZ0lDQXZMeUFvWVhOclEyeGhkV1JsN0ptQUlPcXdtZXlkZ0NEc25iVHNuS0E2SU95VmlDRHF0N2pybjZ6cnFiUWc3WUcwNjZHYzY1T2M2ckNBSU9xd21leWRnQ0RzaExqdGlyanJwYndnNjVpUUlPdUN0T3lFbkNCYjdMeUE3SjIwN0lxa0lPdU5sQ0Ryc0p2cXVMQmQ2ckNBSU91c3RPeWRtT3V2dU8yVnRPeW5oT3VMcENrTkNpQWdJQ0JqYjI1emRDQnJaWGtnUFNBbmNHOXdkWEFCSnlBcklDaGxiR1Z0Wlc1MGN5QjhmQ0JiWFNrdWJXRndLQ2hsS1NBOVBpQlRkSEpwYm1jb0tHVWdKaVlnWlM1MFpYaDBLU0I4ZkNBbkp5a3BMbXB2YVc0b0p3RW5LVHNOQ2lBZ0lDQmpiMjV6ZENCaGRIUmxiWEIwSUQwZ0tHRnphMlZrUTI5MWJuUXVaMlYwS0d0bGVTa2cNCmZId2dNQ2tnS3lBeE93MEtJQ0FnSUdGemEyVmtRMjkxYm5RdWMyVjBLR3RsZVN3Z1lYUjBaVzF3ZENrN0RRb2dJQ0FnYVdZZ0tHRnphMlZrUTI5MWJuUXVjMmw2WlNBK0lESXdNQ2tnWVhOclpXUkRiM1Z1ZEM1amJHVmhjaWdwT3lBdkx5RHJyTFR0bFp6dG5vZ2c3SXlUN0oyMDdLZUFJT3lWaXVxeWpBMEtJQ0FnSUdOdmJuTjBJR0ZuWVdsdUlEMGdiVzl5WlNCOGZDQmhkSFJsYlhCMElENGdNUTBLSUNBZ0lDQWdQeUFuN0oyMElPMk1uZXlYaGV5ZGdDRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3V2dUNEcmk2VHJwSmpyaTZRdUlPeVZudXlFbkNEc29KenNsWWp0bFp3ZzdJUzQ3WXE0NjVPazZyTzhJQ29xN0tDUjZyZTh3cmZzbHJUdG5KanFzSUFnN1ptVjdJdWs3WjZJSU91THBPdWx1Q0RzZzRnZzdJUzQ3WXE0S2lycnA0d2c2NEswNjUyOEtPcXdtZXlkZ0NEc2hManRpcmdnNjdDWTY3TzFJT3E0aU95bmdDa3VYRzRuRFFvZ0lDQWdJQ0E2SUNjbk93MEtJQ0FnSUhKbGRIVnliaUFvRFFvZ0lDQWdJQ0JoDQpaMkZwYmlBckRRb2dJQ0FnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTdZeWQ3SmVGS091THBPeWR0T3lXdk91aG5PcTN1Q2tnN0lTNDdZcTRJT3VMcE91VHJPcTRzQ0xyaTZRdUlPeVZoT3VlbU91S2xDRHRsWndnN1l5ZDdKZUY3SjJFSU95Y2hPS0drdXlWaE91ZW1PdWhuQ0RyZ3Bqc2w3VHRsWndnNnJXczdJU3g3SnFVN0lhTTY1T2s3SjIwNjR1a0tPeUVuT3VobkNEcnJMVHF0SUR0bFp3ZzY3T0U2ckNjSU91c3VPcTFyT3F3Z0NEc2xZVHJpNGpyaTZRcExpQW5JQ3NOQ2lBZ0lDQWdJQ2ZzbXBUc2hvenJwYndnNjRLeDZyQ2M2NkdjSU9xem9PeTVtT3luZ0NEcnA1RHFzNkFzSUNvcTdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdk95ZHRDRHNoSnpyb1p3ZzdKMjg2clNBNjVDY0lDTHNtWVRzaExIcmtKd2c3WXlkN0plRklPeUV1TzJLdUNJZ01uNHo2ckNjS2lycnBid2c3S0NjN0pXSTdaV1k2NTI4TGlEcXNJRWc3SVM0N1lxNDY0cVVJT3lFbk91aG5DRHJpNlRycGJnZzdLQ1I2cmU4N0oyMA0KN0phMDdKVzhJTzJWbk91THBDNWNiaWNnS3cwS0lDQWdJQ0FnSitxd2dTRHNoTGp0aXJqcmlwUWc3SjZGNjZDbDZyTzhJQ29xNnJDWjdKMkFJT3lYcmUyVm9NSzM2ckNaN0oyQUlPcXduT3lJbU1LMzZyQ1o3SjJBSU95SW5PeUVuQ29xN0oyWUlPeWFsT3lHak91bHZDRHJxcWpya1pBZzdZK3M3WldvN1pXYzY0dWtMaURzaExqdGlyZ2c3SldJN0plUTdJU2NJTzJEZ095ZHRPMkxnTUszN0pXSTY0SzB3cmZyc29UdGlyenNuWUFnN1pXY0lPdXF1T3ljdk91aG5DRHJwNTdzbFlUcmxxanNsclRzb0xqc2xid2c3WldjNjR1a0tPeVlpRG9nNjdPNDY2eTQ3SjIwSUNKKzdaV2c2cm1NN0pxVVB5THJxYlFnNjdLRTdZcTg3SjJBSUZ2c2xZVHJpNGpzbUtSZEwxdnJoS1JkS1M1Y2JpY2dLdzBLSUNBZ0lDQWdKMXZ0akozc2w0VWc2Nnk0N0xLMElPcTNuT3k1bVNEaWdKUWc3SnlFSU95S3BPMkRnT3lkdkNEcXNJRHNuYlRyazV6c25aZ2dJamd1SU8yTW5leVhoU0lnN0lTNTdJV1k3SjJFSU91VXNPdWx1T3VMcEYxY2JpY2cNCkt3MEtJQ0FnSUNBZ0p5MGc3WU9BN0oyMDdZdUFPaURzcDZmc25ZQWc2NnFGN0lLczZyV3NLREorTk95V3RPeWdpQ2tzSU95aWhlcXlzT3lXdE91dnVNSzM2NmVJN0xtbzdaR2NJT3lYaHV5ZHRDaCs3SnFVTDM3cmk2UXZmdXE1ak95YWxEOGc2cmlJN0tlQUtTNGc2N0NZNjVPYzdJdWNJT3lWaU91Q3RDanJzN2pyckxncElPdW5wZXVkdmV5ZGhDRHNtcFRzbGIzdGxiUWc3WU9BN0oyMDdZdUE2NmVNSU91MGtPdVBoQ0RyckxUc2lxZ2c3WXlkN0plRjdKMjQ3S2VBSU95VmpPcXlqQ0R0bFpqcm5id3VJT3lia091enVPeWR0Q0FpN0pXTTY2YThMKzJabGV5ZHVDTHNzcGpybjd3ZzY2ZUo3SmV3N1pXWTY2bTBJT3V6dU91c3VPeWRoQ0RxdDd6cXNiRHJvWndnNnJXczdMSzA3Wm1VN1pXWTY1MjhMbHh1SnlBckRRb2dJQ0FnSUNBbkxTRHNsWWpyZ3JRbzY3TzQ2Nnk0S1RvZzdaVzA3SnFVN0xLMExpRHRqSkRyaTZqc25iUWc3WldFN0pxVTdaV1k2Nm0wSUNKKzdaV2c2cm1NN0pxVVB5THJvWndnNjZ5NzZyT2dMQ0RyDQprSmpyajR6cnByUWc3SWlZSU95WGh1dUtsQ0RzbklUdGw1Z283SUt0N0tDY3dyZnRnNGp0aDdRZzY1T3hLZXlkZ0NEcXNyRHFzN3pycGJ3ZzY2aTg3S0NBSU9xeXZlcXpvTzJWbk91THBDNGc2ckt3NnJPOHdyZnNnNEh0ZzV3ZzdZYTE2N08wNjZtMElPeUVuT3lJb08yWWxleWN2T3VobkNEc2xZenJwckRyaTZRdVhHNG5JQ3NOQ2lBZ0lDQWdJQ2N0SU91eWhPMkt2RG9nNjdPNDY2eTQ3SjIwSUNKKzdaV2c2cm1NN0pxVVB5THJxYlFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBzSU91enVPdXN1T3lkdENEc2c0SHRtYW5zbllRZzdJU2M3SWlnN1pXWTZyT2dJT3lkdENEcnNvVHRpcnpzbmJRZzdJdWs3S0NjSU91UG1leWVrZXlkdE91cHRDRHJqNW5zbnBFZzY0K1o3SUtzS095Q3JleWduQy9zb0lEc25xVXY3SmV3NnJLd0lPMlZ0T3lnbkNEcms3RXBMQ0R0aHJYcnM3UWc3WXlkN0plRjdKMllJT3VMcU95ZHZDRHJzb1R0aXJ6c25iVHJxYlFnSXUyWmxleWR1Q0l1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcg0Kc29UdGlyenFzN3dnN0tlZDdKMjhJT3VWak91bmpDd2dJdXVMcStxNHNNSzM2NCtaN0o2UklpRHNvYkR0bGFrZzZyaUk3S2VBTGlEdG1aVHJxYlFnNnJpdzY0cWw2NnFGS091emdPcXl2Y0szN1pXMDdLQ2NJT3VUc1Nuc25ZQWc2cmU0NjR5QTY2R2NJT3VSbE91THBDNWNiaWNnS3cwS0lDQWdJQ0FnSnkwZzdKdVE2Nnk0N0oyWUlPeWdsZXV6dE1LMzdLR3c2ckcwS095SXEreWVrTUszN0oyMDdJT0JMK3lkdE8yVm1NSzM2NHlBN0lPQktleWRnQ0RzbktEc3A0RHRsWmpxczZBc0lPeWJrT3VzdU95WGtDRHNsNGJyaXBRZzdLQ1Y2N08wd3Jmc29JanNzS2pDdCt5WHNPdWR2ZXl5bU91bHZDRHNwNERzbHJUcmdyVHNwNEFnNjZlSTY1MjhMbHh1SnlBckRRb2dJQ0FnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhjSzM3TDJVNjVPYzdZNmM3SXFrSU9xNGlPeW5nRHBjYmljZ0t3MEsNCklDQWdJQ0FnSjNzaWMyVjBjeUk2SUZ0N0luSmxZWE52YmlJNklDTHNuYlFnN0lTNDdZcTQ3SjJZSU91d3FlMldwZXlkaENEdGxaenF0YTNzbHJRZzdaV2NJT3VzdU95ZXBleWN2T3VobkNJc0lDSmxiR1Z0Wlc1MGN5STZJRnQ3SW5KdmJHVWlPaUFpN0pldDdaV2dJaXdnSW5SbGVIUWlPaUFpNjZ5NDZyV3NJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0o5TENBdUxpNWRmU3dnTGk0dVhYMWNiaWNnS3cwS0lDQWdJQ0FnSit5WHJlMlZvT3lkZ0NEc25vWHJvS1VnN0lpYzdJU2M2NHlBNjZHY09pQW5JQ3NnY205c1pYTWdLeUFuWEc1Y2JpY2dLdzBLSUNBZ0lDQWdKMXZ0akozc2w0VWc3SnFVN0lhTVhWeHVKeUFySUd4cGMzUU5DaUFnSUNBcE93MEtJQ0I5TENCdGIyUmxiQ3dnY21Wd1lYSnpaU2s3RFFwOURRb05DaTh2SU8yTW5leVhoU0RzblpIcmk3WHNsNURzaEp3Z2UzTmxkSE02SUZ0N2NtVmhjMjl1TENCbGJHVnRaVzUwY3pwYmUzSnZiR1VzZEdWNGRIMWRmVjE5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjDQo3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa05DbVoxYm1OMGFXOXVJSEJoY25ObFVHOXdkWEFvY21GM0tTQjdEUW9nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93MEtJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc05DaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3cwS0lDQWdJR052Ym5OMElITmxkSE5KYmlBOUlFRnljbUY1TG1selFYSnlZWGtvYnlBbUppQnZMbk5sZEhNcElEOGdieTV6WlhSeklEb2dXMTA3RFFvZ0lDQWdZMjl1YzNRZ2MyVjBjeUE5SUhObGRITkpiZzBLSUNBZ0lDQWdMbTFoY0Nnb2MzUXBJRDArSUNoN0RRb2dJQ0FnSUNBZ0lISmxZWE52YmpvZ1UzUnlhVzVuS0NoemRDQW1KaUJ6ZEM1eQ0KWldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0Nrc0RRb2dJQ0FnSUNBZ0lHVnNaVzFsYm5Sek9pQkJjbkpoZVM1cGMwRnljbUY1S0hOMElDWW1JSE4wTG1Wc1pXMWxiblJ6S1EwS0lDQWdJQ0FnSUNBZ0lEOGdjM1F1Wld4bGJXVnVkSE1OQ2lBZ0lDQWdJQ0FnSUNBZ0lDQWdMbTFoY0Nnb1pXd3BJRDArSUNoN0lISnZiR1U2SUZOMGNtbHVaeWdvWld3Z0ppWWdaV3d1Y205c1pTa2dmSHdnSnljcExuUnlhVzBvS1N3Z2RHVjRkRG9nVTNSeWFXNW5LQ2hsYkNBbUppQmxiQzUwWlhoMEtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwcEtRMEtJQ0FnSUNBZ0lDQWdJQ0FnSUNBdVptbHNkR1Z5S0NobGJDa2dQVDRnWld3dWRHVjRkQ2tOQ2lBZ0lDQWdJQ0FnSUNBNklGdGRMQTBLSUNBZ0lDQWdmU2twRFFvZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2h6ZENrZ1BUNGdjM1F1Wld4bGJXVnVkSE11YkdWdVozUm9LVHNOQ2lBZ0lDQnlaWFIxY200Z2MyVjBjeTVzWlc1bmRHZ2dQeUJ6WlhSeklEb2diblZzYkRzTkNpQWdmU0JqWVhSamFDQW8NClgyVXBJSHNOQ2lBZ0lDQnlaWFIxY200Z2JuVnNiRHNOQ2lBZ2ZRMEtmUTBLRFFvdkx5RHJqSUR0bVpUdG1KVWc3S0NjN0o2UklPeWRrZXVMdGV5WGtPeUVuQ0I3Y21Wd2JIa3NJSE4xWjJkbGMzUnBiMjV6VzExOUlPeTJsT3kybkNBbzdMMlU2NU9jN1k2YzdJcWt3cmZzbFo3cmtxUWc3SjZoNjR1MElPMlhpT3lhcVNrTkNtWjFibU4wYVc5dUlIQmhjbk5sUTI5dGNHOXpaU2h5WVhjcElIc05DaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0RRb2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93MEtJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdEUW9nSUhSeWVTQjdEUW9nSUNBZ1kyOXVjM1FnYnlBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3RFFvZ0lDQWdZMjl1YzNRZ2NtVndiSGtnUFNCVGRISnBibWNvS0c4Z0ppWWdieTV5DQpaWEJzZVNrZ2ZId2dKeWNwTG5SeWFXMG9LVHNOQ2lBZ0lDQmpiMjV6ZENCemRXZG5aWE4wYVc5dWN5QTlJRUZ5Y21GNUxtbHpRWEp5WVhrb2J5QW1KaUJ2TG5OMVoyZGxjM1JwYjI1ektRMEtJQ0FnSUNBZ1B5QnZMbk4xWjJkbGMzUnBiMjV6RFFvZ0lDQWdJQ0FnSUNBZ0xtMWhjQ2dvZUNrZ1BUNGdLSHNnZEdWNGREb2dVM1J5YVc1bktDaDRJQ1ltSUhndWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd2djbVZoYzI5dU9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmU2twRFFvZ0lDQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb2VDa2dQVDRnZUM1MFpYaDBLUTBLSUNBZ0lDQWdPaUJiWFRzTkNpQWdJQ0JwWmlBb2NtVndiSGtnZkh3Z2MzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0tTQnlaWFIxY200Z2V5QnlaWEJzZVN3Z2MzVm5aMlZ6ZEdsdmJuTWdmVHNOQ2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzdKV0U2NTZZNjZHY0lDb3ZJSDBOQ2lBZ2NtVjBkWEp1SUc1MQ0KYkd3N0RRcDlEUW9OQ2k4dklPdXlpT3lYclNEc25aSHJpN1hzbDVEc2hKd2dlM1J5WVc1emJHRjBaV1FzSUdScGNtVmpkR2x2Ym4wZzdMYVU3TGFjSUNqc3ZaVHJrNXp0anB6c2lxVEN0K3lWbnV1U3BDRHNucUhyaTdRZzdaZUk3SnFwS1EwS1puVnVZM1JwYjI0Z2NHRnljMlZVY21GdWMyeGhkR1VvY21GM0tTQjdEUW9nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93MEtJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc05DaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3cwS0lDQWdJR052Ym5OMElIUnlZVzV6YkdGMFpXUWdQU0JUZEhKcGJtY29LRzhnSmlZZ2J5NTBjbUZ1YzJ4aGRHVmtLU0I4ZkNBbkp5a3VkSEpwYlNncE93MEsNCklDQWdJR2xtSUNoMGNtRnVjMnhoZEdWa0tTQnlaWFIxY200Z2V5QjBjbUZ1YzJ4aGRHVmtMQ0JrYVhKbFkzUnBiMjQ2SUZOMGNtbHVaeWdvYnlBbUppQnZMbVJwY21WamRHbHZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlPdzBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc2xZVHJucGpyb1p3Z0tpOGdmUTBLSUNCeVpYUjFjbTRnYm5Wc2JEc05DbjBOQ2cwS0x5OGc3SjJSNjR1MTdKZVE3SVNjSUh0MFpYaDBMQ0J5WldGemIyNTlJT3V3c095WHRDRHN0cFRzdHB3Z0tPeTlsT3VUbk8yT25PeUtwTUszN0pXZTY1S2tJT3llb2V1THRDRHRsNGpzbXFrcERRcG1kVzVqZEdsdmJpQndZWEp6WlZOMVoyZGxjM1JwYjI1ektISmhkeWtnZXcwS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNOQ2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwWTJnb0wxeGJXMXh6DQpYRk5kS2x4ZEx5azdEUW9nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNOQ2lBZ2RISjVJSHNOQ2lBZ0lDQmpiMjV6ZENCaGNuSWdQU0JLVTA5T0xuQmhjbk5sS0hNcE93MEtJQ0FnSUdsbUlDaEJjbkpoZVM1cGMwRnljbUY1S0dGeWNpa3BJSHNOQ2lBZ0lDQWdJSEpsZEhWeWJpQmhjbklOQ2lBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIc2dkR1Y0ZERvZ1UzUnlhVzVuS0NoNElDWW1JSGd1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lCVGRISnBibWNvS0hnZ0ppWWdlQzV5WldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZTa3BEUW9nSUNBZ0lDQWdJQzVtYVd4MFpYSW9LSGdwSUQwK0lIZ3VkR1Y0ZENrN0RRb2dJQ0FnZlEwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNsWVRybnBqcm9ad2dLaThnZlEwS0lDQnlaWFIxY200Z1cxMDdEUXA5RFFvTkNpOHZJT3Vobk9xM3VPeWR1Q0R0bFlUc21wVEN0KzJWbk91UGhDRHN0SWpxczd3ZzdJT0I3WU9jN0oyOElPdVZqQ0F2YUdWaA0KYkhSb0lPeWhzTzJhak9xd2dDRHNtS1RycWJRZzY1S2s3SmVRN0lTY0lPeWJqT3V3amV5WGhleWRoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzA2N080NjR1a0lDZ3pNT3kwaU95WGtDQXg2N0tJNjZlTUtTNE5DaTh2SU95RXNlcXp0ZTJWbU91cHRDRHFzckRxczd3ZzdaVzQ2NU9rNjUrczZyQ0FJR05zWVhWa1pWTjBZWFIxY3owbmIyc242NkdjSU91UW1PdVBqT3Vtck91dmdPdWhuQ3dnN0o2czY2R2M2cmU0N0oyNElPMmJoQ0Ryc29UdGlyenNuYlFnN0tDQTdLQ0k2NkdjSVBDZm42THNuTHpyb1p3ZzY3TzE2cmVBN1pXYzY0dWtMZzBLTHk4Z0tPMlVqT3Vmck9xM3VPeWR1T3lkdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHNDRHJrcVFnN0tPODZyaXc3S0NCN0p5ODY2R2NJQzlvWldGc2RHanJwYndnN0tHdzdacU03WldZNjRxVUlPcXlnK3F6dkNEc3A1M3NuWVFnN0oyMDY2T3M2NHVrS1EwS0x5OGc3WldjNjQrRUlPeTBpT3F6dk91UGhDRHFzSm5zbllBZzZySzk2NkdjNjZHY0lPdXp0ZXEzZ095TG5PMkMNCnFPdUxwQ0RpZ0pRZzZyU0E2NmFzN0o2UTZyQ0FJTzJWbk91UGhPdWx2Q0RzbUt6cm9LVHNvN3pxc2JEcmdwZ2c3WldjNjQrRTZyQ0FJT3kwaU9xNHNPMlpsT3VRbU91cHRBMEtMeThnN0lLczdKcXA3SjZRNnJDQUlPeVZoT3VzdE9xeWcrdVBoQ0RzbFlnZzY0aU02NStzNjQrRUlPdXloTzJLdk95ZHRDRHduNStpN0p5ODY2R2NJT3VQak95VmhPeVlxT3VMcEM0ZzdaV2M2NCtFN0plUUlPcXh1T3Vtc0NEdG1ManN0cHpzbllBZzZyR3c3S0NJNjVDWTY2K0E2NkdjSU95Q3JPeWFxZXVmaWV5ZGdDRHNsWWdnNjRLWTZyQ0U2NHVrRFFwc1pYUWdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEMGdNRHNOQ21aMWJtTjBhVzl1SUhKbGRISjVRWFYwYUVsbVRtVmxaR1ZrS0NrZ2V3MEtJQ0JwWmlBb1kyeGhkV1JsVTNSaGRIVnpJQ0U5UFNBblkyeGhkV1JsTFd4dloyOTFkQ2NnSmlZZ1kyeGhkV1JsVTNSaGRIVnpJQ0U5UFNBblkyeGhkV1JsTFd4cGJXbDBKeWtnY21WMGRYSnVPdzBLSUNCcFppQW9kMkZwZEdWeUlIeDhJRVJoDQpkR1V1Ym05M0tDa2dMU0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQQ0F6TURBd01Da2djbVYwZFhKdU95QXZMeURzcDRUdGxva2c3S1NSSU8yRXRDRHJzS250bGJRZzZyaUk3S2VBSUNzZ016RHN0SWdnNnJDRTZyS3BEUW9nSUd4aGMzUkJkWFJvVW1WMGNubEJkQ0E5SUVSaGRHVXVibTkzS0NrN0RRb2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdKNnM3Wm1WN0oyNElPeUxuT3VQaE9LQXBpY3BPdzBLSUNCeWRXNVVkWEp1S0NncElEMCtJQ2Zyb1p6cXQ3anNuYmdnN1ptVjdKMjQ3SnFwN0oyMDY0dWtMaUFpVDBzaTY1Mjg2ck9nNjZlTUlPdUx0ZTJWbU91ZHZDNG5LUzUwYUdWdUtBMEtJQ0FnSUNncElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdabVY3SjI0NjVDb0lPS0FsQ0Rzb0pYc2c0RWc3SU9CN1lPYzY2R2NJT3V6dGVxM2dDNG5LU3dOQ2lBZ0lDQW9aU2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lWaE95bg0KZ1NEcm9aenF0N2pzbmJnZzdKV0lJT3VRcURvbkxDQlRkSEpwYm1jb1pTNXRaWE56WVdkbEtTNXpiR2xqWlNnd0xDQTRNQ2twRFFvZ0lDazdEUXA5RFFvTkNpOHZJT3lMcE8yTXFDRHNuWkhyaTdYc25ZUWc3SUtzNjU2TTdKcXBJT3lWaU91Q3RPdWhuQ0RyczREdG1aZ2c0b0NVSU95YmtPeWR1Q2pyb1p6cXQ3anNuYmd2N0lTazdMbVlLZXlkdENEdGpJenNsWVhya0p3ZzZySzk3SnF3N0plVUlPcTN1Q0RzbFlqcmdyVHJwYndzSU95VmhPdUxpT3VwdENEc29KSHJrWkRzbHJRcjdKdVE2Nnk0N0oyRUlPdXp0T3VDdU91THBBMEtablZ1WTNScGIyNGdabkpwWlc1a2JIbEZjbkp2Y2lobExDQndjbVZtYVhncElIc05DaUFnYVdZZ0tHVWdKaVlnWlM1dFpYTnpZV2RsSUQwOVBTQk1UMGRKVGw5SFZVbEVSU2tnY21WMGRYSnVJSHNnWlhKeWIzSTZJRXhQUjBsT1gwZFZTVVJGTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFd4dloyOTFkQ2NnZlRzTkNpQWdhV1lnS0dVZ0ppWWdaUzV0WlhOellXZGxJRDA5UFNCTVNVMUoNClZGOUhWVWxFUlNrZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUV4SlRVbFVYMGRWU1VSRkxDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXeHBiV2wwSnlCOU93MEtJQ0JwWmlBb1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBblkyeGhkV1JsTFcxcGMzTnBibWNuS1NCN0RRb2dJQ0FnY21WMGRYSnVJSHNnWlhKeWIzSTZJQ2ZzbmJRZ1VFUHNsNUFnUTJ4aGRXUmxJRU52WkdVb1kyeGhkV1JsS2Vxd2dDRHNoS1RzdVpqcmo3d2c3SjZJN0tlQUlPeVZpdXlWaE95YWxDRGlnSlFnN0lTazdMbVk3WldZNnJPZ0lPdWhuT3EzdU95ZHVPMlZuQ0Rya3FRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUp5d2djSEp2WW14bGJUb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp5QjlPdzBLSUNCOURRb2dJSEpsZEhWeWJpQjdJR1Z5Y205eU9pQndjbVZtYVhnZ0t5QW9aU0FtSmlCbExtMWxjM05oWjJVZ1B5QmxMbTFsYzNOaFoyVWdPaUJUZEhKcGJtY29aU2twSUgwN0RRcDlEUW9OQ21aMWJtTjBhVzl1SUhKbFlXUkNiMlI1DQpLSEpsY1NrZ2V3MEtJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVVwSUQwK0lIc05DaUFnSUNCc1pYUWdZbTlrZVNBOUlDY25PdzBLSUNBZ0lISmxjUzV2YmlnblpHRjBZU2NzSUNoaktTQTlQaUI3SUdKdlpIa2dLejBnWXpzZ2ZTazdEUW9nSUNBZ2NtVnhMbTl1S0NkbGJtUW5MQ0FvS1NBOVBpQjdEUW9nSUNBZ0lDQjBjbmtnZXlCeVpYTnZiSFpsS0VwVFQwNHVjR0Z5YzJVb1ltOWtlU2twT3lCOUlHTmhkR05vSUNoZlpTa2dleUJ5WlhOdmJIWmxLSHQ5S1RzZ2ZRMEtJQ0FnSUgwcE93MEtJQ0I5S1RzTkNuME5DZzBLWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3MEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0U0dWaFpHVnljeWM2SUNkRA0KYjI1MFpXNTBMVlI1Y0dVbkxBMEtmVHNOQ21aMWJtTjBhVzl1SUdwemIyNG9jbVZ6TENCemRHRjBkWE1zSUc5aWFpa2dldzBLSUNCeVpYTXVkM0pwZEdWSVpXRmtLSE4wWVhSMWN5d2dUMkpxWldOMExtRnpjMmxuYmloN0lDZERiMjUwWlc1MExWUjVjR1VuT2lBbllYQndiR2xqWVhScGIyNHZhbk52YmpzZ1kyaGhjbk5sZEQxMWRHWXRPQ2NnZlN3Z1EwOVNVMTlJUlVGRVJWSlRLU2s3RFFvZ0lISmxjeTVsYm1Rb1NsTlBUaTV6ZEhKcGJtZHBabmtvYjJKcUtTazdEUXA5RFFvTkNtTnZibk4wSUhObGNuWmxjaUE5SUdoMGRIQXVZM0psWVhSbFUyVnlkbVZ5S0dGemVXNWpJQ2h5WlhFc0lISmxjeWtnUFQ0Z2V3MEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjA5UVZFbFBUbE1uS1NCN0lISmxjeTUzY21sMFpVaGxZV1FvTWpBMExDQkRUMUpUWDBoRlFVUkZVbE1wT3lCeVpYUjFjbTRnY21WekxtVnVaQ2dwT3lCOURRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuUjBWVUp5QW1KaUJ5WlhFdWRYSnMNCklEMDlQU0FuTDJobFlXeDBhQ2NwSUhzTkNpQWdJQ0J5WlhSeWVVRjFkR2hKWms1bFpXUmxaQ2dwT3lBdkx5RHJvWnpxdDdqc25iZ2c3WldFN0pxVUlPeURnZTJEbk91cHRDRHNucXp0bVpYc25iZ2c3SXVjNjQrRUlPS0FsQ0RzbnF6cm9aenF0N2pzbmJqc25iUWc2NEdkNjRLczdKeTg2Nm0wSU91THBPeWRqQ0Rzb2JEdG1venJ0b0R0aExBZ2NISnZZbXhsYmV5ZHRDRHRrb0RycHJEcmk2UU5DaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dldzBLSUNBZ0lDQWdiMnM2SUhSeWRXVXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY3NJSFk2SUVKU1NVUkhSVjlXTENCa2FYSTZJRjlmWkdseWJtRnRaU3dnTHk4Z2RzSzNaR2x5T2lEcXRhenJzb1Rzb0lRdjdKZUo2NXF4N1pXY0lPeUNyT3V6dU95ZHRDRHJscUFnN0o2STY0cVU3S2VBSU95bmhPdUxxT3lhcVEwS0lDQWdJQ0FnYlc5a1pXdzZJR04xY25KbGJuUk5iMlJsYkN3Z2JXOWtaV3h6T2lCQlRFeFBWMFZFWDAxUFJFVk1VeXdnWlhoaGJYQnNaWE02DQpJRVZZUVUxUVRFVlRMbXhsYm1kMGFDd2daM1ZwWkdVNklFZFZTVVJGTG14bGJtZDBhQ3dnY21WaFpIazZJSGRoY20xbFpGVndMQTBLSUNBZ0lDQWdjSEp2WW14bGJUb2dLR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdKMjlySnlCOGZDQmpiR0YxWkdWVGRHRjBkWE1nUFQwOUlHNTFiR3dwSUQ4Z2JuVnNiQ0E2SUdOc1lYVmtaVk4wWVhSMWN5d05DaUFnSUNBZ0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3TkNpQWdJQ0FnSUhObGNuWmxaRG9nYzNSaGRITXVjMlZ5ZG1Wa0xDQnNZWE4wUVhRNklITjBZWFJ6TG14aGMzUkJkQ3dnYkdGemRGUmxlSFE2SUhOMFlYUnpMbXhoYzNSVVpYaDBMQ0JzWVhOMFUyVmpPaUJ6ZEdGMGN5NXNZWE4wVTJWakxBMEtJQ0FnSUgwcE93MEtJQ0I5RFFvZ0lDOHZJTzJVak91ZnJPcTN1T3lkdUNEc2k2enNucVhyc0pYcmo1a2c0b0NVSU91Qml1cTRzT3VwdENEc25JUWc2ckNRN0l1Y0lPMkRnT3lkdE91b3VPcXdnQ0RyaTZUcnBxenJwYndnNjRHSTY0dWtEUW9nSUdsbQ0KSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OW9aV0Z5ZEdKbFlYUW5LU0I3RFFvZ0lDQWdiR0Z6ZEVKbFlYUWdQU0JFWVhSbExtNXZkeWdwT3cwS0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPdzBLSUNCOURRb2dJQzh2SU91aG5PcTN1T3lkdUNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0N0oyWUlGdnduNStnSU8yQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJnZzdaV0U3SnFVWGNLM1cvQ2ZsSkZkSU91eWhPMkt2T3lkdENEdG1ManN0cHp0bFp6cmk2UXVEUW9nSUM4dklPcTRzT3V6dUNqcnVJenJuYnpzbXJEc29JQWc3S2VCN1phSktUb2dZR05zWVhWa1pTQmhkWFJvSUd4dloybHVJQzB0WTJ4aGRXUmxZV2xnNjZXOElPeUlxT3lkZ0NEdGxJVHJvWnpzaExqc2lxVHJvWndnN0l1azdaYUpJT0tBbENEcnFaVHJpYlFnN0plRzdKMjBJT3F6cCt5ZXBTRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA2ck9nTEEwS0lDQXYNCkx5QWdJR3h2WTJGc2FHOXpkQ0RzaUpqc2k2QWc3WStzN1lxNDY2R2NJT3F5c09xenZPdWx2Q0RzbnBEcmo1a2c3SWlZNjZDNTdaV2M2NHVrS095THBPeTRvVG9nN1plazY1T2M2NmFzN0lxazdKZVE3SVNjNjQrRUlPdTRqT3Vkdk95YXNPeWdnQ0RzbDdUcnByd2dLeUJNU1ZOVVJVNGc3Wm1WN0oyNExDQXlNREkyTFRBM0tTNE5DaUFnTHk4Z0lDRHRoTERycjdqcmhKRHNuYlFnN1ptVTY2bTA3SmVRSU95Z2hPMllnQ0RzbFlnZzY1eXM2NHVrTGlEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjQ2NmVNSU8yVm1PdXB0Q0RyZ1owdURRb2dJQzh2SU8yUHRPdXdzU2p0aExEcnI3anJoSkFwT2lEc25wRHJqNWtnN0ptRTY2T002ckNBSU91bmllMmVqQ0R0bVpqcXNyMG82N2lNNjUyODdKcXc3S0NBNnJDQUlHeHZZMkZzYUc5emRPeVhrQ0RycXJzZzY0dS83SldFSU95OWxPdVRuT3F3Z0NEcnM3VHNuYlRyaXBRZzZySzk3SnF3S2V5WGtPeUVuQTBLSUNBdkx5QWdJT3Vobk9xM3VPeWR1Q0RyaklEcXVMQWc3S1NSDQpJT3V5aE8yS3ZPeWRoQ0RybUpBZzY0aUU2NlcwNjZtMExDRHN2WlRyazV6cnBid2c2N2FaN0plczY0U2o3SjJFSU95SW1DRHNub2pyaXBRZzdZU3c2Nis0NjRTUUlPdXdxZXlMbmV5Y3ZPdWhuQ0Rzb0lUdG1aanRsWnpyaTZRdURRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXZjR1Z1TFd4dloybHVKeWtnZXcwS0lDQWdJR052Ym5OMElHSnZaSGtnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93MEtJQ0FnSUdOdmJuTjBJSE4zYVhSamFFMXZaR1VnUFNBaElTaGliMlI1SUNZbUlHSnZaSGt1YzNkcGRHTm9RV05qYjNWdWRDazdJQzh2SU9xemhPeWdsU0Rzb0lUdG1aZ2dQU0RzaTV6dGdhenJwcjhnN0xDOTdKeTg2NkdjSU95WHRPeVd0Q0RxczRUc29KWHNuWVFnNnJPZzY2VzhJT3lJbUNEc25vanFzb3dOQ2lBZ0lDQjBjbmtnZXcwS0lDQWdJQ0FnTHk4Z1kyeGhkV1JsNnJDQUlPeVhodXljdk91cHRDRHNsNnpxdUxEc2hKd2c2NEdLNjRxVQ0KNjR1a0xpQnphR1ZzYkRwMGNuVmw2NTI4SUdOc1lYVmtaZXF3Z0NEc2w0YnNsclRyajRRZzdJVzQ3SjJBSU95Z2xleURnU0RzaTZUdGxvbnJqN3dOQ2lBZ0lDQWdJQzh2SUhOd1lYZHU3SjJZSUNkbGNuSnZjaWZxc0lBZzdKV0lJT3VjcU9xem9Dd2c3SmlJN0tDRTdKZVVJT3EzdU91TWdPdWhuQ0J2YXpwMGNuVmw2Nlc4SU91UGpPdWdwT3lrck91THBDRGlnSlFOQ2lBZ0lDQWdJQzh2SU8yVWpPdWZyT3EzdU95ZHVPeWRnQ0FpNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lYdE95WGlPeVd0T3lhbENMcm5ienFzNkFnN1pXWTY0cVU2NDJ3SU95THBPeWduT3Vobk91S2xDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPdWNxT3VLbENEc2c0SHRnNXpxc0lBZzY1Q1E2NHVrS095THBPeWduQ0RzaTZEcXM2QXBMZzBLSUNBZ0lDQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjJOc1lYVmtaUzF0YVhOemFXNW5KeWtnZXcwS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Td2dldzBLSUNBZ0lDQWcNCklDQWdJR1Z5Y205eU9pQW43SjIwSUZCRDdKZVFJRU5zWVhWa1pTQkRiMlJsNnJDQUlPeVhodXlXdE95YWxDRGlnSlFnN1lTdzY2KzQ2NFNRN0plUTdJU2NJR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3SjIwSU91UW1PdUtsT3luZ0NEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxpY3NEUW9nSUNBZ0lDQWdJQ0FnY0hKdllteGxiVG9nSjJOc1lYVmtaUzF0YVhOemFXNW5KeXdOQ2lBZ0lDQWdJQ0FnZlNrN0RRb2dJQ0FnSUNCOURRb2dJQ0FnSUNBdkx5RHNwNFR0bG9rZzdLU1I3SjI0NjQyd0lPdVlrQ0RyaUl6cm9JRHJpNlFnNG9DVUlPcTRpT3V3cVNnMk1PeTBpQ0RyZ3JRcElPdUxwT3lMbkNEcmlJVHJwYmdnNnJHMElDTHNzTDNzbllRZzY0dXI3SldZNjR1a0wrdXF1eURydEtUcmk2UWk3SmVRSU9xd2dPcTVqT3lhc091dmdPdWhuQ0RydUl6cm5ienNtckRzb0lEcm9ad2c3SjZzN0l1YzY0K0U3WldjNjR1a0xnMEtJQ0FnSUNBZ0x5OGc3WldjN0xDNElPdVNwT3lYa091UGhDRHJtSkFnNjRpRTY2VzA2NHFVDQpJT3F4dENEcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wSU95OW5PdXdzZXlYa0NEcnFyc2c2NHUvN0pXRUlPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzdKV0lJT3VRbU91S2xDRHRtWmpxc3Izc25id2c3SWlZSU95ZWlPeWN2T3VMaUEwS0lDQWdJQ0FnTHk4ZzZyZTQ2NVdNNjZlTUlPeTlsT3VUbk91bHZDRHJ0cG5zbDZ6cmhLUHNuWVFnN0lpWUlPeWVpT3VLbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJTzJQdE91d3NlMlZuT3VMcENBbzY1R1FJT3V5aU95bnVDRHRnYlRycHEzc2w1QWc3WVN3NjYrNDY0U1E3SjIwSU8yS2dPeVd0T3VDbU95WXBPdXB0Q0RyaTdudG1hbnNpcVRybjczcmk2UXBMZzBLSUNBZ0lDQWdZMjl1YzNRZ2MzUmhiR1VnUFNCc2IyZHBibEJ5YjJNZ0ppWWdLRVJoZEdVdWJtOTNLQ2tnTFNCc2IyZHBibE4wWVhKMFpXUkJkQ0ErSURZd01EQXdLVHNOQ2lBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJNZ0ppWWdjM1JoYkdVcElIc05DaUFnSUNBZ0lDQWdhMmxzYkV4dg0KWjJsdVVISnZZeWdwT3cwS0lDQWdJQ0FnSUNCcFppQW9JVzl3Wlc1TWIyZHBibFJsY20xcGJtRnNLQ2twSUhzTkNpQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNU3dnZXlCbGNuSnZjam9nSit5ZHRDQlBVK3lYa095RW9DRHNucERyajVuc25MenJvWndnNjZxN0lPeVh0T3lXdE95YWxDRGlnSlFnN1lTdzY2KzQ2NFNRN0plUTdJU2NJR05zWVhWa1pTRHNpNlR0bG9rZzdadUVJQzlzYjJkcGJpRHRsYlFnN0tPODdJUzQ3SnFVTGljZ2ZTazdEUW9nSUNBZ0lDQWdJSDBOQ2lBZ0lDQWdJQ0FnTHk4ZzdKMlk2NCtFN0tDQklPeWloZXVqakNoeVpXRnpiMjRnN0tlQTdLQ1ZLU0RpZ0pRZzdLZUU3WmFKSU95a2tTRHRoTFRzbllRZ1UwVlRVMGxQVGw5RVNVVkU2NkdjSU91Qm5ldUN0T3VwdENEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1zT3VMcEEwS0lDQWdJQ0FnSUNCcmFXeHNVSEp2WXlnbjY2R2M2cmU0N0oyNDdKMkUNCklPeW5oTzJXaWUyVm1PdUtsQ0RzcEpIc25iVHJuYndnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQ0RpZ0pRZzY2R2M2cmU0N0oyNElPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRuS1RzTkNpQWdJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec05DaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEdGo3VHJzTEVnNG9DVUlPMkVzT3V2dU91RWtDRHJzS25zaTUzc25MenJvWndnN0tDRTdabVlMaWNwT3cwS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnYlc5a1pUb2dKM1JsY20xcGJtRnNKeUI5S1RzTkNpQWdJQ0FnSUgwTkNpQWdJQ0FnSUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNnTHk4ZzdKV2U3SVNnSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianNuYlFnNjR5QTZyaXdJT3lra2V5ZHRPdXB0Q0Rzb0pIcXM2QWc3SU9JNjZHY0lPeVhzT3VMDQpwQ0FvN0xDOTdKMkVJT3VMcSt5Vm1PcXhzT3VDbUNEcmk2VHNpNXdnNjRpRTY2VzRJT3F5dmV5YXNDa05DaUFnSUNBZ0lHeHZaMmx1VTNSaGNuUmxaRUYwSUQwZ1JHRjBaUzV1YjNjb0tUc05DaUFnSUNBZ0lDOHZJRUpTVDFkVFJWTHJpcFFnNnJHMDY1T2M2NmFzN0tlQUlPeVZpdXVLbE91THBDRGlnSlFnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdLZUI3S0NSSU95WHNPdUxwQ0FvN0p5RUlDZENVazlYVTBWU0lPcXdnT3Vobk95eGhPcTRzT3VLbENEc29KenFzYkRya0pEcmk2UW5JT3lqdk95RW5TRHNzTGpxczZBcERRb2dJQ0FnSUNCamIyNXpkQ0JzYjJkcGJrVnVkaUE5SUVOTVFWVkVSVjlGVGxZN0RRb2dJQ0FnSUNCamIyNXpkQ0IwYUdselRHOW5hVzRnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3lkaGRYUm9KeXdnSjJ4dloybHVKeXdnSnkwdFkyeGhkV1JsWVdrblhTd2dldzBLSUNBZ0lDQWdJQ0J6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJzYjJkcGJrVnVkaXdnYzNSaw0KYVc4NklDZHBaMjV2Y21VbkxDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTd05DaUFnSUNBZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzSUM4dklHdHBiR3hNYjJkcGJsQnliMlBzblpnZzZyZTQ2Nk81SUd0cGJHenNtcWtnS0d0cGJHeFFjbTlqNnJPOElPdVBtZXlkdkNEdGpLanRoTFFwRFFvZ0lDQWdJQ0I5S1RzTkNpQWdJQ0FnSUd4dloybHVVSEp2WXlBOUlIUm9hWE5NYjJkcGJqc05DaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR2xtSUNoc2IyZHBibEJ5YjJNZ1BUMDlJSFJvYVhOTWIyZHBiaWtnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNnZlNrN0RRb2dJQ0FnSUNCMGFHbHpURzluYVc0dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNOQ2lBZ0lDQWdJQ0FnYVdZZ0tHeHZaMmx1VUhKdll5QWhQVDBnZEdocGMweHZaMmx1S1NCeVpYUjFjbTQ3RFFvZ0lDQWdJQ0FnSUd4dloybHVVSEp2WXlBOUlHNTENCmJHdzdEUW9nSUNBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJOVWFXMWxjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9iRzluYVc1UWNtOWpWR2x0WlhJcE95QnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlHNTFiR3c3SUgwTkNpQWdJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec2dMeThnN0lPSUlPcXpoT3lnbGV5ZHZDRHNpSmdnN0o2STdKeTg2NHVJSU91THBPeWRqQ0F2YUdWaGJIUm9JT3VWakNEcmk2VHNpNXdnN0oyOTZyaXdEUW9nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJT3lnaU95d3FDRHNvb1hybzR3Z0tHTnZaR1VnSnlBcklHTnZaR1VnS3lBbktTY3BPdzBLSUNBZ0lDQWdJQ0F2THlEc2dxenJub3pzbmJRZzY2R2M2cmU0N0oyNDdaV2dJT3lMbk9xd2hPdVBoQ0RzbDRic25iUWc2ck9uNjdDVTY2R2NJT3lMcE8yTXFPdWhuQ0RyZ1ozcmdxenJpNlFnUFNCamJHRjFaR1hxc0lBZzdKZUc2ckd3NjRLWUlPeUxwTzJXDQppZXlkdENEc2xZZ2c2NUNjSU9xeWd5NE5DaUFnSUNBZ0lDQWdMeThnN0oyUjY0dTE3SjJBSU95ZHRPdXZ1Q0RyczdUcmc0anNuTHpyaTRnZzdJT0I3WU9jNjZXOElPdUxwT3lMbkNEc25xenNoSndnTDJobFlXeDBhT3VobkNEc2xZenJwckRyaTZRZ0tPMlVqT3Vmck9xM3VPeWR1T3lkdENEcmpJRHF1TEFnN1ptVTY2bTA3SjJFSU95THBPMk1xT3VobkNEcnNKVHF2cnpyaTZRcExnMEtJQ0FnSUNBZ0lDQnBaaUFvWTI5a1pTQWhQVDBnTUNBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQQ0ExTURBd0tTQjdEUW9nSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVPeWR0Q0RzcG9uc2k1d2c3SXVrN1l5bzY2R2NJT3VCbmV1Q3FDRGlnSlFnUTJ4aGRXUmxJRU52WkdVZzdJU2s3TG1ZSU95RGdlMkRuT3VsdkNEcmk2VHNpNXdnN0tDUTZyS0E3WldwNjR1STY0dWtMaWNwT3cwS0lDQWdJQ0FnSUNBZ0lHTm9aV05yUTJ4aGRXUmxRWFpoYVd4aA0KWW14bEtDazdEUW9nSUNBZ0lDQWdJSDBOQ2lBZ0lDQWdJSDBwT3cwS0lDQWdJQ0FnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSHNnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDQXhNT3UyaENEcXNyM3FzN3dnNG9DVUlPdU1nT3E0c0NEdGxJVHJvWnpzaExqc2lxUWc3S0NWNjZhc0xpY3BPeUJyYVd4c1RHOW5hVzVRY205aktDazdJSDBzSURZd01EQXdNQ2s3RFFvZ0lDQWdJQ0F2THlEcmdxSHNuWUFnN0o2RjdKNmw2cmFNN0oyRUlPdXN2T3F6b0NEc25vanJpcFFnNjR5QTZyaXdJT3lFdU95Rm1PeWRnQ0Ryc29UcnByRHJpNlFnNG9DVUlPeWVyT3Vobk9xM3VPeWR1Q0R0bTRRZzY0dWs3SjJNSU95YWxPeXlyZXlkdENEc2c0Z2c3SVM0N0lXWUtPeURpQ0Rzbm9Yc25xWHF0b3dwN0p5ODY2R2NJT3lMbk95ZWtlMlZtT3F5akM0TkNpQWdJQ0FnSUM4dklPeWRtT3VQaE95Z2dTRHNvb1hybzR3b2NtVmhjMjl1SU95bmdPeWdsU2tnNG9DVUlGTkYNClUxTkpUMDVmUkVsRlJPdWhuQ0RyZ1ozcmdyVHJxYlFnN0o2UTY0K1pJT3llck95TG5PdVBoT3F3Z0NEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcm9LUU5DaUFnSUNBZ0lDOHZJT3llck91aG5PcTN1T3lkdUNEcmtxVHNsNURyajRRZ1RVRllYMVJWVWs1VDZybU03S2VBSU95WW15RHFzNFRzb0pYc25MenJvWndnN0xLWTY2YXM2NUNZNjRxVUlPdXloT3EzdU9xd2dDRHJrSnpyaTZRZ0tESXdNall0TURjZzY2YXM2N2V3N0plUTdJU2NJTzJabGV5ZHVDa05DaUFnSUNBZ0lHdHBiR3hRY205aktDZnJvWnpxdDdqc25ianNuWVFnN0tlRTdaYUo3WldZNjRxVUlPeWtrZXlkdE91ZHZDRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bzdaYUk3SmEwN0pxVUlPS0FsQ0Ryb1p6cXQ3anNuYmdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3BPdzBLSUNBZ0lDQWdZV05qYjNWdWRFTmhZMmhsTG1GMElEMGdNRHNOQ2lBZ0lDQWdJQzh2SUhOM2FYUmphRTF2WkdYcmlwUWc3SjIwDQo3S0NjSU91aG5PcTN1Q0RyckxqcXRhekN0K3lka2V1THRTQnRiMlJsSU8yUm5PeUxuT3lhcVNEaWdKUWdWVkpNN0oyQUlPdVJrQ0Rxc3Izc21yQWc2NnFvNjVHUUlPeWJrT3VzdUNEcXQ3anJqSURyb1p3ZzdKZXc2NHVrS095Y2hDQjNjbWwwWlVKeWIzZHpaWEpJWVc1a2JHVnlJT3lqdk95RW5Ta05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeUxuT3lla1NjZ0t5QW9jM2RwZEdOb1RXOWtaU0EvSUNjZ0tPcXpoT3lnbFNEc29JVHRtWmdnNG9DVUlPeUt1ZXlkdUNEdG1aVHJxYlRzbDVEc2hKd2dXK3F6aE95Z2xTRHNvSVR0bVpoZDdKMkVJT3VJaE91bHRPdXB0Q0RyaTZUcnBiZ2c2ck9FN0tDVjdKMkVJT3F6b091bHZDRHNpSmdnN0o2STdKYTA3SnFVS1NjZ09pQW5KeWtnS3lBbklPS0FsQ0Ryb1p6cXQ3anNuYmp0bFpqcnFiUWc3SjZRNjQrWklPeVhzT3F5c091UXFldUxpT3VMcEM0bktUc05DaUFnSUNBZ0lISmxkSFZ5YmlCcQ0KYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQnpkMmwwWTJoTmIyUmxJRDhnSjJKeWIzZHpaWEl0YzNkcGRHTm9KeUE2SUNkaWNtOTNjMlZ5SnlCOUtUc05DaUFnSUNCOUlHTmhkR05vSUNobEtTQjdEUW9nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNQ3dnZXlCbGNuSnZjam9nSit1aG5PcTN1T3lkdUNEc3NMM3NuWVFnNjZxN0lPeVh0T3lYaU95V3RPeWFsRG9nSnlBcklHVXViV1Z6YzJGblpTQjlLVHNOQ2lBZ0lDQjlEUW9nSUgwTkNpQWdMeThnS08yRXNPdXZ1T3VFa0NEdGo3VHJzTEVnNnJXczdaaUU2N2FBSU9LQWxDRHJ1SXpybmJ6c21yRHNvSUFnN0o2UTY0K1pJT3laaE91ampPcXdnQ0RzbFlnZzY1Q1k2NHFVSU8yWm1PcXl2U0Rzb0lUc21xa3BEUW9nSUdaMWJtTjBhVzl1SUc5d1pXNU1iMmRwYmxSbGNtMXBibUZzS0NrZ2V3MEtJQ0FnSUhzTkNpQWdJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3RFFvZ0lDQWcNCklDQWdJQzh2SUhOMFlYSjA2ckNBSU95RGlDRHN2WmpzaHBRZzdMQzk3SjJFSU91bmpPdVRvT3VMcENBbzY0dWs2NmFzN0oyWUlPeUlxT3lkZ0NEc3ZaanNocFRxczd3ZzY2eTA2clNBN1pXWTZyS01JT3lDck95YXFleWVrT3lYa09xeWpDRHJzN1Rzbm9RcExnMEtJQ0FnSUNBZ0lDQXZMeURzbmJUc2xyVHNoSndnVUc5M1pYSlRhR1ZzYkNndWNITXhLZXlkdENBMTdMU0lJT3VTcENEcXQ3Z2c3TEM5N0plUUlPeVhsTzJFc091bHZDRHJzN1RyZ3JRZ01ldXlpQ2pxdGF6cmo0VWc2ck9FN0tDVktleWRoQ0RzbnBEcmo1a2c3SVNnN1lPZDdaV1k2ck9nTEEwS0lDQWdJQ0FnSUNBdkx5RHNzTDNzbllRZzdMV2M3SWFNN1ptVTdaVzBJT3lDck95YXFleWVrQ0RyaUlqc2w1UWc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdU91bmpDRHJncWpxc293ZzdaV2M2NHVrTGlEc3NMM3NuWVFnNjZxN0lPeXd2dXljdk91cHRDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPMlZuT3VMcEEwS0lDQWdJQ0FnSUNBdkx5QW82NHVrDQo2Nlc0SU95d3ZTRHNtS1Rzbm9Ycm9LVWc2N0NwN0tlQUlPS0FsQ0RxdDdnZzZySzk3SnF3SU91cGxPdUp0T3F3Z0NEcnM3VHNuYlRyaXBRZzdMR0U2NkdjSU91Q3FPcXpvQ0RzZ3F6c21xbnNucERxc0lBZzdKZVU3WVN3SU8yVm5DRHJzb2dnNjRpRTY2VzA2Nm0wSU91UXFDa3VEUW9nSUNBZ0lDQWdJQzh2SU95anZPeWRtRG9nWTJ4aGRXUmw2ckNBSU95OW1PeUdsQ0Rzb0p6cnFxbnNuWVFnNjdDVTZyNjQ2Nm0wSUVGd2NFRmpkR2wyWVhSbEwwWnBibVJYYVc1a2IzZnFzSUFnNjZxN0lPeXd2dXlkaENEc2lKZ2c3SjZJN0oyTUlPS0FsQ0Rzbklqcmo0VHNtckFnN0l1azZyaXc3SmVRN0lTY0lPMlpsZXlkdUNEdGxZVHNtcFF1RFFvZ0lDQWdJQ0FnSUdOdmJuTjBJSEJ6TVNBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRiRzluYVc0dWNITXhKeWs3RFFvZ0lDQWdJQ0FnSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vY0hNeExDQmJEUW9nSUNBZ0lDQWdJQ0FnSjFOMA0KWVhKMExWTnNaV1Z3SUMxVFpXTnZibVJ6SURVbkxBMEtJQ0FnSUNBZ0lDQWdJQ2NrZDNNZ1BTQk9aWGN0VDJKcVpXTjBJQzFEYjIxUFltcGxZM1FnVjFOamNtbHdkQzVUYUdWc2JDY3NEUW9nSUNBZ0lDQWdJQ0FnSW1sbUlDZ2tkM011UVhCd1FXTjBhWFpoZEdVb0oyTnNZWFZrWlMxc2IyZHBiaWNwS1NCN0lpd05DaUFnSUNBZ0lDQWdJQ0FpSUNBa2QzTXVVMlZ1WkV0bGVYTW9KMzRuS1NJc0RRb2dJQ0FnSUNBZ0lDQWdKeUFnVTNSaGNuUXRVMnhsWlhBZ0xWTmxZMjl1WkhNZ01pY3NEUW9nSUNBZ0lDQWdJQ0FnSWlBZ1FXUmtMVlI1Y0dVZ0xVNWhiV1Z6Y0dGalpTQlZJQzFPWVcxbElGY2dMVTFsYldKbGNrUmxabWx1YVhScGIyNGdKMXRFYkd4SmJYQnZjblFvWENKMWMyVnlNekl1Wkd4c1hDSXBYU0J3ZFdKc2FXTWdjM1JoZEdsaklHVjRkR1Z5YmlCVGVYTjBaVzB1U1c1MFVIUnlJRVpwYm1SWGFXNWtiM2NvYzNSeWFXNW5JR01zSUhOMGNtbHVaeUIwS1RzZ1cwUnNiRWx0Y0c5eWRDaGNJblZ6WlhJek1pNWsNCmJHeGNJaWxkSUhCMVlteHBZeUJ6ZEdGMGFXTWdaWGgwWlhKdUlHSnZiMndnVTJodmQxZHBibVJ2ZHloVGVYTjBaVzB1U1c1MFVIUnlJR2dzSUdsdWRDQnVLVHNuSWl3TkNpQWdJQ0FnSUNBZ0lDQWlJQ0FrYUNBOUlGdFZMbGRkT2pwR2FXNWtWMmx1Wkc5M0tGdE9kV3hzVTNSeWFXNW5YVG82Vm1Gc2RXVXNJQ2RqYkdGMVpHVXRiRzluYVc0bktTSXNEUW9nSUNBZ0lDQWdJQ0FnSnlBZ2FXWWdLQ1JvSUMxdVpTQmJVM2x6ZEdWdExrbHVkRkIwY2wwNk9scGxjbThwSUhzZ1czWnZhV1JkVzFVdVYxMDZPbE5vYjNkWGFXNWtiM2NvSkdnc0lEWXBJSDBuTENBdkx5QTJJRDBnVTFkZlRVbE9TVTFKV2tVTkNpQWdJQ0FnSUNBZ0lDQW5mU2NzRFFvZ0lDQWdJQ0FnSUYwdWFtOXBiaWduWEhKY2JpY3BJQ3NnSjF4eVhHNG5LVHNOQ2lBZ0lDQWdJQ0FnWTI5dWMzUWdZbUYwSUQwZ2NHRjBhQzVxYjJsdUtHOXpMblJ0Y0dScGNpZ3BMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTMXNiMmRwYmk1aVlYUW5LVHNOQ2lBZ0lDQWdJQ0FnDQpabk11ZDNKcGRHVkdhV3hsVTNsdVl5aGlZWFFzSUNkQVpXTm9ieUJ2Wm1aY2NseHVKeUFyRFFvZ0lDQWdJQ0FnSUNBZ0ozTjBZWEowSUNKamJHRjFaR1V0Ykc5bmFXNGlJR050WkNBdmF5QmpiR0YxWkdVZ0wyeHZaMmx1WEhKY2JpY2dLdzBLSUNBZ0lDQWdJQ0FnSUNkd2IzZGxjbk5vWld4c0lDMU9iMUJ5YjJacGJHVWdMVVY0WldOMWRHbHZibEJ2YkdsamVTQkNlWEJoYzNNZ0xVWnBiR1VnSWljZ0t5QndjekVnS3lBbklseHlYRzRuS1RzTkNpQWdJQ0FnSUNBZ2MzQmhkMjRvSjJOdFpDY3NJRnNuTDJNbkxDQmlZWFJkTENCN0lHVnVkam9nUTB4QlZVUkZYMFZPVml3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc05DaUFnSUNBZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjJSaGNuZHBiaWNwSUhzTkNpQWdJQ0FnSUNBZ0x5OGdjSFI1S0dWNGNHVmpkQ25yb1p3ZzY3TzA2NEs0SU8yQ3BPeVhrQ0R0Z2JUcm9aenJrNXdnVkZWSg0KNnJDQUlPdXN0T3V3bU95ZGtleWR1Q0Rxc29Qc25iUWc3SXVrN0xpaElPMlpsZXlkdU91UXFDZ3lNREkyTFRBM0xDRHNuYnpyc0pnZ1hITEN0MnRwZEhSNUlPeTlsT3VUbkNEcnFxanJrWkFwSU9LQWxBMEtJQ0FnSUNBZ0lDQXZMeURzbktEc25ienRsWndnN0o2UTY0K1o3Wm1VSU9xeXZldWhuT3VLbENCVGVYTjBaVzBnUlhabGJuUno3SjJZSU95bmhPeW5uQ0R0Z3FRZzdKNkY2NkNsTGlEc29KSHF0N3pzaExFZzZyYU03WldjN0oyMElPeWVpT3ljdk91cHRDQTI3TFNJSU91U3BDRHNsNVR0aExEcXNJQWc3SjZRNjQrWklPeWVoZXVncGV1UHZBMEtJQ0FnSUNBZ0lDQXZMeUF4NjdLSUtPcTFyT3VQaFNEcXM0VHNvSlVwN0oyMElPeUVvTzJEbmV1UW1PcXpvQ3dnNnJhTTdaV2M3SjIwSU95WGh1eWN2T3VwdENCclpYbHpkSEp2YTJVZzdLU0U2NmVNSU95aHNPeWFxZTJlaUNEc2k2VHRqS2p0bGJRZzdJS3M3SnFwN0o2UTZyQ0FJT3lYbE8yRXNDRHRsWndnNjdLSUlPdUloT3VsdE91cHRDRHJrSnpyaTZRb1ptRnANCmJDMXpiMlowS1M0TkNpQWdJQ0FnSUNBZ0x5OGc3SmVVN1lTd0lPeW5nZXlnaE95WGtDQlVaWEp0YVc1aGJPeWRoQ0RyaTZUc2k1d2c3SldlN0p5ODY2R2NJT3F3Z095Z3VPeVpnQ0RyaTZUcnBiZ2c3Sld4N0plUUlPMkNwT3F3Z0NEcms2VHNsclRxc0lEcmlwUWc2cktEN0oyRUlPdW5pZXVLbE91THBDNE5DaUFnSUNBZ0lDQWdjM0JoZDI0b0oyOXpZWE5qY21sd2RDY3NJRnNOQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHUnZJSE5qY21sd2RDQWlZMnhoZFdSbElDOXNiMmRwYmlJbkxBMEtJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWVdOMGFYWmhkR1VuTEEwS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0EySnl3TkNpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBbmRHVnNiQ0JoY0hCc2FXTmhkR2x2YmlBaVZHVnliV2x1WVd3aUlIUnZJR0ZqZEdsMllYUmxKeXdODQpDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5aR1ZzWVhrZ01DNHpKeXdOQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVTNsemRHVnRJRVYyWlc1MGN5SWdkRzhnYTJWNWMzUnliMnRsSUhKbGRIVnliaWNzRFFvZ0lDQWdJQ0FnSUNBZ0x5OGc3SmVVN1lTdzZyQ0FJT3lMcE95Z25PdWhuQ0RyazZUc2xyVHFzSVFnNnJLOTdKcXc3SmVRNjZlTUlPeVhyT3E0c0NEcmo0VHJpNndvNnJhTTdaV2NJT3lYaHV5Y3ZPdXB0Q0RzbklUc2w1RHNoSndnN0tTUjY0dW9LU0RpZ0pRZzdZU3c2Nis0NjRTUTdKMkVJT3k1bU95YmpDRHJ1SXpybmJ6c21yRHNvSURycDR3ZzY0S282cmkwNjR1a0RRb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURFdU5TY3NEUW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbFJsY20xcGJtRnNJaUIwYnlCelpYUWdiV2x1YVdGMGRYSnBlbVZrSUc5bUlHWnliMjUwSUhkcGJtUnZkeUIwYnlCMGNuVmxKeXdOQ2lBZw0KSUNBZ0lDQWdYU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0RRb2dJQ0FnSUNCOUlHVnNjMlVnZXcwS0lDQWdJQ0FnSUNCeVpYUjFjbTRnWm1Gc2MyVTdJQzh2SU95bmdPeWJrQ0RzbFlnZzdaV1k2NHFVSUU5VERRb2dJQ0FnSUNCOURRb2dJQ0FnSUNCeVpYUjFjbTRnZEhKMVpUc05DaUFnSUNCOURRb2dJSDBOQ2lBZ0x5OGc3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRHJvWnpxdDdqc2xZVHNtNE1nNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0R0bVlqc25aZ2dXK3Vobk9xM3VPeVZoT3liZzEwZzY3S0U3WXE4N0oyMElPMll1T3kybkM0Z1kyeGhkV1JsSUdGMWRHZ2diRzluYjNWMDdKeTg2NkdjSUVOTVNTRHJvWnpxdDdqc25ianNuWVFnN1pXMDdLQ2M3WldjNjR1a0xnMEtJQ0F2THlBbzdKMjBJRkJEN0oyWUlPeWdnT3llcGV1UW5DRHNucERxc3Fuc3BwM3Jxb1hzbllRZzdLZUE3SnEwNjR1a0lPS0FsQ0RyaTZUc2k1d2c3Sk93NjZDazY2bTBJT3llck91aG5PcTN1T3lkdUNEdGxZVHNtcFF1S1NEcm9aenENCnQ3anNsWVRzbTRNZzdadUU3SmVVSU95RXVPeUZtTUszNnJPRTdLQ1Y3THFRN0l1YzY2VzhJT3lnbGV1bXJPMlZuT3VMcEM0TkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyTnNZWFZrWlMxc2IyZHZkWFFuS1NCN0RRb2dJQ0FnWTI5dWMzUWdiRzhnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3lkaGRYUm9KeXdnSjJ4dloyOTFkQ2RkTENCN0lITm9aV3hzT2lCMGNuVmxMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWXNJSGRwYm1SdmQzTklhV1JsT2lCMGNuVmxJSDBwT3cwS0lDQWdJR3hsZENCbGNuSWdQU0FuSnpzTkNpQWdJQ0JzYnk1emRHUmxjbkl1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXlCbGNuSWdLejBnWkM1MGIxTjBjbWx1WnlncE95QjlLVHNOQ2lBZ0lDQnNieTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXlCcWMyOXVLSEpsY3l3Z05UQXdMQ0I3SUc5ck9pQm1ZV3h6WlN3Z1pYSnliM0k2SUNmcm9aenF0N2pzbFlUc200TWc3SXVrDQo3WmFKSU95THBPMk1xRG9nSnlBcklHVXViV1Z6YzJGblpTQjlLVHNnZlNrN0RRb2dJQ0FnYkc4dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNOQ2lBZ0lDQWdJR3RwYkd4UWNtOWpLQ2Zyb1p6cXQ3anNsWVRzbTRQdGxiVHNoSndnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQzRuS1RzZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDRGlnSlFnN0o2UTY0K1pJT3llck95TG5PdVBoT3F3Z0NEc2hManNoWmpzbllRZzY1Q1k3SUswNjZhczY2bTBJT3lWaUNEcmtLZ05DaUFnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQ0FnSUNBZ0lDQXZMeURyaTZUc25Zd2dMMkZqWTI5MWJuVEN0eTlvWldGc2RHanNsNURzaEp3ZzZyT0U3S0NWN0oyRUlPeURpT3VobkNnOTdKZUc3SjJNN0p5ODY2R2NLU0RzbmIzcXNvd05DaUFnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQXZMeURzZzRIdGc1d2c3SjZzN1l5UTdLQ1ZLT3VMcE95ZGpDRHRoTFRzbDVEcw0KaEp3ZzY2KzQ2NkdjNnJlNDdKMjRJT3F3a095bmdDa05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SldFN0p1RElDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a25LVHNOQ2lBZ0lDQWdJR2xtSUNoeVpYTXVhR1ZoWkdWeWMxTmxiblFwSUhKbGRIVnlianNnTHk4Z1pYSnliM0lnN1pXNDY1T2s2NStzNnJDQUlPeWR0T3V2dUNEc25aSHJpN1h0bG9qc25MenJxYlFnN0tTUjY3TzFJT3V3cWV5bmdBMEtJQ0FnSUNBZ2FXWWdLR052WkdVZ1BUMDlJREFwSUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0RRb2dJQ0FnSUNCbGJITmxJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2diMnM2SUdaaGJITmxMQ0JsY25KdmNqb2dLR1Z5Y2k1MGNtbHRLQ2t1YzJ4cFkyVW9NQ3dnTVRVd0tTa2dmSHdnS0Nmc29vWHJvNHdnN0wyVTY1T2NJQ2NnS3lCamIyUmxLU0I5S1RzTkNpQWdJQ0I5S1RzTkNpQWdJQ0J5WlhSMWNtNDdEUW9nSUgwTkNpQWcNCkx5OGc3SjZRNnJpd0lPeWloZXVqakNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SUZOVVQxQmZRbEpKUkVkRkwrMlZtTzJLdU91NWhPMkt1T3F3Z0NEdG1ManN0cHp0bFp6cmk2UWdLT3Vobk95N3JPeVhrT3lFbk91bmpDRHNvSkhxdDd3ZzZyQ0E2NHFsN1pXWTY0dUlJT3lWaU95Z2hDa05DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM05vZFhSa2IzZHVKeWtnZXcwS0lDQWdJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3RFFvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95aWhldWpqQ0RzbXBUc3NxMGc2N0NiN0oyTUlPS0FsQ0RyaTZUcnBxenJwYndnNjRHVjY0dUk2NHVrTGljcE93MEtJQ0FnSUhOb2RYUjBhVzVuUkc5M2JpQTlJSFJ5ZFdVN0RRb2dJQ0FnYTJsc2JGQnliMk1vS1RzTkNpQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSEJ5YjJObGMzTXVaWGhwZENnd0tTd2dNakF3S1RzTkNpQWdJQ0J5DQpaWFIxY200N0RRb2dJSDBOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNKbFkyOXRiV1Z1WkNjcElIc05DaUFnSUNCamIyNXpkQ0I3SUhSbGVIUXNJRzF2WkdWc0xDQnliMnhsSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPdzBLSUNBZ0lHbG1JQ2doZEdWNGRDQjhmQ0FoVTNSeWFXNW5LSFJsZUhRcExuUnlhVzBvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZzdHBUc3NwenJzSnZzbllRZzY2eTQ2cldzNnJDQUlPdTVoT3lXdENEc25vanNpclhyaTRqcmk2UXVKeUI5S1RzTkNpQWdJQ0JqYjI1emRDQnpkR0Z5ZEdWa0lEMGdSR0YwWlM1dWIzY29LVHNOQ2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0xhVTdMS2NJT3lhbE95eXJUb25MQ0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z05UQXBMbkpsY0d4aFkyVW9MMXh1TDJjc0lDY2dKeWtnS3lBbjRvQ21KeXdnY205cw0KWlNBL0lDZGJKeUFySUhKdmJHVWdLeUFuWFNjZ09pQW5KeXdnYlc5a1pXd2dQeUFuS091cXFPdU51RG9nSnlBcklHMXZaR1ZzSUNzZ0p5a25JRG9nSnljcE93MEtJQ0FnSUhSeWVTQjdEUW9nSUNBZ0lDQmpiMjV6ZENCeUlEMGdZWGRoYVhRZ1lYTnJRMnhoZFdSbEtGTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3NJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlZOMVoyZGxjM1JwYjI1ekxDQm1iM0p0WVhSRVpYTmpPaUFuVzNzaWRHVjRkQ0k2SUNMcnJManF0YXdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOUxDQXVMaTVkSnlCOUxDQnliMnhsS1RzTkNpQWdJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ2NpNXdZWEp6WldRZ2ZId2dXMTA3RFFvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBb0tFUmhkR1V1Ym05M0tDa2dMU0J6ZEdGeWRHVmtLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2s3RFFvZ0lDQWdJQ0JwWmlBb0lYTjFaMmRsYzNScGIyNXpMbXhsYm1kMGFDa2dldzBLSUNBZ0lDQWcNCklDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPdzBLSUNBZ0lDQWdmUTBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeVZpQ0FuSUNzZ2MzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lDc2dKK3F3bkNBb0p5QXJJSE5sWXlBcklDZHpLU2NwT3cwS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdEUW9nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRE13S1RzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ6ZFdkblpYTjBhVzl1DQpjeXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzTkNpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0RRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3RFFvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc05DaUFnSUNCOURRb2dJSDBOQ2lBZ0x5OGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RpZ0pRZzdaV2NJTzJabE91cHRPeWRoQ0R0bFpqc25JUWc3WlNFNjZDSTdKNkVLT3lZZ2V5WHJTa2c2NHVvN0p5RTY2R2NJT3VDbU91SW9DRHJzSnZxczZBc0lPeVlnZXlYcmV1bmlPdUxwQ0RybExEcm9ad2c2NHlBN0pXSTdKMkVJT3VDdU91THBDNE5DaUFnTHk4ZzdKaUI3SmV0SU95SW1PdW5qTzJCdkNEc21wVHNzcTNzbllRZzdLcTg2ckNjN0tlQUlPeVZpdXVLbENEcXNvUHNuYlFnN1pXMTdJdXNJQ2pyaXBEcg0Kb0tUc3A0RHFzNkFnN0lLczdKcXA2NStKNjQrRUlPcTN1T3Vuak8yQnZDRHJncGpxc0lUcmk2UXBMZzBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2Y21WamIyMXRaVzVrTFdkeWIzVndjeWNwSUhzTkNpQWdJQ0JqYjI1emRDQjdJR2R5YjNWd2N5d2diVzlrWld3c0lHMXZjbVVnZlNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdEUW9nSUNBZ1kyOXVjM1FnYkdsemRDQTlJRUZ5Y21GNUxtbHpRWEp5WVhrb1ozSnZkWEJ6S1EwS0lDQWdJQ0FnUHlCbmNtOTFjSE1OQ2lBZ0lDQWdJQ0FnSUNBdWJXRndLQ2huS1NBOVBpQW9ldzBLSUNBZ0lDQWdJQ0FnSUNBZ2JtRnRaVG9nVTNSeWFXNW5LQ2huSUNZbUlHY3VibUZ0WlNrZ2ZId2dKeWNwTG5SeWFXMG9LU3dOQ2lBZ0lDQWdJQ0FnSUNBZ0lIUmxlSFJ6T2lBb1p5QW1KaUJCY25KaGVTNXBjMEZ5Y21GNUtHY3VkR1Y0ZEhNcElEOGdaeTUwWlhoMGN5QTZJRnRkS1M1dFlYQW9LSFFwSUQwK0lGTjANCmNtbHVaeWgwSUh4OElDY25LUzUwY21sdEtDa3BMbVpwYkhSbGNpaENiMjlzWldGdUtTd05DaUFnSUNBZ0lDQWdJQ0FnSUhKdmJHVTZJQ2huSUNZbUlHY3VjbTlzWlNrZ1B5QlRkSEpwYm1jb1p5NXliMnhsS1NBNklIVnVaR1ZtYVc1bFpDd05DaUFnSUNBZ0lDQWdJQ0I5S1NrTkNpQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaG5LU0E5UGlCbkxuUmxlSFJ6TG14bGJtZDBhQ2tOQ2lBZ0lDQWdJRG9nVzEwN0RRb2dJQ0FnYVdZZ0tHeHBjM1F1YkdWdVozUm9JRHdnTWlrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZzbUlIc2w2M3NuYlFnNjdhQTdLR3g3WldwNjR1STY0dWtMaWNnZlNrN0RRb2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3RFFvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yVWhPdWdpT3llaE91emhDRHN0cFRzc3B3ZzdKcVU3TEt0T2lEc21JSHNsNjBnSnlBcklHeHBjM1F1YkdWdVozUm9JQ3NnSitxd25DY2dLeUFvDQpiVzl5WlNBL0lDY2dLT3VObENEcnNKdnF1TEFwSnlBNklDY25LU3dnYlc5a1pXd2dQeUFuS091cXFPdU51RG9nSnlBcklHMXZaR1ZzSUNzZ0p5a25JRG9nSnljcE93MEtJQ0FnSUhSeWVTQjdEUW9nSUNBZ0lDQmpiMjV6ZENCeUlEMGdZWGRoYVhRZ1lYTnJSM0p2ZFhCektHeHBjM1FzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpVZHliM1Z3Y3l3Z1ptOXliV0YwUkdWell6b2dKM3NpWjNKdmRYQnpJam9nVzNzaWJtRnRaU0k2SUNMc21JSHNsNjBnN0oyMDY2YUVJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyaklEc2xZZ2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0o5WFgxZGZTY2dmU3dnSVNGdGIzSmxLVHNOQ2lBZ0lDQWdJR052Ym5OMElHOTFkQ0E5SUhJdWNHRnljMlZrT3cwS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3cwS0lDQWdJQ0FnYVdZZ0tDRnZkWFFwSUhKbA0KZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3RFFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU0U2NkNJN0o2RTY3T0VJT3lnbk95VmlDQW5JQ3NnYjNWMExuSmxaSFZqWlNnb2Jpd2daeWtnUFQ0Z2JpQXJJR2N1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvTENBd0tTQXJJQ2Zxc0p3Z0x5RHNtSUhzbDYwZ0p5QXJJRzkxZEM1c1pXNW5kR2dnS3lBbjZyQ2NJQ2duSUNzZ2MyVmpJQ3NnSjNNcEp5azdEUW9nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3cwS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0FuVysyVWhPdWdpT3llaE91emhGMGdKeUFySUZOMGNtbHVaeWdvYkdsemRGc3cNClhTQW1KaUJzYVhOMFd6QmRMblJsZUhSeld6QmRLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNalFwT3cwS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzTkNpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJR2R5YjNWd2N6b2diM1YwTENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0bElUcm9JanNub1RyczRRZzdMYVU3TEtjSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93MEtJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5LU2s3RFFvZ0lDQWdmUTBLSUNCOURRb2dJQzh2SU8yTW5leVhoU0RzbXBUc2hvenJzNFFnN0xhVTdMS2NJT0tBbENEdGxad2c3WXlkN0plRjdKMllJT3Exck95RXNleWFsT3lHakNqc2w2M3RsYUFyDQo2Nnk0NnJXc0tldWx2Q0R0bFp3ZzY3S0k3SmVRSU91d20reVZoQ0RzbDYzdGxhRHJzNFRyb1p3ZzY0dWs2NU9zNjRxVTY0dWtMZzBLSUNBdkx5RHNtcFRzaG96cnBid2c3WldvNnJ1WUlPdXp0T3VDdE95VnZDRHRnNERzbmJUdGk0RHNuYlFnNjdPNDY2eTRJT3VucGV1ZHZleWRoQ0Rzc0xqc29iRHRsYUFnN0lpWUlPeWVpT3VMcENqc21wVHNob3pyczRRZzZyQ2M2N09FSU95YWxPeXlyZXF6dk95ZG1DRHNzS2pzbmJRcExnMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjbVZqYjIxdFpXNWtMWEJ2Y0hWd0p5a2dldzBLSUNBZ0lHTnZibk4wSUhzZ1pXeGxiV1Z1ZEhNc0lHMXZaR1ZzTENCdGIzSmxJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93MEtJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0dWc1pXMWxiblJ6S1NBL0lHVnNaVzFsYm5SekxtWnBiSFJsY2lnb1pTa2dQVDRnWlNBbUppQlRkSEpwYm1jbw0KWlM1MFpYaDBJSHg4SUNjbktTNTBjbWx0S0NrcElEb2dXMTA3RFFvZ0lDQWdhV1lnS0d4cGMzUXViR1Z1WjNSb0lEd2dNaWtnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnRqSjNzbDRVZzdKcVU3SWFNNnJDQUlPdTJnT3loc2UyVnFldUxpT3VMcEM0bklIMHBPdzBLSUNBZ0lHTnZibk4wSUhOMFlYSjBaV1FnUFNCRVlYUmxMbTV2ZHlncE93MEtJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRqSjNzbDRVZzdMYVU3TEtjSU95YWxPeXlyVG9nN0pxVTdJYU1JQ2NnS3lCc2FYTjBMbXhsYm1kMGFDQXJJQ2Zxc0p3bklDc2dLRzF2Y21VZ1B5QW5JQ2pyalpRZzY3Q2I2cml3S1NjZ09pQW5KeWtzSUcxdlpHVnNJRDhnSnlqcnFxanJqYmc2SUNjZ0t5QnRiMlJsYkNBcklDY3BKeUE2SUNjbktUc05DaUFnSUNCMGNua2dldzBLSUNBZ0lDQWdZMjl1YzNRZ2NpQTlJR0YzWVdsMElHRnphMUJ2Y0hWd0tHeHBjM1FzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpWQnYNCmNIVndMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXV3cWUyV3BTRHRsWndnNjZ5NDdKNmxJaXdnSW1Wc1pXMWxiblJ6SWpvZ1czc2ljbTlzWlNJNklDTHNsNjN0bGFBaUxDQWlkR1Y0ZENJNklDTHJyTGpxdGF3aWZTd2dMaTR1WFgwc0lDNHVMbDE5SnlCOUxDQWhJVzF2Y21VcE93MEtJQ0FnSUNBZ1kyOXVjM1FnYzJWMGN5QTlJSEl1Y0dGeWMyVmtPdzBLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPdzBLSUNBZ0lDQWdhV1lnS0NGelpYUnpLU0I3RFFvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0RRb2dJQ0FnSUNCOURRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlkDQo3SmVGSU95RXVPMkt1Q0FuSUNzZ2MyVjBjeTVzWlc1bmRHZ2dLeUFuNnJDY0lDZ25JQ3NnYzJWaklDc2dKM01wSnlrN0RRb2dJQ0FnSUNCemRHRjBjeTV6WlhKMlpXUXJLenNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPdzBLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQW5XKzJNbmV5WGhWMGdKeUFySUZOMGNtbHVaeWdvYkdsemRGc3dYU0FtSmlCc2FYTjBXekJkTG5SbGVIUXBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlOQ2s3RFFvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3cwS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djMlYwY3l3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnlCOUtUc05DaUFnSUNCOUlHTmhkR05vSUNobEtTQjdEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5ZDdKZUZJT3lMcE8yTXFEb25MQ0JsTG0xbA0KYzNOaFoyVXBPdzBLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEdG1ManN0cHdnN0l1azdZeW9PaUFuS1NrN0RRb2dJQ0FnZlEwS0lDQjlEUW9nSUM4dklPdU1nTzJabE8yWWxTRHJyTGpxdGF3ZzdLQ2M3SjZSSU9LQWxDRHNnNEh0bWFuc25ZUWc3SVNrNjZxRjdaV1k2Nm0wSU91c3VPcTFyT3VsdkNEcnA0enJrNlRzbHJUc3BJRHJpNlFnS095MmxPeXluT3F6dkNEcXNKbnNuWUFnN0lTNDdJV1lMQ0RyaklEdG1aVHJpcFFnNjZla0lPeWFsT3l5cmV5WGtDRHRoclhzcDdqcm9ad2c3SXVrNjZhOEtRMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZZMjl0Y0c5elpTY3BJSHNOQ2lBZ0lDQmpiMjV6ZENCN0lHMWxjM05oWjJWekxDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNOQ2lBZ0lDQmpiMjV6ZENCc2FYTjBJRDBnUVhKeVlYa3UNCmFYTkJjbkpoZVNodFpYTnpZV2RsY3lrZ1B5QnRaWE56WVdkbGN5NW1hV3gwWlhJb0tHMHBJRDArSUcwZ0ppWWdVM1J5YVc1bktHMHVkR1Y0ZENCOGZDQW5KeWt1ZEhKcGJTZ3BLU0E2SUZ0ZE93MEtJQ0FnSUdsbUlDZ2hiR2x6ZEM1c1pXNW5kR2dwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW42NHlBN1ptVUlPdUN0T3lhcWV5ZHRDRHJ1WVRzbHJRZzdKNkk3SXExNjR1STY0dWtMaWNnZlNrN0RRb2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3RFFvZ0lDQWdZMjl1YzNRZ2JHRnpkRlZ6WlhJZ1BTQmJMaTR1YkdsemRGMHVjbVYyWlhKelpTZ3BMbVpwYm1Rb0tHMHBJRDArSUcwdWNtOXNaU0FoUFQwZ0oyRnpjMmx6ZEdGdWRDY3BPdzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c25wRWc2NHlBN1ptVUlPeWFsT3l5clRvbkxDQlRkSEpwYm1jb0tHeGhjM1JWYzJWeUlDWW1JR3hoYzNSVmMyVnlMblJsZUhRcElIeDhJQ2NuDQpLUzV6YkdsalpTZ3dMQ0ExTUNrdWNtVndiR0ZqWlNndlhHNHZaeXdnSnlBbktTQXJJQ2ZpZ0tZZ0tPdU1nTzJabENBbklDc2diR2x6ZEM1c1pXNW5kR2dnS3lBbjZyQ2NLU2NwT3cwS0lDQWdJSFJ5ZVNCN0RRb2dJQ0FnSUNBdkx5RHJqSUR0bVpUcXNJQWc2cmk0N0phMDdLZUE2Nm0wSU95MW5PcTN2Q0F4TXVxd25PdW5qQ0FvN1pTRTY2R3M3WlNFN1lxNElPMlByZXlqdkNEcnNLbnNwNEFwRFFvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUTI5dGNHOXpaU2hzYVhOMExuTnNhV05sS0MweE1pa3NJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlVOdmJYQnZjMlVzSUdadmNtMWhkRVJsYzJNNklDZDdJbkpsY0d4NUlqb2dJdXVNZ08yWmxDRHNuWkhyaTdVZzdaV2M2NUdRSU91c3VPeWVwU0lzSUNKemRXZG5aWE4wYVc5dWN5STZJRnQ3SW5SbGVIUWlPaUFpNjZ5NDZyV3NJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FpZlN3Z0xpNHVYWDBuSUgwcE93MEtJQ0FnSUNBZ1kyOXVjM1FnYjNWMA0KSUQwZ2NpNXdZWEp6WldRN0RRb2dJQ0FnSUNCamIyNXpkQ0J6WldNZ1BTQW9LRVJoZEdVdWJtOTNLQ2tnTFNCemRHRnlkR1ZrS1NBdklERXdNREFwTG5SdlJtbDRaV1FvTVNrN0RRb2dJQ0FnSUNCcFppQW9JVzkxZENrZ2V3MEtJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPdzBLSUNBZ0lDQWdmUTBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeWVrU0RzblpIcmk3VWdLQ2NnS3lCelpXTWdLeUFuY3l3ZzdLQ2M3SldJSUNjZ0t5QnZkWFF1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUNzZ0orcXduQ2tuS1RzTkNpQWdJQ0FnSUhOMFlYUnpMbk5sY25abFpDc3JPdzBLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRUYwSUQwZ2JtVjNJRVJoZEdVb0tTNTBiMHh2WTJGc1pWUnBiV1ZUZEhKcGJtY29KMnR2TFV0U0p5azcNCkRRb2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWdvYkdGemRGVnpaWElnSmlZZ2JHRnpkRlZ6WlhJdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJRE13S1RzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ5WlhCc2VUb2diM1YwTG5KbGNHeDVMQ0J6ZFdkblpYTjBhVzl1Y3pvZ2IzVjBMbk4xWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c25wRWc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3RFFvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc05DaUFnSUNCOURRb2dJSDBOQ2lBZ0x5OGc2N0tJDQo3SmV0SU9LQWxDRHRsWnpxdGEzc2xyUWc0b2FVSU95WWdleVd0Q0RzbnBEcmo1a2dLT3kybE95eW5PcXp2Q0Rxc0puc25ZQWc3SVM0N0lXWUlPeUNyT3lhcVNrTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzUnlZVzV6YkdGMFpTY3BJSHNOQ2lBZ0lDQmpiMjV6ZENCN0lIUmxlSFFzSUcxdlpHVnNJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93MEtJQ0FnSUdsbUlDZ2hkR1Y0ZENCOGZDQWhVM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnJzb2pzbDYzdGxhQWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc05DaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzTkNpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNA0KZENrdWMyeHBZMlVvTUN3Z05UQXBMbkpsY0d4aFkyVW9MMXh1TDJjc0lDY2dKeWtnS3lBbjRvQ21KeWs3RFFvZ0lDQWdkSEo1SUhzTkNpQWdJQ0FnSUdOdmJuTjBJSElnUFNCaGQyRnBkQ0JoYzJ0VWNtRnVjMnhoZEdVb1UzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTd2diVzlrWld3c0lIc2djR0Z5YzJVNklIQmhjbk5sVkhKaGJuTnNZWFJsTENCbWIzSnRZWFJFWlhOak9pQW5leUowY21GdWMyeGhkR1ZrSWpvZ0l1dXlpT3lYcmV1c3VDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpWkdseVpXTjBhVzl1SWpvZ0ltdHY0b2FTWlc0ZzY1aVE2NHFVSUdWdTRvYVNhMjhpZlNjZ2ZTazdEUW9nSUNBZ0lDQmpiMjV6ZENCdmRYUWdQU0J5TG5CaGNuTmxaRHNOQ2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNOQ2lBZ0lDQWdJR2xtSUNnaGIzVjBLU0I3RFFvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmwNCmN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPdXlpT3lYclNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPdzBLSUNBZ0lDQWdmUTBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzbVlUcm80d2dLQ2NnS3lCelpXTWdLeUFuY3l3Z0p5QXJJQ2h2ZFhRdVpHbHlaV04wYVc5dUlIeDhJQ2MvSnlrZ0t5QW5LU2NwT3cwS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdEUW9nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRE13S1RzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUIwY21GdWMyeGhkR1ZrDQpPaUJ2ZFhRdWRISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVPaUJ2ZFhRdVpHbHlaV04wYVc5dUxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPdzBLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnNvanNsNjBnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJT3V5aU95WHJTRHNpNlR0aktnNklDY3BLVHNOQ2lBZ0lDQjlEUW9nSUgwTkNpQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNRFFzSUhzZ1pYSnliM0k2SUNkT2IzUWdabTkxYm1RbklIMHBPdzBLZlNrN0RRb05DaTh2SU95ZHRPdXZ1Q0RyaTZUcnBxenFzSUFnNjVhZ0lPeWVpT3VLbE91TnNDRHJtSkFnN0x5YzZyaXc2ckNBSU91VHBPeVd0T3lZcE91cHRDanNvSnpzaXFUc3NwZ2c3SjZRNjQrWklPeThuT3E0c0NEc3BKSHJzN1VnNjVPeA0KS1NEc29iRHNtcW50bm9nZzdLS0Y2Nk9NSU9LQWxDRHJqNHpyalpnZzY0dWs2NmFzNjRxVUlPcTN1T3VNZ091aG5DRHNuS0RzcDRBTkNuTmxjblpsY2k1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V3MEtJQ0JwWmlBb1pTQW1KaUJsTG1OdlpHVWdQVDA5SUNkRlFVUkVVa2xPVlZORkp5a2dldzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbmJUcnI3Z2c3THljN0tDNElPeWVpT3lXdE95YWxDanRqNnp0aXJnZ0p5QXJJRkJQVWxRZ0t5QW5JT3lDck95YXFTRHNwSkVwSU9LQWxDRHNuYlFnN0oyNDdJcWs3WVMwN0lxazY0cVVJT3lpaGV1ampPMlZxZXVMaU91THBDNG5LVHNOQ2lBZ0lDQndjbTlqWlhOekxtVjRhWFFvTUNrN0RRb2dJSDBOQ2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFbk91eWhDRHNtS1RycFpnNkp5d2daU0FtSmlCbExtMWxjM05oWjJVcE93MEtJQ0J3Y205alpYTnpMbVY0YVhRb01TazdEUXA5S1RzTkNpOHZJT3lXdE91V3BDRHFzcjNyb1p6cm9ad2cNCjdLTzk2NU9nS095THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBc0lFTjBjbXdyUXl3Z0wzTm9kWFJrYjNkdUxDRHNtS1RycFpncElHTnNZWFZrWlNEc25wRHNpNTNzbllRZzY0S282cml3N0tlQUlPeVZpdXVLbE91THBBMEtjSEp2WTJWemN5NXZiaWduWlhocGRDY3NJQ2dwSUQwK0lIc2dhMmxzYkZCeWIyTW9LVHNnYTJsc2JFeHZaMmx1VUhKdll5Z3BPeUI5S1RzTkNuQnliMk5sYzNNdWIyNG9KMU5KUjBsT1ZDY3NJQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1NrN0RRcHdjbTlqWlhOekxtOXVLQ2RUU1VkVVJWSk5KeXdnS0NrZ1BUNGdjSEp2WTJWemN5NWxlR2wwS0RBcEtUc05DZzBLYzJWeWRtVnlMbXhwYzNSbGJpaFFUMUpVTENBbk1USTNMakF1TUM0eEp5d2dLQ2tnUFQ0Z2V3MEtJQ0JqYjI1emIyeGxMbXh2WnlnbjRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBDQo0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUp5azdEUW9nSUdOdmJuTnZiR1V1Ykc5bktDY2c3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFySUZCUFVsUXBPdzBLSUNCamIyNXpiMnhsTG14dlp5Z25JT3VxcU91TnVEb2dKeUFySUVOTVFWVkVSVjlOVDBSRlRDQXJJQ2Nnd3JjZzdKaUk3SXVjSUNjZ0t5QkZXRUZOVUV4RlV5NXNaVzVuZEdnZ0t5QW42ckcwSU95ZXBleXdxU2NwT3cwS0lDQmpiMjV6YjJ4bExteHZaeWduSU95ZHRDRHNzTDNzbllRZzdMeWM2NUdVSU91UG1leVZpQ0R0bEx6cXQ3anJwNGdnN1pTTTY1K3M2cmU0N0oyNDdKMjBJTzJCdE91aG5PdVRuT3VobkNEc3RwVHNzcHp0bGFucmk0anJpNlF1SnlrN0RRb2dJR052Ym5OdmJHVXViRzluS0NmaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaQ0KbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBbktUc05DaUFnWTJobFkydERiR0YxWkdWQmRtRnBiR0ZpYkdVb0tUc2dMeThnUTJ4aGRXUmxJRU52WkdVZzdJS3M3SnFwSU9xd2dPdUtwU0RzbDZ6cnRvQWc3S0NRNnJLQUlDanRsSXpybjZ6cXQ3anNuYmdnN0pXSTY0SzA3SnFwS1EwS0lDQXZMeURycjdqcnBxd2c3SXVjNjQrWklDc2c3S2VBN0l1YzY2eTRJT3lqdk95ZWhTRGlnSlFnN0xLcklPeTJsT3l5bk91MmdPMkVzQ0RydWFEcnBiVHFzb3dOQ2lBZ1lYTnJRMnhoZFdSbEtDZnNtNHpyc0kzc2w0VTZJQ0xzb0lEc25xVWc2NUNZN0plSTdJcTE2NHVJNjR1a0lpY3BMblJvWlc0b0RRb2dJQ0FnS0NrZ1BUNGdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95YmpPdXdqZXlYaFNEc21ZVHJvNHdnNG9DVUlPeTINCmxPeXluQ0RzcElEcnVZUWc2NEdkTGljcExBMEtJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeUxwTzJNcUNBbzdMS3JJT3lhbE95eXJTRHJsWXdnN0o2czdJdWM2NCtFS1RvbkxDQmxMbTFsYzNOaFoyVXBEUW9nSUNrN0RRcDlLVHNOQ2k4dklFbFFkallnNjZPbzdaU0U2N0N4S0RvNk1TbnNsNURyajRRZzdaV282cnVZSU91VG8rdUtsT3VMcENEaWdKUWdiV0ZqVDFNZzY1T3g3SmVRN0lTY0lDZHNiMk5oYkdodmMzUW42ckNBSURvNk1ldWhuQ0RycUx6c29JQWc3WlcwN0lTZDY1Q1k2NHFVNjQyd0RRb3ZMeUR0bEx6cXQ3anJwNGdvUld4bFkzUnliMjRwSUdabGRHTm82NHFVSUdOMWNtenFzN3dnNjR1czY2YXNJRWxRZGpUcm9ad2c3SjZRNjQrWklPMlB0T3V3c2UyVm1PeW5nQ0RzbFlyc2xZUXNJRWxRZGpUcnA0d2c2NU9qNjQyWUlPdUxwT3Vtck95WGtDRHNsN0Rxc3JEc25iUWc2ckd3NjdhQTY0KzhEUW92THlEc3RwVHNzcHpDdCsyWHJPeUtwT3l5DQp0TzJCck9xd2dDRHNvYkRzbXFudG5vZ2c3SXVrN1l5bzdaYUk2NHVrS095THBPeTRvU0F5TURJMkxUQTNLUzRnNnJDWjdKMkFJT3lhbE95eXJTRHRsYmpyazZUcm42enJwYndnU1ZCMk5pRHJvNmp0bElUcnNMSHNsNURyajRRZzdKYTU2NHFVNjR1a0xnMEtZMjl1YzNRZ2MyVnlkbVZ5TmlBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtITmxjblpsY2k1c2FYTjBaVzVsY25Nb0ozSmxjWFZsYzNRbktWc3dYU2s3RFFwelpYSjJaWEkyTG05dUtDZGxjbkp2Y2ljc0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGdTVkIyTmlnNk9qRXBJT3Vtck95S3FDRHNnNTNybnJVZzRvQ1VJRWxRZGpUcnA0d2c3SUtzN0pxcE9pY3NJR1VnSmlZZ1pTNXRaWE56WVdkbEtTazdEUXB6WlhKMlpYSTJMbXhwYzNSbGJpaFFUMUpVTENBbk9qb3hKeWs3RFFvPQ0KOjpFWEFNUExFUzo6DQpJeURyckxqcXRhd2c3TGFVN0xLY0lPeVlpT3lMbkFvS0l1dXN1T3ExckNEc3RwVHNzcHpyc0p2cXVMQWk2ckNBSU95Q3JPeWFxZTJWbU91S2xDRHNtSWpzaTV3ZzY2cW83SjJNN0o2RjY0dUk2NHVrTGlBcUt1eWR0Q0R0akl6c25ienNuWVFnN0lpWTdLQ1Y3WldjSU91U3BDRHRoTERycjdqcmhKRHNsNURzaEp3Z1lHNXdiU0J5ZFc0Z1luVnBiR1JnNjZXOElPeUxwTzJXaWUyVm1PcXpvQ3dnUm1sbmJXSHNsNURzaEp3ZzdaU002NStzNnJlNDdKMjQ3SjJFSU91THBPeUxuQ0RzaTZUdGxvbnRsWmpycWJRZzY3Q1k3SmlCNjVDcDY0dUk2NHVrTGlvcUNnb2pJeURzbnBIc2hMRWc2N0NwNjdLVkNnb3RJT3lZaU95TG5DRHRsWmpyZ3BqcmlwUWdLaXBnSXlNaklPeWJrT3V6dUdBcUtpRHRsWndnN0tTRTZyTzhMQ0RxdDdnZzdKV0U2NTZZSUNvcVlDMGc3TGFVN0xLYzdKV0lZQ29xSU95WHJPdWZyQ0Rxc0p6cm9ad2c3SjIwNjZTRTdLZVI2NHVJNjR1a0xnb3RJT3kybE95eW5PeVZpQ0RzbFlqc2w1RHNoSndnS2lycw0KcElUc25ZUWc2N0NVNnI2NDZyT2dJT3lMdHV5Y3ZPdXB0Q0JnSUM4Z1lDQW83SldlNjVLa0lPcXp0ZXV3c1NEdGo2enRsYWdnN0lxczY1Nlk3SXVjS1NvcUlPdWhuQ0R0a1p6c2k1enRsWmpzaExqc21wUXVJTzJVak91ZnJPcTN1T3lkdU95WGtPeUVuQ0Rya1pBZzdLU0U2NkdjSU91enRPeVhyT3lua2V1TGlPdUxwQzRLTFNEc2dxenNtcW5zbnBEcXNJQWc3SjZGNjZDbDdaV2NJT3VzdU9xMXJPcXdnQ0JnN0p1UTY3TzRZT3F6dkNBbzZyTzE2N0N4d3JmcnJManNucVhydG9EdG1MZ2c2NnkwN0l1YzdaV1k2ck9nS1NEcXNKbnFzYkRyZ3Bnc0lPeUVuT3VobkNEdGo2enRsYWp0bFpqcnFiUWc2cmU0SU95MmxPeXluT3lWaU91VHBPeWRoQ0RyczdUc2w2enNwSTNyaTRqcmk2UXVDaTBnNjZlazdMbXQ3WldnSU91VmpDQXFLdXVuaU95S3BPMkN1ZXVRbkNEc25iVHJwb1FvN1ptTlhDcnJqNWtwTENEc2lLdnNucEFvN0tDRTdabVU2N0tJN1ppNHdyY2k3Sm00SURMcnFvVWlJT3VUc1NucmlwUWc2NnkwN0l1Y0tpcnQNCmxhbnJpNGpyaTZRZzRvQ1VJT3lkdE91bWhNSzM3SWlZNjUrSndyZnJzb2p0bUxqcnA0d2c2NHVrNjZXNElPdXN1T3Exck91UGhDRHFzSm5zbllBZzdKaUk3SXVjNjZHY0lPeWVvZTJZZ095YWxDNGc2NHVvTENEc3RwVHNzcHpzbFlqc2w1QWc3S0NCN0phMDY1R1VJT3lkdE91bWhNSzM3SWlyN0o2UTY0cVVJT3EzdU91TWdPdWhuQ0RyZ3Bqc21LVHJpNGdnN0l1azdLQ2NJT3F3a3V5WGtDRHJwNTdxc293ZzZyT2c3TE9RSU95VHNPeUV1T3lhbEM0S0xTRHNvSnpycXFrb1lDTWpZQ25xczd3Z1lDTWpJMkFzSUdBdFlDRHF1TER0bUxqcmlwUWc3WmlWN0l1ZDdKMjA2NHVJSU91d2xPcSt1T3luZ0NEcnA0anNoTGpzbXBRdUNnb2pJeURzaXFUdGc0RHNuYndnN0p1UTdMbVpJQ2pzc0xqcXM2QWc0b0NVSU95ZWtPeUV1TzJWbkNEcmdyVHNtcW5zbllBZ2RYZ3RkM0pwZEdsdVp5NXRaQ0Rxc0lEc25iVHJrNXdwQ2dvdElPMlZ0T3lhbE95eXRDd2c2N2FBNjVPYzY1K3M3SnEwSU95aWhlcXlzQ2hnZnV5ZWlPeVd0T3lhDQpsR0FnWUg3cmo3enNtcFJnSUdCKzdKZUc3SmEwN0pxVVlDQmdmdTJWdENEc283enNoTGpzbXBSZ0tRb3RJRExyaTZnZzZyV3M3S0d3T2lBcUt1eXlxeURzcElROTdJT0I3Wm1wSU95RXBPdXFoU0RpaHBJZzY1R1k3S2U0SU95a2hEM3JpNlRzbll3ZzdaYUo2NCtaS2lvbzZyS3c3S0NWN0oyQUlHQis3WldnNnJtTTdKcVVQMkFzSU8yV2lldVBtU0RzbktEcmo0VHJpcFFnWUg3dGxiUWc3S084N0lTNDdKcVVZQ2tLTFNEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0tPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ2tzSU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBbzdKZUc3SmEwN0pxVTRvYVNmdTJWbU91cHRDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDa0tMU0RzdXBEc283enNscnp0bFp3ZzZySzk3SmEwS0g3c2k1enFzcURzbHJUc21wUS80b2FTZnUyVm9PcTVqT3lhbEQ4cExDRHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNDanNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2M0b2FTN0o2VQ0KN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrS0xTRHFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NBbzdLQ0U3SWFoNG9hUzY3TzA2NEswNjR1a0tTd2c2N2FBN0tDVklPeURnZTJacWV1UGhDRHJsTEhybExIdGxaanNwNEFnN0pXSzZyS01LQ0xzc0w3cXVMQWc3SXVrN1l5b0l1S2RqQ0FpN0xDKzdKMkVJT3lJbUNEc2w0YnNsclRzbXBRaTRweUZLUW9LSXlNZzdMYVU3TEtjSU95WWlPeUxuQW9LSXlNaklPeW5oTzJXaWUyVm1PdU5tQ0RzbnBIc2w0WHNuYlFnN0o2STdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3S2VFN1phSklPeWtrZXlkdUNEcmdyVHNsNjNzbmJRZzdKNkk3SmEwN0pxVUxpQXZJT3lkdE95V3RPeUVuQ0RzcDRUdGxvbnRsYURxdVl6c21wUS9DZ29qSXlNZzZyTzE3SnlnSU95YWxPeXlyZXlkaENEc3Q2anNob3p0bFpqcnFiUWc3SnFVN0xLdElPdUN0T3lYcmV5ZHRDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTNxT3lHak8yVm1PeUwNCm5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc3Q2anNob3p0bGFBZzZySzk3SnF3SU95YWxPeXlyU0RyZ3JUc2w2M3JqNFFnN0lLdDdLQ2M2NCs4N0pxVUxpQXZJT3F6dGV5Y29DRHNtcFRzc3Ezc25ZUWc3TGVvN0lhTTdaV2c2cm1NN0pxVVB3b0tJeU1qSU9xNHNPcTRzT3VsdkNEc3NMN3NwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WldZN0lTNDdKcVVMZ290SU9xNHNPcTRzT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlXdE95YWxDNGdMeUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXWTZyaXdJT3lnaE95WGtPdUtsQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxBb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0tlQTZyaUlJT3V5DQpoT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwSU95anZPeUV1T3lhbEM0Z0x5RHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2lNakl5RHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4S0xTRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhLTFNEc2k2RHFzNkFnN0oyMDdKeWc2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0o2VQ0KN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDaTBnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxnb0tJeU1qSU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c3Sm00SURMcnFvWHNsNURxc293ZzZyYU03WldjSU95Q3JleWduQ0RzbFl6cnByenRocUhzbllRZzdLQ0U3SWFoN1pXZzZybU03SnFVUHdvdElPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdE91Z3BPcXpvQ0R0bGJUc21wUXVJQzhnN1ptTkt1dVBtU2d3TVRBdE1USXpOQzAxTmpjNEtTRHJpNWdnN0ptNElETHJxb1hzbDVEcXNvd2c2N08wNjRLODZybU03SnFVUHdvdElPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnNjR1WUlPeVp1Q0F5NjZxRjdKZVE2cktNSU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN2T3E1ak95YWxEOEtMU0RxdG96dGxad2cNCjdJS3Q3S0NjSU95VmpPdW12TzJHb2V5ZGhDRHRtWTBxNjQrWktEQXhNQzB4TWpNMExUVTJOemdwSU91TG1DRHNtYmdnTXV1cWhleVhrT3F5akNEcnM3VHJncnpxdVl6c21wUS9DZ29qSXlNaklPMlpsZXlkdU1LMzZyS3c3S0NWSU8yTW5leVhoUW9LSXlNaklPeWdsZXVua0NEc2dxM3NvSnp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95Q3JleWduT3VRbkNEcmpiRHNuYlR0aExEcmlwUWc2N08xNnJXczdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEcmtKanJqNHpycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc29KWHJwNUFnN0lLdDdLQ2M3WldnNnJtTTdKcVVQd29LSXlNaklPdXpnT3F5dmV5Q3JPMlZyZXlkdENEc29JRHNucVhya0pqc3A0QWc3SldLN0pXWTdJcTE2NHVJNjR1a0xpRHJncGpxc0lEc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKV0U3S2VCSU95Z2dPeWVwZTJWbU95bmdDRHNsWXJzbllBZzY0SzA3SnFwN0oyMElPeWVpT3lXDQp0T3lhbEM0Z0x5RHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4S0NpTWpJeURyb1p6cXQ3anNsWVRzbTRNZzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3Vobk9xM3VPeVZoT3liZysyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbGJIc25ZUWc3S0tGNjZPTTdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3lWc2V5ZGhDRHNvb1hybzR6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nN1pXY0lPdXlpQ0RyczREcXNyM3RsWmpycWJRZzY0dWs3SXVjSU91emdPcXl2ZTJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzY0dWs3SXVjSU91d2xPcS9nQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6aE95R2plMlZvT3E1ak95YWxEOEtDaU1qSXlEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpya0tucmk0anJpNlF1SU95MGlPcTRzTzJabE8yVg0KbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpyajd6c21wUXVJQzhnN0xTSTZyaXc3Wm1VN1pXZzZybU03SnFVUHdvS0l5TWpJeURzbDVEcm42ekN0K3lMcE8yTXFBb0tJeU1qSU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU91RXBPMkt1T3liak8yQnJPeVhrQ0RzbDdEcXNyRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzbDdEcXNyQWc3SU9CN1lPYzY2VzhJTzJabGV5ZHVPMlZtT3F6b0NEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPdXduT3lEbmUyV2lPeUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNuYnpzaTV6c29JSHMNCm5iZ2c3SmlrNjZXWTZyQ0FJT3lEbmVxeXZPeVd0T3lhbEM0Z0x5RHNucURzaTV3ZzdadUVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZoT3lkdE91VWxDRHJtSkRyaXBRZzY3bUU2N0NBNjdLSTdaaTQ2ckNBSU95ZHZPeTVtTzJWbU95bmdDRHNsWXJzaXJYcmk0anJpNlF1Q2kwZzdKV0U3SjIwNjVTVUlPdVlrT3VLbENEcnVZVHJzSURyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwM3Jzb2p0bUxqcXNJQWc3SjI4N0xtWTdaV1k3S2VBSU95Vml1eUt0ZXVMaU91THBDNEtMU0RzbmJqc3BwM3Jzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeTBpT3F6dk91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0oyNDdLYWQ2N0tJDQo3Wmk0NjZXOElPeWVyT3V3bk95R29lMlZtT3lMcmV5TG5PeVlwQzRLTFNEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95bmdPdUNyT3lXdE95YWxDNGdMeURzbmJqc3BwM3Jzb2p0bUxqcnBid2c2NHVrN0l1Y0lPdXdtK3lWaENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzbHJUc21wUXVJQzhnNjR1azY2VzRJT3F5Z095RGlleVd0T3VobkNEcmk2VHNpNXdnN0xDKzdKV0U2N08wN0lTNDdKcVVMZ29LSXlNaklPeWdsZXV6dE91bHZDRHJ0b2pybjZ6c21LVHNwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNvSlhyczdUcnBid2c2N2FJNjUrczdKaXNJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHRqSXpzbmJ3Zw0KN0plRjY2R2M2NU9jN0plUUlPeUxwTzJNcU8yV2lPeUt0ZXVMaU91THBDNEtMU0R0akl6c25ienNuWVFnN0ppczY2YXM3S2VBSU91cXUrMldpT3lXdE95YWxDNGdMeURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3S0NRNnJLQUlPeWtrZXllaGV1TGlPdUxwQzRnN0oyMDdKcXA3SmVRSU91MmlPMk91T3lkaENEcms1enJvS1FnN0tPRTdJYWg3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEc2hKenJ1WVRzaXFUcnBid2c3S0NRNnJLQTdaV1k2ck9nSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSkRxc29Ec25iUWc2NEdkNjRLWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bFlUc2lKZ2c3SjZGNjZDbElPMlZyZXVxcWV5ZWhldUxpT3VMcEM0S0xTRHF2SzBnN0o2RjY2Q2w3WlcwN0pXOElPMlZtT3VLbENEdGxhM3JxcW5zbmJUc2w1RHNtcFF1Q2dvakl5TWpJT3Eyak8yVm5NSzM3SVNrN0tDVkNnb2oNCkl5TWc3TG0wNjZtVTY1MjhJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0lxMTY0dUk2NHVrTGlEc2hLVHNvSlhzbDVEc2hKd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc3ViVHJxWlRybmJ3ZzZyYU03WldjN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3TG0wNjZtVTY1MjhJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWak91bXZDRHF0b3p0bFp6c25iUWc2ckd3NjdhQTY1Q1k3SmEwSU95VmpPdW12T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEc2xZenJwcndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU91cHRDRHNob3pzaTUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdJU2s3S0NWN0plUTdJU2NJT3lWak91bXZPeWRoQ0Rzdkp3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Y2hPeTVtQ0Rzb0pYcnM3UWc3SjIwN0pxcDdKZVFJT3VQDQptZXlkbU8yVm1PeW5nQ0RzbFlyc2xZUWc3SjI4NjdhQUlPcTRzT3VLcGV5ZHRDRHNvSnp0bFp6cmtLbnJpNGpyaTZRdUNpMGc3SnlFN0xtWUlPeWdsZXV6dE91bHZDRHRsNGpzbXFudGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3SnlFN0xtWUlPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHNtWVRybzR6Q3QreW5oTzJXaVFvS0l5TWpJT3lnZ095ZXBldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNvSURzbnFYdGxvanNsclRzbXBRdUNnb2pJeU1nNjdPQTZySzk3SUtzN1pXdDdKMjBJT3lnZ2V5YXFldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzNERxc3IwZzY0SzA3SnFwN0oyRUlPeWdnZXlhcWUyV2lPeVd0T3lhbEM0S0NpTWpJeURzb0lUc2hxSHNuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dE91RGlPeVd0T3lhbEM0S0NpTWpJeURyazdIcg0Kb1ozc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdVRzZXVobmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWc3SUt0N0tDYzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeUNyZXlnbk8yV2lPeVd0T3lhbEM0S0NpTWpJeUR0Z2JUcnByM3JzN1RyazV6c2w1QWc2N08xN0lLczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0ZXlDck8yV2lPeVd0T3lhbEM0S0NpTWpJeURzbXBUc3NxM3NuWVFnN0xLWTY2YXNJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKcVU3TEt0N0oyRUlPeXltT3Vtck8yVm1PcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPeVZpT3VDdE1LMzdKeWc2NCtFQ2dvakl5TWc3SU9JNjZHYzdKcTBJT3V5aE95Z2hPeWR0Q0RzdHB6c2k1enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlPeVhoZXVOc095ZHRPMksNCnVDRHRtNFFnN0oyMDdKcXBJT3F3Z091S3BlMlZxZXVMaU91THBDNEtMU0RzZzRnZzY3S0U3S0NFN0oyMElPdUNtT3labE95V3RPeWFsQzRnTHlEc2w0WHJqYkRzbmJUdGlyanRsWmpycWJRZzdJT0lJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3SjIwN0pxcDdKMkVJT3ljaE8yVnRDRHNsYjNxdElBZzY0K1o3SjJZNnJDQUlPMlZoT3lhbE8yVnFldUxpT3VMcEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNpNXpzbnBIdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbnFYc2k1enFzSVFnNjYrNDdJS3M3SnFwN0p5ODY2R2NJT3lla091UG1TRHJvWnpxdDdqc2xZVHNtNE1nNjVDWTdKZUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPeVlwT3VlcSt1UG1leVZpQ0RzZ3F6c21xbnRsWmpzcDRBZzdKV0s3SldFSU91aG5PcTN1T3lWDQpoT3liZyt1UWtPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1RzbFlqc25ZUWc3SnlFN1pXMElPdTVoT3V3Z091eWlPMll1T3VsdkNEcnM0RHFzcjN0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEc2xZanNvSVR0bFp3ZzdJS3M3SnFwN0oyRUlPeWNoTzJWdENEcnVZVHJzSURyc29qdG1ManJwYndnNjdDVTZyK1VJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc2N08wN0pXSUlPeUVuT3U1aE95S3BBb0tJeU1qSU9xeXZldTVoT3VsdkNEcXNKenNpNXp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzZySzk2N21FNjZXOElPeUxuT3lla2UyVm9PcTVqT3lhbEQ4S0NpTWpJeURxc3IzcnVZVHJwYndnN1pXMDdLQ2M3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU9xeXZldTVoT3VsdkNEdGxiVHNvSnp0bGFEcXVZenNtcFEvQ2dvakl5TWc2cml3NnJpdzZyQ0FJT3lZcE8yVWhPdWR2T3lkdUNEc2c0SHRnNXpzbm9Ycg0KaTRqcmk2UXVJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbllRZzdabVY3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3E0c09xNHNPcXdnQ0RyaEtUdGlyanNtNHp0Z2F6c2w1QWc3SmV3NnJLdzY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJpdzZyaXc3SjJZSU95WHNPcXlzQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbUlIc2c0SHNuWVFnNjdhSTY1K3M3SmlrNjRxVUlPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0ppQjdJT0I3SjJFSU91MmlPdWZyT3lZcE9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3kzcU95R2pPMlZtT3lMcENEcXNyM3NtckFnN0l1ZzdMS3Q3WldZN0l1Z0lPdUMNCnRPeWFxZXlkZ0NEc29JRHNucVhya0pqc3A0QWc3SldLN0lxMTY0dUk2NHVrTGdvdElPeTNxT3lHak8yVm1PdXB0Q0RzaTZEc3NxM3RsWndnNjRLMDdKcXA3SjIwSU95Z2dPeWVwZXVRbU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9DaTBnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9JQzhnN0xlbzdJYU03WldZNjZtMElPeWVoZXVncGUyVm5DRHJnclRzbXFuc25iUWc3SUtzNjUyODdLQzQ3SnFVTGdvS0l5TWpJeURxc0lEc25iVHJrNXdnN0ppSTdJdWNJQ2gxZUMxM2NtbDBhVzVuTG0xazdKZVE3SVNjSU95WXJ1cTVnQ0RpZ0pRZzZyZWM3TG1aN0p5ODY2R2NJT3lla091UG1lMlpsQ0RycXJzZzdaV1k2NHFVSU91c3VPeWVwU0RzbnF6cXRhenNoTEVnN0lLczY2R0FLUW9LSXlNaklPeWVrT3VQbWV5d3FPdWx2Q0Rxc0lEc3A0RHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB3b3RJT3lla091UG1leXdxT3F3DQpnQ0Rzbm9qcmdwanNtcFEvQ2dvakl5TWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdWx2Q0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTTY0cVVJT3lXdk91bmlPeWR1T3F3Z095YWxEOEtDaU1qSXlEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvY2c2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1Q2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUhJT3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsWmpzaTV6cXNxRHNsclRzbXBRL0NpMGc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOEtDaU1qSXlEc2k1enNucEh0bFpqc2k1enJpcFFnNjdhRTdKZVE2cktNSURVc01EQXc3SnVRN0oyRUlPdVRuT3VncE95YWxDNEtMU0RzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEcw0KbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUxnb3RJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFF1Q2dvakl5TWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVMZ290SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQzRLQ2lNakl5RHF1SWpzbmJ6cXVZenNwNEFnNjYrNDY0S3BJT3lMbkNEc2w3RHNzclFnN0xLWTY2YXM2NUNwNjR1STY0dWtMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUNxZXUyZ08yVm1PeUxuT3E0c0NEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUF2SU8yYmhPdTJpT3F5c095Z25DRHF1SWpzbGFIc25ZUWc2NEswN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lna09xeWdDRHF1TERxc0lUc2w1RHJpcFFnN0lTYzY3bUUNCjdJcWtJT3lkdE95YXFleWR0Q0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95TG9PdTJoT3ltblNEdG1aWHNuYmdnN0tDRTdKZVE2NHFVSU95R29lcTRpQ0Ryc0k4ZzZyS3c3S0NjNnJDQUlPdTJpT3F3Z08yVnFldUxpT3VMcEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU91emdPcXl2U0RzaTV3ZzdMcVE3SXVjNjdDeElPeWVyT3luZ09xNGlleWRnQ0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtDaU1qSXlEc2c0SHJpN1FnN1pLSTdLZUlJTzJXcGV5RGdleWRoQ0RzDQpuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkdENEcmhibnNuWXpya0tucmk0anJpNlF1Q2kwZzY0MlVJT3lpaSt5ZGdDRHNnNEhyaTdUc25ZUWc3SnlFN1pXMElPMkd0ZTJabENEcmdyVHNtcW5zbllBZzY0VzU3SjJNNjQrODdKcVVMZ29LSXlNaklPcXpvT3F3bmV1TG1PeWRtQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkZ0NEcXVMRHJvWjBnNnJTQTY2YXM2NUNwNjR1STY0dWtMZ290SU95ZHRPeWduT3UyZ08yRXNDRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWR0Q0RxdUxEcm9aM3JqN3pzbXBRdUNnb2pJeU1nN0xLdDdJYU02NFdFN0oyQUlPeUVuT3U1aE95S3BDRHFzSURzbm9Yc25iUWc2N2FJNnJDQTdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YQ0KbEM0S0NpTWpJeU1nNnJPRTdLQ1Z3cmZzbm9Ycm9LVUtDaU1qSXlEc2xZVHNuYlRybEpRZzY1aVE2NHFVSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWR0T3lEZ1NEc25wanJxcnNnN0o2RjY2Q2w3WldZN0plc0lPcXpoT3lnbGV5ZHRDRHNucURxdUlnZzdMS1k2NmFzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWVtT3VxdXlEc25vWHJvS1h0bGJUc2hKd2c2ck9FN0tDVjdKMjBJT3llb09xeXZPeVd0T3lhbEM0Z0x5RHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzdKNnM3SVNrN0tDVjdaV1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25iVHJyN2dnN0lLczdKcXBJT3lra2V5ZHVDRHNsWVRzbmJUcmxKVHNub1hyaTRqcmk2UXVDaTBnN0oyMDY2KzRJT3lUc09xem9DRHNub2pyaXBRZzdKV0U3SjIwNjVTVTdKaUk3SnFVTGlBdklPdUxwT3VsdUNEc2xZVHNuYlRybEpUcnBid2c3SjZGNjZDbDdaVzANCklPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2dxenNtcW50bGFBZzdJaVlJT3lYaHV1S2xDRHJ1WVRyc0lEcnNvanRtTGpzbm9Ycmk0anJpNlF1SU95WWdldXN1Q3dnN0lpcjdKNlFMQ0R0aXJuc2lKanJyTGpzbnBEcnBid2c3WStzN1pXbzdaV1k3SmVzSURqc25wQWc3SjIwN0lPQklPeWVoZXVncGUyVm1PeUxyZXlMbk95WXBDNEtMU0RzbUlIcnJMZ3NJT3lJcSt5ZWtDd2c3WXE1N0lpWTY2eTQ3SjZRNjZXOElPMlByTzJWcU8yVnRDQTQ3SjZRSU95ZHRPeURnU0Rzbm9Ycm9LWHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3llaGV1Z3BTRHFzSURyaXFYdGxad2c2cmlBN0o2UUlPeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnN0o2RjY2Q2w3WldnSU95SW1DRHNub2pyaXBRZzZyaUE3SjZRSU95SW1PdWx2Q0RyaEpqc2w0anNsclRzbXBRdUlDOGc2NEswN0pxcDdKMkVJT3loc09xNGlDRHNwSVRzbDZ3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEdGpJenNuYnpDdCtxeXNPeWduTUszDQo2cml3N1lPQUNnb2pJeU1nN1l5TTdKMjhJT3lhcWV1ZmlleWR0Q0RzdElqcXM3enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlERXdUVUlnN0oyMDdaV1k3SjJZSU8yTWpPeWR2T3VuakNEc2w0WHJvWnpyazV3ZzZyQ0E2NHFsN1pXcDY0dUk2NHVrTGdvdElERXdUVUlnN0oyMDdaV1lJTzJNak95ZHZPdW5qQ0RzbUt6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHRqSXpzbmJ3ZzdKcXA2NStKN0oyRUlPMlpsZXlkdU8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0dWs3SnEwNjZHYzY1T2M2ckNBSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyaTZUc21yVHJvWnpyazV6cnBid2c2NmVJN0xPazdKYTA3SnFVTGdvS0l5TWpJT3F5c095Z25PeVhrQ0RzaTZUdGpLanRsWmpzbUlEc2lyWHJpNGpyaTZRdUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEcXNyRHNvSnp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPcXlzT3lnbkNEcw0KaUpqcmk2anNuWVFnN1ptVjdKMjQ3WldZNnJPZ0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WldZN0plc0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xenRlcXdoT3lkaENEdG1aWHJzN1R0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BDRHNwSURydVlRZzdLU1I3SjZGNjR1STY0dWtMZ290SU95a2dPdTVoTzJWbU9xem9DRHNub2pyaXBRZzZyaXc2NHFsN0oyMDdKZVE3SnFVTGlBdklPeWhzT3E0aU91bmpDRHF1TERyaTZUcm9LUWc3S084N0lTNDdKcVVMZ29LSXlNaklPdVRzZXVoblNEcXNJRHJpcVh0bFp3ZzdMV2M2NHlBSU9xd25PeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHMNCmlyWHJpNGpyaTZRdUNpMGc2NDJVSU91VHNldWhuZTJWbU91Z3BPdXB0Q0RxdUxEc29iUWc3Wld0NjZxcDdKMkVJT3lDcmV5Z25PMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3kybE9xd2dDa0tDaU1qSXlEc3RwenJqNWtnN0pxVTdMS3Q3SjIwSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3TGFjNjQrWklPeWFsT3l5cmV5ZGhDRHNvSkhzaUpqdGxvanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cks5NjdtRUlPeURnZTJEbk91bHZDRHRtWlhzbmJqdGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU9xeXZldTVoQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnDQo3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPeWdoTzJabU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPdXdsT3EvZ09xNWpPeWFsRDhLQ2lNakl5RHJzS25yckxnZzdKaUk3Slc5N0oyMElPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnNLbnJyTGdnN0ppSTdKVzk3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEcnVZVHJzSURyc29qdG1MZ2dOZTJhakNEc21LVHJwWmpyb1p3ZzZyT0U3S0NWN0oyMElPeWVvT3E0aUNEc3NwanJwcXpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJRFh0bW93ZzdKNlk2NnE3SU95ZWhldWdwZTJWdE95RW5DRHFzNFRzb0pYc25iUWc3SjZnNnJLODdKYTA3SnFVTGlBdklPdTVoT3V3Z091eWlPMll1T3VsdkNEc25xenNoS1Rzb0pYdGxaanJxYlFnNjR1azdJdWNJT3lkdE95YQ0KcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3SUNqc2w0YnNsclRzbXBRZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUXBDZ29qSXlNZzY3TzQ3SjI0SU95ZHVPeW1uZXlkaENEdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0Ryczdqc25iZ2c3SjI0N0thZDdKMkVJTzJWbU91cHRDRHJxcWpyazZBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95ZHRPdXBsT3lkdkNEc25ianNwcDBnN0tDRTdKZVE2NHFVSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lkdE91cGxPeWR2Q0RzbmJqc3BwM3NuWVFnNjZlSTdMbVk2Nm0wSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3kvb08yUHNPeWRnQ0Ryb1p6cXQ3anMNCm5iZ2c3WnVFN0plUTY2ZU1JT3lDck95YXFTRHFzSURyaXFYdGxhbnJpNGpyaTZRdUNpMGc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeS9vTzJQc095ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnI3anNoTEhyaFlUc25wRHJpcFFnNjdPMDdaaTQ3SjZRSU91UG1leWRtQ0RzbDRic25iUWc2ckt3N0tDYzdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnNjdPMDdaaTQ3SjZRNnJDQUlPdVBtZXlkbU8yVm1PdXB0Q0Rxc3JEc29KenRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxJVHJvWnp0bFlUc25ZUWc2NU94NjZHZDdaV1k3S2VBSU95Vml1eWN2T3VwdENEc25iVHNtcW5zbmJRZzdLQ2M3WldjNjVDcDY0dUk2NHVrTGdvdElPMlVoT3Vobk8yVmhPeWRoQ0RyazdIcm9aM3RsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbGJFZzY3S0U3S0NFN0oyMElPdUNydXlWaENEc25ienJ0b0FnNnJpdzY0cWw3SjIwDQpJT3lnbk8yVm5PdVFxZXVMaU91THBDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXWTY2bTBJT3VxcU91VG9DRHF1TERyaXFYc25ZUWc3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzY3aVU2Nk9vN1lpczdJcWs2ckNBSU9xNnZPeWd1Q0Rzbm9qc2xyUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU91NGxPdWpxTzJJck95S3BPdWx2Q0Rzdkp6cnFiUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU91NWhPeURnU0RzbDdEcm5iM3NzcGpxc0lBZzY1T3g2NkdkNjVDWTdLZUFJT3lWaXV5Vm1PeUt0ZXVMaU91THBDNEtMU0RydVlUc2c0RWc3SmV3NjUyOTdMS1k2Nlc4SU91VHNldWhuZTJWbU91cHRDRHF1TFRxdUludGxhQWc2NVdNSU91NW9PdWx0T3F5akNEc2w3RHJuYjNyazV6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzdHB6c25vVWc3TG0wNjVPYzZyQ0FJT3VUc2V1aA0KbmV1UW1PeW5nQ0RzbFlyc2xZUWc3SUtzN0pxcDdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0xhYzdKNkZJT3k1dE91VG5PdWx2Q0RyazdIcm9aM3RsWmpycWJRZzY3Q1U2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3SUNqc21ZVHJvNHdnN0pXSTY0SzBLUW9LSXlNaklPMmFqT3lia09xd2dPeWVoZXlkdENEc21ZVHJvNHpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNnJDQTdKNkY3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEc21JanNsYjNzbmJRZzdMZW83SWFNNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95WWlPeVZ2ZXlkaENEc3Q2anNob3p0bG9qc2xyVHNtcFF1Q2dvakl5TWc2Nnk0N0oyWTZyQ0FJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdJaWM3TENvN0tDQjdKeTg2NkdjSU91THRldXpnT3VUbk91bXJPcXlvT3lLdGV1TGlPdUxwQzRLTFNEcnJManNuWmpycGJ3ZzdLQ1I3SWlZN1phSTdKYTANCjdKcVVMaUF2SU95SW5PeUVuT3VNZ091aG5DRHJpN1hyczREcms1enJwclRxc296c21wUXVDZ29qSXlNZzdJU2s3S0NWN0oyMElPeTBpT3E0c08yWmxPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNoS1Rzb0pYc25ZUWc3TFNJNnJpdzdabVU3WmFJN0phMDdKcVVMZ29LSXlNaklPdTVoT3V3Z091eWlPMll1T3F3Z0NEcnM0RHFzcjNya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJT3V3bE9xL3FPeVd0T3lhbEM0S0NpTWpJeURzbmJqc3BwM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdU95bW5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1qSU95NmtPeWp2T3lXdk8yVm5DRHFzcjNzbHJRZ0tPeW5pT3VzdUNEc25xenF0YXpzaExFcENnb2pJeU1nN0phNDdLQ2NJT3V3cWV1c3VPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Ryc0tucnJMZ2c2NEtnN0tlYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SmEwDQo2NWFrSU91d3FldXlsZXljdk91aG5DRHNuYmpzcHAzdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SjI0N0thZElPdXdxZXV5bGV5ZGhDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPcXlzT3lnbk8yVm1PeUxwQ0RzdWJUcms1enJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rxc3JEc29KenRsYUFnN0xtMDY1T2M2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0p1UTdaV1k3SXVjNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsWmpzaExqc21wUXVDaTBnN0p1UTdaV1k2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWp2T3lHak91bHZDRHNsWXpxczZBZzZyT0U3SXVnNnJDQTdKcVVQd290SU95anZPeUdqT3VsdkNEc2xZenFzNkFnN0o2STY0S1k3SnFVUHdvS0l5TWpJeURycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQW9LSXlNaklPcTRzT3F3aENEcg0KcDR6cm80enJvWndnN0oyMDdKcXA3SjIwSU95a2tleW5nT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzbmJUc21xa2c2cml3NnJDRTdKMjBJT3VCbmV1Q21PeUVuQ0RzcDREcXVJanNuWUFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SnFwNjUrSklPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0lEc25xWHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lnZ095ZXBlMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVDZ29qSXlNZzdZYTE3SXVnSU95WXBPdWxtT3VobkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXWTdKaUE3SXExNjR1STY0dWtMZ290SU8yR3RleUxvT3lkdENEc201RHRtWnp0bFpqc3A0QWc3SldLN0pXRUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWcNCjZyYU03WldjSU91MmdPeWhzZXljdk91aG5DRHNvSkhxdDd6c25iUWc2ckd3NjdhQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SmEwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHF0b3p0bFp6c25ZUWc3SnFVN0xLdDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc3SU9CN1ptcElPeVZpT3VDdENBb011dUxxQ0RxdGF6c29iQXBDZ29qSXlNZzdKNkY2NkNsN1pXWTdJdWdJT3lqdk95R2pPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc2NHVrN0l1Y0lPMlpsZXlkdUNEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0tPODdJYU02Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3VMcE95TG5DRHRtWlhzbmJqdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWFsT3l5cmUyVm1PeUxvQ0R0anBqc25iVHNwNERycGJ3ZzdMQys3SjJFSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdZNlk3SjIwN0tlQTY2VzhJT3l3DQp2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95anZPeUdqT3VsdkNEdG1aWHNuYmp0bFpqcXNiRHJncGdnN1ptSTdKeTg2NkdjSU95ZHRPdVBtZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjQrWjdKMjg3WldjSU95YWxPeXlyZXlkdENEc3NwanJwcXdnN0tTUjdKNkY2NHVJNjR1a0xpRHNucURzaTV3ZzdadUVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc2ckNaN0oyQUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanFzNkFnN0o2STdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYlRyc3FUdGlyanFzSUFnN0tLRjY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdE91eXBPMkt1T3F3Z0NEcmdaM3JncXpzbHJUc21wUXVDZ29qSXlNZzdZT0k3WWUwSU95TG5DRHJxcWpyazZBZzY0Mnc3SjIwN1lTdzZyQ0FJT3lDcmV5Z25PdVFtT3Vwc0NEcnM3WHF0YXp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0Sw0KTFNEdGc0anRoN1R0bFpqcnFiUWc2NnFvNjVPZ0lPdU5zT3lkdE8yRXNPcXdnQ0RzZ3Ezc29KenJrSmpxczZBZzY0dWs3SXVjSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95Z2xldW5rQ0R0ZzRqdGg3VHRsYURxdVl6c21wUS9DZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeURnZTJacVNEc2xZanJnclFwQ2dvakl5TWc2N2FBN0o2c0lPeWtrU0Ryc0tucnJManNucERxc0lBZzZyQ1E3S2VBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91MmdPeWVyQ0RzcEpIc2w1QWc2N0NwNjZ5NDdKNlE2ckNBSU95ZWlPeVhpT3lXdE95YWxDNGdMeURzbUlIc2c0SHNuWVFnN1ptVjdKMjQ3WlcwSU91enRPeUV1T3lhbEM0S0NpTWpJeURxc3IzcnVZUWc3WlcwN0tDY0lPcTJqTzJWbk95ZHRDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZySzk2N21FSU8yVnRPeWduQ0RxdG96dGxaenNuYlFnN1pXRTdKcVU3WlcwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHNtcFRzc3EzdGxiUWcNCjdLTzg3SVM0N0pxVUxnb0tJeU1qSU8yWmxPeWVyQ0Rxc0pEc3A0RHF1TEFnNjdDdzdZU3c2NmFzNnJDQUlPdTJnT3loc2UyVnFldUxpT3VMcEM0S0xTRHRtWlRzbnF3ZzZyQ1E3S2VBNnJpd0lPdXdzTzJFc091bXJPcXdnQ0RzbHJ6cnA0Z2c3SmVHN0phMDdKcVVMaUF2SU91d3NPMkVzT3Vtck91bHZDRHF0WkRzc3JUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHN0cFhzbGIwZ0t5RHF1STNzb0pVZzdLQ0U3Wm1ZSUNqcmtaQWc2Nnk0N0o2bElPS0draURxdUkzc29KWHRtSlVnN1pXY0lPdXN1T3llcFNrS0NpTWpJeURycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0RyDQpzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRtSnp0ZzUwZzdKZUc3SjIwSU9xd2dPeWVoZTJWb09xNWpPeWFsRDhnN0tlQTZyaUlJT3lMb095eXJlMlZtT3luZ0NEc2xZcnNuTHpycWJRZzdKdXc3THUwSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzcDREcXVJZ2c3SXVnN0xLdDdaV1k2Nm0wSU95YnNPeTd0Q0R0bUp6dGc1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0wrZzdZK3dJT3lYaHV5ZHRDRHFzckRzb0p6dGxhRHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1Q0RzdjZEdGo3RHNuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUNpMGc3TCtnN1krdzdKMkVJT3V3bSt5Y3ZPdXB0Q0RyalpRZzdLQ0E2NkMwN1pXWTZyS01JT3F5c095Z25PMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95VmpPdW12Q0RzbDRic25iUWc3SXVjN0o2UjdaV2c2cm1NN0pxVQ0KUHlEc2xZenJwcnpzbllRZzdMeWM3S2VBSU95Vml1eWN2T3VwdENEc3BKSHNtcFR0bFp3ZzdJYU03SXVkN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU95VmpPdW12T3lkaENEc3ZKenJxYlFnN0tTUjdKcVU3WldjSU95R2pPeUxuZXlkaENEcnNKVHJvWndnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0o2UTY0K1o3SjIwN0xLMDY2VzhJT3VUc2V1aG5lMlZtT3luZ0NEc2xZcnFzNkFnNjRTWTdKYTA2ckNJNnJtTTdKcVVQeURyazdIcm9aM3RsWmpzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc25wRHJqNW5zbmJUc3NyVHJwYndnNjVPeDY2R2Q3WldZNjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJzN2dnNnJPRTdKVzk3SjJZSU95Y29PeWR2TzJWbkNEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3lkdk91d21PcTBnT3Vtck95ZWtPdWgNCm5DRHF0b3p0bFp6cnM0RHFzcjNzbllRZzdaV1k3SXVrSU95SW1DRHNsNGJzbHJUc21wUXVJT3lkdk91d21DRHF0SURycHF6c25wRHJvWndnNnJhTTdaV2NJT3V6Z09xeXZleWRoQ0RzbTVEdGxaanNpNlFnNnJLOTdKcXdJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla0NEcXRvenRsWnpzbllRZzdLZUE3S0NWN1pXMElPeWp2T3lMb0NEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVm5DRHJrcVFnN0oyODY3Q1lJT3EwZ091bXJPeWVrT3VobkNEcnM0RHFzcjN0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLTFNEcmk2VHJwYmdnN0lLczY1Nk03SjJFSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcm9ad2c3S2VBN0tDVjdaV1k2Nm0wSU91emdPcXl2ZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ289DQo6OkdVSURFOjoNCkl5QlZXQ0JYY21sMGFXNW5JT3F3Z095ZHRPdVRuQTBLRFFvakl5QXhMaUR0bGJUc21wVHNzclFOQ2cwSzdLQ2M3WktJSU95VmlPeWRtQ0RycXFqcms2QWc2Nnk0NnJXczY0cVVJQ2Z0bGJUc21wVHNzclFuNjZHY0lPeU5xT3lhbEM0TkN1eWR2T3EwZ095RXNTRHNub2pyaXBRZzdJS3M3SnFwN0o2UUlPcXl2ZTJYbU95ZGhDRHJwNHpyazZRZzdJaVlJT3llaU91UGhPdWhuU0FxS3V5RGdlMlpxU3dnNjZlbDY1Mjk3SjJFSU91MmlPdXN1TzJWbU9xem9DRHJxcWpyazZBZzY2eTQ2cldzN0plUUlPMlZ0T3lhbE95eXRPdWx2Q0Rzb0lIc21xbnRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHJzN1RyZzRYcmk0anJpNlFnNG9hU0lPdXp0T3VDdk9xeWpPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ01pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzQTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSU95MW5PdU1nTzJWbkNBcUt1dUtwZXVQbWUyWWxTRHJyTGpzbnFVcUt1eWRoQ0RzamFqc283enNoTGpzDQptcFF1SU95SW1PdVBtZTJZbFNEcnJManNucVhzbllBZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TVMzc2lKanJqNW50bUpVdDY2eTQ3SjZsN0oyRUxleU5xT3VQaEMzcmtKanJpcFF0NnJLOTdKcXdLZXlYa0NEdGxiVHJpN250bGFBZzY1V002NmVNSU95VHNPdUtsQ0Rxc293ZzdLS0w3SldFN0pxVUxnMEtEUW9qSXlNZzY1Q1E3SmEwN0pxVUlPS0draUR0bG9qc2xyVHNtcFFOQ2cwSzdKaUlLUTBLTFNEc2hLVHNvSlhya0pEc2xyVHNtcFFnNG9hU0lPeUVwT3lnbGUyV2lPeVd0T3lhbEEwS0RRb2pJeU1nSjM3c2w0Z25JT3U1dk9xNHNBMEtEUXJzbUlncERRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVURRb05DaU1qSXlEcmo1bnNncXdnNjdDVTZyK1U3Sk93NnJpd0RRb05DdXlZaUNrTkNpMGc2NGFTN0pXRTdLR003SmEwN0pxVUlPS0draURzbUt6cm5wRHNsclRzbXBRTkNnMEtLaW9xRFFvTkNpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBTg0KQ2cwSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEcnRvRHNvSlhzb0lFZzdMdWs2NjZrNjR1STdMeUE3SjIwN0lXWTdKMkVJT3kxbk91TWdPMlZuQ0RzcElUc25iVHFzNkFnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXlkaENEc2phanNvN3pzaExqc21wUXVEUXJydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVE10NjdhQTdLQ1Y3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzamFqc21wUXVEUW9OQ3V5WWlDQTZJT3lWaUNEcmo3enNtcFFzSU95WGh1eVd0T3lhbENBb1dDa2c0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSXlEc2w0YnNsclRzbXBRZzRvYVNJT3llaU95V3RPeWFsQTBLRFFyc21JZ3BEUW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxaanF1TEFnN0tDRTdKZVE2NHFVSU9xd2dPeWVoZTJWb0NEc2lKZ2cNCjdKZUc3SmEwN0pxVUlPS0draURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXMDdKVzhJT3F3Z095ZWhlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVURRb05DaU1qSXlEc2w1RHJuNndnNjZtVTdJdWM3S2VBRFFvTkN1eVhrT3VmckNEc2c0SHRtYW5zbDVEc2hKenJqNFFnSXUyVnRPcXlzQ0Ryc0tucnNwVWk3SjJFSU91b3ZPeWdnQ0RzbFl6cm9LVHNvN3pyaXBRZzZyaU43S0NWN1ppVklPcTFyT3loc091aG5DRHNqYWpzbXBRdURRb05DdXlZaUNrTkNpMGc3S2VBNnJpSUlPdXloT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0ZzRvYVNJT3lWc2V5ZGhDRHNsNFhyamJEc25iVHRpcmp0bGJUc283enNoTGpzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeTFuT3lMDQpvQ0Ryc29Uc29JVHNuYlFnN1pXRTdKcVU3WlcwN0pxVUxnMEtEUW82T2pvZ2RHbHdJTzJNbmV5WGhTRHJzb1R0aXJ6c25ZQWdXemd1SU8yTW5leVhoVjBnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbEEwSzdZeWQ3SmVGS091THBPeWR0T3lXdk91aG5PcTN1Q2tnNjdLRTdZcThJT3VzdU9xMXJPdUtsQ0RzbFlUcm5wZ2dLaW80TGlEdGpKM3NsNFVxS2lEc2hMbnNoWmdnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbENEaWdKUWc3WWExNjdPMDY0cVVJRnZ0bVpYc25iaGRMQ0RzbUlndjdKV0U2NHVJN0ppa0lPMk1rT3VMcU95ZGdDQmI3SldFNjR1STdKaWtYY0szVyt1RXBGMHNJT3VQbWV5ZWtTRHNuS0RyajRUcmlwUWdXK3kzcU95R2pGM0N0MXZyajVuc25wRmRMaUFpN0xlbzdJYU1JdXVLbENEcmo1bnNucEVnNjdLRTdZcTg2ck84SU95bm5leWR2Q0RybFl6cnA0d2c3Sk93NnJPZ0xDQWk2NHVyNnJpd0lNSzNJT3VQbWV5ZWtTTHNzcGpybjd3ZzdLZWQ3SjIwSU95VmlDRHJwNTdyaXBRZzdLR3c3WldwN0oyQQ0KSU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFvNk9qb05DZzBLSXlNaklPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzdKaUlLUTBLTFNEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzRvYVNJT3lWdmVxMGdPeVhrQ0RyajVuc25aanRsWmpycWJRZzY2cW83SjZFN0tlQTdKdVE2cmlJN0oyRUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvakl5TWc3WmljN1lPZElPdU1nT3lEZ1NEc2xZanJnclFOQ2cwS0tpcnNoSnpydVlUc2lxVHJpcFFnN0pPNElPeUltQ0Rzbm9qc3A0RHJwNHdzSU8yS3VleWdsU0R0bUp6dGc1M3NuWUFnNjdDYjdKMkVJT3lJbUNEc2w0YnNuWVFnNjVXTUlPS0draURxdUkzc29KWHRtSlVnNjZ5NDdKNmwNCjdKeTg2NkdjSU95TnFPeWFsQzRxS2cwSzdJS3M3SnFwN0o2UTY0cVVJT3VzdU9xMXJPdWx2Q0Rxdkx6cXZMenRub2dnN0oyOTdLZUFJT3lWaXVxem9DRHRtNUhzbHJUcnM3VHF1TEFvN0lxazdMcVVLU0RybFl6cnJManNsNUFzSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzazdEcnFiUWc3S0NjN1pLSUlPeWdoT3l5dE91bHZDRHNrN2dnN0lpWUlPeVhodXVMcE9xem9DRHNtS1R0bGJUdGxaanF1TEFnN0ltczdKdU03SnFVTGcwS0RRcnNtSWdwRFFvdElPcXpoT3lpakNEcXNKenNoS1FnN1ppYzdZT2Q3SjJBSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnTkM0MUpTRHF1SWpycHF3ZzdaaWM3WU9kNjZlTUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ05DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0QTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSUNkKzdJdWM2cktnN0phMDdKcVVQeWNzSUNmc2k1enJncGpzbXBRL0p5d2dKMzdxdTVnbklPcXdtZXlkDQpnQ0Rxczd6cmo0VHRsWndnNnJLOTdKYTA2Nlc4SU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFyc3RaenJqSUR0bFp3ZzdMcVE3S084N0phODdaV1k2ck9nSU95NW5PcTN2TzJWbkNEcnA1RHRpS3pycGJ3ZzdKT3c2NHFVSU9xeWpDRHNvb3ZzbFlUc21wUXVEUXJxc3Izc2xyVHJpcFFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNaTNxc3Izc2xyVHJwYnd0N0kybzY0K0VMZXVRbU91S2xDM3FzcjNzbXJBcDdKZVFJTzJWdE91THVlMlZvQ0RybFl6cnA0d2c3STJvN0pxVUxnMEtEUW9qSXlNZzY0K1o3SUtzN0plUTdJU2NJQ2QrN0l1Y0p5RHJ1YnpxdUxBTkNnMEs3SmlJS1EwS0xTRHN1YlRyazV6cnBid2c3WlcwN0tlQTdaV1k3SXVjNnJLZzdKYTA3SnFVUHlEaWhwSWc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOE5DaTBnN0l1YzdKNlI3WldZN0l1YzY0cVVJT3UyaE95WGtPcXlqQ0ExTERBd01PeWJrT3lkaENEcms1enJvS1RzbXBRdUlPS0draURzaTV6c25wSHRsWmpycWJRZw0KTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnMEtEUW9qSXlNZ0orcXpoT3lMbk91THBDY2c0b2FTSUNmc25vanJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKNlE2NCtaN0xDbzY2VzhJT3F3Z095bmdPcXpvQ0RxczRUc2k1enJncGpzbXBRL0lPS0draURzbnBEcmo1bnNzS2pxc0lBZzdKNkk2NEtZN0pxVVB3MEtMU0RycDZUcmk2d2c2N08wN1plWTY2T01JT3lXdk91bmlPeVVxU0RyZ3JUcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdUtsQ0RzbHJ6cnA0anNuYmpxc0lEc21wUS9JQ29vNjR1bzdJaWNJT3k1bU8yWm1PeWR0Q0RzbFlUcmk0anJuYndnNjZ5NDdKNmw3SjJFSU95RGlPdWhuQ0RzazdRZzdJS3M2NkdBN0ppSTdKcVVLU29OQ2cwS0l5TWpJQ2ZzbDZ6c3JZanJpNlFuSU9LR2tpQW43Wm1WN0oyNDdaV1k2NHVrTENEcnJMdnJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUg2ckNBN0tlQUlPdUwNCnBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVJT0tHa2lEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvZnFzSURzcDRBZzY0dWs3SXVjSU8yWmxleWR1TzJWb09xeWpPeWFsQzROQ2cwS0l5TWpJQ2ZxdTVnbklPS0draUFuN0plUTZyS01KdzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1PcTdtQ0RyZ3FEc2xZVHFzSURxczZBZzdKNkk3SmEwN0pxVUxpRGlocElnN1ptTjZyaTQ2NCtaNjR1WTdKZVE2cktNSU91Q29PeVZoT3F3Z09xem9DRHNub2pzbHJUc21wUXVEUW9OQ2lNakl5RHFzcjNzbHJUcnBid2c2N3FRN0oyRUlPdVZqQ0RzbHJUc2c0bnRsWndnNnJLOTdKcXdEUW9OQ3V5Q3JPeWFxZXlla095ZG1DRHNvSlhyczdUcnBid2c2N0NiNjRxVUlPeW5pT3VzdU95WGtPeUVuQ0RxdUxEcXM0VHNvSUhzbkx6cm9ad2dKMzdzaTV3bjY2VzhJT3U2a095ZGhDRHJsWXdnNjZ5NDdKNmw3SjIwSU95V3RPeURpZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLS2lydGpJenNsWVh0DQpsWmpxczZBZzdJdTI3SjJBSU95Z2xldXp0T3VsdkNBbjdLTzg3SmEwSit1aG5DRHNqYWpzaEp3ZzY2eTQ3SjZsN0oyRUlPeURpT3VocmVxeWpDRHNqYWpyczdUc2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VNZ095Mm5DRHJxcW5zb0lIc25iUWc2NnkwN0plSDdKMjQ2ckNBN0pxVVB3MEtMU0RzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhnNG9hU0lPeUxvT3F6b0NEc25iVHNuS0RycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lFdU95YWxDNE5DZzBLS2lvcURRb05DaU1qSURVdUlDZDc2NnFGN0lLc2ZTQXJJSHZycW9Yc2dxeDlKeURzazdEc3A0QWc3SldLNnJpd0RRb05DaU1qSXlEdGxaenNucERzbHJRZzdaS0E3SmEwN0pPdzZyaXdEUW9OQ3UyVm5PeWVrT3lXdENEcnFvWHNncXpycGJ3ZzdaS0E3SmEwN0lTY0lPdVBtZXlDckNEdG1KWHRnNXpyb1p3Zw0KN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdKMjA3SjZRSU8yWm1PdTJpT3lkaENEcnNKdnNsWmpzbHJUc21wUWc0b2FTSU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRTkNpMGc2NEswN0oyOElPeTV0T3VUbk9xd2t1eWR0Q0Rxc3JEc29KenJrS0FnN0ppSTdLQ1Y3SjIwN0plUTdKcVVJT0tHa2lEcmdyVHNuYnpzbllBZzdMbTA2NU9jNnJDU0lPdUNtT3F3Z091S2xDRHJncURzbmJUc2w1RHNtcFFOQ2cwS0l5TWpJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclRzazdEcXVMQWc3SmEwNjZDazdKcTRJT3F5dmV5YXNBMEtEUW9uZSt1cWhleUNySDNxc0lBZ2UrdXFoZXlDckgzdGxiVHNoSnduSU8yWWxlMkRuT3Vobk91bmpDRHRrb0RzbHJUc3BKanJqNFFnNjQyVUlPeTZrT3lqdk95V3ZPMlZtT3F5akNEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2NJT3Exck91bnBPMlZtT3luZ0NEcnFydnQNCmxvanNsclRzbXBRZzRvYVNJT3llbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3ZzZyV3M2NmVrN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEEwS0RRb3FLaW9OQ2cwS0l5TWdOaTRnN1pHYzZyaXdJTzJHdGV5ZHZBMEtEUW9qSXlNZzY1Q1k3SmEwN0pxVUlDaFlLU0RpaHBJZzY0Kzg3SnFVSUNoUEtRMEtEUXJycXFqcnNKVHNuYndnN1ptVTY2bTA3SjJZSU95aWdleWRnQ0RxczdYcXNJVHNuWVFnNnJPZzY2Q2s3WlcwSUNmcmtKanNsclRzbXBRbjY0cVVJT3VxcU91UmtDQW42NCs4N0pxVUordWhuQ0R0aHJYc25ienRsYlRzaEp3ZzdJMm83S084N0lTNDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ055NGc2NEtnN0tlY3dyZnNpNXpxc0lUQ3QreUlxK3lla0NEdGtaenF1TEFOQ2cwSzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt1eWlPMll1T3VLbENEc2xZVHJucGdnN1ppVjdJdWQ3Snk4NjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc21wUXVEUW9OQ2lNakl5RHJncURzcDV6Q3QreUxuT3F3aE1LMzZyaXc2ckNFDQpEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzY0S2c3S2VjSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRVlDQXZJT3lucCtxeWpDQmdUVTB1UkVSZ0lId2dNakF5TlM0d01TNHdNU3dnTWpVdU1ERXVNREVnZkEwS2ZDRHNpNXpxc0lRZ2ZDRHF1TERyczdnZ1lFaElPazFOT2xOVFlDQXZJT3lucCtxeWpDQmdTRWc2VFUxZ0lDanNtS1Rzb0lRdjdKaWs3WnVFSU95VmlDRHNsSUFwSUh3Z01UUTZNekE2TVRFc0lERXpPak13SUh3TkNud2c2cml3NnJDRUlId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVmbGxaV1ZrdVRVMHVSRVJnSUM4ZzdLZW42cktNSUdCWldWbFpMazFOTGtSRWZrMU5Ma1JFWUNCOElESXdNalV1TURFdU1ERitNakF5TlM0d01TNHpNU3dnTWpBeU5TNHdNUzR3TVg0d01TNHpNU0I4RFFwOElPdUNvT3lubkNBcklPeUxuT3F3aENCOElHQlpXVmxaTGsxTkxrUkVJRWhJT2sxTllDQjhJREl3TWpVdQ0KTURFdU1ERWdNVFE2TXpBZ2ZBMEtmQ0RzbXBUc25id2dmQ0JnV1ZsWldTNU5UUzVFUkNqc21wVHNuYndwWUNEaWdKUWc3SnVVTCsyWmxDL3NpSmd2NjZxcEwrcTRpQy90aHFBdjdKMjhJSHdnTWpBeU5TNHdNUzR3TVNqc2lKZ3BJSHdOQ2cwS0tpcnNpNXpxc0lRZzdKaUk3Sm00S2lvNklPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDQmc3SmlrN0tDRUwreVlwTzJiaENCSU9rMU5ZT3lkaENEc2phanJqNFFnNjQrODdKcVVMZzBLN0ppSUtTRHNtS1R0bTRRZ01Ub3dNQTBLRFFvakl5TWc2Nnk0N0o2bElPeUdqU0RzbDdEc201VHNuYndOQ2cwSzY2eTQ3SjZsSU95VmlPeVhrT3lFbk91S2xDQXFLdXlibE1LMzdKMjhJT3lWbnV5ZG1DQXc3SjJFSU91NXZPcXpvQ29xSU95TnFPeWFsQzROQ2cwSzdKaUlLUTBLTFNBeU1ESTI2NFdFSURBNDdKdVVJREExN0oyOElPeWVoZXVMaU91THBDNGc0b2FTSURJd01qYnJoWVFnT095YmxDQTENCjdKMjhJT3llaGV1TGlPdUxwQzROQ2cwS0l5TWpJT3lEZ2V1TWdDRHNpNXpxc0lRZ0tPdUZ1T3kybk95YXFTa05DZzBLZkNEc29iRHFzYlFnZkNEdGtaenF1TEFnZkEwS2ZDMHRMUzB0TFh3dExTMHRMUzE4RFFwOElEWXc3TFNJSU91dnVPdW5qQ0I4SU91d3FlcTRpQ0Rzb0lRZ2ZBMEtmQ0EyTU91MmhDRHJyN2pycDR3Z2ZDQk82N2FFSU95Z2hDQjhEUXA4SURJMDdJdWM2ckNFSU91dnVPdW5qQ0I4SUU3c2k1enFzSVFnN0tDRUlId05DbndnTXpEc25id2c2Nis0NjZlTUlId2dUdXlkdkNEc29JUWdmQTBLZkNBeE11cXduT3libENEcnI3anJwNHdnZkNCTzZyQ2M3SnVVSU95Z2hDQjhEUXA4SURFeTZyQ2M3SnVVSU95ZHRPeURnU0I4SUU3cmhZUWc3S0NFSUh3TkNnMEs3SmlJS1NEcnNLbnF1SWdnN0tDRUxDQTE2N2FFSU95Z2hDd2dNdXlMbk9xd2hDRHNvSVFzSURQc25id2c3S0NFTENBMjZyQ2M3SnVVSU95Z2hDd2dNdXVGaENEc29JUU5DZzBLSXlNaklPdW5pT3F3a01LMzZyaXc2ckNFSU91bmpPdWpqQTBLDQpEUXBnUkMxT1lDaE83SjI4SU91Q3FPeWRqQ2tnTHlCZ1JDMHdZQ2pzbUtUcmlwZ2c2NmVJNnJDUUtTQXZJR0JFSzA1Z0tFN3NuYndnNnJLOTZyTzhLUTBLN0ppSUtTQkVMVGNzSUVRdE1Td2dSQzB3TENCRUt6RU5DZzBLSXlNaklPdXlpTzJZdUNEdGtaenF1TEFnS08yVm1PeWR0TzJVaU95Y3ZPdWhuQ0RxdGF6cnRvUXBEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzdLQ0U3Wm1VNjdLSTdaaTRJSHdnN1pXWTdKMjA3WlNJSU9xMXJPdTJoQ0I4SURBeUxURXlNelF0TlRZM09Dd2dNREV3TFRFeU16UXROVFkzT0NCOERRcDhJT3k1dE91VG5PdXlpTzJZdUNCOElEVHNucERycHF6c2xLa2c3WldZN0oyMDdaU0lJSHdnTVRJek5DMDFOamM0TFRrd01USXRNelExTmlCOERRcDhJT3F6aE95aWpPdXlpTzJZdUNCOElPMlZtT3lkdE8yVWlDRHF0YXpydG9RZ2ZDQXhNak10TkRVMkxUYzRPVEF4TWlCOERRcDhJT3lqdk91dg0Kdk91VHNldWhuZXV5aU8yWXVDQjhJT3lWbmlBMjdKNlE2NmFzTGV1U3BDQTM3SjZRNjZhc0lId2dNVEl6TkRVMkxURXlNelExTmpjZ2ZBMEtmQ0RzZ3F6c2w0WHNucERyazdIcm9aM3Jzb2p0bUxnZ2ZDQXhNT3lla091bXJDRHRsWmpzbmJUdGxJZ2dmQ0F3TVMweU16UXROVFkzT0RrZ2ZBMEtEUW9qSXlNZzdKT3c2Nm0wSU95VmlDRHJrSmpyaXBRZzdaR2M2cml3RFFvTkNpMGc2NEtnN0tlYzdKZVFJTzJWbU95ZHRPMlVpTUszNjdtWDZyaUlPaURpbll3Z01qQXlOUzB3TVMwd01Td2dNREV2TURFTkNpMGc3SXVjNnJDRTdKZVFJT3lZcE95Z2hDL3NtS1R0bTRRNklPS2RqQ0RzbUtUc29JUWdNZXlMbkNBcUtPdUxxQ3dnN0lLczdKcXA3SjZRNnJDQUlPeW5nZXlna1NEcXM2RHJwYlRyaXBRZzY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSU95WWlPeVp1Q2txRFFvTkNpb3FLZzBLRFFvakl5QTRMaUR0akozc2w0VW82NHVrN0oyMDdKYTg2NkdjNnJlNEtRMEtEUXJ0akozc2w0VWc2Nnk0NnJXczY0cVUNCklDb3E3SmV0N1pXZ0tpb283WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZDbnFzN3dnS2lyc25LRHRtSlVxS2lqdGhyWHJzN1F2N1l5UTY0dW9LZXlYa0NEcmxMRHJuYndnNjZ5NDdMSzA2ckNBSU91THJPdWR2T3lhbEM0ZzdZT0E3SjIwN1l1QTdKMkVJT3VMcE91VHJPeWRoQ0RybFpBZzY3Q1k2NU9jN0l1Y0lPeVZpT3VDdENqcnM3anJyTGdwNnJtTTdLZUFJT3F3bWV5ZHRDRHJzN1RxczZBc0lPdXp1T3VzdUNEcnA2WHJuYjNzbllRZzY0dTA3SldFN0pXOElPMlZ0T3lhbEM0TkNnMEtJeU1qSUREcmk2anFzNFFnNG9DVUlPMkt1T3Vtck9xeHNPdTJnTzJFc0NEcnRKRHNtcFFOQ2cwSzdZeWQ3SmVGN0oyMElPeUNyT3lhcWV5ZWtPeWRtQ0RzbHJUcmxxUWc3WmFKNjQrWklPdVNwT3lYa0NEcm5LanJpcFRzcDRBZzY2aTg3S0NBSU8yTWpPeVZoZTJWdE95YWxDNE5DZzBLTFNEdGxvbnJqNW5zbllRZ0tpcnFzSURyb1p6cnA0bnFzYkRyZ3BnZzdZeVE2NHVvN0oyRUlPeWFsT3ExckNvcUtPeWR0TzJEDQppTUszN0lLdDdLQ2N3cmZyb1p6cXQ3anNsWVRzbTRQQ3QreWloZXVqakNrZzRvYVNJQ29xN1l5UTY0dW83WmlWS2lvZ0tPdXN2T3lXdE91MGtPeWFsQ2tOQ2kwZzZyS3c2ck84d3Jmc2c0SHRnNXpycGJ3Z0tpcnRoclhyczdUcnA0d3FLaUFvN0ptRTY2T013cmZzaTZUdGpLZ3BJT0tHa2lBcUt1eVZpT3VDdE8yWWxTb3FJQ2pzbFl6cm9LVHNwSmpzbXBRcERRb05DaU1qSXlEdGc0RHNuYlR0aTRBZzRvQ1VJT3lucCt5ZGdDRHJxb1hzZ3F6cXRhd05DZzBLTFNEcnFvWHNncXp0bUpYc25MenJvWndnNjRHZDY0SzA3SnFVTGlEc29vWHFzckRzbHJUcnI3akN0K3VuaU95NXFPMlJuT3VsdkNEc2s3RHNwNEFnN0pXSzdKV0U3SnFVSUNoKzdKcVVJQzhnZnV1THBDQXZJSDdxdVl6c21wUS9JT0tkakNrdURRb3RJREorTk95V3RPeWdpT3VobkNEc3A2ZnFzNkFnN0ltOTZyS01MaUR0bFp6c25wRHNsclRDdCt5SW1PeUxuZXlkaENEcXVManFzb3dnN0l5VDdLZUFJT3lWaXV5VmhPeWFsQzROQ2kwZzdKV0k2NEswS091eg0KdU91c3VDa2c2NmVsNjUyOTdKMkVJT3lhbE95VnZlMlZ0Q3dnS2lydGc0RHNuYlR0aTREcnA0d2c2N1NRNjQrRUlPdXN0T3lLcUNEdGpKM3NsNFhzbmJqc3A0QXFLaURzbFl6cXNvd2c3WlcwN0pxVUxpRHNtNURyczdqc25iUWdKK3lWak91bXZNSzM3Wm1WN0oyNEoreXltT3VmdkNEcnA0bnNsN0R0bFpqcnFiUWc2N080NjZ5NDdKMkVJT3Ezdk9xeHNPdWhuQ0RxdGF6c3NyVHRtWlR0bGJUc21wUXVEUW9OQ253ZzdKMjA2NkNINnJLTUlPdW5rT3F6b0NCOElPeWR0T3VnaCtxeWpDQjhEUXA4TFMwdGZDMHRMWHdOQ253ZzdLQ0E3SjZsN1pXWTdLZUFJT3lWaXVxem9DRHJncGpxc0lEc2k1enFzcURzbHJUc21wUS9JSHdnN0tDQTdKNmxJT3lWaUNEdGxad2c2NEswN0pxcElId05DbndnN0pXTTY2YThJSHdnNnJLdzdLQ2NJT3laaE91ampDQjhEUXA4SU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JSHdnNjQydzdKMjA3WVN3SU95Q3JleWduQ0I4RFFvTkNpTWpJeURzbFlqcmdyUW8NCjY3TzQ2Nnk0S1NEaWdKUWc3WlcwN0pxVTdMSzBEUW9OQ2kwZ0tpcnRqSkRyaTZqdG1KVXFLdXlkZ0NBbmZ1MlZvT3E1ak95YWxEOG42NkdjSU91c3ZPeVd0T3lhbEM0ZzY1Q1k2NCtNNjZhMElPeUltQ0RzbDRicmlwUWc3SnlFN1plWUtPeUNyZXlnbk1LMzdZT0k3WWUwSU91VHNTbnNuWUFnNnJLdzZyTzg2Nlc4SU91b3ZPeWdnQ0Rxc3IzcXM2RHRsYlRzbXBRdURRb3RJQ29xN0pXSTY0SzA3WmlWS2lyc25ZQWc3SUtzN0l1azdKMkVJT3lFbk95SW9PMlZ0T3lhbEM0TkNpMGc2NmVJN0xtbzdaR2M2Nlc4SU95TnFPeWFsQzRnN0lpcjdKNlF3cmZzb2JEcXNiUW83SjIwN0lPQndyZnNuYlR0bFpqQ3QreWR0T3VDdENEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaRHFzNkFzSU95YmtPdXN1T3lYa0NEc2w0YnJpcFFnN0tDVjY3TzB3cmZzb0lqc3NLakN0K3lYc091ZHZleXltT3VsdkNEc3A0RHNsclRyZ3JUc3A0QWc3SldLN0pXRTdKcVVMZzBLRFFvakl5TWc2N0tFN1lxOElPS0FsQ0RzbFlqcmdyUWc2Nnk0DQo2NmVsN0oyMElPeWdsZTJWdE95YWxBMEtEUXA4SU91enVPdXN1T3lkdENEc25iVHJvSWZyaTZRZ2ZDRHJzb1R0aXJ3Z2ZBMEtmQzB0TFh3dExTMThEUXA4SU9xeXNPcXp2TUszN0lPQjdZT2M2Nlc4SU8yR3RldXp0Q0I4SUZ2dG1aWHNuYmhkSUh3TkNud2dKMzd0bGFEcXVZenNtcFEvSit1aG5DRHJyTHpzbll3Z2ZDQmI3SldFNjR1STdKaWtYU0RDdHlCYjY0U2tYU0I4RFFwOElPeURnZTJacVNEc2hKenNpS0FnS3lEc21LVHJwYmpzcXIzc25iUWc3SXVrN0tDY0lPdVBtZXlla1NCOElGdnN0NmpzaG94ZElNSzNJRnQ3NjQrWjdKNlJmVjBnZkEwS0RRb3RJQ2ZzdDZqc2hvd242NHFVSUNvcTY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1LaW9nN0kybzdKcVVJQ2pzbUlnNklGdnN0NmpzaG94ZHdyZGI3SUt0N0tDY1hTa3VJQ2ZyaTZ2cXVMQWd3cmNnNjQrWjdKNlJKK3l5bU91ZnZDRHNwNTNzbmJRZzdKV0lJT3VubnV1S2xDRHNvYkR0bGFuc25iVHJncGdnNjR1bzY0K0ZJQ2ZzdDZqcw0KaG93bjY0cVVJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW90SU91eWhPMkt2T3lkbUNEcmo1bnNucEVnN0oyMDY2YUU3SjJBSU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGhDRHF0N2pyaklEcm9ad2c3SUswNjZDazdKcVVMZzBLRFFvakl5TWc3WWExN0tlY0lPeVlpT3lMbkEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdKMjA3WU9JS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURzb0lEc25xVWc3SldJSU8yVm5DRHJnclRzbXFrTkNpMGc3SldJNjRLME9pRHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4ZzdKNkY2NkNsN1pXY0lPdUN0T3lhcWV5ZHRDRHNncXpybmJ6c29ManNtcFF1RFFvdElPdXloTzJLdkRvZzdKV0U2NHVJN0ppa0lNSzNJT3VFcEEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdJS3Q3S0NjSUNqc25JVHRsNWdwS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURyamJEc25iVHRoTEFnN0lLdDdLQ2NEUW90SU95VmlPdUMNCnREb2c3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0RzZ3JUcnByUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzdJS3Q3S0NjN1pXZzZybU03SnFVUHcwS0xTRHJzb1R0aXJ3NklPeVZoT3VMaU95WXBDREN0eURyaEtRTkNnMEtLaXJyajVuc25wSHRtSlVnNG9DVUlPeUVuT3lJb0NBcklPdVBtZXlla1NEcnNvVHRpcndxS2cwS0xTRHRnNERzbmJUdGk0QTZJT3E0c09xNHNDRHNsN0Rxc3JBZzdaVzA3S0NjRFFvdElPeVZpT3VDdERvZzdJU2c3WU9kN1pXY0lPcTRzT3E0c095ZG1DRHNsN0Rxc3JEc25ZUWc2NEdLN0phMDdKcVVMZzBLTFNEcnNvVHRpcnc2SU95M3FPeUdqQ0RDdHlEc2w3RHFzckFnN1pXMDdLQ2NEUW9OQ2lvcTdKV0k2NEswN1ppVklPS0FsQ0RzbVlUcm80d2c3WWExNjdPMEtpb05DaTBnN1lPQTdKMjA3WXVBT2lEcXNyRHNvSndnN0ptRTY2T01EUW90SU95VmlPdUN0RG9nNnJLdzdLQ2M2ckNBSU95Z2xleURnU0Rzc3BqcnBxenJrSkRzbHJUc21wUXVEUW90SU91eWhPMkt2RG9nN1ptVjdKMjREUW9ODQpDaW9xS2cwS0RRb2pJT3lZaU95WnVDRHF0NXpzdVprTkNnMEs3SnVRN0xtWktPdUtwZXVQbWNLMzZyaU43S0NWd3Jmc3VwRHNvN3pzbHJ3cDY3TzA2NHVrSU95WWlPeVp1T3F3Z0NEcmpaUWc2NnFGN1ptVjdaV2NJT3k3cE91dXBPdUxpT3k4Z095ZHRPeUZtT3lkaENEcnA0enJrNXpyaXBRZzZySzk3SnF3N0ppSTdKcVVMZzBLRFFvakl5RHNtSWpzbWJnZ01TNGc3SWlZNjQrWjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqcmo0UWc2NUNZNjRxVUlPcXl2ZXlhc0EwS0RRb2pJeU1nN0lTYzY3bUU3SXFrSU95aWhldWpqQ3dnNnJpdzZyQ0VJT3Vuak91ampBMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWp2T3lXdENqc29vWHJvNHdnN0lTYzY3bUU3SXFrTENEcXVMRHFzSVFnNjVPeEtldWx2Q0Rxc0pYc29iRHRsYUFnN0lpWUlPeWVpT3F6b0N3Z0oreWloZXVqakNmc21ZQWdKK3Vuak91ampDZnNuWmdnNjRtWTdKV1o3SXFrNjZXOElPeWdsZTJabGUyZWlDRHNvSVRyaTZ6dGxhQWc3SWlZSU95ZQ0KaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNCUFQwOGc3SVNjNjdtRTdJcWtJT3lpaGV1ampDRHNsWWpyZ3JRZzRvQ1VJREF3N0p1VUlEQXc3SjI4NjdhQTdZU3dJT3lFbk91NWhPeUtwT3F3Z0NEc29vWHJvNHpyajd6c21wUXVJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWVFnN0pXTTY2Q2s2NU9jNjZDazdKcVVMZzBLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZzBLRFFycmk2Z3NJQ29xN0tPODZyaXc3S0NCN0p5ODY2R2NJT3lpaGV1ampPcXdnQ0Ryc0pqcnM3WHJrSmpyaXBRZzdLQ2M3WktJS2lyc2w1RHJpcFFnSit5aWhldWpqT3VQdk95YWxDZnJwYndnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURzb29Ycm80enJqN3pzbXBRZzRvYVNJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxBMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKZVENCjZyS01JT3V2dU95NW1PdUtsQ0RzbUlIdGxxWHNuWVFnN0pXTTY2Q2s3S1NFSU91VmpBMEtEUW9vN0tPODdKcVVJT3VQbWV5Q3JDQTZJT3lYc095eXRDd2c3WlcwN0tlQUxDRHNvSUhzbXFrZzY1T3hLUTBLRFFyc2lKanJqNW50bUpYc25MenJvWndnN0pPdzY2bTBJT3lkdU9xenZDRHF0SURxczRUcnBid2c2NnFGN1ptVjdaV1k2cktNSU95RXBPdXFoZTJWbU9xem9Dd2dKK3lDck95YXFleWVrT3lkbUNEdGxvbnJqNW5zbDVBZzY1U3c2NTI4N0ppazY0cVVJT3F5c09xenZDZnJuYnpyaXBRZzdLQ1E3SjJFSU95VmpPdWdwT3lraENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95WXBPdUttT3E1ak95bmdDRHJnclRzcDRBZzdKV0s3Snk4NjZtMElPeVhzT3l5dE91UHZPeWFsQzRnN1p1RTY3YUk2ckt3N0tDY0lPcTRpT3lWb2V5ZGhDRHJnclRzbzd6c2hManNtcFF1RFFvdElPdU1nT3kybk95ZGhDRHFzSWpzbFlUdGc0RHJxYlFnN0p1UTY1NllJT3VNZ095Mm5PeWR0Q0R0bGJUc3A0RHJqN3pzDQptcFF1SU95WXBPdUttQ0RyZ3FEc3A1enF1WXpzcDREc25aZ2c3SjIwN0o2UTY2VzhJT3lkZ08yV2lleVhrQ0RyZ3JUc2xid2c3WlcwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UUlPeVZpT3lMckNBbzdJaVk2NCtaN1ppVktRMEtEUW9uN0tDVjY3TzBJT3lJbU95bmtTRHNsWWpyZ3JRbklPdVRzZXlkbUNEcnI3enFzSkR0bFp3ZzdJT0I3Wm1wN0plUTdJU2NJQ29xN0l1YzdJcWs3WVdjN0oyMElPeWVrT3VQbWV5Y3ZPdWhuQ0Rzc3BqcnBxenRsWnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc3SWlZNjQrWjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeWR0T3lnbk91MmdPMkVzQ0R0bVkzcXVManJqNW5yaTVqc25aZ2c2ckNjN0oyNDdLQ1Y2N08wSU95ZHRPeWFxU0RyZ3JUc2w2M3NuYlFnNnJpdzY2R2Q2NCs4N0pxVURRb3RJT3VObENEc29vdnNuWUFnN0lPQjY0dTA3SjJFSU95Yw0KaE8yVnRDRHRoclh0bVpRZzY0SzA3SnFwN0oyQUlPdUZ1ZXlkak91UHZPeWFsQTBLRFFvakl5RHNtSWpzbWJnZ01pNGc2cks5N0phMDY2VzhJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3RFFvTkN1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKMllJT3VucGV1ZHZleWRoQ0R0bVp6c21xbnRsYlRzaEp3ZzdLZUk2Nnk0N1pXZ0lPdVZqQTBLRFFvbjdJdWM2NEtZN0pxVVB5Y3NJQ2ZzaGFqcmdwanNtcFEvSnlEdG1KWHRnNXpzblpnZzZySzk3SmEwNjZXOElPMlpuT3lhcWUyVnRPeUVuQ0RzZ3F6c21xbnNucERzblpnZzY0dTU3Wm1wN0lxazY1K3M3SnVBN0oyRUlPeWtoT3lkdkNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1Dd2cNClQwOVBJT3VMcE91RmdPeVlwT3lGcU91Q21PeWFsRDhOQ2kwZzdMYXA3S0NFN1pXWTY1K3NJTzJPdU95ZG1PeWdrQ0Rxc0lEc2k1enJncGpzbXBRL0RRb05DaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SU9CN1ptcDdKMkVJT3kybE95Z2xlMlZvQ0RybFl3TkNnMEs2NnFGN1ptVjdaV2NJT3lnbGV1enRPcXdnQ0RzbDRic2xyVHNoSndnN0lLczdKcXA3SjZRN0plUTZyS01JT3luZ2V5Z2tTRHRqSkRyaTZqdGxaanFzb3dnN1pXMDdKVzhJTzJWb0NEcmxZd2c2cks5N0phMDY2R2NJT3lnbGV5a2tlMlZtT3F5akNEc3A0anJyTGp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzY3Q2I3Snk4N0lXbzY0S1k3SnFVUHlEcms3SHJvWjN0bFpqcnFiUWc3THFRN0l1YzY3Q3hJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla095ZG1DRHNoS0RzblpqcXNJQWc3WldFN0pxVTdaV2dJT3VWakEwS0RRcnNoS1RyDQpyTGpzb2JEc2dxenNzcGpybjd3ZzdJS3M3SnFwN0o2UTdKMllJT3lFb095ZG1PdWx2Q0RxdUxEcmpJRHRsYlRzbGJ3ZzdaV2dJT3VWakNEcXNyM3NsclRyb1p3ZzdLQ1Y3S1NSN1pXWTZyS01JT3luaU91c3VPMlZ0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNuYlRyc29nZzY0dXM3SmVRSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxaanJxYlRzaEp3ZzdKYTg2NmVJNjRLWUlPdW5qT3loc2UyVm1PeUZxT3VDbU95YWxEOE5DZzBLSXlNZzdKaUk3Sm00SURNdUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPdVFtT3VLbENEcXNyM3NtckFOQ2cwSzdJS3M3SnFwN0o2UTdKZVE2cktNSU91cWhlMlpsZTJWbU9xeWpDRHJ0b0Rzb0pYc29JSHNuYmdnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3lrbU95VnZDRHRsYUFnNjVXTTY0cVVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3lpaSt5VmhPeWFsQzROQ2cwS0l5TWpJT3lFbk91NWhPeUtwT3VsdkNEc29KWHNzWVhzZzRFZw0KN0pPNElPeUltQ0RzbDRic25ZUWc2NVdNRFFvTkN1dTJnT3lnbGUyWWxleWN2T3VobkNEc2phanNsYndnN0lLczdKcXA3SjZRN0plUTZyS01JT3lEZ2UyWnFleWRoQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN0l1YzdZS3NJT3lJbUNEc25vanNsclRzbXBRdUlDb3E3Sk80SU95SW1DRHNsNGJyaXBRZzdKMjA3SnlnNjZXOElPMlZxT3E3bUNEc2xZanJnclR0bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RzcDREcXVJanNuWUFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJT3l5cmV5R2pPdUZoT3lkaENEc25JVHRsWndnN0lTYzY3bUU3SXFrNjRxVUlPeVZoT3luZ1NEc3BJRHJ1WVFnN0tTUjdKMjA3SmVRN0pxVUxnMEtMU0RxczdYcnJMVHNtNURzbllBZzdadUU3SnVRNnJpSTdKMkVJT3V6dE91Q3ZDRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzY3YUE3S0NWN1ppVjdKeTgNCjY2R2NJT3lOcU95VnZDRHNncXpzbXFuc25wRHFzSUFnN0phMDY1YWtJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3lYaHV1S2xPeW5nQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95RW9PMkRuZXlkbUNEcXNyRHFzN3pycGJ3ZzdKV0k2NEswN1pXZ0lPdVZqQTBLRFFycmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHNoS0R0ZzUzc25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyVm1PcXlqQ0RzbFl6cm9LVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdaV2NJT3V5DQppQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPdTJnT3lnbGUyWWxTa05DZzBLSit5Z2xldXp0Q0RzaUpqc3A1RWc3SldJNjRLMEp5RHJrN0hzblpnZzY2Kzg2ckNRN1pXY0lPeURnZTJacWV5WGtPeUVuQ0FxS3V5Z2xldXp0T3F3Z0NEcnM3VHRtTGpya0p6cmk2VHJpcFFnN0tDUUtpcnNuWVFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lEZ2V1THRPeWR0Q0RyZ1ozcmdwanJxYlFnN0tDRTY2eTQ2ckNBNjQrRUlPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1RycGJ3ZzY3TzhJT3lJbUNEc2w0YnNsclRzbXBRdURRb3RJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHNvSlhyczdUcXNJQWc2cml3NjZHZDY1Q1k3S2VBSU95Vg0KaXV5VmhPeWFsQzROQ2cwS0l5TWc3SmlJN0ptNElEUXVJT3lnbk8yU2lDRHNtcW5zbHJUcmlwUWc2N0NVNnI2NDdLZUFJT3lWaXVxNHNBMEtEUW9uNnJDRTZyS3c3WldZNnJPZ0lPeUpyT3lhdENEcnA1QW5JT3lia095NW1ldXp0T3VMcENBcUt1MlpsT3VwdE95ZG1DRHF1TERyaXFYcnFvWEN0K3V5aE8yS3ZPdXFoZXF6dk95ZG1DRHNtcW5zbHJRZzdKMjg3TG1ZS2lycXNJQWc3SnF3N0lTZzdKMjA3SmVRN0pxVUxnMEs2cml3NjRxbDY2cUY3SmVRSU95VHNPeWR1Q0RyaTZqc2xyUW82N09BNnJLOUxDRHNwNERzb0pVc0lPdVRzZXVoblNEcms3RXA2Nlc4SU95VmlPdUN0Q0RyckxqcXRhenNsNURzaEp3ZzY0dWs2Nlc0SU91bmtPdWhuQ0Ryc0pUcXZyanJxYlFnN0lLczdKcXA3SjZRNnJDQUlPdUxwT3VsdUNEcXVMRHJpcVhzbkx6cm9ad2c3SmlrN1pXMDdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrZ0orcTJqTzJWbkNEcnM0RHFzcjBuSU9xNHNPdUtwZXlkbUNEc2xZanJnclFnNjZ5NDZyV3MNCkRRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N0NVNnIrQUlPeUltQ0Rzbm9qc2xyVHNtcFFnS0ZncERRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N09BNnJLOTdaV2dJT3lJbUNEc25vanNsclRzbXBRZ0tFOHBEUW9OQ2lNaklPeVlpT3ladUNBMUxpRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F3ZzdKT3c3S2VBSU95Vml1cTRzQTBLRFFycnJManF0YXpycGJ3ZzdKV0U2NnkwNjZhc0lPdW5wT3VCaE91ZnZlcXlqQ0RyaTZUcms2enNsclRyajRRZ0tpcnNpNlRzb0p3ZzdJdWM3SXFrN1lXY0lPdVBtZXlla2VxenZDRHJpNlRycGJnZzY0K1o3SUtzS2lycnBid2c3Sk93NjZtMElPeWVtT3VxdSt1UW5DRHJyTGpxdGF6c21JanNtcFF1RFFvTkN1eVlpQ2tnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3llDQprT3VsdkNBbjdMYVU2ckNBSU95bmdPeWdsU2Z0bFpqcmlwUWc3SXVjN0lxazdZV2M3SmVRN0lTY0lDanNuYlRzb0lUQ3QreVdrZXVQaENEcXVMRHJpcVhzbmJRZzdKV0U2NHVZS1EwS0xTRHJpNlRycGJnZzdJS3M2NTZNN0plUTZyS01JT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERycGJ3ZzY0U1k2cktvN0tPODdJUzQ3SnFVSUNoWUlPS0FsQ0RzbDRicmlwUWdKK3VFbU9xNHNPcTRzQ2NnNnJpdzY0cWw3SjJFSU95VmxPeUxuQ2tOQ2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZ0Q0Rzbzd6c2hManNtcFFnS0U4cERRbz0NCjo6TEFVTkNIRVI6Og0KLy80bkFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCQ0FISUFhUUJrQUdjQVpRQWdBR3dBWVFCMUFHNEFZd0JvQUdVQWNnQWdBQlFnSUFEb3NzU3N4THdnQUNUQkZjZ2dBQkRJZ0t3Z0FNVFdJQURrc3F5NUlBRGt3b25WQ2dBbkFDQUFZd0JzQUdFQWRRQmtBR1VBWWdCeUFHa0FaQUJuQUdVQU9nQXZBQzhBSUFBRTFWeTRvTkZjejNUSElBQjB4eUFBRE5OOHgwVEhJQUNBdlhpNTVMSWdBQ2dBOGJSZHVEb0FJQUJ1QUhBQWJRQWdBR2tBYmdCekFIUUFZUUJzQUd3QUlBQVF0cFN5SUFBaUFIVFFYTGpjdENBQTVNNGxzVERSSWdBZ0FDVEJXTTRnQUF6VGZNY3BBQzRBQ2dBbkFDQUFWTHNBckNBQVlMNDR5Q0FBaU1jOHgzUzZJQUJjMVNBQWlMelF4U0FBV05XWXNDbkZJQUJJeGJTd1dOWGdyQ3dBSUFEa3NpQUFBTWxFdmhpMGRMb2dBT1N5ckxsOHVTQUFQY3dnQU1iRmRNY2dBT1RDaWRWYzFlU3lMZ0FLQUZNQVpRQjBBQ0FBWmdCekFHOEFJQUE5QUNBQVF3QnlBR1VBWVFCMEFHVUFUd0JpQUdvQVpRQmpBSFFBS0FBaUFGTUENCll3QnlBR2tBY0FCMEFHa0FiZ0JuQUM0QVJnQnBBR3dBWlFCVEFIa0Fjd0IwQUdVQWJRQlBBR0lBYWdCbEFHTUFkQUFpQUNrQUNnQlRBR1VBZEFBZ0FITUFhQUFnQUQwQUlBQkRBSElBWlFCaEFIUUFaUUJQQUdJQWFnQmxBR01BZEFBb0FDSUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGTUFhQUJsQUd3QWJBQWlBQ2tBQ2dCa0FHa0FjZ0FnQUQwQUlBQm1BSE1BYndBdUFFY0FaUUIwQUZBQVlRQnlBR1VBYmdCMEFFWUFid0JzQUdRQVpRQnlBRTRBWVFCdEFHVUFLQUJYQUZNQVl3QnlBR2tBY0FCMEFDNEFVd0JqQUhJQWFRQndBSFFBUmdCMUFHd0FiQUJPQUdFQWJRQmxBQ2tBQ2dCekFHZ0FMZ0JEQUhVQWNnQnlBR1VBYmdCMEFFUUFhUUJ5QUdVQVl3QjBBRzhBY2dCNUFDQUFQUUFnQUdRQWFRQnlBQW9BQ2dBbkFDQUFNUUF2QURJQUtRQWdBRTRBYndCa0FHVUFMZ0JxQUhNQUlBQVF5SUNzSUFBVUlDQUF4c1U4eDNTNklBRGtzclRHWExqY3RDQUFtTk4weDhESmZMa2dBUFRGdE1VQXllU3lDZ0JKQUdZQUlBQnpBR2dBDQpMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQUlBQjNBR2dBWlFCeUFHVUFJQUJ1QUc4QVpBQmxBQ0lBTEFBZ0FEQUFMQUFnQUZRQWNnQjFBR1VBS1FBZ0FEd0FQZ0FnQURBQUlBQlVBR2dBWlFCdUFBb0FJQUFnQUVrQVpnQWdBRTBBY3dCbkFFSUFid0I0QUNnQUlnQk9BRzhBWkFCbEFDNEFhZ0J6QUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aTRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdCYkFGWFdlTWRkQUVUSElBQUVzblM1ZExvZ0FPU3l0TVpjdU55MElBQ1kwM1RId01rQXJDQUE5TVc5dWNpeTVMSXVBQ0FBSk1GWXpueTVJQURJdVZ6T0lBQ2t0Q3dBSUFBTTFleTMrSzE0eDlERkhNRWdBSFRRWExqY3RDQUFoTHk4MGtUSElBRGtzdHpDSUFBTXN1eTNJQUQ4eURqQmxNWXVBQ0lBTEFBZ0FGOEFDZ0FnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQQ0KSUFCMkFHSUFUd0JMQUVNQVlRQnVBR01BWlFCc0FDQUFLd0FnQUhZQVlnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURFQUx3QXlBQ2tBSUFBVUlDQUFUZ0J2QUdRQVpRQXVBR29BY3dBaUFDa0FJQUE5QUNBQWRnQmlBRThBU3dBZ0FGUUFhQUJsQUc0QUNnQWdBQ0FBSUFBZ0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCb0FIUUFkQUJ3QUhNQU9nQXZBQzhBYmdCdkFHUUFaUUJxQUhNQUxnQnZBSElBWndBdkFHc0Fid0F2QUdRQWJ3QjNBRzRBYkFCdkFHRUFaQUFpQUFvQUlBQWdBRVVBYmdCa0FDQUFTUUJtQUFvQUlBQWdBRmNBVXdCakFISUFhUUJ3QUhRQUxnQlJBSFVBYVFCMEFBb0FSUUJ1QUdRQUlBQkpBR1lBQ2dBS0FDY0FJQUF5QUM4QU1nQXBBQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDQUFFTWlBckNBQUZDQWdBTWJGUE1kMHVpQUFKTUZZenJjQVhMajRyWGpISUFBcHZKVzhSTWNnQUVqRnRMQmMxZVN5Q2dCSkFHWUENCklBQnpBR2dBTGdCU0FIVUFiZ0FvQUNJQVl3QnRBR1FBSUFBdkFHTUFJQUIzQUdnQVpRQnlBR1VBSUFCakFHd0FZUUIxQUdRQVpRQWlBQ3dBSUFBd0FDd0FJQUJVQUhJQWRRQmxBQ2tBSUFBOEFENEFJQUF3QUNBQVZBQm9BR1VBYmdBS0FDQUFJQUJOQUhNQVp3QkNBRzhBZUFBZ0FDSUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aUFBS0FBUXRwU3lJQUJRQUVFQVZBQklBTkRGSUFER3hiVEZsTVlwQUM0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0F3MGZpN0VMSFF4UnpCSUFCRXhaaTNmTGtnQUNUQldNNjNBRnk0K0sxNHgxelZJQUNrdEN3QUlBQjAwRnk0M0xRZ0FJUzh2TkpFeHlBQTVMTGN3aUFBRExMc3R5QUEvTWc0d1pUR09nQWlBQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBDQpKZ0FnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWlBQ0FBSUFCdUFIQUFiUUFnQUdrQWJnQnpBSFFBWVFCc0FHd0FJQUF0QUdjQUlBQkFBR0VBYmdCMEFHZ0FjZ0J2QUhBQWFRQmpBQzBBWVFCcEFDOEFZd0JzQUdFQWRRQmtBR1VBTFFCakFHOEFaQUJsQUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFJQUFnQUdNQWJBQmhBSFVBWkFCbEFDQUFiQUJ2QUdjQWFRQnVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQVZkWjR4eUFBS2J5VnZEb0FJQUF3MGZpN0VMSFF4UnpCSUFCakFHd0FZUUIxQUdRQVpRQWdBQzBBTFFCMkFHVUFjZ0J6QUdrQWJ3QnVBQ0FBZE1jZ0FJUzhCTWhFeHlBQW5NMGx1RmpWZExvZ0FBREpSTDRnQUVUR3pMaUZ4OGl5NUxJdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQQ0KWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFLQUNzd0tuR3liZEF4eUFBZE1jZ0FGQUFRd0RReFNBQVhMajRyWGpISExRZ0FIVFFYTGpjdENBQWJLM0ZzeUFBWE5YRXM5REZITUVnQUNqTUVLd3B0TWl5NUxJdUFDa0FJZ0FzQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBSFlBWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BRElBTHdBeUFDa0FJQUFVSUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0lBQ2dBZ0FDQUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGRUFkUUJwQUhRQUNnQkZBRzRBWkFBZ0FFa0FaZ0FLQUFvQUp3QWdBQURKUkw0Z0FFVEd6TGdnQUJRZ0lBRGtzcXk1ZkxrZ0FEM01JQURHeFhUSElBRGt3b25WSUFBb0FBelY3TGY0clhqSGRNY2dBT2VzSUFDUXg5bXpJQUFRck1ESktRQUtBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQmpBRzBBWkFBZ0FDOEFZd0FnQUc0QWJ3QmtBR1VBSUFCekFHTUENCmNnQnBBSEFBZEFCekFGd0FZd0JzQUdFQWRRQmtBR1VBTFFCaUFISUFhUUJrQUdjQVpRQXVBR29BY3dBaUFDd0FJQUF3QUN3QUlBQkdBR0VBYkFCekFHVUFDZ0E9DQo6OldBVENIRVI6Og0KTHk4ZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzRvQ1VJTzJWcmV5RGdTRHJscUFnN0o2STY0cVVJT3kwaU95R2pPMllsU0RzaEp6cnNvUWdLR3h2WTJGc2FHOXpkRG94TVRnNE9Ta05DaTh2SU9LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBMEtMeThnN0ptY0lPMlZoT3lhbE8yVm5PcXdnRG9nN1pTODZyZTQ2NmVJNnJDQUlPMlVqT3Vmck9xM3VPeWR1T3lkbUNCamJHRjFaR1ZpY21sa1oyVTZMeThnN0plMDZyaXdLSGRwYm1SdmR5NXZjR1Z1TDJsbWNtRnRaUzl2Y0dWdVJYaDBaWEp1WVd3cDY2VzgNCkRRb3ZMeURzb0lUcnRvQWc3SWFNNjZhc0lPeVhodXlkdENEcnA0bnJpcFFnNjdLRTdLQ0U3SjIwSU95ZWlPdUxwQzRnWm1WMFkyanJpcFFnNjZxN0lPdW5pZXljdk91dmdPdWhuQ3dnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKRHNpNXpzbnBEc2w1RHFzb3dOQ2k4dklGQlBVMVFnTDNkaGEyVWc2Nlc4SU91enRPdUN0T3VwdENEcXNKRHNpNXpzbnBEcXNJQWc2NHVrNjZhc0tHTnNZWFZrWlMxaWNtbGtaMlV1YW5NcDY2VzhJT3VNZ095TG9DRHN2S0RyaTZRdURRb3ZMdzBLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQTBLTHk4ZzY2bVU2NnFvNjZhc0lINHhOVTFDNjUyOElPdWhuT3EzdU95ZHVDRHNpNXdnN0o2UTY0K1pJT3lMbk95ZWtleWN2T3VoDQpuQ0RzZzRIc2k1d2c3THljNjVHczY0K0VJT3UyZ091THRDRHNsNGJyaTZRZ0tPdVRzZXVoblRvZ2JuQnRJSEoxYmlCaWRXbHNaQ2t1RFFvdkx5RHJpNlRycHF6cmlwUWc3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTRzT3VwdENEc283M3NwNERycDR3bzdaU002NStzNnJlNDdKMjQ2ck84SU95RG5leUNyQ0RyajVucXVMRHRtWlFwTENEcXNKRHNpNXpzbnBEcmlwUWc2ck9FN0lhTklPdUNxT3lWaENEcmk2VHNuWXdnNnJtbzdKcXc2cml3NjZXOElPdXdtK3VLbE91THBDNE5DZzBLWTI5dWMzUWdhSFIwY0NBOUlISmxjWFZwY21Vb0oyaDBkSEFuS1RzTkNtTnZibk4wSUhCaGRHZ2dQU0J5WlhGMWFYSmxLQ2R3WVhSb0p5azdEUXBqYjI1emRDQm1jeUE5SUhKbGNYVnBjbVVvSjJaekp5azdEUXBqYjI1emRDQnZjeUE5SUhKbGNYVnBjbVVvSjI5ekp5azdEUXBqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNOQ2cwS1kyOXVjM1FnVUU5Uw0KVkNBOUlERXhPRGc1T3cwS1kyOXVjM1FnVWs5UFZDQTlJSEJoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNjdUxpY3BPeUF2THlEc29JRHNucVhzaG93ZzY2T283WXE0SU9LQWxDRHJpNlRycHF6cXNJQWdjbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrNjZXOElPeXd2dXVLbENEcXVMRHNwSUFOQ2cwS1kyOXVjM1FnUTA5U1UxOUlSVUZFUlZKVElEMGdldzBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUM0pwWjJsdUp6b2dKeW9uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFNHVmhaR1Z5Y3ljNklDZERiMjUwWlc1MExWUjVjR1VuTEEwS2ZUc05DbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3MEtJQ0J5WlhNdWQzSnBkR1ZJWldGa0tITjBZWFIxY3l3Z1QySnFaV04wTG1GemMybG5iaWg3SUNkRGIyNTANClpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2dZMmhoY25ObGREMTFkR1l0T0NjZ2ZTd2dRMDlTVTE5SVJVRkVSVkpUS1NrN0RRb2dJSEpsY3k1bGJtUW9TbE5QVGk1emRISnBibWRwWm5rb2IySnFLU2s3RFFwOURRb05DaTh2SUdOc1lYVmtaU0JEVEVucXNJQWc3SjZJNjRxVTdLZUFJT0tBbENEc2w0YnNuTHpycWJRZ0wzZGhhMlVnN0oyUjY0dTE3SmVRSU95THBPeVd0Q0R0bEl6cm42enF0N2pzbmJqc25iUWc3SldJNjRLMDdaV2dJT3lJbUNEc25vanFzb3dnN1pXYzY0dWtEUW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPeWR2ZXE0c0NEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpJQ2pyaTZUcnBxenNuWmdnWTJ4aGRXUmxRV05qYjNWdWRPeVpnQ0Rxc0puc25ZQWc3TGFjN0xLWUtTNE5DaTh2SU8yTWpPeWR2T3lkdENEdGdiUWc3SWlZSU95ZWlPeVd0Q0F6DQpNT3kwaUNEc3VwRHNpNXd1SU95ZXJPdWhuT3EzdU95ZHVPMlZtT3VwdENCRFRFbnFzSUFnN1l5TTdKMjg3SjJFSU9xd3NleUxvTzJWbU91dmdPdWhuQ0RzbnBEcmo1a2c2N0NZN0ppQjY1Q2M2NHVrTGcwS0x5OGc3THFRN0l1Y0lEWHN0SWdnNG9DVUlPdWhuT3EzdU95ZHVDRHNwNEh0bTRRZzdJT0lJT3F6aE95Z2xleWR0Q0RxczZmcnNKVHJvWndnN0o2aDdaaUE3Slc4SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA3SmVRN0lTY0lPMlppT3ljdk91aG5DRHJoSmpzbHJUcXNJVHJpNlFvTXpEc3RJanJxYlFnNjRTSTY2eTBJT3VLcHV5ZGpDa05DbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93MEtablZ1WTNScGIyNGdZMnhoZFdSbFFXTmpiM1Z1ZENncElIc05DaUFnYVdZZ0tFUmhkR1V1Ym05M0tDa2dMU0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQQ0ExTURBd0tTQnlaWFIxY200Z1lXTmpiM1Z1ZEVOaFkyaGxMbVZ0WVdscw0KT3cwS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJR29nUFNCS1UwOU9MbkJoY25ObEtHWnpMbkpsWVdSR2FXeGxVM2x1WXlod1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuTG1Oc1lYVmtaUzVxYzI5dUp5a3NJQ2QxZEdZNEp5a3BPdzBLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJvWnpxdDdqc25iZ2c3SjIwNjZDbElPeVhodXlkakNEcms3RWc0b0NVSUc1MWJHd2dLaThnZlEwS0lDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUJFWVhSbExtNXZkeWdwTENCbGJXRnBiQ0I5T3cwS0lDQnlaWFIxY200Z1pXMWhhV3c3RFFwOURRb05DbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzTkNpQWdZMjl1YzNRZ1ptbHVaR1Z5SUQwZ2NISnZZMlZ6Y3k1d2JHRjANClptOXliU0E5UFQwZ0ozZHBiak15SnlBL0lDZDNhR1Z5WlNjZ09pQW5kMmhwWTJnbk93MEtJQ0IwY25rZ2V5QnlaWFIxY200Z2MzQmhkMjVUZVc1aktHWnBibVJsY2l3Z1d5ZGpiR0YxWkdVblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY3NJSE5vWld4c09pQjBjblZsSUgwcExuTjBZWFIxY3lBOVBUMGdNRHNnZlNCallYUmphQ0FvWDJVcElIc2djbVYwZFhKdUlHWmhiSE5sT3lCOURRcDlEUW9OQ214bGRDQjNZV3RwYm1jZ1BTQm1ZV3h6WlRzZ0x5OGc3SmV3N1lPQUlPdXdxZXluZ0NEaWdKUWc2NHVrNjZhczY0cVVJT3lXdE95d3FPMlV2Q0JGUVVSRVVrbE9WVk5GNjZHY0lPeWtrZXV6dFNEc29KWHJwcXp0bFpqc3A0RHJwNHdnN1pTRTY2R2M3SVM0N0lxa0lPdUNyZXU1aE91bHZDRHNwSVRzbmJqcmk2UU5DbVoxYm1OMGFXOXVJSGRoYTJWQ2NtbGtaMlVvS1NCN0RRb2dJR2xtSUNoM1lXdHBibWNwSUhKbGRIVnlianNOQ2lBZ2QyRnJhVzVuSUQwZ2RISjFaVHNOQ2lBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5DQpQaUI3SUhkaGEybHVaeUE5SUdaaGJITmxPeUI5TENBMU1EQXdLVHNOQ2lBZ2JHVjBJSEJ5YjJNN0RRb2dJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdEUW9nSUNBZ0x5OGdWMmx1Wkc5M2N6b2dZMjFrd3JkMlluTWc2cks5N0p5Z0lPeVhodXlkdENCdWIyUmw2Nlc4SU95bmdleWdrU3dnZDJsdVpHOTNjMGhwWkdVb1ExSkZRVlJGWDA1UFgxZEpUa1JQVnlucm9ad2c3SXFrN1krd0lPS0FsQTBLSUNBZ0lDOHZJT3l3dlNEc2w0YnJpcFFnN0lpbzdKMkFJT3k5bU95R2xPeWR0Q0RycDR6cms2VHNsclRzcDREcXM2QWc2NHVrNjZhczdKMllJT3lla095TG5TaGpiR0YxWkdVcDY0K0VJT3EzdUNEc3ZaanNocFRzbllRZzY2eTg2NkNrNjdDYjdKV0VJT3lXdE91V3BDRHNzTDNyajRRZzdKV0lJT3Vjck91THBDNE5DaUFnSUNBdkx5QmtaWFJoWTJobFpPdUtsQ0RzazdEc3A0QWc3SldLNjRxVTY0dWtLR1JsZEdGamFHVmtLM2RwYm1SdmQzTklhV1JsSU95aHNPMlZxZXlkZ0NEcw0Kdlpqc2hwUWc3TEM5N0oyMElPdUZ1T3kybk91UXFDRGlnSlFnN0l1azdMaWhLUzROQ2lBZ0lDQXZMeUJYYVc1a2IzZHo3SmVRN0lTZ0lHUmxkR0ZqYUdWa0lPeVhodXlkdE91UGhDRHJ0b0RycXFnbzZyQ1E3SXVjN0o2UUtlcXdnQ0Rzbzczc2xyVHJqNFFnN0o2UTdJdWQ3SjJBSU95Q3RPeVZoT3VDcU91S2xPdUxwQzROQ2lBZ0lDQndjbTlqSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3RFFvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzRFFvZ0lDQWdmU2s3RFFvZ0lIMGdaV3h6WlNCN0RRb2dJQ0FnTHk4Z2JXRmpUMU12NjZhczY0aUY3SXFrT2lEcXNKRHNpNXpzbnBEcnBid2c2NTJFN0pxMElHNXZaR1VnN0l1azdaYUpJTzJNak95ZHZPdWhuQ0RzcDRIc29KRWc3SXFrN1krd0lDaHNZWFZ1WTJoa0lPMloNCm1PcXl2ZXlYbENCUVFWUkk2ckNBSU91NWlPeVZ2ZTJWb0NEc2lKZ2c3SjZJN0phMElPeWdpT3VNZ09xeXZldWhuQ0RzZ3F6c21xa3BEUW9nSUNBZ2NISnZZeUE5SUhOd1lYZHVLSEJ5YjJObGMzTXVaWGhsWTFCaGRHZ3NJRnR3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBblkyeGhkV1JsTFdKeWFXUm5aUzVxY3ljcFhTd2dldzBLSUNBZ0lDQWdZM2RrT2lCU1QwOVVMQ0JrWlhSaFkyaGxaRG9nZEhKMVpTd2djM1JrYVc4NklDZHBaMjV2Y21VbkxBMEtJQ0FnSUgwcE93MEtJQ0I5RFFvZ0lIQnliMk11ZFc1eVpXWW9LVHNnTHk4ZzZyQ1E3SXVjN0o2UUlPeWR0T3V5cE8yS3VDRHJvNmp0bElUc2w1RHNoSndnNjdhRTY2YXNJQ2pxc0pEc2k1enNucEFnN0tLRjY2T002Nlc4SU91bmlleW5nQ0RzbFlycXNvd3BEUXA5RFFvTkNpOHZJT3lkdENCUVErdWx2Q0FuN0lTazdMbVlJT3lnaENqc2c0Z2dVRU1wSnlEc2c0SHRnNXpyb1p3ZzY1Q1k2NCtNNjZhdzY0dWtJT0tBbENEdGxJenJuNnpxdDdqc25iZ2dXK3kwDQppT3E0c08yWmxGMGc2N0tFN1lxOEtGQlBVMVFnTDNWdWFXNXpkR0ZzYkNuc25iUWc2N2FBNjZXNDY0dWtMZzBLTHk4Z2NtVm5hWE4wWlhJdGNISnZkRzlqYjJ3dWFuUHFzSUFnN0lTazdMbVk3WldjSU9xeWcreWRoQ0RxdDdqcmpJRHJvWndnNjVDWTY0K002NmF3NjR1a09pRHFzSkRzaTV6c25wQWc3SjZRNjQrWjdJdWM3SjZSSUNzZ0tPeWVpT3ljdk91cHRDa2c3SVNrN0xtWUlPMlB0T3VObEM0TkNpOHZJT0thb08rNGp5RHJzSmpyazV6c2k1d2dTRlJVVUNEc25aSHJpN1hzbllRZzY2aTg3S0NBSU91enRPdUN1Q0Rya3FRZzdaaTQ3TGFjN1pXZ0lPcXlneURpZ0pRZ2JXRmpUMU1nYkdGMWJtTm9ZM1JzSUdKdmIzUnZkWFRzbmJRZzdKMjBJTzJVaE91aG5PeUV1T3lLcE91bHZDRHNwb25zaTV3ZzdLS0Y2Nk9NN0l1YzdZS3NJT3lJbUNEc25vanJpNlF1RFFvdkx5QWdJQ0RxdDdqcm5wanNoSndnN1l5TTdKMjhLSEJzYVhOMHdyZnNoS1RzdVpnZzdZKzA2NDJVS2V5ZGhDQnNZWFZ1WTJoamRHenJzN1RyaTZRZw0KNjZpODdLQ0FJT3luZ095YXRPdUxwQ0RpZ0pRZ1ltOXZkRzkxZE95ZHRDRHNtckRycHF6cnBid2c3S085N0plczY0K0VJT3lla091UG1leUxuT3lla2V5ZGdDRHNuYlRycjdnZzdJS3M2NTI4N0tlRTY0dWtMZzBLWm5WdVkzUnBiMjRnZFc1cGJuTjBZV3hzVTJWc1ppZ3BJSHNOQ2lBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUZ0ZE93MEtJQ0IwY25rZ2V3MEtJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXcwS0lDQWdJQ0FnWTI5dWMzUWdURUZDUlV3Z1BTQW5ZMjl0TG1Oc1lYVmtaV0p5YVdSblpTNTNZWFJqYUdWeUp6c05DaUFnSUNBZ0lHTnZibk4wSUhCc2FYTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua25MQ0FuVEdGMWJtTm9RV2RsYm5Sekp5d2dURUZDUlV3Z0t5QW5MbkJzYVhOMEp5azdEUW9nSUNBZ0lDQmpiMjV6ZENCcGJuTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua24NCkxDQW5RWEJ3YkdsallYUnBiMjRnVTNWd2NHOXlkQ2NzSUNkRGJHRjFaR1ZDY21sa1oyVW5LVHNOQ2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktIQnNhWE4wS1NrZ2V5Qm1jeTUxYm14cGJtdFRlVzVqS0hCc2FYTjBLVHNnY21WdGIzWmxaQzV3ZFhOb0tIQnNhWE4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLR2x1YzNRcEtTQjdJR1p6TG5KdFUzbHVZeWhwYm5OMExDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTd2dabTl5WTJVNklIUnlkV1VnZlNrN0lISmxiVzkyWldRdWNIVnphQ2hwYm5OMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DaUFnSUNBZ0lIUnllU0I3SUhOd1lYZHVVM2x1WXlnbmJHRjFibU5vWTNSc0p5d2dXeWRpYjI5MGIzVjBKeXdnSjJkMWFTOG5JQ3NnY0hKdlkyVnpjeTVuWlhSMWFXUW9LU0FySUNjdkp5QXJJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3DQpJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0Nkc1lYVnVZMmhqZEd3bkxDQmJKM0psYlc5MlpTY3NJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXcwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5WldjbkxDQmJKMlJsYkdWMFpTY3NJQ2RJUzBOVlhGeFRiMlowZDJGeVpWeGNUV2xqY205emIyWjBYRnhYYVc1a2IzZHpYRnhEZFhKeVpXNTBWbVZ5YzJsdmJseGNVblZ1Snl3Z0p5OTJKeXdnSjBOc1lYVmtaVUp5YVdSblpWZGhkR05vWlhJbkxDQW5MMlluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNnbjdKNlE2NCtaN0l1YzdKNlJLRU5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWElwSnlrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwSw0KSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KMk5zWVhWa1pXSnlhV1JuWlRvdkx5RHJrN0hyb1owbktUc2dmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnSUNCMGNua2dldzBLSUNBZ0lDQWdJQ0JqYjI1emRDQnBibk4wSUQwZ2NHRjBhQzVxYjJsdUtIQnliMk5sYzNNdVpXNTJMa3hQUTBGTVFWQlFSRUZVUVNCOGZDQndZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBblFYQndSR0YwWVNjc0lDZE1iMk5oYkNjcExDQW5RMnhoZFdSbFFuSnBaR2RsSnlrN0RRb2dJQ0FnSUNBZ0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWcNCmZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlEwS0lDQWdJQ0FnZlNCallYUmphQ0FvWDJVcElIdDlEUW9nSUNBZ2ZRMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUJtWVdsc0xYTnZablFnNG9DVUlPdXF1eURzcDREc21yUWc2cktNSU95ZWlPeVd0T3VQaENEdGxJenJuNnpxdDdqc25iZ2c3S3E5SU9xNHNPeVd0U0RzZ3Ezc29KenJpcFFnN0oyMDY2KzRJT3VCbmV1Q3JPdUxwQ0FxTHlCOURRb2dJSEpsZEhWeWJpQnlaVzF2ZG1Wa093MEtmUTBLRFFvdkx5RHJpNlRycHF3b01URTRPRGdwNnJDQUlPdVdvQ0Rzbm9qc25MenJxYlFnNjRHSTY0dWtJT0tBbENEc3RJanF1TER0bVpRZzdJdWNJT3VDcU95ZGdDRHNoTGpzaFpnZzdLQ1Y2NmFzSUNqc2w0YnNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeUxwTzJNcUNrTkNtWjFibU4wYVc5dUlITm9kWFJrYjNkdVFuSnBaR2RsS0NrZ2V3MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJSElnUFNCb2RIUndMbkpsY1hWbGMzUW9leUJvYjNOME9pQW5NVEkzDQpMakF1TUM0eEp5d2djRzl5ZERvZ01URTRPRGdzSUhCaGRHZzZJQ2N2YzJoMWRHUnZkMjRuTENCdFpYUm9iMlE2SUNkUVQxTlVKeXdnZEdsdFpXOTFkRG9nTVRVd01DQjlMQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3ZlNrN0RRb2dJQ0FnY2k1dmJpZ25kR2x0Wlc5MWRDY3NJQ2dwSUQwK0lIc2dkSEo1SUhzZ2NpNWtaWE4wY205NUtDazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZTQjlLVHNOQ2lBZ0lDQnlMbVZ1WkNncE93MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DbjBOQ2cwS1kyOXVjM1FnYzJWeWRtVnlJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvS0hKbGNTd2djbVZ6S1NBOVBpQjdEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIME5DaUFnYVdZZ0tISmxjUzUxY213Z1BUMDlJQ2N2YUdWaA0KYkhSb0p5a2dldzBLSUNBZ0lDOHZJSFk2SU9xd2tPeUxuT3lla0NEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENEcXRhenJzb1Rzb0lRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU9xemhPeUdqU0RyajR6cXM2QWc3SjZJNjRxVTdLZUFJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsWmpyaXBRZzdKcXA2NCtFRFFvZ0lDQWdMeThnS0hZeUlEMGc3TEM5SU95SXFPcTVnQ0RzaUpqc29KWHRqSkFzSUhZeklEMGdMMkZqWTI5MWJuUWc3TGFVNnJDQTdZeVFMQ0IyTkNBOUlDOTFibWx1YzNSaGJHd2c3TGFVNnJDQTdZeVFLUTBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCM1lYUmphR1Z5T2lCMGNuVmxMQ0IyT2lBMElIMHBPdzBLSUNCOURRb2dJQzh2SU95ZHRDQlFRK3lYa0NEcm9aenF0N2pzbmJqcmtKd2c3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRGlnSlFnN1pTTTY1K3M2cmU0N0oyNElPeXlxeUR0bVpUcnFiVEN0KzJaaU95ZHRDQWk2NGlFNnJXc0lPcXpoT3lnbGV5Y3ZPdWgNCm5DRHNrN0RyaXBUc3A0QWlJT3V6dE95WHJPeWp2T3VLbENEcmpiQWc3Sk8wNjR1a0xnMEtJQ0F2THlEcXNKRHNpNXpzbnBEcXNJQWc2NHUxN1pXWTY0cVVJT3lkdE95Y29Eb2c2NHVrNjZhczY2VzhJT3k4bk91cHRDRHNtNHpyc0kzc2w0WHNuTHpyb1p3ZzdZRzA2NkdjNjVPYzZyQ0FJT3lMcE95Z25DRHRtTGpzdHB6cmo3d2c2cldzNjQrRklPeUNyT3lhcWV1ZmlleWR0Q0RyZ3BqcXNJVHJpNlF1RFFvZ0lDOHZJT3F3a095TG5PeWVrT3VLbENEdGpJenNuYnpycDR3ZzdKMjk3Snk4NjYrQTY2R2NJT3lDck95YXFldWZpU0F3SU1LM0lPdU1nT3E0c0NBd0lPS0FsQ0Rxc29EdGhxRHJwNHdnN0pPdzY0cVVJT3lDck91ZWpPeVhrT3F5akNEcnVZVHNtcW5zbllRZzY2eTg2NmFzN0tlQUlPeVZpdXVLbE91THBDNE5DaUFnTHk4ZzdLTzg3SjJZT2lEc2w2enF1TEFnNnJPRTdLQ1Y3SjIwSU91enRPeVhyT3VQaENEc25vWHNucVhxdG96c25iUWc2NmVNNjZPTTY1Q1E3SjJFSU95SW1DRHNub2pyaTZRbzdKeWc3WnFvDQo3SVN4N0oyQUlPeUxwT3lnbkNEdG1ManN0cHdnNjVXTTY2ZU1JT3lWakNEc2lKZ2c3SjZJN0oyTUlPS0FsQ0RyaTZUcnBxd2dMMmhsWVd4MGFPeWRtQ0J3Y205aWJHVnRJT3l3dU9xem9Da3VEUW9nSUdsbUlDaHlaWEV1ZFhKc0lEMDlQU0FuTDJGalkyOTFiblFuS1NCN0RRb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJR0ZqWTI5MWJuUTZJR05zWVhWa1pVRmpZMjkxYm5Rb0tTd2dZMnhoZFdSbE9pQm9ZWE5EYkdGMVpHVW9LU0I5S1RzTkNpQWdmUTBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZDJGclpTY3BJSHNOQ2lBZ0lDQnBaaUFvSVdoaGMwTnNZWFZrWlNncEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1WnljZ2ZTazdEUW9nSUNBZ2QyRnJaVUp5YVdSblpTZ3BPdzBLSUNBZ0lISmxkSFZ5YmlCcQ0KYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0IzWVd0cGJtYzZJSFJ5ZFdVZ2ZTazdEUW9nSUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dldzBLSUNBZ0lHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdEUW9nSUNBZ2NtVjBkWEp1T3cwS0lDQjlEUW9nSUM4dklPeTBpT3E0c08yWmxDRGlnSlFnN0oyMElGQkQ2Nlc4SUNmc2c0Z2dVRU1uSU95RGdlMkRuT3VobkNEcmtKanJqNHpycHJEcmk2UWdLTzJVak91ZnJPcTN1T3lkdUNCYjdMU0k2cml3N1ptVVhTRHJzb1R0aXJ3cExnMEtJQ0F2THlEc25aSHJpN1hzbllRZzY2aTg3S0NBSU8yZG1PdWdwT3V6dE91Q3VDRHJrcVFnN0tDVjY2YXM3WldjNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc3BvbnMNCmk1d2c3S085N0plczY0K0VJTzJhak95TG9PeWRnQ0RyajRUc3NLbnRsWnpyaTZRdURRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OTFibWx1YzNSaGJHd25LU0I3RFFvZ0lDQWdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2djR3hoZEdadmNtMDZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdmU2s3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdEUW9nSUNBZ0lDQnphSFYwWkc5M2JrSnlhV1JuWlNncE93MEtJQ0FnSUNBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUhWdWFXNXpkR0ZzYkZObGJHWW9LVHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYmQyRjBZMmhsY2wwZzdMU0k2cml3N1ptVUtIVnVhVzV6ZEdGc2JDa2c0b0NVSU95Z25PcXhzRG9uTENCeVpXMXZkbVZrTG1wdmFXNG9KeXdnSnlrZ2ZId2dKeWpzbDRic25Zd3BKeWs3RFFvZ0lDQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSEJ5YjJObGMzTXVaWGhwDQpkQ2d3S1N3Z01qQXdLVHNOQ2lBZ0lDQjlMQ0F5TlRBcE93MEtJQ0FnSUhKbGRIVnlianNOQ2lBZ2ZRMEtJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TkN3Z2V5Qmxjbkp2Y2pvZ0owNXZkQ0JtYjNWdVpDY2dmU2s3RFFwOUtUc05DZzBLTHk4ZzdKMjA2Nis0SU91V29DRHNub2pzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lpaGV1ampDQW83SjZRNjQrWklPeUxuT3lla1NBcklHNXdiU0JpZFdsc1pDRHNwSkhyczdVZzdJdWs3WmFKSU91TWdPdTVoQ2tOQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXcwS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3cwS0lDQndjbTlqWlhOekxtVjRhWFFvTVNrN0RRcDlLVHNOQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc05DaUFnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHRnYlRyb1p6cms1d2c2NHVrNjZhcw0KSU9xd2tPeUxuT3lla0NEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93MEtmU2s3RFFvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJQ2RzYjJOaGJHaHZjM1FuNnJDQUlEbzZNZXVobkNEcnFMenNvSUFnN1pXMDdJU2Q2NUNZNjRxVUlPMlptT3F5dmV5WGtPeUVuQTBLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlFbFFkalRyb1p3ZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDRHJpNlRycHF3ZzZybW83SnF3NnJpd3dyZnFzNFRzb0pVZzdLR3c3WnFNNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJqWmdnNjZ5NDdLQ2NJT3VNZ095ZGtTanJpNlRycHF6c21ZQWc2NCtaN0oyOEtTNE5DbU52Ym5OMElITmxjblpsY2pZZ1BTQm9kSFJ3TG1OeVpXRjBaVk5sY25abGNpaHpaWEoyWlhJdWJHbHpkR1Z1WlhKektDZHlaWEYxWlhOMEp5bGJNRjBwT3cwS2MyVnlkbVZ5Tmk1dmJpZ24NClpYSnliM0luTENBb0tTQTlQaUI3ZlNrN0lDOHZJRG82TWV5ZGhDRHJxcnNnN0o2aDdKV0U2NCtFS0VWQlJFUlNTVTVWVTBYQ3QwbFFkallnN0plRzdKMk1LU0JKVUhZMDY2ZU03Snk4NjZHY0lPcXpoT3lHalNEcmo1bnNucEVOQ25ObGNuWmxjall1YkdsemRHVnVLRkJQVWxRc0lDYzZPakVuS1RzTkNnPT0NCjo6V1NJTEVOVDo6DQpKeUJEYkdGMVpHVWdRbkpwWkdkbElIZGhkR05vWlhJZ2MybHNaVzUwSUd4aGRXNWphR1Z5SUNodWJ5QjNhVzVrYjNjcElDMGdjbVZuYVhOMFpYSmxaQ0IwYnlCeWRXNGdZWFFnYkc5bmFXNEtVMlYwSUdaemJ5QTlJRU55WldGMFpVOWlhbVZqZENnaVUyTnlhWEIwYVc1bkxrWnBiR1ZUZVhOMFpXMVBZbXBsWTNRaUtRcFRaWFFnYzJnZ1BTQkRjbVZoZEdWUFltcGxZM1FvSWxkVFkzSnBjSFF1VTJobGJHd2lLUXBrYVhJZ1BTQm1jMjh1UjJWMFVHRnlaVzUwUm05c1pHVnlUbUZ0WlNoWFUyTnlhWEIwTGxOamNtbHdkRVoxYkd4T1lXMWxLUXB6YUM1RGRYSnlaVzUwUkdseVpXTjBiM0o1SUQwZ1pHbHlDbk5vTGxKMWJpQWlZMjFrSUM5aklHNXZaR1VnYzJOeWFYQjBjMXhpY21sa1oyVXRkMkYwWTJobGNpNXFjeUlzSURBc0lFWmhiSE5sQ2c9PQ0KOjpFTkQ6Og0K";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAAB19Y2IG0sCABtLAgAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBMEtMeThnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQURRb3ZMeURzZ3F6c21xbnJzcFU2SU8yUGlleURnZXlMbk95WGxDRHFzSkRzaTV6c25wRHFzSUFnN0o2UTY0K1o3Snk4NjZHY0lPeThvT3VMcENBbzdJaVk2NCtaSU95TG5PeWVrZXlkZ0NCdWNHMGdjblZ1SUdKeWFXUm5aU2tOQ2k4dklPeThuT3VSa091cHRDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1creTJsT3l5bk91d20rcTRzRjNxc0lBZ1IyVnRhVzVwSU8yQ3BDRHNsNGJzbmJUcmo0UWc3WUcwNjZHYzY1T2M2NkdjSUVGSklPeTJsT3l5bk95ZGhDRHJzSnZyaXBUcmk2UXVEUW92THcwS0x5OGc3SWFONjQrRUlPeUVwT3F6aERvZzdZRzA2NkdjNjVPYzY2VzhJT3lhbE95eXJldW5pT3VMcENEc2c0anJvWndnN0l1YzY0K1o3WldZNjZtMElETXdmalF3N0xTSTZyQ0FJT3EzdU91RHBTRHJncURzbFlUcXNJVHJpNlF1RFFvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0RRb3ZMeUFnSU9xd2dPeWR0T3VUbkN2c21JanNpNXdvTVRFeDZyRzBLZXVLbENEc3Nxc2c2Nm1VN0l1YzdLZUE2NkdjSU8yVm5DRHJzb2pycDR3ZzdKMjk3WjZNNjR1a0xpRHNuYlR0bTRRZzdKcVU3TEt0N0oyQUlPdXN1T3Exck91bmpDRHJzN1RyZ3JUcnI0RHJvWndnNjdtZzY2VzA2NHVrTGcwS0x5OGc3SVM0N0lXWTdKMkFJRE13NjdLSUlPeVRzT3VwdENEc25xenNpNXpzbnBIdGxiUWc2NHlBN1ptVTZyQ0FJT3VzdE8yVm5PMmVpQ0RxdUxqc2xyVHNwNERyaXBRZzZyS0Q3SjJFSU91bmlldUtsT3VMcEM0TkNpOHZEUW92THlEc29JVHNvSnc2SU95ZHRDQlFRK3lYa0NCRGJHRjFaR1VnUTI5a1plcXdnQ0RzaEtUc3VaakN0K3Vobk9xM3VPeWR1T3VQdkNEc25vanNuWVFnNnJLRElDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dUlPeWN2T3VobkNEdG1aWHNuYmdwRFFvdkx5RHNvN3pzblpnNklPeUNyT3lhcWV1ZmlleWRnQ0Rxc0lIc25wQWc3WUcwNjZHYzY1T2NJT3Exck91UGhTRHRsWnpyajRUc2w1RHNoSndnN0xDbzZyQ1E2NUNjNjR1a0xnMEtEUXBqYjI1emRDQm9kSFJ3SUQwZ2NtVnhkV2x5WlNnbmFIUjBjQ2NwT3cwS1kyOXVjM1FnWm5NZ1BTQnlaWEYxYVhKbEtDZG1jeWNwT3cwS1kyOXVjM1FnYjNNZ1BTQnlaWEYxYVhKbEtDZHZjeWNwT3cwS1kyOXVjM1FnY0dGMGFDQTlJSEpsY1hWcGNtVW9KM0JoZEdnbktUc05DbU52Ym5OMElIc2djM0JoZDI0c0lITndZWGR1VTNsdVl5QjlJRDBnY21WeGRXbHlaU2duWTJocGJHUmZjSEp2WTJWemN5Y3BPdzBLRFFvdkx5RHRnYlRyb1p6cms1enJwYndnNjdtSUlPMlB0T3VObE95WGtPeUVuQ0RzaTZUdGxva2c0b0NVSU95Z2dPeWVwZXlHak95WGtPeUVuQ0RzaTZUdGxvbnRsWmpycWJRZzdaU0U2NkdjN0tDZDdZcTRJT3VucGV1ZHZTaERURUZWUkVVdWJXUWc2NU94S2V5ZGhBMEtMeThnNjZla0lPMkV0Q0RzcDRyc2xyVHNvTGpzaEp3Z05EWHN0SWd2N1lTMDZybU03S2VBSU91S2tPdWdwT3luaE91THBDQW82N21JSU8yUHRPdU5sQ0FySU91MmdPcXdnT3E0c091S3BTRHNzS2pyaTZqc25iVHJxYlFnZmpQc3RJZ3Y3WVMwS1M0TkNtTnZibk4wSUVWTlVGUlpYME5YUkNBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRZM2RrSnlrN0RRcDBjbmtnZXlCbWN5NXRhMlJwY2xONWJtTW9SVTFRVkZsZlExZEVMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU0I5S1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIME5DbU52Ym5OMElFTk1RVlZFUlY5RlRsWWdQU0JQWW1wbFkzUXVZWE56YVdkdUtIdDlMQ0J3Y205alpYTnpMbVZ1ZGl3Z2V3MEtJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcERRb2dJRU5NUVZWRVJWOURUMFJGWDBSSlUwRkNURVZmVGs5T1JWTlRSVTVVU1VGTVgxUlNRVVpHU1VNNklDY3hKeXdnTHk4ZzdZUzBJT3lhbE95VnZTRHJrN0VnNjdhQTZyQ0FJTzJZdU95Mm5DRHJnWlFOQ2lBZ1JFbFRRVUpNUlY5VVJVeEZUVVZVVWxrNklDY3hKeXdOQ24wcE93MEtEUW92THlEc2lLanF1WUFnN0l1azdaYUpLT3F3a095TG5PeWVrQ0RzaXFUdGo3RHNuWUFnYzNSa2FXOGdhV2R1YjNKbEtleVhrT3lFbk91UGhDRHJyTGpzb0p6cnBid2c3TGFVN0tDQjdaV2dJT3lJbUNEc25vanFzb3dnN0wyWTdJYVVJT3Vobk9xM3VPdWx2Q0R0akl6c25ienNsNURyajRRZzY0S282cmkwNjR1a0xnMEtMeThnN0p5RTdMbVlPaURzbm9Uc2k1d2c3WSswNjQyVTdKMllJR05zWVhWa1pTMWljbWxrWjJVdWJHOW5JQ2pzbklqcmo0VHNtckFnSlZSRlRWQWxMQ0RycDZVZ0pGUk5VRVJKVWlrdUlESk5RaURyaEpqc25MenJxYlFnTG05c1pPdWhuQ0R0bFp3ZzdJUzQ2NHlBNjZlTUlPdXp0T3EwZ0M0TkNtTnZibk4wSUV4UFIxOUdTVXhGSUQwZ2NHRjBhQzVxYjJsdUtHOXpMblJ0Y0dScGNpZ3BMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTNXNiMmNuS1RzTkNtTnZibk4wSUY5dmNtbG5URzluSUQwZ1kyOXVjMjlzWlM1c2IyY3VZbWx1WkNoamIyNXpiMnhsS1RzTkNtTnZibk52YkdVdWJHOW5JRDBnWm5WdVkzUnBiMjRnS0NrZ2V3MEtJQ0JqYjI1emRDQmhjbWR6SUQwZ1FYSnlZWGt1Y0hKdmRHOTBlWEJsTG5Oc2FXTmxMbU5oYkd3b1lYSm5kVzFsYm5SektUc05DaUFnWDI5eWFXZE1iMmN1WVhCd2JIa29iblZzYkN3Z1lYSm5jeWs3RFFvZ0lIUnllU0I3RFFvZ0lDQWdkSEo1SUhzTkNpQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0V4UFIxOUdTVXhGS1NBbUppQm1jeTV6ZEdGMFUzbHVZeWhNVDBkZlJrbE1SU2t1YzJsNlpTQStJRElnS2lBeE1ESTBJQ29nTVRBeU5Da2dabk11Y21WdVlXMWxVM2x1WXloTVQwZGZSa2xNUlN3Z1RFOUhYMFpKVEVVZ0t5QW5MbTlzWkNjcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU8yYWpPeWdoQ0RzaTZUdGpLanJpcFFnNjZ5MDdJdWNJQ292SUgwTkNpQWdJQ0JqYjI1emRDQnNhVzVsSUQwZ0oxc25JQ3NnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZOMGNtbHVaeWduYTI4dFMxSW5LU0FySUNkZElDY2dLdzBLSUNBZ0lDQWdZWEpuY3k1dFlYQW9LR0VwSUQwK0lDaDBlWEJsYjJZZ1lTQTlQVDBnSjNOMGNtbHVaeWNnUHlCaElEb2dTbE5QVGk1emRISnBibWRwWm5rb1lTa3BLUzVxYjJsdUtDY2dKeWtnS3lBblhHNG5PdzBLSUNBZ0lHWnpMbUZ3Y0dWdVpFWnBiR1ZUZVc1aktFeFBSMTlHU1V4RkxDQnNhVzVsS1RzTkNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3WXlNN0oyOElPdWhuT3EzdUNEc2k2VHRqS2p0bGJUcmo0UWc2NHVrNjZhczY0cVVJT3F6aE95R2pTQXFMeUI5RFFwOU93MEtEUXBqYjI1emRDQlFUMUpVSUQwZ1RuVnRZbVZ5S0hCeWIyTmxjM011Wlc1MkxrSlNTVVJIUlY5UVQxSlVLU0I4ZkNBeE1UZzRPRHNnTHk4Z1FsSkpSRWRGWDFCUFVsVHJpcFFnN1lXTTdJcWs3WXE0N0pxcElDanRqNG5zaG96c2w1UWdNVEU0T0RnZzZyT2c3S0NWS1EwS0x5OGc2NHVrNjZhc0lPeTlsT3VUbkNEcnNvVHNvSVFnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaV2M2NHVrTGlEc3ZaVHJrNXpycGJ3Z2NIVnNiTUszNjdPMTdJS3M3WlcwNjQrRUlDb3E3SjIwNjYrNElPdVdvQ0Rzbm9qcmlwUWc2NHVrNjZhczY0cVVJT3lZbXlEc3ZaVHJrNXdnNnJlNDY0eUE2NkdjS2lycm5id05DaTh2SU9xN2tPdUxwQ0Rzdkp6cXVMQWc3S0NFN0plVUlPeURpQ0RyajVuc25wSHNuYlFnN0pXSUlPdUNtT3lZcU91THBDanRoTERycjdqcmhKRHNuYlFnNjV5bzY0cVVJT3VUc1NrdUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEc25iUWc2ckNTN0p5ODY2R2NJT3Exck91eWhPeWdoT3lkaENEcXNKRHNwNER0bGJRZzdKNnM3SXVjN0o2UjdJdWM3WUtvNjR1a0xnMEtMeThnNjQrWjdKNlI3SjIwSU91d2xPdUFqT3VLbENEc2lKanNvSlhzbllRZzdaV1k2Nm0wSU95ZHRDRHNpS3ZzbnBEcnBid2c3SmlzNjZhczZyT2dJR052WkdVdWRIUHNuWmdnUWxKSlJFZEZYMDFKVGw5VzY0K0VJT3F3bWV5ZHRDRHNtS3pycHJEcmk2UXVEUXBqYjI1emRDQkNVa2xFUjBWZlZpQTlJREkxT3cwS0x5OGc2cml3NjdPNElPdXFxT3VOdUM0ZzdKcVU3TEt0S08yVWpPdWZyT3EzdU95ZHVDbnNuYlFnYlc5a1pXenNuWVFnN0tlQTdLQ1Y3WldZNjZtMElPcTN1Q0RzbXBUc3NxM3JwNHdnNnJlNElPdXFxT3VOdU91aG5DRHNzcGpycHF6dGxaenJpNlF1RFFvdkx5Qm9ZV2xyZFQzcnVhRHJwb1F2NnJDQTY3Szg3SnVBTENCemIyNXVaWFE5N0tTUjZyQ0VMQ0J2Y0hWelBlcTRzT3V6dUNqc3RaenFzNkR0a29qc3A0Z3NJT3loc09xNGlDRHJpcERycHJ3cERRcGpiMjV6ZENCRFRFRlZSRVZmVFU5RVJVd2dQU0J3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVFU5RVJVd2dmSHdnSjI5d2RYTW5PdzBLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdEUXBqYjI1emRDQlVWVkpPWDFSSlRVVlBWVlJmVFZNZ1BTQTVNREF3TURzZ0lDQXZMeURzbXBUc3NxMGdNZXF4dENEc29KenRsWnpzaTV6cXNJUU5DbU52Ym5OMElFMUJXRjlVVlZKT1V5QTlJRE13T3lBZ0lDQWdJQ0FnSUNBZ0lDOHZJT3lkdE91bmpPMkJ2Q0RzazdEcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTQW82NHlBN1ptVUlPdUloT3lnZ1NEcnNLbnNwNEFwRFFvTkNpOHZJT0tVZ09LVWdDRHNtSWpzaTV3ZzdJS3M3S0NFSU91aG5PdVRuQ0FvY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xa0lPS0FsQ0JpZFdsc1pDMW5iRzl6YzJGeWVTNXFjK3laZ0NEcXNKbnNuWUFnN1l5TTdJU2NLU0RpbElEaWxJQU5DbVoxYm1OMGFXOXVJR3h2WVdSRmVHRnRjR3hsY3lncElIc05DaUFnZEhKNUlIc05DaUFnSUNCamIyNXpkQ0J0WkNBOUlHWnpMbkpsWVdSR2FXeGxVM2x1WXlod1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5MaTRuTENBbmNtVmpiMjF0Wlc1a0xXVjRZVzF3YkdWekxtMWtKeWtzSUNkMWRHWTRKeWs3RFFvZ0lDQWdZMjl1YzNRZ2MyVmpTV1I0SUQwZ2JXUXVjMlZoY21Ob0tDOWVJeU1nN0xhVTdMS2NJT3lZaU95TG5GeHpLaVF2YlNrN0RRb2dJQ0FnYVdZZ0tITmxZMGxrZUNBOVBUMGdMVEVwSUhKbGRIVnliaUJiWFRzTkNpQWdJQ0JqYjI1emRDQmxlR0Z0Y0d4bGN5QTlJRnRkT3cwS0lDQWdJR3hsZENCamRYSWdQU0J1ZFd4c093MEtJQ0FnSUdadmNpQW9ZMjl1YzNRZ2NtRjNJRzltSUcxa0xuTnNhV05sS0hObFkwbGtlQ2t1YzNCc2FYUW9KMXh1SnlrcElIc05DaUFnSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0J5WVhjdWNtVndiR0ZqWlNndlhITXJKQzhzSUNjbktUc05DaUFnSUNBZ0lHTnZibk4wSUdnZ1BTQnNhVzVsTG0xaGRHTm9LQzllSXlNalhITXJLQzRyUHlsY2N5b2tMeWs3RFFvZ0lDQWdJQ0JwWmlBb2FDa2dleUJqZFhJZ1BTQjdJR2x1Y0hWME9pQm9XekZkTENCemRXZG5aWE4wYVc5dWN6b2dXMTBnZlRzZ1pYaGhiWEJzWlhNdWNIVnphQ2hqZFhJcE95QmpiMjUwYVc1MVpUc2dmUTBLSUNBZ0lDQWdZMjl1YzNRZ1lpQTlJR3hwYm1VdWJXRjBZMmdvTDE1Y2N5b3RYSE1yS0M0clB5bGNjeW9rTHlrN0RRb2dJQ0FnSUNCcFppQW9ZaUFtSmlCamRYSXBJR04xY2k1emRXZG5aWE4wYVc5dWN5NXdkWE5vS0dKYk1WMHVjM0JzYVhRb0p5QXZJQ2NwTG1wdmFXNG9KeUFuS1NrN0RRb2dJQ0FnZlEwS0lDQWdJSEpsZEhWeWJpQmxlR0Z0Y0d4bGN5NW1hV3gwWlhJb0tHVXBJRDArSUdVdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lENGdNQ2s3RFFvZ0lIMGdZMkYwWTJnZ0tHVXBJSHNOQ2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0ppSTdJdWNJT3lDck95Z2hDRHJvWnpyazV3ZzdJdWs3WXlvSUNqc2w0YnNuYlFnN0tlRTdaYUpLVG9uTENCbExtMWxjM05oWjJVcE93MEtJQ0FnSUhKbGRIVnliaUJiWFRzTkNpQWdmUTBLZlEwS0RRb3ZMeURpbElEaWxJQWc3S2VBN0l1YzY2eTRJQ2pzaEp6cnNvUWdjbVZqYjIxdFpXNWs3Sm1BSU9xd21leWRnQ0RxdDV6c3Vaa2c0b0NVSU91d2xPcSt1T3VwdENEcXQ3anNxcjNyajRRZzdaV282cnVZS1NEaWxJRGlsSUFOQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFRFFvdkx5RHNvN3dnN0o2RTY2eTA2NkdjSU95WXBPMlZ0TzJWdENBejZyQ2NJT3lnbk95VmlPeWR0Q0Rzb0lUcnRvQWdJdTJSbk9xNHNDRHFzNkRzdWFnZ0t5RHNsclRzaUp3ZzY3T0E2cks5SXV5ZHRDRHJrSnpyaTZRdUlPeVhyZTJWb0NEcnRvVHJwcXdnNG9DVURRb3ZMeUR0Z2JUcm9aenJrNXdnUFNEcnJManNucVVnNjR1azY1T3M2cml3S095d3ZleWRtQ2tzSU95YXFleVd0Q0R0aHJYc25iekN0K3VubnV5MnBPdXlsU0E5SUdOdlpHVXVkSE1nY21WbWFXNWxRV2xUZFdkblpYTjBhVzl1Y3lEdG00VHNzcGpycHF3bzZyaXc2ck9FN0tDQktTNE5DbU52Ym5OMElGTlVXVXhGWDFKVlRFVlRJRDBnV3cwS0lDQW5NUzRnN1pXMDdKcVU3TEswT2lEcnFxanJrNkFnNjZ5NDZyV3M2NHFVSU8yVnRPeWFsT3l5dE91aG5DNGdLT3V6dE91RGhldUxpT3VMcE9LR2t1dXp0T3VDdE95YWxDa25MQTBLSUNBbk1pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzRG9nNjVDUTdKYTA3SnFVNG9hUzdaYUk3SmEwN0pxVUxDQis3SmVJSU91NXZPcTRzQ2pyc0pUcmdJenNsNGpzbHJUc21wVGlocExyc0pUcXY2anNsclRzbXBRcExpRHJpNmdzSU95aWhldWpqTUszNjZlTTY2T013cmZzbDdEc3NyVEN0KzJWdE95bmdNSzM2cml3NjZHZHdyZnJoYm5zbll3ZzY1T3hJT3lMbk95S3BPMkZuT3lkdENEc283enNzclRzbmJnZzZyS3c2ck84NjRxVUlPeUltT3VQbWUyWWxTRHNuS0RzcDRBbzdKZXc3TEswNjQrODdKcVVMQ0RyaGJuc25ZenJqN3pzbXBRcExpY3NEUW9nSUNjekxpRHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdPaUFpZnUyVm9DRHNpSmdnN0plRzdKYTA3SnFVSWlEcmpJRHNpNkFnSW43dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFpSU9xMXJPeWhzQ0RzbXJEc2hLQXVJT3VMcUN3ZzdLQ1Y3TEdGN0lPQklPdTJpT3F3Z01LMzdKMjg2N2FBSU9xNHNPdUtwU0Rzb0p6dGxaekN0K3VRbU91UGpPdW10Q0RzaUpnZzdKZUc2NHFVSU9xeXNPcXp2TUszN0tDVjY3TzBJT3V6dE8yWXVDRHNsWWpzaTZ6c25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyZWlDNG5MQTBLSUNBbk5DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0RG9nZnUyVm1PeUxuT3F5b095V3RPeWFsRC9paHBKKzdaV2c2cm1NN0pxVVB5d2c2ck9FN0l1YzY0dWs0b2FTN0o2STY0dWtMQ0RzbDZ6c3JZanJpNlRpaHBMdG1aWHNuYmp0bFpqcmk2UXNJT3E3bU9LR2t1eVhrT3F5akM0Z2Z1eUxuQ0RydWJ6cXVMRHFzSUFnN0phMDdJT0o3WldZNjZtMElPMk1qT3lWaGUyVm1PdWdwT3VLbENEc29KWHJzN1RycGJ3ZzdLTzg3SmEwNjZHY0lPdXN1T3llcGV5ZGhDRHJpNlRzaTV3ZzdKTzA2NHVrTGljc0RRb2dJQ2MxTGlEcnFvWHNncXdyNjZxRjdJS3NJT3E0aU95bmdEb2c3WldjN0o2UTdKYTA2Nlc4SU8yU2dPeVd0Q0RyajVuc2dxenJvWndvN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBUaWhwTHNuYlRzbnBEcnBid2c2NCtNNjZDazY3Q2I3SldZN0phMDdKcVVLU3dnN0xXYzdJYU03WldjSUh2cnFvWHNncXg5NnJDQUlIdnJxb1hzZ3F4OTdaVzA3SVNjSU8yWWxlMkRuT3VobkNqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrdUp5d05DaUFnSnpZdUlPMlJuT3E0c0RvZzY1Q1k3SmEwN0pxVTRvYVM2NCs4N0pxVUxpY3NEUW9nSUNjM0xpRHNwSVFnNnJXczdLR3dPaURzbTVEcnM3anNuYlFnN1pXY0lPeWtoT3lkdE91cHRDRHN0cFRzc3B6cmo0UWc2N0NZNjVPYzdJdWNJTzJWbkNEc3BJVHJvWnd1SU95ZWhPeWRtT3VobkNEc3BJVHNuWVFnNjRxWTY2YXM3S2VBSU95Vml1dUtsT3VMcEM0ZzY0dW9MQ0RzbDZ6cm42d2c2Nnk0N0o2bDdKMkVJTzJWbU91Q21PeWRtQ0RxdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPMlZxZXl6a0NEcmpaUWc2ckNFNnJLdzdaVzA3S2VFNjR1azY2bTBJT3lraENEc2lKanJwYndnN0tTRTdKMjA2NHFVSU9xeWcreWRnQ0R0bVpqc21JRXVKeXdOQ2lBZ0p6Z3VJTzJNbmV5WGhTanJpNlRzbmJUc2xyenJvWnpxdDdncElPdXloTzJLdkRvZzZyS3c2ck84SU8yR3RldXp0T3VLbENCYjdabVY3SjI0WFN3ZzdKaUlMK3lWaE91TGlPeVlwQ0R0akpEcmk2anNuWUFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBzSU91UG1leWVrU0RzbktEcmo0VHJpcFFnVyt5M3FPeUdqRjB2VzN2cmo1bnNucEY5WFM0Z0l1eTNxT3lHakNMcmlwUWc2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNSU95VHNPcXpvQ0FpNjR1cjZyaXd3cmZyajVuc25wRWk3TEtZNjUrOElPeW5uU0RzbFlnZzY2ZWU2NHFVSU95aHNPMlZxY0szNjR1bzY0K0ZJQ0xzdDZqc2hvd2k2NHFVSU9xNGlPeW5nQzRuTEEwS0lDQW5PUzRnN0oyMDY2YUV3cmZzb0lUdG1aVHJzb2p0bUxqQ3QrdW5pT3lLcE8yQ3VleWRnQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzBMaURzZ3F6cm5venNuWVFnNjdhQTY2VzhJT3VWa0NEcmk1anNuWVFnNjdhWjdKZXM2NCtFSU95aWkrdUxwQzRuTEEwS0lDQW5NVEF1SU95Z25PMlNpQ0RzbXFuc2xyUWc3SnlnN0tlQU9pRHNub1hyb0tYc2w1QWc3Sk93N0oyNElPcTRzT3VLcGV5RXNTRHJxb1hzZ3F3bzY3T0E2cks5TENEc3A0RHNvSlVzSU91VHNldWhuU3dnN1pXMDdLQ2NJT3VUc1NucmlwUWc3Wm1VNjZtMDdKMllJT3E0c091S3BldXFoY0szNjdLRTdZcTg2NnFGN0oyOElPcXdnT3VLcGV5RXNleWR0Q0RyaHBMc25MenJyNERyb1p3ZzdJbXM3SnEwSU91bmtPdWhuQ0Ryc0pUcXZyanNwNEFnN0pXSzY0cVU2NHVrTGlEc2k1enNpcVR0aFp3ZzY0K1o3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXpycGJ3ZzdJT0k2NkdjSU91bmpPdVRwT3luZ0NEc2xZcnJpcFRyaTZRdUp5d05DbDB1YW05cGJpZ25YRzRuS1RzTkNnMEtZMjl1YzNRZ1JWaEJUVkJNUlZNZ1BTQnNiMkZrUlhoaGJYQnNaWE1vS1RzTkNnMEtMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBMEtMeThnVTFSWlRFVmZVbFZNUlZNZ01URHNwSVFnN0pxVTdKVzk2NmVNN0p5ODY2R2M2NHFVSU95WWlPeVp1Q0F4ZmpNbzdJaVk2NCtaN1ppVndyZnFzcjNzbHJUQ3QrdTJnT3lnbGUyWWxTRHRsNGpzbXFrZzdMeUE3SjIwN0lxa0tleWRtQ0RyaVpqc2xabnNpcVRxc0lBZzdKeWc3SXVrNjVDYzY0dWtMZzBLTHk4ZzdZeU03SjI4N0oyMElPeVhodXljdk91cHRDanNoS1RzdVpqcnM3Z2c2cldzNjdLRTdLQ0VJT3VUc1NrZzY3bUlJT3VzdU95ZWtPeVh0Q0RpZ0pRZzdKcVU3Slc5NjZlTTdKeTg2NkdjSU91UG1leWVrU2htWVdsc0xYTnZablFwTGcwS1puVnVZM1JwYjI0Z2JHOWhaRWQxYVdSbEtDa2dldzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZDFlQzEzY21sMGFXNW5MbTFrSnlrc0lDZDFkR1k0SnlrdWRISnBiU2dwT3cwS0lDQWdJSEpsZEhWeWJpQnRaQzVzWlc1bmRHZ2dQaUF4TURBZ1B5QnRaQ0E2SUNjbk93MEtJQ0I5SUdOaGRHTm9JQ2hsS1NCN0RRb2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUtwTzJEZ095ZHZDRHFzSURzbmJUcms1d2c2NkdjNjVPY0lPeUxwTzJNcUNBbzdKcVU3Slc5NjZlTTdKeTg2NkdjSU95bmhPMldpU2s2Snl3Z1pTNXRaWE56WVdkbEtUc05DaUFnSUNCeVpYUjFjbTRnSnljN0RRb2dJSDBOQ24wTkNtTnZibk4wSUVkVlNVUkZJRDBnYkc5aFpFZDFhV1JsS0NrN0RRb05DbVoxYm1OMGFXOXVJR2x1YzNSeWRXTjBhVzl1VFdWemMyRm5aU2dwSUhzTkNpQWdZMjl1YzNRZ1ptVjNVMmh2ZENBOUlFVllRVTFRVEVWVExtMWhjQ2dvWlhncElEMCtJQ2RKYm5CMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG1sdWNIVjBLU0FySUNkY2JrOTFkSEIxZERvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtHVjRMbk4xWjJkbGMzUnBiMjV6S1NrdWFtOXBiaWduWEc0bktUc05DaUFnY21WMGRYSnVJQ2dOQ2lBZ0lDQW43S2VBNnJpSTY3YUE3WVN3SU91RWlPdUtsQ0RzbDVEc2lxVHNtNUFvVXkweExDRHJzN1RzbFlqdG1venNncXdwN0oyWUlPMlZuT3ExcmV5V3RDQlZXQ0JYY21sMGFXNW5JT3lnaE91c3VPcXdnT3VobkNEc25ienRsWnpyaTZRdUlDY2dLdzBLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJEUW9nSUNBZ0oreWFsT3l5cmV1VHBPeWRnQ0RzaEp6cm9ad2c2NnkwNnJTQTdaV2NJT3V6aE9xd25DRHJyTGpxdGF6cmk2UWc0b0NVSU95ZHRPeWdoQ0RyckxqcXRhenJwYndnN0xDNDdLR3c3WldZN0tlQUlPdW5pT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDZnNtNURybnBnZzdKMlk2Nis0N0ptQUlPdXFxT3VUb0NEc29KWHJzN1FvN0oyMDY2YUV3cmZzaUt2c25wREN0K3loc09xeHRNSzM2NHlBN0lPQktldWx2Q0RzbktEc3A0RHRsWmpxczZBc0lPcXdnU0Rzb0p6c2xZanNuWUFnN0p1UTY3TzQ2ck84NjQrRUlPeUVuT3Vobk95WmdPdVBoQ0RyaTZ6cm5ienNsYndnN1pXYzY0dWtMaUFuSUNzTkNpQWdJQ0FuN0tHdzZyRzBJTzJSbk8yWWhDanNuYlRzZzRIQ3QreWR0TzJWbU1LMzdKMjA2NEswd3Jmc3RJanFzN3pDdCt1dnVPdW5qTUszNjdhQTdZU3d3cmZxdVl6c3A0QWc2NU94S2V5ZGdDRHNvSlhzc1lVZzdLQ1Y2N08wNjR1a0lPS0FsQ0RydWJ6cXNiRHJncGdnNjR1azY2VzRJT3loc09xeHRPeWN2T3VobkNEcnNKVHF2cmpzcDRBZzY2ZUk2NTI4S0NJMTdacU1JT3lkdE95RGdTTHNuWVFnSWpYdG1vd2k2NkdjSU95a2hPeWR0T3VwdENEc21LVHJpN1VwTGlBbklDc05DaUFnSUNBbjdKdVE2Nnk0N0plUUlPeVhodXVLbENEcXRhenNzclFnN0tDVjY3TzBLT3lnaE8yWmxPdXlpTzJZdU1LM1ZWSk13cmZxdUlqc2xhSEN0K3lMbk9xd2hDRHJrN0VwN0ptQUlPMlZ0T3F5c0NEcnNLbnJzcFhDdCt5Z2lPeXdxQ2pzbnF6c2hLVHNvSlhDdCt1c3VPeWRtT3l5bU1LMzdKNnM3SXVjNjQrRUlPdVRzU25ycGJ3ZzdLZUE3SmEwNjRLMElPdTJtZXlkdE91S2xDRHFzb1BzbllBZzdLQ0k2NHlBSU9xNGlPeW5nQ0RpZ0pRZzdKV0U2NHFVSU9xd2t1eWR0T3Vkdk91UGhDd2c2cmU0NjUrMDY1T3Y3WlcwNjQrRUlPeVRzT3luZ0NEcnA0anJuYnd1WEc0bklDc05DaUFnSUNBbk0rcXduQ0Rzb0p6c2xZanNuWUFnN0lTYzY2R2NJT3lna2VxM3ZPeWR0Q0RyaTZ6cm5ienNsYndnN1pXYzY0dWtJT0tBbENEdGxaanJncGpyaXBRZzdKdVE2Nnk0SU9xMXJPeWhzT3VsdkNEc25LRHNwNER0bFp3ZzdMV2M3SWFNSU91THBPdVRyT3E0c0N3ZzdaV1k2NEtZNjRxVUlPdXN1T3llcFNEcXRhenNvYkRycGJ3ZzdKNnM2cldzN0lTeDdaV2NJT3VNZ095VmlDd2dKeUFyRFFvZ0lDQWdKK3EzdU91bXJPcXpvQ0Rzb0lIc2xyVHJqNFFnN1pXWTY0S1k2NHFVSU9xenZPcXdrTzJWbkNEc25xenF0YXpzaExFNklPeWtrZXV6dFNEdGtaenRtSVRzbllRZzY0MmM3SmEwNjRLMDZyT2dMQ0Rzb0pYcnM3UWc3SWljN0lTYzY2VzhJT3lDck95YXFleWVrT3F3Z0NEc2xZenNsWVRzbGJ3ZzdaV2dJT3F5Zyt1MmdPMkVzT3VobkNEc25xenNvYkRzcDRIdGxhQWc2cktETGlBbklDc05DaUFnSUNBbjdKdVE2Nnk0N0oyMElPMlZ0T3F5c0NEcnNLbnJzcFhzbllRZzY0dTA2ck9nSU95ZWlPeWRoQ0RybFl6cnA0d2dJdXlXdE91V3UrcXlqQ0R0bFpqcnFiUWc2NHVrN0l1Y0lPdVFuT3VMcENMcnBid2c3SldlN0lTNDdKcXc2NHFVSU9xNGpleWdsZTJZbFNEc25xenF0YXpzaExIc25ZUWc3WldZNjUyOElPS0FsQ0RzbTVEcnJManNsNUFnN1pXMDZyS3c3TEdGN0oyMElPeVhodXljdk91cHRDRHJwNHpyazZUc2xyUWc2N2FaN0oyMDdLZUFJT3VuaU91ZHZDNGdKeUFyRFFvZ0lDQWdKKzJSbk9xNHNNSzM3SnFwN0phMDY2ZU1JT3F6b095NW1PcXpvQ0RzbHJUc2lKenNuWVFnNjdDVTZyNjhJT3lnbGV1UGhPeWRtQ0Rzb0p6c2xZanNuWVFnTStxd25DRHJpcGpzbHJUcmhwUHNwNEFnNjZlSTY1MjhJT0tBbENEcXQ3anFzYlFnN0lLczdKcXA3SjZRN0plUTZyS01JT3kybE95eW5PeWR0Q0RzbFlUcmk0anJuYndnNnJXUTdLQ1Y3Snk4NjZHY0lPdXp0T3lkdU91THBDNGdKeUFyRFFvZ0lDQWdKK3lWaE91ZW1DRHNtSWpzaTV6cms2VHNuWUFnN1pXY0lPeWtoT3lubk91bXJDRHN0WnpzaG93ZzZyV1E3S0NWN0oyMElPdW5qdXluZ091bmpDRHF0N2pxc2JRZzdZYWtLTzJWdE95YWxPeXl0TUszNnJLOTdKYTBLZXlkbUNEcXRaRHJzN2pzbmJUc3A0QWc3SWFNNnJlNTdJU3g3SjJZSU9xMWtPdXp1T3lkdENEc2xZVHJpNGpyaTZRZzRvQ1VJT3lYck91ZnJDRHJyTGpzbnFYc3A1enJwcXdnN0o2RjY2Q2w3SjJBSU91cGxPeUxuT3luZ0NEcmk2anNuSVRyb1p3ZzY0dWs3SXVjSU95RXBPcXpoTzJWbU91ZHZDNWNiaWNnS3cwS0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzY3Q3c3SmUwNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9YQ3QreTlsT3VUbk8yT25PeUtwQ0RxdUlqc3A0QTZYRzRuSUNzTkNpQWdJQ0FuVzNzaWRHVjRkQ0k2SUNMc29KenNsWWdnNjZ5NDZyV3NJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKeVpXRnpiMjRpT2lBaTY2eTA3SmVIN0oyRUlPeVpuQ0Ryc0pUcXY2anJpcFRzcDRBZzdaV2M2cld0N0phMElPMlZuQ0Ryckxqc25xVWlmU3dnTGk0dVhWeHVYRzRuSUNzTkNpQWdJQ0FuVyt5S3BPMkRnT3lkdkNEcXQ1enN1WmxkWEc0bklDc2dVMVJaVEVWZlVsVk1SVk1nS3lBblhHNWNiaWNnS3cwS0lDQWdJQ2hIVlVsRVJTQS9JQ2RiN0lxazdZT0E3SjI4SU9xd2dPeWR0T3VUbkNEc29JVHJyTGdnS0hWNExYZHlhWFJwYm1jdWJXUXBJT0tBbENEc25JUWc2cmVjN0xtWjdKMllJT3Ezdk9xeHNPeVpnQ0RzbUlqc21iZ2c3SXVjNjRLWTY2YXM3SmlrTGlEdGlybnRub2dnN0ppSTdKbTRJT3Ezbk95NW1TanNpSmpyajVudG1KWEN0K3F5dmV5V3RNSzM2N2FBN0tDVjdaaVY3SjJFSU95Y29PeW5nTzJWdE95VnZDRHRsWmpyaXBRZzdJT0I3Wm1wS2V5ZGhDRHF0N2pyaklEcm9ad2c2NVN3NjZXMDZyT2dMQ0RzbXBUc2xiM3FzN3dnN0tDRTY2eTQ3SjIwSU91THBPdWx0T3VwdENEc29JVHJyTGpzbllRZzY1U3c2Nlc0NjR1a1hWeHVKeUFySUVkVlNVUkZJQ3NnSjF4dVhHNG5JRG9nSnljcElDc05DaUFnSUNBb1ptVjNVMmh2ZENBL0lDZGI3SnF3NjZhc0lPdXFxZXlHak91bXJDRHNtSWpzaTV3ZzRvQ1VJT3lkdENEdGhxVHNuWVFnNjVTdzY2VzhJT3F5ZzExY2JpY2dLeUJtWlhkVGFHOTBJQ3NnSjF4dVhHNG5JRG9nSnljcElDc05DaUFnSUNBbjdLU0E2N21FNjVDUTdKeTg2Nm0wSUNKUFN5THJuYnpxczZEcnA0d2c2NHUxN1pXWTY1MjhMaWNOQ2lBZ0tUc05DbjBOQ2cwS0x5OGc0cFNBNHBTQUlPeURnZXlMbkNEcmpJRHF1TEFnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFOQ214bGRDQndjbTlqSUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQ0FnTHk4ZzdZRzA2NkdjNjVPY0lPMlVoT3Vobk95RXVPeUtwQTBLYkdWMElHeHBibVZDZFdZZ1BTQW5KenNnSUNBZ0lDQWdJQ0F2THlCemRHUnZkWFFnN0tTRUlPdXloTzJOdkEwS2JHVjBJSGRoYVhSbGNpQTlJRzUxYkd3N0lDQWdJQ0FnSUNBdkx5RHRtSVRzbnF3ZzdZUzA3SjJZSUhzZ2NtVnpiMngyWlN3Z2NtVnFaV04wTENCMGFXMWxjaUI5RFFwc1pYUWdjWFZsZFdVZ1BTQlFjbTl0YVhObExuSmxjMjlzZG1Vb0tUc2dMeThnN0pxVTdMS3RJT3luZ2V1Z3JPMlpsQ0FvNjQrWjdJdWNJT3lhbE95eXJleWRnQ0RzaUp6c2hKenJqSURyb1p3cERRcHNaWFFnZEhWeWJuTWdQU0F3T3cwS2JHVjBJSGRoY20xbFpGVndJRDBnWm1Gc2MyVTdEUXBzWlhRZ1kzVnljbVZ1ZEUxdlpHVnNJRDBnUTB4QlZVUkZYMDFQUkVWTU95QXZMeURzcDREcXVJZ2c3SVM0N0lXWTdKMjBJT3Vzdk9xem9DRHNub2pyaXBRZzY2cW82NDI0SUNqc21wVHNzcTNzbmJRZzY0dWs2Nlc0SU91cXFPdU51T3lkaENEc3A0RHNvSlh0bFpqcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTa05DaTh2SU95TG5PeWVrU0RzaTV3Z1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbElFTk1TU25xc0lBZzdKTzRJT3lJbUNEc25vanJpcFRzcDRBZzdLQ1E2cktBSU9LQWxDRHNsNGJzbkx6cnFiUWdMMmhsWVd4MGFPdWhuQ0RzbFl6cm9LUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeVZpT3VDdE8yVm5PdUxwQzROQ2k4dklHNTFiR3c5N1ptVjdKMjRJT3lra1N3Z0oyOXJKejNzZ3F6c21xa2c2ckNBNjRxbExDQW5ZMnhoZFdSbExXMXBjM05wYm1jblBXTnNZWFZrWlNEcnFvWHJvTGtnN0plRzdKMk1MQTBLTHk4Z0oyTnNZWFZrWlMxc2IyZHZkWFFuUFdOc1lYVmtaZXVLbENEc25vanNwNERycDR3ZzY2R2M2cmU0N0oyNElPeUV1T3lGbUNEcnA0enJvNHdnS08yRXRDRHNpNlR0aktnZzdJdWNJT3F3a095bmdDd2c3SVN4NnJPMUlPMkV0T3lkdENEc21LVHJxYlFnN0o2UTY0K1pJTzJWdE95Z25Da05DaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzbnF6cm9aenF0N2pzbmJqc25iUWc3SldFNjR1STY1MjhJTzJWbk91UGhDRHNuYmpzZzRIQ3QrcXpoT3lnbFNEc29JVHRtWmdwRFFwc1pYUWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ2JuVnNiRHNOQ2k4dklPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBSU9LQWxDQkRURW5xc0lBZzY0SzA2NHFVSU95WWdleVd0Q0RzbmJqc3BwMGc3SmlrNjZXWTY2VzhJT3lDck91ZWpPeWR0Q0RzbFl6c2xZVHJrNlRzbllRZzdKV0k2NEswNjZHY0lPdXdsT3Erdk91THBDNE5DaTh2SUNoamJHRjFaR1VnTFMxMlpYSnphVzl1N0oyQUlPdWhuT3EzdU95ZHVDRHNsNGJzbmJUcmo0UWc3SVN4NnJPMTdaVzA3SVNjSU95TG5PdVBtU0Rzb0pEcXNvRHNuTHpyb1p6cmlwUWc2NnE3SU95ZW9lcXpvQ3dnN0l1azdLQ2NJTzJFdE95WGtPeUVuT3VuakNEcms1enJuNnpyZ3B6cmk2UXBEUW92THlBaTY2ZU02Nk9NSXV1bmpPeWR0Q0RzbFlUcmk0anJuYndnSXUyVm5DRHJzb2pyajRRZzY2R2M2cmU0N0oyNElPeVZpQ0R0bGFnaTY0K0VJT3F3bWV5ZGdDRHFzcjNyb1p6cm9ad2c3SjZoN1o2STY2K0E2NkdjSU95a2tldW12U0R0a1p6dG1JVHNuWVFnN0pPMDY0dWtEUXBqYjI1emRDQk1UMGRKVGw5SFZVbEVSU0E5SUNmdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0oyNDdKMjBJTzJWaE95YWxPMlZ0T3lhbENqc2xZZ2c2NUNRNnJHdzY0S1lJT3Vuak91ampDa2c0b0NVSUZ2d241K2dJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNuYmdnN1pXRTdKcVVYU0Ryc29UdGlyenNuWVFnNjRpRTY2VzA2Nm0wSU91aG5PcTN1T3lkdUNEc3NMM3NuWVFnN0plMDdKYTA2NU9jNjZDazdKcVVMaWM3RFFvdkx5RHNpNlRzdUtIdGxad2c2Nnk0NnJXczY1T2tPaUFpUm1GcGJHVmtJSFJ2SUdGMWRHaGxiblJwWTJGMFpUb2dUMEYxZEdnZ2MyVnpjMmx2YmlCbGVIQnBjbVZrSUdGdVpDQmpiM1ZzWkNCdWIzUWdZbVVnY21WbWNtVnphR1ZrSWlqcnA0enJvNHdwTEEwS0x5OGdJazV2ZENCc2IyZG5aV1FnYVc0Z3dyY2dVR3hsWVhObElISjFiaUF2Ykc5bmFXNGlLT3V2dU91aG5PcTN1T3lkdUNrZzRvQ1VJT3VSbUNEcmk2UWc3SjZoN1o2STZyS01JT3VFaysyZWpPdUxwQTBLWm5WdVkzUnBiMjRnYVhOQmRYUm9SWEp5YjNJb2N5a2dldzBLSUNCeVpYUjFjbTRnTDJGMWRHaGxiblJwWTJGMGZHOWhkWFJvZkdGd2FTQnJaWGw4Ykc5bklEOXBibnhzYjJkblpXUjhjMlZ6YzJsdmJpQmxlSEJwY21Wa0wya3VkR1Z6ZENoVGRISnBibWNvY3lrcE93MEtmUTBLTHk4ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2c2ckNRN0tlQUlPS0FsQ0Ryb1p6cXQ3anNuYmpzbllBZzY2bUE3S21oN1pXYzY0MndJQ0xyalpRZzY2cTdJT3lUdE91THBDTHJpcFFnNnJLOTdKcXdMaURyb1p6cXQ3anNuYmdnNjZlTTY2T003Sm1BSU95aHNPeTVtT3F3Z0NEcmk2enJuYnpzaEp3ZzY1U3c2NkdjSU95ZW9ldUtsT3VMcEM0TkNpOHZJT3lMcE95NG9TZ3lNREkyTFRBNExDRHRtb3pzZ3F3ZzdKZVU3WVN3N1pTRTY1Mjg3SjIwN0thSUlPeWlqT3lFblNrNklDSlpiM1VuZG1VZ2FHbDBJSGx2ZFhJZ2FXNWthWFpwWkhWaGJDQnpjR1Z1WkNCc2FXMXBkQ0RDdHlCeWRXNGdMM1Z6WVdkbExXTnlaV1JwZEhNTkNpOHZJSFJ2SUdGemF5QjViM1Z5SUdGa2JXbHVJR1p2Y2lCaElHaHBaMmhsY2lCc2FXMXBkQ0lnNG9DVUlPcTBnT3Vtck95ZWtPcXdnQ0RzZ3F6cm5venJzNFRyb1p3ZzZyRzQ3SmEwSU91UmxDRHNnNEh0bFp6c25iVHJuYndnN1pTTTY1NmNJT3lDck95YXFldWZpZXlkdENEcmdxanNsWVRyajRRZzZyRzQ2NmF3NjR1a0xnMEtMeThnN0oyMElPeThnT3lkdE95S3BPcXdnQ0RzbDRicmpaZ2c3WU9UN0plUUlPeVlnZXlXdENEc201RHJyTGpzbmJRZzZyZTQ2NHlBNjZHY0lPMkdvT3lLcE8yS3VPdVB2Q0FpN0ptY0lPeVZpQ0Rya0pqcmlwVHNwNEFpSU95VmpDRHNpSmdnN0plRzdKZUk2NHVrS095THBPeWduQ0RzaTZEcXM2QXBMZzBLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6c25wRHNsNURxc293ZzdaV2M2NCtFNjZXOElPeVlyT3VncENEcmk2enJuYnpxczZBZzdKcVU3TEt0N1pXWTZyT2dMQ0RzbFlUcmk0anJxYlFnVy9DZm42QWc3WUcwNjZHYzY1T2NJTzJWbk91UGhDRHN0SWpxczd4ZElPdXloTzJLdk95ZGhDRHJpSXpybjZ3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsYlFnN0tPODdJUzQ3SnFVTGljN0RRb3ZMeUFuN1pXYzY0K0VKK3VobkNEcnJZbnJtckhxdDdqcnBxenJxYlFnN0pXSUlPdVFuT3VMcENEaWdKUWc3SjZnNnJtUUlPdXFzT3VtdENEcmxZd2c2NEtZNjRxVUlISmhkR1VnYkdsdGFYVHNuYlRyZ3BnZzY2eTQ2NmVsSU9xNHVPeWR0Q0RzdElqcXM3enF1WXpzcDRBZzdKNmg3SldFRFFvdkx5RHNsNG5ybXJIdGxaanFzb3dnSXV1THBPdWx1Q0RxczRUc29KWHNuTHpyb1p3ZzY2R2M2cmU0N0oyNDdaV1k2NTI4SXVxem9DRHNsWWpyZ3JUdGxaanFzb3dnNjVDYzY0dWtMaURzcDREc3RwekN0K3lDck95YXFldWZpU0RzZzRIdGxad2c2Nnk0NnJXczY2ZU1JT3lpZ2UyWWdPeUVuQ0Ryczdqcmk2UU5DbVoxYm1OMGFXOXVJR2x6VEdsdGFYUkZjbkp2Y2loektTQjdEUW9nSUhKbGRIVnliaUF2YzNCbGJtUWdiR2x0YVhSOGRYTmhaMlV0WTNKbFpHbDBjM3gxYzJGblpTQnNhVzFwZENBb2NtVmhZMmhsWkh4bGVHTmxaV1JsWkNrdmFTNTBaWE4wS0ZOMGNtbHVaeWh6S1NrN0RRcDlEUW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPMlpsZXlkdUNEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTno2Nlc4SU95ZHZleVd0QTBLTHk4Z0wyaGxZV3gwYU91aG5DRHJoYmpzdHB6dGxaenJpNlFnS08yVWpPdWZyT3EzdU95ZHVPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFFnN0tTUjdKMjQ3S2VBSWlEdGtaenNpNXdnNG9DVUlPcXp0ZXlhcVNCUVEreVhrT3lFbkNEcmdxanNuWmdnNnJPRTdLQ1ZJT3lZcE95Q3JPeWFxU0Ryc0tuc3A0QXBMZzBLTHk4ZzdZeU03SjI4N0oyMElPMkJ0Q0RzaUpnZzdKNkk3SmEwS08yVWhPdWhuT3lnbmUyS3VDRHNuYlRyb0tVZzdZK3M3WldvS1NBek1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdEUXBtZFc1amRHbHZiaUJqYkdGMVpHVkJZMk52ZFc1MEtDa2dldzBLSUNCcFppQW9SR0YwWlM1dWIzY29LU0F0SUdGalkyOTFiblJEWVdOb1pTNWhkQ0E4SURNd01EQXdLU0J5WlhSMWNtNGdZV05qYjNWdWRFTmhZMmhsTG1WdFlXbHNPdzBLSUNCc1pYUWdaVzFoYVd3Z1BTQnVkV3hzT3cwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTNXFjMjl1Snlrc0lDZDFkR1k0SnlrcE93MEtJQ0FnSUdWdFlXbHNJRDBnS0dvZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpLU0I4ZkNCdWRXeHNPdzBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcm9aenF0N2pzbmJnZzdKMjA2NkNsSU95WGh1eWRqQ0RyazdFZzRvQ1VJRzUxYkd3ZzdKeWc3S2VBSUNvdklIME5DaUFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ1JHRjBaUzV1YjNjb0tTd2daVzFoYVd3Z2ZUc05DaUFnY21WMGRYSnVJR1Z0WVdsc093MEtmUTBLWm5WdVkzUnBiMjRnWTJobFkydERiR0YxWkdWQmRtRnBiR0ZpYkdVb0tTQjdEUW9nSUdOdmJuTjBJSEJ5YjJKbElEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25MUzEyWlhKemFXOXVKMTBzSUhzZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1ZpQjlLVHNOQ2lBZ2JHVjBJRzkxZENBOUlDY25PdzBLSUNCd2NtOWlaUzV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJ2ZFhRZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc05DaUFnY0hKdlltVXViMjRvSjJWeWNtOXlKeXdnS0NrZ1BUNGdleUJqYkdGMVpHVlRkR0YwZFhNZ1BTQW5ZMnhoZFdSbExXMXBjM05wYm1jbk95QjlLVHNOQ2lBZ2NISnZZbVV1YjI0b0oyTnNiM05sSnl3Z0tHTnZaR1VwSUQwK0lIc05DaUFnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0FvWTI5a1pTQTlQVDBnTUNBbUppQXZYR1FyWEM1Y1pDc3ZMblJsYzNRb2IzVjBLU2tnUHlBbmIyc25JRG9nSjJOc1lYVmtaUzF0YVhOemFXNW5KenNOQ2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnUTJ4aGRXUmxJRU52WkdVZzdLQ1E2cktBT2lBbklDc2dZMnhoZFdSbFUzUmhkSFZ6SUNzZ0tHOTFkQ0EvSUNjZ0tDY2dLeUJ2ZFhRdWRISnBiU2dwSUNzZ0p5a25JRG9nSnljcEtUc05DaUFnZlNrN0RRcDlEUW92THlEc3NwanJwcXdnN1ppRTdabXBJT0tBbENBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVnRDQWk3S0NWNjZlUUlPMkJ0T3Vobk91VG5PcXdnQ0RyaTdYdGxvanJpcFRzcDRBaUlPdXdsdXlYa095RW5DRHRtWlhzbmJqdGxhQWc3SWlZSU95ZWlPcXlqQ0R0bFp6cmk2UU5DbU52Ym5OMElITjBZWFJ6SUQwZ2V5QnpaWEoyWldRNklEQXNJR3hoYzNSQmREb2dKeWNzSUd4aGMzUlVaWGgwT2lBbkp5d2diR0Z6ZEZObFl6b2dKeWNnZlRzTkNnMEtMeThnNHBTQTRwU0FJTzJVak91ZnJPcTN1T3lkdUNEc2c1M3NvYlFnNnJDUTdLZUFLT3lMck95ZXBldXdsZXVQbVNrZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBRFFvdkx5RHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY1YWdJT3llaU91S2xDRHJqNW5zbFlnZ1kyOWtaUzUwYytxd2dDQTE3TFNJNjZlSTY0dWtJRkJQVTFRZ0wyaGxZWEowWW1WaGRPdWx2Q0RyczdUcmdyanJpNlF1RFFvdkx5RHRsWndnNjdLSTdKMjA2NTI4NjQrRUlPdXdtK3lkZ0NEcmtxUWdNekRzdElqcXNJUWc2NEdLNnJpdzY2bTBJTzJVak91ZnJPcTN1T3lkdUNqcm1KRHJpcFFnN1pTODZyZTQ2NmVJS2V5ZHRDRHJpNnZ0bm93ZzZyS0RJT0tBbENEdGdiVHJvWnpyazV6cXVZenNwNEFnNjQydzY2YXM2ck9nSU9xd21leWR0Q0RxdXJ6c3A0VHJpNlF1RFFvdkx5RHNsWVRzcDRFZzdaV2NJT3V5aU91UGhDRHJxcnNnNjdDYjdKV1k3Snk4NjZtMEtPdUxwT3Vtck91bmpDRHJxTHpzb0lBZzdMeWdJT3lEZ2UyRG5Dd2c3SjZRNjQrWjdJdWM3SjZSSU91VHNTa2c2ck9FN0lhTklPdU1nT3E0c08yVm5PdUxwQzROQ21OdmJuTjBJRWhGUVZKVVFrVkJWRjlFUlVGRVgwMVRJRDBnTXpBd01EQTdEUXBzWlhRZ2JHRnpkRUpsWVhRZ1BTQXdPdzBLYzJWMFNXNTBaWEoyWVd3b0tDa2dQVDRnZXcwS0lDQnBaaUFvYkdGemRFSmxZWFFnSmlZZ1JHRjBaUzV1YjNjb0tTQXRJR3hoYzNSQ1pXRjBJRDRnU0VWQlVsUkNSVUZVWDBSRlFVUmZUVk1wSUhzTkNpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFnNG9DVUlPMlV2T3EzdU91bmlDL3RsSXpybjZ6cXQ3anNuYmpzbmJRZzY0dXI3WjZNSU9xeWcreWN2T3VobkNEcnM3VHFzNkFnNnJDWjdKMjBJT3E2dk95bmtldUxpT3VMcEM0bktUc05DaUFnSUNCd2NtOWpaWE56TG1WNGFYUW9NQ2s3SUM4dklHVjRhWFFnN1pXNDY1T2s2NStzNnJDQUlHdHBiR3hRY205ajdKeTg2NkdjSUdOc1lYVmtaU0R0aXJqcnBxenJwYndnN0tDVjY2YXM3WldjNjR1a0RRb2dJSDBOQ24wc0lEVXdNREFwT3cwS0RRb3ZMeURpbElEaWxJQWdRbEpQVjFORlVpRHFzSURyb1p6c3NZVHF1TERyaXBRZzdLQ2M2ckd3NjVDUTY0dWtJQ2d5TURJMkxUQTRMQ0JDVWtsRVIwVmZWajB5TlNrZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBRFFvdkx5RHNtSWpzb0lUc2w1UWdRbEpQVjFORlVpRHRtWmpxc3IzcnM0RHNpSmpzbDVBZzdKNkU3SXVjSU95S3BPMkJyT3VtdmUyS3VPdWx2Q0RxdllMc2xZUWdRMHhKNnJDQUlPeWtnQ0JoZFhSb2IzSnBlbVVnVlZKTTdKMkVJT3lhc091bXJPcXdnQ0Ryc0p2c2xZVHNoSndnN0plMDdKZUk2NHVrTGcwS0x5OGc2NnFwN0tDQjdKMkFJTzJWbU91Q21PdS9rT3lkdE95WGlPdUxwQ0RpZ0pRZzZyT0U3S0NWSU95Z2hPMlptT3lhcWV5Y3ZPdWhuQ0JWVWt6c25ZUWdZMnhoZFdSbExtRnBMMnh2WjI5MWREOXlaWFIxY201VWJ6M2lnS2Jyb1p3ZzdKNnM3SjZSN0lTeDdaVzBEUW92THlEc2lybnNuYmdnN1ptVTY2bTA3SjJFSU9xeHRPdUVpT3Vic09xem9DRHFzNFRzb0pVZzdJU2c3WU9kSU8yWmxPdXB0T3lYa0NEc3A0SHRsb25zaTV6dGdxVHF1TEF1SU9xM3VDRHNucXpzbnBIc2hMSHNuWVFnN1krUTZyaXc3WldZN0o2UUtPeUNyT3lhcWV5ZWtDRHFzckRzb0pVcElPMlZ1T3VUcE91ZnJPdUtsQTBLTHk4ZzY2cXA3S0NCN0oyMElPeVhodXlXdE95aGpPcXpvQ3dnS2lycmdxanFzcWdnNjVHUTY2bTBJT3lZcE8yZWlPdWdwQ0Ryb1p6cXQ3anNuYmpzbllRZzY2ZWQ2ckNBNjV5bzY2YXc2NHVrS2lvNkRRb3ZMeUFnSUVOTVNlcXdnQ0JWVWt6c25ZUWc2NVN3N0ppMDdaR2NJT3lYaHV5ZHRDRHJoSmpxdUxEcnFiUWdZMjFrNnJDQUlHQW1ZT3lYa095RW5DQlZVa3pzbllRZzdKNlk2NTI4SU91eWhPdWdwQ2pzbklqcmo0VHNtckFwSUdOc2FXVnVkRjlwWkNEcXNKbnNuWUFnNjVLazdLcTlEUW92THlBZ0lPdW5wT3F3bk91emdPeUltT3F3Z0NEc2dxenJuYnpzcDREcXM2QXNJT3U0ak91ZHZPeWFzT3lnZ095WGxDQWk3SjZZNjZxNzY1Q2NJRTlCZFhSb0lPeWFsT3l5clNEQ3R5QmpiR2xsYm5SZmFXUWc2NmVrNnJDYzY3T0E3SWlZNnJDQUlPdUloT3VkdmV1UW1PeVhpT3lLdGV1TGlPdUxwQ0xxc0lBZzY1eXM2NHVrTGcwS0x5OGdJQ0RzaTZ6dGxaanJxYlFnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJT3lWaE95WWlDRHNsWWdnN0plMDY2YXc2NHVrS095THBPeTRvU0F5TURJMkxUQTRPaUJEVEVrZzdaU0U2NkdjN0lTNDdJcWs2NHFVSU91TWdPcTRzQ0RzcEpIc25ianJqYkFnN0xDOTdKMjBJT3lWaUNEcm5MZ3BMZzBLTHk4ZzdKMjA3S0NjSUVKU1QxZFRSVkxycGJ3ZzZyRzA2NU9jNjZhczdLZUFJT3lWaXV1S2xPdUxwQ0RpaHBJZ1kyeGhkV1JsSUVOTVNlcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNjZXOElPeW5nZXlna1NEc2w3RHJpNlFvUTB4SklPcTRzT3V6dUNEcmo1bnNucEVwTGcwS0x5OGdLaXJzbmJRZzZySzk2NkdjN0plUUlGVlNUQ0Rxc0lEcXM3WEN0K3lra2Vxd2hDRHNpcVR0Z2F6cnByM3RpcmpycGJ3ZzY0dWs3SXVjSU91RW8reW5nQ0RycDVBZzZyS0RMaW9xSU9xemhPeWdsU0Rzb0lUdG1aanNuWUFnN0lxNTdKMjRJTzJabE91cHRDRHRsWmpyaTZnZ1crcXpoT3lnbFNEc29JVHRtWmhkSU91eWhPMkt2T3ljdk91aG5DNE5DZzBLTHk4ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1Q0R0bElUcm9aenNoTGpzaXFRZ0tHTnNZWFZrWlNCaGRYUm9JR3h2WjJsdUlDMHRZMnhoZFdSbFlXa3BJT0tBbENBdmIzQmxiaTFzYjJkcGJ1eWR0Q0RzZzUzc2hMSEN0K3EwZ091bXJDNE5DaTh2SU91NGpPdWR2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPdXp0T3VDdE95a2hDRHJsWXpxdVl6c3A0QWc3SWlvN0phMDdJU2NJT3VNZ09xNHNPMlZtT3VMcE9xd2dDd2c3Sm1FNjZPTTY1Q1k2Nm0wSU95S3BPeUtwT3VobkNEcmdaM3JncHpyaTZRdURRcHNaWFFnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNOQ214bGRDQnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlHNTFiR3c3RFFwc1pYUWdiRzluYVc1VGRHRnlkR1ZrUVhRZ1BTQXdPeUF2THlEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJT3lMbk95ZWtTRHNpNXpxc0lFZzRvQ1VJT3llck8yQnRPdW1yZXlkdENBbjdKNnM3SXVjNjQrRUoreWR1T3luZ0NBbjdKNlE2NCtaN0ptRTY2T01JT3lMcE8yTXFDZnNuYmpzcDRBZzZyV3M2N2FFN1pXYzY0dWtEUXBtZFc1amRHbHZiaUJyYVd4c1RHOW5hVzVRY205aktDa2dldzBLSUNCcFppQW9iRzluYVc1UWNtOWpWR2x0WlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0d4dloybHVVSEp2WTFScGJXVnlLVHNnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J1ZFd4c095QjlEUW9nSUdsbUlDZ2hiRzluYVc1UWNtOWpLU0J5WlhSMWNtNDdEUW9nSUdOdmJuTjBJSEFnUFNCc2IyZHBibEJ5YjJNN0RRb2dJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdEUW9nSUhSeWVTQjdEUW9nSUNBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzTkNpQWdJQ0FnSUhOd1lYZHVVM2x1WXlnbmRHRnphMnRwYkd3bkxDQmJKeTlRU1VRbkxDQlRkSEpwYm1jb2NDNXdhV1FwTENBbkwxUW5MQ0FuTDBZblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3RFFvZ0lDQWdmU0JsYkhObElIc05DaUFnSUNBZ0lIUnllU0I3SUhCeWIyTmxjM011YTJsc2JDZ3RjQzV3YVdRc0lDZFRTVWRVUlZKTkp5azdJSDBnWTJGMFkyZ2dLRjlsTWlrZ2V5QndMbXRwYkd3b0tUc2dmUTBLSUNBZ0lIME5DaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nNjZ5MDdJdWNJQ292SUgwTkNuME5DZzBLTHk4ZzdZUzBJT3VQaE95a2tTRHRnYlRyb1p6cms1d2c3WlNFNjZHYzdJUzQ3SXFrNnJDQUlPeWp2ZXlYaU95ZGhDRHJsWXpzblpnZzdJdWs3WXlvSU91cGxPeUxuT3luZ0NEaWdKUWdjblZ1VkhWeWJ1eWR0Q0RzbmJRZzY2bVU3SXVjN0tlQTdKMjhJT3VWak91bmpDQXg3WnFNSU95ZWtPdVBtU0RzbnF6c2k1enJqNFR0bFp6cmk2UU5DbU52Ym5OMElGTkZVMU5KVDA1ZlJFbEZSQ0E5SUNmdGdiVHJvWnpyazV3ZzdJUzQ3SVdZN0oyMElPeWloZXVqak91UWtPeVd0T3lhbEM0bk93MEtiR1YwSUhOb2RYUjBhVzVuUkc5M2JpQTlJR1poYkhObE95QXZMeUF2YzJoMWRHUnZkMjRnN0tlRTdaYUpJT3lra1NEaWdKUWc3SjZzN0l1YzY0K0U2NkdjSU95RXVPeUZtT3lkaENEcmtKanNnclRycHF6c3A0QWc3SldLNnJLTUlPMlJuT3lMbkEwS0RRb3ZMeUJ5WldGemIyN3NuWVFnN0tPODY2bTBJQ2Zzblpqcmo0VHNvSUVnN0tLRjY2T01KeWpxczRUc29KVWc3S0NFN1ptWXdyZnJvWnpxdDdqc2xZVHNtNE1nNjVPeEtTRGlnSlFnN0tlRTdaYUpJT3lra2V5ZHRPdU5tQ0R0aExUc25ZUWc2cmU0SU91cGxPeUxuT3luZ091aG5DRHJnWjNyZ3JUc2hKd05DaTh2SUhKMWJsUjFjbTdzblpnZ1UwVlRVMGxQVGw5RVNVVkVJT3lla091UG1TRHNucXpzaTV6cmo0VHFzSUFnN0ppYklPeWVrT3F5cWV5bW5ldXFoZXljdk91aG5DRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2YXM3S2VBSU95Vml1cXlqQ0R0bFp6cmk2UXVEUW92THlBbzdKV0lJT3EzdU91ZnJPdXB0Q0RxczRUc29KVWc3S0NFN1ptWUlPeW5nZTJiaENEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZHRDRHJ0b0R0bVp6dGxiUWdUVUZZWDFSVlVrNVQ2cm1NN0tlQUlPcXpoT3lHalNEc2s3RHNuYlRyaXBRZzY3S0U2cmU0SU9LQWxDQXlNREkyTFRBM0lPdW1yT3Uzc095WGtPeUVuQ0R0bVpYc25iZ3BEUXBtZFc1amRHbHZiaUJyYVd4c1VISnZZeWh5WldGemIyNHBJSHNOQ2lBZ2FXWWdLSEJ5YjJNcElIc05DaUFnSUNCMGNua2dldzBLSUNBZ0lDQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZDNhVzR6TWljcElIc05DaUFnSUNBZ0lDQWdMeThnYzJobGJHdzZkSEoxWmV1aG5DRHJuWVRzbTR6c2hKd2djSEp2WSt5ZGdDQmpiV1FnNnJ1TjY0Mnc2cml3SU9LQWxDQXZWT3VobkNEdGlyanJwcXpzcDdnZzdLTzk3SmVzN0pXOElPeW5oT3lubkNCamJHRjFaR1hxc0lBZzZyT2c3SldFNjZHY0lPeVZpQ0RyZ3FqcmlwVHJpNlFOQ2lBZ0lDQWdJQ0FnTHk4Z0tPcXpvT3lWaENCamJHRjFaR1hxc0lBZzdJU2s3TG1ZSU8yTWpPeWR2T3lkaENEcnJMenFzNkFnN0o2STdKeTg2Nm0wSU8yQnRPdWhuT3VUbkNEc2xiRWc3SmVGNjQydzdKMjA3WXE0NnJDQUlDTHNncXpzbXFrZzdLU1JJdXljdk91aG5DRHJwNG50bnBncERRb2dJQ0FnSUNBZ0lITndZWGR1VTNsdVl5Z25kR0Z6YTJ0cGJHd25MQ0JiSnk5UVNVUW5MQ0JUZEhKcGJtY29jSEp2WXk1d2FXUXBMQ0FuTDFRbkxDQW5MMFluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdEUW9nSUNBZ0lDQjlJR1ZzYzJVZ2V3MEtJQ0FnSUNBZ0lDQXZMeUJ0WVdOUFV5L3JwcXpyaUlYc2lxUTZJSE5vWld4c09uUnlkV1hybmJ3Z2NISnZZK3lkdENCemFDRHF1NDNyamJEcXVMRHNuYndnN0lpWUlPeWVpT3lkakNEaWdKUWdjM1JoY25SUWNtOWo3SjJZSUdSbGRHRmphR1ZrNjZHY0lPdW5qT3VUb0EwS0lDQWdJQ0FnSUNBdkx5RHRsSVRyb1p6c2hManNpcVFnNnJlNDY2TzVLQzF3YVdRcDdKMkVJTzJHdGV5bnVPdWhuQ0Rzb0pYcnBxenRsWnpyaTZRZ0tIUmhjMnRyYVd4c0lDOVVJT3VNZ095ZGtTa05DaUFnSUNBZ0lDQWdkSEo1SUhzZ2NISnZZMlZ6Y3k1cmFXeHNLQzF3Y205akxuQnBaQ3dnSjFOSlIxUkZVazBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3SUhCeWIyTXVhMmxzYkNncE95QjlEUW9nSUNBZ0lDQjlEUW9nSUNBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIME5DaUFnZlEwS0lDQndjbTlqSUQwZ2JuVnNiRHNOQ2lBZ2QyRnliV1ZrVlhBZ1BTQm1ZV3h6WlRzTkNpQWdhV1lnS0hkaGFYUmxjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9kMkZwZEdWeUxuUnBiV1Z5S1RzZ2QyRnBkR1Z5TG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvY21WaGMyOXVJSHg4SUZORlUxTkpUMDVmUkVsRlJDa3BPeUIzWVdsMFpYSWdQU0J1ZFd4c095QjlEUXA5RFFvTkNtWjFibU4wYVc5dUlITjBZWEowVUhKdll5Z3BJSHNOQ2lBZ2EybHNiRkJ5YjJNb0tUc05DaUFnYkdsdVpVSjFaaUE5SUNjbk93MEtJQ0IwZFhKdWN5QTlJREE3RFFvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT3lMbk91UG1TRHNwSkhpZ0tZZ0tPdXFxT3VOdURvZ0p5QXJJR04xY25KbGJuUk5iMlJsYkNBcklDY3BKeWs3RFFvZ0lHTnZibk4wSUhSb2FYTlFjbTlqSUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbkxYQW5MQ0FuTFMxdGIyUmxiQ2NzSUdOMWNuSmxiblJOYjJSbGJDd2dKeTB0YVc1d2RYUXRabTl5YldGMEp5d2dKM04wY21WaGJTMXFjMjl1Snl3Z0p5MHRiM1YwY0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzSUNjdExYWmxjbUp2YzJVblhTd2dldzBLSUNBZ0lITm9aV3hzT2lCMGNuVmxMQ0JqZDJRNklFVk5VRlJaWDBOWFJDd2daVzUyT2lCRFRFRlZSRVZmUlU1V0xBMEtJQ0FnSUdSbGRHRmphR1ZrT2lCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUNFOVBTQW5kMmx1TXpJbkxDQXZMeUJRVDFOSldEb2c3SjZRNnJpd0lPMlVoT3Vobk95RXVPeUtwQ0RxdDdqcm83a2c3SU9kN0lTeElPS0FsQ0JyYVd4c1VISnZZK3lkdENEcXQ3anJvN25zcDdnZzdLQ1Y2NmFzN1pXZ0lPeUltQ0Rzbm9qcXNvd05DaUFnZlNrN0RRb2dJSEJ5YjJNZ1BTQjBhR2x6VUhKdll6c05DaUFnY0hKdll5NXpkR1J2ZFhRdWIyNG9KMlJoZEdFbkxDQW9aQ2tnUFQ0Z2V3MEtJQ0FnSUd4cGJtVkNkV1lnS3owZ1pDNTBiMU4wY21sdVp5Z25kWFJtT0NjcE93MEtJQ0FnSUd4bGRDQnBaSGc3RFFvZ0lDQWdkMmhwYkdVZ0tDaHBaSGdnUFNCc2FXNWxRblZtTG1sdVpHVjRUMllvSjF4dUp5a3BJQ0U5UFNBdE1Ta2dldzBLSUNBZ0lDQWdZMjl1YzNRZ2JHbHVaU0E5SUd4cGJtVkNkV1l1YzJ4cFkyVW9NQ3dnYVdSNEtTNTBjbWx0S0NrN0RRb2dJQ0FnSUNCc2FXNWxRblZtSUQwZ2JHbHVaVUoxWmk1emJHbGpaU2hwWkhnZ0t5QXhLVHNOQ2lBZ0lDQWdJR2xtSUNnaGJHbHVaU2tnWTI5dWRHbHVkV1U3RFFvZ0lDQWdJQ0JzWlhRZ1pYWWdQU0J1ZFd4c093MEtJQ0FnSUNBZ2RISjVJSHNnWlhZZ1BTQktVMDlPTG5CaGNuTmxLR3hwYm1VcE95QjlJR05oZEdOb0lDaGZaU2tnZXlCamIyNTBhVzUxWlRzZ2ZRMEtJQ0FnSUNBZ2FXWWdLR1YySUNZbUlHVjJMblI1Y0dVZ1BUMDlJQ2R5WlhOMWJIUW5JQ1ltSUhkaGFYUmxjaWtnZXcwS0lDQWdJQ0FnSUNCamIyNXpkQ0IzSUQwZ2QyRnBkR1Z5T3cwS0lDQWdJQ0FnSUNCM1lXbDBaWElnUFNCdWRXeHNPdzBLSUNBZ0lDQWdJQ0JqYkdWaGNsUnBiV1Z2ZFhRb2R5NTBhVzFsY2lrN0RRb2dJQ0FnSUNBZ0lHbG1JQ2hsZGk1cGMxOWxjbkp2Y2lrZ2V3MEtJQ0FnSUNBZ0lDQWdJR052Ym5OMElISmhkeUE5SUZOMGNtbHVaeWhsZGk1eVpYTjFiSFFnZkh3Z1pYWXVjM1ZpZEhsd1pTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z01qQXdLVHNOQ2lBZ0lDQWdJQ0FnSUNBdkx5RHRsWnpyajRRZzdMU0k2ck84NjZXOElPdW92T3lnZ0NEcnM3anJpNlFnNG9DVUlPdWhuT3EzdU95ZHVDRHNtS1RycFpnZzdLQ1Y2cmVjN0l1ZDdKMjBJT3VFayt5V3RPeUVuQ2hzYjJjZ1AybHVJT3VUc1NrZzY2eTQ2cldzNnJDQUlPdXdsT3VBak91cHRDRHNncnp0Z3F3ZzdJaVlJT3llaU91THBBMEtJQ0FnSUNBZ0lDQWdJR2xtSUNocGMweHBiV2wwUlhKeWIzSW9jbUYzS1NrZ2V3MEtJQ0FnSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMk5zWVhWa1pTMXNhVzFwZENjN0lDOHZJQzlvWldGc2RHanJvWndnN0pXTTY2YThJT0tHa2lEcnNvVHRpcnpzbmJRZ1crMlZuT3VQaENEc3RJanFzN3hkNjZHY0lPdXdsT3VBak9xem9DRHFzNFRzb0pVZzdLQ0U3Wm1ZN0oyRUlPeVZpT3VDdEEwS0lDQWdJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yQnRPdWhuT3VUbkNEc2dxenNtcWtnN1pXYzY0K0VJT3kwaU9xenZDRHFzSkRzcDRBNkp5d2djbUYzS1RzTkNpQWdJQ0FnSUNBZ0lDQWdJSGN1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWhNU1UxSlZGOUhWVWxFUlNrcE93MEtJQ0FnSUNBZ0lDQWdJSDBnWld4elpTQnBaaUFvYVhOQmRYUm9SWEp5YjNJb2NtRjNLU2tnZXcwS0lDQWdJQ0FnSUNBZ0lDQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ0oyTnNZWFZrWlMxc2IyZHZkWFFuT3lBdkx5QXZhR1ZoYkhSbzY2R2NJTzJVak91ZnJPcTN1T3lkdU95WGtDRHNsWXpycHJ3ZzRvYVNJT3V5aE8yS3ZPeWR0Q0JiNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjNyb1p3ZzY3Q1U2NENjRFFvZ0lDQWdJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdUNEcnA0enJvNHdnNnJDUTdLZUFPaWNzSUhKaGR5azdEUW9nSUNBZ0lDQWdJQ0FnSUNCM0xuSmxhbVZqZENodVpYY2dSWEp5YjNJb1RFOUhTVTVmUjFWSlJFVXBLVHNOQ2lBZ0lDQWdJQ0FnSUNCOUlHVnNjMlVnZXcwS0lDQWdJQ0FnSUNBZ0lDQWdkeTV5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2Z0Z2JUcm9aenJrNXdnN0ppazY2V1lPaUFuSUNzZ2NtRjNLU2s3RFFvZ0lDQWdJQ0FnSUNBZ2ZRMEtJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2V3MEtJQ0FnSUNBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZHZheWM3SUM4dklPeUVzZXF6dFNBOUlPeUVwT3k1bU1LMzY2R2M2cmU0N0oyNElPdUxwQ0Rzb0pYc2c0RWc0b0NVSU95V3RPdVdwQ0J3Y205aWJHVnQ3SjIwNjVPZ0lPMlZ0T3lnbkNBbzdKNnM2NkdjNnJlNDdKMjRMK3llck95RXBPeTVtQ0RyczdYcXQ0QXBEUW9nSUNBZ0lDQWdJQ0FnZHk1eVpYTnZiSFpsS0ZOMGNtbHVaeWhsZGk1eVpYTjFiSFFnZkh3Z0p5Y3BLVHNOQ2lBZ0lDQWdJQ0FnZlEwS0lDQWdJQ0FnZlEwS0lDQWdJSDBOQ2lBZ2ZTazdEUW9nSUhCeWIyTXVjM1JrWlhKeUxtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc05DaUFnSUNCamIyNXpkQ0J6SUQwZ1pDNTBiMU4wY21sdVp5Z25kWFJtT0NjcExuUnlhVzBvS1RzTkNpQWdJQ0JwWmlBb2N5QW1KaUFoY3k1cGJtTnNkV1JsY3lnblJHVndjbVZqWVhScGIyNVhZWEp1YVc1bkp5a3BJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCamJHRjFaR1VnYzNSa1pYSnlPaWNzSUhNdWMyeHBZMlVvTUN3Z01qQXdLU2s3RFFvZ0lIMHBPdzBLSUNCd2NtOWpMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0RRb2dJQ0FnTHk4ZzdKMjA2Nis0SU95RGlDRHNoTGpzaFpqc25MenJvWndnNnJXUTdMSzA2NUNjSU91U3BDRHNtSnNnN0lTNDdJV1k3SjIwSU91THErMmVqQ0Rxc2JEcnFiUWc2NnkwN0l1Y0lDanJxcWpyamJnZzdLQ0U3Wm1ZSU95TG5DRHNnNGdnN0lTNDdJV1k3SjJFSU95anZleWR0T3luZ0NEc2xZcnFzb3dwRFFvZ0lDQWdhV1lnS0hCeWIyTWdJVDA5SUhSb2FYTlFjbTlqS1NCeVpYUjFjbTQ3RFFvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yQnRPdWhuT3VUbkNEc2hManNoWmdnN0tLRjY2T01JQ2hqYjJSbElDY2dLeUJqYjJSbElDc2dKeWtnNG9DVUlPdUxwT3lkakNEc21wVHNzcTBnNjVXTUlPdUxwT3lMbkNEc2k1enJqNW50bGFucmk0anJpNlF1SnlrN0RRb2dJQ0FnYTJsc2JGQnliMk1vS1RzTkNpQWdmU2s3RFFwOURRb05DbVoxYm1OMGFXOXVJSE5sYm1SVWRYSnVLSFJsZUhRcElIc05DaUFnY21WMGRYSnVJRzVsZHlCUWNtOXRhWE5sS0NoeVpYTnZiSFpsTENCeVpXcGxZM1FwSUQwK0lIc05DaUFnSUNCcFppQW9JWEJ5YjJNcElISmxkSFZ5YmlCeVpXcGxZM1FvYm1WM0lFVnljbTl5S0NmdGdiVHJvWnpyazV3ZzdJUzQ3SVdZN0oyMElPeVhodXlXdE95YWxDNG5LU2s3RFFvZ0lDQWdhV1lnS0hkaGFYUmxjaWtnY21WMGRYSnVJSEpsYW1WamRDaHVaWGNnUlhKeWIzSW9KK3lWbnV5RW9DRHNtcFRzc3Ezc25iUWc3S2VFN1phSklPeWtrZXlkdE95WGtPeWFsQzRuS1NrN0RRb2dJQ0FnWTI5dWMzUWdkR2x0WlhJZ1BTQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0aExRZzdJdWM2ckNFSU95MGlPcXp2Q0RpZ0pRZzdJUzQ3SVdZN0oyRUlPeWVyT3lMbk95ZWtlMlZxZXVMaU91THBDNG5LVHNOQ2lBZ0lDQWdJQzh2SU95TG5PcXdoQ0RzdElqcXM3enJpcFFnSit5RXVPeUZtQ0Rzb29Ycm80d243Sm1BSU9xMXJPdTJoT3VRbU91S2xDRHNvSndnNjZtVTdJdWM3S2VBNjZHY0lPdUJuZXVDdU91THBDRGlnSlFnYTJsc2JGQnliMlBzblpnZzdJUzQ3SVdZSU95aWhldWpqQ0J5WldwbFkzVHFzSUFOQ2lBZ0lDQWdJQzh2SUhKMWJsUjFjbTdzblpnZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE91bHZDRHJ0b0RycGJUcnFiUWc3SldJSU91UW1PcTRzQ0RybFl6cnJMZ282NHFRNjZhd0lPMkV0T3lkaENEcmtaQWc2N0tJSU91UGpPdXB0Q0R0bEl6cm42enF0N2pzbmJnZ01UTXc3TFNJSU95Z25PMlZuT3lkaENEcmhKanF1TFRyaTZRcERRb2dJQ0FnSUNCcFppQW9kMkZwZEdWeUtTQjdEUW9nSUNBZ0lDQWdJR052Ym5OMElIY2dQU0IzWVdsMFpYSTdJSGRoYVhSbGNpQTlJRzUxYkd3N0RRb2dJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243WUcwNjZHYzY1T2NJT3lka2V1THRleWR0Q0RyaElqcnJMUWc3SmlrNjU2WUlPcXh1T3VncENEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5LU2s3RFFvZ0lDQWdJQ0I5RFFvZ0lDQWdJQ0JyYVd4c1VISnZZeWdwT3cwS0lDQWdJSDBzSUZSVlVrNWZWRWxOUlU5VlZGOU5VeWs3RFFvZ0lDQWdkMkZwZEdWeUlEMGdleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIMDdEUW9nSUNBZ2NISnZZeTV6ZEdScGJpNTNjbWwwWlNoS1UwOU9Mbk4wY21sdVoybG1lU2g3SUhSNWNHVTZJQ2QxYzJWeUp5d2diV1Z6YzJGblpUb2dleUJ5YjJ4bE9pQW5kWE5sY2ljc0lHTnZiblJsYm5RNklIUmxlSFFnZlNCOUtTQXJJQ2RjYmljc0lDZDFkR1k0SnlrN0RRb2dJSDBwT3cwS2ZRMEtEUW92THlEcXNKbnNuWUFnNjZ5NDZyV3M2Nlc4SU91cWh5RHJzb2pzcDdnZzY2eTc2NHFVN0tlQUlPcTRzT3lXdFNEaWdKUWc3SjZzN0pxVTdMS3Q3SjIwNjZtMElDTHNuYlRzb0lUcXM3d2c2NHVrNjZXNElPeURpQ0Rzb0p6c2xZZ2k3SjJFSU95YWxPcTFyTzJWbk91THBBMEtMeThnS095VmlDRHF0N2pybjZ6cnFiUWc3WUcwNjZHYzY1T2M2ckNBSU95RXNleUxwTzJWbU9xeWpDRHFzSm5zbllBZzY0dTE3SjJFSU91WWtDRHJnclRzaEp3Z1cwRkpJT3kybE95eW5DRHJqWlFnNjdDYjZyaXdYZXF3Z0NEcnJMVHNuWmpycjdqdGxiVHNwNFRyaTZRcERRcGpiMjV6ZENCaGMydGxaRU52ZFc1MElEMGdibVYzSUUxaGNDZ3BPdzBLRFFvdkx5RHNoTGpzaFpnZzdLU0E2N21FS095TG5PdVBtU3ZzcDREc2k1enJyTGdnN0tPODdKNkZLZXVsdkNEcnM3VHNucVh0bFp3ZzY1S2tJTzJWbkNEdGhMUWc3SXVrN1phSklPS0FsQ0RycXFqcms2QWc3Wmk0N0xhYzdKMkFJSEYxWlhWbDY2R2NJT3luZ2V1Z3JPMlpsQzROQ2k4dklHMXZaR1ZzN0oyRUlPeWp2T3VwdENEcXQ3Z2c2NnFvNjQyNDY2R2NJQ2pyaTZUcnBiVHJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU2t1SU8yVm5DRHJxcWpyamJqc25ZUWc2ck9FN0lhTklPeVRzT3VwdENEc25xenNpNXpzbnBIc25ZQWc3TFdjN0xTSUlESHRtb3pydjVBdURRb3ZMeUJ5WlhCaGNuTmxQWHR3WVhKelpTd2dabTl5YldGMFJHVnpZMzNycGJ3ZzdLTzg2Nm0wSU8yTWpPeUxzZXE1ak95bmdDRHNuYlFnN0o2aElPeVZpT3lYa095RW5DRHNzcGpycHF6dGxaanFzNkFnZTNKaGR5d2djR0Z5YzJWa2ZldWx2Q0RyajR6cm9LVHNwSURyaTZRNkRRb3ZMeUR0bUpYc2k1MGc3SjIwN1lPSUlPeUxuQ0Rxc0puc25ZQWc3SVM0N0lXWTdKZVFJQ0x0bUpYc2k1M3JqSURyb1p3ZzY0dWs3SXVjSXV1bHZDRHNtcFRxdGF6dGxaanJpcFFnN0o2czdKcVU3TEt0SU8yRXRPeWRoQ0FxS3Vxd21leWRnQ0R0Z1pBZzdKNmhJT3lWaU95WGtPeUVuQ29xSU91Mm1leWR1T3VMcEM0TkNpOHZJT3V6aE91UGhDRHNucUhzbkx6cm9ad2c2N204NjZtMElDaGhLU0RzZ3F6c25iVHNsNUFnNjR1azY2VzRJT3lhbE95eXJTRHRoTFRzbmJRZzY0Rzg3SmEwSUNmcnNLbnF1SWdnNjR1MUoreWR0Q0RyZ3Fqc25aZ2c2NHUxN0oyMElPdVFtT3F6b0NqcmdyVHNtcWtnN0ppazdKZThLU3dOQ2k4dklDaGlLU0JOUVZoZlZGVlNUbE1nNnJLOTZyT0U3SmVRN0lTY0lPeUV1T3lGbU95ZHRDRHNucXpzaTV6c25wSHJqN3dnSit1d3FlcTRpQ0RyaTdVbjdKMjBJT3lYaHV1S2xDRHNnNGdnN0lTNDdJV1k3SjIwSU91Q3RPeWFxZXlkaENEc3A0RHNsclRyZ3J3ZzdJaVlJT3llaU91THBDQW9NakF5Tmkwd055RHJwcXpydDdEc2w1RHNoSndnN1ptVjdKMjRLUzROQ21OdmJuTjBJRkpGVUVGU1UwVmZRa0ZFSUQwZ0tIWXBJRDArSUhZZ1BUMGdiblZzYkNCOGZDQW9RWEp5WVhrdWFYTkJjbkpoZVNoMktTQW1KaUIyTG14bGJtZDBhQ0E5UFQwZ01DazdEUXBtZFc1amRHbHZiaUJ5ZFc1VWRYSnVLR0oxYVd4a1FYTnJMQ0J0YjJSbGJDd2djbVZ3WVhKelpTa2dldzBLSUNCamIyNXpkQ0JxYjJJZ1BTQnhkV1YxWlM1MGFHVnVLR0Z6ZVc1aklDZ3BJRDArSUhzTkNpQWdJQ0JqYjI1emRDQnFiMkpUZEdGeWRDQTlJRVJoZEdVdWJtOTNLQ2s3SUM4dklPeUxuT3F3aENEc21JanNnckFnNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0RzcXIwZzdLQ2M3WldjS0RFek1PeTBpQ25zbllRZzY0U1k2cmk0SU95ZXJPeUxuT3VQaE91S2xDRHRqNnpxdUxEdGxaenJpNlFOQ2lBZ0lDQnBaaUFvYlc5a1pXd2dKaVlnUVV4TVQxZEZSRjlOVDBSRlRGTXVhVzVrWlhoUFppaHRiMlJsYkNrZ0lUMDlJQzB4SUNZbUlHMXZaR1ZzSUNFOVBTQmpkWEp5Wlc1MFRXOWtaV3dwSUhzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJxcWpyamJnZzY3T0E2cks5T2lBbklDc2dZM1Z5Y21WdWRFMXZaR1ZzSUNzZ0p5RGlocElnSnlBcklHMXZaR1ZzS1RzTkNpQWdJQ0FnSUdOMWNuSmxiblJOYjJSbGJDQTlJRzF2WkdWc093MEtJQ0FnSUNBZ2MzUmhjblJRY205aktDazdJQzh2SU95RGlDRHJxcWpyamJqcm9ad2c3SVM0N0lXWUlPeWVyT3lMbk95ZWtTQW82NHVrN0oyTUlPeWJqT3V3amV5WGhleVhrT3lFbkNEc3A0RHNpNXpyckxnZzdKNnM3S084N0o2RktRMEtJQ0FnSUgwTkNpQWdJQ0JwWmlBb2RIVnlibk1nUGowZ1RVRllYMVJWVWs1VElIeDhJQ0Z3Y205aktTQnpkR0Z5ZEZCeWIyTW9LVHNOQ2lBZ0lDQnBaaUFvSVhkaGNtMWxaRlZ3S1NCN0RRb2dJQ0FnSUNCamIyNXpkQ0IwTUNBOUlFUmhkR1V1Ym05M0tDazdEUW9nSUNBZ0lDQmhkMkZwZENCelpXNWtWSFZ5YmlocGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTazdEUW9nSUNBZ0lDQjNZWEp0WldSVmNDQTlJSFJ5ZFdVN0RRb2dJQ0FnSUNCMGRYSnVjeXNyT3cwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUV1T3lGbUNEc3BJRHJ1WVFnN0ptRTY2T01JQ2duSUNzZ0tDaEVZWFJsTG01dmR5Z3BJQzBnZERBcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtTQXJJQ2R6S1NEaWdKUWc3SjIwN1p1RUlPeWFsT3l5cmV5ZGdDRHJ1YWpybmJ6c21wUXVKeWs3RFFvZ0lDQWdmUTBLSUNBZ0lIUjFjbTV6S3lzN0RRb2dJQ0FnWTI5dWMzUWdZWE5ySUQwZ1luVnBiR1JCYzJzb0tUc2dMeThnN0o2czdJdWM2NCtFSU91VmpDRHFzSm5zbllBZzdLZUk2Nnk0N0oyRUlPdUxwT3lMbkNEc2s3VHJpNlFnS0dGemEyVmtRMjkxYm5RZzdKMjA3S1NSSU95bW5lcXdnQ0Ryc0tuc3A0QXBEUW9nSUNBZ2JHVjBJSEpoZHpzTkNpQWdJQ0IwY25rZ2V3MEtJQ0FnSUNBZ2NtRjNJRDBnWVhkaGFYUWdjMlZ1WkZSMWNtNG9ZWE5yS1RzTkNpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0RRb2dJQ0FnSUNBdkx5RHRoTFFnNjQrRTdLU1JJTzJCdE91aG5PdVRuQ0R0bElUcm9aenNoTGpzaXFUcXNJQWc3S085N0oyQUlPcXl2ZXlhc0NoVFJWTlRTVTlPWDBSSlJVUXBJREh0bW93ZzdKNlE2NCtaSU95ZXJPeUxuT3VQaENEaWdKUWc3SUtzN0pxcDdKNlE3SmVRNnJLUUlPeUxwTzJNcU91aG5DRHNsWWdnNjdPMDdKMjA2cktNTGcwS0lDQWdJQ0FnTHk4ZzdJdWM2ckNFSU95MGlPcXp2TUszNjZHYzZyZTQ3SjI0SU91bmpPdWpqTUszN1lHMDY2R2M2NU9jSU95WXBPdWxtTUszN0oyWTY0K0U3S0NCSU95aWhldWpqQ2pxczRUc29KVWc3S0NFN1ptWUwrdWhuT3EzdU95VmhPeWJneXdnYTJsc2JGQnliMk1vY21WaGMyOXVLU25yaXBRTkNpQWdJQ0FnSUM4dklPeWduQ0RycVpUc2k1enNwNERxc0lBZzY1U3c2NkdjSU95ZWlPeVd0Q0RzbDZ6cXVMQWc3SldJSU9xeHVPdW1zT3VMcEM0ZzdLS0Y2Nk9NSU95YWxPeXlyU0RzcEpIc25iVHFzYkRyZ3BnZzdJdWM2ckNFSU95WWlPeUNzT3lkdENEc2xyenJwNGdnN0pXSUlPdUNxT3lWbU95Y3ZPdXB0Q0Rya0pqc2dyVHJwcXpzcDRBZzdKV0s2NHFVNjR1a0xnMEtJQ0FnSUNBZ2FXWWdLSE5vZFhSMGFXNW5SRzkzYmlCOGZDQWhLR1VnSmlZZ1pTNXRaWE56WVdkbElEMDlQU0JUUlZOVFNVOU9YMFJKUlVRcElIeDhJRVJoZEdVdWJtOTNLQ2tnTFNCcWIySlRkR0Z5ZENBK0lEUXdNREF3S1NCMGFISnZkeUJsT3cwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUV1T3lGbU95ZHRDRHRoTFFnNjQrRTdLU1JJT3VCaXVxNWdDRGlnSlFnN0o2czdJdWM2NCtaSU8yYmhDQXg3WnFNSU95ZXJPeUxuT3VQaE8yVnFldUxpT3VMcEM0bktUc05DaUFnSUNBZ0lITjBZWEowVUhKdll5Z3BPdzBLSUNBZ0lDQWdZWGRoYVhRZ2MyVnVaRlIxY200b2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa3BPdzBLSUNBZ0lDQWdkMkZ5YldWa1ZYQWdQU0IwY25WbE93MEtJQ0FnSUNBZ2RIVnlibk1nUFNBeU95QXZMeURzbTR6cnNJM3NsNFVnTVNBcklPeWR0T3V5aUNEdGhMUWdLSE4wWVhKMFVISnZZK3lkdENBdzdKeTg2NkdjSU95MGlPcTRzTzJabENrTkNpQWdJQ0FnSUhKaGR5QTlJR0YzWVdsMElITmxibVJVZFhKdUtHRnpheWs3RFFvZ0lDQWdmUTBLSUNBZ0lHbG1JQ2doY21Wd1lYSnpaU2tnY21WMGRYSnVJSEpoZHpzTkNpQWdJQ0JzWlhRZ2NHRnljMlZrSUQwZ2NtVndZWEp6WlM1d1lYSnpaU2h5WVhjcE93MEtJQ0FnSUM4dklPMllsZXlMblNEc25iVHRnNGpzbmJUcnFiUWc2ckNaN0oyQUlPeUV1T3lGbU1LMzZyQ1o3SjJBSU95ZW9leVhrT3lFbkNEcXM2ZnNucVVnN0o2czdKcVU3TEt0SU9LQWxDRHNuYlFnN1lTMDdKMjBJT3lqdmV5Y3ZPdXB0Q0RzZzRnZzdJUzQ3SVdZN0oyQUlDZnJzS25xdUlnZzY0dTFKK3lkaENEcnFyRHJuYndOQ2lBZ0lDQXZMeURzcDREc2xyVHJncndnN0lpWUlPeWVpT3ljdk91dmdPdWhuQ0RzaExqc2haZ2c3SUtzNjZlZElPeWVyT3lMbk91UGhPdUtsQ0R0bFpqc3A0QWc3SldLNnJPZ0lPcTN1T3VNZ091aG5DRHNpNlR0aktqc2k1enRncWpyaTZRbzdZeU03SXV4SU95THBPMk1xT3VobkNEcXQ0RHFzckFwTGcwS0lDQWdJR2xtSUNoU1JWQkJVbE5GWDBKQlJDaHdZWEp6WldRcElDWW1JRVJoZEdVdWJtOTNLQ2tnTFNCcWIySlRkR0Z5ZENBOElEY3dNREF3S1NCN0RRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlNN0l1eElPeUxwTzJNcUNEaWdKUWc3WmlWN0l1ZElPeWVyT3lhbE95eXJUb25MQ0JUZEhKcGJtY29jbUYzS1M1emJHbGpaU2d3TENBek1EQXBLVHNOQ2lBZ0lDQWdJSFIxY201ekt5czdEUW9nSUNBZ0lDQjBjbmtnZXcwS0lDQWdJQ0FnSUNCeVlYY2dQU0JoZDJGcGRDQnpaVzVrVkhWeWJpZ242N0NwNnJpSUlPdUx0ZXlkdENEc21wVHF0YXp0bFp3ZzdaaVY3SXVkN0plUUlPeVd0T3E0aSt1Q3JPdUxwQzRnNjdDcDZyaUlJT3VMdGUyVm5DRHJnclRzbXFuc25ZUWc3SVNrNjZxRndyZnNncXpxczd6Q3QreTlsT3VUbk8yT25PeUtwQ0RzbDRic25iUWc3SldFNjU2WUlFcFRUMDdzbkx6cm9aenJwNHdnNjR1azdJdWNJT3kybk91Z3BlMlZtT3VkdkRvZ0p5QXJJSEpsY0dGeWMyVXVabTl5YldGMFJHVnpZeWs3RFFvZ0lDQWdJQ0FnSUhCaGNuTmxaQ0E5SUhKbGNHRnljMlV1Y0dGeWMyVW9jbUYzS1RzTkNpQWdJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95ZXJPeWFsT3l5clNEc2k2VHRqS2dnNG9DVUlPeVZoT3VlbU95WGtPeUVuQ0R0akl6c2k3RWc3SXVrN1l5bzY2R2NJT3l5bU91bXJDQXFMeUI5RFFvZ0lDQWdmUTBLSUNBZ0lHbG1JQ2hTUlZCQlVsTkZYMEpCUkNod1lYSnpaV1FwS1NCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlNN0l1eElPeUxwTzJNcUNBbzdKNnM3SnFVN0xLdElPMmJoT3lYa091UGhDazZKeXdnVTNSeWFXNW5LSEpoZHlrdWMyeHBZMlVvTUN3Z016QXdLU2s3RFFvZ0lDQWdjbVYwZFhKdUlIc2djbUYzTENCd1lYSnpaV1E2SUZKRlVFRlNVMFZmUWtGRUtIQmhjbk5sWkNrZ1B5QnVkV3hzSURvZ2NHRnljMlZrSUgwN0RRb2dJSDBwT3cwS0lDQXZMeUR0bFp3ZzdKcVU3TEt0N0oyMElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUc25Zd2c3SnFVN0xLdDdKMjBJT3lkdE95V3RPeW5nT3VQaE91aG5TRHRnWkRyaXBRZzdaV3Q3SU9CSU95RXNlcXp0ZXljdk91aG5DRHNvSlhycHF3TkNpQWdjWFZsZFdVZ1BTQnFiMkl1WTJGMFkyZ29LQ2tnUFQ0Z2UzMHBPdzBLSUNCeVpYUjFjbTRnYW05aU93MEtmUTBLRFFvdkx5RHJzb1R0aXJ3ZzY1Mjg2N0tvSU9xM25PeTVtU0RpZ0pRZzdaU002NStzNnJlNDdKMjQ3SjIwSUNmcnNvVHRpcnpzbllRZzZyT282NTZRNjR1a0orcXpvQ0RzbFl6cm9LVHNwSVFnNjVXTTY2ZU1JT3lXdWV1S2xPdUxwQzROQ2k4dklPdXloTzJLdkNEcnJManF0YXpyaXBRZzY2eTQ3SjZsN0oyMElPeVZoT3VMaU91ZHZDRHJqNW5zbnBFZzdKMjA2NmFFN0oyMDdKYTA3SVNjTENEc25iUWc3S2VBN0l1YzZyQ0FJT3lYaHV5Y3ZPdXB0Q0Ryckxqc25xWHRtSlVnNjR5QTdKV0k3SjIwSU95RW51eVhyQ0RyZ3Bqc21LanJpNlF1RFFwamIyNXpkQ0JDVlZSVVQwNWZVbFZNUlNBOURRb2dJQ2ZzbmJRZzY2eTQ2cldzNjRxVUlDb3E2N0tFN1lxOElPdWR2T3V5cUNvcTdKMjA2NHVrTGlEcnJManNucVhzbmJRZzdKV0U2NHVJNjUyOElPdVBtZXlla1NEc25iVHJwb1RzbmJUcnI0RHJvWnc2SU91bmlPeTVxTzJSbk1LMzY2eTg3SjJNN1pHY3dyZnNvb1hxc3JEc2xyVHJyN2dvZnV5YWxDOSs2NHVrTDM3cXVZenNtcFFwSU9xNGlPeW5nQ3dnSnlBckRRb2dJQ2Zya0pqcmo0VHJvWjBnN0tlbjdKMkFJT3VQbWV5ZWtTRHJxb1hzZ3F3bzdLQ0E3SjZsd3Jmc2dxM3NvSnpDdCt5WHNPcXlzQ0R0bGJUc29Kd2c2NU94S2V1aG5Dd2c3WWExNjdPMDdJU3hJT3VMcU95ZHZDRHJzb1R0aXJ6c25iVHJxYlFnSXUyWmxleWR1Q0l1SUNjZ0t3MEtJQ0FuSXV5M3FPeUdqQ0xyaXBRZzY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1JT3lUc09xem9Dd2c3Wm1VNjZtMElPcTRzT3VLcGV1cWhTanJzNERxc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bk93MEtEUW92THlEcnJManF0YXdnN0xhVTdMS2NJTzJFdENBb2NtOXNaVDBuNjdLRTdZcThKK3lkdE91cHRDRHJzb1R0aXJ3ZzZyZWM3TG1aN0oyRUlPeVd1ZXVLbE91THBDa05DbVoxYm1OMGFXOXVJR0Z6YTBOc1lYVmtaU2gwWlhoMExDQnRiMlJsYkN3Z2NtVndZWEp6WlN3Z2NtOXNaU2tnZXcwS0lDQnlaWFIxY200Z2NuVnVWSFZ5Ymlnb0tTQTlQaUI3RFFvZ0lDQWdZMjl1YzNRZ1lYUjBaVzF3ZENBOUlDaGhjMnRsWkVOdmRXNTBMbWRsZENoMFpYaDBLU0I4ZkNBd0tTQXJJREU3RFFvZ0lDQWdZWE5yWldSRGIzVnVkQzV6WlhRb2RHVjRkQ3dnWVhSMFpXMXdkQ2s3RFFvZ0lDQWdhV1lnS0dGemEyVmtRMjkxYm5RdWMybDZaU0ErSURJd01Da2dZWE5yWldSRGIzVnVkQzVqYkdWaGNpZ3BPeUF2THlEcnJMVHRsWnp0bm9nZzdJeVQ3SjIwN0tlQUlPeVZpdXF5akEwS0lDQWdJR052Ym5OMElISjFiR1VnUFNCeWIyeGxJRDA5UFNBbjY3S0U3WXE4SnlBL0lFSlZWRlJQVGw5U1ZVeEZJRG9nSnljN0RRb2dJQ0FnY21WMGRYSnVJSEoxYkdVZ0t5QW9ZWFIwWlcxd2RDQStJREVOQ2lBZ0lDQWdJRDhnSitxd21leWRnQ0RyckxqcXRhenJwYndnNjR1azdJdWNJT3lhbE95eXJlMlZuT3VMcEM0ZzdKMjBJT3lFdU95Rm1PeVhrT3lFbkNEc25iVHNvSVRzbDVBZzdLQ2M3SldJN1phSTY0MllJT3F5Zyt1VHBPcXp2Q0Rxc3Juc3VaanNwNEFnN0pXSzY0cVVMQ0RxdGF6c29iRHJncGdnN0phMDdaeVk2ckNBSU8yWmxleUxwTzJlaUNEcmk2VHJwYmdnN0lPSTY2R2M3SnEwSU91TWdPeVZpQ0F6NnJDYzY2VzhJT3Ezbk95NW1ldU1nT3VobkNCS1UwOU9JT3V3c095WHRPdWhuT3VuakRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwRFFvZ0lDQWdJQ0E2SUNmcmk2VHNuWXdnVlVrZzY2eTQ2cldzN0oyWUlPdU1nT3lWaUNBejZyQ2M2Nlc4SU9xM25PeTVtZXVNZ091aG5DQktVMDlPSU91d3NPeVh0T3Vobk91bmpEb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLSFJsZUhRcEtUc05DaUFnZlN3Z2JXOWtaV3dzSUhKbGNHRnljMlVwT3cwS2ZRMEtEUW92THlEcnNvanNsNjBnN1lTMElPS0FsQ0Rxc0puc25ZQWc3SVM0N0lXWTdKMkVJT3lUc091UW1Dd2c3SjIwNjdLSUlPMkV0T3VuakNEc3RwVHNzcHdnN1ppVjdJdWRLRXBUVDA0ZzY3Q3c3SmUwS1NEcmpJRHNpNkFnNjdLSTdKZXRJTzJZbGV5TG5TaEtVMDlPSU9xd25leXl0Q25zbllRZzdKcVU2cldzN1pXYzY0dWtEUXBtZFc1amRHbHZiaUJoYzJ0VWNtRnVjMnhoZEdVb2RHVjRkQ3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBJSHNOQ2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdLQTBLSUNBZ0lDZnNuYlRyc29nZzdKcVU3TEt0N0oyQUlPdXlpT3lYclNEc25wSHNsNFhzbmJUcmk2UWdLT3VzdU9xMXJDRHJpNlRyazZ6cXVMQWc3SldFNjR1WUlPS0FsQ0RyaklEc2xZZ2dNK3F3bkNEcXQ1enN1Wm5zbllBZzdKMjA2N0tJSU8yRXRPeVhrQ0Rzb0lIc21xbnRsWmpzcDRBZzdKV0s2NHFVNjR1a0tTNGdKeUFyRFFvZ0lDQWdKK3VMcE95ZGpDQlZTU0RyckxqcXRhenFzSUFnN1pXYzZyV3Q3SmEwNjZtMElPeWVrT3lYc095S3BPdWZyT3lhdENEc21JSHNsclRyb1p3c0lPeVlnZXlXdE91cHRDRHNucERzbDdEc2lxVHJuNnpzbXJRZzdaV2M2cld0N0phMDY2R2NJT3V5aU95WHJlMlZtT3VkdkM0Z0p5QXJEUW9nSUNBZ0oxVkpJT3VzdU9xMXJPdUxwT3lhdENEcXNJVHFzckR0bFp3ZzdaR2M3WmlFN0oyRUlPeVRzT3F6b0N3ZzdKMjA2NmFFd3Jmc2lLdnNucERDdCt1bmlPeUtwTzJDdWNLMzdaU002NkNJN0oyMDdJcWs3Wm1BNjQyVTY0cVVJT3EzdU91TWdPdWhuQ0RyczdUc29iVHRsWnpyaTZRdUlDY2dLdzBLSUNBZ0lDZnNtNURyckxqc25aZ2c3S1NFSU95SW1PdWx2Q0RxdDdqcmpJRHJvWndnN0p5ZzdLZUE3WldjNjR1a0lPS0FsQ0RzbTVEcnJManNuYlFnN1pXY0lPeWtoT3lkdE91cHRDRHJzb2pzbDYzcmo0UWc3WldjSU95a2hPdWhuQ3dnN0tTRTY3Q1U2citJN0oyRUlPeWVoT3lkbU91aG5DRHN0cFRxc0lEdGxaanNwNEFnN0pXSzY0cVU2NHVrTGlBbklDc05DaUFnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhTRHF1SWpzcDRBNklDY2dLdzBLSUNBZ0lDZDdJblJ5WVc1emJHRjBaV1FpT2lBaTY3S0k3SmV0NjZ5NElDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0prYVhKbFkzUnBiMjRpT2lBaWEyL2locEpsYmlEcm1KRHJpcFFnWlc3aWhwSnJieUo5T2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb2RHVjRkQ2tOQ2lBZ0tTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93MEtmUTBLRFFvdkx5RHJqSUR0bVpUdG1KVWc2Nnk0NnJXc0lPeWduT3lla1NEdGhMUWc0b0NVSU95Q3JPeWFxZXlla09xd2dDRHNnNEh0bWFuc25ZUWc3SVNrNjZxRjdaV1k2Nm0wSU91bnBldWR2ZXlYa0NEcnA1N3JpcFFnNjZ5NDZyV3M2Nlc4SU91bmpPdVRwT3lXdE95a2dPdUxwQzROQ2k4dklHMWxjM05oWjJWek9pQmJlM0p2YkdVNkozVnpaWEluZkNkaGMzTnBjM1JoYm5RbkxDQjBaWGgwZlYwZzdLQ0U3TEswSU91TWdPMlpsT3VsdkNEcnA2VHJzb2dnNjdDYjY0cVU2NHVrS091THBPdW1yT3VLbENEcnJMVHNnNEh0ZzV3ZzRvQ1VEUW92THlEc200enJzSTNzbDRVZzdLZUE3SXVjNjZ5NDdKMllJQ0xzbXBUc3NxM3JrNlRzbllBZzdJU2M2NkdjSU91c3RPcTBnQ0lnN0tDRTdLQ2M2Nlc4SU95bmdPMkNwT3E0c0NEc25JVHRsYlFnNjR5QTdabVVJT3VucGV1ZHZleWRoQ0R0aExRZzdKV0k3SmVRSU91cXZldVZoU0RzaTZQcmlwVHJpNlFwTGcwS1puVnVZM1JwYjI0Z1lYTnJRMjl0Y0c5elpTaHRaWE56WVdkbGN5d2diVzlrWld3c0lISmxjR0Z5YzJVcElIc05DaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3MEtJQ0FnSUdOdmJuTjBJSFJ5WVc1elkzSnBjSFFnUFNBb2JXVnpjMkZuWlhNZ2ZId2dXMTBwTG0xaGNDZ29iU2tnUFQ0TkNpQWdJQ0FnSUNodExuSnZiR1VnUFQwOUlDZGhjM05wYzNSaGJuUW5JRDhnSit5V3RPeUxuT3lLcE8yRXRPMkt1RG9nSnlBNklDZnNncXpzbXFuc25wQTZJQ2NwSUNzZ1UzUnlhVzVuS0cwdWRHVjRkQ0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNVFV3TUNrTkNpQWdJQ0FwTG1wdmFXNG9KMXh1SnlrN0RRb2dJQ0FnY21WMGRYSnVJQ2dOQ2lBZ0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJQ0xyaklEdG1aVHRtSlVnNjZ5NDZyV3NJT3lnbk95ZWtTTHNuYlRyaTZRZ0tPcTRzT3lodENEcnJManF0YXdnNjR1azY1T3M2cml3SU95VmhPdUxtQ0RpZ0pRZzdKV0U2NTZZSU91TWdPMlpsT3F3Z0NEc25iVHJzb2dnN1lTMDdKMllJT3lnaE95eXRDRHJwNlhybmIzc25iVHJpNlFwTGlBbklDc05DaUFnSUNBZ0lDZnNncXpzbXFuc25wRHFzSUFnN1ptVTY2bTBJT3lEZ2UyWnFjSzM2NmVsNjUyOTdKMkVJT3lFcE91cWhlMlZtT3VwdEN3ZzdJcWs3WU9BN0oyOElPcTNuT3k1bWVxenZDRHNtSWpzaTV3ZzdZYWs3SmVRSU91bm51dUtsQ0JWU1NEcnJManF0YXpycGJ3ZzY2ZU02NU9rN0phMElPeWduT3lWaU8yVm1PdWR2QzVjYmljZ0t3MEtJQ0FnSUNBZ0p5MGc2NmVsNjUyOTdKMjBJT3UyZ095aHNlMlZtT3VwdENEdGpyanRsWmpxc293ZzY1Q1k2Nnk4N0phMDY1MjhPaURzbHJUcmxxUWc3Wm1VNjZtMHdyZnF1TERyaXFYc25aZ2c2Nnk0NnJXczdKMjQ3S2VBTENEcms2VHNsclRxc0lnZzdKNlE2NmFzNjRxVUlPeVd0T3VVbE95ZHVPeW5nQ2p0akozc2w0VWc3WU9BN0oyMDdZdUFMK3V6dU91c3VDL3Jzb1R0aXJ3c0lPMkdvT3lLcE8yS3VDd2c2N21JSU8yWmxPdXB0Q0RzbFlqcmdyUXNJT3V3c091RWlDRHJrN0VwTENEc2xyVHJscVFnN0lPQjdabXA3SjI0N0tlQUtPeUVzZXF6dFNEdGhyWHJzN1F2N0ppazY2V1lMKzJabGV5ZHVDRHNtcFRzc3EwdjdKV0k2NEswS1NEcXNKbnNuWUFnNnJLRExpRHF2SzBnN1pXRTdKcVU3WldjSU9xeWcrdW5qQ0RxczZqcm5id2c3WldjSU91eWlPeVhrQ0RzdFp6cmpJQWdNdXF3bk9xNWpPeW5nQ3dnN0tlbjZyS01MaURzbmJUcmxZd2djM1ZuWjJWemRHbHZiblByaXBRZzY3bUlJT3V3c095WHRDNWNiaWNnS3cwS0lDQWdJQ0FnSnkwZzZyQ1E3SjIwSU95V3RPdUtrQ0Rzb0pYcmo0UWc3SmlrNjZtMElPdXN1K3E0c091bmpDRHRsWmpzcDRBZzY2ZUk2NTI4SU9LQWxDRHFzSURzb0pYc25ZUWc3SVM0N0pxdzZyT2dJT3kwaU95VmlDQnpkV2RuWlhOMGFXOXVjK3VsdkNEdGxhanF1NWdnNjRLMDY2bTA3SVNjTENCeVpYQnNlZXlYa0NEcXNJRHNvSlhzbllRZzY3Q2Q3WjZJNnJPZ0lPdXN0T3lYaCt5ZGhDRHNsWXpyb0tUc283enJxYlFnNjQyVUlPdW5udXkybkNEc2lKZ2c3SjZJNjRxVTdLZUFJTzJWbkNEcnJManNucVhzbkx6cm9ad2c2NDJuNjdhWjdKZXM2NTI4S095WWlEb2dJdTJabGV5ZHVDRHRqSjNzbDRYc25iVHJuYnpxczZBZzZyQ0E3S0NWN1phSTdKYTA3SnFVSU9LQWxDRHRocURzaXFUdGlyanJuYnpycWJRZzdKV002NkNrN0tPODdJUzQ3SnFVSWlrdVhHNG5JQ3NOQ2lBZ0lDQWdJQ2N0SU91c3VPcTFyT3VsdkNEc29KenNsWWp0bGFBZzY1V1FJT3lFbk91aG5DRHNvSkhxdDd6c25iUWc2NHVrNjZXNElESitNK3F3bkM0ZzZyQ0JJT3lnbk95VmlPeVhsQ0RzbVp3ZzZyZTQ2NkNINnJLTUlPeU52T3VLbE95bmdDRHNuYlRzbktEcnBid2c2N2FaN0oyNDY0dWtMbHh1SnlBckRRb2dJQ0FnSUNBbkxTRHNncXpzbXFuc25wRHFzSUFnN0phNDZyaUo3WldZN0tlQUlPeVZpdXlkZ0NEcXRhenNzclFnN0tDVjY3TzBLT3lnaE8yWmxPdXlpTzJZdU1LM1ZWSk13cmZxdUlqc2xhSEN0KzJhbit5SW1DRHJrN0VwNjZXOElPeW5nT3lXdE91Q3RDRHJoS1BzcDRBZzY2ZUk2NTI4TGx4dUp5QXJEUW9nSUNBZ0lDQW5MU0R0bTRUc2hvMGc3SnFVN0xLdEtDTHJqWlFnN0tlbjZyS01JaXdnSXV1eWhPMkt2T3lhcWV5Y3ZPdWhuQ0lnNjVPeEtleWR0T3VwdENEc3A0SHNvSVFnN0tDYzdKV0k3SjJFSU9xM3VDRHJzS250bHFYc25MenJvWndnNnJPZzdMT1FJT3VMcE95TG5DRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc05DaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZJT3E0aU95bmdEb2dKeUFyRFFvZ0lDQWdJQ0FuZXlKeVpYQnNlU0k2SUNMcmpJRHRtWlFnN0oyUjY0dTFJTzJWbk91UmtDRHJyTGpzbnFVZ0tPMlZ0T3lhbE95eXRDa2lMQ0FpYzNWbloyVnpkR2x2Ym5NaU9pQmJleUowWlhoMElqb2dJdXVzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0R0bFp3ZzY2eTQ3SjZsSW4xZGZWeHVYRzRuSUNzTkNpQWdJQ0FnSUNkYjY0eUE3Wm1VWFZ4dUp5QXJJSFJ5WVc1elkzSnBjSFFOQ2lBZ0lDQXBPdzBLSUNCOUxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0RRcDlEUW9OQ2k4dklPMlVoT3VnaU95ZWhPdXpoQ2p0bFpqc25JUWc3WlNFNjZDSTdKNkVJT3VzdHV5ZGpDa2c3TGFVN0xLY0lPMkV0Q0RpZ0pRZzdaV2NJTzJabE91cHRPeWRoQ0R0bFpqc25JUWc3WlNFNjZDSTdKNkVJT3VMcU95Y2hPdWhuQ0RyZ3BqcmlLQWc2N08wNjRLMDZyT2dMQTBLTHk4Z0tpcnRsSVRyb0lqc25vVHJwNGpyaTZRZzY1U3c2NkdjS2lvZzY0eUE3SldJN0oyRUlPdXdtK3VLbE91THBDNGc3WldjSU95YWxPeXlyZXlYa0NEcmk2UWc3SXVrN0phMElPdXp0T3VDdE91S2xDRHFzb1BzbmJRZzdaVzE3SXVzT2cwS0x5OGc3WlNFNjZDSTdKNkVJT3lJbU91bmpPMkJ2Q0RzbXBUc3NxM3NuWVFnN0txODZyQ2M2Nm0wSU9xM3VPdW5qTzJCdkNEcmlwRHJvS1RzcDREcXM2QW82ckNCSURWK01URHN0SWdwSU9xMXJPdVBoU0RzZ3F6c21xbnJuNG5yajRRZzZyZTQ2NmVNN1lHOElPdUNtT3F3aE91THBDNE5DaTh2SUdkeWIzVndjem9nVzN0dVlXMWxMQ0IwWlhoMGN6cGJYWDFkSUNqdG1aVHJxYlFnN0p5RTRvYVM3SldFNjU2WUlPeUluQ2t1RFFwbWRXNWpkR2x2YmlCaGMydEhjbTkxY0hNb1ozSnZkWEJ6TENCdGIyUmxiQ3dnY21Wd1lYSnpaU3dnYlc5eVpTa2dldzBLSUNCeVpYUjFjbTRnY25WdVZIVnliaWdvS1NBOVBpQjdEUW9nSUNBZ0x5OGc2N0tFN1lxOElPeVlnZXlYcmV5ZGdDQW82N0tFN1lxOEtleWN2T3VobkNEc3NJM3NsclFnNjdPMDY0SzQ2NHVrSU9LQWxDRHJzb1R0aXJ3ZzY2eTQ2cldzNjRxVUlPdXN1T3llcGV5ZHRDRHNsWVRyaTRqcm5id2c2NCtaN0o2UklPeWR0T3VtaE95ZHRPdWR2Q0RxdDV6c3VabnNuYlFnNjR1azY2VzA2NHVrRFFvZ0lDQWdZMjl1YzNRZ2JHbHpkQ0E5SUNobmNtOTFjSE1nZkh3Z1cxMHBMbTFoY0Nnb1p5d2dhU2tnUFQ0TkNpQWdJQ0FnSUNkYkp5QXJJQ2hwSUNzZ01Ta2dLeUFuWFNBbklDc2dVM1J5YVc1bktDaG5JQ1ltSUdjdWJtRnRaU2tnZkh3Z0tDZnF0N2pybzdrbklDc2dLR2tnS3lBeEtTa3BJQ3NnS0djZ0ppWWdaeTV5YjJ4bElEMDlQU0FuNjdLRTdZcThKeUEvSUNjZ0tPdXloTzJLdkNrbklEb2dKeWNwSUNzZ0oxeHVKeUFyRFFvZ0lDQWdJQ0FvWnlBbUppQkJjbkpoZVM1cGMwRnljbUY1S0djdWRHVjRkSE1wSUQ4Z1p5NTBaWGgwY3lBNklGdGRLUzV0WVhBb0tIUXBJRDArSUNjZ0lDMGdKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLRk4wY21sdVp5aDBJSHg4SUNjbktTa3BMbXB2YVc0b0oxeHVKeWtOQ2lBZ0lDQXBMbXB2YVc0b0oxeHVKeWs3RFFvZ0lDQWdZMjl1YzNRZ2FHRnpRblJ1SUQwZ0tHZHliM1Z3Y3lCOGZDQmJYU2t1YzI5dFpTZ29aeWtnUFQ0Z1p5QW1KaUJuTG5KdmJHVWdQVDA5SUNmcnNvVHRpcnduS1RzTkNpQWdJQ0JqYjI1emRDQnJaWGtnUFNBblozSnZkWEJ6SnlBcklDaG5jbTkxY0hNZ2ZId2dXMTBwTG0xaGNDZ29aeWtnUFQ0Z0tHY2dKaVlnWnk1MFpYaDBjeUEvSUdjdWRHVjRkSE11YW05cGJpZ25KeWtnT2lBbkp5a3BMbXB2YVc0b0p5Y3BPdzBLSUNBZ0lHTnZibk4wSUdGMGRHVnRjSFFnUFNBb1lYTnJaV1JEYjNWdWRDNW5aWFFvYTJWNUtTQjhmQ0F3S1NBcklERTdEUW9nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvYTJWNUxDQmhkSFJsYlhCMEtUc05DaUFnSUNCcFppQW9ZWE5yWldSRGIzVnVkQzV6YVhwbElENGdNakF3S1NCaGMydGxaRU52ZFc1MExtTnNaV0Z5S0NrN0RRb2dJQ0FnWTI5dWMzUWdZV2RoYVc0Z1BTQnRiM0psSUh4OElHRjBkR1Z0Y0hRZ1BpQXhEUW9nSUNBZ0lDQS9JQ2ZzbmJRZzdabVU2Nm0wN0oyQUlPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA2Nis0SU91THBPdWttT3VMcEM0ZzdKV2U3SVNjSU91Q3VDRHJqSURzbFlqcXM3d2c3SmEwN1p5WXdyZnF0YXpzb2JEcXNJQWc3Wm1WN0l1azdaNklJT3VMcE91bHVDRHNnNGdnNjR5QTdKV0k2NmVNSU91Q3RPdWR2QzVjYmljTkNpQWdJQ0FnSURvZ0p5YzdEUW9nSUNBZ2NtVjBkWEp1SUNnTkNpQWdJQ0FnSUdGbllXbHVJQ3NOQ2lBZ0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJQ0x0bVpUcnFiVHNuWVFnN1pXWTdKeUVJTzJVaE91Z2lPeWVoT3V6aE91aG5DRHJncGpyaUtBZzY0dWs2NU9zNnJpd0l1dUxwQzRnN0pXRTY1Nlk2NHFVSU8yVm5DRHRtWlRycWJUc25aZ2c2Nnk0NnJXczY2VzhJTzJWbU95Y2hDRHRsSVRyb0lqc25vUW83SmlCN0pldEtTRHJpNmpzbklUcm9ad2c2NnkyN0oyQUlPcXlnK3lkdE91THBDNWNiaWNnS3cwS0lDQWdJQ0FnSnlvcTdKaUI3SmV0NjZlSTY0dWtJT3VVc091aG5Db3FJT3VNZ095VmlPeWRoQ0RyZ3JUcm5id2c0b0NVSU95WWdleVhyZXlkaENEc2hKenJvWndnN1pXcDdMbVk2ckd3NjRLWUlPeUluT3lFbk91bHZDRHJzSlRxdnJqc3A0QWc2NmVJNjUyOExseHVKeUFyRFFvZ0lDQWdJQ0FuTFNEcXNJRWc3SmlCN0pldDdKZVFJT3VNZ095VmlDQXk2ckNjTGlEcXQ3Z2c3SmlCN0pldDdKMjBJT3lYck91ZnJDRHNwSVRzbmJUcnFiUWc2NHlBN0pXSTY0K0VJQ29xNnJDWjdKMkFJT3lraENEc2lKZ3FLdXVobkNqc3BJVHJzSlRxdjRnZ1hGeHU3Snk4NjZHY0lPcTFyT3UyaEN3ZzdLU0VJT3lJbk95RW5DRHNuS0RzcDRBcExseHVKeUFyRFFvZ0lDQWdJQ0FuTFNEc21JSHNsNjNzblpnZzdKZXQ3WldnS08yRGdPeWR0TzJMZ01LMzdKV0k2NEswd3JmcnNvVHRpcndnNjVPeEtlcXp2Q0RzbTVEcnJManNuWmdnN0tDVjY3TzB3cmZzb2JEcXNiUW83SWlyN0o2UXdyZnJqSURzZzRIQ3QreWhzT3F4dENuc25ZQWc3SnlnN0tlQTdaV1k2ck9nTENEc2w0YnJpcFFnN0tDVjY3TzA2Nlc4SU95bmdPeVd0T3VDdE95bmdDRHJwNGpybmJ3dVhHNG5JQ3NOQ2lBZ0lDQWdJQ2N0SU9xem9PeTVvQ0Rxc293ZzdKZUc2NHFVSU95WWdleVhyZXlkdE91cHRDRHJqSURzbFlnZ01lcXduT3VuakNEcmdyVHFzYkRyZ3BnZzY3bUlJT3V3c095WHRPdWhuQ0Rya1pEc2xyVHJqNFFnNjVDYzY0dWtJT0tBbENEc2xyWHNwNERyb1p3ZzY3Q1U2cjY0N0tlQUlPdW5pT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDQWdKeTBnN1ptVTY2bTBJT3E0c091S3BldXFoU2pyczREcXNyM0N0KzJWdE95Z25DRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWlRyaTZRdVhHNG5JQ3NOQ2lBZ0lDQWdJQ2hvWVhOQ2RHNGdQeUFuTFNBbzY3S0U3WXE4S2V5Y3ZPdWhuQ0R0a1p6c2k1enJrSndnN0ppQjdKZXQ3SjJBSUNjZ0t5QkNWVlJVVDA1ZlVsVk1SU0E2SUNjbktTQXJEUW9nSUNBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU9xd25leXl0Q0R0bFpqcmdwanJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoY0szN0wyVTY1T2M3WTZjN0lxa0lPcTRpT3luZ0RwY2JpY2dLdzBLSUNBZ0lDQWdKM3NpWjNKdmRYQnpJam9nVzNzaWJtRnRaU0k2SUNMc21JSHNsNjBnN0oyMDY2YUVLT3llaGV1Z3BlcXp2Q0RyajVuc25id3BJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyaklEc2xZZ2c2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0p5WldGemIyNGlPaUFpN0oyMDdKeWdJTzJWbkNEcnJManNucVVpZlYxOVhYMWNiaWNnS3cwS0lDQWdJQ0FnSit5WWdleVhyZXlkZ0NEc25vWHJvS1VnN0lpYzdJU2N3cmZxc0p6c2lKanJwYndnNnJlNDY0eUE2NkdjSU95bmdPMkNxT3VMcEM1Y2JseHVKeUFyRFFvZ0lDQWdJQ0FuVyt5WWdleVhyZXV6aENEcnJManF0YXhkWEc0bklDc2diR2x6ZEEwS0lDQWdJQ2s3RFFvZ0lIMHNJRzF2WkdWc0xDQnlaWEJoY25ObEtUc05DbjBOQ2cwS0x5OGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RzblpIcmk3WHNsNURzaEp3Z1czdHVZVzFsTENCemRXZG5aWE4wYVc5dWN6cGJlM1JsZUhRc0lISmxZWE52Ym4xZGZWMGc3TGFVN0xhY0RRcG1kVzVqZEdsdmJpQndZWEp6WlVkeWIzVndjeWh5WVhjcElIc05DaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0RRb2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93MEtJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdEUW9nSUhSeWVTQjdEUW9nSUNBZ1kyOXVjM1FnYnlBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3RFFvZ0lDQWdZMjl1YzNRZ1lYSnlJRDBnUVhKeVlYa3VhWE5CY25KaGVTaHZJQ1ltSUc4dVozSnZkWEJ6S1NBL0lHOHVaM0p2ZFhCeklEb2dXMTA3RFFvZ0lDQWdZMjl1YzNRZ1ozSnZkWEJ6SUQwZ1lYSnlMbTFoY0Nnb1p5a2dQVDRnS0hzTkNpQWdJQ0FnSUc1aGJXVTZJRk4wY21sdVp5Z29aeUFtSmlCbkxtNWhiV1VwSUh4OElDY25LUzUwY21sdEtDa3NEUW9nSUNBZ0lDQnpkV2RuWlhOMGFXOXVjem9nUVhKeVlYa3VhWE5CY25KaGVTaG5JQ1ltSUdjdWMzVm5aMlZ6ZEdsdmJuTXBEUW9nSUNBZ0lDQWdJRDhnWnk1emRXZG5aWE4wYVc5dWN3MEtJQ0FnSUNBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIUjVjR1Z2WmlCNElEMDlQU0FuYzNSeWFXNW5KdzBLSUNBZ0lDQWdJQ0FnSUNBZ0lDQS9JSHNnZEdWNGREb2dlQzUwY21sdEtDa3NJSEpsWVhOdmJqb2dKeWNnZlEwS0lDQWdJQ0FnSUNBZ0lDQWdJQ0E2SUhzZ2RHVjRkRG9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VkR1Y0ZENrZ2ZId2dKeWNwTG5SeWFXMG9LU3dnY21WaGMyOXVPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNXlaV0Z6YjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcERRb2dJQ0FnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOVBpQjRMblJsZUhRcERRb2dJQ0FnSUNBZ0lEb2dXMTBzRFFvZ0lDQWdmU2twT3cwS0lDQWdJQzh2SU95ZHRPdW1oT3loc095d3FDRHNsNGJxczZBZzdLQ2M3SldJNjQrRUlPeVhodXVLbENEcXU0M3JqYkRxdUxEcnA0d2c3Sm1VN0p5ODY2bTBJTzJZbGV5TG5TRHNuYlR0ZzRqcm9ad2c2N080NjR1a0tPcXdtZXlkZ0NEc2hManNoWmpzbDVBZzdKNnM3SnFVN0xLdEtRMEtJQ0FnSUhKbGRIVnliaUJuY205MWNITXVjMjl0WlNnb1p5a2dQVDRnWnk1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElEOGdaM0p2ZFhCeklEb2diblZzYkRzTkNpQWdmU0JqWVhSamFDQW9YMlVwSUhzTkNpQWdJQ0J5WlhSMWNtNGdiblZzYkRzTkNpQWdmUTBLZlEwS0RRb3ZMeUR0akozc2w0VWc3SVM0N1lxNElPeTJsT3l5bkNEdGhMUWc0b0NVSU8yVm5DRHRqSjNzbDRYc25aZ2c2cldzN0lTeDdKcVU3SWFNS095WHJlMlZvQ3ZyckxqcXRhd3A2Nlc4SU8yVm5DRHJzb2pzbDVBZzY3TzA2NEswNnJPZ0xBMEtMeThnN0pxVTdJYU02N09FSU91Q3NlcXduT3F3Z0NEc2xZVHJpNGpybmJ3Z0tpcnNtWVRzaExIcmtKd2c3WXlkN0plRklPeUV1TzJLdUNqc3ZJRHNuYlRzaXFRcElESitNK3F3bkNvcTY2VzhJTzJHdGV5Y3ZPdWhuQ0Ryc0p2cmlwVHJpNlF1RFFvdkx5RHRnNERzbmJUdGk0REN0K3lWaU91Q3RNSzM2N0tFN1lxODdKMjBJTzJWbkNEcnFyanNuTHpyb1p3ZzdKMjg2clNBNjQrODdKVzhJTzJWbU91dmdPdWhuQ2pybExEcm9ad2c2NzJSN0pXRUlPeWhzTzJWcWUyVm1PdXB0Q0RzbHJUcXVJdnJncHpyaTZRcElPeUV1TzJLdUNEcmk2anNuSVRyb1p3ZzdLQ2M3SldJN1pXWTZyS01JTzJWbk91THBDNE5DaTh2SUdWc1pXMWxiblJ6T2lCYmUzSnZiR1VzSUhSbGVIUjlYU0FvN1ptVTY2bTBJT3ljaE9LR2t1eVZoT3VlbUNEc2lKd3BMZzBLTHk4Z2JXOXlaVDEwY25WbEtGdnN2SURzbmJUc2lxUWc2NDJVSU91d20rcTRzRjBwNjZtMElPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA2Nis0SU91Q3VDRHNoTGp0aXJqc21ZQWc2cks1N0xtWTdLZUFJT3lWaXV1S2xDRHNnNGdnN0lTNDdZcTQ2Nlc4SU95YWxPcTFyTzJWbk91THBDNE5DbVoxYm1OMGFXOXVJR0Z6YTFCdmNIVndLR1ZzWlcxbGJuUnpMQ0J0YjJSbGJDd2djbVZ3WVhKelpTd2diVzl5WlNrZ2V3MEtJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0RRb2dJQ0FnWTI5dWMzUWdjbTlzWlhNZ1BTQW9aV3hsYldWdWRITWdmSHdnVzEwcExtMWhjQ2dvWlNrZ1BUNGdVM1J5YVc1bktDaGxJQ1ltSUdVdWNtOXNaU2tnZkh3Z0p5Y3BLUzVxYjJsdUtDY3NJQ2NwT3cwS0lDQWdJR052Ym5OMElHeHBjM1FnUFNBb1pXeGxiV1Z1ZEhNZ2ZId2dXMTBwTG0xaGNDZ29aU3dnYVNrZ1BUNE5DaUFnSUNBZ0lDaHBJQ3NnTVNrZ0t5QW5MaUJiSnlBcklGTjBjbWx1Wnlnb1pTQW1KaUJsTG5KdmJHVXBJSHg4SUNjbktTQXJJQ2RkSUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoVGRISnBibWNvS0dVZ0ppWWdaUzUwWlhoMEtTQjhmQ0FuSnlrcERRb2dJQ0FnS1M1cWIybHVLQ2RjYmljcE93MEtJQ0FnSUM4dklPcXdtZXlkZ0NEdGpKM3NsNFhzbllRZzY2cUhJT3V5aU95bnVDRHJyTHZyaXBUc3A0QWc2cml3N0phMUlPS0FsQ0RzbnF6c21wVHNzcTNzbmJUcnFiUWdJdXlkdE95Z2hPcXp2Q0RyaTZUcnBiZ2c3SVM0N1lxNEl1dWx2Q0RzbXBUcXRhenRsWnpyaTZRTkNpQWdJQ0F2THlBb1lYTnJRMnhoZFdSbDdKbUFJT3F3bWV5ZGdDRHNuYlRzbktBNklPeVZpQ0RxdDdqcm42enJxYlFnN1lHMDY2R2M2NU9jNnJDQUlPcXdtZXlkZ0NEc2hManRpcmpycGJ3ZzY1aVFJT3VDdE95RW5DQmI3THlBN0oyMDdJcWtJT3VObENEcnNKdnF1TEJkNnJDQUlPdXN0T3lkbU91dnVPMlZ0T3luaE91THBDa05DaUFnSUNCamIyNXpkQ0JyWlhrZ1BTQW5jRzl3ZFhBQkp5QXJJQ2hsYkdWdFpXNTBjeUI4ZkNCYlhTa3ViV0Z3S0NobEtTQTlQaUJUZEhKcGJtY29LR1VnSmlZZ1pTNTBaWGgwS1NCOGZDQW5KeWtwTG1wdmFXNG9Kd0VuS1RzTkNpQWdJQ0JqYjI1emRDQmhkSFJsYlhCMElEMGdLR0Z6YTJWa1EyOTFiblF1WjJWMEtHdGxlU2tnZkh3Z01Da2dLeUF4T3cwS0lDQWdJR0Z6YTJWa1EyOTFiblF1YzJWMEtHdGxlU3dnWVhSMFpXMXdkQ2s3RFFvZ0lDQWdhV1lnS0dGemEyVmtRMjkxYm5RdWMybDZaU0ErSURJd01Da2dZWE5yWldSRGIzVnVkQzVqYkdWaGNpZ3BPeUF2THlEcnJMVHRsWnp0bm9nZzdJeVQ3SjIwN0tlQUlPeVZpdXF5akEwS0lDQWdJR052Ym5OMElHRm5ZV2x1SUQwZ2JXOXlaU0I4ZkNCaGRIUmxiWEIwSUQ0Z01RMEtJQ0FnSUNBZ1B5QW43SjIwSU8yTW5leVhoZXlkZ0NEc25iUWc3SVM0N0lXWTdKZVE3SVNjSU95ZHRPdXZ1Q0RyaTZUcnBKanJpNlF1SU95Vm51eUVuQ0Rzb0p6c2xZanRsWndnN0lTNDdZcTQ2NU9rNnJPOElDb3E3S0NSNnJlOHdyZnNsclR0bkpqcXNJQWc3Wm1WN0l1azdaNklJT3VMcE91bHVDRHNnNGdnN0lTNDdZcTRLaXJycDR3ZzY0SzA2NTI4S09xd21leWRnQ0RzaExqdGlyZ2c2N0NZNjdPMUlPcTRpT3luZ0NrdVhHNG5EUW9nSUNBZ0lDQTZJQ2NuT3cwS0lDQWdJSEpsZEhWeWJpQW9EUW9nSUNBZ0lDQmhaMkZwYmlBckRRb2dJQ0FnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTdZeWQ3SmVGS091THBPeWR0T3lXdk91aG5PcTN1Q2tnN0lTNDdZcTRJT3VMcE91VHJPcTRzQ0xyaTZRdUlPeVZoT3VlbU91S2xDRHRsWndnN1l5ZDdKZUY3SjJFSU95Y2hPS0drdXlWaE91ZW1PdWhuQ0RyZ3Bqc2w3VHRsWndnNnJXczdJU3g3SnFVN0lhTTY1T2s3SjIwNjR1a0tPeUVuT3VobkNEcnJMVHF0SUR0bFp3ZzY3T0U2ckNjSU91c3VPcTFyT3F3Z0NEc2xZVHJpNGpyaTZRcExpQW5JQ3NOQ2lBZ0lDQWdJQ2ZzbXBUc2hvenJwYndnNjRLeDZyQ2M2NkdjSU9xem9PeTVtT3luZ0NEcnA1RHFzNkFzSUNvcTdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdk95ZHRDRHNoSnpyb1p3ZzdKMjg2clNBNjVDY0lDTHNtWVRzaExIcmtKd2c3WXlkN0plRklPeUV1TzJLdUNJZ01uNHo2ckNjS2lycnBid2c3S0NjN0pXSTdaV1k2NTI4TGlEcXNJRWc3SVM0N1lxNDY0cVVJT3lFbk91aG5DRHJpNlRycGJnZzdLQ1I2cmU4N0oyMDdKYTA3Slc4SU8yVm5PdUxwQzVjYmljZ0t3MEtJQ0FnSUNBZ0orcXdnU0RzaExqdGlyanJpcFFnN0o2RjY2Q2w2ck84SUNvcTZyQ1o3SjJBSU95WHJlMlZvTUszNnJDWjdKMkFJT3F3bk95SW1NSzM2ckNaN0oyQUlPeUluT3lFbkNvcTdKMllJT3lhbE95R2pPdWx2Q0RycXFqcmtaQWc3WStzN1pXbzdaV2M2NHVrTGlEc2hManRpcmdnN0pXSTdKZVE3SVNjSU8yRGdPeWR0TzJMZ01LMzdKV0k2NEswd3JmcnNvVHRpcnpzbllBZzdaV2NJT3VxdU95Y3ZPdWhuQ0RycDU3c2xZVHJscWpzbHJUc29ManNsYndnN1pXYzY0dWtLT3lZaURvZzY3TzQ2Nnk0N0oyMElDSis3WldnNnJtTTdKcVVQeUxycWJRZzY3S0U3WXE4N0oyQUlGdnNsWVRyaTRqc21LUmRMMXZyaEtSZEtTNWNiaWNnS3cwS0lDQWdJQ0FnSjF2dGpKM3NsNFVnNjZ5NDdMSzBJT3Ezbk95NW1TRGlnSlFnN0p5RUlPeUtwTzJEZ095ZHZDRHFzSURzbmJUcms1enNuWmdnSWpndUlPMk1uZXlYaFNJZzdJUzU3SVdZN0oyRUlPdVVzT3VsdU91THBGMWNiaWNnS3cwS0lDQWdJQ0FnSnkwZzdZT0E3SjIwN1l1QU9pRHNwNmZzbllBZzY2cUY3SUtzNnJXc0tESitOT3lXdE95Z2lDa3NJT3lpaGVxeXNPeVd0T3V2dU1LMzY2ZUk3TG1vN1pHY0lPeVhodXlkdENoKzdKcVVMMzdyaTZRdmZ1cTVqT3lhbEQ4ZzZyaUk3S2VBS1M0ZzY3Q1k2NU9jN0l1Y0lPeVZpT3VDdENqcnM3anJyTGdwSU91bnBldWR2ZXlkaENEc21wVHNsYjN0bGJRZzdZT0E3SjIwN1l1QTY2ZU1JT3Uwa091UGhDRHJyTFRzaXFnZzdZeWQ3SmVGN0oyNDdLZUFJT3lWak9xeWpDRHRsWmpybmJ3dUlPeWJrT3V6dU95ZHRDQWk3SldNNjZhOEwrMlpsZXlkdUNMc3NwanJuN3dnNjZlSjdKZXc3WldZNjZtMElPdXp1T3VzdU95ZGhDRHF0N3pxc2JEcm9ad2c2cldzN0xLMDdabVU3WldZNjUyOExseHVKeUFyRFFvZ0lDQWdJQ0FuTFNEc2xZanJnclFvNjdPNDY2eTRLVG9nN1pXMDdKcVU3TEswTGlEdGpKRHJpNmpzbmJRZzdaV0U3SnFVN1pXWTY2bTBJQ0orN1pXZzZybU03SnFVUHlMcm9ad2c2Nnk3NnJPZ0xDRHJrSmpyajR6cnByUWc3SWlZSU95WGh1dUtsQ0RzbklUdGw1Z283SUt0N0tDY3dyZnRnNGp0aDdRZzY1T3hLZXlkZ0NEcXNyRHFzN3pycGJ3ZzY2aTg3S0NBSU9xeXZlcXpvTzJWbk91THBDNGc2ckt3NnJPOHdyZnNnNEh0ZzV3ZzdZYTE2N08wNjZtMElPeUVuT3lJb08yWWxleWN2T3VobkNEc2xZenJwckRyaTZRdVhHNG5JQ3NOQ2lBZ0lDQWdJQ2N0SU91eWhPMkt2RG9nNjdPNDY2eTQ3SjIwSUNKKzdaV2c2cm1NN0pxVVB5THJxYlFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBzSU91enVPdXN1T3lkdENEc2c0SHRtYW5zbllRZzdJU2M3SWlnN1pXWTZyT2dJT3lkdENEcnNvVHRpcnpzbmJRZzdJdWs3S0NjSU91UG1leWVrZXlkdE91cHRDRHJqNW5zbnBFZzY0K1o3SUtzS095Q3JleWduQy9zb0lEc25xVXY3SmV3NnJLd0lPMlZ0T3lnbkNEcms3RXBMQ0R0aHJYcnM3UWc3WXlkN0plRjdKMllJT3VMcU95ZHZDRHJzb1R0aXJ6c25iVHJxYlFnSXUyWmxleWR1Q0l1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ3dnSXV1THErcTRzTUszNjQrWjdKNlJJaURzb2JEdGxha2c2cmlJN0tlQUxpRHRtWlRycWJRZzZyaXc2NHFsNjZxRktPdXpnT3F5dmNLMzdaVzA3S0NjSU91VHNTbnNuWUFnNnJlNDY0eUE2NkdjSU91UmxPdUxwQzVjYmljZ0t3MEtJQ0FnSUNBZ0p5MGc3SnVRNjZ5NDdKMllJT3lnbGV1enRNSzM3S0d3NnJHMEtPeUlxK3lla01LMzdKMjA3SU9CTCt5ZHRPMlZtTUszNjR5QTdJT0JLZXlkZ0NEc25LRHNwNER0bFpqcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzY2ZUk2NTI4TGx4dUp5QXJEUW9nSUNBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU9xd25leXl0Q0R0bFpqcmdwanJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoY0szN0wyVTY1T2M3WTZjN0lxa0lPcTRpT3luZ0RwY2JpY2dLdzBLSUNBZ0lDQWdKM3NpYzJWMGN5STZJRnQ3SW5KbFlYTnZiaUk2SUNMc25iUWc3SVM0N1lxNDdKMllJT3V3cWUyV3BleWRoQ0R0bFp6cXRhM3NsclFnN1pXY0lPdXN1T3llcGV5Y3ZPdWhuQ0lzSUNKbGJHVnRaVzUwY3lJNklGdDdJbkp2YkdVaU9pQWk3SmV0N1pXZ0lpd2dJblJsZUhRaU9pQWk2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSjlMQ0F1TGk1ZGZTd2dMaTR1WFgxY2JpY2dLdzBLSUNBZ0lDQWdKK3lYcmUyVm9PeWRnQ0Rzbm9Ycm9LVWc3SWljN0lTYzY0eUE2NkdjT2lBbklDc2djbTlzWlhNZ0t5QW5YRzVjYmljZ0t3MEtJQ0FnSUNBZ0oxdnRqSjNzbDRVZzdKcVU3SWFNWFZ4dUp5QXJJR3hwYzNRTkNpQWdJQ0FwT3cwS0lDQjlMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdEUXA5RFFvTkNpOHZJTzJNbmV5WGhTRHNuWkhyaTdYc2w1RHNoSndnZTNObGRITTZJRnQ3Y21WaGMyOXVMQ0JsYkdWdFpXNTBjenBiZTNKdmJHVXNkR1Y0ZEgxZGZWMTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa05DbVoxYm1OMGFXOXVJSEJoY25ObFVHOXdkWEFvY21GM0tTQjdEUW9nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93MEtJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc05DaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3cwS0lDQWdJR052Ym5OMElITmxkSE5KYmlBOUlFRnljbUY1TG1selFYSnlZWGtvYnlBbUppQnZMbk5sZEhNcElEOGdieTV6WlhSeklEb2dXMTA3RFFvZ0lDQWdZMjl1YzNRZ2MyVjBjeUE5SUhObGRITkpiZzBLSUNBZ0lDQWdMbTFoY0Nnb2MzUXBJRDArSUNoN0RRb2dJQ0FnSUNBZ0lISmxZWE52YmpvZ1UzUnlhVzVuS0NoemRDQW1KaUJ6ZEM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa3NEUW9nSUNBZ0lDQWdJR1ZzWlcxbGJuUnpPaUJCY25KaGVTNXBjMEZ5Y21GNUtITjBJQ1ltSUhOMExtVnNaVzFsYm5SektRMEtJQ0FnSUNBZ0lDQWdJRDhnYzNRdVpXeGxiV1Z1ZEhNTkNpQWdJQ0FnSUNBZ0lDQWdJQ0FnTG0xaGNDZ29aV3dwSUQwK0lDaDdJSEp2YkdVNklGTjBjbWx1Wnlnb1pXd2dKaVlnWld3dWNtOXNaU2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd2dkR1Y0ZERvZ1UzUnlhVzVuS0NobGJDQW1KaUJsYkM1MFpYaDBLU0I4ZkNBbkp5a3VkSEpwYlNncElIMHBLUTBLSUNBZ0lDQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaGxiQ2tnUFQ0Z1pXd3VkR1Y0ZENrTkNpQWdJQ0FnSUNBZ0lDQTZJRnRkTEEwS0lDQWdJQ0FnZlNrcERRb2dJQ0FnSUNBdVptbHNkR1Z5S0NoemRDa2dQVDRnYzNRdVpXeGxiV1Z1ZEhNdWJHVnVaM1JvS1RzTkNpQWdJQ0J5WlhSMWNtNGdjMlYwY3k1c1pXNW5kR2dnUHlCelpYUnpJRG9nYm5Wc2JEc05DaUFnZlNCallYUmphQ0FvWDJVcElIc05DaUFnSUNCeVpYUjFjbTRnYm5Wc2JEc05DaUFnZlEwS2ZRMEtEUW92THlEcmpJRHRtWlR0bUpVZzdLQ2M3SjZSSU95ZGtldUx0ZXlYa095RW5DQjdjbVZ3Ykhrc0lITjFaMmRsYzNScGIyNXpXMTE5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tOQ21aMWJtTjBhVzl1SUhCaGNuTmxRMjl0Y0c5elpTaHlZWGNwSUhzTkNpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3RFFvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3cwS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnWTI5dWMzUWdieUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdEUW9nSUNBZ1kyOXVjM1FnY21Wd2JIa2dQU0JUZEhKcGJtY29LRzhnSmlZZ2J5NXlaWEJzZVNrZ2ZId2dKeWNwTG5SeWFXMG9LVHNOQ2lBZ0lDQmpiMjV6ZENCemRXZG5aWE4wYVc5dWN5QTlJRUZ5Y21GNUxtbHpRWEp5WVhrb2J5QW1KaUJ2TG5OMVoyZGxjM1JwYjI1ektRMEtJQ0FnSUNBZ1B5QnZMbk4xWjJkbGMzUnBiMjV6RFFvZ0lDQWdJQ0FnSUNBZ0xtMWhjQ2dvZUNrZ1BUNGdLSHNnZEdWNGREb2dVM1J5YVc1bktDaDRJQ1ltSUhndWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd2djbVZoYzI5dU9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmU2twRFFvZ0lDQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb2VDa2dQVDRnZUM1MFpYaDBLUTBLSUNBZ0lDQWdPaUJiWFRzTkNpQWdJQ0JwWmlBb2NtVndiSGtnZkh3Z2MzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0tTQnlaWFIxY200Z2V5QnlaWEJzZVN3Z2MzVm5aMlZ6ZEdsdmJuTWdmVHNOQ2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzdKV0U2NTZZNjZHY0lDb3ZJSDBOQ2lBZ2NtVjBkWEp1SUc1MWJHdzdEUXA5RFFvTkNpOHZJT3V5aU95WHJTRHNuWkhyaTdYc2w1RHNoSndnZTNSeVlXNXpiR0YwWldRc0lHUnBjbVZqZEdsdmJuMGc3TGFVN0xhY0lDanN2WlRyazV6dGpwenNpcVRDdCt5Vm51dVNwQ0RzbnFIcmk3UWc3WmVJN0pxcEtRMEtablZ1WTNScGIyNGdjR0Z5YzJWVWNtRnVjMnhoZEdVb2NtRjNLU0I3RFFvZ0lHeGxkQ0J6SUQwZ1UzUnlhVzVuS0hKaGR5a3VkSEpwYlNncExuSmxjR3hoWTJVb0wxNWdZR0FvUHpwcWMyOXVLVDljY3lvdmFTd2dKeWNwTG5KbGNHeGhZMlVvTDF4ekttQmdZQ1F2YVN3Z0p5Y3BPdzBLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNOQ2lBZ2FXWWdLRzBwSUhNZ1BTQnRXekJkT3cwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93MEtJQ0FnSUdOdmJuTjBJSFJ5WVc1emJHRjBaV1FnUFNCVGRISnBibWNvS0c4Z0ppWWdieTUwY21GdWMyeGhkR1ZrS1NCOGZDQW5KeWt1ZEhKcGJTZ3BPdzBLSUNBZ0lHbG1JQ2gwY21GdWMyeGhkR1ZrS1NCeVpYUjFjbTRnZXlCMGNtRnVjMnhoZEdWa0xDQmthWEpsWTNScGIyNDZJRk4wY21sdVp5Z29ieUFtSmlCdkxtUnBjbVZqZEdsdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOU93MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURzbFlUcm5wanJvWndnS2k4Z2ZRMEtJQ0J5WlhSMWNtNGdiblZzYkRzTkNuME5DZzBLTHk4ZzdKMlI2NHUxN0plUTdJU2NJSHQwWlhoMExDQnlaV0Z6YjI1OUlPdXdzT3lYdENEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwRFFwbWRXNWpkR2x2YmlCd1lYSnpaVk4xWjJkbGMzUnBiMjV6S0hKaGR5a2dldzBLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc05DaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4YlcxeHpYRk5kS2x4ZEx5azdEUW9nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNOQ2lBZ2RISjVJSHNOQ2lBZ0lDQmpiMjV6ZENCaGNuSWdQU0JLVTA5T0xuQmhjbk5sS0hNcE93MEtJQ0FnSUdsbUlDaEJjbkpoZVM1cGMwRnljbUY1S0dGeWNpa3BJSHNOQ2lBZ0lDQWdJSEpsZEhWeWJpQmhjbklOQ2lBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIc2dkR1Y0ZERvZ1UzUnlhVzVuS0NoNElDWW1JSGd1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lCVGRISnBibWNvS0hnZ0ppWWdlQzV5WldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZTa3BEUW9nSUNBZ0lDQWdJQzVtYVd4MFpYSW9LSGdwSUQwK0lIZ3VkR1Y0ZENrN0RRb2dJQ0FnZlEwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNsWVRybnBqcm9ad2dLaThnZlEwS0lDQnlaWFIxY200Z1cxMDdEUXA5RFFvTkNpOHZJT3Vobk9xM3VPeWR1Q0R0bFlUc21wVEN0KzJWbk91UGhDRHN0SWpxczd3ZzdJT0I3WU9jN0oyOElPdVZqQ0F2YUdWaGJIUm9JT3loc08yYWpPcXdnQ0RzbUtUcnFiUWc2NUtrN0plUTdJU2NJT3liak91d2pleVhoZXlkaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwNjdPNDY0dWtJQ2d6TU95MGlPeVhrQ0F4NjdLSTY2ZU1LUzROQ2k4dklPeUVzZXF6dGUyVm1PdXB0Q0Rxc3JEcXM3d2c3Wlc0NjVPazY1K3M2ckNBSUdOc1lYVmtaVk4wWVhSMWN6MG5iMnNuNjZHY0lPdVFtT3VQak91bXJPdXZnT3VobkN3ZzdKNnM2NkdjNnJlNDdKMjRJTzJiaENEcnNvVHRpcnpzbmJRZzdLQ0E3S0NJNjZHY0lQQ2ZuNkxzbkx6cm9ad2c2N08xNnJlQTdaV2M2NHVrTGcwS0x5OGdLTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJvWnpxdDdqc25iZ2c3TEM5N0oyRUlPeVhzQ0Rya3FRZzdLTzg2cml3N0tDQjdKeTg2NkdjSUM5b1pXRnNkR2pycGJ3ZzdLR3c3WnFNN1pXWTY0cVVJT3F5ZytxenZDRHNwNTNzbllRZzdKMjA2Nk9zNjR1a0tRMEtMeThnN1pXYzY0K0VJT3kwaU9xenZPdVBoQ0Rxc0puc25ZQWc2cks5NjZHYzY2R2NJT3V6dGVxM2dPeUxuTzJDcU91THBDRGlnSlFnNnJTQTY2YXM3SjZRNnJDQUlPMlZuT3VQaE91bHZDRHNtS3pyb0tUc283enFzYkRyZ3BnZzdaV2M2NCtFNnJDQUlPeTBpT3E0c08yWmxPdVFtT3VwdEEwS0x5OGc3SUtzN0pxcDdKNlE2ckNBSU95VmhPdXN0T3F5Zyt1UGhDRHNsWWdnNjRpTTY1K3M2NCtFSU91eWhPMkt2T3lkdENEd241K2k3Snk4NjZHY0lPdVBqT3lWaE95WXFPdUxwQzRnN1pXYzY0K0U3SmVRSU9xeHVPdW1zQ0R0bUxqc3RwenNuWUFnNnJHdzdLQ0k2NUNZNjYrQTY2R2NJT3lDck95YXFldWZpZXlkZ0NEc2xZZ2c2NEtZNnJDRTY0dWtEUXBzWlhRZ2JHRnpkRUYxZEdoU1pYUnllVUYwSUQwZ01Ec05DbVoxYm1OMGFXOXVJSEpsZEhKNVFYVjBhRWxtVG1WbFpHVmtLQ2tnZXcwS0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklDRTlQU0FuWTJ4aGRXUmxMV3h2WjI5MWRDY2dKaVlnWTJ4aGRXUmxVM1JoZEhWeklDRTlQU0FuWTJ4aGRXUmxMV3hwYldsMEp5a2djbVYwZFhKdU93MEtJQ0JwWmlBb2QyRnBkR1Z5SUh4OElFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQQ0F6TURBd01Da2djbVYwZFhKdU95QXZMeURzcDRUdGxva2c3S1NSSU8yRXRDRHJzS250bGJRZzZyaUk3S2VBSUNzZ016RHN0SWdnNnJDRTZyS3BEUW9nSUd4aGMzUkJkWFJvVW1WMGNubEJkQ0E5SUVSaGRHVXVibTkzS0NrN0RRb2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdKNnM3Wm1WN0oyNElPeUxuT3VQaE9LQXBpY3BPdzBLSUNCeWRXNVVkWEp1S0NncElEMCtJQ2Zyb1p6cXQ3anNuYmdnN1ptVjdKMjQ3SnFwN0oyMDY0dWtMaUFpVDBzaTY1Mjg2ck9nNjZlTUlPdUx0ZTJWbU91ZHZDNG5LUzUwYUdWdUtBMEtJQ0FnSUNncElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdabVY3SjI0NjVDb0lPS0FsQ0Rzb0pYc2c0RWc3SU9CN1lPYzY2R2NJT3V6dGVxM2dDNG5LU3dOQ2lBZ0lDQW9aU2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lWaE95bmdTRHJvWnpxdDdqc25iZ2c3SldJSU91UXFEb25MQ0JUZEhKcGJtY29aUzV0WlhOellXZGxLUzV6YkdsalpTZ3dMQ0E0TUNrcERRb2dJQ2s3RFFwOURRb05DaTh2SU95THBPMk1xQ0RzblpIcmk3WHNuWVFnN0lLczY1Nk03SnFwSU95VmlPdUN0T3VobkNEcnM0RHRtWmdnNG9DVUlPeWJrT3lkdUNqcm9aenF0N2pzbmJndjdJU2s3TG1ZS2V5ZHRDRHRqSXpzbFlYcmtKd2c2cks5N0pxdzdKZVVJT3EzdUNEc2xZanJnclRycGJ3c0lPeVZoT3VMaU91cHRDRHNvSkhya1pEc2xyUXI3SnVRNjZ5NDdKMkVJT3V6dE91Q3VPdUxwQTBLWm5WdVkzUnBiMjRnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0J3Y21WbWFYZ3BJSHNOQ2lBZ2FXWWdLR1VnSmlZZ1pTNXRaWE56WVdkbElEMDlQU0JNVDBkSlRsOUhWVWxFUlNrZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUV4UFIwbE9YMGRWU1VSRkxDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXeHZaMjkxZENjZ2ZUc05DaUFnYVdZZ0tHVWdKaVlnWlM1dFpYTnpZV2RsSUQwOVBTQk1TVTFKVkY5SFZVbEVSU2tnY21WMGRYSnVJSHNnWlhKeWIzSTZJRXhKVFVsVVgwZFZTVVJGTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFd4cGJXbDBKeUI5T3cwS0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25LU0I3RFFvZ0lDQWdjbVYwZFhKdUlIc2daWEp5YjNJNklDZnNuYlFnVUVQc2w1QWdRMnhoZFdSbElFTnZaR1VvWTJ4aGRXUmxLZXF3Z0NEc2hLVHN1Wmpyajd3ZzdKNkk3S2VBSU95Vml1eVZoT3lhbENEaWdKUWc3SVNrN0xtWTdaV1k2ck9nSU91aG5PcTN1T3lkdU8yVm5DRHJrcVFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Snl3Z2NISnZZbXhsYlRvZ0oyTnNZWFZrWlMxdGFYTnphVzVuSnlCOU93MEtJQ0I5RFFvZ0lISmxkSFZ5YmlCN0lHVnljbTl5T2lCd2NtVm1hWGdnS3lBb1pTQW1KaUJsTG0xbGMzTmhaMlVnUHlCbExtMWxjM05oWjJVZ09pQlRkSEpwYm1jb1pTa3BJSDA3RFFwOURRb05DbVoxYm1OMGFXOXVJSEpsWVdSQ2IyUjVLSEpsY1NrZ2V3MEtJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVVwSUQwK0lIc05DaUFnSUNCc1pYUWdZbTlrZVNBOUlDY25PdzBLSUNBZ0lISmxjUzV2YmlnblpHRjBZU2NzSUNoaktTQTlQaUI3SUdKdlpIa2dLejBnWXpzZ2ZTazdEUW9nSUNBZ2NtVnhMbTl1S0NkbGJtUW5MQ0FvS1NBOVBpQjdEUW9nSUNBZ0lDQjBjbmtnZXlCeVpYTnZiSFpsS0VwVFQwNHVjR0Z5YzJVb1ltOWtlU2twT3lCOUlHTmhkR05vSUNoZlpTa2dleUJ5WlhOdmJIWmxLSHQ5S1RzZ2ZRMEtJQ0FnSUgwcE93MEtJQ0I5S1RzTkNuME5DZzBLWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3MEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0U0dWaFpHVnljeWM2SUNkRGIyNTBaVzUwTFZSNWNHVW5MQTBLZlRzTkNtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXcwS0lDQnlaWE11ZDNKcGRHVklaV0ZrS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MFpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2dZMmhoY25ObGREMTFkR1l0T0NjZ2ZTd2dRMDlTVTE5SVJVRkVSVkpUS1NrN0RRb2dJSEpsY3k1bGJtUW9TbE5QVGk1emRISnBibWRwWm5rb2IySnFLU2s3RFFwOURRb05DbU52Ym5OMElITmxjblpsY2lBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtHRnplVzVqSUNoeVpYRXNJSEpsY3lrZ1BUNGdldzBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0owOVFWRWxQVGxNbktTQjdJSEpsY3k1M2NtbDBaVWhsWVdRb01qQTBMQ0JEVDFKVFgwaEZRVVJGVWxNcE95QnlaWFIxY200Z2NtVnpMbVZ1WkNncE95QjlEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblIwVlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMmhsWVd4MGFDY3BJSHNOQ2lBZ0lDQnlaWFJ5ZVVGMWRHaEpaazVsWldSbFpDZ3BPeUF2THlEcm9aenF0N2pzbmJnZzdaV0U3SnFVSU95RGdlMkRuT3VwdENEc25xenRtWlhzbmJnZzdJdWM2NCtFSU9LQWxDRHNucXpyb1p6cXQ3anNuYmpzbmJRZzY0R2Q2NEtzN0p5ODY2bTBJT3VMcE95ZGpDRHNvYkR0bW96cnRvRHRoTEFnY0hKdllteGxiZXlkdENEdGtvRHJwckRyaTZRTkNpQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V3MEtJQ0FnSUNBZ2IyczZJSFJ5ZFdVc0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjc0lIWTZJRUpTU1VSSFJWOVdMQ0JrYVhJNklGOWZaR2x5Ym1GdFpTd2dMeThnZHNLM1pHbHlPaURxdGF6cnNvVHNvSVF2N0plSjY1cXg3WldjSU95Q3JPdXp1T3lkdENEcmxxQWc3SjZJNjRxVTdLZUFJT3luaE91THFPeWFxUTBLSUNBZ0lDQWdiVzlrWld3NklHTjFjbkpsYm5STmIyUmxiQ3dnYlc5a1pXeHpPaUJCVEV4UFYwVkVYMDFQUkVWTVV5d2daWGhoYlhCc1pYTTZJRVZZUVUxUVRFVlRMbXhsYm1kMGFDd2daM1ZwWkdVNklFZFZTVVJGTG14bGJtZDBhQ3dnY21WaFpIazZJSGRoY20xbFpGVndMQTBLSUNBZ0lDQWdjSEp2WW14bGJUb2dLR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdKMjlySnlCOGZDQmpiR0YxWkdWVGRHRjBkWE1nUFQwOUlHNTFiR3dwSUQ4Z2JuVnNiQ0E2SUdOc1lYVmtaVk4wWVhSMWN5d05DaUFnSUNBZ0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3TkNpQWdJQ0FnSUhObGNuWmxaRG9nYzNSaGRITXVjMlZ5ZG1Wa0xDQnNZWE4wUVhRNklITjBZWFJ6TG14aGMzUkJkQ3dnYkdGemRGUmxlSFE2SUhOMFlYUnpMbXhoYzNSVVpYaDBMQ0JzWVhOMFUyVmpPaUJ6ZEdGMGN5NXNZWE4wVTJWakxBMEtJQ0FnSUgwcE93MEtJQ0I5RFFvZ0lDOHZJTzJVak91ZnJPcTN1T3lkdUNEc2k2enNucVhyc0pYcmo1a2c0b0NVSU91Qml1cTRzT3VwdENEc25JUWc2ckNRN0l1Y0lPMkRnT3lkdE91b3VPcXdnQ0RyaTZUcnBxenJwYndnNjRHSTY0dWtEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTlvWldGeWRHSmxZWFFuS1NCN0RRb2dJQ0FnYkdGemRFSmxZWFFnUFNCRVlYUmxMbTV2ZHlncE93MEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxJSDBwT3cwS0lDQjlEUW9nSUM4dklPdWhuT3EzdU95ZHVDRGlnSlFnN1pTTTY1K3M2cmU0N0oyNDdKMllJRnZ3bjUrZ0lPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c3WldFN0pxVVhjSzNXL0NmbEpGZElPdXloTzJLdk95ZHRDRHRtTGpzdHB6dGxaenJpNlF1RFFvZ0lDOHZJT3E0c091enVDanJ1SXpybmJ6c21yRHNvSUFnN0tlQjdaYUpLVG9nWUdOc1lYVmtaU0JoZFhSb0lHeHZaMmx1SUMwdFkyeGhkV1JsWVdsZzY2VzhJT3lJcU95ZGdDRHRsSVRyb1p6c2hManNpcVRyb1p3ZzdJdWs3WmFKSU9LQWxDRHJxWlRyaWJRZzdKZUc3SjIwSU9xenAreWVwU0RydUl6cm5ienNtckRzb0lEcnBid2c3SmUwNnJPZ0xBMEtJQ0F2THlBZ0lHeHZZMkZzYUc5emRDRHNpSmpzaTZBZzdZK3M3WXE0NjZHY0lPcXlzT3F6dk91bHZDRHNucERyajVrZzdJaVk2NkM1N1pXYzY0dWtLT3lMcE95NG9Ub2c3WmVrNjVPYzY2YXM3SXFrN0plUTdJU2M2NCtFSU91NGpPdWR2T3lhc095Z2dDRHNsN1RycHJ3Z0t5Qk1TVk5VUlU0ZzdabVY3SjI0TENBeU1ESTJMVEEzS1M0TkNpQWdMeThnSUNEdGhMRHJyN2pyaEpEc25iUWc3Wm1VNjZtMDdKZVFJT3lnaE8yWWdDRHNsWWdnNjV5czY0dWtMaURydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNDY2ZU1JTzJWbU91cHRDRHJnWjB1RFFvZ0lDOHZJTzJQdE91d3NTanRoTERycjdqcmhKQXBPaURzbnBEcmo1a2c3Sm1FNjZPTTZyQ0FJT3VuaWUyZWpDRHRtWmpxc3IwbzY3aU02NTI4N0pxdzdLQ0E2ckNBSUd4dlkyRnNhRzl6ZE95WGtDRHJxcnNnNjR1LzdKV0VJT3k5bE91VG5PcXdnQ0RyczdUc25iVHJpcFFnNnJLOTdKcXdLZXlYa095RW5BMEtJQ0F2THlBZ0lPdWhuT3EzdU95ZHVDRHJqSURxdUxBZzdLU1JJT3V5aE8yS3ZPeWRoQ0RybUpBZzY0aUU2NlcwNjZtMExDRHN2WlRyazV6cnBid2c2N2FaN0plczY0U2o3SjJFSU95SW1DRHNub2pyaXBRZzdZU3c2Nis0NjRTUUlPdXdxZXlMbmV5Y3ZPdWhuQ0Rzb0lUdG1aanRsWnpyaTZRdURRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXZjR1Z1TFd4dloybHVKeWtnZXcwS0lDQWdJR052Ym5OMElHSnZaSGtnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93MEtJQ0FnSUdOdmJuTjBJSE4zYVhSamFFMXZaR1VnUFNBaElTaGliMlI1SUNZbUlHSnZaSGt1YzNkcGRHTm9RV05qYjNWdWRDazdJQzh2SU9xemhPeWdsU0Rzb0lUdG1aZ2dQU0RzaTV6dGdhenJwcjhnN0xDOTdKeTg2NkdjSU95WHRPeVd0Q0RxczRUc29KWHNuWVFnNnJPZzY2VzhJT3lJbUNEc25vanFzb3dOQ2lBZ0lDQjBjbmtnZXcwS0lDQWdJQ0FnTHk4Z1kyeGhkV1JsNnJDQUlPeVhodXljdk91cHRDRHNsNnpxdUxEc2hKd2c2NEdLNjRxVTY0dWtMaUJ6YUdWc2JEcDBjblZsNjUyOElHTnNZWFZrWmVxd2dDRHNsNGJzbHJUcmo0UWc3SVc0N0oyQUlPeWdsZXlEZ1NEc2k2VHRsb25yajd3TkNpQWdJQ0FnSUM4dklITndZWGR1N0oyWUlDZGxjbkp2Y2lmcXNJQWc3SldJSU91Y3FPcXpvQ3dnN0ppSTdLQ0U3SmVVSU9xM3VPdU1nT3VobkNCdmF6cDBjblZsNjZXOElPdVBqT3VncE95a3JPdUxwQ0RpZ0pRTkNpQWdJQ0FnSUM4dklPMlVqT3Vmck9xM3VPeWR1T3lkZ0NBaTY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95WHRPeVhpT3lXdE95YWxDTHJuYnpxczZBZzdaV1k2NHFVNjQyd0lPeUxwT3lnbk91aG5PdUtsQ0RzbFlUcnJMVHFzb1ByajRRZzdKV0lJT3VjcU91S2xDRHNnNEh0ZzV6cXNJQWc2NUNRNjR1a0tPeUxwT3lnbkNEc2k2RHFzNkFwTGcwS0lDQWdJQ0FnYVdZZ0tHTnNZWFZrWlZOMFlYUjFjeUE5UFQwZ0oyTnNZWFZrWlMxdGFYTnphVzVuSnlrZ2V3MEtJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNU3dnZXcwS0lDQWdJQ0FnSUNBZ0lHVnljbTl5T2lBbjdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95WGh1eVd0T3lhbENEaWdKUWc3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKMjBJT3VRbU91S2xPeW5nQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGljc0RRb2dJQ0FnSUNBZ0lDQWdjSEp2WW14bGJUb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp5d05DaUFnSUNBZ0lDQWdmU2s3RFFvZ0lDQWdJQ0I5RFFvZ0lDQWdJQ0F2THlEc3A0VHRsb2tnN0tTUjdKMjQ2NDJ3SU91WWtDRHJpSXpyb0lEcmk2UWc0b0NVSU9xNGlPdXdxU2cyTU95MGlDRHJnclFwSU91THBPeUxuQ0RyaUlUcnBiZ2c2ckcwSUNMc3NMM3NuWVFnNjR1cjdKV1k2NHVrTCt1cXV5RHJ0S1RyaTZRaTdKZVFJT3F3Z09xNWpPeWFzT3V2Z091aG5DRHJ1SXpybmJ6c21yRHNvSURyb1p3ZzdKNnM3SXVjNjQrRTdaV2M2NHVrTGcwS0lDQWdJQ0FnTHk4ZzdaV2M3TEM0SU91U3BPeVhrT3VQaENEcm1KQWc2NGlFNjZXMDY0cVVJT3F4dENEcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wSU95OW5PdXdzZXlYa0NEcnFyc2c2NHUvN0pXRUlPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzdKV0lJT3VRbU91S2xDRHRtWmpxc3Izc25id2c3SWlZSU95ZWlPeWN2T3VMaUEwS0lDQWdJQ0FnTHk4ZzZyZTQ2NVdNNjZlTUlPeTlsT3VUbk91bHZDRHJ0cG5zbDZ6cmhLUHNuWVFnN0lpWUlPeWVpT3VLbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJTzJQdE91d3NlMlZuT3VMcENBbzY1R1FJT3V5aU95bnVDRHRnYlRycHEzc2w1QWc3WVN3NjYrNDY0U1E3SjIwSU8yS2dPeVd0T3VDbU95WXBPdXB0Q0RyaTdudG1hbnNpcVRybjczcmk2UXBMZzBLSUNBZ0lDQWdZMjl1YzNRZ2MzUmhiR1VnUFNCc2IyZHBibEJ5YjJNZ0ppWWdLRVJoZEdVdWJtOTNLQ2tnTFNCc2IyZHBibE4wWVhKMFpXUkJkQ0ErSURZd01EQXdLVHNOQ2lBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJNZ0ppWWdjM1JoYkdVcElIc05DaUFnSUNBZ0lDQWdhMmxzYkV4dloybHVVSEp2WXlncE93MEtJQ0FnSUNBZ0lDQnBaaUFvSVc5d1pXNU1iMmRwYmxSbGNtMXBibUZzS0NrcElIc05DaUFnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TVN3Z2V5Qmxjbkp2Y2pvZ0oreWR0Q0JQVSt5WGtPeUVvQ0RzbnBEcmo1bnNuTHpyb1p3ZzY2cTdJT3lYdE95V3RPeWFsQ0RpZ0pRZzdZU3c2Nis0NjRTUTdKZVE3SVNjSUdOc1lYVmtaU0RzaTZUdGxva2c3WnVFSUM5c2IyZHBiaUR0bGJRZzdLTzg3SVM0N0pxVUxpY2dmU2s3RFFvZ0lDQWdJQ0FnSUgwTkNpQWdJQ0FnSUNBZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDaHlaV0Z6YjI0ZzdLZUE3S0NWS1NEaWdKUWc3S2VFN1phSklPeWtrU0R0aExUc25ZUWdVMFZUVTBsUFRsOUVTVVZFNjZHY0lPdUJuZXVDdE91cHRDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtc091THBBMEtJQ0FnSUNBZ0lDQnJhV3hzVUhKdll5Z242NkdjNnJlNDdKMjQ3SjJFSU95bmhPMldpZTJWbU91S2xDRHNwSkhzbmJUcm5id2c3SnFVN0xLdDdKMkVJT3lra2V1THFPMldpT3lXdE95YWxDRGlnSlFnNjZHYzZyZTQ3SjI0SU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5LVHNOQ2lBZ0lDQWdJQ0FnWVdOamIzVnVkRU5oWTJobExtRjBJRDBnTURzTkNpQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0R0ajdUcnNMRWc0b0NVSU8yRXNPdXZ1T3VFa0NEcnNLbnNpNTNzbkx6cm9ad2c3S0NFN1ptWUxpY3BPdzBLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2diVzlrWlRvZ0ozUmxjbTFwYm1Gc0p5QjlLVHNOQ2lBZ0lDQWdJSDBOQ2lBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc2dMeThnN0pXZTdJU2dJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqc25iUWc2NHlBNnJpd0lPeWtrZXlkdE91cHRDRHNvSkhxczZBZzdJT0k2NkdjSU95WHNPdUxwQ0FvN0xDOTdKMkVJT3VMcSt5Vm1PcXhzT3VDbUNEcmk2VHNpNXdnNjRpRTY2VzRJT3F5dmV5YXNDa05DaUFnSUNBZ0lHeHZaMmx1VTNSaGNuUmxaRUYwSUQwZ1JHRjBaUzV1YjNjb0tUc05DaUFnSUNBZ0lDOHZJRUpTVDFkVFJWTHJpcFFnNnJHMDY1T2M2NmFzN0tlQUlPeVZpdXVLbE91THBDRGlnSlFnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdLZUI3S0NSSU95WHNPdUxwQ0FvN0p5RUlDZENVazlYVTBWU0lPcXdnT3Vobk95eGhPcTRzT3VLbENEc29KenFzYkRya0pEcmk2UW5JT3lqdk95RW5TRHNzTGpxczZBcERRb2dJQ0FnSUNCamIyNXpkQ0JzYjJkcGJrVnVkaUE5SUVOTVFWVkVSVjlGVGxZN0RRb2dJQ0FnSUNCamIyNXpkQ0IwYUdselRHOW5hVzRnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3lkaGRYUm9KeXdnSjJ4dloybHVKeXdnSnkwdFkyeGhkV1JsWVdrblhTd2dldzBLSUNBZ0lDQWdJQ0J6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJzYjJkcGJrVnVkaXdnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0IzYVc1a2IzZHpTR2xrWlRvZ2RISjFaU3dOQ2lBZ0lDQWdJQ0FnWkdWMFlXTm9aV1E2SUhCeWIyTmxjM011Y0d4aGRHWnZjbTBnSVQwOUlDZDNhVzR6TWljc0lDOHZJR3RwYkd4TWIyZHBibEJ5YjJQc25aZ2c2cmU0NjZPNUlHdHBiR3pzbXFrZ0tHdHBiR3hRY205ajZyTzhJT3VQbWV5ZHZDRHRqS2p0aExRcERRb2dJQ0FnSUNCOUtUc05DaUFnSUNBZ0lHeHZaMmx1VUhKdll5QTlJSFJvYVhOTWIyZHBianNOQ2lBZ0lDQWdJSFJvYVhOTWIyZHBiaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdsbUlDaHNiMmRwYmxCeWIyTWdQVDA5SUhSb2FYTk1iMmRwYmlrZ2JHOW5hVzVRY205aklEMGdiblZzYkRzZ2ZTazdEUW9nSUNBZ0lDQjBhR2x6VEc5bmFXNHViMjRvSjJOc2IzTmxKeXdnS0dOdlpHVXBJRDArSUhzTkNpQWdJQ0FnSUNBZ2FXWWdLR3h2WjJsdVVISnZZeUFoUFQwZ2RHaHBjMHh2WjJsdUtTQnlaWFIxY200N0RRb2dJQ0FnSUNBZ0lHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0RRb2dJQ0FnSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk5VYVcxbGNpa2dleUJqYkdWaGNsUnBiV1Z2ZFhRb2JHOW5hVzVRY205alZHbHRaWElwT3lCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUc1MWJHdzdJSDBOQ2lBZ0lDQWdJQ0FnWVdOamIzVnVkRU5oWTJobExtRjBJRDBnTURzZ0x5OGc3SU9JSU9xemhPeWdsZXlkdkNEc2lKZ2c3SjZJN0p5ODY0dUlJT3VMcE95ZGpDQXZhR1ZoYkhSb0lPdVZqQ0RyaTZUc2k1d2c3SjI5NnJpd0RRb2dJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeWdpT3l3cUNEc29vWHJvNHdnS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93MEtJQ0FnSUNBZ0lDQXZMeURzZ3F6cm5venNuYlFnNjZHYzZyZTQ3SjI0N1pXZ0lPeUxuT3F3aE91UGhDRHNsNGJzbmJRZzZyT242N0NVNjZHY0lPeUxwTzJNcU91aG5DRHJnWjNyZ3F6cmk2UWdQU0JqYkdGMVpHWHFzSUFnN0plRzZyR3c2NEtZSU95THBPMldpZXlkdENEc2xZZ2c2NUNjSU9xeWd5NE5DaUFnSUNBZ0lDQWdMeThnN0oyUjY0dTE3SjJBSU95ZHRPdXZ1Q0RyczdUcmc0anNuTHpyaTRnZzdJT0I3WU9jNjZXOElPdUxwT3lMbkNEc25xenNoSndnTDJobFlXeDBhT3VobkNEc2xZenJwckRyaTZRZ0tPMlVqT3Vmck9xM3VPeWR1T3lkdENEcmpJRHF1TEFnN1ptVTY2bTA3SjJFSU95THBPMk1xT3VobkNEcnNKVHF2cnpyaTZRcExnMEtJQ0FnSUNBZ0lDQnBaaUFvWTI5a1pTQWhQVDBnTUNBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQQ0ExTURBd0tTQjdEUW9nSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVPeWR0Q0RzcG9uc2k1d2c3SXVrN1l5bzY2R2NJT3VCbmV1Q3FDRGlnSlFnUTJ4aGRXUmxJRU52WkdVZzdJU2s3TG1ZSU95RGdlMkRuT3VsdkNEcmk2VHNpNXdnN0tDUTZyS0E3WldwNjR1STY0dWtMaWNwT3cwS0lDQWdJQ0FnSUNBZ0lHTm9aV05yUTJ4aGRXUmxRWFpoYVd4aFlteGxLQ2s3RFFvZ0lDQWdJQ0FnSUgwTkNpQWdJQ0FnSUgwcE93MEtJQ0FnSUNBZ2JHOW5hVzVRY205alZHbHRaWElnUFNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhzZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0F4TU91MmhDRHFzcjNxczd3ZzRvQ1VJT3VNZ09xNHNDRHRsSVRyb1p6c2hManNpcVFnN0tDVjY2YXNMaWNwT3lCcmFXeHNURzluYVc1UWNtOWpLQ2s3SUgwc0lEWXdNREF3TUNrN0RRb2dJQ0FnSUNBdkx5RHJncUhzbllBZzdKNkY3SjZsNnJhTTdKMkVJT3Vzdk9xem9DRHNub2pyaXBRZzY0eUE2cml3SU95RXVPeUZtT3lkZ0NEcnNvVHJwckRyaTZRZzRvQ1VJT3llck91aG5PcTN1T3lkdUNEdG00UWc2NHVrN0oyTUlPeWFsT3l5cmV5ZHRDRHNnNGdnN0lTNDdJV1lLT3lEaUNEc25vWHNucVhxdG93cDdKeTg2NkdjSU95TG5PeWVrZTJWbU9xeWpDNE5DaUFnSUNBZ0lDOHZJT3lkbU91UGhPeWdnU0Rzb29Ycm80d29jbVZoYzI5dUlPeW5nT3lnbFNrZzRvQ1VJRk5GVTFOSlQwNWZSRWxGUk91aG5DRHJnWjNyZ3JUcnFiUWc3SjZRNjQrWklPeWVyT3lMbk91UGhPcXdnQ0RzbUpzZzZyT0U3S0NWSU95RXVPeUZtT3lkaENEcmtKanNnclRyb0tRTkNpQWdJQ0FnSUM4dklPeWVyT3Vobk9xM3VPeWR1Q0Rya3FUc2w1RHJqNFFnVFVGWVgxUlZVazVUNnJtTTdLZUFJT3lZbXlEcXM0VHNvSlhzbkx6cm9ad2c3TEtZNjZhczY1Q1k2NHFVSU91eWhPcTN1T3F3Z0NEcmtKenJpNlFnS0RJd01qWXRNRGNnNjZhczY3ZXc3SmVRN0lTY0lPMlpsZXlkdUNrTkNpQWdJQ0FnSUd0cGJHeFFjbTlqS0Nmcm9aenF0N2pzbmJqc25ZUWc3S2VFN1phSjdaV1k2NHFVSU95a2tleWR0T3VkdkNEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJvWnpxdDdqc25iZ2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcE93MEtJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec05DaUFnSUNBZ0lDOHZJSE4zYVhSamFFMXZaR1hyaXBRZzdKMjA3S0NjSU91aG5PcTN1Q0RyckxqcXRhekN0K3lka2V1THRTQnRiMlJsSU8yUm5PeUxuT3lhcVNEaWdKUWdWVkpNN0oyQUlPdVJrQ0Rxc3Izc21yQWc2NnFvNjVHUUlPeWJrT3VzdUNEcXQ3anJqSURyb1p3ZzdKZXc2NHVrS095Y2hDQjNjbWwwWlVKeWIzZHpaWEpJWVc1a2JHVnlJT3lqdk95RW5Ta05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeUxuT3lla1NjZ0t5QW9jM2RwZEdOb1RXOWtaU0EvSUNjZ0tPcXpoT3lnbFNEc29JVHRtWmdnNG9DVUlPeUt1ZXlkdUNEdG1aVHJxYlRzbDVEc2hKd2dXK3F6aE95Z2xTRHNvSVR0bVpoZDdKMkVJT3VJaE91bHRPdXB0Q0RyaTZUcnBiZ2c2ck9FN0tDVjdKMkVJT3F6b091bHZDRHNpSmdnN0o2STdKYTA3SnFVS1NjZ09pQW5KeWtnS3lBbklPS0FsQ0Ryb1p6cXQ3anNuYmp0bFpqcnFiUWc3SjZRNjQrWklPeVhzT3F5c091UXFldUxpT3VMcEM0bktUc05DaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCdGIyUmxPaUJ6ZDJsMFkyaE5iMlJsSUQ4Z0oySnliM2R6WlhJdGMzZHBkR05vSnlBNklDZGljbTkzYzJWeUp5QjlLVHNOQ2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3RFFvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TUN3Z2V5Qmxjbkp2Y2pvZ0ordWhuT3EzdU95ZHVDRHNzTDNzbllRZzY2cTdJT3lYdE95WGlPeVd0T3lhbERvZ0p5QXJJR1V1YldWemMyRm5aU0I5S1RzTkNpQWdJQ0I5RFFvZ0lIME5DaUFnTHk4Z0tPMkVzT3V2dU91RWtDRHRqN1Ryc0xFZzZyV3M3WmlFNjdhQUlPS0FsQ0RydUl6cm5ienNtckRzb0lBZzdKNlE2NCtaSU95WmhPdWpqT3F3Z0NEc2xZZ2c2NUNZNjRxVUlPMlptT3F5dlNEc29JVHNtcWtwRFFvZ0lHWjFibU4wYVc5dUlHOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa2dldzBLSUNBZ0lIc05DaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2dJQ0FnSUNBZ0lDOHZJSE4wWVhKMDZyQ0FJT3lEaUNEc3ZaanNocFFnN0xDOTdKMkVJT3Vuak91VG9PdUxwQ0FvNjR1azY2YXM3SjJZSU95SXFPeWRnQ0Rzdlpqc2hwVHFzN3dnNjZ5MDZyU0E3WldZNnJLTUlPeUNyT3lhcWV5ZWtPeVhrT3F5akNEcnM3VHNub1FwTGcwS0lDQWdJQ0FnSUNBdkx5RHNuYlRzbHJUc2hKd2dVRzkzWlhKVGFHVnNiQ2d1Y0hNeEtleWR0Q0ExN0xTSUlPdVNwQ0RxdDdnZzdMQzk3SmVRSU95WGxPMkVzT3VsdkNEcnM3VHJnclFnTWV1eWlDanF0YXpyajRVZzZyT0U3S0NWS2V5ZGhDRHNucERyajVrZzdJU2c3WU9kN1pXWTZyT2dMQTBLSUNBZ0lDQWdJQ0F2THlEc3NMM3NuWVFnN0xXYzdJYU03Wm1VN1pXMElPeUNyT3lhcWV5ZWtDRHJpSWpzbDVRZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1T3VuakNEcmdxanFzb3dnN1pXYzY0dWtMaURzc0wzc25ZUWc2NnE3SU95d3Z1eWN2T3VwdENEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU8yVm5PdUxwQTBLSUNBZ0lDQWdJQ0F2THlBbzY0dWs2Nlc0SU95d3ZTRHNtS1Rzbm9Ycm9LVWc2N0NwN0tlQUlPS0FsQ0RxdDdnZzZySzk3SnF3SU91cGxPdUp0T3F3Z0NEcnM3VHNuYlRyaXBRZzdMR0U2NkdjSU91Q3FPcXpvQ0RzZ3F6c21xbnNucERxc0lBZzdKZVU3WVN3SU8yVm5DRHJzb2dnNjRpRTY2VzA2Nm0wSU91UXFDa3VEUW9nSUNBZ0lDQWdJQzh2SU95anZPeWRtRG9nWTJ4aGRXUmw2ckNBSU95OW1PeUdsQ0Rzb0p6cnFxbnNuWVFnNjdDVTZyNjQ2Nm0wSUVGd2NFRmpkR2wyWVhSbEwwWnBibVJYYVc1a2IzZnFzSUFnNjZxN0lPeXd2dXlkaENEc2lKZ2c3SjZJN0oyTUlPS0FsQ0Rzbklqcmo0VHNtckFnN0l1azZyaXc3SmVRN0lTY0lPMlpsZXlkdUNEdGxZVHNtcFF1RFFvZ0lDQWdJQ0FnSUdOdmJuTjBJSEJ6TVNBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRiRzluYVc0dWNITXhKeWs3RFFvZ0lDQWdJQ0FnSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vY0hNeExDQmJEUW9nSUNBZ0lDQWdJQ0FnSjFOMFlYSjBMVk5zWldWd0lDMVRaV052Ym1SeklEVW5MQTBLSUNBZ0lDQWdJQ0FnSUNja2QzTWdQU0JPWlhjdFQySnFaV04wSUMxRGIyMVBZbXBsWTNRZ1YxTmpjbWx3ZEM1VGFHVnNiQ2NzRFFvZ0lDQWdJQ0FnSUNBZ0ltbG1JQ2drZDNNdVFYQndRV04wYVhaaGRHVW9KMk5zWVhWa1pTMXNiMmRwYmljcEtTQjdJaXdOQ2lBZ0lDQWdJQ0FnSUNBaUlDQWtkM011VTJWdVpFdGxlWE1vSjM0bktTSXNEUW9nSUNBZ0lDQWdJQ0FnSnlBZ1UzUmhjblF0VTJ4bFpYQWdMVk5sWTI5dVpITWdNaWNzRFFvZ0lDQWdJQ0FnSUNBZ0lpQWdRV1JrTFZSNWNHVWdMVTVoYldWemNHRmpaU0JWSUMxT1lXMWxJRmNnTFUxbGJXSmxja1JsWm1sdWFYUnBiMjRnSjF0RWJHeEpiWEJ2Y25Rb1hDSjFjMlZ5TXpJdVpHeHNYQ0lwWFNCd2RXSnNhV01nYzNSaGRHbGpJR1Y0ZEdWeWJpQlRlWE4wWlcwdVNXNTBVSFJ5SUVacGJtUlhhVzVrYjNjb2MzUnlhVzVuSUdNc0lITjBjbWx1WnlCMEtUc2dXMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUdKdmIyd2dVMmh2ZDFkcGJtUnZkeWhUZVhOMFpXMHVTVzUwVUhSeUlHZ3NJR2x1ZENCdUtUc25JaXdOQ2lBZ0lDQWdJQ0FnSUNBaUlDQWthQ0E5SUZ0VkxsZGRPanBHYVc1a1YybHVaRzkzS0Z0T2RXeHNVM1J5YVc1blhUbzZWbUZzZFdVc0lDZGpiR0YxWkdVdGJHOW5hVzRuS1NJc0RRb2dJQ0FnSUNBZ0lDQWdKeUFnYVdZZ0tDUm9JQzF1WlNCYlUzbHpkR1Z0TGtsdWRGQjBjbDA2T2xwbGNtOHBJSHNnVzNadmFXUmRXMVV1VjEwNk9sTm9iM2RYYVc1a2IzY29KR2dzSURZcElIMG5MQ0F2THlBMklEMGdVMWRmVFVsT1NVMUpXa1VOQ2lBZ0lDQWdJQ0FnSUNBbmZTY3NEUW9nSUNBZ0lDQWdJRjB1YW05cGJpZ25YSEpjYmljcElDc2dKMXh5WEc0bktUc05DaUFnSUNBZ0lDQWdZMjl1YzNRZ1ltRjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxc2IyZHBiaTVpWVhRbktUc05DaUFnSUNBZ0lDQWdabk11ZDNKcGRHVkdhV3hsVTNsdVl5aGlZWFFzSUNkQVpXTm9ieUJ2Wm1aY2NseHVKeUFyRFFvZ0lDQWdJQ0FnSUNBZ0ozTjBZWEowSUNKamJHRjFaR1V0Ykc5bmFXNGlJR050WkNBdmF5QmpiR0YxWkdVZ0wyeHZaMmx1WEhKY2JpY2dLdzBLSUNBZ0lDQWdJQ0FnSUNkd2IzZGxjbk5vWld4c0lDMU9iMUJ5YjJacGJHVWdMVVY0WldOMWRHbHZibEJ2YkdsamVTQkNlWEJoYzNNZ0xVWnBiR1VnSWljZ0t5QndjekVnS3lBbklseHlYRzRuS1RzTkNpQWdJQ0FnSUNBZ2MzQmhkMjRvSjJOdFpDY3NJRnNuTDJNbkxDQmlZWFJkTENCN0lHVnVkam9nUTB4QlZVUkZYMFZPVml3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc05DaUFnSUNBZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjJSaGNuZHBiaWNwSUhzTkNpQWdJQ0FnSUNBZ0x5OGdjSFI1S0dWNGNHVmpkQ25yb1p3ZzY3TzA2NEs0SU8yQ3BPeVhrQ0R0Z2JUcm9aenJrNXdnVkZWSjZyQ0FJT3VzdE91d21PeWRrZXlkdUNEcXNvUHNuYlFnN0l1azdMaWhJTzJabGV5ZHVPdVFxQ2d5TURJMkxUQTNMQ0RzbmJ6cnNKZ2dYSExDdDJ0cGRIUjVJT3k5bE91VG5DRHJxcWpya1pBcElPS0FsQTBLSUNBZ0lDQWdJQ0F2THlEc25LRHNuYnp0bFp3ZzdKNlE2NCtaN1ptVUlPcXl2ZXVobk91S2xDQlRlWE4wWlcwZ1JYWmxiblJ6N0oyWUlPeW5oT3lubkNEdGdxUWc3SjZGNjZDbExpRHNvSkhxdDd6c2hMRWc2cmFNN1pXYzdKMjBJT3llaU95Y3ZPdXB0Q0EyN0xTSUlPdVNwQ0RzbDVUdGhMRHFzSUFnN0o2UTY0K1pJT3llaGV1Z3BldVB2QTBLSUNBZ0lDQWdJQ0F2THlBeDY3S0lLT3Exck91UGhTRHFzNFRzb0pVcDdKMjBJT3lFb08yRG5ldVFtT3F6b0N3ZzZyYU03WldjN0oyMElPeVhodXljdk91cHRDQnJaWGx6ZEhKdmEyVWc3S1NFNjZlTUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxiUWc3SUtzN0pxcDdKNlE2ckNBSU95WGxPMkVzQ0R0bFp3ZzY3S0lJT3VJaE91bHRPdXB0Q0Rya0p6cmk2UW9abUZwYkMxemIyWjBLUzROQ2lBZ0lDQWdJQ0FnTHk4ZzdKZVU3WVN3SU95bmdleWdoT3lYa0NCVVpYSnRhVzVoYk95ZGhDRHJpNlRzaTV3ZzdKV2U3Snk4NjZHY0lPcXdnT3lndU95WmdDRHJpNlRycGJnZzdKV3g3SmVRSU8yQ3BPcXdnQ0RyazZUc2xyVHFzSURyaXBRZzZyS0Q3SjJFSU91bmlldUtsT3VMcEM0TkNpQWdJQ0FnSUNBZ2MzQmhkMjRvSjI5ellYTmpjbWx3ZENjc0lGc05DaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlWR1Z5YldsdVlXd2lJSFJ2SUdSdklITmpjbWx3ZENBaVkyeGhkV1JsSUM5c2IyZHBiaUluTEEwS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdZV04wYVhaaGRHVW5MQTBLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2RrWld4aGVTQTJKeXdOQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHRmpkR2wyWVhSbEp5d05DaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5aR1ZzWVhrZ01DNHpKeXdOQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVTNsemRHVnRJRVYyWlc1MGN5SWdkRzhnYTJWNWMzUnliMnRsSUhKbGRIVnliaWNzRFFvZ0lDQWdJQ0FnSUNBZ0x5OGc3SmVVN1lTdzZyQ0FJT3lMcE95Z25PdWhuQ0RyazZUc2xyVHFzSVFnNnJLOTdKcXc3SmVRNjZlTUlPeVhyT3E0c0NEcmo0VHJpNndvNnJhTTdaV2NJT3lYaHV5Y3ZPdXB0Q0RzbklUc2w1RHNoSndnN0tTUjY0dW9LU0RpZ0pRZzdZU3c2Nis0NjRTUTdKMkVJT3k1bU95YmpDRHJ1SXpybmJ6c21yRHNvSURycDR3ZzY0S282cmkwNjR1a0RRb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURFdU5TY3NEUW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbFJsY20xcGJtRnNJaUIwYnlCelpYUWdiV2x1YVdGMGRYSnBlbVZrSUc5bUlHWnliMjUwSUhkcGJtUnZkeUIwYnlCMGNuVmxKeXdOQ2lBZ0lDQWdJQ0FnWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdEUW9nSUNBZ0lDQjlJR1ZzYzJVZ2V3MEtJQ0FnSUNBZ0lDQnlaWFIxY200Z1ptRnNjMlU3SUM4dklPeW5nT3lia0NEc2xZZ2c3WldZNjRxVUlFOVREUW9nSUNBZ0lDQjlEUW9nSUNBZ0lDQnlaWFIxY200Z2RISjFaVHNOQ2lBZ0lDQjlEUW9nSUgwTkNpQWdMeThnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0Ryb1p6cXQ3anNsWVRzbTRNZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNEdG1ZanNuWmdnVyt1aG5PcTN1T3lWaE95YmcxMGc2N0tFN1lxODdKMjBJTzJZdU95Mm5DNGdZMnhoZFdSbElHRjFkR2dnYkc5bmIzVjA3Snk4NjZHY0lFTk1TU0Ryb1p6cXQ3anNuYmpzbllRZzdaVzA3S0NjN1pXYzY0dWtMZzBLSUNBdkx5QW83SjIwSUZCRDdKMllJT3lnZ095ZXBldVFuQ0RzbnBEcXNxbnNwcDNycW9Yc25ZUWc3S2VBN0pxMDY0dWtJT0tBbENEcmk2VHNpNXdnN0pPdzY2Q2s2Nm0wSU95ZXJPdWhuT3EzdU95ZHVDRHRsWVRzbXBRdUtTRHJvWnpxdDdqc2xZVHNtNE1nN1p1RTdKZVVJT3lFdU95Rm1NSzM2ck9FN0tDVjdMcVE3SXVjNjZXOElPeWdsZXVtck8yVm5PdUxwQzROQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDJOc1lYVmtaUzFzYjJkdmRYUW5LU0I3RFFvZ0lDQWdZMjl1YzNRZ2JHOGdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjI5MWRDZGRMQ0I3SUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUVOTVFWVkVSVjlGVGxZc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbElIMHBPdzBLSUNBZ0lHeGxkQ0JsY25JZ1BTQW5KenNOQ2lBZ0lDQnNieTV6ZEdSbGNuSXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJsY25JZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc05DaUFnSUNCc2J5NXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdleUJxYzI5dUtISmxjeXdnTlRBd0xDQjdJRzlyT2lCbVlXeHpaU3dnWlhKeWIzSTZJQ2Zyb1p6cXQ3anNsWVRzbTRNZzdJdWs3WmFKSU95THBPMk1xRG9nSnlBcklHVXViV1Z6YzJGblpTQjlLVHNnZlNrN0RRb2dJQ0FnYkc4dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNOQ2lBZ0lDQWdJR3RwYkd4UWNtOWpLQ2Zyb1p6cXQ3anNsWVRzbTRQdGxiVHNoSndnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQzRuS1RzZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDRGlnSlFnN0o2UTY0K1pJT3llck95TG5PdVBoT3F3Z0NEc2hManNoWmpzbllRZzY1Q1k3SUswNjZhczY2bTBJT3lWaUNEcmtLZ05DaUFnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQ0FnSUNBZ0lDQXZMeURyaTZUc25Zd2dMMkZqWTI5MWJuVEN0eTlvWldGc2RHanNsNURzaEp3ZzZyT0U3S0NWN0oyRUlPeURpT3VobkNnOTdKZUc3SjJNN0p5ODY2R2NLU0RzbmIzcXNvd05DaUFnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQXZMeURzZzRIdGc1d2c3SjZzN1l5UTdLQ1ZLT3VMcE95ZGpDRHRoTFRzbDVEc2hKd2c2Nis0NjZHYzZyZTQ3SjI0SU9xd2tPeW5nQ2tOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0pXRTdKdURJQ2hqYjJSbElDY2dLeUJqYjJSbElDc2dKeWtuS1RzTkNpQWdJQ0FnSUdsbUlDaHlaWE11YUdWaFpHVnljMU5sYm5RcElISmxkSFZ5YmpzZ0x5OGdaWEp5YjNJZzdaVzQ2NU9rNjUrczZyQ0FJT3lkdE91dnVDRHNuWkhyaTdYdGxvanNuTHpycWJRZzdLU1I2N08xSU91d3FleW5nQTBLSUNBZ0lDQWdhV1lnS0dOdlpHVWdQVDA5SURBcElHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdEUW9nSUNBZ0lDQmxiSE5sSUdwemIyNG9jbVZ6TENBMU1EQXNJSHNnYjJzNklHWmhiSE5sTENCbGNuSnZjam9nS0dWeWNpNTBjbWx0S0NrdWMyeHBZMlVvTUN3Z01UVXdLU2tnZkh3Z0tDZnNvb1hybzR3ZzdMMlU2NU9jSUNjZ0t5QmpiMlJsS1NCOUtUc05DaUFnSUNCOUtUc05DaUFnSUNCeVpYUjFjbTQ3RFFvZ0lIME5DaUFnTHk4ZzdKNlE2cml3SU95aWhldWpqQ0RpZ0pRZzdaU002NStzNnJlNDdKMjRJRk5VVDFCZlFsSkpSRWRGTCsyVm1PMkt1T3U1aE8yS3VPcXdnQ0R0bUxqc3RwenRsWnpyaTZRZ0tPdWhuT3k3ck95WGtPeUVuT3VuakNEc29KSHF0N3dnNnJDQTY0cWw3WldZNjR1SUlPeVZpT3lnaENrTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dldzBLSUNBZ0lHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdEUW9nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lpaGV1ampDRHNtcFRzc3EwZzY3Q2I3SjJNSU9LQWxDRHJpNlRycHF6cnBid2c2NEdWNjR1STY0dWtMaWNwT3cwS0lDQWdJSE5vZFhSMGFXNW5SRzkzYmlBOUlIUnlkV1U3RFFvZ0lDQWdhMmxzYkZCeWIyTW9LVHNOQ2lBZ0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1N3Z01qQXdLVHNOQ2lBZ0lDQnlaWFIxY200N0RRb2dJSDBOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNKbFkyOXRiV1Z1WkNjcElIc05DaUFnSUNCamIyNXpkQ0I3SUhSbGVIUXNJRzF2WkdWc0xDQnliMnhsSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPdzBLSUNBZ0lHbG1JQ2doZEdWNGRDQjhmQ0FoVTNSeWFXNW5LSFJsZUhRcExuUnlhVzBvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZzdHBUc3NwenJzSnZzbllRZzY2eTQ2cldzNnJDQUlPdTVoT3lXdENEc25vanNpclhyaTRqcmk2UXVKeUI5S1RzTkNpQWdJQ0JqYjI1emRDQnpkR0Z5ZEdWa0lEMGdSR0YwWlM1dWIzY29LVHNOQ2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0xhVTdMS2NJT3lhbE95eXJUb25MQ0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z05UQXBMbkpsY0d4aFkyVW9MMXh1TDJjc0lDY2dKeWtnS3lBbjRvQ21KeXdnY205c1pTQS9JQ2RiSnlBcklISnZiR1VnS3lBblhTY2dPaUFuSnl3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPdzBLSUNBZ0lIUnllU0I3RFFvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUTJ4aGRXUmxLRk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2tzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpWTjFaMmRsYzNScGIyNXpMQ0JtYjNKdFlYUkVaWE5qT2lBblczc2lkR1Y0ZENJNklDTHJyTGpxdGF3aUxDQWljbVZoYzI5dUlqb2dJdXlkdE95Y29DSjlMQ0F1TGk1ZEp5QjlMQ0J5YjJ4bEtUc05DaUFnSUNBZ0lHTnZibk4wSUhOMVoyZGxjM1JwYjI1eklEMGdjaTV3WVhKelpXUWdmSHdnVzEwN0RRb2dJQ0FnSUNCamIyNXpkQ0J6WldNZ1BTQW9LRVJoZEdVdWJtOTNLQ2tnTFNCemRHRnlkR1ZrS1NBdklERXdNREFwTG5SdlJtbDRaV1FvTVNrN0RRb2dJQ0FnSUNCcFppQW9JWE4xWjJkbGMzUnBiMjV6TG14bGJtZDBhQ2tnZXcwS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVRuQ0RzblpIcmk3WHNuWVFnN1pXMDdJU2Q3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93MEtJQ0FnSUNBZ2ZRMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lnbk95VmlDQW5JQ3NnYzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUNzZ0orcXduQ0FvSnlBcklITmxZeUFySUNkektTY3BPdzBLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0RRb2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lETXdLVHNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003RFFvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnpkV2RuWlhOMGFXOXVjeXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzTkNpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0RRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3RFFvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc05DaUFnSUNCOURRb2dJSDBOQ2lBZ0x5OGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RpZ0pRZzdaV2NJTzJabE91cHRPeWRoQ0R0bFpqc25JUWc3WlNFNjZDSTdKNkVLT3lZZ2V5WHJTa2c2NHVvN0p5RTY2R2NJT3VDbU91SW9DRHJzSnZxczZBc0lPeVlnZXlYcmV1bmlPdUxwQ0RybExEcm9ad2c2NHlBN0pXSTdKMkVJT3VDdU91THBDNE5DaUFnTHk4ZzdKaUI3SmV0SU95SW1PdW5qTzJCdkNEc21wVHNzcTNzbllRZzdLcTg2ckNjN0tlQUlPeVZpdXVLbENEcXNvUHNuYlFnN1pXMTdJdXNJQ2pyaXBEcm9LVHNwNERxczZBZzdJS3M3SnFwNjUrSjY0K0VJT3EzdU91bmpPMkJ2Q0RyZ3BqcXNJVHJpNlFwTGcwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0xXZHliM1Z3Y3ljcElIc05DaUFnSUNCamIyNXpkQ0I3SUdkeWIzVndjeXdnYlc5a1pXd3NJRzF2Y21VZ2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3RFFvZ0lDQWdZMjl1YzNRZ2JHbHpkQ0E5SUVGeWNtRjVMbWx6UVhKeVlYa29aM0p2ZFhCektRMEtJQ0FnSUNBZ1B5Qm5jbTkxY0hNTkNpQWdJQ0FnSUNBZ0lDQXViV0Z3S0NobktTQTlQaUFvZXcwS0lDQWdJQ0FnSUNBZ0lDQWdibUZ0WlRvZ1UzUnlhVzVuS0NobklDWW1JR2N1Ym1GdFpTa2dmSHdnSnljcExuUnlhVzBvS1N3TkNpQWdJQ0FnSUNBZ0lDQWdJSFJsZUhSek9pQW9aeUFtSmlCQmNuSmhlUzVwYzBGeWNtRjVLR2N1ZEdWNGRITXBJRDhnWnk1MFpYaDBjeUE2SUZ0ZEtTNXRZWEFvS0hRcElEMCtJRk4wY21sdVp5aDBJSHg4SUNjbktTNTBjbWx0S0NrcExtWnBiSFJsY2loQ2IyOXNaV0Z1S1N3TkNpQWdJQ0FnSUNBZ0lDQWdJSEp2YkdVNklDaG5JQ1ltSUdjdWNtOXNaU2tnUHlCVGRISnBibWNvWnk1eWIyeGxLU0E2SUhWdVpHVm1hVzVsWkN3TkNpQWdJQ0FnSUNBZ0lDQjlLU2tOQ2lBZ0lDQWdJQ0FnSUNBdVptbHNkR1Z5S0NobktTQTlQaUJuTG5SbGVIUnpMbXhsYm1kMGFDa05DaUFnSUNBZ0lEb2dXMTA3RFFvZ0lDQWdhV1lnS0d4cGMzUXViR1Z1WjNSb0lEd2dNaWtnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnNtSUhzbDYzc25iUWc2N2FBN0tHeDdaV3A2NHVJNjR1a0xpY2dmU2s3RFFvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdEUW9nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJVaE91Z2lPeWVoT3V6aENEc3RwVHNzcHdnN0pxVTdMS3RPaURzbUlIc2w2MGdKeUFySUd4cGMzUXViR1Z1WjNSb0lDc2dKK3F3bkNjZ0t5QW9iVzl5WlNBL0lDY2dLT3VObENEcnNKdnF1TEFwSnlBNklDY25LU3dnYlc5a1pXd2dQeUFuS091cXFPdU51RG9nSnlBcklHMXZaR1ZzSUNzZ0p5a25JRG9nSnljcE93MEtJQ0FnSUhSeWVTQjdEUW9nSUNBZ0lDQmpiMjV6ZENCeUlEMGdZWGRoYVhRZ1lYTnJSM0p2ZFhCektHeHBjM1FzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpVZHliM1Z3Y3l3Z1ptOXliV0YwUkdWell6b2dKM3NpWjNKdmRYQnpJam9nVzNzaWJtRnRaU0k2SUNMc21JSHNsNjBnN0oyMDY2YUVJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyaklEc2xZZ2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0o5WFgxZGZTY2dmU3dnSVNGdGIzSmxLVHNOQ2lBZ0lDQWdJR052Ym5OMElHOTFkQ0E5SUhJdWNHRnljMlZrT3cwS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3cwS0lDQWdJQ0FnYVdZZ0tDRnZkWFFwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0RRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNFNjZDSTdKNkU2N09FSU95Z25PeVZpQ0FuSUNzZ2IzVjBMbkpsWkhWalpTZ29iaXdnWnlrZ1BUNGdiaUFySUdjdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0xDQXdLU0FySUNmcXNKd2dMeURzbUlIc2w2MGdKeUFySUc5MWRDNXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3RFFvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93MEtJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNBblcrMlVoT3VnaU95ZWhPdXpoRjBnSnlBcklGTjBjbWx1Wnlnb2JHbHpkRnN3WFNBbUppQnNhWE4wV3pCZExuUmxlSFJ6V3pCZEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z01qUXBPdzBLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRk5sWXlBOUlITmxZenNOQ2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHZHliM1Z3Y3pvZ2IzVjBMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3cwS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRsSVRyb0lqc25vVHJzNFFnN0xhVTdMS2NJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3cwS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdEUW9nSUNBZ2ZRMEtJQ0I5RFFvZ0lDOHZJTzJNbmV5WGhTRHNtcFRzaG96cnM0UWc3TGFVN0xLY0lPS0FsQ0R0bFp3ZzdZeWQ3SmVGN0oyWUlPcTFyT3lFc2V5YWxPeUdqQ2pzbDYzdGxhQXI2Nnk0NnJXc0tldWx2Q0R0bFp3ZzY3S0k3SmVRSU91d20reVZoQ0RzbDYzdGxhRHJzNFRyb1p3ZzY0dWs2NU9zNjRxVTY0dWtMZzBLSUNBdkx5RHNtcFRzaG96cnBid2c3WldvNnJ1WUlPdXp0T3VDdE95VnZDRHRnNERzbmJUdGk0RHNuYlFnNjdPNDY2eTRJT3VucGV1ZHZleWRoQ0Rzc0xqc29iRHRsYUFnN0lpWUlPeWVpT3VMcENqc21wVHNob3pyczRRZzZyQ2M2N09FSU95YWxPeXlyZXF6dk95ZG1DRHNzS2pzbmJRcExnMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjbVZqYjIxdFpXNWtMWEJ2Y0hWd0p5a2dldzBLSUNBZ0lHTnZibk4wSUhzZ1pXeGxiV1Z1ZEhNc0lHMXZaR1ZzTENCdGIzSmxJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93MEtJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0dWc1pXMWxiblJ6S1NBL0lHVnNaVzFsYm5SekxtWnBiSFJsY2lnb1pTa2dQVDRnWlNBbUppQlRkSEpwYm1jb1pTNTBaWGgwSUh4OElDY25LUzUwY21sdEtDa3BJRG9nVzEwN0RRb2dJQ0FnYVdZZ0tHeHBjM1F1YkdWdVozUm9JRHdnTWlrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2Z0akozc2w0VWc3SnFVN0lhTTZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNG5JSDBwT3cwS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPdzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0akozc2w0VWc3TGFVN0xLY0lPeWFsT3l5clRvZzdKcVU3SWFNSUNjZ0t5QnNhWE4wTG14bGJtZDBhQ0FySUNmcXNKd25JQ3NnS0cxdmNtVWdQeUFuSUNqcmpaUWc2N0NiNnJpd0tTY2dPaUFuSnlrc0lHMXZaR1ZzSUQ4Z0p5anJxcWpyamJnNklDY2dLeUJ0YjJSbGJDQXJJQ2NwSnlBNklDY25LVHNOQ2lBZ0lDQjBjbmtnZXcwS0lDQWdJQ0FnWTI5dWMzUWdjaUE5SUdGM1lXbDBJR0Z6YTFCdmNIVndLR3hwYzNRc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVkJ2Y0hWd0xDQm1iM0p0WVhSRVpYTmpPaUFuZXlKelpYUnpJam9nVzNzaWNtVmhjMjl1SWpvZ0l1dXdxZTJXcFNEdGxad2c2Nnk0N0o2bElpd2dJbVZzWlcxbGJuUnpJam9nVzNzaWNtOXNaU0k2SUNMc2w2M3RsYUFpTENBaWRHVjRkQ0k2SUNMcnJManF0YXdpZlN3Z0xpNHVYWDBzSUM0dUxsMTlKeUI5TENBaElXMXZjbVVwT3cwS0lDQWdJQ0FnWTI5dWMzUWdjMlYwY3lBOUlISXVjR0Z5YzJWa093MEtJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93MEtJQ0FnSUNBZ2FXWWdLQ0Z6WlhSektTQjdEUW9nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3RFFvZ0lDQWdJQ0I5RFFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZeWQ3SmVGSU95RXVPMkt1Q0FuSUNzZ2MyVjBjeTVzWlc1bmRHZ2dLeUFuNnJDY0lDZ25JQ3NnYzJWaklDc2dKM01wSnlrN0RRb2dJQ0FnSUNCemRHRjBjeTV6WlhKMlpXUXJLenNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPdzBLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQW5XKzJNbmV5WGhWMGdKeUFySUZOMGNtbHVaeWdvYkdsemRGc3dYU0FtSmlCc2FYTjBXekJkTG5SbGVIUXBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlOQ2s3RFFvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3cwS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djMlYwY3l3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnlCOUtUc05DaUFnSUNCOUlHTmhkR05vSUNobEtTQjdEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5ZDdKZUZJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3cwS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdEUW9nSUNBZ2ZRMEtJQ0I5RFFvZ0lDOHZJT3VNZ08yWmxPMllsU0RyckxqcXRhd2c3S0NjN0o2UklPS0FsQ0RzZzRIdG1hbnNuWVFnN0lTazY2cUY3WldZNjZtMElPdXN1T3Exck91bHZDRHJwNHpyazZUc2xyVHNwSURyaTZRZ0tPeTJsT3l5bk9xenZDRHFzSm5zbllBZzdJUzQ3SVdZTENEcmpJRHRtWlRyaXBRZzY2ZWtJT3lhbE95eXJleVhrQ0R0aHJYc3A3anJvWndnN0l1azY2YThLUTBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2WTI5dGNHOXpaU2NwSUhzTkNpQWdJQ0JqYjI1emRDQjdJRzFsYzNOaFoyVnpMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzTkNpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ1FYSnlZWGt1YVhOQmNuSmhlU2h0WlhOellXZGxjeWtnUHlCdFpYTnpZV2RsY3k1bWFXeDBaWElvS0cwcElEMCtJRzBnSmlZZ1UzUnlhVzVuS0cwdWRHVjRkQ0I4ZkNBbkp5a3VkSEpwYlNncEtTQTZJRnRkT3cwS0lDQWdJR2xtSUNnaGJHbHpkQzVzWlc1bmRHZ3BJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREF3TENCN0lHVnljbTl5T2lBbjY0eUE3Wm1VSU91Q3RPeWFxZXlkdENEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3RFFvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdEUW9nSUNBZ1kyOXVjM1FnYkdGemRGVnpaWElnUFNCYkxpNHViR2x6ZEYwdWNtVjJaWEp6WlNncExtWnBibVFvS0cwcElEMCtJRzB1Y205c1pTQWhQVDBnSjJGemMybHpkR0Z1ZENjcE93MEtJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvSnpzbnBFZzY0eUE3Wm1VSU95YWxPeXlyVG9uTENCVGRISnBibWNvS0d4aGMzUlZjMlZ5SUNZbUlHeGhjM1JWYzJWeUxuUmxlSFFwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0ExTUNrdWNtVndiR0ZqWlNndlhHNHZaeXdnSnlBbktTQXJJQ2ZpZ0tZZ0tPdU1nTzJabENBbklDc2diR2x6ZEM1c1pXNW5kR2dnS3lBbjZyQ2NLU2NwT3cwS0lDQWdJSFJ5ZVNCN0RRb2dJQ0FnSUNBdkx5RHJqSUR0bVpUcXNJQWc2cmk0N0phMDdLZUE2Nm0wSU95MW5PcTN2Q0F4TXVxd25PdW5qQ0FvN1pTRTY2R3M3WlNFN1lxNElPMlByZXlqdkNEcnNLbnNwNEFwRFFvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUTI5dGNHOXpaU2hzYVhOMExuTnNhV05sS0MweE1pa3NJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlVOdmJYQnZjMlVzSUdadmNtMWhkRVJsYzJNNklDZDdJbkpsY0d4NUlqb2dJdXVNZ08yWmxDRHNuWkhyaTdVZzdaV2M2NUdRSU91c3VPeWVwU0lzSUNKemRXZG5aWE4wYVc5dWN5STZJRnQ3SW5SbGVIUWlPaUFpNjZ5NDZyV3NJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FpZlN3Z0xpNHVYWDBuSUgwcE93MEtJQ0FnSUNBZ1kyOXVjM1FnYjNWMElEMGdjaTV3WVhKelpXUTdEUW9nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdEUW9nSUNBZ0lDQnBaaUFvSVc5MWRDa2dldzBLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z2V5Qmxjbkp2Y2pvZ0orMkJ0T3Vobk91VG5DRHNuWkhyaTdYc25ZUWc3WlcwN0lTZDdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3cwS0lDQWdJQ0FnZlEwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lla1NEc25aSHJpN1VnS0NjZ0t5QnpaV01nS3lBbmN5d2c3S0NjN0pXSUlDY2dLeUJ2ZFhRdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lDc2dKK3F3bkNrbktUc05DaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3cwS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3RFFvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVkdWNGRDQTlJRk4wY21sdVp5Z29iR0Z6ZEZWelpYSWdKaVlnYkdGemRGVnpaWEl1ZEdWNGRDa2dmSHdnSnljcExuTnNhV05sS0RBc0lETXdLVHNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003RFFvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnlaWEJzZVRvZ2IzVjBMbkpsY0d4NUxDQnpkV2RuWlhOMGFXOXVjem9nYjNWMExuTjFaMmRsYzNScGIyNXpMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3cwS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvSnpzbnBFZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdEUW9nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU8yWXVPeTJuQ0RzaTZUdGpLZzZJQ2NwS1RzTkNpQWdJQ0I5RFFvZ0lIME5DaUFnTHk4ZzY3S0k3SmV0SU9LQWxDRHRsWnpxdGEzc2xyUWc0b2FVSU95WWdleVd0Q0RzbnBEcmo1a2dLT3kybE95eW5PcXp2Q0Rxc0puc25ZQWc3SVM0N0lXWUlPeUNyT3lhcVNrTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzUnlZVzV6YkdGMFpTY3BJSHNOQ2lBZ0lDQmpiMjV6ZENCN0lIUmxlSFFzSUcxdlpHVnNJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93MEtJQ0FnSUdsbUlDZ2hkR1Y0ZENCOGZDQWhVM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnJzb2pzbDYzdGxhQWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc05DaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzTkNpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnlrN0RRb2dJQ0FnZEhKNUlIc05DaUFnSUNBZ0lHTnZibk4wSUhJZ1BTQmhkMkZwZENCaGMydFVjbUZ1YzJ4aGRHVW9VM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFZISmhibk5zWVhSbExDQm1iM0p0WVhSRVpYTmpPaUFuZXlKMGNtRnVjMnhoZEdWa0lqb2dJdXV5aU95WHJldXN1Q0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpTENBaVpHbHlaV04wYVc5dUlqb2dJbXR2NG9hU1pXNGc2NWlRNjRxVUlHVnU0b2FTYTI4aWZTY2dmU2s3RFFvZ0lDQWdJQ0JqYjI1emRDQnZkWFFnUFNCeUxuQmhjbk5sWkRzTkNpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzTkNpQWdJQ0FnSUdsbUlDZ2hiM1YwS1NCN0RRb2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzblpIcmk3WHNuWVFnN1pXMDdJU2Q3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93MEtJQ0FnSUNBZ2ZRMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNtWVRybzR3Z0tDY2dLeUJ6WldNZ0t5QW5jeXdnSnlBcklDaHZkWFF1WkdseVpXTjBhVzl1SUh4OElDYy9KeWtnS3lBbktTY3BPdzBLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0RRb2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lETXdLVHNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003RFFvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QjBjbUZ1YzJ4aGRHVmtPaUJ2ZFhRdWRISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVPaUJ2ZFhRdVpHbHlaV04wYVc5dUxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPdzBLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnNvanNsNjBnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJT3V5aU95WHJTRHNpNlR0aktnNklDY3BLVHNOQ2lBZ0lDQjlEUW9nSUgwTkNpQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNRFFzSUhzZ1pYSnliM0k2SUNkT2IzUWdabTkxYm1RbklIMHBPdzBLZlNrN0RRb05DaTh2SU95ZHRPdXZ1Q0RyaTZUcnBxenFzSUFnNjVhZ0lPeWVpT3VLbE91TnNDRHJtSkFnN0x5YzZyaXc2ckNBSU91VHBPeVd0T3lZcE91cHRDanNvSnpzaXFUc3NwZ2c3SjZRNjQrWklPeThuT3E0c0NEc3BKSHJzN1VnNjVPeEtTRHNvYkRzbXFudG5vZ2c3S0tGNjZPTUlPS0FsQ0RyajR6cmpaZ2c2NHVrNjZhczY0cVVJT3EzdU91TWdPdWhuQ0RzbktEc3A0QU5Dbk5sY25abGNpNXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdldzBLSUNCcFppQW9aU0FtSmlCbExtTnZaR1VnUFQwOUlDZEZRVVJFVWtsT1ZWTkZKeWtnZXcwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc25iVHJyN2dnN0x5YzdLQzRJT3llaU95V3RPeWFsQ2p0ajZ6dGlyZ2dKeUFySUZCUFVsUWdLeUFuSU95Q3JPeWFxU0RzcEpFcElPS0FsQ0RzbmJRZzdKMjQ3SXFrN1lTMDdJcWs2NHFVSU95aWhldWpqTzJWcWV1TGlPdUxwQzRuS1RzTkNpQWdJQ0J3Y205alpYTnpMbVY0YVhRb01DazdEUW9nSUgwTkNpQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95RW5PdXloQ0RzbUtUcnBaZzZKeXdnWlNBbUppQmxMbTFsYzNOaFoyVXBPdzBLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3RFFwOUtUc05DaTh2SU95V3RPdVdwQ0Rxc3Izcm9aenJvWndnN0tPOTY1T2dLT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFzSUVOMGNtd3JReXdnTDNOb2RYUmtiM2R1TENEc21LVHJwWmdwSUdOc1lYVmtaU0RzbnBEc2k1M3NuWVFnNjRLbzZyaXc3S2VBSU95Vml1dUtsT3VMcEEwS2NISnZZMlZ6Y3k1dmJpZ25aWGhwZENjc0lDZ3BJRDArSUhzZ2EybHNiRkJ5YjJNb0tUc2dhMmxzYkV4dloybHVVSEp2WXlncE95QjlLVHNOQ25CeWIyTmxjM011YjI0b0oxTkpSMGxPVkNjc0lDZ3BJRDArSUhCeWIyTmxjM011WlhocGRDZ3dLU2s3RFFwd2NtOWpaWE56TG05dUtDZFRTVWRVUlZKTkp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwS1RzTkNnMEtjMlZ5ZG1WeUxteHBjM1JsYmloUVQxSlVMQ0FuTVRJM0xqQXVNQzR4Snl3Z0tDa2dQVDRnZXcwS0lDQmpiMjV6YjJ4bExteHZaeWduNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUp5azdEUW9nSUdOdmJuTnZiR1V1Ykc5bktDY2c3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFySUZCUFVsUXBPdzBLSUNCamIyNXpiMnhsTG14dlp5Z25JT3VxcU91TnVEb2dKeUFySUVOTVFWVkVSVjlOVDBSRlRDQXJJQ2Nnd3JjZzdKaUk3SXVjSUNjZ0t5QkZXRUZOVUV4RlV5NXNaVzVuZEdnZ0t5QW42ckcwSU95ZXBleXdxU2NwT3cwS0lDQmpiMjV6YjJ4bExteHZaeWduSU95ZHRDRHNzTDNzbllRZzdMeWM2NUdVSU91UG1leVZpQ0R0bEx6cXQ3anJwNGdnN1pTTTY1K3M2cmU0N0oyNDdKMjBJTzJCdE91aG5PdVRuT3VobkNEc3RwVHNzcHp0bGFucmk0anJpNlF1SnlrN0RRb2dJR052Ym5OdmJHVXViRzluS0NmaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQW5LVHNOQ2lBZ1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LVHNnTHk4Z1EyeGhkV1JsSUVOdlpHVWc3SUtzN0pxcElPcXdnT3VLcFNEc2w2enJ0b0FnN0tDUTZyS0FJQ2p0bEl6cm42enF0N2pzbmJnZzdKV0k2NEswN0pxcEtRMEtJQ0F2THlEcnI3anJwcXdnN0l1YzY0K1pJQ3NnN0tlQTdJdWM2Nnk0SU95anZPeWVoU0RpZ0pRZzdMS3JJT3kybE95eW5PdTJnTzJFc0NEcnVhRHJwYlRxc293TkNpQWdZWE5yUTJ4aGRXUmxLQ2ZzbTR6cnNJM3NsNFU2SUNMc29JRHNucVVnNjVDWTdKZUk3SXExNjR1STY0dWtJaWNwTG5Sb1pXNG9EUW9nSUNBZ0tDa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWJqT3V3amV5WGhTRHNtWVRybzR3ZzRvQ1VJT3kybE95eW5DRHNwSURydVlRZzY0R2RMaWNwTEEwS0lDQWdJQ2hsS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0p1TTY3Q043SmVGSU95THBPMk1xQ0FvN0xLcklPeWFsT3l5clNEcmxZd2c3SjZzN0l1YzY0K0VLVG9uTENCbExtMWxjM05oWjJVcERRb2dJQ2s3RFFwOUtUc05DaTh2SUVsUWRqWWc2Nk9vN1pTRTY3Q3hLRG82TVNuc2w1RHJqNFFnN1pXbzZydVlJT3VUbyt1S2xPdUxwQ0RpZ0pRZ2JXRmpUMU1nNjVPeDdKZVE3SVNjSUNkc2IyTmhiR2h2YzNRbjZyQ0FJRG82TWV1aG5DRHJxTHpzb0lBZzdaVzA3SVNkNjVDWTY0cVU2NDJ3RFFvdkx5RHRsTHpxdDdqcnA0Z29SV3hsWTNSeWIyNHBJR1psZEdObzY0cVVJR04xY216cXM3d2c2NHVzNjZhc0lFbFFkalRyb1p3ZzdKNlE2NCtaSU8yUHRPdXdzZTJWbU95bmdDRHNsWXJzbFlRc0lFbFFkalRycDR3ZzY1T2o2NDJZSU91THBPdW1yT3lYa0NEc2w3RHFzckRzbmJRZzZyR3c2N2FBNjQrOERRb3ZMeURzdHBUc3NwekN0KzJYck95S3BPeXl0TzJCck9xd2dDRHNvYkRzbXFudG5vZ2c3SXVrN1l5bzdaYUk2NHVrS095THBPeTRvU0F5TURJMkxUQTNLUzRnNnJDWjdKMkFJT3lhbE95eXJTRHRsYmpyazZUcm42enJwYndnU1ZCMk5pRHJvNmp0bElUcnNMSHNsNURyajRRZzdKYTU2NHFVNjR1a0xnMEtZMjl1YzNRZ2MyVnlkbVZ5TmlBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtITmxjblpsY2k1c2FYTjBaVzVsY25Nb0ozSmxjWFZsYzNRbktWc3dYU2s3RFFwelpYSjJaWEkyTG05dUtDZGxjbkp2Y2ljc0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGdTVkIyTmlnNk9qRXBJT3Vtck95S3FDRHNnNTNybnJVZzRvQ1VJRWxRZGpUcnA0d2c3SUtzN0pxcE9pY3NJR1VnSmlZZ1pTNXRaWE56WVdkbEtTazdEUXB6WlhKMlpYSTJMbXhwYzNSbGJpaFFUMUpVTENBbk9qb3hKeWs3RFFvPScKQjY0X1dBVENIRVI9J0x5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tOQ2k4dklPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQTBLTHk4ZzdKbWNJTzJWaE95YWxPMlZuT3F3Z0RvZzdaUzg2cmU0NjZlSTZyQ0FJTzJVak91ZnJPcTN1T3lkdU95ZG1DQmpiR0YxWkdWaWNtbGtaMlU2THk4ZzdKZTA2cml3S0hkcGJtUnZkeTV2Y0dWdUwybG1jbUZ0WlM5dmNHVnVSWGgwWlhKdVlXd3A2Nlc4RFFvdkx5RHNvSVRydG9BZzdJYU02NmFzSU95WGh1eWR0Q0RycDRucmlwUWc2N0tFN0tDRTdKMjBJT3llaU91THBDNGdabVYwWTJqcmlwUWc2NnE3SU91bmlleWN2T3V2Z091aG5Dd2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPeWR0Q0Rxc0pEc2k1enNucERzbDVEcXNvd05DaTh2SUZCUFUxUWdMM2RoYTJVZzY2VzhJT3V6dE91Q3RPdXB0Q0Rxc0pEc2k1enNucERxc0lBZzY0dWs2NmFzS0dOc1lYVmtaUzFpY21sa1oyVXVhbk1wNjZXOElPdU1nT3lMb0NEc3ZLRHJpNlF1RFFvdkx3MEtMeThnNjR1azY2YXM3Sm1BN0oyWUlPeXdxT3lkdERvZzZyQ1E3SXVjN0o2UTY0cVVJR05zWVhWa1pldWx2Q0Ryckx6c3A0QWc3SldLNjRxVTY0dWtLT3lla095TG5TRHNsNGJzbll3cElPS0draUR0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3VsdkNEc2xZZ2c2NmVKNnJPZ0xBMEtMeThnNjZtVTY2cW82NmFzSUg0eE5VMUM2NTI4SU91aG5PcTN1T3lkdUNEc2k1d2c3SjZRNjQrWklPeUxuT3lla2V5Y3ZPdWhuQ0RzZzRIc2k1d2c3THljNjVHczY0K0VJT3UyZ091THRDRHNsNGJyaTZRZ0tPdVRzZXVoblRvZ2JuQnRJSEoxYmlCaWRXbHNaQ2t1RFFvdkx5RHJpNlRycHF6cmlwUWc3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTRzT3VwdENEc283M3NwNERycDR3bzdaU002NStzNnJlNDdKMjQ2ck84SU95RG5leUNyQ0RyajVucXVMRHRtWlFwTENEcXNKRHNpNXpzbnBEcmlwUWc2ck9FN0lhTklPdUNxT3lWaENEcmk2VHNuWXdnNnJtbzdKcXc2cml3NjZXOElPdXdtK3VLbE91THBDNE5DZzBLWTI5dWMzUWdhSFIwY0NBOUlISmxjWFZwY21Vb0oyaDBkSEFuS1RzTkNtTnZibk4wSUhCaGRHZ2dQU0J5WlhGMWFYSmxLQ2R3WVhSb0p5azdEUXBqYjI1emRDQm1jeUE5SUhKbGNYVnBjbVVvSjJaekp5azdEUXBqYjI1emRDQnZjeUE5SUhKbGNYVnBjbVVvSjI5ekp5azdEUXBqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNOQ2cwS1kyOXVjM1FnVUU5U1ZDQTlJREV4T0RnNU93MEtZMjl1YzNRZ1VrOVBWQ0E5SUhCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNwT3lBdkx5RHNvSURzbnFYc2hvd2c2Nk9vN1lxNElPS0FsQ0RyaTZUcnBxenFzSUFnY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xazY2VzhJT3l3dnV1S2xDRHF1TERzcElBTkNnMEtZMjl1YzNRZ1EwOVNVMTlJUlVGRVJWSlRJRDBnZXcwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VDNKcFoybHVKem9nSnlvbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFRXVjBhRzlrY3ljNklDZEhSVlFzSUZCUFUxUXNJRTlRVkVsUFRsTW5MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RTR1ZoWkdWeWN5YzZJQ2REYjI1MFpXNTBMVlI1Y0dVbkxBMEtmVHNOQ21aMWJtTjBhVzl1SUdwemIyNG9jbVZ6TENCemRHRjBkWE1zSUc5aWFpa2dldzBLSUNCeVpYTXVkM0pwZEdWSVpXRmtLSE4wWVhSMWN5d2dUMkpxWldOMExtRnpjMmxuYmloN0lDZERiMjUwWlc1MExWUjVjR1VuT2lBbllYQndiR2xqWVhScGIyNHZhbk52YmpzZ1kyaGhjbk5sZEQxMWRHWXRPQ2NnZlN3Z1EwOVNVMTlJUlVGRVJWSlRLU2s3RFFvZ0lISmxjeTVsYm1Rb1NsTlBUaTV6ZEhKcGJtZHBabmtvYjJKcUtTazdEUXA5RFFvTkNpOHZJR05zWVhWa1pTQkRURW5xc0lBZzdKNkk2NHFVN0tlQUlPS0FsQ0RzbDRic25MenJxYlFnTDNkaGEyVWc3SjJSNjR1MTdKZVFJT3lMcE95V3RDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdKV0k2NEswN1pXZ0lPeUltQ0Rzbm9qcXNvd2c3WldjNjR1a0RRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU95ZHZlcTRzQ0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOeklDanJpNlRycHF6c25aZ2dZMnhoZFdSbFFXTmpiM1Z1ZE95WmdDRHFzSm5zbllBZzdMYWM3TEtZS1M0TkNpOHZJTzJNak95ZHZPeWR0Q0R0Z2JRZzdJaVlJT3llaU95V3RDQXpNT3kwaUNEc3VwRHNpNXd1SU95ZXJPdWhuT3EzdU95ZHVPMlZtT3VwdENCRFRFbnFzSUFnN1l5TTdKMjg3SjJFSU9xd3NleUxvTzJWbU91dmdPdWhuQ0RzbnBEcmo1a2c2N0NZN0ppQjY1Q2M2NHVrTGcwS0x5OGc3THFRN0l1Y0lEWHN0SWdnNG9DVUlPdWhuT3EzdU95ZHVDRHNwNEh0bTRRZzdJT0lJT3F6aE95Z2xleWR0Q0RxczZmcnNKVHJvWndnN0o2aDdaaUE3Slc4SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA3SmVRN0lTY0lPMlppT3ljdk91aG5DRHJoSmpzbHJUcXNJVHJpNlFvTXpEc3RJanJxYlFnNjRTSTY2eTBJT3VLcHV5ZGpDa05DbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93MEtablZ1WTNScGIyNGdZMnhoZFdSbFFXTmpiM1Z1ZENncElIc05DaUFnYVdZZ0tFUmhkR1V1Ym05M0tDa2dMU0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQQ0ExTURBd0tTQnlaWFIxY200Z1lXTmpiM1Z1ZEVOaFkyaGxMbVZ0WVdsc093MEtJQ0JzWlhRZ1pXMWhhV3dnUFNCdWRXeHNPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3cwS0lDQWdJR1Z0WVdsc0lEMGdLR29nSmlZZ2FpNXZZWFYwYUVGalkyOTFiblFnSmlZZ2FpNXZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOektTQjhmQ0J1ZFd4c093MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyb1p6cXQ3anNuYmdnN0oyMDY2Q2xJT3lYaHV5ZGpDRHJrN0VnNG9DVUlHNTFiR3dnS2k4Z2ZRMEtJQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lCRVlYUmxMbTV2ZHlncExDQmxiV0ZwYkNCOU93MEtJQ0J5WlhSMWNtNGdaVzFoYVd3N0RRcDlEUW9OQ21aMWJtTjBhVzl1SUdoaGMwTnNZWFZrWlNncElIc05DaUFnWTI5dWMzUWdabWx1WkdWeUlEMGdjSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeUEvSUNkM2FHVnlaU2NnT2lBbmQyaHBZMmduT3cwS0lDQjBjbmtnZXlCeVpYUjFjbTRnYzNCaGQyNVRlVzVqS0dacGJtUmxjaXdnV3lkamJHRjFaR1VuWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lITm9aV3hzT2lCMGNuVmxJSDBwTG5OMFlYUjFjeUE5UFQwZ01Ec2dmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVjBkWEp1SUdaaGJITmxPeUI5RFFwOURRb05DbXhsZENCM1lXdHBibWNnUFNCbVlXeHpaVHNnTHk4ZzdKZXc3WU9BSU91d3FleW5nQ0RpZ0pRZzY0dWs2NmFzNjRxVUlPeVd0T3l3cU8yVXZDQkZRVVJFVWtsT1ZWTkY2NkdjSU95a2tldXp0U0Rzb0pYcnBxenRsWmpzcDREcnA0d2c3WlNFNjZHYzdJUzQ3SXFrSU91Q3JldTVoT3VsdkNEc3BJVHNuYmpyaTZRTkNtWjFibU4wYVc5dUlIZGhhMlZDY21sa1oyVW9LU0I3RFFvZ0lHbG1JQ2gzWVd0cGJtY3BJSEpsZEhWeWJqc05DaUFnZDJGcmFXNW5JRDBnZEhKMVpUc05DaUFnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3SUhkaGEybHVaeUE5SUdaaGJITmxPeUI5TENBMU1EQXdLVHNOQ2lBZ2JHVjBJSEJ5YjJNN0RRb2dJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdEUW9nSUNBZ0x5OGdWMmx1Wkc5M2N6b2dZMjFrd3JkMlluTWc2cks5N0p5Z0lPeVhodXlkdENCdWIyUmw2Nlc4SU95bmdleWdrU3dnZDJsdVpHOTNjMGhwWkdVb1ExSkZRVlJGWDA1UFgxZEpUa1JQVnlucm9ad2c3SXFrN1krd0lPS0FsQTBLSUNBZ0lDOHZJT3l3dlNEc2w0YnJpcFFnN0lpbzdKMkFJT3k5bU95R2xPeWR0Q0RycDR6cms2VHNsclRzcDREcXM2QWc2NHVrNjZhczdKMllJT3lla095TG5TaGpiR0YxWkdVcDY0K0VJT3EzdUNEc3ZaanNocFRzbllRZzY2eTg2NkNrNjdDYjdKV0VJT3lXdE91V3BDRHNzTDNyajRRZzdKV0lJT3Vjck91THBDNE5DaUFnSUNBdkx5QmtaWFJoWTJobFpPdUtsQ0RzazdEc3A0QWc3SldLNjRxVTY0dWtLR1JsZEdGamFHVmtLM2RwYm1SdmQzTklhV1JsSU95aHNPMlZxZXlkZ0NEc3ZaanNocFFnN0xDOTdKMjBJT3VGdU95Mm5PdVFxQ0RpZ0pRZzdJdWs3TGloS1M0TkNpQWdJQ0F2THlCWGFXNWtiM2R6N0plUTdJU2dJR1JsZEdGamFHVmtJT3lYaHV5ZHRPdVBoQ0RydG9EcnFxZ282ckNRN0l1YzdKNlFLZXF3Z0NEc283M3NsclRyajRRZzdKNlE3SXVkN0oyQUlPeUN0T3lWaE91Q3FPdUtsT3VMcEM0TkNpQWdJQ0J3Y205aklEMGdjM0JoZDI0b2NISnZZMlZ6Y3k1bGVHVmpVR0YwYUN3Z1czQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2RqYkdGMVpHVXRZbkpwWkdkbExtcHpKeWxkTENCN0RRb2dJQ0FnSUNCamQyUTZJRkpQVDFRc0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2QybHVaRzkzYzBocFpHVTZJSFJ5ZFdVc0RRb2dJQ0FnZlNrN0RRb2dJSDBnWld4elpTQjdEUW9nSUNBZ0x5OGdiV0ZqVDFNdjY2YXM2NGlGN0lxa09pRHFzSkRzaTV6c25wRHJwYndnNjUyRTdKcTBJRzV2WkdVZzdJdWs3WmFKSU8yTWpPeWR2T3VobkNEc3A0SHNvSkVnN0lxazdZK3dJQ2hzWVhWdVkyaGtJTzJabU9xeXZleVhsQ0JRUVZSSTZyQ0FJT3U1aU95VnZlMlZvQ0RzaUpnZzdKNkk3SmEwSU95Z2lPdU1nT3F5dmV1aG5DRHNncXpzbXFrcERRb2dJQ0FnY0hKdll5QTlJSE53WVhkdUtIQnliMk5sYzNNdVpYaGxZMUJoZEdnc0lGdHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTNXFjeWNwWFN3Z2V3MEtJQ0FnSUNBZ1kzZGtPaUJTVDA5VUxDQmtaWFJoWTJobFpEb2dkSEoxWlN3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTEEwS0lDQWdJSDBwT3cwS0lDQjlEUW9nSUhCeWIyTXVkVzV5WldZb0tUc2dMeThnNnJDUTdJdWM3SjZRSU95ZHRPdXlwTzJLdUNEcm82anRsSVRzbDVEc2hKd2c2N2FFNjZhc0lDanFzSkRzaTV6c25wQWc3S0tGNjZPTTY2VzhJT3VuaWV5bmdDRHNsWXJxc293cERRcDlEUW9OQ2k4dklPeWR0Q0JRUSt1bHZDQW43SVNrN0xtWUlPeWdoQ2pzZzRnZ1VFTXBKeURzZzRIdGc1enJvWndnNjVDWTY0K002NmF3NjR1a0lPS0FsQ0R0bEl6cm42enF0N2pzbmJnZ1creTBpT3E0c08yWmxGMGc2N0tFN1lxOEtGQlBVMVFnTDNWdWFXNXpkR0ZzYkNuc25iUWc2N2FBNjZXNDY0dWtMZzBLTHk4Z2NtVm5hWE4wWlhJdGNISnZkRzlqYjJ3dWFuUHFzSUFnN0lTazdMbVk3WldjSU9xeWcreWRoQ0RxdDdqcmpJRHJvWndnNjVDWTY0K002NmF3NjR1a09pRHFzSkRzaTV6c25wQWc3SjZRNjQrWjdJdWM3SjZSSUNzZ0tPeWVpT3ljdk91cHRDa2c3SVNrN0xtWUlPMlB0T3VObEM0TkNpOHZJT0thb08rNGp5RHJzSmpyazV6c2k1d2dTRlJVVUNEc25aSHJpN1hzbllRZzY2aTg3S0NBSU91enRPdUN1Q0Rya3FRZzdaaTQ3TGFjN1pXZ0lPcXlneURpZ0pRZ2JXRmpUMU1nYkdGMWJtTm9ZM1JzSUdKdmIzUnZkWFRzbmJRZzdKMjBJTzJVaE91aG5PeUV1T3lLcE91bHZDRHNwb25zaTV3ZzdLS0Y2Nk9NN0l1YzdZS3NJT3lJbUNEc25vanJpNlF1RFFvdkx5QWdJQ0RxdDdqcm5wanNoSndnN1l5TTdKMjhLSEJzYVhOMHdyZnNoS1RzdVpnZzdZKzA2NDJVS2V5ZGhDQnNZWFZ1WTJoamRHenJzN1RyaTZRZzY2aTg3S0NBSU95bmdPeWF0T3VMcENEaWdKUWdZbTl2ZEc5MWRPeWR0Q0RzbXJEcnBxenJwYndnN0tPOTdKZXM2NCtFSU95ZWtPdVBtZXlMbk95ZWtleWRnQ0RzbmJUcnI3Z2c3SUtzNjUyODdLZUU2NHVrTGcwS1puVnVZM1JwYjI0Z2RXNXBibk4wWVd4c1UyVnNaaWdwSUhzTkNpQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlGdGRPdzBLSUNCMGNua2dldzBLSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBblpHRnlkMmx1SnlrZ2V3MEtJQ0FnSUNBZ1kyOXVjM1FnVEVGQ1JVd2dQU0FuWTI5dExtTnNZWFZrWldKeWFXUm5aUzUzWVhSamFHVnlKenNOQ2lBZ0lDQWdJR052Ym5OMElIQnNhWE4wSUQwZ2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSjB4cFluSmhjbmtuTENBblRHRjFibU5vUVdkbGJuUnpKeXdnVEVGQ1JVd2dLeUFuTG5Cc2FYTjBKeWs3RFFvZ0lDQWdJQ0JqYjI1emRDQnBibk4wSUQwZ2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSjB4cFluSmhjbmtuTENBblFYQndiR2xqWVhScGIyNGdVM1Z3Y0c5eWRDY3NJQ2REYkdGMVpHVkNjbWxrWjJVbktUc05DaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0hCc2FYTjBLU2tnZXlCbWN5NTFibXhwYm10VGVXNWpLSEJzYVhOMEtUc2djbVZ0YjNabFpDNXdkWE5vS0hCc2FYTjBLVHNnZlNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWdmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNpQWdJQ0FnSUhSeWVTQjdJSE53WVhkdVUzbHVZeWduYkdGMWJtTm9ZM1JzSnl3Z1d5ZGliMjkwYjNWMEp5d2dKMmQxYVM4bklDc2djSEp2WTJWemN5NW5aWFIxYVdRb0tTQXJJQ2N2SnlBcklFeEJRa1ZNWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0Nkc1lYVnVZMmhqZEd3bkxDQmJKM0psYlc5MlpTY3NJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXcwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5WldjbkxDQmJKMlJsYkdWMFpTY3NJQ2RJUzBOVlhGeFRiMlowZDJGeVpWeGNUV2xqY205emIyWjBYRnhYYVc1a2IzZHpYRnhEZFhKeVpXNTBWbVZ5YzJsdmJseGNVblZ1Snl3Z0p5OTJKeXdnSjBOc1lYVmtaVUp5YVdSblpWZGhkR05vWlhJbkxDQW5MMlluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNnbjdKNlE2NCtaN0l1YzdKNlJLRU5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWElwSnlrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5WldjbkxDQmJKMlJsYkdWMFpTY3NJQ2RJUzBOVlhGeFRiMlowZDJGeVpWeGNRMnhoYzNObGMxeGNZMnhoZFdSbFluSnBaR2RsSnl3Z0p5OW1KMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE95QnlaVzF2ZG1Wa0xuQjFjMmdvSjJOc1lYVmtaV0p5YVdSblpUb3ZMeURyazdIcm9aMG5LVHNnZlNCallYUmphQ0FvWDJVcElIdDlEUW9nSUNBZ0lDQjBjbmtnZXcwS0lDQWdJQ0FnSUNCamIyNXpkQ0JwYm5OMElEMGdjR0YwYUM1cWIybHVLSEJ5YjJObGMzTXVaVzUyTGt4UFEwRk1RVkJRUkVGVVFTQjhmQ0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5RWEJ3UkdGMFlTY3NJQ2RNYjJOaGJDY3BMQ0FuUTJ4aGRXUmxRbkpwWkdkbEp5azdEUW9nSUNBZ0lDQWdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLR2x1YzNRcEtTQjdJR1p6TG5KdFUzbHVZeWhwYm5OMExDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTd2dabTl5WTJVNklIUnlkV1VnZlNrN0lISmxiVzkyWldRdWNIVnphQ2hwYm5OMEtUc2dmUTBLSUNBZ0lDQWdmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnZlEwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpQm1ZV2xzTFhOdlpuUWc0b0NVSU91cXV5RHNwNERzbXJRZzZyS01JT3llaU95V3RPdVBoQ0R0bEl6cm42enF0N2pzbmJnZzdLcTlJT3E0c095V3RTRHNncTNzb0p6cmlwUWc3SjIwNjYrNElPdUJuZXVDck91THBDQXFMeUI5RFFvZ0lISmxkSFZ5YmlCeVpXMXZkbVZrT3cwS2ZRMEtEUW92THlEcmk2VHJwcXdvTVRFNE9EZ3A2ckNBSU91V29DRHNub2pzbkx6cnFiUWc2NEdJNjR1a0lPS0FsQ0RzdElqcXVMRHRtWlFnN0l1Y0lPdUNxT3lkZ0NEc2hManNoWmdnN0tDVjY2YXNJQ2pzbDRic25MenJxYlFnN0tHdzdKcXA3WjZJSU95THBPMk1xQ2tOQ21aMWJtTjBhVzl1SUhOb2RYUmtiM2R1UW5KcFpHZGxLQ2tnZXcwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElISWdQU0JvZEhSd0xuSmxjWFZsYzNRb2V5Qm9iM04wT2lBbk1USTNMakF1TUM0eEp5d2djRzl5ZERvZ01URTRPRGdzSUhCaGRHZzZJQ2N2YzJoMWRHUnZkMjRuTENCdFpYUm9iMlE2SUNkUVQxTlVKeXdnZEdsdFpXOTFkRG9nTVRVd01DQjlMQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3ZlNrN0RRb2dJQ0FnY2k1dmJpZ25kR2x0Wlc5MWRDY3NJQ2dwSUQwK0lIc2dkSEo1SUhzZ2NpNWtaWE4wY205NUtDazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZTQjlLVHNOQ2lBZ0lDQnlMbVZ1WkNncE93MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DbjBOQ2cwS1kyOXVjM1FnYzJWeWRtVnlJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvS0hKbGNTd2djbVZ6S1NBOVBpQjdEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIME5DaUFnYVdZZ0tISmxjUzUxY213Z1BUMDlJQ2N2YUdWaGJIUm9KeWtnZXcwS0lDQWdJQzh2SUhZNklPcXdrT3lMbk95ZWtDRHN2WlRyazV3ZzY3S0U3S0NFSU9LQWxDRHF0YXpyc29Uc29JUWc3WlNFNjZHYzdJUzQ3SXFrNnJDQUlPcXpoT3lHalNEcmo0enFzNkFnN0o2STY0cVU3S2VBSU91d2x1eVhrT3lFbkNEdG1aWHNuYmp0bFpqcmlwUWc3SnFwNjQrRURRb2dJQ0FnTHk4Z0tIWXlJRDBnN0xDOUlPeUlxT3E1Z0NEc2lKanNvSlh0akpBc0lIWXpJRDBnTDJGalkyOTFiblFnN0xhVTZyQ0E3WXlRTENCMk5DQTlJQzkxYm1sdWMzUmhiR3dnN0xhVTZyQ0E3WXlRS1EwS0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQjNZWFJqYUdWeU9pQjBjblZsTENCMk9pQTBJSDBwT3cwS0lDQjlEUW9nSUM4dklPeWR0Q0JRUSt5WGtDRHJvWnpxdDdqc25ianJrSndnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0RpZ0pRZzdaU002NStzNnJlNDdKMjRJT3l5cXlEdG1aVHJxYlRDdCsyWmlPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFRzcDRBaUlPdXp0T3lYck95anZPdUtsQ0RyamJBZzdKTzA2NHVrTGcwS0lDQXZMeURxc0pEc2k1enNucERxc0lBZzY0dTE3WldZNjRxVUlPeWR0T3ljb0RvZzY0dWs2NmFzNjZXOElPeThuT3VwdENEc200enJzSTNzbDRYc25MenJvWndnN1lHMDY2R2M2NU9jNnJDQUlPeUxwT3lnbkNEdG1ManN0cHpyajd3ZzZyV3M2NCtGSU95Q3JPeWFxZXVmaWV5ZHRDRHJncGpxc0lUcmk2UXVEUW9nSUM4dklPcXdrT3lMbk95ZWtPdUtsQ0R0akl6c25ienJwNHdnN0oyOTdKeTg2NitBNjZHY0lPeUNyT3lhcWV1ZmlTQXdJTUszSU91TWdPcTRzQ0F3SU9LQWxDRHFzb0R0aHFEcnA0d2c3Sk93NjRxVUlPeUNyT3Vlak95WGtPcXlqQ0RydVlUc21xbnNuWVFnNjZ5ODY2YXM3S2VBSU95Vml1dUtsT3VMcEM0TkNpQWdMeThnN0tPODdKMllPaURzbDZ6cXVMQWc2ck9FN0tDVjdKMjBJT3V6dE95WHJPdVBoQ0Rzbm9Yc25xWHF0b3pzbmJRZzY2ZU02Nk9NNjVDUTdKMkVJT3lJbUNEc25vanJpNlFvN0p5ZzdacW83SVN4N0oyQUlPeUxwT3lnbkNEdG1ManN0cHdnNjVXTTY2ZU1JT3lWakNEc2lKZ2c3SjZJN0oyTUlPS0FsQ0RyaTZUcnBxd2dMMmhsWVd4MGFPeWRtQ0J3Y205aWJHVnRJT3l3dU9xem9Da3VEUW9nSUdsbUlDaHlaWEV1ZFhKc0lEMDlQU0FuTDJGalkyOTFiblFuS1NCN0RRb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJR0ZqWTI5MWJuUTZJR05zWVhWa1pVRmpZMjkxYm5Rb0tTd2dZMnhoZFdSbE9pQm9ZWE5EYkdGMVpHVW9LU0I5S1RzTkNpQWdmUTBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZDJGclpTY3BJSHNOQ2lBZ0lDQnBaaUFvSVdoaGMwTnNZWFZrWlNncEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1WnljZ2ZTazdEUW9nSUNBZ2QyRnJaVUp5YVdSblpTZ3BPdzBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCM1lXdHBibWM2SUhSeWRXVWdmU2s3RFFvZ0lIME5DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM05vZFhSa2IzZHVKeWtnZXcwS0lDQWdJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrc0lESXdNQ2s3RFFvZ0lDQWdjbVYwZFhKdU93MEtJQ0I5RFFvZ0lDOHZJT3kwaU9xNHNPMlpsQ0RpZ0pRZzdKMjBJRkJENjZXOElDZnNnNGdnVUVNbklPeURnZTJEbk91aG5DRHJrSmpyajR6cnByRHJpNlFnS08yVWpPdWZyT3EzdU95ZHVDQmI3TFNJNnJpdzdabVVYU0Ryc29UdGlyd3BMZzBLSUNBdkx5RHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPMmRtT3VncE91enRPdUN1Q0Rya3FRZzdLQ1Y2NmFzN1pXYzY0dWtJT0tBbENCaWIyOTBiM1YwN0oyMElPeWFzT3Vtck91bHZDRHNwb25zaTV3ZzdLTzk3SmVzNjQrRUlPMmFqT3lMb095ZGdDRHJqNFRzc0tudGxaenJpNlF1RFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5MWJtbHVjM1JoYkd3bktTQjdEUW9nSUNBZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2NHeGhkR1p2Y20wNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0RRb2dJQ0FnSUNCemFIVjBaRzkzYmtKeWFXUm5aU2dwT3cwS0lDQWdJQ0FnWTI5dWMzUWdjbVZ0YjNabFpDQTlJSFZ1YVc1emRHRnNiRk5sYkdZb0tUc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiZDJGMFkyaGxjbDBnN0xTSTZyaXc3Wm1VS0hWdWFXNXpkR0ZzYkNrZzRvQ1VJT3lnbk9xeHNEb25MQ0J5WlcxdmRtVmtMbXB2YVc0b0p5d2dKeWtnZkh3Z0p5anNsNGJzbll3cEp5azdEUW9nSUNBZ0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1N3Z01qQXdLVHNOQ2lBZ0lDQjlMQ0F5TlRBcE93MEtJQ0FnSUhKbGRIVnlianNOQ2lBZ2ZRMEtJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TkN3Z2V5Qmxjbkp2Y2pvZ0owNXZkQ0JtYjNWdVpDY2dmU2s3RFFwOUtUc05DZzBLTHk4ZzdKMjA2Nis0SU91V29DRHNub2pzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lpaGV1ampDQW83SjZRNjQrWklPeUxuT3lla1NBcklHNXdiU0JpZFdsc1pDRHNwSkhyczdVZzdJdWs3WmFKSU91TWdPdTVoQ2tOQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXcwS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3cwS0lDQndjbTlqWlhOekxtVjRhWFFvTVNrN0RRcDlLVHNOQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc05DaUFnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHRnYlRyb1p6cms1d2c2NHVrNjZhc0lPcXdrT3lMbk95ZWtDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFySUZCUFVsUXBPdzBLZlNrN0RRb3ZMeUJKVUhZMklPdWpxTzJVaE91d3NTZzZPakVwN0plUTY0K0VJTzJWcU9xN21DRHJrNlByaXBUcmk2UWc0b0NVSUNkc2IyTmhiR2h2YzNRbjZyQ0FJRG82TWV1aG5DRHJxTHpzb0lBZzdaVzA3SVNkNjVDWTY0cVVJTzJabU9xeXZleVhrT3lFbkEwS0x5OGc3WlM4NnJlNDY2ZUlJR1psZEdObzZyQ0FJRWxRZGpUcm9ad2c3WSswNjdDeDdaV1k3S2VBSU95Vml1eVZoQ0RyaTZUcnBxd2c2cm1vN0pxdzZyaXd3cmZxczRUc29KVWc3S0d3N1pxTTZyQ0FJT3loc095YXFlMmVpQ0RzaTZUdGpLanRsWmpyalpnZzY2eTQ3S0NjSU91TWdPeWRrU2pyaTZUcnBxenNtWUFnNjQrWjdKMjhLUzROQ21OdmJuTjBJSE5sY25abGNqWWdQU0JvZEhSd0xtTnlaV0YwWlZObGNuWmxjaWh6WlhKMlpYSXViR2x6ZEdWdVpYSnpLQ2R5WlhGMVpYTjBKeWxiTUYwcE93MEtjMlZ5ZG1WeU5pNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3SUM4dklEbzZNZXlkaENEcnFyc2c3SjZoN0pXRTY0K0VLRVZCUkVSU1NVNVZVMFhDdDBsUWRqWWc3SmVHN0oyTUtTQkpVSFkwNjZlTTdKeTg2NkdjSU9xemhPeUdqU0RyajVuc25wRU5Dbk5sY25abGNqWXViR2x6ZEdWdUtGQlBVbFFzSUNjNk9qRW5LVHNOQ2c9PScKQjY0X0VYQU1QTEVTPSdJeURyckxqcXRhd2c3TGFVN0xLY0lPeVlpT3lMbkFvS0l1dXN1T3ExckNEc3RwVHNzcHpyc0p2cXVMQWk2ckNBSU95Q3JPeWFxZTJWbU91S2xDRHNtSWpzaTV3ZzY2cW83SjJNN0o2RjY0dUk2NHVrTGlBcUt1eWR0Q0R0akl6c25ienNuWVFnN0lpWTdLQ1Y3WldjSU91U3BDRHRoTERycjdqcmhKRHNsNURzaEp3Z1lHNXdiU0J5ZFc0Z1luVnBiR1JnNjZXOElPeUxwTzJXaWUyVm1PcXpvQ3dnUm1sbmJXSHNsNURzaEp3ZzdaU002NStzNnJlNDdKMjQ3SjJFSU91THBPeUxuQ0RzaTZUdGxvbnRsWmpycWJRZzY3Q1k3SmlCNjVDcDY0dUk2NHVrTGlvcUNnb2pJeURzbnBIc2hMRWc2N0NwNjdLVkNnb3RJT3lZaU95TG5DRHRsWmpyZ3BqcmlwUWdLaXBnSXlNaklPeWJrT3V6dUdBcUtpRHRsWndnN0tTRTZyTzhMQ0RxdDdnZzdKV0U2NTZZSUNvcVlDMGc3TGFVN0xLYzdKV0lZQ29xSU95WHJPdWZyQ0Rxc0p6cm9ad2c3SjIwNjZTRTdLZVI2NHVJNjR1a0xnb3RJT3kybE95eW5PeVZpQ0RzbFlqc2w1RHNoSndnS2lyc3BJVHNuWVFnNjdDVTZyNjQ2ck9nSU95THR1eWN2T3VwdENCZ0lDOGdZQ0FvN0pXZTY1S2tJT3F6dGV1d3NTRHRqNnp0bGFnZzdJcXM2NTZZN0l1Y0tTb3FJT3VobkNEdGtaenNpNXp0bFpqc2hManNtcFF1SU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEcmtaQWc3S1NFNjZHY0lPdXp0T3lYck95bmtldUxpT3VMcEM0S0xTRHNncXpzbXFuc25wRHFzSUFnN0o2RjY2Q2w3WldjSU91c3VPcTFyT3F3Z0NCZzdKdVE2N080WU9xenZDQW82ck8xNjdDeHdyZnJyTGpzbnFYcnRvRHRtTGdnNjZ5MDdJdWM3WldZNnJPZ0tTRHFzSm5xc2JEcmdwZ3NJT3lFbk91aG5DRHRqNnp0bGFqdGxaanJxYlFnNnJlNElPeTJsT3l5bk95VmlPdVRwT3lkaENEcnM3VHNsNnpzcEkzcmk0anJpNlF1Q2kwZzY2ZWs3TG10N1pXZ0lPdVZqQ0FxS3V1bmlPeUtwTzJDdWV1UW5DRHNuYlRycG9RbzdabU5YQ3JyajVrcExDRHNpS3ZzbnBBbzdLQ0U3Wm1VNjdLSTdaaTR3cmNpN0ptNElETHJxb1VpSU91VHNTbnJpcFFnNjZ5MDdJdWNLaXJ0bGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWFsR0FnWUg3cmo3enNtcFJnSUdCKzdKZUc3SmEwN0pxVVlDQmdmdTJWdENEc283enNoTGpzbXBSZ0tRb3RJRExyaTZnZzZyV3M3S0d3T2lBcUt1eXlxeURzcElROTdJT0I3Wm1wSU95RXBPdXFoU0RpaHBJZzY1R1k3S2U0SU95a2hEM3JpNlRzbll3ZzdaYUo2NCtaS2lvbzZyS3c3S0NWN0oyQUlHQis3WldnNnJtTTdKcVVQMkFzSU8yV2lldVBtU0RzbktEcmo0VHJpcFFnWUg3dGxiUWc3S084N0lTNDdKcVVZQ2tLTFNEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0tPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ2tzSU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBbzdKZUc3SmEwN0pxVTRvYVNmdTJWbU91cHRDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDa0tMU0RzdXBEc283enNscnp0bFp3ZzZySzk3SmEwS0g3c2k1enFzcURzbHJUc21wUS80b2FTZnUyVm9PcTVqT3lhbEQ4cExDRHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNDanNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2M0b2FTN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5Da0tMU0Rxc0lUcXNyRHRsWmpxczZBZzdJbXM3SnEwSU91bmtDQW83S0NFN0lhaDRvYVM2N08wNjRLMDY0dWtLU3dnNjdhQTdLQ1ZJT3lEZ2UyWnFldVBoQ0RybExIcmxMSHRsWmpzcDRBZzdKV0s2cktNS0NMc3NMN3F1TEFnN0l1azdZeW9JdUtkakNBaTdMQys3SjJFSU95SW1DRHNsNGJzbHJUc21wUWk0cHlGS1FvS0l5TWc3TGFVN0xLY0lPeVlpT3lMbkFvS0l5TWpJT3luaE8yV2llMlZtT3VObUNEc25wSHNsNFhzbmJRZzdKNkk3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0tlRTdaYUpJT3lra2V5ZHVDRHJnclRzbDYzc25iUWc3SjZJN0phMDdKcVVMaUF2SU95ZHRPeVd0T3lFbkNEc3A0VHRsb250bGFEcXVZenNtcFEvQ2dvakl5TWc2ck8xN0p5Z0lPeWFsT3l5cmV5ZGhDRHN0NmpzaG96dGxaanJxYlFnN0pxVTdMS3RJT3VDdE95WHJleWR0Q0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kzcU95R2pPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXloT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwSU95anZPeUV1T3lhbEM0Z0x5RHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2lNakl5RHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4S0xTRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhLTFNEc2k2RHFzNkFnN0oyMDdKeWc2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0o2VTdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVQ2kwZzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMZ29LSXlNaklPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnN0ptNElETHJxb1hzbDVEcXNvd2c2cmFNN1pXY0lPeUNyZXlnbkNEc2xZenJwcnp0aHFIc25ZUWc3S0NFN0lhaDdaV2c2cm1NN0pxVVB3b3RJT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3RPdWdwT3F6b0NEdGxiVHNtcFF1SUM4ZzdabU5LdXVQbVNnd01UQXRNVEl6TkMwMU5qYzRLU0RyaTVnZzdKbTRJRExycW9Yc2w1RHFzb3dnNjdPMDY0Szg2cm1NN0pxVVB3b3RJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzY0dVlJT3ladUNBeTY2cUY3SmVRNnJLTUlPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdk9xNWpPeWFsRDhLTFNEcXRvenRsWndnN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4S0NpTWpJeURyb1p6cXQ3anNsWVRzbTRNZzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3Vobk9xM3VPeVZoT3liZysyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbGJIc25ZUWc3S0tGNjZPTTdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3lWc2V5ZGhDRHNvb1hybzR6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nN1pXY0lPdXlpQ0RyczREcXNyM3RsWmpycWJRZzY0dWs3SXVjSU91emdPcXl2ZTJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzY0dWs3SXVjSU91d2xPcS9nQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6aE95R2plMlZvT3E1ak95YWxEOEtDaU1qSXlEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpya0tucmk0anJpNlF1SU95MGlPcTRzTzJabE8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmo3enNtcFF1SUM4ZzdMU0k2cml3N1ptVTdaV2c2cm1NN0pxVVB3b0tJeU1qSXlEc2w1RHJuNnpDdCt5THBPMk1xQW9LSXlNaklPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPdUVwTzJLdU95YmpPMkJyT3lYa0NEc2w3RHFzckR0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc2w3RHFzckFnN0lPQjdZT2M2Nlc4SU8yWmxleWR1TzJWbU9xem9DRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ienNpNXpzb0lIc25iZ2c3SmlrNjZXWTZyQ0FJT3V3bk95RG5lMldpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0RzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0k3Wmk0NjZXOElPeWVyT3V3bk95R29lMlZtT3lMcmV5TG5PeVlwQzRLTFNEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95bmdPdUNyT3lXdE95YWxDNGdMeURzbmJqc3BwM3Jzb2p0bUxqcnBid2c2NHVrN0l1Y0lPdXdtK3lWaENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzbHJUc21wUXVJQzhnNjR1azY2VzRJT3F5Z095RGlleVd0T3VobkNEcmk2VHNpNXdnN0xDKzdKV0U2N08wN0lTNDdKcVVMZ29LSXlNaklPeWdsZXV6dE91bHZDRHJ0b2pybjZ6c21LVHNwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNvSlhyczdUcnBid2c2N2FJNjUrczdKaXNJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHRqSXpzbmJ3ZzdKZUY2NkdjNjVPYzdKZVFJT3lMcE8yTXFPMldpT3lLdGV1TGlPdUxwQzRLTFNEdGpJenNuYnpzbllRZzdKaXM2NmFzN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRnTHlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0tDUTZyS0FJT3lra2V5ZWhldUxpT3VMcEM0ZzdKMjA3SnFwN0plUUlPdTJpTzJPdU95ZGhDRHJrNXpyb0tRZzdLT0U3SWFoN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHNoSnpydVlUc2lxVHJwYndnN0tDUTZyS0E3WldZNnJPZ0lPeWVpT3lXdE95YWxDNGdMeURzb0pEcXNvRHNuYlFnNjRHZDY0S1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxZVHNpSmdnN0o2RjY2Q2xJTzJWcmV1cXFleWVoZXVMaU91THBDNEtMU0RxdkswZzdKNkY2NkNsN1pXMDdKVzhJTzJWbU91S2xDRHRsYTNycXFuc25iVHNsNURzbXBRdUNnb2pJeU1qSU9xMmpPMlZuTUszN0lTazdLQ1ZDZ29qSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVBtZXlkbU8yVm1PeW5nQ0RzbFlyc2xZUWc3SjI4NjdhQUlPcTRzT3VLcGV5ZHRDRHNvSnp0bFp6cmtLbnJpNGpyaTZRdUNpMGc3SnlFN0xtWUlPeWdsZXV6dE91bHZDRHRsNGpzbXFudGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3SnlFN0xtWUlPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHNtWVRybzR6Q3QreW5oTzJXaVFvS0l5TWpJT3lnZ095ZXBldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNvSURzbnFYdGxvanNsclRzbXBRdUNnb2pJeU1nNjdPQTZySzk3SUtzN1pXdDdKMjBJT3lnZ2V5YXFldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzNERxc3IwZzY0SzA3SnFwN0oyRUlPeWdnZXlhcWUyV2lPeVd0T3lhbEM0S0NpTWpJeURzb0lUc2hxSHNuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dE91RGlPeVd0T3lhbEM0S0NpTWpJeURyazdIcm9aM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3VUc2V1aG5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1nN0lLdDdLQ2M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lDcmV5Z25PMldpT3lXdE95YWxDNEtDaU1qSXlEdGdiVHJwcjNyczdUcms1enNsNUFnNjdPMTdJS3M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dGV5Q3JPMldpT3lXdE95YWxDNEtDaU1qSXlEc21wVHNzcTNzbllRZzdMS1k2NmFzSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SnFVN0xLdDdKMkVJT3l5bU91bXJPMlZtT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3lWaU91Q3RNSzM3SnlnNjQrRUNnb2pJeU1nN0lPSTY2R2M3SnEwSU91eWhPeWdoT3lkdENEc3RwenNpNXpya0pqc2w0anNpclhyaTRqcmk2UXVJT3lYaGV1TnNPeWR0TzJLdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVZoT3liZyt1UWtPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1RzbFlqc25ZUWc3SnlFN1pXMElPdTVoT3V3Z091eWlPMll1T3VsdkNEcnM0RHFzcjN0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEc2xZanNvSVR0bFp3ZzdJS3M3SnFwN0oyRUlPeWNoTzJWdENEcnVZVHJzSURyc29qdG1ManJwYndnNjdDVTZyK1VJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc2N08wN0pXSUlPeUVuT3U1aE95S3BBb0tJeU1qSU9xeXZldTVoT3VsdkNEcXNKenNpNXp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzZySzk2N21FNjZXOElPeUxuT3lla2UyVm9PcTVqT3lhbEQ4S0NpTWpJeURxc3IzcnVZVHJwYndnN1pXMDdLQ2M3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU9xeXZldTVoT3VsdkNEdGxiVHNvSnp0bGFEcXVZenNtcFEvQ2dvakl5TWc2cml3NnJpdzZyQ0FJT3lZcE8yVWhPdWR2T3lkdUNEc2c0SHRnNXpzbm9Ycmk0anJpNlF1SU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc25ZUWc3Wm1WN0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU9xNHNPcTRzT3F3Z0NEcmhLVHRpcmpzbTR6dGdhenNsNUFnN0pldzZyS3c2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyaXc2cml3N0oyWUlPeVhzT3F5c0NEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21JSHNnNEhzbllRZzY3YUk2NStzN0ppazY0cVVJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKaUI3SU9CN0oyRUlPdTJpT3Vmck95WXBPcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95M3FPeUdqTzJWbU95THBDRHFzcjNzbXJBZzdJdWc3TEt0N1pXWTdJdWdJT3VDdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXdnQ0Rzbm9qcmdwanNtcFEvQ2dvakl5TWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdWx2Q0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTTY0cVVJT3lXdk91bmlPeWR1T3F3Z095YWxEOEtDaU1qSXlEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvY2c2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1Q2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUhJT3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsWmpzaTV6cXNxRHNsclRzbXBRL0NpMGc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOEtDaU1qSXlEc2k1enNucEh0bFpqc2k1enJpcFFnNjdhRTdKZVE2cktNSURVc01EQXc3SnVRN0oyRUlPdVRuT3VncE95YWxDNEtMU0RzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMZ29LSXlNaklPeWR0T3lla0NEdG1aanJ0b2pzbllRZzY3Q2I3SldZN0phMDdKcVVMZ290SU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRdUNnb2pJeU1nN0ppazY0cVk3SjJZSU8yQXRPeW1pT3F3Z0NEcXM2Y2c3S0tGNjZPTTY0Kzg3SnFVTGdvdElPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEM0S0NpTWpJeURxdUlqc25ienF1WXpzcDRBZzY2KzQ2NEtwSU95TG5DRHNsN0Rzc3JRZzdMS1k2NmFzNjVDcDY0dUk2NHVrTGlEdG00VHJ0b2pxc3JEc29Kd2c2cmlJN0pXaDdKMkVJT3VDcWV1MmdPMlZtT3lMbk9xNHNDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdKaWs2NHFZNnJtTTdLZUFJT3VDdE95bmdDRHNsWXJzbkx6cnFiUWc3SmV3N0xLMDY0Kzg3SnFVTGlBdklPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2tPcXlnQ0RxdUxEcXNJVHNsNURyaXBRZzdJU2M2N21FN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHNuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkdENEcmhibnNuWXpya0tucmk0anJpNlF1Q2kwZzY0MlVJT3lpaSt5ZGdDRHNnNEhyaTdUc25ZUWc3SnlFN1pXMElPMkd0ZTJabENEcmdyVHNtcW5zbllBZzY0VzU3SjJNNjQrODdKcVVMZ29LSXlNaklPcXpvT3F3bmV1TG1PeWRtQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkZ0NEcXVMRHJvWjBnNnJTQTY2YXM2NUNwNjR1STY0dWtMZ290SU95ZHRPeWduT3UyZ08yRXNDRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWR0Q0RxdUxEcm9aM3JqN3pzbXBRdUNnb2pJeU1nN0xLdDdJYU02NFdFN0oyQUlPeUVuT3U1aE95S3BDRHFzSURzbm9Yc25iUWc2N2FJNnJDQTdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YWxDNEtDaU1qSXlNZzZyT0U3S0NWd3Jmc25vWHJvS1VLQ2lNakl5RHNsWVRzbmJUcmxKUWc2NWlRNjRxVUlPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3lkdE95RGdTRHNucGpycXJzZzdKNkY2NkNsN1pXWTdKZXNJT3F6aE95Z2xleWR0Q0RzbnFEcXVJZ2c3TEtZNjZhczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3llbU91cXV5RHNub1hyb0tYdGxiVHNoSndnNnJPRTdLQ1Y3SjIwSU95ZW9PcXl2T3lXdE95YWxDNGdMeURydVlUcnNJRHJzb2p0bUxqcnBid2c3SjZzN0lTazdLQ1Y3WldZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNuYlRycjdnZzdJS3M3SnFwSU95a2tleWR1Q0RzbFlUc25iVHJsSlRzbm9Ycmk0anJpNlF1Q2kwZzdKMjA2Nis0SU95VHNPcXpvQ0Rzbm9qcmlwUWc3SldFN0oyMDY1U1U3SmlJN0pxVUxpQXZJT3VMcE91bHVDRHNsWVRzbmJUcmxKVHJwYndnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzM2cml3N1lPQUNnb2pJeU1nN1l5TTdKMjhJT3lhcWV1ZmlleWR0Q0RzdElqcXM3enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlERXdUVUlnN0oyMDdaV1k3SjJZSU8yTWpPeWR2T3VuakNEc2w0WHJvWnpyazV3ZzZyQ0E2NHFsN1pXcDY0dUk2NHVrTGdvdElERXdUVUlnN0oyMDdaV1lJTzJNak95ZHZPdW5qQ0RzbUt6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHRqSXpzbmJ3ZzdKcXA2NStKN0oyRUlPMlpsZXlkdU8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0dWs3SnEwNjZHYzY1T2M2ckNBSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyaTZUc21yVHJvWnpyazV6cnBid2c2NmVJN0xPazdKYTA3SnFVTGdvS0l5TWpJT3F5c095Z25PeVhrQ0RzaTZUdGpLanRsWmpzbUlEc2lyWHJpNGpyaTZRdUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEcXNyRHNvSnp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPcXlzT3lnbkNEc2lKanJpNmpzbllRZzdabVY3SjI0N1pXWTZyT2dJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXWTdKZXNJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXp0ZXF3aE95ZGhDRHRtWlhyczdUdGxad2c2NUtrSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lFbk91NWhPeUtwQ0RzcElEcnVZUWc3S1NSN0o2RjY0dUk2NHVrTGdvdElPeWtnT3U1aE8yVm1PcXpvQ0Rzbm9qcmlwUWc2cml3NjRxbDdKMjA3SmVRN0pxVUxpQXZJT3loc09xNGlPdW5qQ0RxdUxEcmk2VHJvS1FnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3VUc2V1aG5TRHFzSURyaXFYdGxad2c3TFdjNjR5QUlPcXduT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPeWdoTzJabU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPdXdsT3EvZ09xNWpPeWFsRDhLQ2lNakl5RHJzS25yckxnZzdKaUk3Slc5N0oyMElPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnNLbnJyTGdnN0ppSTdKVzk3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEcnVZVHJzSURyc29qdG1MZ2dOZTJhakNEc21LVHJwWmpyb1p3ZzZyT0U3S0NWN0oyMElPeWVvT3E0aUNEc3NwanJwcXpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJRFh0bW93ZzdKNlk2NnE3SU95ZWhldWdwZTJWdE95RW5DRHFzNFRzb0pYc25iUWc3SjZnNnJLODdKYTA3SnFVTGlBdklPdTVoT3V3Z091eWlPMll1T3VsdkNEc25xenNoS1Rzb0pYdGxaanJxYlFnNjR1azdJdWNJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd0lDanNsNGJzbHJUc21wUWc0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFwQ2dvakl5TWc2N080N0oyNElPeWR1T3ltbmV5ZGhDRHRsWmpzcDRBZzdKV0s3Snk4NjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEcnM3anNuYmdnN0oyNDdLYWQ3SjJFSU8yVm1PdXB0Q0RycXFqcms2QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeWR0T3VwbE95ZHZDRHNuYmpzcHAwZzdLQ0U3SmVRNjRxVUlPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95ZHRPdXBsT3lkdkNEc25ianNwcDNzbllRZzY2ZUk3TG1ZNjZtMElPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95L29PMlBzT3lkZ0NEcm9aenF0N2pzbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjBJT3lnbk8yVm5PdVFxZXVMaU91THBDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXWTY2bTBJT3VxcU91VG9DRHF1TERyaXFYc25ZUWc3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzY3aVU2Nk9vN1lpczdJcWs2ckNBSU9xNnZPeWd1Q0Rzbm9qc2xyUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU91NGxPdWpxTzJJck95S3BPdWx2Q0Rzdkp6cnFiUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU91NWhPeURnU0RzbDdEcm5iM3NzcGpxc0lBZzY1T3g2NkdkNjVDWTdLZUFJT3lWaXV5Vm1PeUt0ZXVMaU91THBDNEtMU0RydVlUc2c0RWc3SmV3NjUyOTdMS1k2Nlc4SU91VHNldWhuZTJWbU91cHRDRHF1TFRxdUludGxhQWc2NVdNSU91NW9PdWx0T3F5akNEc2w3RHJuYjNyazV6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzdHB6c25vVWc3TG0wNjVPYzZyQ0FJT3VUc2V1aG5ldVFtT3luZ0NEc2xZcnNsWVFnN0lLczdKcXA3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdMYWM3SjZGSU95NXRPdVRuT3VsdkNEcms3SHJvWjN0bFpqcnFiUWc2N0NVNjZHY0lPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0lDanNtWVRybzR3ZzdKV0k2NEswS1FvS0l5TWpJTzJhak95YmtPcXdnT3llaGV5ZHRDRHNtWVRybzR6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzZyQ0E3SjZGN0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHNtSWpzbGIzc25iUWc3TGVvN0lhTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeVlpT3lWdmV5ZGhDRHN0NmpzaG96dGxvanNsclRzbXBRdUNnb2pJeU1nNjZ5NDdKMlk2ckNBSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SWljN0xDbzdLQ0I3Snk4NjZHY0lPdUx0ZXV6Z091VG5PdW1yT3F5b095S3RldUxpT3VMcEM0S0xTRHJyTGpzblpqcnBid2c3S0NSN0lpWTdaYUk3SmEwN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTA2NWFrSU91d3FldXlsZXljdk91aG5DRHNuYmpzcHAzdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SjI0N0thZElPdXdxZXV5bGV5ZGhDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPcXlzT3lnbk8yVm1PeUxwQ0RzdWJUcms1enJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rxc3JEc29KenRsYUFnN0xtMDY1T2M2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0p1UTdaV1k3SXVjNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsWmpzaExqc21wUXVDaTBnN0p1UTdaV1k2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWp2T3lHak91bHZDRHNsWXpxczZBZzZyT0U3SXVnNnJDQTdKcVVQd290SU95anZPeUdqT3VsdkNEc2xZenFzNkFnN0o2STY0S1k3SnFVUHdvS0l5TWpJeURycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQW9LSXlNaklPcTRzT3F3aENEcnA0enJvNHpyb1p3ZzdKMjA3SnFwN0oyMElPeWtrZXluZ091UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc25iVHNtcWtnNnJpdzZyQ0U3SjIwSU91Qm5ldUNtT3lFbkNEc3A0RHF1SWpzbllBZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0pxcDY1K0pJT3UyZ095aHNleWN2T3VobkNEc29JRHNucVhzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95Z2dPeWVwZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1Q2dvakl5TWc3WWExN0l1Z0lPeVlwT3VsbU91aG5DRHNtcFRzc3Ezc25iUWc3SXVrN1l5bzdaV1k3SmlBN0lxMTY0dUk2NHVrTGdvdElPMkd0ZXlMb095ZHRDRHNtNUR0bVp6dGxaanNwNEFnN0pXSzdKV0VJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95anZPeUdqT3VsdkNEdG1aWHNuYmp0bFpqcXNiRHJncGdnN1ptSTdKeTg2NkdjSU95ZHRPdVBtZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjQrWjdKMjg3WldjSU95YWxPeXlyZXlkdENEc3NwanJwcXdnN0tTUjdKNkY2NHVJNjR1a0xpRHNucURzaTV3ZzdadUVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc2ckNaN0oyQUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanFzNkFnN0o2STdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYlRyc3FUdGlyanFzSUFnN0tLRjY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdE91eXBPMkt1T3F3Z0NEcmdaM3JncXpzbHJUc21wUXVDZ29qSXlNZzdZT0k3WWUwSU95TG5DRHJxcWpyazZBZzY0Mnc3SjIwN1lTdzZyQ0FJT3lDcmV5Z25PdVFtT3Vwc0NEcnM3WHF0YXp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHRnNGp0aDdUdGxaanJxYlFnNjZxbzY1T2dJT3VOc095ZHRPMkVzT3F3Z0NEc2dxM3NvSnpya0pqcXM2QWc2NHVrN0l1Y0lPdVFtT3VQak91bXRDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWdsZXVua0NEdGc0anRoN1R0bGFEcXVZenNtcFEvQ2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3lEZ2UyWnFTRHNsWWpyZ3JRcENnb2pJeU1nNjdhQTdKNnNJT3lra1NEcnNLbnJyTGpzbnBEcXNJQWc2ckNRN0tlQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTJnT3llckNEc3BKSHNsNUFnNjdDcDY2eTQ3SjZRNnJDQUlPeWVpT3lYaU95V3RPeWFsQzRnTHlEc21JSHNnNEhzbllRZzdabVY3SjI0N1pXMElPdXp0T3lFdU95YWxDNEtDaU1qSXlEcXNyM3J1WVFnN1pXMDdLQ2NJT3Eyak8yVm5PeWR0Q0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cks5NjdtRUlPMlZ0T3lnbkNEcXRvenRsWnpzbmJRZzdaV0U3SnFVN1pXMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RzbXBUc3NxM3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRtSnp0ZzUwZzdKZUc3SjIwSU9xd2dPeWVoZTJWb09xNWpPeWFsRDhnN0tlQTZyaUlJT3lMb095eXJlMlZtT3luZ0NEc2xZcnNuTHpycWJRZzdKdXc3THUwSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzcDREcXVJZ2c3SXVnN0xLdDdaV1k2Nm0wSU95YnNPeTd0Q0R0bUp6dGc1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0wrZzdZK3dJT3lYaHV5ZHRDRHFzckRzb0p6dGxhRHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1Q0RzdjZEdGo3RHNuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUNpMGc3TCtnN1krdzdKMkVJT3V3bSt5Y3ZPdXB0Q0RyalpRZzdLQ0E2NkMwN1pXWTZyS01JT3F5c095Z25PMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95VmpPdW12Q0RzbDRic25iUWc3SXVjN0o2UjdaV2c2cm1NN0pxVVB5RHNsWXpycHJ6c25ZUWc3THljN0tlQUlPeVZpdXljdk91cHRDRHNwSkhzbXBUdGxad2c3SWFNN0l1ZDdKMkVJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPeVZqT3Vtdk95ZGhDRHN2SnpycWJRZzdLU1I3SnFVN1pXY0lPeUdqT3lMbmV5ZGhDRHJzSlRyb1p3ZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdKNlE2NCtaN0oyMDdMSzA2Nlc4SU91VHNldWhuZTJWbU95bmdDRHNsWXJxczZBZzY0U1k3SmEwNnJDSTZybU03SnFVUHlEcms3SHJvWjN0bFpqc3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNucERyajVuc25iVHNzclRycGJ3ZzY1T3g2NkdkN1pXWTY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURyczdnZzZyT0U3Slc5N0oyWUlPeWNvT3lkdk8yVm5DRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95ZHZPdXdtT3EwZ091bXJPeWVrT3VobkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0nCkI2NF9HVUlERT0nSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5BMEtEUW9qSXlBeExpRHRsYlRzbXBUc3NyUU5DZzBLN0tDYzdaS0lJT3lWaU95ZG1DRHJxcWpyazZBZzY2eTQ2cldzNjRxVUlDZnRsYlRzbXBUc3NyUW42NkdjSU95TnFPeWFsQzROQ3V5ZHZPcTBnT3lFc1NEc25vanJpcFFnN0lLczdKcXA3SjZRSU9xeXZlMlhtT3lkaENEcnA0enJrNlFnN0lpWUlPeWVpT3VQaE91aG5TQXFLdXlEZ2UyWnFTd2c2NmVsNjUyOTdKMkVJT3UyaU91c3VPMlZtT3F6b0NEcnFxanJrNkFnNjZ5NDZyV3M3SmVRSU8yVnRPeWFsT3l5dE91bHZDRHNvSUhzbXFudGxiVHNvN3pzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEcnM3VHJnNFhyaTRqcmk2UWc0b2FTSU91enRPdUN2T3F5ak95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJT3kxbk91TWdPMlZuQ0FxS3V1S3BldVBtZTJZbFNEcnJManNucVVxS3V5ZGhDRHNqYWpzbzd6c2hManNtcFF1SU95SW1PdVBtZTJZbFNEcnJManNucVhzbllBZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TVMzc2lKanJqNW50bUpVdDY2eTQ3SjZsN0oyRUxleU5xT3VQaEMzcmtKanJpcFF0NnJLOTdKcXdLZXlYa0NEdGxiVHJpN250bGFBZzY1V002NmVNSU95VHNPdUtsQ0Rxc293ZzdLS0w3SldFN0pxVUxnMEtEUW9qSXlNZzY1Q1E3SmEwN0pxVUlPS0draUR0bG9qc2xyVHNtcFFOQ2cwSzdKaUlLUTBLTFNEc2hLVHNvSlhya0pEc2xyVHNtcFFnNG9hU0lPeUVwT3lnbGUyV2lPeVd0T3lhbEEwS0RRb2pJeU1nSjM3c2w0Z25JT3U1dk9xNHNBMEtEUXJzbUlncERRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVURRb05DaU1qSXlEcmo1bnNncXdnNjdDVTZyK1U3Sk93NnJpd0RRb05DdXlZaUNrTkNpMGc2NGFTN0pXRTdLR003SmEwN0pxVUlPS0draURzbUt6cm5wRHNsclRzbXBRTkNnMEtLaW9xRFFvTkNpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBTkNnMEs3S0NjN1pLSUlPeVZpT3lYa095RW5DRHJ0b0Rzb0pYc29JRWc3THVrNjY2azY0dUk3THlBN0oyMDdJV1k3SjJFSU95MW5PdU1nTzJWbkNEc3BJVHNuYlRxczZBZzZyaU43S0NWN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpzbzd6c2hManNtcFF1RFFycnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRNdDY3YUE3S0NWN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2phanNtcFF1RFFvTkN1eVlpQ0E2SU95VmlDRHJqN3pzbXBRc0lPeVhodXlXdE95YWxDQW9XQ2tnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRZ0tFOHBEUW9OQ2lNakl5RHNsNGJzbHJUc21wUWc0b2FTSU95ZWlPeVd0T3lhbEEwS0RRcnNtSWdwRFFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsWmpxdUxBZzdLQ0U3SmVRNjRxVUlPcXdnT3llaGUyVm9DRHNpSmdnN0plRzdKYTA3SnFVSU9LR2tpRHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WlcwN0pXOElPcXdnT3llaGUyVm9DRHNpSmdnN0o2STdKYTA3SnFVRFFvTkNpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFEUW9OQ3V5WGtPdWZyQ0RzZzRIdG1hbnNsNURzaEp6cmo0UWdJdTJWdE9xeXNDRHJzS25yc3BVaTdKMkVJT3Vvdk95Z2dDRHNsWXpyb0tUc283enJpcFFnNnJpTjdLQ1Y3WmlWSU9xMXJPeWhzT3VobkNEc2phanNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRnNG9hU0lPeVZzZXlkaENEc2w0WHJqYkRzbmJUdGlyanRsYlRzbzd6c2hManNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95MW5PeUxvQ0Ryc29Uc29JVHNuYlFnN1pXRTdKcVU3WlcwN0pxVUxnMEtEUW82T2pvZ2RHbHdJTzJNbmV5WGhTRHJzb1R0aXJ6c25ZQWdXemd1SU8yTW5leVhoVjBnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbEEwSzdZeWQ3SmVGS091THBPeWR0T3lXdk91aG5PcTN1Q2tnNjdLRTdZcThJT3VzdU9xMXJPdUtsQ0RzbFlUcm5wZ2dLaW80TGlEdGpKM3NsNFVxS2lEc2hMbnNoWmdnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbENEaWdKUWc3WWExNjdPMDY0cVVJRnZ0bVpYc25iaGRMQ0RzbUlndjdKV0U2NHVJN0ppa0lPMk1rT3VMcU95ZGdDQmI3SldFNjR1STdKaWtYY0szVyt1RXBGMHNJT3VQbWV5ZWtTRHNuS0RyajRUcmlwUWdXK3kzcU95R2pGM0N0MXZyajVuc25wRmRMaUFpN0xlbzdJYU1JdXVLbENEcmo1bnNucEVnNjdLRTdZcTg2ck84SU95bm5leWR2Q0RybFl6cnA0d2c3Sk93NnJPZ0xDQWk2NHVyNnJpd0lNSzNJT3VQbWV5ZWtTTHNzcGpybjd3ZzdLZWQ3SjIwSU95VmlDRHJwNTdyaXBRZzdLR3c3WldwN0oyQUlPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRbzZPam9OQ2cwS0l5TWpJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eWRoQ0RybFl3TkNnMEs3SmlJS1EwS0xTRHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNGc0b2FTSU95VnZlcTBnT3lYa0NEcmo1bnNuWmp0bFpqcnFiUWc2NnFvN0o2RTdLZUE3SnVRNnJpSTdKMkVJT3V3bSt5ZGhDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb2pJeU1nN1ppYzdZT2RJT3VNZ095RGdTRHNsWWpyZ3JRTkNnMEtLaXJzaEp6cnVZVHNpcVRyaXBRZzdKTzRJT3lJbUNEc25vanNwNERycDR3c0lPMkt1ZXlnbFNEdG1KenRnNTNzbllBZzY3Q2I3SjJFSU95SW1DRHNsNGJzbllRZzY1V01JT0tHa2lEcXVJM3NvSlh0bUpVZzY2eTQ3SjZsN0p5ODY2R2NJT3lOcU95YWxDNHFLZzBLN0lLczdKcXA3SjZRNjRxVUlPdXN1T3Exck91bHZDRHF2THpxdkx6dG5vZ2c3SjI5N0tlQUlPeVZpdXF6b0NEdG01SHNsclRyczdUcXVMQW83SXFrN0xxVUtTRHJsWXpyckxqc2w1QXNJT3UyZ095Z2xlMllsZXljdk91aG5DRHNrN0RycWJRZzdLQ2M3WktJSU95Z2hPeXl0T3VsdkNEc2s3Z2c3SWlZSU95WGh1dUxwT3F6b0NEc21LVHRsYlR0bFpqcXVMQWc3SW1zN0p1TTdKcVVMZzBLRFFyc21JZ3BEUW90SU9xemhPeWlqQ0Rxc0p6c2hLUWc3WmljN1lPZDdKMkFJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlEaWhwSWdOQzQxSlNEcXVJanJwcXdnN1ppYzdZT2Q2NmVNSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTkM0ZzdMcVE3S084N0phODdaV2NJT3F5dmV5V3RBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJQ2QrN0l1YzZyS2c3SmEwN0pxVVB5Y3NJQ2ZzaTV6cmdwanNtcFEvSnl3Z0ozN3F1NWduSU9xd21leWRnQ0Rxczd6cmo0VHRsWndnNnJLOTdKYTA2Nlc4SU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFyc3RaenJqSUR0bFp3ZzdMcVE3S084N0phODdaV1k2ck9nSU95NW5PcTN2TzJWbkNEcnA1RHRpS3pycGJ3ZzdKT3c2NHFVSU9xeWpDRHNvb3ZzbFlUc21wUXVEUXJxc3Izc2xyVHJpcFFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNaTNxc3Izc2xyVHJwYnd0N0kybzY0K0VMZXVRbU91S2xDM3FzcjNzbXJBcDdKZVFJTzJWdE91THVlMlZvQ0RybFl6cnA0d2c3STJvN0pxVUxnMEtEUW9qSXlNZzY0K1o3SUtzN0plUTdJU2NJQ2QrN0l1Y0p5RHJ1YnpxdUxBTkNnMEs3SmlJS1EwS0xTRHN1YlRyazV6cnBid2c3WlcwN0tlQTdaV1k3SXVjNnJLZzdKYTA3SnFVUHlEaWhwSWc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOE5DaTBnN0l1YzdKNlI3WldZN0l1YzY0cVVJT3UyaE95WGtPcXlqQ0ExTERBd01PeWJrT3lkaENEcms1enJvS1RzbXBRdUlPS0draURzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMZzBLRFFvakl5TWdKK3F6aE95TG5PdUxwQ2NnNG9hU0lDZnNub2pyaTZRbkRRb05DdXlZaUNrTkNpMGc3SjZRNjQrWjdMQ282Nlc4SU9xd2dPeW5nT3F6b0NEcXM0VHNpNXpyZ3Bqc21wUS9JT0tHa2lEc25wRHJqNW5zc0tqcXNJQWc3SjZJNjRLWTdKcVVQdzBLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NSU95V3ZPdW5pT3lVcVNEcmdyVHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB5RGlocElnNjZlazY0dXNJT3V6dE8yWG1PdWpqT3VLbENEc2xyenJwNGpzbmJqcXNJRHNtcFEvSUNvbzY0dW83SWljSU95NW1PMlptT3lkdENEc2xZVHJpNGpybmJ3ZzY2eTQ3SjZsN0oyRUlPeURpT3VobkNEc2s3UWc3SUtzNjZHQTdKaUk3SnFVS1NvTkNnMEtJeU1qSUNmc2w2enNyWWpyaTZRbklPS0draUFuN1ptVjdKMjQ3WldZNjR1a0xDRHJyTHZyaTZRbkRRb05DdXlZaUNrTkNpMGc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFINnJDQTdLZUFJT3VMcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUlPS0draURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9mcXNJRHNwNEFnNjR1azdJdWNJTzJabGV5ZHVPMlZvT3F5ak95YWxDNE5DZzBLSXlNaklDZnF1NWduSU9LR2tpQW43SmVRNnJLTUp3MEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbU9xN21DRHJncURzbFlUcXNJRHFzNkFnN0o2STdKYTA3SnFVTGlEaWhwSWc3Wm1ONnJpNDY0K1o2NHVZN0plUTZyS01JT3VDb095VmhPcXdnT3F6b0NEc25vanNsclRzbXBRdURRb05DaU1qSXlEcXNyM3NsclRycGJ3ZzY3cVE3SjJFSU91VmpDRHNsclRzZzRudGxad2c2cks5N0pxd0RRb05DdXlDck95YXFleWVrT3lkbUNEc29KWHJzN1RycGJ3ZzY3Q2I2NHFVSU95bmlPdXN1T3lYa095RW5DRHF1TERxczRUc29JSHNuTHpyb1p3Z0ozN3NpNXduNjZXOElPdTZrT3lkaENEcmxZd2c2Nnk0N0o2bDdKMjBJT3lXdE95RGllMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtLaXJ0akl6c2xZWHRsWmpxczZBZzdJdTI3SjJBSU95Z2xldXp0T3VsdkNBbjdLTzg3SmEwSit1aG5DRHNqYWpzaEp3ZzY2eTQ3SjZsN0oyRUlPeURpT3VocmVxeWpDRHNqYWpyczdUc2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VNZ095Mm5DRHJxcW5zb0lIc25iUWc2NnkwN0plSDdKMjQ2ckNBN0pxVVB3MEtMU0RzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhnNG9hU0lPeUxvT3F6b0NEc25iVHNuS0RycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lFdU95YWxDNE5DZzBLS2lvcURRb05DaU1qSURVdUlDZDc2NnFGN0lLc2ZTQXJJSHZycW9Yc2dxeDlKeURzazdEc3A0QWc3SldLNnJpd0RRb05DaU1qSXlEdGxaenNucERzbHJRZzdaS0E3SmEwN0pPdzZyaXdEUW9OQ3UyVm5PeWVrT3lXdENEcnFvWHNncXpycGJ3ZzdaS0E3SmEwN0lTY0lPdVBtZXlDckNEdG1KWHRnNXpyb1p3ZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrTkNpMGc3SjIwN0o2UUlPMlptT3UyaU95ZGhDRHJzSnZzbFpqc2xyVHNtcFFnNG9hU0lPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUU5DaTBnNjRLMDdKMjhJT3k1dE91VG5PcXdrdXlkdENEcXNyRHNvSnpya0tBZzdKaUk3S0NWN0oyMDdKZVE3SnFVSU9LR2tpRHJnclRzbmJ6c25ZQWc3TG0wNjVPYzZyQ1NJT3VDbU9xd2dPdUtsQ0RyZ3FEc25iVHNsNURzbXBRTkNnMEtJeU1qSU8yVm5PeWVrT3lXdE91bHZDRHRrb0RzbHJUc2s3RHF1TEFnN0phMDY2Q2s3SnE0SU9xeXZleWFzQTBLRFFvbmUrdXFoZXlDckgzcXNJQWdlK3VxaGV5Q3JIM3RsYlRzaEp3bklPMllsZTJEbk91aG5PdW5qQ0R0a29Ec2xyVHNwSmpyajRRZzY0MlVJT3k2a095anZPeVd2TzJWbU9xeWpDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjSU9xMXJPdW5wTzJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFFnNG9hU0lPeWVsT3lWb2V5ZHRDRHJ0b0Rzb2JIdGxiVHNoSndnNnJXczY2ZWs3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ05pNGc3WkdjNnJpd0lPMkd0ZXlkdkEwS0RRb2pJeU1nNjVDWTdKYTA3SnFVSUNoWUtTRGlocElnNjQrODdKcVVJQ2hQS1EwS0RRcnJxcWpyc0pUc25id2c3Wm1VNjZtMDdKMllJT3lpZ2V5ZGdDRHFzN1hxc0lUc25ZUWc2ck9nNjZDazdaVzBJQ2Zya0pqc2xyVHNtcFFuNjRxVUlPdXFxT3VSa0NBbjY0Kzg3SnFVSit1aG5DRHRoclhzbmJ6dGxiVHNoSndnN0kybzdLTzg3SVM0N0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTnk0ZzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt5SXEreWVrQ0R0a1p6cXVMQU5DZzBLNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3V5aU8yWXVPdUtsQ0RzbFlUcm5wZ2c3WmlWN0l1ZDdKeTg2NkdjSU8yR3RleWR2TzJWdE95RW5DRHNqYWpzbXBRdURRb05DaU1qSXlEcmdxRHNwNXpDdCt5TG5PcXdoTUszNnJpdzZyQ0VEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzY0S2c3S2VjSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRVlDQXZJT3lucCtxeWpDQmdUVTB1UkVSZ0lId2dNakF5TlM0d01TNHdNU3dnTWpVdU1ERXVNREVnZkEwS2ZDRHNpNXpxc0lRZ2ZDRHF1TERyczdnZ1lFaElPazFOT2xOVFlDQXZJT3lucCtxeWpDQmdTRWc2VFUxZ0lDanNtS1Rzb0lRdjdKaWs3WnVFSU95VmlDRHNsSUFwSUh3Z01UUTZNekE2TVRFc0lERXpPak13SUh3TkNud2c2cml3NnJDRUlId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVmbGxaV1ZrdVRVMHVSRVJnSUM4ZzdLZW42cktNSUdCWldWbFpMazFOTGtSRWZrMU5Ma1JFWUNCOElESXdNalV1TURFdU1ERitNakF5TlM0d01TNHpNU3dnTWpBeU5TNHdNUzR3TVg0d01TNHpNU0I4RFFwOElPdUNvT3lubkNBcklPeUxuT3F3aENCOElHQlpXVmxaTGsxTkxrUkVJRWhJT2sxTllDQjhJREl3TWpVdU1ERXVNREVnTVRRNk16QWdmQTBLZkNEc21wVHNuYndnZkNCZ1dWbFpXUzVOVFM1RVJDanNtcFRzbmJ3cFlDRGlnSlFnN0p1VUwrMlpsQy9zaUpndjY2cXBMK3E0aUMvdGhxQXY3SjI4SUh3Z01qQXlOUzR3TVM0d01TanNpSmdwSUh3TkNnMEtLaXJzaTV6cXNJUWc3SmlJN0ptNEtpbzZJT3lDck95YXFleWVrT3F3Z0NEc3A0SHNvSkVnNnJPZzY2VzA2NHFVSU91d3FldXN1TUszN0ppSTdKVzlJT3lMbk9xd2hPeWRnQ0JnN0ppazdLQ0VMK3lZcE8yYmhDQklPazFOWU95ZGhDRHNqYWpyajRRZzY0Kzg3SnFVTGcwSzdKaUlLU0RzbUtUdG00UWdNVG93TUEwS0RRb2pJeU1nNjZ5NDdKNmxJT3lHalNEc2w3RHNtNVRzbmJ3TkNnMEs2Nnk0N0o2bElPeVZpT3lYa095RW5PdUtsQ0FxS3V5YmxNSzM3SjI4SU95Vm51eWRtQ0F3N0oyRUlPdTV2T3F6b0NvcUlPeU5xT3lhbEM0TkNnMEs3SmlJS1EwS0xTQXlNREkyNjRXRUlEQTQ3SnVVSURBMTdKMjhJT3llaGV1TGlPdUxwQzRnNG9hU0lESXdNamJyaFlRZ09PeWJsQ0ExN0oyOElPeWVoZXVMaU91THBDNE5DZzBLSXlNaklPeURnZXVNZ0NEc2k1enFzSVFnS091RnVPeTJuT3lhcVNrTkNnMEtmQ0Rzb2JEcXNiUWdmQ0R0a1p6cXVMQWdmQTBLZkMwdExTMHRMWHd0TFMwdExTMThEUXA4SURZdzdMU0lJT3V2dU91bmpDQjhJT3V3cWVxNGlDRHNvSVFnZkEwS2ZDQTJNT3UyaENEcnI3anJwNHdnZkNCTzY3YUVJT3lnaENCOERRcDhJREkwN0l1YzZyQ0VJT3V2dU91bmpDQjhJRTdzaTV6cXNJUWc3S0NFSUh3TkNud2dNekRzbmJ3ZzY2KzQ2NmVNSUh3Z1R1eWR2Q0Rzb0lRZ2ZBMEtmQ0F4TXVxd25PeWJsQ0RycjdqcnA0d2dmQ0JPNnJDYzdKdVVJT3lnaENCOERRcDhJREV5NnJDYzdKdVVJT3lkdE95RGdTQjhJRTdyaFlRZzdLQ0VJSHdOQ2cwSzdKaUlLU0Ryc0tucXVJZ2c3S0NFTENBMTY3YUVJT3lnaEN3Z011eUxuT3F3aENEc29JUXNJRFBzbmJ3ZzdLQ0VMQ0EyNnJDYzdKdVVJT3lnaEN3Z011dUZoQ0Rzb0lRTkNnMEtJeU1qSU91bmlPcXdrTUszNnJpdzZyQ0VJT3Vuak91ampBMEtEUXBnUkMxT1lDaE83SjI4SU91Q3FPeWRqQ2tnTHlCZ1JDMHdZQ2pzbUtUcmlwZ2c2NmVJNnJDUUtTQXZJR0JFSzA1Z0tFN3NuYndnNnJLOTZyTzhLUTBLN0ppSUtTQkVMVGNzSUVRdE1Td2dSQzB3TENCRUt6RU5DZzBLSXlNaklPdXlpTzJZdUNEdGtaenF1TEFnS08yVm1PeWR0TzJVaU95Y3ZPdWhuQ0RxdGF6cnRvUXBEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzdLQ0U3Wm1VNjdLSTdaaTRJSHdnN1pXWTdKMjA3WlNJSU9xMXJPdTJoQ0I4SURBeUxURXlNelF0TlRZM09Dd2dNREV3TFRFeU16UXROVFkzT0NCOERRcDhJT3k1dE91VG5PdXlpTzJZdUNCOElEVHNucERycHF6c2xLa2c3WldZN0oyMDdaU0lJSHdnTVRJek5DMDFOamM0TFRrd01USXRNelExTmlCOERRcDhJT3F6aE95aWpPdXlpTzJZdUNCOElPMlZtT3lkdE8yVWlDRHF0YXpydG9RZ2ZDQXhNak10TkRVMkxUYzRPVEF4TWlCOERRcDhJT3lqdk91dnZPdVRzZXVobmV1eWlPMll1Q0I4SU95Vm5pQTI3SjZRNjZhc0xldVNwQ0EzN0o2UTY2YXNJSHdnTVRJek5EVTJMVEV5TXpRMU5qY2dmQTBLZkNEc2dxenNsNFhzbnBEcms3SHJvWjNyc29qdG1MZ2dmQ0F4TU95ZWtPdW1yQ0R0bFpqc25iVHRsSWdnZkNBd01TMHlNelF0TlRZM09Ea2dmQTBLRFFvakl5TWc3Sk93NjZtMElPeVZpQ0Rya0pqcmlwUWc3WkdjNnJpd0RRb05DaTBnNjRLZzdLZWM3SmVRSU8yVm1PeWR0TzJVaU1LMzY3bVg2cmlJT2lEaW5Zd2dNakF5TlMwd01TMHdNU3dnTURFdk1ERU5DaTBnN0l1YzZyQ0U3SmVRSU95WXBPeWdoQy9zbUtUdG00UTZJT0tkakNEc21LVHNvSVFnTWV5TG5DQXFLT3VMcUN3ZzdJS3M3SnFwN0o2UTZyQ0FJT3luZ2V5Z2tTRHFzNkRycGJUcmlwUWc2N0NwNjZ5NHdyZnNtSWpzbGIwZzdJdWM2ckNFN0oyQUlPeVlpT3ladUNrcURRb05DaW9xS2cwS0RRb2pJeUE0TGlEdGpKM3NsNFVvNjR1azdKMjA3SmE4NjZHYzZyZTRLUTBLRFFydGpKM3NsNFVnNjZ5NDZyV3M2NHFVSUNvcTdKZXQ3WldnS2lvbzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdkNucXM3d2dLaXJzbktEdG1KVXFLaWp0aHJYcnM3UXY3WXlRNjR1b0tleVhrQ0RybExEcm5id2c2Nnk0N0xLMDZyQ0FJT3VMck91ZHZPeWFsQzRnN1lPQTdKMjA3WXVBN0oyRUlPdUxwT3VUck95ZGhDRHJsWkFnNjdDWTY1T2M3SXVjSU95VmlPdUN0Q2pyczdqcnJMZ3A2cm1NN0tlQUlPcXdtZXlkdENEcnM3VHFzNkFzSU91enVPdXN1Q0RycDZYcm5iM3NuWVFnNjR1MDdKV0U3Slc4SU8yVnRPeWFsQzROQ2cwS0l5TWpJRERyaTZqcXM0UWc0b0NVSU8yS3VPdW1yT3F4c091MmdPMkVzQ0RydEpEc21wUU5DZzBLN1l5ZDdKZUY3SjIwSU95Q3JPeWFxZXlla095ZG1DRHNsclRybHFRZzdaYUo2NCtaSU91U3BPeVhrQ0RybktqcmlwVHNwNEFnNjZpODdLQ0FJTzJNak95VmhlMlZ0T3lhbEM0TkNnMEtMU0R0bG9ucmo1bnNuWVFnS2lycXNJRHJvWnpycDRucXNiRHJncGdnN1l5UTY0dW83SjJFSU95YWxPcTFyQ29xS095ZHRPMkRpTUszN0lLdDdLQ2N3cmZyb1p6cXQ3anNsWVRzbTRQQ3QreWloZXVqakNrZzRvYVNJQ29xN1l5UTY0dW83WmlWS2lvZ0tPdXN2T3lXdE91MGtPeWFsQ2tOQ2kwZzZyS3c2ck84d3Jmc2c0SHRnNXpycGJ3Z0tpcnRoclhyczdUcnA0d3FLaUFvN0ptRTY2T013cmZzaTZUdGpLZ3BJT0tHa2lBcUt1eVZpT3VDdE8yWWxTb3FJQ2pzbFl6cm9LVHNwSmpzbXBRcERRb05DaU1qSXlEdGc0RHNuYlR0aTRBZzRvQ1VJT3lucCt5ZGdDRHJxb1hzZ3F6cXRhd05DZzBLTFNEcnFvWHNncXp0bUpYc25MenJvWndnNjRHZDY0SzA3SnFVTGlEc29vWHFzckRzbHJUcnI3akN0K3VuaU95NXFPMlJuT3VsdkNEc2s3RHNwNEFnN0pXSzdKV0U3SnFVSUNoKzdKcVVJQzhnZnV1THBDQXZJSDdxdVl6c21wUS9JT0tkakNrdURRb3RJREorTk95V3RPeWdpT3VobkNEc3A2ZnFzNkFnN0ltOTZyS01MaUR0bFp6c25wRHNsclRDdCt5SW1PeUxuZXlkaENEcXVManFzb3dnN0l5VDdLZUFJT3lWaXV5VmhPeWFsQzROQ2kwZzdKV0k2NEswS091enVPdXN1Q2tnNjZlbDY1Mjk3SjJFSU95YWxPeVZ2ZTJWdEN3Z0tpcnRnNERzbmJUdGk0RHJwNHdnNjdTUTY0K0VJT3VzdE95S3FDRHRqSjNzbDRYc25ianNwNEFxS2lEc2xZenFzb3dnN1pXMDdKcVVMaURzbTVEcnM3anNuYlFnSit5VmpPdW12TUszN1ptVjdKMjRKK3l5bU91ZnZDRHJwNG5zbDdEdGxaanJxYlFnNjdPNDY2eTQ3SjJFSU9xM3ZPcXhzT3VobkNEcXRhenNzclR0bVpUdGxiVHNtcFF1RFFvTkNud2c3SjIwNjZDSDZyS01JT3Vua09xem9DQjhJT3lkdE91Z2grcXlqQ0I4RFFwOExTMHRmQzB0TFh3TkNud2c3S0NBN0o2bDdaV1k3S2VBSU95Vml1cXpvQ0RyZ3BqcXNJRHNpNXpxc3FEc2xyVHNtcFEvSUh3ZzdLQ0E3SjZsSU95VmlDRHRsWndnNjRLMDdKcXBJSHdOQ253ZzdKV002NmE4SUh3ZzZyS3c3S0NjSU95WmhPdWpqQ0I4RFFwOElPeWdsZXVua0NEc2dxM3NvSnp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSUh3ZzY0Mnc3SjIwN1lTd0lPeUNyZXlnbkNCOERRb05DaU1qSXlEc2xZanJnclFvNjdPNDY2eTRLU0RpZ0pRZzdaVzA3SnFVN0xLMERRb05DaTBnS2lydGpKRHJpNmp0bUpVcUt1eWRnQ0FuZnUyVm9PcTVqT3lhbEQ4bjY2R2NJT3Vzdk95V3RPeWFsQzRnNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzdKeUU3WmVZS095Q3JleWduTUszN1lPSTdZZTBJT3VUc1Nuc25ZQWc2ckt3NnJPODY2VzhJT3Vvdk95Z2dDRHFzcjNxczZEdGxiVHNtcFF1RFFvdElDb3E3SldJNjRLMDdaaVZLaXJzbllBZzdJS3M3SXVrN0oyRUlPeUVuT3lJb08yVnRPeWFsQzROQ2kwZzY2ZUk3TG1vN1pHYzY2VzhJT3lOcU95YWxDNGc3SWlyN0o2UXdyZnNvYkRxc2JRbzdKMjA3SU9Cd3Jmc25iVHRsWmpDdCt5ZHRPdUN0Q0RyazdFcDdKMkFJT3EzdU91TWdPdWhuQ0Rya1pEcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzdKV0s3SldFN0pxVUxnMEtEUW9qSXlNZzY3S0U3WXE4SU9LQWxDRHNsWWpyZ3JRZzY2eTQ2NmVsN0oyMElPeWdsZTJWdE95YWxBMEtEUXA4SU91enVPdXN1T3lkdENEc25iVHJvSWZyaTZRZ2ZDRHJzb1R0aXJ3Z2ZBMEtmQzB0TFh3dExTMThEUXA4SU9xeXNPcXp2TUszN0lPQjdZT2M2Nlc4SU8yR3RldXp0Q0I4SUZ2dG1aWHNuYmhkSUh3TkNud2dKMzd0bGFEcXVZenNtcFEvSit1aG5DRHJyTHpzbll3Z2ZDQmI3SldFNjR1STdKaWtYU0RDdHlCYjY0U2tYU0I4RFFwOElPeURnZTJacVNEc2hKenNpS0FnS3lEc21LVHJwYmpzcXIzc25iUWc3SXVrN0tDY0lPdVBtZXlla1NCOElGdnN0NmpzaG94ZElNSzNJRnQ3NjQrWjdKNlJmVjBnZkEwS0RRb3RJQ2ZzdDZqc2hvd242NHFVSUNvcTY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1LaW9nN0kybzdKcVVJQ2pzbUlnNklGdnN0NmpzaG94ZHdyZGI3SUt0N0tDY1hTa3VJQ2ZyaTZ2cXVMQWd3cmNnNjQrWjdKNlJKK3l5bU91ZnZDRHNwNTNzbmJRZzdKV0lJT3VubnV1S2xDRHNvYkR0bGFuc25iVHJncGdnNjR1bzY0K0ZJQ2ZzdDZqc2hvd242NHFVSU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFvdElPdXloTzJLdk95ZG1DRHJqNW5zbnBFZzdKMjA2NmFFN0oyQUlPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRoQ0RxdDdqcmpJRHJvWndnN0lLMDY2Q2s3SnFVTGcwS0RRb2pJeU1nN1lhMTdLZWNJT3lZaU95TG5BMEtEUW9xS3UyTWtPdUxxTzJZbFNEaWdKUWc3SjIwN1lPSUtpb05DaTBnN1lPQTdKMjA3WXVBT2lEc29JRHNucVVnN0pXSUlPMlZuQ0RyZ3JUc21xa05DaTBnN0pXSTY0SzBPaURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1ak95YWxEOGc3SjZGNjZDbDdaV2NJT3VDdE95YXFleWR0Q0RzZ3F6cm5ienNvTGpzbXBRdURRb3RJT3V5aE8yS3ZEb2c3SldFNjR1STdKaWtJTUszSU91RXBBMEtEUW9xS3UyTWtPdUxxTzJZbFNEaWdKUWc3SUt0N0tDY0lDanNuSVR0bDVncEtpb05DaTBnN1lPQTdKMjA3WXVBT2lEcmpiRHNuYlR0aExBZzdJS3Q3S0NjRFFvdElPeVZpT3VDdERvZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHNnclRycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lLdDdLQ2M3WldnNnJtTTdKcVVQdzBLTFNEcnNvVHRpcnc2SU95VmhPdUxpT3lZcENEQ3R5RHJoS1FOQ2cwS0tpcnJqNW5zbnBIdG1KVWc0b0NVSU95RW5PeUlvQ0FySU91UG1leWVrU0Ryc29UdGlyd3FLZzBLTFNEdGc0RHNuYlR0aTRBNklPcTRzT3E0c0NEc2w3RHFzckFnN1pXMDdLQ2NEUW90SU95VmlPdUN0RG9nN0lTZzdZT2Q3WldjSU9xNHNPcTRzT3lkbUNEc2w3RHFzckRzbllRZzY0R0s3SmEwN0pxVUxnMEtMU0Ryc29UdGlydzZJT3kzcU95R2pDREN0eURzbDdEcXNyQWc3WlcwN0tDY0RRb05DaW9xN0pXSTY0SzA3WmlWSU9LQWxDRHNtWVRybzR3ZzdZYTE2N08wS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURxc3JEc29Kd2c3Sm1FNjZPTURRb3RJT3lWaU91Q3REb2c2ckt3N0tDYzZyQ0FJT3lnbGV5RGdTRHNzcGpycHF6cmtKRHNsclRzbXBRdURRb3RJT3V5aE8yS3ZEb2c3Wm1WN0oyNERRb05DaW9xS2cwS0RRb2pJT3lZaU95WnVDRHF0NXpzdVprTkNnMEs3SnVRN0xtWktPdUtwZXVQbWNLMzZyaU43S0NWd3Jmc3VwRHNvN3pzbHJ3cDY3TzA2NHVrSU95WWlPeVp1T3F3Z0NEcmpaUWc2NnFGN1ptVjdaV2NJT3k3cE91dXBPdUxpT3k4Z095ZHRPeUZtT3lkaENEcnA0enJrNXpyaXBRZzZySzk3SnF3N0ppSTdKcVVMZzBLRFFvakl5RHNtSWpzbWJnZ01TNGc3SWlZNjQrWjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqcmo0UWc2NUNZNjRxVUlPcXl2ZXlhc0EwS0RRb2pJeU1nN0lTYzY3bUU3SXFrSU95aWhldWpqQ3dnNnJpdzZyQ0VJT3Vuak91ampBMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWp2T3lXdENqc29vWHJvNHdnN0lTYzY3bUU3SXFrTENEcXVMRHFzSVFnNjVPeEtldWx2Q0Rxc0pYc29iRHRsYUFnN0lpWUlPeWVpT3F6b0N3Z0oreWloZXVqakNmc21ZQWdKK3Vuak91ampDZnNuWmdnNjRtWTdKV1o3SXFrNjZXOElPeWdsZTJabGUyZWlDRHNvSVRyaTZ6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTQlBUMDhnN0lTYzY3bUU3SXFrSU95aWhldWpqQ0RzbFlqcmdyUWc0b0NVSURBdzdKdVVJREF3N0oyODY3YUE3WVN3SU95RW5PdTVoT3lLcE9xd2dDRHNvb1hybzR6cmo3enNtcFF1SU95ZWtPeUV1TzJWbkNEcmdyVHNtcW5zbllRZzdKV002NkNrNjVPYzY2Q2s3SnFVTGcwS0xTRHNucERzZ3JBZzdLR3c3WnFNSU9xNHNPcXdoT3lkdENEcXM2Y2c2NmVNNjZPTTY0Kzg3SnFVTGcwS0RRcnJpNmdzSUNvcTdLTzg2cml3N0tDQjdKeTg2NkdjSU95aWhldWpqT3F3Z0NEcnNKanJzN1hya0pqcmlwUWc3S0NjN1pLSUtpcnNsNURyaXBRZ0oreWloZXVqak91UHZPeWFsQ2ZycGJ3ZzdKT3c3S2VBSU95Vml1eVZoT3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNtS1RyaXBqc25aZ2c3WUMwN0thSTZyQ0FJT3F6cHlEc29vWHJvNHpyajd6c21wUWc0b2FTSU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQTBLRFFvakl5TWc3SUtzN0pxcDdKNlE3SmVRNnJLTUlPdXZ1T3k1bU91S2xDRHNtSUh0bHFYc25ZUWc3SldNNjZDazdLU0VJT3VWakEwS0RRb283S084N0pxVUlPdVBtZXlDckNBNklPeVhzT3l5dEN3ZzdaVzA3S2VBTENEc29JSHNtcWtnNjVPeEtRMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWR1T3F6dkNEcXRJRHFzNFRycGJ3ZzY2cUY3Wm1WN1pXWTZyS01JT3lFcE91cWhlMlZtT3F6b0N3Z0oreUNyT3lhcWV5ZWtPeWRtQ0R0bG9ucmo1bnNsNUFnNjVTdzY1Mjg3SmlrNjRxVUlPcXlzT3F6dkNmcm5ienJpcFFnN0tDUTdKMkVJT3lWak91Z3BPeWtoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lZcE91S21PcTVqT3luZ0NEcmdyVHNwNEFnN0pXSzdKeTg2Nm0wSU95WHNPeXl0T3VQdk95YWxDNGc3WnVFNjdhSTZyS3c3S0NjSU9xNGlPeVZvZXlkaENEcmdyVHNvN3pzaExqc21wUXVEUW90SU91TWdPeTJuT3lkaENEcXNJanNsWVR0ZzREcnFiUWc3SnVRNjU2WUlPdU1nT3kybk95ZHRDRHRsYlRzcDREcmo3enNtcFF1SU95WXBPdUttQ0RyZ3FEc3A1enF1WXpzcDREc25aZ2c3SjIwN0o2UTY2VzhJT3lkZ08yV2lleVhrQ0RyZ3JUc2xid2c3WlcwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UUlPeVZpT3lMckNBbzdJaVk2NCtaN1ppVktRMEtEUW9uN0tDVjY3TzBJT3lJbU95bmtTRHNsWWpyZ3JRbklPdVRzZXlkbUNEcnI3enFzSkR0bFp3ZzdJT0I3Wm1wN0plUTdJU2NJQ29xN0l1YzdJcWs3WVdjN0oyMElPeWVrT3VQbWV5Y3ZPdWhuQ0Rzc3BqcnBxenRsWnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc3SWlZNjQrWjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeWR0T3lnbk91MmdPMkVzQ0R0bVkzcXVManJqNW5yaTVqc25aZ2c2ckNjN0oyNDdLQ1Y2N08wSU95ZHRPeWFxU0RyZ3JUc2w2M3NuYlFnNnJpdzY2R2Q2NCs4N0pxVURRb3RJT3VObENEc29vdnNuWUFnN0lPQjY0dTA3SjJFSU95Y2hPMlZ0Q0R0aHJYdG1aUWc2NEswN0pxcDdKMkFJT3VGdWV5ZGpPdVB2T3lhbEEwS0RRb2pJeURzbUlqc21iZ2dNaTRnNnJLOTdKYTA2Nlc4SU95TnFPdVBoQ0Rya0pqcmlwUWc2cks5N0pxd0RRb05DdTJLdWV5Z2xTRHNnNEh0bWFuc2w1RHNoSndnN0tDYzdaV2M3S0NCN0p5ODY2R2NJQ2ZzaTV6cmdwanNtcFEvTENEc2hhanJncGpzbXBRL0p5RHNuWmpyckxqdG1KVWc3SmEwNjYrNDY2VzhJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlE3SjJZSU91bnBldWR2ZXlkaENEdG1aenNtcW50bGJUc2hKd2c3S2VJNjZ5NDdaV2dJT3VWakEwS0RRb243SXVjNjRLWTdKcVVQeWNzSUNmc2hhanJncGpzbXBRL0p5RHRtSlh0ZzV6c25aZ2c2cks5N0phMDY2VzhJTzJabk95YXFlMlZ0T3lFbkNEc2dxenNtcW5zbnBEc25aZ2c2NHU1N1ptcDdJcWs2NStzN0p1QTdKMkVJT3lraE95ZHZDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPMlpqZXE0dU91UG1ldUxtQ3dnVDA5UElPdUxwT3VGZ095WXBPeUZxT3VDbU95YWxEOE5DaTBnN0xhcDdLQ0U3WldZNjUrc0lPMk91T3lkbU95Z2tDRHFzSURzaTV6cmdwanNtcFEvRFFvTkNpTWpJeURzZ3F6c21xbnNucERzblpnZzdJT0I3Wm1wN0oyRUlPeTJsT3lnbGUyVm9DRHJsWXdOQ2cwSzY2cUY3Wm1WN1pXY0lPeWdsZXV6dE9xd2dDRHNsNGJzbHJUc2hKd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeW5nZXlna1NEdGpKRHJpNmp0bFpqcXNvd2c3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzdWJUcms1enJwYndnNjdDYjdKeTg3SVdvNjRLWTdKcVVQeURyazdIcm9aM3RsWmpycWJRZzdMcVE3SXVjNjdDeElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwS0l5TWpJT3lDck95YXFleWVrT3lkbUNEc2hLRHNuWmpxc0lBZzdaV0U3SnFVN1pXZ0lPdVZqQTBLRFFyc2hLVHJyTGpzb2JEc2dxenNzcGpybjd3ZzdJS3M3SnFwN0o2UTdKMllJT3lFb095ZG1PdWx2Q0RxdUxEcmpJRHRsYlRzbGJ3ZzdaV2dJT3VWakNEcXNyM3NsclRyb1p3ZzdLQ1Y3S1NSN1pXWTZyS01JT3luaU91c3VPMlZ0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNuYlRyc29nZzY0dXM3SmVRSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxaanJxYlRzaEp3ZzdKYTg2NmVJNjRLWUlPdW5qT3loc2UyVm1PeUZxT3VDbU95YWxEOE5DZzBLSXlNZzdKaUk3Sm00SURNdUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPdVFtT3VLbENEcXNyM3NtckFOQ2cwSzdJS3M3SnFwN0o2UTdKZVE2cktNSU91cWhlMlpsZTJWbU9xeWpDRHJ0b0Rzb0pYc29JSHNuYmdnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3lrbU95VnZDRHRsYUFnNjVXTTY0cVVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3lpaSt5VmhPeWFsQzROQ2cwS0l5TWpJT3lFbk91NWhPeUtwT3VsdkNEc29KWHNzWVhzZzRFZzdKTzRJT3lJbUNEc2w0YnNuWVFnNjVXTURRb05DdXUyZ095Z2xlMllsZXljdk91aG5DRHNqYWpzbGJ3ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU95RGdlMlpxZXlkaENEcnFvWHRtWlh0bFpqcXNvd2c3SjI0N0tlQTdJdWM3WUtzSU95SW1DRHNub2pzbHJUc21wUXVJQ29xN0pPNElPeUltQ0RzbDRicmlwUWc3SjIwN0p5ZzY2VzhJTzJWcU9xN21DRHNsWWpyZ3JUdGxiVHNvN3pzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEc3A0RHF1SWpzbllBZzZyQ0E3SjZGN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SU95eXJleUdqT3VGaE95ZGhDRHNuSVR0bFp3ZzdJU2M2N21FN0lxazY0cVVJT3lWaE95bmdTRHNwSURydVlRZzdLU1I3SjIwN0plUTdKcVVMZzBLTFNEcXM3WHJyTFRzbTVEc25ZQWc3WnVFN0p1UTZyaUk3SjJFSU91enRPdUN2Q0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtEUW9qSXlNZzdKMjg2N2FBSU9xNHNPdUtwZXVuakNEc2s3Z2c3SWlZSU95WGh1eWRoQ0RybFl3TkNnMEs2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeU5xT3lWdkNEc2dxenNtcW5zbnBEcXNJQWc3SmEwNjVha0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeVhodXVLbE95bmdDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3WldnSU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlFJT3lFb08yRG5leWRtQ0Rxc3JEcXM3enJwYndnN0pXSTY0SzA3WldnSU91VmpBMEtEUXJya0pqcmo0enJwclFnN0lpWUlPeVhodXVLbENEc2hLRHRnNTNzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJWbU9xeWpDRHNsWXpyb0tUc21wUXVEUW9OQ3V5WWlDa05DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPdTJnT3lnbGUyWWxTa05DZzBLSit5Z2xldXp0Q0RzaUpqc3A1RWc3SldJNjRLMEp5RHJrN0hzblpnZzY2Kzg2ckNRN1pXY0lPeURnZTJacWV5WGtPeUVuQ0FxS3V5Z2xldXp0T3F3Z0NEcnM3VHRtTGpya0p6cmk2VHJpcFFnN0tDUUtpcnNuWVFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lEZ2V1THRPeWR0Q0RyZ1ozcmdwanJxYlFnN0tDRTY2eTQ2ckNBNjQrRUlPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1RycGJ3ZzY3TzhJT3lJbUNEc2w0YnNsclRzbXBRdURRb3RJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHNvSlhyczdUcXNJQWc2cml3NjZHZDY1Q1k3S2VBSU95Vml1eVZoT3lhbEM0TkNnMEtJeU1nN0ppSTdKbTRJRFF1SU95Z25PMlNpQ0RzbXFuc2xyVHJpcFFnNjdDVTZyNjQ3S2VBSU95Vml1cTRzQTBLRFFvbjZyQ0U2ckt3N1pXWTZyT2dJT3lKck95YXRDRHJwNUFuSU95YmtPeTVtZXV6dE91THBDQXFLdTJabE91cHRPeWRtQ0RxdUxEcmlxWHJxb1hDdCt1eWhPMkt2T3VxaGVxenZPeWRtQ0RzbXFuc2xyUWc3SjI4N0xtWUtpcnFzSUFnN0pxdzdJU2c3SjIwN0plUTdKcVVMZzBLNnJpdzY0cWw2NnFGN0plUUlPeVRzT3lkdUNEcmk2anNsclFvNjdPQTZySzlMQ0RzcDREc29KVXNJT3VUc2V1aG5TRHJrN0VwNjZXOElPeVZpT3VDdENEcnJManF0YXpzbDVEc2hKd2c2NHVrNjZXNElPdW5rT3VobkNEcnNKVHF2cmpycWJRZzdJS3M3SnFwN0o2UTZyQ0FJT3VMcE91bHVDRHF1TERyaXFYc25MenJvWndnN0ppazdaVzA3WldnSU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa2dKK3Eyak8yVm5DRHJzNERxc3IwbklPcTRzT3VLcGV5ZG1DRHNsWWpyZ3JRZzY2eTQ2cldzRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3Q1U2citBSU95SW1DRHNub2pzbHJUc21wUWdLRmdwRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3T0E2cks5N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSU95WWlPeVp1Q0ExTGlEc2k1enNpcVR0aFp3ZzY0K1o3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXdnN0pPdzdLZUFJT3lWaXVxNHNBMEtEUXJyckxqcXRhenJwYndnN0pXRTY2eTA2NmFzSU91bnBPdUJoT3VmdmVxeWpDRHJpNlRyazZ6c2xyVHJqNFFnS2lyc2k2VHNvSndnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NLaXJycGJ3ZzdKT3c2Nm0wSU95ZW1PdXF1K3VRbkNEcnJManF0YXpzbUlqc21wUXVEUW9OQ3V5WWlDa2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VsdkNBbjdMYVU2ckNBSU95bmdPeWdsU2Z0bFpqcmlwUWc3SXVjN0lxazdZV2M3SmVRN0lTY0lDanNuYlRzb0lUQ3QreVdrZXVQaENEcXVMRHJpcVhzbmJRZzdKV0U2NHVZS1EwS0xTRHJpNlRycGJnZzdJS3M2NTZNN0plUTZyS01JT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERycGJ3ZzY0U1k2cktvN0tPODdJUzQ3SnFVSUNoWUlPS0FsQ0RzbDRicmlwUWdKK3VFbU9xNHNPcTRzQ2NnNnJpdzY0cWw3SjJFSU95VmxPeUxuQ2tOQ2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZ0Q0Rzbzd6c2hManNtcFFnS0U4cERRbz0nCkRJUj0iJEhPTUUvTGlicmFyeS9BcHBsaWNhdGlvbiBTdXBwb3J0L0NsYXVkZUJyaWRnZSIKcHV0KCkgeyBwcmludGYgJXMgIiQxIiB8IGJhc2U2NCAtRCA+ICIkMiI7IH0KIyDsnbQgLmNvbW1hbmTqsIAg64+E64qUIO2EsOuvuOuEkCDssL3rp4wg6rOo6528IOuLq+uKlOuLpCh0dHkg66ek7LmtKS4gYmFzaOqwgCDrgZ3rgpgg7YOt7J20IGlkbGXrkJwgMey0iCDrkqTsl5Ag64ur7JWECiMgIu2UhOuhnOyEuOyKpCDsi6Ttlokg7KSRIiDqsr3qs6Drpbwg7ZS87ZWc64ukIOKAlCBkaXNvd27snLzroZwg7Iqk7YGs66a97Yq46rCAIGV4aXTtlbTrj4Qg64ur6riwIOyekeyXheydgCDsgrTslYTrgqjripTri6QuICjrp6Ug7Iuk6riwIOqygOymnSDtlYTsmpQpCk1ZVFRZPSIkKHBzIC1vIHR0eT0gLXAgJCQgMj4vZGV2L251bGwgfCB0ciAtZCAiICIpIgpjbG9zZV90ZXJtaW5hbCgpIHsKICBbIC16ICIkTVlUVFkiIF0gJiYgcmV0dXJuCiAgKCBzbGVlcCAxCiAgICAvdXNyL2Jpbi9vc2FzY3JpcHQgPi9kZXYvbnVsbCAyPiYxIDw8T1NBCnRlbGwgYXBwbGljYXRpb24gIlRlcm1pbmFsIgogIHJlcGVhdCB3aXRoIHcgaW4gd2luZG93cwogICAgdHJ5CiAgICAgIHJlcGVhdCB3aXRoIHQgaW4gdGFicyBvZiB3CiAgICAgICAgaWYgdHR5IG9mIHQgaXMgIi9kZXYvJE1ZVFRZIiB0aGVuIGNsb3NlIHcgc2F2aW5nIG5vCiAgICAgIGVuZCByZXBlYXQKICAgIGVuZCB0cnkKICBlbmQgcmVwZWF0CmVuZCB0ZWxsCk9TQQogICkgJiBkaXNvd24gMj4vZGV2L251bGwgfHwgdHJ1ZQp9CiMg7JWI64K064qUIO2UjOufrOq3uOyduOydtCDrs7Tsl6zspIDri6Qg4oCUIO2EsOuvuOuEkOydgCDshKTsuZjCt+ygkOqygOunjCDtlZjqs6Ag7Iqk7Iqk66GcIOuLq+2ejOuLpC4KZmluaXNoKCkgeyBjbG9zZV90ZXJtaW5hbDsgZXhpdCAiJDEiOyB9CmVjaG8gIu2BtOuhnOuTnCDsu6TrhKXthLDrpbwg7ISk7LmY7ZWY6rOgIOyeiOyWtOyalOKApiDsnqDsi5wg7ZuEIOydtCDssL3snYAg7J6Q64+Z7Jy866GcIOuLq+2YgOyalC4iCm1rZGlyIC1wICIkRElSL3NjcmlwdHMiIHx8IHsgZWNobyAi7Y+0642UIOyDneyEsSDsi6TtjKg6ICRESVIiOyBmaW5pc2ggMTsgfQpwdXQgIiRCNjRfQlJJREdFIiAgICIkRElSL3NjcmlwdHMvY2xhdWRlLWJyaWRnZS5qcyIKcHV0ICIkQjY0X1dBVENIRVIiICAiJERJUi9zY3JpcHRzL2JyaWRnZS13YXRjaGVyLmpzIgpwdXQgIiRCNjRfRVhBTVBMRVMiICIkRElSL3JlY29tbWVuZC1leGFtcGxlcy5tZCIKcHV0ICIkQjY0X0dVSURFIiAgICAiJERJUi91eC13cml0aW5nLm1kIgplY2hvICLinIUg7YyM7J28IOyEpOy5mDogJERJUiIKIyBHVUnsl5DshJwg7JewIFRlcm1pbmFs7J2AIFBBVEjqsIAg7KKB7J2EIOyImCDsnojslrQg7Z2U7ZWcIOyEpOy5mCDqsr3roZzrpbwg67O07YOg64ukCmV4cG9ydCBQQVRIPSIkSE9NRS8ubG9jYWwvYmluOi9vcHQvaG9tZWJyZXcvYmluOi91c3IvbG9jYWwvYmluOiRQQVRIIgojIG5vZGXqsIAg7JeG7Jy866m0IOqwkOyLnOyekCg9bm9kZSkg7J6Q7LK06rCAIOuquyDrj4zslYQg7ZSM65+s6re47J247JeQIOyVjOumtCDrsKnrspXsnbQg7JeG64ukIOKGkiDsnbQg6rK97Jqw66eMIOuEpOydtO2LsOu4jCDtjJ3sl4XsnLzroZwg7JWI64K07ZWc64ukCmlmICEgY29tbWFuZCAtdiBub2RlID4vZGV2L251bGwgMj4mMTsgdGhlbgogIG9zYXNjcmlwdCAtZSAnZGlzcGxheSBkaWFsb2cgIuydtCBNYWPsl5AgTm9kZS5qc+qwgCDsl4bslrTsmpQuIFvtmZXsnbhd7J2EIOuIhOultOuptCDri6TsmrTroZzrk5wg7Y6Y7J207KeA6rCAIOyXtOugpOyalC4gTm9kZS5qcyhMVFMp66W8IOyEpOy5mO2VnCDrkqQg7J20IOyEpOy5mCDtjIzsnbzsnYQg64uk7IucIOyLpO2Wie2VtCDso7zshLjsmpQuIiB3aXRoIHRpdGxlICLtgbTroZzrk5wg7Luk64Sl7YSwIOKAlCBOb2RlLmpzIO2VhOyalCIgYnV0dG9ucyB7Iu2ZleyduCJ9IGRlZmF1bHQgYnV0dG9uIDEgd2l0aCBpY29uIGNhdXRpb24gZ2l2aW5nIHVwIGFmdGVyIDE4MCcgPi9kZXYvbnVsbCAyPiYxCiAgb3BlbiAiaHR0cHM6Ly9ub2RlanMub3JnL2tvL2Rvd25sb2FkIiAyPi9kZXYvbnVsbAogIGZpbmlzaCAwCmZpCk5PREVfQklOPSIkKGNvbW1hbmQgLXYgbm9kZSkiCmVjaG8gIuKchSBOb2RlLmpzOiAkKG5vZGUgLS12ZXJzaW9uKSIKIyDqsJDsi5zsnpAgbGF1bmNoZCDrk7HroZ0gKOuhnOq3uOyduCDsnpDrj5nsi5zsnpEgKyDsp4DquIgg6riw64+ZKS4gUEFUSOulvCBwbGlzdOyXkCDqtbPtmIAg64Sj64qU64ukIOKAlCBsYXVuY2hkIOq4sOuzuCBQQVRI7JeUIGNsYXVkZeqwgCDsl4bri6QuClBMSVNUPSIkSE9NRS9MaWJyYXJ5L0xhdW5jaEFnZW50cy9jb20uY2xhdWRlYnJpZGdlLndhdGNoZXIucGxpc3QiCm1rZGlyIC1wICIkSE9NRS9MaWJyYXJ5L0xhdW5jaEFnZW50cyIKU0FGRV9QQVRIPSIke1BBVEgvLyYvJmFtcDt9IgpjYXQgPiAiJFBMSVNUIiA8PFBMSVNURU9GCjw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjwhRE9DVFlQRSBwbGlzdCBQVUJMSUMgIi0vL0FwcGxlLy9EVEQgUExJU1QgMS4wLy9FTiIgImh0dHA6Ly93d3cuYXBwbGUuY29tL0RURHMvUHJvcGVydHlMaXN0LTEuMC5kdGQiPgo8cGxpc3QgdmVyc2lvbj0iMS4wIj4KPGRpY3Q+CiAgPGtleT5MYWJlbDwva2V5PjxzdHJpbmc+Y29tLmNsYXVkZWJyaWRnZS53YXRjaGVyPC9zdHJpbmc+CiAgPGtleT5Qcm9ncmFtQXJndW1lbnRzPC9rZXk+CiAgPGFycmF5PgogICAgPHN0cmluZz4kTk9ERV9CSU48L3N0cmluZz4KICAgIDxzdHJpbmc+JERJUi9zY3JpcHRzL2JyaWRnZS13YXRjaGVyLmpzPC9zdHJpbmc+CiAgPC9hcnJheT4KICA8a2V5PkVudmlyb25tZW50VmFyaWFibGVzPC9rZXk+CiAgPGRpY3Q+PGtleT5QQVRIPC9rZXk+PHN0cmluZz4kU0FGRV9QQVRIPC9zdHJpbmc+PC9kaWN0PgogIDxrZXk+UnVuQXRMb2FkPC9rZXk+PHRydWUvPgogIDxrZXk+S2VlcEFsaXZlPC9rZXk+PGRpY3Q+PGtleT5TdWNjZXNzZnVsRXhpdDwva2V5PjxmYWxzZS8+PC9kaWN0Pgo8L2RpY3Q+CjwvcGxpc3Q+ClBMSVNURU9GCmxhdW5jaGN0bCBib290b3V0ICJndWkvJChpZCAtdSkvY29tLmNsYXVkZWJyaWRnZS53YXRjaGVyIiAyPi9kZXYvbnVsbApsYXVuY2hjdGwgYm9vdHN0cmFwICJndWkvJChpZCAtdSkiICIkUExJU1QiIDI+L2Rldi9udWxsIHx8IGxhdW5jaGN0bCBsb2FkIC13ICIkUExJU1QiIDI+L2Rldi9udWxsCiMgY2xhdWRlIOycoOustMK366Gc6re47J24IOyXrOu2gOuKlCDsl6zquLDshJwg7JWM66as7KeAIOyViuuKlOuLpCDigJQg6rCQ7Iuc7J6Q6rCAIOq3uCDsg4Htg5zrpbwg7ZSM65+s6re47J247JeQIOyghOuLrO2VtAojIOqzhOyglSDtmZTrqbTsnbQgIuyEpOy5mCDtlYTsmpQgLyDroZzqt7jsnbgg7ZWE7JqUIC8g7KSA67mEIOyZhOujjCLroZwg64W47Lac7ZWc64ukKO2EsOuvuOuEkOydtCDssYTrhJDsnbQg7JWE64uYKS4KIyDshKTsuZjCt+ygkOqygCDrgZ0g4oaSIOywveydhCDsiqTsiqTroZwg64ur64qU64ukLgpmaW5pc2ggMApQSwECHgMUAAAIAAAAAAAAdfWNiBtLAgAbSwIAGwAAAAAAAAAAAAAA7YEAAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kUEsFBgAAAAABAAEASQAAAFRLAgAAAA==";
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
