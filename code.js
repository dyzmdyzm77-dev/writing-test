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
const BRIDGE_MIN_V = 26;
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
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21saw0KWjJVcENpOHZJT3k4bk91UmtPdXB0Q0R0bEl6cm42enF0N2pzbmJqc25aZ2dXK3kybE95eW5PdXdtK3E0c0YzcXNJQWdSMlZ0YVc1cElPMkNwQ0RzbDRic25iVHJqNFFnN1lHMDY2R2M2NU9jNjZHY0lFRkpJT3kybE95eW5PeWRoQ0Ryc0p2cmlwVHJpNlF1Q2k4dkNpOHZJT3lHamV1UGhDRHNoS1RxczRRNklPMkJ0T3Vobk91VG5PdWx2Q0RzbXBUc3NxM3JwNGpyaTZRZzdJT0k2NkdjSU95TG5PdVBtZTJWbU91cHRDQXpNSDQwTU95MGlPcXdnQ0RxdDdqcmc2VWc2NEtnN0pXRTZyQ0U2NHVrTGdvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0NpOHZJQ0FnNnJDQTdKMjA2NU9jSyt5WWlPeUxuQ2d4TVRIcXNiUXA2NHFVSU95eXF5RHJxWlRzaTV6c3A0RHJvWndnN1pXY0lPdXlpT3VuakNEc25iM3QNCm5venJpNlF1SU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjZ5NDZyV3M2NmVNSU91enRPdUN0T3V2Z091aG5DRHJ1YURycGJUcmk2UXVDaTh2SU95RXVPeUZtT3lkZ0NBek1PdXlpQ0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3WlcwSU91TWdPMlpsT3F3Z0NEcnJMVHRsWnp0bm9nZzZyaTQ3SmEwN0tlQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaTh2Q2k4dklPeWdoT3lnbkRvZzdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0NjQrOElPeWVpT3lkaENEcXNvTWdLR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3Snk4NjZHY0lPMlpsZXlkdUNrS0x5OGc3S084N0oyWU9pRHNncXpzbXFucm40bnNuWUFnNnJDQjdKNlFJTzJCdE91aG5PdVRuQ0RxdGF6cmo0VWc3WldjNjQrRTdKZVE3SVNjSU95d3FPcXdrT3VRbk91THBDNEtDbU52Ym5OMElHaDBkSEFnUFNCeVpYRjFhWEpsS0Nkb2RIUndKeWs3Q21OdmJuTjBJR1p6SUQwZ2NtVnhkV2x5WlNnblpuTW5LVHNLDQpZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdA0KWTNka0p5azdDblJ5ZVNCN0lHWnpMbTFyWkdseVUzbHVZeWhGVFZCVVdWOURWMFFzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsSUgwcE95QjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUXBqYjI1emRDQkRURUZWUkVWZlJVNVdJRDBnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnY0hKdlkyVnpjeTVsYm5Zc0lIc0tJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcENpQWdRMHhCVlVSRlgwTlBSRVZmUkVsVFFVSk1SVjlPVDA1RlUxTkZUbFJKUVV4ZlZGSkJSa1pKUXpvZ0p6RW5MQ0F2THlEdGhMUWc3SnFVN0pXOUlPdVRzU0RydG9EcXNJQWc3Wmk0N0xhY0lPdUJsQW9nSUVSSlUwRkNURVZmVkVWTVJVMUZWRkpaT2lBbk1TY3NDbjBwT3dvS0x5OGc3SWlvNnJtQUlPeUxwTzJXaVNqcXNKRHNpNXpzbnBBZzdJcWsNCjdZK3c3SjJBSUhOMFpHbHZJR2xuYm05eVpTbnNsNURzaEp6cmo0UWc2Nnk0N0tDYzY2VzhJT3kybE95Z2dlMlZvQ0RzaUpnZzdKNkk2cktNSU95OW1PeUdsQ0Ryb1p6cXQ3anJwYndnN1l5TTdKMjg3SmVRNjQrRUlPdUNxT3E0dE91THBDNEtMeThnN0p5RTdMbVlPaURzbm9Uc2k1d2c3WSswNjQyVTdKMllJR05zWVhWa1pTMWljbWxrWjJVdWJHOW5JQ2pzbklqcmo0VHNtckFnSlZSRlRWQWxMQ0RycDZVZ0pGUk5VRVJKVWlrdUlESk5RaURyaEpqc25MenJxYlFnTG05c1pPdWhuQ0R0bFp3ZzdJUzQ2NHlBNjZlTUlPdXp0T3EwZ0M0S1kyOXVjM1FnVEU5SFgwWkpURVVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExteHZaeWNwT3dwamIyNXpkQ0JmYjNKcFoweHZaeUE5SUdOdmJuTnZiR1V1Ykc5bkxtSnBibVFvWTI5dWMyOXNaU2s3Q21OdmJuTnZiR1V1Ykc5bklEMGdablZ1WTNScGIyNGdLQ2tnZXdvZ0lHTnZibk4wSUdGeVozTWdQU0JCY25KaGVTNXdjbTkwDQpiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bg0KYVdaNUtHRXBLU2t1YW05cGJpZ25JQ2NwSUNzZ0oxeHVKenNLSUNBZ0lHWnpMbUZ3Y0dWdVpFWnBiR1ZUZVc1aktFeFBSMTlHU1V4RkxDQnNhVzVsS1RzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHRqSXpzbmJ3ZzY2R2M2cmU0SU95THBPMk1xTzJWdE91UGhDRHJpNlRycHF6cmlwUWc2ck9FN0lhTklDb3ZJSDBLZlRzS0NtTnZibk4wSUZCUFVsUWdQU0JPZFcxaVpYSW9jSEp2WTJWemN5NWxibll1UWxKSlJFZEZYMUJQVWxRcElIeDhJREV4T0RnNE95QXZMeUJDVWtsRVIwVmZVRTlTVk91S2xDRHRoWXpzaXFUdGlyanNtcWtnS08yUGlleUdqT3lYbENBeE1UZzRPQ0RxczZEc29KVXBDaTh2SU91THBPdW1yQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0F2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDNGc3TDJVNjVPYzY2VzhJSEIxYkd6Q3QrdXp0ZXlDck8yVnRPdVBoQ0FxS3V5ZHRPdXZ1Q0RybHFBZzdKNkk2NHFVSU91THBPdW1yT3VLbENEc21Kc2c3TDJVNjVPY0lPcTN1T3VNZ091aG5Db3ENCjY1MjhDaTh2SU9xN2tPdUxwQ0Rzdkp6cXVMQWc3S0NFN0plVUlPeURpQ0RyajVuc25wSHNuYlFnN0pXSUlPdUNtT3lZcU91THBDanRoTERycjdqcmhKRHNuYlFnNjV5bzY0cVVJT3VUc1NrdUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEc25iUWc2ckNTN0p5ODY2R2NJT3Exck91eWhPeWdoT3lkaENEcXNKRHNwNER0bGJRZzdKNnM3SXVjN0o2UjdJdWM3WUtvNjR1a0xnb3ZMeURyajVuc25wSHNuYlFnNjdDVTY0Q002NHFVSU95SW1PeWdsZXlkaENEdGxaanJxYlFnN0oyMElPeUlxK3lla091bHZDRHNtS3pycHF6cXM2QWdZMjlrWlM1MGMreWRtQ0JDVWtsRVIwVmZUVWxPWDFicmo0UWc2ckNaN0oyMElPeVlyT3Vtc091THBDNEtZMjl1YzNRZ1FsSkpSRWRGWDFZZ1BTQXlOanNLTHk4ZzZyaXc2N080SU91cXFPdU51QzRnN0pxVTdMS3RLTzJVak91ZnJPcTN1T3lkdUNuc25iUWdiVzlrWld6c25ZUWc3S2VBN0tDVjdaV1k2Nm0wSU9xM3VDRHNtcFRzc3EzcnA0d2c2cmU0SU91cXFPdU51T3VobkNEc3NwanJwcXp0DQpsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPYw0KSUNoeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUWc0b0NVSUdKMWFXeGtMV2RzYjNOellYSjVMbXB6N0ptQUlPcXdtZXlkZ0NEdGpJenNoSndwSU9LVWdPS1VnQXBtZFc1amRHbHZiaUJzYjJGa1JYaGhiWEJzWlhNb0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzFrSUQwZ1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNzSUNkeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUW5LU3dnSjNWMFpqZ25LVHNLSUNBZ0lHTnZibk4wSUhObFkwbGtlQ0E5SUcxa0xuTmxZWEpqYUNndlhpTWpJT3kybE95eW5DRHNtSWpzaTV4Y2N5b2tMMjBwT3dvZ0lDQWdhV1lnS0hObFkwbGtlQ0E5UFQwZ0xURXBJSEpsZEhWeWJpQmJYVHNLSUNBZ0lHTnZibk4wSUdWNFlXMXdiR1Z6SUQwZ1cxMDdDaUFnSUNCc1pYUWdZM1Z5SUQwZ2JuVnNiRHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjbUYzSUc5bUlHMWtMbk5zYVdObEtITmxZMGxrZUNrdWMzQnNhWFFvSjF4dUp5a3ANCklIc0tJQ0FnSUNBZ1kyOXVjM1FnYkdsdVpTQTlJSEpoZHk1eVpYQnNZV05sS0M5Y2N5c2tMeXdnSnljcE93b2dJQ0FnSUNCamIyNXpkQ0JvSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYaU1qSTF4ekt5Z3VLejhwWEhNcUpDOHBPd29nSUNBZ0lDQnBaaUFvYUNrZ2V5QmpkWElnUFNCN0lHbHVjSFYwT2lCb1d6RmRMQ0J6ZFdkblpYTjBhVzl1Y3pvZ1cxMGdmVHNnWlhoaGJYQnNaWE11Y0hWemFDaGpkWElwT3lCamIyNTBhVzUxWlRzZ2ZRb2dJQ0FnSUNCamIyNXpkQ0JpSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYbHh6S2kxY2N5c29MaXMvS1Z4ektpUXZLVHNLSUNBZ0lDQWdhV1lnS0dJZ0ppWWdZM1Z5S1NCamRYSXVjM1ZuWjJWemRHbHZibk11Y0hWemFDaGlXekZkTG5Od2JHbDBLQ2NnTHlBbktTNXFiMmx1S0NjZ0p5a3BPd29nSUNBZ2ZRb2dJQ0FnY21WMGRYSnVJR1Y0WVcxd2JHVnpMbVpwYkhSbGNpZ29aU2tnUFQ0Z1pTNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dQaUF3S1RzS0lDQjlJR05oZEdOb0lDaGxLU0I3DQpDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpdw0KSU9xem9PeTVxQ0FySU95V3RPeUluQ0RyczREcXNyMGk3SjIwSU91UW5PdUxwQzRnN0pldDdaV2dJT3UyaE91bXJDRGlnSlFLTHk4ZzdZRzA2NkdjNjVPY0lEMGc2Nnk0N0o2bElPdUxwT3VUck9xNHNDanNzTDNzblpncExDRHNtcW5zbHJRZzdZYTE3SjI4d3JmcnA1N3N0cVRyc3BVZ1BTQmpiMlJsTG5SeklISmxabWx1WlVGcFUzVm5aMlZ6ZEdsdmJuTWc3WnVFN0xLWTY2YXNLT3E0c09xemhPeWdnU2t1Q21OdmJuTjBJRk5VV1V4RlgxSlZURVZUSUQwZ1d3b2dJQ2N4TGlEdGxiVHNtcFRzc3JRNklPdXFxT3VUb0NEcnJManF0YXpyaXBRZzdaVzA3SnFVN0xLMDY2R2NMaUFvNjdPMDY0T0Y2NHVJNjR1azRvYVM2N08wNjRLMDdKcVVLU2NzQ2lBZ0p6SXVJT3VLcGV1UG1leWdnU0RycDVEdGxaanF1TEE2SU91UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDd2dmdXlYaUNEcnVienF1TEFvNjdDVTY0Q003SmVJN0phMDdKcVU0b2FTNjdDVTZyK283SmEwN0pxVUtTNGc2NHVvTENEc29vWHJvNHpDdCt1bmpPdWoNCmpNSzM3SmV3N0xLMHdyZnRsYlRzcDREQ3QrcTRzT3VobmNLMzY0VzU3SjJNSU91VHNTRHNpNXpzaXFUdGhaenNuYlFnN0tPODdMSzA3SjI0SU9xeXNPcXp2T3VLbENEc2lKanJqNW50bUpVZzdKeWc3S2VBS095WHNPeXl0T3VQdk95YWxDd2c2NFc1N0oyTTY0Kzg3SnFVS1M0bkxBb2dJQ2N6TGlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd09pQWlmdTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVJaURyaklEc2k2QWdJbjd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWlJT3Exck95aHNDRHNtckRzaEtBdUlPdUxxQ3dnN0tDVjdMR0Y3SU9CSU91MmlPcXdnTUszN0oyODY3YUFJT3E0c091S3BTRHNvSnp0bFp6Q3QrdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3F5c09xenZNSzM3S0NWNjdPMElPdXp0TzJZdUNEc2xZanNpNnpzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJlaUM0bkxBb2dJQ2MwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phME9pQis3WldZN0l1YzZyS2c3SmEwDQo3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cA0KTGljc0NpQWdKell1SU8yUm5PcTRzRG9nNjVDWTdKYTA3SnFVNG9hUzY0Kzg3SnFVTGljc0NpQWdKemN1SU95a2hDRHF0YXpzb2JBNklPeWJrT3V6dU95ZHRDRHRsWndnN0tTRTdKMjA2Nm0wSU95MmxPeXluT3VQaENEcnNKanJrNXpzaTV3ZzdaV2NJT3lraE91aG5DNGc3SjZFN0oyWTY2R2NJT3lraE95ZGhDRHJpcGpycHF6c3A0QWc3SldLNjRxVTY0dWtMaURyaTZnc0lPeVhyT3VmckNEcnJManNucVhzbllRZzdaV1k2NEtZN0oyWUlPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25MenJvWndnN1pXcDdMT1FJT3VObENEcXNJVHFzckR0bGJUc3A0VHJpNlRycWJRZzdLU0VJT3lJbU91bHZDRHNwSVRzbmJUcmlwUWc2cktEN0oyQUlPMlptT3lZZ1M0bkxBb2dJQ2M0TGlEdGpKM3NsNFVvNjR1azdKMjA3SmE4NjZHYzZyZTRLU0Ryc29UdGlydzZJT3F5c09xenZDRHRoclhyczdUcmlwUWdXKzJabGV5ZHVGMHNJT3lZaUMvc2xZVHJpNGpzbUtRZzdZeVE2NHVvN0oyQUlGdnNsWVRyaTRqc21LUmRMMXZyaEtSZExDRHINCmo1bnNucEVnN0p5ZzY0K0U2NHFVSUZ2c3Q2anNob3hkTDF0NzY0K1o3SjZSZlYwdUlDTHN0NmpzaG93aTY0cVVJT3VQbWV5ZWtTRHJzb1R0aXJ6cXM3d2c3S2VkN0oyOElPdVZqT3VuakNEc2s3RHFzNkFnSXV1THErcTRzTUszNjQrWjdKNlJJdXl5bU91ZnZDRHNwNTBnN0pXSUlPdW5udXVLbENEc29iRHRsYW5DdCt1THFPdVBoU0FpN0xlbzdJYU1JdXVLbENEcXVJanNwNEF1Snl3S0lDQW5PUzRnN0oyMDY2YUV3cmZzb0lUdG1aVHJzb2p0bUxqQ3QrdW5pT3lLcE8yQ3VleWRnQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzBMaURzZ3F6cm5venNuWVFnNjdhQTY2VzhJT3VWa0NEcmk1anNuWVFnNjdhWjdKZXM2NCtFSU95aWkrdUxwQzRuTEFvZ0lDY3hNQzRnN0tDYzdaS0lJT3lhcWV5V3RDRHNuS0RzcDRBNklPeWVoZXVncGV5WGtDRHNrN0RzbmJnZzZyaXc2NHFsN0lTeElPdXFoZXlDckNqcnM0RHFzcjBzSU95bmdPeWdsU3dnNjVPeDY2R2RMQ0R0bGJUc29Kd2c2NU94S2V1S2xDRHRtWlRycWJUc25aZ2c2cml3DQo2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqcw0KaUpqcmo1bnRtSlhDdCtxeXZleVd0TUszNjdhQTdLQ1Y3WmlWSU8yWGlPeWFxU0RzdklEc25iVHNpcVFwN0oyWUlPdUptT3lWbWV5S3BPcXdnQ0RzbktEc2k2VHJrSnpyaTZRdUNpOHZJTzJNak95ZHZPeWR0Q0RzbDRic25MenJxYlFvN0lTazdMbVk2N080SU9xMXJPdXloT3lnaENEcms3RXBJT3U1aUNEcnJManNucERzbDdRZzRvQ1VJT3lhbE95VnZldW5qT3ljdk91aG5DRHJqNW5zbnBFb1ptRnBiQzF6YjJaMEtTNEtablZ1WTNScGIyNGdiRzloWkVkMWFXUmxLQ2tnZXdvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdFpDQTlJR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bkxDQW5kWGd0ZDNKcGRHbHVaeTV0WkNjcExDQW5kWFJtT0NjcExuUnlhVzBvS1RzS0lDQWdJSEpsZEhWeWJpQnRaQzVzWlc1bmRHZ2dQaUF4TURBZ1B5QnRaQ0E2SUNjbk93b2dJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2lxVHQNCmc0RHNuYndnNnJDQTdKMjA2NU9jSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lhbE95VnZldW5qT3ljdk91aG5DRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z0p5YzdDaUFnZlFwOUNtTnZibk4wSUVkVlNVUkZJRDBnYkc5aFpFZDFhV1JsS0NrN0NncG1kVzVqZEdsdmJpQnBibk4wY25WamRHbHZiazFsYzNOaFoyVW9LU0I3Q2lBZ1kyOXVjM1FnWm1WM1UyaHZkQ0E5SUVWWVFVMVFURVZUTG0xaGNDZ29aWGdwSUQwK0lDZEpibkIxZERvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtHVjRMbWx1Y0hWMEtTQXJJQ2RjYms5MWRIQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExuTjFaMmRsYzNScGIyNXpLU2t1YW05cGJpZ25YRzRuS1RzS0lDQnlaWFIxY200Z0tBb2dJQ0FnSit5bmdPcTRpT3UyZ08yRXNDRHJoSWpyaXBRZzdKZVE3SXFrN0p1UUtGTXRNU3dnNjdPMDdKV0k3WnFNN0lLc0tleWRtQ0R0bFp6cXRhM3NsclFnVlZnZ1YzSnBkR2x1WnlEc29JVHJyTGpxDQpzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91TA0KcEM0Z0p5QXJDaUFnSUNBbjdLR3c2ckcwSU8yUm5PMlloQ2pzbmJUc2c0SEN0K3lkdE8yVm1NSzM3SjIwNjRLMHdyZnN0SWpxczd6Q3QrdXZ1T3Vuak1LMzY3YUE3WVN3d3JmcXVZenNwNEFnNjVPeEtleWRnQ0Rzb0pYc3NZVWc3S0NWNjdPMDY0dWtJT0tBbENEcnVienFzYkRyZ3BnZzY0dWs2Nlc0SU95aHNPcXh0T3ljdk91aG5DRHJzSlRxdnJqc3A0QWc2NmVJNjUyOEtDSTE3WnFNSU95ZHRPeURnU0xzbllRZ0lqWHRtb3dpNjZHY0lPeWtoT3lkdE91cHRDRHNtS1RyaTdVcExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc2w1QWc3SmVHNjRxVUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN0l1YzZyQ0VJT3VUc1Nuc21ZQWc3WlcwNnJLd0lPdXdxZXV5bGNLMzdLQ0k3TENvS095ZXJPeUVwT3lnbGNLMzY2eTQ3SjJZN0xLWXdyZnNucXpzaTV6cmo0UWc2NU94S2V1bHZDRHNwNERzbHJUcmdyUWc2N2FaN0oyMDY0cVVJT3F5Zyt5ZGdDRHNvSWpyaklBZzZyaUkNCjdLZUFJT0tBbENEc2xZVHJpcFFnNnJDUzdKMjA2NTI4NjQrRUxDRHF0N2pybjdUcms2L3RsYlRyajRRZzdKT3c3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSnpQcXNKd2c3S0NjN0pXSTdKMkFJT3lFbk91aG5DRHNvSkhxdDd6c25iUWc2NHVzNjUyODdKVzhJTzJWbk91THBDRGlnSlFnN1pXWTY0S1k2NHFVSU95YmtPdXN1Q0RxdGF6c29iRHJwYndnN0p5ZzdLZUE3WldjSU95MW5PeUdqQ0RyaTZUcms2enF1TEFzSU8yVm1PdUNtT3VLbENEcnJManNucVVnNnJXczdLR3c2Nlc4SU95ZXJPcTFyT3lFc2UyVm5DRHJqSURzbFlnc0lDY2dLd29nSUNBZ0orcTN1T3Vtck9xem9DRHNvSUhzbHJUcmo0UWc3WldZNjRLWTY0cVVJT3F6dk9xd2tPMlZuQ0RzbnF6cXRhenNoTEU2SU95a2tldXp0U0R0a1p6dG1JVHNuWVFnNjQyYzdKYTA2NEswNnJPZ0xDRHNvSlhyczdRZzdJaWM3SVNjNjZXOElPeUNyT3lhcWV5ZWtPcXdnQ0RzbFl6c2xZVHNsYndnN1pXZ0lPcXlnK3UyZ08yRXNPdWhuQ0RzbnF6c29iRHNwNEh0DQpsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZw0KSUNBZ0oreVZoT3VlbUNEc21JanNpNXpyazZUc25ZQWc3WldjSU95a2hPeW5uT3VtckNEc3RaenNob3dnNnJXUTdLQ1Y3SjIwSU91bmp1eW5nT3VuakNEcXQ3anFzYlFnN1lha0tPMlZ0T3lhbE95eXRNSzM2cks5N0phMEtleWRtQ0RxdFpEcnM3anNuYlRzcDRBZzdJYU02cmU1N0lTeDdKMllJT3Exa091enVPeWR0Q0RzbFlUcmk0anJpNlFnNG9DVUlPeVhyT3VmckNEcnJManNucVhzcDV6cnBxd2c3SjZGNjZDbDdKMkFJT3VwbE95TG5PeW5nQ0RyaTZqc25JVHJvWndnNjR1azdJdWNJT3lFcE9xemhPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURyc0xEc2w3VHJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoY0szN0wyVTY1T2M3WTZjN0lxa0lPcTRpT3luZ0RwY2JpY2dLd29nSUNBZ0oxdDdJblJsZUhRaU9pQWk3S0NjN0pXSUlPdXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2cNCkl1dXN0T3lYaCt5ZGhDRHNtWndnNjdDVTZyK282NHFVN0tlQUlPMlZuT3ExcmV5V3RDRHRsWndnNjZ5NDdKNmxJbjBzSUM0dUxsMWNibHh1SnlBckNpQWdJQ0FuVyt5S3BPMkRnT3lkdkNEcXQ1enN1WmxkWEc0bklDc2dVMVJaVEVWZlVsVk1SVk1nS3lBblhHNWNiaWNnS3dvZ0lDQWdLRWRWU1VSRklEOGdKMXZzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jSU95Z2hPdXN1Q0FvZFhndGQzSnBkR2x1Wnk1dFpDa2c0b0NVSU95Y2hDRHF0NXpzdVpuc25aZ2c2cmU4NnJHdzdKbUFJT3lZaU95WnVDRHNpNXpyZ3BqcnBxenNtS1F1SU8yS3VlMmVpQ0RzbUlqc21iZ2c2cmVjN0xtWktPeUltT3VQbWUyWWxjSzM2cks5N0phMHdyZnJ0b0Rzb0pYdG1KWHNuWVFnN0p5ZzdLZUE3WlcwN0pXOElPMlZtT3VLbENEc2c0SHRtYWtwN0oyRUlPcTN1T3VNZ091aG5DRHJsTERycGJUcXM2QXNJT3lhbE95VnZlcXp2Q0Rzb0lUcnJManNuYlFnNjR1azY2VzA2Nm0wSU95Z2hPdXN1T3lkaENEcmxMRHJwYmpyaTZSZFhHNG5JQ3NnDQpSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cA0KYm1WQ2RXWWdQU0FuSnpzZ0lDQWdJQ0FnSUNBdkx5QnpkR1J2ZFhRZzdLU0VJT3V5aE8yTnZBcHNaWFFnZDJGcGRHVnlJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDOHZJTzJZaE95ZXJDRHRoTFRzblpnZ2V5QnlaWE52YkhabExDQnlaV3BsWTNRc0lIUnBiV1Z5SUgwS2JHVjBJSEYxWlhWbElEMGdVSEp2YldselpTNXlaWE52YkhabEtDazdJQzh2SU95YWxPeXlyU0RzcDRIcm9LenRtWlFnS091UG1leUxuQ0RzbXBUc3NxM3NuWUFnN0lpYzdJU2M2NHlBNjZHY0tRcHNaWFFnZEhWeWJuTWdQU0F3T3dwc1pYUWdkMkZ5YldWa1ZYQWdQU0JtWVd4elpUc0tiR1YwSUdOMWNuSmxiblJOYjJSbGJDQTlJRU5NUVZWRVJWOU5UMFJGVERzZ0x5OGc3S2VBNnJpSUlPeUV1T3lGbU95ZHRDRHJyTHpxczZBZzdKNkk2NHFVSU91cXFPdU51Q0FvN0pxVTdMS3Q3SjIwSU91THBPdWx1Q0RycXFqcmpianNuWVFnN0tlQTdLQ1Y3WldZNjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFcENpOHZJT3lMbk95ZWtTRHNpNXdnUTJ4aGRXUmwNCklFTnZaR1VvWTJ4aGRXUmxJRU5NU1NucXNJQWc3Sk80SU95SW1DRHNub2pyaXBUc3A0QWc3S0NRNnJLQUlPS0FsQ0RzbDRic25MenJxYlFnTDJobFlXeDBhT3VobkNEc2xZenJvS1FnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZuT3VMcEM0S0x5OGdiblZzYkQzdG1aWHNuYmdnN0tTUkxDQW5iMnNuUGV5Q3JPeWFxU0Rxc0lEcmlxVXNJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzlZMnhoZFdSbElPdXFoZXVndVNEc2w0YnNuWXdzQ2k4dklDZGpiR0YxWkdVdGJHOW5iM1YwSnoxamJHRjFaR1hyaXBRZzdKNkk3S2VBNjZlTUlPdWhuT3EzdU95ZHVDRHNoTGpzaFpnZzY2ZU02Nk9NSUNqdGhMUWc3SXVrN1l5b0lPeUxuQ0Rxc0pEc3A0QXNJT3lFc2VxenRTRHRoTFRzbmJRZzdKaWs2Nm0wSU95ZWtPdVBtU0R0bGJUc29Kd3BDaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzDQpucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWg0KN0oyQUlPcXl2ZXVobk91aG5DRHNucUh0bm9qcnI0RHJvWndnN0tTUjY2YTlJTzJSbk8yWWhPeWRoQ0RzazdUcmk2UUtZMjl1YzNRZ1RFOUhTVTVmUjFWSlJFVWdQU0FuN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdU95ZHRDRHRsWVRzbXBUdGxiVHNtcFFvN0pXSUlPdVFrT3F4c091Q21DRHJwNHpybzR3cElPS0FsQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGMGc2N0tFN1lxODdKMkVJT3VJaE91bHRPdXB0Q0Ryb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3lYdE95V3RPdVRuT3VncE95YWxDNG5Pd292THlEc2k2VHN1S0h0bFp3ZzY2eTQ2cldzNjVPa09pQWlSbUZwYkdWa0lIUnZJR0YxZEdobGJuUnBZMkYwWlRvZ1QwRjFkR2dnYzJWemMybHZiaUJsZUhCcGNtVmtJR0Z1WkNCamIzVnNaQ0J1YjNRZ1ltVWdjbVZtY21WemFHVmtJaWpycDR6cm80d3BMQW92THlBaVRtOTBJR3h2WjJkbFpDQnBiaURDdHlCUWJHVmhjMlVnY25WdUlDOXNiMmRwYmlJbzY2KzQ2NkdjNnJlNDdKMjQNCktTRGlnSlFnNjVHWUlPdUxwQ0RzbnFIdG5vanFzb3dnNjRTVDdaNk02NHVrQ21aMWJtTjBhVzl1SUdselFYVjBhRVZ5Y205eUtITXBJSHNLSUNCeVpYUjFjbTRnTDJGMWRHaGxiblJwWTJGMGZHOWhkWFJvZkdGd2FTQnJaWGw4Ykc5bklEOXBibnhzYjJkblpXUjhjMlZ6YzJsdmJpQmxlSEJwY21Wa0wya3VkR1Z6ZENoVGRISnBibWNvY3lrcE93cDlDaTh2SU95Q3JPeWFxU0R0bFp6cmo0UWc3TFNJNnJPOElPcXdrT3luZ0NEaWdKUWc2NkdjNnJlNDdKMjQ3SjJBSU91cGdPeXBvZTJWbk91TnNDQWk2NDJVSU91cXV5RHNrN1RyaTZRaTY0cVVJT3F5dmV5YXNDNGc2NkdjNnJlNDdKMjRJT3Vuak91ampPeVpnQ0Rzb2JEc3VaanFzSUFnNjR1czY1Mjg3SVNjSU91VXNPdWhuQ0RzbnFIcmlwVHJpNlF1Q2k4dklPeUxwT3k0b1NneU1ESTJMVEE0TENEdG1venNncXdnN0plVTdZU3c3WlNFNjUyODdKMjA3S2FJSU95aWpPeUVuU2s2SUNKWmIzVW5kbVVnYUdsMElIbHZkWElnYVc1a2FYWnBaSFZoYkNCemNHVnVaQ0JzDQphVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6cw0KbnBEc2w1RHFzb3dnN1pXYzY0K0U2Nlc4SU95WXJPdWdwQ0RyaTZ6cm5ienFzNkFnN0pxVTdMS3Q3WldZNnJPZ0xDRHNsWVRyaTRqcnFiUWdXL0NmbjZBZzdZRzA2NkdjNjVPY0lPMlZuT3VQaENEc3RJanFzN3hkSU91eWhPMkt2T3lkaENEcmlJenJuNndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxiUWc3S084N0lTNDdKcVVMaWM3Q2k4dklDZnRsWnpyajRRbjY2R2NJT3V0aWV1YXNlcTN1T3Vtck91cHRDRHNsWWdnNjVDYzY0dWtJT0tBbENEc25xRHF1WkFnNjZxdzY2YTBJT3VWakNEcmdwanJpcFFnY21GMFpTQnNhVzFwZE95ZHRPdUNtQ0RyckxqcnA2VWc2cmk0N0oyMElPeTBpT3F6dk9xNWpPeW5nQ0RzbnFIc2xZUUtMeThnN0plSjY1cXg3WldZNnJLTUlDTHJpNlRycGJnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJWbU91ZHZDTHFzNkFnN0pXSTY0SzA3WldZNnJLTUlPdVFuT3VMcEM0ZzdLZUE3TGFjd3Jmc2dxenNtcW5ybjRrZzdJT0I3WldjSU91c3VPcTENCnJPdW5qQ0Rzb29IdG1JRHNoSndnNjdPNDY0dWtDbVoxYm1OMGFXOXVJR2x6VEdsdGFYUkZjbkp2Y2loektTQjdDaUFnY21WMGRYSnVJQzl6Y0dWdVpDQnNhVzFwZEh4MWMyRm5aUzFqY21Wa2FYUnpmSFZ6WVdkbElHeHBiV2wwSUNoeVpXRmphR1ZrZkdWNFkyVmxaR1ZrS1M5cExuUmxjM1FvVTNSeWFXNW5LSE1wS1RzS2ZRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU8yWmxleWR1Q0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOejY2VzhJT3lkdmV5V3RBb3ZMeUF2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDQW83WlNNNjUrczZyZTQ3SjI0N0oyMElDTHJpSVRxdGF3ZzZyT0U3S0NWN0p5ODY2R2NJT3lUc091S2xDRHNwSkhzbmJqc3A0QWlJTzJSbk95TG5DRGlnSlFnNnJPMTdKcXBJRkJEN0plUTdJU2NJT3VDcU95ZG1DRHFzNFRzb0pVZzdKaWs3SUtzN0pxcElPdXdxZXluDQpnQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMA0KSU95ZHRDRHFzSkxxczd3ZzdZeU03SjI4N0oyWUlPcXpoT3lnbGV5ZHRDRHNsclRxdUl2cmdwenJpNlFLYkdWMElITmxjM05wYjI1QlkyTnZkVzUwSUQwZ2JuVnNiRHNLWm5WdVkzUnBiMjRnWTJ4aGRXUmxRV05qYjNWdWRDZ3BJSHNLSUNCcFppQW9SR0YwWlM1dWIzY29LU0F0SUdGalkyOTFiblJEWVdOb1pTNWhkQ0E4SURNd01EQXdLU0J5WlhSMWNtNGdZV05qYjNWdWRFTmhZMmhsTG1WdFlXbHNPd29nSUd4bGRDQmxiV0ZwYkNBOUlHNTFiR3c3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3dvZ0lDQWdaVzFoYVd3Z1BTQW9haUFtSmlCcUxtOWhkWFJvUVdOamIzVnVkQ0FtSmlCcUxtOWhkWFJvUVdOamIzVnVkQzVsYldGcGJFRmtaSEpsYzNNcElIeDhJRzUxYkd3N0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2cNCjY2R2M2cmU0N0oyNElPeWR0T3VncFNEc2w0YnNuWXdnNjVPeElPS0FsQ0J1ZFd4c0lPeWNvT3luZ0NBcUx5QjlDaUFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ1JHRjBaUzV1YjNjb0tTd2daVzFoYVd3Z2ZUc0tJQ0J5WlhSMWNtNGdaVzFoYVd3N0NuMEtablZ1WTNScGIyNGdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1NCN0NpQWdZMjl1YzNRZ2NISnZZbVVnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3ljdExYWmxjbk5wYjI0blhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXSUgwcE93b2dJR3hsZENCdmRYUWdQU0FuSnpzS0lDQndjbTlpWlM1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXlCdmRYUWdLejBnWkM1MGIxTjBjbWx1WnlncE95QjlLVHNLSUNCd2NtOWlaUzV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzdJSDBwT3dvZ0lIQnliMkpsTG05dUtDZGpiRzl6DQpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVA0KWldNNklDY25JSDA3Q2dvdkx5RGlsSURpbElBZzdaU002NStzNnJlNDdKMjRJT3lEbmV5aHRDRHFzSkRzcDRBbzdJdXM3SjZsNjdDVjY0K1pLU0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQUtMeThnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3VXb0NEc25vanJpcFFnNjQrWjdKV0lJR052WkdVdWRIUHFzSUFnTmV5MGlPdW5pT3VMcENCUVQxTlVJQzlvWldGeWRHSmxZWFRycGJ3ZzY3TzA2NEs0NjR1a0xnb3ZMeUR0bFp3ZzY3S0k3SjIwNjUyODY0K0VJT3V3bSt5ZGdDRHJrcVFnTXpEc3RJanFzSVFnNjRHSzZyaXc2Nm0wSU8yVWpPdWZyT3EzdU95ZHVDanJtSkRyaXBRZzdaUzg2cmU0NjZlSUtleWR0Q0RyaTZ2dG5vd2c2cktESU9LQWxDRHRnYlRyb1p6cms1enF1WXpzcDRBZzY0Mnc2NmFzNnJPZ0lPcXdtZXlkdENEcXVyenNwNFRyaTZRdUNpOHYNCklPeVZoT3luZ1NEdGxad2c2N0tJNjQrRUlPdXF1eURyc0p2c2xaanNuTHpycWJRbzY0dWs2NmFzNjZlTUlPdW92T3lnZ0NEc3ZLQWc3SU9CN1lPY0xDRHNucERyajVuc2k1enNucEVnNjVPeEtTRHFzNFRzaG8wZzY0eUE2cml3N1pXYzY0dWtMZ3BqYjI1emRDQklSVUZTVkVKRlFWUmZSRVZCUkY5TlV5QTlJRE13TURBd093cHNaWFFnYkdGemRFSmxZWFFnUFNBd093cHpaWFJKYm5SbGNuWmhiQ2dvS1NBOVBpQjdDaUFnYVdZZ0tHeGhjM1JDWldGMElDWW1JRVJoZEdVdWJtOTNLQ2tnTFNCc1lYTjBRbVZoZENBK0lFaEZRVkpVUWtWQlZGOUVSVUZFWDAxVEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNNNjUrczZyZTQ3SjI0SU95THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBZzRvQ1VJTzJVdk9xM3VPdW5pQy90bEl6cm42enF0N2pzbmJqc25iUWc2NHVyN1o2TUlPcXlnK3ljdk91aG5DRHJzN1RxczZBZzZyQ1o3SjIwSU9xNnZPeW5rZXVMaU91THBDNG5LVHNLSUNBZ0lIQnliMk5sDQpjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQc25MenJvWndnWTJ4aGRXUmxJTzJLdU91bXJPdWx2Q0Rzb0pYcnBxenRsWnpyaTZRS0lDQjlDbjBzSURVd01EQXBPd29LTHk4ZzRwU0E0cFNBSUVKU1QxZFRSVklnNnJDQTY2R2M3TEdFNnJpdzY0cVVJT3lnbk9xeHNPdVFrT3VMcENBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU1qVXBJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBb3ZMeURzbUlqc29JVHNsNVFnUWxKUFYxTkZVaUR0bVpqcXNyM3JzNERzaUpqc2w1QWc3SjZFN0l1Y0lPeUtwTzJCck91bXZlMkt1T3VsdkNEcXZZTHNsWVFnUTB4SjZyQ0FJT3lrZ0NCaGRYUm9iM0pwZW1VZ1ZWSk03SjJFSU95YXNPdW1yT3F3Z0NEcnNKdnNsWVRzaEp3ZzdKZTA3SmVJNjR1a0xnb3ZMeURycXFuc29JSHNuWUFnN1pXWTY0S1k2NytRN0oyMDdKZUk2NHVrSU9LQWxDRHFzNFRzb0pVZzdLQ0U3Wm1ZN0pxcA0KN0p5ODY2R2NJRlZTVE95ZGhDQmpiR0YxWkdVdVlXa3ZiRzluYjNWMFAzSmxkSFZ5YmxSdlBlS0FwdXVobkNEc25xenNucEhzaExIdGxiUUtMeThnN0lxNTdKMjRJTzJabE91cHRPeWRoQ0Rxc2JUcmhJanJtN0RxczZBZzZyT0U3S0NWSU95RW9PMkRuU0R0bVpUcnFiVHNsNUFnN0tlQjdaYUo3SXVjN1lLazZyaXdMaURxdDdnZzdKNnM3SjZSN0lTeDdKMkVJTzJQa09xNHNPMlZtT3lla0Nqc2dxenNtcW5zbnBBZzZyS3c3S0NWS1NEdGxianJrNlRybjZ6cmlwUUtMeThnNjZxcDdLQ0I3SjIwSU95WGh1eVd0T3loak9xem9Dd2dLaXJyZ3FqcXNxZ2c2NUdRNjZtMElPeVlwTzJlaU91Z3BDRHJvWnpxdDdqc25ianNuWVFnNjZlZDZyQ0E2NXlvNjZhdzY0dWtLaW82Q2k4dklDQWdRMHhKNnJDQUlGVlNUT3lkaENEcmxMRHNtTFR0a1p3ZzdKZUc3SjIwSU91RW1PcTRzT3VwdENCamJXVHFzSUFnWUNaZzdKZVE3SVNjSUZWU1RPeWRoQ0RzbnBqcm5id2c2N0tFNjZDa0tPeWNpT3VQaE95YXNDa2dZMnhwWlc1MFgybGsNCklPcXdtZXlkZ0NEcmtxVHNxcjBLTHk4Z0lDRHJwNlRxc0p6cnM0RHNpSmpxc0lBZzdJS3M2NTI4N0tlQTZyT2dMQ0RydUl6cm5ienNtckRzb0lEc2w1UWdJdXllbU91cXUrdVFuQ0JQUVhWMGFDRHNtcFRzc3EwZ3dyY2dZMnhwWlc1MFgybGtJT3VucE9xd25PdXpnT3lJbU9xd2dDRHJpSVRybmIzcmtKanNsNGpzaXJYcmk0anJpNlFpNnJDQUlPdWNyT3VMcEM0S0x5OGdJQ0RzaTZ6dGxaanJxYlFnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJT3lWaE95WWlDRHNsWWdnN0plMDY2YXc2NHVrS095THBPeTRvU0F5TURJMkxUQTRPaUJEVEVrZzdaU0U2NkdjN0lTNDdJcWs2NHFVSU91TWdPcTRzQ0RzcEpIc25ianJqYkFnN0xDOTdKMjBJT3lWaUNEcm5MZ3BMZ292THlEc25iVHNvSndnUWxKUFYxTkZVdXVsdkNEcXNiVHJrNXpycHF6c3A0QWc3SldLNjRxVTY0dWtJT0tHa2lCamJHRjFaR1VnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdLZUI3S0NSSU95WHNPdUxwQ2hEVEVrZzZyaXc2N080DQpJT3VQbWV5ZWtTa3VDaTh2SUNvcTdKMjBJT3F5dmV1aG5PeVhrQ0JWVWt3ZzZyQ0E2ck8xd3Jmc3BKSHFzSVFnN0lxazdZR3M2NmE5N1lxNDY2VzhJT3VMcE95TG5DRHJoS1BzcDRBZzY2ZVFJT3F5Z3k0cUtpRHFzNFRzb0pVZzdLQ0U3Wm1ZN0oyQUlPeUt1ZXlkdUNEdG1aVHJxYlFnN1pXWTY0dW9JRnZxczRUc29KVWc3S0NFN1ptWVhTRHJzb1R0aXJ6c25MenJvWnd1Q2dvdkx5RHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU8yVWhPdWhuT3lFdU95S3BDQW9ZMnhoZFdSbElHRjFkR2dnYkc5bmFXNGdMUzFqYkdGMVpHVmhhU2tnNG9DVUlDOXZjR1Z1TFd4dloybHU3SjIwSU95RG5leUVzY0szNnJTQTY2YXNMZ292THlEcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHJzN1RyZ3JUc3BJUWc2NVdNNnJtTTdLZUFJT3lJcU95V3RPeUVuQ0RyaklEcXVMRHRsWmpyaTZUcXNJQXNJT3laaE91ampPdVFtT3VwdENEc2lxVHNpcVRyb1p3ZzY0R2Q2NEtjNjR1aw0KTGdwc1pYUWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc0tiR1YwSUd4dloybHVVM1JoY25SbFpFRjBJRDBnTURzZ0x5OGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVnN0l1YzZyQ0JJT0tBbENEc25xenRnYlRycHEzc25iUWdKK3llck95TG5PdVBoQ2ZzbmJqc3A0QWdKK3lla091UG1leVpoT3VqakNEc2k2VHRqS2duN0oyNDdLZUFJT3Exck91MmhPMlZuT3VMcEFwbWRXNWpkR2x2YmlCcmFXeHNURzluYVc1UWNtOWpLQ2tnZXdvZ0lHbG1JQ2hzYjJkcGJsQnliMk5VYVcxbGNpa2dleUJqYkdWaGNsUnBiV1Z2ZFhRb2JHOW5hVzVRY205alZHbHRaWElwT3lCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUc1MWJHdzdJSDBLSUNCcFppQW9JV3h2WjJsdVVISnZZeWtnY21WMGRYSnVPd29nSUdOdmJuTjBJSEFnUFNCc2IyZHBibEJ5YjJNN0NpQWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tJQ0IwY25rZ2V3b2dJQ0FnYVdZZ0tIQnkNCmIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZDNhVzR6TWljcElIc0tJQ0FnSUNBZ2MzQmhkMjVUZVc1aktDZDBZWE5yYTJsc2JDY3NJRnNuTDFCSlJDY3NJRk4wY21sdVp5aHdMbkJwWkNrc0lDY3ZWQ2NzSUNjdlJpZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lIUnllU0I3SUhCeWIyTmxjM011YTJsc2JDZ3RjQzV3YVdRc0lDZFRTVWRVUlZKTkp5azdJSDBnWTJGMFkyZ2dLRjlsTWlrZ2V5QndMbXRwYkd3b0tUc2dmUW9nSUNBZ2ZRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3VzdE95TG5DQXFMeUI5Q24wS0NpOHZJTzJFdENEcmo0VHNwSkVnN1lHMDY2R2M2NU9jSU8yVWhPdWhuT3lFdU95S3BPcXdnQ0Rzbzczc2w0anNuWVFnNjVXTTdKMllJT3lMcE8yTXFDRHJxWlRzaTV6c3A0QWc0b0NVSUhKMWJsUjFjbTdzbmJRZzdKMjBJT3VwbE95TG5PeW5nT3lkdkNEcmxZenJwNHdnTWUyYWpDRHNucERyajVrZzdKNnM3SXVjNjQrRTdaV2M2NHVrDQpDbU52Ym5OMElGTkZVMU5KVDA1ZlJFbEZSQ0E5SUNmdGdiVHJvWnpyazV3ZzdJUzQ3SVdZN0oyMElPeWloZXVqak91UWtPeVd0T3lhbEM0bk93cHNaWFFnYzJoMWRIUnBibWRFYjNkdUlEMGdabUZzYzJVN0lDOHZJQzl6YUhWMFpHOTNiaURzcDRUdGxva2c3S1NSSU9LQWxDRHNucXpzaTV6cmo0VHJvWndnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtck95bmdDRHNsWXJxc293ZzdaR2M3SXVjQ2dvdkx5QnlaV0Z6YjI3c25ZUWc3S084NjZtMElDZnNuWmpyajRUc29JRWc3S0tGNjZPTUp5anFzNFRzb0pVZzdLQ0U3Wm1Zd3Jmcm9aenF0N2pzbFlUc200TWc2NU94S1NEaWdKUWc3S2VFN1phSklPeWtrZXlkdE91Tm1DRHRoTFRzbllRZzZyZTRJT3VwbE95TG5PeW5nT3VobkNEcmdaM3JnclRzaEp3S0x5OGdjblZ1VkhWeWJ1eWRtQ0JUUlZOVFNVOU9YMFJKUlVRZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE9xd2dDRHNtSnNnN0o2UTZyS3A3S2FkNjZxRjdKeTg2NkdjSU95RXVPeUZtT3lkaENEcmtKanNnclRycHF6cw0KcDRBZzdKV0s2cktNSU8yVm5PdUxwQzRLTHk4Z0tPeVZpQ0RxdDdqcm42enJxYlFnNnJPRTdLQ1ZJT3lnaE8yWm1DRHNwNEh0bTRRZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25iUWc2N2FBN1ptYzdaVzBJRTFCV0Y5VVZWSk9VK3E1ak95bmdDRHFzNFRzaG8wZzdKT3c3SjIwNjRxVUlPdXloT3EzdUNEaWdKUWdNakF5Tmkwd055RHJwcXpydDdEc2w1RHNoSndnN1ptVjdKMjRLUXBtZFc1amRHbHZiaUJyYVd4c1VISnZZeWh5WldGemIyNHBJSHNLSUNCcFppQW9jSEp2WXlrZ2V3b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzS0lDQWdJQ0FnSUNBdkx5QnphR1ZzYkRwMGNuVmw2NkdjSU91ZGhPeWJqT3lFbkNCd2NtOWo3SjJBSUdOdFpDRHF1NDNyamJEcXVMQWc0b0NVSUM5VTY2R2NJTzJLdU91bXJPeW51Q0Rzbzczc2w2enNsYndnN0tlRTdLZWNJR05zWVhWa1plcXdnQ0RxczZEc2xZVHJvWndnN0pXSUlPdUNxT3VLbE91THBBb2cNCklDQWdJQ0FnSUM4dklDanFzNkRzbFlRZ1kyeGhkV1JsNnJDQUlPeUVwT3k1bUNEdGpJenNuYnpzbllRZzY2eTg2ck9nSU95ZWlPeWN2T3VwdENEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU9xd2dDQWk3SUtzN0pxcElPeWtrU0xzbkx6cm9ad2c2NmVKN1o2WUtRb2dJQ0FnSUNBZ0lITndZWGR1VTNsdVl5Z25kR0Z6YTJ0cGJHd25MQ0JiSnk5UVNVUW5MQ0JUZEhKcGJtY29jSEp2WXk1d2FXUXBMQ0FuTDFRbkxDQW5MMFluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdDaUFnSUNBZ0lIMGdaV3h6WlNCN0NpQWdJQ0FnSUNBZ0x5OGdiV0ZqVDFNdjY2YXM2NGlGN0lxa09pQnphR1ZzYkRwMGNuVmw2NTI4SUhCeWIyUHNuYlFnYzJnZzZydU42NDJ3NnJpdzdKMjhJT3lJbUNEc25vanNuWXdnNG9DVUlITjBZWEowVUhKdlkreWRtQ0JrWlhSaFkyaGxaT3VobkNEcnA0enJrNkFLSUNBZ0lDQWdJQ0F2THlEdGxJVHJvWnpzaExqc2lxUWc2cmU0NjZPNUtDMXdhV1FwN0oyRUlPMkd0ZXluDQp1T3VobkNEc29KWHJwcXp0bFp6cmk2UWdLSFJoYzJ0cmFXeHNJQzlVSU91TWdPeWRrU2tLSUNBZ0lDQWdJQ0IwY25rZ2V5QndjbTlqWlhOekxtdHBiR3dvTFhCeWIyTXVjR2xrTENBblUwbEhWRVZTVFNjcE95QjlJR05oZEdOb0lDaGZaVElwSUhzZ2NISnZZeTVyYVd4c0tDazdJSDBLSUNBZ0lDQWdmUW9nSUNBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIMEtJQ0I5Q2lBZ2NISnZZeUE5SUc1MWJHdzdDaUFnZDJGeWJXVmtWWEFnUFNCbVlXeHpaVHNLSUNCcFppQW9kMkZwZEdWeUtTQjdJR05zWldGeVZHbHRaVzkxZENoM1lXbDBaWEl1ZEdsdFpYSXBPeUIzWVdsMFpYSXVjbVZxWldOMEtHNWxkeUJGY25KdmNpaHlaV0Z6YjI0Z2ZId2dVMFZUVTBsUFRsOUVTVVZFS1NrN0lIZGhhWFJsY2lBOUlHNTFiR3c3SUgwS2ZRb0tablZ1WTNScGIyNGdjM1JoY25SUWNtOWpLQ2tnZXdvZ0lHdHBiR3hRY205aktDazdDaUFnYkdsdVpVSjFaaUE5SUNjbk93b2dJSFIxY201eklEMGdNRHNLSUNBdg0KTHlEc25iUWc3SVM0N0lXWTdKMjBJT3lXdE91S2tDRHFzNFRzb0pYc25aZ2c3SjZGN0o2bDZyYU03Snk4NjZHY0lPdVBoT3VLbE95bmdDRHF1TERyb1owZzRvQ1VJT3V3bHV5WGtPeUVuQ0RxczRUc29KWHNuYlFnNjdDVTY0Q003SmVJNjRxVTdLZUFJT3U1aE9xMWtPMlZtT3VLbENEcXVMRHNwSUFLSUNCelpYTnphVzl1UVdOamIzVnVkQ0E5SUdOc1lYVmtaVUZqWTI5MWJuUW9LVHNLSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WUcwNjZHYzY1T2NJT3lFdU95Rm1DRHNpNXpyajVrZzdLU1I0b0NtSUNqcnFxanJqYmc2SUNjZ0t5QmpkWEp5Wlc1MFRXOWtaV3dnS3lBbktTY3BPd29nSUdOdmJuTjBJSFJvYVhOUWNtOWpJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuTFhBbkxDQW5MUzF0YjJSbGJDY3NJR04xY25KbGJuUk5iMlJsYkN3Z0p5MHRhVzV3ZFhRdFptOXliV0YwSnl3Z0ozTjBjbVZoYlMxcWMyOXVKeXdnSnkwdGIzVjBjSFYwTFdadmNtMWhkQ2NzSUNkemRISmxZVzB0YW5OdmJpY3MNCklDY3RMWFpsY21KdmMyVW5YU3dnZXdvZ0lDQWdjMmhsYkd3NklIUnlkV1VzSUdOM1pEb2dSVTFRVkZsZlExZEVMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWXNDaUFnSUNCa1pYUmhZMmhsWkRvZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBaFBUMGdKM2RwYmpNeUp5d2dMeThnVUU5VFNWZzZJT3lla09xNHNDRHRsSVRyb1p6c2hManNpcVFnNnJlNDY2TzVJT3lEbmV5RXNTRGlnSlFnYTJsc2JGQnliMlBzbmJRZzZyZTQ2Nk81N0tlNElPeWdsZXVtck8yVm9DRHNpSmdnN0o2STZyS01DaUFnZlNrN0NpQWdjSEp2WXlBOUlIUm9hWE5RY205ak93b2dJSEJ5YjJNdWMzUmtiM1YwTG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzS0lDQWdJR3hwYm1WQ2RXWWdLejBnWkM1MGIxTjBjbWx1WnlnbmRYUm1PQ2NwT3dvZ0lDQWdiR1YwSUdsa2VEc0tJQ0FnSUhkb2FXeGxJQ2dvYVdSNElEMGdiR2x1WlVKMVppNXBibVJsZUU5bUtDZGNiaWNwS1NBaFBUMGdMVEVwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlHeHBibVZDDQpkV1l1YzJ4cFkyVW9NQ3dnYVdSNEtTNTBjbWx0S0NrN0NpQWdJQ0FnSUd4cGJtVkNkV1lnUFNCc2FXNWxRblZtTG5Oc2FXTmxLR2xrZUNBcklERXBPd29nSUNBZ0lDQnBaaUFvSVd4cGJtVXBJR052Ym5ScGJuVmxPd29nSUNBZ0lDQnNaWFFnWlhZZ1BTQnVkV3hzT3dvZ0lDQWdJQ0IwY25rZ2V5QmxkaUE5SUVwVFQwNHVjR0Z5YzJVb2JHbHVaU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJR052Ym5ScGJuVmxPeUI5Q2lBZ0lDQWdJR2xtSUNobGRpQW1KaUJsZGk1MGVYQmxJRDA5UFNBbmNtVnpkV3gwSnlBbUppQjNZV2wwWlhJcElIc0tJQ0FnSUNBZ0lDQmpiMjV6ZENCM0lEMGdkMkZwZEdWeU93b2dJQ0FnSUNBZ0lIZGhhWFJsY2lBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnWTJ4bFlYSlVhVzFsYjNWMEtIY3VkR2x0WlhJcE93b2dJQ0FnSUNBZ0lHbG1JQ2hsZGk1cGMxOWxjbkp2Y2lrZ2V3b2dJQ0FnSUNBZ0lDQWdZMjl1YzNRZ2NtRjNJRDBnVTNSeWFXNW5LR1YyTG5KbGMzVnNkQ0I4ZkNCbGRpNXpkV0owZVhCbA0KSUh4OElDY25LUzV6YkdsalpTZ3dMQ0F5TURBcE93b2dJQ0FnSUNBZ0lDQWdMeThnN1pXYzY0K0VJT3kwaU9xenZPdWx2Q0RycUx6c29JQWc2N080NjR1a0lPS0FsQ0Ryb1p6cXQ3anNuYmdnN0ppazY2V1lJT3lnbGVxM25PeUxuZXlkdENEcmhKUHNsclRzaEp3b2JHOW5JRDlwYmlEcms3RXBJT3VzdU9xMXJPcXdnQ0Ryc0pUcmdJenJxYlFnN0lLODdZS3NJT3lJbUNEc25vanJpNlFLSUNBZ0lDQWdJQ0FnSUdsbUlDaHBjMHhwYldsMFJYSnliM0lvY21GM0tTa2dld29nSUNBZ0lDQWdJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0FuWTJ4aGRXUmxMV3hwYldsMEp6c2dMeThnTDJobFlXeDBhT3VobkNEc2xZenJwcndnNG9hU0lPdXloTzJLdk95ZHRDQmI3WldjNjQrRUlPeTBpT3F6dkYzcm9ad2c2N0NVNjRDTTZyT2dJT3F6aE95Z2xTRHNvSVR0bVpqc25ZUWc3SldJNjRLMENpQWdJQ0FnSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzdJS3M3SnFwSU8yVm5PdVANCmhDRHN0SWpxczd3ZzZyQ1E3S2VBT2ljc0lISmhkeWs3Q2lBZ0lDQWdJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpaE1TVTFKVkY5SFZVbEVSU2twT3dvZ0lDQWdJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaHBjMEYxZEdoRmNuSnZjaWh5WVhjcEtTQjdDaUFnSUNBZ0lDQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiRzluYjNWMEp6c2dMeThnTDJobFlXeDBhT3VobkNEdGxJenJuNnpxdDdqc25ianNsNUFnN0pXTTY2YThJT0tHa2lEcnNvVHRpcnpzbmJRZ1crdWhuT3EzdU95ZHVDRHRsWVRzbXBSZDY2R2NJT3V3bE91QW5Bb2dJQ0FnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBT2ljc0lISmhkeWs3Q2lBZ0lDQWdJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpaE1UMGRKVGw5SFZVbEVSU2twT3dvZ0lDQWdJQ0FnSUNBZ2ZTQmxiSE5sSUhzS0lDQWdJQ0FnDQpJQ0FnSUNBZ2R5NXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SmlrNjZXWU9pQW5JQ3NnY21GM0tTazdDaUFnSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2R2YXljN0lDOHZJT3lFc2VxenRTQTlJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjRJT3VMcENEc29KWHNnNEVnNG9DVUlPeVd0T3VXcENCd2NtOWliR1Z0N0oyMDY1T2dJTzJWdE95Z25DQW83SjZzNjZHYzZyZTQ3SjI0TCt5ZXJPeUVwT3k1bUNEcnM3WHF0NEFwQ2lBZ0lDQWdJQ0FnSUNCM0xuSmxjMjlzZG1Vb1UzUnlhVzVuS0dWMkxuSmxjM1ZzZENCOGZDQW5KeWtwT3dvZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnZlFvZ0lDQWdmUW9nSUgwcE93b2dJSEJ5YjJNdWMzUmtaWEp5TG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzS0lDQWdJR052Ym5OMElITWdQU0JrTG5SdlUzUnlhVzVuS0NkMWRHWTRKeWt1ZEhKcGJTZ3BPd29nSUNBZ2FXWWdLSE1nSmlZZw0KSVhNdWFXNWpiSFZrWlhNb0owUmxjSEpsWTJGMGFXOXVWMkZ5Ym1sdVp5Y3BLU0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZ1kyeGhkV1JsSUhOMFpHVnljam9uTENCekxuTnNhV05sS0RBc0lESXdNQ2twT3dvZ0lIMHBPd29nSUhCeWIyTXViMjRvSjJOc2IzTmxKeXdnS0dOdlpHVXBJRDArSUhzS0lDQWdJQzh2SU95ZHRPdXZ1Q0RzZzRnZzdJUzQ3SVdZN0p5ODY2R2NJT3Exa095eXRPdVFuQ0Rya3FRZzdKaWJJT3lFdU95Rm1PeWR0Q0RyaTZ2dG5vd2c2ckd3NjZtMElPdXN0T3lMbkNBbzY2cW82NDI0SU95Z2hPMlptQ0RzaTV3ZzdJT0lJT3lFdU95Rm1PeWRoQ0Rzbzczc25iVHNwNEFnN0pXSzZyS01LUW9nSUNBZ2FXWWdLSEJ5YjJNZ0lUMDlJSFJvYVhOUWNtOWpLU0J5WlhSMWNtNDdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WUcwNjZHYzY1T2NJT3lFdU95Rm1DRHNvb1hybzR3Z0tHTnZaR1VnSnlBcklHTnZaR1VnS3lBbktTRGlnSlFnNjR1azdKMk1JT3lhbE95eXJTRHINCmxZd2c2NHVrN0l1Y0lPeUxuT3VQbWUyVnFldUxpT3VMcEM0bktUc0tJQ0FnSUd0cGJHeFFjbTlqS0NrN0NpQWdmU2s3Q24wS0NtWjFibU4wYVc5dUlITmxibVJVZFhKdUtIUmxlSFFwSUhzS0lDQnlaWFIxY200Z2JtVjNJRkJ5YjIxcGMyVW9LSEpsYzI5c2RtVXNJSEpsYW1WamRDa2dQVDRnZXdvZ0lDQWdhV1lnS0NGd2NtOWpLU0J5WlhSMWNtNGdjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243WUcwNjZHYzY1T2NJT3lFdU95Rm1PeWR0Q0RzbDRic2xyVHNtcFF1SnlrcE93b2dJQ0FnYVdZZ0tIZGhhWFJsY2lrZ2NtVjBkWEp1SUhKbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSit5Vm51eUVvQ0RzbXBUc3NxM3NuYlFnN0tlRTdaYUpJT3lra2V5ZHRPeVhrT3lhbEM0bktTazdDaUFnSUNCamIyNXpkQ0IwYVcxbGNpQTlJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lTMElPeUxuT3F3aENEc3RJanFzN3dnNG9DVUlPeUV1T3lGbU95ZGhDRHNucXpzDQppNXpzbnBIdGxhbnJpNGpyaTZRdUp5azdDaUFnSUNBZ0lDOHZJT3lMbk9xd2hDRHN0SWpxczd6cmlwUWdKK3lFdU95Rm1DRHNvb1hybzR3bjdKbUFJT3Exck91MmhPdVFtT3VLbENEc29Kd2c2Nm1VN0l1YzdLZUE2NkdjSU91Qm5ldUN1T3VMcENEaWdKUWdhMmxzYkZCeWIyUHNuWmdnN0lTNDdJV1lJT3lpaGV1ampDQnlaV3BsWTNUcXNJQUtJQ0FnSUNBZ0x5OGdjblZ1VkhWeWJ1eWRtQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2Nlc4SU91MmdPdWx0T3VwdENEc2xZZ2c2NUNZNnJpd0lPdVZqT3VzdUNqcmlwRHJwckFnN1lTMDdKMkVJT3VSa0NEcnNvZ2c2NCtNNjZtMElPMlVqT3Vmck9xM3VPeWR1Q0F4TXpEc3RJZ2c3S0NjN1pXYzdKMkVJT3VFbU9xNHRPdUxwQ2tLSUNBZ0lDQWdhV1lnS0hkaGFYUmxjaWtnZXdvZ0lDQWdJQ0FnSUdOdmJuTjBJSGNnUFNCM1lXbDBaWEk3SUhkaGFYUmxjaUE5SUc1MWJHdzdDaUFnSUNBZ0lDQWdkeTV5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2Z0Z2JUcm9aenJrNXdnN0oyUg0KNjR1MTdKMjBJT3VFaU91c3RDRHNtS1RybnBnZzZyRzQ2NkNrSU95YWxPeXlyZXlkaENEc3BKSHJpNmp0bG9qc2xyVHNtcFFnNG9DVUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3BLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ2ZTd2dWRlZTVGw5VVNVMUZUMVZVWDAxVEtUc0tJQ0FnSUhkaGFYUmxjaUE5SUhzZ2NtVnpiMngyWlN3Z2NtVnFaV04wTENCMGFXMWxjaUI5T3dvZ0lDQWdjSEp2WXk1emRHUnBiaTUzY21sMFpTaEtVMDlPTG5OMGNtbHVaMmxtZVNoN0lIUjVjR1U2SUNkMWMyVnlKeXdnYldWemMyRm5aVG9nZXlCeWIyeGxPaUFuZFhObGNpY3NJR052Ym5SbGJuUTZJSFJsZUhRZ2ZTQjlLU0FySUNkY2JpY3NJQ2QxZEdZNEp5azdDaUFnZlNrN0NuMEtDaTh2SU9xd21leWRnQ0RyckxqcXRhenJwYndnNjZxSElPdXlpT3ludUNEcnJMdnJpcFRzcDRBZzZyaXc3SmExSU9LQWxDRHNucXpzbXBUc3NxM3NuYlRycWJRZ0l1eWR0T3lnaE9xenZDRHINCmk2VHJwYmdnN0lPSUlPeWduT3lWaUNMc25ZUWc3SnFVNnJXczdaV2M2NHVrQ2k4dklDanNsWWdnNnJlNDY1K3M2Nm0wSU8yQnRPdWhuT3VUbk9xd2dDRHNoTEhzaTZUdGxaanFzb3dnNnJDWjdKMkFJT3VMdGV5ZGhDRHJtSkFnNjRLMDdJU2NJRnRCU1NEc3RwVHNzcHdnNjQyVUlPdXdtK3E0c0YzcXNJQWc2NnkwN0oyWTY2KzQ3WlcwN0tlRTY0dWtLUXBqYjI1emRDQmhjMnRsWkVOdmRXNTBJRDBnYm1WM0lFMWhjQ2dwT3dvS0x5OGc3SVM0N0lXWUlPeWtnT3U1aENqc2k1enJqNWtyN0tlQTdJdWM2Nnk0SU95anZPeWVoU25ycGJ3ZzY3TzA3SjZsN1pXY0lPdVNwQ0R0bFp3ZzdZUzBJT3lMcE8yV2lTRGlnSlFnNjZxbzY1T2dJTzJZdU95Mm5PeWRnQ0J4ZFdWMVpldWhuQ0RzcDRIcm9LenRtWlF1Q2k4dklHMXZaR1ZzN0oyRUlPeWp2T3VwdENEcXQ3Z2c2NnFvNjQyNDY2R2NJQ2pyaTZUcnBiVHJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU2t1SU8yVm5DRHJxcWpyamJqc25ZUWc2ck9FN0lhTklPeVRzT3VwDQp0Q0RzbnF6c2k1enNucEhzbllBZzdMV2M3TFNJSURIdG1venJ2NUF1Q2k4dklISmxjR0Z5YzJVOWUzQmhjbk5sTENCbWIzSnRZWFJFWlhOamZldWx2Q0Rzbzd6cnFiUWc3WXlNN0l1eDZybU03S2VBSU95ZHRDRHNucUVnN0pXSTdKZVE3SVNjSU95eW1PdW1yTzJWbU9xem9DQjdjbUYzTENCd1lYSnpaV1I5NjZXOElPdVBqT3VncE95a2dPdUxwRG9LTHk4ZzdaaVY3SXVkSU95ZHRPMkRpQ0RzaTV3ZzZyQ1o3SjJBSU95RXVPeUZtT3lYa0NBaTdaaVY3SXVkNjR5QTY2R2NJT3VMcE95TG5DTHJwYndnN0pxVTZyV3M3WldZNjRxVUlPeWVyT3lhbE95eXJTRHRoTFRzbllRZ0tpcnFzSm5zbllBZzdZR1FJT3llb1NEc2xZanNsNURzaEp3cUtpRHJ0cG5zbmJqcmk2UXVDaTh2SU91emhPdVBoQ0RzbnFIc25MenJvWndnNjdtODY2bTBJQ2hoS1NEc2dxenNuYlRzbDVBZzY0dWs2Nlc0SU95YWxPeXlyU0R0aExUc25iUWc2NEc4N0phMElDZnJzS25xdUlnZzY0dTFKK3lkdENEcmdxanNuWmdnNjR1MTdKMjBJT3VRbU9xeg0Kb0NqcmdyVHNtcWtnN0ppazdKZThLU3dLTHk4Z0tHSXBJRTFCV0Y5VVZWSk9VeURxc3IzcXM0VHNsNURzaEp3ZzdJUzQ3SVdZN0oyMElPeWVyT3lMbk95ZWtldVB2Q0FuNjdDcDZyaUlJT3VMdFNmc25iUWc3SmVHNjRxVUlPeURpQ0RzaExqc2haanNuYlFnNjRLMDdKcXA3SjJFSU95bmdPeVd0T3VDdkNEc2lKZ2c3SjZJNjR1a0lDZ3lNREkyTFRBM0lPdW1yT3Uzc095WGtPeUVuQ0R0bVpYc25iZ3BMZ3BqYjI1emRDQlNSVkJCVWxORlgwSkJSQ0E5SUNoMktTQTlQaUIySUQwOUlHNTFiR3dnZkh3Z0tFRnljbUY1TG1selFYSnlZWGtvZGlrZ0ppWWdkaTVzWlc1bmRHZ2dQVDA5SURBcE93cG1kVzVqZEdsdmJpQnlkVzVVZFhKdUtHSjFhV3hrUVhOckxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrZ2V3b2dJR052Ym5OMElHcHZZaUE5SUhGMVpYVmxMblJvWlc0b1lYTjVibU1nS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnYW05aVUzUmhjblFnUFNCRVlYUmxMbTV2ZHlncE95QXZMeURzaTV6cXNJUWc3SmlJN0lLd0lPS0ENCmxDRHRsSXpybjZ6cXQ3anNuYmdnN0txOUlPeWduTzJWbkNneE16RHN0SWdwN0oyRUlPdUVtT3E0dUNEc25xenNpNXpyajRUcmlwUWc3WStzNnJpdzdaV2M2NHVrQ2lBZ0lDQnBaaUFvYlc5a1pXd2dKaVlnUVV4TVQxZEZSRjlOVDBSRlRGTXVhVzVrWlhoUFppaHRiMlJsYkNrZ0lUMDlJQzB4SUNZbUlHMXZaR1ZzSUNFOVBTQmpkWEp5Wlc1MFRXOWtaV3dwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdXFxT3VOdUNEcnM0RHFzcjA2SUNjZ0t5QmpkWEp5Wlc1MFRXOWtaV3dnS3lBbklPS0draUFuSUNzZ2JXOWtaV3dwT3dvZ0lDQWdJQ0JqZFhKeVpXNTBUVzlrWld3Z1BTQnRiMlJsYkRzS0lDQWdJQ0FnYzNSaGNuUlFjbTlqS0NrN0lDOHZJT3lEaUNEcnFxanJqYmpyb1p3ZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NBbzY0dWs3SjJNSU95YmpPdXdqZXlYaGV5WGtPeUVuQ0RzcDREc2k1enJyTGdnN0o2czdLTzg3SjZGS1FvZ0lDQWdmUW9nSUNBZ2FXWWdLSFIxY201eklENDlJRTFCDQpXRjlVVlZKT1V5QjhmQ0FoY0hKdll5a2djM1JoY25SUWNtOWpLQ2s3Q2lBZ0lDQnBaaUFvSVhkaGNtMWxaRlZ3S1NCN0NpQWdJQ0FnSUdOdmJuTjBJSFF3SUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUNBZ1lYZGhhWFFnYzJWdVpGUjFjbTRvYVc1emRISjFZM1JwYjI1TlpYTnpZV2RsS0NrcE93b2dJQ0FnSUNCM1lYSnRaV1JWY0NBOUlIUnlkV1U3Q2lBZ0lDQWdJSFIxY201ekt5czdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haZ2c3S1NBNjdtRUlPeVpoT3VqakNBb0p5QXJJQ2dvUkdGMFpTNXViM2NvS1NBdElIUXdLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2tnS3lBbmN5a2c0b0NVSU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjdtbzY1Mjg3SnFVTGljcE93b2dJQ0FnZlFvZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUdOdmJuTjBJR0Z6YXlBOUlHSjFhV3hrUVhOcktDazdJQzh2SU95ZXJPeUxuT3VQaENEcmxZd2c2ckNaN0oyQUlPeW5pT3VzdU95ZGhDRHJpNlRzaTV3Zw0KN0pPMDY0dWtJQ2hoYzJ0bFpFTnZkVzUwSU95ZHRPeWtrU0RzcHAzcXNJQWc2N0NwN0tlQUtRb2dJQ0FnYkdWMElISmhkenNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJSEpoZHlBOUlHRjNZV2wwSUhObGJtUlVkWEp1S0dGemF5azdDaUFnSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNBZ0lDOHZJTzJFdENEcmo0VHNwSkVnN1lHMDY2R2M2NU9jSU8yVWhPdWhuT3lFdU95S3BPcXdnQ0Rzbzczc25ZQWc2cks5N0pxd0tGTkZVMU5KVDA1ZlJFbEZSQ2tnTWUyYWpDRHNucERyajVrZzdKNnM3SXVjNjQrRUlPS0FsQ0RzZ3F6c21xbnNucERzbDVEcXNwQWc3SXVrN1l5bzY2R2NJT3lWaUNEcnM3VHNuYlRxc293dUNpQWdJQ0FnSUM4dklPeUxuT3F3aENEc3RJanFzN3pDdCt1aG5PcTN1T3lkdUNEcnA0enJvNHpDdCsyQnRPdWhuT3VUbkNEc21LVHJwWmpDdCt5ZG1PdVBoT3lnZ1NEc29vWHJvNHdvNnJPRTdLQ1ZJT3lnaE8yWm1DL3JvWnpxdDdqc2xZVHNtNE1zSUd0cGJHeFFjbTlqS0hKbFlYTnZiaWtwNjRxVUNpQWcNCklDQWdJQzh2SU95Z25DRHJxWlRzaTV6c3A0RHFzSUFnNjVTdzY2R2NJT3llaU95V3RDRHNsNnpxdUxBZzdKV0lJT3F4dU91bXNPdUxwQzRnN0tLRjY2T01JT3lhbE95eXJTRHNwSkhzbmJUcXNiRHJncGdnN0l1YzZyQ0VJT3lZaU95Q3NPeWR0Q0RzbHJ6cnA0Z2c3SldJSU91Q3FPeVZtT3ljdk91cHRDRHJrSmpzZ3JUcnBxenNwNEFnN0pXSzY0cVU2NHVrTGdvZ0lDQWdJQ0JwWmlBb2MyaDFkSFJwYm1kRWIzZHVJSHg4SUNFb1pTQW1KaUJsTG0xbGMzTmhaMlVnUFQwOUlGTkZVMU5KVDA1ZlJFbEZSQ2tnZkh3Z1JHRjBaUzV1YjNjb0tTQXRJR3B2WWxOMFlYSjBJRDRnTkRBd01EQXBJSFJvY205M0lHVTdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haanNuYlFnN1lTMElPdVBoT3lra1NEcmdZcnF1WUFnNG9DVUlPeWVyT3lMbk91UG1TRHRtNFFnTWUyYWpDRHNucXpzaTV6cmo0VHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJSE4wWVhKMFVISnZZeWdwT3dvZ0lDQWdJQ0JoDQpkMkZwZENCelpXNWtWSFZ5YmlocGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTazdDaUFnSUNBZ0lIZGhjbTFsWkZWd0lEMGdkSEoxWlRzS0lDQWdJQ0FnZEhWeWJuTWdQU0F5T3lBdkx5RHNtNHpyc0kzc2w0VWdNU0FySU95ZHRPdXlpQ0R0aExRZ0tITjBZWEowVUhKdlkreWR0Q0F3N0p5ODY2R2NJT3kwaU9xNHNPMlpsQ2tLSUNBZ0lDQWdjbUYzSUQwZ1lYZGhhWFFnYzJWdVpGUjFjbTRvWVhOcktUc0tJQ0FnSUgwS0lDQWdJR2xtSUNnaGNtVndZWEp6WlNrZ2NtVjBkWEp1SUhKaGR6c0tJQ0FnSUd4bGRDQndZWEp6WldRZ1BTQnlaWEJoY25ObExuQmhjbk5sS0hKaGR5azdDaUFnSUNBdkx5RHRtSlhzaTUwZzdKMjA3WU9JN0oyMDY2bTBJT3F3bWV5ZGdDRHNoTGpzaFpqQ3QrcXdtZXlkZ0NEc25xSHNsNURzaEp3ZzZyT243SjZsSU95ZXJPeWFsT3l5clNEaWdKUWc3SjIwSU8yRXRPeWR0Q0Rzbzczc25MenJxYlFnN0lPSUlPeUV1T3lGbU95ZGdDQW42N0NwNnJpSUlPdUx0U2ZzbllRZzY2cXc2NTI4Q2lBZw0KSUNBdkx5RHNwNERzbHJUcmdyd2c3SWlZSU95ZWlPeWN2T3V2Z091aG5DRHNoTGpzaFpnZzdJS3M2NmVkSU95ZXJPeUxuT3VQaE91S2xDRHRsWmpzcDRBZzdKV0s2ck9nSU9xM3VPdU1nT3VobkNEc2k2VHRqS2pzaTV6dGdxanJpNlFvN1l5TTdJdXhJT3lMcE8yTXFPdWhuQ0RxdDREcXNyQXBMZ29nSUNBZ2FXWWdLRkpGVUVGU1UwVmZRa0ZFS0hCaGNuTmxaQ2tnSmlZZ1JHRjBaUzV1YjNjb0tTQXRJR3B2WWxOMFlYSjBJRHdnTnpBd01EQXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTWpPeUxzU0RzaTZUdGpLZ2c0b0NVSU8yWWxleUxuU0RzbnF6c21wVHNzcTA2Snl3Z1UzUnlhVzVuS0hKaGR5a3VjMnhwWTJVb01Dd2dNekF3S1NrN0NpQWdJQ0FnSUhSMWNtNXpLeXM3Q2lBZ0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUNBZ2NtRjNJRDBnWVhkaGFYUWdjMlZ1WkZSMWNtNG9KK3V3cWVxNGlDRHJpN1hzbmJRZzdKcVU2cldzN1pXY0lPMllsZXlMbmV5WGtDRHNsclRxdUl2cmdxenINCmk2UXVJT3V3cWVxNGlDRHJpN1h0bFp3ZzY0SzA3SnFwN0oyRUlPeUVwT3VxaGNLMzdJS3M2ck84d3Jmc3ZaVHJrNXp0anB6c2lxUWc3SmVHN0oyMElPeVZoT3VlbUNCS1UwOU83Snk4NjZHYzY2ZU1JT3VMcE95TG5DRHN0cHpyb0tYdGxaanJuYnc2SUNjZ0t5QnlaWEJoY25ObExtWnZjbTFoZEVSbGMyTXBPd29nSUNBZ0lDQWdJSEJoY25ObFpDQTlJSEpsY0dGeWMyVXVjR0Z5YzJVb2NtRjNLVHNLSUNBZ0lDQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3SjZzN0pxVTdMS3RJT3lMcE8yTXFDRGlnSlFnN0pXRTY1Nlk3SmVRN0lTY0lPMk1qT3lMc1NEc2k2VHRqS2pyb1p3ZzdMS1k2NmFzSUNvdklIMEtJQ0FnSUgwS0lDQWdJR2xtSUNoU1JWQkJVbE5GWDBKQlJDaHdZWEp6WldRcEtTQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5TTdJdXhJT3lMcE8yTXFDQW83SjZzN0pxVTdMS3RJTzJiaE95WGtPdVBoQ2s2Snl3Z1UzUnlhVzVuS0hKaGR5a3VjMnhwWTJVb01Dd2dNekF3S1NrN0NpQWdJQ0J5DQpaWFIxY200Z2V5QnlZWGNzSUhCaGNuTmxaRG9nVWtWUVFWSlRSVjlDUVVRb2NHRnljMlZrS1NBL0lHNTFiR3dnT2lCd1lYSnpaV1FnZlRzS0lDQjlLVHNLSUNBdkx5RHRsWndnN0pxVTdMS3Q3SjIwSU95THBPMk1xTzJWdE91UGhDRHJpNlRzbll3ZzdKcVU3TEt0N0oyMElPeWR0T3lXdE95bmdPdVBoT3VoblNEdGdaRHJpcFFnN1pXdDdJT0JJT3lFc2VxenRleWN2T3VobkNEc29KWHJwcXdLSUNCeGRXVjFaU0E5SUdwdllpNWpZWFJqYUNnb0tTQTlQaUI3ZlNrN0NpQWdjbVYwZFhKdUlHcHZZanNLZlFvS0x5OGc2N0tFN1lxOElPdWR2T3V5cUNEcXQ1enN1WmtnNG9DVUlPMlVqT3Vmck9xM3VPeWR1T3lkdENBbjY3S0U3WXE4N0oyRUlPcXpxT3Vla091THBDZnFzNkFnN0pXTTY2Q2s3S1NFSU91VmpPdW5qQ0RzbHJucmlwVHJpNlF1Q2k4dklPdXloTzJLdkNEcnJManF0YXpyaXBRZzY2eTQ3SjZsN0oyMElPeVZoT3VMaU91ZHZDRHJqNW5zbnBFZzdKMjA2NmFFN0oyMDdKYTA3SVNjTENEc25iUWc3S2VBN0l1Yw0KNnJDQUlPeVhodXljdk91cHRDRHJyTGpzbnFYdG1KVWc2NHlBN0pXSTdKMjBJT3lFbnV5WHJDRHJncGpzbUtqcmk2UXVDbU52Ym5OMElFSlZWRlJQVGw5U1ZVeEZJRDBLSUNBbjdKMjBJT3VzdU9xMXJPdUtsQ0FxS3V1eWhPMkt2Q0RybmJ6cnNxZ3FLdXlkdE91THBDNGc2Nnk0N0o2bDdKMjBJT3lWaE91TGlPdWR2Q0RyajVuc25wRWc3SjIwNjZhRTdKMjA2NitBNjZHY09pRHJwNGpzdWFqdGtaekN0K3Vzdk95ZGpPMlJuTUszN0tLRjZyS3c3SmEwNjYrNEtIN3NtcFF2ZnV1THBDOSs2cm1NN0pxVUtTRHF1SWpzcDRBc0lDY2dLd29nSUNmcmtKanJqNFRyb1owZzdLZW43SjJBSU91UG1leWVrU0RycW9Yc2dxd283S0NBN0o2bHdyZnNncTNzb0p6Q3QreVhzT3F5c0NEdGxiVHNvSndnNjVPeEtldWhuQ3dnN1lhMTY3TzA3SVN4SU91THFPeWR2Q0Ryc29UdGlyenNuYlRycWJRZ0l1MlpsZXlkdUNJdUlDY2dLd29nSUNjaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenINCnA0d2c3Sk93NnJPZ0xDRHRtWlRycWJRZzZyaXc2NHFsNjZxRktPdXpnT3F5dmNLMzdaVzA3S0NjSU91VHNTbnNuWUFnNnJlNDY0eUE2NkdjSU91UmxPdUxwQzVjYmljN0Nnb3ZMeURyckxqcXRhd2c3TGFVN0xLY0lPMkV0Q0FvY205c1pUMG42N0tFN1lxOEoreWR0T3VwdENEcnNvVHRpcndnNnJlYzdMbVo3SjJFSU95V3VldUtsT3VMcENrS1puVnVZM1JwYjI0Z1lYTnJRMnhoZFdSbEtIUmxlSFFzSUcxdlpHVnNMQ0J5WlhCaGNuTmxMQ0J5YjJ4bEtTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3b2dJQ0FnWTI5dWMzUWdZWFIwWlcxd2RDQTlJQ2hoYzJ0bFpFTnZkVzUwTG1kbGRDaDBaWGgwS1NCOGZDQXdLU0FySURFN0NpQWdJQ0JoYzJ0bFpFTnZkVzUwTG5ObGRDaDBaWGgwTENCaGRIUmxiWEIwS1RzS0lDQWdJR2xtSUNoaGMydGxaRU52ZFc1MExuTnBlbVVnUGlBeU1EQXBJR0Z6YTJWa1EyOTFiblF1WTJ4bFlYSW9LVHNnTHk4ZzY2eTA3WldjN1o2SUlPeU1rK3lkdE95bmdDRHNsWXJxDQpzb3dLSUNBZ0lHTnZibk4wSUhKMWJHVWdQU0J5YjJ4bElEMDlQU0FuNjdLRTdZcThKeUEvSUVKVlZGUlBUbDlTVlV4RklEb2dKeWM3Q2lBZ0lDQnlaWFIxY200Z2NuVnNaU0FySUNoaGRIUmxiWEIwSUQ0Z01Rb2dJQ0FnSUNBL0lDZnFzSm5zbllBZzY2eTQ2cldzNjZXOElPdUxwT3lMbkNEc21wVHNzcTN0bFp6cmk2UXVJT3lkdENEc2hManNoWmpzbDVEc2hKd2c3SjIwN0tDRTdKZVFJT3lnbk95VmlPMldpT3VObUNEcXNvUHJrNlRxczd3ZzZySzU3TG1ZN0tlQUlPeVZpdXVLbEN3ZzZyV3M3S0d3NjRLWUlPeVd0TzJjbU9xd2dDRHRtWlhzaTZUdG5vZ2c2NHVrNjZXNElPeURpT3Vobk95YXRDRHJqSURzbFlnZ00rcXduT3VsdkNEcXQ1enN1Wm5yaklEcm9ad2dTbE5QVGlEcnNMRHNsN1Ryb1p6cnA0dzZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtRb2dJQ0FnSUNBNklDZnJpNlRzbll3Z1ZVa2c2Nnk0NnJXczdKMllJT3VNZ095VmlDQXo2ckNjNjZXOElPcTNuT3k1bWV1TWdPdWhuQ0JLVTA5Tw0KSU91d3NPeVh0T3Vobk91bmpEb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLSFJsZUhRcEtUc0tJQ0I5TENCdGIyUmxiQ3dnY21Wd1lYSnpaU2s3Q24wS0NpOHZJT3V5aU95WHJTRHRoTFFnNG9DVUlPcXdtZXlkZ0NEc2hManNoWmpzbllRZzdKT3c2NUNZTENEc25iVHJzb2dnN1lTMDY2ZU1JT3kybE95eW5DRHRtSlhzaTUwb1NsTlBUaURyc0xEc2w3UXBJT3VNZ095TG9DRHJzb2pzbDYwZzdaaVY3SXVkS0VwVFQwNGc2ckNkN0xLMEtleWRoQ0RzbXBUcXRhenRsWnpyaTZRS1puVnVZM1JwYjI0Z1lYTnJWSEpoYm5Oc1lYUmxLSFJsZUhRc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnS0FvZ0lDQWdKK3lkdE91eWlDRHNtcFRzc3Ezc25ZQWc2N0tJN0pldElPeWVrZXlYaGV5ZHRPdUxwQ0FvNjZ5NDZyV3NJT3VMcE91VHJPcTRzQ0RzbFlUcmk1Z2c0b0NVSU91TWdPeVZpQ0F6NnJDY0lPcTNuT3k1bWV5ZGdDRHNuYlRyc29nZzdZUzA3SmVRSU95Z2dleWENCnFlMlZtT3luZ0NEc2xZcnJpcFRyaTZRcExpQW5JQ3NLSUNBZ0lDZnJpNlRzbll3Z1ZVa2c2Nnk0NnJXczZyQ0FJTzJWbk9xMXJleVd0T3VwdENEc25wRHNsN0RzaXFUcm42enNtclFnN0ppQjdKYTA2NkdjTENEc21JSHNsclRycWJRZzdKNlE3SmV3N0lxazY1K3M3SnEwSU8yVm5PcTFyZXlXdE91aG5DRHJzb2pzbDYzdGxaanJuYnd1SUNjZ0t3b2dJQ0FnSjFWSklPdXN1T3Exck91THBPeWF0Q0Rxc0lUcXNyRHRsWndnN1pHYzdaaUU3SjJFSU95VHNPcXpvQ3dnN0oyMDY2YUV3cmZzaUt2c25wREN0K3VuaU95S3BPMkN1Y0szN1pTTTY2Q0k3SjIwN0lxazdabUE2NDJVNjRxVUlPcTN1T3VNZ091aG5DRHJzN1Rzb2JUdGxaenJpNlF1SUNjZ0t3b2dJQ0FnSit5YmtPdXN1T3lkbUNEc3BJUWc3SWlZNjZXOElPcTN1T3VNZ091aG5DRHNuS0RzcDREdGxaenJpNlFnNG9DVUlPeWJrT3VzdU95ZHRDRHRsWndnN0tTRTdKMjA2Nm0wSU91eWlPeVhyZXVQaENEdGxad2c3S1NFNjZHY0xDRHNwSVRyc0pUcXY0anNuWVFnDQo3SjZFN0oyWTY2R2NJT3kybE9xd2dPMlZtT3luZ0NEc2xZcnJpcFRyaTZRdUlDY2dLd29nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURxc0ozc3NyUWc3WldZNjRLWTY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvVWc2cmlJN0tlQU9pQW5JQ3NLSUNBZ0lDZDdJblJ5WVc1emJHRjBaV1FpT2lBaTY3S0k3SmV0NjZ5NElDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0prYVhKbFkzUnBiMjRpT2lBaWEyL2locEpsYmlEcm1KRHJpcFFnWlc3aWhwSnJieUo5T2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb2RHVjRkQ2tLSUNBcExDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0NuMEtDaTh2SU91TWdPMlpsTzJZbFNEcnJManF0YXdnN0tDYzdKNlJJTzJFdENEaWdKUWc3SUtzN0pxcDdKNlE2ckNBSU95RGdlMlpxZXlkaENEc2hLVHJxb1h0bFpqcnFiUWc2NmVsNjUyOTdKZVFJT3VubnV1S2xDRHJyTGpxdGF6cnBid2c2NmVNNjVPazdKYTA3S1NBNjR1aw0KTGdvdkx5QnRaWE56WVdkbGN6b2dXM3R5YjJ4bE9pZDFjMlZ5SjN3bllYTnphWE4wWVc1MEp5d2dkR1Y0ZEgxZElPeWdoT3l5dENEcmpJRHRtWlRycGJ3ZzY2ZWs2N0tJSU91d20rdUtsT3VMcENqcmk2VHJwcXpyaXBRZzY2eTA3SU9CN1lPY0lPS0FsQW92THlEc200enJzSTNzbDRVZzdLZUE3SXVjNjZ5NDdKMllJQ0xzbXBUc3NxM3JrNlRzbllBZzdJU2M2NkdjSU91c3RPcTBnQ0lnN0tDRTdLQ2M2Nlc4SU95bmdPMkNwT3E0c0NEc25JVHRsYlFnNjR5QTdabVVJT3VucGV1ZHZleWRoQ0R0aExRZzdKV0k3SmVRSU91cXZldVZoU0RzaTZQcmlwVHJpNlFwTGdwbWRXNWpkR2x2YmlCaGMydERiMjF3YjNObEtHMWxjM05oWjJWekxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrZ2V3b2dJSEpsZEhWeWJpQnlkVzVVZFhKdUtDZ3BJRDArSUhzS0lDQWdJR052Ym5OMElIUnlZVzV6WTNKcGNIUWdQU0FvYldWemMyRm5aWE1nZkh3Z1cxMHBMbTFoY0Nnb2JTa2dQVDRLSUNBZ0lDQWdLRzB1Y205c1pTQTlQVDBnSjJGemMybHoNCmRHRnVkQ2NnUHlBbjdKYTA3SXVjN0lxazdZUzA3WXE0T2lBbklEb2dKK3lDck95YXFleWVrRG9nSnlrZ0t5QlRkSEpwYm1jb2JTNTBaWGgwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0F4TlRBd0tRb2dJQ0FnS1M1cWIybHVLQ2RjYmljcE93b2dJQ0FnY21WMGRYSnVJQ2dLSUNBZ0lDQWdKK3lkdE91eWlDRHNtcFRzc3Ezc25ZQWdJdXVNZ08yWmxPMllsU0RyckxqcXRhd2c3S0NjN0o2Ukl1eWR0T3VMcENBbzZyaXc3S0cwSU91c3VPcTFyQ0RyaTZUcms2enF1TEFnN0pXRTY0dVlJT0tBbENEc2xZVHJucGdnNjR5QTdabVU2ckNBSU95ZHRPdXlpQ0R0aExUc25aZ2c3S0NFN0xLMElPdW5wZXVkdmV5ZHRPdUxwQ2t1SUNjZ0t3b2dJQ0FnSUNBbjdJS3M3SnFwN0o2UTZyQ0FJTzJabE91cHRDRHNnNEh0bWFuQ3QrdW5wZXVkdmV5ZGhDRHNoS1RycW9YdGxaanJxYlFzSU95S3BPMkRnT3lkdkNEcXQ1enN1Wm5xczd3ZzdKaUk3SXVjSU8yR3BPeVhrQ0RycDU3cmlwUWdWVWtnNjZ5NDZyV3M2Nlc4SU91bmpPdVRwT3lXDQp0Q0Rzb0p6c2xZanRsWmpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnNjZlbDY1Mjk3SjIwSU91MmdPeWhzZTJWbU91cHRDRHRqcmp0bFpqcXNvd2c2NUNZNjZ5ODdKYTA2NTI4T2lEc2xyVHJscVFnN1ptVTY2bTB3cmZxdUxEcmlxWHNuWmdnNjZ5NDZyV3M3SjI0N0tlQUxDRHJrNlRzbHJUcXNJZ2c3SjZRNjZhczY0cVVJT3lXdE91VWxPeWR1T3luZ0NqdGpKM3NsNFVnN1lPQTdKMjA3WXVBTCt1enVPdXN1Qy9yc29UdGlyd3NJTzJHb095S3BPMkt1Q3dnNjdtSUlPMlpsT3VwdENEc2xZanJnclFzSU91d3NPdUVpQ0RyazdFcExDRHNsclRybHFRZzdJT0I3Wm1wN0oyNDdLZUFLT3lFc2VxenRTRHRoclhyczdRdjdKaWs2NldZTCsyWmxleWR1Q0RzbXBUc3NxMHY3SldJNjRLMEtTRHFzSm5zbllBZzZyS0RMaURxdkswZzdaV0U3SnFVN1pXY0lPcXlnK3VuakNEcXM2anJuYndnN1pXY0lPdXlpT3lYa0NEc3RaenJqSUFnTXVxd25PcTVqT3luZ0N3ZzdLZW42cktNTGlEc25iVHJsWXdnYzNWbloyVnpkR2x2Ym5Qcg0KaXBRZzY3bUlJT3V3c095WHRDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcXNKRHNuYlFnN0phMDY0cVFJT3lnbGV1UGhDRHNtS1RycWJRZzY2eTc2cml3NjZlTUlPMlZtT3luZ0NEcnA0anJuYndnNG9DVUlPcXdnT3lnbGV5ZGhDRHNoTGpzbXJEcXM2QWc3TFNJN0pXSUlITjFaMmRsYzNScGIyNXo2Nlc4SU8yVnFPcTdtQ0RyZ3JUcnFiVHNoSndzSUhKbGNHeDU3SmVRSU9xd2dPeWdsZXlkaENEcnNKM3Rub2pxczZBZzY2eTA3SmVIN0oyRUlPeVZqT3VncE95anZPdXB0Q0RyalpRZzY2ZWU3TGFjSU95SW1DRHNub2pyaXBUc3A0QWc3WldjSU91c3VPeWVwZXljdk91aG5DRHJqYWZydHBuc2w2enJuYndvN0ppSU9pQWk3Wm1WN0oyNElPMk1uZXlYaGV5ZHRPdWR2T3F6b0NEcXNJRHNvSlh0bG9qc2xyVHNtcFFnNG9DVUlPMkdvT3lLcE8yS3VPdWR2T3VwdENEc2xZenJvS1Rzbzd6c2hManNtcFFpS1M1Y2JpY2dLd29nSUNBZ0lDQW5MU0RyckxqcXRhenJwYndnN0tDYzdKV0k3WldnSU91VmtDRHNoSnpyb1p3ZzdLQ1INCjZyZTg3SjIwSU91THBPdWx1Q0F5ZmpQcXNKd3VJT3F3Z1NEc29KenNsWWpzbDVRZzdKbWNJT3EzdU91Z2grcXlqQ0RzamJ6cmlwVHNwNEFnN0oyMDdKeWc2Nlc4SU91Mm1leWR1T3VMcEM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RzZ3F6c21xbnNucERxc0lBZzdKYTQ2cmlKN1pXWTdLZUFJT3lWaXV5ZGdDRHF0YXpzc3JRZzdLQ1Y2N08wS095Z2hPMlpsT3V5aU8yWXVNSzNWVkpNd3JmcXVJanNsYUhDdCsyYW4reUltQ0RyazdFcDY2VzhJT3luZ095V3RPdUN0Q0RyaEtQc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU8yYmhPeUdqU0RzbXBUc3NxMG9JdXVObENEc3A2ZnFzb3dpTENBaTY3S0U3WXE4N0pxcDdKeTg2NkdjSWlEcms3RXA3SjIwNjZtMElPeW5nZXlnaENEc29KenNsWWpzbllRZzZyZTRJT3V3cWUyV3BleWN2T3VobkNEcXM2RHNzNUFnNjR1azdJdWNJT3lnbk95VmlPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU9xd25leXl0Q0R0DQpsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhTRHF1SWpzcDRBNklDY2dLd29nSUNBZ0lDQW5leUp5WlhCc2VTSTZJQ0xyaklEdG1aUWc3SjJSNjR1MUlPMlZuT3VSa0NEcnJManNucVVnS08yVnRPeWFsT3l5dENraUxDQWljM1ZuWjJWemRHbHZibk1pT2lCYmV5SjBaWGgwSWpvZ0l1dXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2dJdXlkdE95Y29DRHRsWndnNjZ5NDdKNmxJbjFkZlZ4dVhHNG5JQ3NLSUNBZ0lDQWdKMXZyaklEdG1aUmRYRzRuSUNzZ2RISmhibk5qY21sd2RBb2dJQ0FnS1RzS0lDQjlMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdDbjBLQ2k4dklPMlVoT3VnaU95ZWhPdXpoQ2p0bFpqc25JUWc3WlNFNjZDSTdKNkVJT3VzdHV5ZGpDa2c3TGFVN0xLY0lPMkV0Q0RpZ0pRZzdaV2NJTzJabE91cHRPeWRoQ0R0bFpqc25JUWc3WlNFNjZDSTdKNkVJT3VMcU95Y2hPdWhuQ0RyZ3BqcmlLQWc2N08wNjRLMA0KNnJPZ0xBb3ZMeUFxS3UyVWhPdWdpT3llaE91bmlPdUxwQ0RybExEcm9ad3FLaURyaklEc2xZanNuWVFnNjdDYjY0cVU2NHVrTGlEdGxad2c3SnFVN0xLdDdKZVFJT3VMcENEc2k2VHNsclFnNjdPMDY0SzA2NHFVSU9xeWcreWR0Q0R0bGJYc2k2dzZDaTh2SU8yVWhPdWdpT3llaENEc2lKanJwNHp0Z2J3ZzdKcVU3TEt0N0oyRUlPeXF2T3F3bk91cHRDRHF0N2pycDR6dGdid2c2NHFRNjZDazdLZUE2ck9nS09xd2dTQTFmakV3N0xTSUtTRHF0YXpyajRVZzdJS3M3SnFwNjUrSjY0K0VJT3EzdU91bmpPMkJ2Q0RyZ3BqcXNJVHJpNlF1Q2k4dklHZHliM1Z3Y3pvZ1czdHVZVzFsTENCMFpYaDBjenBiWFgxZElDanRtWlRycWJRZzdKeUU0b2FTN0pXRTY1NllJT3lJbkNrdUNtWjFibU4wYVc5dUlHRnphMGR5YjNWd2N5aG5jbTkxY0hNc0lHMXZaR1ZzTENCeVpYQmhjbk5sTENCdGIzSmxLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ0x5OGc2N0tFN1lxOElPeVlnZXlYcmV5ZGdDQW8NCjY3S0U3WXE4S2V5Y3ZPdWhuQ0Rzc0kzc2xyUWc2N08wNjRLNDY0dWtJT0tBbENEcnNvVHRpcndnNjZ5NDZyV3M2NHFVSU91c3VPeWVwZXlkdENEc2xZVHJpNGpybmJ3ZzY0K1o3SjZSSU95ZHRPdW1oT3lkdE91ZHZDRHF0NXpzdVpuc25iUWc2NHVrNjZXMDY0dWtDaUFnSUNCamIyNXpkQ0JzYVhOMElEMGdLR2R5YjNWd2N5QjhmQ0JiWFNrdWJXRndLQ2huTENCcEtTQTlQZ29nSUNBZ0lDQW5XeWNnS3lBb2FTQXJJREVwSUNzZ0oxMGdKeUFySUZOMGNtbHVaeWdvWnlBbUppQm5MbTVoYldVcElIeDhJQ2duNnJlNDY2TzVKeUFySUNocElDc2dNU2twS1NBcklDaG5JQ1ltSUdjdWNtOXNaU0E5UFQwZ0ordXloTzJLdkNjZ1B5QW5JQ2pyc29UdGlyd3BKeUE2SUNjbktTQXJJQ2RjYmljZ0t3b2dJQ0FnSUNBb1p5QW1KaUJCY25KaGVTNXBjMEZ5Y21GNUtHY3VkR1Y0ZEhNcElEOGdaeTUwWlhoMGN5QTZJRnRkS1M1dFlYQW9LSFFwSUQwK0lDY2dJQzBnSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0ZOMGNtbHVaeWgwDQpJSHg4SUNjbktTa3BMbXB2YVc0b0oxeHVKeWtLSUNBZ0lDa3VhbTlwYmlnblhHNG5LVHNLSUNBZ0lHTnZibk4wSUdoaGMwSjBiaUE5SUNobmNtOTFjSE1nZkh3Z1cxMHBMbk52YldVb0tHY3BJRDArSUdjZ0ppWWdaeTV5YjJ4bElEMDlQU0FuNjdLRTdZcThKeWs3Q2lBZ0lDQmpiMjV6ZENCclpYa2dQU0FuWjNKdmRYQnpKeUFySUNobmNtOTFjSE1nZkh3Z1cxMHBMbTFoY0Nnb1p5a2dQVDRnS0djZ0ppWWdaeTUwWlhoMGN5QS9JR2N1ZEdWNGRITXVhbTlwYmlnbkp5a2dPaUFuSnlrcExtcHZhVzRvSnljcE93b2dJQ0FnWTI5dWMzUWdZWFIwWlcxd2RDQTlJQ2hoYzJ0bFpFTnZkVzUwTG1kbGRDaHJaWGtwSUh4OElEQXBJQ3NnTVRzS0lDQWdJR0Z6YTJWa1EyOTFiblF1YzJWMEtHdGxlU3dnWVhSMFpXMXdkQ2s3Q2lBZ0lDQnBaaUFvWVhOclpXUkRiM1Z1ZEM1emFYcGxJRDRnTWpBd0tTQmhjMnRsWkVOdmRXNTBMbU5zWldGeUtDazdDaUFnSUNCamIyNXpkQ0JoWjJGcGJpQTlJRzF2Y21VZ2ZId2dZWFIwWlcxdw0KZENBK0lERUtJQ0FnSUNBZ1B5QW43SjIwSU8yWmxPdXB0T3lkZ0NEc25iUWc3SVM0N0lXWTdKZVE3SVNjSU95ZHRPdXZ1Q0RyaTZUcnBKanJpNlF1SU95Vm51eUVuQ0RyZ3JnZzY0eUE3SldJNnJPOElPeVd0TzJjbU1LMzZyV3M3S0d3NnJDQUlPMlpsZXlMcE8yZWlDRHJpNlRycGJnZzdJT0lJT3VNZ095VmlPdW5qQ0RyZ3JUcm5id3VYRzRuQ2lBZ0lDQWdJRG9nSnljN0NpQWdJQ0J5WlhSMWNtNGdLQW9nSUNBZ0lDQmhaMkZwYmlBckNpQWdJQ0FnSUNmc25iVHJzb2dnN0pxVTdMS3Q3SjJBSUNMdG1aVHJxYlRzbllRZzdaV1k3SnlFSU8yVWhPdWdpT3llaE91emhPdWhuQ0RyZ3BqcmlLQWc2NHVrNjVPczZyaXdJdXVMcEM0ZzdKV0U2NTZZNjRxVUlPMlZuQ0R0bVpUcnFiVHNuWmdnNjZ5NDZyV3M2Nlc4SU8yVm1PeWNoQ0R0bElUcm9JanNub1FvN0ppQjdKZXRLU0RyaTZqc25JVHJvWndnNjZ5MjdKMkFJT3F5Zyt5ZHRPdUxwQzVjYmljZ0t3b2dJQ0FnSUNBbktpcnNtSUhzbDYzcnA0anJpNlFnNjVTdzY2R2MNCktpb2c2NHlBN0pXSTdKMkVJT3VDdE91ZHZDRGlnSlFnN0ppQjdKZXQ3SjJFSU95RW5PdWhuQ0R0bGFuc3VaanFzYkRyZ3BnZzdJaWM3SVNjNjZXOElPdXdsT3ErdU95bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnNnJDQklPeVlnZXlYcmV5WGtDRHJqSURzbFlnZ011cXduQzRnNnJlNElPeVlnZXlYcmV5ZHRDRHNsNnpybjZ3ZzdLU0U3SjIwNjZtMElPdU1nT3lWaU91UGhDQXFLdXF3bWV5ZGdDRHNwSVFnN0lpWUtpcnJvWndvN0tTRTY3Q1U2citJSUZ4Y2J1eWN2T3VobkNEcXRhenJ0b1FzSU95a2hDRHNpSnpzaEp3ZzdKeWc3S2VBS1M1Y2JpY2dLd29nSUNBZ0lDQW5MU0RzbUlIc2w2M3NuWmdnN0pldDdaV2dLTzJEZ095ZHRPMkxnTUszN0pXSTY0SzB3cmZyc29UdGlyd2c2NU94S2VxenZDRHNtNURyckxqc25aZ2c3S0NWNjdPMHdyZnNvYkRxc2JRbzdJaXI3SjZRd3JmcmpJRHNnNEhDdCt5aHNPcXh0Q25zbllBZzdKeWc3S2VBN1pXWTZyT2dMQ0RzbDRicmlwUWc3S0NWNjdPMDY2VzhJT3luDQpnT3lXdE91Q3RPeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSnkwZzZyT2c3TG1nSU9xeWpDRHNsNGJyaXBRZzdKaUI3SmV0N0oyMDY2bTBJT3VNZ095VmlDQXg2ckNjNjZlTUlPdUN0T3F4c091Q21DRHJ1WWdnNjdDdzdKZTA2NkdjSU91UmtPeVd0T3VQaENEcmtKenJpNlFnNG9DVUlPeVd0ZXluZ091aG5DRHJzSlRxdnJqc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGdDRHF0N2pyaklEcm9ad2c2NUdVNjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2hvWVhOQ2RHNGdQeUFuTFNBbzY3S0U3WXE4S2V5Y3ZPdWhuQ0R0a1p6c2k1enJrSndnN0ppQjdKZXQ3SjJBSUNjZ0t5QkNWVlJVVDA1ZlVsVk1SU0E2SUNjbktTQXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTaw0KNjZxRndyZnN2WlRyazV6dGpwenNpcVFnNnJpSTdLZUFPbHh1SnlBckNpQWdJQ0FnSUNkN0ltZHliM1Z3Y3lJNklGdDdJbTVoYldVaU9pQWk3SmlCN0pldElPeWR0T3VtaENqc25vWHJvS1hxczd3ZzY0K1o3SjI4S1NJc0lDSnpkV2RuWlhOMGFXOXVjeUk2SUZ0N0luUmxlSFFpT2lBaTY0eUE3SldJSU91c3VPcTFyQ0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NEdGxad2c2Nnk0N0o2bEluMWRmVjE5WEc0bklDc0tJQ0FnSUNBZ0oreVlnZXlYcmV5ZGdDRHNub1hyb0tVZzdJaWM3SVNjd3JmcXNKenNpSmpycGJ3ZzZyZTQ2NHlBNjZHY0lPeW5nTzJDcU91THBDNWNibHh1SnlBckNpQWdJQ0FnSUNkYjdKaUI3SmV0NjdPRUlPdXN1T3ExckYxY2JpY2dLeUJzYVhOMENpQWdJQ0FwT3dvZ0lIMHNJRzF2WkdWc0xDQnlaWEJoY25ObEtUc0tmUW9LTHk4ZzdaU0U2NkNJN0o2RTY3T0VJT3kybE95eW5DRHNuWkhyaTdYc2w1RHNoSndnVzN0dVlXMWxMQ0J6ZFdkblpYTjANCmFXOXVjenBiZTNSbGVIUXNJSEpsWVhOdmJuMWRmVjBnN0xhVTdMYWNDbVoxYm1OMGFXOXVJSEJoY25ObFIzSnZkWEJ6S0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdieUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCamIyNXpkQ0JoY25JZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTVuY205MWNITXBJRDhnYnk1bmNtOTFjSE1nT2lCYlhUc0tJQ0FnSUdOdmJuTjBJR2R5YjNWd2N5QTlJR0Z5Y2k1dFlYQW9LR2NwSUQwK0lDaDdDaUFnSUNBZ0lHNWhiV1U2SUZOMGNtbHVaeWdvWnlBbUppQm5MbTVoYldVcElIeDhJQ2NuS1M1MGNtbHRLQ2tzDQpDaUFnSUNBZ0lITjFaMmRsYzNScGIyNXpPaUJCY25KaGVTNXBjMEZ5Y21GNUtHY2dKaVlnWnk1emRXZG5aWE4wYVc5dWN5a0tJQ0FnSUNBZ0lDQS9JR2N1YzNWbloyVnpkR2x2Ym5NS0lDQWdJQ0FnSUNBZ0lDQWdMbTFoY0Nnb2VDa2dQVDRnS0hSNWNHVnZaaUI0SUQwOVBTQW5jM1J5YVc1bkp3b2dJQ0FnSUNBZ0lDQWdJQ0FnSUQ4Z2V5QjBaWGgwT2lCNExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lBbkp5QjlDaUFnSUNBZ0lDQWdJQ0FnSUNBZ09pQjdJSFJsZUhRNklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5SbGVIUXBJSHg4SUNjbktTNTBjbWx0S0Nrc0lISmxZWE52YmpvZ1UzUnlhVzVuS0NoNElDWW1JSGd1Y21WaGMyOXVLU0I4ZkNBbkp5a3VkSEpwYlNncElIMHBLUW9nSUNBZ0lDQWdJQ0FnSUNBdVptbHNkR1Z5S0NoNEtTQTlQaUI0TG5SbGVIUXBDaUFnSUNBZ0lDQWdPaUJiWFN3S0lDQWdJSDBwS1RzS0lDQWdJQzh2SU95ZHRPdW1oT3loc095d3FDRHNsNGJxczZBZzdLQ2M3SldJNjQrRUlPeVhodXVLbENEcQ0KdTQzcmpiRHF1TERycDR3ZzdKbVU3Snk4NjZtMElPMllsZXlMblNEc25iVHRnNGpyb1p3ZzY3TzQ2NHVrS09xd21leWRnQ0RzaExqc2haanNsNUFnN0o2czdKcVU3TEt0S1FvZ0lDQWdjbVYwZFhKdUlHZHliM1Z3Y3k1emIyMWxLQ2huS1NBOVBpQm5Mbk4xWjJkbGMzUnBiMjV6TG14bGJtZDBhQ2tnUHlCbmNtOTFjSE1nT2lCdWRXeHNPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdDaUFnSUNCeVpYUjFjbTRnYm5Wc2JEc0tJQ0I5Q24wS0NpOHZJTzJNbmV5WGhTRHNoTGp0aXJnZzdMYVU3TEtjSU8yRXRDRGlnSlFnN1pXY0lPMk1uZXlYaGV5ZG1DRHF0YXpzaExIc21wVHNob3dvN0pldDdaV2dLK3VzdU9xMXJDbnJwYndnN1pXY0lPdXlpT3lYa0NEcnM3VHJnclRxczZBc0NpOHZJT3lhbE95R2pPdXpoQ0RyZ3JIcXNKenFzSUFnN0pXRTY0dUk2NTI4SUNvcTdKbUU3SVN4NjVDY0lPMk1uZXlYaFNEc2hManRpcmdvN0x5QTdKMjA3SXFrS1NBeWZqUHFzSndxS3V1bHZDRHRoclhzbkx6cm9ad2c2N0NiNjRxVTY0dWsNCkxnb3ZMeUR0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcTg3SjIwSU8yVm5DRHJxcmpzbkx6cm9ad2c3SjI4NnJTQTY0Kzg3Slc4SU8yVm1PdXZnT3VobkNqcmxMRHJvWndnNjcyUjdKV0VJT3loc08yVnFlMlZtT3VwdENEc2xyVHF1SXZyZ3B6cmk2UXBJT3lFdU8yS3VDRHJpNmpzbklUcm9ad2c3S0NjN0pXSTdaV1k2cktNSU8yVm5PdUxwQzRLTHk4Z1pXeGxiV1Z1ZEhNNklGdDdjbTlzWlN3Z2RHVjRkSDFkSUNqdG1aVHJxYlFnN0p5RTRvYVM3SldFNjU2WUlPeUluQ2t1Q2k4dklHMXZjbVU5ZEhKMVpTaGI3THlBN0oyMDdJcWtJT3VObENEcnNKdnF1TEJkS2V1cHRDRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3V2dUNEcmdyZ2c3SVM0N1lxNDdKbUFJT3F5dWV5NW1PeW5nQ0RzbFlycmlwUWc3SU9JSU95RXVPMkt1T3VsdkNEc21wVHF0YXp0bFp6cmk2UXVDbVoxYm1OMGFXOXVJR0Z6YTFCdmNIVndLR1ZzWlcxbGJuUnpMQ0J0YjJSbGJDd2djbVZ3WVhKelpTd2diVzl5WlNrZ2V3b2dJSEpsDQpkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lHTnZibk4wSUhKdmJHVnpJRDBnS0dWc1pXMWxiblJ6SUh4OElGdGRLUzV0WVhBb0tHVXBJRDArSUZOMGNtbHVaeWdvWlNBbUppQmxMbkp2YkdVcElIeDhJQ2NuS1NrdWFtOXBiaWduTENBbktUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQW9aV3hsYldWdWRITWdmSHdnVzEwcExtMWhjQ2dvWlN3Z2FTa2dQVDRLSUNBZ0lDQWdLR2tnS3lBeEtTQXJJQ2N1SUZzbklDc2dVM1J5YVc1bktDaGxJQ1ltSUdVdWNtOXNaU2tnZkh3Z0p5Y3BJQ3NnSjEwZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtGTjBjbWx1Wnlnb1pTQW1KaUJsTG5SbGVIUXBJSHg4SUNjbktTa0tJQ0FnSUNrdWFtOXBiaWduWEc0bktUc0tJQ0FnSUM4dklPcXdtZXlkZ0NEdGpKM3NsNFhzbllRZzY2cUhJT3V5aU95bnVDRHJyTHZyaXBUc3A0QWc2cml3N0phMUlPS0FsQ0RzbnF6c21wVHNzcTNzbmJUcnFiUWdJdXlkdE95Z2hPcXp2Q0RyaTZUcnBiZ2c3SVM0N1lxNEl1dWx2Q0RzbXBUcQ0KdGF6dGxaenJpNlFLSUNBZ0lDOHZJQ2hoYzJ0RGJHRjFaR1hzbVlBZzZyQ1o3SjJBSU95ZHRPeWNvRG9nN0pXSUlPcTN1T3Vmck91cHRDRHRnYlRyb1p6cms1enFzSUFnNnJDWjdKMkFJT3lFdU8yS3VPdWx2Q0RybUpBZzY0SzA3SVNjSUZ2c3ZJRHNuYlRzaXFRZzY0MlVJT3V3bStxNHNGM3FzSUFnNjZ5MDdKMlk2Nis0N1pXMDdLZUU2NHVrS1FvZ0lDQWdZMjl1YzNRZ2EyVjVJRDBnSjNCdmNIVndBU2NnS3lBb1pXeGxiV1Z1ZEhNZ2ZId2dXMTBwTG0xaGNDZ29aU2tnUFQ0Z1UzUnlhVzVuS0NobElDWW1JR1V1ZEdWNGRDa2dmSHdnSnljcEtTNXFiMmx1S0NjQkp5azdDaUFnSUNCamIyNXpkQ0JoZEhSbGJYQjBJRDBnS0dGemEyVmtRMjkxYm5RdVoyVjBLR3RsZVNrZ2ZId2dNQ2tnS3lBeE93b2dJQ0FnWVhOclpXUkRiM1Z1ZEM1elpYUW9hMlY1TENCaGRIUmxiWEIwS1RzS0lDQWdJR2xtSUNoaGMydGxaRU52ZFc1MExuTnBlbVVnUGlBeU1EQXBJR0Z6YTJWa1EyOTFiblF1WTJ4bFlYSW9LVHNnTHk4ZzY2eTANCjdaV2M3WjZJSU95TWsreWR0T3luZ0NEc2xZcnFzb3dLSUNBZ0lHTnZibk4wSUdGbllXbHVJRDBnYlc5eVpTQjhmQ0JoZEhSbGJYQjBJRDRnTVFvZ0lDQWdJQ0EvSUNmc25iUWc3WXlkN0plRjdKMkFJT3lkdENEc2hManNoWmpzbDVEc2hKd2c3SjIwNjYrNElPdUxwT3VrbU91THBDNGc3SldlN0lTY0lPeWduT3lWaU8yVm5DRHNoTGp0aXJqcms2VHFzN3dnS2lyc29KSHF0N3pDdCt5V3RPMmNtT3F3Z0NEdG1aWHNpNlR0bm9nZzY0dWs2Nlc0SU95RGlDRHNoTGp0aXJncUt1dW5qQ0RyZ3JUcm5id282ckNaN0oyQUlPeUV1TzJLdUNEcnNKanJzN1VnNnJpSTdLZUFLUzVjYmljS0lDQWdJQ0FnT2lBbkp6c0tJQ0FnSUhKbGRIVnliaUFvQ2lBZ0lDQWdJR0ZuWVdsdUlDc0tJQ0FnSUNBZ0oreWR0T3V5aUNEc21wVHNzcTNzbllBZ0l1Mk1uZXlYaFNqcmk2VHNuYlRzbHJ6cm9aenF0N2dwSU95RXVPMkt1Q0RyaTZUcms2enF1TEFpNjR1a0xpRHNsWVRybnBqcmlwUWc3WldjSU8yTW5leVhoZXlkaENEc25JVGlocExzDQpsWVRybnBqcm9ad2c2NEtZN0plMDdaV2NJT3Exck95RXNleWFsT3lHak91VHBPeWR0T3VMcENqc2hKenJvWndnNjZ5MDZyU0E3WldjSU91emhPcXduQ0RyckxqcXRhenFzSUFnN0pXRTY0dUk2NHVrS1M0Z0p5QXJDaUFnSUNBZ0lDZnNtcFRzaG96cnBid2c2NEt4NnJDYzY2R2NJT3F6b095NW1PeW5nQ0RycDVEcXM2QXNJQ29xN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2T3lkdENEc2hKenJvWndnN0oyODZyU0E2NUNjSUNMc21ZVHNoTEhya0p3ZzdZeWQ3SmVGSU95RXVPMkt1Q0lnTW40ejZyQ2NLaXJycGJ3ZzdLQ2M3SldJN1pXWTY1MjhMaURxc0lFZzdJUzQ3WXE0NjRxVUlPeUVuT3VobkNEcmk2VHJwYmdnN0tDUjZyZTg3SjIwN0phMDdKVzhJTzJWbk91THBDNWNiaWNnS3dvZ0lDQWdJQ0FuNnJDQklPeUV1TzJLdU91S2xDRHNub1hyb0tYcXM3d2dLaXJxc0puc25ZQWc3SmV0N1pXZ3dyZnFzSm5zbllBZzZyQ2M3SWlZd3JmcXNKbnNuWUFnN0lpYzdJU2NLaXJzblpnZzdKcVU3SWFNNjZXOA0KSU91cXFPdVJrQ0R0ajZ6dGxhanRsWnpyaTZRdUlPeUV1TzJLdUNEc2xZanNsNURzaEp3ZzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdk95ZGdDRHRsWndnNjZxNDdKeTg2NkdjSU91bm51eVZoT3VXcU95V3RPeWd1T3lWdkNEdGxaenJpNlFvN0ppSU9pRHJzN2pyckxqc25iUWdJbjd0bGFEcXVZenNtcFEvSXV1cHRDRHJzb1R0aXJ6c25ZQWdXK3lWaE91TGlPeVlwRjB2Vyt1RXBGMHBMbHh1SnlBckNpQWdJQ0FnSUNkYjdZeWQ3SmVGSU91c3VPeXl0Q0RxdDV6c3Vaa2c0b0NVSU95Y2hDRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2M3SjJZSUNJNExpRHRqSjNzbDRVaUlPeUV1ZXlGbU95ZGhDRHJsTERycGJqcmk2UmRYRzRuSUNzS0lDQWdJQ0FnSnkwZzdZT0E3SjIwN1l1QU9pRHNwNmZzbllBZzY2cUY3SUtzNnJXc0tESitOT3lXdE95Z2lDa3NJT3lpaGVxeXNPeVd0T3V2dU1LMzY2ZUk3TG1vN1pHY0lPeVhodXlkdENoKzdKcVVMMzdyaTZRdmZ1cTVqT3lhbEQ4ZzZyaUk3S2VBS1M0ZzY3Q1kNCjY1T2M3SXVjSU95VmlPdUN0Q2pyczdqcnJMZ3BJT3VucGV1ZHZleWRoQ0RzbXBUc2xiM3RsYlFnN1lPQTdKMjA3WXVBNjZlTUlPdTBrT3VQaENEcnJMVHNpcWdnN1l5ZDdKZUY3SjI0N0tlQUlPeVZqT3F5akNEdGxaanJuYnd1SU95YmtPdXp1T3lkdENBaTdKV002NmE4TCsyWmxleWR1Q0xzc3Bqcm43d2c2NmVKN0pldzdaV1k2Nm0wSU91enVPdXN1T3lkaENEcXQ3enFzYkRyb1p3ZzZyV3M3TEswN1ptVTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lWaU91Q3RDanJzN2pyckxncE9pRHRsYlRzbXBUc3NyUXVJTzJNa091THFPeWR0Q0R0bFlUc21wVHRsWmpycWJRZ0luN3RsYURxdVl6c21wUS9JdXVobkNEcnJMdnFzNkFzSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPeWNoTzJYbUNqc2dxM3NvSnpDdCsyRGlPMkh0Q0RyazdFcDdKMkFJT3F5c09xenZPdWx2Q0RycUx6c29JQWc2cks5NnJPZzdaV2M2NHVrTGlEcXNyRHFzN3pDdCt5RGdlMkRuQ0R0aHJYcnM3VHJxYlFnN0lTYzdJaWc3WmlWDQo3Snk4NjZHY0lPeVZqT3Vtc091THBDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcnNvVHRpcnc2SU91enVPdXN1T3lkdENBaWZ1MlZvT3E1ak95YWxEOGk2Nm0wSUZ2c2xZVHJpNGpzbUtSZEwxdnJoS1JkTENEcnM3anJyTGpzbmJRZzdJT0I3Wm1wN0oyRUlPeUVuT3lJb08yVm1PcXpvQ0RzbmJRZzY3S0U3WXE4N0oyMElPeUxwT3lnbkNEcmo1bnNucEhzbmJUcnFiUWc2NCtaN0o2UklPdVBtZXlDckNqc2dxM3NvSnd2N0tDQTdKNmxMK3lYc09xeXNDRHRsYlRzb0p3ZzY1T3hLU3dnN1lhMTY3TzBJTzJNbmV5WGhleWRtQ0RyaTZqc25id2c2N0tFN1lxODdKMjA2Nm0wSUNMdG1aWHNuYmdpTGlBaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenJwNHdzSUNMcmk2dnF1TERDdCt1UG1leWVrU0lnN0tHdzdaV3BJT3E0aU95bmdDNGc3Wm1VNjZtMElPcTRzT3VLcGV1cWhTanJzNERxc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bg0KSUNzS0lDQWdJQ0FnSnkwZzdKdVE2Nnk0N0oyWUlPeWdsZXV6dE1LMzdLR3c2ckcwS095SXEreWVrTUszN0oyMDdJT0JMK3lkdE8yVm1NSzM2NHlBN0lPQktleWRnQ0RzbktEc3A0RHRsWmpxczZBc0lPeWJrT3VzdU95WGtDRHNsNGJyaXBRZzdLQ1Y2N08wd3Jmc29JanNzS2pDdCt5WHNPdWR2ZXl5bU91bHZDRHNwNERzbHJUcmdyVHNwNEFnNjZlSTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNmcmk3WHNuWUFnNjdDWTY1T2M3SXVjSUVwVFQwNGc2ckNkN0xLMElPMlZtT3VDbU91bmpDRHN0cHpyb0tYdGxaenJpNlF1SU91bmlPMkJyT3VMcE95YXRNSzM3SVNrNjZxRndyZnN2WlRyazV6dGpwenNpcVFnNnJpSTdLZUFPbHh1SnlBckNpQWdJQ0FnSUNkN0luTmxkSE1pT2lCYmV5SnlaV0Z6YjI0aU9pQWk3SjIwSU95RXVPMkt1T3lkbUNEcnNLbnRscVhzbllRZzdaV2M2cld0N0phMElPMlZuQ0Ryckxqc25xWHNuTHpyb1p3aUxDQWlaV3hsYldWdWRITWlPaUJiZXlKeWIyeGxJam9nSXV5WHJlMlZvQ0lzSUNKMFpYaDANCklqb2dJdXVzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lmU3dnTGk0dVhYMHNJQzR1TGwxOVhHNG5JQ3NLSUNBZ0lDQWdKK3lYcmUyVm9PeWRnQ0Rzbm9Ycm9LVWc3SWljN0lTYzY0eUE2NkdjT2lBbklDc2djbTlzWlhNZ0t5QW5YRzVjYmljZ0t3b2dJQ0FnSUNBblcrMk1uZXlYaFNEc21wVHNob3hkWEc0bklDc2diR2x6ZEFvZ0lDQWdLVHNLSUNCOUxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0NuMEtDaTh2SU8yTW5leVhoU0RzblpIcmk3WHNsNURzaEp3Z2UzTmxkSE02SUZ0N2NtVmhjMjl1TENCbGJHVnRaVzUwY3pwYmUzSnZiR1VzZEdWNGRIMWRmVjE5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlFiM0IxY0NoeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljDQpjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYSHRiWEhOY1UxMHFYSDB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93b2dJQ0FnWTI5dWMzUWdjMlYwYzBsdUlEMGdRWEp5WVhrdWFYTkJjbkpoZVNodklDWW1JRzh1YzJWMGN5a2dQeUJ2TG5ObGRITWdPaUJiWFRzS0lDQWdJR052Ym5OMElITmxkSE1nUFNCelpYUnpTVzRLSUNBZ0lDQWdMbTFoY0Nnb2MzUXBJRDArSUNoN0NpQWdJQ0FnSUNBZ2NtVmhjMjl1T2lCVGRISnBibWNvS0hOMElDWW1JSE4wTG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTd0tJQ0FnSUNBZ0lDQmxiR1Z0Wlc1MGN6b2dRWEp5WVhrdWFYTkJjbkpoZVNoemRDQW1KaUJ6ZEM1bGJHVnRaVzUwY3lrS0lDQWdJQ0FnSUNBZ0lEOGdjM1F1Wld4bGJXVnVkSE1LSUNBZ0lDQWdJQ0FnSUNBZ0lDQXViV0Z3S0NobGJDa2dQVDRnS0hzZ2NtOXNaVG9nVTNSeQ0KYVc1bktDaGxiQ0FtSmlCbGJDNXliMnhsS1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQ0IwWlhoME9pQlRkSEpwYm1jb0tHVnNJQ1ltSUdWc0xuUmxlSFFwSUh4OElDY25LUzUwY21sdEtDa2dmU2twQ2lBZ0lDQWdJQ0FnSUNBZ0lDQWdMbVpwYkhSbGNpZ29aV3dwSUQwK0lHVnNMblJsZUhRcENpQWdJQ0FnSUNBZ0lDQTZJRnRkTEFvZ0lDQWdJQ0I5S1NrS0lDQWdJQ0FnTG1acGJIUmxjaWdvYzNRcElEMCtJSE4wTG1Wc1pXMWxiblJ6TG14bGJtZDBhQ2s3Q2lBZ0lDQnlaWFIxY200Z2MyVjBjeTVzWlc1bmRHZ2dQeUJ6WlhSeklEb2diblZzYkRzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXdvZ0lDQWdjbVYwZFhKdUlHNTFiR3c3Q2lBZ2ZRcDlDZ292THlEcmpJRHRtWlR0bUpVZzdLQ2M3SjZSSU95ZGtldUx0ZXlYa095RW5DQjdjbVZ3Ykhrc0lITjFaMmRsYzNScGIyNXpXMTE5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVkQNCmIyMXdiM05sS0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdieUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCamIyNXpkQ0J5WlhCc2VTQTlJRk4wY21sdVp5Z29ieUFtSmlCdkxuSmxjR3g1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BPd29nSUNBZ1kyOXVjM1FnYzNWbloyVnpkR2x2Ym5NZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTV6ZFdkblpYTjBhVzl1Y3lrS0lDQWdJQ0FnUHlCdkxuTjFaMmRsYzNScGIyNXpDaUFnSUNBZ0lDQWdJQ0F1YldGd0tDaDRLU0E5UGlBb2V5QjBaWGgwT2lCVGRISnBibWNvS0hnZ0ppWWdlQzUwWlhoMEtTQjhmQ0FuDQpKeWt1ZEhKcGJTZ3BMQ0J5WldGemIyNDZJRk4wY21sdVp5Z29lQ0FtSmlCNExuSmxZWE52YmlrZ2ZId2dKeWNwTG5SeWFXMG9LU0I5S1NrS0lDQWdJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tIZ3BJRDArSUhndWRHVjRkQ2tLSUNBZ0lDQWdPaUJiWFRzS0lDQWdJR2xtSUNoeVpYQnNlU0I4ZkNCemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElISmxkSFZ5YmlCN0lISmxjR3g1TENCemRXZG5aWE4wYVc5dWN5QjlPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95VmhPdWVtT3VobkNBcUx5QjlDaUFnY21WMGRYSnVJRzUxYkd3N0NuMEtDaTh2SU91eWlPeVhyU0RzblpIcmk3WHNsNURzaEp3Z2UzUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZibjBnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpWUnlZVzV6YkdGMFpTaHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObA0KS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzhnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ1kyOXVjM1FnZEhKaGJuTnNZWFJsWkNBOUlGTjBjbWx1Wnlnb2J5QW1KaUJ2TG5SeVlXNXpiR0YwWldRcElIeDhJQ2NuS1M1MGNtbHRLQ2s3Q2lBZ0lDQnBaaUFvZEhKaGJuTnNZWFJsWkNrZ2NtVjBkWEp1SUhzZ2RISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVPaUJUZEhKcGJtY29LRzhnSmlZZ2J5NWthWEpsWTNScGIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURzbFlUcm5wanJvWndnS2k4Z2ZRb2dJSEpsZEhWeWJpQnVkV3hzT3dwOUNnb3ZMeURzblpIcmk3WHNsNURzaEp3Z2UzUmxlSFFzSUhKbFlYTnYNCmJuMGc2N0N3N0plMElPeTJsT3kybkNBbzdMMlU2NU9jN1k2YzdJcWt3cmZzbFo3cmtxUWc3SjZoNjR1MElPMlhpT3lhcVNrS1puVnVZM1JwYjI0Z2NHRnljMlZUZFdkblpYTjBhVzl1Y3loeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEZ0YlhITmNVMTBxWEYwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJR0Z5Y2lBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3Q2lBZ0lDQnBaaUFvUVhKeVlYa3VhWE5CY25KaGVTaGhjbklwS1NCN0NpQWdJQ0FnSUhKbGRIVnliaUJoY25JS0lDQWdJQ0FnSUNBdWJXRndLQ2g0S1NBOVBpQW9leUIwWlhoME9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1MFpYaDBLU0I4ZkNBbkp5a3VkSEpwYlNncExDQnlaV0Z6DQpiMjQ2SUZOMGNtbHVaeWdvZUNBbUppQjRMbkpsWVhOdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa0tJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaDRLU0E5UGlCNExuUmxlSFFwT3dvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95VmhPdWVtT3VobkNBcUx5QjlDaUFnY21WMGRYSnVJRnRkT3dwOUNnb3ZMeURyb1p6cXQ3anNuYmdnN1pXRTdKcVV3cmZ0bFp6cmo0UWc3TFNJNnJPOElPeURnZTJEbk95ZHZDRHJsWXdnTDJobFlXeDBhQ0Rzb2JEdG1venFzSUFnN0ppazY2bTBJT3VTcE95WGtPeUVuQ0RzbTR6cnNJM3NsNFhzbllRZzY0dWs3SXVjSU95TG5PdVBoTzJWdE91enVPdUxwQ0FvTXpEc3RJanNsNUFnTWV1eWlPdW5qQ2t1Q2k4dklPeUVzZXF6dGUyVm1PdXB0Q0Rxc3JEcXM3d2c3Wlc0NjVPazY1K3M2ckNBSUdOc1lYVmtaVk4wWVhSMWN6MG5iMnNuNjZHY0lPdVFtT3VQak91bXJPdXZnT3VobkN3ZzdKNnM2NkdjNnJlNDdKMjRJTzJiaENEcnNvVHRpcnpzbmJRZzdLQ0E3S0NJNjZHYw0KSVBDZm42THNuTHpyb1p3ZzY3TzE2cmVBN1pXYzY0dWtMZ292THlBbzdaU002NStzNnJlNDdKMjQ3SjIwSU91aG5PcTN1T3lkdUNEc3NMM3NuWVFnN0pld0lPdVNwQ0Rzbzd6cXVMRHNvSUhzbkx6cm9ad2dMMmhsWVd4MGFPdWx2Q0Rzb2JEdG1venRsWmpyaXBRZzZyS0Q2ck84SU95bm5leWRoQ0RzbmJUcm82enJpNlFwQ2k4dklPMlZuT3VQaENEc3RJanFzN3pyajRRZzZyQ1o3SjJBSU9xeXZldWhuT3VobkNEcnM3WHF0NERzaTV6dGdxanJpNlFnNG9DVUlPcTBnT3Vtck95ZWtPcXdnQ0R0bFp6cmo0VHJwYndnN0ppczY2Q2s3S084NnJHdzY0S1lJTzJWbk91UGhPcXdnQ0RzdElqcXVMRHRtWlRya0pqcnFiUUtMeThnN0lLczdKcXA3SjZRNnJDQUlPeVZoT3VzdE9xeWcrdVBoQ0RzbFlnZzY0aU02NStzNjQrRUlPdXloTzJLdk95ZHRDRHduNStpN0p5ODY2R2NJT3VQak95VmhPeVlxT3VMcEM0ZzdaV2M2NCtFN0plUUlPcXh1T3Vtc0NEdG1ManN0cHpzbllBZzZyR3c3S0NJNjVDWTY2K0E2NkdjSU95Q3JPeWENCnFldWZpZXlkZ0NEc2xZZ2c2NEtZNnJDRTY0dWtDaTh2SU9xemhPeWdsZXlkdENBcUt1dXdsdXlYa095RW5Db3FJT3V3bE91QWtDRHFzb1BzbllRZzdKV003SldFN0xHSTY0dWtJQ2d5TURJMkxUQTRMQ0JDVWtsRVIwVmZWajB5TmlrdUNpOHZJTzJFc091dnVPdUVrT3lkdE91Q21DRHJ1SXpybmJ6c21yRHNvSURzbDVEc2hKd2c2NHVrNjZXNElPcXpoT3lnbGV5Y3ZPdWhuQ0Ryb1p6cXQ3anNuYmp0bFpqcnFiUWc3SjZRNnJLcDdLYWQ2NnFGSU8yTWpPeWR2T3lkZ0NEcnNKVHJnSXpzcDREcnA0d3NJT3lkdE91dnVDRHJscUFnN0o2STY0cVVJR05zWVhWa1pRb3ZMeURzaExqc2haanNuWUFnN0l1YzY0K1o3WldnSU91VmpDRHJzSnZzbllBZzdKaWJJT3F6aE95Z2xTRHNub1hzbnFYcXRvenNuWVFnNnJlNDY0eUE2NkdjSU95VHRPdUxwQ0RpaHBJZzdJT0lJT3F6aE95Z2xleVhrQ0RzZ3F6c21xbnJuNG5zbmJRZzY0S283SldFSU95ZWlPeVd0T3VQaENBaTdaV2M2NCtFSU95MGlPcXp2Q0xxc0lBS0x5OGc2ck9FDQo3SWFOSU91Q21PeVlxT3VMcENneU1ESTJMVEE0SU95THBPeTRvU0RzaTZEcXM2QTZJQ0xzZzRnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJXaU91S2xPdU5zQ0RzbVp3ZzZyZTRJT3F6aE95Z2xTRHNncXpzbXFucm40bnNuWVFnNjZxN0lPeVRzT3VEa0NJcExnb3ZMeUR0bEl6cm42enF0N2pzbmJqc25ZUWc2ckd3N0xtY0lPdWhuT3EzdU95ZHVNSzM2NkdjNnJlNDdKV0U3SnVES0M5dmNHVnVMV3h2WjJsdXdyY3ZZMnhoZFdSbExXeHZaMjkxZENuc25ZQWdhMmxzYkZCeWIyUHNuTHpyb1p3ZzdJUzQ3SVdZN0oyRUlPdXloT3VncE95RW5DRHNuYlFnNjZ5NDdLQ2M2ckNBQ2k4dklPeVhodXlYaU91S2xPdU5zQ3dnNjdDVzdKZVE3SVNjSU91d2xPcSt1T3VwdENEcmk2VHJwcXpxc0lBZzdKV01JT3V3cWV1eWxleWR0Q0RzbDRic2w0anJpNlF1SU9xM3VPdWVtT3lFbkNBdmFHVmhiSFJvSU95aHNPMmFqT3VuaU91THBDRHRqSXpzbmJ6c25aZ2c2ck9FN0tDVjZyTzhJT3U1aE9xMWtPMlZuT3VMcEM0Sw0KTHk4ZzY3bUU3SnFwSURBbzdZeU03SjI4NjZlTUlPeWR2ZXF6b0N3Z1kyeGhkV1JsUVdOamIzVnVkT3lkbUNBek1PeTBpQ0RzdXBEc2k1enJwYndnNnJlNDY0eUE2NkdjSU95VHRPdUxwQ0RpZ0pRZ0xtTnNZWFZrWlM1cWMyOXU3SjIwSU95N3BPeUVuQ0RycDZUcnNvZ2c3SjI5N0tlQUlPeVZpdXVLbE91THBDa3VDaTh2SU9xemhPeWdsU0Rzbm9qc25Zd2c0b2FTSU95WGh1eWRqQ2pyb1p6cXQ3anNsWVRzbTRNcElPdXdxZTJXcGV5ZGdDRHFzYlRyazV6cnBxenNwNEFnN0pXSzY0cVU2NHVrT2lEdGpJenNuYnpzbllRZzY0MnU3SmEwN0pPdzY0cVVJT3lJbk9xd2hDRHNucURxdVpBZzY2cTdJT3lkdmV1S2xDRHFzb1Bxczd3S0x5OGc2cldzNjdhRTY1Q1k3S2VBSU95Vml1eVZoQ0R0bDVzZzdKNnM3SXVjN0o2UjdKMkVJT3UyZ091bHRPcXpvQ3dnNnJlNElPdXdxZTJXcGV5ZGdDRHNuYmpzcHAwZzdKaWs2NldZSU9xeXZldWhuQ2hwYzBGMWRHaEZjbkp2Y2lucXNJQWc3SjIwNjYrNElPeXltT3Vtck8yVm5PdUwNCnBDNEtablZ1WTNScGIyNGdjbVZ6ZEdGeWRFbG1RV05qYjNWdWRFTm9ZVzVuWldRb0tTQjdDaUFnYVdZZ0tDRndjbTlqSUh4OElIZGhhWFJsY2lrZ2NtVjBkWEp1T3lBZ0lDQWdJQ0FnSUM4dklPeUV1T3lGbUNEc2w0YnNuWXdvNjR1azdKMk1JTzJFdE95ZHRDRHNnNGpyb1p3ZzdJdWM2NCtaS1NBdklPMkV0Q0RzcDRUdGxva2c3S1NSN0oyMDY2bTBJT3VMcE95ZGpDRHNvYkR0bW96c2w1RHNoSndLSUNCamIyNXpkQ0J1YjNjZ1BTQmpiR0YxWkdWQlkyTnZkVzUwS0NrN0NpQWdhV1lnS0NGdWIzY2dmSHdnYm05M0lEMDlQU0J6WlhOemFXOXVRV05qYjNWdWRDa2djbVYwZFhKdU93b2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcXM0VHNvSlhzbmJRZzY3Q1U2NENNN0plSTdKYTA3SnFVSUNnbklDc2dLSE5sYzNOcGIyNUJZMk52ZFc1MElIeDhJQ2ZzbDRic25Zd25LU0FySUNjZzRvYVNJQ2NnS3lCdWIzY2dLeUFuS1NEaWdKUWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuWVFnNjdLRTY2YXM2ck9nDQpJT3lEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NHVrN0l1Y0lPeUxuT3lla2UyVnFldUxpT3VMcEM0bktUc0tJQ0F2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NS0hKbFlYTnZiaURzcDREc29KVXBJT0tBbENCVFJWTlRTVTlPWDBSSlJVVHJvWndnNjRHZDY0SzA2Nm0wSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRxc0lBZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2YXc2NHVrQ2lBZ2EybHNiRkJ5YjJNb0orcXpoT3lnbGV5ZHRDRHJzSlRyZ0l6c2xyVHNoSndnN0lTNDdJV1k3SjJFSU95RGlPdWhuQ0RzaTV6c25wSHRsb2pzbHJUc21wUWc0b0NVSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcE93b2dJR05zWVhWa1pWTjBZWFIxY3lBOUlHNTFiR3c3SUM4dklPMlZuT3VQaE1LMzY2R2M2cmU0N0oyNElPeURnZTJEbk91S2xDRHFzNFRzb0pYcnA0anJpNlFnNjR1azY2VzA2NHVrSU9LQWxDRHNnNGdnNnJPRTdLQ1Y3Snk4NjZHY0lPdUxwT3lMbkNEdGpKRHNvSlh0bFpqcQ0Kc293S0lDQnpaWE56YVc5dVFXTmpiM1Z1ZENBOUlHNXZkenNLZlFvS2JHVjBJR3hoYzNSQmRYUm9VbVYwY25sQmRDQTlJREE3Q21aMWJtTjBhVzl1SUhKbGRISjVRWFYwYUVsbVRtVmxaR1ZrS0NrZ2V3b2dJR2xtSUNoamJHRjFaR1ZUZEdGMGRYTWdJVDA5SUNkamJHRjFaR1V0Ykc5bmIzVjBKeUFtSmlCamJHRjFaR1ZUZEdGMGRYTWdJVDA5SUNkamJHRjFaR1V0YkdsdGFYUW5LU0J5WlhSMWNtNDdDaUFnYVdZZ0tIZGhhWFJsY2lCOGZDQkVZWFJsTG01dmR5Z3BJQzBnYkdGemRFRjFkR2hTWlhSeWVVRjBJRHdnTXpBd01EQXBJSEpsZEhWeWJqc2dMeThnN0tlRTdaYUpJT3lra1NEdGhMUWc2N0NwN1pXMElPcTRpT3luZ0NBcklETXc3TFNJSU9xd2hPcXlxUW9nSUd4aGMzUkJkWFJvVW1WMGNubEJkQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEc25xenRtWlhzbmJnZzdJdWM2NCtFNG9DbUp5azdDaUFnY25WdVZIVnliaWdvS1NBOVBpQW4NCjY2R2M2cmU0N0oyNElPMlpsZXlkdU95YXFleWR0T3VMcEM0Z0lrOUxJdXVkdk9xem9PdW5qQ0RyaTdYdGxaanJuYnd1SnlrdWRHaGxiaWdLSUNBZ0lDZ3BJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25iZ2c3Wm1WN0oyNDY1Q29JT0tBbENEc29KWHNnNEVnN0lPQjdZT2M2NkdjSU91enRlcTNnQzRuS1N3S0lDQWdJQ2hsS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0pXRTdLZUJJT3Vobk9xM3VPeWR1Q0RzbFlnZzY1Q29PaWNzSUZOMGNtbHVaeWhsTG0xbGMzTmhaMlVwTG5Oc2FXTmxLREFzSURnd0tTa0tJQ0FwT3dwOUNnb3ZMeURzaTZUdGpLZ2c3SjJSNjR1MTdKMkVJT3lDck91ZWpPeWFxU0RzbFlqcmdyVHJvWndnNjdPQTdabVlJT0tBbENEc201RHNuYmdvNjZHYzZyZTQ3SjI0TCt5RXBPeTVtQ25zbmJRZzdZeU03SldGNjVDY0lPcXl2ZXlhc095WGxDRHF0N2dnN0pXSTY0SzA2Nlc4TENEc2xZVHJpNGpycWJRZzdLQ1I2NUdRN0phMEsreWJrT3VzDQp1T3lkaENEcnM3VHJncmpyaTZRS1puVnVZM1JwYjI0Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENCd2NtVm1hWGdwSUhzS0lDQnBaaUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQVDA5SUV4UFIwbE9YMGRWU1VSRktTQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ1RFOUhTVTVmUjFWSlJFVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiRzluYjNWMEp5QjlPd29nSUdsbUlDaGxJQ1ltSUdVdWJXVnpjMkZuWlNBOVBUMGdURWxOU1ZSZlIxVkpSRVVwSUhKbGRIVnliaUI3SUdWeWNtOXlPaUJNU1UxSlZGOUhWVWxFUlN3Z2NISnZZbXhsYlRvZ0oyTnNZWFZrWlMxc2FXMXBkQ2NnZlRzS0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25LU0I3Q2lBZ0lDQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ0oreWR0Q0JRUSt5WGtDQkRiR0YxWkdVZ1EyOWtaU2hqYkdGMVpHVXA2ckNBSU95RXBPeTVtT3VQdkNEc25vanNwNEFnN0pXSzdKV0U3SnFVSU9LQWxDRHNoS1RzdVpqdGxaanFzNkFnNjZHYw0KNnJlNDdKMjQ3WldjSU91U3BDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5MQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25JSDA3Q2lBZ2ZRb2dJSEpsZEhWeWJpQjdJR1Z5Y205eU9pQndjbVZtYVhnZ0t5QW9aU0FtSmlCbExtMWxjM05oWjJVZ1B5QmxMbTFsYzNOaFoyVWdPaUJUZEhKcGJtY29aU2twSUgwN0NuMEtDbVoxYm1OMGFXOXVJSEpsWVdSQ2IyUjVLSEpsY1NrZ2V3b2dJSEpsZEhWeWJpQnVaWGNnVUhKdmJXbHpaU2dvY21WemIyeDJaU2tnUFQ0Z2V3b2dJQ0FnYkdWMElHSnZaSGtnUFNBbkp6c0tJQ0FnSUhKbGNTNXZiaWduWkdGMFlTY3NJQ2hqS1NBOVBpQjdJR0p2WkhrZ0t6MGdZenNnZlNrN0NpQWdJQ0J5WlhFdWIyNG9KMlZ1WkNjc0lDZ3BJRDArSUhzS0lDQWdJQ0FnZEhKNUlIc2djbVZ6YjJ4MlpTaEtVMDlPTG5CaGNuTmxLR0p2WkhrcEtUc2dmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVnpiMngyWlNoN2ZTazdJSDBLSUNBZ0lIMHBPd29nSUgwcE93cDkNCkNncGpiMjV6ZENCRFQxSlRYMGhGUVVSRlVsTWdQU0I3Q2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVTl5YVdkcGJpYzZJQ2NxSnl3S0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxSVpXRmtaWEp6SnpvZ0owTnZiblJsYm5RdFZIbHdaU2NzQ24wN0NtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXdvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzS0lDQnlaWE11Wlc1a0tFcFRUMDR1YzNSeWFXNW5hV1o1S0c5aWFpa3BPd3A5Q2dwamIyNXpkQ0J6WlhKMlpYSWdQU0JvZEhSd0xtTnlaV0YwWlZObGNuWmxjaWhoDQpjM2x1WXlBb2NtVnhMQ0J5WlhNcElEMCtJSHNLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0owOVFWRWxQVGxNbktTQjdJSEpsY3k1M2NtbDBaVWhsWVdRb01qQTBMQ0JEVDFKVFgwaEZRVVJGVWxNcE95QnlaWFIxY200Z2NtVnpMbVZ1WkNncE95QjlDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkSFJWUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoYkhSb0p5a2dld29nSUNBZ2NtVnpkR0Z5ZEVsbVFXTmpiM1Z1ZEVOb1lXNW5aV1FvS1RzZ0x5OGc2N0NXN0plUTdJU2NJT3F6aE95Z2xleWRoQ0Ryc0pUcXY2anNuTHpycWJRZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2Nmk4N0tDQUlPdXloT3Vtc091THBDQW83SldFNjU2WUlPeWJqT3V3amV5WGhleWR0Q0RzbUpzZzZyT0U3S0NWN0p5ODY2R2NJT3VQak95bmdDRHNsWXJxc293cENpQWdJQ0J5WlhSeWVVRjFkR2hKWms1bFpXUmxaQ2dwT3lBdkx5RHJvWnpxdDdqc25iZ2c3WldFN0pxVUlPeURnZTJEbk91cHRDRHNucXp0bVpYcw0KbmJnZzdJdWM2NCtFSU9LQWxDRHNucXpyb1p6cXQ3anNuYmpzbmJRZzY0R2Q2NEtzN0p5ODY2bTBJT3VMcE95ZGpDRHNvYkR0bW96cnRvRHRoTEFnY0hKdllteGxiZXlkdENEdGtvRHJwckRyaTZRS0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0NpQWdJQ0FnSUc5ck9pQjBjblZsTENCbGJtZHBibVU2SUNkamJHRjFaR1VuTENCMk9pQkNVa2xFUjBWZlZpd2daR2x5T2lCZlgyUnBjbTVoYldVc0lDOHZJSGJDdDJScGNqb2c2cldzNjdLRTdLQ0VMK3lYaWV1YXNlMlZuQ0RzZ3F6cnM3anNuYlFnNjVhZ0lPeWVpT3VLbE95bmdDRHNwNFRyaTZqc21xa0tJQ0FnSUNBZ2JXOWtaV3c2SUdOMWNuSmxiblJOYjJSbGJDd2diVzlrWld4ek9pQkJURXhQVjBWRVgwMVBSRVZNVXl3Z1pYaGhiWEJzWlhNNklFVllRVTFRVEVWVExteGxibWQwYUN3Z1ozVnBaR1U2SUVkVlNVUkZMbXhsYm1kMGFDd2djbVZoWkhrNklIZGhjbTFsWkZWd0xBb2dJQ0FnSUNCd2NtOWliR1Z0T2lBb1kyeGhkV1JsVTNSaGRIVnoNCklEMDlQU0FuYjJzbklIeDhJR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdiblZzYkNrZ1B5QnVkV3hzSURvZ1kyeGhkV1JsVTNSaGRIVnpMQW9nSUNBZ0lDQmhZMk52ZFc1ME9pQmpiR0YxWkdWQlkyTnZkVzUwS0Nrc0NpQWdJQ0FnSUhObGNuWmxaRG9nYzNSaGRITXVjMlZ5ZG1Wa0xDQnNZWE4wUVhRNklITjBZWFJ6TG14aGMzUkJkQ3dnYkdGemRGUmxlSFE2SUhOMFlYUnpMbXhoYzNSVVpYaDBMQ0JzWVhOMFUyVmpPaUJ6ZEdGMGN5NXNZWE4wVTJWakxBb2dJQ0FnZlNrN0NpQWdmUW9nSUM4dklPMlVqT3Vmck9xM3VPeWR1Q0RzaTZ6c25xWHJzSlhyajVrZzRvQ1VJT3VCaXVxNHNPdXB0Q0RzbklRZzZyQ1E3SXVjSU8yRGdPeWR0T3VvdU9xd2dDRHJpNlRycHF6cnBid2c2NEdJNjR1a0NpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyaGxZWEowWW1WaGRDY3BJSHNLSUNBZ0lHeGhjM1JDWldGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lISmxkSFZ5DQpiaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxJSDBwT3dvZ0lIMEtJQ0F2THlEcm9aenF0N2pzbmJnZzRvQ1VJTzJVak91ZnJPcTN1T3lkdU95ZG1DQmI4Sitmb0NEdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0oyNElPMlZoT3lhbEYzQ3QxdnduNVNSWFNEcnNvVHRpcnpzbmJRZzdaaTQ3TGFjN1pXYzY0dWtMZ29nSUM4dklPcTRzT3V6dUNqcnVJenJuYnpzbXJEc29JQWc3S2VCN1phSktUb2dZR05zWVhWa1pTQmhkWFJvSUd4dloybHVJQzB0WTJ4aGRXUmxZV2xnNjZXOElPeUlxT3lkZ0NEdGxJVHJvWnpzaExqc2lxVHJvWndnN0l1azdaYUpJT0tBbENEcnFaVHJpYlFnN0plRzdKMjBJT3F6cCt5ZXBTRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA2ck9nTEFvZ0lDOHZJQ0FnYkc5allXeG9iM04wSU95SW1PeUxvQ0R0ajZ6dGlyanJvWndnNnJLdzZyTzg2Nlc4SU95ZWtPdVBtU0RzaUpqcm9MbnRsWnpyaTZRbzdJdWs3TGloT2lEdGw2VHJrNXpycHF6c2lxVHNsNURzaEp6cmo0UWc2N2lNNjUyOA0KN0pxdzdLQ0FJT3lYdE91bXZDQXJJRXhKVTFSRlRpRHRtWlhzbmJnc0lESXdNall0TURjcExnb2dJQzh2SUNBZzdZU3c2Nis0NjRTUTdKMjBJTzJabE91cHRPeVhrQ0Rzb0lUdG1JQWc3SldJSU91Y3JPdUxwQzRnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVPdW5qQ0R0bFpqcnFiUWc2NEdkTGdvZ0lDOHZJTzJQdE91d3NTanRoTERycjdqcmhKQXBPaURzbnBEcmo1a2c3Sm1FNjZPTTZyQ0FJT3VuaWUyZWpDRHRtWmpxc3IwbzY3aU02NTI4N0pxdzdLQ0E2ckNBSUd4dlkyRnNhRzl6ZE95WGtDRHJxcnNnNjR1LzdKV0VJT3k5bE91VG5PcXdnQ0RyczdUc25iVHJpcFFnNnJLOTdKcXdLZXlYa095RW5Bb2dJQzh2SUNBZzY2R2M2cmU0N0oyNElPdU1nT3E0c0NEc3BKRWc2N0tFN1lxODdKMkVJT3VZa0NEcmlJVHJwYlRycWJRc0lPeTlsT3VUbk91bHZDRHJ0cG5zbDZ6cmhLUHNuWVFnN0lpWUlPeWVpT3VLbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJT3lnaE8yWm1PMlZuT3VMcEM0S0lDQnANClppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YjNCbGJpMXNiMmRwYmljcElIc0tJQ0FnSUdOdmJuTjBJR0p2WkhrZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ1kyOXVjM1FnYzNkcGRHTm9UVzlrWlNBOUlDRWhLR0p2WkhrZ0ppWWdZbTlrZVM1emQybDBZMmhCWTJOdmRXNTBLVHNnTHk4ZzZyT0U3S0NWSU95Z2hPMlptQ0E5SU95TG5PMkJyT3VtdnlEc3NMM3NuTHpyb1p3ZzdKZTA3SmEwSU9xemhPeWdsZXlkaENEcXM2RHJwYndnN0lpWUlPeWVpT3F5akFvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnTHk4Z1kyeGhkV1JsNnJDQUlPeVhodXljdk91cHRDRHNsNnpxdUxEc2hKd2c2NEdLNjRxVTY0dWtMaUJ6YUdWc2JEcDBjblZsNjUyOElHTnNZWFZrWmVxd2dDRHNsNGJzbHJUcmo0UWc3SVc0N0oyQUlPeWdsZXlEZ1NEc2k2VHRsb25yajd3S0lDQWdJQ0FnTHk4Z2MzQmhkMjdzblpnZ0oyVnljbTl5Sitxd2dDRHNsWWdnNjV5bzZyT2dMQ0RzDQptSWpzb0lUc2w1UWc2cmU0NjR5QTY2R2NJRzlyT25SeWRXWHJwYndnNjQrTTY2Q2s3S1NzNjR1a0lPS0FsQW9nSUNBZ0lDQXZMeUR0bEl6cm42enF0N2pzbmJqc25ZQWdJdXU0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RzbDRqc2xyVHNtcFFpNjUyODZyT2dJTzJWbU91S2xPdU5zQ0RzaTZUc29KenJvWnpyaXBRZzdKV0U2NnkwNnJLRDY0K0VJT3lWaUNEcm5LanJpcFFnN0lPQjdZT2M2ckNBSU91UWtPdUxwQ2pzaTZUc29Kd2c3SXVnNnJPZ0tTNEtJQ0FnSUNBZ2FXWWdLR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdKMk5zWVhWa1pTMXRhWE56YVc1bkp5a2dld29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF4TENCN0NpQWdJQ0FnSUNBZ0lDQmxjbkp2Y2pvZ0oreWR0Q0JRUSt5WGtDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZzRvQ1VJTzJFc091dnVPdUVrT3lYa095RW5DQmpiR0YxWkdVZ0xTMTJaWEp6YVc5dUlPeWR0Q0Rya0pqcmlwVHNwNEFnN1ptVjdKMjQ3WlcwSU95ag0Kdk95RXVPeWFsQzRuTEFvZ0lDQWdJQ0FnSUNBZ2NISnZZbXhsYlRvZ0oyTnNZWFZrWlMxdGFYTnphVzVuSnl3S0lDQWdJQ0FnSUNCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNBdkx5RHNwNFR0bG9rZzdLU1I3SjI0NjQyd0lPdVlrQ0RyaUl6cm9JRHJpNlFnNG9DVUlPcTRpT3V3cVNnMk1PeTBpQ0RyZ3JRcElPdUxwT3lMbkNEcmlJVHJwYmdnNnJHMElDTHNzTDNzbllRZzY0dXI3SldZNjR1a0wrdXF1eURydEtUcmk2UWk3SmVRSU9xd2dPcTVqT3lhc091dmdPdWhuQ0RydUl6cm5ienNtckRzb0lEcm9ad2c3SjZzN0l1YzY0K0U3WldjNjR1a0xnb2dJQ0FnSUNBdkx5RHRsWnpzc0xnZzY1S2s3SmVRNjQrRUlPdVlrQ0RyaUlUcnBiVHJpcFFnNnJHMElPdTRqT3Vkdk95YXNPeWdnT3F3Z0NCc2IyTmhiR2h2YzNRZzdMMmM2N0N4N0plUUlPdXF1eURyaTcvc2xZUWc3SjZRNjQrWklPeVpoT3Vqak9xd2dDRHNsWWdnNjVDWTY0cVVJTzJabU9xeXZleWR2Q0RzaUpnZzdKNkk3Snk4NjR1SUNpQWdJQ0FnSUM4dklPcTMNCnVPdVZqT3VuakNEc3ZaVHJrNXpycGJ3ZzY3YVo3SmVzNjRTajdKMkVJT3lJbUNEc25vanJpcFFnN1lTdzY2KzQ2NFNRSU91d3FleUxuZXljdk91aG5DRHRqN1Ryc0xIdGxaenJpNlFnS091UmtDRHJzb2pzcDdnZzdZRzA2NmF0N0plUUlPMkVzT3V2dU91RWtPeWR0Q0R0aW9Ec2xyVHJncGpzbUtUcnFiUWc2NHU1N1ptcDdJcWs2NSs5NjR1a0tTNEtJQ0FnSUNBZ1kyOXVjM1FnYzNSaGJHVWdQU0JzYjJkcGJsQnliMk1nSmlZZ0tFUmhkR1V1Ym05M0tDa2dMU0JzYjJkcGJsTjBZWEowWldSQmRDQStJRFl3TURBd0tUc0tJQ0FnSUNBZ2FXWWdLR3h2WjJsdVVISnZZeUFtSmlCemRHRnNaU2tnZXdvZ0lDQWdJQ0FnSUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNLSUNBZ0lDQWdJQ0JwWmlBb0lXOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa3BJSHNLSUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeExDQjdJR1Z5Y205eU9pQW43SjIwSUU5VDdKZVE3SVNnSU95ZWtPdVBtZXljdk91aG5DRHJxcnNnDQo3SmUwN0phMDdKcVVJT0tBbENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJT3lMcE8yV2lTRHRtNFFnTDJ4dloybHVJTzJWdENEc283enNoTGpzbXBRdUp5QjlLVHNLSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJQ0FnTHk4ZzdKMlk2NCtFN0tDQklPeWloZXVqakNoeVpXRnpiMjRnN0tlQTdLQ1ZLU0RpZ0pRZzdLZUU3WmFKSU95a2tTRHRoTFRzbllRZ1UwVlRVMGxQVGw5RVNVVkU2NkdjSU91Qm5ldUN0T3VwdENEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1zT3VMcEFvZ0lDQWdJQ0FnSUd0cGJHeFFjbTlqS0Nmcm9aenF0N2pzbmJqc25ZUWc3S2VFN1phSjdaV1k2NHFVSU95a2tleWR0T3VkdkNEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJvWnpxdDdqc25iZ2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcE93b2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOQ0KSURBN0NpQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0R0ajdUcnNMRWc0b0NVSU8yRXNPdXZ1T3VFa0NEcnNLbnNpNTNzbkx6cm9ad2c3S0NFN1ptWUxpY3BPd29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQnRiMlJsT2lBbmRHVnliV2x1WVd3bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ0x5OGc3SldlN0lTZ0lPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmpzbmJRZzY0eUE2cml3SU95a2tleWR0T3VwdENEc29KSHFzNkFnN0lPSTY2R2NJT3lYc091THBDQW83TEM5N0oyRUlPdUxxK3lWbU9xeHNPdUNtQ0RyaTZUc2k1d2c2NGlFNjZXNElPcXl2ZXlhc0NrS0lDQWdJQ0FnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdJQ0F2THlCQ1VrOVhVMFZTNjRxVUlPcXh0T3VUbk91bXJPeW5nQ0RzbFlycmlwVHJpNlFnNG9DVUlFTk0NClNlcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNjZXOElPeW5nZXlna1NEc2w3RHJpNlFnS095Y2hDQW5RbEpQVjFORlVpRHFzSURyb1p6c3NZVHF1TERyaXBRZzdLQ2M2ckd3NjVDUTY0dWtKeURzbzd6c2hKMGc3TEM0NnJPZ0tRb2dJQ0FnSUNCamIyNXpkQ0JzYjJkcGJrVnVkaUE5SUVOTVFWVkVSVjlGVGxZN0NpQWdJQ0FnSUdOdmJuTjBJSFJvYVhOTWIyZHBiaUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSjJGMWRHZ25MQ0FuYkc5bmFXNG5MQ0FuTFMxamJHRjFaR1ZoYVNkZExDQjdDaUFnSUNBZ0lDQWdjMmhsYkd3NklIUnlkV1VzSUdWdWRqb2diRzluYVc1RmJuWXNJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVXNDaUFnSUNBZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzSUM4dklHdHBiR3hNYjJkcGJsQnliMlBzblpnZzZyZTQ2Nk81SUd0cGJHenNtcWtnS0d0cGJHeFFjbTlqNnJPOElPdVBtZXlkDQp2Q0R0aktqdGhMUXBDaUFnSUNBZ0lIMHBPd29nSUNBZ0lDQnNiMmRwYmxCeWIyTWdQU0IwYUdselRHOW5hVzQ3Q2lBZ0lDQWdJSFJvYVhOTWIyZHBiaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdsbUlDaHNiMmRwYmxCeWIyTWdQVDA5SUhSb2FYTk1iMmRwYmlrZ2JHOW5hVzVRY205aklEMGdiblZzYkRzZ2ZTazdDaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdJVDA5SUhSb2FYTk1iMmRwYmlrZ2NtVjBkWEp1T3dvZ0lDQWdJQ0FnSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnYVdZZ0tHeHZaMmx1VUhKdlkxUnBiV1Z5S1NCN0lHTnNaV0Z5VkdsdFpXOTFkQ2hzYjJkcGJsQnliMk5VYVcxbGNpazdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdiblZzYkRzZ2ZRb2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQzh2SU95RGlDRHFzNFRzb0pYc25id2c3SWlZSU95ZQ0KaU95Y3ZPdUxpQ0RyaTZUc25Zd2dMMmhsWVd4MGFDRHJsWXdnNjR1azdJdWNJT3lkdmVxNHNBb2dJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeWdpT3l3cUNEc29vWHJvNHdnS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93b2dJQ0FnSUNBZ0lDOHZJT3lDck91ZWpPeWR0Q0Ryb1p6cXQ3anNuYmp0bGFBZzdJdWM2ckNFNjQrRUlPeVhodXlkdENEcXM2ZnJzSlRyb1p3ZzdJdWs3WXlvNjZHY0lPdUJuZXVDck91THBDQTlJR05zWVhWa1plcXdnQ0RzbDRicXNiRHJncGdnN0l1azdaYUo3SjIwSU95VmlDRHJrSndnNnJLRExnb2dJQ0FnSUNBZ0lDOHZJT3lka2V1THRleWRnQ0RzbmJUcnI3Z2c2N08wNjRPSTdKeTg2NHVJSU95RGdlMkRuT3VsdkNEcmk2VHNpNXdnN0o2czdJU2NJQzlvWldGc2RHanJvWndnN0pXTTY2YXc2NHVrSUNqdGxJenJuNnpxdDdqc25ianNuYlFnNjR5QTZyaXdJTzJabE91cHRPeWRoQ0RzaTZUdGpLanINCm9ad2c2N0NVNnI2ODY0dWtLUzRLSUNBZ0lDQWdJQ0JwWmlBb1kyOWtaU0FoUFQwZ01DQW1KaUJFWVhSbExtNXZkeWdwSUMwZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUENBMU1EQXdLU0I3Q2lBZ0lDQWdJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjQ3SjIwSU95bWlleUxuQ0RzaTZUdGpLanJvWndnNjRHZDY0S29JT0tBbENCRGJHRjFaR1VnUTI5a1pTRHNoS1RzdVpnZzdJT0I3WU9jNjZXOElPdUxwT3lMbkNEc29KRHFzb0R0bGFucmk0anJpNlF1SnlrN0NpQWdJQ0FnSUNBZ0lDQmphR1ZqYTBOc1lYVmtaVUYyWVdsc1lXSnNaU2dwT3dvZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnZlNrN0NpQWdJQ0FnSUd4dloybHVVSEp2WTFScGJXVnlJRDBnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3SUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25iZ2dNVERydG9RZzZySzk2ck84SU9LQWxDRHJqSURxdUxBZzdaU0U2NkdjN0lTNDdJcWtJT3lnbGV1bXJDNG5LVHNnDQphMmxzYkV4dloybHVVSEp2WXlncE95QjlMQ0EyTURBd01EQXBPd29nSUNBZ0lDQXZMeURyZ3FIc25ZQWc3SjZGN0o2bDZyYU03SjJFSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NHlBNnJpd0lPeUV1T3lGbU95ZGdDRHJzb1RycHJEcmk2UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzZzRnZzdJUzQ3SVdZS095RGlDRHNub1hzbnFYcXRvd3A3Snk4NjZHY0lPeUxuT3lla2UyVm1PcXlqQzRLSUNBZ0lDQWdMeThnN0oyWTY0K0U3S0NCSU95aWhldWpqQ2h5WldGemIyNGc3S2VBN0tDVktTRGlnSlFnVTBWVFUwbFBUbDlFU1VWRTY2R2NJT3VCbmV1Q3RPdXB0Q0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91Z3BBb2dJQ0FnSUNBdkx5RHNucXpyb1p6cXQ3anNuYmdnNjVLazdKZVE2NCtFSUUxQldGOVVWVkpPVStxNWpPeW5nQ0RzbUpzZzZyT0U3S0NWN0p5ODY2R2NJT3l5bU91bXJPdVFtT3VLbENEcg0Kc29UcXQ3anFzSUFnNjVDYzY0dWtJQ2d5TURJMkxUQTNJT3Vtck91M3NPeVhrT3lFbkNEdG1aWHNuYmdwQ2lBZ0lDQWdJR3RwYkd4UWNtOWpLQ2Zyb1p6cXQ3anNuYmpzbllRZzdLZUU3WmFKN1pXWTY0cVVJT3lra2V5ZHRPdWR2Q0RzbXBUc3NxM3NuWVFnN0tTUjY0dW83WmFJN0phMDdKcVVJT0tBbENEcm9aenF0N2pzbmJnZzdadUVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMaWNwT3dvZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQU0F3T3dvZ0lDQWdJQ0F2THlCemQybDBZMmhOYjJSbDY0cVVJT3lkdE95Z25DRHJvWnpxdDdnZzY2eTQ2cldzd3Jmc25aSHJpN1VnYlc5a1pTRHRrWnpzaTV6c21xa2c0b0NVSUZWU1RPeWRnQ0Rya1pBZzZySzk3SnF3SU91cXFPdVJrQ0JEVEVucXNJQWc2cmU0NjR5QTY2R2NJT3lYc091THBDanNuSVFnUWxKUFYxTkZVaURzbzd6c2hKMHBDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RydUl6cm5ienNtckRzb0lBZzY2R2MNCjZyZTQ3SjI0SU95TG5PeWVrU2NnS3lBb2MzZHBkR05vVFc5a1pTQS9JQ2NnS09xemhPeWdsU0Rzb0lUdG1aZ2c0b0NVSU95S3VleWR1Q0R0bVpUcnFiVHNsNURzaEp3Z1crcXpoT3lnbFNEc29JVHRtWmhkN0oyRUlPdUloT3VsdE91cHRDRHJpNlRycGJnZzZyT0U3S0NWN0oyRUlPcXpvT3VsdkNEc2lKZ2c3SjZJN0phMDdKcVVLU2NnT2lBbkp5a2dLeUFuSU9LQWxDRHJvWnpxdDdqc25ianRsWmpycWJRZzdKNlE2NCtaSU95WHNPcXlzT3VRcWV1TGlPdUxwQzRuS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJRzF2WkdVNklITjNhWFJqYUUxdlpHVWdQeUFuWW5KdmQzTmxjaTF6ZDJsMFkyZ25JRG9nSjJKeWIzZHpaWEluSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJsY25KdmNqb2dKK3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc2NnE3SU95WHRPeVhpT3lXdE95YWxEb2dKeUFyDQpJR1V1YldWemMyRm5aU0I5S1RzS0lDQWdJSDBLSUNCOUNpQWdMeThnS08yRXNPdXZ1T3VFa0NEdGo3VHJzTEVnNnJXczdaaUU2N2FBSU9LQWxDRHJ1SXpybmJ6c21yRHNvSUFnN0o2UTY0K1pJT3laaE91ampPcXdnQ0RzbFlnZzY1Q1k2NHFVSU8yWm1PcXl2U0Rzb0lUc21xa3BDaUFnWm5WdVkzUnBiMjRnYjNCbGJreHZaMmx1VkdWeWJXbHVZV3dvS1NCN0NpQWdJQ0I3Q2lBZ0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdDaUFnSUNBZ0lDQWdMeThnYzNSaGNuVHFzSUFnN0lPSUlPeTltT3lHbENEc3NMM3NuWVFnNjZlTTY1T2c2NHVrSUNqcmk2VHJwcXpzblpnZzdJaW83SjJBSU95OW1PeUdsT3F6dkNEcnJMVHF0SUR0bFpqcXNvd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPdXp0T3llaENrdUNpQWdJQ0FnSUNBZ0x5OGc3SjIwN0phMDdJU2NJRkJ2ZDJWeVUyaGxiR3dvTG5Cek1TbnNuYlFnTmV5MGlDRHJrcVFnNnJlNElPeXd2ZXlYa0NEc2w1VHRoTERycGJ3Zw0KNjdPMDY0SzBJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbllRZzdKNlE2NCtaSU95RW9PMkRuZTJWbU9xem9Dd0tJQ0FnSUNBZ0lDQXZMeURzc0wzc25ZUWc3TFdjN0lhTTdabVU3WlcwSU95Q3JPeWFxZXlla0NEcmlJanNsNVFnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVPdW5qQ0RyZ3FqcXNvd2c3WldjNjR1a0xpRHNzTDNzbllRZzY2cTdJT3l3dnV5Y3ZPdXB0Q0RzbFlUcnJMVHFzb1ByajRRZzdKV0lJTzJWbk91THBBb2dJQ0FnSUNBZ0lDOHZJQ2pyaTZUcnBiZ2c3TEM5SU95WXBPeWVoZXVncFNEcnNLbnNwNEFnNG9DVUlPcTN1Q0Rxc3Izc21yQWc2Nm1VNjRtMDZyQ0FJT3V6dE95ZHRPdUtsQ0Rzc1lUcm9ad2c2NEtvNnJPZ0lPeUNyT3lhcWV5ZWtPcXdnQ0RzbDVUdGhMQWc3WldjSU91eWlDRHJpSVRycGJUcnFiUWc2NUNvS1M0S0lDQWdJQ0FnSUNBdkx5RHNvN3pzblpnNklHTnNZWFZrWmVxd2dDRHN2WmpzaHBRZzdLQ2M2NnFwN0oyRUlPdXdsT3ErdU91cHRDQkJjSEJCWTNScGRtRjANClpTOUdhVzVrVjJsdVpHOTM2ckNBSU91cXV5RHNzTDdzbllRZzdJaVlJT3llaU95ZGpDRGlnSlFnN0p5STY0K0U3SnF3SU95THBPcTRzT3lYa095RW5DRHRtWlhzbmJnZzdaV0U3SnFVTGdvZ0lDQWdJQ0FnSUdOdmJuTjBJSEJ6TVNBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRiRzluYVc0dWNITXhKeWs3Q2lBZ0lDQWdJQ0FnWm5NdWQzSnBkR1ZHYVd4bFUzbHVZeWh3Y3pFc0lGc0tJQ0FnSUNBZ0lDQWdJQ2RUZEdGeWRDMVRiR1ZsY0NBdFUyVmpiMjVrY3lBMUp5d0tJQ0FnSUNBZ0lDQWdJQ2NrZDNNZ1BTQk9aWGN0VDJKcVpXTjBJQzFEYjIxUFltcGxZM1FnVjFOamNtbHdkQzVUYUdWc2JDY3NDaUFnSUNBZ0lDQWdJQ0FpYVdZZ0tDUjNjeTVCY0hCQlkzUnBkbUYwWlNnblkyeGhkV1JsTFd4dloybHVKeWtwSUhzaUxBb2dJQ0FnSUNBZ0lDQWdJaUFnSkhkekxsTmxibVJMWlhsektDZCtKeWtpTEFvZ0lDQWdJQ0FnSUNBZ0p5QWdVM1JoY25RdFUyeGxaWEFnDQpMVk5sWTI5dVpITWdNaWNzQ2lBZ0lDQWdJQ0FnSUNBaUlDQkJaR1F0Vkhsd1pTQXRUbUZ0WlhOd1lXTmxJRlVnTFU1aGJXVWdWeUF0VFdWdFltVnlSR1ZtYVc1cGRHbHZiaUFuVzBSc2JFbHRjRzl5ZENoY0luVnpaWEl6TWk1a2JHeGNJaWxkSUhCMVlteHBZeUJ6ZEdGMGFXTWdaWGgwWlhKdUlGTjVjM1JsYlM1SmJuUlFkSElnUm1sdVpGZHBibVJ2ZHloemRISnBibWNnWXl3Z2MzUnlhVzVuSUhRcE95QmJSR3hzU1cxd2IzSjBLRndpZFhObGNqTXlMbVJzYkZ3aUtWMGdjSFZpYkdsaklITjBZWFJwWXlCbGVIUmxjbTRnWW05dmJDQlRhRzkzVjJsdVpHOTNLRk41YzNSbGJTNUpiblJRZEhJZ2FDd2dhVzUwSUc0cE95Y2lMQW9nSUNBZ0lDQWdJQ0FnSWlBZ0pHZ2dQU0JiVlM1WFhUbzZSbWx1WkZkcGJtUnZkeWhiVG5Wc2JGTjBjbWx1WjEwNk9sWmhiSFZsTENBblkyeGhkV1JsTFd4dloybHVKeWtpTEFvZ0lDQWdJQ0FnSUNBZ0p5QWdhV1lnS0NSb0lDMXVaU0JiVTNsemRHVnRMa2x1ZEZCMGNsMDZPbHBsY204cA0KSUhzZ1czWnZhV1JkVzFVdVYxMDZPbE5vYjNkWGFXNWtiM2NvSkdnc0lEWXBJSDBuTENBdkx5QTJJRDBnVTFkZlRVbE9TVTFKV2tVS0lDQWdJQ0FnSUNBZ0lDZDlKeXdLSUNBZ0lDQWdJQ0JkTG1wdmFXNG9KMXh5WEc0bktTQXJJQ2RjY2x4dUp5azdDaUFnSUNBZ0lDQWdZMjl1YzNRZ1ltRjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxc2IyZHBiaTVpWVhRbktUc0tJQ0FnSUNBZ0lDQm1jeTUzY21sMFpVWnBiR1ZUZVc1aktHSmhkQ3dnSjBCbFkyaHZJRzltWmx4eVhHNG5JQ3NLSUNBZ0lDQWdJQ0FnSUNkemRHRnlkQ0FpWTJ4aGRXUmxMV3h2WjJsdUlpQmpiV1FnTDJzZ1kyeGhkV1JsSUM5c2IyZHBibHh5WEc0bklDc0tJQ0FnSUNBZ0lDQWdJQ2R3YjNkbGNuTm9aV3hzSUMxT2IxQnliMlpwYkdVZ0xVVjRaV04xZEdsdmJsQnZiR2xqZVNCQ2VYQmhjM01nTFVacGJHVWdJaWNnS3lCd2N6RWdLeUFuSWx4eVhHNG5LVHNLSUNBZ0lDQWdJQ0J6Y0dGM2JpZ24NClkyMWtKeXdnV3ljdll5Y3NJR0poZEYwc0lIc2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbElIMHBPd29nSUNBZ0lDQjlJR1ZzYzJVZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNka1lYSjNhVzRuS1NCN0NpQWdJQ0FnSUNBZ0x5OGdjSFI1S0dWNGNHVmpkQ25yb1p3ZzY3TzA2NEs0SU8yQ3BPeVhrQ0R0Z2JUcm9aenJrNXdnVkZWSjZyQ0FJT3VzdE91d21PeWRrZXlkdUNEcXNvUHNuYlFnN0l1azdMaWhJTzJabGV5ZHVPdVFxQ2d5TURJMkxUQTNMQ0RzbmJ6cnNKZ2dYSExDdDJ0cGRIUjVJT3k5bE91VG5DRHJxcWpya1pBcElPS0FsQW9nSUNBZ0lDQWdJQzh2SU95Y29PeWR2TzJWbkNEc25wRHJqNW50bVpRZzZySzk2NkdjNjRxVUlGTjVjM1JsYlNCRmRtVnVkSFBzblpnZzdLZUU3S2VjSU8yQ3BDRHNub1hyb0tVdUlPeWdrZXEzdk95RXNTRHF0b3p0bFp6c25iUWc3SjZJN0p5ODY2bTBJRGJzdElnZzY1S2tJT3lYDQpsTzJFc09xd2dDRHNucERyajVrZzdKNkY2NkNsNjQrOENpQWdJQ0FnSUNBZ0x5OGdNZXV5aUNqcXRhenJqNFVnNnJPRTdLQ1ZLZXlkdENEc2hLRHRnNTNya0pqcXM2QXNJT3Eyak8yVm5PeWR0Q0RzbDRic25MenJxYlFnYTJWNWMzUnliMnRsSU95a2hPdW5qQ0Rzb2JEc21xbnRub2dnN0l1azdZeW83WlcwSU95Q3JPeWFxZXlla09xd2dDRHNsNVR0aExBZzdaV2NJT3V5aUNEcmlJVHJwYlRycWJRZzY1Q2M2NHVrS0daaGFXd3RjMjltZENrdUNpQWdJQ0FnSUNBZ0x5OGc3SmVVN1lTd0lPeW5nZXlnaE95WGtDQlVaWEp0YVc1aGJPeWRoQ0RyaTZUc2k1d2c3SldlN0p5ODY2R2NJT3F3Z095Z3VPeVpnQ0RyaTZUcnBiZ2c3Sld4N0plUUlPMkNwT3F3Z0NEcms2VHNsclRxc0lEcmlwUWc2cktEN0oyRUlPdW5pZXVLbE91THBDNEtJQ0FnSUNBZ0lDQnpjR0YzYmlnbmIzTmhjMk55YVhCMEp5d2dXd29nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbFJsY20xcGJtRnNJaUIwYnlCaw0KYnlCelkzSnBjSFFnSW1Oc1lYVmtaU0F2Ykc5bmFXNGlKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWhiQ0lnZEc4Z1lXTjBhWFpoZEdVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURZbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJoWTNScGRtRjBaU2NzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuWkdWc1lYa2dNQzR6Snl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVGVYTjBaVzBnUlhabGJuUnpJaUIwYnlCclpYbHpkSEp2YTJVZ2NtVjBkWEp1Snl3S0lDQWdJQ0FnSUNBZ0lDOHZJT3lYbE8yRXNPcXdnQ0RzaTZUc29KenJvWndnNjVPazdKYTA2ckNFSU9xeXZleWFzT3lYa091bmpDRHNsNnpxdUxBZzY0K0U2NHVzS09xMmpPMlZuQ0RzbDRic25MenJxYlFnN0p5RTdKZVE3SVNjSU95a2tldUxxQ2tnNG9DVUlPMkUNCnNPdXZ1T3VFa095ZGhDRHN1WmpzbTR3ZzY3aU02NTI4N0pxdzdLQ0E2NmVNSU91Q3FPcTR0T3VMcEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjJSbGJHRjVJREV1TlNjc0NpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBbmRHVnNiQ0JoY0hCc2FXTmhkR2x2YmlBaVZHVnliV2x1WVd3aUlIUnZJSE5sZENCdGFXNXBZWFIxY21sNlpXUWdiMllnWm5KdmJuUWdkMmx1Wkc5M0lIUnZJSFJ5ZFdVbkxBb2dJQ0FnSUNBZ0lGMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3dvZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJSEpsZEhWeWJpQm1ZV3h6WlRzZ0x5OGc3S2VBN0p1UUlPeVZpQ0R0bFpqcmlwUWdUMU1LSUNBZ0lDQWdmUW9nSUNBZ0lDQnlaWFIxY200Z2RISjFaVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRHJvWnpxdDdqc2xZVHNtNE1nNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0R0bVlqc25aZ2dXK3Vobk9xM3VPeVZoT3liZzEwZzY3S0U3WXE4N0oyMElPMll1T3kyDQpuQzRnWTJ4aGRXUmxJR0YxZEdnZ2JHOW5iM1YwN0p5ODY2R2NJRU5NU1NEcm9aenF0N2pzbmJqc25ZUWc3WlcwN0tDYzdaV2M2NHVrTGdvZ0lDOHZJQ2pzbmJRZ1VFUHNuWmdnN0tDQTdKNmw2NUNjSU95ZWtPcXlxZXltbmV1cWhleWRoQ0RzcDREc21yVHJpNlFnNG9DVUlPdUxwT3lMbkNEc2s3RHJvS1RycWJRZzdKNnM2NkdjNnJlNDdKMjRJTzJWaE95YWxDNHBJT3Vobk9xM3VPeVZoT3liZ3lEdG00VHNsNVFnN0lTNDdJV1l3cmZxczRUc29KWHN1cERzaTV6cnBid2c3S0NWNjZhczdaV2M2NHVrTGdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5amJHRjFaR1V0Ykc5bmIzVjBKeWtnZXdvZ0lDQWdZMjl1YzNRZ2JHOGdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjI5MWRDZGRMQ0I3SUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUVOTVFWVkVSVjlGVGxZc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbElIMHBPd29nSUNBZw0KYkdWMElHVnljaUE5SUNjbk93b2dJQ0FnYkc4dWMzUmtaWEp5TG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzZ1pYSnlJQ3M5SUdRdWRHOVRkSEpwYm1jb0tUc2dmU2s3Q2lBZ0lDQnNieTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXlCcWMyOXVLSEpsY3l3Z05UQXdMQ0I3SUc5ck9pQm1ZV3h6WlN3Z1pYSnliM0k2SUNmcm9aenF0N2pzbFlUc200TWc3SXVrN1phSklPeUxwTzJNcURvZ0p5QXJJR1V1YldWemMyRm5aU0I5S1RzZ2ZTazdDaUFnSUNCc2J5NXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdJQ0JyYVd4c1VISnZZeWduNjZHYzZyZTQ3SldFN0p1RDdaVzA3SVNjSU95YWxPeXlyZXlkaENEc3BKSHJpNmp0bG9qc2xyVHNtcFF1SnlrN0lDOHZJT3lkbU91UGhPeWdnU0Rzb29Ycm80d2c0b0NVSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRxc0lBZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91bXJPdXB0Q0RzbFlnZzY1Q29DaUFnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTcNCklDQWdJQ0FnSUNBdkx5RHJpNlRzbll3Z0wyRmpZMjkxYm5UQ3R5OW9aV0ZzZEdqc2w1RHNoSndnNnJPRTdLQ1Y3SjJFSU95RGlPdWhuQ2c5N0plRzdKMk03Snk4NjZHY0tTRHNuYjNxc293S0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdiblZzYkRzZ0lDQWdJQ0FnSUM4dklPeURnZTJEbkNEc25xenRqSkRzb0pVbzY0dWs3SjJNSU8yRXRPeVhrT3lFbkNEcnI3anJvWnpxdDdqc25iZ2c2ckNRN0tlQUtRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WUcwNjZHYzY1T2NJT3Vobk9xM3VPeVZoT3liZ3lBb1kyOWtaU0FuSUNzZ1kyOWtaU0FySUNjcEp5azdDaUFnSUNBZ0lHbG1JQ2h5WlhNdWFHVmhaR1Z5YzFObGJuUXBJSEpsZEhWeWJqc2dMeThnWlhKeWIzSWc3Wlc0NjVPazY1K3M2ckNBSU95ZHRPdXZ1Q0RzblpIcmk3WHRsb2pzbkx6cnFiUWc3S1NSNjdPMUlPdXdxZXluZ0FvZ0lDQWdJQ0JwWmlBb1kyOWtaU0E5UFQwZ01Da2dhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nDQpkSEoxWlNCOUtUc0tJQ0FnSUNBZ1pXeHpaU0JxYzI5dUtISmxjeXdnTlRBd0xDQjdJRzlyT2lCbVlXeHpaU3dnWlhKeWIzSTZJQ2hsY25JdWRISnBiU2dwTG5Oc2FXTmxLREFzSURFMU1Da3BJSHg4SUNnbjdLS0Y2Nk9NSU95OWxPdVRuQ0FuSUNzZ1kyOWtaU2tnZlNrN0NpQWdJQ0I5S1RzS0lDQWdJSEpsZEhWeWJqc0tJQ0I5Q2lBZ0x5OGc3SjZRNnJpd0lPeWloZXVqakNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SUZOVVQxQmZRbEpKUkVkRkwrMlZtTzJLdU91NWhPMkt1T3F3Z0NEdG1ManN0cHp0bFp6cmk2UWdLT3Vobk95N3JPeVhrT3lFbk91bmpDRHNvSkhxdDd3ZzZyQ0E2NHFsN1pXWTY0dUlJT3lWaU95Z2hDa0tJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjMmgxZEdSdmQyNG5LU0I3Q2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lpaGV1ag0KakNEc21wVHNzcTBnNjdDYjdKMk1JT0tBbENEcmk2VHJwcXpycGJ3ZzY0R1Y2NHVJNjR1a0xpY3BPd29nSUNBZ2MyaDFkSFJwYm1kRWIzZHVJRDBnZEhKMVpUc0tJQ0FnSUd0cGJHeFFjbTlqS0NrN0NpQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSEJ5YjJObGMzTXVaWGhwZENnd0tTd2dNakF3S1RzS0lDQWdJSEpsZEhWeWJqc0tJQ0I5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNKbFkyOXRiV1Z1WkNjcElIc0tJQ0FnSUdOdmJuTjBJSHNnZEdWNGRDd2diVzlrWld3c0lISnZiR1VnZlNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdDaUFnSUNCcFppQW9JWFJsZUhRZ2ZId2dJVk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2twSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW43TGFVN0xLYzY3Q2I3SjJFSU91c3VPcTFyT3F3Z0NEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmoNCmIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc3RwVHNzcHdnN0pxVTdMS3RPaWNzSUZOMGNtbHVaeWgwWlhoMEtTNXpiR2xqWlNnd0xDQTFNQ2t1Y21Wd2JHRmpaU2d2WEc0dlp5d2dKeUFuS1NBcklDZmlnS1luTENCeWIyeGxJRDhnSjFzbklDc2djbTlzWlNBcklDZGRKeUE2SUNjbkxDQnRiMlJsYkNBL0lDY282NnFvNjQyNE9pQW5JQ3NnYlc5a1pXd2dLeUFuS1NjZ09pQW5KeWs3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUTJ4aGRXUmxLRk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2tzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpWTjFaMmRsYzNScGIyNXpMQ0JtYjNKdFlYUkVaWE5qT2lBblczc2lkR1Y0ZENJNklDTHJyTGpxdGF3aUxDQWljbVZoYzI5dUlqb2dJdXlkdE95Y29DSjlMQ0F1TGk1ZEp5QjlMQ0J5YjJ4bEtUc0tJQ0FnSUNBZ1kyOXVjM1FnYzNWbloyVnpkR2x2DQpibk1nUFNCeUxuQmhjbk5sWkNCOGZDQmJYVHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNrZ2V3b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lnbk95VmlDQW5JQ3NnYzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUNzZ0orcXduQ0FvSnlBcklITmxZeUFySUNkektTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZw0KSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djM1ZuWjJWemRHbHZibk1zSUdWdVoybHVaVG9nSjJOc1lYVmtaU2NnZlNrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNpNlR0aktnNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEdG1ManN0cHdnN0l1azdZeW9PaUFuS1NrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SU8yVWhPdWdpT3llaE91emhDRHN0cFRzc3B3ZzRvQ1VJTzJWbkNEdG1aVHJxYlRzbllRZzdaV1k3SnlFSU8yVWhPdWdpT3llaENqc21JSHNsNjBwSU91THFPeWNoT3VobkNEcmdwanJpS0FnNjdDYjZyT2cNCkxDRHNtSUhzbDYzcnA0anJpNlFnNjVTdzY2R2NJT3VNZ095VmlPeWRoQ0RyZ3Jqcmk2UXVDaUFnTHk4ZzdKaUI3SmV0SU95SW1PdW5qTzJCdkNEc21wVHNzcTNzbllRZzdLcTg2ckNjN0tlQUlPeVZpdXVLbENEcXNvUHNuYlFnN1pXMTdJdXNJQ2pyaXBEcm9LVHNwNERxczZBZzdJS3M3SnFwNjUrSjY0K0VJT3EzdU91bmpPMkJ2Q0RyZ3BqcXNJVHJpNlFwTGdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5eVpXTnZiVzFsYm1RdFozSnZkWEJ6SnlrZ2V3b2dJQ0FnWTI5dWMzUWdleUJuY205MWNITXNJRzF2WkdWc0xDQnRiM0psSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ1kyOXVjM1FnYkdsemRDQTlJRUZ5Y21GNUxtbHpRWEp5WVhrb1ozSnZkWEJ6S1FvZ0lDQWdJQ0EvSUdkeWIzVndjd29nSUNBZ0lDQWdJQ0FnTG0xaGNDZ29aeWtnUFQ0Z0tIc0tJQ0FnSUNBZ0lDQWdJQ0FnYm1GdFpUb2dVM1J5YVc1bktDaG5JQ1ltDQpJR2N1Ym1GdFpTa2dmSHdnSnljcExuUnlhVzBvS1N3S0lDQWdJQ0FnSUNBZ0lDQWdkR1Y0ZEhNNklDaG5JQ1ltSUVGeWNtRjVMbWx6UVhKeVlYa29aeTUwWlhoMGN5a2dQeUJuTG5SbGVIUnpJRG9nVzEwcExtMWhjQ2dvZENrZ1BUNGdVM1J5YVc1bktIUWdmSHdnSnljcExuUnlhVzBvS1NrdVptbHNkR1Z5S0VKdmIyeGxZVzRwTEFvZ0lDQWdJQ0FnSUNBZ0lDQnliMnhsT2lBb1p5QW1KaUJuTG5KdmJHVXBJRDhnVTNSeWFXNW5LR2N1Y205c1pTa2dPaUIxYm1SbFptbHVaV1FzQ2lBZ0lDQWdJQ0FnSUNCOUtTa0tJQ0FnSUNBZ0lDQWdJQzVtYVd4MFpYSW9LR2NwSUQwK0lHY3VkR1Y0ZEhNdWJHVnVaM1JvS1FvZ0lDQWdJQ0E2SUZ0ZE93b2dJQ0FnYVdZZ0tHeHBjM1F1YkdWdVozUm9JRHdnTWlrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZzbUlIc2w2M3NuYlFnNjdhQTdLR3g3WldwNjR1STY0dWtMaWNnZlNrN0NpQWdJQ0JqYjI1emRDQnpkR0Z5ZEdWa0lEMGdSR0YwWlM1dQ0KYjNjb0tUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRsSVRyb0lqc25vVHJzNFFnN0xhVTdMS2NJT3lhbE95eXJUb2c3SmlCN0pldElDY2dLeUJzYVhOMExteGxibWQwYUNBcklDZnFzSnduSUNzZ0tHMXZjbVVnUHlBbklDanJqWlFnNjdDYjZyaXdLU2NnT2lBbkp5a3NJRzF2WkdWc0lEOGdKeWpycXFqcmpiZzZJQ2NnS3lCdGIyUmxiQ0FySUNjcEp5QTZJQ2NuS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSElnUFNCaGQyRnBkQ0JoYzJ0SGNtOTFjSE1vYkdsemRDd2diVzlrWld3c0lIc2djR0Z5YzJVNklIQmhjbk5sUjNKdmRYQnpMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5Sm5jbTkxY0hNaU9pQmJleUp1WVcxbElqb2dJdXlZZ2V5WHJTRHNuYlRycG9RaUxDQWljM1ZuWjJWemRHbHZibk1pT2lCYmV5SjBaWGgwSWpvZ0l1dU1nT3lWaUNJc0lDSnlaV0Z6YjI0aU9pQWk3SjIwN0p5Z0luMWRmVjE5SnlCOUxDQWhJVzF2Y21VcE93b2dJQ0FnSUNCamIyNXpkQ0J2ZFhRZ1BTQnkNCkxuQmhjbk5sWkRzS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3dvZ0lDQWdJQ0JwWmlBb0lXOTFkQ2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lIc2daWEp5YjNJNklDZnRnYlRyb1p6cms1d2c3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMlVoT3VnaU95ZWhPdXpoQ0Rzb0p6c2xZZ2dKeUFySUc5MWRDNXlaV1IxWTJVb0tHNHNJR2NwSUQwK0lHNGdLeUJuTG5OMVoyZGxjM1JwYjI1ekxteGxibWQwYUN3Z01Da2dLeUFuNnJDY0lDOGc3SmlCN0pldElDY2dLeUJ2ZFhRdWJHVnVaM1JvSUNzZ0orcXduQ0FvSnlBcklITmxZeUFySUNkektTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwDQpiMHh2WTJGc1pWUnBiV1ZUZEhKcGJtY29KMnR2TFV0U0p5azdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ0oxdnRsSVRyb0lqc25vVHJzNFJkSUNjZ0t5QlRkSEpwYm1jb0tHeHBjM1JiTUYwZ0ppWWdiR2x6ZEZzd1hTNTBaWGgwYzFzd1hTa2dmSHdnSnljcExuTnNhV05sS0RBc0lESTBLVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRk5sWXlBOUlITmxZenNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ1ozSnZkWEJ6T2lCdmRYUXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY2dmU2s3Q2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJVHJvSWpzbm9UcnM0UWc3TGFVN0xLY0lPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU8yWXVPeTJuQ0RzaTZUdGpLZzZJQ2NwS1RzSw0KSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc3WXlkN0plRklPeWFsT3lHak91emhDRHN0cFRzc3B3ZzRvQ1VJTzJWbkNEdGpKM3NsNFhzblpnZzZyV3M3SVN4N0pxVTdJYU1LT3lYcmUyVm9DdnJyTGpxdGF3cDY2VzhJTzJWbkNEcnNvanNsNUFnNjdDYjdKV0VJT3lYcmUyVm9PdXpoT3VobkNEcmk2VHJrNnpyaXBUcmk2UXVDaUFnTHk4ZzdKcVU3SWFNNjZXOElPMlZxT3E3bUNEcnM3VHJnclRzbGJ3ZzdZT0E3SjIwN1l1QTdKMjBJT3V6dU91c3VDRHJwNlhybmIzc25ZUWc3TEM0N0tHdzdaV2dJT3lJbUNEc25vanJpNlFvN0pxVTdJYU02N09FSU9xd25PdXpoQ0RzbXBUc3NxM3FzN3pzblpnZzdMQ283SjIwS1M0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0xYQnZjSFZ3SnlrZ2V3b2dJQ0FnWTI5dWMzUWdleUJsYkdWdFpXNTBjeXdnYlc5a1pXd3NJRzF2Y21VZ2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQmoNCmIyNXpkQ0JzYVhOMElEMGdRWEp5WVhrdWFYTkJjbkpoZVNobGJHVnRaVzUwY3lrZ1B5QmxiR1Z0Wlc1MGN5NW1hV3gwWlhJb0tHVXBJRDArSUdVZ0ppWWdVM1J5YVc1bktHVXVkR1Y0ZENCOGZDQW5KeWt1ZEhKcGJTZ3BLU0E2SUZ0ZE93b2dJQ0FnYVdZZ0tHeHBjM1F1YkdWdVozUm9JRHdnTWlrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2Z0akozc2w0VWc3SnFVN0lhTTZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNG5JSDBwT3dvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlkN0plRklPeTJsT3l5bkNEc21wVHNzcTA2SU95YWxPeUdqQ0FuSUNzZ2JHbHpkQzVzWlc1bmRHZ2dLeUFuNnJDY0p5QXJJQ2h0YjNKbElEOGdKeUFvNjQyVUlPdXdtK3E0c0NrbklEb2dKeWNwTENCdGIyUmxiQ0EvSUNjbzY2cW82NDI0T2lBbklDc2diVzlrWld3Z0t5QW5LU2NnT2lBbkp5azdDaUFnDQpJQ0IwY25rZ2V3b2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclVHOXdkWEFvYkdsemRDd2diVzlrWld3c0lIc2djR0Z5YzJVNklIQmhjbk5sVUc5d2RYQXNJR1p2Y20xaGRFUmxjMk02SUNkN0luTmxkSE1pT2lCYmV5SnlaV0Z6YjI0aU9pQWk2N0NwN1phbElPMlZuQ0Ryckxqc25xVWlMQ0FpWld4bGJXVnVkSE1pT2lCYmV5SnliMnhsSWpvZ0l1eVhyZTJWb0NJc0lDSjBaWGgwSWpvZ0l1dXN1T3ExckNKOUxDQXVMaTVkZlN3Z0xpNHVYWDBuSUgwc0lDRWhiVzl5WlNrN0NpQWdJQ0FnSUdOdmJuTjBJSE5sZEhNZ1BTQnlMbkJoY25ObFpEc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93b2dJQ0FnSUNCcFppQW9JWE5sZEhNcElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWQ0KN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRqSjNzbDRVZzdJUzQ3WXE0SUNjZ0t5QnpaWFJ6TG14bGJtZDBhQ0FySUNmcXNKd2dLQ2NnS3lCelpXTWdLeUFuY3lrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlDZGI3WXlkN0plRlhTQW5JQ3NnVTNSeWFXNW5LQ2hzYVhOMFd6QmRJQ1ltSUd4cGMzUmJNRjB1ZEdWNGRDa2dmSHdnSnljcExuTnNhV05sS0RBc0lESTBLVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRk5sWXlBOUlITmxZenNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2MyVjBjeXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2cNCktHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTW5leVhoU0RzaTZUdGpLZzZKeXdnWlM1dFpYTnpZV2RsS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdDaUFnSUNCOUNpQWdmUW9nSUM4dklPdU1nTzJabE8yWWxTRHJyTGpxdGF3ZzdLQ2M3SjZSSU9LQWxDRHNnNEh0bWFuc25ZUWc3SVNrNjZxRjdaV1k2Nm0wSU91c3VPcTFyT3VsdkNEcnA0enJrNlRzbHJUc3BJRHJpNlFnS095MmxPeXluT3F6dkNEcXNKbnNuWUFnN0lTNDdJV1lMQ0RyaklEdG1aVHJpcFFnNjZla0lPeWFsT3l5cmV5WGtDRHRoclhzcDdqcm9ad2c3SXVrNjZhOEtRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OWpiMjF3YjNObEp5a2dld29nSUNBZ1kyOXVjM1FnZXlCdFpYTnpZV2RsY3l3Z2JXOWtaV3dnDQpmU0E5SUdGM1lXbDBJSEpsWVdSQ2IyUjVLSEpsY1NrN0NpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ1FYSnlZWGt1YVhOQmNuSmhlU2h0WlhOellXZGxjeWtnUHlCdFpYTnpZV2RsY3k1bWFXeDBaWElvS0cwcElEMCtJRzBnSmlZZ1UzUnlhVzVuS0cwdWRHVjRkQ0I4ZkNBbkp5a3VkSEpwYlNncEtTQTZJRnRkT3dvZ0lDQWdhV1lnS0NGc2FYTjBMbXhsYm1kMGFDa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmcmpJRHRtWlFnNjRLMDdKcXA3SjIwSU91NWhPeVd0Q0Rzbm9qc2lyWHJpNGpyaTZRdUp5QjlLVHNLSUNBZ0lHTnZibk4wSUhOMFlYSjBaV1FnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnWTI5dWMzUWdiR0Z6ZEZWelpYSWdQU0JiTGk0dWJHbHpkRjB1Y21WMlpYSnpaU2dwTG1acGJtUW9LRzBwSUQwK0lHMHVjbTlzWlNBaFBUMGdKMkZ6YzJsemRHRnVkQ2NwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeWVrU0RyaklEdG1aUWc3SnFVN0xLdA0KT2ljc0lGTjBjbWx1Wnlnb2JHRnpkRlZ6WlhJZ0ppWWdiR0Z6ZEZWelpYSXVkR1Y0ZENrZ2ZId2dKeWNwTG5Oc2FXTmxLREFzSURVd0tTNXlaWEJzWVdObEtDOWNiaTluTENBbklDY3BJQ3NnSitLQXBpQW82NHlBN1ptVUlDY2dLeUJzYVhOMExteGxibWQwYUNBcklDZnFzSndwSnlrN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNBdkx5RHJqSUR0bVpUcXNJQWc2cmk0N0phMDdLZUE2Nm0wSU95MW5PcTN2Q0F4TXVxd25PdW5qQ0FvN1pTRTY2R3M3WlNFN1lxNElPMlByZXlqdkNEcnNLbnNwNEFwQ2lBZ0lDQWdJR052Ym5OMElISWdQU0JoZDJGcGRDQmhjMnREYjIxd2IzTmxLR3hwYzNRdWMyeHBZMlVvTFRFeUtTd2diVzlrWld3c0lIc2djR0Z5YzJVNklIQmhjbk5sUTI5dGNHOXpaU3dnWm05eWJXRjBSR1Z6WXpvZ0ozc2ljbVZ3YkhraU9pQWk2NHlBN1ptVUlPeWRrZXVMdFNEdGxaenJrWkFnNjZ5NDdKNmxJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2lMQ0FpY21WaGMyOXUNCklqb2dJdXlkdE95Y29DSjlMQ0F1TGk1ZGZTY2dmU2s3Q2lBZ0lDQWdJR052Ym5OMElHOTFkQ0E5SUhJdWNHRnljMlZrT3dvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBb0tFUmhkR1V1Ym05M0tDa2dMU0J6ZEdGeWRHVmtLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2s3Q2lBZ0lDQWdJR2xtSUNnaGIzVjBLU0I3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lIc2daWEp5YjNJNklDZnRnYlRyb1p6cms1d2c3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU95ZGtldUx0U0FvSnlBcklITmxZeUFySUNkekxDRHNvSnpzbFlnZ0p5QXJJRzkxZEM1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ0t5QW42ckNjS1NjcE93b2dJQ0FnSUNCemRHRjBjeTV6WlhKMlpXUXJLenNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRUYwSUQwZ2JtVjNJRVJoDQpkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnVTNSeWFXNW5LQ2hzWVhOMFZYTmxjaUFtSmlCc1lYTjBWWE5sY2k1MFpYaDBLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNekFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnlaWEJzZVRvZ2IzVjBMbkpsY0d4NUxDQnpkV2RuWlhOMGFXOXVjem9nYjNWMExuTjFaMmRsYzNScGIyNXpMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNg0KSUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzY3S0k3SmV0SU9LQWxDRHRsWnpxdGEzc2xyUWc0b2FVSU95WWdleVd0Q0RzbnBEcmo1a2dLT3kybE95eW5PcXp2Q0Rxc0puc25ZQWc3SVM0N0lXWUlPeUNyT3lhcVNrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmRISmhibk5zWVhSbEp5a2dld29nSUNBZ1kyOXVjM1FnZXlCMFpYaDBMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmcnNvanNsNjN0bGFBZzY2eTQ2cldzNnJDQUlPdTVoT3lXdENEc25vanNpclhyaTRqcmk2UXVKeUI5S1RzS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHMNCm1wVHNzcTA2Snl3Z1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRFV3S1M1eVpYQnNZV05sS0M5Y2JpOW5MQ0FuSUNjcElDc2dKK0tBcGljcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ1kyOXVjM1FnY2lBOUlHRjNZV2wwSUdGemExUnlZVzV6YkdGMFpTaFRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BMQ0J0YjJSbGJDd2dleUJ3WVhKelpUb2djR0Z5YzJWVWNtRnVjMnhoZEdVc0lHWnZjbTFoZEVSbGMyTTZJQ2Q3SW5SeVlXNXpiR0YwWldRaU9pQWk2N0tJN0pldDY2eTRJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKa2FYSmxZM1JwYjI0aU9pQWlhMi9paHBKbGJpRHJtSkRyaXBRZ1pXN2locEpyYnlKOUp5QjlLVHNLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY2k1d1lYSnpaV1E3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGdmRYUXBJSHNLSUNBZ0lDQWdJQ0J5DQpaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEcnNvanNsNjBnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N0tJN0pldElPeVpoT3VqakNBb0p5QXJJSE5sWXlBcklDZHpMQ0FuSUNzZ0tHOTFkQzVrYVhKbFkzUnBiMjRnZkh3Z0p6OG5LU0FySUNjcEp5azdDaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQlRkSEpwYm1jb2RHVjRkQ2t1YzJ4cFkyVW9NQ3dnTXpBcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUIwY21GdQ0KYzJ4aGRHVmtPaUJ2ZFhRdWRISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVPaUJ2ZFhRdVpHbHlaV04wYVc5dUxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdLSTdKZXRJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPdXlpT3lYclNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURRc0lIc2daWEp5YjNJNklDZE9iM1FnWm05MWJtUW5JSDBwT3dwOUtUc0tDaTh2SU95ZHRPdXZ1Q0RyaTZUcnBxenFzSUFnNjVhZ0lPeWVpT3VLbE91TnNDRHJtSkFnN0x5YzZyaXc2ckNBSU91VHBPeVd0T3lZcE91cHRDanNvSnpzaXFUc3NwZ2c3SjZRNjQrWklPeThuT3E0c0NEc3BKSHJzN1VnNjVPeEtTRHMNCm9iRHNtcW50bm9nZzdLS0Y2Nk9NSU9LQWxDRHJqNHpyalpnZzY0dWs2NmFzNjRxVUlPcTN1T3VNZ091aG5DRHNuS0RzcDRBS2MyVnlkbVZ5TG05dUtDZGxjbkp2Y2ljc0lDaGxLU0E5UGlCN0NpQWdhV1lnS0dVZ0ppWWdaUzVqYjJSbElEMDlQU0FuUlVGRVJGSkpUbFZUUlNjcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNuYlRycjdnZzdMeWM3S0M0SU95ZWlPeVd0T3lhbENqdGo2enRpcmdnSnlBcklGQlBVbFFnS3lBbklPeUNyT3lhcVNEc3BKRXBJT0tBbENEc25iUWc3SjI0N0lxazdZUzA3SXFrNjRxVUlPeWloZXVqak8yVnFldUxpT3VMcEM0bktUc0tJQ0FnSUhCeWIyTmxjM011WlhocGRDZ3dLVHNLSUNCOUNpQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95RW5PdXloQ0RzbUtUcnBaZzZKeXdnWlNBbUppQmxMbTFsYzNOaFoyVXBPd29nSUhCeWIyTmxjM011WlhocGRDZ3hLVHNLZlNrN0NpOHZJT3lXdE91V3BDRHFzcjNyb1p6cm9ad2c3S085NjVPZ0tPeUxyT3llDQpwZXV3bGV1UG1TRHJnWXJxdVlBc0lFTjBjbXdyUXl3Z0wzTm9kWFJrYjNkdUxDRHNtS1RycFpncElHTnNZWFZrWlNEc25wRHNpNTNzbllRZzY0S282cml3N0tlQUlPeVZpdXVLbE91THBBcHdjbTlqWlhOekxtOXVLQ2RsZUdsMEp5d2dLQ2tnUFQ0Z2V5QnJhV3hzVUhKdll5Z3BPeUJyYVd4c1RHOW5hVzVRY205aktDazdJSDBwT3dwd2NtOWpaWE56TG05dUtDZFRTVWRKVGxRbkxDQW9LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2twT3dwd2NtOWpaWE56TG05dUtDZFRTVWRVUlZKTkp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwS1RzS0NuTmxjblpsY2k1c2FYTjBaVzRvVUU5U1ZDd2dKekV5Tnk0d0xqQXVNU2NzSUNncElEMCtJSHNLSUNCamIyNXpiMnhsTG14dlp5Z240cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQQ0KNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FKeWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeUR0Z2JUcm9aenJrNXdnNjR1azY2YXNJT3k4bk95bmtDRGlnSlFnYUhSMGNEb3ZMMnh2WTJGc2FHOXpkRG9uSUNzZ1VFOVNWQ2s3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeURycXFqcmpiZzZJQ2NnS3lCRFRFRlZSRVZmVFU5RVJVd2dLeUFuSU1LM0lPeVlpT3lMbkNBbklDc2dSVmhCVFZCTVJWTXViR1Z1WjNSb0lDc2dKK3F4dENEc25xWHNzS2tuS1RzS0lDQmpiMjV6YjJ4bExteHZaeWduSU95ZHRDRHNzTDNzbllRZzdMeWM2NUdVSU91UG1leVZpQ0R0bEx6cXQ3anJwNGdnN1pTTTY1K3M2cmU0N0oyNDdKMjBJTzJCdE91aG5PdVRuT3VobkNEc3RwVHNzcHp0bGFucmk0anJpNlF1SnlrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSitLVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1UNCmdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0NjcE93b2dJR05vWldOclEyeGhkV1JsUVhaaGFXeGhZbXhsS0NrN0lDOHZJRU5zWVhWa1pTQkRiMlJsSU95Q3JPeWFxU0Rxc0lEcmlxVWc3SmVzNjdhQUlPeWdrT3F5Z0NBbzdaU002NStzNnJlNDdKMjRJT3lWaU91Q3RPeWFxU2tLSUNBdkx5RHJyN2pycHF3ZzdJdWM2NCtaSUNzZzdLZUE3SXVjNjZ5NElPeWp2T3llaFNEaWdKUWc3TEtySU95MmxPeXluT3UyZ08yRXNDRHJ1YURycGJUcXNvd0tJQ0JoYzJ0RGJHRjFaR1VvSit5YmpPdXdqZXlYaFRvZ0l1eWdnT3llcFNEcmtKanNsNGpzaXJYcmk0anJpNlFpSnlrdWRHaGxiaWdLSUNBZ0lDZ3BJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNtNHpyc0kzc2w0VWc3Sm1FNjZPTUlPS0FsQ0RzdHBUc3Nwd2c3S1NBNjdtRUlPdUJuUzRuS1N3S0lDQWdJQ2hsDQpLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SnVNNjdDTjdKZUZJT3lMcE8yTXFDQW83TEtySU95YWxPeXlyU0RybFl3ZzdKNnM3SXVjNjQrRUtUb25MQ0JsTG0xbGMzTmhaMlVwQ2lBZ0tUc0tmU2s3Q2k4dklFbFFkallnNjZPbzdaU0U2N0N4S0RvNk1TbnNsNURyajRRZzdaV282cnVZSU91VG8rdUtsT3VMcENEaWdKUWdiV0ZqVDFNZzY1T3g3SmVRN0lTY0lDZHNiMk5oYkdodmMzUW42ckNBSURvNk1ldWhuQ0RycUx6c29JQWc3WlcwN0lTZDY1Q1k2NHFVNjQyd0NpOHZJTzJVdk9xM3VPdW5pQ2hGYkdWamRISnZiaWtnWm1WMFkyanJpcFFnWTNWeWJPcXp2Q0RyaTZ6cnBxd2dTVkIyTk91aG5DRHNucERyajVrZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDd2dTVkIyTk91bmpDRHJrNlByalpnZzY0dWs2NmFzN0plUUlPeVhzT3F5c095ZHRDRHFzYkRydG9Ecmo3d0tMeThnN0xhVTdMS2N3cmZ0bDZ6c2lxVHNzclR0Z2F6cXNJQWc3S0d3N0pxcDdaNklJT3lMcE8yTXFPMldpT3VMcENqcw0KaTZUc3VLRWdNakF5Tmkwd055a3VJT3F3bWV5ZGdDRHNtcFRzc3EwZzdaVzQ2NU9rNjUrczY2VzhJRWxRZGpZZzY2T283WlNFNjdDeDdKZVE2NCtFSU95V3VldUtsT3VMcEM0S1kyOXVjM1FnYzJWeWRtVnlOaUE5SUdoMGRIQXVZM0psWVhSbFUyVnlkbVZ5S0hObGNuWmxjaTVzYVhOMFpXNWxjbk1vSjNKbGNYVmxjM1FuS1Zzd1hTazdDbk5sY25abGNqWXViMjRvSjJWeWNtOXlKeXdnS0dVcElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCSlVIWTJLRG82TVNrZzY2YXM3SXFvSU95RG5ldWV0U0RpZ0pRZ1NWQjJOT3VuakNEc2dxenNtcWs2Snl3Z1pTQW1KaUJsTG0xbGMzTmhaMlVwS1RzS2MyVnlkbVZ5Tmk1c2FYTjBaVzRvVUU5U1ZDd2dKem82TVNjcE93bz0NCjo6RVhBTVBMRVM6Og0KSXlEcnJManF0YXdnN0xhVTdMS2NJT3lZaU95TG5Bb0tJdXVzdU9xMXJDRHN0cFRzc3B6cnNKdnF1TEFpNnJDQUlPeUNyT3lhcWUyVm1PdUtsQ0RzbUlqc2k1d2c2NnFvN0oyTTdKNkY2NHVJNjR1a0xpQXFLdXlkdENEdGpJenNuYnpzbllRZzdJaVk3S0NWN1pXY0lPdVNwQ0R0aExEcnI3anJoSkRzbDVEc2hKd2dZRzV3YlNCeWRXNGdZblZwYkdSZzY2VzhJT3lMcE8yV2llMlZtT3F6b0N3Z1JtbG5iV0hzbDVEc2hKd2c3WlNNNjUrczZyZTQ3SjI0N0oyRUlPdUxwT3lMbkNEc2k2VHRsb250bFpqcnFiUWc2N0NZN0ppQjY1Q3A2NHVJNjR1a0xpb3FDZ29qSXlEc25wSHNoTEVnNjdDcDY3S1ZDZ290SU95WWlPeUxuQ0R0bFpqcmdwanJpcFFnS2lwZ0l5TWpJT3lia091enVHQXFLaUR0bFp3ZzdLU0U2ck84TENEcXQ3Z2c3SldFNjU2WUlDb3FZQzBnN0xhVTdMS2M3SldJWUNvcUlPeVhyT3VmckNEcXNKenJvWndnN0oyMDY2U0U3S2VSNjR1STY0dWtMZ290SU95MmxPeXluT3lWaUNEc2xZanNsNURzaEp3Z0tpcnMNCnBJVHNuWVFnNjdDVTZyNjQ2ck9nSU95THR1eWN2T3VwdENCZ0lDOGdZQ0FvN0pXZTY1S2tJT3F6dGV1d3NTRHRqNnp0bGFnZzdJcXM2NTZZN0l1Y0tTb3FJT3VobkNEdGtaenNpNXp0bFpqc2hManNtcFF1SU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEcmtaQWc3S1NFNjZHY0lPdXp0T3lYck95bmtldUxpT3VMcEM0S0xTRHNncXpzbXFuc25wRHFzSUFnN0o2RjY2Q2w3WldjSU91c3VPcTFyT3F3Z0NCZzdKdVE2N080WU9xenZDQW82ck8xNjdDeHdyZnJyTGpzbnFYcnRvRHRtTGdnNjZ5MDdJdWM3WldZNnJPZ0tTRHFzSm5xc2JEcmdwZ3NJT3lFbk91aG5DRHRqNnp0bGFqdGxaanJxYlFnNnJlNElPeTJsT3l5bk95VmlPdVRwT3lkaENEcnM3VHNsNnpzcEkzcmk0anJpNlF1Q2kwZzY2ZWs3TG10N1pXZ0lPdVZqQ0FxS3V1bmlPeUtwTzJDdWV1UW5DRHNuYlRycG9RbzdabU5YQ3JyajVrcExDRHNpS3ZzbnBBbzdLQ0U3Wm1VNjdLSTdaaTR3cmNpN0ptNElETHJxb1VpSU91VHNTbnJpcFFnNjZ5MDdJdWNLaXJ0DQpsYW5yaTRqcmk2UWc0b0NVSU95ZHRPdW1oTUszN0lpWTY1K0p3cmZyc29qdG1ManJwNHdnNjR1azY2VzRJT3VzdU9xMXJPdVBoQ0Rxc0puc25ZQWc3SmlJN0l1YzY2R2NJT3llb2UyWWdPeWFsQzRnNjR1b0xDRHN0cFRzc3B6c2xZanNsNUFnN0tDQjdKYTA2NUdVSU95ZHRPdW1oTUszN0lpcjdKNlE2NHFVSU9xM3VPdU1nT3VobkNEcmdwanNtS1RyaTRnZzdJdWs3S0NjSU9xd2t1eVhrQ0RycDU3cXNvd2c2ck9nN0xPUUlPeVRzT3lFdU95YWxDNEtMU0Rzb0p6cnFxa29ZQ01qWUNucXM3d2dZQ01qSTJBc0lHQXRZQ0RxdUxEdG1ManJpcFFnN1ppVjdJdWQ3SjIwNjR1SUlPdXdsT3ErdU95bmdDRHJwNGpzaExqc21wUXVDZ29qSXlEc2lxVHRnNERzbmJ3ZzdKdVE3TG1aSUNqc3NManFzNkFnNG9DVUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZQWdkWGd0ZDNKcGRHbHVaeTV0WkNEcXNJRHNuYlRyazV3cENnb3RJTzJWdE95YWxPeXl0Q3dnNjdhQTY1T2M2NStzN0pxMElPeWloZXF5c0NoZ2Z1eWVpT3lXdE95YQ0KbEdBZ1lIN3JqN3pzbXBSZ0lHQis3SmVHN0phMDdKcVVZQ0JnZnUyVnRDRHNvN3pzaExqc21wUmdLUW90SURMcmk2Z2c2cldzN0tHd09pQXFLdXl5cXlEc3BJUTk3SU9CN1ptcElPeUVwT3VxaFNEaWhwSWc2NUdZN0tlNElPeWtoRDNyaTZUc25Zd2c3WmFKNjQrWktpb282ckt3N0tDVjdKMkFJR0IrN1pXZzZybU03SnFVUDJBc0lPMldpZXVQbVNEc25LRHJqNFRyaXBRZ1lIN3RsYlFnN0tPODdJUzQ3SnFVWUNrS0xTRHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdLT3VRa095V3RPeWFsT0tHa3UyV2lPeVd0T3lhbENrc0lPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQW83SmVHN0phMDdKcVU0b2FTZnUyVm1PdXB0Q0R0bGFBZzdJaVlJT3llaU95V3RPeWFsQ2tLTFNEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phMEtIN3NpNXpxc3FEc2xyVHNtcFEvNG9hU2Z1MlZvT3E1ak95YWxEOHBMQ0RycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQ2pzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjNG9hUzdKNlUNCjdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5Da0tMU0Rxc0lUcXNyRHRsWmpxczZBZzdJbXM3SnEwSU91bmtDQW83S0NFN0lhaDRvYVM2N08wNjRLMDY0dWtLU3dnNjdhQTdLQ1ZJT3lEZ2UyWnFldVBoQ0RybExIcmxMSHRsWmpzcDRBZzdKV0s2cktNS0NMc3NMN3F1TEFnN0l1azdZeW9JdUtkakNBaTdMQys3SjJFSU95SW1DRHNsNGJzbHJUc21wUWk0cHlGS1FvS0l5TWc3TGFVN0xLY0lPeVlpT3lMbkFvS0l5TWpJT3luaE8yV2llMlZtT3VObUNEc25wSHNsNFhzbmJRZzdKNkk3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0tlRTdaYUpJT3lra2V5ZHVDRHJnclRzbDYzc25iUWc3SjZJN0phMDdKcVVMaUF2SU95ZHRPeVd0T3lFbkNEc3A0VHRsb250bGFEcXVZenNtcFEvQ2dvakl5TWc2ck8xN0p5Z0lPeWFsT3l5cmV5ZGhDRHN0NmpzaG96dGxaanJxYlFnN0pxVTdMS3RJT3VDdE95WHJleWR0Q0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kzcU95R2pPMlZtT3lMDQpuT3F5b095S3RldUxpT3E1akQ4S0xTRHN0NmpzaG96dGxhQWc2cks5N0pxd0lPeWFsT3l5clNEcmdyVHNsNjNyajRRZzdJS3Q3S0NjNjQrODdKcVVMaUF2SU9xenRleWNvQ0RzbXBUc3NxM3NuWVFnN0xlbzdJYU03WldnNnJtTTdKcVVQd29LSXlNaklPcTRzT3E0c091bHZDRHNzTDdzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXWTdJUzQ3SnFVTGdvdElPcTRzT3E0c091bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaV1k2cml3SU95Z2hPeVhrT3VLbENEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQTdKNkY3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdLZUE2cmlJSU91eQ0KaE95Z2hPeVhrT3lFbk91S2xDRHNrN2dnN0lpWUlPeVhodXlXdE95YWxDNGc3SU9kN0xLMElPeWR1T3ltbmV5ZGhDRHNrN0Ryb0tUcnFiUWc3Sld4N0oyRUlPeTFuT3lMb0NEcnNvVHNvSVRzbkx6cm9ad2c3SmVGNjQydzdKMjA3WXE0SU8yVnRPeWp2T3lFdU95YWxDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMElPeWp2T3lFdU95YWxDNGdMeURzZzUzc3NyUWc3SjI0N0thZDdKMkVJT3lUc091Z3BPdXB0Q0RzdFp6c2k2QWc2N0tFN0tDRTdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0S0NpTWpJeURzbHJUcmxxUWc2NnFwN0tDQjdKeTg2NkdjSU91TWdPeTJuT3V3bSt5Y3ZPeUxuT3VDbU95YWxEOEtMU0RyaklEc3Rwd2c2NnFwN0tDQjdKMjBJT3VzdE95WGgreWR1T3F3Z095YWxEOEtDaU1qSXlEc2xyVHJscVFnN0oyMDdKeWc2NkdjSU95TG9PcXpvTzJWbU95TG5PdUNtT3lhbEQ4S0xTRHNpNkRxczZBZzdKMjA3SnlnNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKNlUNCjdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVQ2kwZzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMZ29LSXlNaklPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnN0ptNElETHJxb1hzbDVEcXNvd2c2cmFNN1pXY0lPeUNyZXlnbkNEc2xZenJwcnp0aHFIc25ZUWc3S0NFN0lhaDdaV2c2cm1NN0pxVVB3b3RJT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3RPdWdwT3F6b0NEdGxiVHNtcFF1SUM4ZzdabU5LdXVQbVNnd01UQXRNVEl6TkMwMU5qYzRLU0RyaTVnZzdKbTRJRExycW9Yc2w1RHFzb3dnNjdPMDY0Szg2cm1NN0pxVVB3b3RJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzY0dVlJT3ladUNBeTY2cUY3SmVRNnJLTUlPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdk9xNWpPeWFsRDhLTFNEcXRvenRsWndnDQo3SUt0N0tDY0lPeVZqT3Vtdk8yR29leWRoQ0R0bVkwcTY0K1pLREF4TUMweE1qTTBMVFUyTnpncElPdUxtQ0RzbWJnZ011dXFoZXlYa09xeWpDRHJzN1RyZ3J6cXVZenNtcFEvQ2dvakl5TWpJTzJabGV5ZHVNSzM2ckt3N0tDVklPMk1uZXlYaFFvS0l5TWpJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeUNyZXlnbk91UW5DRHJqYkRzbmJUdGhMRHJpcFFnNjdPMTZyV3M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHJrSmpyajR6cnByUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNvSlhycDVBZzdJS3Q3S0NjN1pXZzZybU03SnFVUHdvS0l5TWpJT3V6Z09xeXZleUNyTzJWcmV5ZHRDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdKV1k3SXExNjR1STY0dWtMaURyZ3BqcXNJRHNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SldFN0tlQklPeWdnT3llcGUyVm1PeW5nQ0RzbFlyc25ZQWc2NEswN0pxcDdKMjBJT3llaU95Vw0KdE95YWxDNGdMeURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1ak95YWxEOEtDaU1qSXlEcm9aenF0N2pzbFlUc200TWc3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU91aG5PcTN1T3lWaE95YmcrMlZvT3E1ak95YWxEOEtDaU1qSXlEc2xiSHNuWVFnN0tLRjY2T003WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU95VnNleWRoQ0Rzb29Ycm80enRsYURxdVl6c21wUS9DZ29qSXlNZzdaV2NJT3V5aUNEcnM0RHFzcjN0bFpqcnFiUWc2NHVrN0l1Y0lPdXpnT3F5dmUyVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc2NHVrN0l1Y0lPdXdsT3EvZ0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xemhPeUdqZTJWb09xNWpPeWFsRDhLQ2lNakl5RHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTBpT3E0c08yWmxPMlYNCm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmo3enNtcFF1SUM4ZzdMU0k2cml3N1ptVTdaV2c2cm1NN0pxVVB3b0tJeU1qSXlEc2w1RHJuNnpDdCt5THBPMk1xQW9LSXlNaklPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPdUVwTzJLdU95YmpPMkJyT3lYa0NEc2w3RHFzckR0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc2w3RHFzckFnN0lPQjdZT2M2Nlc4SU8yWmxleWR1TzJWbU9xem9DRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ienNpNXpzb0lIc25iZ2c3SmlrNjZXWTZyQ0FJT3V3bk95RG5lMldpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0RzbmJ6c2k1enNvSUhzDQpuYmdnN0ppazY2V1k2ckNBSU95RG5lcXl2T3lXdE95YWxDNGdMeURzbnFEc2k1d2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWaE95ZHRPdVVsQ0RybUpEcmlwUWc2N21FNjdDQTY3S0k3Wmk0NnJDQUlPeWR2T3k1bU8yVm1PeW5nQ0RzbFlyc2lyWHJpNGpyaTZRdUNpMGc3SldFN0oyMDY1U1VJT3VZa091S2xDRHJ1WVRyc0lEcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDNyc29qdG1ManFzSUFnN0oyODdMbVk3WldZN0tlQUlPeVZpdXlLdGV1TGlPdUxwQzRLTFNEc25ianNwcDNyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3kwaU9xenZPdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKMjQ3S2FkNjdLSQ0KN1ppNDY2VzhJT3llck91d25PeUdvZTJWbU95THJleUxuT3lZcEM0S0xTRHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeW5nT3VDck95V3RPeWFsQzRnTHlEc25ianNwcDNyc29qdG1ManJwYndnNjR1azdJdWNJT3V3bSt5VmhDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2xyVHNtcFF1SUM4ZzY0dWs2Nlc0SU9xeWdPeURpZXlXdE91aG5DRHJpNlRzaTV3ZzdMQys3SldFNjdPMDdJUzQ3SnFVTGdvS0l5TWpJT3lnbGV1enRPdWx2Q0RydG9qcm42enNtS1RzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rzb0pYcnM3VHJwYndnNjdhSTY1K3M3SmlzSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeUR0akl6c25id2cNCjdKZUY2NkdjNjVPYzdKZVFJT3lMcE8yTXFPMldpT3lLdGV1TGlPdUxwQzRLTFNEdGpJenNuYnpzbllRZzdKaXM2NmFzN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRnTHlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0tDUTZyS0FJT3lra2V5ZWhldUxpT3VMcEM0ZzdKMjA3SnFwN0plUUlPdTJpTzJPdU95ZGhDRHJrNXpyb0tRZzdLT0U3SWFoN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHNoSnpydVlUc2lxVHJwYndnN0tDUTZyS0E3WldZNnJPZ0lPeWVpT3lXdE95YWxDNGdMeURzb0pEcXNvRHNuYlFnNjRHZDY0S1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxZVHNpSmdnN0o2RjY2Q2xJTzJWcmV1cXFleWVoZXVMaU91THBDNEtMU0RxdkswZzdKNkY2NkNsN1pXMDdKVzhJTzJWbU91S2xDRHRsYTNycXFuc25iVHNsNURzbXBRdUNnb2pJeU1qSU9xMmpPMlZuTUszN0lTazdLQ1ZDZ29qDQpJeU1nN0xtMDY2bVU2NTI4SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdJcTE2NHVJNjR1a0xpRHNoS1Rzb0pYc2w1RHNoSndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU95THJleUxuT3lZcEM0S0xTRHN1YlRycVpUcm5id2c2cmFNN1pXYzdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0xtMDY2bVU2NTI4SU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmpPdW12Q0RxdG96dGxaenNuYlFnNnJHdzY3YUE2NUNZN0phMElPeVZqT3Vtdk95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHNsWXpycHJ3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PdXB0Q0RzaG96c2k1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUlDOGc3SVNrN0tDVjdKZVE3SVNjSU95VmpPdW12T3lkaENEc3ZKd2c3S084N0lTNDdKcVVMZ29LSXlNaklPeWNoT3k1bUNEc29KWHJzN1FnN0oyMDdKcXA3SmVRSU91UA0KbWV5ZG1PMlZtT3luZ0NEc2xZcnNsWVFnN0oyODY3YUFJT3E0c091S3BleWR0Q0Rzb0p6dGxaenJrS25yaTRqcmk2UXVDaTBnN0p5RTdMbVlJT3lnbGV1enRPdWx2Q0R0bDRqc21xbnRsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0p5RTdMbVlJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzbVlUcm80ekN0K3luaE8yV2lRb0tJeU1qSU95Z2dPeWVwZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Rzb0lEc25xWHRsb2pzbHJUc21wUXVDZ29qSXlNZzY3T0E2cks5N0lLczdaV3Q3SjIwSU95Z2dleWFxZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyczREcXNyMGc2NEswN0pxcDdKMkVJT3lnZ2V5YXFlMldpT3lXdE95YWxDNEtDaU1qSXlEc29JVHNocUhzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRPdURpT3lXdE95YWxDNEtDaU1qSXlEcms3SHINCm9aM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3VUc2V1aG5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1nN0lLdDdLQ2M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lDcmV5Z25PMldpT3lXdE95YWxDNEtDaU1qSXlEdGdiVHJwcjNyczdUcms1enNsNUFnNjdPMTdJS3M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dGV5Q3JPMldpT3lXdE95YWxDNEtDaU1qSXlEc21wVHNzcTNzbllRZzdMS1k2NmFzSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SnFVN0xLdDdKMkVJT3l5bU91bXJPMlZtT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3lWaU91Q3RNSzM3SnlnNjQrRUNnb2pJeU1nN0lPSTY2R2M3SnEwSU91eWhPeWdoT3lkdENEc3RwenNpNXpya0pqc2w0anNpclhyaTRqcmk2UXVJT3lYaGV1TnNPeWR0TzJLDQp1Q0R0bTRRZzdKMjA3SnFwSU9xd2dPdUtwZTJWcWV1TGlPdUxwQzRLTFNEc2c0Z2c2N0tFN0tDRTdKMjBJT3VDbU95WmxPeVd0T3lhbEM0Z0x5RHNsNFhyamJEc25iVHRpcmp0bFpqcnFiUWc3SU9JSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0oyMDdKcXA3SjJFSU95Y2hPMlZ0Q0RzbGIzcXRJQWc2NCtaN0oyWTZyQ0FJTzJWaE95YWxPMlZxZXVMaU91THBDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzaTV6c25wSHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25xWHNpNXpxc0lRZzY2KzQ3SUtzN0pxcDdKeTg2NkdjSU95ZWtPdVBtU0Ryb1p6cXQ3anNsWVRzbTRNZzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3lZcE91ZXErdVBtZXlWaUNEc2dxenNtcW50bFpqc3A0QWc3SldLN0pXRUlPdWhuT3EzdU95Vg0KaE95YmcrdVFrT3lXdE95YWxDNGdMeURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUc2xZanNuWVFnN0p5RTdaVzBJT3U1aE91d2dPdXlpTzJZdU91bHZDRHJzNERxc3IzdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHNsWWpzb0lUdGxad2c3SUtzN0pxcDdKMkVJT3ljaE8yVnRDRHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzY3Q1U2citVSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nNjdPMDdKV0lJT3lFbk91NWhPeUtwQW9LSXlNaklPcXl2ZXU1aE91bHZDRHFzSnpzaTV6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc2cks5NjdtRTY2VzhJT3lMbk95ZWtlMlZvT3E1ak95YWxEOEtDaU1qSXlEcXNyM3J1WVRycGJ3ZzdaVzA3S0NjN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPcXl2ZXU1aE91bHZDRHRsYlRzb0p6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJpdzZyaXc2ckNBSU95WXBPMlVoT3Vkdk95ZHVDRHNnNEh0ZzV6c25vWHINCmk0anJpNlF1SU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc25ZUWc3Wm1WN0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU9xNHNPcTRzT3F3Z0NEcmhLVHRpcmpzbTR6dGdhenNsNUFnN0pldzZyS3c2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyaXc2cml3N0oyWUlPeVhzT3F5c0NEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21JSHNnNEhzbllRZzY3YUk2NStzN0ppazY0cVVJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKaUI3SU9CN0oyRUlPdTJpT3Vmck95WXBPcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95M3FPeUdqTzJWbU95THBDRHFzcjNzbXJBZzdJdWc3TEt0N1pXWTdJdWdJT3VDDQp0T3lhcWV5ZGdDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdJcTE2NHVJNjR1a0xnb3RJT3kzcU95R2pPMlZtT3VwdENEc2k2RHNzcTN0bFp3ZzY0SzA3SnFwN0oyMElPeWdnT3llcGV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvQ2kwZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvSUM4ZzdMZW83SWFNN1pXWTY2bTBJT3llaGV1Z3BlMlZuQ0RyZ3JUc21xbnNuYlFnN0lLczY1Mjg3S0M0N0pxVUxnb0tJeU1qSXlEcXNJRHNuYlRyazV3ZzdKaUk3SXVjSUNoMWVDMTNjbWwwYVc1bkxtMWs3SmVRN0lTY0lPeVlydXE1Z0NEaWdKUWc2cmVjN0xtWjdKeTg2NkdjSU95ZWtPdVBtZTJabENEcnFyc2c3WldZNjRxVUlPdXN1T3llcFNEc25xenF0YXpzaExFZzdJS3M2NkdBS1FvS0l5TWpJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxczZBZzZyT0U3SXVjNjRLWTdKcVVQd290SU95ZWtPdVBtZXl3cU9xdw0KZ0NEc25vanJncGpzbXBRL0Nnb2pJeU1nNjZlazY0dXNJT3V6dE8yWG1PdWpqT3VsdkNEc2xyenJwNGpzbEtrZzY0SzA2ck9nSU9xemhPeUxuT3VDbU95YWxEOEtMU0RycDZUcmk2d2c2N08wN1plWTY2T002NHFVSU95V3ZPdW5pT3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2NnNnJDQTdLZUFJT3VMcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUNpMGc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFISU9xd2dPeW5nQ0RyaTZUc2k1d2c3Wm1WN0oyNDdaV2c2cktNN0pxVUxnb0tJeU1qSU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bFpqc2k1enFzcURzbHJUc21wUS9DaTBnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWb09xNWpPeWFsRDhLQ2lNakl5RHNpNXpzbnBIdGxaanNpNXpyaXBRZzY3YUU3SmVRNnJLTUlEVXNNREF3N0p1UTdKMkVJT3VUbk91Z3BPeWFsQzRLTFNEc2k1enNucEh0bFpqcnFiUWdOU3d3TUREc201RHMNCm5ZUWc2NU9jNjZDazdKcVVMZ29LSXlNaklPeWR0T3lla0NEdG1aanJ0b2pzbllRZzY3Q2I3SldZN0phMDdKcVVMZ290SU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRdUNnb2pJeU1nN0ppazY0cVk3SjJZSU8yQXRPeW1pT3F3Z0NEcXM2Y2c3S0tGNjZPTTY0Kzg3SnFVTGdvdElPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEM0S0NpTWpJeURxdUlqc25ienF1WXpzcDRBZzY2KzQ2NEtwSU95TG5DRHNsN0Rzc3JRZzdMS1k2NmFzNjVDcDY0dUk2NHVrTGlEdG00VHJ0b2pxc3JEc29Kd2c2cmlJN0pXaDdKMkVJT3VDcWV1MmdPMlZtT3lMbk9xNHNDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdKaWs2NHFZNnJtTTdLZUFJT3VDdE95bmdDRHNsWXJzbkx6cnFiUWc3SmV3N0xLMDY0Kzg3SnFVTGlBdklPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2tPcXlnQ0RxdUxEcXNJVHNsNURyaXBRZzdJU2M2N21FDQo3SXFrSU95ZHRPeWFxZXlkdENEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUxvT3UyaE95bW5TRHRtWlhzbmJnZzdLQ0U3SmVRNjRxVUlPeUdvZXE0aUNEcnNJOGc2ckt3N0tDYzZyQ0FJT3UyaU9xd2dPMlZxZXVMaU91THBDNEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPdXpnT3F5dlNEc2k1d2c3THFRN0l1YzY3Q3hJT3llck95bmdPcTRpZXlkZ0NEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNnNEhyaTdRZzdaS0k3S2VJSU8yV3BleURnZXlkaENEcw0KbklUdGxiUWc3WWExN1ptVUlPdUN0T3lhcWV5ZHRDRHJoYm5zbll6cmtLbnJpNGpyaTZRdUNpMGc2NDJVSU95aWkreWRnQ0RzZzRIcmk3VHNuWVFnN0p5RTdaVzBJTzJHdGUyWmxDRHJnclRzbXFuc25ZQWc2NFc1N0oyTTY0Kzg3SnFVTGdvS0l5TWpJT3F6b09xd25ldUxtT3lkbUNEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZGdDRHF1TERyb1owZzZyU0E2NmFzNjVDcDY0dUk2NHVrTGdvdElPeWR0T3lnbk91MmdPMkVzQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkdENEcXVMRHJvWjNyajd6c21wUXVDZ29qSXlNZzdMS3Q3SWFNNjRXRTdKMkFJT3lFbk91NWhPeUtwQ0Rxc0lEc25vWHNuYlFnNjdhSTZyQ0E3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc3NxM3Nob3pyaFlUc25ZUWc3SnlFN1pXY0lPeUVuT3U1aE95S3BPdUtsQ0RzbFlUc3A0RWc3S1NBNjdtRUlPeWtrZXlkdE95WGtPeWENCmxDNEtDaU1qSXlNZzZyT0U3S0NWd3Jmc25vWHJvS1VLQ2lNakl5RHNsWVRzbmJUcmxKUWc2NWlRNjRxVUlPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3lkdE95RGdTRHNucGpycXJzZzdKNkY2NkNsN1pXWTdKZXNJT3F6aE95Z2xleWR0Q0RzbnFEcXVJZ2c3TEtZNjZhczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3llbU91cXV5RHNub1hyb0tYdGxiVHNoSndnNnJPRTdLQ1Y3SjIwSU95ZW9PcXl2T3lXdE95YWxDNGdMeURydVlUcnNJRHJzb2p0bUxqcnBid2c3SjZzN0lTazdLQ1Y3WldZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNuYlRycjdnZzdJS3M3SnFwSU95a2tleWR1Q0RzbFlUc25iVHJsSlRzbm9Ycmk0anJpNlF1Q2kwZzdKMjA2Nis0SU95VHNPcXpvQ0Rzbm9qcmlwUWc3SldFN0oyMDY1U1U3SmlJN0pxVUxpQXZJT3VMcE91bHVDRHNsWVRzbmJUcmxKVHJwYndnN0o2RjY2Q2w3WlcwDQpJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNncXpzbXFudGxhQWc3SWlZSU95WGh1dUtsQ0RydVlUcnNJRHJzb2p0bUxqc25vWHJpNGpyaTZRdUlPeVlnZXVzdUN3ZzdJaXI3SjZRTENEdGlybnNpSmpyckxqc25wRHJwYndnN1krczdaV283WldZN0plc0lEanNucEFnN0oyMDdJT0JJT3llaGV1Z3BlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc21JSHJyTGdzSU95SXEreWVrQ3dnN1lxNTdJaVk2Nnk0N0o2UTY2VzhJTzJQck8yVnFPMlZ0Q0E0N0o2UUlPeWR0T3lEZ1NEc25vWHJvS1h0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95ZWhldWdwU0Rxc0lEcmlxWHRsWndnNnJpQTdKNlFJT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzdKNkY2NkNsN1pXZ0lPeUltQ0Rzbm9qcmlwUWc2cmlBN0o2UUlPeUltT3VsdkNEcmhKanNsNGpzbHJUc21wUXVJQzhnNjRLMDdKcXA3SjJFSU95aHNPcTRpQ0RzcElUc2w2d2c3S084N0lTNDdKcVVMZ29LSXlNakl5RHRqSXpzbmJ6Q3QrcXlzT3lnbk1LMw0KNnJpdzdZT0FDZ29qSXlNZzdZeU03SjI4SU95YXFldWZpZXlkdENEc3RJanFzN3pya0pqc2w0anNpclhyaTRqcmk2UXVJREV3VFVJZzdKMjA3WldZN0oyWUlPMk1qT3lkdk91bmpDRHNsNFhyb1p6cms1d2c2ckNBNjRxbDdaV3A2NHVJNjR1a0xnb3RJREV3VFVJZzdKMjA3WldZSU8yTWpPeWR2T3VuakNEc21LenJwclFnN0lpWUlPeWVpT3lXdE95YWxDNGdMeUR0akl6c25id2c3SnFwNjUrSjdKMkVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NHVrN0pxMDY2R2M2NU9jNnJDQUlPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcmk2VHNtclRyb1p6cms1enJwYndnNjZlSTdMT2s3SmEwN0pxVUxnb0tJeU1qSU9xeXNPeWduT3lYa0NEc2k2VHRqS2p0bFpqc21JRHNpclhyaTRqcmk2UXVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHFzckRzb0p6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3F5c095Z25DRHMNCmlKanJpNmpzbllRZzdabVY3SjI0N1pXWTZyT2dJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXWTdKZXNJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXp0ZXF3aE95ZGhDRHRtWlhyczdUdGxad2c2NUtrSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lFbk91NWhPeUtwQ0RzcElEcnVZUWc3S1NSN0o2RjY0dUk2NHVrTGdvdElPeWtnT3U1aE8yVm1PcXpvQ0Rzbm9qcmlwUWc2cml3NjRxbDdKMjA3SmVRN0pxVUxpQXZJT3loc09xNGlPdW5qQ0RxdUxEcmk2VHJvS1FnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3VUc2V1aG5TRHFzSURyaXFYdGxad2c3TFdjNjR5QUlPcXduT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzDQppclhyaTRqcmk2UXVDaTBnNjQyVUlPdVRzZXVobmUyVm1PdWdwT3VwdENEcXVMRHNvYlFnN1pXdDY2cXA3SjJFSU95Q3JleWduTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095MmxPcXdnQ2tLQ2lNakl5RHN0cHpyajVrZzdKcVU3TEt0N0oyMElPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0xhYzY0K1pJT3lhbE95eXJleWRoQ0Rzb0pIc2lKanRsb2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLOTY3bUVJT3lEZ2UyRG5PdWx2Q0R0bVpYc25ianRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPcXl2ZXU1aENEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4Zw0KN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3lnaE8yWm1PMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3V3bE9xL2dPcTVqT3lhbEQ4S0NpTWpJeURyc0tucnJMZ2c3SmlJN0pXOTdKMjBJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzS25yckxnZzdKaUk3Slc5N0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHJ1WVRyc0lEcnNvanRtTGdnTmUyYWpDRHNtS1RycFpqcm9ad2c2ck9FN0tDVjdKMjBJT3llb09xNGlDRHNzcGpycHF6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SURYdG1vd2c3SjZZNjZxN0lPeWVoZXVncGUyVnRPeUVuQ0RxczRUc29KWHNuYlFnN0o2ZzZySzg3SmEwN0pxVUxpQXZJT3U1aE91d2dPdXlpTzJZdU91bHZDRHNucXpzaEtUc29KWHRsWmpycWJRZzY0dWs3SXVjSU95ZHRPeWENCnFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd0lDanNsNGJzbHJUc21wUWc0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFwQ2dvakl5TWc2N080N0oyNElPeWR1T3ltbmV5ZGhDRHRsWmpzcDRBZzdKV0s3Snk4NjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEcnM3anNuYmdnN0oyNDdLYWQ3SjJFSU8yVm1PdXB0Q0RycXFqcms2QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeWR0T3VwbE95ZHZDRHNuYmpzcHAwZzdLQ0U3SmVRNjRxVUlPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95ZHRPdXBsT3lkdkNEc25ianNwcDNzbllRZzY2ZUk3TG1ZNjZtMElPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95L29PMlBzT3lkZ0NEcm9aenF0N2pzDQpuYmdnN1p1RTdKZVE2NmVNSU95Q3JPeWFxU0Rxc0lEcmlxWHRsYW5yaTRqcmk2UXVDaTBnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3kvb08yUHNPeWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJyN2pzaExIcmhZVHNucERyaXBRZzY3TzA3Wmk0N0o2UUlPdVBtZXlkbUNEc2w0YnNuYlFnNnJLdzdLQ2M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzY3TzA3Wmk0N0o2UTZyQ0FJT3VQbWV5ZG1PMlZtT3VwdENEcXNyRHNvSnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsSVRyb1p6dGxZVHNuWVFnNjVPeDY2R2Q3WldZN0tlQUlPeVZpdXljdk91cHRDRHNuYlRzbXFuc25iUWc3S0NjN1pXYzY1Q3A2NHVJNjR1a0xnb3RJTzJVaE91aG5PMlZoT3lkaENEcms3SHJvWjN0bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2xiRWc2N0tFN0tDRTdKMjBJT3VDcnV5VmhDRHNuYnpydG9BZzZyaXc2NHFsN0oyMA0KSU95Z25PMlZuT3VRcWV1TGlPdUxwQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaV1k2Nm0wSU91cXFPdVRvQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc2N2lVNjZPbzdZaXM3SXFrNnJDQUlPcTZ2T3lndUNEc25vanNsclFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPdTRsT3VqcU8ySXJPeUtwT3VsdkNEc3ZKenJxYlFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPdTVoT3lEZ1NEc2w3RHJuYjNzc3BqcXNJQWc2NU94NjZHZDY1Q1k3S2VBSU95Vml1eVZtT3lLdGV1TGlPdUxwQzRLTFNEcnVZVHNnNEVnN0pldzY1Mjk3TEtZNjZXOElPdVRzZXVobmUyVm1PdXB0Q0RxdUxUcXVJbnRsYUFnNjVXTUlPdTVvT3VsdE9xeWpDRHNsN0RybmIzcms1enJwclFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc3RwenNub1VnN0xtMDY1T2M2ckNBSU91VHNldWgNCm5ldVFtT3luZ0NEc2xZcnNsWVFnN0lLczdKcXA3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdMYWM3SjZGSU95NXRPdVRuT3VsdkNEcms3SHJvWjN0bFpqcnFiUWc2N0NVNjZHY0lPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0lDanNtWVRybzR3ZzdKV0k2NEswS1FvS0l5TWpJTzJhak95YmtPcXdnT3llaGV5ZHRDRHNtWVRybzR6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzZyQ0E3SjZGN0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHNtSWpzbGIzc25iUWc3TGVvN0lhTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeVlpT3lWdmV5ZGhDRHN0NmpzaG96dGxvanNsclRzbXBRdUNnb2pJeU1nNjZ5NDdKMlk2ckNBSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SWljN0xDbzdLQ0I3Snk4NjZHY0lPdUx0ZXV6Z091VG5PdW1yT3F5b095S3RldUxpT3VMcEM0S0xTRHJyTGpzblpqcnBid2c3S0NSN0lpWTdaYUk3SmEwDQo3SnFVTGlBdklPeUluT3lFbk91TWdPdWhuQ0RyaTdYcnM0RHJrNXpycHJUcXNvenNtcFF1Q2dvakl5TWc3SVNrN0tDVjdKMjBJT3kwaU9xNHNPMlpsT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzaEtUc29KWHNuWVFnN0xTSTZyaXc3Wm1VN1phSTdKYTA3SnFVTGdvS0l5TWpJT3U1aE91d2dPdXlpTzJZdU9xd2dDRHJzNERxc3IzcmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SU91d2xPcS9xT3lXdE95YWxDNEtDaU1qSXlEc25ianNwcDNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHVPeW1uZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNaklPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUWdLT3luaU91c3VDRHNucXpxdGF6c2hMRXBDZ29qSXlNZzdKYTQ3S0NjSU91d3FldXN1TzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEcnNLbnJyTGdnNjRLZzdLZWM2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0phMA0KNjVha0lPdXdxZXV5bGV5Y3ZPdWhuQ0RzbmJqc3BwM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0oyNDdLYWRJT3V3cWV1eWxleWRoQ0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3F5c095Z25PMlZtT3lMcENEc3ViVHJrNXpycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEcXNyRHNvSnp0bGFBZzdMbTA2NU9jNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKdVE3WldZN0l1YzY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bFpqc2hManNtcFF1Q2kwZzdKdVE3WldZNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc2ck9FN0l1ZzZyQ0E3SnFVUHdvdElPeWp2T3lHak91bHZDRHNsWXpxczZBZzdKNkk2NEtZN0pxVVB3b0tJeU1qSXlEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0FvS0l5TWpJT3E0c09xd2hDRHINCnA0enJvNHpyb1p3ZzdKMjA3SnFwN0oyMElPeWtrZXluZ091UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc25iVHNtcWtnNnJpdzZyQ0U3SjIwSU91Qm5ldUNtT3lFbkNEc3A0RHF1SWpzbllBZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0pxcDY1K0pJT3UyZ095aHNleWN2T3VobkNEc29JRHNucVhzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95Z2dPeWVwZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1Q2dvakl5TWc3WWExN0l1Z0lPeVlwT3VsbU91aG5DRHNtcFRzc3Ezc25iUWc3SXVrN1l5bzdaV1k3SmlBN0lxMTY0dUk2NHVrTGdvdElPMkd0ZXlMb095ZHRDRHNtNUR0bVp6dGxaanNwNEFnN0pXSzdKV0VJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nDQo2cmFNN1pXY0lPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0pIcXQ3enNuYlFnNnJHdzY3YUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0phMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RxdG96dGxaenNuWVFnN0pxVTdMS3Q3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nN0lPQjdabXBJT3lWaU91Q3RDQW9NdXVMcUNEcXRhenNvYkFwQ2dvakl5TWc3SjZGNjZDbDdaV1k3SXVnSU95anZPeUdqT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnNjR1azdJdWNJTzJabGV5ZHVDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdLTzg3SWFNNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU91THBPeUxuQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lhbE95eXJlMlZtT3lMb0NEdGpwanNuYlRzcDREcnBid2c3TEMrN0oyRUlPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3WTZZN0oyMDdLZUE2Nlc4SU95dw0KdnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWp2T3lHak91bHZDRHRtWlhzbmJqdGxaanFzYkRyZ3BnZzdabUk3Snk4NjZHY0lPeWR0T3VQbWUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0K1o3SjI4N1pXY0lPeWFsT3l5cmV5ZHRDRHNzcGpycHF3ZzdLU1I3SjZGNjR1STY0dWtMaURzbnFEc2k1d2c3WnVFSU8yWmxleWR1TzJWdENEc283enNpNjNzaTV6c21LUXVDaTBnNnJDWjdKMkFJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpxczZBZzdKNkk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJUcnNxVHRpcmpxc0lBZzdLS0Y2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHRPdXlwTzJLdU9xd2dDRHJnWjNyZ3F6c2xyVHNtcFF1Q2dvakl5TWc3WU9JN1llMElPeUxuQ0RycXFqcms2QWc2NDJ3N0oyMDdZU3c2ckNBSU95Q3JleWduT3VRbU91cHNDRHJzN1hxdGF6dGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEsNCkxTRHRnNGp0aDdUdGxaanJxYlFnNjZxbzY1T2dJT3VOc095ZHRPMkVzT3F3Z0NEc2dxM3NvSnpya0pqcXM2QWc2NHVrN0l1Y0lPdVFtT3VQak91bXRDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWdsZXVua0NEdGc0anRoN1R0bGFEcXVZenNtcFEvQ2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3lEZ2UyWnFTRHNsWWpyZ3JRcENnb2pJeU1nNjdhQTdKNnNJT3lra1NEcnNLbnJyTGpzbnBEcXNJQWc2ckNRN0tlQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTJnT3llckNEc3BKSHNsNUFnNjdDcDY2eTQ3SjZRNnJDQUlPeWVpT3lYaU95V3RPeWFsQzRnTHlEc21JSHNnNEhzbllRZzdabVY3SjI0N1pXMElPdXp0T3lFdU95YWxDNEtDaU1qSXlEcXNyM3J1WVFnN1pXMDdLQ2NJT3Eyak8yVm5PeWR0Q0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cks5NjdtRUlPMlZ0T3lnbkNEcXRvenRsWnpzbmJRZzdaV0U3SnFVN1pXMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RzbXBUc3NxM3RsYlFnDQo3S084N0lTNDdKcVVMZ29LSXlNaklPMlpsT3llckNEcXNKRHNwNERxdUxBZzY3Q3c3WVN3NjZhczZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNEtMU0R0bVpUc25xd2c2ckNRN0tlQTZyaXdJT3V3c08yRXNPdW1yT3F3Z0NEc2xyenJwNGdnN0plRzdKYTA3SnFVTGlBdklPdXdzTzJFc091bXJPdWx2Q0RxdFpEc3NyVHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzdHBYc2xiMGdLeURxdUkzc29KVWc3S0NFN1ptWUlDanJrWkFnNjZ5NDdKNmxJT0tHa2lEcXVJM3NvSlh0bUpVZzdaV2NJT3VzdU95ZXBTa0tDaU1qSXlEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcg0Kc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bUp6dGc1MGc3SmVHN0oyMElPcXdnT3llaGUyVm9PcTVqT3lhbEQ4ZzdLZUE2cmlJSU95TG9PeXlyZTJWbU95bmdDRHNsWXJzbkx6cnFiUWc3SnV3N0x1MElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc3A0RHF1SWdnN0l1ZzdMS3Q3WldZNjZtMElPeWJzT3k3dENEdG1KenRnNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdMK2c3WSt3SU95WGh1eWR0Q0Rxc3JEc29KenRsYURxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdUNEc3Y2RHRqN0RzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVDaTBnN0wrZzdZK3c3SjJFSU91d20reWN2T3VwdENEcmpaUWc3S0NBNjZDMDdaV1k2cktNSU9xeXNPeWduTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEc2w0YnNuYlFnN0l1YzdKNlI3WldnNnJtTTdKcVUNClB5RHNsWXpycHJ6c25ZUWc3THljN0tlQUlPeVZpdXljdk91cHRDRHNwSkhzbXBUdGxad2c3SWFNN0l1ZDdKMkVJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPeVZqT3Vtdk95ZGhDRHN2SnpycWJRZzdLU1I3SnFVN1pXY0lPeUdqT3lMbmV5ZGhDRHJzSlRyb1p3ZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdKNlE2NCtaN0oyMDdMSzA2Nlc4SU91VHNldWhuZTJWbU95bmdDRHNsWXJxczZBZzY0U1k3SmEwNnJDSTZybU03SnFVUHlEcms3SHJvWjN0bFpqc3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNucERyajVuc25iVHNzclRycGJ3ZzY1T3g2NkdkN1pXWTY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURyczdnZzZyT0U3Slc5N0oyWUlPeWNvT3lkdk8yVm5DRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95ZHZPdXdtT3EwZ091bXJPeWVrT3VoDQpuQ0RxdG96dGxaenJzNERxc3Izc25ZUWc3WldZN0l1a0lPeUltQ0RzbDRic2xyVHNtcFF1SU95ZHZPdXdtQ0RxdElEcnBxenNucERyb1p3ZzZyYU03WldjSU91emdPcXl2ZXlkaENEc201RHRsWmpzaTZRZzZySzk3SnF3SU91THBPdWx1Q0RzZ3F6cm5venNsNURxc293ZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtDRHF0b3p0bFp6c25ZUWc3S2VBN0tDVjdaVzBJT3lqdk95TG9DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZuQ0Rya3FRZzdKMjg2N0NZSU9xMGdPdW1yT3lla091aG5DRHJzNERxc3IzdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXpnT3F5dmUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvPQ0KOjpHVUlERTo6DQpJeUJWV0NCWGNtbDBhVzVuSU9xd2dPeWR0T3VUbkEwS0RRb2pJeUF4TGlEdGxiVHNtcFRzc3JRTkNnMEs3S0NjN1pLSUlPeVZpT3lkbUNEcnFxanJrNkFnNjZ5NDZyV3M2NHFVSUNmdGxiVHNtcFRzc3JRbjY2R2NJT3lOcU95YWxDNE5DdXlkdk9xMGdPeUVzU0Rzbm9qcmlwUWc3SUtzN0pxcDdKNlFJT3F5dmUyWG1PeWRoQ0RycDR6cms2UWc3SWlZSU95ZWlPdVBoT3VoblNBcUt1eURnZTJacVN3ZzY2ZWw2NTI5N0oyRUlPdTJpT3VzdU8yVm1PcXpvQ0RycXFqcms2QWc2Nnk0NnJXczdKZVFJTzJWdE95YWxPeXl0T3VsdkNEc29JSHNtcW50bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RyczdUcmc0WHJpNGpyaTZRZzRvYVNJT3V6dE91Q3ZPcXlqT3lhbEEwS0RRb3FLaW9OQ2cwS0l5TWdNaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0EwS0RRcnNvSnp0a29nZzdKV0k3SmVRN0lTY0lPeTFuT3VNZ08yVm5DQXFLdXVLcGV1UG1lMllsU0Ryckxqc25xVXFLdXlkaENEc2phanNvN3pzaExqcw0KbXBRdUlPeUltT3VQbWUyWWxTRHJyTGpzbnFYc25ZQWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1TM3NpSmpyajVudG1KVXQ2Nnk0N0o2bDdKMkVMZXlOcU91UGhDM3JrSmpyaXBRdDZySzk3SnF3S2V5WGtDRHRsYlRyaTdudGxhQWc2NVdNNjZlTUlPeVRzT3VLbENEcXNvd2c3S0tMN0pXRTdKcVVMZzBLRFFvakl5TWc2NUNRN0phMDdKcVVJT0tHa2lEdGxvanNsclRzbXBRTkNnMEs3SmlJS1EwS0xTRHNoS1Rzb0pYcmtKRHNsclRzbXBRZzRvYVNJT3lFcE95Z2xlMldpT3lXdE95YWxBMEtEUW9qSXlNZ0ozN3NsNGduSU91NXZPcTRzQTBLRFFyc21JZ3BEUW90SU91d2xPdUFqT3lYaU95V3RPeWFsQ0RpaHBJZzY3Q1U2citvN0phMDdKcVVEUW9OQ2lNakl5RHJqNW5zZ3F3ZzY3Q1U2citVN0pPdzZyaXdEUW9OQ3V5WWlDa05DaTBnNjRhUzdKV0U3S0dNN0phMDdKcVVJT0tHa2lEc21LenJucERzbHJUc21wUU5DZzBLS2lvcURRb05DaU1qSURNdUlPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQU4NCkNnMEs3S0NjN1pLSUlPeVZpT3lYa095RW5DRHJ0b0Rzb0pYc29JRWc3THVrNjY2azY0dUk3THlBN0oyMDdJV1k3SjJFSU95MW5PdU1nTzJWbkNEc3BJVHNuYlRxczZBZzZyaU43S0NWN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpzbzd6c2hManNtcFF1RFFycnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRNdDY3YUE3S0NWN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2phanNtcFF1RFFvTkN1eVlpQ0E2SU95VmlDRHJqN3pzbXBRc0lPeVhodXlXdE95YWxDQW9XQ2tnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRZ0tFOHBEUW9OQ2lNakl5RHNsNGJzbHJUc21wUWc0b2FTSU95ZWlPeVd0T3lhbEEwS0RRcnNtSWdwRFFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsWmpxdUxBZzdLQ0U3SmVRNjRxVUlPcXdnT3llaGUyVm9DRHNpSmdnDQo3SmVHN0phMDdKcVVJT0tHa2lEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaVzA3Slc4SU9xd2dPeWVoZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVEUW9OQ2lNakl5RHNsNURybjZ3ZzY2bVU3SXVjN0tlQURRb05DdXlYa091ZnJDRHNnNEh0bWFuc2w1RHNoSnpyajRRZ0l1MlZ0T3F5c0NEcnNLbnJzcFVpN0oyRUlPdW92T3lnZ0NEc2xZenJvS1Rzbzd6cmlwUWc2cmlON0tDVjdaaVZJT3Exck95aHNPdWhuQ0RzamFqc21wUXVEUW9OQ3V5WWlDa05DaTBnN0tlQTZyaUlJT3V5aE95Z2hPeVhrT3lFbk91S2xDRHNrN2dnN0lpWUlPeVhodXlXdE95YWxDNGc3SU9kN0xLMElPeWR1T3ltbmV5ZGhDRHNrN0Ryb0tUcnFiUWc3Sld4N0oyRUlPeTFuT3lMb0NEcnNvVHNvSVRzbkx6cm9ad2c3SmVGNjQydzdKMjA3WXE0SU8yVnRPeWp2T3lFdU95YWxDNGc0b2FTSU95VnNleWRoQ0RzbDRYcmpiRHNuYlR0aXJqdGxiVHNvN3pzaExqc21wUXVJT3lEbmV5eXRDRHNuYmpzcHAzc25ZUWc3Sk93NjZDazY2bTBJT3kxbk95TA0Kb0NEcnNvVHNvSVRzbmJRZzdaV0U3SnFVN1pXMDdKcVVMZzBLRFFvNk9qb2dkR2x3SU8yTW5leVhoU0Ryc29UdGlyenNuWUFnV3pndUlPMk1uZXlYaFYwZzZyZWM3TG1aN0oyRUlPdVVzT3Vkdk95YWxBMEs3WXlkN0plRktPdUxwT3lkdE95V3ZPdWhuT3EzdUNrZzY3S0U3WXE4SU91c3VPcTFyT3VLbENEc2xZVHJucGdnS2lvNExpRHRqSjNzbDRVcUtpRHNoTG5zaFpnZzZyZWM3TG1aN0oyRUlPdVVzT3Vkdk95YWxDRGlnSlFnN1lhMTY3TzA2NHFVSUZ2dG1aWHNuYmhkTENEc21JZ3Y3SldFNjR1STdKaWtJTzJNa091THFPeWRnQ0JiN0pXRTY0dUk3SmlrWGNLM1crdUVwRjBzSU91UG1leWVrU0RzbktEcmo0VHJpcFFnVyt5M3FPeUdqRjNDdDF2cmo1bnNucEZkTGlBaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenJwNHdnN0pPdzZyT2dMQ0FpNjR1cjZyaXdJTUszSU91UG1leWVrU0xzc3Bqcm43d2c3S2VkN0oyMElPeVZpQ0RycDU3cmlwUWc3S0d3N1pXcDdKMkENCklPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRbzZPam9OQ2cwS0l5TWpJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eWRoQ0RybFl3TkNnMEs3SmlJS1EwS0xTRHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNGc0b2FTSU95VnZlcTBnT3lYa0NEcmo1bnNuWmp0bFpqcnFiUWc2NnFvN0o2RTdLZUE3SnVRNnJpSTdKMkVJT3V3bSt5ZGhDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb2pJeU1nN1ppYzdZT2RJT3VNZ095RGdTRHNsWWpyZ3JRTkNnMEtLaXJzaEp6cnVZVHNpcVRyaXBRZzdKTzRJT3lJbUNEc25vanNwNERycDR3c0lPMkt1ZXlnbFNEdG1KenRnNTNzbllBZzY3Q2I3SjJFSU95SW1DRHNsNGJzbllRZzY1V01JT0tHa2lEcXVJM3NvSlh0bUpVZzY2eTQ3SjZsDQo3Snk4NjZHY0lPeU5xT3lhbEM0cUtnMEs3SUtzN0pxcDdKNlE2NHFVSU91c3VPcTFyT3VsdkNEcXZMenF2THp0bm9nZzdKMjk3S2VBSU95Vml1cXpvQ0R0bTVIc2xyVHJzN1RxdUxBbzdJcWs3THFVS1NEcmxZenJyTGpzbDVBc0lPdTJnT3lnbGUyWWxleWN2T3VobkNEc2s3RHJxYlFnN0tDYzdaS0lJT3lnaE95eXRPdWx2Q0RzazdnZzdJaVlJT3lYaHV1THBPcXpvQ0RzbUtUdGxiVHRsWmpxdUxBZzdJbXM3SnVNN0pxVUxnMEtEUXJzbUlncERRb3RJT3F6aE95aWpDRHFzSnpzaEtRZzdaaWM3WU9kN0oyQUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMaURpaHBJZ05DNDFKU0RxdUlqcnBxd2c3WmljN1lPZDY2ZU1JT3V3bSt5ZGhDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb3FLaW9OQ2cwS0l5TWdOQzRnN0xxUTdLTzg3SmE4N1pXY0lPcXl2ZXlXdEEwS0RRcnNvSnp0a29nZzdKV0k3SmVRN0lTY0lDZCs3SXVjNnJLZzdKYTA3SnFVUHljc0lDZnNpNXpyZ3Bqc21wUS9KeXdnSjM3cXU1Z25JT3F3bWV5ZA0KZ0NEcXM3enJqNFR0bFp3ZzZySzk3SmEwNjZXOElPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRcnN0WnpyaklEdGxad2c3THFRN0tPODdKYTg3WldZNnJPZ0lPeTVuT3Ezdk8yVm5DRHJwNUR0aUt6cnBid2c3Sk93NjRxVUlPcXlqQ0Rzb292c2xZVHNtcFF1RFFycXNyM3NsclRyaXBRZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TWkzcXNyM3NsclRycGJ3dDdJMm82NCtFTGV1UW1PdUtsQzNxc3Izc21yQXA3SmVRSU8yVnRPdUx1ZTJWb0NEcmxZenJwNHdnN0kybzdKcVVMZzBLRFFvakl5TWc2NCtaN0lLczdKZVE3SVNjSUNkKzdJdWNKeURydWJ6cXVMQU5DZzBLN0ppSUtRMEtMU0RzdWJUcms1enJwYndnN1pXMDdLZUE3WldZN0l1YzZyS2c3SmEwN0pxVVB5RGlocElnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWb09xNWpPeWFsRDhOQ2kwZzdJdWM3SjZSN1pXWTdJdWM2NHFVSU91MmhPeVhrT3F5akNBMUxEQXdNT3lia095ZGhDRHJrNXpyb0tUc21wUXVJT0tHa2lEc2k1enNucEh0bFpqcnFiUWcNCk5Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMZzBLRFFvakl5TWdKK3F6aE95TG5PdUxwQ2NnNG9hU0lDZnNub2pyaTZRbkRRb05DdXlZaUNrTkNpMGc3SjZRNjQrWjdMQ282Nlc4SU9xd2dPeW5nT3F6b0NEcXM0VHNpNXpyZ3Bqc21wUS9JT0tHa2lEc25wRHJqNW5zc0tqcXNJQWc3SjZJNjRLWTdKcVVQdzBLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NSU95V3ZPdW5pT3lVcVNEcmdyVHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB5RGlocElnNjZlazY0dXNJT3V6dE8yWG1PdWpqT3VLbENEc2xyenJwNGpzbmJqcXNJRHNtcFEvSUNvbzY0dW83SWljSU95NW1PMlptT3lkdENEc2xZVHJpNGpybmJ3ZzY2eTQ3SjZsN0oyRUlPeURpT3VobkNEc2s3UWc3SUtzNjZHQTdKaUk3SnFVS1NvTkNnMEtJeU1qSUNmc2w2enNyWWpyaTZRbklPS0draUFuN1ptVjdKMjQ3WldZNjR1a0xDRHJyTHZyaTZRbkRRb05DdXlZaUNrTkNpMGc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFINnJDQTdLZUFJT3VMDQpwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1SU9LR2tpRHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2Zxc0lEc3A0QWc2NHVrN0l1Y0lPMlpsZXlkdU8yVm9PcXlqT3lhbEM0TkNnMEtJeU1qSUNmcXU1Z25JT0tHa2lBbjdKZVE2cktNSncwS0RRcnNtSWdwRFFvdElPMlpqZXE0dU91UG1ldUxtT3E3bUNEcmdxRHNsWVRxc0lEcXM2QWc3SjZJN0phMDdKcVVMaURpaHBJZzdabU42cmk0NjQrWjY0dVk3SmVRNnJLTUlPdUNvT3lWaE9xd2dPcXpvQ0Rzbm9qc2xyVHNtcFF1RFFvTkNpTWpJeURxc3Izc2xyVHJwYndnNjdxUTdKMkVJT3VWakNEc2xyVHNnNG50bFp3ZzZySzk3SnF3RFFvTkN1eUNyT3lhcWV5ZWtPeWRtQ0Rzb0pYcnM3VHJwYndnNjdDYjY0cVVJT3luaU91c3VPeVhrT3lFbkNEcXVMRHFzNFRzb0lIc25MenJvWndnSjM3c2k1d242Nlc4SU91NmtPeWRoQ0RybFl3ZzY2eTQ3SjZsN0oyMElPeVd0T3lEaWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0tpcnRqSXpzbFlYdA0KbFpqcXM2QWc3SXUyN0oyQUlPeWdsZXV6dE91bHZDQW43S084N0phMEordWhuQ0RzamFqc2hKd2c2Nnk0N0o2bDdKMkVJT3lEaU91aHJlcXlqQ0RzamFqcnM3VHNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RzbHJUcmxxUWc2NnFwN0tDQjdKeTg2NkdjSU91TWdPeTJuT3V3bSt5Y3ZPeUxuT3VDbU95YWxEOGc0b2FTSU91TWdPeTJuQ0RycXFuc29JSHNuYlFnNjZ5MDdKZUg3SjI0NnJDQTdKcVVQdzBLTFNEc2xyVHJscVFnN0oyMDdKeWc2NkdjSU95TG9PcXpvTzJWbU95TG5PdUNtT3lhbEQ4ZzRvYVNJT3lMb09xem9DRHNuYlRzbktEcnBid2c3SVNnN1lPZDdaVzBJT3lqdk95RXVPeWFsQzROQ2cwS0tpb3FEUW9OQ2lNaklEVXVJQ2Q3NjZxRjdJS3NmU0FySUh2cnFvWHNncXg5SnlEc2s3RHNwNEFnN0pXSzZyaXdEUW9OQ2lNakl5RHRsWnpzbnBEc2xyUWc3WktBN0phMDdKT3c2cml3RFFvTkN1MlZuT3lla095V3RDRHJxb1hzZ3F6cnBid2c3WktBN0phMDdJU2NJT3VQbWV5Q3JDRHRtSlh0ZzV6cm9ad2cNCjdKTzRJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrTkNpMGc3SjIwN0o2UUlPMlptT3UyaU95ZGhDRHJzSnZzbFpqc2xyVHNtcFFnNG9hU0lPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUU5DaTBnNjRLMDdKMjhJT3k1dE91VG5PcXdrdXlkdENEcXNyRHNvSnpya0tBZzdKaUk3S0NWN0oyMDdKZVE3SnFVSU9LR2tpRHJnclRzbmJ6c25ZQWc3TG0wNjVPYzZyQ1NJT3VDbU9xd2dPdUtsQ0RyZ3FEc25iVHNsNURzbXBRTkNnMEtJeU1qSU8yVm5PeWVrT3lXdE91bHZDRHRrb0RzbHJUc2s3RHF1TEFnN0phMDY2Q2s3SnE0SU9xeXZleWFzQTBLRFFvbmUrdXFoZXlDckgzcXNJQWdlK3VxaGV5Q3JIM3RsYlRzaEp3bklPMllsZTJEbk91aG5PdW5qQ0R0a29Ec2xyVHNwSmpyajRRZzY0MlVJT3k2a095anZPeVd2TzJWbU9xeWpDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjSU9xMXJPdW5wTzJWbU95bmdDRHJxcnZ0DQpsb2pzbHJUc21wUWc0b2FTSU95ZWxPeVZvZXlkdENEcnRvRHNvYkh0bGJUc2hKd2c2cldzNjZlazdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTmk0ZzdaR2M2cml3SU8yR3RleWR2QTBLRFFvakl5TWc2NUNZN0phMDdKcVVJQ2hZS1NEaWhwSWc2NCs4N0pxVUlDaFBLUTBLRFFycnFxanJzSlRzbmJ3ZzdabVU2Nm0wN0oyWUlPeWlnZXlkZ0NEcXM3WHFzSVRzbllRZzZyT2c2NkNrN1pXMElDZnJrSmpzbHJUc21wUW42NHFVSU91cXFPdVJrQ0FuNjQrODdKcVVKK3VobkNEdGhyWHNuYnp0bGJUc2hKd2c3STJvN0tPODdJUzQ3SnFVTGcwS0RRb3FLaW9OQ2cwS0l5TWdOeTRnNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3lJcSt5ZWtDRHRrWnpxdUxBTkNnMEs2NEtnN0tlY3dyZnNpNXpxc0lUQ3QrdXlpTzJZdU91S2xDRHNsWVRybnBnZzdaaVY3SXVkN0p5ODY2R2NJTzJHdGV5ZHZPMlZ0T3lFbkNEc2phanNtcFF1RFFvTkNpTWpJeURyZ3FEc3A1ekN0K3lMbk9xd2hNSzM2cml3NnJDRQ0KRFFvTkNud2c3Wld0NjZxcElId2c3WmlWN0l1ZElId2c3SmlJN0l1Y0lId05Dbnd0TFMwdExTMThMUzB0TFMwdGZDMHRMUzB0TFh3TkNud2c2NEtnN0tlY0lId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVZQ0F2SU95bnArcXlqQ0JnVFUwdVJFUmdJSHdnTWpBeU5TNHdNUzR3TVN3Z01qVXVNREV1TURFZ2ZBMEtmQ0RzaTV6cXNJUWdmQ0RxdUxEcnM3Z2dZRWhJT2sxTk9sTlRZQ0F2SU95bnArcXlqQ0JnU0VnNlRVMWdJQ2pzbUtUc29JUXY3SmlrN1p1RUlPeVZpQ0RzbElBcElId2dNVFE2TXpBNk1URXNJREV6T2pNd0lId05DbndnNnJpdzZyQ0VJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFZmxsWldWa3VUVTB1UkVSZ0lDOGc3S2VuNnJLTUlHQlpXVmxaTGsxTkxrUkVmazFOTGtSRVlDQjhJREl3TWpVdU1ERXVNREYrTWpBeU5TNHdNUzR6TVN3Z01qQXlOUzR3TVM0d01YNHdNUzR6TVNCOERRcDhJT3VDb095bm5DQXJJT3lMbk9xd2hDQjhJR0JaV1ZsWkxrMU5Ma1JFSUVoSU9rMU5ZQ0I4SURJd01qVXUNCk1ERXVNREVnTVRRNk16QWdmQTBLZkNEc21wVHNuYndnZkNCZ1dWbFpXUzVOVFM1RVJDanNtcFRzbmJ3cFlDRGlnSlFnN0p1VUwrMlpsQy9zaUpndjY2cXBMK3E0aUMvdGhxQXY3SjI4SUh3Z01qQXlOUzR3TVM0d01TanNpSmdwSUh3TkNnMEtLaXJzaTV6cXNJUWc3SmlJN0ptNEtpbzZJT3lDck95YXFleWVrT3F3Z0NEc3A0SHNvSkVnNnJPZzY2VzA2NHFVSU91d3FldXN1TUszN0ppSTdKVzlJT3lMbk9xd2hPeWRnQ0JnN0ppazdLQ0VMK3lZcE8yYmhDQklPazFOWU95ZGhDRHNqYWpyajRRZzY0Kzg3SnFVTGcwSzdKaUlLU0RzbUtUdG00UWdNVG93TUEwS0RRb2pJeU1nNjZ5NDdKNmxJT3lHalNEc2w3RHNtNVRzbmJ3TkNnMEs2Nnk0N0o2bElPeVZpT3lYa095RW5PdUtsQ0FxS3V5YmxNSzM3SjI4SU95Vm51eWRtQ0F3N0oyRUlPdTV2T3F6b0NvcUlPeU5xT3lhbEM0TkNnMEs3SmlJS1EwS0xTQXlNREkyNjRXRUlEQTQ3SnVVSURBMTdKMjhJT3llaGV1TGlPdUxwQzRnNG9hU0lESXdNamJyaFlRZ09PeWJsQ0ExDQo3SjI4SU95ZWhldUxpT3VMcEM0TkNnMEtJeU1qSU95RGdldU1nQ0RzaTV6cXNJUWdLT3VGdU95Mm5PeWFxU2tOQ2cwS2ZDRHNvYkRxc2JRZ2ZDRHRrWnpxdUxBZ2ZBMEtmQzB0TFMwdExYd3RMUzB0TFMxOERRcDhJRFl3N0xTSUlPdXZ1T3VuakNCOElPdXdxZXE0aUNEc29JUWdmQTBLZkNBMk1PdTJoQ0RycjdqcnA0d2dmQ0JPNjdhRUlPeWdoQ0I4RFFwOElESTA3SXVjNnJDRUlPdXZ1T3VuakNCOElFN3NpNXpxc0lRZzdLQ0VJSHdOQ253Z016RHNuYndnNjYrNDY2ZU1JSHdnVHV5ZHZDRHNvSVFnZkEwS2ZDQXhNdXF3bk95YmxDRHJyN2pycDR3Z2ZDQk82ckNjN0p1VUlPeWdoQ0I4RFFwOElERXk2ckNjN0p1VUlPeWR0T3lEZ1NCOElFN3JoWVFnN0tDRUlId05DZzBLN0ppSUtTRHJzS25xdUlnZzdLQ0VMQ0ExNjdhRUlPeWdoQ3dnTXV5TG5PcXdoQ0Rzb0lRc0lEUHNuYndnN0tDRUxDQTI2ckNjN0p1VUlPeWdoQ3dnTXV1RmhDRHNvSVFOQ2cwS0l5TWpJT3VuaU9xd2tNSzM2cml3NnJDRUlPdW5qT3VqakEwSw0KRFFwZ1JDMU9ZQ2hPN0oyOElPdUNxT3lkakNrZ0x5QmdSQzB3WUNqc21LVHJpcGdnNjZlSTZyQ1FLU0F2SUdCRUswNWdLRTdzbmJ3ZzZySzk2ck84S1EwSzdKaUlLU0JFTFRjc0lFUXRNU3dnUkMwd0xDQkVLekVOQ2cwS0l5TWpJT3V5aU8yWXVDRHRrWnpxdUxBZ0tPMlZtT3lkdE8yVWlPeWN2T3VobkNEcXRhenJ0b1FwRFFvTkNud2c3Wld0NjZxcElId2c3WmlWN0l1ZElId2c3SmlJN0l1Y0lId05Dbnd0TFMwdExTMThMUzB0TFMwdGZDMHRMUzB0TFh3TkNud2c3S0NFN1ptVTY3S0k3Wmk0SUh3ZzdaV1k3SjIwN1pTSUlPcTFyT3UyaENCOElEQXlMVEV5TXpRdE5UWTNPQ3dnTURFd0xURXlNelF0TlRZM09DQjhEUXA4SU95NXRPdVRuT3V5aU8yWXVDQjhJRFRzbnBEcnBxenNsS2tnN1pXWTdKMjA3WlNJSUh3Z01USXpOQzAxTmpjNExUa3dNVEl0TXpRMU5pQjhEUXA4SU9xemhPeWlqT3V5aU8yWXVDQjhJTzJWbU95ZHRPMlVpQ0RxdGF6cnRvUWdmQ0F4TWpNdE5EVTJMVGM0T1RBeE1pQjhEUXA4SU95anZPdXYNCnZPdVRzZXVobmV1eWlPMll1Q0I4SU95Vm5pQTI3SjZRNjZhc0xldVNwQ0EzN0o2UTY2YXNJSHdnTVRJek5EVTJMVEV5TXpRMU5qY2dmQTBLZkNEc2dxenNsNFhzbnBEcms3SHJvWjNyc29qdG1MZ2dmQ0F4TU95ZWtPdW1yQ0R0bFpqc25iVHRsSWdnZkNBd01TMHlNelF0TlRZM09Ea2dmQTBLRFFvakl5TWc3Sk93NjZtMElPeVZpQ0Rya0pqcmlwUWc3WkdjNnJpd0RRb05DaTBnNjRLZzdLZWM3SmVRSU8yVm1PeWR0TzJVaU1LMzY3bVg2cmlJT2lEaW5Zd2dNakF5TlMwd01TMHdNU3dnTURFdk1ERU5DaTBnN0l1YzZyQ0U3SmVRSU95WXBPeWdoQy9zbUtUdG00UTZJT0tkakNEc21LVHNvSVFnTWV5TG5DQXFLT3VMcUN3ZzdJS3M3SnFwN0o2UTZyQ0FJT3luZ2V5Z2tTRHFzNkRycGJUcmlwUWc2N0NwNjZ5NHdyZnNtSWpzbGIwZzdJdWM2ckNFN0oyQUlPeVlpT3ladUNrcURRb05DaW9xS2cwS0RRb2pJeUE0TGlEdGpKM3NsNFVvNjR1azdKMjA3SmE4NjZHYzZyZTRLUTBLRFFydGpKM3NsNFVnNjZ5NDZyV3M2NHFVDQpJQ29xN0pldDdaV2dLaW9vN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2Q25xczd3Z0tpcnNuS0R0bUpVcUtpanRoclhyczdRdjdZeVE2NHVvS2V5WGtDRHJsTERybmJ3ZzY2eTQ3TEswNnJDQUlPdUxyT3Vkdk95YWxDNGc3WU9BN0oyMDdZdUE3SjJFSU91THBPdVRyT3lkaENEcmxaQWc2N0NZNjVPYzdJdWNJT3lWaU91Q3RDanJzN2pyckxncDZybU03S2VBSU9xd21leWR0Q0RyczdUcXM2QXNJT3V6dU91c3VDRHJwNlhybmIzc25ZUWc2NHUwN0pXRTdKVzhJTzJWdE95YWxDNE5DZzBLSXlNaklERHJpNmpxczRRZzRvQ1VJTzJLdU91bXJPcXhzT3UyZ08yRXNDRHJ0SkRzbXBRTkNnMEs3WXlkN0plRjdKMjBJT3lDck95YXFleWVrT3lkbUNEc2xyVHJscVFnN1phSjY0K1pJT3VTcE95WGtDRHJuS2pyaXBUc3A0QWc2Nmk4N0tDQUlPMk1qT3lWaGUyVnRPeWFsQzROQ2cwS0xTRHRsb25yajVuc25ZUWdLaXJxc0lEcm9aenJwNG5xc2JEcmdwZ2c3WXlRNjR1bzdKMkVJT3lhbE9xMXJDb3FLT3lkdE8yRA0KaU1LMzdJS3Q3S0Njd3Jmcm9aenF0N2pzbFlUc200UEN0K3lpaGV1ampDa2c0b2FTSUNvcTdZeVE2NHVvN1ppVktpb2dLT3Vzdk95V3RPdTBrT3lhbENrTkNpMGc2ckt3NnJPOHdyZnNnNEh0ZzV6cnBid2dLaXJ0aHJYcnM3VHJwNHdxS2lBbzdKbUU2Nk9Nd3Jmc2k2VHRqS2dwSU9LR2tpQXFLdXlWaU91Q3RPMllsU29xSUNqc2xZenJvS1RzcEpqc21wUXBEUW9OQ2lNakl5RHRnNERzbmJUdGk0QWc0b0NVSU95bnAreWRnQ0RycW9Yc2dxenF0YXdOQ2cwS0xTRHJxb1hzZ3F6dG1KWHNuTHpyb1p3ZzY0R2Q2NEswN0pxVUxpRHNvb1hxc3JEc2xyVHJyN2pDdCt1bmlPeTVxTzJSbk91bHZDRHNrN0RzcDRBZzdKV0s3SldFN0pxVUlDaCs3SnFVSUM4Z2Z1dUxwQ0F2SUg3cXVZenNtcFEvSU9LZGpDa3VEUW90SURKK05PeVd0T3lnaU91aG5DRHNwNmZxczZBZzdJbTk2cktNTGlEdGxaenNucERzbHJUQ3QreUltT3lMbmV5ZGhDRHF1TGpxc293ZzdJeVQ3S2VBSU95Vml1eVZoT3lhbEM0TkNpMGc3SldJNjRLMEtPdXoNCnVPdXN1Q2tnNjZlbDY1Mjk3SjJFSU95YWxPeVZ2ZTJWdEN3Z0tpcnRnNERzbmJUdGk0RHJwNHdnNjdTUTY0K0VJT3VzdE95S3FDRHRqSjNzbDRYc25ianNwNEFxS2lEc2xZenFzb3dnN1pXMDdKcVVMaURzbTVEcnM3anNuYlFnSit5VmpPdW12TUszN1ptVjdKMjRKK3l5bU91ZnZDRHJwNG5zbDdEdGxaanJxYlFnNjdPNDY2eTQ3SjJFSU9xM3ZPcXhzT3VobkNEcXRhenNzclR0bVpUdGxiVHNtcFF1RFFvTkNud2c3SjIwNjZDSDZyS01JT3Vua09xem9DQjhJT3lkdE91Z2grcXlqQ0I4RFFwOExTMHRmQzB0TFh3TkNud2c3S0NBN0o2bDdaV1k3S2VBSU95Vml1cXpvQ0RyZ3BqcXNJRHNpNXpxc3FEc2xyVHNtcFEvSUh3ZzdLQ0E3SjZsSU95VmlDRHRsWndnNjRLMDdKcXBJSHdOQ253ZzdKV002NmE4SUh3ZzZyS3c3S0NjSU95WmhPdWpqQ0I4RFFwOElPeWdsZXVua0NEc2dxM3NvSnp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSUh3ZzY0Mnc3SjIwN1lTd0lPeUNyZXlnbkNCOERRb05DaU1qSXlEc2xZanJnclFvDQo2N080NjZ5NEtTRGlnSlFnN1pXMDdKcVU3TEswRFFvTkNpMGdLaXJ0akpEcmk2anRtSlVxS3V5ZGdDQW5mdTJWb09xNWpPeWFsRDhuNjZHY0lPdXN2T3lXdE95YWxDNGc2NUNZNjQrTTY2YTBJT3lJbUNEc2w0YnJpcFFnN0p5RTdaZVlLT3lDcmV5Z25NSzM3WU9JN1llMElPdVRzU25zbllBZzZyS3c2ck84NjZXOElPdW92T3lnZ0NEcXNyM3FzNkR0bGJUc21wUXVEUW90SUNvcTdKV0k2NEswN1ppVktpcnNuWUFnN0lLczdJdWs3SjJFSU95RW5PeUlvTzJWdE95YWxDNE5DaTBnNjZlSTdMbW83WkdjNjZXOElPeU5xT3lhbEM0ZzdJaXI3SjZRd3Jmc29iRHFzYlFvN0oyMDdJT0J3cmZzbmJUdGxaakN0K3lkdE91Q3RDRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWkRxczZBc0lPeWJrT3VzdU95WGtDRHNsNGJyaXBRZzdLQ1Y2N08wd3Jmc29JanNzS2pDdCt5WHNPdWR2ZXl5bU91bHZDRHNwNERzbHJUcmdyVHNwNEFnN0pXSzdKV0U3SnFVTGcwS0RRb2pJeU1nNjdLRTdZcThJT0tBbENEc2xZanJnclFnNjZ5NA0KNjZlbDdKMjBJT3lnbGUyVnRPeWFsQTBLRFFwOElPdXp1T3VzdU95ZHRDRHNuYlRyb0lmcmk2UWdmQ0Ryc29UdGlyd2dmQTBLZkMwdExYd3RMUzE4RFFwOElPcXlzT3F6dk1LMzdJT0I3WU9jNjZXOElPMkd0ZXV6dENCOElGdnRtWlhzbmJoZElId05DbndnSjM3dGxhRHF1WXpzbXBRL0ordWhuQ0Ryckx6c25Zd2dmQ0JiN0pXRTY0dUk3SmlrWFNEQ3R5QmI2NFNrWFNCOERRcDhJT3lEZ2UyWnFTRHNoSnpzaUtBZ0t5RHNtS1RycGJqc3FyM3NuYlFnN0l1azdLQ2NJT3VQbWV5ZWtTQjhJRnZzdDZqc2hveGRJTUszSUZ0NzY0K1o3SjZSZlYwZ2ZBMEtEUW90SUNmc3Q2anNob3duNjRxVUlDb3E2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNS2lvZzdJMm83SnFVSUNqc21JZzZJRnZzdDZqc2hveGR3cmRiN0lLdDdLQ2NYU2t1SUNmcmk2dnF1TEFnd3JjZzY0K1o3SjZSSit5eW1PdWZ2Q0RzcDUzc25iUWc3SldJSU91bm51dUtsQ0Rzb2JEdGxhbnNuYlRyZ3BnZzY0dW82NCtGSUNmc3Q2anMNCmhvd242NHFVSU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFvdElPdXloTzJLdk95ZG1DRHJqNW5zbnBFZzdKMjA2NmFFN0oyQUlPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRoQ0RxdDdqcmpJRHJvWndnN0lLMDY2Q2s3SnFVTGcwS0RRb2pJeU1nN1lhMTdLZWNJT3lZaU95TG5BMEtEUW9xS3UyTWtPdUxxTzJZbFNEaWdKUWc3SjIwN1lPSUtpb05DaTBnN1lPQTdKMjA3WXVBT2lEc29JRHNucVVnN0pXSUlPMlZuQ0RyZ3JUc21xa05DaTBnN0pXSTY0SzBPaURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1ak95YWxEOGc3SjZGNjZDbDdaV2NJT3VDdE95YXFleWR0Q0RzZ3F6cm5ienNvTGpzbXBRdURRb3RJT3V5aE8yS3ZEb2c3SldFNjR1STdKaWtJTUszSU91RXBBMEtEUW9xS3UyTWtPdUxxTzJZbFNEaWdKUWc3SUt0N0tDY0lDanNuSVR0bDVncEtpb05DaTBnN1lPQTdKMjA3WXVBT2lEcmpiRHNuYlR0aExBZzdJS3Q3S0NjRFFvdElPeVZpT3VDDQp0RG9nN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEc2dyVHJwclFnN0lpWUlPeVhodXlXdE95YWxDNGc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3MEtMU0Ryc29UdGlydzZJT3lWaE91TGlPeVlwQ0RDdHlEcmhLUU5DZzBLS2lycmo1bnNucEh0bUpVZzRvQ1VJT3lFbk95SW9DQXJJT3VQbWV5ZWtTRHJzb1R0aXJ3cUtnMEtMU0R0ZzREc25iVHRpNEE2SU9xNHNPcTRzQ0RzbDdEcXNyQWc3WlcwN0tDY0RRb3RJT3lWaU91Q3REb2c3SVNnN1lPZDdaV2NJT3E0c09xNHNPeWRtQ0RzbDdEcXNyRHNuWVFnNjRHSzdKYTA3SnFVTGcwS0xTRHJzb1R0aXJ3NklPeTNxT3lHakNEQ3R5RHNsN0Rxc3JBZzdaVzA3S0NjRFFvTkNpb3E3SldJNjRLMDdaaVZJT0tBbENEc21ZVHJvNHdnN1lhMTY3TzBLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHFzckRzb0p3ZzdKbUU2Nk9NRFFvdElPeVZpT3VDdERvZzZyS3c3S0NjNnJDQUlPeWdsZXlEZ1NEc3NwanJwcXpya0pEc2xyVHNtcFF1RFFvdElPdXloTzJLdkRvZzdabVY3SjI0RFFvTg0KQ2lvcUtnMEtEUW9qSU95WWlPeVp1Q0RxdDV6c3Vaa05DZzBLN0p1UTdMbVpLT3VLcGV1UG1jSzM2cmlON0tDVndyZnN1cERzbzd6c2xyd3A2N08wNjR1a0lPeVlpT3ladU9xd2dDRHJqWlFnNjZxRjdabVY3WldjSU95N3BPdXVwT3VMaU95OGdPeWR0T3lGbU95ZGhDRHJwNHpyazV6cmlwUWc2cks5N0pxdzdKaUk3SnFVTGcwS0RRb2pJeURzbUlqc21iZ2dNUzRnN0lpWTY0K1o3WmlWSU91c3VPeWVwZXlkaENEc2phanJqNFFnNjVDWTY0cVVJT3F5dmV5YXNBMEtEUW9qSXlNZzdJU2M2N21FN0lxa0lPeWloZXVqakN3ZzZyaXc2ckNFSU91bmpPdWpqQTBLRFFyc2lKanJqNW50bUpYc25MenJvWndnN0pPdzY2bTBJT3lqdk95V3RDanNvb1hybzR3ZzdJU2M2N21FN0lxa0xDRHF1TERxc0lRZzY1T3hLZXVsdkNEcXNKWHNvYkR0bGFBZzdJaVlJT3llaU9xem9Dd2dKK3lpaGV1ampDZnNtWUFnSit1bmpPdWpqQ2ZzblpnZzY0bVk3SldaN0lxazY2VzhJT3lnbGUyWmxlMmVpQ0Rzb0lUcmk2enRsYUFnN0lpWUlPeWUNCmlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTQlBUMDhnN0lTYzY3bUU3SXFrSU95aWhldWpqQ0RzbFlqcmdyUWc0b0NVSURBdzdKdVVJREF3N0oyODY3YUE3WVN3SU95RW5PdTVoT3lLcE9xd2dDRHNvb1hybzR6cmo3enNtcFF1SU95ZWtPeUV1TzJWbkNEcmdyVHNtcW5zbllRZzdKV002NkNrNjVPYzY2Q2s3SnFVTGcwS0xTRHNucERzZ3JBZzdLR3c3WnFNSU9xNHNPcXdoT3lkdENEcXM2Y2c2NmVNNjZPTTY0Kzg3SnFVTGcwS0RRcnJpNmdzSUNvcTdLTzg2cml3N0tDQjdKeTg2NkdjSU95aWhldWpqT3F3Z0NEcnNKanJzN1hya0pqcmlwUWc3S0NjN1pLSUtpcnNsNURyaXBRZ0oreWloZXVqak91UHZPeWFsQ2ZycGJ3ZzdKT3c3S2VBSU95Vml1eVZoT3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNtS1RyaXBqc25aZ2c3WUMwN0thSTZyQ0FJT3F6cHlEc29vWHJvNHpyajd6c21wUWc0b2FTSU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQTBLRFFvakl5TWc3SUtzN0pxcDdKNlE3SmVRDQo2cktNSU91dnVPeTVtT3VLbENEc21JSHRscVhzbllRZzdKV002NkNrN0tTRUlPdVZqQTBLRFFvbzdLTzg3SnFVSU91UG1leUNyQ0E2SU95WHNPeXl0Q3dnN1pXMDdLZUFMQ0Rzb0lIc21xa2c2NU94S1EwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95ZHVPcXp2Q0RxdElEcXM0VHJwYndnNjZxRjdabVY3WldZNnJLTUlPeUVwT3VxaGUyVm1PcXpvQ3dnSit5Q3JPeWFxZXlla095ZG1DRHRsb25yajVuc2w1QWc2NVN3NjUyODdKaWs2NHFVSU9xeXNPcXp2Q2ZybmJ6cmlwUWc3S0NRN0oyRUlPeVZqT3VncE95a2hDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeVlwT3VLbU9xNWpPeW5nQ0RyZ3JUc3A0QWc3SldLN0p5ODY2bTBJT3lYc095eXRPdVB2T3lhbEM0ZzdadUU2N2FJNnJLdzdLQ2NJT3E0aU95Vm9leWRoQ0RyZ3JUc283enNoTGpzbXBRdURRb3RJT3VNZ095Mm5PeWRoQ0Rxc0lqc2xZVHRnNERycWJRZzdKdVE2NTZZSU91TWdPeTJuT3lkdENEdGxiVHNwNERyajd6cw0KbXBRdUlPeVlwT3VLbUNEcmdxRHNwNXpxdVl6c3A0RHNuWmdnN0oyMDdKNlE2Nlc4SU95ZGdPMldpZXlYa0NEcmdyVHNsYndnN1pXMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlFJT3lWaU95THJDQW83SWlZNjQrWjdaaVZLUTBLRFFvbjdLQ1Y2N08wSU95SW1PeW5rU0RzbFlqcmdyUW5JT3VUc2V5ZG1DRHJyN3pxc0pEdGxad2c3SU9CN1ptcDdKZVE3SVNjSUNvcTdJdWM3SXFrN1lXYzdKMjBJT3lla091UG1leWN2T3VobkNEc3NwanJwcXp0bFp6cmk2VHJpcFFnN0tDUUtpcnNuWVFnN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lkdE95Z25PdTJnTzJFc0NEdG1ZM3F1TGpyajVucmk1anNuWmdnNnJDYzdKMjQ3S0NWNjdPMElPeWR0T3lhcVNEcmdyVHNsNjNzbmJRZzZyaXc2NkdkNjQrODdKcVVEUW90SU91TmxDRHNvb3ZzbllBZzdJT0I2NHUwN0oyRUlPeWMNCmhPMlZ0Q0R0aHJYdG1aUWc2NEswN0pxcDdKMkFJT3VGdWV5ZGpPdVB2T3lhbEEwS0RRb2pJeURzbUlqc21iZ2dNaTRnNnJLOTdKYTA2Nlc4SU95TnFPdVBoQ0Rya0pqcmlwUWc2cks5N0pxd0RRb05DdTJLdWV5Z2xTRHNnNEh0bWFuc2w1RHNoSndnN0tDYzdaV2M3S0NCN0p5ODY2R2NJQ2ZzaTV6cmdwanNtcFEvTENEc2hhanJncGpzbXBRL0p5RHNuWmpyckxqdG1KVWc3SmEwNjYrNDY2VzhJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlE3SjJZSU91bnBldWR2ZXlkaENEdG1aenNtcW50bGJUc2hKd2c3S2VJNjZ5NDdaV2dJT3VWakEwS0RRb243SXVjNjRLWTdKcVVQeWNzSUNmc2hhanJncGpzbXBRL0p5RHRtSlh0ZzV6c25aZ2c2cks5N0phMDY2VzhJTzJabk95YXFlMlZ0T3lFbkNEc2dxenNtcW5zbnBEc25aZ2c2NHU1N1ptcDdJcWs2NStzN0p1QTdKMkVJT3lraE95ZHZDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPMlpqZXE0dU91UG1ldUxtQ3dnDQpUMDlQSU91THBPdUZnT3lZcE95RnFPdUNtT3lhbEQ4TkNpMGc3TGFwN0tDRTdaV1k2NStzSU8yT3VPeWRtT3lna0NEcXNJRHNpNXpyZ3Bqc21wUS9EUW9OQ2lNakl5RHNncXpzbXFuc25wRHNuWmdnN0lPQjdabXA3SjJFSU95MmxPeWdsZTJWb0NEcmxZd05DZzBLNjZxRjdabVY3WldjSU95Z2xldXp0T3F3Z0NEc2w0YnNsclRzaEp3ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU95bmdleWdrU0R0akpEcmk2anRsWmpxc293ZzdaVzA3Slc4SU8yVm9DRHJsWXdnNnJLOTdKYTA2NkdjSU95Z2xleWtrZTJWbU9xeWpDRHNwNGpyckxqdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHN1YlRyazV6cnBid2c2N0NiN0p5ODdJV282NEtZN0pxVVB5RHJrN0hyb1ozdGxaanJxYlFnN0xxUTdJdWM2N0N4SU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtPeWRtQ0RzaEtEc25aanFzSUFnN1pXRTdKcVU3WldnSU91VmpBMEtEUXJzaEtUcg0Kckxqc29iRHNncXpzc3Bqcm43d2c3SUtzN0pxcDdKNlE3SjJZSU95RW9PeWRtT3VsdkNEcXVMRHJqSUR0bGJUc2xid2c3WldnSU91VmpDRHFzcjNzbHJUcm9ad2c3S0NWN0tTUjdaV1k2cktNSU95bmlPdXN1TzJWdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbmJUcnNvZ2c2NHVzN0plUUlPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsWmpycWJUc2hKd2c3SmE4NjZlSTY0S1lJT3Vuak95aHNlMlZtT3lGcU91Q21PeWFsRDhOQ2cwS0l5TWc3SmlJN0ptNElETXVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBTkNnMEs3SUtzN0pxcDdKNlE3SmVRNnJLTUlPdXFoZTJabGUyVm1PcXlqQ0RydG9Ec29KWHNvSUhzbmJnZzY0SzA3SnFwN0oyRUlPeVZqT3VncE95a21PeVZ2Q0R0bGFBZzY1V002NHFVSU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU95aWkreVZoT3lhbEM0TkNnMEtJeU1qSU95RW5PdTVoT3lLcE91bHZDRHNvSlhzc1lYc2c0RWcNCjdKTzRJT3lJbUNEc2w0YnNuWVFnNjVXTURRb05DdXUyZ095Z2xlMllsZXljdk91aG5DRHNqYWpzbGJ3ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU95RGdlMlpxZXlkaENEcnFvWHRtWlh0bFpqcXNvd2c3SjI0N0tlQTdJdWM3WUtzSU95SW1DRHNub2pzbHJUc21wUXVJQ29xN0pPNElPeUltQ0RzbDRicmlwUWc3SjIwN0p5ZzY2VzhJTzJWcU9xN21DRHNsWWpyZ3JUdGxiVHNvN3pzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEc3A0RHF1SWpzbllBZzZyQ0E3SjZGN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SU95eXJleUdqT3VGaE95ZGhDRHNuSVR0bFp3ZzdJU2M2N21FN0lxazY0cVVJT3lWaE95bmdTRHNwSURydVlRZzdLU1I3SjIwN0plUTdKcVVMZzBLTFNEcXM3WHJyTFRzbTVEc25ZQWc3WnVFN0p1UTZyaUk3SjJFSU91enRPdUN2Q0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtEUW9qSXlNZzdKMjg2N2FBSU9xNHNPdUtwZXVuakNEc2s3Z2c3SWlZSU95WGh1eWRoQ0RybFl3TkNnMEs2N2FBN0tDVjdaaVY3Snk4DQo2NkdjSU95TnFPeVZ2Q0RzZ3F6c21xbnNucERxc0lBZzdKYTA2NWFrSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95WGh1dUtsT3luZ0NEcnFvWHRtWlh0bFpqcXNvd2c3SjI0N0tlQTdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrTkNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGcwS0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UUlPeUVvTzJEbmV5ZG1DRHFzckRxczd6cnBid2c3SldJNjRLMDdaV2dJT3VWakEwS0RRcnJrSmpyajR6cnByUWc3SWlZSU95WGh1dUtsQ0RzaEtEdGc1M3NuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMlZtT3F5akNEc2xZenJvS1RzbXBRdURRb05DdXlZaUNrTkNpMGc3WldjSU91eQ0KaUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzROQ2cwS0l5TWpJT3lDck95YXFleWVrQ0RzbFlqc2k2d2dLT3UyZ095Z2xlMllsU2tOQ2cwS0oreWdsZXV6dENEc2lKanNwNUVnN0pXSTY0SzBKeURyazdIc25aZ2c2Nis4NnJDUTdaV2NJT3lEZ2UyWnFleVhrT3lFbkNBcUt1eWdsZXV6dE9xd2dDRHJzN1R0bUxqcmtKenJpNlRyaXBRZzdLQ1FLaXJzbllRZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95RGdldUx0T3lkdENEcmdaM3JncGpycWJRZzdLQ0U2Nnk0NnJDQTY0K0VJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHNvSlhyczdUcnBid2c2N084SU95SW1DRHNsNGJzbHJUc21wUXVEUW90SU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHFzSUFnNnJpdzY2R2Q2NUNZN0tlQUlPeVYNCml1eVZoT3lhbEM0TkNnMEtJeU1nN0ppSTdKbTRJRFF1SU95Z25PMlNpQ0RzbXFuc2xyVHJpcFFnNjdDVTZyNjQ3S2VBSU95Vml1cTRzQTBLRFFvbjZyQ0U2ckt3N1pXWTZyT2dJT3lKck95YXRDRHJwNUFuSU95YmtPeTVtZXV6dE91THBDQXFLdTJabE91cHRPeWRtQ0RxdUxEcmlxWHJxb1hDdCt1eWhPMkt2T3VxaGVxenZPeWRtQ0RzbXFuc2xyUWc3SjI4N0xtWUtpcnFzSUFnN0pxdzdJU2c3SjIwN0plUTdKcVVMZzBLNnJpdzY0cWw2NnFGN0plUUlPeVRzT3lkdUNEcmk2anNsclFvNjdPQTZySzlMQ0RzcDREc29KVXNJT3VUc2V1aG5TRHJrN0VwNjZXOElPeVZpT3VDdENEcnJManF0YXpzbDVEc2hKd2c2NHVrNjZXNElPdW5rT3VobkNEcnNKVHF2cmpycWJRZzdJS3M3SnFwN0o2UTZyQ0FJT3VMcE91bHVDRHF1TERyaXFYc25MenJvWndnN0ppazdaVzA3WldnSU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa2dKK3Eyak8yVm5DRHJzNERxc3IwbklPcTRzT3VLcGV5ZG1DRHNsWWpyZ3JRZzY2eTQ2cldzDQpEUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxaanJxYlFnNjdDVTZyK0FJT3lJbUNEc25vanNsclRzbXBRZ0tGZ3BEUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxaanJxYlFnNjdPQTZySzk3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJT3lZaU95WnVDQTFMaURzaTV6c2lxVHRoWndnNjQrWjdKNlI2ck84SU91THBPdWx1Q0RyajVuc2dxd2c3Sk93N0tlQUlPeVZpdXE0c0EwS0RRcnJyTGpxdGF6cnBid2c3SldFNjZ5MDY2YXNJT3VucE91QmhPdWZ2ZXF5akNEcmk2VHJrNnpzbHJUcmo0UWdLaXJzaTZUc29Kd2c3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyaTZUcnBiZ2c2NCtaN0lLc0tpcnJwYndnN0pPdzY2bTBJT3llbU91cXUrdVFuQ0RyckxqcXRhenNtSWpzbXBRdURRb05DdXlZaUNrZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZQ0Ka091bHZDQW43TGFVNnJDQUlPeW5nT3lnbFNmdGxaanJpcFFnN0l1YzdJcWs3WVdjN0plUTdJU2NJQ2pzbmJUc29JVEN0K3lXa2V1UGhDRHF1TERyaXFYc25iUWc3SldFNjR1WUtRMEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKZVE2cktNSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcnBid2c2NFNZNnJLbzdLTzg3SVM0N0pxVUlDaFlJT0tBbENEc2w0YnJpcFFnSit1RW1PcTRzT3E0c0NjZzZyaXc2NHFsN0oyRUlPeVZsT3lMbkNrTkNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWdENEc283enNoTGpzbXBRZ0tFOHBEUW89DQo6OkxBVU5DSEVSOjoNCi8vNG5BQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkNBSElBYVFCa0FHY0FaUUFnQUd3QVlRQjFBRzRBWXdCb0FHVUFjZ0FnQUJRZ0lBRG9zc1NzeEx3Z0FDVEJGY2dnQUJESWdLd2dBTVRXSUFEa3NxeTVJQURrd29uVkNnQW5BQ0FBWXdCc0FHRUFkUUJrQUdVQVlnQnlBR2tBWkFCbkFHVUFPZ0F2QUM4QUlBQUUxVnk0b05GY3ozVEhJQUIweHlBQUROTjh4MFRISUFDQXZYaTU1TElnQUNnQThiUmR1RG9BSUFCdUFIQUFiUUFnQUdrQWJnQnpBSFFBWVFCc0FHd0FJQUFRdHBTeUlBQWlBSFRRWExqY3RDQUE1TTRsc1REUklnQWdBQ1RCV000Z0FBelRmTWNwQUM0QUNnQW5BQ0FBVkxzQXJDQUFZTDQ0eUNBQWlNYzh4M1M2SUFCYzFTQUFpTHpReFNBQVdOV1lzQ25GSUFCSXhiU3dXTlhnckN3QUlBRGtzaUFBQU1sRXZoaTBkTG9nQU9TeXJMbDh1U0FBUGN3Z0FNYkZkTWNnQU9UQ2lkVmMxZVN5TGdBS0FGTUFaUUIwQUNBQVpnQnpBRzhBSUFBOUFDQUFRd0J5QUdVQVlRQjBBR1VBVHdCaUFHb0FaUUJqQUhRQUtBQWlBRk1BDQpZd0J5QUdrQWNBQjBBR2tBYmdCbkFDNEFSZ0JwQUd3QVpRQlRBSGtBY3dCMEFHVUFiUUJQQUdJQWFnQmxBR01BZEFBaUFDa0FDZ0JUQUdVQWRBQWdBSE1BYUFBZ0FEMEFJQUJEQUhJQVpRQmhBSFFBWlFCUEFHSUFhZ0JsQUdNQWRBQW9BQ0lBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRk1BYUFCbEFHd0FiQUFpQUNrQUNnQmtBR2tBY2dBZ0FEMEFJQUJtQUhNQWJ3QXVBRWNBWlFCMEFGQUFZUUJ5QUdVQWJnQjBBRVlBYndCc0FHUUFaUUJ5QUU0QVlRQnRBR1VBS0FCWEFGTUFZd0J5QUdrQWNBQjBBQzRBVXdCakFISUFhUUJ3QUhRQVJnQjFBR3dBYkFCT0FHRUFiUUJsQUNrQUNnQnpBR2dBTGdCREFIVUFjZ0J5QUdVQWJnQjBBRVFBYVFCeUFHVUFZd0IwQUc4QWNnQjVBQ0FBUFFBZ0FHUUFhUUJ5QUFvQUNnQW5BQ0FBTVFBdkFESUFLUUFnQUU0QWJ3QmtBR1VBTGdCcUFITUFJQUFReUlDc0lBQVVJQ0FBeHNVOHgzUzZJQURrc3JUR1hMamN0Q0FBbU5OMHg4REpmTGtnQVBURnRNVUF5ZVN5Q2dCSkFHWUFJQUJ6QUdnQQ0KTGdCU0FIVUFiZ0FvQUNJQVl3QnRBR1FBSUFBdkFHTUFJQUIzQUdnQVpRQnlBR1VBSUFCdUFHOEFaQUJsQUNJQUxBQWdBREFBTEFBZ0FGUUFjZ0IxQUdVQUtRQWdBRHdBUGdBZ0FEQUFJQUJVQUdnQVpRQnVBQW9BSUFBZ0FFa0FaZ0FnQUUwQWN3Qm5BRUlBYndCNEFDZ0FJZ0JPQUc4QVpBQmxBQzRBYWdCekFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGk0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQmJBRlhXZU1kZEFFVEhJQUFFc25TNWRMb2dBT1N5dE1aY3VOeTBJQUNZMDNUSHdNa0FyQ0FBOU1XOXVjaXk1TEl1QUNBQUpNRll6bnk1SUFESXVWek9JQUNrdEN3QUlBQU0xZXkzK0sxNHg5REZITUVnQUhUUVhMamN0Q0FBaEx5ODBrVEhJQURrc3R6Q0lBQU1zdXkzSUFEOHlEakJsTVl1QUNJQUxBQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUENCklBQjJBR0lBVHdCTEFFTUFZUUJ1QUdNQVpRQnNBQ0FBS3dBZ0FIWUFZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FERUFMd0F5QUNrQUlBQVVJQ0FBVGdCdkFHUUFaUUF1QUdvQWN3QWlBQ2tBSUFBOUFDQUFkZ0JpQUU4QVN3QWdBRlFBYUFCbEFHNEFDZ0FnQUNBQUlBQWdBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQm9BSFFBZEFCd0FITUFPZ0F2QUM4QWJnQnZBR1FBWlFCcUFITUFMZ0J2QUhJQVp3QXZBR3NBYndBdkFHUUFid0IzQUc0QWJBQnZBR0VBWkFBaUFBb0FJQUFnQUVVQWJnQmtBQ0FBU1FCbUFBb0FJQUFnQUZjQVV3QmpBSElBYVFCd0FIUUFMZ0JSQUhVQWFRQjBBQW9BUlFCdUFHUUFJQUJKQUdZQUNnQUtBQ2NBSUFBeUFDOEFNZ0FwQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0FBRU1pQXJDQUFGQ0FnQU1iRlBNZDB1aUFBSk1GWXpyY0FYTGo0clhqSElBQXB2Slc4Uk1jZ0FFakZ0TEJjMWVTeUNnQkpBR1lBDQpJQUJ6QUdnQUxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BSUFCM0FHZ0FaUUJ5QUdVQUlBQmpBR3dBWVFCMUFHUUFaUUFpQUN3QUlBQXdBQ3dBSUFCVUFISUFkUUJsQUNrQUlBQThBRDRBSUFBd0FDQUFWQUJvQUdVQWJnQUtBQ0FBSUFCTkFITUFad0JDQUc4QWVBQWdBQ0lBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGlBQUtBQVF0cFN5SUFCUUFFRUFWQUJJQU5ERklBREd4YlRGbE1ZcEFDNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdBdzBmaTdFTEhReFJ6QklBQkV4WmkzZkxrZ0FDVEJXTTYzQUZ5NCtLMTR4MXpWSUFDa3RDd0FJQUIwMEZ5NDNMUWdBSVM4dk5KRXh5QUE1TExjd2lBQURMTHN0eUFBL01nNHdaVEdPZ0FpQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQQ0KSmdBZ0FGOEFDZ0FnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFpQUNBQUlBQnVBSEFBYlFBZ0FHa0FiZ0J6QUhRQVlRQnNBR3dBSUFBdEFHY0FJQUJBQUdFQWJnQjBBR2dBY2dCdkFIQUFhUUJqQUMwQVlRQnBBQzhBWXdCc0FHRUFkUUJrQUdVQUxRQmpBRzhBWkFCbEFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBSUFBZ0FHTUFiQUJoQUhVQVpBQmxBQ0FBYkFCdkFHY0FhUUJ1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFWZFo0eHlBQUtieVZ2RG9BSUFBdzBmaTdFTEhReFJ6QklBQmpBR3dBWVFCMUFHUUFaUUFnQUMwQUxRQjJBR1VBY2dCekFHa0Fid0J1QUNBQWRNY2dBSVM4Qk1oRXh5QUFuTTBsdUZqVmRMb2dBQURKUkw0Z0FFVEd6TGlGeDhpeTVMSXVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUENClh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBS0FDc3dLbkd5YmRBeHlBQWRNY2dBRkFBUXdEUXhTQUFYTGo0clhqSEhMUWdBSFRRWExqY3RDQUFiSzNGc3lBQVhOWEVzOURGSE1FZ0FDak1FS3dwdE1peTVMSXVBQ2tBSWdBc0FDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUhZQVlnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURJQUx3QXlBQ2tBSUFBVUlDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNJQUNnQWdBQ0FBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRkVBZFFCcEFIUUFDZ0JGQUc0QVpBQWdBRWtBWmdBS0FBb0FKd0FnQUFESlJMNGdBRVRHekxnZ0FCUWdJQURrc3F5NWZMa2dBRDNNSUFER3hYVEhJQURrd29uVklBQW9BQXpWN0xmNHJYakhkTWNnQU9lc0lBQ1F4OW16SUFBUXJNREpLUUFLQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JqQUcwQVpBQWdBQzhBWXdBZ0FHNEFid0JrQUdVQUlBQnpBR01BDQpjZ0JwQUhBQWRBQnpBRndBWXdCc0FHRUFkUUJrQUdVQUxRQmlBSElBYVFCa0FHY0FaUUF1QUdvQWN3QWlBQ3dBSUFBd0FDd0FJQUJHQUdFQWJBQnpBR1VBQ2dBPQ0KOjpXQVRDSEVSOjoNCkx5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tOQ2k4dklPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQTBLTHk4ZzdKbWNJTzJWaE95YWxPMlZuT3F3Z0RvZzdaUzg2cmU0NjZlSTZyQ0FJTzJVak91ZnJPcTN1T3lkdU95ZG1DQmpiR0YxWkdWaWNtbGtaMlU2THk4ZzdKZTA2cml3S0hkcGJtUnZkeTV2Y0dWdUwybG1jbUZ0WlM5dmNHVnVSWGgwWlhKdVlXd3A2Nlc4DQpEUW92THlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293TkNpOHZJRkJQVTFRZ0wzZGhhMlVnNjZXOElPdXp0T3VDdE91cHRDRHFzSkRzaTV6c25wRHFzSUFnNjR1azY2YXNLR05zWVhWa1pTMWljbWxrWjJVdWFuTXA2Nlc4SU91TWdPeUxvQ0RzdktEcmk2UXVEUW92THcwS0x5OGc2NHVrNjZhczdKbUE3SjJZSU95d3FPeWR0RG9nNnJDUTdJdWM3SjZRNjRxVUlHTnNZWFZrWmV1bHZDRHJyTHpzcDRBZzdKV0s2NHFVNjR1a0tPeWVrT3lMblNEc2w0YnNuWXdwSU9LR2tpRHRnYlRyb1p6cms1d2c3Sld4SU95WGhldU5zT3lkdE8yS3VPdWx2Q0RzbFlnZzY2ZUo2ck9nTEEwS0x5OGc2Nm1VNjZxbzY2YXNJSDR4TlUxQzY1MjhJT3Vobk9xM3VPeWR1Q0RzaTV3ZzdKNlE2NCtaSU95TG5PeWVrZXljdk91aA0KbkNEc2c0SHNpNXdnN0x5YzY1R3M2NCtFSU91MmdPdUx0Q0RzbDRicmk2UWdLT3VUc2V1aG5Ub2dibkJ0SUhKMWJpQmlkV2xzWkNrdURRb3ZMeURyaTZUcnBxenJpcFFnN0l1czdKNmw2N0NWNjQrWklPdUJpdXE0c091cHRDRHNvNzNzcDREcnA0d283WlNNNjUrczZyZTQ3SjI0NnJPOElPeURuZXlDckNEcmo1bnF1TER0bVpRcExDRHFzSkRzaTV6c25wRHJpcFFnNnJPRTdJYU5JT3VDcU95VmhDRHJpNlRzbll3ZzZybW83SnF3NnJpdzY2VzhJT3V3bSt1S2xPdUxwQzROQ2cwS1kyOXVjM1FnYUhSMGNDQTlJSEpsY1hWcGNtVW9KMmgwZEhBbktUc05DbU52Ym5OMElIQmhkR2dnUFNCeVpYRjFhWEpsS0Nkd1lYUm9KeWs3RFFwamIyNXpkQ0JtY3lBOUlISmxjWFZwY21Vb0oyWnpKeWs3RFFwamIyNXpkQ0J2Y3lBOUlISmxjWFZwY21Vb0oyOXpKeWs3RFFwamIyNXpkQ0I3SUhOd1lYZHVMQ0J6Y0dGM2JsTjVibU1nZlNBOUlISmxjWFZwY21Vb0oyTm9hV3hrWDNCeWIyTmxjM01uS1RzTkNnMEtZMjl1YzNRZ1VFOVMNClZDQTlJREV4T0RnNU93MEtZMjl1YzNRZ1VrOVBWQ0E5SUhCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNwT3lBdkx5RHNvSURzbnFYc2hvd2c2Nk9vN1lxNElPS0FsQ0RyaTZUcnBxenFzSUFnY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xazY2VzhJT3l3dnV1S2xDRHF1TERzcElBTkNnMEtZMjl1YzNRZ1EwOVNVMTlJUlVGRVJWSlRJRDBnZXcwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VDNKcFoybHVKem9nSnlvbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFRXVjBhRzlrY3ljNklDZEhSVlFzSUZCUFUxUXNJRTlRVkVsUFRsTW5MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RTR1ZoWkdWeWN5YzZJQ2REYjI1MFpXNTBMVlI1Y0dVbkxBMEtmVHNOQ21aMWJtTjBhVzl1SUdwemIyNG9jbVZ6TENCemRHRjBkWE1zSUc5aWFpa2dldzBLSUNCeVpYTXVkM0pwZEdWSVpXRmtLSE4wWVhSMWN5d2dUMkpxWldOMExtRnpjMmxuYmloN0lDZERiMjUwDQpaVzUwTFZSNWNHVW5PaUFuWVhCd2JHbGpZWFJwYjI0dmFuTnZianNnWTJoaGNuTmxkRDExZEdZdE9DY2dmU3dnUTA5U1UxOUlSVUZFUlZKVEtTazdEUW9nSUhKbGN5NWxibVFvU2xOUFRpNXpkSEpwYm1kcFpua29iMkpxS1NrN0RRcDlEUW9OQ2k4dklHTnNZWFZrWlNCRFRFbnFzSUFnN0o2STY0cVU3S2VBSU9LQWxDRHNsNGJzbkx6cnFiUWdMM2RoYTJVZzdKMlI2NHUxN0plUUlPeUxwT3lXdENEdGxJenJuNnpxdDdqc25ianNuYlFnN0pXSTY0SzA3WldnSU95SW1DRHNub2pxc293ZzdaV2M2NHVrRFFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzROQ2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENBeg0KTU95MGlDRHN1cERzaTV3dUlPeWVyT3Vobk9xM3VPeWR1TzJWbU91cHRDQkRURW5xc0lBZzdZeU03SjI4N0oyRUlPcXdzZXlMb08yVm1PdXZnT3VobkNEc25wRHJqNWtnNjdDWTdKaUI2NUNjNjR1a0xnMEtMeThnN0xxUTdJdWNJRFhzdElnZzRvQ1VJT3Vobk9xM3VPeWR1Q0RzcDRIdG00UWc3SU9JSU9xemhPeWdsZXlkdENEcXM2ZnJzSlRyb1p3ZzdKNmg3WmlBN0pXOElPMlVqT3Vmck9xM3VPeWR1T3lkdENEcm9aenF0N2pzbmJnZzdabVU2Nm0wN0plUTdJU2NJTzJaaU95Y3ZPdWhuQ0RyaEpqc2xyVHFzSVRyaTZRb016RHN0SWpycWJRZzY0U0k2NnkwSU91S3B1eWRqQ2tOQ214bGRDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUF3TENCbGJXRnBiRG9nYm5Wc2JDQjlPdzBLWm5WdVkzUnBiMjRnWTJ4aGRXUmxRV05qYjNWdWRDZ3BJSHNOQ2lBZ2FXWWdLRVJoZEdVdWJtOTNLQ2tnTFNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUENBMU1EQXdLU0J5WlhSMWNtNGdZV05qYjNWdWRFTmhZMmhsTG1WdFlXbHMNCk93MEtJQ0JzWlhRZ1pXMWhhV3dnUFNCdWRXeHNPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3cwS0lDQWdJR1Z0WVdsc0lEMGdLR29nSmlZZ2FpNXZZWFYwYUVGalkyOTFiblFnSmlZZ2FpNXZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOektTQjhmQ0J1ZFd4c093MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyb1p6cXQ3anNuYmdnN0oyMDY2Q2xJT3lYaHV5ZGpDRHJrN0VnNG9DVUlHNTFiR3dnS2k4Z2ZRMEtJQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lCRVlYUmxMbTV2ZHlncExDQmxiV0ZwYkNCOU93MEtJQ0J5WlhSMWNtNGdaVzFoYVd3N0RRcDlEUW9OQ21aMWJtTjBhVzl1SUdoaGMwTnNZWFZrWlNncElIc05DaUFnWTI5dWMzUWdabWx1WkdWeUlEMGdjSEp2WTJWemN5NXdiR0YwDQpabTl5YlNBOVBUMGdKM2RwYmpNeUp5QS9JQ2QzYUdWeVpTY2dPaUFuZDJocFkyZ25PdzBLSUNCMGNua2dleUJ5WlhSMWNtNGdjM0JoZDI1VGVXNWpLR1pwYm1SbGNpd2dXeWRqYkdGMVpHVW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhOb1pXeHNPaUIwY25WbElIMHBMbk4wWVhSMWN5QTlQVDBnTURzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnY21WMGRYSnVJR1poYkhObE95QjlEUXA5RFFvTkNteGxkQ0IzWVd0cGJtY2dQU0JtWVd4elpUc2dMeThnN0pldzdZT0FJT3V3cWV5bmdDRGlnSlFnNjR1azY2YXM2NHFVSU95V3RPeXdxTzJVdkNCRlFVUkVVa2xPVlZORjY2R2NJT3lra2V1enRTRHNvSlhycHF6dGxaanNwNERycDR3ZzdaU0U2NkdjN0lTNDdJcWtJT3VDcmV1NWhPdWx2Q0RzcElUc25ianJpNlFOQ21aMWJtTjBhVzl1SUhkaGEyVkNjbWxrWjJVb0tTQjdEUW9nSUdsbUlDaDNZV3RwYm1jcElISmxkSFZ5YmpzTkNpQWdkMkZyYVc1bklEMGdkSEoxWlRzTkNpQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOQ0KUGlCN0lIZGhhMmx1WnlBOUlHWmhiSE5sT3lCOUxDQTFNREF3S1RzTkNpQWdiR1YwSUhCeWIyTTdEUW9nSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3RFFvZ0lDQWdMeThnVjJsdVpHOTNjem9nWTIxa3dyZDJZbk1nNnJLOTdKeWdJT3lYaHV5ZHRDQnViMlJsNjZXOElPeW5nZXlna1N3Z2QybHVaRzkzYzBocFpHVW9RMUpGUVZSRlgwNVBYMWRKVGtSUFZ5bnJvWndnN0lxazdZK3dJT0tBbEEwS0lDQWdJQzh2SU95d3ZTRHNsNGJyaXBRZzdJaW83SjJBSU95OW1PeUdsT3lkdENEcnA0enJrNlRzbHJUc3A0RHFzNkFnNjR1azY2YXM3SjJZSU95ZWtPeUxuU2hqYkdGMVpHVXA2NCtFSU9xM3VDRHN2WmpzaHBUc25ZUWc2Nnk4NjZDazY3Q2I3SldFSU95V3RPdVdwQ0Rzc0wzcmo0UWc3SldJSU91Y3JPdUxwQzROQ2lBZ0lDQXZMeUJrWlhSaFkyaGxaT3VLbENEc2s3RHNwNEFnN0pXSzY0cVU2NHVrS0dSbGRHRmphR1ZrSzNkcGJtUnZkM05JYVdSbElPeWhzTzJWcWV5ZGdDRHMNCnZaanNocFFnN0xDOTdKMjBJT3VGdU95Mm5PdVFxQ0RpZ0pRZzdJdWs3TGloS1M0TkNpQWdJQ0F2THlCWGFXNWtiM2R6N0plUTdJU2dJR1JsZEdGamFHVmtJT3lYaHV5ZHRPdVBoQ0RydG9EcnFxZ282ckNRN0l1YzdKNlFLZXF3Z0NEc283M3NsclRyajRRZzdKNlE3SXVkN0oyQUlPeUN0T3lWaE91Q3FPdUtsT3VMcEM0TkNpQWdJQ0J3Y205aklEMGdjM0JoZDI0b2NISnZZMlZ6Y3k1bGVHVmpVR0YwYUN3Z1czQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2RqYkdGMVpHVXRZbkpwWkdkbExtcHpKeWxkTENCN0RRb2dJQ0FnSUNCamQyUTZJRkpQVDFRc0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2QybHVaRzkzYzBocFpHVTZJSFJ5ZFdVc0RRb2dJQ0FnZlNrN0RRb2dJSDBnWld4elpTQjdEUW9nSUNBZ0x5OGdiV0ZqVDFNdjY2YXM2NGlGN0lxa09pRHFzSkRzaTV6c25wRHJwYndnNjUyRTdKcTBJRzV2WkdVZzdJdWs3WmFKSU8yTWpPeWR2T3VobkNEc3A0SHNvSkVnN0lxazdZK3dJQ2hzWVhWdVkyaGtJTzJaDQptT3F5dmV5WGxDQlFRVlJJNnJDQUlPdTVpT3lWdmUyVm9DRHNpSmdnN0o2STdKYTBJT3lnaU91TWdPcXl2ZXVobkNEc2dxenNtcWtwRFFvZ0lDQWdjSEp2WXlBOUlITndZWGR1S0hCeWIyTmxjM011WlhobFkxQmhkR2dzSUZ0d1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5ZMnhoZFdSbExXSnlhV1JuWlM1cWN5Y3BYU3dnZXcwS0lDQWdJQ0FnWTNka09pQlNUMDlVTENCa1pYUmhZMmhsWkRvZ2RISjFaU3dnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQTBLSUNBZ0lIMHBPdzBLSUNCOURRb2dJSEJ5YjJNdWRXNXlaV1lvS1RzZ0x5OGc2ckNRN0l1YzdKNlFJT3lkdE91eXBPMkt1Q0RybzZqdGxJVHNsNURzaEp3ZzY3YUU2NmFzSUNqcXNKRHNpNXpzbnBBZzdLS0Y2Nk9NNjZXOElPdW5pZXluZ0NEc2xZcnFzb3dwRFFwOURRb05DaTh2SU95ZHRDQlFRK3VsdkNBbjdJU2s3TG1ZSU95Z2hDanNnNGdnVUVNcEp5RHNnNEh0ZzV6cm9ad2c2NUNZNjQrTTY2YXc2NHVrSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnVyt5MA0KaU9xNHNPMlpsRjBnNjdLRTdZcThLRkJQVTFRZ0wzVnVhVzV6ZEdGc2JDbnNuYlFnNjdhQTY2VzQ2NHVrTGcwS0x5OGdjbVZuYVhOMFpYSXRjSEp2ZEc5amIyd3VhblBxc0lBZzdJU2s3TG1ZN1pXY0lPcXlnK3lkaENEcXQ3anJqSURyb1p3ZzY1Q1k2NCtNNjZhdzY0dWtPaURxc0pEc2k1enNucEFnN0o2UTY0K1o3SXVjN0o2UklDc2dLT3llaU95Y3ZPdXB0Q2tnN0lTazdMbVlJTzJQdE91TmxDNE5DaTh2SU9LYW9PKzRqeURyc0pqcms1enNpNXdnU0ZSVVVDRHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPdXp0T3VDdUNEcmtxUWc3Wmk0N0xhYzdaV2dJT3F5Z3lEaWdKUWdiV0ZqVDFNZ2JHRjFibU5vWTNSc0lHSnZiM1J2ZFhUc25iUWc3SjIwSU8yVWhPdWhuT3lFdU95S3BPdWx2Q0RzcG9uc2k1d2c3S0tGNjZPTTdJdWM3WUtzSU95SW1DRHNub2pyaTZRdURRb3ZMeUFnSUNEcXQ3anJucGpzaEp3ZzdZeU03SjI4S0hCc2FYTjB3cmZzaEtUc3VaZ2c3WSswNjQyVUtleWRoQ0JzWVhWdVkyaGpkR3pyczdUcmk2UWcNCjY2aTg3S0NBSU95bmdPeWF0T3VMcENEaWdKUWdZbTl2ZEc5MWRPeWR0Q0RzbXJEcnBxenJwYndnN0tPOTdKZXM2NCtFSU95ZWtPdVBtZXlMbk95ZWtleWRnQ0RzbmJUcnI3Z2c3SUtzNjUyODdLZUU2NHVrTGcwS1puVnVZM1JwYjI0Z2RXNXBibk4wWVd4c1UyVnNaaWdwSUhzTkNpQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlGdGRPdzBLSUNCMGNua2dldzBLSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBblpHRnlkMmx1SnlrZ2V3MEtJQ0FnSUNBZ1kyOXVjM1FnVEVGQ1JVd2dQU0FuWTI5dExtTnNZWFZrWldKeWFXUm5aUzUzWVhSamFHVnlKenNOQ2lBZ0lDQWdJR052Ym5OMElIQnNhWE4wSUQwZ2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSjB4cFluSmhjbmtuTENBblRHRjFibU5vUVdkbGJuUnpKeXdnVEVGQ1JVd2dLeUFuTG5Cc2FYTjBKeWs3RFFvZ0lDQWdJQ0JqYjI1emRDQnBibk4wSUQwZ2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSjB4cFluSmhjbmtuDQpMQ0FuUVhCd2JHbGpZWFJwYjI0Z1UzVndjRzl5ZENjc0lDZERiR0YxWkdWQ2NtbGtaMlVuS1RzTkNpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLSEJzYVhOMEtTa2dleUJtY3k1MWJteHBibXRUZVc1aktIQnNhWE4wS1RzZ2NtVnRiM1psWkM1d2RYTm9LSEJzYVhOMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQWdJSFJ5ZVNCN0lITndZWGR1VTNsdVl5Z25iR0YxYm1Ob1kzUnNKeXdnV3lkaWIyOTBiM1YwSnl3Z0oyZDFhUzhuSUNzZ2NISnZZMlZ6Y3k1blpYUjFhV1FvS1NBcklDY3ZKeUFySUV4QlFrVk1YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrNw0KSUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHNZWFZ1WTJoamRHd25MQ0JiSjNKbGJXOTJaU2NzSUV4QlFrVk1YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwS0lDQWdJSDBnWld4elpTQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3MEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0NkeVpXY25MQ0JiSjJSbGJHVjBaU2NzSUNkSVMwTlZYRnhUYjJaMGQyRnlaVnhjVFdsamNtOXpiMlowWEZ4WGFXNWtiM2R6WEZ4RGRYSnlaVzUwVm1WeWMybHZibHhjVW5WdUp5d2dKeTkySnl3Z0owTnNZWFZrWlVKeWFXUm5aVmRoZEdOb1pYSW5MQ0FuTDJZblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUhKbGJXOTJaV1F1Y0hWemFDZ243SjZRNjQrWjdJdWM3SjZSS0VOc1lYVmtaVUp5YVdSblpWZGhkR05vWlhJcEp5azdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEsNCklDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5WldjbkxDQmJKMlJsYkdWMFpTY3NJQ2RJUzBOVlhGeFRiMlowZDJGeVpWeGNRMnhoYzNObGMxeGNZMnhoZFdSbFluSnBaR2RsSnl3Z0p5OW1KMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE95QnlaVzF2ZG1Wa0xuQjFjMmdvSjJOc1lYVmtaV0p5YVdSblpUb3ZMeURyazdIcm9aMG5LVHNnZlNCallYUmphQ0FvWDJVcElIdDlEUW9nSUNBZ0lDQjBjbmtnZXcwS0lDQWdJQ0FnSUNCamIyNXpkQ0JwYm5OMElEMGdjR0YwYUM1cWIybHVLSEJ5YjJObGMzTXVaVzUyTGt4UFEwRk1RVkJRUkVGVVFTQjhmQ0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5RWEJ3UkdGMFlTY3NJQ2RNYjJOaGJDY3BMQ0FuUTJ4aGRXUmxRbkpwWkdkbEp5azdEUW9nSUNBZ0lDQWdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLR2x1YzNRcEtTQjdJR1p6TG5KdFUzbHVZeWhwYm5OMExDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTd2dabTl5WTJVNklIUnlkV1VnDQpmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZRMEtJQ0FnSUNBZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdmUTBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lCbVlXbHNMWE52Wm5RZzRvQ1VJT3VxdXlEc3A0RHNtclFnNnJLTUlPeWVpT3lXdE91UGhDRHRsSXpybjZ6cXQ3anNuYmdnN0txOUlPcTRzT3lXdFNEc2dxM3NvSnpyaXBRZzdKMjA2Nis0SU91Qm5ldUNyT3VMcENBcUx5QjlEUW9nSUhKbGRIVnliaUJ5WlcxdmRtVmtPdzBLZlEwS0RRb3ZMeURyaTZUcnBxd29NVEU0T0RncDZyQ0FJT3VXb0NEc25vanNuTHpycWJRZzY0R0k2NHVrSU9LQWxDRHN0SWpxdUxEdG1aUWc3SXVjSU91Q3FPeWRnQ0RzaExqc2haZ2c3S0NWNjZhc0lDanNsNGJzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lMcE8yTXFDa05DbVoxYm1OMGFXOXVJSE5vZFhSa2IzZHVRbkpwWkdkbEtDa2dldzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUhJZ1BTQm9kSFJ3TG5KbGNYVmxjM1FvZXlCb2IzTjBPaUFuTVRJMw0KTGpBdU1DNHhKeXdnY0c5eWREb2dNVEU0T0Rnc0lIQmhkR2c2SUNjdmMyaDFkR1J2ZDI0bkxDQnRaWFJvYjJRNklDZFFUMU5VSnl3Z2RHbHRaVzkxZERvZ01UVXdNQ0I5TENBb0tTQTlQaUI3ZlNrN0RRb2dJQ0FnY2k1dmJpZ25aWEp5YjNJbkxDQW9LU0E5UGlCN2ZTazdEUW9nSUNBZ2NpNXZiaWduZEdsdFpXOTFkQ2NzSUNncElEMCtJSHNnZEhKNUlIc2djaTVrWlhOMGNtOTVLQ2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmU0I5S1RzTkNpQWdJQ0J5TG1WdVpDZ3BPdzBLSUNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ24wTkNnMEtZMjl1YzNRZ2MyVnlkbVZ5SUQwZ2FIUjBjQzVqY21WaGRHVlRaWEoyWlhJb0tISmxjU3dnY21WektTQTlQaUI3RFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5UMUJVU1U5T1V5Y3BJSHNnY21WekxuZHlhWFJsU0dWaFpDZ3lNRFFzSUVOUFVsTmZTRVZCUkVWU1V5azdJSEpsZEhWeWJpQnlaWE11Wlc1a0tDazdJSDBOQ2lBZ2FXWWdLSEpsY1M1MWNtd2dQVDA5SUNjdmFHVmgNCmJIUm9KeWtnZXcwS0lDQWdJQzh2SUhZNklPcXdrT3lMbk95ZWtDRHN2WlRyazV3ZzY3S0U3S0NFSU9LQWxDRHF0YXpyc29Uc29JUWc3WlNFNjZHYzdJUzQ3SXFrNnJDQUlPcXpoT3lHalNEcmo0enFzNkFnN0o2STY0cVU3S2VBSU91d2x1eVhrT3lFbkNEdG1aWHNuYmp0bFpqcmlwUWc3SnFwNjQrRURRb2dJQ0FnTHk4Z0tIWXlJRDBnN0xDOUlPeUlxT3E1Z0NEc2lKanNvSlh0akpBc0lIWXpJRDBnTDJGalkyOTFiblFnN0xhVTZyQ0E3WXlRTENCMk5DQTlJQzkxYm1sdWMzUmhiR3dnN0xhVTZyQ0E3WXlRS1EwS0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQjNZWFJqYUdWeU9pQjBjblZsTENCMk9pQTBJSDBwT3cwS0lDQjlEUW9nSUM4dklPeWR0Q0JRUSt5WGtDRHJvWnpxdDdqc25ianJrSndnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0RpZ0pRZzdaU002NStzNnJlNDdKMjRJT3l5cXlEdG1aVHJxYlRDdCsyWmlPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VoDQpuQ0RzazdEcmlwVHNwNEFpSU91enRPeVhyT3lqdk91S2xDRHJqYkFnN0pPMDY0dWtMZzBLSUNBdkx5RHFzSkRzaTV6c25wRHFzSUFnNjR1MTdaV1k2NHFVSU95ZHRPeWNvRG9nNjR1azY2YXM2Nlc4SU95OG5PdXB0Q0RzbTR6cnNJM3NsNFhzbkx6cm9ad2c3WUcwNjZHYzY1T2M2ckNBSU95THBPeWduQ0R0bUxqc3RwenJqN3dnNnJXczY0K0ZJT3lDck95YXFldWZpZXlkdENEcmdwanFzSVRyaTZRdURRb2dJQzh2SU9xd2tPeUxuT3lla091S2xDRHRqSXpzbmJ6cnA0d2c3SjI5N0p5ODY2K0E2NkdjSU95Q3JPeWFxZXVmaVNBd0lNSzNJT3VNZ09xNHNDQXdJT0tBbENEcXNvRHRocURycDR3ZzdKT3c2NHFVSU95Q3JPdWVqT3lYa09xeWpDRHJ1WVRzbXFuc25ZUWc2Nnk4NjZhczdLZUFJT3lWaXV1S2xPdUxwQzROQ2lBZ0x5OGc3S084N0oyWU9pRHNsNnpxdUxBZzZyT0U3S0NWN0oyMElPdXp0T3lYck91UGhDRHNub1hzbnFYcXRvenNuYlFnNjZlTTY2T002NUNRN0oyRUlPeUltQ0Rzbm9qcmk2UW83SnlnN1pxbw0KN0lTeDdKMkFJT3lMcE95Z25DRHRtTGpzdHB3ZzY1V002NmVNSU95VmpDRHNpSmdnN0o2STdKMk1JT0tBbENEcmk2VHJwcXdnTDJobFlXeDBhT3lkbUNCd2NtOWliR1Z0SU95d3VPcXpvQ2t1RFFvZ0lHbG1JQ2h5WlhFdWRYSnNJRDA5UFNBbkwyRmpZMjkxYm5RbktTQjdEUW9nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUdGalkyOTFiblE2SUdOc1lYVmtaVUZqWTI5MWJuUW9LU3dnWTJ4aGRXUmxPaUJvWVhORGJHRjFaR1VvS1NCOUtUc05DaUFnZlEwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmQyRnJaU2NwSUhzTkNpQWdJQ0JwWmlBb0lXaGhjME5zWVhWa1pTZ3BLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nWm1Gc2MyVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y2dmU2s3RFFvZ0lDQWdkMkZyWlVKeWFXUm5aU2dwT3cwS0lDQWdJSEpsZEhWeWJpQnENCmMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCM1lXdHBibWM2SUhSeWRXVWdmU2s3RFFvZ0lIME5DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM05vZFhSa2IzZHVKeWtnZXcwS0lDQWdJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrc0lESXdNQ2s3RFFvZ0lDQWdjbVYwZFhKdU93MEtJQ0I5RFFvZ0lDOHZJT3kwaU9xNHNPMlpsQ0RpZ0pRZzdKMjBJRkJENjZXOElDZnNnNGdnVUVNbklPeURnZTJEbk91aG5DRHJrSmpyajR6cnByRHJpNlFnS08yVWpPdWZyT3EzdU95ZHVDQmI3TFNJNnJpdzdabVVYU0Ryc29UdGlyd3BMZzBLSUNBdkx5RHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPMmRtT3VncE91enRPdUN1Q0Rya3FRZzdLQ1Y2NmFzN1pXYzY0dWtJT0tBbENCaWIyOTBiM1YwN0oyMElPeWFzT3Vtck91bHZDRHNwb25zDQppNXdnN0tPOTdKZXM2NCtFSU8yYWpPeUxvT3lkZ0NEcmo0VHNzS250bFp6cmk2UXVEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkxYm1sdWMzUmhiR3duS1NCN0RRb2dJQ0FnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnY0d4aGRHWnZjbTA2SUhCeWIyTmxjM011Y0d4aGRHWnZjbTBnZlNrN0RRb2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3RFFvZ0lDQWdJQ0J6YUhWMFpHOTNia0p5YVdSblpTZ3BPdzBLSUNBZ0lDQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlIVnVhVzV6ZEdGc2JGTmxiR1lvS1RzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJkMkYwWTJobGNsMGc3TFNJNnJpdzdabVVLSFZ1YVc1emRHRnNiQ2tnNG9DVUlPeWduT3F4c0RvbkxDQnlaVzF2ZG1Wa0xtcHZhVzRvSnl3Z0p5a2dmSHdnSnlqc2w0YnNuWXdwSnlrN0RRb2dJQ0FnSUNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhCeWIyTmxjM011WlhocA0KZENnd0tTd2dNakF3S1RzTkNpQWdJQ0I5TENBeU5UQXBPdzBLSUNBZ0lISmxkSFZ5YmpzTkNpQWdmUTBLSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd05Dd2dleUJsY25KdmNqb2dKMDV2ZENCbWIzVnVaQ2NnZlNrN0RRcDlLVHNOQ2cwS0x5OGc3SjIwNjYrNElPdVdvQ0Rzbm9qc25MenJxYlFnN0tHdzdKcXA3WjZJSU95aWhldWpqQ0FvN0o2UTY0K1pJT3lMbk95ZWtTQXJJRzV3YlNCaWRXbHNaQ0RzcEpIcnM3VWc3SXVrN1phSklPdU1nT3U1aENrTkNuTmxjblpsY2k1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V3MEtJQ0JwWmlBb1pTQW1KaUJsTG1OdlpHVWdQVDA5SUNkRlFVUkVVa2xPVlZORkp5a2djSEp2WTJWemN5NWxlR2wwS0RBcE93MEtJQ0J3Y205alpYTnpMbVY0YVhRb01TazdEUXA5S1RzTkNuTmxjblpsY2k1c2FYTjBaVzRvVUU5U1ZDd2dKekV5Tnk0d0xqQXVNU2NzSUNncElEMCtJSHNOQ2lBZ1kyOXVjMjlzWlM1c2IyY29KMXQzWVhSamFHVnlYU0R0Z2JUcm9aenJrNXdnNjR1azY2YXMNCklPcXdrT3lMbk95ZWtDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFySUZCUFVsUXBPdzBLZlNrN0RRb3ZMeUJKVUhZMklPdWpxTzJVaE91d3NTZzZPakVwN0plUTY0K0VJTzJWcU9xN21DRHJrNlByaXBUcmk2UWc0b0NVSUNkc2IyTmhiR2h2YzNRbjZyQ0FJRG82TWV1aG5DRHJxTHpzb0lBZzdaVzA3SVNkNjVDWTY0cVVJTzJabU9xeXZleVhrT3lFbkEwS0x5OGc3WlM4NnJlNDY2ZUlJR1psZEdObzZyQ0FJRWxRZGpUcm9ad2c3WSswNjdDeDdaV1k3S2VBSU95Vml1eVZoQ0RyaTZUcnBxd2c2cm1vN0pxdzZyaXd3cmZxczRUc29KVWc3S0d3N1pxTTZyQ0FJT3loc095YXFlMmVpQ0RzaTZUdGpLanRsWmpyalpnZzY2eTQ3S0NjSU91TWdPeWRrU2pyaTZUcnBxenNtWUFnNjQrWjdKMjhLUzROQ21OdmJuTjBJSE5sY25abGNqWWdQU0JvZEhSd0xtTnlaV0YwWlZObGNuWmxjaWh6WlhKMlpYSXViR2x6ZEdWdVpYSnpLQ2R5WlhGMVpYTjBKeWxiTUYwcE93MEtjMlZ5ZG1WeU5pNXZiaWduDQpaWEp5YjNJbkxDQW9LU0E5UGlCN2ZTazdJQzh2SURvNk1leWRoQ0RycXJzZzdKNmg3SldFNjQrRUtFVkJSRVJTU1U1VlUwWEN0MGxRZGpZZzdKZUc3SjJNS1NCSlVIWTA2NmVNN0p5ODY2R2NJT3F6aE95R2pTRHJqNW5zbnBFTkNuTmxjblpsY2pZdWJHbHpkR1Z1S0ZCUFVsUXNJQ2M2T2pFbktUc05DZz09DQo6OldTSUxFTlQ6Og0KSnlCRGJHRjFaR1VnUW5KcFpHZGxJSGRoZEdOb1pYSWdjMmxzWlc1MElHeGhkVzVqYUdWeUlDaHVieUIzYVc1a2IzY3BJQzBnY21WbmFYTjBaWEpsWkNCMGJ5QnlkVzRnWVhRZ2JHOW5hVzRLVTJWMElHWnpieUE5SUVOeVpXRjBaVTlpYW1WamRDZ2lVMk55YVhCMGFXNW5Ma1pwYkdWVGVYTjBaVzFQWW1wbFkzUWlLUXBUWlhRZ2MyZ2dQU0JEY21WaGRHVlBZbXBsWTNRb0lsZFRZM0pwY0hRdVUyaGxiR3dpS1Fwa2FYSWdQU0JtYzI4dVIyVjBVR0Z5Wlc1MFJtOXNaR1Z5VG1GdFpTaFhVMk55YVhCMExsTmpjbWx3ZEVaMWJHeE9ZVzFsS1FwemFDNURkWEp5Wlc1MFJHbHlaV04wYjNKNUlEMGdaR2x5Q25Ob0xsSjFiaUFpWTIxa0lDOWpJRzV2WkdVZ2MyTnlhWEIwYzF4aWNtbGtaMlV0ZDJGMFkyaGxjaTVxY3lJc0lEQXNJRVpoYkhObENnPT0NCjo6RU5EOjoNCg==";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAADffkCA61ICAOtSAgAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21sa1oyVXBDaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdUNpOHZDaTh2SU95R2pldVBoQ0RzaEtUcXM0UTZJTzJCdE91aG5PdVRuT3VsdkNEc21wVHNzcTNycDRqcmk2UWc3SU9JNjZHY0lPeUxuT3VQbWUyVm1PdXB0Q0F6TUg0ME1PeTBpT3F3Z0NEcXQ3anJnNlVnNjRLZzdKV0U2ckNFNjR1a0xnb3ZMeURpaHBJZzY0dWs2NmFzNjZXOElPeThwQ0RybFl3ZzdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZGhDRHRsWmpyZ3BnZzdKZTA3SmEwSU95RGdleUxuQ0RyaklEcXVMRHNpNXp0Z3FUcXM2QW9jM1J5WldGdExXcHpiMjRnNjR5QTdabVVJT3VxcU91VG5Da3NDaTh2SUNBZzZyQ0E3SjIwNjVPY0sreVlpT3lMbkNneE1USHFzYlFwNjRxVUlPeXlxeURycVpUc2k1enNwNERyb1p3ZzdaV2NJT3V5aU91bmpDRHNuYjN0bm96cmk2UXVJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2Nnk0NnJXczY2ZU1JT3V6dE91Q3RPdXZnT3VobkNEcnVhRHJwYlRyaTZRdUNpOHZJT3lFdU95Rm1PeWRnQ0F6TU91eWlDRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdaVzBJT3VNZ08yWmxPcXdnQ0RyckxUdGxaenRub2dnNnJpNDdKYTA3S2VBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpOHZDaTh2SU95Z2hPeWduRG9nN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPeWRoQ0Rxc29NZ0tHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKeTg2NkdjSU8yWmxleWR1Q2tLTHk4ZzdLTzg3SjJZT2lEc2dxenNtcW5ybjRuc25ZQWc2ckNCN0o2UUlPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFuT3VMcEM0S0NtTnZibk4wSUdoMGRIQWdQU0J5WlhGMWFYSmxLQ2RvZEhSd0p5azdDbU52Ym5OMElHWnpJRDBnY21WeGRXbHlaU2duWm5NbktUc0tZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3Q25SeWVTQjdJR1p6TG0xclpHbHlVM2x1WXloRlRWQlVXVjlEVjBRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbElIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwamIyNXpkQ0JEVEVGVlJFVmZSVTVXSUQwZ1QySnFaV04wTG1GemMybG5iaWg3ZlN3Z2NISnZZMlZ6Y3k1bGJuWXNJSHNLSUNCTlFWaGZWRWhKVGt0SlRrZGZWRTlMUlU1VE9pQW5NQ2NzSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNnNTNxc0lFZzY2cW82NU9jSU91QmxDQW83S2VuN0oyQUlPdXN1T3Exck95WGxDRHJ0b2p0bFlUc21wUXBDaUFnUTB4QlZVUkZYME5QUkVWZlJFbFRRVUpNUlY5T1QwNUZVMU5GVGxSSlFVeGZWRkpCUmtaSlF6b2dKekVuTENBdkx5RHRoTFFnN0pxVTdKVzlJT3VUc1NEcnRvRHFzSUFnN1ppNDdMYWNJT3VCbEFvZ0lFUkpVMEZDVEVWZlZFVk1SVTFGVkZKWk9pQW5NU2NzQ24wcE93b0tMeThnN0lpbzZybUFJT3lMcE8yV2lTanFzSkRzaTV6c25wQWc3SXFrN1krdzdKMkFJSE4wWkdsdklHbG5ibTl5WlNuc2w1RHNoSnpyajRRZzY2eTQ3S0NjNjZXOElPeTJsT3lnZ2UyVm9DRHNpSmdnN0o2STZyS01JT3k5bU95R2xDRHJvWnpxdDdqcnBid2c3WXlNN0oyODdKZVE2NCtFSU91Q3FPcTR0T3VMcEM0S0x5OGc3SnlFN0xtWU9pRHNub1RzaTV3ZzdZKzA2NDJVN0oyWUlHTnNZWFZrWlMxaWNtbGtaMlV1Ykc5bklDanNuSWpyajRUc21yQWdKVlJGVFZBbExDRHJwNlVnSkZSTlVFUkpVaWt1SURKTlFpRHJoSmpzbkx6cnFiUWdMbTlzWk91aG5DRHRsWndnN0lTNDY0eUE2NmVNSU91enRPcTBnQzRLWTI5dWMzUWdURTlIWDBaSlRFVWdQU0J3WVhSb0xtcHZhVzRvYjNNdWRHMXdaR2x5S0Nrc0lDZGpiR0YxWkdVdFluSnBaR2RsTG14dlp5Y3BPd3BqYjI1emRDQmZiM0pwWjB4dlp5QTlJR052Ym5OdmJHVXViRzluTG1KcGJtUW9ZMjl1YzI5c1pTazdDbU52Ym5OdmJHVXViRzluSUQwZ1puVnVZM1JwYjI0Z0tDa2dld29nSUdOdmJuTjBJR0Z5WjNNZ1BTQkJjbkpoZVM1d2NtOTBiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bmFXWjVLR0VwS1NrdWFtOXBiaWduSUNjcElDc2dKMXh1SnpzS0lDQWdJR1p6TG1Gd2NHVnVaRVpwYkdWVGVXNWpLRXhQUjE5R1NVeEZMQ0JzYVc1bEtUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUR0akl6c25id2c2NkdjNnJlNElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUcnBxenJpcFFnNnJPRTdJYU5JQ292SUgwS2ZUc0tDbU52Ym5OMElGQlBVbFFnUFNCT2RXMWlaWElvY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDFCUFVsUXBJSHg4SURFeE9EZzRPeUF2THlCQ1VrbEVSMFZmVUU5U1ZPdUtsQ0R0aFl6c2lxVHRpcmpzbXFrZ0tPMlBpZXlHak95WGxDQXhNVGc0T0NEcXM2RHNvSlVwQ2k4dklPdUxwT3VtckNEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVm5PdUxwQzRnN0wyVTY1T2M2Nlc4SUhCMWJHekN0K3V6dGV5Q3JPMlZ0T3VQaENBcUt1eWR0T3V2dUNEcmxxQWc3SjZJNjRxVUlPdUxwT3Vtck91S2xDRHNtSnNnN0wyVTY1T2NJT3EzdU91TWdPdWhuQ29xNjUyOENpOHZJT3E3a091THBDRHN2SnpxdUxBZzdLQ0U3SmVVSU95RGlDRHJqNW5zbnBIc25iUWc3SldJSU91Q21PeVlxT3VMcENqdGhMRHJyN2pyaEpEc25iUWc2NXlvNjRxVUlPdVRzU2t1SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RzbmJRZzZyQ1M3Snk4NjZHY0lPcTFyT3V5aE95Z2hPeWRoQ0Rxc0pEc3A0RHRsYlFnN0o2czdJdWM3SjZSN0l1YzdZS282NHVrTGdvdkx5RHJqNW5zbnBIc25iUWc2N0NVNjRDTTY0cVVJT3lJbU95Z2xleWRoQ0R0bFpqcnFiUWc3SjIwSU95SXEreWVrT3VsdkNEc21LenJwcXpxczZBZ1kyOWtaUzUwYyt5ZG1DQkNVa2xFUjBWZlRVbE9YMWJyajRRZzZyQ1o3SjIwSU95WXJPdW1zT3VMcEM0S1kyOXVjM1FnUWxKSlJFZEZYMVlnUFNBeU5qc0tMeThnNnJpdzY3TzRJT3VxcU91TnVDNGc3SnFVN0xLdEtPMlVqT3Vmck9xM3VPeWR1Q25zbmJRZ2JXOWtaV3pzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3EzdUNEc21wVHNzcTNycDR3ZzZyZTRJT3VxcU91TnVPdWhuQ0Rzc3BqcnBxenRsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPY0lDaHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FnNG9DVUlHSjFhV3hrTFdkc2IzTnpZWEo1TG1wejdKbUFJT3F3bWV5ZGdDRHRqSXpzaEp3cElPS1VnT0tVZ0FwbWRXNWpkR2x2YmlCc2IyRmtSWGhoYlhCc1pYTW9LU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FuS1N3Z0ozVjBaamduS1RzS0lDQWdJR052Ym5OMElITmxZMGxrZUNBOUlHMWtMbk5sWVhKamFDZ3ZYaU1qSU95MmxPeXluQ0RzbUlqc2k1eGNjeW9rTDIwcE93b2dJQ0FnYVdZZ0tITmxZMGxrZUNBOVBUMGdMVEVwSUhKbGRIVnliaUJiWFRzS0lDQWdJR052Ym5OMElHVjRZVzF3YkdWeklEMGdXMTA3Q2lBZ0lDQnNaWFFnWTNWeUlEMGdiblZzYkRzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnY21GM0lHOW1JRzFrTG5Oc2FXTmxLSE5sWTBsa2VDa3VjM0JzYVhRb0oxeHVKeWtwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlISmhkeTV5WlhCc1lXTmxLQzljY3lza0x5d2dKeWNwT3dvZ0lDQWdJQ0JqYjI1emRDQm9JRDBnYkdsdVpTNXRZWFJqYUNndlhpTWpJMXh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9hQ2tnZXlCamRYSWdQU0I3SUdsdWNIVjBPaUJvV3pGZExDQnpkV2RuWlhOMGFXOXVjem9nVzEwZ2ZUc2daWGhoYlhCc1pYTXVjSFZ6YUNoamRYSXBPeUJqYjI1MGFXNTFaVHNnZlFvZ0lDQWdJQ0JqYjI1emRDQmlJRDBnYkdsdVpTNXRZWFJqYUNndlhseHpLaTFjY3lzb0xpcy9LVnh6S2lRdktUc0tJQ0FnSUNBZ2FXWWdLR0lnSmlZZ1kzVnlLU0JqZFhJdWMzVm5aMlZ6ZEdsdmJuTXVjSFZ6YUNoaVd6RmRMbk53YkdsMEtDY2dMeUFuS1M1cWIybHVLQ2NnSnlrcE93b2dJQ0FnZlFvZ0lDQWdjbVYwZFhKdUlHVjRZVzF3YkdWekxtWnBiSFJsY2lnb1pTa2dQVDRnWlM1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ1BpQXdLVHNLSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpd0lPcXpvT3k1cUNBcklPeVd0T3lJbkNEcnM0RHFzcjBpN0oyMElPdVFuT3VMcEM0ZzdKZXQ3WldnSU91MmhPdW1yQ0RpZ0pRS0x5OGc3WUcwNjZHYzY1T2NJRDBnNjZ5NDdKNmxJT3VMcE91VHJPcTRzQ2pzc0wzc25aZ3BMQ0RzbXFuc2xyUWc3WWExN0oyOHdyZnJwNTdzdHFUcnNwVWdQU0JqYjJSbExuUnpJSEpsWm1sdVpVRnBVM1ZuWjJWemRHbHZibk1nN1p1RTdMS1k2NmFzS09xNHNPcXpoT3lnZ1NrdUNtTnZibk4wSUZOVVdVeEZYMUpWVEVWVElEMGdXd29nSUNjeExpRHRsYlRzbXBUc3NyUTZJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWc3WlcwN0pxVTdMSzA2NkdjTGlBbzY3TzA2NE9GNjR1STY0dWs0b2FTNjdPMDY0SzA3SnFVS1Njc0NpQWdKekl1SU91S3BldVBtZXlnZ1NEcnA1RHRsWmpxdUxBNklPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ3dnZnV5WGlDRHJ1YnpxdUxBbzY3Q1U2NENNN0plSTdKYTA3SnFVNG9hUzY3Q1U2citvN0phMDdKcVVLUzRnNjR1b0xDRHNvb1hybzR6Q3QrdW5qT3Vqak1LMzdKZXc3TEswd3JmdGxiVHNwNERDdCtxNHNPdWhuY0szNjRXNTdKMk1JT3VUc1NEc2k1enNpcVR0aFp6c25iUWc3S084N0xLMDdKMjRJT3F5c09xenZPdUtsQ0RzaUpqcmo1bnRtSlVnN0p5ZzdLZUFLT3lYc095eXRPdVB2T3lhbEN3ZzY0VzU3SjJNNjQrODdKcVVLUzRuTEFvZ0lDY3pMaURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3T2lBaWZ1MlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlpRHJqSURzaTZBZ0luN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRaUlPcTFyT3loc0NEc21yRHNoS0F1SU91THFDd2c3S0NWN0xHRjdJT0JJT3UyaU9xd2dNSzM3SjI4NjdhQUlPcTRzT3VLcFNEc29KenRsWnpDdCt1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPcXlzT3F6dk1LMzdLQ1Y2N08wSU91enRPMll1Q0RzbFlqc2k2enNuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMmVpQzRuTEFvZ0lDYzBMaURzdXBEc283enNscnp0bFp3ZzZySzk3SmEwT2lCKzdaV1k3SXVjNnJLZzdKYTA3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cExpY3NDaUFnSnpZdUlPMlJuT3E0c0RvZzY1Q1k3SmEwN0pxVTRvYVM2NCs4N0pxVUxpY3NDaUFnSnpjdUlPeWtoQ0RxdGF6c29iQTZJT3lia091enVPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPeTJsT3l5bk91UGhDRHJzSmpyazV6c2k1d2c3WldjSU95a2hPdWhuQzRnN0o2RTdKMlk2NkdjSU95a2hPeWRoQ0RyaXBqcnBxenNwNEFnN0pXSzY0cVU2NHVrTGlEcmk2Z3NJT3lYck91ZnJDRHJyTGpzbnFYc25ZUWc3WldZNjRLWTdKMllJT3E0amV5Z2xlMllsU0Ryckxqc25xWHNuTHpyb1p3ZzdaV3A3TE9RSU91TmxDRHFzSVRxc3JEdGxiVHNwNFRyaTZUcnFiUWc3S1NFSU95SW1PdWx2Q0RzcElUc25iVHJpcFFnNnJLRDdKMkFJTzJabU95WWdTNG5MQW9nSUNjNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1NEcnNvVHRpcnc2SU9xeXNPcXp2Q0R0aHJYcnM3VHJpcFFnVysyWmxleWR1RjBzSU95WWlDL3NsWVRyaTRqc21LUWc3WXlRNjR1bzdKMkFJRnZzbFlUcmk0anNtS1JkTDF2cmhLUmRMQ0RyajVuc25wRWc3SnlnNjQrRTY0cVVJRnZzdDZqc2hveGRMMXQ3NjQrWjdKNlJmVjB1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ0RzazdEcXM2QWdJdXVMcStxNHNNSzM2NCtaN0o2Ukl1eXltT3VmdkNEc3A1MGc3SldJSU91bm51dUtsQ0Rzb2JEdGxhbkN0K3VMcU91UGhTQWk3TGVvN0lhTUl1dUtsQ0RxdUlqc3A0QXVKeXdLSUNBbk9TNGc3SjIwNjZhRXdyZnNvSVR0bVpUcnNvanRtTGpDdCt1bmlPeUtwTzJDdWV5ZGdDRHF0N2pyaklEcm9ad2c2N08wN0tHMExpRHNncXpybm96c25ZUWc2N2FBNjZXOElPdVZrQ0RyaTVqc25ZUWc2N2FaN0plczY0K0VJT3lpaSt1THBDNG5MQW9nSUNjeE1DNGc3S0NjN1pLSUlPeWFxZXlXdENEc25LRHNwNEE2SU95ZWhldWdwZXlYa0NEc2s3RHNuYmdnNnJpdzY0cWw3SVN4SU91cWhleUNyQ2pyczREcXNyMHNJT3luZ095Z2xTd2c2NU94NjZHZExDRHRsYlRzb0p3ZzY1T3hLZXVLbENEdG1aVHJxYlRzblpnZzZyaXc2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqc2lKanJqNW50bUpYQ3QrcXl2ZXlXdE1LMzY3YUE3S0NWN1ppVklPMlhpT3lhcVNEc3ZJRHNuYlRzaXFRcDdKMllJT3VKbU95Vm1leUtwT3F3Z0NEc25LRHNpNlRya0p6cmk2UXVDaTh2SU8yTWpPeWR2T3lkdENEc2w0YnNuTHpycWJRbzdJU2s3TG1ZNjdPNElPcTFyT3V5aE95Z2hDRHJrN0VwSU91NWlDRHJyTGpzbnBEc2w3UWc0b0NVSU95YWxPeVZ2ZXVuak95Y3ZPdWhuQ0RyajVuc25wRW9abUZwYkMxemIyWjBLUzRLWm5WdVkzUnBiMjRnYkc5aFpFZDFhV1JsS0NrZ2V3b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuZFhndGQzSnBkR2x1Wnk1dFpDY3BMQ0FuZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUhKbGRIVnliaUJ0WkM1c1pXNW5kR2dnUGlBeE1EQWdQeUJ0WkNBNklDY25Pd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3Vobk91VG5DRHNpNlR0aktnZ0tPeWFsT3lWdmV1bmpPeWN2T3VobkNEc3A0VHRsb2twT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNCeVpYUjFjbTRnSnljN0NpQWdmUXA5Q21OdmJuTjBJRWRWU1VSRklEMGdiRzloWkVkMWFXUmxLQ2s3Q2dwbWRXNWpkR2x2YmlCcGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTQjdDaUFnWTI5dWMzUWdabVYzVTJodmRDQTlJRVZZUVUxUVRFVlRMbTFoY0Nnb1pYZ3BJRDArSUNkSmJuQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExtbHVjSFYwS1NBcklDZGNiazkxZEhCMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG5OMVoyZGxjM1JwYjI1ektTa3VhbTlwYmlnblhHNG5LVHNLSUNCeVpYUjFjbTRnS0FvZ0lDQWdKK3luZ09xNGlPdTJnTzJFc0NEcmhJanJpcFFnN0plUTdJcWs3SnVRS0ZNdE1Td2c2N08wN0pXSTdacU03SUtzS2V5ZG1DRHRsWnpxdGEzc2xyUWdWVmdnVjNKcGRHbHVaeURzb0lUcnJManFzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91THBDNGdKeUFyQ2lBZ0lDQW43S0d3NnJHMElPMlJuTzJZaENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzB3cmZzdElqcXM3ekN0K3V2dU91bmpNSzM2N2FBN1lTd3dyZnF1WXpzcDRBZzY1T3hLZXlkZ0NEc29KWHNzWVVnN0tDVjY3TzA2NHVrSU9LQWxDRHJ1Ynpxc2JEcmdwZ2c2NHVrNjZXNElPeWhzT3F4dE95Y3ZPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhLQ0kxN1pxTUlPeWR0T3lEZ1NMc25ZUWdJalh0bW93aTY2R2NJT3lraE95ZHRPdXB0Q0RzbUtUcmk3VXBMaUFuSUNzS0lDQWdJQ2ZzbTVEcnJManNsNUFnN0plRzY0cVVJT3Exck95eXRDRHNvSlhyczdRbzdLQ0U3Wm1VNjdLSTdaaTR3cmRWVWt6Q3QrcTRpT3lWb2NLMzdJdWM2ckNFSU91VHNTbnNtWUFnN1pXMDZyS3dJT3V3cWV1eWxjSzM3S0NJN0xDb0tPeWVyT3lFcE95Z2xjSzM2Nnk0N0oyWTdMS1l3cmZzbnF6c2k1enJqNFFnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjdhWjdKMjA2NHFVSU9xeWcreWRnQ0Rzb0lqcmpJQWc2cmlJN0tlQUlPS0FsQ0RzbFlUcmlwUWc2ckNTN0oyMDY1Mjg2NCtFTENEcXQ3anJuN1RyazYvdGxiVHJqNFFnN0pPdzdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdKelBxc0p3ZzdLQ2M3SldJN0oyQUlPeUVuT3VobkNEc29KSHF0N3pzbmJRZzY0dXM2NTI4N0pXOElPMlZuT3VMcENEaWdKUWc3WldZNjRLWTY0cVVJT3lia091c3VDRHF0YXpzb2JEcnBid2c3SnlnN0tlQTdaV2NJT3kxbk95R2pDRHJpNlRyazZ6cXVMQXNJTzJWbU91Q21PdUtsQ0Ryckxqc25xVWc2cldzN0tHdzY2VzhJT3llck9xMXJPeUVzZTJWbkNEcmpJRHNsWWdzSUNjZ0t3b2dJQ0FnSitxM3VPdW1yT3F6b0NEc29JSHNsclRyajRRZzdaV1k2NEtZNjRxVUlPcXp2T3F3a08yVm5DRHNucXpxdGF6c2hMRTZJT3lra2V1enRTRHRrWnp0bUlUc25ZUWc2NDJjN0phMDY0SzA2ck9nTENEc29KWHJzN1FnN0lpYzdJU2M2Nlc4SU95Q3JPeWFxZXlla09xd2dDRHNsWXpzbFlUc2xid2c3WldnSU9xeWcrdTJnTzJFc091aG5DRHNucXpzb2JEc3A0SHRsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZ0lDQWdKK3lWaE91ZW1DRHNtSWpzaTV6cms2VHNuWUFnN1pXY0lPeWtoT3lubk91bXJDRHN0WnpzaG93ZzZyV1E3S0NWN0oyMElPdW5qdXluZ091bmpDRHF0N2pxc2JRZzdZYWtLTzJWdE95YWxPeXl0TUszNnJLOTdKYTBLZXlkbUNEcXRaRHJzN2pzbmJUc3A0QWc3SWFNNnJlNTdJU3g3SjJZSU9xMWtPdXp1T3lkdENEc2xZVHJpNGpyaTZRZzRvQ1VJT3lYck91ZnJDRHJyTGpzbnFYc3A1enJwcXdnN0o2RjY2Q2w3SjJBSU91cGxPeUxuT3luZ0NEcmk2anNuSVRyb1p3ZzY0dWs3SXVjSU95RXBPcXpoTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcnNMRHNsN1RycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaGNLMzdMMlU2NU9jN1k2YzdJcWtJT3E0aU95bmdEcGNiaWNnS3dvZ0lDQWdKMXQ3SW5SbGVIUWlPaUFpN0tDYzdKV0lJT3VzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV1c3RPeVhoK3lkaENEc21ad2c2N0NVNnIrbzY0cVU3S2VBSU8yVm5PcTFyZXlXdENEdGxad2c2Nnk0N0o2bEluMHNJQzR1TGwxY2JseHVKeUFyQ2lBZ0lDQW5XK3lLcE8yRGdPeWR2Q0RxdDV6c3VabGRYRzRuSUNzZ1UxUlpURVZmVWxWTVJWTWdLeUFuWEc1Y2JpY2dLd29nSUNBZ0tFZFZTVVJGSUQ4Z0oxdnNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3lnaE91c3VDQW9kWGd0ZDNKcGRHbHVaeTV0WkNrZzRvQ1VJT3ljaENEcXQ1enN1Wm5zblpnZzZyZTg2ckd3N0ptQUlPeVlpT3ladUNEc2k1enJncGpycHF6c21LUXVJTzJLdWUyZWlDRHNtSWpzbWJnZzZyZWM3TG1aS095SW1PdVBtZTJZbGNLMzZySzk3SmEwd3JmcnRvRHNvSlh0bUpYc25ZUWc3SnlnN0tlQTdaVzA3Slc4SU8yVm1PdUtsQ0RzZzRIdG1ha3A3SjJFSU9xM3VPdU1nT3VobkNEcmxMRHJwYlRxczZBc0lPeWFsT3lWdmVxenZDRHNvSVRyckxqc25iUWc2NHVrNjZXMDY2bTBJT3lnaE91c3VPeWRoQ0RybExEcnBianJpNlJkWEc0bklDc2dSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cGJtVkNkV1lnUFNBbkp6c2dJQ0FnSUNBZ0lDQXZMeUJ6ZEdSdmRYUWc3S1NFSU91eWhPMk52QXBzWlhRZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQzh2SU8yWWhPeWVyQ0R0aExUc25aZ2dleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIMEtiR1YwSUhGMVpYVmxJRDBnVUhKdmJXbHpaUzV5WlhOdmJIWmxLQ2s3SUM4dklPeWFsT3l5clNEc3A0SHJvS3p0bVpRZ0tPdVBtZXlMbkNEc21wVHNzcTNzbllBZzdJaWM3SVNjNjR5QTY2R2NLUXBzWlhRZ2RIVnlibk1nUFNBd093cHNaWFFnZDJGeWJXVmtWWEFnUFNCbVlXeHpaVHNLYkdWMElHTjFjbkpsYm5STmIyUmxiQ0E5SUVOTVFWVkVSVjlOVDBSRlREc2dMeThnN0tlQTZyaUlJT3lFdU95Rm1PeWR0Q0Ryckx6cXM2QWc3SjZJNjRxVUlPdXFxT3VOdUNBbzdKcVU3TEt0N0oyMElPdUxwT3VsdUNEcnFxanJqYmpzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3lFdU95Rm1DRHNucXpzaTV6c25wRXBDaTh2SU95TG5PeWVrU0RzaTV3Z1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbElFTk1TU25xc0lBZzdKTzRJT3lJbUNEc25vanJpcFRzcDRBZzdLQ1E2cktBSU9LQWxDRHNsNGJzbkx6cnFiUWdMMmhsWVd4MGFPdWhuQ0RzbFl6cm9LUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeVZpT3VDdE8yVm5PdUxwQzRLTHk4Z2JuVnNiRDN0bVpYc25iZ2c3S1NSTENBbmIyc25QZXlDck95YXFTRHFzSURyaXFVc0lDZGpiR0YxWkdVdGJXbHpjMmx1WnljOVkyeGhkV1JsSU91cWhldWd1U0RzbDRic25Zd3NDaTh2SUNkamJHRjFaR1V0Ykc5bmIzVjBKejFqYkdGMVpHWHJpcFFnN0o2STdLZUE2NmVNSU91aG5PcTN1T3lkdUNEc2hManNoWmdnNjZlTTY2T01JQ2p0aExRZzdJdWs3WXlvSU95TG5DRHFzSkRzcDRBc0lPeUVzZXF6dFNEdGhMVHNuYlFnN0ppazY2bTBJT3lla091UG1TRHRsYlRzb0p3cENpOHZJQ2RqYkdGMVpHVXRiR2x0YVhRblBldWhuT3EzdU95ZHVPeWRnQ0Rya0pEc3A0RHJwNHdnN0lLczdKcXBJTzJWbk91UGhDRHN0SWpxczd3Z0tPeWhzT3k1bU9xd2dDRHNucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWjdKMkFJT3F5dmV1aG5PdWhuQ0RzbnFIdG5vanJyNERyb1p3ZzdLU1I2NmE5SU8yUm5PMlloT3lkaENEc2s3VHJpNlFLWTI5dWMzUWdURTlIU1U1ZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVPeWR0Q0R0bFlUc21wVHRsYlRzbXBRbzdKV0lJT3VRa09xeHNPdUNtQ0RycDR6cm80d3BJT0tBbENCYjhKK2ZvQ0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjBnNjdLRTdZcTg3SjJFSU91SWhPdWx0T3VwdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHRPeVd0T3VUbk91Z3BPeWFsQzRuT3dvdkx5RHNpNlRzdUtIdGxad2c2Nnk0NnJXczY1T2tPaUFpUm1GcGJHVmtJSFJ2SUdGMWRHaGxiblJwWTJGMFpUb2dUMEYxZEdnZ2MyVnpjMmx2YmlCbGVIQnBjbVZrSUdGdVpDQmpiM1ZzWkNCdWIzUWdZbVVnY21WbWNtVnphR1ZrSWlqcnA0enJvNHdwTEFvdkx5QWlUbTkwSUd4dloyZGxaQ0JwYmlEQ3R5QlFiR1ZoYzJVZ2NuVnVJQzlzYjJkcGJpSW82Nis0NjZHYzZyZTQ3SjI0S1NEaWdKUWc2NUdZSU91THBDRHNucUh0bm9qcXNvd2c2NFNUN1o2TTY0dWtDbVoxYm1OMGFXOXVJR2x6UVhWMGFFVnljbTl5S0hNcElIc0tJQ0J5WlhSMWNtNGdMMkYxZEdobGJuUnBZMkYwZkc5aGRYUm9mR0Z3YVNCclpYbDhiRzluSUQ5cGJueHNiMmRuWldSOGMyVnpjMmx2YmlCbGVIQnBjbVZrTDJrdWRHVnpkQ2hUZEhKcGJtY29jeWtwT3dwOUNpOHZJT3lDck95YXFTRHRsWnpyajRRZzdMU0k2ck84SU9xd2tPeW5nQ0RpZ0pRZzY2R2M2cmU0N0oyNDdKMkFJT3VwZ095cG9lMlZuT3VOc0NBaTY0MlVJT3VxdXlEc2s3VHJpNlFpNjRxVUlPcXl2ZXlhc0M0ZzY2R2M2cmU0N0oyNElPdW5qT3Vqak95WmdDRHNvYkRzdVpqcXNJQWc2NHVzNjUyODdJU2NJT3VVc091aG5DRHNucUhyaXBUcmk2UXVDaTh2SU95THBPeTRvU2d5TURJMkxUQTRMQ0R0bW96c2dxd2c3SmVVN1lTdzdaU0U2NTI4N0oyMDdLYUlJT3lpak95RW5TazZJQ0paYjNVbmRtVWdhR2wwSUhsdmRYSWdhVzVrYVhacFpIVmhiQ0J6Y0dWdVpDQnNhVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6c25wRHNsNURxc293ZzdaV2M2NCtFNjZXOElPeVlyT3VncENEcmk2enJuYnpxczZBZzdKcVU3TEt0N1pXWTZyT2dMQ0RzbFlUcmk0anJxYlFnVy9DZm42QWc3WUcwNjZHYzY1T2NJTzJWbk91UGhDRHN0SWpxczd4ZElPdXloTzJLdk95ZGhDRHJpSXpybjZ3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsYlFnN0tPODdJUzQ3SnFVTGljN0NpOHZJQ2Z0bFp6cmo0UW42NkdjSU91dGlldWFzZXEzdU91bXJPdXB0Q0RzbFlnZzY1Q2M2NHVrSU9LQWxDRHNucURxdVpBZzY2cXc2NmEwSU91VmpDRHJncGpyaXBRZ2NtRjBaU0JzYVcxcGRPeWR0T3VDbUNEcnJManJwNlVnNnJpNDdKMjBJT3kwaU9xenZPcTVqT3luZ0NEc25xSHNsWVFLTHk4ZzdKZUo2NXF4N1pXWTZyS01JQ0xyaTZUcnBiZ2c2ck9FN0tDVjdKeTg2NkdjSU91aG5PcTN1T3lkdU8yVm1PdWR2Q0xxczZBZzdKV0k2NEswN1pXWTZyS01JT3VRbk91THBDNGc3S2VBN0xhY3dyZnNncXpzbXFucm40a2c3SU9CN1pXY0lPdXN1T3Exck91bmpDRHNvb0h0bUlEc2hKd2c2N080NjR1a0NtWjFibU4wYVc5dUlHbHpUR2x0YVhSRmNuSnZjaWh6S1NCN0NpQWdjbVYwZFhKdUlDOXpjR1Z1WkNCc2FXMXBkSHgxYzJGblpTMWpjbVZrYVhSemZIVnpZV2RsSUd4cGJXbDBJQ2h5WldGamFHVmtmR1Y0WTJWbFpHVmtLUzlwTG5SbGMzUW9VM1J5YVc1bktITXBLVHNLZlFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56NjZXOElPeWR2ZXlXdEFvdkx5QXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZuT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbENEc3BKSHNuYmpzcDRBaUlPMlJuT3lMbkNEaWdKUWc2ck8xN0pxcElGQkQ3SmVRN0lTY0lPdUNxT3lkbUNEcXM0VHNvSlVnN0ppazdJS3M3SnFwSU91d3FleW5nQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMElPeWR0Q0Rxc0pMcXM3d2c3WXlNN0oyODdKMllJT3F6aE95Z2xleWR0Q0RzbHJUcXVJdnJncHpyaTZRS2JHVjBJSE5sYzNOcGIyNUJZMk52ZFc1MElEMGdiblZzYkRzS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzS0lDQnBaaUFvUkdGMFpTNXViM2NvS1NBdElHRmpZMjkxYm5SRFlXTm9aUzVoZENBOElETXdNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3dvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTNXFjMjl1Snlrc0lDZDFkR1k0SnlrcE93b2dJQ0FnWlcxaGFXd2dQU0FvYWlBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZENBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZEM1bGJXRnBiRUZrWkhKbGMzTXBJSHg4SUc1MWJHdzdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nNjZHYzZyZTQ3SjI0SU95ZHRPdWdwU0RzbDRic25Zd2c2NU94SU9LQWxDQnVkV3hzSU95Y29PeW5nQ0FxTHlCOUNpQWdZV05qYjNWdWRFTmhZMmhsSUQwZ2V5QmhkRG9nUkdGMFpTNXViM2NvS1N3Z1pXMWhhV3dnZlRzS0lDQnlaWFIxY200Z1pXMWhhV3c3Q24wS1puVnVZM1JwYjI0Z1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LU0I3Q2lBZ1kyOXVjM1FnY0hKdlltVWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0TFhabGNuTnBiMjRuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdJSDBwT3dvZ0lHeGxkQ0J2ZFhRZ1BTQW5KenNLSUNCd2NtOWlaUzV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJ2ZFhRZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc0tJQ0J3Y205aVpTNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljN0lIMHBPd29nSUhCeWIySmxMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVFpXTTZJQ2NuSUgwN0Nnb3ZMeURpbElEaWxJQWc3WlNNNjUrczZyZTQ3SjI0SU95RG5leWh0Q0Rxc0pEc3A0QW83SXVzN0o2bDY3Q1Y2NCtaS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdaU002NStzNnJlNDdKMjQ3SjIwSU91V29DRHNub2pyaXBRZzY0K1o3SldJSUdOdlpHVXVkSFBxc0lBZ05leTBpT3VuaU91THBDQlFUMU5VSUM5b1pXRnlkR0psWVhUcnBid2c2N08wNjRLNDY0dWtMZ292THlEdGxad2c2N0tJN0oyMDY1Mjg2NCtFSU91d20reWRnQ0Rya3FRZ016RHN0SWpxc0lRZzY0R0s2cml3NjZtMElPMlVqT3Vmck9xM3VPeWR1Q2pybUpEcmlwUWc3WlM4NnJlNDY2ZUlLZXlkdENEcmk2dnRub3dnNnJLRElPS0FsQ0R0Z2JUcm9aenJrNXpxdVl6c3A0QWc2NDJ3NjZhczZyT2dJT3F3bWV5ZHRDRHF1cnpzcDRUcmk2UXVDaTh2SU95VmhPeW5nU0R0bFp3ZzY3S0k2NCtFSU91cXV5RHJzSnZzbFpqc25MenJxYlFvNjR1azY2YXM2NmVNSU91b3ZPeWdnQ0RzdktBZzdJT0I3WU9jTENEc25wRHJqNW5zaTV6c25wRWc2NU94S1NEcXM0VHNobzBnNjR5QTZyaXc3WldjNjR1a0xncGpiMjV6ZENCSVJVRlNWRUpGUVZSZlJFVkJSRjlOVXlBOUlETXdNREF3T3dwc1pYUWdiR0Z6ZEVKbFlYUWdQU0F3T3dwelpYUkpiblJsY25aaGJDZ29LU0E5UGlCN0NpQWdhV1lnS0d4aGMzUkNaV0YwSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFtVmhkQ0ErSUVoRlFWSlVRa1ZCVkY5RVJVRkVYMDFUS1NCN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFnNG9DVUlPMlV2T3EzdU91bmlDL3RsSXpybjZ6cXQ3anNuYmpzbmJRZzY0dXI3WjZNSU9xeWcreWN2T3VobkNEcnM3VHFzNkFnNnJDWjdKMjBJT3E2dk95bmtldUxpT3VMcEM0bktUc0tJQ0FnSUhCeWIyTmxjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQc25MenJvWndnWTJ4aGRXUmxJTzJLdU91bXJPdWx2Q0Rzb0pYcnBxenRsWnpyaTZRS0lDQjlDbjBzSURVd01EQXBPd29LTHk4ZzRwU0E0cFNBSUVKU1QxZFRSVklnNnJDQTY2R2M3TEdFNnJpdzY0cVVJT3lnbk9xeHNPdVFrT3VMcENBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU1qVXBJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBb3ZMeURzbUlqc29JVHNsNVFnUWxKUFYxTkZVaUR0bVpqcXNyM3JzNERzaUpqc2w1QWc3SjZFN0l1Y0lPeUtwTzJCck91bXZlMkt1T3VsdkNEcXZZTHNsWVFnUTB4SjZyQ0FJT3lrZ0NCaGRYUm9iM0pwZW1VZ1ZWSk03SjJFSU95YXNPdW1yT3F3Z0NEcnNKdnNsWVRzaEp3ZzdKZTA3SmVJNjR1a0xnb3ZMeURycXFuc29JSHNuWUFnN1pXWTY0S1k2NytRN0oyMDdKZUk2NHVrSU9LQWxDRHFzNFRzb0pVZzdLQ0U3Wm1ZN0pxcDdKeTg2NkdjSUZWU1RPeWRoQ0JqYkdGMVpHVXVZV2t2Ykc5bmIzVjBQM0psZEhWeWJsUnZQZUtBcHV1aG5DRHNucXpzbnBIc2hMSHRsYlFLTHk4ZzdJcTU3SjI0SU8yWmxPdXB0T3lkaENEcXNiVHJoSWpybTdEcXM2QWc2ck9FN0tDVklPeUVvTzJEblNEdG1aVHJxYlRzbDVBZzdLZUI3WmFKN0l1YzdZS2s2cml3TGlEcXQ3Z2c3SjZzN0o2UjdJU3g3SjJFSU8yUGtPcTRzTzJWbU95ZWtDanNncXpzbXFuc25wQWc2ckt3N0tDVktTRHRsYmpyazZUcm42enJpcFFLTHk4ZzY2cXA3S0NCN0oyMElPeVhodXlXdE95aGpPcXpvQ3dnS2lycmdxanFzcWdnNjVHUTY2bTBJT3lZcE8yZWlPdWdwQ0Ryb1p6cXQ3anNuYmpzbllRZzY2ZWQ2ckNBNjV5bzY2YXc2NHVrS2lvNkNpOHZJQ0FnUTB4SjZyQ0FJRlZTVE95ZGhDRHJsTERzbUxUdGtad2c3SmVHN0oyMElPdUVtT3E0c091cHRDQmpiV1Rxc0lBZ1lDWmc3SmVRN0lTY0lGVlNUT3lkaENEc25wanJuYndnNjdLRTY2Q2tLT3ljaU91UGhPeWFzQ2tnWTJ4cFpXNTBYMmxrSU9xd21leWRnQ0Rya3FUc3FyMEtMeThnSUNEcnA2VHFzSnpyczREc2lKanFzSUFnN0lLczY1Mjg3S2VBNnJPZ0xDRHJ1SXpybmJ6c21yRHNvSURzbDVRZ0l1eWVtT3VxdSt1UW5DQlBRWFYwYUNEc21wVHNzcTBnd3JjZ1kyeHBaVzUwWDJsa0lPdW5wT3F3bk91emdPeUltT3F3Z0NEcmlJVHJuYjNya0pqc2w0anNpclhyaTRqcmk2UWk2ckNBSU91Y3JPdUxwQzRLTHk4Z0lDRHNpNnp0bFpqcnFiUWc2N2lNNjUyODdKcXc3S0NBNnJDQUlPeVZoT3lZaUNEc2xZZ2c3SmUwNjZhdzY0dWtLT3lMcE95NG9TQXlNREkyTFRBNE9pQkRURWtnN1pTRTY2R2M3SVM0N0lxazY0cVVJT3VNZ09xNHNDRHNwSkhzbmJqcmpiQWc3TEM5N0oyMElPeVZpQ0RybkxncExnb3ZMeURzbmJUc29Kd2dRbEpQVjFORlV1dWx2Q0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a0lPS0draUJqYkdGMVpHVWdRMHhKNnJDQUlPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJwYndnN0tlQjdLQ1JJT3lYc091THBDaERURWtnNnJpdzY3TzRJT3VQbWV5ZWtTa3VDaTh2SUNvcTdKMjBJT3F5dmV1aG5PeVhrQ0JWVWt3ZzZyQ0E2ck8xd3Jmc3BKSHFzSVFnN0lxazdZR3M2NmE5N1lxNDY2VzhJT3VMcE95TG5DRHJoS1BzcDRBZzY2ZVFJT3F5Z3k0cUtpRHFzNFRzb0pVZzdLQ0U3Wm1ZN0oyQUlPeUt1ZXlkdUNEdG1aVHJxYlFnN1pXWTY0dW9JRnZxczRUc29KVWc3S0NFN1ptWVhTRHJzb1R0aXJ6c25MenJvWnd1Q2dvdkx5RHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU8yVWhPdWhuT3lFdU95S3BDQW9ZMnhoZFdSbElHRjFkR2dnYkc5bmFXNGdMUzFqYkdGMVpHVmhhU2tnNG9DVUlDOXZjR1Z1TFd4dloybHU3SjIwSU95RG5leUVzY0szNnJTQTY2YXNMZ292THlEcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHJzN1RyZ3JUc3BJUWc2NVdNNnJtTTdLZUFJT3lJcU95V3RPeUVuQ0RyaklEcXVMRHRsWmpyaTZUcXNJQXNJT3laaE91ampPdVFtT3VwdENEc2lxVHNpcVRyb1p3ZzY0R2Q2NEtjNjR1a0xncHNaWFFnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNLYkdWMElHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2JuVnNiRHNLYkdWMElHeHZaMmx1VTNSaGNuUmxaRUYwSUQwZ01Ec2dMeThnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFZzdJdWM2ckNCSU9LQWxDRHNucXp0Z2JUcnBxM3NuYlFnSit5ZXJPeUxuT3VQaENmc25ianNwNEFnSit5ZWtPdVBtZXlaaE91ampDRHNpNlR0aktnbjdKMjQ3S2VBSU9xMXJPdTJoTzJWbk91THBBcG1kVzVqZEdsdmJpQnJhV3hzVEc5bmFXNVFjbTlqS0NrZ2V3b2dJR2xtSUNoc2IyZHBibEJ5YjJOVWFXMWxjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9iRzluYVc1UWNtOWpWR2x0WlhJcE95QnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlHNTFiR3c3SUgwS0lDQnBaaUFvSVd4dloybHVVSEp2WXlrZ2NtVjBkWEp1T3dvZ0lHTnZibk4wSUhBZ1BTQnNiMmRwYmxCeWIyTTdDaUFnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNLSUNCMGNua2dld29nSUNBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzS0lDQWdJQ0FnYzNCaGQyNVRlVzVqS0NkMFlYTnJhMmxzYkNjc0lGc25MMUJKUkNjc0lGTjBjbWx1Wnlod0xuQnBaQ2tzSUNjdlZDY3NJQ2N2UmlkZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNLSUNBZ0lIMGdaV3h6WlNCN0NpQWdJQ0FnSUhSeWVTQjdJSEJ5YjJObGMzTXVhMmxzYkNndGNDNXdhV1FzSUNkVFNVZFVSVkpOSnlrN0lIMGdZMkYwWTJnZ0tGOWxNaWtnZXlCd0xtdHBiR3dvS1RzZ2ZRb2dJQ0FnZlFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdXN0T3lMbkNBcUx5QjlDbjBLQ2k4dklPMkV0Q0RyajRUc3BKRWc3WUcwNjZHYzY1T2NJTzJVaE91aG5PeUV1T3lLcE9xd2dDRHNvNzNzbDRqc25ZUWc2NVdNN0oyWUlPeUxwTzJNcUNEcnFaVHNpNXpzcDRBZzRvQ1VJSEoxYmxSMWNtN3NuYlFnN0oyMElPdXBsT3lMbk95bmdPeWR2Q0RybFl6cnA0d2dNZTJhakNEc25wRHJqNWtnN0o2czdJdWM2NCtFN1pXYzY0dWtDbU52Ym5OMElGTkZVMU5KVDA1ZlJFbEZSQ0E5SUNmdGdiVHJvWnpyazV3ZzdJUzQ3SVdZN0oyMElPeWloZXVqak91UWtPeVd0T3lhbEM0bk93cHNaWFFnYzJoMWRIUnBibWRFYjNkdUlEMGdabUZzYzJVN0lDOHZJQzl6YUhWMFpHOTNiaURzcDRUdGxva2c3S1NSSU9LQWxDRHNucXpzaTV6cmo0VHJvWndnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtck95bmdDRHNsWXJxc293ZzdaR2M3SXVjQ2dvdkx5QnlaV0Z6YjI3c25ZUWc3S084NjZtMElDZnNuWmpyajRUc29JRWc3S0tGNjZPTUp5anFzNFRzb0pVZzdLQ0U3Wm1Zd3Jmcm9aenF0N2pzbFlUc200TWc2NU94S1NEaWdKUWc3S2VFN1phSklPeWtrZXlkdE91Tm1DRHRoTFRzbllRZzZyZTRJT3VwbE95TG5PeW5nT3VobkNEcmdaM3JnclRzaEp3S0x5OGdjblZ1VkhWeWJ1eWRtQ0JUUlZOVFNVOU9YMFJKUlVRZzdKNlE2NCtaSU95ZXJPeUxuT3VQaE9xd2dDRHNtSnNnN0o2UTZyS3A3S2FkNjZxRjdKeTg2NkdjSU95RXVPeUZtT3lkaENEcmtKanNnclRycHF6c3A0QWc3SldLNnJLTUlPMlZuT3VMcEM0S0x5OGdLT3lWaUNEcXQ3anJuNnpycWJRZzZyT0U3S0NWSU95Z2hPMlptQ0RzcDRIdG00UWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuYlFnNjdhQTdabWM3WlcwSUUxQldGOVVWVkpPVStxNWpPeW5nQ0RxczRUc2hvMGc3Sk93N0oyMDY0cVVJT3V5aE9xM3VDRGlnSlFnTWpBeU5pMHdOeURycHF6cnQ3RHNsNURzaEp3ZzdabVY3SjI0S1FwbWRXNWpkR2x2YmlCcmFXeHNVSEp2WXloeVpXRnpiMjRwSUhzS0lDQnBaaUFvY0hKdll5a2dld29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZDNhVzR6TWljcElIc0tJQ0FnSUNBZ0lDQXZMeUJ6YUdWc2JEcDBjblZsNjZHY0lPdWRoT3liak95RW5DQndjbTlqN0oyQUlHTnRaQ0RxdTQzcmpiRHF1TEFnNG9DVUlDOVU2NkdjSU8yS3VPdW1yT3ludUNEc283M3NsNnpzbGJ3ZzdLZUU3S2VjSUdOc1lYVmtaZXF3Z0NEcXM2RHNsWVRyb1p3ZzdKV0lJT3VDcU91S2xPdUxwQW9nSUNBZ0lDQWdJQzh2SUNqcXM2RHNsWVFnWTJ4aGRXUmw2ckNBSU95RXBPeTVtQ0R0akl6c25ienNuWVFnNjZ5ODZyT2dJT3llaU95Y3ZPdXB0Q0R0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3F3Z0NBaTdJS3M3SnFwSU95a2tTTHNuTHpyb1p3ZzY2ZUo3WjZZS1FvZ0lDQWdJQ0FnSUhOd1lYZHVVM2x1WXlnbmRHRnphMnRwYkd3bkxDQmJKeTlRU1VRbkxDQlRkSEpwYm1jb2NISnZZeTV3YVdRcExDQW5MMVFuTENBbkwwWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0NpQWdJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJQ0FnTHk4Z2JXRmpUMU12NjZhczY0aUY3SXFrT2lCemFHVnNiRHAwY25WbDY1MjhJSEJ5YjJQc25iUWdjMmdnNnJ1TjY0Mnc2cml3N0oyOElPeUltQ0Rzbm9qc25Zd2c0b0NVSUhOMFlYSjBVSEp2WSt5ZG1DQmtaWFJoWTJobFpPdWhuQ0RycDR6cms2QUtJQ0FnSUNBZ0lDQXZMeUR0bElUcm9aenNoTGpzaXFRZzZyZTQ2Nk81S0Mxd2FXUXA3SjJFSU8yR3RleW51T3VobkNEc29KWHJwcXp0bFp6cmk2UWdLSFJoYzJ0cmFXeHNJQzlVSU91TWdPeWRrU2tLSUNBZ0lDQWdJQ0IwY25rZ2V5QndjbTlqWlhOekxtdHBiR3dvTFhCeWIyTXVjR2xrTENBblUwbEhWRVZTVFNjcE95QjlJR05oZEdOb0lDaGZaVElwSUhzZ2NISnZZeTVyYVd4c0tDazdJSDBLSUNBZ0lDQWdmUW9nSUNBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIMEtJQ0I5Q2lBZ2NISnZZeUE5SUc1MWJHdzdDaUFnZDJGeWJXVmtWWEFnUFNCbVlXeHpaVHNLSUNCcFppQW9kMkZwZEdWeUtTQjdJR05zWldGeVZHbHRaVzkxZENoM1lXbDBaWEl1ZEdsdFpYSXBPeUIzWVdsMFpYSXVjbVZxWldOMEtHNWxkeUJGY25KdmNpaHlaV0Z6YjI0Z2ZId2dVMFZUVTBsUFRsOUVTVVZFS1NrN0lIZGhhWFJsY2lBOUlHNTFiR3c3SUgwS2ZRb0tablZ1WTNScGIyNGdjM1JoY25SUWNtOWpLQ2tnZXdvZ0lHdHBiR3hRY205aktDazdDaUFnYkdsdVpVSjFaaUE5SUNjbk93b2dJSFIxY201eklEMGdNRHNLSUNBdkx5RHNuYlFnN0lTNDdJV1k3SjIwSU95V3RPdUtrQ0RxczRUc29KWHNuWmdnN0o2RjdKNmw2cmFNN0p5ODY2R2NJT3VQaE91S2xPeW5nQ0RxdUxEcm9aMGc0b0NVSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbmJRZzY3Q1U2NENNN0plSTY0cVU3S2VBSU91NWhPcTFrTzJWbU91S2xDRHF1TERzcElBS0lDQnpaWE56YVc5dVFXTmpiM1Z1ZENBOUlHTnNZWFZrWlVGalkyOTFiblFvS1RzS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RzaTV6cmo1a2c3S1NSNG9DbUlDanJxcWpyamJnNklDY2dLeUJqZFhKeVpXNTBUVzlrWld3Z0t5QW5LU2NwT3dvZ0lHTnZibk4wSUhSb2FYTlFjbTlqSUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbkxYQW5MQ0FuTFMxdGIyUmxiQ2NzSUdOMWNuSmxiblJOYjJSbGJDd2dKeTB0YVc1d2RYUXRabTl5YldGMEp5d2dKM04wY21WaGJTMXFjMjl1Snl3Z0p5MHRiM1YwY0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzSUNjdExYWmxjbUp2YzJVblhTd2dld29nSUNBZ2MyaGxiR3c2SUhSeWRXVXNJR04zWkRvZ1JVMVFWRmxmUTFkRUxDQmxiblk2SUVOTVFWVkVSVjlGVGxZc0NpQWdJQ0JrWlhSaFkyaGxaRG9nY0hKdlkyVnpjeTV3YkdGMFptOXliU0FoUFQwZ0ozZHBiak15Snl3Z0x5OGdVRTlUU1ZnNklPeWVrT3E0c0NEdGxJVHJvWnpzaExqc2lxUWc2cmU0NjZPNUlPeURuZXlFc1NEaWdKUWdhMmxzYkZCeWIyUHNuYlFnNnJlNDY2TzU3S2U0SU95Z2xldW1yTzJWb0NEc2lKZ2c3SjZJNnJLTUNpQWdmU2s3Q2lBZ2NISnZZeUE5SUhSb2FYTlFjbTlqT3dvZ0lIQnliMk11YzNSa2IzVjBMbTl1S0Nka1lYUmhKeXdnS0dRcElEMCtJSHNLSUNBZ0lHeHBibVZDZFdZZ0t6MGdaQzUwYjFOMGNtbHVaeWduZFhSbU9DY3BPd29nSUNBZ2JHVjBJR2xrZURzS0lDQWdJSGRvYVd4bElDZ29hV1I0SUQwZ2JHbHVaVUoxWmk1cGJtUmxlRTltS0NkY2JpY3BLU0FoUFQwZ0xURXBJSHNLSUNBZ0lDQWdZMjl1YzNRZ2JHbHVaU0E5SUd4cGJtVkNkV1l1YzJ4cFkyVW9NQ3dnYVdSNEtTNTBjbWx0S0NrN0NpQWdJQ0FnSUd4cGJtVkNkV1lnUFNCc2FXNWxRblZtTG5Oc2FXTmxLR2xrZUNBcklERXBPd29nSUNBZ0lDQnBaaUFvSVd4cGJtVXBJR052Ym5ScGJuVmxPd29nSUNBZ0lDQnNaWFFnWlhZZ1BTQnVkV3hzT3dvZ0lDQWdJQ0IwY25rZ2V5QmxkaUE5SUVwVFQwNHVjR0Z5YzJVb2JHbHVaU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJR052Ym5ScGJuVmxPeUI5Q2lBZ0lDQWdJR2xtSUNobGRpQW1KaUJsZGk1MGVYQmxJRDA5UFNBbmNtVnpkV3gwSnlBbUppQjNZV2wwWlhJcElIc0tJQ0FnSUNBZ0lDQmpiMjV6ZENCM0lEMGdkMkZwZEdWeU93b2dJQ0FnSUNBZ0lIZGhhWFJsY2lBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnWTJ4bFlYSlVhVzFsYjNWMEtIY3VkR2x0WlhJcE93b2dJQ0FnSUNBZ0lHbG1JQ2hsZGk1cGMxOWxjbkp2Y2lrZ2V3b2dJQ0FnSUNBZ0lDQWdZMjl1YzNRZ2NtRjNJRDBnVTNSeWFXNW5LR1YyTG5KbGMzVnNkQ0I4ZkNCbGRpNXpkV0owZVhCbElIeDhJQ2NuS1M1emJHbGpaU2d3TENBeU1EQXBPd29nSUNBZ0lDQWdJQ0FnTHk4ZzdaV2M2NCtFSU95MGlPcXp2T3VsdkNEcnFMenNvSUFnNjdPNDY0dWtJT0tBbENEcm9aenF0N2pzbmJnZzdKaWs2NldZSU95Z2xlcTNuT3lMbmV5ZHRDRHJoSlBzbHJUc2hKd29iRzluSUQ5cGJpRHJrN0VwSU91c3VPcTFyT3F3Z0NEcnNKVHJnSXpycWJRZzdJSzg3WUtzSU95SW1DRHNub2pyaTZRS0lDQWdJQ0FnSUNBZ0lHbG1JQ2hwYzB4cGJXbDBSWEp5YjNJb2NtRjNLU2tnZXdvZ0lDQWdJQ0FnSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNBblkyeGhkV1JsTFd4cGJXbDBKenNnTHk4Z0wyaGxZV3gwYU91aG5DRHNsWXpycHJ3ZzRvYVNJT3V5aE8yS3ZPeWR0Q0JiN1pXYzY0K0VJT3kwaU9xenZGM3JvWndnNjdDVTY0Q002ck9nSU9xemhPeWdsU0Rzb0lUdG1aanNuWVFnN0pXSTY0SzBDaUFnSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c3SUtzN0pxcElPMlZuT3VQaENEc3RJanFzN3dnNnJDUTdLZUFPaWNzSUhKaGR5azdDaUFnSUNBZ0lDQWdJQ0FnSUhjdWNtVnFaV04wS0c1bGR5QkZjbkp2Y2loTVNVMUpWRjlIVlVsRVJTa3BPd29nSUNBZ0lDQWdJQ0FnZlNCbGJITmxJR2xtSUNocGMwRjFkR2hGY25KdmNpaHlZWGNwS1NCN0NpQWdJQ0FnSUNBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJHOW5iM1YwSnpzZ0x5OGdMMmhsWVd4MGFPdWhuQ0R0bEl6cm42enF0N2pzbmJqc2w1QWc3SldNNjZhOElPS0draURyc29UdGlyenNuYlFnVyt1aG5PcTN1T3lkdUNEdGxZVHNtcFJkNjZHY0lPdXdsT3VBbkFvZ0lDQWdJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdUNEcnA0enJvNHdnNnJDUTdLZUFPaWNzSUhKaGR5azdDaUFnSUNBZ0lDQWdJQ0FnSUhjdWNtVnFaV04wS0c1bGR5QkZjbkp2Y2loTVQwZEpUbDlIVlVsRVJTa3BPd29nSUNBZ0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0FnSUNBZ2R5NXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SmlrNjZXWU9pQW5JQ3NnY21GM0tTazdDaUFnSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2R2YXljN0lDOHZJT3lFc2VxenRTQTlJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjRJT3VMcENEc29KWHNnNEVnNG9DVUlPeVd0T3VXcENCd2NtOWliR1Z0N0oyMDY1T2dJTzJWdE95Z25DQW83SjZzNjZHYzZyZTQ3SjI0TCt5ZXJPeUVwT3k1bUNEcnM3WHF0NEFwQ2lBZ0lDQWdJQ0FnSUNCM0xuSmxjMjlzZG1Vb1UzUnlhVzVuS0dWMkxuSmxjM1ZzZENCOGZDQW5KeWtwT3dvZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnZlFvZ0lDQWdmUW9nSUgwcE93b2dJSEJ5YjJNdWMzUmtaWEp5TG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzS0lDQWdJR052Ym5OMElITWdQU0JrTG5SdlUzUnlhVzVuS0NkMWRHWTRKeWt1ZEhKcGJTZ3BPd29nSUNBZ2FXWWdLSE1nSmlZZ0lYTXVhVzVqYkhWa1pYTW9KMFJsY0hKbFkyRjBhVzl1VjJGeWJtbHVaeWNwS1NCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGdZMnhoZFdSbElITjBaR1Z5Y2pvbkxDQnpMbk5zYVdObEtEQXNJREl3TUNrcE93b2dJSDBwT3dvZ0lIQnliMk11YjI0b0oyTnNiM05sSnl3Z0tHTnZaR1VwSUQwK0lIc0tJQ0FnSUM4dklPeWR0T3V2dUNEc2c0Z2c3SVM0N0lXWTdKeTg2NkdjSU9xMWtPeXl0T3VRbkNEcmtxUWc3SmliSU95RXVPeUZtT3lkdENEcmk2dnRub3dnNnJHdzY2bTBJT3VzdE95TG5DQW82NnFvNjQyNElPeWdoTzJabUNEc2k1d2c3SU9JSU95RXVPeUZtT3lkaENEc283M3NuYlRzcDRBZzdKV0s2cktNS1FvZ0lDQWdhV1lnS0hCeWIyTWdJVDA5SUhSb2FYTlFjbTlqS1NCeVpYUjFjbTQ3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0Rzb29Ycm80d2dLR052WkdVZ0p5QXJJR052WkdVZ0t5QW5LU0RpZ0pRZzY0dWs3SjJNSU95YWxPeXlyU0RybFl3ZzY0dWs3SXVjSU95TG5PdVBtZTJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJR3RwYkd4UWNtOWpLQ2s3Q2lBZ2ZTazdDbjBLQ21aMWJtTjBhVzl1SUhObGJtUlVkWEp1S0hSbGVIUXBJSHNLSUNCeVpYUjFjbTRnYm1WM0lGQnliMjFwYzJVb0tISmxjMjlzZG1Vc0lISmxhbVZqZENrZ1BUNGdld29nSUNBZ2FXWWdLQ0Z3Y205aktTQnlaWFIxY200Z2NtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZHRDRHNsNGJzbHJUc21wUXVKeWtwT3dvZ0lDQWdhV1lnS0hkaGFYUmxjaWtnY21WMGRYSnVJSEpsYW1WamRDaHVaWGNnUlhKeWIzSW9KK3lWbnV5RW9DRHNtcFRzc3Ezc25iUWc3S2VFN1phSklPeWtrZXlkdE95WGtPeWFsQzRuS1NrN0NpQWdJQ0JqYjI1emRDQjBhVzFsY2lBOUlITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WVMwSU95TG5PcXdoQ0RzdElqcXM3d2c0b0NVSU95RXVPeUZtT3lkaENEc25xenNpNXpzbnBIdGxhbnJpNGpyaTZRdUp5azdDaUFnSUNBZ0lDOHZJT3lMbk9xd2hDRHN0SWpxczd6cmlwUWdKK3lFdU95Rm1DRHNvb1hybzR3bjdKbUFJT3Exck91MmhPdVFtT3VLbENEc29Kd2c2Nm1VN0l1YzdLZUE2NkdjSU91Qm5ldUN1T3VMcENEaWdKUWdhMmxzYkZCeWIyUHNuWmdnN0lTNDdJV1lJT3lpaGV1ampDQnlaV3BsWTNUcXNJQUtJQ0FnSUNBZ0x5OGdjblZ1VkhWeWJ1eWRtQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2Nlc4SU91MmdPdWx0T3VwdENEc2xZZ2c2NUNZNnJpd0lPdVZqT3VzdUNqcmlwRHJwckFnN1lTMDdKMkVJT3VSa0NEcnNvZ2c2NCtNNjZtMElPMlVqT3Vmck9xM3VPeWR1Q0F4TXpEc3RJZ2c3S0NjN1pXYzdKMkVJT3VFbU9xNHRPdUxwQ2tLSUNBZ0lDQWdhV1lnS0hkaGFYUmxjaWtnZXdvZ0lDQWdJQ0FnSUdOdmJuTjBJSGNnUFNCM1lXbDBaWEk3SUhkaGFYUmxjaUE5SUc1MWJHdzdDaUFnSUNBZ0lDQWdkeTV5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2Z0Z2JUcm9aenJrNXdnN0oyUjY0dTE3SjIwSU91RWlPdXN0Q0RzbUtUcm5wZ2c2ckc0NjZDa0lPeWFsT3l5cmV5ZGhDRHNwSkhyaTZqdGxvanNsclRzbXBRZzRvQ1VJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMaWNwS1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JyYVd4c1VISnZZeWdwT3dvZ0lDQWdmU3dnVkZWU1RsOVVTVTFGVDFWVVgwMVRLVHNLSUNBZ0lIZGhhWFJsY2lBOUlIc2djbVZ6YjJ4MlpTd2djbVZxWldOMExDQjBhVzFsY2lCOU93b2dJQ0FnY0hKdll5NXpkR1JwYmk1M2NtbDBaU2hLVTA5T0xuTjBjbWx1WjJsbWVTaDdJSFI1Y0dVNklDZDFjMlZ5Snl3Z2JXVnpjMkZuWlRvZ2V5QnliMnhsT2lBbmRYTmxjaWNzSUdOdmJuUmxiblE2SUhSbGVIUWdmU0I5S1NBcklDZGNiaWNzSUNkMWRHWTRKeWs3Q2lBZ2ZTazdDbjBLQ2k4dklPcXdtZXlkZ0NEcnJManF0YXpycGJ3ZzY2cUhJT3V5aU95bnVDRHJyTHZyaXBUc3A0QWc2cml3N0phMUlPS0FsQ0RzbnF6c21wVHNzcTNzbmJUcnFiUWdJdXlkdE95Z2hPcXp2Q0RyaTZUcnBiZ2c3SU9JSU95Z25PeVZpQ0xzbllRZzdKcVU2cldzN1pXYzY0dWtDaTh2SUNqc2xZZ2c2cmU0NjUrczY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc2hMSHNpNlR0bFpqcXNvd2c2ckNaN0oyQUlPdUx0ZXlkaENEcm1KQWc2NEswN0lTY0lGdEJTU0RzdHBUc3Nwd2c2NDJVSU91d20rcTRzRjNxc0lBZzY2eTA3SjJZNjYrNDdaVzA3S2VFNjR1a0tRcGpiMjV6ZENCaGMydGxaRU52ZFc1MElEMGdibVYzSUUxaGNDZ3BPd29LTHk4ZzdJUzQ3SVdZSU95a2dPdTVoQ2pzaTV6cmo1a3I3S2VBN0l1YzY2eTRJT3lqdk95ZWhTbnJwYndnNjdPMDdKNmw3WldjSU91U3BDRHRsWndnN1lTMElPeUxwTzJXaVNEaWdKUWc2NnFvNjVPZ0lPMll1T3kybk95ZGdDQnhkV1YxWmV1aG5DRHNwNEhyb0t6dG1aUXVDaTh2SUcxdlpHVnM3SjJFSU95anZPdXB0Q0RxdDdnZzY2cW82NDI0NjZHY0lDanJpNlRycGJUcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTa3VJTzJWbkNEcnFxanJqYmpzbllRZzZyT0U3SWFOSU95VHNPdXB0Q0RzbnF6c2k1enNucEhzbllBZzdMV2M3TFNJSURIdG1venJ2NUF1Q2k4dklISmxjR0Z5YzJVOWUzQmhjbk5sTENCbWIzSnRZWFJFWlhOamZldWx2Q0Rzbzd6cnFiUWc3WXlNN0l1eDZybU03S2VBSU95ZHRDRHNucUVnN0pXSTdKZVE3SVNjSU95eW1PdW1yTzJWbU9xem9DQjdjbUYzTENCd1lYSnpaV1I5NjZXOElPdVBqT3VncE95a2dPdUxwRG9LTHk4ZzdaaVY3SXVkSU95ZHRPMkRpQ0RzaTV3ZzZyQ1o3SjJBSU95RXVPeUZtT3lYa0NBaTdaaVY3SXVkNjR5QTY2R2NJT3VMcE95TG5DTHJwYndnN0pxVTZyV3M3WldZNjRxVUlPeWVyT3lhbE95eXJTRHRoTFRzbllRZ0tpcnFzSm5zbllBZzdZR1FJT3llb1NEc2xZanNsNURzaEp3cUtpRHJ0cG5zbmJqcmk2UXVDaTh2SU91emhPdVBoQ0RzbnFIc25MenJvWndnNjdtODY2bTBJQ2hoS1NEc2dxenNuYlRzbDVBZzY0dWs2Nlc0SU95YWxPeXlyU0R0aExUc25iUWc2NEc4N0phMElDZnJzS25xdUlnZzY0dTFKK3lkdENEcmdxanNuWmdnNjR1MTdKMjBJT3VRbU9xem9DanJnclRzbXFrZzdKaWs3SmU4S1N3S0x5OGdLR0lwSUUxQldGOVVWVkpPVXlEcXNyM3FzNFRzbDVEc2hKd2c3SVM0N0lXWTdKMjBJT3llck95TG5PeWVrZXVQdkNBbjY3Q3A2cmlJSU91THRTZnNuYlFnN0plRzY0cVVJT3lEaUNEc2hManNoWmpzbmJRZzY0SzA3SnFwN0oyRUlPeW5nT3lXdE91Q3ZDRHNpSmdnN0o2STY0dWtJQ2d5TURJMkxUQTNJT3Vtck91M3NPeVhrT3lFbkNEdG1aWHNuYmdwTGdwamIyNXpkQ0JTUlZCQlVsTkZYMEpCUkNBOUlDaDJLU0E5UGlCMklEMDlJRzUxYkd3Z2ZId2dLRUZ5Y21GNUxtbHpRWEp5WVhrb2Rpa2dKaVlnZGk1c1pXNW5kR2dnUFQwOUlEQXBPd3BtZFc1amRHbHZiaUJ5ZFc1VWRYSnVLR0oxYVd4a1FYTnJMQ0J0YjJSbGJDd2djbVZ3WVhKelpTa2dld29nSUdOdmJuTjBJR3B2WWlBOUlIRjFaWFZsTG5Sb1pXNG9ZWE41Ym1NZ0tDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ2FtOWlVM1JoY25RZ1BTQkVZWFJsTG01dmR5Z3BPeUF2THlEc2k1enFzSVFnN0ppSTdJS3dJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3S3E5SU95Z25PMlZuQ2d4TXpEc3RJZ3A3SjJFSU91RW1PcTR1Q0RzbnF6c2k1enJqNFRyaXBRZzdZK3M2cml3N1pXYzY0dWtDaUFnSUNCcFppQW9iVzlrWld3Z0ppWWdRVXhNVDFkRlJGOU5UMFJGVEZNdWFXNWtaWGhQWmlodGIyUmxiQ2tnSVQwOUlDMHhJQ1ltSUcxdlpHVnNJQ0U5UFNCamRYSnlaVzUwVFc5a1pXd3BJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91cXFPdU51Q0RyczREcXNyMDZJQ2NnS3lCamRYSnlaVzUwVFc5a1pXd2dLeUFuSU9LR2tpQW5JQ3NnYlc5a1pXd3BPd29nSUNBZ0lDQmpkWEp5Wlc1MFRXOWtaV3dnUFNCdGIyUmxiRHNLSUNBZ0lDQWdjM1JoY25SUWNtOWpLQ2s3SUM4dklPeURpQ0RycXFqcmpianJvWndnN0lTNDdJV1lJT3llck95TG5PeWVrU0FvNjR1azdKMk1JT3liak91d2pleVhoZXlYa095RW5DRHNwNERzaTV6cnJMZ2c3SjZzN0tPODdKNkZLUW9nSUNBZ2ZRb2dJQ0FnYVdZZ0tIUjFjbTV6SUQ0OUlFMUJXRjlVVlZKT1V5QjhmQ0FoY0hKdll5a2djM1JoY25SUWNtOWpLQ2s3Q2lBZ0lDQnBaaUFvSVhkaGNtMWxaRlZ3S1NCN0NpQWdJQ0FnSUdOdmJuTjBJSFF3SUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUNBZ1lYZGhhWFFnYzJWdVpGUjFjbTRvYVc1emRISjFZM1JwYjI1TlpYTnpZV2RsS0NrcE93b2dJQ0FnSUNCM1lYSnRaV1JWY0NBOUlIUnlkV1U3Q2lBZ0lDQWdJSFIxY201ekt5czdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haZ2c3S1NBNjdtRUlPeVpoT3VqakNBb0p5QXJJQ2dvUkdGMFpTNXViM2NvS1NBdElIUXdLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2tnS3lBbmN5a2c0b0NVSU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjdtbzY1Mjg3SnFVTGljcE93b2dJQ0FnZlFvZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUdOdmJuTjBJR0Z6YXlBOUlHSjFhV3hrUVhOcktDazdJQzh2SU95ZXJPeUxuT3VQaENEcmxZd2c2ckNaN0oyQUlPeW5pT3VzdU95ZGhDRHJpNlRzaTV3ZzdKTzA2NHVrSUNoaGMydGxaRU52ZFc1MElPeWR0T3lra1NEc3BwM3FzSUFnNjdDcDdLZUFLUW9nSUNBZ2JHVjBJSEpoZHpzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUhKaGR5QTlJR0YzWVdsMElITmxibVJVZFhKdUtHRnpheWs3Q2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQWdJQzh2SU8yRXRDRHJqNFRzcEpFZzdZRzA2NkdjNjVPY0lPMlVoT3Vobk95RXVPeUtwT3F3Z0NEc283M3NuWUFnNnJLOTdKcXdLRk5GVTFOSlQwNWZSRWxGUkNrZ01lMmFqQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0VJT0tBbENEc2dxenNtcW5zbnBEc2w1RHFzcEFnN0l1azdZeW82NkdjSU95VmlDRHJzN1RzbmJUcXNvd3VDaUFnSUNBZ0lDOHZJT3lMbk9xd2hDRHN0SWpxczd6Q3QrdWhuT3EzdU95ZHVDRHJwNHpybzR6Q3QrMkJ0T3Vobk91VG5DRHNtS1RycFpqQ3QreWRtT3VQaE95Z2dTRHNvb1hybzR3bzZyT0U3S0NWSU95Z2hPMlptQy9yb1p6cXQ3anNsWVRzbTRNc0lHdHBiR3hRY205aktISmxZWE52YmlrcDY0cVVDaUFnSUNBZ0lDOHZJT3lnbkNEcnFaVHNpNXpzcDREcXNJQWc2NVN3NjZHY0lPeWVpT3lXdENEc2w2enF1TEFnN0pXSUlPcXh1T3Vtc091THBDNGc3S0tGNjZPTUlPeWFsT3l5clNEc3BKSHNuYlRxc2JEcmdwZ2c3SXVjNnJDRUlPeVlpT3lDc095ZHRDRHNscnpycDRnZzdKV0lJT3VDcU95Vm1PeWN2T3VwdENEcmtKanNnclRycHF6c3A0QWc3SldLNjRxVTY0dWtMZ29nSUNBZ0lDQnBaaUFvYzJoMWRIUnBibWRFYjNkdUlIeDhJQ0VvWlNBbUppQmxMbTFsYzNOaFoyVWdQVDA5SUZORlUxTkpUMDVmUkVsRlJDa2dmSHdnUkdGMFpTNXViM2NvS1NBdElHcHZZbE4wWVhKMElENGdOREF3TURBcElIUm9jbTkzSUdVN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNoTGpzaFpqc25iUWc3WVMwSU91UGhPeWtrU0RyZ1lycXVZQWc0b0NVSU95ZXJPeUxuT3VQbVNEdG00UWdNZTJhakNEc25xenNpNXpyajRUdGxhbnJpNGpyaTZRdUp5azdDaUFnSUNBZ0lITjBZWEowVUhKdll5Z3BPd29nSUNBZ0lDQmhkMkZwZENCelpXNWtWSFZ5YmlocGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTazdDaUFnSUNBZ0lIZGhjbTFsWkZWd0lEMGdkSEoxWlRzS0lDQWdJQ0FnZEhWeWJuTWdQU0F5T3lBdkx5RHNtNHpyc0kzc2w0VWdNU0FySU95ZHRPdXlpQ0R0aExRZ0tITjBZWEowVUhKdlkreWR0Q0F3N0p5ODY2R2NJT3kwaU9xNHNPMlpsQ2tLSUNBZ0lDQWdjbUYzSUQwZ1lYZGhhWFFnYzJWdVpGUjFjbTRvWVhOcktUc0tJQ0FnSUgwS0lDQWdJR2xtSUNnaGNtVndZWEp6WlNrZ2NtVjBkWEp1SUhKaGR6c0tJQ0FnSUd4bGRDQndZWEp6WldRZ1BTQnlaWEJoY25ObExuQmhjbk5sS0hKaGR5azdDaUFnSUNBdkx5RHRtSlhzaTUwZzdKMjA3WU9JN0oyMDY2bTBJT3F3bWV5ZGdDRHNoTGpzaFpqQ3QrcXdtZXlkZ0NEc25xSHNsNURzaEp3ZzZyT243SjZsSU95ZXJPeWFsT3l5clNEaWdKUWc3SjIwSU8yRXRPeWR0Q0Rzbzczc25MenJxYlFnN0lPSUlPeUV1T3lGbU95ZGdDQW42N0NwNnJpSUlPdUx0U2ZzbllRZzY2cXc2NTI4Q2lBZ0lDQXZMeURzcDREc2xyVHJncndnN0lpWUlPeWVpT3ljdk91dmdPdWhuQ0RzaExqc2haZ2c3SUtzNjZlZElPeWVyT3lMbk91UGhPdUtsQ0R0bFpqc3A0QWc3SldLNnJPZ0lPcTN1T3VNZ091aG5DRHNpNlR0aktqc2k1enRncWpyaTZRbzdZeU03SXV4SU95THBPMk1xT3VobkNEcXQ0RHFzckFwTGdvZ0lDQWdhV1lnS0ZKRlVFRlNVMFZmUWtGRUtIQmhjbk5sWkNrZ0ppWWdSR0YwWlM1dWIzY29LU0F0SUdwdllsTjBZWEowSUR3Z056QXdNREFwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1qT3lMc1NEc2k2VHRqS2dnNG9DVUlPMllsZXlMblNEc25xenNtcFRzc3EwNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTXpBd0tTazdDaUFnSUNBZ0lIUjFjbTV6S3lzN0NpQWdJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lDQWdjbUYzSUQwZ1lYZGhhWFFnYzJWdVpGUjFjbTRvSit1d3FlcTRpQ0RyaTdYc25iUWc3SnFVNnJXczdaV2NJTzJZbGV5TG5leVhrQ0RzbHJUcXVJdnJncXpyaTZRdUlPdXdxZXE0aUNEcmk3WHRsWndnNjRLMDdKcXA3SjJFSU95RXBPdXFoY0szN0lLczZyTzh3cmZzdlpUcms1enRqcHpzaXFRZzdKZUc3SjIwSU95VmhPdWVtQ0JLVTA5TzdKeTg2NkdjNjZlTUlPdUxwT3lMbkNEc3RwenJvS1h0bFpqcm5idzZJQ2NnS3lCeVpYQmhjbk5sTG1admNtMWhkRVJsYzJNcE93b2dJQ0FnSUNBZ0lIQmhjbk5sWkNBOUlISmxjR0Z5YzJVdWNHRnljMlVvY21GM0tUc0tJQ0FnSUNBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzdKNnM3SnFVN0xLdElPeUxwTzJNcUNEaWdKUWc3SldFNjU2WTdKZVE3SVNjSU8yTWpPeUxzU0RzaTZUdGpLanJvWndnN0xLWTY2YXNJQ292SUgwS0lDQWdJSDBLSUNBZ0lHbG1JQ2hTUlZCQlVsTkZYMEpCUkNod1lYSnpaV1FwS1NCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlNN0l1eElPeUxwTzJNcUNBbzdKNnM3SnFVN0xLdElPMmJoT3lYa091UGhDazZKeXdnVTNSeWFXNW5LSEpoZHlrdWMyeHBZMlVvTUN3Z016QXdLU2s3Q2lBZ0lDQnlaWFIxY200Z2V5QnlZWGNzSUhCaGNuTmxaRG9nVWtWUVFWSlRSVjlDUVVRb2NHRnljMlZrS1NBL0lHNTFiR3dnT2lCd1lYSnpaV1FnZlRzS0lDQjlLVHNLSUNBdkx5RHRsWndnN0pxVTdMS3Q3SjIwSU95THBPMk1xTzJWdE91UGhDRHJpNlRzbll3ZzdKcVU3TEt0N0oyMElPeWR0T3lXdE95bmdPdVBoT3VoblNEdGdaRHJpcFFnN1pXdDdJT0JJT3lFc2VxenRleWN2T3VobkNEc29KWHJwcXdLSUNCeGRXVjFaU0E5SUdwdllpNWpZWFJqYUNnb0tTQTlQaUI3ZlNrN0NpQWdjbVYwZFhKdUlHcHZZanNLZlFvS0x5OGc2N0tFN1lxOElPdWR2T3V5cUNEcXQ1enN1WmtnNG9DVUlPMlVqT3Vmck9xM3VPeWR1T3lkdENBbjY3S0U3WXE4N0oyRUlPcXpxT3Vla091THBDZnFzNkFnN0pXTTY2Q2s3S1NFSU91VmpPdW5qQ0RzbHJucmlwVHJpNlF1Q2k4dklPdXloTzJLdkNEcnJManF0YXpyaXBRZzY2eTQ3SjZsN0oyMElPeVZoT3VMaU91ZHZDRHJqNW5zbnBFZzdKMjA2NmFFN0oyMDdKYTA3SVNjTENEc25iUWc3S2VBN0l1YzZyQ0FJT3lYaHV5Y3ZPdXB0Q0Ryckxqc25xWHRtSlVnNjR5QTdKV0k3SjIwSU95RW51eVhyQ0RyZ3Bqc21LanJpNlF1Q21OdmJuTjBJRUpWVkZSUFRsOVNWVXhGSUQwS0lDQW43SjIwSU91c3VPcTFyT3VLbENBcUt1dXloTzJLdkNEcm5ienJzcWdxS3V5ZHRPdUxwQzRnNjZ5NDdKNmw3SjIwSU95VmhPdUxpT3VkdkNEcmo1bnNucEVnN0oyMDY2YUU3SjIwNjYrQTY2R2NPaURycDRqc3VhanRrWnpDdCt1c3ZPeWRqTzJSbk1LMzdLS0Y2ckt3N0phMDY2KzRLSDdzbXBRdmZ1dUxwQzkrNnJtTTdKcVVLU0RxdUlqc3A0QXNJQ2NnS3dvZ0lDZnJrSmpyajRUcm9aMGc3S2VuN0oyQUlPdVBtZXlla1NEcnFvWHNncXdvN0tDQTdKNmx3cmZzZ3Ezc29KekN0K3lYc09xeXNDRHRsYlRzb0p3ZzY1T3hLZXVobkN3ZzdZYTE2N08wN0lTeElPdUxxT3lkdkNEcnNvVHRpcnpzbmJUcnFiUWdJdTJabGV5ZHVDSXVJQ2NnS3dvZ0lDY2k3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3ZzdKT3c2ck9nTENEdG1aVHJxYlFnNnJpdzY0cWw2NnFGS091emdPcXl2Y0szN1pXMDdLQ2NJT3VUc1Nuc25ZQWc2cmU0NjR5QTY2R2NJT3VSbE91THBDNWNiaWM3Q2dvdkx5RHJyTGpxdGF3ZzdMYVU3TEtjSU8yRXRDQW9jbTlzWlQwbjY3S0U3WXE4Sit5ZHRPdXB0Q0Ryc29UdGlyd2c2cmVjN0xtWjdKMkVJT3lXdWV1S2xPdUxwQ2tLWm5WdVkzUnBiMjRnWVhOclEyeGhkV1JsS0hSbGVIUXNJRzF2WkdWc0xDQnlaWEJoY25ObExDQnliMnhsS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ1lYUjBaVzF3ZENBOUlDaGhjMnRsWkVOdmRXNTBMbWRsZENoMFpYaDBLU0I4ZkNBd0tTQXJJREU3Q2lBZ0lDQmhjMnRsWkVOdmRXNTBMbk5sZENoMFpYaDBMQ0JoZEhSbGJYQjBLVHNLSUNBZ0lHbG1JQ2hoYzJ0bFpFTnZkVzUwTG5OcGVtVWdQaUF5TURBcElHRnphMlZrUTI5MWJuUXVZMnhsWVhJb0tUc2dMeThnNjZ5MDdaV2M3WjZJSU95TWsreWR0T3luZ0NEc2xZcnFzb3dLSUNBZ0lHTnZibk4wSUhKMWJHVWdQU0J5YjJ4bElEMDlQU0FuNjdLRTdZcThKeUEvSUVKVlZGUlBUbDlTVlV4RklEb2dKeWM3Q2lBZ0lDQnlaWFIxY200Z2NuVnNaU0FySUNoaGRIUmxiWEIwSUQ0Z01Rb2dJQ0FnSUNBL0lDZnFzSm5zbllBZzY2eTQ2cldzNjZXOElPdUxwT3lMbkNEc21wVHNzcTN0bFp6cmk2UXVJT3lkdENEc2hManNoWmpzbDVEc2hKd2c3SjIwN0tDRTdKZVFJT3lnbk95VmlPMldpT3VObUNEcXNvUHJrNlRxczd3ZzZySzU3TG1ZN0tlQUlPeVZpdXVLbEN3ZzZyV3M3S0d3NjRLWUlPeVd0TzJjbU9xd2dDRHRtWlhzaTZUdG5vZ2c2NHVrNjZXNElPeURpT3Vobk95YXRDRHJqSURzbFlnZ00rcXduT3VsdkNEcXQ1enN1Wm5yaklEcm9ad2dTbE5QVGlEcnNMRHNsN1Ryb1p6cnA0dzZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtRb2dJQ0FnSUNBNklDZnJpNlRzbll3Z1ZVa2c2Nnk0NnJXczdKMllJT3VNZ095VmlDQXo2ckNjNjZXOElPcTNuT3k1bWV1TWdPdWhuQ0JLVTA5T0lPdXdzT3lYdE91aG5PdW5qRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0hSbGVIUXBLVHNLSUNCOUxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0NuMEtDaTh2SU91eWlPeVhyU0R0aExRZzRvQ1VJT3F3bWV5ZGdDRHNoTGpzaFpqc25ZUWc3Sk93NjVDWUxDRHNuYlRyc29nZzdZUzA2NmVNSU95MmxPeXluQ0R0bUpYc2k1MG9TbE5QVGlEcnNMRHNsN1FwSU91TWdPeUxvQ0Ryc29qc2w2MGc3WmlWN0l1ZEtFcFRUMDRnNnJDZDdMSzBLZXlkaENEc21wVHF0YXp0bFp6cmk2UUtablZ1WTNScGIyNGdZWE5yVkhKaGJuTnNZWFJsS0hSbGVIUXNJRzF2WkdWc0xDQnlaWEJoY25ObEtTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z0tBb2dJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnNjdLSTdKZXRJT3lla2V5WGhleWR0T3VMcENBbzY2eTQ2cldzSU91THBPdVRyT3E0c0NEc2xZVHJpNWdnNG9DVUlPdU1nT3lWaUNBejZyQ2NJT3Ezbk95NW1leWRnQ0RzbmJUcnNvZ2c3WVMwN0plUUlPeWdnZXlhcWUyVm1PeW5nQ0RzbFlycmlwVHJpNlFwTGlBbklDc0tJQ0FnSUNmcmk2VHNuWXdnVlVrZzY2eTQ2cldzNnJDQUlPMlZuT3ExcmV5V3RPdXB0Q0RzbnBEc2w3RHNpcVRybjZ6c21yUWc3SmlCN0phMDY2R2NMQ0RzbUlIc2xyVHJxYlFnN0o2UTdKZXc3SXFrNjUrczdKcTBJTzJWbk9xMXJleVd0T3VobkNEcnNvanNsNjN0bFpqcm5id3VJQ2NnS3dvZ0lDQWdKMVZKSU91c3VPcTFyT3VMcE95YXRDRHFzSVRxc3JEdGxad2c3WkdjN1ppRTdKMkVJT3lUc09xem9Dd2c3SjIwNjZhRXdyZnNpS3ZzbnBEQ3QrdW5pT3lLcE8yQ3VjSzM3WlNNNjZDSTdKMjA3SXFrN1ptQTY0MlU2NHFVSU9xM3VPdU1nT3VobkNEcnM3VHNvYlR0bFp6cmk2UXVJQ2NnS3dvZ0lDQWdKK3lia091c3VPeWRtQ0RzcElRZzdJaVk2Nlc4SU9xM3VPdU1nT3VobkNEc25LRHNwNER0bFp6cmk2UWc0b0NVSU95YmtPdXN1T3lkdENEdGxad2c3S1NFN0oyMDY2bTBJT3V5aU95WHJldVBoQ0R0bFp3ZzdLU0U2NkdjTENEc3BJVHJzSlRxdjRqc25ZUWc3SjZFN0oyWTY2R2NJT3kybE9xd2dPMlZtT3luZ0NEc2xZcnJpcFRyaTZRdUlDY2dLd29nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURxc0ozc3NyUWc3WldZNjRLWTY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvVWc2cmlJN0tlQU9pQW5JQ3NLSUNBZ0lDZDdJblJ5WVc1emJHRjBaV1FpT2lBaTY3S0k3SmV0NjZ5NElDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0prYVhKbFkzUnBiMjRpT2lBaWEyL2locEpsYmlEcm1KRHJpcFFnWlc3aWhwSnJieUo5T2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb2RHVjRkQ2tLSUNBcExDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0NuMEtDaTh2SU91TWdPMlpsTzJZbFNEcnJManF0YXdnN0tDYzdKNlJJTzJFdENEaWdKUWc3SUtzN0pxcDdKNlE2ckNBSU95RGdlMlpxZXlkaENEc2hLVHJxb1h0bFpqcnFiUWc2NmVsNjUyOTdKZVFJT3VubnV1S2xDRHJyTGpxdGF6cnBid2c2NmVNNjVPazdKYTA3S1NBNjR1a0xnb3ZMeUJ0WlhOellXZGxjem9nVzN0eWIyeGxPaWQxYzJWeUozd25ZWE56YVhOMFlXNTBKeXdnZEdWNGRIMWRJT3lnaE95eXRDRHJqSUR0bVpUcnBid2c2NmVrNjdLSUlPdXdtK3VLbE91THBDanJpNlRycHF6cmlwUWc2NnkwN0lPQjdZT2NJT0tBbEFvdkx5RHNtNHpyc0kzc2w0VWc3S2VBN0l1YzY2eTQ3SjJZSUNMc21wVHNzcTNyazZUc25ZQWc3SVNjNjZHY0lPdXN0T3EwZ0NJZzdLQ0U3S0NjNjZXOElPeW5nTzJDcE9xNHNDRHNuSVR0bGJRZzY0eUE3Wm1VSU91bnBldWR2ZXlkaENEdGhMUWc3SldJN0plUUlPdXF2ZXVWaFNEc2k2UHJpcFRyaTZRcExncG1kVzVqZEdsdmJpQmhjMnREYjIxd2IzTmxLRzFsYzNOaFoyVnpMQ0J0YjJSbGJDd2djbVZ3WVhKelpTa2dld29nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJSFJ5WVc1elkzSnBjSFFnUFNBb2JXVnpjMkZuWlhNZ2ZId2dXMTBwTG0xaGNDZ29iU2tnUFQ0S0lDQWdJQ0FnS0cwdWNtOXNaU0E5UFQwZ0oyRnpjMmx6ZEdGdWRDY2dQeUFuN0phMDdJdWM3SXFrN1lTMDdZcTRPaUFuSURvZ0oreUNyT3lhcWV5ZWtEb2dKeWtnS3lCVGRISnBibWNvYlM1MFpYaDBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXhOVEF3S1FvZ0lDQWdLUzVxYjJsdUtDZGNiaWNwT3dvZ0lDQWdjbVYwZFhKdUlDZ0tJQ0FnSUNBZ0oreWR0T3V5aUNEc21wVHNzcTNzbllBZ0l1dU1nTzJabE8yWWxTRHJyTGpxdGF3ZzdLQ2M3SjZSSXV5ZHRPdUxwQ0FvNnJpdzdLRzBJT3VzdU9xMXJDRHJpNlRyazZ6cXVMQWc3SldFNjR1WUlPS0FsQ0RzbFlUcm5wZ2c2NHlBN1ptVTZyQ0FJT3lkdE91eWlDRHRoTFRzblpnZzdLQ0U3TEswSU91bnBldWR2ZXlkdE91THBDa3VJQ2NnS3dvZ0lDQWdJQ0FuN0lLczdKcXA3SjZRNnJDQUlPMlpsT3VwdENEc2c0SHRtYW5DdCt1bnBldWR2ZXlkaENEc2hLVHJxb1h0bFpqcnFiUXNJT3lLcE8yRGdPeWR2Q0RxdDV6c3VabnFzN3dnN0ppSTdJdWNJTzJHcE95WGtDRHJwNTdyaXBRZ1ZVa2c2Nnk0NnJXczY2VzhJT3Vuak91VHBPeVd0Q0Rzb0p6c2xZanRsWmpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnNjZlbDY1Mjk3SjIwSU91MmdPeWhzZTJWbU91cHRDRHRqcmp0bFpqcXNvd2c2NUNZNjZ5ODdKYTA2NTI4T2lEc2xyVHJscVFnN1ptVTY2bTB3cmZxdUxEcmlxWHNuWmdnNjZ5NDZyV3M3SjI0N0tlQUxDRHJrNlRzbHJUcXNJZ2c3SjZRNjZhczY0cVVJT3lXdE91VWxPeWR1T3luZ0NqdGpKM3NsNFVnN1lPQTdKMjA3WXVBTCt1enVPdXN1Qy9yc29UdGlyd3NJTzJHb095S3BPMkt1Q3dnNjdtSUlPMlpsT3VwdENEc2xZanJnclFzSU91d3NPdUVpQ0RyazdFcExDRHNsclRybHFRZzdJT0I3Wm1wN0oyNDdLZUFLT3lFc2VxenRTRHRoclhyczdRdjdKaWs2NldZTCsyWmxleWR1Q0RzbXBUc3NxMHY3SldJNjRLMEtTRHFzSm5zbllBZzZyS0RMaURxdkswZzdaV0U3SnFVN1pXY0lPcXlnK3VuakNEcXM2anJuYndnN1pXY0lPdXlpT3lYa0NEc3RaenJqSUFnTXVxd25PcTVqT3luZ0N3ZzdLZW42cktNTGlEc25iVHJsWXdnYzNWbloyVnpkR2x2Ym5QcmlwUWc2N21JSU91d3NPeVh0QzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHFzSkRzbmJRZzdKYTA2NHFRSU95Z2xldVBoQ0RzbUtUcnFiUWc2Nnk3NnJpdzY2ZU1JTzJWbU95bmdDRHJwNGpybmJ3ZzRvQ1VJT3F3Z095Z2xleWRoQ0RzaExqc21yRHFzNkFnN0xTSTdKV0lJSE4xWjJkbGMzUnBiMjV6NjZXOElPMlZxT3E3bUNEcmdyVHJxYlRzaEp3c0lISmxjR3g1N0plUUlPcXdnT3lnbGV5ZGhDRHJzSjN0bm9qcXM2QWc2NnkwN0plSDdKMkVJT3lWak91Z3BPeWp2T3VwdENEcmpaUWc2NmVlN0xhY0lPeUltQ0Rzbm9qcmlwVHNwNEFnN1pXY0lPdXN1T3llcGV5Y3ZPdWhuQ0RyamFmcnRwbnNsNnpybmJ3bzdKaUlPaUFpN1ptVjdKMjRJTzJNbmV5WGhleWR0T3Vkdk9xem9DRHFzSURzb0pYdGxvanNsclRzbXBRZzRvQ1VJTzJHb095S3BPMkt1T3Vkdk91cHRDRHNsWXpyb0tUc283enNoTGpzbXBRaUtTNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcnJManF0YXpycGJ3ZzdLQ2M3SldJN1pXZ0lPdVZrQ0RzaEp6cm9ad2c3S0NSNnJlODdKMjBJT3VMcE91bHVDQXlmalBxc0p3dUlPcXdnU0Rzb0p6c2xZanNsNVFnN0ptY0lPcTN1T3VnaCtxeWpDRHNqYnpyaXBUc3A0QWc3SjIwN0p5ZzY2VzhJT3UybWV5ZHVPdUxwQzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHNncXpzbXFuc25wRHFzSUFnN0phNDZyaUo3WldZN0tlQUlPeVZpdXlkZ0NEcXRhenNzclFnN0tDVjY3TzBLT3lnaE8yWmxPdXlpTzJZdU1LM1ZWSk13cmZxdUlqc2xhSEN0KzJhbit5SW1DRHJrN0VwNjZXOElPeW5nT3lXdE91Q3RDRHJoS1BzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDY3RJTzJiaE95R2pTRHNtcFRzc3Ewb0l1dU5sQ0RzcDZmcXNvd2lMQ0FpNjdLRTdZcTg3SnFwN0p5ODY2R2NJaURyazdFcDdKMjA2Nm0wSU95bmdleWdoQ0Rzb0p6c2xZanNuWVFnNnJlNElPdXdxZTJXcGV5Y3ZPdWhuQ0RxczZEc3M1QWc2NHVrN0l1Y0lPeWduT3lWaU8yVm1PdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhTRHF1SWpzcDRBNklDY2dLd29nSUNBZ0lDQW5leUp5WlhCc2VTSTZJQ0xyaklEdG1aUWc3SjJSNjR1MUlPMlZuT3VSa0NEcnJManNucVVnS08yVnRPeWFsT3l5dENraUxDQWljM1ZuWjJWemRHbHZibk1pT2lCYmV5SjBaWGgwSWpvZ0l1dXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2dJdXlkdE95Y29DRHRsWndnNjZ5NDdKNmxJbjFkZlZ4dVhHNG5JQ3NLSUNBZ0lDQWdKMXZyaklEdG1aUmRYRzRuSUNzZ2RISmhibk5qY21sd2RBb2dJQ0FnS1RzS0lDQjlMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdDbjBLQ2k4dklPMlVoT3VnaU95ZWhPdXpoQ2p0bFpqc25JUWc3WlNFNjZDSTdKNkVJT3VzdHV5ZGpDa2c3TGFVN0xLY0lPMkV0Q0RpZ0pRZzdaV2NJTzJabE91cHRPeWRoQ0R0bFpqc25JUWc3WlNFNjZDSTdKNkVJT3VMcU95Y2hPdWhuQ0RyZ3BqcmlLQWc2N08wNjRLMDZyT2dMQW92THlBcUt1MlVoT3VnaU95ZWhPdW5pT3VMcENEcmxMRHJvWndxS2lEcmpJRHNsWWpzbllRZzY3Q2I2NHFVNjR1a0xpRHRsWndnN0pxVTdMS3Q3SmVRSU91THBDRHNpNlRzbHJRZzY3TzA2NEswNjRxVUlPcXlnK3lkdENEdGxiWHNpNnc2Q2k4dklPMlVoT3VnaU95ZWhDRHNpSmpycDR6dGdid2c3SnFVN0xLdDdKMkVJT3lxdk9xd25PdXB0Q0RxdDdqcnA0enRnYndnNjRxUTY2Q2s3S2VBNnJPZ0tPcXdnU0ExZmpFdzdMU0lLU0RxdGF6cmo0VWc3SUtzN0pxcDY1K0o2NCtFSU9xM3VPdW5qTzJCdkNEcmdwanFzSVRyaTZRdUNpOHZJR2R5YjNWd2N6b2dXM3R1WVcxbExDQjBaWGgwY3pwYlhYMWRJQ2p0bVpUcnFiUWc3SnlFNG9hUzdKV0U2NTZZSU95SW5Da3VDbVoxYm1OMGFXOXVJR0Z6YTBkeWIzVndjeWhuY205MWNITXNJRzF2WkdWc0xDQnlaWEJoY25ObExDQnRiM0psS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnZXdvZ0lDQWdMeThnNjdLRTdZcThJT3lZZ2V5WHJleWRnQ0FvNjdLRTdZcThLZXljdk91aG5DRHNzSTNzbHJRZzY3TzA2NEs0NjR1a0lPS0FsQ0Ryc29UdGlyd2c2Nnk0NnJXczY0cVVJT3VzdU95ZXBleWR0Q0RzbFlUcmk0anJuYndnNjQrWjdKNlJJT3lkdE91bWhPeWR0T3VkdkNEcXQ1enN1Wm5zbmJRZzY0dWs2NlcwNjR1a0NpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ0tHZHliM1Z3Y3lCOGZDQmJYU2t1YldGd0tDaG5MQ0JwS1NBOVBnb2dJQ0FnSUNBbld5Y2dLeUFvYVNBcklERXBJQ3NnSjEwZ0p5QXJJRk4wY21sdVp5Z29aeUFtSmlCbkxtNWhiV1VwSUh4OElDZ242cmU0NjZPNUp5QXJJQ2hwSUNzZ01Ta3BLU0FySUNobklDWW1JR2N1Y205c1pTQTlQVDBnSit1eWhPMkt2Q2NnUHlBbklDanJzb1R0aXJ3cEp5QTZJQ2NuS1NBcklDZGNiaWNnS3dvZ0lDQWdJQ0FvWnlBbUppQkJjbkpoZVM1cGMwRnljbUY1S0djdWRHVjRkSE1wSUQ4Z1p5NTBaWGgwY3lBNklGdGRLUzV0WVhBb0tIUXBJRDArSUNjZ0lDMGdKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLRk4wY21sdVp5aDBJSHg4SUNjbktTa3BMbXB2YVc0b0oxeHVKeWtLSUNBZ0lDa3VhbTlwYmlnblhHNG5LVHNLSUNBZ0lHTnZibk4wSUdoaGMwSjBiaUE5SUNobmNtOTFjSE1nZkh3Z1cxMHBMbk52YldVb0tHY3BJRDArSUdjZ0ppWWdaeTV5YjJ4bElEMDlQU0FuNjdLRTdZcThKeWs3Q2lBZ0lDQmpiMjV6ZENCclpYa2dQU0FuWjNKdmRYQnpKeUFySUNobmNtOTFjSE1nZkh3Z1cxMHBMbTFoY0Nnb1p5a2dQVDRnS0djZ0ppWWdaeTUwWlhoMGN5QS9JR2N1ZEdWNGRITXVhbTlwYmlnbkp5a2dPaUFuSnlrcExtcHZhVzRvSnljcE93b2dJQ0FnWTI5dWMzUWdZWFIwWlcxd2RDQTlJQ2hoYzJ0bFpFTnZkVzUwTG1kbGRDaHJaWGtwSUh4OElEQXBJQ3NnTVRzS0lDQWdJR0Z6YTJWa1EyOTFiblF1YzJWMEtHdGxlU3dnWVhSMFpXMXdkQ2s3Q2lBZ0lDQnBaaUFvWVhOclpXUkRiM1Z1ZEM1emFYcGxJRDRnTWpBd0tTQmhjMnRsWkVOdmRXNTBMbU5zWldGeUtDazdDaUFnSUNCamIyNXpkQ0JoWjJGcGJpQTlJRzF2Y21VZ2ZId2dZWFIwWlcxd2RDQStJREVLSUNBZ0lDQWdQeUFuN0oyMElPMlpsT3VwdE95ZGdDRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3V2dUNEcmk2VHJwSmpyaTZRdUlPeVZudXlFbkNEcmdyZ2c2NHlBN0pXSTZyTzhJT3lXdE8yY21NSzM2cldzN0tHdzZyQ0FJTzJabGV5THBPMmVpQ0RyaTZUcnBiZ2c3SU9JSU91TWdPeVZpT3VuakNEcmdyVHJuYnd1WEc0bkNpQWdJQ0FnSURvZ0p5YzdDaUFnSUNCeVpYUjFjbTRnS0FvZ0lDQWdJQ0JoWjJGcGJpQXJDaUFnSUNBZ0lDZnNuYlRyc29nZzdKcVU3TEt0N0oyQUlDTHRtWlRycWJUc25ZUWc3WldZN0p5RUlPMlVoT3VnaU95ZWhPdXpoT3VobkNEcmdwanJpS0FnNjR1azY1T3M2cml3SXV1THBDNGc3SldFNjU2WTY0cVVJTzJWbkNEdG1aVHJxYlRzblpnZzY2eTQ2cldzNjZXOElPMlZtT3ljaENEdGxJVHJvSWpzbm9RbzdKaUI3SmV0S1NEcmk2anNuSVRyb1p3ZzY2eTI3SjJBSU9xeWcreWR0T3VMcEM1Y2JpY2dLd29nSUNBZ0lDQW5LaXJzbUlIc2w2M3JwNGpyaTZRZzY1U3c2NkdjS2lvZzY0eUE3SldJN0oyRUlPdUN0T3VkdkNEaWdKUWc3SmlCN0pldDdKMkVJT3lFbk91aG5DRHRsYW5zdVpqcXNiRHJncGdnN0lpYzdJU2M2Nlc4SU91d2xPcSt1T3luZ0NEcnA0anJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2ckNCSU95WWdleVhyZXlYa0NEcmpJRHNsWWdnTXVxd25DNGc2cmU0SU95WWdleVhyZXlkdENEc2w2enJuNndnN0tTRTdKMjA2Nm0wSU91TWdPeVZpT3VQaENBcUt1cXdtZXlkZ0NEc3BJUWc3SWlZS2lycm9ad283S1NFNjdDVTZyK0lJRnhjYnV5Y3ZPdWhuQ0RxdGF6cnRvUXNJT3lraENEc2lKenNoSndnN0p5ZzdLZUFLUzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHNtSUhzbDYzc25aZ2c3SmV0N1pXZ0tPMkRnT3lkdE8yTGdNSzM3SldJNjRLMHdyZnJzb1R0aXJ3ZzY1T3hLZXF6dkNEc201RHJyTGpzblpnZzdLQ1Y2N08wd3Jmc29iRHFzYlFvN0lpcjdKNlF3cmZyaklEc2c0SEN0K3loc09xeHRDbnNuWUFnN0p5ZzdLZUE3WldZNnJPZ0xDRHNsNGJyaXBRZzdLQ1Y2N08wNjZXOElPeW5nT3lXdE91Q3RPeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSnkwZzZyT2c3TG1nSU9xeWpDRHNsNGJyaXBRZzdKaUI3SmV0N0oyMDY2bTBJT3VNZ095VmlDQXg2ckNjNjZlTUlPdUN0T3F4c091Q21DRHJ1WWdnNjdDdzdKZTA2NkdjSU91UmtPeVd0T3VQaENEcmtKenJpNlFnNG9DVUlPeVd0ZXluZ091aG5DRHJzSlRxdnJqc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGdDRHF0N2pyaklEcm9ad2c2NUdVNjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2hvWVhOQ2RHNGdQeUFuTFNBbzY3S0U3WXE4S2V5Y3ZPdWhuQ0R0a1p6c2k1enJrSndnN0ppQjdKZXQ3SjJBSUNjZ0t5QkNWVlJVVDA1ZlVsVk1SU0E2SUNjbktTQXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZ3cmZzdlpUcms1enRqcHpzaXFRZzZyaUk3S2VBT2x4dUp5QXJDaUFnSUNBZ0lDZDdJbWR5YjNWd2N5STZJRnQ3SW01aGJXVWlPaUFpN0ppQjdKZXRJT3lkdE91bWhDanNub1hyb0tYcXM3d2c2NCtaN0oyOEtTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2NHlBN0pXSUlPdXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2dJdXlkdE95Y29DRHRsWndnNjZ5NDdKNmxJbjFkZlYxOVhHNG5JQ3NLSUNBZ0lDQWdKK3lZZ2V5WHJleWRnQ0Rzbm9Ycm9LVWc3SWljN0lTY3dyZnFzSnpzaUpqcnBid2c2cmU0NjR5QTY2R2NJT3luZ08yQ3FPdUxwQzVjYmx4dUp5QXJDaUFnSUNBZ0lDZGI3SmlCN0pldDY3T0VJT3VzdU9xMXJGMWNiaWNnS3lCc2FYTjBDaUFnSUNBcE93b2dJSDBzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLVHNLZlFvS0x5OGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RzblpIcmk3WHNsNURzaEp3Z1czdHVZVzFsTENCemRXZG5aWE4wYVc5dWN6cGJlM1JsZUhRc0lISmxZWE52Ym4xZGZWMGc3TGFVN0xhY0NtWjFibU4wYVc5dUlIQmhjbk5sUjNKdmRYQnpLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQmhjbklnUFNCQmNuSmhlUzVwYzBGeWNtRjVLRzhnSmlZZ2J5NW5jbTkxY0hNcElEOGdieTVuY205MWNITWdPaUJiWFRzS0lDQWdJR052Ym5OMElHZHliM1Z3Y3lBOUlHRnljaTV0WVhBb0tHY3BJRDArSUNoN0NpQWdJQ0FnSUc1aGJXVTZJRk4wY21sdVp5Z29aeUFtSmlCbkxtNWhiV1VwSUh4OElDY25LUzUwY21sdEtDa3NDaUFnSUNBZ0lITjFaMmRsYzNScGIyNXpPaUJCY25KaGVTNXBjMEZ5Y21GNUtHY2dKaVlnWnk1emRXZG5aWE4wYVc5dWN5a0tJQ0FnSUNBZ0lDQS9JR2N1YzNWbloyVnpkR2x2Ym5NS0lDQWdJQ0FnSUNBZ0lDQWdMbTFoY0Nnb2VDa2dQVDRnS0hSNWNHVnZaaUI0SUQwOVBTQW5jM1J5YVc1bkp3b2dJQ0FnSUNBZ0lDQWdJQ0FnSUQ4Z2V5QjBaWGgwT2lCNExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lBbkp5QjlDaUFnSUNBZ0lDQWdJQ0FnSUNBZ09pQjdJSFJsZUhRNklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5SbGVIUXBJSHg4SUNjbktTNTBjbWx0S0Nrc0lISmxZWE52YmpvZ1UzUnlhVzVuS0NoNElDWW1JSGd1Y21WaGMyOXVLU0I4ZkNBbkp5a3VkSEpwYlNncElIMHBLUW9nSUNBZ0lDQWdJQ0FnSUNBdVptbHNkR1Z5S0NoNEtTQTlQaUI0TG5SbGVIUXBDaUFnSUNBZ0lDQWdPaUJiWFN3S0lDQWdJSDBwS1RzS0lDQWdJQzh2SU95ZHRPdW1oT3loc095d3FDRHNsNGJxczZBZzdLQ2M3SldJNjQrRUlPeVhodXVLbENEcXU0M3JqYkRxdUxEcnA0d2c3Sm1VN0p5ODY2bTBJTzJZbGV5TG5TRHNuYlR0ZzRqcm9ad2c2N080NjR1a0tPcXdtZXlkZ0NEc2hManNoWmpzbDVBZzdKNnM3SnFVN0xLdEtRb2dJQ0FnY21WMGRYSnVJR2R5YjNWd2N5NXpiMjFsS0NobktTQTlQaUJuTG5OMVoyZGxjM1JwYjI1ekxteGxibWQwYUNrZ1B5Qm5jbTkxY0hNZ09pQnVkV3hzT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3Q2lBZ0lDQnlaWFIxY200Z2JuVnNiRHNLSUNCOUNuMEtDaTh2SU8yTW5leVhoU0RzaExqdGlyZ2c3TGFVN0xLY0lPMkV0Q0RpZ0pRZzdaV2NJTzJNbmV5WGhleWRtQ0RxdGF6c2hMSHNtcFRzaG93bzdKZXQ3WldnSyt1c3VPcTFyQ25ycGJ3ZzdaV2NJT3V5aU95WGtDRHJzN1RyZ3JUcXM2QXNDaTh2SU95YWxPeUdqT3V6aENEcmdySHFzSnpxc0lBZzdKV0U2NHVJNjUyOElDb3E3Sm1FN0lTeDY1Q2NJTzJNbmV5WGhTRHNoTGp0aXJnbzdMeUE3SjIwN0lxa0tTQXlmalBxc0p3cUt1dWx2Q0R0aHJYc25MenJvWndnNjdDYjY0cVU2NHVrTGdvdkx5RHRnNERzbmJUdGk0REN0K3lWaU91Q3RNSzM2N0tFN1lxODdKMjBJTzJWbkNEcnFyanNuTHpyb1p3ZzdKMjg2clNBNjQrODdKVzhJTzJWbU91dmdPdWhuQ2pybExEcm9ad2c2NzJSN0pXRUlPeWhzTzJWcWUyVm1PdXB0Q0RzbHJUcXVJdnJncHpyaTZRcElPeUV1TzJLdUNEcmk2anNuSVRyb1p3ZzdLQ2M3SldJN1pXWTZyS01JTzJWbk91THBDNEtMeThnWld4bGJXVnVkSE02SUZ0N2NtOXNaU3dnZEdWNGRIMWRJQ2p0bVpUcnFiUWc3SnlFNG9hUzdKV0U2NTZZSU95SW5Da3VDaTh2SUcxdmNtVTlkSEoxWlNoYjdMeUE3SjIwN0lxa0lPdU5sQ0Ryc0p2cXVMQmRLZXVwdENEc25iUWc3SVM0N0lXWTdKZVE3SVNjSU95ZHRPdXZ1Q0RyZ3JnZzdJUzQ3WXE0N0ptQUlPcXl1ZXk1bU95bmdDRHNsWXJyaXBRZzdJT0lJT3lFdU8yS3VPdWx2Q0RzbXBUcXRhenRsWnpyaTZRdUNtWjFibU4wYVc5dUlHRnphMUJ2Y0hWd0tHVnNaVzFsYm5SekxDQnRiMlJsYkN3Z2NtVndZWEp6WlN3Z2JXOXlaU2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lHTnZibk4wSUhKdmJHVnpJRDBnS0dWc1pXMWxiblJ6SUh4OElGdGRLUzV0WVhBb0tHVXBJRDArSUZOMGNtbHVaeWdvWlNBbUppQmxMbkp2YkdVcElIeDhJQ2NuS1NrdWFtOXBiaWduTENBbktUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQW9aV3hsYldWdWRITWdmSHdnVzEwcExtMWhjQ2dvWlN3Z2FTa2dQVDRLSUNBZ0lDQWdLR2tnS3lBeEtTQXJJQ2N1SUZzbklDc2dVM1J5YVc1bktDaGxJQ1ltSUdVdWNtOXNaU2tnZkh3Z0p5Y3BJQ3NnSjEwZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtGTjBjbWx1Wnlnb1pTQW1KaUJsTG5SbGVIUXBJSHg4SUNjbktTa0tJQ0FnSUNrdWFtOXBiaWduWEc0bktUc0tJQ0FnSUM4dklPcXdtZXlkZ0NEdGpKM3NsNFhzbllRZzY2cUhJT3V5aU95bnVDRHJyTHZyaXBUc3A0QWc2cml3N0phMUlPS0FsQ0RzbnF6c21wVHNzcTNzbmJUcnFiUWdJdXlkdE95Z2hPcXp2Q0RyaTZUcnBiZ2c3SVM0N1lxNEl1dWx2Q0RzbXBUcXRhenRsWnpyaTZRS0lDQWdJQzh2SUNoaGMydERiR0YxWkdYc21ZQWc2ckNaN0oyQUlPeWR0T3ljb0RvZzdKV0lJT3EzdU91ZnJPdXB0Q0R0Z2JUcm9aenJrNXpxc0lBZzZyQ1o3SjJBSU95RXVPMkt1T3VsdkNEcm1KQWc2NEswN0lTY0lGdnN2SURzbmJUc2lxUWc2NDJVSU91d20rcTRzRjNxc0lBZzY2eTA3SjJZNjYrNDdaVzA3S2VFNjR1a0tRb2dJQ0FnWTI5dWMzUWdhMlY1SUQwZ0ozQnZjSFZ3QVNjZ0t5QW9aV3hsYldWdWRITWdmSHdnVzEwcExtMWhjQ2dvWlNrZ1BUNGdVM1J5YVc1bktDaGxJQ1ltSUdVdWRHVjRkQ2tnZkh3Z0p5Y3BLUzVxYjJsdUtDY0JKeWs3Q2lBZ0lDQmpiMjV6ZENCaGRIUmxiWEIwSUQwZ0tHRnphMlZrUTI5MWJuUXVaMlYwS0d0bGVTa2dmSHdnTUNrZ0t5QXhPd29nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvYTJWNUxDQmhkSFJsYlhCMEtUc0tJQ0FnSUdsbUlDaGhjMnRsWkVOdmRXNTBMbk5wZW1VZ1BpQXlNREFwSUdGemEyVmtRMjkxYm5RdVkyeGxZWElvS1RzZ0x5OGc2NnkwN1pXYzdaNklJT3lNayt5ZHRPeW5nQ0RzbFlycXNvd0tJQ0FnSUdOdmJuTjBJR0ZuWVdsdUlEMGdiVzl5WlNCOGZDQmhkSFJsYlhCMElENGdNUW9nSUNBZ0lDQS9JQ2ZzbmJRZzdZeWQ3SmVGN0oyQUlPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA2Nis0SU91THBPdWttT3VMcEM0ZzdKV2U3SVNjSU95Z25PeVZpTzJWbkNEc2hManRpcmpyazZUcXM3d2dLaXJzb0pIcXQ3ekN0K3lXdE8yY21PcXdnQ0R0bVpYc2k2VHRub2dnNjR1azY2VzRJT3lEaUNEc2hManRpcmdxS3V1bmpDRHJnclRybmJ3bzZyQ1o3SjJBSU95RXVPMkt1Q0Ryc0pqcnM3VWc2cmlJN0tlQUtTNWNiaWNLSUNBZ0lDQWdPaUFuSnpzS0lDQWdJSEpsZEhWeWJpQW9DaUFnSUNBZ0lHRm5ZV2x1SUNzS0lDQWdJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnSXUyTW5leVhoU2pyaTZUc25iVHNscnpyb1p6cXQ3Z3BJT3lFdU8yS3VDRHJpNlRyazZ6cXVMQWk2NHVrTGlEc2xZVHJucGpyaXBRZzdaV2NJTzJNbmV5WGhleWRoQ0RzbklUaWhwTHNsWVRybnBqcm9ad2c2NEtZN0plMDdaV2NJT3Exck95RXNleWFsT3lHak91VHBPeWR0T3VMcENqc2hKenJvWndnNjZ5MDZyU0E3WldjSU91emhPcXduQ0RyckxqcXRhenFzSUFnN0pXRTY0dUk2NHVrS1M0Z0p5QXJDaUFnSUNBZ0lDZnNtcFRzaG96cnBid2c2NEt4NnJDYzY2R2NJT3F6b095NW1PeW5nQ0RycDVEcXM2QXNJQ29xN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2T3lkdENEc2hKenJvWndnN0oyODZyU0E2NUNjSUNMc21ZVHNoTEhya0p3ZzdZeWQ3SmVGSU95RXVPMkt1Q0lnTW40ejZyQ2NLaXJycGJ3ZzdLQ2M3SldJN1pXWTY1MjhMaURxc0lFZzdJUzQ3WXE0NjRxVUlPeUVuT3VobkNEcmk2VHJwYmdnN0tDUjZyZTg3SjIwN0phMDdKVzhJTzJWbk91THBDNWNiaWNnS3dvZ0lDQWdJQ0FuNnJDQklPeUV1TzJLdU91S2xDRHNub1hyb0tYcXM3d2dLaXJxc0puc25ZQWc3SmV0N1pXZ3dyZnFzSm5zbllBZzZyQ2M3SWlZd3JmcXNKbnNuWUFnN0lpYzdJU2NLaXJzblpnZzdKcVU3SWFNNjZXOElPdXFxT3VSa0NEdGo2enRsYWp0bFp6cmk2UXVJT3lFdU8yS3VDRHNsWWpzbDVEc2hKd2c3WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZPeWRnQ0R0bFp3ZzY2cTQ3Snk4NjZHY0lPdW5udXlWaE91V3FPeVd0T3lndU95VnZDRHRsWnpyaTZRbzdKaUlPaURyczdqcnJManNuYlFnSW43dGxhRHF1WXpzbXBRL0l1dXB0Q0Ryc29UdGlyenNuWUFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBwTGx4dUp5QXJDaUFnSUNBZ0lDZGI3WXlkN0plRklPdXN1T3l5dENEcXQ1enN1WmtnNG9DVUlPeWNoQ0RzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jN0oyWUlDSTRMaUR0akozc2w0VWlJT3lFdWV5Rm1PeWRoQ0RybExEcnBianJpNlJkWEc0bklDc0tJQ0FnSUNBZ0p5MGc3WU9BN0oyMDdZdUFPaURzcDZmc25ZQWc2NnFGN0lLczZyV3NLREorTk95V3RPeWdpQ2tzSU95aWhlcXlzT3lXdE91dnVNSzM2NmVJN0xtbzdaR2NJT3lYaHV5ZHRDaCs3SnFVTDM3cmk2UXZmdXE1ak95YWxEOGc2cmlJN0tlQUtTNGc2N0NZNjVPYzdJdWNJT3lWaU91Q3RDanJzN2pyckxncElPdW5wZXVkdmV5ZGhDRHNtcFRzbGIzdGxiUWc3WU9BN0oyMDdZdUE2NmVNSU91MGtPdVBoQ0RyckxUc2lxZ2c3WXlkN0plRjdKMjQ3S2VBSU95VmpPcXlqQ0R0bFpqcm5id3VJT3lia091enVPeWR0Q0FpN0pXTTY2YThMKzJabGV5ZHVDTHNzcGpybjd3ZzY2ZUo3SmV3N1pXWTY2bTBJT3V6dU91c3VPeWRoQ0RxdDd6cXNiRHJvWndnNnJXczdMSzA3Wm1VN1pXWTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPeVZpT3VDdENqcnM3anJyTGdwT2lEdGxiVHNtcFRzc3JRdUlPMk1rT3VMcU95ZHRDRHRsWVRzbXBUdGxaanJxYlFnSW43dGxhRHF1WXpzbXBRL0l1dWhuQ0Ryckx2cXM2QXNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc2NHFVSU95Y2hPMlhtQ2pzZ3Ezc29KekN0KzJEaU8ySHRDRHJrN0VwN0oyQUlPcXlzT3F6dk91bHZDRHJxTHpzb0lBZzZySzk2ck9nN1pXYzY0dWtMaURxc3JEcXM3ekN0K3lEZ2UyRG5DRHRoclhyczdUcnFiUWc3SVNjN0lpZzdaaVY3Snk4NjZHY0lPeVZqT3Vtc091THBDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcnNvVHRpcnc2SU91enVPdXN1T3lkdENBaWZ1MlZvT3E1ak95YWxEOGk2Nm0wSUZ2c2xZVHJpNGpzbUtSZEwxdnJoS1JkTENEcnM3anJyTGpzbmJRZzdJT0I3Wm1wN0oyRUlPeUVuT3lJb08yVm1PcXpvQ0RzbmJRZzY3S0U3WXE4N0oyMElPeUxwT3lnbkNEcmo1bnNucEhzbmJUcnFiUWc2NCtaN0o2UklPdVBtZXlDckNqc2dxM3NvSnd2N0tDQTdKNmxMK3lYc09xeXNDRHRsYlRzb0p3ZzY1T3hLU3dnN1lhMTY3TzBJTzJNbmV5WGhleWRtQ0RyaTZqc25id2c2N0tFN1lxODdKMjA2Nm0wSUNMdG1aWHNuYmdpTGlBaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenJwNHdzSUNMcmk2dnF1TERDdCt1UG1leWVrU0lnN0tHdzdaV3BJT3E0aU95bmdDNGc3Wm1VNjZtMElPcTRzT3VLcGV1cWhTanJzNERxc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bklDc0tJQ0FnSUNBZ0p5MGc3SnVRNjZ5NDdKMllJT3lnbGV1enRNSzM3S0d3NnJHMEtPeUlxK3lla01LMzdKMjA3SU9CTCt5ZHRPMlZtTUszNjR5QTdJT0JLZXlkZ0NEc25LRHNwNER0bFpqcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZ3cmZzdlpUcms1enRqcHpzaXFRZzZyaUk3S2VBT2x4dUp5QXJDaUFnSUNBZ0lDZDdJbk5sZEhNaU9pQmJleUp5WldGemIyNGlPaUFpN0oyMElPeUV1TzJLdU95ZG1DRHJzS250bHFYc25ZUWc3WldjNnJXdDdKYTBJTzJWbkNEcnJManNucVhzbkx6cm9ad2lMQ0FpWld4bGJXVnVkSE1pT2lCYmV5SnliMnhsSWpvZ0l1eVhyZTJWb0NJc0lDSjBaWGgwSWpvZ0l1dXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraWZTd2dMaTR1WFgwc0lDNHVMbDE5WEc0bklDc0tJQ0FnSUNBZ0oreVhyZTJWb095ZGdDRHNub1hyb0tVZzdJaWM3SVNjNjR5QTY2R2NPaUFuSUNzZ2NtOXNaWE1nS3lBblhHNWNiaWNnS3dvZ0lDQWdJQ0FuVysyTW5leVhoU0RzbXBUc2hveGRYRzRuSUNzZ2JHbHpkQW9nSUNBZ0tUc0tJQ0I5TENCdGIyUmxiQ3dnY21Wd1lYSnpaU2s3Q24wS0NpOHZJTzJNbmV5WGhTRHNuWkhyaTdYc2w1RHNoSndnZTNObGRITTZJRnQ3Y21WaGMyOXVMQ0JsYkdWdFpXNTBjenBiZTNKdmJHVXNkR1Y0ZEgxZGZWMTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa0tablZ1WTNScGIyNGdjR0Z5YzJWUWIzQjFjQ2h5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYSHRiWEhOY1UxMHFYSDB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93b2dJQ0FnWTI5dWMzUWdjMlYwYzBsdUlEMGdRWEp5WVhrdWFYTkJjbkpoZVNodklDWW1JRzh1YzJWMGN5a2dQeUJ2TG5ObGRITWdPaUJiWFRzS0lDQWdJR052Ym5OMElITmxkSE1nUFNCelpYUnpTVzRLSUNBZ0lDQWdMbTFoY0Nnb2MzUXBJRDArSUNoN0NpQWdJQ0FnSUNBZ2NtVmhjMjl1T2lCVGRISnBibWNvS0hOMElDWW1JSE4wTG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTd0tJQ0FnSUNBZ0lDQmxiR1Z0Wlc1MGN6b2dRWEp5WVhrdWFYTkJjbkpoZVNoemRDQW1KaUJ6ZEM1bGJHVnRaVzUwY3lrS0lDQWdJQ0FnSUNBZ0lEOGdjM1F1Wld4bGJXVnVkSE1LSUNBZ0lDQWdJQ0FnSUNBZ0lDQXViV0Z3S0NobGJDa2dQVDRnS0hzZ2NtOXNaVG9nVTNSeWFXNW5LQ2hsYkNBbUppQmxiQzV5YjJ4bEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCMFpYaDBPaUJUZEhKcGJtY29LR1ZzSUNZbUlHVnNMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcENpQWdJQ0FnSUNBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvWld3cElEMCtJR1ZzTG5SbGVIUXBDaUFnSUNBZ0lDQWdJQ0E2SUZ0ZExBb2dJQ0FnSUNCOUtTa0tJQ0FnSUNBZ0xtWnBiSFJsY2lnb2MzUXBJRDArSUhOMExtVnNaVzFsYm5SekxteGxibWQwYUNrN0NpQWdJQ0J5WlhSMWNtNGdjMlYwY3k1c1pXNW5kR2dnUHlCelpYUnpJRG9nYm5Wc2JEc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V3b2dJQ0FnY21WMGRYSnVJRzUxYkd3N0NpQWdmUXA5Q2dvdkx5RHJqSUR0bVpUdG1KVWc3S0NjN0o2UklPeWRrZXVMdGV5WGtPeUVuQ0I3Y21Wd2JIa3NJSE4xWjJkbGMzUnBiMjV6VzExOUlPeTJsT3kybkNBbzdMMlU2NU9jN1k2YzdJcWt3cmZzbFo3cmtxUWc3SjZoNjR1MElPMlhpT3lhcVNrS1puVnVZM1JwYjI0Z2NHRnljMlZEYjIxd2IzTmxLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQnlaWEJzZVNBOUlGTjBjbWx1Wnlnb2J5QW1KaUJ2TG5KbGNHeDVLU0I4ZkNBbkp5a3VkSEpwYlNncE93b2dJQ0FnWTI5dWMzUWdjM1ZuWjJWemRHbHZibk1nUFNCQmNuSmhlUzVwYzBGeWNtRjVLRzhnSmlZZ2J5NXpkV2RuWlhOMGFXOXVjeWtLSUNBZ0lDQWdQeUJ2TG5OMVoyZGxjM1JwYjI1ekNpQWdJQ0FnSUNBZ0lDQXViV0Z3S0NoNEtTQTlQaUFvZXlCMFpYaDBPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNTBaWGgwS1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQ0J5WldGemIyNDZJRk4wY21sdVp5Z29lQ0FtSmlCNExuSmxZWE52YmlrZ2ZId2dKeWNwTG5SeWFXMG9LU0I5S1NrS0lDQWdJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tIZ3BJRDArSUhndWRHVjRkQ2tLSUNBZ0lDQWdPaUJiWFRzS0lDQWdJR2xtSUNoeVpYQnNlU0I4ZkNCemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElISmxkSFZ5YmlCN0lISmxjR3g1TENCemRXZG5aWE4wYVc5dWN5QjlPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95VmhPdWVtT3VobkNBcUx5QjlDaUFnY21WMGRYSnVJRzUxYkd3N0NuMEtDaTh2SU91eWlPeVhyU0RzblpIcmk3WHNsNURzaEp3Z2UzUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZibjBnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpWUnlZVzV6YkdGMFpTaHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdZMjl1YzNRZ2RISmhibk5zWVhSbFpDQTlJRk4wY21sdVp5Z29ieUFtSmlCdkxuUnlZVzV6YkdGMFpXUXBJSHg4SUNjbktTNTBjbWx0S0NrN0NpQWdJQ0JwWmlBb2RISmhibk5zWVhSbFpDa2djbVYwZFhKdUlIc2dkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1T2lCVGRISnBibWNvS0c4Z0ppWWdieTVrYVhKbFkzUnBiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmVHNLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc2xZVHJucGpyb1p3Z0tpOGdmUW9nSUhKbGRIVnliaUJ1ZFd4c093cDlDZ292THlEc25aSHJpN1hzbDVEc2hKd2dlM1JsZUhRc0lISmxZWE52Ym4wZzY3Q3c3SmUwSU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlRkV2RuWlhOMGFXOXVjeWh5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYRnRiWEhOY1UxMHFYRjB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHRnljaUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCcFppQW9RWEp5WVhrdWFYTkJjbkpoZVNoaGNuSXBLU0I3Q2lBZ0lDQWdJSEpsZEhWeWJpQmhjbklLSUNBZ0lDQWdJQ0F1YldGd0tDaDRLU0E5UGlBb2V5QjBaWGgwT2lCVGRISnBibWNvS0hnZ0ppWWdlQzUwWlhoMEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCeVpXRnpiMjQ2SUZOMGNtbHVaeWdvZUNBbUppQjRMbkpsWVhOdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa0tJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaDRLU0E5UGlCNExuUmxlSFFwT3dvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95VmhPdWVtT3VobkNBcUx5QjlDaUFnY21WMGRYSnVJRnRkT3dwOUNnb3ZMeURyb1p6cXQ3anNuYmdnN1pXRTdKcVV3cmZ0bFp6cmo0UWc3TFNJNnJPOElPeURnZTJEbk95ZHZDRHJsWXdnTDJobFlXeDBhQ0Rzb2JEdG1venFzSUFnN0ppazY2bTBJT3VTcE95WGtPeUVuQ0RzbTR6cnNJM3NsNFhzbllRZzY0dWs3SXVjSU95TG5PdVBoTzJWdE91enVPdUxwQ0FvTXpEc3RJanNsNUFnTWV1eWlPdW5qQ2t1Q2k4dklPeUVzZXF6dGUyVm1PdXB0Q0Rxc3JEcXM3d2c3Wlc0NjVPazY1K3M2ckNBSUdOc1lYVmtaVk4wWVhSMWN6MG5iMnNuNjZHY0lPdVFtT3VQak91bXJPdXZnT3VobkN3ZzdKNnM2NkdjNnJlNDdKMjRJTzJiaENEcnNvVHRpcnpzbmJRZzdLQ0E3S0NJNjZHY0lQQ2ZuNkxzbkx6cm9ad2c2N08xNnJlQTdaV2M2NHVrTGdvdkx5QW83WlNNNjUrczZyZTQ3SjI0N0oyMElPdWhuT3EzdU95ZHVDRHNzTDNzbllRZzdKZXdJT3VTcENEc283enF1TERzb0lIc25MenJvWndnTDJobFlXeDBhT3VsdkNEc29iRHRtb3p0bFpqcmlwUWc2cktENnJPOElPeW5uZXlkaENEc25iVHJvNnpyaTZRcENpOHZJTzJWbk91UGhDRHN0SWpxczd6cmo0UWc2ckNaN0oyQUlPcXl2ZXVobk91aG5DRHJzN1hxdDREc2k1enRncWpyaTZRZzRvQ1VJT3EwZ091bXJPeWVrT3F3Z0NEdGxaenJqNFRycGJ3ZzdKaXM2NkNrN0tPODZyR3c2NEtZSU8yVm5PdVBoT3F3Z0NEc3RJanF1TER0bVpUcmtKanJxYlFLTHk4ZzdJS3M3SnFwN0o2UTZyQ0FJT3lWaE91c3RPcXlnK3VQaENEc2xZZ2c2NGlNNjUrczY0K0VJT3V5aE8yS3ZPeWR0Q0R3bjUraTdKeTg2NkdjSU91UGpPeVZoT3lZcU91THBDNGc3WldjNjQrRTdKZVFJT3F4dU91bXNDRHRtTGpzdHB6c25ZQWc2ckd3N0tDSTY1Q1k2NitBNjZHY0lPeUNyT3lhcWV1ZmlleWRnQ0RzbFlnZzY0S1k2ckNFNjR1a0NpOHZJT3F6aE95Z2xleWR0Q0FxS3V1d2x1eVhrT3lFbkNvcUlPdXdsT3VBa0NEcXNvUHNuWVFnN0pXTTdKV0U3TEdJNjR1a0lDZ3lNREkyTFRBNExDQkNVa2xFUjBWZlZqMHlOaWt1Q2k4dklPMkVzT3V2dU91RWtPeWR0T3VDbUNEcnVJenJuYnpzbXJEc29JRHNsNURzaEp3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsWmpycWJRZzdKNlE2cktwN0thZDY2cUZJTzJNak95ZHZPeWRnQ0Ryc0pUcmdJenNwNERycDR3c0lPeWR0T3V2dUNEcmxxQWc3SjZJNjRxVUlHTnNZWFZrWlFvdkx5RHNoTGpzaFpqc25ZQWc3SXVjNjQrWjdaV2dJT3VWakNEcnNKdnNuWUFnN0ppYklPcXpoT3lnbFNEc25vWHNucVhxdG96c25ZUWc2cmU0NjR5QTY2R2NJT3lUdE91THBDRGlocElnN0lPSUlPcXpoT3lnbGV5WGtDRHNncXpzbXFucm40bnNuYlFnNjRLbzdKV0VJT3llaU95V3RPdVBoQ0FpN1pXYzY0K0VJT3kwaU9xenZDTHFzSUFLTHk4ZzZyT0U3SWFOSU91Q21PeVlxT3VMcENneU1ESTJMVEE0SU95THBPeTRvU0RzaTZEcXM2QTZJQ0xzZzRnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJXaU91S2xPdU5zQ0RzbVp3ZzZyZTRJT3F6aE95Z2xTRHNncXpzbXFucm40bnNuWVFnNjZxN0lPeVRzT3VEa0NJcExnb3ZMeUR0bEl6cm42enF0N2pzbmJqc25ZUWc2ckd3N0xtY0lPdWhuT3EzdU95ZHVNSzM2NkdjNnJlNDdKV0U3SnVES0M5dmNHVnVMV3h2WjJsdXdyY3ZZMnhoZFdSbExXeHZaMjkxZENuc25ZQWdhMmxzYkZCeWIyUHNuTHpyb1p3ZzdJUzQ3SVdZN0oyRUlPdXloT3VncE95RW5DRHNuYlFnNjZ5NDdLQ2M2ckNBQ2k4dklPeVhodXlYaU91S2xPdU5zQ3dnNjdDVzdKZVE3SVNjSU91d2xPcSt1T3VwdENEcmk2VHJwcXpxc0lBZzdKV01JT3V3cWV1eWxleWR0Q0RzbDRic2w0anJpNlF1SU9xM3VPdWVtT3lFbkNBdmFHVmhiSFJvSU95aHNPMmFqT3VuaU91THBDRHRqSXpzbmJ6c25aZ2c2ck9FN0tDVjZyTzhJT3U1aE9xMWtPMlZuT3VMcEM0S0x5OGc2N21FN0pxcElEQW83WXlNN0oyODY2ZU1JT3lkdmVxem9Dd2dZMnhoZFdSbFFXTmpiM1Z1ZE95ZG1DQXpNT3kwaUNEc3VwRHNpNXpycGJ3ZzZyZTQ2NHlBNjZHY0lPeVR0T3VMcENEaWdKUWdMbU5zWVhWa1pTNXFjMjl1N0oyMElPeTdwT3lFbkNEcnA2VHJzb2dnN0oyOTdLZUFJT3lWaXV1S2xPdUxwQ2t1Q2k4dklPcXpoT3lnbFNEc25vanNuWXdnNG9hU0lPeVhodXlkakNqcm9aenF0N2pzbFlUc200TXBJT3V3cWUyV3BleWRnQ0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a09pRHRqSXpzbmJ6c25ZUWc2NDJ1N0phMDdKT3c2NHFVSU95SW5PcXdoQ0RzbnFEcXVaQWc2NnE3SU95ZHZldUtsQ0Rxc29QcXM3d0tMeThnNnJXczY3YUU2NUNZN0tlQUlPeVZpdXlWaENEdGw1c2c3SjZzN0l1YzdKNlI3SjJFSU91MmdPdWx0T3F6b0N3ZzZyZTRJT3V3cWUyV3BleWRnQ0RzbmJqc3BwMGc3SmlrNjZXWUlPcXl2ZXVobkNocGMwRjFkR2hGY25KdmNpbnFzSUFnN0oyMDY2KzRJT3l5bU91bXJPMlZuT3VMcEM0S1puVnVZM1JwYjI0Z2NtVnpkR0Z5ZEVsbVFXTmpiM1Z1ZEVOb1lXNW5aV1FvS1NCN0NpQWdhV1lnS0NGd2NtOWpJSHg4SUhkaGFYUmxjaWtnY21WMGRYSnVPeUFnSUNBZ0lDQWdJQzh2SU95RXVPeUZtQ0RzbDRic25Zd282NHVrN0oyTUlPMkV0T3lkdENEc2c0anJvWndnN0l1YzY0K1pLU0F2SU8yRXRDRHNwNFR0bG9rZzdLU1I3SjIwNjZtMElPdUxwT3lkakNEc29iRHRtb3pzbDVEc2hKd0tJQ0JqYjI1emRDQnViM2NnUFNCamJHRjFaR1ZCWTJOdmRXNTBLQ2s3Q2lBZ2FXWWdLQ0Z1YjNjZ2ZId2dibTkzSUQwOVBTQnpaWE56YVc5dVFXTmpiM1Z1ZENrZ2NtVjBkWEp1T3dvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RxczRUc29KWHNuYlFnNjdDVTY0Q003SmVJN0phMDdKcVVJQ2duSUNzZ0tITmxjM05wYjI1QlkyTnZkVzUwSUh4OElDZnNsNGJzbll3bktTQXJJQ2NnNG9hU0lDY2dLeUJ1YjNjZ0t5QW5LU0RpZ0pRZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2N0tFNjZhczZyT2dJT3lEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NHVrN0l1Y0lPeUxuT3lla2UyVnFldUxpT3VMcEM0bktUc0tJQ0F2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NS0hKbFlYTnZiaURzcDREc29KVXBJT0tBbENCVFJWTlRTVTlPWDBSSlJVVHJvWndnNjRHZDY0SzA2Nm0wSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRxc0lBZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2YXc2NHVrQ2lBZ2EybHNiRkJ5YjJNb0orcXpoT3lnbGV5ZHRDRHJzSlRyZ0l6c2xyVHNoSndnN0lTNDdJV1k3SjJFSU95RGlPdWhuQ0RzaTV6c25wSHRsb2pzbHJUc21wUWc0b0NVSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcE93b2dJR05zWVhWa1pWTjBZWFIxY3lBOUlHNTFiR3c3SUM4dklPMlZuT3VQaE1LMzY2R2M2cmU0N0oyNElPeURnZTJEbk91S2xDRHFzNFRzb0pYcnA0anJpNlFnNjR1azY2VzA2NHVrSU9LQWxDRHNnNGdnNnJPRTdLQ1Y3Snk4NjZHY0lPdUxwT3lMbkNEdGpKRHNvSlh0bFpqcXNvd0tJQ0J6WlhOemFXOXVRV05qYjNWdWRDQTlJRzV2ZHpzS2ZRb0tiR1YwSUd4aGMzUkJkWFJvVW1WMGNubEJkQ0E5SURBN0NtWjFibU4wYVc5dUlISmxkSEo1UVhWMGFFbG1UbVZsWkdWa0tDa2dld29nSUdsbUlDaGpiR0YxWkdWVGRHRjBkWE1nSVQwOUlDZGpiR0YxWkdVdGJHOW5iM1YwSnlBbUppQmpiR0YxWkdWVGRHRjBkWE1nSVQwOUlDZGpiR0YxWkdVdGJHbHRhWFFuS1NCeVpYUjFjbTQ3Q2lBZ2FXWWdLSGRoYVhSbGNpQjhmQ0JFWVhSbExtNXZkeWdwSUMwZ2JHRnpkRUYxZEdoU1pYUnllVUYwSUR3Z016QXdNREFwSUhKbGRIVnlianNnTHk4ZzdLZUU3WmFKSU95a2tTRHRoTFFnNjdDcDdaVzBJT3E0aU95bmdDQXJJRE13N0xTSUlPcXdoT3F5cVFvZ0lHeGhjM1JCZFhSb1VtVjBjbmxCZENBOUlFUmhkR1V1Ym05M0tDazdDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHNucXp0bVpYc25iZ2c3SXVjNjQrRTRvQ21KeWs3Q2lBZ2NuVnVWSFZ5Ymlnb0tTQTlQaUFuNjZHYzZyZTQ3SjI0SU8yWmxleWR1T3lhcWV5ZHRPdUxwQzRnSWs5TEl1dWR2T3F6b091bmpDRHJpN1h0bFpqcm5id3VKeWt1ZEdobGJpZ0tJQ0FnSUNncElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZzdabVY3SjI0NjVDb0lPS0FsQ0Rzb0pYc2c0RWc3SU9CN1lPYzY2R2NJT3V6dGVxM2dDNG5LU3dLSUNBZ0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SldFN0tlQklPdWhuT3EzdU95ZHVDRHNsWWdnNjVDb09pY3NJRk4wY21sdVp5aGxMbTFsYzNOaFoyVXBMbk5zYVdObEtEQXNJRGd3S1NrS0lDQXBPd3A5Q2dvdkx5RHNpNlR0aktnZzdKMlI2NHUxN0oyRUlPeUNyT3Vlak95YXFTRHNsWWpyZ3JUcm9ad2c2N09BN1ptWUlPS0FsQ0RzbTVEc25iZ282NkdjNnJlNDdKMjRMK3lFcE95NW1DbnNuYlFnN1l5TTdKV0Y2NUNjSU9xeXZleWFzT3lYbENEcXQ3Z2c3SldJNjRLMDY2VzhMQ0RzbFlUcmk0anJxYlFnN0tDUjY1R1E3SmEwSyt5YmtPdXN1T3lkaENEcnM3VHJncmpyaTZRS1puVnVZM1JwYjI0Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENCd2NtVm1hWGdwSUhzS0lDQnBaaUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQVDA5SUV4UFIwbE9YMGRWU1VSRktTQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ1RFOUhTVTVmUjFWSlJFVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiRzluYjNWMEp5QjlPd29nSUdsbUlDaGxJQ1ltSUdVdWJXVnpjMkZuWlNBOVBUMGdURWxOU1ZSZlIxVkpSRVVwSUhKbGRIVnliaUI3SUdWeWNtOXlPaUJNU1UxSlZGOUhWVWxFUlN3Z2NISnZZbXhsYlRvZ0oyTnNZWFZrWlMxc2FXMXBkQ2NnZlRzS0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25LU0I3Q2lBZ0lDQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ0oreWR0Q0JRUSt5WGtDQkRiR0YxWkdVZ1EyOWtaU2hqYkdGMVpHVXA2ckNBSU95RXBPeTVtT3VQdkNEc25vanNwNEFnN0pXSzdKV0U3SnFVSU9LQWxDRHNoS1RzdVpqdGxaanFzNkFnNjZHYzZyZTQ3SjI0N1pXY0lPdVNwQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRuTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuSUgwN0NpQWdmUW9nSUhKbGRIVnliaUI3SUdWeWNtOXlPaUJ3Y21WbWFYZ2dLeUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQeUJsTG0xbGMzTmhaMlVnT2lCVGRISnBibWNvWlNrcElIMDdDbjBLQ21aMWJtTjBhVzl1SUhKbFlXUkNiMlI1S0hKbGNTa2dld29nSUhKbGRIVnliaUJ1WlhjZ1VISnZiV2x6WlNnb2NtVnpiMngyWlNrZ1BUNGdld29nSUNBZ2JHVjBJR0p2WkhrZ1BTQW5KenNLSUNBZ0lISmxjUzV2YmlnblpHRjBZU2NzSUNoaktTQTlQaUI3SUdKdlpIa2dLejBnWXpzZ2ZTazdDaUFnSUNCeVpYRXViMjRvSjJWdVpDY3NJQ2dwSUQwK0lIc0tJQ0FnSUNBZ2RISjVJSHNnY21WemIyeDJaU2hLVTA5T0xuQmhjbk5sS0dKdlpIa3BLVHNnZlNCallYUmphQ0FvWDJVcElIc2djbVZ6YjJ4MlpTaDdmU2s3SUgwS0lDQWdJSDBwT3dvZ0lIMHBPd3A5Q2dwamIyNXpkQ0JEVDFKVFgwaEZRVVJGVWxNZ1BTQjdDaUFnSjBGalkyVnpjeTFEYjI1MGNtOXNMVUZzYkc5M0xVOXlhV2RwYmljNklDY3FKeXdLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEFvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFJWldGa1pYSnpKem9nSjBOdmJuUmxiblF0Vkhsd1pTY3NDbjA3Q21aMWJtTjBhVzl1SUdwemIyNG9jbVZ6TENCemRHRjBkWE1zSUc5aWFpa2dld29nSUhKbGN5NTNjbWwwWlVobFlXUW9jM1JoZEhWekxDQlBZbXBsWTNRdVlYTnphV2R1S0hzZ0owTnZiblJsYm5RdFZIbHdaU2M2SUNkaGNIQnNhV05oZEdsdmJpOXFjMjl1T3lCamFHRnljMlYwUFhWMFppMDRKeUI5TENCRFQxSlRYMGhGUVVSRlVsTXBLVHNLSUNCeVpYTXVaVzVrS0VwVFQwNHVjM1J5YVc1bmFXWjVLRzlpYWlrcE93cDlDZ3BqYjI1emRDQnpaWEoyWlhJZ1BTQm9kSFJ3TG1OeVpXRjBaVk5sY25abGNpaGhjM2x1WXlBb2NtVnhMQ0J5WlhNcElEMCtJSHNLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0owOVFWRWxQVGxNbktTQjdJSEpsY3k1M2NtbDBaVWhsWVdRb01qQTBMQ0JEVDFKVFgwaEZRVVJGVWxNcE95QnlaWFIxY200Z2NtVnpMbVZ1WkNncE95QjlDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkSFJWUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoYkhSb0p5a2dld29nSUNBZ2NtVnpkR0Z5ZEVsbVFXTmpiM1Z1ZEVOb1lXNW5aV1FvS1RzZ0x5OGc2N0NXN0plUTdJU2NJT3F6aE95Z2xleWRoQ0Ryc0pUcXY2anNuTHpycWJRZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2Nmk4N0tDQUlPdXloT3Vtc091THBDQW83SldFNjU2WUlPeWJqT3V3amV5WGhleWR0Q0RzbUpzZzZyT0U3S0NWN0p5ODY2R2NJT3VQak95bmdDRHNsWXJxc293cENpQWdJQ0J5WlhSeWVVRjFkR2hKWms1bFpXUmxaQ2dwT3lBdkx5RHJvWnpxdDdqc25iZ2c3WldFN0pxVUlPeURnZTJEbk91cHRDRHNucXp0bVpYc25iZ2c3SXVjNjQrRUlPS0FsQ0RzbnF6cm9aenF0N2pzbmJqc25iUWc2NEdkNjRLczdKeTg2Nm0wSU91THBPeWRqQ0Rzb2JEdG1venJ0b0R0aExBZ2NISnZZbXhsYmV5ZHRDRHRrb0RycHJEcmk2UUtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdDaUFnSUNBZ0lHOXJPaUIwY25WbExDQmxibWRwYm1VNklDZGpiR0YxWkdVbkxDQjJPaUJDVWtsRVIwVmZWaXdnWkdseU9pQmZYMlJwY201aGJXVXNJQzh2SUhiQ3QyUnBjam9nNnJXczY3S0U3S0NFTCt5WGlldWFzZTJWbkNEc2dxenJzN2pzbmJRZzY1YWdJT3llaU91S2xPeW5nQ0RzcDRUcmk2anNtcWtLSUNBZ0lDQWdiVzlrWld3NklHTjFjbkpsYm5STmIyUmxiQ3dnYlc5a1pXeHpPaUJCVEV4UFYwVkVYMDFQUkVWTVV5d2daWGhoYlhCc1pYTTZJRVZZUVUxUVRFVlRMbXhsYm1kMGFDd2daM1ZwWkdVNklFZFZTVVJGTG14bGJtZDBhQ3dnY21WaFpIazZJSGRoY20xbFpGVndMQW9nSUNBZ0lDQndjbTlpYkdWdE9pQW9ZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQW5iMnNuSUh4OElHTnNZWFZrWlZOMFlYUjFjeUE5UFQwZ2JuVnNiQ2tnUHlCdWRXeHNJRG9nWTJ4aGRXUmxVM1JoZEhWekxBb2dJQ0FnSUNCaFkyTnZkVzUwT2lCamJHRjFaR1ZCWTJOdmRXNTBLQ2tzQ2lBZ0lDQWdJSE5sY25abFpEb2djM1JoZEhNdWMyVnlkbVZrTENCc1lYTjBRWFE2SUhOMFlYUnpMbXhoYzNSQmRDd2diR0Z6ZEZSbGVIUTZJSE4wWVhSekxteGhjM1JVWlhoMExDQnNZWE4wVTJWak9pQnpkR0YwY3k1c1lYTjBVMlZqTEFvZ0lDQWdmU2s3Q2lBZ2ZRb2dJQzh2SU8yVWpPdWZyT3EzdU95ZHVDRHNpNnpzbnFYcnNKWHJqNWtnNG9DVUlPdUJpdXE0c091cHRDRHNuSVFnNnJDUTdJdWNJTzJEZ095ZHRPdW91T3F3Z0NEcmk2VHJwcXpycGJ3ZzY0R0k2NHVrQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDJobFlYSjBZbVZoZENjcElIc0tJQ0FnSUd4aGMzUkNaV0YwSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxJSDBwT3dvZ0lIMEtJQ0F2THlEcm9aenF0N2pzbmJnZzRvQ1VJTzJVak91ZnJPcTN1T3lkdU95ZG1DQmI4Sitmb0NEdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0oyNElPMlZoT3lhbEYzQ3QxdnduNVNSWFNEcnNvVHRpcnpzbmJRZzdaaTQ3TGFjN1pXYzY0dWtMZ29nSUM4dklPcTRzT3V6dUNqcnVJenJuYnpzbXJEc29JQWc3S2VCN1phSktUb2dZR05zWVhWa1pTQmhkWFJvSUd4dloybHVJQzB0WTJ4aGRXUmxZV2xnNjZXOElPeUlxT3lkZ0NEdGxJVHJvWnpzaExqc2lxVHJvWndnN0l1azdaYUpJT0tBbENEcnFaVHJpYlFnN0plRzdKMjBJT3F6cCt5ZXBTRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA2ck9nTEFvZ0lDOHZJQ0FnYkc5allXeG9iM04wSU95SW1PeUxvQ0R0ajZ6dGlyanJvWndnNnJLdzZyTzg2Nlc4SU95ZWtPdVBtU0RzaUpqcm9MbnRsWnpyaTZRbzdJdWs3TGloT2lEdGw2VHJrNXpycHF6c2lxVHNsNURzaEp6cmo0UWc2N2lNNjUyODdKcXc3S0NBSU95WHRPdW12Q0FySUV4SlUxUkZUaUR0bVpYc25iZ3NJREl3TWpZdE1EY3BMZ29nSUM4dklDQWc3WVN3NjYrNDY0U1E3SjIwSU8yWmxPdXB0T3lYa0NEc29JVHRtSUFnN0pXSUlPdWNyT3VMcEM0ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1T3VuakNEdGxaanJxYlFnNjRHZExnb2dJQzh2SU8yUHRPdXdzU2p0aExEcnI3anJoSkFwT2lEc25wRHJqNWtnN0ptRTY2T002ckNBSU91bmllMmVqQ0R0bVpqcXNyMG82N2lNNjUyODdKcXc3S0NBNnJDQUlHeHZZMkZzYUc5emRPeVhrQ0RycXJzZzY0dS83SldFSU95OWxPdVRuT3F3Z0NEcnM3VHNuYlRyaXBRZzZySzk3SnF3S2V5WGtPeUVuQW9nSUM4dklDQWc2NkdjNnJlNDdKMjRJT3VNZ09xNHNDRHNwSkVnNjdLRTdZcTg3SjJFSU91WWtDRHJpSVRycGJUcnFiUXNJT3k5bE91VG5PdWx2Q0RydHBuc2w2enJoS1BzbllRZzdJaVlJT3llaU91S2xDRHRoTERycjdqcmhKQWc2N0NwN0l1ZDdKeTg2NkdjSU95Z2hPMlptTzJWbk91THBDNEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZiM0JsYmkxc2IyZHBiaWNwSUhzS0lDQWdJR052Ym5OMElHSnZaSGtnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnWTI5dWMzUWdjM2RwZEdOb1RXOWtaU0E5SUNFaEtHSnZaSGtnSmlZZ1ltOWtlUzV6ZDJsMFkyaEJZMk52ZFc1MEtUc2dMeThnNnJPRTdLQ1ZJT3lnaE8yWm1DQTlJT3lMbk8yQnJPdW12eURzc0wzc25MenJvWndnN0plMDdKYTBJT3F6aE95Z2xleWRoQ0RxczZEcnBid2c3SWlZSU95ZWlPcXlqQW9nSUNBZ2RISjVJSHNLSUNBZ0lDQWdMeThnWTJ4aGRXUmw2ckNBSU95WGh1eWN2T3VwdENEc2w2enF1TERzaEp3ZzY0R0s2NHFVNjR1a0xpQnphR1ZzYkRwMGNuVmw2NTI4SUdOc1lYVmtaZXF3Z0NEc2w0YnNsclRyajRRZzdJVzQ3SjJBSU95Z2xleURnU0RzaTZUdGxvbnJqN3dLSUNBZ0lDQWdMeThnYzNCaGQyN3NuWmdnSjJWeWNtOXlKK3F3Z0NEc2xZZ2c2NXlvNnJPZ0xDRHNtSWpzb0lUc2w1UWc2cmU0NjR5QTY2R2NJRzlyT25SeWRXWHJwYndnNjQrTTY2Q2s3S1NzNjR1a0lPS0FsQW9nSUNBZ0lDQXZMeUR0bEl6cm42enF0N2pzbmJqc25ZQWdJdXU0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RzbDRqc2xyVHNtcFFpNjUyODZyT2dJTzJWbU91S2xPdU5zQ0RzaTZUc29KenJvWnpyaXBRZzdKV0U2NnkwNnJLRDY0K0VJT3lWaUNEcm5LanJpcFFnN0lPQjdZT2M2ckNBSU91UWtPdUxwQ2pzaTZUc29Kd2c3SXVnNnJPZ0tTNEtJQ0FnSUNBZ2FXWWdLR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdKMk5zWVhWa1pTMXRhWE56YVc1bkp5a2dld29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF4TENCN0NpQWdJQ0FnSUNBZ0lDQmxjbkp2Y2pvZ0oreWR0Q0JRUSt5WGtDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZzRvQ1VJTzJFc091dnVPdUVrT3lYa095RW5DQmpiR0YxWkdVZ0xTMTJaWEp6YVc5dUlPeWR0Q0Rya0pqcmlwVHNwNEFnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0bkxBb2dJQ0FnSUNBZ0lDQWdjSEp2WW14bGJUb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp5d0tJQ0FnSUNBZ0lDQjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQXZMeURzcDRUdGxva2c3S1NSN0oyNDY0MndJT3VZa0NEcmlJenJvSURyaTZRZzRvQ1VJT3E0aU91d3FTZzJNT3kwaUNEcmdyUXBJT3VMcE95TG5DRHJpSVRycGJnZzZyRzBJQ0xzc0wzc25ZUWc2NHVyN0pXWTY0dWtMK3VxdXlEcnRLVHJpNlFpN0plUUlPcXdnT3E1ak95YXNPdXZnT3VobkNEcnVJenJuYnpzbXJEc29JRHJvWndnN0o2czdJdWM2NCtFN1pXYzY0dWtMZ29nSUNBZ0lDQXZMeUR0bFp6c3NMZ2c2NUtrN0plUTY0K0VJT3VZa0NEcmlJVHJwYlRyaXBRZzZyRzBJT3U0ak91ZHZPeWFzT3lnZ09xd2dDQnNiMk5oYkdodmMzUWc3TDJjNjdDeDdKZVFJT3VxdXlEcmk3L3NsWVFnN0o2UTY0K1pJT3laaE91ampPcXdnQ0RzbFlnZzY1Q1k2NHFVSU8yWm1PcXl2ZXlkdkNEc2lKZ2c3SjZJN0p5ODY0dUlDaUFnSUNBZ0lDOHZJT3EzdU91VmpPdW5qQ0RzdlpUcms1enJwYndnNjdhWjdKZXM2NFNqN0oyRUlPeUltQ0Rzbm9qcmlwUWc3WVN3NjYrNDY0U1FJT3V3cWV5TG5leWN2T3VobkNEdGo3VHJzTEh0bFp6cmk2UWdLT3VSa0NEcnNvanNwN2dnN1lHMDY2YXQ3SmVRSU8yRXNPdXZ1T3VFa095ZHRDRHRpb0RzbHJUcmdwanNtS1RycWJRZzY0dTU3Wm1wN0lxazY1Kzk2NHVrS1M0S0lDQWdJQ0FnWTI5dWMzUWdjM1JoYkdVZ1BTQnNiMmRwYmxCeWIyTWdKaVlnS0VSaGRHVXVibTkzS0NrZ0xTQnNiMmRwYmxOMFlYSjBaV1JCZENBK0lEWXdNREF3S1RzS0lDQWdJQ0FnYVdZZ0tHeHZaMmx1VUhKdll5QW1KaUJ6ZEdGc1pTa2dld29nSUNBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc0tJQ0FnSUNBZ0lDQnBaaUFvSVc5d1pXNU1iMmRwYmxSbGNtMXBibUZzS0NrcElIc0tJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF4TENCN0lHVnljbTl5T2lBbjdKMjBJRTlUN0plUTdJU2dJT3lla091UG1leWN2T3VobkNEcnFyc2c3SmUwN0phMDdKcVVJT0tBbENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJT3lMcE8yV2lTRHRtNFFnTDJ4dloybHVJTzJWdENEc283enNoTGpzbXBRdUp5QjlLVHNLSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJQ0FnTHk4ZzdKMlk2NCtFN0tDQklPeWloZXVqakNoeVpXRnpiMjRnN0tlQTdLQ1ZLU0RpZ0pRZzdLZUU3WmFKSU95a2tTRHRoTFRzbllRZ1UwVlRVMGxQVGw5RVNVVkU2NkdjSU91Qm5ldUN0T3VwdENEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1zT3VMcEFvZ0lDQWdJQ0FnSUd0cGJHeFFjbTlqS0Nmcm9aenF0N2pzbmJqc25ZUWc3S2VFN1phSjdaV1k2NHFVSU95a2tleWR0T3VkdkNEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJvWnpxdDdqc25iZ2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcE93b2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEdGo3VHJzTEVnNG9DVUlPMkVzT3V2dU91RWtDRHJzS25zaTUzc25MenJvWndnN0tDRTdabVlMaWNwT3dvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQW5kR1Z5YldsdVlXd25JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc2dMeThnN0pXZTdJU2dJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqc25iUWc2NHlBNnJpd0lPeWtrZXlkdE91cHRDRHNvSkhxczZBZzdJT0k2NkdjSU95WHNPdUxwQ0FvN0xDOTdKMkVJT3VMcSt5Vm1PcXhzT3VDbUNEcmk2VHNpNXdnNjRpRTY2VzRJT3F5dmV5YXNDa0tJQ0FnSUNBZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNBdkx5QkNVazlYVTBWUzY0cVVJT3F4dE91VG5PdW1yT3luZ0NEc2xZcnJpcFRyaTZRZzRvQ1VJRU5NU2Vxd2dDRHF1TERyczdnZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95bmdleWdrU0RzbDdEcmk2UWdLT3ljaENBblFsSlBWMU5GVWlEcXNJRHJvWnpzc1lUcXVMRHJpcFFnN0tDYzZyR3c2NUNRNjR1a0p5RHNvN3pzaEowZzdMQzQ2ck9nS1FvZ0lDQWdJQ0JqYjI1emRDQnNiMmRwYmtWdWRpQTlJRU5NUVZWRVJWOUZUbFk3Q2lBZ0lDQWdJR052Ym5OMElIUm9hWE5NYjJkcGJpQTlJSE53WVhkdUtDZGpiR0YxWkdVbkxDQmJKMkYxZEdnbkxDQW5iRzluYVc0bkxDQW5MUzFqYkdGMVpHVmhhU2RkTENCN0NpQWdJQ0FnSUNBZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ2JHOW5hVzVGYm5Zc0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2QybHVaRzkzYzBocFpHVTZJSFJ5ZFdVc0NpQWdJQ0FnSUNBZ1pHVjBZV05vWldRNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ0lUMDlJQ2QzYVc0ek1pY3NJQzh2SUd0cGJHeE1iMmRwYmxCeWIyUHNuWmdnNnJlNDY2TzVJR3RwYkd6c21xa2dLR3RwYkd4UWNtOWo2ck84SU91UG1leWR2Q0R0aktqdGhMUXBDaUFnSUNBZ0lIMHBPd29nSUNBZ0lDQnNiMmRwYmxCeWIyTWdQU0IwYUdselRHOW5hVzQ3Q2lBZ0lDQWdJSFJvYVhOTWIyZHBiaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdsbUlDaHNiMmRwYmxCeWIyTWdQVDA5SUhSb2FYTk1iMmRwYmlrZ2JHOW5hVzVRY205aklEMGdiblZzYkRzZ2ZTazdDaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdJVDA5SUhSb2FYTk1iMmRwYmlrZ2NtVjBkWEp1T3dvZ0lDQWdJQ0FnSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnYVdZZ0tHeHZaMmx1VUhKdlkxUnBiV1Z5S1NCN0lHTnNaV0Z5VkdsdFpXOTFkQ2hzYjJkcGJsQnliMk5VYVcxbGNpazdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdiblZzYkRzZ2ZRb2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQzh2SU95RGlDRHFzNFRzb0pYc25id2c3SWlZSU95ZWlPeWN2T3VMaUNEcmk2VHNuWXdnTDJobFlXeDBhQ0RybFl3ZzY0dWs3SXVjSU95ZHZlcTRzQW9nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJT3lnaU95d3FDRHNvb1hybzR3Z0tHTnZaR1VnSnlBcklHTnZaR1VnS3lBbktTY3BPd29nSUNBZ0lDQWdJQzh2SU95Q3JPdWVqT3lkdENEcm9aenF0N2pzbmJqdGxhQWc3SXVjNnJDRTY0K0VJT3lYaHV5ZHRDRHFzNmZyc0pUcm9ad2c3SXVrN1l5bzY2R2NJT3VCbmV1Q3JPdUxwQ0E5SUdOc1lYVmtaZXF3Z0NEc2w0YnFzYkRyZ3BnZzdJdWs3WmFKN0oyMElPeVZpQ0Rya0p3ZzZyS0RMZ29nSUNBZ0lDQWdJQzh2SU95ZGtldUx0ZXlkZ0NEc25iVHJyN2dnNjdPMDY0T0k3Snk4NjR1SUlPeURnZTJEbk91bHZDRHJpNlRzaTV3ZzdKNnM3SVNjSUM5b1pXRnNkR2pyb1p3ZzdKV002NmF3NjR1a0lDanRsSXpybjZ6cXQ3anNuYmpzbmJRZzY0eUE2cml3SU8yWmxPdXB0T3lkaENEc2k2VHRqS2pyb1p3ZzY3Q1U2cjY4NjR1a0tTNEtJQ0FnSUNBZ0lDQnBaaUFvWTI5a1pTQWhQVDBnTUNBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQQ0ExTURBd0tTQjdDaUFnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNDdKMjBJT3ltaWV5TG5DRHNpNlR0aktqcm9ad2c2NEdkNjRLb0lPS0FsQ0JEYkdGMVpHVWdRMjlrWlNEc2hLVHN1WmdnN0lPQjdZT2M2Nlc4SU91THBPeUxuQ0Rzb0pEcXNvRHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJQ0FnSUNCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BPd29nSUNBZ0lDQWdJSDBLSUNBZ0lDQWdmU2s3Q2lBZ0lDQWdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZ01URHJ0b1FnNnJLOTZyTzhJT0tBbENEcmpJRHF1TEFnN1pTRTY2R2M3SVM0N0lxa0lPeWdsZXVtckM0bktUc2dhMmxzYkV4dloybHVVSEp2WXlncE95QjlMQ0EyTURBd01EQXBPd29nSUNBZ0lDQXZMeURyZ3FIc25ZQWc3SjZGN0o2bDZyYU03SjJFSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NHlBNnJpd0lPeUV1T3lGbU95ZGdDRHJzb1RycHJEcmk2UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzZzRnZzdJUzQ3SVdZS095RGlDRHNub1hzbnFYcXRvd3A3Snk4NjZHY0lPeUxuT3lla2UyVm1PcXlqQzRLSUNBZ0lDQWdMeThnN0oyWTY0K0U3S0NCSU95aWhldWpqQ2h5WldGemIyNGc3S2VBN0tDVktTRGlnSlFnVTBWVFUwbFBUbDlFU1VWRTY2R2NJT3VCbmV1Q3RPdXB0Q0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91Z3BBb2dJQ0FnSUNBdkx5RHNucXpyb1p6cXQ3anNuYmdnNjVLazdKZVE2NCtFSUUxQldGOVVWVkpPVStxNWpPeW5nQ0RzbUpzZzZyT0U3S0NWN0p5ODY2R2NJT3l5bU91bXJPdVFtT3VLbENEcnNvVHF0N2pxc0lBZzY1Q2M2NHVrSUNneU1ESTJMVEEzSU91bXJPdTNzT3lYa095RW5DRHRtWlhzbmJncENpQWdJQ0FnSUd0cGJHeFFjbTlqS0Nmcm9aenF0N2pzbmJqc25ZUWc3S2VFN1phSjdaV1k2NHFVSU95a2tleWR0T3VkdkNEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJvWnpxdDdqc25iZ2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcE93b2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd093b2dJQ0FnSUNBdkx5QnpkMmwwWTJoTmIyUmw2NHFVSU95ZHRPeWduQ0Ryb1p6cXQ3Z2c2Nnk0NnJXc3dyZnNuWkhyaTdVZ2JXOWtaU0R0a1p6c2k1enNtcWtnNG9DVUlGVlNUT3lkZ0NEcmtaQWc2cks5N0pxd0lPdXFxT3VSa0NCRFRFbnFzSUFnNnJlNDY0eUE2NkdjSU95WHNPdUxwQ2pzbklRZ1FsSlBWMU5GVWlEc283enNoSjBwQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJT3lMbk95ZWtTY2dLeUFvYzNkcGRHTm9UVzlrWlNBL0lDY2dLT3F6aE95Z2xTRHNvSVR0bVpnZzRvQ1VJT3lLdWV5ZHVDRHRtWlRycWJUc2w1RHNoSndnVytxemhPeWdsU0Rzb0lUdG1aaGQ3SjJFSU91SWhPdWx0T3VwdENEcmk2VHJwYmdnNnJPRTdLQ1Y3SjJFSU9xem9PdWx2Q0RzaUpnZzdKNkk3SmEwN0pxVUtTY2dPaUFuSnlrZ0t5QW5JT0tBbENEcm9aenF0N2pzbmJqdGxaanJxYlFnN0o2UTY0K1pJT3lYc09xeXNPdVFxZXVMaU91THBDNG5LVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHMXZaR1U2SUhOM2FYUmphRTF2WkdVZ1B5QW5Zbkp2ZDNObGNpMXpkMmwwWTJnbklEb2dKMkp5YjNkelpYSW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TUN3Z2V5Qmxjbkp2Y2pvZ0ordWhuT3EzdU95ZHVDRHNzTDNzbllRZzY2cTdJT3lYdE95WGlPeVd0T3lhbERvZ0p5QXJJR1V1YldWemMyRm5aU0I5S1RzS0lDQWdJSDBLSUNCOUNpQWdMeThnS08yRXNPdXZ1T3VFa0NEdGo3VHJzTEVnNnJXczdaaUU2N2FBSU9LQWxDRHJ1SXpybmJ6c21yRHNvSUFnN0o2UTY0K1pJT3laaE91ampPcXdnQ0RzbFlnZzY1Q1k2NHFVSU8yWm1PcXl2U0Rzb0lUc21xa3BDaUFnWm5WdVkzUnBiMjRnYjNCbGJreHZaMmx1VkdWeWJXbHVZV3dvS1NCN0NpQWdJQ0I3Q2lBZ0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdDaUFnSUNBZ0lDQWdMeThnYzNSaGNuVHFzSUFnN0lPSUlPeTltT3lHbENEc3NMM3NuWVFnNjZlTTY1T2c2NHVrSUNqcmk2VHJwcXpzblpnZzdJaW83SjJBSU95OW1PeUdsT3F6dkNEcnJMVHF0SUR0bFpqcXNvd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPdXp0T3llaENrdUNpQWdJQ0FnSUNBZ0x5OGc3SjIwN0phMDdJU2NJRkJ2ZDJWeVUyaGxiR3dvTG5Cek1TbnNuYlFnTmV5MGlDRHJrcVFnNnJlNElPeXd2ZXlYa0NEc2w1VHRoTERycGJ3ZzY3TzA2NEswSURIcnNvZ282cldzNjQrRklPcXpoT3lnbFNuc25ZUWc3SjZRNjQrWklPeUVvTzJEbmUyVm1PcXpvQ3dLSUNBZ0lDQWdJQ0F2THlEc3NMM3NuWVFnN0xXYzdJYU03Wm1VN1pXMElPeUNyT3lhcWV5ZWtDRHJpSWpzbDVRZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1T3VuakNEcmdxanFzb3dnN1pXYzY0dWtMaURzc0wzc25ZUWc2NnE3SU95d3Z1eWN2T3VwdENEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU8yVm5PdUxwQW9nSUNBZ0lDQWdJQzh2SUNqcmk2VHJwYmdnN0xDOUlPeVlwT3llaGV1Z3BTRHJzS25zcDRBZzRvQ1VJT3EzdUNEcXNyM3NtckFnNjZtVTY0bTA2ckNBSU91enRPeWR0T3VLbENEc3NZVHJvWndnNjRLbzZyT2dJT3lDck95YXFleWVrT3F3Z0NEc2w1VHRoTEFnN1pXY0lPdXlpQ0RyaUlUcnBiVHJxYlFnNjVDb0tTNEtJQ0FnSUNBZ0lDQXZMeURzbzd6c25aZzZJR05zWVhWa1plcXdnQ0Rzdlpqc2hwUWc3S0NjNjZxcDdKMkVJT3V3bE9xK3VPdXB0Q0JCY0hCQlkzUnBkbUYwWlM5R2FXNWtWMmx1Wkc5MzZyQ0FJT3VxdXlEc3NMN3NuWVFnN0lpWUlPeWVpT3lkakNEaWdKUWc3SnlJNjQrRTdKcXdJT3lMcE9xNHNPeVhrT3lFbkNEdG1aWHNuYmdnN1pXRTdKcVVMZ29nSUNBZ0lDQWdJR052Ym5OMElIQnpNU0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdGJHOW5hVzR1Y0hNeEp5azdDaUFnSUNBZ0lDQWdabk11ZDNKcGRHVkdhV3hsVTNsdVl5aHdjekVzSUZzS0lDQWdJQ0FnSUNBZ0lDZFRkR0Z5ZEMxVGJHVmxjQ0F0VTJWamIyNWtjeUExSnl3S0lDQWdJQ0FnSUNBZ0lDY2tkM01nUFNCT1pYY3RUMkpxWldOMElDMURiMjFQWW1wbFkzUWdWMU5qY21sd2RDNVRhR1ZzYkNjc0NpQWdJQ0FnSUNBZ0lDQWlhV1lnS0NSM2N5NUJjSEJCWTNScGRtRjBaU2duWTJ4aGRXUmxMV3h2WjJsdUp5a3BJSHNpTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdKSGR6TGxObGJtUkxaWGx6S0NkK0p5a2lMQW9nSUNBZ0lDQWdJQ0FnSnlBZ1UzUmhjblF0VTJ4bFpYQWdMVk5sWTI5dVpITWdNaWNzQ2lBZ0lDQWdJQ0FnSUNBaUlDQkJaR1F0Vkhsd1pTQXRUbUZ0WlhOd1lXTmxJRlVnTFU1aGJXVWdWeUF0VFdWdFltVnlSR1ZtYVc1cGRHbHZiaUFuVzBSc2JFbHRjRzl5ZENoY0luVnpaWEl6TWk1a2JHeGNJaWxkSUhCMVlteHBZeUJ6ZEdGMGFXTWdaWGgwWlhKdUlGTjVjM1JsYlM1SmJuUlFkSElnUm1sdVpGZHBibVJ2ZHloemRISnBibWNnWXl3Z2MzUnlhVzVuSUhRcE95QmJSR3hzU1cxd2IzSjBLRndpZFhObGNqTXlMbVJzYkZ3aUtWMGdjSFZpYkdsaklITjBZWFJwWXlCbGVIUmxjbTRnWW05dmJDQlRhRzkzVjJsdVpHOTNLRk41YzNSbGJTNUpiblJRZEhJZ2FDd2dhVzUwSUc0cE95Y2lMQW9nSUNBZ0lDQWdJQ0FnSWlBZ0pHZ2dQU0JiVlM1WFhUbzZSbWx1WkZkcGJtUnZkeWhiVG5Wc2JGTjBjbWx1WjEwNk9sWmhiSFZsTENBblkyeGhkV1JsTFd4dloybHVKeWtpTEFvZ0lDQWdJQ0FnSUNBZ0p5QWdhV1lnS0NSb0lDMXVaU0JiVTNsemRHVnRMa2x1ZEZCMGNsMDZPbHBsY204cElIc2dXM1p2YVdSZFcxVXVWMTA2T2xOb2IzZFhhVzVrYjNjb0pHZ3NJRFlwSUgwbkxDQXZMeUEySUQwZ1UxZGZUVWxPU1UxSldrVUtJQ0FnSUNBZ0lDQWdJQ2Q5Snl3S0lDQWdJQ0FnSUNCZExtcHZhVzRvSjF4eVhHNG5LU0FySUNkY2NseHVKeWs3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdZbUYwSUQwZ2NHRjBhQzVxYjJsdUtHOXpMblJ0Y0dScGNpZ3BMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTMXNiMmRwYmk1aVlYUW5LVHNLSUNBZ0lDQWdJQ0JtY3k1M2NtbDBaVVpwYkdWVGVXNWpLR0poZEN3Z0owQmxZMmh2SUc5bVpseHlYRzRuSUNzS0lDQWdJQ0FnSUNBZ0lDZHpkR0Z5ZENBaVkyeGhkV1JsTFd4dloybHVJaUJqYldRZ0wyc2dZMnhoZFdSbElDOXNiMmRwYmx4eVhHNG5JQ3NLSUNBZ0lDQWdJQ0FnSUNkd2IzZGxjbk5vWld4c0lDMU9iMUJ5YjJacGJHVWdMVVY0WldOMWRHbHZibEJ2YkdsamVTQkNlWEJoYzNNZ0xVWnBiR1VnSWljZ0t5QndjekVnS3lBbklseHlYRzRuS1RzS0lDQWdJQ0FnSUNCemNHRjNiaWduWTIxa0p5d2dXeWN2WXljc0lHSmhkRjBzSUhzZ1pXNTJPaUJEVEVGVlJFVmZSVTVXTENCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcE93b2dJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2RrWVhKM2FXNG5LU0I3Q2lBZ0lDQWdJQ0FnTHk4Z2NIUjVLR1Y0Y0dWamRDbnJvWndnNjdPMDY0SzRJTzJDcE95WGtDRHRnYlRyb1p6cms1d2dWRlZKNnJDQUlPdXN0T3V3bU95ZGtleWR1Q0Rxc29Qc25iUWc3SXVrN0xpaElPMlpsZXlkdU91UXFDZ3lNREkyTFRBM0xDRHNuYnpyc0pnZ1hITEN0MnRwZEhSNUlPeTlsT3VUbkNEcnFxanJrWkFwSU9LQWxBb2dJQ0FnSUNBZ0lDOHZJT3ljb095ZHZPMlZuQ0RzbnBEcmo1bnRtWlFnNnJLOTY2R2M2NHFVSUZONWMzUmxiU0JGZG1WdWRIUHNuWmdnN0tlRTdLZWNJTzJDcENEc25vWHJvS1V1SU95Z2tlcTN2T3lFc1NEcXRvenRsWnpzbmJRZzdKNkk3Snk4NjZtMElEYnN0SWdnNjVLa0lPeVhsTzJFc09xd2dDRHNucERyajVrZzdKNkY2NkNsNjQrOENpQWdJQ0FnSUNBZ0x5OGdNZXV5aUNqcXRhenJqNFVnNnJPRTdLQ1ZLZXlkdENEc2hLRHRnNTNya0pqcXM2QXNJT3Eyak8yVm5PeWR0Q0RzbDRic25MenJxYlFnYTJWNWMzUnliMnRsSU95a2hPdW5qQ0Rzb2JEc21xbnRub2dnN0l1azdZeW83WlcwSU95Q3JPeWFxZXlla09xd2dDRHNsNVR0aExBZzdaV2NJT3V5aUNEcmlJVHJwYlRycWJRZzY1Q2M2NHVrS0daaGFXd3RjMjltZENrdUNpQWdJQ0FnSUNBZ0x5OGc3SmVVN1lTd0lPeW5nZXlnaE95WGtDQlVaWEp0YVc1aGJPeWRoQ0RyaTZUc2k1d2c3SldlN0p5ODY2R2NJT3F3Z095Z3VPeVpnQ0RyaTZUcnBiZ2c3Sld4N0plUUlPMkNwT3F3Z0NEcms2VHNsclRxc0lEcmlwUWc2cktEN0oyRUlPdW5pZXVLbE91THBDNEtJQ0FnSUNBZ0lDQnpjR0YzYmlnbmIzTmhjMk55YVhCMEp5d2dXd29nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbFJsY20xcGJtRnNJaUIwYnlCa2J5QnpZM0pwY0hRZ0ltTnNZWFZrWlNBdmJHOW5hVzRpSnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdZV04wYVhaaGRHVW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlEWW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbFJsY20xcGJtRnNJaUIwYnlCaFkzUnBkbUYwWlNjc0NpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBblpHVnNZWGtnTUM0ekp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlRlWE4wWlcwZ1JYWmxiblJ6SWlCMGJ5QnJaWGx6ZEhKdmEyVWdjbVYwZFhKdUp5d0tJQ0FnSUNBZ0lDQWdJQzh2SU95WGxPMkVzT3F3Z0NEc2k2VHNvSnpyb1p3ZzY1T2s3SmEwNnJDRUlPcXl2ZXlhc095WGtPdW5qQ0RzbDZ6cXVMQWc2NCtFNjR1c0tPcTJqTzJWbkNEc2w0YnNuTHpycWJRZzdKeUU3SmVRN0lTY0lPeWtrZXVMcUNrZzRvQ1VJTzJFc091dnVPdUVrT3lkaENEc3VaanNtNHdnNjdpTTY1Mjg3SnF3N0tDQTY2ZU1JT3VDcU9xNHRPdUxwQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlERXVOU2NzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklITmxkQ0J0YVc1cFlYUjFjbWw2WldRZ2IyWWdabkp2Ym5RZ2QybHVaRzkzSUhSdklIUnlkV1VuTEFvZ0lDQWdJQ0FnSUYwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPd29nSUNBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCbVlXeHpaVHNnTHk4ZzdLZUE3SnVRSU95VmlDRHRsWmpyaXBRZ1QxTUtJQ0FnSUNBZ2ZRb2dJQ0FnSUNCeVpYUjFjbTRnZEhKMVpUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzdZRzA2NkdjNjVPY0lPcXpoT3lnbFNEcm9aenF0N2pzbFlUc200TWc0b0NVSU8yVWpPdWZyT3EzdU95ZHVDRHRtWWpzblpnZ1crdWhuT3EzdU95VmhPeWJnMTBnNjdLRTdZcTg3SjIwSU8yWXVPeTJuQzRnWTJ4aGRXUmxJR0YxZEdnZ2JHOW5iM1YwN0p5ODY2R2NJRU5NU1NEcm9aenF0N2pzbmJqc25ZUWc3WlcwN0tDYzdaV2M2NHVrTGdvZ0lDOHZJQ2pzbmJRZ1VFUHNuWmdnN0tDQTdKNmw2NUNjSU95ZWtPcXlxZXltbmV1cWhleWRoQ0RzcDREc21yVHJpNlFnNG9DVUlPdUxwT3lMbkNEc2s3RHJvS1RycWJRZzdKNnM2NkdjNnJlNDdKMjRJTzJWaE95YWxDNHBJT3Vobk9xM3VPeVZoT3liZ3lEdG00VHNsNVFnN0lTNDdJV1l3cmZxczRUc29KWHN1cERzaTV6cnBid2c3S0NWNjZhczdaV2M2NHVrTGdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5amJHRjFaR1V0Ykc5bmIzVjBKeWtnZXdvZ0lDQWdZMjl1YzNRZ2JHOGdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjI5MWRDZGRMQ0I3SUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUVOTVFWVkVSVjlGVGxZc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbElIMHBPd29nSUNBZ2JHVjBJR1Z5Y2lBOUlDY25Pd29nSUNBZ2JHOHVjM1JrWlhKeUxtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc2daWEp5SUNzOUlHUXVkRzlUZEhKcGJtY29LVHNnZlNrN0NpQWdJQ0JzYnk1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V5QnFjMjl1S0hKbGN5d2dOVEF3TENCN0lHOXJPaUJtWVd4elpTd2daWEp5YjNJNklDZnJvWnpxdDdqc2xZVHNtNE1nN0l1azdaYUpJT3lMcE8yTXFEb2dKeUFySUdVdWJXVnpjMkZuWlNCOUtUc2dmU2s3Q2lBZ0lDQnNieTV2YmlnblkyeHZjMlVuTENBb1kyOWtaU2tnUFQ0Z2V3b2dJQ0FnSUNCcmFXeHNVSEp2WXlnbjY2R2M2cmU0N0pXRTdKdUQ3WlcwN0lTY0lPeWFsT3l5cmV5ZGhDRHNwSkhyaTZqdGxvanNsclRzbXBRdUp5azdJQzh2SU95ZG1PdVBoT3lnZ1NEc29vWHJvNHdnNG9DVUlPeWVrT3VQbVNEc25xenNpNXpyajRUcXNJQWc3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1yT3VwdENEc2xZZ2c2NUNvQ2lBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3SUNBZ0lDQWdJQ0F2THlEcmk2VHNuWXdnTDJGalkyOTFiblRDdHk5b1pXRnNkR2pzbDVEc2hKd2c2ck9FN0tDVjdKMkVJT3lEaU91aG5DZzk3SmVHN0oyTTdKeTg2NkdjS1NEc25iM3Fzb3dLSUNBZ0lDQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQzh2SU95RGdlMkRuQ0RzbnF6dGpKRHNvSlVvNjR1azdKMk1JTzJFdE95WGtPeUVuQ0Rycjdqcm9aenF0N2pzbmJnZzZyQ1E3S2VBS1FvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPdWhuT3EzdU95VmhPeWJneUFvWTI5a1pTQW5JQ3NnWTI5a1pTQXJJQ2NwSnlrN0NpQWdJQ0FnSUdsbUlDaHlaWE11YUdWaFpHVnljMU5sYm5RcElISmxkSFZ5YmpzZ0x5OGdaWEp5YjNJZzdaVzQ2NU9rNjUrczZyQ0FJT3lkdE91dnVDRHNuWkhyaTdYdGxvanNuTHpycWJRZzdLU1I2N08xSU91d3FleW5nQW9nSUNBZ0lDQnBaaUFvWTI5a1pTQTlQVDBnTUNrZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlNCOUtUc0tJQ0FnSUNBZ1pXeHpaU0JxYzI5dUtISmxjeXdnTlRBd0xDQjdJRzlyT2lCbVlXeHpaU3dnWlhKeWIzSTZJQ2hsY25JdWRISnBiU2dwTG5Oc2FXTmxLREFzSURFMU1Da3BJSHg4SUNnbjdLS0Y2Nk9NSU95OWxPdVRuQ0FuSUNzZ1kyOWtaU2tnZlNrN0NpQWdJQ0I5S1RzS0lDQWdJSEpsZEhWeWJqc0tJQ0I5Q2lBZ0x5OGc3SjZRNnJpd0lPeWloZXVqakNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SUZOVVQxQmZRbEpKUkVkRkwrMlZtTzJLdU91NWhPMkt1T3F3Z0NEdG1ManN0cHp0bFp6cmk2UWdLT3Vobk95N3JPeVhrT3lFbk91bmpDRHNvSkhxdDd3ZzZyQ0E2NHFsN1pXWTY0dUlJT3lWaU95Z2hDa0tJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjMmgxZEdSdmQyNG5LU0I3Q2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lpaGV1ampDRHNtcFRzc3EwZzY3Q2I3SjJNSU9LQWxDRHJpNlRycHF6cnBid2c2NEdWNjR1STY0dWtMaWNwT3dvZ0lDQWdjMmgxZEhScGJtZEViM2R1SUQwZ2RISjFaVHNLSUNBZ0lHdHBiR3hRY205aktDazdDaUFnSUNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhCeWIyTmxjM011WlhocGRDZ3dLU3dnTWpBd0tUc0tJQ0FnSUhKbGRIVnlianNLSUNCOUNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzSmxZMjl0YldWdVpDY3BJSHNLSUNBZ0lHTnZibk4wSUhzZ2RHVjRkQ3dnYlc5a1pXd3NJSEp2YkdVZ2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQnBaaUFvSVhSbGVIUWdmSHdnSVZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0NrcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuN0xhVTdMS2M2N0NiN0oyRUlPdXN1T3Exck9xd2dDRHJ1WVRzbHJRZzdKNkk3SXExNjR1STY0dWtMaWNnZlNrN0NpQWdJQ0JqYjI1emRDQnpkR0Z5ZEdWa0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzdHBUc3Nwd2c3SnFVN0xLdE9pY3NJRk4wY21sdVp5aDBaWGgwS1M1emJHbGpaU2d3TENBMU1Da3VjbVZ3YkdGalpTZ3ZYRzR2Wnl3Z0p5QW5LU0FySUNmaWdLWW5MQ0J5YjJ4bElEOGdKMXNuSUNzZ2NtOXNaU0FySUNkZEp5QTZJQ2NuTENCdGIyUmxiQ0EvSUNjbzY2cW82NDI0T2lBbklDc2diVzlrWld3Z0t5QW5LU2NnT2lBbkp5azdDaUFnSUNCMGNua2dld29nSUNBZ0lDQmpiMjV6ZENCeUlEMGdZWGRoYVhRZ1lYTnJRMnhoZFdSbEtGTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3NJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlZOMVoyZGxjM1JwYjI1ekxDQm1iM0p0WVhSRVpYTmpPaUFuVzNzaWRHVjRkQ0k2SUNMcnJManF0YXdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOUxDQXVMaTVkSnlCOUxDQnliMnhsS1RzS0lDQWdJQ0FnWTI5dWMzUWdjM1ZuWjJWemRHbHZibk1nUFNCeUxuQmhjbk5sWkNCOGZDQmJYVHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNrZ2V3b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lnbk95VmlDQW5JQ3NnYzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUNzZ0orcXduQ0FvSnlBcklITmxZeUFySUNkektTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURNd0tUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGTmxZeUE5SUhObFl6c0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYzNWbloyVnpkR2x2Ym5Nc0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjZ2ZTazdDaUFnSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaTZUdGpLZzZKeXdnWlM1dFpYTnpZV2RsS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdDaUFnSUNCOUNpQWdmUW9nSUM4dklPMlVoT3VnaU95ZWhPdXpoQ0RzdHBUc3Nwd2c0b0NVSU8yVm5DRHRtWlRycWJUc25ZUWc3WldZN0p5RUlPMlVoT3VnaU95ZWhDanNtSUhzbDYwcElPdUxxT3ljaE91aG5DRHJncGpyaUtBZzY3Q2I2ck9nTENEc21JSHNsNjNycDRqcmk2UWc2NVN3NjZHY0lPdU1nT3lWaU95ZGhDRHJncmpyaTZRdUNpQWdMeThnN0ppQjdKZXRJT3lJbU91bmpPMkJ2Q0RzbXBUc3NxM3NuWVFnN0txODZyQ2M3S2VBSU95Vml1dUtsQ0Rxc29Qc25iUWc3WlcxN0l1c0lDanJpcERyb0tUc3A0RHFzNkFnN0lLczdKcXA2NStKNjQrRUlPcTN1T3Vuak8yQnZDRHJncGpxc0lUcmk2UXBMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl5WldOdmJXMWxibVF0WjNKdmRYQnpKeWtnZXdvZ0lDQWdZMjl1YzNRZ2V5Qm5jbTkxY0hNc0lHMXZaR1ZzTENCdGIzSmxJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlFRnljbUY1TG1selFYSnlZWGtvWjNKdmRYQnpLUW9nSUNBZ0lDQS9JR2R5YjNWd2N3b2dJQ0FnSUNBZ0lDQWdMbTFoY0Nnb1p5a2dQVDRnS0hzS0lDQWdJQ0FnSUNBZ0lDQWdibUZ0WlRvZ1UzUnlhVzVuS0NobklDWW1JR2N1Ym1GdFpTa2dmSHdnSnljcExuUnlhVzBvS1N3S0lDQWdJQ0FnSUNBZ0lDQWdkR1Y0ZEhNNklDaG5JQ1ltSUVGeWNtRjVMbWx6UVhKeVlYa29aeTUwWlhoMGN5a2dQeUJuTG5SbGVIUnpJRG9nVzEwcExtMWhjQ2dvZENrZ1BUNGdVM1J5YVc1bktIUWdmSHdnSnljcExuUnlhVzBvS1NrdVptbHNkR1Z5S0VKdmIyeGxZVzRwTEFvZ0lDQWdJQ0FnSUNBZ0lDQnliMnhsT2lBb1p5QW1KaUJuTG5KdmJHVXBJRDhnVTNSeWFXNW5LR2N1Y205c1pTa2dPaUIxYm1SbFptbHVaV1FzQ2lBZ0lDQWdJQ0FnSUNCOUtTa0tJQ0FnSUNBZ0lDQWdJQzVtYVd4MFpYSW9LR2NwSUQwK0lHY3VkR1Y0ZEhNdWJHVnVaM1JvS1FvZ0lDQWdJQ0E2SUZ0ZE93b2dJQ0FnYVdZZ0tHeHBjM1F1YkdWdVozUm9JRHdnTWlrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZzbUlIc2w2M3NuYlFnNjdhQTdLR3g3WldwNjR1STY0dWtMaWNnZlNrN0NpQWdJQ0JqYjI1emRDQnpkR0Z5ZEdWa0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0bElUcm9JanNub1RyczRRZzdMYVU3TEtjSU95YWxPeXlyVG9nN0ppQjdKZXRJQ2NnS3lCc2FYTjBMbXhsYm1kMGFDQXJJQ2Zxc0p3bklDc2dLRzF2Y21VZ1B5QW5JQ2pyalpRZzY3Q2I2cml3S1NjZ09pQW5KeWtzSUcxdlpHVnNJRDhnSnlqcnFxanJqYmc2SUNjZ0t5QnRiMlJsYkNBcklDY3BKeUE2SUNjbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhJZ1BTQmhkMkZwZENCaGMydEhjbTkxY0hNb2JHbHpkQ3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFIzSnZkWEJ6TENCbWIzSnRZWFJFWlhOak9pQW5leUpuY205MWNITWlPaUJiZXlKdVlXMWxJam9nSXV5WWdleVhyU0RzbmJUcnBvUWlMQ0FpYzNWbloyVnpkR2x2Ym5NaU9pQmJleUowWlhoMElqb2dJdXVNZ095VmlDSXNJQ0p5WldGemIyNGlPaUFpN0oyMDdKeWdJbjFkZlYxOUp5QjlMQ0FoSVcxdmNtVXBPd29nSUNBZ0lDQmpiMjV6ZENCdmRYUWdQU0J5TG5CaGNuTmxaRHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVc5MWRDa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yVWhPdWdpT3llaE91emhDRHNvSnpzbFlnZ0p5QXJJRzkxZEM1eVpXUjFZMlVvS0c0c0lHY3BJRDArSUc0Z0t5Qm5Mbk4xWjJkbGMzUnBiMjV6TG14bGJtZDBhQ3dnTUNrZ0t5QW42ckNjSUM4ZzdKaUI3SmV0SUNjZ0t5QnZkWFF1YkdWdVozUm9JQ3NnSitxd25DQW9KeUFySUhObFl5QXJJQ2R6S1NjcE93b2dJQ0FnSUNCemRHRjBjeTV6WlhKMlpXUXJLenNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRUYwSUQwZ2JtVjNJRVJoZEdVb0tTNTBiMHh2WTJGc1pWUnBiV1ZUZEhKcGJtY29KMnR2TFV0U0p5azdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ0oxdnRsSVRyb0lqc25vVHJzNFJkSUNjZ0t5QlRkSEpwYm1jb0tHeHBjM1JiTUYwZ0ppWWdiR2x6ZEZzd1hTNTBaWGgwYzFzd1hTa2dmSHdnSnljcExuTnNhV05sS0RBc0lESTBLVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRk5sWXlBOUlITmxZenNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ1ozSnZkWEJ6T2lCdmRYUXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY2dmU2s3Q2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJVHJvSWpzbm9UcnM0UWc3TGFVN0xLY0lPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU8yWXVPeTJuQ0RzaTZUdGpLZzZJQ2NwS1RzS0lDQWdJSDBLSUNCOUNpQWdMeThnN1l5ZDdKZUZJT3lhbE95R2pPdXpoQ0RzdHBUc3Nwd2c0b0NVSU8yVm5DRHRqSjNzbDRYc25aZ2c2cldzN0lTeDdKcVU3SWFNS095WHJlMlZvQ3ZyckxqcXRhd3A2Nlc4SU8yVm5DRHJzb2pzbDVBZzY3Q2I3SldFSU95WHJlMlZvT3V6aE91aG5DRHJpNlRyazZ6cmlwVHJpNlF1Q2lBZ0x5OGc3SnFVN0lhTTY2VzhJTzJWcU9xN21DRHJzN1RyZ3JUc2xid2c3WU9BN0oyMDdZdUE3SjIwSU91enVPdXN1Q0RycDZYcm5iM3NuWVFnN0xDNDdLR3c3WldnSU95SW1DRHNub2pyaTZRbzdKcVU3SWFNNjdPRUlPcXduT3V6aENEc21wVHNzcTNxczd6c25aZ2c3TENvN0oyMEtTNEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjbVZqYjIxdFpXNWtMWEJ2Y0hWd0p5a2dld29nSUNBZ1kyOXVjM1FnZXlCbGJHVnRaVzUwY3l3Z2JXOWtaV3dzSUcxdmNtVWdmU0E5SUdGM1lXbDBJSEpsWVdSQ2IyUjVLSEpsY1NrN0NpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ1FYSnlZWGt1YVhOQmNuSmhlU2hsYkdWdFpXNTBjeWtnUHlCbGJHVnRaVzUwY3k1bWFXeDBaWElvS0dVcElEMCtJR1VnSmlZZ1UzUnlhVzVuS0dVdWRHVjRkQ0I4ZkNBbkp5a3VkSEpwYlNncEtTQTZJRnRkT3dvZ0lDQWdhV1lnS0d4cGMzUXViR1Z1WjNSb0lEd2dNaWtnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnRqSjNzbDRVZzdKcVU3SWFNNnJDQUlPdTJnT3loc2UyVnFldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZeWQ3SmVGSU95MmxPeXluQ0RzbXBUc3NxMDZJT3lhbE95R2pDQW5JQ3NnYkdsemRDNXNaVzVuZEdnZ0t5QW42ckNjSnlBcklDaHRiM0psSUQ4Z0p5QW82NDJVSU91d20rcTRzQ2tuSURvZ0p5Y3BMQ0J0YjJSbGJDQS9JQ2NvNjZxbzY0MjRPaUFuSUNzZ2JXOWtaV3dnS3lBbktTY2dPaUFuSnlrN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclVHOXdkWEFvYkdsemRDd2diVzlrWld3c0lIc2djR0Z5YzJVNklIQmhjbk5sVUc5d2RYQXNJR1p2Y20xaGRFUmxjMk02SUNkN0luTmxkSE1pT2lCYmV5SnlaV0Z6YjI0aU9pQWk2N0NwN1phbElPMlZuQ0Ryckxqc25xVWlMQ0FpWld4bGJXVnVkSE1pT2lCYmV5SnliMnhsSWpvZ0l1eVhyZTJWb0NJc0lDSjBaWGgwSWpvZ0l1dXN1T3ExckNKOUxDQXVMaTVkZlN3Z0xpNHVYWDBuSUgwc0lDRWhiVzl5WlNrN0NpQWdJQ0FnSUdOdmJuTjBJSE5sZEhNZ1BTQnlMbkJoY25ObFpEc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93b2dJQ0FnSUNCcFppQW9JWE5sZEhNcElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0akozc2w0VWc3SVM0N1lxNElDY2dLeUJ6WlhSekxteGxibWQwYUNBcklDZnFzSndnS0NjZ0t5QnpaV01nS3lBbmN5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVkdWNGRDQTlJQ2RiN1l5ZDdKZUZYU0FuSUNzZ1UzUnlhVzVuS0Noc2FYTjBXekJkSUNZbUlHeHBjM1JiTUYwdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJREkwS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djMlYwY3l3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnlCOUtUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNbmV5WGhTRHNpNlR0aktnNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEdG1ManN0cHdnN0l1azdZeW9PaUFuS1NrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SU91TWdPMlpsTzJZbFNEcnJManF0YXdnN0tDYzdKNlJJT0tBbENEc2c0SHRtYW5zbllRZzdJU2s2NnFGN1pXWTY2bTBJT3VzdU9xMXJPdWx2Q0RycDR6cms2VHNsclRzcElEcmk2UWdLT3kybE95eW5PcXp2Q0Rxc0puc25ZQWc3SVM0N0lXWUxDRHJqSUR0bVpUcmlwUWc2NmVrSU95YWxPeXlyZXlYa0NEdGhyWHNwN2pyb1p3ZzdJdWs2NmE4S1FvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5amIyMXdiM05sSnlrZ2V3b2dJQ0FnWTI5dWMzUWdleUJ0WlhOellXZGxjeXdnYlc5a1pXd2dmU0E5SUdGM1lXbDBJSEpsWVdSQ2IyUjVLSEpsY1NrN0NpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ1FYSnlZWGt1YVhOQmNuSmhlU2h0WlhOellXZGxjeWtnUHlCdFpYTnpZV2RsY3k1bWFXeDBaWElvS0cwcElEMCtJRzBnSmlZZ1UzUnlhVzVuS0cwdWRHVjRkQ0I4ZkNBbkp5a3VkSEpwYlNncEtTQTZJRnRkT3dvZ0lDQWdhV1lnS0NGc2FYTjBMbXhsYm1kMGFDa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmcmpJRHRtWlFnNjRLMDdKcXA3SjIwSU91NWhPeVd0Q0Rzbm9qc2lyWHJpNGpyaTZRdUp5QjlLVHNLSUNBZ0lHTnZibk4wSUhOMFlYSjBaV1FnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnWTI5dWMzUWdiR0Z6ZEZWelpYSWdQU0JiTGk0dWJHbHpkRjB1Y21WMlpYSnpaU2dwTG1acGJtUW9LRzBwSUQwK0lHMHVjbTlzWlNBaFBUMGdKMkZ6YzJsemRHRnVkQ2NwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeWVrU0RyaklEdG1aUWc3SnFVN0xLdE9pY3NJRk4wY21sdVp5Z29iR0Z6ZEZWelpYSWdKaVlnYkdGemRGVnpaWEl1ZEdWNGRDa2dmSHdnSnljcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaUFvNjR5QTdabVVJQ2NnS3lCc2FYTjBMbXhsYm1kMGFDQXJJQ2Zxc0p3cEp5azdDaUFnSUNCMGNua2dld29nSUNBZ0lDQXZMeURyaklEdG1aVHFzSUFnNnJpNDdKYTA3S2VBNjZtMElPeTFuT3EzdkNBeE11cXduT3VuakNBbzdaU0U2NkdzN1pTRTdZcTRJTzJQcmV5anZDRHJzS25zcDRBcENpQWdJQ0FnSUdOdmJuTjBJSElnUFNCaGQyRnBkQ0JoYzJ0RGIyMXdiM05sS0d4cGMzUXVjMnhwWTJVb0xURXlLU3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFEyOXRjRzl6WlN3Z1ptOXliV0YwUkdWell6b2dKM3NpY21Wd2JIa2lPaUFpNjR5QTdabVVJT3lka2V1THRTRHRsWnpya1pBZzY2eTQ3SjZsSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcnJManF0YXdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOUxDQXVMaTVkZlNjZ2ZTazdDaUFnSUNBZ0lHTnZibk4wSUc5MWRDQTlJSEl1Y0dGeWMyVmtPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJT3lka2V1THRTQW9KeUFySUhObFl5QXJJQ2R6TENEc29KenNsWWdnSnlBcklHOTFkQzV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dnS3lBbjZyQ2NLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnVTNSeWFXNW5LQ2hzWVhOMFZYTmxjaUFtSmlCc1lYTjBWWE5sY2k1MFpYaDBLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNekFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnlaWEJzZVRvZ2IzVjBMbkpsY0d4NUxDQnpkV2RuWlhOMGFXOXVjem9nYjNWMExuTjFaMmRsYzNScGIyNXpMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc2N0tJN0pldElPS0FsQ0R0bFp6cXRhM3NsclFnNG9hVUlPeVlnZXlXdENEc25wRHJqNWtnS095MmxPeXluT3F6dkNEcXNKbnNuWUFnN0lTNDdJV1lJT3lDck95YXFTa0tJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZkSEpoYm5Oc1lYUmxKeWtnZXdvZ0lDQWdZMjl1YzNRZ2V5QjBaWGgwTENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdsbUlDZ2hkR1Y0ZENCOGZDQWhVM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnJzb2pzbDYzdGxhQWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTI5dWMzUWdjaUE5SUdGM1lXbDBJR0Z6YTFSeVlXNXpiR0YwWlNoVGRISnBibWNvZEdWNGRDa3VkSEpwYlNncExDQnRiMlJsYkN3Z2V5QndZWEp6WlRvZ2NHRnljMlZVY21GdWMyeGhkR1VzSUdadmNtMWhkRVJsYzJNNklDZDdJblJ5WVc1emJHRjBaV1FpT2lBaTY3S0k3SmV0NjZ5NElDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSXNJQ0prYVhKbFkzUnBiMjRpT2lBaWEyL2locEpsYmlEcm1KRHJpcFFnWlc3aWhwSnJieUo5SnlCOUtUc0tJQ0FnSUNBZ1kyOXVjM1FnYjNWMElEMGdjaTV3WVhKelpXUTdDaUFnSUNBZ0lHTnZibk4wSUhObFl5QTlJQ2dvUkdGMFpTNXViM2NvS1NBdElITjBZWEowWldRcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtUc0tJQ0FnSUNBZ2FXWWdLQ0Z2ZFhRcElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEcnNvanNsNjBnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N0tJN0pldElPeVpoT3VqakNBb0p5QXJJSE5sWXlBcklDZHpMQ0FuSUNzZ0tHOTFkQzVrYVhKbFkzUnBiMjRnZkh3Z0p6OG5LU0FySUNjcEp5azdDaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQlRkSEpwYm1jb2RHVjRkQ2t1YzJ4cFkyVW9NQ3dnTXpBcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUIwY21GdWMyeGhkR1ZrT2lCdmRYUXVkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1T2lCdmRYUXVaR2x5WldOMGFXOXVMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJT3V5aU95WHJTRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EUXNJSHNnWlhKeWIzSTZJQ2RPYjNRZ1ptOTFibVFuSUgwcE93cDlLVHNLQ2k4dklPeWR0T3V2dUNEcmk2VHJwcXpxc0lBZzY1YWdJT3llaU91S2xPdU5zQ0RybUpBZzdMeWM2cml3NnJDQUlPdVRwT3lXdE95WXBPdXB0Q2pzb0p6c2lxVHNzcGdnN0o2UTY0K1pJT3k4bk9xNHNDRHNwSkhyczdVZzY1T3hLU0Rzb2JEc21xbnRub2dnN0tLRjY2T01JT0tBbENEcmo0enJqWmdnNjR1azY2YXM2NHFVSU9xM3VPdU1nT3VobkNEc25LRHNwNEFLYzJWeWRtVnlMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUI3Q2lBZ2FXWWdLR1VnSmlZZ1pTNWpiMlJsSUQwOVBTQW5SVUZFUkZKSlRsVlRSU2NwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc25iVHJyN2dnN0x5YzdLQzRJT3llaU95V3RPeWFsQ2p0ajZ6dGlyZ2dKeUFySUZCUFVsUWdLeUFuSU95Q3JPeWFxU0RzcEpFcElPS0FsQ0RzbmJRZzdKMjQ3SXFrN1lTMDdJcWs2NHFVSU95aWhldWpqTzJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJSEJ5YjJObGMzTXVaWGhwZENnd0tUc0tJQ0I5Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFbk91eWhDRHNtS1RycFpnNkp5d2daU0FtSmlCbExtMWxjM05oWjJVcE93b2dJSEJ5YjJObGMzTXVaWGhwZENneEtUc0tmU2s3Q2k4dklPeVd0T3VXcENEcXNyM3JvWnpyb1p3ZzdLTzk2NU9nS095THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBc0lFTjBjbXdyUXl3Z0wzTm9kWFJrYjNkdUxDRHNtS1RycFpncElHTnNZWFZrWlNEc25wRHNpNTNzbllRZzY0S282cml3N0tlQUlPeVZpdXVLbE91THBBcHdjbTlqWlhOekxtOXVLQ2RsZUdsMEp5d2dLQ2tnUFQ0Z2V5QnJhV3hzVUhKdll5Z3BPeUJyYVd4c1RHOW5hVzVRY205aktDazdJSDBwT3dwd2NtOWpaWE56TG05dUtDZFRTVWRKVGxRbkxDQW9LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2twT3dwd2NtOWpaWE56TG05dUtDZFRTVWRVUlZKTkp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwS1RzS0NuTmxjblpsY2k1c2FYTjBaVzRvVUU5U1ZDd2dKekV5Tnk0d0xqQXVNU2NzSUNncElEMCtJSHNLSUNCamIyNXpiMnhsTG14dlp5Z240cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBSnlrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSnlEdGdiVHJvWnpyazV3ZzY0dWs2NmFzSU95OG5PeW5rQ0RpZ0pRZ2FIUjBjRG92TDJ4dlkyRnNhRzl6ZERvbklDc2dVRTlTVkNrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSnlEcnFxanJqYmc2SUNjZ0t5QkRURUZWUkVWZlRVOUVSVXdnS3lBbklNSzNJT3lZaU95TG5DQW5JQ3NnUlZoQlRWQk1SVk11YkdWdVozUm9JQ3NnSitxeHRDRHNucVhzc0trbktUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPeWR0Q0Rzc0wzc25ZUWc3THljNjVHVUlPdVBtZXlWaUNEdGxMenF0N2pycDRnZzdaU002NStzNnJlNDdKMjQ3SjIwSU8yQnRPdWhuT3VUbk91aG5DRHN0cFRzc3B6dGxhbnJpNGpyaTZRdUp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0orS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTm9aV05yUTJ4aGRXUmxRWFpoYVd4aFlteGxLQ2s3SUM4dklFTnNZWFZrWlNCRGIyUmxJT3lDck95YXFTRHFzSURyaXFVZzdKZXM2N2FBSU95Z2tPcXlnQ0FvN1pTTTY1K3M2cmU0N0oyNElPeVZpT3VDdE95YXFTa0tJQ0F2THlEcnI3anJwcXdnN0l1YzY0K1pJQ3NnN0tlQTdJdWM2Nnk0SU95anZPeWVoU0RpZ0pRZzdMS3JJT3kybE95eW5PdTJnTzJFc0NEcnVhRHJwYlRxc293S0lDQmhjMnREYkdGMVpHVW9KK3liak91d2pleVhoVG9nSXV5Z2dPeWVwU0Rya0pqc2w0anNpclhyaTRqcmk2UWlKeWt1ZEdobGJpZ0tJQ0FnSUNncElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc200enJzSTNzbDRVZzdKbUU2Nk9NSU9LQWxDRHN0cFRzc3B3ZzdLU0E2N21FSU91Qm5TNG5LU3dLSUNBZ0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SnVNNjdDTjdKZUZJT3lMcE8yTXFDQW83TEtySU95YWxPeXlyU0RybFl3ZzdKNnM3SXVjNjQrRUtUb25MQ0JsTG0xbGMzTmhaMlVwQ2lBZ0tUc0tmU2s3Q2k4dklFbFFkallnNjZPbzdaU0U2N0N4S0RvNk1TbnNsNURyajRRZzdaV282cnVZSU91VG8rdUtsT3VMcENEaWdKUWdiV0ZqVDFNZzY1T3g3SmVRN0lTY0lDZHNiMk5oYkdodmMzUW42ckNBSURvNk1ldWhuQ0RycUx6c29JQWc3WlcwN0lTZDY1Q1k2NHFVNjQyd0NpOHZJTzJVdk9xM3VPdW5pQ2hGYkdWamRISnZiaWtnWm1WMFkyanJpcFFnWTNWeWJPcXp2Q0RyaTZ6cnBxd2dTVkIyTk91aG5DRHNucERyajVrZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDd2dTVkIyTk91bmpDRHJrNlByalpnZzY0dWs2NmFzN0plUUlPeVhzT3F5c095ZHRDRHFzYkRydG9Ecmo3d0tMeThnN0xhVTdMS2N3cmZ0bDZ6c2lxVHNzclR0Z2F6cXNJQWc3S0d3N0pxcDdaNklJT3lMcE8yTXFPMldpT3VMcENqc2k2VHN1S0VnTWpBeU5pMHdOeWt1SU9xd21leWRnQ0RzbXBUc3NxMGc3Wlc0NjVPazY1K3M2Nlc4SUVsUWRqWWc2Nk9vN1pTRTY3Q3g3SmVRNjQrRUlPeVd1ZXVLbE91THBDNEtZMjl1YzNRZ2MyVnlkbVZ5TmlBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtITmxjblpsY2k1c2FYTjBaVzVsY25Nb0ozSmxjWFZsYzNRbktWc3dYU2s3Q25ObGNuWmxjall1YjI0b0oyVnljbTl5Snl3Z0tHVXBJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkpVSFkyS0RvNk1Ta2c2NmFzN0lxb0lPeURuZXVldFNEaWdKUWdTVkIyTk91bmpDRHNncXpzbXFrNkp5d2daU0FtSmlCbExtMWxjM05oWjJVcEtUc0tjMlZ5ZG1WeU5pNXNhWE4wWlc0b1VFOVNWQ3dnSnpvNk1TY3BPd289JwpCNjRfV0FUQ0hFUj0nTHk4ZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzRvQ1VJTzJWcmV5RGdTRHJscUFnN0o2STY0cVVJT3kwaU95R2pPMllsU0RzaEp6cnNvUWdLR3h2WTJGc2FHOXpkRG94TVRnNE9Ta05DaTh2SU9LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBMEtMeThnN0ptY0lPMlZoT3lhbE8yVm5PcXdnRG9nN1pTODZyZTQ2NmVJNnJDQUlPMlVqT3Vmck9xM3VPeWR1T3lkbUNCamJHRjFaR1ZpY21sa1oyVTZMeThnN0plMDZyaXdLSGRwYm1SdmR5NXZjR1Z1TDJsbWNtRnRaUzl2Y0dWdVJYaDBaWEp1WVd3cDY2VzhEUW92THlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293TkNpOHZJRkJQVTFRZ0wzZGhhMlVnNjZXOElPdXp0T3VDdE91cHRDRHFzSkRzaTV6c25wRHFzSUFnNjR1azY2YXNLR05zWVhWa1pTMWljbWxrWjJVdWFuTXA2Nlc4SU91TWdPeUxvQ0RzdktEcmk2UXVEUW92THcwS0x5OGc2NHVrNjZhczdKbUE3SjJZSU95d3FPeWR0RG9nNnJDUTdJdWM3SjZRNjRxVUlHTnNZWFZrWmV1bHZDRHJyTHpzcDRBZzdKV0s2NHFVNjR1a0tPeWVrT3lMblNEc2w0YnNuWXdwSU9LR2tpRHRnYlRyb1p6cms1d2c3Sld4SU95WGhldU5zT3lkdE8yS3VPdWx2Q0RzbFlnZzY2ZUo2ck9nTEEwS0x5OGc2Nm1VNjZxbzY2YXNJSDR4TlUxQzY1MjhJT3Vobk9xM3VPeWR1Q0RzaTV3ZzdKNlE2NCtaSU95TG5PeWVrZXljdk91aG5DRHNnNEhzaTV3ZzdMeWM2NUdzNjQrRUlPdTJnT3VMdENEc2w0YnJpNlFnS091VHNldWhuVG9nYm5CdElISjFiaUJpZFdsc1pDa3VEUW92THlEcmk2VHJwcXpyaXBRZzdJdXM3SjZsNjdDVjY0K1pJT3VCaXVxNHNPdXB0Q0Rzbzczc3A0RHJwNHdvN1pTTTY1K3M2cmU0N0oyNDZyTzhJT3lEbmV5Q3JDRHJqNW5xdUxEdG1aUXBMQ0Rxc0pEc2k1enNucERyaXBRZzZyT0U3SWFOSU91Q3FPeVZoQ0RyaTZUc25Zd2c2cm1vN0pxdzZyaXc2Nlc4SU91d20rdUtsT3VMcEM0TkNnMEtZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNOQ21OdmJuTjBJSEJoZEdnZ1BTQnlaWEYxYVhKbEtDZHdZWFJvSnlrN0RRcGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0RRcGpiMjV6ZENCdmN5QTlJSEpsY1hWcGNtVW9KMjl6SnlrN0RRcGpiMjV6ZENCN0lITndZWGR1TENCemNHRjNibE41Ym1NZ2ZTQTlJSEpsY1hWcGNtVW9KMk5vYVd4a1gzQnliMk5sYzNNbktUc05DZzBLWTI5dWMzUWdVRTlTVkNBOUlERXhPRGc1T3cwS1kyOXVjM1FnVWs5UFZDQTlJSEJoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNjdUxpY3BPeUF2THlEc29JRHNucVhzaG93ZzY2T283WXE0SU9LQWxDRHJpNlRycHF6cXNJQWdjbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrNjZXOElPeXd2dXVLbENEcXVMRHNwSUFOQ2cwS1kyOXVjM1FnUTA5U1UxOUlSVUZFUlZKVElEMGdldzBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUM0pwWjJsdUp6b2dKeW9uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFNHVmhaR1Z5Y3ljNklDZERiMjUwWlc1MExWUjVjR1VuTEEwS2ZUc05DbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3MEtJQ0J5WlhNdWQzSnBkR1ZJWldGa0tITjBZWFIxY3l3Z1QySnFaV04wTG1GemMybG5iaWg3SUNkRGIyNTBaVzUwTFZSNWNHVW5PaUFuWVhCd2JHbGpZWFJwYjI0dmFuTnZianNnWTJoaGNuTmxkRDExZEdZdE9DY2dmU3dnUTA5U1UxOUlSVUZFUlZKVEtTazdEUW9nSUhKbGN5NWxibVFvU2xOUFRpNXpkSEpwYm1kcFpua29iMkpxS1NrN0RRcDlEUW9OQ2k4dklHTnNZWFZrWlNCRFRFbnFzSUFnN0o2STY0cVU3S2VBSU9LQWxDRHNsNGJzbkx6cnFiUWdMM2RoYTJVZzdKMlI2NHUxN0plUUlPeUxwT3lXdENEdGxJenJuNnpxdDdqc25ianNuYlFnN0pXSTY0SzA3WldnSU95SW1DRHNub2pxc293ZzdaV2M2NHVrRFFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzROQ2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENBek1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLTHk4ZzdMcVE3SXVjSURYc3RJZ2c0b0NVSU91aG5PcTN1T3lkdUNEc3A0SHRtNFFnN0lPSUlPcXpoT3lnbGV5ZHRDRHFzNmZyc0pUcm9ad2c3SjZoN1ppQTdKVzhJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKZVE3SVNjSU8yWmlPeWN2T3VobkNEcmhKanNsclRxc0lUcmk2UW9NekRzdElqcnFiUWc2NFNJNjZ5MElPdUtwdXlkakNrTkNteGxkQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lBd0xDQmxiV0ZwYkRvZ2JuVnNiQ0I5T3cwS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzTkNpQWdhV1lnS0VSaGRHVXVibTkzS0NrZ0xTQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BDQTFNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3cwS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJR29nUFNCS1UwOU9MbkJoY25ObEtHWnpMbkpsWVdSR2FXeGxVM2x1WXlod1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuTG1Oc1lYVmtaUzVxYzI5dUp5a3NJQ2QxZEdZNEp5a3BPdzBLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJvWnpxdDdqc25iZ2c3SjIwNjZDbElPeVhodXlkakNEcms3RWc0b0NVSUc1MWJHd2dLaThnZlEwS0lDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUJFWVhSbExtNXZkeWdwTENCbGJXRnBiQ0I5T3cwS0lDQnlaWFIxY200Z1pXMWhhV3c3RFFwOURRb05DbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzTkNpQWdZMjl1YzNRZ1ptbHVaR1Z5SUQwZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5QS9JQ2QzYUdWeVpTY2dPaUFuZDJocFkyZ25PdzBLSUNCMGNua2dleUJ5WlhSMWNtNGdjM0JoZDI1VGVXNWpLR1pwYm1SbGNpd2dXeWRqYkdGMVpHVW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhOb1pXeHNPaUIwY25WbElIMHBMbk4wWVhSMWN5QTlQVDBnTURzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnY21WMGRYSnVJR1poYkhObE95QjlEUXA5RFFvTkNteGxkQ0IzWVd0cGJtY2dQU0JtWVd4elpUc2dMeThnN0pldzdZT0FJT3V3cWV5bmdDRGlnSlFnNjR1azY2YXM2NHFVSU95V3RPeXdxTzJVdkNCRlFVUkVVa2xPVlZORjY2R2NJT3lra2V1enRTRHNvSlhycHF6dGxaanNwNERycDR3ZzdaU0U2NkdjN0lTNDdJcWtJT3VDcmV1NWhPdWx2Q0RzcElUc25ianJpNlFOQ21aMWJtTjBhVzl1SUhkaGEyVkNjbWxrWjJVb0tTQjdEUW9nSUdsbUlDaDNZV3RwYm1jcElISmxkSFZ5YmpzTkNpQWdkMkZyYVc1bklEMGdkSEoxWlRzTkNpQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJSGRoYTJsdVp5QTlJR1poYkhObE95QjlMQ0ExTURBd0tUc05DaUFnYkdWMElIQnliMk03RFFvZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2dJQ0FnTHk4Z1YybHVaRzkzY3pvZ1kyMWt3cmQyWW5NZzZySzk3SnlnSU95WGh1eWR0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTd2dkMmx1Wkc5M2MwaHBaR1VvUTFKRlFWUkZYMDVQWDFkSlRrUlBWeW5yb1p3ZzdJcWs3WSt3SU9LQWxBMEtJQ0FnSUM4dklPeXd2U0RzbDRicmlwUWc3SWlvN0oyQUlPeTltT3lHbE95ZHRDRHJwNHpyazZUc2xyVHNwNERxczZBZzY0dWs2NmFzN0oyWUlPeWVrT3lMblNoamJHRjFaR1VwNjQrRUlPcTN1Q0Rzdlpqc2hwVHNuWVFnNjZ5ODY2Q2s2N0NiN0pXRUlPeVd0T3VXcENEc3NMM3JqNFFnN0pXSUlPdWNyT3VMcEM0TkNpQWdJQ0F2THlCa1pYUmhZMmhsWk91S2xDRHNrN0RzcDRBZzdKV0s2NHFVNjR1a0tHUmxkR0ZqYUdWa0szZHBibVJ2ZDNOSWFXUmxJT3loc08yVnFleWRnQ0Rzdlpqc2hwUWc3TEM5N0oyMElPdUZ1T3kybk91UXFDRGlnSlFnN0l1azdMaWhLUzROQ2lBZ0lDQXZMeUJYYVc1a2IzZHo3SmVRN0lTZ0lHUmxkR0ZqYUdWa0lPeVhodXlkdE91UGhDRHJ0b0RycXFnbzZyQ1E3SXVjN0o2UUtlcXdnQ0Rzbzczc2xyVHJqNFFnN0o2UTdJdWQ3SjJBSU95Q3RPeVZoT3VDcU91S2xPdUxwQzROQ2lBZ0lDQndjbTlqSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3RFFvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzRFFvZ0lDQWdmU2s3RFFvZ0lIMGdaV3h6WlNCN0RRb2dJQ0FnTHk4Z2JXRmpUMU12NjZhczY0aUY3SXFrT2lEcXNKRHNpNXpzbnBEcnBid2c2NTJFN0pxMElHNXZaR1VnN0l1azdaYUpJTzJNak95ZHZPdWhuQ0RzcDRIc29KRWc3SXFrN1krd0lDaHNZWFZ1WTJoa0lPMlptT3F5dmV5WGxDQlFRVlJJNnJDQUlPdTVpT3lWdmUyVm9DRHNpSmdnN0o2STdKYTBJT3lnaU91TWdPcXl2ZXVobkNEc2dxenNtcWtwRFFvZ0lDQWdjSEp2WXlBOUlITndZWGR1S0hCeWIyTmxjM011WlhobFkxQmhkR2dzSUZ0d1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5ZMnhoZFdSbExXSnlhV1JuWlM1cWN5Y3BYU3dnZXcwS0lDQWdJQ0FnWTNka09pQlNUMDlVTENCa1pYUmhZMmhsWkRvZ2RISjFaU3dnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQTBLSUNBZ0lIMHBPdzBLSUNCOURRb2dJSEJ5YjJNdWRXNXlaV1lvS1RzZ0x5OGc2ckNRN0l1YzdKNlFJT3lkdE91eXBPMkt1Q0RybzZqdGxJVHNsNURzaEp3ZzY3YUU2NmFzSUNqcXNKRHNpNXpzbnBBZzdLS0Y2Nk9NNjZXOElPdW5pZXluZ0NEc2xZcnFzb3dwRFFwOURRb05DaTh2SU95ZHRDQlFRK3VsdkNBbjdJU2s3TG1ZSU95Z2hDanNnNGdnVUVNcEp5RHNnNEh0ZzV6cm9ad2c2NUNZNjQrTTY2YXc2NHVrSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnVyt5MGlPcTRzTzJabEYwZzY3S0U3WXE4S0ZCUFUxUWdMM1Z1YVc1emRHRnNiQ25zbmJRZzY3YUE2Nlc0NjR1a0xnMEtMeThnY21WbmFYTjBaWEl0Y0hKdmRHOWpiMnd1YW5QcXNJQWc3SVNrN0xtWTdaV2NJT3F5Zyt5ZGhDRHF0N2pyaklEcm9ad2c2NUNZNjQrTTY2YXc2NHVrT2lEcXNKRHNpNXpzbnBBZzdKNlE2NCtaN0l1YzdKNlJJQ3NnS095ZWlPeWN2T3VwdENrZzdJU2s3TG1ZSU8yUHRPdU5sQzROQ2k4dklPS2FvTys0anlEcnNKanJrNXpzaTV3Z1NGUlVVQ0RzblpIcmk3WHNuWVFnNjZpODdLQ0FJT3V6dE91Q3VDRHJrcVFnN1ppNDdMYWM3WldnSU9xeWd5RGlnSlFnYldGalQxTWdiR0YxYm1Ob1kzUnNJR0p2YjNSdmRYVHNuYlFnN0oyMElPMlVoT3Vobk95RXVPeUtwT3VsdkNEc3BvbnNpNXdnN0tLRjY2T003SXVjN1lLc0lPeUltQ0Rzbm9qcmk2UXVEUW92THlBZ0lDRHF0N2pybnBqc2hKd2c3WXlNN0oyOEtIQnNhWE4wd3Jmc2hLVHN1WmdnN1krMDY0MlVLZXlkaENCc1lYVnVZMmhqZEd6cnM3VHJpNlFnNjZpODdLQ0FJT3luZ095YXRPdUxwQ0RpZ0pRZ1ltOXZkRzkxZE95ZHRDRHNtckRycHF6cnBid2c3S085N0plczY0K0VJT3lla091UG1leUxuT3lla2V5ZGdDRHNuYlRycjdnZzdJS3M2NTI4N0tlRTY0dWtMZzBLWm5WdVkzUnBiMjRnZFc1cGJuTjBZV3hzVTJWc1ppZ3BJSHNOQ2lBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUZ0ZE93MEtJQ0IwY25rZ2V3MEtJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXcwS0lDQWdJQ0FnWTI5dWMzUWdURUZDUlV3Z1BTQW5ZMjl0TG1Oc1lYVmtaV0p5YVdSblpTNTNZWFJqYUdWeUp6c05DaUFnSUNBZ0lHTnZibk4wSUhCc2FYTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua25MQ0FuVEdGMWJtTm9RV2RsYm5Sekp5d2dURUZDUlV3Z0t5QW5MbkJzYVhOMEp5azdEUW9nSUNBZ0lDQmpiMjV6ZENCcGJuTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua25MQ0FuUVhCd2JHbGpZWFJwYjI0Z1UzVndjRzl5ZENjc0lDZERiR0YxWkdWQ2NtbGtaMlVuS1RzTkNpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLSEJzYVhOMEtTa2dleUJtY3k1MWJteHBibXRUZVc1aktIQnNhWE4wS1RzZ2NtVnRiM1psWkM1d2RYTm9LSEJzYVhOMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQWdJSFJ5ZVNCN0lITndZWGR1VTNsdVl5Z25iR0YxYm1Ob1kzUnNKeXdnV3lkaWIyOTBiM1YwSnl3Z0oyZDFhUzhuSUNzZ2NISnZZMlZ6Y3k1blpYUjFhV1FvS1NBcklDY3ZKeUFySUV4QlFrVk1YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2RzWVhWdVkyaGpkR3duTENCYkozSmxiVzkyWlNjc0lFeEJRa1ZNWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dldzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1RXbGpjbTl6YjJaMFhGeFhhVzVrYjNkelhGeERkWEp5Wlc1MFZtVnljMmx2Ymx4Y1VuVnVKeXdnSnk5Mkp5d2dKME5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWEluTENBbkwyWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lISmxiVzkyWldRdWNIVnphQ2duN0o2UTY0K1o3SXVjN0o2UktFTnNZWFZrWlVKeWFXUm5aVmRoZEdOb1pYSXBKeWs3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KMk5zWVhWa1pXSnlhV1JuWlRvdkx5RHJrN0hyb1owbktUc2dmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnSUNCMGNua2dldzBLSUNBZ0lDQWdJQ0JqYjI1emRDQnBibk4wSUQwZ2NHRjBhQzVxYjJsdUtIQnliMk5sYzNNdVpXNTJMa3hQUTBGTVFWQlFSRUZVUVNCOGZDQndZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBblFYQndSR0YwWVNjc0lDZE1iMk5oYkNjcExDQW5RMnhoZFdSbFFuSnBaR2RsSnlrN0RRb2dJQ0FnSUNBZ0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWdmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZRMEtJQ0FnSUNBZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdmUTBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lCbVlXbHNMWE52Wm5RZzRvQ1VJT3VxdXlEc3A0RHNtclFnNnJLTUlPeWVpT3lXdE91UGhDRHRsSXpybjZ6cXQ3anNuYmdnN0txOUlPcTRzT3lXdFNEc2dxM3NvSnpyaXBRZzdKMjA2Nis0SU91Qm5ldUNyT3VMcENBcUx5QjlEUW9nSUhKbGRIVnliaUJ5WlcxdmRtVmtPdzBLZlEwS0RRb3ZMeURyaTZUcnBxd29NVEU0T0RncDZyQ0FJT3VXb0NEc25vanNuTHpycWJRZzY0R0k2NHVrSU9LQWxDRHN0SWpxdUxEdG1aUWc3SXVjSU91Q3FPeWRnQ0RzaExqc2haZ2c3S0NWNjZhc0lDanNsNGJzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lMcE8yTXFDa05DbVoxYm1OMGFXOXVJSE5vZFhSa2IzZHVRbkpwWkdkbEtDa2dldzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUhJZ1BTQm9kSFJ3TG5KbGNYVmxjM1FvZXlCb2IzTjBPaUFuTVRJM0xqQXVNQzR4Snl3Z2NHOXlkRG9nTVRFNE9EZ3NJSEJoZEdnNklDY3ZjMmgxZEdSdmQyNG5MQ0J0WlhSb2IyUTZJQ2RRVDFOVUp5d2dkR2x0Wlc5MWREb2dNVFV3TUNCOUxDQW9LU0E5UGlCN2ZTazdEUW9nSUNBZ2NpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnbmRHbHRaVzkxZENjc0lDZ3BJRDArSUhzZ2RISjVJSHNnY2k1a1pYTjBjbTk1S0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlNCOUtUc05DaUFnSUNCeUxtVnVaQ2dwT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNuME5DZzBLWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9LSEpsY1N3Z2NtVnpLU0E5UGlCN0RRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwTkNpQWdhV1lnS0hKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoYkhSb0p5a2dldzBLSUNBZ0lDOHZJSFk2SU9xd2tPeUxuT3lla0NEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENEcXRhenJzb1Rzb0lRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU9xemhPeUdqU0RyajR6cXM2QWc3SjZJNjRxVTdLZUFJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsWmpyaXBRZzdKcXA2NCtFRFFvZ0lDQWdMeThnS0hZeUlEMGc3TEM5SU95SXFPcTVnQ0RzaUpqc29KWHRqSkFzSUhZeklEMGdMMkZqWTI5MWJuUWc3TGFVNnJDQTdZeVFMQ0IyTkNBOUlDOTFibWx1YzNSaGJHd2c3TGFVNnJDQTdZeVFLUTBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCM1lYUmphR1Z5T2lCMGNuVmxMQ0IyT2lBMElIMHBPdzBLSUNCOURRb2dJQzh2SU95ZHRDQlFRK3lYa0NEcm9aenF0N2pzbmJqcmtKd2c3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRGlnSlFnN1pTTTY1K3M2cmU0N0oyNElPeXlxeUR0bVpUcnFiVEN0KzJaaU95ZHRDQWk2NGlFNnJXc0lPcXpoT3lnbGV5Y3ZPdWhuQ0RzazdEcmlwVHNwNEFpSU91enRPeVhyT3lqdk91S2xDRHJqYkFnN0pPMDY0dWtMZzBLSUNBdkx5RHFzSkRzaTV6c25wRHFzSUFnNjR1MTdaV1k2NHFVSU95ZHRPeWNvRG9nNjR1azY2YXM2Nlc4SU95OG5PdXB0Q0RzbTR6cnNJM3NsNFhzbkx6cm9ad2c3WUcwNjZHYzY1T2M2ckNBSU95THBPeWduQ0R0bUxqc3RwenJqN3dnNnJXczY0K0ZJT3lDck95YXFldWZpZXlkdENEcmdwanFzSVRyaTZRdURRb2dJQzh2SU9xd2tPeUxuT3lla091S2xDRHRqSXpzbmJ6cnA0d2c3SjI5N0p5ODY2K0E2NkdjSU95Q3JPeWFxZXVmaVNBd0lNSzNJT3VNZ09xNHNDQXdJT0tBbENEcXNvRHRocURycDR3ZzdKT3c2NHFVSU95Q3JPdWVqT3lYa09xeWpDRHJ1WVRzbXFuc25ZUWc2Nnk4NjZhczdLZUFJT3lWaXV1S2xPdUxwQzROQ2lBZ0x5OGc3S084N0oyWU9pRHNsNnpxdUxBZzZyT0U3S0NWN0oyMElPdXp0T3lYck91UGhDRHNub1hzbnFYcXRvenNuYlFnNjZlTTY2T002NUNRN0oyRUlPeUltQ0Rzbm9qcmk2UW83SnlnN1pxbzdJU3g3SjJBSU95THBPeWduQ0R0bUxqc3Rwd2c2NVdNNjZlTUlPeVZqQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHJpNlRycHF3Z0wyaGxZV3gwYU95ZG1DQndjbTlpYkdWdElPeXd1T3F6b0NrdURRb2dJR2xtSUNoeVpYRXVkWEpzSUQwOVBTQW5MMkZqWTI5MWJuUW5LU0I3RFFvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3Z1kyeGhkV1JsT2lCb1lYTkRiR0YxWkdVb0tTQjlLVHNOQ2lBZ2ZRMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZkMkZyWlNjcElIc05DaUFnSUNCcFppQW9JV2hoYzBOc1lYVmtaU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNnZlNrN0RRb2dJQ0FnZDJGclpVSnlhV1JuWlNncE93MEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0IzWVd0cGJtYzZJSFJ5ZFdVZ2ZTazdEUW9nSUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dldzBLSUNBZ0lHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdEUW9nSUNBZ2NtVjBkWEp1T3cwS0lDQjlEUW9nSUM4dklPeTBpT3E0c08yWmxDRGlnSlFnN0oyMElGQkQ2Nlc4SUNmc2c0Z2dVRU1uSU95RGdlMkRuT3VobkNEcmtKanJqNHpycHJEcmk2UWdLTzJVak91ZnJPcTN1T3lkdUNCYjdMU0k2cml3N1ptVVhTRHJzb1R0aXJ3cExnMEtJQ0F2THlEc25aSHJpN1hzbllRZzY2aTg3S0NBSU8yZG1PdWdwT3V6dE91Q3VDRHJrcVFnN0tDVjY2YXM3WldjNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc3BvbnNpNXdnN0tPOTdKZXM2NCtFSU8yYWpPeUxvT3lkZ0NEcmo0VHNzS250bFp6cmk2UXVEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkxYm1sdWMzUmhiR3duS1NCN0RRb2dJQ0FnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnY0d4aGRHWnZjbTA2SUhCeWIyTmxjM011Y0d4aGRHWnZjbTBnZlNrN0RRb2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3RFFvZ0lDQWdJQ0J6YUhWMFpHOTNia0p5YVdSblpTZ3BPdzBLSUNBZ0lDQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlIVnVhVzV6ZEdGc2JGTmxiR1lvS1RzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJkMkYwWTJobGNsMGc3TFNJNnJpdzdabVVLSFZ1YVc1emRHRnNiQ2tnNG9DVUlPeWduT3F4c0RvbkxDQnlaVzF2ZG1Wa0xtcHZhVzRvSnl3Z0p5a2dmSHdnSnlqc2w0YnNuWXdwSnlrN0RRb2dJQ0FnSUNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhCeWIyTmxjM011WlhocGRDZ3dLU3dnTWpBd0tUc05DaUFnSUNCOUxDQXlOVEFwT3cwS0lDQWdJSEpsZEhWeWJqc05DaUFnZlEwS0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdOQ3dnZXlCbGNuSnZjam9nSjA1dmRDQm1iM1Z1WkNjZ2ZTazdEUXA5S1RzTkNnMEtMeThnN0oyMDY2KzRJT3VXb0NEc25vanNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeWloZXVqakNBbzdKNlE2NCtaSU95TG5PeWVrU0FySUc1d2JTQmlkV2xzWkNEc3BKSHJzN1VnN0l1azdaYUpJT3VNZ091NWhDa05Dbk5sY25abGNpNXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdldzBLSUNCcFppQW9aU0FtSmlCbExtTnZaR1VnUFQwOUlDZEZRVVJFVWtsT1ZWTkZKeWtnY0hKdlkyVnpjeTVsZUdsMEtEQXBPdzBLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3RFFwOUtUc05Dbk5sY25abGNpNXNhWE4wWlc0b1VFOVNWQ3dnSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzTkNpQWdZMjl1YzI5c1pTNXNiMmNvSjF0M1lYUmphR1Z5WFNEdGdiVHJvWnpyazV3ZzY0dWs2NmFzSU9xd2tPeUxuT3lla0NEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93MEtmU2s3RFFvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJQ2RzYjJOaGJHaHZjM1FuNnJDQUlEbzZNZXVobkNEcnFMenNvSUFnN1pXMDdJU2Q2NUNZNjRxVUlPMlptT3F5dmV5WGtPeUVuQTBLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlFbFFkalRyb1p3ZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDRHJpNlRycHF3ZzZybW83SnF3NnJpd3dyZnFzNFRzb0pVZzdLR3c3WnFNNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJqWmdnNjZ5NDdLQ2NJT3VNZ095ZGtTanJpNlRycHF6c21ZQWc2NCtaN0oyOEtTNE5DbU52Ym5OMElITmxjblpsY2pZZ1BTQm9kSFJ3TG1OeVpXRjBaVk5sY25abGNpaHpaWEoyWlhJdWJHbHpkR1Z1WlhKektDZHlaWEYxWlhOMEp5bGJNRjBwT3cwS2MyVnlkbVZ5Tmk1dmJpZ25aWEp5YjNJbkxDQW9LU0E5UGlCN2ZTazdJQzh2SURvNk1leWRoQ0RycXJzZzdKNmg3SldFNjQrRUtFVkJSRVJTU1U1VlUwWEN0MGxRZGpZZzdKZUc3SjJNS1NCSlVIWTA2NmVNN0p5ODY2R2NJT3F6aE95R2pTRHJqNW5zbnBFTkNuTmxjblpsY2pZdWJHbHpkR1Z1S0ZCUFVsUXNJQ2M2T2pFbktUc05DZz09JwpCNjRfRVhBTVBMRVM9J0l5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzcElUc25ZUWc2N0NVNnI2NDZyT2dJT3lMdHV5Y3ZPdXB0Q0JnSUM4Z1lDQW83SldlNjVLa0lPcXp0ZXV3c1NEdGo2enRsYWdnN0lxczY1Nlk3SXVjS1NvcUlPdWhuQ0R0a1p6c2k1enRsWmpzaExqc21wUXVJTzJVak91ZnJPcTN1T3lkdU95WGtPeUVuQ0Rya1pBZzdLU0U2NkdjSU91enRPeVhyT3lua2V1TGlPdUxwQzRLTFNEc2dxenNtcW5zbnBEcXNJQWc3SjZGNjZDbDdaV2NJT3VzdU9xMXJPcXdnQ0JnN0p1UTY3TzRZT3F6dkNBbzZyTzE2N0N4d3JmcnJManNucVhydG9EdG1MZ2c2NnkwN0l1YzdaV1k2ck9nS1NEcXNKbnFzYkRyZ3Bnc0lPeUVuT3VobkNEdGo2enRsYWp0bFpqcnFiUWc2cmU0SU95MmxPeXluT3lWaU91VHBPeWRoQ0RyczdUc2w2enNwSTNyaTRqcmk2UXVDaTBnNjZlazdMbXQ3WldnSU91VmpDQXFLdXVuaU95S3BPMkN1ZXVRbkNEc25iVHJwb1FvN1ptTlhDcnJqNWtwTENEc2lLdnNucEFvN0tDRTdabVU2N0tJN1ppNHdyY2k3Sm00SURMcnFvVWlJT3VUc1NucmlwUWc2NnkwN0l1Y0tpcnRsYW5yaTRqcmk2UWc0b0NVSU95ZHRPdW1oTUszN0lpWTY1K0p3cmZyc29qdG1ManJwNHdnNjR1azY2VzRJT3VzdU9xMXJPdVBoQ0Rxc0puc25ZQWc3SmlJN0l1YzY2R2NJT3llb2UyWWdPeWFsQzRnNjR1b0xDRHN0cFRzc3B6c2xZanNsNUFnN0tDQjdKYTA2NUdVSU95ZHRPdW1oTUszN0lpcjdKNlE2NHFVSU9xM3VPdU1nT3VobkNEcmdwanNtS1RyaTRnZzdJdWs3S0NjSU9xd2t1eVhrQ0RycDU3cXNvd2c2ck9nN0xPUUlPeVRzT3lFdU95YWxDNEtMU0Rzb0p6cnFxa29ZQ01qWUNucXM3d2dZQ01qSTJBc0lHQXRZQ0RxdUxEdG1ManJpcFFnN1ppVjdJdWQ3SjIwNjR1SUlPdXdsT3ErdU95bmdDRHJwNGpzaExqc21wUXVDZ29qSXlEc2lxVHRnNERzbmJ3ZzdKdVE3TG1aSUNqc3NManFzNkFnNG9DVUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZQWdkWGd0ZDNKcGRHbHVaeTV0WkNEcXNJRHNuYlRyazV3cENnb3RJTzJWdE95YWxPeXl0Q3dnNjdhQTY1T2M2NStzN0pxMElPeWloZXF5c0NoZ2Z1eWVpT3lXdE95YWxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrS0xTRHFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NBbzdLQ0U3SWFoNG9hUzY3TzA2NEswNjR1a0tTd2c2N2FBN0tDVklPeURnZTJacWV1UGhDRHJsTEhybExIdGxaanNwNEFnN0pXSzZyS01LQ0xzc0w3cXVMQWc3SXVrN1l5b0l1S2RqQ0FpN0xDKzdKMkVJT3lJbUNEc2w0YnNsclRzbXBRaTRweUZLUW9LSXlNZzdMYVU3TEtjSU95WWlPeUxuQW9LSXlNaklPeW5oTzJXaWUyVm1PdU5tQ0RzbnBIc2w0WHNuYlFnN0o2STdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3S2VFN1phSklPeWtrZXlkdUNEcmdyVHNsNjNzbmJRZzdKNkk3SmEwN0pxVUxpQXZJT3lkdE95V3RPeUVuQ0RzcDRUdGxvbnRsYURxdVl6c21wUS9DZ29qSXlNZzZyTzE3SnlnSU95YWxPeXlyZXlkaENEc3Q2anNob3p0bFpqcnFiUWc3SnFVN0xLdElPdUN0T3lYcmV5ZHRDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTNxT3lHak8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHN0NmpzaG96dGxhQWc2cks5N0pxd0lPeWFsT3l5clNEcmdyVHNsNjNyajRRZzdJS3Q3S0NjNjQrODdKcVVMaUF2SU9xenRleWNvQ0RzbXBUc3NxM3NuWVFnN0xlbzdJYU03WldnNnJtTTdKcVVQd29LSXlNaklPcTRzT3E0c091bHZDRHNzTDdzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXWTdJUzQ3SnFVTGdvdElPcTRzT3E0c091bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaV1k2cml3SU95Z2hPeVhrT3VLbENEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQTdKNkY3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDaTBnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxnb0tJeU1qSU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c3Sm00SURMcnFvWHNsNURxc293ZzZyYU03WldjSU95Q3JleWduQ0RzbFl6cnByenRocUhzbllRZzdLQ0U3SWFoN1pXZzZybU03SnFVUHdvdElPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdE91Z3BPcXpvQ0R0bGJUc21wUXVJQzhnN1ptTkt1dVBtU2d3TVRBdE1USXpOQzAxTmpjNEtTRHJpNWdnN0ptNElETHJxb1hzbDVEcXNvd2c2N08wNjRLODZybU03SnFVUHdvdElPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnNjR1WUlPeVp1Q0F5NjZxRjdKZVE2cktNSU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN2T3E1ak95YWxEOEtMU0RxdG96dGxad2c3SUt0N0tDY0lPeVZqT3Vtdk8yR29leWRoQ0R0bVkwcTY0K1pLREF4TUMweE1qTTBMVFUyTnpncElPdUxtQ0RzbWJnZ011dXFoZXlYa09xeWpDRHJzN1RyZ3J6cXVZenNtcFEvQ2dvakl5TWpJTzJabGV5ZHVNSzM2ckt3N0tDVklPMk1uZXlYaFFvS0l5TWpJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeUNyZXlnbk91UW5DRHJqYkRzbmJUdGhMRHJpcFFnNjdPMTZyV3M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHJrSmpyajR6cnByUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNvSlhycDVBZzdJS3Q3S0NjN1pXZzZybU03SnFVUHdvS0l5TWpJT3V6Z09xeXZleUNyTzJWcmV5ZHRDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdKV1k3SXExNjR1STY0dWtMaURyZ3BqcXNJRHNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SldFN0tlQklPeWdnT3llcGUyVm1PeW5nQ0RzbFlyc25ZQWc2NEswN0pxcDdKMjBJT3llaU95V3RPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpyajd6c21wUXVJQzhnN0xTSTZyaXc3Wm1VN1pXZzZybU03SnFVUHdvS0l5TWpJeURzbDVEcm42ekN0K3lMcE8yTXFBb0tJeU1qSU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU91RXBPMkt1T3liak8yQnJPeVhrQ0RzbDdEcXNyRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzbDdEcXNyQWc3SU9CN1lPYzY2VzhJTzJabGV5ZHVPMlZtT3F6b0NEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPdXduT3lEbmUyV2lPeUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU95RG5lcXl2T3lXdE95YWxDNGdMeURzbnFEc2k1d2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWaE95ZHRPdVVsQ0RybUpEcmlwUWc2N21FNjdDQTY3S0k3Wmk0NnJDQUlPeWR2T3k1bU8yVm1PeW5nQ0RzbFlyc2lyWHJpNGpyaTZRdUNpMGc3SldFN0oyMDY1U1VJT3VZa091S2xDRHJ1WVRyc0lEcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDNyc29qdG1ManFzSUFnN0oyODdMbVk3WldZN0tlQUlPeVZpdXlLdGV1TGlPdUxwQzRLTFNEc25ianNwcDNyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3kwaU9xenZPdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKMjQ3S2FkNjdLSTdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnN0plRjY2R2M2NU9jN0plUUlPeUxwTzJNcU8yV2lPeUt0ZXVMaU91THBDNEtMU0R0akl6c25ienNuWVFnN0ppczY2YXM3S2VBSU91cXUrMldpT3lXdE95YWxDNGdMeURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3S0NRNnJLQUlPeWtrZXllaGV1TGlPdUxwQzRnN0oyMDdKcXA3SmVRSU91MmlPMk91T3lkaENEcms1enJvS1FnN0tPRTdJYWg3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEc2hKenJ1WVRzaXFUcnBid2c3S0NRNnJLQTdaV1k2ck9nSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSkRxc29Ec25iUWc2NEdkNjRLWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bFlUc2lKZ2c3SjZGNjZDbElPMlZyZXVxcWV5ZWhldUxpT3VMcEM0S0xTRHF2SzBnN0o2RjY2Q2w3WlcwN0pXOElPMlZtT3VLbENEdGxhM3JxcW5zbmJUc2w1RHNtcFF1Q2dvakl5TWpJT3Eyak8yVm5NSzM3SVNrN0tDVkNnb2pJeU1nN0xtMDY2bVU2NTI4SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdJcTE2NHVJNjR1a0xpRHNoS1Rzb0pYc2w1RHNoSndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU95THJleUxuT3lZcEM0S0xTRHN1YlRycVpUcm5id2c2cmFNN1pXYzdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0xtMDY2bVU2NTI4SU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmpPdW12Q0RxdG96dGxaenNuYlFnNnJHdzY3YUE2NUNZN0phMElPeVZqT3Vtdk95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHNsWXpycHJ3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PdXB0Q0RzaG96c2k1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUlDOGc3SVNrN0tDVjdKZVE3SVNjSU95VmpPdW12T3lkaENEc3ZKd2c3S084N0lTNDdKcVVMZ29LSXlNaklPeWNoT3k1bUNEc29KWHJzN1FnN0oyMDdKcXA3SmVRSU91UG1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyb1ozc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdVRzZXVobmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWc3SUt0N0tDYzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeUNyZXlnbk8yV2lPeVd0T3lhbEM0S0NpTWpJeUR0Z2JUcnByM3JzN1RyazV6c2w1QWc2N08xN0lLczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0ZXlDck8yV2lPeVd0T3lhbEM0S0NpTWpJeURzbXBUc3NxM3NuWVFnN0xLWTY2YXNJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKcVU3TEt0N0oyRUlPeXltT3Vtck8yVm1PcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPeVZpT3VDdE1LMzdKeWc2NCtFQ2dvakl5TWc3SU9JNjZHYzdKcTBJT3V5aE95Z2hPeWR0Q0RzdHB6c2k1enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlPeVhoZXVOc095ZHRPMkt1Q0R0bTRRZzdKMjA3SnFwSU9xd2dPdUtwZTJWcWV1TGlPdUxwQzRLTFNEc2c0Z2c2N0tFN0tDRTdKMjBJT3VDbU95WmxPeVd0T3lhbEM0Z0x5RHNsNFhyamJEc25iVHRpcmp0bFpqcnFiUWc3SU9JSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0oyMDdKcXA3SjJFSU95Y2hPMlZ0Q0RzbGIzcXRJQWc2NCtaN0oyWTZyQ0FJTzJWaE95YWxPMlZxZXVMaU91THBDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzaTV6c25wSHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25xWHNpNXpxc0lRZzY2KzQ3SUtzN0pxcDdKeTg2NkdjSU95ZWtPdVBtU0Ryb1p6cXQ3anNsWVRzbTRNZzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3lZcE91ZXErdVBtZXlWaUNEc2dxenNtcW50bFpqc3A0QWc3SldLN0pXRUlPdWhuT3EzdU95VmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyaTRqcmk2UXVJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbllRZzdabVY3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3E0c09xNHNPcXdnQ0RyaEtUdGlyanNtNHp0Z2F6c2w1QWc3SmV3NnJLdzY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJpdzZyaXc3SjJZSU95WHNPcXlzQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbUlIc2c0SHNuWVFnNjdhSTY1K3M3SmlrNjRxVUlPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0ppQjdJT0I3SjJFSU91MmlPdWZyT3lZcE9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3kzcU95R2pPMlZtT3lMcENEcXNyM3NtckFnN0l1ZzdMS3Q3WldZN0l1Z0lPdUN0T3lhcWV5ZGdDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdJcTE2NHVJNjR1a0xnb3RJT3kzcU95R2pPMlZtT3VwdENEc2k2RHNzcTN0bFp3ZzY0SzA3SnFwN0oyMElPeWdnT3llcGV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvQ2kwZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvSUM4ZzdMZW83SWFNN1pXWTY2bTBJT3llaGV1Z3BlMlZuQ0RyZ3JUc21xbnNuYlFnN0lLczY1Mjg3S0M0N0pxVUxnb0tJeU1qSXlEcXNJRHNuYlRyazV3ZzdKaUk3SXVjSUNoMWVDMTNjbWwwYVc1bkxtMWs3SmVRN0lTY0lPeVlydXE1Z0NEaWdKUWc2cmVjN0xtWjdKeTg2NkdjSU95ZWtPdVBtZTJabENEcnFyc2c3WldZNjRxVUlPdXN1T3llcFNEc25xenF0YXpzaExFZzdJS3M2NkdBS1FvS0l5TWpJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxczZBZzZyT0U3SXVjNjRLWTdKcVVQd290SU95ZWtPdVBtZXl3cU9xd2dDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUxnb3RJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFF1Q2dvakl5TWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVMZ290SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQzRLQ2lNakl5RHF1SWpzbmJ6cXVZenNwNEFnNjYrNDY0S3BJT3lMbkNEc2w3RHNzclFnN0xLWTY2YXM2NUNwNjR1STY0dWtMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUNxZXUyZ08yVm1PeUxuT3E0c0NEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUF2SU8yYmhPdTJpT3F5c095Z25DRHF1SWpzbGFIc25ZUWc2NEswN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lna09xeWdDRHF1TERxc0lUc2w1RHJpcFFnN0lTYzY3bUU3SXFrSU95ZHRPeWFxZXlkdENEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUxvT3UyaE95bW5TRHRtWlhzbmJnZzdLQ0U3SmVRNjRxVUlPeUdvZXE0aUNEcnNJOGc2ckt3N0tDYzZyQ0FJT3UyaU9xd2dPMlZxZXVMaU91THBDNEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPdXpnT3F5dlNEc2k1d2c3THFRN0l1YzY3Q3hJT3llck95bmdPcTRpZXlkZ0NEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNnNEhyaTdRZzdaS0k3S2VJSU8yV3BleURnZXlkaENEc25JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhbEM0S0NpTWpJeU1nNnJPRTdLQ1Z3cmZzbm9Ycm9LVUtDaU1qSXlEc2xZVHNuYlRybEpRZzY1aVE2NHFVSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWR0T3lEZ1NEc25wanJxcnNnN0o2RjY2Q2w3WldZN0plc0lPcXpoT3lnbGV5ZHRDRHNucURxdUlnZzdMS1k2NmFzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWVtT3VxdXlEc25vWHJvS1h0bGJUc2hKd2c2ck9FN0tDVjdKMjBJT3llb09xeXZPeVd0T3lhbEM0Z0x5RHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzdKNnM3SVNrN0tDVjdaV1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25iVHJyN2dnN0lLczdKcXBJT3lra2V5ZHVDRHNsWVRzbmJUcmxKVHNub1hyaTRqcmk2UXVDaTBnN0oyMDY2KzRJT3lUc09xem9DRHNub2pyaXBRZzdKV0U3SjIwNjVTVTdKaUk3SnFVTGlBdklPdUxwT3VsdUNEc2xZVHNuYlRybEpUcnBid2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNncXpzbXFudGxhQWc3SWlZSU95WGh1dUtsQ0RydVlUcnNJRHJzb2p0bUxqc25vWHJpNGpyaTZRdUlPeVlnZXVzdUN3ZzdJaXI3SjZRTENEdGlybnNpSmpyckxqc25wRHJwYndnN1krczdaV283WldZN0plc0lEanNucEFnN0oyMDdJT0JJT3llaGV1Z3BlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc21JSHJyTGdzSU95SXEreWVrQ3dnN1lxNTdJaVk2Nnk0N0o2UTY2VzhJTzJQck8yVnFPMlZ0Q0E0N0o2UUlPeWR0T3lEZ1NEc25vWHJvS1h0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95ZWhldWdwU0Rxc0lEcmlxWHRsWndnNnJpQTdKNlFJT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzdKNkY2NkNsN1pXZ0lPeUltQ0Rzbm9qcmlwUWc2cmlBN0o2UUlPeUltT3VsdkNEcmhKanNsNGpzbHJUc21wUXVJQzhnNjRLMDdKcXA3SjJFSU95aHNPcTRpQ0RzcElUc2w2d2c3S084N0lTNDdKcVVMZ29LSXlNakl5RHRqSXpzbmJ6Q3QrcXlzT3lnbk1LMzZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzaUpqcmk2anNuWVFnN1ptVjdKMjQ3WldZNnJPZ0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WldZN0plc0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xenRlcXdoT3lkaENEdG1aWHJzN1R0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BDRHNwSURydVlRZzdLU1I3SjZGNjR1STY0dWtMZ290SU95a2dPdTVoTzJWbU9xem9DRHNub2pyaXBRZzZyaXc2NHFsN0oyMDdKZVE3SnFVTGlBdklPeWhzT3E0aU91bmpDRHF1TERyaTZUcm9LUWc3S084N0lTNDdKcVVMZ29LSXlNaklPdVRzZXVoblNEcXNJRHJpcVh0bFp3ZzdMV2M2NHlBSU9xd25PeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnNjQyVUlPdVRzZXVobmUyVm1PdWdwT3VwdENEcXVMRHNvYlFnN1pXdDY2cXA3SjJFSU95Q3JleWduTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095MmxPcXdnQ2tLQ2lNakl5RHN0cHpyajVrZzdKcVU3TEt0N0oyMElPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0xhYzY0K1pJT3lhbE95eXJleWRoQ0Rzb0pIc2lKanRsb2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLOTY3bUVJT3lEZ2UyRG5PdWx2Q0R0bVpYc25ianRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPcXl2ZXU1aENEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3SUNqc2w0YnNsclRzbXBRZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUXBDZ29qSXlNZzY3TzQ3SjI0SU95ZHVPeW1uZXlkaENEdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0Ryczdqc25iZ2c3SjI0N0thZDdKMkVJTzJWbU91cHRDRHJxcWpyazZBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95ZHRPdXBsT3lkdkNEc25ianNwcDBnN0tDRTdKZVE2NHFVSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lkdE91cGxPeWR2Q0RzbmJqc3BwM3NuWVFnNjZlSTdMbVk2Nm0wSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3kvb08yUHNPeWRnQ0Ryb1p6cXQ3anNuYmdnN1p1RTdKZVE2NmVNSU95Q3JPeWFxU0Rxc0lEcmlxWHRsYW5yaTRqcmk2UXVDaTBnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3kvb08yUHNPeWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJyN2pzaExIcmhZVHNucERyaXBRZzY3TzA3Wmk0N0o2UUlPdVBtZXlkbUNEc2w0YnNuYlFnNnJLdzdLQ2M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzY3TzA3Wmk0N0o2UTZyQ0FJT3VQbWV5ZG1PMlZtT3VwdENEcXNyRHNvSnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsSVRyb1p6dGxZVHNuWVFnNjVPeDY2R2Q3WldZN0tlQUlPeVZpdXljdk91cHRDRHNuYlRzbXFuc25iUWc3S0NjN1pXYzY1Q3A2NHVJNjR1a0xnb3RJTzJVaE91aG5PMlZoT3lkaENEcms3SHJvWjN0bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2xiRWc2N0tFN0tDRTdKMjBJT3VDcnV5VmhDRHNuYnpydG9BZzZyaXc2NHFsN0oyMElPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVobmV1UW1PeW5nQ0RzbFlyc2xZUWc3SUtzN0pxcDdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0xhYzdKNkZJT3k1dE91VG5PdWx2Q0RyazdIcm9aM3RsWmpycWJRZzY3Q1U2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3SUNqc21ZVHJvNHdnN0pXSTY0SzBLUW9LSXlNaklPMmFqT3lia09xd2dPeWVoZXlkdENEc21ZVHJvNHpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNnJDQTdKNkY3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEc21JanNsYjNzbmJRZzdMZW83SWFNNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95WWlPeVZ2ZXlkaENEc3Q2anNob3p0bG9qc2xyVHNtcFF1Q2dvakl5TWc2Nnk0N0oyWTZyQ0FJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdJaWM3TENvN0tDQjdKeTg2NkdjSU91THRldXpnT3VUbk91bXJPcXlvT3lLdGV1TGlPdUxwQzRLTFNEcnJManNuWmpycGJ3ZzdLQ1I3SWlZN1phSTdKYTA3SnFVTGlBdklPeUluT3lFbk91TWdPdWhuQ0RyaTdYcnM0RHJrNXpycHJUcXNvenNtcFF1Q2dvakl5TWc3SVNrN0tDVjdKMjBJT3kwaU9xNHNPMlpsT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzaEtUc29KWHNuWVFnN0xTSTZyaXc3Wm1VN1phSTdKYTA3SnFVTGdvS0l5TWpJT3U1aE91d2dPdXlpTzJZdU9xd2dDRHJzNERxc3IzcmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SU91d2xPcS9xT3lXdE95YWxDNEtDaU1qSXlEc25ianNwcDNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHVPeW1uZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNaklPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUWdLT3luaU91c3VDRHNucXpxdGF6c2hMRXBDZ29qSXlNZzdKYTQ3S0NjSU91d3FldXN1TzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEcnNLbnJyTGdnNjRLZzdLZWM2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0phMDY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RycDR6cm80enJvWndnN0oyMDdKcXA3SjIwSU95a2tleW5nT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzbmJUc21xa2c2cml3NnJDRTdKMjBJT3VCbmV1Q21PeUVuQ0RzcDREcXVJanNuWUFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SnFwNjUrSklPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0lEc25xWHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lnZ095ZXBlMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVDZ29qSXlNZzdZYTE3SXVnSU95WXBPdWxtT3VobkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXWTdKaUE3SXExNjR1STY0dWtMZ290SU8yR3RleUxvT3lkdENEc201RHRtWnp0bFpqc3A0QWc3SldLN0pXRUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0pIcXQ3enNuYlFnNnJHdzY3YUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0phMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RxdG96dGxaenNuWVFnN0pxVTdMS3Q3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nN0lPQjdabXBJT3lWaU91Q3RDQW9NdXVMcUNEcXRhenNvYkFwQ2dvakl5TWc3SjZGNjZDbDdaV1k3SXVnSU95anZPeUdqT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnNjR1azdJdWNJTzJabGV5ZHVDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdLTzg3SWFNNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU91THBPeUxuQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lhbE95eXJlMlZtT3lMb0NEdGpwanNuYlRzcDREcnBid2c3TEMrN0oyRUlPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3WTZZN0oyMDdLZUE2Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEdGc0anRoN1R0bFpqcnFiUWc2NnFvNjVPZ0lPdU5zT3lkdE8yRXNPcXdnQ0RzZ3Ezc29KenJrSmpxczZBZzY0dWs3SXVjSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95Z2xldW5rQ0R0ZzRqdGg3VHRsYURxdVl6c21wUS9DZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeURnZTJacVNEc2xZanJnclFwQ2dvakl5TWc2N2FBN0o2c0lPeWtrU0Ryc0tucnJManNucERxc0lBZzZyQ1E3S2VBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91MmdPeWVyQ0RzcEpIc2w1QWc2N0NwNjZ5NDdKNlE2ckNBSU95ZWlPeVhpT3lXdE95YWxDNGdMeURzbUlIc2c0SHNuWVFnN1ptVjdKMjQ3WlcwSU91enRPeUV1T3lhbEM0S0NpTWpJeURxc3IzcnVZUWc3WlcwN0tDY0lPcTJqTzJWbk95ZHRDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZySzk2N21FSU8yVnRPeWduQ0RxdG96dGxaenNuYlFnN1pXRTdKcVU3WlcwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHNtcFRzc3EzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPMlpsT3llckNEcXNKRHNwNERxdUxBZzY3Q3c3WVN3NjZhczZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNEtMU0R0bVpUc25xd2c2ckNRN0tlQTZyaXdJT3V3c08yRXNPdW1yT3F3Z0NEc2xyenJwNGdnN0plRzdKYTA3SnFVTGlBdklPdXdzTzJFc091bXJPdWx2Q0RxdFpEc3NyVHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzdHBYc2xiMGdLeURxdUkzc29KVWc3S0NFN1ptWUlDanJrWkFnNjZ5NDdKNmxJT0tHa2lEcXVJM3NvSlh0bUpVZzdaV2NJT3VzdU95ZXBTa0tDaU1qSXlEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVUHlEc2xZenJwcnpzbllRZzdMeWM3S2VBSU95Vml1eWN2T3VwdENEc3BKSHNtcFR0bFp3ZzdJYU03SXVkN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU95VmpPdW12T3lkaENEc3ZKenJxYlFnN0tTUjdKcVU3WldjSU95R2pPeUxuZXlkaENEcnNKVHJvWndnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0o2UTY0K1o3SjIwN0xLMDY2VzhJT3VUc2V1aG5lMlZtT3luZ0NEc2xZcnFzNkFnNjRTWTdKYTA2ckNJNnJtTTdKcVVQeURyazdIcm9aM3RsWmpzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc25wRHJqNW5zbmJUc3NyVHJwYndnNjVPeDY2R2Q3WldZNjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJzN2dnNnJPRTdKVzk3SjJZSU95Y29PeWR2TzJWbkNEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3lkdk91d21PcTBnT3Vtck95ZWtPdWhuQ0RxdG96dGxaenJzNERxc3Izc25ZUWc3WldZN0l1a0lPeUltQ0RzbDRic2xyVHNtcFF1SU95ZHZPdXdtQ0RxdElEcnBxenNucERyb1p3ZzZyYU03WldjSU91emdPcXl2ZXlkaENEc201RHRsWmpzaTZRZzZySzk3SnF3SU91THBPdWx1Q0RzZ3F6cm5venNsNURxc293ZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtDRHF0b3p0bFp6c25ZUWc3S2VBN0tDVjdaVzBJT3lqdk95TG9DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZuQ0Rya3FRZzdKMjg2N0NZSU9xMGdPdW1yT3lla091aG5DRHJzNERxc3IzdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXpnT3F5dmUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvPScKQjY0X0dVSURFPSdJeUJWV0NCWGNtbDBhVzVuSU9xd2dPeWR0T3VUbkEwS0RRb2pJeUF4TGlEdGxiVHNtcFRzc3JRTkNnMEs3S0NjN1pLSUlPeVZpT3lkbUNEcnFxanJrNkFnNjZ5NDZyV3M2NHFVSUNmdGxiVHNtcFRzc3JRbjY2R2NJT3lOcU95YWxDNE5DdXlkdk9xMGdPeUVzU0Rzbm9qcmlwUWc3SUtzN0pxcDdKNlFJT3F5dmUyWG1PeWRoQ0RycDR6cms2UWc3SWlZSU95ZWlPdVBoT3VoblNBcUt1eURnZTJacVN3ZzY2ZWw2NTI5N0oyRUlPdTJpT3VzdU8yVm1PcXpvQ0RycXFqcms2QWc2Nnk0NnJXczdKZVFJTzJWdE95YWxPeXl0T3VsdkNEc29JSHNtcW50bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RyczdUcmc0WHJpNGpyaTZRZzRvYVNJT3V6dE91Q3ZPcXlqT3lhbEEwS0RRb3FLaW9OQ2cwS0l5TWdNaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0EwS0RRcnNvSnp0a29nZzdKV0k3SmVRN0lTY0lPeTFuT3VNZ08yVm5DQXFLdXVLcGV1UG1lMllsU0Ryckxqc25xVXFLdXlkaENEc2phanNvN3pzaExqc21wUXVJT3lJbU91UG1lMllsU0Ryckxqc25xWHNuWUFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNUzNzaUpqcmo1bnRtSlV0NjZ5NDdKNmw3SjJFTGV5TnFPdVBoQzNya0pqcmlwUXQ2cks5N0pxd0tleVhrQ0R0bGJUcmk3bnRsYUFnNjVXTTY2ZU1JT3lUc091S2xDRHFzb3dnN0tLTDdKV0U3SnFVTGcwS0RRb2pJeU1nNjVDUTdKYTA3SnFVSU9LR2tpRHRsb2pzbHJUc21wUU5DZzBLN0ppSUtRMEtMU0RzaEtUc29KWHJrSkRzbHJUc21wUWc0b2FTSU95RXBPeWdsZTJXaU95V3RPeWFsQTBLRFFvakl5TWdKMzdzbDRnbklPdTV2T3E0c0EwS0RRcnNtSWdwRFFvdElPdXdsT3VBak95WGlPeVd0T3lhbENEaWhwSWc2N0NVNnIrbzdKYTA3SnFVRFFvTkNpTWpJeURyajVuc2dxd2c2N0NVNnIrVTdKT3c2cml3RFFvTkN1eVlpQ2tOQ2kwZzY0YVM3SldFN0tHTTdKYTA3SnFVSU9LR2tpRHNtS3pybnBEc2xyVHNtcFFOQ2cwS0tpb3FEUW9OQ2lNaklETXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFOQ2cwSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEcnRvRHNvSlhzb0lFZzdMdWs2NjZrNjR1STdMeUE3SjIwN0lXWTdKMkVJT3kxbk91TWdPMlZuQ0RzcElUc25iVHFzNkFnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXlkaENEc2phanNvN3pzaExqc21wUXVEUXJydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVE10NjdhQTdLQ1Y3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzamFqc21wUXVEUW9OQ3V5WWlDQTZJT3lWaUNEcmo3enNtcFFzSU95WGh1eVd0T3lhbENBb1dDa2c0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSXlEc2w0YnNsclRzbXBRZzRvYVNJT3llaU95V3RPeWFsQTBLRFFyc21JZ3BEUW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxaanF1TEFnN0tDRTdKZVE2NHFVSU9xd2dPeWVoZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVJT0tHa2lEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaVzA3Slc4SU9xd2dPeWVoZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVEUW9OQ2lNakl5RHNsNURybjZ3ZzY2bVU3SXVjN0tlQURRb05DdXlYa091ZnJDRHNnNEh0bWFuc2w1RHNoSnpyajRRZ0l1MlZ0T3F5c0NEcnNLbnJzcFVpN0oyRUlPdW92T3lnZ0NEc2xZenJvS1Rzbzd6cmlwUWc2cmlON0tDVjdaaVZJT3Exck95aHNPdWhuQ0RzamFqc21wUXVEUW9OQ3V5WWlDa05DaTBnN0tlQTZyaUlJT3V5aE95Z2hPeVhrT3lFbk91S2xDRHNrN2dnN0lpWUlPeVhodXlXdE95YWxDNGc3SU9kN0xLMElPeWR1T3ltbmV5ZGhDRHNrN0Ryb0tUcnFiUWc3Sld4N0oyRUlPeTFuT3lMb0NEcnNvVHNvSVRzbkx6cm9ad2c3SmVGNjQydzdKMjA3WXE0SU8yVnRPeWp2T3lFdU95YWxDNGc0b2FTSU95VnNleWRoQ0RzbDRYcmpiRHNuYlR0aXJqdGxiVHNvN3pzaExqc21wUXVJT3lEbmV5eXRDRHNuYmpzcHAzc25ZUWc3Sk93NjZDazY2bTBJT3kxbk95TG9DRHJzb1Rzb0lUc25iUWc3WldFN0pxVTdaVzA3SnFVTGcwS0RRbzZPam9nZEdsd0lPMk1uZXlYaFNEcnNvVHRpcnpzbllBZ1d6Z3VJTzJNbmV5WGhWMGc2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQTBLN1l5ZDdKZUZLT3VMcE95ZHRPeVd2T3Vobk9xM3VDa2c2N0tFN1lxOElPdXN1T3Exck91S2xDRHNsWVRybnBnZ0tpbzRMaUR0akozc2w0VXFLaURzaExuc2haZ2c2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQ0RpZ0pRZzdZYTE2N08wNjRxVUlGdnRtWlhzbmJoZExDRHNtSWd2N0pXRTY0dUk3SmlrSU8yTWtPdUxxT3lkZ0NCYjdKV0U2NHVJN0ppa1hjSzNXK3VFcEYwc0lPdVBtZXlla1NEc25LRHJqNFRyaXBRZ1creTNxT3lHakYzQ3QxdnJqNW5zbnBGZExpQWk3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3ZzdKT3c2ck9nTENBaTY0dXI2cml3SU1LM0lPdVBtZXlla1NMc3NwanJuN3dnN0tlZDdKMjBJT3lWaUNEcnA1N3JpcFFnN0tHdzdaV3A3SjJBSU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFvNk9qb05DZzBLSXlNaklPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzdKaUlLUTBLTFNEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzRvYVNJT3lWdmVxMGdPeVhrQ0RyajVuc25aanRsWmpycWJRZzY2cW83SjZFN0tlQTdKdVE2cmlJN0oyRUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvakl5TWc3WmljN1lPZElPdU1nT3lEZ1NEc2xZanJnclFOQ2cwS0tpcnNoSnpydVlUc2lxVHJpcFFnN0pPNElPeUltQ0Rzbm9qc3A0RHJwNHdzSU8yS3VleWdsU0R0bUp6dGc1M3NuWUFnNjdDYjdKMkVJT3lJbUNEc2w0YnNuWVFnNjVXTUlPS0draURxdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPeU5xT3lhbEM0cUtnMEs3SUtzN0pxcDdKNlE2NHFVSU91c3VPcTFyT3VsdkNEcXZMenF2THp0bm9nZzdKMjk3S2VBSU95Vml1cXpvQ0R0bTVIc2xyVHJzN1RxdUxBbzdJcWs3THFVS1NEcmxZenJyTGpzbDVBc0lPdTJnT3lnbGUyWWxleWN2T3VobkNEc2s3RHJxYlFnN0tDYzdaS0lJT3lnaE95eXRPdWx2Q0RzazdnZzdJaVlJT3lYaHV1THBPcXpvQ0RzbUtUdGxiVHRsWmpxdUxBZzdJbXM3SnVNN0pxVUxnMEtEUXJzbUlncERRb3RJT3F6aE95aWpDRHFzSnpzaEtRZzdaaWM3WU9kN0oyQUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMaURpaHBJZ05DNDFKU0RxdUlqcnBxd2c3WmljN1lPZDY2ZU1JT3V3bSt5ZGhDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb3FLaW9OQ2cwS0l5TWdOQzRnN0xxUTdLTzg3SmE4N1pXY0lPcXl2ZXlXdEEwS0RRcnNvSnp0a29nZzdKV0k3SmVRN0lTY0lDZCs3SXVjNnJLZzdKYTA3SnFVUHljc0lDZnNpNXpyZ3Bqc21wUS9KeXdnSjM3cXU1Z25JT3F3bWV5ZGdDRHFzN3pyajRUdGxad2c2cks5N0phMDY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUXJzdFp6cmpJRHRsWndnN0xxUTdLTzg3SmE4N1pXWTZyT2dJT3k1bk9xM3ZPMlZuQ0RycDVEdGlLenJwYndnN0pPdzY0cVVJT3F5akNEc29vdnNsWVRzbXBRdURRcnFzcjNzbHJUcmlwUWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1pM3FzcjNzbHJUcnBid3Q3STJvNjQrRUxldVFtT3VLbEMzcXNyM3NtckFwN0plUUlPMlZ0T3VMdWUyVm9DRHJsWXpycDR3ZzdJMm83SnFVTGcwS0RRb2pJeU1nNjQrWjdJS3M3SmVRN0lTY0lDZCs3SXVjSnlEcnVienF1TEFOQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzdaVzA3S2VBN1pXWTdJdWM2cktnN0phMDdKcVVQeURpaHBJZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4TkNpMGc3SXVjN0o2UjdaV1k3SXVjNjRxVUlPdTJoT3lYa09xeWpDQTFMREF3TU95YmtPeWRoQ0RyazV6cm9LVHNtcFF1SU9LR2tpRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnMEtEUW9qSXlNZ0orcXpoT3lMbk91THBDY2c0b2FTSUNmc25vanJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKNlE2NCtaN0xDbzY2VzhJT3F3Z095bmdPcXpvQ0RxczRUc2k1enJncGpzbXBRL0lPS0draURzbnBEcmo1bnNzS2pxc0lBZzdKNkk2NEtZN0pxVVB3MEtMU0RycDZUcmk2d2c2N08wN1plWTY2T01JT3lXdk91bmlPeVVxU0RyZ3JUcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdUtsQ0RzbHJ6cnA0anNuYmpxc0lEc21wUS9JQ29vNjR1bzdJaWNJT3k1bU8yWm1PeWR0Q0RzbFlUcmk0anJuYndnNjZ5NDdKNmw3SjJFSU95RGlPdWhuQ0RzazdRZzdJS3M2NkdBN0ppSTdKcVVLU29OQ2cwS0l5TWpJQ2ZzbDZ6c3JZanJpNlFuSU9LR2tpQW43Wm1WN0oyNDdaV1k2NHVrTENEcnJMdnJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUg2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1SU9LR2tpRHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2Zxc0lEc3A0QWc2NHVrN0l1Y0lPMlpsZXlkdU8yVm9PcXlqT3lhbEM0TkNnMEtJeU1qSUNmcXU1Z25JT0tHa2lBbjdKZVE2cktNSncwS0RRcnNtSWdwRFFvdElPMlpqZXE0dU91UG1ldUxtT3E3bUNEcmdxRHNsWVRxc0lEcXM2QWc3SjZJN0phMDdKcVVMaURpaHBJZzdabU42cmk0NjQrWjY0dVk3SmVRNnJLTUlPdUNvT3lWaE9xd2dPcXpvQ0Rzbm9qc2xyVHNtcFF1RFFvTkNpTWpJeURxc3Izc2xyVHJwYndnNjdxUTdKMkVJT3VWakNEc2xyVHNnNG50bFp3ZzZySzk3SnF3RFFvTkN1eUNyT3lhcWV5ZWtPeWRtQ0Rzb0pYcnM3VHJwYndnNjdDYjY0cVVJT3luaU91c3VPeVhrT3lFbkNEcXVMRHFzNFRzb0lIc25MenJvWndnSjM3c2k1d242Nlc4SU91NmtPeWRoQ0RybFl3ZzY2eTQ3SjZsN0oyMElPeVd0T3lEaWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0tpcnRqSXpzbFlYdGxaanFzNkFnN0l1MjdKMkFJT3lnbGV1enRPdWx2Q0FuN0tPODdKYTBKK3VobkNEc2phanNoSndnNjZ5NDdKNmw3SjJFSU95RGlPdWhyZXF5akNEc2phanJzN1RzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhnNG9hU0lPdU1nT3kybkNEcnFxbnNvSUhzbmJRZzY2eTA3SmVIN0oyNDZyQ0E3SnFVUHcwS0xTRHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOGc0b2FTSU95TG9PcXpvQ0RzbmJUc25LRHJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUV1T3lhbEM0TkNnMEtLaW9xRFFvTkNpTWpJRFV1SUNkNzY2cUY3SUtzZlNBcklIdnJxb1hzZ3F4OUp5RHNrN0RzcDRBZzdKV0s2cml3RFFvTkNpTWpJeUR0bFp6c25wRHNsclFnN1pLQTdKYTA3Sk93NnJpd0RRb05DdTJWbk95ZWtPeVd0Q0RycW9Yc2dxenJwYndnN1pLQTdKYTA3SVNjSU91UG1leUNyQ0R0bUpYdGc1enJvWndnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdKMjA3SjZRSU8yWm1PdTJpT3lkaENEcnNKdnNsWmpzbHJUc21wUWc0b2FTSU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRTkNpMGc2NEswN0oyOElPeTV0T3VUbk9xd2t1eWR0Q0Rxc3JEc29KenJrS0FnN0ppSTdLQ1Y3SjIwN0plUTdKcVVJT0tHa2lEcmdyVHNuYnpzbllBZzdMbTA2NU9jNnJDU0lPdUNtT3F3Z091S2xDRHJncURzbmJUc2w1RHNtcFFOQ2cwS0l5TWpJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclRzazdEcXVMQWc3SmEwNjZDazdKcTRJT3F5dmV5YXNBMEtEUW9uZSt1cWhleUNySDNxc0lBZ2UrdXFoZXlDckgzdGxiVHNoSnduSU8yWWxlMkRuT3Vobk91bmpDRHRrb0RzbHJUc3BKanJqNFFnNjQyVUlPeTZrT3lqdk95V3ZPMlZtT3F5akNEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2NJT3Exck91bnBPMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUWc0b2FTSU95ZWxPeVZvZXlkdENEcnRvRHNvYkh0bGJUc2hKd2c2cldzNjZlazdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTmk0ZzdaR2M2cml3SU8yR3RleWR2QTBLRFFvakl5TWc2NUNZN0phMDdKcVVJQ2hZS1NEaWhwSWc2NCs4N0pxVUlDaFBLUTBLRFFycnFxanJzSlRzbmJ3ZzdabVU2Nm0wN0oyWUlPeWlnZXlkZ0NEcXM3WHFzSVRzbllRZzZyT2c2NkNrN1pXMElDZnJrSmpzbHJUc21wUW42NHFVSU91cXFPdVJrQ0FuNjQrODdKcVVKK3VobkNEdGhyWHNuYnp0bGJUc2hKd2c3STJvN0tPODdJUzQ3SnFVTGcwS0RRb3FLaW9OQ2cwS0l5TWdOeTRnNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3lJcSt5ZWtDRHRrWnpxdUxBTkNnMEs2NEtnN0tlY3dyZnNpNXpxc0lUQ3QrdXlpTzJZdU91S2xDRHNsWVRybnBnZzdaaVY3SXVkN0p5ODY2R2NJTzJHdGV5ZHZPMlZ0T3lFbkNEc2phanNtcFF1RFFvTkNpTWpJeURyZ3FEc3A1ekN0K3lMbk9xd2hNSzM2cml3NnJDRURRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnNjRLZzdLZWNJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1RVMHVSRVJnSUh3Z01qQXlOUzR3TVM0d01Td2dNalV1TURFdU1ERWdmQTBLZkNEc2k1enFzSVFnZkNEcXVMRHJzN2dnWUVoSU9rMU5PbE5UWUNBdklPeW5wK3F5akNCZ1NFZzZUVTFnSUNqc21LVHNvSVF2N0ppazdadUVJT3lWaUNEc2xJQXBJSHdnTVRRNk16QTZNVEVzSURFek9qTXdJSHdOQ253ZzZyaXc2ckNFSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRWZsbFpXVmt1VFUwdVJFUmdJQzhnN0tlbjZyS01JR0JaV1ZsWkxrMU5Ma1JFZmsxTkxrUkVZQ0I4SURJd01qVXVNREV1TURGK01qQXlOUzR3TVM0ek1Td2dNakF5TlM0d01TNHdNWDR3TVM0ek1TQjhEUXA4SU91Q29PeW5uQ0FySU95TG5PcXdoQ0I4SUdCWldWbFpMazFOTGtSRUlFaElPazFOWUNCOElESXdNalV1TURFdU1ERWdNVFE2TXpBZ2ZBMEtmQ0RzbXBUc25id2dmQ0JnV1ZsWldTNU5UUzVFUkNqc21wVHNuYndwWUNEaWdKUWc3SnVVTCsyWmxDL3NpSmd2NjZxcEwrcTRpQy90aHFBdjdKMjhJSHdnTWpBeU5TNHdNUzR3TVNqc2lKZ3BJSHdOQ2cwS0tpcnNpNXpxc0lRZzdKaUk3Sm00S2lvNklPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDQmc3SmlrN0tDRUwreVlwTzJiaENCSU9rMU5ZT3lkaENEc2phanJqNFFnNjQrODdKcVVMZzBLN0ppSUtTRHNtS1R0bTRRZ01Ub3dNQTBLRFFvakl5TWc2Nnk0N0o2bElPeUdqU0RzbDdEc201VHNuYndOQ2cwSzY2eTQ3SjZsSU95VmlPeVhrT3lFbk91S2xDQXFLdXlibE1LMzdKMjhJT3lWbnV5ZG1DQXc3SjJFSU91NXZPcXpvQ29xSU95TnFPeWFsQzROQ2cwSzdKaUlLUTBLTFNBeU1ESTI2NFdFSURBNDdKdVVJREExN0oyOElPeWVoZXVMaU91THBDNGc0b2FTSURJd01qYnJoWVFnT095YmxDQTE3SjI4SU95ZWhldUxpT3VMcEM0TkNnMEtJeU1qSU95RGdldU1nQ0RzaTV6cXNJUWdLT3VGdU95Mm5PeWFxU2tOQ2cwS2ZDRHNvYkRxc2JRZ2ZDRHRrWnpxdUxBZ2ZBMEtmQzB0TFMwdExYd3RMUzB0TFMxOERRcDhJRFl3N0xTSUlPdXZ1T3VuakNCOElPdXdxZXE0aUNEc29JUWdmQTBLZkNBMk1PdTJoQ0RycjdqcnA0d2dmQ0JPNjdhRUlPeWdoQ0I4RFFwOElESTA3SXVjNnJDRUlPdXZ1T3VuakNCOElFN3NpNXpxc0lRZzdLQ0VJSHdOQ253Z016RHNuYndnNjYrNDY2ZU1JSHdnVHV5ZHZDRHNvSVFnZkEwS2ZDQXhNdXF3bk95YmxDRHJyN2pycDR3Z2ZDQk82ckNjN0p1VUlPeWdoQ0I4RFFwOElERXk2ckNjN0p1VUlPeWR0T3lEZ1NCOElFN3JoWVFnN0tDRUlId05DZzBLN0ppSUtTRHJzS25xdUlnZzdLQ0VMQ0ExNjdhRUlPeWdoQ3dnTXV5TG5PcXdoQ0Rzb0lRc0lEUHNuYndnN0tDRUxDQTI2ckNjN0p1VUlPeWdoQ3dnTXV1RmhDRHNvSVFOQ2cwS0l5TWpJT3VuaU9xd2tNSzM2cml3NnJDRUlPdW5qT3VqakEwS0RRcGdSQzFPWUNoTzdKMjhJT3VDcU95ZGpDa2dMeUJnUkMwd1lDanNtS1RyaXBnZzY2ZUk2ckNRS1NBdklHQkVLMDVnS0U3c25id2c2cks5NnJPOEtRMEs3SmlJS1NCRUxUY3NJRVF0TVN3Z1JDMHdMQ0JFS3pFTkNnMEtJeU1qSU91eWlPMll1Q0R0a1p6cXVMQWdLTzJWbU95ZHRPMlVpT3ljdk91aG5DRHF0YXpydG9RcERRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnN0tDRTdabVU2N0tJN1ppNElId2c3WldZN0oyMDdaU0lJT3Exck91MmhDQjhJREF5TFRFeU16UXROVFkzT0N3Z01ERXdMVEV5TXpRdE5UWTNPQ0I4RFFwOElPeTV0T3VUbk91eWlPMll1Q0I4SURUc25wRHJwcXpzbEtrZzdaV1k3SjIwN1pTSUlId2dNVEl6TkMwMU5qYzRMVGt3TVRJdE16UTFOaUI4RFFwOElPcXpoT3lpak91eWlPMll1Q0I4SU8yVm1PeWR0TzJVaUNEcXRhenJ0b1FnZkNBeE1qTXRORFUyTFRjNE9UQXhNaUI4RFFwOElPeWp2T3V2dk91VHNldWhuZXV5aU8yWXVDQjhJT3lWbmlBMjdKNlE2NmFzTGV1U3BDQTM3SjZRNjZhc0lId2dNVEl6TkRVMkxURXlNelExTmpjZ2ZBMEtmQ0RzZ3F6c2w0WHNucERyazdIcm9aM3Jzb2p0bUxnZ2ZDQXhNT3lla091bXJDRHRsWmpzbmJUdGxJZ2dmQ0F3TVMweU16UXROVFkzT0RrZ2ZBMEtEUW9qSXlNZzdKT3c2Nm0wSU95VmlDRHJrSmpyaXBRZzdaR2M2cml3RFFvTkNpMGc2NEtnN0tlYzdKZVFJTzJWbU95ZHRPMlVpTUszNjdtWDZyaUlPaURpbll3Z01qQXlOUzB3TVMwd01Td2dNREV2TURFTkNpMGc3SXVjNnJDRTdKZVFJT3lZcE95Z2hDL3NtS1R0bTRRNklPS2RqQ0RzbUtUc29JUWdNZXlMbkNBcUtPdUxxQ3dnN0lLczdKcXA3SjZRNnJDQUlPeW5nZXlna1NEcXM2RHJwYlRyaXBRZzY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSU95WWlPeVp1Q2txRFFvTkNpb3FLZzBLRFFvakl5QTRMaUR0akozc2w0VW82NHVrN0oyMDdKYTg2NkdjNnJlNEtRMEtEUXJ0akozc2w0VWc2Nnk0NnJXczY0cVVJQ29xN0pldDdaV2dLaW9vN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2Q25xczd3Z0tpcnNuS0R0bUpVcUtpanRoclhyczdRdjdZeVE2NHVvS2V5WGtDRHJsTERybmJ3ZzY2eTQ3TEswNnJDQUlPdUxyT3Vkdk95YWxDNGc3WU9BN0oyMDdZdUE3SjJFSU91THBPdVRyT3lkaENEcmxaQWc2N0NZNjVPYzdJdWNJT3lWaU91Q3RDanJzN2pyckxncDZybU03S2VBSU9xd21leWR0Q0RyczdUcXM2QXNJT3V6dU91c3VDRHJwNlhybmIzc25ZUWc2NHUwN0pXRTdKVzhJTzJWdE95YWxDNE5DZzBLSXlNaklERHJpNmpxczRRZzRvQ1VJTzJLdU91bXJPcXhzT3UyZ08yRXNDRHJ0SkRzbXBRTkNnMEs3WXlkN0plRjdKMjBJT3lDck95YXFleWVrT3lkbUNEc2xyVHJscVFnN1phSjY0K1pJT3VTcE95WGtDRHJuS2pyaXBUc3A0QWc2Nmk4N0tDQUlPMk1qT3lWaGUyVnRPeWFsQzROQ2cwS0xTRHRsb25yajVuc25ZUWdLaXJxc0lEcm9aenJwNG5xc2JEcmdwZ2c3WXlRNjR1bzdKMkVJT3lhbE9xMXJDb3FLT3lkdE8yRGlNSzM3SUt0N0tDY3dyZnJvWnpxdDdqc2xZVHNtNFBDdCt5aWhldWpqQ2tnNG9hU0lDb3E3WXlRNjR1bzdaaVZLaW9nS091c3ZPeVd0T3Uwa095YWxDa05DaTBnNnJLdzZyTzh3cmZzZzRIdGc1enJwYndnS2lydGhyWHJzN1RycDR3cUtpQW83Sm1FNjZPTXdyZnNpNlR0aktncElPS0draUFxS3V5VmlPdUN0TzJZbFNvcUlDanNsWXpyb0tUc3BKanNtcFFwRFFvTkNpTWpJeUR0ZzREc25iVHRpNEFnNG9DVUlPeW5wK3lkZ0NEcnFvWHNncXpxdGF3TkNnMEtMU0RycW9Yc2dxenRtSlhzbkx6cm9ad2c2NEdkNjRLMDdKcVVMaURzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5PdWx2Q0RzazdEc3A0QWc3SldLN0pXRTdKcVVJQ2grN0pxVUlDOGdmdXVMcENBdklIN3F1WXpzbXBRL0lPS2RqQ2t1RFFvdElESitOT3lXdE95Z2lPdWhuQ0RzcDZmcXM2QWc3SW05NnJLTUxpRHRsWnpzbnBEc2xyVEN0K3lJbU95TG5leWRoQ0RxdUxqcXNvd2c3SXlUN0tlQUlPeVZpdXlWaE95YWxDNE5DaTBnN0pXSTY0SzBLT3V6dU91c3VDa2c2NmVsNjUyOTdKMkVJT3lhbE95VnZlMlZ0Q3dnS2lydGc0RHNuYlR0aTREcnA0d2c2N1NRNjQrRUlPdXN0T3lLcUNEdGpKM3NsNFhzbmJqc3A0QXFLaURzbFl6cXNvd2c3WlcwN0pxVUxpRHNtNURyczdqc25iUWdKK3lWak91bXZNSzM3Wm1WN0oyNEoreXltT3VmdkNEcnA0bnNsN0R0bFpqcnFiUWc2N080NjZ5NDdKMkVJT3Ezdk9xeHNPdWhuQ0RxdGF6c3NyVHRtWlR0bGJUc21wUXVEUW9OQ253ZzdKMjA2NkNINnJLTUlPdW5rT3F6b0NCOElPeWR0T3VnaCtxeWpDQjhEUXA4TFMwdGZDMHRMWHdOQ253ZzdLQ0E3SjZsN1pXWTdLZUFJT3lWaXVxem9DRHJncGpxc0lEc2k1enFzcURzbHJUc21wUS9JSHdnN0tDQTdKNmxJT3lWaUNEdGxad2c2NEswN0pxcElId05DbndnN0pXTTY2YThJSHdnNnJLdzdLQ2NJT3laaE91ampDQjhEUXA4SU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JSHdnNjQydzdKMjA3WVN3SU95Q3JleWduQ0I4RFFvTkNpTWpJeURzbFlqcmdyUW82N080NjZ5NEtTRGlnSlFnN1pXMDdKcVU3TEswRFFvTkNpMGdLaXJ0akpEcmk2anRtSlVxS3V5ZGdDQW5mdTJWb09xNWpPeWFsRDhuNjZHY0lPdXN2T3lXdE95YWxDNGc2NUNZNjQrTTY2YTBJT3lJbUNEc2w0YnJpcFFnN0p5RTdaZVlLT3lDcmV5Z25NSzM3WU9JN1llMElPdVRzU25zbllBZzZyS3c2ck84NjZXOElPdW92T3lnZ0NEcXNyM3FzNkR0bGJUc21wUXVEUW90SUNvcTdKV0k2NEswN1ppVktpcnNuWUFnN0lLczdJdWs3SjJFSU95RW5PeUlvTzJWdE95YWxDNE5DaTBnNjZlSTdMbW83WkdjNjZXOElPeU5xT3lhbEM0ZzdJaXI3SjZRd3Jmc29iRHFzYlFvN0oyMDdJT0J3cmZzbmJUdGxaakN0K3lkdE91Q3RDRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWkRxczZBc0lPeWJrT3VzdU95WGtDRHNsNGJyaXBRZzdLQ1Y2N08wd3Jmc29JanNzS2pDdCt5WHNPdWR2ZXl5bU91bHZDRHNwNERzbHJUcmdyVHNwNEFnN0pXSzdKV0U3SnFVTGcwS0RRb2pJeU1nNjdLRTdZcThJT0tBbENEc2xZanJnclFnNjZ5NDY2ZWw3SjIwSU95Z2xlMlZ0T3lhbEEwS0RRcDhJT3V6dU91c3VPeWR0Q0RzbmJUcm9JZnJpNlFnZkNEcnNvVHRpcndnZkEwS2ZDMHRMWHd0TFMxOERRcDhJT3F5c09xenZNSzM3SU9CN1lPYzY2VzhJTzJHdGV1enRDQjhJRnZ0bVpYc25iaGRJSHdOQ253Z0ozN3RsYURxdVl6c21wUS9KK3VobkNEcnJMenNuWXdnZkNCYjdKV0U2NHVJN0ppa1hTREN0eUJiNjRTa1hTQjhEUXA4SU95RGdlMlpxU0RzaEp6c2lLQWdLeURzbUtUcnBianNxcjNzbmJRZzdJdWs3S0NjSU91UG1leWVrU0I4SUZ2c3Q2anNob3hkSU1LM0lGdDc2NCtaN0o2UmZWMGdmQTBLRFFvdElDZnN0NmpzaG93bjY0cVVJQ29xNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUtpb2c3STJvN0pxVUlDanNtSWc2SUZ2c3Q2anNob3hkd3JkYjdJS3Q3S0NjWFNrdUlDZnJpNnZxdUxBZ3dyY2c2NCtaN0o2UkoreXltT3VmdkNEc3A1M3NuYlFnN0pXSUlPdW5udXVLbENEc29iRHRsYW5zbmJUcmdwZ2c2NHVvNjQrRklDZnN0NmpzaG93bjY0cVVJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW90SU91eWhPMkt2T3lkbUNEcmo1bnNucEVnN0oyMDY2YUU3SjJBSU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGhDRHF0N2pyaklEcm9ad2c3SUswNjZDazdKcVVMZzBLRFFvakl5TWc3WWExN0tlY0lPeVlpT3lMbkEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdKMjA3WU9JS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURzb0lEc25xVWc3SldJSU8yVm5DRHJnclRzbXFrTkNpMGc3SldJNjRLME9pRHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4ZzdKNkY2NkNsN1pXY0lPdUN0T3lhcWV5ZHRDRHNncXpybmJ6c29ManNtcFF1RFFvdElPdXloTzJLdkRvZzdKV0U2NHVJN0ppa0lNSzNJT3VFcEEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdJS3Q3S0NjSUNqc25JVHRsNWdwS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURyamJEc25iVHRoTEFnN0lLdDdLQ2NEUW90SU95VmlPdUN0RG9nN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEc2dyVHJwclFnN0lpWUlPeVhodXlXdE95YWxDNGc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3MEtMU0Ryc29UdGlydzZJT3lWaE91TGlPeVlwQ0RDdHlEcmhLUU5DZzBLS2lycmo1bnNucEh0bUpVZzRvQ1VJT3lFbk95SW9DQXJJT3VQbWV5ZWtTRHJzb1R0aXJ3cUtnMEtMU0R0ZzREc25iVHRpNEE2SU9xNHNPcTRzQ0RzbDdEcXNyQWc3WlcwN0tDY0RRb3RJT3lWaU91Q3REb2c3SVNnN1lPZDdaV2NJT3E0c09xNHNPeWRtQ0RzbDdEcXNyRHNuWVFnNjRHSzdKYTA3SnFVTGcwS0xTRHJzb1R0aXJ3NklPeTNxT3lHakNEQ3R5RHNsN0Rxc3JBZzdaVzA3S0NjRFFvTkNpb3E3SldJNjRLMDdaaVZJT0tBbENEc21ZVHJvNHdnN1lhMTY3TzBLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHFzckRzb0p3ZzdKbUU2Nk9NRFFvdElPeVZpT3VDdERvZzZyS3c3S0NjNnJDQUlPeWdsZXlEZ1NEc3NwanJwcXpya0pEc2xyVHNtcFF1RFFvdElPdXloTzJLdkRvZzdabVY3SjI0RFFvTkNpb3FLZzBLRFFvaklPeVlpT3ladUNEcXQ1enN1WmtOQ2cwSzdKdVE3TG1aS091S3BldVBtY0szNnJpTjdLQ1Z3cmZzdXBEc283enNscndwNjdPMDY0dWtJT3lZaU95WnVPcXdnQ0RyalpRZzY2cUY3Wm1WN1pXY0lPeTdwT3V1cE91TGlPeThnT3lkdE95Rm1PeWRoQ0RycDR6cms1enJpcFFnNnJLOTdKcXc3SmlJN0pxVUxnMEtEUW9qSXlEc21JanNtYmdnTVM0ZzdJaVk2NCtaN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzY1Q1k2NHFVSU9xeXZleWFzQTBLRFFvakl5TWc3SVNjNjdtRTdJcWtJT3lpaGV1ampDd2c2cml3NnJDRUlPdW5qT3VqakEwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95anZPeVd0Q2pzb29Ycm80d2c3SVNjNjdtRTdJcWtMQ0RxdUxEcXNJUWc2NU94S2V1bHZDRHFzSlhzb2JEdGxhQWc3SWlZSU95ZWlPcXpvQ3dnSit5aWhldWpqQ2ZzbVlBZ0ordW5qT3VqakNmc25aZ2c2NG1ZN0pXWjdJcWs2Nlc4SU95Z2xlMlpsZTJlaUNEc29JVHJpNnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNCUFQwOGc3SVNjNjdtRTdJcWtJT3lpaGV1ampDRHNsWWpyZ3JRZzRvQ1VJREF3N0p1VUlEQXc3SjI4NjdhQTdZU3dJT3lFbk91NWhPeUtwT3F3Z0NEc29vWHJvNHpyajd6c21wUXVJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWVFnN0pXTTY2Q2s2NU9jNjZDazdKcVVMZzBLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZzBLRFFycmk2Z3NJQ29xN0tPODZyaXc3S0NCN0p5ODY2R2NJT3lpaGV1ampPcXdnQ0Ryc0pqcnM3WHJrSmpyaXBRZzdLQ2M3WktJS2lyc2w1RHJpcFFnSit5aWhldWpqT3VQdk95YWxDZnJwYndnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURzb29Ycm80enJqN3pzbXBRZzRvYVNJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxBMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKZVE2cktNSU91dnVPeTVtT3VLbENEc21JSHRscVhzbllRZzdKV002NkNrN0tTRUlPdVZqQTBLRFFvbzdLTzg3SnFVSU91UG1leUNyQ0E2SU95WHNPeXl0Q3dnN1pXMDdLZUFMQ0Rzb0lIc21xa2c2NU94S1EwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95ZHVPcXp2Q0RxdElEcXM0VHJwYndnNjZxRjdabVY3WldZNnJLTUlPeUVwT3VxaGUyVm1PcXpvQ3dnSit5Q3JPeWFxZXlla095ZG1DRHRsb25yajVuc2w1QWc2NVN3NjUyODdKaWs2NHFVSU9xeXNPcXp2Q2ZybmJ6cmlwUWc3S0NRN0oyRUlPeVZqT3VncE95a2hDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeVlwT3VLbU9xNWpPeW5nQ0RyZ3JUc3A0QWc3SldLN0p5ODY2bTBJT3lYc095eXRPdVB2T3lhbEM0ZzdadUU2N2FJNnJLdzdLQ2NJT3E0aU95Vm9leWRoQ0RyZ3JUc283enNoTGpzbXBRdURRb3RJT3VNZ095Mm5PeWRoQ0Rxc0lqc2xZVHRnNERycWJRZzdKdVE2NTZZSU91TWdPeTJuT3lkdENEdGxiVHNwNERyajd6c21wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXaWV5WGtDRHJnclRzbGJ3ZzdaVzA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95VmlPeUxyQ0FvN0lpWTY0K1o3WmlWS1EwS0RRb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3SXVjN0lxazdZV2M3SjIwSU95ZWtPdVBtZXljdk91aG5DRHNzcGpycHF6dGxaenJpNlRyaXBRZzdLQ1FLaXJzbllRZzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95ZHRPeWduT3UyZ08yRXNDRHRtWTNxdUxqcmo1bnJpNWpzblpnZzZyQ2M3SjI0N0tDVjY3TzBJT3lkdE95YXFTRHJnclRzbDYzc25iUWc2cml3NjZHZDY0Kzg3SnFVRFFvdElPdU5sQ0Rzb292c25ZQWc3SU9CNjR1MDdKMkVJT3ljaE8yVnRDRHRoclh0bVpRZzY0SzA3SnFwN0oyQUlPdUZ1ZXlkak91UHZPeWFsQTBLRFFvakl5RHNtSWpzbWJnZ01pNGc2cks5N0phMDY2VzhJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3RFFvTkN1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKMllJT3VucGV1ZHZleWRoQ0R0bVp6c21xbnRsYlRzaEp3ZzdLZUk2Nnk0N1pXZ0lPdVZqQTBLRFFvbjdJdWM2NEtZN0pxVVB5Y3NJQ2ZzaGFqcmdwanNtcFEvSnlEdG1KWHRnNXpzblpnZzZySzk3SmEwNjZXOElPMlpuT3lhcWUyVnRPeUVuQ0RzZ3F6c21xbnNucERzblpnZzY0dTU3Wm1wN0lxazY1K3M3SnVBN0oyRUlPeWtoT3lkdkNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1Dd2dUMDlQSU91THBPdUZnT3lZcE95RnFPdUNtT3lhbEQ4TkNpMGc3TGFwN0tDRTdaV1k2NStzSU8yT3VPeWRtT3lna0NEcXNJRHNpNXpyZ3Bqc21wUS9EUW9OQ2lNakl5RHNncXpzbXFuc25wRHNuWmdnN0lPQjdabXA3SjJFSU95MmxPeWdsZTJWb0NEcmxZd05DZzBLNjZxRjdabVY3WldjSU95Z2xldXp0T3F3Z0NEc2w0YnNsclRzaEp3ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU95bmdleWdrU0R0akpEcmk2anRsWmpxc293ZzdaVzA3Slc4SU8yVm9DRHJsWXdnNnJLOTdKYTA2NkdjSU95Z2xleWtrZTJWbU9xeWpDRHNwNGpyckxqdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHN1YlRyazV6cnBid2c2N0NiN0p5ODdJV282NEtZN0pxVVB5RHJrN0hyb1ozdGxaanJxYlFnN0xxUTdJdWM2N0N4SU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtPeWRtQ0RzaEtEc25aanFzSUFnN1pXRTdKcVU3WldnSU91VmpBMEtEUXJzaEtUcnJManNvYkRzZ3F6c3NwanJuN3dnN0lLczdKcXA3SjZRN0oyWUlPeUVvT3lkbU91bHZDRHF1TERyaklEdGxiVHNsYndnN1pXZ0lPdVZqQ0Rxc3Izc2xyVHJvWndnN0tDVjdLU1I3WldZNnJLTUlPeW5pT3VzdU8yVnRPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25iVHJzb2dnNjR1czdKZVFJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bFpqcnFiVHNoSndnN0phODY2ZUk2NEtZSU91bmpPeWhzZTJWbU95RnFPdUNtT3lhbEQ4TkNnMEtJeU1nN0ppSTdKbTRJRE11SU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU91UW1PdUtsQ0Rxc3Izc21yQU5DZzBLN0lLczdKcXA3SjZRN0plUTZyS01JT3VxaGUyWmxlMlZtT3F5akNEcnRvRHNvSlhzb0lIc25iZ2c2NEswN0pxcDdKMkVJT3lWak91Z3BPeWttT3lWdkNEdGxhQWc2NVdNNjRxVUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPeWlpK3lWaE95YWxDNE5DZzBLSXlNaklPeUVuT3U1aE95S3BPdWx2Q0Rzb0pYc3NZWHNnNEVnN0pPNElPeUltQ0RzbDRic25ZUWc2NVdNRFFvTkN1dTJnT3lnbGUyWWxleWN2T3VobkNEc2phanNsYndnN0lLczdKcXA3SjZRN0plUTZyS01JT3lEZ2UyWnFleWRoQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN0l1YzdZS3NJT3lJbUNEc25vanNsclRzbXBRdUlDb3E3Sk80SU95SW1DRHNsNGJyaXBRZzdKMjA3SnlnNjZXOElPMlZxT3E3bUNEc2xZanJnclR0bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RzcDREcXVJanNuWUFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJT3l5cmV5R2pPdUZoT3lkaENEc25JVHRsWndnN0lTYzY3bUU3SXFrNjRxVUlPeVZoT3luZ1NEc3BJRHJ1WVFnN0tTUjdKMjA3SmVRN0pxVUxnMEtMU0RxczdYcnJMVHNtNURzbllBZzdadUU3SnVRNnJpSTdKMkVJT3V6dE91Q3ZDRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzY3YUE3S0NWN1ppVjdKeTg2NkdjSU95TnFPeVZ2Q0RzZ3F6c21xbnNucERxc0lBZzdKYTA2NWFrSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95WGh1dUtsT3luZ0NEcnFvWHRtWlh0bFpqcXNvd2c3SjI0N0tlQTdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrTkNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGcwS0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UUlPeUVvTzJEbmV5ZG1DRHFzckRxczd6cnBid2c3SldJNjRLMDdaV2dJT3VWakEwS0RRcnJrSmpyajR6cnByUWc3SWlZSU95WGh1dUtsQ0RzaEtEdGc1M3NuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMlZtT3F5akNEc2xZenJvS1RzbXBRdURRb05DdXlZaUNrTkNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrTkNnMEtKK3lnbGV1enRDRHNpSmpzcDVFZzdKV0k2NEswSnlEcms3SHNuWmdnNjYrODZyQ1E3WldjSU95RGdlMlpxZXlYa095RW5DQXFLdXlnbGV1enRPcXdnQ0RyczdUdG1ManJrSnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeURnZXVMdE95ZHRDRHJnWjNyZ3BqcnFiUWc3S0NFNjZ5NDZyQ0E2NCtFSU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHJwYndnNjdPOElPeUltQ0RzbDRic2xyVHNtcFF1RFFvdElPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1Rxc0lBZzZyaXc2NkdkNjVDWTdLZUFJT3lWaXV5VmhPeWFsQzROQ2cwS0l5TWc3SmlJN0ptNElEUXVJT3lnbk8yU2lDRHNtcW5zbHJUcmlwUWc2N0NVNnI2NDdLZUFJT3lWaXVxNHNBMEtEUW9uNnJDRTZyS3c3WldZNnJPZ0lPeUpyT3lhdENEcnA1QW5JT3lia095NW1ldXp0T3VMcENBcUt1MlpsT3VwdE95ZG1DRHF1TERyaXFYcnFvWEN0K3V5aE8yS3ZPdXFoZXF6dk95ZG1DRHNtcW5zbHJRZzdKMjg3TG1ZS2lycXNJQWc3SnF3N0lTZzdKMjA3SmVRN0pxVUxnMEs2cml3NjRxbDY2cUY3SmVRSU95VHNPeWR1Q0RyaTZqc2xyUW82N09BNnJLOUxDRHNwNERzb0pVc0lPdVRzZXVoblNEcms3RXA2Nlc4SU95VmlPdUN0Q0RyckxqcXRhenNsNURzaEp3ZzY0dWs2Nlc0SU91bmtPdWhuQ0Ryc0pUcXZyanJxYlFnN0lLczdKcXA3SjZRNnJDQUlPdUxwT3VsdUNEcXVMRHJpcVhzbkx6cm9ad2c3SmlrN1pXMDdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrZ0orcTJqTzJWbkNEcnM0RHFzcjBuSU9xNHNPdUtwZXlkbUNEc2xZanJnclFnNjZ5NDZyV3NEUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxaanJxYlFnNjdDVTZyK0FJT3lJbUNEc25vanNsclRzbXBRZ0tGZ3BEUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxaanJxYlFnNjdPQTZySzk3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJT3lZaU95WnVDQTFMaURzaTV6c2lxVHRoWndnNjQrWjdKNlI2ck84SU91THBPdWx1Q0RyajVuc2dxd2c3Sk93N0tlQUlPeVZpdXE0c0EwS0RRcnJyTGpxdGF6cnBid2c3SldFNjZ5MDY2YXNJT3VucE91QmhPdWZ2ZXF5akNEcmk2VHJrNnpzbHJUcmo0UWdLaXJzaTZUc29Kd2c3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyaTZUcnBiZ2c2NCtaN0lLc0tpcnJwYndnN0pPdzY2bTBJT3llbU91cXUrdVFuQ0RyckxqcXRhenNtSWpzbXBRdURRb05DdXlZaUNrZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWx2Q0FuN0xhVTZyQ0FJT3luZ095Z2xTZnRsWmpyaXBRZzdJdWM3SXFrN1lXYzdKZVE3SVNjSUNqc25iVHNvSVRDdCt5V2tldVBoQ0RxdUxEcmlxWHNuYlFnN0pXRTY0dVlLUTBLTFNEcmk2VHJwYmdnN0lLczY1Nk03SmVRNnJLTUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJwYndnNjRTWTZyS283S084N0lTNDdKcVVJQ2hZSU9LQWxDRHNsNGJyaXBRZ0ordUVtT3E0c09xNHNDY2c2cml3NjRxbDdKMkVJT3lWbE95TG5Da05DaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVnRDRHNvN3pzaExqc21wUWdLRThwRFFvPScKRElSPSIkSE9NRS9MaWJyYXJ5L0FwcGxpY2F0aW9uIFN1cHBvcnQvQ2xhdWRlQnJpZGdlIgpwdXQoKSB7IHByaW50ZiAlcyAiJDEiIHwgYmFzZTY0IC1EID4gIiQyIjsgfQojIOydtCAuY29tbWFuZOqwgCDrj4TripQg7YSw66+464SQIOywveunjCDqs6jrnbwg64ur64qU64ukKHR0eSDrp6Tsua0pLiBiYXNo6rCAIOuBneuCmCDtg63snbQgaWRsZeuQnCAx7LSIIOuSpOyXkCDri6vslYQKIyAi7ZSE66Gc7IS47IqkIOyLpO2WiSDspJEiIOqyveqzoOulvCDtlLztlZzri6Qg4oCUIGRpc293buycvOuhnCDsiqTtgazrpr3tirjqsIAgZXhpdO2VtOuPhCDri6vquLAg7J6R7JeF7J2AIOyCtOyVhOuCqOuKlOuLpC4gKOunpSDsi6TquLAg6rKA7KadIO2VhOyalCkKTVlUVFk9IiQocHMgLW8gdHR5PSAtcCAkJCAyPi9kZXYvbnVsbCB8IHRyIC1kICIgIikiCmNsb3NlX3Rlcm1pbmFsKCkgewogIFsgLXogIiRNWVRUWSIgXSAmJiByZXR1cm4KICAoIHNsZWVwIDEKICAgIC91c3IvYmluL29zYXNjcmlwdCA+L2Rldi9udWxsIDI+JjEgPDxPU0EKdGVsbCBhcHBsaWNhdGlvbiAiVGVybWluYWwiCiAgcmVwZWF0IHdpdGggdyBpbiB3aW5kb3dzCiAgICB0cnkKICAgICAgcmVwZWF0IHdpdGggdCBpbiB0YWJzIG9mIHcKICAgICAgICBpZiB0dHkgb2YgdCBpcyAiL2Rldi8kTVlUVFkiIHRoZW4gY2xvc2UgdyBzYXZpbmcgbm8KICAgICAgZW5kIHJlcGVhdAogICAgZW5kIHRyeQogIGVuZCByZXBlYXQKZW5kIHRlbGwKT1NBCiAgKSAmIGRpc293biAyPi9kZXYvbnVsbCB8fCB0cnVlCn0KIyDslYjrgrTripQg7ZSM65+s6re47J247J20IOuztOyXrOykgOuLpCDigJQg7YSw66+464SQ7J2AIOyEpOy5mMK37KCQ6rKA66eMIO2VmOqzoCDsiqTsiqTroZwg64ur7Z6M64ukLgpmaW5pc2goKSB7IGNsb3NlX3Rlcm1pbmFsOyBleGl0ICIkMSI7IH0KZWNobyAi7YG066Gc65OcIOy7pOuEpe2EsOulvCDshKTsuZjtlZjqs6Ag7J6I7Ja07JqU4oCmIOyeoOyLnCDtm4Qg7J20IOywveydgCDsnpDrj5nsnLzroZwg64ur7ZiA7JqULiIKbWtkaXIgLXAgIiRESVIvc2NyaXB0cyIgfHwgeyBlY2hvICLtj7TrjZQg7IOd7ISxIOyLpO2MqDogJERJUiI7IGZpbmlzaCAxOyB9CnB1dCAiJEI2NF9CUklER0UiICAgIiRESVIvc2NyaXB0cy9jbGF1ZGUtYnJpZGdlLmpzIgpwdXQgIiRCNjRfV0FUQ0hFUiIgICIkRElSL3NjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanMiCnB1dCAiJEI2NF9FWEFNUExFUyIgIiRESVIvcmVjb21tZW5kLWV4YW1wbGVzLm1kIgpwdXQgIiRCNjRfR1VJREUiICAgICIkRElSL3V4LXdyaXRpbmcubWQiCmVjaG8gIuKchSDtjIzsnbwg7ISk7LmYOiAkRElSIgojIEdVSeyXkOyEnCDsl7AgVGVybWluYWzsnYAgUEFUSOqwgCDsooHsnYQg7IiYIOyeiOyWtCDtnZTtlZwg7ISk7LmYIOqyveuhnOulvCDrs7Ttg6Dri6QKZXhwb3J0IFBBVEg9IiRIT01FLy5sb2NhbC9iaW46L29wdC9ob21lYnJldy9iaW46L3Vzci9sb2NhbC9iaW46JFBBVEgiCiMgbm9kZeqwgCDsl4bsnLzrqbQg6rCQ7Iuc7J6QKD1ub2RlKSDsnpDssrTqsIAg66q7IOuPjOyVhCDtlIzrn6zqt7jsnbjsl5Ag7JWM66a0IOuwqeuyleydtCDsl4bri6Qg4oaSIOydtCDqsr3smrDrp4wg64Sk7J207Yuw67iMIO2MneyXheycvOuhnCDslYjrgrTtlZzri6QKaWYgISBjb21tYW5kIC12IG5vZGUgPi9kZXYvbnVsbCAyPiYxOyB0aGVuCiAgb3Nhc2NyaXB0IC1lICdkaXNwbGF5IGRpYWxvZyAi7J20IE1hY+yXkCBOb2RlLmpz6rCAIOyXhuyWtOyalC4gW+2ZleyduF3snYQg64iE66W066m0IOuLpOyatOuhnOuTnCDtjpjsnbTsp4DqsIAg7Je066Ck7JqULiBOb2RlLmpzKExUUynrpbwg7ISk7LmY7ZWcIOuSpCDsnbQg7ISk7LmYIO2MjOydvOydhCDri6Tsi5wg7Iuk7ZaJ7ZW0IOyjvOyEuOyalC4iIHdpdGggdGl0bGUgIu2BtOuhnOuTnCDsu6TrhKXthLAg4oCUIE5vZGUuanMg7ZWE7JqUIiBidXR0b25zIHsi7ZmV7J24In0gZGVmYXVsdCBidXR0b24gMSB3aXRoIGljb24gY2F1dGlvbiBnaXZpbmcgdXAgYWZ0ZXIgMTgwJyA+L2Rldi9udWxsIDI+JjEKICBvcGVuICJodHRwczovL25vZGVqcy5vcmcva28vZG93bmxvYWQiIDI+L2Rldi9udWxsCiAgZmluaXNoIDAKZmkKTk9ERV9CSU49IiQoY29tbWFuZCAtdiBub2RlKSIKZWNobyAi4pyFIE5vZGUuanM6ICQobm9kZSAtLXZlcnNpb24pIgojIOqwkOyLnOyekCBsYXVuY2hkIOuTseuhnSAo66Gc6re47J24IOyekOuPmeyLnOyekSArIOyngOq4iCDquLDrj5kpLiBQQVRI66W8IHBsaXN07JeQIOq1s+2YgCDrhKPripTri6Qg4oCUIGxhdW5jaGQg6riw67O4IFBBVEjsl5QgY2xhdWRl6rCAIOyXhuuLpC4KUExJU1Q9IiRIT01FL0xpYnJhcnkvTGF1bmNoQWdlbnRzL2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlci5wbGlzdCIKbWtkaXIgLXAgIiRIT01FL0xpYnJhcnkvTGF1bmNoQWdlbnRzIgpTQUZFX1BBVEg9IiR7UEFUSC8vJi8mYW1wO30iCmNhdCA+ICIkUExJU1QiIDw8UExJU1RFT0YKPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPCFET0NUWVBFIHBsaXN0IFBVQkxJQyAiLS8vQXBwbGUvL0RURCBQTElTVCAxLjAvL0VOIiAiaHR0cDovL3d3dy5hcHBsZS5jb20vRFREcy9Qcm9wZXJ0eUxpc3QtMS4wLmR0ZCI+CjxwbGlzdCB2ZXJzaW9uPSIxLjAiPgo8ZGljdD4KICA8a2V5PkxhYmVsPC9rZXk+PHN0cmluZz5jb20uY2xhdWRlYnJpZGdlLndhdGNoZXI8L3N0cmluZz4KICA8a2V5PlByb2dyYW1Bcmd1bWVudHM8L2tleT4KICA8YXJyYXk+CiAgICA8c3RyaW5nPiROT0RFX0JJTjwvc3RyaW5nPgogICAgPHN0cmluZz4kRElSL3NjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanM8L3N0cmluZz4KICA8L2FycmF5PgogIDxrZXk+RW52aXJvbm1lbnRWYXJpYWJsZXM8L2tleT4KICA8ZGljdD48a2V5PlBBVEg8L2tleT48c3RyaW5nPiRTQUZFX1BBVEg8L3N0cmluZz48L2RpY3Q+CiAgPGtleT5SdW5BdExvYWQ8L2tleT48dHJ1ZS8+CiAgPGtleT5LZWVwQWxpdmU8L2tleT48ZGljdD48a2V5PlN1Y2Nlc3NmdWxFeGl0PC9rZXk+PGZhbHNlLz48L2RpY3Q+CjwvZGljdD4KPC9wbGlzdD4KUExJU1RFT0YKbGF1bmNoY3RsIGJvb3RvdXQgImd1aS8kKGlkIC11KS9jb20uY2xhdWRlYnJpZGdlLndhdGNoZXIiIDI+L2Rldi9udWxsCmxhdW5jaGN0bCBib290c3RyYXAgImd1aS8kKGlkIC11KSIgIiRQTElTVCIgMj4vZGV2L251bGwgfHwgbGF1bmNoY3RsIGxvYWQgLXcgIiRQTElTVCIgMj4vZGV2L251bGwKIyBjbGF1ZGUg7Jyg66y0wrfroZzqt7jsnbgg7Jes67aA64qUIOyXrOq4sOyEnCDslYzrpqzsp4Ag7JWK64qU64ukIOKAlCDqsJDsi5zsnpDqsIAg6re4IOyDge2DnOulvCDtlIzrn6zqt7jsnbjsl5Ag7KCE64us7ZW0CiMg6rOE7KCVIO2ZlOuptOydtCAi7ISk7LmYIO2VhOyalCAvIOuhnOq3uOyduCDtlYTsmpQgLyDspIDruYQg7JmE66OMIuuhnCDrhbjstpztlZzri6Qo7YSw66+464SQ7J20IOyxhOuEkOydtCDslYTri5gpLgojIOyEpOy5mMK37KCQ6rKAIOuBnSDihpIg7LC97J2EIOyKpOyKpOuhnCDri6vripTri6QuCmZpbmlzaCAwClBLAQIeAxQAAAgAAAAAAADffkCA61ICAOtSAgAbAAAAAAAAAAAAAADtgQAAAADtgbTroZzrk5wt7Luk64Sl7YSwLmNvbW1hbmRQSwUGAAAAAAEAAQBJAAAAJFMCAAAA";
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
