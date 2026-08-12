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
const BRIDGE_MIN_V = 27;
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
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21saw0KWjJVcENpOHZJT3k4bk91UmtPdXB0Q0R0bEl6cm42enF0N2pzbmJqc25aZ2dXK3kybE95eW5PdXdtK3E0c0YzcXNJQWdSMlZ0YVc1cElPMkNwQ0RzbDRic25iVHJqNFFnN1lHMDY2R2M2NU9jNjZHY0lFRkpJT3kybE95eW5PeWRoQ0Ryc0p2cmlwVHJpNlF1Q2k4dkNpOHZJT3lHamV1UGhDRHNoS1RxczRRNklPMkJ0T3Vobk91VG5PdWx2Q0RzbXBUc3NxM3JwNGpyaTZRZzdJT0k2NkdjSU95TG5PdVBtZTJWbU91cHRDQXpNSDQwTU95MGlPcXdnQ0RxdDdqcmc2VWc2NEtnN0pXRTZyQ0U2NHVrTGdvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0NpOHZJQ0FnNnJDQTdKMjA2NU9jSyt5WWlPeUxuQ2d4TVRIcXNiUXA2NHFVSU95eXF5RHJxWlRzaTV6c3A0RHJvWndnN1pXY0lPdXlpT3VuakNEc25iM3QNCm5venJpNlF1SU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjZ5NDZyV3M2NmVNSU91enRPdUN0T3V2Z091aG5DRHJ1YURycGJUcmk2UXVDaTh2SU95RXVPeUZtT3lkZ0NBek1PdXlpQ0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3WlcwSU91TWdPMlpsT3F3Z0NEcnJMVHRsWnp0bm9nZzZyaTQ3SmEwN0tlQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaTh2Q2k4dklPeWdoT3lnbkRvZzdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0NjQrOElPeWVpT3lkaENEcXNvTWdLR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3Snk4NjZHY0lPMlpsZXlkdUNrS0x5OGc3S084N0oyWU9pRHNncXpzbXFucm40bnNuWUFnNnJDQjdKNlFJTzJCdE91aG5PdVRuQ0RxdGF6cmo0VWc3WldjNjQrRTdKZVE3SVNjSU95d3FPcXdrT3VRbk91THBDNEtDbU52Ym5OMElHaDBkSEFnUFNCeVpYRjFhWEpsS0Nkb2RIUndKeWs3Q21OdmJuTjBJR1p6SUQwZ2NtVnhkV2x5WlNnblpuTW5LVHNLDQpZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdA0KWTNka0p5azdDblJ5ZVNCN0lHWnpMbTFyWkdseVUzbHVZeWhGVFZCVVdWOURWMFFzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsSUgwcE95QjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUXBqYjI1emRDQkRURUZWUkVWZlJVNVdJRDBnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnY0hKdlkyVnpjeTVsYm5Zc0lIc0tJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcENpQWdRMHhCVlVSRlgwTlBSRVZmUkVsVFFVSk1SVjlPVDA1RlUxTkZUbFJKUVV4ZlZGSkJSa1pKUXpvZ0p6RW5MQ0F2THlEdGhMUWc3SnFVN0pXOUlPdVRzU0RydG9EcXNJQWc3Wmk0N0xhY0lPdUJsQW9nSUVSSlUwRkNURVZmVkVWTVJVMUZWRkpaT2lBbk1TY3NDbjBwT3dvS0x5OGc3SWlvNnJtQUlPeUxwTzJXaVNqcXNKRHNpNXpzbnBBZzdJcWsNCjdZK3c3SjJBSUhOMFpHbHZJR2xuYm05eVpTbnNsNURzaEp6cmo0UWc2Nnk0N0tDYzY2VzhJT3kybE95Z2dlMlZvQ0RzaUpnZzdKNkk2cktNSU95OW1PeUdsQ0Ryb1p6cXQ3anJwYndnN1l5TTdKMjg3SmVRNjQrRUlPdUNxT3E0dE91THBDNEtMeThnN0p5RTdMbVlPaURzbm9Uc2k1d2c3WSswNjQyVTdKMllJR05zWVhWa1pTMWljbWxrWjJVdWJHOW5JQ2pzbklqcmo0VHNtckFnSlZSRlRWQWxMQ0RycDZVZ0pGUk5VRVJKVWlrdUlESk5RaURyaEpqc25MenJxYlFnTG05c1pPdWhuQ0R0bFp3ZzdJUzQ2NHlBNjZlTUlPdXp0T3EwZ0M0S1kyOXVjM1FnVEU5SFgwWkpURVVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExteHZaeWNwT3dwamIyNXpkQ0JmYjNKcFoweHZaeUE5SUdOdmJuTnZiR1V1Ykc5bkxtSnBibVFvWTI5dWMyOXNaU2s3Q21OdmJuTnZiR1V1Ykc5bklEMGdablZ1WTNScGIyNGdLQ2tnZXdvZ0lHTnZibk4wSUdGeVozTWdQU0JCY25KaGVTNXdjbTkwDQpiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bg0KYVdaNUtHRXBLU2t1YW05cGJpZ25JQ2NwSUNzZ0oxeHVKenNLSUNBZ0lHWnpMbUZ3Y0dWdVpFWnBiR1ZUZVc1aktFeFBSMTlHU1V4RkxDQnNhVzVsS1RzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHRqSXpzbmJ3ZzY2R2M2cmU0SU95THBPMk1xTzJWdE91UGhDRHJpNlRycHF6cmlwUWc2ck9FN0lhTklDb3ZJSDBLZlRzS0NtTnZibk4wSUZCUFVsUWdQU0JPZFcxaVpYSW9jSEp2WTJWemN5NWxibll1UWxKSlJFZEZYMUJQVWxRcElIeDhJREV4T0RnNE95QXZMeUJDVWtsRVIwVmZVRTlTVk91S2xDRHRoWXpzaXFUdGlyanNtcWtnS08yUGlleUdqT3lYbENBeE1UZzRPQ0RxczZEc29KVXBDaTh2SU91THBPdW1yQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0F2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDNGc3TDJVNjVPYzY2VzhJSEIxYkd6Q3QrdXp0ZXlDck8yVnRPdVBoQ0FxS3V5ZHRPdXZ1Q0RybHFBZzdKNkk2NHFVSU91THBPdW1yT3VLbENEc21Kc2c3TDJVNjVPY0lPcTN1T3VNZ091aG5Db3ENCjY1MjhDaTh2SU9xN2tPdUxwQ0Rzdkp6cXVMQWc3S0NFN0plVUlPeURpQ0RyajVuc25wSHNuYlFnN0pXSUlPdUNtT3lZcU91THBDanRoTERycjdqcmhKRHNuYlFnNjV5bzY0cVVJT3VUc1NrdUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEc25iUWc2ckNTN0p5ODY2R2NJT3Exck91eWhPeWdoT3lkaENEcXNKRHNwNER0bGJRZzdKNnM3SXVjN0o2UjdJdWM3WUtvNjR1a0xnb3ZMeURyajVuc25wSHNuYlFnNjdDVTY0Q002NHFVSU95SW1PeWdsZXlkaENEdGxaanJxYlFnN0oyMElPeUlxK3lla091bHZDRHNtS3pycHF6cXM2QWdZMjlrWlM1MGMreWRtQ0JDVWtsRVIwVmZUVWxPWDFicmo0UWc2ckNaN0oyMElPeVlyT3Vtc091THBDNEtZMjl1YzNRZ1FsSkpSRWRGWDFZZ1BTQXlOenNLTHk4ZzZyaXc2N080SU91cXFPdU51QzRnN0pxVTdMS3RLTzJVak91ZnJPcTN1T3lkdUNuc25iUWdiVzlrWld6c25ZUWc3S2VBN0tDVjdaV1k2Nm0wSU9xM3VDRHNtcFRzc3EzcnA0d2c2cmU0SU91cXFPdU51T3VobkNEc3NwanJwcXp0DQpsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPYw0KSUNoeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUWc0b0NVSUdKMWFXeGtMV2RzYjNOellYSjVMbXB6N0ptQUlPcXdtZXlkZ0NEdGpJenNoSndwSU9LVWdPS1VnQXBtZFc1amRHbHZiaUJzYjJGa1JYaGhiWEJzWlhNb0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzFrSUQwZ1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNzSUNkeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUW5LU3dnSjNWMFpqZ25LVHNLSUNBZ0lHTnZibk4wSUhObFkwbGtlQ0E5SUcxa0xuTmxZWEpqYUNndlhpTWpJT3kybE95eW5DRHNtSWpzaTV4Y2N5b2tMMjBwT3dvZ0lDQWdhV1lnS0hObFkwbGtlQ0E5UFQwZ0xURXBJSEpsZEhWeWJpQmJYVHNLSUNBZ0lHTnZibk4wSUdWNFlXMXdiR1Z6SUQwZ1cxMDdDaUFnSUNCc1pYUWdZM1Z5SUQwZ2JuVnNiRHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjbUYzSUc5bUlHMWtMbk5zYVdObEtITmxZMGxrZUNrdWMzQnNhWFFvSjF4dUp5a3ANCklIc0tJQ0FnSUNBZ1kyOXVjM1FnYkdsdVpTQTlJSEpoZHk1eVpYQnNZV05sS0M5Y2N5c2tMeXdnSnljcE93b2dJQ0FnSUNCamIyNXpkQ0JvSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYaU1qSTF4ekt5Z3VLejhwWEhNcUpDOHBPd29nSUNBZ0lDQnBaaUFvYUNrZ2V5QmpkWElnUFNCN0lHbHVjSFYwT2lCb1d6RmRMQ0J6ZFdkblpYTjBhVzl1Y3pvZ1cxMGdmVHNnWlhoaGJYQnNaWE11Y0hWemFDaGpkWElwT3lCamIyNTBhVzUxWlRzZ2ZRb2dJQ0FnSUNCamIyNXpkQ0JpSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYbHh6S2kxY2N5c29MaXMvS1Z4ektpUXZLVHNLSUNBZ0lDQWdhV1lnS0dJZ0ppWWdZM1Z5S1NCamRYSXVjM1ZuWjJWemRHbHZibk11Y0hWemFDaGlXekZkTG5Od2JHbDBLQ2NnTHlBbktTNXFiMmx1S0NjZ0p5a3BPd29nSUNBZ2ZRb2dJQ0FnY21WMGRYSnVJR1Y0WVcxd2JHVnpMbVpwYkhSbGNpZ29aU2tnUFQ0Z1pTNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dQaUF3S1RzS0lDQjlJR05oZEdOb0lDaGxLU0I3DQpDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpdw0KSU9xem9PeTVxQ0FySU95V3RPeUluQ0RyczREcXNyMGk3SjIwSU91UW5PdUxwQzRnN0pldDdaV2dJT3UyaE91bXJDRGlnSlFLTHk4ZzdZRzA2NkdjNjVPY0lEMGc2Nnk0N0o2bElPdUxwT3VUck9xNHNDanNzTDNzblpncExDRHNtcW5zbHJRZzdZYTE3SjI4d3JmcnA1N3N0cVRyc3BVZ1BTQmpiMlJsTG5SeklISmxabWx1WlVGcFUzVm5aMlZ6ZEdsdmJuTWc3WnVFN0xLWTY2YXNLT3E0c09xemhPeWdnU2t1Q21OdmJuTjBJRk5VV1V4RlgxSlZURVZUSUQwZ1d3b2dJQ2N4TGlEdGxiVHNtcFRzc3JRNklPdXFxT3VUb0NEcnJManF0YXpyaXBRZzdaVzA3SnFVN0xLMDY2R2NMaUFvNjdPMDY0T0Y2NHVJNjR1azRvYVM2N08wNjRLMDdKcVVLU2NzQ2lBZ0p6SXVJT3VLcGV1UG1leWdnU0RycDVEdGxaanF1TEE2SU91UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDd2dmdXlYaUNEcnVienF1TEFvNjdDVTY0Q003SmVJN0phMDdKcVU0b2FTNjdDVTZyK283SmEwN0pxVUtTNGc2NHVvTENEc29vWHJvNHpDdCt1bmpPdWoNCmpNSzM3SmV3N0xLMHdyZnRsYlRzcDREQ3QrcTRzT3VobmNLMzY0VzU3SjJNSU91VHNTRHNpNXpzaXFUdGhaenNuYlFnN0tPODdMSzA3SjI0SU9xeXNPcXp2T3VLbENEc2lKanJqNW50bUpVZzdKeWc3S2VBS095WHNPeXl0T3VQdk95YWxDd2c2NFc1N0oyTTY0Kzg3SnFVS1M0bkxBb2dJQ2N6TGlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd09pQWlmdTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVJaURyaklEc2k2QWdJbjd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWlJT3Exck95aHNDRHNtckRzaEtBdUlPdUxxQ3dnN0tDVjdMR0Y3SU9CSU91MmlPcXdnTUszN0oyODY3YUFJT3E0c091S3BTRHNvSnp0bFp6Q3QrdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3F5c09xenZNSzM3S0NWNjdPMElPdXp0TzJZdUNEc2xZanNpNnpzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJlaUM0bkxBb2dJQ2MwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phME9pQis3WldZN0l1YzZyS2c3SmEwDQo3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cA0KTGljc0NpQWdKell1SU8yUm5PcTRzRG9nNjVDWTdKYTA3SnFVNG9hUzY0Kzg3SnFVTGljc0NpQWdKemN1SU95a2hDRHF0YXpzb2JBNklPeWJrT3V6dU95ZHRDRHRsWndnN0tTRTdKMjA2Nm0wSU95MmxPeXluT3VQaENEcnNKanJrNXpzaTV3ZzdaV2NJT3lraE91aG5DNGc3SjZFN0oyWTY2R2NJT3lraE95ZGhDRHJpcGpycHF6c3A0QWc3SldLNjRxVTY0dWtMaURyaTZnc0lPeVhyT3VmckNEcnJManNucVhzbllRZzdaV1k2NEtZN0oyWUlPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25MenJvWndnN1pXcDdMT1FJT3VObENEcXNJVHFzckR0bGJUc3A0VHJpNlRycWJRZzdLU0VJT3lJbU91bHZDRHNwSVRzbmJUcmlwUWc2cktEN0oyQUlPMlptT3lZZ1M0bkxBb2dJQ2M0TGlEdGpKM3NsNFVvNjR1azdKMjA3SmE4NjZHYzZyZTRLU0Ryc29UdGlydzZJT3F5c09xenZDRHRoclhyczdUcmlwUWdXKzJabGV5ZHVGMHNJT3lZaUMvc2xZVHJpNGpzbUtRZzdZeVE2NHVvN0oyQUlGdnNsWVRyaTRqc21LUmRMMXZyaEtSZExDRHINCmo1bnNucEVnN0p5ZzY0K0U2NHFVSUZ2c3Q2anNob3hkTDF0NzY0K1o3SjZSZlYwdUlDTHN0NmpzaG93aTY0cVVJT3VQbWV5ZWtTRHJzb1R0aXJ6cXM3d2c3S2VkN0oyOElPdVZqT3VuakNEc2s3RHFzNkFnSXV1THErcTRzTUszNjQrWjdKNlJJdXl5bU91ZnZDRHNwNTBnN0pXSUlPdW5udXVLbENEc29iRHRsYW5DdCt1THFPdVBoU0FpN0xlbzdJYU1JdXVLbENEcXVJanNwNEF1Snl3S0lDQW5PUzRnN0oyMDY2YUV3cmZzb0lUdG1aVHJzb2p0bUxqQ3QrdW5pT3lLcE8yQ3VleWRnQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzBMaURzZ3F6cm5venNuWVFnNjdhQTY2VzhJT3VWa0NEcmk1anNuWVFnNjdhWjdKZXM2NCtFSU95aWkrdUxwQzRuTEFvZ0lDY3hNQzRnN0tDYzdaS0lJT3lhcWV5V3RDRHNuS0RzcDRBNklPeWVoZXVncGV5WGtDRHNrN0RzbmJnZzZyaXc2NHFsN0lTeElPdXFoZXlDckNqcnM0RHFzcjBzSU95bmdPeWdsU3dnNjVPeDY2R2RMQ0R0bGJUc29Kd2c2NU94S2V1S2xDRHRtWlRycWJUc25aZ2c2cml3DQo2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqcw0KaUpqcmo1bnRtSlhDdCtxeXZleVd0TUszNjdhQTdLQ1Y3WmlWSU8yWGlPeWFxU0RzdklEc25iVHNpcVFwN0oyWUlPdUptT3lWbWV5S3BPcXdnQ0RzbktEc2k2VHJrSnpyaTZRdUNpOHZJTzJNak95ZHZPeWR0Q0RzbDRic25MenJxYlFvN0lTazdMbVk2N080SU9xMXJPdXloT3lnaENEcms3RXBJT3U1aUNEcnJManNucERzbDdRZzRvQ1VJT3lhbE95VnZldW5qT3ljdk91aG5DRHJqNW5zbnBFb1ptRnBiQzF6YjJaMEtTNEtablZ1WTNScGIyNGdiRzloWkVkMWFXUmxLQ2tnZXdvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdFpDQTlJR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bkxDQW5kWGd0ZDNKcGRHbHVaeTV0WkNjcExDQW5kWFJtT0NjcExuUnlhVzBvS1RzS0lDQWdJSEpsZEhWeWJpQnRaQzVzWlc1bmRHZ2dQaUF4TURBZ1B5QnRaQ0E2SUNjbk93b2dJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2lxVHQNCmc0RHNuYndnNnJDQTdKMjA2NU9jSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lhbE95VnZldW5qT3ljdk91aG5DRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z0p5YzdDaUFnZlFwOUNtTnZibk4wSUVkVlNVUkZJRDBnYkc5aFpFZDFhV1JsS0NrN0NncG1kVzVqZEdsdmJpQnBibk4wY25WamRHbHZiazFsYzNOaFoyVW9LU0I3Q2lBZ1kyOXVjM1FnWm1WM1UyaHZkQ0E5SUVWWVFVMVFURVZUTG0xaGNDZ29aWGdwSUQwK0lDZEpibkIxZERvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtHVjRMbWx1Y0hWMEtTQXJJQ2RjYms5MWRIQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExuTjFaMmRsYzNScGIyNXpLU2t1YW05cGJpZ25YRzRuS1RzS0lDQnlaWFIxY200Z0tBb2dJQ0FnSit5bmdPcTRpT3UyZ08yRXNDRHJoSWpyaXBRZzdKZVE3SXFrN0p1UUtGTXRNU3dnNjdPMDdKV0k3WnFNN0lLc0tleWRtQ0R0bFp6cXRhM3NsclFnVlZnZ1YzSnBkR2x1WnlEc29JVHJyTGpxDQpzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91TA0KcEM0Z0p5QXJDaUFnSUNBbjdLR3c2ckcwSU8yUm5PMlloQ2pzbmJUc2c0SEN0K3lkdE8yVm1NSzM3SjIwNjRLMHdyZnN0SWpxczd6Q3QrdXZ1T3Vuak1LMzY3YUE3WVN3d3JmcXVZenNwNEFnNjVPeEtleWRnQ0Rzb0pYc3NZVWc3S0NWNjdPMDY0dWtJT0tBbENEcnVienFzYkRyZ3BnZzY0dWs2Nlc0SU95aHNPcXh0T3ljdk91aG5DRHJzSlRxdnJqc3A0QWc2NmVJNjUyOEtDSTE3WnFNSU95ZHRPeURnU0xzbllRZ0lqWHRtb3dpNjZHY0lPeWtoT3lkdE91cHRDRHNtS1RyaTdVcExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc2w1QWc3SmVHNjRxVUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN0l1YzZyQ0VJT3VUc1Nuc21ZQWc3WlcwNnJLd0lPdXdxZXV5bGNLMzdLQ0k3TENvS095ZXJPeUVwT3lnbGNLMzY2eTQ3SjJZN0xLWXdyZnNucXpzaTV6cmo0UWc2NU94S2V1bHZDRHNwNERzbHJUcmdyUWc2N2FaN0oyMDY0cVVJT3F5Zyt5ZGdDRHNvSWpyaklBZzZyaUkNCjdLZUFJT0tBbENEc2xZVHJpcFFnNnJDUzdKMjA2NTI4NjQrRUxDRHF0N2pybjdUcms2L3RsYlRyajRRZzdKT3c3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSnpQcXNKd2c3S0NjN0pXSTdKMkFJT3lFbk91aG5DRHNvSkhxdDd6c25iUWc2NHVzNjUyODdKVzhJTzJWbk91THBDRGlnSlFnN1pXWTY0S1k2NHFVSU95YmtPdXN1Q0RxdGF6c29iRHJwYndnN0p5ZzdLZUE3WldjSU95MW5PeUdqQ0RyaTZUcms2enF1TEFzSU8yVm1PdUNtT3VLbENEcnJManNucVVnNnJXczdLR3c2Nlc4SU95ZXJPcTFyT3lFc2UyVm5DRHJqSURzbFlnc0lDY2dLd29nSUNBZ0orcTN1T3Vtck9xem9DRHNvSUhzbHJUcmo0UWc3WldZNjRLWTY0cVVJT3F6dk9xd2tPMlZuQ0RzbnF6cXRhenNoTEU2SU95a2tldXp0U0R0a1p6dG1JVHNuWVFnNjQyYzdKYTA2NEswNnJPZ0xDRHNvSlhyczdRZzdJaWM3SVNjNjZXOElPeUNyT3lhcWV5ZWtPcXdnQ0RzbFl6c2xZVHNsYndnN1pXZ0lPcXlnK3UyZ08yRXNPdWhuQ0RzbnF6c29iRHNwNEh0DQpsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZw0KSUNBZ0oreVZoT3VlbUNEc21JanNpNXpyazZUc25ZQWc3WldjSU95a2hPeW5uT3VtckNEc3RaenNob3dnNnJXUTdLQ1Y3SjIwSU91bmp1eW5nT3VuakNEcXQ3anFzYlFnN1lha0tPMlZ0T3lhbE95eXRNSzM2cks5N0phMEtleWRtQ0RxdFpEcnM3anNuYlRzcDRBZzdJYU02cmU1N0lTeDdKMllJT3Exa091enVPeWR0Q0RzbFlUcmk0anJpNlFnNG9DVUlPeVhyT3VmckNEcnJManNucVhzcDV6cnBxd2c3SjZGNjZDbDdKMkFJT3VwbE95TG5PeW5nQ0RyaTZqc25JVHJvWndnNjR1azdJdWNJT3lFcE9xemhPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURyc0xEc2w3VHJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoY0szN0wyVTY1T2M3WTZjN0lxa0lPcTRpT3luZ0RwY2JpY2dLd29nSUNBZ0oxdDdJblJsZUhRaU9pQWk3S0NjN0pXSUlPdXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2cNCkl1dXN0T3lYaCt5ZGhDRHNtWndnNjdDVTZyK282NHFVN0tlQUlPMlZuT3ExcmV5V3RDRHRsWndnNjZ5NDdKNmxJbjBzSUM0dUxsMWNibHh1SnlBckNpQWdJQ0FuVyt5S3BPMkRnT3lkdkNEcXQ1enN1WmxkWEc0bklDc2dVMVJaVEVWZlVsVk1SVk1nS3lBblhHNWNiaWNnS3dvZ0lDQWdLRWRWU1VSRklEOGdKMXZzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jSU95Z2hPdXN1Q0FvZFhndGQzSnBkR2x1Wnk1dFpDa2c0b0NVSU95Y2hDRHF0NXpzdVpuc25aZ2c2cmU4NnJHdzdKbUFJT3lZaU95WnVDRHNpNXpyZ3BqcnBxenNtS1F1SU8yS3VlMmVpQ0RzbUlqc21iZ2c2cmVjN0xtWktPeUltT3VQbWUyWWxjSzM2cks5N0phMHdyZnJ0b0Rzb0pYdG1KWHNuWVFnN0p5ZzdLZUE3WlcwN0pXOElPMlZtT3VLbENEc2c0SHRtYWtwN0oyRUlPcTN1T3VNZ091aG5DRHJsTERycGJUcXM2QXNJT3lhbE95VnZlcXp2Q0Rzb0lUcnJManNuYlFnNjR1azY2VzA2Nm0wSU95Z2hPdXN1T3lkaENEcmxMRHJwYmpyaTZSZFhHNG5JQ3NnDQpSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cA0KYm1WQ2RXWWdQU0FuSnpzZ0lDQWdJQ0FnSUNBdkx5QnpkR1J2ZFhRZzdLU0VJT3V5aE8yTnZBcHNaWFFnZDJGcGRHVnlJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDOHZJTzJZaE95ZXJDRHRoTFRzblpnZ2V5QnlaWE52YkhabExDQnlaV3BsWTNRc0lIUnBiV1Z5SUgwS2JHVjBJSEYxWlhWbElEMGdVSEp2YldselpTNXlaWE52YkhabEtDazdJQzh2SU95YWxPeXlyU0RzcDRIcm9LenRtWlFnS091UG1leUxuQ0RzbXBUc3NxM3NuWUFnN0lpYzdJU2M2NHlBNjZHY0tRcHNaWFFnZEhWeWJuTWdQU0F3T3dwc1pYUWdkMkZ5YldWa1ZYQWdQU0JtWVd4elpUc0tiR1YwSUdOMWNuSmxiblJOYjJSbGJDQTlJRU5NUVZWRVJWOU5UMFJGVERzZ0x5OGc3S2VBNnJpSUlPeUV1T3lGbU95ZHRDRHJyTHpxczZBZzdKNkk2NHFVSU91cXFPdU51Q0FvN0pxVTdMS3Q3SjIwSU91THBPdWx1Q0RycXFqcmpianNuWVFnN0tlQTdLQ1Y3WldZNjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFcENpOHZJT3lMbk95ZWtTRHNpNXdnUTJ4aGRXUmwNCklFTnZaR1VvWTJ4aGRXUmxJRU5NU1NucXNJQWc3Sk80SU95SW1DRHNub2pyaXBUc3A0QWc3S0NRNnJLQUlPS0FsQ0RzbDRic25MenJxYlFnTDJobFlXeDBhT3VobkNEc2xZenJvS1FnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZuT3VMcEM0S0x5OGdiblZzYkQzdG1aWHNuYmdnN0tTUkxDQW5iMnNuUGV5Q3JPeWFxU0Rxc0lEcmlxVXNJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzlZMnhoZFdSbElPdXFoZXVndVNEc2w0YnNuWXdzQ2k4dklDZGpiR0YxWkdVdGJHOW5iM1YwSnoxamJHRjFaR1hyaXBRZzdKNkk3S2VBNjZlTUlPdWhuT3EzdU95ZHVDRHNoTGpzaFpnZzY2ZU02Nk9NSUNqdGhMUWc3SXVrN1l5b0lPeUxuQ0Rxc0pEc3A0QXNJT3lFc2VxenRTRHRoTFRzbmJRZzdKaWs2Nm0wSU95ZWtPdVBtU0R0bGJUc29Kd3BDaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzDQpucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWg0KN0oyQUlPcXl2ZXVobk91aG5DRHNucUh0bm9qcnI0RHJvWndnN0tTUjY2YTlJTzJSbk8yWWhPeWRoQ0RzazdUcmk2UUtZMjl1YzNRZ1RFOUhTVTVmUjFWSlJFVWdQU0FuN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdU95ZHRDRHRsWVRzbXBUdGxiVHNtcFFvN0pXSUlPdVFrT3F4c091Q21DRHJwNHpybzR3cElPS0FsQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGMGc2N0tFN1lxODdKMkVJT3VJaE91bHRPdXB0Q0Ryb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3lYdE95V3RPdVRuT3VncE95YWxDNG5Pd292THlEc2k2VHN1S0h0bFp3ZzY2eTQ2cldzNjVPa09pQWlSbUZwYkdWa0lIUnZJR0YxZEdobGJuUnBZMkYwWlRvZ1QwRjFkR2dnYzJWemMybHZiaUJsZUhCcGNtVmtJR0Z1WkNCamIzVnNaQ0J1YjNRZ1ltVWdjbVZtY21WemFHVmtJaWpycDR6cm80d3BMQW92THlBaVRtOTBJR3h2WjJkbFpDQnBiaURDdHlCUWJHVmhjMlVnY25WdUlDOXNiMmRwYmlJbzY2KzQ2NkdjNnJlNDdKMjQNCktTRGlnSlFnNjVHWUlPdUxwQ0RzbnFIdG5vanFzb3dnNjRTVDdaNk02NHVrQ21aMWJtTjBhVzl1SUdselFYVjBhRVZ5Y205eUtITXBJSHNLSUNCeVpYUjFjbTRnTDJGMWRHaGxiblJwWTJGMGZHOWhkWFJvZkdGd2FTQnJaWGw4Ykc5bklEOXBibnhzYjJkblpXUjhjMlZ6YzJsdmJpQmxlSEJwY21Wa0wya3VkR1Z6ZENoVGRISnBibWNvY3lrcE93cDlDaTh2SU95Q3JPeWFxU0R0bFp6cmo0UWc3TFNJNnJPOElPcXdrT3luZ0NEaWdKUWc2NkdjNnJlNDdKMjQ3SjJBSU91cGdPeXBvZTJWbk91TnNDQWk2NDJVSU91cXV5RHNrN1RyaTZRaTY0cVVJT3F5dmV5YXNDNGc2NkdjNnJlNDdKMjRJT3Vuak91ampPeVpnQ0Rzb2JEc3VaanFzSUFnNjR1czY1Mjg3SVNjSU91VXNPdWhuQ0RzbnFIcmlwVHJpNlF1Q2k4dklPeUxwT3k0b1NneU1ESTJMVEE0TENEdG1venNncXdnN0plVTdZU3c3WlNFNjUyODdKMjA3S2FJSU95aWpPeUVuU2s2SUNKWmIzVW5kbVVnYUdsMElIbHZkWElnYVc1a2FYWnBaSFZoYkNCemNHVnVaQ0JzDQphVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6cw0KbnBEc2w1RHFzb3dnN1pXYzY0K0U2Nlc4SU95WXJPdWdwQ0RyaTZ6cm5ienFzNkFnN0pxVTdMS3Q3WldZNnJPZ0xDRHNsWVRyaTRqcnFiUWdXL0NmbjZBZzdZRzA2NkdjNjVPY0lPMlZuT3VQaENEc3RJanFzN3hkSU91eWhPMkt2T3lkaENEcmlJenJuNndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxiUWc3S084N0lTNDdKcVVMaWM3Q2k4dklDZnRsWnpyajRRbjY2R2NJT3V0aWV1YXNlcTN1T3Vtck91cHRDRHNsWWdnNjVDYzY0dWtJT0tBbENEc25xRHF1WkFnNjZxdzY2YTBJT3VWakNEcmdwanJpcFFnY21GMFpTQnNhVzFwZE95ZHRPdUNtQ0RyckxqcnA2VWc2cmk0N0oyMElPeTBpT3F6dk9xNWpPeW5nQ0RzbnFIc2xZUUtMeThnN0plSjY1cXg3WldZNnJLTUlDTHJpNlRycGJnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJWbU91ZHZDTHFzNkFnN0pXSTY0SzA3WldZNnJLTUlPdVFuT3VMcEM0ZzdLZUE3TGFjd3Jmc2dxenNtcW5ybjRrZzdJT0I3WldjSU91c3VPcTENCnJPdW5qQ0Rzb29IdG1JRHNoSndnNjdPNDY0dWtDbVoxYm1OMGFXOXVJR2x6VEdsdGFYUkZjbkp2Y2loektTQjdDaUFnY21WMGRYSnVJQzl6Y0dWdVpDQnNhVzFwZEh4MWMyRm5aUzFqY21Wa2FYUnpmSFZ6WVdkbElHeHBiV2wwSUNoeVpXRmphR1ZrZkdWNFkyVmxaR1ZrS1M5cExuUmxjM1FvVTNSeWFXNW5LSE1wS1RzS2ZRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU8yWmxleWR1Q0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOejY2VzhJT3lkdmV5V3RBb3ZMeUF2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDQW83WlNNNjUrczZyZTQ3SjI0N0oyMElDTHJpSVRxdGF3ZzZyT0U3S0NWN0p5ODY2R2NJT3lUc091S2xDRHNwSkhzbmJqc3A0QWlJTzJSbk95TG5DRGlnSlFnNnJPMTdKcXBJRkJEN0plUTdJU2NJT3VDcU95ZG1DRHFzNFRzb0pVZzdKaWs3SUtzN0pxcElPdXdxZXluDQpnQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMA0KSU95ZHRDRHFzSkxxczd3ZzdZeU03SjI4N0oyWUlPcXpoT3lnbGV5ZHRDRHNsclRxdUl2cmdwenJpNlFLYkdWMElITmxjM05wYjI1QlkyTnZkVzUwSUQwZ2JuVnNiRHNLWm5WdVkzUnBiMjRnWTJ4aGRXUmxRV05qYjNWdWRDZ3BJSHNLSUNCcFppQW9SR0YwWlM1dWIzY29LU0F0SUdGalkyOTFiblJEWVdOb1pTNWhkQ0E4SURNd01EQXdLU0J5WlhSMWNtNGdZV05qYjNWdWRFTmhZMmhsTG1WdFlXbHNPd29nSUd4bGRDQmxiV0ZwYkNBOUlHNTFiR3c3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3dvZ0lDQWdaVzFoYVd3Z1BTQW9haUFtSmlCcUxtOWhkWFJvUVdOamIzVnVkQ0FtSmlCcUxtOWhkWFJvUVdOamIzVnVkQzVsYldGcGJFRmtaSEpsYzNNcElIeDhJRzUxYkd3N0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2cNCjY2R2M2cmU0N0oyNElPeWR0T3VncFNEc2w0YnNuWXdnNjVPeElPS0FsQ0J1ZFd4c0lPeWNvT3luZ0NBcUx5QjlDaUFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ1JHRjBaUzV1YjNjb0tTd2daVzFoYVd3Z2ZUc0tJQ0J5WlhSMWNtNGdaVzFoYVd3N0NuMEtablZ1WTNScGIyNGdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1NCN0NpQWdZMjl1YzNRZ2NISnZZbVVnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3ljdExYWmxjbk5wYjI0blhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXSUgwcE93b2dJR3hsZENCdmRYUWdQU0FuSnpzS0lDQndjbTlpWlM1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXlCdmRYUWdLejBnWkM1MGIxTjBjbWx1WnlncE95QjlLVHNLSUNCd2NtOWlaUzV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzdJSDBwT3dvZ0lIQnliMkpsTG05dUtDZGpiRzl6DQpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVA0KWldNNklDY25JSDA3Q2dvdkx5RGlsSURpbElBZzdaU002NStzNnJlNDdKMjRJT3lEbmV5aHRDRHFzSkRzcDRBbzdJdXM3SjZsNjdDVjY0K1pLU0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQUtMeThnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3VXb0NEc25vanJpcFFnNjQrWjdKV0lJR052WkdVdWRIUHFzSUFnTmV5MGlPdW5pT3VMcENCUVQxTlVJQzlvWldGeWRHSmxZWFRycGJ3ZzY3TzA2NEs0NjR1a0xnb3ZMeUR0bFp3ZzY3S0k3SjIwNjUyODY0K0VJT3V3bSt5ZGdDRHJrcVFnTXpEc3RJanFzSVFnNjRHSzZyaXc2Nm0wSU8yVWpPdWZyT3EzdU95ZHVDanJtSkRyaXBRZzdaUzg2cmU0NjZlSUtleWR0Q0RyaTZ2dG5vd2c2cktESU9LQWxDRHRnYlRyb1p6cms1enF1WXpzcDRBZzY0Mnc2NmFzNnJPZ0lPcXdtZXlkdENEcXVyenNwNFRyaTZRdUNpOHYNCklPeVZoT3luZ1NEdGxad2c2N0tJNjQrRUlPdXF1eURyc0p2c2xaanNuTHpycWJRbzY0dWs2NmFzNjZlTUlPdW92T3lnZ0NEc3ZLQWc3SU9CN1lPY0xDRHNucERyajVuc2k1enNucEVnNjVPeEtTRHFzNFRzaG8wZzY0eUE2cml3N1pXYzY0dWtMZ3BqYjI1emRDQklSVUZTVkVKRlFWUmZSRVZCUkY5TlV5QTlJRE13TURBd093cHNaWFFnYkdGemRFSmxZWFFnUFNBd093cHpaWFJKYm5SbGNuWmhiQ2dvS1NBOVBpQjdDaUFnYVdZZ0tHeGhjM1JDWldGMElDWW1JRVJoZEdVdWJtOTNLQ2tnTFNCc1lYTjBRbVZoZENBK0lFaEZRVkpVUWtWQlZGOUVSVUZFWDAxVEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNNNjUrczZyZTQ3SjI0SU95THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBZzRvQ1VJTzJVdk9xM3VPdW5pQy90bEl6cm42enF0N2pzbmJqc25iUWc2NHVyN1o2TUlPcXlnK3ljdk91aG5DRHJzN1RxczZBZzZyQ1o3SjIwSU9xNnZPeW5rZXVMaU91THBDNG5LVHNLSUNBZ0lIQnliMk5sDQpjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQc25MenJvWndnWTJ4aGRXUmxJTzJLdU91bXJPdWx2Q0Rzb0pYcnBxenRsWnpyaTZRS0lDQjlDbjBzSURVd01EQXBPd29LTHk4ZzRwU0E0cFNBSU9xemhPeWdsU0Rzb0lUdG1aanNuWUFnN0l1YzdZR3M2NmEvSU95d3ZleWN2T3VobkNBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU1qY3BJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0Fvdkx5QmI2ck9FN0tDVklPeWdoTzJabUYzc25ZUWc2NGlNNjZDQTY0cVU2NDJ3SUNKRGJHRjFaR1VnUTI5a1pldUxtT3lkdENEaWdLYnNsN0Rxc3JEc25ZUWc3SnFVN0xLdDdaYUk3SXExNjR1STY0dWtJaWpzaXJuc25iZ2c3Wm1VNjZtMEtlcXdnQ0RybktqcmlwUWc2cktNSU91MmlPdW5qT3lkdE95WGlPdUxwQzRLTHk4ZzY3aU02NTI4N0pxdzdLQ0E3SmVRSU95WW15RHFzNFRzb0pVZ1kyeGhkV1JsTG1GcA0KSU95RXVPeUZtT3lkdENEcmdxanNsWVFnN0o2STdKeTg2Nm0wSUdGMWRHaHZjbWw2WlNCVlVrenNuWUFnNnJPRTdLQ1Y3SjJFSU91c3UreW5nQ0RzbFlycXM2QWc2cmU0SU9xemhPeWdsZXljdk91aG5Bb3ZMeURzaXJuc25ianJwNHdnNjZ5NzY0cVU2NHVrTGlCVlVrenNsNUFnYzJWc1pXTjBRV05qYjNWdWRNSzNjSEp2YlhCMDY2VzhJT3lVak95YXNPcXhzT3VDbUNCc2IyZHZkWFEvY21WMGRYSnVWRy9yb1p3ZzdKNkg2NHFVSU9xeHRDRHNvSVRydG9BZzdJdWs3WXlvN1phSTY0dWtDaTh2SUNqc2xZVHJucGdnSjBKU1QxZFRSVklnNnJDQTY2R2M3TEdFNnJpd0p5RHNvN3pzaEozc25aZ2c3WjZJN0lxazdZYWc2NmFzS1M0Z0tpcnNoTGpzaFpqc25iUWc3SmVHNjRxVUlPeXd2ZXlYa095RW5DRHNsN1RycWJRZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95ZHRDRHF0N2pyZzZVZzY0S1k3SmlvNjR1a0tpb2c0b0NVQ2k4dklPeVp1T3UyZ0NEc2dxenNuYlR0aXJqc25aZ2c2NmFzNjR1azdKMjA2NkNKN1lxNElPcTMNCm5PeTVtZXlYa0NEcXVMRHJqSURzcDRBZzdKV0s2NHFVSU95Y29PeWR2TzJWbkNEcnNLbnJzcFhzbmJUcm5id2c3SjIwNnJHNElPeVR0T3VMcEM0S0x5OGc3SVN4NjZhOUlPcTN2T3F4c0NneU1ESTJMVEE0SU95THBPeTRvU2s2SU9LUm9DQkRURW5yaXBRZ1lYVjBhRzl5YVhwbElGVlNUQ0Rzb0lUcnJManNuWVFnS2lwemRHUnZkWFRzbDVBZzdMQ042NHFVNjR1a0tpb29Ja2xtSUhSb1pTQmljbTkzYzJWeUlHUnBaRzRuZEFvdkx5QnZjR1Z1TENCMmFYTnBkRG9nNG9DbUlpa2c0cEdoSUVKU1QxZFRSVkxycGJ3ZzdKV0U2NnkwNnJLRDY0K0VJT3lWaUNEdGxaanJpcFFnN0lxazdZR3M2NmE5N1lxNDY2R2NJT3luZ095Z2xlMlZtT3VwdENCRFRFbnFzSUFnN0o2UTZyaXdJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RzcDRBZzdKV0s3Snk4NjZtMDdJU2M2NCtFQ2k4dklDb3FiRzlqWVd4b2IzTjBJT3lla091UG1TRHNpSmpyb0xuc25ZQWc3SnlnN0tlQUtpcnRsWnpyaTZRb01USTNMakF1TUM0eElFeEpVMVJGDQpUaUR0bVpYc25iZ3BJT0tHa2lEc3ZaVHJrNXdnNjdhWjdKZXM2NFNqNnJpd0lPeVhodXlkdENEcmdaM3JncHpyaTZRdUNpOHZJQ29xVlZKTTdKMkFJSE4wWkc5MWRPeVhrT3lFbkNEcXNJRHNvTGpzbUt3ZzZyS0RLaW9nNG9DVUlFSlNUMWRUUlZJZzdaVzQ2NU9rNjUrczdKMllJT3lkdU95ZWtPdWhuQ0Ryc0p2c25MenJxYlFnWTIxazZyQ0FJR0FtWU95WGtPeUVuQ0RzbnBqcm5ienJxTG5yaXBUcmk2UW83SXVrN0xpaE9nb3ZMeUJCVWtkVFgwRk1UT3lkdENBL1kyOWtaVDEwY25WbDdKZVE3SVNjSU91Qm5ldUNtT3F6b0NCamJHbGxiblJmYVdRZzdKMjA3WnVFNnJDQUlPeUNyT3Vkdk95bmtDQTlJQ0xzbnBqcnFydnJrSndnVDBGMWRHZ2c3SnFVN0xLdEl1eWRtQ0RzcDRUc3A1d2c3SnVRN0oyNEtTNEtMeThnNjdpTTY1Mjg3SnF3N0tDQTY0cVVJT3lkdU95ZWtPdWhuQ0RzcDRIc29KRWc2NFNZNnJpMDY0dWtLSE5vWld4c0lPcXl2ZXljb0NEcXVJanNwNEFnNG9DVUlPcXdtZXlkZ0NEc25wanJwcnpzbllRZw0KNjR1NTdaV2M2NHVrS1M0S1puVnVZM1JwYjI0Z2QzSnBkR1ZPYjI5d1FuSnZkM05sY2lncElIc0tJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ1kyOXVjM1FnY0NBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRibTl2Y0M1amJXUW5LVHNLSUNBZ0lHWnpMbmR5YVhSbFJtbHNaVk41Ym1Nb2NDd2dKMEJsWTJodklHOW1abHh5WEc1bGVHbDBJQzlpSURCY2NseHVKeWs3Q2lBZ0lDQnlaWFIxY200Z2NEc0tJQ0I5Q2lBZ1kyOXVjM1FnY0NBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRibTl2Y0M1emFDY3BPd29nSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vY0N3Z0p5TWhMMkpwYmk5emFGeHVaWGhwZENBd1hHNG5LVHNLSUNCbWN5NWphRzF2WkZONWJtTW9jQ3dnTUc4M05UVXBPd29nSUhKbGRIVnliaUJ3T3dwOUNpOHZJT3lMbk8yQnJPdW12eTlKYmxCeWFYWmgNCmRHVWc3TEM5N0p5ODY2R2NJRlZTVE95ZGhDRHNsN0RyaTZRdUlPdXF1eURzbDdUcnFiUWdabUZzYzJVZzRvQ1VJTzJZdU95Mm5PMlZuQ0RzcXIzc25iUWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VobkNEdGo3VHJzTEh0bFp6cmk2UUtMeThnS08yUHRPdXdzZXlkdENEc2w0YnNuTHpycWJRZzdKV0U2NnkwSU95d3ZldVBoQ0RzbFlnZzY1YWc3SVNjSU95Q3JPeWFxZXlla09xd2dDRHJwNG50bm96cmk2UWc0b0NVSUVKU1QxZFRSVkxycGJ3Z2JtOHRiM0Rzbkx6cm9ad2c2NmVKN0pXRUlPdVNnT3E0c0NEcmxZenJyTGdwTGdwamIyNXpkQ0JYU1U1ZlVGSkpWa0ZVUlY5Q1VrOVhVMFZTVXlBOUlGc0tJQ0I3SUdWNFpUb2dLSEJ5YjJObGMzTXVaVzUyTGxCeWIyZHlZVzFHYVd4bGN5QjhmQ0FuUXpwY1hGQnliMmR5WVcwZ1JtbHNaWE1uS1NBcklDZGNYRWR2YjJkc1pWeGNRMmh5YjIxbFhGeEJjSEJzYVdOaGRHbHZibHhjWTJoeWIyMWxMbVY0WlNjc0lHWnNZV2M2SUNjdExXbHVZMjluYm1sMGJ5Y2dmU3dLDQpJQ0I3SUdWNFpUb2dLSEJ5YjJObGMzTXVaVzUyV3lkUWNtOW5jbUZ0Um1sc1pYTW9lRGcyS1NkZElIeDhJQ2RET2x4Y1VISnZaM0poYlNCR2FXeGxjeUFvZURnMktTY3BJQ3NnSjF4Y1IyOXZaMnhsWEZ4RGFISnZiV1ZjWEVGd2NHeHBZMkYwYVc5dVhGeGphSEp2YldVdVpYaGxKeXdnWm14aFp6b2dKeTB0YVc1amIyZHVhWFJ2SnlCOUxBb2dJSHNnWlhobE9pQW9jSEp2WTJWemN5NWxiblpiSjFCeWIyZHlZVzFHYVd4bGN5aDRPRFlwSjEwZ2ZId2dKME02WEZ4UWNtOW5jbUZ0SUVacGJHVnpJQ2g0T0RZcEp5a2dLeUFuWEZ4TmFXTnliM052Wm5SY1hFVmtaMlZjWEVGd2NHeHBZMkYwYVc5dVhGeHRjMlZrWjJVdVpYaGxKeXdnWm14aFp6b2dKeTB0YVc1d2NtbDJZWFJsSnlCOUxBb2dJSHNnWlhobE9pQW9jSEp2WTJWemN5NWxibll1VUhKdlozSmhiVVpwYkdWeklIeDhJQ2RET2x4Y1VISnZaM0poYlNCR2FXeGxjeWNwSUNzZ0oxeGNUV2xqY205emIyWjBYRnhGWkdkbFhGeEJjSEJzYVdOaGRHbHZibHhjYlhObA0KWkdkbExtVjRaU2NzSUdac1lXYzZJQ2N0TFdsdWNISnBkbUYwWlNjZ2ZTd0tYVHNLWm5WdVkzUnBiMjRnYjNCbGJsQnlhWFpoZEdWWGFXNWtiM2NvZFhKc0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJR1p2Y2lBb1kyOXVjM1FnWWlCdlppQlhTVTVmVUZKSlZrRlVSVjlDVWs5WFUwVlNVeWtnZXdvZ0lDQWdJQ0FnSUdsbUlDZ2habk11WlhocGMzUnpVM2x1WXloaUxtVjRaU2twSUdOdmJuUnBiblZsT3dvZ0lDQWdJQ0FnSUhOd1lYZHVLR0l1WlhobExDQmJZaTVtYkdGbkxDQjFjbXhkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2QybHVaRzkzYzBocFpHVTZJR1poYkhObElIMHBMblZ1Y21WbUtDazdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95TG5PMkJyT3VtdnlEc3NMM3NuTHpyb1p3ZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95ZGhDRHNsN1RzbDRqc2xyVHNtcFE2SUNjZ0t5QncNCllYUm9MbUpoYzJWdVlXMWxLR0l1WlhobEtTazdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlIUnlkV1U3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdjbVYwZFhKdUlHWmhiSE5sT3dvZ0lDQWdmUW9nSUNBZ0x5OGdiV0ZqVDFNZzRvQ1VJTzJCck91aHJPeWR0Q0Rzbm9qc25MenJxYlFnN0l1YzdZR3M2NmEvSU95d3ZTd2c3SmVHN0p5ODY2bTBJTzJQdE91d3NTanNncXp0akl6cnBxenJpcFFnUTB4SjY2R2NJT3F3bk95ZHVPeWdsZXV6dENEcnM3VHRtTGdnN0xDOTdKMkVJT3VxdXlEc2w3RHJpNlFwQ2lBZ0lDQmpiMjV6ZENCeUlEMGdjM0JoZDI1VGVXNWpLQ2R2Y0dWdUp5d2dXeWN0Ym1FbkxDQW5SMjl2WjJ4bElFTm9jbTl0WlNjc0lDY3RMV0Z5WjNNbkxDQW5MUzFwYm1OdloyNXBkRzhuTENCMWNteGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJR2xtSUNoeUxuTjBZWFIxY3lBOVBUMGdNQ2tnZXlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXVjN1lHczY2YS9JT3l3dmV5Y3ZPdWhuQ0RyDQpvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKMkVJT3lYdE95WGlPeVd0T3lhbENBb1EyaHliMjFsS1NjcE95QnlaWFIxY200Z2RISjFaVHNnZlFvZ0lDQWdjbVYwZFhKdUlHWmhiSE5sT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGRIVnliaUJtWVd4elpUc2dmUXA5Q2k4dklPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJvWndnN0plMDZyaXdLTzJQdE91d3NTa3VJSGRwYmpNeTY0cVVJSEoxYm1Sc2JETXk2NkdjSU9LQWxDQmpiV1RycGJ3ZzdKV0lJT3F4c095emtPeUVuQ0JWVWt6c25aZ2dKdXF3Z0NEc2xZZ2c3SjZZNjZhdzY0dWtDbVoxYm1OMGFXOXVJRzl3Wlc1RVpXWmhkV3gwUW5KdmQzTmxjaWgxY213cElIc0tJQ0IwY25rZ2V3b2dJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSE53WVhkdUtDZHlkVzVrYkd3ek1pY3NJRnNuZFhKc0xtUnNiQ3hHYVd4bFVISnZkRzlqYjJ4SVlXNWtiR1Z5Snl3Z2RYSnNYU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhkcA0KYm1SdmQzTklhV1JsT2lCMGNuVmxJSDBwTG5WdWNtVm1LQ2s3Q2lBZ0lDQmxiSE5sSUhOd1lYZHVLQ2R2Y0dWdUp5d2dXM1Z5YkYwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBMblZ1Y21WbUtDazdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VobkNEcm9aenF0N2pzbmJnZzdabVU2Nm0wN0oyRUlPeVh0T3lYaU95V3RPeWFsQ2pzaTV6dGdhenJwcjhnN0xDOUlPeUxwTzJNcUNEdGo3VHJzTEVwTGljcE93b2dJQ0FnY21WMGRYSnVJSFJ5ZFdVN0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVjBkWEp1SUdaaGJITmxPeUI5Q24wS0NpOHZJT0tVZ09LVWdDQkNVazlYVTBWU0lPcXdnT3Vobk95eGhPcTRzT3VLbENEc29KenFzYkRya0pEcmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVEkxS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdKaUk3S0NFN0plVUlFSlMNClQxZFRSVklnN1ptWTZySzk2N09BN0lpWTdKZVFJT3llaE95TG5DRHNpcVR0Z2F6cnByM3RpcmpycGJ3ZzZyMkM3SldFSUVOTVNlcXdnQ0RzcElBZ1lYVjBhRzl5YVhwbElGVlNUT3lkaENEc21yRHJwcXpxc0lBZzY3Q2I3SldFN0lTY0lPeVh0T3lYaU91THBDNEtMeThnNjZxcDdLQ0I3SjJBSU8yVm1PdUNtT3Uva095ZHRPeVhpT3VMcENEaWdKUWc2ck9FN0tDVklPeWdoTzJabU95YXFleWN2T3VobkNCVlVrenNuWVFnWTJ4aGRXUmxMbUZwTDJ4dloyOTFkRDl5WlhSMWNtNVViejNpZ0ticm9ad2c3SjZzN0o2UjdJU3g3WlcwQ2k4dklPeUt1ZXlkdUNEdG1aVHJxYlRzbllRZzZyRzA2NFNJNjV1dzZyT2dJT3F6aE95Z2xTRHNoS0R0ZzUwZzdabVU2Nm0wN0plUUlPeW5nZTJXaWV5TG5PMkNwT3E0c0M0ZzZyZTRJT3llck95ZWtleUVzZXlkaENEdGo1RHF1TER0bFpqc25wQW83SUtzN0pxcDdKNlFJT3F5c095Z2xTa2c3Wlc0NjVPazY1K3M2NHFVQ2k4dklPdXFxZXlnZ2V5ZHRDRHNsNGJzbHJUc29ZenFzNkFzDQpJQ29xNjRLbzZyS29JT3VSa091cHRDRHNtS1R0bm9qcm9LUWc2NkdjNnJlNDdKMjQ3SjJFSU91bm5lcXdnT3VjcU91bXNPdUxwQ29xT2dvdkx5QWdJRU5NU2Vxd2dDQlZVa3pzbllRZzY1U3c3SmkwN1pHY0lPeVhodXlkdENEcmhKanF1TERycWJRZ1kyMWs2ckNBSUdBbVlPeVhrT3lFbkNCVlVrenNuWVFnN0o2WTY1MjhJT3V5aE91Z3BDanNuSWpyajRUc21yQXBJR05zYVdWdWRGOXBaQ0Rxc0puc25ZQWc2NUtrN0txOUNpOHZJQ0FnNjZlazZyQ2M2N09BN0lpWTZyQ0FJT3lDck91ZHZPeW5nT3F6b0N3ZzY3aU02NTI4N0pxdzdLQ0E3SmVVSUNMc25wanJxcnZya0p3Z1QwRjFkR2dnN0pxVTdMS3RJTUszSUdOc2FXVnVkRjlwWkNEcnA2VHFzSnpyczREc2lKanFzSUFnNjRpRTY1Mjk2NUNZN0plSTdJcTE2NHVJNjR1a0l1cXdnQ0Rybkt6cmk2UXVDaTh2SUNBZzdJdXM3WldZNjZtMElPdTRqT3Vkdk95YXNPeWdnT3F3Z0NEc2xZVHNtSWdnN0pXSUlPeVh0T3Vtc091THBDanNpNlRzdUtFZ01qQXlOaTB3T0RvZw0KUTB4SklPMlVoT3Vobk95RXVPeUtwT3VLbENEcmpJRHF1TEFnN0tTUjdKMjQ2NDJ3SU95d3ZleWR0Q0RzbFlnZzY1eTRLUzRLTHk4ZzdKMjA3S0NjSUVKU1QxZFRSVkxycGJ3ZzZyRzA2NU9jNjZhczdLZUFJT3lWaXV1S2xPdUxwQ0RpaHBJZ1kyeGhkV1JsSUVOTVNlcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNjZXOElPeW5nZXlna1NEc2w3RHJpNlFvUTB4SklPcTRzT3V6dUNEcmo1bnNucEVwTGdvdkx5QXFLdXlkdENEcXNyM3JvWnpzbDVBZ1ZWSk1JT3F3Z09xenRjSzM3S1NSNnJDRUlPeUtwTzJCck91bXZlMkt1T3VsdkNEcmk2VHNpNXdnNjRTajdLZUFJT3Vua0NEcXNvTXVLaW9nNnJPRTdLQ1ZJT3lnaE8yWm1PeWRnQ0RzaXJuc25iZ2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjBnNjdLRTdZcTg3Snk4NjZHY0xnb0tMeThnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHRsSVRyb1p6c2hManNpcVFnS0dOc1lYVmtaU0JoZFhSb0lHeHZaMmx1SUMwdFkyeGgNCmRXUmxZV2twSU9LQWxDQXZiM0JsYmkxc2IyZHBidXlkdENEc2c1M3NoTEhDdCtxMGdPdW1yQzRLTHk4ZzY3aU02NTI4N0pxdzdLQ0E2ckNBSUd4dlkyRnNhRzl6ZE91aG5DRHFzckRxczd6cnBid2c2N08wNjRLMDdLU0VJT3VWak9xNWpPeW5nQ0RzaUtqc2xyVHNoSndnNjR5QTZyaXc3WldZNjR1azZyQ0FMQ0RzbVlUcm80enJrSmpycWJRZzdJcWs3SXFrNjZHY0lPdUJuZXVDbk91THBDNEtiR1YwSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3Q214bGRDQnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlHNTFiR3c3Q214bGRDQnNiMmRwYmxOMFlYSjBaV1JCZENBOUlEQTdJQzh2SU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25iZ2c3SXVjN0o2UklPeUxuT3F3Z1NEaWdKUWc3SjZzN1lHMDY2YXQ3SjIwSUNmc25xenNpNXpyajRRbjdKMjQ3S2VBSUNmc25wRHJqNW5zbVlUcm80d2c3SXVrN1l5b0oreWR1T3luZ0NEcXRhenJ0b1R0bFp6cmk2UUtablZ1WTNScGIyNGdhMmxzYkV4dloybHVVSEp2WXlncElIc0tJQ0JwDQpaaUFvYkc5bmFXNVFjbTlqVkdsdFpYSXBJSHNnWTJ4bFlYSlVhVzFsYjNWMEtHeHZaMmx1VUhKdlkxUnBiV1Z5S1RzZ2JHOW5hVzVRY205alZHbHRaWElnUFNCdWRXeHNPeUI5Q2lBZ2FXWWdLQ0ZzYjJkcGJsQnliMk1wSUhKbGRIVnlianNLSUNCamIyNXpkQ0J3SUQwZ2JHOW5hVzVRY205ak93b2dJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdDaUFnZEhKNUlIc0tJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJSE53WVhkdVUzbHVZeWduZEdGemEydHBiR3duTENCYkp5OVFTVVFuTENCVGRISnBibWNvY0M1d2FXUXBMQ0FuTDFRbkxDQW5MMFluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdDaUFnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0IwY25rZ2V5QndjbTlqWlhOekxtdHBiR3dvTFhBdWNHbGtMQ0FuVTBsSFZFVlNUU2NwT3lCOUlHTmhkR05vSUNoZlpUSXBJSHNnY0M1cmFXeHNLQ2s3SUgwS0lDQWdJSDBLSUNCOUlHTmhkR05vSUNoZg0KWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwOUNnb3ZMeUR0aExRZzY0K0U3S1NSSU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxVHFzSUFnN0tPOTdKZUk3SjJFSU91VmpPeWRtQ0RzaTZUdGpLZ2c2Nm1VN0l1YzdLZUFJT0tBbENCeWRXNVVkWEp1N0oyMElPeWR0Q0RycVpUc2k1enNwNERzbmJ3ZzY1V002NmVNSURIdG1vd2c3SjZRNjQrWklPeWVyT3lMbk91UGhPMlZuT3VMcEFwamIyNXpkQ0JUUlZOVFNVOU9YMFJKUlVRZ1BTQW43WUcwNjZHYzY1T2NJT3lFdU95Rm1PeWR0Q0Rzb29Ycm80enJrSkRzbHJUc21wUXVKenNLYkdWMElITm9kWFIwYVc1blJHOTNiaUE5SUdaaGJITmxPeUF2THlBdmMyaDFkR1J2ZDI0ZzdLZUU3WmFKSU95a2tTRGlnSlFnN0o2czdJdWM2NCtFNjZHY0lPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcnBxenNwNEFnN0pXSzZyS01JTzJSbk95TG5Bb0tMeThnY21WaGMyOXU3SjJFSU95anZPdXB0Q0FuN0oyWTY0K0U3S0NCSU95aWhldWpqQ2NvNnJPRTdLQ1ZJT3lnaE8yWm1NSzMNCjY2R2M2cmU0N0pXRTdKdURJT3VUc1NrZzRvQ1VJT3luaE8yV2lTRHNwSkhzbmJUcmpaZ2c3WVMwN0oyRUlPcTN1Q0RycVpUc2k1enNwNERyb1p3ZzY0R2Q2NEswN0lTY0NpOHZJSEoxYmxSMWNtN3NuWmdnVTBWVFUwbFBUbDlFU1VWRUlPeWVrT3VQbVNEc25xenNpNXpyajRUcXNJQWc3SmliSU95ZWtPcXlxZXltbmV1cWhleWN2T3VobkNEc2hManNoWmpzbllRZzY1Q1k3SUswNjZhczdLZUFJT3lWaXVxeWpDRHRsWnpyaTZRdUNpOHZJQ2pzbFlnZzZyZTQ2NStzNjZtMElPcXpoT3lnbFNEc29JVHRtWmdnN0tlQjdadUVJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjIwSU91MmdPMlpuTzJWdENCTlFWaGZWRlZTVGxQcXVZenNwNEFnNnJPRTdJYU5JT3lUc095ZHRPdUtsQ0Ryc29UcXQ3Z2c0b0NVSURJd01qWXRNRGNnNjZhczY3ZXc3SmVRN0lTY0lPMlpsZXlkdUNrS1puVnVZM1JwYjI0Z2EybHNiRkJ5YjJNb2NtVmhjMjl1S1NCN0NpQWdhV1lnS0hCeWIyTXBJSHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJR2xtDQpJQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUNBZ0x5OGdjMmhsYkd3NmRISjFaZXVobkNEcm5ZVHNtNHpzaEp3Z2NISnZZK3lkZ0NCamJXUWc2cnVONjQydzZyaXdJT0tBbENBdlZPdWhuQ0R0aXJqcnBxenNwN2dnN0tPOTdKZXM3Slc4SU95bmhPeW5uQ0JqYkdGMVpHWHFzSUFnNnJPZzdKV0U2NkdjSU95VmlDRHJncWpyaXBUcmk2UUtJQ0FnSUNBZ0lDQXZMeUFvNnJPZzdKV0VJR05zWVhWa1plcXdnQ0RzaEtUc3VaZ2c3WXlNN0oyODdKMkVJT3Vzdk9xem9DRHNub2pzbkx6cnFiUWc3WUcwNjZHYzY1T2NJT3lWc1NEc2w0WHJqYkRzbmJUdGlyanFzSUFnSXV5Q3JPeWFxU0RzcEpFaTdKeTg2NkdjSU91bmllMmVtQ2tLSUNBZ0lDQWdJQ0J6Y0dGM2JsTjVibU1vSjNSaGMydHJhV3hzSnl3Z1d5Y3ZVRWxFSnl3Z1UzUnlhVzVuS0hCeWIyTXVjR2xrS1N3Z0p5OVVKeXdnSnk5R0oxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3dvZ0lDQWdJQ0I5SUdWcw0KYzJVZ2V3b2dJQ0FnSUNBZ0lDOHZJRzFoWTA5VEwrdW1yT3VJaGV5S3BEb2djMmhsYkd3NmRISjFaZXVkdkNCd2NtOWo3SjIwSUhOb0lPcTdqZXVOc09xNHNPeWR2Q0RzaUpnZzdKNkk3SjJNSU9LQWxDQnpkR0Z5ZEZCeWIyUHNuWmdnWkdWMFlXTm9aV1Ryb1p3ZzY2ZU02NU9nQ2lBZ0lDQWdJQ0FnTHk4ZzdaU0U2NkdjN0lTNDdJcWtJT3EzdU91anVTZ3RjR2xrS2V5ZGhDRHRoclhzcDdqcm9ad2c3S0NWNjZhczdaV2M2NHVrSUNoMFlYTnJhMmxzYkNBdlZDRHJqSURzblpFcENpQWdJQ0FnSUNBZ2RISjVJSHNnY0hKdlkyVnpjeTVyYVd4c0tDMXdjbTlqTG5CcFpDd2dKMU5KUjFSRlVrMG5LVHNnZlNCallYUmphQ0FvWDJVeUtTQjdJSEJ5YjJNdWEybHNiQ2dwT3lCOUNpQWdJQ0FnSUgwS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3VzdE95TG5DQXFMeUI5Q2lBZ2ZRb2dJSEJ5YjJNZ1BTQnVkV3hzT3dvZ0lIZGhjbTFsWkZWd0lEMGdabUZzYzJVN0NpQWdhV1lnS0hkaGFYUmxjaWtnZXlCamJHVmgNCmNsUnBiV1Z2ZFhRb2QyRnBkR1Z5TG5ScGJXVnlLVHNnZDJGcGRHVnlMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9jbVZoYzI5dUlIeDhJRk5GVTFOSlQwNWZSRWxGUkNrcE95QjNZV2wwWlhJZ1BTQnVkV3hzT3lCOUNuMEtDbVoxYm1OMGFXOXVJSE4wWVhKMFVISnZZeWdwSUhzS0lDQnJhV3hzVUhKdll5Z3BPd29nSUd4cGJtVkNkV1lnUFNBbkp6c0tJQ0IwZFhKdWN5QTlJREE3Q2lBZ0x5OGc3SjIwSU95RXVPeUZtT3lkdENEc2xyVHJpcEFnNnJPRTdLQ1Y3SjJZSU95ZWhleWVwZXEyak95Y3ZPdWhuQ0RyajRUcmlwVHNwNEFnNnJpdzY2R2RJT0tBbENEcnNKYnNsNURzaEp3ZzZyT0U3S0NWN0oyMElPdXdsT3VBak95WGlPdUtsT3luZ0NEcnVZVHF0WkR0bFpqcmlwUWc2cml3N0tTQUNpQWdjMlZ6YzJsdmJrRmpZMjkxYm5RZ1BTQmpiR0YxWkdWQlkyTnZkVzUwS0NrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yQnRPdWhuT3VUbkNEc2hManNoWmdnN0l1YzY0K1pJT3lra2VLQXBpQW82NnFvDQo2NDI0T2lBbklDc2dZM1Z5Y21WdWRFMXZaR1ZzSUNzZ0p5a25LVHNLSUNCamIyNXpkQ0IwYUdselVISnZZeUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSnkxd0p5d2dKeTB0Ylc5a1pXd25MQ0JqZFhKeVpXNTBUVzlrWld3c0lDY3RMV2x1Y0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzSUNjdExXOTFkSEIxZEMxbWIzSnRZWFFuTENBbmMzUnlaV0Z0TFdwemIyNG5MQ0FuTFMxMlpYSmliM05sSjEwc0lIc0tJQ0FnSUhOb1pXeHNPaUIwY25WbExDQmpkMlE2SUVWTlVGUlpYME5YUkN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTEFvZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzSUM4dklGQlBVMGxZT2lEc25wRHF1TEFnN1pTRTY2R2M3SVM0N0lxa0lPcTN1T3VqdVNEc2c1M3NoTEVnNG9DVUlHdHBiR3hRY205ajdKMjBJT3EzdU91anVleW51Q0Rzb0pYcnBxenRsYUFnN0lpWUlPeWVpT3F5akFvZ0lIMHBPd29nSUhCeWIyTWdQU0IwYUdseg0KVUhKdll6c0tJQ0J3Y205akxuTjBaRzkxZEM1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0NpQWdJQ0JzYVc1bFFuVm1JQ3M5SUdRdWRHOVRkSEpwYm1jb0ozVjBaamduS1RzS0lDQWdJR3hsZENCcFpIZzdDaUFnSUNCM2FHbHNaU0FvS0dsa2VDQTlJR3hwYm1WQ2RXWXVhVzVrWlhoUFppZ25YRzRuS1NrZ0lUMDlJQzB4S1NCN0NpQWdJQ0FnSUdOdmJuTjBJR3hwYm1VZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0RBc0lHbGtlQ2t1ZEhKcGJTZ3BPd29nSUNBZ0lDQnNhVzVsUW5WbUlEMGdiR2x1WlVKMVppNXpiR2xqWlNocFpIZ2dLeUF4S1RzS0lDQWdJQ0FnYVdZZ0tDRnNhVzVsS1NCamIyNTBhVzUxWlRzS0lDQWdJQ0FnYkdWMElHVjJJRDBnYm5Wc2JEc0tJQ0FnSUNBZ2RISjVJSHNnWlhZZ1BTQktVMDlPTG5CaGNuTmxLR3hwYm1VcE95QjlJR05oZEdOb0lDaGZaU2tnZXlCamIyNTBhVzUxWlRzZ2ZRb2dJQ0FnSUNCcFppQW9aWFlnSmlZZ1pYWXVkSGx3WlNBOVBUMGdKM0psYzNWc2RDY2dKaVlnZDJGcGRHVnkNCktTQjdDaUFnSUNBZ0lDQWdZMjl1YzNRZ2R5QTlJSGRoYVhSbGNqc0tJQ0FnSUNBZ0lDQjNZV2wwWlhJZ1BTQnVkV3hzT3dvZ0lDQWdJQ0FnSUdOc1pXRnlWR2x0Wlc5MWRDaDNMblJwYldWeUtUc0tJQ0FnSUNBZ0lDQnBaaUFvWlhZdWFYTmZaWEp5YjNJcElIc0tJQ0FnSUNBZ0lDQWdJR052Ym5OMElISmhkeUE5SUZOMGNtbHVaeWhsZGk1eVpYTjFiSFFnZkh3Z1pYWXVjM1ZpZEhsd1pTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z01qQXdLVHNLSUNBZ0lDQWdJQ0FnSUM4dklPMlZuT3VQaENEc3RJanFzN3pycGJ3ZzY2aTg3S0NBSU91enVPdUxwQ0RpZ0pRZzY2R2M2cmU0N0oyNElPeVlwT3VsbUNEc29KWHF0NXpzaTUzc25iUWc2NFNUN0phMDdJU2NLR3h2WnlBL2FXNGc2NU94S1NEcnJManF0YXpxc0lBZzY3Q1U2NENNNjZtMElPeUN2TzJDckNEc2lKZ2c3SjZJNjR1a0NpQWdJQ0FnSUNBZ0lDQnBaaUFvYVhOTWFXMXBkRVZ5Y205eUtISmhkeWtwSUhzS0lDQWdJQ0FnSUNBZ0lDQWdZMnhoZFdSbFUzUmhkSFZ6DQpJRDBnSjJOc1lYVmtaUzFzYVcxcGRDYzdJQzh2SUM5b1pXRnNkR2pyb1p3ZzdKV002NmE4SU9LR2tpRHJzb1R0aXJ6c25iUWdXKzJWbk91UGhDRHN0SWpxczd4ZDY2R2NJT3V3bE91QWpPcXpvQ0RxczRUc29KVWc3S0NFN1ptWTdKMkVJT3lWaU91Q3RBb2dJQ0FnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFFnN0xTSTZyTzhJT3F3a095bmdEb25MQ0J5WVhjcE93b2dJQ0FnSUNBZ0lDQWdJQ0IzTG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvVEVsTlNWUmZSMVZKUkVVcEtUc0tJQ0FnSUNBZ0lDQWdJSDBnWld4elpTQnBaaUFvYVhOQmRYUm9SWEp5YjNJb2NtRjNLU2tnZXdvZ0lDQWdJQ0FnSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNBblkyeGhkV1JsTFd4dloyOTFkQ2M3SUM4dklDOW9aV0ZzZEdqcm9ad2c3WlNNNjUrczZyZTQ3SjI0N0plUUlPeVZqT3VtdkNEaWhwSWc2N0tFN1lxODdKMjBJRnZyb1p6cXQ3anNuYmdnN1pXRQ0KN0pxVVhldWhuQ0Ryc0pUcmdKd0tJQ0FnSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c2NmVNNjZPTUlPcXdrT3luZ0RvbkxDQnlZWGNwT3dvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9URTlIU1U1ZlIxVkpSRVVwS1RzS0lDQWdJQ0FnSUNBZ0lIMGdaV3h6WlNCN0NpQWdJQ0FnSUNBZ0lDQWdJSGN1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN1lHMDY2R2M2NU9jSU95WXBPdWxtRG9nSnlBcklISmhkeWtwT3dvZ0lDQWdJQ0FnSUNBZ2ZRb2dJQ0FnSUNBZ0lIMGdaV3h6WlNCN0NpQWdJQ0FnSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNBbmIyc25PeUF2THlEc2hMSHFzN1VnUFNEc2hLVHN1WmpDdCt1aG5PcTN1T3lkdUNEcmk2UWc3S0NWN0lPQklPS0FsQ0RzbHJUcmxxUWdjSEp2WW14bGJleWR0T3VUb0NEdGxiVHNvSndnS095ZXJPdWhuT3EzdU95ZHVDL3NucXpzaEtUc3VaZ2c2N08xNnJlQUtRb2cNCklDQWdJQ0FnSUNBZ2R5NXlaWE52YkhabEtGTjBjbWx1WnlobGRpNXlaWE4xYkhRZ2ZId2dKeWNwS1RzS0lDQWdJQ0FnSUNCOUNpQWdJQ0FnSUgwS0lDQWdJSDBLSUNCOUtUc0tJQ0J3Y205akxuTjBaR1Z5Y2k1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0NpQWdJQ0JqYjI1emRDQnpJRDBnWkM1MGIxTjBjbWx1WnlnbmRYUm1PQ2NwTG5SeWFXMG9LVHNLSUNBZ0lHbG1JQ2h6SUNZbUlDRnpMbWx1WTJ4MVpHVnpLQ2RFWlhCeVpXTmhkR2x2YmxkaGNtNXBibWNuS1NrZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJR05zWVhWa1pTQnpkR1JsY25JNkp5d2djeTV6YkdsalpTZ3dMQ0F5TURBcEtUc0tJQ0I5S1RzS0lDQndjbTlqTG05dUtDZGpiRzl6WlNjc0lDaGpiMlJsS1NBOVBpQjdDaUFnSUNBdkx5RHNuYlRycjdnZzdJT0lJT3lFdU95Rm1PeWN2T3VobkNEcXRaRHNzclRya0p3ZzY1S2tJT3lZbXlEc2hManNoWmpzbmJRZzY0dXI3WjZNSU9xeHNPdXB0Q0RyckxUc2k1d2dLT3VxcU91TnVDRHNvSVR0DQptWmdnN0l1Y0lPeURpQ0RzaExqc2haanNuWVFnN0tPOTdKMjA3S2VBSU95Vml1cXlqQ2tLSUNBZ0lHbG1JQ2h3Y205aklDRTlQU0IwYUdselVISnZZeWtnY21WMGRYSnVPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c3S0tGNjZPTUlDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a2c0b0NVSU91THBPeWRqQ0RzbXBUc3NxMGc2NVdNSU91THBPeUxuQ0RzaTV6cmo1bnRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUgwcE93cDlDZ3BtZFc1amRHbHZiaUJ6Wlc1a1ZIVnliaWgwWlhoMEtTQjdDaUFnY21WMGRYSnVJRzVsZHlCUWNtOXRhWE5sS0NoeVpYTnZiSFpsTENCeVpXcGxZM1FwSUQwK0lIc0tJQ0FnSUdsbUlDZ2hjSEp2WXlrZ2NtVjBkWEp1SUhKbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSisyQnRPdWhuT3VUbkNEc2hManNoWmpzbmJRZzdKZUc3SmEwN0pxVUxpY3BLVHNLSUNBZ0lHbG1JQ2gzWVdsMFpYSXBJSEpsZEhWeQ0KYmlCeVpXcGxZM1FvYm1WM0lFVnljbTl5S0Nmc2xaN3NoS0FnN0pxVTdMS3Q3SjIwSU95bmhPMldpU0RzcEpIc25iVHNsNURzbXBRdUp5a3BPd29nSUNBZ1kyOXVjM1FnZEdsdFpYSWdQU0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yRXRDRHNpNXpxc0lRZzdMU0k2ck84SU9LQWxDRHNoTGpzaFpqc25ZUWc3SjZzN0l1YzdKNlI3WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdJQ0F2THlEc2k1enFzSVFnN0xTSTZyTzg2NHFVSUNmc2hManNoWmdnN0tLRjY2T01KK3laZ0NEcXRhenJ0b1Rya0pqcmlwUWc3S0NjSU91cGxPeUxuT3luZ091aG5DRHJnWjNyZ3Jqcmk2UWc0b0NVSUd0cGJHeFFjbTlqN0oyWUlPeUV1T3lGbUNEc29vWHJvNHdnY21WcVpXTjA2ckNBQ2lBZ0lDQWdJQzh2SUhKMWJsUjFjbTdzblpnZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE91bHZDRHJ0b0RycGJUcnFiUWc3SldJSU91UW1PcTRzQ0RybFl6cnJMZ282NHFRNjZhd0lPMkUNCnRPeWRoQ0Rya1pBZzY3S0lJT3VQak91cHRDRHRsSXpybjZ6cXQ3anNuYmdnTVRNdzdMU0lJT3lnbk8yVm5PeWRoQ0RyaEpqcXVMVHJpNlFwQ2lBZ0lDQWdJR2xtSUNoM1lXbDBaWElwSUhzS0lDQWdJQ0FnSUNCamIyNXpkQ0IzSUQwZ2QyRnBkR1Z5T3lCM1lXbDBaWElnUFNCdWRXeHNPd29nSUNBZ0lDQWdJSGN1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN1lHMDY2R2M2NU9jSU95ZGtldUx0ZXlkdENEcmhJanJyTFFnN0ppazY1NllJT3F4dU91Z3BDRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bzdaYUk3SmEwN0pxVUlPS0FsQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRuS1NrN0NpQWdJQ0FnSUgwS0lDQWdJQ0FnYTJsc2JGQnliMk1vS1RzS0lDQWdJSDBzSUZSVlVrNWZWRWxOUlU5VlZGOU5VeWs3Q2lBZ0lDQjNZV2wwWlhJZ1BTQjdJSEpsYzI5c2RtVXNJSEpsYW1WamRDd2dkR2x0WlhJZ2ZUc0tJQ0FnSUhCeWIyTXVjM1JrYVc0dWQzSnBkR1VvU2xOUFRpNXpkSEpwYm1kcFpua29leUIwDQplWEJsT2lBbmRYTmxjaWNzSUcxbGMzTmhaMlU2SUhzZ2NtOXNaVG9nSjNWelpYSW5MQ0JqYjI1MFpXNTBPaUIwWlhoMElIMGdmU2tnS3lBblhHNG5MQ0FuZFhSbU9DY3BPd29nSUgwcE93cDlDZ292THlEcXNKbnNuWUFnNjZ5NDZyV3M2Nlc4SU91cWh5RHJzb2pzcDdnZzY2eTc2NHFVN0tlQUlPcTRzT3lXdFNEaWdKUWc3SjZzN0pxVTdMS3Q3SjIwNjZtMElDTHNuYlRzb0lUcXM3d2c2NHVrNjZXNElPeURpQ0Rzb0p6c2xZZ2k3SjJFSU95YWxPcTFyTzJWbk91THBBb3ZMeUFvN0pXSUlPcTN1T3Vmck91cHRDRHRnYlRyb1p6cms1enFzSUFnN0lTeDdJdWs3WldZNnJLTUlPcXdtZXlkZ0NEcmk3WHNuWVFnNjVpUUlPdUN0T3lFbkNCYlFVa2c3TGFVN0xLY0lPdU5sQ0Ryc0p2cXVMQmQ2ckNBSU91c3RPeWRtT3V2dU8yVnRPeW5oT3VMcENrS1kyOXVjM1FnWVhOclpXUkRiM1Z1ZENBOUlHNWxkeUJOWVhBb0tUc0tDaTh2SU95RXVPeUZtQ0RzcElEcnVZUW83SXVjNjQrWksreW5nT3lMbk91c3VDRHNvN3pzbm9VcA0KNjZXOElPdXp0T3llcGUyVm5DRHJrcVFnN1pXY0lPMkV0Q0RzaTZUdGxva2c0b0NVSU91cXFPdVRvQ0R0bUxqc3RwenNuWUFnY1hWbGRXWHJvWndnN0tlQjY2Q3M3Wm1VTGdvdkx5QnRiMlJsYk95ZGhDRHNvN3pycWJRZzZyZTRJT3VxcU91TnVPdWhuQ0FvNjR1azY2VzA2Nm0wSU95RXVPeUZtQ0RzbnF6c2k1enNucEVwTGlEdGxad2c2NnFvNjQyNDdKMkVJT3F6aE95R2pTRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdKMkFJT3kxbk95MGlDQXg3WnFNNjcrUUxnb3ZMeUJ5WlhCaGNuTmxQWHR3WVhKelpTd2dabTl5YldGMFJHVnpZMzNycGJ3ZzdLTzg2Nm0wSU8yTWpPeUxzZXE1ak95bmdDRHNuYlFnN0o2aElPeVZpT3lYa095RW5DRHNzcGpycHF6dGxaanFzNkFnZTNKaGR5d2djR0Z5YzJWa2ZldWx2Q0RyajR6cm9LVHNwSURyaTZRNkNpOHZJTzJZbGV5TG5TRHNuYlR0ZzRnZzdJdWNJT3F3bWV5ZGdDRHNoTGpzaFpqc2w1QWdJdTJZbGV5TG5ldU1nT3VobkNEcmk2VHNpNXdpNjZXOElPeWFsT3Exck8yVm1PdUsNCmxDRHNucXpzbXBUc3NxMGc3WVMwN0oyRUlDb3E2ckNaN0oyQUlPMkJrQ0RzbnFFZzdKV0k3SmVRN0lTY0tpb2c2N2FaN0oyNDY0dWtMZ292THlEcnM0VHJqNFFnN0o2aDdKeTg2NkdjSU91NXZPdXB0Q0FvWVNrZzdJS3M3SjIwN0plUUlPdUxwT3VsdUNEc21wVHNzcTBnN1lTMDdKMjBJT3VCdk95V3RDQW42N0NwNnJpSUlPdUx0U2ZzbmJRZzY0S283SjJZSU91THRleWR0Q0Rya0pqcXM2QW82NEswN0pxcElPeVlwT3lYdkNrc0NpOHZJQ2hpS1NCTlFWaGZWRlZTVGxNZzZySzk2ck9FN0plUTdJU2NJT3lFdU95Rm1PeWR0Q0RzbnF6c2k1enNucEhyajd3Z0ordXdxZXE0aUNEcmk3VW43SjIwSU95WGh1dUtsQ0RzZzRnZzdJUzQ3SVdZN0oyMElPdUN0T3lhcWV5ZGhDRHNwNERzbHJUcmdyd2c3SWlZSU95ZWlPdUxwQ0FvTWpBeU5pMHdOeURycHF6cnQ3RHNsNURzaEp3ZzdabVY3SjI0S1M0S1kyOXVjM1FnVWtWUVFWSlRSVjlDUVVRZ1BTQW9kaWtnUFQ0Z2RpQTlQU0J1ZFd4c0lIeDhJQ2hCY25KaGVTNXBjMEZ5DQpjbUY1S0hZcElDWW1JSFl1YkdWdVozUm9JRDA5UFNBd0tUc0tablZ1WTNScGIyNGdjblZ1VkhWeWJpaGlkV2xzWkVGemF5d2diVzlrWld3c0lISmxjR0Z5YzJVcElIc0tJQ0JqYjI1emRDQnFiMklnUFNCeGRXVjFaUzUwYUdWdUtHRnplVzVqSUNncElEMCtJSHNLSUNBZ0lHTnZibk4wSUdwdllsTjBZWEowSUQwZ1JHRjBaUzV1YjNjb0tUc2dMeThnN0l1YzZyQ0VJT3lZaU95Q3NDRGlnSlFnN1pTTTY1K3M2cmU0N0oyNElPeXF2U0Rzb0p6dGxad29NVE13N0xTSUtleWRoQ0RyaEpqcXVMZ2c3SjZzN0l1YzY0K0U2NHFVSU8yUHJPcTRzTzJWbk91THBBb2dJQ0FnYVdZZ0tHMXZaR1ZzSUNZbUlFRk1URTlYUlVSZlRVOUVSVXhUTG1sdVpHVjRUMllvYlc5a1pXd3BJQ0U5UFNBdE1TQW1KaUJ0YjJSbGJDQWhQVDBnWTNWeWNtVnVkRTF2WkdWc0tTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RycXFqcmpiZ2c2N09BNnJLOU9pQW5JQ3NnWTNWeWNtVnVkRTF2WkdWc0lDc2dKeURpaHBJZw0KSnlBcklHMXZaR1ZzS1RzS0lDQWdJQ0FnWTNWeWNtVnVkRTF2WkdWc0lEMGdiVzlrWld3N0NpQWdJQ0FnSUhOMFlYSjBVSEp2WXlncE95QXZMeURzZzRnZzY2cW82NDI0NjZHY0lPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdUxwT3lkakNEc200enJzSTNzbDRYc2w1RHNoSndnN0tlQTdJdWM2Nnk0SU95ZXJPeWp2T3llaFNrS0lDQWdJSDBLSUNBZ0lHbG1JQ2gwZFhKdWN5QStQU0JOUVZoZlZGVlNUbE1nZkh3Z0lYQnliMk1wSUhOMFlYSjBVSEp2WXlncE93b2dJQ0FnYVdZZ0tDRjNZWEp0WldSVmNDa2dld29nSUNBZ0lDQmpiMjV6ZENCME1DQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQWdJR0YzWVdsMElITmxibVJVZFhKdUtHbHVjM1J5ZFdOMGFXOXVUV1Z6YzJGblpTZ3BLVHNLSUNBZ0lDQWdkMkZ5YldWa1ZYQWdQU0IwY25WbE93b2dJQ0FnSUNCMGRYSnVjeXNyT3dvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdJUzQ3SVdZSU95a2dPdTVoQ0RzbVlUcm80d2dLQ2NnS3lBb0tFUmgNCmRHVXVibTkzS0NrZ0xTQjBNQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwSUNzZ0ozTXBJT0tBbENEc25iVHRtNFFnN0pxVTdMS3Q3SjJBSU91NXFPdWR2T3lhbEM0bktUc0tJQ0FnSUgwS0lDQWdJSFIxY201ekt5czdDaUFnSUNCamIyNXpkQ0JoYzJzZ1BTQmlkV2xzWkVGemF5Z3BPeUF2THlEc25xenNpNXpyajRRZzY1V01JT3F3bWV5ZGdDRHNwNGpyckxqc25ZUWc2NHVrN0l1Y0lPeVR0T3VMcENBb1lYTnJaV1JEYjNWdWRDRHNuYlRzcEpFZzdLYWQ2ckNBSU91d3FleW5nQ2tLSUNBZ0lHeGxkQ0J5WVhjN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCeVlYY2dQU0JoZDJGcGRDQnpaVzVrVkhWeWJpaGhjMnNwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0F2THlEdGhMUWc2NCtFN0tTUklPMkJ0T3Vobk91VG5DRHRsSVRyb1p6c2hManNpcVRxc0lBZzdLTzk3SjJBSU9xeXZleWFzQ2hUUlZOVFNVOU9YMFJKUlVRcElESHRtb3dnN0o2UTY0K1pJT3llck95TG5PdVBoQ0RpZ0pRZzdJS3M3SnFwDQo3SjZRN0plUTZyS1FJT3lMcE8yTXFPdWhuQ0RzbFlnZzY3TzA3SjIwNnJLTUxnb2dJQ0FnSUNBdkx5RHNpNXpxc0lRZzdMU0k2ck84d3Jmcm9aenF0N2pzbmJnZzY2ZU02Nk9Nd3JmdGdiVHJvWnpyazV3ZzdKaWs2NldZd3Jmc25aanJqNFRzb0lFZzdLS0Y2Nk9NS09xemhPeWdsU0Rzb0lUdG1aZ3Y2NkdjNnJlNDdKV0U3SnVETENCcmFXeHNVSEp2WXloeVpXRnpiMjRwS2V1S2xBb2dJQ0FnSUNBdkx5RHNvSndnNjZtVTdJdWM3S2VBNnJDQUlPdVVzT3VobkNEc25vanNsclFnN0plczZyaXdJT3lWaUNEcXNianJwckRyaTZRdUlPeWloZXVqakNEc21wVHNzcTBnN0tTUjdKMjA2ckd3NjRLWUlPeUxuT3F3aENEc21JanNnckRzbmJRZzdKYTg2NmVJSU95VmlDRHJncWpzbFpqc25MenJxYlFnNjVDWTdJSzA2NmFzN0tlQUlPeVZpdXVLbE91THBDNEtJQ0FnSUNBZ2FXWWdLSE5vZFhSMGFXNW5SRzkzYmlCOGZDQWhLR1VnSmlZZ1pTNXRaWE56WVdkbElEMDlQU0JUUlZOVFNVOU9YMFJKUlVRcElIeDhJRVJoZEdVdQ0KYm05M0tDa2dMU0JxYjJKVGRHRnlkQ0ErSURRd01EQXdLU0IwYUhKdmR5QmxPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0lTNDdJV1k3SjIwSU8yRXRDRHJqNFRzcEpFZzY0R0s2cm1BSU9LQWxDRHNucXpzaTV6cmo1a2c3WnVFSURIdG1vd2c3SjZzN0l1YzY0K0U3WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdJQ0J6ZEdGeWRGQnliMk1vS1RzS0lDQWdJQ0FnWVhkaGFYUWdjMlZ1WkZSMWNtNG9hVzV6ZEhKMVkzUnBiMjVOWlhOellXZGxLQ2twT3dvZ0lDQWdJQ0IzWVhKdFpXUlZjQ0E5SUhSeWRXVTdDaUFnSUNBZ0lIUjFjbTV6SUQwZ01qc2dMeThnN0p1TTY3Q043SmVGSURFZ0t5RHNuYlRyc29nZzdZUzBJQ2h6ZEdGeWRGQnliMlBzbmJRZ01PeWN2T3VobkNEc3RJanF1TER0bVpRcENpQWdJQ0FnSUhKaGR5QTlJR0YzWVdsMElITmxibVJVZFhKdUtHRnpheWs3Q2lBZ0lDQjlDaUFnSUNCcFppQW9JWEpsY0dGeWMyVXBJSEpsZEhWeWJpQnlZWGM3Q2lBZ0lDQnNaWFFnY0dGeWMyVmsNCklEMGdjbVZ3WVhKelpTNXdZWEp6WlNoeVlYY3BPd29nSUNBZ0x5OGc3WmlWN0l1ZElPeWR0TzJEaU95ZHRPdXB0Q0Rxc0puc25ZQWc3SVM0N0lXWXdyZnFzSm5zbllBZzdKNmg3SmVRN0lTY0lPcXpwK3llcFNEc25xenNtcFRzc3EwZzRvQ1VJT3lkdENEdGhMVHNuYlFnN0tPOTdKeTg2Nm0wSU95RGlDRHNoTGpzaFpqc25ZQWdKK3V3cWVxNGlDRHJpN1VuN0oyRUlPdXFzT3VkdkFvZ0lDQWdMeThnN0tlQTdKYTA2NEs4SU95SW1DRHNub2pzbkx6cnI0RHJvWndnN0lTNDdJV1lJT3lDck91bm5TRHNucXpzaTV6cmo0VHJpcFFnN1pXWTdLZUFJT3lWaXVxem9DRHF0N2pyaklEcm9ad2c3SXVrN1l5bzdJdWM3WUtvNjR1a0tPMk1qT3lMc1NEc2k2VHRqS2pyb1p3ZzZyZUE2ckt3S1M0S0lDQWdJR2xtSUNoU1JWQkJVbE5GWDBKQlJDaHdZWEp6WldRcElDWW1JRVJoZEdVdWJtOTNLQ2tnTFNCcWIySlRkR0Z5ZENBOElEY3dNREF3S1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRqSXpzDQppN0VnN0l1azdZeW9JT0tBbENEdG1KWHNpNTBnN0o2czdKcVU3TEt0T2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJRE13TUNrcE93b2dJQ0FnSUNCMGRYSnVjeXNyT3dvZ0lDQWdJQ0IwY25rZ2V3b2dJQ0FnSUNBZ0lISmhkeUE5SUdGM1lXbDBJSE5sYm1SVWRYSnVLQ2Zyc0tucXVJZ2c2NHUxN0oyMElPeWFsT3Exck8yVm5DRHRtSlhzaTUzc2w1QWc3SmEwNnJpTDY0S3M2NHVrTGlEcnNLbnF1SWdnNjR1MTdaV2NJT3VDdE95YXFleWRoQ0RzaEtUcnFvWEN0K3lDck9xenZNSzM3TDJVNjVPYzdZNmM3SXFrSU95WGh1eWR0Q0RzbFlUcm5wZ2dTbE5QVHV5Y3ZPdWhuT3VuakNEcmk2VHNpNXdnN0xhYzY2Q2w3WldZNjUyOE9pQW5JQ3NnY21Wd1lYSnpaUzVtYjNKdFlYUkVaWE5qS1RzS0lDQWdJQ0FnSUNCd1lYSnpaV1FnUFNCeVpYQmhjbk5sTG5CaGNuTmxLSEpoZHlrN0NpQWdJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95ZXJPeWFsT3l5clNEc2k2VHRqS2dnNG9DVUlPeVZoT3VlbU95WA0Ka095RW5DRHRqSXpzaTdFZzdJdWs3WXlvNjZHY0lPeXltT3VtckNBcUx5QjlDaUFnSUNCOUNpQWdJQ0JwWmlBb1VrVlFRVkpUUlY5Q1FVUW9jR0Z5YzJWa0tTa2dZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTWpPeUxzU0RzaTZUdGpLZ2dLT3llck95YWxPeXlyU0R0bTRUc2w1RHJqNFFwT2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJRE13TUNrcE93b2dJQ0FnY21WMGRYSnVJSHNnY21GM0xDQndZWEp6WldRNklGSkZVRUZTVTBWZlFrRkVLSEJoY25ObFpDa2dQeUJ1ZFd4c0lEb2djR0Z5YzJWa0lIMDdDaUFnZlNrN0NpQWdMeThnN1pXY0lPeWFsT3l5cmV5ZHRDRHNpNlR0aktqdGxiVHJqNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzbmJUc2xyVHNwNERyajRUcm9aMGc3WUdRNjRxVUlPMlZyZXlEZ1NEc2hMSHFzN1hzbkx6cm9ad2c3S0NWNjZhc0NpQWdjWFZsZFdVZ1BTQnFiMkl1WTJGMFkyZ29LQ2tnUFQ0Z2UzMHBPd29nSUhKbGRIVnliaUJxYjJJN0NuMEtDaTh2SU91eWhPMksNCnZDRHJuYnpyc3FnZzZyZWM3TG1aSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZ0ordXloTzJLdk95ZGhDRHFzNmpybnBEcmk2UW42ck9nSU95VmpPdWdwT3lraENEcmxZenJwNHdnN0phNTY0cVU2NHVrTGdvdkx5RHJzb1R0aXJ3ZzY2eTQ2cldzNjRxVUlPdXN1T3llcGV5ZHRDRHNsWVRyaTRqcm5id2c2NCtaN0o2UklPeWR0T3VtaE95ZHRPeVd0T3lFbkN3ZzdKMjBJT3luZ095TG5PcXdnQ0RzbDRic25MenJxYlFnNjZ5NDdKNmw3WmlWSU91TWdPeVZpT3lkdENEc2hKN3NsNndnNjRLWTdKaW82NHVrTGdwamIyNXpkQ0JDVlZSVVQwNWZVbFZNUlNBOUNpQWdKK3lkdENEcnJManF0YXpyaXBRZ0tpcnJzb1R0aXJ3ZzY1Mjg2N0tvS2lyc25iVHJpNlF1SU91c3VPeWVwZXlkdENEc2xZVHJpNGpybmJ3ZzY0K1o3SjZSSU95ZHRPdW1oT3lkdE91dmdPdWhuRG9nNjZlSTdMbW83Wkdjd3JmcnJMenNuWXp0a1p6Q3QreWloZXF5c095V3RPdXZ1Q2grN0pxVUwzN3JpNlF2ZnVxNWpPeWFsQ2tnNnJpSTdLZUFMQ0FuDQpJQ3NLSUNBbjY1Q1k2NCtFNjZHZElPeW5wK3lkZ0NEcmo1bnNucEVnNjZxRjdJS3NLT3lnZ095ZXBjSzM3SUt0N0tDY3dyZnNsN0Rxc3JBZzdaVzA3S0NjSU91VHNTbnJvWndzSU8yR3RldXp0T3lFc1NEcmk2anNuYndnNjdLRTdZcTg3SjIwNjZtMElDTHRtWlhzbmJnaUxpQW5JQ3NLSUNBbkl1eTNxT3lHakNMcmlwUWc2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNSU95VHNPcXpvQ3dnN1ptVTY2bTBJT3E0c091S3BldXFoU2pyczREcXNyM0N0KzJWdE95Z25DRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWlRyaTZRdVhHNG5Pd29LTHk4ZzY2eTQ2cldzSU95MmxPeXluQ0R0aExRZ0tISnZiR1U5Sit1eWhPMkt2Q2ZzbmJUcnFiUWc2N0tFN1lxOElPcTNuT3k1bWV5ZGhDRHNscm5yaXBUcmk2UXBDbVoxYm1OMGFXOXVJR0Z6YTBOc1lYVmtaU2gwWlhoMExDQnRiMlJsYkN3Z2NtVndZWEp6WlN3Z2NtOXNaU2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZw0KSUdOdmJuTjBJR0YwZEdWdGNIUWdQU0FvWVhOclpXUkRiM1Z1ZEM1blpYUW9kR1Y0ZENrZ2ZId2dNQ2tnS3lBeE93b2dJQ0FnWVhOclpXUkRiM1Z1ZEM1elpYUW9kR1Y0ZEN3Z1lYUjBaVzF3ZENrN0NpQWdJQ0JwWmlBb1lYTnJaV1JEYjNWdWRDNXphWHBsSUQ0Z01qQXdLU0JoYzJ0bFpFTnZkVzUwTG1Oc1pXRnlLQ2s3SUM4dklPdXN0TzJWbk8yZWlDRHNqSlBzbmJUc3A0QWc3SldLNnJLTUNpQWdJQ0JqYjI1emRDQnlkV3hsSUQwZ2NtOXNaU0E5UFQwZ0ordXloTzJLdkNjZ1B5QkNWVlJVVDA1ZlVsVk1SU0E2SUNjbk93b2dJQ0FnY21WMGRYSnVJSEoxYkdVZ0t5QW9ZWFIwWlcxd2RDQStJREVLSUNBZ0lDQWdQeUFuNnJDWjdKMkFJT3VzdU9xMXJPdWx2Q0RyaTZUc2k1d2c3SnFVN0xLdDdaV2M2NHVrTGlEc25iUWc3SVM0N0lXWTdKZVE3SVNjSU95ZHRPeWdoT3lYa0NEc29KenNsWWp0bG9qcmpaZ2c2cktENjVPazZyTzhJT3F5dWV5NW1PeW5nQ0RzbFlycmlwUXNJT3Exck95aHNPdUNtQ0RzbHJUdG5KanENCnNJQWc3Wm1WN0l1azdaNklJT3VMcE91bHVDRHNnNGpyb1p6c21yUWc2NHlBN0pXSUlEUHFzSnpycGJ3ZzZyZWM3TG1aNjR5QTY2R2NJRXBUVDA0ZzY3Q3c3SmUwNjZHYzY2ZU1PaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvZEdWNGRDa0tJQ0FnSUNBZ09pQW42NHVrN0oyTUlGVkpJT3VzdU9xMXJPeWRtQ0RyaklEc2xZZ2dNK3F3bk91bHZDRHF0NXpzdVpucmpJRHJvWndnU2xOUFRpRHJzTERzbDdUcm9aenJwNHc2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLU2s3Q2lBZ2ZTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93cDlDZ292THlEcnNvanNsNjBnN1lTMElPS0FsQ0Rxc0puc25ZQWc3SVM0N0lXWTdKMkVJT3lUc091UW1Dd2c3SjIwNjdLSUlPMkV0T3VuakNEc3RwVHNzcHdnN1ppVjdJdWRLRXBUVDA0ZzY3Q3c3SmUwS1NEcmpJRHNpNkFnNjdLSTdKZXRJTzJZbGV5TG5TaEtVMDlPSU9xd25leXl0Q25zbllRZzdKcVU2cldzN1pXYzY0dWtDbVoxYm1OMGFXOXVJR0Z6YTFSeVlXNXpiR0YwDQpaU2gwWlhoMExDQnRiMlJsYkN3Z2NtVndZWEp6WlNrZ2V3b2dJSEpsZEhWeWJpQnlkVzVVZFhKdUtDZ3BJRDArSUNnS0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJT3V5aU95WHJTRHNucEhzbDRYc25iVHJpNlFnS091c3VPcTFyQ0RyaTZUcms2enF1TEFnN0pXRTY0dVlJT0tBbENEcmpJRHNsWWdnTStxd25DRHF0NXpzdVpuc25ZQWc3SjIwNjdLSUlPMkV0T3lYa0NEc29JSHNtcW50bFpqc3A0QWc3SldLNjRxVTY0dWtLUzRnSnlBckNpQWdJQ0FuNjR1azdKMk1JRlZKSU91c3VPcTFyT3F3Z0NEdGxaenF0YTNzbHJUcnFiUWc3SjZRN0pldzdJcWs2NStzN0pxMElPeVlnZXlXdE91aG5Dd2c3SmlCN0phMDY2bTBJT3lla095WHNPeUtwT3Vmck95YXRDRHRsWnpxdGEzc2xyVHJvWndnNjdLSTdKZXQ3WldZNjUyOExpQW5JQ3NLSUNBZ0lDZFZTU0RyckxqcXRhenJpNlRzbXJRZzZyQ0U2ckt3N1pXY0lPMlJuTzJZaE95ZGhDRHNrN0RxczZBc0lPeWR0T3VtaE1LMzdJaXI3SjZRd3JmcnA0anNpcVR0Z3JuQw0KdCsyVWpPdWdpT3lkdE95S3BPMlpnT3VObE91S2xDRHF0N2pyaklEcm9ad2c2N08wN0tHMDdaV2M2NHVrTGlBbklDc0tJQ0FnSUNmc201RHJyTGpzblpnZzdLU0VJT3lJbU91bHZDRHF0N2pyaklEcm9ad2c3SnlnN0tlQTdaV2M2NHVrSU9LQWxDRHNtNURyckxqc25iUWc3WldjSU95a2hPeWR0T3VwdENEcnNvanNsNjNyajRRZzdaV2NJT3lraE91aG5Dd2c3S1NFNjdDVTZyK0k3SjJFSU95ZWhPeWRtT3VobkNEc3RwVHFzSUR0bFpqc3A0QWc3SldLNjRxVTY0dWtMaUFuSUNzS0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzZyQ2Q3TEswSU8yVm1PdUNtT3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUxwT3lhdE1LMzdJU2s2NnFGSU9xNGlPeW5nRG9nSnlBckNpQWdJQ0FuZXlKMGNtRnVjMnhoZEdWa0lqb2dJdXV5aU95WHJldXN1Q0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpTENBaVpHbHlaV04wYVc5dUlqb2dJbXR2NG9hU1pXNGc2NWlRNjRxVUlHVnU0b2FTYTI4aWZUb2cNCkp5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwQ2lBZ0tTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93cDlDZ292THlEcmpJRHRtWlR0bUpVZzY2eTQ2cldzSU95Z25PeWVrU0R0aExRZzRvQ1VJT3lDck95YXFleWVrT3F3Z0NEc2c0SHRtYW5zbllRZzdJU2s2NnFGN1pXWTY2bTBJT3VucGV1ZHZleVhrQ0RycDU3cmlwUWc2Nnk0NnJXczY2VzhJT3Vuak91VHBPeVd0T3lrZ091THBDNEtMeThnYldWemMyRm5aWE02SUZ0N2NtOXNaVG9uZFhObGNpZDhKMkZ6YzJsemRHRnVkQ2NzSUhSbGVIUjlYU0Rzb0lUc3NyUWc2NHlBN1ptVTY2VzhJT3VucE91eWlDRHJzSnZyaXBUcmk2UW82NHVrNjZhczY0cVVJT3VzdE95RGdlMkRuQ0RpZ0pRS0x5OGc3SnVNNjdDTjdKZUZJT3luZ095TG5PdXN1T3lkbUNBaTdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElBaUlPeWdoT3lnbk91bHZDRHNwNER0Z3FUcXVMQWc3SnlFN1pXMElPdU1nTzJabENEcnA2WHJuYjNzbllRZzdZUzBJT3lWaU95WGtDRHJxcjNyDQpsWVVnN0l1ajY0cVU2NHVrS1M0S1puVnVZM1JwYjI0Z1lYTnJRMjl0Y0c5elpTaHRaWE56WVdkbGN5d2diVzlrWld3c0lISmxjR0Z5YzJVcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0NpQWdJQ0JqYjI1emRDQjBjbUZ1YzJOeWFYQjBJRDBnS0cxbGMzTmhaMlZ6SUh4OElGdGRLUzV0WVhBb0tHMHBJRDArQ2lBZ0lDQWdJQ2h0TG5KdmJHVWdQVDA5SUNkaGMzTnBjM1JoYm5RbklEOGdKK3lXdE95TG5PeUtwTzJFdE8yS3VEb2dKeUE2SUNmc2dxenNtcW5zbnBBNklDY3BJQ3NnVTNSeWFXNW5LRzB1ZEdWNGRDQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z01UVXdNQ2tLSUNBZ0lDa3VhbTlwYmlnblhHNG5LVHNLSUNBZ0lISmxkSFZ5YmlBb0NpQWdJQ0FnSUNmc25iVHJzb2dnN0pxVTdMS3Q3SjJBSUNMcmpJRHRtWlR0bUpVZzY2eTQ2cldzSU95Z25PeWVrU0xzbmJUcmk2UWdLT3E0c095aHRDRHJyTGpxdGF3ZzY0dWs2NU9zNnJpd0lPeVZoT3VMbUNEaWdKUWc3SldFNjU2WUlPdU1nTzJabE9xdw0KZ0NEc25iVHJzb2dnN1lTMDdKMllJT3lnaE95eXRDRHJwNlhybmIzc25iVHJpNlFwTGlBbklDc0tJQ0FnSUNBZ0oreUNyT3lhcWV5ZWtPcXdnQ0R0bVpUcnFiUWc3SU9CN1ptcHdyZnJwNlhybmIzc25ZUWc3SVNrNjZxRjdaV1k2Nm0wTENEc2lxVHRnNERzbmJ3ZzZyZWM3TG1aNnJPOElPeVlpT3lMbkNEdGhxVHNsNUFnNjZlZTY0cVVJRlZKSU91c3VPcTFyT3VsdkNEcnA0enJrNlRzbHJRZzdLQ2M3SldJN1pXWTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPdW5wZXVkdmV5ZHRDRHJ0b0Rzb2JIdGxaanJxYlFnN1k2NDdaV1k2cktNSU91UW1PdXN2T3lXdE91ZHZEb2c3SmEwNjVha0lPMlpsT3VwdE1LMzZyaXc2NHFsN0oyWUlPdXN1T3Exck95ZHVPeW5nQ3dnNjVPazdKYTA2ckNJSU95ZWtPdW1yT3VLbENEc2xyVHJsSlRzbmJqc3A0QW83WXlkN0plRklPMkRnT3lkdE8yTGdDL3JzN2pyckxndjY3S0U3WXE4TENEdGhxRHNpcVR0aXJnc0lPdTVpQ0R0bVpUcnFiUWc3SldJNjRLMExDRHJzTERyaElnZzY1T3gNCktTd2c3SmEwNjVha0lPeURnZTJacWV5ZHVPeW5nQ2pzaExIcXM3VWc3WWExNjdPMEwreVlwT3VsbUMvdG1aWHNuYmdnN0pxVTdMS3RMK3lWaU91Q3RDa2c2ckNaN0oyQUlPcXlneTRnNnJ5dElPMlZoT3lhbE8yVm5DRHFzb1BycDR3ZzZyT282NTI4SU8yVm5DRHJzb2pzbDVBZzdMV2M2NHlBSURMcXNKenF1WXpzcDRBc0lPeW5wK3F5akM0ZzdKMjA2NVdNSUhOMVoyZGxjM1JwYjI1ejY0cVVJT3U1aUNEcnNMRHNsN1F1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2ckNRN0oyMElPeVd0T3VLa0NEc29KWHJqNFFnN0ppazY2bTBJT3VzdStxNHNPdW5qQ0R0bFpqc3A0QWc2NmVJNjUyOElPS0FsQ0Rxc0lEc29KWHNuWVFnN0lTNDdKcXc2ck9nSU95MGlPeVZpQ0J6ZFdkblpYTjBhVzl1Yyt1bHZDRHRsYWpxdTVnZzY0SzA2Nm0wN0lTY0xDQnlaWEJzZWV5WGtDRHFzSURzb0pYc25ZUWc2N0NkN1o2STZyT2dJT3VzdE95WGgreWRoQ0RzbFl6cm9LVHNvN3pycWJRZzY0MlVJT3VubnV5Mm5DRHNpSmdnN0o2STY0cVU3S2VBDQpJTzJWbkNEcnJManNucVhzbkx6cm9ad2c2NDJuNjdhWjdKZXM2NTI4S095WWlEb2dJdTJabGV5ZHVDRHRqSjNzbDRYc25iVHJuYnpxczZBZzZyQ0E3S0NWN1phSTdKYTA3SnFVSU9LQWxDRHRocURzaXFUdGlyanJuYnpycWJRZzdKV002NkNrN0tPODdJUzQ3SnFVSWlrdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnNjZ5NDZyV3M2Nlc4SU95Z25PeVZpTzJWb0NEcmxaQWc3SVNjNjZHY0lPeWdrZXEzdk95ZHRDRHJpNlRycGJnZ01uNHo2ckNjTGlEcXNJRWc3S0NjN0pXSTdKZVVJT3labkNEcXQ3anJvSWZxc293ZzdJMjg2NHFVN0tlQUlPeWR0T3ljb091bHZDRHJ0cG5zbmJqcmk2UXVYRzRuSUNzS0lDQWdJQ0FnSnkwZzdJS3M3SnFwN0o2UTZyQ0FJT3lXdU9xNGllMlZtT3luZ0NEc2xZcnNuWUFnNnJXczdMSzBJT3lnbGV1enRDanNvSVR0bVpUcnNvanRtTGpDdDFWU1RNSzM2cmlJN0pXaHdyZnRtcC9zaUpnZzY1T3hLZXVsdkNEc3A0RHNsclRyZ3JRZzY0U2o3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbg0KTFNEdG00VHNobzBnN0pxVTdMS3RLQ0xyalpRZzdLZW42cktNSWl3Z0l1dXloTzJLdk95YXFleWN2T3VobkNJZzY1T3hLZXlkdE91cHRDRHNwNEhzb0lRZzdLQ2M3SldJN0oyRUlPcTN1Q0Ryc0tudGxxWHNuTHpyb1p3ZzZyT2c3TE9RSU91THBPeUxuQ0Rzb0p6c2xZanRsWmpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1VnNnJpSTdLZUFPaUFuSUNzS0lDQWdJQ0FnSjNzaWNtVndiSGtpT2lBaTY0eUE3Wm1VSU95ZGtldUx0U0R0bFp6cmtaQWc2Nnk0N0o2bElDanRsYlRzbXBUc3NyUXBJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FnN1pXY0lPdXN1T3llcFNKOVhYMWNibHh1SnlBckNpQWdJQ0FnSUNkYjY0eUENCjdabVVYVnh1SnlBcklIUnlZVzV6WTNKcGNIUUtJQ0FnSUNrN0NpQWdmU3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBPd3A5Q2dvdkx5RHRsSVRyb0lqc25vVHJzNFFvN1pXWTdKeUVJTzJVaE91Z2lPeWVoQ0Ryckxic25Zd3BJT3kybE95eW5DRHRoTFFnNG9DVUlPMlZuQ0R0bVpUcnFiVHNuWVFnN1pXWTdKeUVJTzJVaE91Z2lPeWVoQ0RyaTZqc25JVHJvWndnNjRLWTY0aWdJT3V6dE91Q3RPcXpvQ3dLTHk4Z0tpcnRsSVRyb0lqc25vVHJwNGpyaTZRZzY1U3c2NkdjS2lvZzY0eUE3SldJN0oyRUlPdXdtK3VLbE91THBDNGc3WldjSU95YWxPeXlyZXlYa0NEcmk2UWc3SXVrN0phMElPdXp0T3VDdE91S2xDRHFzb1BzbmJRZzdaVzE3SXVzT2dvdkx5RHRsSVRyb0lqc25vUWc3SWlZNjZlTTdZRzhJT3lhbE95eXJleWRoQ0RzcXJ6cXNKenJxYlFnNnJlNDY2ZU03WUc4SU91S2tPdWdwT3luZ09xem9DanFzSUVnTlg0eE1PeTBpQ2tnNnJXczY0K0ZJT3lDck95YXFldWZpZXVQaENEcXQ3anJwNHp0Z2J3ZzY0S1k2ckNFDQo2NHVrTGdvdkx5Qm5jbTkxY0hNNklGdDdibUZ0WlN3Z2RHVjRkSE02VzExOVhTQW83Wm1VNjZtMElPeWNoT0tHa3V5VmhPdWVtQ0RzaUp3cExncG1kVzVqZEdsdmJpQmhjMnRIY205MWNITW9aM0p2ZFhCekxDQnRiMlJsYkN3Z2NtVndZWEp6WlN3Z2JXOXlaU2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lDOHZJT3V5aE8yS3ZDRHNtSUhzbDYzc25ZQWdLT3V5aE8yS3ZDbnNuTHpyb1p3ZzdMQ043SmEwSU91enRPdUN1T3VMcENEaWdKUWc2N0tFN1lxOElPdXN1T3Exck91S2xDRHJyTGpzbnFYc25iUWc3SldFNjR1STY1MjhJT3VQbWV5ZWtTRHNuYlRycG9Uc25iVHJuYndnNnJlYzdMbVo3SjIwSU91THBPdWx0T3VMcEFvZ0lDQWdZMjl1YzNRZ2JHbHpkQ0E5SUNobmNtOTFjSE1nZkh3Z1cxMHBMbTFoY0Nnb1p5d2dhU2tnUFQ0S0lDQWdJQ0FnSjFzbklDc2dLR2tnS3lBeEtTQXJJQ2RkSUNjZ0t5QlRkSEpwYm1jb0tHY2dKaVlnWnk1dVlXMWxLU0I4ZkNBb0orcTN1T3VqdVNjZw0KS3lBb2FTQXJJREVwS1NrZ0t5QW9aeUFtSmlCbkxuSnZiR1VnUFQwOUlDZnJzb1R0aXJ3bklEOGdKeUFvNjdLRTdZcThLU2NnT2lBbkp5a2dLeUFuWEc0bklDc0tJQ0FnSUNBZ0tHY2dKaVlnUVhKeVlYa3VhWE5CY25KaGVTaG5MblJsZUhSektTQS9JR2N1ZEdWNGRITWdPaUJiWFNrdWJXRndLQ2gwS1NBOVBpQW5JQ0F0SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoVGRISnBibWNvZENCOGZDQW5KeWtwS1M1cWIybHVLQ2RjYmljcENpQWdJQ0FwTG1wdmFXNG9KMXh1SnlrN0NpQWdJQ0JqYjI1emRDQm9ZWE5DZEc0Z1BTQW9aM0p2ZFhCeklIeDhJRnRkS1M1emIyMWxLQ2huS1NBOVBpQm5JQ1ltSUdjdWNtOXNaU0E5UFQwZ0ordXloTzJLdkNjcE93b2dJQ0FnWTI5dWMzUWdhMlY1SUQwZ0oyZHliM1Z3Y3ljZ0t5QW9aM0p2ZFhCeklIeDhJRnRkS1M1dFlYQW9LR2NwSUQwK0lDaG5JQ1ltSUdjdWRHVjRkSE1nUHlCbkxuUmxlSFJ6TG1wdmFXNG9KeWNwSURvZ0p5Y3BLUzVxYjJsdUtDY25LVHNLSUNBZ0lHTnYNCmJuTjBJR0YwZEdWdGNIUWdQU0FvWVhOclpXUkRiM1Z1ZEM1blpYUW9hMlY1S1NCOGZDQXdLU0FySURFN0NpQWdJQ0JoYzJ0bFpFTnZkVzUwTG5ObGRDaHJaWGtzSUdGMGRHVnRjSFFwT3dvZ0lDQWdhV1lnS0dGemEyVmtRMjkxYm5RdWMybDZaU0ErSURJd01Da2dZWE5yWldSRGIzVnVkQzVqYkdWaGNpZ3BPd29nSUNBZ1kyOXVjM1FnWVdkaGFXNGdQU0J0YjNKbElIeDhJR0YwZEdWdGNIUWdQaUF4Q2lBZ0lDQWdJRDhnSit5ZHRDRHRtWlRycWJUc25ZQWc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRycjdnZzY0dWs2NlNZNjR1a0xpRHNsWjdzaEp3ZzY0SzRJT3VNZ095VmlPcXp2Q0RzbHJUdG5KakN0K3Exck95aHNPcXdnQ0R0bVpYc2k2VHRub2dnNjR1azY2VzRJT3lEaUNEcmpJRHNsWWpycDR3ZzY0SzA2NTI4TGx4dUp3b2dJQ0FnSUNBNklDY25Pd29nSUNBZ2NtVjBkWEp1SUNnS0lDQWdJQ0FnWVdkaGFXNGdLd29nSUNBZ0lDQW43SjIwNjdLSUlPeWFsT3l5cmV5ZGdDQWk3Wm1VNjZtMDdKMkVJTzJWDQptT3ljaENEdGxJVHJvSWpzbm9UcnM0VHJvWndnNjRLWTY0aWdJT3VMcE91VHJPcTRzQ0xyaTZRdUlPeVZoT3VlbU91S2xDRHRsWndnN1ptVTY2bTA3SjJZSU91c3VPcTFyT3VsdkNEdGxaanNuSVFnN1pTRTY2Q0k3SjZFS095WWdleVhyU2tnNjR1bzdKeUU2NkdjSU91c3R1eWRnQ0Rxc29Qc25iVHJpNlF1WEc0bklDc0tJQ0FnSUNBZ0p5b3E3SmlCN0pldDY2ZUk2NHVrSU91VXNPdWhuQ29xSU91TWdPeVZpT3lkaENEcmdyVHJuYndnNG9DVUlPeVlnZXlYcmV5ZGhDRHNoSnpyb1p3ZzdaV3A3TG1ZNnJHdzY0S1lJT3lJbk95RW5PdWx2Q0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPcXdnU0RzbUlIc2w2M3NsNUFnNjR5QTdKV0lJRExxc0p3dUlPcTN1Q0RzbUlIc2w2M3NuYlFnN0plczY1K3NJT3lraE95ZHRPdXB0Q0RyaklEc2xZanJqNFFnS2lycXNKbnNuWUFnN0tTRUlPeUltQ29xNjZHY0tPeWtoT3V3bE9xL2lDQmNYRzdzbkx6cm9ad2c2cldzNjdhRUxDRHNwSVFnN0lpYw0KN0lTY0lPeWNvT3luZ0NrdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN0ppQjdKZXQ3SjJZSU95WHJlMlZvQ2p0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcThJT3VUc1NucXM3d2c3SnVRNjZ5NDdKMllJT3lnbGV1enRNSzM3S0d3NnJHMEtPeUlxK3lla01LMzY0eUE3SU9Cd3Jmc29iRHFzYlFwN0oyQUlPeWNvT3luZ08yVm1PcXpvQ3dnN0plRzY0cVVJT3lnbGV1enRPdWx2Q0RzcDREc2xyVHJnclRzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3F6b095NW9DRHFzb3dnN0plRzY0cVVJT3lZZ2V5WHJleWR0T3VwdENEcmpJRHNsWWdnTWVxd25PdW5qQ0RyZ3JUcXNiRHJncGdnNjdtSUlPdXdzT3lYdE91aG5DRHJrWkRzbHJUcmo0UWc2NUNjNjR1a0lPS0FsQ0RzbHJYc3A0RHJvWndnNjdDVTZyNjQ3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHRtWlRycWJRZzZyaXc2NHFsNjZxRktPdXpnT3F5dmNLMzdaVzA3S0NjSU91VHNTbnNuWUFnNnJlNDY0eUE2NkdjSU91UmxPdUwNCnBDNWNiaWNnS3dvZ0lDQWdJQ0FvYUdGelFuUnVJRDhnSnkwZ0tPdXloTzJLdkNuc25MenJvWndnN1pHYzdJdWM2NUNjSU95WWdleVhyZXlkZ0NBbklDc2dRbFZVVkU5T1gxSlZURVVnT2lBbkp5a2dLd29nSUNBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU9xd25leXl0Q0R0bFpqcmdwanJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoY0szN0wyVTY1T2M3WTZjN0lxa0lPcTRpT3luZ0RwY2JpY2dLd29nSUNBZ0lDQW5leUpuY205MWNITWlPaUJiZXlKdVlXMWxJam9nSXV5WWdleVhyU0RzbmJUcnBvUW83SjZGNjZDbDZyTzhJT3VQbWV5ZHZDa2lMQ0FpYzNWbloyVnpkR2x2Ym5NaU9pQmJleUowWlhoMElqb2dJdXVNZ095VmlDRHJyTGpxdGF3Z0tPeWtoT3V3bE9xL2lPeWRnQ0JjWEc0cElpd2dJbkpsWVhOdmJpSTZJQ0xzbmJUc25LQWc3WldjSU91c3VPeWVwU0o5WFgxZGZWeHVKeUFyQ2lBZ0lDQWdJQ2ZzbUlIc2w2M3NuWUFnN0o2RjY2Q2xJT3lJDQpuT3lFbk1LMzZyQ2M3SWlZNjZXOElPcTN1T3VNZ091aG5DRHNwNER0Z3Fqcmk2UXVYRzVjYmljZ0t3b2dJQ0FnSUNBblcreVlnZXlYcmV1emhDRHJyTGpxdGF4ZFhHNG5JQ3NnYkdsemRBb2dJQ0FnS1RzS0lDQjlMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdDbjBLQ2k4dklPMlVoT3VnaU95ZWhPdXpoQ0RzdHBUc3Nwd2c3SjJSNjR1MTdKZVE3SVNjSUZ0N2JtRnRaU3dnYzNWbloyVnpkR2x2Ym5NNlczdDBaWGgwTENCeVpXRnpiMjU5WFgxZElPeTJsT3kybkFwbWRXNWpkR2x2YmlCd1lYSnpaVWR5YjNWd2N5aHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUc4Zw0KUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ1kyOXVjM1FnWVhKeUlEMGdRWEp5WVhrdWFYTkJjbkpoZVNodklDWW1JRzh1WjNKdmRYQnpLU0EvSUc4dVozSnZkWEJ6SURvZ1cxMDdDaUFnSUNCamIyNXpkQ0JuY205MWNITWdQU0JoY25JdWJXRndLQ2huS1NBOVBpQW9ld29nSUNBZ0lDQnVZVzFsT2lCVGRISnBibWNvS0djZ0ppWWdaeTV1WVcxbEtTQjhmQ0FuSnlrdWRISnBiU2dwTEFvZ0lDQWdJQ0J6ZFdkblpYTjBhVzl1Y3pvZ1FYSnlZWGt1YVhOQmNuSmhlU2huSUNZbUlHY3VjM1ZuWjJWemRHbHZibk1wQ2lBZ0lDQWdJQ0FnUHlCbkxuTjFaMmRsYzNScGIyNXpDaUFnSUNBZ0lDQWdJQ0FnSUM1dFlYQW9LSGdwSUQwK0lDaDBlWEJsYjJZZ2VDQTlQVDBnSjNOMGNtbHVaeWNLSUNBZ0lDQWdJQ0FnSUNBZ0lDQS9JSHNnZEdWNGREb2dlQzUwY21sdEtDa3NJSEpsWVhOdmJqb2dKeWNnZlFvZ0lDQWdJQ0FnSUNBZ0lDQWdJRG9nZXlCMFpYaDBPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNTBaWGgwS1NCOGZDQW4NCkp5a3VkSEpwYlNncExDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tLSUNBZ0lDQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb2VDa2dQVDRnZUM1MFpYaDBLUW9nSUNBZ0lDQWdJRG9nVzEwc0NpQWdJQ0I5S1NrN0NpQWdJQ0F2THlEc25iVHJwb1Rzb2JEc3NLZ2c3SmVHNnJPZ0lPeWduT3lWaU91UGhDRHNsNGJyaXBRZzZydU42NDJ3NnJpdzY2ZU1JT3labE95Y3ZPdXB0Q0R0bUpYc2k1MGc3SjIwN1lPSTY2R2NJT3V6dU91THBDanFzSm5zbllBZzdJUzQ3SVdZN0plUUlPeWVyT3lhbE95eXJTa0tJQ0FnSUhKbGRIVnliaUJuY205MWNITXVjMjl0WlNnb1p5a2dQVDRnWnk1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElEOGdaM0p2ZFhCeklEb2diblZzYkRzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXdvZ0lDQWdjbVYwZFhKdUlHNTFiR3c3Q2lBZ2ZRcDlDZ292THlEdGpKM3NsNFVnN0lTNDdZcTRJT3kybE95eW5DRHRoTFFnNG9DVUlPMlZuQ0R0DQpqSjNzbDRYc25aZ2c2cldzN0lTeDdKcVU3SWFNS095WHJlMlZvQ3ZyckxqcXRhd3A2Nlc4SU8yVm5DRHJzb2pzbDVBZzY3TzA2NEswNnJPZ0xBb3ZMeURzbXBUc2hvenJzNFFnNjRLeDZyQ2M2ckNBSU95VmhPdUxpT3VkdkNBcUt1eVpoT3lFc2V1UW5DRHRqSjNzbDRVZzdJUzQ3WXE0S095OGdPeWR0T3lLcENrZ01uNHo2ckNjS2lycnBid2c3WWExN0p5ODY2R2NJT3V3bSt1S2xPdUxwQzRLTHk4ZzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdk95ZHRDRHRsWndnNjZxNDdKeTg2NkdjSU95ZHZPcTBnT3VQdk95VnZDRHRsWmpycjREcm9ad282NVN3NjZHY0lPdTlrZXlWaENEc29iRHRsYW50bFpqcnFiUWc3SmEwNnJpTDY0S2M2NHVrS1NEc2hManRpcmdnNjR1bzdKeUU2NkdjSU95Z25PeVZpTzJWbU9xeWpDRHRsWnpyaTZRdUNpOHZJR1ZzWlcxbGJuUnpPaUJiZTNKdmJHVXNJSFJsZUhSOVhTQW83Wm1VNjZtMElPeWNoT0tHa3V5VmhPdWVtQ0RzaUp3cExnb3ZMeUJ0YjNKbFBYUnlkV1VvVyt5OA0KZ095ZHRPeUtwQ0RyalpRZzY3Q2I2cml3WFNucnFiUWc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRycjdnZzY0SzRJT3lFdU8yS3VPeVpnQ0Rxc3Juc3VaanNwNEFnN0pXSzY0cVVJT3lEaUNEc2hManRpcmpycGJ3ZzdKcVU2cldzN1pXYzY0dWtMZ3BtZFc1amRHbHZiaUJoYzJ0UWIzQjFjQ2hsYkdWdFpXNTBjeXdnYlc5a1pXd3NJSEpsY0dGeWMyVXNJRzF2Y21VcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0NpQWdJQ0JqYjI1emRDQnliMnhsY3lBOUlDaGxiR1Z0Wlc1MGN5QjhmQ0JiWFNrdWJXRndLQ2hsS1NBOVBpQlRkSEpwYm1jb0tHVWdKaVlnWlM1eWIyeGxLU0I4ZkNBbkp5a3BMbXB2YVc0b0p5d2dKeWs3Q2lBZ0lDQmpiMjV6ZENCc2FYTjBJRDBnS0dWc1pXMWxiblJ6SUh4OElGdGRLUzV0WVhBb0tHVXNJR2twSUQwK0NpQWdJQ0FnSUNocElDc2dNU2tnS3lBbkxpQmJKeUFySUZOMGNtbHVaeWdvWlNBbUppQmxMbkp2YkdVcElIeDhJQ2NuS1NBcklDZGRJQ2NnS3lCS1UwOU8NCkxuTjBjbWx1WjJsbWVTaFRkSEpwYm1jb0tHVWdKaVlnWlM1MFpYaDBLU0I4ZkNBbkp5a3BDaUFnSUNBcExtcHZhVzRvSjF4dUp5azdDaUFnSUNBdkx5RHFzSm5zbllBZzdZeWQ3SmVGN0oyRUlPdXFoeURyc29qc3A3Z2c2Nnk3NjRxVTdLZUFJT3E0c095V3RTRGlnSlFnN0o2czdKcVU3TEt0N0oyMDY2bTBJQ0xzbmJUc29JVHFzN3dnNjR1azY2VzRJT3lFdU8yS3VDTHJwYndnN0pxVTZyV3M3WldjNjR1a0NpQWdJQ0F2THlBb1lYTnJRMnhoZFdSbDdKbUFJT3F3bWV5ZGdDRHNuYlRzbktBNklPeVZpQ0RxdDdqcm42enJxYlFnN1lHMDY2R2M2NU9jNnJDQUlPcXdtZXlkZ0NEc2hManRpcmpycGJ3ZzY1aVFJT3VDdE95RW5DQmI3THlBN0oyMDdJcWtJT3VObENEcnNKdnF1TEJkNnJDQUlPdXN0T3lkbU91dnVPMlZ0T3luaE91THBDa0tJQ0FnSUdOdmJuTjBJR3RsZVNBOUlDZHdiM0IxY0FFbklDc2dLR1ZzWlcxbGJuUnpJSHg4SUZ0ZEtTNXRZWEFvS0dVcElEMCtJRk4wY21sdVp5Z29aU0FtSmlCbExuUmxlSFFwDQpJSHg4SUNjbktTa3VhbTlwYmlnbkFTY3BPd29nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2hyWlhrcElIeDhJREFwSUNzZ01Uc0tJQ0FnSUdGemEyVmtRMjkxYm5RdWMyVjBLR3RsZVN3Z1lYUjBaVzF3ZENrN0NpQWdJQ0JwWmlBb1lYTnJaV1JEYjNWdWRDNXphWHBsSUQ0Z01qQXdLU0JoYzJ0bFpFTnZkVzUwTG1Oc1pXRnlLQ2s3SUM4dklPdXN0TzJWbk8yZWlDRHNqSlBzbmJUc3A0QWc3SldLNnJLTUNpQWdJQ0JqYjI1emRDQmhaMkZwYmlBOUlHMXZjbVVnZkh3Z1lYUjBaVzF3ZENBK0lERUtJQ0FnSUNBZ1B5QW43SjIwSU8yTW5leVhoZXlkZ0NEc25iUWc3SVM0N0lXWTdKZVE3SVNjSU95ZHRPdXZ1Q0RyaTZUcnBKanJpNlF1SU95Vm51eUVuQ0Rzb0p6c2xZanRsWndnN0lTNDdZcTQ2NU9rNnJPOElDb3E3S0NSNnJlOHdyZnNsclR0bkpqcXNJQWc3Wm1WN0l1azdaNklJT3VMcE91bHVDRHNnNGdnN0lTNDdZcTRLaXJycDR3ZzY0SzA2NTI4S09xd21leWRnQ0RzaExqdA0KaXJnZzY3Q1k2N08xSU9xNGlPeW5nQ2t1WEc0bkNpQWdJQ0FnSURvZ0p5YzdDaUFnSUNCeVpYUjFjbTRnS0FvZ0lDQWdJQ0JoWjJGcGJpQXJDaUFnSUNBZ0lDZnNuYlRyc29nZzdKcVU3TEt0N0oyQUlDTHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1NEc2hManRpcmdnNjR1azY1T3M2cml3SXV1THBDNGc3SldFNjU2WTY0cVVJTzJWbkNEdGpKM3NsNFhzbllRZzdKeUU0b2FTN0pXRTY1Nlk2NkdjSU91Q21PeVh0TzJWbkNEcXRhenNoTEhzbXBUc2hvenJrNlRzbmJUcmk2UW83SVNjNjZHY0lPdXN0T3EwZ08yVm5DRHJzNFRxc0p3ZzY2eTQ2cldzNnJDQUlPeVZoT3VMaU91THBDa3VJQ2NnS3dvZ0lDQWdJQ0FuN0pxVTdJYU02Nlc4SU91Q3NlcXduT3VobkNEcXM2RHN1WmpzcDRBZzY2ZVE2ck9nTENBcUt1MkRnT3lkdE8yTGdNSzM3SldJNjRLMHdyZnJzb1R0aXJ6c25iUWc3SVNjNjZHY0lPeWR2T3EwZ091UW5DQWk3Sm1FN0lTeDY1Q2NJTzJNbmV5WGhTRHNoTGp0aXJnaUlESitNK3F3bkNvcTY2VzgNCklPeWduT3lWaU8yVm1PdWR2QzRnNnJDQklPeUV1TzJLdU91S2xDRHNoSnpyb1p3ZzY0dWs2Nlc0SU95Z2tlcTN2T3lkdE95V3RPeVZ2Q0R0bFp6cmk2UXVYRzRuSUNzS0lDQWdJQ0FnSitxd2dTRHNoTGp0aXJqcmlwUWc3SjZGNjZDbDZyTzhJQ29xNnJDWjdKMkFJT3lYcmUyVm9NSzM2ckNaN0oyQUlPcXduT3lJbU1LMzZyQ1o3SjJBSU95SW5PeUVuQ29xN0oyWUlPeWFsT3lHak91bHZDRHJxcWpya1pBZzdZK3M3WldvN1pXYzY0dWtMaURzaExqdGlyZ2c3SldJN0plUTdJU2NJTzJEZ095ZHRPMkxnTUszN0pXSTY0SzB3cmZyc29UdGlyenNuWUFnN1pXY0lPdXF1T3ljdk91aG5DRHJwNTdzbFlUcmxxanNsclRzb0xqc2xid2c3WldjNjR1a0tPeVlpRG9nNjdPNDY2eTQ3SjIwSUNKKzdaV2c2cm1NN0pxVVB5THJxYlFnNjdLRTdZcTg3SjJBSUZ2c2xZVHJpNGpzbUtSZEwxdnJoS1JkS1M1Y2JpY2dLd29nSUNBZ0lDQW5XKzJNbmV5WGhTRHJyTGpzc3JRZzZyZWM3TG1aSU9LQWxDRHNuSVFnN0lxazdZT0E3SjI4DQpJT3F3Z095ZHRPdVRuT3lkbUNBaU9DNGc3WXlkN0plRklpRHNoTG5zaFpqc25ZUWc2NVN3NjZXNDY0dWtYVnh1SnlBckNpQWdJQ0FnSUNjdElPMkRnT3lkdE8yTGdEb2c3S2VuN0oyQUlPdXFoZXlDck9xMXJDZ3lmalRzbHJUc29JZ3BMQ0Rzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5DRHNsNGJzbmJRb2Z1eWFsQzkrNjR1a0wzN3F1WXpzbXBRL0lPcTRpT3luZ0NrdUlPdXdtT3VUbk95TG5DRHNsWWpyZ3JRbzY3TzQ2Nnk0S1NEcnA2WHJuYjNzbllRZzdKcVU3Slc5N1pXMElPMkRnT3lkdE8yTGdPdW5qQ0RydEpEcmo0UWc2NnkwN0lxb0lPMk1uZXlYaGV5ZHVPeW5nQ0RzbFl6cXNvd2c3WldZNjUyOExpRHNtNURyczdqc25iUWdJdXlWak91bXZDL3RtWlhzbmJnaTdMS1k2NSs4SU91bmlleVhzTzJWbU91cHRDRHJzN2pyckxqc25ZUWc2cmU4NnJHdzY2R2NJT3Exck95eXRPMlpsTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEc2xZanJnclFvNjdPNDY2eTRLVG9nN1pXMDdKcVU3TEswTGlEdA0KakpEcmk2anNuYlFnN1pXRTdKcVU3WldZNjZtMElDSis3WldnNnJtTTdKcVVQeUxyb1p3ZzY2eTc2ck9nTENEcmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHNuSVR0bDVnbzdJS3Q3S0Njd3JmdGc0anRoN1FnNjVPeEtleWRnQ0Rxc3JEcXM3enJwYndnNjZpODdLQ0FJT3F5dmVxem9PMlZuT3VMcEM0ZzZyS3c2ck84d3Jmc2c0SHRnNXdnN1lhMTY3TzA2Nm0wSU95RW5PeUlvTzJZbGV5Y3ZPdWhuQ0RzbFl6cnByRHJpNlF1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2N0tFN1lxOE9pRHJzN2pyckxqc25iUWdJbjd0bGFEcXVZenNtcFEvSXV1cHRDQmI3SldFNjR1STdKaWtYUzliNjRTa1hTd2c2N080NjZ5NDdKMjBJT3lEZ2UyWnFleWRoQ0RzaEp6c2lLRHRsWmpxczZBZzdKMjBJT3V5aE8yS3ZPeWR0Q0RzaTZUc29Kd2c2NCtaN0o2UjdKMjA2Nm0wSU91UG1leWVrU0RyajVuc2dxd283SUt0N0tDY0wreWdnT3llcFMvc2w3RHFzckFnN1pXMDdLQ2NJT3VUc1Nrc0lPMkd0ZXV6dENEdGpKM3NsNFhzblpnZzY0dW8NCjdKMjhJT3V5aE8yS3ZPeWR0T3VwdENBaTdabVY3SjI0SWk0Z0l1eTNxT3lHakNMcmlwUWc2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNTENBaTY0dXI2cml3d3Jmcmo1bnNucEVpSU95aHNPMlZxU0RxdUlqc3A0QXVJTzJabE91cHRDRHF1TERyaXFYcnFvVW82N09BNnJLOXdyZnRsYlRzb0p3ZzY1T3hLZXlkZ0NEcXQ3anJqSURyb1p3ZzY1R1U2NHVrTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lia091c3VPeWRtQ0Rzb0pYcnM3VEN0K3loc09xeHRDanNpS3ZzbnBEQ3QreWR0T3lEZ1Mvc25iVHRsWmpDdCt1TWdPeURnU25zbllBZzdKeWc3S2VBN1pXWTZyT2dMQ0RzbTVEcnJManNsNUFnN0plRzY0cVVJT3lnbGV1enRNSzM3S0NJN0xDb3dyZnNsN0RybmIzc3NwanJwYndnN0tlQTdKYTA2NEswN0tlQUlPdW5pT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU9xd25leXl0Q0R0bFpqcmdwanJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0DQpnYXpyaTZUc21yVEN0K3lFcE91cWhjSzM3TDJVNjVPYzdZNmM3SXFrSU9xNGlPeW5nRHBjYmljZ0t3b2dJQ0FnSUNBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXlkdENEc2hManRpcmpzblpnZzY3Q3A3WmFsN0oyRUlPMlZuT3ExcmV5V3RDRHRsWndnNjZ5NDdKNmw3Snk4NjZHY0lpd2dJbVZzWlcxbGJuUnpJam9nVzNzaWNtOXNaU0k2SUNMc2w2M3RsYUFpTENBaWRHVjRkQ0k2SUNMcnJManF0YXdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSW4wc0lDNHVMbDE5TENBdUxpNWRmVnh1SnlBckNpQWdJQ0FnSUNmc2w2M3RsYURzbllBZzdKNkY2NkNsSU95SW5PeUVuT3VNZ091aG5Eb2dKeUFySUhKdmJHVnpJQ3NnSjF4dVhHNG5JQ3NLSUNBZ0lDQWdKMXZ0akozc2w0VWc3SnFVN0lhTVhWeHVKeUFySUd4cGMzUUtJQ0FnSUNrN0NpQWdmU3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBPd3A5Q2dvdkx5RHRqSjNzbDRVZzdKMlI2NHUxN0plUTdJU2NJSHR6WlhSek9pQmJlM0psWVhOdmJpd2daV3hsYldWdQ0KZEhNNlczdHliMnhsTEhSbGVIUjlYWDFkZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxVRzl3ZFhBb2NtRjNLU0I3Q2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdDaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4N1cxeHpYRk5kS2x4OUx5azdDaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0J2SUQwZ1NsTlBUaTV3WVhKelpTaHpLVHNLSUNBZ0lHTnZibk4wSUhObGRITkpiaUE5SUVGeWNtRjVMbWx6UVhKeVlYa29ieUFtSmlCdkxuTmxkSE1wSUQ4Z2J5NXpaWFJ6SURvZ1cxMDdDaUFnSUNCamIyNXpkQ0J6WlhSeklEMGdjMlYwYzBsdUNpQWdJQ0FnSUM1dFlYQW9LSE4wS1NBOVBpQW9ld29nSUNBZ0lDQWcNCklISmxZWE52YmpvZ1UzUnlhVzVuS0NoemRDQW1KaUJ6ZEM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa3NDaUFnSUNBZ0lDQWdaV3hsYldWdWRITTZJRUZ5Y21GNUxtbHpRWEp5WVhrb2MzUWdKaVlnYzNRdVpXeGxiV1Z1ZEhNcENpQWdJQ0FnSUNBZ0lDQS9JSE4wTG1Wc1pXMWxiblJ6Q2lBZ0lDQWdJQ0FnSUNBZ0lDQWdMbTFoY0Nnb1pXd3BJRDArSUNoN0lISnZiR1U2SUZOMGNtbHVaeWdvWld3Z0ppWWdaV3d1Y205c1pTa2dmSHdnSnljcExuUnlhVzBvS1N3Z2RHVjRkRG9nVTNSeWFXNW5LQ2hsYkNBbUppQmxiQzUwWlhoMEtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwcEtRb2dJQ0FnSUNBZ0lDQWdJQ0FnSUM1bWFXeDBaWElvS0dWc0tTQTlQaUJsYkM1MFpYaDBLUW9nSUNBZ0lDQWdJQ0FnT2lCYlhTd0tJQ0FnSUNBZ2ZTa3BDaUFnSUNBZ0lDNW1hV3gwWlhJb0tITjBLU0E5UGlCemRDNWxiR1Z0Wlc1MGN5NXNaVzVuZEdncE93b2dJQ0FnY21WMGRYSnVJSE5sZEhNdWJHVnVaM1JvSUQ4Z2MyVjBjeUE2DQpJRzUxYkd3N0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzS0lDQWdJSEpsZEhWeWJpQnVkV3hzT3dvZ0lIMEtmUW9LTHk4ZzY0eUE3Wm1VN1ppVklPeWduT3lla1NEc25aSHJpN1hzbDVEc2hKd2dlM0psY0d4NUxDQnpkV2RuWlhOMGFXOXVjMXRkZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxRMjl0Y0c5elpTaHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdZMjl1YzNRZ2NtVndiSGtnUFNCVGRISnBibWNvS0c4Zw0KSmlZZ2J5NXlaWEJzZVNrZ2ZId2dKeWNwTG5SeWFXMG9LVHNLSUNBZ0lHTnZibk4wSUhOMVoyZGxjM1JwYjI1eklEMGdRWEp5WVhrdWFYTkJjbkpoZVNodklDWW1JRzh1YzNWbloyVnpkR2x2Ym5NcENpQWdJQ0FnSUQ4Z2J5NXpkV2RuWlhOMGFXOXVjd29nSUNBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIc2dkR1Y0ZERvZ1UzUnlhVzVuS0NoNElDWW1JSGd1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lCVGRISnBibWNvS0hnZ0ppWWdlQzV5WldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZTa3BDaUFnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOVBpQjRMblJsZUhRcENpQWdJQ0FnSURvZ1cxMDdDaUFnSUNCcFppQW9jbVZ3YkhrZ2ZId2djM1ZuWjJWemRHbHZibk11YkdWdVozUm9LU0J5WlhSMWNtNGdleUJ5WlhCc2VTd2djM1ZuWjJWemRHbHZibk1nZlRzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNsWVRybnBqcm9ad2dLaThnZlFvZ0lISmxkSFZ5YmlCdWRXeHMNCk93cDlDZ292THlEcnNvanNsNjBnN0oyUjY0dTE3SmVRN0lTY0lIdDBjbUZ1YzJ4aGRHVmtMQ0JrYVhKbFkzUnBiMjU5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlVjbUZ1YzJ4aGRHVW9jbUYzS1NCN0NpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3Q2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwWTJnb0wxeDdXMXh6WEZOZEtseDlMeWs3Q2lBZ2FXWWdLRzBwSUhNZ1BTQnRXekJkT3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdklEMGdTbE5QVGk1d1lYSnpaU2h6S1RzS0lDQWdJR052Ym5OMElIUnlZVzV6YkdGMFpXUWdQU0JUZEhKcGJtY29LRzhnSmlZZ2J5NTBjbUZ1YzJ4aGRHVmtLU0I4ZkNBbkp5a3VkSEpwYlNncE93b2dJQ0FnYVdZZ0tIUnlZVzV6DQpiR0YwWldRcElISmxkSFZ5YmlCN0lIUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZiam9nVTNSeWFXNW5LQ2h2SUNZbUlHOHVaR2x5WldOMGFXOXVLU0I4ZkNBbkp5a3VkSEpwYlNncElIMDdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIMEtJQ0J5WlhSMWNtNGdiblZzYkRzS2ZRb0tMeThnN0oyUjY0dTE3SmVRN0lTY0lIdDBaWGgwTENCeVpXRnpiMjU5SU91d3NPeVh0Q0RzdHBUc3Rwd2dLT3k5bE91VG5PMk9uT3lLcE1LMzdKV2U2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3BDbVoxYm1OMGFXOXVJSEJoY25ObFUzVm5aMlZ6ZEdsdmJuTW9jbUYzS1NCN0NpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3Q2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwWTJnb0wxeGJXMXh6WEZOZEtseGRMeWs3Q2lBZ2FXWWdLRzBwSUhNZw0KUFNCdFd6QmRPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0JoY25JZ1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdhV1lnS0VGeWNtRjVMbWx6UVhKeVlYa29ZWEp5S1NrZ2V3b2dJQ0FnSUNCeVpYUjFjbTRnWVhKeUNpQWdJQ0FnSUNBZ0xtMWhjQ2dvZUNrZ1BUNGdLSHNnZEdWNGREb2dVM1J5YVc1bktDaDRJQ1ltSUhndWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd2djbVZoYzI5dU9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmU2twQ2lBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvZUNrZ1BUNGdlQzUwWlhoMEtUc0tJQ0FnSUgwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNsWVRybnBqcm9ad2dLaThnZlFvZ0lISmxkSFZ5YmlCYlhUc0tmUW9LTHk4ZzY2R2M2cmU0N0oyNElPMlZoT3lhbE1LMzdaV2M2NCtFSU95MGlPcXp2Q0RzZzRIdGc1enNuYndnNjVXTUlDOW9aV0ZzZEdnZzdLR3c3WnFNNnJDQUlPeVlwT3VwdENEcmtxVHNsNURzaEp3ZzdKdU0NCjY3Q043SmVGN0oyRUlPdUxwT3lMbkNEc2k1enJqNFR0bGJUcnM3anJpNlFnS0RNdzdMU0k3SmVRSURIcnNvanJwNHdwTGdvdkx5RHNoTEhxczdYdGxaanJxYlFnNnJLdzZyTzhJTzJWdU91VHBPdWZyT3F3Z0NCamJHRjFaR1ZUZEdGMGRYTTlKMjlySit1aG5DRHJrSmpyajR6cnBxenJyNERyb1p3c0lPeWVyT3Vobk9xM3VPeWR1Q0R0bTRRZzY3S0U3WXE4N0oyMElPeWdnT3lnaU91aG5DRHduNStpN0p5ODY2R2NJT3V6dGVxM2dPMlZuT3VMcEM0S0x5OGdLTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJvWnpxdDdqc25iZ2c3TEM5N0oyRUlPeVhzQ0Rya3FRZzdLTzg2cml3N0tDQjdKeTg2NkdjSUM5b1pXRnNkR2pycGJ3ZzdLR3c3WnFNN1pXWTY0cVVJT3F5ZytxenZDRHNwNTNzbllRZzdKMjA2Nk9zNjR1a0tRb3ZMeUR0bFp6cmo0UWc3TFNJNnJPODY0K0VJT3F3bWV5ZGdDRHFzcjNyb1p6cm9ad2c2N08xNnJlQTdJdWM3WUtvNjR1a0lPS0FsQ0RxdElEcnBxenNucERxc0lBZzdaV2M2NCtFNjZXOElPeVlyT3VnDQpwT3lqdk9xeHNPdUNtQ0R0bFp6cmo0VHFzSUFnN0xTSTZyaXc3Wm1VNjVDWTY2bTBDaTh2SU95Q3JPeWFxZXlla09xd2dDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPdUlqT3Vmck91UGhDRHJzb1R0aXJ6c25iUWc4Sitmb3V5Y3ZPdWhuQ0RyajR6c2xZVHNtS2pyaTZRdUlPMlZuT3VQaE95WGtDRHFzYmpycHJBZzdaaTQ3TGFjN0oyQUlPcXhzT3lnaU91UW1PdXZnT3VobkNEc2dxenNtcW5ybjRuc25ZQWc3SldJSU91Q21PcXdoT3VMcEFvdkx5RHFzNFRzb0pYc25iUWdLaXJyc0pic2w1RHNoSndxS2lEcnNKVHJnSkFnNnJLRDdKMkVJT3lWak95VmhPeXhpT3VMcENBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU1qWXBMZ292THlEdGhMRHJyN2pyaEpEc25iVHJncGdnNjdpTTY1Mjg3SnF3N0tDQTdKZVE3SVNjSU91THBPdWx1Q0RxczRUc29KWHNuTHpyb1p3ZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95ZWtPcXlxZXltbmV1cWhTRHRqSXpzbmJ6c25ZQWc2N0NVNjRDTTdLZUE2NmVNTENEc25iVHJyN2dnNjVhZw0KSU95ZWlPdUtsQ0JqYkdGMVpHVUtMeThnN0lTNDdJV1k3SjJBSU95TG5PdVBtZTJWb0NEcmxZd2c2N0NiN0oyQUlPeVlteURxczRUc29KVWc3SjZGN0o2bDZyYU03SjJFSU9xM3VPdU1nT3VobkNEc2s3VHJpNlFnNG9hU0lPeURpQ0RxczRUc29KWHNsNUFnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaENEc25vanNsclRyajRRZ0l1MlZuT3VQaENEc3RJanFzN3dpNnJDQUNpOHZJT3F6aE95R2pTRHJncGpzbUtqcmk2UW9NakF5Tmkwd09DRHNpNlRzdUtFZzdJdWc2ck9nT2lBaTdJT0lJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxvanJpcFRyamJBZzdKbWNJT3EzdUNEcXM0VHNvSlVnN0lLczdKcXA2NStKN0oyRUlPdXF1eURzazdEcmc1QWlLUzRLTHk4ZzdaU002NStzNnJlNDdKMjQ3SjJFSU9xeHNPeTVuQ0Ryb1p6cXQ3anNuYmpDdCt1aG5PcTN1T3lWaE95Ymd5Z3ZiM0JsYmkxc2IyZHBic0szTDJOc1lYVmtaUzFzYjJkdmRYUXA3SjJBSUd0cGJHeFFjbTlqN0p5ODY2R2NJT3lFdU95Rm1PeWQNCmhDRHJzb1Ryb0tUc2hKd2c3SjIwSU91c3VPeWduT3F3Z0Fvdkx5RHNsNGJzbDRqcmlwVHJqYkFzSU91d2x1eVhrT3lFbkNEcnNKVHF2cmpycWJRZzY0dWs2NmFzNnJDQUlPeVZqQ0Ryc0tucnNwWHNuYlFnN0plRzdKZUk2NHVrTGlEcXQ3anJucGpzaEp3Z0wyaGxZV3gwYUNEc29iRHRtb3pycDRqcmk2UWc3WXlNN0oyODdKMllJT3F6aE95Z2xlcXp2Q0RydVlUcXRaRHRsWnpyaTZRdUNpOHZJT3U1aE95YXFTQXdLTzJNak95ZHZPdW5qQ0RzbmIzcXM2QXNJR05zWVhWa1pVRmpZMjkxYm5Uc25aZ2dNekRzdElnZzdMcVE3SXVjNjZXOElPcTN1T3VNZ091aG5DRHNrN1RyaTZRZzRvQ1VJQzVqYkdGMVpHVXVhbk52YnV5ZHRDRHN1NlRzaEp3ZzY2ZWs2N0tJSU95ZHZleW5nQ0RzbFlycmlwVHJpNlFwTGdvdkx5RHFzNFRzb0pVZzdKNkk3SjJNSU9LR2tpRHNsNGJzbll3bzY2R2M2cmU0N0pXRTdKdURLU0Ryc0tudGxxWHNuWUFnNnJHMDY1T2M2NmFzN0tlQUlPeVZpdXVLbE91THBEb2c3WXlNN0oyODdKMkVJT3VODQpydXlXdE95VHNPdUtsQ0RzaUp6cXNJUWc3SjZnNnJtUUlPdXF1eURzbmIzcmlwUWc2cktENnJPOENpOHZJT3Exck91MmhPdVFtT3luZ0NEc2xZcnNsWVFnN1plYklPeWVyT3lMbk95ZWtleWRoQ0RydG9EcnBiVHFzNkFzSU9xM3VDRHJzS250bHFYc25ZQWc3SjI0N0thZElPeVlwT3VsbUNEcXNyM3JvWndvYVhOQmRYUm9SWEp5YjNJcDZyQ0FJT3lkdE91dnVDRHNzcGpycHF6dGxaenJpNlF1Q21aMWJtTjBhVzl1SUhKbGMzUmhjblJKWmtGalkyOTFiblJEYUdGdVoyVmtLQ2tnZXdvZ0lHbG1JQ2doY0hKdll5QjhmQ0IzWVdsMFpYSXBJSEpsZEhWeWJqc2dJQ0FnSUNBZ0lDQXZMeURzaExqc2haZ2c3SmVHN0oyTUtPdUxwT3lkakNEdGhMVHNuYlFnN0lPSTY2R2NJT3lMbk91UG1Ta2dMeUR0aExRZzdLZUU3WmFKSU95a2tleWR0T3VwdENEcmk2VHNuWXdnN0tHdzdacU03SmVRN0lTY0NpQWdZMjl1YzNRZ2JtOTNJRDBnWTJ4aGRXUmxRV05qYjNWdWRDZ3BPd29nSUdsbUlDZ2hibTkzSUh4OElHNXZkeUE5UFQwZw0KYzJWemMybHZia0ZqWTI5MWJuUXBJSEpsZEhWeWJqc0tJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzZyT0U3S0NWN0oyMElPdXdsT3VBak95WGlPeVd0T3lhbENBb0p5QXJJQ2h6WlhOemFXOXVRV05qYjNWdWRDQjhmQ0FuN0plRzdKMk1KeWtnS3lBbklPS0draUFuSUNzZ2JtOTNJQ3NnSnlrZzRvQ1VJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91eWhPdW1yT3F6b0NEc2c0Z2c2ck9FN0tDVjdKeTg2NkdjSU91THBPeUxuQ0RzaTV6c25wSHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDaHlaV0Z6YjI0ZzdLZUE3S0NWS1NEaWdKUWdVMFZUVTBsUFRsOUVTVVZFNjZHY0lPdUJuZXVDdE91cHRDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtc091THBBb2dJR3RwYkd4UWNtOWpLQ2ZxczRUc29KWHNuYlFnNjdDVTY0Q003SmEwN0lTY0lPeUV1T3lGbU95ZGhDRHNnNGpyb1p3ZzdJdWMNCjdKNlI3WmFJN0phMDdKcVVJT0tBbENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0bktUc0tJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQnVkV3hzT3lBdkx5RHRsWnpyajRUQ3QrdWhuT3EzdU95ZHVDRHNnNEh0ZzV6cmlwUWc2ck9FN0tDVjY2ZUk2NHVrSU91THBPdWx0T3VMcENEaWdKUWc3SU9JSU9xemhPeWdsZXljdk91aG5DRHJpNlRzaTV3ZzdZeVE3S0NWN1pXWTZyS01DaUFnYzJWemMybHZia0ZqWTI5MWJuUWdQU0J1YjNjN0NuMEtDbXhsZENCc1lYTjBRWFYwYUZKbGRISjVRWFFnUFNBd093cG1kVzVqZEdsdmJpQnlaWFJ5ZVVGMWRHaEpaazVsWldSbFpDZ3BJSHNLSUNCcFppQW9ZMnhoZFdSbFUzUmhkSFZ6SUNFOVBTQW5ZMnhoZFdSbExXeHZaMjkxZENjZ0ppWWdZMnhoZFdSbFUzUmhkSFZ6SUNFOVBTQW5ZMnhoZFdSbExXeHBiV2wwSnlrZ2NtVjBkWEp1T3dvZ0lHbG1JQ2gzWVdsMFpYSWdmSHdnUkdGMFpTNXViM2NvS1NBdElHeGhjM1JCZFhSb1VtVjBjbmxCZENBOElETXdNREF3DQpLU0J5WlhSMWNtNDdJQzh2SU95bmhPMldpU0RzcEpFZzdZUzBJT3V3cWUyVnRDRHF1SWpzcDRBZ0t5QXpNT3kwaUNEcXNJVHFzcWtLSUNCc1lYTjBRWFYwYUZKbGRISjVRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdKNnM3Wm1WN0oyNElPeUxuT3VQaE9LQXBpY3BPd29nSUhKMWJsUjFjbTRvS0NrZ1BUNGdKK3Vobk9xM3VPeWR1Q0R0bVpYc25ianNtcW5zbmJUcmk2UXVJQ0pQU3lMcm5ienFzNkRycDR3ZzY0dTE3WldZNjUyOExpY3BMblJvWlc0b0NpQWdJQ0FvS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU8yWmxleWR1T3VRcUNEaWdKUWc3S0NWN0lPQklPeURnZTJEbk91aG5DRHJzN1hxdDRBdUp5a3NDaUFnSUNBb1pTa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeVZoT3luZ1NEcm9aenF0N2pzbmJnZzdKV0lJT3VRcURvbkxDQlRkSEpwYm1jb1pTNXRaWE56WVdkbA0KS1M1emJHbGpaU2d3TENBNE1Da3BDaUFnS1RzS2ZRb0tMeThnN0l1azdZeW9JT3lka2V1THRleWRoQ0RzZ3F6cm5venNtcWtnN0pXSTY0SzA2NkdjSU91emdPMlptQ0RpZ0pRZzdKdVE3SjI0S091aG5PcTN1T3lkdUMvc2hLVHN1WmdwN0oyMElPMk1qT3lWaGV1UW5DRHFzcjNzbXJEc2w1UWc2cmU0SU95VmlPdUN0T3VsdkN3ZzdKV0U2NHVJNjZtMElPeWdrZXVSa095V3RDdnNtNURyckxqc25ZUWc2N08wNjRLNDY0dWtDbVoxYm1OMGFXOXVJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2djSEpsWm1sNEtTQjdDaUFnYVdZZ0tHVWdKaVlnWlM1dFpYTnpZV2RsSUQwOVBTQk1UMGRKVGw5SFZVbEVSU2tnY21WMGRYSnVJSHNnWlhKeWIzSTZJRXhQUjBsT1gwZFZTVVJGTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFd4dloyOTFkQ2NnZlRzS0lDQnBaaUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQVDA5SUV4SlRVbFVYMGRWU1VSRktTQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ1RFbE5TVlJmUjFWSlJFVXNJSEJ5YjJKc1pXMDYNCklDZGpiR0YxWkdVdGJHbHRhWFFuSUgwN0NpQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjJOc1lYVmtaUzF0YVhOemFXNW5KeWtnZXdvZ0lDQWdjbVYwZFhKdUlIc2daWEp5YjNJNklDZnNuYlFnVUVQc2w1QWdRMnhoZFdSbElFTnZaR1VvWTJ4aGRXUmxLZXF3Z0NEc2hLVHN1Wmpyajd3ZzdKNkk3S2VBSU95Vml1eVZoT3lhbENEaWdKUWc3SVNrN0xtWTdaV1k2ck9nSU91aG5PcTN1T3lkdU8yVm5DRHJrcVFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Snl3Z2NISnZZbXhsYlRvZ0oyTnNZWFZrWlMxdGFYTnphVzVuSnlCOU93b2dJSDBLSUNCeVpYUjFjbTRnZXlCbGNuSnZjam9nY0hKbFptbDRJQ3NnS0dVZ0ppWWdaUzV0WlhOellXZGxJRDhnWlM1dFpYTnpZV2RsSURvZ1UzUnlhVzVuS0dVcEtTQjlPd3A5Q2dwbWRXNWpkR2x2YmlCeVpXRmtRbTlrZVNoeVpYRXBJSHNLSUNCeVpYUjFjbTRnYm1WM0lGQnliMjFwYzJVb0tISmxjMjlzZG1VcElEMCtJSHNLSUNBZ0lHeGxkQ0JpDQpiMlI1SUQwZ0p5YzdDaUFnSUNCeVpYRXViMjRvSjJSaGRHRW5MQ0FvWXlrZ1BUNGdleUJpYjJSNUlDczlJR003SUgwcE93b2dJQ0FnY21WeExtOXVLQ2RsYm1RbkxDQW9LU0E5UGlCN0NpQWdJQ0FnSUhSeWVTQjdJSEpsYzI5c2RtVW9TbE5QVGk1d1lYSnpaU2hpYjJSNUtTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lISmxjMjlzZG1Vb2UzMHBPeUI5Q2lBZ0lDQjlLVHNLSUNCOUtUc0tmUW9LWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3b2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxUGNtbG5hVzRuT2lBbktpY3NDaUFnSjBGalkyVnpjeTFEYjI1MGNtOXNMVUZzYkc5M0xVMWxkR2h2WkhNbk9pQW5SMFZVTENCUVQxTlVMQ0JQVUZSSlQwNVRKeXdLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RTR1ZoWkdWeWN5YzZJQ2REYjI1MFpXNTBMVlI1Y0dVbkxBcDlPd3BtZFc1amRHbHZiaUJxYzI5dUtISmxjeXdnYzNSaGRIVnpMQ0J2WW1vcElIc0tJQ0J5WlhNdWQzSnBkR1ZJWldGaw0KS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MFpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2dZMmhoY25ObGREMTFkR1l0T0NjZ2ZTd2dRMDlTVTE5SVJVRkVSVkpUS1NrN0NpQWdjbVZ6TG1WdVpDaEtVMDlPTG5OMGNtbHVaMmxtZVNodlltb3BLVHNLZlFvS1kyOXVjM1FnYzJWeWRtVnlJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvWVhONWJtTWdLSEpsY1N3Z2NtVnpLU0E5UGlCN0NpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RQVUZSSlQwNVRKeWtnZXlCeVpYTXVkM0pwZEdWSVpXRmtLREl3TkN3Z1EwOVNVMTlJUlVGRVJWSlRLVHNnY21WMGRYSnVJSEpsY3k1bGJtUW9LVHNnZlFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5SMFZVSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDJobFlXeDBhQ2NwSUhzS0lDQWdJSEpsYzNSaGNuUkpaa0ZqWTI5MWJuUkRhR0Z1WjJWa0tDazdJQzh2SU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1UNCjZyK283Snk4NjZtMElPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3Vvdk95Z2dDRHJzb1RycHJEcmk2UWdLT3lWaE91ZW1DRHNtNHpyc0kzc2w0WHNuYlFnN0ppYklPcXpoT3lnbGV5Y3ZPdWhuQ0RyajR6c3A0QWc3SldLNnJLTUtRb2dJQ0FnY21WMGNubEJkWFJvU1daT1pXVmtaV1FvS1RzZ0x5OGc2NkdjNnJlNDdKMjRJTzJWaE95YWxDRHNnNEh0ZzV6cnFiUWc3SjZzN1ptVjdKMjRJT3lMbk91UGhDRGlnSlFnN0o2czY2R2M2cmU0N0oyNDdKMjBJT3VCbmV1Q3JPeWN2T3VwdENEcmk2VHNuWXdnN0tHdzdacU02N2FBN1lTd0lIQnliMkpzWlczc25iUWc3WktBNjZhdzY0dWtDaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dld29nSUNBZ0lDQnZhem9nZEhKMVpTd2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5d2dkam9nUWxKSlJFZEZYMVlzSUdScGNqb2dYMTlrYVhKdVlXMWxMQ0F2THlCMndyZGthWEk2SU9xMXJPdXloT3lnaEMvc2w0bnJtckh0bFp3ZzdJS3M2N080N0oyMElPdVdvQ0RzDQpub2pyaXBUc3A0QWc3S2VFNjR1bzdKcXBDaUFnSUNBZ0lHMXZaR1ZzT2lCamRYSnlaVzUwVFc5a1pXd3NJRzF2WkdWc2N6b2dRVXhNVDFkRlJGOU5UMFJGVEZNc0lHVjRZVzF3YkdWek9pQkZXRUZOVUV4RlV5NXNaVzVuZEdnc0lHZDFhV1JsT2lCSFZVbEVSUzVzWlc1bmRHZ3NJSEpsWVdSNU9pQjNZWEp0WldSVmNDd0tJQ0FnSUNBZ2NISnZZbXhsYlRvZ0tHTnNZWFZrWlZOMFlYUjFjeUE5UFQwZ0oyOXJKeUI4ZkNCamJHRjFaR1ZUZEdGMGRYTWdQVDA5SUc1MWJHd3BJRDhnYm5Wc2JDQTZJR05zWVhWa1pWTjBZWFIxY3l3S0lDQWdJQ0FnWVdOamIzVnVkRG9nWTJ4aGRXUmxRV05qYjNWdWRDZ3BMQW9nSUNBZ0lDQnpaWEoyWldRNklITjBZWFJ6TG5ObGNuWmxaQ3dnYkdGemRFRjBPaUJ6ZEdGMGN5NXNZWE4wUVhRc0lHeGhjM1JVWlhoME9pQnpkR0YwY3k1c1lYTjBWR1Y0ZEN3Z2JHRnpkRk5sWXpvZ2MzUmhkSE11YkdGemRGTmxZeXdLSUNBZ0lIMHBPd29nSUgwS0lDQXZMeUR0bEl6cm42enF0N2pzbmJnZw0KN0l1czdKNmw2N0NWNjQrWklPS0FsQ0RyZ1lycXVMRHJxYlFnN0p5RUlPcXdrT3lMbkNEdGc0RHNuYlRycUxqcXNJQWc2NHVrNjZhczY2VzhJT3VCaU91THBBb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OW9aV0Z5ZEdKbFlYUW5LU0I3Q2lBZ0lDQnNZWE4wUW1WaGRDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlNCOUtUc0tJQ0I5Q2lBZ0x5OGc2NkdjNnJlNDdKMjRJT0tBbENEdGxJenJuNnpxdDdqc25ianNuWmdnVy9DZm42QWc3WUcwNjZHYzY1T2NJT3Vobk9xM3VPeWR1Q0R0bFlUc21wUmR3cmRiOEorVWtWMGc2N0tFN1lxODdKMjBJTzJZdU95Mm5PMlZuT3VMcEM0S0lDQXZMeURxdUxEcnM3Z282N2lNNjUyODdKcXc3S0NBSU95bmdlMldpU2s2SUdCamJHRjFaR1VnWVhWMGFDQnNiMmRwYmlBdExXTnNZWFZrWldGcFlPdWx2Q0RzaUtqc25ZQWc3WlNFNjZHYzdJUzQNCjdJcWs2NkdjSU95THBPMldpU0RpZ0pRZzY2bVU2NG0wSU95WGh1eWR0Q0RxczZmc25xVWc2N2lNNjUyODdKcXc3S0NBNjZXOElPeVh0T3F6b0N3S0lDQXZMeUFnSUd4dlkyRnNhRzl6ZENEc2lKanNpNkFnN1krczdZcTQ2NkdjSU9xeXNPcXp2T3VsdkNEc25wRHJqNWtnN0lpWTY2QzU3WldjNjR1a0tPeUxwT3k0b1RvZzdaZWs2NU9jNjZhczdJcWs3SmVRN0lTYzY0K0VJT3U0ak91ZHZPeWFzT3lnZ0NEc2w3VHJwcndnS3lCTVNWTlVSVTRnN1ptVjdKMjRMQ0F5TURJMkxUQTNLUzRLSUNBdkx5QWdJTzJFc091dnVPdUVrT3lkdENEdG1aVHJxYlRzbDVBZzdLQ0U3WmlBSU95VmlDRHJuS3pyaTZRdUlPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmpycDR3ZzdaV1k2Nm0wSU91Qm5TNEtJQ0F2THlEdGo3VHJzTEVvN1lTdzY2KzQ2NFNRS1RvZzdKNlE2NCtaSU95WmhPdWpqT3F3Z0NEcnA0bnRub3dnN1ptWTZySzlLT3U0ak91ZHZPeWFzT3lnZ09xd2dDQnNiMk5oYkdodmMzVHNsNUFnNjZxN0lPdUx2K3lWDQpoQ0RzdlpUcms1enFzSUFnNjdPMDdKMjA2NHFVSU9xeXZleWFzQ25zbDVEc2hKd0tJQ0F2THlBZ0lPdWhuT3EzdU95ZHVDRHJqSURxdUxBZzdLU1JJT3V5aE8yS3ZPeWRoQ0RybUpBZzY0aUU2NlcwNjZtMExDRHN2WlRyazV6cnBid2c2N2FaN0plczY0U2o3SjJFSU95SW1DRHNub2pyaXBRZzdZU3c2Nis0NjRTUUlPdXdxZXlMbmV5Y3ZPdWhuQ0Rzb0lUdG1aanRsWnpyaTZRdUNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyOXdaVzR0Ykc5bmFXNG5LU0I3Q2lBZ0lDQmpiMjV6ZENCaWIyUjVJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR052Ym5OMElITjNhWFJqYUUxdlpHVWdQU0FoSVNoaWIyUjVJQ1ltSUdKdlpIa3VjM2RwZEdOb1FXTmpiM1Z1ZENrN0lDOHZJT3F6aE95Z2xTRHNvSVR0bVpnZ1BTRHNpNXp0Z2F6cnByOGc3TEM5N0p5ODY2R2NJT3lYdE95V3RDRHFzNFRzb0pYc25ZUWc2ck9nNjZXOElPeUltQ0Rzbm9qcQ0Kc293S0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUM4dklHTnNZWFZrWmVxd2dDRHNsNGJzbkx6cnFiUWc3SmVzNnJpdzdJU2NJT3VCaXV1S2xPdUxwQzRnYzJobGJHdzZkSEoxWmV1ZHZDQmpiR0YxWkdYcXNJQWc3SmVHN0phMDY0K0VJT3lGdU95ZGdDRHNvSlhzZzRFZzdJdWs3WmFKNjQrOENpQWdJQ0FnSUM4dklITndZWGR1N0oyWUlDZGxjbkp2Y2lmcXNJQWc3SldJSU91Y3FPcXpvQ3dnN0ppSTdLQ0U3SmVVSU9xM3VPdU1nT3VobkNCdmF6cDBjblZsNjZXOElPdVBqT3VncE95a3JPdUxwQ0RpZ0pRS0lDQWdJQ0FnTHk4ZzdaU002NStzNnJlNDdKMjQ3SjJBSUNMcnVJenJuYnpzbXJEc29JRHJwYndnN0plMDdKZUk3SmEwN0pxVUl1dWR2T3F6b0NEdGxaanJpcFRyamJBZzdJdWs3S0NjNjZHYzY0cVVJT3lWaE91c3RPcXlnK3VQaENEc2xZZ2c2NXlvNjRxVUlPeURnZTJEbk9xd2dDRHJrSkRyaTZRbzdJdWs3S0NjSU95TG9PcXpvQ2t1Q2lBZ0lDQWdJR2xtSUNoamJHRjFaR1ZUZEdGMGRYTWdQVDA5SUNkamJHRjENClpHVXRiV2x6YzJsdVp5Y3BJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TVN3Z2V3b2dJQ0FnSUNBZ0lDQWdaWEp5YjNJNklDZnNuYlFnVUVQc2w1QWdRMnhoZFdSbElFTnZaR1hxc0lBZzdKZUc3SmEwN0pxVUlPS0FsQ0R0aExEcnI3anJoSkRzbDVEc2hKd2dZMnhoZFdSbElDMHRkbVZ5YzJsdmJpRHNuYlFnNjVDWTY0cVU3S2VBSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUp5d0tJQ0FnSUNBZ0lDQWdJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y3NDaUFnSUNBZ0lDQWdmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdMeThnN0tlRTdaYUpJT3lra2V5ZHVPdU5zQ0RybUpBZzY0aU02NkNBNjR1a0lPS0FsQ0RxdUlqcnNLa29OakRzdElnZzY0SzBLU0RyaTZUc2k1d2c2NGlFNjZXNElPcXh0Q0FpN0xDOTdKMkVJT3VMcSt5Vm1PdUxwQy9ycXJzZzY3U2s2NHVrSXV5WGtDRHFzSURxdVl6c21yRHJyNERyb1p3ZzY3aU02NTI4N0pxdzdLQ0E2NkdjSU95ZXJPeUxuT3VQDQpoTzJWbk91THBDNEtJQ0FnSUNBZ0x5OGc3WldjN0xDNElPdVNwT3lYa091UGhDRHJtSkFnNjRpRTY2VzA2NHFVSU9xeHRDRHJ1SXpybmJ6c21yRHNvSURxc0lBZ2JHOWpZV3hvYjNOMElPeTluT3V3c2V5WGtDRHJxcnNnNjR1LzdKV0VJT3lla091UG1TRHNtWVRybzR6cXNJQWc3SldJSU91UW1PdUtsQ0R0bVpqcXNyM3NuYndnN0lpWUlPeWVpT3ljdk91TGlBb2dJQ0FnSUNBdkx5RHF0N2pybFl6cnA0d2c3TDJVNjVPYzY2VzhJT3UybWV5WHJPdUVvK3lkaENEc2lKZ2c3SjZJNjRxVUlPMkVzT3V2dU91RWtDRHJzS25zaTUzc25MenJvWndnN1krMDY3Q3g3WldjNjR1a0lDanJrWkFnNjdLSTdLZTRJTzJCdE91bXJleVhrQ0R0aExEcnI3anJoSkRzbmJRZzdZcUE3SmEwNjRLWTdKaWs2Nm0wSU91THVlMlpxZXlLcE91ZnZldUxwQ2t1Q2lBZ0lDQWdJR052Ym5OMElITjBZV3hsSUQwZ2JHOW5hVzVRY205aklDWW1JQ2hFWVhSbExtNXZkeWdwSUMwZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUGlBMk1EQXdNQ2s3Q2lBZw0KSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk1nSmlZZ2MzUmhiR1VwSUhzS0lDQWdJQ0FnSUNCcmFXeHNURzluYVc1UWNtOWpLQ2s3Q2lBZ0lDQWdJQ0FnYVdZZ0tDRnZjR1Z1VEc5bmFXNVVaWEp0YVc1aGJDZ3BLU0I3Q2lBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Td2dleUJsY25KdmNqb2dKK3lkdENCUFUreVhrT3lFb0NEc25wRHJqNW5zbkx6cm9ad2c2NnE3SU95WHRPeVd0T3lhbENEaWdKUWc3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNEc2k2VHRsb2tnN1p1RUlDOXNiMmRwYmlEdGxiUWc3S084N0lTNDdKcVVMaWNnZlNrN0NpQWdJQ0FnSUNBZ2ZRb2dJQ0FnSUNBZ0lDOHZJT3lkbU91UGhPeWdnU0Rzb29Ycm80d29jbVZoYzI5dUlPeW5nT3lnbFNrZzRvQ1VJT3luaE8yV2lTRHNwSkVnN1lTMDdKMkVJRk5GVTFOSlQwNWZSRWxGUk91aG5DRHJnWjNyZ3JUcnFiUWc3SjZRNjQrWklPeWVyT3lMbk91UGhPcXdnQ0RzbUpzZzZyT0U3S0NWSU95RXVPeUZtT3lkaENEcmtKanMNCmdyVHJwckRyaTZRS0lDQWdJQ0FnSUNCcmFXeHNVSEp2WXlnbjY2R2M2cmU0N0oyNDdKMkVJT3luaE8yV2llMlZtT3VLbENEc3BKSHNuYlRybmJ3ZzdKcVU3TEt0N0oyRUlPeWtrZXVMcU8yV2lPeVd0T3lhbENEaWdKUWc2NkdjNnJlNDdKMjRJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0bktUc0tJQ0FnSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPd29nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdZKzA2N0N4SU9LQWxDRHRoTERycjdqcmhKQWc2N0NwN0l1ZDdKeTg2NkdjSU95Z2hPMlptQzRuS1RzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnYlc5a1pUb2dKM1JsY20xcGJtRnNKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JyYVd4c1RHOW5hVzVRY205aktDazdJQzh2SU95Vm51eUVvQ0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNDdKMjBJT3VNDQpnT3E0c0NEc3BKSHNuYlRycWJRZzdLQ1I2ck9nSU95RGlPdWhuQ0RzbDdEcmk2UWdLT3l3dmV5ZGhDRHJpNnZzbFpqcXNiRHJncGdnNjR1azdJdWNJT3VJaE91bHVDRHFzcjNzbXJBcENpQWdJQ0FnSUd4dloybHVVM1JoY25SbFpFRjBJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJQ0FnTHk4ZzZyT0U3S0NWSU95Z2hPMlptT3lkdE91cHRDRHNtckRycHF6cXNJQWc3SXVjN1lHczY2YS9JT3l3dmV5Y3ZPdWhuQ0RzbDdEcmk2UW83SnlFSUNmcXM0VHNvSlVnN0tDRTdabVk3SjJBSU95TG5PMkJyT3VtdnlEc3NMM3NuTHpyb1p3bklPeWp2T3lFblNrNkNpQWdJQ0FnSUM4dklDQWdRbEpQVjFORlVqMXVieTF2Y095Y3ZPdWhuQ0JEVEVuc25aZ2c2N2lNNjUyODdKcXc3S0NBSU95WHRPcTRzT3VsdkNEcnA0bnFzNkFzSUhOMFpHOTFkT3lYa0NEc3NJM3Rub2pyaXBRZ1ZWSk1JT3lnaE91c3VPeWRoQ0RzbnFIc2xZVHNoSndnN0pxdzY2YXM2ckNBSU95WHNPdUxwQzRLSUNBZ0lDQWdMeThnNjZlTTY2T01JT3llck91aA0Kbk9xM3VPeWR1Q2h1YjNKdFlXd3A3SjJBSU9xd21leWRnQ0RxczRUc29KWHNuYlRybmJ3ZzdJUzQ3SVdZN0oyMElPdUNxT3lWaENEc25vanJpcFFnNnJLTUlPdTVvT3VsdE91THBDRGlocElnNnJHMDY1T2M2NmFzN0tlQUlPeVZpdXF6b0NCRFRFbnFzSUFnN0tlQjdLQ1JJT3lYc091THBDNEtJQ0FnSUNBZ1kyOXVjM1FnY0hKcGRtRjBaVXh2WjJsdUlEMGdJU0Z6ZDJsMFkyaE5iMlJsT3dvZ0lDQWdJQ0JqYjI1emRDQjBhR2x6VEc5bmFXNGdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjJsdUp5d2dKeTB0WTJ4aGRXUmxZV2tuWFN3Z2V3b2dJQ0FnSUNBZ0lITm9aV3hzT2lCMGNuVmxMQW9nSUNBZ0lDQWdJR1Z1ZGpvZ2NISnBkbUYwWlV4dloybHVJRDhnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnUTB4QlZVUkZYMFZPVml3Z2V5QkNVazlYVTBWU09pQjNjbWwwWlU1dmIzQkNjbTkzYzJWeUtDa2dmU2tnT2lCRFRFRlZSRVZmUlU1V0xBb2dJQ0FnSUNBZ0lITjBaR2x2T2lCd2NtbDINCllYUmxURzluYVc0Z1B5QmJKMmxuYm05eVpTY3NJQ2R3YVhCbEp5d2dKM0JwY0dVblhTQTZJQ2RwWjI1dmNtVW5MQW9nSUNBZ0lDQWdJSGRwYm1SdmQzTklhV1JsT2lCMGNuVmxMQW9nSUNBZ0lDQWdJR1JsZEdGamFHVmtPaUJ3Y205alpYTnpMbkJzWVhSbWIzSnRJQ0U5UFNBbmQybHVNekluTENBdkx5QnJhV3hzVEc5bmFXNVFjbTlqN0oyWUlPcTN1T3VqdVNCcmFXeHM3SnFwSUNocmFXeHNVSEp2WStxenZDRHJqNW5zbmJ3ZzdZeW83WVMwS1FvZ0lDQWdJQ0I5S1RzS0lDQWdJQ0FnYkc5bmFXNVFjbTlqSUQwZ2RHaHBjMHh2WjJsdU93b2dJQ0FnSUNCcFppQW9jSEpwZG1GMFpVeHZaMmx1S1NCN0NpQWdJQ0FnSUNBZ2JHVjBJRzkxZENBOUlDY25Pd29nSUNBZ0lDQWdJR3hsZENCdmNHVnVaV1FnUFNCbVlXeHpaVHNLSUNBZ0lDQWdJQ0JqYjI1emRDQnpZMkZ1SUQwZ0tHTm9kVzVyS1NBOVBpQjdDaUFnSUNBZ0lDQWdJQ0JwWmlBb2IzQmxibVZrS1NCeVpYUjFjbTQ3Q2lBZ0lDQWdJQ0FnSUNCdmRYUWdLejBnDQpZMmgxYm1zdWRHOVRkSEpwYm1jb0tUc0tJQ0FnSUNBZ0lDQWdJR052Ym5OMElHMGdQU0J2ZFhRdWJXRjBZMmdvTDJoMGRIQnpPbHd2WEM5Y1V5cGNMMjloZFhSb1hDOWhkWFJvYjNKcGVtVmNQMXhUS3k4cE93b2dJQ0FnSUNBZ0lDQWdhV1lnS0NGdEtTQnlaWFIxY200N0NpQWdJQ0FnSUNBZ0lDQnZjR1Z1WldRZ1BTQjBjblZsT3dvZ0lDQWdJQ0FnSUNBZ0x5OGc2NEdkN0plUUlPdTJtZXlkZ0NEcmxMRHNtTFR0a1p6Q3QrcTBoTzJZdU91bG1PdW5qQ0RybHJ6c2xyVHJncmpyaTZRZ0tGVlNUQ0RzbnBEc3NyVHNsNVFnN0pXSUlPeVRzT3lkdE91S2xDRHJyTGpzbnBEcms2UXBDaUFnSUNBZ0lDQWdJQ0JqYjI1emRDQjFjbXdnUFNCdFd6QmRMbkpsY0d4aFkyVW9MMXNpSnp3K0tWeGRYU3NrTHl3Z0p5Y3BPd29nSUNBZ0lDQWdJQ0FnYVdZZ0tDRnZjR1Z1VUhKcGRtRjBaVmRwYm1SdmR5aDFjbXdwSUNZbUlDRnZjR1Z1UkdWbVlYVnNkRUp5YjNkelpYSW9kWEpzS1NrZ2V3b2dJQ0FnSUNBZ0lDQWdJQ0JqYjI1eg0KYjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU8yWmxPdXB0T3lkaENEcnFyc2c3SmUwN0plSTdKYTA3SnFVSU9LQWxDRHNuYlFnN0tPODdJYU02NkdjSU95bmdleWdrU0Ryb1p6cXQ3anNuYmp0bGJRZzdLTzg3SVM0N0pxVU9pQW5JQ3NnZFhKc0tUc0tJQ0FnSUNBZ0lDQWdJSDBLSUNBZ0lDQWdJQ0I5T3dvZ0lDQWdJQ0FnSUhSb2FYTk1iMmRwYmk1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENCelkyRnVLVHNLSUNBZ0lDQWdJQ0IwYUdselRHOW5hVzR1YzNSa1pYSnlMbTl1S0Nka1lYUmhKeXdnYzJOaGJpazdDaUFnSUNBZ0lDQWdMeThnVlZKTTdKMjBJT3lWaUNEc25xSHRub2pycWJRbzdMYWM2NkNsSU8yWWxleUxuZXlkdENEcnNKVHJnSkFnNjVPeEtTRHNsWVRyckxRZzdMQzk2NCtFSU95VmlDRHJuS3dnN0xHRUlPdW5pZTJlak91THBDRGlnSlFnUWxKUFYxTkZVdXVsdkNCdWJ5MXZjT3ljdk91aG5DRHJwNG5zbFlRZzY1S0E2cml3SU91VmpPdXN1QzRLSUNBZ0lDQWdJQ0F2THlEcXQ3Z2cNCjZySzk3SnF3SU8yVm5DRHJzb2pycDR3ZzdKaWJJT3V3cWV5TG5TaERURW5xc0lBZzdLZUI3S0NSSU95WHRPcTRzQ25zbkx6cm9ad2c2NHVrN0l1Y0lPeUxuT3VQaE8yVm5PdUxwQzRLSUNBZ0lDQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSHNLSUNBZ0lDQWdJQ0FnSUdsbUlDaHZjR1Z1WldRZ2ZId2diRzluYVc1UWNtOWpJQ0U5UFNCMGFHbHpURzluYVc0cElISmxkSFZ5YmpzS0lDQWdJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryb1p6cXQ3anNuYmdnVlZKTTdKMkVJT3VxdXlEc3NMN3NsWmpzbHJUc21wUWc0b0NVSUVOTVNlcXdnQ0RzcDRIc29KRWc2N2lNNjUyODdKcXc3S0NBNjZXOElPeVhyT3VLbENEcnNLbnNpNTNzbkx6cm9ad2c2NHVrN0l1Y0lPeUxuT3VQaE8yVnFldUxpT3VMcEM0bktUc0tJQ0FnSUNBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc0tJQ0FnSUNBZ0lDQWdJR052Ym5OMElISmxkSEo1SUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbllYVjBhQ2NzDQpJQ2RzYjJkcGJpY3NJQ2N0TFdOc1lYVmtaV0ZwSjEwc0lIc0tJQ0FnSUNBZ0lDQWdJQ0FnYzJobGJHdzZJSFJ5ZFdVc0lHVnVkam9nUTB4QlZVUkZYMFZPVml3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlN3S0lDQWdJQ0FnSUNBZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzQ2lBZ0lDQWdJQ0FnSUNCOUtUc0tJQ0FnSUNBZ0lDQWdJR3h2WjJsdVVISnZZeUE5SUhKbGRISjVPd29nSUNBZ0lDQWdJQ0FnY21WMGNua3ViMjRvSjJWeWNtOXlKeXdnS0NrZ1BUNGdleUJwWmlBb2JHOW5hVzVRY205aklEMDlQU0J5WlhSeWVTa2diRzluYVc1UWNtOWpJRDBnYm5Wc2JEc2dmU2s3Q2lBZ0lDQWdJQ0FnSUNCeVpYUnllUzV2YmlnblkyeHZjMlVuTENBb0tTQTlQaUI3SUdsbUlDaHNiMmRwYmxCeWIyTWdQVDA5SUhKbGRISjVLU0I3SUd4dloybHVVSEp2WXlBOUlHNTFiR3c3SUdGalkyOTFiblJEWVdOb1pTNWhkQ0E5SURBNw0KSUgwZ2ZTazdDaUFnSUNBZ0lDQWdmU3dnTVRVd01EQXBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR2xtSUNoc2IyZHBibEJ5YjJNZ1BUMDlJSFJvYVhOTWIyZHBiaWtnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNnZlNrN0NpQWdJQ0FnSUhSb2FYTk1iMmRwYmk1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGdld29nSUNBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJNZ0lUMDlJSFJvYVhOTWIyZHBiaWtnY21WMGRYSnVPd29nSUNBZ0lDQWdJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdDaUFnSUNBZ0lDQWdhV1lnS0d4dloybHVVSEp2WTFScGJXVnlLU0I3SUdOc1pXRnlWR2x0Wlc5MWRDaHNiMmRwYmxCeWIyTlVhVzFsY2lrN0lHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2JuVnNiRHNnZlFvZ0lDQWdJQ0FnSUdGalkyOTFiblJEWVdOb1pTNWhkQ0E5SURBN0lDOHZJT3lEaUNEcXM0VHNvSlhzbmJ3ZzdJaVlJT3llaU95Y3ZPdUxpQ0RyaTZUc25Zd2cNCkwyaGxZV3gwYUNEcmxZd2c2NHVrN0l1Y0lPeWR2ZXE0c0FvZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU95Z2lPeXdxQ0Rzb29Ycm80d2dLR052WkdVZ0p5QXJJR052WkdVZ0t5QW5LU2NwT3dvZ0lDQWdJQ0FnSUM4dklPeUNyT3Vlak95ZHRDRHJvWnpxdDdqc25ianRsYUFnN0l1YzZyQ0U2NCtFSU95WGh1eWR0Q0RxczZmcnNKVHJvWndnN0l1azdZeW82NkdjSU91Qm5ldUNyT3VMcENBOUlHTnNZWFZrWmVxd2dDRHNsNGJxc2JEcmdwZ2c3SXVrN1phSjdKMjBJT3lWaUNEcmtKd2c2cktETGdvZ0lDQWdJQ0FnSUM4dklPeWRrZXVMdGV5ZGdDRHNuYlRycjdnZzY3TzA2NE9JN0p5ODY0dUlJT3lEZ2UyRG5PdWx2Q0RyaTZUc2k1d2c3SjZzN0lTY0lDOW9aV0ZzZEdqcm9ad2c3SldNNjZhdzY0dWtJQ2p0bEl6cm42enF0N2pzbmJqc25iUWc2NHlBNnJpd0lPMlpsT3VwdE95ZGhDRHNpNlR0aktqcm9ad2c2N0NVNnI2ODY0dWtLUzRLDQpJQ0FnSUNBZ0lDQnBaaUFvWTI5a1pTQWhQVDBnTUNBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQQ0ExTURBd0tTQjdDaUFnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNDdKMjBJT3ltaWV5TG5DRHNpNlR0aktqcm9ad2c2NEdkNjRLb0lPS0FsQ0JEYkdGMVpHVWdRMjlrWlNEc2hLVHN1WmdnN0lPQjdZT2M2Nlc4SU91THBPeUxuQ0Rzb0pEcXNvRHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJQ0FnSUNCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BPd29nSUNBZ0lDQWdJSDBLSUNBZ0lDQWdmU2s3Q2lBZ0lDQWdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZ01URHJ0b1FnNnJLOTZyTzhJT0tBbENEcmpJRHF1TEFnN1pTRTY2R2M3SVM0N0lxa0lPeWdsZXVtckM0bktUc2dhMmxzYkV4dloybHVVSEp2WXlncA0KT3lCOUxDQTJNREF3TURBcE93b2dJQ0FnSUNBdkx5RHJncUhzbllBZzdKNkY3SjZsNnJhTTdKMkVJT3Vzdk9xem9DRHNub2pyaXBRZzY0eUE2cml3SU95RXVPeUZtT3lkZ0NEcnNvVHJwckRyaTZRZzRvQ1VJT3llck91aG5PcTN1T3lkdUNEdG00UWc2NHVrN0oyTUlPeWFsT3l5cmV5ZHRDRHNnNGdnN0lTNDdJV1lLT3lEaUNEc25vWHNucVhxdG93cDdKeTg2NkdjSU95TG5PeWVrZTJWbU9xeWpDNEtJQ0FnSUNBZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDaHlaV0Z6YjI0ZzdLZUE3S0NWS1NEaWdKUWdVMFZUVTBsUFRsOUVTVVZFNjZHY0lPdUJuZXVDdE91cHRDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3VncEFvZ0lDQWdJQ0F2THlEc25xenJvWnpxdDdqc25iZ2c2NUtrN0plUTY0K0VJRTFCV0Y5VVZWSk9VK3E1ak95bmdDRHNtSnNnNnJPRTdLQ1Y3Snk4NjZHY0lPeXltT3Vtck91UW1PdUtsQ0Ryc29UcXQ3anFzSUFnNjVDYzY0dWsNCklDZ3lNREkyTFRBM0lPdW1yT3Uzc095WGtPeUVuQ0R0bVpYc25iZ3BDaUFnSUNBZ0lHdHBiR3hRY205aktDZnJvWnpxdDdqc25ianNuWVFnN0tlRTdaYUo3WldZNjRxVUlPeWtrZXlkdE91ZHZDRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bzdaYUk3SmEwN0pxVUlPS0FsQ0Ryb1p6cXQ3anNuYmdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3BPd29nSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFbklDc2dLSE4zYVhSamFFMXZaR1VnUHlBbklDanFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDRHNpNXp0Z2F6cnByOGc3TEM5N0p5ODY2R2NJT3lYdE95V3RDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDY3YUE3WVN3SU91enRPeVhyT3lramV1TGlPdUxwQ2tuSURvZ0p5Y3BJQ3NnSnlEaWdKUWc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeWVrT3VQDQptU0RzbDdEcXNyRHJrS25yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQnRiMlJsT2lCemQybDBZMmhOYjJSbElEOGdKMkp5YjNkelpYSXRjM2RwZEdOb0p5QTZJQ2RpY205M2MyVnlKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2daWEp5YjNJNklDZnJvWnpxdDdqc25iZ2c3TEM5N0oyRUlPdXF1eURzbDdUc2w0anNsclRzbXBRNklDY2dLeUJsTG0xbGMzTmhaMlVnZlNrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SUNqdGhMRHJyN2pyaEpBZzdZKzA2N0N4SU9xMXJPMlloT3UyZ0NEaWdKUWc2N2lNNjUyODdKcXc3S0NBSU95ZWtPdVBtU0RzbVlUcm80enFzSUFnN0pXSUlPdVFtT3VLbENEdG1aanFzcjBnN0tDRTdKcXBLUW9nSUdaMWJtTjBhVzl1SUc5d1pXNU1iMmRwYmxSbGNtMXBibUZzS0NrZ2V3b2dJQ0FnZXdvZ0lDQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1dw0KYkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSE4wWVhKMDZyQ0FJT3lEaUNEc3ZaanNocFFnN0xDOTdKMkVJT3Vuak91VG9PdUxwQ0FvNjR1azY2YXM3SjJZSU95SXFPeWRnQ0Rzdlpqc2hwVHFzN3dnNjZ5MDZyU0E3WldZNnJLTUlPeUNyT3lhcWV5ZWtPeVhrT3F5akNEcnM3VHNub1FwTGdvZ0lDQWdJQ0FnSUM4dklPeWR0T3lXdE95RW5DQlFiM2RsY2xOb1pXeHNLQzV3Y3pFcDdKMjBJRFhzdElnZzY1S2tJT3EzdUNEc3NMM3NsNUFnN0plVTdZU3c2Nlc4SU91enRPdUN0Q0F4NjdLSUtPcTFyT3VQaFNEcXM0VHNvSlVwN0oyRUlPeWVrT3VQbVNEc2hLRHRnNTN0bFpqcXM2QXNDaUFnSUNBZ0lDQWdMeThnN0xDOTdKMkVJT3kxbk95R2pPMlpsTzJWdENEc2dxenNtcW5zbnBBZzY0aUk3SmVVSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianJwNHdnNjRLbzZyS01JTzJWbk91THBDNGc3TEM5N0oyRUlPdXF1eURzc0w3c25MenJxYlFnN0pXRTY2eTA2cktENjQrRUlPeVYNCmlDRHRsWnpyaTZRS0lDQWdJQ0FnSUNBdkx5QW82NHVrNjZXNElPeXd2U0RzbUtUc25vWHJvS1VnNjdDcDdLZUFJT0tBbENEcXQ3Z2c2cks5N0pxd0lPdXBsT3VKdE9xd2dDRHJzN1RzbmJUcmlwUWc3TEdFNjZHY0lPdUNxT3F6b0NEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFxQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdLTzg3SjJZT2lCamJHRjFaR1hxc0lBZzdMMlk3SWFVSU95Z25PdXFxZXlkaENEcnNKVHF2cmpycWJRZ1FYQndRV04wYVhaaGRHVXZSbWx1WkZkcGJtUnZkK3F3Z0NEcnFyc2c3TEMrN0oyRUlPeUltQ0Rzbm9qc25Zd2c0b0NVSU95Y2lPdVBoT3lhc0NEc2k2VHF1TERzbDVEc2hKd2c3Wm1WN0oyNElPMlZoT3lhbEM0S0lDQWdJQ0FnSUNCamIyNXpkQ0J3Y3pFZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV3h2WjJsdUxuQnpNU2NwT3dvZ0lDQWdJQ0FnSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vDQpjSE14TENCYkNpQWdJQ0FnSUNBZ0lDQW5VM1JoY25RdFUyeGxaWEFnTFZObFkyOXVaSE1nTlNjc0NpQWdJQ0FnSUNBZ0lDQW5KSGR6SUQwZ1RtVjNMVTlpYW1WamRDQXRRMjl0VDJKcVpXTjBJRmRUWTNKcGNIUXVVMmhsYkd3bkxBb2dJQ0FnSUNBZ0lDQWdJbWxtSUNna2QzTXVRWEJ3UVdOMGFYWmhkR1VvSjJOc1lYVmtaUzFzYjJkcGJpY3BLU0I3SWl3S0lDQWdJQ0FnSUNBZ0lDSWdJQ1IzY3k1VFpXNWtTMlY1Y3lnbmZpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lGTjBZWEowTFZOc1pXVndJQzFUWldOdmJtUnpJREluTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdRV1JrTFZSNWNHVWdMVTVoYldWemNHRmpaU0JWSUMxT1lXMWxJRmNnTFUxbGJXSmxja1JsWm1sdWFYUnBiMjRnSjF0RWJHeEpiWEJ2Y25Rb1hDSjFjMlZ5TXpJdVpHeHNYQ0lwWFNCd2RXSnNhV01nYzNSaGRHbGpJR1Y0ZEdWeWJpQlRlWE4wWlcwdVNXNTBVSFJ5SUVacGJtUlhhVzVrYjNjb2MzUnlhVzVuSUdNc0lITjBjbWx1WnlCMEtUc2dXMFJzYkVsdA0KY0c5eWRDaGNJblZ6WlhJek1pNWtiR3hjSWlsZElIQjFZbXhwWXlCemRHRjBhV01nWlhoMFpYSnVJR0p2YjJ3Z1UyaHZkMWRwYm1SdmR5aFRlWE4wWlcwdVNXNTBVSFJ5SUdnc0lHbHVkQ0J1S1Rzbklpd0tJQ0FnSUNBZ0lDQWdJQ0lnSUNSb0lEMGdXMVV1VjEwNk9rWnBibVJYYVc1a2IzY29XMDUxYkd4VGRISnBibWRkT2pwV1lXeDFaU3dnSjJOc1lYVmtaUzFzYjJkcGJpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lHbG1JQ2drYUNBdGJtVWdXMU41YzNSbGJTNUpiblJRZEhKZE9qcGFaWEp2S1NCN0lGdDJiMmxrWFZ0VkxsZGRPanBUYUc5M1YybHVaRzkzS0NSb0xDQTJLU0I5Snl3Z0x5OGdOaUE5SUZOWFgwMUpUa2xOU1ZwRkNpQWdJQ0FnSUNBZ0lDQW5mU2NzQ2lBZ0lDQWdJQ0FnWFM1cWIybHVLQ2RjY2x4dUp5a2dLeUFuWEhKY2JpY3BPd29nSUNBZ0lDQWdJR052Ym5OMElHSmhkQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdGJHOW5hVzR1WW1GMEp5azcNCkNpQWdJQ0FnSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloaVlYUXNJQ2RBWldOb2J5QnZabVpjY2x4dUp5QXJDaUFnSUNBZ0lDQWdJQ0FuYzNSaGNuUWdJbU5zWVhWa1pTMXNiMmRwYmlJZ1kyMWtJQzlySUdOc1lYVmtaU0F2Ykc5bmFXNWNjbHh1SnlBckNpQWdJQ0FnSUNBZ0lDQW5jRzkzWlhKemFHVnNiQ0F0VG05UWNtOW1hV3hsSUMxRmVHVmpkWFJwYjI1UWIyeHBZM2tnUW5sd1lYTnpJQzFHYVd4bElDSW5JQ3NnY0hNeElDc2dKeUpjY2x4dUp5azdDaUFnSUNBZ0lDQWdjM0JoZDI0b0oyTnRaQ2NzSUZzbkwyTW5MQ0JpWVhSZExDQjdJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2djM1JrYVc4NklDZHBaMjV2Y21VbkxDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNLSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBblpHRnlkMmx1SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSEIwZVNobGVIQmxZM1FwNjZHY0lPdXp0T3VDdUNEdGdxVHNsNUFnN1lHMDY2R2M2NU9jDQpJRlJWU2Vxd2dDRHJyTFRyc0pqc25aSHNuYmdnNnJLRDdKMjBJT3lMcE95NG9TRHRtWlhzbmJqcmtLZ29NakF5Tmkwd055d2c3SjI4NjdDWUlGeHl3cmRyYVhSMGVTRHN2WlRyazV3ZzY2cW82NUdRS1NEaWdKUUtJQ0FnSUNBZ0lDQXZMeURzbktEc25ienRsWndnN0o2UTY0K1o3Wm1VSU9xeXZldWhuT3VLbENCVGVYTjBaVzBnUlhabGJuUno3SjJZSU95bmhPeW5uQ0R0Z3FRZzdKNkY2NkNsTGlEc29KSHF0N3pzaExFZzZyYU03WldjN0oyMElPeWVpT3ljdk91cHRDQTI3TFNJSU91U3BDRHNsNVR0aExEcXNJQWc3SjZRNjQrWklPeWVoZXVncGV1UHZBb2dJQ0FnSUNBZ0lDOHZJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbmJRZzdJU2c3WU9kNjVDWTZyT2dMQ0RxdG96dGxaenNuYlFnN0plRzdKeTg2Nm0wSUd0bGVYTjBjbTlyWlNEc3BJVHJwNHdnN0tHdzdKcXA3WjZJSU95THBPMk1xTzJWdENEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFuT3VMcENobQ0KWVdsc0xYTnZablFwTGdvZ0lDQWdJQ0FnSUM4dklPeVhsTzJFc0NEc3A0SHNvSVRzbDVBZ1ZHVnliV2x1WVd6c25ZUWc2NHVrN0l1Y0lPeVZudXljdk91aG5DRHFzSURzb0xqc21ZQWc2NHVrNjZXNElPeVZzZXlYa0NEdGdxVHFzSUFnNjVPazdKYTA2ckNBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpQWdJQ0FnSUNBZ2MzQmhkMjRvSjI5ellYTmpjbWx3ZENjc0lGc0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWkc4Z2MyTnlhWEIwSUNKamJHRjFaR1VnTDJ4dloybHVJaWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHRmpkR2wyWVhSbEp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZGtaV3hoZVNBMkp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWVdOMGFYWmhkR1VuTEFvZ0lDQWcNCklDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlEQXVNeWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVTNsemRHVnRJRVYyWlc1MGN5SWdkRzhnYTJWNWMzUnliMnRsSUhKbGRIVnliaWNzQ2lBZ0lDQWdJQ0FnSUNBdkx5RHNsNVR0aExEcXNJQWc3SXVrN0tDYzY2R2NJT3VUcE95V3RPcXdoQ0Rxc3Izc21yRHNsNURycDR3ZzdKZXM2cml3SU91UGhPdUxyQ2pxdG96dGxad2c3SmVHN0p5ODY2bTBJT3ljaE95WGtPeUVuQ0RzcEpIcmk2Z3BJT0tBbENEdGhMRHJyN2pyaEpEc25ZUWc3TG1ZN0p1TUlPdTRqT3Vkdk95YXNPeWdnT3VuakNEcmdxanF1TFRyaTZRS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0F4TGpVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJ6WlhRZ2JXbHVhV0YwZFhKcGVtVmtJRzltSUdaeWIyNTBJSGRwYm1SdmR5QjBieUIwY25WbEp5d0tJQ0FnSUNBZ0lDQmRMQ0I3DQpJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNLSUNBZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z1ptRnNjMlU3SUM4dklPeW5nT3lia0NEc2xZZ2c3WldZNjRxVUlFOVRDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2NtVjBkWEp1SUhSeWRXVTdDaUFnSUNCOUNpQWdmUW9nSUM4dklPMkJ0T3Vobk91VG5DRHFzNFRzb0pVZzY2R2M2cmU0N0pXRTdKdURJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3Wm1JN0oyWUlGdnJvWnpxdDdqc2xZVHNtNE5kSU91eWhPMkt2T3lkdENEdG1ManN0cHd1SUdOc1lYVmtaU0JoZFhSb0lHeHZaMjkxZE95Y3ZPdWhuQ0JEVEVrZzY2R2M2cmU0N0oyNDdKMkVJTzJWdE95Z25PMlZuT3VMcEM0S0lDQXZMeUFvN0oyMElGQkQ3SjJZSU95Z2dPeWVwZXVRbkNEc25wRHFzcW5zcHAzcnFvWHNuWVFnN0tlQTdKcTA2NHVrSU9LQWxDRHJpNlRzaTV3ZzdKT3c2NkNrNjZtMElPeWVyT3Vobk9xM3VPeWR1Q0R0bFlUc21wUXVLU0Ryb1p6cXQ3anNsWVRzbTRNZzdadUU3SmVVSU95RQ0KdU95Rm1NSzM2ck9FN0tDVjdMcVE3SXVjNjZXOElPeWdsZXVtck8yVm5PdUxwQzRLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2WTJ4aGRXUmxMV3h2WjI5MWRDY3BJSHNLSUNBZ0lHTnZibk4wSUd4dklEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25ZWFYwYUNjc0lDZHNiMmR2ZFhRblhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc0tJQ0FnSUd4bGRDQmxjbklnUFNBbkp6c0tJQ0FnSUd4dkxuTjBaR1Z5Y2k1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0lHVnljaUFyUFNCa0xuUnZVM1J5YVc1bktDazdJSDBwT3dvZ0lDQWdiRzh1YjI0b0oyVnljbTl5Snl3Z0tHVXBJRDArSUhzZ2FuTnZiaWh5WlhNc0lEVXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lHVnljbTl5T2lBbjY2R2M2cmU0N0pXRTdKdURJT3lMcE8yV2lTRHNpNlR0aktnNklDY2dLeUJsTG0xbGMzTmgNCloyVWdmU2s3SUgwcE93b2dJQ0FnYkc4dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lDQWdhMmxzYkZCeWIyTW9KK3Vobk9xM3VPeVZoT3liZysyVnRPeUVuQ0RzbXBUc3NxM3NuWVFnN0tTUjY0dW83WmFJN0phMDdKcVVMaWNwT3lBdkx5RHNuWmpyajRUc29JRWc3S0tGNjZPTUlPS0FsQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95RXVPeUZtT3lkaENEcmtKanNnclRycHF6cnFiUWc3SldJSU91UXFBb2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QWdJQ0FnSUNBZ0x5OGc2NHVrN0oyTUlDOWhZMk52ZFc1MHdyY3ZhR1ZoYkhSbzdKZVE3SVNjSU9xemhPeWdsZXlkaENEc2c0anJvWndvUGV5WGh1eWRqT3ljdk91aG5Da2c3SjI5NnJLTUNpQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0lDQWdJQ0FnSUNBdkx5RHNnNEh0ZzV3ZzdKNnM3WXlRN0tDVktPdUxwT3lkakNEdGhMVHNsNURzaEp3ZzY2KzQ2NkdjNnJlNDdKMjRJT3F3a095bmdDa0tJQ0FnDQpJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc2xZVHNtNE1nS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93b2dJQ0FnSUNCcFppQW9jbVZ6TG1obFlXUmxjbk5UWlc1MEtTQnlaWFIxY200N0lDOHZJR1Z5Y205eUlPMlZ1T3VUcE91ZnJPcXdnQ0RzbmJUcnI3Z2c3SjJSNjR1MTdaYUk3Snk4NjZtMElPeWtrZXV6dFNEcnNLbnNwNEFLSUNBZ0lDQWdhV1lnS0dOdlpHVWdQVDA5SURBcElHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdDaUFnSUNBZ0lHVnNjMlVnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUdWeWNtOXlPaUFvWlhKeUxuUnlhVzBvS1M1emJHbGpaU2d3TENBeE5UQXBLU0I4ZkNBb0oreWloZXVqakNEc3ZaVHJrNXdnSnlBcklHTnZaR1VwSUgwcE93b2dJQ0FnZlNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lDOHZJT3lla09xNHNDRHNvb1hybzR3ZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNCVA0KVkU5UVgwSlNTVVJIUlMvdGxaanRpcmpydVlUdGlyanFzSUFnN1ppNDdMYWM3WldjNjR1a0lDanJvWnpzdTZ6c2w1RHNoSnpycDR3ZzdLQ1I2cmU4SU9xd2dPdUtwZTJWbU91TGlDRHNsWWpzb0lRcENpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dld29nSUNBZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlNCOUtUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvb1hybzR3ZzdKcVU3TEt0SU91d20reWRqQ0RpZ0pRZzY0dWs2NmFzNjZXOElPdUJsZXVMaU91THBDNG5LVHNLSUNBZ0lITm9kWFIwYVc1blJHOTNiaUE5SUhSeWRXVTdDaUFnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJREl3TUNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWcNCmNtVnhMblZ5YkNBOVBUMGdKeTl5WldOdmJXMWxibVFuS1NCN0NpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzTENCeWIyeGxJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnYVdZZ0tDRjBaWGgwSUh4OElDRlRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0oreTJsT3l5bk91d20reWRoQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdMYVU3TEtjSU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnl3Z2NtOXNaU0EvSUNkYkp5QXJJSEp2YkdVZ0t5QW5YU2NnT2lBbkp5d2diVzlrWld3Z1B5QW5LT3VxcU91TnVEb2dKeUFyDQpJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NpQTlJR0YzWVdsMElHRnphME5zWVhWa1pTaFRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BMQ0J0YjJSbGJDd2dleUJ3WVhKelpUb2djR0Z5YzJWVGRXZG5aWE4wYVc5dWN5d2dabTl5YldGMFJHVnpZem9nSjF0N0luUmxlSFFpT2lBaTY2eTQ2cldzSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBaWZTd2dMaTR1WFNjZ2ZTd2djbTlzWlNrN0NpQWdJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ2NpNXdZWEp6WldRZ2ZId2dXMTA3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZw0KN1pXMDdJU2Q3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvSnpzbFlnZ0p5QXJJSE4xWjJkbGMzUnBiMjV6TG14bGJtZDBhQ0FySUNmcXNKd2dLQ2NnS3lCelpXTWdLeUFuY3lrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0F6TUNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJSE4xWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z24NClcySnlhV1JuWlYwZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0JtY21sbGJtUnNlVVZ5Y205eUtHVXNJQ2Z0Z2JUcm9aenJrNXdnN1ppNDdMYWNJT3lMcE8yTXFEb2dKeWtwT3dvZ0lDQWdmUW9nSUgwS0lDQXZMeUR0bElUcm9JanNub1RyczRRZzdMYVU3TEtjSU9LQWxDRHRsWndnN1ptVTY2bTA3SjJFSU8yVm1PeWNoQ0R0bElUcm9JanNub1FvN0ppQjdKZXRLU0RyaTZqc25JVHJvWndnNjRLWTY0aWdJT3V3bStxem9Dd2c3SmlCN0pldDY2ZUk2NHVrSU91VXNPdWhuQ0RyaklEc2xZanNuWVFnNjRLNDY0dWtMZ29nSUM4dklPeVlnZXlYclNEc2lKanJwNHp0Z2J3ZzdKcVU3TEt0N0oyRUlPeXF2T3F3bk95bmdDRHNsWXJyaXBRZzZyS0Q3SjIwSU8yVnRleUxyQ0FvNjRxUTY2Q2s3S2VBNnJPZ0lPeUNyT3lhcWV1ZmlldVBoQ0RxdDdqcnA0enRnYndnNjRLWTZyQ0U2NHVrS1M0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQDQpVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2Y21WamIyMXRaVzVrTFdkeWIzVndjeWNwSUhzS0lDQWdJR052Ym5OMElIc2daM0p2ZFhCekxDQnRiMlJsYkN3Z2JXOXlaU0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0dkeWIzVndjeWtLSUNBZ0lDQWdQeUJuY205MWNITUtJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tHY3BJRDArSUNoN0NpQWdJQ0FnSUNBZ0lDQWdJRzVoYldVNklGTjBjbWx1Wnlnb1p5QW1KaUJuTG01aGJXVXBJSHg4SUNjbktTNTBjbWx0S0Nrc0NpQWdJQ0FnSUNBZ0lDQWdJSFJsZUhSek9pQW9aeUFtSmlCQmNuSmhlUzVwYzBGeWNtRjVLR2N1ZEdWNGRITXBJRDhnWnk1MFpYaDBjeUE2SUZ0ZEtTNXRZWEFvS0hRcElEMCtJRk4wY21sdVp5aDBJSHg4SUNjbktTNTBjbWx0S0NrcExtWnBiSFJsY2loQ2IyOXNaV0Z1S1N3S0lDQWdJQ0FnSUNBZ0lDQWdjbTlzWlRvZ0tHY2dKaVlnWnk1eWIyeGxLU0EvSUZOMA0KY21sdVp5aG5Mbkp2YkdVcElEb2dkVzVrWldacGJtVmtMQW9nSUNBZ0lDQWdJQ0FnZlNrcENpQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaG5LU0E5UGlCbkxuUmxlSFJ6TG14bGJtZDBhQ2tLSUNBZ0lDQWdPaUJiWFRzS0lDQWdJR2xtSUNoc2FYTjBMbXhsYm1kMGFDQThJRElwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW43SmlCN0pldDdKMjBJT3UyZ095aHNlMlZxZXVMaU91THBDNG5JSDBwT3dvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RzbXBUc3NxMDZJT3lZZ2V5WHJTQW5JQ3NnYkdsemRDNXNaVzVuZEdnZ0t5QW42ckNjSnlBcklDaHRiM0psSUQ4Z0p5QW82NDJVSU91d20rcTRzQ2tuSURvZ0p5Y3BMQ0J0YjJSbGJDQS9JQ2NvNjZxbzY0MjRPaUFuSUNzZ2JXOWtaV3dnS3lBbktTY2dPaUFuSnlrN0NpQWdJQ0IwY25rZ2V3b2cNCklDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUjNKdmRYQnpLR3hwYzNRc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVWR5YjNWd2N5d2dabTl5YldGMFJHVnpZem9nSjNzaVozSnZkWEJ6SWpvZ1czc2libUZ0WlNJNklDTHNtSUhzbDYwZzdKMjA2NmFFSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcmpJRHNsWWdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOVhYMWRmU2NnZlN3Z0lTRnRiM0psS1RzS0lDQWdJQ0FnWTI5dWMzUWdiM1YwSUQwZ2NpNXdZWEp6WldRN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnZkWFFwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0NpQWdJQ0FnDQpJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJVHJvSWpzbm9UcnM0UWc3S0NjN0pXSUlDY2dLeUJ2ZFhRdWNtVmtkV05sS0NodUxDQm5LU0E5UGlCdUlDc2daeTV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dzSURBcElDc2dKK3F3bkNBdklPeVlnZXlYclNBbklDc2diM1YwTG14bGJtZDBhQ0FySUNmcXNKd2dLQ2NnS3lCelpXTWdLeUFuY3lrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlDZGI3WlNFNjZDSTdKNkU2N09FWFNBbklDc2dVM1J5YVc1bktDaHNhWE4wV3pCZElDWW1JR3hwYzNSYk1GMHVkR1Y0ZEhOYk1GMHBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlOQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbA0KY3l3Z01qQXdMQ0I3SUdkeWIzVndjem9nYjNWMExDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1pTRTY2Q0k3SjZFNjdPRUlPeTJsT3l5bkNEc2k2VHRqS2c2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5LU2s3Q2lBZ0lDQjlDaUFnZlFvZ0lDOHZJTzJNbmV5WGhTRHNtcFRzaG96cnM0UWc3TGFVN0xLY0lPS0FsQ0R0bFp3ZzdZeWQ3SmVGN0oyWUlPcTFyT3lFc2V5YWxPeUdqQ2pzbDYzdGxhQXI2Nnk0NnJXc0tldWx2Q0R0bFp3ZzY3S0k3SmVRSU91d20reVZoQ0RzbDYzdGxhRHJzNFRyb1p3ZzY0dWs2NU9zNjRxVTY0dWtMZ29nSUM4dklPeWFsT3lHak91bHZDRHRsYWpxdTVnZzY3TzA2NEswN0pXOElPMkRnT3lkdE8yTGdPeWQNCnRDRHJzN2pyckxnZzY2ZWw2NTI5N0oyRUlPeXd1T3loc08yVm9DRHNpSmdnN0o2STY0dWtLT3lhbE95R2pPdXpoQ0Rxc0p6cnM0UWc3SnFVN0xLdDZyTzg3SjJZSU95d3FPeWR0Q2t1Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNKbFkyOXRiV1Z1WkMxd2IzQjFjQ2NwSUhzS0lDQWdJR052Ym5OMElIc2daV3hsYldWdWRITXNJRzF2WkdWc0xDQnRiM0psSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ1kyOXVjM1FnYkdsemRDQTlJRUZ5Y21GNUxtbHpRWEp5WVhrb1pXeGxiV1Z1ZEhNcElEOGdaV3hsYldWdWRITXVabWxzZEdWeUtDaGxLU0E5UGlCbElDWW1JRk4wY21sdVp5aGxMblJsZUhRZ2ZId2dKeWNwTG5SeWFXMG9LU2tnT2lCYlhUc0tJQ0FnSUdsbUlDaHNhWE4wTG14bGJtZDBhQ0E4SURJcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuN1l5ZDdKZUZJT3lhbE95R2pPcXdnQ0RyDQp0b0Rzb2JIdGxhbnJpNGpyaTZRdUp5QjlLVHNLSUNBZ0lHTnZibk4wSUhOMFlYSjBaV1FnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1uZXlYaFNEc3RwVHNzcHdnN0pxVTdMS3RPaURzbXBUc2hvd2dKeUFySUd4cGMzUXViR1Z1WjNSb0lDc2dKK3F3bkNjZ0t5QW9iVzl5WlNBL0lDY2dLT3VObENEcnNKdnF1TEFwSnlBNklDY25LU3dnYlc5a1pXd2dQeUFuS091cXFPdU51RG9nSnlBcklHMXZaR1ZzSUNzZ0p5a25JRG9nSnljcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ1kyOXVjM1FnY2lBOUlHRjNZV2wwSUdGemExQnZjSFZ3S0d4cGMzUXNJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlZCdmNIVndMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXV3cWUyV3BTRHRsWndnNjZ5NDdKNmxJaXdnSW1Wc1pXMWxiblJ6SWpvZ1czc2ljbTlzWlNJNklDTHNsNjN0bGFBaUxDQWlkR1Y0ZENJNklDTHJyTGpxdGF3aQ0KZlN3Z0xpNHVYWDBzSUM0dUxsMTlKeUI5TENBaElXMXZjbVVwT3dvZ0lDQWdJQ0JqYjI1emRDQnpaWFJ6SUQwZ2NpNXdZWEp6WldRN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnpaWFJ6S1NCN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJSHNnWlhKeWIzSTZJQ2Z0Z2JUcm9aenJrNXdnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlkN0plRklPeUV1TzJLdUNBbklDc2djMlYwY3k1c1pXNW5kR2dnS3lBbjZyQ2NJQ2duSUNzZ2MyVmpJQ3NnSjNNcEp5azdDaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGwNClZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNBblcrMk1uZXlYaFYwZ0p5QXJJRk4wY21sdVp5Z29iR2x6ZEZzd1hTQW1KaUJzYVhOMFd6QmRMblJsZUhRcElIeDhJQ2NuS1M1emJHbGpaU2d3TENBeU5DazdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhObGRITXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY2dmU2s3Q2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpKM3NsNFVnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lDZnRnYlRyb1p6cms1d2c3Wmk0N0xhY0lPeUxwTzJNcURvZ0p5a3BPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5RHJqSUR0bVpUdG1KVWc2Nnk0NnJXc0lPeWduT3llDQprU0RpZ0pRZzdJT0I3Wm1wN0oyRUlPeUVwT3VxaGUyVm1PdXB0Q0RyckxqcXRhenJwYndnNjZlTTY1T2s3SmEwN0tTQTY0dWtJQ2pzdHBUc3NwenFzN3dnNnJDWjdKMkFJT3lFdU95Rm1Dd2c2NHlBN1ptVTY0cVVJT3VucENEc21wVHNzcTNzbDVBZzdZYTE3S2U0NjZHY0lPeUxwT3VtdkNrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdlkyOXRjRzl6WlNjcElIc0tJQ0FnSUdOdmJuTjBJSHNnYldWemMyRm5aWE1zSUcxdlpHVnNJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlFRnljbUY1TG1selFYSnlZWGtvYldWemMyRm5aWE1wSUQ4Z2JXVnpjMkZuWlhNdVptbHNkR1Z5S0NodEtTQTlQaUJ0SUNZbUlGTjBjbWx1WnlodExuUmxlSFFnZkh3Z0p5Y3BMblJ5YVcwb0tTa2dPaUJiWFRzS0lDQWdJR2xtSUNnaGJHbHpkQzVzWlc1bmRHZ3BJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREF3TENCNw0KSUdWeWNtOXlPaUFuNjR5QTdabVVJT3VDdE95YXFleWR0Q0RydVlUc2xyUWc3SjZJN0lxMTY0dUk2NHVrTGljZ2ZTazdDaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJR052Ym5OMElHeGhjM1JWYzJWeUlEMGdXeTR1TG14cGMzUmRMbkpsZG1WeWMyVW9LUzVtYVc1a0tDaHRLU0E5UGlCdExuSnZiR1VnSVQwOUlDZGhjM05wYzNSaGJuUW5LVHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c25wRWc2NHlBN1ptVUlPeWFsT3l5clRvbkxDQlRkSEpwYm1jb0tHeGhjM1JWYzJWeUlDWW1JR3hoYzNSVmMyVnlMblJsZUhRcElIeDhJQ2NuS1M1emJHbGpaU2d3TENBMU1Da3VjbVZ3YkdGalpTZ3ZYRzR2Wnl3Z0p5QW5LU0FySUNmaWdLWWdLT3VNZ08yWmxDQW5JQ3NnYkdsemRDNXNaVzVuZEdnZ0t5QW42ckNjS1NjcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ0x5OGc2NHlBN1ptVTZyQ0FJT3E0dU95V3RPeW5nT3VwdENEc3RaenF0N3dnTVRMcXNKenINCnA0d2dLTzJVaE91aHJPMlVoTzJLdUNEdGo2M3NvN3dnNjdDcDdLZUFLUW9nSUNBZ0lDQmpiMjV6ZENCeUlEMGdZWGRoYVhRZ1lYTnJRMjl0Y0c5elpTaHNhWE4wTG5Oc2FXTmxLQzB4TWlrc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVU52YlhCdmMyVXNJR1p2Y20xaGRFUmxjMk02SUNkN0luSmxjR3g1SWpvZ0l1dU1nTzJabENEc25aSHJpN1VnN1pXYzY1R1FJT3VzdU95ZXBTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2Nnk0NnJXc0lpd2dJbkpsWVhOdmJpSTZJQ0xzbmJUc25LQWlmU3dnTGk0dVhYMG5JSDBwT3dvZ0lDQWdJQ0JqYjI1emRDQnZkWFFnUFNCeUxuQmhjbk5sWkRzS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3dvZ0lDQWdJQ0JwWmlBb0lXOTFkQ2tnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwDQo2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeWVrU0RzblpIcmk3VWdLQ2NnS3lCelpXTWdLeUFuY3l3ZzdLQ2M3SldJSUNjZ0t5QnZkWFF1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUNzZ0orcXduQ2tuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWdvYkdGemRGVnpaWElnSmlZZ2JHRnpkRlZ6WlhJdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djbVZ3YkhrNg0KSUc5MWRDNXlaWEJzZVN3Z2MzVm5aMlZ6ZEdsdmJuTTZJRzkxZEM1emRXZG5aWE4wYVc5dWN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeWVrU0RzaTZUdGpLZzZKeXdnWlM1dFpYTnpZV2RsS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdDaUFnSUNCOUNpQWdmUW9nSUM4dklPdXlpT3lYclNEaWdKUWc3WldjNnJXdDdKYTBJT0tHbENEc21JSHNsclFnN0o2UTY0K1pJQ2pzdHBUc3NwenFzN3dnNnJDWjdKMkFJT3lFdU95Rm1DRHNncXpzbXFrcENpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzUnlZVzV6YkdGMFpTY3BJSHNLSUNBZ0lHTnZibk4wSUhzZ2RHVjRkQ3dnYlc5a1pXd2cNCmZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQnBaaUFvSVhSbGVIUWdmSHdnSVZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0NrcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuNjdLSTdKZXQ3WldnSU91c3VPcTFyT3F3Z0NEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdKcVU3TEt0T2ljc0lGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0ExTUNrdWNtVndiR0ZqWlNndlhHNHZaeXdnSnlBbktTQXJJQ2ZpZ0tZbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhJZ1BTQmhkMkZwZENCaGMydFVjbUZ1YzJ4aGRHVW9VM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFZISmhibk5zWVhSbExDQm1iM0p0WVhSRVpYTmpPaUFuDQpleUowY21GdWMyeGhkR1ZrSWpvZ0l1dXlpT3lYcmV1c3VDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpWkdseVpXTjBhVzl1SWpvZ0ltdHY0b2FTWlc0ZzY1aVE2NHFVSUdWdTRvYVNhMjhpZlNjZ2ZTazdDaUFnSUNBZ0lHTnZibk4wSUc5MWRDQTlJSEl1Y0dGeWMyVmtPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzY3S0k3SmV0SU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNtWVRybzR3Z0tDY2dLeUJ6WldNZ0t5QW5jeXdnSnlBcklDaHZkWFF1WkdseVpXTjBhVzl1SUh4OA0KSUNjL0p5a2dLeUFuS1NjcE93b2dJQ0FnSUNCemRHRjBjeTV6WlhKMlpXUXJLenNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRUYwSUQwZ2JtVjNJRVJoZEdVb0tTNTBiMHh2WTJGc1pWUnBiV1ZUZEhKcGJtY29KMnR2TFV0U0p5azdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2dkSEpoYm5Oc1lYUmxaRG9nYjNWMExuUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZiam9nYjNWMExtUnBjbVZqZEdsdmJpd2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzaTZUdGpLZzZKeXdnWlM1dFpYTnpZV2RsS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnkNCmFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEcnNvanNsNjBnN0l1azdZeW9PaUFuS1NrN0NpQWdJQ0I5Q2lBZ2ZRb2dJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREEwTENCN0lHVnljbTl5T2lBblRtOTBJR1p2ZFc1a0p5QjlLVHNLZlNrN0Nnb3ZMeURzbmJUcnI3Z2c2NHVrNjZhczZyQ0FJT3VXb0NEc25vanJpcFRyamJBZzY1aVFJT3k4bk9xNHNPcXdnQ0RyazZUc2xyVHNtS1RycWJRbzdLQ2M3SXFrN0xLWUlPeWVrT3VQbVNEc3ZKenF1TEFnN0tTUjY3TzFJT3VUc1NrZzdLR3c3SnFwN1o2SUlPeWloZXVqakNEaWdKUWc2NCtNNjQyWUlPdUxwT3Vtck91S2xDRHF0N2pyaklEcm9ad2c3SnlnN0tlQUNuTmxjblpsY2k1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V3b2dJR2xtSUNobElDWW1JR1V1WTI5a1pTQTlQVDBnSjBWQlJFUlNTVTVWVTBVbktTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SjIwNjYrNElPeThuT3lndUNEc25vanNsclRzbXBRbzdZK3M3WXE0DQpJQ2NnS3lCUVQxSlVJQ3NnSnlEc2dxenNtcWtnN0tTUktTRGlnSlFnN0oyMElPeWR1T3lLcE8yRXRPeUtwT3VLbENEc29vWHJvNHp0bGFucmk0anJpNlF1SnlrN0NpQWdJQ0J3Y205alpYTnpMbVY0YVhRb01DazdDaUFnZlFvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaEp6cnNvUWc3SmlrNjZXWU9pY3NJR1VnSmlZZ1pTNXRaWE56WVdkbEtUc0tJQ0J3Y205alpYTnpMbVY0YVhRb01TazdDbjBwT3dvdkx5RHNsclRybHFRZzZySzk2NkdjNjZHY0lPeWp2ZXVUb0Nqc2k2enNucVhyc0pYcmo1a2c2NEdLNnJtQUxDQkRkSEpzSzBNc0lDOXphSFYwWkc5M2Jpd2c3SmlrNjZXWUtTQmpiR0YxWkdVZzdKNlE3SXVkN0oyRUlPdUNxT3E0c095bmdDRHNsWXJyaXBUcmk2UUtjSEp2WTJWemN5NXZiaWduWlhocGRDY3NJQ2dwSUQwK0lIc2dhMmxzYkZCeWIyTW9LVHNnYTJsc2JFeHZaMmx1VUhKdll5Z3BPeUI5S1RzS2NISnZZMlZ6Y3k1dmJpZ25VMGxIU1U1VUp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bA0KZUdsMEtEQXBLVHNLY0hKdlkyVnpjeTV2YmlnblUwbEhWRVZTVFNjc0lDZ3BJRDArSUhCeWIyTmxjM011WlhocGRDZ3dLU2s3Q2dwelpYSjJaWEl1YkdsemRHVnVLRkJQVWxRc0lDY3hNamN1TUM0d0xqRW5MQ0FvS1NBOVBpQjdDaUFnWTI5dWMyOXNaUzVzYjJjb0orS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2NnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rzdkp6c3A1QWc0b0NVSUdoMGRIQTZMeTlzYjJOaGJHaHZjM1E2SnlBcklGQlBVbFFwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2NnNjZxbzY0MjRPaUFuSUNzZ1EweEJWVVJGWDAxUFJFVk1JQ3NnSnlEQ3R5RHNtSWpzaTV3Z0p5QXINCklFVllRVTFRVEVWVExteGxibWQwYUNBcklDZnFzYlFnN0o2bDdMQ3BKeWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeURzbmJRZzdMQzk3SjJFSU95OG5PdVJsQ0RyajVuc2xZZ2c3WlM4NnJlNDY2ZUlJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHRnYlRyb1p6cms1enJvWndnN0xhVTdMS2M3WldwNjR1STY0dWtMaWNwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2ZpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBbktUc0tJQ0JqYUdWamEwTnNZWFZrWlVGMllXbHNZV0pzWlNncE95QXZMeUJEYkdGMVpHVWdRMjlrWlNEc2dxenNtcWtnNnJDQTY0cWxJT3lYck91MmdDRHNvSkRxc29BZ0tPMlVqT3Vmck9xM3VPeWR1Q0RzbFlqcmdyVHNtcWtwDQpDaUFnTHk4ZzY2KzQ2NmFzSU95TG5PdVBtU0FySU95bmdPeUxuT3VzdUNEc283enNub1VnNG9DVUlPeXlxeURzdHBUc3NwenJ0b0R0aExBZzY3bWc2NlcwNnJLTUNpQWdZWE5yUTJ4aGRXUmxLQ2ZzbTR6cnNJM3NsNFU2SUNMc29JRHNucVVnNjVDWTdKZUk3SXExNjR1STY0dWtJaWNwTG5Sb1pXNG9DaUFnSUNBb0tTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeVpoT3VqakNEaWdKUWc3TGFVN0xLY0lPeWtnT3U1aENEcmdaMHVKeWtzQ2lBZ0lDQW9aU2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3liak91d2pleVhoU0RzaTZUdGpLZ2dLT3l5cXlEc21wVHNzcTBnNjVXTUlPeWVyT3lMbk91UGhDazZKeXdnWlM1dFpYTnpZV2RsS1FvZ0lDazdDbjBwT3dvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJRzFoWTA5VElPdVRzZXlYa095RW5DQW5iRzlqWVd4b2IzTjBKK3F3Z0NBNg0KT2pIcm9ad2c2Nmk4N0tDQUlPMlZ0T3lFbmV1UW1PdUtsT3VOc0Fvdkx5RHRsTHpxdDdqcnA0Z29SV3hsWTNSeWIyNHBJR1psZEdObzY0cVVJR04xY216cXM3d2c2NHVzNjZhc0lFbFFkalRyb1p3ZzdKNlE2NCtaSU8yUHRPdXdzZTJWbU95bmdDRHNsWXJzbFlRc0lFbFFkalRycDR3ZzY1T2o2NDJZSU91THBPdW1yT3lYa0NEc2w3RHFzckRzbmJRZzZyR3c2N2FBNjQrOENpOHZJT3kybE95eW5NSzM3WmVzN0lxazdMSzA3WUdzNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxvanJpNlFvN0l1azdMaWhJREl3TWpZdE1EY3BMaURxc0puc25ZQWc3SnFVN0xLdElPMlZ1T3VUcE91ZnJPdWx2Q0JKVUhZMklPdWpxTzJVaE91d3NleVhrT3VQaENEc2xybnJpcFRyaTZRdUNtTnZibk4wSUhObGNuWmxjallnUFNCb2RIUndMbU55WldGMFpWTmxjblpsY2loelpYSjJaWEl1YkdsemRHVnVaWEp6S0NkeVpYRjFaWE4wSnlsYk1GMHBPd3B6WlhKMlpYSTJMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUJqYjI1emIyeGwNCkxteHZaeWduVzJKeWFXUm5aVjBnU1ZCMk5pZzZPakVwSU91bXJPeUtxQ0RzZzUzcm5yVWc0b0NVSUVsUWRqVHJwNHdnN0lLczdKcXBPaWNzSUdVZ0ppWWdaUzV0WlhOellXZGxLU2s3Q25ObGNuWmxjall1YkdsemRHVnVLRkJQVWxRc0lDYzZPakVuS1RzSw0KOjpFWEFNUExFUzo6DQpJeURyckxqcXRhd2c3TGFVN0xLY0lPeVlpT3lMbkFvS0l1dXN1T3ExckNEc3RwVHNzcHpyc0p2cXVMQWk2ckNBSU95Q3JPeWFxZTJWbU91S2xDRHNtSWpzaTV3ZzY2cW83SjJNN0o2RjY0dUk2NHVrTGlBcUt1eWR0Q0R0akl6c25ienNuWVFnN0lpWTdLQ1Y3WldjSU91U3BDRHRoTERycjdqcmhKRHNsNURzaEp3Z1lHNXdiU0J5ZFc0Z1luVnBiR1JnNjZXOElPeUxwTzJXaWUyVm1PcXpvQ3dnUm1sbmJXSHNsNURzaEp3ZzdaU002NStzNnJlNDdKMjQ3SjJFSU91THBPeUxuQ0RzaTZUdGxvbnRsWmpycWJRZzY3Q1k3SmlCNjVDcDY0dUk2NHVrTGlvcUNnb2pJeURzbnBIc2hMRWc2N0NwNjdLVkNnb3RJT3lZaU95TG5DRHRsWmpyZ3BqcmlwUWdLaXBnSXlNaklPeWJrT3V6dUdBcUtpRHRsWndnN0tTRTZyTzhMQ0RxdDdnZzdKV0U2NTZZSUNvcVlDMGc3TGFVN0xLYzdKV0lZQ29xSU95WHJPdWZyQ0Rxc0p6cm9ad2c3SjIwNjZTRTdLZVI2NHVJNjR1a0xnb3RJT3kybE95eW5PeVZpQ0RzbFlqc2w1RHNoSndnS2lycw0KcElUc25ZUWc2N0NVNnI2NDZyT2dJT3lMdHV5Y3ZPdXB0Q0JnSUM4Z1lDQW83SldlNjVLa0lPcXp0ZXV3c1NEdGo2enRsYWdnN0lxczY1Nlk3SXVjS1NvcUlPdWhuQ0R0a1p6c2k1enRsWmpzaExqc21wUXVJTzJVak91ZnJPcTN1T3lkdU95WGtPeUVuQ0Rya1pBZzdLU0U2NkdjSU91enRPeVhyT3lua2V1TGlPdUxwQzRLTFNEc2dxenNtcW5zbnBEcXNJQWc3SjZGNjZDbDdaV2NJT3VzdU9xMXJPcXdnQ0JnN0p1UTY3TzRZT3F6dkNBbzZyTzE2N0N4d3JmcnJManNucVhydG9EdG1MZ2c2NnkwN0l1YzdaV1k2ck9nS1NEcXNKbnFzYkRyZ3Bnc0lPeUVuT3VobkNEdGo2enRsYWp0bFpqcnFiUWc2cmU0SU95MmxPeXluT3lWaU91VHBPeWRoQ0RyczdUc2w2enNwSTNyaTRqcmk2UXVDaTBnNjZlazdMbXQ3WldnSU91VmpDQXFLdXVuaU95S3BPMkN1ZXVRbkNEc25iVHJwb1FvN1ptTlhDcnJqNWtwTENEc2lLdnNucEFvN0tDRTdabVU2N0tJN1ppNHdyY2k3Sm00SURMcnFvVWlJT3VUc1NucmlwUWc2NnkwN0l1Y0tpcnQNCmxhbnJpNGpyaTZRZzRvQ1VJT3lkdE91bWhNSzM3SWlZNjUrSndyZnJzb2p0bUxqcnA0d2c2NHVrNjZXNElPdXN1T3Exck91UGhDRHFzSm5zbllBZzdKaUk3SXVjNjZHY0lPeWVvZTJZZ095YWxDNGc2NHVvTENEc3RwVHNzcHpzbFlqc2w1QWc3S0NCN0phMDY1R1VJT3lkdE91bWhNSzM3SWlyN0o2UTY0cVVJT3EzdU91TWdPdWhuQ0RyZ3Bqc21LVHJpNGdnN0l1azdLQ2NJT3F3a3V5WGtDRHJwNTdxc293ZzZyT2c3TE9RSU95VHNPeUV1T3lhbEM0S0xTRHNvSnpycXFrb1lDTWpZQ25xczd3Z1lDTWpJMkFzSUdBdFlDRHF1TER0bUxqcmlwUWc3WmlWN0l1ZDdKMjA2NHVJSU91d2xPcSt1T3luZ0NEcnA0anNoTGpzbXBRdUNnb2pJeURzaXFUdGc0RHNuYndnN0p1UTdMbVpJQ2pzc0xqcXM2QWc0b0NVSU95ZWtPeUV1TzJWbkNEcmdyVHNtcW5zbllBZ2RYZ3RkM0pwZEdsdVp5NXRaQ0Rxc0lEc25iVHJrNXdwQ2dvdElPMlZ0T3lhbE95eXRDd2c2N2FBNjVPYzY1K3M3SnEwSU95aWhlcXlzQ2hnZnV5ZWlPeVd0T3lhDQpsR0FnWUg3cmo3enNtcFJnSUdCKzdKZUc3SmEwN0pxVVlDQmdmdTJWdENEc283enNoTGpzbXBSZ0tRb3RJRExyaTZnZzZyV3M3S0d3T2lBcUt1eXlxeURzcElROTdJT0I3Wm1wSU95RXBPdXFoU0RpaHBJZzY1R1k3S2U0SU95a2hEM3JpNlRzbll3ZzdaYUo2NCtaS2lvbzZyS3c3S0NWN0oyQUlHQis3WldnNnJtTTdKcVVQMkFzSU8yV2lldVBtU0RzbktEcmo0VHJpcFFnWUg3dGxiUWc3S084N0lTNDdKcVVZQ2tLTFNEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0tPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ2tzSU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBbzdKZUc3SmEwN0pxVTRvYVNmdTJWbU91cHRDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDa0tMU0RzdXBEc283enNscnp0bFp3ZzZySzk3SmEwS0g3c2k1enFzcURzbHJUc21wUS80b2FTZnUyVm9PcTVqT3lhbEQ4cExDRHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNDanNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2M0b2FTN0o2VQ0KN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrS0xTRHFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NBbzdLQ0U3SWFoNG9hUzY3TzA2NEswNjR1a0tTd2c2N2FBN0tDVklPeURnZTJacWV1UGhDRHJsTEhybExIdGxaanNwNEFnN0pXSzZyS01LQ0xzc0w3cXVMQWc3SXVrN1l5b0l1S2RqQ0FpN0xDKzdKMkVJT3lJbUNEc2w0YnNsclRzbXBRaTRweUZLUW9LSXlNZzdMYVU3TEtjSU95WWlPeUxuQW9LSXlNaklPeW5oTzJXaWUyVm1PdU5tQ0RzbnBIc2w0WHNuYlFnN0o2STdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3S2VFN1phSklPeWtrZXlkdUNEcmdyVHNsNjNzbmJRZzdKNkk3SmEwN0pxVUxpQXZJT3lkdE95V3RPeUVuQ0RzcDRUdGxvbnRsYURxdVl6c21wUS9DZ29qSXlNZzZyTzE3SnlnSU95YWxPeXlyZXlkaENEc3Q2anNob3p0bFpqcnFiUWc3SnFVN0xLdElPdUN0T3lYcmV5ZHRDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTNxT3lHak8yVm1PeUwNCm5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc3Q2anNob3p0bGFBZzZySzk3SnF3SU95YWxPeXlyU0RyZ3JUc2w2M3JqNFFnN0lLdDdLQ2M2NCs4N0pxVUxpQXZJT3F6dGV5Y29DRHNtcFRzc3Ezc25ZUWc3TGVvN0lhTTdaV2c2cm1NN0pxVVB3b0tJeU1qSU9xNHNPcTRzT3VsdkNEc3NMN3NwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WldZN0lTNDdKcVVMZ290SU9xNHNPcTRzT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlXdE95YWxDNGdMeUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXWTZyaXdJT3lnaE95WGtPdUtsQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxBb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0tlQTZyaUlJT3V5DQpoT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwSU95anZPeUV1T3lhbEM0Z0x5RHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2lNakl5RHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4S0xTRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhLTFNEc2k2RHFzNkFnN0oyMDdKeWc2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0o2VQ0KN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDaTBnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxnb0tJeU1qSU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c3Sm00SURMcnFvWHNsNURxc293ZzZyYU03WldjSU95Q3JleWduQ0RzbFl6cnByenRocUhzbllRZzdLQ0U3SWFoN1pXZzZybU03SnFVUHdvdElPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdE91Z3BPcXpvQ0R0bGJUc21wUXVJQzhnN1ptTkt1dVBtU2d3TVRBdE1USXpOQzAxTmpjNEtTRHJpNWdnN0ptNElETHJxb1hzbDVEcXNvd2c2N08wNjRLODZybU03SnFVUHdvdElPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnNjR1WUlPeVp1Q0F5NjZxRjdKZVE2cktNSU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN2T3E1ak95YWxEOEtMU0RxdG96dGxad2cNCjdJS3Q3S0NjSU95VmpPdW12TzJHb2V5ZGhDRHRtWTBxNjQrWktEQXhNQzB4TWpNMExUVTJOemdwSU91TG1DRHNtYmdnTXV1cWhleVhrT3F5akNEcnM3VHJncnpxdVl6c21wUS9DZ29qSXlNaklPMlpsZXlkdU1LMzZyS3c3S0NWSU8yTW5leVhoUW9LSXlNaklPeWdsZXVua0NEc2dxM3NvSnp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95Q3JleWduT3VRbkNEcmpiRHNuYlR0aExEcmlwUWc2N08xNnJXczdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEcmtKanJqNHpycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc29KWHJwNUFnN0lLdDdLQ2M3WldnNnJtTTdKcVVQd29LSXlNaklPdXpnT3F5dmV5Q3JPMlZyZXlkdENEc29JRHNucVhya0pqc3A0QWc3SldLN0pXWTdJcTE2NHVJNjR1a0xpRHJncGpxc0lEc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKV0U3S2VCSU95Z2dPeWVwZTJWbU95bmdDRHNsWXJzbllBZzY0SzA3SnFwN0oyMElPeWVpT3lXDQp0T3lhbEM0Z0x5RHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4S0NpTWpJeURyb1p6cXQ3anNsWVRzbTRNZzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3Vobk9xM3VPeVZoT3liZysyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbGJIc25ZUWc3S0tGNjZPTTdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3lWc2V5ZGhDRHNvb1hybzR6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nN1pXY0lPdXlpQ0RyczREcXNyM3RsWmpycWJRZzY0dWs3SXVjSU91emdPcXl2ZTJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzY0dWs3SXVjSU91d2xPcS9nQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6aE95R2plMlZvT3E1ak95YWxEOEtDaU1qSXlEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpya0tucmk0anJpNlF1SU95MGlPcTRzTzJabE8yVg0KbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpyajd6c21wUXVJQzhnN0xTSTZyaXc3Wm1VN1pXZzZybU03SnFVUHdvS0l5TWpJeURzbDVEcm42ekN0K3lMcE8yTXFBb0tJeU1qSU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU91RXBPMkt1T3liak8yQnJPeVhrQ0RzbDdEcXNyRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzbDdEcXNyQWc3SU9CN1lPYzY2VzhJTzJabGV5ZHVPMlZtT3F6b0NEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPdXduT3lEbmUyV2lPeUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNuYnpzaTV6c29JSHMNCm5iZ2c3SmlrNjZXWTZyQ0FJT3lEbmVxeXZPeVd0T3lhbEM0Z0x5RHNucURzaTV3ZzdadUVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZoT3lkdE91VWxDRHJtSkRyaXBRZzY3bUU2N0NBNjdLSTdaaTQ2ckNBSU95ZHZPeTVtTzJWbU95bmdDRHNsWXJzaXJYcmk0anJpNlF1Q2kwZzdKV0U3SjIwNjVTVUlPdVlrT3VLbENEcnVZVHJzSURyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwM3Jzb2p0bUxqcXNJQWc3SjI4N0xtWTdaV1k3S2VBSU95Vml1eUt0ZXVMaU91THBDNEtMU0RzbmJqc3BwM3Jzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeTBpT3F6dk91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0oyNDdLYWQ2N0tJDQo3Wmk0NjZXOElPeWVyT3V3bk95R29lMlZtT3lMcmV5TG5PeVlwQzRLTFNEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95bmdPdUNyT3lXdE95YWxDNGdMeURzbmJqc3BwM3Jzb2p0bUxqcnBid2c2NHVrN0l1Y0lPdXdtK3lWaENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzbHJUc21wUXVJQzhnNjR1azY2VzRJT3F5Z095RGlleVd0T3VobkNEcmk2VHNpNXdnN0xDKzdKV0U2N08wN0lTNDdKcVVMZ29LSXlNaklPeWdsZXV6dE91bHZDRHJ0b2pybjZ6c21LVHNwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNvSlhyczdUcnBid2c2N2FJNjUrczdKaXNJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHRqSXpzbmJ3Zw0KN0plRjY2R2M2NU9jN0plUUlPeUxwTzJNcU8yV2lPeUt0ZXVMaU91THBDNEtMU0R0akl6c25ienNuWVFnN0ppczY2YXM3S2VBSU91cXUrMldpT3lXdE95YWxDNGdMeURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3S0NRNnJLQUlPeWtrZXllaGV1TGlPdUxwQzRnN0oyMDdKcXA3SmVRSU91MmlPMk91T3lkaENEcms1enJvS1FnN0tPRTdJYWg3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEc2hKenJ1WVRzaXFUcnBid2c3S0NRNnJLQTdaV1k2ck9nSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSkRxc29Ec25iUWc2NEdkNjRLWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bFlUc2lKZ2c3SjZGNjZDbElPMlZyZXVxcWV5ZWhldUxpT3VMcEM0S0xTRHF2SzBnN0o2RjY2Q2w3WlcwN0pXOElPMlZtT3VLbENEdGxhM3JxcW5zbmJUc2w1RHNtcFF1Q2dvakl5TWpJT3Eyak8yVm5NSzM3SVNrN0tDVkNnb2oNCkl5TWc3TG0wNjZtVTY1MjhJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0lxMTY0dUk2NHVrTGlEc2hLVHNvSlhzbDVEc2hKd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc3ViVHJxWlRybmJ3ZzZyYU03WldjN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3TG0wNjZtVTY1MjhJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWak91bXZDRHF0b3p0bFp6c25iUWc2ckd3NjdhQTY1Q1k3SmEwSU95VmpPdW12T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEc2xZenJwcndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU91cHRDRHNob3pzaTUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdJU2s3S0NWN0plUTdJU2NJT3lWak91bXZPeWRoQ0Rzdkp3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Y2hPeTVtQ0Rzb0pYcnM3UWc3SjIwN0pxcDdKZVFJT3VQDQptZXlkbU8yVm1PeW5nQ0RzbFlyc2xZUWc3SjI4NjdhQUlPcTRzT3VLcGV5ZHRDRHNvSnp0bFp6cmtLbnJpNGpyaTZRdUNpMGc3SnlFN0xtWUlPeWdsZXV6dE91bHZDRHRsNGpzbXFudGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3SnlFN0xtWUlPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHNtWVRybzR6Q3QreW5oTzJXaVFvS0l5TWpJT3lnZ095ZXBldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNvSURzbnFYdGxvanNsclRzbXBRdUNnb2pJeU1nNjdPQTZySzk3SUtzN1pXdDdKMjBJT3lnZ2V5YXFldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzNERxc3IwZzY0SzA3SnFwN0oyRUlPeWdnZXlhcWUyV2lPeVd0T3lhbEM0S0NpTWpJeURzb0lUc2hxSHNuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dE91RGlPeVd0T3lhbEM0S0NpTWpJeURyazdIcg0Kb1ozc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdVRzZXVobmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWc3SUt0N0tDYzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeUNyZXlnbk8yV2lPeVd0T3lhbEM0S0NpTWpJeUR0Z2JUcnByM3JzN1RyazV6c2w1QWc2N08xN0lLczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0ZXlDck8yV2lPeVd0T3lhbEM0S0NpTWpJeURzbXBUc3NxM3NuWVFnN0xLWTY2YXNJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKcVU3TEt0N0oyRUlPeXltT3Vtck8yVm1PcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPeVZpT3VDdE1LMzdKeWc2NCtFQ2dvakl5TWc3SU9JNjZHYzdKcTBJT3V5aE95Z2hPeWR0Q0RzdHB6c2k1enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlPeVhoZXVOc095ZHRPMksNCnVDRHRtNFFnN0oyMDdKcXBJT3F3Z091S3BlMlZxZXVMaU91THBDNEtMU0RzZzRnZzY3S0U3S0NFN0oyMElPdUNtT3labE95V3RPeWFsQzRnTHlEc2w0WHJqYkRzbmJUdGlyanRsWmpycWJRZzdJT0lJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3SjIwN0pxcDdKMkVJT3ljaE8yVnRDRHNsYjNxdElBZzY0K1o3SjJZNnJDQUlPMlZoT3lhbE8yVnFldUxpT3VMcEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNpNXpzbnBIdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbnFYc2k1enFzSVFnNjYrNDdJS3M3SnFwN0p5ODY2R2NJT3lla091UG1TRHJvWnpxdDdqc2xZVHNtNE1nNjVDWTdKZUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPeVlwT3VlcSt1UG1leVZpQ0RzZ3F6c21xbnRsWmpzcDRBZzdKV0s3SldFSU91aG5PcTN1T3lWDQpoT3liZyt1UWtPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1RzbFlqc25ZUWc3SnlFN1pXMElPdTVoT3V3Z091eWlPMll1T3VsdkNEcnM0RHFzcjN0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEc2xZanNvSVR0bFp3ZzdJS3M3SnFwN0oyRUlPeWNoTzJWdENEcnVZVHJzSURyc29qdG1ManJwYndnNjdDVTZyK1VJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc2N08wN0pXSUlPeUVuT3U1aE95S3BBb0tJeU1qSU9xeXZldTVoT3VsdkNEcXNKenNpNXp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzZySzk2N21FNjZXOElPeUxuT3lla2UyVm9PcTVqT3lhbEQ4S0NpTWpJeURxc3IzcnVZVHJwYndnN1pXMDdLQ2M3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU9xeXZldTVoT3VsdkNEdGxiVHNvSnp0bGFEcXVZenNtcFEvQ2dvakl5TWc2cml3NnJpdzZyQ0FJT3lZcE8yVWhPdWR2T3lkdUNEc2c0SHRnNXpzbm9Ycg0KaTRqcmk2UXVJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbllRZzdabVY3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3E0c09xNHNPcXdnQ0RyaEtUdGlyanNtNHp0Z2F6c2w1QWc3SmV3NnJLdzY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJpdzZyaXc3SjJZSU95WHNPcXlzQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbUlIc2c0SHNuWVFnNjdhSTY1K3M3SmlrNjRxVUlPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0ppQjdJT0I3SjJFSU91MmlPdWZyT3lZcE9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3kzcU95R2pPMlZtT3lMcENEcXNyM3NtckFnN0l1ZzdMS3Q3WldZN0l1Z0lPdUMNCnRPeWFxZXlkZ0NEc29JRHNucVhya0pqc3A0QWc3SldLN0lxMTY0dUk2NHVrTGdvdElPeTNxT3lHak8yVm1PdXB0Q0RzaTZEc3NxM3RsWndnNjRLMDdKcXA3SjIwSU95Z2dPeWVwZXVRbU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9DaTBnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9JQzhnN0xlbzdJYU03WldZNjZtMElPeWVoZXVncGUyVm5DRHJnclRzbXFuc25iUWc3SUtzNjUyODdLQzQ3SnFVTGdvS0l5TWpJeURxc0lEc25iVHJrNXdnN0ppSTdJdWNJQ2gxZUMxM2NtbDBhVzVuTG0xazdKZVE3SVNjSU95WXJ1cTVnQ0RpZ0pRZzZyZWM3TG1aN0p5ODY2R2NJT3lla091UG1lMlpsQ0RycXJzZzdaV1k2NHFVSU91c3VPeWVwU0RzbnF6cXRhenNoTEVnN0lLczY2R0FLUW9LSXlNaklPeWVrT3VQbWV5d3FPdWx2Q0Rxc0lEc3A0RHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB3b3RJT3lla091UG1leXdxT3F3DQpnQ0Rzbm9qcmdwanNtcFEvQ2dvakl5TWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdWx2Q0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTTY0cVVJT3lXdk91bmlPeWR1T3F3Z095YWxEOEtDaU1qSXlEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvY2c2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1Q2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUhJT3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsWmpzaTV6cXNxRHNsclRzbXBRL0NpMGc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOEtDaU1qSXlEc2k1enNucEh0bFpqc2k1enJpcFFnNjdhRTdKZVE2cktNSURVc01EQXc3SnVRN0oyRUlPdVRuT3VncE95YWxDNEtMU0RzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEcw0KbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUxnb3RJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFF1Q2dvakl5TWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVMZ290SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQzRLQ2lNakl5RHF1SWpzbmJ6cXVZenNwNEFnNjYrNDY0S3BJT3lMbkNEc2w3RHNzclFnN0xLWTY2YXM2NUNwNjR1STY0dWtMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUNxZXUyZ08yVm1PeUxuT3E0c0NEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUF2SU8yYmhPdTJpT3F5c095Z25DRHF1SWpzbGFIc25ZUWc2NEswN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lna09xeWdDRHF1TERxc0lUc2w1RHJpcFFnN0lTYzY3bUUNCjdJcWtJT3lkdE95YXFleWR0Q0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95TG9PdTJoT3ltblNEdG1aWHNuYmdnN0tDRTdKZVE2NHFVSU95R29lcTRpQ0Ryc0k4ZzZyS3c3S0NjNnJDQUlPdTJpT3F3Z08yVnFldUxpT3VMcEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU91emdPcXl2U0RzaTV3ZzdMcVE3SXVjNjdDeElPeWVyT3luZ09xNGlleWRnQ0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtDaU1qSXlEc2c0SHJpN1FnN1pLSTdLZUlJTzJXcGV5RGdleWRoQ0RzDQpuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkdENEcmhibnNuWXpya0tucmk0anJpNlF1Q2kwZzY0MlVJT3lpaSt5ZGdDRHNnNEhyaTdUc25ZUWc3SnlFN1pXMElPMkd0ZTJabENEcmdyVHNtcW5zbllBZzY0VzU3SjJNNjQrODdKcVVMZ29LSXlNaklPcXpvT3F3bmV1TG1PeWRtQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkZ0NEcXVMRHJvWjBnNnJTQTY2YXM2NUNwNjR1STY0dWtMZ290SU95ZHRPeWduT3UyZ08yRXNDRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWR0Q0RxdUxEcm9aM3JqN3pzbXBRdUNnb2pJeU1nN0xLdDdJYU02NFdFN0oyQUlPeUVuT3U1aE95S3BDRHFzSURzbm9Yc25iUWc2N2FJNnJDQTdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YQ0KbEM0S0NpTWpJeU1nNnJPRTdLQ1Z3cmZzbm9Ycm9LVUtDaU1qSXlEc2xZVHNuYlRybEpRZzY1aVE2NHFVSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWR0T3lEZ1NEc25wanJxcnNnN0o2RjY2Q2w3WldZN0plc0lPcXpoT3lnbGV5ZHRDRHNucURxdUlnZzdMS1k2NmFzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWVtT3VxdXlEc25vWHJvS1h0bGJUc2hKd2c2ck9FN0tDVjdKMjBJT3llb09xeXZPeVd0T3lhbEM0Z0x5RHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzdKNnM3SVNrN0tDVjdaV1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25iVHJyN2dnN0lLczdKcXBJT3lra2V5ZHVDRHNsWVRzbmJUcmxKVHNub1hyaTRqcmk2UXVDaTBnN0oyMDY2KzRJT3lUc09xem9DRHNub2pyaXBRZzdKV0U3SjIwNjVTVTdKaUk3SnFVTGlBdklPdUxwT3VsdUNEc2xZVHNuYlRybEpUcnBid2c3SjZGNjZDbDdaVzANCklPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2dxenNtcW50bGFBZzdJaVlJT3lYaHV1S2xDRHJ1WVRyc0lEcnNvanRtTGpzbm9Ycmk0anJpNlF1SU95WWdldXN1Q3dnN0lpcjdKNlFMQ0R0aXJuc2lKanJyTGpzbnBEcnBid2c3WStzN1pXbzdaV1k3SmVzSURqc25wQWc3SjIwN0lPQklPeWVoZXVncGUyVm1PeUxyZXlMbk95WXBDNEtMU0RzbUlIcnJMZ3NJT3lJcSt5ZWtDd2c3WXE1N0lpWTY2eTQ3SjZRNjZXOElPMlByTzJWcU8yVnRDQTQ3SjZRSU95ZHRPeURnU0Rzbm9Ycm9LWHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3llaGV1Z3BTRHFzSURyaXFYdGxad2c2cmlBN0o2UUlPeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnN0o2RjY2Q2w3WldnSU95SW1DRHNub2pyaXBRZzZyaUE3SjZRSU95SW1PdWx2Q0RyaEpqc2w0anNsclRzbXBRdUlDOGc2NEswN0pxcDdKMkVJT3loc09xNGlDRHNwSVRzbDZ3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEdGpJenNuYnpDdCtxeXNPeWduTUszDQo2cml3N1lPQUNnb2pJeU1nN1l5TTdKMjhJT3lhcWV1ZmlleWR0Q0RzdElqcXM3enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlERXdUVUlnN0oyMDdaV1k3SjJZSU8yTWpPeWR2T3VuakNEc2w0WHJvWnpyazV3ZzZyQ0E2NHFsN1pXcDY0dUk2NHVrTGdvdElERXdUVUlnN0oyMDdaV1lJTzJNak95ZHZPdW5qQ0RzbUt6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHRqSXpzbmJ3ZzdKcXA2NStKN0oyRUlPMlpsZXlkdU8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0dWs3SnEwNjZHYzY1T2M2ckNBSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyaTZUc21yVHJvWnpyazV6cnBid2c2NmVJN0xPazdKYTA3SnFVTGdvS0l5TWpJT3F5c095Z25PeVhrQ0RzaTZUdGpLanRsWmpzbUlEc2lyWHJpNGpyaTZRdUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEcXNyRHNvSnp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPcXlzT3lnbkNEcw0KaUpqcmk2anNuWVFnN1ptVjdKMjQ3WldZNnJPZ0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WldZN0plc0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xenRlcXdoT3lkaENEdG1aWHJzN1R0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BDRHNwSURydVlRZzdLU1I3SjZGNjR1STY0dWtMZ290SU95a2dPdTVoTzJWbU9xem9DRHNub2pyaXBRZzZyaXc2NHFsN0oyMDdKZVE3SnFVTGlBdklPeWhzT3E0aU91bmpDRHF1TERyaTZUcm9LUWc3S084N0lTNDdKcVVMZ29LSXlNaklPdVRzZXVoblNEcXNJRHJpcVh0bFp3ZzdMV2M2NHlBSU9xd25PeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHMNCmlyWHJpNGpyaTZRdUNpMGc2NDJVSU91VHNldWhuZTJWbU91Z3BPdXB0Q0RxdUxEc29iUWc3Wld0NjZxcDdKMkVJT3lDcmV5Z25PMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3kybE9xd2dDa0tDaU1qSXlEc3RwenJqNWtnN0pxVTdMS3Q3SjIwSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3TGFjNjQrWklPeWFsT3l5cmV5ZGhDRHNvSkhzaUpqdGxvanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cks5NjdtRUlPeURnZTJEbk91bHZDRHRtWlhzbmJqdGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU9xeXZldTVoQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnDQo3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPeWdoTzJabU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPdXdsT3EvZ09xNWpPeWFsRDhLQ2lNakl5RHJzS25yckxnZzdKaUk3Slc5N0oyMElPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnNLbnJyTGdnN0ppSTdKVzk3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEcnVZVHJzSURyc29qdG1MZ2dOZTJhakNEc21LVHJwWmpyb1p3ZzZyT0U3S0NWN0oyMElPeWVvT3E0aUNEc3NwanJwcXpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJRFh0bW93ZzdKNlk2NnE3SU95ZWhldWdwZTJWdE95RW5DRHFzNFRzb0pYc25iUWc3SjZnNnJLODdKYTA3SnFVTGlBdklPdTVoT3V3Z091eWlPMll1T3VsdkNEc25xenNoS1Rzb0pYdGxaanJxYlFnNjR1azdJdWNJT3lkdE95YQ0KcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3SUNqc2w0YnNsclRzbXBRZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUXBDZ29qSXlNZzY3TzQ3SjI0SU95ZHVPeW1uZXlkaENEdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0Ryczdqc25iZ2c3SjI0N0thZDdKMkVJTzJWbU91cHRDRHJxcWpyazZBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95ZHRPdXBsT3lkdkNEc25ianNwcDBnN0tDRTdKZVE2NHFVSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lkdE91cGxPeWR2Q0RzbmJqc3BwM3NuWVFnNjZlSTdMbVk2Nm0wSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3kvb08yUHNPeWRnQ0Ryb1p6cXQ3anMNCm5iZ2c3WnVFN0plUTY2ZU1JT3lDck95YXFTRHFzSURyaXFYdGxhbnJpNGpyaTZRdUNpMGc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeS9vTzJQc095ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnI3anNoTEhyaFlUc25wRHJpcFFnNjdPMDdaaTQ3SjZRSU91UG1leWRtQ0RzbDRic25iUWc2ckt3N0tDYzdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnNjdPMDdaaTQ3SjZRNnJDQUlPdVBtZXlkbU8yVm1PdXB0Q0Rxc3JEc29KenRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxJVHJvWnp0bFlUc25ZUWc2NU94NjZHZDdaV1k3S2VBSU95Vml1eWN2T3VwdENEc25iVHNtcW5zbmJRZzdLQ2M3WldjNjVDcDY0dUk2NHVrTGdvdElPMlVoT3Vobk8yVmhPeWRoQ0RyazdIcm9aM3RsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbGJFZzY3S0U3S0NFN0oyMElPdUNydXlWaENEc25ienJ0b0FnNnJpdzY0cWw3SjIwDQpJT3lnbk8yVm5PdVFxZXVMaU91THBDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXWTY2bTBJT3VxcU91VG9DRHF1TERyaXFYc25ZUWc3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzY3aVU2Nk9vN1lpczdJcWs2ckNBSU9xNnZPeWd1Q0Rzbm9qc2xyUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU91NGxPdWpxTzJJck95S3BPdWx2Q0Rzdkp6cnFiUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU91NWhPeURnU0RzbDdEcm5iM3NzcGpxc0lBZzY1T3g2NkdkNjVDWTdLZUFJT3lWaXV5Vm1PeUt0ZXVMaU91THBDNEtMU0RydVlUc2c0RWc3SmV3NjUyOTdMS1k2Nlc4SU91VHNldWhuZTJWbU91cHRDRHF1TFRxdUludGxhQWc2NVdNSU91NW9PdWx0T3F5akNEc2w3RHJuYjNyazV6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzdHB6c25vVWc3TG0wNjVPYzZyQ0FJT3VUc2V1aA0KbmV1UW1PeW5nQ0RzbFlyc2xZUWc3SUtzN0pxcDdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0xhYzdKNkZJT3k1dE91VG5PdWx2Q0RyazdIcm9aM3RsWmpycWJRZzY3Q1U2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3SUNqc21ZVHJvNHdnN0pXSTY0SzBLUW9LSXlNaklPMmFqT3lia09xd2dPeWVoZXlkdENEc21ZVHJvNHpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNnJDQTdKNkY3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEc21JanNsYjNzbmJRZzdMZW83SWFNNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95WWlPeVZ2ZXlkaENEc3Q2anNob3p0bG9qc2xyVHNtcFF1Q2dvakl5TWc2Nnk0N0oyWTZyQ0FJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdJaWM3TENvN0tDQjdKeTg2NkdjSU91THRldXpnT3VUbk91bXJPcXlvT3lLdGV1TGlPdUxwQzRLTFNEcnJManNuWmpycGJ3ZzdLQ1I3SWlZN1phSTdKYTANCjdKcVVMaUF2SU95SW5PeUVuT3VNZ091aG5DRHJpN1hyczREcms1enJwclRxc296c21wUXVDZ29qSXlNZzdJU2s3S0NWN0oyMElPeTBpT3E0c08yWmxPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNoS1Rzb0pYc25ZUWc3TFNJNnJpdzdabVU3WmFJN0phMDdKcVVMZ29LSXlNaklPdTVoT3V3Z091eWlPMll1T3F3Z0NEcnM0RHFzcjNya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJT3V3bE9xL3FPeVd0T3lhbEM0S0NpTWpJeURzbmJqc3BwM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdU95bW5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1qSU95NmtPeWp2T3lXdk8yVm5DRHFzcjNzbHJRZ0tPeW5pT3VzdUNEc25xenF0YXpzaExFcENnb2pJeU1nN0phNDdLQ2NJT3V3cWV1c3VPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Ryc0tucnJMZ2c2NEtnN0tlYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SmEwDQo2NWFrSU91d3FldXlsZXljdk91aG5DRHNuYmpzcHAzdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SjI0N0thZElPdXdxZXV5bGV5ZGhDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPcXlzT3lnbk8yVm1PeUxwQ0RzdWJUcms1enJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rxc3JEc29KenRsYUFnN0xtMDY1T2M2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0p1UTdaV1k3SXVjNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsWmpzaExqc21wUXVDaTBnN0p1UTdaV1k2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWp2T3lHak91bHZDRHNsWXpxczZBZzZyT0U3SXVnNnJDQTdKcVVQd290SU95anZPeUdqT3VsdkNEc2xZenFzNkFnN0o2STY0S1k3SnFVUHdvS0l5TWpJeURycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQW9LSXlNaklPcTRzT3F3aENEcg0KcDR6cm80enJvWndnN0oyMDdKcXA3SjIwSU95a2tleW5nT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzbmJUc21xa2c2cml3NnJDRTdKMjBJT3VCbmV1Q21PeUVuQ0RzcDREcXVJanNuWUFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SnFwNjUrSklPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0lEc25xWHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lnZ095ZXBlMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVDZ29qSXlNZzdZYTE3SXVnSU95WXBPdWxtT3VobkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXWTdKaUE3SXExNjR1STY0dWtMZ290SU8yR3RleUxvT3lkdENEc201RHRtWnp0bFpqc3A0QWc3SldLN0pXRUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWcNCjZyYU03WldjSU91MmdPeWhzZXljdk91aG5DRHNvSkhxdDd6c25iUWc2ckd3NjdhQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SmEwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHF0b3p0bFp6c25ZUWc3SnFVN0xLdDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc3SU9CN1ptcElPeVZpT3VDdENBb011dUxxQ0RxdGF6c29iQXBDZ29qSXlNZzdKNkY2NkNsN1pXWTdJdWdJT3lqdk95R2pPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc2NHVrN0l1Y0lPMlpsZXlkdUNEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0tPODdJYU02Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3VMcE95TG5DRHRtWlhzbmJqdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWFsT3l5cmUyVm1PeUxvQ0R0anBqc25iVHNwNERycGJ3ZzdMQys3SjJFSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdZNlk3SjIwN0tlQTY2VzhJT3l3DQp2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95anZPeUdqT3VsdkNEdG1aWHNuYmp0bFpqcXNiRHJncGdnN1ptSTdKeTg2NkdjSU95ZHRPdVBtZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjQrWjdKMjg3WldjSU95YWxPeXlyZXlkdENEc3NwanJwcXdnN0tTUjdKNkY2NHVJNjR1a0xpRHNucURzaTV3ZzdadUVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc2ckNaN0oyQUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanFzNkFnN0o2STdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYlRyc3FUdGlyanFzSUFnN0tLRjY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdE91eXBPMkt1T3F3Z0NEcmdaM3JncXpzbHJUc21wUXVDZ29qSXlNZzdZT0k3WWUwSU95TG5DRHJxcWpyazZBZzY0Mnc3SjIwN1lTdzZyQ0FJT3lDcmV5Z25PdVFtT3Vwc0NEcnM3WHF0YXp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0Sw0KTFNEdGc0anRoN1R0bFpqcnFiUWc2NnFvNjVPZ0lPdU5zT3lkdE8yRXNPcXdnQ0RzZ3Ezc29KenJrSmpxczZBZzY0dWs3SXVjSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95Z2xldW5rQ0R0ZzRqdGg3VHRsYURxdVl6c21wUS9DZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeURnZTJacVNEc2xZanJnclFwQ2dvakl5TWc2N2FBN0o2c0lPeWtrU0Ryc0tucnJManNucERxc0lBZzZyQ1E3S2VBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91MmdPeWVyQ0RzcEpIc2w1QWc2N0NwNjZ5NDdKNlE2ckNBSU95ZWlPeVhpT3lXdE95YWxDNGdMeURzbUlIc2c0SHNuWVFnN1ptVjdKMjQ3WlcwSU91enRPeUV1T3lhbEM0S0NpTWpJeURxc3IzcnVZUWc3WlcwN0tDY0lPcTJqTzJWbk95ZHRDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZySzk2N21FSU8yVnRPeWduQ0RxdG96dGxaenNuYlFnN1pXRTdKcVU3WlcwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHNtcFRzc3EzdGxiUWcNCjdLTzg3SVM0N0pxVUxnb0tJeU1qSU8yWmxPeWVyQ0Rxc0pEc3A0RHF1TEFnNjdDdzdZU3c2NmFzNnJDQUlPdTJnT3loc2UyVnFldUxpT3VMcEM0S0xTRHRtWlRzbnF3ZzZyQ1E3S2VBNnJpd0lPdXdzTzJFc091bXJPcXdnQ0RzbHJ6cnA0Z2c3SmVHN0phMDdKcVVMaUF2SU91d3NPMkVzT3Vtck91bHZDRHF0WkRzc3JUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHN0cFhzbGIwZ0t5RHF1STNzb0pVZzdLQ0U3Wm1ZSUNqcmtaQWc2Nnk0N0o2bElPS0draURxdUkzc29KWHRtSlVnN1pXY0lPdXN1T3llcFNrS0NpTWpJeURycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0RyDQpzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRtSnp0ZzUwZzdKZUc3SjIwSU9xd2dPeWVoZTJWb09xNWpPeWFsRDhnN0tlQTZyaUlJT3lMb095eXJlMlZtT3luZ0NEc2xZcnNuTHpycWJRZzdKdXc3THUwSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzcDREcXVJZ2c3SXVnN0xLdDdaV1k2Nm0wSU95YnNPeTd0Q0R0bUp6dGc1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0wrZzdZK3dJT3lYaHV5ZHRDRHFzckRzb0p6dGxhRHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1Q0RzdjZEdGo3RHNuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUNpMGc3TCtnN1krdzdKMkVJT3V3bSt5Y3ZPdXB0Q0RyalpRZzdLQ0E2NkMwN1pXWTZyS01JT3F5c095Z25PMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95VmpPdW12Q0RzbDRic25iUWc3SXVjN0o2UjdaV2c2cm1NN0pxVQ0KUHlEc2xZenJwcnpzbllRZzdMeWM3S2VBSU95Vml1eWN2T3VwdENEc3BKSHNtcFR0bFp3ZzdJYU03SXVkN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU95VmpPdW12T3lkaENEc3ZKenJxYlFnN0tTUjdKcVU3WldjSU95R2pPeUxuZXlkaENEcnNKVHJvWndnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0o2UTY0K1o3SjIwN0xLMDY2VzhJT3VUc2V1aG5lMlZtT3luZ0NEc2xZcnFzNkFnNjRTWTdKYTA2ckNJNnJtTTdKcVVQeURyazdIcm9aM3RsWmpzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc25wRHJqNW5zbmJUc3NyVHJwYndnNjVPeDY2R2Q3WldZNjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJzN2dnNnJPRTdKVzk3SjJZSU95Y29PeWR2TzJWbkNEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3lkdk91d21PcTBnT3Vtck95ZWtPdWgNCm5DRHF0b3p0bFp6cnM0RHFzcjNzbllRZzdaV1k3SXVrSU95SW1DRHNsNGJzbHJUc21wUXVJT3lkdk91d21DRHF0SURycHF6c25wRHJvWndnNnJhTTdaV2NJT3V6Z09xeXZleWRoQ0RzbTVEdGxaanNpNlFnNnJLOTdKcXdJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla0NEcXRvenRsWnpzbllRZzdLZUE3S0NWN1pXMElPeWp2T3lMb0NEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVm5DRHJrcVFnN0oyODY3Q1lJT3EwZ091bXJPeWVrT3VobkNEcnM0RHFzcjN0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLTFNEcmk2VHJwYmdnN0lLczY1Nk03SjJFSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcm9ad2c3S2VBN0tDVjdaV1k2Nm0wSU91emdPcXl2ZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ289DQo6OkdVSURFOjoNCkl5QlZXQ0JYY21sMGFXNW5JT3F3Z095ZHRPdVRuQTBLRFFvakl5QXhMaUR0bGJUc21wVHNzclFOQ2cwSzdLQ2M3WktJSU95VmlPeWRtQ0RycXFqcms2QWc2Nnk0NnJXczY0cVVJQ2Z0bGJUc21wVHNzclFuNjZHY0lPeU5xT3lhbEM0TkN1eWR2T3EwZ095RXNTRHNub2pyaXBRZzdJS3M3SnFwN0o2UUlPcXl2ZTJYbU95ZGhDRHJwNHpyazZRZzdJaVlJT3llaU91UGhPdWhuU0FxS3V5RGdlMlpxU3dnNjZlbDY1Mjk3SjJFSU91MmlPdXN1TzJWbU9xem9DRHJxcWpyazZBZzY2eTQ2cldzN0plUUlPMlZ0T3lhbE95eXRPdWx2Q0Rzb0lIc21xbnRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHJzN1RyZzRYcmk0anJpNlFnNG9hU0lPdXp0T3VDdk9xeWpPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ01pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzQTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSU95MW5PdU1nTzJWbkNBcUt1dUtwZXVQbWUyWWxTRHJyTGpzbnFVcUt1eWRoQ0RzamFqc283enNoTGpzDQptcFF1SU95SW1PdVBtZTJZbFNEcnJManNucVhzbllBZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TVMzc2lKanJqNW50bUpVdDY2eTQ3SjZsN0oyRUxleU5xT3VQaEMzcmtKanJpcFF0NnJLOTdKcXdLZXlYa0NEdGxiVHJpN250bGFBZzY1V002NmVNSU95VHNPdUtsQ0Rxc293ZzdLS0w3SldFN0pxVUxnMEtEUW9qSXlNZzY1Q1E3SmEwN0pxVUlPS0draUR0bG9qc2xyVHNtcFFOQ2cwSzdKaUlLUTBLTFNEc2hLVHNvSlhya0pEc2xyVHNtcFFnNG9hU0lPeUVwT3lnbGUyV2lPeVd0T3lhbEEwS0RRb2pJeU1nSjM3c2w0Z25JT3U1dk9xNHNBMEtEUXJzbUlncERRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVURRb05DaU1qSXlEcmo1bnNncXdnNjdDVTZyK1U3Sk93NnJpd0RRb05DdXlZaUNrTkNpMGc2NGFTN0pXRTdLR003SmEwN0pxVUlPS0draURzbUt6cm5wRHNsclRzbXBRTkNnMEtLaW9xRFFvTkNpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBTg0KQ2cwSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEcnRvRHNvSlhzb0lFZzdMdWs2NjZrNjR1STdMeUE3SjIwN0lXWTdKMkVJT3kxbk91TWdPMlZuQ0RzcElUc25iVHFzNkFnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXlkaENEc2phanNvN3pzaExqc21wUXVEUXJydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVE10NjdhQTdLQ1Y3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzamFqc21wUXVEUW9OQ3V5WWlDQTZJT3lWaUNEcmo3enNtcFFzSU95WGh1eVd0T3lhbENBb1dDa2c0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSXlEc2w0YnNsclRzbXBRZzRvYVNJT3llaU95V3RPeWFsQTBLRFFyc21JZ3BEUW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxaanF1TEFnN0tDRTdKZVE2NHFVSU9xd2dPeWVoZTJWb0NEc2lKZ2cNCjdKZUc3SmEwN0pxVUlPS0draURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXMDdKVzhJT3F3Z095ZWhlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVURRb05DaU1qSXlEc2w1RHJuNndnNjZtVTdJdWM3S2VBRFFvTkN1eVhrT3VmckNEc2c0SHRtYW5zbDVEc2hKenJqNFFnSXUyVnRPcXlzQ0Ryc0tucnNwVWk3SjJFSU91b3ZPeWdnQ0RzbFl6cm9LVHNvN3pyaXBRZzZyaU43S0NWN1ppVklPcTFyT3loc091aG5DRHNqYWpzbXBRdURRb05DdXlZaUNrTkNpMGc3S2VBNnJpSUlPdXloT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0ZzRvYVNJT3lWc2V5ZGhDRHNsNFhyamJEc25iVHRpcmp0bGJUc283enNoTGpzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeTFuT3lMDQpvQ0Ryc29Uc29JVHNuYlFnN1pXRTdKcVU3WlcwN0pxVUxnMEtEUW82T2pvZ2RHbHdJTzJNbmV5WGhTRHJzb1R0aXJ6c25ZQWdXemd1SU8yTW5leVhoVjBnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbEEwSzdZeWQ3SmVGS091THBPeWR0T3lXdk91aG5PcTN1Q2tnNjdLRTdZcThJT3VzdU9xMXJPdUtsQ0RzbFlUcm5wZ2dLaW80TGlEdGpKM3NsNFVxS2lEc2hMbnNoWmdnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbENEaWdKUWc3WWExNjdPMDY0cVVJRnZ0bVpYc25iaGRMQ0RzbUlndjdKV0U2NHVJN0ppa0lPMk1rT3VMcU95ZGdDQmI3SldFNjR1STdKaWtYY0szVyt1RXBGMHNJT3VQbWV5ZWtTRHNuS0RyajRUcmlwUWdXK3kzcU95R2pGM0N0MXZyajVuc25wRmRMaUFpN0xlbzdJYU1JdXVLbENEcmo1bnNucEVnNjdLRTdZcTg2ck84SU95bm5leWR2Q0RybFl6cnA0d2c3Sk93NnJPZ0xDQWk2NHVyNnJpd0lNSzNJT3VQbWV5ZWtTTHNzcGpybjd3ZzdLZWQ3SjIwSU95VmlDRHJwNTdyaXBRZzdLR3c3WldwN0oyQQ0KSU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFvNk9qb05DZzBLSXlNaklPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzdKaUlLUTBLTFNEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzRvYVNJT3lWdmVxMGdPeVhrQ0RyajVuc25aanRsWmpycWJRZzY2cW83SjZFN0tlQTdKdVE2cmlJN0oyRUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvakl5TWc3WmljN1lPZElPdU1nT3lEZ1NEc2xZanJnclFOQ2cwS0tpcnNoSnpydVlUc2lxVHJpcFFnN0pPNElPeUltQ0Rzbm9qc3A0RHJwNHdzSU8yS3VleWdsU0R0bUp6dGc1M3NuWUFnNjdDYjdKMkVJT3lJbUNEc2w0YnNuWVFnNjVXTUlPS0draURxdUkzc29KWHRtSlVnNjZ5NDdKNmwNCjdKeTg2NkdjSU95TnFPeWFsQzRxS2cwSzdJS3M3SnFwN0o2UTY0cVVJT3VzdU9xMXJPdWx2Q0Rxdkx6cXZMenRub2dnN0oyOTdLZUFJT3lWaXVxem9DRHRtNUhzbHJUcnM3VHF1TEFvN0lxazdMcVVLU0RybFl6cnJManNsNUFzSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzazdEcnFiUWc3S0NjN1pLSUlPeWdoT3l5dE91bHZDRHNrN2dnN0lpWUlPeVhodXVMcE9xem9DRHNtS1R0bGJUdGxaanF1TEFnN0ltczdKdU03SnFVTGcwS0RRcnNtSWdwRFFvdElPcXpoT3lpakNEcXNKenNoS1FnN1ppYzdZT2Q3SjJBSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnTkM0MUpTRHF1SWpycHF3ZzdaaWM3WU9kNjZlTUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ05DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0QTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSUNkKzdJdWM2cktnN0phMDdKcVVQeWNzSUNmc2k1enJncGpzbXBRL0p5d2dKMzdxdTVnbklPcXdtZXlkDQpnQ0Rxczd6cmo0VHRsWndnNnJLOTdKYTA2Nlc4SU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFyc3RaenJqSUR0bFp3ZzdMcVE3S084N0phODdaV1k2ck9nSU95NW5PcTN2TzJWbkNEcnA1RHRpS3pycGJ3ZzdKT3c2NHFVSU9xeWpDRHNvb3ZzbFlUc21wUXVEUXJxc3Izc2xyVHJpcFFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNaTNxc3Izc2xyVHJwYnd0N0kybzY0K0VMZXVRbU91S2xDM3FzcjNzbXJBcDdKZVFJTzJWdE91THVlMlZvQ0RybFl6cnA0d2c3STJvN0pxVUxnMEtEUW9qSXlNZzY0K1o3SUtzN0plUTdJU2NJQ2QrN0l1Y0p5RHJ1YnpxdUxBTkNnMEs3SmlJS1EwS0xTRHN1YlRyazV6cnBid2c3WlcwN0tlQTdaV1k3SXVjNnJLZzdKYTA3SnFVUHlEaWhwSWc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOE5DaTBnN0l1YzdKNlI3WldZN0l1YzY0cVVJT3UyaE95WGtPcXlqQ0ExTERBd01PeWJrT3lkaENEcms1enJvS1RzbXBRdUlPS0draURzaTV6c25wSHRsWmpycWJRZw0KTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnMEtEUW9qSXlNZ0orcXpoT3lMbk91THBDY2c0b2FTSUNmc25vanJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKNlE2NCtaN0xDbzY2VzhJT3F3Z095bmdPcXpvQ0RxczRUc2k1enJncGpzbXBRL0lPS0draURzbnBEcmo1bnNzS2pxc0lBZzdKNkk2NEtZN0pxVVB3MEtMU0RycDZUcmk2d2c2N08wN1plWTY2T01JT3lXdk91bmlPeVVxU0RyZ3JUcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdUtsQ0RzbHJ6cnA0anNuYmpxc0lEc21wUS9JQ29vNjR1bzdJaWNJT3k1bU8yWm1PeWR0Q0RzbFlUcmk0anJuYndnNjZ5NDdKNmw3SjJFSU95RGlPdWhuQ0RzazdRZzdJS3M2NkdBN0ppSTdKcVVLU29OQ2cwS0l5TWpJQ2ZzbDZ6c3JZanJpNlFuSU9LR2tpQW43Wm1WN0oyNDdaV1k2NHVrTENEcnJMdnJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUg2ckNBN0tlQUlPdUwNCnBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVJT0tHa2lEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvZnFzSURzcDRBZzY0dWs3SXVjSU8yWmxleWR1TzJWb09xeWpPeWFsQzROQ2cwS0l5TWpJQ2ZxdTVnbklPS0draUFuN0plUTZyS01KdzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1PcTdtQ0RyZ3FEc2xZVHFzSURxczZBZzdKNkk3SmEwN0pxVUxpRGlocElnN1ptTjZyaTQ2NCtaNjR1WTdKZVE2cktNSU91Q29PeVZoT3F3Z09xem9DRHNub2pzbHJUc21wUXVEUW9OQ2lNakl5RHFzcjNzbHJUcnBid2c2N3FRN0oyRUlPdVZqQ0RzbHJUc2c0bnRsWndnNnJLOTdKcXdEUW9OQ3V5Q3JPeWFxZXlla095ZG1DRHNvSlhyczdUcnBid2c2N0NiNjRxVUlPeW5pT3VzdU95WGtPeUVuQ0RxdUxEcXM0VHNvSUhzbkx6cm9ad2dKMzdzaTV3bjY2VzhJT3U2a095ZGhDRHJsWXdnNjZ5NDdKNmw3SjIwSU95V3RPeURpZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLS2lydGpJenNsWVh0DQpsWmpxczZBZzdJdTI3SjJBSU95Z2xldXp0T3VsdkNBbjdLTzg3SmEwSit1aG5DRHNqYWpzaEp3ZzY2eTQ3SjZsN0oyRUlPeURpT3VocmVxeWpDRHNqYWpyczdUc2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VNZ095Mm5DRHJxcW5zb0lIc25iUWc2NnkwN0plSDdKMjQ2ckNBN0pxVVB3MEtMU0RzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhnNG9hU0lPeUxvT3F6b0NEc25iVHNuS0RycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lFdU95YWxDNE5DZzBLS2lvcURRb05DaU1qSURVdUlDZDc2NnFGN0lLc2ZTQXJJSHZycW9Yc2dxeDlKeURzazdEc3A0QWc3SldLNnJpd0RRb05DaU1qSXlEdGxaenNucERzbHJRZzdaS0E3SmEwN0pPdzZyaXdEUW9OQ3UyVm5PeWVrT3lXdENEcnFvWHNncXpycGJ3ZzdaS0E3SmEwN0lTY0lPdVBtZXlDckNEdG1KWHRnNXpyb1p3Zw0KN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdKMjA3SjZRSU8yWm1PdTJpT3lkaENEcnNKdnNsWmpzbHJUc21wUWc0b2FTSU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRTkNpMGc2NEswN0oyOElPeTV0T3VUbk9xd2t1eWR0Q0Rxc3JEc29KenJrS0FnN0ppSTdLQ1Y3SjIwN0plUTdKcVVJT0tHa2lEcmdyVHNuYnpzbllBZzdMbTA2NU9jNnJDU0lPdUNtT3F3Z091S2xDRHJncURzbmJUc2w1RHNtcFFOQ2cwS0l5TWpJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclRzazdEcXVMQWc3SmEwNjZDazdKcTRJT3F5dmV5YXNBMEtEUW9uZSt1cWhleUNySDNxc0lBZ2UrdXFoZXlDckgzdGxiVHNoSnduSU8yWWxlMkRuT3Vobk91bmpDRHRrb0RzbHJUc3BKanJqNFFnNjQyVUlPeTZrT3lqdk95V3ZPMlZtT3F5akNEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2NJT3Exck91bnBPMlZtT3luZ0NEcnFydnQNCmxvanNsclRzbXBRZzRvYVNJT3llbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3ZzZyV3M2NmVrN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEEwS0RRb3FLaW9OQ2cwS0l5TWdOaTRnN1pHYzZyaXdJTzJHdGV5ZHZBMEtEUW9qSXlNZzY1Q1k3SmEwN0pxVUlDaFlLU0RpaHBJZzY0Kzg3SnFVSUNoUEtRMEtEUXJycXFqcnNKVHNuYndnN1ptVTY2bTA3SjJZSU95aWdleWRnQ0RxczdYcXNJVHNuWVFnNnJPZzY2Q2s3WlcwSUNmcmtKanNsclRzbXBRbjY0cVVJT3VxcU91UmtDQW42NCs4N0pxVUordWhuQ0R0aHJYc25ienRsYlRzaEp3ZzdJMm83S084N0lTNDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ055NGc2NEtnN0tlY3dyZnNpNXpxc0lUQ3QreUlxK3lla0NEdGtaenF1TEFOQ2cwSzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt1eWlPMll1T3VLbENEc2xZVHJucGdnN1ppVjdJdWQ3Snk4NjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc21wUXVEUW9OQ2lNakl5RHJncURzcDV6Q3QreUxuT3F3aE1LMzZyaXc2ckNFDQpEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzY0S2c3S2VjSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRVlDQXZJT3lucCtxeWpDQmdUVTB1UkVSZ0lId2dNakF5TlM0d01TNHdNU3dnTWpVdU1ERXVNREVnZkEwS2ZDRHNpNXpxc0lRZ2ZDRHF1TERyczdnZ1lFaElPazFOT2xOVFlDQXZJT3lucCtxeWpDQmdTRWc2VFUxZ0lDanNtS1Rzb0lRdjdKaWs3WnVFSU95VmlDRHNsSUFwSUh3Z01UUTZNekE2TVRFc0lERXpPak13SUh3TkNud2c2cml3NnJDRUlId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVmbGxaV1ZrdVRVMHVSRVJnSUM4ZzdLZW42cktNSUdCWldWbFpMazFOTGtSRWZrMU5Ma1JFWUNCOElESXdNalV1TURFdU1ERitNakF5TlM0d01TNHpNU3dnTWpBeU5TNHdNUzR3TVg0d01TNHpNU0I4RFFwOElPdUNvT3lubkNBcklPeUxuT3F3aENCOElHQlpXVmxaTGsxTkxrUkVJRWhJT2sxTllDQjhJREl3TWpVdQ0KTURFdU1ERWdNVFE2TXpBZ2ZBMEtmQ0RzbXBUc25id2dmQ0JnV1ZsWldTNU5UUzVFUkNqc21wVHNuYndwWUNEaWdKUWc3SnVVTCsyWmxDL3NpSmd2NjZxcEwrcTRpQy90aHFBdjdKMjhJSHdnTWpBeU5TNHdNUzR3TVNqc2lKZ3BJSHdOQ2cwS0tpcnNpNXpxc0lRZzdKaUk3Sm00S2lvNklPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDQmc3SmlrN0tDRUwreVlwTzJiaENCSU9rMU5ZT3lkaENEc2phanJqNFFnNjQrODdKcVVMZzBLN0ppSUtTRHNtS1R0bTRRZ01Ub3dNQTBLRFFvakl5TWc2Nnk0N0o2bElPeUdqU0RzbDdEc201VHNuYndOQ2cwSzY2eTQ3SjZsSU95VmlPeVhrT3lFbk91S2xDQXFLdXlibE1LMzdKMjhJT3lWbnV5ZG1DQXc3SjJFSU91NXZPcXpvQ29xSU95TnFPeWFsQzROQ2cwSzdKaUlLUTBLTFNBeU1ESTI2NFdFSURBNDdKdVVJREExN0oyOElPeWVoZXVMaU91THBDNGc0b2FTSURJd01qYnJoWVFnT095YmxDQTENCjdKMjhJT3llaGV1TGlPdUxwQzROQ2cwS0l5TWpJT3lEZ2V1TWdDRHNpNXpxc0lRZ0tPdUZ1T3kybk95YXFTa05DZzBLZkNEc29iRHFzYlFnZkNEdGtaenF1TEFnZkEwS2ZDMHRMUzB0TFh3dExTMHRMUzE4RFFwOElEWXc3TFNJSU91dnVPdW5qQ0I4SU91d3FlcTRpQ0Rzb0lRZ2ZBMEtmQ0EyTU91MmhDRHJyN2pycDR3Z2ZDQk82N2FFSU95Z2hDQjhEUXA4SURJMDdJdWM2ckNFSU91dnVPdW5qQ0I4SUU3c2k1enFzSVFnN0tDRUlId05DbndnTXpEc25id2c2Nis0NjZlTUlId2dUdXlkdkNEc29JUWdmQTBLZkNBeE11cXduT3libENEcnI3anJwNHdnZkNCTzZyQ2M3SnVVSU95Z2hDQjhEUXA4SURFeTZyQ2M3SnVVSU95ZHRPeURnU0I4SUU3cmhZUWc3S0NFSUh3TkNnMEs3SmlJS1NEcnNLbnF1SWdnN0tDRUxDQTE2N2FFSU95Z2hDd2dNdXlMbk9xd2hDRHNvSVFzSURQc25id2c3S0NFTENBMjZyQ2M3SnVVSU95Z2hDd2dNdXVGaENEc29JUU5DZzBLSXlNaklPdW5pT3F3a01LMzZyaXc2ckNFSU91bmpPdWpqQTBLDQpEUXBnUkMxT1lDaE83SjI4SU91Q3FPeWRqQ2tnTHlCZ1JDMHdZQ2pzbUtUcmlwZ2c2NmVJNnJDUUtTQXZJR0JFSzA1Z0tFN3NuYndnNnJLOTZyTzhLUTBLN0ppSUtTQkVMVGNzSUVRdE1Td2dSQzB3TENCRUt6RU5DZzBLSXlNaklPdXlpTzJZdUNEdGtaenF1TEFnS08yVm1PeWR0TzJVaU95Y3ZPdWhuQ0RxdGF6cnRvUXBEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzdLQ0U3Wm1VNjdLSTdaaTRJSHdnN1pXWTdKMjA3WlNJSU9xMXJPdTJoQ0I4SURBeUxURXlNelF0TlRZM09Dd2dNREV3TFRFeU16UXROVFkzT0NCOERRcDhJT3k1dE91VG5PdXlpTzJZdUNCOElEVHNucERycHF6c2xLa2c3WldZN0oyMDdaU0lJSHdnTVRJek5DMDFOamM0TFRrd01USXRNelExTmlCOERRcDhJT3F6aE95aWpPdXlpTzJZdUNCOElPMlZtT3lkdE8yVWlDRHF0YXpydG9RZ2ZDQXhNak10TkRVMkxUYzRPVEF4TWlCOERRcDhJT3lqdk91dg0Kdk91VHNldWhuZXV5aU8yWXVDQjhJT3lWbmlBMjdKNlE2NmFzTGV1U3BDQTM3SjZRNjZhc0lId2dNVEl6TkRVMkxURXlNelExTmpjZ2ZBMEtmQ0RzZ3F6c2w0WHNucERyazdIcm9aM3Jzb2p0bUxnZ2ZDQXhNT3lla091bXJDRHRsWmpzbmJUdGxJZ2dmQ0F3TVMweU16UXROVFkzT0RrZ2ZBMEtEUW9qSXlNZzdKT3c2Nm0wSU95VmlDRHJrSmpyaXBRZzdaR2M2cml3RFFvTkNpMGc2NEtnN0tlYzdKZVFJTzJWbU95ZHRPMlVpTUszNjdtWDZyaUlPaURpbll3Z01qQXlOUzB3TVMwd01Td2dNREV2TURFTkNpMGc3SXVjNnJDRTdKZVFJT3lZcE95Z2hDL3NtS1R0bTRRNklPS2RqQ0RzbUtUc29JUWdNZXlMbkNBcUtPdUxxQ3dnN0lLczdKcXA3SjZRNnJDQUlPeW5nZXlna1NEcXM2RHJwYlRyaXBRZzY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSU95WWlPeVp1Q2txRFFvTkNpb3FLZzBLRFFvakl5QTRMaUR0akozc2w0VW82NHVrN0oyMDdKYTg2NkdjNnJlNEtRMEtEUXJ0akozc2w0VWc2Nnk0NnJXczY0cVUNCklDb3E3SmV0N1pXZ0tpb283WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZDbnFzN3dnS2lyc25LRHRtSlVxS2lqdGhyWHJzN1F2N1l5UTY0dW9LZXlYa0NEcmxMRHJuYndnNjZ5NDdMSzA2ckNBSU91THJPdWR2T3lhbEM0ZzdZT0E3SjIwN1l1QTdKMkVJT3VMcE91VHJPeWRoQ0RybFpBZzY3Q1k2NU9jN0l1Y0lPeVZpT3VDdENqcnM3anJyTGdwNnJtTTdLZUFJT3F3bWV5ZHRDRHJzN1RxczZBc0lPdXp1T3VzdUNEcnA2WHJuYjNzbllRZzY0dTA3SldFN0pXOElPMlZ0T3lhbEM0TkNnMEtJeU1qSUREcmk2anFzNFFnNG9DVUlPMkt1T3Vtck9xeHNPdTJnTzJFc0NEcnRKRHNtcFFOQ2cwSzdZeWQ3SmVGN0oyMElPeUNyT3lhcWV5ZWtPeWRtQ0RzbHJUcmxxUWc3WmFKNjQrWklPdVNwT3lYa0NEcm5LanJpcFRzcDRBZzY2aTg3S0NBSU8yTWpPeVZoZTJWdE95YWxDNE5DZzBLTFNEdGxvbnJqNW5zbllRZ0tpcnFzSURyb1p6cnA0bnFzYkRyZ3BnZzdZeVE2NHVvN0oyRUlPeWFsT3ExckNvcUtPeWR0TzJEDQppTUszN0lLdDdLQ2N3cmZyb1p6cXQ3anNsWVRzbTRQQ3QreWloZXVqakNrZzRvYVNJQ29xN1l5UTY0dW83WmlWS2lvZ0tPdXN2T3lXdE91MGtPeWFsQ2tOQ2kwZzZyS3c2ck84d3Jmc2c0SHRnNXpycGJ3Z0tpcnRoclhyczdUcnA0d3FLaUFvN0ptRTY2T013cmZzaTZUdGpLZ3BJT0tHa2lBcUt1eVZpT3VDdE8yWWxTb3FJQ2pzbFl6cm9LVHNwSmpzbXBRcERRb05DaU1qSXlEdGc0RHNuYlR0aTRBZzRvQ1VJT3lucCt5ZGdDRHJxb1hzZ3F6cXRhd05DZzBLTFNEcnFvWHNncXp0bUpYc25MenJvWndnNjRHZDY0SzA3SnFVTGlEc29vWHFzckRzbHJUcnI3akN0K3VuaU95NXFPMlJuT3VsdkNEc2s3RHNwNEFnN0pXSzdKV0U3SnFVSUNoKzdKcVVJQzhnZnV1THBDQXZJSDdxdVl6c21wUS9JT0tkakNrdURRb3RJREorTk95V3RPeWdpT3VobkNEc3A2ZnFzNkFnN0ltOTZyS01MaUR0bFp6c25wRHNsclRDdCt5SW1PeUxuZXlkaENEcXVManFzb3dnN0l5VDdLZUFJT3lWaXV5VmhPeWFsQzROQ2kwZzdKV0k2NEswS091eg0KdU91c3VDa2c2NmVsNjUyOTdKMkVJT3lhbE95VnZlMlZ0Q3dnS2lydGc0RHNuYlR0aTREcnA0d2c2N1NRNjQrRUlPdXN0T3lLcUNEdGpKM3NsNFhzbmJqc3A0QXFLaURzbFl6cXNvd2c3WlcwN0pxVUxpRHNtNURyczdqc25iUWdKK3lWak91bXZNSzM3Wm1WN0oyNEoreXltT3VmdkNEcnA0bnNsN0R0bFpqcnFiUWc2N080NjZ5NDdKMkVJT3Ezdk9xeHNPdWhuQ0RxdGF6c3NyVHRtWlR0bGJUc21wUXVEUW9OQ253ZzdKMjA2NkNINnJLTUlPdW5rT3F6b0NCOElPeWR0T3VnaCtxeWpDQjhEUXA4TFMwdGZDMHRMWHdOQ253ZzdLQ0E3SjZsN1pXWTdLZUFJT3lWaXVxem9DRHJncGpxc0lEc2k1enFzcURzbHJUc21wUS9JSHdnN0tDQTdKNmxJT3lWaUNEdGxad2c2NEswN0pxcElId05DbndnN0pXTTY2YThJSHdnNnJLdzdLQ2NJT3laaE91ampDQjhEUXA4SU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JSHdnNjQydzdKMjA3WVN3SU95Q3JleWduQ0I4RFFvTkNpTWpJeURzbFlqcmdyUW8NCjY3TzQ2Nnk0S1NEaWdKUWc3WlcwN0pxVTdMSzBEUW9OQ2kwZ0tpcnRqSkRyaTZqdG1KVXFLdXlkZ0NBbmZ1MlZvT3E1ak95YWxEOG42NkdjSU91c3ZPeVd0T3lhbEM0ZzY1Q1k2NCtNNjZhMElPeUltQ0RzbDRicmlwUWc3SnlFN1plWUtPeUNyZXlnbk1LMzdZT0k3WWUwSU91VHNTbnNuWUFnNnJLdzZyTzg2Nlc4SU91b3ZPeWdnQ0Rxc3IzcXM2RHRsYlRzbXBRdURRb3RJQ29xN0pXSTY0SzA3WmlWS2lyc25ZQWc3SUtzN0l1azdKMkVJT3lFbk95SW9PMlZ0T3lhbEM0TkNpMGc2NmVJN0xtbzdaR2M2Nlc4SU95TnFPeWFsQzRnN0lpcjdKNlF3cmZzb2JEcXNiUW83SjIwN0lPQndyZnNuYlR0bFpqQ3QreWR0T3VDdENEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaRHFzNkFzSU95YmtPdXN1T3lYa0NEc2w0YnJpcFFnN0tDVjY3TzB3cmZzb0lqc3NLakN0K3lYc091ZHZleXltT3VsdkNEc3A0RHNsclRyZ3JUc3A0QWc3SldLN0pXRTdKcVVMZzBLRFFvakl5TWc2N0tFN1lxOElPS0FsQ0RzbFlqcmdyUWc2Nnk0DQo2NmVsN0oyMElPeWdsZTJWdE95YWxBMEtEUXA4SU91enVPdXN1T3lkdENEc25iVHJvSWZyaTZRZ2ZDRHJzb1R0aXJ3Z2ZBMEtmQzB0TFh3dExTMThEUXA4SU9xeXNPcXp2TUszN0lPQjdZT2M2Nlc4SU8yR3RldXp0Q0I4SUZ2dG1aWHNuYmhkSUh3TkNud2dKMzd0bGFEcXVZenNtcFEvSit1aG5DRHJyTHpzbll3Z2ZDQmI3SldFNjR1STdKaWtYU0RDdHlCYjY0U2tYU0I4RFFwOElPeURnZTJacVNEc2hKenNpS0FnS3lEc21LVHJwYmpzcXIzc25iUWc3SXVrN0tDY0lPdVBtZXlla1NCOElGdnN0NmpzaG94ZElNSzNJRnQ3NjQrWjdKNlJmVjBnZkEwS0RRb3RJQ2ZzdDZqc2hvd242NHFVSUNvcTY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1LaW9nN0kybzdKcVVJQ2pzbUlnNklGdnN0NmpzaG94ZHdyZGI3SUt0N0tDY1hTa3VJQ2ZyaTZ2cXVMQWd3cmNnNjQrWjdKNlJKK3l5bU91ZnZDRHNwNTNzbmJRZzdKV0lJT3VubnV1S2xDRHNvYkR0bGFuc25iVHJncGdnNjR1bzY0K0ZJQ2ZzdDZqcw0KaG93bjY0cVVJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW90SU91eWhPMkt2T3lkbUNEcmo1bnNucEVnN0oyMDY2YUU3SjJBSU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGhDRHF0N2pyaklEcm9ad2c3SUswNjZDazdKcVVMZzBLRFFvakl5TWc3WWExN0tlY0lPeVlpT3lMbkEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdKMjA3WU9JS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURzb0lEc25xVWc3SldJSU8yVm5DRHJnclRzbXFrTkNpMGc3SldJNjRLME9pRHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4ZzdKNkY2NkNsN1pXY0lPdUN0T3lhcWV5ZHRDRHNncXpybmJ6c29ManNtcFF1RFFvdElPdXloTzJLdkRvZzdKV0U2NHVJN0ppa0lNSzNJT3VFcEEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdJS3Q3S0NjSUNqc25JVHRsNWdwS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURyamJEc25iVHRoTEFnN0lLdDdLQ2NEUW90SU95VmlPdUMNCnREb2c3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0RzZ3JUcnByUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzdJS3Q3S0NjN1pXZzZybU03SnFVUHcwS0xTRHJzb1R0aXJ3NklPeVZoT3VMaU95WXBDREN0eURyaEtRTkNnMEtLaXJyajVuc25wSHRtSlVnNG9DVUlPeUVuT3lJb0NBcklPdVBtZXlla1NEcnNvVHRpcndxS2cwS0xTRHRnNERzbmJUdGk0QTZJT3E0c09xNHNDRHNsN0Rxc3JBZzdaVzA3S0NjRFFvdElPeVZpT3VDdERvZzdJU2c3WU9kN1pXY0lPcTRzT3E0c095ZG1DRHNsN0Rxc3JEc25ZUWc2NEdLN0phMDdKcVVMZzBLTFNEcnNvVHRpcnc2SU95M3FPeUdqQ0RDdHlEc2w3RHFzckFnN1pXMDdLQ2NEUW9OQ2lvcTdKV0k2NEswN1ppVklPS0FsQ0RzbVlUcm80d2c3WWExNjdPMEtpb05DaTBnN1lPQTdKMjA3WXVBT2lEcXNyRHNvSndnN0ptRTY2T01EUW90SU95VmlPdUN0RG9nNnJLdzdLQ2M2ckNBSU95Z2xleURnU0Rzc3BqcnBxenJrSkRzbHJUc21wUXVEUW90SU91eWhPMkt2RG9nN1ptVjdKMjREUW9ODQpDaW9xS2cwS0RRb2pJT3lZaU95WnVDRHF0NXpzdVprTkNnMEs3SnVRN0xtWktPdUtwZXVQbWNLMzZyaU43S0NWd3Jmc3VwRHNvN3pzbHJ3cDY3TzA2NHVrSU95WWlPeVp1T3F3Z0NEcmpaUWc2NnFGN1ptVjdaV2NJT3k3cE91dXBPdUxpT3k4Z095ZHRPeUZtT3lkaENEcnA0enJrNXpyaXBRZzZySzk3SnF3N0ppSTdKcVVMZzBLRFFvakl5RHNtSWpzbWJnZ01TNGc3SWlZNjQrWjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqcmo0UWc2NUNZNjRxVUlPcXl2ZXlhc0EwS0RRb2pJeU1nN0lTYzY3bUU3SXFrSU95aWhldWpqQ3dnNnJpdzZyQ0VJT3Vuak91ampBMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWp2T3lXdENqc29vWHJvNHdnN0lTYzY3bUU3SXFrTENEcXVMRHFzSVFnNjVPeEtldWx2Q0Rxc0pYc29iRHRsYUFnN0lpWUlPeWVpT3F6b0N3Z0oreWloZXVqakNmc21ZQWdKK3Vuak91ampDZnNuWmdnNjRtWTdKV1o3SXFrNjZXOElPeWdsZTJabGUyZWlDRHNvSVRyaTZ6dGxhQWc3SWlZSU95ZQ0KaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNCUFQwOGc3SVNjNjdtRTdJcWtJT3lpaGV1ampDRHNsWWpyZ3JRZzRvQ1VJREF3N0p1VUlEQXc3SjI4NjdhQTdZU3dJT3lFbk91NWhPeUtwT3F3Z0NEc29vWHJvNHpyajd6c21wUXVJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWVFnN0pXTTY2Q2s2NU9jNjZDazdKcVVMZzBLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZzBLRFFycmk2Z3NJQ29xN0tPODZyaXc3S0NCN0p5ODY2R2NJT3lpaGV1ampPcXdnQ0Ryc0pqcnM3WHJrSmpyaXBRZzdLQ2M3WktJS2lyc2w1RHJpcFFnSit5aWhldWpqT3VQdk95YWxDZnJwYndnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURzb29Ycm80enJqN3pzbXBRZzRvYVNJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxBMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKZVENCjZyS01JT3V2dU95NW1PdUtsQ0RzbUlIdGxxWHNuWVFnN0pXTTY2Q2s3S1NFSU91VmpBMEtEUW9vN0tPODdKcVVJT3VQbWV5Q3JDQTZJT3lYc095eXRDd2c3WlcwN0tlQUxDRHNvSUhzbXFrZzY1T3hLUTBLRFFyc2lKanJqNW50bUpYc25MenJvWndnN0pPdzY2bTBJT3lkdU9xenZDRHF0SURxczRUcnBid2c2NnFGN1ptVjdaV1k2cktNSU95RXBPdXFoZTJWbU9xem9Dd2dKK3lDck95YXFleWVrT3lkbUNEdGxvbnJqNW5zbDVBZzY1U3c2NTI4N0ppazY0cVVJT3F5c09xenZDZnJuYnpyaXBRZzdLQ1E3SjJFSU95VmpPdWdwT3lraENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95WXBPdUttT3E1ak95bmdDRHJnclRzcDRBZzdKV0s3Snk4NjZtMElPeVhzT3l5dE91UHZPeWFsQzRnN1p1RTY3YUk2ckt3N0tDY0lPcTRpT3lWb2V5ZGhDRHJnclRzbzd6c2hManNtcFF1RFFvdElPdU1nT3kybk95ZGhDRHFzSWpzbFlUdGc0RHJxYlFnN0p1UTY1NllJT3VNZ095Mm5PeWR0Q0R0bGJUc3A0RHJqN3pzDQptcFF1SU95WXBPdUttQ0RyZ3FEc3A1enF1WXpzcDREc25aZ2c3SjIwN0o2UTY2VzhJT3lkZ08yV2lleVhrQ0RyZ3JUc2xid2c3WlcwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UUlPeVZpT3lMckNBbzdJaVk2NCtaN1ppVktRMEtEUW9uN0tDVjY3TzBJT3lJbU95bmtTRHNsWWpyZ3JRbklPdVRzZXlkbUNEcnI3enFzSkR0bFp3ZzdJT0I3Wm1wN0plUTdJU2NJQ29xN0l1YzdJcWs3WVdjN0oyMElPeWVrT3VQbWV5Y3ZPdWhuQ0Rzc3BqcnBxenRsWnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc3SWlZNjQrWjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeWR0T3lnbk91MmdPMkVzQ0R0bVkzcXVManJqNW5yaTVqc25aZ2c2ckNjN0oyNDdLQ1Y2N08wSU95ZHRPeWFxU0RyZ3JUc2w2M3NuYlFnNnJpdzY2R2Q2NCs4N0pxVURRb3RJT3VObENEc29vdnNuWUFnN0lPQjY0dTA3SjJFSU95Yw0KaE8yVnRDRHRoclh0bVpRZzY0SzA3SnFwN0oyQUlPdUZ1ZXlkak91UHZPeWFsQTBLRFFvakl5RHNtSWpzbWJnZ01pNGc2cks5N0phMDY2VzhJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3RFFvTkN1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKMllJT3VucGV1ZHZleWRoQ0R0bVp6c21xbnRsYlRzaEp3ZzdLZUk2Nnk0N1pXZ0lPdVZqQTBLRFFvbjdJdWM2NEtZN0pxVVB5Y3NJQ2ZzaGFqcmdwanNtcFEvSnlEdG1KWHRnNXpzblpnZzZySzk3SmEwNjZXOElPMlpuT3lhcWUyVnRPeUVuQ0RzZ3F6c21xbnNucERzblpnZzY0dTU3Wm1wN0lxazY1K3M3SnVBN0oyRUlPeWtoT3lkdkNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1Dd2cNClQwOVBJT3VMcE91RmdPeVlwT3lGcU91Q21PeWFsRDhOQ2kwZzdMYXA3S0NFN1pXWTY1K3NJTzJPdU95ZG1PeWdrQ0Rxc0lEc2k1enJncGpzbXBRL0RRb05DaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SU9CN1ptcDdKMkVJT3kybE95Z2xlMlZvQ0RybFl3TkNnMEs2NnFGN1ptVjdaV2NJT3lnbGV1enRPcXdnQ0RzbDRic2xyVHNoSndnN0lLczdKcXA3SjZRN0plUTZyS01JT3luZ2V5Z2tTRHRqSkRyaTZqdGxaanFzb3dnN1pXMDdKVzhJTzJWb0NEcmxZd2c2cks5N0phMDY2R2NJT3lnbGV5a2tlMlZtT3F5akNEc3A0anJyTGp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzY3Q2I3Snk4N0lXbzY0S1k3SnFVUHlEcms3SHJvWjN0bFpqcnFiUWc3THFRN0l1YzY3Q3hJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla095ZG1DRHNoS0RzblpqcXNJQWc3WldFN0pxVTdaV2dJT3VWakEwS0RRcnNoS1RyDQpyTGpzb2JEc2dxenNzcGpybjd3ZzdJS3M3SnFwN0o2UTdKMllJT3lFb095ZG1PdWx2Q0RxdUxEcmpJRHRsYlRzbGJ3ZzdaV2dJT3VWakNEcXNyM3NsclRyb1p3ZzdLQ1Y3S1NSN1pXWTZyS01JT3luaU91c3VPMlZ0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNuYlRyc29nZzY0dXM3SmVRSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxaanJxYlRzaEp3ZzdKYTg2NmVJNjRLWUlPdW5qT3loc2UyVm1PeUZxT3VDbU95YWxEOE5DZzBLSXlNZzdKaUk3Sm00SURNdUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPdVFtT3VLbENEcXNyM3NtckFOQ2cwSzdJS3M3SnFwN0o2UTdKZVE2cktNSU91cWhlMlpsZTJWbU9xeWpDRHJ0b0Rzb0pYc29JSHNuYmdnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3lrbU95VnZDRHRsYUFnNjVXTTY0cVVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3lpaSt5VmhPeWFsQzROQ2cwS0l5TWpJT3lFbk91NWhPeUtwT3VsdkNEc29KWHNzWVhzZzRFZw0KN0pPNElPeUltQ0RzbDRic25ZUWc2NVdNRFFvTkN1dTJnT3lnbGUyWWxleWN2T3VobkNEc2phanNsYndnN0lLczdKcXA3SjZRN0plUTZyS01JT3lEZ2UyWnFleWRoQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN0l1YzdZS3NJT3lJbUNEc25vanNsclRzbXBRdUlDb3E3Sk80SU95SW1DRHNsNGJyaXBRZzdKMjA3SnlnNjZXOElPMlZxT3E3bUNEc2xZanJnclR0bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RzcDREcXVJanNuWUFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJT3l5cmV5R2pPdUZoT3lkaENEc25JVHRsWndnN0lTYzY3bUU3SXFrNjRxVUlPeVZoT3luZ1NEc3BJRHJ1WVFnN0tTUjdKMjA3SmVRN0pxVUxnMEtMU0RxczdYcnJMVHNtNURzbllBZzdadUU3SnVRNnJpSTdKMkVJT3V6dE91Q3ZDRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzY3YUE3S0NWN1ppVjdKeTgNCjY2R2NJT3lOcU95VnZDRHNncXpzbXFuc25wRHFzSUFnN0phMDY1YWtJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3lYaHV1S2xPeW5nQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95RW9PMkRuZXlkbUNEcXNyRHFzN3pycGJ3ZzdKV0k2NEswN1pXZ0lPdVZqQTBLRFFycmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHNoS0R0ZzUzc25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyVm1PcXlqQ0RzbFl6cm9LVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdaV2NJT3V5DQppQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPdTJnT3lnbGUyWWxTa05DZzBLSit5Z2xldXp0Q0RzaUpqc3A1RWc3SldJNjRLMEp5RHJrN0hzblpnZzY2Kzg2ckNRN1pXY0lPeURnZTJacWV5WGtPeUVuQ0FxS3V5Z2xldXp0T3F3Z0NEcnM3VHRtTGpya0p6cmk2VHJpcFFnN0tDUUtpcnNuWVFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lEZ2V1THRPeWR0Q0RyZ1ozcmdwanJxYlFnN0tDRTY2eTQ2ckNBNjQrRUlPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1RycGJ3ZzY3TzhJT3lJbUNEc2w0YnNsclRzbXBRdURRb3RJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHNvSlhyczdUcXNJQWc2cml3NjZHZDY1Q1k3S2VBSU95Vg0KaXV5VmhPeWFsQzROQ2cwS0l5TWc3SmlJN0ptNElEUXVJT3lnbk8yU2lDRHNtcW5zbHJUcmlwUWc2N0NVNnI2NDdLZUFJT3lWaXVxNHNBMEtEUW9uNnJDRTZyS3c3WldZNnJPZ0lPeUpyT3lhdENEcnA1QW5JT3lia095NW1ldXp0T3VMcENBcUt1MlpsT3VwdE95ZG1DRHF1TERyaXFYcnFvWEN0K3V5aE8yS3ZPdXFoZXF6dk95ZG1DRHNtcW5zbHJRZzdKMjg3TG1ZS2lycXNJQWc3SnF3N0lTZzdKMjA3SmVRN0pxVUxnMEs2cml3NjRxbDY2cUY3SmVRSU95VHNPeWR1Q0RyaTZqc2xyUW82N09BNnJLOUxDRHNwNERzb0pVc0lPdVRzZXVoblNEcms3RXA2Nlc4SU95VmlPdUN0Q0RyckxqcXRhenNsNURzaEp3ZzY0dWs2Nlc0SU91bmtPdWhuQ0Ryc0pUcXZyanJxYlFnN0lLczdKcXA3SjZRNnJDQUlPdUxwT3VsdUNEcXVMRHJpcVhzbkx6cm9ad2c3SmlrN1pXMDdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrZ0orcTJqTzJWbkNEcnM0RHFzcjBuSU9xNHNPdUtwZXlkbUNEc2xZanJnclFnNjZ5NDZyV3MNCkRRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N0NVNnIrQUlPeUltQ0Rzbm9qc2xyVHNtcFFnS0ZncERRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N09BNnJLOTdaV2dJT3lJbUNEc25vanNsclRzbXBRZ0tFOHBEUW9OQ2lNaklPeVlpT3ladUNBMUxpRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F3ZzdKT3c3S2VBSU95Vml1cTRzQTBLRFFycnJManF0YXpycGJ3ZzdKV0U2NnkwNjZhc0lPdW5wT3VCaE91ZnZlcXlqQ0RyaTZUcms2enNsclRyajRRZ0tpcnNpNlRzb0p3ZzdJdWM3SXFrN1lXY0lPdVBtZXlla2VxenZDRHJpNlRycGJnZzY0K1o3SUtzS2lycnBid2c3Sk93NjZtMElPeWVtT3VxdSt1UW5DRHJyTGpxdGF6c21JanNtcFF1RFFvTkN1eVlpQ2tnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3llDQprT3VsdkNBbjdMYVU2ckNBSU95bmdPeWdsU2Z0bFpqcmlwUWc3SXVjN0lxazdZV2M3SmVRN0lTY0lDanNuYlRzb0lUQ3QreVdrZXVQaENEcXVMRHJpcVhzbmJRZzdKV0U2NHVZS1EwS0xTRHJpNlRycGJnZzdJS3M2NTZNN0plUTZyS01JT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERycGJ3ZzY0U1k2cktvN0tPODdJUzQ3SnFVSUNoWUlPS0FsQ0RzbDRicmlwUWdKK3VFbU9xNHNPcTRzQ2NnNnJpdzY0cWw3SjJFSU95VmxPeUxuQ2tOQ2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZ0Q0Rzbzd6c2hManNtcFFnS0U4cERRbz0NCjo6TEFVTkNIRVI6Og0KLy80bkFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCQ0FISUFhUUJrQUdjQVpRQWdBR3dBWVFCMUFHNEFZd0JvQUdVQWNnQWdBQlFnSUFEb3NzU3N4THdnQUNUQkZjZ2dBQkRJZ0t3Z0FNVFdJQURrc3F5NUlBRGt3b25WQ2dBbkFDQUFZd0JzQUdFQWRRQmtBR1VBWWdCeUFHa0FaQUJuQUdVQU9nQXZBQzhBSUFBRTFWeTRvTkZjejNUSElBQjB4eUFBRE5OOHgwVEhJQUNBdlhpNTVMSWdBQ2dBOGJSZHVEb0FJQUJ1QUhBQWJRQWdBR2tBYmdCekFIUUFZUUJzQUd3QUlBQVF0cFN5SUFBaUFIVFFYTGpjdENBQTVNNGxzVERSSWdBZ0FDVEJXTTRnQUF6VGZNY3BBQzRBQ2dBbkFDQUFWTHNBckNBQVlMNDR5Q0FBaU1jOHgzUzZJQUJjMVNBQWlMelF4U0FBV05XWXNDbkZJQUJJeGJTd1dOWGdyQ3dBSUFEa3NpQUFBTWxFdmhpMGRMb2dBT1N5ckxsOHVTQUFQY3dnQU1iRmRNY2dBT1RDaWRWYzFlU3lMZ0FLQUZNQVpRQjBBQ0FBWmdCekFHOEFJQUE5QUNBQVF3QnlBR1VBWVFCMEFHVUFUd0JpQUdvQVpRQmpBSFFBS0FBaUFGTUENCll3QnlBR2tBY0FCMEFHa0FiZ0JuQUM0QVJnQnBBR3dBWlFCVEFIa0Fjd0IwQUdVQWJRQlBBR0lBYWdCbEFHTUFkQUFpQUNrQUNnQlRBR1VBZEFBZ0FITUFhQUFnQUQwQUlBQkRBSElBWlFCaEFIUUFaUUJQQUdJQWFnQmxBR01BZEFBb0FDSUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGTUFhQUJsQUd3QWJBQWlBQ2tBQ2dCa0FHa0FjZ0FnQUQwQUlBQm1BSE1BYndBdUFFY0FaUUIwQUZBQVlRQnlBR1VBYmdCMEFFWUFid0JzQUdRQVpRQnlBRTRBWVFCdEFHVUFLQUJYQUZNQVl3QnlBR2tBY0FCMEFDNEFVd0JqQUhJQWFRQndBSFFBUmdCMUFHd0FiQUJPQUdFQWJRQmxBQ2tBQ2dCekFHZ0FMZ0JEQUhVQWNnQnlBR1VBYmdCMEFFUUFhUUJ5QUdVQVl3QjBBRzhBY2dCNUFDQUFQUUFnQUdRQWFRQnlBQW9BQ2dBbkFDQUFNUUF2QURJQUtRQWdBRTRBYndCa0FHVUFMZ0JxQUhNQUlBQVF5SUNzSUFBVUlDQUF4c1U4eDNTNklBRGtzclRHWExqY3RDQUFtTk4weDhESmZMa2dBUFRGdE1VQXllU3lDZ0JKQUdZQUlBQnpBR2dBDQpMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQUlBQjNBR2dBWlFCeUFHVUFJQUJ1QUc4QVpBQmxBQ0lBTEFBZ0FEQUFMQUFnQUZRQWNnQjFBR1VBS1FBZ0FEd0FQZ0FnQURBQUlBQlVBR2dBWlFCdUFBb0FJQUFnQUVrQVpnQWdBRTBBY3dCbkFFSUFid0I0QUNnQUlnQk9BRzhBWkFCbEFDNEFhZ0J6QUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aTRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdCYkFGWFdlTWRkQUVUSElBQUVzblM1ZExvZ0FPU3l0TVpjdU55MElBQ1kwM1RId01rQXJDQUE5TVc5dWNpeTVMSXVBQ0FBSk1GWXpueTVJQURJdVZ6T0lBQ2t0Q3dBSUFBTTFleTMrSzE0eDlERkhNRWdBSFRRWExqY3RDQUFoTHk4MGtUSElBRGtzdHpDSUFBTXN1eTNJQUQ4eURqQmxNWXVBQ0lBTEFBZ0FGOEFDZ0FnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQQ0KSUFCMkFHSUFUd0JMQUVNQVlRQnVBR01BWlFCc0FDQUFLd0FnQUhZQVlnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURFQUx3QXlBQ2tBSUFBVUlDQUFUZ0J2QUdRQVpRQXVBR29BY3dBaUFDa0FJQUE5QUNBQWRnQmlBRThBU3dBZ0FGUUFhQUJsQUc0QUNnQWdBQ0FBSUFBZ0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCb0FIUUFkQUJ3QUhNQU9nQXZBQzhBYmdCdkFHUUFaUUJxQUhNQUxnQnZBSElBWndBdkFHc0Fid0F2QUdRQWJ3QjNBRzRBYkFCdkFHRUFaQUFpQUFvQUlBQWdBRVVBYmdCa0FDQUFTUUJtQUFvQUlBQWdBRmNBVXdCakFISUFhUUJ3QUhRQUxnQlJBSFVBYVFCMEFBb0FSUUJ1QUdRQUlBQkpBR1lBQ2dBS0FDY0FJQUF5QUM4QU1nQXBBQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDQUFFTWlBckNBQUZDQWdBTWJGUE1kMHVpQUFKTUZZenJjQVhMajRyWGpISUFBcHZKVzhSTWNnQUVqRnRMQmMxZVN5Q2dCSkFHWUENCklBQnpBR2dBTGdCU0FIVUFiZ0FvQUNJQVl3QnRBR1FBSUFBdkFHTUFJQUIzQUdnQVpRQnlBR1VBSUFCakFHd0FZUUIxQUdRQVpRQWlBQ3dBSUFBd0FDd0FJQUJVQUhJQWRRQmxBQ2tBSUFBOEFENEFJQUF3QUNBQVZBQm9BR1VBYmdBS0FDQUFJQUJOQUhNQVp3QkNBRzhBZUFBZ0FDSUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aUFBS0FBUXRwU3lJQUJRQUVFQVZBQklBTkRGSUFER3hiVEZsTVlwQUM0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0F3MGZpN0VMSFF4UnpCSUFCRXhaaTNmTGtnQUNUQldNNjNBRnk0K0sxNHgxelZJQUNrdEN3QUlBQjAwRnk0M0xRZ0FJUzh2TkpFeHlBQTVMTGN3aUFBRExMc3R5QUEvTWc0d1pUR09nQWlBQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBDQpKZ0FnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWlBQ0FBSUFCdUFIQUFiUUFnQUdrQWJnQnpBSFFBWVFCc0FHd0FJQUF0QUdjQUlBQkFBR0VBYmdCMEFHZ0FjZ0J2QUhBQWFRQmpBQzBBWVFCcEFDOEFZd0JzQUdFQWRRQmtBR1VBTFFCakFHOEFaQUJsQUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFJQUFnQUdNQWJBQmhBSFVBWkFCbEFDQUFiQUJ2QUdjQWFRQnVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQVZkWjR4eUFBS2J5VnZEb0FJQUF3MGZpN0VMSFF4UnpCSUFCakFHd0FZUUIxQUdRQVpRQWdBQzBBTFFCMkFHVUFjZ0J6QUdrQWJ3QnVBQ0FBZE1jZ0FJUzhCTWhFeHlBQW5NMGx1RmpWZExvZ0FBREpSTDRnQUVUR3pMaUZ4OGl5NUxJdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQQ0KWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFLQUNzd0tuR3liZEF4eUFBZE1jZ0FGQUFRd0RReFNBQVhMajRyWGpISExRZ0FIVFFYTGpjdENBQWJLM0ZzeUFBWE5YRXM5REZITUVnQUNqTUVLd3B0TWl5NUxJdUFDa0FJZ0FzQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBSFlBWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BRElBTHdBeUFDa0FJQUFVSUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0lBQ2dBZ0FDQUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGRUFkUUJwQUhRQUNnQkZBRzRBWkFBZ0FFa0FaZ0FLQUFvQUp3QWdBQURKUkw0Z0FFVEd6TGdnQUJRZ0lBRGtzcXk1ZkxrZ0FEM01JQURHeFhUSElBRGt3b25WSUFBb0FBelY3TGY0clhqSGRNY2dBT2VzSUFDUXg5bXpJQUFRck1ESktRQUtBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQmpBRzBBWkFBZ0FDOEFZd0FnQUc0QWJ3QmtBR1VBSUFCekFHTUENCmNnQnBBSEFBZEFCekFGd0FZd0JzQUdFQWRRQmtBR1VBTFFCaUFISUFhUUJrQUdjQVpRQXVBR29BY3dBaUFDd0FJQUF3QUN3QUlBQkdBR0VBYkFCekFHVUFDZ0E9DQo6OldBVENIRVI6Og0KTHk4ZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzRvQ1VJTzJWcmV5RGdTRHJscUFnN0o2STY0cVVJT3kwaU95R2pPMllsU0RzaEp6cnNvUWdLR3h2WTJGc2FHOXpkRG94TVRnNE9Ta05DaTh2SU9LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBMEtMeThnN0ptY0lPMlZoT3lhbE8yVm5PcXdnRG9nN1pTODZyZTQ2NmVJNnJDQUlPMlVqT3Vmck9xM3VPeWR1T3lkbUNCamJHRjFaR1ZpY21sa1oyVTZMeThnN0plMDZyaXdLSGRwYm1SdmR5NXZjR1Z1TDJsbWNtRnRaUzl2Y0dWdVJYaDBaWEp1WVd3cDY2VzgNCkRRb3ZMeURzb0lUcnRvQWc3SWFNNjZhc0lPeVhodXlkdENEcnA0bnJpcFFnNjdLRTdLQ0U3SjIwSU95ZWlPdUxwQzRnWm1WMFkyanJpcFFnNjZxN0lPdW5pZXljdk91dmdPdWhuQ3dnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKRHNpNXpzbnBEc2w1RHFzb3dOQ2k4dklGQlBVMVFnTDNkaGEyVWc2Nlc4SU91enRPdUN0T3VwdENEcXNKRHNpNXpzbnBEcXNJQWc2NHVrNjZhc0tHTnNZWFZrWlMxaWNtbGtaMlV1YW5NcDY2VzhJT3VNZ095TG9DRHN2S0RyaTZRdURRb3ZMdzBLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQTBLTHk4ZzY2bVU2NnFvNjZhc0lINHhOVTFDNjUyOElPdWhuT3EzdU95ZHVDRHNpNXdnN0o2UTY0K1pJT3lMbk95ZWtleWN2T3VoDQpuQ0RzZzRIc2k1d2c3THljNjVHczY0K0VJT3UyZ091THRDRHNsNGJyaTZRZ0tPdVRzZXVoblRvZ2JuQnRJSEoxYmlCaWRXbHNaQ2t1RFFvdkx5RHJpNlRycHF6cmlwUWc3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTRzT3VwdENEc283M3NwNERycDR3bzdaU002NStzNnJlNDdKMjQ2ck84SU95RG5leUNyQ0RyajVucXVMRHRtWlFwTENEcXNKRHNpNXpzbnBEcmlwUWc2ck9FN0lhTklPdUNxT3lWaENEcmk2VHNuWXdnNnJtbzdKcXc2cml3NjZXOElPdXdtK3VLbE91THBDNE5DZzBLWTI5dWMzUWdhSFIwY0NBOUlISmxjWFZwY21Vb0oyaDBkSEFuS1RzTkNtTnZibk4wSUhCaGRHZ2dQU0J5WlhGMWFYSmxLQ2R3WVhSb0p5azdEUXBqYjI1emRDQm1jeUE5SUhKbGNYVnBjbVVvSjJaekp5azdEUXBqYjI1emRDQnZjeUE5SUhKbGNYVnBjbVVvSjI5ekp5azdEUXBqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNOQ2cwS1kyOXVjM1FnVUU5Uw0KVkNBOUlERXhPRGc1T3cwS1kyOXVjM1FnVWs5UFZDQTlJSEJoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNjdUxpY3BPeUF2THlEc29JRHNucVhzaG93ZzY2T283WXE0SU9LQWxDRHJpNlRycHF6cXNJQWdjbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrNjZXOElPeXd2dXVLbENEcXVMRHNwSUFOQ2cwS1kyOXVjM1FnUTA5U1UxOUlSVUZFUlZKVElEMGdldzBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUM0pwWjJsdUp6b2dKeW9uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFNHVmhaR1Z5Y3ljNklDZERiMjUwWlc1MExWUjVjR1VuTEEwS2ZUc05DbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3MEtJQ0J5WlhNdWQzSnBkR1ZJWldGa0tITjBZWFIxY3l3Z1QySnFaV04wTG1GemMybG5iaWg3SUNkRGIyNTANClpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2dZMmhoY25ObGREMTFkR1l0T0NjZ2ZTd2dRMDlTVTE5SVJVRkVSVkpUS1NrN0RRb2dJSEpsY3k1bGJtUW9TbE5QVGk1emRISnBibWRwWm5rb2IySnFLU2s3RFFwOURRb05DaTh2SUdOc1lYVmtaU0JEVEVucXNJQWc3SjZJNjRxVTdLZUFJT0tBbENEc2w0YnNuTHpycWJRZ0wzZGhhMlVnN0oyUjY0dTE3SmVRSU95THBPeVd0Q0R0bEl6cm42enF0N2pzbmJqc25iUWc3SldJNjRLMDdaV2dJT3lJbUNEc25vanFzb3dnN1pXYzY0dWtEUW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPeWR2ZXE0c0NEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpJQ2pyaTZUcnBxenNuWmdnWTJ4aGRXUmxRV05qYjNWdWRPeVpnQ0Rxc0puc25ZQWc3TGFjN0xLWUtTNE5DaTh2SU8yTWpPeWR2T3lkdENEdGdiUWc3SWlZSU95ZWlPeVd0Q0F6DQpNT3kwaUNEc3VwRHNpNXd1SU95ZXJPdWhuT3EzdU95ZHVPMlZtT3VwdENCRFRFbnFzSUFnN1l5TTdKMjg3SjJFSU9xd3NleUxvTzJWbU91dmdPdWhuQ0RzbnBEcmo1a2c2N0NZN0ppQjY1Q2M2NHVrTGcwS0x5OGc3THFRN0l1Y0lEWHN0SWdnNG9DVUlPdWhuT3EzdU95ZHVDRHNwNEh0bTRRZzdJT0lJT3F6aE95Z2xleWR0Q0RxczZmcnNKVHJvWndnN0o2aDdaaUE3Slc4SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA3SmVRN0lTY0lPMlppT3ljdk91aG5DRHJoSmpzbHJUcXNJVHJpNlFvTXpEc3RJanJxYlFnNjRTSTY2eTBJT3VLcHV5ZGpDa05DbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93MEtablZ1WTNScGIyNGdZMnhoZFdSbFFXTmpiM1Z1ZENncElIc05DaUFnYVdZZ0tFUmhkR1V1Ym05M0tDa2dMU0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQQ0ExTURBd0tTQnlaWFIxY200Z1lXTmpiM1Z1ZEVOaFkyaGxMbVZ0WVdscw0KT3cwS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJR29nUFNCS1UwOU9MbkJoY25ObEtHWnpMbkpsWVdSR2FXeGxVM2x1WXlod1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuTG1Oc1lYVmtaUzVxYzI5dUp5a3NJQ2QxZEdZNEp5a3BPdzBLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJvWnpxdDdqc25iZ2c3SjIwNjZDbElPeVhodXlkakNEcms3RWc0b0NVSUc1MWJHd2dLaThnZlEwS0lDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUJFWVhSbExtNXZkeWdwTENCbGJXRnBiQ0I5T3cwS0lDQnlaWFIxY200Z1pXMWhhV3c3RFFwOURRb05DbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzTkNpQWdZMjl1YzNRZ1ptbHVaR1Z5SUQwZ2NISnZZMlZ6Y3k1d2JHRjANClptOXliU0E5UFQwZ0ozZHBiak15SnlBL0lDZDNhR1Z5WlNjZ09pQW5kMmhwWTJnbk93MEtJQ0IwY25rZ2V5QnlaWFIxY200Z2MzQmhkMjVUZVc1aktHWnBibVJsY2l3Z1d5ZGpiR0YxWkdVblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY3NJSE5vWld4c09pQjBjblZsSUgwcExuTjBZWFIxY3lBOVBUMGdNRHNnZlNCallYUmphQ0FvWDJVcElIc2djbVYwZFhKdUlHWmhiSE5sT3lCOURRcDlEUW9OQ214bGRDQjNZV3RwYm1jZ1BTQm1ZV3h6WlRzZ0x5OGc3SmV3N1lPQUlPdXdxZXluZ0NEaWdKUWc2NHVrNjZhczY0cVVJT3lXdE95d3FPMlV2Q0JGUVVSRVVrbE9WVk5GNjZHY0lPeWtrZXV6dFNEc29KWHJwcXp0bFpqc3A0RHJwNHdnN1pTRTY2R2M3SVM0N0lxa0lPdUNyZXU1aE91bHZDRHNwSVRzbmJqcmk2UU5DbVoxYm1OMGFXOXVJSGRoYTJWQ2NtbGtaMlVvS1NCN0RRb2dJR2xtSUNoM1lXdHBibWNwSUhKbGRIVnlianNOQ2lBZ2QyRnJhVzVuSUQwZ2RISjFaVHNOQ2lBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5DQpQaUI3SUhkaGEybHVaeUE5SUdaaGJITmxPeUI5TENBMU1EQXdLVHNOQ2lBZ2JHVjBJSEJ5YjJNN0RRb2dJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdEUW9nSUNBZ0x5OGdWMmx1Wkc5M2N6b2dZMjFrd3JkMlluTWc2cks5N0p5Z0lPeVhodXlkdENCdWIyUmw2Nlc4SU95bmdleWdrU3dnZDJsdVpHOTNjMGhwWkdVb1ExSkZRVlJGWDA1UFgxZEpUa1JQVnlucm9ad2c3SXFrN1krd0lPS0FsQTBLSUNBZ0lDOHZJT3l3dlNEc2w0YnJpcFFnN0lpbzdKMkFJT3k5bU95R2xPeWR0Q0RycDR6cms2VHNsclRzcDREcXM2QWc2NHVrNjZhczdKMllJT3lla095TG5TaGpiR0YxWkdVcDY0K0VJT3EzdUNEc3ZaanNocFRzbllRZzY2eTg2NkNrNjdDYjdKV0VJT3lXdE91V3BDRHNzTDNyajRRZzdKV0lJT3Vjck91THBDNE5DaUFnSUNBdkx5QmtaWFJoWTJobFpPdUtsQ0RzazdEc3A0QWc3SldLNjRxVTY0dWtLR1JsZEdGamFHVmtLM2RwYm1SdmQzTklhV1JsSU95aHNPMlZxZXlkZ0NEcw0Kdlpqc2hwUWc3TEM5N0oyMElPdUZ1T3kybk91UXFDRGlnSlFnN0l1azdMaWhLUzROQ2lBZ0lDQXZMeUJYYVc1a2IzZHo3SmVRN0lTZ0lHUmxkR0ZqYUdWa0lPeVhodXlkdE91UGhDRHJ0b0RycXFnbzZyQ1E3SXVjN0o2UUtlcXdnQ0Rzbzczc2xyVHJqNFFnN0o2UTdJdWQ3SjJBSU95Q3RPeVZoT3VDcU91S2xPdUxwQzROQ2lBZ0lDQndjbTlqSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3RFFvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzRFFvZ0lDQWdmU2s3RFFvZ0lIMGdaV3h6WlNCN0RRb2dJQ0FnTHk4Z2JXRmpUMU12NjZhczY0aUY3SXFrT2lEcXNKRHNpNXpzbnBEcnBid2c2NTJFN0pxMElHNXZaR1VnN0l1azdaYUpJTzJNak95ZHZPdWhuQ0RzcDRIc29KRWc3SXFrN1krd0lDaHNZWFZ1WTJoa0lPMloNCm1PcXl2ZXlYbENCUVFWUkk2ckNBSU91NWlPeVZ2ZTJWb0NEc2lKZ2c3SjZJN0phMElPeWdpT3VNZ09xeXZldWhuQ0RzZ3F6c21xa3BEUW9nSUNBZ2NISnZZeUE5SUhOd1lYZHVLSEJ5YjJObGMzTXVaWGhsWTFCaGRHZ3NJRnR3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBblkyeGhkV1JsTFdKeWFXUm5aUzVxY3ljcFhTd2dldzBLSUNBZ0lDQWdZM2RrT2lCU1QwOVVMQ0JrWlhSaFkyaGxaRG9nZEhKMVpTd2djM1JrYVc4NklDZHBaMjV2Y21VbkxBMEtJQ0FnSUgwcE93MEtJQ0I5RFFvZ0lIQnliMk11ZFc1eVpXWW9LVHNnTHk4ZzZyQ1E3SXVjN0o2UUlPeWR0T3V5cE8yS3VDRHJvNmp0bElUc2w1RHNoSndnNjdhRTY2YXNJQ2pxc0pEc2k1enNucEFnN0tLRjY2T002Nlc4SU91bmlleW5nQ0RzbFlycXNvd3BEUXA5RFFvTkNpOHZJT3lkdENCUVErdWx2Q0FuN0lTazdMbVlJT3lnaENqc2c0Z2dVRU1wSnlEc2c0SHRnNXpyb1p3ZzY1Q1k2NCtNNjZhdzY0dWtJT0tBbENEdGxJenJuNnpxdDdqc25iZ2dXK3kwDQppT3E0c08yWmxGMGc2N0tFN1lxOEtGQlBVMVFnTDNWdWFXNXpkR0ZzYkNuc25iUWc2N2FBNjZXNDY0dWtMZzBLTHk4Z2NtVm5hWE4wWlhJdGNISnZkRzlqYjJ3dWFuUHFzSUFnN0lTazdMbVk3WldjSU9xeWcreWRoQ0RxdDdqcmpJRHJvWndnNjVDWTY0K002NmF3NjR1a09pRHFzSkRzaTV6c25wQWc3SjZRNjQrWjdJdWM3SjZSSUNzZ0tPeWVpT3ljdk91cHRDa2c3SVNrN0xtWUlPMlB0T3VObEM0TkNpOHZJT0thb08rNGp5RHJzSmpyazV6c2k1d2dTRlJVVUNEc25aSHJpN1hzbllRZzY2aTg3S0NBSU91enRPdUN1Q0Rya3FRZzdaaTQ3TGFjN1pXZ0lPcXlneURpZ0pRZ2JXRmpUMU1nYkdGMWJtTm9ZM1JzSUdKdmIzUnZkWFRzbmJRZzdKMjBJTzJVaE91aG5PeUV1T3lLcE91bHZDRHNwb25zaTV3ZzdLS0Y2Nk9NN0l1YzdZS3NJT3lJbUNEc25vanJpNlF1RFFvdkx5QWdJQ0RxdDdqcm5wanNoSndnN1l5TTdKMjhLSEJzYVhOMHdyZnNoS1RzdVpnZzdZKzA2NDJVS2V5ZGhDQnNZWFZ1WTJoamRHenJzN1RyaTZRZw0KNjZpODdLQ0FJT3luZ095YXRPdUxwQ0RpZ0pRZ1ltOXZkRzkxZE95ZHRDRHNtckRycHF6cnBid2c3S085N0plczY0K0VJT3lla091UG1leUxuT3lla2V5ZGdDRHNuYlRycjdnZzdJS3M2NTI4N0tlRTY0dWtMZzBLWm5WdVkzUnBiMjRnZFc1cGJuTjBZV3hzVTJWc1ppZ3BJSHNOQ2lBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUZ0ZE93MEtJQ0IwY25rZ2V3MEtJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXcwS0lDQWdJQ0FnWTI5dWMzUWdURUZDUlV3Z1BTQW5ZMjl0TG1Oc1lYVmtaV0p5YVdSblpTNTNZWFJqYUdWeUp6c05DaUFnSUNBZ0lHTnZibk4wSUhCc2FYTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua25MQ0FuVEdGMWJtTm9RV2RsYm5Sekp5d2dURUZDUlV3Z0t5QW5MbkJzYVhOMEp5azdEUW9nSUNBZ0lDQmpiMjV6ZENCcGJuTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua24NCkxDQW5RWEJ3YkdsallYUnBiMjRnVTNWd2NHOXlkQ2NzSUNkRGJHRjFaR1ZDY21sa1oyVW5LVHNOQ2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktIQnNhWE4wS1NrZ2V5Qm1jeTUxYm14cGJtdFRlVzVqS0hCc2FYTjBLVHNnY21WdGIzWmxaQzV3ZFhOb0tIQnNhWE4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLR2x1YzNRcEtTQjdJR1p6TG5KdFUzbHVZeWhwYm5OMExDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTd2dabTl5WTJVNklIUnlkV1VnZlNrN0lISmxiVzkyWldRdWNIVnphQ2hwYm5OMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DaUFnSUNBZ0lIUnllU0I3SUhOd1lYZHVVM2x1WXlnbmJHRjFibU5vWTNSc0p5d2dXeWRpYjI5MGIzVjBKeXdnSjJkMWFTOG5JQ3NnY0hKdlkyVnpjeTVuWlhSMWFXUW9LU0FySUNjdkp5QXJJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3DQpJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0Nkc1lYVnVZMmhqZEd3bkxDQmJKM0psYlc5MlpTY3NJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXcwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5WldjbkxDQmJKMlJsYkdWMFpTY3NJQ2RJUzBOVlhGeFRiMlowZDJGeVpWeGNUV2xqY205emIyWjBYRnhYYVc1a2IzZHpYRnhEZFhKeVpXNTBWbVZ5YzJsdmJseGNVblZ1Snl3Z0p5OTJKeXdnSjBOc1lYVmtaVUp5YVdSblpWZGhkR05vWlhJbkxDQW5MMlluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNnbjdKNlE2NCtaN0l1YzdKNlJLRU5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWElwSnlrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwSw0KSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KMk5zWVhWa1pXSnlhV1JuWlRvdkx5RHJrN0hyb1owbktUc2dmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnSUNCMGNua2dldzBLSUNBZ0lDQWdJQ0JqYjI1emRDQnBibk4wSUQwZ2NHRjBhQzVxYjJsdUtIQnliMk5sYzNNdVpXNTJMa3hQUTBGTVFWQlFSRUZVUVNCOGZDQndZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBblFYQndSR0YwWVNjc0lDZE1iMk5oYkNjcExDQW5RMnhoZFdSbFFuSnBaR2RsSnlrN0RRb2dJQ0FnSUNBZ0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWcNCmZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlEwS0lDQWdJQ0FnZlNCallYUmphQ0FvWDJVcElIdDlEUW9nSUNBZ2ZRMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUJtWVdsc0xYTnZablFnNG9DVUlPdXF1eURzcDREc21yUWc2cktNSU95ZWlPeVd0T3VQaENEdGxJenJuNnpxdDdqc25iZ2c3S3E5SU9xNHNPeVd0U0RzZ3Ezc29KenJpcFFnN0oyMDY2KzRJT3VCbmV1Q3JPdUxwQ0FxTHlCOURRb2dJSEpsZEhWeWJpQnlaVzF2ZG1Wa093MEtmUTBLRFFvdkx5RHJpNlRycHF3b01URTRPRGdwNnJDQUlPdVdvQ0Rzbm9qc25MenJxYlFnNjRHSTY0dWtJT0tBbENEc3RJanF1TER0bVpRZzdJdWNJT3VDcU95ZGdDRHNoTGpzaFpnZzdLQ1Y2NmFzSUNqc2w0YnNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeUxwTzJNcUNrTkNtWjFibU4wYVc5dUlITm9kWFJrYjNkdVFuSnBaR2RsS0NrZ2V3MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJSElnUFNCb2RIUndMbkpsY1hWbGMzUW9leUJvYjNOME9pQW5NVEkzDQpMakF1TUM0eEp5d2djRzl5ZERvZ01URTRPRGdzSUhCaGRHZzZJQ2N2YzJoMWRHUnZkMjRuTENCdFpYUm9iMlE2SUNkUVQxTlVKeXdnZEdsdFpXOTFkRG9nTVRVd01DQjlMQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3ZlNrN0RRb2dJQ0FnY2k1dmJpZ25kR2x0Wlc5MWRDY3NJQ2dwSUQwK0lIc2dkSEo1SUhzZ2NpNWtaWE4wY205NUtDazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZTQjlLVHNOQ2lBZ0lDQnlMbVZ1WkNncE93MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DbjBOQ2cwS1kyOXVjM1FnYzJWeWRtVnlJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvS0hKbGNTd2djbVZ6S1NBOVBpQjdEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIME5DaUFnYVdZZ0tISmxjUzUxY213Z1BUMDlJQ2N2YUdWaA0KYkhSb0p5a2dldzBLSUNBZ0lDOHZJSFk2SU9xd2tPeUxuT3lla0NEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENEcXRhenJzb1Rzb0lRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU9xemhPeUdqU0RyajR6cXM2QWc3SjZJNjRxVTdLZUFJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsWmpyaXBRZzdKcXA2NCtFRFFvZ0lDQWdMeThnS0hZeUlEMGc3TEM5SU95SXFPcTVnQ0RzaUpqc29KWHRqSkFzSUhZeklEMGdMMkZqWTI5MWJuUWc3TGFVNnJDQTdZeVFMQ0IyTkNBOUlDOTFibWx1YzNSaGJHd2c3TGFVNnJDQTdZeVFLUTBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCM1lYUmphR1Z5T2lCMGNuVmxMQ0IyT2lBMElIMHBPdzBLSUNCOURRb2dJQzh2SU95ZHRDQlFRK3lYa0NEcm9aenF0N2pzbmJqcmtKd2c3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRGlnSlFnN1pTTTY1K3M2cmU0N0oyNElPeXlxeUR0bVpUcnFiVEN0KzJaaU95ZHRDQWk2NGlFNnJXc0lPcXpoT3lnbGV5Y3ZPdWgNCm5DRHNrN0RyaXBUc3A0QWlJT3V6dE95WHJPeWp2T3VLbENEcmpiQWc3Sk8wNjR1a0xnMEtJQ0F2THlEcXNKRHNpNXpzbnBEcXNJQWc2NHUxN1pXWTY0cVVJT3lkdE95Y29Eb2c2NHVrNjZhczY2VzhJT3k4bk91cHRDRHNtNHpyc0kzc2w0WHNuTHpyb1p3ZzdZRzA2NkdjNjVPYzZyQ0FJT3lMcE95Z25DRHRtTGpzdHB6cmo3d2c2cldzNjQrRklPeUNyT3lhcWV1ZmlleWR0Q0RyZ3BqcXNJVHJpNlF1RFFvZ0lDOHZJT3F3a095TG5PeWVrT3VLbENEdGpJenNuYnpycDR3ZzdKMjk3Snk4NjYrQTY2R2NJT3lDck95YXFldWZpU0F3SU1LM0lPdU1nT3E0c0NBd0lPS0FsQ0Rxc29EdGhxRHJwNHdnN0pPdzY0cVVJT3lDck91ZWpPeVhrT3F5akNEcnVZVHNtcW5zbllRZzY2eTg2NmFzN0tlQUlPeVZpdXVLbE91THBDNE5DaUFnTHk4ZzdLTzg3SjJZT2lEc2w2enF1TEFnNnJPRTdLQ1Y3SjIwSU91enRPeVhyT3VQaENEc25vWHNucVhxdG96c25iUWc2NmVNNjZPTTY1Q1E3SjJFSU95SW1DRHNub2pyaTZRbzdKeWc3WnFvDQo3SVN4N0oyQUlPeUxwT3lnbkNEdG1ManN0cHdnNjVXTTY2ZU1JT3lWakNEc2lKZ2c3SjZJN0oyTUlPS0FsQ0RyaTZUcnBxd2dMMmhsWVd4MGFPeWRtQ0J3Y205aWJHVnRJT3l3dU9xem9Da3VEUW9nSUdsbUlDaHlaWEV1ZFhKc0lEMDlQU0FuTDJGalkyOTFiblFuS1NCN0RRb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJR0ZqWTI5MWJuUTZJR05zWVhWa1pVRmpZMjkxYm5Rb0tTd2dZMnhoZFdSbE9pQm9ZWE5EYkdGMVpHVW9LU0I5S1RzTkNpQWdmUTBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZDJGclpTY3BJSHNOQ2lBZ0lDQnBaaUFvSVdoaGMwTnNZWFZrWlNncEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1WnljZ2ZTazdEUW9nSUNBZ2QyRnJaVUp5YVdSblpTZ3BPdzBLSUNBZ0lISmxkSFZ5YmlCcQ0KYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0IzWVd0cGJtYzZJSFJ5ZFdVZ2ZTazdEUW9nSUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dldzBLSUNBZ0lHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdEUW9nSUNBZ2NtVjBkWEp1T3cwS0lDQjlEUW9nSUM4dklPeTBpT3E0c08yWmxDRGlnSlFnN0oyMElGQkQ2Nlc4SUNmc2c0Z2dVRU1uSU95RGdlMkRuT3VobkNEcmtKanJqNHpycHJEcmk2UWdLTzJVak91ZnJPcTN1T3lkdUNCYjdMU0k2cml3N1ptVVhTRHJzb1R0aXJ3cExnMEtJQ0F2THlEc25aSHJpN1hzbllRZzY2aTg3S0NBSU8yZG1PdWdwT3V6dE91Q3VDRHJrcVFnN0tDVjY2YXM3WldjNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc3BvbnMNCmk1d2c3S085N0plczY0K0VJTzJhak95TG9PeWRnQ0RyajRUc3NLbnRsWnpyaTZRdURRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OTFibWx1YzNSaGJHd25LU0I3RFFvZ0lDQWdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2djR3hoZEdadmNtMDZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdmU2s3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdEUW9nSUNBZ0lDQnphSFYwWkc5M2JrSnlhV1JuWlNncE93MEtJQ0FnSUNBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUhWdWFXNXpkR0ZzYkZObGJHWW9LVHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYmQyRjBZMmhsY2wwZzdMU0k2cml3N1ptVUtIVnVhVzV6ZEdGc2JDa2c0b0NVSU95Z25PcXhzRG9uTENCeVpXMXZkbVZrTG1wdmFXNG9KeXdnSnlrZ2ZId2dKeWpzbDRic25Zd3BKeWs3RFFvZ0lDQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSEJ5YjJObGMzTXVaWGhwDQpkQ2d3S1N3Z01qQXdLVHNOQ2lBZ0lDQjlMQ0F5TlRBcE93MEtJQ0FnSUhKbGRIVnlianNOQ2lBZ2ZRMEtJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TkN3Z2V5Qmxjbkp2Y2pvZ0owNXZkQ0JtYjNWdVpDY2dmU2s3RFFwOUtUc05DZzBLTHk4ZzdKMjA2Nis0SU91V29DRHNub2pzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lpaGV1ampDQW83SjZRNjQrWklPeUxuT3lla1NBcklHNXdiU0JpZFdsc1pDRHNwSkhyczdVZzdJdWs3WmFKSU91TWdPdTVoQ2tOQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXcwS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3cwS0lDQndjbTlqWlhOekxtVjRhWFFvTVNrN0RRcDlLVHNOQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc05DaUFnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHRnYlRyb1p6cms1d2c2NHVrNjZhcw0KSU9xd2tPeUxuT3lla0NEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93MEtmU2s3RFFvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJQ2RzYjJOaGJHaHZjM1FuNnJDQUlEbzZNZXVobkNEcnFMenNvSUFnN1pXMDdJU2Q2NUNZNjRxVUlPMlptT3F5dmV5WGtPeUVuQTBLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlFbFFkalRyb1p3ZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDRHJpNlRycHF3ZzZybW83SnF3NnJpd3dyZnFzNFRzb0pVZzdLR3c3WnFNNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJqWmdnNjZ5NDdLQ2NJT3VNZ095ZGtTanJpNlRycHF6c21ZQWc2NCtaN0oyOEtTNE5DbU52Ym5OMElITmxjblpsY2pZZ1BTQm9kSFJ3TG1OeVpXRjBaVk5sY25abGNpaHpaWEoyWlhJdWJHbHpkR1Z1WlhKektDZHlaWEYxWlhOMEp5bGJNRjBwT3cwS2MyVnlkbVZ5Tmk1dmJpZ24NClpYSnliM0luTENBb0tTQTlQaUI3ZlNrN0lDOHZJRG82TWV5ZGhDRHJxcnNnN0o2aDdKV0U2NCtFS0VWQlJFUlNTVTVWVTBYQ3QwbFFkallnN0plRzdKMk1LU0JKVUhZMDY2ZU03Snk4NjZHY0lPcXpoT3lHalNEcmo1bnNucEVOQ25ObGNuWmxjall1YkdsemRHVnVLRkJQVWxRc0lDYzZPakVuS1RzTkNnPT0NCjo6V1NJTEVOVDo6DQpKeUJEYkdGMVpHVWdRbkpwWkdkbElIZGhkR05vWlhJZ2MybHNaVzUwSUd4aGRXNWphR1Z5SUNodWJ5QjNhVzVrYjNjcElDMGdjbVZuYVhOMFpYSmxaQ0IwYnlCeWRXNGdZWFFnYkc5bmFXNEtVMlYwSUdaemJ5QTlJRU55WldGMFpVOWlhbVZqZENnaVUyTnlhWEIwYVc1bkxrWnBiR1ZUZVhOMFpXMVBZbXBsWTNRaUtRcFRaWFFnYzJnZ1BTQkRjbVZoZEdWUFltcGxZM1FvSWxkVFkzSnBjSFF1VTJobGJHd2lLUXBrYVhJZ1BTQm1jMjh1UjJWMFVHRnlaVzUwUm05c1pHVnlUbUZ0WlNoWFUyTnlhWEIwTGxOamNtbHdkRVoxYkd4T1lXMWxLUXB6YUM1RGRYSnlaVzUwUkdseVpXTjBiM0o1SUQwZ1pHbHlDbk5vTGxKMWJpQWlZMjFrSUM5aklHNXZaR1VnYzJOeWFYQjBjMXhpY21sa1oyVXRkMkYwWTJobGNpNXFjeUlzSURBc0lFWmhiSE5sQ2c9PQ0KOjpFTkQ6Og0K";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAADlpHGd/3ECAP9xAgAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21sa1oyVXBDaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdUNpOHZDaTh2SU95R2pldVBoQ0RzaEtUcXM0UTZJTzJCdE91aG5PdVRuT3VsdkNEc21wVHNzcTNycDRqcmk2UWc3SU9JNjZHY0lPeUxuT3VQbWUyVm1PdXB0Q0F6TUg0ME1PeTBpT3F3Z0NEcXQ3anJnNlVnNjRLZzdKV0U2ckNFNjR1a0xnb3ZMeURpaHBJZzY0dWs2NmFzNjZXOElPeThwQ0RybFl3ZzdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZGhDRHRsWmpyZ3BnZzdKZTA3SmEwSU95RGdleUxuQ0RyaklEcXVMRHNpNXp0Z3FUcXM2QW9jM1J5WldGdExXcHpiMjRnNjR5QTdabVVJT3VxcU91VG5Da3NDaTh2SUNBZzZyQ0E3SjIwNjVPY0sreVlpT3lMbkNneE1USHFzYlFwNjRxVUlPeXlxeURycVpUc2k1enNwNERyb1p3ZzdaV2NJT3V5aU91bmpDRHNuYjN0bm96cmk2UXVJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2Nnk0NnJXczY2ZU1JT3V6dE91Q3RPdXZnT3VobkNEcnVhRHJwYlRyaTZRdUNpOHZJT3lFdU95Rm1PeWRnQ0F6TU91eWlDRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdaVzBJT3VNZ08yWmxPcXdnQ0RyckxUdGxaenRub2dnNnJpNDdKYTA3S2VBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpOHZDaTh2SU95Z2hPeWduRG9nN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPeWRoQ0Rxc29NZ0tHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKeTg2NkdjSU8yWmxleWR1Q2tLTHk4ZzdLTzg3SjJZT2lEc2dxenNtcW5ybjRuc25ZQWc2ckNCN0o2UUlPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFuT3VMcEM0S0NtTnZibk4wSUdoMGRIQWdQU0J5WlhGMWFYSmxLQ2RvZEhSd0p5azdDbU52Ym5OMElHWnpJRDBnY21WeGRXbHlaU2duWm5NbktUc0tZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3Q25SeWVTQjdJR1p6TG0xclpHbHlVM2x1WXloRlRWQlVXVjlEVjBRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbElIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwamIyNXpkQ0JEVEVGVlJFVmZSVTVXSUQwZ1QySnFaV04wTG1GemMybG5iaWg3ZlN3Z2NISnZZMlZ6Y3k1bGJuWXNJSHNLSUNCTlFWaGZWRWhKVGt0SlRrZGZWRTlMUlU1VE9pQW5NQ2NzSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNnNTNxc0lFZzY2cW82NU9jSU91QmxDQW83S2VuN0oyQUlPdXN1T3Exck95WGxDRHJ0b2p0bFlUc21wUXBDaUFnUTB4QlZVUkZYME5QUkVWZlJFbFRRVUpNUlY5T1QwNUZVMU5GVGxSSlFVeGZWRkpCUmtaSlF6b2dKekVuTENBdkx5RHRoTFFnN0pxVTdKVzlJT3VUc1NEcnRvRHFzSUFnN1ppNDdMYWNJT3VCbEFvZ0lFUkpVMEZDVEVWZlZFVk1SVTFGVkZKWk9pQW5NU2NzQ24wcE93b0tMeThnN0lpbzZybUFJT3lMcE8yV2lTanFzSkRzaTV6c25wQWc3SXFrN1krdzdKMkFJSE4wWkdsdklHbG5ibTl5WlNuc2w1RHNoSnpyajRRZzY2eTQ3S0NjNjZXOElPeTJsT3lnZ2UyVm9DRHNpSmdnN0o2STZyS01JT3k5bU95R2xDRHJvWnpxdDdqcnBid2c3WXlNN0oyODdKZVE2NCtFSU91Q3FPcTR0T3VMcEM0S0x5OGc3SnlFN0xtWU9pRHNub1RzaTV3ZzdZKzA2NDJVN0oyWUlHTnNZWFZrWlMxaWNtbGtaMlV1Ykc5bklDanNuSWpyajRUc21yQWdKVlJGVFZBbExDRHJwNlVnSkZSTlVFUkpVaWt1SURKTlFpRHJoSmpzbkx6cnFiUWdMbTlzWk91aG5DRHRsWndnN0lTNDY0eUE2NmVNSU91enRPcTBnQzRLWTI5dWMzUWdURTlIWDBaSlRFVWdQU0J3WVhSb0xtcHZhVzRvYjNNdWRHMXdaR2x5S0Nrc0lDZGpiR0YxWkdVdFluSnBaR2RsTG14dlp5Y3BPd3BqYjI1emRDQmZiM0pwWjB4dlp5QTlJR052Ym5OdmJHVXViRzluTG1KcGJtUW9ZMjl1YzI5c1pTazdDbU52Ym5OdmJHVXViRzluSUQwZ1puVnVZM1JwYjI0Z0tDa2dld29nSUdOdmJuTjBJR0Z5WjNNZ1BTQkJjbkpoZVM1d2NtOTBiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bmFXWjVLR0VwS1NrdWFtOXBiaWduSUNjcElDc2dKMXh1SnpzS0lDQWdJR1p6TG1Gd2NHVnVaRVpwYkdWVGVXNWpLRXhQUjE5R1NVeEZMQ0JzYVc1bEtUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUR0akl6c25id2c2NkdjNnJlNElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUcnBxenJpcFFnNnJPRTdJYU5JQ292SUgwS2ZUc0tDbU52Ym5OMElGQlBVbFFnUFNCT2RXMWlaWElvY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDFCUFVsUXBJSHg4SURFeE9EZzRPeUF2THlCQ1VrbEVSMFZmVUU5U1ZPdUtsQ0R0aFl6c2lxVHRpcmpzbXFrZ0tPMlBpZXlHak95WGxDQXhNVGc0T0NEcXM2RHNvSlVwQ2k4dklPdUxwT3VtckNEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVm5PdUxwQzRnN0wyVTY1T2M2Nlc4SUhCMWJHekN0K3V6dGV5Q3JPMlZ0T3VQaENBcUt1eWR0T3V2dUNEcmxxQWc3SjZJNjRxVUlPdUxwT3Vtck91S2xDRHNtSnNnN0wyVTY1T2NJT3EzdU91TWdPdWhuQ29xNjUyOENpOHZJT3E3a091THBDRHN2SnpxdUxBZzdLQ0U3SmVVSU95RGlDRHJqNW5zbnBIc25iUWc3SldJSU91Q21PeVlxT3VMcENqdGhMRHJyN2pyaEpEc25iUWc2NXlvNjRxVUlPdVRzU2t1SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RzbmJRZzZyQ1M3Snk4NjZHY0lPcTFyT3V5aE95Z2hPeWRoQ0Rxc0pEc3A0RHRsYlFnN0o2czdJdWM3SjZSN0l1YzdZS282NHVrTGdvdkx5RHJqNW5zbnBIc25iUWc2N0NVNjRDTTY0cVVJT3lJbU95Z2xleWRoQ0R0bFpqcnFiUWc3SjIwSU95SXEreWVrT3VsdkNEc21LenJwcXpxczZBZ1kyOWtaUzUwYyt5ZG1DQkNVa2xFUjBWZlRVbE9YMWJyajRRZzZyQ1o3SjIwSU95WXJPdW1zT3VMcEM0S1kyOXVjM1FnUWxKSlJFZEZYMVlnUFNBeU56c0tMeThnNnJpdzY3TzRJT3VxcU91TnVDNGc3SnFVN0xLdEtPMlVqT3Vmck9xM3VPeWR1Q25zbmJRZ2JXOWtaV3pzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3EzdUNEc21wVHNzcTNycDR3ZzZyZTRJT3VxcU91TnVPdWhuQ0Rzc3BqcnBxenRsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPY0lDaHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FnNG9DVUlHSjFhV3hrTFdkc2IzTnpZWEo1TG1wejdKbUFJT3F3bWV5ZGdDRHRqSXpzaEp3cElPS1VnT0tVZ0FwbWRXNWpkR2x2YmlCc2IyRmtSWGhoYlhCc1pYTW9LU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FuS1N3Z0ozVjBaamduS1RzS0lDQWdJR052Ym5OMElITmxZMGxrZUNBOUlHMWtMbk5sWVhKamFDZ3ZYaU1qSU95MmxPeXluQ0RzbUlqc2k1eGNjeW9rTDIwcE93b2dJQ0FnYVdZZ0tITmxZMGxrZUNBOVBUMGdMVEVwSUhKbGRIVnliaUJiWFRzS0lDQWdJR052Ym5OMElHVjRZVzF3YkdWeklEMGdXMTA3Q2lBZ0lDQnNaWFFnWTNWeUlEMGdiblZzYkRzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnY21GM0lHOW1JRzFrTG5Oc2FXTmxLSE5sWTBsa2VDa3VjM0JzYVhRb0oxeHVKeWtwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlISmhkeTV5WlhCc1lXTmxLQzljY3lza0x5d2dKeWNwT3dvZ0lDQWdJQ0JqYjI1emRDQm9JRDBnYkdsdVpTNXRZWFJqYUNndlhpTWpJMXh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9hQ2tnZXlCamRYSWdQU0I3SUdsdWNIVjBPaUJvV3pGZExDQnpkV2RuWlhOMGFXOXVjem9nVzEwZ2ZUc2daWGhoYlhCc1pYTXVjSFZ6YUNoamRYSXBPeUJqYjI1MGFXNTFaVHNnZlFvZ0lDQWdJQ0JqYjI1emRDQmlJRDBnYkdsdVpTNXRZWFJqYUNndlhseHpLaTFjY3lzb0xpcy9LVnh6S2lRdktUc0tJQ0FnSUNBZ2FXWWdLR0lnSmlZZ1kzVnlLU0JqZFhJdWMzVm5aMlZ6ZEdsdmJuTXVjSFZ6YUNoaVd6RmRMbk53YkdsMEtDY2dMeUFuS1M1cWIybHVLQ2NnSnlrcE93b2dJQ0FnZlFvZ0lDQWdjbVYwZFhKdUlHVjRZVzF3YkdWekxtWnBiSFJsY2lnb1pTa2dQVDRnWlM1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ1BpQXdLVHNLSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpd0lPcXpvT3k1cUNBcklPeVd0T3lJbkNEcnM0RHFzcjBpN0oyMElPdVFuT3VMcEM0ZzdKZXQ3WldnSU91MmhPdW1yQ0RpZ0pRS0x5OGc3WUcwNjZHYzY1T2NJRDBnNjZ5NDdKNmxJT3VMcE91VHJPcTRzQ2pzc0wzc25aZ3BMQ0RzbXFuc2xyUWc3WWExN0oyOHdyZnJwNTdzdHFUcnNwVWdQU0JqYjJSbExuUnpJSEpsWm1sdVpVRnBVM1ZuWjJWemRHbHZibk1nN1p1RTdMS1k2NmFzS09xNHNPcXpoT3lnZ1NrdUNtTnZibk4wSUZOVVdVeEZYMUpWVEVWVElEMGdXd29nSUNjeExpRHRsYlRzbXBUc3NyUTZJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWc3WlcwN0pxVTdMSzA2NkdjTGlBbzY3TzA2NE9GNjR1STY0dWs0b2FTNjdPMDY0SzA3SnFVS1Njc0NpQWdKekl1SU91S3BldVBtZXlnZ1NEcnA1RHRsWmpxdUxBNklPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ3dnZnV5WGlDRHJ1YnpxdUxBbzY3Q1U2NENNN0plSTdKYTA3SnFVNG9hUzY3Q1U2citvN0phMDdKcVVLUzRnNjR1b0xDRHNvb1hybzR6Q3QrdW5qT3Vqak1LMzdKZXc3TEswd3JmdGxiVHNwNERDdCtxNHNPdWhuY0szNjRXNTdKMk1JT3VUc1NEc2k1enNpcVR0aFp6c25iUWc3S084N0xLMDdKMjRJT3F5c09xenZPdUtsQ0RzaUpqcmo1bnRtSlVnN0p5ZzdLZUFLT3lYc095eXRPdVB2T3lhbEN3ZzY0VzU3SjJNNjQrODdKcVVLUzRuTEFvZ0lDY3pMaURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3T2lBaWZ1MlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlpRHJqSURzaTZBZ0luN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRaUlPcTFyT3loc0NEc21yRHNoS0F1SU91THFDd2c3S0NWN0xHRjdJT0JJT3UyaU9xd2dNSzM3SjI4NjdhQUlPcTRzT3VLcFNEc29KenRsWnpDdCt1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPcXlzT3F6dk1LMzdLQ1Y2N08wSU91enRPMll1Q0RzbFlqc2k2enNuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMmVpQzRuTEFvZ0lDYzBMaURzdXBEc283enNscnp0bFp3ZzZySzk3SmEwT2lCKzdaV1k3SXVjNnJLZzdKYTA3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cExpY3NDaUFnSnpZdUlPMlJuT3E0c0RvZzY1Q1k3SmEwN0pxVTRvYVM2NCs4N0pxVUxpY3NDaUFnSnpjdUlPeWtoQ0RxdGF6c29iQTZJT3lia091enVPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPeTJsT3l5bk91UGhDRHJzSmpyazV6c2k1d2c3WldjSU95a2hPdWhuQzRnN0o2RTdKMlk2NkdjSU95a2hPeWRoQ0RyaXBqcnBxenNwNEFnN0pXSzY0cVU2NHVrTGlEcmk2Z3NJT3lYck91ZnJDRHJyTGpzbnFYc25ZUWc3WldZNjRLWTdKMllJT3E0amV5Z2xlMllsU0Ryckxqc25xWHNuTHpyb1p3ZzdaV3A3TE9RSU91TmxDRHFzSVRxc3JEdGxiVHNwNFRyaTZUcnFiUWc3S1NFSU95SW1PdWx2Q0RzcElUc25iVHJpcFFnNnJLRDdKMkFJTzJabU95WWdTNG5MQW9nSUNjNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1NEcnNvVHRpcnc2SU9xeXNPcXp2Q0R0aHJYcnM3VHJpcFFnVysyWmxleWR1RjBzSU95WWlDL3NsWVRyaTRqc21LUWc3WXlRNjR1bzdKMkFJRnZzbFlUcmk0anNtS1JkTDF2cmhLUmRMQ0RyajVuc25wRWc3SnlnNjQrRTY0cVVJRnZzdDZqc2hveGRMMXQ3NjQrWjdKNlJmVjB1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ0RzazdEcXM2QWdJdXVMcStxNHNNSzM2NCtaN0o2Ukl1eXltT3VmdkNEc3A1MGc3SldJSU91bm51dUtsQ0Rzb2JEdGxhbkN0K3VMcU91UGhTQWk3TGVvN0lhTUl1dUtsQ0RxdUlqc3A0QXVKeXdLSUNBbk9TNGc3SjIwNjZhRXdyZnNvSVR0bVpUcnNvanRtTGpDdCt1bmlPeUtwTzJDdWV5ZGdDRHF0N2pyaklEcm9ad2c2N08wN0tHMExpRHNncXpybm96c25ZUWc2N2FBNjZXOElPdVZrQ0RyaTVqc25ZUWc2N2FaN0plczY0K0VJT3lpaSt1THBDNG5MQW9nSUNjeE1DNGc3S0NjN1pLSUlPeWFxZXlXdENEc25LRHNwNEE2SU95ZWhldWdwZXlYa0NEc2s3RHNuYmdnNnJpdzY0cWw3SVN4SU91cWhleUNyQ2pyczREcXNyMHNJT3luZ095Z2xTd2c2NU94NjZHZExDRHRsYlRzb0p3ZzY1T3hLZXVLbENEdG1aVHJxYlRzblpnZzZyaXc2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqc2lKanJqNW50bUpYQ3QrcXl2ZXlXdE1LMzY3YUE3S0NWN1ppVklPMlhpT3lhcVNEc3ZJRHNuYlRzaXFRcDdKMllJT3VKbU95Vm1leUtwT3F3Z0NEc25LRHNpNlRya0p6cmk2UXVDaTh2SU8yTWpPeWR2T3lkdENEc2w0YnNuTHpycWJRbzdJU2s3TG1ZNjdPNElPcTFyT3V5aE95Z2hDRHJrN0VwSU91NWlDRHJyTGpzbnBEc2w3UWc0b0NVSU95YWxPeVZ2ZXVuak95Y3ZPdWhuQ0RyajVuc25wRW9abUZwYkMxemIyWjBLUzRLWm5WdVkzUnBiMjRnYkc5aFpFZDFhV1JsS0NrZ2V3b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuZFhndGQzSnBkR2x1Wnk1dFpDY3BMQ0FuZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUhKbGRIVnliaUJ0WkM1c1pXNW5kR2dnUGlBeE1EQWdQeUJ0WkNBNklDY25Pd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3Vobk91VG5DRHNpNlR0aktnZ0tPeWFsT3lWdmV1bmpPeWN2T3VobkNEc3A0VHRsb2twT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNCeVpYUjFjbTRnSnljN0NpQWdmUXA5Q21OdmJuTjBJRWRWU1VSRklEMGdiRzloWkVkMWFXUmxLQ2s3Q2dwbWRXNWpkR2x2YmlCcGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTQjdDaUFnWTI5dWMzUWdabVYzVTJodmRDQTlJRVZZUVUxUVRFVlRMbTFoY0Nnb1pYZ3BJRDArSUNkSmJuQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExtbHVjSFYwS1NBcklDZGNiazkxZEhCMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG5OMVoyZGxjM1JwYjI1ektTa3VhbTlwYmlnblhHNG5LVHNLSUNCeVpYUjFjbTRnS0FvZ0lDQWdKK3luZ09xNGlPdTJnTzJFc0NEcmhJanJpcFFnN0plUTdJcWs3SnVRS0ZNdE1Td2c2N08wN0pXSTdacU03SUtzS2V5ZG1DRHRsWnpxdGEzc2xyUWdWVmdnVjNKcGRHbHVaeURzb0lUcnJManFzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91THBDNGdKeUFyQ2lBZ0lDQW43S0d3NnJHMElPMlJuTzJZaENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzB3cmZzdElqcXM3ekN0K3V2dU91bmpNSzM2N2FBN1lTd3dyZnF1WXpzcDRBZzY1T3hLZXlkZ0NEc29KWHNzWVVnN0tDVjY3TzA2NHVrSU9LQWxDRHJ1Ynpxc2JEcmdwZ2c2NHVrNjZXNElPeWhzT3F4dE95Y3ZPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhLQ0kxN1pxTUlPeWR0T3lEZ1NMc25ZUWdJalh0bW93aTY2R2NJT3lraE95ZHRPdXB0Q0RzbUtUcmk3VXBMaUFuSUNzS0lDQWdJQ2ZzbTVEcnJManNsNUFnN0plRzY0cVVJT3Exck95eXRDRHNvSlhyczdRbzdLQ0U3Wm1VNjdLSTdaaTR3cmRWVWt6Q3QrcTRpT3lWb2NLMzdJdWM2ckNFSU91VHNTbnNtWUFnN1pXMDZyS3dJT3V3cWV1eWxjSzM3S0NJN0xDb0tPeWVyT3lFcE95Z2xjSzM2Nnk0N0oyWTdMS1l3cmZzbnF6c2k1enJqNFFnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjdhWjdKMjA2NHFVSU9xeWcreWRnQ0Rzb0lqcmpJQWc2cmlJN0tlQUlPS0FsQ0RzbFlUcmlwUWc2ckNTN0oyMDY1Mjg2NCtFTENEcXQ3anJuN1RyazYvdGxiVHJqNFFnN0pPdzdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdKelBxc0p3ZzdLQ2M3SldJN0oyQUlPeUVuT3VobkNEc29KSHF0N3pzbmJRZzY0dXM2NTI4N0pXOElPMlZuT3VMcENEaWdKUWc3WldZNjRLWTY0cVVJT3lia091c3VDRHF0YXpzb2JEcnBid2c3SnlnN0tlQTdaV2NJT3kxbk95R2pDRHJpNlRyazZ6cXVMQXNJTzJWbU91Q21PdUtsQ0Ryckxqc25xVWc2cldzN0tHdzY2VzhJT3llck9xMXJPeUVzZTJWbkNEcmpJRHNsWWdzSUNjZ0t3b2dJQ0FnSitxM3VPdW1yT3F6b0NEc29JSHNsclRyajRRZzdaV1k2NEtZNjRxVUlPcXp2T3F3a08yVm5DRHNucXpxdGF6c2hMRTZJT3lra2V1enRTRHRrWnp0bUlUc25ZUWc2NDJjN0phMDY0SzA2ck9nTENEc29KWHJzN1FnN0lpYzdJU2M2Nlc4SU95Q3JPeWFxZXlla09xd2dDRHNsWXpzbFlUc2xid2c3WldnSU9xeWcrdTJnTzJFc091aG5DRHNucXpzb2JEc3A0SHRsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZ0lDQWdKK3lWaE91ZW1DRHNtSWpzaTV6cms2VHNuWUFnN1pXY0lPeWtoT3lubk91bXJDRHN0WnpzaG93ZzZyV1E3S0NWN0oyMElPdW5qdXluZ091bmpDRHF0N2pxc2JRZzdZYWtLTzJWdE95YWxPeXl0TUszNnJLOTdKYTBLZXlkbUNEcXRaRHJzN2pzbmJUc3A0QWc3SWFNNnJlNTdJU3g3SjJZSU9xMWtPdXp1T3lkdENEc2xZVHJpNGpyaTZRZzRvQ1VJT3lYck91ZnJDRHJyTGpzbnFYc3A1enJwcXdnN0o2RjY2Q2w3SjJBSU91cGxPeUxuT3luZ0NEcmk2anNuSVRyb1p3ZzY0dWs3SXVjSU95RXBPcXpoTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcnNMRHNsN1RycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaGNLMzdMMlU2NU9jN1k2YzdJcWtJT3E0aU95bmdEcGNiaWNnS3dvZ0lDQWdKMXQ3SW5SbGVIUWlPaUFpN0tDYzdKV0lJT3VzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV1c3RPeVhoK3lkaENEc21ad2c2N0NVNnIrbzY0cVU3S2VBSU8yVm5PcTFyZXlXdENEdGxad2c2Nnk0N0o2bEluMHNJQzR1TGwxY2JseHVKeUFyQ2lBZ0lDQW5XK3lLcE8yRGdPeWR2Q0RxdDV6c3VabGRYRzRuSUNzZ1UxUlpURVZmVWxWTVJWTWdLeUFuWEc1Y2JpY2dLd29nSUNBZ0tFZFZTVVJGSUQ4Z0oxdnNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3lnaE91c3VDQW9kWGd0ZDNKcGRHbHVaeTV0WkNrZzRvQ1VJT3ljaENEcXQ1enN1Wm5zblpnZzZyZTg2ckd3N0ptQUlPeVlpT3ladUNEc2k1enJncGpycHF6c21LUXVJTzJLdWUyZWlDRHNtSWpzbWJnZzZyZWM3TG1aS095SW1PdVBtZTJZbGNLMzZySzk3SmEwd3JmcnRvRHNvSlh0bUpYc25ZUWc3SnlnN0tlQTdaVzA3Slc4SU8yVm1PdUtsQ0RzZzRIdG1ha3A3SjJFSU9xM3VPdU1nT3VobkNEcmxMRHJwYlRxczZBc0lPeWFsT3lWdmVxenZDRHNvSVRyckxqc25iUWc2NHVrNjZXMDY2bTBJT3lnaE91c3VPeWRoQ0RybExEcnBianJpNlJkWEc0bklDc2dSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cGJtVkNkV1lnUFNBbkp6c2dJQ0FnSUNBZ0lDQXZMeUJ6ZEdSdmRYUWc3S1NFSU91eWhPMk52QXBzWlhRZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQzh2SU8yWWhPeWVyQ0R0aExUc25aZ2dleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIMEtiR1YwSUhGMVpYVmxJRDBnVUhKdmJXbHpaUzV5WlhOdmJIWmxLQ2s3SUM4dklPeWFsT3l5clNEc3A0SHJvS3p0bVpRZ0tPdVBtZXlMbkNEc21wVHNzcTNzbllBZzdJaWM3SVNjNjR5QTY2R2NLUXBzWlhRZ2RIVnlibk1nUFNBd093cHNaWFFnZDJGeWJXVmtWWEFnUFNCbVlXeHpaVHNLYkdWMElHTjFjbkpsYm5STmIyUmxiQ0E5SUVOTVFWVkVSVjlOVDBSRlREc2dMeThnN0tlQTZyaUlJT3lFdU95Rm1PeWR0Q0Ryckx6cXM2QWc3SjZJNjRxVUlPdXFxT3VOdUNBbzdKcVU3TEt0N0oyMElPdUxwT3VsdUNEcnFxanJqYmpzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3lFdU95Rm1DRHNucXpzaTV6c25wRXBDaTh2SU95TG5PeWVrU0RzaTV3Z1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbElFTk1TU25xc0lBZzdKTzRJT3lJbUNEc25vanJpcFRzcDRBZzdLQ1E2cktBSU9LQWxDRHNsNGJzbkx6cnFiUWdMMmhsWVd4MGFPdWhuQ0RzbFl6cm9LUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeVZpT3VDdE8yVm5PdUxwQzRLTHk4Z2JuVnNiRDN0bVpYc25iZ2c3S1NSTENBbmIyc25QZXlDck95YXFTRHFzSURyaXFVc0lDZGpiR0YxWkdVdGJXbHpjMmx1WnljOVkyeGhkV1JsSU91cWhldWd1U0RzbDRic25Zd3NDaTh2SUNkamJHRjFaR1V0Ykc5bmIzVjBKejFqYkdGMVpHWHJpcFFnN0o2STdLZUE2NmVNSU91aG5PcTN1T3lkdUNEc2hManNoWmdnNjZlTTY2T01JQ2p0aExRZzdJdWs3WXlvSU95TG5DRHFzSkRzcDRBc0lPeUVzZXF6dFNEdGhMVHNuYlFnN0ppazY2bTBJT3lla091UG1TRHRsYlRzb0p3cENpOHZJQ2RqYkdGMVpHVXRiR2x0YVhRblBldWhuT3EzdU95ZHVPeWRnQ0Rya0pEc3A0RHJwNHdnN0lLczdKcXBJTzJWbk91UGhDRHN0SWpxczd3Z0tPeWhzT3k1bU9xd2dDRHNucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWjdKMkFJT3F5dmV1aG5PdWhuQ0RzbnFIdG5vanJyNERyb1p3ZzdLU1I2NmE5SU8yUm5PMlloT3lkaENEc2s3VHJpNlFLWTI5dWMzUWdURTlIU1U1ZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVPeWR0Q0R0bFlUc21wVHRsYlRzbXBRbzdKV0lJT3VRa09xeHNPdUNtQ0RycDR6cm80d3BJT0tBbENCYjhKK2ZvQ0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjBnNjdLRTdZcTg3SjJFSU91SWhPdWx0T3VwdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHRPeVd0T3VUbk91Z3BPeWFsQzRuT3dvdkx5RHNpNlRzdUtIdGxad2c2Nnk0NnJXczY1T2tPaUFpUm1GcGJHVmtJSFJ2SUdGMWRHaGxiblJwWTJGMFpUb2dUMEYxZEdnZ2MyVnpjMmx2YmlCbGVIQnBjbVZrSUdGdVpDQmpiM1ZzWkNCdWIzUWdZbVVnY21WbWNtVnphR1ZrSWlqcnA0enJvNHdwTEFvdkx5QWlUbTkwSUd4dloyZGxaQ0JwYmlEQ3R5QlFiR1ZoYzJVZ2NuVnVJQzlzYjJkcGJpSW82Nis0NjZHYzZyZTQ3SjI0S1NEaWdKUWc2NUdZSU91THBDRHNucUh0bm9qcXNvd2c2NFNUN1o2TTY0dWtDbVoxYm1OMGFXOXVJR2x6UVhWMGFFVnljbTl5S0hNcElIc0tJQ0J5WlhSMWNtNGdMMkYxZEdobGJuUnBZMkYwZkc5aGRYUm9mR0Z3YVNCclpYbDhiRzluSUQ5cGJueHNiMmRuWldSOGMyVnpjMmx2YmlCbGVIQnBjbVZrTDJrdWRHVnpkQ2hUZEhKcGJtY29jeWtwT3dwOUNpOHZJT3lDck95YXFTRHRsWnpyajRRZzdMU0k2ck84SU9xd2tPeW5nQ0RpZ0pRZzY2R2M2cmU0N0oyNDdKMkFJT3VwZ095cG9lMlZuT3VOc0NBaTY0MlVJT3VxdXlEc2s3VHJpNlFpNjRxVUlPcXl2ZXlhc0M0ZzY2R2M2cmU0N0oyNElPdW5qT3Vqak95WmdDRHNvYkRzdVpqcXNJQWc2NHVzNjUyODdJU2NJT3VVc091aG5DRHNucUhyaXBUcmk2UXVDaTh2SU95THBPeTRvU2d5TURJMkxUQTRMQ0R0bW96c2dxd2c3SmVVN1lTdzdaU0U2NTI4N0oyMDdLYUlJT3lpak95RW5TazZJQ0paYjNVbmRtVWdhR2wwSUhsdmRYSWdhVzVrYVhacFpIVmhiQ0J6Y0dWdVpDQnNhVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6c25wRHNsNURxc293ZzdaV2M2NCtFNjZXOElPeVlyT3VncENEcmk2enJuYnpxczZBZzdKcVU3TEt0N1pXWTZyT2dMQ0RzbFlUcmk0anJxYlFnVy9DZm42QWc3WUcwNjZHYzY1T2NJTzJWbk91UGhDRHN0SWpxczd4ZElPdXloTzJLdk95ZGhDRHJpSXpybjZ3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsYlFnN0tPODdJUzQ3SnFVTGljN0NpOHZJQ2Z0bFp6cmo0UW42NkdjSU91dGlldWFzZXEzdU91bXJPdXB0Q0RzbFlnZzY1Q2M2NHVrSU9LQWxDRHNucURxdVpBZzY2cXc2NmEwSU91VmpDRHJncGpyaXBRZ2NtRjBaU0JzYVcxcGRPeWR0T3VDbUNEcnJManJwNlVnNnJpNDdKMjBJT3kwaU9xenZPcTVqT3luZ0NEc25xSHNsWVFLTHk4ZzdKZUo2NXF4N1pXWTZyS01JQ0xyaTZUcnBiZ2c2ck9FN0tDVjdKeTg2NkdjSU91aG5PcTN1T3lkdU8yVm1PdWR2Q0xxczZBZzdKV0k2NEswN1pXWTZyS01JT3VRbk91THBDNGc3S2VBN0xhY3dyZnNncXpzbXFucm40a2c3SU9CN1pXY0lPdXN1T3Exck91bmpDRHNvb0h0bUlEc2hKd2c2N080NjR1a0NtWjFibU4wYVc5dUlHbHpUR2x0YVhSRmNuSnZjaWh6S1NCN0NpQWdjbVYwZFhKdUlDOXpjR1Z1WkNCc2FXMXBkSHgxYzJGblpTMWpjbVZrYVhSemZIVnpZV2RsSUd4cGJXbDBJQ2h5WldGamFHVmtmR1Y0WTJWbFpHVmtLUzlwTG5SbGMzUW9VM1J5YVc1bktITXBLVHNLZlFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56NjZXOElPeWR2ZXlXdEFvdkx5QXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZuT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbENEc3BKSHNuYmpzcDRBaUlPMlJuT3lMbkNEaWdKUWc2ck8xN0pxcElGQkQ3SmVRN0lTY0lPdUNxT3lkbUNEcXM0VHNvSlVnN0ppazdJS3M3SnFwSU91d3FleW5nQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMElPeWR0Q0Rxc0pMcXM3d2c3WXlNN0oyODdKMllJT3F6aE95Z2xleWR0Q0RzbHJUcXVJdnJncHpyaTZRS2JHVjBJSE5sYzNOcGIyNUJZMk52ZFc1MElEMGdiblZzYkRzS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzS0lDQnBaaUFvUkdGMFpTNXViM2NvS1NBdElHRmpZMjkxYm5SRFlXTm9aUzVoZENBOElETXdNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3dvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTNXFjMjl1Snlrc0lDZDFkR1k0SnlrcE93b2dJQ0FnWlcxaGFXd2dQU0FvYWlBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZENBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZEM1bGJXRnBiRUZrWkhKbGMzTXBJSHg4SUc1MWJHdzdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nNjZHYzZyZTQ3SjI0SU95ZHRPdWdwU0RzbDRic25Zd2c2NU94SU9LQWxDQnVkV3hzSU95Y29PeW5nQ0FxTHlCOUNpQWdZV05qYjNWdWRFTmhZMmhsSUQwZ2V5QmhkRG9nUkdGMFpTNXViM2NvS1N3Z1pXMWhhV3dnZlRzS0lDQnlaWFIxY200Z1pXMWhhV3c3Q24wS1puVnVZM1JwYjI0Z1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LU0I3Q2lBZ1kyOXVjM1FnY0hKdlltVWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0TFhabGNuTnBiMjRuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdJSDBwT3dvZ0lHeGxkQ0J2ZFhRZ1BTQW5KenNLSUNCd2NtOWlaUzV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJ2ZFhRZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc0tJQ0J3Y205aVpTNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljN0lIMHBPd29nSUhCeWIySmxMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVFpXTTZJQ2NuSUgwN0Nnb3ZMeURpbElEaWxJQWc3WlNNNjUrczZyZTQ3SjI0SU95RG5leWh0Q0Rxc0pEc3A0QW83SXVzN0o2bDY3Q1Y2NCtaS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdaU002NStzNnJlNDdKMjQ3SjIwSU91V29DRHNub2pyaXBRZzY0K1o3SldJSUdOdlpHVXVkSFBxc0lBZ05leTBpT3VuaU91THBDQlFUMU5VSUM5b1pXRnlkR0psWVhUcnBid2c2N08wNjRLNDY0dWtMZ292THlEdGxad2c2N0tJN0oyMDY1Mjg2NCtFSU91d20reWRnQ0Rya3FRZ016RHN0SWpxc0lRZzY0R0s2cml3NjZtMElPMlVqT3Vmck9xM3VPeWR1Q2pybUpEcmlwUWc3WlM4NnJlNDY2ZUlLZXlkdENEcmk2dnRub3dnNnJLRElPS0FsQ0R0Z2JUcm9aenJrNXpxdVl6c3A0QWc2NDJ3NjZhczZyT2dJT3F3bWV5ZHRDRHF1cnpzcDRUcmk2UXVDaTh2SU95VmhPeW5nU0R0bFp3ZzY3S0k2NCtFSU91cXV5RHJzSnZzbFpqc25MenJxYlFvNjR1azY2YXM2NmVNSU91b3ZPeWdnQ0RzdktBZzdJT0I3WU9jTENEc25wRHJqNW5zaTV6c25wRWc2NU94S1NEcXM0VHNobzBnNjR5QTZyaXc3WldjNjR1a0xncGpiMjV6ZENCSVJVRlNWRUpGUVZSZlJFVkJSRjlOVXlBOUlETXdNREF3T3dwc1pYUWdiR0Z6ZEVKbFlYUWdQU0F3T3dwelpYUkpiblJsY25aaGJDZ29LU0E5UGlCN0NpQWdhV1lnS0d4aGMzUkNaV0YwSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFtVmhkQ0ErSUVoRlFWSlVRa1ZCVkY5RVJVRkVYMDFUS1NCN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFnNG9DVUlPMlV2T3EzdU91bmlDL3RsSXpybjZ6cXQ3anNuYmpzbmJRZzY0dXI3WjZNSU9xeWcreWN2T3VobkNEcnM3VHFzNkFnNnJDWjdKMjBJT3E2dk95bmtldUxpT3VMcEM0bktUc0tJQ0FnSUhCeWIyTmxjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQc25MenJvWndnWTJ4aGRXUmxJTzJLdU91bXJPdWx2Q0Rzb0pYcnBxenRsWnpyaTZRS0lDQjlDbjBzSURVd01EQXBPd29LTHk4ZzRwU0E0cFNBSU9xemhPeWdsU0Rzb0lUdG1aanNuWUFnN0l1YzdZR3M2NmEvSU95d3ZleWN2T3VobkNBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU1qY3BJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0Fvdkx5QmI2ck9FN0tDVklPeWdoTzJabUYzc25ZUWc2NGlNNjZDQTY0cVU2NDJ3SUNKRGJHRjFaR1VnUTI5a1pldUxtT3lkdENEaWdLYnNsN0Rxc3JEc25ZUWc3SnFVN0xLdDdaYUk3SXExNjR1STY0dWtJaWpzaXJuc25iZ2c3Wm1VNjZtMEtlcXdnQ0RybktqcmlwUWc2cktNSU91MmlPdW5qT3lkdE95WGlPdUxwQzRLTHk4ZzY3aU02NTI4N0pxdzdLQ0E3SmVRSU95WW15RHFzNFRzb0pVZ1kyeGhkV1JsTG1GcElPeUV1T3lGbU95ZHRDRHJncWpzbFlRZzdKNkk3Snk4NjZtMElHRjFkR2h2Y21sNlpTQlZVa3pzbllBZzZyT0U3S0NWN0oyRUlPdXN1K3luZ0NEc2xZcnFzNkFnNnJlNElPcXpoT3lnbGV5Y3ZPdWhuQW92THlEc2lybnNuYmpycDR3ZzY2eTc2NHFVNjR1a0xpQlZVa3pzbDVBZ2MyVnNaV04wUVdOamIzVnVkTUszY0hKdmJYQjA2Nlc4SU95VWpPeWFzT3F4c091Q21DQnNiMmR2ZFhRL2NtVjBkWEp1Vkcvcm9ad2c3SjZINjRxVUlPcXh0Q0Rzb0lUcnRvQWc3SXVrN1l5bzdaYUk2NHVrQ2k4dklDanNsWVRybnBnZ0owSlNUMWRUUlZJZzZyQ0E2NkdjN0xHRTZyaXdKeURzbzd6c2hKM3NuWmdnN1o2STdJcWs3WWFnNjZhc0tTNGdLaXJzaExqc2haanNuYlFnN0plRzY0cVVJT3l3dmV5WGtPeUVuQ0RzbDdUcnFiUWc2NkdjNnJlNDdKMjRJTzJabE91cHRPeWR0Q0RxdDdqcmc2VWc2NEtZN0ppbzY0dWtLaW9nNG9DVUNpOHZJT3ladU91MmdDRHNncXpzbmJUdGlyanNuWmdnNjZhczY0dWs3SjIwNjZDSjdZcTRJT3Ezbk95NW1leVhrQ0RxdUxEcmpJRHNwNEFnN0pXSzY0cVVJT3ljb095ZHZPMlZuQ0Ryc0tucnNwWHNuYlRybmJ3ZzdKMjA2ckc0SU95VHRPdUxwQzRLTHk4ZzdJU3g2NmE5SU9xM3ZPcXhzQ2d5TURJMkxUQTRJT3lMcE95NG9TazZJT0tSb0NCRFRFbnJpcFFnWVhWMGFHOXlhWHBsSUZWU1RDRHNvSVRyckxqc25ZUWdLaXB6ZEdSdmRYVHNsNUFnN0xDTjY0cVU2NHVrS2lvb0lrbG1JSFJvWlNCaWNtOTNjMlZ5SUdScFpHNG5kQW92THlCdmNHVnVMQ0IyYVhOcGREb2c0b0NtSWlrZzRwR2hJRUpTVDFkVFJWTHJwYndnN0pXRTY2eTA2cktENjQrRUlPeVZpQ0R0bFpqcmlwUWc3SXFrN1lHczY2YTk3WXE0NjZHY0lPeW5nT3lnbGUyVm1PdXB0Q0JEVEVucXNJQWc3SjZRNnJpd0lPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHNwNEFnN0pXSzdKeTg2Nm0wN0lTYzY0K0VDaTh2SUNvcWJHOWpZV3hvYjNOMElPeWVrT3VQbVNEc2lKanJvTG5zbllBZzdKeWc3S2VBS2lydGxaenJpNlFvTVRJM0xqQXVNQzR4SUV4SlUxUkZUaUR0bVpYc25iZ3BJT0tHa2lEc3ZaVHJrNXdnNjdhWjdKZXM2NFNqNnJpd0lPeVhodXlkdENEcmdaM3JncHpyaTZRdUNpOHZJQ29xVlZKTTdKMkFJSE4wWkc5MWRPeVhrT3lFbkNEcXNJRHNvTGpzbUt3ZzZyS0RLaW9nNG9DVUlFSlNUMWRUUlZJZzdaVzQ2NU9rNjUrczdKMllJT3lkdU95ZWtPdWhuQ0Ryc0p2c25MenJxYlFnWTIxazZyQ0FJR0FtWU95WGtPeUVuQ0RzbnBqcm5ienJxTG5yaXBUcmk2UW83SXVrN0xpaE9nb3ZMeUJCVWtkVFgwRk1UT3lkdENBL1kyOWtaVDEwY25WbDdKZVE3SVNjSU91Qm5ldUNtT3F6b0NCamJHbGxiblJmYVdRZzdKMjA3WnVFNnJDQUlPeUNyT3Vkdk95bmtDQTlJQ0xzbnBqcnFydnJrSndnVDBGMWRHZ2c3SnFVN0xLdEl1eWRtQ0RzcDRUc3A1d2c3SnVRN0oyNEtTNEtMeThnNjdpTTY1Mjg3SnF3N0tDQTY0cVVJT3lkdU95ZWtPdWhuQ0RzcDRIc29KRWc2NFNZNnJpMDY0dWtLSE5vWld4c0lPcXl2ZXljb0NEcXVJanNwNEFnNG9DVUlPcXdtZXlkZ0NEc25wanJwcnpzbllRZzY0dTU3WldjNjR1a0tTNEtablZ1WTNScGIyNGdkM0pwZEdWT2IyOXdRbkp2ZDNObGNpZ3BJSHNLSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdZMjl1YzNRZ2NDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ym05dmNDNWpiV1FuS1RzS0lDQWdJR1p6TG5keWFYUmxSbWxzWlZONWJtTW9jQ3dnSjBCbFkyaHZJRzltWmx4eVhHNWxlR2wwSUM5aUlEQmNjbHh1SnlrN0NpQWdJQ0J5WlhSMWNtNGdjRHNLSUNCOUNpQWdZMjl1YzNRZ2NDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ym05dmNDNXphQ2NwT3dvZ0lHWnpMbmR5YVhSbFJtbHNaVk41Ym1Nb2NDd2dKeU1oTDJKcGJpOXphRnh1WlhocGRDQXdYRzRuS1RzS0lDQm1jeTVqYUcxdlpGTjVibU1vY0N3Z01HODNOVFVwT3dvZ0lISmxkSFZ5YmlCd093cDlDaTh2SU95TG5PMkJyT3Vtdnk5SmJsQnlhWFpoZEdVZzdMQzk3Snk4NjZHY0lGVlNUT3lkaENEc2w3RHJpNlF1SU91cXV5RHNsN1RycWJRZ1ptRnNjMlVnNG9DVUlPMll1T3kybk8yVm5DRHNxcjNzbmJRZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWhuQ0R0ajdUcnNMSHRsWnpyaTZRS0x5OGdLTzJQdE91d3NleWR0Q0RzbDRic25MenJxYlFnN0pXRTY2eTBJT3l3dmV1UGhDRHNsWWdnNjVhZzdJU2NJT3lDck95YXFleWVrT3F3Z0NEcnA0bnRub3pyaTZRZzRvQ1VJRUpTVDFkVFJWTHJwYndnYm04dGIzRHNuTHpyb1p3ZzY2ZUo3SldFSU91U2dPcTRzQ0RybFl6cnJMZ3BMZ3BqYjI1emRDQlhTVTVmVUZKSlZrRlVSVjlDVWs5WFUwVlNVeUE5SUZzS0lDQjdJR1Y0WlRvZ0tIQnliMk5sYzNNdVpXNTJMbEJ5YjJkeVlXMUdhV3hsY3lCOGZDQW5RenBjWEZCeWIyZHlZVzBnUm1sc1pYTW5LU0FySUNkY1hFZHZiMmRzWlZ4Y1EyaHliMjFsWEZ4QmNIQnNhV05oZEdsdmJseGNZMmh5YjIxbExtVjRaU2NzSUdac1lXYzZJQ2N0TFdsdVkyOW5ibWwwYnljZ2ZTd0tJQ0I3SUdWNFpUb2dLSEJ5YjJObGMzTXVaVzUyV3lkUWNtOW5jbUZ0Um1sc1pYTW9lRGcyS1NkZElIeDhJQ2RET2x4Y1VISnZaM0poYlNCR2FXeGxjeUFvZURnMktTY3BJQ3NnSjF4Y1IyOXZaMnhsWEZ4RGFISnZiV1ZjWEVGd2NHeHBZMkYwYVc5dVhGeGphSEp2YldVdVpYaGxKeXdnWm14aFp6b2dKeTB0YVc1amIyZHVhWFJ2SnlCOUxBb2dJSHNnWlhobE9pQW9jSEp2WTJWemN5NWxiblpiSjFCeWIyZHlZVzFHYVd4bGN5aDRPRFlwSjEwZ2ZId2dKME02WEZ4UWNtOW5jbUZ0SUVacGJHVnpJQ2g0T0RZcEp5a2dLeUFuWEZ4TmFXTnliM052Wm5SY1hFVmtaMlZjWEVGd2NHeHBZMkYwYVc5dVhGeHRjMlZrWjJVdVpYaGxKeXdnWm14aFp6b2dKeTB0YVc1d2NtbDJZWFJsSnlCOUxBb2dJSHNnWlhobE9pQW9jSEp2WTJWemN5NWxibll1VUhKdlozSmhiVVpwYkdWeklIeDhJQ2RET2x4Y1VISnZaM0poYlNCR2FXeGxjeWNwSUNzZ0oxeGNUV2xqY205emIyWjBYRnhGWkdkbFhGeEJjSEJzYVdOaGRHbHZibHhjYlhObFpHZGxMbVY0WlNjc0lHWnNZV2M2SUNjdExXbHVjSEpwZG1GMFpTY2dmU3dLWFRzS1puVnVZM1JwYjI0Z2IzQmxibEJ5YVhaaGRHVlhhVzVrYjNjb2RYSnNLU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUdadmNpQW9ZMjl1YzNRZ1lpQnZaaUJYU1U1ZlVGSkpWa0ZVUlY5Q1VrOVhVMFZTVXlrZ2V3b2dJQ0FnSUNBZ0lHbG1JQ2doWm5NdVpYaHBjM1J6VTNsdVl5aGlMbVY0WlNrcElHTnZiblJwYm5WbE93b2dJQ0FnSUNBZ0lITndZWGR1S0dJdVpYaGxMQ0JiWWk1bWJHRm5MQ0IxY214ZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUdaaGJITmxJSDBwTG5WdWNtVm1LQ2s3Q2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUxuTzJCck91bXZ5RHNzTDNzbkx6cm9ad2c2NkdjNnJlNDdKMjRJTzJabE91cHRPeWRoQ0RzbDdUc2w0anNsclRzbXBRNklDY2dLeUJ3WVhSb0xtSmhjMlZ1WVcxbEtHSXVaWGhsS1NrN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUhSeWRXVTdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2NtVjBkWEp1SUdaaGJITmxPd29nSUNBZ2ZRb2dJQ0FnTHk4Z2JXRmpUMU1nNG9DVUlPMkJyT3Vock95ZHRDRHNub2pzbkx6cnFiUWc3SXVjN1lHczY2YS9JT3l3dlN3ZzdKZUc3Snk4NjZtMElPMlB0T3V3c1Nqc2dxenRqSXpycHF6cmlwUWdRMHhKNjZHY0lPcXduT3lkdU95Z2xldXp0Q0RyczdUdG1MZ2c3TEM5N0oyRUlPdXF1eURzbDdEcmk2UXBDaUFnSUNCamIyNXpkQ0J5SUQwZ2MzQmhkMjVUZVc1aktDZHZjR1Z1Snl3Z1d5Y3RibUVuTENBblIyOXZaMnhsSUVOb2NtOXRaU2NzSUNjdExXRnlaM01uTENBbkxTMXBibU52WjI1cGRHOG5MQ0IxY214ZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNLSUNBZ0lHbG1JQ2h5TG5OMFlYUjFjeUE5UFQwZ01Da2dleUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdJdWM3WUdzNjZhL0lPeXd2ZXljdk91aG5DRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKMkVJT3lYdE95WGlPeVd0T3lhbENBb1EyaHliMjFsS1NjcE95QnlaWFIxY200Z2RISjFaVHNnZlFvZ0lDQWdjbVYwZFhKdUlHWmhiSE5sT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGRIVnliaUJtWVd4elpUc2dmUXA5Q2k4dklPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJvWndnN0plMDZyaXdLTzJQdE91d3NTa3VJSGRwYmpNeTY0cVVJSEoxYm1Sc2JETXk2NkdjSU9LQWxDQmpiV1RycGJ3ZzdKV0lJT3F4c095emtPeUVuQ0JWVWt6c25aZ2dKdXF3Z0NEc2xZZ2c3SjZZNjZhdzY0dWtDbVoxYm1OMGFXOXVJRzl3Wlc1RVpXWmhkV3gwUW5KdmQzTmxjaWgxY213cElIc0tJQ0IwY25rZ2V3b2dJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSE53WVhkdUtDZHlkVzVrYkd3ek1pY3NJRnNuZFhKc0xtUnNiQ3hHYVd4bFVISnZkRzlqYjJ4SVlXNWtiR1Z5Snl3Z2RYSnNYU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcExuVnVjbVZtS0NrN0NpQWdJQ0JsYkhObElITndZWGR1S0NkdmNHVnVKeXdnVzNWeWJGMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwTG5WdWNtVm1LQ2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNnJpdzY3TzRJT3U0ak91ZHZPeWFzT3lnZ091aG5DRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKMkVJT3lYdE95WGlPeVd0T3lhbENqc2k1enRnYXpycHI4ZzdMQzlJT3lMcE8yTXFDRHRqN1Ryc0xFcExpY3BPd29nSUNBZ2NtVjBkWEp1SUhSeWRXVTdDaUFnZlNCallYUmphQ0FvWDJVcElIc2djbVYwZFhKdUlHWmhiSE5sT3lCOUNuMEtDaTh2SU9LVWdPS1VnQ0JDVWs5WFUwVlNJT3F3Z091aG5PeXhoT3E0c091S2xDRHNvSnpxc2JEcmtKRHJpNlFnS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRJMUtTRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SmlJN0tDRTdKZVVJRUpTVDFkVFJWSWc3Wm1ZNnJLOTY3T0E3SWlZN0plUUlPeWVoT3lMbkNEc2lxVHRnYXpycHIzdGlyanJwYndnNnIyQzdKV0VJRU5NU2Vxd2dDRHNwSUFnWVhWMGFHOXlhWHBsSUZWU1RPeWRoQ0RzbXJEcnBxenFzSUFnNjdDYjdKV0U3SVNjSU95WHRPeVhpT3VMcEM0S0x5OGc2NnFwN0tDQjdKMkFJTzJWbU91Q21PdS9rT3lkdE95WGlPdUxwQ0RpZ0pRZzZyT0U3S0NWSU95Z2hPMlptT3lhcWV5Y3ZPdWhuQ0JWVWt6c25ZUWdZMnhoZFdSbExtRnBMMnh2WjI5MWREOXlaWFIxY201VWJ6M2lnS2Jyb1p3ZzdKNnM3SjZSN0lTeDdaVzBDaTh2SU95S3VleWR1Q0R0bVpUcnFiVHNuWVFnNnJHMDY0U0k2NXV3NnJPZ0lPcXpoT3lnbFNEc2hLRHRnNTBnN1ptVTY2bTA3SmVRSU95bmdlMldpZXlMbk8yQ3BPcTRzQzRnNnJlNElPeWVyT3lla2V5RXNleWRoQ0R0ajVEcXVMRHRsWmpzbnBBbzdJS3M3SnFwN0o2UUlPcXlzT3lnbFNrZzdaVzQ2NU9rNjUrczY0cVVDaTh2SU91cXFleWdnZXlkdENEc2w0YnNsclRzb1l6cXM2QXNJQ29xNjRLbzZyS29JT3VSa091cHRDRHNtS1R0bm9qcm9LUWc2NkdjNnJlNDdKMjQ3SjJFSU91bm5lcXdnT3VjcU91bXNPdUxwQ29xT2dvdkx5QWdJRU5NU2Vxd2dDQlZVa3pzbllRZzY1U3c3SmkwN1pHY0lPeVhodXlkdENEcmhKanF1TERycWJRZ1kyMWs2ckNBSUdBbVlPeVhrT3lFbkNCVlVrenNuWVFnN0o2WTY1MjhJT3V5aE91Z3BDanNuSWpyajRUc21yQXBJR05zYVdWdWRGOXBaQ0Rxc0puc25ZQWc2NUtrN0txOUNpOHZJQ0FnNjZlazZyQ2M2N09BN0lpWTZyQ0FJT3lDck91ZHZPeW5nT3F6b0N3ZzY3aU02NTI4N0pxdzdLQ0E3SmVVSUNMc25wanJxcnZya0p3Z1QwRjFkR2dnN0pxVTdMS3RJTUszSUdOc2FXVnVkRjlwWkNEcnA2VHFzSnpyczREc2lKanFzSUFnNjRpRTY1Mjk2NUNZN0plSTdJcTE2NHVJNjR1a0l1cXdnQ0Rybkt6cmk2UXVDaTh2SUNBZzdJdXM3WldZNjZtMElPdTRqT3Vkdk95YXNPeWdnT3F3Z0NEc2xZVHNtSWdnN0pXSUlPeVh0T3Vtc091THBDanNpNlRzdUtFZ01qQXlOaTB3T0RvZ1EweEpJTzJVaE91aG5PeUV1T3lLcE91S2xDRHJqSURxdUxBZzdLU1I3SjI0NjQyd0lPeXd2ZXlkdENEc2xZZ2c2NXk0S1M0S0x5OGc3SjIwN0tDY0lFSlNUMWRUUlZMcnBid2c2ckcwNjVPYzY2YXM3S2VBSU95Vml1dUtsT3VMcENEaWhwSWdZMnhoZFdSbElFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN0RyaTZRb1EweEpJT3E0c091enVDRHJqNW5zbnBFcExnb3ZMeUFxS3V5ZHRDRHFzcjNyb1p6c2w1QWdWVkpNSU9xd2dPcXp0Y0szN0tTUjZyQ0VJT3lLcE8yQnJPdW12ZTJLdU91bHZDRHJpNlRzaTV3ZzY0U2o3S2VBSU91bmtDRHFzb011S2lvZzZyT0U3S0NWSU95Z2hPMlptT3lkZ0NEc2lybnNuYmdnN1ptVTY2bTBJTzJWbU91THFDQmI2ck9FN0tDVklPeWdoTzJabUYwZzY3S0U3WXE4N0p5ODY2R2NMZ29LTHk4ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1Q0R0bElUcm9aenNoTGpzaXFRZ0tHTnNZWFZrWlNCaGRYUm9JR3h2WjJsdUlDMHRZMnhoZFdSbFlXa3BJT0tBbENBdmIzQmxiaTFzYjJkcGJ1eWR0Q0RzZzUzc2hMSEN0K3EwZ091bXJDNEtMeThnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJR3h2WTJGc2FHOXpkT3VobkNEcXNyRHFzN3pycGJ3ZzY3TzA2NEswN0tTRUlPdVZqT3E1ak95bmdDRHNpS2pzbHJUc2hKd2c2NHlBNnJpdzdaV1k2NHVrNnJDQUxDRHNtWVRybzR6cmtKanJxYlFnN0lxazdJcWs2NkdjSU91Qm5ldUNuT3VMcEM0S2JHVjBJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdDbXhsZENCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUc1MWJHdzdDbXhsZENCc2IyZHBibE4wWVhKMFpXUkJkQ0E5SURBN0lDOHZJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJnZzdJdWM3SjZSSU95TG5PcXdnU0RpZ0pRZzdKNnM3WUcwNjZhdDdKMjBJQ2ZzbnF6c2k1enJqNFFuN0oyNDdLZUFJQ2ZzbnBEcmo1bnNtWVRybzR3ZzdJdWs3WXlvSit5ZHVPeW5nQ0RxdGF6cnRvVHRsWnpyaTZRS1puVnVZM1JwYjI0Z2EybHNiRXh2WjJsdVVISnZZeWdwSUhzS0lDQnBaaUFvYkc5bmFXNVFjbTlqVkdsdFpYSXBJSHNnWTJ4bFlYSlVhVzFsYjNWMEtHeHZaMmx1VUhKdlkxUnBiV1Z5S1RzZ2JHOW5hVzVRY205alZHbHRaWElnUFNCdWRXeHNPeUI5Q2lBZ2FXWWdLQ0ZzYjJkcGJsQnliMk1wSUhKbGRIVnlianNLSUNCamIyNXpkQ0J3SUQwZ2JHOW5hVzVRY205ak93b2dJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdDaUFnZEhKNUlIc0tJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJSE53WVhkdVUzbHVZeWduZEdGemEydHBiR3duTENCYkp5OVFTVVFuTENCVGRISnBibWNvY0M1d2FXUXBMQ0FuTDFRbkxDQW5MMFluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdDaUFnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0IwY25rZ2V5QndjbTlqWlhOekxtdHBiR3dvTFhBdWNHbGtMQ0FuVTBsSFZFVlNUU2NwT3lCOUlHTmhkR05vSUNoZlpUSXBJSHNnY0M1cmFXeHNLQ2s3SUgwS0lDQWdJSDBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRcDlDZ292THlEdGhMUWc2NCtFN0tTUklPMkJ0T3Vobk91VG5DRHRsSVRyb1p6c2hManNpcVRxc0lBZzdLTzk3SmVJN0oyRUlPdVZqT3lkbUNEc2k2VHRqS2dnNjZtVTdJdWM3S2VBSU9LQWxDQnlkVzVVZFhKdTdKMjBJT3lkdENEcnFaVHNpNXpzcDREc25id2c2NVdNNjZlTUlESHRtb3dnN0o2UTY0K1pJT3llck95TG5PdVBoTzJWbk91THBBcGpiMjV6ZENCVFJWTlRTVTlPWDBSSlJVUWdQU0FuN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkdENEc29vWHJvNHpya0pEc2xyVHNtcFF1SnpzS2JHVjBJSE5vZFhSMGFXNW5SRzkzYmlBOUlHWmhiSE5sT3lBdkx5QXZjMmgxZEdSdmQyNGc3S2VFN1phSklPeWtrU0RpZ0pRZzdKNnM3SXVjNjQrRTY2R2NJT3lFdU95Rm1PeWRoQ0Rya0pqc2dyVHJwcXpzcDRBZzdKV0s2cktNSU8yUm5PeUxuQW9LTHk4Z2NtVmhjMjl1N0oyRUlPeWp2T3VwdENBbjdKMlk2NCtFN0tDQklPeWloZXVqakNjbzZyT0U3S0NWSU95Z2hPMlptTUszNjZHYzZyZTQ3SldFN0p1RElPdVRzU2tnNG9DVUlPeW5oTzJXaVNEc3BKSHNuYlRyalpnZzdZUzA3SjJFSU9xM3VDRHJxWlRzaTV6c3A0RHJvWndnNjRHZDY0SzA3SVNjQ2k4dklISjFibFIxY203c25aZ2dVMFZUVTBsUFRsOUVTVVZFSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRxc0lBZzdKaWJJT3lla09xeXFleW1uZXVxaGV5Y3ZPdWhuQ0RzaExqc2haanNuWVFnNjVDWTdJSzA2NmFzN0tlQUlPeVZpdXF5akNEdGxaenJpNlF1Q2k4dklDanNsWWdnNnJlNDY1K3M2Nm0wSU9xemhPeWdsU0Rzb0lUdG1aZ2c3S2VCN1p1RUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMjBJT3UyZ08yWm5PMlZ0Q0JOUVZoZlZGVlNUbFBxdVl6c3A0QWc2ck9FN0lhTklPeVRzT3lkdE91S2xDRHJzb1RxdDdnZzRvQ1VJREl3TWpZdE1EY2c2NmFzNjdldzdKZVE3SVNjSU8yWmxleWR1Q2tLWm5WdVkzUnBiMjRnYTJsc2JGQnliMk1vY21WaGMyOXVLU0I3Q2lBZ2FXWWdLSEJ5YjJNcElIc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUNBZ0x5OGdjMmhsYkd3NmRISjFaZXVobkNEcm5ZVHNtNHpzaEp3Z2NISnZZK3lkZ0NCamJXUWc2cnVONjQydzZyaXdJT0tBbENBdlZPdWhuQ0R0aXJqcnBxenNwN2dnN0tPOTdKZXM3Slc4SU95bmhPeW5uQ0JqYkdGMVpHWHFzSUFnNnJPZzdKV0U2NkdjSU95VmlDRHJncWpyaXBUcmk2UUtJQ0FnSUNBZ0lDQXZMeUFvNnJPZzdKV0VJR05zWVhWa1plcXdnQ0RzaEtUc3VaZ2c3WXlNN0oyODdKMkVJT3Vzdk9xem9DRHNub2pzbkx6cnFiUWc3WUcwNjZHYzY1T2NJT3lWc1NEc2w0WHJqYkRzbmJUdGlyanFzSUFnSXV5Q3JPeWFxU0RzcEpFaTdKeTg2NkdjSU91bmllMmVtQ2tLSUNBZ0lDQWdJQ0J6Y0dGM2JsTjVibU1vSjNSaGMydHJhV3hzSnl3Z1d5Y3ZVRWxFSnl3Z1UzUnlhVzVuS0hCeWIyTXVjR2xrS1N3Z0p5OVVKeXdnSnk5R0oxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3dvZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJQzh2SUcxaFkwOVRMK3Vtck91SWhleUtwRG9nYzJobGJHdzZkSEoxWmV1ZHZDQndjbTlqN0oyMElITm9JT3E3amV1TnNPcTRzT3lkdkNEc2lKZ2c3SjZJN0oyTUlPS0FsQ0J6ZEdGeWRGQnliMlBzblpnZ1pHVjBZV05vWldUcm9ad2c2NmVNNjVPZ0NpQWdJQ0FnSUNBZ0x5OGc3WlNFNjZHYzdJUzQ3SXFrSU9xM3VPdWp1U2d0Y0dsa0tleWRoQ0R0aHJYc3A3anJvWndnN0tDVjY2YXM3WldjNjR1a0lDaDBZWE5yYTJsc2JDQXZWQ0RyaklEc25aRXBDaUFnSUNBZ0lDQWdkSEo1SUhzZ2NISnZZMlZ6Y3k1cmFXeHNLQzF3Y205akxuQnBaQ3dnSjFOSlIxUkZVazBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3SUhCeWIyTXVhMmxzYkNncE95QjlDaUFnSUNBZ0lIMEtJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91c3RPeUxuQ0FxTHlCOUNpQWdmUW9nSUhCeWIyTWdQU0J1ZFd4c093b2dJSGRoY20xbFpGVndJRDBnWm1Gc2MyVTdDaUFnYVdZZ0tIZGhhWFJsY2lrZ2V5QmpiR1ZoY2xScGJXVnZkWFFvZDJGcGRHVnlMblJwYldWeUtUc2dkMkZwZEdWeUxuSmxhbVZqZENodVpYY2dSWEp5YjNJb2NtVmhjMjl1SUh4OElGTkZVMU5KVDA1ZlJFbEZSQ2twT3lCM1lXbDBaWElnUFNCdWRXeHNPeUI5Q24wS0NtWjFibU4wYVc5dUlITjBZWEowVUhKdll5Z3BJSHNLSUNCcmFXeHNVSEp2WXlncE93b2dJR3hwYm1WQ2RXWWdQU0FuSnpzS0lDQjBkWEp1Y3lBOUlEQTdDaUFnTHk4ZzdKMjBJT3lFdU95Rm1PeWR0Q0RzbHJUcmlwQWc2ck9FN0tDVjdKMllJT3llaGV5ZXBlcTJqT3ljdk91aG5DRHJqNFRyaXBUc3A0QWc2cml3NjZHZElPS0FsQ0Ryc0pic2w1RHNoSndnNnJPRTdLQ1Y3SjIwSU91d2xPdUFqT3lYaU91S2xPeW5nQ0RydVlUcXRaRHRsWmpyaXBRZzZyaXc3S1NBQ2lBZ2MyVnpjMmx2YmtGalkyOTFiblFnUFNCamJHRjFaR1ZCWTJOdmRXNTBLQ2s3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c3SXVjNjQrWklPeWtrZUtBcGlBbzY2cW82NDI0T2lBbklDc2dZM1Z5Y21WdWRFMXZaR1ZzSUNzZ0p5a25LVHNLSUNCamIyNXpkQ0IwYUdselVISnZZeUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSnkxd0p5d2dKeTB0Ylc5a1pXd25MQ0JqZFhKeVpXNTBUVzlrWld3c0lDY3RMV2x1Y0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzSUNjdExXOTFkSEIxZEMxbWIzSnRZWFFuTENBbmMzUnlaV0Z0TFdwemIyNG5MQ0FuTFMxMlpYSmliM05sSjEwc0lIc0tJQ0FnSUhOb1pXeHNPaUIwY25WbExDQmpkMlE2SUVWTlVGUlpYME5YUkN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTEFvZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzSUM4dklGQlBVMGxZT2lEc25wRHF1TEFnN1pTRTY2R2M3SVM0N0lxa0lPcTN1T3VqdVNEc2c1M3NoTEVnNG9DVUlHdHBiR3hRY205ajdKMjBJT3EzdU91anVleW51Q0Rzb0pYcnBxenRsYUFnN0lpWUlPeWVpT3F5akFvZ0lIMHBPd29nSUhCeWIyTWdQU0IwYUdselVISnZZenNLSUNCd2NtOWpMbk4wWkc5MWRDNXZiaWduWkdGMFlTY3NJQ2hrS1NBOVBpQjdDaUFnSUNCc2FXNWxRblZtSUNzOUlHUXVkRzlUZEhKcGJtY29KM1YwWmpnbktUc0tJQ0FnSUd4bGRDQnBaSGc3Q2lBZ0lDQjNhR2xzWlNBb0tHbGtlQ0E5SUd4cGJtVkNkV1l1YVc1a1pYaFBaaWduWEc0bktTa2dJVDA5SUMweEtTQjdDaUFnSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0JzYVc1bFFuVm1Mbk5zYVdObEtEQXNJR2xrZUNrdWRISnBiU2dwT3dvZ0lDQWdJQ0JzYVc1bFFuVm1JRDBnYkdsdVpVSjFaaTV6YkdsalpTaHBaSGdnS3lBeEtUc0tJQ0FnSUNBZ2FXWWdLQ0ZzYVc1bEtTQmpiMjUwYVc1MVpUc0tJQ0FnSUNBZ2JHVjBJR1YySUQwZ2JuVnNiRHNLSUNBZ0lDQWdkSEo1SUhzZ1pYWWdQU0JLVTA5T0xuQmhjbk5sS0d4cGJtVXBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QmpiMjUwYVc1MVpUc2dmUW9nSUNBZ0lDQnBaaUFvWlhZZ0ppWWdaWFl1ZEhsd1pTQTlQVDBnSjNKbGMzVnNkQ2NnSmlZZ2QyRnBkR1Z5S1NCN0NpQWdJQ0FnSUNBZ1kyOXVjM1FnZHlBOUlIZGhhWFJsY2pzS0lDQWdJQ0FnSUNCM1lXbDBaWElnUFNCdWRXeHNPd29nSUNBZ0lDQWdJR05zWldGeVZHbHRaVzkxZENoM0xuUnBiV1Z5S1RzS0lDQWdJQ0FnSUNCcFppQW9aWFl1YVhOZlpYSnliM0lwSUhzS0lDQWdJQ0FnSUNBZ0lHTnZibk4wSUhKaGR5QTlJRk4wY21sdVp5aGxkaTV5WlhOMWJIUWdmSHdnWlhZdWMzVmlkSGx3WlNCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTWpBd0tUc0tJQ0FnSUNBZ0lDQWdJQzh2SU8yVm5PdVBoQ0RzdElqcXM3enJwYndnNjZpODdLQ0FJT3V6dU91THBDRGlnSlFnNjZHYzZyZTQ3SjI0SU95WXBPdWxtQ0Rzb0pYcXQ1enNpNTNzbmJRZzY0U1Q3SmEwN0lTY0tHeHZaeUEvYVc0ZzY1T3hLU0RyckxqcXRhenFzSUFnNjdDVTY0Q002Nm0wSU95Q3ZPMkNyQ0RzaUpnZzdKNkk2NHVrQ2lBZ0lDQWdJQ0FnSUNCcFppQW9hWE5NYVcxcGRFVnljbTl5S0hKaGR5a3BJSHNLSUNBZ0lDQWdJQ0FnSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnSjJOc1lYVmtaUzFzYVcxcGRDYzdJQzh2SUM5b1pXRnNkR2pyb1p3ZzdKV002NmE4SU9LR2tpRHJzb1R0aXJ6c25iUWdXKzJWbk91UGhDRHN0SWpxczd4ZDY2R2NJT3V3bE91QWpPcXpvQ0RxczRUc29KVWc3S0NFN1ptWTdKMkVJT3lWaU91Q3RBb2dJQ0FnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFFnN0xTSTZyTzhJT3F3a095bmdEb25MQ0J5WVhjcE93b2dJQ0FnSUNBZ0lDQWdJQ0IzTG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvVEVsTlNWUmZSMVZKUkVVcEtUc0tJQ0FnSUNBZ0lDQWdJSDBnWld4elpTQnBaaUFvYVhOQmRYUm9SWEp5YjNJb2NtRjNLU2tnZXdvZ0lDQWdJQ0FnSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNBblkyeGhkV1JsTFd4dloyOTFkQ2M3SUM4dklDOW9aV0ZzZEdqcm9ad2c3WlNNNjUrczZyZTQ3SjI0N0plUUlPeVZqT3VtdkNEaWhwSWc2N0tFN1lxODdKMjBJRnZyb1p6cXQ3anNuYmdnN1pXRTdKcVVYZXVobkNEcnNKVHJnSndLSUNBZ0lDQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdEb25MQ0J5WVhjcE93b2dJQ0FnSUNBZ0lDQWdJQ0IzTG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvVEU5SFNVNWZSMVZKUkVVcEtUc0tJQ0FnSUNBZ0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lDQWdJQ0FnSUhjdWNtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdZRzA2NkdjNjVPY0lPeVlwT3VsbURvZ0p5QXJJSEpoZHlrcE93b2dJQ0FnSUNBZ0lDQWdmUW9nSUNBZ0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lDQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW5iMnNuT3lBdkx5RHNoTEhxczdVZ1BTRHNoS1RzdVpqQ3QrdWhuT3EzdU95ZHVDRHJpNlFnN0tDVjdJT0JJT0tBbENEc2xyVHJscVFnY0hKdllteGxiZXlkdE91VG9DRHRsYlRzb0p3Z0tPeWVyT3Vobk9xM3VPeWR1Qy9zbnF6c2hLVHN1WmdnNjdPMTZyZUFLUW9nSUNBZ0lDQWdJQ0FnZHk1eVpYTnZiSFpsS0ZOMGNtbHVaeWhsZGk1eVpYTjFiSFFnZkh3Z0p5Y3BLVHNLSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJSDBLSUNBZ0lIMEtJQ0I5S1RzS0lDQndjbTlqTG5OMFpHVnljaTV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCeklEMGdaQzUwYjFOMGNtbHVaeWduZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUdsbUlDaHpJQ1ltSUNGekxtbHVZMngxWkdWektDZEVaWEJ5WldOaGRHbHZibGRoY201cGJtY25LU2tnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElHTnNZWFZrWlNCemRHUmxjbkk2Snl3Z2N5NXpiR2xqWlNnd0xDQXlNREFwS1RzS0lDQjlLVHNLSUNCd2NtOWpMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0F2THlEc25iVHJyN2dnN0lPSUlPeUV1T3lGbU95Y3ZPdWhuQ0RxdFpEc3NyVHJrSndnNjVLa0lPeVlteURzaExqc2haanNuYlFnNjR1cjdaNk1JT3F4c091cHRDRHJyTFRzaTV3Z0tPdXFxT3VOdUNEc29JVHRtWmdnN0l1Y0lPeURpQ0RzaExqc2haanNuWVFnN0tPOTdKMjA3S2VBSU95Vml1cXlqQ2tLSUNBZ0lHbG1JQ2h3Y205aklDRTlQU0IwYUdselVISnZZeWtnY21WMGRYSnVPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c3S0tGNjZPTUlDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a2c0b0NVSU91THBPeWRqQ0RzbXBUc3NxMGc2NVdNSU91THBPeUxuQ0RzaTV6cmo1bnRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUgwcE93cDlDZ3BtZFc1amRHbHZiaUJ6Wlc1a1ZIVnliaWgwWlhoMEtTQjdDaUFnY21WMGRYSnVJRzVsZHlCUWNtOXRhWE5sS0NoeVpYTnZiSFpsTENCeVpXcGxZM1FwSUQwK0lIc0tJQ0FnSUdsbUlDZ2hjSEp2WXlrZ2NtVjBkWEp1SUhKbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSisyQnRPdWhuT3VUbkNEc2hManNoWmpzbmJRZzdKZUc3SmEwN0pxVUxpY3BLVHNLSUNBZ0lHbG1JQ2gzWVdsMFpYSXBJSEpsZEhWeWJpQnlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnNsWjdzaEtBZzdKcVU3TEt0N0oyMElPeW5oTzJXaVNEc3BKSHNuYlRzbDVEc21wUXVKeWtwT3dvZ0lDQWdZMjl1YzNRZ2RHbHRaWElnUFNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkV0Q0RzaTV6cXNJUWc3TFNJNnJPOElPS0FsQ0RzaExqc2haanNuWVFnN0o2czdJdWM3SjZSN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnSUNBdkx5RHNpNXpxc0lRZzdMU0k2ck84NjRxVUlDZnNoTGpzaFpnZzdLS0Y2Nk9NSit5WmdDRHF0YXpydG9UcmtKanJpcFFnN0tDY0lPdXBsT3lMbk95bmdPdWhuQ0RyZ1ozcmdyanJpNlFnNG9DVUlHdHBiR3hRY205ajdKMllJT3lFdU95Rm1DRHNvb1hybzR3Z2NtVnFaV04wNnJDQUNpQWdJQ0FnSUM4dklISjFibFIxY203c25aZ2c3SjZRNjQrWklPeWVyT3lMbk91UGhPdWx2Q0RydG9EcnBiVHJxYlFnN0pXSUlPdVFtT3E0c0NEcmxZenJyTGdvNjRxUTY2YXdJTzJFdE95ZGhDRHJrWkFnNjdLSUlPdVBqT3VwdENEdGxJenJuNnpxdDdqc25iZ2dNVE13N0xTSUlPeWduTzJWbk95ZGhDRHJoSmpxdUxUcmk2UXBDaUFnSUNBZ0lHbG1JQ2gzWVdsMFpYSXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emRDQjNJRDBnZDJGcGRHVnlPeUIzWVdsMFpYSWdQU0J1ZFd4c093b2dJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243WUcwNjZHYzY1T2NJT3lka2V1THRleWR0Q0RyaElqcnJMUWc3SmlrNjU2WUlPcXh1T3VncENEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5LU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdhMmxzYkZCeWIyTW9LVHNLSUNBZ0lIMHNJRlJWVWs1ZlZFbE5SVTlWVkY5TlV5azdDaUFnSUNCM1lXbDBaWElnUFNCN0lISmxjMjlzZG1Vc0lISmxhbVZqZEN3Z2RHbHRaWElnZlRzS0lDQWdJSEJ5YjJNdWMzUmthVzR1ZDNKcGRHVW9TbE5QVGk1emRISnBibWRwWm5rb2V5QjBlWEJsT2lBbmRYTmxjaWNzSUcxbGMzTmhaMlU2SUhzZ2NtOXNaVG9nSjNWelpYSW5MQ0JqYjI1MFpXNTBPaUIwWlhoMElIMGdmU2tnS3lBblhHNG5MQ0FuZFhSbU9DY3BPd29nSUgwcE93cDlDZ292THlEcXNKbnNuWUFnNjZ5NDZyV3M2Nlc4SU91cWh5RHJzb2pzcDdnZzY2eTc2NHFVN0tlQUlPcTRzT3lXdFNEaWdKUWc3SjZzN0pxVTdMS3Q3SjIwNjZtMElDTHNuYlRzb0lUcXM3d2c2NHVrNjZXNElPeURpQ0Rzb0p6c2xZZ2k3SjJFSU95YWxPcTFyTzJWbk91THBBb3ZMeUFvN0pXSUlPcTN1T3Vmck91cHRDRHRnYlRyb1p6cms1enFzSUFnN0lTeDdJdWs3WldZNnJLTUlPcXdtZXlkZ0NEcmk3WHNuWVFnNjVpUUlPdUN0T3lFbkNCYlFVa2c3TGFVN0xLY0lPdU5sQ0Ryc0p2cXVMQmQ2ckNBSU91c3RPeWRtT3V2dU8yVnRPeW5oT3VMcENrS1kyOXVjM1FnWVhOclpXUkRiM1Z1ZENBOUlHNWxkeUJOWVhBb0tUc0tDaTh2SU95RXVPeUZtQ0RzcElEcnVZUW83SXVjNjQrWksreW5nT3lMbk91c3VDRHNvN3pzbm9VcDY2VzhJT3V6dE95ZXBlMlZuQ0Rya3FRZzdaV2NJTzJFdENEc2k2VHRsb2tnNG9DVUlPdXFxT3VUb0NEdG1ManN0cHpzbllBZ2NYVmxkV1hyb1p3ZzdLZUI2NkNzN1ptVUxnb3ZMeUJ0YjJSbGJPeWRoQ0Rzbzd6cnFiUWc2cmU0SU91cXFPdU51T3VobkNBbzY0dWs2NlcwNjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFcExpRHRsWndnNjZxbzY0MjQ3SjJFSU9xemhPeUdqU0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3SjJBSU95MW5PeTBpQ0F4N1pxTTY3K1FMZ292THlCeVpYQmhjbk5sUFh0d1lYSnpaU3dnWm05eWJXRjBSR1Z6WTMzcnBid2c3S084NjZtMElPMk1qT3lMc2VxNWpPeW5nQ0RzbmJRZzdKNmhJT3lWaU95WGtPeUVuQ0Rzc3BqcnBxenRsWmpxczZBZ2UzSmhkeXdnY0dGeWMyVmtmZXVsdkNEcmo0enJvS1RzcElEcmk2UTZDaTh2SU8yWWxleUxuU0RzbmJUdGc0Z2c3SXVjSU9xd21leWRnQ0RzaExqc2haanNsNUFnSXUyWWxleUxuZXVNZ091aG5DRHJpNlRzaTV3aTY2VzhJT3lhbE9xMXJPMlZtT3VLbENEc25xenNtcFRzc3EwZzdZUzA3SjJFSUNvcTZyQ1o3SjJBSU8yQmtDRHNucUVnN0pXSTdKZVE3SVNjS2lvZzY3YVo3SjI0NjR1a0xnb3ZMeURyczRUcmo0UWc3SjZoN0p5ODY2R2NJT3U1dk91cHRDQW9ZU2tnN0lLczdKMjA3SmVRSU91THBPdWx1Q0RzbXBUc3NxMGc3WVMwN0oyMElPdUJ2T3lXdENBbjY3Q3A2cmlJSU91THRTZnNuYlFnNjRLbzdKMllJT3VMdGV5ZHRDRHJrSmpxczZBbzY0SzA3SnFwSU95WXBPeVh2Q2tzQ2k4dklDaGlLU0JOUVZoZlZGVlNUbE1nNnJLOTZyT0U3SmVRN0lTY0lPeUV1T3lGbU95ZHRDRHNucXpzaTV6c25wSHJqN3dnSit1d3FlcTRpQ0RyaTdVbjdKMjBJT3lYaHV1S2xDRHNnNGdnN0lTNDdJV1k3SjIwSU91Q3RPeWFxZXlkaENEc3A0RHNsclRyZ3J3ZzdJaVlJT3llaU91THBDQW9NakF5Tmkwd055RHJwcXpydDdEc2w1RHNoSndnN1ptVjdKMjRLUzRLWTI5dWMzUWdVa1ZRUVZKVFJWOUNRVVFnUFNBb2Rpa2dQVDRnZGlBOVBTQnVkV3hzSUh4OElDaEJjbkpoZVM1cGMwRnljbUY1S0hZcElDWW1JSFl1YkdWdVozUm9JRDA5UFNBd0tUc0tablZ1WTNScGIyNGdjblZ1VkhWeWJpaGlkV2xzWkVGemF5d2diVzlrWld3c0lISmxjR0Z5YzJVcElIc0tJQ0JqYjI1emRDQnFiMklnUFNCeGRXVjFaUzUwYUdWdUtHRnplVzVqSUNncElEMCtJSHNLSUNBZ0lHTnZibk4wSUdwdllsTjBZWEowSUQwZ1JHRjBaUzV1YjNjb0tUc2dMeThnN0l1YzZyQ0VJT3lZaU95Q3NDRGlnSlFnN1pTTTY1K3M2cmU0N0oyNElPeXF2U0Rzb0p6dGxad29NVE13N0xTSUtleWRoQ0RyaEpqcXVMZ2c3SjZzN0l1YzY0K0U2NHFVSU8yUHJPcTRzTzJWbk91THBBb2dJQ0FnYVdZZ0tHMXZaR1ZzSUNZbUlFRk1URTlYUlVSZlRVOUVSVXhUTG1sdVpHVjRUMllvYlc5a1pXd3BJQ0U5UFNBdE1TQW1KaUJ0YjJSbGJDQWhQVDBnWTNWeWNtVnVkRTF2WkdWc0tTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RycXFqcmpiZ2c2N09BNnJLOU9pQW5JQ3NnWTNWeWNtVnVkRTF2WkdWc0lDc2dKeURpaHBJZ0p5QXJJRzF2WkdWc0tUc0tJQ0FnSUNBZ1kzVnljbVZ1ZEUxdlpHVnNJRDBnYlc5a1pXdzdDaUFnSUNBZ0lITjBZWEowVUhKdll5Z3BPeUF2THlEc2c0Z2c2NnFvNjQyNDY2R2NJT3lFdU95Rm1DRHNucXpzaTV6c25wRWdLT3VMcE95ZGpDRHNtNHpyc0kzc2w0WHNsNURzaEp3ZzdLZUE3SXVjNjZ5NElPeWVyT3lqdk95ZWhTa0tJQ0FnSUgwS0lDQWdJR2xtSUNoMGRYSnVjeUErUFNCTlFWaGZWRlZTVGxNZ2ZId2dJWEJ5YjJNcElITjBZWEowVUhKdll5Z3BPd29nSUNBZ2FXWWdLQ0YzWVhKdFpXUlZjQ2tnZXdvZ0lDQWdJQ0JqYjI1emRDQjBNQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0FnSUdGM1lXbDBJSE5sYm1SVWRYSnVLR2x1YzNSeWRXTjBhVzl1VFdWemMyRm5aU2dwS1RzS0lDQWdJQ0FnZDJGeWJXVmtWWEFnUFNCMGNuVmxPd29nSUNBZ0lDQjBkWEp1Y3lzck93b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SVM0N0lXWUlPeWtnT3U1aENEc21ZVHJvNHdnS0NjZ0t5QW9LRVJoZEdVdWJtOTNLQ2tnTFNCME1Da2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBJQ3NnSjNNcElPS0FsQ0RzbmJUdG00UWc3SnFVN0xLdDdKMkFJT3U1cU91ZHZPeWFsQzRuS1RzS0lDQWdJSDBLSUNBZ0lIUjFjbTV6S3lzN0NpQWdJQ0JqYjI1emRDQmhjMnNnUFNCaWRXbHNaRUZ6YXlncE95QXZMeURzbnF6c2k1enJqNFFnNjVXTUlPcXdtZXlkZ0NEc3A0anJyTGpzbllRZzY0dWs3SXVjSU95VHRPdUxwQ0FvWVhOclpXUkRiM1Z1ZENEc25iVHNwSkVnN0thZDZyQ0FJT3V3cWV5bmdDa0tJQ0FnSUd4bGRDQnlZWGM3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0J5WVhjZ1BTQmhkMkZwZENCelpXNWtWSFZ5YmloaGMyc3BPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQXZMeUR0aExRZzY0K0U3S1NSSU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxVHFzSUFnN0tPOTdKMkFJT3F5dmV5YXNDaFRSVk5UU1U5T1gwUkpSVVFwSURIdG1vd2c3SjZRNjQrWklPeWVyT3lMbk91UGhDRGlnSlFnN0lLczdKcXA3SjZRN0plUTZyS1FJT3lMcE8yTXFPdWhuQ0RzbFlnZzY3TzA3SjIwNnJLTUxnb2dJQ0FnSUNBdkx5RHNpNXpxc0lRZzdMU0k2ck84d3Jmcm9aenF0N2pzbmJnZzY2ZU02Nk9Nd3JmdGdiVHJvWnpyazV3ZzdKaWs2NldZd3Jmc25aanJqNFRzb0lFZzdLS0Y2Nk9NS09xemhPeWdsU0Rzb0lUdG1aZ3Y2NkdjNnJlNDdKV0U3SnVETENCcmFXeHNVSEp2WXloeVpXRnpiMjRwS2V1S2xBb2dJQ0FnSUNBdkx5RHNvSndnNjZtVTdJdWM3S2VBNnJDQUlPdVVzT3VobkNEc25vanNsclFnN0plczZyaXdJT3lWaUNEcXNianJwckRyaTZRdUlPeWloZXVqakNEc21wVHNzcTBnN0tTUjdKMjA2ckd3NjRLWUlPeUxuT3F3aENEc21JanNnckRzbmJRZzdKYTg2NmVJSU95VmlDRHJncWpzbFpqc25MenJxYlFnNjVDWTdJSzA2NmFzN0tlQUlPeVZpdXVLbE91THBDNEtJQ0FnSUNBZ2FXWWdLSE5vZFhSMGFXNW5SRzkzYmlCOGZDQWhLR1VnSmlZZ1pTNXRaWE56WVdkbElEMDlQU0JUUlZOVFNVOU9YMFJKUlVRcElIeDhJRVJoZEdVdWJtOTNLQ2tnTFNCcWIySlRkR0Z5ZENBK0lEUXdNREF3S1NCMGFISnZkeUJsT3dvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdJUzQ3SVdZN0oyMElPMkV0Q0RyajRUc3BKRWc2NEdLNnJtQUlPS0FsQ0RzbnF6c2k1enJqNWtnN1p1RUlESHRtb3dnN0o2czdJdWM2NCtFN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnSUNCemRHRnlkRkJ5YjJNb0tUc0tJQ0FnSUNBZ1lYZGhhWFFnYzJWdVpGUjFjbTRvYVc1emRISjFZM1JwYjI1TlpYTnpZV2RsS0NrcE93b2dJQ0FnSUNCM1lYSnRaV1JWY0NBOUlIUnlkV1U3Q2lBZ0lDQWdJSFIxY201eklEMGdNanNnTHk4ZzdKdU02N0NON0plRklERWdLeURzbmJUcnNvZ2c3WVMwSUNoemRHRnlkRkJ5YjJQc25iUWdNT3ljdk91aG5DRHN0SWpxdUxEdG1aUXBDaUFnSUNBZ0lISmhkeUE5SUdGM1lXbDBJSE5sYm1SVWRYSnVLR0Z6YXlrN0NpQWdJQ0I5Q2lBZ0lDQnBaaUFvSVhKbGNHRnljMlVwSUhKbGRIVnliaUJ5WVhjN0NpQWdJQ0JzWlhRZ2NHRnljMlZrSUQwZ2NtVndZWEp6WlM1d1lYSnpaU2h5WVhjcE93b2dJQ0FnTHk4ZzdaaVY3SXVkSU95ZHRPMkRpT3lkdE91cHRDRHFzSm5zbllBZzdJUzQ3SVdZd3JmcXNKbnNuWUFnN0o2aDdKZVE3SVNjSU9xenAreWVwU0RzbnF6c21wVHNzcTBnNG9DVUlPeWR0Q0R0aExUc25iUWc3S085N0p5ODY2bTBJT3lEaUNEc2hManNoWmpzbllBZ0ordXdxZXE0aUNEcmk3VW43SjJFSU91cXNPdWR2QW9nSUNBZ0x5OGc3S2VBN0phMDY0SzhJT3lJbUNEc25vanNuTHpycjREcm9ad2c3SVM0N0lXWUlPeUNyT3VublNEc25xenNpNXpyajRUcmlwUWc3WldZN0tlQUlPeVZpdXF6b0NEcXQ3anJqSURyb1p3ZzdJdWs3WXlvN0l1YzdZS282NHVrS08yTWpPeUxzU0RzaTZUdGpLanJvWndnNnJlQTZyS3dLUzRLSUNBZ0lHbG1JQ2hTUlZCQlVsTkZYMEpCUkNod1lYSnpaV1FwSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JxYjJKVGRHRnlkQ0E4SURjd01EQXdLU0I3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpJenNpN0VnN0l1azdZeW9JT0tBbENEdG1KWHNpNTBnN0o2czdKcVU3TEt0T2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJRE13TUNrcE93b2dJQ0FnSUNCMGRYSnVjeXNyT3dvZ0lDQWdJQ0IwY25rZ2V3b2dJQ0FnSUNBZ0lISmhkeUE5SUdGM1lXbDBJSE5sYm1SVWRYSnVLQ2Zyc0tucXVJZ2c2NHUxN0oyMElPeWFsT3Exck8yVm5DRHRtSlhzaTUzc2w1QWc3SmEwNnJpTDY0S3M2NHVrTGlEcnNLbnF1SWdnNjR1MTdaV2NJT3VDdE95YXFleWRoQ0RzaEtUcnFvWEN0K3lDck9xenZNSzM3TDJVNjVPYzdZNmM3SXFrSU95WGh1eWR0Q0RzbFlUcm5wZ2dTbE5QVHV5Y3ZPdWhuT3VuakNEcmk2VHNpNXdnN0xhYzY2Q2w3WldZNjUyOE9pQW5JQ3NnY21Wd1lYSnpaUzVtYjNKdFlYUkVaWE5qS1RzS0lDQWdJQ0FnSUNCd1lYSnpaV1FnUFNCeVpYQmhjbk5sTG5CaGNuTmxLSEpoZHlrN0NpQWdJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95ZXJPeWFsT3l5clNEc2k2VHRqS2dnNG9DVUlPeVZoT3VlbU95WGtPeUVuQ0R0akl6c2k3RWc3SXVrN1l5bzY2R2NJT3l5bU91bXJDQXFMeUI5Q2lBZ0lDQjlDaUFnSUNCcFppQW9Va1ZRUVZKVFJWOUNRVVFvY0dGeWMyVmtLU2tnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1qT3lMc1NEc2k2VHRqS2dnS095ZXJPeWFsT3l5clNEdG00VHNsNURyajRRcE9pY3NJRk4wY21sdVp5aHlZWGNwTG5Oc2FXTmxLREFzSURNd01Da3BPd29nSUNBZ2NtVjBkWEp1SUhzZ2NtRjNMQ0J3WVhKelpXUTZJRkpGVUVGU1UwVmZRa0ZFS0hCaGNuTmxaQ2tnUHlCdWRXeHNJRG9nY0dGeWMyVmtJSDA3Q2lBZ2ZTazdDaUFnTHk4ZzdaV2NJT3lhbE95eXJleWR0Q0RzaTZUdGpLanRsYlRyajRRZzY0dWs3SjJNSU95YWxPeXlyZXlkdENEc25iVHNsclRzcDREcmo0VHJvWjBnN1lHUTY0cVVJTzJWcmV5RGdTRHNoTEhxczdYc25MenJvWndnN0tDVjY2YXNDaUFnY1hWbGRXVWdQU0JxYjJJdVkyRjBZMmdvS0NrZ1BUNGdlMzBwT3dvZ0lISmxkSFZ5YmlCcWIySTdDbjBLQ2k4dklPdXloTzJLdkNEcm5ienJzcWdnNnJlYzdMbVpJT0tBbENEdGxJenJuNnpxdDdqc25ianNuYlFnSit1eWhPMkt2T3lkaENEcXM2anJucERyaTZRbjZyT2dJT3lWak91Z3BPeWtoQ0RybFl6cnA0d2c3SmE1NjRxVTY0dWtMZ292THlEcnNvVHRpcndnNjZ5NDZyV3M2NHFVSU91c3VPeWVwZXlkdENEc2xZVHJpNGpybmJ3ZzY0K1o3SjZSSU95ZHRPdW1oT3lkdE95V3RPeUVuQ3dnN0oyMElPeW5nT3lMbk9xd2dDRHNsNGJzbkx6cnFiUWc2Nnk0N0o2bDdaaVZJT3VNZ095VmlPeWR0Q0RzaEo3c2w2d2c2NEtZN0ppbzY0dWtMZ3BqYjI1emRDQkNWVlJVVDA1ZlVsVk1SU0E5Q2lBZ0oreWR0Q0RyckxqcXRhenJpcFFnS2lycnNvVHRpcndnNjUyODY3S29LaXJzbmJUcmk2UXVJT3VzdU95ZXBleWR0Q0RzbFlUcmk0anJuYndnNjQrWjdKNlJJT3lkdE91bWhPeWR0T3V2Z091aG5Eb2c2NmVJN0xtbzdaR2N3cmZyckx6c25ZenRrWnpDdCt5aWhlcXlzT3lXdE91dnVDaCs3SnFVTDM3cmk2UXZmdXE1ak95YWxDa2c2cmlJN0tlQUxDQW5JQ3NLSUNBbjY1Q1k2NCtFNjZHZElPeW5wK3lkZ0NEcmo1bnNucEVnNjZxRjdJS3NLT3lnZ095ZXBjSzM3SUt0N0tDY3dyZnNsN0Rxc3JBZzdaVzA3S0NjSU91VHNTbnJvWndzSU8yR3RldXp0T3lFc1NEcmk2anNuYndnNjdLRTdZcTg3SjIwNjZtMElDTHRtWlhzbmJnaUxpQW5JQ3NLSUNBbkl1eTNxT3lHakNMcmlwUWc2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNSU95VHNPcXpvQ3dnN1ptVTY2bTBJT3E0c091S3BldXFoU2pyczREcXNyM0N0KzJWdE95Z25DRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWlRyaTZRdVhHNG5Pd29LTHk4ZzY2eTQ2cldzSU95MmxPeXluQ0R0aExRZ0tISnZiR1U5Sit1eWhPMkt2Q2ZzbmJUcnFiUWc2N0tFN1lxOElPcTNuT3k1bWV5ZGhDRHNscm5yaXBUcmk2UXBDbVoxYm1OMGFXOXVJR0Z6YTBOc1lYVmtaU2gwWlhoMExDQnRiMlJsYkN3Z2NtVndZWEp6WlN3Z2NtOXNaU2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lHTnZibk4wSUdGMGRHVnRjSFFnUFNBb1lYTnJaV1JEYjNWdWRDNW5aWFFvZEdWNGRDa2dmSHdnTUNrZ0t5QXhPd29nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvZEdWNGRDd2dZWFIwWlcxd2RDazdDaUFnSUNCcFppQW9ZWE5yWldSRGIzVnVkQzV6YVhwbElENGdNakF3S1NCaGMydGxaRU52ZFc1MExtTnNaV0Z5S0NrN0lDOHZJT3VzdE8yVm5PMmVpQ0RzakpQc25iVHNwNEFnN0pXSzZyS01DaUFnSUNCamIyNXpkQ0J5ZFd4bElEMGdjbTlzWlNBOVBUMGdKK3V5aE8yS3ZDY2dQeUJDVlZSVVQwNWZVbFZNUlNBNklDY25Pd29nSUNBZ2NtVjBkWEp1SUhKMWJHVWdLeUFvWVhSMFpXMXdkQ0ErSURFS0lDQWdJQ0FnUHlBbjZyQ1o3SjJBSU91c3VPcTFyT3VsdkNEcmk2VHNpNXdnN0pxVTdMS3Q3WldjNjR1a0xpRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3lnaE95WGtDRHNvSnpzbFlqdGxvanJqWmdnNnJLRDY1T2s2ck84SU9xeXVleTVtT3luZ0NEc2xZcnJpcFFzSU9xMXJPeWhzT3VDbUNEc2xyVHRuSmpxc0lBZzdabVY3SXVrN1o2SUlPdUxwT3VsdUNEc2c0anJvWnpzbXJRZzY0eUE3SldJSURQcXNKenJwYndnNnJlYzdMbVo2NHlBNjZHY0lFcFRUMDRnNjdDdzdKZTA2NkdjNjZlTU9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29kR1Y0ZENrS0lDQWdJQ0FnT2lBbjY0dWs3SjJNSUZWSklPdXN1T3Exck95ZG1DRHJqSURzbFlnZ00rcXduT3VsdkNEcXQ1enN1Wm5yaklEcm9ad2dTbE5QVGlEcnNMRHNsN1Ryb1p6cnA0dzZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtTazdDaUFnZlN3Z2JXOWtaV3dzSUhKbGNHRnljMlVwT3dwOUNnb3ZMeURyc29qc2w2MGc3WVMwSU9LQWxDRHFzSm5zbllBZzdJUzQ3SVdZN0oyRUlPeVRzT3VRbUN3ZzdKMjA2N0tJSU8yRXRPdW5qQ0RzdHBUc3Nwd2c3WmlWN0l1ZEtFcFRUMDRnNjdDdzdKZTBLU0RyaklEc2k2QWc2N0tJN0pldElPMllsZXlMblNoS1UwOU9JT3F3bmV5eXRDbnNuWVFnN0pxVTZyV3M3WldjNjR1a0NtWjFibU4wYVc5dUlHRnphMVJ5WVc1emJHRjBaU2gwWlhoMExDQnRiMlJsYkN3Z2NtVndZWEp6WlNrZ2V3b2dJSEpsZEhWeWJpQnlkVzVVZFhKdUtDZ3BJRDArSUNnS0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJT3V5aU95WHJTRHNucEhzbDRYc25iVHJpNlFnS091c3VPcTFyQ0RyaTZUcms2enF1TEFnN0pXRTY0dVlJT0tBbENEcmpJRHNsWWdnTStxd25DRHF0NXpzdVpuc25ZQWc3SjIwNjdLSUlPMkV0T3lYa0NEc29JSHNtcW50bFpqc3A0QWc3SldLNjRxVTY0dWtLUzRnSnlBckNpQWdJQ0FuNjR1azdKMk1JRlZKSU91c3VPcTFyT3F3Z0NEdGxaenF0YTNzbHJUcnFiUWc3SjZRN0pldzdJcWs2NStzN0pxMElPeVlnZXlXdE91aG5Dd2c3SmlCN0phMDY2bTBJT3lla095WHNPeUtwT3Vmck95YXRDRHRsWnpxdGEzc2xyVHJvWndnNjdLSTdKZXQ3WldZNjUyOExpQW5JQ3NLSUNBZ0lDZFZTU0RyckxqcXRhenJpNlRzbXJRZzZyQ0U2ckt3N1pXY0lPMlJuTzJZaE95ZGhDRHNrN0RxczZBc0lPeWR0T3VtaE1LMzdJaXI3SjZRd3JmcnA0anNpcVR0Z3JuQ3QrMlVqT3VnaU95ZHRPeUtwTzJaZ091TmxPdUtsQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzA3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25aZ2c3S1NFSU95SW1PdWx2Q0RxdDdqcmpJRHJvWndnN0p5ZzdLZUE3WldjNjR1a0lPS0FsQ0RzbTVEcnJManNuYlFnN1pXY0lPeWtoT3lkdE91cHRDRHJzb2pzbDYzcmo0UWc3WldjSU95a2hPdWhuQ3dnN0tTRTY3Q1U2citJN0oyRUlPeWVoT3lkbU91aG5DRHN0cFRxc0lEdGxaanNwNEFnN0pXSzY0cVU2NHVrTGlBbklDc0tJQ0FnSUNmcmk3WHNuWUFnNjdDWTY1T2M3SXVjSUVwVFQwNGc2ckNkN0xLMElPMlZtT3VDbU91bmpDRHN0cHpyb0tYdGxaenJpNlF1SU91bmlPMkJyT3VMcE95YXRNSzM3SVNrNjZxRklPcTRpT3luZ0RvZ0p5QXJDaUFnSUNBbmV5SjBjbUZ1YzJ4aGRHVmtJam9nSXV1eWlPeVhyZXVzdUNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWlaR2x5WldOMGFXOXVJam9nSW10djRvYVNaVzRnNjVpUTY0cVVJR1Z1NG9hU2EyOGlmVG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0hSbGVIUXBDaUFnS1N3Z2JXOWtaV3dzSUhKbGNHRnljMlVwT3dwOUNnb3ZMeURyaklEdG1aVHRtSlVnNjZ5NDZyV3NJT3lnbk95ZWtTRHRoTFFnNG9DVUlPeUNyT3lhcWV5ZWtPcXdnQ0RzZzRIdG1hbnNuWVFnN0lTazY2cUY3WldZNjZtMElPdW5wZXVkdmV5WGtDRHJwNTdyaXBRZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RPeWtnT3VMcEM0S0x5OGdiV1Z6YzJGblpYTTZJRnQ3Y205c1pUb25kWE5sY2lkOEoyRnpjMmx6ZEdGdWRDY3NJSFJsZUhSOVhTRHNvSVRzc3JRZzY0eUE3Wm1VNjZXOElPdW5wT3V5aUNEcnNKdnJpcFRyaTZRbzY0dWs2NmFzNjRxVUlPdXN0T3lEZ2UyRG5DRGlnSlFLTHk4ZzdKdU02N0NON0plRklPeW5nT3lMbk91c3VPeWRtQ0FpN0pxVTdMS3Q2NU9rN0oyQUlPeUVuT3VobkNEcnJMVHF0SUFpSU95Z2hPeWduT3VsdkNEc3A0RHRncVRxdUxBZzdKeUU3WlcwSU91TWdPMlpsQ0RycDZYcm5iM3NuWVFnN1lTMElPeVZpT3lYa0NEcnFyM3JsWVVnN0l1ajY0cVU2NHVrS1M0S1puVnVZM1JwYjI0Z1lYTnJRMjl0Y0c5elpTaHRaWE56WVdkbGN5d2diVzlrWld3c0lISmxjR0Z5YzJVcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0NpQWdJQ0JqYjI1emRDQjBjbUZ1YzJOeWFYQjBJRDBnS0cxbGMzTmhaMlZ6SUh4OElGdGRLUzV0WVhBb0tHMHBJRDArQ2lBZ0lDQWdJQ2h0TG5KdmJHVWdQVDA5SUNkaGMzTnBjM1JoYm5RbklEOGdKK3lXdE95TG5PeUtwTzJFdE8yS3VEb2dKeUE2SUNmc2dxenNtcW5zbnBBNklDY3BJQ3NnVTNSeWFXNW5LRzB1ZEdWNGRDQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z01UVXdNQ2tLSUNBZ0lDa3VhbTlwYmlnblhHNG5LVHNLSUNBZ0lISmxkSFZ5YmlBb0NpQWdJQ0FnSUNmc25iVHJzb2dnN0pxVTdMS3Q3SjJBSUNMcmpJRHRtWlR0bUpVZzY2eTQ2cldzSU95Z25PeWVrU0xzbmJUcmk2UWdLT3E0c095aHRDRHJyTGpxdGF3ZzY0dWs2NU9zNnJpd0lPeVZoT3VMbUNEaWdKUWc3SldFNjU2WUlPdU1nTzJabE9xd2dDRHNuYlRyc29nZzdZUzA3SjJZSU95Z2hPeXl0Q0RycDZYcm5iM3NuYlRyaTZRcExpQW5JQ3NLSUNBZ0lDQWdKK3lDck95YXFleWVrT3F3Z0NEdG1aVHJxYlFnN0lPQjdabXB3cmZycDZYcm5iM3NuWVFnN0lTazY2cUY3WldZNjZtMExDRHNpcVR0ZzREc25id2c2cmVjN0xtWjZyTzhJT3lZaU95TG5DRHRocVRzbDVBZzY2ZWU2NHFVSUZWSklPdXN1T3Exck91bHZDRHJwNHpyazZUc2xyUWc3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3VucGV1ZHZleWR0Q0RydG9Ec29iSHRsWmpycWJRZzdZNjQ3WldZNnJLTUlPdVFtT3Vzdk95V3RPdWR2RG9nN0phMDY1YWtJTzJabE91cHRNSzM2cml3NjRxbDdKMllJT3VzdU9xMXJPeWR1T3luZ0N3ZzY1T2s3SmEwNnJDSUlPeWVrT3Vtck91S2xDRHNsclRybEpUc25ianNwNEFvN1l5ZDdKZUZJTzJEZ095ZHRPMkxnQy9yczdqcnJMZ3Y2N0tFN1lxOExDRHRocURzaXFUdGlyZ3NJT3U1aUNEdG1aVHJxYlFnN0pXSTY0SzBMQ0Ryc0xEcmhJZ2c2NU94S1N3ZzdKYTA2NWFrSU95RGdlMlpxZXlkdU95bmdDanNoTEhxczdVZzdZYTE2N08wTCt5WXBPdWxtQy90bVpYc25iZ2c3SnFVN0xLdEwreVZpT3VDdENrZzZyQ1o3SjJBSU9xeWd5NGc2cnl0SU8yVmhPeWFsTzJWbkNEcXNvUHJwNHdnNnJPbzY1MjhJTzJWbkNEcnNvanNsNUFnN0xXYzY0eUFJRExxc0p6cXVZenNwNEFzSU95bnArcXlqQzRnN0oyMDY1V01JSE4xWjJkbGMzUnBiMjV6NjRxVUlPdTVpQ0Ryc0xEc2w3UXVYRzRuSUNzS0lDQWdJQ0FnSnkwZzZyQ1E3SjIwSU95V3RPdUtrQ0Rzb0pYcmo0UWc3SmlrNjZtMElPdXN1K3E0c091bmpDRHRsWmpzcDRBZzY2ZUk2NTI4SU9LQWxDRHFzSURzb0pYc25ZUWc3SVM0N0pxdzZyT2dJT3kwaU95VmlDQnpkV2RuWlhOMGFXOXVjK3VsdkNEdGxhanF1NWdnNjRLMDY2bTA3SVNjTENCeVpYQnNlZXlYa0NEcXNJRHNvSlhzbllRZzY3Q2Q3WjZJNnJPZ0lPdXN0T3lYaCt5ZGhDRHNsWXpyb0tUc283enJxYlFnNjQyVUlPdW5udXkybkNEc2lKZ2c3SjZJNjRxVTdLZUFJTzJWbkNEcnJManNucVhzbkx6cm9ad2c2NDJuNjdhWjdKZXM2NTI4S095WWlEb2dJdTJabGV5ZHVDRHRqSjNzbDRYc25iVHJuYnpxczZBZzZyQ0E3S0NWN1phSTdKYTA3SnFVSU9LQWxDRHRocURzaXFUdGlyanJuYnpycWJRZzdKV002NkNrN0tPODdJUzQ3SnFVSWlrdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnNjZ5NDZyV3M2Nlc4SU95Z25PeVZpTzJWb0NEcmxaQWc3SVNjNjZHY0lPeWdrZXEzdk95ZHRDRHJpNlRycGJnZ01uNHo2ckNjTGlEcXNJRWc3S0NjN0pXSTdKZVVJT3labkNEcXQ3anJvSWZxc293ZzdJMjg2NHFVN0tlQUlPeWR0T3ljb091bHZDRHJ0cG5zbmJqcmk2UXVYRzRuSUNzS0lDQWdJQ0FnSnkwZzdJS3M3SnFwN0o2UTZyQ0FJT3lXdU9xNGllMlZtT3luZ0NEc2xZcnNuWUFnNnJXczdMSzBJT3lnbGV1enRDanNvSVR0bVpUcnNvanRtTGpDdDFWU1RNSzM2cmlJN0pXaHdyZnRtcC9zaUpnZzY1T3hLZXVsdkNEc3A0RHNsclRyZ3JRZzY0U2o3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHRtNFRzaG8wZzdKcVU3TEt0S0NMcmpaUWc3S2VuNnJLTUlpd2dJdXV5aE8yS3ZPeWFxZXljdk91aG5DSWc2NU94S2V5ZHRPdXB0Q0RzcDRIc29JUWc3S0NjN0pXSTdKMkVJT3EzdUNEcnNLbnRscVhzbkx6cm9ad2c2ck9nN0xPUUlPdUxwT3lMbkNEc29KenNsWWp0bFpqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSit1THRleWRnQ0Ryc0pqcms1enNpNXdnU2xOUFRpRHFzSjNzc3JRZzdaV1k2NEtZNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9VZzZyaUk3S2VBT2lBbklDc0tJQ0FnSUNBZ0ozc2ljbVZ3YkhraU9pQWk2NHlBN1ptVUlPeWRrZXVMdFNEdGxaenJrWkFnNjZ5NDdKNmxJQ2p0bGJUc21wVHNzclFwSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcnJManF0YXdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBZzdaV2NJT3VzdU95ZXBTSjlYWDFjYmx4dUp5QXJDaUFnSUNBZ0lDZGI2NHlBN1ptVVhWeHVKeUFySUhSeVlXNXpZM0pwY0hRS0lDQWdJQ2s3Q2lBZ2ZTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93cDlDZ292THlEdGxJVHJvSWpzbm9UcnM0UW83WldZN0p5RUlPMlVoT3VnaU95ZWhDRHJyTGJzbll3cElPeTJsT3l5bkNEdGhMUWc0b0NVSU8yVm5DRHRtWlRycWJUc25ZUWc3WldZN0p5RUlPMlVoT3VnaU95ZWhDRHJpNmpzbklUcm9ad2c2NEtZNjRpZ0lPdXp0T3VDdE9xem9Dd0tMeThnS2lydGxJVHJvSWpzbm9UcnA0anJpNlFnNjVTdzY2R2NLaW9nNjR5QTdKV0k3SjJFSU91d20rdUtsT3VMcEM0ZzdaV2NJT3lhbE95eXJleVhrQ0RyaTZRZzdJdWs3SmEwSU91enRPdUN0T3VLbENEcXNvUHNuYlFnN1pXMTdJdXNPZ292THlEdGxJVHJvSWpzbm9RZzdJaVk2NmVNN1lHOElPeWFsT3l5cmV5ZGhDRHNxcnpxc0p6cnFiUWc2cmU0NjZlTTdZRzhJT3VLa091Z3BPeW5nT3F6b0NqcXNJRWdOWDR4TU95MGlDa2c2cldzNjQrRklPeUNyT3lhcWV1ZmlldVBoQ0RxdDdqcnA0enRnYndnNjRLWTZyQ0U2NHVrTGdvdkx5Qm5jbTkxY0hNNklGdDdibUZ0WlN3Z2RHVjRkSE02VzExOVhTQW83Wm1VNjZtMElPeWNoT0tHa3V5VmhPdWVtQ0RzaUp3cExncG1kVzVqZEdsdmJpQmhjMnRIY205MWNITW9aM0p2ZFhCekxDQnRiMlJsYkN3Z2NtVndZWEp6WlN3Z2JXOXlaU2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lDOHZJT3V5aE8yS3ZDRHNtSUhzbDYzc25ZQWdLT3V5aE8yS3ZDbnNuTHpyb1p3ZzdMQ043SmEwSU91enRPdUN1T3VMcENEaWdKUWc2N0tFN1lxOElPdXN1T3Exck91S2xDRHJyTGpzbnFYc25iUWc3SldFNjR1STY1MjhJT3VQbWV5ZWtTRHNuYlRycG9Uc25iVHJuYndnNnJlYzdMbVo3SjIwSU91THBPdWx0T3VMcEFvZ0lDQWdZMjl1YzNRZ2JHbHpkQ0E5SUNobmNtOTFjSE1nZkh3Z1cxMHBMbTFoY0Nnb1p5d2dhU2tnUFQ0S0lDQWdJQ0FnSjFzbklDc2dLR2tnS3lBeEtTQXJJQ2RkSUNjZ0t5QlRkSEpwYm1jb0tHY2dKaVlnWnk1dVlXMWxLU0I4ZkNBb0orcTN1T3VqdVNjZ0t5QW9hU0FySURFcEtTa2dLeUFvWnlBbUppQm5Mbkp2YkdVZ1BUMDlJQ2Zyc29UdGlyd25JRDhnSnlBbzY3S0U3WXE4S1NjZ09pQW5KeWtnS3lBblhHNG5JQ3NLSUNBZ0lDQWdLR2NnSmlZZ1FYSnlZWGt1YVhOQmNuSmhlU2huTG5SbGVIUnpLU0EvSUdjdWRHVjRkSE1nT2lCYlhTa3ViV0Z3S0NoMEtTQTlQaUFuSUNBdElDY2dLeUJLVTA5T0xuTjBjbWx1WjJsbWVTaFRkSEpwYm1jb2RDQjhmQ0FuSnlrcEtTNXFiMmx1S0NkY2JpY3BDaUFnSUNBcExtcHZhVzRvSjF4dUp5azdDaUFnSUNCamIyNXpkQ0JvWVhOQ2RHNGdQU0FvWjNKdmRYQnpJSHg4SUZ0ZEtTNXpiMjFsS0NobktTQTlQaUJuSUNZbUlHY3VjbTlzWlNBOVBUMGdKK3V5aE8yS3ZDY3BPd29nSUNBZ1kyOXVjM1FnYTJWNUlEMGdKMmR5YjNWd2N5Y2dLeUFvWjNKdmRYQnpJSHg4SUZ0ZEtTNXRZWEFvS0djcElEMCtJQ2huSUNZbUlHY3VkR1Y0ZEhNZ1B5Qm5MblJsZUhSekxtcHZhVzRvSnljcElEb2dKeWNwS1M1cWIybHVLQ2NuS1RzS0lDQWdJR052Ym5OMElHRjBkR1Z0Y0hRZ1BTQW9ZWE5yWldSRGIzVnVkQzVuWlhRb2EyVjVLU0I4ZkNBd0tTQXJJREU3Q2lBZ0lDQmhjMnRsWkVOdmRXNTBMbk5sZENoclpYa3NJR0YwZEdWdGNIUXBPd29nSUNBZ2FXWWdLR0Z6YTJWa1EyOTFiblF1YzJsNlpTQStJREl3TUNrZ1lYTnJaV1JEYjNWdWRDNWpiR1ZoY2lncE93b2dJQ0FnWTI5dWMzUWdZV2RoYVc0Z1BTQnRiM0psSUh4OElHRjBkR1Z0Y0hRZ1BpQXhDaUFnSUNBZ0lEOGdKK3lkdENEdG1aVHJxYlRzbllBZzdKMjBJT3lFdU95Rm1PeVhrT3lFbkNEc25iVHJyN2dnNjR1azY2U1k2NHVrTGlEc2xaN3NoSndnNjRLNElPdU1nT3lWaU9xenZDRHNsclR0bkpqQ3QrcTFyT3loc09xd2dDRHRtWlhzaTZUdG5vZ2c2NHVrNjZXNElPeURpQ0RyaklEc2xZanJwNHdnNjRLMDY1MjhMbHh1SndvZ0lDQWdJQ0E2SUNjbk93b2dJQ0FnY21WMGRYSnVJQ2dLSUNBZ0lDQWdZV2RoYVc0Z0t3b2dJQ0FnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTdabVU2Nm0wN0oyRUlPMlZtT3ljaENEdGxJVHJvSWpzbm9UcnM0VHJvWndnNjRLWTY0aWdJT3VMcE91VHJPcTRzQ0xyaTZRdUlPeVZoT3VlbU91S2xDRHRsWndnN1ptVTY2bTA3SjJZSU91c3VPcTFyT3VsdkNEdGxaanNuSVFnN1pTRTY2Q0k3SjZFS095WWdleVhyU2tnNjR1bzdKeUU2NkdjSU91c3R1eWRnQ0Rxc29Qc25iVHJpNlF1WEc0bklDc0tJQ0FnSUNBZ0p5b3E3SmlCN0pldDY2ZUk2NHVrSU91VXNPdWhuQ29xSU91TWdPeVZpT3lkaENEcmdyVHJuYndnNG9DVUlPeVlnZXlYcmV5ZGhDRHNoSnpyb1p3ZzdaV3A3TG1ZNnJHdzY0S1lJT3lJbk95RW5PdWx2Q0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPcXdnU0RzbUlIc2w2M3NsNUFnNjR5QTdKV0lJRExxc0p3dUlPcTN1Q0RzbUlIc2w2M3NuYlFnN0plczY1K3NJT3lraE95ZHRPdXB0Q0RyaklEc2xZanJqNFFnS2lycXNKbnNuWUFnN0tTRUlPeUltQ29xNjZHY0tPeWtoT3V3bE9xL2lDQmNYRzdzbkx6cm9ad2c2cldzNjdhRUxDRHNwSVFnN0lpYzdJU2NJT3ljb095bmdDa3VYRzRuSUNzS0lDQWdJQ0FnSnkwZzdKaUI3SmV0N0oyWUlPeVhyZTJWb0NqdGc0RHNuYlR0aTREQ3QreVZpT3VDdE1LMzY3S0U3WXE4SU91VHNTbnFzN3dnN0p1UTY2eTQ3SjJZSU95Z2xldXp0TUszN0tHdzZyRzBLT3lJcSt5ZWtNSzM2NHlBN0lPQndyZnNvYkRxc2JRcDdKMkFJT3ljb095bmdPMlZtT3F6b0N3ZzdKZUc2NHFVSU95Z2xldXp0T3VsdkNEc3A0RHNsclRyZ3JUc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU9xem9PeTVvQ0Rxc293ZzdKZUc2NHFVSU95WWdleVhyZXlkdE91cHRDRHJqSURzbFlnZ01lcXduT3VuakNEcmdyVHFzYkRyZ3BnZzY3bUlJT3V3c095WHRPdWhuQ0Rya1pEc2xyVHJqNFFnNjVDYzY0dWtJT0tBbENEc2xyWHNwNERyb1p3ZzY3Q1U2cjY0N0tlQUlPdW5pT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0R0bVpUcnFiUWc2cml3NjRxbDY2cUZLT3V6Z09xeXZjSzM3WlcwN0tDY0lPdVRzU25zbllBZzZyZTQ2NHlBNjZHY0lPdVJsT3VMcEM1Y2JpY2dLd29nSUNBZ0lDQW9hR0Z6UW5SdUlEOGdKeTBnS091eWhPMkt2Q25zbkx6cm9ad2c3WkdjN0l1YzY1Q2NJT3lZZ2V5WHJleWRnQ0FuSUNzZ1FsVlVWRTlPWDFKVlRFVWdPaUFuSnlrZ0t3b2dJQ0FnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhjSzM3TDJVNjVPYzdZNmM3SXFrSU9xNGlPeW5nRHBjYmljZ0t3b2dJQ0FnSUNBbmV5Sm5jbTkxY0hNaU9pQmJleUp1WVcxbElqb2dJdXlZZ2V5WHJTRHNuYlRycG9RbzdKNkY2NkNsNnJPOElPdVBtZXlkdkNraUxDQWljM1ZuWjJWemRHbHZibk1pT2lCYmV5SjBaWGgwSWpvZ0l1dU1nT3lWaUNEcnJManF0YXdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBZzdaV2NJT3VzdU95ZXBTSjlYWDFkZlZ4dUp5QXJDaUFnSUNBZ0lDZnNtSUhzbDYzc25ZQWc3SjZGNjZDbElPeUluT3lFbk1LMzZyQ2M3SWlZNjZXOElPcTN1T3VNZ091aG5DRHNwNER0Z3Fqcmk2UXVYRzVjYmljZ0t3b2dJQ0FnSUNBblcreVlnZXlYcmV1emhDRHJyTGpxdGF4ZFhHNG5JQ3NnYkdsemRBb2dJQ0FnS1RzS0lDQjlMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdDbjBLQ2k4dklPMlVoT3VnaU95ZWhPdXpoQ0RzdHBUc3Nwd2c3SjJSNjR1MTdKZVE3SVNjSUZ0N2JtRnRaU3dnYzNWbloyVnpkR2x2Ym5NNlczdDBaWGgwTENCeVpXRnpiMjU5WFgxZElPeTJsT3kybkFwbWRXNWpkR2x2YmlCd1lYSnpaVWR5YjNWd2N5aHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdZMjl1YzNRZ1lYSnlJRDBnUVhKeVlYa3VhWE5CY25KaGVTaHZJQ1ltSUc4dVozSnZkWEJ6S1NBL0lHOHVaM0p2ZFhCeklEb2dXMTA3Q2lBZ0lDQmpiMjV6ZENCbmNtOTFjSE1nUFNCaGNuSXViV0Z3S0NobktTQTlQaUFvZXdvZ0lDQWdJQ0J1WVcxbE9pQlRkSEpwYm1jb0tHY2dKaVlnWnk1dVlXMWxLU0I4ZkNBbkp5a3VkSEpwYlNncExBb2dJQ0FnSUNCemRXZG5aWE4wYVc5dWN6b2dRWEp5WVhrdWFYTkJjbkpoZVNobklDWW1JR2N1YzNWbloyVnpkR2x2Ym5NcENpQWdJQ0FnSUNBZ1B5Qm5Mbk4xWjJkbGMzUnBiMjV6Q2lBZ0lDQWdJQ0FnSUNBZ0lDNXRZWEFvS0hncElEMCtJQ2gwZVhCbGIyWWdlQ0E5UFQwZ0ozTjBjbWx1WnljS0lDQWdJQ0FnSUNBZ0lDQWdJQ0EvSUhzZ2RHVjRkRG9nZUM1MGNtbHRLQ2tzSUhKbFlYTnZiam9nSnljZ2ZRb2dJQ0FnSUNBZ0lDQWdJQ0FnSURvZ2V5QjBaWGgwT2lCVGRISnBibWNvS0hnZ0ppWWdlQzUwWlhoMEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCeVpXRnpiMjQ2SUZOMGNtbHVaeWdvZUNBbUppQjRMbkpsWVhOdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa0tJQ0FnSUNBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvZUNrZ1BUNGdlQzUwWlhoMEtRb2dJQ0FnSUNBZ0lEb2dXMTBzQ2lBZ0lDQjlLU2s3Q2lBZ0lDQXZMeURzbmJUcnBvVHNvYkRzc0tnZzdKZUc2ck9nSU95Z25PeVZpT3VQaENEc2w0YnJpcFFnNnJ1TjY0Mnc2cml3NjZlTUlPeVpsT3ljdk91cHRDRHRtSlhzaTUwZzdKMjA3WU9JNjZHY0lPdXp1T3VMcENqcXNKbnNuWUFnN0lTNDdJV1k3SmVRSU95ZXJPeWFsT3l5clNrS0lDQWdJSEpsZEhWeWJpQm5jbTkxY0hNdWMyOXRaU2dvWnlrZ1BUNGdaeTV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dwSUQ4Z1ozSnZkWEJ6SURvZ2JuVnNiRHNLSUNCOUlHTmhkR05vSUNoZlpTa2dld29nSUNBZ2NtVjBkWEp1SUc1MWJHdzdDaUFnZlFwOUNnb3ZMeUR0akozc2w0VWc3SVM0N1lxNElPeTJsT3l5bkNEdGhMUWc0b0NVSU8yVm5DRHRqSjNzbDRYc25aZ2c2cldzN0lTeDdKcVU3SWFNS095WHJlMlZvQ3ZyckxqcXRhd3A2Nlc4SU8yVm5DRHJzb2pzbDVBZzY3TzA2NEswNnJPZ0xBb3ZMeURzbXBUc2hvenJzNFFnNjRLeDZyQ2M2ckNBSU95VmhPdUxpT3VkdkNBcUt1eVpoT3lFc2V1UW5DRHRqSjNzbDRVZzdJUzQ3WXE0S095OGdPeWR0T3lLcENrZ01uNHo2ckNjS2lycnBid2c3WWExN0p5ODY2R2NJT3V3bSt1S2xPdUxwQzRLTHk4ZzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdk95ZHRDRHRsWndnNjZxNDdKeTg2NkdjSU95ZHZPcTBnT3VQdk95VnZDRHRsWmpycjREcm9ad282NVN3NjZHY0lPdTlrZXlWaENEc29iRHRsYW50bFpqcnFiUWc3SmEwNnJpTDY0S2M2NHVrS1NEc2hManRpcmdnNjR1bzdKeUU2NkdjSU95Z25PeVZpTzJWbU9xeWpDRHRsWnpyaTZRdUNpOHZJR1ZzWlcxbGJuUnpPaUJiZTNKdmJHVXNJSFJsZUhSOVhTQW83Wm1VNjZtMElPeWNoT0tHa3V5VmhPdWVtQ0RzaUp3cExnb3ZMeUJ0YjNKbFBYUnlkV1VvVyt5OGdPeWR0T3lLcENEcmpaUWc2N0NiNnJpd1hTbnJxYlFnN0oyMElPeUV1T3lGbU95WGtPeUVuQ0RzbmJUcnI3Z2c2NEs0SU95RXVPMkt1T3laZ0NEcXNybnN1WmpzcDRBZzdKV0s2NHFVSU95RGlDRHNoTGp0aXJqcnBid2c3SnFVNnJXczdaV2M2NHVrTGdwbWRXNWpkR2x2YmlCaGMydFFiM0IxY0NobGJHVnRaVzUwY3l3Z2JXOWtaV3dzSUhKbGNHRnljMlVzSUcxdmNtVXBJSHNLSUNCeVpYUjFjbTRnY25WdVZIVnliaWdvS1NBOVBpQjdDaUFnSUNCamIyNXpkQ0J5YjJ4bGN5QTlJQ2hsYkdWdFpXNTBjeUI4ZkNCYlhTa3ViV0Z3S0NobEtTQTlQaUJUZEhKcGJtY29LR1VnSmlZZ1pTNXliMnhsS1NCOGZDQW5KeWtwTG1wdmFXNG9KeXdnSnlrN0NpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ0tHVnNaVzFsYm5SeklIeDhJRnRkS1M1dFlYQW9LR1VzSUdrcElEMCtDaUFnSUNBZ0lDaHBJQ3NnTVNrZ0t5QW5MaUJiSnlBcklGTjBjbWx1Wnlnb1pTQW1KaUJsTG5KdmJHVXBJSHg4SUNjbktTQXJJQ2RkSUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoVGRISnBibWNvS0dVZ0ppWWdaUzUwWlhoMEtTQjhmQ0FuSnlrcENpQWdJQ0FwTG1wdmFXNG9KMXh1SnlrN0NpQWdJQ0F2THlEcXNKbnNuWUFnN1l5ZDdKZUY3SjJFSU91cWh5RHJzb2pzcDdnZzY2eTc2NHFVN0tlQUlPcTRzT3lXdFNEaWdKUWc3SjZzN0pxVTdMS3Q3SjIwNjZtMElDTHNuYlRzb0lUcXM3d2c2NHVrNjZXNElPeUV1TzJLdUNMcnBid2c3SnFVNnJXczdaV2M2NHVrQ2lBZ0lDQXZMeUFvWVhOclEyeGhkV1JsN0ptQUlPcXdtZXlkZ0NEc25iVHNuS0E2SU95VmlDRHF0N2pybjZ6cnFiUWc3WUcwNjZHYzY1T2M2ckNBSU9xd21leWRnQ0RzaExqdGlyanJwYndnNjVpUUlPdUN0T3lFbkNCYjdMeUE3SjIwN0lxa0lPdU5sQ0Ryc0p2cXVMQmQ2ckNBSU91c3RPeWRtT3V2dU8yVnRPeW5oT3VMcENrS0lDQWdJR052Ym5OMElHdGxlU0E5SUNkd2IzQjFjQUVuSUNzZ0tHVnNaVzFsYm5SeklIeDhJRnRkS1M1dFlYQW9LR1VwSUQwK0lGTjBjbWx1Wnlnb1pTQW1KaUJsTG5SbGVIUXBJSHg4SUNjbktTa3VhbTlwYmlnbkFTY3BPd29nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2hyWlhrcElIeDhJREFwSUNzZ01Uc0tJQ0FnSUdGemEyVmtRMjkxYm5RdWMyVjBLR3RsZVN3Z1lYUjBaVzF3ZENrN0NpQWdJQ0JwWmlBb1lYTnJaV1JEYjNWdWRDNXphWHBsSUQ0Z01qQXdLU0JoYzJ0bFpFTnZkVzUwTG1Oc1pXRnlLQ2s3SUM4dklPdXN0TzJWbk8yZWlDRHNqSlBzbmJUc3A0QWc3SldLNnJLTUNpQWdJQ0JqYjI1emRDQmhaMkZwYmlBOUlHMXZjbVVnZkh3Z1lYUjBaVzF3ZENBK0lERUtJQ0FnSUNBZ1B5QW43SjIwSU8yTW5leVhoZXlkZ0NEc25iUWc3SVM0N0lXWTdKZVE3SVNjSU95ZHRPdXZ1Q0RyaTZUcnBKanJpNlF1SU95Vm51eUVuQ0Rzb0p6c2xZanRsWndnN0lTNDdZcTQ2NU9rNnJPOElDb3E3S0NSNnJlOHdyZnNsclR0bkpqcXNJQWc3Wm1WN0l1azdaNklJT3VMcE91bHVDRHNnNGdnN0lTNDdZcTRLaXJycDR3ZzY0SzA2NTI4S09xd21leWRnQ0RzaExqdGlyZ2c2N0NZNjdPMUlPcTRpT3luZ0NrdVhHNG5DaUFnSUNBZ0lEb2dKeWM3Q2lBZ0lDQnlaWFIxY200Z0tBb2dJQ0FnSUNCaFoyRnBiaUFyQ2lBZ0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJQ0x0akozc2w0VW82NHVrN0oyMDdKYTg2NkdjNnJlNEtTRHNoTGp0aXJnZzY0dWs2NU9zNnJpd0l1dUxwQzRnN0pXRTY1Nlk2NHFVSU8yVm5DRHRqSjNzbDRYc25ZUWc3SnlFNG9hUzdKV0U2NTZZNjZHY0lPdUNtT3lYdE8yVm5DRHF0YXpzaExIc21wVHNob3pyazZUc25iVHJpNlFvN0lTYzY2R2NJT3VzdE9xMGdPMlZuQ0RyczRUcXNKd2c2Nnk0NnJXczZyQ0FJT3lWaE91TGlPdUxwQ2t1SUNjZ0t3b2dJQ0FnSUNBbjdKcVU3SWFNNjZXOElPdUNzZXF3bk91aG5DRHFzNkRzdVpqc3A0QWc2NmVRNnJPZ0xDQXFLdTJEZ095ZHRPMkxnTUszN0pXSTY0SzB3cmZyc29UdGlyenNuYlFnN0lTYzY2R2NJT3lkdk9xMGdPdVFuQ0FpN0ptRTdJU3g2NUNjSU8yTW5leVhoU0RzaExqdGlyZ2lJREorTStxd25Db3E2Nlc4SU95Z25PeVZpTzJWbU91ZHZDNGc2ckNCSU95RXVPMkt1T3VLbENEc2hKenJvWndnNjR1azY2VzRJT3lna2VxM3ZPeWR0T3lXdE95VnZDRHRsWnpyaTZRdVhHNG5JQ3NLSUNBZ0lDQWdKK3F3Z1NEc2hManRpcmpyaXBRZzdKNkY2NkNsNnJPOElDb3E2ckNaN0oyQUlPeVhyZTJWb01LMzZyQ1o3SjJBSU9xd25PeUltTUszNnJDWjdKMkFJT3lJbk95RW5Db3E3SjJZSU95YWxPeUdqT3VsdkNEcnFxanJrWkFnN1krczdaV283WldjNjR1a0xpRHNoTGp0aXJnZzdKV0k3SmVRN0lTY0lPMkRnT3lkdE8yTGdNSzM3SldJNjRLMHdyZnJzb1R0aXJ6c25ZQWc3WldjSU91cXVPeWN2T3VobkNEcnA1N3NsWVRybHFqc2xyVHNvTGpzbGJ3ZzdaV2M2NHVrS095WWlEb2c2N080NjZ5NDdKMjBJQ0orN1pXZzZybU03SnFVUHlMcnFiUWc2N0tFN1lxODdKMkFJRnZzbFlUcmk0anNtS1JkTDF2cmhLUmRLUzVjYmljZ0t3b2dJQ0FnSUNBblcrMk1uZXlYaFNEcnJManNzclFnNnJlYzdMbVpJT0tBbENEc25JUWc3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuT3lkbUNBaU9DNGc3WXlkN0plRklpRHNoTG5zaFpqc25ZUWc2NVN3NjZXNDY0dWtYVnh1SnlBckNpQWdJQ0FnSUNjdElPMkRnT3lkdE8yTGdEb2c3S2VuN0oyQUlPdXFoZXlDck9xMXJDZ3lmalRzbHJUc29JZ3BMQ0Rzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5DRHNsNGJzbmJRb2Z1eWFsQzkrNjR1a0wzN3F1WXpzbXBRL0lPcTRpT3luZ0NrdUlPdXdtT3VUbk95TG5DRHNsWWpyZ3JRbzY3TzQ2Nnk0S1NEcnA2WHJuYjNzbllRZzdKcVU3Slc5N1pXMElPMkRnT3lkdE8yTGdPdW5qQ0RydEpEcmo0UWc2NnkwN0lxb0lPMk1uZXlYaGV5ZHVPeW5nQ0RzbFl6cXNvd2c3WldZNjUyOExpRHNtNURyczdqc25iUWdJdXlWak91bXZDL3RtWlhzbmJnaTdMS1k2NSs4SU91bmlleVhzTzJWbU91cHRDRHJzN2pyckxqc25ZUWc2cmU4NnJHdzY2R2NJT3Exck95eXRPMlpsTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEc2xZanJnclFvNjdPNDY2eTRLVG9nN1pXMDdKcVU3TEswTGlEdGpKRHJpNmpzbmJRZzdaV0U3SnFVN1pXWTY2bTBJQ0orN1pXZzZybU03SnFVUHlMcm9ad2c2Nnk3NnJPZ0xDRHJrSmpyajR6cnByUWc3SWlZSU95WGh1dUtsQ0RzbklUdGw1Z283SUt0N0tDY3dyZnRnNGp0aDdRZzY1T3hLZXlkZ0NEcXNyRHFzN3pycGJ3ZzY2aTg3S0NBSU9xeXZlcXpvTzJWbk91THBDNGc2ckt3NnJPOHdyZnNnNEh0ZzV3ZzdZYTE2N08wNjZtMElPeUVuT3lJb08yWWxleWN2T3VobkNEc2xZenJwckRyaTZRdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnNjdLRTdZcThPaURyczdqcnJManNuYlFnSW43dGxhRHF1WXpzbXBRL0l1dXB0Q0JiN0pXRTY0dUk3SmlrWFM5YjY0U2tYU3dnNjdPNDY2eTQ3SjIwSU95RGdlMlpxZXlkaENEc2hKenNpS0R0bFpqcXM2QWc3SjIwSU91eWhPMkt2T3lkdENEc2k2VHNvSndnNjQrWjdKNlI3SjIwNjZtMElPdVBtZXlla1NEcmo1bnNncXdvN0lLdDdLQ2NMK3lnZ095ZXBTL3NsN0Rxc3JBZzdaVzA3S0NjSU91VHNTa3NJTzJHdGV1enRDRHRqSjNzbDRYc25aZ2c2NHVvN0oyOElPdXloTzJLdk95ZHRPdXB0Q0FpN1ptVjdKMjRJaTRnSXV5M3FPeUdqQ0xyaXBRZzY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1MQ0FpNjR1cjZyaXd3cmZyajVuc25wRWlJT3loc08yVnFTRHF1SWpzcDRBdUlPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRnQ0RxdDdqcmpJRHJvWndnNjVHVTY0dWtMbHh1SnlBckNpQWdJQ0FnSUNjdElPeWJrT3VzdU95ZG1DRHNvSlhyczdUQ3QreWhzT3F4dENqc2lLdnNucERDdCt5ZHRPeURnUy9zbmJUdGxaakN0K3VNZ095RGdTbnNuWUFnN0p5ZzdLZUE3WldZNnJPZ0xDRHNtNURyckxqc2w1QWc3SmVHNjRxVUlPeWdsZXV6dE1LMzdLQ0k3TENvd3Jmc2w3RHJuYjNzc3BqcnBid2c3S2VBN0phMDY0SzA3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhjSzM3TDJVNjVPYzdZNmM3SXFrSU9xNGlPeW5nRHBjYmljZ0t3b2dJQ0FnSUNBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXlkdENEc2hManRpcmpzblpnZzY3Q3A3WmFsN0oyRUlPMlZuT3ExcmV5V3RDRHRsWndnNjZ5NDdKNmw3Snk4NjZHY0lpd2dJbVZzWlcxbGJuUnpJam9nVzNzaWNtOXNaU0k2SUNMc2w2M3RsYUFpTENBaWRHVjRkQ0k2SUNMcnJManF0YXdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSW4wc0lDNHVMbDE5TENBdUxpNWRmVnh1SnlBckNpQWdJQ0FnSUNmc2w2M3RsYURzbllBZzdKNkY2NkNsSU95SW5PeUVuT3VNZ091aG5Eb2dKeUFySUhKdmJHVnpJQ3NnSjF4dVhHNG5JQ3NLSUNBZ0lDQWdKMXZ0akozc2w0VWc3SnFVN0lhTVhWeHVKeUFySUd4cGMzUUtJQ0FnSUNrN0NpQWdmU3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBPd3A5Q2dvdkx5RHRqSjNzbDRVZzdKMlI2NHUxN0plUTdJU2NJSHR6WlhSek9pQmJlM0psWVhOdmJpd2daV3hsYldWdWRITTZXM3R5YjJ4bExIUmxlSFI5WFgxZGZTRHN0cFRzdHB3Z0tPeTlsT3VUbk8yT25PeUtwTUszN0pXZTY1S2tJT3llb2V1THRDRHRsNGpzbXFrcENtWjFibU4wYVc5dUlIQmhjbk5sVUc5d2RYQW9jbUYzS1NCN0NpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3Q2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwWTJnb0wxeDdXMXh6WEZOZEtseDlMeWs3Q2lBZ2FXWWdLRzBwSUhNZ1BTQnRXekJkT3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdklEMGdTbE5QVGk1d1lYSnpaU2h6S1RzS0lDQWdJR052Ym5OMElITmxkSE5KYmlBOUlFRnljbUY1TG1selFYSnlZWGtvYnlBbUppQnZMbk5sZEhNcElEOGdieTV6WlhSeklEb2dXMTA3Q2lBZ0lDQmpiMjV6ZENCelpYUnpJRDBnYzJWMGMwbHVDaUFnSUNBZ0lDNXRZWEFvS0hOMEtTQTlQaUFvZXdvZ0lDQWdJQ0FnSUhKbFlYTnZiam9nVTNSeWFXNW5LQ2h6ZENBbUppQnpkQzV5WldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0Nrc0NpQWdJQ0FnSUNBZ1pXeGxiV1Z1ZEhNNklFRnljbUY1TG1selFYSnlZWGtvYzNRZ0ppWWdjM1F1Wld4bGJXVnVkSE1wQ2lBZ0lDQWdJQ0FnSUNBL0lITjBMbVZzWlcxbGJuUnpDaUFnSUNBZ0lDQWdJQ0FnSUNBZ0xtMWhjQ2dvWld3cElEMCtJQ2g3SUhKdmJHVTZJRk4wY21sdVp5Z29aV3dnSmlZZ1pXd3VjbTlzWlNrZ2ZId2dKeWNwTG5SeWFXMG9LU3dnZEdWNGREb2dVM1J5YVc1bktDaGxiQ0FtSmlCbGJDNTBaWGgwS1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1FvZ0lDQWdJQ0FnSUNBZ0lDQWdJQzVtYVd4MFpYSW9LR1ZzS1NBOVBpQmxiQzUwWlhoMEtRb2dJQ0FnSUNBZ0lDQWdPaUJiWFN3S0lDQWdJQ0FnZlNrcENpQWdJQ0FnSUM1bWFXeDBaWElvS0hOMEtTQTlQaUJ6ZEM1bGJHVnRaVzUwY3k1c1pXNW5kR2dwT3dvZ0lDQWdjbVYwZFhKdUlITmxkSE11YkdWdVozUm9JRDhnYzJWMGN5QTZJRzUxYkd3N0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzS0lDQWdJSEpsZEhWeWJpQnVkV3hzT3dvZ0lIMEtmUW9LTHk4ZzY0eUE3Wm1VN1ppVklPeWduT3lla1NEc25aSHJpN1hzbDVEc2hKd2dlM0psY0d4NUxDQnpkV2RuWlhOMGFXOXVjMXRkZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxRMjl0Y0c5elpTaHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdZMjl1YzNRZ2NtVndiSGtnUFNCVGRISnBibWNvS0c4Z0ppWWdieTV5WlhCc2VTa2dmSHdnSnljcExuUnlhVzBvS1RzS0lDQWdJR052Ym5OMElITjFaMmRsYzNScGIyNXpJRDBnUVhKeVlYa3VhWE5CY25KaGVTaHZJQ1ltSUc4dWMzVm5aMlZ6ZEdsdmJuTXBDaUFnSUNBZ0lEOGdieTV6ZFdkblpYTjBhVzl1Y3dvZ0lDQWdJQ0FnSUNBZ0xtMWhjQ2dvZUNrZ1BUNGdLSHNnZEdWNGREb2dVM1J5YVc1bktDaDRJQ1ltSUhndWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd2djbVZoYzI5dU9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmU2twQ2lBZ0lDQWdJQ0FnSUNBdVptbHNkR1Z5S0NoNEtTQTlQaUI0TG5SbGVIUXBDaUFnSUNBZ0lEb2dXMTA3Q2lBZ0lDQnBaaUFvY21Wd2JIa2dmSHdnYzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvS1NCeVpYUjFjbTRnZXlCeVpYQnNlU3dnYzNWbloyVnpkR2x2Ym5NZ2ZUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURzbFlUcm5wanJvWndnS2k4Z2ZRb2dJSEpsZEhWeWJpQnVkV3hzT3dwOUNnb3ZMeURyc29qc2w2MGc3SjJSNjR1MTdKZVE3SVNjSUh0MGNtRnVjMnhoZEdWa0xDQmthWEpsWTNScGIyNTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa0tablZ1WTNScGIyNGdjR0Z5YzJWVWNtRnVjMnhoZEdVb2NtRjNLU0I3Q2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdDaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4N1cxeHpYRk5kS2x4OUx5azdDaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0J2SUQwZ1NsTlBUaTV3WVhKelpTaHpLVHNLSUNBZ0lHTnZibk4wSUhSeVlXNXpiR0YwWldRZ1BTQlRkSEpwYm1jb0tHOGdKaVlnYnk1MGNtRnVjMnhoZEdWa0tTQjhmQ0FuSnlrdWRISnBiU2dwT3dvZ0lDQWdhV1lnS0hSeVlXNXpiR0YwWldRcElISmxkSFZ5YmlCN0lIUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZiam9nVTNSeWFXNW5LQ2h2SUNZbUlHOHVaR2x5WldOMGFXOXVLU0I4ZkNBbkp5a3VkSEpwYlNncElIMDdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIMEtJQ0J5WlhSMWNtNGdiblZzYkRzS2ZRb0tMeThnN0oyUjY0dTE3SmVRN0lTY0lIdDBaWGgwTENCeVpXRnpiMjU5SU91d3NPeVh0Q0RzdHBUc3Rwd2dLT3k5bE91VG5PMk9uT3lLcE1LMzdKV2U2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3BDbVoxYm1OMGFXOXVJSEJoY25ObFUzVm5aMlZ6ZEdsdmJuTW9jbUYzS1NCN0NpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3Q2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwWTJnb0wxeGJXMXh6WEZOZEtseGRMeWs3Q2lBZ2FXWWdLRzBwSUhNZ1BTQnRXekJkT3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCaGNuSWdQU0JLVTA5T0xuQmhjbk5sS0hNcE93b2dJQ0FnYVdZZ0tFRnljbUY1TG1selFYSnlZWGtvWVhKeUtTa2dld29nSUNBZ0lDQnlaWFIxY200Z1lYSnlDaUFnSUNBZ0lDQWdMbTFoY0Nnb2VDa2dQVDRnS0hzZ2RHVjRkRG9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VkR1Y0ZENrZ2ZId2dKeWNwTG5SeWFXMG9LU3dnY21WaGMyOXVPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNXlaV0Z6YjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcENpQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb2VDa2dQVDRnZUM1MFpYaDBLVHNLSUNBZ0lIMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURzbFlUcm5wanJvWndnS2k4Z2ZRb2dJSEpsZEhWeWJpQmJYVHNLZlFvS0x5OGc2NkdjNnJlNDdKMjRJTzJWaE95YWxNSzM3WldjNjQrRUlPeTBpT3F6dkNEc2c0SHRnNXpzbmJ3ZzY1V01JQzlvWldGc2RHZ2c3S0d3N1pxTTZyQ0FJT3lZcE91cHRDRHJrcVRzbDVEc2hKd2c3SnVNNjdDTjdKZUY3SjJFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlRyczdqcmk2UWdLRE13N0xTSTdKZVFJREhyc29qcnA0d3BMZ292THlEc2hMSHFzN1h0bFpqcnFiUWc2ckt3NnJPOElPMlZ1T3VUcE91ZnJPcXdnQ0JqYkdGMVpHVlRkR0YwZFhNOUoyOXJKK3VobkNEcmtKanJqNHpycHF6cnI0RHJvWndzSU95ZXJPdWhuT3EzdU95ZHVDRHRtNFFnNjdLRTdZcTg3SjIwSU95Z2dPeWdpT3VobkNEd241K2k3Snk4NjZHY0lPdXp0ZXEzZ08yVm5PdUxwQzRLTHk4Z0tPMlVqT3Vmck9xM3VPeWR1T3lkdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHNDRHJrcVFnN0tPODZyaXc3S0NCN0p5ODY2R2NJQzlvWldGc2RHanJwYndnN0tHdzdacU03WldZNjRxVUlPcXlnK3F6dkNEc3A1M3NuWVFnN0oyMDY2T3M2NHVrS1Fvdkx5RHRsWnpyajRRZzdMU0k2ck84NjQrRUlPcXdtZXlkZ0NEcXNyM3JvWnpyb1p3ZzY3TzE2cmVBN0l1YzdZS282NHVrSU9LQWxDRHF0SURycHF6c25wRHFzSUFnN1pXYzY0K0U2Nlc4SU95WXJPdWdwT3lqdk9xeHNPdUNtQ0R0bFp6cmo0VHFzSUFnN0xTSTZyaXc3Wm1VNjVDWTY2bTBDaTh2SU95Q3JPeWFxZXlla09xd2dDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPdUlqT3Vmck91UGhDRHJzb1R0aXJ6c25iUWc4Sitmb3V5Y3ZPdWhuQ0RyajR6c2xZVHNtS2pyaTZRdUlPMlZuT3VQaE95WGtDRHFzYmpycHJBZzdaaTQ3TGFjN0oyQUlPcXhzT3lnaU91UW1PdXZnT3VobkNEc2dxenNtcW5ybjRuc25ZQWc3SldJSU91Q21PcXdoT3VMcEFvdkx5RHFzNFRzb0pYc25iUWdLaXJyc0pic2w1RHNoSndxS2lEcnNKVHJnSkFnNnJLRDdKMkVJT3lWak95VmhPeXhpT3VMcENBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU1qWXBMZ292THlEdGhMRHJyN2pyaEpEc25iVHJncGdnNjdpTTY1Mjg3SnF3N0tDQTdKZVE3SVNjSU91THBPdWx1Q0RxczRUc29KWHNuTHpyb1p3ZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95ZWtPcXlxZXltbmV1cWhTRHRqSXpzbmJ6c25ZQWc2N0NVNjRDTTdLZUE2NmVNTENEc25iVHJyN2dnNjVhZ0lPeWVpT3VLbENCamJHRjFaR1VLTHk4ZzdJUzQ3SVdZN0oyQUlPeUxuT3VQbWUyVm9DRHJsWXdnNjdDYjdKMkFJT3lZbXlEcXM0VHNvSlVnN0o2RjdKNmw2cmFNN0oyRUlPcTN1T3VNZ091aG5DRHNrN1RyaTZRZzRvYVNJT3lEaUNEcXM0VHNvSlhzbDVBZzdJS3M3SnFwNjUrSjdKMjBJT3VDcU95VmhDRHNub2pzbHJUcmo0UWdJdTJWbk91UGhDRHN0SWpxczd3aTZyQ0FDaTh2SU9xemhPeUdqU0RyZ3Bqc21LanJpNlFvTWpBeU5pMHdPQ0RzaTZUc3VLRWc3SXVnNnJPZ09pQWk3SU9JSU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsb2pyaXBUcmpiQWc3Sm1jSU9xM3VDRHFzNFRzb0pVZzdJS3M3SnFwNjUrSjdKMkVJT3VxdXlEc2s3RHJnNUFpS1M0S0x5OGc3WlNNNjUrczZyZTQ3SjI0N0oyRUlPcXhzT3k1bkNEcm9aenF0N2pzbmJqQ3QrdWhuT3EzdU95VmhPeWJneWd2YjNCbGJpMXNiMmRwYnNLM0wyTnNZWFZrWlMxc2IyZHZkWFFwN0oyQUlHdHBiR3hRY205ajdKeTg2NkdjSU95RXVPeUZtT3lkaENEcnNvVHJvS1RzaEp3ZzdKMjBJT3VzdU95Z25PcXdnQW92THlEc2w0YnNsNGpyaXBUcmpiQXNJT3V3bHV5WGtPeUVuQ0Ryc0pUcXZyanJxYlFnNjR1azY2YXM2ckNBSU95VmpDRHJzS25yc3BYc25iUWc3SmVHN0plSTY0dWtMaURxdDdqcm5wanNoSndnTDJobFlXeDBhQ0Rzb2JEdG1venJwNGpyaTZRZzdZeU03SjI4N0oyWUlPcXpoT3lnbGVxenZDRHJ1WVRxdFpEdGxaenJpNlF1Q2k4dklPdTVoT3lhcVNBd0tPMk1qT3lkdk91bmpDRHNuYjNxczZBc0lHTnNZWFZrWlVGalkyOTFiblRzblpnZ016RHN0SWdnN0xxUTdJdWM2Nlc4SU9xM3VPdU1nT3VobkNEc2s3VHJpNlFnNG9DVUlDNWpiR0YxWkdVdWFuTnZidXlkdENEc3U2VHNoSndnNjZlazY3S0lJT3lkdmV5bmdDRHNsWXJyaXBUcmk2UXBMZ292THlEcXM0VHNvSlVnN0o2STdKMk1JT0tHa2lEc2w0YnNuWXdvNjZHYzZyZTQ3SldFN0p1REtTRHJzS250bHFYc25ZQWc2ckcwNjVPYzY2YXM3S2VBSU95Vml1dUtsT3VMcERvZzdZeU03SjI4N0oyRUlPdU5ydXlXdE95VHNPdUtsQ0RzaUp6cXNJUWc3SjZnNnJtUUlPdXF1eURzbmIzcmlwUWc2cktENnJPOENpOHZJT3Exck91MmhPdVFtT3luZ0NEc2xZcnNsWVFnN1plYklPeWVyT3lMbk95ZWtleWRoQ0RydG9EcnBiVHFzNkFzSU9xM3VDRHJzS250bHFYc25ZQWc3SjI0N0thZElPeVlwT3VsbUNEcXNyM3JvWndvYVhOQmRYUm9SWEp5YjNJcDZyQ0FJT3lkdE91dnVDRHNzcGpycHF6dGxaenJpNlF1Q21aMWJtTjBhVzl1SUhKbGMzUmhjblJKWmtGalkyOTFiblJEYUdGdVoyVmtLQ2tnZXdvZ0lHbG1JQ2doY0hKdll5QjhmQ0IzWVdsMFpYSXBJSEpsZEhWeWJqc2dJQ0FnSUNBZ0lDQXZMeURzaExqc2haZ2c3SmVHN0oyTUtPdUxwT3lkakNEdGhMVHNuYlFnN0lPSTY2R2NJT3lMbk91UG1Ta2dMeUR0aExRZzdLZUU3WmFKSU95a2tleWR0T3VwdENEcmk2VHNuWXdnN0tHdzdacU03SmVRN0lTY0NpQWdZMjl1YzNRZ2JtOTNJRDBnWTJ4aGRXUmxRV05qYjNWdWRDZ3BPd29nSUdsbUlDZ2hibTkzSUh4OElHNXZkeUE5UFQwZ2MyVnpjMmx2YmtGalkyOTFiblFwSUhKbGRIVnlianNLSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2ck9FN0tDVjdKMjBJT3V3bE91QWpPeVhpT3lXdE95YWxDQW9KeUFySUNoelpYTnphVzl1UVdOamIzVnVkQ0I4ZkNBbjdKZUc3SjJNSnlrZ0t5QW5JT0tHa2lBbklDc2dibTkzSUNzZ0p5a2c0b0NVSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRUlPdXloT3Vtck9xem9DRHNnNGdnNnJPRTdLQ1Y3Snk4NjZHY0lPdUxwT3lMbkNEc2k1enNucEh0bGFucmk0anJpNlF1SnlrN0NpQWdMeThnN0oyWTY0K0U3S0NCSU95aWhldWpqQ2h5WldGemIyNGc3S2VBN0tDVktTRGlnSlFnVTBWVFUwbFBUbDlFU1VWRTY2R2NJT3VCbmV1Q3RPdXB0Q0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91bXNPdUxwQW9nSUd0cGJHeFFjbTlqS0NmcXM0VHNvSlhzbmJRZzY3Q1U2NENNN0phMDdJU2NJT3lFdU95Rm1PeWRoQ0RzZzRqcm9ad2c3SXVjN0o2UjdaYUk3SmEwN0pxVUlPS0FsQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRuS1RzS0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNCdWRXeHNPeUF2THlEdGxaenJqNFRDdCt1aG5PcTN1T3lkdUNEc2c0SHRnNXpyaXBRZzZyT0U3S0NWNjZlSTY0dWtJT3VMcE91bHRPdUxwQ0RpZ0pRZzdJT0lJT3F6aE95Z2xleWN2T3VobkNEcmk2VHNpNXdnN1l5UTdLQ1Y3WldZNnJLTUNpQWdjMlZ6YzJsdmJrRmpZMjkxYm5RZ1BTQnViM2M3Q24wS0NteGxkQ0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQU0F3T3dwbWRXNWpkR2x2YmlCeVpYUnllVUYxZEdoSlprNWxaV1JsWkNncElIc0tJQ0JwWmlBb1kyeGhkV1JsVTNSaGRIVnpJQ0U5UFNBblkyeGhkV1JsTFd4dloyOTFkQ2NnSmlZZ1kyeGhkV1JsVTNSaGRIVnpJQ0U5UFNBblkyeGhkV1JsTFd4cGJXbDBKeWtnY21WMGRYSnVPd29nSUdsbUlDaDNZV2wwWlhJZ2ZId2dSR0YwWlM1dWIzY29LU0F0SUd4aGMzUkJkWFJvVW1WMGNubEJkQ0E4SURNd01EQXdLU0J5WlhSMWNtNDdJQzh2SU95bmhPMldpU0RzcEpFZzdZUzBJT3V3cWUyVnRDRHF1SWpzcDRBZ0t5QXpNT3kwaUNEcXNJVHFzcWtLSUNCc1lYTjBRWFYwYUZKbGRISjVRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdKNnM3Wm1WN0oyNElPeUxuT3VQaE9LQXBpY3BPd29nSUhKMWJsUjFjbTRvS0NrZ1BUNGdKK3Vobk9xM3VPeWR1Q0R0bVpYc25ianNtcW5zbmJUcmk2UXVJQ0pQU3lMcm5ienFzNkRycDR3ZzY0dTE3WldZNjUyOExpY3BMblJvWlc0b0NpQWdJQ0FvS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU8yWmxleWR1T3VRcUNEaWdKUWc3S0NWN0lPQklPeURnZTJEbk91aG5DRHJzN1hxdDRBdUp5a3NDaUFnSUNBb1pTa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeVZoT3luZ1NEcm9aenF0N2pzbmJnZzdKV0lJT3VRcURvbkxDQlRkSEpwYm1jb1pTNXRaWE56WVdkbEtTNXpiR2xqWlNnd0xDQTRNQ2twQ2lBZ0tUc0tmUW9LTHk4ZzdJdWs3WXlvSU95ZGtldUx0ZXlkaENEc2dxenJub3pzbXFrZzdKV0k2NEswNjZHY0lPdXpnTzJabUNEaWdKUWc3SnVRN0oyNEtPdWhuT3EzdU95ZHVDL3NoS1RzdVpncDdKMjBJTzJNak95VmhldVFuQ0Rxc3Izc21yRHNsNVFnNnJlNElPeVZpT3VDdE91bHZDd2c3SldFNjR1STY2bTBJT3lna2V1UmtPeVd0Q3ZzbTVEcnJManNuWVFnNjdPMDY0SzQ2NHVrQ21aMWJtTjBhVzl1SUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnY0hKbFptbDRLU0I3Q2lBZ2FXWWdLR1VnSmlZZ1pTNXRaWE56WVdkbElEMDlQU0JNVDBkSlRsOUhWVWxFUlNrZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUV4UFIwbE9YMGRWU1VSRkxDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXeHZaMjkxZENjZ2ZUc0tJQ0JwWmlBb1pTQW1KaUJsTG0xbGMzTmhaMlVnUFQwOUlFeEpUVWxVWDBkVlNVUkZLU0J5WlhSMWNtNGdleUJsY25KdmNqb2dURWxOU1ZSZlIxVkpSRVVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YkdsdGFYUW5JSDA3Q2lBZ2FXWWdLR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdKMk5zWVhWa1pTMXRhWE56YVc1bkp5a2dld29nSUNBZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUNmc25iUWdVRVBzbDVBZ1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbEtlcXdnQ0RzaEtUc3VaanJqN3dnN0o2STdLZUFJT3lWaXV5VmhPeWFsQ0RpZ0pRZzdJU2s3TG1ZN1pXWTZyT2dJT3Vobk9xM3VPeWR1TzJWbkNEcmtxUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeXdnY0hKdllteGxiVG9nSjJOc1lYVmtaUzF0YVhOemFXNW5KeUI5T3dvZ0lIMEtJQ0J5WlhSMWNtNGdleUJsY25KdmNqb2djSEpsWm1sNElDc2dLR1VnSmlZZ1pTNXRaWE56WVdkbElEOGdaUzV0WlhOellXZGxJRG9nVTNSeWFXNW5LR1VwS1NCOU93cDlDZ3BtZFc1amRHbHZiaUJ5WldGa1FtOWtlU2h5WlhFcElIc0tJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVVwSUQwK0lIc0tJQ0FnSUd4bGRDQmliMlI1SUQwZ0p5YzdDaUFnSUNCeVpYRXViMjRvSjJSaGRHRW5MQ0FvWXlrZ1BUNGdleUJpYjJSNUlDczlJR003SUgwcE93b2dJQ0FnY21WeExtOXVLQ2RsYm1RbkxDQW9LU0E5UGlCN0NpQWdJQ0FnSUhSeWVTQjdJSEpsYzI5c2RtVW9TbE5QVGk1d1lYSnpaU2hpYjJSNUtTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lISmxjMjlzZG1Vb2UzMHBPeUI5Q2lBZ0lDQjlLVHNLSUNCOUtUc0tmUW9LWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3b2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxUGNtbG5hVzRuT2lBbktpY3NDaUFnSjBGalkyVnpjeTFEYjI1MGNtOXNMVUZzYkc5M0xVMWxkR2h2WkhNbk9pQW5SMFZVTENCUVQxTlVMQ0JQVUZSSlQwNVRKeXdLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RTR1ZoWkdWeWN5YzZJQ2REYjI1MFpXNTBMVlI1Y0dVbkxBcDlPd3BtZFc1amRHbHZiaUJxYzI5dUtISmxjeXdnYzNSaGRIVnpMQ0J2WW1vcElIc0tJQ0J5WlhNdWQzSnBkR1ZJWldGa0tITjBZWFIxY3l3Z1QySnFaV04wTG1GemMybG5iaWg3SUNkRGIyNTBaVzUwTFZSNWNHVW5PaUFuWVhCd2JHbGpZWFJwYjI0dmFuTnZianNnWTJoaGNuTmxkRDExZEdZdE9DY2dmU3dnUTA5U1UxOUlSVUZFUlZKVEtTazdDaUFnY21WekxtVnVaQ2hLVTA5T0xuTjBjbWx1WjJsbWVTaHZZbW9wS1RzS2ZRb0tZMjl1YzNRZ2MyVnlkbVZ5SUQwZ2FIUjBjQzVqY21WaGRHVlRaWEoyWlhJb1lYTjVibU1nS0hKbGNTd2djbVZ6S1NBOVBpQjdDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUFVGUkpUMDVUSnlrZ2V5QnlaWE11ZDNKcGRHVklaV0ZrS0RJd05Dd2dRMDlTVTE5SVJVRkVSVkpUS1RzZ2NtVjBkWEp1SUhKbGN5NWxibVFvS1RzZ2ZRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuUjBWVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyaGxZV3gwYUNjcElIc0tJQ0FnSUhKbGMzUmhjblJKWmtGalkyOTFiblJEYUdGdVoyVmtLQ2s3SUM4dklPdXdsdXlYa095RW5DRHFzNFRzb0pYc25ZUWc2N0NVNnIrbzdKeTg2Nm0wSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRUlPdW92T3lnZ0NEcnNvVHJwckRyaTZRZ0tPeVZoT3VlbUNEc200enJzSTNzbDRYc25iUWc3SmliSU9xemhPeWdsZXljdk91aG5DRHJqNHpzcDRBZzdKV0s2cktNS1FvZ0lDQWdjbVYwY25sQmRYUm9TV1pPWldWa1pXUW9LVHNnTHk4ZzY2R2M2cmU0N0oyNElPMlZoT3lhbENEc2c0SHRnNXpycWJRZzdKNnM3Wm1WN0oyNElPeUxuT3VQaENEaWdKUWc3SjZzNjZHYzZyZTQ3SjI0N0oyMElPdUJuZXVDck95Y3ZPdXB0Q0RyaTZUc25Zd2c3S0d3N1pxTTY3YUE3WVN3SUhCeWIySnNaVzNzbmJRZzdaS0E2NmF3NjR1a0NpQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V3b2dJQ0FnSUNCdmF6b2dkSEoxWlN3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnl3Z2Rqb2dRbEpKUkVkRlgxWXNJR1JwY2pvZ1gxOWthWEp1WVcxbExDQXZMeUIyd3Jka2FYSTZJT3Exck91eWhPeWdoQy9zbDRucm1ySHRsWndnN0lLczY3TzQ3SjIwSU91V29DRHNub2pyaXBUc3A0QWc3S2VFNjR1bzdKcXBDaUFnSUNBZ0lHMXZaR1ZzT2lCamRYSnlaVzUwVFc5a1pXd3NJRzF2WkdWc2N6b2dRVXhNVDFkRlJGOU5UMFJGVEZNc0lHVjRZVzF3YkdWek9pQkZXRUZOVUV4RlV5NXNaVzVuZEdnc0lHZDFhV1JsT2lCSFZVbEVSUzVzWlc1bmRHZ3NJSEpsWVdSNU9pQjNZWEp0WldSVmNDd0tJQ0FnSUNBZ2NISnZZbXhsYlRvZ0tHTnNZWFZrWlZOMFlYUjFjeUE5UFQwZ0oyOXJKeUI4ZkNCamJHRjFaR1ZUZEdGMGRYTWdQVDA5SUc1MWJHd3BJRDhnYm5Wc2JDQTZJR05zWVhWa1pWTjBZWFIxY3l3S0lDQWdJQ0FnWVdOamIzVnVkRG9nWTJ4aGRXUmxRV05qYjNWdWRDZ3BMQW9nSUNBZ0lDQnpaWEoyWldRNklITjBZWFJ6TG5ObGNuWmxaQ3dnYkdGemRFRjBPaUJ6ZEdGMGN5NXNZWE4wUVhRc0lHeGhjM1JVWlhoME9pQnpkR0YwY3k1c1lYTjBWR1Y0ZEN3Z2JHRnpkRk5sWXpvZ2MzUmhkSE11YkdGemRGTmxZeXdLSUNBZ0lIMHBPd29nSUgwS0lDQXZMeUR0bEl6cm42enF0N2pzbmJnZzdJdXM3SjZsNjdDVjY0K1pJT0tBbENEcmdZcnF1TERycWJRZzdKeUVJT3F3a095TG5DRHRnNERzbmJUcnFManFzSUFnNjR1azY2YXM2Nlc4SU91QmlPdUxwQW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTlvWldGeWRHSmxZWFFuS1NCN0NpQWdJQ0JzWVhOMFFtVmhkQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTQjlLVHNLSUNCOUNpQWdMeThnNjZHYzZyZTQ3SjI0SU9LQWxDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1cvQ2ZuNkFnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdUNEdGxZVHNtcFJkd3JkYjhKK1VrVjBnNjdLRTdZcTg3SjIwSU8yWXVPeTJuTzJWbk91THBDNEtJQ0F2THlEcXVMRHJzN2dvNjdpTTY1Mjg3SnF3N0tDQUlPeW5nZTJXaVNrNklHQmpiR0YxWkdVZ1lYVjBhQ0JzYjJkcGJpQXRMV05zWVhWa1pXRnBZT3VsdkNEc2lLanNuWUFnN1pTRTY2R2M3SVM0N0lxazY2R2NJT3lMcE8yV2lTRGlnSlFnNjZtVTY0bTBJT3lYaHV5ZHRDRHFzNmZzbnFVZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95WHRPcXpvQ3dLSUNBdkx5QWdJR3h2WTJGc2FHOXpkQ0RzaUpqc2k2QWc3WStzN1lxNDY2R2NJT3F5c09xenZPdWx2Q0RzbnBEcmo1a2c3SWlZNjZDNTdaV2M2NHVrS095THBPeTRvVG9nN1plazY1T2M2NmFzN0lxazdKZVE3SVNjNjQrRUlPdTRqT3Vkdk95YXNPeWdnQ0RzbDdUcnByd2dLeUJNU1ZOVVJVNGc3Wm1WN0oyNExDQXlNREkyTFRBM0tTNEtJQ0F2THlBZ0lPMkVzT3V2dU91RWtPeWR0Q0R0bVpUcnFiVHNsNUFnN0tDRTdaaUFJT3lWaUNEcm5LenJpNlF1SU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianJwNHdnN1pXWTY2bTBJT3VCblM0S0lDQXZMeUR0ajdUcnNMRW83WVN3NjYrNDY0U1FLVG9nN0o2UTY0K1pJT3laaE91ampPcXdnQ0RycDRudG5vd2c3Wm1ZNnJLOUtPdTRqT3Vkdk95YXNPeWdnT3F3Z0NCc2IyTmhiR2h2YzNUc2w1QWc2NnE3SU91THYreVZoQ0RzdlpUcms1enFzSUFnNjdPMDdKMjA2NHFVSU9xeXZleWFzQ25zbDVEc2hKd0tJQ0F2THlBZ0lPdWhuT3EzdU95ZHVDRHJqSURxdUxBZzdLU1JJT3V5aE8yS3ZPeWRoQ0RybUpBZzY0aUU2NlcwNjZtMExDRHN2WlRyazV6cnBid2c2N2FaN0plczY0U2o3SjJFSU95SW1DRHNub2pyaXBRZzdZU3c2Nis0NjRTUUlPdXdxZXlMbmV5Y3ZPdWhuQ0Rzb0lUdG1aanRsWnpyaTZRdUNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyOXdaVzR0Ykc5bmFXNG5LU0I3Q2lBZ0lDQmpiMjV6ZENCaWIyUjVJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR052Ym5OMElITjNhWFJqYUUxdlpHVWdQU0FoSVNoaWIyUjVJQ1ltSUdKdlpIa3VjM2RwZEdOb1FXTmpiM1Z1ZENrN0lDOHZJT3F6aE95Z2xTRHNvSVR0bVpnZ1BTRHNpNXp0Z2F6cnByOGc3TEM5N0p5ODY2R2NJT3lYdE95V3RDRHFzNFRzb0pYc25ZUWc2ck9nNjZXOElPeUltQ0Rzbm9qcXNvd0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lDOHZJR05zWVhWa1plcXdnQ0RzbDRic25MenJxYlFnN0plczZyaXc3SVNjSU91Qml1dUtsT3VMcEM0Z2MyaGxiR3c2ZEhKMVpldWR2Q0JqYkdGMVpHWHFzSUFnN0plRzdKYTA2NCtFSU95RnVPeWRnQ0Rzb0pYc2c0RWc3SXVrN1phSjY0KzhDaUFnSUNBZ0lDOHZJSE53WVhkdTdKMllJQ2RsY25KdmNpZnFzSUFnN0pXSUlPdWNxT3F6b0N3ZzdKaUk3S0NFN0plVUlPcTN1T3VNZ091aG5DQnZhenAwY25WbDY2VzhJT3VQak91Z3BPeWtyT3VMcENEaWdKUUtJQ0FnSUNBZ0x5OGc3WlNNNjUrczZyZTQ3SjI0N0oyQUlDTHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA3SmVJN0phMDdKcVVJdXVkdk9xem9DRHRsWmpyaXBUcmpiQWc3SXVrN0tDYzY2R2M2NHFVSU95VmhPdXN0T3F5Zyt1UGhDRHNsWWdnNjV5bzY0cVVJT3lEZ2UyRG5PcXdnQ0Rya0pEcmk2UW83SXVrN0tDY0lPeUxvT3F6b0NrdUNpQWdJQ0FnSUdsbUlDaGpiR0YxWkdWVGRHRjBkWE1nUFQwOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljcElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNU3dnZXdvZ0lDQWdJQ0FnSUNBZ1pYSnliM0k2SUNmc25iUWdVRVBzbDVBZ1EyeGhkV1JsSUVOdlpHWHFzSUFnN0plRzdKYTA3SnFVSU9LQWxDRHRoTERycjdqcmhKRHNsNURzaEp3Z1kyeGhkV1JsSUMwdGRtVnljMmx2YmlEc25iUWc2NUNZNjRxVTdLZUFJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2hManNtcFF1Snl3S0lDQWdJQ0FnSUNBZ0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1Wnljc0NpQWdJQ0FnSUNBZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ0x5OGc3S2VFN1phSklPeWtrZXlkdU91TnNDRHJtSkFnNjRpTTY2Q0E2NHVrSU9LQWxDRHF1SWpyc0trb05qRHN0SWdnNjRLMEtTRHJpNlRzaTV3ZzY0aUU2Nlc0SU9xeHRDQWk3TEM5N0oyRUlPdUxxK3lWbU91THBDL3JxcnNnNjdTazY0dWtJdXlYa0NEcXNJRHF1WXpzbXJEcnI0RHJvWndnNjdpTTY1Mjg3SnF3N0tDQTY2R2NJT3llck95TG5PdVBoTzJWbk91THBDNEtJQ0FnSUNBZ0x5OGc3WldjN0xDNElPdVNwT3lYa091UGhDRHJtSkFnNjRpRTY2VzA2NHFVSU9xeHRDRHJ1SXpybmJ6c21yRHNvSURxc0lBZ2JHOWpZV3hvYjNOMElPeTluT3V3c2V5WGtDRHJxcnNnNjR1LzdKV0VJT3lla091UG1TRHNtWVRybzR6cXNJQWc3SldJSU91UW1PdUtsQ0R0bVpqcXNyM3NuYndnN0lpWUlPeWVpT3ljdk91TGlBb2dJQ0FnSUNBdkx5RHF0N2pybFl6cnA0d2c3TDJVNjVPYzY2VzhJT3UybWV5WHJPdUVvK3lkaENEc2lKZ2c3SjZJNjRxVUlPMkVzT3V2dU91RWtDRHJzS25zaTUzc25MenJvWndnN1krMDY3Q3g3WldjNjR1a0lDanJrWkFnNjdLSTdLZTRJTzJCdE91bXJleVhrQ0R0aExEcnI3anJoSkRzbmJRZzdZcUE3SmEwNjRLWTdKaWs2Nm0wSU91THVlMlpxZXlLcE91ZnZldUxwQ2t1Q2lBZ0lDQWdJR052Ym5OMElITjBZV3hsSUQwZ2JHOW5hVzVRY205aklDWW1JQ2hFWVhSbExtNXZkeWdwSUMwZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUGlBMk1EQXdNQ2s3Q2lBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJNZ0ppWWdjM1JoYkdVcElIc0tJQ0FnSUNBZ0lDQnJhV3hzVEc5bmFXNVFjbTlqS0NrN0NpQWdJQ0FnSUNBZ2FXWWdLQ0Z2Y0dWdVRHOW5hVzVVWlhKdGFXNWhiQ2dwS1NCN0NpQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNU3dnZXlCbGNuSnZjam9nSit5ZHRDQlBVK3lYa095RW9DRHNucERyajVuc25MenJvWndnNjZxN0lPeVh0T3lXdE95YWxDRGlnSlFnN1lTdzY2KzQ2NFNRN0plUTdJU2NJR05zWVhWa1pTRHNpNlR0bG9rZzdadUVJQzlzYjJkcGJpRHRsYlFnN0tPODdJUzQ3SnFVTGljZ2ZTazdDaUFnSUNBZ0lDQWdmUW9nSUNBZ0lDQWdJQzh2SU95ZG1PdVBoT3lnZ1NEc29vWHJvNHdvY21WaGMyOXVJT3luZ095Z2xTa2c0b0NVSU95bmhPMldpU0RzcEpFZzdZUzA3SjJFSUZORlUxTkpUMDVmUkVsRlJPdWhuQ0RyZ1ozcmdyVHJxYlFnN0o2UTY0K1pJT3llck95TG5PdVBoT3F3Z0NEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcnByRHJpNlFLSUNBZ0lDQWdJQ0JyYVd4c1VISnZZeWduNjZHYzZyZTQ3SjI0N0oyRUlPeW5oTzJXaWUyVm1PdUtsQ0RzcEpIc25iVHJuYndnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQ0RpZ0pRZzY2R2M2cmU0N0oyNElPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRuS1RzS0lDQWdJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd093b2dJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryb1p6cXQ3anNuYmdnN1krMDY3Q3hJT0tBbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJT3lnaE8yWm1DNG5LVHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2diVzlrWlRvZ0ozUmxjbTFwYm1Gc0p5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lDOHZJT3lWbnV5RW9DRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0N0oyMElPdU1nT3E0c0NEc3BKSHNuYlRycWJRZzdLQ1I2ck9nSU95RGlPdWhuQ0RzbDdEcmk2UWdLT3l3dmV5ZGhDRHJpNnZzbFpqcXNiRHJncGdnNjR1azdJdWNJT3VJaE91bHVDRHFzcjNzbXJBcENpQWdJQ0FnSUd4dloybHVVM1JoY25SbFpFRjBJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJQ0FnTHk4ZzZyT0U3S0NWSU95Z2hPMlptT3lkdE91cHRDRHNtckRycHF6cXNJQWc3SXVjN1lHczY2YS9JT3l3dmV5Y3ZPdWhuQ0RzbDdEcmk2UW83SnlFSUNmcXM0VHNvSlVnN0tDRTdabVk3SjJBSU95TG5PMkJyT3VtdnlEc3NMM3NuTHpyb1p3bklPeWp2T3lFblNrNkNpQWdJQ0FnSUM4dklDQWdRbEpQVjFORlVqMXVieTF2Y095Y3ZPdWhuQ0JEVEVuc25aZ2c2N2lNNjUyODdKcXc3S0NBSU95WHRPcTRzT3VsdkNEcnA0bnFzNkFzSUhOMFpHOTFkT3lYa0NEc3NJM3Rub2pyaXBRZ1ZWSk1JT3lnaE91c3VPeWRoQ0RzbnFIc2xZVHNoSndnN0pxdzY2YXM2ckNBSU95WHNPdUxwQzRLSUNBZ0lDQWdMeThnNjZlTTY2T01JT3llck91aG5PcTN1T3lkdUNodWIzSnRZV3dwN0oyQUlPcXdtZXlkZ0NEcXM0VHNvSlhzbmJUcm5id2c3SVM0N0lXWTdKMjBJT3VDcU95VmhDRHNub2pyaXBRZzZyS01JT3U1b091bHRPdUxwQ0RpaHBJZzZyRzA2NU9jNjZhczdLZUFJT3lWaXVxem9DQkRURW5xc0lBZzdLZUI3S0NSSU95WHNPdUxwQzRLSUNBZ0lDQWdZMjl1YzNRZ2NISnBkbUYwWlV4dloybHVJRDBnSVNGemQybDBZMmhOYjJSbE93b2dJQ0FnSUNCamIyNXpkQ0IwYUdselRHOW5hVzRnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3lkaGRYUm9KeXdnSjJ4dloybHVKeXdnSnkwdFkyeGhkV1JsWVdrblhTd2dld29nSUNBZ0lDQWdJSE5vWld4c09pQjBjblZsTEFvZ0lDQWdJQ0FnSUdWdWRqb2djSEpwZG1GMFpVeHZaMmx1SUQ4Z1QySnFaV04wTG1GemMybG5iaWg3ZlN3Z1EweEJWVVJGWDBWT1Zpd2dleUJDVWs5WFUwVlNPaUIzY21sMFpVNXZiM0JDY205M2MyVnlLQ2tnZlNrZ09pQkRURUZWUkVWZlJVNVdMQW9nSUNBZ0lDQWdJSE4wWkdsdk9pQndjbWwyWVhSbFRHOW5hVzRnUHlCYkoybG5ibTl5WlNjc0lDZHdhWEJsSnl3Z0ozQnBjR1VuWFNBNklDZHBaMjV2Y21VbkxBb2dJQ0FnSUNBZ0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbExBb2dJQ0FnSUNBZ0lHUmxkR0ZqYUdWa09pQndjbTlqWlhOekxuQnNZWFJtYjNKdElDRTlQU0FuZDJsdU16SW5MQ0F2THlCcmFXeHNURzluYVc1UWNtOWo3SjJZSU9xM3VPdWp1U0JyYVd4czdKcXBJQ2hyYVd4c1VISnZZK3F6dkNEcmo1bnNuYndnN1l5bzdZUzBLUW9nSUNBZ0lDQjlLVHNLSUNBZ0lDQWdiRzluYVc1UWNtOWpJRDBnZEdocGMweHZaMmx1T3dvZ0lDQWdJQ0JwWmlBb2NISnBkbUYwWlV4dloybHVLU0I3Q2lBZ0lDQWdJQ0FnYkdWMElHOTFkQ0E5SUNjbk93b2dJQ0FnSUNBZ0lHeGxkQ0J2Y0dWdVpXUWdQU0JtWVd4elpUc0tJQ0FnSUNBZ0lDQmpiMjV6ZENCelkyRnVJRDBnS0dOb2RXNXJLU0E5UGlCN0NpQWdJQ0FnSUNBZ0lDQnBaaUFvYjNCbGJtVmtLU0J5WlhSMWNtNDdDaUFnSUNBZ0lDQWdJQ0J2ZFhRZ0t6MGdZMmgxYm1zdWRHOVRkSEpwYm1jb0tUc0tJQ0FnSUNBZ0lDQWdJR052Ym5OMElHMGdQU0J2ZFhRdWJXRjBZMmdvTDJoMGRIQnpPbHd2WEM5Y1V5cGNMMjloZFhSb1hDOWhkWFJvYjNKcGVtVmNQMXhUS3k4cE93b2dJQ0FnSUNBZ0lDQWdhV1lnS0NGdEtTQnlaWFIxY200N0NpQWdJQ0FnSUNBZ0lDQnZjR1Z1WldRZ1BTQjBjblZsT3dvZ0lDQWdJQ0FnSUNBZ0x5OGc2NEdkN0plUUlPdTJtZXlkZ0NEcmxMRHNtTFR0a1p6Q3QrcTBoTzJZdU91bG1PdW5qQ0RybHJ6c2xyVHJncmpyaTZRZ0tGVlNUQ0RzbnBEc3NyVHNsNVFnN0pXSUlPeVRzT3lkdE91S2xDRHJyTGpzbnBEcms2UXBDaUFnSUNBZ0lDQWdJQ0JqYjI1emRDQjFjbXdnUFNCdFd6QmRMbkpsY0d4aFkyVW9MMXNpSnp3K0tWeGRYU3NrTHl3Z0p5Y3BPd29nSUNBZ0lDQWdJQ0FnYVdZZ0tDRnZjR1Z1VUhKcGRtRjBaVmRwYm1SdmR5aDFjbXdwSUNZbUlDRnZjR1Z1UkdWbVlYVnNkRUp5YjNkelpYSW9kWEpzS1NrZ2V3b2dJQ0FnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95ZGhDRHJxcnNnN0plMDdKZUk3SmEwN0pxVUlPS0FsQ0RzbmJRZzdLTzg3SWFNNjZHY0lPeW5nZXlna1NEcm9aenF0N2pzbmJqdGxiUWc3S084N0lTNDdKcVVPaUFuSUNzZ2RYSnNLVHNLSUNBZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnSUNCOU93b2dJQ0FnSUNBZ0lIUm9hWE5NYjJkcGJpNXpkR1J2ZFhRdWIyNG9KMlJoZEdFbkxDQnpZMkZ1S1RzS0lDQWdJQ0FnSUNCMGFHbHpURzluYVc0dWMzUmtaWEp5TG05dUtDZGtZWFJoSnl3Z2MyTmhiaWs3Q2lBZ0lDQWdJQ0FnTHk4Z1ZWSk03SjIwSU95VmlDRHNucUh0bm9qcnFiUW83TGFjNjZDbElPMllsZXlMbmV5ZHRDRHJzSlRyZ0pBZzY1T3hLU0RzbFlUcnJMUWc3TEM5NjQrRUlPeVZpQ0Rybkt3ZzdMR0VJT3VuaWUyZWpPdUxwQ0RpZ0pRZ1FsSlBWMU5GVXV1bHZDQnVieTF2Y095Y3ZPdWhuQ0RycDRuc2xZUWc2NUtBNnJpd0lPdVZqT3VzdUM0S0lDQWdJQ0FnSUNBdkx5RHF0N2dnNnJLOTdKcXdJTzJWbkNEcnNvanJwNHdnN0ppYklPdXdxZXlMblNoRFRFbnFzSUFnN0tlQjdLQ1JJT3lYdE9xNHNDbnNuTHpyb1p3ZzY0dWs3SXVjSU95TG5PdVBoTzJWbk91THBDNEtJQ0FnSUNBZ0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIc0tJQ0FnSUNBZ0lDQWdJR2xtSUNodmNHVnVaV1FnZkh3Z2JHOW5hVzVRY205aklDRTlQU0IwYUdselRHOW5hVzRwSUhKbGRIVnlianNLSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25iZ2dWVkpNN0oyRUlPdXF1eURzc0w3c2xaanNsclRzbXBRZzRvQ1VJRU5NU2Vxd2dDRHNwNEhzb0pFZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95WHJPdUtsQ0Ryc0tuc2k1M3NuTHpyb1p3ZzY0dWs3SXVjSU95TG5PdVBoTzJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJQ0FnSUNBZ0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzS0lDQWdJQ0FnSUNBZ0lHTnZibk4wSUhKbGRISjVJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuWVhWMGFDY3NJQ2RzYjJkcGJpY3NJQ2N0TFdOc1lYVmtaV0ZwSjEwc0lIc0tJQ0FnSUNBZ0lDQWdJQ0FnYzJobGJHdzZJSFJ5ZFdVc0lHVnVkam9nUTB4QlZVUkZYMFZPVml3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlN3S0lDQWdJQ0FnSUNBZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzQ2lBZ0lDQWdJQ0FnSUNCOUtUc0tJQ0FnSUNBZ0lDQWdJR3h2WjJsdVVISnZZeUE5SUhKbGRISjVPd29nSUNBZ0lDQWdJQ0FnY21WMGNua3ViMjRvSjJWeWNtOXlKeXdnS0NrZ1BUNGdleUJwWmlBb2JHOW5hVzVRY205aklEMDlQU0J5WlhSeWVTa2diRzluYVc1UWNtOWpJRDBnYm5Wc2JEc2dmU2s3Q2lBZ0lDQWdJQ0FnSUNCeVpYUnllUzV2YmlnblkyeHZjMlVuTENBb0tTQTlQaUI3SUdsbUlDaHNiMmRwYmxCeWIyTWdQVDA5SUhKbGRISjVLU0I3SUd4dloybHVVSEp2WXlBOUlHNTFiR3c3SUdGalkyOTFiblJEWVdOb1pTNWhkQ0E5SURBN0lIMGdmU2s3Q2lBZ0lDQWdJQ0FnZlN3Z01UVXdNREFwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJSFJvYVhOTWIyZHBiaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdsbUlDaHNiMmRwYmxCeWIyTWdQVDA5SUhSb2FYTk1iMmRwYmlrZ2JHOW5hVzVRY205aklEMGdiblZzYkRzZ2ZTazdDaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdJVDA5SUhSb2FYTk1iMmRwYmlrZ2NtVjBkWEp1T3dvZ0lDQWdJQ0FnSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnYVdZZ0tHeHZaMmx1VUhKdlkxUnBiV1Z5S1NCN0lHTnNaV0Z5VkdsdFpXOTFkQ2hzYjJkcGJsQnliMk5VYVcxbGNpazdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdiblZzYkRzZ2ZRb2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQzh2SU95RGlDRHFzNFRzb0pYc25id2c3SWlZSU95ZWlPeWN2T3VMaUNEcmk2VHNuWXdnTDJobFlXeDBhQ0RybFl3ZzY0dWs3SXVjSU95ZHZlcTRzQW9nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJT3lnaU95d3FDRHNvb1hybzR3Z0tHTnZaR1VnSnlBcklHTnZaR1VnS3lBbktTY3BPd29nSUNBZ0lDQWdJQzh2SU95Q3JPdWVqT3lkdENEcm9aenF0N2pzbmJqdGxhQWc3SXVjNnJDRTY0K0VJT3lYaHV5ZHRDRHFzNmZyc0pUcm9ad2c3SXVrN1l5bzY2R2NJT3VCbmV1Q3JPdUxwQ0E5SUdOc1lYVmtaZXF3Z0NEc2w0YnFzYkRyZ3BnZzdJdWs3WmFKN0oyMElPeVZpQ0Rya0p3ZzZyS0RMZ29nSUNBZ0lDQWdJQzh2SU95ZGtldUx0ZXlkZ0NEc25iVHJyN2dnNjdPMDY0T0k3Snk4NjR1SUlPeURnZTJEbk91bHZDRHJpNlRzaTV3ZzdKNnM3SVNjSUM5b1pXRnNkR2pyb1p3ZzdKV002NmF3NjR1a0lDanRsSXpybjZ6cXQ3anNuYmpzbmJRZzY0eUE2cml3SU8yWmxPdXB0T3lkaENEc2k2VHRqS2pyb1p3ZzY3Q1U2cjY4NjR1a0tTNEtJQ0FnSUNBZ0lDQnBaaUFvWTI5a1pTQWhQVDBnTUNBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQQ0ExTURBd0tTQjdDaUFnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNDdKMjBJT3ltaWV5TG5DRHNpNlR0aktqcm9ad2c2NEdkNjRLb0lPS0FsQ0JEYkdGMVpHVWdRMjlrWlNEc2hLVHN1WmdnN0lPQjdZT2M2Nlc4SU91THBPeUxuQ0Rzb0pEcXNvRHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJQ0FnSUNCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BPd29nSUNBZ0lDQWdJSDBLSUNBZ0lDQWdmU2s3Q2lBZ0lDQWdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZ01URHJ0b1FnNnJLOTZyTzhJT0tBbENEcmpJRHF1TEFnN1pTRTY2R2M3SVM0N0lxa0lPeWdsZXVtckM0bktUc2dhMmxzYkV4dloybHVVSEp2WXlncE95QjlMQ0EyTURBd01EQXBPd29nSUNBZ0lDQXZMeURyZ3FIc25ZQWc3SjZGN0o2bDZyYU03SjJFSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NHlBNnJpd0lPeUV1T3lGbU95ZGdDRHJzb1RycHJEcmk2UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzZzRnZzdJUzQ3SVdZS095RGlDRHNub1hzbnFYcXRvd3A3Snk4NjZHY0lPeUxuT3lla2UyVm1PcXlqQzRLSUNBZ0lDQWdMeThnN0oyWTY0K0U3S0NCSU95aWhldWpqQ2h5WldGemIyNGc3S2VBN0tDVktTRGlnSlFnVTBWVFUwbFBUbDlFU1VWRTY2R2NJT3VCbmV1Q3RPdXB0Q0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91Z3BBb2dJQ0FnSUNBdkx5RHNucXpyb1p6cXQ3anNuYmdnNjVLazdKZVE2NCtFSUUxQldGOVVWVkpPVStxNWpPeW5nQ0RzbUpzZzZyT0U3S0NWN0p5ODY2R2NJT3l5bU91bXJPdVFtT3VLbENEcnNvVHF0N2pxc0lBZzY1Q2M2NHVrSUNneU1ESTJMVEEzSU91bXJPdTNzT3lYa095RW5DRHRtWlhzbmJncENpQWdJQ0FnSUd0cGJHeFFjbTlqS0Nmcm9aenF0N2pzbmJqc25ZUWc3S2VFN1phSjdaV1k2NHFVSU95a2tleWR0T3VkdkNEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJvWnpxdDdqc25iZ2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcE93b2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd093b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVuSUNzZ0tITjNhWFJqYUUxdlpHVWdQeUFuSUNqcXM0VHNvSlVnN0tDRTdabVlJT0tBbENEc2k1enRnYXpycHI4ZzdMQzk3Snk4NjZHY0lPeVh0T3lXdENEcm9aenF0N2pzbmJnZzdabVU2Nm0wNjdhQTdZU3dJT3V6dE95WHJPeWtqZXVMaU91THBDa25JRG9nSnljcElDc2dKeURpZ0pRZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95ZWtPdVBtU0RzbDdEcXNyRHJrS25yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQnRiMlJsT2lCemQybDBZMmhOYjJSbElEOGdKMkp5YjNkelpYSXRjM2RwZEdOb0p5QTZJQ2RpY205M2MyVnlKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2daWEp5YjNJNklDZnJvWnpxdDdqc25iZ2c3TEM5N0oyRUlPdXF1eURzbDdUc2w0anNsclRzbXBRNklDY2dLeUJsTG0xbGMzTmhaMlVnZlNrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SUNqdGhMRHJyN2pyaEpBZzdZKzA2N0N4SU9xMXJPMlloT3UyZ0NEaWdKUWc2N2lNNjUyODdKcXc3S0NBSU95ZWtPdVBtU0RzbVlUcm80enFzSUFnN0pXSUlPdVFtT3VLbENEdG1aanFzcjBnN0tDRTdKcXBLUW9nSUdaMWJtTjBhVzl1SUc5d1pXNU1iMmRwYmxSbGNtMXBibUZzS0NrZ2V3b2dJQ0FnZXdvZ0lDQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ0lDQWdJQzh2SUhOMFlYSjA2ckNBSU95RGlDRHN2WmpzaHBRZzdMQzk3SjJFSU91bmpPdVRvT3VMcENBbzY0dWs2NmFzN0oyWUlPeUlxT3lkZ0NEc3ZaanNocFRxczd3ZzY2eTA2clNBN1pXWTZyS01JT3lDck95YXFleWVrT3lYa09xeWpDRHJzN1Rzbm9RcExnb2dJQ0FnSUNBZ0lDOHZJT3lkdE95V3RPeUVuQ0JRYjNkbGNsTm9aV3hzS0M1d2N6RXA3SjIwSURYc3RJZ2c2NUtrSU9xM3VDRHNzTDNzbDVBZzdKZVU3WVN3NjZXOElPdXp0T3VDdENBeDY3S0lLT3Exck91UGhTRHFzNFRzb0pVcDdKMkVJT3lla091UG1TRHNoS0R0ZzUzdGxaanFzNkFzQ2lBZ0lDQWdJQ0FnTHk4ZzdMQzk3SjJFSU95MW5PeUdqTzJabE8yVnRDRHNncXpzbXFuc25wQWc2NGlJN0plVUlPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmpycDR3ZzY0S282cktNSU8yVm5PdUxwQzRnN0xDOTdKMkVJT3VxdXlEc3NMN3NuTHpycWJRZzdKV0U2NnkwNnJLRDY0K0VJT3lWaUNEdGxaenJpNlFLSUNBZ0lDQWdJQ0F2THlBbzY0dWs2Nlc0SU95d3ZTRHNtS1Rzbm9Ycm9LVWc2N0NwN0tlQUlPS0FsQ0RxdDdnZzZySzk3SnF3SU91cGxPdUp0T3F3Z0NEcnM3VHNuYlRyaXBRZzdMR0U2NkdjSU91Q3FPcXpvQ0RzZ3F6c21xbnNucERxc0lBZzdKZVU3WVN3SU8yVm5DRHJzb2dnNjRpRTY2VzA2Nm0wSU91UXFDa3VDaUFnSUNBZ0lDQWdMeThnN0tPODdKMllPaUJqYkdGMVpHWHFzSUFnN0wyWTdJYVVJT3lnbk91cXFleWRoQ0Ryc0pUcXZyanJxYlFnUVhCd1FXTjBhWFpoZEdVdlJtbHVaRmRwYm1SdmQrcXdnQ0RycXJzZzdMQys3SjJFSU95SW1DRHNub2pzbll3ZzRvQ1VJT3ljaU91UGhPeWFzQ0RzaTZUcXVMRHNsNURzaEp3ZzdabVY3SjI0SU8yVmhPeWFsQzRLSUNBZ0lDQWdJQ0JqYjI1emRDQndjekVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExXeHZaMmx1TG5Cek1TY3BPd29nSUNBZ0lDQWdJR1p6TG5keWFYUmxSbWxzWlZONWJtTW9jSE14TENCYkNpQWdJQ0FnSUNBZ0lDQW5VM1JoY25RdFUyeGxaWEFnTFZObFkyOXVaSE1nTlNjc0NpQWdJQ0FnSUNBZ0lDQW5KSGR6SUQwZ1RtVjNMVTlpYW1WamRDQXRRMjl0VDJKcVpXTjBJRmRUWTNKcGNIUXVVMmhsYkd3bkxBb2dJQ0FnSUNBZ0lDQWdJbWxtSUNna2QzTXVRWEJ3UVdOMGFYWmhkR1VvSjJOc1lYVmtaUzFzYjJkcGJpY3BLU0I3SWl3S0lDQWdJQ0FnSUNBZ0lDSWdJQ1IzY3k1VFpXNWtTMlY1Y3lnbmZpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lGTjBZWEowTFZOc1pXVndJQzFUWldOdmJtUnpJREluTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdRV1JrTFZSNWNHVWdMVTVoYldWemNHRmpaU0JWSUMxT1lXMWxJRmNnTFUxbGJXSmxja1JsWm1sdWFYUnBiMjRnSjF0RWJHeEpiWEJ2Y25Rb1hDSjFjMlZ5TXpJdVpHeHNYQ0lwWFNCd2RXSnNhV01nYzNSaGRHbGpJR1Y0ZEdWeWJpQlRlWE4wWlcwdVNXNTBVSFJ5SUVacGJtUlhhVzVrYjNjb2MzUnlhVzVuSUdNc0lITjBjbWx1WnlCMEtUc2dXMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUdKdmIyd2dVMmh2ZDFkcGJtUnZkeWhUZVhOMFpXMHVTVzUwVUhSeUlHZ3NJR2x1ZENCdUtUc25JaXdLSUNBZ0lDQWdJQ0FnSUNJZ0lDUm9JRDBnVzFVdVYxMDZPa1pwYm1SWGFXNWtiM2NvVzA1MWJHeFRkSEpwYm1kZE9qcFdZV3gxWlN3Z0oyTnNZWFZrWlMxc2IyZHBiaWNwSWl3S0lDQWdJQ0FnSUNBZ0lDY2dJR2xtSUNna2FDQXRibVVnVzFONWMzUmxiUzVKYm5SUWRISmRPanBhWlhKdktTQjdJRnQyYjJsa1hWdFZMbGRkT2pwVGFHOTNWMmx1Wkc5M0tDUm9MQ0EyS1NCOUp5d2dMeThnTmlBOUlGTlhYMDFKVGtsTlNWcEZDaUFnSUNBZ0lDQWdJQ0FuZlNjc0NpQWdJQ0FnSUNBZ1hTNXFiMmx1S0NkY2NseHVKeWtnS3lBblhISmNiaWNwT3dvZ0lDQWdJQ0FnSUdOdmJuTjBJR0poZENBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRiRzluYVc0dVltRjBKeWs3Q2lBZ0lDQWdJQ0FnWm5NdWQzSnBkR1ZHYVd4bFUzbHVZeWhpWVhRc0lDZEFaV05vYnlCdlptWmNjbHh1SnlBckNpQWdJQ0FnSUNBZ0lDQW5jM1JoY25RZ0ltTnNZWFZrWlMxc2IyZHBiaUlnWTIxa0lDOXJJR05zWVhWa1pTQXZiRzluYVc1Y2NseHVKeUFyQ2lBZ0lDQWdJQ0FnSUNBbmNHOTNaWEp6YUdWc2JDQXRUbTlRY205bWFXeGxJQzFGZUdWamRYUnBiMjVRYjJ4cFkza2dRbmx3WVhOeklDMUdhV3hsSUNJbklDc2djSE14SUNzZ0p5SmNjbHh1SnlrN0NpQWdJQ0FnSUNBZ2MzQmhkMjRvSjJOdFpDY3NJRnNuTDJNbkxDQmlZWFJkTENCN0lHVnVkam9nUTB4QlZVUkZYMFZPVml3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc0tJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXdvZ0lDQWdJQ0FnSUM4dklIQjBlU2hsZUhCbFkzUXA2NkdjSU91enRPdUN1Q0R0Z3FUc2w1QWc3WUcwNjZHYzY1T2NJRlJWU2Vxd2dDRHJyTFRyc0pqc25aSHNuYmdnNnJLRDdKMjBJT3lMcE95NG9TRHRtWlhzbmJqcmtLZ29NakF5Tmkwd055d2c3SjI4NjdDWUlGeHl3cmRyYVhSMGVTRHN2WlRyazV3ZzY2cW82NUdRS1NEaWdKUUtJQ0FnSUNBZ0lDQXZMeURzbktEc25ienRsWndnN0o2UTY0K1o3Wm1VSU9xeXZldWhuT3VLbENCVGVYTjBaVzBnUlhabGJuUno3SjJZSU95bmhPeW5uQ0R0Z3FRZzdKNkY2NkNsTGlEc29KSHF0N3pzaExFZzZyYU03WldjN0oyMElPeWVpT3ljdk91cHRDQTI3TFNJSU91U3BDRHNsNVR0aExEcXNJQWc3SjZRNjQrWklPeWVoZXVncGV1UHZBb2dJQ0FnSUNBZ0lDOHZJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbmJRZzdJU2c3WU9kNjVDWTZyT2dMQ0RxdG96dGxaenNuYlFnN0plRzdKeTg2Nm0wSUd0bGVYTjBjbTlyWlNEc3BJVHJwNHdnN0tHdzdKcXA3WjZJSU95THBPMk1xTzJWdENEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFuT3VMcENobVlXbHNMWE52Wm5RcExnb2dJQ0FnSUNBZ0lDOHZJT3lYbE8yRXNDRHNwNEhzb0lUc2w1QWdWR1Z5YldsdVlXenNuWVFnNjR1azdJdWNJT3lWbnV5Y3ZPdWhuQ0Rxc0lEc29ManNtWUFnNjR1azY2VzRJT3lWc2V5WGtDRHRncVRxc0lBZzY1T2s3SmEwNnJDQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaUFnSUNBZ0lDQWdjM0JoZDI0b0oyOXpZWE5qY21sd2RDY3NJRnNLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWhiQ0lnZEc4Z1pHOGdjMk55YVhCMElDSmpiR0YxWkdVZ0wyeHZaMmx1SWljc0NpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBbmRHVnNiQ0JoY0hCc2FXTmhkR2x2YmlBaVZHVnliV2x1WVd3aUlIUnZJR0ZqZEdsMllYUmxKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2RrWld4aGVTQTJKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWhiQ0lnZEc4Z1lXTjBhWFpoZEdVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURBdU15Y3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlVM2x6ZEdWdElFVjJaVzUwY3lJZ2RHOGdhMlY1YzNSeWIydGxJSEpsZEhWeWJpY3NDaUFnSUNBZ0lDQWdJQ0F2THlEc2w1VHRoTERxc0lBZzdJdWs3S0NjNjZHY0lPdVRwT3lXdE9xd2hDRHFzcjNzbXJEc2w1RHJwNHdnN0plczZyaXdJT3VQaE91THJDanF0b3p0bFp3ZzdKZUc3Snk4NjZtMElPeWNoT3lYa095RW5DRHNwSkhyaTZncElPS0FsQ0R0aExEcnI3anJoSkRzbllRZzdMbVk3SnVNSU91NGpPdWR2T3lhc095Z2dPdW5qQ0RyZ3FqcXVMVHJpNlFLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2RrWld4aGVTQXhMalVuTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QnpaWFFnYldsdWFXRjBkWEpwZW1Wa0lHOW1JR1p5YjI1MElIZHBibVJ2ZHlCMGJ5QjBjblZsSnl3S0lDQWdJQ0FnSUNCZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNLSUNBZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z1ptRnNjMlU3SUM4dklPeW5nT3lia0NEc2xZZ2c3WldZNjRxVUlFOVRDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2NtVjBkWEp1SUhSeWRXVTdDaUFnSUNCOUNpQWdmUW9nSUM4dklPMkJ0T3Vobk91VG5DRHFzNFRzb0pVZzY2R2M2cmU0N0pXRTdKdURJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3Wm1JN0oyWUlGdnJvWnpxdDdqc2xZVHNtNE5kSU91eWhPMkt2T3lkdENEdG1ManN0cHd1SUdOc1lYVmtaU0JoZFhSb0lHeHZaMjkxZE95Y3ZPdWhuQ0JEVEVrZzY2R2M2cmU0N0oyNDdKMkVJTzJWdE95Z25PMlZuT3VMcEM0S0lDQXZMeUFvN0oyMElGQkQ3SjJZSU95Z2dPeWVwZXVRbkNEc25wRHFzcW5zcHAzcnFvWHNuWVFnN0tlQTdKcTA2NHVrSU9LQWxDRHJpNlRzaTV3ZzdKT3c2NkNrNjZtMElPeWVyT3Vobk9xM3VPeWR1Q0R0bFlUc21wUXVLU0Ryb1p6cXQ3anNsWVRzbTRNZzdadUU3SmVVSU95RXVPeUZtTUszNnJPRTdLQ1Y3THFRN0l1YzY2VzhJT3lnbGV1bXJPMlZuT3VMcEM0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdlkyeGhkV1JsTFd4dloyOTFkQ2NwSUhzS0lDQWdJR052Ym5OMElHeHZJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuWVhWMGFDY3NJQ2RzYjJkdmRYUW5YU3dnZXlCemFHVnNiRG9nZEhKMVpTd2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNLSUNBZ0lHeGxkQ0JsY25JZ1BTQW5KenNLSUNBZ0lHeHZMbk4wWkdWeWNpNXZiaWduWkdGMFlTY3NJQ2hrS1NBOVBpQjdJR1Z5Y2lBclBTQmtMblJ2VTNSeWFXNW5LQ2s3SUgwcE93b2dJQ0FnYkc4dWIyNG9KMlZ5Y205eUp5d2dLR1VwSUQwK0lIc2dhbk52YmloeVpYTXNJRFV3TUN3Z2V5QnZhem9nWm1Gc2MyVXNJR1Z5Y205eU9pQW42NkdjNnJlNDdKV0U3SnVESU95THBPMldpU0RzaTZUdGpLZzZJQ2NnS3lCbExtMWxjM05oWjJVZ2ZTazdJSDBwT3dvZ0lDQWdiRzh1YjI0b0oyTnNiM05sSnl3Z0tHTnZaR1VwSUQwK0lIc0tJQ0FnSUNBZ2EybHNiRkJ5YjJNb0ordWhuT3EzdU95VmhPeWJnKzJWdE95RW5DRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bzdaYUk3SmEwN0pxVUxpY3BPeUF2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NSU9LQWxDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lFdU95Rm1PeWRoQ0Rya0pqc2dyVHJwcXpycWJRZzdKV0lJT3VRcUFvZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQU0F3T3lBZ0lDQWdJQ0FnTHk4ZzY0dWs3SjJNSUM5aFkyTnZkVzUwd3JjdmFHVmhiSFJvN0plUTdJU2NJT3F6aE95Z2xleWRoQ0RzZzRqcm9ad29QZXlYaHV5ZGpPeWN2T3VobkNrZzdKMjk2cktNQ2lBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlHNTFiR3c3SUNBZ0lDQWdJQ0F2THlEc2c0SHRnNXdnN0o2czdZeVE3S0NWS091THBPeWRqQ0R0aExUc2w1RHNoSndnNjYrNDY2R2M2cmU0N0oyNElPcXdrT3luZ0NrS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc2xZVHNtNE1nS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93b2dJQ0FnSUNCcFppQW9jbVZ6TG1obFlXUmxjbk5UWlc1MEtTQnlaWFIxY200N0lDOHZJR1Z5Y205eUlPMlZ1T3VUcE91ZnJPcXdnQ0RzbmJUcnI3Z2c3SjJSNjR1MTdaYUk3Snk4NjZtMElPeWtrZXV6dFNEcnNLbnNwNEFLSUNBZ0lDQWdhV1lnS0dOdlpHVWdQVDA5SURBcElHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdDaUFnSUNBZ0lHVnNjMlVnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUdWeWNtOXlPaUFvWlhKeUxuUnlhVzBvS1M1emJHbGpaU2d3TENBeE5UQXBLU0I4ZkNBb0oreWloZXVqakNEc3ZaVHJrNXdnSnlBcklHTnZaR1VwSUgwcE93b2dJQ0FnZlNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lDOHZJT3lla09xNHNDRHNvb1hybzR3ZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNCVFZFOVFYMEpTU1VSSFJTL3RsWmp0aXJqcnVZVHRpcmpxc0lBZzdaaTQ3TGFjN1pXYzY0dWtJQ2pyb1p6c3U2enNsNURzaEp6cnA0d2c3S0NSNnJlOElPcXdnT3VLcGUyVm1PdUxpQ0RzbFlqc29JUXBDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM05vZFhSa2IzZHVKeWtnZXdvZ0lDQWdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTQjlLVHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb29Ycm80d2c3SnFVN0xLdElPdXdtK3lkakNEaWdKUWc2NHVrNjZhczY2VzhJT3VCbGV1TGlPdUxwQzRuS1RzS0lDQWdJSE5vZFhSMGFXNW5SRzkzYmlBOUlIUnlkV1U3Q2lBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdDaUFnSUNCeVpYUjFjbTQ3Q2lBZ2ZRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXlaV052YlcxbGJtUW5LU0I3Q2lBZ0lDQmpiMjV6ZENCN0lIUmxlSFFzSUcxdlpHVnNMQ0J5YjJ4bElIMGdQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3dvZ0lDQWdhV1lnS0NGMFpYaDBJSHg4SUNGVGRISnBibWNvZEdWNGRDa3VkSEpwYlNncEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdNQ3dnZXlCbGNuSnZjam9nSit5MmxPeXluT3V3bSt5ZGhDRHJyTGpxdGF6cXNJQWc2N21FN0phMElPeWVpT3lLdGV1TGlPdUxwQzRuSUgwcE93b2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0xhVTdMS2NJT3lhbE95eXJUb25MQ0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z05UQXBMbkpsY0d4aFkyVW9MMXh1TDJjc0lDY2dKeWtnS3lBbjRvQ21KeXdnY205c1pTQS9JQ2RiSnlBcklISnZiR1VnS3lBblhTY2dPaUFuSnl3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NpQTlJR0YzWVdsMElHRnphME5zWVhWa1pTaFRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BMQ0J0YjJSbGJDd2dleUJ3WVhKelpUb2djR0Z5YzJWVGRXZG5aWE4wYVc5dWN5d2dabTl5YldGMFJHVnpZem9nSjF0N0luUmxlSFFpT2lBaTY2eTQ2cldzSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBaWZTd2dMaTR1WFNjZ2ZTd2djbTlzWlNrN0NpQWdJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ2NpNXdZWEp6WldRZ2ZId2dXMTA3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c2xZZ2dKeUFySUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBcklDZnFzSndnS0NjZ0t5QnpaV01nS3lBbmN5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVkdWNGRDQTlJRk4wY21sdVp5aDBaWGgwS1M1emJHbGpaU2d3TENBek1DazdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhOMVoyZGxjM1JwYjI1ekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lDZnRnYlRyb1p6cms1d2c3Wmk0N0xhY0lPeUxwTzJNcURvZ0p5a3BPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5RHRsSVRyb0lqc25vVHJzNFFnN0xhVTdMS2NJT0tBbENEdGxad2c3Wm1VNjZtMDdKMkVJTzJWbU95Y2hDRHRsSVRyb0lqc25vUW83SmlCN0pldEtTRHJpNmpzbklUcm9ad2c2NEtZNjRpZ0lPdXdtK3F6b0N3ZzdKaUI3SmV0NjZlSTY0dWtJT3VVc091aG5DRHJqSURzbFlqc25ZUWc2NEs0NjR1a0xnb2dJQzh2SU95WWdleVhyU0RzaUpqcnA0enRnYndnN0pxVTdMS3Q3SjJFSU95cXZPcXduT3luZ0NEc2xZcnJpcFFnNnJLRDdKMjBJTzJWdGV5THJDQW82NHFRNjZDazdLZUE2ck9nSU95Q3JPeWFxZXVmaWV1UGhDRHF0N2pycDR6dGdid2c2NEtZNnJDRTY0dWtLUzRLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2Y21WamIyMXRaVzVrTFdkeWIzVndjeWNwSUhzS0lDQWdJR052Ym5OMElIc2daM0p2ZFhCekxDQnRiMlJsYkN3Z2JXOXlaU0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0dkeWIzVndjeWtLSUNBZ0lDQWdQeUJuY205MWNITUtJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tHY3BJRDArSUNoN0NpQWdJQ0FnSUNBZ0lDQWdJRzVoYldVNklGTjBjbWx1Wnlnb1p5QW1KaUJuTG01aGJXVXBJSHg4SUNjbktTNTBjbWx0S0Nrc0NpQWdJQ0FnSUNBZ0lDQWdJSFJsZUhSek9pQW9aeUFtSmlCQmNuSmhlUzVwYzBGeWNtRjVLR2N1ZEdWNGRITXBJRDhnWnk1MFpYaDBjeUE2SUZ0ZEtTNXRZWEFvS0hRcElEMCtJRk4wY21sdVp5aDBJSHg4SUNjbktTNTBjbWx0S0NrcExtWnBiSFJsY2loQ2IyOXNaV0Z1S1N3S0lDQWdJQ0FnSUNBZ0lDQWdjbTlzWlRvZ0tHY2dKaVlnWnk1eWIyeGxLU0EvSUZOMGNtbHVaeWhuTG5KdmJHVXBJRG9nZFc1a1pXWnBibVZrTEFvZ0lDQWdJQ0FnSUNBZ2ZTa3BDaUFnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2huS1NBOVBpQm5MblJsZUhSekxteGxibWQwYUNrS0lDQWdJQ0FnT2lCYlhUc0tJQ0FnSUdsbUlDaHNhWE4wTG14bGJtZDBhQ0E4SURJcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuN0ppQjdKZXQ3SjIwSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRuSUgwcE93b2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1pTRTY2Q0k3SjZFNjdPRUlPeTJsT3l5bkNEc21wVHNzcTA2SU95WWdleVhyU0FuSUNzZ2JHbHpkQzVzWlc1bmRHZ2dLeUFuNnJDY0p5QXJJQ2h0YjNKbElEOGdKeUFvNjQyVUlPdXdtK3E0c0NrbklEb2dKeWNwTENCdGIyUmxiQ0EvSUNjbzY2cW82NDI0T2lBbklDc2diVzlrWld3Z0t5QW5LU2NnT2lBbkp5azdDaUFnSUNCMGNua2dld29nSUNBZ0lDQmpiMjV6ZENCeUlEMGdZWGRoYVhRZ1lYTnJSM0p2ZFhCektHeHBjM1FzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpVZHliM1Z3Y3l3Z1ptOXliV0YwUkdWell6b2dKM3NpWjNKdmRYQnpJam9nVzNzaWJtRnRaU0k2SUNMc21JSHNsNjBnN0oyMDY2YUVJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyaklEc2xZZ2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0o5WFgxZGZTY2dmU3dnSVNGdGIzSmxLVHNLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY2k1d1lYSnpaV1E3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGdmRYUXBJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJVHJvSWpzbm9UcnM0UWc3S0NjN0pXSUlDY2dLeUJ2ZFhRdWNtVmtkV05sS0NodUxDQm5LU0E5UGlCdUlDc2daeTV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dzSURBcElDc2dKK3F3bkNBdklPeVlnZXlYclNBbklDc2diM1YwTG14bGJtZDBhQ0FySUNmcXNKd2dLQ2NnS3lCelpXTWdLeUFuY3lrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlDZGI3WlNFNjZDSTdKNkU2N09FWFNBbklDc2dVM1J5YVc1bktDaHNhWE4wV3pCZElDWW1JR3hwYzNSYk1GMHVkR1Y0ZEhOYk1GMHBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlOQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHZHliM1Z3Y3pvZ2IzVjBMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU0U2NkNJN0o2RTY3T0VJT3kybE95eW5DRHNpNlR0aktnNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEdG1ManN0cHdnN0l1azdZeW9PaUFuS1NrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SU8yTW5leVhoU0RzbXBUc2hvenJzNFFnN0xhVTdMS2NJT0tBbENEdGxad2c3WXlkN0plRjdKMllJT3Exck95RXNleWFsT3lHakNqc2w2M3RsYUFyNjZ5NDZyV3NLZXVsdkNEdGxad2c2N0tJN0plUUlPdXdtK3lWaENEc2w2M3RsYURyczRUcm9ad2c2NHVrNjVPczY0cVU2NHVrTGdvZ0lDOHZJT3lhbE95R2pPdWx2Q0R0bGFqcXU1Z2c2N08wNjRLMDdKVzhJTzJEZ095ZHRPMkxnT3lkdENEcnM3anJyTGdnNjZlbDY1Mjk3SjJFSU95d3VPeWhzTzJWb0NEc2lKZ2c3SjZJNjR1a0tPeWFsT3lHak91emhDRHFzSnpyczRRZzdKcVU3TEt0NnJPODdKMllJT3l3cU95ZHRDa3VDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM0psWTI5dGJXVnVaQzF3YjNCMWNDY3BJSHNLSUNBZ0lHTnZibk4wSUhzZ1pXeGxiV1Z1ZEhNc0lHMXZaR1ZzTENCdGIzSmxJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlFRnljbUY1TG1selFYSnlZWGtvWld4bGJXVnVkSE1wSUQ4Z1pXeGxiV1Z1ZEhNdVptbHNkR1Z5S0NobEtTQTlQaUJsSUNZbUlGTjBjbWx1WnlobExuUmxlSFFnZkh3Z0p5Y3BMblJ5YVcwb0tTa2dPaUJiWFRzS0lDQWdJR2xtSUNoc2FYTjBMbXhsYm1kMGFDQThJRElwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW43WXlkN0plRklPeWFsT3lHak9xd2dDRHJ0b0Rzb2JIdGxhbnJpNGpyaTZRdUp5QjlLVHNLSUNBZ0lHTnZibk4wSUhOMFlYSjBaV1FnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1uZXlYaFNEc3RwVHNzcHdnN0pxVTdMS3RPaURzbXBUc2hvd2dKeUFySUd4cGMzUXViR1Z1WjNSb0lDc2dKK3F3bkNjZ0t5QW9iVzl5WlNBL0lDY2dLT3VObENEcnNKdnF1TEFwSnlBNklDY25LU3dnYlc5a1pXd2dQeUFuS091cXFPdU51RG9nSnlBcklHMXZaR1ZzSUNzZ0p5a25JRG9nSnljcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ1kyOXVjM1FnY2lBOUlHRjNZV2wwSUdGemExQnZjSFZ3S0d4cGMzUXNJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlZCdmNIVndMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXV3cWUyV3BTRHRsWndnNjZ5NDdKNmxJaXdnSW1Wc1pXMWxiblJ6SWpvZ1czc2ljbTlzWlNJNklDTHNsNjN0bGFBaUxDQWlkR1Y0ZENJNklDTHJyTGpxdGF3aWZTd2dMaTR1WFgwc0lDNHVMbDE5SnlCOUxDQWhJVzF2Y21VcE93b2dJQ0FnSUNCamIyNXpkQ0J6WlhSeklEMGdjaTV3WVhKelpXUTdDaUFnSUNBZ0lHTnZibk4wSUhObFl5QTlJQ2dvUkdGMFpTNXViM2NvS1NBdElITjBZWEowWldRcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtUc0tJQ0FnSUNBZ2FXWWdLQ0Z6WlhSektTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5ZDdKZUZJT3lFdU8yS3VDQW5JQ3NnYzJWMGN5NXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3Q2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0FuVysyTW5leVhoVjBnSnlBcklGTjBjbWx1Wnlnb2JHbHpkRnN3WFNBbUppQnNhWE4wV3pCZExuUmxlSFFwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0F5TkNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJSE5sZEhNc0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjZ2ZTazdDaUFnSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0akozc2w0VWc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUNmdGdiVHJvWnpyazV3ZzdaaTQ3TGFjSU95THBPMk1xRG9nSnlrcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlEcmpJRHRtWlR0bUpVZzY2eTQ2cldzSU95Z25PeWVrU0RpZ0pRZzdJT0I3Wm1wN0oyRUlPeUVwT3VxaGUyVm1PdXB0Q0RyckxqcXRhenJwYndnNjZlTTY1T2s3SmEwN0tTQTY0dWtJQ2pzdHBUc3NwenFzN3dnNnJDWjdKMkFJT3lFdU95Rm1Dd2c2NHlBN1ptVTY0cVVJT3VucENEc21wVHNzcTNzbDVBZzdZYTE3S2U0NjZHY0lPeUxwT3VtdkNrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdlkyOXRjRzl6WlNjcElIc0tJQ0FnSUdOdmJuTjBJSHNnYldWemMyRm5aWE1zSUcxdlpHVnNJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlFRnljbUY1TG1selFYSnlZWGtvYldWemMyRm5aWE1wSUQ4Z2JXVnpjMkZuWlhNdVptbHNkR1Z5S0NodEtTQTlQaUJ0SUNZbUlGTjBjbWx1WnlodExuUmxlSFFnZkh3Z0p5Y3BMblJ5YVcwb0tTa2dPaUJiWFRzS0lDQWdJR2xtSUNnaGJHbHpkQzVzWlc1bmRHZ3BJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREF3TENCN0lHVnljbTl5T2lBbjY0eUE3Wm1VSU91Q3RPeWFxZXlkdENEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTjBJR3hoYzNSVmMyVnlJRDBnV3k0dUxteHBjM1JkTG5KbGRtVnljMlVvS1M1bWFXNWtLQ2h0S1NBOVBpQnRMbkp2YkdVZ0lUMDlJQ2RoYzNOcGMzUmhiblFuS1RzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc29KenNucEVnNjR5QTdabVVJT3lhbE95eXJUb25MQ0JUZEhKcGJtY29LR3hoYzNSVmMyVnlJQ1ltSUd4aGMzUlZjMlZ5TG5SbGVIUXBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQTFNQ2t1Y21Wd2JHRmpaU2d2WEc0dlp5d2dKeUFuS1NBcklDZmlnS1lnS091TWdPMlpsQ0FuSUNzZ2JHbHpkQzVzWlc1bmRHZ2dLeUFuNnJDY0tTY3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdMeThnNjR5QTdabVU2ckNBSU9xNHVPeVd0T3luZ091cHRDRHN0WnpxdDd3Z01UTHFzSnpycDR3Z0tPMlVoT3Vock8yVWhPMkt1Q0R0ajYzc283d2c2N0NwN0tlQUtRb2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclEyOXRjRzl6WlNoc2FYTjBMbk5zYVdObEtDMHhNaWtzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpVTnZiWEJ2YzJVc0lHWnZjbTFoZEVSbGMyTTZJQ2Q3SW5KbGNHeDVJam9nSXV1TWdPMlpsQ0RzblpIcmk3VWc3WldjNjVHUUlPdXN1T3llcFNJc0lDSnpkV2RuWlhOMGFXOXVjeUk2SUZ0N0luUmxlSFFpT2lBaTY2eTQ2cldzSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBaWZTd2dMaTR1WFgwbklIMHBPd29nSUNBZ0lDQmpiMjV6ZENCdmRYUWdQU0J5TG5CaGNuTmxaRHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVc5MWRDa2dld29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeWVrU0RzblpIcmk3VWdLQ2NnS3lCelpXTWdLeUFuY3l3ZzdLQ2M3SldJSUNjZ0t5QnZkWFF1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUNzZ0orcXduQ2tuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWdvYkdGemRGVnpaWElnSmlZZ2JHRnpkRlZ6WlhJdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djbVZ3YkhrNklHOTFkQzV5WlhCc2VTd2djM1ZuWjJWemRHbHZibk02SUc5MWRDNXpkV2RuWlhOMGFXOXVjeXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lla1NEc2k2VHRqS2c2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5LU2s3Q2lBZ0lDQjlDaUFnZlFvZ0lDOHZJT3V5aU95WHJTRGlnSlFnN1pXYzZyV3Q3SmEwSU9LR2xDRHNtSUhzbHJRZzdKNlE2NCtaSUNqc3RwVHNzcHpxczd3ZzZyQ1o3SjJBSU95RXVPeUZtQ0RzZ3F6c21xa3BDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM1J5WVc1emJHRjBaU2NwSUhzS0lDQWdJR052Ym5OMElIc2dkR1Y0ZEN3Z2JXOWtaV3dnZlNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdDaUFnSUNCcFppQW9JWFJsZUhRZ2ZId2dJVk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2twSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW42N0tJN0pldDdaV2dJT3VzdU9xMXJPcXdnQ0RydVlUc2xyUWc3SjZJN0lxMTY0dUk2NHVrTGljZ2ZTazdDaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnNvanNsNjBnN0pxVTdMS3RPaWNzSUZOMGNtbHVaeWgwWlhoMEtTNXpiR2xqWlNnd0xDQTFNQ2t1Y21Wd2JHRmpaU2d2WEc0dlp5d2dKeUFuS1NBcklDZmlnS1luS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSElnUFNCaGQyRnBkQ0JoYzJ0VWNtRnVjMnhoZEdVb1UzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTd2diVzlrWld3c0lIc2djR0Z5YzJVNklIQmhjbk5sVkhKaGJuTnNZWFJsTENCbWIzSnRZWFJFWlhOak9pQW5leUowY21GdWMyeGhkR1ZrSWpvZ0l1dXlpT3lYcmV1c3VDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpWkdseVpXTjBhVzl1SWpvZ0ltdHY0b2FTWlc0ZzY1aVE2NHFVSUdWdTRvYVNhMjhpZlNjZ2ZTazdDaUFnSUNBZ0lHTnZibk4wSUc5MWRDQTlJSEl1Y0dGeWMyVmtPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzY3S0k3SmV0SU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNtWVRybzR3Z0tDY2dLeUJ6WldNZ0t5QW5jeXdnSnlBcklDaHZkWFF1WkdseVpXTjBhVzl1SUh4OElDYy9KeWtnS3lBbktTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURNd0tUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGTmxZeUE5SUhObFl6c0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnZEhKaGJuTnNZWFJsWkRvZ2IzVjBMblJ5WVc1emJHRjBaV1FzSUdScGNtVmpkR2x2YmpvZ2IzVjBMbVJwY21WamRHbHZiaXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdXlpT3lYclNEc2k2VHRqS2c2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0Ryc29qc2w2MGc3SXVrN1l5b09pQW5LU2s3Q2lBZ0lDQjlDaUFnZlFvZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQTBMQ0I3SUdWeWNtOXlPaUFuVG05MElHWnZkVzVrSnlCOUtUc0tmU2s3Q2dvdkx5RHNuYlRycjdnZzY0dWs2NmFzNnJDQUlPdVdvQ0Rzbm9qcmlwVHJqYkFnNjVpUUlPeThuT3E0c09xd2dDRHJrNlRzbHJUc21LVHJxYlFvN0tDYzdJcWs3TEtZSU95ZWtPdVBtU0Rzdkp6cXVMQWc3S1NSNjdPMUlPdVRzU2tnN0tHdzdKcXA3WjZJSU95aWhldWpqQ0RpZ0pRZzY0K002NDJZSU91THBPdW1yT3VLbENEcXQ3anJqSURyb1p3ZzdKeWc3S2VBQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXdvZ0lHbG1JQ2hsSUNZbUlHVXVZMjlrWlNBOVBUMGdKMFZCUkVSU1NVNVZVMFVuS1NCN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKMjA2Nis0SU95OG5PeWd1Q0Rzbm9qc2xyVHNtcFFvN1krczdZcTRJQ2NnS3lCUVQxSlVJQ3NnSnlEc2dxenNtcWtnN0tTUktTRGlnSlFnN0oyMElPeWR1T3lLcE8yRXRPeUtwT3VLbENEc29vWHJvNHp0bGFucmk0anJpNlF1SnlrN0NpQWdJQ0J3Y205alpYTnpMbVY0YVhRb01DazdDaUFnZlFvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaEp6cnNvUWc3SmlrNjZXWU9pY3NJR1VnSmlZZ1pTNXRaWE56WVdkbEtUc0tJQ0J3Y205alpYTnpMbVY0YVhRb01TazdDbjBwT3dvdkx5RHNsclRybHFRZzZySzk2NkdjNjZHY0lPeWp2ZXVUb0Nqc2k2enNucVhyc0pYcmo1a2c2NEdLNnJtQUxDQkRkSEpzSzBNc0lDOXphSFYwWkc5M2Jpd2c3SmlrNjZXWUtTQmpiR0YxWkdVZzdKNlE3SXVkN0oyRUlPdUNxT3E0c095bmdDRHNsWXJyaXBUcmk2UUtjSEp2WTJWemN5NXZiaWduWlhocGRDY3NJQ2dwSUQwK0lIc2dhMmxzYkZCeWIyTW9LVHNnYTJsc2JFeHZaMmx1VUhKdll5Z3BPeUI5S1RzS2NISnZZMlZ6Y3k1dmJpZ25VMGxIU1U1VUp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwS1RzS2NISnZZMlZ6Y3k1dmJpZ25VMGxIVkVWU1RTY3NJQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1NrN0NncHpaWEoyWlhJdWJHbHpkR1Z1S0ZCUFVsUXNJQ2N4TWpjdU1DNHdMakVuTENBb0tTQTlQaUI3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KK0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0NjcE93b2dJR052Ym5OdmJHVXViRzluS0NjZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93b2dJR052Ym5OdmJHVXViRzluS0NjZzY2cW82NDI0T2lBbklDc2dRMHhCVlVSRlgwMVBSRVZNSUNzZ0p5REN0eURzbUlqc2k1d2dKeUFySUVWWVFVMVFURVZUTG14bGJtZDBhQ0FySUNmcXNiUWc3SjZsN0xDcEp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0p5RHNuYlFnN0xDOTdKMkVJT3k4bk91UmxDRHJqNW5zbFlnZzdaUzg2cmU0NjZlSUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEdGdiVHJvWnpyazV6cm9ad2c3TGFVN0xLYzdaV3A2NHVJNjR1a0xpY3BPd29nSUdOdmJuTnZiR1V1Ykc5bktDZmlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFuS1RzS0lDQmphR1ZqYTBOc1lYVmtaVUYyWVdsc1lXSnNaU2dwT3lBdkx5QkRiR0YxWkdVZ1EyOWtaU0RzZ3F6c21xa2c2ckNBNjRxbElPeVhyT3UyZ0NEc29KRHFzb0FnS08yVWpPdWZyT3EzdU95ZHVDRHNsWWpyZ3JUc21xa3BDaUFnTHk4ZzY2KzQ2NmFzSU95TG5PdVBtU0FySU95bmdPeUxuT3VzdUNEc283enNub1VnNG9DVUlPeXlxeURzdHBUc3NwenJ0b0R0aExBZzY3bWc2NlcwNnJLTUNpQWdZWE5yUTJ4aGRXUmxLQ2ZzbTR6cnNJM3NsNFU2SUNMc29JRHNucVVnNjVDWTdKZUk3SXExNjR1STY0dWtJaWNwTG5Sb1pXNG9DaUFnSUNBb0tTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeVpoT3VqakNEaWdKUWc3TGFVN0xLY0lPeWtnT3U1aENEcmdaMHVKeWtzQ2lBZ0lDQW9aU2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3liak91d2pleVhoU0RzaTZUdGpLZ2dLT3l5cXlEc21wVHNzcTBnNjVXTUlPeWVyT3lMbk91UGhDazZKeXdnWlM1dFpYTnpZV2RsS1FvZ0lDazdDbjBwT3dvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJRzFoWTA5VElPdVRzZXlYa095RW5DQW5iRzlqWVd4b2IzTjBKK3F3Z0NBNk9qSHJvWndnNjZpODdLQ0FJTzJWdE95RW5ldVFtT3VLbE91TnNBb3ZMeUR0bEx6cXQ3anJwNGdvUld4bFkzUnliMjRwSUdabGRHTm82NHFVSUdOMWNtenFzN3dnNjR1czY2YXNJRWxRZGpUcm9ad2c3SjZRNjQrWklPMlB0T3V3c2UyVm1PeW5nQ0RzbFlyc2xZUXNJRWxRZGpUcnA0d2c2NU9qNjQyWUlPdUxwT3Vtck95WGtDRHNsN0Rxc3JEc25iUWc2ckd3NjdhQTY0KzhDaTh2SU95MmxPeXluTUszN1plczdJcWs3TEswN1lHczZyQ0FJT3loc095YXFlMmVpQ0RzaTZUdGpLanRsb2pyaTZRbzdJdWs3TGloSURJd01qWXRNRGNwTGlEcXNKbnNuWUFnN0pxVTdMS3RJTzJWdU91VHBPdWZyT3VsdkNCSlVIWTJJT3VqcU8yVWhPdXdzZXlYa091UGhDRHNscm5yaXBUcmk2UXVDbU52Ym5OMElITmxjblpsY2pZZ1BTQm9kSFJ3TG1OeVpXRjBaVk5sY25abGNpaHpaWEoyWlhJdWJHbHpkR1Z1WlhKektDZHlaWEYxWlhOMEp5bGJNRjBwT3dwelpYSjJaWEkyTG05dUtDZGxjbkp2Y2ljc0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGdTVkIyTmlnNk9qRXBJT3Vtck95S3FDRHNnNTNybnJVZzRvQ1VJRWxRZGpUcnA0d2c3SUtzN0pxcE9pY3NJR1VnSmlZZ1pTNXRaWE56WVdkbEtTazdDbk5sY25abGNqWXViR2x6ZEdWdUtGQlBVbFFzSUNjNk9qRW5LVHNLJwpCNjRfV0FUQ0hFUj0nTHk4ZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzRvQ1VJTzJWcmV5RGdTRHJscUFnN0o2STY0cVVJT3kwaU95R2pPMllsU0RzaEp6cnNvUWdLR3h2WTJGc2FHOXpkRG94TVRnNE9Ta05DaTh2SU9LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBMEtMeThnN0ptY0lPMlZoT3lhbE8yVm5PcXdnRG9nN1pTODZyZTQ2NmVJNnJDQUlPMlVqT3Vmck9xM3VPeWR1T3lkbUNCamJHRjFaR1ZpY21sa1oyVTZMeThnN0plMDZyaXdLSGRwYm1SdmR5NXZjR1Z1TDJsbWNtRnRaUzl2Y0dWdVJYaDBaWEp1WVd3cDY2VzhEUW92THlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293TkNpOHZJRkJQVTFRZ0wzZGhhMlVnNjZXOElPdXp0T3VDdE91cHRDRHFzSkRzaTV6c25wRHFzSUFnNjR1azY2YXNLR05zWVhWa1pTMWljbWxrWjJVdWFuTXA2Nlc4SU91TWdPeUxvQ0RzdktEcmk2UXVEUW92THcwS0x5OGc2NHVrNjZhczdKbUE3SjJZSU95d3FPeWR0RG9nNnJDUTdJdWM3SjZRNjRxVUlHTnNZWFZrWmV1bHZDRHJyTHpzcDRBZzdKV0s2NHFVNjR1a0tPeWVrT3lMblNEc2w0YnNuWXdwSU9LR2tpRHRnYlRyb1p6cms1d2c3Sld4SU95WGhldU5zT3lkdE8yS3VPdWx2Q0RzbFlnZzY2ZUo2ck9nTEEwS0x5OGc2Nm1VNjZxbzY2YXNJSDR4TlUxQzY1MjhJT3Vobk9xM3VPeWR1Q0RzaTV3ZzdKNlE2NCtaSU95TG5PeWVrZXljdk91aG5DRHNnNEhzaTV3ZzdMeWM2NUdzNjQrRUlPdTJnT3VMdENEc2w0YnJpNlFnS091VHNldWhuVG9nYm5CdElISjFiaUJpZFdsc1pDa3VEUW92THlEcmk2VHJwcXpyaXBRZzdJdXM3SjZsNjdDVjY0K1pJT3VCaXVxNHNPdXB0Q0Rzbzczc3A0RHJwNHdvN1pTTTY1K3M2cmU0N0oyNDZyTzhJT3lEbmV5Q3JDRHJqNW5xdUxEdG1aUXBMQ0Rxc0pEc2k1enNucERyaXBRZzZyT0U3SWFOSU91Q3FPeVZoQ0RyaTZUc25Zd2c2cm1vN0pxdzZyaXc2Nlc4SU91d20rdUtsT3VMcEM0TkNnMEtZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNOQ21OdmJuTjBJSEJoZEdnZ1BTQnlaWEYxYVhKbEtDZHdZWFJvSnlrN0RRcGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0RRcGpiMjV6ZENCdmN5QTlJSEpsY1hWcGNtVW9KMjl6SnlrN0RRcGpiMjV6ZENCN0lITndZWGR1TENCemNHRjNibE41Ym1NZ2ZTQTlJSEpsY1hWcGNtVW9KMk5vYVd4a1gzQnliMk5sYzNNbktUc05DZzBLWTI5dWMzUWdVRTlTVkNBOUlERXhPRGc1T3cwS1kyOXVjM1FnVWs5UFZDQTlJSEJoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNjdUxpY3BPeUF2THlEc29JRHNucVhzaG93ZzY2T283WXE0SU9LQWxDRHJpNlRycHF6cXNJQWdjbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrNjZXOElPeXd2dXVLbENEcXVMRHNwSUFOQ2cwS1kyOXVjM1FnUTA5U1UxOUlSVUZFUlZKVElEMGdldzBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUM0pwWjJsdUp6b2dKeW9uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFNHVmhaR1Z5Y3ljNklDZERiMjUwWlc1MExWUjVjR1VuTEEwS2ZUc05DbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3MEtJQ0J5WlhNdWQzSnBkR1ZJWldGa0tITjBZWFIxY3l3Z1QySnFaV04wTG1GemMybG5iaWg3SUNkRGIyNTBaVzUwTFZSNWNHVW5PaUFuWVhCd2JHbGpZWFJwYjI0dmFuTnZianNnWTJoaGNuTmxkRDExZEdZdE9DY2dmU3dnUTA5U1UxOUlSVUZFUlZKVEtTazdEUW9nSUhKbGN5NWxibVFvU2xOUFRpNXpkSEpwYm1kcFpua29iMkpxS1NrN0RRcDlEUW9OQ2k4dklHTnNZWFZrWlNCRFRFbnFzSUFnN0o2STY0cVU3S2VBSU9LQWxDRHNsNGJzbkx6cnFiUWdMM2RoYTJVZzdKMlI2NHUxN0plUUlPeUxwT3lXdENEdGxJenJuNnpxdDdqc25ianNuYlFnN0pXSTY0SzA3WldnSU95SW1DRHNub2pxc293ZzdaV2M2NHVrRFFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzROQ2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENBek1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLTHk4ZzdMcVE3SXVjSURYc3RJZ2c0b0NVSU91aG5PcTN1T3lkdUNEc3A0SHRtNFFnN0lPSUlPcXpoT3lnbGV5ZHRDRHFzNmZyc0pUcm9ad2c3SjZoN1ppQTdKVzhJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKZVE3SVNjSU8yWmlPeWN2T3VobkNEcmhKanNsclRxc0lUcmk2UW9NekRzdElqcnFiUWc2NFNJNjZ5MElPdUtwdXlkakNrTkNteGxkQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lBd0xDQmxiV0ZwYkRvZ2JuVnNiQ0I5T3cwS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzTkNpQWdhV1lnS0VSaGRHVXVibTkzS0NrZ0xTQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BDQTFNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3cwS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJR29nUFNCS1UwOU9MbkJoY25ObEtHWnpMbkpsWVdSR2FXeGxVM2x1WXlod1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuTG1Oc1lYVmtaUzVxYzI5dUp5a3NJQ2QxZEdZNEp5a3BPdzBLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJvWnpxdDdqc25iZ2c3SjIwNjZDbElPeVhodXlkakNEcms3RWc0b0NVSUc1MWJHd2dLaThnZlEwS0lDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUJFWVhSbExtNXZkeWdwTENCbGJXRnBiQ0I5T3cwS0lDQnlaWFIxY200Z1pXMWhhV3c3RFFwOURRb05DbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzTkNpQWdZMjl1YzNRZ1ptbHVaR1Z5SUQwZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5QS9JQ2QzYUdWeVpTY2dPaUFuZDJocFkyZ25PdzBLSUNCMGNua2dleUJ5WlhSMWNtNGdjM0JoZDI1VGVXNWpLR1pwYm1SbGNpd2dXeWRqYkdGMVpHVW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhOb1pXeHNPaUIwY25WbElIMHBMbk4wWVhSMWN5QTlQVDBnTURzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnY21WMGRYSnVJR1poYkhObE95QjlEUXA5RFFvTkNteGxkQ0IzWVd0cGJtY2dQU0JtWVd4elpUc2dMeThnN0pldzdZT0FJT3V3cWV5bmdDRGlnSlFnNjR1azY2YXM2NHFVSU95V3RPeXdxTzJVdkNCRlFVUkVVa2xPVlZORjY2R2NJT3lra2V1enRTRHNvSlhycHF6dGxaanNwNERycDR3ZzdaU0U2NkdjN0lTNDdJcWtJT3VDcmV1NWhPdWx2Q0RzcElUc25ianJpNlFOQ21aMWJtTjBhVzl1SUhkaGEyVkNjbWxrWjJVb0tTQjdEUW9nSUdsbUlDaDNZV3RwYm1jcElISmxkSFZ5YmpzTkNpQWdkMkZyYVc1bklEMGdkSEoxWlRzTkNpQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJSGRoYTJsdVp5QTlJR1poYkhObE95QjlMQ0ExTURBd0tUc05DaUFnYkdWMElIQnliMk03RFFvZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2dJQ0FnTHk4Z1YybHVaRzkzY3pvZ1kyMWt3cmQyWW5NZzZySzk3SnlnSU95WGh1eWR0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTd2dkMmx1Wkc5M2MwaHBaR1VvUTFKRlFWUkZYMDVQWDFkSlRrUlBWeW5yb1p3ZzdJcWs3WSt3SU9LQWxBMEtJQ0FnSUM4dklPeXd2U0RzbDRicmlwUWc3SWlvN0oyQUlPeTltT3lHbE95ZHRDRHJwNHpyazZUc2xyVHNwNERxczZBZzY0dWs2NmFzN0oyWUlPeWVrT3lMblNoamJHRjFaR1VwNjQrRUlPcTN1Q0Rzdlpqc2hwVHNuWVFnNjZ5ODY2Q2s2N0NiN0pXRUlPeVd0T3VXcENEc3NMM3JqNFFnN0pXSUlPdWNyT3VMcEM0TkNpQWdJQ0F2THlCa1pYUmhZMmhsWk91S2xDRHNrN0RzcDRBZzdKV0s2NHFVNjR1a0tHUmxkR0ZqYUdWa0szZHBibVJ2ZDNOSWFXUmxJT3loc08yVnFleWRnQ0Rzdlpqc2hwUWc3TEM5N0oyMElPdUZ1T3kybk91UXFDRGlnSlFnN0l1azdMaWhLUzROQ2lBZ0lDQXZMeUJYYVc1a2IzZHo3SmVRN0lTZ0lHUmxkR0ZqYUdWa0lPeVhodXlkdE91UGhDRHJ0b0RycXFnbzZyQ1E3SXVjN0o2UUtlcXdnQ0Rzbzczc2xyVHJqNFFnN0o2UTdJdWQ3SjJBSU95Q3RPeVZoT3VDcU91S2xPdUxwQzROQ2lBZ0lDQndjbTlqSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3RFFvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzRFFvZ0lDQWdmU2s3RFFvZ0lIMGdaV3h6WlNCN0RRb2dJQ0FnTHk4Z2JXRmpUMU12NjZhczY0aUY3SXFrT2lEcXNKRHNpNXpzbnBEcnBid2c2NTJFN0pxMElHNXZaR1VnN0l1azdaYUpJTzJNak95ZHZPdWhuQ0RzcDRIc29KRWc3SXFrN1krd0lDaHNZWFZ1WTJoa0lPMlptT3F5dmV5WGxDQlFRVlJJNnJDQUlPdTVpT3lWdmUyVm9DRHNpSmdnN0o2STdKYTBJT3lnaU91TWdPcXl2ZXVobkNEc2dxenNtcWtwRFFvZ0lDQWdjSEp2WXlBOUlITndZWGR1S0hCeWIyTmxjM011WlhobFkxQmhkR2dzSUZ0d1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5ZMnhoZFdSbExXSnlhV1JuWlM1cWN5Y3BYU3dnZXcwS0lDQWdJQ0FnWTNka09pQlNUMDlVTENCa1pYUmhZMmhsWkRvZ2RISjFaU3dnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQTBLSUNBZ0lIMHBPdzBLSUNCOURRb2dJSEJ5YjJNdWRXNXlaV1lvS1RzZ0x5OGc2ckNRN0l1YzdKNlFJT3lkdE91eXBPMkt1Q0RybzZqdGxJVHNsNURzaEp3ZzY3YUU2NmFzSUNqcXNKRHNpNXpzbnBBZzdLS0Y2Nk9NNjZXOElPdW5pZXluZ0NEc2xZcnFzb3dwRFFwOURRb05DaTh2SU95ZHRDQlFRK3VsdkNBbjdJU2s3TG1ZSU95Z2hDanNnNGdnVUVNcEp5RHNnNEh0ZzV6cm9ad2c2NUNZNjQrTTY2YXc2NHVrSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnVyt5MGlPcTRzTzJabEYwZzY3S0U3WXE4S0ZCUFUxUWdMM1Z1YVc1emRHRnNiQ25zbmJRZzY3YUE2Nlc0NjR1a0xnMEtMeThnY21WbmFYTjBaWEl0Y0hKdmRHOWpiMnd1YW5QcXNJQWc3SVNrN0xtWTdaV2NJT3F5Zyt5ZGhDRHF0N2pyaklEcm9ad2c2NUNZNjQrTTY2YXc2NHVrT2lEcXNKRHNpNXpzbnBBZzdKNlE2NCtaN0l1YzdKNlJJQ3NnS095ZWlPeWN2T3VwdENrZzdJU2s3TG1ZSU8yUHRPdU5sQzROQ2k4dklPS2FvTys0anlEcnNKanJrNXpzaTV3Z1NGUlVVQ0RzblpIcmk3WHNuWVFnNjZpODdLQ0FJT3V6dE91Q3VDRHJrcVFnN1ppNDdMYWM3WldnSU9xeWd5RGlnSlFnYldGalQxTWdiR0YxYm1Ob1kzUnNJR0p2YjNSdmRYVHNuYlFnN0oyMElPMlVoT3Vobk95RXVPeUtwT3VsdkNEc3BvbnNpNXdnN0tLRjY2T003SXVjN1lLc0lPeUltQ0Rzbm9qcmk2UXVEUW92THlBZ0lDRHF0N2pybnBqc2hKd2c3WXlNN0oyOEtIQnNhWE4wd3Jmc2hLVHN1WmdnN1krMDY0MlVLZXlkaENCc1lYVnVZMmhqZEd6cnM3VHJpNlFnNjZpODdLQ0FJT3luZ095YXRPdUxwQ0RpZ0pRZ1ltOXZkRzkxZE95ZHRDRHNtckRycHF6cnBid2c3S085N0plczY0K0VJT3lla091UG1leUxuT3lla2V5ZGdDRHNuYlRycjdnZzdJS3M2NTI4N0tlRTY0dWtMZzBLWm5WdVkzUnBiMjRnZFc1cGJuTjBZV3hzVTJWc1ppZ3BJSHNOQ2lBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUZ0ZE93MEtJQ0IwY25rZ2V3MEtJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXcwS0lDQWdJQ0FnWTI5dWMzUWdURUZDUlV3Z1BTQW5ZMjl0TG1Oc1lYVmtaV0p5YVdSblpTNTNZWFJqYUdWeUp6c05DaUFnSUNBZ0lHTnZibk4wSUhCc2FYTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua25MQ0FuVEdGMWJtTm9RV2RsYm5Sekp5d2dURUZDUlV3Z0t5QW5MbkJzYVhOMEp5azdEUW9nSUNBZ0lDQmpiMjV6ZENCcGJuTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua25MQ0FuUVhCd2JHbGpZWFJwYjI0Z1UzVndjRzl5ZENjc0lDZERiR0YxWkdWQ2NtbGtaMlVuS1RzTkNpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLSEJzYVhOMEtTa2dleUJtY3k1MWJteHBibXRUZVc1aktIQnNhWE4wS1RzZ2NtVnRiM1psWkM1d2RYTm9LSEJzYVhOMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQWdJSFJ5ZVNCN0lITndZWGR1VTNsdVl5Z25iR0YxYm1Ob1kzUnNKeXdnV3lkaWIyOTBiM1YwSnl3Z0oyZDFhUzhuSUNzZ2NISnZZMlZ6Y3k1blpYUjFhV1FvS1NBcklDY3ZKeUFySUV4QlFrVk1YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2RzWVhWdVkyaGpkR3duTENCYkozSmxiVzkyWlNjc0lFeEJRa1ZNWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dldzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1RXbGpjbTl6YjJaMFhGeFhhVzVrYjNkelhGeERkWEp5Wlc1MFZtVnljMmx2Ymx4Y1VuVnVKeXdnSnk5Mkp5d2dKME5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWEluTENBbkwyWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lISmxiVzkyWldRdWNIVnphQ2duN0o2UTY0K1o3SXVjN0o2UktFTnNZWFZrWlVKeWFXUm5aVmRoZEdOb1pYSXBKeWs3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KMk5zWVhWa1pXSnlhV1JuWlRvdkx5RHJrN0hyb1owbktUc2dmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnSUNCMGNua2dldzBLSUNBZ0lDQWdJQ0JqYjI1emRDQnBibk4wSUQwZ2NHRjBhQzVxYjJsdUtIQnliMk5sYzNNdVpXNTJMa3hQUTBGTVFWQlFSRUZVUVNCOGZDQndZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBblFYQndSR0YwWVNjc0lDZE1iMk5oYkNjcExDQW5RMnhoZFdSbFFuSnBaR2RsSnlrN0RRb2dJQ0FnSUNBZ0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWdmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZRMEtJQ0FnSUNBZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdmUTBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lCbVlXbHNMWE52Wm5RZzRvQ1VJT3VxdXlEc3A0RHNtclFnNnJLTUlPeWVpT3lXdE91UGhDRHRsSXpybjZ6cXQ3anNuYmdnN0txOUlPcTRzT3lXdFNEc2dxM3NvSnpyaXBRZzdKMjA2Nis0SU91Qm5ldUNyT3VMcENBcUx5QjlEUW9nSUhKbGRIVnliaUJ5WlcxdmRtVmtPdzBLZlEwS0RRb3ZMeURyaTZUcnBxd29NVEU0T0RncDZyQ0FJT3VXb0NEc25vanNuTHpycWJRZzY0R0k2NHVrSU9LQWxDRHN0SWpxdUxEdG1aUWc3SXVjSU91Q3FPeWRnQ0RzaExqc2haZ2c3S0NWNjZhc0lDanNsNGJzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lMcE8yTXFDa05DbVoxYm1OMGFXOXVJSE5vZFhSa2IzZHVRbkpwWkdkbEtDa2dldzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUhJZ1BTQm9kSFJ3TG5KbGNYVmxjM1FvZXlCb2IzTjBPaUFuTVRJM0xqQXVNQzR4Snl3Z2NHOXlkRG9nTVRFNE9EZ3NJSEJoZEdnNklDY3ZjMmgxZEdSdmQyNG5MQ0J0WlhSb2IyUTZJQ2RRVDFOVUp5d2dkR2x0Wlc5MWREb2dNVFV3TUNCOUxDQW9LU0E5UGlCN2ZTazdEUW9nSUNBZ2NpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnbmRHbHRaVzkxZENjc0lDZ3BJRDArSUhzZ2RISjVJSHNnY2k1a1pYTjBjbTk1S0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlNCOUtUc05DaUFnSUNCeUxtVnVaQ2dwT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNuME5DZzBLWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9LSEpsY1N3Z2NtVnpLU0E5UGlCN0RRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwTkNpQWdhV1lnS0hKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoYkhSb0p5a2dldzBLSUNBZ0lDOHZJSFk2SU9xd2tPeUxuT3lla0NEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENEcXRhenJzb1Rzb0lRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU9xemhPeUdqU0RyajR6cXM2QWc3SjZJNjRxVTdLZUFJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsWmpyaXBRZzdKcXA2NCtFRFFvZ0lDQWdMeThnS0hZeUlEMGc3TEM5SU95SXFPcTVnQ0RzaUpqc29KWHRqSkFzSUhZeklEMGdMMkZqWTI5MWJuUWc3TGFVNnJDQTdZeVFMQ0IyTkNBOUlDOTFibWx1YzNSaGJHd2c3TGFVNnJDQTdZeVFLUTBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCM1lYUmphR1Z5T2lCMGNuVmxMQ0IyT2lBMElIMHBPdzBLSUNCOURRb2dJQzh2SU95ZHRDQlFRK3lYa0NEcm9aenF0N2pzbmJqcmtKd2c3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRGlnSlFnN1pTTTY1K3M2cmU0N0oyNElPeXlxeUR0bVpUcnFiVEN0KzJaaU95ZHRDQWk2NGlFNnJXc0lPcXpoT3lnbGV5Y3ZPdWhuQ0RzazdEcmlwVHNwNEFpSU91enRPeVhyT3lqdk91S2xDRHJqYkFnN0pPMDY0dWtMZzBLSUNBdkx5RHFzSkRzaTV6c25wRHFzSUFnNjR1MTdaV1k2NHFVSU95ZHRPeWNvRG9nNjR1azY2YXM2Nlc4SU95OG5PdXB0Q0RzbTR6cnNJM3NsNFhzbkx6cm9ad2c3WUcwNjZHYzY1T2M2ckNBSU95THBPeWduQ0R0bUxqc3RwenJqN3dnNnJXczY0K0ZJT3lDck95YXFldWZpZXlkdENEcmdwanFzSVRyaTZRdURRb2dJQzh2SU9xd2tPeUxuT3lla091S2xDRHRqSXpzbmJ6cnA0d2c3SjI5N0p5ODY2K0E2NkdjSU95Q3JPeWFxZXVmaVNBd0lNSzNJT3VNZ09xNHNDQXdJT0tBbENEcXNvRHRocURycDR3ZzdKT3c2NHFVSU95Q3JPdWVqT3lYa09xeWpDRHJ1WVRzbXFuc25ZUWc2Nnk4NjZhczdLZUFJT3lWaXV1S2xPdUxwQzROQ2lBZ0x5OGc3S084N0oyWU9pRHNsNnpxdUxBZzZyT0U3S0NWN0oyMElPdXp0T3lYck91UGhDRHNub1hzbnFYcXRvenNuYlFnNjZlTTY2T002NUNRN0oyRUlPeUltQ0Rzbm9qcmk2UW83SnlnN1pxbzdJU3g3SjJBSU95THBPeWduQ0R0bUxqc3Rwd2c2NVdNNjZlTUlPeVZqQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHJpNlRycHF3Z0wyaGxZV3gwYU95ZG1DQndjbTlpYkdWdElPeXd1T3F6b0NrdURRb2dJR2xtSUNoeVpYRXVkWEpzSUQwOVBTQW5MMkZqWTI5MWJuUW5LU0I3RFFvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3Z1kyeGhkV1JsT2lCb1lYTkRiR0YxWkdVb0tTQjlLVHNOQ2lBZ2ZRMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZkMkZyWlNjcElIc05DaUFnSUNCcFppQW9JV2hoYzBOc1lYVmtaU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNnZlNrN0RRb2dJQ0FnZDJGclpVSnlhV1JuWlNncE93MEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0IzWVd0cGJtYzZJSFJ5ZFdVZ2ZTazdEUW9nSUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dldzBLSUNBZ0lHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdEUW9nSUNBZ2NtVjBkWEp1T3cwS0lDQjlEUW9nSUM4dklPeTBpT3E0c08yWmxDRGlnSlFnN0oyMElGQkQ2Nlc4SUNmc2c0Z2dVRU1uSU95RGdlMkRuT3VobkNEcmtKanJqNHpycHJEcmk2UWdLTzJVak91ZnJPcTN1T3lkdUNCYjdMU0k2cml3N1ptVVhTRHJzb1R0aXJ3cExnMEtJQ0F2THlEc25aSHJpN1hzbllRZzY2aTg3S0NBSU8yZG1PdWdwT3V6dE91Q3VDRHJrcVFnN0tDVjY2YXM3WldjNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc3BvbnNpNXdnN0tPOTdKZXM2NCtFSU8yYWpPeUxvT3lkZ0NEcmo0VHNzS250bFp6cmk2UXVEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkxYm1sdWMzUmhiR3duS1NCN0RRb2dJQ0FnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnY0d4aGRHWnZjbTA2SUhCeWIyTmxjM011Y0d4aGRHWnZjbTBnZlNrN0RRb2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3RFFvZ0lDQWdJQ0J6YUhWMFpHOTNia0p5YVdSblpTZ3BPdzBLSUNBZ0lDQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlIVnVhVzV6ZEdGc2JGTmxiR1lvS1RzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJkMkYwWTJobGNsMGc3TFNJNnJpdzdabVVLSFZ1YVc1emRHRnNiQ2tnNG9DVUlPeWduT3F4c0RvbkxDQnlaVzF2ZG1Wa0xtcHZhVzRvSnl3Z0p5a2dmSHdnSnlqc2w0YnNuWXdwSnlrN0RRb2dJQ0FnSUNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhCeWIyTmxjM011WlhocGRDZ3dLU3dnTWpBd0tUc05DaUFnSUNCOUxDQXlOVEFwT3cwS0lDQWdJSEpsZEhWeWJqc05DaUFnZlEwS0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdOQ3dnZXlCbGNuSnZjam9nSjA1dmRDQm1iM1Z1WkNjZ2ZTazdEUXA5S1RzTkNnMEtMeThnN0oyMDY2KzRJT3VXb0NEc25vanNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeWloZXVqakNBbzdKNlE2NCtaSU95TG5PeWVrU0FySUc1d2JTQmlkV2xzWkNEc3BKSHJzN1VnN0l1azdaYUpJT3VNZ091NWhDa05Dbk5sY25abGNpNXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdldzBLSUNCcFppQW9aU0FtSmlCbExtTnZaR1VnUFQwOUlDZEZRVVJFVWtsT1ZWTkZKeWtnY0hKdlkyVnpjeTVsZUdsMEtEQXBPdzBLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3RFFwOUtUc05Dbk5sY25abGNpNXNhWE4wWlc0b1VFOVNWQ3dnSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzTkNpQWdZMjl1YzI5c1pTNXNiMmNvSjF0M1lYUmphR1Z5WFNEdGdiVHJvWnpyazV3ZzY0dWs2NmFzSU9xd2tPeUxuT3lla0NEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93MEtmU2s3RFFvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJQ2RzYjJOaGJHaHZjM1FuNnJDQUlEbzZNZXVobkNEcnFMenNvSUFnN1pXMDdJU2Q2NUNZNjRxVUlPMlptT3F5dmV5WGtPeUVuQTBLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlFbFFkalRyb1p3ZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDRHJpNlRycHF3ZzZybW83SnF3NnJpd3dyZnFzNFRzb0pVZzdLR3c3WnFNNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJqWmdnNjZ5NDdLQ2NJT3VNZ095ZGtTanJpNlRycHF6c21ZQWc2NCtaN0oyOEtTNE5DbU52Ym5OMElITmxjblpsY2pZZ1BTQm9kSFJ3TG1OeVpXRjBaVk5sY25abGNpaHpaWEoyWlhJdWJHbHpkR1Z1WlhKektDZHlaWEYxWlhOMEp5bGJNRjBwT3cwS2MyVnlkbVZ5Tmk1dmJpZ25aWEp5YjNJbkxDQW9LU0E5UGlCN2ZTazdJQzh2SURvNk1leWRoQ0RycXJzZzdKNmg3SldFNjQrRUtFVkJSRVJTU1U1VlUwWEN0MGxRZGpZZzdKZUc3SjJNS1NCSlVIWTA2NmVNN0p5ODY2R2NJT3F6aE95R2pTRHJqNW5zbnBFTkNuTmxjblpsY2pZdWJHbHpkR1Z1S0ZCUFVsUXNJQ2M2T2pFbktUc05DZz09JwpCNjRfRVhBTVBMRVM9J0l5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzcElUc25ZUWc2N0NVNnI2NDZyT2dJT3lMdHV5Y3ZPdXB0Q0JnSUM4Z1lDQW83SldlNjVLa0lPcXp0ZXV3c1NEdGo2enRsYWdnN0lxczY1Nlk3SXVjS1NvcUlPdWhuQ0R0a1p6c2k1enRsWmpzaExqc21wUXVJTzJVak91ZnJPcTN1T3lkdU95WGtPeUVuQ0Rya1pBZzdLU0U2NkdjSU91enRPeVhyT3lua2V1TGlPdUxwQzRLTFNEc2dxenNtcW5zbnBEcXNJQWc3SjZGNjZDbDdaV2NJT3VzdU9xMXJPcXdnQ0JnN0p1UTY3TzRZT3F6dkNBbzZyTzE2N0N4d3JmcnJManNucVhydG9EdG1MZ2c2NnkwN0l1YzdaV1k2ck9nS1NEcXNKbnFzYkRyZ3Bnc0lPeUVuT3VobkNEdGo2enRsYWp0bFpqcnFiUWc2cmU0SU95MmxPeXluT3lWaU91VHBPeWRoQ0RyczdUc2w2enNwSTNyaTRqcmk2UXVDaTBnNjZlazdMbXQ3WldnSU91VmpDQXFLdXVuaU95S3BPMkN1ZXVRbkNEc25iVHJwb1FvN1ptTlhDcnJqNWtwTENEc2lLdnNucEFvN0tDRTdabVU2N0tJN1ppNHdyY2k3Sm00SURMcnFvVWlJT3VUc1NucmlwUWc2NnkwN0l1Y0tpcnRsYW5yaTRqcmk2UWc0b0NVSU95ZHRPdW1oTUszN0lpWTY1K0p3cmZyc29qdG1ManJwNHdnNjR1azY2VzRJT3VzdU9xMXJPdVBoQ0Rxc0puc25ZQWc3SmlJN0l1YzY2R2NJT3llb2UyWWdPeWFsQzRnNjR1b0xDRHN0cFRzc3B6c2xZanNsNUFnN0tDQjdKYTA2NUdVSU95ZHRPdW1oTUszN0lpcjdKNlE2NHFVSU9xM3VPdU1nT3VobkNEcmdwanNtS1RyaTRnZzdJdWs3S0NjSU9xd2t1eVhrQ0RycDU3cXNvd2c2ck9nN0xPUUlPeVRzT3lFdU95YWxDNEtMU0Rzb0p6cnFxa29ZQ01qWUNucXM3d2dZQ01qSTJBc0lHQXRZQ0RxdUxEdG1ManJpcFFnN1ppVjdJdWQ3SjIwNjR1SUlPdXdsT3ErdU95bmdDRHJwNGpzaExqc21wUXVDZ29qSXlEc2lxVHRnNERzbmJ3ZzdKdVE3TG1aSUNqc3NManFzNkFnNG9DVUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZQWdkWGd0ZDNKcGRHbHVaeTV0WkNEcXNJRHNuYlRyazV3cENnb3RJTzJWdE95YWxPeXl0Q3dnNjdhQTY1T2M2NStzN0pxMElPeWloZXF5c0NoZ2Z1eWVpT3lXdE95YWxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrS0xTRHFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NBbzdLQ0U3SWFoNG9hUzY3TzA2NEswNjR1a0tTd2c2N2FBN0tDVklPeURnZTJacWV1UGhDRHJsTEhybExIdGxaanNwNEFnN0pXSzZyS01LQ0xzc0w3cXVMQWc3SXVrN1l5b0l1S2RqQ0FpN0xDKzdKMkVJT3lJbUNEc2w0YnNsclRzbXBRaTRweUZLUW9LSXlNZzdMYVU3TEtjSU95WWlPeUxuQW9LSXlNaklPeW5oTzJXaWUyVm1PdU5tQ0RzbnBIc2w0WHNuYlFnN0o2STdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3S2VFN1phSklPeWtrZXlkdUNEcmdyVHNsNjNzbmJRZzdKNkk3SmEwN0pxVUxpQXZJT3lkdE95V3RPeUVuQ0RzcDRUdGxvbnRsYURxdVl6c21wUS9DZ29qSXlNZzZyTzE3SnlnSU95YWxPeXlyZXlkaENEc3Q2anNob3p0bFpqcnFiUWc3SnFVN0xLdElPdUN0T3lYcmV5ZHRDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTNxT3lHak8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHN0NmpzaG96dGxhQWc2cks5N0pxd0lPeWFsT3l5clNEcmdyVHNsNjNyajRRZzdJS3Q3S0NjNjQrODdKcVVMaUF2SU9xenRleWNvQ0RzbXBUc3NxM3NuWVFnN0xlbzdJYU03WldnNnJtTTdKcVVQd29LSXlNaklPcTRzT3E0c091bHZDRHNzTDdzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXWTdJUzQ3SnFVTGdvdElPcTRzT3E0c091bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaV1k2cml3SU95Z2hPeVhrT3VLbENEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQTdKNkY3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDaTBnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxnb0tJeU1qSU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c3Sm00SURMcnFvWHNsNURxc293ZzZyYU03WldjSU95Q3JleWduQ0RzbFl6cnByenRocUhzbllRZzdLQ0U3SWFoN1pXZzZybU03SnFVUHdvdElPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdE91Z3BPcXpvQ0R0bGJUc21wUXVJQzhnN1ptTkt1dVBtU2d3TVRBdE1USXpOQzAxTmpjNEtTRHJpNWdnN0ptNElETHJxb1hzbDVEcXNvd2c2N08wNjRLODZybU03SnFVUHdvdElPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnNjR1WUlPeVp1Q0F5NjZxRjdKZVE2cktNSU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN2T3E1ak95YWxEOEtMU0RxdG96dGxad2c3SUt0N0tDY0lPeVZqT3Vtdk8yR29leWRoQ0R0bVkwcTY0K1pLREF4TUMweE1qTTBMVFUyTnpncElPdUxtQ0RzbWJnZ011dXFoZXlYa09xeWpDRHJzN1RyZ3J6cXVZenNtcFEvQ2dvakl5TWpJTzJabGV5ZHVNSzM2ckt3N0tDVklPMk1uZXlYaFFvS0l5TWpJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeUNyZXlnbk91UW5DRHJqYkRzbmJUdGhMRHJpcFFnNjdPMTZyV3M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHJrSmpyajR6cnByUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNvSlhycDVBZzdJS3Q3S0NjN1pXZzZybU03SnFVUHdvS0l5TWpJT3V6Z09xeXZleUNyTzJWcmV5ZHRDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdKV1k3SXExNjR1STY0dWtMaURyZ3BqcXNJRHNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SldFN0tlQklPeWdnT3llcGUyVm1PeW5nQ0RzbFlyc25ZQWc2NEswN0pxcDdKMjBJT3llaU95V3RPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpyajd6c21wUXVJQzhnN0xTSTZyaXc3Wm1VN1pXZzZybU03SnFVUHdvS0l5TWpJeURzbDVEcm42ekN0K3lMcE8yTXFBb0tJeU1qSU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU91RXBPMkt1T3liak8yQnJPeVhrQ0RzbDdEcXNyRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzbDdEcXNyQWc3SU9CN1lPYzY2VzhJTzJabGV5ZHVPMlZtT3F6b0NEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPdXduT3lEbmUyV2lPeUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU95RG5lcXl2T3lXdE95YWxDNGdMeURzbnFEc2k1d2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWaE95ZHRPdVVsQ0RybUpEcmlwUWc2N21FNjdDQTY3S0k3Wmk0NnJDQUlPeWR2T3k1bU8yVm1PeW5nQ0RzbFlyc2lyWHJpNGpyaTZRdUNpMGc3SldFN0oyMDY1U1VJT3VZa091S2xDRHJ1WVRyc0lEcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDNyc29qdG1ManFzSUFnN0oyODdMbVk3WldZN0tlQUlPeVZpdXlLdGV1TGlPdUxwQzRLTFNEc25ianNwcDNyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3kwaU9xenZPdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKMjQ3S2FkNjdLSTdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnN0plRjY2R2M2NU9jN0plUUlPeUxwTzJNcU8yV2lPeUt0ZXVMaU91THBDNEtMU0R0akl6c25ienNuWVFnN0ppczY2YXM3S2VBSU91cXUrMldpT3lXdE95YWxDNGdMeURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3S0NRNnJLQUlPeWtrZXllaGV1TGlPdUxwQzRnN0oyMDdKcXA3SmVRSU91MmlPMk91T3lkaENEcms1enJvS1FnN0tPRTdJYWg3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEc2hKenJ1WVRzaXFUcnBid2c3S0NRNnJLQTdaV1k2ck9nSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSkRxc29Ec25iUWc2NEdkNjRLWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bFlUc2lKZ2c3SjZGNjZDbElPMlZyZXVxcWV5ZWhldUxpT3VMcEM0S0xTRHF2SzBnN0o2RjY2Q2w3WlcwN0pXOElPMlZtT3VLbENEdGxhM3JxcW5zbmJUc2w1RHNtcFF1Q2dvakl5TWpJT3Eyak8yVm5NSzM3SVNrN0tDVkNnb2pJeU1nN0xtMDY2bVU2NTI4SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdJcTE2NHVJNjR1a0xpRHNoS1Rzb0pYc2w1RHNoSndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU95THJleUxuT3lZcEM0S0xTRHN1YlRycVpUcm5id2c2cmFNN1pXYzdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0xtMDY2bVU2NTI4SU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmpPdW12Q0RxdG96dGxaenNuYlFnNnJHdzY3YUE2NUNZN0phMElPeVZqT3Vtdk95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHNsWXpycHJ3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PdXB0Q0RzaG96c2k1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUlDOGc3SVNrN0tDVjdKZVE3SVNjSU95VmpPdW12T3lkaENEc3ZKd2c3S084N0lTNDdKcVVMZ29LSXlNaklPeWNoT3k1bUNEc29KWHJzN1FnN0oyMDdKcXA3SmVRSU91UG1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyb1ozc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdVRzZXVobmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWc3SUt0N0tDYzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeUNyZXlnbk8yV2lPeVd0T3lhbEM0S0NpTWpJeUR0Z2JUcnByM3JzN1RyazV6c2w1QWc2N08xN0lLczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0ZXlDck8yV2lPeVd0T3lhbEM0S0NpTWpJeURzbXBUc3NxM3NuWVFnN0xLWTY2YXNJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKcVU3TEt0N0oyRUlPeXltT3Vtck8yVm1PcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPeVZpT3VDdE1LMzdKeWc2NCtFQ2dvakl5TWc3SU9JNjZHYzdKcTBJT3V5aE95Z2hPeWR0Q0RzdHB6c2k1enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlPeVhoZXVOc095ZHRPMkt1Q0R0bTRRZzdKMjA3SnFwSU9xd2dPdUtwZTJWcWV1TGlPdUxwQzRLTFNEc2c0Z2c2N0tFN0tDRTdKMjBJT3VDbU95WmxPeVd0T3lhbEM0Z0x5RHNsNFhyamJEc25iVHRpcmp0bFpqcnFiUWc3SU9JSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0oyMDdKcXA3SjJFSU95Y2hPMlZ0Q0RzbGIzcXRJQWc2NCtaN0oyWTZyQ0FJTzJWaE95YWxPMlZxZXVMaU91THBDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzaTV6c25wSHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25xWHNpNXpxc0lRZzY2KzQ3SUtzN0pxcDdKeTg2NkdjSU95ZWtPdVBtU0Ryb1p6cXQ3anNsWVRzbTRNZzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3lZcE91ZXErdVBtZXlWaUNEc2dxenNtcW50bFpqc3A0QWc3SldLN0pXRUlPdWhuT3EzdU95VmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyaTRqcmk2UXVJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbllRZzdabVY3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3E0c09xNHNPcXdnQ0RyaEtUdGlyanNtNHp0Z2F6c2w1QWc3SmV3NnJLdzY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJpdzZyaXc3SjJZSU95WHNPcXlzQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbUlIc2c0SHNuWVFnNjdhSTY1K3M3SmlrNjRxVUlPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0ppQjdJT0I3SjJFSU91MmlPdWZyT3lZcE9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3kzcU95R2pPMlZtT3lMcENEcXNyM3NtckFnN0l1ZzdMS3Q3WldZN0l1Z0lPdUN0T3lhcWV5ZGdDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdJcTE2NHVJNjR1a0xnb3RJT3kzcU95R2pPMlZtT3VwdENEc2k2RHNzcTN0bFp3ZzY0SzA3SnFwN0oyMElPeWdnT3llcGV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvQ2kwZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvSUM4ZzdMZW83SWFNN1pXWTY2bTBJT3llaGV1Z3BlMlZuQ0RyZ3JUc21xbnNuYlFnN0lLczY1Mjg3S0M0N0pxVUxnb0tJeU1qSXlEcXNJRHNuYlRyazV3ZzdKaUk3SXVjSUNoMWVDMTNjbWwwYVc1bkxtMWs3SmVRN0lTY0lPeVlydXE1Z0NEaWdKUWc2cmVjN0xtWjdKeTg2NkdjSU95ZWtPdVBtZTJabENEcnFyc2c3WldZNjRxVUlPdXN1T3llcFNEc25xenF0YXpzaExFZzdJS3M2NkdBS1FvS0l5TWpJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxczZBZzZyT0U3SXVjNjRLWTdKcVVQd290SU95ZWtPdVBtZXl3cU9xd2dDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUxnb3RJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFF1Q2dvakl5TWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVMZ290SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQzRLQ2lNakl5RHF1SWpzbmJ6cXVZenNwNEFnNjYrNDY0S3BJT3lMbkNEc2w3RHNzclFnN0xLWTY2YXM2NUNwNjR1STY0dWtMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUNxZXUyZ08yVm1PeUxuT3E0c0NEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUF2SU8yYmhPdTJpT3F5c095Z25DRHF1SWpzbGFIc25ZUWc2NEswN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lna09xeWdDRHF1TERxc0lUc2w1RHJpcFFnN0lTYzY3bUU3SXFrSU95ZHRPeWFxZXlkdENEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUxvT3UyaE95bW5TRHRtWlhzbmJnZzdLQ0U3SmVRNjRxVUlPeUdvZXE0aUNEcnNJOGc2ckt3N0tDYzZyQ0FJT3UyaU9xd2dPMlZxZXVMaU91THBDNEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPdXpnT3F5dlNEc2k1d2c3THFRN0l1YzY3Q3hJT3llck95bmdPcTRpZXlkZ0NEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNnNEhyaTdRZzdaS0k3S2VJSU8yV3BleURnZXlkaENEc25JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhbEM0S0NpTWpJeU1nNnJPRTdLQ1Z3cmZzbm9Ycm9LVUtDaU1qSXlEc2xZVHNuYlRybEpRZzY1aVE2NHFVSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWR0T3lEZ1NEc25wanJxcnNnN0o2RjY2Q2w3WldZN0plc0lPcXpoT3lnbGV5ZHRDRHNucURxdUlnZzdMS1k2NmFzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWVtT3VxdXlEc25vWHJvS1h0bGJUc2hKd2c2ck9FN0tDVjdKMjBJT3llb09xeXZPeVd0T3lhbEM0Z0x5RHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzdKNnM3SVNrN0tDVjdaV1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25iVHJyN2dnN0lLczdKcXBJT3lra2V5ZHVDRHNsWVRzbmJUcmxKVHNub1hyaTRqcmk2UXVDaTBnN0oyMDY2KzRJT3lUc09xem9DRHNub2pyaXBRZzdKV0U3SjIwNjVTVTdKaUk3SnFVTGlBdklPdUxwT3VsdUNEc2xZVHNuYlRybEpUcnBid2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNncXpzbXFudGxhQWc3SWlZSU95WGh1dUtsQ0RydVlUcnNJRHJzb2p0bUxqc25vWHJpNGpyaTZRdUlPeVlnZXVzdUN3ZzdJaXI3SjZRTENEdGlybnNpSmpyckxqc25wRHJwYndnN1krczdaV283WldZN0plc0lEanNucEFnN0oyMDdJT0JJT3llaGV1Z3BlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc21JSHJyTGdzSU95SXEreWVrQ3dnN1lxNTdJaVk2Nnk0N0o2UTY2VzhJTzJQck8yVnFPMlZ0Q0E0N0o2UUlPeWR0T3lEZ1NEc25vWHJvS1h0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95ZWhldWdwU0Rxc0lEcmlxWHRsWndnNnJpQTdKNlFJT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzdKNkY2NkNsN1pXZ0lPeUltQ0Rzbm9qcmlwUWc2cmlBN0o2UUlPeUltT3VsdkNEcmhKanNsNGpzbHJUc21wUXVJQzhnNjRLMDdKcXA3SjJFSU95aHNPcTRpQ0RzcElUc2w2d2c3S084N0lTNDdKcVVMZ29LSXlNakl5RHRqSXpzbmJ6Q3QrcXlzT3lnbk1LMzZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzaUpqcmk2anNuWVFnN1ptVjdKMjQ3WldZNnJPZ0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WldZN0plc0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xenRlcXdoT3lkaENEdG1aWHJzN1R0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BDRHNwSURydVlRZzdLU1I3SjZGNjR1STY0dWtMZ290SU95a2dPdTVoTzJWbU9xem9DRHNub2pyaXBRZzZyaXc2NHFsN0oyMDdKZVE3SnFVTGlBdklPeWhzT3E0aU91bmpDRHF1TERyaTZUcm9LUWc3S084N0lTNDdKcVVMZ29LSXlNaklPdVRzZXVoblNEcXNJRHJpcVh0bFp3ZzdMV2M2NHlBSU9xd25PeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnNjQyVUlPdVRzZXVobmUyVm1PdWdwT3VwdENEcXVMRHNvYlFnN1pXdDY2cXA3SjJFSU95Q3JleWduTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095MmxPcXdnQ2tLQ2lNakl5RHN0cHpyajVrZzdKcVU3TEt0N0oyMElPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0xhYzY0K1pJT3lhbE95eXJleWRoQ0Rzb0pIc2lKanRsb2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLOTY3bUVJT3lEZ2UyRG5PdWx2Q0R0bVpYc25ianRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPcXl2ZXU1aENEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3SUNqc2w0YnNsclRzbXBRZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUXBDZ29qSXlNZzY3TzQ3SjI0SU95ZHVPeW1uZXlkaENEdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0Ryczdqc25iZ2c3SjI0N0thZDdKMkVJTzJWbU91cHRDRHJxcWpyazZBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95ZHRPdXBsT3lkdkNEc25ianNwcDBnN0tDRTdKZVE2NHFVSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lkdE91cGxPeWR2Q0RzbmJqc3BwM3NuWVFnNjZlSTdMbVk2Nm0wSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3kvb08yUHNPeWRnQ0Ryb1p6cXQ3anNuYmdnN1p1RTdKZVE2NmVNSU95Q3JPeWFxU0Rxc0lEcmlxWHRsYW5yaTRqcmk2UXVDaTBnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3kvb08yUHNPeWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJyN2pzaExIcmhZVHNucERyaXBRZzY3TzA3Wmk0N0o2UUlPdVBtZXlkbUNEc2w0YnNuYlFnNnJLdzdLQ2M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzY3TzA3Wmk0N0o2UTZyQ0FJT3VQbWV5ZG1PMlZtT3VwdENEcXNyRHNvSnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsSVRyb1p6dGxZVHNuWVFnNjVPeDY2R2Q3WldZN0tlQUlPeVZpdXljdk91cHRDRHNuYlRzbXFuc25iUWc3S0NjN1pXYzY1Q3A2NHVJNjR1a0xnb3RJTzJVaE91aG5PMlZoT3lkaENEcms3SHJvWjN0bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2xiRWc2N0tFN0tDRTdKMjBJT3VDcnV5VmhDRHNuYnpydG9BZzZyaXc2NHFsN0oyMElPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVobmV1UW1PeW5nQ0RzbFlyc2xZUWc3SUtzN0pxcDdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0xhYzdKNkZJT3k1dE91VG5PdWx2Q0RyazdIcm9aM3RsWmpycWJRZzY3Q1U2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3SUNqc21ZVHJvNHdnN0pXSTY0SzBLUW9LSXlNaklPMmFqT3lia09xd2dPeWVoZXlkdENEc21ZVHJvNHpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNnJDQTdKNkY3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEc21JanNsYjNzbmJRZzdMZW83SWFNNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95WWlPeVZ2ZXlkaENEc3Q2anNob3p0bG9qc2xyVHNtcFF1Q2dvakl5TWc2Nnk0N0oyWTZyQ0FJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdJaWM3TENvN0tDQjdKeTg2NkdjSU91THRldXpnT3VUbk91bXJPcXlvT3lLdGV1TGlPdUxwQzRLTFNEcnJManNuWmpycGJ3ZzdLQ1I3SWlZN1phSTdKYTA3SnFVTGlBdklPeUluT3lFbk91TWdPdWhuQ0RyaTdYcnM0RHJrNXpycHJUcXNvenNtcFF1Q2dvakl5TWc3SVNrN0tDVjdKMjBJT3kwaU9xNHNPMlpsT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzaEtUc29KWHNuWVFnN0xTSTZyaXc3Wm1VN1phSTdKYTA3SnFVTGdvS0l5TWpJT3U1aE91d2dPdXlpTzJZdU9xd2dDRHJzNERxc3IzcmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SU91d2xPcS9xT3lXdE95YWxDNEtDaU1qSXlEc25ianNwcDNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHVPeW1uZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNaklPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUWdLT3luaU91c3VDRHNucXpxdGF6c2hMRXBDZ29qSXlNZzdKYTQ3S0NjSU91d3FldXN1TzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEcnNLbnJyTGdnNjRLZzdLZWM2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0phMDY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RycDR6cm80enJvWndnN0oyMDdKcXA3SjIwSU95a2tleW5nT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzbmJUc21xa2c2cml3NnJDRTdKMjBJT3VCbmV1Q21PeUVuQ0RzcDREcXVJanNuWUFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SnFwNjUrSklPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0lEc25xWHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lnZ095ZXBlMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVDZ29qSXlNZzdZYTE3SXVnSU95WXBPdWxtT3VobkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXWTdKaUE3SXExNjR1STY0dWtMZ290SU8yR3RleUxvT3lkdENEc201RHRtWnp0bFpqc3A0QWc3SldLN0pXRUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0pIcXQ3enNuYlFnNnJHdzY3YUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0phMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RxdG96dGxaenNuWVFnN0pxVTdMS3Q3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nN0lPQjdabXBJT3lWaU91Q3RDQW9NdXVMcUNEcXRhenNvYkFwQ2dvakl5TWc3SjZGNjZDbDdaV1k3SXVnSU95anZPeUdqT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnNjR1azdJdWNJTzJabGV5ZHVDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdLTzg3SWFNNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU91THBPeUxuQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lhbE95eXJlMlZtT3lMb0NEdGpwanNuYlRzcDREcnBid2c3TEMrN0oyRUlPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3WTZZN0oyMDdLZUE2Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEdGc0anRoN1R0bFpqcnFiUWc2NnFvNjVPZ0lPdU5zT3lkdE8yRXNPcXdnQ0RzZ3Ezc29KenJrSmpxczZBZzY0dWs3SXVjSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95Z2xldW5rQ0R0ZzRqdGg3VHRsYURxdVl6c21wUS9DZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeURnZTJacVNEc2xZanJnclFwQ2dvakl5TWc2N2FBN0o2c0lPeWtrU0Ryc0tucnJManNucERxc0lBZzZyQ1E3S2VBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91MmdPeWVyQ0RzcEpIc2w1QWc2N0NwNjZ5NDdKNlE2ckNBSU95ZWlPeVhpT3lXdE95YWxDNGdMeURzbUlIc2c0SHNuWVFnN1ptVjdKMjQ3WlcwSU91enRPeUV1T3lhbEM0S0NpTWpJeURxc3IzcnVZUWc3WlcwN0tDY0lPcTJqTzJWbk95ZHRDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZySzk2N21FSU8yVnRPeWduQ0RxdG96dGxaenNuYlFnN1pXRTdKcVU3WlcwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHNtcFRzc3EzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPMlpsT3llckNEcXNKRHNwNERxdUxBZzY3Q3c3WVN3NjZhczZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNEtMU0R0bVpUc25xd2c2ckNRN0tlQTZyaXdJT3V3c08yRXNPdW1yT3F3Z0NEc2xyenJwNGdnN0plRzdKYTA3SnFVTGlBdklPdXdzTzJFc091bXJPdWx2Q0RxdFpEc3NyVHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzdHBYc2xiMGdLeURxdUkzc29KVWc3S0NFN1ptWUlDanJrWkFnNjZ5NDdKNmxJT0tHa2lEcXVJM3NvSlh0bUpVZzdaV2NJT3VzdU95ZXBTa0tDaU1qSXlEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVUHlEc2xZenJwcnpzbllRZzdMeWM3S2VBSU95Vml1eWN2T3VwdENEc3BKSHNtcFR0bFp3ZzdJYU03SXVkN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU95VmpPdW12T3lkaENEc3ZKenJxYlFnN0tTUjdKcVU3WldjSU95R2pPeUxuZXlkaENEcnNKVHJvWndnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0o2UTY0K1o3SjIwN0xLMDY2VzhJT3VUc2V1aG5lMlZtT3luZ0NEc2xZcnFzNkFnNjRTWTdKYTA2ckNJNnJtTTdKcVVQeURyazdIcm9aM3RsWmpzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc25wRHJqNW5zbmJUc3NyVHJwYndnNjVPeDY2R2Q3WldZNjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJzN2dnNnJPRTdKVzk3SjJZSU95Y29PeWR2TzJWbkNEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3lkdk91d21PcTBnT3Vtck95ZWtPdWhuQ0RxdG96dGxaenJzNERxc3Izc25ZUWc3WldZN0l1a0lPeUltQ0RzbDRic2xyVHNtcFF1SU95ZHZPdXdtQ0RxdElEcnBxenNucERyb1p3ZzZyYU03WldjSU91emdPcXl2ZXlkaENEc201RHRsWmpzaTZRZzZySzk3SnF3SU91THBPdWx1Q0RzZ3F6cm5venNsNURxc293ZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtDRHF0b3p0bFp6c25ZUWc3S2VBN0tDVjdaVzBJT3lqdk95TG9DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZuQ0Rya3FRZzdKMjg2N0NZSU9xMGdPdW1yT3lla091aG5DRHJzNERxc3IzdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXpnT3F5dmUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvPScKQjY0X0dVSURFPSdJeUJWV0NCWGNtbDBhVzVuSU9xd2dPeWR0T3VUbkEwS0RRb2pJeUF4TGlEdGxiVHNtcFRzc3JRTkNnMEs3S0NjN1pLSUlPeVZpT3lkbUNEcnFxanJrNkFnNjZ5NDZyV3M2NHFVSUNmdGxiVHNtcFRzc3JRbjY2R2NJT3lOcU95YWxDNE5DdXlkdk9xMGdPeUVzU0Rzbm9qcmlwUWc3SUtzN0pxcDdKNlFJT3F5dmUyWG1PeWRoQ0RycDR6cms2UWc3SWlZSU95ZWlPdVBoT3VoblNBcUt1eURnZTJacVN3ZzY2ZWw2NTI5N0oyRUlPdTJpT3VzdU8yVm1PcXpvQ0RycXFqcms2QWc2Nnk0NnJXczdKZVFJTzJWdE95YWxPeXl0T3VsdkNEc29JSHNtcW50bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RyczdUcmc0WHJpNGpyaTZRZzRvYVNJT3V6dE91Q3ZPcXlqT3lhbEEwS0RRb3FLaW9OQ2cwS0l5TWdNaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0EwS0RRcnNvSnp0a29nZzdKV0k3SmVRN0lTY0lPeTFuT3VNZ08yVm5DQXFLdXVLcGV1UG1lMllsU0Ryckxqc25xVXFLdXlkaENEc2phanNvN3pzaExqc21wUXVJT3lJbU91UG1lMllsU0Ryckxqc25xWHNuWUFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNUzNzaUpqcmo1bnRtSlV0NjZ5NDdKNmw3SjJFTGV5TnFPdVBoQzNya0pqcmlwUXQ2cks5N0pxd0tleVhrQ0R0bGJUcmk3bnRsYUFnNjVXTTY2ZU1JT3lUc091S2xDRHFzb3dnN0tLTDdKV0U3SnFVTGcwS0RRb2pJeU1nNjVDUTdKYTA3SnFVSU9LR2tpRHRsb2pzbHJUc21wUU5DZzBLN0ppSUtRMEtMU0RzaEtUc29KWHJrSkRzbHJUc21wUWc0b2FTSU95RXBPeWdsZTJXaU95V3RPeWFsQTBLRFFvakl5TWdKMzdzbDRnbklPdTV2T3E0c0EwS0RRcnNtSWdwRFFvdElPdXdsT3VBak95WGlPeVd0T3lhbENEaWhwSWc2N0NVNnIrbzdKYTA3SnFVRFFvTkNpTWpJeURyajVuc2dxd2c2N0NVNnIrVTdKT3c2cml3RFFvTkN1eVlpQ2tOQ2kwZzY0YVM3SldFN0tHTTdKYTA3SnFVSU9LR2tpRHNtS3pybnBEc2xyVHNtcFFOQ2cwS0tpb3FEUW9OQ2lNaklETXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFOQ2cwSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEcnRvRHNvSlhzb0lFZzdMdWs2NjZrNjR1STdMeUE3SjIwN0lXWTdKMkVJT3kxbk91TWdPMlZuQ0RzcElUc25iVHFzNkFnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXlkaENEc2phanNvN3pzaExqc21wUXVEUXJydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVE10NjdhQTdLQ1Y3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzamFqc21wUXVEUW9OQ3V5WWlDQTZJT3lWaUNEcmo3enNtcFFzSU95WGh1eVd0T3lhbENBb1dDa2c0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSXlEc2w0YnNsclRzbXBRZzRvYVNJT3llaU95V3RPeWFsQTBLRFFyc21JZ3BEUW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxaanF1TEFnN0tDRTdKZVE2NHFVSU9xd2dPeWVoZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVJT0tHa2lEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaVzA3Slc4SU9xd2dPeWVoZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVEUW9OQ2lNakl5RHNsNURybjZ3ZzY2bVU3SXVjN0tlQURRb05DdXlYa091ZnJDRHNnNEh0bWFuc2w1RHNoSnpyajRRZ0l1MlZ0T3F5c0NEcnNLbnJzcFVpN0oyRUlPdW92T3lnZ0NEc2xZenJvS1Rzbzd6cmlwUWc2cmlON0tDVjdaaVZJT3Exck95aHNPdWhuQ0RzamFqc21wUXVEUW9OQ3V5WWlDa05DaTBnN0tlQTZyaUlJT3V5aE95Z2hPeVhrT3lFbk91S2xDRHNrN2dnN0lpWUlPeVhodXlXdE95YWxDNGc3SU9kN0xLMElPeWR1T3ltbmV5ZGhDRHNrN0Ryb0tUcnFiUWc3Sld4N0oyRUlPeTFuT3lMb0NEcnNvVHNvSVRzbkx6cm9ad2c3SmVGNjQydzdKMjA3WXE0SU8yVnRPeWp2T3lFdU95YWxDNGc0b2FTSU95VnNleWRoQ0RzbDRYcmpiRHNuYlR0aXJqdGxiVHNvN3pzaExqc21wUXVJT3lEbmV5eXRDRHNuYmpzcHAzc25ZUWc3Sk93NjZDazY2bTBJT3kxbk95TG9DRHJzb1Rzb0lUc25iUWc3WldFN0pxVTdaVzA3SnFVTGcwS0RRbzZPam9nZEdsd0lPMk1uZXlYaFNEcnNvVHRpcnpzbllBZ1d6Z3VJTzJNbmV5WGhWMGc2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQTBLN1l5ZDdKZUZLT3VMcE95ZHRPeVd2T3Vobk9xM3VDa2c2N0tFN1lxOElPdXN1T3Exck91S2xDRHNsWVRybnBnZ0tpbzRMaUR0akozc2w0VXFLaURzaExuc2haZ2c2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQ0RpZ0pRZzdZYTE2N08wNjRxVUlGdnRtWlhzbmJoZExDRHNtSWd2N0pXRTY0dUk3SmlrSU8yTWtPdUxxT3lkZ0NCYjdKV0U2NHVJN0ppa1hjSzNXK3VFcEYwc0lPdVBtZXlla1NEc25LRHJqNFRyaXBRZ1creTNxT3lHakYzQ3QxdnJqNW5zbnBGZExpQWk3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3ZzdKT3c2ck9nTENBaTY0dXI2cml3SU1LM0lPdVBtZXlla1NMc3NwanJuN3dnN0tlZDdKMjBJT3lWaUNEcnA1N3JpcFFnN0tHdzdaV3A3SjJBSU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFvNk9qb05DZzBLSXlNaklPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzdKaUlLUTBLTFNEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzRvYVNJT3lWdmVxMGdPeVhrQ0RyajVuc25aanRsWmpycWJRZzY2cW83SjZFN0tlQTdKdVE2cmlJN0oyRUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvakl5TWc3WmljN1lPZElPdU1nT3lEZ1NEc2xZanJnclFOQ2cwS0tpcnNoSnpydVlUc2lxVHJpcFFnN0pPNElPeUltQ0Rzbm9qc3A0RHJwNHdzSU8yS3VleWdsU0R0bUp6dGc1M3NuWUFnNjdDYjdKMkVJT3lJbUNEc2w0YnNuWVFnNjVXTUlPS0draURxdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPeU5xT3lhbEM0cUtnMEs3SUtzN0pxcDdKNlE2NHFVSU91c3VPcTFyT3VsdkNEcXZMenF2THp0bm9nZzdKMjk3S2VBSU95Vml1cXpvQ0R0bTVIc2xyVHJzN1RxdUxBbzdJcWs3THFVS1NEcmxZenJyTGpzbDVBc0lPdTJnT3lnbGUyWWxleWN2T3VobkNEc2s3RHJxYlFnN0tDYzdaS0lJT3lnaE95eXRPdWx2Q0RzazdnZzdJaVlJT3lYaHV1THBPcXpvQ0RzbUtUdGxiVHRsWmpxdUxBZzdJbXM3SnVNN0pxVUxnMEtEUXJzbUlncERRb3RJT3F6aE95aWpDRHFzSnpzaEtRZzdaaWM3WU9kN0oyQUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMaURpaHBJZ05DNDFKU0RxdUlqcnBxd2c3WmljN1lPZDY2ZU1JT3V3bSt5ZGhDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb3FLaW9OQ2cwS0l5TWdOQzRnN0xxUTdLTzg3SmE4N1pXY0lPcXl2ZXlXdEEwS0RRcnNvSnp0a29nZzdKV0k3SmVRN0lTY0lDZCs3SXVjNnJLZzdKYTA3SnFVUHljc0lDZnNpNXpyZ3Bqc21wUS9KeXdnSjM3cXU1Z25JT3F3bWV5ZGdDRHFzN3pyajRUdGxad2c2cks5N0phMDY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUXJzdFp6cmpJRHRsWndnN0xxUTdLTzg3SmE4N1pXWTZyT2dJT3k1bk9xM3ZPMlZuQ0RycDVEdGlLenJwYndnN0pPdzY0cVVJT3F5akNEc29vdnNsWVRzbXBRdURRcnFzcjNzbHJUcmlwUWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1pM3FzcjNzbHJUcnBid3Q3STJvNjQrRUxldVFtT3VLbEMzcXNyM3NtckFwN0plUUlPMlZ0T3VMdWUyVm9DRHJsWXpycDR3ZzdJMm83SnFVTGcwS0RRb2pJeU1nNjQrWjdJS3M3SmVRN0lTY0lDZCs3SXVjSnlEcnVienF1TEFOQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzdaVzA3S2VBN1pXWTdJdWM2cktnN0phMDdKcVVQeURpaHBJZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4TkNpMGc3SXVjN0o2UjdaV1k3SXVjNjRxVUlPdTJoT3lYa09xeWpDQTFMREF3TU95YmtPeWRoQ0RyazV6cm9LVHNtcFF1SU9LR2tpRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnMEtEUW9qSXlNZ0orcXpoT3lMbk91THBDY2c0b2FTSUNmc25vanJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKNlE2NCtaN0xDbzY2VzhJT3F3Z095bmdPcXpvQ0RxczRUc2k1enJncGpzbXBRL0lPS0draURzbnBEcmo1bnNzS2pxc0lBZzdKNkk2NEtZN0pxVVB3MEtMU0RycDZUcmk2d2c2N08wN1plWTY2T01JT3lXdk91bmlPeVVxU0RyZ3JUcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdUtsQ0RzbHJ6cnA0anNuYmpxc0lEc21wUS9JQ29vNjR1bzdJaWNJT3k1bU8yWm1PeWR0Q0RzbFlUcmk0anJuYndnNjZ5NDdKNmw3SjJFSU95RGlPdWhuQ0RzazdRZzdJS3M2NkdBN0ppSTdKcVVLU29OQ2cwS0l5TWpJQ2ZzbDZ6c3JZanJpNlFuSU9LR2tpQW43Wm1WN0oyNDdaV1k2NHVrTENEcnJMdnJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUg2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1SU9LR2tpRHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2Zxc0lEc3A0QWc2NHVrN0l1Y0lPMlpsZXlkdU8yVm9PcXlqT3lhbEM0TkNnMEtJeU1qSUNmcXU1Z25JT0tHa2lBbjdKZVE2cktNSncwS0RRcnNtSWdwRFFvdElPMlpqZXE0dU91UG1ldUxtT3E3bUNEcmdxRHNsWVRxc0lEcXM2QWc3SjZJN0phMDdKcVVMaURpaHBJZzdabU42cmk0NjQrWjY0dVk3SmVRNnJLTUlPdUNvT3lWaE9xd2dPcXpvQ0Rzbm9qc2xyVHNtcFF1RFFvTkNpTWpJeURxc3Izc2xyVHJwYndnNjdxUTdKMkVJT3VWakNEc2xyVHNnNG50bFp3ZzZySzk3SnF3RFFvTkN1eUNyT3lhcWV5ZWtPeWRtQ0Rzb0pYcnM3VHJwYndnNjdDYjY0cVVJT3luaU91c3VPeVhrT3lFbkNEcXVMRHFzNFRzb0lIc25MenJvWndnSjM3c2k1d242Nlc4SU91NmtPeWRoQ0RybFl3ZzY2eTQ3SjZsN0oyMElPeVd0T3lEaWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0tpcnRqSXpzbFlYdGxaanFzNkFnN0l1MjdKMkFJT3lnbGV1enRPdWx2Q0FuN0tPODdKYTBKK3VobkNEc2phanNoSndnNjZ5NDdKNmw3SjJFSU95RGlPdWhyZXF5akNEc2phanJzN1RzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhnNG9hU0lPdU1nT3kybkNEcnFxbnNvSUhzbmJRZzY2eTA3SmVIN0oyNDZyQ0E3SnFVUHcwS0xTRHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOGc0b2FTSU95TG9PcXpvQ0RzbmJUc25LRHJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUV1T3lhbEM0TkNnMEtLaW9xRFFvTkNpTWpJRFV1SUNkNzY2cUY3SUtzZlNBcklIdnJxb1hzZ3F4OUp5RHNrN0RzcDRBZzdKV0s2cml3RFFvTkNpTWpJeUR0bFp6c25wRHNsclFnN1pLQTdKYTA3Sk93NnJpd0RRb05DdTJWbk95ZWtPeVd0Q0RycW9Yc2dxenJwYndnN1pLQTdKYTA3SVNjSU91UG1leUNyQ0R0bUpYdGc1enJvWndnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdKMjA3SjZRSU8yWm1PdTJpT3lkaENEcnNKdnNsWmpzbHJUc21wUWc0b2FTSU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRTkNpMGc2NEswN0oyOElPeTV0T3VUbk9xd2t1eWR0Q0Rxc3JEc29KenJrS0FnN0ppSTdLQ1Y3SjIwN0plUTdKcVVJT0tHa2lEcmdyVHNuYnpzbllBZzdMbTA2NU9jNnJDU0lPdUNtT3F3Z091S2xDRHJncURzbmJUc2w1RHNtcFFOQ2cwS0l5TWpJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclRzazdEcXVMQWc3SmEwNjZDazdKcTRJT3F5dmV5YXNBMEtEUW9uZSt1cWhleUNySDNxc0lBZ2UrdXFoZXlDckgzdGxiVHNoSnduSU8yWWxlMkRuT3Vobk91bmpDRHRrb0RzbHJUc3BKanJqNFFnNjQyVUlPeTZrT3lqdk95V3ZPMlZtT3F5akNEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2NJT3Exck91bnBPMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUWc0b2FTSU95ZWxPeVZvZXlkdENEcnRvRHNvYkh0bGJUc2hKd2c2cldzNjZlazdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTmk0ZzdaR2M2cml3SU8yR3RleWR2QTBLRFFvakl5TWc2NUNZN0phMDdKcVVJQ2hZS1NEaWhwSWc2NCs4N0pxVUlDaFBLUTBLRFFycnFxanJzSlRzbmJ3ZzdabVU2Nm0wN0oyWUlPeWlnZXlkZ0NEcXM3WHFzSVRzbllRZzZyT2c2NkNrN1pXMElDZnJrSmpzbHJUc21wUW42NHFVSU91cXFPdVJrQ0FuNjQrODdKcVVKK3VobkNEdGhyWHNuYnp0bGJUc2hKd2c3STJvN0tPODdJUzQ3SnFVTGcwS0RRb3FLaW9OQ2cwS0l5TWdOeTRnNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3lJcSt5ZWtDRHRrWnpxdUxBTkNnMEs2NEtnN0tlY3dyZnNpNXpxc0lUQ3QrdXlpTzJZdU91S2xDRHNsWVRybnBnZzdaaVY3SXVkN0p5ODY2R2NJTzJHdGV5ZHZPMlZ0T3lFbkNEc2phanNtcFF1RFFvTkNpTWpJeURyZ3FEc3A1ekN0K3lMbk9xd2hNSzM2cml3NnJDRURRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnNjRLZzdLZWNJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1RVMHVSRVJnSUh3Z01qQXlOUzR3TVM0d01Td2dNalV1TURFdU1ERWdmQTBLZkNEc2k1enFzSVFnZkNEcXVMRHJzN2dnWUVoSU9rMU5PbE5UWUNBdklPeW5wK3F5akNCZ1NFZzZUVTFnSUNqc21LVHNvSVF2N0ppazdadUVJT3lWaUNEc2xJQXBJSHdnTVRRNk16QTZNVEVzSURFek9qTXdJSHdOQ253ZzZyaXc2ckNFSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRWZsbFpXVmt1VFUwdVJFUmdJQzhnN0tlbjZyS01JR0JaV1ZsWkxrMU5Ma1JFZmsxTkxrUkVZQ0I4SURJd01qVXVNREV1TURGK01qQXlOUzR3TVM0ek1Td2dNakF5TlM0d01TNHdNWDR3TVM0ek1TQjhEUXA4SU91Q29PeW5uQ0FySU95TG5PcXdoQ0I4SUdCWldWbFpMazFOTGtSRUlFaElPazFOWUNCOElESXdNalV1TURFdU1ERWdNVFE2TXpBZ2ZBMEtmQ0RzbXBUc25id2dmQ0JnV1ZsWldTNU5UUzVFUkNqc21wVHNuYndwWUNEaWdKUWc3SnVVTCsyWmxDL3NpSmd2NjZxcEwrcTRpQy90aHFBdjdKMjhJSHdnTWpBeU5TNHdNUzR3TVNqc2lKZ3BJSHdOQ2cwS0tpcnNpNXpxc0lRZzdKaUk3Sm00S2lvNklPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDQmc3SmlrN0tDRUwreVlwTzJiaENCSU9rMU5ZT3lkaENEc2phanJqNFFnNjQrODdKcVVMZzBLN0ppSUtTRHNtS1R0bTRRZ01Ub3dNQTBLRFFvakl5TWc2Nnk0N0o2bElPeUdqU0RzbDdEc201VHNuYndOQ2cwSzY2eTQ3SjZsSU95VmlPeVhrT3lFbk91S2xDQXFLdXlibE1LMzdKMjhJT3lWbnV5ZG1DQXc3SjJFSU91NXZPcXpvQ29xSU95TnFPeWFsQzROQ2cwSzdKaUlLUTBLTFNBeU1ESTI2NFdFSURBNDdKdVVJREExN0oyOElPeWVoZXVMaU91THBDNGc0b2FTSURJd01qYnJoWVFnT095YmxDQTE3SjI4SU95ZWhldUxpT3VMcEM0TkNnMEtJeU1qSU95RGdldU1nQ0RzaTV6cXNJUWdLT3VGdU95Mm5PeWFxU2tOQ2cwS2ZDRHNvYkRxc2JRZ2ZDRHRrWnpxdUxBZ2ZBMEtmQzB0TFMwdExYd3RMUzB0TFMxOERRcDhJRFl3N0xTSUlPdXZ1T3VuakNCOElPdXdxZXE0aUNEc29JUWdmQTBLZkNBMk1PdTJoQ0RycjdqcnA0d2dmQ0JPNjdhRUlPeWdoQ0I4RFFwOElESTA3SXVjNnJDRUlPdXZ1T3VuakNCOElFN3NpNXpxc0lRZzdLQ0VJSHdOQ253Z016RHNuYndnNjYrNDY2ZU1JSHdnVHV5ZHZDRHNvSVFnZkEwS2ZDQXhNdXF3bk95YmxDRHJyN2pycDR3Z2ZDQk82ckNjN0p1VUlPeWdoQ0I4RFFwOElERXk2ckNjN0p1VUlPeWR0T3lEZ1NCOElFN3JoWVFnN0tDRUlId05DZzBLN0ppSUtTRHJzS25xdUlnZzdLQ0VMQ0ExNjdhRUlPeWdoQ3dnTXV5TG5PcXdoQ0Rzb0lRc0lEUHNuYndnN0tDRUxDQTI2ckNjN0p1VUlPeWdoQ3dnTXV1RmhDRHNvSVFOQ2cwS0l5TWpJT3VuaU9xd2tNSzM2cml3NnJDRUlPdW5qT3VqakEwS0RRcGdSQzFPWUNoTzdKMjhJT3VDcU95ZGpDa2dMeUJnUkMwd1lDanNtS1RyaXBnZzY2ZUk2ckNRS1NBdklHQkVLMDVnS0U3c25id2c2cks5NnJPOEtRMEs3SmlJS1NCRUxUY3NJRVF0TVN3Z1JDMHdMQ0JFS3pFTkNnMEtJeU1qSU91eWlPMll1Q0R0a1p6cXVMQWdLTzJWbU95ZHRPMlVpT3ljdk91aG5DRHF0YXpydG9RcERRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnN0tDRTdabVU2N0tJN1ppNElId2c3WldZN0oyMDdaU0lJT3Exck91MmhDQjhJREF5TFRFeU16UXROVFkzT0N3Z01ERXdMVEV5TXpRdE5UWTNPQ0I4RFFwOElPeTV0T3VUbk91eWlPMll1Q0I4SURUc25wRHJwcXpzbEtrZzdaV1k3SjIwN1pTSUlId2dNVEl6TkMwMU5qYzRMVGt3TVRJdE16UTFOaUI4RFFwOElPcXpoT3lpak91eWlPMll1Q0I4SU8yVm1PeWR0TzJVaUNEcXRhenJ0b1FnZkNBeE1qTXRORFUyTFRjNE9UQXhNaUI4RFFwOElPeWp2T3V2dk91VHNldWhuZXV5aU8yWXVDQjhJT3lWbmlBMjdKNlE2NmFzTGV1U3BDQTM3SjZRNjZhc0lId2dNVEl6TkRVMkxURXlNelExTmpjZ2ZBMEtmQ0RzZ3F6c2w0WHNucERyazdIcm9aM3Jzb2p0bUxnZ2ZDQXhNT3lla091bXJDRHRsWmpzbmJUdGxJZ2dmQ0F3TVMweU16UXROVFkzT0RrZ2ZBMEtEUW9qSXlNZzdKT3c2Nm0wSU95VmlDRHJrSmpyaXBRZzdaR2M2cml3RFFvTkNpMGc2NEtnN0tlYzdKZVFJTzJWbU95ZHRPMlVpTUszNjdtWDZyaUlPaURpbll3Z01qQXlOUzB3TVMwd01Td2dNREV2TURFTkNpMGc3SXVjNnJDRTdKZVFJT3lZcE95Z2hDL3NtS1R0bTRRNklPS2RqQ0RzbUtUc29JUWdNZXlMbkNBcUtPdUxxQ3dnN0lLczdKcXA3SjZRNnJDQUlPeW5nZXlna1NEcXM2RHJwYlRyaXBRZzY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSU95WWlPeVp1Q2txRFFvTkNpb3FLZzBLRFFvakl5QTRMaUR0akozc2w0VW82NHVrN0oyMDdKYTg2NkdjNnJlNEtRMEtEUXJ0akozc2w0VWc2Nnk0NnJXczY0cVVJQ29xN0pldDdaV2dLaW9vN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2Q25xczd3Z0tpcnNuS0R0bUpVcUtpanRoclhyczdRdjdZeVE2NHVvS2V5WGtDRHJsTERybmJ3ZzY2eTQ3TEswNnJDQUlPdUxyT3Vkdk95YWxDNGc3WU9BN0oyMDdZdUE3SjJFSU91THBPdVRyT3lkaENEcmxaQWc2N0NZNjVPYzdJdWNJT3lWaU91Q3RDanJzN2pyckxncDZybU03S2VBSU9xd21leWR0Q0RyczdUcXM2QXNJT3V6dU91c3VDRHJwNlhybmIzc25ZUWc2NHUwN0pXRTdKVzhJTzJWdE95YWxDNE5DZzBLSXlNaklERHJpNmpxczRRZzRvQ1VJTzJLdU91bXJPcXhzT3UyZ08yRXNDRHJ0SkRzbXBRTkNnMEs3WXlkN0plRjdKMjBJT3lDck95YXFleWVrT3lkbUNEc2xyVHJscVFnN1phSjY0K1pJT3VTcE95WGtDRHJuS2pyaXBUc3A0QWc2Nmk4N0tDQUlPMk1qT3lWaGUyVnRPeWFsQzROQ2cwS0xTRHRsb25yajVuc25ZUWdLaXJxc0lEcm9aenJwNG5xc2JEcmdwZ2c3WXlRNjR1bzdKMkVJT3lhbE9xMXJDb3FLT3lkdE8yRGlNSzM3SUt0N0tDY3dyZnJvWnpxdDdqc2xZVHNtNFBDdCt5aWhldWpqQ2tnNG9hU0lDb3E3WXlRNjR1bzdaaVZLaW9nS091c3ZPeVd0T3Uwa095YWxDa05DaTBnNnJLdzZyTzh3cmZzZzRIdGc1enJwYndnS2lydGhyWHJzN1RycDR3cUtpQW83Sm1FNjZPTXdyZnNpNlR0aktncElPS0draUFxS3V5VmlPdUN0TzJZbFNvcUlDanNsWXpyb0tUc3BKanNtcFFwRFFvTkNpTWpJeUR0ZzREc25iVHRpNEFnNG9DVUlPeW5wK3lkZ0NEcnFvWHNncXpxdGF3TkNnMEtMU0RycW9Yc2dxenRtSlhzbkx6cm9ad2c2NEdkNjRLMDdKcVVMaURzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5PdWx2Q0RzazdEc3A0QWc3SldLN0pXRTdKcVVJQ2grN0pxVUlDOGdmdXVMcENBdklIN3F1WXpzbXBRL0lPS2RqQ2t1RFFvdElESitOT3lXdE95Z2lPdWhuQ0RzcDZmcXM2QWc3SW05NnJLTUxpRHRsWnpzbnBEc2xyVEN0K3lJbU95TG5leWRoQ0RxdUxqcXNvd2c3SXlUN0tlQUlPeVZpdXlWaE95YWxDNE5DaTBnN0pXSTY0SzBLT3V6dU91c3VDa2c2NmVsNjUyOTdKMkVJT3lhbE95VnZlMlZ0Q3dnS2lydGc0RHNuYlR0aTREcnA0d2c2N1NRNjQrRUlPdXN0T3lLcUNEdGpKM3NsNFhzbmJqc3A0QXFLaURzbFl6cXNvd2c3WlcwN0pxVUxpRHNtNURyczdqc25iUWdKK3lWak91bXZNSzM3Wm1WN0oyNEoreXltT3VmdkNEcnA0bnNsN0R0bFpqcnFiUWc2N080NjZ5NDdKMkVJT3Ezdk9xeHNPdWhuQ0RxdGF6c3NyVHRtWlR0bGJUc21wUXVEUW9OQ253ZzdKMjA2NkNINnJLTUlPdW5rT3F6b0NCOElPeWR0T3VnaCtxeWpDQjhEUXA4TFMwdGZDMHRMWHdOQ253ZzdLQ0E3SjZsN1pXWTdLZUFJT3lWaXVxem9DRHJncGpxc0lEc2k1enFzcURzbHJUc21wUS9JSHdnN0tDQTdKNmxJT3lWaUNEdGxad2c2NEswN0pxcElId05DbndnN0pXTTY2YThJSHdnNnJLdzdLQ2NJT3laaE91ampDQjhEUXA4SU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JSHdnNjQydzdKMjA3WVN3SU95Q3JleWduQ0I4RFFvTkNpTWpJeURzbFlqcmdyUW82N080NjZ5NEtTRGlnSlFnN1pXMDdKcVU3TEswRFFvTkNpMGdLaXJ0akpEcmk2anRtSlVxS3V5ZGdDQW5mdTJWb09xNWpPeWFsRDhuNjZHY0lPdXN2T3lXdE95YWxDNGc2NUNZNjQrTTY2YTBJT3lJbUNEc2w0YnJpcFFnN0p5RTdaZVlLT3lDcmV5Z25NSzM3WU9JN1llMElPdVRzU25zbllBZzZyS3c2ck84NjZXOElPdW92T3lnZ0NEcXNyM3FzNkR0bGJUc21wUXVEUW90SUNvcTdKV0k2NEswN1ppVktpcnNuWUFnN0lLczdJdWs3SjJFSU95RW5PeUlvTzJWdE95YWxDNE5DaTBnNjZlSTdMbW83WkdjNjZXOElPeU5xT3lhbEM0ZzdJaXI3SjZRd3Jmc29iRHFzYlFvN0oyMDdJT0J3cmZzbmJUdGxaakN0K3lkdE91Q3RDRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWkRxczZBc0lPeWJrT3VzdU95WGtDRHNsNGJyaXBRZzdLQ1Y2N08wd3Jmc29JanNzS2pDdCt5WHNPdWR2ZXl5bU91bHZDRHNwNERzbHJUcmdyVHNwNEFnN0pXSzdKV0U3SnFVTGcwS0RRb2pJeU1nNjdLRTdZcThJT0tBbENEc2xZanJnclFnNjZ5NDY2ZWw3SjIwSU95Z2xlMlZ0T3lhbEEwS0RRcDhJT3V6dU91c3VPeWR0Q0RzbmJUcm9JZnJpNlFnZkNEcnNvVHRpcndnZkEwS2ZDMHRMWHd0TFMxOERRcDhJT3F5c09xenZNSzM3SU9CN1lPYzY2VzhJTzJHdGV1enRDQjhJRnZ0bVpYc25iaGRJSHdOQ253Z0ozN3RsYURxdVl6c21wUS9KK3VobkNEcnJMenNuWXdnZkNCYjdKV0U2NHVJN0ppa1hTREN0eUJiNjRTa1hTQjhEUXA4SU95RGdlMlpxU0RzaEp6c2lLQWdLeURzbUtUcnBianNxcjNzbmJRZzdJdWs3S0NjSU91UG1leWVrU0I4SUZ2c3Q2anNob3hkSU1LM0lGdDc2NCtaN0o2UmZWMGdmQTBLRFFvdElDZnN0NmpzaG93bjY0cVVJQ29xNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUtpb2c3STJvN0pxVUlDanNtSWc2SUZ2c3Q2anNob3hkd3JkYjdJS3Q3S0NjWFNrdUlDZnJpNnZxdUxBZ3dyY2c2NCtaN0o2UkoreXltT3VmdkNEc3A1M3NuYlFnN0pXSUlPdW5udXVLbENEc29iRHRsYW5zbmJUcmdwZ2c2NHVvNjQrRklDZnN0NmpzaG93bjY0cVVJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW90SU91eWhPMkt2T3lkbUNEcmo1bnNucEVnN0oyMDY2YUU3SjJBSU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGhDRHF0N2pyaklEcm9ad2c3SUswNjZDazdKcVVMZzBLRFFvakl5TWc3WWExN0tlY0lPeVlpT3lMbkEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdKMjA3WU9JS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURzb0lEc25xVWc3SldJSU8yVm5DRHJnclRzbXFrTkNpMGc3SldJNjRLME9pRHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4ZzdKNkY2NkNsN1pXY0lPdUN0T3lhcWV5ZHRDRHNncXpybmJ6c29ManNtcFF1RFFvdElPdXloTzJLdkRvZzdKV0U2NHVJN0ppa0lNSzNJT3VFcEEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdJS3Q3S0NjSUNqc25JVHRsNWdwS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURyamJEc25iVHRoTEFnN0lLdDdLQ2NEUW90SU95VmlPdUN0RG9nN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEc2dyVHJwclFnN0lpWUlPeVhodXlXdE95YWxDNGc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3MEtMU0Ryc29UdGlydzZJT3lWaE91TGlPeVlwQ0RDdHlEcmhLUU5DZzBLS2lycmo1bnNucEh0bUpVZzRvQ1VJT3lFbk95SW9DQXJJT3VQbWV5ZWtTRHJzb1R0aXJ3cUtnMEtMU0R0ZzREc25iVHRpNEE2SU9xNHNPcTRzQ0RzbDdEcXNyQWc3WlcwN0tDY0RRb3RJT3lWaU91Q3REb2c3SVNnN1lPZDdaV2NJT3E0c09xNHNPeWRtQ0RzbDdEcXNyRHNuWVFnNjRHSzdKYTA3SnFVTGcwS0xTRHJzb1R0aXJ3NklPeTNxT3lHakNEQ3R5RHNsN0Rxc3JBZzdaVzA3S0NjRFFvTkNpb3E3SldJNjRLMDdaaVZJT0tBbENEc21ZVHJvNHdnN1lhMTY3TzBLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHFzckRzb0p3ZzdKbUU2Nk9NRFFvdElPeVZpT3VDdERvZzZyS3c3S0NjNnJDQUlPeWdsZXlEZ1NEc3NwanJwcXpya0pEc2xyVHNtcFF1RFFvdElPdXloTzJLdkRvZzdabVY3SjI0RFFvTkNpb3FLZzBLRFFvaklPeVlpT3ladUNEcXQ1enN1WmtOQ2cwSzdKdVE3TG1aS091S3BldVBtY0szNnJpTjdLQ1Z3cmZzdXBEc283enNscndwNjdPMDY0dWtJT3lZaU95WnVPcXdnQ0RyalpRZzY2cUY3Wm1WN1pXY0lPeTdwT3V1cE91TGlPeThnT3lkdE95Rm1PeWRoQ0RycDR6cms1enJpcFFnNnJLOTdKcXc3SmlJN0pxVUxnMEtEUW9qSXlEc21JanNtYmdnTVM0ZzdJaVk2NCtaN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzY1Q1k2NHFVSU9xeXZleWFzQTBLRFFvakl5TWc3SVNjNjdtRTdJcWtJT3lpaGV1ampDd2c2cml3NnJDRUlPdW5qT3VqakEwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95anZPeVd0Q2pzb29Ycm80d2c3SVNjNjdtRTdJcWtMQ0RxdUxEcXNJUWc2NU94S2V1bHZDRHFzSlhzb2JEdGxhQWc3SWlZSU95ZWlPcXpvQ3dnSit5aWhldWpqQ2ZzbVlBZ0ordW5qT3VqakNmc25aZ2c2NG1ZN0pXWjdJcWs2Nlc4SU95Z2xlMlpsZTJlaUNEc29JVHJpNnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNCUFQwOGc3SVNjNjdtRTdJcWtJT3lpaGV1ampDRHNsWWpyZ3JRZzRvQ1VJREF3N0p1VUlEQXc3SjI4NjdhQTdZU3dJT3lFbk91NWhPeUtwT3F3Z0NEc29vWHJvNHpyajd6c21wUXVJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWVFnN0pXTTY2Q2s2NU9jNjZDazdKcVVMZzBLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZzBLRFFycmk2Z3NJQ29xN0tPODZyaXc3S0NCN0p5ODY2R2NJT3lpaGV1ampPcXdnQ0Ryc0pqcnM3WHJrSmpyaXBRZzdLQ2M3WktJS2lyc2w1RHJpcFFnSit5aWhldWpqT3VQdk95YWxDZnJwYndnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURzb29Ycm80enJqN3pzbXBRZzRvYVNJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxBMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKZVE2cktNSU91dnVPeTVtT3VLbENEc21JSHRscVhzbllRZzdKV002NkNrN0tTRUlPdVZqQTBLRFFvbzdLTzg3SnFVSU91UG1leUNyQ0E2SU95WHNPeXl0Q3dnN1pXMDdLZUFMQ0Rzb0lIc21xa2c2NU94S1EwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95ZHVPcXp2Q0RxdElEcXM0VHJwYndnNjZxRjdabVY3WldZNnJLTUlPeUVwT3VxaGUyVm1PcXpvQ3dnSit5Q3JPeWFxZXlla095ZG1DRHRsb25yajVuc2w1QWc2NVN3NjUyODdKaWs2NHFVSU9xeXNPcXp2Q2ZybmJ6cmlwUWc3S0NRN0oyRUlPeVZqT3VncE95a2hDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeVlwT3VLbU9xNWpPeW5nQ0RyZ3JUc3A0QWc3SldLN0p5ODY2bTBJT3lYc095eXRPdVB2T3lhbEM0ZzdadUU2N2FJNnJLdzdLQ2NJT3E0aU95Vm9leWRoQ0RyZ3JUc283enNoTGpzbXBRdURRb3RJT3VNZ095Mm5PeWRoQ0Rxc0lqc2xZVHRnNERycWJRZzdKdVE2NTZZSU91TWdPeTJuT3lkdENEdGxiVHNwNERyajd6c21wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXaWV5WGtDRHJnclRzbGJ3ZzdaVzA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95VmlPeUxyQ0FvN0lpWTY0K1o3WmlWS1EwS0RRb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3SXVjN0lxazdZV2M3SjIwSU95ZWtPdVBtZXljdk91aG5DRHNzcGpycHF6dGxaenJpNlRyaXBRZzdLQ1FLaXJzbllRZzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95ZHRPeWduT3UyZ08yRXNDRHRtWTNxdUxqcmo1bnJpNWpzblpnZzZyQ2M3SjI0N0tDVjY3TzBJT3lkdE95YXFTRHJnclRzbDYzc25iUWc2cml3NjZHZDY0Kzg3SnFVRFFvdElPdU5sQ0Rzb292c25ZQWc3SU9CNjR1MDdKMkVJT3ljaE8yVnRDRHRoclh0bVpRZzY0SzA3SnFwN0oyQUlPdUZ1ZXlkak91UHZPeWFsQTBLRFFvakl5RHNtSWpzbWJnZ01pNGc2cks5N0phMDY2VzhJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3RFFvTkN1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKMllJT3VucGV1ZHZleWRoQ0R0bVp6c21xbnRsYlRzaEp3ZzdLZUk2Nnk0N1pXZ0lPdVZqQTBLRFFvbjdJdWM2NEtZN0pxVVB5Y3NJQ2ZzaGFqcmdwanNtcFEvSnlEdG1KWHRnNXpzblpnZzZySzk3SmEwNjZXOElPMlpuT3lhcWUyVnRPeUVuQ0RzZ3F6c21xbnNucERzblpnZzY0dTU3Wm1wN0lxazY1K3M3SnVBN0oyRUlPeWtoT3lkdkNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1Dd2dUMDlQSU91THBPdUZnT3lZcE95RnFPdUNtT3lhbEQ4TkNpMGc3TGFwN0tDRTdaV1k2NStzSU8yT3VPeWRtT3lna0NEcXNJRHNpNXpyZ3Bqc21wUS9EUW9OQ2lNakl5RHNncXpzbXFuc25wRHNuWmdnN0lPQjdabXA3SjJFSU95MmxPeWdsZTJWb0NEcmxZd05DZzBLNjZxRjdabVY3WldjSU95Z2xldXp0T3F3Z0NEc2w0YnNsclRzaEp3ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU95bmdleWdrU0R0akpEcmk2anRsWmpxc293ZzdaVzA3Slc4SU8yVm9DRHJsWXdnNnJLOTdKYTA2NkdjSU95Z2xleWtrZTJWbU9xeWpDRHNwNGpyckxqdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHN1YlRyazV6cnBid2c2N0NiN0p5ODdJV282NEtZN0pxVVB5RHJrN0hyb1ozdGxaanJxYlFnN0xxUTdJdWM2N0N4SU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtPeWRtQ0RzaEtEc25aanFzSUFnN1pXRTdKcVU3WldnSU91VmpBMEtEUXJzaEtUcnJManNvYkRzZ3F6c3NwanJuN3dnN0lLczdKcXA3SjZRN0oyWUlPeUVvT3lkbU91bHZDRHF1TERyaklEdGxiVHNsYndnN1pXZ0lPdVZqQ0Rxc3Izc2xyVHJvWndnN0tDVjdLU1I3WldZNnJLTUlPeW5pT3VzdU8yVnRPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25iVHJzb2dnNjR1czdKZVFJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bFpqcnFiVHNoSndnN0phODY2ZUk2NEtZSU91bmpPeWhzZTJWbU95RnFPdUNtT3lhbEQ4TkNnMEtJeU1nN0ppSTdKbTRJRE11SU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU91UW1PdUtsQ0Rxc3Izc21yQU5DZzBLN0lLczdKcXA3SjZRN0plUTZyS01JT3VxaGUyWmxlMlZtT3F5akNEcnRvRHNvSlhzb0lIc25iZ2c2NEswN0pxcDdKMkVJT3lWak91Z3BPeWttT3lWdkNEdGxhQWc2NVdNNjRxVUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPeWlpK3lWaE95YWxDNE5DZzBLSXlNaklPeUVuT3U1aE95S3BPdWx2Q0Rzb0pYc3NZWHNnNEVnN0pPNElPeUltQ0RzbDRic25ZUWc2NVdNRFFvTkN1dTJnT3lnbGUyWWxleWN2T3VobkNEc2phanNsYndnN0lLczdKcXA3SjZRN0plUTZyS01JT3lEZ2UyWnFleWRoQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN0l1YzdZS3NJT3lJbUNEc25vanNsclRzbXBRdUlDb3E3Sk80SU95SW1DRHNsNGJyaXBRZzdKMjA3SnlnNjZXOElPMlZxT3E3bUNEc2xZanJnclR0bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RzcDREcXVJanNuWUFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJT3l5cmV5R2pPdUZoT3lkaENEc25JVHRsWndnN0lTYzY3bUU3SXFrNjRxVUlPeVZoT3luZ1NEc3BJRHJ1WVFnN0tTUjdKMjA3SmVRN0pxVUxnMEtMU0RxczdYcnJMVHNtNURzbllBZzdadUU3SnVRNnJpSTdKMkVJT3V6dE91Q3ZDRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzY3YUE3S0NWN1ppVjdKeTg2NkdjSU95TnFPeVZ2Q0RzZ3F6c21xbnNucERxc0lBZzdKYTA2NWFrSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95WGh1dUtsT3luZ0NEcnFvWHRtWlh0bFpqcXNvd2c3SjI0N0tlQTdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrTkNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGcwS0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UUlPeUVvTzJEbmV5ZG1DRHFzckRxczd6cnBid2c3SldJNjRLMDdaV2dJT3VWakEwS0RRcnJrSmpyajR6cnByUWc3SWlZSU95WGh1dUtsQ0RzaEtEdGc1M3NuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMlZtT3F5akNEc2xZenJvS1RzbXBRdURRb05DdXlZaUNrTkNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrTkNnMEtKK3lnbGV1enRDRHNpSmpzcDVFZzdKV0k2NEswSnlEcms3SHNuWmdnNjYrODZyQ1E3WldjSU95RGdlMlpxZXlYa095RW5DQXFLdXlnbGV1enRPcXdnQ0RyczdUdG1ManJrSnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeURnZXVMdE95ZHRDRHJnWjNyZ3BqcnFiUWc3S0NFNjZ5NDZyQ0E2NCtFSU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHJwYndnNjdPOElPeUltQ0RzbDRic2xyVHNtcFF1RFFvdElPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1Rxc0lBZzZyaXc2NkdkNjVDWTdLZUFJT3lWaXV5VmhPeWFsQzROQ2cwS0l5TWc3SmlJN0ptNElEUXVJT3lnbk8yU2lDRHNtcW5zbHJUcmlwUWc2N0NVNnI2NDdLZUFJT3lWaXVxNHNBMEtEUW9uNnJDRTZyS3c3WldZNnJPZ0lPeUpyT3lhdENEcnA1QW5JT3lia095NW1ldXp0T3VMcENBcUt1MlpsT3VwdE95ZG1DRHF1TERyaXFYcnFvWEN0K3V5aE8yS3ZPdXFoZXF6dk95ZG1DRHNtcW5zbHJRZzdKMjg3TG1ZS2lycXNJQWc3SnF3N0lTZzdKMjA3SmVRN0pxVUxnMEs2cml3NjRxbDY2cUY3SmVRSU95VHNPeWR1Q0RyaTZqc2xyUW82N09BNnJLOUxDRHNwNERzb0pVc0lPdVRzZXVoblNEcms3RXA2Nlc4SU95VmlPdUN0Q0RyckxqcXRhenNsNURzaEp3ZzY0dWs2Nlc0SU91bmtPdWhuQ0Ryc0pUcXZyanJxYlFnN0lLczdKcXA3SjZRNnJDQUlPdUxwT3VsdUNEcXVMRHJpcVhzbkx6cm9ad2c3SmlrN1pXMDdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrZ0orcTJqTzJWbkNEcnM0RHFzcjBuSU9xNHNPdUtwZXlkbUNEc2xZanJnclFnNjZ5NDZyV3NEUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxaanJxYlFnNjdDVTZyK0FJT3lJbUNEc25vanNsclRzbXBRZ0tGZ3BEUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxaanJxYlFnNjdPQTZySzk3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJT3lZaU95WnVDQTFMaURzaTV6c2lxVHRoWndnNjQrWjdKNlI2ck84SU91THBPdWx1Q0RyajVuc2dxd2c3Sk93N0tlQUlPeVZpdXE0c0EwS0RRcnJyTGpxdGF6cnBid2c3SldFNjZ5MDY2YXNJT3VucE91QmhPdWZ2ZXF5akNEcmk2VHJrNnpzbHJUcmo0UWdLaXJzaTZUc29Kd2c3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyaTZUcnBiZ2c2NCtaN0lLc0tpcnJwYndnN0pPdzY2bTBJT3llbU91cXUrdVFuQ0RyckxqcXRhenNtSWpzbXBRdURRb05DdXlZaUNrZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWx2Q0FuN0xhVTZyQ0FJT3luZ095Z2xTZnRsWmpyaXBRZzdJdWM3SXFrN1lXYzdKZVE3SVNjSUNqc25iVHNvSVRDdCt5V2tldVBoQ0RxdUxEcmlxWHNuYlFnN0pXRTY0dVlLUTBLTFNEcmk2VHJwYmdnN0lLczY1Nk03SmVRNnJLTUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJwYndnNjRTWTZyS283S084N0lTNDdKcVVJQ2hZSU9LQWxDRHNsNGJyaXBRZ0ordUVtT3E0c09xNHNDY2c2cml3NjRxbDdKMkVJT3lWbE95TG5Da05DaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVnRDRHNvN3pzaExqc21wUWdLRThwRFFvPScKRElSPSIkSE9NRS9MaWJyYXJ5L0FwcGxpY2F0aW9uIFN1cHBvcnQvQ2xhdWRlQnJpZGdlIgpwdXQoKSB7IHByaW50ZiAlcyAiJDEiIHwgYmFzZTY0IC1EID4gIiQyIjsgfQojIOydtCAuY29tbWFuZOqwgCDrj4TripQg7YSw66+464SQIOywveunjCDqs6jrnbwg64ur64qU64ukKHR0eSDrp6Tsua0pLiBiYXNo6rCAIOuBneuCmCDtg63snbQgaWRsZeuQnCAx7LSIIOuSpOyXkCDri6vslYQKIyAi7ZSE66Gc7IS47IqkIOyLpO2WiSDspJEiIOqyveqzoOulvCDtlLztlZzri6Qg4oCUIGRpc293buycvOuhnCDsiqTtgazrpr3tirjqsIAgZXhpdO2VtOuPhCDri6vquLAg7J6R7JeF7J2AIOyCtOyVhOuCqOuKlOuLpC4gKOunpSDsi6TquLAg6rKA7KadIO2VhOyalCkKTVlUVFk9IiQocHMgLW8gdHR5PSAtcCAkJCAyPi9kZXYvbnVsbCB8IHRyIC1kICIgIikiCmNsb3NlX3Rlcm1pbmFsKCkgewogIFsgLXogIiRNWVRUWSIgXSAmJiByZXR1cm4KICAoIHNsZWVwIDEKICAgIC91c3IvYmluL29zYXNjcmlwdCA+L2Rldi9udWxsIDI+JjEgPDxPU0EKdGVsbCBhcHBsaWNhdGlvbiAiVGVybWluYWwiCiAgcmVwZWF0IHdpdGggdyBpbiB3aW5kb3dzCiAgICB0cnkKICAgICAgcmVwZWF0IHdpdGggdCBpbiB0YWJzIG9mIHcKICAgICAgICBpZiB0dHkgb2YgdCBpcyAiL2Rldi8kTVlUVFkiIHRoZW4gY2xvc2UgdyBzYXZpbmcgbm8KICAgICAgZW5kIHJlcGVhdAogICAgZW5kIHRyeQogIGVuZCByZXBlYXQKZW5kIHRlbGwKT1NBCiAgKSAmIGRpc293biAyPi9kZXYvbnVsbCB8fCB0cnVlCn0KIyDslYjrgrTripQg7ZSM65+s6re47J247J20IOuztOyXrOykgOuLpCDigJQg7YSw66+464SQ7J2AIOyEpOy5mMK37KCQ6rKA66eMIO2VmOqzoCDsiqTsiqTroZwg64ur7Z6M64ukLgpmaW5pc2goKSB7IGNsb3NlX3Rlcm1pbmFsOyBleGl0ICIkMSI7IH0KZWNobyAi7YG066Gc65OcIOy7pOuEpe2EsOulvCDshKTsuZjtlZjqs6Ag7J6I7Ja07JqU4oCmIOyeoOyLnCDtm4Qg7J20IOywveydgCDsnpDrj5nsnLzroZwg64ur7ZiA7JqULiIKbWtkaXIgLXAgIiRESVIvc2NyaXB0cyIgfHwgeyBlY2hvICLtj7TrjZQg7IOd7ISxIOyLpO2MqDogJERJUiI7IGZpbmlzaCAxOyB9CnB1dCAiJEI2NF9CUklER0UiICAgIiRESVIvc2NyaXB0cy9jbGF1ZGUtYnJpZGdlLmpzIgpwdXQgIiRCNjRfV0FUQ0hFUiIgICIkRElSL3NjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanMiCnB1dCAiJEI2NF9FWEFNUExFUyIgIiRESVIvcmVjb21tZW5kLWV4YW1wbGVzLm1kIgpwdXQgIiRCNjRfR1VJREUiICAgICIkRElSL3V4LXdyaXRpbmcubWQiCmVjaG8gIuKchSDtjIzsnbwg7ISk7LmYOiAkRElSIgojIEdVSeyXkOyEnCDsl7AgVGVybWluYWzsnYAgUEFUSOqwgCDsooHsnYQg7IiYIOyeiOyWtCDtnZTtlZwg7ISk7LmYIOqyveuhnOulvCDrs7Ttg6Dri6QKZXhwb3J0IFBBVEg9IiRIT01FLy5sb2NhbC9iaW46L29wdC9ob21lYnJldy9iaW46L3Vzci9sb2NhbC9iaW46JFBBVEgiCiMgbm9kZeqwgCDsl4bsnLzrqbQg6rCQ7Iuc7J6QKD1ub2RlKSDsnpDssrTqsIAg66q7IOuPjOyVhCDtlIzrn6zqt7jsnbjsl5Ag7JWM66a0IOuwqeuyleydtCDsl4bri6Qg4oaSIOydtCDqsr3smrDrp4wg64Sk7J207Yuw67iMIO2MneyXheycvOuhnCDslYjrgrTtlZzri6QKaWYgISBjb21tYW5kIC12IG5vZGUgPi9kZXYvbnVsbCAyPiYxOyB0aGVuCiAgb3Nhc2NyaXB0IC1lICdkaXNwbGF5IGRpYWxvZyAi7J20IE1hY+yXkCBOb2RlLmpz6rCAIOyXhuyWtOyalC4gW+2ZleyduF3snYQg64iE66W066m0IOuLpOyatOuhnOuTnCDtjpjsnbTsp4DqsIAg7Je066Ck7JqULiBOb2RlLmpzKExUUynrpbwg7ISk7LmY7ZWcIOuSpCDsnbQg7ISk7LmYIO2MjOydvOydhCDri6Tsi5wg7Iuk7ZaJ7ZW0IOyjvOyEuOyalC4iIHdpdGggdGl0bGUgIu2BtOuhnOuTnCDsu6TrhKXthLAg4oCUIE5vZGUuanMg7ZWE7JqUIiBidXR0b25zIHsi7ZmV7J24In0gZGVmYXVsdCBidXR0b24gMSB3aXRoIGljb24gY2F1dGlvbiBnaXZpbmcgdXAgYWZ0ZXIgMTgwJyA+L2Rldi9udWxsIDI+JjEKICBvcGVuICJodHRwczovL25vZGVqcy5vcmcva28vZG93bmxvYWQiIDI+L2Rldi9udWxsCiAgZmluaXNoIDAKZmkKTk9ERV9CSU49IiQoY29tbWFuZCAtdiBub2RlKSIKZWNobyAi4pyFIE5vZGUuanM6ICQobm9kZSAtLXZlcnNpb24pIgojIOqwkOyLnOyekCBsYXVuY2hkIOuTseuhnSAo66Gc6re47J24IOyekOuPmeyLnOyekSArIOyngOq4iCDquLDrj5kpLiBQQVRI66W8IHBsaXN07JeQIOq1s+2YgCDrhKPripTri6Qg4oCUIGxhdW5jaGQg6riw67O4IFBBVEjsl5QgY2xhdWRl6rCAIOyXhuuLpC4KUExJU1Q9IiRIT01FL0xpYnJhcnkvTGF1bmNoQWdlbnRzL2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlci5wbGlzdCIKbWtkaXIgLXAgIiRIT01FL0xpYnJhcnkvTGF1bmNoQWdlbnRzIgpTQUZFX1BBVEg9IiR7UEFUSC8vJi8mYW1wO30iCmNhdCA+ICIkUExJU1QiIDw8UExJU1RFT0YKPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPCFET0NUWVBFIHBsaXN0IFBVQkxJQyAiLS8vQXBwbGUvL0RURCBQTElTVCAxLjAvL0VOIiAiaHR0cDovL3d3dy5hcHBsZS5jb20vRFREcy9Qcm9wZXJ0eUxpc3QtMS4wLmR0ZCI+CjxwbGlzdCB2ZXJzaW9uPSIxLjAiPgo8ZGljdD4KICA8a2V5PkxhYmVsPC9rZXk+PHN0cmluZz5jb20uY2xhdWRlYnJpZGdlLndhdGNoZXI8L3N0cmluZz4KICA8a2V5PlByb2dyYW1Bcmd1bWVudHM8L2tleT4KICA8YXJyYXk+CiAgICA8c3RyaW5nPiROT0RFX0JJTjwvc3RyaW5nPgogICAgPHN0cmluZz4kRElSL3NjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanM8L3N0cmluZz4KICA8L2FycmF5PgogIDxrZXk+RW52aXJvbm1lbnRWYXJpYWJsZXM8L2tleT4KICA8ZGljdD48a2V5PlBBVEg8L2tleT48c3RyaW5nPiRTQUZFX1BBVEg8L3N0cmluZz48L2RpY3Q+CiAgPGtleT5SdW5BdExvYWQ8L2tleT48dHJ1ZS8+CiAgPGtleT5LZWVwQWxpdmU8L2tleT48ZGljdD48a2V5PlN1Y2Nlc3NmdWxFeGl0PC9rZXk+PGZhbHNlLz48L2RpY3Q+CjwvZGljdD4KPC9wbGlzdD4KUExJU1RFT0YKbGF1bmNoY3RsIGJvb3RvdXQgImd1aS8kKGlkIC11KS9jb20uY2xhdWRlYnJpZGdlLndhdGNoZXIiIDI+L2Rldi9udWxsCmxhdW5jaGN0bCBib290c3RyYXAgImd1aS8kKGlkIC11KSIgIiRQTElTVCIgMj4vZGV2L251bGwgfHwgbGF1bmNoY3RsIGxvYWQgLXcgIiRQTElTVCIgMj4vZGV2L251bGwKIyBjbGF1ZGUg7Jyg66y0wrfroZzqt7jsnbgg7Jes67aA64qUIOyXrOq4sOyEnCDslYzrpqzsp4Ag7JWK64qU64ukIOKAlCDqsJDsi5zsnpDqsIAg6re4IOyDge2DnOulvCDtlIzrn6zqt7jsnbjsl5Ag7KCE64us7ZW0CiMg6rOE7KCVIO2ZlOuptOydtCAi7ISk7LmYIO2VhOyalCAvIOuhnOq3uOyduCDtlYTsmpQgLyDspIDruYQg7JmE66OMIuuhnCDrhbjstpztlZzri6Qo7YSw66+464SQ7J20IOyxhOuEkOydtCDslYTri5gpLgojIOyEpOy5mMK37KCQ6rKAIOuBnSDihpIg7LC97J2EIOyKpOyKpOuhnCDri6vripTri6QuCmZpbmlzaCAwClBLAQIeAxQAAAgAAAAAAADlpHGd/3ECAP9xAgAbAAAAAAAAAAAAAADtgQAAAADtgbTroZzrk5wt7Luk64Sl7YSwLmNvbW1hbmRQSwUGAAAAAAEAAQBJAAAAOHICAAAA";
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
