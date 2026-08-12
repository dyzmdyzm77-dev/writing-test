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
const BRIDGE_MIN_V = 30;
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
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21saw0KWjJVcENpOHZJT3k4bk91UmtPdXB0Q0R0bEl6cm42enF0N2pzbmJqc25aZ2dXK3kybE95eW5PdXdtK3E0c0YzcXNJQWdSMlZ0YVc1cElPMkNwQ0RzbDRic25iVHJqNFFnN1lHMDY2R2M2NU9jNjZHY0lFRkpJT3kybE95eW5PeWRoQ0Ryc0p2cmlwVHJpNlF1Q2k4dkNpOHZJT3lHamV1UGhDRHNoS1RxczRRNklPMkJ0T3Vobk91VG5PdWx2Q0RzbXBUc3NxM3JwNGpyaTZRZzdJT0k2NkdjSU95TG5PdVBtZTJWbU91cHRDQXpNSDQwTU95MGlPcXdnQ0RxdDdqcmc2VWc2NEtnN0pXRTZyQ0U2NHVrTGdvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0NpOHZJQ0FnNnJDQTdKMjA2NU9jSyt5WWlPeUxuQ2d4TVRIcXNiUXA2NHFVSU95eXF5RHJxWlRzaTV6c3A0RHJvWndnN1pXY0lPdXlpT3VuakNEc25iM3QNCm5venJpNlF1SU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjZ5NDZyV3M2NmVNSU91enRPdUN0T3V2Z091aG5DRHJ1YURycGJUcmk2UXVDaTh2SU95RXVPeUZtT3lkZ0NBek1PdXlpQ0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3WlcwSU91TWdPMlpsT3F3Z0NEcnJMVHRsWnp0bm9nZzZyaTQ3SmEwN0tlQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaTh2Q2k4dklPeWdoT3lnbkRvZzdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0NjQrOElPeWVpT3lkaENEcXNvTWdLR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3Snk4NjZHY0lPMlpsZXlkdUNrS0x5OGc3S084N0oyWU9pRHNncXpzbXFucm40bnNuWUFnNnJDQjdKNlFJTzJCdE91aG5PdVRuQ0RxdGF6cmo0VWc3WldjNjQrRTdKZVE3SVNjSU95d3FPcXdrT3VRbk91THBDNEtDbU52Ym5OMElHaDBkSEFnUFNCeVpYRjFhWEpsS0Nkb2RIUndKeWs3Q21OdmJuTjBJR1p6SUQwZ2NtVnhkV2x5WlNnblpuTW5LVHNLDQpZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdA0KWTNka0p5azdDblJ5ZVNCN0lHWnpMbTFyWkdseVUzbHVZeWhGVFZCVVdWOURWMFFzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsSUgwcE95QjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUXBqYjI1emRDQkRURUZWUkVWZlJVNVdJRDBnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnY0hKdlkyVnpjeTVsYm5Zc0lIc0tJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcENpQWdRMHhCVlVSRlgwTlBSRVZmUkVsVFFVSk1SVjlPVDA1RlUxTkZUbFJKUVV4ZlZGSkJSa1pKUXpvZ0p6RW5MQ0F2THlEdGhMUWc3SnFVN0pXOUlPdVRzU0RydG9EcXNJQWc3Wmk0N0xhY0lPdUJsQW9nSUVSSlUwRkNURVZmVkVWTVJVMUZWRkpaT2lBbk1TY3NDbjBwT3dvS0x5OGc3SWlvNnJtQUlPeUxwTzJXaVNqcXNKRHNpNXpzbnBBZzdJcWsNCjdZK3c3SjJBSUhOMFpHbHZJR2xuYm05eVpTbnNsNURzaEp6cmo0UWc2Nnk0N0tDYzY2VzhJT3kybE95Z2dlMlZvQ0RzaUpnZzdKNkk2cktNSU95OW1PeUdsQ0Ryb1p6cXQ3anJwYndnN1l5TTdKMjg3SmVRNjQrRUlPdUNxT3E0dE91THBDNEtMeThnN0p5RTdMbVlPaURzbm9Uc2k1d2c3WSswNjQyVTdKMllJR05zWVhWa1pTMWljbWxrWjJVdWJHOW5JQ2pzbklqcmo0VHNtckFnSlZSRlRWQWxMQ0RycDZVZ0pGUk5VRVJKVWlrdUlESk5RaURyaEpqc25MenJxYlFnTG05c1pPdWhuQ0R0bFp3ZzdJUzQ2NHlBNjZlTUlPdXp0T3EwZ0M0S1kyOXVjM1FnVEU5SFgwWkpURVVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExteHZaeWNwT3dwamIyNXpkQ0JmYjNKcFoweHZaeUE5SUdOdmJuTnZiR1V1Ykc5bkxtSnBibVFvWTI5dWMyOXNaU2s3Q21OdmJuTnZiR1V1Ykc5bklEMGdablZ1WTNScGIyNGdLQ2tnZXdvZ0lHTnZibk4wSUdGeVozTWdQU0JCY25KaGVTNXdjbTkwDQpiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bg0KYVdaNUtHRXBLU2t1YW05cGJpZ25JQ2NwSUNzZ0oxeHVKenNLSUNBZ0lHWnpMbUZ3Y0dWdVpFWnBiR1ZUZVc1aktFeFBSMTlHU1V4RkxDQnNhVzVsS1RzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHRqSXpzbmJ3ZzY2R2M2cmU0SU95THBPMk1xTzJWdE91UGhDRHJpNlRycHF6cmlwUWc2ck9FN0lhTklDb3ZJSDBLZlRzS0NtTnZibk4wSUZCUFVsUWdQU0JPZFcxaVpYSW9jSEp2WTJWemN5NWxibll1UWxKSlJFZEZYMUJQVWxRcElIeDhJREV4T0RnNE95QXZMeUJDVWtsRVIwVmZVRTlTVk91S2xDRHRoWXpzaXFUdGlyanNtcWtnS08yUGlleUdqT3lYbENBeE1UZzRPQ0RxczZEc29KVXBDaTh2SU91THBPdW1yQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0F2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDNGc3TDJVNjVPYzY2VzhJSEIxYkd6Q3QrdXp0ZXlDck8yVnRPdVBoQ0FxS3V5ZHRPdXZ1Q0RybHFBZzdKNkk2NHFVSU91THBPdW1yT3VLbENEc21Kc2c3TDJVNjVPY0lPcTN1T3VNZ091aG5Db3ENCjY1MjhDaTh2SU9xN2tPdUxwQ0Rzdkp6cXVMQWc3S0NFN0plVUlPeURpQ0RyajVuc25wSHNuYlFnN0pXSUlPdUNtT3lZcU91THBDanRoTERycjdqcmhKRHNuYlFnNjV5bzY0cVVJT3VUc1NrdUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEc25iUWc2ckNTN0p5ODY2R2NJT3Exck91eWhPeWdoT3lkaENEcXNKRHNwNER0bGJRZzdKNnM3SXVjN0o2UjdJdWM3WUtvNjR1a0xnb3ZMeURyajVuc25wSHNuYlFnNjdDVTY0Q002NHFVSU95SW1PeWdsZXlkaENEdGxaanJxYlFnN0oyMElPeUlxK3lla091bHZDRHNtS3pycHF6cXM2QWdZMjlrWlM1MGMreWRtQ0JDVWtsRVIwVmZUVWxPWDFicmo0UWc2ckNaN0oyMElPeVlyT3Vtc091THBDNEtZMjl1YzNRZ1FsSkpSRWRGWDFZZ1BTQXpNRHNLTHk4ZzZyaXc2N080SU91cXFPdU51QzRnN0pxVTdMS3RLTzJVak91ZnJPcTN1T3lkdUNuc25iUWdiVzlrWld6c25ZUWc3S2VBN0tDVjdaV1k2Nm0wSU9xM3VDRHNtcFRzc3EzcnA0d2c2cmU0SU91cXFPdU51T3VobkNEc3NwanJwcXp0DQpsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPYw0KSUNoeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUWc0b0NVSUdKMWFXeGtMV2RzYjNOellYSjVMbXB6N0ptQUlPcXdtZXlkZ0NEdGpJenNoSndwSU9LVWdPS1VnQXBtZFc1amRHbHZiaUJzYjJGa1JYaGhiWEJzWlhNb0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzFrSUQwZ1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNzSUNkeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUW5LU3dnSjNWMFpqZ25LVHNLSUNBZ0lHTnZibk4wSUhObFkwbGtlQ0E5SUcxa0xuTmxZWEpqYUNndlhpTWpJT3kybE95eW5DRHNtSWpzaTV4Y2N5b2tMMjBwT3dvZ0lDQWdhV1lnS0hObFkwbGtlQ0E5UFQwZ0xURXBJSEpsZEhWeWJpQmJYVHNLSUNBZ0lHTnZibk4wSUdWNFlXMXdiR1Z6SUQwZ1cxMDdDaUFnSUNCc1pYUWdZM1Z5SUQwZ2JuVnNiRHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjbUYzSUc5bUlHMWtMbk5zYVdObEtITmxZMGxrZUNrdWMzQnNhWFFvSjF4dUp5a3ANCklIc0tJQ0FnSUNBZ1kyOXVjM1FnYkdsdVpTQTlJSEpoZHk1eVpYQnNZV05sS0M5Y2N5c2tMeXdnSnljcE93b2dJQ0FnSUNCamIyNXpkQ0JvSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYaU1qSTF4ekt5Z3VLejhwWEhNcUpDOHBPd29nSUNBZ0lDQnBaaUFvYUNrZ2V5QmpkWElnUFNCN0lHbHVjSFYwT2lCb1d6RmRMQ0J6ZFdkblpYTjBhVzl1Y3pvZ1cxMGdmVHNnWlhoaGJYQnNaWE11Y0hWemFDaGpkWElwT3lCamIyNTBhVzUxWlRzZ2ZRb2dJQ0FnSUNCamIyNXpkQ0JpSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYbHh6S2kxY2N5c29MaXMvS1Z4ektpUXZLVHNLSUNBZ0lDQWdhV1lnS0dJZ0ppWWdZM1Z5S1NCamRYSXVjM1ZuWjJWemRHbHZibk11Y0hWemFDaGlXekZkTG5Od2JHbDBLQ2NnTHlBbktTNXFiMmx1S0NjZ0p5a3BPd29nSUNBZ2ZRb2dJQ0FnY21WMGRYSnVJR1Y0WVcxd2JHVnpMbVpwYkhSbGNpZ29aU2tnUFQ0Z1pTNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dQaUF3S1RzS0lDQjlJR05oZEdOb0lDaGxLU0I3DQpDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpdw0KSU9xem9PeTVxQ0FySU95V3RPeUluQ0RyczREcXNyMGk3SjIwSU91UW5PdUxwQzRnN0pldDdaV2dJT3UyaE91bXJDRGlnSlFLTHk4ZzdZRzA2NkdjNjVPY0lEMGc2Nnk0N0o2bElPdUxwT3VUck9xNHNDanNzTDNzblpncExDRHNtcW5zbHJRZzdZYTE3SjI4d3JmcnA1N3N0cVRyc3BVZ1BTQmpiMlJsTG5SeklISmxabWx1WlVGcFUzVm5aMlZ6ZEdsdmJuTWc3WnVFN0xLWTY2YXNLT3E0c09xemhPeWdnU2t1Q21OdmJuTjBJRk5VV1V4RlgxSlZURVZUSUQwZ1d3b2dJQ2N4TGlEdGxiVHNtcFRzc3JRNklPdXFxT3VUb0NEcnJManF0YXpyaXBRZzdaVzA3SnFVN0xLMDY2R2NMaUFvNjdPMDY0T0Y2NHVJNjR1azRvYVM2N08wNjRLMDdKcVVLU2NzQ2lBZ0p6SXVJT3VLcGV1UG1leWdnU0RycDVEdGxaanF1TEE2SU91UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDd2dmdXlYaUNEcnVienF1TEFvNjdDVTY0Q003SmVJN0phMDdKcVU0b2FTNjdDVTZyK283SmEwN0pxVUtTNGc2NHVvTENEc29vWHJvNHpDdCt1bmpPdWoNCmpNSzM3SmV3N0xLMHdyZnRsYlRzcDREQ3QrcTRzT3VobmNLMzY0VzU3SjJNSU91VHNTRHNpNXpzaXFUdGhaenNuYlFnN0tPODdMSzA3SjI0SU9xeXNPcXp2T3VLbENEc2lKanJqNW50bUpVZzdKeWc3S2VBS095WHNPeXl0T3VQdk95YWxDd2c2NFc1N0oyTTY0Kzg3SnFVS1M0bkxBb2dJQ2N6TGlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd09pQWlmdTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVJaURyaklEc2k2QWdJbjd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWlJT3Exck95aHNDRHNtckRzaEtBdUlPdUxxQ3dnN0tDVjdMR0Y3SU9CSU91MmlPcXdnTUszN0oyODY3YUFJT3E0c091S3BTRHNvSnp0bFp6Q3QrdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3F5c09xenZNSzM3S0NWNjdPMElPdXp0TzJZdUNEc2xZanNpNnpzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJlaUM0bkxBb2dJQ2MwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phME9pQis3WldZN0l1YzZyS2c3SmEwDQo3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cA0KTGljc0NpQWdKell1SU8yUm5PcTRzRG9nNjVDWTdKYTA3SnFVNG9hUzY0Kzg3SnFVTGljc0NpQWdKemN1SU95a2hDRHF0YXpzb2JBNklPeWJrT3V6dU95ZHRDRHRsWndnN0tTRTdKMjA2Nm0wSU95MmxPeXluT3VQaENEcnNKanJrNXpzaTV3ZzdaV2NJT3lraE91aG5DNGc3SjZFN0oyWTY2R2NJT3lraE95ZGhDRHJpcGpycHF6c3A0QWc3SldLNjRxVTY0dWtMaURyaTZnc0lPeVhyT3VmckNEcnJManNucVhzbllRZzdaV1k2NEtZN0oyWUlPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25MenJvWndnN1pXcDdMT1FJT3VObENEcXNJVHFzckR0bGJUc3A0VHJpNlRycWJRZzdLU0VJT3lJbU91bHZDRHNwSVRzbmJUcmlwUWc2cktEN0oyQUlPMlptT3lZZ1M0bkxBb2dJQ2M0TGlEdGpKM3NsNFVvNjR1azdKMjA3SmE4NjZHYzZyZTRLU0Ryc29UdGlydzZJT3F5c09xenZDRHRoclhyczdUcmlwUWdXKzJabGV5ZHVGMHNJT3lZaUMvc2xZVHJpNGpzbUtRZzdZeVE2NHVvN0oyQUlGdnNsWVRyaTRqc21LUmRMMXZyaEtSZExDRHINCmo1bnNucEVnN0p5ZzY0K0U2NHFVSUZ2c3Q2anNob3hkTDF0NzY0K1o3SjZSZlYwdUlDTHN0NmpzaG93aTY0cVVJT3VQbWV5ZWtTRHJzb1R0aXJ6cXM3d2c3S2VkN0oyOElPdVZqT3VuakNEc2s3RHFzNkFnSXV1THErcTRzTUszNjQrWjdKNlJJdXl5bU91ZnZDRHNwNTBnN0pXSUlPdW5udXVLbENEc29iRHRsYW5DdCt1THFPdVBoU0FpN0xlbzdJYU1JdXVLbENEcXVJanNwNEF1Snl3S0lDQW5PUzRnN0oyMDY2YUV3cmZzb0lUdG1aVHJzb2p0bUxqQ3QrdW5pT3lLcE8yQ3VleWRnQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzBMaURzZ3F6cm5venNuWVFnNjdhQTY2VzhJT3VWa0NEcmk1anNuWVFnNjdhWjdKZXM2NCtFSU95aWkrdUxwQzRuTEFvZ0lDY3hNQzRnN0tDYzdaS0lJT3lhcWV5V3RDRHNuS0RzcDRBNklPeWVoZXVncGV5WGtDRHNrN0RzbmJnZzZyaXc2NHFsN0lTeElPdXFoZXlDckNqcnM0RHFzcjBzSU95bmdPeWdsU3dnNjVPeDY2R2RMQ0R0bGJUc29Kd2c2NU94S2V1S2xDRHRtWlRycWJUc25aZ2c2cml3DQo2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqcw0KaUpqcmo1bnRtSlhDdCtxeXZleVd0TUszNjdhQTdLQ1Y3WmlWSU8yWGlPeWFxU0RzdklEc25iVHNpcVFwN0oyWUlPdUptT3lWbWV5S3BPcXdnQ0RzbktEc2k2VHJrSnpyaTZRdUNpOHZJTzJNak95ZHZPeWR0Q0RzbDRic25MenJxYlFvN0lTazdMbVk2N080SU9xMXJPdXloT3lnaENEcms3RXBJT3U1aUNEcnJManNucERzbDdRZzRvQ1VJT3lhbE95VnZldW5qT3ljdk91aG5DRHJqNW5zbnBFb1ptRnBiQzF6YjJaMEtTNEtablZ1WTNScGIyNGdiRzloWkVkMWFXUmxLQ2tnZXdvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdFpDQTlJR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bkxDQW5kWGd0ZDNKcGRHbHVaeTV0WkNjcExDQW5kWFJtT0NjcExuUnlhVzBvS1RzS0lDQWdJSEpsZEhWeWJpQnRaQzVzWlc1bmRHZ2dQaUF4TURBZ1B5QnRaQ0E2SUNjbk93b2dJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2lxVHQNCmc0RHNuYndnNnJDQTdKMjA2NU9jSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lhbE95VnZldW5qT3ljdk91aG5DRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z0p5YzdDaUFnZlFwOUNtTnZibk4wSUVkVlNVUkZJRDBnYkc5aFpFZDFhV1JsS0NrN0NncG1kVzVqZEdsdmJpQnBibk4wY25WamRHbHZiazFsYzNOaFoyVW9LU0I3Q2lBZ1kyOXVjM1FnWm1WM1UyaHZkQ0E5SUVWWVFVMVFURVZUTG0xaGNDZ29aWGdwSUQwK0lDZEpibkIxZERvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtHVjRMbWx1Y0hWMEtTQXJJQ2RjYms5MWRIQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExuTjFaMmRsYzNScGIyNXpLU2t1YW05cGJpZ25YRzRuS1RzS0lDQnlaWFIxY200Z0tBb2dJQ0FnSit5bmdPcTRpT3UyZ08yRXNDRHJoSWpyaXBRZzdKZVE3SXFrN0p1UUtGTXRNU3dnNjdPMDdKV0k3WnFNN0lLc0tleWRtQ0R0bFp6cXRhM3NsclFnVlZnZ1YzSnBkR2x1WnlEc29JVHJyTGpxDQpzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91TA0KcEM0Z0p5QXJDaUFnSUNBbjdLR3c2ckcwSU8yUm5PMlloQ2pzbmJUc2c0SEN0K3lkdE8yVm1NSzM3SjIwNjRLMHdyZnN0SWpxczd6Q3QrdXZ1T3Vuak1LMzY3YUE3WVN3d3JmcXVZenNwNEFnNjVPeEtleWRnQ0Rzb0pYc3NZVWc3S0NWNjdPMDY0dWtJT0tBbENEcnVienFzYkRyZ3BnZzY0dWs2Nlc0SU95aHNPcXh0T3ljdk91aG5DRHJzSlRxdnJqc3A0QWc2NmVJNjUyOEtDSTE3WnFNSU95ZHRPeURnU0xzbllRZ0lqWHRtb3dpNjZHY0lPeWtoT3lkdE91cHRDRHNtS1RyaTdVcExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc2w1QWc3SmVHNjRxVUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN0l1YzZyQ0VJT3VUc1Nuc21ZQWc3WlcwNnJLd0lPdXdxZXV5bGNLMzdLQ0k3TENvS095ZXJPeUVwT3lnbGNLMzY2eTQ3SjJZN0xLWXdyZnNucXpzaTV6cmo0UWc2NU94S2V1bHZDRHNwNERzbHJUcmdyUWc2N2FaN0oyMDY0cVVJT3F5Zyt5ZGdDRHNvSWpyaklBZzZyaUkNCjdLZUFJT0tBbENEc2xZVHJpcFFnNnJDUzdKMjA2NTI4NjQrRUxDRHF0N2pybjdUcms2L3RsYlRyajRRZzdKT3c3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSnpQcXNKd2c3S0NjN0pXSTdKMkFJT3lFbk91aG5DRHNvSkhxdDd6c25iUWc2NHVzNjUyODdKVzhJTzJWbk91THBDRGlnSlFnN1pXWTY0S1k2NHFVSU95YmtPdXN1Q0RxdGF6c29iRHJwYndnN0p5ZzdLZUE3WldjSU95MW5PeUdqQ0RyaTZUcms2enF1TEFzSU8yVm1PdUNtT3VLbENEcnJManNucVVnNnJXczdLR3c2Nlc4SU95ZXJPcTFyT3lFc2UyVm5DRHJqSURzbFlnc0lDY2dLd29nSUNBZ0orcTN1T3Vtck9xem9DRHNvSUhzbHJUcmo0UWc3WldZNjRLWTY0cVVJT3F6dk9xd2tPMlZuQ0RzbnF6cXRhenNoTEU2SU95a2tldXp0U0R0a1p6dG1JVHNuWVFnNjQyYzdKYTA2NEswNnJPZ0xDRHNvSlhyczdRZzdJaWM3SVNjNjZXOElPeUNyT3lhcWV5ZWtPcXdnQ0RzbFl6c2xZVHNsYndnN1pXZ0lPcXlnK3UyZ08yRXNPdWhuQ0RzbnF6c29iRHNwNEh0DQpsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZw0KSUNBZ0oreVZoT3VlbUNEc21JanNpNXpyazZUc25ZQWc3WldjSU95a2hPeW5uT3VtckNEc3RaenNob3dnNnJXUTdLQ1Y3SjIwSU91bmp1eW5nT3VuakNEcXQ3anFzYlFnN1lha0tPMlZ0T3lhbE95eXRNSzM2cks5N0phMEtleWRtQ0RxdFpEcnM3anNuYlRzcDRBZzdJYU02cmU1N0lTeDdKMllJT3Exa091enVPeWR0Q0RzbFlUcmk0anJpNlFnNG9DVUlPeVhyT3VmckNEcnJManNucVhzcDV6cnBxd2c3SjZGNjZDbDdKMkFJT3VwbE95TG5PeW5nQ0RyaTZqc25JVHJvWndnNjR1azdJdWNJT3lFcE9xemhPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURyc0xEc2w3VHJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoY0szN0wyVTY1T2M3WTZjN0lxa0lPcTRpT3luZ0RwY2JpY2dLd29nSUNBZ0oxdDdJblJsZUhRaU9pQWk3S0NjN0pXSUlPdXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2cNCkl1dXN0T3lYaCt5ZGhDRHNtWndnNjdDVTZyK282NHFVN0tlQUlPMlZuT3ExcmV5V3RDRHRsWndnNjZ5NDdKNmxJbjBzSUM0dUxsMWNibHh1SnlBckNpQWdJQ0FuVyt5S3BPMkRnT3lkdkNEcXQ1enN1WmxkWEc0bklDc2dVMVJaVEVWZlVsVk1SVk1nS3lBblhHNWNiaWNnS3dvZ0lDQWdLRWRWU1VSRklEOGdKMXZzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jSU95Z2hPdXN1Q0FvZFhndGQzSnBkR2x1Wnk1dFpDa2c0b0NVSU95Y2hDRHF0NXpzdVpuc25aZ2c2cmU4NnJHdzdKbUFJT3lZaU95WnVDRHNpNXpyZ3BqcnBxenNtS1F1SU8yS3VlMmVpQ0RzbUlqc21iZ2c2cmVjN0xtWktPeUltT3VQbWUyWWxjSzM2cks5N0phMHdyZnJ0b0Rzb0pYdG1KWHNuWVFnN0p5ZzdLZUE3WlcwN0pXOElPMlZtT3VLbENEc2c0SHRtYWtwN0oyRUlPcTN1T3VNZ091aG5DRHJsTERycGJUcXM2QXNJT3lhbE95VnZlcXp2Q0Rzb0lUcnJManNuYlFnNjR1azY2VzA2Nm0wSU95Z2hPdXN1T3lkaENEcmxMRHJwYmpyaTZSZFhHNG5JQ3NnDQpSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cA0KYm1WQ2RXWWdQU0FuSnpzZ0lDQWdJQ0FnSUNBdkx5QnpkR1J2ZFhRZzdLU0VJT3V5aE8yTnZBcHNaWFFnZDJGcGRHVnlJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDOHZJTzJZaE95ZXJDRHRoTFRzblpnZ2V5QnlaWE52YkhabExDQnlaV3BsWTNRc0lIUnBiV1Z5SUgwS2JHVjBJSEYxWlhWbElEMGdVSEp2YldselpTNXlaWE52YkhabEtDazdJQzh2SU95YWxPeXlyU0RzcDRIcm9LenRtWlFnS091UG1leUxuQ0RzbXBUc3NxM3NuWUFnN0lpYzdJU2M2NHlBNjZHY0tRcHNaWFFnZEhWeWJuTWdQU0F3T3dwc1pYUWdkMkZ5YldWa1ZYQWdQU0JtWVd4elpUc0tiR1YwSUdOMWNuSmxiblJOYjJSbGJDQTlJRU5NUVZWRVJWOU5UMFJGVERzZ0x5OGc3S2VBNnJpSUlPeUV1T3lGbU95ZHRDRHJyTHpxczZBZzdKNkk2NHFVSU91cXFPdU51Q0FvN0pxVTdMS3Q3SjIwSU91THBPdWx1Q0RycXFqcmpianNuWVFnN0tlQTdLQ1Y3WldZNjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFcENpOHZJT3lMbk95ZWtTRHNpNXdnUTJ4aGRXUmwNCklFTnZaR1VvWTJ4aGRXUmxJRU5NU1NucXNJQWc3Sk80SU95SW1DRHNub2pyaXBUc3A0QWc3S0NRNnJLQUlPS0FsQ0RzbDRic25MenJxYlFnTDJobFlXeDBhT3VobkNEc2xZenJvS1FnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZuT3VMcEM0S0x5OGdiblZzYkQzdG1aWHNuYmdnN0tTUkxDQW5iMnNuUGV5Q3JPeWFxU0Rxc0lEcmlxVXNJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzlZMnhoZFdSbElPdXFoZXVndVNEc2w0YnNuWXdzQ2k4dklDZGpiR0YxWkdVdGJHOW5iM1YwSnoxamJHRjFaR1hyaXBRZzdKNkk3S2VBNjZlTUlPdWhuT3EzdU95ZHVDRHNoTGpzaFpnZzY2ZU02Nk9NSUNqdGhMUWc3SXVrN1l5b0lPeUxuQ0Rxc0pEc3A0QXNJT3lFc2VxenRTRHRoTFRzbmJRZzdKaWs2Nm0wSU95ZWtPdVBtU0R0bGJUc29Kd3BDaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzDQpucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWg0KN0oyQUlPcXl2ZXVobk91aG5DRHNucUh0bm9qcnI0RHJvWndnN0tTUjY2YTlJTzJSbk8yWWhPeWRoQ0RzazdUcmk2UUtZMjl1YzNRZ1RFOUhTVTVmUjFWSlJFVWdQU0FuN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdU95ZHRDRHRsWVRzbXBUdGxiVHNtcFFvN0pXSUlPdVFrT3F4c091Q21DRHJwNHpybzR3cElPS0FsQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGMGc2N0tFN1lxODdKMkVJT3VJaE91bHRPdXB0Q0Ryb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3lYdE95V3RPdVRuT3VncE95YWxDNG5Pd292THlEc2k2VHN1S0h0bFp3ZzY2eTQ2cldzNjVPa09pQWlSbUZwYkdWa0lIUnZJR0YxZEdobGJuUnBZMkYwWlRvZ1QwRjFkR2dnYzJWemMybHZiaUJsZUhCcGNtVmtJR0Z1WkNCamIzVnNaQ0J1YjNRZ1ltVWdjbVZtY21WemFHVmtJaWpycDR6cm80d3BMQW92THlBaVRtOTBJR3h2WjJkbFpDQnBiaURDdHlCUWJHVmhjMlVnY25WdUlDOXNiMmRwYmlJbzY2KzQ2NkdjNnJlNDdKMjQNCktTRGlnSlFnNjVHWUlPdUxwQ0RzbnFIdG5vanFzb3dnNjRTVDdaNk02NHVrQ21aMWJtTjBhVzl1SUdselFYVjBhRVZ5Y205eUtITXBJSHNLSUNCeVpYUjFjbTRnTDJGMWRHaGxiblJwWTJGMGZHOWhkWFJvZkdGd2FTQnJaWGw4Ykc5bklEOXBibnhzYjJkblpXUjhjMlZ6YzJsdmJpQmxlSEJwY21Wa0wya3VkR1Z6ZENoVGRISnBibWNvY3lrcE93cDlDaTh2SU95Q3JPeWFxU0R0bFp6cmo0UWc3TFNJNnJPOElPcXdrT3luZ0NEaWdKUWc2NkdjNnJlNDdKMjQ3SjJBSU91cGdPeXBvZTJWbk91TnNDQWk2NDJVSU91cXV5RHNrN1RyaTZRaTY0cVVJT3F5dmV5YXNDNGc2NkdjNnJlNDdKMjRJT3Vuak91ampPeVpnQ0Rzb2JEc3VaanFzSUFnNjR1czY1Mjg3SVNjSU91VXNPdWhuQ0RzbnFIcmlwVHJpNlF1Q2k4dklPeUxwT3k0b1NneU1ESTJMVEE0TENEdG1venNncXdnN0plVTdZU3c3WlNFNjUyODdKMjA3S2FJSU95aWpPeUVuU2s2SUNKWmIzVW5kbVVnYUdsMElIbHZkWElnYVc1a2FYWnBaSFZoYkNCemNHVnVaQ0JzDQphVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6cw0KbnBEc2w1RHFzb3dnN1pXYzY0K0U2Nlc4SU95WXJPdWdwQ0RyaTZ6cm5ienFzNkFnN0pxVTdMS3Q3WldZNnJPZ0xDRHNsWVRyaTRqcnFiUWdXL0NmbjZBZzdZRzA2NkdjNjVPY0lPMlZuT3VQaENEc3RJanFzN3hkSU91eWhPMkt2T3lkaENEcmlJenJuNndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxiUWc3S084N0lTNDdKcVVMaWM3Q2k4dklDZnRsWnpyajRRbjY2R2NJT3V0aWV1YXNlcTN1T3Vtck91cHRDRHNsWWdnNjVDYzY0dWtJT0tBbENEc25xRHF1WkFnNjZxdzY2YTBJT3VWakNEcmdwanJpcFFnY21GMFpTQnNhVzFwZE95ZHRPdUNtQ0RyckxqcnA2VWc2cmk0N0oyMElPeTBpT3F6dk9xNWpPeW5nQ0RzbnFIc2xZUUtMeThnN0plSjY1cXg3WldZNnJLTUlDTHJpNlRycGJnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJWbU91ZHZDTHFzNkFnN0pXSTY0SzA3WldZNnJLTUlPdVFuT3VMcEM0ZzdLZUE3TGFjd3Jmc2dxenNtcW5ybjRrZzdJT0I3WldjSU91c3VPcTENCnJPdW5qQ0Rzb29IdG1JRHNoSndnNjdPNDY0dWtDbVoxYm1OMGFXOXVJR2x6VEdsdGFYUkZjbkp2Y2loektTQjdDaUFnY21WMGRYSnVJQzl6Y0dWdVpDQnNhVzFwZEh4MWMyRm5aUzFqY21Wa2FYUnpmSFZ6WVdkbElHeHBiV2wwSUNoeVpXRmphR1ZrZkdWNFkyVmxaR1ZrS1M5cExuUmxjM1FvVTNSeWFXNW5LSE1wS1RzS2ZRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU8yWmxleWR1Q0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOejY2VzhJT3lkdmV5V3RBb3ZMeUF2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDQW83WlNNNjUrczZyZTQ3SjI0N0oyMElDTHJpSVRxdGF3ZzZyT0U3S0NWN0p5ODY2R2NJT3lUc091S2xDRHNwSkhzbmJqc3A0QWlJTzJSbk95TG5DRGlnSlFnNnJPMTdKcXBJRkJEN0plUTdJU2NJT3VDcU95ZG1DRHFzNFRzb0pVZzdKaWs3SUtzN0pxcElPdXdxZXluDQpnQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMA0KSU95ZHRDRHFzSkxxczd3ZzdZeU03SjI4N0oyWUlPcXpoT3lnbGV5ZHRDRHNsclRxdUl2cmdwenJpNlFLYkdWMElITmxjM05wYjI1QlkyTnZkVzUwSUQwZ2JuVnNiRHNLWm5WdVkzUnBiMjRnWTJ4aGRXUmxRV05qYjNWdWRDZ3BJSHNLSUNCcFppQW9SR0YwWlM1dWIzY29LU0F0SUdGalkyOTFiblJEWVdOb1pTNWhkQ0E4SURNd01EQXdLU0J5WlhSMWNtNGdZV05qYjNWdWRFTmhZMmhsTG1WdFlXbHNPd29nSUd4bGRDQmxiV0ZwYkNBOUlHNTFiR3c3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3dvZ0lDQWdaVzFoYVd3Z1BTQW9haUFtSmlCcUxtOWhkWFJvUVdOamIzVnVkQ0FtSmlCcUxtOWhkWFJvUVdOamIzVnVkQzVsYldGcGJFRmtaSEpsYzNNcElIeDhJRzUxYkd3N0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2cNCjY2R2M2cmU0N0oyNElPeWR0T3VncFNEc2w0YnNuWXdnNjVPeElPS0FsQ0J1ZFd4c0lPeWNvT3luZ0NBcUx5QjlDaUFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ1JHRjBaUzV1YjNjb0tTd2daVzFoYVd3Z2ZUc0tJQ0J5WlhSMWNtNGdaVzFoYVd3N0NuMEtablZ1WTNScGIyNGdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1NCN0NpQWdZMjl1YzNRZ2NISnZZbVVnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3ljdExYWmxjbk5wYjI0blhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXSUgwcE93b2dJR3hsZENCdmRYUWdQU0FuSnpzS0lDQndjbTlpWlM1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXlCdmRYUWdLejBnWkM1MGIxTjBjbWx1WnlncE95QjlLVHNLSUNCd2NtOWlaUzV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzdJSDBwT3dvZ0lIQnliMkpsTG05dUtDZGpiRzl6DQpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVA0KWldNNklDY25JSDA3Q2dvdkx5RGlsSURpbElBZzdaU002NStzNnJlNDdKMjRJT3lEbmV5aHRDRHFzSkRzcDRBbzdJdXM3SjZsNjdDVjY0K1pLU0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQUtMeThnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3VXb0NEc25vanJpcFFnNjQrWjdKV0lJR052WkdVdWRIUHFzSUFnTmV5MGlPdW5pT3VMcENCUVQxTlVJQzlvWldGeWRHSmxZWFRycGJ3ZzY3TzA2NEs0NjR1a0xnb3ZMeUR0bFp3ZzY3S0k3SjIwNjUyODY0K0VJT3V3bSt5ZGdDRHJrcVFnTXpEc3RJanFzSVFnNjRHSzZyaXc2Nm0wSU8yVWpPdWZyT3EzdU95ZHVDanJtSkRyaXBRZzdaUzg2cmU0NjZlSUtleWR0Q0RyaTZ2dG5vd2c2cktESU9LQWxDRHRnYlRyb1p6cms1enF1WXpzcDRBZzY0Mnc2NmFzNnJPZ0lPcXdtZXlkdENEcXVyenNwNFRyaTZRdUNpOHYNCklPeVZoT3luZ1NEdGxad2c2N0tJNjQrRUlPdXF1eURyc0p2c2xaanNuTHpycWJRbzY0dWs2NmFzNjZlTUlPdW92T3lnZ0NEc3ZLQWc3SU9CN1lPY0xDRHNucERyajVuc2k1enNucEVnNjVPeEtTRHFzNFRzaG8wZzY0eUE2cml3N1pXYzY0dWtMZ3BqYjI1emRDQklSVUZTVkVKRlFWUmZSRVZCUkY5TlV5QTlJRE13TURBd093cHNaWFFnYkdGemRFSmxZWFFnUFNBd093cHpaWFJKYm5SbGNuWmhiQ2dvS1NBOVBpQjdDaUFnYVdZZ0tHeGhjM1JDWldGMElDWW1JRVJoZEdVdWJtOTNLQ2tnTFNCc1lYTjBRbVZoZENBK0lFaEZRVkpVUWtWQlZGOUVSVUZFWDAxVEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNNNjUrczZyZTQ3SjI0SU95THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBZzRvQ1VJTzJVdk9xM3VPdW5pQy90bEl6cm42enF0N2pzbmJqc25iUWc2NHVyN1o2TUlPcXlnK3ljdk91aG5DRHJzN1RxczZBZzZyQ1o3SjIwSU9xNnZPeW5rZXVMaU91THBDNG5LVHNLSUNBZ0lIQnliMk5sDQpjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQc25MenJvWndnWTJ4aGRXUmxJTzJLdU91bXJPdWx2Q0Rzb0pYcnBxenRsWnpyaTZRS0lDQjlDbjBzSURVd01EQXBPd29LTHk4ZzRwU0E0cFNBSU91aG5PcTN1T3lkdU95ZGdDQkRURW5xc0lBZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzcDRIc29KRWc3SmUwNnJLTUlPMlZuT3VMcENBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU16QXBJT0tVZ09LVWdBb3ZMeURzbXJEcnBxenFzSUFnUWxKUFYxTkZVdXVsdkNEcXNJRHJvWnpzc1lUcXNiRHJncGdnN0xDOTdKMkVJT3F6cU91ZHZDRHNsNnpyaXBRZzdJdWM2NCtFNjRxVUlDb3E3S0NFNjdhQUlPeUxwTzJNcU8yVnRPeUVuQ0Rya0pqcmo0enJvTGpyaTZRcUtpNGc2NEtvNnJpMElPcTFrTzJiaURvS0x5OGdJQ0Rpa2FBZ1FsSlBWMU5GVWlEdGxianJrNlRybjZ6cm9ad2dWVkpNN0oyRUlPdXdtK3ljdk91cHRDQmpiV1Rxc0lBZ1lDWmc3SmVRN0lTYw0KSU95ZW1PdWR2T3VvdWV1S2xPdUxwQ0RpaHBJZ1kyeHBaVzUwWDJsa0lPeUdqT3lMcENnaTdKNlk2NnE3NjVDY0lFOUJkWFJvSU95YWxPeXlyU0lwTGdvdkx5QWdJT0tSb1NCQ1VrOVhVMFZTNjZXOElHNXZMVzl3N0p5ODY2R2NJT3VuaWVxem9DQnpkR1J2ZFhUc25aZ2dWVkpNN0oyRUlPeWFzT3Vtck9xd2dDRHNsN1RycWJRZ0tpcnNpcm5zbmJnZzY1S2tJT3lkdU95bW5leTlsT3VUbk91bHZDRHJ0cG5zbDZ6cmhLUHNuTHpybmJ6cmlwUWc3Wm1VNjZtMEtpcnNuYlFLTHk4Z0lDQWdJQ0Rybkt6cmk2UW83SXVrN0xpaElPeUxvT3F6b0RvZ0l1eWR0T3Vmc0NEcXNiQWc3SmVHN0plSTY0cVU2NDJ3SU9xd2tleWVrT3E0c0NEc21ad2c3SU9kNnJLb0lpa2c0b0NVSU95ZWtPdVBtU0RzaUpqcm9MbnNuYlFnNnJtbzdLZUU2NHVrTGdvdkx5QWdJT0tSb2lEc2k1enRnYXpycHI4ZzdMQzk3Snk4NjZHY0lPeVh0T3VncE91cHRDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKcXc2NmFzNnJDQUlPcXpxT3Vkdk95VnZDRHQNCmxiVHNoSndnS2lycXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJT3lWaE91TGpDRHRnYXpyb2F6Q3QreVhvK3luZ09xd2dDRHNsN1RycHJEcmk2UXFLZ292THlBZ0lDQWdJQ2pzaTZUc3VLRWc3SXVnNnJPZ09pQWk3Sm1jSU8yQnJPdWhyT3ljdk91aG5DRHNsN1Ryb0tRaUxDQWk2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VobkNEdGxaanJuYnpyaTRqcXVZd2lLUzRnNnJLTTY0dWs2ckNBSU9xNHNPdXp1Q0RydUl6cm5ienNtckRzb0lEcXNJQWc3SXVjN1lHczY2YS9DaTh2SUNBZ0lDQWc3SjI0N0o2UTY2VzhJT3VzdE95TG5PMlZtT3VwdENqc2dyenNoTEVnN0oyNDdZU3c2NFMzSU95THBPeTRvU2tnN0oyODY3Q1lJT3l3dmV5ZHRDRHJscUFnN0lxNTdKMjRJTzJabE91cHRPeWR0Q0RxdDdqcmpJRHJvWnpyaTZRdUNpOHZJT3EzdU91ZW1PeUVuQ0FxS2tKU1QxZFRSVkxycGJ3ZzZyRzA2NU9jNjZhczdLZUFJT3lWaXV1S2xPdUxwQ29xSU9LQWxDQmpiR0YxWkdVZ1EweEo2ckNBSU9xNHNPdXp1Q0RyDQp1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA2ck9nSUd4dlkyRnNhRzl6ZE91aG5DRHFzckRxczd6cnBid2c3SjZRNjQrWkNpOHZJT3lJbU91Z3VlMlZuT3VMcENqc3ZaVHJrNXdnNjdhWjdKZXM2NFNqNnJpd0lPeVhodXlkakNrdUlPcXpoT3lnbFNEc29JVHRtWmpzbllBZzdJcTU3SjI0SU8yWmxPdXB0Q0R0bFpqcmk2Z2dXK3F6aE95Z2xTRHNvSVR0bVpoZElPdXloTzJLdk95Y3ZPdWhuQ0R0bFp6cmk2UXVDaTh2SUNvcTdKMjBJT3F5dmV1aG5PeVhrQ0JWVWt3ZzZyQ0E2ck8xd3Jmc3BKSHFzSVFnN0lxazdZR3M2NmE5N1lxNHdyZnJ1SXpybmJ6c21yRHNvSUFnN0tlQTdLQ1Y3SjJFSU91THBPeUxuQ0RyaEtQc3A0QWc2NmVRSU9xeWd5NHFLZ29LTHk4ZzRwU0E0cFNBSUVKU1QxZFRSVklnNnJDQTY2R2M3TEdFNnJpdzY0cVVJT3lnbk9xeHNPdVFrT3VMcENBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU1qVXBJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVQ0KZ0Fvdkx5RHNtSWpzb0lUc2w1UWdRbEpQVjFORlVpRHRtWmpxc3IzcnM0RHNpSmpzbDVBZzdKNkU3SXVjSU95S3BPMkJyT3VtdmUyS3VPdWx2Q0RxdllMc2xZUWdRMHhKNnJDQUlPeWtnQ0JoZFhSb2IzSnBlbVVnVlZKTTdKMkVJT3lhc091bXJPcXdnQ0Ryc0p2c2xZVHNoSndnN0plMDdKZUk2NHVrTGdvdkx5RHJxcW5zb0lIc25ZQWc3WldZNjRLWTY3K1E3SjIwN0plSTY0dWtJT0tBbENEcXM0VHNvSlVnN0tDRTdabVk3SnFwN0p5ODY2R2NJRlZTVE95ZGhDQmpiR0YxWkdVdVlXa3ZiRzluYjNWMFAzSmxkSFZ5YmxSdlBlS0FwdXVobkNEc25xenNucEhzaExIdGxiUUtMeThnN0lxNTdKMjRJTzJabE91cHRPeWRoQ0Rxc2JUcmhJanJtN0RxczZBZzZyT0U3S0NWSU95RW9PMkRuU0R0bVpUcnFiVHNsNUFnN0tlQjdaYUo3SXVjN1lLazZyaXdMaURxdDdnZzdKNnM3SjZSN0lTeDdKMkVJTzJQa09xNHNPMlZtT3lla0Nqc2dxenNtcW5zbnBBZzZyS3c3S0NWS1NEdGxianJrNlRybjZ6cmlwUUtMeThnNjZxcDdLQ0INCjdKMjBJT3lYaHV5V3RPeWhqT3F6b0N3Z0tpcnJncWpxc3FnZzY1R1E2Nm0wSU95WXBPMmVpT3VncENEcm9aenF0N2pzbmJqc25ZUWc2NmVkNnJDQTY1eW82NmF3NjR1a0tpbzZDaTh2SUNBZ1EweEo2ckNBSUZWU1RPeWRoQ0RybExEc21MVHRrWndnN0plRzdKMjBJT3VFbU9xNHNPdXB0Q0JqYldUcXNJQWdZQ1pnN0plUTdJU2NJRlZTVE95ZGhDRHNucGpybmJ3ZzY3S0U2NkNrS095Y2lPdVBoT3lhc0NrZ1kyeHBaVzUwWDJsa0lPcXdtZXlkZ0NEcmtxVHNxcjBLTHk4Z0lDRHJwNlRxc0p6cnM0RHNpSmpxc0lBZzdJS3M2NTI4N0tlQTZyT2dMQ0RydUl6cm5ienNtckRzb0lEc2w1UWdJdXllbU91cXUrdVFuQ0JQUVhWMGFDRHNtcFRzc3EwZ3dyY2dZMnhwWlc1MFgybGtJT3VucE9xd25PdXpnT3lJbU9xd2dDRHJpSVRybmIzcmtKanNsNGpzaXJYcmk0anJpNlFpNnJDQUlPdWNyT3VMcEM0S0x5OGdJQ0RzaTZ6dGxaanJxYlFnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJT3lWaE95WWlDRHNsWWdnN0plMDY2YXc2NHVrDQpLT3lMcE95NG9TQXlNREkyTFRBNE9pQkRURWtnN1pTRTY2R2M3SVM0N0lxazY0cVVJT3VNZ09xNHNDRHNwSkhzbmJqcmpiQWc3TEM5N0oyMElPeVZpQ0RybkxncExnb3ZMeURzbmJUc29Kd2dRbEpQVjFORlV1dWx2Q0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a0lPS0draUJqYkdGMVpHVWdRMHhKNnJDQUlPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJwYndnN0tlQjdLQ1JJT3lYc091THBDaERURWtnNnJpdzY3TzRJT3VQbWV5ZWtTa3VDaTh2SUNvcTdKMjBJT3F5dmV1aG5PeVhrQ0JWVWt3ZzZyQ0E2ck8xd3Jmc3BKSHFzSVFnN0lxazdZR3M2NmE5N1lxNDY2VzhJT3VMcE95TG5DRHJoS1BzcDRBZzY2ZVFJT3F5Z3k0cUtpRHFzNFRzb0pVZzdLQ0U3Wm1ZN0oyQUlPeUt1ZXlkdUNEdG1aVHJxYlFnN1pXWTY0dW9JRnZxczRUc29KVWc3S0NFN1ptWVhTRHJzb1R0aXJ6c25MenJvWnd1Q2dvdkx5RHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU8yVWhPdWhuT3lFdU95S3BDQW9ZMnhoZFdSbA0KSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFTa2c0b0NVSUM5dmNHVnVMV3h2WjJsdTdKMjBJT3lEbmV5RXNjSzM2clNBNjZhc0xnb3ZMeURydUl6cm5ienNtckRzb0lEcXNJQWdiRzlqWVd4b2IzTjA2NkdjSU9xeXNPcXp2T3VsdkNEcnM3VHJnclRzcElRZzY1V002cm1NN0tlQUlPeUlxT3lXdE95RW5DRHJqSURxdUxEdGxaanJpNlRxc0lBc0lPeVpoT3Vqak91UW1PdXB0Q0RzaXFUc2lxVHJvWndnNjRHZDY0S2M2NHVrTGdwc1pYUWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVM1JoY25SbFpFRjBJRDBnTURzZ0x5OGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVnN0l1YzZyQ0JJT0tBbENEc25xenRnYlRycHEzc25iUWdKK3llck95TG5PdVBoQ2ZzbmJqc3A0QWdKK3lla091UG1leVpoT3VqakNEc2k2VHRqS2duN0oyNDdLZUFJT3Exck91MmhPMlZuT3VMcEFvdkx5RHNuYlRyc29nZzY2R2MNCjZyZTQ3SjI0N0plUTdJU2NJT3U0ak91ZHZPeWFzT3lnZ0NEc3NMM3NuWVFnN0l1azdLQ2M2NkdjSU91ZGhPeWJvT3VLbE9xd2dDRGlnSlFnN1lTdzY2KzQ2NFNRSU8yUHRPdXdzZXlkZ0NEc25iVHFzb3dnWm1Gc2MyWHNuYndnNjVXTTY2ZU1JT3lUdE91THBBb3ZMeUFvN0l1YzZyQ0U2NmVNN0p5ODY2R2NJTzJNa091THFPMlZtT3VwdENEc29KWHNnNEVnN0o2czdZRzA2NmF0N0plUTY0K0VJR050WkNEc3NMM3NuYlFnN1lxQTdKYTA2NEtZN0ppbzY0dWtLUXBzWlhRZ2JHOW5hVzVYYVc1a2IzZFBjR1Z1WldRZ1BTQm1ZV3h6WlRzS1puVnVZM1JwYjI0Z2EybHNiRXh2WjJsdVVISnZZeWdwSUhzS0lDQnBaaUFvYkc5bmFXNVFjbTlqVkdsdFpYSXBJSHNnWTJ4bFlYSlVhVzFsYjNWMEtHeHZaMmx1VUhKdlkxUnBiV1Z5S1RzZ2JHOW5hVzVRY205alZHbHRaWElnUFNCdWRXeHNPeUI5Q2lBZ2FXWWdLQ0ZzYjJkcGJsQnliMk1wSUhKbGRIVnlianNLSUNCamIyNXpkQ0J3SUQwZ2JHOW5hVzVRY205ak93b2dJR3h2DQpaMmx1VUhKdll5QTlJRzUxYkd3N0NpQWdkSEo1SUhzS0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdDaUFnSUNBZ0lITndZWGR1VTNsdVl5Z25kR0Z6YTJ0cGJHd25MQ0JiSnk5UVNVUW5MQ0JUZEhKcGJtY29jQzV3YVdRcExDQW5MMVFuTENBbkwwWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0NpQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQjBjbmtnZXlCd2NtOWpaWE56TG10cGJHd29MWEF1Y0dsa0xDQW5VMGxIVkVWU1RTY3BPeUI5SUdOaGRHTm9JQ2hmWlRJcElIc2djQzVyYVd4c0tDazdJSDBLSUNBZ0lIMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwOUNnb3ZMeUR0aExRZzY0K0U3S1NSSU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxVHFzSUFnN0tPOTdKZUk3SjJFSU91VmpPeWRtQ0RzaTZUdGpLZ2c2Nm1VN0l1YzdLZUFJT0tBbENCeWRXNVVkWEp1N0oyMElPeWR0Q0RycVpUc2k1enNwNERzbmJ3Zw0KNjVXTTY2ZU1JREh0bW93ZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE8yVm5PdUxwQXBqYjI1emRDQlRSVk5UU1U5T1gwUkpSVVFnUFNBbjdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZHRDRHNvb1hybzR6cmtKRHNsclRzbXBRdUp6c0tiR1YwSUhOb2RYUjBhVzVuUkc5M2JpQTlJR1poYkhObE95QXZMeUF2YzJoMWRHUnZkMjRnN0tlRTdaYUpJT3lra1NEaWdKUWc3SjZzN0l1YzY0K0U2NkdjSU95RXVPeUZtT3lkaENEcmtKanNnclRycHF6c3A0QWc3SldLNnJLTUlPMlJuT3lMbkFvS0x5OGdjbVZoYzI5dTdKMkVJT3lqdk91cHRDQW43SjJZNjQrRTdLQ0JJT3lpaGV1ampDY282ck9FN0tDVklPeWdoTzJabU1LMzY2R2M2cmU0N0pXRTdKdURJT3VUc1NrZzRvQ1VJT3luaE8yV2lTRHNwSkhzbmJUcmpaZ2c3WVMwN0oyRUlPcTN1Q0RycVpUc2k1enNwNERyb1p3ZzY0R2Q2NEswN0lTY0NpOHZJSEoxYmxSMWNtN3NuWmdnVTBWVFUwbFBUbDlFU1VWRUlPeWVrT3VQbVNEc25xenNpNXpyajRUcXNJQWc3SmliSU95ZWtPcXkNCnFleW1uZXVxaGV5Y3ZPdWhuQ0RzaExqc2haanNuWVFnNjVDWTdJSzA2NmFzN0tlQUlPeVZpdXF5akNEdGxaenJpNlF1Q2k4dklDanNsWWdnNnJlNDY1K3M2Nm0wSU9xemhPeWdsU0Rzb0lUdG1aZ2c3S2VCN1p1RUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMjBJT3UyZ08yWm5PMlZ0Q0JOUVZoZlZGVlNUbFBxdVl6c3A0QWc2ck9FN0lhTklPeVRzT3lkdE91S2xDRHJzb1RxdDdnZzRvQ1VJREl3TWpZdE1EY2c2NmFzNjdldzdKZVE3SVNjSU8yWmxleWR1Q2tLWm5WdVkzUnBiMjRnYTJsc2JGQnliMk1vY21WaGMyOXVLU0I3Q2lBZ2FXWWdLSEJ5YjJNcElIc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUNBZ0x5OGdjMmhsYkd3NmRISjFaZXVobkNEcm5ZVHNtNHpzaEp3Z2NISnZZK3lkZ0NCamJXUWc2cnVONjQydzZyaXdJT0tBbENBdlZPdWhuQ0R0aXJqcnBxenNwN2dnN0tPOTdKZXM3Slc4SU95bmhPeW5uQ0JqDQpiR0YxWkdYcXNJQWc2ck9nN0pXRTY2R2NJT3lWaUNEcmdxanJpcFRyaTZRS0lDQWdJQ0FnSUNBdkx5QW82ck9nN0pXRUlHTnNZWFZrWmVxd2dDRHNoS1RzdVpnZzdZeU03SjI4N0oyRUlPdXN2T3F6b0NEc25vanNuTHpycWJRZzdZRzA2NkdjNjVPY0lPeVZzU0RzbDRYcmpiRHNuYlR0aXJqcXNJQWdJdXlDck95YXFTRHNwSkVpN0p5ODY2R2NJT3VuaWUyZW1Da0tJQ0FnSUNBZ0lDQnpjR0YzYmxONWJtTW9KM1JoYzJ0cmFXeHNKeXdnV3ljdlVFbEVKeXdnVTNSeWFXNW5LSEJ5YjJNdWNHbGtLU3dnSnk5VUp5d2dKeTlHSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPd29nSUNBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNBZ0lDOHZJRzFoWTA5VEwrdW1yT3VJaGV5S3BEb2djMmhsYkd3NmRISjFaZXVkdkNCd2NtOWo3SjIwSUhOb0lPcTdqZXVOc09xNHNPeWR2Q0RzaUpnZzdKNkk3SjJNSU9LQWxDQnpkR0Z5ZEZCeWIyUHNuWmdnWkdWMFlXTm9aV1Ryb1p3ZzY2ZU02NU9nQ2lBZ0lDQWdJQ0FnTHk4Zw0KN1pTRTY2R2M3SVM0N0lxa0lPcTN1T3VqdVNndGNHbGtLZXlkaENEdGhyWHNwN2pyb1p3ZzdLQ1Y2NmFzN1pXYzY0dWtJQ2gwWVhOcmEybHNiQ0F2VkNEcmpJRHNuWkVwQ2lBZ0lDQWdJQ0FnZEhKNUlIc2djSEp2WTJWemN5NXJhV3hzS0Mxd2NtOWpMbkJwWkN3Z0oxTkpSMVJGVWswbktUc2dmU0JqWVhSamFDQW9YMlV5S1NCN0lIQnliMk11YTJsc2JDZ3BPeUI5Q2lBZ0lDQWdJSDBLSUNBZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdXN0T3lMbkNBcUx5QjlDaUFnZlFvZ0lIQnliMk1nUFNCdWRXeHNPd29nSUhkaGNtMWxaRlZ3SUQwZ1ptRnNjMlU3Q2lBZ2FXWWdLSGRoYVhSbGNpa2dleUJqYkdWaGNsUnBiV1Z2ZFhRb2QyRnBkR1Z5TG5ScGJXVnlLVHNnZDJGcGRHVnlMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9jbVZoYzI5dUlIeDhJRk5GVTFOSlQwNWZSRWxGUkNrcE95QjNZV2wwWlhJZ1BTQnVkV3hzT3lCOUNuMEtDbVoxYm1OMGFXOXVJSE4wWVhKMFVISnZZeWdwSUhzS0lDQnJhV3hzVUhKdll5Z3ANCk93b2dJR3hwYm1WQ2RXWWdQU0FuSnpzS0lDQjBkWEp1Y3lBOUlEQTdDaUFnTHk4ZzdKMjBJT3lFdU95Rm1PeWR0Q0RzbHJUcmlwQWc2ck9FN0tDVjdKMllJT3llaGV5ZXBlcTJqT3ljdk91aG5DRHJqNFRyaXBUc3A0QWc2cml3NjZHZElPS0FsQ0Ryc0pic2w1RHNoSndnNnJPRTdLQ1Y3SjIwSU91d2xPdUFqT3lYaU91S2xPeW5nQ0RydVlUcXRaRHRsWmpyaXBRZzZyaXc3S1NBQ2lBZ2MyVnpjMmx2YmtGalkyOTFiblFnUFNCamJHRjFaR1ZCWTJOdmRXNTBLQ2s3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c3SXVjNjQrWklPeWtrZUtBcGlBbzY2cW82NDI0T2lBbklDc2dZM1Z5Y21WdWRFMXZaR1ZzSUNzZ0p5a25LVHNLSUNCamIyNXpkQ0IwYUdselVISnZZeUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSnkxd0p5d2dKeTB0Ylc5a1pXd25MQ0JqZFhKeVpXNTBUVzlrWld3c0lDY3RMV2x1Y0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzDQpJQ2N0TFc5MWRIQjFkQzFtYjNKdFlYUW5MQ0FuYzNSeVpXRnRMV3B6YjI0bkxDQW5MUzEyWlhKaWIzTmxKMTBzSUhzS0lDQWdJSE5vWld4c09pQjBjblZsTENCamQyUTZJRVZOVUZSWlgwTlhSQ3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdMQW9nSUNBZ1pHVjBZV05vWldRNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ0lUMDlJQ2QzYVc0ek1pY3NJQzh2SUZCUFUwbFlPaURzbnBEcXVMQWc3WlNFNjZHYzdJUzQ3SXFrSU9xM3VPdWp1U0RzZzUzc2hMRWc0b0NVSUd0cGJHeFFjbTlqN0oyMElPcTN1T3VqdWV5bnVDRHNvSlhycHF6dGxhQWc3SWlZSU95ZWlPcXlqQW9nSUgwcE93b2dJSEJ5YjJNZ1BTQjBhR2x6VUhKdll6c0tJQ0J3Y205akxuTjBaRzkxZEM1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0NpQWdJQ0JzYVc1bFFuVm1JQ3M5SUdRdWRHOVRkSEpwYm1jb0ozVjBaamduS1RzS0lDQWdJR3hsZENCcFpIZzdDaUFnSUNCM2FHbHNaU0FvS0dsa2VDQTlJR3hwYm1WQ2RXWXVhVzVrWlhoUFppZ25YRzRuS1NrZw0KSVQwOUlDMHhLU0I3Q2lBZ0lDQWdJR052Ym5OMElHeHBibVVnUFNCc2FXNWxRblZtTG5Oc2FXTmxLREFzSUdsa2VDa3VkSEpwYlNncE93b2dJQ0FnSUNCc2FXNWxRblZtSUQwZ2JHbHVaVUoxWmk1emJHbGpaU2hwWkhnZ0t5QXhLVHNLSUNBZ0lDQWdhV1lnS0NGc2FXNWxLU0JqYjI1MGFXNTFaVHNLSUNBZ0lDQWdiR1YwSUdWMklEMGdiblZzYkRzS0lDQWdJQ0FnZEhKNUlIc2daWFlnUFNCS1UwOU9MbkJoY25ObEtHeHBibVVwT3lCOUlHTmhkR05vSUNoZlpTa2dleUJqYjI1MGFXNTFaVHNnZlFvZ0lDQWdJQ0JwWmlBb1pYWWdKaVlnWlhZdWRIbHdaU0E5UFQwZ0ozSmxjM1ZzZENjZ0ppWWdkMkZwZEdWeUtTQjdDaUFnSUNBZ0lDQWdZMjl1YzNRZ2R5QTlJSGRoYVhSbGNqc0tJQ0FnSUNBZ0lDQjNZV2wwWlhJZ1BTQnVkV3hzT3dvZ0lDQWdJQ0FnSUdOc1pXRnlWR2x0Wlc5MWRDaDNMblJwYldWeUtUc0tJQ0FnSUNBZ0lDQnBaaUFvWlhZdWFYTmZaWEp5YjNJcElIc0tJQ0FnSUNBZ0lDQWdJR052Ym5OMElISmgNCmR5QTlJRk4wY21sdVp5aGxkaTV5WlhOMWJIUWdmSHdnWlhZdWMzVmlkSGx3WlNCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTWpBd0tUc0tJQ0FnSUNBZ0lDQWdJQzh2SU8yVm5PdVBoQ0RzdElqcXM3enJwYndnNjZpODdLQ0FJT3V6dU91THBDRGlnSlFnNjZHYzZyZTQ3SjI0SU95WXBPdWxtQ0Rzb0pYcXQ1enNpNTNzbmJRZzY0U1Q3SmEwN0lTY0tHeHZaeUEvYVc0ZzY1T3hLU0RyckxqcXRhenFzSUFnNjdDVTY0Q002Nm0wSU95Q3ZPMkNyQ0RzaUpnZzdKNkk2NHVrQ2lBZ0lDQWdJQ0FnSUNCcFppQW9hWE5NYVcxcGRFVnljbTl5S0hKaGR5a3BJSHNLSUNBZ0lDQWdJQ0FnSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnSjJOc1lYVmtaUzFzYVcxcGRDYzdJQzh2SUM5b1pXRnNkR2pyb1p3ZzdKV002NmE4SU9LR2tpRHJzb1R0aXJ6c25iUWdXKzJWbk91UGhDRHN0SWpxczd4ZDY2R2NJT3V3bE91QWpPcXpvQ0RxczRUc29KVWc3S0NFN1ptWTdKMkVJT3lWaU91Q3RBb2dJQ0FnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2DQpaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95Q3JPeWFxU0R0bFp6cmo0UWc3TFNJNnJPOElPcXdrT3luZ0RvbkxDQnlZWGNwT3dvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9URWxOU1ZSZlIxVkpSRVVwS1RzS0lDQWdJQ0FnSUNBZ0lIMGdaV3h6WlNCcFppQW9hWE5CZFhSb1JYSnliM0lvY21GM0tTa2dld29nSUNBZ0lDQWdJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0FuWTJ4aGRXUmxMV3h2WjI5MWRDYzdJQzh2SUM5b1pXRnNkR2pyb1p3ZzdaU002NStzNnJlNDdKMjQ3SmVRSU95VmpPdW12Q0RpaHBJZzY3S0U3WXE4N0oyMElGdnJvWnpxdDdqc25iZ2c3WldFN0pxVVhldWhuQ0Ryc0pUcmdKd0tJQ0FnSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c2NmVNNjZPTUlPcXdrT3luZ0RvbkxDQnlZWGNwT3dvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9URTlIU1U1Zg0KUjFWSlJFVXBLVHNLSUNBZ0lDQWdJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243WUcwNjZHYzY1T2NJT3lZcE91bG1Eb2dKeUFySUhKaGR5a3BPd29nSUNBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0FuYjJzbk95QXZMeURzaExIcXM3VWdQU0RzaEtUc3VaakN0K3Vobk9xM3VPeWR1Q0RyaTZRZzdLQ1Y3SU9CSU9LQWxDRHNsclRybHFRZ2NISnZZbXhsYmV5ZHRPdVRvQ0R0bGJUc29Kd2dLT3llck91aG5PcTN1T3lkdUMvc25xenNoS1RzdVpnZzY3TzE2cmVBS1FvZ0lDQWdJQ0FnSUNBZ2R5NXlaWE52YkhabEtGTjBjbWx1WnlobGRpNXlaWE4xYkhRZ2ZId2dKeWNwS1RzS0lDQWdJQ0FnSUNCOUNpQWdJQ0FnSUgwS0lDQWdJSDBLSUNCOUtUc0tJQ0J3Y205akxuTjBaR1Z5Y2k1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0NpQWdJQ0JqYjI1emRDQnpJRDBnWkM1MGIxTjANCmNtbHVaeWduZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUdsbUlDaHpJQ1ltSUNGekxtbHVZMngxWkdWektDZEVaWEJ5WldOaGRHbHZibGRoY201cGJtY25LU2tnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElHTnNZWFZrWlNCemRHUmxjbkk2Snl3Z2N5NXpiR2xqWlNnd0xDQXlNREFwS1RzS0lDQjlLVHNLSUNCd2NtOWpMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0F2THlEc25iVHJyN2dnN0lPSUlPeUV1T3lGbU95Y3ZPdWhuQ0RxdFpEc3NyVHJrSndnNjVLa0lPeVlteURzaExqc2haanNuYlFnNjR1cjdaNk1JT3F4c091cHRDRHJyTFRzaTV3Z0tPdXFxT3VOdUNEc29JVHRtWmdnN0l1Y0lPeURpQ0RzaExqc2haanNuWVFnN0tPOTdKMjA3S2VBSU95Vml1cXlqQ2tLSUNBZ0lHbG1JQ2h3Y205aklDRTlQU0IwYUdselVISnZZeWtnY21WMGRYSnVPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c3S0tGNjZPTUlDaGpiMlJsDQpJQ2NnS3lCamIyUmxJQ3NnSnlrZzRvQ1VJT3VMcE95ZGpDRHNtcFRzc3EwZzY1V01JT3VMcE95TG5DRHNpNXpyajVudGxhbnJpNGpyaTZRdUp5azdDaUFnSUNCcmFXeHNVSEp2WXlncE93b2dJSDBwT3dwOUNncG1kVzVqZEdsdmJpQnpaVzVrVkhWeWJpaDBaWGgwS1NCN0NpQWdjbVYwZFhKdUlHNWxkeUJRY205dGFYTmxLQ2h5WlhOdmJIWmxMQ0J5WldwbFkzUXBJRDArSUhzS0lDQWdJR2xtSUNnaGNISnZZeWtnY21WMGRYSnVJSEpsYW1WamRDaHVaWGNnUlhKeWIzSW9KKzJCdE91aG5PdVRuQ0RzaExqc2haanNuYlFnN0plRzdKYTA3SnFVTGljcEtUc0tJQ0FnSUdsbUlDaDNZV2wwWlhJcElISmxkSFZ5YmlCeVpXcGxZM1FvYm1WM0lFVnljbTl5S0Nmc2xaN3NoS0FnN0pxVTdMS3Q3SjIwSU95bmhPMldpU0RzcEpIc25iVHNsNURzbXBRdUp5a3BPd29nSUNBZ1kyOXVjM1FnZEdsdFpYSWdQU0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yRQ0KdENEc2k1enFzSVFnN0xTSTZyTzhJT0tBbENEc2hManNoWmpzbllRZzdKNnM3SXVjN0o2UjdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ0lDQXZMeURzaTV6cXNJUWc3TFNJNnJPODY0cVVJQ2ZzaExqc2haZ2c3S0tGNjZPTUoreVpnQ0RxdGF6cnRvVHJrSmpyaXBRZzdLQ2NJT3VwbE95TG5PeW5nT3VobkNEcmdaM3JncmpyaTZRZzRvQ1VJR3RwYkd4UWNtOWo3SjJZSU95RXVPeUZtQ0Rzb29Ycm80d2djbVZxWldOMDZyQ0FDaUFnSUNBZ0lDOHZJSEoxYmxSMWNtN3NuWmdnN0o2UTY0K1pJT3llck95TG5PdVBoT3VsdkNEcnRvRHJwYlRycWJRZzdKV0lJT3VRbU9xNHNDRHJsWXpyckxnbzY0cVE2NmF3SU8yRXRPeWRoQ0Rya1pBZzY3S0lJT3VQak91cHRDRHRsSXpybjZ6cXQ3anNuYmdnTVRNdzdMU0lJT3lnbk8yVm5PeWRoQ0RyaEpqcXVMVHJpNlFwQ2lBZ0lDQWdJR2xtSUNoM1lXbDBaWElwSUhzS0lDQWdJQ0FnSUNCamIyNXpkQ0IzSUQwZ2QyRnBkR1Z5T3lCM1lXbDBaWElnUFNCdWRXeHNPd29nSUNBZ0lDQWcNCklIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243WUcwNjZHYzY1T2NJT3lka2V1THRleWR0Q0RyaElqcnJMUWc3SmlrNjU2WUlPcXh1T3VncENEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5LU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdhMmxzYkZCeWIyTW9LVHNLSUNBZ0lIMHNJRlJWVWs1ZlZFbE5SVTlWVkY5TlV5azdDaUFnSUNCM1lXbDBaWElnUFNCN0lISmxjMjlzZG1Vc0lISmxhbVZqZEN3Z2RHbHRaWElnZlRzS0lDQWdJSEJ5YjJNdWMzUmthVzR1ZDNKcGRHVW9TbE5QVGk1emRISnBibWRwWm5rb2V5QjBlWEJsT2lBbmRYTmxjaWNzSUcxbGMzTmhaMlU2SUhzZ2NtOXNaVG9nSjNWelpYSW5MQ0JqYjI1MFpXNTBPaUIwWlhoMElIMGdmU2tnS3lBblhHNG5MQ0FuZFhSbU9DY3BPd29nSUgwcE93cDlDZ292THlEcXNKbnNuWUFnNjZ5NDZyV3M2Nlc4SU91cWh5RHJzb2pzcDdnZzY2eTc2NHFVN0tlQUlPcTRzT3lXDQp0U0RpZ0pRZzdKNnM3SnFVN0xLdDdKMjA2Nm0wSUNMc25iVHNvSVRxczd3ZzY0dWs2Nlc0SU95RGlDRHNvSnpzbFlnaTdKMkVJT3lhbE9xMXJPMlZuT3VMcEFvdkx5QW83SldJSU9xM3VPdWZyT3VwdENEdGdiVHJvWnpyazV6cXNJQWc3SVN4N0l1azdaV1k2cktNSU9xd21leWRnQ0RyaTdYc25ZUWc2NWlRSU91Q3RPeUVuQ0JiUVVrZzdMYVU3TEtjSU91TmxDRHJzSnZxdUxCZDZyQ0FJT3VzdE95ZG1PdXZ1TzJWdE95bmhPdUxwQ2tLWTI5dWMzUWdZWE5yWldSRGIzVnVkQ0E5SUc1bGR5Qk5ZWEFvS1RzS0NpOHZJT3lFdU95Rm1DRHNwSURydVlRbzdJdWM2NCtaSyt5bmdPeUxuT3VzdUNEc283enNub1VwNjZXOElPdXp0T3llcGUyVm5DRHJrcVFnN1pXY0lPMkV0Q0RzaTZUdGxva2c0b0NVSU91cXFPdVRvQ0R0bUxqc3RwenNuWUFnY1hWbGRXWHJvWndnN0tlQjY2Q3M3Wm1VTGdvdkx5QnRiMlJsYk95ZGhDRHNvN3pycWJRZzZyZTRJT3VxcU91TnVPdWhuQ0FvNjR1azY2VzA2Nm0wSU95RXVPeUZtQ0RzbnF6cw0KaTV6c25wRXBMaUR0bFp3ZzY2cW82NDI0N0oyRUlPcXpoT3lHalNEc2s3RHJxYlFnN0o2czdJdWM3SjZSN0oyQUlPeTFuT3kwaUNBeDdacU02NytRTGdvdkx5QnlaWEJoY25ObFBYdHdZWEp6WlN3Z1ptOXliV0YwUkdWelkzM3JwYndnN0tPODY2bTBJTzJNak95THNlcTVqT3luZ0NEc25iUWc3SjZoSU95VmlPeVhrT3lFbkNEc3NwanJwcXp0bFpqcXM2QWdlM0poZHl3Z2NHRnljMlZrZmV1bHZDRHJqNHpyb0tUc3BJRHJpNlE2Q2k4dklPMllsZXlMblNEc25iVHRnNGdnN0l1Y0lPcXdtZXlkZ0NEc2hManNoWmpzbDVBZ0l1MllsZXlMbmV1TWdPdWhuQ0RyaTZUc2k1d2k2Nlc4SU95YWxPcTFyTzJWbU91S2xDRHNucXpzbXBUc3NxMGc3WVMwN0oyRUlDb3E2ckNaN0oyQUlPMkJrQ0RzbnFFZzdKV0k3SmVRN0lTY0tpb2c2N2FaN0oyNDY0dWtMZ292THlEcnM0VHJqNFFnN0o2aDdKeTg2NkdjSU91NXZPdXB0Q0FvWVNrZzdJS3M3SjIwN0plUUlPdUxwT3VsdUNEc21wVHNzcTBnN1lTMDdKMjBJT3VCdk95V3RDQW4NCjY3Q3A2cmlJSU91THRTZnNuYlFnNjRLbzdKMllJT3VMdGV5ZHRDRHJrSmpxczZBbzY0SzA3SnFwSU95WXBPeVh2Q2tzQ2k4dklDaGlLU0JOUVZoZlZGVlNUbE1nNnJLOTZyT0U3SmVRN0lTY0lPeUV1T3lGbU95ZHRDRHNucXpzaTV6c25wSHJqN3dnSit1d3FlcTRpQ0RyaTdVbjdKMjBJT3lYaHV1S2xDRHNnNGdnN0lTNDdJV1k3SjIwSU91Q3RPeWFxZXlkaENEc3A0RHNsclRyZ3J3ZzdJaVlJT3llaU91THBDQW9NakF5Tmkwd055RHJwcXpydDdEc2w1RHNoSndnN1ptVjdKMjRLUzRLWTI5dWMzUWdVa1ZRUVZKVFJWOUNRVVFnUFNBb2Rpa2dQVDRnZGlBOVBTQnVkV3hzSUh4OElDaEJjbkpoZVM1cGMwRnljbUY1S0hZcElDWW1JSFl1YkdWdVozUm9JRDA5UFNBd0tUc0tablZ1WTNScGIyNGdjblZ1VkhWeWJpaGlkV2xzWkVGemF5d2diVzlrWld3c0lISmxjR0Z5YzJVcElIc0tJQ0JqYjI1emRDQnFiMklnUFNCeGRXVjFaUzUwYUdWdUtHRnplVzVqSUNncElEMCtJSHNLSUNBZ0lHTnZibk4wSUdwdllsTjBZWEowDQpJRDBnUkdGMFpTNXViM2NvS1RzZ0x5OGc3SXVjNnJDRUlPeVlpT3lDc0NEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SU95cXZTRHNvSnp0bFp3b01UTXc3TFNJS2V5ZGhDRHJoSmpxdUxnZzdKNnM3SXVjNjQrRTY0cVVJTzJQck9xNHNPMlZuT3VMcEFvZ0lDQWdhV1lnS0cxdlpHVnNJQ1ltSUVGTVRFOVhSVVJmVFU5RVJVeFRMbWx1WkdWNFQyWW9iVzlrWld3cElDRTlQU0F0TVNBbUppQnRiMlJsYkNBaFBUMGdZM1Z5Y21WdWRFMXZaR1ZzS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJxcWpyamJnZzY3T0E2cks5T2lBbklDc2dZM1Z5Y21WdWRFMXZaR1ZzSUNzZ0p5RGlocElnSnlBcklHMXZaR1ZzS1RzS0lDQWdJQ0FnWTNWeWNtVnVkRTF2WkdWc0lEMGdiVzlrWld3N0NpQWdJQ0FnSUhOMFlYSjBVSEp2WXlncE95QXZMeURzZzRnZzY2cW82NDI0NjZHY0lPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdUxwT3lkakNEc200enJzSTNzbDRYc2w1RHNoSndnN0tlQTdJdWM2Nnk0SU95ZQ0Kck95anZPeWVoU2tLSUNBZ0lIMEtJQ0FnSUdsbUlDaDBkWEp1Y3lBK1BTQk5RVmhmVkZWU1RsTWdmSHdnSVhCeWIyTXBJSE4wWVhKMFVISnZZeWdwT3dvZ0lDQWdhV1lnS0NGM1lYSnRaV1JWY0NrZ2V3b2dJQ0FnSUNCamIyNXpkQ0IwTUNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNBZ0lHRjNZV2wwSUhObGJtUlVkWEp1S0dsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncEtUc0tJQ0FnSUNBZ2QyRnliV1ZrVlhBZ1BTQjBjblZsT3dvZ0lDQWdJQ0IwZFhKdWN5c3JPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0lTNDdJV1lJT3lrZ091NWhDRHNtWVRybzR3Z0tDY2dLeUFvS0VSaGRHVXVibTkzS0NrZ0xTQjBNQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwSUNzZ0ozTXBJT0tBbENEc25iVHRtNFFnN0pxVTdMS3Q3SjJBSU91NXFPdWR2T3lhbEM0bktUc0tJQ0FnSUgwS0lDQWdJSFIxY201ekt5czdDaUFnSUNCamIyNXpkQ0JoYzJzZ1BTQmlkV2xzWkVGemF5Z3BPeUF2THlEc25xenMNCmk1enJqNFFnNjVXTUlPcXdtZXlkZ0NEc3A0anJyTGpzbllRZzY0dWs3SXVjSU95VHRPdUxwQ0FvWVhOclpXUkRiM1Z1ZENEc25iVHNwSkVnN0thZDZyQ0FJT3V3cWV5bmdDa0tJQ0FnSUd4bGRDQnlZWGM3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0J5WVhjZ1BTQmhkMkZwZENCelpXNWtWSFZ5YmloaGMyc3BPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQXZMeUR0aExRZzY0K0U3S1NSSU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxVHFzSUFnN0tPOTdKMkFJT3F5dmV5YXNDaFRSVk5UU1U5T1gwUkpSVVFwSURIdG1vd2c3SjZRNjQrWklPeWVyT3lMbk91UGhDRGlnSlFnN0lLczdKcXA3SjZRN0plUTZyS1FJT3lMcE8yTXFPdWhuQ0RzbFlnZzY3TzA3SjIwNnJLTUxnb2dJQ0FnSUNBdkx5RHNpNXpxc0lRZzdMU0k2ck84d3Jmcm9aenF0N2pzbmJnZzY2ZU02Nk9Nd3JmdGdiVHJvWnpyazV3ZzdKaWs2NldZd3Jmc25aanJqNFRzb0lFZzdLS0Y2Nk9NS09xemhPeWdsU0Rzb0lUdG1aZ3Y2NkdjDQo2cmU0N0pXRTdKdURMQ0JyYVd4c1VISnZZeWh5WldGemIyNHBLZXVLbEFvZ0lDQWdJQ0F2THlEc29Kd2c2Nm1VN0l1YzdLZUE2ckNBSU91VXNPdWhuQ0Rzbm9qc2xyUWc3SmVzNnJpd0lPeVZpQ0Rxc2JqcnByRHJpNlF1SU95aWhldWpqQ0RzbXBUc3NxMGc3S1NSN0oyMDZyR3c2NEtZSU95TG5PcXdoQ0RzbUlqc2dyRHNuYlFnN0phODY2ZUlJT3lWaUNEcmdxanNsWmpzbkx6cnFiUWc2NUNZN0lLMDY2YXM3S2VBSU95Vml1dUtsT3VMcEM0S0lDQWdJQ0FnYVdZZ0tITm9kWFIwYVc1blJHOTNiaUI4ZkNBaEtHVWdKaVlnWlM1dFpYTnpZV2RsSUQwOVBTQlRSVk5UU1U5T1gwUkpSVVFwSUh4OElFUmhkR1V1Ym05M0tDa2dMU0JxYjJKVGRHRnlkQ0ErSURRd01EQXdLU0IwYUhKdmR5QmxPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0lTNDdJV1k3SjIwSU8yRXRDRHJqNFRzcEpFZzY0R0s2cm1BSU9LQWxDRHNucXpzaTV6cmo1a2c3WnVFSURIdG1vd2c3SjZzN0l1YzY0K0U3WldwNjR1SQ0KNjR1a0xpY3BPd29nSUNBZ0lDQnpkR0Z5ZEZCeWIyTW9LVHNLSUNBZ0lDQWdZWGRoYVhRZ2MyVnVaRlIxY200b2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa3BPd29nSUNBZ0lDQjNZWEp0WldSVmNDQTlJSFJ5ZFdVN0NpQWdJQ0FnSUhSMWNtNXpJRDBnTWpzZ0x5OGc3SnVNNjdDTjdKZUZJREVnS3lEc25iVHJzb2dnN1lTMElDaHpkR0Z5ZEZCeWIyUHNuYlFnTU95Y3ZPdWhuQ0RzdElqcXVMRHRtWlFwQ2lBZ0lDQWdJSEpoZHlBOUlHRjNZV2wwSUhObGJtUlVkWEp1S0dGemF5azdDaUFnSUNCOUNpQWdJQ0JwWmlBb0lYSmxjR0Z5YzJVcElISmxkSFZ5YmlCeVlYYzdDaUFnSUNCc1pYUWdjR0Z5YzJWa0lEMGdjbVZ3WVhKelpTNXdZWEp6WlNoeVlYY3BPd29nSUNBZ0x5OGc3WmlWN0l1ZElPeWR0TzJEaU95ZHRPdXB0Q0Rxc0puc25ZQWc3SVM0N0lXWXdyZnFzSm5zbllBZzdKNmg3SmVRN0lTY0lPcXpwK3llcFNEc25xenNtcFRzc3EwZzRvQ1VJT3lkdENEdGhMVHNuYlFnN0tPOTdKeTg2Nm0wSU95RGlDRHMNCmhManNoWmpzbllBZ0ordXdxZXE0aUNEcmk3VW43SjJFSU91cXNPdWR2QW9nSUNBZ0x5OGc3S2VBN0phMDY0SzhJT3lJbUNEc25vanNuTHpycjREcm9ad2c3SVM0N0lXWUlPeUNyT3VublNEc25xenNpNXpyajRUcmlwUWc3WldZN0tlQUlPeVZpdXF6b0NEcXQ3anJqSURyb1p3ZzdJdWs3WXlvN0l1YzdZS282NHVrS08yTWpPeUxzU0RzaTZUdGpLanJvWndnNnJlQTZyS3dLUzRLSUNBZ0lHbG1JQ2hTUlZCQlVsTkZYMEpCUkNod1lYSnpaV1FwSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JxYjJKVGRHRnlkQ0E4SURjd01EQXdLU0I3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpJenNpN0VnN0l1azdZeW9JT0tBbENEdG1KWHNpNTBnN0o2czdKcVU3TEt0T2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJRE13TUNrcE93b2dJQ0FnSUNCMGRYSnVjeXNyT3dvZ0lDQWdJQ0IwY25rZ2V3b2dJQ0FnSUNBZ0lISmhkeUE5SUdGM1lXbDBJSE5sYm1SVWRYSnVLQ2Zyc0tucXVJZ2c2NHUxDQo3SjIwSU95YWxPcTFyTzJWbkNEdG1KWHNpNTNzbDVBZzdKYTA2cmlMNjRLczY0dWtMaURyc0tucXVJZ2c2NHUxN1pXY0lPdUN0T3lhcWV5ZGhDRHNoS1RycW9YQ3QreUNyT3F6dk1LMzdMMlU2NU9jN1k2YzdJcWtJT3lYaHV5ZHRDRHNsWVRybnBnZ1NsTlBUdXljdk91aG5PdW5qQ0RyaTZUc2k1d2c3TGFjNjZDbDdaV1k2NTI4T2lBbklDc2djbVZ3WVhKelpTNW1iM0p0WVhSRVpYTmpLVHNLSUNBZ0lDQWdJQ0J3WVhKelpXUWdQU0J5WlhCaGNuTmxMbkJoY25ObEtISmhkeWs3Q2lBZ0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3llck95YWxPeXlyU0RzaTZUdGpLZ2c0b0NVSU95VmhPdWVtT3lYa095RW5DRHRqSXpzaTdFZzdJdWs3WXlvNjZHY0lPeXltT3VtckNBcUx5QjlDaUFnSUNCOUNpQWdJQ0JwWmlBb1VrVlFRVkpUUlY5Q1FVUW9jR0Z5YzJWa0tTa2dZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTWpPeUxzU0RzaTZUdGpLZ2dLT3llck95YWxPeXlyU0R0bTRUc2w1RHJqNFFwT2ljcw0KSUZOMGNtbHVaeWh5WVhjcExuTnNhV05sS0RBc0lETXdNQ2twT3dvZ0lDQWdjbVYwZFhKdUlIc2djbUYzTENCd1lYSnpaV1E2SUZKRlVFRlNVMFZmUWtGRUtIQmhjbk5sWkNrZ1B5QnVkV3hzSURvZ2NHRnljMlZrSUgwN0NpQWdmU2s3Q2lBZ0x5OGc3WldjSU95YWxPeXlyZXlkdENEc2k2VHRqS2p0bGJUcmo0UWc2NHVrN0oyTUlPeWFsT3l5cmV5ZHRDRHNuYlRzbHJUc3A0RHJqNFRyb1owZzdZR1E2NHFVSU8yVnJleURnU0RzaExIcXM3WHNuTHpyb1p3ZzdLQ1Y2NmFzQ2lBZ2NYVmxkV1VnUFNCcWIySXVZMkYwWTJnb0tDa2dQVDRnZTMwcE93b2dJSEpsZEhWeWJpQnFiMkk3Q24wS0NpOHZJT3V5aE8yS3ZDRHJuYnpyc3FnZzZyZWM3TG1aSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZ0ordXloTzJLdk95ZGhDRHFzNmpybnBEcmk2UW42ck9nSU95VmpPdWdwT3lraENEcmxZenJwNHdnN0phNTY0cVU2NHVrTGdvdkx5RHJzb1R0aXJ3ZzY2eTQ2cldzNjRxVUlPdXN1T3llcGV5ZHRDRHNsWVRyaTRqcm5id2cNCjY0K1o3SjZSSU95ZHRPdW1oT3lkdE95V3RPeUVuQ3dnN0oyMElPeW5nT3lMbk9xd2dDRHNsNGJzbkx6cnFiUWc2Nnk0N0o2bDdaaVZJT3VNZ095VmlPeWR0Q0RzaEo3c2w2d2c2NEtZN0ppbzY0dWtMZ3BqYjI1emRDQkNWVlJVVDA1ZlVsVk1SU0E5Q2lBZ0oreWR0Q0RyckxqcXRhenJpcFFnS2lycnNvVHRpcndnNjUyODY3S29LaXJzbmJUcmk2UXVJT3VzdU95ZXBleWR0Q0RzbFlUcmk0anJuYndnNjQrWjdKNlJJT3lkdE91bWhPeWR0T3V2Z091aG5Eb2c2NmVJN0xtbzdaR2N3cmZyckx6c25ZenRrWnpDdCt5aWhlcXlzT3lXdE91dnVDaCs3SnFVTDM3cmk2UXZmdXE1ak95YWxDa2c2cmlJN0tlQUxDQW5JQ3NLSUNBbjY1Q1k2NCtFNjZHZElPeW5wK3lkZ0NEcmo1bnNucEVnNjZxRjdJS3NLT3lnZ095ZXBjSzM3SUt0N0tDY3dyZnNsN0Rxc3JBZzdaVzA3S0NjSU91VHNTbnJvWndzSU8yR3RldXp0T3lFc1NEcmk2anNuYndnNjdLRTdZcTg3SjIwNjZtMElDTHRtWlhzbmJnaUxpQW5JQ3NLSUNBbkl1eTNxT3lHDQpqQ0xyaXBRZzY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1JT3lUc09xem9Dd2c3Wm1VNjZtMElPcTRzT3VLcGV1cWhTanJzNERxc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bk93b0tMeThnNjZ5NDZyV3NJT3kybE95eW5DRHRoTFFnS0hKdmJHVTlKK3V5aE8yS3ZDZnNuYlRycWJRZzY3S0U3WXE4SU9xM25PeTVtZXlkaENEc2xybnJpcFRyaTZRcENtWjFibU4wYVc5dUlHRnphME5zWVhWa1pTaDBaWGgwTENCdGIyUmxiQ3dnY21Wd1lYSnpaU3dnY205c1pTa2dld29nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJR0YwZEdWdGNIUWdQU0FvWVhOclpXUkRiM1Z1ZEM1blpYUW9kR1Y0ZENrZ2ZId2dNQ2tnS3lBeE93b2dJQ0FnWVhOclpXUkRiM1Z1ZEM1elpYUW9kR1Y0ZEN3Z1lYUjBaVzF3ZENrN0NpQWdJQ0JwWmlBb1lYTnJaV1JEYjNWdWRDNXphWHBsSUQ0Z01qQXdLU0JoYzJ0bFpFTnZkVzUwTG1Ocw0KWldGeUtDazdJQzh2SU91c3RPMlZuTzJlaUNEc2pKUHNuYlRzcDRBZzdKV0s2cktNQ2lBZ0lDQmpiMjV6ZENCeWRXeGxJRDBnY205c1pTQTlQVDBnSit1eWhPMkt2Q2NnUHlCQ1ZWUlVUMDVmVWxWTVJTQTZJQ2NuT3dvZ0lDQWdjbVYwZFhKdUlISjFiR1VnS3lBb1lYUjBaVzF3ZENBK0lERUtJQ0FnSUNBZ1B5QW42ckNaN0oyQUlPdXN1T3Exck91bHZDRHJpNlRzaTV3ZzdKcVU3TEt0N1pXYzY0dWtMaURzbmJRZzdJUzQ3SVdZN0plUTdJU2NJT3lkdE95Z2hPeVhrQ0Rzb0p6c2xZanRsb2pyalpnZzZyS0Q2NU9rNnJPOElPcXl1ZXk1bU95bmdDRHNsWXJyaXBRc0lPcTFyT3loc091Q21DRHNsclR0bkpqcXNJQWc3Wm1WN0l1azdaNklJT3VMcE91bHVDRHNnNGpyb1p6c21yUWc2NHlBN0pXSUlEUHFzSnpycGJ3ZzZyZWM3TG1aNjR5QTY2R2NJRXBUVDA0ZzY3Q3c3SmUwNjZHYzY2ZU1PaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvZEdWNGRDa0tJQ0FnSUNBZ09pQW42NHVrN0oyTUlGVkpJT3VzdU9xMXJPeWQNCm1DRHJqSURzbFlnZ00rcXduT3VsdkNEcXQ1enN1Wm5yaklEcm9ad2dTbE5QVGlEcnNMRHNsN1Ryb1p6cnA0dzZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtTazdDaUFnZlN3Z2JXOWtaV3dzSUhKbGNHRnljMlVwT3dwOUNnb3ZMeURyc29qc2w2MGc3WVMwSU9LQWxDRHFzSm5zbllBZzdJUzQ3SVdZN0oyRUlPeVRzT3VRbUN3ZzdKMjA2N0tJSU8yRXRPdW5qQ0RzdHBUc3Nwd2c3WmlWN0l1ZEtFcFRUMDRnNjdDdzdKZTBLU0RyaklEc2k2QWc2N0tJN0pldElPMllsZXlMblNoS1UwOU9JT3F3bmV5eXRDbnNuWVFnN0pxVTZyV3M3WldjNjR1a0NtWjFibU4wYVc5dUlHRnphMVJ5WVc1emJHRjBaU2gwWlhoMExDQnRiMlJsYkN3Z2NtVndZWEp6WlNrZ2V3b2dJSEpsZEhWeWJpQnlkVzVVZFhKdUtDZ3BJRDArSUNnS0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJT3V5aU95WHJTRHNucEhzbDRYc25iVHJpNlFnS091c3VPcTFyQ0RyaTZUcms2enF1TEFnN0pXRTY0dVlJT0tBbENEcmpJRHNsWWdnDQpNK3F3bkNEcXQ1enN1Wm5zbllBZzdKMjA2N0tJSU8yRXRPeVhrQ0Rzb0lIc21xbnRsWmpzcDRBZzdKV0s2NHFVNjR1a0tTNGdKeUFyQ2lBZ0lDQW42NHVrN0oyTUlGVkpJT3VzdU9xMXJPcXdnQ0R0bFp6cXRhM3NsclRycWJRZzdKNlE3SmV3N0lxazY1K3M3SnEwSU95WWdleVd0T3VobkN3ZzdKaUI3SmEwNjZtMElPeWVrT3lYc095S3BPdWZyT3lhdENEdGxaenF0YTNzbHJUcm9ad2c2N0tJN0pldDdaV1k2NTI4TGlBbklDc0tJQ0FnSUNkVlNTRHJyTGpxdGF6cmk2VHNtclFnNnJDRTZyS3c3WldjSU8yUm5PMlloT3lkaENEc2s3RHFzNkFzSU95ZHRPdW1oTUszN0lpcjdKNlF3cmZycDRqc2lxVHRncm5DdCsyVWpPdWdpT3lkdE95S3BPMlpnT3VObE91S2xDRHF0N2pyaklEcm9ad2c2N08wN0tHMDdaV2M2NHVrTGlBbklDc0tJQ0FnSUNmc201RHJyTGpzblpnZzdLU0VJT3lJbU91bHZDRHF0N2pyaklEcm9ad2c3SnlnN0tlQTdaV2M2NHVrSU9LQWxDRHNtNURyckxqc25iUWc3WldjSU95a2hPeWR0T3VwdENEcg0Kc29qc2w2M3JqNFFnN1pXY0lPeWtoT3VobkN3ZzdLU0U2N0NVNnIrSTdKMkVJT3llaE95ZG1PdWhuQ0RzdHBUcXNJRHRsWmpzcDRBZzdKV0s2NHFVNjR1a0xpQW5JQ3NLSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZJT3E0aU95bmdEb2dKeUFyQ2lBZ0lDQW5leUowY21GdWMyeGhkR1ZrSWpvZ0l1dXlpT3lYcmV1c3VDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpWkdseVpXTjBhVzl1SWpvZ0ltdHY0b2FTWlc0ZzY1aVE2NHFVSUdWdTRvYVNhMjhpZlRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwQ2lBZ0tTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93cDlDZ292THlEcmpJRHRtWlR0bUpVZzY2eTQ2cldzSU95Z25PeWVrU0R0aExRZzRvQ1VJT3lDck95YXFleWVrT3F3Z0NEc2c0SHRtYW5zbllRZzdJU2s2NnFGN1pXWTY2bTBJT3VucGV1ZHZleVgNCmtDRHJwNTdyaXBRZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RPeWtnT3VMcEM0S0x5OGdiV1Z6YzJGblpYTTZJRnQ3Y205c1pUb25kWE5sY2lkOEoyRnpjMmx6ZEdGdWRDY3NJSFJsZUhSOVhTRHNvSVRzc3JRZzY0eUE3Wm1VNjZXOElPdW5wT3V5aUNEcnNKdnJpcFRyaTZRbzY0dWs2NmFzNjRxVUlPdXN0T3lEZ2UyRG5DRGlnSlFLTHk4ZzdKdU02N0NON0plRklPeW5nT3lMbk91c3VPeWRtQ0FpN0pxVTdMS3Q2NU9rN0oyQUlPeUVuT3VobkNEcnJMVHF0SUFpSU95Z2hPeWduT3VsdkNEc3A0RHRncVRxdUxBZzdKeUU3WlcwSU91TWdPMlpsQ0RycDZYcm5iM3NuWVFnN1lTMElPeVZpT3lYa0NEcnFyM3JsWVVnN0l1ajY0cVU2NHVrS1M0S1puVnVZM1JwYjI0Z1lYTnJRMjl0Y0c5elpTaHRaWE56WVdkbGN5d2diVzlrWld3c0lISmxjR0Z5YzJVcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0NpQWdJQ0JqYjI1emRDQjBjbUZ1YzJOeWFYQjBJRDBnS0cxbGMzTmhaMlZ6SUh4OElGdGRLUzV0DQpZWEFvS0cwcElEMCtDaUFnSUNBZ0lDaHRMbkp2YkdVZ1BUMDlJQ2RoYzNOcGMzUmhiblFuSUQ4Z0oreVd0T3lMbk95S3BPMkV0TzJLdURvZ0p5QTZJQ2ZzZ3F6c21xbnNucEE2SUNjcElDc2dVM1J5YVc1bktHMHVkR1Y0ZENCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTVRVd01Da0tJQ0FnSUNrdWFtOXBiaWduWEc0bktUc0tJQ0FnSUhKbGRIVnliaUFvQ2lBZ0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJQ0xyaklEdG1aVHRtSlVnNjZ5NDZyV3NJT3lnbk95ZWtTTHNuYlRyaTZRZ0tPcTRzT3lodENEcnJManF0YXdnNjR1azY1T3M2cml3SU95VmhPdUxtQ0RpZ0pRZzdKV0U2NTZZSU91TWdPMlpsT3F3Z0NEc25iVHJzb2dnN1lTMDdKMllJT3lnaE95eXRDRHJwNlhybmIzc25iVHJpNlFwTGlBbklDc0tJQ0FnSUNBZ0oreUNyT3lhcWV5ZWtPcXdnQ0R0bVpUcnFiUWc3SU9CN1ptcHdyZnJwNlhybmIzc25ZUWc3SVNrNjZxRjdaV1k2Nm0wTENEc2lxVHRnNERzbmJ3ZzZyZWM3TG1aNnJPOElPeVlpT3lMbkNEdA0KaHFUc2w1QWc2NmVlNjRxVUlGVkpJT3VzdU9xMXJPdWx2Q0RycDR6cms2VHNsclFnN0tDYzdKV0k3WldZNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU91bnBldWR2ZXlkdENEcnRvRHNvYkh0bFpqcnFiUWc3WTY0N1pXWTZyS01JT3VRbU91c3ZPeVd0T3VkdkRvZzdKYTA2NWFrSU8yWmxPdXB0TUszNnJpdzY0cWw3SjJZSU91c3VPcTFyT3lkdU95bmdDd2c2NU9rN0phMDZyQ0lJT3lla091bXJPdUtsQ0RzbHJUcmxKVHNuYmpzcDRBbzdZeWQ3SmVGSU8yRGdPeWR0TzJMZ0MvcnM3anJyTGd2NjdLRTdZcThMQ0R0aHFEc2lxVHRpcmdzSU91NWlDRHRtWlRycWJRZzdKV0k2NEswTENEcnNMRHJoSWdnNjVPeEtTd2c3SmEwNjVha0lPeURnZTJacWV5ZHVPeW5nQ2pzaExIcXM3VWc3WWExNjdPMEwreVlwT3VsbUMvdG1aWHNuYmdnN0pxVTdMS3RMK3lWaU91Q3RDa2c2ckNaN0oyQUlPcXlneTRnNnJ5dElPMlZoT3lhbE8yVm5DRHFzb1BycDR3ZzZyT282NTI4SU8yVm5DRHJzb2pzbDVBZzdMV2M2NHlBSURMcXNKenENCnVZenNwNEFzSU95bnArcXlqQzRnN0oyMDY1V01JSE4xWjJkbGMzUnBiMjV6NjRxVUlPdTVpQ0Ryc0xEc2w3UXVYRzRuSUNzS0lDQWdJQ0FnSnkwZzZyQ1E3SjIwSU95V3RPdUtrQ0Rzb0pYcmo0UWc3SmlrNjZtMElPdXN1K3E0c091bmpDRHRsWmpzcDRBZzY2ZUk2NTI4SU9LQWxDRHFzSURzb0pYc25ZUWc3SVM0N0pxdzZyT2dJT3kwaU95VmlDQnpkV2RuWlhOMGFXOXVjK3VsdkNEdGxhanF1NWdnNjRLMDY2bTA3SVNjTENCeVpYQnNlZXlYa0NEcXNJRHNvSlhzbllRZzY3Q2Q3WjZJNnJPZ0lPdXN0T3lYaCt5ZGhDRHNsWXpyb0tUc283enJxYlFnNjQyVUlPdW5udXkybkNEc2lKZ2c3SjZJNjRxVTdLZUFJTzJWbkNEcnJManNucVhzbkx6cm9ad2c2NDJuNjdhWjdKZXM2NTI4S095WWlEb2dJdTJabGV5ZHVDRHRqSjNzbDRYc25iVHJuYnpxczZBZzZyQ0E3S0NWN1phSTdKYTA3SnFVSU9LQWxDRHRocURzaXFUdGlyanJuYnpycWJRZzdKV002NkNrN0tPODdJUzQ3SnFVSWlrdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnDQo2Nnk0NnJXczY2VzhJT3lnbk95VmlPMlZvQ0RybFpBZzdJU2M2NkdjSU95Z2tlcTN2T3lkdENEcmk2VHJwYmdnTW40ejZyQ2NMaURxc0lFZzdLQ2M3SldJN0plVUlPeVpuQ0RxdDdqcm9JZnFzb3dnN0kyODY0cVU3S2VBSU95ZHRPeWNvT3VsdkNEcnRwbnNuYmpyaTZRdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN0lLczdKcXA3SjZRNnJDQUlPeVd1T3E0aWUyVm1PeW5nQ0RzbFlyc25ZQWc2cldzN0xLMElPeWdsZXV6dENqc29JVHRtWlRyc29qdG1MakN0MVZTVE1LMzZyaUk3Sldod3JmdG1wL3NpSmdnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjRTajdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEdG00VHNobzBnN0pxVTdMS3RLQ0xyalpRZzdLZW42cktNSWl3Z0l1dXloTzJLdk95YXFleWN2T3VobkNJZzY1T3hLZXlkdE91cHRDRHNwNEhzb0lRZzdLQ2M3SldJN0oyRUlPcTN1Q0Ryc0tudGxxWHNuTHpyb1p3ZzZyT2c3TE9RSU91THBPeUxuQ0Rzb0p6c2xZanRsWmpybmJ3dVhHNG5JQ3NLSUNBZw0KSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURxc0ozc3NyUWc3WldZNjRLWTY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvVWc2cmlJN0tlQU9pQW5JQ3NLSUNBZ0lDQWdKM3NpY21Wd2JIa2lPaUFpNjR5QTdabVVJT3lka2V1THRTRHRsWnpya1pBZzY2eTQ3SjZsSUNqdGxiVHNtcFRzc3JRcElpd2dJbk4xWjJkbGMzUnBiMjV6SWpvZ1czc2lkR1Y0ZENJNklDTHJyTGpxdGF3Z0tPeWtoT3V3bE9xL2lPeWRnQ0JjWEc0cElpd2dJbkpsWVhOdmJpSTZJQ0xzbmJUc25LQWc3WldjSU91c3VPeWVwU0o5WFgxY2JseHVKeUFyQ2lBZ0lDQWdJQ2RiNjR5QTdabVVYVnh1SnlBcklIUnlZVzV6WTNKcGNIUUtJQ0FnSUNrN0NpQWdmU3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBPd3A5Q2dvdkx5RHRsSVRyb0lqc25vVHJzNFFvN1pXWTdKeUVJTzJVaE91Z2lPeWVoQ0Ryckxic25Zd3BJT3kybE95eW5DRHRoTFFnNG9DVUlPMlZuQ0R0bVpUcnFiVHNuWVFnN1pXWTdKeUUNCklPMlVoT3VnaU95ZWhDRHJpNmpzbklUcm9ad2c2NEtZNjRpZ0lPdXp0T3VDdE9xem9Dd0tMeThnS2lydGxJVHJvSWpzbm9UcnA0anJpNlFnNjVTdzY2R2NLaW9nNjR5QTdKV0k3SjJFSU91d20rdUtsT3VMcEM0ZzdaV2NJT3lhbE95eXJleVhrQ0RyaTZRZzdJdWs3SmEwSU91enRPdUN0T3VLbENEcXNvUHNuYlFnN1pXMTdJdXNPZ292THlEdGxJVHJvSWpzbm9RZzdJaVk2NmVNN1lHOElPeWFsT3l5cmV5ZGhDRHNxcnpxc0p6cnFiUWc2cmU0NjZlTTdZRzhJT3VLa091Z3BPeW5nT3F6b0NqcXNJRWdOWDR4TU95MGlDa2c2cldzNjQrRklPeUNyT3lhcWV1ZmlldVBoQ0RxdDdqcnA0enRnYndnNjRLWTZyQ0U2NHVrTGdvdkx5Qm5jbTkxY0hNNklGdDdibUZ0WlN3Z2RHVjRkSE02VzExOVhTQW83Wm1VNjZtMElPeWNoT0tHa3V5VmhPdWVtQ0RzaUp3cExncG1kVzVqZEdsdmJpQmhjMnRIY205MWNITW9aM0p2ZFhCekxDQnRiMlJsYkN3Z2NtVndZWEp6WlN3Z2JXOXlaU2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1DQpLQ2dwSUQwK0lIc0tJQ0FnSUM4dklPdXloTzJLdkNEc21JSHNsNjNzbllBZ0tPdXloTzJLdkNuc25MenJvWndnN0xDTjdKYTBJT3V6dE91Q3VPdUxwQ0RpZ0pRZzY3S0U3WXE4SU91c3VPcTFyT3VLbENEcnJManNucVhzbmJRZzdKV0U2NHVJNjUyOElPdVBtZXlla1NEc25iVHJwb1RzbmJUcm5id2c2cmVjN0xtWjdKMjBJT3VMcE91bHRPdUxwQW9nSUNBZ1kyOXVjM1FnYkdsemRDQTlJQ2huY205MWNITWdmSHdnVzEwcExtMWhjQ2dvWnl3Z2FTa2dQVDRLSUNBZ0lDQWdKMXNuSUNzZ0tHa2dLeUF4S1NBcklDZGRJQ2NnS3lCVGRISnBibWNvS0djZ0ppWWdaeTV1WVcxbEtTQjhmQ0FvSitxM3VPdWp1U2NnS3lBb2FTQXJJREVwS1NrZ0t5QW9aeUFtSmlCbkxuSnZiR1VnUFQwOUlDZnJzb1R0aXJ3bklEOGdKeUFvNjdLRTdZcThLU2NnT2lBbkp5a2dLeUFuWEc0bklDc0tJQ0FnSUNBZ0tHY2dKaVlnUVhKeVlYa3VhWE5CY25KaGVTaG5MblJsZUhSektTQS9JR2N1ZEdWNGRITWdPaUJiWFNrdWJXRndLQ2gwS1NBOQ0KUGlBbklDQXRJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2hUZEhKcGJtY29kQ0I4ZkNBbkp5a3BLUzVxYjJsdUtDZGNiaWNwQ2lBZ0lDQXBMbXB2YVc0b0oxeHVKeWs3Q2lBZ0lDQmpiMjV6ZENCb1lYTkNkRzRnUFNBb1ozSnZkWEJ6SUh4OElGdGRLUzV6YjIxbEtDaG5LU0E5UGlCbklDWW1JR2N1Y205c1pTQTlQVDBnSit1eWhPMkt2Q2NwT3dvZ0lDQWdZMjl1YzNRZ2EyVjVJRDBnSjJkeWIzVndjeWNnS3lBb1ozSnZkWEJ6SUh4OElGdGRLUzV0WVhBb0tHY3BJRDArSUNobklDWW1JR2N1ZEdWNGRITWdQeUJuTG5SbGVIUnpMbXB2YVc0b0p5Y3BJRG9nSnljcEtTNXFiMmx1S0NjbktUc0tJQ0FnSUdOdmJuTjBJR0YwZEdWdGNIUWdQU0FvWVhOclpXUkRiM1Z1ZEM1blpYUW9hMlY1S1NCOGZDQXdLU0FySURFN0NpQWdJQ0JoYzJ0bFpFTnZkVzUwTG5ObGRDaHJaWGtzSUdGMGRHVnRjSFFwT3dvZ0lDQWdhV1lnS0dGemEyVmtRMjkxYm5RdWMybDZaU0ErSURJd01Da2dZWE5yWldSRGIzVnVkQzVqYkdWaGNpZ3ANCk93b2dJQ0FnWTI5dWMzUWdZV2RoYVc0Z1BTQnRiM0psSUh4OElHRjBkR1Z0Y0hRZ1BpQXhDaUFnSUNBZ0lEOGdKK3lkdENEdG1aVHJxYlRzbllBZzdKMjBJT3lFdU95Rm1PeVhrT3lFbkNEc25iVHJyN2dnNjR1azY2U1k2NHVrTGlEc2xaN3NoSndnNjRLNElPdU1nT3lWaU9xenZDRHNsclR0bkpqQ3QrcTFyT3loc09xd2dDRHRtWlhzaTZUdG5vZ2c2NHVrNjZXNElPeURpQ0RyaklEc2xZanJwNHdnNjRLMDY1MjhMbHh1SndvZ0lDQWdJQ0E2SUNjbk93b2dJQ0FnY21WMGRYSnVJQ2dLSUNBZ0lDQWdZV2RoYVc0Z0t3b2dJQ0FnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTdabVU2Nm0wN0oyRUlPMlZtT3ljaENEdGxJVHJvSWpzbm9UcnM0VHJvWndnNjRLWTY0aWdJT3VMcE91VHJPcTRzQ0xyaTZRdUlPeVZoT3VlbU91S2xDRHRsWndnN1ptVTY2bTA3SjJZSU91c3VPcTFyT3VsdkNEdGxaanNuSVFnN1pTRTY2Q0k3SjZFS095WWdleVhyU2tnNjR1bzdKeUU2NkdjSU91c3R1eWRnQ0Rxc29Qc25iVHJpNlF1DQpYRzRuSUNzS0lDQWdJQ0FnSnlvcTdKaUI3SmV0NjZlSTY0dWtJT3VVc091aG5Db3FJT3VNZ095VmlPeWRoQ0RyZ3JUcm5id2c0b0NVSU95WWdleVhyZXlkaENEc2hKenJvWndnN1pXcDdMbVk2ckd3NjRLWUlPeUluT3lFbk91bHZDRHJzSlRxdnJqc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU9xd2dTRHNtSUhzbDYzc2w1QWc2NHlBN0pXSUlETHFzSnd1SU9xM3VDRHNtSUhzbDYzc25iUWc3SmVzNjUrc0lPeWtoT3lkdE91cHRDRHJqSURzbFlqcmo0UWdLaXJxc0puc25ZQWc3S1NFSU95SW1Db3E2NkdjS095a2hPdXdsT3EvaUNCY1hHN3NuTHpyb1p3ZzZyV3M2N2FFTENEc3BJUWc3SWljN0lTY0lPeWNvT3luZ0NrdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN0ppQjdKZXQ3SjJZSU95WHJlMlZvQ2p0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcThJT3VUc1NucXM3d2c3SnVRNjZ5NDdKMllJT3lnbGV1enRNSzM3S0d3NnJHMEtPeUlxK3lla01LMzY0eUE3SU9Cd3Jmc29iRHFzYlFwN0oyQQ0KSU95Y29PeW5nTzJWbU9xem9Dd2c3SmVHNjRxVUlPeWdsZXV6dE91bHZDRHNwNERzbHJUcmdyVHNwNEFnNjZlSTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPcXpvT3k1b0NEcXNvd2c3SmVHNjRxVUlPeVlnZXlYcmV5ZHRPdXB0Q0RyaklEc2xZZ2dNZXF3bk91bmpDRHJnclRxc2JEcmdwZ2c2N21JSU91d3NPeVh0T3VobkNEcmtaRHNsclRyajRRZzY1Q2M2NHVrSU9LQWxDRHNsclhzcDREcm9ad2c2N0NVNnI2NDdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEdG1aVHJxYlFnNnJpdzY0cWw2NnFGS091emdPcXl2Y0szN1pXMDdLQ2NJT3VUc1Nuc25ZQWc2cmU0NjR5QTY2R2NJT3VSbE91THBDNWNiaWNnS3dvZ0lDQWdJQ0FvYUdGelFuUnVJRDhnSnkwZ0tPdXloTzJLdkNuc25MenJvWndnN1pHYzdJdWM2NUNjSU95WWdleVhyZXlkZ0NBbklDc2dRbFZVVkU5T1gxSlZURVVnT2lBbkp5a2dLd29nSUNBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU9xd25leXl0Q0R0bFpqcmdwanINCnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhjSzM3TDJVNjVPYzdZNmM3SXFrSU9xNGlPeW5nRHBjYmljZ0t3b2dJQ0FnSUNBbmV5Sm5jbTkxY0hNaU9pQmJleUp1WVcxbElqb2dJdXlZZ2V5WHJTRHNuYlRycG9RbzdKNkY2NkNsNnJPOElPdVBtZXlkdkNraUxDQWljM1ZuWjJWemRHbHZibk1pT2lCYmV5SjBaWGgwSWpvZ0l1dU1nT3lWaUNEcnJManF0YXdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBZzdaV2NJT3VzdU95ZXBTSjlYWDFkZlZ4dUp5QXJDaUFnSUNBZ0lDZnNtSUhzbDYzc25ZQWc3SjZGNjZDbElPeUluT3lFbk1LMzZyQ2M3SWlZNjZXOElPcTN1T3VNZ091aG5DRHNwNER0Z3Fqcmk2UXVYRzVjYmljZ0t3b2dJQ0FnSUNBblcreVlnZXlYcmV1emhDRHJyTGpxdGF4ZFhHNG5JQ3NnYkdsemRBb2dJQ0FnS1RzS0lDQjlMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdDbjBLQ2k4dklPMlVoT3VnaU95ZWhPdXpoQ0RzDQp0cFRzc3B3ZzdKMlI2NHUxN0plUTdJU2NJRnQ3Ym1GdFpTd2djM1ZuWjJWemRHbHZibk02VzN0MFpYaDBMQ0J5WldGemIyNTlYWDFkSU95MmxPeTJuQXBtZFc1amRHbHZiaUJ3WVhKelpVZHliM1Z3Y3loeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzhnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ1kyOXVjM1FnWVhKeUlEMGdRWEp5WVhrdWFYTkJjbkpoZVNodklDWW1JRzh1WjNKdmRYQnpLU0EvSUc4dVozSnZkWEJ6SURvZ1cxMDdDaUFnSUNCamIyNXpkQ0JuY205MWNITWdQU0JoY25JdWJXRndLQ2huS1NBOVBpQW9ld29nSUNBZ0lDQnVZVzFsT2lCVA0KZEhKcGJtY29LR2NnSmlZZ1p5NXVZVzFsS1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQW9nSUNBZ0lDQnpkV2RuWlhOMGFXOXVjem9nUVhKeVlYa3VhWE5CY25KaGVTaG5JQ1ltSUdjdWMzVm5aMlZ6ZEdsdmJuTXBDaUFnSUNBZ0lDQWdQeUJuTG5OMVoyZGxjM1JwYjI1ekNpQWdJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tIZ3BJRDArSUNoMGVYQmxiMllnZUNBOVBUMGdKM04wY21sdVp5Y0tJQ0FnSUNBZ0lDQWdJQ0FnSUNBL0lIc2dkR1Y0ZERvZ2VDNTBjbWx0S0Nrc0lISmxZWE52YmpvZ0p5Y2dmUW9nSUNBZ0lDQWdJQ0FnSUNBZ0lEb2dleUIwWlhoME9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1MFpYaDBLU0I4ZkNBbkp5a3VkSEpwYlNncExDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tLSUNBZ0lDQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb2VDa2dQVDRnZUM1MFpYaDBLUW9nSUNBZ0lDQWdJRG9nVzEwc0NpQWdJQ0I5S1NrN0NpQWdJQ0F2THlEc25iVHINCnBvVHNvYkRzc0tnZzdKZUc2ck9nSU95Z25PeVZpT3VQaENEc2w0YnJpcFFnNnJ1TjY0Mnc2cml3NjZlTUlPeVpsT3ljdk91cHRDRHRtSlhzaTUwZzdKMjA3WU9JNjZHY0lPdXp1T3VMcENqcXNKbnNuWUFnN0lTNDdJV1k3SmVRSU95ZXJPeWFsT3l5clNrS0lDQWdJSEpsZEhWeWJpQm5jbTkxY0hNdWMyOXRaU2dvWnlrZ1BUNGdaeTV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dwSUQ4Z1ozSnZkWEJ6SURvZ2JuVnNiRHNLSUNCOUlHTmhkR05vSUNoZlpTa2dld29nSUNBZ2NtVjBkWEp1SUc1MWJHdzdDaUFnZlFwOUNnb3ZMeUR0akozc2w0VWc3SVM0N1lxNElPeTJsT3l5bkNEdGhMUWc0b0NVSU8yVm5DRHRqSjNzbDRYc25aZ2c2cldzN0lTeDdKcVU3SWFNS095WHJlMlZvQ3ZyckxqcXRhd3A2Nlc4SU8yVm5DRHJzb2pzbDVBZzY3TzA2NEswNnJPZ0xBb3ZMeURzbXBUc2hvenJzNFFnNjRLeDZyQ2M2ckNBSU95VmhPdUxpT3VkdkNBcUt1eVpoT3lFc2V1UW5DRHRqSjNzbDRVZzdJUzQ3WXE0S095OGdPeWR0T3lLDQpwQ2tnTW40ejZyQ2NLaXJycGJ3ZzdZYTE3Snk4NjZHY0lPdXdtK3VLbE91THBDNEtMeThnN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2T3lkdENEdGxad2c2NnE0N0p5ODY2R2NJT3lkdk9xMGdPdVB2T3lWdkNEdGxaanJyNERyb1p3bzY1U3c2NkdjSU91OWtleVZoQ0Rzb2JEdGxhbnRsWmpycWJRZzdKYTA2cmlMNjRLYzY0dWtLU0RzaExqdGlyZ2c2NHVvN0p5RTY2R2NJT3lnbk95VmlPMlZtT3F5akNEdGxaenJpNlF1Q2k4dklHVnNaVzFsYm5Sek9pQmJlM0p2YkdVc0lIUmxlSFI5WFNBbzdabVU2Nm0wSU95Y2hPS0drdXlWaE91ZW1DRHNpSndwTGdvdkx5QnRiM0psUFhSeWRXVW9XK3k4Z095ZHRPeUtwQ0RyalpRZzY3Q2I2cml3WFNucnFiUWc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRycjdnZzY0SzRJT3lFdU8yS3VPeVpnQ0Rxc3Juc3VaanNwNEFnN0pXSzY0cVVJT3lEaUNEc2hManRpcmpycGJ3ZzdKcVU2cldzN1pXYzY0dWtMZ3BtZFc1amRHbHZiaUJoYzJ0UWIzQjFjQ2hsYkdWdA0KWlc1MGN5d2diVzlrWld3c0lISmxjR0Z5YzJVc0lHMXZjbVVwSUhzS0lDQnlaWFIxY200Z2NuVnVWSFZ5Ymlnb0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCeWIyeGxjeUE5SUNobGJHVnRaVzUwY3lCOGZDQmJYU2t1YldGd0tDaGxLU0E5UGlCVGRISnBibWNvS0dVZ0ppWWdaUzV5YjJ4bEtTQjhmQ0FuSnlrcExtcHZhVzRvSnl3Z0p5azdDaUFnSUNCamIyNXpkQ0JzYVhOMElEMGdLR1ZzWlcxbGJuUnpJSHg4SUZ0ZEtTNXRZWEFvS0dVc0lHa3BJRDArQ2lBZ0lDQWdJQ2hwSUNzZ01Ta2dLeUFuTGlCYkp5QXJJRk4wY21sdVp5Z29aU0FtSmlCbExuSnZiR1VwSUh4OElDY25LU0FySUNkZElDY2dLeUJLVTA5T0xuTjBjbWx1WjJsbWVTaFRkSEpwYm1jb0tHVWdKaVlnWlM1MFpYaDBLU0I4ZkNBbkp5a3BDaUFnSUNBcExtcHZhVzRvSjF4dUp5azdDaUFnSUNBdkx5RHFzSm5zbllBZzdZeWQ3SmVGN0oyRUlPdXFoeURyc29qc3A3Z2c2Nnk3NjRxVTdLZUFJT3E0c095V3RTRGlnSlFnN0o2czdKcVU3TEt0N0oyMDY2bTANCklDTHNuYlRzb0lUcXM3d2c2NHVrNjZXNElPeUV1TzJLdUNMcnBid2c3SnFVNnJXczdaV2M2NHVrQ2lBZ0lDQXZMeUFvWVhOclEyeGhkV1JsN0ptQUlPcXdtZXlkZ0NEc25iVHNuS0E2SU95VmlDRHF0N2pybjZ6cnFiUWc3WUcwNjZHYzY1T2M2ckNBSU9xd21leWRnQ0RzaExqdGlyanJwYndnNjVpUUlPdUN0T3lFbkNCYjdMeUE3SjIwN0lxa0lPdU5sQ0Ryc0p2cXVMQmQ2ckNBSU91c3RPeWRtT3V2dU8yVnRPeW5oT3VMcENrS0lDQWdJR052Ym5OMElHdGxlU0E5SUNkd2IzQjFjQUVuSUNzZ0tHVnNaVzFsYm5SeklIeDhJRnRkS1M1dFlYQW9LR1VwSUQwK0lGTjBjbWx1Wnlnb1pTQW1KaUJsTG5SbGVIUXBJSHg4SUNjbktTa3VhbTlwYmlnbkFTY3BPd29nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2hyWlhrcElIeDhJREFwSUNzZ01Uc0tJQ0FnSUdGemEyVmtRMjkxYm5RdWMyVjBLR3RsZVN3Z1lYUjBaVzF3ZENrN0NpQWdJQ0JwWmlBb1lYTnJaV1JEYjNWdWRDNXphWHBsDQpJRDRnTWpBd0tTQmhjMnRsWkVOdmRXNTBMbU5zWldGeUtDazdJQzh2SU91c3RPMlZuTzJlaUNEc2pKUHNuYlRzcDRBZzdKV0s2cktNQ2lBZ0lDQmpiMjV6ZENCaFoyRnBiaUE5SUcxdmNtVWdmSHdnWVhSMFpXMXdkQ0ErSURFS0lDQWdJQ0FnUHlBbjdKMjBJTzJNbmV5WGhleWRnQ0RzbmJRZzdJUzQ3SVdZN0plUTdJU2NJT3lkdE91dnVDRHJpNlRycEpqcmk2UXVJT3lWbnV5RW5DRHNvSnpzbFlqdGxad2c3SVM0N1lxNDY1T2s2ck84SUNvcTdLQ1I2cmU4d3Jmc2xyVHRuSmpxc0lBZzdabVY3SXVrN1o2SUlPdUxwT3VsdUNEc2c0Z2c3SVM0N1lxNEtpcnJwNHdnNjRLMDY1MjhLT3F3bWV5ZGdDRHNoTGp0aXJnZzY3Q1k2N08xSU9xNGlPeW5nQ2t1WEc0bkNpQWdJQ0FnSURvZ0p5YzdDaUFnSUNCeVpYUjFjbTRnS0FvZ0lDQWdJQ0JoWjJGcGJpQXJDaUFnSUNBZ0lDZnNuYlRyc29nZzdKcVU3TEt0N0oyQUlDTHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1NEc2hManRpcmdnNjR1azY1T3M2cml3SXV1TA0KcEM0ZzdKV0U2NTZZNjRxVUlPMlZuQ0R0akozc2w0WHNuWVFnN0p5RTRvYVM3SldFNjU2WTY2R2NJT3VDbU95WHRPMlZuQ0RxdGF6c2hMSHNtcFRzaG96cms2VHNuYlRyaTZRbzdJU2M2NkdjSU91c3RPcTBnTzJWbkNEcnM0VHFzSndnNjZ5NDZyV3M2ckNBSU95VmhPdUxpT3VMcENrdUlDY2dLd29nSUNBZ0lDQW43SnFVN0lhTTY2VzhJT3VDc2Vxd25PdWhuQ0RxczZEc3VaanNwNEFnNjZlUTZyT2dMQ0FxS3UyRGdPeWR0TzJMZ01LMzdKV0k2NEswd3JmcnNvVHRpcnpzbmJRZzdJU2M2NkdjSU95ZHZPcTBnT3VRbkNBaTdKbUU3SVN4NjVDY0lPMk1uZXlYaFNEc2hManRpcmdpSURKK00rcXduQ29xNjZXOElPeWduT3lWaU8yVm1PdWR2QzRnNnJDQklPeUV1TzJLdU91S2xDRHNoSnpyb1p3ZzY0dWs2Nlc0SU95Z2tlcTN2T3lkdE95V3RPeVZ2Q0R0bFp6cmk2UXVYRzRuSUNzS0lDQWdJQ0FnSitxd2dTRHNoTGp0aXJqcmlwUWc3SjZGNjZDbDZyTzhJQ29xNnJDWjdKMkFJT3lYcmUyVm9NSzM2ckNaN0oyQUlPcXcNCm5PeUltTUszNnJDWjdKMkFJT3lJbk95RW5Db3E3SjJZSU95YWxPeUdqT3VsdkNEcnFxanJrWkFnN1krczdaV283WldjNjR1a0xpRHNoTGp0aXJnZzdKV0k3SmVRN0lTY0lPMkRnT3lkdE8yTGdNSzM3SldJNjRLMHdyZnJzb1R0aXJ6c25ZQWc3WldjSU91cXVPeWN2T3VobkNEcnA1N3NsWVRybHFqc2xyVHNvTGpzbGJ3ZzdaV2M2NHVrS095WWlEb2c2N080NjZ5NDdKMjBJQ0orN1pXZzZybU03SnFVUHlMcnFiUWc2N0tFN1lxODdKMkFJRnZzbFlUcmk0anNtS1JkTDF2cmhLUmRLUzVjYmljZ0t3b2dJQ0FnSUNBblcrMk1uZXlYaFNEcnJManNzclFnNnJlYzdMbVpJT0tBbENEc25JUWc3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuT3lkbUNBaU9DNGc3WXlkN0plRklpRHNoTG5zaFpqc25ZUWc2NVN3NjZXNDY0dWtYVnh1SnlBckNpQWdJQ0FnSUNjdElPMkRnT3lkdE8yTGdEb2c3S2VuN0oyQUlPdXFoZXlDck9xMXJDZ3lmalRzbHJUc29JZ3BMQ0Rzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5DRHNsNGJzDQpuYlFvZnV5YWxDOSs2NHVrTDM3cXVZenNtcFEvSU9xNGlPeW5nQ2t1SU91d21PdVRuT3lMbkNEc2xZanJnclFvNjdPNDY2eTRLU0RycDZYcm5iM3NuWVFnN0pxVTdKVzk3WlcwSU8yRGdPeWR0TzJMZ091bmpDRHJ0SkRyajRRZzY2eTA3SXFvSU8yTW5leVhoZXlkdU95bmdDRHNsWXpxc293ZzdaV1k2NTI4TGlEc201RHJzN2pzbmJRZ0l1eVZqT3VtdkMvdG1aWHNuYmdpN0xLWTY1KzhJT3VuaWV5WHNPMlZtT3VwdENEcnM3anJyTGpzbllRZzZyZTg2ckd3NjZHY0lPcTFyT3l5dE8yWmxPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RzbFlqcmdyUW82N080NjZ5NEtUb2c3WlcwN0pxVTdMSzBMaUR0akpEcmk2anNuYlFnN1pXRTdKcVU3WldZNjZtMElDSis3WldnNnJtTTdKcVVQeUxyb1p3ZzY2eTc2ck9nTENEcmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHNuSVR0bDVnbzdJS3Q3S0Njd3JmdGc0anRoN1FnNjVPeEtleWRnQ0Rxc3JEcXM3enJwYndnNjZpODdLQ0FJT3F5dmVxem9PMlZuT3VMcEM0Zw0KNnJLdzZyTzh3cmZzZzRIdGc1d2c3WWExNjdPMDY2bTBJT3lFbk95SW9PMllsZXljdk91aG5DRHNsWXpycHJEcmk2UXVYRzRuSUNzS0lDQWdJQ0FnSnkwZzY3S0U3WXE4T2lEcnM3anJyTGpzbmJRZ0luN3RsYURxdVl6c21wUS9JdXVwdENCYjdKV0U2NHVJN0ppa1hTOWI2NFNrWFN3ZzY3TzQ2Nnk0N0oyMElPeURnZTJacWV5ZGhDRHNoSnpzaUtEdGxaanFzNkFnN0oyMElPdXloTzJLdk95ZHRDRHNpNlRzb0p3ZzY0K1o3SjZSN0oyMDY2bTBJT3VQbWV5ZWtTRHJqNW5zZ3F3bzdJS3Q3S0NjTCt5Z2dPeWVwUy9zbDdEcXNyQWc3WlcwN0tDY0lPdVRzU2tzSU8yR3RldXp0Q0R0akozc2w0WHNuWmdnNjR1bzdKMjhJT3V5aE8yS3ZPeWR0T3VwdENBaTdabVY3SjI0SWk0Z0l1eTNxT3lHakNMcmlwUWc2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNTENBaTY0dXI2cml3d3Jmcmo1bnNucEVpSU95aHNPMlZxU0RxdUlqc3A0QXVJTzJabE91cHRDRHF1TERyaXFYcnFvVW82N09BNnJLOXdyZnQNCmxiVHNvSndnNjVPeEtleWRnQ0RxdDdqcmpJRHJvWndnNjVHVTY0dWtMbHh1SnlBckNpQWdJQ0FnSUNjdElPeWJrT3VzdU95ZG1DRHNvSlhyczdUQ3QreWhzT3F4dENqc2lLdnNucERDdCt5ZHRPeURnUy9zbmJUdGxaakN0K3VNZ095RGdTbnNuWUFnN0p5ZzdLZUE3WldZNnJPZ0xDRHNtNURyckxqc2w1QWc3SmVHNjRxVUlPeWdsZXV6dE1LMzdLQ0k3TENvd3Jmc2w3RHJuYjNzc3BqcnBid2c3S2VBN0phMDY0SzA3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhjSzM3TDJVNjVPYzdZNmM3SXFrSU9xNGlPeW5nRHBjYmljZ0t3b2dJQ0FnSUNBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXlkdENEc2hManRpcmpzblpnZzY3Q3A3WmFsN0oyRUlPMlZuT3ExcmV5V3RDRHRsWndnNjZ5NDdKNmw3Snk4NjZHY0lpd2dJbVZzDQpaVzFsYm5Seklqb2dXM3NpY205c1pTSTZJQ0xzbDYzdGxhQWlMQ0FpZEdWNGRDSTZJQ0xyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJbjBzSUM0dUxsMTlMQ0F1TGk1ZGZWeHVKeUFyQ2lBZ0lDQWdJQ2ZzbDYzdGxhRHNuWUFnN0o2RjY2Q2xJT3lJbk95RW5PdU1nT3VobkRvZ0p5QXJJSEp2YkdWeklDc2dKMXh1WEc0bklDc0tJQ0FnSUNBZ0oxdnRqSjNzbDRVZzdKcVU3SWFNWFZ4dUp5QXJJR3hwYzNRS0lDQWdJQ2s3Q2lBZ2ZTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93cDlDZ292THlEdGpKM3NsNFVnN0oyUjY0dTE3SmVRN0lTY0lIdHpaWFJ6T2lCYmUzSmxZWE52Yml3Z1pXeGxiV1Z1ZEhNNlczdHliMnhsTEhSbGVIUjlYWDFkZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxVRzl3ZFhBb2NtRjNLU0I3Q2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndg0KWG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXg3VzF4elhGTmRLbHg5THlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnZJRDBnU2xOUFRpNXdZWEp6WlNoektUc0tJQ0FnSUdOdmJuTjBJSE5sZEhOSmJpQTlJRUZ5Y21GNUxtbHpRWEp5WVhrb2J5QW1KaUJ2TG5ObGRITXBJRDhnYnk1elpYUnpJRG9nVzEwN0NpQWdJQ0JqYjI1emRDQnpaWFJ6SUQwZ2MyVjBjMGx1Q2lBZ0lDQWdJQzV0WVhBb0tITjBLU0E5UGlBb2V3b2dJQ0FnSUNBZ0lISmxZWE52YmpvZ1UzUnlhVzVuS0NoemRDQW1KaUJ6ZEM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa3NDaUFnSUNBZ0lDQWdaV3hsYldWdWRITTZJRUZ5Y21GNUxtbHpRWEp5WVhrb2MzUWdKaVlnYzNRdVpXeGxiV1Z1ZEhNcENpQWdJQ0FnSUNBZ0lDQS9JSE4wTG1Wc1pXMWxiblJ6Q2lBZ0lDQWcNCklDQWdJQ0FnSUNBZ0xtMWhjQ2dvWld3cElEMCtJQ2g3SUhKdmJHVTZJRk4wY21sdVp5Z29aV3dnSmlZZ1pXd3VjbTlzWlNrZ2ZId2dKeWNwTG5SeWFXMG9LU3dnZEdWNGREb2dVM1J5YVc1bktDaGxiQ0FtSmlCbGJDNTBaWGgwS1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1FvZ0lDQWdJQ0FnSUNBZ0lDQWdJQzVtYVd4MFpYSW9LR1ZzS1NBOVBpQmxiQzUwWlhoMEtRb2dJQ0FnSUNBZ0lDQWdPaUJiWFN3S0lDQWdJQ0FnZlNrcENpQWdJQ0FnSUM1bWFXeDBaWElvS0hOMEtTQTlQaUJ6ZEM1bGJHVnRaVzUwY3k1c1pXNW5kR2dwT3dvZ0lDQWdjbVYwZFhKdUlITmxkSE11YkdWdVozUm9JRDhnYzJWMGN5QTZJRzUxYkd3N0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzS0lDQWdJSEpsZEhWeWJpQnVkV3hzT3dvZ0lIMEtmUW9LTHk4ZzY0eUE3Wm1VN1ppVklPeWduT3lla1NEc25aSHJpN1hzbDVEc2hKd2dlM0psY0d4NUxDQnpkV2RuWlhOMGFXOXVjMXRkZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlDQo2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3BDbVoxYm1OMGFXOXVJSEJoY25ObFEyOXRjRzl6WlNoeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzhnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ1kyOXVjM1FnY21Wd2JIa2dQU0JUZEhKcGJtY29LRzhnSmlZZ2J5NXlaWEJzZVNrZ2ZId2dKeWNwTG5SeWFXMG9LVHNLSUNBZ0lHTnZibk4wSUhOMVoyZGxjM1JwYjI1eklEMGdRWEp5WVhrdWFYTkJjbkpoZVNodklDWW1JRzh1YzNWbloyVnpkR2x2Ym5NcENpQWdJQ0FnSUQ4Z2J5NXpkV2RuWlhOMGFXOXVjd29nSUNBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Zw0KS0hzZ2RHVjRkRG9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VkR1Y0ZENrZ2ZId2dKeWNwTG5SeWFXMG9LU3dnY21WaGMyOXVPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNXlaV0Z6YjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcENpQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaDRLU0E5UGlCNExuUmxlSFFwQ2lBZ0lDQWdJRG9nVzEwN0NpQWdJQ0JwWmlBb2NtVndiSGtnZkh3Z2MzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0tTQnlaWFIxY200Z2V5QnlaWEJzZVN3Z2MzVm5aMlZ6ZEdsdmJuTWdmVHNLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc2xZVHJucGpyb1p3Z0tpOGdmUW9nSUhKbGRIVnliaUJ1ZFd4c093cDlDZ292THlEcnNvanNsNjBnN0oyUjY0dTE3SmVRN0lTY0lIdDBjbUZ1YzJ4aGRHVmtMQ0JrYVhKbFkzUnBiMjU5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlVjbUZ1YzJ4aGRHVW9jbUYzS1NCN0NpQWcNCmJHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdDaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4N1cxeHpYRk5kS2x4OUx5azdDaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0J2SUQwZ1NsTlBUaTV3WVhKelpTaHpLVHNLSUNBZ0lHTnZibk4wSUhSeVlXNXpiR0YwWldRZ1BTQlRkSEpwYm1jb0tHOGdKaVlnYnk1MGNtRnVjMnhoZEdWa0tTQjhmQ0FuSnlrdWRISnBiU2dwT3dvZ0lDQWdhV1lnS0hSeVlXNXpiR0YwWldRcElISmxkSFZ5YmlCN0lIUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZiam9nVTNSeWFXNW5LQ2h2SUNZbUlHOHVaR2x5WldOMGFXOXVLU0I4ZkNBbkp5a3VkSEpwYlNncElIMDdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIMEtJQ0J5WlhSMWNtNGdiblZzDQpiRHNLZlFvS0x5OGc3SjJSNjR1MTdKZVE3SVNjSUh0MFpYaDBMQ0J5WldGemIyNTlJT3V3c095WHRDRHN0cFRzdHB3Z0tPeTlsT3VUbk8yT25PeUtwTUszN0pXZTY1S2tJT3llb2V1THRDRHRsNGpzbXFrcENtWjFibU4wYVc5dUlIQmhjbk5sVTNWbloyVnpkR2x2Ym5Nb2NtRjNLU0I3Q2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdDaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4YlcxeHpYRk5kS2x4ZEx5azdDaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0JoY25JZ1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdhV1lnS0VGeWNtRjVMbWx6UVhKeVlYa29ZWEp5S1NrZ2V3b2dJQ0FnSUNCeVpYUjFjbTRnWVhKeUNpQWdJQ0FnSUNBZ0xtMWhjQ2dvZUNrZ1BUNGdLSHNnZEdWNGREb2dVM1J5YVc1bg0KS0NoNElDWW1JSGd1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lCVGRISnBibWNvS0hnZ0ppWWdlQzV5WldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZTa3BDaUFnSUNBZ0lDQWdMbVpwYkhSbGNpZ29lQ2tnUFQ0Z2VDNTBaWGgwS1RzS0lDQWdJSDBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc2xZVHJucGpyb1p3Z0tpOGdmUW9nSUhKbGRIVnliaUJiWFRzS2ZRb0tMeThnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsTUszN1pXYzY0K0VJT3kwaU9xenZDRHNnNEh0ZzV6c25id2c2NVdNSUM5b1pXRnNkR2dnN0tHdzdacU02ckNBSU95WXBPdXB0Q0Rya3FUc2w1RHNoSndnN0p1TTY3Q043SmVGN0oyRUlPdUxwT3lMbkNEc2k1enJqNFR0bGJUcnM3anJpNlFnS0RNdzdMU0k3SmVRSURIcnNvanJwNHdwTGdvdkx5RHNoTEhxczdYdGxaanJxYlFnNnJLdzZyTzhJTzJWdU91VHBPdWZyT3F3Z0NCamJHRjFaR1ZUZEdGMGRYTTlKMjlySit1aG5DRHJrSmpyajR6cnBxenJyNERyb1p3c0lPeWUNCnJPdWhuT3EzdU95ZHVDRHRtNFFnNjdLRTdZcTg3SjIwSU95Z2dPeWdpT3VobkNEd241K2k3Snk4NjZHY0lPdXp0ZXEzZ08yVm5PdUxwQzRLTHk4Z0tPMlVqT3Vmck9xM3VPeWR1T3lkdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHNDRHJrcVFnN0tPODZyaXc3S0NCN0p5ODY2R2NJQzlvWldGc2RHanJwYndnN0tHdzdacU03WldZNjRxVUlPcXlnK3F6dkNEc3A1M3NuWVFnN0oyMDY2T3M2NHVrS1Fvdkx5RHRsWnpyajRRZzdMU0k2ck84NjQrRUlPcXdtZXlkZ0NEcXNyM3JvWnpyb1p3ZzY3TzE2cmVBN0l1YzdZS282NHVrSU9LQWxDRHF0SURycHF6c25wRHFzSUFnN1pXYzY0K0U2Nlc4SU95WXJPdWdwT3lqdk9xeHNPdUNtQ0R0bFp6cmo0VHFzSUFnN0xTSTZyaXc3Wm1VNjVDWTY2bTBDaTh2SU95Q3JPeWFxZXlla09xd2dDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPdUlqT3Vmck91UGhDRHJzb1R0aXJ6c25iUWc4Sitmb3V5Y3ZPdWhuQ0RyajR6c2xZVHNtS2pyaTZRdUlPMlZuT3VQaE95WGtDRHFzYmpyDQpwckFnN1ppNDdMYWM3SjJBSU9xeHNPeWdpT3VRbU91dmdPdWhuQ0RzZ3F6c21xbnJuNG5zbllBZzdKV0lJT3VDbU9xd2hPdUxwQW92THlEcXM0VHNvSlhzbmJRZ0tpcnJzSmJzbDVEc2hKd3FLaURyc0pUcmdKQWc2cktEN0oyRUlPeVZqT3lWaE95eGlPdUxwQ0FvTWpBeU5pMHdPQ3dnUWxKSlJFZEZYMVk5TWpZcExnb3ZMeUR0aExEcnI3anJoSkRzbmJUcmdwZ2c2N2lNNjUyODdKcXc3S0NBN0plUTdJU2NJT3VMcE91bHVDRHFzNFRzb0pYc25MenJvWndnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3lla09xeXFleW1uZXVxaFNEdGpJenNuYnpzbllBZzY3Q1U2NENNN0tlQTY2ZU1MQ0RzbmJUcnI3Z2c2NWFnSU95ZWlPdUtsQ0JqYkdGMVpHVUtMeThnN0lTNDdJV1k3SjJBSU95TG5PdVBtZTJWb0NEcmxZd2c2N0NiN0oyQUlPeVlteURxczRUc29KVWc3SjZGN0o2bDZyYU03SjJFSU9xM3VPdU1nT3VobkNEc2s3VHJpNlFnNG9hU0lPeURpQ0RxczRUc29KWHNsNUFnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaENEcw0Kbm9qc2xyVHJqNFFnSXUyVm5PdVBoQ0RzdElqcXM3d2k2ckNBQ2k4dklPcXpoT3lHalNEcmdwanNtS2pyaTZRb01qQXlOaTB3T0NEc2k2VHN1S0VnN0l1ZzZyT2dPaUFpN0lPSUlPcXpoT3lnbGV5Y3ZPdWhuQ0Ryb1p6cXQ3anNuYmp0bG9qcmlwVHJqYkFnN0ptY0lPcTN1Q0RxczRUc29KVWc3SUtzN0pxcDY1K0o3SjJFSU91cXV5RHNrN0RyZzVBaUtTNEtMeThnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3F4c095NW5DRHJvWnpxdDdqc25iakN0K3Vobk9xM3VPeVZoT3liZ3lndmIzQmxiaTFzYjJkcGJzSzNMMk5zWVhWa1pTMXNiMmR2ZFhRcDdKMkFJR3RwYkd4UWNtOWo3Snk4NjZHY0lPeUV1T3lGbU95ZGhDRHJzb1Ryb0tUc2hKd2c3SjIwSU91c3VPeWduT3F3Z0Fvdkx5RHNsNGJzbDRqcmlwVHJqYkFzSU91d2x1eVhrT3lFbkNEcnNKVHF2cmpycWJRZzY0dWs2NmFzNnJDQUlPeVZqQ0Ryc0tucnNwWHNuYlFnN0plRzdKZUk2NHVrTGlEcXQ3anJucGpzaEp3Z0wyaGxZV3gwYUNEc29iRHRtb3pycDRqcmk2UWcNCjdZeU03SjI4N0oyWUlPcXpoT3lnbGVxenZDRHJ1WVRxdFpEdGxaenJpNlF1Q2k4dklPdTVoT3lhcVNBd0tPMk1qT3lkdk91bmpDRHNuYjNxczZBc0lHTnNZWFZrWlVGalkyOTFiblRzblpnZ016RHN0SWdnN0xxUTdJdWM2Nlc4SU9xM3VPdU1nT3VobkNEc2s3VHJpNlFnNG9DVUlDNWpiR0YxWkdVdWFuTnZidXlkdENEc3U2VHNoSndnNjZlazY3S0lJT3lkdmV5bmdDRHNsWXJyaXBUcmk2UXBMZ292THlEcXM0VHNvSlVnN0o2STdKMk1JT0tHa2lEc2w0YnNuWXdvNjZHYzZyZTQ3SldFN0p1REtTRHJzS250bHFYc25ZQWc2ckcwNjVPYzY2YXM3S2VBSU95Vml1dUtsT3VMcERvZzdZeU03SjI4N0oyRUlPdU5ydXlXdE95VHNPdUtsQ0RzaUp6cXNJUWc3SjZnNnJtUUlPdXF1eURzbmIzcmlwUWc2cktENnJPOENpOHZJT3Exck91MmhPdVFtT3luZ0NEc2xZcnNsWVFnN1plYklPeWVyT3lMbk95ZWtleWRoQ0RydG9EcnBiVHFzNkFzSU9xM3VDRHJzS250bHFYc25ZQWc3SjI0N0thZElPeVlwT3VsbUNEcXNyM3JvWndvDQphWE5CZFhSb1JYSnliM0lwNnJDQUlPeWR0T3V2dUNEc3NwanJwcXp0bFp6cmk2UXVDbVoxYm1OMGFXOXVJSEpsYzNSaGNuUkpaa0ZqWTI5MWJuUkRhR0Z1WjJWa0tDa2dld29nSUdsbUlDZ2hjSEp2WXlCOGZDQjNZV2wwWlhJcElISmxkSFZ5YmpzZ0lDQWdJQ0FnSUNBdkx5RHNoTGpzaFpnZzdKZUc3SjJNS091THBPeWRqQ0R0aExUc25iUWc3SU9JNjZHY0lPeUxuT3VQbVNrZ0x5RHRoTFFnN0tlRTdaYUpJT3lra2V5ZHRPdXB0Q0RyaTZUc25Zd2c3S0d3N1pxTTdKZVE3SVNjQ2lBZ1kyOXVjM1FnYm05M0lEMGdZMnhoZFdSbFFXTmpiM1Z1ZENncE93b2dJR2xtSUNnaGJtOTNJSHg4SUc1dmR5QTlQVDBnYzJWemMybHZia0ZqWTI5MWJuUXBJSEpsZEhWeWJqc0tJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzZyT0U3S0NWN0oyMElPdXdsT3VBak95WGlPeVd0T3lhbENBb0p5QXJJQ2h6WlhOemFXOXVRV05qYjNWdWRDQjhmQ0FuN0plRzdKMk1KeWtnS3lBbklPS0draUFuSUNzZ2JtOTNJQ3NnSnlrZw0KNG9DVUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3V5aE91bXJPcXpvQ0RzZzRnZzZyT0U3S0NWN0p5ODY2R2NJT3VMcE95TG5DRHNpNXpzbnBIdGxhbnJpNGpyaTZRdUp5azdDaUFnTHk4ZzdKMlk2NCtFN0tDQklPeWloZXVqakNoeVpXRnpiMjRnN0tlQTdLQ1ZLU0RpZ0pRZ1UwVlRVMGxQVGw5RVNVVkU2NkdjSU91Qm5ldUN0T3VwdENEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1zT3VMcEFvZ0lHdHBiR3hRY205aktDZnFzNFRzb0pYc25iUWc2N0NVNjRDTTdKYTA3SVNjSU95RXVPeUZtT3lkaENEc2c0anJvWndnN0l1YzdKNlI3WmFJN0phMDdKcVVJT0tBbENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0bktUc0tJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQnVkV3hzT3lBdkx5RHRsWnpyajRUQ3QrdWhuT3EzdU95ZHVDRHNnNEh0ZzV6cmlwUWc2ck9FN0tDVjY2ZUk2NHVrSU91THBPdWx0T3VMcENEaWdKUWcNCjdJT0lJT3F6aE95Z2xleWN2T3VobkNEcmk2VHNpNXdnN1l5UTdLQ1Y3WldZNnJLTUNpQWdjMlZ6YzJsdmJrRmpZMjkxYm5RZ1BTQnViM2M3Q24wS0NteGxkQ0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQU0F3T3dwbWRXNWpkR2x2YmlCeVpYUnllVUYxZEdoSlprNWxaV1JsWkNncElIc0tJQ0JwWmlBb1kyeGhkV1JsVTNSaGRIVnpJQ0U5UFNBblkyeGhkV1JsTFd4dloyOTFkQ2NnSmlZZ1kyeGhkV1JsVTNSaGRIVnpJQ0U5UFNBblkyeGhkV1JsTFd4cGJXbDBKeWtnY21WMGRYSnVPd29nSUdsbUlDaDNZV2wwWlhJZ2ZId2dSR0YwWlM1dWIzY29LU0F0SUd4aGMzUkJkWFJvVW1WMGNubEJkQ0E4SURNd01EQXdLU0J5WlhSMWNtNDdJQzh2SU95bmhPMldpU0RzcEpFZzdZUzBJT3V3cWUyVnRDRHF1SWpzcDRBZ0t5QXpNT3kwaUNEcXNJVHFzcWtLSUNCc1lYTjBRWFYwYUZKbGRISjVRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdKNnM3Wm1WDQo3SjI0SU95TG5PdVBoT0tBcGljcE93b2dJSEoxYmxSMWNtNG9LQ2tnUFQ0Z0ordWhuT3EzdU95ZHVDRHRtWlhzbmJqc21xbnNuYlRyaTZRdUlDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljcExuUm9aVzRvQ2lBZ0lDQW9LU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJTzJabGV5ZHVPdVFxQ0RpZ0pRZzdLQ1Y3SU9CSU95RGdlMkRuT3VobkNEcnM3WHF0NEF1Snlrc0NpQWdJQ0FvWlNrZ1BUNGdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95VmhPeW5nU0Ryb1p6cXQ3anNuYmdnN0pXSUlPdVFxRG9uTENCVGRISnBibWNvWlM1dFpYTnpZV2RsS1M1emJHbGpaU2d3TENBNE1Da3BDaUFnS1RzS2ZRb0tMeThnN0l1azdZeW9JT3lka2V1THRleWRoQ0RzZ3F6cm5venNtcWtnN0pXSTY0SzA2NkdjSU91emdPMlptQ0RpZ0pRZzdKdVE3SjI0S091aG5PcTN1T3lkdUMvc2hLVHN1WmdwN0oyMElPMk1qT3lWaGV1UW5DRHFzcjNzbXJEc2w1UWc2cmU0SU95Vg0KaU91Q3RPdWx2Q3dnN0pXRTY0dUk2Nm0wSU95Z2tldVJrT3lXdEN2c201RHJyTGpzbllRZzY3TzA2NEs0NjR1a0NtWjFibU4wYVc5dUlHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z2NISmxabWw0S1NCN0NpQWdhV1lnS0dVZ0ppWWdaUzV0WlhOellXZGxJRDA5UFNCTVQwZEpUbDlIVlVsRVJTa2djbVYwZFhKdUlIc2daWEp5YjNJNklFeFBSMGxPWDBkVlNVUkZMQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMV3h2WjI5MWRDY2dmVHNLSUNCcFppQW9aU0FtSmlCbExtMWxjM05oWjJVZ1BUMDlJRXhKVFVsVVgwZFZTVVJGS1NCeVpYUjFjbTRnZXlCbGNuSnZjam9nVEVsTlNWUmZSMVZKUkVVc0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJHbHRhWFFuSUgwN0NpQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjJOc1lYVmtaUzF0YVhOemFXNW5KeWtnZXdvZ0lDQWdjbVYwZFhKdUlIc2daWEp5YjNJNklDZnNuYlFnVUVQc2w1QWdRMnhoZFdSbElFTnZaR1VvWTJ4aGRXUmxLZXF3Z0NEc2hLVHN1Wmpyajd3ZzdKNkkNCjdLZUFJT3lWaXV5VmhPeWFsQ0RpZ0pRZzdJU2s3TG1ZN1pXWTZyT2dJT3Vobk9xM3VPeWR1TzJWbkNEcmtxUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeXdnY0hKdllteGxiVG9nSjJOc1lYVmtaUzF0YVhOemFXNW5KeUI5T3dvZ0lIMEtJQ0J5WlhSMWNtNGdleUJsY25KdmNqb2djSEpsWm1sNElDc2dLR1VnSmlZZ1pTNXRaWE56WVdkbElEOGdaUzV0WlhOellXZGxJRG9nVTNSeWFXNW5LR1VwS1NCOU93cDlDZ3BtZFc1amRHbHZiaUJ5WldGa1FtOWtlU2h5WlhFcElIc0tJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVVwSUQwK0lIc0tJQ0FnSUd4bGRDQmliMlI1SUQwZ0p5YzdDaUFnSUNCeVpYRXViMjRvSjJSaGRHRW5MQ0FvWXlrZ1BUNGdleUJpYjJSNUlDczlJR003SUgwcE93b2dJQ0FnY21WeExtOXVLQ2RsYm1RbkxDQW9LU0E5UGlCN0NpQWdJQ0FnSUhSeWVTQjdJSEpsYzI5c2RtVW9TbE5QVGk1d1lYSnpaU2hpYjJSNUtTazdJSDBnWTJGMFkyZ2dLRjlsDQpLU0I3SUhKbGMyOXNkbVVvZTMwcE95QjlDaUFnSUNCOUtUc0tJQ0I5S1RzS2ZRb0tZMjl1YzNRZ1EwOVNVMTlJUlVGRVJWSlRJRDBnZXdvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFQY21sbmFXNG5PaUFuS2ljc0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFUxbGRHaHZaSE1uT2lBblIwVlVMQ0JRVDFOVUxDQlBVRlJKVDA1VEp5d0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFNHVmhaR1Z5Y3ljNklDZERiMjUwWlc1MExWUjVjR1VuTEFwOU93cG1kVzVqZEdsdmJpQnFjMjl1S0hKbGN5d2djM1JoZEhWekxDQnZZbW9wSUhzS0lDQnlaWE11ZDNKcGRHVklaV0ZrS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MFpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2dZMmhoY25ObGREMTFkR1l0T0NjZ2ZTd2dRMDlTVTE5SVJVRkVSVkpUS1NrN0NpQWdjbVZ6TG1WdVpDaEtVMDlPTG5OMGNtbHVaMmxtZVNodlltb3BLVHNLZlFvSw0KWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9ZWE41Ym1NZ0tISmxjU3dnY21WektTQTlQaUI3Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFBVRlJKVDA1VEp5a2dleUJ5WlhNdWQzSnBkR1ZJWldGa0tESXdOQ3dnUTA5U1UxOUlSVUZFUlZKVEtUc2djbVYwZFhKdUlISmxjeTVsYm1Rb0tUc2dmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblIwVlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMmhsWVd4MGFDY3BJSHNLSUNBZ0lISmxjM1JoY25SSlprRmpZMjkxYm5SRGFHRnVaMlZrS0NrN0lDOHZJT3V3bHV5WGtPeUVuQ0RxczRUc29KWHNuWVFnNjdDVTZyK283Snk4NjZtMElPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3Vvdk95Z2dDRHJzb1RycHJEcmk2UWdLT3lWaE91ZW1DRHNtNHpyc0kzc2w0WHNuYlFnN0ppYklPcXpoT3lnbGV5Y3ZPdWhuQ0RyajR6c3A0QWc3SldLNnJLTUtRb2dJQ0FnY21WMGNubEJkWFJvU1daT1pXVmtaV1FvS1RzZ0x5OGcNCjY2R2M2cmU0N0oyNElPMlZoT3lhbENEc2c0SHRnNXpycWJRZzdKNnM3Wm1WN0oyNElPeUxuT3VQaENEaWdKUWc3SjZzNjZHYzZyZTQ3SjI0N0oyMElPdUJuZXVDck95Y3ZPdXB0Q0RyaTZUc25Zd2c3S0d3N1pxTTY3YUE3WVN3SUhCeWIySnNaVzNzbmJRZzdaS0E2NmF3NjR1a0NpQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V3b2dJQ0FnSUNCdmF6b2dkSEoxWlN3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnl3Z2Rqb2dRbEpKUkVkRlgxWXNJR1JwY2pvZ1gxOWthWEp1WVcxbExDQXZMeUIyd3Jka2FYSTZJT3Exck91eWhPeWdoQy9zbDRucm1ySHRsWndnN0lLczY3TzQ3SjIwSU91V29DRHNub2pyaXBUc3A0QWc3S2VFNjR1bzdKcXBDaUFnSUNBZ0lHMXZaR1ZzT2lCamRYSnlaVzUwVFc5a1pXd3NJRzF2WkdWc2N6b2dRVXhNVDFkRlJGOU5UMFJGVEZNc0lHVjRZVzF3YkdWek9pQkZXRUZOVUV4RlV5NXNaVzVuZEdnc0lHZDFhV1JsT2lCSFZVbEVSUzVzWlc1bmRHZ3NJSEpsWVdSNU9pQjNZWEp0DQpaV1JWY0N3S0lDQWdJQ0FnY0hKdllteGxiVG9nS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjI5ckp5QjhmQ0JqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJRzUxYkd3cElEOGdiblZzYkNBNklHTnNZWFZrWlZOMFlYUjFjeXdLSUNBZ0lDQWdZV05qYjNWdWREb2dZMnhoZFdSbFFXTmpiM1Z1ZENncExBb2dJQ0FnSUNCelpYSjJaV1E2SUhOMFlYUnpMbk5sY25abFpDd2diR0Z6ZEVGME9pQnpkR0YwY3k1c1lYTjBRWFFzSUd4aGMzUlVaWGgwT2lCemRHRjBjeTVzWVhOMFZHVjRkQ3dnYkdGemRGTmxZem9nYzNSaGRITXViR0Z6ZEZObFl5d0tJQ0FnSUgwcE93b2dJSDBLSUNBdkx5RHRsSXpybjZ6cXQ3anNuYmdnN0l1czdKNmw2N0NWNjQrWklPS0FsQ0RyZ1lycXVMRHJxYlFnN0p5RUlPcXdrT3lMbkNEdGc0RHNuYlRycUxqcXNJQWc2NHVrNjZhczY2VzhJT3VCaU91THBBb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OW9aV0Z5ZEdKbFlYUW5LU0I3Q2lBZw0KSUNCc1lYTjBRbVZoZENBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU0I5S1RzS0lDQjlDaUFnTHk4ZzY2R2M2cmU0N0oyNElPS0FsQ0R0bEl6cm42enF0N2pzbmJqc25aZ2dXL0NmbjZBZzdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVDRHRsWVRzbXBSZHdyZGI4SitVa1YwZzY3S0U3WXE4N0oyMElPMll1T3kybk8yVm5PdUxwQzRLSUNBdkx5RHF1TERyczdnbzY3aU02NTI4N0pxdzdLQ0FJT3luZ2UyV2lTazZJR0JqYkdGMVpHVWdZWFYwYUNCc2IyZHBiaUF0TFdOc1lYVmtaV0ZwWU91bHZDRHNpS2pzbllBZzdaU0U2NkdjN0lTNDdJcWs2NkdjSU95THBPMldpU0RpZ0pRZzY2bVU2NG0wSU95WGh1eWR0Q0RxczZmc25xVWc2N2lNNjUyODdKcXc3S0NBNjZXOElPeVh0T3F6b0N3S0lDQXZMeUFnSUd4dlkyRnNhRzl6ZENEc2lKanNpNkFnN1krczdZcTQ2NkdjSU9xeXNPcXp2T3VsdkNEc25wRHJqNWtnN0lpWTY2QzU3WldjNjR1a0tPeUwNCnBPeTRvVG9nN1plazY1T2M2NmFzN0lxazdKZVE3SVNjNjQrRUlPdTRqT3Vkdk95YXNPeWdnQ0RzbDdUcnByd2dLeUJNU1ZOVVJVNGc3Wm1WN0oyNExDQXlNREkyTFRBM0tTNEtJQ0F2THlBZ0lPMkVzT3V2dU91RWtPeWR0Q0R0bVpUcnFiVHNsNUFnN0tDRTdaaUFJT3lWaUNEcm5LenJpNlF1SU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianJwNHdnN1pXWTY2bTBJT3VCblM0S0lDQXZMeUR0ajdUcnNMRW83WVN3NjYrNDY0U1FLVG9nN0o2UTY0K1pJT3laaE91ampPcXdnQ0RycDRudG5vd2c3Wm1ZNnJLOUtPdTRqT3Vkdk95YXNPeWdnT3F3Z0NCc2IyTmhiR2h2YzNUc2w1QWc2NnE3SU91THYreVZoQ0RzdlpUcms1enFzSUFnNjdPMDdKMjA2NHFVSU9xeXZleWFzQ25zbDVEc2hKd0tJQ0F2THlBZ0lPdWhuT3EzdU95ZHVDRHJqSURxdUxBZzdLU1JJT3V5aE8yS3ZPeWRoQ0RybUpBZzY0aUU2NlcwNjZtMExDRHN2WlRyazV6cnBid2c2N2FaN0plczY0U2o3SjJFSU95SW1DRHNub2pyaXBRZzdZU3c2Nis0DQo2NFNRSU91d3FleUxuZXljdk91aG5DRHNvSVR0bVpqdGxaenJpNlF1Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDI5d1pXNHRiRzluYVc0bktTQjdDaUFnSUNCamIyNXpkQ0JpYjJSNUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHTnZibk4wSUhOM2FYUmphRTF2WkdVZ1BTQWhJU2hpYjJSNUlDWW1JR0p2WkhrdWMzZHBkR05vUVdOamIzVnVkQ2s3SUM4dklPcXpoT3lnbFNEc29JVHRtWmdnUFNEc2k1enRnYXpycHI4ZzdMQzk3Snk4NjZHY0lPeVh0T3lXdENEcXM0VHNvSlhzbllRZzZyT2c2Nlc4SU95SW1DRHNub2pxc293S0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUM4dklHTnNZWFZrWmVxd2dDRHNsNGJzbkx6cnFiUWc3SmVzNnJpdzdJU2NJT3VCaXV1S2xPdUxwQzRnYzJobGJHdzZkSEoxWmV1ZHZDQmpiR0YxWkdYcXNJQWc3SmVHN0phMDY0K0VJT3lGdU95ZGdDRHNvSlhzZzRFZzdJdWs3WmFKNjQrOENpQWdJQ0FnSUM4dg0KSUhOd1lYZHU3SjJZSUNkbGNuSnZjaWZxc0lBZzdKV0lJT3VjcU9xem9Dd2c3SmlJN0tDRTdKZVVJT3EzdU91TWdPdWhuQ0J2YXpwMGNuVmw2Nlc4SU91UGpPdWdwT3lrck91THBDRGlnSlFLSUNBZ0lDQWdMeThnN1pTTTY1K3M2cmU0N0oyNDdKMkFJQ0xydUl6cm5ienNtckRzb0lEcnBid2c3SmUwN0plSTdKYTA3SnFVSXV1ZHZPcXpvQ0R0bFpqcmlwVHJqYkFnN0l1azdLQ2M2NkdjNjRxVUlPeVZoT3VzdE9xeWcrdVBoQ0RzbFlnZzY1eW82NHFVSU95RGdlMkRuT3F3Z0NEcmtKRHJpNlFvN0l1azdLQ2NJT3lMb09xem9Da3VDaUFnSUNBZ0lHbG1JQ2hqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y3BJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TVN3Z2V3b2dJQ0FnSUNBZ0lDQWdaWEp5YjNJNklDZnNuYlFnVUVQc2w1QWdRMnhoZFdSbElFTnZaR1hxc0lBZzdKZUc3SmEwN0pxVUlPS0FsQ0R0aExEcnI3anJoSkRzbDVEc2hKd2dZMnhoZFdSbElDMHQNCmRtVnljMmx2YmlEc25iUWc2NUNZNjRxVTdLZUFJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2hManNtcFF1Snl3S0lDQWdJQ0FnSUNBZ0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1Wnljc0NpQWdJQ0FnSUNBZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ0x5OGc3S2VFN1phSklPeWtrZXlkdU91TnNDRHJtSkFnNjRpTTY2Q0E2NHVrSU9LQWxDRHNtNURzdVpuc25ZQWdJdXU0ak91ZHZPeWFzT3lnZ091aG5DRHJpNlRzaTV3ZzdKZTA2cml3SXV1THBDNGc3WVN3NjYrNDY0U1E3SjJBSUNvcTdMQzk3SjJFSU95VmhPdXN0T3F5Zyt1UGhDRHJxcnNnNjUyRTdKdWc3SjJFSU91VmpPdW5qQ29xTGdvZ0lDQWdJQ0F2THlEc21JanNvSVRzbDVRZ0p6WXc3TFNJSU91RW1PcXlqQ0RyaklEcXVMQWc3S1NSN0oyMDY2bTBJTzJFc091dnVPdUVrQ2ZzbmJUc2w0anJpcFRyamJBc0lPdWhuT3EzdU95ZHVDRHRtWlRycWJUc25ZUWc3SjI5NnJHdzY0S1lJT3llb09xNWtDRHJsTFFnN0oyOElPMlZtT3VMcENEcmk2VHNpNXdnDQo2NGlFNjZXNENpQWdJQ0FnSUM4dklPeWdsZXlEZ2V5Z2dleWR1Q0Rxc3Izc21yRHNsNURyajRRZ1kyMWtJT3l3dmV5ZHRDRHRpb0RzbHJUcmdwanNtWlRyaTZRb01qQXlOaTB3T0NEc2k2VHN1S0VnN0l1ZzZyT2dPaUFpN1lTdzY2KzQ2NFNRSU8yWmxPdXB0T3lkZ0NEc21ad2c2NWFnSU9xd2tleWVrT3E0c0NJcExnb2dJQ0FnSUNBdkx5RHNuYlRzb0p3ZzdKcXc2NmFzNnJDQUlPeXd2ZXlkaENEc3A0SHNvSkVnN0plMDZyT2dJT3lFc2VxenRTRHNsNnpydG9Bb2JHOW5hVzVYYVc1a2IzZFBjR1Z1WldRcDY2VzhJT3lWaE91TGlPcTVqQ3dnN0l1YzZyQ0U3SjIwSU95VmhPdUxpT3VkdkNEcXQ3Z2c3SUtzN0l1azY2R2NJTzJNa091THFPMlZuT3VMcEM0S0lDQWdJQ0FnWTI5dWMzUWdjM1JoYkdVZ1BTQnNiMmRwYmxCeWIyTWdKaVlnSVd4dloybHVWMmx1Wkc5M1QzQmxibVZrSUNZbUlDaEVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQaUF5TURBd01DazdDaUFnSUNBZ0lHbG1JQ2hzYjJkcA0KYmxCeWIyTWdKaVlnYzNSaGJHVXBJSHNLSUNBZ0lDQWdJQ0JyYVd4c1RHOW5hVzVRY205aktDazdDaUFnSUNBZ0lDQWdhV1lnS0NGdmNHVnVURzluYVc1VVpYSnRhVzVoYkNncEtTQjdDaUFnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TVN3Z2V5Qmxjbkp2Y2pvZ0oreWR0Q0JQVSt5WGtPeUVvQ0RzbnBEcmo1bnNuTHpyb1p3ZzY2cTdJT3lYdE95V3RPeWFsQ0RpZ0pRZzdZU3c2Nis0NjRTUTdKZVE3SVNjSUdOc1lYVmtaU0RzaTZUdGxva2c3WnVFSUM5c2IyZHBiaUR0bGJRZzdLTzg3SVM0N0pxVUxpY2dmU2s3Q2lBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0FnSUM4dklPeWRtT3VQaE95Z2dTRHNvb1hybzR3b2NtVmhjMjl1SU95bmdPeWdsU2tnNG9DVUlPeW5oTzJXaVNEc3BKRWc3WVMwN0oyRUlGTkZVMU5KVDA1ZlJFbEZST3VobkNEcmdaM3JnclRycWJRZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE9xd2dDRHNtSnNnNnJPRTdLQ1ZJT3lFdU95Rm1PeWRoQ0Rya0pqc2dyVHJwckRyaTZRS0lDQWcNCklDQWdJQ0JyYVd4c1VISnZZeWduNjZHYzZyZTQ3SjI0N0oyRUlPeW5oTzJXaWUyVm1PdUtsQ0RzcEpIc25iVHJuYndnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQ0RpZ0pRZzY2R2M2cmU0N0oyNElPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRuS1RzS0lDQWdJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd093b2dJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryb1p6cXQ3anNuYmdnN1krMDY3Q3hJT0tBbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJT3lnaE8yWm1DNG5LVHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2diVzlrWlRvZ0ozUmxjbTFwYm1Gc0p5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lDOHZJT3lWbnV5RW9DRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0N0oyMElPdU1nT3E0c0NEc3BKSHNuYlRyDQpxYlFnN0tDUjZyT2dJT3lEaU91aG5DRHNsN0RyaTZRZ0tPeXd2ZXlkaENEcmk2dnNsWmpxc2JEcmdwZ2c2NHVrN0l1Y0lPdUloT3VsdUNEcXNyM3NtckFwQ2lBZ0lDQWdJR3h2WjJsdVUzUmhjblJsWkVGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lDQWdiRzluYVc1WGFXNWtiM2RQY0dWdVpXUWdQU0JtWVd4elpUc2dMeThnN0oyMDY3S0lJT3lMbk91UGhPeWRtQ0Rzc0wwZzdKZTA2cml3SU95RXNlcXp0U0RzbDZ6cnRvQWc0b0NVSU95VmhPdWVtT3lYa095RW5DRHNoTGpzbXJUcmk2UUtJQ0FnSUNBZ0x5OGdRbEpQVjFORlV1dUtsQ0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a0lPS0FsQ0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHFzNkFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHNucERyajVrZzdJaVk2NkM1N1pXYzY0dWtDaUFnSUNBZ0lDOHZJQ2pzbklRZ0ordWhuT3EzdU95ZHVPeWRnQ0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YQ0Kc095Z2dPdWx2Q0RzcDRIc29KRWc3SmUwNnJLTUlPMlZuT3VMcENjZzdLTzg3SVNkSU9LQWxDRHFzSURyb1p6c3NZVHJxYlFnN0wyVTY1T2NJT3UybWV5WHJPdUVvK3E0c0NEdG1aVHJxYlRzbmJRZzY1eXM2NHVrS1M0S0lDQWdJQ0FnTHk4ZzZyT0U3S0NWSU95Z2hPMlptT3VQaENEcXNKbnNuWUFnNnJLOTY2R2M2NHVrT2lEcnVJenJuYnpzbXJEc29JRHNsNUFnN0lTNDdJV1k3SjIwSU91Q3FPeVZoQ0Rzbm9qc25MenJxYlFnN0lxNTdKMjRJTzJabE91cHRPeWR0Q0RybktqcXM2QXNJT3EzdUNEdG1aVHJxYlFnN1pXWTY0dW9DaUFnSUNBZ0lDOHZJRnZxczRUc29KVWc3S0NFN1ptWVhleWN2T3VobkNEcmk2VHJwYmdnNnJPRTdLQ1Y3SjJFSU9xem9PdWx1T3VMcEM0Z2MzZHBkR05vVFc5a1pldUtsQ0Ryb1p6cXQ3akN0K3lka2V1THRTRHRrWnpzaTV6c21xbnNuTHpyb1p6cnA0d2c2NEtvNjRxVTY0dWtMZ29nSUNBZ0lDQmpiMjV6ZENCMGFHbHpURzluYVc0Z1BTQnpjR0YzYmlnblkyeGhkV1JsSnl3Z1d5ZGgNCmRYUm9KeXdnSjJ4dloybHVKeXdnSnkwdFkyeGhkV1JsWVdrblhTd2dld29nSUNBZ0lDQWdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzQ2lBZ0lDQWdJQ0FnWkdWMFlXTm9aV1E2SUhCeWIyTmxjM011Y0d4aGRHWnZjbTBnSVQwOUlDZDNhVzR6TWljc0lDOHZJR3RwYkd4TWIyZHBibEJ5YjJQc25aZ2c2cmU0NjZPNUlHdHBiR3pzbXFrZ0tHdHBiR3hRY205ajZyTzhJT3VQbWV5ZHZDRHRqS2p0aExRcENpQWdJQ0FnSUgwcE93b2dJQ0FnSUNCc2IyZHBibEJ5YjJNZ1BTQjBhR2x6VEc5bmFXNDdDaUFnSUNBZ0lHeHZaMmx1VjJsdVpHOTNUM0JsYm1Wa0lEMGdkSEoxWlRzZ0x5OGdRMHhKNnJDQUlPeVhyT3VLbENEcXNiUWc2clNBN0xDdzdaV2dJT3lJbUNEc2w0YnNuTHpyaTRnZzdKZTA2NmF3SU9xeWcreWN2T3VobkNEcnM3anJpNlFnS095ZXJPMkJ0T3VtcmV5WGtDRHRoTERycjdqcmhKQWc2N0NwDQo3S2VBS1FvZ0lDQWdJQ0IwYUdselRHOW5hVzR1YjI0b0oyVnljbTl5Snl3Z0tDa2dQVDRnZXlCcFppQW9iRzluYVc1UWNtOWpJRDA5UFNCMGFHbHpURzluYVc0cElHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0lIMHBPd29nSUNBZ0lDQjBhR2x6VEc5bmFXNHViMjRvSjJOc2IzTmxKeXdnS0dOdlpHVXBJRDArSUhzS0lDQWdJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpJQ0U5UFNCMGFHbHpURzluYVc0cElISmxkSFZ5YmpzS0lDQWdJQ0FnSUNCc2IyZHBibEJ5YjJNZ1BTQnVkV3hzT3dvZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTlVhVzFsY2lrZ2V5QmpiR1ZoY2xScGJXVnZkWFFvYkc5bmFXNVFjbTlqVkdsdFpYSXBPeUJzYjJkcGJsQnliMk5VYVcxbGNpQTlJRzUxYkd3N0lIMEtJQ0FnSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPeUF2THlEc2c0Z2c2ck9FN0tDVjdKMjhJT3lJbUNEc25vanNuTHpyaTRnZzY0dWs3SjJNSUM5b1pXRnNkR2dnNjVXTUlPdUxwT3lMbkNEc25iM3F1TEFLSUNBZw0KSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNvSWpzc0tnZzdLS0Y2Nk9NSUNoamIyUmxJQ2NnS3lCamIyUmxJQ3NnSnlrbktUc0tJQ0FnSUNBZ0lDQXZMeURzZ3F6cm5venNuYlFnNjZHYzZyZTQ3SjI0N1pXZ0lPeUxuT3F3aE91UGhDRHNsNGJzbmJRZzZyT242N0NVNjZHY0lPeUxwTzJNcU91aG5DRHJnWjNyZ3F6cmk2UWdQU0JqYkdGMVpHWHFzSUFnN0plRzZyR3c2NEtZSU95THBPMldpZXlkdENEc2xZZ2c2NUNjSU9xeWd5NEtJQ0FnSUNBZ0lDQXZMeURzblpIcmk3WHNuWUFnN0oyMDY2KzRJT3V6dE91RGlPeWN2T3VMaUNEc2c0SHRnNXpycGJ3ZzY0dWs3SXVjSU95ZXJPeUVuQ0F2YUdWaGJIUm82NkdjSU95VmpPdW1zT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSU91TWdPcTRzQ0R0bVpUcnFiVHNuWVFnN0l1azdZeW82NkdjSU91d2xPcSt2T3VMcENrdUNpQWdJQ0FnSUNBZ2FXWWdLR052WkdVZ0lUMDlJREFnSmlZZ1JHRjANClpTNXViM2NvS1NBdElHeHZaMmx1VTNSaGNuUmxaRUYwSUR3Z05UQXdNQ2tnZXdvZ0lDQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1T3lkdENEc3BvbnNpNXdnN0l1azdZeW82NkdjSU91Qm5ldUNxQ0RpZ0pRZ1EyeGhkV1JsSUVOdlpHVWc3SVNrN0xtWUlPeURnZTJEbk91bHZDRHJpNlRzaTV3ZzdLQ1E2cktBN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnSUNBZ0lDQWdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1RzS0lDQWdJQ0FnSUNCOUNpQWdJQ0FnSUgwcE93b2dJQ0FnSUNCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnZXlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJREV3NjdhRUlPcXl2ZXF6dkNEaWdKUWc2NHlBNnJpd0lPMlVoT3Vobk95RXVPeUtwQ0Rzb0pYcnBxd3VKeWs3SUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNnZlN3Z05qQXdNREF3S1RzS0lDQWdJQ0FnTHk4ZzY0S2g3SjJBDQpJT3llaGV5ZXBlcTJqT3lkaENEcnJMenFzNkFnN0o2STY0cVVJT3VNZ09xNHNDRHNoTGpzaFpqc25ZQWc2N0tFNjZhdzY0dWtJT0tBbENEc25xenJvWnpxdDdqc25iZ2c3WnVFSU91THBPeWRqQ0RzbXBUc3NxM3NuYlFnN0lPSUlPeUV1T3lGbUNqc2c0Z2c3SjZGN0o2bDZyYU1LZXljdk91aG5DRHNpNXpzbnBIdGxaanFzb3d1Q2lBZ0lDQWdJQzh2SU95ZG1PdVBoT3lnZ1NEc29vWHJvNHdvY21WaGMyOXVJT3luZ095Z2xTa2c0b0NVSUZORlUxTkpUMDVmUkVsRlJPdWhuQ0RyZ1ozcmdyVHJxYlFnN0o2UTY0K1pJT3llck95TG5PdVBoT3F3Z0NEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcm9LUUtJQ0FnSUNBZ0x5OGc3SjZzNjZHYzZyZTQ3SjI0SU91U3BPeVhrT3VQaENCTlFWaGZWRlZTVGxQcXVZenNwNEFnN0ppYklPcXpoT3lnbGV5Y3ZPdWhuQ0Rzc3BqcnBxenJrSmpyaXBRZzY3S0U2cmU0NnJDQUlPdVFuT3VMcENBb01qQXlOaTB3TnlEcnBxenJ0N0RzbDVEc2hKd2c3Wm1WN0oyNA0KS1FvZ0lDQWdJQ0JyYVd4c1VISnZZeWduNjZHYzZyZTQ3SjI0N0oyRUlPeW5oTzJXaWUyVm1PdUtsQ0RzcEpIc25iVHJuYndnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQ0RpZ0pRZzY2R2M2cmU0N0oyNElPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRuS1RzS0lDQWdJQ0FnWVdOamIzVnVkRU5oWTJobExtRjBJRDBnTURzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN0l1YzdKNlJKeUFySUNoemQybDBZMmhOYjJSbElEOGdKeUFvNnJPRTdLQ1ZJT3lnaE8yWm1DRGlnSlFnN0lxNTdKMjRJTzJabE91cHRPeWR0Q0RybktqcnFiUWc2cmU0SU8yWmxPdXB0Q0R0bFpqcmk2Z2dXK3F6aE95Z2xTRHNvSVR0bVpoZDdKeTg2NkdjSU91THBPdWx1Q0RxczRUc29KWHNuWVFnNnJPZzY2VzhJT3lJbUNEc25vanNsclRzbXBRcEp5QTZJQ2NuS1NBcklDY2c0b0NVSU91aG5PcTN1T3lkdU8yVm1PdXANCnRDRHNucERyajVrZzdKZXc2ckt3NjVDcDY0dUk2NHVrTGljcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnYlc5a1pUb2djM2RwZEdOb1RXOWtaU0EvSUNkaWNtOTNjMlZ5TFhOM2FYUmphQ2NnT2lBblluSnZkM05sY2ljZ2ZTazdDaUFnSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXdMQ0I3SUdWeWNtOXlPaUFuNjZHYzZyZTQ3SjI0SU95d3ZleWRoQ0RycXJzZzdKZTA3SmVJN0phMDdKcVVPaUFuSUNzZ1pTNXRaWE56WVdkbElIMHBPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5QW83WVN3NjYrNDY0U1FJTzJQdE91d3NTRHF0YXp0bUlUcnRvQWc0b0NVSU91NGpPdWR2T3lhc095Z2dDRHNucERyajVrZzdKbUU2Nk9NNnJDQUlPeVZpQ0Rya0pqcmlwUWc3Wm1ZNnJLOUlPeWdoT3lhcVNrS0lDQm1kVzVqZEdsdmJpQnZjR1Z1VEc5bmFXNVVaWEp0YVc1aGJDZ3BJSHNLSUNBZ0lIc0tJQ0FnSUNBZ2FXWWdLSEJ5DQpiMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNLSUNBZ0lDQWdJQ0F2THlCemRHRnlkT3F3Z0NEc2c0Z2c3TDJZN0lhVUlPeXd2ZXlkaENEcnA0enJrNkRyaTZRZ0tPdUxwT3Vtck95ZG1DRHNpS2pzbllBZzdMMlk3SWFVNnJPOElPdXN0T3EwZ08yVm1PcXlqQ0RzZ3F6c21xbnNucERzbDVEcXNvd2c2N08wN0o2RUtTNEtJQ0FnSUNBZ0lDQXZMeURzbmJUc2xyVHNoSndnVUc5M1pYSlRhR1ZzYkNndWNITXhLZXlkdENBMTdMU0lJT3VTcENEcXQ3Z2c3TEM5N0plUUlPeVhsTzJFc091bHZDRHJzN1RyZ3JRZ01ldXlpQ2pxdGF6cmo0VWc2ck9FN0tDVktleWRoQ0RzbnBEcmo1a2c3SVNnN1lPZDdaV1k2ck9nTEFvZ0lDQWdJQ0FnSUM4dklPeXd2ZXlkaENEc3RaenNob3p0bVpUdGxiUWc3SUtzN0pxcDdKNlFJT3VJaU95WGxDRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0NjZlTUlPdUNxT3F5akNEdGxaenJpNlF1SU95d3ZleWRoQ0RycXJzZzdMQys3Snk4NjZtMElPeVZoT3VzdE9xeQ0KZyt1UGhDRHNsWWdnN1pXYzY0dWtDaUFnSUNBZ0lDQWdMeThnS091THBPdWx1Q0Rzc0wwZzdKaWs3SjZGNjZDbElPdXdxZXluZ0NEaWdKUWc2cmU0SU9xeXZleWFzQ0RycVpUcmliVHFzSUFnNjdPMDdKMjA2NHFVSU95eGhPdWhuQ0RyZ3FqcXM2QWc3SUtzN0pxcDdKNlE2ckNBSU95WGxPMkVzQ0R0bFp3ZzY3S0lJT3VJaE91bHRPdXB0Q0Rya0tncExnb2dJQ0FnSUNBZ0lDOHZJT3lqdk95ZG1Eb2dZMnhoZFdSbDZyQ0FJT3k5bU95R2xDRHNvSnpycXFuc25ZUWc2N0NVNnI2NDY2bTBJRUZ3Y0VGamRHbDJZWFJsTDBacGJtUlhhVzVrYjNmcXNJQWc2NnE3SU95d3Z1eWRoQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHNuSWpyajRUc21yQWc3SXVrNnJpdzdKZVE3SVNjSU8yWmxleWR1Q0R0bFlUc21wUXVDaUFnSUNBZ0lDQWdZMjl1YzNRZ2NITXhJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxc2IyZHBiaTV3Y3pFbktUc0tJQ0FnSUNBZ0lDQm1jeTUzY21sMFpVWnANCmJHVlRlVzVqS0hCek1Td2dXd29nSUNBZ0lDQWdJQ0FnSjFOMFlYSjBMVk5zWldWd0lDMVRaV052Ym1SeklEVW5MQW9nSUNBZ0lDQWdJQ0FnSnlSM2N5QTlJRTVsZHkxUFltcGxZM1FnTFVOdmJVOWlhbVZqZENCWFUyTnlhWEIwTGxOb1pXeHNKeXdLSUNBZ0lDQWdJQ0FnSUNKcFppQW9KSGR6TGtGd2NFRmpkR2wyWVhSbEtDZGpiR0YxWkdVdGJHOW5hVzRuS1NrZ2V5SXNDaUFnSUNBZ0lDQWdJQ0FpSUNBa2QzTXVVMlZ1WkV0bGVYTW9KMzRuS1NJc0NpQWdJQ0FnSUNBZ0lDQW5JQ0JUZEdGeWRDMVRiR1ZsY0NBdFUyVmpiMjVrY3lBeUp5d0tJQ0FnSUNBZ0lDQWdJQ0lnSUVGa1pDMVVlWEJsSUMxT1lXMWxjM0JoWTJVZ1ZTQXRUbUZ0WlNCWElDMU5aVzFpWlhKRVpXWnBibWwwYVc5dUlDZGJSR3hzU1cxd2IzSjBLRndpZFhObGNqTXlMbVJzYkZ3aUtWMGdjSFZpYkdsaklITjBZWFJwWXlCbGVIUmxjbTRnVTNsemRHVnRMa2x1ZEZCMGNpQkdhVzVrVjJsdVpHOTNLSE4wY21sdVp5QmpMQ0J6ZEhKcGJtY2dkQ2s3DQpJRnRFYkd4SmJYQnZjblFvWENKMWMyVnlNekl1Wkd4c1hDSXBYU0J3ZFdKc2FXTWdjM1JoZEdsaklHVjRkR1Z5YmlCaWIyOXNJRk5vYjNkWGFXNWtiM2NvVTNsemRHVnRMa2x1ZEZCMGNpQm9MQ0JwYm5RZ2JpazdKeUlzQ2lBZ0lDQWdJQ0FnSUNBaUlDQWthQ0E5SUZ0VkxsZGRPanBHYVc1a1YybHVaRzkzS0Z0T2RXeHNVM1J5YVc1blhUbzZWbUZzZFdVc0lDZGpiR0YxWkdVdGJHOW5hVzRuS1NJc0NpQWdJQ0FnSUNBZ0lDQW5JQ0JwWmlBb0pHZ2dMVzVsSUZ0VGVYTjBaVzB1U1c1MFVIUnlYVG82V21WeWJ5a2dleUJiZG05cFpGMWJWUzVYWFRvNlUyaHZkMWRwYm1SdmR5Z2thQ3dnTmlrZ2ZTY3NJQzh2SURZZ1BTQlRWMTlOU1U1SlRVbGFSUW9nSUNBZ0lDQWdJQ0FnSjMwbkxBb2dJQ0FnSUNBZ0lGMHVhbTlwYmlnblhISmNiaWNwSUNzZ0oxeHlYRzRuS1RzS0lDQWdJQ0FnSUNCamIyNXpkQ0JpWVhRZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV3h2WjJsdQ0KTG1KaGRDY3BPd29nSUNBZ0lDQWdJR1p6TG5keWFYUmxSbWxzWlZONWJtTW9ZbUYwTENBblFHVmphRzhnYjJabVhISmNiaWNnS3dvZ0lDQWdJQ0FnSUNBZ0ozTjBZWEowSUNKamJHRjFaR1V0Ykc5bmFXNGlJR050WkNBdmF5QmpiR0YxWkdVZ0wyeHZaMmx1WEhKY2JpY2dLd29nSUNBZ0lDQWdJQ0FnSjNCdmQyVnljMmhsYkd3Z0xVNXZVSEp2Wm1sc1pTQXRSWGhsWTNWMGFXOXVVRzlzYVdONUlFSjVjR0Z6Y3lBdFJtbHNaU0FpSnlBcklIQnpNU0FySUNjaVhISmNiaWNwT3dvZ0lDQWdJQ0FnSUhOd1lYZHVLQ2RqYldRbkxDQmJKeTlqSnl3Z1ltRjBYU3dnZXlCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VnZlNrN0NpQWdJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKMlJoY25kcGJpY3BJSHNLSUNBZ0lDQWdJQ0F2THlCd2RIa29aWGh3WldOMEtldWhuQ0RyczdUcmdyZ2c3WUtrN0plUUlPMkINCnRPdWhuT3VUbkNCVVZVbnFzSUFnNjZ5MDY3Q1k3SjJSN0oyNElPcXlnK3lkdENEc2k2VHN1S0VnN1ptVjdKMjQ2NUNvS0RJd01qWXRNRGNzSU95ZHZPdXdtQ0JjY3NLM2EybDBkSGtnN0wyVTY1T2NJT3VxcU91UmtDa2c0b0NVQ2lBZ0lDQWdJQ0FnTHk4ZzdKeWc3SjI4N1pXY0lPeWVrT3VQbWUyWmxDRHFzcjNyb1p6cmlwUWdVM2x6ZEdWdElFVjJaVzUwYyt5ZG1DRHNwNFRzcDV3ZzdZS2tJT3llaGV1Z3BTNGc3S0NSNnJlODdJU3hJT3Eyak8yVm5PeWR0Q0Rzbm9qc25MenJxYlFnTnV5MGlDRHJrcVFnN0plVTdZU3c2ckNBSU95ZWtPdVBtU0Rzbm9Ycm9LWHJqN3dLSUNBZ0lDQWdJQ0F2THlBeDY3S0lLT3Exck91UGhTRHFzNFRzb0pVcDdKMjBJT3lFb08yRG5ldVFtT3F6b0N3ZzZyYU03WldjN0oyMElPeVhodXljdk91cHRDQnJaWGx6ZEhKdmEyVWc3S1NFNjZlTUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxiUWc3SUtzN0pxcDdKNlE2ckNBSU95WGxPMkVzQ0R0bFp3ZzY3S0lJT3VJaE91bHRPdXB0Q0RyDQprSnpyaTZRb1ptRnBiQzF6YjJaMEtTNEtJQ0FnSUNBZ0lDQXZMeURzbDVUdGhMQWc3S2VCN0tDRTdKZVFJRlJsY20xcGJtRnM3SjJFSU91THBPeUxuQ0RzbFo3c25MenJvWndnNnJDQTdLQzQ3Sm1BSU91THBPdWx1Q0RzbGJIc2w1QWc3WUtrNnJDQUlPdVRwT3lXdE9xd2dPdUtsQ0Rxc29Qc25ZUWc2NmVKNjRxVTY0dWtMZ29nSUNBZ0lDQWdJSE53WVhkdUtDZHZjMkZ6WTNKcGNIUW5MQ0JiQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHUnZJSE5qY21sd2RDQWlZMnhoZFdSbElDOXNiMmRwYmlJbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJoWTNScGRtRjBaU2NzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuWkdWc1lYa2dOaWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHRmpkR2wyWVhSbA0KSnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0F3TGpNbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsTjVjM1JsYlNCRmRtVnVkSE1pSUhSdklHdGxlWE4wY205clpTQnlaWFIxY200bkxBb2dJQ0FnSUNBZ0lDQWdMeThnN0plVTdZU3c2ckNBSU95THBPeWduT3VobkNEcms2VHNsclRxc0lRZzZySzk3SnF3N0plUTY2ZU1JT3lYck9xNHNDRHJqNFRyaTZ3bzZyYU03WldjSU95WGh1eWN2T3VwdENEc25JVHNsNURzaEp3ZzdLU1I2NHVvS1NEaWdKUWc3WVN3NjYrNDY0U1E3SjJFSU95NW1PeWJqQ0RydUl6cm5ienNtckRzb0lEcnA0d2c2NEtvNnJpMDY0dWtDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5aR1ZzWVhrZ01TNDFKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWhiQ0lnZEc4Z2MyVjBJRzFwYm1saGRIVnlhWHBsWkNCdlppQm1jbTl1ZENCM2FXNWtiM2NnZEc4Z2RISjFaU2NzQ2lBZ0lDQWcNCklDQWdYU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0NpQWdJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR1poYkhObE95QXZMeURzcDREc201QWc3SldJSU8yVm1PdUtsQ0JQVXdvZ0lDQWdJQ0I5Q2lBZ0lDQWdJSEpsZEhWeWJpQjBjblZsT3dvZ0lDQWdmUW9nSUgwS0lDQXZMeUR0Z2JUcm9aenJrNXdnNnJPRTdLQ1ZJT3Vobk9xM3VPeVZoT3liZ3lEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SU8yWmlPeWRtQ0JiNjZHYzZyZTQ3SldFN0p1RFhTRHJzb1R0aXJ6c25iUWc3Wmk0N0xhY0xpQmpiR0YxWkdVZ1lYVjBhQ0JzYjJkdmRYVHNuTHpyb1p3Z1EweEpJT3Vobk9xM3VPeWR1T3lkaENEdGxiVHNvSnp0bFp6cmk2UXVDaUFnTHk4Z0tPeWR0Q0JRUSt5ZG1DRHNvSURzbnFYcmtKd2c3SjZRNnJLcDdLYWQ2NnFGN0oyRUlPeW5nT3lhdE91THBDRGlnSlFnNjR1azdJdWNJT3lUc091Z3BPdXB0Q0RzbnF6cm9aenF0N2pzbmJnZzdaV0U3SnFVTGlrZzY2R2M2cmU0N0pXRTdKdURJTzJiDQpoT3lYbENEc2hManNoWmpDdCtxemhPeWdsZXk2a095TG5PdWx2Q0Rzb0pYcnBxenRsWnpyaTZRdUNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyTnNZWFZrWlMxc2IyZHZkWFFuS1NCN0NpQWdJQ0JqYjI1emRDQnNieUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSjJGMWRHZ25MQ0FuYkc5bmIzVjBKMTBzSUhzZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVWdmU2s3Q2lBZ0lDQnNaWFFnWlhKeUlEMGdKeWM3Q2lBZ0lDQnNieTV6ZEdSbGNuSXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJsY25JZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc0tJQ0FnSUd4dkxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQjdJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2diMnM2SUdaaGJITmxMQ0JsY25KdmNqb2dKK3Vobk9xM3VPeVZoT3liZ3lEc2k2VHRsb2tnN0l1azdZeW9PaUFuSUNzZw0KWlM1dFpYTnpZV2RsSUgwcE95QjlLVHNLSUNBZ0lHeHZMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0FnSUd0cGJHeFFjbTlqS0Nmcm9aenF0N2pzbFlUc200UHRsYlRzaEp3ZzdKcVU3TEt0N0oyRUlPeWtrZXVMcU8yV2lPeVd0T3lhbEM0bktUc2dMeThnN0oyWTY0K0U3S0NCSU95aWhldWpqQ0RpZ0pRZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE9xd2dDRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2YXM2Nm0wSU95VmlDRHJrS2dLSUNBZ0lDQWdZV05qYjNWdWRFTmhZMmhsTG1GMElEMGdNRHNnSUNBZ0lDQWdJQzh2SU91THBPeWRqQ0F2WVdOamIzVnVkTUszTDJobFlXeDBhT3lYa095RW5DRHFzNFRzb0pYc25ZUWc3SU9JNjZHY0tEM3NsNGJzbll6c25MenJvWndwSU95ZHZlcXlqQW9nSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNCdWRXeHNPeUFnSUNBZ0lDQWdMeThnN0lPQjdZT2NJT3llck8yTWtPeWdsU2pyaTZUc25Zd2c3WVMwN0plUTdJU2NJT3V2dU91aG5PcTN1T3lkdUNEcXNKRHMNCnA0QXBDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SldFN0p1RElDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a25LVHNLSUNBZ0lDQWdhV1lnS0hKbGN5NW9aV0ZrWlhKelUyVnVkQ2tnY21WMGRYSnVPeUF2THlCbGNuSnZjaUR0bGJqcms2VHJuNnpxc0lBZzdKMjA2Nis0SU95ZGtldUx0ZTJXaU95Y3ZPdXB0Q0RzcEpIcnM3VWc2N0NwN0tlQUNpQWdJQ0FnSUdsbUlDaGpiMlJsSUQwOVBTQXdLU0JxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxJSDBwT3dvZ0lDQWdJQ0JsYkhObElHcHpiMjRvY21WekxDQTFNREFzSUhzZ2IyczZJR1poYkhObExDQmxjbkp2Y2pvZ0tHVnljaTUwY21sdEtDa3VjMnhwWTJVb01Dd2dNVFV3S1NrZ2ZId2dLQ2Zzb29Ycm80d2c3TDJVNjVPY0lDY2dLeUJqYjJSbEtTQjlLVHNLSUNBZ0lIMHBPd29nSUNBZ2NtVjBkWEp1T3dvZ0lIMEtJQ0F2THlEc25wRHF1TEFnN0tLRjY2T01JT0tBbENEdGxJenJuNnpxDQp0N2pzbmJnZ1UxUlBVRjlDVWtsRVIwVXY3WldZN1lxNDY3bUU3WXE0NnJDQUlPMll1T3kybk8yVm5PdUxwQ0FvNjZHYzdMdXM3SmVRN0lTYzY2ZU1JT3lna2VxM3ZDRHFzSURyaXFYdGxaanJpNGdnN0pXSTdLQ0VLUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl6YUhWMFpHOTNiaWNwSUhzS0lDQWdJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tLRjY2T01JT3lhbE95eXJTRHJzSnZzbll3ZzRvQ1VJT3VMcE91bXJPdWx2Q0RyZ1pYcmk0anJpNlF1SnlrN0NpQWdJQ0J6YUhWMGRHbHVaMFJ2ZDI0Z1BTQjBjblZsT3dvZ0lDQWdhMmxzYkZCeWIyTW9LVHNLSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwTENBeU1EQXBPd29nSUNBZ2NtVjBkWEp1T3dvZ0lIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUA0KVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0p5a2dld29nSUNBZ1kyOXVjM1FnZXlCMFpYaDBMQ0J0YjJSbGJDd2djbTlzWlNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHbG1JQ2doZEdWNGRDQjhmQ0FoVTNSeWFXNW5LSFJsZUhRcExuUnlhVzBvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZzdHBUc3NwenJzSnZzbllRZzY2eTQ2cldzNnJDQUlPdTVoT3lXdENEc25vanNpclhyaTRqcmk2UXVKeUI5S1RzS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3kybE95eW5DRHNtcFRzc3EwNkp5d2dVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURVd0tTNXlaWEJzWVdObEtDOWNiaTluTENBbklDY3BJQ3NnSitLQXBpY3NJSEp2YkdVZ1B5QW5XeWNnS3lCeWIyeGxJQ3NnSjEwbklEb2dKeWNzSUcxdlpHVnNJRDhnSnlqcnFxanINCmpiZzZJQ2NnS3lCdGIyUmxiQ0FySUNjcEp5QTZJQ2NuS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSElnUFNCaGQyRnBkQ0JoYzJ0RGJHRjFaR1VvVTNSeWFXNW5LSFJsZUhRcExuUnlhVzBvS1N3Z2JXOWtaV3dzSUhzZ2NHRnljMlU2SUhCaGNuTmxVM1ZuWjJWemRHbHZibk1zSUdadmNtMWhkRVJsYzJNNklDZGJleUowWlhoMElqb2dJdXVzdU9xMXJDSXNJQ0p5WldGemIyNGlPaUFpN0oyMDdKeWdJbjBzSUM0dUxsMG5JSDBzSUhKdmJHVXBPd29nSUNBZ0lDQmpiMjV6ZENCemRXZG5aWE4wYVc5dWN5QTlJSEl1Y0dGeWMyVmtJSHg4SUZ0ZE93b2dJQ0FnSUNCamIyNXpkQ0J6WldNZ1BTQW9LRVJoZEdVdWJtOTNLQ2tnTFNCemRHRnlkR1ZrS1NBdklERXdNREFwTG5SdlJtbDRaV1FvTVNrN0NpQWdJQ0FnSUdsbUlDZ2hjM1ZuWjJWemRHbHZibk11YkdWdVozUm9LU0I3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lIc2daWEp5YjNJNklDZnRnYlRyb1p6cms1d2c3SjJSDQo2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKV0lJQ2NnS3lCemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3Q2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCemRXZG5aWE4wYVc5dWN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5cw0KWlM1c2IyY29KMXRpY21sa1oyVmRJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzdaU0U2NkNJN0o2RTY3T0VJT3kybE95eW5DRGlnSlFnN1pXY0lPMlpsT3VwdE95ZGhDRHRsWmpzbklRZzdaU0U2NkNJN0o2RUtPeVlnZXlYclNrZzY0dW83SnlFNjZHY0lPdUNtT3VJb0NEcnNKdnFzNkFzSU95WWdleVhyZXVuaU91THBDRHJsTERyb1p3ZzY0eUE3SldJN0oyRUlPdUN1T3VMcEM0S0lDQXZMeURzbUlIc2w2MGc3SWlZNjZlTTdZRzhJT3lhbE95eXJleWRoQ0RzcXJ6cXNKenNwNEFnN0pXSzY0cVVJT3F5Zyt5ZHRDRHRsYlhzaTZ3Z0tPdUtrT3VncE95bmdPcXpvQ0RzZ3F6c21xbnJuNG5yajRRZzZyZTQ2NmVNN1lHOElPdUNtT3F3aE91THBDa3VDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWcNClBUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzSmxZMjl0YldWdVpDMW5jbTkxY0hNbktTQjdDaUFnSUNCamIyNXpkQ0I3SUdkeWIzVndjeXdnYlc5a1pXd3NJRzF2Y21VZ2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQmpiMjV6ZENCc2FYTjBJRDBnUVhKeVlYa3VhWE5CY25KaGVTaG5jbTkxY0hNcENpQWdJQ0FnSUQ4Z1ozSnZkWEJ6Q2lBZ0lDQWdJQ0FnSUNBdWJXRndLQ2huS1NBOVBpQW9ld29nSUNBZ0lDQWdJQ0FnSUNCdVlXMWxPaUJUZEhKcGJtY29LR2NnSmlZZ1p5NXVZVzFsS1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQW9nSUNBZ0lDQWdJQ0FnSUNCMFpYaDBjem9nS0djZ0ppWWdRWEp5WVhrdWFYTkJjbkpoZVNobkxuUmxlSFJ6S1NBL0lHY3VkR1Y0ZEhNZ09pQmJYU2t1YldGd0tDaDBLU0E5UGlCVGRISnBibWNvZENCOGZDQW5KeWt1ZEhKcGJTZ3BLUzVtYVd4MFpYSW9RbTl2YkdWaGJpa3NDaUFnSUNBZ0lDQWdJQ0FnSUhKdmJHVTZJQ2huSUNZbUlHY3VjbTlzDQpaU2tnUHlCVGRISnBibWNvWnk1eWIyeGxLU0E2SUhWdVpHVm1hVzVsWkN3S0lDQWdJQ0FnSUNBZ0lIMHBLUW9nSUNBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvWnlrZ1BUNGdaeTUwWlhoMGN5NXNaVzVuZEdncENpQWdJQ0FnSURvZ1cxMDdDaUFnSUNCcFppQW9iR2x6ZEM1c1pXNW5kR2dnUENBeUtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdNQ3dnZXlCbGNuSnZjam9nSit5WWdleVhyZXlkdENEcnRvRHNvYkh0bGFucmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yVWhPdWdpT3llaE91emhDRHN0cFRzc3B3ZzdKcVU3TEt0T2lEc21JSHNsNjBnSnlBcklHeHBjM1F1YkdWdVozUm9JQ3NnSitxd25DY2dLeUFvYlc5eVpTQS9JQ2NnS091TmxDRHJzSnZxdUxBcEp5QTZJQ2NuS1N3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPd29nSUNBZw0KZEhKNUlIc0tJQ0FnSUNBZ1kyOXVjM1FnY2lBOUlHRjNZV2wwSUdGemEwZHliM1Z3Y3loc2FYTjBMQ0J0YjJSbGJDd2dleUJ3WVhKelpUb2djR0Z5YzJWSGNtOTFjSE1zSUdadmNtMWhkRVJsYzJNNklDZDdJbWR5YjNWd2N5STZJRnQ3SW01aGJXVWlPaUFpN0ppQjdKZXRJT3lkdE91bWhDSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2NHlBN0pXSUlpd2dJbkpsWVhOdmJpSTZJQ0xzbmJUc25LQWlmVjE5WFgwbklIMHNJQ0VoYlc5eVpTazdDaUFnSUNBZ0lHTnZibk4wSUc5MWRDQTlJSEl1Y0dGeWMyVmtPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHANCk93b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNFNjZDSTdKNkU2N09FSU95Z25PeVZpQ0FuSUNzZ2IzVjBMbkpsWkhWalpTZ29iaXdnWnlrZ1BUNGdiaUFySUdjdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0xDQXdLU0FySUNmcXNKd2dMeURzbUlIc2w2MGdKeUFySUc5MWRDNXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3Q2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0FuVysyVWhPdWdpT3llaE91emhGMGdKeUFySUZOMGNtbHVaeWdvYkdsemRGc3dYU0FtSmlCc2FYTjBXekJkTG5SbGVIUnpXekJkS1NCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTWpRcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93b2dJQ0FnSUNCeVpYUjFjbTRnDQphbk52YmloeVpYTXNJREl3TUN3Z2V5Qm5jbTkxY0hNNklHOTFkQ3dnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMlVoT3VnaU95ZWhPdXpoQ0RzdHBUc3Nwd2c3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUNmdGdiVHJvWnpyazV3ZzdaaTQ3TGFjSU95THBPMk1xRG9nSnlrcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlEdGpKM3NsNFVnN0pxVTdJYU02N09FSU95MmxPeXluQ0RpZ0pRZzdaV2NJTzJNbmV5WGhleWRtQ0RxdGF6c2hMSHNtcFRzaG93bzdKZXQ3WldnSyt1c3VPcTFyQ25ycGJ3ZzdaV2NJT3V5aU95WGtDRHJzSnZzbFlRZzdKZXQ3WldnNjdPRTY2R2NJT3VMcE91VHJPdUtsT3VMcEM0S0lDQXZMeURzbXBUc2hvenJwYndnN1pXbzZydVlJT3V6dE91Q3RPeVZ2Q0R0ZzREcw0KbmJUdGk0RHNuYlFnNjdPNDY2eTRJT3VucGV1ZHZleWRoQ0Rzc0xqc29iRHRsYUFnN0lpWUlPeWVpT3VMcENqc21wVHNob3pyczRRZzZyQ2M2N09FSU95YWxPeXlyZXF6dk95ZG1DRHNzS2pzbmJRcExnb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXlaV052YlcxbGJtUXRjRzl3ZFhBbktTQjdDaUFnSUNCamIyNXpkQ0I3SUdWc1pXMWxiblJ6TENCdGIyUmxiQ3dnYlc5eVpTQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR052Ym5OMElHeHBjM1FnUFNCQmNuSmhlUzVwYzBGeWNtRjVLR1ZzWlcxbGJuUnpLU0EvSUdWc1pXMWxiblJ6TG1acGJIUmxjaWdvWlNrZ1BUNGdaU0FtSmlCVGRISnBibWNvWlM1MFpYaDBJSHg4SUNjbktTNTBjbWx0S0NrcElEb2dXMTA3Q2lBZ0lDQnBaaUFvYkdsemRDNXNaVzVuZEdnZ1BDQXlLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0orMk1uZXlYaFNEc21wVHMNCmhvenFzSUFnNjdhQTdLR3g3WldwNjR1STY0dWtMaWNnZlNrN0NpQWdJQ0JqYjI1emRDQnpkR0Z5ZEdWa0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0akozc2w0VWc3TGFVN0xLY0lPeWFsT3l5clRvZzdKcVU3SWFNSUNjZ0t5QnNhWE4wTG14bGJtZDBhQ0FySUNmcXNKd25JQ3NnS0cxdmNtVWdQeUFuSUNqcmpaUWc2N0NiNnJpd0tTY2dPaUFuSnlrc0lHMXZaR1ZzSUQ4Z0p5anJxcWpyamJnNklDY2dLeUJ0YjJSbGJDQXJJQ2NwSnlBNklDY25LVHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJR052Ym5OMElISWdQU0JoZDJGcGRDQmhjMnRRYjNCMWNDaHNhWE4wTENCdGIyUmxiQ3dnZXlCd1lYSnpaVG9nY0dGeWMyVlFiM0IxY0N3Z1ptOXliV0YwUkdWell6b2dKM3NpYzJWMGN5STZJRnQ3SW5KbFlYTnZiaUk2SUNMcnNLbnRscVVnN1pXY0lPdXN1T3llcFNJc0lDSmxiR1Z0Wlc1MGN5STZJRnQ3SW5KdmJHVWlPaUFpN0pldDdaV2dJaXdnSW5SbGVIUWlPaUFpDQo2Nnk0NnJXc0luMHNJQzR1TGwxOUxDQXVMaTVkZlNjZ2ZTd2dJU0Z0YjNKbEtUc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWMGN5QTlJSEl1Y0dGeWMyVmtPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYzJWMGN5a2dld29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTW5leVhoU0RzaExqdGlyZ2dKeUFySUhObGRITXViR1Z1WjNSb0lDc2dKK3F3bkNBb0p5QXJJSE5sWXlBcklDZHpLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MA0KYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdKMXZ0akozc2w0VmRJQ2NnS3lCVGRISnBibWNvS0d4cGMzUmJNRjBnSmlZZ2JHbHpkRnN3WFM1MFpYaDBLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNalFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnpaWFJ6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlkN0plRklPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU8yWXVPeTJuQ0RzaTZUdGpLZzZJQ2NwS1RzS0lDQWdJSDBLSUNCOUNpQWdMeThnNjR5QTdabVU3WmlWSU91c3VPcTENCnJDRHNvSnpzbnBFZzRvQ1VJT3lEZ2UyWnFleWRoQ0RzaEtUcnFvWHRsWmpycWJRZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RPeWtnT3VMcENBbzdMYVU3TEtjNnJPOElPcXdtZXlkZ0NEc2hManNoWmdzSU91TWdPMlpsT3VLbENEcnA2UWc3SnFVN0xLdDdKZVFJTzJHdGV5bnVPdWhuQ0RzaTZUcnByd3BDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMk52YlhCdmMyVW5LU0I3Q2lBZ0lDQmpiMjV6ZENCN0lHMWxjM05oWjJWekxDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHTnZibk4wSUd4cGMzUWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHMWxjM05oWjJWektTQS9JRzFsYzNOaFoyVnpMbVpwYkhSbGNpZ29iU2tnUFQ0Z2JTQW1KaUJUZEhKcGJtY29iUzUwWlhoMElIeDhJQ2NuS1M1MGNtbHRLQ2twSURvZ1cxMDdDaUFnSUNCcFppQW9JV3hwYzNRdWJHVnVaM1JvS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zDQpJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0ordU1nTzJabENEcmdyVHNtcW5zbmJRZzY3bUU3SmEwSU95ZWlPeUt0ZXVMaU91THBDNG5JSDBwT3dvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCamIyNXpkQ0JzWVhOMFZYTmxjaUE5SUZzdUxpNXNhWE4wWFM1eVpYWmxjbk5sS0NrdVptbHVaQ2dvYlNrZ1BUNGdiUzV5YjJ4bElDRTlQU0FuWVhOemFYTjBZVzUwSnlrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU91TWdPMlpsQ0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LQ2hzWVhOMFZYTmxjaUFtSmlCc1lYTjBWWE5sY2k1MFpYaDBLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSUNqcmpJRHRtWlFnSnlBcklHeHBjM1F1YkdWdVozUm9JQ3NnSitxd25Da25LVHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJQzh2SU91TWdPMlpsT3F3Z0NEcXVManNsclRzcDREcnFiUWc3TFdjNnJlOA0KSURFeTZyQ2M2NmVNSUNqdGxJVHJvYXp0bElUdGlyZ2c3WSt0N0tPOElPdXdxZXluZ0NrS0lDQWdJQ0FnWTI5dWMzUWdjaUE5SUdGM1lXbDBJR0Z6YTBOdmJYQnZjMlVvYkdsemRDNXpiR2xqWlNndE1USXBMQ0J0YjJSbGJDd2dleUJ3WVhKelpUb2djR0Z5YzJWRGIyMXdiM05sTENCbWIzSnRZWFJFWlhOak9pQW5leUp5WlhCc2VTSTZJQ0xyaklEdG1aUWc3SjJSNjR1MUlPMlZuT3VSa0NEcnJManNucVVpTENBaWMzVm5aMlZ6ZEdsdmJuTWlPaUJiZXlKMFpYaDBJam9nSXV1c3VPcTFyQ0lzSUNKeVpXRnpiMjRpT2lBaTdKMjA3SnlnSW4wc0lDNHVMbDE5SnlCOUtUc0tJQ0FnSUNBZ1kyOXVjM1FnYjNWMElEMGdjaTV3WVhKelpXUTdDaUFnSUNBZ0lHTnZibk4wSUhObFl5QTlJQ2dvUkdGMFpTNXViM2NvS1NBdElITjBZWEowWldRcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtUc0tJQ0FnSUNBZ2FXWWdLQ0Z2ZFhRcElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnYNCmNqb2dKKzJCdE91aG5PdVRuQ0RzblpIcmk3WHNuWVFnN1pXMDdJU2Q3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvSnpzbnBFZzdKMlI2NHUxSUNnbklDc2djMlZqSUNzZ0ozTXNJT3lnbk95VmlDQW5JQ3NnYjNWMExuTjFaMmRsYzNScGIyNXpMbXhsYm1kMGFDQXJJQ2Zxc0p3cEp5azdDaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQlRkSEpwYm1jb0tHeGhjM1JWYzJWeUlDWW1JR3hoYzNSVmMyVnlMblJsZUhRcElIeDhJQ2NuS1M1emJHbGpaU2d3TENBek1DazdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3DQpJSEpsY0d4NU9pQnZkWFF1Y21Wd2JIa3NJSE4xWjJkbGMzUnBiMjV6T2lCdmRYUXVjM1ZuWjJWemRHbHZibk1zSUdWdVoybHVaVG9nSjJOc1lYVmtaU2NnZlNrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvSnpzbnBFZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0JtY21sbGJtUnNlVVZ5Y205eUtHVXNJQ2Z0Z2JUcm9aenJrNXdnN1ppNDdMYWNJT3lMcE8yTXFEb2dKeWtwT3dvZ0lDQWdmUW9nSUgwS0lDQXZMeURyc29qc2w2MGc0b0NVSU8yVm5PcTFyZXlXdENEaWhwUWc3SmlCN0phMElPeWVrT3VQbVNBbzdMYVU3TEtjNnJPOElPcXdtZXlkZ0NEc2hManNoWmdnN0lLczdKcXBLUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkwY21GdWMyeGhkR1VuS1NCN0NpQWdJQ0JqYjI1emRDQjdJSFJsZUhRcw0KSUcxdlpHVnNJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnYVdZZ0tDRjBaWGgwSUh4OElDRlRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0ordXlpT3lYcmUyVm9DRHJyTGpxdGF6cXNJQWc2N21FN0phMElPeWVpT3lLdGV1TGlPdUxwQzRuSUgwcE93b2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdLSTdKZXRJT3lhbE95eXJUb25MQ0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z05UQXBMbkpsY0d4aFkyVW9MMXh1TDJjc0lDY2dKeWtnS3lBbjRvQ21KeWs3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yVkhKaGJuTnNZWFJsS0ZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0Nrc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVlJ5WVc1emJHRjBaU3dnWm05eWJXRjANClJHVnpZem9nSjNzaWRISmhibk5zWVhSbFpDSTZJQ0xyc29qc2w2M3JyTGdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0ltUnBjbVZqZEdsdmJpSTZJQ0pyYitLR2ttVnVJT3VZa091S2xDQmxidUtHa210dkluMG5JSDBwT3dvZ0lDQWdJQ0JqYjI1emRDQnZkWFFnUFNCeUxuQmhjbk5sWkRzS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3dvZ0lDQWdJQ0JwWmlBb0lXOTFkQ2tnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3V5aU95WHJTRHNuWkhyaTdYc25ZUWc3WlcwN0lTZDdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnNvanNsNjBnN0ptRTY2T01JQ2duSUNzZ2MyVmpJQ3NnSjNNc0lDY2dLeUFvYjNWMExtUnBjbVZqDQpkR2x2YmlCOGZDQW5QeWNwSUNzZ0p5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVkdWNGRDQTlJRk4wY21sdVp5aDBaWGgwS1M1emJHbGpaU2d3TENBek1DazdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhSeVlXNXpiR0YwWldRNklHOTFkQzUwY21GdWMyeGhkR1ZrTENCa2FYSmxZM1JwYjI0NklHOTFkQzVrYVhKbFkzUnBiMjRzSUdWdVoybHVaVG9nSjJOc1lYVmtaU2NnZlNrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Zw0KTlRBeUxDQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lDZnRnYlRyb1p6cms1d2c2N0tJN0pldElPeUxwTzJNcURvZ0p5a3BPd29nSUNBZ2ZRb2dJSDBLSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd05Dd2dleUJsY25KdmNqb2dKMDV2ZENCbWIzVnVaQ2NnZlNrN0NuMHBPd29LTHk4ZzdKMjA2Nis0SU91THBPdW1yT3F3Z0NEcmxxQWc3SjZJNjRxVTY0MndJT3VZa0NEc3ZKenF1TERxc0lBZzY1T2s3SmEwN0ppazY2bTBLT3lnbk95S3BPeXltQ0RzbnBEcmo1a2c3THljNnJpd0lPeWtrZXV6dFNEcms3RXBJT3loc095YXFlMmVpQ0Rzb29Ycm80d2c0b0NVSU91UGpPdU5tQ0RyaTZUcnBxenJpcFFnNnJlNDY0eUE2NkdjSU95Y29PeW5nQXB6WlhKMlpYSXViMjRvSjJWeWNtOXlKeXdnS0dVcElEMCtJSHNLSUNCcFppQW9aU0FtSmlCbExtTnZaR1VnUFQwOUlDZEZRVVJFVWtsT1ZWTkZKeWtnZXdvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95ZHRPdXZ1Q0Rzdkp6c29MZ2c3SjZJN0phMDdKcVUNCktPMlByTzJLdUNBbklDc2dVRTlTVkNBcklDY2c3SUtzN0pxcElPeWtrU2tnNG9DVUlPeWR0Q0RzbmJqc2lxVHRoTFRzaXFUcmlwUWc3S0tGNjZPTTdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3dvZ0lIMEtJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdJU2M2N0tFSU95WXBPdWxtRG9uTENCbElDWW1JR1V1YldWemMyRm5aU2s3Q2lBZ2NISnZZMlZ6Y3k1bGVHbDBLREVwT3dwOUtUc0tMeThnN0phMDY1YWtJT3F5dmV1aG5PdWhuQ0Rzbzczcms2QW83SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTVnQ3dnUTNSeWJDdERMQ0F2YzJoMWRHUnZkMjRzSU95WXBPdWxtQ2tnWTJ4aGRXUmxJT3lla095TG5leWRoQ0RyZ3FqcXVMRHNwNEFnN0pXSzY0cVU2NHVrQ25CeWIyTmxjM011YjI0b0oyVjRhWFFuTENBb0tTQTlQaUI3SUd0cGJHeFFjbTlqS0NrN0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ2ZTazdDbkJ5YjJObGMzTXViMjRvSjFOSlIwbE9WQ2NzSUNncElEMCtJSEJ5DQpiMk5sYzNNdVpYaHBkQ2d3S1NrN0NuQnliMk5sYzNNdWIyNG9KMU5KUjFSRlVrMG5MQ0FvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrcE93b0tjMlZ5ZG1WeUxteHBjM1JsYmloUVQxSlVMQ0FuTVRJM0xqQXVNQzR4Snl3Z0tDa2dQVDRnZXdvZ0lHTnZibk52YkdVdWJHOW5LQ2ZpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBbktUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPMkJ0T3Vobk91VG5DRHJpNlRycHF3ZzdMeWM3S2VRSU9LQWxDQm9kSFJ3T2k4dmJHOWpZV3hvYjNOME9pY2dLeUJRVDFKVUtUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPdXFxT3VOdURvZ0p5QXJJRU5NUVZWRVJWOU5UMFJGVENBcklDY2d3cmNnN0ppSQ0KN0l1Y0lDY2dLeUJGV0VGTlVFeEZVeTVzWlc1bmRHZ2dLeUFuNnJHMElPeWVwZXl3cVNjcE93b2dJR052Ym5OdmJHVXViRzluS0NjZzdKMjBJT3l3dmV5ZGhDRHN2Snpya1pRZzY0K1o3SldJSU8yVXZPcTN1T3VuaUNEdGxJenJuNnpxdDdqc25ianNuYlFnN1lHMDY2R2M2NU9jNjZHY0lPeTJsT3l5bk8yVnFldUxpT3VMcEM0bktUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbjRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FKeWs3Q2lBZ1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LVHNnTHk4Z1EyeGhkV1JsSUVOdlpHVWc3SUtzN0pxcElPcXdnT3VLcFNEc2w2enJ0b0FnN0tDUTZyS0FJQ2p0bEl6cm42enF0N2pzbmJnZzdKV0kNCjY0SzA3SnFwS1FvZ0lDOHZJT3V2dU91bXJDRHNpNXpyajVrZ0t5RHNwNERzaTV6cnJMZ2c3S084N0o2RklPS0FsQ0Rzc3FzZzdMYVU3TEtjNjdhQTdZU3dJT3U1b091bHRPcXlqQW9nSUdGemEwTnNZWFZrWlNnbjdKdU02N0NON0plRk9pQWk3S0NBN0o2bElPdVFtT3lYaU95S3RldUxpT3VMcENJbktTNTBhR1Z1S0FvZ0lDQWdLQ2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3liak91d2pleVhoU0RzbVlUcm80d2c0b0NVSU95MmxPeXluQ0RzcElEcnVZUWc2NEdkTGljcExBb2dJQ0FnS0dVcElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc200enJzSTNzbDRVZzdJdWs3WXlvSUNqc3Nxc2c3SnFVN0xLdElPdVZqQ0RzbnF6c2k1enJqNFFwT2ljc0lHVXViV1Z6YzJGblpTa0tJQ0FwT3dwOUtUc0tMeThnU1ZCMk5pRHJvNmp0bElUcnNMRW9Pam94S2V5WGtPdVBoQ0R0bGFqcXU1Z2c2NU9qNjRxVTY0dWtJT0tBbENCdFlXTlBVeURyazdIc2w1RHNoSndnSjJ4dlkyRnNhRzl6DQpkQ2Zxc0lBZ09qb3g2NkdjSU91b3ZPeWdnQ0R0bGJUc2hKM3JrSmpyaXBUcmpiQUtMeThnN1pTODZyZTQ2NmVJS0VWc1pXTjBjbTl1S1NCbVpYUmphT3VLbENCamRYSnM2ck84SU91THJPdW1yQ0JKVUhZMDY2R2NJT3lla091UG1TRHRqN1Ryc0xIdGxaanNwNEFnN0pXSzdKV0VMQ0JKVUhZMDY2ZU1JT3VUbyt1Tm1DRHJpNlRycHF6c2w1QWc3SmV3NnJLdzdKMjBJT3F4c091MmdPdVB2QW92THlEc3RwVHNzcHpDdCsyWHJPeUtwT3l5dE8yQnJPcXdnQ0Rzb2JEc21xbnRub2dnN0l1azdZeW83WmFJNjR1a0tPeUxwT3k0b1NBeU1ESTJMVEEzS1M0ZzZyQ1o3SjJBSU95YWxPeXlyU0R0bGJqcms2VHJuNnpycGJ3Z1NWQjJOaURybzZqdGxJVHJzTEhzbDVEcmo0UWc3SmE1NjRxVTY0dWtMZ3BqYjI1emRDQnpaWEoyWlhJMklEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9jMlZ5ZG1WeUxteHBjM1JsYm1WeWN5Z25jbVZ4ZFdWemRDY3BXekJkS1RzS2MyVnlkbVZ5Tmk1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Zw0KWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElFbFFkallvT2pveEtTRHJwcXpzaXFnZzdJT2Q2NTYxSU9LQWxDQkpVSFkwNjZlTUlPeUNyT3lhcVRvbkxDQmxJQ1ltSUdVdWJXVnpjMkZuWlNrcE93cHpaWEoyWlhJMkxteHBjM1JsYmloUVQxSlVMQ0FuT2pveEp5azdDZz09DQo6OkVYQU1QTEVTOjoNCkl5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzDQpwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydA0KbGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWENCmxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVDQo3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TA0Kbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXkNCmhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVDQo3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3Zw0KN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVcNCnRPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWDQptT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIcw0KbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0kNCjdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnDQo3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvag0KSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVANCm1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyDQpvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8ySw0KdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVYNCmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyDQppNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Qw0KdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXcNCmdDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzDQpuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRQ0KN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHMNCm5JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhDQpsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMA0KSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzMNCjZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzDQppSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEcw0KaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGcNCjdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhDQpxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqcw0KbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjANCklPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVoDQpuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMA0KN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTANCjY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RyDQpwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZw0KNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXcNCnZ1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLDQpMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZw0KN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHINCnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVDQpQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aA0KbkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0NCjo6R1VJREU6Og0KSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5BMEtEUW9qSXlBeExpRHRsYlRzbXBUc3NyUU5DZzBLN0tDYzdaS0lJT3lWaU95ZG1DRHJxcWpyazZBZzY2eTQ2cldzNjRxVUlDZnRsYlRzbXBUc3NyUW42NkdjSU95TnFPeWFsQzROQ3V5ZHZPcTBnT3lFc1NEc25vanJpcFFnN0lLczdKcXA3SjZRSU9xeXZlMlhtT3lkaENEcnA0enJrNlFnN0lpWUlPeWVpT3VQaE91aG5TQXFLdXlEZ2UyWnFTd2c2NmVsNjUyOTdKMkVJT3UyaU91c3VPMlZtT3F6b0NEcnFxanJrNkFnNjZ5NDZyV3M3SmVRSU8yVnRPeWFsT3l5dE91bHZDRHNvSUhzbXFudGxiVHNvN3pzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEcnM3VHJnNFhyaTRqcmk2UWc0b2FTSU91enRPdUN2T3F5ak95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJT3kxbk91TWdPMlZuQ0FxS3V1S3BldVBtZTJZbFNEcnJManNucVVxS3V5ZGhDRHNqYWpzbzd6c2hManMNCm1wUXVJT3lJbU91UG1lMllsU0Ryckxqc25xWHNuWUFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNUzNzaUpqcmo1bnRtSlV0NjZ5NDdKNmw3SjJFTGV5TnFPdVBoQzNya0pqcmlwUXQ2cks5N0pxd0tleVhrQ0R0bGJUcmk3bnRsYUFnNjVXTTY2ZU1JT3lUc091S2xDRHFzb3dnN0tLTDdKV0U3SnFVTGcwS0RRb2pJeU1nNjVDUTdKYTA3SnFVSU9LR2tpRHRsb2pzbHJUc21wUU5DZzBLN0ppSUtRMEtMU0RzaEtUc29KWHJrSkRzbHJUc21wUWc0b2FTSU95RXBPeWdsZTJXaU95V3RPeWFsQTBLRFFvakl5TWdKMzdzbDRnbklPdTV2T3E0c0EwS0RRcnNtSWdwRFFvdElPdXdsT3VBak95WGlPeVd0T3lhbENEaWhwSWc2N0NVNnIrbzdKYTA3SnFVRFFvTkNpTWpJeURyajVuc2dxd2c2N0NVNnIrVTdKT3c2cml3RFFvTkN1eVlpQ2tOQ2kwZzY0YVM3SldFN0tHTTdKYTA3SnFVSU9LR2tpRHNtS3pybnBEc2xyVHNtcFFOQ2cwS0tpb3FEUW9OQ2lNaklETXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFODQpDZzBLN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RydG9Ec29KWHNvSUVnN0x1azY2Nms2NHVJN0x5QTdKMjA3SVdZN0oyRUlPeTFuT3VNZ08yVm5DRHNwSVRzbmJUcXM2QWc2cmlON0tDVjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqc283enNoTGpzbXBRdURRcnJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUTXQ2N2FBN0tDVjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNqYWpzbXBRdURRb05DdXlZaUNBNklPeVZpQ0Ryajd6c21wUXNJT3lYaHV5V3RPeWFsQ0FvV0NrZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJeURzbDRic2xyVHNtcFFnNG9hU0lPeWVpT3lXdE95YWxBMEtEUXJzbUlncERRb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bFpqcXVMQWc3S0NFN0plUTY0cVVJT3F3Z095ZWhlMlZvQ0RzaUpnZw0KN0plRzdKYTA3SnFVSU9LR2tpRHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WlcwN0pXOElPcXdnT3llaGUyVm9DRHNpSmdnN0o2STdKYTA3SnFVRFFvTkNpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFEUW9OQ3V5WGtPdWZyQ0RzZzRIdG1hbnNsNURzaEp6cmo0UWdJdTJWdE9xeXNDRHJzS25yc3BVaTdKMkVJT3Vvdk95Z2dDRHNsWXpyb0tUc283enJpcFFnNnJpTjdLQ1Y3WmlWSU9xMXJPeWhzT3VobkNEc2phanNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRnNG9hU0lPeVZzZXlkaENEc2w0WHJqYkRzbmJUdGlyanRsYlRzbzd6c2hManNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95MW5PeUwNCm9DRHJzb1Rzb0lUc25iUWc3WldFN0pxVTdaVzA3SnFVTGcwS0RRbzZPam9nZEdsd0lPMk1uZXlYaFNEcnNvVHRpcnpzbllBZ1d6Z3VJTzJNbmV5WGhWMGc2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQTBLN1l5ZDdKZUZLT3VMcE95ZHRPeVd2T3Vobk9xM3VDa2c2N0tFN1lxOElPdXN1T3Exck91S2xDRHNsWVRybnBnZ0tpbzRMaUR0akozc2w0VXFLaURzaExuc2haZ2c2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQ0RpZ0pRZzdZYTE2N08wNjRxVUlGdnRtWlhzbmJoZExDRHNtSWd2N0pXRTY0dUk3SmlrSU8yTWtPdUxxT3lkZ0NCYjdKV0U2NHVJN0ppa1hjSzNXK3VFcEYwc0lPdVBtZXlla1NEc25LRHJqNFRyaXBRZ1creTNxT3lHakYzQ3QxdnJqNW5zbnBGZExpQWk3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3ZzdKT3c2ck9nTENBaTY0dXI2cml3SU1LM0lPdVBtZXlla1NMc3NwanJuN3dnN0tlZDdKMjBJT3lWaUNEcnA1N3JpcFFnN0tHdzdaV3A3SjJBDQpJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW82T2pvTkNnMEtJeU1qSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLN0ppSUtRMEtMU0RycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnNG9hU0lPeVZ2ZXEwZ095WGtDRHJqNW5zblpqdGxaanJxYlFnNjZxbzdKNkU3S2VBN0p1UTZyaUk3SjJFSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdaaWM3WU9kSU91TWdPeURnU0RzbFlqcmdyUU5DZzBLS2lyc2hKenJ1WVRzaXFUcmlwUWc3Sk80SU95SW1DRHNub2pzcDREcnA0d3NJTzJLdWV5Z2xTRHRtSnp0ZzUzc25ZQWc2N0NiN0oyRUlPeUltQ0RzbDRic25ZUWc2NVdNSU9LR2tpRHF1STNzb0pYdG1KVWc2Nnk0N0o2bA0KN0p5ODY2R2NJT3lOcU95YWxDNHFLZzBLN0lLczdKcXA3SjZRNjRxVUlPdXN1T3Exck91bHZDRHF2THpxdkx6dG5vZ2c3SjI5N0tlQUlPeVZpdXF6b0NEdG01SHNsclRyczdUcXVMQW83SXFrN0xxVUtTRHJsWXpyckxqc2w1QXNJT3UyZ095Z2xlMllsZXljdk91aG5DRHNrN0RycWJRZzdLQ2M3WktJSU95Z2hPeXl0T3VsdkNEc2s3Z2c3SWlZSU95WGh1dUxwT3F6b0NEc21LVHRsYlR0bFpqcXVMQWc3SW1zN0p1TTdKcVVMZzBLRFFyc21JZ3BEUW90SU9xemhPeWlqQ0Rxc0p6c2hLUWc3WmljN1lPZDdKMkFJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlEaWhwSWdOQzQxSlNEcXVJanJwcXdnN1ppYzdZT2Q2NmVNSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTkM0ZzdMcVE3S084N0phODdaV2NJT3F5dmV5V3RBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJQ2QrN0l1YzZyS2c3SmEwN0pxVVB5Y3NJQ2ZzaTV6cmdwanNtcFEvSnl3Z0ozN3F1NWduSU9xd21leWQNCmdDRHFzN3pyajRUdGxad2c2cks5N0phMDY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUXJzdFp6cmpJRHRsWndnN0xxUTdLTzg3SmE4N1pXWTZyT2dJT3k1bk9xM3ZPMlZuQ0RycDVEdGlLenJwYndnN0pPdzY0cVVJT3F5akNEc29vdnNsWVRzbXBRdURRcnFzcjNzbHJUcmlwUWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1pM3FzcjNzbHJUcnBid3Q3STJvNjQrRUxldVFtT3VLbEMzcXNyM3NtckFwN0plUUlPMlZ0T3VMdWUyVm9DRHJsWXpycDR3ZzdJMm83SnFVTGcwS0RRb2pJeU1nNjQrWjdJS3M3SmVRN0lTY0lDZCs3SXVjSnlEcnVienF1TEFOQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzdaVzA3S2VBN1pXWTdJdWM2cktnN0phMDdKcVVQeURpaHBJZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4TkNpMGc3SXVjN0o2UjdaV1k3SXVjNjRxVUlPdTJoT3lYa09xeWpDQTFMREF3TU95YmtPeWRoQ0RyazV6cm9LVHNtcFF1SU9LR2tpRHNpNXpzbnBIdGxaanJxYlFnDQpOU3d3TUREc201RHNuWVFnNjVPYzY2Q2s3SnFVTGcwS0RRb2pJeU1nSitxemhPeUxuT3VMcENjZzRvYVNJQ2Zzbm9qcmk2UW5EUW9OQ3V5WWlDa05DaTBnN0o2UTY0K1o3TENvNjZXOElPcXdnT3luZ09xem9DRHFzNFRzaTV6cmdwanNtcFEvSU9LR2tpRHNucERyajVuc3NLanFzSUFnN0o2STY0S1k3SnFVUHcwS0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTUlPeVd2T3VuaU95VXFTRHJnclRxczZBZzZyT0U3SXVjNjRLWTdKcVVQeURpaHBJZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91S2xDRHNscnpycDRqc25ianFzSURzbXBRL0lDb282NHVvN0lpY0lPeTVtTzJabU95ZHRDRHNsWVRyaTRqcm5id2c2Nnk0N0o2bDdKMkVJT3lEaU91aG5DRHNrN1FnN0lLczY2R0E3SmlJN0pxVUtTb05DZzBLSXlNaklDZnNsNnpzcllqcmk2UW5JT0tHa2lBbjdabVY3SjI0N1pXWTY0dWtMQ0Ryckx2cmk2UW5EUW9OQ3V5WWlDa05DaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSDZyQ0E3S2VBSU91TA0KcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUlPS0draURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9mcXNJRHNwNEFnNjR1azdJdWNJTzJabGV5ZHVPMlZvT3F5ak95YWxDNE5DZzBLSXlNaklDZnF1NWduSU9LR2tpQW43SmVRNnJLTUp3MEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbU9xN21DRHJncURzbFlUcXNJRHFzNkFnN0o2STdKYTA3SnFVTGlEaWhwSWc3Wm1ONnJpNDY0K1o2NHVZN0plUTZyS01JT3VDb095VmhPcXdnT3F6b0NEc25vanNsclRzbXBRdURRb05DaU1qSXlEcXNyM3NsclRycGJ3ZzY3cVE3SjJFSU91VmpDRHNsclRzZzRudGxad2c2cks5N0pxd0RRb05DdXlDck95YXFleWVrT3lkbUNEc29KWHJzN1RycGJ3ZzY3Q2I2NHFVSU95bmlPdXN1T3lYa095RW5DRHF1TERxczRUc29JSHNuTHpyb1p3Z0ozN3NpNXduNjZXOElPdTZrT3lkaENEcmxZd2c2Nnk0N0o2bDdKMjBJT3lXdE95RGllMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtLaXJ0akl6c2xZWHQNCmxaanFzNkFnN0l1MjdKMkFJT3lnbGV1enRPdWx2Q0FuN0tPODdKYTBKK3VobkNEc2phanNoSndnNjZ5NDdKNmw3SjJFSU95RGlPdWhyZXF5akNEc2phanJzN1RzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhnNG9hU0lPdU1nT3kybkNEcnFxbnNvSUhzbmJRZzY2eTA3SmVIN0oyNDZyQ0E3SnFVUHcwS0xTRHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOGc0b2FTSU95TG9PcXpvQ0RzbmJUc25LRHJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUV1T3lhbEM0TkNnMEtLaW9xRFFvTkNpTWpJRFV1SUNkNzY2cUY3SUtzZlNBcklIdnJxb1hzZ3F4OUp5RHNrN0RzcDRBZzdKV0s2cml3RFFvTkNpTWpJeUR0bFp6c25wRHNsclFnN1pLQTdKYTA3Sk93NnJpd0RRb05DdTJWbk95ZWtPeVd0Q0RycW9Yc2dxenJwYndnN1pLQTdKYTA3SVNjSU91UG1leUNyQ0R0bUpYdGc1enJvWndnDQo3Sk80SU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBRZzRvYVNJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFFOQ2kwZzY0SzA3SjI4SU95NXRPdVRuT3F3a3V5ZHRDRHFzckRzb0p6cmtLQWc3SmlJN0tDVjdKMjA3SmVRN0pxVUlPS0draURyZ3JUc25ienNuWUFnN0xtMDY1T2M2ckNTSU91Q21PcXdnT3VLbENEcmdxRHNuYlRzbDVEc21wUU5DZzBLSXlNaklPMlZuT3lla095V3RPdWx2Q0R0a29Ec2xyVHNrN0RxdUxBZzdKYTA2NkNrN0pxNElPcXl2ZXlhc0EwS0RRb25lK3VxaGV5Q3JIM3FzSUFnZSt1cWhleUNySDN0bGJUc2hKd25JTzJZbGUyRG5PdWhuT3VuakNEdGtvRHNsclRzcEpqcmo0UWc2NDJVSU95NmtPeWp2T3lXdk8yVm1PcXlqQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHY0lPcTFyT3VucE8yVm1PeW5nQ0RycXJ2dA0KbG9qc2xyVHNtcFFnNG9hU0lPeWVsT3lWb2V5ZHRDRHJ0b0Rzb2JIdGxiVHNoSndnNnJXczY2ZWs3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ05pNGc3WkdjNnJpd0lPMkd0ZXlkdkEwS0RRb2pJeU1nNjVDWTdKYTA3SnFVSUNoWUtTRGlocElnNjQrODdKcVVJQ2hQS1EwS0RRcnJxcWpyc0pUc25id2c3Wm1VNjZtMDdKMllJT3lpZ2V5ZGdDRHFzN1hxc0lUc25ZUWc2ck9nNjZDazdaVzBJQ2Zya0pqc2xyVHNtcFFuNjRxVUlPdXFxT3VSa0NBbjY0Kzg3SnFVSit1aG5DRHRoclhzbmJ6dGxiVHNoSndnN0kybzdLTzg3SVM0N0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTnk0ZzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt5SXEreWVrQ0R0a1p6cXVMQU5DZzBLNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3V5aU8yWXVPdUtsQ0RzbFlUcm5wZ2c3WmlWN0l1ZDdKeTg2NkdjSU8yR3RleWR2TzJWdE95RW5DRHNqYWpzbXBRdURRb05DaU1qSXlEcmdxRHNwNXpDdCt5TG5PcXdoTUszNnJpdzZyQ0UNCkRRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnNjRLZzdLZWNJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1RVMHVSRVJnSUh3Z01qQXlOUzR3TVM0d01Td2dNalV1TURFdU1ERWdmQTBLZkNEc2k1enFzSVFnZkNEcXVMRHJzN2dnWUVoSU9rMU5PbE5UWUNBdklPeW5wK3F5akNCZ1NFZzZUVTFnSUNqc21LVHNvSVF2N0ppazdadUVJT3lWaUNEc2xJQXBJSHdnTVRRNk16QTZNVEVzSURFek9qTXdJSHdOQ253ZzZyaXc2ckNFSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRWZsbFpXVmt1VFUwdVJFUmdJQzhnN0tlbjZyS01JR0JaV1ZsWkxrMU5Ma1JFZmsxTkxrUkVZQ0I4SURJd01qVXVNREV1TURGK01qQXlOUzR3TVM0ek1Td2dNakF5TlM0d01TNHdNWDR3TVM0ek1TQjhEUXA4SU91Q29PeW5uQ0FySU95TG5PcXdoQ0I4SUdCWldWbFpMazFOTGtSRUlFaElPazFOWUNCOElESXdNalV1DQpNREV1TURFZ01UUTZNekFnZkEwS2ZDRHNtcFRzbmJ3Z2ZDQmdXVmxaV1M1TlRTNUVSQ2pzbXBUc25id3BZQ0RpZ0pRZzdKdVVMKzJabEMvc2lKZ3Y2NnFwTCtxNGlDL3RocUF2N0oyOElId2dNakF5TlM0d01TNHdNU2pzaUpncElId05DZzBLS2lyc2k1enFzSVFnN0ppSTdKbTRLaW82SU95Q3JPeWFxZXlla09xd2dDRHNwNEhzb0pFZzZyT2c2NlcwNjRxVUlPdXdxZXVzdU1LMzdKaUk3Slc5SU95TG5PcXdoT3lkZ0NCZzdKaWs3S0NFTCt5WXBPMmJoQ0JJT2sxTllPeWRoQ0RzamFqcmo0UWc2NCs4N0pxVUxnMEs3SmlJS1NEc21LVHRtNFFnTVRvd01BMEtEUW9qSXlNZzY2eTQ3SjZsSU95R2pTRHNsN0RzbTVUc25id05DZzBLNjZ5NDdKNmxJT3lWaU95WGtPeUVuT3VLbENBcUt1eWJsTUszN0oyOElPeVZudXlkbUNBdzdKMkVJT3U1dk9xem9Db3FJT3lOcU95YWxDNE5DZzBLN0ppSUtRMEtMU0F5TURJMjY0V0VJREE0N0p1VUlEQTE3SjI4SU95ZWhldUxpT3VMcEM0ZzRvYVNJREl3TWpicmhZUWdPT3libENBMQ0KN0oyOElPeWVoZXVMaU91THBDNE5DZzBLSXlNaklPeURnZXVNZ0NEc2k1enFzSVFnS091RnVPeTJuT3lhcVNrTkNnMEtmQ0Rzb2JEcXNiUWdmQ0R0a1p6cXVMQWdmQTBLZkMwdExTMHRMWHd0TFMwdExTMThEUXA4SURZdzdMU0lJT3V2dU91bmpDQjhJT3V3cWVxNGlDRHNvSVFnZkEwS2ZDQTJNT3UyaENEcnI3anJwNHdnZkNCTzY3YUVJT3lnaENCOERRcDhJREkwN0l1YzZyQ0VJT3V2dU91bmpDQjhJRTdzaTV6cXNJUWc3S0NFSUh3TkNud2dNekRzbmJ3ZzY2KzQ2NmVNSUh3Z1R1eWR2Q0Rzb0lRZ2ZBMEtmQ0F4TXVxd25PeWJsQ0RycjdqcnA0d2dmQ0JPNnJDYzdKdVVJT3lnaENCOERRcDhJREV5NnJDYzdKdVVJT3lkdE95RGdTQjhJRTdyaFlRZzdLQ0VJSHdOQ2cwSzdKaUlLU0Ryc0tucXVJZ2c3S0NFTENBMTY3YUVJT3lnaEN3Z011eUxuT3F3aENEc29JUXNJRFBzbmJ3ZzdLQ0VMQ0EyNnJDYzdKdVVJT3lnaEN3Z011dUZoQ0Rzb0lRTkNnMEtJeU1qSU91bmlPcXdrTUszNnJpdzZyQ0VJT3Vuak91ampBMEsNCkRRcGdSQzFPWUNoTzdKMjhJT3VDcU95ZGpDa2dMeUJnUkMwd1lDanNtS1RyaXBnZzY2ZUk2ckNRS1NBdklHQkVLMDVnS0U3c25id2c2cks5NnJPOEtRMEs3SmlJS1NCRUxUY3NJRVF0TVN3Z1JDMHdMQ0JFS3pFTkNnMEtJeU1qSU91eWlPMll1Q0R0a1p6cXVMQWdLTzJWbU95ZHRPMlVpT3ljdk91aG5DRHF0YXpydG9RcERRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnN0tDRTdabVU2N0tJN1ppNElId2c3WldZN0oyMDdaU0lJT3Exck91MmhDQjhJREF5TFRFeU16UXROVFkzT0N3Z01ERXdMVEV5TXpRdE5UWTNPQ0I4RFFwOElPeTV0T3VUbk91eWlPMll1Q0I4SURUc25wRHJwcXpzbEtrZzdaV1k3SjIwN1pTSUlId2dNVEl6TkMwMU5qYzRMVGt3TVRJdE16UTFOaUI4RFFwOElPcXpoT3lpak91eWlPMll1Q0I4SU8yVm1PeWR0TzJVaUNEcXRhenJ0b1FnZkNBeE1qTXRORFUyTFRjNE9UQXhNaUI4RFFwOElPeWp2T3V2DQp2T3VUc2V1aG5ldXlpTzJZdUNCOElPeVZuaUEyN0o2UTY2YXNMZXVTcENBMzdKNlE2NmFzSUh3Z01USXpORFUyTFRFeU16UTFOamNnZkEwS2ZDRHNncXpzbDRYc25wRHJrN0hyb1ozcnNvanRtTGdnZkNBeE1PeWVrT3VtckNEdGxaanNuYlR0bElnZ2ZDQXdNUzB5TXpRdE5UWTNPRGtnZkEwS0RRb2pJeU1nN0pPdzY2bTBJT3lWaUNEcmtKanJpcFFnN1pHYzZyaXdEUW9OQ2kwZzY0S2c3S2VjN0plUUlPMlZtT3lkdE8yVWlNSzM2N21YNnJpSU9pRGluWXdnTWpBeU5TMHdNUzB3TVN3Z01ERXZNREVOQ2kwZzdJdWM2ckNFN0plUUlPeVlwT3lnaEMvc21LVHRtNFE2SU9LZGpDRHNtS1Rzb0lRZ01leUxuQ0FxS091THFDd2c3SUtzN0pxcDdKNlE2ckNBSU95bmdleWdrU0RxczZEcnBiVHJpcFFnNjdDcDY2eTR3cmZzbUlqc2xiMGc3SXVjNnJDRTdKMkFJT3lZaU95WnVDa3FEUW9OQ2lvcUtnMEtEUW9qSXlBNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1EwS0RRcnRqSjNzbDRVZzY2eTQ2cldzNjRxVQ0KSUNvcTdKZXQ3WldnS2lvbzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdkNucXM3d2dLaXJzbktEdG1KVXFLaWp0aHJYcnM3UXY3WXlRNjR1b0tleVhrQ0RybExEcm5id2c2Nnk0N0xLMDZyQ0FJT3VMck91ZHZPeWFsQzRnN1lPQTdKMjA3WXVBN0oyRUlPdUxwT3VUck95ZGhDRHJsWkFnNjdDWTY1T2M3SXVjSU95VmlPdUN0Q2pyczdqcnJMZ3A2cm1NN0tlQUlPcXdtZXlkdENEcnM3VHFzNkFzSU91enVPdXN1Q0RycDZYcm5iM3NuWVFnNjR1MDdKV0U3Slc4SU8yVnRPeWFsQzROQ2cwS0l5TWpJRERyaTZqcXM0UWc0b0NVSU8yS3VPdW1yT3F4c091MmdPMkVzQ0RydEpEc21wUU5DZzBLN1l5ZDdKZUY3SjIwSU95Q3JPeWFxZXlla095ZG1DRHNsclRybHFRZzdaYUo2NCtaSU91U3BPeVhrQ0RybktqcmlwVHNwNEFnNjZpODdLQ0FJTzJNak95VmhlMlZ0T3lhbEM0TkNnMEtMU0R0bG9ucmo1bnNuWVFnS2lycXNJRHJvWnpycDRucXNiRHJncGdnN1l5UTY0dW83SjJFSU95YWxPcTFyQ29xS095ZHRPMkQNCmlNSzM3SUt0N0tDY3dyZnJvWnpxdDdqc2xZVHNtNFBDdCt5aWhldWpqQ2tnNG9hU0lDb3E3WXlRNjR1bzdaaVZLaW9nS091c3ZPeVd0T3Uwa095YWxDa05DaTBnNnJLdzZyTzh3cmZzZzRIdGc1enJwYndnS2lydGhyWHJzN1RycDR3cUtpQW83Sm1FNjZPTXdyZnNpNlR0aktncElPS0draUFxS3V5VmlPdUN0TzJZbFNvcUlDanNsWXpyb0tUc3BKanNtcFFwRFFvTkNpTWpJeUR0ZzREc25iVHRpNEFnNG9DVUlPeW5wK3lkZ0NEcnFvWHNncXpxdGF3TkNnMEtMU0RycW9Yc2dxenRtSlhzbkx6cm9ad2c2NEdkNjRLMDdKcVVMaURzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5PdWx2Q0RzazdEc3A0QWc3SldLN0pXRTdKcVVJQ2grN0pxVUlDOGdmdXVMcENBdklIN3F1WXpzbXBRL0lPS2RqQ2t1RFFvdElESitOT3lXdE95Z2lPdWhuQ0RzcDZmcXM2QWc3SW05NnJLTUxpRHRsWnpzbnBEc2xyVEN0K3lJbU95TG5leWRoQ0RxdUxqcXNvd2c3SXlUN0tlQUlPeVZpdXlWaE95YWxDNE5DaTBnN0pXSTY0SzBLT3V6DQp1T3VzdUNrZzY2ZWw2NTI5N0oyRUlPeWFsT3lWdmUyVnRDd2dLaXJ0ZzREc25iVHRpNERycDR3ZzY3U1E2NCtFSU91c3RPeUtxQ0R0akozc2w0WHNuYmpzcDRBcUtpRHNsWXpxc293ZzdaVzA3SnFVTGlEc201RHJzN2pzbmJRZ0oreVZqT3Vtdk1LMzdabVY3SjI0Sit5eW1PdWZ2Q0RycDRuc2w3RHRsWmpycWJRZzY3TzQ2Nnk0N0oyRUlPcTN2T3F4c091aG5DRHF0YXpzc3JUdG1aVHRsYlRzbXBRdURRb05DbndnN0oyMDY2Q0g2cktNSU91bmtPcXpvQ0I4SU95ZHRPdWdoK3F5akNCOERRcDhMUzB0ZkMwdExYd05DbndnN0tDQTdKNmw3WldZN0tlQUlPeVZpdXF6b0NEcmdwanFzSURzaTV6cXNxRHNsclRzbXBRL0lId2c3S0NBN0o2bElPeVZpQ0R0bFp3ZzY0SzA3SnFwSUh3TkNud2c3SldNNjZhOElId2c2ckt3N0tDY0lPeVpoT3VqakNCOERRcDhJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lId2c2NDJ3N0oyMDdZU3dJT3lDcmV5Z25DQjhEUW9OQ2lNakl5RHNsWWpyZ3JRbw0KNjdPNDY2eTRLU0RpZ0pRZzdaVzA3SnFVN0xLMERRb05DaTBnS2lydGpKRHJpNmp0bUpVcUt1eWRnQ0FuZnUyVm9PcTVqT3lhbEQ4bjY2R2NJT3Vzdk95V3RPeWFsQzRnNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzdKeUU3WmVZS095Q3JleWduTUszN1lPSTdZZTBJT3VUc1Nuc25ZQWc2ckt3NnJPODY2VzhJT3Vvdk95Z2dDRHFzcjNxczZEdGxiVHNtcFF1RFFvdElDb3E3SldJNjRLMDdaaVZLaXJzbllBZzdJS3M3SXVrN0oyRUlPeUVuT3lJb08yVnRPeWFsQzROQ2kwZzY2ZUk3TG1vN1pHYzY2VzhJT3lOcU95YWxDNGc3SWlyN0o2UXdyZnNvYkRxc2JRbzdKMjA3SU9Cd3Jmc25iVHRsWmpDdCt5ZHRPdUN0Q0RyazdFcDdKMkFJT3EzdU91TWdPdWhuQ0Rya1pEcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzdKV0s3SldFN0pxVUxnMEtEUW9qSXlNZzY3S0U3WXE4SU9LQWxDRHNsWWpyZ3JRZzY2eTQNCjY2ZWw3SjIwSU95Z2xlMlZ0T3lhbEEwS0RRcDhJT3V6dU91c3VPeWR0Q0RzbmJUcm9JZnJpNlFnZkNEcnNvVHRpcndnZkEwS2ZDMHRMWHd0TFMxOERRcDhJT3F5c09xenZNSzM3SU9CN1lPYzY2VzhJTzJHdGV1enRDQjhJRnZ0bVpYc25iaGRJSHdOQ253Z0ozN3RsYURxdVl6c21wUS9KK3VobkNEcnJMenNuWXdnZkNCYjdKV0U2NHVJN0ppa1hTREN0eUJiNjRTa1hTQjhEUXA4SU95RGdlMlpxU0RzaEp6c2lLQWdLeURzbUtUcnBianNxcjNzbmJRZzdJdWs3S0NjSU91UG1leWVrU0I4SUZ2c3Q2anNob3hkSU1LM0lGdDc2NCtaN0o2UmZWMGdmQTBLRFFvdElDZnN0NmpzaG93bjY0cVVJQ29xNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUtpb2c3STJvN0pxVUlDanNtSWc2SUZ2c3Q2anNob3hkd3JkYjdJS3Q3S0NjWFNrdUlDZnJpNnZxdUxBZ3dyY2c2NCtaN0o2UkoreXltT3VmdkNEc3A1M3NuYlFnN0pXSUlPdW5udXVLbENEc29iRHRsYW5zbmJUcmdwZ2c2NHVvNjQrRklDZnN0NmpzDQpob3duNjRxVUlPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRb3RJT3V5aE8yS3ZPeWRtQ0RyajVuc25wRWc3SjIwNjZhRTdKMkFJTzJabE91cHRDRHF1TERyaXFYcnFvVW82N09BNnJLOXdyZnRsYlRzb0p3ZzY1T3hLZXlkaENEcXQ3anJqSURyb1p3ZzdJSzA2NkNrN0pxVUxnMEtEUW9qSXlNZzdZYTE3S2VjSU95WWlPeUxuQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0oyMDdZT0lLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHNvSURzbnFVZzdKV0lJTzJWbkNEcmdyVHNtcWtOQ2kwZzdKV0k2NEswT2lEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhnN0o2RjY2Q2w3WldjSU91Q3RPeWFxZXlkdENEc2dxenJuYnpzb0xqc21wUXVEUW90SU91eWhPMkt2RG9nN0pXRTY0dUk3SmlrSU1LM0lPdUVwQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0lLdDdLQ2NJQ2pzbklUdGw1Z3BLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHJqYkRzbmJUdGhMQWc3SUt0N0tDY0RRb3RJT3lWaU91Qw0KdERvZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHNnclRycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lLdDdLQ2M3WldnNnJtTTdKcVVQdzBLTFNEcnNvVHRpcnc2SU95VmhPdUxpT3lZcENEQ3R5RHJoS1FOQ2cwS0tpcnJqNW5zbnBIdG1KVWc0b0NVSU95RW5PeUlvQ0FySU91UG1leWVrU0Ryc29UdGlyd3FLZzBLTFNEdGc0RHNuYlR0aTRBNklPcTRzT3E0c0NEc2w3RHFzckFnN1pXMDdLQ2NEUW90SU95VmlPdUN0RG9nN0lTZzdZT2Q3WldjSU9xNHNPcTRzT3lkbUNEc2w3RHFzckRzbllRZzY0R0s3SmEwN0pxVUxnMEtMU0Ryc29UdGlydzZJT3kzcU95R2pDREN0eURzbDdEcXNyQWc3WlcwN0tDY0RRb05DaW9xN0pXSTY0SzA3WmlWSU9LQWxDRHNtWVRybzR3ZzdZYTE2N08wS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURxc3JEc29Kd2c3Sm1FNjZPTURRb3RJT3lWaU91Q3REb2c2ckt3N0tDYzZyQ0FJT3lnbGV5RGdTRHNzcGpycHF6cmtKRHNsclRzbXBRdURRb3RJT3V5aE8yS3ZEb2c3Wm1WN0oyNERRb04NCkNpb3FLZzBLRFFvaklPeVlpT3ladUNEcXQ1enN1WmtOQ2cwSzdKdVE3TG1aS091S3BldVBtY0szNnJpTjdLQ1Z3cmZzdXBEc283enNscndwNjdPMDY0dWtJT3lZaU95WnVPcXdnQ0RyalpRZzY2cUY3Wm1WN1pXY0lPeTdwT3V1cE91TGlPeThnT3lkdE95Rm1PeWRoQ0RycDR6cms1enJpcFFnNnJLOTdKcXc3SmlJN0pxVUxnMEtEUW9qSXlEc21JanNtYmdnTVM0ZzdJaVk2NCtaN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzY1Q1k2NHFVSU9xeXZleWFzQTBLRFFvakl5TWc3SVNjNjdtRTdJcWtJT3lpaGV1ampDd2c2cml3NnJDRUlPdW5qT3VqakEwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95anZPeVd0Q2pzb29Ycm80d2c3SVNjNjdtRTdJcWtMQ0RxdUxEcXNJUWc2NU94S2V1bHZDRHFzSlhzb2JEdGxhQWc3SWlZSU95ZWlPcXpvQ3dnSit5aWhldWpqQ2ZzbVlBZ0ordW5qT3VqakNmc25aZ2c2NG1ZN0pXWjdJcWs2Nlc4SU95Z2xlMlpsZTJlaUNEc29JVHJpNnp0bGFBZzdJaVlJT3llDQppT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0JQVDA4ZzdJU2M2N21FN0lxa0lPeWloZXVqakNEc2xZanJnclFnNG9DVUlEQXc3SnVVSURBdzdKMjg2N2FBN1lTd0lPeUVuT3U1aE95S3BPcXdnQ0Rzb29Ycm80enJqN3pzbXBRdUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZUWc3SldNNjZDazY1T2M2NkNrN0pxVUxnMEtMU0RzbnBEc2dyQWc3S0d3N1pxTUlPcTRzT3F3aE95ZHRDRHFzNmNnNjZlTTY2T002NCs4N0pxVUxnMEtEUXJyaTZnc0lDb3E3S084NnJpdzdLQ0I3Snk4NjZHY0lPeWloZXVqak9xd2dDRHJzSmpyczdYcmtKanJpcFFnN0tDYzdaS0lLaXJzbDVEcmlwUWdKK3lpaGV1ampPdVB2T3lhbENmcnBid2c3Sk93N0tlQUlPeVZpdXlWaE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbUtUcmlwanNuWmdnN1lDMDdLYUk2ckNBSU9xenB5RHNvb1hybzR6cmo3enNtcFFnNG9hU0lPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEEwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0plUQ0KNnJLTUlPdXZ1T3k1bU91S2xDRHNtSUh0bHFYc25ZUWc3SldNNjZDazdLU0VJT3VWakEwS0RRb283S084N0pxVUlPdVBtZXlDckNBNklPeVhzT3l5dEN3ZzdaVzA3S2VBTENEc29JSHNtcWtnNjVPeEtRMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWR1T3F6dkNEcXRJRHFzNFRycGJ3ZzY2cUY3Wm1WN1pXWTZyS01JT3lFcE91cWhlMlZtT3F6b0N3Z0oreUNyT3lhcWV5ZWtPeWRtQ0R0bG9ucmo1bnNsNUFnNjVTdzY1Mjg3SmlrNjRxVUlPcXlzT3F6dkNmcm5ienJpcFFnN0tDUTdKMkVJT3lWak91Z3BPeWtoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lZcE91S21PcTVqT3luZ0NEcmdyVHNwNEFnN0pXSzdKeTg2Nm0wSU95WHNPeXl0T3VQdk95YWxDNGc3WnVFNjdhSTZyS3c3S0NjSU9xNGlPeVZvZXlkaENEcmdyVHNvN3pzaExqc21wUXVEUW90SU91TWdPeTJuT3lkaENEcXNJanNsWVR0ZzREcnFiUWc3SnVRNjU2WUlPdU1nT3kybk95ZHRDRHRsYlRzcDREcmo3enMNCm1wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXaWV5WGtDRHJnclRzbGJ3ZzdaVzA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95VmlPeUxyQ0FvN0lpWTY0K1o3WmlWS1EwS0RRb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3SXVjN0lxazdZV2M3SjIwSU95ZWtPdVBtZXljdk91aG5DRHNzcGpycHF6dGxaenJpNlRyaXBRZzdLQ1FLaXJzbllRZzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95ZHRPeWduT3UyZ08yRXNDRHRtWTNxdUxqcmo1bnJpNWpzblpnZzZyQ2M3SjI0N0tDVjY3TzBJT3lkdE95YXFTRHJnclRzbDYzc25iUWc2cml3NjZHZDY0Kzg3SnFVRFFvdElPdU5sQ0Rzb292c25ZQWc3SU9CNjR1MDdKMkVJT3ljDQpoTzJWdENEdGhyWHRtWlFnNjRLMDdKcXA3SjJBSU91RnVleWRqT3VQdk95YWxBMEtEUW9qSXlEc21JanNtYmdnTWk0ZzZySzk3SmEwNjZXOElPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdEUW9OQ3UyS3VleWdsU0RzZzRIdG1hbnNsNURzaEp3ZzdLQ2M3WldjN0tDQjdKeTg2NkdjSUNmc2k1enJncGpzbXBRL0xDRHNoYWpyZ3Bqc21wUS9KeURzblpqcnJManRtSlVnN0phMDY2KzQ2Nlc4SU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0oyWUlPdW5wZXVkdmV5ZGhDRHRtWnpzbXFudGxiVHNoSndnN0tlSTY2eTQ3WldnSU91VmpBMEtEUW9uN0l1YzY0S1k3SnFVUHljc0lDZnNoYWpyZ3Bqc21wUS9KeUR0bUpYdGc1enNuWmdnNnJLOTdKYTA2Nlc4SU8yWm5PeWFxZTJWdE95RW5DRHNncXpzbXFuc25wRHNuWmdnNjR1NTdabXA3SXFrNjUrczdKdUE3SjJFSU95a2hPeWR2Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbUN3Zw0KVDA5UElPdUxwT3VGZ095WXBPeUZxT3VDbU95YWxEOE5DaTBnN0xhcDdLQ0U3WldZNjUrc0lPMk91T3lkbU95Z2tDRHFzSURzaTV6cmdwanNtcFEvRFFvTkNpTWpJeURzZ3F6c21xbnNucERzblpnZzdJT0I3Wm1wN0oyRUlPeTJsT3lnbGUyVm9DRHJsWXdOQ2cwSzY2cUY3Wm1WN1pXY0lPeWdsZXV6dE9xd2dDRHNsNGJzbHJUc2hKd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeW5nZXlna1NEdGpKRHJpNmp0bFpqcXNvd2c3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzdWJUcms1enJwYndnNjdDYjdKeTg3SVdvNjRLWTdKcVVQeURyazdIcm9aM3RsWmpycWJRZzdMcVE3SXVjNjdDeElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwS0l5TWpJT3lDck95YXFleWVrT3lkbUNEc2hLRHNuWmpxc0lBZzdaV0U3SnFVN1pXZ0lPdVZqQTBLRFFyc2hLVHINCnJManNvYkRzZ3F6c3NwanJuN3dnN0lLczdKcXA3SjZRN0oyWUlPeUVvT3lkbU91bHZDRHF1TERyaklEdGxiVHNsYndnN1pXZ0lPdVZqQ0Rxc3Izc2xyVHJvWndnN0tDVjdLU1I3WldZNnJLTUlPeW5pT3VzdU8yVnRPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25iVHJzb2dnNjR1czdKZVFJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bFpqcnFiVHNoSndnN0phODY2ZUk2NEtZSU91bmpPeWhzZTJWbU95RnFPdUNtT3lhbEQ4TkNnMEtJeU1nN0ppSTdKbTRJRE11SU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU91UW1PdUtsQ0Rxc3Izc21yQU5DZzBLN0lLczdKcXA3SjZRN0plUTZyS01JT3VxaGUyWmxlMlZtT3F5akNEcnRvRHNvSlhzb0lIc25iZ2c2NEswN0pxcDdKMkVJT3lWak91Z3BPeWttT3lWdkNEdGxhQWc2NVdNNjRxVUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPeWlpK3lWaE95YWxDNE5DZzBLSXlNaklPeUVuT3U1aE95S3BPdWx2Q0Rzb0pYc3NZWHNnNEVnDQo3Sk80SU95SW1DRHNsNGJzbllRZzY1V01EUW9OQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeURnZTJacWV5ZGhDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3SXVjN1lLc0lPeUltQ0Rzbm9qc2xyVHNtcFF1SUNvcTdKTzRJT3lJbUNEc2w0YnJpcFFnN0oyMDdKeWc2Nlc4SU8yVnFPcTdtQ0RzbFlqcmdyVHRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNwNERxdUlqc25ZQWc2ckNBN0o2RjdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlPeXlyZXlHak91RmhPeWRoQ0RzbklUdGxad2c3SVNjNjdtRTdJcWs2NHFVSU95VmhPeW5nU0RzcElEcnVZUWc3S1NSN0oyMDdKZVE3SnFVTGcwS0xTRHFzN1hyckxUc201RHNuWUFnN1p1RTdKdVE2cmlJN0oyRUlPdXp0T3VDdkNEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SjI4NjdhQUlPcTRzT3VLcGV1bmpDRHNrN2dnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLNjdhQTdLQ1Y3WmlWN0p5OA0KNjZHY0lPeU5xT3lWdkNEc2dxenNtcW5zbnBEcXNJQWc3SmEwNjVha0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeVhodXVLbE95bmdDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3WldnSU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlFJT3lFb08yRG5leWRtQ0Rxc3JEcXM3enJwYndnN0pXSTY0SzA3WldnSU91VmpBMEtEUXJya0pqcmo0enJwclFnN0lpWUlPeVhodXVLbENEc2hLRHRnNTNzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJWbU9xeWpDRHNsWXpyb0tUc21wUXVEUW9OQ3V5WWlDa05DaTBnN1pXY0lPdXkNCmlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrTkNnMEtKK3lnbGV1enRDRHNpSmpzcDVFZzdKV0k2NEswSnlEcms3SHNuWmdnNjYrODZyQ1E3WldjSU95RGdlMlpxZXlYa095RW5DQXFLdXlnbGV1enRPcXdnQ0RyczdUdG1ManJrSnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeURnZXVMdE95ZHRDRHJnWjNyZ3BqcnFiUWc3S0NFNjZ5NDZyQ0E2NCtFSU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHJwYndnNjdPOElPeUltQ0RzbDRic2xyVHNtcFF1RFFvdElPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1Rxc0lBZzZyaXc2NkdkNjVDWTdLZUFJT3lWDQppdXlWaE95YWxDNE5DZzBLSXlNZzdKaUk3Sm00SURRdUlPeWduTzJTaUNEc21xbnNsclRyaXBRZzY3Q1U2cjY0N0tlQUlPeVZpdXE0c0EwS0RRb242ckNFNnJLdzdaV1k2ck9nSU95SnJPeWF0Q0RycDVBbklPeWJrT3k1bWV1enRPdUxwQ0FxS3UyWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhlcXp2T3lkbUNEc21xbnNsclFnN0oyODdMbVlLaXJxc0lBZzdKcXc3SVNnN0oyMDdKZVE3SnFVTGcwSzZyaXc2NHFsNjZxRjdKZVFJT3lUc095ZHVDRHJpNmpzbHJRbzY3T0E2cks5TENEc3A0RHNvSlVzSU91VHNldWhuU0RyazdFcDY2VzhJT3lWaU91Q3RDRHJyTGpxdGF6c2w1RHNoSndnNjR1azY2VzRJT3Vua091aG5DRHJzSlRxdnJqcnFiUWc3SUtzN0pxcDdKNlE2ckNBSU91THBPdWx1Q0RxdUxEcmlxWHNuTHpyb1p3ZzdKaWs3WlcwN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tnSitxMmpPMlZuQ0RyczREcXNyMG5JT3E0c091S3BleWRtQ0RzbFlqcmdyUWc2Nnk0NnJXcw0KRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3Q1U2citBSU95SW1DRHNub2pzbHJUc21wUWdLRmdwRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3T0E2cks5N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSU95WWlPeVp1Q0ExTGlEc2k1enNpcVR0aFp3ZzY0K1o3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXdnN0pPdzdLZUFJT3lWaXVxNHNBMEtEUXJyckxqcXRhenJwYndnN0pXRTY2eTA2NmFzSU91bnBPdUJoT3VmdmVxeWpDRHJpNlRyazZ6c2xyVHJqNFFnS2lyc2k2VHNvSndnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NLaXJycGJ3ZzdKT3c2Nm0wSU95ZW1PdXF1K3VRbkNEcnJManF0YXpzbUlqc21wUXVEUW9OQ3V5WWlDa2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWUNCmtPdWx2Q0FuN0xhVTZyQ0FJT3luZ095Z2xTZnRsWmpyaXBRZzdJdWM3SXFrN1lXYzdKZVE3SVNjSUNqc25iVHNvSVRDdCt5V2tldVBoQ0RxdUxEcmlxWHNuYlFnN0pXRTY0dVlLUTBLTFNEcmk2VHJwYmdnN0lLczY1Nk03SmVRNnJLTUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJwYndnNjRTWTZyS283S084N0lTNDdKcVVJQ2hZSU9LQWxDRHNsNGJyaXBRZ0ordUVtT3E0c09xNHNDY2c2cml3NjRxbDdKMkVJT3lWbE95TG5Da05DaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVnRDRHNvN3pzaExqc21wUWdLRThwRFFvPQ0KOjpMQVVOQ0hFUjo6DQovLzRuQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJDQUhJQWFRQmtBR2NBWlFBZ0FHd0FZUUIxQUc0QVl3Qm9BR1VBY2dBZ0FCUWdJQURvc3NTc3hMd2dBQ1RCRmNnZ0FCRElnS3dnQU1UV0lBRGtzcXk1SUFEa3dvblZDZ0FuQUNBQVl3QnNBR0VBZFFCa0FHVUFZZ0J5QUdrQVpBQm5BR1VBT2dBdkFDOEFJQUFFMVZ5NG9ORmN6M1RISUFCMHh5QUFETk44eDBUSElBQ0F2WGk1NUxJZ0FDZ0E4YlJkdURvQUlBQnVBSEFBYlFBZ0FHa0FiZ0J6QUhRQVlRQnNBR3dBSUFBUXRwU3lJQUFpQUhUUVhMamN0Q0FBNU00bHNURFJJZ0FnQUNUQldNNGdBQXpUZk1jcEFDNEFDZ0FuQUNBQVZMc0FyQ0FBWUw0NHlDQUFpTWM4eDNTNklBQmMxU0FBaUx6UXhTQUFXTldZc0NuRklBQkl4YlN3V05YZ3JDd0FJQURrc2lBQUFNbEV2aGkwZExvZ0FPU3lyTGw4dVNBQVBjd2dBTWJGZE1jZ0FPVENpZFZjMWVTeUxnQUtBRk1BWlFCMEFDQUFaZ0J6QUc4QUlBQTlBQ0FBUXdCeUFHVUFZUUIwQUdVQVR3QmlBR29BWlFCakFIUUFLQUFpQUZNQQ0KWXdCeUFHa0FjQUIwQUdrQWJnQm5BQzRBUmdCcEFHd0FaUUJUQUhrQWN3QjBBR1VBYlFCUEFHSUFhZ0JsQUdNQWRBQWlBQ2tBQ2dCVEFHVUFkQUFnQUhNQWFBQWdBRDBBSUFCREFISUFaUUJoQUhRQVpRQlBBR0lBYWdCbEFHTUFkQUFvQUNJQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZNQWFBQmxBR3dBYkFBaUFDa0FDZ0JrQUdrQWNnQWdBRDBBSUFCbUFITUFid0F1QUVjQVpRQjBBRkFBWVFCeUFHVUFiZ0IwQUVZQWJ3QnNBR1FBWlFCeUFFNEFZUUJ0QUdVQUtBQlhBRk1BWXdCeUFHa0FjQUIwQUM0QVV3QmpBSElBYVFCd0FIUUFSZ0IxQUd3QWJBQk9BR0VBYlFCbEFDa0FDZ0J6QUdnQUxnQkRBSFVBY2dCeUFHVUFiZ0IwQUVRQWFRQnlBR1VBWXdCMEFHOEFjZ0I1QUNBQVBRQWdBR1FBYVFCeUFBb0FDZ0FuQUNBQU1RQXZBRElBS1FBZ0FFNEFid0JrQUdVQUxnQnFBSE1BSUFBUXlJQ3NJQUFVSUNBQXhzVTh4M1M2SUFEa3NyVEdYTGpjdENBQW1OTjB4OERKZkxrZ0FQVEZ0TVVBeWVTeUNnQkpBR1lBSUFCekFHZ0ENCkxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BSUFCM0FHZ0FaUUJ5QUdVQUlBQnVBRzhBWkFCbEFDSUFMQUFnQURBQUxBQWdBRlFBY2dCMUFHVUFLUUFnQUR3QVBnQWdBREFBSUFCVUFHZ0FaUUJ1QUFvQUlBQWdBRWtBWmdBZ0FFMEFjd0JuQUVJQWJ3QjRBQ2dBSWdCT0FHOEFaQUJsQUM0QWFnQnpBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0JiQUZYV2VNZGRBRVRISUFBRXNuUzVkTG9nQU9TeXRNWmN1TnkwSUFDWTAzVEh3TWtBckNBQTlNVzl1Y2l5NUxJdUFDQUFKTUZZem55NUlBREl1VnpPSUFDa3RDd0FJQUFNMWV5MytLMTR4OURGSE1FZ0FIVFFYTGpjdENBQWhMeTgwa1RISUFEa3N0ekNJQUFNc3V5M0lBRDh5RGpCbE1ZdUFDSUFMQUFnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBDQpJQUIyQUdJQVR3QkxBRU1BWVFCdUFHTUFaUUJzQUNBQUt3QWdBSFlBWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BREVBTHdBeUFDa0FJQUFVSUNBQVRnQnZBR1FBWlFBdUFHb0Fjd0FpQUNrQUlBQTlBQ0FBZGdCaUFFOEFTd0FnQUZRQWFBQmxBRzRBQ2dBZ0FDQUFJQUFnQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JvQUhRQWRBQndBSE1BT2dBdkFDOEFiZ0J2QUdRQVpRQnFBSE1BTGdCdkFISUFad0F2QUdzQWJ3QXZBR1FBYndCM0FHNEFiQUJ2QUdFQVpBQWlBQW9BSUFBZ0FFVUFiZ0JrQUNBQVNRQm1BQW9BSUFBZ0FGY0FVd0JqQUhJQWFRQndBSFFBTGdCUkFIVUFhUUIwQUFvQVJRQnVBR1FBSUFCSkFHWUFDZ0FLQUNjQUlBQXlBQzhBTWdBcEFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNBQUVNaUFyQ0FBRkNBZ0FNYkZQTWQwdWlBQUpNRll6cmNBWExqNHJYakhJQUFwdkpXOFJNY2dBRWpGdExCYzFlU3lDZ0JKQUdZQQ0KSUFCekFHZ0FMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQUlBQjNBR2dBWlFCeUFHVUFJQUJqQUd3QVlRQjFBR1FBWlFBaUFDd0FJQUF3QUN3QUlBQlVBSElBZFFCbEFDa0FJQUE4QUQ0QUlBQXdBQ0FBVkFCb0FHVUFiZ0FLQUNBQUlBQk5BSE1BWndCQ0FHOEFlQUFnQUNJQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpQUFLQUFRdHBTeUlBQlFBRUVBVkFCSUFOREZJQURHeGJURmxNWXBBQzRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQXcwZmk3RUxIUXhSekJJQUJFeFppM2ZMa2dBQ1RCV002M0FGeTQrSzE0eDF6VklBQ2t0Q3dBSUFCMDBGeTQzTFFnQUlTOHZOSkV4eUFBNUxMY3dpQUFETExzdHlBQS9NZzR3WlRHT2dBaUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUENCkpnQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBaUFDQUFJQUJ1QUhBQWJRQWdBR2tBYmdCekFIUUFZUUJzQUd3QUlBQXRBR2NBSUFCQUFHRUFiZ0IwQUdnQWNnQnZBSEFBYVFCakFDMEFZUUJwQUM4QVl3QnNBR0VBZFFCa0FHVUFMUUJqQUc4QVpBQmxBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUlBQWdBR01BYkFCaEFIVUFaQUJsQUNBQWJBQnZBR2NBYVFCdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBVmRaNHh5QUFLYnlWdkRvQUlBQXcwZmk3RUxIUXhSekJJQUJqQUd3QVlRQjFBR1FBWlFBZ0FDMEFMUUIyQUdVQWNnQnpBR2tBYndCdUFDQUFkTWNnQUlTOEJNaEV4eUFBbk0wbHVGalZkTG9nQUFESlJMNGdBRVRHekxpRng4aXk1TEl1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBDQpYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUtBQ3N3S25HeWJkQXh5QUFkTWNnQUZBQVF3RFF4U0FBWExqNHJYakhITFFnQUhUUVhMamN0Q0FBYkszRnN5QUFYTlhFczlERkhNRWdBQ2pNRUt3cHRNaXk1TEl1QUNrQUlnQXNBQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FIWUFZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FESUFMd0F5QUNrQUlBQVVJQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDSUFDZ0FnQUNBQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZFQWRRQnBBSFFBQ2dCRkFHNEFaQUFnQUVrQVpnQUtBQW9BSndBZ0FBREpSTDRnQUVUR3pMZ2dBQlFnSUFEa3NxeTVmTGtnQUQzTUlBREd4WFRISUFEa3dvblZJQUFvQUF6VjdMZjRyWGpIZE1jZ0FPZXNJQUNReDlteklBQVFyTURKS1FBS0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCakFHMEFaQUFnQUM4QVl3QWdBRzRBYndCa0FHVUFJQUJ6QUdNQQ0KY2dCcEFIQUFkQUJ6QUZ3QVl3QnNBR0VBZFFCa0FHVUFMUUJpQUhJQWFRQmtBR2NBWlFBdUFHb0Fjd0FpQUN3QUlBQXdBQ3dBSUFCR0FHRUFiQUJ6QUdVQUNnQT0NCjo6V0FUQ0hFUjo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rxc0pEc2k1enNucEFnNG9DVUlPMlZyZXlEZ1NEcmxxQWc3SjZJNjRxVUlPeTBpT3lHak8yWWxTRHNoSnpyc29RZ0tHeHZZMkZzYUc5emREb3hNVGc0T1NrTkNpOHZJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0EwS0x5OGc3Sm1jSU8yVmhPeWFsTzJWbk9xd2dEb2c3WlM4NnJlNDY2ZUk2ckNBSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JqYkdGMVpHVmljbWxrWjJVNkx5OGc3SmUwNnJpd0tIZHBibVJ2ZHk1dmNHVnVMMmxtY21GdFpTOXZjR1Z1UlhoMFpYSnVZV3dwNjZXOA0KRFFvdkx5RHNvSVRydG9BZzdJYU02NmFzSU95WGh1eWR0Q0RycDRucmlwUWc2N0tFN0tDRTdKMjBJT3llaU91THBDNGdabVYwWTJqcmlwUWc2NnE3SU91bmlleWN2T3V2Z091aG5Dd2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPeWR0Q0Rxc0pEc2k1enNucERzbDVEcXNvd05DaTh2SUZCUFUxUWdMM2RoYTJVZzY2VzhJT3V6dE91Q3RPdXB0Q0Rxc0pEc2k1enNucERxc0lBZzY0dWs2NmFzS0dOc1lYVmtaUzFpY21sa1oyVXVhbk1wNjZXOElPdU1nT3lMb0NEc3ZLRHJpNlF1RFFvdkx3MEtMeThnNjR1azY2YXM3Sm1BN0oyWUlPeXdxT3lkdERvZzZyQ1E3SXVjN0o2UTY0cVVJR05zWVhWa1pldWx2Q0Ryckx6c3A0QWc3SldLNjRxVTY0dWtLT3lla095TG5TRHNsNGJzbll3cElPS0draUR0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3VsdkNEc2xZZ2c2NmVKNnJPZ0xBMEtMeThnNjZtVTY2cW82NmFzSUg0eE5VMUM2NTI4SU91aG5PcTN1T3lkdUNEc2k1d2c3SjZRNjQrWklPeUxuT3lla2V5Y3ZPdWgNCm5DRHNnNEhzaTV3ZzdMeWM2NUdzNjQrRUlPdTJnT3VMdENEc2w0YnJpNlFnS091VHNldWhuVG9nYm5CdElISjFiaUJpZFdsc1pDa3VEUW92THlEcmk2VHJwcXpyaXBRZzdJdXM3SjZsNjdDVjY0K1pJT3VCaXVxNHNPdXB0Q0Rzbzczc3A0RHJwNHdvN1pTTTY1K3M2cmU0N0oyNDZyTzhJT3lEbmV5Q3JDRHJqNW5xdUxEdG1aUXBMQ0Rxc0pEc2k1enNucERyaXBRZzZyT0U3SWFOSU91Q3FPeVZoQ0RyaTZUc25Zd2c2cm1vN0pxdzZyaXc2Nlc4SU91d20rdUtsT3VMcEM0TkNnMEtZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNOQ21OdmJuTjBJSEJoZEdnZ1BTQnlaWEYxYVhKbEtDZHdZWFJvSnlrN0RRcGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0RRcGpiMjV6ZENCdmN5QTlJSEpsY1hWcGNtVW9KMjl6SnlrN0RRcGpiMjV6ZENCN0lITndZWGR1TENCemNHRjNibE41Ym1NZ2ZTQTlJSEpsY1hWcGNtVW9KMk5vYVd4a1gzQnliMk5sYzNNbktUc05DZzBLWTI5dWMzUWdVRTlTDQpWQ0E5SURFeE9EZzVPdzBLWTI5dWMzUWdVazlQVkNBOUlIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljcE95QXZMeURzb0lEc25xWHNob3dnNjZPbzdZcTRJT0tBbENEcmk2VHJwcXpxc0lBZ2NtVmpiMjF0Wlc1a0xXVjRZVzF3YkdWekxtMWs2Nlc4SU95d3Z1dUtsQ0RxdUxEc3BJQU5DZzBLWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3MEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0U0dWaFpHVnljeWM2SUNkRGIyNTBaVzUwTFZSNWNHVW5MQTBLZlRzTkNtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXcwS0lDQnlaWE11ZDNKcGRHVklaV0ZrS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MA0KWlc1MExWUjVjR1VuT2lBbllYQndiR2xqWVhScGIyNHZhbk52YmpzZ1kyaGhjbk5sZEQxMWRHWXRPQ2NnZlN3Z1EwOVNVMTlJUlVGRVJWSlRLU2s3RFFvZ0lISmxjeTVsYm1Rb1NsTlBUaTV6ZEhKcGJtZHBabmtvYjJKcUtTazdEUXA5RFFvTkNpOHZJR05zWVhWa1pTQkRURW5xc0lBZzdKNkk2NHFVN0tlQUlPS0FsQ0RzbDRic25MenJxYlFnTDNkaGEyVWc3SjJSNjR1MTdKZVFJT3lMcE95V3RDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdKV0k2NEswN1pXZ0lPeUltQ0Rzbm9qcXNvd2c3WldjNjR1a0RRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU95ZHZlcTRzQ0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOeklDanJpNlRycHF6c25aZ2dZMnhoZFdSbFFXTmpiM1Z1ZE95WmdDRHFzSm5zbllBZzdMYWM3TEtZS1M0TkNpOHZJTzJNak95ZHZPeWR0Q0R0Z2JRZzdJaVlJT3llaU95V3RDQXoNCk1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLTHk4ZzdMcVE3SXVjSURYc3RJZ2c0b0NVSU91aG5PcTN1T3lkdUNEc3A0SHRtNFFnN0lPSUlPcXpoT3lnbGV5ZHRDRHFzNmZyc0pUcm9ad2c3SjZoN1ppQTdKVzhJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKZVE3SVNjSU8yWmlPeWN2T3VobkNEcmhKanNsclRxc0lUcmk2UW9NekRzdElqcnFiUWc2NFNJNjZ5MElPdUtwdXlkakNrTkNteGxkQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lBd0xDQmxiV0ZwYkRvZ2JuVnNiQ0I5T3cwS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzTkNpQWdhV1lnS0VSaGRHVXVibTkzS0NrZ0xTQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BDQTFNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzDQpPdzBLSUNCc1pYUWdaVzFoYVd3Z1BTQnVkV3hzT3cwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTNXFjMjl1Snlrc0lDZDFkR1k0SnlrcE93MEtJQ0FnSUdWdFlXbHNJRDBnS0dvZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpLU0I4ZkNCdWRXeHNPdzBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcm9aenF0N2pzbmJnZzdKMjA2NkNsSU95WGh1eWRqQ0RyazdFZzRvQ1VJRzUxYkd3Z0tpOGdmUTBLSUNCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQkVZWFJsTG01dmR5Z3BMQ0JsYldGcGJDQjlPdzBLSUNCeVpYUjFjbTRnWlcxaGFXdzdEUXA5RFFvTkNtWjFibU4wYVc5dUlHaGhjME5zWVhWa1pTZ3BJSHNOQ2lBZ1kyOXVjM1FnWm1sdVpHVnlJRDBnY0hKdlkyVnpjeTV3YkdGMA0KWm05eWJTQTlQVDBnSjNkcGJqTXlKeUEvSUNkM2FHVnlaU2NnT2lBbmQyaHBZMmduT3cwS0lDQjBjbmtnZXlCeVpYUjFjbTRnYzNCaGQyNVRlVzVqS0dacGJtUmxjaXdnV3lkamJHRjFaR1VuWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lITm9aV3hzT2lCMGNuVmxJSDBwTG5OMFlYUjFjeUE5UFQwZ01Ec2dmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVjBkWEp1SUdaaGJITmxPeUI5RFFwOURRb05DbXhsZENCM1lXdHBibWNnUFNCbVlXeHpaVHNnTHk4ZzdKZXc3WU9BSU91d3FleW5nQ0RpZ0pRZzY0dWs2NmFzNjRxVUlPeVd0T3l3cU8yVXZDQkZRVVJFVWtsT1ZWTkY2NkdjSU95a2tldXp0U0Rzb0pYcnBxenRsWmpzcDREcnA0d2c3WlNFNjZHYzdJUzQ3SXFrSU91Q3JldTVoT3VsdkNEc3BJVHNuYmpyaTZRTkNtWjFibU4wYVc5dUlIZGhhMlZDY21sa1oyVW9LU0I3RFFvZ0lHbG1JQ2gzWVd0cGJtY3BJSEpsZEhWeWJqc05DaUFnZDJGcmFXNW5JRDBnZEhKMVpUc05DaUFnYzJWMFZHbHRaVzkxZENnb0tTQTkNClBpQjdJSGRoYTJsdVp5QTlJR1poYkhObE95QjlMQ0ExTURBd0tUc05DaUFnYkdWMElIQnliMk03RFFvZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2dJQ0FnTHk4Z1YybHVaRzkzY3pvZ1kyMWt3cmQyWW5NZzZySzk3SnlnSU95WGh1eWR0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTd2dkMmx1Wkc5M2MwaHBaR1VvUTFKRlFWUkZYMDVQWDFkSlRrUlBWeW5yb1p3ZzdJcWs3WSt3SU9LQWxBMEtJQ0FnSUM4dklPeXd2U0RzbDRicmlwUWc3SWlvN0oyQUlPeTltT3lHbE95ZHRDRHJwNHpyazZUc2xyVHNwNERxczZBZzY0dWs2NmFzN0oyWUlPeWVrT3lMblNoamJHRjFaR1VwNjQrRUlPcTN1Q0Rzdlpqc2hwVHNuWVFnNjZ5ODY2Q2s2N0NiN0pXRUlPeVd0T3VXcENEc3NMM3JqNFFnN0pXSUlPdWNyT3VMcEM0TkNpQWdJQ0F2THlCa1pYUmhZMmhsWk91S2xDRHNrN0RzcDRBZzdKV0s2NHFVNjR1a0tHUmxkR0ZqYUdWa0szZHBibVJ2ZDNOSWFXUmxJT3loc08yVnFleWRnQ0RzDQp2WmpzaHBRZzdMQzk3SjIwSU91RnVPeTJuT3VRcUNEaWdKUWc3SXVrN0xpaEtTNE5DaUFnSUNBdkx5QlhhVzVrYjNkejdKZVE3SVNnSUdSbGRHRmphR1ZrSU95WGh1eWR0T3VQaENEcnRvRHJxcWdvNnJDUTdJdWM3SjZRS2Vxd2dDRHNvNzNzbHJUcmo0UWc3SjZRN0l1ZDdKMkFJT3lDdE95VmhPdUNxT3VLbE91THBDNE5DaUFnSUNCd2NtOWpJRDBnYzNCaGQyNG9jSEp2WTJWemN5NWxlR1ZqVUdGMGFDd2dXM0JoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNkamJHRjFaR1V0WW5KcFpHZGxMbXB6SnlsZExDQjdEUW9nSUNBZ0lDQmpkMlE2SUZKUFQxUXNJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVXNEUW9nSUNBZ2ZTazdEUW9nSUgwZ1pXeHpaU0I3RFFvZ0lDQWdMeThnYldGalQxTXY2NmFzNjRpRjdJcWtPaURxc0pEc2k1enNucERycGJ3ZzY1MkU3SnEwSUc1dlpHVWc3SXVrN1phSklPMk1qT3lkdk91aG5DRHNwNEhzb0pFZzdJcWs3WSt3SUNoc1lYVnVZMmhrSU8yWg0KbU9xeXZleVhsQ0JRUVZSSTZyQ0FJT3U1aU95VnZlMlZvQ0RzaUpnZzdKNkk3SmEwSU95Z2lPdU1nT3F5dmV1aG5DRHNncXpzbXFrcERRb2dJQ0FnY0hKdll5QTlJSE53WVhkdUtIQnliMk5sYzNNdVpYaGxZMUJoZEdnc0lGdHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTNXFjeWNwWFN3Z2V3MEtJQ0FnSUNBZ1kzZGtPaUJTVDA5VUxDQmtaWFJoWTJobFpEb2dkSEoxWlN3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTEEwS0lDQWdJSDBwT3cwS0lDQjlEUW9nSUhCeWIyTXVkVzV5WldZb0tUc2dMeThnNnJDUTdJdWM3SjZRSU95ZHRPdXlwTzJLdUNEcm82anRsSVRzbDVEc2hKd2c2N2FFNjZhc0lDanFzSkRzaTV6c25wQWc3S0tGNjZPTTY2VzhJT3VuaWV5bmdDRHNsWXJxc293cERRcDlEUW9OQ2k4dklPeWR0Q0JRUSt1bHZDQW43SVNrN0xtWUlPeWdoQ2pzZzRnZ1VFTXBKeURzZzRIdGc1enJvWndnNjVDWTY0K002NmF3NjR1a0lPS0FsQ0R0bEl6cm42enF0N2pzbmJnZ1creTANCmlPcTRzTzJabEYwZzY3S0U3WXE4S0ZCUFUxUWdMM1Z1YVc1emRHRnNiQ25zbmJRZzY3YUE2Nlc0NjR1a0xnMEtMeThnY21WbmFYTjBaWEl0Y0hKdmRHOWpiMnd1YW5QcXNJQWc3SVNrN0xtWTdaV2NJT3F5Zyt5ZGhDRHF0N2pyaklEcm9ad2c2NUNZNjQrTTY2YXc2NHVrT2lEcXNKRHNpNXpzbnBBZzdKNlE2NCtaN0l1YzdKNlJJQ3NnS095ZWlPeWN2T3VwdENrZzdJU2s3TG1ZSU8yUHRPdU5sQzROQ2k4dklPS2FvTys0anlEcnNKanJrNXpzaTV3Z1NGUlVVQ0RzblpIcmk3WHNuWVFnNjZpODdLQ0FJT3V6dE91Q3VDRHJrcVFnN1ppNDdMYWM3WldnSU9xeWd5RGlnSlFnYldGalQxTWdiR0YxYm1Ob1kzUnNJR0p2YjNSdmRYVHNuYlFnN0oyMElPMlVoT3Vobk95RXVPeUtwT3VsdkNEc3BvbnNpNXdnN0tLRjY2T003SXVjN1lLc0lPeUltQ0Rzbm9qcmk2UXVEUW92THlBZ0lDRHF0N2pybnBqc2hKd2c3WXlNN0oyOEtIQnNhWE4wd3Jmc2hLVHN1WmdnN1krMDY0MlVLZXlkaENCc1lYVnVZMmhqZEd6cnM3VHJpNlFnDQo2Nmk4N0tDQUlPeW5nT3lhdE91THBDRGlnSlFnWW05dmRHOTFkT3lkdENEc21yRHJwcXpycGJ3ZzdLTzk3SmVzNjQrRUlPeWVrT3VQbWV5TG5PeWVrZXlkZ0NEc25iVHJyN2dnN0lLczY1Mjg3S2VFNjR1a0xnMEtablZ1WTNScGIyNGdkVzVwYm5OMFlXeHNVMlZzWmlncElIc05DaUFnWTI5dWMzUWdjbVZ0YjNabFpDQTlJRnRkT3cwS0lDQjBjbmtnZXcwS0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5aR0Z5ZDJsdUp5a2dldzBLSUNBZ0lDQWdZMjl1YzNRZ1RFRkNSVXdnUFNBblkyOXRMbU5zWVhWa1pXSnlhV1JuWlM1M1lYUmphR1Z5SnpzTkNpQWdJQ0FnSUdOdmJuTjBJSEJzYVhOMElEMGdjR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0oweHBZbkpoY25rbkxDQW5UR0YxYm1Ob1FXZGxiblJ6Snl3Z1RFRkNSVXdnS3lBbkxuQnNhWE4wSnlrN0RRb2dJQ0FnSUNCamIyNXpkQ0JwYm5OMElEMGdjR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0oweHBZbkpoY25rbg0KTENBblFYQndiR2xqWVhScGIyNGdVM1Z3Y0c5eWRDY3NJQ2REYkdGMVpHVkNjbWxrWjJVbktUc05DaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0hCc2FYTjBLU2tnZXlCbWN5NTFibXhwYm10VGVXNWpLSEJzYVhOMEtUc2djbVZ0YjNabFpDNXdkWE5vS0hCc2FYTjBLVHNnZlNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWdmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNpQWdJQ0FnSUhSeWVTQjdJSE53WVhkdVUzbHVZeWduYkdGMWJtTm9ZM1JzSnl3Z1d5ZGliMjkwYjNWMEp5d2dKMmQxYVM4bklDc2djSEp2WTJWemN5NW5aWFIxYVdRb0tTQXJJQ2N2SnlBcklFeEJRa1ZNWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazcNCklIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2RzWVhWdVkyaGpkR3duTENCYkozSmxiVzkyWlNjc0lFeEJRa1ZNWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dldzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1RXbGpjbTl6YjJaMFhGeFhhVzVrYjNkelhGeERkWEp5Wlc1MFZtVnljMmx2Ymx4Y1VuVnVKeXdnSnk5Mkp5d2dKME5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWEluTENBbkwyWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lISmxiVzkyWldRdWNIVnphQ2duN0o2UTY0K1o3SXVjN0o2UktFTnNZWFZrWlVKeWFXUm5aVmRoZEdOb1pYSXBKeWs3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLDQpJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0NkeVpXY25MQ0JiSjJSbGJHVjBaU2NzSUNkSVMwTlZYRnhUYjJaMGQyRnlaVnhjUTJ4aGMzTmxjMXhjWTJ4aGRXUmxZbkpwWkdkbEp5d2dKeTltSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPeUJ5WlcxdmRtVmtMbkIxYzJnb0oyTnNZWFZrWldKeWFXUm5aVG92THlEcms3SHJvWjBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdJQ0IwY25rZ2V3MEtJQ0FnSUNBZ0lDQmpiMjV6ZENCcGJuTjBJRDBnY0dGMGFDNXFiMmx1S0hCeWIyTmxjM011Wlc1MkxreFBRMEZNUVZCUVJFRlVRU0I4ZkNCd1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuUVhCd1JHRjBZU2NzSUNkTWIyTmhiQ2NwTENBblEyeGhkV1JsUW5KcFpHZGxKeWs3RFFvZ0lDQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZw0KZlNrN0lISmxiVzkyWldRdWNIVnphQ2hwYm5OMEtUc2dmUTBLSUNBZ0lDQWdmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnZlEwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpQm1ZV2xzTFhOdlpuUWc0b0NVSU91cXV5RHNwNERzbXJRZzZyS01JT3llaU95V3RPdVBoQ0R0bEl6cm42enF0N2pzbmJnZzdLcTlJT3E0c095V3RTRHNncTNzb0p6cmlwUWc3SjIwNjYrNElPdUJuZXVDck91THBDQXFMeUI5RFFvZ0lISmxkSFZ5YmlCeVpXMXZkbVZrT3cwS2ZRMEtEUW92THlEcmk2VHJwcXdvTVRFNE9EZ3A2ckNBSU91V29DRHNub2pzbkx6cnFiUWc2NEdJNjR1a0lPS0FsQ0RzdElqcXVMRHRtWlFnN0l1Y0lPdUNxT3lkZ0NEc2hManNoWmdnN0tDVjY2YXNJQ2pzbDRic25MenJxYlFnN0tHdzdKcXA3WjZJSU95THBPMk1xQ2tOQ21aMWJtTjBhVzl1SUhOb2RYUmtiM2R1UW5KcFpHZGxLQ2tnZXcwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElISWdQU0JvZEhSd0xuSmxjWFZsYzNRb2V5Qm9iM04wT2lBbk1USTMNCkxqQXVNQzR4Snl3Z2NHOXlkRG9nTVRFNE9EZ3NJSEJoZEdnNklDY3ZjMmgxZEdSdmQyNG5MQ0J0WlhSb2IyUTZJQ2RRVDFOVUp5d2dkR2x0Wlc5MWREb2dNVFV3TUNCOUxDQW9LU0E5UGlCN2ZTazdEUW9nSUNBZ2NpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnbmRHbHRaVzkxZENjc0lDZ3BJRDArSUhzZ2RISjVJSHNnY2k1a1pYTjBjbTk1S0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlNCOUtUc05DaUFnSUNCeUxtVnVaQ2dwT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNuME5DZzBLWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9LSEpsY1N3Z2NtVnpLU0E5UGlCN0RRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwTkNpQWdhV1lnS0hKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoDQpiSFJvSnlrZ2V3MEtJQ0FnSUM4dklIWTZJT3F3a095TG5PeWVrQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0RxdGF6cnNvVHNvSVFnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3F6aE95R2pTRHJqNHpxczZBZzdKNkk2NHFVN0tlQUlPdXdsdXlYa095RW5DRHRtWlhzbmJqdGxaanJpcFFnN0pxcDY0K0VEUW9nSUNBZ0x5OGdLSFl5SUQwZzdMQzlJT3lJcU9xNWdDRHNpSmpzb0pYdGpKQXNJSFl6SUQwZ0wyRmpZMjkxYm5RZzdMYVU2ckNBN1l5UUxDQjJOQ0E5SUM5MWJtbHVjM1JoYkd3ZzdMYVU2ckNBN1l5UUtRMEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0IzWVhSamFHVnlPaUIwY25WbExDQjJPaUEwSUgwcE93MEtJQ0I5RFFvZ0lDOHZJT3lkdENCUVEreVhrQ0Ryb1p6cXQ3anNuYmpya0p3ZzdZRzA2NkdjNjVPY0lPcXpoT3lnbFNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SU95eXF5RHRtWlRycWJUQ3QrMlppT3lkdENBaTY0aUU2cldzSU9xemhPeWdsZXljdk91aA0KbkNEc2s3RHJpcFRzcDRBaUlPdXp0T3lYck95anZPdUtsQ0RyamJBZzdKTzA2NHVrTGcwS0lDQXZMeURxc0pEc2k1enNucERxc0lBZzY0dTE3WldZNjRxVUlPeWR0T3ljb0RvZzY0dWs2NmFzNjZXOElPeThuT3VwdENEc200enJzSTNzbDRYc25MenJvWndnN1lHMDY2R2M2NU9jNnJDQUlPeUxwT3lnbkNEdG1ManN0cHpyajd3ZzZyV3M2NCtGSU95Q3JPeWFxZXVmaWV5ZHRDRHJncGpxc0lUcmk2UXVEUW9nSUM4dklPcXdrT3lMbk95ZWtPdUtsQ0R0akl6c25ienJwNHdnN0oyOTdKeTg2NitBNjZHY0lPeUNyT3lhcWV1ZmlTQXdJTUszSU91TWdPcTRzQ0F3SU9LQWxDRHFzb0R0aHFEcnA0d2c3Sk93NjRxVUlPeUNyT3Vlak95WGtPcXlqQ0RydVlUc21xbnNuWVFnNjZ5ODY2YXM3S2VBSU95Vml1dUtsT3VMcEM0TkNpQWdMeThnN0tPODdKMllPaURzbDZ6cXVMQWc2ck9FN0tDVjdKMjBJT3V6dE95WHJPdVBoQ0Rzbm9Yc25xWHF0b3pzbmJRZzY2ZU02Nk9NNjVDUTdKMkVJT3lJbUNEc25vanJpNlFvN0p5ZzdacW8NCjdJU3g3SjJBSU95THBPeWduQ0R0bUxqc3Rwd2c2NVdNNjZlTUlPeVZqQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHJpNlRycHF3Z0wyaGxZV3gwYU95ZG1DQndjbTlpYkdWdElPeXd1T3F6b0NrdURRb2dJR2xtSUNoeVpYRXVkWEpzSUQwOVBTQW5MMkZqWTI5MWJuUW5LU0I3RFFvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3Z1kyeGhkV1JsT2lCb1lYTkRiR0YxWkdVb0tTQjlLVHNOQ2lBZ2ZRMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZkMkZyWlNjcElIc05DaUFnSUNCcFppQW9JV2hoYzBOc1lYVmtaU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNnZlNrN0RRb2dJQ0FnZDJGclpVSnlhV1JuWlNncE93MEtJQ0FnSUhKbGRIVnliaUJxDQpjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQjNZV3RwYm1jNklIUnlkV1VnZlNrN0RRb2dJSDBOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNOb2RYUmtiM2R1SnlrZ2V3MEtJQ0FnSUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0RRb2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJREl3TUNrN0RRb2dJQ0FnY21WMGRYSnVPdzBLSUNCOURRb2dJQzh2SU95MGlPcTRzTzJabENEaWdKUWc3SjIwSUZCRDY2VzhJQ2ZzZzRnZ1VFTW5JT3lEZ2UyRG5PdWhuQ0Rya0pqcmo0enJwckRyaTZRZ0tPMlVqT3Vmck9xM3VPeWR1Q0JiN0xTSTZyaXc3Wm1VWFNEcnNvVHRpcndwTGcwS0lDQXZMeURzblpIcmk3WHNuWVFnNjZpODdLQ0FJTzJkbU91Z3BPdXp0T3VDdUNEcmtxUWc3S0NWNjZhczdaV2M2NHVrSU9LQWxDQmliMjkwYjNWMDdKMjBJT3lhc091bXJPdWx2Q0RzcG9ucw0KaTV3ZzdLTzk3SmVzNjQrRUlPMmFqT3lMb095ZGdDRHJqNFRzc0tudGxaenJpNlF1RFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5MWJtbHVjM1JoYkd3bktTQjdEUW9nSUNBZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2NHeGhkR1p2Y20wNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0RRb2dJQ0FnSUNCemFIVjBaRzkzYmtKeWFXUm5aU2dwT3cwS0lDQWdJQ0FnWTI5dWMzUWdjbVZ0YjNabFpDQTlJSFZ1YVc1emRHRnNiRk5sYkdZb0tUc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiZDJGMFkyaGxjbDBnN0xTSTZyaXc3Wm1VS0hWdWFXNXpkR0ZzYkNrZzRvQ1VJT3lnbk9xeHNEb25MQ0J5WlcxdmRtVmtMbXB2YVc0b0p5d2dKeWtnZkh3Z0p5anNsNGJzbll3cEp5azdEUW9nSUNBZ0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHANCmRDZ3dLU3dnTWpBd0tUc05DaUFnSUNCOUxDQXlOVEFwT3cwS0lDQWdJSEpsZEhWeWJqc05DaUFnZlEwS0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdOQ3dnZXlCbGNuSnZjam9nSjA1dmRDQm1iM1Z1WkNjZ2ZTazdEUXA5S1RzTkNnMEtMeThnN0oyMDY2KzRJT3VXb0NEc25vanNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeWloZXVqakNBbzdKNlE2NCtaSU95TG5PeWVrU0FySUc1d2JTQmlkV2xzWkNEc3BKSHJzN1VnN0l1azdaYUpJT3VNZ091NWhDa05Dbk5sY25abGNpNXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdldzBLSUNCcFppQW9aU0FtSmlCbExtTnZaR1VnUFQwOUlDZEZRVVJFVWtsT1ZWTkZKeWtnY0hKdlkyVnpjeTVsZUdsMEtEQXBPdzBLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3RFFwOUtUc05Dbk5sY25abGNpNXNhWE4wWlc0b1VFOVNWQ3dnSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzTkNpQWdZMjl1YzI5c1pTNXNiMmNvSjF0M1lYUmphR1Z5WFNEdGdiVHJvWnpyazV3ZzY0dWs2NmFzDQpJT3F3a095TG5PeWVrQ0Rzdkp6c3A1QWc0b0NVSUdoMGRIQTZMeTlzYjJOaGJHaHZjM1E2SnlBcklGQlBVbFFwT3cwS2ZTazdEUW92THlCSlVIWTJJT3VqcU8yVWhPdXdzU2c2T2pFcDdKZVE2NCtFSU8yVnFPcTdtQ0RyazZQcmlwVHJpNlFnNG9DVUlDZHNiMk5oYkdodmMzUW42ckNBSURvNk1ldWhuQ0RycUx6c29JQWc3WlcwN0lTZDY1Q1k2NHFVSU8yWm1PcXl2ZXlYa095RW5BMEtMeThnN1pTODZyZTQ2NmVJSUdabGRHTm82ckNBSUVsUWRqVHJvWndnN1krMDY3Q3g3WldZN0tlQUlPeVZpdXlWaENEcmk2VHJwcXdnNnJtbzdKcXc2cml3d3JmcXM0VHNvSlVnN0tHdzdacU02ckNBSU95aHNPeWFxZTJlaUNEc2k2VHRqS2p0bFpqcmpaZ2c2Nnk0N0tDY0lPdU1nT3lka1Nqcmk2VHJwcXpzbVlBZzY0K1o3SjI4S1M0TkNtTnZibk4wSUhObGNuWmxjallnUFNCb2RIUndMbU55WldGMFpWTmxjblpsY2loelpYSjJaWEl1YkdsemRHVnVaWEp6S0NkeVpYRjFaWE4wSnlsYk1GMHBPdzBLYzJWeWRtVnlOaTV2Ymlnbg0KWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3SUM4dklEbzZNZXlkaENEcnFyc2c3SjZoN0pXRTY0K0VLRVZCUkVSU1NVNVZVMFhDdDBsUWRqWWc3SmVHN0oyTUtTQkpVSFkwNjZlTTdKeTg2NkdjSU9xemhPeUdqU0RyajVuc25wRU5Dbk5sY25abGNqWXViR2x6ZEdWdUtGQlBVbFFzSUNjNk9qRW5LVHNOQ2c9PQ0KOjpXU0lMRU5UOjoNCkp5QkRiR0YxWkdVZ1FuSnBaR2RsSUhkaGRHTm9aWElnYzJsc1pXNTBJR3hoZFc1amFHVnlJQ2h1YnlCM2FXNWtiM2NwSUMwZ2NtVm5hWE4wWlhKbFpDQjBieUJ5ZFc0Z1lYUWdiRzluYVc0S1UyVjBJR1p6YnlBOUlFTnlaV0YwWlU5aWFtVmpkQ2dpVTJOeWFYQjBhVzVuTGtacGJHVlRlWE4wWlcxUFltcGxZM1FpS1FwVFpYUWdjMmdnUFNCRGNtVmhkR1ZQWW1wbFkzUW9JbGRUWTNKcGNIUXVVMmhsYkd3aUtRcGthWElnUFNCbWMyOHVSMlYwVUdGeVpXNTBSbTlzWkdWeVRtRnRaU2hYVTJOeWFYQjBMbE5qY21sd2RFWjFiR3hPWVcxbEtRcHphQzVEZFhKeVpXNTBSR2x5WldOMGIzSjVJRDBnWkdseUNuTm9MbEoxYmlBaVkyMWtJQzlqSUc1dlpHVWdjMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5SXNJREFzSUVaaGJITmxDZz09DQo6OkVORDo6DQo=";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAAC17BLYC14CAAteAgAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21sa1oyVXBDaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdUNpOHZDaTh2SU95R2pldVBoQ0RzaEtUcXM0UTZJTzJCdE91aG5PdVRuT3VsdkNEc21wVHNzcTNycDRqcmk2UWc3SU9JNjZHY0lPeUxuT3VQbWUyVm1PdXB0Q0F6TUg0ME1PeTBpT3F3Z0NEcXQ3anJnNlVnNjRLZzdKV0U2ckNFNjR1a0xnb3ZMeURpaHBJZzY0dWs2NmFzNjZXOElPeThwQ0RybFl3ZzdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZGhDRHRsWmpyZ3BnZzdKZTA3SmEwSU95RGdleUxuQ0RyaklEcXVMRHNpNXp0Z3FUcXM2QW9jM1J5WldGdExXcHpiMjRnNjR5QTdabVVJT3VxcU91VG5Da3NDaTh2SUNBZzZyQ0E3SjIwNjVPY0sreVlpT3lMbkNneE1USHFzYlFwNjRxVUlPeXlxeURycVpUc2k1enNwNERyb1p3ZzdaV2NJT3V5aU91bmpDRHNuYjN0bm96cmk2UXVJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2Nnk0NnJXczY2ZU1JT3V6dE91Q3RPdXZnT3VobkNEcnVhRHJwYlRyaTZRdUNpOHZJT3lFdU95Rm1PeWRnQ0F6TU91eWlDRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdaVzBJT3VNZ08yWmxPcXdnQ0RyckxUdGxaenRub2dnNnJpNDdKYTA3S2VBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpOHZDaTh2SU95Z2hPeWduRG9nN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPeWRoQ0Rxc29NZ0tHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKeTg2NkdjSU8yWmxleWR1Q2tLTHk4ZzdLTzg3SjJZT2lEc2dxenNtcW5ybjRuc25ZQWc2ckNCN0o2UUlPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFuT3VMcEM0S0NtTnZibk4wSUdoMGRIQWdQU0J5WlhGMWFYSmxLQ2RvZEhSd0p5azdDbU52Ym5OMElHWnpJRDBnY21WeGRXbHlaU2duWm5NbktUc0tZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3Q25SeWVTQjdJR1p6TG0xclpHbHlVM2x1WXloRlRWQlVXVjlEVjBRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbElIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwamIyNXpkQ0JEVEVGVlJFVmZSVTVXSUQwZ1QySnFaV04wTG1GemMybG5iaWg3ZlN3Z2NISnZZMlZ6Y3k1bGJuWXNJSHNLSUNCTlFWaGZWRWhKVGt0SlRrZGZWRTlMUlU1VE9pQW5NQ2NzSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNnNTNxc0lFZzY2cW82NU9jSU91QmxDQW83S2VuN0oyQUlPdXN1T3Exck95WGxDRHJ0b2p0bFlUc21wUXBDaUFnUTB4QlZVUkZYME5QUkVWZlJFbFRRVUpNUlY5T1QwNUZVMU5GVGxSSlFVeGZWRkpCUmtaSlF6b2dKekVuTENBdkx5RHRoTFFnN0pxVTdKVzlJT3VUc1NEcnRvRHFzSUFnN1ppNDdMYWNJT3VCbEFvZ0lFUkpVMEZDVEVWZlZFVk1SVTFGVkZKWk9pQW5NU2NzQ24wcE93b0tMeThnN0lpbzZybUFJT3lMcE8yV2lTanFzSkRzaTV6c25wQWc3SXFrN1krdzdKMkFJSE4wWkdsdklHbG5ibTl5WlNuc2w1RHNoSnpyajRRZzY2eTQ3S0NjNjZXOElPeTJsT3lnZ2UyVm9DRHNpSmdnN0o2STZyS01JT3k5bU95R2xDRHJvWnpxdDdqcnBid2c3WXlNN0oyODdKZVE2NCtFSU91Q3FPcTR0T3VMcEM0S0x5OGc3SnlFN0xtWU9pRHNub1RzaTV3ZzdZKzA2NDJVN0oyWUlHTnNZWFZrWlMxaWNtbGtaMlV1Ykc5bklDanNuSWpyajRUc21yQWdKVlJGVFZBbExDRHJwNlVnSkZSTlVFUkpVaWt1SURKTlFpRHJoSmpzbkx6cnFiUWdMbTlzWk91aG5DRHRsWndnN0lTNDY0eUE2NmVNSU91enRPcTBnQzRLWTI5dWMzUWdURTlIWDBaSlRFVWdQU0J3WVhSb0xtcHZhVzRvYjNNdWRHMXdaR2x5S0Nrc0lDZGpiR0YxWkdVdFluSnBaR2RsTG14dlp5Y3BPd3BqYjI1emRDQmZiM0pwWjB4dlp5QTlJR052Ym5OdmJHVXViRzluTG1KcGJtUW9ZMjl1YzI5c1pTazdDbU52Ym5OdmJHVXViRzluSUQwZ1puVnVZM1JwYjI0Z0tDa2dld29nSUdOdmJuTjBJR0Z5WjNNZ1BTQkJjbkpoZVM1d2NtOTBiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bmFXWjVLR0VwS1NrdWFtOXBiaWduSUNjcElDc2dKMXh1SnpzS0lDQWdJR1p6TG1Gd2NHVnVaRVpwYkdWVGVXNWpLRXhQUjE5R1NVeEZMQ0JzYVc1bEtUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUR0akl6c25id2c2NkdjNnJlNElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUcnBxenJpcFFnNnJPRTdJYU5JQ292SUgwS2ZUc0tDbU52Ym5OMElGQlBVbFFnUFNCT2RXMWlaWElvY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDFCUFVsUXBJSHg4SURFeE9EZzRPeUF2THlCQ1VrbEVSMFZmVUU5U1ZPdUtsQ0R0aFl6c2lxVHRpcmpzbXFrZ0tPMlBpZXlHak95WGxDQXhNVGc0T0NEcXM2RHNvSlVwQ2k4dklPdUxwT3VtckNEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVm5PdUxwQzRnN0wyVTY1T2M2Nlc4SUhCMWJHekN0K3V6dGV5Q3JPMlZ0T3VQaENBcUt1eWR0T3V2dUNEcmxxQWc3SjZJNjRxVUlPdUxwT3Vtck91S2xDRHNtSnNnN0wyVTY1T2NJT3EzdU91TWdPdWhuQ29xNjUyOENpOHZJT3E3a091THBDRHN2SnpxdUxBZzdLQ0U3SmVVSU95RGlDRHJqNW5zbnBIc25iUWc3SldJSU91Q21PeVlxT3VMcENqdGhMRHJyN2pyaEpEc25iUWc2NXlvNjRxVUlPdVRzU2t1SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RzbmJRZzZyQ1M3Snk4NjZHY0lPcTFyT3V5aE95Z2hPeWRoQ0Rxc0pEc3A0RHRsYlFnN0o2czdJdWM3SjZSN0l1YzdZS282NHVrTGdvdkx5RHJqNW5zbnBIc25iUWc2N0NVNjRDTTY0cVVJT3lJbU95Z2xleWRoQ0R0bFpqcnFiUWc3SjIwSU95SXEreWVrT3VsdkNEc21LenJwcXpxczZBZ1kyOWtaUzUwYyt5ZG1DQkNVa2xFUjBWZlRVbE9YMWJyajRRZzZyQ1o3SjIwSU95WXJPdW1zT3VMcEM0S1kyOXVjM1FnUWxKSlJFZEZYMVlnUFNBek1Ec0tMeThnNnJpdzY3TzRJT3VxcU91TnVDNGc3SnFVN0xLdEtPMlVqT3Vmck9xM3VPeWR1Q25zbmJRZ2JXOWtaV3pzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3EzdUNEc21wVHNzcTNycDR3ZzZyZTRJT3VxcU91TnVPdWhuQ0Rzc3BqcnBxenRsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPY0lDaHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FnNG9DVUlHSjFhV3hrTFdkc2IzTnpZWEo1TG1wejdKbUFJT3F3bWV5ZGdDRHRqSXpzaEp3cElPS1VnT0tVZ0FwbWRXNWpkR2x2YmlCc2IyRmtSWGhoYlhCc1pYTW9LU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FuS1N3Z0ozVjBaamduS1RzS0lDQWdJR052Ym5OMElITmxZMGxrZUNBOUlHMWtMbk5sWVhKamFDZ3ZYaU1qSU95MmxPeXluQ0RzbUlqc2k1eGNjeW9rTDIwcE93b2dJQ0FnYVdZZ0tITmxZMGxrZUNBOVBUMGdMVEVwSUhKbGRIVnliaUJiWFRzS0lDQWdJR052Ym5OMElHVjRZVzF3YkdWeklEMGdXMTA3Q2lBZ0lDQnNaWFFnWTNWeUlEMGdiblZzYkRzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnY21GM0lHOW1JRzFrTG5Oc2FXTmxLSE5sWTBsa2VDa3VjM0JzYVhRb0oxeHVKeWtwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlISmhkeTV5WlhCc1lXTmxLQzljY3lza0x5d2dKeWNwT3dvZ0lDQWdJQ0JqYjI1emRDQm9JRDBnYkdsdVpTNXRZWFJqYUNndlhpTWpJMXh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9hQ2tnZXlCamRYSWdQU0I3SUdsdWNIVjBPaUJvV3pGZExDQnpkV2RuWlhOMGFXOXVjem9nVzEwZ2ZUc2daWGhoYlhCc1pYTXVjSFZ6YUNoamRYSXBPeUJqYjI1MGFXNTFaVHNnZlFvZ0lDQWdJQ0JqYjI1emRDQmlJRDBnYkdsdVpTNXRZWFJqYUNndlhseHpLaTFjY3lzb0xpcy9LVnh6S2lRdktUc0tJQ0FnSUNBZ2FXWWdLR0lnSmlZZ1kzVnlLU0JqZFhJdWMzVm5aMlZ6ZEdsdmJuTXVjSFZ6YUNoaVd6RmRMbk53YkdsMEtDY2dMeUFuS1M1cWIybHVLQ2NnSnlrcE93b2dJQ0FnZlFvZ0lDQWdjbVYwZFhKdUlHVjRZVzF3YkdWekxtWnBiSFJsY2lnb1pTa2dQVDRnWlM1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ1BpQXdLVHNLSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpd0lPcXpvT3k1cUNBcklPeVd0T3lJbkNEcnM0RHFzcjBpN0oyMElPdVFuT3VMcEM0ZzdKZXQ3WldnSU91MmhPdW1yQ0RpZ0pRS0x5OGc3WUcwNjZHYzY1T2NJRDBnNjZ5NDdKNmxJT3VMcE91VHJPcTRzQ2pzc0wzc25aZ3BMQ0RzbXFuc2xyUWc3WWExN0oyOHdyZnJwNTdzdHFUcnNwVWdQU0JqYjJSbExuUnpJSEpsWm1sdVpVRnBVM1ZuWjJWemRHbHZibk1nN1p1RTdMS1k2NmFzS09xNHNPcXpoT3lnZ1NrdUNtTnZibk4wSUZOVVdVeEZYMUpWVEVWVElEMGdXd29nSUNjeExpRHRsYlRzbXBUc3NyUTZJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWc3WlcwN0pxVTdMSzA2NkdjTGlBbzY3TzA2NE9GNjR1STY0dWs0b2FTNjdPMDY0SzA3SnFVS1Njc0NpQWdKekl1SU91S3BldVBtZXlnZ1NEcnA1RHRsWmpxdUxBNklPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ3dnZnV5WGlDRHJ1YnpxdUxBbzY3Q1U2NENNN0plSTdKYTA3SnFVNG9hUzY3Q1U2citvN0phMDdKcVVLUzRnNjR1b0xDRHNvb1hybzR6Q3QrdW5qT3Vqak1LMzdKZXc3TEswd3JmdGxiVHNwNERDdCtxNHNPdWhuY0szNjRXNTdKMk1JT3VUc1NEc2k1enNpcVR0aFp6c25iUWc3S084N0xLMDdKMjRJT3F5c09xenZPdUtsQ0RzaUpqcmo1bnRtSlVnN0p5ZzdLZUFLT3lYc095eXRPdVB2T3lhbEN3ZzY0VzU3SjJNNjQrODdKcVVLUzRuTEFvZ0lDY3pMaURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3T2lBaWZ1MlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlpRHJqSURzaTZBZ0luN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRaUlPcTFyT3loc0NEc21yRHNoS0F1SU91THFDd2c3S0NWN0xHRjdJT0JJT3UyaU9xd2dNSzM3SjI4NjdhQUlPcTRzT3VLcFNEc29KenRsWnpDdCt1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPcXlzT3F6dk1LMzdLQ1Y2N08wSU91enRPMll1Q0RzbFlqc2k2enNuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMmVpQzRuTEFvZ0lDYzBMaURzdXBEc283enNscnp0bFp3ZzZySzk3SmEwT2lCKzdaV1k3SXVjNnJLZzdKYTA3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cExpY3NDaUFnSnpZdUlPMlJuT3E0c0RvZzY1Q1k3SmEwN0pxVTRvYVM2NCs4N0pxVUxpY3NDaUFnSnpjdUlPeWtoQ0RxdGF6c29iQTZJT3lia091enVPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPeTJsT3l5bk91UGhDRHJzSmpyazV6c2k1d2c3WldjSU95a2hPdWhuQzRnN0o2RTdKMlk2NkdjSU95a2hPeWRoQ0RyaXBqcnBxenNwNEFnN0pXSzY0cVU2NHVrTGlEcmk2Z3NJT3lYck91ZnJDRHJyTGpzbnFYc25ZUWc3WldZNjRLWTdKMllJT3E0amV5Z2xlMllsU0Ryckxqc25xWHNuTHpyb1p3ZzdaV3A3TE9RSU91TmxDRHFzSVRxc3JEdGxiVHNwNFRyaTZUcnFiUWc3S1NFSU95SW1PdWx2Q0RzcElUc25iVHJpcFFnNnJLRDdKMkFJTzJabU95WWdTNG5MQW9nSUNjNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1NEcnNvVHRpcnc2SU9xeXNPcXp2Q0R0aHJYcnM3VHJpcFFnVysyWmxleWR1RjBzSU95WWlDL3NsWVRyaTRqc21LUWc3WXlRNjR1bzdKMkFJRnZzbFlUcmk0anNtS1JkTDF2cmhLUmRMQ0RyajVuc25wRWc3SnlnNjQrRTY0cVVJRnZzdDZqc2hveGRMMXQ3NjQrWjdKNlJmVjB1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ0RzazdEcXM2QWdJdXVMcStxNHNNSzM2NCtaN0o2Ukl1eXltT3VmdkNEc3A1MGc3SldJSU91bm51dUtsQ0Rzb2JEdGxhbkN0K3VMcU91UGhTQWk3TGVvN0lhTUl1dUtsQ0RxdUlqc3A0QXVKeXdLSUNBbk9TNGc3SjIwNjZhRXdyZnNvSVR0bVpUcnNvanRtTGpDdCt1bmlPeUtwTzJDdWV5ZGdDRHF0N2pyaklEcm9ad2c2N08wN0tHMExpRHNncXpybm96c25ZUWc2N2FBNjZXOElPdVZrQ0RyaTVqc25ZUWc2N2FaN0plczY0K0VJT3lpaSt1THBDNG5MQW9nSUNjeE1DNGc3S0NjN1pLSUlPeWFxZXlXdENEc25LRHNwNEE2SU95ZWhldWdwZXlYa0NEc2s3RHNuYmdnNnJpdzY0cWw3SVN4SU91cWhleUNyQ2pyczREcXNyMHNJT3luZ095Z2xTd2c2NU94NjZHZExDRHRsYlRzb0p3ZzY1T3hLZXVLbENEdG1aVHJxYlRzblpnZzZyaXc2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqc2lKanJqNW50bUpYQ3QrcXl2ZXlXdE1LMzY3YUE3S0NWN1ppVklPMlhpT3lhcVNEc3ZJRHNuYlRzaXFRcDdKMllJT3VKbU95Vm1leUtwT3F3Z0NEc25LRHNpNlRya0p6cmk2UXVDaTh2SU8yTWpPeWR2T3lkdENEc2w0YnNuTHpycWJRbzdJU2s3TG1ZNjdPNElPcTFyT3V5aE95Z2hDRHJrN0VwSU91NWlDRHJyTGpzbnBEc2w3UWc0b0NVSU95YWxPeVZ2ZXVuak95Y3ZPdWhuQ0RyajVuc25wRW9abUZwYkMxemIyWjBLUzRLWm5WdVkzUnBiMjRnYkc5aFpFZDFhV1JsS0NrZ2V3b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuZFhndGQzSnBkR2x1Wnk1dFpDY3BMQ0FuZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUhKbGRIVnliaUJ0WkM1c1pXNW5kR2dnUGlBeE1EQWdQeUJ0WkNBNklDY25Pd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3Vobk91VG5DRHNpNlR0aktnZ0tPeWFsT3lWdmV1bmpPeWN2T3VobkNEc3A0VHRsb2twT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNCeVpYUjFjbTRnSnljN0NpQWdmUXA5Q21OdmJuTjBJRWRWU1VSRklEMGdiRzloWkVkMWFXUmxLQ2s3Q2dwbWRXNWpkR2x2YmlCcGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTQjdDaUFnWTI5dWMzUWdabVYzVTJodmRDQTlJRVZZUVUxUVRFVlRMbTFoY0Nnb1pYZ3BJRDArSUNkSmJuQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExtbHVjSFYwS1NBcklDZGNiazkxZEhCMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG5OMVoyZGxjM1JwYjI1ektTa3VhbTlwYmlnblhHNG5LVHNLSUNCeVpYUjFjbTRnS0FvZ0lDQWdKK3luZ09xNGlPdTJnTzJFc0NEcmhJanJpcFFnN0plUTdJcWs3SnVRS0ZNdE1Td2c2N08wN0pXSTdacU03SUtzS2V5ZG1DRHRsWnpxdGEzc2xyUWdWVmdnVjNKcGRHbHVaeURzb0lUcnJManFzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91THBDNGdKeUFyQ2lBZ0lDQW43S0d3NnJHMElPMlJuTzJZaENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzB3cmZzdElqcXM3ekN0K3V2dU91bmpNSzM2N2FBN1lTd3dyZnF1WXpzcDRBZzY1T3hLZXlkZ0NEc29KWHNzWVVnN0tDVjY3TzA2NHVrSU9LQWxDRHJ1Ynpxc2JEcmdwZ2c2NHVrNjZXNElPeWhzT3F4dE95Y3ZPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhLQ0kxN1pxTUlPeWR0T3lEZ1NMc25ZUWdJalh0bW93aTY2R2NJT3lraE95ZHRPdXB0Q0RzbUtUcmk3VXBMaUFuSUNzS0lDQWdJQ2ZzbTVEcnJManNsNUFnN0plRzY0cVVJT3Exck95eXRDRHNvSlhyczdRbzdLQ0U3Wm1VNjdLSTdaaTR3cmRWVWt6Q3QrcTRpT3lWb2NLMzdJdWM2ckNFSU91VHNTbnNtWUFnN1pXMDZyS3dJT3V3cWV1eWxjSzM3S0NJN0xDb0tPeWVyT3lFcE95Z2xjSzM2Nnk0N0oyWTdMS1l3cmZzbnF6c2k1enJqNFFnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjdhWjdKMjA2NHFVSU9xeWcreWRnQ0Rzb0lqcmpJQWc2cmlJN0tlQUlPS0FsQ0RzbFlUcmlwUWc2ckNTN0oyMDY1Mjg2NCtFTENEcXQ3anJuN1RyazYvdGxiVHJqNFFnN0pPdzdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdKelBxc0p3ZzdLQ2M3SldJN0oyQUlPeUVuT3VobkNEc29KSHF0N3pzbmJRZzY0dXM2NTI4N0pXOElPMlZuT3VMcENEaWdKUWc3WldZNjRLWTY0cVVJT3lia091c3VDRHF0YXpzb2JEcnBid2c3SnlnN0tlQTdaV2NJT3kxbk95R2pDRHJpNlRyazZ6cXVMQXNJTzJWbU91Q21PdUtsQ0Ryckxqc25xVWc2cldzN0tHdzY2VzhJT3llck9xMXJPeUVzZTJWbkNEcmpJRHNsWWdzSUNjZ0t3b2dJQ0FnSitxM3VPdW1yT3F6b0NEc29JSHNsclRyajRRZzdaV1k2NEtZNjRxVUlPcXp2T3F3a08yVm5DRHNucXpxdGF6c2hMRTZJT3lra2V1enRTRHRrWnp0bUlUc25ZUWc2NDJjN0phMDY0SzA2ck9nTENEc29KWHJzN1FnN0lpYzdJU2M2Nlc4SU95Q3JPeWFxZXlla09xd2dDRHNsWXpzbFlUc2xid2c3WldnSU9xeWcrdTJnTzJFc091aG5DRHNucXpzb2JEc3A0SHRsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZ0lDQWdKK3lWaE91ZW1DRHNtSWpzaTV6cms2VHNuWUFnN1pXY0lPeWtoT3lubk91bXJDRHN0WnpzaG93ZzZyV1E3S0NWN0oyMElPdW5qdXluZ091bmpDRHF0N2pxc2JRZzdZYWtLTzJWdE95YWxPeXl0TUszNnJLOTdKYTBLZXlkbUNEcXRaRHJzN2pzbmJUc3A0QWc3SWFNNnJlNTdJU3g3SjJZSU9xMWtPdXp1T3lkdENEc2xZVHJpNGpyaTZRZzRvQ1VJT3lYck91ZnJDRHJyTGpzbnFYc3A1enJwcXdnN0o2RjY2Q2w3SjJBSU91cGxPeUxuT3luZ0NEcmk2anNuSVRyb1p3ZzY0dWs3SXVjSU95RXBPcXpoTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcnNMRHNsN1RycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaGNLMzdMMlU2NU9jN1k2YzdJcWtJT3E0aU95bmdEcGNiaWNnS3dvZ0lDQWdKMXQ3SW5SbGVIUWlPaUFpN0tDYzdKV0lJT3VzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV1c3RPeVhoK3lkaENEc21ad2c2N0NVNnIrbzY0cVU3S2VBSU8yVm5PcTFyZXlXdENEdGxad2c2Nnk0N0o2bEluMHNJQzR1TGwxY2JseHVKeUFyQ2lBZ0lDQW5XK3lLcE8yRGdPeWR2Q0RxdDV6c3VabGRYRzRuSUNzZ1UxUlpURVZmVWxWTVJWTWdLeUFuWEc1Y2JpY2dLd29nSUNBZ0tFZFZTVVJGSUQ4Z0oxdnNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3lnaE91c3VDQW9kWGd0ZDNKcGRHbHVaeTV0WkNrZzRvQ1VJT3ljaENEcXQ1enN1Wm5zblpnZzZyZTg2ckd3N0ptQUlPeVlpT3ladUNEc2k1enJncGpycHF6c21LUXVJTzJLdWUyZWlDRHNtSWpzbWJnZzZyZWM3TG1aS095SW1PdVBtZTJZbGNLMzZySzk3SmEwd3JmcnRvRHNvSlh0bUpYc25ZUWc3SnlnN0tlQTdaVzA3Slc4SU8yVm1PdUtsQ0RzZzRIdG1ha3A3SjJFSU9xM3VPdU1nT3VobkNEcmxMRHJwYlRxczZBc0lPeWFsT3lWdmVxenZDRHNvSVRyckxqc25iUWc2NHVrNjZXMDY2bTBJT3lnaE91c3VPeWRoQ0RybExEcnBianJpNlJkWEc0bklDc2dSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cGJtVkNkV1lnUFNBbkp6c2dJQ0FnSUNBZ0lDQXZMeUJ6ZEdSdmRYUWc3S1NFSU91eWhPMk52QXBzWlhRZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQzh2SU8yWWhPeWVyQ0R0aExUc25aZ2dleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIMEtiR1YwSUhGMVpYVmxJRDBnVUhKdmJXbHpaUzV5WlhOdmJIWmxLQ2s3SUM4dklPeWFsT3l5clNEc3A0SHJvS3p0bVpRZ0tPdVBtZXlMbkNEc21wVHNzcTNzbllBZzdJaWM3SVNjNjR5QTY2R2NLUXBzWlhRZ2RIVnlibk1nUFNBd093cHNaWFFnZDJGeWJXVmtWWEFnUFNCbVlXeHpaVHNLYkdWMElHTjFjbkpsYm5STmIyUmxiQ0E5SUVOTVFWVkVSVjlOVDBSRlREc2dMeThnN0tlQTZyaUlJT3lFdU95Rm1PeWR0Q0Ryckx6cXM2QWc3SjZJNjRxVUlPdXFxT3VOdUNBbzdKcVU3TEt0N0oyMElPdUxwT3VsdUNEcnFxanJqYmpzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3lFdU95Rm1DRHNucXpzaTV6c25wRXBDaTh2SU95TG5PeWVrU0RzaTV3Z1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbElFTk1TU25xc0lBZzdKTzRJT3lJbUNEc25vanJpcFRzcDRBZzdLQ1E2cktBSU9LQWxDRHNsNGJzbkx6cnFiUWdMMmhsWVd4MGFPdWhuQ0RzbFl6cm9LUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeVZpT3VDdE8yVm5PdUxwQzRLTHk4Z2JuVnNiRDN0bVpYc25iZ2c3S1NSTENBbmIyc25QZXlDck95YXFTRHFzSURyaXFVc0lDZGpiR0YxWkdVdGJXbHpjMmx1WnljOVkyeGhkV1JsSU91cWhldWd1U0RzbDRic25Zd3NDaTh2SUNkamJHRjFaR1V0Ykc5bmIzVjBKejFqYkdGMVpHWHJpcFFnN0o2STdLZUE2NmVNSU91aG5PcTN1T3lkdUNEc2hManNoWmdnNjZlTTY2T01JQ2p0aExRZzdJdWs3WXlvSU95TG5DRHFzSkRzcDRBc0lPeUVzZXF6dFNEdGhMVHNuYlFnN0ppazY2bTBJT3lla091UG1TRHRsYlRzb0p3cENpOHZJQ2RqYkdGMVpHVXRiR2x0YVhRblBldWhuT3EzdU95ZHVPeWRnQ0Rya0pEc3A0RHJwNHdnN0lLczdKcXBJTzJWbk91UGhDRHN0SWpxczd3Z0tPeWhzT3k1bU9xd2dDRHNucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWjdKMkFJT3F5dmV1aG5PdWhuQ0RzbnFIdG5vanJyNERyb1p3ZzdLU1I2NmE5SU8yUm5PMlloT3lkaENEc2s3VHJpNlFLWTI5dWMzUWdURTlIU1U1ZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVPeWR0Q0R0bFlUc21wVHRsYlRzbXBRbzdKV0lJT3VRa09xeHNPdUNtQ0RycDR6cm80d3BJT0tBbENCYjhKK2ZvQ0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjBnNjdLRTdZcTg3SjJFSU91SWhPdWx0T3VwdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHRPeVd0T3VUbk91Z3BPeWFsQzRuT3dvdkx5RHNpNlRzdUtIdGxad2c2Nnk0NnJXczY1T2tPaUFpUm1GcGJHVmtJSFJ2SUdGMWRHaGxiblJwWTJGMFpUb2dUMEYxZEdnZ2MyVnpjMmx2YmlCbGVIQnBjbVZrSUdGdVpDQmpiM1ZzWkNCdWIzUWdZbVVnY21WbWNtVnphR1ZrSWlqcnA0enJvNHdwTEFvdkx5QWlUbTkwSUd4dloyZGxaQ0JwYmlEQ3R5QlFiR1ZoYzJVZ2NuVnVJQzlzYjJkcGJpSW82Nis0NjZHYzZyZTQ3SjI0S1NEaWdKUWc2NUdZSU91THBDRHNucUh0bm9qcXNvd2c2NFNUN1o2TTY0dWtDbVoxYm1OMGFXOXVJR2x6UVhWMGFFVnljbTl5S0hNcElIc0tJQ0J5WlhSMWNtNGdMMkYxZEdobGJuUnBZMkYwZkc5aGRYUm9mR0Z3YVNCclpYbDhiRzluSUQ5cGJueHNiMmRuWldSOGMyVnpjMmx2YmlCbGVIQnBjbVZrTDJrdWRHVnpkQ2hUZEhKcGJtY29jeWtwT3dwOUNpOHZJT3lDck95YXFTRHRsWnpyajRRZzdMU0k2ck84SU9xd2tPeW5nQ0RpZ0pRZzY2R2M2cmU0N0oyNDdKMkFJT3VwZ095cG9lMlZuT3VOc0NBaTY0MlVJT3VxdXlEc2s3VHJpNlFpNjRxVUlPcXl2ZXlhc0M0ZzY2R2M2cmU0N0oyNElPdW5qT3Vqak95WmdDRHNvYkRzdVpqcXNJQWc2NHVzNjUyODdJU2NJT3VVc091aG5DRHNucUhyaXBUcmk2UXVDaTh2SU95THBPeTRvU2d5TURJMkxUQTRMQ0R0bW96c2dxd2c3SmVVN1lTdzdaU0U2NTI4N0oyMDdLYUlJT3lpak95RW5TazZJQ0paYjNVbmRtVWdhR2wwSUhsdmRYSWdhVzVrYVhacFpIVmhiQ0J6Y0dWdVpDQnNhVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6c25wRHNsNURxc293ZzdaV2M2NCtFNjZXOElPeVlyT3VncENEcmk2enJuYnpxczZBZzdKcVU3TEt0N1pXWTZyT2dMQ0RzbFlUcmk0anJxYlFnVy9DZm42QWc3WUcwNjZHYzY1T2NJTzJWbk91UGhDRHN0SWpxczd4ZElPdXloTzJLdk95ZGhDRHJpSXpybjZ3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsYlFnN0tPODdJUzQ3SnFVTGljN0NpOHZJQ2Z0bFp6cmo0UW42NkdjSU91dGlldWFzZXEzdU91bXJPdXB0Q0RzbFlnZzY1Q2M2NHVrSU9LQWxDRHNucURxdVpBZzY2cXc2NmEwSU91VmpDRHJncGpyaXBRZ2NtRjBaU0JzYVcxcGRPeWR0T3VDbUNEcnJManJwNlVnNnJpNDdKMjBJT3kwaU9xenZPcTVqT3luZ0NEc25xSHNsWVFLTHk4ZzdKZUo2NXF4N1pXWTZyS01JQ0xyaTZUcnBiZ2c2ck9FN0tDVjdKeTg2NkdjSU91aG5PcTN1T3lkdU8yVm1PdWR2Q0xxczZBZzdKV0k2NEswN1pXWTZyS01JT3VRbk91THBDNGc3S2VBN0xhY3dyZnNncXpzbXFucm40a2c3SU9CN1pXY0lPdXN1T3Exck91bmpDRHNvb0h0bUlEc2hKd2c2N080NjR1a0NtWjFibU4wYVc5dUlHbHpUR2x0YVhSRmNuSnZjaWh6S1NCN0NpQWdjbVYwZFhKdUlDOXpjR1Z1WkNCc2FXMXBkSHgxYzJGblpTMWpjbVZrYVhSemZIVnpZV2RsSUd4cGJXbDBJQ2h5WldGamFHVmtmR1Y0WTJWbFpHVmtLUzlwTG5SbGMzUW9VM1J5YVc1bktITXBLVHNLZlFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56NjZXOElPeWR2ZXlXdEFvdkx5QXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZuT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbENEc3BKSHNuYmpzcDRBaUlPMlJuT3lMbkNEaWdKUWc2ck8xN0pxcElGQkQ3SmVRN0lTY0lPdUNxT3lkbUNEcXM0VHNvSlVnN0ppazdJS3M3SnFwSU91d3FleW5nQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMElPeWR0Q0Rxc0pMcXM3d2c3WXlNN0oyODdKMllJT3F6aE95Z2xleWR0Q0RzbHJUcXVJdnJncHpyaTZRS2JHVjBJSE5sYzNOcGIyNUJZMk52ZFc1MElEMGdiblZzYkRzS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzS0lDQnBaaUFvUkdGMFpTNXViM2NvS1NBdElHRmpZMjkxYm5SRFlXTm9aUzVoZENBOElETXdNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3dvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTNXFjMjl1Snlrc0lDZDFkR1k0SnlrcE93b2dJQ0FnWlcxaGFXd2dQU0FvYWlBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZENBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZEM1bGJXRnBiRUZrWkhKbGMzTXBJSHg4SUc1MWJHdzdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nNjZHYzZyZTQ3SjI0SU95ZHRPdWdwU0RzbDRic25Zd2c2NU94SU9LQWxDQnVkV3hzSU95Y29PeW5nQ0FxTHlCOUNpQWdZV05qYjNWdWRFTmhZMmhsSUQwZ2V5QmhkRG9nUkdGMFpTNXViM2NvS1N3Z1pXMWhhV3dnZlRzS0lDQnlaWFIxY200Z1pXMWhhV3c3Q24wS1puVnVZM1JwYjI0Z1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LU0I3Q2lBZ1kyOXVjM1FnY0hKdlltVWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0TFhabGNuTnBiMjRuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdJSDBwT3dvZ0lHeGxkQ0J2ZFhRZ1BTQW5KenNLSUNCd2NtOWlaUzV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJ2ZFhRZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc0tJQ0J3Y205aVpTNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljN0lIMHBPd29nSUhCeWIySmxMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVFpXTTZJQ2NuSUgwN0Nnb3ZMeURpbElEaWxJQWc3WlNNNjUrczZyZTQ3SjI0SU95RG5leWh0Q0Rxc0pEc3A0QW83SXVzN0o2bDY3Q1Y2NCtaS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdaU002NStzNnJlNDdKMjQ3SjIwSU91V29DRHNub2pyaXBRZzY0K1o3SldJSUdOdlpHVXVkSFBxc0lBZ05leTBpT3VuaU91THBDQlFUMU5VSUM5b1pXRnlkR0psWVhUcnBid2c2N08wNjRLNDY0dWtMZ292THlEdGxad2c2N0tJN0oyMDY1Mjg2NCtFSU91d20reWRnQ0Rya3FRZ016RHN0SWpxc0lRZzY0R0s2cml3NjZtMElPMlVqT3Vmck9xM3VPeWR1Q2pybUpEcmlwUWc3WlM4NnJlNDY2ZUlLZXlkdENEcmk2dnRub3dnNnJLRElPS0FsQ0R0Z2JUcm9aenJrNXpxdVl6c3A0QWc2NDJ3NjZhczZyT2dJT3F3bWV5ZHRDRHF1cnpzcDRUcmk2UXVDaTh2SU95VmhPeW5nU0R0bFp3ZzY3S0k2NCtFSU91cXV5RHJzSnZzbFpqc25MenJxYlFvNjR1azY2YXM2NmVNSU91b3ZPeWdnQ0RzdktBZzdJT0I3WU9jTENEc25wRHJqNW5zaTV6c25wRWc2NU94S1NEcXM0VHNobzBnNjR5QTZyaXc3WldjNjR1a0xncGpiMjV6ZENCSVJVRlNWRUpGUVZSZlJFVkJSRjlOVXlBOUlETXdNREF3T3dwc1pYUWdiR0Z6ZEVKbFlYUWdQU0F3T3dwelpYUkpiblJsY25aaGJDZ29LU0E5UGlCN0NpQWdhV1lnS0d4aGMzUkNaV0YwSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFtVmhkQ0ErSUVoRlFWSlVRa1ZCVkY5RVJVRkVYMDFUS1NCN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFnNG9DVUlPMlV2T3EzdU91bmlDL3RsSXpybjZ6cXQ3anNuYmpzbmJRZzY0dXI3WjZNSU9xeWcreWN2T3VobkNEcnM3VHFzNkFnNnJDWjdKMjBJT3E2dk95bmtldUxpT3VMcEM0bktUc0tJQ0FnSUhCeWIyTmxjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQc25MenJvWndnWTJ4aGRXUmxJTzJLdU91bXJPdWx2Q0Rzb0pYcnBxenRsWnpyaTZRS0lDQjlDbjBzSURVd01EQXBPd29LTHk4ZzRwU0E0cFNBSU91aG5PcTN1T3lkdU95ZGdDQkRURW5xc0lBZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzcDRIc29KRWc3SmUwNnJLTUlPMlZuT3VMcENBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU16QXBJT0tVZ09LVWdBb3ZMeURzbXJEcnBxenFzSUFnUWxKUFYxTkZVdXVsdkNEcXNJRHJvWnpzc1lUcXNiRHJncGdnN0xDOTdKMkVJT3F6cU91ZHZDRHNsNnpyaXBRZzdJdWM2NCtFNjRxVUlDb3E3S0NFNjdhQUlPeUxwTzJNcU8yVnRPeUVuQ0Rya0pqcmo0enJvTGpyaTZRcUtpNGc2NEtvNnJpMElPcTFrTzJiaURvS0x5OGdJQ0Rpa2FBZ1FsSlBWMU5GVWlEdGxianJrNlRybjZ6cm9ad2dWVkpNN0oyRUlPdXdtK3ljdk91cHRDQmpiV1Rxc0lBZ1lDWmc3SmVRN0lTY0lPeWVtT3Vkdk91b3VldUtsT3VMcENEaWhwSWdZMnhwWlc1MFgybGtJT3lHak95THBDZ2k3SjZZNjZxNzY1Q2NJRTlCZFhSb0lPeWFsT3l5clNJcExnb3ZMeUFnSU9LUm9TQkNVazlYVTBWUzY2VzhJRzV2TFc5dzdKeTg2NkdjSU91bmllcXpvQ0J6ZEdSdmRYVHNuWmdnVlZKTTdKMkVJT3lhc091bXJPcXdnQ0RzbDdUcnFiUWdLaXJzaXJuc25iZ2c2NUtrSU95ZHVPeW1uZXk5bE91VG5PdWx2Q0RydHBuc2w2enJoS1Bzbkx6cm5ienJpcFFnN1ptVTY2bTBLaXJzbmJRS0x5OGdJQ0FnSUNEcm5LenJpNlFvN0l1azdMaWhJT3lMb09xem9Eb2dJdXlkdE91ZnNDRHFzYkFnN0plRzdKZUk2NHFVNjQyd0lPcXdrZXlla09xNHNDRHNtWndnN0lPZDZyS29JaWtnNG9DVUlPeWVrT3VQbVNEc2lKanJvTG5zbmJRZzZybW83S2VFNjR1a0xnb3ZMeUFnSU9LUm9pRHNpNXp0Z2F6cnByOGc3TEM5N0p5ODY2R2NJT3lYdE91Z3BPdXB0Q0RydUl6cm5ienNtckRzb0lEcnBid2c3SnF3NjZhczZyQ0FJT3F6cU91ZHZPeVZ2Q0R0bGJUc2hKd2dLaXJxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNnJDQUlPeVZoT3VMakNEdGdhenJvYXpDdCt5WG8reW5nT3F3Z0NEc2w3VHJwckRyaTZRcUtnb3ZMeUFnSUNBZ0lDanNpNlRzdUtFZzdJdWc2ck9nT2lBaTdKbWNJTzJCck91aHJPeWN2T3VobkNEc2w3VHJvS1FpTENBaTZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWhuQ0R0bFpqcm5ienJpNGpxdVl3aUtTNGc2cktNNjR1azZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURxc0lBZzdJdWM3WUdzNjZhL0NpOHZJQ0FnSUNBZzdKMjQ3SjZRNjZXOElPdXN0T3lMbk8yVm1PdXB0Q2pzZ3J6c2hMRWc3SjI0N1lTdzY0UzNJT3lMcE95NG9Ta2c3SjI4NjdDWUlPeXd2ZXlkdENEcmxxQWc3SXE1N0oyNElPMlpsT3VwdE95ZHRDRHF0N2pyaklEcm9aenJpNlF1Q2k4dklPcTN1T3VlbU95RW5DQXFLa0pTVDFkVFJWTHJwYndnNnJHMDY1T2M2NmFzN0tlQUlPeVZpdXVLbE91THBDb3FJT0tBbENCamJHRjFaR1VnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA2ck9nSUd4dlkyRnNhRzl6ZE91aG5DRHFzckRxczd6cnBid2c3SjZRNjQrWkNpOHZJT3lJbU91Z3VlMlZuT3VMcENqc3ZaVHJrNXdnNjdhWjdKZXM2NFNqNnJpd0lPeVhodXlkakNrdUlPcXpoT3lnbFNEc29JVHRtWmpzbllBZzdJcTU3SjI0SU8yWmxPdXB0Q0R0bFpqcmk2Z2dXK3F6aE95Z2xTRHNvSVR0bVpoZElPdXloTzJLdk95Y3ZPdWhuQ0R0bFp6cmk2UXVDaTh2SUNvcTdKMjBJT3F5dmV1aG5PeVhrQ0JWVWt3ZzZyQ0E2ck8xd3Jmc3BKSHFzSVFnN0lxazdZR3M2NmE5N1lxNHdyZnJ1SXpybmJ6c21yRHNvSUFnN0tlQTdLQ1Y3SjJFSU91THBPeUxuQ0RyaEtQc3A0QWc2NmVRSU9xeWd5NHFLZ29LTHk4ZzRwU0E0cFNBSUVKU1QxZFRSVklnNnJDQTY2R2M3TEdFNnJpdzY0cVVJT3lnbk9xeHNPdVFrT3VMcENBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU1qVXBJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBb3ZMeURzbUlqc29JVHNsNVFnUWxKUFYxTkZVaUR0bVpqcXNyM3JzNERzaUpqc2w1QWc3SjZFN0l1Y0lPeUtwTzJCck91bXZlMkt1T3VsdkNEcXZZTHNsWVFnUTB4SjZyQ0FJT3lrZ0NCaGRYUm9iM0pwZW1VZ1ZWSk03SjJFSU95YXNPdW1yT3F3Z0NEcnNKdnNsWVRzaEp3ZzdKZTA3SmVJNjR1a0xnb3ZMeURycXFuc29JSHNuWUFnN1pXWTY0S1k2NytRN0oyMDdKZUk2NHVrSU9LQWxDRHFzNFRzb0pVZzdLQ0U3Wm1ZN0pxcDdKeTg2NkdjSUZWU1RPeWRoQ0JqYkdGMVpHVXVZV2t2Ykc5bmIzVjBQM0psZEhWeWJsUnZQZUtBcHV1aG5DRHNucXpzbnBIc2hMSHRsYlFLTHk4ZzdJcTU3SjI0SU8yWmxPdXB0T3lkaENEcXNiVHJoSWpybTdEcXM2QWc2ck9FN0tDVklPeUVvTzJEblNEdG1aVHJxYlRzbDVBZzdLZUI3WmFKN0l1YzdZS2s2cml3TGlEcXQ3Z2c3SjZzN0o2UjdJU3g3SjJFSU8yUGtPcTRzTzJWbU95ZWtDanNncXpzbXFuc25wQWc2ckt3N0tDVktTRHRsYmpyazZUcm42enJpcFFLTHk4ZzY2cXA3S0NCN0oyMElPeVhodXlXdE95aGpPcXpvQ3dnS2lycmdxanFzcWdnNjVHUTY2bTBJT3lZcE8yZWlPdWdwQ0Ryb1p6cXQ3anNuYmpzbllRZzY2ZWQ2ckNBNjV5bzY2YXc2NHVrS2lvNkNpOHZJQ0FnUTB4SjZyQ0FJRlZTVE95ZGhDRHJsTERzbUxUdGtad2c3SmVHN0oyMElPdUVtT3E0c091cHRDQmpiV1Rxc0lBZ1lDWmc3SmVRN0lTY0lGVlNUT3lkaENEc25wanJuYndnNjdLRTY2Q2tLT3ljaU91UGhPeWFzQ2tnWTJ4cFpXNTBYMmxrSU9xd21leWRnQ0Rya3FUc3FyMEtMeThnSUNEcnA2VHFzSnpyczREc2lKanFzSUFnN0lLczY1Mjg3S2VBNnJPZ0xDRHJ1SXpybmJ6c21yRHNvSURzbDVRZ0l1eWVtT3VxdSt1UW5DQlBRWFYwYUNEc21wVHNzcTBnd3JjZ1kyeHBaVzUwWDJsa0lPdW5wT3F3bk91emdPeUltT3F3Z0NEcmlJVHJuYjNya0pqc2w0anNpclhyaTRqcmk2UWk2ckNBSU91Y3JPdUxwQzRLTHk4Z0lDRHNpNnp0bFpqcnFiUWc2N2lNNjUyODdKcXc3S0NBNnJDQUlPeVZoT3lZaUNEc2xZZ2c3SmUwNjZhdzY0dWtLT3lMcE95NG9TQXlNREkyTFRBNE9pQkRURWtnN1pTRTY2R2M3SVM0N0lxazY0cVVJT3VNZ09xNHNDRHNwSkhzbmJqcmpiQWc3TEM5N0oyMElPeVZpQ0RybkxncExnb3ZMeURzbmJUc29Kd2dRbEpQVjFORlV1dWx2Q0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a0lPS0draUJqYkdGMVpHVWdRMHhKNnJDQUlPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJwYndnN0tlQjdLQ1JJT3lYc091THBDaERURWtnNnJpdzY3TzRJT3VQbWV5ZWtTa3VDaTh2SUNvcTdKMjBJT3F5dmV1aG5PeVhrQ0JWVWt3ZzZyQ0E2ck8xd3Jmc3BKSHFzSVFnN0lxazdZR3M2NmE5N1lxNDY2VzhJT3VMcE95TG5DRHJoS1BzcDRBZzY2ZVFJT3F5Z3k0cUtpRHFzNFRzb0pVZzdLQ0U3Wm1ZN0oyQUlPeUt1ZXlkdUNEdG1aVHJxYlFnN1pXWTY0dW9JRnZxczRUc29KVWc3S0NFN1ptWVhTRHJzb1R0aXJ6c25MenJvWnd1Q2dvdkx5RHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU8yVWhPdWhuT3lFdU95S3BDQW9ZMnhoZFdSbElHRjFkR2dnYkc5bmFXNGdMUzFqYkdGMVpHVmhhU2tnNG9DVUlDOXZjR1Z1TFd4dloybHU3SjIwSU95RG5leUVzY0szNnJTQTY2YXNMZ292THlEcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHJzN1RyZ3JUc3BJUWc2NVdNNnJtTTdLZUFJT3lJcU95V3RPeUVuQ0RyaklEcXVMRHRsWmpyaTZUcXNJQXNJT3laaE91ampPdVFtT3VwdENEc2lxVHNpcVRyb1p3ZzY0R2Q2NEtjNjR1a0xncHNaWFFnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNLYkdWMElHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2JuVnNiRHNLYkdWMElHeHZaMmx1VTNSaGNuUmxaRUYwSUQwZ01Ec2dMeThnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFZzdJdWM2ckNCSU9LQWxDRHNucXp0Z2JUcnBxM3NuYlFnSit5ZXJPeUxuT3VQaENmc25ianNwNEFnSit5ZWtPdVBtZXlaaE91ampDRHNpNlR0aktnbjdKMjQ3S2VBSU9xMXJPdTJoTzJWbk91THBBb3ZMeURzbmJUcnNvZ2c2NkdjNnJlNDdKMjQ3SmVRN0lTY0lPdTRqT3Vkdk95YXNPeWdnQ0Rzc0wzc25ZUWc3SXVrN0tDYzY2R2NJT3VkaE95Ym9PdUtsT3F3Z0NEaWdKUWc3WVN3NjYrNDY0U1FJTzJQdE91d3NleWRnQ0RzbmJUcXNvd2dabUZzYzJYc25id2c2NVdNNjZlTUlPeVR0T3VMcEFvdkx5QW83SXVjNnJDRTY2ZU03Snk4NjZHY0lPMk1rT3VMcU8yVm1PdXB0Q0Rzb0pYc2c0RWc3SjZzN1lHMDY2YXQ3SmVRNjQrRUlHTnRaQ0Rzc0wzc25iUWc3WXFBN0phMDY0S1k3SmlvNjR1a0tRcHNaWFFnYkc5bmFXNVhhVzVrYjNkUGNHVnVaV1FnUFNCbVlXeHpaVHNLWm5WdVkzUnBiMjRnYTJsc2JFeHZaMmx1VUhKdll5Z3BJSHNLSUNCcFppQW9iRzluYVc1UWNtOWpWR2x0WlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0d4dloybHVVSEp2WTFScGJXVnlLVHNnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J1ZFd4c095QjlDaUFnYVdZZ0tDRnNiMmRwYmxCeWIyTXBJSEpsZEhWeWJqc0tJQ0JqYjI1emRDQndJRDBnYkc5bmFXNVFjbTlqT3dvZ0lHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0NpQWdkSEo1SUhzS0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdDaUFnSUNBZ0lITndZWGR1VTNsdVl5Z25kR0Z6YTJ0cGJHd25MQ0JiSnk5UVNVUW5MQ0JUZEhKcGJtY29jQzV3YVdRcExDQW5MMVFuTENBbkwwWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0NpQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQjBjbmtnZXlCd2NtOWpaWE56TG10cGJHd29MWEF1Y0dsa0xDQW5VMGxIVkVWU1RTY3BPeUI5SUdOaGRHTm9JQ2hmWlRJcElIc2djQzVyYVd4c0tDazdJSDBLSUNBZ0lIMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwOUNnb3ZMeUR0aExRZzY0K0U3S1NSSU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxVHFzSUFnN0tPOTdKZUk3SjJFSU91VmpPeWRtQ0RzaTZUdGpLZ2c2Nm1VN0l1YzdLZUFJT0tBbENCeWRXNVVkWEp1N0oyMElPeWR0Q0RycVpUc2k1enNwNERzbmJ3ZzY1V002NmVNSURIdG1vd2c3SjZRNjQrWklPeWVyT3lMbk91UGhPMlZuT3VMcEFwamIyNXpkQ0JUUlZOVFNVOU9YMFJKUlVRZ1BTQW43WUcwNjZHYzY1T2NJT3lFdU95Rm1PeWR0Q0Rzb29Ycm80enJrSkRzbHJUc21wUXVKenNLYkdWMElITm9kWFIwYVc1blJHOTNiaUE5SUdaaGJITmxPeUF2THlBdmMyaDFkR1J2ZDI0ZzdLZUU3WmFKSU95a2tTRGlnSlFnN0o2czdJdWM2NCtFNjZHY0lPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcnBxenNwNEFnN0pXSzZyS01JTzJSbk95TG5Bb0tMeThnY21WaGMyOXU3SjJFSU95anZPdXB0Q0FuN0oyWTY0K0U3S0NCSU95aWhldWpqQ2NvNnJPRTdLQ1ZJT3lnaE8yWm1NSzM2NkdjNnJlNDdKV0U3SnVESU91VHNTa2c0b0NVSU95bmhPMldpU0RzcEpIc25iVHJqWmdnN1lTMDdKMkVJT3EzdUNEcnFaVHNpNXpzcDREcm9ad2c2NEdkNjRLMDdJU2NDaTh2SUhKMWJsUjFjbTdzblpnZ1UwVlRVMGxQVGw5RVNVVkVJT3lla091UG1TRHNucXpzaTV6cmo0VHFzSUFnN0ppYklPeWVrT3F5cWV5bW5ldXFoZXljdk91aG5DRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2YXM3S2VBSU95Vml1cXlqQ0R0bFp6cmk2UXVDaTh2SUNqc2xZZ2c2cmU0NjUrczY2bTBJT3F6aE95Z2xTRHNvSVR0bVpnZzdLZUI3WnVFSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyMElPdTJnTzJabk8yVnRDQk5RVmhmVkZWU1RsUHF1WXpzcDRBZzZyT0U3SWFOSU95VHNPeWR0T3VLbENEcnNvVHF0N2dnNG9DVUlESXdNall0TURjZzY2YXM2N2V3N0plUTdJU2NJTzJabGV5ZHVDa0tablZ1WTNScGIyNGdhMmxzYkZCeWIyTW9jbVZoYzI5dUtTQjdDaUFnYVdZZ0tIQnliMk1wSUhzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJQ0FnTHk4Z2MyaGxiR3c2ZEhKMVpldWhuQ0RybllUc200enNoSndnY0hKdlkreWRnQ0JqYldRZzZydU42NDJ3NnJpd0lPS0FsQ0F2Vk91aG5DRHRpcmpycHF6c3A3Z2c3S085N0plczdKVzhJT3luaE95bm5DQmpiR0YxWkdYcXNJQWc2ck9nN0pXRTY2R2NJT3lWaUNEcmdxanJpcFRyaTZRS0lDQWdJQ0FnSUNBdkx5QW82ck9nN0pXRUlHTnNZWFZrWmVxd2dDRHNoS1RzdVpnZzdZeU03SjI4N0oyRUlPdXN2T3F6b0NEc25vanNuTHpycWJRZzdZRzA2NkdjNjVPY0lPeVZzU0RzbDRYcmpiRHNuYlR0aXJqcXNJQWdJdXlDck95YXFTRHNwSkVpN0p5ODY2R2NJT3VuaWUyZW1Da0tJQ0FnSUNBZ0lDQnpjR0YzYmxONWJtTW9KM1JoYzJ0cmFXeHNKeXdnV3ljdlVFbEVKeXdnVTNSeWFXNW5LSEJ5YjJNdWNHbGtLU3dnSnk5VUp5d2dKeTlHSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPd29nSUNBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNBZ0lDOHZJRzFoWTA5VEwrdW1yT3VJaGV5S3BEb2djMmhsYkd3NmRISjFaZXVkdkNCd2NtOWo3SjIwSUhOb0lPcTdqZXVOc09xNHNPeWR2Q0RzaUpnZzdKNkk3SjJNSU9LQWxDQnpkR0Z5ZEZCeWIyUHNuWmdnWkdWMFlXTm9aV1Ryb1p3ZzY2ZU02NU9nQ2lBZ0lDQWdJQ0FnTHk4ZzdaU0U2NkdjN0lTNDdJcWtJT3EzdU91anVTZ3RjR2xrS2V5ZGhDRHRoclhzcDdqcm9ad2c3S0NWNjZhczdaV2M2NHVrSUNoMFlYTnJhMmxzYkNBdlZDRHJqSURzblpFcENpQWdJQ0FnSUNBZ2RISjVJSHNnY0hKdlkyVnpjeTVyYVd4c0tDMXdjbTlqTG5CcFpDd2dKMU5KUjFSRlVrMG5LVHNnZlNCallYUmphQ0FvWDJVeUtTQjdJSEJ5YjJNdWEybHNiQ2dwT3lCOUNpQWdJQ0FnSUgwS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3VzdE95TG5DQXFMeUI5Q2lBZ2ZRb2dJSEJ5YjJNZ1BTQnVkV3hzT3dvZ0lIZGhjbTFsWkZWd0lEMGdabUZzYzJVN0NpQWdhV1lnS0hkaGFYUmxjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9kMkZwZEdWeUxuUnBiV1Z5S1RzZ2QyRnBkR1Z5TG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvY21WaGMyOXVJSHg4SUZORlUxTkpUMDVmUkVsRlJDa3BPeUIzWVdsMFpYSWdQU0J1ZFd4c095QjlDbjBLQ21aMWJtTjBhVzl1SUhOMFlYSjBVSEp2WXlncElIc0tJQ0JyYVd4c1VISnZZeWdwT3dvZ0lHeHBibVZDZFdZZ1BTQW5KenNLSUNCMGRYSnVjeUE5SURBN0NpQWdMeThnN0oyMElPeUV1T3lGbU95ZHRDRHNsclRyaXBBZzZyT0U3S0NWN0oyWUlPeWVoZXllcGVxMmpPeWN2T3VobkNEcmo0VHJpcFRzcDRBZzZyaXc2NkdkSU9LQWxDRHJzSmJzbDVEc2hKd2c2ck9FN0tDVjdKMjBJT3V3bE91QWpPeVhpT3VLbE95bmdDRHJ1WVRxdFpEdGxaanJpcFFnNnJpdzdLU0FDaUFnYzJWemMybHZia0ZqWTI5MWJuUWdQU0JqYkdGMVpHVkJZMk52ZFc1MEtDazdDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHNoTGpzaFpnZzdJdWM2NCtaSU95a2tlS0FwaUFvNjZxbzY0MjRPaUFuSUNzZ1kzVnljbVZ1ZEUxdlpHVnNJQ3NnSnlrbktUc0tJQ0JqYjI1emRDQjBhR2x6VUhKdll5QTlJSE53WVhkdUtDZGpiR0YxWkdVbkxDQmJKeTF3Snl3Z0p5MHRiVzlrWld3bkxDQmpkWEp5Wlc1MFRXOWtaV3dzSUNjdExXbHVjSFYwTFdadmNtMWhkQ2NzSUNkemRISmxZVzB0YW5OdmJpY3NJQ2N0TFc5MWRIQjFkQzFtYjNKdFlYUW5MQ0FuYzNSeVpXRnRMV3B6YjI0bkxDQW5MUzEyWlhKaWIzTmxKMTBzSUhzS0lDQWdJSE5vWld4c09pQjBjblZsTENCamQyUTZJRVZOVUZSWlgwTlhSQ3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdMQW9nSUNBZ1pHVjBZV05vWldRNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ0lUMDlJQ2QzYVc0ek1pY3NJQzh2SUZCUFUwbFlPaURzbnBEcXVMQWc3WlNFNjZHYzdJUzQ3SXFrSU9xM3VPdWp1U0RzZzUzc2hMRWc0b0NVSUd0cGJHeFFjbTlqN0oyMElPcTN1T3VqdWV5bnVDRHNvSlhycHF6dGxhQWc3SWlZSU95ZWlPcXlqQW9nSUgwcE93b2dJSEJ5YjJNZ1BTQjBhR2x6VUhKdll6c0tJQ0J3Y205akxuTjBaRzkxZEM1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0NpQWdJQ0JzYVc1bFFuVm1JQ3M5SUdRdWRHOVRkSEpwYm1jb0ozVjBaamduS1RzS0lDQWdJR3hsZENCcFpIZzdDaUFnSUNCM2FHbHNaU0FvS0dsa2VDQTlJR3hwYm1WQ2RXWXVhVzVrWlhoUFppZ25YRzRuS1NrZ0lUMDlJQzB4S1NCN0NpQWdJQ0FnSUdOdmJuTjBJR3hwYm1VZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0RBc0lHbGtlQ2t1ZEhKcGJTZ3BPd29nSUNBZ0lDQnNhVzVsUW5WbUlEMGdiR2x1WlVKMVppNXpiR2xqWlNocFpIZ2dLeUF4S1RzS0lDQWdJQ0FnYVdZZ0tDRnNhVzVsS1NCamIyNTBhVzUxWlRzS0lDQWdJQ0FnYkdWMElHVjJJRDBnYm5Wc2JEc0tJQ0FnSUNBZ2RISjVJSHNnWlhZZ1BTQktVMDlPTG5CaGNuTmxLR3hwYm1VcE95QjlJR05oZEdOb0lDaGZaU2tnZXlCamIyNTBhVzUxWlRzZ2ZRb2dJQ0FnSUNCcFppQW9aWFlnSmlZZ1pYWXVkSGx3WlNBOVBUMGdKM0psYzNWc2RDY2dKaVlnZDJGcGRHVnlLU0I3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdkeUE5SUhkaGFYUmxjanNLSUNBZ0lDQWdJQ0IzWVdsMFpYSWdQU0J1ZFd4c093b2dJQ0FnSUNBZ0lHTnNaV0Z5VkdsdFpXOTFkQ2gzTG5ScGJXVnlLVHNLSUNBZ0lDQWdJQ0JwWmlBb1pYWXVhWE5mWlhKeWIzSXBJSHNLSUNBZ0lDQWdJQ0FnSUdOdmJuTjBJSEpoZHlBOUlGTjBjbWx1WnlobGRpNXlaWE4xYkhRZ2ZId2daWFl1YzNWaWRIbHdaU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNakF3S1RzS0lDQWdJQ0FnSUNBZ0lDOHZJTzJWbk91UGhDRHN0SWpxczd6cnBid2c2Nmk4N0tDQUlPdXp1T3VMcENEaWdKUWc2NkdjNnJlNDdKMjRJT3lZcE91bG1DRHNvSlhxdDV6c2k1M3NuYlFnNjRTVDdKYTA3SVNjS0d4dlp5QS9hVzRnNjVPeEtTRHJyTGpxdGF6cXNJQWc2N0NVNjRDTTY2bTBJT3lDdk8yQ3JDRHNpSmdnN0o2STY0dWtDaUFnSUNBZ0lDQWdJQ0JwWmlBb2FYTk1hVzFwZEVWeWNtOXlLSEpoZHlrcElIc0tJQ0FnSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMk5zWVhWa1pTMXNhVzFwZENjN0lDOHZJQzlvWldGc2RHanJvWndnN0pXTTY2YThJT0tHa2lEcnNvVHRpcnpzbmJRZ1crMlZuT3VQaENEc3RJanFzN3hkNjZHY0lPdXdsT3VBak9xem9DRHFzNFRzb0pVZzdLQ0U3Wm1ZN0oyRUlPeVZpT3VDdEFvZ0lDQWdJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95Q3JPeWFxU0R0bFp6cmo0UWc3TFNJNnJPOElPcXdrT3luZ0RvbkxDQnlZWGNwT3dvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9URWxOU1ZSZlIxVkpSRVVwS1RzS0lDQWdJQ0FnSUNBZ0lIMGdaV3h6WlNCcFppQW9hWE5CZFhSb1JYSnliM0lvY21GM0tTa2dld29nSUNBZ0lDQWdJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0FuWTJ4aGRXUmxMV3h2WjI5MWRDYzdJQzh2SUM5b1pXRnNkR2pyb1p3ZzdaU002NStzNnJlNDdKMjQ3SmVRSU95VmpPdW12Q0RpaHBJZzY3S0U3WXE4N0oyMElGdnJvWnpxdDdqc25iZ2c3WldFN0pxVVhldWhuQ0Ryc0pUcmdKd0tJQ0FnSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c2NmVNNjZPTUlPcXdrT3luZ0RvbkxDQnlZWGNwT3dvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9URTlIU1U1ZlIxVkpSRVVwS1RzS0lDQWdJQ0FnSUNBZ0lIMGdaV3h6WlNCN0NpQWdJQ0FnSUNBZ0lDQWdJSGN1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN1lHMDY2R2M2NU9jSU95WXBPdWxtRG9nSnlBcklISmhkeWtwT3dvZ0lDQWdJQ0FnSUNBZ2ZRb2dJQ0FnSUNBZ0lIMGdaV3h6WlNCN0NpQWdJQ0FnSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNBbmIyc25PeUF2THlEc2hMSHFzN1VnUFNEc2hLVHN1WmpDdCt1aG5PcTN1T3lkdUNEcmk2UWc3S0NWN0lPQklPS0FsQ0RzbHJUcmxxUWdjSEp2WW14bGJleWR0T3VUb0NEdGxiVHNvSndnS095ZXJPdWhuT3EzdU95ZHVDL3NucXpzaEtUc3VaZ2c2N08xNnJlQUtRb2dJQ0FnSUNBZ0lDQWdkeTV5WlhOdmJIWmxLRk4wY21sdVp5aGxkaTV5WlhOMWJIUWdmSHdnSnljcEtUc0tJQ0FnSUNBZ0lDQjlDaUFnSUNBZ0lIMEtJQ0FnSUgwS0lDQjlLVHNLSUNCd2NtOWpMbk4wWkdWeWNpNXZiaWduWkdGMFlTY3NJQ2hrS1NBOVBpQjdDaUFnSUNCamIyNXpkQ0J6SUQwZ1pDNTBiMU4wY21sdVp5Z25kWFJtT0NjcExuUnlhVzBvS1RzS0lDQWdJR2xtSUNoeklDWW1JQ0Z6TG1sdVkyeDFaR1Z6S0NkRVpYQnlaV05oZEdsdmJsZGhjbTVwYm1jbktTa2dZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSUdOc1lYVmtaU0J6ZEdSbGNuSTZKeXdnY3k1emJHbGpaU2d3TENBeU1EQXBLVHNLSUNCOUtUc0tJQ0J3Y205akxtOXVLQ2RqYkc5elpTY3NJQ2hqYjJSbEtTQTlQaUI3Q2lBZ0lDQXZMeURzbmJUcnI3Z2c3SU9JSU95RXVPeUZtT3ljdk91aG5DRHF0WkRzc3JUcmtKd2c2NUtrSU95WW15RHNoTGpzaFpqc25iUWc2NHVyN1o2TUlPcXhzT3VwdENEcnJMVHNpNXdnS091cXFPdU51Q0Rzb0lUdG1aZ2c3SXVjSU95RGlDRHNoTGpzaFpqc25ZUWc3S085N0oyMDdLZUFJT3lWaXVxeWpDa0tJQ0FnSUdsbUlDaHdjbTlqSUNFOVBTQjBhR2x6VUhKdll5a2djbVYwZFhKdU93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHNoTGpzaFpnZzdLS0Y2Nk9NSUNoamIyUmxJQ2NnS3lCamIyUmxJQ3NnSnlrZzRvQ1VJT3VMcE95ZGpDRHNtcFRzc3EwZzY1V01JT3VMcE95TG5DRHNpNXpyajVudGxhbnJpNGpyaTZRdUp5azdDaUFnSUNCcmFXeHNVSEp2WXlncE93b2dJSDBwT3dwOUNncG1kVzVqZEdsdmJpQnpaVzVrVkhWeWJpaDBaWGgwS1NCN0NpQWdjbVYwZFhKdUlHNWxkeUJRY205dGFYTmxLQ2h5WlhOdmJIWmxMQ0J5WldwbFkzUXBJRDArSUhzS0lDQWdJR2xtSUNnaGNISnZZeWtnY21WMGRYSnVJSEpsYW1WamRDaHVaWGNnUlhKeWIzSW9KKzJCdE91aG5PdVRuQ0RzaExqc2haanNuYlFnN0plRzdKYTA3SnFVTGljcEtUc0tJQ0FnSUdsbUlDaDNZV2wwWlhJcElISmxkSFZ5YmlCeVpXcGxZM1FvYm1WM0lFVnljbTl5S0Nmc2xaN3NoS0FnN0pxVTdMS3Q3SjIwSU95bmhPMldpU0RzcEpIc25iVHNsNURzbXBRdUp5a3BPd29nSUNBZ1kyOXVjM1FnZEdsdFpYSWdQU0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yRXRDRHNpNXpxc0lRZzdMU0k2ck84SU9LQWxDRHNoTGpzaFpqc25ZUWc3SjZzN0l1YzdKNlI3WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdJQ0F2THlEc2k1enFzSVFnN0xTSTZyTzg2NHFVSUNmc2hManNoWmdnN0tLRjY2T01KK3laZ0NEcXRhenJ0b1Rya0pqcmlwUWc3S0NjSU91cGxPeUxuT3luZ091aG5DRHJnWjNyZ3Jqcmk2UWc0b0NVSUd0cGJHeFFjbTlqN0oyWUlPeUV1T3lGbUNEc29vWHJvNHdnY21WcVpXTjA2ckNBQ2lBZ0lDQWdJQzh2SUhKMWJsUjFjbTdzblpnZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE91bHZDRHJ0b0RycGJUcnFiUWc3SldJSU91UW1PcTRzQ0RybFl6cnJMZ282NHFRNjZhd0lPMkV0T3lkaENEcmtaQWc2N0tJSU91UGpPdXB0Q0R0bEl6cm42enF0N2pzbmJnZ01UTXc3TFNJSU95Z25PMlZuT3lkaENEcmhKanF1TFRyaTZRcENpQWdJQ0FnSUdsbUlDaDNZV2wwWlhJcElIc0tJQ0FnSUNBZ0lDQmpiMjV6ZENCM0lEMGdkMkZwZEdWeU95QjNZV2wwWlhJZ1BTQnVkV3hzT3dvZ0lDQWdJQ0FnSUhjdWNtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZHRDRHJoSWpyckxRZzdKaWs2NTZZSU9xeHVPdWdwQ0RzbXBUc3NxM3NuWVFnN0tTUjY0dW83WmFJN0phMDdKcVVJT0tBbENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0bktTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUgwc0lGUlZVazVmVkVsTlJVOVZWRjlOVXlrN0NpQWdJQ0IzWVdsMFpYSWdQU0I3SUhKbGMyOXNkbVVzSUhKbGFtVmpkQ3dnZEdsdFpYSWdmVHNLSUNBZ0lIQnliMk11YzNSa2FXNHVkM0pwZEdVb1NsTlBUaTV6ZEhKcGJtZHBabmtvZXlCMGVYQmxPaUFuZFhObGNpY3NJRzFsYzNOaFoyVTZJSHNnY205c1pUb2dKM1Z6WlhJbkxDQmpiMjUwWlc1ME9pQjBaWGgwSUgwZ2ZTa2dLeUFuWEc0bkxDQW5kWFJtT0NjcE93b2dJSDBwT3dwOUNnb3ZMeURxc0puc25ZQWc2Nnk0NnJXczY2VzhJT3VxaHlEcnNvanNwN2dnNjZ5NzY0cVU3S2VBSU9xNHNPeVd0U0RpZ0pRZzdKNnM3SnFVN0xLdDdKMjA2Nm0wSUNMc25iVHNvSVRxczd3ZzY0dWs2Nlc0SU95RGlDRHNvSnpzbFlnaTdKMkVJT3lhbE9xMXJPMlZuT3VMcEFvdkx5QW83SldJSU9xM3VPdWZyT3VwdENEdGdiVHJvWnpyazV6cXNJQWc3SVN4N0l1azdaV1k2cktNSU9xd21leWRnQ0RyaTdYc25ZUWc2NWlRSU91Q3RPeUVuQ0JiUVVrZzdMYVU3TEtjSU91TmxDRHJzSnZxdUxCZDZyQ0FJT3VzdE95ZG1PdXZ1TzJWdE95bmhPdUxwQ2tLWTI5dWMzUWdZWE5yWldSRGIzVnVkQ0E5SUc1bGR5Qk5ZWEFvS1RzS0NpOHZJT3lFdU95Rm1DRHNwSURydVlRbzdJdWM2NCtaSyt5bmdPeUxuT3VzdUNEc283enNub1VwNjZXOElPdXp0T3llcGUyVm5DRHJrcVFnN1pXY0lPMkV0Q0RzaTZUdGxva2c0b0NVSU91cXFPdVRvQ0R0bUxqc3RwenNuWUFnY1hWbGRXWHJvWndnN0tlQjY2Q3M3Wm1VTGdvdkx5QnRiMlJsYk95ZGhDRHNvN3pycWJRZzZyZTRJT3VxcU91TnVPdWhuQ0FvNjR1azY2VzA2Nm0wSU95RXVPeUZtQ0RzbnF6c2k1enNucEVwTGlEdGxad2c2NnFvNjQyNDdKMkVJT3F6aE95R2pTRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdKMkFJT3kxbk95MGlDQXg3WnFNNjcrUUxnb3ZMeUJ5WlhCaGNuTmxQWHR3WVhKelpTd2dabTl5YldGMFJHVnpZMzNycGJ3ZzdLTzg2Nm0wSU8yTWpPeUxzZXE1ak95bmdDRHNuYlFnN0o2aElPeVZpT3lYa095RW5DRHNzcGpycHF6dGxaanFzNkFnZTNKaGR5d2djR0Z5YzJWa2ZldWx2Q0RyajR6cm9LVHNwSURyaTZRNkNpOHZJTzJZbGV5TG5TRHNuYlR0ZzRnZzdJdWNJT3F3bWV5ZGdDRHNoTGpzaFpqc2w1QWdJdTJZbGV5TG5ldU1nT3VobkNEcmk2VHNpNXdpNjZXOElPeWFsT3Exck8yVm1PdUtsQ0RzbnF6c21wVHNzcTBnN1lTMDdKMkVJQ29xNnJDWjdKMkFJTzJCa0NEc25xRWc3SldJN0plUTdJU2NLaW9nNjdhWjdKMjQ2NHVrTGdvdkx5RHJzNFRyajRRZzdKNmg3Snk4NjZHY0lPdTV2T3VwdENBb1lTa2c3SUtzN0oyMDdKZVFJT3VMcE91bHVDRHNtcFRzc3EwZzdZUzA3SjIwSU91QnZPeVd0Q0FuNjdDcDZyaUlJT3VMdFNmc25iUWc2NEtvN0oyWUlPdUx0ZXlkdENEcmtKanFzNkFvNjRLMDdKcXBJT3lZcE95WHZDa3NDaTh2SUNoaUtTQk5RVmhmVkZWU1RsTWc2cks5NnJPRTdKZVE3SVNjSU95RXVPeUZtT3lkdENEc25xenNpNXpzbnBIcmo3d2dKK3V3cWVxNGlDRHJpN1VuN0oyMElPeVhodXVLbENEc2c0Z2c3SVM0N0lXWTdKMjBJT3VDdE95YXFleWRoQ0RzcDREc2xyVHJncndnN0lpWUlPeWVpT3VMcENBb01qQXlOaTB3TnlEcnBxenJ0N0RzbDVEc2hKd2c3Wm1WN0oyNEtTNEtZMjl1YzNRZ1VrVlFRVkpUUlY5Q1FVUWdQU0FvZGlrZ1BUNGdkaUE5UFNCdWRXeHNJSHg4SUNoQmNuSmhlUzVwYzBGeWNtRjVLSFlwSUNZbUlIWXViR1Z1WjNSb0lEMDlQU0F3S1RzS1puVnVZM1JwYjI0Z2NuVnVWSFZ5YmloaWRXbHNaRUZ6YXl3Z2JXOWtaV3dzSUhKbGNHRnljMlVwSUhzS0lDQmpiMjV6ZENCcWIySWdQU0J4ZFdWMVpTNTBhR1Z1S0dGemVXNWpJQ2dwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJR3B2WWxOMFlYSjBJRDBnUkdGMFpTNXViM2NvS1RzZ0x5OGc3SXVjNnJDRUlPeVlpT3lDc0NEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SU95cXZTRHNvSnp0bFp3b01UTXc3TFNJS2V5ZGhDRHJoSmpxdUxnZzdKNnM3SXVjNjQrRTY0cVVJTzJQck9xNHNPMlZuT3VMcEFvZ0lDQWdhV1lnS0cxdlpHVnNJQ1ltSUVGTVRFOVhSVVJmVFU5RVJVeFRMbWx1WkdWNFQyWW9iVzlrWld3cElDRTlQU0F0TVNBbUppQnRiMlJsYkNBaFBUMGdZM1Z5Y21WdWRFMXZaR1ZzS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJxcWpyamJnZzY3T0E2cks5T2lBbklDc2dZM1Z5Y21WdWRFMXZaR1ZzSUNzZ0p5RGlocElnSnlBcklHMXZaR1ZzS1RzS0lDQWdJQ0FnWTNWeWNtVnVkRTF2WkdWc0lEMGdiVzlrWld3N0NpQWdJQ0FnSUhOMFlYSjBVSEp2WXlncE95QXZMeURzZzRnZzY2cW82NDI0NjZHY0lPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdUxwT3lkakNEc200enJzSTNzbDRYc2w1RHNoSndnN0tlQTdJdWM2Nnk0SU95ZXJPeWp2T3llaFNrS0lDQWdJSDBLSUNBZ0lHbG1JQ2gwZFhKdWN5QStQU0JOUVZoZlZGVlNUbE1nZkh3Z0lYQnliMk1wSUhOMFlYSjBVSEp2WXlncE93b2dJQ0FnYVdZZ0tDRjNZWEp0WldSVmNDa2dld29nSUNBZ0lDQmpiMjV6ZENCME1DQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQWdJR0YzWVdsMElITmxibVJVZFhKdUtHbHVjM1J5ZFdOMGFXOXVUV1Z6YzJGblpTZ3BLVHNLSUNBZ0lDQWdkMkZ5YldWa1ZYQWdQU0IwY25WbE93b2dJQ0FnSUNCMGRYSnVjeXNyT3dvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdJUzQ3SVdZSU95a2dPdTVoQ0RzbVlUcm80d2dLQ2NnS3lBb0tFUmhkR1V1Ym05M0tDa2dMU0IwTUNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcElDc2dKM01wSU9LQWxDRHNuYlR0bTRRZzdKcVU3TEt0N0oyQUlPdTVxT3Vkdk95YWxDNG5LVHNLSUNBZ0lIMEtJQ0FnSUhSMWNtNXpLeXM3Q2lBZ0lDQmpiMjV6ZENCaGMyc2dQU0JpZFdsc1pFRnpheWdwT3lBdkx5RHNucXpzaTV6cmo0UWc2NVdNSU9xd21leWRnQ0RzcDRqcnJManNuWVFnNjR1azdJdWNJT3lUdE91THBDQW9ZWE5yWldSRGIzVnVkQ0RzbmJUc3BKRWc3S2FkNnJDQUlPdXdxZXluZ0NrS0lDQWdJR3hsZENCeVlYYzdDaUFnSUNCMGNua2dld29nSUNBZ0lDQnlZWGNnUFNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhoYzJzcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNBdkx5RHRoTFFnNjQrRTdLU1JJTzJCdE91aG5PdVRuQ0R0bElUcm9aenNoTGpzaXFUcXNJQWc3S085N0oyQUlPcXl2ZXlhc0NoVFJWTlRTVTlPWDBSSlJVUXBJREh0bW93ZzdKNlE2NCtaSU95ZXJPeUxuT3VQaENEaWdKUWc3SUtzN0pxcDdKNlE3SmVRNnJLUUlPeUxwTzJNcU91aG5DRHNsWWdnNjdPMDdKMjA2cktNTGdvZ0lDQWdJQ0F2THlEc2k1enFzSVFnN0xTSTZyTzh3cmZyb1p6cXQ3anNuYmdnNjZlTTY2T013cmZ0Z2JUcm9aenJrNXdnN0ppazY2V1l3cmZzblpqcmo0VHNvSUVnN0tLRjY2T01LT3F6aE95Z2xTRHNvSVR0bVpndjY2R2M2cmU0N0pXRTdKdURMQ0JyYVd4c1VISnZZeWh5WldGemIyNHBLZXVLbEFvZ0lDQWdJQ0F2THlEc29Kd2c2Nm1VN0l1YzdLZUE2ckNBSU91VXNPdWhuQ0Rzbm9qc2xyUWc3SmVzNnJpd0lPeVZpQ0Rxc2JqcnByRHJpNlF1SU95aWhldWpqQ0RzbXBUc3NxMGc3S1NSN0oyMDZyR3c2NEtZSU95TG5PcXdoQ0RzbUlqc2dyRHNuYlFnN0phODY2ZUlJT3lWaUNEcmdxanNsWmpzbkx6cnFiUWc2NUNZN0lLMDY2YXM3S2VBSU95Vml1dUtsT3VMcEM0S0lDQWdJQ0FnYVdZZ0tITm9kWFIwYVc1blJHOTNiaUI4ZkNBaEtHVWdKaVlnWlM1dFpYTnpZV2RsSUQwOVBTQlRSVk5UU1U5T1gwUkpSVVFwSUh4OElFUmhkR1V1Ym05M0tDa2dMU0JxYjJKVGRHRnlkQ0ErSURRd01EQXdLU0IwYUhKdmR5QmxPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0lTNDdJV1k3SjIwSU8yRXRDRHJqNFRzcEpFZzY0R0s2cm1BSU9LQWxDRHNucXpzaTV6cmo1a2c3WnVFSURIdG1vd2c3SjZzN0l1YzY0K0U3WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdJQ0J6ZEdGeWRGQnliMk1vS1RzS0lDQWdJQ0FnWVhkaGFYUWdjMlZ1WkZSMWNtNG9hVzV6ZEhKMVkzUnBiMjVOWlhOellXZGxLQ2twT3dvZ0lDQWdJQ0IzWVhKdFpXUlZjQ0E5SUhSeWRXVTdDaUFnSUNBZ0lIUjFjbTV6SUQwZ01qc2dMeThnN0p1TTY3Q043SmVGSURFZ0t5RHNuYlRyc29nZzdZUzBJQ2h6ZEdGeWRGQnliMlBzbmJRZ01PeWN2T3VobkNEc3RJanF1TER0bVpRcENpQWdJQ0FnSUhKaGR5QTlJR0YzWVdsMElITmxibVJVZFhKdUtHRnpheWs3Q2lBZ0lDQjlDaUFnSUNCcFppQW9JWEpsY0dGeWMyVXBJSEpsZEhWeWJpQnlZWGM3Q2lBZ0lDQnNaWFFnY0dGeWMyVmtJRDBnY21Wd1lYSnpaUzV3WVhKelpTaHlZWGNwT3dvZ0lDQWdMeThnN1ppVjdJdWRJT3lkdE8yRGlPeWR0T3VwdENEcXNKbnNuWUFnN0lTNDdJV1l3cmZxc0puc25ZQWc3SjZoN0plUTdJU2NJT3F6cCt5ZXBTRHNucXpzbXBUc3NxMGc0b0NVSU95ZHRDRHRoTFRzbmJRZzdLTzk3Snk4NjZtMElPeURpQ0RzaExqc2haanNuWUFnSit1d3FlcTRpQ0RyaTdVbjdKMkVJT3Vxc091ZHZBb2dJQ0FnTHk4ZzdLZUE3SmEwNjRLOElPeUltQ0Rzbm9qc25MenJyNERyb1p3ZzdJUzQ3SVdZSU95Q3JPdW5uU0RzbnF6c2k1enJqNFRyaXBRZzdaV1k3S2VBSU95Vml1cXpvQ0RxdDdqcmpJRHJvWndnN0l1azdZeW83SXVjN1lLbzY0dWtLTzJNak95THNTRHNpNlR0aktqcm9ad2c2cmVBNnJLd0tTNEtJQ0FnSUdsbUlDaFNSVkJCVWxORlgwSkJSQ2h3WVhKelpXUXBJQ1ltSUVSaGRHVXVibTkzS0NrZ0xTQnFiMkpUZEdGeWRDQThJRGN3TURBd0tTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0akl6c2k3RWc3SXVrN1l5b0lPS0FsQ0R0bUpYc2k1MGc3SjZzN0pxVTdMS3RPaWNzSUZOMGNtbHVaeWh5WVhjcExuTnNhV05sS0RBc0lETXdNQ2twT3dvZ0lDQWdJQ0IwZFhKdWN5c3JPd29nSUNBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0FnSUhKaGR5QTlJR0YzWVdsMElITmxibVJVZFhKdUtDZnJzS25xdUlnZzY0dTE3SjIwSU95YWxPcTFyTzJWbkNEdG1KWHNpNTNzbDVBZzdKYTA2cmlMNjRLczY0dWtMaURyc0tucXVJZ2c2NHUxN1pXY0lPdUN0T3lhcWV5ZGhDRHNoS1RycW9YQ3QreUNyT3F6dk1LMzdMMlU2NU9jN1k2YzdJcWtJT3lYaHV5ZHRDRHNsWVRybnBnZ1NsTlBUdXljdk91aG5PdW5qQ0RyaTZUc2k1d2c3TGFjNjZDbDdaV1k2NTI4T2lBbklDc2djbVZ3WVhKelpTNW1iM0p0WVhSRVpYTmpLVHNLSUNBZ0lDQWdJQ0J3WVhKelpXUWdQU0J5WlhCaGNuTmxMbkJoY25ObEtISmhkeWs3Q2lBZ0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3llck95YWxPeXlyU0RzaTZUdGpLZ2c0b0NVSU95VmhPdWVtT3lYa095RW5DRHRqSXpzaTdFZzdJdWs3WXlvNjZHY0lPeXltT3VtckNBcUx5QjlDaUFnSUNCOUNpQWdJQ0JwWmlBb1VrVlFRVkpUUlY5Q1FVUW9jR0Z5YzJWa0tTa2dZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTWpPeUxzU0RzaTZUdGpLZ2dLT3llck95YWxPeXlyU0R0bTRUc2w1RHJqNFFwT2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJRE13TUNrcE93b2dJQ0FnY21WMGRYSnVJSHNnY21GM0xDQndZWEp6WldRNklGSkZVRUZTVTBWZlFrRkVLSEJoY25ObFpDa2dQeUJ1ZFd4c0lEb2djR0Z5YzJWa0lIMDdDaUFnZlNrN0NpQWdMeThnN1pXY0lPeWFsT3l5cmV5ZHRDRHNpNlR0aktqdGxiVHJqNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzbmJUc2xyVHNwNERyajRUcm9aMGc3WUdRNjRxVUlPMlZyZXlEZ1NEc2hMSHFzN1hzbkx6cm9ad2c3S0NWNjZhc0NpQWdjWFZsZFdVZ1BTQnFiMkl1WTJGMFkyZ29LQ2tnUFQ0Z2UzMHBPd29nSUhKbGRIVnliaUJxYjJJN0NuMEtDaTh2SU91eWhPMkt2Q0RybmJ6cnNxZ2c2cmVjN0xtWklPS0FsQ0R0bEl6cm42enF0N2pzbmJqc25iUWdKK3V5aE8yS3ZPeWRoQ0RxczZqcm5wRHJpNlFuNnJPZ0lPeVZqT3VncE95a2hDRHJsWXpycDR3ZzdKYTU2NHFVNjR1a0xnb3ZMeURyc29UdGlyd2c2Nnk0NnJXczY0cVVJT3VzdU95ZXBleWR0Q0RzbFlUcmk0anJuYndnNjQrWjdKNlJJT3lkdE91bWhPeWR0T3lXdE95RW5Dd2c3SjIwSU95bmdPeUxuT3F3Z0NEc2w0YnNuTHpycWJRZzY2eTQ3SjZsN1ppVklPdU1nT3lWaU95ZHRDRHNoSjdzbDZ3ZzY0S1k3SmlvNjR1a0xncGpiMjV6ZENCQ1ZWUlVUMDVmVWxWTVJTQTlDaUFnSit5ZHRDRHJyTGpxdGF6cmlwUWdLaXJyc29UdGlyd2c2NTI4NjdLb0tpcnNuYlRyaTZRdUlPdXN1T3llcGV5ZHRDRHNsWVRyaTRqcm5id2c2NCtaN0o2UklPeWR0T3VtaE95ZHRPdXZnT3VobkRvZzY2ZUk3TG1vN1pHY3dyZnJyTHpzbll6dGtaekN0K3lpaGVxeXNPeVd0T3V2dUNoKzdKcVVMMzdyaTZRdmZ1cTVqT3lhbENrZzZyaUk3S2VBTENBbklDc0tJQ0FuNjVDWTY0K0U2NkdkSU95bnAreWRnQ0RyajVuc25wRWc2NnFGN0lLc0tPeWdnT3llcGNLMzdJS3Q3S0Njd3Jmc2w3RHFzckFnN1pXMDdLQ2NJT3VUc1Nucm9ad3NJTzJHdGV1enRPeUVzU0RyaTZqc25id2c2N0tFN1lxODdKMjA2Nm0wSUNMdG1aWHNuYmdpTGlBbklDc0tJQ0FuSXV5M3FPeUdqQ0xyaXBRZzY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1JT3lUc09xem9Dd2c3Wm1VNjZtMElPcTRzT3VLcGV1cWhTanJzNERxc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bk93b0tMeThnNjZ5NDZyV3NJT3kybE95eW5DRHRoTFFnS0hKdmJHVTlKK3V5aE8yS3ZDZnNuYlRycWJRZzY3S0U3WXE4SU9xM25PeTVtZXlkaENEc2xybnJpcFRyaTZRcENtWjFibU4wYVc5dUlHRnphME5zWVhWa1pTaDBaWGgwTENCdGIyUmxiQ3dnY21Wd1lYSnpaU3dnY205c1pTa2dld29nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJR0YwZEdWdGNIUWdQU0FvWVhOclpXUkRiM1Z1ZEM1blpYUW9kR1Y0ZENrZ2ZId2dNQ2tnS3lBeE93b2dJQ0FnWVhOclpXUkRiM1Z1ZEM1elpYUW9kR1Y0ZEN3Z1lYUjBaVzF3ZENrN0NpQWdJQ0JwWmlBb1lYTnJaV1JEYjNWdWRDNXphWHBsSUQ0Z01qQXdLU0JoYzJ0bFpFTnZkVzUwTG1Oc1pXRnlLQ2s3SUM4dklPdXN0TzJWbk8yZWlDRHNqSlBzbmJUc3A0QWc3SldLNnJLTUNpQWdJQ0JqYjI1emRDQnlkV3hsSUQwZ2NtOXNaU0E5UFQwZ0ordXloTzJLdkNjZ1B5QkNWVlJVVDA1ZlVsVk1SU0E2SUNjbk93b2dJQ0FnY21WMGRYSnVJSEoxYkdVZ0t5QW9ZWFIwWlcxd2RDQStJREVLSUNBZ0lDQWdQeUFuNnJDWjdKMkFJT3VzdU9xMXJPdWx2Q0RyaTZUc2k1d2c3SnFVN0xLdDdaV2M2NHVrTGlEc25iUWc3SVM0N0lXWTdKZVE3SVNjSU95ZHRPeWdoT3lYa0NEc29KenNsWWp0bG9qcmpaZ2c2cktENjVPazZyTzhJT3F5dWV5NW1PeW5nQ0RzbFlycmlwUXNJT3Exck95aHNPdUNtQ0RzbHJUdG5KanFzSUFnN1ptVjdJdWs3WjZJSU91THBPdWx1Q0RzZzRqcm9aenNtclFnNjR5QTdKV0lJRFBxc0p6cnBid2c2cmVjN0xtWjY0eUE2NkdjSUVwVFQwNGc2N0N3N0plMDY2R2M2NmVNT2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb2RHVjRkQ2tLSUNBZ0lDQWdPaUFuNjR1azdKMk1JRlZKSU91c3VPcTFyT3lkbUNEcmpJRHNsWWdnTStxd25PdWx2Q0RxdDV6c3VabnJqSURyb1p3Z1NsTlBUaURyc0xEc2w3VHJvWnpycDR3NklDY2dLeUJLVTA5T0xuTjBjbWx1WjJsbWVTaDBaWGgwS1NrN0NpQWdmU3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBPd3A5Q2dvdkx5RHJzb2pzbDYwZzdZUzBJT0tBbENEcXNKbnNuWUFnN0lTNDdJV1k3SjJFSU95VHNPdVFtQ3dnN0oyMDY3S0lJTzJFdE91bmpDRHN0cFRzc3B3ZzdaaVY3SXVkS0VwVFQwNGc2N0N3N0plMEtTRHJqSURzaTZBZzY3S0k3SmV0SU8yWWxleUxuU2hLVTA5T0lPcXduZXl5dENuc25ZUWc3SnFVNnJXczdaV2M2NHVrQ21aMWJtTjBhVzl1SUdGemExUnlZVzV6YkdGMFpTaDBaWGgwTENCdGIyUmxiQ3dnY21Wd1lYSnpaU2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJQ2dLSUNBZ0lDZnNuYlRyc29nZzdKcVU3TEt0N0oyQUlPdXlpT3lYclNEc25wSHNsNFhzbmJUcmk2UWdLT3VzdU9xMXJDRHJpNlRyazZ6cXVMQWc3SldFNjR1WUlPS0FsQ0RyaklEc2xZZ2dNK3F3bkNEcXQ1enN1Wm5zbllBZzdKMjA2N0tJSU8yRXRPeVhrQ0Rzb0lIc21xbnRsWmpzcDRBZzdKV0s2NHFVNjR1a0tTNGdKeUFyQ2lBZ0lDQW42NHVrN0oyTUlGVkpJT3VzdU9xMXJPcXdnQ0R0bFp6cXRhM3NsclRycWJRZzdKNlE3SmV3N0lxazY1K3M3SnEwSU95WWdleVd0T3VobkN3ZzdKaUI3SmEwNjZtMElPeWVrT3lYc095S3BPdWZyT3lhdENEdGxaenF0YTNzbHJUcm9ad2c2N0tJN0pldDdaV1k2NTI4TGlBbklDc0tJQ0FnSUNkVlNTRHJyTGpxdGF6cmk2VHNtclFnNnJDRTZyS3c3WldjSU8yUm5PMlloT3lkaENEc2s3RHFzNkFzSU95ZHRPdW1oTUszN0lpcjdKNlF3cmZycDRqc2lxVHRncm5DdCsyVWpPdWdpT3lkdE95S3BPMlpnT3VObE91S2xDRHF0N2pyaklEcm9ad2c2N08wN0tHMDdaV2M2NHVrTGlBbklDc0tJQ0FnSUNmc201RHJyTGpzblpnZzdLU0VJT3lJbU91bHZDRHF0N2pyaklEcm9ad2c3SnlnN0tlQTdaV2M2NHVrSU9LQWxDRHNtNURyckxqc25iUWc3WldjSU95a2hPeWR0T3VwdENEcnNvanNsNjNyajRRZzdaV2NJT3lraE91aG5Dd2c3S1NFNjdDVTZyK0k3SjJFSU95ZWhPeWRtT3VobkNEc3RwVHFzSUR0bFpqc3A0QWc3SldLNjRxVTY0dWtMaUFuSUNzS0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzZyQ2Q3TEswSU8yVm1PdUNtT3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUxwT3lhdE1LMzdJU2s2NnFGSU9xNGlPeW5nRG9nSnlBckNpQWdJQ0FuZXlKMGNtRnVjMnhoZEdWa0lqb2dJdXV5aU95WHJldXN1Q0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpTENBaVpHbHlaV04wYVc5dUlqb2dJbXR2NG9hU1pXNGc2NWlRNjRxVUlHVnU0b2FTYTI4aWZUb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLSFJsZUhRcENpQWdLU3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBPd3A5Q2dvdkx5RHJqSUR0bVpUdG1KVWc2Nnk0NnJXc0lPeWduT3lla1NEdGhMUWc0b0NVSU95Q3JPeWFxZXlla09xd2dDRHNnNEh0bWFuc25ZUWc3SVNrNjZxRjdaV1k2Nm0wSU91bnBldWR2ZXlYa0NEcnA1N3JpcFFnNjZ5NDZyV3M2Nlc4SU91bmpPdVRwT3lXdE95a2dPdUxwQzRLTHk4Z2JXVnpjMkZuWlhNNklGdDdjbTlzWlRvbmRYTmxjaWQ4SjJGemMybHpkR0Z1ZENjc0lIUmxlSFI5WFNEc29JVHNzclFnNjR5QTdabVU2Nlc4SU91bnBPdXlpQ0Ryc0p2cmlwVHJpNlFvNjR1azY2YXM2NHFVSU91c3RPeURnZTJEbkNEaWdKUUtMeThnN0p1TTY3Q043SmVGSU95bmdPeUxuT3VzdU95ZG1DQWk3SnFVN0xLdDY1T2s3SjJBSU95RW5PdWhuQ0RyckxUcXRJQWlJT3lnaE95Z25PdWx2Q0RzcDREdGdxVHF1TEFnN0p5RTdaVzBJT3VNZ08yWmxDRHJwNlhybmIzc25ZUWc3WVMwSU95VmlPeVhrQ0RycXIzcmxZVWc3SXVqNjRxVTY0dWtLUzRLWm5WdVkzUnBiMjRnWVhOclEyOXRjRzl6WlNodFpYTnpZV2RsY3l3Z2JXOWtaV3dzSUhKbGNHRnljMlVwSUhzS0lDQnlaWFIxY200Z2NuVnVWSFZ5Ymlnb0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCMGNtRnVjMk55YVhCMElEMGdLRzFsYzNOaFoyVnpJSHg4SUZ0ZEtTNXRZWEFvS0cwcElEMCtDaUFnSUNBZ0lDaHRMbkp2YkdVZ1BUMDlJQ2RoYzNOcGMzUmhiblFuSUQ4Z0oreVd0T3lMbk95S3BPMkV0TzJLdURvZ0p5QTZJQ2ZzZ3F6c21xbnNucEE2SUNjcElDc2dVM1J5YVc1bktHMHVkR1Y0ZENCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTVRVd01Da0tJQ0FnSUNrdWFtOXBiaWduWEc0bktUc0tJQ0FnSUhKbGRIVnliaUFvQ2lBZ0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJQ0xyaklEdG1aVHRtSlVnNjZ5NDZyV3NJT3lnbk95ZWtTTHNuYlRyaTZRZ0tPcTRzT3lodENEcnJManF0YXdnNjR1azY1T3M2cml3SU95VmhPdUxtQ0RpZ0pRZzdKV0U2NTZZSU91TWdPMlpsT3F3Z0NEc25iVHJzb2dnN1lTMDdKMllJT3lnaE95eXRDRHJwNlhybmIzc25iVHJpNlFwTGlBbklDc0tJQ0FnSUNBZ0oreUNyT3lhcWV5ZWtPcXdnQ0R0bVpUcnFiUWc3SU9CN1ptcHdyZnJwNlhybmIzc25ZUWc3SVNrNjZxRjdaV1k2Nm0wTENEc2lxVHRnNERzbmJ3ZzZyZWM3TG1aNnJPOElPeVlpT3lMbkNEdGhxVHNsNUFnNjZlZTY0cVVJRlZKSU91c3VPcTFyT3VsdkNEcnA0enJrNlRzbHJRZzdLQ2M3SldJN1pXWTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPdW5wZXVkdmV5ZHRDRHJ0b0Rzb2JIdGxaanJxYlFnN1k2NDdaV1k2cktNSU91UW1PdXN2T3lXdE91ZHZEb2c3SmEwNjVha0lPMlpsT3VwdE1LMzZyaXc2NHFsN0oyWUlPdXN1T3Exck95ZHVPeW5nQ3dnNjVPazdKYTA2ckNJSU95ZWtPdW1yT3VLbENEc2xyVHJsSlRzbmJqc3A0QW83WXlkN0plRklPMkRnT3lkdE8yTGdDL3JzN2pyckxndjY3S0U3WXE4TENEdGhxRHNpcVR0aXJnc0lPdTVpQ0R0bVpUcnFiUWc3SldJNjRLMExDRHJzTERyaElnZzY1T3hLU3dnN0phMDY1YWtJT3lEZ2UyWnFleWR1T3luZ0Nqc2hMSHFzN1VnN1lhMTY3TzBMK3lZcE91bG1DL3RtWlhzbmJnZzdKcVU3TEt0TCt5VmlPdUN0Q2tnNnJDWjdKMkFJT3F5Z3k0ZzZyeXRJTzJWaE95YWxPMlZuQ0Rxc29QcnA0d2c2ck9vNjUyOElPMlZuQ0Ryc29qc2w1QWc3TFdjNjR5QUlETHFzSnpxdVl6c3A0QXNJT3lucCtxeWpDNGc3SjIwNjVXTUlITjFaMmRsYzNScGIyNXo2NHFVSU91NWlDRHJzTERzbDdRdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnNnJDUTdKMjBJT3lXdE91S2tDRHNvSlhyajRRZzdKaWs2Nm0wSU91c3UrcTRzT3VuakNEdGxaanNwNEFnNjZlSTY1MjhJT0tBbENEcXNJRHNvSlhzbllRZzdJUzQ3SnF3NnJPZ0lPeTBpT3lWaUNCemRXZG5aWE4wYVc5dWMrdWx2Q0R0bGFqcXU1Z2c2NEswNjZtMDdJU2NMQ0J5WlhCc2VleVhrQ0Rxc0lEc29KWHNuWVFnNjdDZDdaNkk2ck9nSU91c3RPeVhoK3lkaENEc2xZenJvS1Rzbzd6cnFiUWc2NDJVSU91bm51eTJuQ0RzaUpnZzdKNkk2NHFVN0tlQUlPMlZuQ0Ryckxqc25xWHNuTHpyb1p3ZzY0Mm42N2FaN0plczY1MjhLT3lZaURvZ0l1MlpsZXlkdUNEdGpKM3NsNFhzbmJUcm5ienFzNkFnNnJDQTdLQ1Y3WmFJN0phMDdKcVVJT0tBbENEdGhxRHNpcVR0aXJqcm5ienJxYlFnN0pXTTY2Q2s3S084N0lTNDdKcVVJaWt1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2Nnk0NnJXczY2VzhJT3lnbk95VmlPMlZvQ0RybFpBZzdJU2M2NkdjSU95Z2tlcTN2T3lkdENEcmk2VHJwYmdnTW40ejZyQ2NMaURxc0lFZzdLQ2M3SldJN0plVUlPeVpuQ0RxdDdqcm9JZnFzb3dnN0kyODY0cVU3S2VBSU95ZHRPeWNvT3VsdkNEcnRwbnNuYmpyaTZRdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN0lLczdKcXA3SjZRNnJDQUlPeVd1T3E0aWUyVm1PeW5nQ0RzbFlyc25ZQWc2cldzN0xLMElPeWdsZXV6dENqc29JVHRtWlRyc29qdG1MakN0MVZTVE1LMzZyaUk3Sldod3JmdG1wL3NpSmdnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjRTajdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEdG00VHNobzBnN0pxVTdMS3RLQ0xyalpRZzdLZW42cktNSWl3Z0l1dXloTzJLdk95YXFleWN2T3VobkNJZzY1T3hLZXlkdE91cHRDRHNwNEhzb0lRZzdLQ2M3SldJN0oyRUlPcTN1Q0Ryc0tudGxxWHNuTHpyb1p3ZzZyT2c3TE9RSU91THBPeUxuQ0Rzb0p6c2xZanRsWmpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1VnNnJpSTdLZUFPaUFuSUNzS0lDQWdJQ0FnSjNzaWNtVndiSGtpT2lBaTY0eUE3Wm1VSU95ZGtldUx0U0R0bFp6cmtaQWc2Nnk0N0o2bElDanRsYlRzbXBUc3NyUXBJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FnN1pXY0lPdXN1T3llcFNKOVhYMWNibHh1SnlBckNpQWdJQ0FnSUNkYjY0eUE3Wm1VWFZ4dUp5QXJJSFJ5WVc1elkzSnBjSFFLSUNBZ0lDazdDaUFnZlN3Z2JXOWtaV3dzSUhKbGNHRnljMlVwT3dwOUNnb3ZMeUR0bElUcm9JanNub1RyczRRbzdaV1k3SnlFSU8yVWhPdWdpT3llaENEcnJMYnNuWXdwSU95MmxPeXluQ0R0aExRZzRvQ1VJTzJWbkNEdG1aVHJxYlRzbllRZzdaV1k3SnlFSU8yVWhPdWdpT3llaENEcmk2anNuSVRyb1p3ZzY0S1k2NGlnSU91enRPdUN0T3F6b0N3S0x5OGdLaXJ0bElUcm9JanNub1RycDRqcmk2UWc2NVN3NjZHY0tpb2c2NHlBN0pXSTdKMkVJT3V3bSt1S2xPdUxwQzRnN1pXY0lPeWFsT3l5cmV5WGtDRHJpNlFnN0l1azdKYTBJT3V6dE91Q3RPdUtsQ0Rxc29Qc25iUWc3WlcxN0l1c09nb3ZMeUR0bElUcm9JanNub1FnN0lpWTY2ZU03WUc4SU95YWxPeXlyZXlkaENEc3FyenFzSnpycWJRZzZyZTQ2NmVNN1lHOElPdUtrT3VncE95bmdPcXpvQ2pxc0lFZ05YNHhNT3kwaUNrZzZyV3M2NCtGSU95Q3JPeWFxZXVmaWV1UGhDRHF0N2pycDR6dGdid2c2NEtZNnJDRTY0dWtMZ292THlCbmNtOTFjSE02SUZ0N2JtRnRaU3dnZEdWNGRITTZXMTE5WFNBbzdabVU2Nm0wSU95Y2hPS0drdXlWaE91ZW1DRHNpSndwTGdwbWRXNWpkR2x2YmlCaGMydEhjbTkxY0hNb1ozSnZkWEJ6TENCdGIyUmxiQ3dnY21Wd1lYSnpaU3dnYlc5eVpTa2dld29nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lIc0tJQ0FnSUM4dklPdXloTzJLdkNEc21JSHNsNjNzbllBZ0tPdXloTzJLdkNuc25MenJvWndnN0xDTjdKYTBJT3V6dE91Q3VPdUxwQ0RpZ0pRZzY3S0U3WXE4SU91c3VPcTFyT3VLbENEcnJManNucVhzbmJRZzdKV0U2NHVJNjUyOElPdVBtZXlla1NEc25iVHJwb1RzbmJUcm5id2c2cmVjN0xtWjdKMjBJT3VMcE91bHRPdUxwQW9nSUNBZ1kyOXVjM1FnYkdsemRDQTlJQ2huY205MWNITWdmSHdnVzEwcExtMWhjQ2dvWnl3Z2FTa2dQVDRLSUNBZ0lDQWdKMXNuSUNzZ0tHa2dLeUF4S1NBcklDZGRJQ2NnS3lCVGRISnBibWNvS0djZ0ppWWdaeTV1WVcxbEtTQjhmQ0FvSitxM3VPdWp1U2NnS3lBb2FTQXJJREVwS1NrZ0t5QW9aeUFtSmlCbkxuSnZiR1VnUFQwOUlDZnJzb1R0aXJ3bklEOGdKeUFvNjdLRTdZcThLU2NnT2lBbkp5a2dLeUFuWEc0bklDc0tJQ0FnSUNBZ0tHY2dKaVlnUVhKeVlYa3VhWE5CY25KaGVTaG5MblJsZUhSektTQS9JR2N1ZEdWNGRITWdPaUJiWFNrdWJXRndLQ2gwS1NBOVBpQW5JQ0F0SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoVGRISnBibWNvZENCOGZDQW5KeWtwS1M1cWIybHVLQ2RjYmljcENpQWdJQ0FwTG1wdmFXNG9KMXh1SnlrN0NpQWdJQ0JqYjI1emRDQm9ZWE5DZEc0Z1BTQW9aM0p2ZFhCeklIeDhJRnRkS1M1emIyMWxLQ2huS1NBOVBpQm5JQ1ltSUdjdWNtOXNaU0E5UFQwZ0ordXloTzJLdkNjcE93b2dJQ0FnWTI5dWMzUWdhMlY1SUQwZ0oyZHliM1Z3Y3ljZ0t5QW9aM0p2ZFhCeklIeDhJRnRkS1M1dFlYQW9LR2NwSUQwK0lDaG5JQ1ltSUdjdWRHVjRkSE1nUHlCbkxuUmxlSFJ6TG1wdmFXNG9KeWNwSURvZ0p5Y3BLUzVxYjJsdUtDY25LVHNLSUNBZ0lHTnZibk4wSUdGMGRHVnRjSFFnUFNBb1lYTnJaV1JEYjNWdWRDNW5aWFFvYTJWNUtTQjhmQ0F3S1NBcklERTdDaUFnSUNCaGMydGxaRU52ZFc1MExuTmxkQ2hyWlhrc0lHRjBkR1Z0Y0hRcE93b2dJQ0FnYVdZZ0tHRnphMlZrUTI5MWJuUXVjMmw2WlNBK0lESXdNQ2tnWVhOclpXUkRiM1Z1ZEM1amJHVmhjaWdwT3dvZ0lDQWdZMjl1YzNRZ1lXZGhhVzRnUFNCdGIzSmxJSHg4SUdGMGRHVnRjSFFnUGlBeENpQWdJQ0FnSUQ4Z0oreWR0Q0R0bVpUcnFiVHNuWUFnN0oyMElPeUV1T3lGbU95WGtPeUVuQ0RzbmJUcnI3Z2c2NHVrNjZTWTY0dWtMaURzbFo3c2hKd2c2NEs0SU91TWdPeVZpT3F6dkNEc2xyVHRuSmpDdCtxMXJPeWhzT3F3Z0NEdG1aWHNpNlR0bm9nZzY0dWs2Nlc0SU95RGlDRHJqSURzbFlqcnA0d2c2NEswNjUyOExseHVKd29nSUNBZ0lDQTZJQ2NuT3dvZ0lDQWdjbVYwZFhKdUlDZ0tJQ0FnSUNBZ1lXZGhhVzRnS3dvZ0lDQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0FpN1ptVTY2bTA3SjJFSU8yVm1PeWNoQ0R0bElUcm9JanNub1RyczRUcm9ad2c2NEtZNjRpZ0lPdUxwT3VUck9xNHNDTHJpNlF1SU95VmhPdWVtT3VLbENEdGxad2c3Wm1VNjZtMDdKMllJT3VzdU9xMXJPdWx2Q0R0bFpqc25JUWc3WlNFNjZDSTdKNkVLT3lZZ2V5WHJTa2c2NHVvN0p5RTY2R2NJT3VzdHV5ZGdDRHFzb1BzbmJUcmk2UXVYRzRuSUNzS0lDQWdJQ0FnSnlvcTdKaUI3SmV0NjZlSTY0dWtJT3VVc091aG5Db3FJT3VNZ095VmlPeWRoQ0RyZ3JUcm5id2c0b0NVSU95WWdleVhyZXlkaENEc2hKenJvWndnN1pXcDdMbVk2ckd3NjRLWUlPeUluT3lFbk91bHZDRHJzSlRxdnJqc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU9xd2dTRHNtSUhzbDYzc2w1QWc2NHlBN0pXSUlETHFzSnd1SU9xM3VDRHNtSUhzbDYzc25iUWc3SmVzNjUrc0lPeWtoT3lkdE91cHRDRHJqSURzbFlqcmo0UWdLaXJxc0puc25ZQWc3S1NFSU95SW1Db3E2NkdjS095a2hPdXdsT3EvaUNCY1hHN3NuTHpyb1p3ZzZyV3M2N2FFTENEc3BJUWc3SWljN0lTY0lPeWNvT3luZ0NrdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN0ppQjdKZXQ3SjJZSU95WHJlMlZvQ2p0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcThJT3VUc1NucXM3d2c3SnVRNjZ5NDdKMllJT3lnbGV1enRNSzM3S0d3NnJHMEtPeUlxK3lla01LMzY0eUE3SU9Cd3Jmc29iRHFzYlFwN0oyQUlPeWNvT3luZ08yVm1PcXpvQ3dnN0plRzY0cVVJT3lnbGV1enRPdWx2Q0RzcDREc2xyVHJnclRzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3F6b095NW9DRHFzb3dnN0plRzY0cVVJT3lZZ2V5WHJleWR0T3VwdENEcmpJRHNsWWdnTWVxd25PdW5qQ0RyZ3JUcXNiRHJncGdnNjdtSUlPdXdzT3lYdE91aG5DRHJrWkRzbHJUcmo0UWc2NUNjNjR1a0lPS0FsQ0RzbHJYc3A0RHJvWndnNjdDVTZyNjQ3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHRtWlRycWJRZzZyaXc2NHFsNjZxRktPdXpnT3F5dmNLMzdaVzA3S0NjSU91VHNTbnNuWUFnNnJlNDY0eUE2NkdjSU91UmxPdUxwQzVjYmljZ0t3b2dJQ0FnSUNBb2FHRnpRblJ1SUQ4Z0p5MGdLT3V5aE8yS3ZDbnNuTHpyb1p3ZzdaR2M3SXVjNjVDY0lPeVlnZXlYcmV5ZGdDQW5JQ3NnUWxWVVZFOU9YMUpWVEVVZ09pQW5KeWtnS3dvZ0lDQWdJQ0FuNjR1MTdKMkFJT3V3bU91VG5PeUxuQ0JLVTA5T0lPcXduZXl5dENEdGxaanJncGpycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaGNLMzdMMlU2NU9jN1k2YzdJcWtJT3E0aU95bmdEcGNiaWNnS3dvZ0lDQWdJQ0FuZXlKbmNtOTFjSE1pT2lCYmV5SnVZVzFsSWpvZ0l1eVlnZXlYclNEc25iVHJwb1FvN0o2RjY2Q2w2ck84SU91UG1leWR2Q2tpTENBaWMzVm5aMlZ6ZEdsdmJuTWlPaUJiZXlKMFpYaDBJam9nSXV1TWdPeVZpQ0RyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FnN1pXY0lPdXN1T3llcFNKOVhYMWRmVnh1SnlBckNpQWdJQ0FnSUNmc21JSHNsNjNzbllBZzdKNkY2NkNsSU95SW5PeUVuTUszNnJDYzdJaVk2Nlc4SU9xM3VPdU1nT3VobkNEc3A0RHRncWpyaTZRdVhHNWNiaWNnS3dvZ0lDQWdJQ0FuVyt5WWdleVhyZXV6aENEcnJManF0YXhkWEc0bklDc2diR2x6ZEFvZ0lDQWdLVHNLSUNCOUxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0NuMEtDaTh2SU8yVWhPdWdpT3llaE91emhDRHN0cFRzc3B3ZzdKMlI2NHUxN0plUTdJU2NJRnQ3Ym1GdFpTd2djM1ZuWjJWemRHbHZibk02VzN0MFpYaDBMQ0J5WldGemIyNTlYWDFkSU95MmxPeTJuQXBtZFc1amRHbHZiaUJ3WVhKelpVZHliM1Z3Y3loeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzhnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ1kyOXVjM1FnWVhKeUlEMGdRWEp5WVhrdWFYTkJjbkpoZVNodklDWW1JRzh1WjNKdmRYQnpLU0EvSUc4dVozSnZkWEJ6SURvZ1cxMDdDaUFnSUNCamIyNXpkQ0JuY205MWNITWdQU0JoY25JdWJXRndLQ2huS1NBOVBpQW9ld29nSUNBZ0lDQnVZVzFsT2lCVGRISnBibWNvS0djZ0ppWWdaeTV1WVcxbEtTQjhmQ0FuSnlrdWRISnBiU2dwTEFvZ0lDQWdJQ0J6ZFdkblpYTjBhVzl1Y3pvZ1FYSnlZWGt1YVhOQmNuSmhlU2huSUNZbUlHY3VjM1ZuWjJWemRHbHZibk1wQ2lBZ0lDQWdJQ0FnUHlCbkxuTjFaMmRsYzNScGIyNXpDaUFnSUNBZ0lDQWdJQ0FnSUM1dFlYQW9LSGdwSUQwK0lDaDBlWEJsYjJZZ2VDQTlQVDBnSjNOMGNtbHVaeWNLSUNBZ0lDQWdJQ0FnSUNBZ0lDQS9JSHNnZEdWNGREb2dlQzUwY21sdEtDa3NJSEpsWVhOdmJqb2dKeWNnZlFvZ0lDQWdJQ0FnSUNBZ0lDQWdJRG9nZXlCMFpYaDBPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNTBaWGgwS1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQ0J5WldGemIyNDZJRk4wY21sdVp5Z29lQ0FtSmlCNExuSmxZWE52YmlrZ2ZId2dKeWNwTG5SeWFXMG9LU0I5S1NrS0lDQWdJQ0FnSUNBZ0lDQWdMbVpwYkhSbGNpZ29lQ2tnUFQ0Z2VDNTBaWGgwS1FvZ0lDQWdJQ0FnSURvZ1cxMHNDaUFnSUNCOUtTazdDaUFnSUNBdkx5RHNuYlRycG9Uc29iRHNzS2dnN0plRzZyT2dJT3lnbk95VmlPdVBoQ0RzbDRicmlwUWc2cnVONjQydzZyaXc2NmVNSU95WmxPeWN2T3VwdENEdG1KWHNpNTBnN0oyMDdZT0k2NkdjSU91enVPdUxwQ2pxc0puc25ZQWc3SVM0N0lXWTdKZVFJT3llck95YWxPeXlyU2tLSUNBZ0lISmxkSFZ5YmlCbmNtOTFjSE11YzI5dFpTZ29aeWtnUFQ0Z1p5NXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ3BJRDhnWjNKdmRYQnpJRG9nYm5Wc2JEc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V3b2dJQ0FnY21WMGRYSnVJRzUxYkd3N0NpQWdmUXA5Q2dvdkx5RHRqSjNzbDRVZzdJUzQ3WXE0SU95MmxPeXluQ0R0aExRZzRvQ1VJTzJWbkNEdGpKM3NsNFhzblpnZzZyV3M3SVN4N0pxVTdJYU1LT3lYcmUyVm9DdnJyTGpxdGF3cDY2VzhJTzJWbkNEcnNvanNsNUFnNjdPMDY0SzA2ck9nTEFvdkx5RHNtcFRzaG96cnM0UWc2NEt4NnJDYzZyQ0FJT3lWaE91TGlPdWR2Q0FxS3V5WmhPeUVzZXVRbkNEdGpKM3NsNFVnN0lTNDdZcTRLT3k4Z095ZHRPeUtwQ2tnTW40ejZyQ2NLaXJycGJ3ZzdZYTE3Snk4NjZHY0lPdXdtK3VLbE91THBDNEtMeThnN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2T3lkdENEdGxad2c2NnE0N0p5ODY2R2NJT3lkdk9xMGdPdVB2T3lWdkNEdGxaanJyNERyb1p3bzY1U3c2NkdjSU91OWtleVZoQ0Rzb2JEdGxhbnRsWmpycWJRZzdKYTA2cmlMNjRLYzY0dWtLU0RzaExqdGlyZ2c2NHVvN0p5RTY2R2NJT3lnbk95VmlPMlZtT3F5akNEdGxaenJpNlF1Q2k4dklHVnNaVzFsYm5Sek9pQmJlM0p2YkdVc0lIUmxlSFI5WFNBbzdabVU2Nm0wSU95Y2hPS0drdXlWaE91ZW1DRHNpSndwTGdvdkx5QnRiM0psUFhSeWRXVW9XK3k4Z095ZHRPeUtwQ0RyalpRZzY3Q2I2cml3WFNucnFiUWc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRycjdnZzY0SzRJT3lFdU8yS3VPeVpnQ0Rxc3Juc3VaanNwNEFnN0pXSzY0cVVJT3lEaUNEc2hManRpcmpycGJ3ZzdKcVU2cldzN1pXYzY0dWtMZ3BtZFc1amRHbHZiaUJoYzJ0UWIzQjFjQ2hsYkdWdFpXNTBjeXdnYlc5a1pXd3NJSEpsY0dGeWMyVXNJRzF2Y21VcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0NpQWdJQ0JqYjI1emRDQnliMnhsY3lBOUlDaGxiR1Z0Wlc1MGN5QjhmQ0JiWFNrdWJXRndLQ2hsS1NBOVBpQlRkSEpwYm1jb0tHVWdKaVlnWlM1eWIyeGxLU0I4ZkNBbkp5a3BMbXB2YVc0b0p5d2dKeWs3Q2lBZ0lDQmpiMjV6ZENCc2FYTjBJRDBnS0dWc1pXMWxiblJ6SUh4OElGdGRLUzV0WVhBb0tHVXNJR2twSUQwK0NpQWdJQ0FnSUNocElDc2dNU2tnS3lBbkxpQmJKeUFySUZOMGNtbHVaeWdvWlNBbUppQmxMbkp2YkdVcElIeDhJQ2NuS1NBcklDZGRJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2hUZEhKcGJtY29LR1VnSmlZZ1pTNTBaWGgwS1NCOGZDQW5KeWtwQ2lBZ0lDQXBMbXB2YVc0b0oxeHVKeWs3Q2lBZ0lDQXZMeURxc0puc25ZQWc3WXlkN0plRjdKMkVJT3VxaHlEcnNvanNwN2dnNjZ5NzY0cVU3S2VBSU9xNHNPeVd0U0RpZ0pRZzdKNnM3SnFVN0xLdDdKMjA2Nm0wSUNMc25iVHNvSVRxczd3ZzY0dWs2Nlc0SU95RXVPMkt1Q0xycGJ3ZzdKcVU2cldzN1pXYzY0dWtDaUFnSUNBdkx5QW9ZWE5yUTJ4aGRXUmw3Sm1BSU9xd21leWRnQ0RzbmJUc25LQTZJT3lWaUNEcXQ3anJuNnpycWJRZzdZRzA2NkdjNjVPYzZyQ0FJT3F3bWV5ZGdDRHNoTGp0aXJqcnBid2c2NWlRSU91Q3RPeUVuQ0JiN0x5QTdKMjA3SXFrSU91TmxDRHJzSnZxdUxCZDZyQ0FJT3VzdE95ZG1PdXZ1TzJWdE95bmhPdUxwQ2tLSUNBZ0lHTnZibk4wSUd0bGVTQTlJQ2R3YjNCMWNBRW5JQ3NnS0dWc1pXMWxiblJ6SUh4OElGdGRLUzV0WVhBb0tHVXBJRDArSUZOMGNtbHVaeWdvWlNBbUppQmxMblJsZUhRcElIeDhJQ2NuS1NrdWFtOXBiaWduQVNjcE93b2dJQ0FnWTI5dWMzUWdZWFIwWlcxd2RDQTlJQ2hoYzJ0bFpFTnZkVzUwTG1kbGRDaHJaWGtwSUh4OElEQXBJQ3NnTVRzS0lDQWdJR0Z6YTJWa1EyOTFiblF1YzJWMEtHdGxlU3dnWVhSMFpXMXdkQ2s3Q2lBZ0lDQnBaaUFvWVhOclpXUkRiM1Z1ZEM1emFYcGxJRDRnTWpBd0tTQmhjMnRsWkVOdmRXNTBMbU5zWldGeUtDazdJQzh2SU91c3RPMlZuTzJlaUNEc2pKUHNuYlRzcDRBZzdKV0s2cktNQ2lBZ0lDQmpiMjV6ZENCaFoyRnBiaUE5SUcxdmNtVWdmSHdnWVhSMFpXMXdkQ0ErSURFS0lDQWdJQ0FnUHlBbjdKMjBJTzJNbmV5WGhleWRnQ0RzbmJRZzdJUzQ3SVdZN0plUTdJU2NJT3lkdE91dnVDRHJpNlRycEpqcmk2UXVJT3lWbnV5RW5DRHNvSnpzbFlqdGxad2c3SVM0N1lxNDY1T2s2ck84SUNvcTdLQ1I2cmU4d3Jmc2xyVHRuSmpxc0lBZzdabVY3SXVrN1o2SUlPdUxwT3VsdUNEc2c0Z2c3SVM0N1lxNEtpcnJwNHdnNjRLMDY1MjhLT3F3bWV5ZGdDRHNoTGp0aXJnZzY3Q1k2N08xSU9xNGlPeW5nQ2t1WEc0bkNpQWdJQ0FnSURvZ0p5YzdDaUFnSUNCeVpYUjFjbTRnS0FvZ0lDQWdJQ0JoWjJGcGJpQXJDaUFnSUNBZ0lDZnNuYlRyc29nZzdKcVU3TEt0N0oyQUlDTHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1NEc2hManRpcmdnNjR1azY1T3M2cml3SXV1THBDNGc3SldFNjU2WTY0cVVJTzJWbkNEdGpKM3NsNFhzbllRZzdKeUU0b2FTN0pXRTY1Nlk2NkdjSU91Q21PeVh0TzJWbkNEcXRhenNoTEhzbXBUc2hvenJrNlRzbmJUcmk2UW83SVNjNjZHY0lPdXN0T3EwZ08yVm5DRHJzNFRxc0p3ZzY2eTQ2cldzNnJDQUlPeVZoT3VMaU91THBDa3VJQ2NnS3dvZ0lDQWdJQ0FuN0pxVTdJYU02Nlc4SU91Q3NlcXduT3VobkNEcXM2RHN1WmpzcDRBZzY2ZVE2ck9nTENBcUt1MkRnT3lkdE8yTGdNSzM3SldJNjRLMHdyZnJzb1R0aXJ6c25iUWc3SVNjNjZHY0lPeWR2T3EwZ091UW5DQWk3Sm1FN0lTeDY1Q2NJTzJNbmV5WGhTRHNoTGp0aXJnaUlESitNK3F3bkNvcTY2VzhJT3lnbk95VmlPMlZtT3VkdkM0ZzZyQ0JJT3lFdU8yS3VPdUtsQ0RzaEp6cm9ad2c2NHVrNjZXNElPeWdrZXEzdk95ZHRPeVd0T3lWdkNEdGxaenJpNlF1WEc0bklDc0tJQ0FnSUNBZ0orcXdnU0RzaExqdGlyanJpcFFnN0o2RjY2Q2w2ck84SUNvcTZyQ1o3SjJBSU95WHJlMlZvTUszNnJDWjdKMkFJT3F3bk95SW1NSzM2ckNaN0oyQUlPeUluT3lFbkNvcTdKMllJT3lhbE95R2pPdWx2Q0RycXFqcmtaQWc3WStzN1pXbzdaV2M2NHVrTGlEc2hManRpcmdnN0pXSTdKZVE3SVNjSU8yRGdPeWR0TzJMZ01LMzdKV0k2NEswd3JmcnNvVHRpcnpzbllBZzdaV2NJT3VxdU95Y3ZPdWhuQ0RycDU3c2xZVHJscWpzbHJUc29ManNsYndnN1pXYzY0dWtLT3lZaURvZzY3TzQ2Nnk0N0oyMElDSis3WldnNnJtTTdKcVVQeUxycWJRZzY3S0U3WXE4N0oyQUlGdnNsWVRyaTRqc21LUmRMMXZyaEtSZEtTNWNiaWNnS3dvZ0lDQWdJQ0FuVysyTW5leVhoU0Ryckxqc3NyUWc2cmVjN0xtWklPS0FsQ0RzbklRZzdJcWs3WU9BN0oyOElPcXdnT3lkdE91VG5PeWRtQ0FpT0M0ZzdZeWQ3SmVGSWlEc2hMbnNoWmpzbllRZzY1U3c2Nlc0NjR1a1hWeHVKeUFyQ2lBZ0lDQWdJQ2N0SU8yRGdPeWR0TzJMZ0RvZzdLZW43SjJBSU91cWhleUNyT3ExckNneWZqVHNsclRzb0lncExDRHNvb1hxc3JEc2xyVHJyN2pDdCt1bmlPeTVxTzJSbkNEc2w0YnNuYlFvZnV5YWxDOSs2NHVrTDM3cXVZenNtcFEvSU9xNGlPeW5nQ2t1SU91d21PdVRuT3lMbkNEc2xZanJnclFvNjdPNDY2eTRLU0RycDZYcm5iM3NuWVFnN0pxVTdKVzk3WlcwSU8yRGdPeWR0TzJMZ091bmpDRHJ0SkRyajRRZzY2eTA3SXFvSU8yTW5leVhoZXlkdU95bmdDRHNsWXpxc293ZzdaV1k2NTI4TGlEc201RHJzN2pzbmJRZ0l1eVZqT3VtdkMvdG1aWHNuYmdpN0xLWTY1KzhJT3VuaWV5WHNPMlZtT3VwdENEcnM3anJyTGpzbllRZzZyZTg2ckd3NjZHY0lPcTFyT3l5dE8yWmxPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RzbFlqcmdyUW82N080NjZ5NEtUb2c3WlcwN0pxVTdMSzBMaUR0akpEcmk2anNuYlFnN1pXRTdKcVU3WldZNjZtMElDSis3WldnNnJtTTdKcVVQeUxyb1p3ZzY2eTc2ck9nTENEcmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHNuSVR0bDVnbzdJS3Q3S0Njd3JmdGc0anRoN1FnNjVPeEtleWRnQ0Rxc3JEcXM3enJwYndnNjZpODdLQ0FJT3F5dmVxem9PMlZuT3VMcEM0ZzZyS3c2ck84d3Jmc2c0SHRnNXdnN1lhMTY3TzA2Nm0wSU95RW5PeUlvTzJZbGV5Y3ZPdWhuQ0RzbFl6cnByRHJpNlF1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2N0tFN1lxOE9pRHJzN2pyckxqc25iUWdJbjd0bGFEcXVZenNtcFEvSXV1cHRDQmI3SldFNjR1STdKaWtYUzliNjRTa1hTd2c2N080NjZ5NDdKMjBJT3lEZ2UyWnFleWRoQ0RzaEp6c2lLRHRsWmpxczZBZzdKMjBJT3V5aE8yS3ZPeWR0Q0RzaTZUc29Kd2c2NCtaN0o2UjdKMjA2Nm0wSU91UG1leWVrU0RyajVuc2dxd283SUt0N0tDY0wreWdnT3llcFMvc2w3RHFzckFnN1pXMDdLQ2NJT3VUc1Nrc0lPMkd0ZXV6dENEdGpKM3NsNFhzblpnZzY0dW83SjI4SU91eWhPMkt2T3lkdE91cHRDQWk3Wm1WN0oyNElpNGdJdXkzcU95R2pDTHJpcFFnNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUxDQWk2NHVyNnJpd3dyZnJqNW5zbnBFaUlPeWhzTzJWcVNEcXVJanNwNEF1SU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGdDRHF0N2pyaklEcm9ad2c2NUdVNjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2N0SU95YmtPdXN1T3lkbUNEc29KWHJzN1RDdCt5aHNPcXh0Q2pzaUt2c25wREN0K3lkdE95RGdTL3NuYlR0bFpqQ3QrdU1nT3lEZ1Nuc25ZQWc3SnlnN0tlQTdaV1k2ck9nTENEc201RHJyTGpzbDVBZzdKZUc2NHFVSU95Z2xldXp0TUszN0tDSTdMQ293cmZzbDdEcm5iM3NzcGpycGJ3ZzdLZUE3SmEwNjRLMDdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuNjR1MTdKMkFJT3V3bU91VG5PeUxuQ0JLVTA5T0lPcXduZXl5dENEdGxaanJncGpycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaGNLMzdMMlU2NU9jN1k2YzdJcWtJT3E0aU95bmdEcGNiaWNnS3dvZ0lDQWdJQ0FuZXlKelpYUnpJam9nVzNzaWNtVmhjMjl1SWpvZ0l1eWR0Q0RzaExqdGlyanNuWmdnNjdDcDdaYWw3SjJFSU8yVm5PcTFyZXlXdENEdGxad2c2Nnk0N0o2bDdKeTg2NkdjSWl3Z0ltVnNaVzFsYm5Seklqb2dXM3NpY205c1pTSTZJQ0xzbDYzdGxhQWlMQ0FpZEdWNGRDSTZJQ0xyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJbjBzSUM0dUxsMTlMQ0F1TGk1ZGZWeHVKeUFyQ2lBZ0lDQWdJQ2ZzbDYzdGxhRHNuWUFnN0o2RjY2Q2xJT3lJbk95RW5PdU1nT3VobkRvZ0p5QXJJSEp2YkdWeklDc2dKMXh1WEc0bklDc0tJQ0FnSUNBZ0oxdnRqSjNzbDRVZzdKcVU3SWFNWFZ4dUp5QXJJR3hwYzNRS0lDQWdJQ2s3Q2lBZ2ZTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93cDlDZ292THlEdGpKM3NsNFVnN0oyUjY0dTE3SmVRN0lTY0lIdHpaWFJ6T2lCYmUzSmxZWE52Yml3Z1pXeGxiV1Z1ZEhNNlczdHliMnhsTEhSbGVIUjlYWDFkZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxVRzl3ZFhBb2NtRjNLU0I3Q2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdDaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4N1cxeHpYRk5kS2x4OUx5azdDaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0J2SUQwZ1NsTlBUaTV3WVhKelpTaHpLVHNLSUNBZ0lHTnZibk4wSUhObGRITkpiaUE5SUVGeWNtRjVMbWx6UVhKeVlYa29ieUFtSmlCdkxuTmxkSE1wSUQ4Z2J5NXpaWFJ6SURvZ1cxMDdDaUFnSUNCamIyNXpkQ0J6WlhSeklEMGdjMlYwYzBsdUNpQWdJQ0FnSUM1dFlYQW9LSE4wS1NBOVBpQW9ld29nSUNBZ0lDQWdJSEpsWVhOdmJqb2dVM1J5YVc1bktDaHpkQ0FtSmlCemRDNXlaV0Z6YjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tzQ2lBZ0lDQWdJQ0FnWld4bGJXVnVkSE02SUVGeWNtRjVMbWx6UVhKeVlYa29jM1FnSmlZZ2MzUXVaV3hsYldWdWRITXBDaUFnSUNBZ0lDQWdJQ0EvSUhOMExtVnNaVzFsYm5SekNpQWdJQ0FnSUNBZ0lDQWdJQ0FnTG0xaGNDZ29aV3dwSUQwK0lDaDdJSEp2YkdVNklGTjBjbWx1Wnlnb1pXd2dKaVlnWld3dWNtOXNaU2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd2dkR1Y0ZERvZ1UzUnlhVzVuS0NobGJDQW1KaUJsYkM1MFpYaDBLU0I4ZkNBbkp5a3VkSEpwYlNncElIMHBLUW9nSUNBZ0lDQWdJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tHVnNLU0E5UGlCbGJDNTBaWGgwS1FvZ0lDQWdJQ0FnSUNBZ09pQmJYU3dLSUNBZ0lDQWdmU2twQ2lBZ0lDQWdJQzVtYVd4MFpYSW9LSE4wS1NBOVBpQnpkQzVsYkdWdFpXNTBjeTVzWlc1bmRHZ3BPd29nSUNBZ2NtVjBkWEp1SUhObGRITXViR1Z1WjNSb0lEOGdjMlYwY3lBNklHNTFiR3c3Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNLSUNBZ0lISmxkSFZ5YmlCdWRXeHNPd29nSUgwS2ZRb0tMeThnNjR5QTdabVU3WmlWSU95Z25PeWVrU0RzblpIcmk3WHNsNURzaEp3Z2UzSmxjR3g1TENCemRXZG5aWE4wYVc5dWMxdGRmU0RzdHBUc3Rwd2dLT3k5bE91VG5PMk9uT3lLcE1LMzdKV2U2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3BDbVoxYm1OMGFXOXVJSEJoY25ObFEyOXRjRzl6WlNoeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzhnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ1kyOXVjM1FnY21Wd2JIa2dQU0JUZEhKcGJtY29LRzhnSmlZZ2J5NXlaWEJzZVNrZ2ZId2dKeWNwTG5SeWFXMG9LVHNLSUNBZ0lHTnZibk4wSUhOMVoyZGxjM1JwYjI1eklEMGdRWEp5WVhrdWFYTkJjbkpoZVNodklDWW1JRzh1YzNWbloyVnpkR2x2Ym5NcENpQWdJQ0FnSUQ4Z2J5NXpkV2RuWlhOMGFXOXVjd29nSUNBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIc2dkR1Y0ZERvZ1UzUnlhVzVuS0NoNElDWW1JSGd1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lCVGRISnBibWNvS0hnZ0ppWWdlQzV5WldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZTa3BDaUFnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOVBpQjRMblJsZUhRcENpQWdJQ0FnSURvZ1cxMDdDaUFnSUNCcFppQW9jbVZ3YkhrZ2ZId2djM1ZuWjJWemRHbHZibk11YkdWdVozUm9LU0J5WlhSMWNtNGdleUJ5WlhCc2VTd2djM1ZuWjJWemRHbHZibk1nZlRzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNsWVRybnBqcm9ad2dLaThnZlFvZ0lISmxkSFZ5YmlCdWRXeHNPd3A5Q2dvdkx5RHJzb2pzbDYwZzdKMlI2NHUxN0plUTdJU2NJSHQwY21GdWMyeGhkR1ZrTENCa2FYSmxZM1JwYjI1OUlPeTJsT3kybkNBbzdMMlU2NU9jN1k2YzdJcWt3cmZzbFo3cmtxUWc3SjZoNjR1MElPMlhpT3lhcVNrS1puVnVZM1JwYjI0Z2NHRnljMlZVY21GdWMyeGhkR1VvY21GM0tTQjdDaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXg3VzF4elhGTmRLbHg5THlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnZJRDBnU2xOUFRpNXdZWEp6WlNoektUc0tJQ0FnSUdOdmJuTjBJSFJ5WVc1emJHRjBaV1FnUFNCVGRISnBibWNvS0c4Z0ppWWdieTUwY21GdWMyeGhkR1ZrS1NCOGZDQW5KeWt1ZEhKcGJTZ3BPd29nSUNBZ2FXWWdLSFJ5WVc1emJHRjBaV1FwSUhKbGRIVnliaUI3SUhSeVlXNXpiR0YwWldRc0lHUnBjbVZqZEdsdmJqb2dVM1J5YVc1bktDaHZJQ1ltSUc4dVpHbHlaV04wYVc5dUtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwN0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3SldFNjU2WTY2R2NJQ292SUgwS0lDQnlaWFIxY200Z2JuVnNiRHNLZlFvS0x5OGc3SjJSNjR1MTdKZVE3SVNjSUh0MFpYaDBMQ0J5WldGemIyNTlJT3V3c095WHRDRHN0cFRzdHB3Z0tPeTlsT3VUbk8yT25PeUtwTUszN0pXZTY1S2tJT3llb2V1THRDRHRsNGpzbXFrcENtWjFibU4wYVc5dUlIQmhjbk5sVTNWbloyVnpkR2x2Ym5Nb2NtRjNLU0I3Q2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdDaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4YlcxeHpYRk5kS2x4ZEx5azdDaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0JoY25JZ1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdhV1lnS0VGeWNtRjVMbWx6UVhKeVlYa29ZWEp5S1NrZ2V3b2dJQ0FnSUNCeVpYUjFjbTRnWVhKeUNpQWdJQ0FnSUNBZ0xtMWhjQ2dvZUNrZ1BUNGdLSHNnZEdWNGREb2dVM1J5YVc1bktDaDRJQ1ltSUhndWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd2djbVZoYzI5dU9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmU2twQ2lBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvZUNrZ1BUNGdlQzUwWlhoMEtUc0tJQ0FnSUgwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNsWVRybnBqcm9ad2dLaThnZlFvZ0lISmxkSFZ5YmlCYlhUc0tmUW9LTHk4ZzY2R2M2cmU0N0oyNElPMlZoT3lhbE1LMzdaV2M2NCtFSU95MGlPcXp2Q0RzZzRIdGc1enNuYndnNjVXTUlDOW9aV0ZzZEdnZzdLR3c3WnFNNnJDQUlPeVlwT3VwdENEcmtxVHNsNURzaEp3ZzdKdU02N0NON0plRjdKMkVJT3VMcE95TG5DRHNpNXpyajRUdGxiVHJzN2pyaTZRZ0tETXc3TFNJN0plUUlESHJzb2pycDR3cExnb3ZMeURzaExIcXM3WHRsWmpycWJRZzZyS3c2ck84SU8yVnVPdVRwT3Vmck9xd2dDQmpiR0YxWkdWVGRHRjBkWE05SjI5ckordWhuQ0Rya0pqcmo0enJwcXpycjREcm9ad3NJT3llck91aG5PcTN1T3lkdUNEdG00UWc2N0tFN1lxODdKMjBJT3lnZ095Z2lPdWhuQ0R3bjUraTdKeTg2NkdjSU91enRlcTNnTzJWbk91THBDNEtMeThnS08yVWpPdWZyT3EzdU95ZHVPeWR0Q0Ryb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3lYc0NEcmtxUWc3S084NnJpdzdLQ0I3Snk4NjZHY0lDOW9aV0ZzZEdqcnBid2c3S0d3N1pxTTdaV1k2NHFVSU9xeWcrcXp2Q0RzcDUzc25ZUWc3SjIwNjZPczY0dWtLUW92THlEdGxaenJqNFFnN0xTSTZyTzg2NCtFSU9xd21leWRnQ0Rxc3Izcm9aenJvWndnNjdPMTZyZUE3SXVjN1lLbzY0dWtJT0tBbENEcXRJRHJwcXpzbnBEcXNJQWc3WldjNjQrRTY2VzhJT3lZck91Z3BPeWp2T3F4c091Q21DRHRsWnpyajRUcXNJQWc3TFNJNnJpdzdabVU2NUNZNjZtMENpOHZJT3lDck95YXFleWVrT3F3Z0NEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU91SWpPdWZyT3VQaENEcnNvVHRpcnpzbmJRZzhKK2ZvdXljdk91aG5DRHJqNHpzbFlUc21LanJpNlF1SU8yVm5PdVBoT3lYa0NEcXNianJwckFnN1ppNDdMYWM3SjJBSU9xeHNPeWdpT3VRbU91dmdPdWhuQ0RzZ3F6c21xbnJuNG5zbllBZzdKV0lJT3VDbU9xd2hPdUxwQW92THlEcXM0VHNvSlhzbmJRZ0tpcnJzSmJzbDVEc2hKd3FLaURyc0pUcmdKQWc2cktEN0oyRUlPeVZqT3lWaE95eGlPdUxwQ0FvTWpBeU5pMHdPQ3dnUWxKSlJFZEZYMVk5TWpZcExnb3ZMeUR0aExEcnI3anJoSkRzbmJUcmdwZ2c2N2lNNjUyODdKcXc3S0NBN0plUTdJU2NJT3VMcE91bHVDRHFzNFRzb0pYc25MenJvWndnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3lla09xeXFleW1uZXVxaFNEdGpJenNuYnpzbllBZzY3Q1U2NENNN0tlQTY2ZU1MQ0RzbmJUcnI3Z2c2NWFnSU95ZWlPdUtsQ0JqYkdGMVpHVUtMeThnN0lTNDdJV1k3SjJBSU95TG5PdVBtZTJWb0NEcmxZd2c2N0NiN0oyQUlPeVlteURxczRUc29KVWc3SjZGN0o2bDZyYU03SjJFSU9xM3VPdU1nT3VobkNEc2s3VHJpNlFnNG9hU0lPeURpQ0RxczRUc29KWHNsNUFnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaENEc25vanNsclRyajRRZ0l1MlZuT3VQaENEc3RJanFzN3dpNnJDQUNpOHZJT3F6aE95R2pTRHJncGpzbUtqcmk2UW9NakF5Tmkwd09DRHNpNlRzdUtFZzdJdWc2ck9nT2lBaTdJT0lJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxvanJpcFRyamJBZzdKbWNJT3EzdUNEcXM0VHNvSlVnN0lLczdKcXA2NStKN0oyRUlPdXF1eURzazdEcmc1QWlLUzRLTHk4ZzdaU002NStzNnJlNDdKMjQ3SjJFSU9xeHNPeTVuQ0Ryb1p6cXQ3anNuYmpDdCt1aG5PcTN1T3lWaE95Ymd5Z3ZiM0JsYmkxc2IyZHBic0szTDJOc1lYVmtaUzFzYjJkdmRYUXA3SjJBSUd0cGJHeFFjbTlqN0p5ODY2R2NJT3lFdU95Rm1PeWRoQ0Ryc29Ucm9LVHNoSndnN0oyMElPdXN1T3lnbk9xd2dBb3ZMeURzbDRic2w0anJpcFRyamJBc0lPdXdsdXlYa095RW5DRHJzSlRxdnJqcnFiUWc2NHVrNjZhczZyQ0FJT3lWakNEcnNLbnJzcFhzbmJRZzdKZUc3SmVJNjR1a0xpRHF0N2pybnBqc2hKd2dMMmhsWVd4MGFDRHNvYkR0bW96cnA0anJpNlFnN1l5TTdKMjg3SjJZSU9xemhPeWdsZXF6dkNEcnVZVHF0WkR0bFp6cmk2UXVDaTh2SU91NWhPeWFxU0F3S08yTWpPeWR2T3VuakNEc25iM3FzNkFzSUdOc1lYVmtaVUZqWTI5MWJuVHNuWmdnTXpEc3RJZ2c3THFRN0l1YzY2VzhJT3EzdU91TWdPdWhuQ0RzazdUcmk2UWc0b0NVSUM1amJHRjFaR1V1YW5OdmJ1eWR0Q0RzdTZUc2hKd2c2NmVrNjdLSUlPeWR2ZXluZ0NEc2xZcnJpcFRyaTZRcExnb3ZMeURxczRUc29KVWc3SjZJN0oyTUlPS0draURzbDRic25Zd282NkdjNnJlNDdKV0U3SnVES1NEcnNLbnRscVhzbllBZzZyRzA2NU9jNjZhczdLZUFJT3lWaXV1S2xPdUxwRG9nN1l5TTdKMjg3SjJFSU91TnJ1eVd0T3lUc091S2xDRHNpSnpxc0lRZzdKNmc2cm1RSU91cXV5RHNuYjNyaXBRZzZyS0Q2ck84Q2k4dklPcTFyT3UyaE91UW1PeW5nQ0RzbFlyc2xZUWc3WmViSU95ZXJPeUxuT3lla2V5ZGhDRHJ0b0RycGJUcXM2QXNJT3EzdUNEcnNLbnRscVhzbllBZzdKMjQ3S2FkSU95WXBPdWxtQ0Rxc3Izcm9ad29hWE5CZFhSb1JYSnliM0lwNnJDQUlPeWR0T3V2dUNEc3NwanJwcXp0bFp6cmk2UXVDbVoxYm1OMGFXOXVJSEpsYzNSaGNuUkpaa0ZqWTI5MWJuUkRhR0Z1WjJWa0tDa2dld29nSUdsbUlDZ2hjSEp2WXlCOGZDQjNZV2wwWlhJcElISmxkSFZ5YmpzZ0lDQWdJQ0FnSUNBdkx5RHNoTGpzaFpnZzdKZUc3SjJNS091THBPeWRqQ0R0aExUc25iUWc3SU9JNjZHY0lPeUxuT3VQbVNrZ0x5RHRoTFFnN0tlRTdaYUpJT3lra2V5ZHRPdXB0Q0RyaTZUc25Zd2c3S0d3N1pxTTdKZVE3SVNjQ2lBZ1kyOXVjM1FnYm05M0lEMGdZMnhoZFdSbFFXTmpiM1Z1ZENncE93b2dJR2xtSUNnaGJtOTNJSHg4SUc1dmR5QTlQVDBnYzJWemMybHZia0ZqWTI5MWJuUXBJSEpsZEhWeWJqc0tJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzZyT0U3S0NWN0oyMElPdXdsT3VBak95WGlPeVd0T3lhbENBb0p5QXJJQ2h6WlhOemFXOXVRV05qYjNWdWRDQjhmQ0FuN0plRzdKMk1KeWtnS3lBbklPS0draUFuSUNzZ2JtOTNJQ3NnSnlrZzRvQ1VJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91eWhPdW1yT3F6b0NEc2c0Z2c2ck9FN0tDVjdKeTg2NkdjSU91THBPeUxuQ0RzaTV6c25wSHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDaHlaV0Z6YjI0ZzdLZUE3S0NWS1NEaWdKUWdVMFZUVTBsUFRsOUVTVVZFNjZHY0lPdUJuZXVDdE91cHRDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtc091THBBb2dJR3RwYkd4UWNtOWpLQ2ZxczRUc29KWHNuYlFnNjdDVTY0Q003SmEwN0lTY0lPeUV1T3lGbU95ZGhDRHNnNGpyb1p3ZzdJdWM3SjZSN1phSTdKYTA3SnFVSU9LQWxDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5LVHNLSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c095QXZMeUR0bFp6cmo0VEN0K3Vobk9xM3VPeWR1Q0RzZzRIdGc1enJpcFFnNnJPRTdLQ1Y2NmVJNjR1a0lPdUxwT3VsdE91THBDRGlnSlFnN0lPSUlPcXpoT3lnbGV5Y3ZPdWhuQ0RyaTZUc2k1d2c3WXlRN0tDVjdaV1k2cktNQ2lBZ2MyVnpjMmx2YmtGalkyOTFiblFnUFNCdWIzYzdDbjBLQ214bGRDQnNZWE4wUVhWMGFGSmxkSEo1UVhRZ1BTQXdPd3BtZFc1amRHbHZiaUJ5WlhSeWVVRjFkR2hKWms1bFpXUmxaQ2dwSUhzS0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklDRTlQU0FuWTJ4aGRXUmxMV3h2WjI5MWRDY2dKaVlnWTJ4aGRXUmxVM1JoZEhWeklDRTlQU0FuWTJ4aGRXUmxMV3hwYldsMEp5a2djbVYwZFhKdU93b2dJR2xtSUNoM1lXbDBaWElnZkh3Z1JHRjBaUzV1YjNjb0tTQXRJR3hoYzNSQmRYUm9VbVYwY25sQmRDQThJRE13TURBd0tTQnlaWFIxY200N0lDOHZJT3luaE8yV2lTRHNwSkVnN1lTMElPdXdxZTJWdENEcXVJanNwNEFnS3lBek1PeTBpQ0Rxc0lUcXNxa0tJQ0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryb1p6cXQ3anNuYmdnN0o2czdabVY3SjI0SU95TG5PdVBoT0tBcGljcE93b2dJSEoxYmxSMWNtNG9LQ2tnUFQ0Z0ordWhuT3EzdU95ZHVDRHRtWlhzbmJqc21xbnNuYlRyaTZRdUlDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljcExuUm9aVzRvQ2lBZ0lDQW9LU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJTzJabGV5ZHVPdVFxQ0RpZ0pRZzdLQ1Y3SU9CSU95RGdlMkRuT3VobkNEcnM3WHF0NEF1Snlrc0NpQWdJQ0FvWlNrZ1BUNGdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95VmhPeW5nU0Ryb1p6cXQ3anNuYmdnN0pXSUlPdVFxRG9uTENCVGRISnBibWNvWlM1dFpYTnpZV2RsS1M1emJHbGpaU2d3TENBNE1Da3BDaUFnS1RzS2ZRb0tMeThnN0l1azdZeW9JT3lka2V1THRleWRoQ0RzZ3F6cm5venNtcWtnN0pXSTY0SzA2NkdjSU91emdPMlptQ0RpZ0pRZzdKdVE3SjI0S091aG5PcTN1T3lkdUMvc2hLVHN1WmdwN0oyMElPMk1qT3lWaGV1UW5DRHFzcjNzbXJEc2w1UWc2cmU0SU95VmlPdUN0T3VsdkN3ZzdKV0U2NHVJNjZtMElPeWdrZXVSa095V3RDdnNtNURyckxqc25ZUWc2N08wNjRLNDY0dWtDbVoxYm1OMGFXOXVJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2djSEpsWm1sNEtTQjdDaUFnYVdZZ0tHVWdKaVlnWlM1dFpYTnpZV2RsSUQwOVBTQk1UMGRKVGw5SFZVbEVSU2tnY21WMGRYSnVJSHNnWlhKeWIzSTZJRXhQUjBsT1gwZFZTVVJGTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFd4dloyOTFkQ2NnZlRzS0lDQnBaaUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQVDA5SUV4SlRVbFVYMGRWU1VSRktTQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ1RFbE5TVlJmUjFWSlJFVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiR2x0YVhRbklIMDdDaUFnYVdZZ0tHTnNZWFZrWlZOMFlYUjFjeUE5UFQwZ0oyTnNZWFZrWlMxdGFYTnphVzVuSnlrZ2V3b2dJQ0FnY21WMGRYSnVJSHNnWlhKeWIzSTZJQ2ZzbmJRZ1VFUHNsNUFnUTJ4aGRXUmxJRU52WkdVb1kyeGhkV1JsS2Vxd2dDRHNoS1RzdVpqcmo3d2c3SjZJN0tlQUlPeVZpdXlWaE95YWxDRGlnSlFnN0lTazdMbVk3WldZNnJPZ0lPdWhuT3EzdU95ZHVPMlZuQ0Rya3FRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUp5d2djSEp2WW14bGJUb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp5QjlPd29nSUgwS0lDQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ2NISmxabWw0SUNzZ0tHVWdKaVlnWlM1dFpYTnpZV2RsSUQ4Z1pTNXRaWE56WVdkbElEb2dVM1J5YVc1bktHVXBLU0I5T3dwOUNncG1kVzVqZEdsdmJpQnlaV0ZrUW05a2VTaHlaWEVwSUhzS0lDQnlaWFIxY200Z2JtVjNJRkJ5YjIxcGMyVW9LSEpsYzI5c2RtVXBJRDArSUhzS0lDQWdJR3hsZENCaWIyUjVJRDBnSnljN0NpQWdJQ0J5WlhFdWIyNG9KMlJoZEdFbkxDQW9ZeWtnUFQ0Z2V5QmliMlI1SUNzOUlHTTdJSDBwT3dvZ0lDQWdjbVZ4TG05dUtDZGxibVFuTENBb0tTQTlQaUI3Q2lBZ0lDQWdJSFJ5ZVNCN0lISmxjMjlzZG1Vb1NsTlBUaTV3WVhKelpTaGliMlI1S1NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGMyOXNkbVVvZTMwcE95QjlDaUFnSUNCOUtUc0tJQ0I5S1RzS2ZRb0tZMjl1YzNRZ1EwOVNVMTlJUlVGRVJWSlRJRDBnZXdvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFQY21sbmFXNG5PaUFuS2ljc0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFUxbGRHaHZaSE1uT2lBblIwVlVMQ0JRVDFOVUxDQlBVRlJKVDA1VEp5d0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFNHVmhaR1Z5Y3ljNklDZERiMjUwWlc1MExWUjVjR1VuTEFwOU93cG1kVzVqZEdsdmJpQnFjMjl1S0hKbGN5d2djM1JoZEhWekxDQnZZbW9wSUhzS0lDQnlaWE11ZDNKcGRHVklaV0ZrS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MFpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2dZMmhoY25ObGREMTFkR1l0T0NjZ2ZTd2dRMDlTVTE5SVJVRkVSVkpUS1NrN0NpQWdjbVZ6TG1WdVpDaEtVMDlPTG5OMGNtbHVaMmxtZVNodlltb3BLVHNLZlFvS1kyOXVjM1FnYzJWeWRtVnlJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvWVhONWJtTWdLSEpsY1N3Z2NtVnpLU0E5UGlCN0NpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RQVUZSSlQwNVRKeWtnZXlCeVpYTXVkM0pwZEdWSVpXRmtLREl3TkN3Z1EwOVNVMTlJUlVGRVJWSlRLVHNnY21WMGRYSnVJSEpsY3k1bGJtUW9LVHNnZlFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5SMFZVSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDJobFlXeDBhQ2NwSUhzS0lDQWdJSEpsYzNSaGNuUkpaa0ZqWTI5MWJuUkRhR0Z1WjJWa0tDazdJQzh2SU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2citvN0p5ODY2bTBJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91b3ZPeWdnQ0Ryc29UcnByRHJpNlFnS095VmhPdWVtQ0RzbTR6cnNJM3NsNFhzbmJRZzdKaWJJT3F6aE95Z2xleWN2T3VobkNEcmo0enNwNEFnN0pXSzZyS01LUW9nSUNBZ2NtVjBjbmxCZFhSb1NXWk9aV1ZrWldRb0tUc2dMeThnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsQ0RzZzRIdGc1enJxYlFnN0o2czdabVY3SjI0SU95TG5PdVBoQ0RpZ0pRZzdKNnM2NkdjNnJlNDdKMjQ3SjIwSU91Qm5ldUNyT3ljdk91cHRDRHJpNlRzbll3ZzdLR3c3WnFNNjdhQTdZU3dJSEJ5YjJKc1pXM3NuYlFnN1pLQTY2YXc2NHVrQ2lBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXdvZ0lDQWdJQ0J2YXpvZ2RISjFaU3dnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeXdnZGpvZ1FsSkpSRWRGWDFZc0lHUnBjam9nWDE5a2FYSnVZVzFsTENBdkx5QjJ3cmRrYVhJNklPcTFyT3V5aE95Z2hDL3NsNG5ybXJIdGxad2c3SUtzNjdPNDdKMjBJT3VXb0NEc25vanJpcFRzcDRBZzdLZUU2NHVvN0pxcENpQWdJQ0FnSUcxdlpHVnNPaUJqZFhKeVpXNTBUVzlrWld3c0lHMXZaR1ZzY3pvZ1FVeE1UMWRGUkY5TlQwUkZURk1zSUdWNFlXMXdiR1Z6T2lCRldFRk5VRXhGVXk1c1pXNW5kR2dzSUdkMWFXUmxPaUJIVlVsRVJTNXNaVzVuZEdnc0lISmxZV1I1T2lCM1lYSnRaV1JWY0N3S0lDQWdJQ0FnY0hKdllteGxiVG9nS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjI5ckp5QjhmQ0JqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJRzUxYkd3cElEOGdiblZzYkNBNklHTnNZWFZrWlZOMFlYUjFjeXdLSUNBZ0lDQWdZV05qYjNWdWREb2dZMnhoZFdSbFFXTmpiM1Z1ZENncExBb2dJQ0FnSUNCelpYSjJaV1E2SUhOMFlYUnpMbk5sY25abFpDd2diR0Z6ZEVGME9pQnpkR0YwY3k1c1lYTjBRWFFzSUd4aGMzUlVaWGgwT2lCemRHRjBjeTVzWVhOMFZHVjRkQ3dnYkdGemRGTmxZem9nYzNSaGRITXViR0Z6ZEZObFl5d0tJQ0FnSUgwcE93b2dJSDBLSUNBdkx5RHRsSXpybjZ6cXQ3anNuYmdnN0l1czdKNmw2N0NWNjQrWklPS0FsQ0RyZ1lycXVMRHJxYlFnN0p5RUlPcXdrT3lMbkNEdGc0RHNuYlRycUxqcXNJQWc2NHVrNjZhczY2VzhJT3VCaU91THBBb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OW9aV0Z5ZEdKbFlYUW5LU0I3Q2lBZ0lDQnNZWE4wUW1WaGRDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlNCOUtUc0tJQ0I5Q2lBZ0x5OGc2NkdjNnJlNDdKMjRJT0tBbENEdGxJenJuNnpxdDdqc25ianNuWmdnVy9DZm42QWc3WUcwNjZHYzY1T2NJT3Vobk9xM3VPeWR1Q0R0bFlUc21wUmR3cmRiOEorVWtWMGc2N0tFN1lxODdKMjBJTzJZdU95Mm5PMlZuT3VMcEM0S0lDQXZMeURxdUxEcnM3Z282N2lNNjUyODdKcXc3S0NBSU95bmdlMldpU2s2SUdCamJHRjFaR1VnWVhWMGFDQnNiMmRwYmlBdExXTnNZWFZrWldGcFlPdWx2Q0RzaUtqc25ZQWc3WlNFNjZHYzdJUzQ3SXFrNjZHY0lPeUxwTzJXaVNEaWdKUWc2Nm1VNjRtMElPeVhodXlkdENEcXM2ZnNucVVnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lYdE9xem9Dd0tJQ0F2THlBZ0lHeHZZMkZzYUc5emRDRHNpSmpzaTZBZzdZK3M3WXE0NjZHY0lPcXlzT3F6dk91bHZDRHNucERyajVrZzdJaVk2NkM1N1pXYzY0dWtLT3lMcE95NG9Ub2c3WmVrNjVPYzY2YXM3SXFrN0plUTdJU2M2NCtFSU91NGpPdWR2T3lhc095Z2dDRHNsN1RycHJ3Z0t5Qk1TVk5VUlU0ZzdabVY3SjI0TENBeU1ESTJMVEEzS1M0S0lDQXZMeUFnSU8yRXNPdXZ1T3VFa095ZHRDRHRtWlRycWJUc2w1QWc3S0NFN1ppQUlPeVZpQ0Rybkt6cmk2UXVJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqcnA0d2c3WldZNjZtMElPdUJuUzRLSUNBdkx5RHRqN1Ryc0xFbzdZU3c2Nis0NjRTUUtUb2c3SjZRNjQrWklPeVpoT3Vqak9xd2dDRHJwNG50bm93ZzdabVk2cks5S091NGpPdWR2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1RzbDVBZzY2cTdJT3VMdit5VmhDRHN2WlRyazV6cXNJQWc2N08wN0oyMDY0cVVJT3F5dmV5YXNDbnNsNURzaEp3S0lDQXZMeUFnSU91aG5PcTN1T3lkdUNEcmpJRHF1TEFnN0tTUklPdXloTzJLdk95ZGhDRHJtSkFnNjRpRTY2VzA2Nm0wTENEc3ZaVHJrNXpycGJ3ZzY3YVo3SmVzNjRTajdKMkVJT3lJbUNEc25vanJpcFFnN1lTdzY2KzQ2NFNRSU91d3FleUxuZXljdk91aG5DRHNvSVR0bVpqdGxaenJpNlF1Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDI5d1pXNHRiRzluYVc0bktTQjdDaUFnSUNCamIyNXpkQ0JpYjJSNUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHTnZibk4wSUhOM2FYUmphRTF2WkdVZ1BTQWhJU2hpYjJSNUlDWW1JR0p2WkhrdWMzZHBkR05vUVdOamIzVnVkQ2s3SUM4dklPcXpoT3lnbFNEc29JVHRtWmdnUFNEc2k1enRnYXpycHI4ZzdMQzk3Snk4NjZHY0lPeVh0T3lXdENEcXM0VHNvSlhzbllRZzZyT2c2Nlc4SU95SW1DRHNub2pxc293S0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUM4dklHTnNZWFZrWmVxd2dDRHNsNGJzbkx6cnFiUWc3SmVzNnJpdzdJU2NJT3VCaXV1S2xPdUxwQzRnYzJobGJHdzZkSEoxWmV1ZHZDQmpiR0YxWkdYcXNJQWc3SmVHN0phMDY0K0VJT3lGdU95ZGdDRHNvSlhzZzRFZzdJdWs3WmFKNjQrOENpQWdJQ0FnSUM4dklITndZWGR1N0oyWUlDZGxjbkp2Y2lmcXNJQWc3SldJSU91Y3FPcXpvQ3dnN0ppSTdLQ0U3SmVVSU9xM3VPdU1nT3VobkNCdmF6cDBjblZsNjZXOElPdVBqT3VncE95a3JPdUxwQ0RpZ0pRS0lDQWdJQ0FnTHk4ZzdaU002NStzNnJlNDdKMjQ3SjJBSUNMcnVJenJuYnpzbXJEc29JRHJwYndnN0plMDdKZUk3SmEwN0pxVUl1dWR2T3F6b0NEdGxaanJpcFRyamJBZzdJdWs3S0NjNjZHYzY0cVVJT3lWaE91c3RPcXlnK3VQaENEc2xZZ2c2NXlvNjRxVUlPeURnZTJEbk9xd2dDRHJrSkRyaTZRbzdJdWs3S0NjSU95TG9PcXpvQ2t1Q2lBZ0lDQWdJR2xtSUNoamJHRjFaR1ZUZEdGMGRYTWdQVDA5SUNkamJHRjFaR1V0YldsemMybHVaeWNwSUhzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Td2dld29nSUNBZ0lDQWdJQ0FnWlhKeWIzSTZJQ2ZzbmJRZ1VFUHNsNUFnUTJ4aGRXUmxJRU52WkdYcXNJQWc3SmVHN0phMDdKcVVJT0tBbENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY1Q1k2NHFVN0tlQUlPMlpsZXlkdU8yVnRDRHNvN3pzaExqc21wUXVKeXdLSUNBZ0lDQWdJQ0FnSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNzQ2lBZ0lDQWdJQ0FnZlNrN0NpQWdJQ0FnSUgwS0lDQWdJQ0FnTHk4ZzdLZUU3WmFKSU95a2tleWR1T3VOc0NEcm1KQWc2NGlNNjZDQTY0dWtJT0tBbENEc201RHN1Wm5zbllBZ0l1dTRqT3Vkdk95YXNPeWdnT3VobkNEcmk2VHNpNXdnN0plMDZyaXdJdXVMcEM0ZzdZU3c2Nis0NjRTUTdKMkFJQ29xN0xDOTdKMkVJT3lWaE91c3RPcXlnK3VQaENEcnFyc2c2NTJFN0p1ZzdKMkVJT3VWak91bmpDb3FMZ29nSUNBZ0lDQXZMeURzbUlqc29JVHNsNVFnSnpZdzdMU0lJT3VFbU9xeWpDRHJqSURxdUxBZzdLU1I3SjIwNjZtMElPMkVzT3V2dU91RWtDZnNuYlRzbDRqcmlwVHJqYkFzSU91aG5PcTN1T3lkdUNEdG1aVHJxYlRzbllRZzdKMjk2ckd3NjRLWUlPeWVvT3E1a0NEcmxMUWc3SjI4SU8yVm1PdUxwQ0RyaTZUc2k1d2c2NGlFNjZXNENpQWdJQ0FnSUM4dklPeWdsZXlEZ2V5Z2dleWR1Q0Rxc3Izc21yRHNsNURyajRRZ1kyMWtJT3l3dmV5ZHRDRHRpb0RzbHJUcmdwanNtWlRyaTZRb01qQXlOaTB3T0NEc2k2VHN1S0VnN0l1ZzZyT2dPaUFpN1lTdzY2KzQ2NFNRSU8yWmxPdXB0T3lkZ0NEc21ad2c2NWFnSU9xd2tleWVrT3E0c0NJcExnb2dJQ0FnSUNBdkx5RHNuYlRzb0p3ZzdKcXc2NmFzNnJDQUlPeXd2ZXlkaENEc3A0SHNvSkVnN0plMDZyT2dJT3lFc2VxenRTRHNsNnpydG9Bb2JHOW5hVzVYYVc1a2IzZFBjR1Z1WldRcDY2VzhJT3lWaE91TGlPcTVqQ3dnN0l1YzZyQ0U3SjIwSU95VmhPdUxpT3VkdkNEcXQ3Z2c3SUtzN0l1azY2R2NJTzJNa091THFPMlZuT3VMcEM0S0lDQWdJQ0FnWTI5dWMzUWdjM1JoYkdVZ1BTQnNiMmRwYmxCeWIyTWdKaVlnSVd4dloybHVWMmx1Wkc5M1QzQmxibVZrSUNZbUlDaEVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQaUF5TURBd01DazdDaUFnSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk1nSmlZZ2MzUmhiR1VwSUhzS0lDQWdJQ0FnSUNCcmFXeHNURzluYVc1UWNtOWpLQ2s3Q2lBZ0lDQWdJQ0FnYVdZZ0tDRnZjR1Z1VEc5bmFXNVVaWEp0YVc1aGJDZ3BLU0I3Q2lBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Td2dleUJsY25KdmNqb2dKK3lkdENCUFUreVhrT3lFb0NEc25wRHJqNW5zbkx6cm9ad2c2NnE3SU95WHRPeVd0T3lhbENEaWdKUWc3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNEc2k2VHRsb2tnN1p1RUlDOXNiMmRwYmlEdGxiUWc3S084N0lTNDdKcVVMaWNnZlNrN0NpQWdJQ0FnSUNBZ2ZRb2dJQ0FnSUNBZ0lDOHZJT3lkbU91UGhPeWdnU0Rzb29Ycm80d29jbVZoYzI5dUlPeW5nT3lnbFNrZzRvQ1VJT3luaE8yV2lTRHNwSkVnN1lTMDdKMkVJRk5GVTFOSlQwNWZSRWxGUk91aG5DRHJnWjNyZ3JUcnFiUWc3SjZRNjQrWklPeWVyT3lMbk91UGhPcXdnQ0RzbUpzZzZyT0U3S0NWSU95RXVPeUZtT3lkaENEcmtKanNnclRycHJEcmk2UUtJQ0FnSUNBZ0lDQnJhV3hzVUhKdll5Z242NkdjNnJlNDdKMjQ3SjJFSU95bmhPMldpZTJWbU91S2xDRHNwSkhzbmJUcm5id2c3SnFVN0xLdDdKMkVJT3lra2V1THFPMldpT3lXdE95YWxDRGlnSlFnNjZHYzZyZTQ3SjI0SU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5LVHNLSUNBZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQU0F3T3dvZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25iZ2c3WSswNjdDeElPS0FsQ0R0aExEcnI3anJoSkFnNjdDcDdJdWQ3Snk4NjZHY0lPeWdoTzJabUM0bktUc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2JXOWtaVG9nSjNSbGNtMXBibUZzSnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCcmFXeHNURzluYVc1UWNtOWpLQ2s3SUM4dklPeVZudXlFb0NEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjQ3SjIwSU91TWdPcTRzQ0RzcEpIc25iVHJxYlFnN0tDUjZyT2dJT3lEaU91aG5DRHNsN0RyaTZRZ0tPeXd2ZXlkaENEcmk2dnNsWmpxc2JEcmdwZ2c2NHVrN0l1Y0lPdUloT3VsdUNEcXNyM3NtckFwQ2lBZ0lDQWdJR3h2WjJsdVUzUmhjblJsWkVGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lDQWdiRzluYVc1WGFXNWtiM2RQY0dWdVpXUWdQU0JtWVd4elpUc2dMeThnN0oyMDY3S0lJT3lMbk91UGhPeWRtQ0Rzc0wwZzdKZTA2cml3SU95RXNlcXp0U0RzbDZ6cnRvQWc0b0NVSU95VmhPdWVtT3lYa095RW5DRHNoTGpzbXJUcmk2UUtJQ0FnSUNBZ0x5OGdRbEpQVjFORlV1dUtsQ0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a0lPS0FsQ0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHFzNkFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHNucERyajVrZzdJaVk2NkM1N1pXYzY0dWtDaUFnSUNBZ0lDOHZJQ2pzbklRZ0ordWhuT3EzdU95ZHVPeWRnQ0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc3A0SHNvSkVnN0plMDZyS01JTzJWbk91THBDY2c3S084N0lTZElPS0FsQ0Rxc0lEcm9aenNzWVRycWJRZzdMMlU2NU9jSU91Mm1leVhyT3VFbytxNHNDRHRtWlRycWJUc25iUWc2NXlzNjR1a0tTNEtJQ0FnSUNBZ0x5OGc2ck9FN0tDVklPeWdoTzJabU91UGhDRHFzSm5zbllBZzZySzk2NkdjNjR1a09pRHJ1SXpybmJ6c21yRHNvSURzbDVBZzdJUzQ3SVdZN0oyMElPdUNxT3lWaENEc25vanNuTHpycWJRZzdJcTU3SjI0SU8yWmxPdXB0T3lkdENEcm5LanFzNkFzSU9xM3VDRHRtWlRycWJRZzdaV1k2NHVvQ2lBZ0lDQWdJQzh2SUZ2cXM0VHNvSlVnN0tDRTdabVlYZXljdk91aG5DRHJpNlRycGJnZzZyT0U3S0NWN0oyRUlPcXpvT3VsdU91THBDNGdjM2RwZEdOb1RXOWtaZXVLbENEcm9aenF0N2pDdCt5ZGtldUx0U0R0a1p6c2k1enNtcW5zbkx6cm9aenJwNHdnNjRLbzY0cVU2NHVrTGdvZ0lDQWdJQ0JqYjI1emRDQjBhR2x6VEc5bmFXNGdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjJsdUp5d2dKeTB0WTJ4aGRXUmxZV2tuWFN3Z2V3b2dJQ0FnSUNBZ0lITm9aV3hzT2lCMGNuVmxMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWXNJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVXNDaUFnSUNBZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzSUM4dklHdHBiR3hNYjJkcGJsQnliMlBzblpnZzZyZTQ2Nk81SUd0cGJHenNtcWtnS0d0cGJHeFFjbTlqNnJPOElPdVBtZXlkdkNEdGpLanRoTFFwQ2lBZ0lDQWdJSDBwT3dvZ0lDQWdJQ0JzYjJkcGJsQnliMk1nUFNCMGFHbHpURzluYVc0N0NpQWdJQ0FnSUd4dloybHVWMmx1Wkc5M1QzQmxibVZrSUQwZ2RISjFaVHNnTHk4Z1EweEo2ckNBSU95WHJPdUtsQ0Rxc2JRZzZyU0E3TEN3N1pXZ0lPeUltQ0RzbDRic25MenJpNGdnN0plMDY2YXdJT3F5Zyt5Y3ZPdWhuQ0Ryczdqcmk2UWdLT3llck8yQnRPdW1yZXlYa0NEdGhMRHJyN2pyaEpBZzY3Q3A3S2VBS1FvZ0lDQWdJQ0IwYUdselRHOW5hVzR1YjI0b0oyVnljbTl5Snl3Z0tDa2dQVDRnZXlCcFppQW9iRzluYVc1UWNtOWpJRDA5UFNCMGFHbHpURzluYVc0cElHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0lIMHBPd29nSUNBZ0lDQjBhR2x6VEc5bmFXNHViMjRvSjJOc2IzTmxKeXdnS0dOdlpHVXBJRDArSUhzS0lDQWdJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpJQ0U5UFNCMGFHbHpURzluYVc0cElISmxkSFZ5YmpzS0lDQWdJQ0FnSUNCc2IyZHBibEJ5YjJNZ1BTQnVkV3hzT3dvZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTlVhVzFsY2lrZ2V5QmpiR1ZoY2xScGJXVnZkWFFvYkc5bmFXNVFjbTlqVkdsdFpYSXBPeUJzYjJkcGJsQnliMk5VYVcxbGNpQTlJRzUxYkd3N0lIMEtJQ0FnSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPeUF2THlEc2c0Z2c2ck9FN0tDVjdKMjhJT3lJbUNEc25vanNuTHpyaTRnZzY0dWs3SjJNSUM5b1pXRnNkR2dnNjVXTUlPdUxwT3lMbkNEc25iM3F1TEFLSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1Q0Rzb0lqc3NLZ2c3S0tGNjZPTUlDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a25LVHNLSUNBZ0lDQWdJQ0F2THlEc2dxenJub3pzbmJRZzY2R2M2cmU0N0oyNDdaV2dJT3lMbk9xd2hPdVBoQ0RzbDRic25iUWc2ck9uNjdDVTY2R2NJT3lMcE8yTXFPdWhuQ0RyZ1ozcmdxenJpNlFnUFNCamJHRjFaR1hxc0lBZzdKZUc2ckd3NjRLWUlPeUxwTzJXaWV5ZHRDRHNsWWdnNjVDY0lPcXlneTRLSUNBZ0lDQWdJQ0F2THlEc25aSHJpN1hzbllBZzdKMjA2Nis0SU91enRPdURpT3ljdk91TGlDRHNnNEh0ZzV6cnBid2c2NHVrN0l1Y0lPeWVyT3lFbkNBdmFHVmhiSFJvNjZHY0lPeVZqT3Vtc091THBDQW83WlNNNjUrczZyZTQ3SjI0N0oyMElPdU1nT3E0c0NEdG1aVHJxYlRzbllRZzdJdWs3WXlvNjZHY0lPdXdsT3Erdk91THBDa3VDaUFnSUNBZ0lDQWdhV1lnS0dOdlpHVWdJVDA5SURBZ0ppWWdSR0YwWlM1dWIzY29LU0F0SUd4dloybHVVM1JoY25SbFpFRjBJRHdnTlRBd01Da2dld29nSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVPeWR0Q0RzcG9uc2k1d2c3SXVrN1l5bzY2R2NJT3VCbmV1Q3FDRGlnSlFnUTJ4aGRXUmxJRU52WkdVZzdJU2s3TG1ZSU95RGdlMkRuT3VsdkNEcmk2VHNpNXdnN0tDUTZyS0E3WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdJQ0FnSUNBZ1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LVHNLSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJSDBwT3dvZ0lDQWdJQ0JzYjJkcGJsQnliMk5VYVcxbGNpQTlJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdleUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNElERXc2N2FFSU9xeXZlcXp2Q0RpZ0pRZzY0eUE2cml3SU8yVWhPdWhuT3lFdU95S3BDRHNvSlhycHF3dUp5azdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc2dmU3dnTmpBd01EQXdLVHNLSUNBZ0lDQWdMeThnNjRLaDdKMkFJT3llaGV5ZXBlcTJqT3lkaENEcnJMenFzNkFnN0o2STY0cVVJT3VNZ09xNHNDRHNoTGpzaFpqc25ZQWc2N0tFNjZhdzY0dWtJT0tBbENEc25xenJvWnpxdDdqc25iZ2c3WnVFSU91THBPeWRqQ0RzbXBUc3NxM3NuYlFnN0lPSUlPeUV1T3lGbUNqc2c0Z2c3SjZGN0o2bDZyYU1LZXljdk91aG5DRHNpNXpzbnBIdGxaanFzb3d1Q2lBZ0lDQWdJQzh2SU95ZG1PdVBoT3lnZ1NEc29vWHJvNHdvY21WaGMyOXVJT3luZ095Z2xTa2c0b0NVSUZORlUxTkpUMDVmUkVsRlJPdWhuQ0RyZ1ozcmdyVHJxYlFnN0o2UTY0K1pJT3llck95TG5PdVBoT3F3Z0NEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcm9LUUtJQ0FnSUNBZ0x5OGc3SjZzNjZHYzZyZTQ3SjI0SU91U3BPeVhrT3VQaENCTlFWaGZWRlZTVGxQcXVZenNwNEFnN0ppYklPcXpoT3lnbGV5Y3ZPdWhuQ0Rzc3BqcnBxenJrSmpyaXBRZzY3S0U2cmU0NnJDQUlPdVFuT3VMcENBb01qQXlOaTB3TnlEcnBxenJ0N0RzbDVEc2hKd2c3Wm1WN0oyNEtRb2dJQ0FnSUNCcmFXeHNVSEp2WXlnbjY2R2M2cmU0N0oyNDdKMkVJT3luaE8yV2llMlZtT3VLbENEc3BKSHNuYlRybmJ3ZzdKcVU3TEt0N0oyRUlPeWtrZXVMcU8yV2lPeVd0T3lhbENEaWdKUWc2NkdjNnJlNDdKMjRJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0bktUc0tJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJnZzdJdWM3SjZSSnlBcklDaHpkMmwwWTJoTmIyUmxJRDhnSnlBbzZyT0U3S0NWSU95Z2hPMlptQ0RpZ0pRZzdJcTU3SjI0SU8yWmxPdXB0T3lkdENEcm5LanJxYlFnNnJlNElPMlpsT3VwdENEdGxaanJpNmdnVytxemhPeWdsU0Rzb0lUdG1aaGQ3Snk4NjZHY0lPdUxwT3VsdUNEcXM0VHNvSlhzbllRZzZyT2c2Nlc4SU95SW1DRHNub2pzbHJUc21wUXBKeUE2SUNjbktTQXJJQ2NnNG9DVUlPdWhuT3EzdU95ZHVPMlZtT3VwdENEc25wRHJqNWtnN0pldzZyS3c2NUNwNjR1STY0dWtMaWNwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2diVzlrWlRvZ2MzZHBkR05vVFc5a1pTQS9JQ2RpY205M2MyVnlMWE4zYVhSamFDY2dPaUFuWW5KdmQzTmxjaWNnZlNrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBd0xDQjdJR1Z5Y205eU9pQW42NkdjNnJlNDdKMjRJT3l3dmV5ZGhDRHJxcnNnN0plMDdKZUk3SmEwN0pxVU9pQW5JQ3NnWlM1dFpYTnpZV2RsSUgwcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlBbzdZU3c2Nis0NjRTUUlPMlB0T3V3c1NEcXRhenRtSVRydG9BZzRvQ1VJT3U0ak91ZHZPeWFzT3lnZ0NEc25wRHJqNWtnN0ptRTY2T002ckNBSU95VmlDRHJrSmpyaXBRZzdabVk2cks5SU95Z2hPeWFxU2tLSUNCbWRXNWpkR2x2YmlCdmNHVnVURzluYVc1VVpYSnRhVzVoYkNncElIc0tJQ0FnSUhzS0lDQWdJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNLSUNBZ0lDQWdJQ0F2THlCemRHRnlkT3F3Z0NEc2c0Z2c3TDJZN0lhVUlPeXd2ZXlkaENEcnA0enJrNkRyaTZRZ0tPdUxwT3Vtck95ZG1DRHNpS2pzbllBZzdMMlk3SWFVNnJPOElPdXN0T3EwZ08yVm1PcXlqQ0RzZ3F6c21xbnNucERzbDVEcXNvd2c2N08wN0o2RUtTNEtJQ0FnSUNBZ0lDQXZMeURzbmJUc2xyVHNoSndnVUc5M1pYSlRhR1ZzYkNndWNITXhLZXlkdENBMTdMU0lJT3VTcENEcXQ3Z2c3TEM5N0plUUlPeVhsTzJFc091bHZDRHJzN1RyZ3JRZ01ldXlpQ2pxdGF6cmo0VWc2ck9FN0tDVktleWRoQ0RzbnBEcmo1a2c3SVNnN1lPZDdaV1k2ck9nTEFvZ0lDQWdJQ0FnSUM4dklPeXd2ZXlkaENEc3RaenNob3p0bVpUdGxiUWc3SUtzN0pxcDdKNlFJT3VJaU95WGxDRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0NjZlTUlPdUNxT3F5akNEdGxaenJpNlF1SU95d3ZleWRoQ0RycXJzZzdMQys3Snk4NjZtMElPeVZoT3VzdE9xeWcrdVBoQ0RzbFlnZzdaV2M2NHVrQ2lBZ0lDQWdJQ0FnTHk4Z0tPdUxwT3VsdUNEc3NMMGc3SmlrN0o2RjY2Q2xJT3V3cWV5bmdDRGlnSlFnNnJlNElPcXl2ZXlhc0NEcnFaVHJpYlRxc0lBZzY3TzA3SjIwNjRxVUlPeXhoT3VobkNEcmdxanFzNkFnN0lLczdKcXA3SjZRNnJDQUlPeVhsTzJFc0NEdGxad2c2N0tJSU91SWhPdWx0T3VwdENEcmtLZ3BMZ29nSUNBZ0lDQWdJQzh2SU95anZPeWRtRG9nWTJ4aGRXUmw2ckNBSU95OW1PeUdsQ0Rzb0p6cnFxbnNuWVFnNjdDVTZyNjQ2Nm0wSUVGd2NFRmpkR2wyWVhSbEwwWnBibVJYYVc1a2IzZnFzSUFnNjZxN0lPeXd2dXlkaENEc2lKZ2c3SjZJN0oyTUlPS0FsQ0Rzbklqcmo0VHNtckFnN0l1azZyaXc3SmVRN0lTY0lPMlpsZXlkdUNEdGxZVHNtcFF1Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdjSE14SUQwZ2NHRjBhQzVxYjJsdUtHOXpMblJ0Y0dScGNpZ3BMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTMXNiMmRwYmk1d2N6RW5LVHNLSUNBZ0lDQWdJQ0JtY3k1M2NtbDBaVVpwYkdWVGVXNWpLSEJ6TVN3Z1d3b2dJQ0FnSUNBZ0lDQWdKMU4wWVhKMExWTnNaV1Z3SUMxVFpXTnZibVJ6SURVbkxBb2dJQ0FnSUNBZ0lDQWdKeVIzY3lBOUlFNWxkeTFQWW1wbFkzUWdMVU52YlU5aWFtVmpkQ0JYVTJOeWFYQjBMbE5vWld4c0p5d0tJQ0FnSUNBZ0lDQWdJQ0pwWmlBb0pIZHpMa0Z3Y0VGamRHbDJZWFJsS0NkamJHRjFaR1V0Ykc5bmFXNG5LU2tnZXlJc0NpQWdJQ0FnSUNBZ0lDQWlJQ0FrZDNNdVUyVnVaRXRsZVhNb0ozNG5LU0lzQ2lBZ0lDQWdJQ0FnSUNBbklDQlRkR0Z5ZEMxVGJHVmxjQ0F0VTJWamIyNWtjeUF5Snl3S0lDQWdJQ0FnSUNBZ0lDSWdJRUZrWkMxVWVYQmxJQzFPWVcxbGMzQmhZMlVnVlNBdFRtRnRaU0JYSUMxTlpXMWlaWEpFWldacGJtbDBhVzl1SUNkYlJHeHNTVzF3YjNKMEtGd2lkWE5sY2pNeUxtUnNiRndpS1YwZ2NIVmliR2xqSUhOMFlYUnBZeUJsZUhSbGNtNGdVM2x6ZEdWdExrbHVkRkIwY2lCR2FXNWtWMmx1Wkc5M0tITjBjbWx1WnlCakxDQnpkSEpwYm1jZ2RDazdJRnRFYkd4SmJYQnZjblFvWENKMWMyVnlNekl1Wkd4c1hDSXBYU0J3ZFdKc2FXTWdjM1JoZEdsaklHVjRkR1Z5YmlCaWIyOXNJRk5vYjNkWGFXNWtiM2NvVTNsemRHVnRMa2x1ZEZCMGNpQm9MQ0JwYm5RZ2JpazdKeUlzQ2lBZ0lDQWdJQ0FnSUNBaUlDQWthQ0E5SUZ0VkxsZGRPanBHYVc1a1YybHVaRzkzS0Z0T2RXeHNVM1J5YVc1blhUbzZWbUZzZFdVc0lDZGpiR0YxWkdVdGJHOW5hVzRuS1NJc0NpQWdJQ0FnSUNBZ0lDQW5JQ0JwWmlBb0pHZ2dMVzVsSUZ0VGVYTjBaVzB1U1c1MFVIUnlYVG82V21WeWJ5a2dleUJiZG05cFpGMWJWUzVYWFRvNlUyaHZkMWRwYm1SdmR5Z2thQ3dnTmlrZ2ZTY3NJQzh2SURZZ1BTQlRWMTlOU1U1SlRVbGFSUW9nSUNBZ0lDQWdJQ0FnSjMwbkxBb2dJQ0FnSUNBZ0lGMHVhbTlwYmlnblhISmNiaWNwSUNzZ0oxeHlYRzRuS1RzS0lDQWdJQ0FnSUNCamIyNXpkQ0JpWVhRZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV3h2WjJsdUxtSmhkQ2NwT3dvZ0lDQWdJQ0FnSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vWW1GMExDQW5RR1ZqYUc4Z2IyWm1YSEpjYmljZ0t3b2dJQ0FnSUNBZ0lDQWdKM04wWVhKMElDSmpiR0YxWkdVdGJHOW5hVzRpSUdOdFpDQXZheUJqYkdGMVpHVWdMMnh2WjJsdVhISmNiaWNnS3dvZ0lDQWdJQ0FnSUNBZ0ozQnZkMlZ5YzJobGJHd2dMVTV2VUhKdlptbHNaU0F0UlhobFkzVjBhVzl1VUc5c2FXTjVJRUo1Y0dGemN5QXRSbWxzWlNBaUp5QXJJSEJ6TVNBcklDY2lYSEpjYmljcE93b2dJQ0FnSUNBZ0lITndZWGR1S0NkamJXUW5MQ0JiSnk5akp5d2dZbUYwWFN3Z2V5Qmxiblk2SUVOTVFWVkVSVjlGVGxZc0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2QybHVaRzkzYzBocFpHVTZJSFJ5ZFdVZ2ZTazdDaUFnSUNBZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjJSaGNuZHBiaWNwSUhzS0lDQWdJQ0FnSUNBdkx5QndkSGtvWlhod1pXTjBLZXVobkNEcnM3VHJncmdnN1lLazdKZVFJTzJCdE91aG5PdVRuQ0JVVlVucXNJQWc2NnkwNjdDWTdKMlI3SjI0SU9xeWcreWR0Q0RzaTZUc3VLRWc3Wm1WN0oyNDY1Q29LREl3TWpZdE1EY3NJT3lkdk91d21DQmNjc0szYTJsMGRIa2c3TDJVNjVPY0lPdXFxT3VSa0NrZzRvQ1VDaUFnSUNBZ0lDQWdMeThnN0p5ZzdKMjg3WldjSU95ZWtPdVBtZTJabENEcXNyM3JvWnpyaXBRZ1UzbHpkR1Z0SUVWMlpXNTBjK3lkbUNEc3A0VHNwNXdnN1lLa0lPeWVoZXVncFM0ZzdLQ1I2cmU4N0lTeElPcTJqTzJWbk95ZHRDRHNub2pzbkx6cnFiUWdOdXkwaUNEcmtxUWc3SmVVN1lTdzZyQ0FJT3lla091UG1TRHNub1hyb0tYcmo3d0tJQ0FnSUNBZ0lDQXZMeUF4NjdLSUtPcTFyT3VQaFNEcXM0VHNvSlVwN0oyMElPeUVvTzJEbmV1UW1PcXpvQ3dnNnJhTTdaV2M3SjIwSU95WGh1eWN2T3VwdENCclpYbHpkSEp2YTJVZzdLU0U2NmVNSU95aHNPeWFxZTJlaUNEc2k2VHRqS2p0bGJRZzdJS3M3SnFwN0o2UTZyQ0FJT3lYbE8yRXNDRHRsWndnNjdLSUlPdUloT3VsdE91cHRDRHJrSnpyaTZRb1ptRnBiQzF6YjJaMEtTNEtJQ0FnSUNBZ0lDQXZMeURzbDVUdGhMQWc3S2VCN0tDRTdKZVFJRlJsY20xcGJtRnM3SjJFSU91THBPeUxuQ0RzbFo3c25MenJvWndnNnJDQTdLQzQ3Sm1BSU91THBPdWx1Q0RzbGJIc2w1QWc3WUtrNnJDQUlPdVRwT3lXdE9xd2dPdUtsQ0Rxc29Qc25ZUWc2NmVKNjRxVTY0dWtMZ29nSUNBZ0lDQWdJSE53WVhkdUtDZHZjMkZ6WTNKcGNIUW5MQ0JiQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHUnZJSE5qY21sd2RDQWlZMnhoZFdSbElDOXNiMmRwYmlJbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJoWTNScGRtRjBaU2NzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuWkdWc1lYa2dOaWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHRmpkR2wyWVhSbEp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZGtaV3hoZVNBd0xqTW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbE41YzNSbGJTQkZkbVZ1ZEhNaUlIUnZJR3RsZVhOMGNtOXJaU0J5WlhSMWNtNG5MQW9nSUNBZ0lDQWdJQ0FnTHk4ZzdKZVU3WVN3NnJDQUlPeUxwT3lnbk91aG5DRHJrNlRzbHJUcXNJUWc2cks5N0pxdzdKZVE2NmVNSU95WHJPcTRzQ0RyajRUcmk2d282cmFNN1pXY0lPeVhodXljdk91cHRDRHNuSVRzbDVEc2hKd2c3S1NSNjR1b0tTRGlnSlFnN1lTdzY2KzQ2NFNRN0oyRUlPeTVtT3liakNEcnVJenJuYnpzbXJEc29JRHJwNHdnNjRLbzZyaTA2NHVrQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuWkdWc1lYa2dNUzQxSnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdjMlYwSUcxcGJtbGhkSFZ5YVhwbFpDQnZaaUJtY205dWRDQjNhVzVrYjNjZ2RHOGdkSEoxWlNjc0NpQWdJQ0FnSUNBZ1hTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3Q2lBZ0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHWmhiSE5sT3lBdkx5RHNwNERzbTVBZzdKV0lJTzJWbU91S2xDQlBVd29nSUNBZ0lDQjlDaUFnSUNBZ0lISmxkSFZ5YmlCMGNuVmxPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5RHRnYlRyb1p6cms1d2c2ck9FN0tDVklPdWhuT3EzdU95VmhPeWJneURpZ0pRZzdaU002NStzNnJlNDdKMjRJTzJaaU95ZG1DQmI2NkdjNnJlNDdKV0U3SnVEWFNEcnNvVHRpcnpzbmJRZzdaaTQ3TGFjTGlCamJHRjFaR1VnWVhWMGFDQnNiMmR2ZFhUc25MenJvWndnUTB4SklPdWhuT3EzdU95ZHVPeWRoQ0R0bGJUc29KenRsWnpyaTZRdUNpQWdMeThnS095ZHRDQlFRK3lkbUNEc29JRHNucVhya0p3ZzdKNlE2cktwN0thZDY2cUY3SjJFSU95bmdPeWF0T3VMcENEaWdKUWc2NHVrN0l1Y0lPeVRzT3VncE91cHRDRHNucXpyb1p6cXQ3anNuYmdnN1pXRTdKcVVMaWtnNjZHYzZyZTQ3SldFN0p1RElPMmJoT3lYbENEc2hManNoWmpDdCtxemhPeWdsZXk2a095TG5PdWx2Q0Rzb0pYcnBxenRsWnpyaTZRdUNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyTnNZWFZrWlMxc2IyZHZkWFFuS1NCN0NpQWdJQ0JqYjI1emRDQnNieUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSjJGMWRHZ25MQ0FuYkc5bmIzVjBKMTBzSUhzZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVWdmU2s3Q2lBZ0lDQnNaWFFnWlhKeUlEMGdKeWM3Q2lBZ0lDQnNieTV6ZEdSbGNuSXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJsY25JZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc0tJQ0FnSUd4dkxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQjdJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2diMnM2SUdaaGJITmxMQ0JsY25KdmNqb2dKK3Vobk9xM3VPeVZoT3liZ3lEc2k2VHRsb2tnN0l1azdZeW9PaUFuSUNzZ1pTNXRaWE56WVdkbElIMHBPeUI5S1RzS0lDQWdJR3h2TG05dUtDZGpiRzl6WlNjc0lDaGpiMlJsS1NBOVBpQjdDaUFnSUNBZ0lHdHBiR3hRY205aktDZnJvWnpxdDdqc2xZVHNtNFB0bGJUc2hKd2c3SnFVN0xLdDdKMkVJT3lra2V1THFPMldpT3lXdE95YWxDNG5LVHNnTHk4ZzdKMlk2NCtFN0tDQklPeWloZXVqakNEaWdKUWc3SjZRNjQrWklPeWVyT3lMbk91UGhPcXdnQ0RzaExqc2haanNuWVFnNjVDWTdJSzA2NmFzNjZtMElPeVZpQ0Rya0tnS0lDQWdJQ0FnWVdOamIzVnVkRU5oWTJobExtRjBJRDBnTURzZ0lDQWdJQ0FnSUM4dklPdUxwT3lkakNBdllXTmpiM1Z1ZE1LM0wyaGxZV3gwYU95WGtPeUVuQ0RxczRUc29KWHNuWVFnN0lPSTY2R2NLRDNzbDRic25ZenNuTHpyb1p3cElPeWR2ZXF5akFvZ0lDQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQnVkV3hzT3lBZ0lDQWdJQ0FnTHk4ZzdJT0I3WU9jSU95ZXJPMk1rT3lnbFNqcmk2VHNuWXdnN1lTMDdKZVE3SVNjSU91dnVPdWhuT3EzdU95ZHVDRHFzSkRzcDRBcENpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKV0U3SnVESUNoamIyUmxJQ2NnS3lCamIyUmxJQ3NnSnlrbktUc0tJQ0FnSUNBZ2FXWWdLSEpsY3k1b1pXRmtaWEp6VTJWdWRDa2djbVYwZFhKdU95QXZMeUJsY25KdmNpRHRsYmpyazZUcm42enFzSUFnN0oyMDY2KzRJT3lka2V1THRlMldpT3ljdk91cHRDRHNwSkhyczdVZzY3Q3A3S2VBQ2lBZ0lDQWdJR2xtSUNoamIyUmxJRDA5UFNBd0tTQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUNBZ0lDQmxiSE5sSUdwemIyNG9jbVZ6TENBMU1EQXNJSHNnYjJzNklHWmhiSE5sTENCbGNuSnZjam9nS0dWeWNpNTBjbWx0S0NrdWMyeHBZMlVvTUN3Z01UVXdLU2tnZkh3Z0tDZnNvb1hybzR3ZzdMMlU2NU9jSUNjZ0t5QmpiMlJsS1NCOUtUc0tJQ0FnSUgwcE93b2dJQ0FnY21WMGRYSnVPd29nSUgwS0lDQXZMeURzbnBEcXVMQWc3S0tGNjZPTUlPS0FsQ0R0bEl6cm42enF0N2pzbmJnZ1UxUlBVRjlDVWtsRVIwVXY3WldZN1lxNDY3bUU3WXE0NnJDQUlPMll1T3kybk8yVm5PdUxwQ0FvNjZHYzdMdXM3SmVRN0lTYzY2ZU1JT3lna2VxM3ZDRHFzSURyaXFYdGxaanJpNGdnN0pXSTdLQ0VLUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl6YUhWMFpHOTNiaWNwSUhzS0lDQWdJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tLRjY2T01JT3lhbE95eXJTRHJzSnZzbll3ZzRvQ1VJT3VMcE91bXJPdWx2Q0RyZ1pYcmk0anJpNlF1SnlrN0NpQWdJQ0J6YUhWMGRHbHVaMFJ2ZDI0Z1BTQjBjblZsT3dvZ0lDQWdhMmxzYkZCeWIyTW9LVHNLSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwTENBeU1EQXBPd29nSUNBZ2NtVjBkWEp1T3dvZ0lIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjbVZqYjIxdFpXNWtKeWtnZXdvZ0lDQWdZMjl1YzNRZ2V5QjBaWGgwTENCdGIyUmxiQ3dnY205c1pTQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmc3RwVHNzcHpyc0p2c25ZUWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95MmxPeXluQ0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNzSUhKdmJHVWdQeUFuV3ljZ0t5QnliMnhsSUNzZ0oxMG5JRG9nSnljc0lHMXZaR1ZzSUQ4Z0p5anJxcWpyamJnNklDY2dLeUJ0YjJSbGJDQXJJQ2NwSnlBNklDY25LVHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJR052Ym5OMElISWdQU0JoZDJGcGRDQmhjMnREYkdGMVpHVW9VM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFUzVm5aMlZ6ZEdsdmJuTXNJR1p2Y20xaGRFUmxjMk02SUNkYmV5SjBaWGgwSWpvZ0l1dXN1T3ExckNJc0lDSnlaV0Z6YjI0aU9pQWk3SjIwN0p5Z0luMHNJQzR1TGwwbklIMHNJSEp2YkdVcE93b2dJQ0FnSUNCamIyNXpkQ0J6ZFdkblpYTjBhVzl1Y3lBOUlISXVjR0Z5YzJWa0lIeDhJRnRkT3dvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBb0tFUmhkR1V1Ym05M0tDa2dMU0J6ZEdGeWRHVmtLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2s3Q2lBZ0lDQWdJR2xtSUNnaGMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0tTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKV0lJQ2NnS3lCemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3Q2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCemRXZG5aWE4wYVc5dWN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RpZ0pRZzdaV2NJTzJabE91cHRPeWRoQ0R0bFpqc25JUWc3WlNFNjZDSTdKNkVLT3lZZ2V5WHJTa2c2NHVvN0p5RTY2R2NJT3VDbU91SW9DRHJzSnZxczZBc0lPeVlnZXlYcmV1bmlPdUxwQ0RybExEcm9ad2c2NHlBN0pXSTdKMkVJT3VDdU91THBDNEtJQ0F2THlEc21JSHNsNjBnN0lpWTY2ZU03WUc4SU95YWxPeXlyZXlkaENEc3FyenFzSnpzcDRBZzdKV0s2NHFVSU9xeWcreWR0Q0R0bGJYc2k2d2dLT3VLa091Z3BPeW5nT3F6b0NEc2dxenNtcW5ybjRucmo0UWc2cmU0NjZlTTdZRzhJT3VDbU9xd2hPdUxwQ2t1Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNKbFkyOXRiV1Z1WkMxbmNtOTFjSE1uS1NCN0NpQWdJQ0JqYjI1emRDQjdJR2R5YjNWd2N5d2diVzlrWld3c0lHMXZjbVVnZlNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdDaUFnSUNCamIyNXpkQ0JzYVhOMElEMGdRWEp5WVhrdWFYTkJjbkpoZVNobmNtOTFjSE1wQ2lBZ0lDQWdJRDhnWjNKdmRYQnpDaUFnSUNBZ0lDQWdJQ0F1YldGd0tDaG5LU0E5UGlBb2V3b2dJQ0FnSUNBZ0lDQWdJQ0J1WVcxbE9pQlRkSEpwYm1jb0tHY2dKaVlnWnk1dVlXMWxLU0I4ZkNBbkp5a3VkSEpwYlNncExBb2dJQ0FnSUNBZ0lDQWdJQ0IwWlhoMGN6b2dLR2NnSmlZZ1FYSnlZWGt1YVhOQmNuSmhlU2huTG5SbGVIUnpLU0EvSUdjdWRHVjRkSE1nT2lCYlhTa3ViV0Z3S0NoMEtTQTlQaUJUZEhKcGJtY29kQ0I4ZkNBbkp5a3VkSEpwYlNncEtTNW1hV3gwWlhJb1FtOXZiR1ZoYmlrc0NpQWdJQ0FnSUNBZ0lDQWdJSEp2YkdVNklDaG5JQ1ltSUdjdWNtOXNaU2tnUHlCVGRISnBibWNvWnk1eWIyeGxLU0E2SUhWdVpHVm1hVzVsWkN3S0lDQWdJQ0FnSUNBZ0lIMHBLUW9nSUNBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvWnlrZ1BUNGdaeTUwWlhoMGN5NXNaVzVuZEdncENpQWdJQ0FnSURvZ1cxMDdDaUFnSUNCcFppQW9iR2x6ZEM1c1pXNW5kR2dnUENBeUtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdNQ3dnZXlCbGNuSnZjam9nSit5WWdleVhyZXlkdENEcnRvRHNvYkh0bGFucmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yVWhPdWdpT3llaE91emhDRHN0cFRzc3B3ZzdKcVU3TEt0T2lEc21JSHNsNjBnSnlBcklHeHBjM1F1YkdWdVozUm9JQ3NnSitxd25DY2dLeUFvYlc5eVpTQS9JQ2NnS091TmxDRHJzSnZxdUxBcEp5QTZJQ2NuS1N3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NpQTlJR0YzWVdsMElHRnphMGR5YjNWd2N5aHNhWE4wTENCdGIyUmxiQ3dnZXlCd1lYSnpaVG9nY0dGeWMyVkhjbTkxY0hNc0lHWnZjbTFoZEVSbGMyTTZJQ2Q3SW1keWIzVndjeUk2SUZ0N0ltNWhiV1VpT2lBaTdKaUI3SmV0SU95ZHRPdW1oQ0lzSUNKemRXZG5aWE4wYVc5dWN5STZJRnQ3SW5SbGVIUWlPaUFpNjR5QTdKV0lJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FpZlYxOVhYMG5JSDBzSUNFaGJXOXlaU2s3Q2lBZ0lDQWdJR052Ym5OMElHOTFkQ0E5SUhJdWNHRnljMlZrT3dvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBb0tFUmhkR1V1Ym05M0tDa2dMU0J6ZEdGeWRHVmtLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2s3Q2lBZ0lDQWdJR2xtSUNnaGIzVjBLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z2V5Qmxjbkp2Y2pvZ0orMkJ0T3Vobk91VG5DRHNuWkhyaTdYc25ZUWc3WlcwN0lTZDdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3dvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU0U2NkNJN0o2RTY3T0VJT3lnbk95VmlDQW5JQ3NnYjNWMExuSmxaSFZqWlNnb2Jpd2daeWtnUFQ0Z2JpQXJJR2N1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvTENBd0tTQXJJQ2Zxc0p3Z0x5RHNtSUhzbDYwZ0p5QXJJRzkxZEM1c1pXNW5kR2dnS3lBbjZyQ2NJQ2duSUNzZ2MyVmpJQ3NnSjNNcEp5azdDaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQW5XKzJVaE91Z2lPeWVoT3V6aEYwZ0p5QXJJRk4wY21sdVp5Z29iR2x6ZEZzd1hTQW1KaUJzYVhOMFd6QmRMblJsZUhSeld6QmRLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNalFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5Qm5jbTkxY0hNNklHOTFkQ3dnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMlVoT3VnaU95ZWhPdXpoQ0RzdHBUc3Nwd2c3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUNmdGdiVHJvWnpyazV3ZzdaaTQ3TGFjSU95THBPMk1xRG9nSnlrcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlEdGpKM3NsNFVnN0pxVTdJYU02N09FSU95MmxPeXluQ0RpZ0pRZzdaV2NJTzJNbmV5WGhleWRtQ0RxdGF6c2hMSHNtcFRzaG93bzdKZXQ3WldnSyt1c3VPcTFyQ25ycGJ3ZzdaV2NJT3V5aU95WGtDRHJzSnZzbFlRZzdKZXQ3WldnNjdPRTY2R2NJT3VMcE91VHJPdUtsT3VMcEM0S0lDQXZMeURzbXBUc2hvenJwYndnN1pXbzZydVlJT3V6dE91Q3RPeVZ2Q0R0ZzREc25iVHRpNERzbmJRZzY3TzQ2Nnk0SU91bnBldWR2ZXlkaENEc3NManNvYkR0bGFBZzdJaVlJT3llaU91THBDanNtcFRzaG96cnM0UWc2ckNjNjdPRUlPeWFsT3l5cmVxenZPeWRtQ0Rzc0tqc25iUXBMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl5WldOdmJXMWxibVF0Y0c5d2RYQW5LU0I3Q2lBZ0lDQmpiMjV6ZENCN0lHVnNaVzFsYm5SekxDQnRiMlJsYkN3Z2JXOXlaU0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0dWc1pXMWxiblJ6S1NBL0lHVnNaVzFsYm5SekxtWnBiSFJsY2lnb1pTa2dQVDRnWlNBbUppQlRkSEpwYm1jb1pTNTBaWGgwSUh4OElDY25LUzUwY21sdEtDa3BJRG9nVzEwN0NpQWdJQ0JwWmlBb2JHbHpkQzVzWlc1bmRHZ2dQQ0F5S1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKKzJNbmV5WGhTRHNtcFRzaG96cXNJQWc2N2FBN0tHeDdaV3A2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRqSjNzbDRVZzdMYVU3TEtjSU95YWxPeXlyVG9nN0pxVTdJYU1JQ2NnS3lCc2FYTjBMbXhsYm1kMGFDQXJJQ2Zxc0p3bklDc2dLRzF2Y21VZ1B5QW5JQ2pyalpRZzY3Q2I2cml3S1NjZ09pQW5KeWtzSUcxdlpHVnNJRDhnSnlqcnFxanJqYmc2SUNjZ0t5QnRiMlJsYkNBcklDY3BKeUE2SUNjbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhJZ1BTQmhkMkZwZENCaGMydFFiM0IxY0Noc2FYTjBMQ0J0YjJSbGJDd2dleUJ3WVhKelpUb2djR0Z5YzJWUWIzQjFjQ3dnWm05eWJXRjBSR1Z6WXpvZ0ozc2ljMlYwY3lJNklGdDdJbkpsWVhOdmJpSTZJQ0xyc0tudGxxVWc3WldjSU91c3VPeWVwU0lzSUNKbGJHVnRaVzUwY3lJNklGdDdJbkp2YkdVaU9pQWk3SmV0N1pXZ0lpd2dJblJsZUhRaU9pQWk2Nnk0NnJXc0luMHNJQzR1TGwxOUxDQXVMaTVkZlNjZ2ZTd2dJU0Z0YjNKbEtUc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWMGN5QTlJSEl1Y0dGeWMyVmtPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYzJWMGN5a2dld29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTW5leVhoU0RzaExqdGlyZ2dKeUFySUhObGRITXViR1Z1WjNSb0lDc2dKK3F3bkNBb0p5QXJJSE5sWXlBcklDZHpLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnSjF2dGpKM3NsNFZkSUNjZ0t5QlRkSEpwYm1jb0tHeHBjM1JiTUYwZ0ppWWdiR2x6ZEZzd1hTNTBaWGgwS1NCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTWpRcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ6WlhSekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5ZDdKZUZJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzY0eUE3Wm1VN1ppVklPdXN1T3ExckNEc29KenNucEVnNG9DVUlPeURnZTJacWV5ZGhDRHNoS1RycW9YdGxaanJxYlFnNjZ5NDZyV3M2Nlc4SU91bmpPdVRwT3lXdE95a2dPdUxwQ0FvN0xhVTdMS2M2ck84SU9xd21leWRnQ0RzaExqc2haZ3NJT3VNZ08yWmxPdUtsQ0RycDZRZzdKcVU3TEt0N0plUUlPMkd0ZXludU91aG5DRHNpNlRycHJ3cENpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyTnZiWEJ2YzJVbktTQjdDaUFnSUNCamIyNXpkQ0I3SUcxbGMzTmhaMlZ6TENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0cxbGMzTmhaMlZ6S1NBL0lHMWxjM05oWjJWekxtWnBiSFJsY2lnb2JTa2dQVDRnYlNBbUppQlRkSEpwYm1jb2JTNTBaWGgwSUh4OElDY25LUzUwY21sdEtDa3BJRG9nVzEwN0NpQWdJQ0JwWmlBb0lXeHBjM1F1YkdWdVozUm9LU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0ordU1nTzJabENEcmdyVHNtcW5zbmJRZzY3bUU3SmEwSU95ZWlPeUt0ZXVMaU91THBDNG5JSDBwT3dvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCamIyNXpkQ0JzWVhOMFZYTmxjaUE5SUZzdUxpNXNhWE4wWFM1eVpYWmxjbk5sS0NrdVptbHVaQ2dvYlNrZ1BUNGdiUzV5YjJ4bElDRTlQU0FuWVhOemFYTjBZVzUwSnlrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU91TWdPMlpsQ0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LQ2hzWVhOMFZYTmxjaUFtSmlCc1lYTjBWWE5sY2k1MFpYaDBLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSUNqcmpJRHRtWlFnSnlBcklHeHBjM1F1YkdWdVozUm9JQ3NnSitxd25Da25LVHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJQzh2SU91TWdPMlpsT3F3Z0NEcXVManNsclRzcDREcnFiUWc3TFdjNnJlOElERXk2ckNjNjZlTUlDanRsSVRyb2F6dGxJVHRpcmdnN1krdDdLTzhJT3V3cWV5bmdDa0tJQ0FnSUNBZ1kyOXVjM1FnY2lBOUlHRjNZV2wwSUdGemEwTnZiWEJ2YzJVb2JHbHpkQzV6YkdsalpTZ3RNVElwTENCdGIyUmxiQ3dnZXlCd1lYSnpaVG9nY0dGeWMyVkRiMjF3YjNObExDQm1iM0p0WVhSRVpYTmpPaUFuZXlKeVpYQnNlU0k2SUNMcmpJRHRtWlFnN0oyUjY0dTFJTzJWbk91UmtDRHJyTGpzbnFVaUxDQWljM1ZuWjJWemRHbHZibk1pT2lCYmV5SjBaWGgwSWpvZ0l1dXN1T3ExckNJc0lDSnlaV0Z6YjI0aU9pQWk3SjIwN0p5Z0luMHNJQzR1TGwxOUp5QjlLVHNLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY2k1d1lYSnpaV1E3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGdmRYUXBJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z2V5Qmxjbkp2Y2pvZ0orMkJ0T3Vobk91VG5DRHNuWkhyaTdYc25ZUWc3WlcwN0lTZDdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc29KenNucEVnN0oyUjY0dTFJQ2duSUNzZ2MyVmpJQ3NnSjNNc0lPeWduT3lWaUNBbklDc2diM1YwTG5OMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBcklDZnFzSndwSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbk5sY25abFpDc3JPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNCVGRISnBibWNvS0d4aGMzUlZjMlZ5SUNZbUlHeGhjM1JWYzJWeUxuUmxlSFFwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0F6TUNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJSEpsY0d4NU9pQnZkWFF1Y21Wd2JIa3NJSE4xWjJkbGMzUnBiMjV6T2lCdmRYUXVjM1ZuWjJWemRHbHZibk1zSUdWdVoybHVaVG9nSjJOc1lYVmtaU2NnZlNrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvSnpzbnBFZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0JtY21sbGJtUnNlVVZ5Y205eUtHVXNJQ2Z0Z2JUcm9aenJrNXdnN1ppNDdMYWNJT3lMcE8yTXFEb2dKeWtwT3dvZ0lDQWdmUW9nSUgwS0lDQXZMeURyc29qc2w2MGc0b0NVSU8yVm5PcTFyZXlXdENEaWhwUWc3SmlCN0phMElPeWVrT3VQbVNBbzdMYVU3TEtjNnJPOElPcXdtZXlkZ0NEc2hManNoWmdnN0lLczdKcXBLUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkwY21GdWMyeGhkR1VuS1NCN0NpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ2FXWWdLQ0YwWlhoMElIeDhJQ0ZUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKK3V5aU95WHJlMlZvQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnlrN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclZISmhibk5zWVhSbEtGTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3NJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlZSeVlXNXpiR0YwWlN3Z1ptOXliV0YwUkdWell6b2dKM3NpZEhKaGJuTnNZWFJsWkNJNklDTHJzb2pzbDYzcnJMZ2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW1ScGNtVmpkR2x2YmlJNklDSnJiK0tHa21WdUlPdVlrT3VLbENCbGJ1S0drbXR2SW4wbklIMHBPd29nSUNBZ0lDQmpiMjV6ZENCdmRYUWdQU0J5TG5CaGNuTmxaRHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVc5MWRDa2dld29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPdXlpT3lYclNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryc29qc2w2MGc3Sm1FNjZPTUlDZ25JQ3NnYzJWaklDc2dKM01zSUNjZ0t5QW9iM1YwTG1ScGNtVmpkR2x2YmlCOGZDQW5QeWNwSUNzZ0p5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVkdWNGRDQTlJRk4wY21sdVp5aDBaWGgwS1M1emJHbGpaU2d3TENBek1DazdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhSeVlXNXpiR0YwWldRNklHOTFkQzUwY21GdWMyeGhkR1ZrTENCa2FYSmxZM1JwYjI0NklHOTFkQzVrYVhKbFkzUnBiMjRzSUdWdVoybHVaVG9nSjJOc1lYVmtaU2NnZlNrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0JtY21sbGJtUnNlVVZ5Y205eUtHVXNJQ2Z0Z2JUcm9aenJrNXdnNjdLSTdKZXRJT3lMcE8yTXFEb2dKeWtwT3dvZ0lDQWdmUW9nSUgwS0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdOQ3dnZXlCbGNuSnZjam9nSjA1dmRDQm1iM1Z1WkNjZ2ZTazdDbjBwT3dvS0x5OGc3SjIwNjYrNElPdUxwT3Vtck9xd2dDRHJscUFnN0o2STY0cVU2NDJ3SU91WWtDRHN2SnpxdUxEcXNJQWc2NU9rN0phMDdKaWs2Nm0wS095Z25PeUtwT3l5bUNEc25wRHJqNWtnN0x5YzZyaXdJT3lra2V1enRTRHJrN0VwSU95aHNPeWFxZTJlaUNEc29vWHJvNHdnNG9DVUlPdVBqT3VObUNEcmk2VHJwcXpyaXBRZzZyZTQ2NHlBNjZHY0lPeWNvT3luZ0FwelpYSjJaWEl1YjI0b0oyVnljbTl5Snl3Z0tHVXBJRDArSUhzS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2V3b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWR0T3V2dUNEc3ZKenNvTGdnN0o2STdKYTA3SnFVS08yUHJPMkt1Q0FuSUNzZ1VFOVNWQ0FySUNjZzdJS3M3SnFwSU95a2tTa2c0b0NVSU95ZHRDRHNuYmpzaXFUdGhMVHNpcVRyaXBRZzdLS0Y2Nk9NN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnY0hKdlkyVnpjeTVsZUdsMEtEQXBPd29nSUgwS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0lTYzY3S0VJT3lZcE91bG1Eb25MQ0JsSUNZbUlHVXViV1Z6YzJGblpTazdDaUFnY0hKdlkyVnpjeTVsZUdsMEtERXBPd3A5S1RzS0x5OGc3SmEwNjVha0lPcXl2ZXVobk91aG5DRHNvNzNyazZBbzdJdXM3SjZsNjdDVjY0K1pJT3VCaXVxNWdDd2dRM1J5YkN0RExDQXZjMmgxZEdSdmQyNHNJT3lZcE91bG1Da2dZMnhoZFdSbElPeWVrT3lMbmV5ZGhDRHJncWpxdUxEc3A0QWc3SldLNjRxVTY0dWtDbkJ5YjJObGMzTXViMjRvSjJWNGFYUW5MQ0FvS1NBOVBpQjdJR3RwYkd4UWNtOWpLQ2s3SUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNnZlNrN0NuQnliMk5sYzNNdWIyNG9KMU5KUjBsT1ZDY3NJQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1NrN0NuQnliMk5sYzNNdWIyNG9KMU5KUjFSRlVrMG5MQ0FvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrcE93b0tjMlZ5ZG1WeUxteHBjM1JsYmloUVQxSlVMQ0FuTVRJM0xqQXVNQzR4Snl3Z0tDa2dQVDRnZXdvZ0lHTnZibk52YkdVdWJHOW5LQ2ZpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBbktUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPMkJ0T3Vobk91VG5DRHJpNlRycHF3ZzdMeWM3S2VRSU9LQWxDQm9kSFJ3T2k4dmJHOWpZV3hvYjNOME9pY2dLeUJRVDFKVUtUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPdXFxT3VOdURvZ0p5QXJJRU5NUVZWRVJWOU5UMFJGVENBcklDY2d3cmNnN0ppSTdJdWNJQ2NnS3lCRldFRk5VRXhGVXk1c1pXNW5kR2dnS3lBbjZyRzBJT3llcGV5d3FTY3BPd29nSUdOdmJuTnZiR1V1Ykc5bktDY2c3SjIwSU95d3ZleWRoQ0Rzdkp6cmtaUWc2NCtaN0pXSUlPMlV2T3EzdU91bmlDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdZRzA2NkdjNjVPYzY2R2NJT3kybE95eW5PMlZxZXVMaU91THBDNG5LVHNLSUNCamIyNXpiMnhsTG14dlp5Z240cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBSnlrN0NpQWdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1RzZ0x5OGdRMnhoZFdSbElFTnZaR1VnN0lLczdKcXBJT3F3Z091S3BTRHNsNnpydG9BZzdLQ1E2cktBSUNqdGxJenJuNnpxdDdqc25iZ2c3SldJNjRLMDdKcXBLUW9nSUM4dklPdXZ1T3VtckNEc2k1enJqNWtnS3lEc3A0RHNpNXpyckxnZzdLTzg3SjZGSU9LQWxDRHNzcXNnN0xhVTdMS2M2N2FBN1lTd0lPdTVvT3VsdE9xeWpBb2dJR0Z6YTBOc1lYVmtaU2duN0p1TTY3Q043SmVGT2lBaTdLQ0E3SjZsSU91UW1PeVhpT3lLdGV1TGlPdUxwQ0luS1M1MGFHVnVLQW9nSUNBZ0tDa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWJqT3V3amV5WGhTRHNtWVRybzR3ZzRvQ1VJT3kybE95eW5DRHNwSURydVlRZzY0R2RMaWNwTEFvZ0lDQWdLR1VwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbTR6cnNJM3NsNFVnN0l1azdZeW9JQ2pzc3FzZzdKcVU3TEt0SU91VmpDRHNucXpzaTV6cmo0UXBPaWNzSUdVdWJXVnpjMkZuWlNrS0lDQXBPd3A5S1RzS0x5OGdTVkIyTmlEcm82anRsSVRyc0xFb09qb3hLZXlYa091UGhDRHRsYWpxdTVnZzY1T2o2NHFVNjR1a0lPS0FsQ0J0WVdOUFV5RHJrN0hzbDVEc2hKd2dKMnh2WTJGc2FHOXpkQ2Zxc0lBZ09qb3g2NkdjSU91b3ZPeWdnQ0R0bGJUc2hKM3JrSmpyaXBUcmpiQUtMeThnN1pTODZyZTQ2NmVJS0VWc1pXTjBjbTl1S1NCbVpYUmphT3VLbENCamRYSnM2ck84SU91THJPdW1yQ0JKVUhZMDY2R2NJT3lla091UG1TRHRqN1Ryc0xIdGxaanNwNEFnN0pXSzdKV0VMQ0JKVUhZMDY2ZU1JT3VUbyt1Tm1DRHJpNlRycHF6c2w1QWc3SmV3NnJLdzdKMjBJT3F4c091MmdPdVB2QW92THlEc3RwVHNzcHpDdCsyWHJPeUtwT3l5dE8yQnJPcXdnQ0Rzb2JEc21xbnRub2dnN0l1azdZeW83WmFJNjR1a0tPeUxwT3k0b1NBeU1ESTJMVEEzS1M0ZzZyQ1o3SjJBSU95YWxPeXlyU0R0bGJqcms2VHJuNnpycGJ3Z1NWQjJOaURybzZqdGxJVHJzTEhzbDVEcmo0UWc3SmE1NjRxVTY0dWtMZ3BqYjI1emRDQnpaWEoyWlhJMklEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9jMlZ5ZG1WeUxteHBjM1JsYm1WeWN5Z25jbVZ4ZFdWemRDY3BXekJkS1RzS2MyVnlkbVZ5Tmk1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJRWxRZGpZb09qb3hLU0RycHF6c2lxZ2c3SU9kNjU2MUlPS0FsQ0JKVUhZMDY2ZU1JT3lDck95YXFUb25MQ0JsSUNZbUlHVXViV1Z6YzJGblpTa3BPd3B6WlhKMlpYSTJMbXhwYzNSbGJpaFFUMUpVTENBbk9qb3hKeWs3Q2c9PScKQjY0X1dBVENIRVI9J0x5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tOQ2k4dklPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQTBLTHk4ZzdKbWNJTzJWaE95YWxPMlZuT3F3Z0RvZzdaUzg2cmU0NjZlSTZyQ0FJTzJVak91ZnJPcTN1T3lkdU95ZG1DQmpiR0YxWkdWaWNtbGtaMlU2THk4ZzdKZTA2cml3S0hkcGJtUnZkeTV2Y0dWdUwybG1jbUZ0WlM5dmNHVnVSWGgwWlhKdVlXd3A2Nlc4RFFvdkx5RHNvSVRydG9BZzdJYU02NmFzSU95WGh1eWR0Q0RycDRucmlwUWc2N0tFN0tDRTdKMjBJT3llaU91THBDNGdabVYwWTJqcmlwUWc2NnE3SU91bmlleWN2T3V2Z091aG5Dd2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPeWR0Q0Rxc0pEc2k1enNucERzbDVEcXNvd05DaTh2SUZCUFUxUWdMM2RoYTJVZzY2VzhJT3V6dE91Q3RPdXB0Q0Rxc0pEc2k1enNucERxc0lBZzY0dWs2NmFzS0dOc1lYVmtaUzFpY21sa1oyVXVhbk1wNjZXOElPdU1nT3lMb0NEc3ZLRHJpNlF1RFFvdkx3MEtMeThnNjR1azY2YXM3Sm1BN0oyWUlPeXdxT3lkdERvZzZyQ1E3SXVjN0o2UTY0cVVJR05zWVhWa1pldWx2Q0Ryckx6c3A0QWc3SldLNjRxVTY0dWtLT3lla095TG5TRHNsNGJzbll3cElPS0draUR0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3VsdkNEc2xZZ2c2NmVKNnJPZ0xBMEtMeThnNjZtVTY2cW82NmFzSUg0eE5VMUM2NTI4SU91aG5PcTN1T3lkdUNEc2k1d2c3SjZRNjQrWklPeUxuT3lla2V5Y3ZPdWhuQ0RzZzRIc2k1d2c3THljNjVHczY0K0VJT3UyZ091THRDRHNsNGJyaTZRZ0tPdVRzZXVoblRvZ2JuQnRJSEoxYmlCaWRXbHNaQ2t1RFFvdkx5RHJpNlRycHF6cmlwUWc3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTRzT3VwdENEc283M3NwNERycDR3bzdaU002NStzNnJlNDdKMjQ2ck84SU95RG5leUNyQ0RyajVucXVMRHRtWlFwTENEcXNKRHNpNXpzbnBEcmlwUWc2ck9FN0lhTklPdUNxT3lWaENEcmk2VHNuWXdnNnJtbzdKcXc2cml3NjZXOElPdXdtK3VLbE91THBDNE5DZzBLWTI5dWMzUWdhSFIwY0NBOUlISmxjWFZwY21Vb0oyaDBkSEFuS1RzTkNtTnZibk4wSUhCaGRHZ2dQU0J5WlhGMWFYSmxLQ2R3WVhSb0p5azdEUXBqYjI1emRDQm1jeUE5SUhKbGNYVnBjbVVvSjJaekp5azdEUXBqYjI1emRDQnZjeUE5SUhKbGNYVnBjbVVvSjI5ekp5azdEUXBqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNOQ2cwS1kyOXVjM1FnVUU5U1ZDQTlJREV4T0RnNU93MEtZMjl1YzNRZ1VrOVBWQ0E5SUhCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNwT3lBdkx5RHNvSURzbnFYc2hvd2c2Nk9vN1lxNElPS0FsQ0RyaTZUcnBxenFzSUFnY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xazY2VzhJT3l3dnV1S2xDRHF1TERzcElBTkNnMEtZMjl1YzNRZ1EwOVNVMTlJUlVGRVJWSlRJRDBnZXcwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VDNKcFoybHVKem9nSnlvbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFRXVjBhRzlrY3ljNklDZEhSVlFzSUZCUFUxUXNJRTlRVkVsUFRsTW5MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RTR1ZoWkdWeWN5YzZJQ2REYjI1MFpXNTBMVlI1Y0dVbkxBMEtmVHNOQ21aMWJtTjBhVzl1SUdwemIyNG9jbVZ6TENCemRHRjBkWE1zSUc5aWFpa2dldzBLSUNCeVpYTXVkM0pwZEdWSVpXRmtLSE4wWVhSMWN5d2dUMkpxWldOMExtRnpjMmxuYmloN0lDZERiMjUwWlc1MExWUjVjR1VuT2lBbllYQndiR2xqWVhScGIyNHZhbk52YmpzZ1kyaGhjbk5sZEQxMWRHWXRPQ2NnZlN3Z1EwOVNVMTlJUlVGRVJWSlRLU2s3RFFvZ0lISmxjeTVsYm1Rb1NsTlBUaTV6ZEhKcGJtZHBabmtvYjJKcUtTazdEUXA5RFFvTkNpOHZJR05zWVhWa1pTQkRURW5xc0lBZzdKNkk2NHFVN0tlQUlPS0FsQ0RzbDRic25MenJxYlFnTDNkaGEyVWc3SjJSNjR1MTdKZVFJT3lMcE95V3RDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdKV0k2NEswN1pXZ0lPeUltQ0Rzbm9qcXNvd2c3WldjNjR1a0RRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU95ZHZlcTRzQ0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOeklDanJpNlRycHF6c25aZ2dZMnhoZFdSbFFXTmpiM1Z1ZE95WmdDRHFzSm5zbllBZzdMYWM3TEtZS1M0TkNpOHZJTzJNak95ZHZPeWR0Q0R0Z2JRZzdJaVlJT3llaU95V3RDQXpNT3kwaUNEc3VwRHNpNXd1SU95ZXJPdWhuT3EzdU95ZHVPMlZtT3VwdENCRFRFbnFzSUFnN1l5TTdKMjg3SjJFSU9xd3NleUxvTzJWbU91dmdPdWhuQ0RzbnBEcmo1a2c2N0NZN0ppQjY1Q2M2NHVrTGcwS0x5OGc3THFRN0l1Y0lEWHN0SWdnNG9DVUlPdWhuT3EzdU95ZHVDRHNwNEh0bTRRZzdJT0lJT3F6aE95Z2xleWR0Q0RxczZmcnNKVHJvWndnN0o2aDdaaUE3Slc4SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA3SmVRN0lTY0lPMlppT3ljdk91aG5DRHJoSmpzbHJUcXNJVHJpNlFvTXpEc3RJanJxYlFnNjRTSTY2eTBJT3VLcHV5ZGpDa05DbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93MEtablZ1WTNScGIyNGdZMnhoZFdSbFFXTmpiM1Z1ZENncElIc05DaUFnYVdZZ0tFUmhkR1V1Ym05M0tDa2dMU0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQQ0ExTURBd0tTQnlaWFIxY200Z1lXTmpiM1Z1ZEVOaFkyaGxMbVZ0WVdsc093MEtJQ0JzWlhRZ1pXMWhhV3dnUFNCdWRXeHNPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3cwS0lDQWdJR1Z0WVdsc0lEMGdLR29nSmlZZ2FpNXZZWFYwYUVGalkyOTFiblFnSmlZZ2FpNXZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOektTQjhmQ0J1ZFd4c093MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyb1p6cXQ3anNuYmdnN0oyMDY2Q2xJT3lYaHV5ZGpDRHJrN0VnNG9DVUlHNTFiR3dnS2k4Z2ZRMEtJQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lCRVlYUmxMbTV2ZHlncExDQmxiV0ZwYkNCOU93MEtJQ0J5WlhSMWNtNGdaVzFoYVd3N0RRcDlEUW9OQ21aMWJtTjBhVzl1SUdoaGMwTnNZWFZrWlNncElIc05DaUFnWTI5dWMzUWdabWx1WkdWeUlEMGdjSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeUEvSUNkM2FHVnlaU2NnT2lBbmQyaHBZMmduT3cwS0lDQjBjbmtnZXlCeVpYUjFjbTRnYzNCaGQyNVRlVzVqS0dacGJtUmxjaXdnV3lkamJHRjFaR1VuWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lITm9aV3hzT2lCMGNuVmxJSDBwTG5OMFlYUjFjeUE5UFQwZ01Ec2dmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVjBkWEp1SUdaaGJITmxPeUI5RFFwOURRb05DbXhsZENCM1lXdHBibWNnUFNCbVlXeHpaVHNnTHk4ZzdKZXc3WU9BSU91d3FleW5nQ0RpZ0pRZzY0dWs2NmFzNjRxVUlPeVd0T3l3cU8yVXZDQkZRVVJFVWtsT1ZWTkY2NkdjSU95a2tldXp0U0Rzb0pYcnBxenRsWmpzcDREcnA0d2c3WlNFNjZHYzdJUzQ3SXFrSU91Q3JldTVoT3VsdkNEc3BJVHNuYmpyaTZRTkNtWjFibU4wYVc5dUlIZGhhMlZDY21sa1oyVW9LU0I3RFFvZ0lHbG1JQ2gzWVd0cGJtY3BJSEpsZEhWeWJqc05DaUFnZDJGcmFXNW5JRDBnZEhKMVpUc05DaUFnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3SUhkaGEybHVaeUE5SUdaaGJITmxPeUI5TENBMU1EQXdLVHNOQ2lBZ2JHVjBJSEJ5YjJNN0RRb2dJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdEUW9nSUNBZ0x5OGdWMmx1Wkc5M2N6b2dZMjFrd3JkMlluTWc2cks5N0p5Z0lPeVhodXlkdENCdWIyUmw2Nlc4SU95bmdleWdrU3dnZDJsdVpHOTNjMGhwWkdVb1ExSkZRVlJGWDA1UFgxZEpUa1JQVnlucm9ad2c3SXFrN1krd0lPS0FsQTBLSUNBZ0lDOHZJT3l3dlNEc2w0YnJpcFFnN0lpbzdKMkFJT3k5bU95R2xPeWR0Q0RycDR6cms2VHNsclRzcDREcXM2QWc2NHVrNjZhczdKMllJT3lla095TG5TaGpiR0YxWkdVcDY0K0VJT3EzdUNEc3ZaanNocFRzbllRZzY2eTg2NkNrNjdDYjdKV0VJT3lXdE91V3BDRHNzTDNyajRRZzdKV0lJT3Vjck91THBDNE5DaUFnSUNBdkx5QmtaWFJoWTJobFpPdUtsQ0RzazdEc3A0QWc3SldLNjRxVTY0dWtLR1JsZEdGamFHVmtLM2RwYm1SdmQzTklhV1JsSU95aHNPMlZxZXlkZ0NEc3ZaanNocFFnN0xDOTdKMjBJT3VGdU95Mm5PdVFxQ0RpZ0pRZzdJdWs3TGloS1M0TkNpQWdJQ0F2THlCWGFXNWtiM2R6N0plUTdJU2dJR1JsZEdGamFHVmtJT3lYaHV5ZHRPdVBoQ0RydG9EcnFxZ282ckNRN0l1YzdKNlFLZXF3Z0NEc283M3NsclRyajRRZzdKNlE3SXVkN0oyQUlPeUN0T3lWaE91Q3FPdUtsT3VMcEM0TkNpQWdJQ0J3Y205aklEMGdjM0JoZDI0b2NISnZZMlZ6Y3k1bGVHVmpVR0YwYUN3Z1czQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2RqYkdGMVpHVXRZbkpwWkdkbExtcHpKeWxkTENCN0RRb2dJQ0FnSUNCamQyUTZJRkpQVDFRc0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2QybHVaRzkzYzBocFpHVTZJSFJ5ZFdVc0RRb2dJQ0FnZlNrN0RRb2dJSDBnWld4elpTQjdEUW9nSUNBZ0x5OGdiV0ZqVDFNdjY2YXM2NGlGN0lxa09pRHFzSkRzaTV6c25wRHJwYndnNjUyRTdKcTBJRzV2WkdVZzdJdWs3WmFKSU8yTWpPeWR2T3VobkNEc3A0SHNvSkVnN0lxazdZK3dJQ2hzWVhWdVkyaGtJTzJabU9xeXZleVhsQ0JRUVZSSTZyQ0FJT3U1aU95VnZlMlZvQ0RzaUpnZzdKNkk3SmEwSU95Z2lPdU1nT3F5dmV1aG5DRHNncXpzbXFrcERRb2dJQ0FnY0hKdll5QTlJSE53WVhkdUtIQnliMk5sYzNNdVpYaGxZMUJoZEdnc0lGdHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTNXFjeWNwWFN3Z2V3MEtJQ0FnSUNBZ1kzZGtPaUJTVDA5VUxDQmtaWFJoWTJobFpEb2dkSEoxWlN3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTEEwS0lDQWdJSDBwT3cwS0lDQjlEUW9nSUhCeWIyTXVkVzV5WldZb0tUc2dMeThnNnJDUTdJdWM3SjZRSU95ZHRPdXlwTzJLdUNEcm82anRsSVRzbDVEc2hKd2c2N2FFNjZhc0lDanFzSkRzaTV6c25wQWc3S0tGNjZPTTY2VzhJT3VuaWV5bmdDRHNsWXJxc293cERRcDlEUW9OQ2k4dklPeWR0Q0JRUSt1bHZDQW43SVNrN0xtWUlPeWdoQ2pzZzRnZ1VFTXBKeURzZzRIdGc1enJvWndnNjVDWTY0K002NmF3NjR1a0lPS0FsQ0R0bEl6cm42enF0N2pzbmJnZ1creTBpT3E0c08yWmxGMGc2N0tFN1lxOEtGQlBVMVFnTDNWdWFXNXpkR0ZzYkNuc25iUWc2N2FBNjZXNDY0dWtMZzBLTHk4Z2NtVm5hWE4wWlhJdGNISnZkRzlqYjJ3dWFuUHFzSUFnN0lTazdMbVk3WldjSU9xeWcreWRoQ0RxdDdqcmpJRHJvWndnNjVDWTY0K002NmF3NjR1a09pRHFzSkRzaTV6c25wQWc3SjZRNjQrWjdJdWM3SjZSSUNzZ0tPeWVpT3ljdk91cHRDa2c3SVNrN0xtWUlPMlB0T3VObEM0TkNpOHZJT0thb08rNGp5RHJzSmpyazV6c2k1d2dTRlJVVUNEc25aSHJpN1hzbllRZzY2aTg3S0NBSU91enRPdUN1Q0Rya3FRZzdaaTQ3TGFjN1pXZ0lPcXlneURpZ0pRZ2JXRmpUMU1nYkdGMWJtTm9ZM1JzSUdKdmIzUnZkWFRzbmJRZzdKMjBJTzJVaE91aG5PeUV1T3lLcE91bHZDRHNwb25zaTV3ZzdLS0Y2Nk9NN0l1YzdZS3NJT3lJbUNEc25vanJpNlF1RFFvdkx5QWdJQ0RxdDdqcm5wanNoSndnN1l5TTdKMjhLSEJzYVhOMHdyZnNoS1RzdVpnZzdZKzA2NDJVS2V5ZGhDQnNZWFZ1WTJoamRHenJzN1RyaTZRZzY2aTg3S0NBSU95bmdPeWF0T3VMcENEaWdKUWdZbTl2ZEc5MWRPeWR0Q0RzbXJEcnBxenJwYndnN0tPOTdKZXM2NCtFSU95ZWtPdVBtZXlMbk95ZWtleWRnQ0RzbmJUcnI3Z2c3SUtzNjUyODdLZUU2NHVrTGcwS1puVnVZM1JwYjI0Z2RXNXBibk4wWVd4c1UyVnNaaWdwSUhzTkNpQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlGdGRPdzBLSUNCMGNua2dldzBLSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBblpHRnlkMmx1SnlrZ2V3MEtJQ0FnSUNBZ1kyOXVjM1FnVEVGQ1JVd2dQU0FuWTI5dExtTnNZWFZrWldKeWFXUm5aUzUzWVhSamFHVnlKenNOQ2lBZ0lDQWdJR052Ym5OMElIQnNhWE4wSUQwZ2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSjB4cFluSmhjbmtuTENBblRHRjFibU5vUVdkbGJuUnpKeXdnVEVGQ1JVd2dLeUFuTG5Cc2FYTjBKeWs3RFFvZ0lDQWdJQ0JqYjI1emRDQnBibk4wSUQwZ2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSjB4cFluSmhjbmtuTENBblFYQndiR2xqWVhScGIyNGdVM1Z3Y0c5eWRDY3NJQ2REYkdGMVpHVkNjbWxrWjJVbktUc05DaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0hCc2FYTjBLU2tnZXlCbWN5NTFibXhwYm10VGVXNWpLSEJzYVhOMEtUc2djbVZ0YjNabFpDNXdkWE5vS0hCc2FYTjBLVHNnZlNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWdmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNpQWdJQ0FnSUhSeWVTQjdJSE53WVhkdVUzbHVZeWduYkdGMWJtTm9ZM1JzSnl3Z1d5ZGliMjkwYjNWMEp5d2dKMmQxYVM4bklDc2djSEp2WTJWemN5NW5aWFIxYVdRb0tTQXJJQ2N2SnlBcklFeEJRa1ZNWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0Nkc1lYVnVZMmhqZEd3bkxDQmJKM0psYlc5MlpTY3NJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXcwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5WldjbkxDQmJKMlJsYkdWMFpTY3NJQ2RJUzBOVlhGeFRiMlowZDJGeVpWeGNUV2xqY205emIyWjBYRnhYYVc1a2IzZHpYRnhEZFhKeVpXNTBWbVZ5YzJsdmJseGNVblZ1Snl3Z0p5OTJKeXdnSjBOc1lYVmtaVUp5YVdSblpWZGhkR05vWlhJbkxDQW5MMlluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNnbjdKNlE2NCtaN0l1YzdKNlJLRU5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWElwSnlrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5WldjbkxDQmJKMlJsYkdWMFpTY3NJQ2RJUzBOVlhGeFRiMlowZDJGeVpWeGNRMnhoYzNObGMxeGNZMnhoZFdSbFluSnBaR2RsSnl3Z0p5OW1KMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE95QnlaVzF2ZG1Wa0xuQjFjMmdvSjJOc1lYVmtaV0p5YVdSblpUb3ZMeURyazdIcm9aMG5LVHNnZlNCallYUmphQ0FvWDJVcElIdDlEUW9nSUNBZ0lDQjBjbmtnZXcwS0lDQWdJQ0FnSUNCamIyNXpkQ0JwYm5OMElEMGdjR0YwYUM1cWIybHVLSEJ5YjJObGMzTXVaVzUyTGt4UFEwRk1RVkJRUkVGVVFTQjhmQ0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5RWEJ3UkdGMFlTY3NJQ2RNYjJOaGJDY3BMQ0FuUTJ4aGRXUmxRbkpwWkdkbEp5azdEUW9nSUNBZ0lDQWdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLR2x1YzNRcEtTQjdJR1p6TG5KdFUzbHVZeWhwYm5OMExDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTd2dabTl5WTJVNklIUnlkV1VnZlNrN0lISmxiVzkyWldRdWNIVnphQ2hwYm5OMEtUc2dmUTBLSUNBZ0lDQWdmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnZlEwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpQm1ZV2xzTFhOdlpuUWc0b0NVSU91cXV5RHNwNERzbXJRZzZyS01JT3llaU95V3RPdVBoQ0R0bEl6cm42enF0N2pzbmJnZzdLcTlJT3E0c095V3RTRHNncTNzb0p6cmlwUWc3SjIwNjYrNElPdUJuZXVDck91THBDQXFMeUI5RFFvZ0lISmxkSFZ5YmlCeVpXMXZkbVZrT3cwS2ZRMEtEUW92THlEcmk2VHJwcXdvTVRFNE9EZ3A2ckNBSU91V29DRHNub2pzbkx6cnFiUWc2NEdJNjR1a0lPS0FsQ0RzdElqcXVMRHRtWlFnN0l1Y0lPdUNxT3lkZ0NEc2hManNoWmdnN0tDVjY2YXNJQ2pzbDRic25MenJxYlFnN0tHdzdKcXA3WjZJSU95THBPMk1xQ2tOQ21aMWJtTjBhVzl1SUhOb2RYUmtiM2R1UW5KcFpHZGxLQ2tnZXcwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElISWdQU0JvZEhSd0xuSmxjWFZsYzNRb2V5Qm9iM04wT2lBbk1USTNMakF1TUM0eEp5d2djRzl5ZERvZ01URTRPRGdzSUhCaGRHZzZJQ2N2YzJoMWRHUnZkMjRuTENCdFpYUm9iMlE2SUNkUVQxTlVKeXdnZEdsdFpXOTFkRG9nTVRVd01DQjlMQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3ZlNrN0RRb2dJQ0FnY2k1dmJpZ25kR2x0Wlc5MWRDY3NJQ2dwSUQwK0lIc2dkSEo1SUhzZ2NpNWtaWE4wY205NUtDazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZTQjlLVHNOQ2lBZ0lDQnlMbVZ1WkNncE93MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DbjBOQ2cwS1kyOXVjM1FnYzJWeWRtVnlJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvS0hKbGNTd2djbVZ6S1NBOVBpQjdEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIME5DaUFnYVdZZ0tISmxjUzUxY213Z1BUMDlJQ2N2YUdWaGJIUm9KeWtnZXcwS0lDQWdJQzh2SUhZNklPcXdrT3lMbk95ZWtDRHN2WlRyazV3ZzY3S0U3S0NFSU9LQWxDRHF0YXpyc29Uc29JUWc3WlNFNjZHYzdJUzQ3SXFrNnJDQUlPcXpoT3lHalNEcmo0enFzNkFnN0o2STY0cVU3S2VBSU91d2x1eVhrT3lFbkNEdG1aWHNuYmp0bFpqcmlwUWc3SnFwNjQrRURRb2dJQ0FnTHk4Z0tIWXlJRDBnN0xDOUlPeUlxT3E1Z0NEc2lKanNvSlh0akpBc0lIWXpJRDBnTDJGalkyOTFiblFnN0xhVTZyQ0E3WXlRTENCMk5DQTlJQzkxYm1sdWMzUmhiR3dnN0xhVTZyQ0E3WXlRS1EwS0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQjNZWFJqYUdWeU9pQjBjblZsTENCMk9pQTBJSDBwT3cwS0lDQjlEUW9nSUM4dklPeWR0Q0JRUSt5WGtDRHJvWnpxdDdqc25ianJrSndnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0RpZ0pRZzdaU002NStzNnJlNDdKMjRJT3l5cXlEdG1aVHJxYlRDdCsyWmlPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFRzcDRBaUlPdXp0T3lYck95anZPdUtsQ0RyamJBZzdKTzA2NHVrTGcwS0lDQXZMeURxc0pEc2k1enNucERxc0lBZzY0dTE3WldZNjRxVUlPeWR0T3ljb0RvZzY0dWs2NmFzNjZXOElPeThuT3VwdENEc200enJzSTNzbDRYc25MenJvWndnN1lHMDY2R2M2NU9jNnJDQUlPeUxwT3lnbkNEdG1ManN0cHpyajd3ZzZyV3M2NCtGSU95Q3JPeWFxZXVmaWV5ZHRDRHJncGpxc0lUcmk2UXVEUW9nSUM4dklPcXdrT3lMbk95ZWtPdUtsQ0R0akl6c25ienJwNHdnN0oyOTdKeTg2NitBNjZHY0lPeUNyT3lhcWV1ZmlTQXdJTUszSU91TWdPcTRzQ0F3SU9LQWxDRHFzb0R0aHFEcnA0d2c3Sk93NjRxVUlPeUNyT3Vlak95WGtPcXlqQ0RydVlUc21xbnNuWVFnNjZ5ODY2YXM3S2VBSU95Vml1dUtsT3VMcEM0TkNpQWdMeThnN0tPODdKMllPaURzbDZ6cXVMQWc2ck9FN0tDVjdKMjBJT3V6dE95WHJPdVBoQ0Rzbm9Yc25xWHF0b3pzbmJRZzY2ZU02Nk9NNjVDUTdKMkVJT3lJbUNEc25vanJpNlFvN0p5ZzdacW83SVN4N0oyQUlPeUxwT3lnbkNEdG1ManN0cHdnNjVXTTY2ZU1JT3lWakNEc2lKZ2c3SjZJN0oyTUlPS0FsQ0RyaTZUcnBxd2dMMmhsWVd4MGFPeWRtQ0J3Y205aWJHVnRJT3l3dU9xem9Da3VEUW9nSUdsbUlDaHlaWEV1ZFhKc0lEMDlQU0FuTDJGalkyOTFiblFuS1NCN0RRb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJR0ZqWTI5MWJuUTZJR05zWVhWa1pVRmpZMjkxYm5Rb0tTd2dZMnhoZFdSbE9pQm9ZWE5EYkdGMVpHVW9LU0I5S1RzTkNpQWdmUTBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZDJGclpTY3BJSHNOQ2lBZ0lDQnBaaUFvSVdoaGMwTnNZWFZrWlNncEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1WnljZ2ZTazdEUW9nSUNBZ2QyRnJaVUp5YVdSblpTZ3BPdzBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCM1lXdHBibWM2SUhSeWRXVWdmU2s3RFFvZ0lIME5DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM05vZFhSa2IzZHVKeWtnZXcwS0lDQWdJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrc0lESXdNQ2s3RFFvZ0lDQWdjbVYwZFhKdU93MEtJQ0I5RFFvZ0lDOHZJT3kwaU9xNHNPMlpsQ0RpZ0pRZzdKMjBJRkJENjZXOElDZnNnNGdnVUVNbklPeURnZTJEbk91aG5DRHJrSmpyajR6cnByRHJpNlFnS08yVWpPdWZyT3EzdU95ZHVDQmI3TFNJNnJpdzdabVVYU0Ryc29UdGlyd3BMZzBLSUNBdkx5RHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPMmRtT3VncE91enRPdUN1Q0Rya3FRZzdLQ1Y2NmFzN1pXYzY0dWtJT0tBbENCaWIyOTBiM1YwN0oyMElPeWFzT3Vtck91bHZDRHNwb25zaTV3ZzdLTzk3SmVzNjQrRUlPMmFqT3lMb095ZGdDRHJqNFRzc0tudGxaenJpNlF1RFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5MWJtbHVjM1JoYkd3bktTQjdEUW9nSUNBZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2NHeGhkR1p2Y20wNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0RRb2dJQ0FnSUNCemFIVjBaRzkzYmtKeWFXUm5aU2dwT3cwS0lDQWdJQ0FnWTI5dWMzUWdjbVZ0YjNabFpDQTlJSFZ1YVc1emRHRnNiRk5sYkdZb0tUc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiZDJGMFkyaGxjbDBnN0xTSTZyaXc3Wm1VS0hWdWFXNXpkR0ZzYkNrZzRvQ1VJT3lnbk9xeHNEb25MQ0J5WlcxdmRtVmtMbXB2YVc0b0p5d2dKeWtnZkh3Z0p5anNsNGJzbll3cEp5azdEUW9nSUNBZ0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1N3Z01qQXdLVHNOQ2lBZ0lDQjlMQ0F5TlRBcE93MEtJQ0FnSUhKbGRIVnlianNOQ2lBZ2ZRMEtJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TkN3Z2V5Qmxjbkp2Y2pvZ0owNXZkQ0JtYjNWdVpDY2dmU2s3RFFwOUtUc05DZzBLTHk4ZzdKMjA2Nis0SU91V29DRHNub2pzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lpaGV1ampDQW83SjZRNjQrWklPeUxuT3lla1NBcklHNXdiU0JpZFdsc1pDRHNwSkhyczdVZzdJdWs3WmFKSU91TWdPdTVoQ2tOQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXcwS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3cwS0lDQndjbTlqWlhOekxtVjRhWFFvTVNrN0RRcDlLVHNOQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc05DaUFnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHRnYlRyb1p6cms1d2c2NHVrNjZhc0lPcXdrT3lMbk95ZWtDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFySUZCUFVsUXBPdzBLZlNrN0RRb3ZMeUJKVUhZMklPdWpxTzJVaE91d3NTZzZPakVwN0plUTY0K0VJTzJWcU9xN21DRHJrNlByaXBUcmk2UWc0b0NVSUNkc2IyTmhiR2h2YzNRbjZyQ0FJRG82TWV1aG5DRHJxTHpzb0lBZzdaVzA3SVNkNjVDWTY0cVVJTzJabU9xeXZleVhrT3lFbkEwS0x5OGc3WlM4NnJlNDY2ZUlJR1psZEdObzZyQ0FJRWxRZGpUcm9ad2c3WSswNjdDeDdaV1k3S2VBSU95Vml1eVZoQ0RyaTZUcnBxd2c2cm1vN0pxdzZyaXd3cmZxczRUc29KVWc3S0d3N1pxTTZyQ0FJT3loc095YXFlMmVpQ0RzaTZUdGpLanRsWmpyalpnZzY2eTQ3S0NjSU91TWdPeWRrU2pyaTZUcnBxenNtWUFnNjQrWjdKMjhLUzROQ21OdmJuTjBJSE5sY25abGNqWWdQU0JvZEhSd0xtTnlaV0YwWlZObGNuWmxjaWh6WlhKMlpYSXViR2x6ZEdWdVpYSnpLQ2R5WlhGMVpYTjBKeWxiTUYwcE93MEtjMlZ5ZG1WeU5pNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3SUM4dklEbzZNZXlkaENEcnFyc2c3SjZoN0pXRTY0K0VLRVZCUkVSU1NVNVZVMFhDdDBsUWRqWWc3SmVHN0oyTUtTQkpVSFkwNjZlTTdKeTg2NkdjSU9xemhPeUdqU0RyajVuc25wRU5Dbk5sY25abGNqWXViR2x6ZEdWdUtGQlBVbFFzSUNjNk9qRW5LVHNOQ2c9PScKQjY0X0VYQU1QTEVTPSdJeURyckxqcXRhd2c3TGFVN0xLY0lPeVlpT3lMbkFvS0l1dXN1T3ExckNEc3RwVHNzcHpyc0p2cXVMQWk2ckNBSU95Q3JPeWFxZTJWbU91S2xDRHNtSWpzaTV3ZzY2cW83SjJNN0o2RjY0dUk2NHVrTGlBcUt1eWR0Q0R0akl6c25ienNuWVFnN0lpWTdLQ1Y3WldjSU91U3BDRHRoTERycjdqcmhKRHNsNURzaEp3Z1lHNXdiU0J5ZFc0Z1luVnBiR1JnNjZXOElPeUxwTzJXaWUyVm1PcXpvQ3dnUm1sbmJXSHNsNURzaEp3ZzdaU002NStzNnJlNDdKMjQ3SjJFSU91THBPeUxuQ0RzaTZUdGxvbnRsWmpycWJRZzY3Q1k3SmlCNjVDcDY0dUk2NHVrTGlvcUNnb2pJeURzbnBIc2hMRWc2N0NwNjdLVkNnb3RJT3lZaU95TG5DRHRsWmpyZ3BqcmlwUWdLaXBnSXlNaklPeWJrT3V6dUdBcUtpRHRsWndnN0tTRTZyTzhMQ0RxdDdnZzdKV0U2NTZZSUNvcVlDMGc3TGFVN0xLYzdKV0lZQ29xSU95WHJPdWZyQ0Rxc0p6cm9ad2c3SjIwNjZTRTdLZVI2NHVJNjR1a0xnb3RJT3kybE95eW5PeVZpQ0RzbFlqc2w1RHNoSndnS2lyc3BJVHNuWVFnNjdDVTZyNjQ2ck9nSU95THR1eWN2T3VwdENCZ0lDOGdZQ0FvN0pXZTY1S2tJT3F6dGV1d3NTRHRqNnp0bGFnZzdJcXM2NTZZN0l1Y0tTb3FJT3VobkNEdGtaenNpNXp0bFpqc2hManNtcFF1SU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEcmtaQWc3S1NFNjZHY0lPdXp0T3lYck95bmtldUxpT3VMcEM0S0xTRHNncXpzbXFuc25wRHFzSUFnN0o2RjY2Q2w3WldjSU91c3VPcTFyT3F3Z0NCZzdKdVE2N080WU9xenZDQW82ck8xNjdDeHdyZnJyTGpzbnFYcnRvRHRtTGdnNjZ5MDdJdWM3WldZNnJPZ0tTRHFzSm5xc2JEcmdwZ3NJT3lFbk91aG5DRHRqNnp0bGFqdGxaanJxYlFnNnJlNElPeTJsT3l5bk95VmlPdVRwT3lkaENEcnM3VHNsNnpzcEkzcmk0anJpNlF1Q2kwZzY2ZWs3TG10N1pXZ0lPdVZqQ0FxS3V1bmlPeUtwTzJDdWV1UW5DRHNuYlRycG9RbzdabU5YQ3JyajVrcExDRHNpS3ZzbnBBbzdLQ0U3Wm1VNjdLSTdaaTR3cmNpN0ptNElETHJxb1VpSU91VHNTbnJpcFFnNjZ5MDdJdWNLaXJ0bGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWFsR0FnWUg3cmo3enNtcFJnSUdCKzdKZUc3SmEwN0pxVVlDQmdmdTJWdENEc283enNoTGpzbXBSZ0tRb3RJRExyaTZnZzZyV3M3S0d3T2lBcUt1eXlxeURzcElROTdJT0I3Wm1wSU95RXBPdXFoU0RpaHBJZzY1R1k3S2U0SU95a2hEM3JpNlRzbll3ZzdaYUo2NCtaS2lvbzZyS3c3S0NWN0oyQUlHQis3WldnNnJtTTdKcVVQMkFzSU8yV2lldVBtU0RzbktEcmo0VHJpcFFnWUg3dGxiUWc3S084N0lTNDdKcVVZQ2tLTFNEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0tPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ2tzSU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBbzdKZUc3SmEwN0pxVTRvYVNmdTJWbU91cHRDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDa0tMU0RzdXBEc283enNscnp0bFp3ZzZySzk3SmEwS0g3c2k1enFzcURzbHJUc21wUS80b2FTZnUyVm9PcTVqT3lhbEQ4cExDRHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNDanNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2M0b2FTN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5Da0tMU0Rxc0lUcXNyRHRsWmpxczZBZzdJbXM3SnEwSU91bmtDQW83S0NFN0lhaDRvYVM2N08wNjRLMDY0dWtLU3dnNjdhQTdLQ1ZJT3lEZ2UyWnFldVBoQ0RybExIcmxMSHRsWmpzcDRBZzdKV0s2cktNS0NMc3NMN3F1TEFnN0l1azdZeW9JdUtkakNBaTdMQys3SjJFSU95SW1DRHNsNGJzbHJUc21wUWk0cHlGS1FvS0l5TWc3TGFVN0xLY0lPeVlpT3lMbkFvS0l5TWpJT3luaE8yV2llMlZtT3VObUNEc25wSHNsNFhzbmJRZzdKNkk3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0tlRTdaYUpJT3lra2V5ZHVDRHJnclRzbDYzc25iUWc3SjZJN0phMDdKcVVMaUF2SU95ZHRPeVd0T3lFbkNEc3A0VHRsb250bGFEcXVZenNtcFEvQ2dvakl5TWc2ck8xN0p5Z0lPeWFsT3l5cmV5ZGhDRHN0NmpzaG96dGxaanJxYlFnN0pxVTdMS3RJT3VDdE95WHJleWR0Q0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kzcU95R2pPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXloT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwSU95anZPeUV1T3lhbEM0Z0x5RHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2lNakl5RHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4S0xTRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhLTFNEc2k2RHFzNkFnN0oyMDdKeWc2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0o2VTdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVQ2kwZzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMZ29LSXlNaklPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnN0ptNElETHJxb1hzbDVEcXNvd2c2cmFNN1pXY0lPeUNyZXlnbkNEc2xZenJwcnp0aHFIc25ZUWc3S0NFN0lhaDdaV2c2cm1NN0pxVVB3b3RJT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3RPdWdwT3F6b0NEdGxiVHNtcFF1SUM4ZzdabU5LdXVQbVNnd01UQXRNVEl6TkMwMU5qYzRLU0RyaTVnZzdKbTRJRExycW9Yc2w1RHFzb3dnNjdPMDY0Szg2cm1NN0pxVVB3b3RJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzY0dVlJT3ladUNBeTY2cUY3SmVRNnJLTUlPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdk9xNWpPeWFsRDhLTFNEcXRvenRsWndnN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4S0NpTWpJeURyb1p6cXQ3anNsWVRzbTRNZzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3Vobk9xM3VPeVZoT3liZysyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbGJIc25ZUWc3S0tGNjZPTTdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3lWc2V5ZGhDRHNvb1hybzR6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nN1pXY0lPdXlpQ0RyczREcXNyM3RsWmpycWJRZzY0dWs3SXVjSU91emdPcXl2ZTJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzY0dWs3SXVjSU91d2xPcS9nQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6aE95R2plMlZvT3E1ak95YWxEOEtDaU1qSXlEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpya0tucmk0anJpNlF1SU95MGlPcTRzTzJabE8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmo3enNtcFF1SUM4ZzdMU0k2cml3N1ptVTdaV2c2cm1NN0pxVVB3b0tJeU1qSXlEc2w1RHJuNnpDdCt5THBPMk1xQW9LSXlNaklPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPdUVwTzJLdU95YmpPMkJyT3lYa0NEc2w3RHFzckR0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc2w3RHFzckFnN0lPQjdZT2M2Nlc4SU8yWmxleWR1TzJWbU9xem9DRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ienNpNXpzb0lIc25iZ2c3SmlrNjZXWTZyQ0FJT3V3bk95RG5lMldpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0RzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0k3Wmk0NjZXOElPeWVyT3V3bk95R29lMlZtT3lMcmV5TG5PeVlwQzRLTFNEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95bmdPdUNyT3lXdE95YWxDNGdMeURzbmJqc3BwM3Jzb2p0bUxqcnBid2c2NHVrN0l1Y0lPdXdtK3lWaENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzbHJUc21wUXVJQzhnNjR1azY2VzRJT3F5Z095RGlleVd0T3VobkNEcmk2VHNpNXdnN0xDKzdKV0U2N08wN0lTNDdKcVVMZ29LSXlNaklPeWdsZXV6dE91bHZDRHJ0b2pybjZ6c21LVHNwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNvSlhyczdUcnBid2c2N2FJNjUrczdKaXNJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHRqSXpzbmJ3ZzdKZUY2NkdjNjVPYzdKZVFJT3lMcE8yTXFPMldpT3lLdGV1TGlPdUxwQzRLTFNEdGpJenNuYnpzbllRZzdKaXM2NmFzN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRnTHlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0tDUTZyS0FJT3lra2V5ZWhldUxpT3VMcEM0ZzdKMjA3SnFwN0plUUlPdTJpTzJPdU95ZGhDRHJrNXpyb0tRZzdLT0U3SWFoN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHNoSnpydVlUc2lxVHJwYndnN0tDUTZyS0E3WldZNnJPZ0lPeWVpT3lXdE95YWxDNGdMeURzb0pEcXNvRHNuYlFnNjRHZDY0S1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxZVHNpSmdnN0o2RjY2Q2xJTzJWcmV1cXFleWVoZXVMaU91THBDNEtMU0RxdkswZzdKNkY2NkNsN1pXMDdKVzhJTzJWbU91S2xDRHRsYTNycXFuc25iVHNsNURzbXBRdUNnb2pJeU1qSU9xMmpPMlZuTUszN0lTazdLQ1ZDZ29qSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVBtZXlkbU8yVm1PeW5nQ0RzbFlyc2xZUWc3SjI4NjdhQUlPcTRzT3VLcGV5ZHRDRHNvSnp0bFp6cmtLbnJpNGpyaTZRdUNpMGc3SnlFN0xtWUlPeWdsZXV6dE91bHZDRHRsNGpzbXFudGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3SnlFN0xtWUlPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHNtWVRybzR6Q3QreW5oTzJXaVFvS0l5TWpJT3lnZ095ZXBldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNvSURzbnFYdGxvanNsclRzbXBRdUNnb2pJeU1nNjdPQTZySzk3SUtzN1pXdDdKMjBJT3lnZ2V5YXFldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzNERxc3IwZzY0SzA3SnFwN0oyRUlPeWdnZXlhcWUyV2lPeVd0T3lhbEM0S0NpTWpJeURzb0lUc2hxSHNuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dE91RGlPeVd0T3lhbEM0S0NpTWpJeURyazdIcm9aM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3VUc2V1aG5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1nN0lLdDdLQ2M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lDcmV5Z25PMldpT3lXdE95YWxDNEtDaU1qSXlEdGdiVHJwcjNyczdUcms1enNsNUFnNjdPMTdJS3M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dGV5Q3JPMldpT3lXdE95YWxDNEtDaU1qSXlEc21wVHNzcTNzbllRZzdMS1k2NmFzSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SnFVN0xLdDdKMkVJT3l5bU91bXJPMlZtT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3lWaU91Q3RNSzM3SnlnNjQrRUNnb2pJeU1nN0lPSTY2R2M3SnEwSU91eWhPeWdoT3lkdENEc3RwenNpNXpya0pqc2w0anNpclhyaTRqcmk2UXVJT3lYaGV1TnNPeWR0TzJLdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVZoT3liZyt1UWtPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1RzbFlqc25ZUWc3SnlFN1pXMElPdTVoT3V3Z091eWlPMll1T3VsdkNEcnM0RHFzcjN0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEc2xZanNvSVR0bFp3ZzdJS3M3SnFwN0oyRUlPeWNoTzJWdENEcnVZVHJzSURyc29qdG1ManJwYndnNjdDVTZyK1VJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc2N08wN0pXSUlPeUVuT3U1aE95S3BBb0tJeU1qSU9xeXZldTVoT3VsdkNEcXNKenNpNXp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzZySzk2N21FNjZXOElPeUxuT3lla2UyVm9PcTVqT3lhbEQ4S0NpTWpJeURxc3IzcnVZVHJwYndnN1pXMDdLQ2M3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU9xeXZldTVoT3VsdkNEdGxiVHNvSnp0bGFEcXVZenNtcFEvQ2dvakl5TWc2cml3NnJpdzZyQ0FJT3lZcE8yVWhPdWR2T3lkdUNEc2c0SHRnNXpzbm9Ycmk0anJpNlF1SU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc25ZUWc3Wm1WN0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU9xNHNPcTRzT3F3Z0NEcmhLVHRpcmpzbTR6dGdhenNsNUFnN0pldzZyS3c2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyaXc2cml3N0oyWUlPeVhzT3F5c0NEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21JSHNnNEhzbllRZzY3YUk2NStzN0ppazY0cVVJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKaUI3SU9CN0oyRUlPdTJpT3Vmck95WXBPcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95M3FPeUdqTzJWbU95THBDRHFzcjNzbXJBZzdJdWc3TEt0N1pXWTdJdWdJT3VDdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXdnQ0Rzbm9qcmdwanNtcFEvQ2dvakl5TWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdWx2Q0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTTY0cVVJT3lXdk91bmlPeWR1T3F3Z095YWxEOEtDaU1qSXlEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvY2c2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1Q2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUhJT3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsWmpzaTV6cXNxRHNsclRzbXBRL0NpMGc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOEtDaU1qSXlEc2k1enNucEh0bFpqc2k1enJpcFFnNjdhRTdKZVE2cktNSURVc01EQXc3SnVRN0oyRUlPdVRuT3VncE95YWxDNEtMU0RzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMZ29LSXlNaklPeWR0T3lla0NEdG1aanJ0b2pzbllRZzY3Q2I3SldZN0phMDdKcVVMZ290SU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRdUNnb2pJeU1nN0ppazY0cVk3SjJZSU8yQXRPeW1pT3F3Z0NEcXM2Y2c3S0tGNjZPTTY0Kzg3SnFVTGdvdElPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEM0S0NpTWpJeURxdUlqc25ienF1WXpzcDRBZzY2KzQ2NEtwSU95TG5DRHNsN0Rzc3JRZzdMS1k2NmFzNjVDcDY0dUk2NHVrTGlEdG00VHJ0b2pxc3JEc29Kd2c2cmlJN0pXaDdKMkVJT3VDcWV1MmdPMlZtT3lMbk9xNHNDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdKaWs2NHFZNnJtTTdLZUFJT3VDdE95bmdDRHNsWXJzbkx6cnFiUWc3SmV3N0xLMDY0Kzg3SnFVTGlBdklPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2tPcXlnQ0RxdUxEcXNJVHNsNURyaXBRZzdJU2M2N21FN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHNuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkdENEcmhibnNuWXpya0tucmk0anJpNlF1Q2kwZzY0MlVJT3lpaSt5ZGdDRHNnNEhyaTdUc25ZUWc3SnlFN1pXMElPMkd0ZTJabENEcmdyVHNtcW5zbllBZzY0VzU3SjJNNjQrODdKcVVMZ29LSXlNaklPcXpvT3F3bmV1TG1PeWRtQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkZ0NEcXVMRHJvWjBnNnJTQTY2YXM2NUNwNjR1STY0dWtMZ290SU95ZHRPeWduT3UyZ08yRXNDRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWR0Q0RxdUxEcm9aM3JqN3pzbXBRdUNnb2pJeU1nN0xLdDdJYU02NFdFN0oyQUlPeUVuT3U1aE95S3BDRHFzSURzbm9Yc25iUWc2N2FJNnJDQTdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YWxDNEtDaU1qSXlNZzZyT0U3S0NWd3Jmc25vWHJvS1VLQ2lNakl5RHNsWVRzbmJUcmxKUWc2NWlRNjRxVUlPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3lkdE95RGdTRHNucGpycXJzZzdKNkY2NkNsN1pXWTdKZXNJT3F6aE95Z2xleWR0Q0RzbnFEcXVJZ2c3TEtZNjZhczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3llbU91cXV5RHNub1hyb0tYdGxiVHNoSndnNnJPRTdLQ1Y3SjIwSU95ZW9PcXl2T3lXdE95YWxDNGdMeURydVlUcnNJRHJzb2p0bUxqcnBid2c3SjZzN0lTazdLQ1Y3WldZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNuYlRycjdnZzdJS3M3SnFwSU95a2tleWR1Q0RzbFlUc25iVHJsSlRzbm9Ycmk0anJpNlF1Q2kwZzdKMjA2Nis0SU95VHNPcXpvQ0Rzbm9qcmlwUWc3SldFN0oyMDY1U1U3SmlJN0pxVUxpQXZJT3VMcE91bHVDRHNsWVRzbmJUcmxKVHJwYndnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzM2cml3N1lPQUNnb2pJeU1nN1l5TTdKMjhJT3lhcWV1ZmlleWR0Q0RzdElqcXM3enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlERXdUVUlnN0oyMDdaV1k3SjJZSU8yTWpPeWR2T3VuakNEc2w0WHJvWnpyazV3ZzZyQ0E2NHFsN1pXcDY0dUk2NHVrTGdvdElERXdUVUlnN0oyMDdaV1lJTzJNak95ZHZPdW5qQ0RzbUt6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHRqSXpzbmJ3ZzdKcXA2NStKN0oyRUlPMlpsZXlkdU8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0dWs3SnEwNjZHYzY1T2M2ckNBSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyaTZUc21yVHJvWnpyazV6cnBid2c2NmVJN0xPazdKYTA3SnFVTGdvS0l5TWpJT3F5c095Z25PeVhrQ0RzaTZUdGpLanRsWmpzbUlEc2lyWHJpNGpyaTZRdUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEcXNyRHNvSnp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPcXlzT3lnbkNEc2lKanJpNmpzbllRZzdabVY3SjI0N1pXWTZyT2dJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXWTdKZXNJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXp0ZXF3aE95ZGhDRHRtWlhyczdUdGxad2c2NUtrSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lFbk91NWhPeUtwQ0RzcElEcnVZUWc3S1NSN0o2RjY0dUk2NHVrTGdvdElPeWtnT3U1aE8yVm1PcXpvQ0Rzbm9qcmlwUWc2cml3NjRxbDdKMjA3SmVRN0pxVUxpQXZJT3loc09xNGlPdW5qQ0RxdUxEcmk2VHJvS1FnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3VUc2V1aG5TRHFzSURyaXFYdGxad2c3TFdjNjR5QUlPcXduT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPeWdoTzJabU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPdXdsT3EvZ09xNWpPeWFsRDhLQ2lNakl5RHJzS25yckxnZzdKaUk3Slc5N0oyMElPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnNLbnJyTGdnN0ppSTdKVzk3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEcnVZVHJzSURyc29qdG1MZ2dOZTJhakNEc21LVHJwWmpyb1p3ZzZyT0U3S0NWN0oyMElPeWVvT3E0aUNEc3NwanJwcXpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJRFh0bW93ZzdKNlk2NnE3SU95ZWhldWdwZTJWdE95RW5DRHFzNFRzb0pYc25iUWc3SjZnNnJLODdKYTA3SnFVTGlBdklPdTVoT3V3Z091eWlPMll1T3VsdkNEc25xenNoS1Rzb0pYdGxaanJxYlFnNjR1azdJdWNJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd0lDanNsNGJzbHJUc21wUWc0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFwQ2dvakl5TWc2N080N0oyNElPeWR1T3ltbmV5ZGhDRHRsWmpzcDRBZzdKV0s3Snk4NjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEcnM3anNuYmdnN0oyNDdLYWQ3SjJFSU8yVm1PdXB0Q0RycXFqcms2QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeWR0T3VwbE95ZHZDRHNuYmpzcHAwZzdLQ0U3SmVRNjRxVUlPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95ZHRPdXBsT3lkdkNEc25ianNwcDNzbllRZzY2ZUk3TG1ZNjZtMElPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95L29PMlBzT3lkZ0NEcm9aenF0N2pzbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjBJT3lnbk8yVm5PdVFxZXVMaU91THBDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXWTY2bTBJT3VxcU91VG9DRHF1TERyaXFYc25ZUWc3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzY3aVU2Nk9vN1lpczdJcWs2ckNBSU9xNnZPeWd1Q0Rzbm9qc2xyUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU91NGxPdWpxTzJJck95S3BPdWx2Q0Rzdkp6cnFiUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU91NWhPeURnU0RzbDdEcm5iM3NzcGpxc0lBZzY1T3g2NkdkNjVDWTdLZUFJT3lWaXV5Vm1PeUt0ZXVMaU91THBDNEtMU0RydVlUc2c0RWc3SmV3NjUyOTdMS1k2Nlc4SU91VHNldWhuZTJWbU91cHRDRHF1TFRxdUludGxhQWc2NVdNSU91NW9PdWx0T3F5akNEc2w3RHJuYjNyazV6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzdHB6c25vVWc3TG0wNjVPYzZyQ0FJT3VUc2V1aG5ldVFtT3luZ0NEc2xZcnNsWVFnN0lLczdKcXA3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdMYWM3SjZGSU95NXRPdVRuT3VsdkNEcms3SHJvWjN0bFpqcnFiUWc2N0NVNjZHY0lPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0lDanNtWVRybzR3ZzdKV0k2NEswS1FvS0l5TWpJTzJhak95YmtPcXdnT3llaGV5ZHRDRHNtWVRybzR6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzZyQ0E3SjZGN0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHNtSWpzbGIzc25iUWc3TGVvN0lhTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeVlpT3lWdmV5ZGhDRHN0NmpzaG96dGxvanNsclRzbXBRdUNnb2pJeU1nNjZ5NDdKMlk2ckNBSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SWljN0xDbzdLQ0I3Snk4NjZHY0lPdUx0ZXV6Z091VG5PdW1yT3F5b095S3RldUxpT3VMcEM0S0xTRHJyTGpzblpqcnBid2c3S0NSN0lpWTdaYUk3SmEwN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTA2NWFrSU91d3FldXlsZXljdk91aG5DRHNuYmpzcHAzdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SjI0N0thZElPdXdxZXV5bGV5ZGhDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPcXlzT3lnbk8yVm1PeUxwQ0RzdWJUcms1enJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rxc3JEc29KenRsYUFnN0xtMDY1T2M2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0p1UTdaV1k3SXVjNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsWmpzaExqc21wUXVDaTBnN0p1UTdaV1k2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWp2T3lHak91bHZDRHNsWXpxczZBZzZyT0U3SXVnNnJDQTdKcVVQd290SU95anZPeUdqT3VsdkNEc2xZenFzNkFnN0o2STY0S1k3SnFVUHdvS0l5TWpJeURycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQW9LSXlNaklPcTRzT3F3aENEcnA0enJvNHpyb1p3ZzdKMjA3SnFwN0oyMElPeWtrZXluZ091UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc25iVHNtcWtnNnJpdzZyQ0U3SjIwSU91Qm5ldUNtT3lFbkNEc3A0RHF1SWpzbllBZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0pxcDY1K0pJT3UyZ095aHNleWN2T3VobkNEc29JRHNucVhzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95Z2dPeWVwZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1Q2dvakl5TWc3WWExN0l1Z0lPeVlwT3VsbU91aG5DRHNtcFRzc3Ezc25iUWc3SXVrN1l5bzdaV1k3SmlBN0lxMTY0dUk2NHVrTGdvdElPMkd0ZXlMb095ZHRDRHNtNUR0bVp6dGxaanNwNEFnN0pXSzdKV0VJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95anZPeUdqT3VsdkNEdG1aWHNuYmp0bFpqcXNiRHJncGdnN1ptSTdKeTg2NkdjSU95ZHRPdVBtZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjQrWjdKMjg3WldjSU95YWxPeXlyZXlkdENEc3NwanJwcXdnN0tTUjdKNkY2NHVJNjR1a0xpRHNucURzaTV3ZzdadUVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc2ckNaN0oyQUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanFzNkFnN0o2STdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYlRyc3FUdGlyanFzSUFnN0tLRjY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdE91eXBPMkt1T3F3Z0NEcmdaM3JncXpzbHJUc21wUXVDZ29qSXlNZzdZT0k3WWUwSU95TG5DRHJxcWpyazZBZzY0Mnc3SjIwN1lTdzZyQ0FJT3lDcmV5Z25PdVFtT3Vwc0NEcnM3WHF0YXp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHRnNGp0aDdUdGxaanJxYlFnNjZxbzY1T2dJT3VOc095ZHRPMkVzT3F3Z0NEc2dxM3NvSnpya0pqcXM2QWc2NHVrN0l1Y0lPdVFtT3VQak91bXRDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWdsZXVua0NEdGc0anRoN1R0bGFEcXVZenNtcFEvQ2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3lEZ2UyWnFTRHNsWWpyZ3JRcENnb2pJeU1nNjdhQTdKNnNJT3lra1NEcnNLbnJyTGpzbnBEcXNJQWc2ckNRN0tlQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTJnT3llckNEc3BKSHNsNUFnNjdDcDY2eTQ3SjZRNnJDQUlPeWVpT3lYaU95V3RPeWFsQzRnTHlEc21JSHNnNEhzbllRZzdabVY3SjI0N1pXMElPdXp0T3lFdU95YWxDNEtDaU1qSXlEcXNyM3J1WVFnN1pXMDdLQ2NJT3Eyak8yVm5PeWR0Q0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cks5NjdtRUlPMlZ0T3lnbkNEcXRvenRsWnpzbmJRZzdaV0U3SnFVN1pXMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RzbXBUc3NxM3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRtSnp0ZzUwZzdKZUc3SjIwSU9xd2dPeWVoZTJWb09xNWpPeWFsRDhnN0tlQTZyaUlJT3lMb095eXJlMlZtT3luZ0NEc2xZcnNuTHpycWJRZzdKdXc3THUwSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzcDREcXVJZ2c3SXVnN0xLdDdaV1k2Nm0wSU95YnNPeTd0Q0R0bUp6dGc1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0wrZzdZK3dJT3lYaHV5ZHRDRHFzckRzb0p6dGxhRHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1Q0RzdjZEdGo3RHNuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUNpMGc3TCtnN1krdzdKMkVJT3V3bSt5Y3ZPdXB0Q0RyalpRZzdLQ0E2NkMwN1pXWTZyS01JT3F5c095Z25PMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95VmpPdW12Q0RzbDRic25iUWc3SXVjN0o2UjdaV2c2cm1NN0pxVVB5RHNsWXpycHJ6c25ZUWc3THljN0tlQUlPeVZpdXljdk91cHRDRHNwSkhzbXBUdGxad2c3SWFNN0l1ZDdKMkVJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPeVZqT3Vtdk95ZGhDRHN2SnpycWJRZzdLU1I3SnFVN1pXY0lPeUdqT3lMbmV5ZGhDRHJzSlRyb1p3ZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdKNlE2NCtaN0oyMDdMSzA2Nlc4SU91VHNldWhuZTJWbU95bmdDRHNsWXJxczZBZzY0U1k3SmEwNnJDSTZybU03SnFVUHlEcms3SHJvWjN0bFpqc3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNucERyajVuc25iVHNzclRycGJ3ZzY1T3g2NkdkN1pXWTY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURyczdnZzZyT0U3Slc5N0oyWUlPeWNvT3lkdk8yVm5DRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95ZHZPdXdtT3EwZ091bXJPeWVrT3VobkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0nCkI2NF9HVUlERT0nSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5BMEtEUW9qSXlBeExpRHRsYlRzbXBUc3NyUU5DZzBLN0tDYzdaS0lJT3lWaU95ZG1DRHJxcWpyazZBZzY2eTQ2cldzNjRxVUlDZnRsYlRzbXBUc3NyUW42NkdjSU95TnFPeWFsQzROQ3V5ZHZPcTBnT3lFc1NEc25vanJpcFFnN0lLczdKcXA3SjZRSU9xeXZlMlhtT3lkaENEcnA0enJrNlFnN0lpWUlPeWVpT3VQaE91aG5TQXFLdXlEZ2UyWnFTd2c2NmVsNjUyOTdKMkVJT3UyaU91c3VPMlZtT3F6b0NEcnFxanJrNkFnNjZ5NDZyV3M3SmVRSU8yVnRPeWFsT3l5dE91bHZDRHNvSUhzbXFudGxiVHNvN3pzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEcnM3VHJnNFhyaTRqcmk2UWc0b2FTSU91enRPdUN2T3F5ak95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJT3kxbk91TWdPMlZuQ0FxS3V1S3BldVBtZTJZbFNEcnJManNucVVxS3V5ZGhDRHNqYWpzbzd6c2hManNtcFF1SU95SW1PdVBtZTJZbFNEcnJManNucVhzbllBZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TVMzc2lKanJqNW50bUpVdDY2eTQ3SjZsN0oyRUxleU5xT3VQaEMzcmtKanJpcFF0NnJLOTdKcXdLZXlYa0NEdGxiVHJpN250bGFBZzY1V002NmVNSU95VHNPdUtsQ0Rxc293ZzdLS0w3SldFN0pxVUxnMEtEUW9qSXlNZzY1Q1E3SmEwN0pxVUlPS0draUR0bG9qc2xyVHNtcFFOQ2cwSzdKaUlLUTBLTFNEc2hLVHNvSlhya0pEc2xyVHNtcFFnNG9hU0lPeUVwT3lnbGUyV2lPeVd0T3lhbEEwS0RRb2pJeU1nSjM3c2w0Z25JT3U1dk9xNHNBMEtEUXJzbUlncERRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVURRb05DaU1qSXlEcmo1bnNncXdnNjdDVTZyK1U3Sk93NnJpd0RRb05DdXlZaUNrTkNpMGc2NGFTN0pXRTdLR003SmEwN0pxVUlPS0draURzbUt6cm5wRHNsclRzbXBRTkNnMEtLaW9xRFFvTkNpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBTkNnMEs3S0NjN1pLSUlPeVZpT3lYa095RW5DRHJ0b0Rzb0pYc29JRWc3THVrNjY2azY0dUk3THlBN0oyMDdJV1k3SjJFSU95MW5PdU1nTzJWbkNEc3BJVHNuYlRxczZBZzZyaU43S0NWN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpzbzd6c2hManNtcFF1RFFycnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRNdDY3YUE3S0NWN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2phanNtcFF1RFFvTkN1eVlpQ0E2SU95VmlDRHJqN3pzbXBRc0lPeVhodXlXdE95YWxDQW9XQ2tnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRZ0tFOHBEUW9OQ2lNakl5RHNsNGJzbHJUc21wUWc0b2FTSU95ZWlPeVd0T3lhbEEwS0RRcnNtSWdwRFFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsWmpxdUxBZzdLQ0U3SmVRNjRxVUlPcXdnT3llaGUyVm9DRHNpSmdnN0plRzdKYTA3SnFVSU9LR2tpRHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WlcwN0pXOElPcXdnT3llaGUyVm9DRHNpSmdnN0o2STdKYTA3SnFVRFFvTkNpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFEUW9OQ3V5WGtPdWZyQ0RzZzRIdG1hbnNsNURzaEp6cmo0UWdJdTJWdE9xeXNDRHJzS25yc3BVaTdKMkVJT3Vvdk95Z2dDRHNsWXpyb0tUc283enJpcFFnNnJpTjdLQ1Y3WmlWSU9xMXJPeWhzT3VobkNEc2phanNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRnNG9hU0lPeVZzZXlkaENEc2w0WHJqYkRzbmJUdGlyanRsYlRzbzd6c2hManNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95MW5PeUxvQ0Ryc29Uc29JVHNuYlFnN1pXRTdKcVU3WlcwN0pxVUxnMEtEUW82T2pvZ2RHbHdJTzJNbmV5WGhTRHJzb1R0aXJ6c25ZQWdXemd1SU8yTW5leVhoVjBnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbEEwSzdZeWQ3SmVGS091THBPeWR0T3lXdk91aG5PcTN1Q2tnNjdLRTdZcThJT3VzdU9xMXJPdUtsQ0RzbFlUcm5wZ2dLaW80TGlEdGpKM3NsNFVxS2lEc2hMbnNoWmdnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbENEaWdKUWc3WWExNjdPMDY0cVVJRnZ0bVpYc25iaGRMQ0RzbUlndjdKV0U2NHVJN0ppa0lPMk1rT3VMcU95ZGdDQmI3SldFNjR1STdKaWtYY0szVyt1RXBGMHNJT3VQbWV5ZWtTRHNuS0RyajRUcmlwUWdXK3kzcU95R2pGM0N0MXZyajVuc25wRmRMaUFpN0xlbzdJYU1JdXVLbENEcmo1bnNucEVnNjdLRTdZcTg2ck84SU95bm5leWR2Q0RybFl6cnA0d2c3Sk93NnJPZ0xDQWk2NHVyNnJpd0lNSzNJT3VQbWV5ZWtTTHNzcGpybjd3ZzdLZWQ3SjIwSU95VmlDRHJwNTdyaXBRZzdLR3c3WldwN0oyQUlPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRbzZPam9OQ2cwS0l5TWpJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eWRoQ0RybFl3TkNnMEs3SmlJS1EwS0xTRHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNGc0b2FTSU95VnZlcTBnT3lYa0NEcmo1bnNuWmp0bFpqcnFiUWc2NnFvN0o2RTdLZUE3SnVRNnJpSTdKMkVJT3V3bSt5ZGhDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb2pJeU1nN1ppYzdZT2RJT3VNZ095RGdTRHNsWWpyZ3JRTkNnMEtLaXJzaEp6cnVZVHNpcVRyaXBRZzdKTzRJT3lJbUNEc25vanNwNERycDR3c0lPMkt1ZXlnbFNEdG1KenRnNTNzbllBZzY3Q2I3SjJFSU95SW1DRHNsNGJzbllRZzY1V01JT0tHa2lEcXVJM3NvSlh0bUpVZzY2eTQ3SjZsN0p5ODY2R2NJT3lOcU95YWxDNHFLZzBLN0lLczdKcXA3SjZRNjRxVUlPdXN1T3Exck91bHZDRHF2THpxdkx6dG5vZ2c3SjI5N0tlQUlPeVZpdXF6b0NEdG01SHNsclRyczdUcXVMQW83SXFrN0xxVUtTRHJsWXpyckxqc2w1QXNJT3UyZ095Z2xlMllsZXljdk91aG5DRHNrN0RycWJRZzdLQ2M3WktJSU95Z2hPeXl0T3VsdkNEc2s3Z2c3SWlZSU95WGh1dUxwT3F6b0NEc21LVHRsYlR0bFpqcXVMQWc3SW1zN0p1TTdKcVVMZzBLRFFyc21JZ3BEUW90SU9xemhPeWlqQ0Rxc0p6c2hLUWc3WmljN1lPZDdKMkFJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlEaWhwSWdOQzQxSlNEcXVJanJwcXdnN1ppYzdZT2Q2NmVNSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTkM0ZzdMcVE3S084N0phODdaV2NJT3F5dmV5V3RBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJQ2QrN0l1YzZyS2c3SmEwN0pxVVB5Y3NJQ2ZzaTV6cmdwanNtcFEvSnl3Z0ozN3F1NWduSU9xd21leWRnQ0Rxczd6cmo0VHRsWndnNnJLOTdKYTA2Nlc4SU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFyc3RaenJqSUR0bFp3ZzdMcVE3S084N0phODdaV1k2ck9nSU95NW5PcTN2TzJWbkNEcnA1RHRpS3pycGJ3ZzdKT3c2NHFVSU9xeWpDRHNvb3ZzbFlUc21wUXVEUXJxc3Izc2xyVHJpcFFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNaTNxc3Izc2xyVHJwYnd0N0kybzY0K0VMZXVRbU91S2xDM3FzcjNzbXJBcDdKZVFJTzJWdE91THVlMlZvQ0RybFl6cnA0d2c3STJvN0pxVUxnMEtEUW9qSXlNZzY0K1o3SUtzN0plUTdJU2NJQ2QrN0l1Y0p5RHJ1YnpxdUxBTkNnMEs3SmlJS1EwS0xTRHN1YlRyazV6cnBid2c3WlcwN0tlQTdaV1k3SXVjNnJLZzdKYTA3SnFVUHlEaWhwSWc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOE5DaTBnN0l1YzdKNlI3WldZN0l1YzY0cVVJT3UyaE95WGtPcXlqQ0ExTERBd01PeWJrT3lkaENEcms1enJvS1RzbXBRdUlPS0draURzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMZzBLRFFvakl5TWdKK3F6aE95TG5PdUxwQ2NnNG9hU0lDZnNub2pyaTZRbkRRb05DdXlZaUNrTkNpMGc3SjZRNjQrWjdMQ282Nlc4SU9xd2dPeW5nT3F6b0NEcXM0VHNpNXpyZ3Bqc21wUS9JT0tHa2lEc25wRHJqNW5zc0tqcXNJQWc3SjZJNjRLWTdKcVVQdzBLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NSU95V3ZPdW5pT3lVcVNEcmdyVHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB5RGlocElnNjZlazY0dXNJT3V6dE8yWG1PdWpqT3VLbENEc2xyenJwNGpzbmJqcXNJRHNtcFEvSUNvbzY0dW83SWljSU95NW1PMlptT3lkdENEc2xZVHJpNGpybmJ3ZzY2eTQ3SjZsN0oyRUlPeURpT3VobkNEc2s3UWc3SUtzNjZHQTdKaUk3SnFVS1NvTkNnMEtJeU1qSUNmc2w2enNyWWpyaTZRbklPS0draUFuN1ptVjdKMjQ3WldZNjR1a0xDRHJyTHZyaTZRbkRRb05DdXlZaUNrTkNpMGc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFINnJDQTdLZUFJT3VMcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUlPS0draURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9mcXNJRHNwNEFnNjR1azdJdWNJTzJabGV5ZHVPMlZvT3F5ak95YWxDNE5DZzBLSXlNaklDZnF1NWduSU9LR2tpQW43SmVRNnJLTUp3MEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbU9xN21DRHJncURzbFlUcXNJRHFzNkFnN0o2STdKYTA3SnFVTGlEaWhwSWc3Wm1ONnJpNDY0K1o2NHVZN0plUTZyS01JT3VDb095VmhPcXdnT3F6b0NEc25vanNsclRzbXBRdURRb05DaU1qSXlEcXNyM3NsclRycGJ3ZzY3cVE3SjJFSU91VmpDRHNsclRzZzRudGxad2c2cks5N0pxd0RRb05DdXlDck95YXFleWVrT3lkbUNEc29KWHJzN1RycGJ3ZzY3Q2I2NHFVSU95bmlPdXN1T3lYa095RW5DRHF1TERxczRUc29JSHNuTHpyb1p3Z0ozN3NpNXduNjZXOElPdTZrT3lkaENEcmxZd2c2Nnk0N0o2bDdKMjBJT3lXdE95RGllMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtLaXJ0akl6c2xZWHRsWmpxczZBZzdJdTI3SjJBSU95Z2xldXp0T3VsdkNBbjdLTzg3SmEwSit1aG5DRHNqYWpzaEp3ZzY2eTQ3SjZsN0oyRUlPeURpT3VocmVxeWpDRHNqYWpyczdUc2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VNZ095Mm5DRHJxcW5zb0lIc25iUWc2NnkwN0plSDdKMjQ2ckNBN0pxVVB3MEtMU0RzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhnNG9hU0lPeUxvT3F6b0NEc25iVHNuS0RycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lFdU95YWxDNE5DZzBLS2lvcURRb05DaU1qSURVdUlDZDc2NnFGN0lLc2ZTQXJJSHZycW9Yc2dxeDlKeURzazdEc3A0QWc3SldLNnJpd0RRb05DaU1qSXlEdGxaenNucERzbHJRZzdaS0E3SmEwN0pPdzZyaXdEUW9OQ3UyVm5PeWVrT3lXdENEcnFvWHNncXpycGJ3ZzdaS0E3SmEwN0lTY0lPdVBtZXlDckNEdG1KWHRnNXpyb1p3ZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrTkNpMGc3SjIwN0o2UUlPMlptT3UyaU95ZGhDRHJzSnZzbFpqc2xyVHNtcFFnNG9hU0lPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUU5DaTBnNjRLMDdKMjhJT3k1dE91VG5PcXdrdXlkdENEcXNyRHNvSnpya0tBZzdKaUk3S0NWN0oyMDdKZVE3SnFVSU9LR2tpRHJnclRzbmJ6c25ZQWc3TG0wNjVPYzZyQ1NJT3VDbU9xd2dPdUtsQ0RyZ3FEc25iVHNsNURzbXBRTkNnMEtJeU1qSU8yVm5PeWVrT3lXdE91bHZDRHRrb0RzbHJUc2s3RHF1TEFnN0phMDY2Q2s3SnE0SU9xeXZleWFzQTBLRFFvbmUrdXFoZXlDckgzcXNJQWdlK3VxaGV5Q3JIM3RsYlRzaEp3bklPMllsZTJEbk91aG5PdW5qQ0R0a29Ec2xyVHNwSmpyajRRZzY0MlVJT3k2a095anZPeVd2TzJWbU9xeWpDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjSU9xMXJPdW5wTzJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFFnNG9hU0lPeWVsT3lWb2V5ZHRDRHJ0b0Rzb2JIdGxiVHNoSndnNnJXczY2ZWs3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ05pNGc3WkdjNnJpd0lPMkd0ZXlkdkEwS0RRb2pJeU1nNjVDWTdKYTA3SnFVSUNoWUtTRGlocElnNjQrODdKcVVJQ2hQS1EwS0RRcnJxcWpyc0pUc25id2c3Wm1VNjZtMDdKMllJT3lpZ2V5ZGdDRHFzN1hxc0lUc25ZUWc2ck9nNjZDazdaVzBJQ2Zya0pqc2xyVHNtcFFuNjRxVUlPdXFxT3VSa0NBbjY0Kzg3SnFVSit1aG5DRHRoclhzbmJ6dGxiVHNoSndnN0kybzdLTzg3SVM0N0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTnk0ZzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt5SXEreWVrQ0R0a1p6cXVMQU5DZzBLNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3V5aU8yWXVPdUtsQ0RzbFlUcm5wZ2c3WmlWN0l1ZDdKeTg2NkdjSU8yR3RleWR2TzJWdE95RW5DRHNqYWpzbXBRdURRb05DaU1qSXlEcmdxRHNwNXpDdCt5TG5PcXdoTUszNnJpdzZyQ0VEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzY0S2c3S2VjSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRVlDQXZJT3lucCtxeWpDQmdUVTB1UkVSZ0lId2dNakF5TlM0d01TNHdNU3dnTWpVdU1ERXVNREVnZkEwS2ZDRHNpNXpxc0lRZ2ZDRHF1TERyczdnZ1lFaElPazFOT2xOVFlDQXZJT3lucCtxeWpDQmdTRWc2VFUxZ0lDanNtS1Rzb0lRdjdKaWs3WnVFSU95VmlDRHNsSUFwSUh3Z01UUTZNekE2TVRFc0lERXpPak13SUh3TkNud2c2cml3NnJDRUlId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVmbGxaV1ZrdVRVMHVSRVJnSUM4ZzdLZW42cktNSUdCWldWbFpMazFOTGtSRWZrMU5Ma1JFWUNCOElESXdNalV1TURFdU1ERitNakF5TlM0d01TNHpNU3dnTWpBeU5TNHdNUzR3TVg0d01TNHpNU0I4RFFwOElPdUNvT3lubkNBcklPeUxuT3F3aENCOElHQlpXVmxaTGsxTkxrUkVJRWhJT2sxTllDQjhJREl3TWpVdU1ERXVNREVnTVRRNk16QWdmQTBLZkNEc21wVHNuYndnZkNCZ1dWbFpXUzVOVFM1RVJDanNtcFRzbmJ3cFlDRGlnSlFnN0p1VUwrMlpsQy9zaUpndjY2cXBMK3E0aUMvdGhxQXY3SjI4SUh3Z01qQXlOUzR3TVM0d01TanNpSmdwSUh3TkNnMEtLaXJzaTV6cXNJUWc3SmlJN0ptNEtpbzZJT3lDck95YXFleWVrT3F3Z0NEc3A0SHNvSkVnNnJPZzY2VzA2NHFVSU91d3FldXN1TUszN0ppSTdKVzlJT3lMbk9xd2hPeWRnQ0JnN0ppazdLQ0VMK3lZcE8yYmhDQklPazFOWU95ZGhDRHNqYWpyajRRZzY0Kzg3SnFVTGcwSzdKaUlLU0RzbUtUdG00UWdNVG93TUEwS0RRb2pJeU1nNjZ5NDdKNmxJT3lHalNEc2w3RHNtNVRzbmJ3TkNnMEs2Nnk0N0o2bElPeVZpT3lYa095RW5PdUtsQ0FxS3V5YmxNSzM3SjI4SU95Vm51eWRtQ0F3N0oyRUlPdTV2T3F6b0NvcUlPeU5xT3lhbEM0TkNnMEs3SmlJS1EwS0xTQXlNREkyNjRXRUlEQTQ3SnVVSURBMTdKMjhJT3llaGV1TGlPdUxwQzRnNG9hU0lESXdNamJyaFlRZ09PeWJsQ0ExN0oyOElPeWVoZXVMaU91THBDNE5DZzBLSXlNaklPeURnZXVNZ0NEc2k1enFzSVFnS091RnVPeTJuT3lhcVNrTkNnMEtmQ0Rzb2JEcXNiUWdmQ0R0a1p6cXVMQWdmQTBLZkMwdExTMHRMWHd0TFMwdExTMThEUXA4SURZdzdMU0lJT3V2dU91bmpDQjhJT3V3cWVxNGlDRHNvSVFnZkEwS2ZDQTJNT3UyaENEcnI3anJwNHdnZkNCTzY3YUVJT3lnaENCOERRcDhJREkwN0l1YzZyQ0VJT3V2dU91bmpDQjhJRTdzaTV6cXNJUWc3S0NFSUh3TkNud2dNekRzbmJ3ZzY2KzQ2NmVNSUh3Z1R1eWR2Q0Rzb0lRZ2ZBMEtmQ0F4TXVxd25PeWJsQ0RycjdqcnA0d2dmQ0JPNnJDYzdKdVVJT3lnaENCOERRcDhJREV5NnJDYzdKdVVJT3lkdE95RGdTQjhJRTdyaFlRZzdLQ0VJSHdOQ2cwSzdKaUlLU0Ryc0tucXVJZ2c3S0NFTENBMTY3YUVJT3lnaEN3Z011eUxuT3F3aENEc29JUXNJRFBzbmJ3ZzdLQ0VMQ0EyNnJDYzdKdVVJT3lnaEN3Z011dUZoQ0Rzb0lRTkNnMEtJeU1qSU91bmlPcXdrTUszNnJpdzZyQ0VJT3Vuak91ampBMEtEUXBnUkMxT1lDaE83SjI4SU91Q3FPeWRqQ2tnTHlCZ1JDMHdZQ2pzbUtUcmlwZ2c2NmVJNnJDUUtTQXZJR0JFSzA1Z0tFN3NuYndnNnJLOTZyTzhLUTBLN0ppSUtTQkVMVGNzSUVRdE1Td2dSQzB3TENCRUt6RU5DZzBLSXlNaklPdXlpTzJZdUNEdGtaenF1TEFnS08yVm1PeWR0TzJVaU95Y3ZPdWhuQ0RxdGF6cnRvUXBEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzdLQ0U3Wm1VNjdLSTdaaTRJSHdnN1pXWTdKMjA3WlNJSU9xMXJPdTJoQ0I4SURBeUxURXlNelF0TlRZM09Dd2dNREV3TFRFeU16UXROVFkzT0NCOERRcDhJT3k1dE91VG5PdXlpTzJZdUNCOElEVHNucERycHF6c2xLa2c3WldZN0oyMDdaU0lJSHdnTVRJek5DMDFOamM0TFRrd01USXRNelExTmlCOERRcDhJT3F6aE95aWpPdXlpTzJZdUNCOElPMlZtT3lkdE8yVWlDRHF0YXpydG9RZ2ZDQXhNak10TkRVMkxUYzRPVEF4TWlCOERRcDhJT3lqdk91dnZPdVRzZXVobmV1eWlPMll1Q0I4SU95Vm5pQTI3SjZRNjZhc0xldVNwQ0EzN0o2UTY2YXNJSHdnTVRJek5EVTJMVEV5TXpRMU5qY2dmQTBLZkNEc2dxenNsNFhzbnBEcms3SHJvWjNyc29qdG1MZ2dmQ0F4TU95ZWtPdW1yQ0R0bFpqc25iVHRsSWdnZkNBd01TMHlNelF0TlRZM09Ea2dmQTBLRFFvakl5TWc3Sk93NjZtMElPeVZpQ0Rya0pqcmlwUWc3WkdjNnJpd0RRb05DaTBnNjRLZzdLZWM3SmVRSU8yVm1PeWR0TzJVaU1LMzY3bVg2cmlJT2lEaW5Zd2dNakF5TlMwd01TMHdNU3dnTURFdk1ERU5DaTBnN0l1YzZyQ0U3SmVRSU95WXBPeWdoQy9zbUtUdG00UTZJT0tkakNEc21LVHNvSVFnTWV5TG5DQXFLT3VMcUN3ZzdJS3M3SnFwN0o2UTZyQ0FJT3luZ2V5Z2tTRHFzNkRycGJUcmlwUWc2N0NwNjZ5NHdyZnNtSWpzbGIwZzdJdWM2ckNFN0oyQUlPeVlpT3ladUNrcURRb05DaW9xS2cwS0RRb2pJeUE0TGlEdGpKM3NsNFVvNjR1azdKMjA3SmE4NjZHYzZyZTRLUTBLRFFydGpKM3NsNFVnNjZ5NDZyV3M2NHFVSUNvcTdKZXQ3WldnS2lvbzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdkNucXM3d2dLaXJzbktEdG1KVXFLaWp0aHJYcnM3UXY3WXlRNjR1b0tleVhrQ0RybExEcm5id2c2Nnk0N0xLMDZyQ0FJT3VMck91ZHZPeWFsQzRnN1lPQTdKMjA3WXVBN0oyRUlPdUxwT3VUck95ZGhDRHJsWkFnNjdDWTY1T2M3SXVjSU95VmlPdUN0Q2pyczdqcnJMZ3A2cm1NN0tlQUlPcXdtZXlkdENEcnM3VHFzNkFzSU91enVPdXN1Q0RycDZYcm5iM3NuWVFnNjR1MDdKV0U3Slc4SU8yVnRPeWFsQzROQ2cwS0l5TWpJRERyaTZqcXM0UWc0b0NVSU8yS3VPdW1yT3F4c091MmdPMkVzQ0RydEpEc21wUU5DZzBLN1l5ZDdKZUY3SjIwSU95Q3JPeWFxZXlla095ZG1DRHNsclRybHFRZzdaYUo2NCtaSU91U3BPeVhrQ0RybktqcmlwVHNwNEFnNjZpODdLQ0FJTzJNak95VmhlMlZ0T3lhbEM0TkNnMEtMU0R0bG9ucmo1bnNuWVFnS2lycXNJRHJvWnpycDRucXNiRHJncGdnN1l5UTY0dW83SjJFSU95YWxPcTFyQ29xS095ZHRPMkRpTUszN0lLdDdLQ2N3cmZyb1p6cXQ3anNsWVRzbTRQQ3QreWloZXVqakNrZzRvYVNJQ29xN1l5UTY0dW83WmlWS2lvZ0tPdXN2T3lXdE91MGtPeWFsQ2tOQ2kwZzZyS3c2ck84d3Jmc2c0SHRnNXpycGJ3Z0tpcnRoclhyczdUcnA0d3FLaUFvN0ptRTY2T013cmZzaTZUdGpLZ3BJT0tHa2lBcUt1eVZpT3VDdE8yWWxTb3FJQ2pzbFl6cm9LVHNwSmpzbXBRcERRb05DaU1qSXlEdGc0RHNuYlR0aTRBZzRvQ1VJT3lucCt5ZGdDRHJxb1hzZ3F6cXRhd05DZzBLTFNEcnFvWHNncXp0bUpYc25MenJvWndnNjRHZDY0SzA3SnFVTGlEc29vWHFzckRzbHJUcnI3akN0K3VuaU95NXFPMlJuT3VsdkNEc2s3RHNwNEFnN0pXSzdKV0U3SnFVSUNoKzdKcVVJQzhnZnV1THBDQXZJSDdxdVl6c21wUS9JT0tkakNrdURRb3RJREorTk95V3RPeWdpT3VobkNEc3A2ZnFzNkFnN0ltOTZyS01MaUR0bFp6c25wRHNsclRDdCt5SW1PeUxuZXlkaENEcXVManFzb3dnN0l5VDdLZUFJT3lWaXV5VmhPeWFsQzROQ2kwZzdKV0k2NEswS091enVPdXN1Q2tnNjZlbDY1Mjk3SjJFSU95YWxPeVZ2ZTJWdEN3Z0tpcnRnNERzbmJUdGk0RHJwNHdnNjdTUTY0K0VJT3VzdE95S3FDRHRqSjNzbDRYc25ianNwNEFxS2lEc2xZenFzb3dnN1pXMDdKcVVMaURzbTVEcnM3anNuYlFnSit5VmpPdW12TUszN1ptVjdKMjRKK3l5bU91ZnZDRHJwNG5zbDdEdGxaanJxYlFnNjdPNDY2eTQ3SjJFSU9xM3ZPcXhzT3VobkNEcXRhenNzclR0bVpUdGxiVHNtcFF1RFFvTkNud2c3SjIwNjZDSDZyS01JT3Vua09xem9DQjhJT3lkdE91Z2grcXlqQ0I4RFFwOExTMHRmQzB0TFh3TkNud2c3S0NBN0o2bDdaV1k3S2VBSU95Vml1cXpvQ0RyZ3BqcXNJRHNpNXpxc3FEc2xyVHNtcFEvSUh3ZzdLQ0E3SjZsSU95VmlDRHRsWndnNjRLMDdKcXBJSHdOQ253ZzdKV002NmE4SUh3ZzZyS3c3S0NjSU95WmhPdWpqQ0I4RFFwOElPeWdsZXVua0NEc2dxM3NvSnp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSUh3ZzY0Mnc3SjIwN1lTd0lPeUNyZXlnbkNCOERRb05DaU1qSXlEc2xZanJnclFvNjdPNDY2eTRLU0RpZ0pRZzdaVzA3SnFVN0xLMERRb05DaTBnS2lydGpKRHJpNmp0bUpVcUt1eWRnQ0FuZnUyVm9PcTVqT3lhbEQ4bjY2R2NJT3Vzdk95V3RPeWFsQzRnNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzdKeUU3WmVZS095Q3JleWduTUszN1lPSTdZZTBJT3VUc1Nuc25ZQWc2ckt3NnJPODY2VzhJT3Vvdk95Z2dDRHFzcjNxczZEdGxiVHNtcFF1RFFvdElDb3E3SldJNjRLMDdaaVZLaXJzbllBZzdJS3M3SXVrN0oyRUlPeUVuT3lJb08yVnRPeWFsQzROQ2kwZzY2ZUk3TG1vN1pHYzY2VzhJT3lOcU95YWxDNGc3SWlyN0o2UXdyZnNvYkRxc2JRbzdKMjA3SU9Cd3Jmc25iVHRsWmpDdCt5ZHRPdUN0Q0RyazdFcDdKMkFJT3EzdU91TWdPdWhuQ0Rya1pEcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzdKV0s3SldFN0pxVUxnMEtEUW9qSXlNZzY3S0U3WXE4SU9LQWxDRHNsWWpyZ3JRZzY2eTQ2NmVsN0oyMElPeWdsZTJWdE95YWxBMEtEUXA4SU91enVPdXN1T3lkdENEc25iVHJvSWZyaTZRZ2ZDRHJzb1R0aXJ3Z2ZBMEtmQzB0TFh3dExTMThEUXA4SU9xeXNPcXp2TUszN0lPQjdZT2M2Nlc4SU8yR3RldXp0Q0I4SUZ2dG1aWHNuYmhkSUh3TkNud2dKMzd0bGFEcXVZenNtcFEvSit1aG5DRHJyTHpzbll3Z2ZDQmI3SldFNjR1STdKaWtYU0RDdHlCYjY0U2tYU0I4RFFwOElPeURnZTJacVNEc2hKenNpS0FnS3lEc21LVHJwYmpzcXIzc25iUWc3SXVrN0tDY0lPdVBtZXlla1NCOElGdnN0NmpzaG94ZElNSzNJRnQ3NjQrWjdKNlJmVjBnZkEwS0RRb3RJQ2ZzdDZqc2hvd242NHFVSUNvcTY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1LaW9nN0kybzdKcVVJQ2pzbUlnNklGdnN0NmpzaG94ZHdyZGI3SUt0N0tDY1hTa3VJQ2ZyaTZ2cXVMQWd3cmNnNjQrWjdKNlJKK3l5bU91ZnZDRHNwNTNzbmJRZzdKV0lJT3VubnV1S2xDRHNvYkR0bGFuc25iVHJncGdnNjR1bzY0K0ZJQ2ZzdDZqc2hvd242NHFVSU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFvdElPdXloTzJLdk95ZG1DRHJqNW5zbnBFZzdKMjA2NmFFN0oyQUlPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRoQ0RxdDdqcmpJRHJvWndnN0lLMDY2Q2s3SnFVTGcwS0RRb2pJeU1nN1lhMTdLZWNJT3lZaU95TG5BMEtEUW9xS3UyTWtPdUxxTzJZbFNEaWdKUWc3SjIwN1lPSUtpb05DaTBnN1lPQTdKMjA3WXVBT2lEc29JRHNucVVnN0pXSUlPMlZuQ0RyZ3JUc21xa05DaTBnN0pXSTY0SzBPaURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1ak95YWxEOGc3SjZGNjZDbDdaV2NJT3VDdE95YXFleWR0Q0RzZ3F6cm5ienNvTGpzbXBRdURRb3RJT3V5aE8yS3ZEb2c3SldFNjR1STdKaWtJTUszSU91RXBBMEtEUW9xS3UyTWtPdUxxTzJZbFNEaWdKUWc3SUt0N0tDY0lDanNuSVR0bDVncEtpb05DaTBnN1lPQTdKMjA3WXVBT2lEcmpiRHNuYlR0aExBZzdJS3Q3S0NjRFFvdElPeVZpT3VDdERvZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHNnclRycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lLdDdLQ2M3WldnNnJtTTdKcVVQdzBLTFNEcnNvVHRpcnc2SU95VmhPdUxpT3lZcENEQ3R5RHJoS1FOQ2cwS0tpcnJqNW5zbnBIdG1KVWc0b0NVSU95RW5PeUlvQ0FySU91UG1leWVrU0Ryc29UdGlyd3FLZzBLTFNEdGc0RHNuYlR0aTRBNklPcTRzT3E0c0NEc2w3RHFzckFnN1pXMDdLQ2NEUW90SU95VmlPdUN0RG9nN0lTZzdZT2Q3WldjSU9xNHNPcTRzT3lkbUNEc2w3RHFzckRzbllRZzY0R0s3SmEwN0pxVUxnMEtMU0Ryc29UdGlydzZJT3kzcU95R2pDREN0eURzbDdEcXNyQWc3WlcwN0tDY0RRb05DaW9xN0pXSTY0SzA3WmlWSU9LQWxDRHNtWVRybzR3ZzdZYTE2N08wS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURxc3JEc29Kd2c3Sm1FNjZPTURRb3RJT3lWaU91Q3REb2c2ckt3N0tDYzZyQ0FJT3lnbGV5RGdTRHNzcGpycHF6cmtKRHNsclRzbXBRdURRb3RJT3V5aE8yS3ZEb2c3Wm1WN0oyNERRb05DaW9xS2cwS0RRb2pJT3lZaU95WnVDRHF0NXpzdVprTkNnMEs3SnVRN0xtWktPdUtwZXVQbWNLMzZyaU43S0NWd3Jmc3VwRHNvN3pzbHJ3cDY3TzA2NHVrSU95WWlPeVp1T3F3Z0NEcmpaUWc2NnFGN1ptVjdaV2NJT3k3cE91dXBPdUxpT3k4Z095ZHRPeUZtT3lkaENEcnA0enJrNXpyaXBRZzZySzk3SnF3N0ppSTdKcVVMZzBLRFFvakl5RHNtSWpzbWJnZ01TNGc3SWlZNjQrWjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqcmo0UWc2NUNZNjRxVUlPcXl2ZXlhc0EwS0RRb2pJeU1nN0lTYzY3bUU3SXFrSU95aWhldWpqQ3dnNnJpdzZyQ0VJT3Vuak91ampBMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWp2T3lXdENqc29vWHJvNHdnN0lTYzY3bUU3SXFrTENEcXVMRHFzSVFnNjVPeEtldWx2Q0Rxc0pYc29iRHRsYUFnN0lpWUlPeWVpT3F6b0N3Z0oreWloZXVqakNmc21ZQWdKK3Vuak91ampDZnNuWmdnNjRtWTdKV1o3SXFrNjZXOElPeWdsZTJabGUyZWlDRHNvSVRyaTZ6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTQlBUMDhnN0lTYzY3bUU3SXFrSU95aWhldWpqQ0RzbFlqcmdyUWc0b0NVSURBdzdKdVVJREF3N0oyODY3YUE3WVN3SU95RW5PdTVoT3lLcE9xd2dDRHNvb1hybzR6cmo3enNtcFF1SU95ZWtPeUV1TzJWbkNEcmdyVHNtcW5zbllRZzdKV002NkNrNjVPYzY2Q2s3SnFVTGcwS0xTRHNucERzZ3JBZzdLR3c3WnFNSU9xNHNPcXdoT3lkdENEcXM2Y2c2NmVNNjZPTTY0Kzg3SnFVTGcwS0RRcnJpNmdzSUNvcTdLTzg2cml3N0tDQjdKeTg2NkdjSU95aWhldWpqT3F3Z0NEcnNKanJzN1hya0pqcmlwUWc3S0NjN1pLSUtpcnNsNURyaXBRZ0oreWloZXVqak91UHZPeWFsQ2ZycGJ3ZzdKT3c3S2VBSU95Vml1eVZoT3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNtS1RyaXBqc25aZ2c3WUMwN0thSTZyQ0FJT3F6cHlEc29vWHJvNHpyajd6c21wUWc0b2FTSU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQTBLRFFvakl5TWc3SUtzN0pxcDdKNlE3SmVRNnJLTUlPdXZ1T3k1bU91S2xDRHNtSUh0bHFYc25ZUWc3SldNNjZDazdLU0VJT3VWakEwS0RRb283S084N0pxVUlPdVBtZXlDckNBNklPeVhzT3l5dEN3ZzdaVzA3S2VBTENEc29JSHNtcWtnNjVPeEtRMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWR1T3F6dkNEcXRJRHFzNFRycGJ3ZzY2cUY3Wm1WN1pXWTZyS01JT3lFcE91cWhlMlZtT3F6b0N3Z0oreUNyT3lhcWV5ZWtPeWRtQ0R0bG9ucmo1bnNsNUFnNjVTdzY1Mjg3SmlrNjRxVUlPcXlzT3F6dkNmcm5ienJpcFFnN0tDUTdKMkVJT3lWak91Z3BPeWtoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lZcE91S21PcTVqT3luZ0NEcmdyVHNwNEFnN0pXSzdKeTg2Nm0wSU95WHNPeXl0T3VQdk95YWxDNGc3WnVFNjdhSTZyS3c3S0NjSU9xNGlPeVZvZXlkaENEcmdyVHNvN3pzaExqc21wUXVEUW90SU91TWdPeTJuT3lkaENEcXNJanNsWVR0ZzREcnFiUWc3SnVRNjU2WUlPdU1nT3kybk95ZHRDRHRsYlRzcDREcmo3enNtcFF1SU95WXBPdUttQ0RyZ3FEc3A1enF1WXpzcDREc25aZ2c3SjIwN0o2UTY2VzhJT3lkZ08yV2lleVhrQ0RyZ3JUc2xid2c3WlcwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UUlPeVZpT3lMckNBbzdJaVk2NCtaN1ppVktRMEtEUW9uN0tDVjY3TzBJT3lJbU95bmtTRHNsWWpyZ3JRbklPdVRzZXlkbUNEcnI3enFzSkR0bFp3ZzdJT0I3Wm1wN0plUTdJU2NJQ29xN0l1YzdJcWs3WVdjN0oyMElPeWVrT3VQbWV5Y3ZPdWhuQ0Rzc3BqcnBxenRsWnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc3SWlZNjQrWjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeWR0T3lnbk91MmdPMkVzQ0R0bVkzcXVManJqNW5yaTVqc25aZ2c2ckNjN0oyNDdLQ1Y2N08wSU95ZHRPeWFxU0RyZ3JUc2w2M3NuYlFnNnJpdzY2R2Q2NCs4N0pxVURRb3RJT3VObENEc29vdnNuWUFnN0lPQjY0dTA3SjJFSU95Y2hPMlZ0Q0R0aHJYdG1aUWc2NEswN0pxcDdKMkFJT3VGdWV5ZGpPdVB2T3lhbEEwS0RRb2pJeURzbUlqc21iZ2dNaTRnNnJLOTdKYTA2Nlc4SU95TnFPdVBoQ0Rya0pqcmlwUWc2cks5N0pxd0RRb05DdTJLdWV5Z2xTRHNnNEh0bWFuc2w1RHNoSndnN0tDYzdaV2M3S0NCN0p5ODY2R2NJQ2ZzaTV6cmdwanNtcFEvTENEc2hhanJncGpzbXBRL0p5RHNuWmpyckxqdG1KVWc3SmEwNjYrNDY2VzhJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlE3SjJZSU91bnBldWR2ZXlkaENEdG1aenNtcW50bGJUc2hKd2c3S2VJNjZ5NDdaV2dJT3VWakEwS0RRb243SXVjNjRLWTdKcVVQeWNzSUNmc2hhanJncGpzbXBRL0p5RHRtSlh0ZzV6c25aZ2c2cks5N0phMDY2VzhJTzJabk95YXFlMlZ0T3lFbkNEc2dxenNtcW5zbnBEc25aZ2c2NHU1N1ptcDdJcWs2NStzN0p1QTdKMkVJT3lraE95ZHZDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPMlpqZXE0dU91UG1ldUxtQ3dnVDA5UElPdUxwT3VGZ095WXBPeUZxT3VDbU95YWxEOE5DaTBnN0xhcDdLQ0U3WldZNjUrc0lPMk91T3lkbU95Z2tDRHFzSURzaTV6cmdwanNtcFEvRFFvTkNpTWpJeURzZ3F6c21xbnNucERzblpnZzdJT0I3Wm1wN0oyRUlPeTJsT3lnbGUyVm9DRHJsWXdOQ2cwSzY2cUY3Wm1WN1pXY0lPeWdsZXV6dE9xd2dDRHNsNGJzbHJUc2hKd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeW5nZXlna1NEdGpKRHJpNmp0bFpqcXNvd2c3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzdWJUcms1enJwYndnNjdDYjdKeTg3SVdvNjRLWTdKcVVQeURyazdIcm9aM3RsWmpycWJRZzdMcVE3SXVjNjdDeElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwS0l5TWpJT3lDck95YXFleWVrT3lkbUNEc2hLRHNuWmpxc0lBZzdaV0U3SnFVN1pXZ0lPdVZqQTBLRFFyc2hLVHJyTGpzb2JEc2dxenNzcGpybjd3ZzdJS3M3SnFwN0o2UTdKMllJT3lFb095ZG1PdWx2Q0RxdUxEcmpJRHRsYlRzbGJ3ZzdaV2dJT3VWakNEcXNyM3NsclRyb1p3ZzdLQ1Y3S1NSN1pXWTZyS01JT3luaU91c3VPMlZ0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNuYlRyc29nZzY0dXM3SmVRSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxaanJxYlRzaEp3ZzdKYTg2NmVJNjRLWUlPdW5qT3loc2UyVm1PeUZxT3VDbU95YWxEOE5DZzBLSXlNZzdKaUk3Sm00SURNdUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPdVFtT3VLbENEcXNyM3NtckFOQ2cwSzdJS3M3SnFwN0o2UTdKZVE2cktNSU91cWhlMlpsZTJWbU9xeWpDRHJ0b0Rzb0pYc29JSHNuYmdnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3lrbU95VnZDRHRsYUFnNjVXTTY0cVVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3lpaSt5VmhPeWFsQzROQ2cwS0l5TWpJT3lFbk91NWhPeUtwT3VsdkNEc29KWHNzWVhzZzRFZzdKTzRJT3lJbUNEc2w0YnNuWVFnNjVXTURRb05DdXUyZ095Z2xlMllsZXljdk91aG5DRHNqYWpzbGJ3ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU95RGdlMlpxZXlkaENEcnFvWHRtWlh0bFpqcXNvd2c3SjI0N0tlQTdJdWM3WUtzSU95SW1DRHNub2pzbHJUc21wUXVJQ29xN0pPNElPeUltQ0RzbDRicmlwUWc3SjIwN0p5ZzY2VzhJTzJWcU9xN21DRHNsWWpyZ3JUdGxiVHNvN3pzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEc3A0RHF1SWpzbllBZzZyQ0E3SjZGN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SU95eXJleUdqT3VGaE95ZGhDRHNuSVR0bFp3ZzdJU2M2N21FN0lxazY0cVVJT3lWaE95bmdTRHNwSURydVlRZzdLU1I3SjIwN0plUTdKcVVMZzBLTFNEcXM3WHJyTFRzbTVEc25ZQWc3WnVFN0p1UTZyaUk3SjJFSU91enRPdUN2Q0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtEUW9qSXlNZzdKMjg2N2FBSU9xNHNPdUtwZXVuakNEc2s3Z2c3SWlZSU95WGh1eWRoQ0RybFl3TkNnMEs2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeU5xT3lWdkNEc2dxenNtcW5zbnBEcXNJQWc3SmEwNjVha0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeVhodXVLbE95bmdDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3WldnSU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlFJT3lFb08yRG5leWRtQ0Rxc3JEcXM3enJwYndnN0pXSTY0SzA3WldnSU91VmpBMEtEUXJya0pqcmo0enJwclFnN0lpWUlPeVhodXVLbENEc2hLRHRnNTNzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJWbU9xeWpDRHNsWXpyb0tUc21wUXVEUW9OQ3V5WWlDa05DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPdTJnT3lnbGUyWWxTa05DZzBLSit5Z2xldXp0Q0RzaUpqc3A1RWc3SldJNjRLMEp5RHJrN0hzblpnZzY2Kzg2ckNRN1pXY0lPeURnZTJacWV5WGtPeUVuQ0FxS3V5Z2xldXp0T3F3Z0NEcnM3VHRtTGpya0p6cmk2VHJpcFFnN0tDUUtpcnNuWVFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lEZ2V1THRPeWR0Q0RyZ1ozcmdwanJxYlFnN0tDRTY2eTQ2ckNBNjQrRUlPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1RycGJ3ZzY3TzhJT3lJbUNEc2w0YnNsclRzbXBRdURRb3RJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHNvSlhyczdUcXNJQWc2cml3NjZHZDY1Q1k3S2VBSU95Vml1eVZoT3lhbEM0TkNnMEtJeU1nN0ppSTdKbTRJRFF1SU95Z25PMlNpQ0RzbXFuc2xyVHJpcFFnNjdDVTZyNjQ3S2VBSU95Vml1cTRzQTBLRFFvbjZyQ0U2ckt3N1pXWTZyT2dJT3lKck95YXRDRHJwNUFuSU95YmtPeTVtZXV6dE91THBDQXFLdTJabE91cHRPeWRtQ0RxdUxEcmlxWHJxb1hDdCt1eWhPMkt2T3VxaGVxenZPeWRtQ0RzbXFuc2xyUWc3SjI4N0xtWUtpcnFzSUFnN0pxdzdJU2c3SjIwN0plUTdKcVVMZzBLNnJpdzY0cWw2NnFGN0plUUlPeVRzT3lkdUNEcmk2anNsclFvNjdPQTZySzlMQ0RzcDREc29KVXNJT3VUc2V1aG5TRHJrN0VwNjZXOElPeVZpT3VDdENEcnJManF0YXpzbDVEc2hKd2c2NHVrNjZXNElPdW5rT3VobkNEcnNKVHF2cmpycWJRZzdJS3M3SnFwN0o2UTZyQ0FJT3VMcE91bHVDRHF1TERyaXFYc25MenJvWndnN0ppazdaVzA3WldnSU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa2dKK3Eyak8yVm5DRHJzNERxc3IwbklPcTRzT3VLcGV5ZG1DRHNsWWpyZ3JRZzY2eTQ2cldzRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3Q1U2citBSU95SW1DRHNub2pzbHJUc21wUWdLRmdwRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3T0E2cks5N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSU95WWlPeVp1Q0ExTGlEc2k1enNpcVR0aFp3ZzY0K1o3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXdnN0pPdzdLZUFJT3lWaXVxNHNBMEtEUXJyckxqcXRhenJwYndnN0pXRTY2eTA2NmFzSU91bnBPdUJoT3VmdmVxeWpDRHJpNlRyazZ6c2xyVHJqNFFnS2lyc2k2VHNvSndnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NLaXJycGJ3ZzdKT3c2Nm0wSU95ZW1PdXF1K3VRbkNEcnJManF0YXpzbUlqc21wUXVEUW9OQ3V5WWlDa2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VsdkNBbjdMYVU2ckNBSU95bmdPeWdsU2Z0bFpqcmlwUWc3SXVjN0lxazdZV2M3SmVRN0lTY0lDanNuYlRzb0lUQ3QreVdrZXVQaENEcXVMRHJpcVhzbmJRZzdKV0U2NHVZS1EwS0xTRHJpNlRycGJnZzdJS3M2NTZNN0plUTZyS01JT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERycGJ3ZzY0U1k2cktvN0tPODdJUzQ3SnFVSUNoWUlPS0FsQ0RzbDRicmlwUWdKK3VFbU9xNHNPcTRzQ2NnNnJpdzY0cWw3SjJFSU95VmxPeUxuQ2tOQ2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZ0Q0Rzbzd6c2hManNtcFFnS0U4cERRbz0nCkRJUj0iJEhPTUUvTGlicmFyeS9BcHBsaWNhdGlvbiBTdXBwb3J0L0NsYXVkZUJyaWRnZSIKcHV0KCkgeyBwcmludGYgJXMgIiQxIiB8IGJhc2U2NCAtRCA+ICIkMiI7IH0KIyDsnbQgLmNvbW1hbmTqsIAg64+E64qUIO2EsOuvuOuEkCDssL3rp4wg6rOo6528IOuLq+uKlOuLpCh0dHkg66ek7LmtKS4gYmFzaOqwgCDrgZ3rgpgg7YOt7J20IGlkbGXrkJwgMey0iCDrkqTsl5Ag64ur7JWECiMgIu2UhOuhnOyEuOyKpCDsi6Ttlokg7KSRIiDqsr3qs6Drpbwg7ZS87ZWc64ukIOKAlCBkaXNvd27snLzroZwg7Iqk7YGs66a97Yq46rCAIGV4aXTtlbTrj4Qg64ur6riwIOyekeyXheydgCDsgrTslYTrgqjripTri6QuICjrp6Ug7Iuk6riwIOqygOymnSDtlYTsmpQpCk1ZVFRZPSIkKHBzIC1vIHR0eT0gLXAgJCQgMj4vZGV2L251bGwgfCB0ciAtZCAiICIpIgpjbG9zZV90ZXJtaW5hbCgpIHsKICBbIC16ICIkTVlUVFkiIF0gJiYgcmV0dXJuCiAgKCBzbGVlcCAxCiAgICAvdXNyL2Jpbi9vc2FzY3JpcHQgPi9kZXYvbnVsbCAyPiYxIDw8T1NBCnRlbGwgYXBwbGljYXRpb24gIlRlcm1pbmFsIgogIHJlcGVhdCB3aXRoIHcgaW4gd2luZG93cwogICAgdHJ5CiAgICAgIHJlcGVhdCB3aXRoIHQgaW4gdGFicyBvZiB3CiAgICAgICAgaWYgdHR5IG9mIHQgaXMgIi9kZXYvJE1ZVFRZIiB0aGVuIGNsb3NlIHcgc2F2aW5nIG5vCiAgICAgIGVuZCByZXBlYXQKICAgIGVuZCB0cnkKICBlbmQgcmVwZWF0CmVuZCB0ZWxsCk9TQQogICkgJiBkaXNvd24gMj4vZGV2L251bGwgfHwgdHJ1ZQp9CiMg7JWI64K064qUIO2UjOufrOq3uOyduOydtCDrs7Tsl6zspIDri6Qg4oCUIO2EsOuvuOuEkOydgCDshKTsuZjCt+ygkOqygOunjCDtlZjqs6Ag7Iqk7Iqk66GcIOuLq+2ejOuLpC4KZmluaXNoKCkgeyBjbG9zZV90ZXJtaW5hbDsgZXhpdCAiJDEiOyB9CmVjaG8gIu2BtOuhnOuTnCDsu6TrhKXthLDrpbwg7ISk7LmY7ZWY6rOgIOyeiOyWtOyalOKApiDsnqDsi5wg7ZuEIOydtCDssL3snYAg7J6Q64+Z7Jy866GcIOuLq+2YgOyalC4iCm1rZGlyIC1wICIkRElSL3NjcmlwdHMiIHx8IHsgZWNobyAi7Y+0642UIOyDneyEsSDsi6TtjKg6ICRESVIiOyBmaW5pc2ggMTsgfQpwdXQgIiRCNjRfQlJJREdFIiAgICIkRElSL3NjcmlwdHMvY2xhdWRlLWJyaWRnZS5qcyIKcHV0ICIkQjY0X1dBVENIRVIiICAiJERJUi9zY3JpcHRzL2JyaWRnZS13YXRjaGVyLmpzIgpwdXQgIiRCNjRfRVhBTVBMRVMiICIkRElSL3JlY29tbWVuZC1leGFtcGxlcy5tZCIKcHV0ICIkQjY0X0dVSURFIiAgICAiJERJUi91eC13cml0aW5nLm1kIgplY2hvICLinIUg7YyM7J28IOyEpOy5mDogJERJUiIKIyBHVUnsl5DshJwg7JewIFRlcm1pbmFs7J2AIFBBVEjqsIAg7KKB7J2EIOyImCDsnojslrQg7Z2U7ZWcIOyEpOy5mCDqsr3roZzrpbwg67O07YOg64ukCmV4cG9ydCBQQVRIPSIkSE9NRS8ubG9jYWwvYmluOi9vcHQvaG9tZWJyZXcvYmluOi91c3IvbG9jYWwvYmluOiRQQVRIIgojIG5vZGXqsIAg7JeG7Jy866m0IOqwkOyLnOyekCg9bm9kZSkg7J6Q7LK06rCAIOuquyDrj4zslYQg7ZSM65+s6re47J247JeQIOyVjOumtCDrsKnrspXsnbQg7JeG64ukIOKGkiDsnbQg6rK97Jqw66eMIOuEpOydtO2LsOu4jCDtjJ3sl4XsnLzroZwg7JWI64K07ZWc64ukCmlmICEgY29tbWFuZCAtdiBub2RlID4vZGV2L251bGwgMj4mMTsgdGhlbgogIG9zYXNjcmlwdCAtZSAnZGlzcGxheSBkaWFsb2cgIuydtCBNYWPsl5AgTm9kZS5qc+qwgCDsl4bslrTsmpQuIFvtmZXsnbhd7J2EIOuIhOultOuptCDri6TsmrTroZzrk5wg7Y6Y7J207KeA6rCAIOyXtOugpOyalC4gTm9kZS5qcyhMVFMp66W8IOyEpOy5mO2VnCDrkqQg7J20IOyEpOy5mCDtjIzsnbzsnYQg64uk7IucIOyLpO2Wie2VtCDso7zshLjsmpQuIiB3aXRoIHRpdGxlICLtgbTroZzrk5wg7Luk64Sl7YSwIOKAlCBOb2RlLmpzIO2VhOyalCIgYnV0dG9ucyB7Iu2ZleyduCJ9IGRlZmF1bHQgYnV0dG9uIDEgd2l0aCBpY29uIGNhdXRpb24gZ2l2aW5nIHVwIGFmdGVyIDE4MCcgPi9kZXYvbnVsbCAyPiYxCiAgb3BlbiAiaHR0cHM6Ly9ub2RlanMub3JnL2tvL2Rvd25sb2FkIiAyPi9kZXYvbnVsbAogIGZpbmlzaCAwCmZpCk5PREVfQklOPSIkKGNvbW1hbmQgLXYgbm9kZSkiCmVjaG8gIuKchSBOb2RlLmpzOiAkKG5vZGUgLS12ZXJzaW9uKSIKIyDqsJDsi5zsnpAgbGF1bmNoZCDrk7HroZ0gKOuhnOq3uOyduCDsnpDrj5nsi5zsnpEgKyDsp4DquIgg6riw64+ZKS4gUEFUSOulvCBwbGlzdOyXkCDqtbPtmIAg64Sj64qU64ukIOKAlCBsYXVuY2hkIOq4sOuzuCBQQVRI7JeUIGNsYXVkZeqwgCDsl4bri6QuClBMSVNUPSIkSE9NRS9MaWJyYXJ5L0xhdW5jaEFnZW50cy9jb20uY2xhdWRlYnJpZGdlLndhdGNoZXIucGxpc3QiCm1rZGlyIC1wICIkSE9NRS9MaWJyYXJ5L0xhdW5jaEFnZW50cyIKU0FGRV9QQVRIPSIke1BBVEgvLyYvJmFtcDt9IgpjYXQgPiAiJFBMSVNUIiA8PFBMSVNURU9GCjw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjwhRE9DVFlQRSBwbGlzdCBQVUJMSUMgIi0vL0FwcGxlLy9EVEQgUExJU1QgMS4wLy9FTiIgImh0dHA6Ly93d3cuYXBwbGUuY29tL0RURHMvUHJvcGVydHlMaXN0LTEuMC5kdGQiPgo8cGxpc3QgdmVyc2lvbj0iMS4wIj4KPGRpY3Q+CiAgPGtleT5MYWJlbDwva2V5PjxzdHJpbmc+Y29tLmNsYXVkZWJyaWRnZS53YXRjaGVyPC9zdHJpbmc+CiAgPGtleT5Qcm9ncmFtQXJndW1lbnRzPC9rZXk+CiAgPGFycmF5PgogICAgPHN0cmluZz4kTk9ERV9CSU48L3N0cmluZz4KICAgIDxzdHJpbmc+JERJUi9zY3JpcHRzL2JyaWRnZS13YXRjaGVyLmpzPC9zdHJpbmc+CiAgPC9hcnJheT4KICA8a2V5PkVudmlyb25tZW50VmFyaWFibGVzPC9rZXk+CiAgPGRpY3Q+PGtleT5QQVRIPC9rZXk+PHN0cmluZz4kU0FGRV9QQVRIPC9zdHJpbmc+PC9kaWN0PgogIDxrZXk+UnVuQXRMb2FkPC9rZXk+PHRydWUvPgogIDxrZXk+S2VlcEFsaXZlPC9rZXk+PGRpY3Q+PGtleT5TdWNjZXNzZnVsRXhpdDwva2V5PjxmYWxzZS8+PC9kaWN0Pgo8L2RpY3Q+CjwvcGxpc3Q+ClBMSVNURU9GCmxhdW5jaGN0bCBib290b3V0ICJndWkvJChpZCAtdSkvY29tLmNsYXVkZWJyaWRnZS53YXRjaGVyIiAyPi9kZXYvbnVsbApsYXVuY2hjdGwgYm9vdHN0cmFwICJndWkvJChpZCAtdSkiICIkUExJU1QiIDI+L2Rldi9udWxsIHx8IGxhdW5jaGN0bCBsb2FkIC13ICIkUExJU1QiIDI+L2Rldi9udWxsCiMgY2xhdWRlIOycoOustMK366Gc6re47J24IOyXrOu2gOuKlCDsl6zquLDshJwg7JWM66as7KeAIOyViuuKlOuLpCDigJQg6rCQ7Iuc7J6Q6rCAIOq3uCDsg4Htg5zrpbwg7ZSM65+s6re47J247JeQIOyghOuLrO2VtAojIOqzhOyglSDtmZTrqbTsnbQgIuyEpOy5mCDtlYTsmpQgLyDroZzqt7jsnbgg7ZWE7JqUIC8g7KSA67mEIOyZhOujjCLroZwg64W47Lac7ZWc64ukKO2EsOuvuOuEkOydtCDssYTrhJDsnbQg7JWE64uYKS4KIyDshKTsuZjCt+ygkOqygCDrgZ0g4oaSIOywveydhCDsiqTsiqTroZwg64ur64qU64ukLgpmaW5pc2ggMApQSwECHgMUAAAIAAAAAAAAtewS2AteAgALXgIAGwAAAAAAAAAAAAAA7YEAAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kUEsFBgAAAAABAAEASQAAAEReAgAAAA==";
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
