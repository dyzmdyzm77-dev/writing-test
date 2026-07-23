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
            collectSelectedText().then((t) => {
                figma.ui.postMessage({ type: 'selection-text', text: (t && t.trim()) ? t : '' });
            }).catch(() => { });
        }
        else if (!selection || selection.length === 0) {
            figma.ui.postMessage({ type: 'selection-text', text: '' });
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
    collectSelectedText().then((t) => {
        if (t && t.trim())
            figma.ui.postMessage({ type: 'selection-text', text: t, onEnter: true });
    }).catch(() => { });
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
// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드다리-설치.bat을 base64로 주입) =====
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEcmk2VHJwcXdnN0lTazdMbVlJQ2d4THpJcElPS0FsQ0JPYjJSbExtcHpKeXdnSjA5TFEyRnVZMlZzSnl3Z0oxZGhjbTVwYm1jbktRb2dJQ0FnYVdZZ0tDUnlJQzFsY1NBblQwc25LU0I3SUZOMFlYSjBMVkJ5YjJObGMzTWdKMmgwZEhCek9pOHZibTlrWldwekxtOXlaeTlyYnk5a2IzZHViRzloWkNjZ2ZRb2dJSDBLSUNCbGVHbDBDbjBLYVdZZ0tDMXUNCmIzUWdLRWRsZEMxRGIyMXRZVzVrSUdOc1lYVmtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JDYjNnZ0l1eUVwT3k1bU91S2xDRHJnWjNyZ3F6c2xyVHNtcFF1SU9xM3VPdWZzT3VOc0NCRGJHRjFaR1VnUTI5a1plcXdnQ0RzbDRic2xyVHNtcFFnS091WWtPdUtsQ0JRUVZSSTdKZVFJT3lYaHV5V3RPeWFsQ2t1WUc1Z2J1MkVzT3V2dU91RWtPeVhrT3lFbkNEc2xZVHJucGpycGJ3ZzdJU2s3TG1Zd3Jmcm9aenF0N2pzbmJqdGxad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUTZZRzVnYmlBZ2JuQnRJR2x1YzNSaGJHd2dMV2NnUUdGdWRHaHliM0JwWXkxaGFTOWpiR0YxWkdVdFkyOWtaV0J1SUNCamJHRjFaR1VnYkc5bmFXNWdibUJ1N1ptVjdKMjRPaUR0aExEcnI3anJoSkRzbDVEc2hKd2dZMnhoZFdSbElDMHRkbVZ5YzJsdmJpRHNuYlFnNjdLRTdLQ0U3SjJFSU95Mm5PdWdwZTJWbU91cHRDRHNwSURyDQp1WVFnN0ptRTY2T01MbUJ1S095Q3JPeWFxZXVmaWV5ZGdDRHNuYlFnVUVQc2w1QWc2NkdjNnJlNDdKMjQ2NUNjSU8yQnRPdWhuT3VUbkNEcXRhenJqNFVnN1pXYzY0K0U3SmVRN0lTY0lPeXdxT3F3a091UXFldUxpT3VMcEM0cElpQW43WUcwNjZHYzY1T2NJT3VMcE91bXJDRHNoS1RzdVpnZ0tESXZNaWtnNG9DVUlFTnNZWFZrWlNCRGIyUmxKeUFuVjJGeWJtbHVaeWNLSUNCbGVHbDBDbjBLVTNSaGNuUXRVSEp2WTJWemN5QXRSbWxzWlZCaGRHZ2dKMk50WkM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0p5OWpJRzV2WkdVZ2MyTnlhWEIwYzF4amJHRjFaR1V0WW5KcFpHZGxMbXB6SnlBdFYyOXlhMmx1WjBScGNtVmpkRzl5ZVNBa1pHbHlJQzFYYVc1a2IzZFRkSGxzWlNCSWFXUmtaVzRLUW05NElDTHNoS1RzdVpnZzdKbUU2Nk9NSVNEdGdiVHJvWnpyazV3ZzY0dWs2NmFzNjZXOElPeThzT3lXdE95YWxDNWdibUJ1N0oyMDdLQ2NJTzJVdk9xM3VPdW5pQ0R0bEl6cm42enF0N2pzbmJqc25MenJvWndnNjQrTQ0KN0pXRTZyQ0FJRnZzdHBUc3NwenJzSnZxdUxCZDY2VzhJT3VJaE91bHRPdXB0Q0R0Z2JUcm9aenJrNXpxc0lBZzY0dTE3WlcwN0pxVUxtQnU2NHVrN0oyTTY3YUE3WVN3NjRxVUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHN0cFRzc3B6Q3QrdXlpT3lYclNEdG1aVHJxYlRzbDVBZzY1T2s3SmEwNnJDQTY2bTBJT3lla091UG1leWN2T3VobkNEc3ZKenNwNUhyaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU91THBPdW1yQ0RpZ0pRZzdLU0E2N21FSU95WmhPdWpqQ2NnSjBsdVptOXliV0YwYVc5dUp3PT0NCjo6QlJJREdFOjoNCkx5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDaERiR0YxWkdVZ1FuSnBaR2RsS1NEaWdKUWc3WlM4NnJlNDY2ZUlJTzJVak91ZnJPcTN1T3lkdU9xenZDQkRiR0YxWkdVZ1EyOWtaZXVsdkNEc25vZnJpcFFnNjZHYzdMdXNJT3lMck91MmdPdW1oT3ErdkFvdkx5RGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdJS3M3SnFwNjdLVk9pRHRnYlRyb1p6cms1enJpNlRycHF3dDdMeWM2cml3TG1KaGRDRHJqWlRydUpUdGdiVHJwcTBnS091WWtPdUtsQ0J1Y0cwZ2NuVnVJR0p5YVdSblpTa0tMeThnN0x5YzY1R1E2Nm0wDQpJTzJVak91ZnJPcTN1T3lkdU95ZG1DQmI3TGFVN0xLYzY3Q2I2cml3WGVxd2dDQkhaVzFwYm1rZzdZS2tJT3lYaHV5ZHRPdVBoQ0R0Z2JUcm9aenJrNXpyb1p3Z1FVa2c3TGFVN0xLYzdKMkVJT3V3bSt1S2xPdUxwQzRLTHk4S0x5OGc3SWFONjQrRUlPeUVwT3F6aERvZzdZRzA2NkdjNjVPYzY2VzhJT3lhbE95eXJldW5pT3VMcENEc2c0anJvWndnN0l1YzY0K1o3WldZNjZtMElETXdmalF3N0xTSTZyQ0FJT3EzdU91RHBTRHJncURzbFlUcXNJVHJpNlF1Q2k4dklPS0draURyaTZUcnBxenJwYndnN0x5a0lPdVZqQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1k3SjJFSU8yVm1PdUNtQ0RzbDdUc2xyUWc3SU9CN0l1Y0lPdU1nT3E0c095TG5PMkNwT3F6b0NoemRISmxZVzB0YW5OdmJpRHJqSUR0bVpRZzY2cW82NU9jS1N3S0x5OGdJQ0Rxc0lEc25iVHJrNXdyN0ppSTdJdWNLREV4TWVxeHRDbnJpcFFnN0xLcklPdXBsT3lMbk95bmdPdWhuQ0R0bFp3ZzY3S0k2NmVNSU95ZHZlMmVqT3VMcEM0ZzdKMjA3WnVFSU95YQ0KbE95eXJleWRnQ0RyckxqcXRhenJwNHdnNjdPMDY0SzA2NitBNjZHY0lPdTVvT3VsdE91THBDNEtMeThnN0lTNDdJV1k3SjJBSURNdzY3S0lJT3lUc091cHRDRHNucXpzaTV6c25wSHRsYlFnNjR5QTdabVU2ckNBSU91c3RPMlZuTzJlaUNEcXVManNsclRzcDREcmlwUWc2cktEN0oyRUlPdW5pZXVLbE91THBDNEtMeThLTHk4ZzdLQ0U3S0NjT2lEc25iUWdVRVBzbDVBZ1EyeGhkV1JsSUVOdlpHWHFzSUFnN0lTazdMbVl3cmZyb1p6cXQ3anNuYmpyajd3ZzdKNkk3SjJFSU9xeWd5QW9ZMnhoZFdSbElDMHRkbVZ5YzJsdmJpRHNuTHpyb1p3ZzdabVY3SjI0S1Fvdkx5RHNvN3pzblpnNklPeUNyT3lhcWV1ZmlleWRnQ0Rxc0lIc25wQWc3WUcwNjZHYzY1T2NJT3Exck91UGhTRHRsWnpyajRUc2w1RHNoSndnN0xDbzZyQ1E2NUNjNjR1a0xnb0tZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNLWTI5dWMzUWdabk1nUFNCeVpYRjFhWEpsS0NkbWN5Y3BPd3BqYjI1emRDQnZjeUE5SUhKbGNYVnANCmNtVW9KMjl6SnlrN0NtTnZibk4wSUhCaGRHZ2dQU0J5WlhGMWFYSmxLQ2R3WVhSb0p5azdDbU52Ym5OMElIc2djM0JoZDI0c0lITndZWGR1VTNsdVl5QjlJRDBnY21WeGRXbHlaU2duWTJocGJHUmZjSEp2WTJWemN5Y3BPd29LTHk4ZzdZRzA2NkdjNjVPYzY2VzhJT3U1aUNEdGo3VHJqWlRzbDVEc2hKd2c3SXVrN1phSklPS0FsQ0Rzb0lEc25xWHNob3pzbDVEc2hKd2c3SXVrN1phSjdaV1k2Nm0wSU8yVWhPdWhuT3lnbmUyS3VDRHJwNlhybmIwb1EweEJWVVJGTG0xa0lPdVRzU25zbllRS0x5OGc2NmVrSU8yRXRDRHNwNHJzbHJUc29ManNoSndnTkRYc3RJZ3Y3WVMwNnJtTTdLZUFJT3VLa091Z3BPeW5oT3VMcENBbzY3bUlJTzJQdE91TmxDQXJJT3UyZ09xd2dPcTRzT3VLcFNEc3NLanJpNmpzbmJUcnFiUWdmalBzdElndjdZUzBLUzRLWTI5dWMzUWdSVTFRVkZsZlExZEVJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxamQyUW5LVHNLZEhKNUlIc2dabk11DQpiV3RrYVhKVGVXNWpLRVZOVUZSWlgwTlhSQ3dnZXlCeVpXTjFjbk5wZG1VNklIUnlkV1VnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdXN0T3lMbkNBcUx5QjlDbU52Ym5OMElFTk1RVlZFUlY5RlRsWWdQU0JQWW1wbFkzUXVZWE56YVdkdUtIdDlMQ0J3Y205alpYTnpMbVZ1ZGl3Z2V3b2dJRTFCV0Y5VVNFbE9TMGxPUjE5VVQwdEZUbE02SUNjd0p5d2dJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQzh2SU95RG5lcXdnU0RycXFqcms1d2c2NEdVSUNqc3A2ZnNuWUFnNjZ5NDZyV3M3SmVVSU91MmlPMlZoT3lhbENrS0lDQkRURUZWUkVWZlEwOUVSVjlFU1ZOQlFreEZYMDVQVGtWVFUwVk9WRWxCVEY5VVVrRkdSa2xET2lBbk1TY3NJQzh2SU8yRXRDRHNtcFRzbGIwZzY1T3hJT3UyZ09xd2dDRHRtTGpzdHB3ZzY0R1VDaUFnUkVsVFFVSk1SVjlVUlV4RlRVVlVVbGs2SUNjeEp5d0tmU2s3Q2dwamIyNXpkQ0JRVDFKVUlEMGdUblZ0WW1WeUtIQnliMk5sYzNNdVpXNTJMa0pTU1VSSFJWOVFUMUpVS1NCOA0KZkNBeE1UZzRPRHNnTHk4Z1FsSkpSRWRGWDFCUFVsVHJpcFFnN1lXTTdJcWs3WXE0N0pxcElDanRqNG5zaG96c2w1UWdNVEU0T0RnZzZyT2c3S0NWS1Fvdkx5RHJpNlRycHF3ZzdMMlU2NU9jSU91eWhPeWdoQ0RpZ0pRZ0wyaGxZV3gwYU91aG5DRHJoYmpzdHB6dGxaenJpNlF1SU95OWxPdVRuT3VsdkNCd2RXeHN3cmZyczdYc2dxenRsYlRyajRRZ0tpcnNuYlRycjdnZzY1YWdJT3llaU91S2xDRHJpNlRycHF6cmlwUWc3SmliSU95OWxPdVRuQ0RxdDdqcmpJRHJvWndxS3V1ZHZBb3ZMeURxdTVEcmk2UWc3THljNnJpd0lPeWdoT3lYbENEc2c0Z2c2NCtaN0o2UjdKMjBJT3lWaUNEcmdwanNtS2pyaTZRbzdZU3c2Nis0NjRTUTdKMjBJT3VjcU91S2xDRHJrN0VwTGlEdGxJenJuNnpxdDdqc25ianNuYlFnN0oyMElPcXdrdXljdk91aG5DRHF0YXpyc29Uc29JVHNuWVFnNnJDUTdLZUE3WlcwSU95ZXJPeUxuT3lla2V5TG5PMkNxT3VMcEM0S0x5OGc2NCtaN0o2UjdKMjBJT3V3bE91QWpPdUtsQ0RzaUpqc29KWHMNCm5ZUWc3WldZNjZtMElPeWR0Q0RzaUt2c25wRHJwYndnN0ppczY2YXM2ck9nSUdOdlpHVXVkSFBzblpnZ1FsSkpSRWRGWDAxSlRsOVc2NCtFSU9xd21leWR0Q0RzbUt6cnByRHJpNlF1Q21OdmJuTjBJRUpTU1VSSFJWOVdJRDBnTVRNN0NpOHZJT3E0c091enVDRHJxcWpyamJndUlPeWFsT3l5clNqdGxJenJuNnpxdDdqc25iZ3A3SjIwSUcxdlpHVnM3SjJFSU95bmdPeWdsZTJWbU91cHRDRHF0N2dnN0pxVTdMS3Q2NmVNSU9xM3VDRHJxcWpyamJqcm9ad2c3TEtZNjZhczdaV2M2NHVrTGdvdkx5Qm9ZV2xyZFQzcnVhRHJwb1F2NnJDQTY3Szg3SnVBTENCemIyNXVaWFE5N0tTUjZyQ0VMQ0J2Y0hWelBlcTRzT3V6dUNqc3RaenFzNkR0a29qc3A0Z3NJT3loc09xNGlDRHJpcERycHJ3cENtTnZibk4wSUVOTVFWVkVSVjlOVDBSRlRDQTlJSEJ5YjJObGMzTXVaVzUyTGtKU1NVUkhSVjlOVDBSRlRDQjhmQ0FuYjNCMWN5YzdDbU52Ym5OMElFRk1URTlYUlVSZlRVOUVSVXhUSUQwZ1d5ZG9ZV2xyZFNjc0lDZHpiMjV1DQpaWFFuTENBbmIzQjFjeWRkT3dwamIyNXpkQ0JVVlZKT1gxUkpUVVZQVlZSZlRWTWdQU0E1TURBd01Ec2dJQ0F2THlEc21wVHNzcTBnTWVxeHRDRHNvSnp0bFp6c2k1enFzSVFLWTI5dWMzUWdUVUZZWDFSVlVrNVRJRDBnTXpBN0lDQWdJQ0FnSUNBZ0lDQWdMeThnN0oyMDY2ZU03WUc4SU95VHNPdXB0Q0RzaExqc2haZ2c3SjZzN0l1YzdKNlJJQ2pyaklEdG1aUWc2NGlFN0tDQklPdXdxZXluZ0NrS0NpOHZJT0tVZ09LVWdDRHNtSWpzaTV3ZzdJS3M3S0NFSU91aG5PdVRuQ0FvY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xa0lPS0FsQ0JpZFdsc1pDMW5iRzl6YzJGeWVTNXFjK3laZ0NEcXNKbnNuWUFnN1l5TTdJU2NLU0RpbElEaWxJQUtablZ1WTNScGIyNGdiRzloWkVWNFlXMXdiR1Z6S0NrZ2V3b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xaw0KSnlrc0lDZDFkR1k0SnlrN0NpQWdJQ0JqYjI1emRDQnpaV05KWkhnZ1BTQnRaQzV6WldGeVkyZ29MMTRqSXlEc3RwVHNzcHdnN0ppSTdJdWNYSE1xSkM5dEtUc0tJQ0FnSUdsbUlDaHpaV05KWkhnZ1BUMDlJQzB4S1NCeVpYUjFjbTRnVzEwN0NpQWdJQ0JqYjI1emRDQmxlR0Z0Y0d4bGN5QTlJRnRkT3dvZ0lDQWdiR1YwSUdOMWNpQTlJRzUxYkd3N0NpQWdJQ0JtYjNJZ0tHTnZibk4wSUhKaGR5QnZaaUJ0WkM1emJHbGpaU2h6WldOSlpIZ3BMbk53YkdsMEtDZGNiaWNwS1NCN0NpQWdJQ0FnSUdOdmJuTjBJR3hwYm1VZ1BTQnlZWGN1Y21Wd2JHRmpaU2d2WEhNckpDOHNJQ2NuS1RzS0lDQWdJQ0FnWTI5dWMzUWdhQ0E5SUd4cGJtVXViV0YwWTJnb0wxNGpJeU5jY3lzb0xpcy9LVnh6S2lRdktUc0tJQ0FnSUNBZ2FXWWdLR2dwSUhzZ1kzVnlJRDBnZXlCcGJuQjFkRG9nYUZzeFhTd2djM1ZuWjJWemRHbHZibk02SUZ0ZElIMDdJR1Y0WVcxd2JHVnpMbkIxYzJnb1kzVnlLVHNnWTI5dWRHbHVkV1U3SUgwS0lDQWcNCklDQWdZMjl1YzNRZ1lpQTlJR3hwYm1VdWJXRjBZMmdvTDE1Y2N5b3RYSE1yS0M0clB5bGNjeW9rTHlrN0NpQWdJQ0FnSUdsbUlDaGlJQ1ltSUdOMWNpa2dZM1Z5TG5OMVoyZGxjM1JwYjI1ekxuQjFjMmdvWWxzeFhTNXpjR3hwZENnbklDOGdKeWt1YW05cGJpZ25JQ2NwS1RzS0lDQWdJSDBLSUNBZ0lISmxkSFZ5YmlCbGVHRnRjR3hsY3k1bWFXeDBaWElvS0dVcElEMCtJR1V1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUQ0Z01DazdDaUFnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeVlpT3lMbkNEc2dxenNvSVFnNjZHYzY1T2NJT3lMcE8yTXFDQW83SmVHN0oyMElPeW5oTzJXaVNrNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lISmxkSFZ5YmlCYlhUc0tJQ0I5Q24wS0NpOHZJT0tVZ09LVWdDRHNwNERzaTV6cnJMZ2dLT3lFbk91eWhDQnlaV052YlcxbGJtVHNtWUFnNnJDWjdKMkFJT3Ezbk95NW1TRGlnSlFnNjdDVTZyNjQ2Nm0wSU9xM3VPeXF2ZXVQDQpoQ0R0bGFqcXU1Z3BJT0tVZ09LVWdBb3ZMeURzbXFuc2xyVHNwNUVvWjJ4dmMzTmhjbmt1YldRcDdKMkFJT3lkdk91MmdPdWZyQ0R0bElUcm9henRsSVR0aXJqc2w1QWc3SldJSU91RW8rdUtsT3VMcENneU1ESTJMVEEzSU95THBPeTRvU2s2SU91RW8reWN2T3VwdENEdGdiVHJvWnpyazV6cXNJQWc3SnFwN0phMElPcTFrT3lnbGV5ZGhBb3ZMeURzbzd3ZzdKNkU2NnkwNjZHY0lPeVlwTzJWdE8yVnRDQXo2ckNjSU95Z25PeVZpT3lkdENEc29JVHJ0b0FnSXUyUm5PcTRzQ0RxczZEc3VhZ2dLeURzbHJUc2lKd2c2N09BNnJLOUl1eWR0Q0Rya0p6cmk2UXVJT3lYcmUyVm9DRHJ0b1RycHF3ZzRvQ1VDaTh2SU8yQnRPdWhuT3VUbkNBOUlPdXN1T3llcFNEcmk2VHJrNnpxdUxBbzdMQzk3SjJZS1N3ZzdKcXA3SmEwSU8yR3RleWR2TUszNjZlZTdMYWs2N0tWSUQwZ1kyOWtaUzUwY3lCeVpXWnBibVZCYVZOMVoyZGxjM1JwYjI1eklPMmJoT3l5bU91bXJDanF1TERxczRUc29JRXBMZ3BqYjI1emRDQlRWRmxNUlY5Uw0KVlV4RlV5QTlJRnNLSUNBbk1TNGc3WlcwN0pxVTdMSzBPaURycXFqcms2QWc2Nnk0NnJXczY0cVVJTzJWdE95YWxPeXl0T3VobkM0Z0tPdXp0T3VEaGV1TGlPdUxwT0tHa3V1enRPdUN0T3lhbENrbkxBb2dJQ2N5TGlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd09pRHJrSkRzbHJUc21wVGlocEx0bG9qc2xyVHNtcFFzSUg3c2w0Z2c2N204NnJpd0tPdXdsT3VBak95WGlPeVd0T3lhbE9LR2t1dXdsT3EvcU95V3RPeWFsQ2t1SU91THFDd2c3S0tGNjZPTXdyZnJwNHpybzR6Q3QreVhzT3l5dE1LMzdaVzA3S2VBd3JmcXVMRHJvWjNDdCt1RnVleWRqQ0RyazdFZzdJdWM3SXFrN1lXYzdKMjBJT3lqdk95eXRPeWR1Q0Rxc3JEcXM3enJpcFFnN0lpWTY0K1o3WmlWSU95Y29PeW5nQ2pzbDdEc3NyVHJqN3pzbXBRc0lPdUZ1ZXlkak91UHZPeWFsQ2t1Snl3S0lDQW5NeTRnNnJpTjdLQ1Y3S0NCSU91bmtPMlZtT3E0c0RvZ0luN3RsYUFnN0lpWUlPeVhodXlXdE95YWxDSWc2NHlBN0l1Z0lDSis3WldZNjZtMElPMlYNCm9DRHNpSmdnN0o2STdKYTA3SnFVSWlEcXRhenNvYkFnN0pxdzdJU2dMaURyaTZnc0lPeWdsZXl4aGV5RGdTRHJ0b2pxc0lEQ3QreWR2T3UyZ0NEcXVMRHJpcVVnN0tDYzdaV2N3cmZya0pqcmo0enJwclFnN0lpWUlPeVhodXVLbENEcXNyRHFzN3pDdCt5Z2xldXp0Q0RyczdUdG1MZ2c3SldJN0l1czdKMkFJT3UyZ095Z2xlMllsZXljdk91aG5DRHJxb1h0bVpYdG5vZ3VKeXdLSUNBbk5DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0RG9nZnUyVm1PeUxuT3F5b095V3RPeWFsRC9paHBKKzdaV2c2cm1NN0pxVVB5d2c2ck9FN0l1YzY0dWs0b2FTN0o2STY0dWtMQ0RzbDZ6c3JZanJpNlRpaHBMdG1aWHNuYmp0bFpqcmk2UXNJT3E3bU9LR2t1eVhrT3F5akM0Z2Z1eUxuQ0RydWJ6cXVMRHFzSUFnN0phMDdJT0o3WldZNjZtMElPMk1qT3lWaGUyVm1PdWdwT3VLbENEc29KWHJzN1RycGJ3ZzdLTzg3SmEwNjZHY0lPdXN1T3llcGV5ZGhDRHJpNlRzaTV3ZzdKTzA2NHVrTGljc0NpQWdKelV1SU91cWhleUNyQ3ZyDQpxb1hzZ3F3ZzZyaUk3S2VBT2lEdGxaenNucERzbHJUcnBid2c3WktBN0phMElPdVBtZXlDck91aG5DanNuYlRzbnBBZzdabVk2N2FJN0oyRUlPdXdtK3lWbU95V3RPeWFsT0tHa3V5ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRcExDRHN0WnpzaG96dGxad2dlK3VxaGV5Q3JIM3FzSUFnZSt1cWhleUNySDN0bGJUc2hKd2c3WmlWN1lPYzY2R2NLT3llbE95Vm9TRHJ0b0Rzb2JIc25MenJvWnppaHBMc25wVHNsYUhzbmJRZzY3YUE3S0d4N1pXMDdJU2NLUzRuTEFvZ0lDYzJMaUR0a1p6cXVMQTZJT3VRbU95V3RPeWFsT0tHa3V1UHZPeWFsQzRuTEFvZ0lDYzNMaURzcElRZzZyV3M3S0d3T2lEc201RHJzN2pzbmJRZzdaV2NJT3lraE95ZHRPdXB0Q0RzdHBUc3NwenJqNFFnNjdDWTY1T2M3SXVjSU8yVm5DRHNwSVRyb1p3dUlPeWVoT3lkbU91aG5DRHNwSVRzbllRZzY0cVk2NmFzN0tlQUlPeVZpdXVLbE91THBDNGc2NHVvTENEc2w2enJuNndnNjZ5NDdKNmw3SjJFSU8yVm1PdUNtT3lkbUNEcQ0KdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPMlZxZXl6a0NEcmpaUWc2ckNFNnJLdzdaVzA3S2VFNjR1azY2bTBJT3lraENEc2lKanJwYndnN0tTRTdKMjA2NHFVSU9xeWcreWRnQ0R0bVpqc21JRXVKeXdLSUNBbk9DNGc2NHVrN0oyMDdKYTg2NkdjNnJlNElPeVp2T3lxdlNEcnNvVHRpcndnNjUyODY3S283SjJBSUNMcmk2dnF1TEFpS095M3FPeUdqQ0RxdUlqc3A0QXBMaWNzQ2lBZ0p6a3VJT3lkdE91bWhNSzM3S0NFN1ptVTY3S0k3Wmk0d3JmcnA0anNpcVR0Z3Juc25ZQWc2cmU0NjR5QTY2R2NJT3V6dE95aHRDNGc3SUtzNjU2TTdKMkVJT3UyZ091bHZDRHJsWkFnNjR1WTdKMkVJT3UybWV5WHJPdVBoQ0Rzb292cmk2UXVKeXdLSUNBbk1UQXVJT3lnbk8yU2lDRHNtcW5zbHJRZzdKeWc3S2VBT2lEc25vWHJvS1hzbDVBZzdKT3c3SjI0SU9xNHNPdUtwZXlFc1NEcnFvWHNncXdvNjdPQTZySzlMQ0RzcDREc29KVXNJT3VUc2V1aG5Td2c3WlcwN0tDY0lPdVRzU25yaXBRZzdabVU2Nm0wN0oyWUlPcTQNCnNPdUtwZXVxaGNLMzY3S0U3WXE4NjZxRjdKMjhJT3F3Z091S3BleUVzZXlkdENEcmhwTHNuTHpycjREcm9ad2c3SW1zN0pxMElPdW5rT3VobkNEcnNKVHF2cmpzcDRBZzdKV0s2NHFVNjR1a0xpRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F6cnBid2c3SU9JNjZHY0lPdW5qT3VUcE95bmdDRHNsWXJyaXBUcmk2UXVKeXdLWFM1cWIybHVLQ2RjYmljcE93b0tZMjl1YzNRZ1JWaEJUVkJNUlZNZ1BTQnNiMkZrUlhoaGJYQnNaWE1vS1RzS0NpOHZJT0tVZ09LVWdDRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3lnaE91c3VDRHJvWnpyazV3Z0tIVjRMWGR5YVhScGJtY3ViV1FnNG9DVUlPeVlpT3ladUNEcXQ1enN1WmtnN0lTNDY3YUFJT3lMbk91Q21PdW1yT3lZcE9xNWpPeW5nQ0R0bElUcm9henRsSVR0aXJqc2w1QWc3WStzN1pXb0tTRGlsSURpbElBS0x5OGdVMVJaVEVWZlVsVk1SVk1nTVREc3BJUWc3SnFVN0pXOTY2ZU03Snk4NjZHYzY0cVVJT3lZaU95WnVDQXhmak1vDQo3SWlZNjQrWjdaaVZ3cmZxc3Izc2xyVEN0K3UyZ095Z2xlMllsU0R0bDRqc21xa2c3THlBN0oyMDdJcWtLZXlkbUNEcmlaanNsWm5zaXFUcXNJQWc3SnlnN0l1azY1Q2M2NHVrTGdvdkx5RHRqSXpzbmJ6c25iUWc3SmVHN0p5ODY2bTBLT3lFcE95NW1PdXp1Q0RxdGF6cnNvVHNvSVFnNjVPeEtTRHJ1WWdnNjZ5NDdKNlE3SmUwSU9LQWxDRHNtcFRzbGIzcnA0enNuTHpyb1p3ZzY0K1o3SjZSS0daaGFXd3RjMjltZENrdUNtWjFibU4wYVc5dUlHeHZZV1JIZFdsa1pTZ3BJSHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYldRZ1BTQm1jeTV5WldGa1JtbHNaVk41Ym1Nb2NHRjBhQzVxYjJsdUtGOWZaR2x5Ym1GdFpTd2dKeTR1Snl3Z0ozVjRMWGR5YVhScGJtY3ViV1FuS1N3Z0ozVjBaamduS1M1MGNtbHRLQ2s3Q2lBZ0lDQnlaWFIxY200Z2JXUXViR1Z1WjNSb0lENGdNVEF3SUQ4Z2JXUWdPaUFuSnpzS0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0lxaw0KN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Ryb1p6cms1d2c3SXVrN1l5b0lDanNtcFRzbGIzcnA0enNuTHpyb1p3ZzdLZUU3WmFKS1RvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ2NtVjBkWEp1SUNjbk93b2dJSDBLZlFwamIyNXpkQ0JIVlVsRVJTQTlJR3h2WVdSSGRXbGtaU2dwT3dvS1puVnVZM1JwYjI0Z2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa2dld29nSUdOdmJuTjBJR1psZDFOb2IzUWdQU0JGV0VGTlVFeEZVeTV0WVhBb0tHVjRLU0E5UGlBblNXNXdkWFE2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNobGVDNXBibkIxZENrZ0t5QW5YRzVQZFhSd2RYUTZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2hsZUM1emRXZG5aWE4wYVc5dWN5a3BMbXB2YVc0b0oxeHVKeWs3Q2lBZ2NtVjBkWEp1SUNnS0lDQWdJQ2ZzcDREcXVJanJ0b0R0aExBZzY0U0k2NHFVSU95WGtPeUtwT3lia0NoVExURXNJT3V6dE95VmlPMmFqT3lDckNuc25aZ2c3WldjNnJXdDdKYTBJRlZZSUZkeWFYUnBibWNnN0tDRTY2eTQNCjZyQ0E2NkdjSU95ZHZPMlZuT3VMcEM0Z0p5QXJDaUFnSUNBbjY0SzA2ckNBSUZWSklPdXN1T3Exck91bHZDRHRsWmpyZ3Bqc2xLa2c2N08wNjRLMDY2bTBMQ0RzbFlUcm5wZ2c3SXFrN1lPQTdKMjhJT3Ezbk95NW1leVhrQ0RycDU3cXNvd2c2NHVrNjVPczdKMkFJT3VNZ095VmlDQXo2ckNjNjZXOElPeWduT3lWaU8yVm1PdWR2QzVjYmljZ0t3b2dJQ0FnSit5YWxPeXlyZXVUcE95ZGdDRHNoSnpyb1p3ZzY2eTA2clNBN1pXY0lPdXpoT3F3bkNEcnJManF0YXpyaTZRZzRvQ1VJT3lkdE95Z2hDRHJyTGpxdGF6cnBid2c3TEM0N0tHdzdaV1k3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSit5YmtPdWVtQ0RzblpqcnI3anNtWUFnNjZxbzY1T2dJT3lnbGV1enRDanNuYlRycG9UQ3QreUlxK3lla01LMzdLR3c2ckcwd3JmcmpJRHNnNEVwNjZXOElPeWNvT3luZ08yVm1PcXpvQ3dnNnJDQklPeWduT3lWaU95ZGdDRHNtNURyczdqcXM3enJqNFFnN0lTYzY2R2M3Sm1BNjQrRUlPdUxyT3Vkdk95VnZDRHRsWnpyDQppNlF1SUNjZ0t3b2dJQ0FnSit5aHNPcXh0Q0R0a1p6dG1JUW83SjIwN0lPQndyZnNuYlR0bFpqQ3QreWR0T3VDdE1LMzdMU0k2ck84d3JmcnI3anJwNHpDdCt1MmdPMkVzTUszNnJtTTdLZUFJT3VUc1Nuc25ZQWc3S0NWN0xHRklPeWdsZXV6dE91THBDRGlnSlFnNjdtODZyR3c2NEtZSU91THBPdWx1Q0Rzb2JEcXNiVHNuTHpyb1p3ZzY3Q1U2cjY0N0tlQUlPdW5pT3VkdkNnaU5lMmFqQ0RzbmJUc2c0RWk3SjJFSUNJMTdacU1JdXVobkNEc3BJVHNuYlRycWJRZzdKaWs2NHUxS1M0Z0p5QXJDaUFnSUNBbjdKdVE2Nnk0N0plUUlPeVhodXVLbENEcXRhenNzclFnN0tDVjY3TzBLT3lnaE8yWmxPdXlpTzJZdU1LM1ZWSk13cmZxdUlqc2xhSEN0K3lMbk9xd2hDRHJrN0VwN0ptQUlPMlZ0T3F5c0NEcnNLbnJzcFhDdCt5Z2lPeXdxQ2pzbnF6c2hLVHNvSlhDdCt1c3VPeWRtT3l5bU1LMzdKNnM3SXVjNjQrRUlPdVRzU25ycGJ3ZzdLZUE3SmEwNjRLMElPdTJtZXlkdE91S2xDRHFzb1BzbllBZzdLQ0k2NHlBSU9xNA0KaU95bmdDRGlnSlFnN0pXRTY0cVVJT3F3a3V5ZHRPdWR2T3VQaEN3ZzZyZTQ2NSswNjVPdjdaVzA2NCtFSU95VHNPeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ2N6NnJDY0lPeWduT3lWaU95ZGdDRHNoSnpyb1p3ZzdLQ1I2cmU4N0oyMElPdUxyT3Vkdk95VnZDRHRsWnpyaTZRZzRvQ1VJTzJWbU91Q21PdUtsQ0RzbTVEcnJMZ2c2cldzN0tHdzY2VzhJT3ljb095bmdPMlZuQ0RzdFp6c2hvd2c2NHVrNjVPczZyaXdMQ0R0bFpqcmdwanJpcFFnNjZ5NDdKNmxJT3Exck95aHNPdWx2Q0RzbnF6cXRhenNoTEh0bFp3ZzY0eUE3SldJTENBbklDc0tJQ0FnSUNmcXQ3anJwcXpxczZBZzdLQ0I3SmEwNjQrRUlPMlZtT3VDbU91S2xDRHFzN3pxc0pEdGxad2c3SjZzNnJXczdJU3hPaURzcEpIcnM3VWc3WkdjN1ppRTdKMkVJT3VObk95V3RPdUN0T3F6b0N3ZzdLQ1Y2N08wSU95SW5PeUVuT3VsdkNEc2dxenNtcW5zbnBEcXNJQWc3SldNN0pXRTdKVzhJTzJWb0NEcXNvUHJ0b0R0aExEcm9ad2c3SjZzN0tHdzdLZUINCjdaV2dJT3F5Z3k0Z0p5QXJDaUFnSUNBbjdKdVE2Nnk0N0oyMElPMlZ0T3F5c0NEcnNLbnJzcFhzbllRZzY0dTA2ck9nSU95ZWlPeWRoQ0RybFl6cnA0d2dJdXlXdE91V3UrcXlqQ0R0bFpqcnFiUWc2NHVrN0l1Y0lPdVFuT3VMcENMcnBid2c3SldlN0lTNDdKcXc2NHFVSU9xNGpleWdsZTJZbFNEc25xenF0YXpzaExIc25ZUWc3WldZNjUyOElPS0FsQ0RzbTVEcnJManNsNUFnN1pXMDZyS3c3TEdGN0oyMElPeVhodXljdk91cHRDRHJwNHpyazZUc2xyUWc2N2FaN0oyMDdLZUFJT3VuaU91ZHZDNGdKeUFyQ2lBZ0lDQW43WkdjNnJpd3dyZnNtcW5zbHJUcnA0d2c2ck9nN0xtWTZyT2dJT3lXdE95SW5PeWRoQ0Ryc0pUcXZyd2c3S0NWNjQrRTdKMllJT3lnbk95VmlPeWRoQ0F6NnJDY0lPdUttT3lXdE91R2sreW5nQ0RycDRqcm5id2c0b0NVSU9xM3VPcXh0Q0RzZ3F6c21xbnNucERzbDVEcXNvd2c3TGFVN0xLYzdKMjBJT3lWaE91TGlPdWR2Q0RxdFpEc29KWHNuTHpyb1p3ZzY3TzA3SjI0NjR1a0xpQW5JQ3NLDQpJQ0FnSUNmc2xZVHJucGdnN0ppSTdJdWM2NU9rN0oyQUlPMlZuQ0RzcElUc3A1enJwcXdnN0xXYzdJYU1JT3Exa095Z2xleWR0Q0RycDQ3c3A0RHJwNHdnNnJlNDZyRzBJTzJHcENqdGxiVHNtcFRzc3JUQ3QrcXl2ZXlXdENuc25aZ2c2cldRNjdPNDdKMjA3S2VBSU95R2pPcTN1ZXlFc2V5ZG1DRHF0WkRyczdqc25iUWc3SldFNjR1STY0dWtJT0tBbENEc2w2enJuNndnNjZ5NDdKNmw3S2VjNjZhc0lPeWVoZXVncGV5ZGdDRHJxWlRzaTV6c3A0QWc2NHVvN0p5RTY2R2NJT3VMcE95TG5DRHNoS1RxczRUdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNmcmk3WHNuWUFnNjdDWTY1T2M3SXVjSUVwVFQwNGc2N0N3N0plMDY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvWEN0K3k5bE91VG5PMk9uT3lLcENEcXVJanNwNEE2WEc0bklDc0tJQ0FnSUNkYmV5SjBaWGgwSWpvZ0l1eWduT3lWaUNEcnJManF0YXdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0luSmxZWE52YmlJNg0KSUNMcnJMVHNsNGZzbllRZzdKbWNJT3V3bE9xL3FPdUtsT3luZ0NEdGxaenF0YTNzbHJRZzdaV2NJT3VzdU95ZXBTSjlMQ0F1TGk1ZFhHNWNiaWNnS3dvZ0lDQWdKMXZzaXFUdGc0RHNuYndnNnJlYzdMbVpYVnh1SnlBcklGTlVXVXhGWDFKVlRFVlRJQ3NnSjF4dVhHNG5JQ3NLSUNBZ0lDaEhWVWxFUlNBL0lDZGI3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Rzb0lUcnJMZ2dLSFY0TFhkeWFYUnBibWN1YldRcElPS0FsQ0RzbklRZzZyZWM3TG1aN0oyWUlPcTN2T3F4c095WmdDRHNtSWpzbWJnZzdJdWM2NEtZNjZhczdKaWtMaUR0aXJudG5vZ2c3SmlJN0ptNElPcTNuT3k1bVNqc2lKanJqNW50bUpYQ3QrcXl2ZXlXdE1LMzY3YUE3S0NWN1ppVjdKMkVJT3ljb095bmdPMlZ0T3lWdkNEdGxaanJpcFFnN0lPQjdabXBLZXlkaENEcXQ3anJqSURyb1p3ZzY1U3c2NlcwNnJPZ0xDRHNtcFRzbGIzcXM3d2c3S0NFNjZ5NDdKMjBJT3VMcE91bHRPdXB0Q0Rzb0lUcnJManNuWVFnNjVTdzY2VzQ2NHVrWFZ4dUp5QXINCklFZFZTVVJGSUNzZ0oxeHVYRzRuSURvZ0p5Y3BJQ3NLSUNBZ0lDaG1aWGRUYUc5MElEOGdKMXZzbXJEcnBxd2c2NnFwN0lhTTY2YXNJT3lZaU95TG5DRGlnSlFnN0oyMElPMkdwT3lkaENEcmxMRHJwYndnNnJLRFhWeHVKeUFySUdabGQxTm9iM1FnS3lBblhHNWNiaWNnT2lBbkp5a2dLd29nSUNBZ0oreWtnT3U1aE91UWtPeWN2T3VwdENBaVQwc2k2NTI4NnJPZzY2ZU1JT3VMdGUyVm1PdWR2QzRuQ2lBZ0tUc0tmUW9LTHk4ZzRwU0E0cFNBSU95RGdleUxuQ0RyaklEcXVMQWc3WUcwNjZHYzY1T2NJT3lFdU95Rm1DRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQUtiR1YwSUhCeWIyTWdQU0J1ZFd4c095QWdJQ0FnSUNBZ0lDQXZMeUR0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxa0NteGxkQ0JzDQphVzVsUW5WbUlEMGdKeWM3SUNBZ0lDQWdJQ0FnTHk4Z2MzUmtiM1YwSU95a2hDRHJzb1R0amJ3S2JHVjBJSGRoYVhSbGNpQTlJRzUxYkd3N0lDQWdJQ0FnSUNBdkx5RHRtSVRzbnF3ZzdZUzA3SjJZSUhzZ2NtVnpiMngyWlN3Z2NtVnFaV04wTENCMGFXMWxjaUI5Q214bGRDQnhkV1YxWlNBOUlGQnliMjFwYzJVdWNtVnpiMngyWlNncE95QXZMeURzbXBUc3NxMGc3S2VCNjZDczdabVVJQ2pyajVuc2k1d2c3SnFVN0xLdDdKMkFJT3lJbk95RW5PdU1nT3VobkNrS2JHVjBJSFIxY201eklEMGdNRHNLYkdWMElIZGhjbTFsWkZWd0lEMGdabUZzYzJVN0NteGxkQ0JqZFhKeVpXNTBUVzlrWld3Z1BTQkRURUZWUkVWZlRVOUVSVXc3SUM4dklPeW5nT3E0aUNEc2hManNoWmpzbmJRZzY2eTg2ck9nSU95ZWlPdUtsQ0RycXFqcmpiZ2dLT3lhbE95eXJleWR0Q0RyaTZUcnBiZ2c2NnFvNjQyNDdKMkVJT3luZ095Z2xlMlZtT3VwdENEc2hManNoWmdnN0o2czdJdWM3SjZSS1Fvdkx5RHNpNXpzbnBFZzdJdWNJRU5zWVhWaw0KWlNCRGIyUmxLR05zWVhWa1pTQkRURWtwNnJDQUlPeVR1Q0RzaUpnZzdKNkk2NHFVN0tlQUlPeWdrT3F5Z0NEaWdKUWc3SmVHN0p5ODY2bTBJQzlvWldGc2RHanJvWndnN0pXTTY2Q2tJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHNsWWpyZ3JUdGxaenJpNlF1Q2k4dklHNTFiR3c5N1ptVjdKMjRJT3lra1N3Z0oyOXJKejNzZ3F6c21xa2c2ckNBNjRxbExDQW5ZMnhoZFdSbExXMXBjM05wYm1jblBXTnNZWFZrWlNEcnFvWHJvTGtnN0plRzdKMk1MQW92THlBblkyeGhkV1JsTFd4dloyOTFkQ2M5WTJ4aGRXUmw2NHFVSU95ZWlPeW5nT3VuakNEcm9aenF0N2pzbmJnZzdJUzQ3SVdZSU91bmpPdWpqQ0FvN1lTMElPeUxwTzJNcUNEc2k1d2c2ckNRN0tlQUxDRHNoTEhxczdVZzdZUzA3SjIwSU95WXBPdXB0Q0RzbnBEcmo1a2c3WlcwN0tDY0tRcHNaWFFnWTJ4aGRXUmxVM1JoZEhWeklEMGdiblZzYkRzS0x5OGc2NkdjNnJlNDdKMjRJT3Vuak91ampDRHFzSkRzcDRBZzRvQ1VJRU5NU2Vxd2dDRHJnclRyaXBRZzdKaUINCjdKYTBJT3lkdU95bW5TRHNtS1RycFpqcnBid2c3SUtzNjU2TTdKMjBJT3lWak95VmhPdVRwT3lkaENEc2xZanJnclRyb1p3ZzY3Q1U2cjY4NjR1a0xnb3ZMeUFvWTJ4aGRXUmxJQzB0ZG1WeWMybHZidXlkZ0NEcm9aenF0N2pzbmJnZzdKZUc3SjIwNjQrRUlPeUVzZXF6dGUyVnRPeUVuQ0RzaTV6cmo1a2c3S0NRNnJLQTdKeTg2NkdjNjRxVUlPdXF1eURzbnFIcXM2QXNJT3lMcE95Z25DRHRoTFRzbDVEc2hKenJwNHdnNjVPYzY1K3M2NEtjNjR1a0tRb3ZMeUFpNjZlTTY2T01JdXVuak95ZHRDRHNsWVRyaTRqcm5id2dJdTJWbkNEcnNvanJqNFFnNjZHYzZyZTQ3SjI0SU95VmlDRHRsYWdpNjQrRUlPcXdtZXlkZ0NEcXNyM3JvWnpyb1p3ZzdKNmg3WjZJNjYrQTY2R2NJT3lra2V1bXZTRHRrWnp0bUlUc25ZUWc3Sk8wNjR1a0NtTnZibk4wSUV4UFIwbE9YMGRWU1VSRklEMGdKKzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNuYmpzbmJRZzdaV0U3SnFVN1pXMDdKcVVLT3lWaUNEcmtKRHFzYkRyZ3BnZzY2ZU02Nk9NDQpLU0RpZ0pRZ1cvQ2ZuNkFnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdUNEdGxZVHNtcFJkSU91eWhPMkt2T3lkaENEcmlJVHJwYlRycWJRZzY2R2M2cmU0N0oyNElPeXd2ZXlkaENEc2w3VHNsclRyazV6cm9LVHNtcFF1SnpzS0x5OGc3SXVrN0xpaDdaV2NJT3VzdU9xMXJPdVRwRG9nSWtaaGFXeGxaQ0IwYnlCaGRYUm9aVzUwYVdOaGRHVTZJRTlCZFhSb0lITmxjM05wYjI0Z1pYaHdhWEpsWkNCaGJtUWdZMjkxYkdRZ2JtOTBJR0psSUhKbFpuSmxjMmhsWkNJbzY2ZU02Nk9NS1N3S0x5OGdJazV2ZENCc2IyZG5aV1FnYVc0Z3dyY2dVR3hsWVhObElISjFiaUF2Ykc5bmFXNGlLT3V2dU91aG5PcTN1T3lkdUNrZzRvQ1VJT3VSbUNEcmk2UWc3SjZoN1o2STZyS01JT3VFaysyZWpPdUxwQXBtZFc1amRHbHZiaUJwYzBGMWRHaEZjbkp2Y2loektTQjdDaUFnY21WMGRYSnVJQzloZFhSb1pXNTBhV05oZEh4dllYVjBhSHhoY0drZ2EyVjVmR3h2WnlBL2FXNThiRzluWjJWa2ZITmxjM05wYjI0Z1pYaHdhWEpsWkM5cA0KTG5SbGMzUW9VM1J5YVc1bktITXBLVHNLZlFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56NjZXOElPeWR2ZXlXdEFvdkx5QXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZuT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbENEc3BKSHNuYmpzcDRBaUlPMlJuT3lMbkNEaWdKUWc2ck8xN0pxcElGQkQ3SmVRN0lTY0lPdUNxT3lkbUNEcXM0VHNvSlVnN0ppazdJS3M3SnFwSU91d3FleW5nQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHQNCmxaanJyNERyb1p3ZzdKNlE2NCtaSU91d21PeVlnZXVRbk91THBDNEtiR1YwSUdGalkyOTFiblJEWVdOb1pTQTlJSHNnWVhRNklEQXNJR1Z0WVdsc09pQnVkV3hzSUgwN0NtWjFibU4wYVc5dUlHTnNZWFZrWlVGalkyOTFiblFvS1NCN0NpQWdhV1lnS0VSaGRHVXVibTkzS0NrZ0xTQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BDQXpNREF3TUNrZ2NtVjBkWEp1SUdGalkyOTFiblJEWVdOb1pTNWxiV0ZwYkRzS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnFJRDBnU2xOUFRpNXdZWEp6WlNobWN5NXlaV0ZrUm1sc1pWTjVibU1vY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKeTVqYkdGMVpHVXVhbk52YmljcExDQW5kWFJtT0NjcEtUc0tJQ0FnSUdWdFlXbHNJRDBnS0dvZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpLU0I4ZkNCdWRXeHNPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxDQpJT3Vobk9xM3VPeWR1Q0RzbmJUcm9LVWc3SmVHN0oyTUlPdVRzU0RpZ0pRZ2JuVnNiQ0RzbktEc3A0QWdLaThnZlFvZ0lHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJRVJoZEdVdWJtOTNLQ2tzSUdWdFlXbHNJSDA3Q2lBZ2NtVjBkWEp1SUdWdFlXbHNPd3A5Q21aMWJtTjBhVzl1SUdOb1pXTnJRMnhoZFdSbFFYWmhhV3hoWW14bEtDa2dld29nSUdOdmJuTjBJSEJ5YjJKbElEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25MUzEyWlhKemFXOXVKMTBzSUhzZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1ZpQjlLVHNLSUNCc1pYUWdiM1YwSUQwZ0p5YzdDaUFnY0hKdlltVXVjM1JrYjNWMExtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc2diM1YwSUNzOUlHUXVkRzlUZEhKcGJtY29LVHNnZlNrN0NpQWdjSEp2WW1VdWIyNG9KMlZ5Y205eUp5d2dLQ2tnUFQ0Z2V5QmpiR0YxWkdWVGRHRjBkWE1nUFNBblkyeGhkV1JsTFcxcGMzTnBibWNuT3lCOUtUc0tJQ0J3Y205aVpTNXZiaWduWTJ4dg0KYzJVbkxDQW9ZMjlrWlNrZ1BUNGdld29nSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnS0dOdlpHVWdQVDA5SURBZ0ppWWdMMXhrSzF3dVhHUXJMeTUwWlhOMEtHOTFkQ2twSUQ4Z0oyOXJKeUE2SUNkamJHRjFaR1V0YldsemMybHVaeWM3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnUTJ4aGRXUmxJRU52WkdVZzdLQ1E2cktBT2lBbklDc2dZMnhoZFdSbFUzUmhkSFZ6SUNzZ0tHOTFkQ0EvSUNjZ0tDY2dLeUJ2ZFhRdWRISnBiU2dwSUNzZ0p5a25JRG9nSnljcEtUc0tJQ0I5S1RzS2ZRb3ZMeURzc3BqcnBxd2c3WmlFN1ptcElPS0FsQ0F2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWdENBaTdLQ1Y2NmVRSU8yQnRPdWhuT3VUbk9xd2dDRHJpN1h0bG9qcmlwVHNwNEFpSU91d2x1eVhrT3lFbkNEdG1aWHNuYmp0bGFBZzdJaVlJT3llaU9xeWpDRHRsWnpyaTZRS1kyOXVjM1FnYzNSaGRITWdQU0I3SUhObGNuWmxaRG9nTUN3Z2JHRnpkRUYwT2lBbkp5d2diR0Z6ZEZSbGVIUTZJQ2NuTENCc1lYTjANClUyVmpPaUFuSnlCOU93b0tMeThnNHBTQTRwU0FJTzJVak91ZnJPcTN1T3lkdUNEc2c1M3NvYlFnNnJDUTdLZUFLT3lMck95ZXBldXdsZXVQbVNrZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBQ2k4dklPMlVqT3Vmck9xM3VPeWR1T3lkdENEcmxxQWc3SjZJNjRxVUlPdVBtZXlWaUNCamIyUmxMblJ6NnJDQUlEWHN0SWpycDRqcmk2UWdVRTlUVkNBdmFHVmhjblJpWldGMDY2VzhJT3V6dE91Q3VPdUxwQzRLTHk4ZzdaV2NJT3V5aU95ZHRPdWR2T3VQaENEcnNKdnNuWUFnNjVLa0lETXc3TFNJNnJDRUlPdUJpdXE0c091cHRDRHRsSXpybjZ6cXQ3anNuYmdvNjVpUTY0cVVJTzJVdk9xM3VPdW5pQ25zbmJRZzY0dXI3WjZNSU9xeWd5RGlnSlFnN1lHMDY2R2M2NU9jNnJtTTdLZUFJT3VOc091bXJPcXpvQ0Rxc0puc25iUWc2cnE4N0tlRTY0dWtMZ292DQpMeURzbFlUc3A0RWc3WldjSU91eWlPdVBoQ0RycXJzZzY3Q2I3SldZN0p5ODY2bTBLT3VMcE91bXJPdW5qQ0RycUx6c29JQWc3THlnSU95RGdlMkRuQ3dnN0o2UTY0K1o3SXVjN0o2UklPdVRzU2tnNnJPRTdJYU5JT3VNZ09xNHNPMlZuT3VMcEM0S1kyOXVjM1FnU0VWQlVsUkNSVUZVWDBSRlFVUmZUVk1nUFNBek1EQXdNRHNLYkdWMElHeGhjM1JDWldGMElEMGdNRHNLYzJWMFNXNTBaWEoyWVd3b0tDa2dQVDRnZXdvZ0lHbG1JQ2hzWVhOMFFtVmhkQ0FtSmlCRVlYUmxMbTV2ZHlncElDMGdiR0Z6ZEVKbFlYUWdQaUJJUlVGU1ZFSkZRVlJmUkVWQlJGOU5VeWtnZXdvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yVWpPdWZyT3EzdU95ZHVDRHNpNnpzbnFYcnNKWHJqNWtnNjRHSzZybUFJT0tBbENEdGxMenF0N2pycDRndjdaU002NStzNnJlNDdKMjQ3SjIwSU91THErMmVqQ0Rxc29Qc25MenJvWndnNjdPMDZyT2dJT3F3bWV5ZHRDRHF1cnpzcDVIcmk0anJpNlF1SnlrN0NpQWdJQ0J3Y205ag0KWlhOekxtVjRhWFFvTUNrN0lDOHZJR1Y0YVhRZzdaVzQ2NU9rNjUrczZyQ0FJR3RwYkd4UWNtOWo3Snk4NjZHY0lHTnNZWFZrWlNEdGlyanJwcXpycGJ3ZzdLQ1Y2NmFzN1pXYzY0dWtDaUFnZlFwOUxDQTFNREF3S1RzS0NpOHZJT3Vobk9xM3VPeWR1Q0JWVWt6c25ZUWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnQ2pyczdUdGhyVWc3TEM5S2V1aG5DRHNsNnpyaXBRZ1FsSlBWMU5GVWlEdGxianJrNlRybjZ3ZzdJcWs3WUdzNjZhOTdZcTQ2Nlc4SU91bmpPdVRvT3VMcEM0S0x5OGdZMnhoZFdSbElFTk1TZXVLbENCQ1VrOVhVMFZTSU8yWm1PcXl2ZXV6Z095SW1PdWx2Q0Rzb2JUc3BKSHRsYlFnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN1RzcDRBZzdKV0s2ck9nSU95ZHRDRHNpcVR0Z2F6cnByM3RpcmpzbDVBZ1lYVjBhRzl5YVhwbElGVlNUT3lkaENEcmhKanF1TFRyaTZRbzdJdWs3TGloSURJd01qWXRNRGNwTGdvdkx5QnRiMlJsUFNkemQybDBZMmduS09xemhPeWdsU0Rzb0lUdG1aZ3ANCklPS0draURzaXJuc25iZ2c3Wm1VNjZtMDdKMkVJT3F4c095NW1PeW5nQ0RzbFlycXM2QWdLaXJxczRUc29KVWc3SVNnN1lPZElPMlpsT3VwdE95Y3ZPdWhuQ0Ryc0pUcm9ad3FLaURyczdUcmdyanJpNlF1Q2k4dklDQWc2NkdjNnJlNDdKMjQ2NUNjSU95RGdlMkRuT3VwdENCaGRYUm9iM0pwZW1YcXNJQWc3SXE1N0oyNElPMlpsT3VwdE95Y3ZPdWhuQ0Rxc0lEcXM2QWdjMlZzWldOMFFXTmpiM1Z1ZEQxMGNuVmx3cmR3Y205dGNIUTljMlZzWldOMFgyRmpZMjkxYm5Ucm9aenJqNFFnNjZxN0lPdWFxK3ljdk91dmdPdWhuQ2pzaTZUc3VLRXBMQW92THlBZ0lPMlZuQ0R0ZzYwZzdKV0k3SmVRN0lTY0lHTnNZWFZrWlM1aGFTOXNiMmR2ZFhRL2NtVjBkWEp1Vkc4OVBIVnliQzFsYm1OdlpHVmtJQzl2WVhWMGFDOWhkWFJvYjNKcGVtVS9VVlZGVWxrbzdJT0I2NHlBNnJLOTY2R2NLVDdyb1p3ZzdKNkg2NHFVNjR1a09nb3ZMeUFnSU91aG5PcTN1T3lWaE95Ymd5anNoTGpzaFpnZzdLZUE3SnVBS1NEaWhwSWdiRzluDQphVzQvYzJWc1pXTjBRV05qYjNWdWREMTBjblZsS09xemhPeWdsU0RzaEtEdGc1MHA2NkdjSU95ZWtPdVBtU0Rzc3JUc25iVHJpNTBvN0l1azdMaWhPaURyaTZqc25id2c3WU90S1M0ZzdJcTU3SjI0SU8yWmxPdXB0Q0R0bFpqcmk2Z0tMeThnSUNCYjZyT0U3S0NWSU95Z2hPMlptRjBnNjdLRTdZcTg3SjIwSU8yVm1PdUtsQ0RzbmJ6cXM3d2c2ckNaN0oyQUlPcXlzT3F6dkNEaWdKUWc2NHVrNjZlTUlPeWFzT3Vtck9xd2dDRHFzNmZzbnFVZzZyZTRJTzJabE91cHRPeWN2T3VobkNEcnM3VHJncmpyaTZRdUNpOHZJQ0FnS091MmdPeWVrZXlhcVRvZzY3aU02NTI4N0pxdzdLQ0E3SjJZSUdOc1lYVmtaUzVoYVNEc203a2c2NkdjNnJlNDdKMjQ2NCtFSU8yU2dPdW12Q0RpZ0pRZzZyT0U3S0NWSU95Z2hPMlptQ0Rzblpqcmo0VHNtWUFnNjdDcDdaYWw3SjIwSU9xd21leVZoQ0RzaUpqc21xa3VLUW92THlCdGIyUmxQU2R1YjNKdFlXd25LT3Vuak91ampDRHNucXpyb1p6cXQ3anNuYmdwSU9LR2tpRHJvWnpxdDdqcw0KbFlUc200TWc3SmVHN0oyMElPcTN1T3VEcFNEc2w3RHJpNlFvNjR5QTZyQ2NJT3F3bWV5ZGdDRHFzNFRzb0pYc25iVHJuYndnN0lTNDdJV1lJT3ljb095bmdPcXdnQ0RydWFEcnBvUXBMZ3BtZFc1amRHbHZiaUIzY21sMFpVSnliM2R6WlhKSVlXNWtiR1Z5S0cxdlpHVXBJSHNLSUNCamIyNXpkQ0JzYjJkdmRYUWdQU0J0YjJSbElEMDlQU0FuYzNkcGRHTm9KenNLSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdZMjl1YzNRZ1kyMWtJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxaWNtOTNjMlZ5TFNjZ0t5QnRiMlJsSUNzZ0p5NWpiV1FuS1RzS0lDQWdJR052Ym5OMElIQnpJRDBnYkc5bmIzVjBDaUFnSUNBZ0lEOGdJaVIxUFNSbGJuWTZRMEpmVlZKTU95QWthVDBrZFM1SmJtUmxlRTltS0NkdllYVjBhQzloZFhSb2IzSnBlbVVuS1RzZ2FXWW9KR2tnTFdkbElEQXBleUFrY21Wc1BTY3ZKeXNrZFM1VGRXSnoNCmRISnBibWNvSkdrcE95QWtaVzVqUFZ0VGVYTjBaVzB1VlhKcFhUbzZSWE5qWVhCbFJHRjBZVk4wY21sdVp5Z2tjbVZzS1RzZ1UzUmhjblF0VUhKdlkyVnpjeUFvSjJoMGRIQnpPaTh2WTJ4aGRXUmxMbUZwTDJ4dloyOTFkRDl5WlhSMWNtNVViejBuS3lSbGJtTXBJSDBnWld4elpTQjdJRk4wWVhKMExWQnliMk5sYzNNZ0pIVWdmU0lLSUNBZ0lDQWdPaUFuVTNSaGNuUXRVSEp2WTJWemN5QWtaVzUyT2tOQ1gxVlNUQ2M3Q2lBZ0lDQm1jeTUzY21sMFpVWnBiR1ZUZVc1aktHTnRaQ3dnSjBCbFkyaHZJRzltWmx4eVhHNXpaWFFnSWtOQ1gxVlNURDBsZmpFaVhISmNibkJ2ZDJWeWMyaGxiR3dnTFU1dlVISnZabWxzWlNBdFJYaGxZM1YwYVc5dVVHOXNhV041SUVKNWNHRnpjeUF0UTI5dGJXRnVaQ0FpSnlBcklIQnpJQ3NnSnlKY2NseHVKeWs3Q2lBZ0lDQnlaWFIxY200Z1kyMWtPd29nSUgwS0lDQmpiMjV6ZENCemFDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0DQpZbkp2ZDNObGNpMG5JQ3NnYlc5a1pTQXJJQ2N1YzJnbktUc0tJQ0JqYjI1emRDQnViMlJsUW1sdUlEMGdjSEp2WTJWemN5NWxlR1ZqVUdGMGFEc2dMeThnN0tDRUlFOVQ3SmVRSUc1dlpHVWc3SjZJN0oyTUtPdUxwT3Vtck9xd2dDQnViMlJsNjZHY0lPdVBqaWt1SU91emdPMlptQ0RzaTZUdGpLZ2c3SXVjSU95YmtPdXp1Q0JWVWt3ZzZyZTQ2NHlBNjZHY0lPeVhzT3VMcENobVlXbHNMWE52Wm5RcExnb2dJR052Ym5OMElHSnZaSGtnUFNCc2IyZHZkWFFLSUNBZ0lEOGdKeU1oTDJKcGJpOXphRnh1SnlBckNpQWdJQ0FnSUNkVlBTUW9JaWNnS3lCdWIyUmxRbWx1SUNzZ0p5SWdMV1VnWENkamIyNXpkQ0IxUFhCeWIyTmxjM011WVhKbmRsc3hYVHRqYjI1emRDQnBQWFV1YVc1a1pYaFBaaWdpYjJGMWRHZ3ZZWFYwYUc5eWFYcGxJaWs3Y0hKdlkyVnpjeTV6ZEdSdmRYUXVkM0pwZEdVb2FUd3dQM1U2SW1oMGRIQnpPaTh2WTJ4aGRXUmxMbUZwTDJ4dloyOTFkRDl5WlhSMWNtNVViejBpSzJWdVkyOWtaVlZTU1VOdg0KYlhCdmJtVnVkQ2dpTHlJcmRTNXpiR2xqWlNocEtTa3BYQ2NnSWlReElpQXlQaTlrWlhZdmJuVnNiQ2xjYmljZ0t3b2dJQ0FnSUNBbmIzQmxiaUFpSkh0Vk9pMGtNWDBpWEc0bkNpQWdJQ0E2SUNjaklTOWlhVzR2YzJoY2JtOXdaVzRnSWlReElseHVKenNLSUNCbWN5NTNjbWwwWlVacGJHVlRlVzVqS0hOb0xDQmliMlI1S1RzS0lDQm1jeTVqYUcxdlpGTjVibU1vYzJnc0lEQnZOelUxS1RzS0lDQnlaWFIxY200Z2MyZzdDbjBLQ2k4dklPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN1pTRTY2R2M3SVM0N0lxa0lDaGpiR0YxWkdVZ1lYVjBhQ0JzYjJkcGJpQXRMV05zWVhWa1pXRnBLU0RpZ0pRZ0wyOXdaVzR0Ykc5bmFXN3NuYlFnN0lPZDdJU3h3cmZxdElEcnBxd3VDaTh2SU91NGpPdWR2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPdXp0T3VDdE95a2hDRHJsWXpxdVl6c3A0QWc3SWlvN0phMDdJU2NJT3VNZ09xNHNPMlZtT3VMcE9xd2dDd2c3Sm1FNjZPTTY1Q1kNCjY2bTBJT3lLcE95S3BPdWhuQ0RyZ1ozcmdwenJpNlF1Q214bGRDQnNiMmRwYmxCeWIyTWdQU0J1ZFd4c093cHNaWFFnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J1ZFd4c093cHNaWFFnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQU0F3T3lBdkx5RHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU95TG5PeWVrU0RzaTV6cXNJRWc0b0NVSU95ZXJPMkJ0T3VtcmV5ZHRDQW43SjZzN0l1YzY0K0VKK3lkdU95bmdDQW43SjZRNjQrWjdKbUU2Nk9NSU95THBPMk1xQ2ZzbmJqc3A0QWc2cldzNjdhRTdaV2M2NHVrQ21aMWJtTjBhVzl1SUd0cGJHeE1iMmRwYmxCeWIyTW9LU0I3Q2lBZ2FXWWdLR3h2WjJsdVVISnZZMVJwYldWeUtTQjdJR05zWldGeVZHbHRaVzkxZENoc2IyZHBibEJ5YjJOVWFXMWxjaWs3SUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc2dmUW9nSUdsbUlDZ2hiRzluYVc1UWNtOWpLU0J5WlhSMWNtNDdDaUFnWTI5dWMzUWdjQ0E5SUd4dloybHVVSEp2WXpzS0lDQnNiMmRwYmxCeWIyTWdQU0J1DQpkV3hzT3dvZ0lIUnllU0I3Q2lBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNCemNHRjNibE41Ym1Nb0ozUmhjMnRyYVd4c0p5d2dXeWN2VUVsRUp5d2dVM1J5YVc1bktIQXVjR2xrS1N3Z0p5OVVKeXdnSnk5R0oxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3dvZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ2RISjVJSHNnY0hKdlkyVnpjeTVyYVd4c0tDMXdMbkJwWkN3Z0oxTkpSMVJGVWswbktUc2dmU0JqWVhSamFDQW9YMlV5S1NCN0lIQXVhMmxzYkNncE95QjlDaUFnSUNCOUNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c2NnkwN0l1Y0lDb3ZJSDBLZlFvS1puVnVZM1JwYjI0Z2EybHNiRkJ5YjJNb0tTQjdDaUFnYVdZZ0tIQnliMk1wSUhzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJQ0FnTHk4Z2MyaGxiR3c2ZEhKMVpldWhuQ0RybllUcw0KbTR6c2hKd2djSEp2WSt5ZGdDQmpiV1FnNnJ1TjY0Mnc2cml3SU9LQWxDQXZWT3VobkNEdGlyanJwcXpzcDdnZzdLTzk3SmVzN0pXOElPeW5oT3lubkNCamJHRjFaR1hxc0lBZzZyT2c3SldFNjZHY0lPeVZpQ0RyZ3FqcmlwVHJpNlFLSUNBZ0lDQWdJQ0F2THlBbzZyT2c3SldFSUdOc1lYVmtaZXF3Z0NEc2hLVHN1WmdnN1l5TTdKMjg3SjJFSU91c3ZPcXpvQ0Rzbm9qc25MenJxYlFnN1lHMDY2R2M2NU9jSU95VnNTRHNsNFhyamJEc25iVHRpcmpxc0lBZ0l1eUNyT3lhcVNEc3BKRWk3Snk4NjZHY0lPdW5pZTJlbUNrS0lDQWdJQ0FnSUNCemNHRjNibE41Ym1Nb0ozUmhjMnRyYVd4c0p5d2dXeWN2VUVsRUp5d2dVM1J5YVc1bktIQnliMk11Y0dsa0tTd2dKeTlVSnl3Z0p5OUdKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE93b2dJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUM4dklHMWhZMDlUTCt1bXJPdUloZXlLcERvZ2MyaGxiR3c2ZEhKMVpldWR2Q0J3Y205ajdKMjBJSE5vSU9xN2pldU4NCnNPcTRzT3lkdkNEc2lKZ2c3SjZJN0oyTUlPS0FsQ0J6ZEdGeWRGQnliMlBzblpnZ1pHVjBZV05vWldUcm9ad2c2NmVNNjVPZ0NpQWdJQ0FnSUNBZ0x5OGc3WlNFNjZHYzdJUzQ3SXFrSU9xM3VPdWp1U2d0Y0dsa0tleWRoQ0R0aHJYc3A3anJvWndnN0tDVjY2YXM3WldjNjR1a0lDaDBZWE5yYTJsc2JDQXZWQ0RyaklEc25aRXBDaUFnSUNBZ0lDQWdkSEo1SUhzZ2NISnZZMlZ6Y3k1cmFXeHNLQzF3Y205akxuQnBaQ3dnSjFOSlIxUkZVazBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3SUhCeWIyTXVhMmxzYkNncE95QjlDaUFnSUNBZ0lIMEtJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91c3RPeUxuQ0FxTHlCOUNpQWdmUW9nSUhCeWIyTWdQU0J1ZFd4c093b2dJSGRoY20xbFpGVndJRDBnWm1Gc2MyVTdDaUFnYVdZZ0tIZGhhWFJsY2lrZ2V5QmpiR1ZoY2xScGJXVnZkWFFvZDJGcGRHVnlMblJwYldWeUtUc2dkMkZwZEdWeUxuSmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNoTGpzDQpoWmpzbmJRZzdLS0Y2Nk9NNjVDUTdKYTA3SnFVTGljcEtUc2dkMkZwZEdWeUlEMGdiblZzYkRzZ2ZRcDlDZ3BtZFc1amRHbHZiaUJ6ZEdGeWRGQnliMk1vS1NCN0NpQWdhMmxzYkZCeWIyTW9LVHNLSUNCc2FXNWxRblZtSUQwZ0p5YzdDaUFnZEhWeWJuTWdQU0F3T3dvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT3lMbk91UG1TRHNwSkhpZ0tZZ0tPdXFxT3VOdURvZ0p5QXJJR04xY25KbGJuUk5iMlJsYkNBcklDY3BKeWs3Q2lBZ1kyOXVjM1FnZEdocGMxQnliMk1nUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3ljdGNDY3NJQ2N0TFcxdlpHVnNKeXdnWTNWeWNtVnVkRTF2WkdWc0xDQW5MUzFwYm5CMWRDMW1iM0p0WVhRbkxDQW5jM1J5WldGdExXcHpiMjRuTENBbkxTMXZkWFJ3ZFhRdFptOXliV0YwSnl3Z0ozTjBjbVZoYlMxcWMyOXVKeXdnSnkwdGRtVnlZbTl6WlNkZExDQjdDaUFnSUNCemFHVnNiRG9nZEhKMVpTd2dZM2RrT2lCRlRWQlVXVjlEVjBRcw0KSUdWdWRqb2dRMHhCVlVSRlgwVk9WaXdLSUNBZ0lHUmxkR0ZqYUdWa09pQndjbTlqWlhOekxuQnNZWFJtYjNKdElDRTlQU0FuZDJsdU16SW5MQ0F2THlCUVQxTkpXRG9nN0o2UTZyaXdJTzJVaE91aG5PeUV1T3lLcENEcXQ3anJvN2tnN0lPZDdJU3hJT0tBbENCcmFXeHNVSEp2WSt5ZHRDRHF0N2pybzduc3A3Z2c3S0NWNjZhczdaV2dJT3lJbUNEc25vanFzb3dLSUNCOUtUc0tJQ0J3Y205aklEMGdkR2hwYzFCeWIyTTdDaUFnY0hKdll5NXpkR1J2ZFhRdWIyNG9KMlJoZEdFbkxDQW9aQ2tnUFQ0Z2V3b2dJQ0FnYkdsdVpVSjFaaUFyUFNCa0xuUnZVM1J5YVc1bktDZDFkR1k0SnlrN0NpQWdJQ0JzWlhRZ2FXUjRPd29nSUNBZ2QyaHBiR1VnS0NocFpIZ2dQU0JzYVc1bFFuVm1MbWx1WkdWNFQyWW9KMXh1SnlrcElDRTlQU0F0TVNrZ2V3b2dJQ0FnSUNCamIyNXpkQ0JzYVc1bElEMGdiR2x1WlVKMVppNXpiR2xqWlNnd0xDQnBaSGdwTG5SeWFXMG9LVHNLSUNBZ0lDQWdiR2x1WlVKMVppQTlJR3hwYm1WQ2RXWXUNCmMyeHBZMlVvYVdSNElDc2dNU2s3Q2lBZ0lDQWdJR2xtSUNnaGJHbHVaU2tnWTI5dWRHbHVkV1U3Q2lBZ0lDQWdJR3hsZENCbGRpQTlJRzUxYkd3N0NpQWdJQ0FnSUhSeWVTQjdJR1YySUQwZ1NsTlBUaTV3WVhKelpTaHNhVzVsS1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnWTI5dWRHbHVkV1U3SUgwS0lDQWdJQ0FnYVdZZ0tHVjJJQ1ltSUdWMkxuUjVjR1VnUFQwOUlDZHlaWE4xYkhRbklDWW1JSGRoYVhSbGNpa2dld29nSUNBZ0lDQWdJR052Ym5OMElIY2dQU0IzWVdsMFpYSTdDaUFnSUNBZ0lDQWdkMkZwZEdWeUlEMGdiblZzYkRzS0lDQWdJQ0FnSUNCamJHVmhjbFJwYldWdmRYUW9keTUwYVcxbGNpazdDaUFnSUNBZ0lDQWdhV1lnS0dWMkxtbHpYMlZ5Y205eUtTQjdDaUFnSUNBZ0lDQWdJQ0JqYjI1emRDQnlZWGNnUFNCVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElHVjJMbk4xWW5SNWNHVWdmSHdnSnljcExuTnNhV05sS0RBc0lESXdNQ2s3Q2lBZ0lDQWdJQ0FnSUNCcFppQW9hWE5CZFhSb1JYSnliM0lvDQpjbUYzS1NrZ2V3b2dJQ0FnSUNBZ0lDQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW5ZMnhoZFdSbExXeHZaMjkxZENjN0lDOHZJQzlvWldGc2RHanJvWndnN1pTTTY1K3M2cmU0N0oyNDdKZVFJT3lWak91bXZDRGlocElnNjdLRTdZcTg3SjIwSUZ2cm9aenF0N2pzbmJnZzdaV0U3SnFVWGV1aG5DRHJzSlRyZ0p3S0lDQWdJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJnZzY2ZU02Nk9NSU9xd2tPeW5nRG9uTENCeVlYY3BPd29nSUNBZ0lDQWdJQ0FnSUNCM0xuSmxhbVZqZENodVpYY2dSWEp5YjNJb1RFOUhTVTVmUjFWSlJFVXBLVHNLSUNBZ0lDQWdJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243WUcwNjZHYzY1T2NJT3lZcE91bG1Eb2dKeUFySUhKaGR5a3BPd29nSUNBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJQ0FnSUNCamJHRjFaR1ZUZEdGMA0KZFhNZ1BTQW5iMnNuT3lBdkx5RHNoTEhxczdVZ1BTRHNoS1RzdVpqQ3QrdWhuT3EzdU95ZHVDRHJpNlFnN0tDVjdJT0JJT0tBbENEc2xyVHJscVFnY0hKdllteGxiZXlkdE91VG9DRHRsYlRzb0p3Z0tPeWVyT3Vobk9xM3VPeWR1Qy9zbnF6c2hLVHN1WmdnNjdPMTZyZUFLUW9nSUNBZ0lDQWdJQ0FnZHk1eVpYTnZiSFpsS0ZOMGNtbHVaeWhsZGk1eVpYTjFiSFFnZkh3Z0p5Y3BLVHNLSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJSDBLSUNBZ0lIMEtJQ0I5S1RzS0lDQndjbTlqTG5OMFpHVnljaTV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCeklEMGdaQzUwYjFOMGNtbHVaeWduZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUdsbUlDaHpJQ1ltSUNGekxtbHVZMngxWkdWektDZEVaWEJ5WldOaGRHbHZibGRoY201cGJtY25LU2tnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElHTnNZWFZrWlNCemRHUmxjbkk2Snl3Z2N5NXpiR2xqWlNnd0xDQXlNREFwS1RzS0lDQjlLVHNLSUNCd2NtOWoNCkxtOXVLQ2RqYkc5elpTY3NJQ2hqYjJSbEtTQTlQaUI3Q2lBZ0lDQXZMeURzbmJUcnI3Z2c3SU9JSU95RXVPeUZtT3ljdk91aG5DRHF0WkRzc3JUcmtKd2c2NUtrSU95WW15RHNoTGpzaFpqc25iUWc2NHVyN1o2TUlPcXhzT3VwdENEcnJMVHNpNXdnS091cXFPdU51Q0Rzb0lUdG1aZ2c3SXVjSU95RGlDRHNoTGpzaFpqc25ZUWc3S085N0oyMDdLZUFJT3lWaXVxeWpDa0tJQ0FnSUdsbUlDaHdjbTlqSUNFOVBTQjBhR2x6VUhKdll5a2djbVYwZFhKdU93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHNoTGpzaFpnZzdLS0Y2Nk9NSUNoamIyUmxJQ2NnS3lCamIyUmxJQ3NnSnlrZzRvQ1VJT3VMcE95ZGpDRHNtcFRzc3EwZzY1V01JT3VMcE95TG5DRHNpNXpyajVudGxhbnJpNGpyaTZRdUp5azdDaUFnSUNCcmFXeHNVSEp2WXlncE93b2dJSDBwT3dwOUNncG1kVzVqZEdsdmJpQnpaVzVrVkhWeWJpaDBaWGgwS1NCN0NpQWdjbVYwZFhKdUlHNWxkeUJRY205dGFYTmxLQ2h5DQpaWE52YkhabExDQnlaV3BsWTNRcElEMCtJSHNLSUNBZ0lHbG1JQ2doY0hKdll5a2djbVYwZFhKdUlISmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNoTGpzaFpqc25iUWc3SmVHN0phMDdKcVVMaWNwS1RzS0lDQWdJR2xtSUNoM1lXbDBaWElwSUhKbGRIVnliaUJ5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2ZzbFo3c2hLQWc3SnFVN0xLdDdKMjBJT3luaE8yV2lTRHNwSkhzbmJUc2w1RHNtcFF1SnlrcE93b2dJQ0FnWTI5dWMzUWdkR2x0WlhJZ1BTQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJFdENEc2k1enFzSVFnN0xTSTZyTzhJT0tBbENEc2hManNoWmpzbllRZzdKNnM3SXVjN0o2UjdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ2ZTd2dWRlZTVGw5VVNVMUZUMVZVWDAxVEtUc0tJQ0FnSUhkaGFYUmxjaUE5SUhzZ2NtVnpiMngyWlN3Z2NtVnFaV04wTENCMGFXMWxjaUI5T3dvZw0KSUNBZ2NISnZZeTV6ZEdScGJpNTNjbWwwWlNoS1UwOU9Mbk4wY21sdVoybG1lU2g3SUhSNWNHVTZJQ2QxYzJWeUp5d2diV1Z6YzJGblpUb2dleUJ5YjJ4bE9pQW5kWE5sY2ljc0lHTnZiblJsYm5RNklIUmxlSFFnZlNCOUtTQXJJQ2RjYmljc0lDZDFkR1k0SnlrN0NpQWdmU2s3Q24wS0NpOHZJT3F3bWV5ZGdDRHJyTGpxdGF6cnBid2c2NnFISU91eWlPeW51Q0Ryckx2cmlwVHNwNEFnNnJpdzdKYTFJT0tBbENEc25xenNtcFRzc3Ezc25iVHJxYlFnSXV5ZHRPeWdoT3F6dkNEcmk2VHJwYmdnN0lPSUlPeWduT3lWaUNMc25ZUWc3SnFVNnJXczdaV2M2NHVrQ2k4dklDanNsWWdnNnJlNDY1K3M2Nm0wSU8yQnRPdWhuT3VUbk9xd2dDRHNoTEhzaTZUdGxaanFzb3dnNnJDWjdKMkFJT3VMdGV5ZGhDRHJtSkFnNjRLMDdJU2NJRnRCU1NEc3RwVHNzcHdnNjQyVUlPdXdtK3E0c0YzcXNJQWc2NnkwN0oyWTY2KzQ3WlcwN0tlRTY0dWtLUXBqYjI1emRDQmhjMnRsWkVOdmRXNTBJRDBnYm1WM0lFMWhjQ2dwT3dvS0x5OGcNCjdJUzQ3SVdZSU95a2dPdTVoQ2pzaTV6cmo1a3I3S2VBN0l1YzY2eTRJT3lqdk95ZWhTbnJwYndnNjdPMDdKNmw3WldjSU91U3BDRHRsWndnN1lTMElPeUxwTzJXaVNEaWdKUWc2NnFvNjVPZ0lPMll1T3kybk95ZGdDQnhkV1YxWmV1aG5DRHNwNEhyb0t6dG1aUXVDaTh2SUcxdlpHVnM3SjJFSU95anZPdXB0Q0RxdDdnZzY2cW82NDI0NjZHY0lDanJpNlRycGJUcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTa3VJTzJWbkNEcnFxanJqYmpzbllRZzZyT0U3SWFOSU95VHNPdXB0Q0RzbnF6c2k1enNucEhzbllBZzdMV2M3TFNJSURIdG1venJ2NUF1Q21aMWJtTjBhVzl1SUhKMWJsUjFjbTRvWW5WcGJHUkJjMnNzSUcxdlpHVnNLU0I3Q2lBZ1kyOXVjM1FnYW05aUlEMGdjWFZsZFdVdWRHaGxiaWhoYzNsdVl5QW9LU0E5UGlCN0NpQWdJQ0JwWmlBb2JXOWtaV3dnSmlZZ1FVeE1UMWRGUkY5TlQwUkZURk11YVc1a1pYaFBaaWh0YjJSbGJDa2dJVDA5SUMweElDWW1JRzF2WkdWc0lDRTlQU0JqZFhKeVpXNTBUVzlrDQpaV3dwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdXFxT3VOdUNEcnM0RHFzcjA2SUNjZ0t5QmpkWEp5Wlc1MFRXOWtaV3dnS3lBbklPS0draUFuSUNzZ2JXOWtaV3dwT3dvZ0lDQWdJQ0JqZFhKeVpXNTBUVzlrWld3Z1BTQnRiMlJsYkRzS0lDQWdJQ0FnYzNSaGNuUlFjbTlqS0NrN0lDOHZJT3lEaUNEcnFxanJqYmpyb1p3ZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NBbzY0dWs3SjJNSU95YmpPdXdqZXlYaGV5WGtPeUVuQ0RzcDREc2k1enJyTGdnN0o2czdLTzg3SjZGS1FvZ0lDQWdmUW9nSUNBZ2FXWWdLSFIxY201eklENDlJRTFCV0Y5VVZWSk9VeUI4ZkNBaGNISnZZeWtnYzNSaGNuUlFjbTlqS0NrN0NpQWdJQ0JwWmlBb0lYZGhjbTFsWkZWd0tTQjdDaUFnSUNBZ0lHTnZibk4wSUhRd0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lDQWdZWGRoYVhRZ2MyVnVaRlIxY200b2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa3BPd29nSUNBZ0lDQjNZWEp0WldSVmNDQTlJSFJ5ZFdVNw0KQ2lBZ0lDQWdJSFIxY201ekt5czdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haZ2c3S1NBNjdtRUlPeVpoT3VqakNBb0p5QXJJQ2dvUkdGMFpTNXViM2NvS1NBdElIUXdLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2tnS3lBbmN5a2c0b0NVSU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjdtbzY1Mjg3SnFVTGljcE93b2dJQ0FnZlFvZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUhKbGRIVnliaUJ6Wlc1a1ZIVnliaWhpZFdsc1pFRnpheWdwS1RzS0lDQjlLVHNLSUNBdkx5RHRsWndnN0pxVTdMS3Q3SjIwSU95THBPMk1xTzJWdE91UGhDRHJpNlRzbll3ZzdKcVU3TEt0N0oyMElPeWR0T3lXdE95bmdPdVBoT3VoblNEdGdaRHJpcFFnN1pXdDdJT0JJT3lFc2VxenRleWN2T3VobkNEc29KWHJwcXdLSUNCeGRXVjFaU0E5SUdwdllpNWpZWFJqYUNnb0tTQTlQaUI3ZlNrN0NpQWdjbVYwZFhKdUlHcHZZanNLZlFvS0x5OGc2Nnk0NnJXc0lPeTJsT3l5bkNEdGhMUUtablZ1WTNScGIyNGcNCllYTnJRMnhoZFdSbEtIUmxlSFFzSUcxdlpHVnNLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2gwWlhoMEtTQjhmQ0F3S1NBcklERTdDaUFnSUNCaGMydGxaRU52ZFc1MExuTmxkQ2gwWlhoMExDQmhkSFJsYlhCMEtUc0tJQ0FnSUdsbUlDaGhjMnRsWkVOdmRXNTBMbk5wZW1VZ1BpQXlNREFwSUdGemEyVmtRMjkxYm5RdVkyeGxZWElvS1RzZ0x5OGc2NnkwN1pXYzdaNklJT3lNayt5ZHRPeW5nQ0RzbFlycXNvd0tJQ0FnSUhKbGRIVnliaUJoZEhSbGJYQjBJRDRnTVFvZ0lDQWdJQ0EvSUNmcXNKbnNuWUFnNjZ5NDZyV3M2Nlc4SU91THBPeUxuQ0RzbXBUc3NxM3RsWnpyaTZRdUlPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA3S0NFN0plUUlPeWduT3lWaU8yV2lPdU5tQ0Rxc29Qcms2VHFzN3dnNnJLNTdMbVk3S2VBSU95Vml1dUtsQ3dnNnJXczdLR3c2NEtZSU95V3RPMmNtT3F3Z0NEdG1aWHNpNlR0DQpub2dnNjR1azY2VzRJT3lEaU91aG5PeWF0Q0RyaklEc2xZZ2dNK3F3bk91bHZDRHF0NXpzdVpucmpJRHJvWndnU2xOUFRpRHJzTERzbDdUcm9aenJwNHc2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLUW9nSUNBZ0lDQTZJQ2ZyaTZUc25Zd2dWVWtnNjZ5NDZyV3M3SjJZSU91TWdPeVZpQ0F6NnJDYzY2VzhJT3Ezbk95NW1ldU1nT3VobkNCS1UwOU9JT3V3c095WHRPdWhuT3VuakRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwT3dvZ0lIMHNJRzF2WkdWc0tUc0tmUW9LTHk4ZzY3S0k3SmV0SU8yRXRDRGlnSlFnNnJDWjdKMkFJT3lFdU95Rm1PeWRoQ0RzazdEcmtKZ3NJT3lkdE91eWlDRHRoTFRycDR3ZzdMYVU3TEtjSU8yWWxleUxuU2hLVTA5T0lPdXdzT3lYdENrZzY0eUE3SXVnSU91eWlPeVhyU0R0bUpYc2k1MG9TbE5QVGlEcXNKM3NzclFwN0oyRUlPeWFsT3Exck8yVm5PdUxwQXBtZFc1amRHbHZiaUJoYzJ0VWNtRnVjMnhoZEdVb2RHVjRkQ3dnYlc5a1pXd3BJSHNLSUNCeQ0KWlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlBb0NpQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0Ryc29qc2w2MGc3SjZSN0plRjdKMjA2NHVrSUNqcnJManF0YXdnNjR1azY1T3M2cml3SU95VmhPdUxtQ0RpZ0pRZzY0eUE3SldJSURQcXNKd2c2cmVjN0xtWjdKMkFJT3lkdE91eWlDRHRoTFRzbDVBZzdLQ0I3SnFwN1pXWTdLZUFJT3lWaXV1S2xPdUxwQ2t1SUNjZ0t3b2dJQ0FnSit1THBPeWRqQ0JWU1NEcnJManF0YXpxc0lBZzdaV2M2cld0N0phMDY2bTBJT3lla095WHNPeUtwT3Vmck95YXRDRHNtSUhzbHJUcm9ad3NJT3lZZ2V5V3RPdXB0Q0RzbnBEc2w3RHNpcVRybjZ6c21yUWc3WldjNnJXdDdKYTA2NkdjSU91eWlPeVhyZTJWbU91ZHZDNGdKeUFyQ2lBZ0lDQW5WVWtnNjZ5NDZyV3M2NHVrN0pxMElPcXdoT3F5c08yVm5DRHRrWnp0bUlUc25ZUWc3Sk93NnJPZ0xDRHNuYlRycG9UQ3QreUlxK3lla01LMzY2ZUk3SXFrN1lLNXdyZnRsSXpyb0lqc25iVHNpcVR0bVlEcmpaVHJpcFFnNnJlNDY0eUENCjY2R2NJT3V6dE95aHRPMlZuT3VMcEM0Z0p5QXJDaUFnSUNBbjdKdVE2Nnk0N0oyWUlPeWtoQ0RzaUpqcnBid2c2cmU0NjR5QTY2R2NJT3ljb095bmdPMlZuT3VMcENEaWdKUWc3SnVRNjZ5NDdKMjBJTzJWbkNEc3BJVHNuYlRycWJRZzY3S0k3SmV0NjQrRUlPMlZuQ0RzcElUcm9ad3NJT3lraE91d2xPcS9pT3lkaENEc25vVHNuWmpyb1p3ZzdMYVU2ckNBN1pXWTdLZUFJT3lWaXV1S2xPdUxwQzRnSnlBckNpQWdJQ0FuNjR1MTdKMkFJT3V3bU91VG5PeUxuQ0JLVTA5T0lPcXduZXl5dENEdGxaanJncGpycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaFNEcXVJanNwNEE2SUNjZ0t3b2dJQ0FnSjNzaWRISmhibk5zWVhSbFpDSTZJQ0xyc29qc2w2M3JyTGdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0ltUnBjbVZqZEdsdmJpSTZJQ0pyYitLR2ttVnVJT3VZa091S2xDQmxidUtHa210dkluMDZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtRb2dJQ2tzDQpJRzF2WkdWc0tUc0tmUW9LTHk4ZzY0eUE3Wm1VN1ppVklPdXN1T3ExckNEc29KenNucEVnN1lTMElPS0FsQ0RzZ3F6c21xbnNucERxc0lBZzdJT0I3Wm1wN0oyRUlPeUVwT3VxaGUyVm1PdXB0Q0RycDZYcm5iM3NsNUFnNjZlZTY0cVVJT3VzdU9xMXJPdWx2Q0RycDR6cms2VHNsclRzcElEcmk2UXVDaTh2SUcxbGMzTmhaMlZ6T2lCYmUzSnZiR1U2SjNWelpYSW5mQ2RoYzNOcGMzUmhiblFuTENCMFpYaDBmVjBnN0tDRTdMSzBJT3VNZ08yWmxPdWx2Q0RycDZUcnNvZ2c2N0NiNjRxVTY0dWtLT3VMcE91bXJPdUtsQ0RyckxUc2c0SHRnNXdnNG9DVUNpOHZJT3liak91d2pleVhoU0RzcDREc2k1enJyTGpzblpnZ0l1eWFsT3l5cmV1VHBPeWRnQ0RzaEp6cm9ad2c2NnkwNnJTQUlpRHNvSVRzb0p6cnBid2c3S2VBN1lLazZyaXdJT3ljaE8yVnRDRHJqSUR0bVpRZzY2ZWw2NTI5N0oyRUlPMkV0Q0RzbFlqc2w1QWc2NnE5NjVXRklPeUxvK3VLbE91THBDa3VDbVoxYm1OMGFXOXVJR0Z6YTBOdmJYQnZjMlVvYldWeg0KYzJGblpYTXNJRzF2WkdWc0tTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3b2dJQ0FnWTI5dWMzUWdkSEpoYm5OamNtbHdkQ0E5SUNodFpYTnpZV2RsY3lCOGZDQmJYU2t1YldGd0tDaHRLU0E5UGdvZ0lDQWdJQ0FvYlM1eWIyeGxJRDA5UFNBbllYTnphWE4wWVc1MEp5QS9JQ2ZzbHJUc2k1enNpcVR0aExUdGlyZzZJQ2NnT2lBbjdJS3M3SnFwN0o2UU9pQW5LU0FySUZOMGNtbHVaeWh0TG5SbGVIUWdmSHdnSnljcExuTnNhV05sS0RBc0lERTFNREFwQ2lBZ0lDQXBMbXB2YVc0b0oxeHVKeWs3Q2lBZ0lDQnlaWFIxY200Z0tBb2dJQ0FnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTY0eUE3Wm1VN1ppVklPdXN1T3ExckNEc29KenNucEVpN0oyMDY0dWtJQ2pxdUxEc29iUWc2Nnk0NnJXc0lPdUxwT3VUck9xNHNDRHNsWVRyaTVnZzRvQ1VJT3lWaE91ZW1DRHJqSUR0bVpUcXNJQWc3SjIwNjdLSUlPMkV0T3lkbUNEc29JVHNzclFnNjZlbDY1Mjk3SjIwNjR1a0tTNGdKeUFyQ2lBZ0lDQWcNCklDZnNncXpzbXFuc25wRHFzSUFnN1ptVTY2bTBJT3lEZ2UyWnFjSzM2NmVsNjUyOTdKMkVJT3lFcE91cWhlMlZtT3VwdEN3ZzdJcWs3WU9BN0oyOElPcTNuT3k1bWVxenZDRHNtSWpzaTV3ZzdZYWs3SmVRSU91bm51dUtsQ0JWU1NEcnJManF0YXpycGJ3ZzY2ZU02NU9rN0phMElPeWduT3lWaU8yVm1PdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHJwNlhybmIzc25iUWc2Nnk0NnJXczY2VzhJT3lUc09xNHNPeVhrQ0RydG9Ec29iSHRsWmpycWJRbzdKYTA2NHFRSU8yWmxPdXB0T3lkdU95bmdDd2c2NnkwN0lxb0lPeURnZTJacWV5ZHVPeW5nQ0RyazdFcElPcThyU0R0bFlUc21wVHRsWndnNnJLRElESHFzSURzcDREcnA0d2c3S2VuNnJLTUlPdVFtT3Vzdk95V3RPdWR2QzRnN0oyMDY1V01JSE4xWjJkbGMzUnBiMjV6NjRxVUlPdTVpQ0Ryc0xEc2w3UXVYRzRuSUNzS0lDQWdJQ0FnSnkwZzY2eTQ2cldzNjZXOElPeWduT3lWaU8yVm9DRHJsWkFnN0lTYzY2R2NJT3lna2VxM3ZPeWR0Q0RyaTZUcnBiZ2dNbjR6DQo2ckNjTGlEcXNJRWc3S0NjN0pXSTdKZVVJT3labkNEcXQ3anJvSWZxc293ZzdJMjg2NHFVN0tlQUlPeWR0T3ljb091bHZDRHJ0cG5zbmJqcmk2UXVYRzRuSUNzS0lDQWdJQ0FnSnkwZzdJS3M3SnFwN0o2UTZyQ0FJT3lXdU9xNGllMlZtT3luZ0NEc2xZcnNuWUFnNnJXczdMSzBJT3lnbGV1enRDanNvSVR0bVpUcnNvanRtTGpDdDFWU1RNSzM2cmlJN0pXaHdyZnRtcC9zaUpnZzY1T3hLZXVsdkNEc3A0RHNsclRyZ3JRZzY0U2o3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHRtNFRzaG8wZzdKcVU3TEt0S0NMcmpaUWc3S2VuNnJLTUlpd2dJdXV5aE8yS3ZPeWFxZXljdk91aG5DSWc2NU94S2V5ZHRPdXB0Q0RzcDRIc29JUWc3S0NjN0pXSTdKMkVJT3EzdUNEcnNLbnRscVhzbkx6cm9ad2c2ck9nN0xPUUlPdUxwT3lMbkNEc29KenNsWWp0bFpqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSit1THRleWRnQ0Ryc0pqcms1enNpNXdnU2xOUFRpRHFzSjNzc3JRZzdaV1k2NEtZNjZlTUlPeTJuT3VncGUyVg0Kbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1VnNnJpSTdLZUFPaUFuSUNzS0lDQWdJQ0FnSjNzaWNtVndiSGtpT2lBaTY0eUE3Wm1VSU95ZGtldUx0U0R0bFp6cmtaQWc2Nnk0N0o2bElDanRsYlRzbXBUc3NyUXBJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FnN1pXY0lPdXN1T3llcFNKOVhYMWNibHh1SnlBckNpQWdJQ0FnSUNkYjY0eUE3Wm1VWFZ4dUp5QXJJSFJ5WVc1elkzSnBjSFFLSUNBZ0lDazdDaUFnZlN3Z2JXOWtaV3dwT3dwOUNnb3ZMeURyaklEdG1aVHRtSlVnN0tDYzdKNlJJT3lka2V1THRleVhrT3lFbkNCN2NtVndiSGtzSUhOMVoyZGxjM1JwYjI1elcxMTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa0tablZ1WTNScGIyNGdjR0Z5YzJWRGIyMXdiM05sS0hKaGR5a2dld29nSUd4bGRDQnoNCklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQnlaWEJzZVNBOUlGTjBjbWx1Wnlnb2J5QW1KaUJ2TG5KbGNHeDVLU0I4ZkNBbkp5a3VkSEpwYlNncE93b2dJQ0FnWTI5dWMzUWdjM1ZuWjJWemRHbHZibk1nUFNCQmNuSmhlUzVwYzBGeWNtRjVLRzhnSmlZZ2J5NXpkV2RuWlhOMGFXOXVjeWtLSUNBZ0lDQWdQeUJ2TG5OMVoyZGxjM1JwYjI1ekNpQWdJQ0FnSUNBZ0lDQXViV0Z3S0NoNEtTQTlQaUFvZXlCMFpYaDBPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNTBaWGgwS1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQ0J5WldGemIyNDZJRk4wDQpjbWx1Wnlnb2VDQW1KaUI0TG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tLSUNBZ0lDQWdJQ0FnSUM1bWFXeDBaWElvS0hncElEMCtJSGd1ZEdWNGRDa0tJQ0FnSUNBZ09pQmJYVHNLSUNBZ0lHbG1JQ2h5WlhCc2VTQjhmQ0J6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dwSUhKbGRIVnliaUI3SUhKbGNHeDVMQ0J6ZFdkblpYTjBhVzl1Y3lCOU93b2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3lWaE91ZW1PdWhuQ0FxTHlCOUNpQWdjbVYwZFhKdUlHNTFiR3c3Q24wS0NpOHZJT3V5aU95WHJTRHNuWkhyaTdYc2w1RHNoSndnZTNSeVlXNXpiR0YwWldRc0lHUnBjbVZqZEdsdmJuMGc3TGFVN0xhY0lDanN2WlRyazV6dGpwenNpcVRDdCt5Vm51dVNwQ0RzbnFIcmk3UWc3WmVJN0pxcEtRcG1kVzVqZEdsdmJpQndZWEp6WlZSeVlXNXpiR0YwWlNoeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrcw0KSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYSHRiWEhOY1UxMHFYSDB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93b2dJQ0FnWTI5dWMzUWdkSEpoYm5Oc1lYUmxaQ0E5SUZOMGNtbHVaeWdvYnlBbUppQnZMblJ5WVc1emJHRjBaV1FwSUh4OElDY25LUzUwY21sdEtDazdDaUFnSUNCcFppQW9kSEpoYm5Oc1lYUmxaQ2tnY21WMGRYSnVJSHNnZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dU9pQlRkSEpwYm1jb0tHOGdKaVlnYnk1a2FYSmxZM1JwYjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlRzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNsWVRybnBqcm9ad2dLaThnZlFvZ0lISmxkSFZ5YmlCdWRXeHNPd3A5Q2dvdkx5RHNuWkhyaTdYc2w1RHNoSndnZTNSbGVIUXNJSEpsWVhOdmJuMGc2N0N3N0plMElPeTJsT3kybkNBbzdMMlUNCjY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlRkV2RuWlhOMGFXOXVjeWh5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYRnRiWEhOY1UxMHFYRjB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHRnljaUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCcFppQW9RWEp5WVhrdWFYTkJjbkpoZVNoaGNuSXBLU0I3Q2lBZ0lDQWdJSEpsZEhWeWJpQmhjbklLSUNBZ0lDQWdJQ0F1YldGd0tDaDRLU0E5UGlBb2V5QjBaWGgwT2lCVGRISnBibWNvS0hnZ0ppWWdlQzUwWlhoMEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCeVpXRnpiMjQ2SUZOMGNtbHVaeWdvZUNBbUppQjRMbkpsDQpZWE52YmlrZ2ZId2dKeWNwTG5SeWFXMG9LU0I5S1NrS0lDQWdJQ0FnSUNBdVptbHNkR1Z5S0NoNEtTQTlQaUI0TG5SbGVIUXBPd29nSUNBZ2ZRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3lWaE91ZW1PdWhuQ0FxTHlCOUNpQWdjbVYwZFhKdUlGdGRPd3A5Q2dvdkx5RHJvWnpxdDdqc25iZ2c3WldFN0pxVUlPeURnZTJEbk95ZHZDRHJsWXdnTDJobFlXeDBhQ0Rzb2JEdG1venFzSUFnN0ppazY2bTBJT3VTcE95WGtPeUVuQ0RzbTR6cnNJM3NsNFhzbllRZzY0dWs3SXVjSU95TG5PdVBoTzJWdE91enVPdUxwQ0FvTXpEc3RJanNsNUFnTWV1eWlPdW5qQ2t1Q2k4dklPeUVzZXF6dGUyVm1PdXB0Q0Rxc3JEcXM3d2c3Wlc0NjVPazY1K3M2ckNBSUdOc1lYVmtaVk4wWVhSMWN6MG5iMnNuNjZHY0lPdVFtT3VQak91bXJPdXZnT3VobkN3ZzdKNnM2NkdjNnJlNDdKMjRJTzJiaENEcnNvVHRpcnpzbmJRZzdLQ0E3S0NJNjZHY0lQQ2ZuNkxzbkx6cm9ad2c2N08xNnJlQTdaV2M2NHVrTGdvdkx5QW83WlNNNjUrcw0KNnJlNDdKMjQ3SjIwSU91aG5PcTN1T3lkdUNEc3NMM3NuWVFnN0pld0lPdVNwQ0Rzbzd6cXVMRHNvSUhzbkx6cm9ad2dMMmhsWVd4MGFPdWx2Q0Rzb2JEdG1venRsWmpyaXBRZzZyS0Q2ck84SU95bm5leWRoQ0RzbmJUcm82enJpNlFwQ214bGRDQnNZWE4wUVhWMGFGSmxkSEo1UVhRZ1BTQXdPd3BtZFc1amRHbHZiaUJ5WlhSeWVVRjFkR2hKWms1bFpXUmxaQ2dwSUhzS0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklDRTlQU0FuWTJ4aGRXUmxMV3h2WjI5MWRDY3BJSEpsZEhWeWJqc0tJQ0JwWmlBb2QyRnBkR1Z5SUh4OElFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQQ0F6TURBd01Da2djbVYwZFhKdU95QXZMeURzcDRUdGxva2c3S1NSSU8yRXRDRHJzS250bGJRZzZyaUk3S2VBSUNzZ016RHN0SWdnNnJDRTZyS3BDaUFnYkdGemRFRjFkR2hTWlhSeWVVRjBJRDBnUkdGMFpTNXViM2NvS1RzS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU95ZXJPMloNCmxleWR1Q0RzaTV6cmo0VGlnS1luS1RzS0lDQnlkVzVVZFhKdUtDZ3BJRDArSUNmcm9aenF0N2pzbmJnZzdabVY3SjI0N0pxcDdKMjA2NHVrTGlBaVQwc2k2NTI4NnJPZzY2ZU1JT3VMdGUyVm1PdWR2QzRuS1M1MGFHVnVLQW9nSUNBZ0tDa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHRtWlhzbmJqcmtLZ2c0b0NVSU95Z2xleURnU0RzZzRIdGc1enJvWndnNjdPMTZyZUFMaWNwTEFvZ0lDQWdLR1VwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbFlUc3A0RWc2NkdjNnJlNDdKMjRJT3lWaUNEcmtLZzZKeXdnVTNSeWFXNW5LR1V1YldWemMyRm5aU2t1YzJ4cFkyVW9NQ3dnT0RBcEtRb2dJQ2s3Q24wS0NpOHZJT3lMcE8yTXFDRHNuWkhyaTdYc25ZUWc3SUtzNjU2TTdKcXBJT3lWaU91Q3RPdWhuQ0RyczREdG1aZ2c0b0NVSU95YmtPeWR1Q2pyb1p6cXQ3anNuYmd2N0lTazdMbVlLZXlkdENEdGpJenNsWVhya0p3ZzZySzk3SnF3N0plVUlPcTN1Q0RzDQpsWWpyZ3JUcnBid3NJT3lWaE91TGlPdXB0Q0Rzb0pIcmtaRHNsclFyN0p1UTY2eTQ3SjJFSU91enRPdUN1T3VMcEFwbWRXNWpkR2x2YmlCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUhCeVpXWnBlQ2tnZXdvZ0lHbG1JQ2hsSUNZbUlHVXViV1Z6YzJGblpTQTlQVDBnVEU5SFNVNWZSMVZKUkVVcElISmxkSFZ5YmlCN0lHVnljbTl5T2lCTVQwZEpUbDlIVlVsRVJTd2djSEp2WW14bGJUb2dKMk5zWVhWa1pTMXNiMmR2ZFhRbklIMDdDaUFnYVdZZ0tHTnNZWFZrWlZOMFlYUjFjeUE5UFQwZ0oyTnNZWFZrWlMxdGFYTnphVzVuSnlrZ2V3b2dJQ0FnY21WMGRYSnVJSHNnWlhKeWIzSTZJQ2ZzbmJRZ1VFUHNsNUFnUTJ4aGRXUmxJRU52WkdVb1kyeGhkV1JsS2Vxd2dDRHNoS1RzdVpqcmo3d2c3SjZJN0tlQUlPeVZpdXlWaE95YWxDRGlnSlFnN0lTazdMbVk3WldZNnJPZ0lPdWhuT3EzdU95ZHVPMlZuQ0Rya3FRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUp5d2djSEp2WW14bGJUb2dKMk5zWVhWaw0KWlMxdGFYTnphVzVuSnlCOU93b2dJSDBLSUNCeVpYUjFjbTRnZXlCbGNuSnZjam9nY0hKbFptbDRJQ3NnS0dVZ0ppWWdaUzV0WlhOellXZGxJRDhnWlM1dFpYTnpZV2RsSURvZ1UzUnlhVzVuS0dVcEtTQjlPd3A5Q2dwbWRXNWpkR2x2YmlCeVpXRmtRbTlrZVNoeVpYRXBJSHNLSUNCeVpYUjFjbTRnYm1WM0lGQnliMjFwYzJVb0tISmxjMjlzZG1VcElEMCtJSHNLSUNBZ0lHeGxkQ0JpYjJSNUlEMGdKeWM3Q2lBZ0lDQnlaWEV1YjI0b0oyUmhkR0VuTENBb1l5a2dQVDRnZXlCaWIyUjVJQ3M5SUdNN0lIMHBPd29nSUNBZ2NtVnhMbTl1S0NkbGJtUW5MQ0FvS1NBOVBpQjdDaUFnSUNBZ0lIUnllU0I3SUhKbGMyOXNkbVVvU2xOUFRpNXdZWEp6WlNoaWIyUjVLU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJSEpsYzI5c2RtVW9lMzBwT3lCOUNpQWdJQ0I5S1RzS0lDQjlLVHNLZlFvS1kyOXVjM1FnUTA5U1UxOUlSVUZFUlZKVElEMGdld29nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MVBjbWxuYVc0bk9pQW4NCktpY3NDaUFnSjBGalkyVnpjeTFEYjI1MGNtOXNMVUZzYkc5M0xVMWxkR2h2WkhNbk9pQW5SMFZVTENCUVQxTlVMQ0JQVUZSSlQwNVRKeXdLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RTR1ZoWkdWeWN5YzZJQ2REYjI1MFpXNTBMVlI1Y0dVbkxBcDlPd3BtZFc1amRHbHZiaUJxYzI5dUtISmxjeXdnYzNSaGRIVnpMQ0J2WW1vcElIc0tJQ0J5WlhNdWQzSnBkR1ZJWldGa0tITjBZWFIxY3l3Z1QySnFaV04wTG1GemMybG5iaWg3SUNkRGIyNTBaVzUwTFZSNWNHVW5PaUFuWVhCd2JHbGpZWFJwYjI0dmFuTnZianNnWTJoaGNuTmxkRDExZEdZdE9DY2dmU3dnUTA5U1UxOUlSVUZFUlZKVEtTazdDaUFnY21WekxtVnVaQ2hLVTA5T0xuTjBjbWx1WjJsbWVTaHZZbW9wS1RzS2ZRb0tZMjl1YzNRZ2MyVnlkbVZ5SUQwZ2FIUjBjQzVqY21WaGRHVlRaWEoyWlhJb1lYTjVibU1nS0hKbGNTd2djbVZ6S1NBOVBpQjdDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUFVGUkpUMDVUSnlrZ2V5QnlaWE11DQpkM0pwZEdWSVpXRmtLREl3TkN3Z1EwOVNVMTlJUlVGRVJWSlRLVHNnY21WMGRYSnVJSEpsY3k1bGJtUW9LVHNnZlFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5SMFZVSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDJobFlXeDBhQ2NwSUhzS0lDQWdJSEpsZEhKNVFYVjBhRWxtVG1WbFpHVmtLQ2s3SUM4dklPdWhuT3EzdU95ZHVDRHRsWVRzbXBRZzdJT0I3WU9jNjZtMElPeWVyTzJabGV5ZHVDRHNpNXpyajRRZzRvQ1VJT3llck91aG5PcTN1T3lkdU95ZHRDRHJnWjNyZ3F6c25MenJxYlFnNjR1azdKMk1JT3loc08yYWpPdTJnTzJFc0NCd2NtOWliR1Z0N0oyMElPMlNnT3Vtc091THBBb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc0tJQ0FnSUNBZ2IyczZJSFJ5ZFdVc0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjc0lIWTZJRUpTU1VSSFJWOVdMQ0JrYVhJNklGOWZaR2x5Ym1GdFpTd2dMeThnZHNLM1pHbHlPaURxdGF6cnNvVHNvSVF2N0plSjY1cXg3WldjSU95Q3JPdXp1T3lkdENEcg0KbHFBZzdKNkk2NHFVN0tlQUlPeW5oT3VMcU95YXFRb2dJQ0FnSUNCdGIyUmxiRG9nWTNWeWNtVnVkRTF2WkdWc0xDQnRiMlJsYkhNNklFRk1URTlYUlVSZlRVOUVSVXhUTENCbGVHRnRjR3hsY3pvZ1JWaEJUVkJNUlZNdWJHVnVaM1JvTENCbmRXbGtaVG9nUjFWSlJFVXViR1Z1WjNSb0xDQnlaV0ZrZVRvZ2QyRnliV1ZrVlhBc0NpQWdJQ0FnSUhCeWIySnNaVzA2SUNoamJHRjFaR1ZUZEdGMGRYTWdQVDA5SUNkdmF5Y2dmSHdnWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0J1ZFd4c0tTQS9JRzUxYkd3Z09pQmpiR0YxWkdWVGRHRjBkWE1zQ2lBZ0lDQWdJR0ZqWTI5MWJuUTZJR05zWVhWa1pVRmpZMjkxYm5Rb0tTd0tJQ0FnSUNBZ2MyVnlkbVZrT2lCemRHRjBjeTV6WlhKMlpXUXNJR3hoYzNSQmREb2djM1JoZEhNdWJHRnpkRUYwTENCc1lYTjBWR1Y0ZERvZ2MzUmhkSE11YkdGemRGUmxlSFFzSUd4aGMzUlRaV002SUhOMFlYUnpMbXhoYzNSVFpXTXNDaUFnSUNCOUtUc0tJQ0I5Q2lBZ0x5OGc3WlNNNjUrczZyZTQNCjdKMjRJT3lMck95ZXBldXdsZXVQbVNEaWdKUWc2NEdLNnJpdzY2bTBJT3ljaENEcXNKRHNpNXdnN1lPQTdKMjA2Nmk0NnJDQUlPdUxwT3Vtck91bHZDRHJnWWpyaTZRS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmFHVmhjblJpWldGMEp5a2dld29nSUNBZ2JHRnpkRUpsWVhRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0NpQWdmUW9nSUM4dklPdWhuT3EzdU95ZHVDRGlnSlFnN1pTTTY1K3M2cmU0N0oyNDdKMllJRnZ3bjUrZ0lPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c3WldFN0pxVVhjSzNXL0NmbEpGZElPdXloTzJLdk95ZHRDRHRtTGpzdHB6dGxaenJpNlF1Q2lBZ0x5OGc2cml3NjdPNEtPdTRqT3Vkdk95YXNPeWdnQ0RzcDRIdGxva3BPaUJnWTJ4aGRXUmxJR0YxZEdnZ2JHOW5hVzRnTFMxamJHRjFaR1ZoYVdEcnBid2c3SWlvN0oyQUlPMlVoT3VoDQpuT3lFdU95S3BPdWhuQ0RzaTZUdGxva2c0b0NVSU91cGxPdUp0Q0RzbDRic25iUWc2ck9uN0o2bElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHFzNkFzQ2lBZ0x5OGdJQ0JzYjJOaGJHaHZjM1FnN0lpWTdJdWdJTzJQck8yS3VPdWhuQ0Rxc3JEcXM3enJwYndnN0o2UTY0K1pJT3lJbU91Z3VlMlZuT3VMcENqc2k2VHN1S0U2SU8yWHBPdVRuT3Vtck95S3BPeVhrT3lFbk91UGhDRHJ1SXpybmJ6c21yRHNvSUFnN0plMDY2YThJQ3NnVEVsVFZFVk9JTzJabGV5ZHVDd2dNakF5Tmkwd055a3VDaUFnTHk4Z0lDRHRoTERycjdqcmhKRHNuYlFnN1ptVTY2bTA3SmVRSU95Z2hPMllnQ0RzbFlnZzY1eXM2NHVrTGlEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjQ2NmVNSU8yVm1PdXB0Q0RyZ1owdUNpQWdMeThnN1krMDY3Q3hLTzJFc091dnVPdUVrQ2s2SU95ZWtPdVBtU0RzbVlUcm80enFzSUFnNjZlSjdaNk1JTzJabU9xeXZTanJ1SXpybmJ6c21yRHNvSURxc0lBZ2JHOWpZV3hvYjNOMDdKZVFJT3VxdXlEcg0KaTcvc2xZUWc3TDJVNjVPYzZyQ0FJT3V6dE95ZHRPdUtsQ0Rxc3Izc21yQXA3SmVRN0lTY0NpQWdMeThnSUNEcm9aenF0N2pzbmJnZzY0eUE2cml3SU95a2tTRHJzb1R0aXJ6c25ZUWc2NWlRSU91SWhPdWx0T3VwdEN3ZzdMMlU2NU9jNjZXOElPdTJtZXlYck91RW8reWRoQ0RzaUpnZzdKNkk2NHFVSU8yRXNPdXZ1T3VFa0NEcnNLbnNpNTNzbkx6cm9ad2c3S0NFN1ptWTdaV2M2NHVrTGdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5dmNHVnVMV3h2WjJsdUp5a2dld29nSUNBZ1kyOXVjM1FnWW05a2VTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQmpiMjV6ZENCemQybDBZMmhOYjJSbElEMGdJU0VvWW05a2VTQW1KaUJpYjJSNUxuTjNhWFJqYUVGalkyOTFiblFwT3lBdkx5RHFzNFRzb0pVZzdLQ0U3Wm1ZSUQwZzdJdWM3WUdzNjZhL0lPeXd2ZXljdk91aG5DRHNsN1RzbHJRZzZyT0U3S0NWN0oyRUlPcXpvT3VsdkNEc2lKZ2cNCjdKNkk2cktNQ2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0F2THlCamJHRjFaR1hxc0lBZzdKZUc3Snk4NjZtMElPeVhyT3E0c095RW5DRHJnWXJyaXBUcmk2UXVJSE5vWld4c09uUnlkV1hybmJ3Z1kyeGhkV1JsNnJDQUlPeVhodXlXdE91UGhDRHNoYmpzbllBZzdLQ1Y3SU9CSU95THBPMldpZXVQdkFvZ0lDQWdJQ0F2THlCemNHRjNidXlkbUNBblpYSnliM0luNnJDQUlPeVZpQ0RybktqcXM2QXNJT3lZaU95Z2hPeVhsQ0RxdDdqcmpJRHJvWndnYjJzNmRISjFaZXVsdkNEcmo0enJvS1RzcEt6cmk2UWc0b0NVQ2lBZ0lDQWdJQzh2SU8yVWpPdWZyT3EzdU95ZHVPeWRnQ0FpNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lYdE95WGlPeVd0T3lhbENMcm5ienFzNkFnN1pXWTY0cVU2NDJ3SU95THBPeWduT3Vobk91S2xDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPdWNxT3VLbENEc2c0SHRnNXpxc0lBZzY1Q1E2NHVrS095THBPeWduQ0RzaTZEcXM2QXBMZ29nSUNBZ0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuDQpZMnhoZFdSbExXMXBjM05wYm1jbktTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNREVzSUhzS0lDQWdJQ0FnSUNBZ0lHVnljbTl5T2lBbjdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95WGh1eVd0T3lhbENEaWdKUWc3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKMjBJT3VRbU91S2xPeW5nQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGljc0NpQWdJQ0FnSUNBZ0lDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXMXBjM05wYm1jbkxBb2dJQ0FnSUNBZ0lIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lDOHZJT3luaE8yV2lTRHNwSkhzbmJqcmpiQWc2NWlRSU91SWpPdWdnT3VMcENEaWdKUWc2cmlJNjdDcEtEWXc3TFNJSU91Q3RDa2c2NHVrN0l1Y0lPdUloT3VsdUNEcXNiUWdJdXl3dmV5ZGhDRHJpNnZzbFpqcmk2UXY2NnE3SU91MHBPdUxwQ0xzbDVBZzZyQ0E2cm1NN0pxdzY2K0E2NkdjSU91NGpPdWR2T3lhc095Z2dPdWhuQ0RzbnF6cw0KaTV6cmo0VHRsWnpyaTZRdUNpQWdJQ0FnSUM4dklPMlZuT3l3dUNEcmtxVHNsNURyajRRZzY1aVFJT3VJaE91bHRPdUtsQ0Rxc2JRZzY3aU02NTI4N0pxdzdLQ0E2ckNBSUd4dlkyRnNhRzl6ZENEc3ZaenJzTEhzbDVBZzY2cTdJT3VMdit5VmhDRHNucERyajVrZzdKbUU2Nk9NNnJDQUlPeVZpQ0Rya0pqcmlwUWc3Wm1ZNnJLOTdKMjhJT3lJbUNEc25vanNuTHpyaTRnS0lDQWdJQ0FnTHk4ZzZyZTQ2NVdNNjZlTUlPeTlsT3VUbk91bHZDRHJ0cG5zbDZ6cmhLUHNuWVFnN0lpWUlPeWVpT3VLbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJTzJQdE91d3NlMlZuT3VMcENBbzY1R1FJT3V5aU95bnVDRHRnYlRycHEzc2w1QWc3WVN3NjYrNDY0U1E3SjIwSU8yS2dPeVd0T3VDbU95WXBPdXB0Q0RyaTdudG1hbnNpcVRybjczcmk2UXBMZ29nSUNBZ0lDQmpiMjV6ZENCemRHRnNaU0E5SUd4dloybHVVSEp2WXlBbUppQW9SR0YwWlM1dWIzY29LU0F0SUd4dloybHVVM1JoY25SbFpFRjBJRDRnTmpBd01EQXANCk93b2dJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpJQ1ltSUhOMFlXeGxLU0I3Q2lBZ0lDQWdJQ0FnYTJsc2JFeHZaMmx1VUhKdll5Z3BPd29nSUNBZ0lDQWdJR2xtSUNnaGIzQmxia3h2WjJsdVZHVnliV2x1WVd3b0tTa2dld29nSUNBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURFc0lIc2daWEp5YjNJNklDZnNuYlFnVDFQc2w1RHNoS0FnN0o2UTY0K1o3Snk4NjZHY0lPdXF1eURzbDdUc2xyVHNtcFFnNG9DVUlPMkVzT3V2dU91RWtPeVhrT3lFbkNCamJHRjFaR1VnN0l1azdaYUpJTzJiaENBdmJHOW5hVzRnN1pXMElPeWp2T3lFdU95YWxDNG5JSDBwT3dvZ0lDQWdJQ0FnSUgwS0lDQWdJQ0FnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEdGo3VHJzTEVnNG9DVUlPMkVzT3V2dU91RWtDRHJzS25zaTUzc25MenJvWndnN0tDRTdabVlMaWNwDQpPd29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQnRiMlJsT2lBbmRHVnliV2x1WVd3bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ0x5OGc3SldlN0lTZ0lPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmpzbmJRZzY0eUE2cml3SU95a2tleWR0T3VwdENEc29KSHFzNkFnN0lPSTY2R2NJT3lYc091THBDQW83TEM5N0oyRUlPdUxxK3lWbU9xeHNPdUNtQ0RyaTZUc2k1d2c2NGlFNjZXNElPcXl2ZXlhc0NrS0lDQWdJQ0FnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdJQ0F2THlCQ1VrOVhVMFZTNjZXOElPeWFzT3VtckNEdGxianJrNlRybjZ6cm9ad2c3S2VBN0tDVklPS0FsQ0JEVEVucXNJQWc2N2lNNjUyODdKcXc3S0NBNjZXOElPeW5nZXlna1NEc2w3VHNwNEFnN0pXSzZyT2dJRlZTVE91bmpDRHJoSmpxc3Fqc3BJRHJpNlF1Q2lBZ0lDQWdJQzh2SU8yVnVPdVRwT3Vmck9xdw0KZ0NEc2k2VHRqS2p0bFpqcXNiRHJncGdnUTB4SjZyQ0FJRUpTVDFkVFJWTHJwYndnNjZ5MDdJdWM3WlcwNjQrRUlFTk1TZXF3Z0NEc2xZenNsWVRzaEp3ZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUcnI0RHJvWndnNjZHYzZyZTQ3SjI0N0oyQUlPdVFuT3VMcENobVlXbHNMWE52Wm5RcExnb2dJQ0FnSUNCamIyNXpkQ0JzYjJkcGJrVnVkaUE5SUU5aWFtVmpkQzVoYzNOcFoyNG9lMzBzSUVOTVFWVkVSVjlGVGxZc0lIc2dRbEpQVjFORlVqb2dkM0pwZEdWQ2NtOTNjMlZ5U0dGdVpHeGxjaWh6ZDJsMFkyaE5iMlJsSUQ4Z0ozTjNhWFJqYUNjZ09pQW5ibTl5YldGc0p5a2dmU2s3Q2lBZ0lDQWdJR052Ym5OMElIUm9hWE5NYjJkcGJpQTlJSE53WVhkdUtDZGpiR0YxWkdVbkxDQmJKMkYxZEdnbkxDQW5iRzluYVc0bkxDQW5MUzFqYkdGMVpHVmhhU2RkTENCN0NpQWdJQ0FnSUNBZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ2JHOW5hVzVGYm5Zc0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2QybHUNClpHOTNjMGhwWkdVNklIUnlkV1VzQ2lBZ0lDQWdJQ0FnWkdWMFlXTm9aV1E2SUhCeWIyTmxjM011Y0d4aGRHWnZjbTBnSVQwOUlDZDNhVzR6TWljc0lDOHZJR3RwYkd4TWIyZHBibEJ5YjJQc25aZ2c2cmU0NjZPNUlHdHBiR3pzbXFrZ0tHdHBiR3hRY205ajZyTzhJT3VQbWV5ZHZDRHRqS2p0aExRcENpQWdJQ0FnSUgwcE93b2dJQ0FnSUNCc2IyZHBibEJ5YjJNZ1BTQjBhR2x6VEc5bmFXNDdDaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR2xtSUNoc2IyZHBibEJ5YjJNZ1BUMDlJSFJvYVhOTWIyZHBiaWtnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNnZlNrN0NpQWdJQ0FnSUhSb2FYTk1iMmRwYmk1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGdld29nSUNBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJNZ0lUMDlJSFJvYVhOTWIyZHBiaWtnY21WMGRYSnVPd29nSUNBZ0lDQWdJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdDaUFnSUNBZ0lDQWdhV1lnS0d4dloybHVVSEp2DQpZMVJwYldWeUtTQjdJR05zWldGeVZHbHRaVzkxZENoc2IyZHBibEJ5YjJOVWFXMWxjaWs3SUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc2dmUW9nSUNBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3SUM4dklPeURpQ0RxczRUc29KWHNuYndnN0lpWUlPeWVpT3ljdk91TGlDRHJpNlRzbll3Z0wyaGxZV3gwYUNEcmxZd2c2NHVrN0l1Y0lPeWR2ZXE0c0FvZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU95Z2lPeXdxQ0Rzb29Ycm80d2dLR052WkdVZ0p5QXJJR052WkdVZ0t5QW5LU2NwT3dvZ0lDQWdJQ0FnSUM4dklPeUNyT3Vlak95ZHRDRHJvWnpxdDdqc25ianRsYUFnN0l1YzZyQ0U2NCtFSU95WGh1eWR0Q0RxczZmcnNKVHJvWndnN0l1azdZeW82NkdjSU91Qm5ldUNyT3VMcENBOUlHTnNZWFZrWmVxd2dDRHNsNGJxc2JEcmdwZ2c3SXVrN1phSjdKMjBJT3lWaUNEcmtKd2c2cktETGdvZ0lDQWdJQ0FnSUM4dg0KSU95ZGtldUx0ZXlkZ0NEc25iVHJyN2dnNjdPMDY0T0k3Snk4NjR1SUlPeURnZTJEbk91bHZDRHJpNlRzaTV3ZzdKNnM3SVNjSUM5b1pXRnNkR2pyb1p3ZzdKV002NmF3NjR1a0lDanRsSXpybjZ6cXQ3anNuYmpzbmJRZzY0eUE2cml3SU8yWmxPdXB0T3lkaENEc2k2VHRqS2pyb1p3ZzY3Q1U2cjY4NjR1a0tTNEtJQ0FnSUNBZ0lDQnBaaUFvWTI5a1pTQWhQVDBnTUNBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQQ0ExTURBd0tTQjdDaUFnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNDdKMjBJT3ltaWV5TG5DRHNpNlR0aktqcm9ad2c2NEdkNjRLb0lPS0FsQ0JEYkdGMVpHVWdRMjlrWlNEc2hLVHN1WmdnN0lPQjdZT2M2Nlc4SU91THBPeUxuQ0Rzb0pEcXNvRHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJQ0FnSUNCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BPd29nSUNBZ0lDQWdJSDBLSUNBZ0lDQWdmU2s3Q2lBZ0lDQWcNCklHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryb1p6cXQ3anNuYmdnTVREcnRvUWc2cks5NnJPOElPS0FsQ0RyaklEcXVMQWc3WlNFNjZHYzdJUzQ3SXFrSU95Z2xldW1yQzRuS1RzZ2EybHNiRXh2WjJsdVVISnZZeWdwT3lCOUxDQTJNREF3TURBcE93b2dJQ0FnSUNBdkx5RHJncUhzbllBZzdKNkY3SjZsNnJhTTdKMkVJT3Vzdk9xem9DRHNub2pyaXBRZzY0eUE2cml3SU95RXVPeUZtT3lkZ0NEcnNvVHJwckRyaTZRZzRvQ1VJT3llck91aG5PcTN1T3lkdUNEdG00UWc2NHVrN0oyTUlPeWFsT3l5cmV5ZHRDRHNnNGdnN0lTNDdJV1lLT3lEaUNEc25vWHNucVhxdG93cDdKeTg2NkdjSU95TG5PeWVrZTJWbU9xeWpBb2dJQ0FnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd093b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N2lNNjUyODdKcXc3S0NBDQpJT3Vobk9xM3VPeWR1Q0RzaTV6c25wRW5JQ3NnS0hOM2FYUmphRTF2WkdVZ1B5QW5JQ2pxczRUc29KVWc3S0NFN1ptWUlPS0FsQ0RzaTV6dGdhenJwcjhnN0xDOUtTY2dPaUFuSnlrZ0t5QW5JT0tBbENEcm9aenF0N2pzbmJqdGxaanJxYlFnN0o2UTY0K1pJT3lYc09xeXNPdVFxZXVMaU91THBDNG5LVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHMXZaR1U2SUhOM2FYUmphRTF2WkdVZ1B5QW5Zbkp2ZDNObGNpMXpkMmwwWTJnbklEb2dKMkp5YjNkelpYSW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TUN3Z2V5Qmxjbkp2Y2pvZ0ordWhuT3EzdU95ZHVDRHNzTDNzbllRZzY2cTdJT3lYdE95WGlPeVd0T3lhbERvZ0p5QXJJR1V1YldWemMyRm5aU0I5S1RzS0lDQWdJSDBLSUNCOUNpQWdMeThnS08yRXNPdXZ1T3VFa0NEdGo3VHJzTEVnNnJXczdaaUU2N2FBSU9LQWxDRHJ1SXpybmJ6cw0KbXJEc29JQWc3SjZRNjQrWklPeVpoT3Vqak9xd2dDRHNsWWdnNjVDWTY0cVVJTzJabU9xeXZTRHNvSVRzbXFrcENpQWdablZ1WTNScGIyNGdiM0JsYmt4dloybHVWR1Z5YldsdVlXd29LU0I3Q2lBZ0lDQjdDaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUNBZ0x5OGdjM1JoY25UcXNJQWc3SU9JSU95OW1PeUdsQ0Rzc0wzc25ZUWc2NmVNNjVPZzY0dWtJQ2pyaTZUcnBxenNuWmdnN0lpbzdKMkFJT3k5bU95R2xPcXp2Q0RyckxUcXRJRHRsWmpxc293ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU91enRPeWVoQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdKMjA3SmEwN0lTY0lGQnZkMlZ5VTJobGJHd29MbkJ6TVNuc25iUWdOZXkwaUNEcmtxUWc2cmU0SU95d3ZleVhrQ0RzbDVUdGhMRHJwYndnNjdPMDY0SzBJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbllRZzdKNlE2NCtaSU95RW9PMkRuZTJWbU9xem9Dd0tJQ0FnSUNBZ0lDQXZMeURzc0wzc25ZUWcNCjdMV2M3SWFNN1ptVTdaVzBJT3lDck95YXFleWVrQ0RyaUlqc2w1UWc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdU91bmpDRHJncWpxc293ZzdaV2M2NHVrTGlEc3NMM3NuWVFnNjZxN0lPeXd2dXljdk91cHRDRHNsWVRyckxUcXNvUHJqNFFnN0pXSUlPMlZuT3VMcEFvZ0lDQWdJQ0FnSUM4dklDanJpNlRycGJnZzdMQzlJT3lZcE95ZWhldWdwU0Ryc0tuc3A0QWc0b0NVSU9xM3VDRHFzcjNzbXJBZzY2bVU2NG0wNnJDQUlPdXp0T3lkdE91S2xDRHNzWVRyb1p3ZzY0S282ck9nSU95Q3JPeWFxZXlla09xd2dDRHNsNVR0aExBZzdaV2NJT3V5aUNEcmlJVHJwYlRycWJRZzY1Q29LUzRLSUNBZ0lDQWdJQ0F2THlEc283enNuWmc2SUdOc1lYVmtaZXF3Z0NEc3ZaanNocFFnN0tDYzY2cXA3SjJFSU91d2xPcSt1T3VwdENCQmNIQkJZM1JwZG1GMFpTOUdhVzVrVjJsdVpHOTM2ckNBSU91cXV5RHNzTDdzbllRZzdJaVlJT3llaU95ZGpDRGlnSlFnN0p5STY0K0U3SnF3SU95THBPcTRzT3lYa095RW5DRHRtWlhzDQpuYmdnN1pXRTdKcVVMZ29nSUNBZ0lDQWdJR052Ym5OMElIQnpNU0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdGJHOW5hVzR1Y0hNeEp5azdDaUFnSUNBZ0lDQWdabk11ZDNKcGRHVkdhV3hsVTNsdVl5aHdjekVzSUZzS0lDQWdJQ0FnSUNBZ0lDZFRkR0Z5ZEMxVGJHVmxjQ0F0VTJWamIyNWtjeUExSnl3S0lDQWdJQ0FnSUNBZ0lDY2tkM01nUFNCT1pYY3RUMkpxWldOMElDMURiMjFQWW1wbFkzUWdWMU5qY21sd2RDNVRhR1ZzYkNjc0NpQWdJQ0FnSUNBZ0lDQWlhV1lnS0NSM2N5NUJjSEJCWTNScGRtRjBaU2duWTJ4aGRXUmxMV3h2WjJsdUp5a3BJSHNpTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdKSGR6TGxObGJtUkxaWGx6S0NkK0p5a2lMQW9nSUNBZ0lDQWdJQ0FnSnlBZ1UzUmhjblF0VTJ4bFpYQWdMVk5sWTI5dVpITWdNaWNzQ2lBZ0lDQWdJQ0FnSUNBaUlDQkJaR1F0Vkhsd1pTQXRUbUZ0WlhOd1lXTmxJRlVnTFU1aGJXVWdWeUF0VFdWdFltVnlSR1ZtYVc1cA0KZEdsdmJpQW5XMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUZONWMzUmxiUzVKYm5SUWRISWdSbWx1WkZkcGJtUnZkeWh6ZEhKcGJtY2dZeXdnYzNSeWFXNW5JSFFwT3lCYlJHeHNTVzF3YjNKMEtGd2lkWE5sY2pNeUxtUnNiRndpS1YwZ2NIVmliR2xqSUhOMFlYUnBZeUJsZUhSbGNtNGdZbTl2YkNCVGFHOTNWMmx1Wkc5M0tGTjVjM1JsYlM1SmJuUlFkSElnYUN3Z2FXNTBJRzRwT3ljaUxBb2dJQ0FnSUNBZ0lDQWdJaUFnSkdnZ1BTQmJWUzVYWFRvNlJtbHVaRmRwYm1SdmR5aGJUblZzYkZOMGNtbHVaMTA2T2xaaGJIVmxMQ0FuWTJ4aGRXUmxMV3h2WjJsdUp5a2lMQW9nSUNBZ0lDQWdJQ0FnSnlBZ2FXWWdLQ1JvSUMxdVpTQmJVM2x6ZEdWdExrbHVkRkIwY2wwNk9scGxjbThwSUhzZ1czWnZhV1JkVzFVdVYxMDZPbE5vYjNkWGFXNWtiM2NvSkdnc0lEWXBJSDBuTENBdkx5QTJJRDBnVTFkZlRVbE9TVTFKV2tVS0lDQWdJQ0FnSUNBZ0lDZDkNCkp5d0tJQ0FnSUNBZ0lDQmRMbXB2YVc0b0oxeHlYRzRuS1NBcklDZGNjbHh1SnlrN0NpQWdJQ0FnSUNBZ1kyOXVjM1FnWW1GMElEMGdjR0YwYUM1cWIybHVLRzl6TG5SdGNHUnBjaWdwTENBblkyeGhkV1JsTFdKeWFXUm5aUzFzYjJkcGJpNWlZWFFuS1RzS0lDQWdJQ0FnSUNCbWN5NTNjbWwwWlVacGJHVlRlVzVqS0dKaGRDd2dKMEJsWTJodklHOW1abHh5WEc0bklDc0tJQ0FnSUNBZ0lDQWdJQ2R6ZEdGeWRDQWlZMnhoZFdSbExXeHZaMmx1SWlCamJXUWdMMnNnWTJ4aGRXUmxJQzlzYjJkcGJseHlYRzRuSUNzS0lDQWdJQ0FnSUNBZ0lDZHdiM2RsY25Ob1pXeHNJQzFPYjFCeWIyWnBiR1VnTFVWNFpXTjFkR2x2YmxCdmJHbGplU0JDZVhCaGMzTWdMVVpwYkdVZ0lpY2dLeUJ3Y3pFZ0t5QW5JbHh5WEc0bktUc0tJQ0FnSUNBZ0lDQnpjR0YzYmlnblkyMWtKeXdnV3ljdll5Y3NJR0poZEYwc0lIc2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwDQpjblZsSUgwcE93b2dJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2RrWVhKM2FXNG5LU0I3Q2lBZ0lDQWdJQ0FnTHk4Z2NIUjVLR1Y0Y0dWamRDbnJvWndnNjdPMDY0SzRJTzJDcE95WGtDRHRnYlRyb1p6cms1d2dWRlZKNnJDQUlPdXN0T3V3bU95ZGtleWR1Q0Rxc29Qc25iUWc3SXVrN0xpaElPMlpsZXlkdU91UXFDZ3lNREkyTFRBM0xDRHNuYnpyc0pnZ1hITEN0MnRwZEhSNUlPeTlsT3VUbkNEcnFxanJrWkFwSU9LQWxBb2dJQ0FnSUNBZ0lDOHZJT3ljb095ZHZPMlZuQ0RzbnBEcmo1bnRtWlFnNnJLOTY2R2M2NHFVSUZONWMzUmxiU0JGZG1WdWRIUHNuWmdnN0tlRTdLZWNJTzJDcENEc25vWHJvS1V1SU95Z2tlcTN2T3lFc1NEcXRvenRsWnpzbmJRZzdKNkk3Snk4NjZtMElEYnN0SWdnNjVLa0lPeVhsTzJFc09xd2dDRHNucERyajVrZzdKNkY2NkNsNjQrOENpQWdJQ0FnSUNBZ0x5OGdNZXV5aUNqcXRhenJqNFVnNnJPRTdLQ1ZLZXlkdENEc2hLRHRnNTNya0pqcQ0KczZBc0lPcTJqTzJWbk95ZHRDRHNsNGJzbkx6cnFiUWdhMlY1YzNSeWIydGxJT3lraE91bmpDRHNvYkRzbXFudG5vZ2c3SXVrN1l5bzdaVzBJT3lDck95YXFleWVrT3F3Z0NEc2w1VHRoTEFnN1pXY0lPdXlpQ0RyaUlUcnBiVHJxYlFnNjVDYzY0dWtLR1poYVd3dGMyOW1kQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdKZVU3WVN3SU95bmdleWdoT3lYa0NCVVpYSnRhVzVoYk95ZGhDRHJpNlRzaTV3ZzdKV2U3Snk4NjZHY0lPcXdnT3lndU95WmdDRHJpNlRycGJnZzdKV3g3SmVRSU8yQ3BPcXdnQ0RyazZUc2xyVHFzSURyaXBRZzZyS0Q3SjJFSU91bmlldUtsT3VMcEM0S0lDQWdJQ0FnSUNCemNHRjNiaWduYjNOaGMyTnlhWEIwSnl3Z1d3b2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJrYnlCelkzSnBjSFFnSW1Oc1lYVmtaU0F2Ykc5bmFXNGlKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWgNCmJDSWdkRzhnWVdOMGFYWmhkR1VuTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjJSbGJHRjVJRFluTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QmhZM1JwZG1GMFpTY3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5aR1ZzWVhrZ01DNHpKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pUZVhOMFpXMGdSWFpsYm5SeklpQjBieUJyWlhsemRISnZhMlVnY21WMGRYSnVKeXdLSUNBZ0lDQWdJQ0FnSUM4dklPeVhsTzJFc09xd2dDRHNpNlRzb0p6cm9ad2c2NU9rN0phMDZyQ0VJT3F5dmV5YXNPeVhrT3VuakNEc2w2enF1TEFnNjQrRTY0dXNLT3Eyak8yVm5DRHNsNGJzbkx6cnFiUWc3SnlFN0plUTdJU2NJT3lra2V1THFDa2c0b0NVSU8yRXNPdXZ1T3VFa095ZGhDRHN1WmpzbTR3ZzY3aU02NTI4N0pxdzdLQ0E2NmVNSU91Q3FPcTR0T3VMcEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjJSbGJHRjVJREV1DQpOU2NzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklITmxkQ0J0YVc1cFlYUjFjbWw2WldRZ2IyWWdabkp2Ym5RZ2QybHVaRzkzSUhSdklIUnlkV1VuTEFvZ0lDQWdJQ0FnSUYwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPd29nSUNBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCbVlXeHpaVHNnTHk4ZzdLZUE3SnVRSU95VmlDRHRsWmpyaXBRZ1QxTUtJQ0FnSUNBZ2ZRb2dJQ0FnSUNCeVpYUjFjbTRnZEhKMVpUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzdZRzA2NkdjNjVPY0lPcXpoT3lnbFNEcm9aenF0N2pzbFlUc200TWc0b0NVSU8yVWpPdWZyT3EzdU95ZHVDRHRtWWpzblpnZ1crdWhuT3EzdU95VmhPeWJnMTBnNjdLRTdZcTg3SjIwSU8yWXVPeTJuQzRnWTJ4aGRXUmxJR0YxZEdnZ2JHOW5iM1YwN0p5ODY2R2NJRU5NU1NEcm9aenF0N2pzbmJqc25ZUWc3WlcwN0tDYzdaV2M2NHVrTGdvZ0lDOHZJQ2pzbmJRZw0KVUVQc25aZ2c3S0NBN0o2bDY1Q2NJT3lla09xeXFleW1uZXVxaGV5ZGhDRHNwNERzbXJUcmk2UWc0b0NVSU91THBPeUxuQ0RzazdEcm9LVHJxYlFnN0o2czY2R2M2cmU0N0oyNElPMlZoT3lhbEM0cElPdWhuT3EzdU95VmhPeWJneUR0bTRUc2w1UWc3SVM0N0lXWXdyZnFzNFRzb0pYc3VwRHNpNXpycGJ3ZzdLQ1Y2NmFzN1pXYzY0dWtMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTlqYkdGMVpHVXRiRzluYjNWMEp5a2dld29nSUNBZ1kyOXVjM1FnYkc4Z1BTQnpjR0YzYmlnblkyeGhkV1JsSnl3Z1d5ZGhkWFJvSnl3Z0oyeHZaMjkxZENkZExDQjdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcE93b2dJQ0FnYkdWMElHVnljaUE5SUNjbk93b2dJQ0FnYkc4dWMzUmtaWEp5TG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzZ1pYSnlJQ3M5SUdRdWRHOVRkSEpwYm1jb0tUc2cNCmZTazdDaUFnSUNCc2J5NXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdleUJxYzI5dUtISmxjeXdnTlRBd0xDQjdJRzlyT2lCbVlXeHpaU3dnWlhKeWIzSTZJQ2Zyb1p6cXQ3anNsWVRzbTRNZzdJdWs3WmFKSU95THBPMk1xRG9nSnlBcklHVXViV1Z6YzJGblpTQjlLVHNnZlNrN0NpQWdJQ0JzYnk1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGdld29nSUNBZ0lDQnJhV3hzVUhKdll5Z3BPeUFnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdMeThnNjZHYzZyZTQ3SldFN0p1RDY1Q2NJT3F6aE95Z2xleWRoQ0Ryckx6cmpaZ2c2NHlBNnJpd0lPeUV1T3lGbU95ZGhDRHJzb1RycHJEcmk2UUtJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec2dJQ0FnSUNBZ0lDOHZJT3VMcE95ZGpDQXZZV05qYjNWdWRNSzNMMmhsWVd4MGFPeVhrT3lFbkNEcXM0VHNvSlhzbllRZzdJT0k2NkdjS0Qzc2w0YnNuWXpzbkx6cm9ad3BJT3lkdmVxeWpBb2dJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c095QWdJQ0FnDQpJQ0FnTHk4ZzdJT0I3WU9jSU95ZXJPMk1rT3lnbFNqcmk2VHNuWXdnN1lTMDdKZVE3SVNjSU91dnVPdWhuT3EzdU95ZHVDRHFzSkRzcDRBcENpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKV0U3SnVESUNoamIyUmxJQ2NnS3lCamIyUmxJQ3NnSnlrbktUc0tJQ0FnSUNBZ2FXWWdLSEpsY3k1b1pXRmtaWEp6VTJWdWRDa2djbVYwZFhKdU95QXZMeUJsY25KdmNpRHRsYmpyazZUcm42enFzSUFnN0oyMDY2KzRJT3lka2V1THRlMldpT3ljdk91cHRDRHNwSkhyczdVZzY3Q3A3S2VBQ2lBZ0lDQWdJR2xtSUNoamIyUmxJRDA5UFNBd0tTQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUNBZ0lDQmxiSE5sSUdwemIyNG9jbVZ6TENBMU1EQXNJSHNnYjJzNklHWmhiSE5sTENCbGNuSnZjam9nS0dWeWNpNTBjbWx0S0NrdWMyeHBZMlVvTUN3Z01UVXdLU2tnZkh3Z0tDZnNvb1hybzR3ZzdMMlU2NU9jSUNjZ0t5QmpiMlJsS1NCOQ0KS1RzS0lDQWdJSDBwT3dvZ0lDQWdjbVYwZFhKdU93b2dJSDBLSUNBdkx5RHNucERxdUxBZzdLS0Y2Nk9NSU9LQWxDRHRnYlRyb1p6cms1enJpNlRycHF3dDY0R0U2cml3TG1KaGRPeWR0Q0R0bUxqc3RwenRsWnpyaTZRZ0tPdWhuT3k3ck95WGtPeUVuT3VuakNEc29KSHF0N3dnNnJDQTY0cWw3WldZNjR1SUlPeVZpT3lnaENrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmMyaDFkR1J2ZDI0bktTQjdDaUFnSUNCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWloZXVqakNEc21wVHNzcTBnNjdDYjdKMk1JT0tBbENEcmk2VHJwcXpycGJ3ZzY0R1Y2NHVJNjR1a0xpY3BPd29nSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBMQ0F5TURBcE93b2dJQ0FnY21WMGRYSnVPd29nSUgwS0lDQnANClppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2Y21WamIyMXRaVzVrSnlrZ2V3b2dJQ0FnWTI5dWMzUWdleUIwWlhoMExDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHbG1JQ2doZEdWNGRDQjhmQ0FoVTNSeWFXNW5LSFJsZUhRcExuUnlhVzBvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZzdHBUc3NwenJzSnZzbllRZzY2eTQ2cldzNnJDQUlPdTVoT3lXdENEc25vanNpclhyaTRqcmk2UXVKeUI5S1RzS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3kybE95eW5DRHNtcFRzc3EwNkp5d2dVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURVd0tTNXlaWEJzWVdObEtDOWNiaTluTENBbklDY3BJQ3NnSitLQXBpY3NJRzF2WkdWc0lEOGdKeWpycXFqcmpiZzZJQ2NnS3lCdGIyUmxiQ0FyDQpJQ2NwSnlBNklDY25LVHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJR052Ym5OMElISmhkeUE5SUdGM1lXbDBJR0Z6YTBOc1lYVmtaU2hUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwTENCdGIyUmxiQ2s3Q2lBZ0lDQWdJR052Ym5OMElITjFaMmRsYzNScGIyNXpJRDBnY0dGeWMyVlRkV2RuWlhOMGFXOXVjeWh5WVhjcE93b2dJQ0FnSUNCamIyNXpkQ0J6WldNZ1BTQW9LRVJoZEdVdWJtOTNLQ2tnTFNCemRHRnlkR1ZrS1NBdklERXdNREFwTG5SdlJtbDRaV1FvTVNrN0NpQWdJQ0FnSUdsbUlDZ2hjM1ZuWjJWemRHbHZibk11YkdWdVozUm9LU0I3Q2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1qT3lMc1NEc2k2VHRqS2dnS0NjZ0t5QnpaV01nS3lBbmN5azZKeXdnVTNSeWFXNW5LSEpoZHlrdWMyeHBZMlVvTUN3Z01qQXdLU2s3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lIc2daWEp5YjNJNklDZnRnYlRyb1p6cms1d2c3SjJSNjR1MTdKMkVJTzJWdE95RQ0KbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKV0lJQ2NnS3lCemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3Q2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCemRXZG5aWE4wYVc5dWN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGsNCloyVmRJT3lMcE8yTXFEb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc0tJQ0FnSUgwS0lDQjlDaUFnTHk4ZzY0eUE3Wm1VN1ppVklPdXN1T3ExckNEc29KenNucEVnNG9DVUlPeURnZTJacWV5ZGhDRHNoS1RycW9YdGxaanJxYlFnNjZ5NDZyV3M2Nlc4SU91bmpPdVRwT3lXdE95a2dPdUxwQ0FvN0xhVTdMS2M2ck84SU9xd21leWRnQ0RzaExqc2haZ3NJT3VNZ08yWmxPdUtsQ0RycDZRZzdKcVU3TEt0N0plUUlPMkd0ZXludU91aG5DRHNpNlRycHJ3cENpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyTnZiWEJ2YzJVbktTQjdDaUFnSUNCamIyNXpkQ0I3SUcxbGMzTmhaMlZ6TENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwDQpjM1FnUFNCQmNuSmhlUzVwYzBGeWNtRjVLRzFsYzNOaFoyVnpLU0EvSUcxbGMzTmhaMlZ6TG1acGJIUmxjaWdvYlNrZ1BUNGdiU0FtSmlCVGRISnBibWNvYlM1MFpYaDBJSHg4SUNjbktTNTBjbWx0S0NrcElEb2dXMTA3Q2lBZ0lDQnBaaUFvSVd4cGMzUXViR1Z1WjNSb0tTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdNQ3dnZXlCbGNuSnZjam9nSit1TWdPMlpsQ0RyZ3JUc21xbnNuYlFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emRDQnNZWE4wVlhObGNpQTlJRnN1TGk1c2FYTjBYUzV5WlhabGNuTmxLQ2t1Wm1sdVpDZ29iU2tnUFQ0Z2JTNXliMnhsSUNFOVBTQW5ZWE56YVhOMFlXNTBKeWs3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJT3VNZ08yWmxDRHNtcFRzc3EwNkp5d2dVM1J5YVc1bktDaHNZWE4wVlhObGNpQW1KaUJzWVhOMFZYTmxjaTUwWlhoMA0KS1NCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTlRBcExuSmxjR3hoWTJVb0wxeHVMMmNzSUNjZ0p5a2dLeUFuNG9DbUlDanJqSUR0bVpRZ0p5QXJJR3hwYzNRdWJHVnVaM1JvSUNzZ0orcXduQ2tuS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSEpoZHlBOUlHRjNZV2wwSUdGemEwTnZiWEJ2YzJVb2JHbHpkQzV6YkdsalpTZ3RNVElwTENCdGIyUmxiQ2s3SUM4dklPdU1nTzJabE9xd2dDRHF1TGpzbHJUc3A0RHJxYlFnN0xXYzZyZThJREV5NnJDYzY2ZU1JQ2p0bElUcm9henRsSVR0aXJnZzdZK3Q3S084SU91d3FleW5nQ2tLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY0dGeWMyVkRiMjF3YjNObEtISmhkeWs3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGdmRYUXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU8yTWpPeUwNCnNTRHNpNlR0aktnZ0tDY2dLeUJ6WldNZ0t5QW5jeWs2Snl3Z1UzUnlhVzVuS0hKaGR5a3VjMnhwWTJVb01Dd2dNakF3S1NrN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJSHNnWlhKeWIzSTZJQ2Z0Z2JUcm9aenJrNXdnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPeWRrZXVMdFNBb0p5QXJJSE5sWXlBcklDZHpMQ0Rzb0p6c2xZZ2dKeUFySUc5MWRDNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dLeUFuNnJDY0tTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktDaHNZWE4wVlhObGNpQW1KaUJzDQpZWE4wVlhObGNpNTBaWGgwS1NCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTXpBcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ5WlhCc2VUb2diM1YwTG5KbGNHeDVMQ0J6ZFdkblpYTjBhVzl1Y3pvZ2IzVjBMbk4xWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU8yWXVPeTJuQ0RzaTZUdGpLZzZJQ2NwS1RzS0lDQWdJSDBLSUNCOUNpQWdMeThnNjdLSTdKZXRJT0tBbENEdGxaenF0YTNzbHJRZzRvYVVJT3lZZ2V5V3RDRHNucERyajVrZ0tPeTJsT3l5bk9xenZDRHFzSm5zbllBZw0KN0lTNDdJV1lJT3lDck95YXFTa0tJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZkSEpoYm5Oc1lYUmxKeWtnZXdvZ0lDQWdZMjl1YzNRZ2V5QjBaWGgwTENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdsbUlDZ2hkR1Y0ZENCOGZDQWhVM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnJzb2pzbDYzdGxhQWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWcNCklDQWdZMjl1YzNRZ2NtRjNJRDBnWVhkaGFYUWdZWE5yVkhKaGJuTnNZWFJsS0ZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0Nrc0lHMXZaR1ZzS1RzS0lDQWdJQ0FnWTI5dWMzUWdiM1YwSUQwZ2NHRnljMlZVY21GdWMyeGhkR1VvY21GM0tUc0tJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93b2dJQ0FnSUNCcFppQW9JVzkxZENrZ2V3b2dJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryc29qc2w2MGc3WXlNN0l1eElPeUxwTzJNcUNBb0p5QXJJSE5sWXlBcklDZHpLVG9uTENCVGRISnBibWNvY21GM0tTNXpiR2xqWlNnd0xDQXlNREFwS1RzS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVRuQ0Ryc29qc2w2MGc3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnDQpmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdLSTdKZXRJT3laaE91ampDQW9KeUFySUhObFl5QXJJQ2R6TENBbklDc2dLRzkxZEM1a2FYSmxZM1JwYjI0Z2ZId2dKejhuS1NBcklDY3BKeWs3Q2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCMGNtRnVjMnhoZEdWa09pQnZkWFF1ZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dU9pQnZkWFF1WkdseVpXTjBhVzl1TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCag0KYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJT3V5aU95WHJTRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EUXNJSHNnWlhKeWIzSTZJQ2RPYjNRZ1ptOTFibVFuSUgwcE93cDlLVHNLQ2k4dklPeWR0T3V2dUNEcmk2VHJwcXpxc0lBZzY1YWdJT3llaU91S2xPdU5zQ0RybUpBZzdMeWM2cml3NnJDQUlPdVRwT3lXdE95WXBPdXB0Q2pzb0p6c2lxVHNzcGdnN0o2UTY0K1pJT3k4bk9xNHNDRHNwSkhyczdVZzY1T3hLU0Rzb2JEc21xbnRub2dnN0tLRjY2T01JT0tBbENEcmo0enJqWmdnNjR1azY2YXM2NHFVSU9xM3VPdU1nT3VobkNEc25LRHNwNEFLYzJWeWRtVnlMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUI3Q2lBZ2FXWWdLR1VnSmlZZ1pTNWoNCmIyUmxJRDA5UFNBblJVRkVSRkpKVGxWVFJTY3BJSHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbmJUcnI3Z2c3THljN0tDNElPeWVpT3lXdE95YWxDanRqNnp0aXJnZ0p5QXJJRkJQVWxRZ0t5QW5JT3lDck95YXFTRHNwSkVwSU9LQWxDRHNuYlFnN0oyNDdJcWs3WVMwN0lxazY0cVVJT3lpaGV1ampPMlZxZXVMaU91THBDNG5LVHNLSUNBZ0lIQnliMk5sYzNNdVpYaHBkQ2d3S1RzS0lDQjlDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUVuT3V5aENEc21LVHJwWmc2Snl3Z1pTQW1KaUJsTG0xbGMzTmhaMlVwT3dvZ0lIQnliMk5sYzNNdVpYaHBkQ2d4S1RzS2ZTazdDaTh2SU95V3RPdVdwQ0Rxc3Izcm9aenJvWndnN0tPOTY1T2dLT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFzSUVOMGNtd3JReXdnTDNOb2RYUmtiM2R1TENEc21LVHJwWmdwSUdOc1lYVmtaU0RzbnBEc2k1M3NuWVFnNjRLbzZyaXc3S2VBSU95Vml1dUtsT3VMcEFwd2NtOWpaWE56TG05dUtDZGxlR2wwDQpKeXdnS0NrZ1BUNGdleUJyYVd4c1VISnZZeWdwT3lCcmFXeHNURzluYVc1UWNtOWpLQ2s3SUgwcE93cHdjbTlqWlhOekxtOXVLQ2RUU1VkSlRsUW5MQ0FvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrcE93cHdjbTlqWlhOekxtOXVLQ2RUU1VkVVJWSk5KeXdnS0NrZ1BUNGdjSEp2WTJWemN5NWxlR2wwS0RBcEtUc0tDbk5sY25abGNpNXNhWE4wWlc0b1VFOVNWQ3dnSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzS0lDQmpiMjV6YjJ4bExteHZaeWduNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0p5RHRnYlRyb1p6cms1d2c2NHVrNjZhc0lPeThuT3lua0NEaWdKUWdhSFIwY0Rvdg0KTDJ4dlkyRnNhRzl6ZERvbklDc2dVRTlTVkNrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSnlEcnFxanJqYmc2SUNjZ0t5QkRURUZWUkVWZlRVOUVSVXdnS3lBbklNSzNJT3lZaU95TG5DQW5JQ3NnUlZoQlRWQk1SVk11YkdWdVozUm9JQ3NnSitxeHRDRHNucVhzc0trbktUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPeWR0Q0Rzc0wzc25ZUWc3THljNjVHVUlPdVBtZXlWaUNEdGxMenF0N2pycDRnZzdaU002NStzNnJlNDdKMjQ3SjIwSU8yQnRPdWhuT3VUbk91aG5DRHN0cFRzc3B6dGxhbnJpNGpyaTZRdUp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0orS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTm9aV05yUTJ4aGRXUmwNClFYWmhhV3hoWW14bEtDazdJQzh2SUVOc1lYVmtaU0JEYjJSbElPeUNyT3lhcVNEcXNJRHJpcVVnN0plczY3YUFJT3lna09xeWdDQW83WlNNNjUrczZyZTQ3SjI0SU95VmlPdUN0T3lhcVNrS0lDQXZMeURycjdqcnBxd2c3SXVjNjQrWklDc2c3S2VBN0l1YzY2eTRJT3lqdk95ZWhTRGlnSlFnN0xLcklPeTJsT3l5bk91MmdPMkVzQ0RydWFEcnBiVHFzb3dLSUNCaGMydERiR0YxWkdVb0oreWJqT3V3amV5WGhUb2dJdXlnZ095ZXBTRHJrSmpzbDRqc2lyWHJpNGpyaTZRaUp5a3VkR2hsYmlnS0lDQWdJQ2dwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbTR6cnNJM3NsNFVnN0ptRTY2T01JT0tBbENEc3RwVHNzcHdnN0tTQTY3bUVJT3VCblM0bktTd0tJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeUxwTzJNcUNBbzdMS3JJT3lhbE95eXJTRHJsWXdnN0o2czdJdWM2NCtFS1RvbkxDQmxMbTFsYzNOaFoyVXBDaUFnS1RzS2ZTazdDZz09DQo6OkVYQU1QTEVTOjoNCkl5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzDQpwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydA0KbGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWENCmxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVDQo3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TA0Kbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXkNCmhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVDQo3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3Zw0KN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVcNCnRPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWDQptT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIcw0KbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0kNCjdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnDQo3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvag0KSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVANCm1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyDQpvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8ySw0KdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVYNCmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyDQppNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Qw0KdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXcNCmdDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzDQpuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRQ0KN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHMNCm5JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhDQpsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMA0KSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzMNCjZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzDQppSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEcw0KaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGcNCjdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhDQpxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqcw0KbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjANCklPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVoDQpuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMA0KN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTANCjY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RyDQpwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZw0KNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXcNCnZ1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLDQpMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZw0KN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHINCnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVDQpQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aA0KbkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0NCjo6R1VJREU6Og0KSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5Bb0tJeU1nTVM0ZzdaVzA3SnFVN0xLMENncnNvSnp0a29nZzdKV0k3SjJZSU91cXFPdVRvQ0RyckxqcXRhenJpcFFnSisyVnRPeWFsT3l5dENmcm9ad2c3STJvN0pxVUxncnNuYnpxdElEc2hMRWc3SjZJNjRxVUlPeUNyT3lhcWV5ZWtDRHFzcjN0bDVqc25ZUWc2NmVNNjVPa0lPeUltQ0Rzbm9qcmo0VHJvWjBnS2lyc2c0SHRtYWtzSU91bnBldWR2ZXlkaENEcnRvanJyTGp0bFpqcXM2QWc2NnFvNjVPZ0lPdXN1T3Exck95WGtDRHRsYlRzbXBUc3NyVHJwYndnN0tDQjdKcXA3WlcwN0tPODdJUzQ3SnFVTGlvcUNncnNtSWdwQ2kwZzY3TzA2NE9GNjR1STY0dWtJT0tHa2lEcnM3VHJncnpxc296c21wUUtDaW9xS2dvS0l5TWdNaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0FvSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEc3RaenJqSUR0bFp3Z0tpcnJpcVhyajVudG1KVWc2Nnk0N0o2bEtpcnNuWVFnN0kybzdLTzg3SVM0N0pxVUxpRHNpSmpyajVudG1KVWcNCjY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRFdDdJaVk2NCtaN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2s3RHJpcFFnNnJLTUlPeWlpK3lWaE95YWxDNEtDaU1qSXlEcmtKRHNsclRzbXBRZzRvYVNJTzJXaU95V3RPeWFsQW9LN0ppSUtRb3RJT3lFcE95Z2xldVFrT3lXdE95YWxDRGlocElnN0lTazdLQ1Y3WmFJN0phMDdKcVVDZ29qSXlNZ0ozN3NsNGduSU91NXZPcTRzQW9LN0ppSUtRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVUNnb2pJeU1nNjQrWjdJS3NJT3V3bE9xL2xPeVRzT3E0c0FvSzdKaUlLUW90SU91R2t1eVZoT3loak95V3RPeWFsQ0RpaHBJZzdKaXM2NTZRN0phMDdKcVVDZ29xS2lvS0NpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBS0N1eWduTzJTaUNEc2xZanNsNURzaEp3ZzY3YUE3S0NWN0tDQklPeTdwT3V1DQpwT3VMaU95OGdPeWR0T3lGbU95ZGhDRHN0WnpyaklEdGxad2c3S1NFN0oyMDZyT2dJT3E0amV5Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzdLTzg3SVM0N0pxVUxncnJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUTXQ2N2FBN0tDVjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNqYWpzbXBRdUNncnNtSWdnT2lEc2xZZ2c2NCs4N0pxVUxDRHNsNGJzbHJUc21wUWdLRmdwSU9LR2tpQis3WldZNjZtMElPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUlDaFBLUW9LSXlNaklPeVhodXlXdE95YWxDRGlocElnN0o2STdKYTA3SnFVQ2dyc21JZ3BDaTBnNjdPMDdaaTQ3SjZRNnJDQUlPMlhpT3VkdmUyVm1PcTRzQ0Rzb0lUc2w1RHJpcFFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUWc0b2FTSU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQQ0KN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRS0NpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFDZ3JzbDVEcm42d2c3SU9CN1ptcDdKZVE3SVNjNjQrRUlDTHRsYlRxc3JBZzY3Q3A2N0tWSXV5ZGhDRHJxTHpzb0lBZzdKV002NkNrN0tPODY0cVVJT3E0amV5Z2xlMllsU0RxdGF6c29iRHJvWndnN0kybzdKcVVMZ29LN0ppSUtRb3RJT3luZ09xNGlDRHJzb1Rzb0lUc2w1RHNoSnpyaXBRZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeVZzZXlkaENEc3RaenNpNkFnNjdLRTdLQ0U3Snk4NjZHY0lPeVhoZXVOc095ZHRPMkt1Q0R0bGJUc283enNoTGpzbXBRdUlPS0draURzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMDdLTzg3SVM0N0pxVUxpRHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2pvNk9pQjBhWEFnNjR1azdKMjA3SmE4NjZHYzZyZTQNCklPeVp2T3lxdlNEcnNvVHRpcnpzbllBZ1crdUxxK3E0c0YwSzY0dWs3SjIwN0phODY2R2M2cmU0SU95WnZPeXF2U0Ryc29UdGlyenNuWUFnS2lycmk2dnF1TEFxS3V1aG5DRHJyTGpxdGF6cnBid2c3WWExN0oyODdaVzA3SnFVTGlBcUt1eTNxT3lHakNvcTY0cVVJT3lDck95YXFleWVrT3F3Z0NEdGxaanFzNkFnN0o2STY0cVVJT3lla2V5WGhleWR0Q0RzdDZqc2hvenJrSnpyaTZUcXM2QWc3SmlrN1pXMDdaV2dJT3lJbUNEc25vanNsclFnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzRLT2pvNkNnb2pJeU1nN1ppYzdZT2Q3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SjJFSU91VmpBb0s3SmlJS1FvdElPdXFxT3llaE95bmdPeWJrT3E0aUNEc2w0YnNuYlFnNjZxbzdKNkU3WWExN0o2bDdKMkVJT3Vuak91VHBPcTVqT3lhbEQ4ZzdLZUE2cmlJSU91d20reW5nQ0RzbFlyc25MenJxYlFnNjZxbzdKNkU3S2VBN0p1UTZyaUk3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnN0pXOTZyU0E3SmVRDQpJT3VQbWV5ZG1PMlZtT3VwdENEcnFxanNub1RzcDREc201RHF1SWpzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdaaWM3WU9kSU91TWdPeURnU0RzbFlqcmdyUUtDaW9xN0lTYzY3bUU3SXFrNjRxVUlPeVR1Q0RzaUpnZzdKNkk3S2VBNjZlTUxDRHRpcm5zb0pVZzdaaWM3WU9kN0oyQUlPdXdtK3lkaENEc2lKZ2c3SmVHN0oyRUlPdVZqQ0RpaHBJZzZyaU43S0NWN1ppVklPdXN1T3llcGV5Y3ZPdWhuQ0RzamFqc21wUXVLaW9LN0lLczdKcXA3SjZRNjRxVUlPdXN1T3Exck91bHZDRHF2THpxdkx6dG5vZ2c3SjI5N0tlQUlPeVZpdXF6b0NEdG01SHNsclRyczdUcXVMQW83SXFrN0xxVUtTRHJsWXpyckxqc2w1QXNJT3UyZ095Z2xlMllsZXljdk91aG5DRHNrN0RycWJRZzdLQ2M3WktJSU95Z2hPeXl0T3VsdkNEc2s3Z2c3SWlZSU95WGh1dUxwT3F6b0NEc21LVHRsYlR0bFpqcXVMQWc3SW1zN0p1TTdKcVVMZ29LN0ppSUtRb3RJT3F6aE95aWpDRHFzSnpzaEtRZzdaaWM3WU9kN0oyQQ0KSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnTkM0MUpTRHF1SWpycHF3ZzdaaWM3WU9kNjZlTUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZ29LS2lvcUNnb2pJeUEwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phMENncnNvSnp0a29nZzdKV0k3SmVRN0lTY0lDZCs3SXVjNnJLZzdKYTA3SnFVUHljc0lDZnNpNXpyZ3Bqc21wUS9KeXdnSjM3cXU1Z25JT3F3bWV5ZGdDRHFzN3pyajRUdGxad2c2cks5N0phMDY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVDdXkxbk91TWdPMlZuQ0RzdXBEc283enNscnp0bFpqcXM2QWc3TG1jNnJlODdaV2NJT3Vua08ySXJPdWx2Q0RzazdEcmlwUWc2cktNSU95aWkreVZoT3lhbEM0SzZySzk3SmEwNjRxVUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRJdDZySzk3SmEwNjZXOExleU5xT3VQaEMzcmtKanJpcFF0NnJLOTdKcXdLZXlYa0NEdGxiVHJpN250bGFBZzY1V002NmVNSU95TnFPeWFsQzRLQ2lNakl5RHJqNW5zZ3F6c2w1RHMNCmhKd2dKMzdzaTV3bklPdTV2T3E0c0FvSzdKaUlLUW90SU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bFpqc2k1enFzcURzbHJUc21wUS9JT0tHa2lEc3ViVHJrNXpycGJ3ZzdaVzA3S2VBN1pXZzZybU03SnFVUHdvdElPeUxuT3lla2UyVm1PeUxuT3VLbENEcnRvVHNsNURxc293Z05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMaURpaHBJZzdJdWM3SjZSN1pXWTY2bTBJRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0NpTWpJeUFuNnJPRTdJdWM2NHVrSnlEaWhwSWdKK3llaU91THBDY0tDdXlZaUNrS0xTRHNucERyajVuc3NLanJwYndnNnJDQTdLZUE2ck9nSU9xemhPeUxuT3VDbU95YWxEOGc0b2FTSU95ZWtPdVBtZXl3cU9xd2dDRHNub2pyZ3Bqc21wUS9DaTBnNjZlazY0dXNJT3V6dE8yWG1PdWpqQ0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VucE91THJDRHJzN1R0bDVqcm80enJpcFFnN0phODY2ZUk3SjI0NnJDQTdKcVVQeUFxS091THFPeUluQ0RzDQp1Wmp0bVpqc25iUWc3SldFNjR1STY1MjhJT3VzdU95ZXBleWRoQ0RzZzRqcm9ad2c3Sk8wSU95Q3JPdWhnT3lZaU95YWxDa3FDZ29qSXlNZ0oreVhyT3l0aU91THBDY2c0b2FTSUNmdG1aWHNuYmp0bFpqcmk2UXNJT3VzdSt1THBDY0tDdXlZaUNrS0xTRHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2Zxc0lEc3A0QWc2NHVrN0l1Y0lPeVhyT3l0cE91enZPcXlqT3lhbEM0ZzRvYVNJT3lWaU95Z2hPMlZuQ0Rxc0p6dGhyWHNuWVFnN0p5RTdaVzBJT3VxaCtxd2dPeW5nQ0RyaTZUc2k1d2c3Wm1WN0oyNDdaV2c2cktNN0pxVUxnb0tJeU1qSUNmcXU1Z25JT0tHa2lBbjdKZVE2cktNSndvSzdKaUlLUW90SU8yWmplcTR1T3VQbWV1TG1PcTdtQ0RyZ3FEc2xZVHFzSURxczZBZzdKNkk3SmEwN0pxVUxpRGlocElnN1ptTjZyaTQ2NCtaNjR1WTdKZVE2cktNSU91Q29PeVZoT3F3Z09xem9DRHNub2pzbHJUc21wUXVDZ29qSXlNZzZySzk3SmEwNjZXOElPdTZrT3lkaENEcmxZd2c3SmEwN0lPSg0KN1pXY0lPcXl2ZXlhc0FvSzdJS3M3SnFwN0o2UTdKMllJT3lnbGV1enRPdWx2Q0Ryc0p2cmlwUWc3S2VJNjZ5NDdKZVE3SVNjSU9xNHNPcXpoT3lnZ2V5Y3ZPdWhuQ0FuZnV5TG5DZnJwYndnNjdxUTdKMkVJT3VWakNEcnJManNucVhzbmJRZzdKYTA3SU9KN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2lvcTdZeU03SldGN1pXWTZyT2dJT3lMdHV5ZGdDRHNvSlhyczdUcnBid2dKK3lqdk95V3RDZnJvWndnN0kybzdJU2NJT3VzdU95ZXBleWRoQ0RzZzRqcm9hM3Fzb3dnN0kybzY3TzA3SVM0N0pxVUxpb3FDZ3JzbUlncENpMGc3SmEwNjVha0lPdXFxZXlnZ2V5Y3ZPdWhuQ0RyaklEc3RwenJzSnZzbkx6c2k1enJncGpzbXBRL0lPS0draURyaklEc3Rwd2c2NnFwN0tDQjdKMjBJT3VzdE95WGgreWR1T3F3Z095YWxEOEtMU0RzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhnNG9hU0lPeUxvT3F6b0NEc25iVHNuS0RycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lFdU95YWxDNEsNCkNpb3FLZ29LSXlNZ05TNGdKM3ZycW9Yc2dxeDlJQ3NnZSt1cWhleUNySDBuSU95VHNPeW5nQ0RzbFlycXVMQUtDaU1qSXlEdGxaenNucERzbHJRZzdaS0E3SmEwN0pPdzZyaXdDZ3J0bFp6c25wRHNsclFnNjZxRjdJS3M2Nlc4SU8yU2dPeVd0T3lFbkNEcmo1bnNncXdnN1ppVjdZT2M2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUlPS0draURzbmJUc25wRHJwYndnNjQrTTY2Q2s2N0NiN0pXWTdKYTA3SnFVQ2kwZzY0SzA3SjI4SU95NXRPdVRuT3F3a3V5ZHRDRHFzckRzb0p6cmtLQWc3SmlJN0tDVjdKMjA3SmVRN0pxVUlPS0draURyZ3JUc25ienNuWUFnN0xtMDY1T2M2ckNTSU91Q21PcXdnT3VLbENEcmdxRHNuYlRzbDVEc21wUUtDaU1qSXlEdGxaenNucERzbHJUcnBid2c3WktBN0phMDdKT3c2cml3SU95V3RPdWdwT3lhdUNEcXNyM3NtckFLQ2lkNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFDQpuQ2NnN1ppVjdZT2M2NkdjNjZlTUlPMlNnT3lXdE95a21PdVBoQ0RyalpRZzdMcVE3S084N0phODdaV1k2cktNSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SU95ZWxPeVZvU0RydG9Ec29iSHNuTHpyb1p3ZzZyV3M2NmVrN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbENEaWhwSWc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVQ2dvcUtpb0tDaU1qSURZdUlPMlJuT3E0c0NEdGhyWHNuYndLQ2lNakl5RHJrSmpzbHJUc21wUWdLRmdwSU9LR2tpRHJqN3pzbXBRZ0tFOHBDZ3JycXFqcnNKVHNuYndnN1ptVTY2bTA3SjJZSU95aWdleWRnQ0RxczdYcXNJVHNuWVFnNnJPZzY2Q2s3WlcwSUNmcmtKanNsclRzbXBRbjY0cVVJT3VxcU91UmtDQW42NCs4N0pxVUordWhuQ0R0aHJYc25ienRsYlRzaEp3ZzdJMm83S084N0lTNDdKcVVMZ29LS2lvcUNnb2pJeUEzTGlEcmdxRHNwNXpDdCt5TG5PcXdoTUszN0lpcjdKNlFJTzJSbk9xNA0Kc0FvSzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt1eWlPMll1T3VLbENEc2xZVHJucGdnN1ppVjdJdWQ3Snk4NjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc21wUXVDZ29qSXlNZzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCtxNHNPcXdoQW9LZkNEdGxhM3JxcWtnZkNEdG1KWHNpNTBnZkNEc21JanNpNXdnZkFwOExTMHRMUzB0ZkMwdExTMHRMWHd0TFMwdExTMThDbndnNjRLZzdLZWNJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1RVMHVSRVJnSUh3Z01qQXlOUzR3TVM0d01Td2dNalV1TURFdU1ERWdmQXA4SU95TG5PcXdoQ0I4SU9xNHNPdXp1Q0JnU0VnNlRVMDZVMU5nSUM4ZzdLZW42cktNSUdCSVNEcE5UV0FnS095WXBPeWdoQy9zbUtUdG00UWc3SldJSU95VWdDa2dmQ0F4TkRvek1Eb3hNU3dnTVRNNk16QWdmQXA4SU9xNHNPcXdoQ0I4SU9xNHNPdXp1Q0JnV1ZsWldTNU5UUzVFUkg1WldWbFpMazFOTGtSRVlDQXZJT3lucCtxeWpDQmdXVmxaV1M1TlRTNUVSSDVOVFM1RVJHQWcNCmZDQXlNREkxTGpBeExqQXhmakl3TWpVdU1ERXVNekVzSURJd01qVXVNREV1TURGK01ERXVNekVnZkFwOElPdUNvT3lubkNBcklPeUxuT3F3aENCOElHQlpXVmxaTGsxTkxrUkVJRWhJT2sxTllDQjhJREl3TWpVdU1ERXVNREVnTVRRNk16QWdmQXA4SU95YWxPeWR2Q0I4SUdCWldWbFpMazFOTGtSRUtPeWFsT3lkdkNsZ0lPS0FsQ0RzbTVRdjdabVVMK3lJbUMvcnFxa3Y2cmlJTCsyR29DL3NuYndnZkNBeU1ESTFMakF4TGpBeEtPeUltQ2tnZkFvS0tpcnNpNXpxc0lRZzdKaUk3Sm00S2lvNklPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDQmc3SmlrN0tDRUwreVlwTzJiaENCSU9rMU5ZT3lkaENEc2phanJqNFFnNjQrODdKcVVMZ3JzbUlncElPeVlwTzJiaENBeE9qQXdDZ29qSXlNZzY2eTQ3SjZsSU95R2pTRHNsN0RzbTVUc25id0tDdXVzdU95ZXBTRHNsWWpzbDVEc2hKenJpcFFnS2lyc201VEN0K3lkdkNEc2xaN3NuWmdnDQpNT3lkaENEcnVienFzNkFxS2lEc2phanNtcFF1Q2dyc21JZ3BDaTBnTWpBeU51dUZoQ0F3T095YmxDQXdOZXlkdkNEc25vWHJpNGpyaTZRdUlPS0draUF5TURJMjY0V0VJRGpzbTVRZ05leWR2Q0Rzbm9Ycmk0anJpNlF1Q2dvakl5TWc3SU9CNjR5QUlPeUxuT3F3aENBbzY0VzQ3TGFjN0pxcEtRb0tmQ0Rzb2JEcXNiUWdmQ0R0a1p6cXVMQWdmQXA4TFMwdExTMHRmQzB0TFMwdExYd0tmQ0EyTU95MGlDRHJyN2pycDR3Z2ZDRHJzS25xdUlnZzdLQ0VJSHdLZkNBMk1PdTJoQ0RycjdqcnA0d2dmQ0JPNjdhRUlPeWdoQ0I4Q253Z01qVHNpNXpxc0lRZzY2KzQ2NmVNSUh3Z1R1eUxuT3F3aENEc29JUWdmQXA4SURNdzdKMjhJT3V2dU91bmpDQjhJRTdzbmJ3ZzdLQ0VJSHdLZkNBeE11cXduT3libENEcnI3anJwNHdnZkNCTzZyQ2M3SnVVSU95Z2hDQjhDbndnTVRMcXNKenNtNVFnN0oyMDdJT0JJSHdnVHV1RmhDRHNvSVFnZkFvSzdKaUlLU0Ryc0tucXVJZ2c3S0NFTENBMTY3YUVJT3lnaEN3Z011eUxuT3F3aENEcw0Kb0lRc0lEUHNuYndnN0tDRUxDQTI2ckNjN0p1VUlPeWdoQ3dnTXV1RmhDRHNvSVFLQ2lNakl5RHJwNGpxc0pEQ3QrcTRzT3F3aENEcnA0enJvNHdLQ21CRUxVNWdLRTdzbmJ3ZzY0S283SjJNS1NBdklHQkVMVEJnS095WXBPdUttQ0RycDRqcXNKQXBJQzhnWUVRclRtQW9UdXlkdkNEcXNyM3FzN3dwQ3V5WWlDa2dSQzAzTENCRUxURXNJRVF0TUN3Z1JDc3hDZ29qSXlNZzY3S0k3Wmk0SU8yUm5PcTRzQ0FvN1pXWTdKMjA3WlNJN0p5ODY2R2NJT3Exck91MmhDa0tDbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdLZkMwdExTMHRMWHd0TFMwdExTMThMUzB0TFMwdGZBcDhJT3lnaE8yWmxPdXlpTzJZdUNCOElPMlZtT3lkdE8yVWlDRHF0YXpydG9RZ2ZDQXdNaTB4TWpNMExUVTJOemdzSURBeE1DMHhNak0wTFRVMk56Z2dmQXA4SU95NXRPdVRuT3V5aU8yWXVDQjhJRFRzbnBEcnBxenNsS2tnN1pXWTdKMjA3WlNJSUh3Z01USXpOQzAxTmpjNExUa3dNVEl0TXpRMU5pQjhDbndnNnJPRTdLS00NCjY3S0k3Wmk0SUh3ZzdaV1k3SjIwN1pTSUlPcTFyT3UyaENCOElERXlNeTAwTlRZdE56ZzVNREV5SUh3S2ZDRHNvN3pycjd6cms3SHJvWjNyc29qdG1MZ2dmQ0RzbFo0Z051eWVrT3VtckMzcmtxUWdOK3lla091bXJDQjhJREV5TXpRMU5pMHhNak0wTlRZM0lId0tmQ0RzZ3F6c2w0WHNucERyazdIcm9aM3Jzb2p0bUxnZ2ZDQXhNT3lla091bXJDRHRsWmpzbmJUdGxJZ2dmQ0F3TVMweU16UXROVFkzT0RrZ2ZBb0tJeU1qSU95VHNPdXB0Q0RzbFlnZzY1Q1k2NHFVSU8yUm5PcTRzQW9LTFNEcmdxRHNwNXpzbDVBZzdaV1k3SjIwN1pTSXdyZnJ1WmZxdUlnNklPS2RqQ0F5TURJMUxUQXhMVEF4TENBd01TOHdNUW90SU95TG5PcXdoT3lYa0NEc21LVHNvSVF2N0ppazdadUVPaURpbll3ZzdKaWs3S0NFSURIc2k1d2dLaWpyaTZnc0lPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDRHNtSWpzbWJncEtnb0tLaW9xQ2dvaklPeVlpT3laDQp1Q0RxdDV6c3Vaa0tDdXlia095NW1TanJpcVhyajVuQ3QrcTRqZXlnbGNLMzdMcVE3S084N0phOEtldXp0T3VMcENEc21JanNtYmpxc0lBZzY0MlVJT3VxaGUyWmxlMlZuQ0RzdTZUcnJxVHJpNGpzdklEc25iVHNoWmpzbllRZzY2ZU02NU9jNjRxVUlPcXl2ZXlhc095WWlPeWFsQzRLQ2lNaklPeVlpT3ladUNBeExpRHNpSmpyajVudG1KVWc2Nnk0N0o2bDdKMkVJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3Q2dvakl5TWc3SVNjNjdtRTdJcWtJT3lpaGV1ampDd2c2cml3NnJDRUlPdW5qT3VqakFvSzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VHNPdXB0Q0Rzbzd6c2xyUW83S0tGNjZPTUlPeUVuT3U1aE95S3BDd2c2cml3NnJDRUlPdVRzU25ycGJ3ZzZyQ1Y3S0d3N1pXZ0lPeUltQ0Rzbm9qcXM2QXNJQ2Zzb29Ycm80d243Sm1BSUNmcnA0enJvNHduN0oyWUlPdUptT3lWbWV5S3BPdWx2Q0Rzb0pYdG1aWHRub2dnN0tDRTY0dXM3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ3JzbUlncENpMGdUMDlQSU95RQ0Kbk91NWhPeUtwQ0Rzb29Ycm80d2c3SldJNjRLMElPS0FsQ0F3TU95YmxDQXdNT3lkdk91MmdPMkVzQ0RzaEp6cnVZVHNpcVRxc0lBZzdLS0Y2Nk9NNjQrODdKcVVMaURzbnBEc2hManRsWndnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3VUbk91Z3BPeWFsQzRLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZ29LNjR1b0xDQXFLdXlqdk9xNHNPeWdnZXljdk91aG5DRHNvb1hybzR6cXNJQWc2N0NZNjdPMTY1Q1k2NHFVSU95Z25PMlNpQ29xN0plUTY0cVVJQ2Zzb29Ycm80enJqN3pzbXBRbjY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVDZ3JzbUlncENpMGc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVJT0tHa2lEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURyZ1ozcmdwanNtcFFLQ2lNakl5RHNncXpzbXFuc25wRHNsNURxc293ZzY2KzQ3TG1ZNjRxVUlPeVlnZTJXcGV5ZGhDRHNsWXpyb0tUc3BJUWcNCjY1V01DZ29vN0tPODdKcVVJT3VQbWV5Q3JDQTZJT3lYc095eXRDd2c3WlcwN0tlQUxDRHNvSUhzbXFrZzY1T3hLUW9LN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lUc091cHRDRHNuYmpxczd3ZzZyU0E2ck9FNjZXOElPdXFoZTJabGUyVm1PcXlqQ0RzaEtUcnFvWHRsWmpxczZBc0lDZnNncXpzbXFuc25wRHNuWmdnN1phSjY0K1o3SmVRSU91VXNPdWR2T3lZcE91S2xDRHFzckRxczd3bjY1Mjg2NHFVSU95Z2tPeWRoQ0RzbFl6cm9LVHNwSVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHNtS1RyaXBqcXVZenNwNEFnNjRLMDdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbDdEc3NyVHJqN3pzbXBRdUlPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb3RJT3VNZ095Mm5PeWRoQ0Rxc0lqc2xZVHRnNERycWJRZzdKdVE2NTZZSU91TWdPeTJuT3lkdENEdGxiVHNwNERyajd6c21wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXDQppZXlYa0NEcmdyVHNsYndnN1pXMDdKcVVMZ29LSXlNaklPeUNyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPeUltT3VQbWUyWWxTa0tDaWZzb0pYcnM3UWc3SWlZN0tlUklPeVZpT3VDdENjZzY1T3g3SjJZSU91dnZPcXdrTzJWbkNEc2c0SHRtYW5zbDVEc2hKd2dLaXJzaTV6c2lxVHRoWnpzbmJRZzdKNlE2NCtaN0p5ODY2R2NJT3l5bU91bXJPMlZuT3VMcE91S2xDRHNvSkFxS3V5ZGhDRHNpSmpyajVudG1KWHNuTHpyb1p3ZzdKV002NkNrSU95Q3JPeWFxZXlla091bHZDRHNsWWpzaTZ6dGxaanFzb3dnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0oyMDdLQ2M2N2FBN1lTd0lPMlpqZXE0dU91UG1ldUxtT3lkbUNEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFFLTFNEcmpaUWc3S0tMN0oyQUlPeURnZXVMdE95ZGhDRHNuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkZ0NEcmhibnNuWXpyajd6c21wUUtDaU1qSU95WWlPeVp1Q0F5TGlEcQ0Kc3Izc2xyVHJwYndnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBS0N1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla095ZG1DRHJwNlhybmIzc25ZUWc3Wm1jN0pxcDdaVzA3SVNjSU95bmlPdXN1TzJWb0NEcmxZd0tDaWZzaTV6cmdwanNtcFEvSnl3Z0oreUZxT3VDbU95YWxEOG5JTzJZbGUyRG5PeWRtQ0Rxc3Izc2xyVHJwYndnN1ptYzdKcXA3WlcwN0lTY0lPeUNyT3lhcWV5ZWtPeWRtQ0RyaTdudG1hbnNpcVRybjZ6c200RHNuWVFnN0tTRTdKMjhJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdabU42cmk0NjQrWjY0dVlMQ0JQVDA4ZzY0dWs2NFdBN0ppazdJV282NEtZN0pxVVB3b3RJT3kycWV5Z2hPMlZtT3VmckNEdGpyanNuWmpzb0pBZzZyQ0E3SXVjNjRLWTdKcVUNClB3b0tJeU1qSU95Q3JPeWFxZXlla095ZG1DRHNnNEh0bWFuc25ZUWc3TGFVN0tDVjdaV2dJT3VWakFvSzY2cUY3Wm1WN1pXY0lPeWdsZXV6dE9xd2dDRHNsNGJzbHJUc2hKd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeW5nZXlna1NEdGpKRHJpNmp0bFpqcXNvd2c3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHN1YlRyazV6cnBid2c2N0NiN0p5ODdJV282NEtZN0pxVVB5RHJrN0hyb1ozdGxaanJxYlFnN0xxUTdJdWM2N0N4SU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SVNnN0oyWTZyQ0FJTzJWaE95YWxPMlZvQ0RybFl3S0N1eUVwT3VzdU95aHNPeUNyT3l5bU91ZnZDRHNncXpzbXFuc25wRHNuWmdnN0lTZzdKMlk2Nlc4SU9xNHNPdU1nTzJWdE95VnZDRHRsYUFnNjVXTUlPcXl2ZXlXdE91aG5DRHNvSlhzDQpwSkh0bFpqcXNvd2c3S2VJNjZ5NDdaVzA3SnFVTGdvSzdKaUlLUW90SU95ZHRPdXlpQ0RyaTZ6c2w1QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWbU91cHRPeUVuQ0RzbHJ6cnA0anJncGdnNjZlTTdLR3g3WldZN0lXbzY0S1k3SnFVUHdvS0l5TWc3SmlJN0ptNElETXVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBS0N1eUNyT3lhcWV5ZWtPeVhrT3F5akNEcnFvWHRtWlh0bFpqcXNvd2c2N2FBN0tDVjdLQ0I3SjI0SU91Q3RPeWFxZXlkaENEc2xZenJvS1RzcEpqc2xid2c3WldnSU91VmpPdUtsQ0RydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJFSU95TnFPdVBoQ0Rzb292c2xZVHNtcFF1Q2dvakl5TWc3SVNjNjdtRTdJcWs2Nlc4SU95Z2xleXhoZXlEZ1NEc2s3Z2c3SWlZSU95WGh1eWRoQ0RybFl3S0N1dTJnT3lnbGUyWWxleWN2T3VobkNEc2phanNsYndnN0lLczdKcXA3SjZRN0plUTZyS01JT3lEZ2UyWnFleWRoQ0RycW9YdG1aWHRsWmpxc293Zw0KN0oyNDdLZUE3SXVjN1lLc0lPeUltQ0Rzbm9qc2xyVHNtcFF1SUNvcTdKTzRJT3lJbUNEc2w0YnJpcFFnN0oyMDdKeWc2Nlc4SU8yVnFPcTdtQ0RzbFlqcmdyVHRsYlRzbzd6c2hManNtcFF1S2lvS0N1eVlpQ2tLTFNEc3A0RHF1SWpzbllBZzZyQ0E3SjZGN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SU95eXJleUdqT3VGaE95ZGhDRHNuSVR0bFp3ZzdJU2M2N21FN0lxazY0cVVJT3lWaE95bmdTRHNwSURydVlRZzdLU1I3SjIwN0plUTdKcVVMZ290SU9xenRldXN0T3lia095ZGdDRHRtNFRzbTVEcXVJanNuWVFnNjdPMDY0SzhJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdLQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE2ckNBSU95V3RPdVdwQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0RzbDRicmlwVHNwNEFnNjZxRjdabVY3WldZNnJLTUlPeWR1T3luZ08yVm9DRHNpSmdnN0o2STdKYTANCjdKcVVMZ29LN0ppSUtRb3RJT3lna09xeWdDRHF1TERxc0lRZzY0K1o3SldJSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla0NEc2hLRHRnNTNzblpnZzZyS3c2ck84NjZXOElPeVZpT3VDdE8yVm9DRHJsWXdLQ3V1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPeUVvTzJEbmV5ZGdDRHJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzY2cUY3Wm1WN1pXWTZyS01JT3lWak91Z3BPeWFsQzRLQ3V5WWlDa0tMU0R0bFp3ZzY3S0lJT3V3bE9xK3VPdXB0Q0RzdXBEc2k1enJzTEhzbllBZzY0dWs3SXVjSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrS0NpZnNvSlhyczdRZzdJaVk3S2VSDQpJT3lWaU91Q3RDY2c2NU94N0oyWUlPdXZ2T3F3a08yVm5DRHNnNEh0bWFuc2w1RHNoSndnS2lyc29KWHJzN1Rxc0lBZzY3TzA3Wmk0NjVDYzY0dWs2NHFVSU95Z2tDb3E3SjJFSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzbFl6cm9LUWc3SUtzN0pxcDdKNlE2Nlc4SU95VmlPeUxyTzJWbU9xeWpDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHNnNEhyaTdUc25iUWc2NEdkNjRLWTY2bTBJT3lnaE91c3VPcXdnT3VQaENEdG1ZM3F1TGpyajVucmk1anNuWmdnN0tDVjY3TzA2Nlc4SU91enZDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1Rxc0lBZzZyaXc2NkdkNjVDWTdLZUFJT3lWaXV5VmhPeWFsQzRLQ2lNaklPeVlpT3ladUNBMExpRHNvSnp0a29nZzdKcXA3SmEwNjRxVUlPdXdsT3ErdU95bmdDRHNsWXJxdUxBS0NpZnFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NjZzdKdVE3TG1aNjdPMDY0dWtJQ29xN1ptVTY2bTA3SjJZSU9xNA0Kc091S3BldXFoY0szNjdLRTdZcTg2NnFGNnJPODdKMllJT3lhcWV5V3RDRHNuYnpzdVpncUt1cXdnQ0RzbXJEc2hLRHNuYlRzbDVEc21wUXVDdXE0c091S3BldXFoZXlYa0NEc2s3RHNuYmdnNjR1bzdKYTBLT3V6Z09xeXZTd2c3S2VBN0tDVkxDRHJrN0hyb1owZzY1T3hLZXVsdkNEc2xZanJnclFnNjZ5NDZyV3M3SmVRN0lTY0lPdUxwT3VsdUNEcnA1RHJvWndnNjdDVTZyNjQ2Nm0wSU95Q3JPeWFxZXlla09xd2dDRHJpNlRycGJnZzZyaXc2NHFsN0p5ODY2R2NJT3lZcE8yVnRPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1NBbjZyYU03WldjSU91emdPcXl2U2NnNnJpdzY0cWw3SjJZSU95VmlPdUN0Q0RyckxqcXRhd0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V3bE9xL2dDRHNpSmdnN0o2STdKYTA3SnFVSUNoWUtRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWUNCmtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3T0E2cks5N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cENnb2pJeURzbUlqc21iZ2dOUzRnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NJT3lUc095bmdDRHNsWXJxdUxBS0N1dXN1T3Exck91bHZDRHNsWVRyckxUcnBxd2c2NmVrNjRHRTY1Kzk2cktNSU91THBPdVRyT3lXdE91UGhDQXFLdXlMcE95Z25DRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F3cUt1dWx2Q0RzazdEcnFiUWc3SjZZNjZxNzY1Q2NJT3VzdU9xMXJPeVlpT3lhbEM0S0N1eVlpQ2tnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDQW43TGFVNnJDQUlPeW5nT3lnbFNmdGxaanJpcFFnN0l1YzdJcWs3WVdjN0plUTdJU2NJQ2pzbmJUc29JVEN0K3lXa2V1UGhDRHF1TERyaXFYc25iUWc3SldFNjR1WUtRb3RJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDRHJoSmpxDQpzcWpzbzd6c2hManNtcFFnS0ZnZzRvQ1VJT3lYaHV1S2xDQW42NFNZNnJpdzZyaXdKeURxdUxEcmlxWHNuWVFnN0pXVTdJdWNLUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxiUWc3S084N0lTNDdKcVVJQ2hQS1FvPQ0KOjpMQVVOQ0hFUjo6DQovLzRuQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJDQUhJQWFRQmtBR2NBWlFBZ0FHd0FZUUIxQUc0QVl3Qm9BR1VBY2dBZ0FCUWdJQURvc3NTc3hMd2dBQ1RCRmNnZ0FCRElnS3dnQU1UV0lBRGtzcXk1SUFEa3dvblZDZ0FuQUNBQVl3QnNBR0VBZFFCa0FHVUFZZ0J5QUdrQVpBQm5BR1VBT2dBdkFDOEFJQUFFMVZ5NG9ORmN6M1RISUFCMHh5QUFETk44eDBUSElBQ0F2WGk1NUxJZ0FDZ0E4YlJkdURvQUlBQjAwRnk0M0xUa3NxeTVMUURReG5UUXJibnd4YkNzTGdCMkFHSUFjd0FwQUM0QUNnQW5BQ0FBVkxzQXJDQUFZTDQ0eUNBQWlNYzh4M1M2SUFCYzFTQUFpTHpReFNBQVdOV1lzQ25GSUFCSXhiU3dXTlhnckN3QUlBRGtzaUFBQU1sRXZoaTBkTG9nQU9TeXJMbDh1U0FBUGN3Z0FNYkZkTWNnQU9UQ2lkVmMxZVN5TGdBS0FGTUFaUUIwQUNBQVpnQnpBRzhBSUFBOUFDQUFRd0J5QUdVQVlRQjBBR1VBVHdCaUFHb0FaUUJqQUhRQUtBQWlBRk1BWXdCeUFHa0FjQUIwQUdrQWJnQm5BQzRBUmdCcEFHd0FaUUJUQUhrQQ0KY3dCMEFHVUFiUUJQQUdJQWFnQmxBR01BZEFBaUFDa0FDZ0JUQUdVQWRBQWdBSE1BYUFBZ0FEMEFJQUJEQUhJQVpRQmhBSFFBWlFCUEFHSUFhZ0JsQUdNQWRBQW9BQ0lBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRk1BYUFCbEFHd0FiQUFpQUNrQUNnQmtBR2tBY2dBZ0FEMEFJQUJtQUhNQWJ3QXVBRWNBWlFCMEFGQUFZUUJ5QUdVQWJnQjBBRVlBYndCc0FHUUFaUUJ5QUU0QVlRQnRBR1VBS0FCWEFGTUFZd0J5QUdrQWNBQjBBQzRBVXdCakFISUFhUUJ3QUhRQVJnQjFBR3dBYkFCT0FHRUFiUUJsQUNrQUNnQnpBR2dBTGdCREFIVUFjZ0J5QUdVQWJnQjBBRVFBYVFCeUFHVUFZd0IwQUc4QWNnQjVBQ0FBUFFBZ0FHUUFhUUJ5QUFvQUNnQW5BQ0FBTVFBdkFESUFLUUFnQUU0QWJ3QmtBR1VBTGdCcUFITUFJQUFReUlDc0lBQVVJQ0FBeHNVOHgzUzZJQURrc3JUR1hMamN0Q0FBbU5OMHg4REpmTGtnQVBURnRNVUF5ZVN5Q2dCSkFHWUFJQUJ6QUdnQUxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BSUFCM0FHZ0ENClpRQnlBR1VBSUFCdUFHOEFaQUJsQUNJQUxBQWdBREFBTEFBZ0FGUUFjZ0IxQUdVQUtRQWdBRHdBUGdBZ0FEQUFJQUJVQUdnQVpRQnVBQW9BSUFBZ0FFa0FaZ0FnQUUwQWN3Qm5BRUlBYndCNEFDZ0FJZ0JPQUc4QVpBQmxBQzRBYWdCekFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGk0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQmJBRlhXZU1kZEFFVEhJQUFFc25TNWRMb2dBT1N5dE1aY3VOeTBJQUNZMDNUSHdNa0FyQ0FBOU1XOXVjaXk1TEl1QUNBQUpNRll6bnk1SUFESXVWek9JQUNrdEN3QUlBQU0xZXkzK0sxNHg5REZITUVnQUhUUVhMamN0Q0FBaEx5ODBrVEhJQURrc3R6Q0lBQU1zdXkzSUFEOHlEakJsTVl1QUNJQUxBQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUIyQUdJQVR3QkxBRU1BWVFCdUFHTUFaUUJzQUNBQUt3QWdBSFlBDQpZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FERUFMd0F5QUNrQUlBQVVJQ0FBVGdCdkFHUUFaUUF1QUdvQWN3QWlBQ2tBSUFBOUFDQUFkZ0JpQUU4QVN3QWdBRlFBYUFCbEFHNEFDZ0FnQUNBQUlBQWdBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQm9BSFFBZEFCd0FITUFPZ0F2QUM4QWJnQnZBR1FBWlFCcUFITUFMZ0J2QUhJQVp3QXZBR3NBYndBdkFHUUFid0IzQUc0QWJBQnZBR0VBWkFBaUFBb0FJQUFnQUVVQWJnQmtBQ0FBU1FCbUFBb0FJQUFnQUZjQVV3QmpBSElBYVFCd0FIUUFMZ0JSQUhVQWFRQjBBQW9BUlFCdUFHUUFJQUJKQUdZQUNnQUtBQ2NBSUFBeUFDOEFNZ0FwQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0FBRU1pQXJDQUFGQ0FnQU1iRlBNZDB1aUFBSk1GWXpyY0FYTGo0clhqSElBQXB2Slc4Uk1jZ0FFakZ0TEJjMWVTeUNnQkpBR1lBSUFCekFHZ0FMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQQ0KSUFCM0FHZ0FaUUJ5QUdVQUlBQmpBR3dBWVFCMUFHUUFaUUFpQUN3QUlBQXdBQ3dBSUFCVUFISUFkUUJsQUNrQUlBQThBRDRBSUFBd0FDQUFWQUJvQUdVQWJnQUtBQ0FBSUFCTkFITUFad0JDQUc4QWVBQWdBQ0lBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGlBQUtBQVF0cFN5SUFCUUFFRUFWQUJJQU5ERklBREd4YlRGbE1ZcEFDNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdBdzBmaTdFTEhReFJ6QklBQkV4WmkzZkxrZ0FDVEJXTTYzQUZ5NCtLMTR4MXpWSUFDa3RDd0FJQUIwMEZ5NDNMUWdBSVM4dk5KRXh5QUE1TExjd2lBQURMTHN0eUFBL01nNHdaVEdPZ0FpQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQUpnQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBaUFDQUENCklBQnVBSEFBYlFBZ0FHa0FiZ0J6QUhRQVlRQnNBR3dBSUFBdEFHY0FJQUJBQUdFQWJnQjBBR2dBY2dCdkFIQUFhUUJqQUMwQVlRQnBBQzhBWXdCc0FHRUFkUUJrQUdVQUxRQmpBRzhBWkFCbEFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBSUFBZ0FHTUFiQUJoQUhVQVpBQmxBQ0FBYkFCdkFHY0FhUUJ1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFWZFo0eHlBQUtieVZ2RG9BSUFBdzBmaTdFTEhReFJ6QklBQmpBR3dBWVFCMUFHUUFaUUFnQUMwQUxRQjJBR1VBY2dCekFHa0Fid0J1QUNBQWRNY2dBSVM4Qk1oRXh5QUFuTTBsdUZqVmRMb2dBQURKUkw0Z0FFVEd6TGlGeDhpeTVMSXVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUtBQ3N3S25HDQp5YmRBeHlBQWRNY2dBRkFBUXdEUXhTQUFYTGo0clhqSEhMUWdBSFRRWExqY3RDQUFiSzNGc3lBQVhOWEVzOURGSE1FZ0FDak1FS3dwdE1peTVMSXVBQ2tBSWdBc0FDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUhZQVlnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURJQUx3QXlBQ2tBSUFBVUlDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNJQUNnQWdBQ0FBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRkVBZFFCcEFIUUFDZ0JGQUc0QVpBQWdBRWtBWmdBS0FBb0FKd0FnQUFESlJMNGdBRVRHekxnZ0FCUWdJQURrc3F5NWZMa2dBRDNNSUFER3hYVEhJQURrd29uVklBQW9BQXpWN0xmNHJYakhkTWNnQU9lc0lBQ1F4OW16SUFBUXJNREpLUUFLQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JqQUcwQVpBQWdBQzhBWXdBZ0FHNEFid0JrQUdVQUlBQnpBR01BY2dCcEFIQUFkQUJ6QUZ3QVl3QnNBR0VBZFFCa0FHVUFMUUJpQUhJQQ0KYVFCa0FHY0FaUUF1QUdvQWN3QWlBQ3dBSUFBd0FDd0FJQUJHQUdFQWJBQnpBR1VBQ2dBPQ0KOjpXQVRDSEVSOjoNCkx5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tLTHk4ZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU95Wm5DRHRsWVRzbXBUdGxaenFzSUE2SU8yVXZPcTN1T3VuaU9xd2dDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1kyeGhkV1JsWW5KcFpHZGxPaTh2SU95WHRPcTRzQ2gzYVc1a2IzY3ViM0JsYmk5cFpuSmhiV1V2YjNCbGJrVjRkR1Z5Ym1Gc0tldWx2QW92DQpMeURzb0lUcnRvQWc3SWFNNjZhc0lPeVhodXlkdENEcnA0bnJpcFFnNjdLRTdLQ0U3SjIwSU95ZWlPdUxwQzRnWm1WMFkyanJpcFFnNjZxN0lPdW5pZXljdk91dmdPdWhuQ3dnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKRHNpNXpzbnBEc2w1RHFzb3dLTHk4Z1VFOVRWQ0F2ZDJGclpTRHJwYndnNjdPMDY0SzA2Nm0wSU9xd2tPeUxuT3lla09xd2dDRHJpNlRycHF3b1kyeGhkV1JsTFdKeWFXUm5aUzVxY3lucnBid2c2NHlBN0l1Z0lPeThvT3VMcEM0S0x5OEtMeThnNjR1azY2YXM3Sm1BN0oyWUlPeXdxT3lkdERvZzZyQ1E3SXVjN0o2UTY0cVVJR05zWVhWa1pldWx2Q0Ryckx6c3A0QWc3SldLNjRxVTY0dWtLT3lla095TG5TRHNsNGJzbll3cElPS0draUR0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3VsdkNEc2xZZ2c2NmVKNnJPZ0xBb3ZMeURycVpUcnFxanJwcXdnZmpFMVRVTHJuYndnNjZHYzZyZTQ3SjI0SU95TG5DRHNucERyajVrZzdJdWM3SjZSN0p5ODY2R2NJT3lEZ2V5TA0KbkNEc3ZKenJrYXpyajRRZzY3YUE2NHUwSU95WGh1dUxwQ0FvNjVPeDY2R2RPaUJ1Y0cwZ2NuVnVJR0oxYVd4a0tTNEtMeThnNjR1azY2YXM2NHFVSU95THJPeWVwZXV3bGV1UG1TRHJnWXJxdUxEcnFiUWc3S085N0tlQTY2ZU1LTzJVak91ZnJPcTN1T3lkdU9xenZDRHNnNTNzZ3F3ZzY0K1o2cml3N1ptVUtTd2c2ckNRN0l1YzdKNlE2NHFVSU9xemhPeUdqU0RyZ3Fqc2xZUWc2NHVrN0oyTUlPcTVxT3lhc09xNHNPdWx2Q0Ryc0p2cmlwVHJpNlF1Q2dwamIyNXpkQ0JvZEhSd0lEMGdjbVZ4ZFdseVpTZ25hSFIwY0NjcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQm1jeUE5SUhKbGNYVnBjbVVvSjJaekp5azdDbU52Ym5OMElHOXpJRDBnY21WeGRXbHlaU2duYjNNbktUc0tZMjl1YzNRZ2V5QnpjR0YzYml3Z2MzQmhkMjVUZVc1aklIMGdQU0J5WlhGMWFYSmxLQ2RqYUdsc1pGOXdjbTlqWlhOekp5azdDZ3BqYjI1emRDQlFUMUpVSUQwZ01URTRPRGs3Q21OdmJuTjANCklGSlBUMVFnUFNCd1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5MaTRuS1RzZ0x5OGc3S0NBN0o2bDdJYU1JT3VqcU8yS3VDRGlnSlFnNjR1azY2YXM2ckNBSUhKbFkyOXRiV1Z1WkMxbGVHRnRjR3hsY3k1dFpPdWx2Q0Rzc0w3cmlwUWc2cml3N0tTQUNncGpiMjV6ZENCRFQxSlRYMGhGUVVSRlVsTWdQU0I3Q2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVTl5YVdkcGJpYzZJQ2NxSnl3S0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxSVpXRmtaWEp6SnpvZ0owTnZiblJsYm5RdFZIbHdaU2NzQ24wN0NtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXdvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxDQpjMjl1T3lCamFHRnljMlYwUFhWMFppMDRKeUI5TENCRFQxSlRYMGhGUVVSRlVsTXBLVHNLSUNCeVpYTXVaVzVrS0VwVFQwNHVjM1J5YVc1bmFXWjVLRzlpYWlrcE93cDlDZ292THlCamJHRjFaR1VnUTB4SjZyQ0FJT3llaU91S2xPeW5nQ0RpZ0pRZzdKZUc3Snk4NjZtMElDOTNZV3RsSU95ZGtldUx0ZXlYa0NEc2k2VHNsclFnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPeWR2ZXE0c0NEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpJQ2pyaTZUcnBxenNuWmdnWTJ4aGRXUmxRV05qYjNWdWRPeVpnQ0Rxc0puc25ZQWc3TGFjN0xLWUtTNEtMeThnN1l5TTdKMjg3SjIwSU8yQnRDRHNpSmdnN0o2STdKYTBJRE13N0xTSUlPeTZrT3lMbkM0ZzdKNnM2NkdjNnJlNDdKMjQ3WldZNjZtMA0KSUVOTVNlcXdnQ0R0akl6c25ienNuWVFnNnJDeDdJdWc3WldZNjYrQTY2R2NJT3lla091UG1TRHJzSmpzbUlIcmtKenJpNlF1Q2k4dklPeTZrT3lMbkNBMTdMU0lJT0tBbENEcm9aenF0N2pzbmJnZzdLZUI3WnVFSU95RGlDRHFzNFRzb0pYc25iUWc2ck9uNjdDVTY2R2NJT3llb2UyWWdPeVZ2Q0R0bEl6cm42enF0N2pzbmJqc25iUWc2NkdjNnJlNDdKMjRJTzJabE91cHRPeVhrT3lFbkNEdG1ZanNuTHpyb1p3ZzY0U1k3SmEwNnJDRTY0dWtLRE13N0xTSTY2bTBJT3VFaU91c3RDRHJpcWJzbll3cENteGxkQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lBd0xDQmxiV0ZwYkRvZ2JuVnNiQ0I5T3dwbWRXNWpkR2x2YmlCamJHRjFaR1ZCWTJOdmRXNTBLQ2tnZXdvZ0lHbG1JQ2hFWVhSbExtNXZkeWdwSUMwZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUR3Z05UQXdNQ2tnY21WMGRYSnVJR0ZqWTI5MWJuUkRZV05vWlM1bGJXRnBiRHNLSUNCc1pYUWdaVzFoYVd3Z1BTQnVkV3hzT3dvZ0lIUnllU0I3Q2lBZ0lDQmoNCmIyNXpkQ0JxSUQwZ1NsTlBUaTV3WVhKelpTaG1jeTV5WldGa1JtbHNaVk41Ym1Nb2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSnk1amJHRjFaR1V1YW5OdmJpY3BMQ0FuZFhSbU9DY3BLVHNLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdWhuT3EzdU95ZHVDRHNuYlRyb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDQXFMeUI5Q2lBZ1lXTmpiM1Z1ZEVOaFkyaGxJRDBnZXlCaGREb2dSR0YwWlM1dWIzY29LU3dnWlcxaGFXd2dmVHNLSUNCeVpYUjFjbTRnWlcxaGFXdzdDbjBLQ21aMWJtTjBhVzl1SUdoaGMwTnNZWFZrWlNncElIc0tJQ0JqYjI1emRDQm1hVzVrWlhJZ1BTQndjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5JRDhnSjNkb1pYSmxKeUE2SUNkM2FHbGphQ2M3Q2lBZ2RISjVJSHNnDQpjbVYwZFhKdUlITndZWGR1VTNsdVl5aG1hVzVrWlhJc0lGc25ZMnhoZFdSbEoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0J6YUdWc2JEb2dkSEoxWlNCOUtTNXpkR0YwZFhNZ1BUMDlJREE3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJSEpsZEhWeWJpQm1ZV3h6WlRzZ2ZRcDlDZ3BzWlhRZ2QyRnJhVzVuSUQwZ1ptRnNjMlU3SUM4dklPeVhzTzJEZ0NEcnNLbnNwNEFnNG9DVUlPdUxwT3Vtck91S2xDRHNsclRzc0tqdGxMd2dSVUZFUkZKSlRsVlRSZXVobkNEc3BKSHJzN1VnN0tDVjY2YXM3WldZN0tlQTY2ZU1JTzJVaE91aG5PeUV1T3lLcENEcmdxM3J1WVRycGJ3ZzdLU0U3SjI0NjR1a0NtWjFibU4wYVc5dUlIZGhhMlZDY21sa1oyVW9LU0I3Q2lBZ2FXWWdLSGRoYTJsdVp5a2djbVYwZFhKdU93b2dJSGRoYTJsdVp5QTlJSFJ5ZFdVN0NpQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJSGRoYTJsdVp5QTlJR1poYkhObE95QjlMQ0ExTURBd0tUc0tJQ0JzWlhRZ2NISnZZenNLSUNCcFppQW9jSEp2WTJWeg0KY3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ0x5OGdWMmx1Wkc5M2N6b2dZMjFrd3JkMlluTWc2cks5N0p5Z0lPeVhodXlkdENCdWIyUmw2Nlc4SU95bmdleWdrU3dnZDJsdVpHOTNjMGhwWkdVb1ExSkZRVlJGWDA1UFgxZEpUa1JQVnlucm9ad2c3SXFrN1krd0lPS0FsQW9nSUNBZ0x5OGc3TEM5SU95WGh1dUtsQ0RzaUtqc25ZQWc3TDJZN0lhVTdKMjBJT3Vuak91VHBPeVd0T3luZ09xem9DRHJpNlRycHF6c25aZ2c3SjZRN0l1ZEtHTnNZWFZrWlNucmo0UWc2cmU0SU95OW1PeUdsT3lkaENEcnJMenJvS1Ryc0p2c2xZUWc3SmEwNjVha0lPeXd2ZXVQaENEc2xZZ2c2NXlzNjR1a0xnb2dJQ0FnTHk4Z1pHVjBZV05vWldUcmlwUWc3Sk93N0tlQUlPeVZpdXVLbE91THBDaGtaWFJoWTJobFpDdDNhVzVrYjNkelNHbGtaU0Rzb2JEdGxhbnNuWUFnN0wyWTdJYVVJT3l3dmV5ZHRDRHJoYmpzdHB6cmtLZ2c0b0NVSU95THBPeTRvU2t1Q2lBZ0lDQXZMeUJYYVc1a2IzZHo3SmVRN0lTZ0lHUmwNCmRHRmphR1ZrSU95WGh1eWR0T3VQaENEcnRvRHJxcWdvNnJDUTdJdWM3SjZRS2Vxd2dDRHNvNzNzbHJUcmo0UWc3SjZRN0l1ZDdKMkFJT3lDdE95VmhPdUNxT3VLbE91THBDNEtJQ0FnSUhCeWIyTWdQU0J6Y0dGM2JpaHdjbTlqWlhOekxtVjRaV05RWVhSb0xDQmJjR0YwYUM1cWIybHVLRjlmWkdseWJtRnRaU3dnSjJOc1lYVmtaUzFpY21sa1oyVXVhbk1uS1Ywc0lIc0tJQ0FnSUNBZ1kzZGtPaUJTVDA5VUxDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbExBb2dJQ0FnZlNrN0NpQWdmU0JsYkhObElIc0tJQ0FnSUM4dklHMWhZMDlUTCt1bXJPdUloZXlLcERvZzZyQ1E3SXVjN0o2UTY2VzhJT3VkaE95YXRDQnViMlJsSU95THBPMldpU0R0akl6c25ienJvWndnN0tlQjdLQ1JJT3lLcE8yUHNDQW9iR0YxYm1Ob1pDRHRtWmpxc3Izc2w1UWdVRUZVU09xd2dDRHJ1WWpzbGIzdGxhQWc3SWlZSU95ZWlPeVd0Q0Rzb0lqcmpJRHFzcjNyb1p3ZzdJS3M3SnFwS1FvZ0lDQWdjSEp2DQpZeUE5SUhOd1lYZHVLSEJ5YjJObGMzTXVaWGhsWTFCaGRHZ3NJRnR3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBblkyeGhkV1JsTFdKeWFXUm5aUzVxY3ljcFhTd2dld29nSUNBZ0lDQmpkMlE2SUZKUFQxUXNJR1JsZEdGamFHVmtPaUIwY25WbExDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0NpQWdJQ0I5S1RzS0lDQjlDaUFnY0hKdll5NTFibkpsWmlncE95QXZMeURxc0pEc2k1enNucEFnN0oyMDY3S2s3WXE0SU91anFPMlVoT3lYa095RW5DRHJ0b1RycHF3Z0tPcXdrT3lMbk95ZWtDRHNvb1hybzR6cnBid2c2NmVKN0tlQUlPeVZpdXF5akNrS2ZRb0tZMjl1YzNRZ2MyVnlkbVZ5SUQwZ2FIUjBjQzVqY21WaGRHVlRaWEoyWlhJb0tISmxjU3dnY21WektTQTlQaUI3Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFBVRlJKVDA1VEp5a2dleUJ5WlhNdWQzSnBkR1ZJWldGa0tESXdOQ3dnUTA5U1UxOUlSVUZFUlZKVEtUc2djbVYwZFhKdUlISmxjeTVsYm1Rb0tUc2dmUW9nSUdsbUlDaHlaWEV1ZFhKcw0KSUQwOVBTQW5MMmhsWVd4MGFDY3BJSHNLSUNBZ0lDOHZJSFk2SU9xd2tPeUxuT3lla0NEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENEcXRhenJzb1Rzb0lRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU9xemhPeUdqU0RyajR6cXM2QWc3SjZJNjRxVTdLZUFJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsWmpyaXBRZzdKcXA2NCtFQ2lBZ0lDQXZMeUFvZGpJZ1BTRHNzTDBnN0lpbzZybUFJT3lJbU95Z2xlMk1rQ3dnZGpNZ1BTQXZZV05qYjNWdWRDRHN0cFRxc0lEdGpKQXBDaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnZDJGMFkyaGxjam9nZEhKMVpTd2dkam9nTXlCOUtUc0tJQ0I5Q2lBZ0x5OGc3SjIwSUZCRDdKZVFJT3Vobk9xM3VPeWR1T3VRbkNEdGdiVHJvWnpyazV3ZzZyT0U3S0NWSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnN0xLcklPMlpsT3VwdE1LMzdabUk3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbE95bmdDSWc2N08wN0plczdLTzgNCjY0cVVJT3VOc0NEc2s3VHJpNlF1Q2lBZ0x5OGc2ckNRN0l1YzdKNlE2ckNBSU91THRlMlZtT3VLbENEc25iVHNuS0E2SU91THBPdW1yT3VsdkNEc3ZKenJxYlFnN0p1TTY3Q043SmVGN0p5ODY2R2NJTzJCdE91aG5PdVRuT3F3Z0NEc2k2VHNvSndnN1ppNDdMYWM2NCs4SU9xMXJPdVBoU0RzZ3F6c21xbnJuNG5zbmJRZzY0S1k2ckNFNjR1a0xnb2dJQzh2SU9xd2tPeUxuT3lla091S2xDRHRqSXpzbmJ6cnA0d2c3SjI5N0p5ODY2K0E2NkdjSU95Q3JPeWFxZXVmaVNBd0lNSzNJT3VNZ09xNHNDQXdJT0tBbENEcXNvRHRocURycDR3ZzdKT3c2NHFVSU95Q3JPdWVqT3lYa09xeWpDRHJ1WVRzbXFuc25ZUWc2Nnk4NjZhczdLZUFJT3lWaXV1S2xPdUxwQzRLSUNBdkx5RHNvN3pzblpnNklPeVhyT3E0c0NEcXM0VHNvSlhzbmJRZzY3TzA3SmVzNjQrRUlPeWVoZXllcGVxMmpPeWR0Q0RycDR6cm80enJrSkRzbllRZzdJaVlJT3llaU91THBDanNuS0R0bXFqc2hMSHNuWUFnN0l1azdLQ2NJTzJZdU95Mm5DRHJsWXpyDQpwNHdnN0pXTUlPeUltQ0Rzbm9qc25Zd2c0b0NVSU91THBPdW1yQ0F2YUdWaGJIUm83SjJZSUhCeWIySnNaVzBnN0xDNDZyT2dLUzRLSUNCcFppQW9jbVZ4TG5WeWJDQTlQVDBnSnk5aFkyTnZkVzUwSnlrZ2V3b2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJR0ZqWTI5MWJuUTZJR05zWVhWa1pVRmpZMjkxYm5Rb0tTd2dZMnhoZFdSbE9pQm9ZWE5EYkdGMVpHVW9LU0I5S1RzS0lDQjlDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM2RoYTJVbktTQjdDaUFnSUNCcFppQW9JV2hoYzBOc1lYVmtaU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNnZlNrN0NpQWdJQ0IzWVd0bFFuSnBaR2RsS0NrN0NpQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2dkMkZyYVc1bg0KT2lCMGNuVmxJSDBwT3dvZ0lIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjMmgxZEdSdmQyNG5LU0I3Q2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdDaUFnSUNCeVpYUjFjbTQ3Q2lBZ2ZRb2dJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREEwTENCN0lHVnljbTl5T2lBblRtOTBJR1p2ZFc1a0p5QjlLVHNLZlNrN0Nnb3ZMeURzbmJUcnI3Z2c2NWFnSU95ZWlPeWN2T3VwdENEc29iRHNtcW50bm9nZzdLS0Y2Nk9NSUNqc25wRHJqNWtnN0l1YzdKNlJJQ3NnYm5CdElHSjFhV3hrSU95a2tldXp0U0RzaTZUdGxva2c2NHlBNjdtRUtRcHpaWEoyWlhJdWIyNG9KMlZ5Y205eUp5d2dLR1VwSUQwK0lIc0tJQ0JwWmlBb1pTQW1KaUJsTG1OdlpHVWdQVDA5SUNkRlFVUkVVa2xPVlZORkp5a2djSEp2WTJWemN5NWwNCmVHbDBLREFwT3dvZ0lIQnliMk5sYzNNdVpYaHBkQ2d4S1RzS2ZTazdDbk5sY25abGNpNXNhWE4wWlc0b1VFOVNWQ3dnSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzS0lDQmpiMjV6YjJ4bExteHZaeWduVzNkaGRHTm9aWEpkSU8yQnRPdWhuT3VUbkNEcmk2VHJwcXdnNnJDUTdJdWM3SjZRSU95OG5PeW5rQ0RpZ0pRZ2FIUjBjRG92TDJ4dlkyRnNhRzl6ZERvbklDc2dVRTlTVkNrN0NuMHBPd289DQo6OldTSUxFTlQ6Og0KSnlCRGJHRjFaR1VnUW5KcFpHZGxJSGRoZEdOb1pYSWdjMmxzWlc1MElHeGhkVzVqYUdWeUlDaHVieUIzYVc1a2IzY3BJQzBnY21WbmFYTjBaWEpsWkNCMGJ5QnlkVzRnWVhRZ2JHOW5hVzRLVTJWMElHWnpieUE5SUVOeVpXRjBaVTlpYW1WamRDZ2lVMk55YVhCMGFXNW5Ma1pwYkdWVGVYTjBaVzFQWW1wbFkzUWlLUXBUWlhRZ2MyZ2dQU0JEY21WaGRHVlBZbXBsWTNRb0lsZFRZM0pwY0hRdVUyaGxiR3dpS1Fwa2FYSWdQU0JtYzI4dVIyVjBVR0Z5Wlc1MFJtOXNaR1Z5VG1GdFpTaFhVMk55YVhCMExsTmpjbWx3ZEVaMWJHeE9ZVzFsS1FwemFDNURkWEp5Wlc1MFJHbHlaV04wYjNKNUlEMGdaR2x5Q25Ob0xsSjFiaUFpWTIxa0lDOWpJRzV2WkdVZ2MyTnlhWEIwYzF4aWNtbGtaMlV0ZDJGMFkyaGxjaTVxY3lJc0lEQXNJRVpoYkhObENnPT0NCjo6RU5EOjoNCg==";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드다리-설치.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAAAVdPW6jbIBAI2yAQAeAAAA7YG066Gc65Oc64uk66asLeyEpOy5mC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0gQ2xhdWRlIEJyaWRnZSBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiSDrsKnrspUg65GYIOuLpCDsp4Dsm5A6IOKRoCDthLDrr7jrhJAg7ZWcIOykhCAgY3VybCAtZnNTTCA87ISc67KEPi9hcGkvYnJpZGdlLXNldHVwIHwgYmFzaCAgIOKRoSDsnbQg7YyM7J28IOuNlOu4lO2BtOumrQojICjrjZTruJTtgbTrpq3snLzroZwg7LKY7J2MIOyXtOuptCAi7ZmV7J2465CY7KeAIOyViuydgCDqsJzrsJzsnpAiIOqyveqzoCDigJQg7Jqw7YG066atIOKGkiBb7Je06riwXS4gY3VybHxiYXNo64qUIOqyqeumrCDqsoDsgqwg7JeG7J2MKQpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0Z2JUcm9aenJrNXpyaTZUcnBxd3Q3THljNnJpd0xtSmhkQ0RyalpUcnVKVHRnYlRycHEwZ0tPdVlrT3VLbENCdWNHMGdjblZ1SUdKeWFXUm5aU2tLTHk4ZzdMeWM2NUdRNjZtMElPMlVqT3Vmck9xM3VPeWR1T3lkbUNCYjdMYVU3TEtjNjdDYjZyaXdYZXF3Z0NCSFpXMXBibWtnN1lLa0lPeVhodXlkdE91UGhDRHRnYlRyb1p6cms1enJvWndnUVVrZzdMYVU3TEtjN0oyRUlPdXdtK3VLbE91THBDNEtMeThLTHk4ZzdJYU42NCtFSU95RXBPcXpoRG9nN1lHMDY2R2M2NU9jNjZXOElPeWFsT3l5cmV1bmlPdUxwQ0RzZzRqcm9ad2c3SXVjNjQrWjdaV1k2Nm0wSURNd2ZqUXc3TFNJNnJDQUlPcTN1T3VEcFNEcmdxRHNsWVRxc0lUcmk2UXVDaTh2SU9LR2tpRHJpNlRycHF6cnBid2c3THlrSU91VmpDRHRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMkVJTzJWbU91Q21DRHNsN1RzbHJRZzdJT0I3SXVjSU91TWdPcTRzT3lMbk8yQ3BPcXpvQ2h6ZEhKbFlXMHRhbk52YmlEcmpJRHRtWlFnNjZxbzY1T2NLU3dLTHk4Z0lDRHFzSURzbmJUcms1d3I3SmlJN0l1Y0tERXhNZXF4dENucmlwUWc3TEtySU91cGxPeUxuT3luZ091aG5DRHRsWndnNjdLSTY2ZU1JT3lkdmUyZWpPdUxwQzRnN0oyMDdadUVJT3lhbE95eXJleWRnQ0RyckxqcXRhenJwNHdnNjdPMDY0SzA2NitBNjZHY0lPdTVvT3VsdE91THBDNEtMeThnN0lTNDdJV1k3SjJBSURNdzY3S0lJT3lUc091cHRDRHNucXpzaTV6c25wSHRsYlFnNjR5QTdabVU2ckNBSU91c3RPMlZuTzJlaUNEcXVManNsclRzcDREcmlwUWc2cktEN0oyRUlPdW5pZXVLbE91THBDNEtMeThLTHk4ZzdLQ0U3S0NjT2lEc25iUWdVRVBzbDVBZ1EyeGhkV1JsSUVOdlpHWHFzSUFnN0lTazdMbVl3cmZyb1p6cXQ3anNuYmpyajd3ZzdKNkk3SjJFSU9xeWd5QW9ZMnhoZFdSbElDMHRkbVZ5YzJsdmJpRHNuTHpyb1p3ZzdabVY3SjI0S1Fvdkx5RHNvN3pzblpnNklPeUNyT3lhcWV1ZmlleWRnQ0Rxc0lIc25wQWc3WUcwNjZHYzY1T2NJT3Exck91UGhTRHRsWnpyajRUc2w1RHNoSndnN0xDbzZyQ1E2NUNjNjR1a0xnb0tZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNLWTI5dWMzUWdabk1nUFNCeVpYRjFhWEpsS0NkbWN5Y3BPd3BqYjI1emRDQnZjeUE5SUhKbGNYVnBjbVVvSjI5ekp5azdDbU52Ym5OMElIQmhkR2dnUFNCeVpYRjFhWEpsS0Nkd1lYUm9KeWs3Q21OdmJuTjBJSHNnYzNCaGQyNHNJSE53WVhkdVUzbHVZeUI5SUQwZ2NtVnhkV2x5WlNnblkyaHBiR1JmY0hKdlkyVnpjeWNwT3dvS0x5OGc3WUcwNjZHYzY1T2M2Nlc4SU91NWlDRHRqN1RyalpUc2w1RHNoSndnN0l1azdaYUpJT0tBbENEc29JRHNucVhzaG96c2w1RHNoSndnN0l1azdaYUo3WldZNjZtMElPMlVoT3Vobk95Z25lMkt1Q0RycDZYcm5iMG9RMHhCVlVSRkxtMWtJT3VUc1Nuc25ZUUtMeThnNjZla0lPMkV0Q0RzcDRyc2xyVHNvTGpzaEp3Z05EWHN0SWd2N1lTMDZybU03S2VBSU91S2tPdWdwT3luaE91THBDQW82N21JSU8yUHRPdU5sQ0FySU91MmdPcXdnT3E0c091S3BTRHNzS2pyaTZqc25iVHJxYlFnZmpQc3RJZ3Y3WVMwS1M0S1kyOXVjM1FnUlUxUVZGbGZRMWRFSUQwZ2NHRjBhQzVxYjJsdUtHOXpMblJ0Y0dScGNpZ3BMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTMWpkMlFuS1RzS2RISjVJSHNnWm5NdWJXdGthWEpUZVc1aktFVk5VRlJaWDBOWFJDd2dleUJ5WldOMWNuTnBkbVU2SUhSeWRXVWdmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91c3RPeUxuQ0FxTHlCOUNtTnZibk4wSUVOTVFWVkVSVjlGVGxZZ1BTQlBZbXBsWTNRdVlYTnphV2R1S0h0OUxDQndjbTlqWlhOekxtVnVkaXdnZXdvZ0lFMUJXRjlVU0VsT1MwbE9SMTlVVDB0RlRsTTZJQ2N3Snl3Z0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDOHZJT3lEbmVxd2dTRHJxcWpyazV3ZzY0R1VJQ2pzcDZmc25ZQWc2Nnk0NnJXczdKZVVJT3UyaU8yVmhPeWFsQ2tLSUNCRFRFRlZSRVZmUTA5RVJWOUVTVk5CUWt4RlgwNVBUa1ZUVTBWT1ZFbEJURjlVVWtGR1JrbERPaUFuTVNjc0lDOHZJTzJFdENEc21wVHNsYjBnNjVPeElPdTJnT3F3Z0NEdG1ManN0cHdnNjRHVUNpQWdSRWxUUVVKTVJWOVVSVXhGVFVWVVVsazZJQ2N4Snl3S2ZTazdDZ3BqYjI1emRDQlFUMUpVSUQwZ1RuVnRZbVZ5S0hCeWIyTmxjM011Wlc1MkxrSlNTVVJIUlY5UVQxSlVLU0I4ZkNBeE1UZzRPRHNnTHk4Z1FsSkpSRWRGWDFCUFVsVHJpcFFnN1lXTTdJcWs3WXE0N0pxcElDanRqNG5zaG96c2w1UWdNVEU0T0RnZzZyT2c3S0NWS1Fvdkx5RHJpNlRycHF3ZzdMMlU2NU9jSU91eWhPeWdoQ0RpZ0pRZ0wyaGxZV3gwYU91aG5DRHJoYmpzdHB6dGxaenJpNlF1SU95OWxPdVRuT3VsdkNCd2RXeHN3cmZyczdYc2dxenRsYlRyajRRZ0tpcnNuYlRycjdnZzY1YWdJT3llaU91S2xDRHJpNlRycHF6cmlwUWc3SmliSU95OWxPdVRuQ0RxdDdqcmpJRHJvWndxS3V1ZHZBb3ZMeURxdTVEcmk2UWc3THljNnJpd0lPeWdoT3lYbENEc2c0Z2c2NCtaN0o2UjdKMjBJT3lWaUNEcmdwanNtS2pyaTZRbzdZU3c2Nis0NjRTUTdKMjBJT3VjcU91S2xDRHJrN0VwTGlEdGxJenJuNnpxdDdqc25ianNuYlFnN0oyMElPcXdrdXljdk91aG5DRHF0YXpyc29Uc29JVHNuWVFnNnJDUTdLZUE3WlcwSU95ZXJPeUxuT3lla2V5TG5PMkNxT3VMcEM0S0x5OGc2NCtaN0o2UjdKMjBJT3V3bE91QWpPdUtsQ0RzaUpqc29KWHNuWVFnN1pXWTY2bTBJT3lkdENEc2lLdnNucERycGJ3ZzdKaXM2NmFzNnJPZ0lHTnZaR1V1ZEhQc25aZ2dRbEpKUkVkRlgwMUpUbDlXNjQrRUlPcXdtZXlkdENEc21LenJwckRyaTZRdUNtTnZibk4wSUVKU1NVUkhSVjlXSUQwZ01UTTdDaTh2SU9xNHNPdXp1Q0RycXFqcmpiZ3VJT3lhbE95eXJTanRsSXpybjZ6cXQ3anNuYmdwN0oyMElHMXZaR1ZzN0oyRUlPeW5nT3lnbGUyVm1PdXB0Q0RxdDdnZzdKcVU3TEt0NjZlTUlPcTN1Q0RycXFqcmpianJvWndnN0xLWTY2YXM3WldjNjR1a0xnb3ZMeUJvWVdscmRUM3J1YURycG9RdjZyQ0E2N0s4N0p1QUxDQnpiMjV1WlhROTdLU1I2ckNFTENCdmNIVnpQZXE0c091enVDanN0WnpxczZEdGtvanNwNGdzSU95aHNPcTRpQ0RyaXBEcnByd3BDbU52Ym5OMElFTk1RVlZFUlY5TlQwUkZUQ0E5SUhCeWIyTmxjM011Wlc1MkxrSlNTVVJIUlY5TlQwUkZUQ0I4ZkNBbmIzQjFjeWM3Q21OdmJuTjBJRUZNVEU5WFJVUmZUVTlFUlV4VElEMGdXeWRvWVdscmRTY3NJQ2R6YjI1dVpYUW5MQ0FuYjNCMWN5ZGRPd3BqYjI1emRDQlVWVkpPWDFSSlRVVlBWVlJmVFZNZ1BTQTVNREF3TURzZ0lDQXZMeURzbXBUc3NxMGdNZXF4dENEc29KenRsWnpzaTV6cXNJUUtZMjl1YzNRZ1RVRllYMVJWVWs1VElEMGdNekE3SUNBZ0lDQWdJQ0FnSUNBZ0x5OGc3SjIwNjZlTTdZRzhJT3lUc091cHRDRHNoTGpzaFpnZzdKNnM3SXVjN0o2UklDanJqSUR0bVpRZzY0aUU3S0NCSU91d3FleW5nQ2tLQ2k4dklPS1VnT0tVZ0NEc21JanNpNXdnN0lLczdLQ0VJT3Vobk91VG5DQW9jbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrSU9LQWxDQmlkV2xzWkMxbmJHOXpjMkZ5ZVM1cWMreVpnQ0Rxc0puc25ZQWc3WXlNN0lTY0tTRGlsSURpbElBS1puVnVZM1JwYjI0Z2JHOWhaRVY0WVcxd2JHVnpLQ2tnZXdvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdFpDQTlJR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bkxDQW5jbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrSnlrc0lDZDFkR1k0SnlrN0NpQWdJQ0JqYjI1emRDQnpaV05KWkhnZ1BTQnRaQzV6WldGeVkyZ29MMTRqSXlEc3RwVHNzcHdnN0ppSTdJdWNYSE1xSkM5dEtUc0tJQ0FnSUdsbUlDaHpaV05KWkhnZ1BUMDlJQzB4S1NCeVpYUjFjbTRnVzEwN0NpQWdJQ0JqYjI1emRDQmxlR0Z0Y0d4bGN5QTlJRnRkT3dvZ0lDQWdiR1YwSUdOMWNpQTlJRzUxYkd3N0NpQWdJQ0JtYjNJZ0tHTnZibk4wSUhKaGR5QnZaaUJ0WkM1emJHbGpaU2h6WldOSlpIZ3BMbk53YkdsMEtDZGNiaWNwS1NCN0NpQWdJQ0FnSUdOdmJuTjBJR3hwYm1VZ1BTQnlZWGN1Y21Wd2JHRmpaU2d2WEhNckpDOHNJQ2NuS1RzS0lDQWdJQ0FnWTI5dWMzUWdhQ0E5SUd4cGJtVXViV0YwWTJnb0wxNGpJeU5jY3lzb0xpcy9LVnh6S2lRdktUc0tJQ0FnSUNBZ2FXWWdLR2dwSUhzZ1kzVnlJRDBnZXlCcGJuQjFkRG9nYUZzeFhTd2djM1ZuWjJWemRHbHZibk02SUZ0ZElIMDdJR1Y0WVcxd2JHVnpMbkIxYzJnb1kzVnlLVHNnWTI5dWRHbHVkV1U3SUgwS0lDQWdJQ0FnWTI5dWMzUWdZaUE5SUd4cGJtVXViV0YwWTJnb0wxNWNjeW90WEhNcktDNHJQeWxjY3lva0x5azdDaUFnSUNBZ0lHbG1JQ2hpSUNZbUlHTjFjaWtnWTNWeUxuTjFaMmRsYzNScGIyNXpMbkIxYzJnb1lsc3hYUzV6Y0d4cGRDZ25JQzhnSnlrdWFtOXBiaWduSUNjcEtUc0tJQ0FnSUgwS0lDQWdJSEpsZEhWeWJpQmxlR0Z0Y0d4bGN5NW1hV3gwWlhJb0tHVXBJRDArSUdVdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lENGdNQ2s3Q2lBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lZaU95TG5DRHNncXpzb0lRZzY2R2M2NU9jSU95THBPMk1xQ0FvN0plRzdKMjBJT3luaE8yV2lTazZKeXdnWlM1dFpYTnpZV2RsS1RzS0lDQWdJSEpsZEhWeWJpQmJYVHNLSUNCOUNuMEtDaTh2SU9LVWdPS1VnQ0RzcDREc2k1enJyTGdnS095RW5PdXloQ0J5WldOdmJXMWxibVRzbVlBZzZyQ1o3SjJBSU9xM25PeTVtU0RpZ0pRZzY3Q1U2cjY0NjZtMElPcTN1T3lxdmV1UGhDRHRsYWpxdTVncElPS1VnT0tVZ0Fvdkx5RHNtcW5zbHJUc3A1RW9aMnh2YzNOaGNua3ViV1FwN0oyQUlPeWR2T3UyZ091ZnJDRHRsSVRyb2F6dGxJVHRpcmpzbDVBZzdKV0lJT3VFbyt1S2xPdUxwQ2d5TURJMkxUQTNJT3lMcE95NG9TazZJT3VFbyt5Y3ZPdXB0Q0R0Z2JUcm9aenJrNXpxc0lBZzdKcXA3SmEwSU9xMWtPeWdsZXlkaEFvdkx5RHNvN3dnN0o2RTY2eTA2NkdjSU95WXBPMlZ0TzJWdENBejZyQ2NJT3lnbk95VmlPeWR0Q0Rzb0lUcnRvQWdJdTJSbk9xNHNDRHFzNkRzdWFnZ0t5RHNsclRzaUp3ZzY3T0E2cks5SXV5ZHRDRHJrSnpyaTZRdUlPeVhyZTJWb0NEcnRvVHJwcXdnNG9DVUNpOHZJTzJCdE91aG5PdVRuQ0E5SU91c3VPeWVwU0RyaTZUcms2enF1TEFvN0xDOTdKMllLU3dnN0pxcDdKYTBJTzJHdGV5ZHZNSzM2NmVlN0xhazY3S1ZJRDBnWTI5a1pTNTBjeUJ5WldacGJtVkJhVk4xWjJkbGMzUnBiMjV6SU8yYmhPeXltT3VtckNqcXVMRHFzNFRzb0lFcExncGpiMjV6ZENCVFZGbE1SVjlTVlV4RlV5QTlJRnNLSUNBbk1TNGc3WlcwN0pxVTdMSzBPaURycXFqcms2QWc2Nnk0NnJXczY0cVVJTzJWdE95YWxPeXl0T3VobkM0Z0tPdXp0T3VEaGV1TGlPdUxwT0tHa3V1enRPdUN0T3lhbENrbkxBb2dJQ2N5TGlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd09pRHJrSkRzbHJUc21wVGlocEx0bG9qc2xyVHNtcFFzSUg3c2w0Z2c2N204NnJpd0tPdXdsT3VBak95WGlPeVd0T3lhbE9LR2t1dXdsT3EvcU95V3RPeWFsQ2t1SU91THFDd2c3S0tGNjZPTXdyZnJwNHpybzR6Q3QreVhzT3l5dE1LMzdaVzA3S2VBd3JmcXVMRHJvWjNDdCt1RnVleWRqQ0RyazdFZzdJdWM3SXFrN1lXYzdKMjBJT3lqdk95eXRPeWR1Q0Rxc3JEcXM3enJpcFFnN0lpWTY0K1o3WmlWSU95Y29PeW5nQ2pzbDdEc3NyVHJqN3pzbXBRc0lPdUZ1ZXlkak91UHZPeWFsQ2t1Snl3S0lDQW5NeTRnNnJpTjdLQ1Y3S0NCSU91bmtPMlZtT3E0c0RvZ0luN3RsYUFnN0lpWUlPeVhodXlXdE95YWxDSWc2NHlBN0l1Z0lDSis3WldZNjZtMElPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUlpRHF0YXpzb2JBZzdKcXc3SVNnTGlEcmk2Z3NJT3lnbGV5eGhleURnU0RydG9qcXNJREN0K3lkdk91MmdDRHF1TERyaXFVZzdLQ2M3Wldjd3JmcmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHFzckRxczd6Q3QreWdsZXV6dENEcnM3VHRtTGdnN0pXSTdJdXM3SjJBSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RycW9YdG1aWHRub2d1Snl3S0lDQW5OQzRnN0xxUTdLTzg3SmE4N1pXY0lPcXl2ZXlXdERvZ2Z1MlZtT3lMbk9xeW9PeVd0T3lhbEQvaWhwSis3WldnNnJtTTdKcVVQeXdnNnJPRTdJdWM2NHVrNG9hUzdKNkk2NHVrTENEc2w2enNyWWpyaTZUaWhwTHRtWlhzbmJqdGxaanJpNlFzSU9xN21PS0drdXlYa09xeWpDNGdmdXlMbkNEcnVienF1TERxc0lBZzdKYTA3SU9KN1pXWTY2bTBJTzJNak95VmhlMlZtT3VncE91S2xDRHNvSlhyczdUcnBid2c3S084N0phMDY2R2NJT3VzdU95ZXBleWRoQ0RyaTZUc2k1d2c3Sk8wNjR1a0xpY3NDaUFnSnpVdUlPdXFoZXlDckN2cnFvWHNncXdnNnJpSTdLZUFPaUR0bFp6c25wRHNsclRycGJ3ZzdaS0E3SmEwSU91UG1leUNyT3VobkNqc25iVHNucEFnN1ptWTY3YUk3SjJFSU91d20reVZtT3lXdE95YWxPS0drdXlkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFFwTENEc3RaenNob3p0bFp3Z2UrdXFoZXlDckgzcXNJQWdlK3VxaGV5Q3JIM3RsYlRzaEp3ZzdaaVY3WU9jNjZHY0tPeWVsT3lWb1NEcnRvRHNvYkhzbkx6cm9aemlocExzbnBUc2xhSHNuYlFnNjdhQTdLR3g3WlcwN0lTY0tTNG5MQW9nSUNjMkxpRHRrWnpxdUxBNklPdVFtT3lXdE95YWxPS0drdXVQdk95YWxDNG5MQW9nSUNjM0xpRHNwSVFnNnJXczdLR3dPaURzbTVEcnM3anNuYlFnN1pXY0lPeWtoT3lkdE91cHRDRHN0cFRzc3B6cmo0UWc2N0NZNjVPYzdJdWNJTzJWbkNEc3BJVHJvWnd1SU95ZWhPeWRtT3VobkNEc3BJVHNuWVFnNjRxWTY2YXM3S2VBSU95Vml1dUtsT3VMcEM0ZzY0dW9MQ0RzbDZ6cm42d2c2Nnk0N0o2bDdKMkVJTzJWbU91Q21PeWRtQ0RxdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPMlZxZXl6a0NEcmpaUWc2ckNFNnJLdzdaVzA3S2VFNjR1azY2bTBJT3lraENEc2lKanJwYndnN0tTRTdKMjA2NHFVSU9xeWcreWRnQ0R0bVpqc21JRXVKeXdLSUNBbk9DNGc2NHVrN0oyMDdKYTg2NkdjNnJlNElPeVp2T3lxdlNEcnNvVHRpcndnNjUyODY3S283SjJBSUNMcmk2dnF1TEFpS095M3FPeUdqQ0RxdUlqc3A0QXBMaWNzQ2lBZ0p6a3VJT3lkdE91bWhNSzM3S0NFN1ptVTY3S0k3Wmk0d3JmcnA0anNpcVR0Z3Juc25ZQWc2cmU0NjR5QTY2R2NJT3V6dE95aHRDNGc3SUtzNjU2TTdKMkVJT3UyZ091bHZDRHJsWkFnNjR1WTdKMkVJT3UybWV5WHJPdVBoQ0Rzb292cmk2UXVKeXdLSUNBbk1UQXVJT3lnbk8yU2lDRHNtcW5zbHJRZzdKeWc3S2VBT2lEc25vWHJvS1hzbDVBZzdKT3c3SjI0SU9xNHNPdUtwZXlFc1NEcnFvWHNncXdvNjdPQTZySzlMQ0RzcDREc29KVXNJT3VUc2V1aG5Td2c3WlcwN0tDY0lPdVRzU25yaXBRZzdabVU2Nm0wN0oyWUlPcTRzT3VLcGV1cWhjSzM2N0tFN1lxODY2cUY3SjI4SU9xd2dPdUtwZXlFc2V5ZHRDRHJocExzbkx6cnI0RHJvWndnN0ltczdKcTBJT3Vua091aG5DRHJzSlRxdnJqc3A0QWc3SldLNjRxVTY0dWtMaURzaTV6c2lxVHRoWndnNjQrWjdKNlI2ck84SU91THBPdWx1Q0RyajVuc2dxenJwYndnN0lPSTY2R2NJT3Vuak91VHBPeW5nQ0RzbFlycmlwVHJpNlF1Snl3S1hTNXFiMmx1S0NkY2JpY3BPd29LWTI5dWMzUWdSVmhCVFZCTVJWTWdQU0JzYjJGa1JYaGhiWEJzWlhNb0tUc0tDaTh2SU9LVWdPS1VnQ0RzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jSU95Z2hPdXN1Q0Ryb1p6cms1d2dLSFY0TFhkeWFYUnBibWN1YldRZzRvQ1VJT3lZaU95WnVDRHF0NXpzdVprZzdJUzQ2N2FBSU95TG5PdUNtT3Vtck95WXBPcTVqT3luZ0NEdGxJVHJvYXp0bElUdGlyanNsNUFnN1krczdaV29LU0RpbElEaWxJQUtMeThnVTFSWlRFVmZVbFZNUlZNZ01URHNwSVFnN0pxVTdKVzk2NmVNN0p5ODY2R2M2NHFVSU95WWlPeVp1Q0F4ZmpNbzdJaVk2NCtaN1ppVndyZnFzcjNzbHJUQ3QrdTJnT3lnbGUyWWxTRHRsNGpzbXFrZzdMeUE3SjIwN0lxa0tleWRtQ0RyaVpqc2xabnNpcVRxc0lBZzdKeWc3SXVrNjVDYzY0dWtMZ292THlEdGpJenNuYnpzbmJRZzdKZUc3Snk4NjZtMEtPeUVwT3k1bU91enVDRHF0YXpyc29Uc29JUWc2NU94S1NEcnVZZ2c2Nnk0N0o2UTdKZTBJT0tBbENEc21wVHNsYjNycDR6c25MenJvWndnNjQrWjdKNlJLR1poYVd3dGMyOW1kQ2t1Q21aMWJtTjBhVzl1SUd4dllXUkhkV2xrWlNncElIc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdiV1FnUFNCbWN5NXlaV0ZrUm1sc1pWTjVibU1vY0dGMGFDNXFiMmx1S0Y5ZlpHbHlibUZ0WlN3Z0p5NHVKeXdnSjNWNExYZHlhWFJwYm1jdWJXUW5LU3dnSjNWMFpqZ25LUzUwY21sdEtDazdDaUFnSUNCeVpYUjFjbTRnYldRdWJHVnVaM1JvSUQ0Z01UQXdJRDhnYldRZ09pQW5KenNLSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Ryb1p6cms1d2c3SXVrN1l5b0lDanNtcFRzbGIzcnA0enNuTHpyb1p3ZzdLZUU3WmFKS1RvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ2NtVjBkWEp1SUNjbk93b2dJSDBLZlFwamIyNXpkQ0JIVlVsRVJTQTlJR3h2WVdSSGRXbGtaU2dwT3dvS1puVnVZM1JwYjI0Z2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa2dld29nSUdOdmJuTjBJR1psZDFOb2IzUWdQU0JGV0VGTlVFeEZVeTV0WVhBb0tHVjRLU0E5UGlBblNXNXdkWFE2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNobGVDNXBibkIxZENrZ0t5QW5YRzVQZFhSd2RYUTZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2hsZUM1emRXZG5aWE4wYVc5dWN5a3BMbXB2YVc0b0oxeHVKeWs3Q2lBZ2NtVjBkWEp1SUNnS0lDQWdJQ2ZzcDREcXVJanJ0b0R0aExBZzY0U0k2NHFVSU95WGtPeUtwT3lia0NoVExURXNJT3V6dE95VmlPMmFqT3lDckNuc25aZ2c3WldjNnJXdDdKYTBJRlZZSUZkeWFYUnBibWNnN0tDRTY2eTQ2ckNBNjZHY0lPeWR2TzJWbk91THBDNGdKeUFyQ2lBZ0lDQW42NEswNnJDQUlGVkpJT3VzdU9xMXJPdWx2Q0R0bFpqcmdwanNsS2tnNjdPMDY0SzA2Nm0wTENEc2xZVHJucGdnN0lxazdZT0E3SjI4SU9xM25PeTVtZXlYa0NEcnA1N3Fzb3dnNjR1azY1T3M3SjJBSU91TWdPeVZpQ0F6NnJDYzY2VzhJT3lnbk95VmlPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0oreWFsT3l5cmV1VHBPeWRnQ0RzaEp6cm9ad2c2NnkwNnJTQTdaV2NJT3V6aE9xd25DRHJyTGpxdGF6cmk2UWc0b0NVSU95ZHRPeWdoQ0RyckxqcXRhenJwYndnN0xDNDdLR3c3WldZN0tlQUlPdW5pT3VkdkM1Y2JpY2dLd29nSUNBZ0oreWJrT3VlbUNEc25aanJyN2pzbVlBZzY2cW82NU9nSU95Z2xldXp0Q2pzbmJUcnBvVEN0K3lJcSt5ZWtNSzM3S0d3NnJHMHdyZnJqSURzZzRFcDY2VzhJT3ljb095bmdPMlZtT3F6b0N3ZzZyQ0JJT3lnbk95VmlPeWRnQ0RzbTVEcnM3anFzN3pyajRRZzdJU2M2NkdjN0ptQTY0K0VJT3VMck91ZHZPeVZ2Q0R0bFp6cmk2UXVJQ2NnS3dvZ0lDQWdKK3loc09xeHRDRHRrWnp0bUlRbzdKMjA3SU9Cd3Jmc25iVHRsWmpDdCt5ZHRPdUN0TUszN0xTSTZyTzh3cmZycjdqcnA0ekN0K3UyZ08yRXNNSzM2cm1NN0tlQUlPdVRzU25zbllBZzdLQ1Y3TEdGSU95Z2xldXp0T3VMcENEaWdKUWc2N204NnJHdzY0S1lJT3VMcE91bHVDRHNvYkRxc2JUc25MenJvWndnNjdDVTZyNjQ3S2VBSU91bmlPdWR2Q2dpTmUyYWpDRHNuYlRzZzRFaTdKMkVJQ0kxN1pxTUl1dWhuQ0RzcElUc25iVHJxYlFnN0ppazY0dTFLUzRnSnlBckNpQWdJQ0FuN0p1UTY2eTQ3SmVRSU95WGh1dUtsQ0RxdGF6c3NyUWc3S0NWNjdPMEtPeWdoTzJabE91eWlPMll1TUszVlZKTXdyZnF1SWpzbGFIQ3QreUxuT3F3aENEcms3RXA3Sm1BSU8yVnRPcXlzQ0Ryc0tucnNwWEN0K3lnaU95d3FDanNucXpzaEtUc29KWEN0K3VzdU95ZG1PeXltTUszN0o2czdJdWM2NCtFSU91VHNTbnJwYndnN0tlQTdKYTA2NEswSU91Mm1leWR0T3VLbENEcXNvUHNuWUFnN0tDSTY0eUFJT3E0aU95bmdDRGlnSlFnN0pXRTY0cVVJT3F3a3V5ZHRPdWR2T3VQaEN3ZzZyZTQ2NSswNjVPdjdaVzA2NCtFSU95VHNPeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ2N6NnJDY0lPeWduT3lWaU95ZGdDRHNoSnpyb1p3ZzdLQ1I2cmU4N0oyMElPdUxyT3Vkdk95VnZDRHRsWnpyaTZRZzRvQ1VJTzJWbU91Q21PdUtsQ0RzbTVEcnJMZ2c2cldzN0tHdzY2VzhJT3ljb095bmdPMlZuQ0RzdFp6c2hvd2c2NHVrNjVPczZyaXdMQ0R0bFpqcmdwanJpcFFnNjZ5NDdKNmxJT3Exck95aHNPdWx2Q0RzbnF6cXRhenNoTEh0bFp3ZzY0eUE3SldJTENBbklDc0tJQ0FnSUNmcXQ3anJwcXpxczZBZzdLQ0I3SmEwNjQrRUlPMlZtT3VDbU91S2xDRHFzN3pxc0pEdGxad2c3SjZzNnJXczdJU3hPaURzcEpIcnM3VWc3WkdjN1ppRTdKMkVJT3VObk95V3RPdUN0T3F6b0N3ZzdLQ1Y2N08wSU95SW5PeUVuT3VsdkNEc2dxenNtcW5zbnBEcXNJQWc3SldNN0pXRTdKVzhJTzJWb0NEcXNvUHJ0b0R0aExEcm9ad2c3SjZzN0tHdzdLZUI3WldnSU9xeWd5NGdKeUFyQ2lBZ0lDQW43SnVRNjZ5NDdKMjBJTzJWdE9xeXNDRHJzS25yc3BYc25ZUWc2NHUwNnJPZ0lPeWVpT3lkaENEcmxZenJwNHdnSXV5V3RPdVd1K3F5akNEdGxaanJxYlFnNjR1azdJdWNJT3VRbk91THBDTHJwYndnN0pXZTdJUzQ3SnF3NjRxVUlPcTRqZXlnbGUyWWxTRHNucXpxdGF6c2hMSHNuWVFnN1pXWTY1MjhJT0tBbENEc201RHJyTGpzbDVBZzdaVzA2ckt3N0xHRjdKMjBJT3lYaHV5Y3ZPdXB0Q0RycDR6cms2VHNsclFnNjdhWjdKMjA3S2VBSU91bmlPdWR2QzRnSnlBckNpQWdJQ0FuN1pHYzZyaXd3cmZzbXFuc2xyVHJwNHdnNnJPZzdMbVk2ck9nSU95V3RPeUluT3lkaENEcnNKVHF2cndnN0tDVjY0K0U3SjJZSU95Z25PeVZpT3lkaENBejZyQ2NJT3VLbU95V3RPdUdrK3luZ0NEcnA0anJuYndnNG9DVUlPcTN1T3F4dENEc2dxenNtcW5zbnBEc2w1RHFzb3dnN0xhVTdMS2M3SjIwSU95VmhPdUxpT3VkdkNEcXRaRHNvSlhzbkx6cm9ad2c2N08wN0oyNDY0dWtMaUFuSUNzS0lDQWdJQ2ZzbFlUcm5wZ2c3SmlJN0l1YzY1T2s3SjJBSU8yVm5DRHNwSVRzcDV6cnBxd2c3TFdjN0lhTUlPcTFrT3lnbGV5ZHRDRHJwNDdzcDREcnA0d2c2cmU0NnJHMElPMkdwQ2p0bGJUc21wVHNzclRDdCtxeXZleVd0Q25zblpnZzZyV1E2N080N0oyMDdLZUFJT3lHak9xM3VleUVzZXlkbUNEcXRaRHJzN2pzbmJRZzdKV0U2NHVJNjR1a0lPS0FsQ0RzbDZ6cm42d2c2Nnk0N0o2bDdLZWM2NmFzSU95ZWhldWdwZXlkZ0NEcnFaVHNpNXpzcDRBZzY0dW83SnlFNjZHY0lPdUxwT3lMbkNEc2hLVHFzNFR0bFpqcm5id3VYRzRuSUNzS0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzY3Q3c3SmUwNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9YQ3QreTlsT3VUbk8yT25PeUtwQ0RxdUlqc3A0QTZYRzRuSUNzS0lDQWdJQ2RiZXlKMFpYaDBJam9nSXV5Z25PeVZpQ0RyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW5KbFlYTnZiaUk2SUNMcnJMVHNsNGZzbllRZzdKbWNJT3V3bE9xL3FPdUtsT3luZ0NEdGxaenF0YTNzbHJRZzdaV2NJT3VzdU95ZXBTSjlMQ0F1TGk1ZFhHNWNiaWNnS3dvZ0lDQWdKMXZzaXFUdGc0RHNuYndnNnJlYzdMbVpYVnh1SnlBcklGTlVXVXhGWDFKVlRFVlRJQ3NnSjF4dVhHNG5JQ3NLSUNBZ0lDaEhWVWxFUlNBL0lDZGI3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Rzb0lUcnJMZ2dLSFY0TFhkeWFYUnBibWN1YldRcElPS0FsQ0RzbklRZzZyZWM3TG1aN0oyWUlPcTN2T3F4c095WmdDRHNtSWpzbWJnZzdJdWM2NEtZNjZhczdKaWtMaUR0aXJudG5vZ2c3SmlJN0ptNElPcTNuT3k1bVNqc2lKanJqNW50bUpYQ3QrcXl2ZXlXdE1LMzY3YUE3S0NWN1ppVjdKMkVJT3ljb095bmdPMlZ0T3lWdkNEdGxaanJpcFFnN0lPQjdabXBLZXlkaENEcXQ3anJqSURyb1p3ZzY1U3c2NlcwNnJPZ0xDRHNtcFRzbGIzcXM3d2c3S0NFNjZ5NDdKMjBJT3VMcE91bHRPdXB0Q0Rzb0lUcnJManNuWVFnNjVTdzY2VzQ2NHVrWFZ4dUp5QXJJRWRWU1VSRklDc2dKMXh1WEc0bklEb2dKeWNwSUNzS0lDQWdJQ2htWlhkVGFHOTBJRDhnSjF2c21yRHJwcXdnNjZxcDdJYU02NmFzSU95WWlPeUxuQ0RpZ0pRZzdKMjBJTzJHcE95ZGhDRHJsTERycGJ3ZzZyS0RYVnh1SnlBcklHWmxkMU5vYjNRZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdKK3lrZ091NWhPdVFrT3ljdk91cHRDQWlUMHNpNjUyODZyT2c2NmVNSU91THRlMlZtT3VkdkM0bkNpQWdLVHNLZlFvS0x5OGc0cFNBNHBTQUlPeURnZXlMbkNEcmpJRHF1TEFnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLYkdWMElIQnliMk1nUFNCdWRXeHNPeUFnSUNBZ0lDQWdJQ0F2THlEdGdiVHJvWnpyazV3ZzdaU0U2NkdjN0lTNDdJcWtDbXhsZENCc2FXNWxRblZtSUQwZ0p5YzdJQ0FnSUNBZ0lDQWdMeThnYzNSa2IzVjBJT3lraENEcnNvVHRqYndLYkdWMElIZGhhWFJsY2lBOUlHNTFiR3c3SUNBZ0lDQWdJQ0F2THlEdG1JVHNucXdnN1lTMDdKMllJSHNnY21WemIyeDJaU3dnY21WcVpXTjBMQ0IwYVcxbGNpQjlDbXhsZENCeGRXVjFaU0E5SUZCeWIyMXBjMlV1Y21WemIyeDJaU2dwT3lBdkx5RHNtcFRzc3EwZzdLZUI2NkNzN1ptVUlDanJqNW5zaTV3ZzdKcVU3TEt0N0oyQUlPeUluT3lFbk91TWdPdWhuQ2tLYkdWMElIUjFjbTV6SUQwZ01Ec0tiR1YwSUhkaGNtMWxaRlZ3SUQwZ1ptRnNjMlU3Q214bGRDQmpkWEp5Wlc1MFRXOWtaV3dnUFNCRFRFRlZSRVZmVFU5RVJVdzdJQzh2SU95bmdPcTRpQ0RzaExqc2haanNuYlFnNjZ5ODZyT2dJT3llaU91S2xDRHJxcWpyamJnZ0tPeWFsT3l5cmV5ZHRDRHJpNlRycGJnZzY2cW82NDI0N0oyRUlPeW5nT3lnbGUyVm1PdXB0Q0RzaExqc2haZ2c3SjZzN0l1YzdKNlJLUW92THlEc2k1enNucEVnN0l1Y0lFTnNZWFZrWlNCRGIyUmxLR05zWVhWa1pTQkRURWtwNnJDQUlPeVR1Q0RzaUpnZzdKNkk2NHFVN0tlQUlPeWdrT3F5Z0NEaWdKUWc3SmVHN0p5ODY2bTBJQzlvWldGc2RHanJvWndnN0pXTTY2Q2tJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHNsWWpyZ3JUdGxaenJpNlF1Q2k4dklHNTFiR3c5N1ptVjdKMjRJT3lra1N3Z0oyOXJKejNzZ3F6c21xa2c2ckNBNjRxbExDQW5ZMnhoZFdSbExXMXBjM05wYm1jblBXTnNZWFZrWlNEcnFvWHJvTGtnN0plRzdKMk1MQW92THlBblkyeGhkV1JsTFd4dloyOTFkQ2M5WTJ4aGRXUmw2NHFVSU95ZWlPeW5nT3VuakNEcm9aenF0N2pzbmJnZzdJUzQ3SVdZSU91bmpPdWpqQ0FvN1lTMElPeUxwTzJNcUNEc2k1d2c2ckNRN0tlQUxDRHNoTEhxczdVZzdZUzA3SjIwSU95WXBPdXB0Q0RzbnBEcmo1a2c3WlcwN0tDY0tRcHNaWFFnWTJ4aGRXUmxVM1JoZEhWeklEMGdiblZzYkRzS0x5OGc2NkdjNnJlNDdKMjRJT3Vuak91ampDRHFzSkRzcDRBZzRvQ1VJRU5NU2Vxd2dDRHJnclRyaXBRZzdKaUI3SmEwSU95ZHVPeW1uU0RzbUtUcnBaanJwYndnN0lLczY1Nk03SjIwSU95VmpPeVZoT3VUcE95ZGhDRHNsWWpyZ3JUcm9ad2c2N0NVNnI2ODY0dWtMZ292THlBb1kyeGhkV1JsSUMwdGRtVnljMmx2YnV5ZGdDRHJvWnpxdDdqc25iZ2c3SmVHN0oyMDY0K0VJT3lFc2VxenRlMlZ0T3lFbkNEc2k1enJqNWtnN0tDUTZyS0E3Snk4NjZHYzY0cVVJT3VxdXlEc25xSHFzNkFzSU95THBPeWduQ0R0aExUc2w1RHNoSnpycDR3ZzY1T2M2NStzNjRLYzY0dWtLUW92THlBaTY2ZU02Nk9NSXV1bmpPeWR0Q0RzbFlUcmk0anJuYndnSXUyVm5DRHJzb2pyajRRZzY2R2M2cmU0N0oyNElPeVZpQ0R0bGFnaTY0K0VJT3F3bWV5ZGdDRHFzcjNyb1p6cm9ad2c3SjZoN1o2STY2K0E2NkdjSU95a2tldW12U0R0a1p6dG1JVHNuWVFnN0pPMDY0dWtDbU52Ym5OMElFeFBSMGxPWDBkVlNVUkZJRDBnSisyQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJqc25iUWc3WldFN0pxVTdaVzA3SnFVS095VmlDRHJrSkRxc2JEcmdwZ2c2NmVNNjZPTUtTRGlnSlFnVy9DZm42QWc3WUcwNjZHYzY1T2NJT3Vobk9xM3VPeWR1Q0R0bFlUc21wUmRJT3V5aE8yS3ZPeWRoQ0RyaUlUcnBiVHJxYlFnNjZHYzZyZTQ3SjI0SU95d3ZleWRoQ0RzbDdUc2xyVHJrNXpyb0tUc21wUXVKenNLTHk4ZzdJdWs3TGloN1pXY0lPdXN1T3Exck91VHBEb2dJa1poYVd4bFpDQjBieUJoZFhSb1pXNTBhV05oZEdVNklFOUJkWFJvSUhObGMzTnBiMjRnWlhod2FYSmxaQ0JoYm1RZ1kyOTFiR1FnYm05MElHSmxJSEpsWm5KbGMyaGxaQ0lvNjZlTTY2T01LU3dLTHk4Z0lrNXZkQ0JzYjJkblpXUWdhVzRnd3JjZ1VHeGxZWE5sSUhKMWJpQXZiRzluYVc0aUtPdXZ1T3Vobk9xM3VPeWR1Q2tnNG9DVUlPdVJtQ0RyaTZRZzdKNmg3WjZJNnJLTUlPdUVrKzJlak91THBBcG1kVzVqZEdsdmJpQnBjMEYxZEdoRmNuSnZjaWh6S1NCN0NpQWdjbVYwZFhKdUlDOWhkWFJvWlc1MGFXTmhkSHh2WVhWMGFIeGhjR2tnYTJWNWZHeHZaeUEvYVc1OGJHOW5aMlZrZkhObGMzTnBiMjRnWlhod2FYSmxaQzlwTG5SbGMzUW9VM1J5YVc1bktITXBLVHNLZlFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56NjZXOElPeWR2ZXlXdEFvdkx5QXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZuT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbENEc3BKSHNuYmpzcDRBaUlPMlJuT3lMbkNEaWdKUWc2ck8xN0pxcElGQkQ3SmVRN0lTY0lPdUNxT3lkbUNEcXM0VHNvSlVnN0ppazdJS3M3SnFwSU91d3FleW5nQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDbVoxYm1OMGFXOXVJR05zWVhWa1pVRmpZMjkxYm5Rb0tTQjdDaUFnYVdZZ0tFUmhkR1V1Ym05M0tDa2dMU0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQQ0F6TURBd01Da2djbVYwZFhKdUlHRmpZMjkxYm5SRFlXTm9aUzVsYldGcGJEc0tJQ0JzWlhRZ1pXMWhhV3dnUFNCdWRXeHNPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0JxSUQwZ1NsTlBUaTV3WVhKelpTaG1jeTV5WldGa1JtbHNaVk41Ym1Nb2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSnk1amJHRjFaR1V1YW5OdmJpY3BMQ0FuZFhSbU9DY3BLVHNLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdWhuT3EzdU95ZHVDRHNuYlRyb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDRHNuS0RzcDRBZ0tpOGdmUW9nSUdGalkyOTFiblJEWVdOb1pTQTlJSHNnWVhRNklFUmhkR1V1Ym05M0tDa3NJR1Z0WVdsc0lIMDdDaUFnY21WMGRYSnVJR1Z0WVdsc093cDlDbVoxYm1OMGFXOXVJR05vWldOclEyeGhkV1JsUVhaaGFXeGhZbXhsS0NrZ2V3b2dJR052Ym5OMElIQnliMkpsSUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbkxTMTJaWEp6YVc5dUoxMHNJSHNnYzJobGJHdzZJSFJ5ZFdVc0lHVnVkam9nUTB4QlZVUkZYMFZPVmlCOUtUc0tJQ0JzWlhRZ2IzVjBJRDBnSnljN0NpQWdjSEp2WW1VdWMzUmtiM1YwTG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzZ2IzVjBJQ3M5SUdRdWRHOVRkSEpwYm1jb0tUc2dmU2s3Q2lBZ2NISnZZbVV1YjI0b0oyVnljbTl5Snl3Z0tDa2dQVDRnZXlCamJHRjFaR1ZUZEdGMGRYTWdQU0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25PeUI5S1RzS0lDQndjbTlpWlM1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGdld29nSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnS0dOdlpHVWdQVDA5SURBZ0ppWWdMMXhrSzF3dVhHUXJMeTUwWlhOMEtHOTFkQ2twSUQ4Z0oyOXJKeUE2SUNkamJHRjFaR1V0YldsemMybHVaeWM3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnUTJ4aGRXUmxJRU52WkdVZzdLQ1E2cktBT2lBbklDc2dZMnhoZFdSbFUzUmhkSFZ6SUNzZ0tHOTFkQ0EvSUNjZ0tDY2dLeUJ2ZFhRdWRISnBiU2dwSUNzZ0p5a25JRG9nSnljcEtUc0tJQ0I5S1RzS2ZRb3ZMeURzc3BqcnBxd2c3WmlFN1ptcElPS0FsQ0F2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWdENBaTdLQ1Y2NmVRSU8yQnRPdWhuT3VUbk9xd2dDRHJpN1h0bG9qcmlwVHNwNEFpSU91d2x1eVhrT3lFbkNEdG1aWHNuYmp0bGFBZzdJaVlJT3llaU9xeWpDRHRsWnpyaTZRS1kyOXVjM1FnYzNSaGRITWdQU0I3SUhObGNuWmxaRG9nTUN3Z2JHRnpkRUYwT2lBbkp5d2diR0Z6ZEZSbGVIUTZJQ2NuTENCc1lYTjBVMlZqT2lBbkp5QjlPd29LTHk4ZzRwU0E0cFNBSU8yVWpPdWZyT3EzdU95ZHVDRHNnNTNzb2JRZzZyQ1E3S2VBS095THJPeWVwZXV3bGV1UG1Ta2c0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUNpOHZJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJscUFnN0o2STY0cVVJT3VQbWV5VmlDQmpiMlJsTG5SejZyQ0FJRFhzdElqcnA0anJpNlFnVUU5VFZDQXZhR1ZoY25SaVpXRjA2Nlc4SU91enRPdUN1T3VMcEM0S0x5OGc3WldjSU91eWlPeWR0T3Vkdk91UGhDRHJzSnZzbllBZzY1S2tJRE13N0xTSTZyQ0VJT3VCaXVxNHNPdXB0Q0R0bEl6cm42enF0N2pzbmJnbzY1aVE2NHFVSU8yVXZPcTN1T3VuaUNuc25iUWc2NHVyN1o2TUlPcXlneURpZ0pRZzdZRzA2NkdjNjVPYzZybU03S2VBSU91TnNPdW1yT3F6b0NEcXNKbnNuYlFnNnJxODdLZUU2NHVrTGdvdkx5RHNsWVRzcDRFZzdaV2NJT3V5aU91UGhDRHJxcnNnNjdDYjdKV1k3Snk4NjZtMEtPdUxwT3Vtck91bmpDRHJxTHpzb0lBZzdMeWdJT3lEZ2UyRG5Dd2c3SjZRNjQrWjdJdWM3SjZSSU91VHNTa2c2ck9FN0lhTklPdU1nT3E0c08yVm5PdUxwQzRLWTI5dWMzUWdTRVZCVWxSQ1JVRlVYMFJGUVVSZlRWTWdQU0F6TURBd01Ec0tiR1YwSUd4aGMzUkNaV0YwSUQwZ01Ec0tjMlYwU1c1MFpYSjJZV3dvS0NrZ1BUNGdld29nSUdsbUlDaHNZWE4wUW1WaGRDQW1KaUJFWVhSbExtNXZkeWdwSUMwZ2JHRnpkRUpsWVhRZ1BpQklSVUZTVkVKRlFWUmZSRVZCUkY5TlV5a2dld29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJVak91ZnJPcTN1T3lkdUNEc2k2enNucVhyc0pYcmo1a2c2NEdLNnJtQUlPS0FsQ0R0bEx6cXQ3anJwNGd2N1pTTTY1K3M2cmU0N0oyNDdKMjBJT3VMcSsyZWpDRHFzb1Bzbkx6cm9ad2c2N08wNnJPZ0lPcXdtZXlkdENEcXVyenNwNUhyaTRqcmk2UXVKeWs3Q2lBZ0lDQndjbTlqWlhOekxtVjRhWFFvTUNrN0lDOHZJR1Y0YVhRZzdaVzQ2NU9rNjUrczZyQ0FJR3RwYkd4UWNtOWo3Snk4NjZHY0lHTnNZWFZrWlNEdGlyanJwcXpycGJ3ZzdLQ1Y2NmFzN1pXYzY0dWtDaUFnZlFwOUxDQTFNREF3S1RzS0NpOHZJT3Vobk9xM3VPeWR1Q0JWVWt6c25ZUWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnQ2pyczdUdGhyVWc3TEM5S2V1aG5DRHNsNnpyaXBRZ1FsSlBWMU5GVWlEdGxianJrNlRybjZ3ZzdJcWs3WUdzNjZhOTdZcTQ2Nlc4SU91bmpPdVRvT3VMcEM0S0x5OGdZMnhoZFdSbElFTk1TZXVLbENCQ1VrOVhVMFZTSU8yWm1PcXl2ZXV6Z095SW1PdWx2Q0Rzb2JUc3BKSHRsYlFnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN1RzcDRBZzdKV0s2ck9nSU95ZHRDRHNpcVR0Z2F6cnByM3RpcmpzbDVBZ1lYVjBhRzl5YVhwbElGVlNUT3lkaENEcmhKanF1TFRyaTZRbzdJdWs3TGloSURJd01qWXRNRGNwTGdvdkx5QnRiMlJsUFNkemQybDBZMmduS09xemhPeWdsU0Rzb0lUdG1aZ3BJT0tHa2lEc2lybnNuYmdnN1ptVTY2bTA3SjJFSU9xeHNPeTVtT3luZ0NEc2xZcnFzNkFnS2lycXM0VHNvSlVnN0lTZzdZT2RJTzJabE91cHRPeWN2T3VobkNEcnNKVHJvWndxS2lEcnM3VHJncmpyaTZRdUNpOHZJQ0FnNjZHYzZyZTQ3SjI0NjVDY0lPeURnZTJEbk91cHRDQmhkWFJvYjNKcGVtWHFzSUFnN0lxNTdKMjRJTzJabE91cHRPeWN2T3VobkNEcXNJRHFzNkFnYzJWc1pXTjBRV05qYjNWdWREMTBjblZsd3Jkd2NtOXRjSFE5YzJWc1pXTjBYMkZqWTI5MWJuVHJvWnpyajRRZzY2cTdJT3VhcSt5Y3ZPdXZnT3VobkNqc2k2VHN1S0VwTEFvdkx5QWdJTzJWbkNEdGc2MGc3SldJN0plUTdJU2NJR05zWVhWa1pTNWhhUzlzYjJkdmRYUS9jbVYwZFhKdVZHODlQSFZ5YkMxbGJtTnZaR1ZrSUM5dllYVjBhQzloZFhSb2IzSnBlbVUvVVZWRlVsa283SU9CNjR5QTZySzk2NkdjS1Q3cm9ad2c3SjZINjRxVTY0dWtPZ292THlBZ0lPdWhuT3EzdU95VmhPeWJneWpzaExqc2haZ2c3S2VBN0p1QUtTRGlocElnYkc5bmFXNC9jMlZzWldOMFFXTmpiM1Z1ZEQxMGNuVmxLT3F6aE95Z2xTRHNoS0R0ZzUwcDY2R2NJT3lla091UG1TRHNzclRzbmJUcmk1MG83SXVrN0xpaE9pRHJpNmpzbmJ3ZzdZT3RLUzRnN0lxNTdKMjRJTzJabE91cHRDRHRsWmpyaTZnS0x5OGdJQ0JiNnJPRTdLQ1ZJT3lnaE8yWm1GMGc2N0tFN1lxODdKMjBJTzJWbU91S2xDRHNuYnpxczd3ZzZyQ1o3SjJBSU9xeXNPcXp2Q0RpZ0pRZzY0dWs2NmVNSU95YXNPdW1yT3F3Z0NEcXM2ZnNucVVnNnJlNElPMlpsT3VwdE95Y3ZPdWhuQ0RyczdUcmdyanJpNlF1Q2k4dklDQWdLT3UyZ095ZWtleWFxVG9nNjdpTTY1Mjg3SnF3N0tDQTdKMllJR05zWVhWa1pTNWhhU0RzbTdrZzY2R2M2cmU0N0oyNDY0K0VJTzJTZ091bXZDRGlnSlFnNnJPRTdLQ1ZJT3lnaE8yWm1DRHNuWmpyajRUc21ZQWc2N0NwN1phbDdKMjBJT3F3bWV5VmhDRHNpSmpzbXFrdUtRb3ZMeUJ0YjJSbFBTZHViM0p0WVd3bktPdW5qT3VqakNEc25xenJvWnpxdDdqc25iZ3BJT0tHa2lEcm9aenF0N2pzbFlUc200TWc3SmVHN0oyMElPcTN1T3VEcFNEc2w3RHJpNlFvNjR5QTZyQ2NJT3F3bWV5ZGdDRHFzNFRzb0pYc25iVHJuYndnN0lTNDdJV1lJT3ljb095bmdPcXdnQ0RydWFEcnBvUXBMZ3BtZFc1amRHbHZiaUIzY21sMFpVSnliM2R6WlhKSVlXNWtiR1Z5S0cxdlpHVXBJSHNLSUNCamIyNXpkQ0JzYjJkdmRYUWdQU0J0YjJSbElEMDlQU0FuYzNkcGRHTm9KenNLSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdZMjl1YzNRZ1kyMWtJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxaWNtOTNjMlZ5TFNjZ0t5QnRiMlJsSUNzZ0p5NWpiV1FuS1RzS0lDQWdJR052Ym5OMElIQnpJRDBnYkc5bmIzVjBDaUFnSUNBZ0lEOGdJaVIxUFNSbGJuWTZRMEpmVlZKTU95QWthVDBrZFM1SmJtUmxlRTltS0NkdllYVjBhQzloZFhSb2IzSnBlbVVuS1RzZ2FXWW9KR2tnTFdkbElEQXBleUFrY21Wc1BTY3ZKeXNrZFM1VGRXSnpkSEpwYm1jb0pHa3BPeUFrWlc1alBWdFRlWE4wWlcwdVZYSnBYVG82UlhOallYQmxSR0YwWVZOMGNtbHVaeWdrY21Wc0tUc2dVM1JoY25RdFVISnZZMlZ6Y3lBb0oyaDBkSEJ6T2k4dlkyeGhkV1JsTG1GcEwyeHZaMjkxZEQ5eVpYUjFjbTVVYnowbkt5UmxibU1wSUgwZ1pXeHpaU0I3SUZOMFlYSjBMVkJ5YjJObGMzTWdKSFVnZlNJS0lDQWdJQ0FnT2lBblUzUmhjblF0VUhKdlkyVnpjeUFrWlc1Mk9rTkNYMVZTVENjN0NpQWdJQ0JtY3k1M2NtbDBaVVpwYkdWVGVXNWpLR050WkN3Z0owQmxZMmh2SUc5bVpseHlYRzV6WlhRZ0lrTkNYMVZTVEQwbGZqRWlYSEpjYm5CdmQyVnljMmhsYkd3Z0xVNXZVSEp2Wm1sc1pTQXRSWGhsWTNWMGFXOXVVRzlzYVdONUlFSjVjR0Z6Y3lBdFEyOXRiV0Z1WkNBaUp5QXJJSEJ6SUNzZ0p5SmNjbHh1SnlrN0NpQWdJQ0J5WlhSMWNtNGdZMjFrT3dvZ0lIMEtJQ0JqYjI1emRDQnphQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFluSnZkM05sY2kwbklDc2diVzlrWlNBcklDY3VjMmduS1RzS0lDQmpiMjV6ZENCdWIyUmxRbWx1SUQwZ2NISnZZMlZ6Y3k1bGVHVmpVR0YwYURzZ0x5OGc3S0NFSUU5VDdKZVFJRzV2WkdVZzdKNkk3SjJNS091THBPdW1yT3F3Z0NCdWIyUmw2NkdjSU91UGppa3VJT3V6Z08yWm1DRHNpNlR0aktnZzdJdWNJT3lia091enVDQlZVa3dnNnJlNDY0eUE2NkdjSU95WHNPdUxwQ2htWVdsc0xYTnZablFwTGdvZ0lHTnZibk4wSUdKdlpIa2dQU0JzYjJkdmRYUUtJQ0FnSUQ4Z0p5TWhMMkpwYmk5emFGeHVKeUFyQ2lBZ0lDQWdJQ2RWUFNRb0lpY2dLeUJ1YjJSbFFtbHVJQ3NnSnlJZ0xXVWdYQ2RqYjI1emRDQjFQWEJ5YjJObGMzTXVZWEpuZGxzeFhUdGpiMjV6ZENCcFBYVXVhVzVrWlhoUFppZ2liMkYxZEdndllYVjBhRzl5YVhwbElpazdjSEp2WTJWemN5NXpkR1J2ZFhRdWQzSnBkR1VvYVR3d1AzVTZJbWgwZEhCek9pOHZZMnhoZFdSbExtRnBMMnh2WjI5MWREOXlaWFIxY201VWJ6MGlLMlZ1WTI5a1pWVlNTVU52YlhCdmJtVnVkQ2dpTHlJcmRTNXpiR2xqWlNocEtTa3BYQ2NnSWlReElpQXlQaTlrWlhZdmJuVnNiQ2xjYmljZ0t3b2dJQ0FnSUNBbmIzQmxiaUFpSkh0Vk9pMGtNWDBpWEc0bkNpQWdJQ0E2SUNjaklTOWlhVzR2YzJoY2JtOXdaVzRnSWlReElseHVKenNLSUNCbWN5NTNjbWwwWlVacGJHVlRlVzVqS0hOb0xDQmliMlI1S1RzS0lDQm1jeTVqYUcxdlpGTjVibU1vYzJnc0lEQnZOelUxS1RzS0lDQnlaWFIxY200Z2MyZzdDbjBLQ2k4dklPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN1pTRTY2R2M3SVM0N0lxa0lDaGpiR0YxWkdVZ1lYVjBhQ0JzYjJkcGJpQXRMV05zWVhWa1pXRnBLU0RpZ0pRZ0wyOXdaVzR0Ykc5bmFXN3NuYlFnN0lPZDdJU3h3cmZxdElEcnBxd3VDaTh2SU91NGpPdWR2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPdXp0T3VDdE95a2hDRHJsWXpxdVl6c3A0QWc3SWlvN0phMDdJU2NJT3VNZ09xNHNPMlZtT3VMcE9xd2dDd2c3Sm1FNjZPTTY1Q1k2Nm0wSU95S3BPeUtwT3VobkNEcmdaM3JncHpyaTZRdUNteGxkQ0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPd3BzWlhRZ2JHOW5hVzVRY205alZHbHRaWElnUFNCdWRXeHNPd3BzWlhRZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNBd095QXZMeURydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeUxuT3lla1NEc2k1enFzSUVnNG9DVUlPeWVyTzJCdE91bXJleWR0Q0FuN0o2czdJdWM2NCtFSit5ZHVPeW5nQ0FuN0o2UTY0K1o3Sm1FNjZPTUlPeUxwTzJNcUNmc25ianNwNEFnNnJXczY3YUU3WldjNjR1a0NtWjFibU4wYVc5dUlHdHBiR3hNYjJkcGJsQnliMk1vS1NCN0NpQWdhV1lnS0d4dloybHVVSEp2WTFScGJXVnlLU0I3SUdOc1pXRnlWR2x0Wlc5MWRDaHNiMmRwYmxCeWIyTlVhVzFsY2lrN0lHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2JuVnNiRHNnZlFvZ0lHbG1JQ2doYkc5bmFXNVFjbTlqS1NCeVpYUjFjbTQ3Q2lBZ1kyOXVjM1FnY0NBOUlHeHZaMmx1VUhKdll6c0tJQ0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPd29nSUhSeWVTQjdDaUFnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdJQ0J6Y0dGM2JsTjVibU1vSjNSaGMydHJhV3hzSnl3Z1d5Y3ZVRWxFSnl3Z1UzUnlhVzVuS0hBdWNHbGtLU3dnSnk5VUp5d2dKeTlHSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPd29nSUNBZ2ZTQmxiSE5sSUhzS0lDQWdJQ0FnZEhKNUlIc2djSEp2WTJWemN5NXJhV3hzS0Mxd0xuQnBaQ3dnSjFOSlIxUkZVazBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3SUhBdWEybHNiQ2dwT3lCOUNpQWdJQ0I5Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIMEtmUW9LWm5WdVkzUnBiMjRnYTJsc2JGQnliMk1vS1NCN0NpQWdhV1lnS0hCeWIyTXBJSHNLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdDaUFnSUNBZ0lDQWdMeThnYzJobGJHdzZkSEoxWmV1aG5DRHJuWVRzbTR6c2hKd2djSEp2WSt5ZGdDQmpiV1FnNnJ1TjY0Mnc2cml3SU9LQWxDQXZWT3VobkNEdGlyanJwcXpzcDdnZzdLTzk3SmVzN0pXOElPeW5oT3lubkNCamJHRjFaR1hxc0lBZzZyT2c3SldFNjZHY0lPeVZpQ0RyZ3FqcmlwVHJpNlFLSUNBZ0lDQWdJQ0F2THlBbzZyT2c3SldFSUdOc1lYVmtaZXF3Z0NEc2hLVHN1WmdnN1l5TTdKMjg3SjJFSU91c3ZPcXpvQ0Rzbm9qc25MenJxYlFnN1lHMDY2R2M2NU9jSU95VnNTRHNsNFhyamJEc25iVHRpcmpxc0lBZ0l1eUNyT3lhcVNEc3BKRWk3Snk4NjZHY0lPdW5pZTJlbUNrS0lDQWdJQ0FnSUNCemNHRjNibE41Ym1Nb0ozUmhjMnRyYVd4c0p5d2dXeWN2VUVsRUp5d2dVM1J5YVc1bktIQnliMk11Y0dsa0tTd2dKeTlVSnl3Z0p5OUdKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE93b2dJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUM4dklHMWhZMDlUTCt1bXJPdUloZXlLcERvZ2MyaGxiR3c2ZEhKMVpldWR2Q0J3Y205ajdKMjBJSE5vSU9xN2pldU5zT3E0c095ZHZDRHNpSmdnN0o2STdKMk1JT0tBbENCemRHRnlkRkJ5YjJQc25aZ2daR1YwWVdOb1pXVHJvWndnNjZlTTY1T2dDaUFnSUNBZ0lDQWdMeThnN1pTRTY2R2M3SVM0N0lxa0lPcTN1T3VqdVNndGNHbGtLZXlkaENEdGhyWHNwN2pyb1p3ZzdLQ1Y2NmFzN1pXYzY0dWtJQ2gwWVhOcmEybHNiQ0F2VkNEcmpJRHNuWkVwQ2lBZ0lDQWdJQ0FnZEhKNUlIc2djSEp2WTJWemN5NXJhV3hzS0Mxd2NtOWpMbkJwWkN3Z0oxTkpSMVJGVWswbktUc2dmU0JqWVhSamFDQW9YMlV5S1NCN0lIQnliMk11YTJsc2JDZ3BPeUI5Q2lBZ0lDQWdJSDBLSUNBZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdXN0T3lMbkNBcUx5QjlDaUFnZlFvZ0lIQnliMk1nUFNCdWRXeHNPd29nSUhkaGNtMWxaRlZ3SUQwZ1ptRnNjMlU3Q2lBZ2FXWWdLSGRoYVhSbGNpa2dleUJqYkdWaGNsUnBiV1Z2ZFhRb2QyRnBkR1Z5TG5ScGJXVnlLVHNnZDJGcGRHVnlMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9KKzJCdE91aG5PdVRuQ0RzaExqc2haanNuYlFnN0tLRjY2T002NUNRN0phMDdKcVVMaWNwS1RzZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnZlFwOUNncG1kVzVqZEdsdmJpQnpkR0Z5ZEZCeWIyTW9LU0I3Q2lBZ2EybHNiRkJ5YjJNb0tUc0tJQ0JzYVc1bFFuVm1JRDBnSnljN0NpQWdkSFZ5Ym5NZ1BTQXdPd29nSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c3SVM0N0lXWUlPeUxuT3VQbVNEc3BKSGlnS1lnS091cXFPdU51RG9nSnlBcklHTjFjbkpsYm5STmIyUmxiQ0FySUNjcEp5azdDaUFnWTI5dWMzUWdkR2hwYzFCeWIyTWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0Y0Njc0lDY3RMVzF2WkdWc0p5d2dZM1Z5Y21WdWRFMXZaR1ZzTENBbkxTMXBibkIxZEMxbWIzSnRZWFFuTENBbmMzUnlaV0Z0TFdwemIyNG5MQ0FuTFMxdmRYUndkWFF0Wm05eWJXRjBKeXdnSjNOMGNtVmhiUzFxYzI5dUp5d2dKeTB0ZG1WeVltOXpaU2RkTENCN0NpQWdJQ0J6YUdWc2JEb2dkSEoxWlN3Z1kzZGtPaUJGVFZCVVdWOURWMFFzSUdWdWRqb2dRMHhCVlVSRlgwVk9WaXdLSUNBZ0lHUmxkR0ZqYUdWa09pQndjbTlqWlhOekxuQnNZWFJtYjNKdElDRTlQU0FuZDJsdU16SW5MQ0F2THlCUVQxTkpXRG9nN0o2UTZyaXdJTzJVaE91aG5PeUV1T3lLcENEcXQ3anJvN2tnN0lPZDdJU3hJT0tBbENCcmFXeHNVSEp2WSt5ZHRDRHF0N2pybzduc3A3Z2c3S0NWNjZhczdaV2dJT3lJbUNEc25vanFzb3dLSUNCOUtUc0tJQ0J3Y205aklEMGdkR2hwYzFCeWIyTTdDaUFnY0hKdll5NXpkR1J2ZFhRdWIyNG9KMlJoZEdFbkxDQW9aQ2tnUFQ0Z2V3b2dJQ0FnYkdsdVpVSjFaaUFyUFNCa0xuUnZVM1J5YVc1bktDZDFkR1k0SnlrN0NpQWdJQ0JzWlhRZ2FXUjRPd29nSUNBZ2QyaHBiR1VnS0NocFpIZ2dQU0JzYVc1bFFuVm1MbWx1WkdWNFQyWW9KMXh1SnlrcElDRTlQU0F0TVNrZ2V3b2dJQ0FnSUNCamIyNXpkQ0JzYVc1bElEMGdiR2x1WlVKMVppNXpiR2xqWlNnd0xDQnBaSGdwTG5SeWFXMG9LVHNLSUNBZ0lDQWdiR2x1WlVKMVppQTlJR3hwYm1WQ2RXWXVjMnhwWTJVb2FXUjRJQ3NnTVNrN0NpQWdJQ0FnSUdsbUlDZ2hiR2x1WlNrZ1kyOXVkR2x1ZFdVN0NpQWdJQ0FnSUd4bGRDQmxkaUE5SUc1MWJHdzdDaUFnSUNBZ0lIUnllU0I3SUdWMklEMGdTbE5QVGk1d1lYSnpaU2hzYVc1bEtUc2dmU0JqWVhSamFDQW9YMlVwSUhzZ1kyOXVkR2x1ZFdVN0lIMEtJQ0FnSUNBZ2FXWWdLR1YySUNZbUlHVjJMblI1Y0dVZ1BUMDlJQ2R5WlhOMWJIUW5JQ1ltSUhkaGFYUmxjaWtnZXdvZ0lDQWdJQ0FnSUdOdmJuTjBJSGNnUFNCM1lXbDBaWEk3Q2lBZ0lDQWdJQ0FnZDJGcGRHVnlJRDBnYm5Wc2JEc0tJQ0FnSUNBZ0lDQmpiR1ZoY2xScGJXVnZkWFFvZHk1MGFXMWxjaWs3Q2lBZ0lDQWdJQ0FnYVdZZ0tHVjJMbWx6WDJWeWNtOXlLU0I3Q2lBZ0lDQWdJQ0FnSUNCamIyNXpkQ0J5WVhjZ1BTQlRkSEpwYm1jb1pYWXVjbVZ6ZFd4MElIeDhJR1YyTG5OMVluUjVjR1VnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJREl3TUNrN0NpQWdJQ0FnSUNBZ0lDQnBaaUFvYVhOQmRYUm9SWEp5YjNJb2NtRjNLU2tnZXdvZ0lDQWdJQ0FnSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNBblkyeGhkV1JsTFd4dloyOTFkQ2M3SUM4dklDOW9aV0ZzZEdqcm9ad2c3WlNNNjUrczZyZTQ3SjI0N0plUUlPeVZqT3VtdkNEaWhwSWc2N0tFN1lxODdKMjBJRnZyb1p6cXQ3anNuYmdnN1pXRTdKcVVYZXVobkNEcnNKVHJnSndLSUNBZ0lDQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdEb25MQ0J5WVhjcE93b2dJQ0FnSUNBZ0lDQWdJQ0IzTG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvVEU5SFNVNWZSMVZKUkVVcEtUc0tJQ0FnSUNBZ0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lDQWdJQ0FnSUhjdWNtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdZRzA2NkdjNjVPY0lPeVlwT3VsbURvZ0p5QXJJSEpoZHlrcE93b2dJQ0FnSUNBZ0lDQWdmUW9nSUNBZ0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lDQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW5iMnNuT3lBdkx5RHNoTEhxczdVZ1BTRHNoS1RzdVpqQ3QrdWhuT3EzdU95ZHVDRHJpNlFnN0tDVjdJT0JJT0tBbENEc2xyVHJscVFnY0hKdllteGxiZXlkdE91VG9DRHRsYlRzb0p3Z0tPeWVyT3Vobk9xM3VPeWR1Qy9zbnF6c2hLVHN1WmdnNjdPMTZyZUFLUW9nSUNBZ0lDQWdJQ0FnZHk1eVpYTnZiSFpsS0ZOMGNtbHVaeWhsZGk1eVpYTjFiSFFnZkh3Z0p5Y3BLVHNLSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJSDBLSUNBZ0lIMEtJQ0I5S1RzS0lDQndjbTlqTG5OMFpHVnljaTV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCeklEMGdaQzUwYjFOMGNtbHVaeWduZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUdsbUlDaHpJQ1ltSUNGekxtbHVZMngxWkdWektDZEVaWEJ5WldOaGRHbHZibGRoY201cGJtY25LU2tnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElHTnNZWFZrWlNCemRHUmxjbkk2Snl3Z2N5NXpiR2xqWlNnd0xDQXlNREFwS1RzS0lDQjlLVHNLSUNCd2NtOWpMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0F2THlEc25iVHJyN2dnN0lPSUlPeUV1T3lGbU95Y3ZPdWhuQ0RxdFpEc3NyVHJrSndnNjVLa0lPeVlteURzaExqc2haanNuYlFnNjR1cjdaNk1JT3F4c091cHRDRHJyTFRzaTV3Z0tPdXFxT3VOdUNEc29JVHRtWmdnN0l1Y0lPeURpQ0RzaExqc2haanNuWVFnN0tPOTdKMjA3S2VBSU95Vml1cXlqQ2tLSUNBZ0lHbG1JQ2h3Y205aklDRTlQU0IwYUdselVISnZZeWtnY21WMGRYSnVPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c3S0tGNjZPTUlDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a2c0b0NVSU91THBPeWRqQ0RzbXBUc3NxMGc2NVdNSU91THBPeUxuQ0RzaTV6cmo1bnRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUgwcE93cDlDZ3BtZFc1amRHbHZiaUJ6Wlc1a1ZIVnliaWgwWlhoMEtTQjdDaUFnY21WMGRYSnVJRzVsZHlCUWNtOXRhWE5sS0NoeVpYTnZiSFpsTENCeVpXcGxZM1FwSUQwK0lIc0tJQ0FnSUdsbUlDZ2hjSEp2WXlrZ2NtVjBkWEp1SUhKbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSisyQnRPdWhuT3VUbkNEc2hManNoWmpzbmJRZzdKZUc3SmEwN0pxVUxpY3BLVHNLSUNBZ0lHbG1JQ2gzWVdsMFpYSXBJSEpsZEhWeWJpQnlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnNsWjdzaEtBZzdKcVU3TEt0N0oyMElPeW5oTzJXaVNEc3BKSHNuYlRzbDVEc21wUXVKeWtwT3dvZ0lDQWdZMjl1YzNRZ2RHbHRaWElnUFNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkV0Q0RzaTV6cXNJUWc3TFNJNnJPOElPS0FsQ0RzaExqc2haanNuWVFnN0o2czdJdWM3SjZSN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnZlN3Z1ZGVlNUbDlVU1UxRlQxVlVYMDFUS1RzS0lDQWdJSGRoYVhSbGNpQTlJSHNnY21WemIyeDJaU3dnY21WcVpXTjBMQ0IwYVcxbGNpQjlPd29nSUNBZ2NISnZZeTV6ZEdScGJpNTNjbWwwWlNoS1UwOU9Mbk4wY21sdVoybG1lU2g3SUhSNWNHVTZJQ2QxYzJWeUp5d2diV1Z6YzJGblpUb2dleUJ5YjJ4bE9pQW5kWE5sY2ljc0lHTnZiblJsYm5RNklIUmxlSFFnZlNCOUtTQXJJQ2RjYmljc0lDZDFkR1k0SnlrN0NpQWdmU2s3Q24wS0NpOHZJT3F3bWV5ZGdDRHJyTGpxdGF6cnBid2c2NnFISU91eWlPeW51Q0Ryckx2cmlwVHNwNEFnNnJpdzdKYTFJT0tBbENEc25xenNtcFRzc3Ezc25iVHJxYlFnSXV5ZHRPeWdoT3F6dkNEcmk2VHJwYmdnN0lPSUlPeWduT3lWaUNMc25ZUWc3SnFVNnJXczdaV2M2NHVrQ2k4dklDanNsWWdnNnJlNDY1K3M2Nm0wSU8yQnRPdWhuT3VUbk9xd2dDRHNoTEhzaTZUdGxaanFzb3dnNnJDWjdKMkFJT3VMdGV5ZGhDRHJtSkFnNjRLMDdJU2NJRnRCU1NEc3RwVHNzcHdnNjQyVUlPdXdtK3E0c0YzcXNJQWc2NnkwN0oyWTY2KzQ3WlcwN0tlRTY0dWtLUXBqYjI1emRDQmhjMnRsWkVOdmRXNTBJRDBnYm1WM0lFMWhjQ2dwT3dvS0x5OGc3SVM0N0lXWUlPeWtnT3U1aENqc2k1enJqNWtyN0tlQTdJdWM2Nnk0SU95anZPeWVoU25ycGJ3ZzY3TzA3SjZsN1pXY0lPdVNwQ0R0bFp3ZzdZUzBJT3lMcE8yV2lTRGlnSlFnNjZxbzY1T2dJTzJZdU95Mm5PeWRnQ0J4ZFdWMVpldWhuQ0RzcDRIcm9LenRtWlF1Q2k4dklHMXZaR1ZzN0oyRUlPeWp2T3VwdENEcXQ3Z2c2NnFvNjQyNDY2R2NJQ2pyaTZUcnBiVHJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU2t1SU8yVm5DRHJxcWpyamJqc25ZUWc2ck9FN0lhTklPeVRzT3VwdENEc25xenNpNXpzbnBIc25ZQWc3TFdjN0xTSUlESHRtb3pydjVBdUNtWjFibU4wYVc5dUlISjFibFIxY200b1luVnBiR1JCYzJzc0lHMXZaR1ZzS1NCN0NpQWdZMjl1YzNRZ2FtOWlJRDBnY1hWbGRXVXVkR2hsYmloaGMzbHVZeUFvS1NBOVBpQjdDaUFnSUNCcFppQW9iVzlrWld3Z0ppWWdRVXhNVDFkRlJGOU5UMFJGVEZNdWFXNWtaWGhQWmlodGIyUmxiQ2tnSVQwOUlDMHhJQ1ltSUcxdlpHVnNJQ0U5UFNCamRYSnlaVzUwVFc5a1pXd3BJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91cXFPdU51Q0RyczREcXNyMDZJQ2NnS3lCamRYSnlaVzUwVFc5a1pXd2dLeUFuSU9LR2tpQW5JQ3NnYlc5a1pXd3BPd29nSUNBZ0lDQmpkWEp5Wlc1MFRXOWtaV3dnUFNCdGIyUmxiRHNLSUNBZ0lDQWdjM1JoY25SUWNtOWpLQ2s3SUM4dklPeURpQ0RycXFqcmpianJvWndnN0lTNDdJV1lJT3llck95TG5PeWVrU0FvNjR1azdKMk1JT3liak91d2pleVhoZXlYa095RW5DRHNwNERzaTV6cnJMZ2c3SjZzN0tPODdKNkZLUW9nSUNBZ2ZRb2dJQ0FnYVdZZ0tIUjFjbTV6SUQ0OUlFMUJXRjlVVlZKT1V5QjhmQ0FoY0hKdll5a2djM1JoY25SUWNtOWpLQ2s3Q2lBZ0lDQnBaaUFvSVhkaGNtMWxaRlZ3S1NCN0NpQWdJQ0FnSUdOdmJuTjBJSFF3SUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUNBZ1lYZGhhWFFnYzJWdVpGUjFjbTRvYVc1emRISjFZM1JwYjI1TlpYTnpZV2RsS0NrcE93b2dJQ0FnSUNCM1lYSnRaV1JWY0NBOUlIUnlkV1U3Q2lBZ0lDQWdJSFIxY201ekt5czdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haZ2c3S1NBNjdtRUlPeVpoT3VqakNBb0p5QXJJQ2dvUkdGMFpTNXViM2NvS1NBdElIUXdLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2tnS3lBbmN5a2c0b0NVSU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjdtbzY1Mjg3SnFVTGljcE93b2dJQ0FnZlFvZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUhKbGRIVnliaUJ6Wlc1a1ZIVnliaWhpZFdsc1pFRnpheWdwS1RzS0lDQjlLVHNLSUNBdkx5RHRsWndnN0pxVTdMS3Q3SjIwSU95THBPMk1xTzJWdE91UGhDRHJpNlRzbll3ZzdKcVU3TEt0N0oyMElPeWR0T3lXdE95bmdPdVBoT3VoblNEdGdaRHJpcFFnN1pXdDdJT0JJT3lFc2VxenRleWN2T3VobkNEc29KWHJwcXdLSUNCeGRXVjFaU0E5SUdwdllpNWpZWFJqYUNnb0tTQTlQaUI3ZlNrN0NpQWdjbVYwZFhKdUlHcHZZanNLZlFvS0x5OGc2Nnk0NnJXc0lPeTJsT3l5bkNEdGhMUUtablZ1WTNScGIyNGdZWE5yUTJ4aGRXUmxLSFJsZUhRc0lHMXZaR1ZzS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ1lYUjBaVzF3ZENBOUlDaGhjMnRsWkVOdmRXNTBMbWRsZENoMFpYaDBLU0I4ZkNBd0tTQXJJREU3Q2lBZ0lDQmhjMnRsWkVOdmRXNTBMbk5sZENoMFpYaDBMQ0JoZEhSbGJYQjBLVHNLSUNBZ0lHbG1JQ2hoYzJ0bFpFTnZkVzUwTG5OcGVtVWdQaUF5TURBcElHRnphMlZrUTI5MWJuUXVZMnhsWVhJb0tUc2dMeThnNjZ5MDdaV2M3WjZJSU95TWsreWR0T3luZ0NEc2xZcnFzb3dLSUNBZ0lISmxkSFZ5YmlCaGRIUmxiWEIwSUQ0Z01Rb2dJQ0FnSUNBL0lDZnFzSm5zbllBZzY2eTQ2cldzNjZXOElPdUxwT3lMbkNEc21wVHNzcTN0bFp6cmk2UXVJT3lkdENEc2hManNoWmpzbDVEc2hKd2c3SjIwN0tDRTdKZVFJT3lnbk95VmlPMldpT3VObUNEcXNvUHJrNlRxczd3ZzZySzU3TG1ZN0tlQUlPeVZpdXVLbEN3ZzZyV3M3S0d3NjRLWUlPeVd0TzJjbU9xd2dDRHRtWlhzaTZUdG5vZ2c2NHVrNjZXNElPeURpT3Vobk95YXRDRHJqSURzbFlnZ00rcXduT3VsdkNEcXQ1enN1Wm5yaklEcm9ad2dTbE5QVGlEcnNMRHNsN1Ryb1p6cnA0dzZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtRb2dJQ0FnSUNBNklDZnJpNlRzbll3Z1ZVa2c2Nnk0NnJXczdKMllJT3VNZ095VmlDQXo2ckNjNjZXOElPcTNuT3k1bWV1TWdPdWhuQ0JLVTA5T0lPdXdzT3lYdE91aG5PdW5qRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0hSbGVIUXBPd29nSUgwc0lHMXZaR1ZzS1RzS2ZRb0tMeThnNjdLSTdKZXRJTzJFdENEaWdKUWc2ckNaN0oyQUlPeUV1T3lGbU95ZGhDRHNrN0Rya0pnc0lPeWR0T3V5aUNEdGhMVHJwNHdnN0xhVTdMS2NJTzJZbGV5TG5TaEtVMDlPSU91d3NPeVh0Q2tnNjR5QTdJdWdJT3V5aU95WHJTRHRtSlhzaTUwb1NsTlBUaURxc0ozc3NyUXA3SjJFSU95YWxPcTFyTzJWbk91THBBcG1kVzVqZEdsdmJpQmhjMnRVY21GdWMyeGhkR1VvZEdWNGRDd2diVzlrWld3cElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlBb0NpQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0Ryc29qc2w2MGc3SjZSN0plRjdKMjA2NHVrSUNqcnJManF0YXdnNjR1azY1T3M2cml3SU95VmhPdUxtQ0RpZ0pRZzY0eUE3SldJSURQcXNKd2c2cmVjN0xtWjdKMkFJT3lkdE91eWlDRHRoTFRzbDVBZzdLQ0I3SnFwN1pXWTdLZUFJT3lWaXV1S2xPdUxwQ2t1SUNjZ0t3b2dJQ0FnSit1THBPeWRqQ0JWU1NEcnJManF0YXpxc0lBZzdaV2M2cld0N0phMDY2bTBJT3lla095WHNPeUtwT3Vmck95YXRDRHNtSUhzbHJUcm9ad3NJT3lZZ2V5V3RPdXB0Q0RzbnBEc2w3RHNpcVRybjZ6c21yUWc3WldjNnJXdDdKYTA2NkdjSU91eWlPeVhyZTJWbU91ZHZDNGdKeUFyQ2lBZ0lDQW5WVWtnNjZ5NDZyV3M2NHVrN0pxMElPcXdoT3F5c08yVm5DRHRrWnp0bUlUc25ZUWc3Sk93NnJPZ0xDRHNuYlRycG9UQ3QreUlxK3lla01LMzY2ZUk3SXFrN1lLNXdyZnRsSXpyb0lqc25iVHNpcVR0bVlEcmpaVHJpcFFnNnJlNDY0eUE2NkdjSU91enRPeWh0TzJWbk91THBDNGdKeUFyQ2lBZ0lDQW43SnVRNjZ5NDdKMllJT3lraENEc2lKanJwYndnNnJlNDY0eUE2NkdjSU95Y29PeW5nTzJWbk91THBDRGlnSlFnN0p1UTY2eTQ3SjIwSU8yVm5DRHNwSVRzbmJUcnFiUWc2N0tJN0pldDY0K0VJTzJWbkNEc3BJVHJvWndzSU95a2hPdXdsT3EvaU95ZGhDRHNub1Rzblpqcm9ad2c3TGFVNnJDQTdaV1k3S2VBSU95Vml1dUtsT3VMcEM0Z0p5QXJDaUFnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhTRHF1SWpzcDRBNklDY2dLd29nSUNBZ0ozc2lkSEpoYm5Oc1lYUmxaQ0k2SUNMcnNvanNsNjNyckxnZ0tPeWtoT3V3bE9xL2lPeWRnQ0JjWEc0cElpd2dJbVJwY21WamRHbHZiaUk2SUNKcmIrS0drbVZ1SU91WWtPdUtsQ0JsYnVLR2ttdHZJbjA2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLUW9nSUNrc0lHMXZaR1ZzS1RzS2ZRb0tMeThnNjR5QTdabVU3WmlWSU91c3VPcTFyQ0Rzb0p6c25wRWc3WVMwSU9LQWxDRHNncXpzbXFuc25wRHFzSUFnN0lPQjdabXA3SjJFSU95RXBPdXFoZTJWbU91cHRDRHJwNlhybmIzc2w1QWc2NmVlNjRxVUlPdXN1T3Exck91bHZDRHJwNHpyazZUc2xyVHNwSURyaTZRdUNpOHZJRzFsYzNOaFoyVnpPaUJiZTNKdmJHVTZKM1Z6WlhJbmZDZGhjM05wYzNSaGJuUW5MQ0IwWlhoMGZWMGc3S0NFN0xLMElPdU1nTzJabE91bHZDRHJwNlRyc29nZzY3Q2I2NHFVNjR1a0tPdUxwT3Vtck91S2xDRHJyTFRzZzRIdGc1d2c0b0NVQ2k4dklPeWJqT3V3amV5WGhTRHNwNERzaTV6cnJManNuWmdnSXV5YWxPeXlyZXVUcE95ZGdDRHNoSnpyb1p3ZzY2eTA2clNBSWlEc29JVHNvSnpycGJ3ZzdLZUE3WUtrNnJpd0lPeWNoTzJWdENEcmpJRHRtWlFnNjZlbDY1Mjk3SjJFSU8yRXRDRHNsWWpzbDVBZzY2cTk2NVdGSU95TG8rdUtsT3VMcENrdUNtWjFibU4wYVc5dUlHRnphME52YlhCdmMyVW9iV1Z6YzJGblpYTXNJRzF2WkdWc0tTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3b2dJQ0FnWTI5dWMzUWdkSEpoYm5OamNtbHdkQ0E5SUNodFpYTnpZV2RsY3lCOGZDQmJYU2t1YldGd0tDaHRLU0E5UGdvZ0lDQWdJQ0FvYlM1eWIyeGxJRDA5UFNBbllYTnphWE4wWVc1MEp5QS9JQ2ZzbHJUc2k1enNpcVR0aExUdGlyZzZJQ2NnT2lBbjdJS3M3SnFwN0o2UU9pQW5LU0FySUZOMGNtbHVaeWh0TG5SbGVIUWdmSHdnSnljcExuTnNhV05sS0RBc0lERTFNREFwQ2lBZ0lDQXBMbXB2YVc0b0oxeHVKeWs3Q2lBZ0lDQnlaWFIxY200Z0tBb2dJQ0FnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTY0eUE3Wm1VN1ppVklPdXN1T3ExckNEc29KenNucEVpN0oyMDY0dWtJQ2pxdUxEc29iUWc2Nnk0NnJXc0lPdUxwT3VUck9xNHNDRHNsWVRyaTVnZzRvQ1VJT3lWaE91ZW1DRHJqSUR0bVpUcXNJQWc3SjIwNjdLSUlPMkV0T3lkbUNEc29JVHNzclFnNjZlbDY1Mjk3SjIwNjR1a0tTNGdKeUFyQ2lBZ0lDQWdJQ2ZzZ3F6c21xbnNucERxc0lBZzdabVU2Nm0wSU95RGdlMlpxY0szNjZlbDY1Mjk3SjJFSU95RXBPdXFoZTJWbU91cHRDd2c3SXFrN1lPQTdKMjhJT3Ezbk95NW1lcXp2Q0RzbUlqc2k1d2c3WWFrN0plUUlPdW5udXVLbENCVlNTRHJyTGpxdGF6cnBid2c2NmVNNjVPazdKYTBJT3lnbk95VmlPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RycDZYcm5iM3NuYlFnNjZ5NDZyV3M2Nlc4SU95VHNPcTRzT3lYa0NEcnRvRHNvYkh0bFpqcnFiUW83SmEwNjRxUUlPMlpsT3VwdE95ZHVPeW5nQ3dnNjZ5MDdJcW9JT3lEZ2UyWnFleWR1T3luZ0NEcms3RXBJT3E4clNEdGxZVHNtcFR0bFp3ZzZyS0RJREhxc0lEc3A0RHJwNHdnN0tlbjZyS01JT3VRbU91c3ZPeVd0T3VkdkM0ZzdKMjA2NVdNSUhOMVoyZGxjM1JwYjI1ejY0cVVJT3U1aUNEcnNMRHNsN1F1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2Nnk0NnJXczY2VzhJT3lnbk95VmlPMlZvQ0RybFpBZzdJU2M2NkdjSU95Z2tlcTN2T3lkdENEcmk2VHJwYmdnTW40ejZyQ2NMaURxc0lFZzdLQ2M3SldJN0plVUlPeVpuQ0RxdDdqcm9JZnFzb3dnN0kyODY0cVU3S2VBSU95ZHRPeWNvT3VsdkNEcnRwbnNuYmpyaTZRdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN0lLczdKcXA3SjZRNnJDQUlPeVd1T3E0aWUyVm1PeW5nQ0RzbFlyc25ZQWc2cldzN0xLMElPeWdsZXV6dENqc29JVHRtWlRyc29qdG1MakN0MVZTVE1LMzZyaUk3Sldod3JmdG1wL3NpSmdnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjRTajdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEdG00VHNobzBnN0pxVTdMS3RLQ0xyalpRZzdLZW42cktNSWl3Z0l1dXloTzJLdk95YXFleWN2T3VobkNJZzY1T3hLZXlkdE91cHRDRHNwNEhzb0lRZzdLQ2M3SldJN0oyRUlPcTN1Q0Ryc0tudGxxWHNuTHpyb1p3ZzZyT2c3TE9RSU91THBPeUxuQ0Rzb0p6c2xZanRsWmpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1VnNnJpSTdLZUFPaUFuSUNzS0lDQWdJQ0FnSjNzaWNtVndiSGtpT2lBaTY0eUE3Wm1VSU95ZGtldUx0U0R0bFp6cmtaQWc2Nnk0N0o2bElDanRsYlRzbXBUc3NyUXBJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FnN1pXY0lPdXN1T3llcFNKOVhYMWNibHh1SnlBckNpQWdJQ0FnSUNkYjY0eUE3Wm1VWFZ4dUp5QXJJSFJ5WVc1elkzSnBjSFFLSUNBZ0lDazdDaUFnZlN3Z2JXOWtaV3dwT3dwOUNnb3ZMeURyaklEdG1aVHRtSlVnN0tDYzdKNlJJT3lka2V1THRleVhrT3lFbkNCN2NtVndiSGtzSUhOMVoyZGxjM1JwYjI1elcxMTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa0tablZ1WTNScGIyNGdjR0Z5YzJWRGIyMXdiM05sS0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdieUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCamIyNXpkQ0J5WlhCc2VTQTlJRk4wY21sdVp5Z29ieUFtSmlCdkxuSmxjR3g1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BPd29nSUNBZ1kyOXVjM1FnYzNWbloyVnpkR2x2Ym5NZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTV6ZFdkblpYTjBhVzl1Y3lrS0lDQWdJQ0FnUHlCdkxuTjFaMmRsYzNScGIyNXpDaUFnSUNBZ0lDQWdJQ0F1YldGd0tDaDRLU0E5UGlBb2V5QjBaWGgwT2lCVGRISnBibWNvS0hnZ0ppWWdlQzUwWlhoMEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCeVpXRnpiMjQ2SUZOMGNtbHVaeWdvZUNBbUppQjRMbkpsWVhOdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa0tJQ0FnSUNBZ0lDQWdJQzVtYVd4MFpYSW9LSGdwSUQwK0lIZ3VkR1Y0ZENrS0lDQWdJQ0FnT2lCYlhUc0tJQ0FnSUdsbUlDaHlaWEJzZVNCOGZDQnpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ3BJSEpsZEhWeWJpQjdJSEpsY0d4NUxDQnpkV2RuWlhOMGFXOXVjeUI5T3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUc1MWJHdzdDbjBLQ2k4dklPdXlpT3lYclNEc25aSHJpN1hzbDVEc2hKd2dlM1J5WVc1emJHRjBaV1FzSUdScGNtVmpkR2x2Ym4wZzdMYVU3TGFjSUNqc3ZaVHJrNXp0anB6c2lxVEN0K3lWbnV1U3BDRHNucUhyaTdRZzdaZUk3SnFwS1FwbWRXNWpkR2x2YmlCd1lYSnpaVlJ5WVc1emJHRjBaU2h5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYSHRiWEhOY1UxMHFYSDB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93b2dJQ0FnWTI5dWMzUWdkSEpoYm5Oc1lYUmxaQ0E5SUZOMGNtbHVaeWdvYnlBbUppQnZMblJ5WVc1emJHRjBaV1FwSUh4OElDY25LUzUwY21sdEtDazdDaUFnSUNCcFppQW9kSEpoYm5Oc1lYUmxaQ2tnY21WMGRYSnVJSHNnZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dU9pQlRkSEpwYm1jb0tHOGdKaVlnYnk1a2FYSmxZM1JwYjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlRzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNsWVRybnBqcm9ad2dLaThnZlFvZ0lISmxkSFZ5YmlCdWRXeHNPd3A5Q2dvdkx5RHNuWkhyaTdYc2w1RHNoSndnZTNSbGVIUXNJSEpsWVhOdmJuMGc2N0N3N0plMElPeTJsT3kybkNBbzdMMlU2NU9jN1k2YzdJcWt3cmZzbFo3cmtxUWc3SjZoNjR1MElPMlhpT3lhcVNrS1puVnVZM1JwYjI0Z2NHRnljMlZUZFdkblpYTjBhVzl1Y3loeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEZ0YlhITmNVMTBxWEYwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJR0Z5Y2lBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3Q2lBZ0lDQnBaaUFvUVhKeVlYa3VhWE5CY25KaGVTaGhjbklwS1NCN0NpQWdJQ0FnSUhKbGRIVnliaUJoY25JS0lDQWdJQ0FnSUNBdWJXRndLQ2g0S1NBOVBpQW9leUIwWlhoME9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1MFpYaDBLU0I4ZkNBbkp5a3VkSEpwYlNncExDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tLSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOVBpQjRMblJsZUhRcE93b2dJQ0FnZlFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUZ0ZE93cDlDZ292THlEcm9aenF0N2pzbmJnZzdaV0U3SnFVSU95RGdlMkRuT3lkdkNEcmxZd2dMMmhsWVd4MGFDRHNvYkR0bW96cXNJQWc3SmlrNjZtMElPdVNwT3lYa095RW5DRHNtNHpyc0kzc2w0WHNuWVFnNjR1azdJdWNJT3lMbk91UGhPMlZ0T3V6dU91THBDQW9NekRzdElqc2w1QWdNZXV5aU91bmpDa3VDaTh2SU95RXNlcXp0ZTJWbU91cHRDRHFzckRxczd3ZzdaVzQ2NU9rNjUrczZyQ0FJR05zWVhWa1pWTjBZWFIxY3owbmIyc242NkdjSU91UW1PdVBqT3Vtck91dmdPdWhuQ3dnN0o2czY2R2M2cmU0N0oyNElPMmJoQ0Ryc29UdGlyenNuYlFnN0tDQTdLQ0k2NkdjSVBDZm42THNuTHpyb1p3ZzY3TzE2cmVBN1pXYzY0dWtMZ292THlBbzdaU002NStzNnJlNDdKMjQ3SjIwSU91aG5PcTN1T3lkdUNEc3NMM3NuWVFnN0pld0lPdVNwQ0Rzbzd6cXVMRHNvSUhzbkx6cm9ad2dMMmhsWVd4MGFPdWx2Q0Rzb2JEdG1venRsWmpyaXBRZzZyS0Q2ck84SU95bm5leWRoQ0RzbmJUcm82enJpNlFwQ214bGRDQnNZWE4wUVhWMGFGSmxkSEo1UVhRZ1BTQXdPd3BtZFc1amRHbHZiaUJ5WlhSeWVVRjFkR2hKWms1bFpXUmxaQ2dwSUhzS0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklDRTlQU0FuWTJ4aGRXUmxMV3h2WjI5MWRDY3BJSEpsZEhWeWJqc0tJQ0JwWmlBb2QyRnBkR1Z5SUh4OElFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQQ0F6TURBd01Da2djbVYwZFhKdU95QXZMeURzcDRUdGxva2c3S1NSSU8yRXRDRHJzS250bGJRZzZyaUk3S2VBSUNzZ016RHN0SWdnNnJDRTZyS3BDaUFnYkdGemRFRjFkR2hTWlhSeWVVRjBJRDBnUkdGMFpTNXViM2NvS1RzS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU95ZXJPMlpsZXlkdUNEc2k1enJqNFRpZ0tZbktUc0tJQ0J5ZFc1VWRYSnVLQ2dwSUQwK0lDZnJvWnpxdDdqc25iZ2c3Wm1WN0oyNDdKcXA3SjIwNjR1a0xpQWlUMHNpNjUyODZyT2c2NmVNSU91THRlMlZtT3VkdkM0bktTNTBhR1Z1S0FvZ0lDQWdLQ2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0R0bVpYc25ianJrS2dnNG9DVUlPeWdsZXlEZ1NEc2c0SHRnNXpyb1p3ZzY3TzE2cmVBTGljcExBb2dJQ0FnS0dVcElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2xZVHNwNEVnNjZHYzZyZTQ3SjI0SU95VmlDRHJrS2c2Snl3Z1UzUnlhVzVuS0dVdWJXVnpjMkZuWlNrdWMyeHBZMlVvTUN3Z09EQXBLUW9nSUNrN0NuMEtDaTh2SU95THBPMk1xQ0RzblpIcmk3WHNuWVFnN0lLczY1Nk03SnFwSU95VmlPdUN0T3VobkNEcnM0RHRtWmdnNG9DVUlPeWJrT3lkdUNqcm9aenF0N2pzbmJndjdJU2s3TG1ZS2V5ZHRDRHRqSXpzbFlYcmtKd2c2cks5N0pxdzdKZVVJT3EzdUNEc2xZanJnclRycGJ3c0lPeVZoT3VMaU91cHRDRHNvSkhya1pEc2xyUXI3SnVRNjZ5NDdKMkVJT3V6dE91Q3VPdUxwQXBtZFc1amRHbHZiaUJtY21sbGJtUnNlVVZ5Y205eUtHVXNJSEJ5WldacGVDa2dld29nSUdsbUlDaGxJQ1ltSUdVdWJXVnpjMkZuWlNBOVBUMGdURTlIU1U1ZlIxVkpSRVVwSUhKbGRIVnliaUI3SUdWeWNtOXlPaUJNVDBkSlRsOUhWVWxFUlN3Z2NISnZZbXhsYlRvZ0oyTnNZWFZrWlMxc2IyZHZkWFFuSUgwN0NpQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjJOc1lYVmtaUzF0YVhOemFXNW5KeWtnZXdvZ0lDQWdjbVYwZFhKdUlIc2daWEp5YjNJNklDZnNuYlFnVUVQc2w1QWdRMnhoZFdSbElFTnZaR1VvWTJ4aGRXUmxLZXF3Z0NEc2hLVHN1Wmpyajd3ZzdKNkk3S2VBSU95Vml1eVZoT3lhbENEaWdKUWc3SVNrN0xtWTdaV1k2ck9nSU91aG5PcTN1T3lkdU8yVm5DRHJrcVFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Snl3Z2NISnZZbXhsYlRvZ0oyTnNZWFZrWlMxdGFYTnphVzVuSnlCOU93b2dJSDBLSUNCeVpYUjFjbTRnZXlCbGNuSnZjam9nY0hKbFptbDRJQ3NnS0dVZ0ppWWdaUzV0WlhOellXZGxJRDhnWlM1dFpYTnpZV2RsSURvZ1UzUnlhVzVuS0dVcEtTQjlPd3A5Q2dwbWRXNWpkR2x2YmlCeVpXRmtRbTlrZVNoeVpYRXBJSHNLSUNCeVpYUjFjbTRnYm1WM0lGQnliMjFwYzJVb0tISmxjMjlzZG1VcElEMCtJSHNLSUNBZ0lHeGxkQ0JpYjJSNUlEMGdKeWM3Q2lBZ0lDQnlaWEV1YjI0b0oyUmhkR0VuTENBb1l5a2dQVDRnZXlCaWIyUjVJQ3M5SUdNN0lIMHBPd29nSUNBZ2NtVnhMbTl1S0NkbGJtUW5MQ0FvS1NBOVBpQjdDaUFnSUNBZ0lIUnllU0I3SUhKbGMyOXNkbVVvU2xOUFRpNXdZWEp6WlNoaWIyUjVLU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJSEpsYzI5c2RtVW9lMzBwT3lCOUNpQWdJQ0I5S1RzS0lDQjlLVHNLZlFvS1kyOXVjM1FnUTA5U1UxOUlSVUZFUlZKVElEMGdld29nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MVBjbWxuYVc0bk9pQW5LaWNzQ2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVTFsZEdodlpITW5PaUFuUjBWVUxDQlFUMU5VTENCUFVGUkpUMDVUSnl3S0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0U0dWaFpHVnljeWM2SUNkRGIyNTBaVzUwTFZSNWNHVW5MQXA5T3dwbWRXNWpkR2x2YmlCcWMyOXVLSEpsY3l3Z2MzUmhkSFZ6TENCdlltb3BJSHNLSUNCeVpYTXVkM0pwZEdWSVpXRmtLSE4wWVhSMWN5d2dUMkpxWldOMExtRnpjMmxuYmloN0lDZERiMjUwWlc1MExWUjVjR1VuT2lBbllYQndiR2xqWVhScGIyNHZhbk52YmpzZ1kyaGhjbk5sZEQxMWRHWXRPQ2NnZlN3Z1EwOVNVMTlJUlVGRVJWSlRLU2s3Q2lBZ2NtVnpMbVZ1WkNoS1UwOU9Mbk4wY21sdVoybG1lU2h2WW1vcEtUc0tmUW9LWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9ZWE41Ym1NZ0tISmxjU3dnY21WektTQTlQaUI3Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFBVRlJKVDA1VEp5a2dleUJ5WlhNdWQzSnBkR1ZJWldGa0tESXdOQ3dnUTA5U1UxOUlSVUZFUlZKVEtUc2djbVYwZFhKdUlISmxjeTVsYm1Rb0tUc2dmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblIwVlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMmhsWVd4MGFDY3BJSHNLSUNBZ0lISmxkSEo1UVhWMGFFbG1UbVZsWkdWa0tDazdJQzh2SU91aG5PcTN1T3lkdUNEdGxZVHNtcFFnN0lPQjdZT2M2Nm0wSU95ZXJPMlpsZXlkdUNEc2k1enJqNFFnNG9DVUlPeWVyT3Vobk9xM3VPeWR1T3lkdENEcmdaM3JncXpzbkx6cnFiUWc2NHVrN0oyTUlPeWhzTzJhak91MmdPMkVzQ0J3Y205aWJHVnQ3SjIwSU8yU2dPdW1zT3VMcEFvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzS0lDQWdJQ0FnYjJzNklIUnlkV1VzSUdWdVoybHVaVG9nSjJOc1lYVmtaU2NzSUhZNklFSlNTVVJIUlY5V0xDQmthWEk2SUY5ZlpHbHlibUZ0WlN3Z0x5OGdkc0szWkdseU9pRHF0YXpyc29Uc29JUXY3SmVKNjVxeDdaV2NJT3lDck91enVPeWR0Q0RybHFBZzdKNkk2NHFVN0tlQUlPeW5oT3VMcU95YXFRb2dJQ0FnSUNCdGIyUmxiRG9nWTNWeWNtVnVkRTF2WkdWc0xDQnRiMlJsYkhNNklFRk1URTlYUlVSZlRVOUVSVXhUTENCbGVHRnRjR3hsY3pvZ1JWaEJUVkJNUlZNdWJHVnVaM1JvTENCbmRXbGtaVG9nUjFWSlJFVXViR1Z1WjNSb0xDQnlaV0ZrZVRvZ2QyRnliV1ZrVlhBc0NpQWdJQ0FnSUhCeWIySnNaVzA2SUNoamJHRjFaR1ZUZEdGMGRYTWdQVDA5SUNkdmF5Y2dmSHdnWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0J1ZFd4c0tTQS9JRzUxYkd3Z09pQmpiR0YxWkdWVGRHRjBkWE1zQ2lBZ0lDQWdJR0ZqWTI5MWJuUTZJR05zWVhWa1pVRmpZMjkxYm5Rb0tTd0tJQ0FnSUNBZ2MyVnlkbVZrT2lCemRHRjBjeTV6WlhKMlpXUXNJR3hoYzNSQmREb2djM1JoZEhNdWJHRnpkRUYwTENCc1lYTjBWR1Y0ZERvZ2MzUmhkSE11YkdGemRGUmxlSFFzSUd4aGMzUlRaV002SUhOMFlYUnpMbXhoYzNSVFpXTXNDaUFnSUNCOUtUc0tJQ0I5Q2lBZ0x5OGc3WlNNNjUrczZyZTQ3SjI0SU95THJPeWVwZXV3bGV1UG1TRGlnSlFnNjRHSzZyaXc2Nm0wSU95Y2hDRHFzSkRzaTV3ZzdZT0E3SjIwNjZpNDZyQ0FJT3VMcE91bXJPdWx2Q0RyZ1lqcmk2UUtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoY25SaVpXRjBKeWtnZXdvZ0lDQWdiR0Z6ZEVKbFlYUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdDaUFnZlFvZ0lDOHZJT3Vobk9xM3VPeWR1Q0RpZ0pRZzdaU002NStzNnJlNDdKMjQ3SjJZSUZ2d241K2dJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNuYmdnN1pXRTdKcVVYY0szVy9DZmxKRmRJT3V5aE8yS3ZPeWR0Q0R0bUxqc3RwenRsWnpyaTZRdUNpQWdMeThnNnJpdzY3TzRLT3U0ak91ZHZPeWFzT3lnZ0NEc3A0SHRsb2twT2lCZ1kyeGhkV1JsSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFXRHJwYndnN0lpbzdKMkFJTzJVaE91aG5PeUV1T3lLcE91aG5DRHNpNlR0bG9rZzRvQ1VJT3VwbE91SnRDRHNsNGJzbmJRZzZyT243SjZsSU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUcXM2QXNDaUFnTHk4Z0lDQnNiMk5oYkdodmMzUWc3SWlZN0l1Z0lPMlByTzJLdU91aG5DRHFzckRxczd6cnBid2c3SjZRNjQrWklPeUltT3VndWUyVm5PdUxwQ2pzaTZUc3VLRTZJTzJYcE91VG5PdW1yT3lLcE95WGtPeUVuT3VQaENEcnVJenJuYnpzbXJEc29JQWc3SmUwNjZhOElDc2dURWxUVkVWT0lPMlpsZXlkdUN3Z01qQXlOaTB3TnlrdUNpQWdMeThnSUNEdGhMRHJyN2pyaEpEc25iUWc3Wm1VNjZtMDdKZVFJT3lnaE8yWWdDRHNsWWdnNjV5czY0dWtMaURydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNDY2ZU1JTzJWbU91cHRDRHJnWjB1Q2lBZ0x5OGc3WSswNjdDeEtPMkVzT3V2dU91RWtDazZJT3lla091UG1TRHNtWVRybzR6cXNJQWc2NmVKN1o2TUlPMlptT3F5dlNqcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wN0plUUlPdXF1eURyaTcvc2xZUWc3TDJVNjVPYzZyQ0FJT3V6dE95ZHRPdUtsQ0Rxc3Izc21yQXA3SmVRN0lTY0NpQWdMeThnSUNEcm9aenF0N2pzbmJnZzY0eUE2cml3SU95a2tTRHJzb1R0aXJ6c25ZUWc2NWlRSU91SWhPdWx0T3VwdEN3ZzdMMlU2NU9jNjZXOElPdTJtZXlYck91RW8reWRoQ0RzaUpnZzdKNkk2NHFVSU8yRXNPdXZ1T3VFa0NEcnNLbnNpNTNzbkx6cm9ad2c3S0NFN1ptWTdaV2M2NHVrTGdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5dmNHVnVMV3h2WjJsdUp5a2dld29nSUNBZ1kyOXVjM1FnWW05a2VTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQmpiMjV6ZENCemQybDBZMmhOYjJSbElEMGdJU0VvWW05a2VTQW1KaUJpYjJSNUxuTjNhWFJqYUVGalkyOTFiblFwT3lBdkx5RHFzNFRzb0pVZzdLQ0U3Wm1ZSUQwZzdJdWM3WUdzNjZhL0lPeXd2ZXljdk91aG5DRHNsN1RzbHJRZzZyT0U3S0NWN0oyRUlPcXpvT3VsdkNEc2lKZ2c3SjZJNnJLTUNpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNBdkx5QmpiR0YxWkdYcXNJQWc3SmVHN0p5ODY2bTBJT3lYck9xNHNPeUVuQ0RyZ1lycmlwVHJpNlF1SUhOb1pXeHNPblJ5ZFdYcm5id2dZMnhoZFdSbDZyQ0FJT3lYaHV5V3RPdVBoQ0RzaGJqc25ZQWc3S0NWN0lPQklPeUxwTzJXaWV1UHZBb2dJQ0FnSUNBdkx5QnpjR0YzYnV5ZG1DQW5aWEp5YjNJbjZyQ0FJT3lWaUNEcm5LanFzNkFzSU95WWlPeWdoT3lYbENEcXQ3anJqSURyb1p3Z2IyczZkSEoxWmV1bHZDRHJqNHpyb0tUc3BLenJpNlFnNG9DVUNpQWdJQ0FnSUM4dklPMlVqT3Vmck9xM3VPeWR1T3lkZ0NBaTY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95WHRPeVhpT3lXdE95YWxDTHJuYnpxczZBZzdaV1k2NHFVNjQyd0lPeUxwT3lnbk91aG5PdUtsQ0RzbFlUcnJMVHFzb1ByajRRZzdKV0lJT3VjcU91S2xDRHNnNEh0ZzV6cXNJQWc2NUNRNjR1a0tPeUxwT3lnbkNEc2k2RHFzNkFwTGdvZ0lDQWdJQ0JwWmlBb1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBblkyeGhkV1JsTFcxcGMzTnBibWNuS1NCN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ERXNJSHNLSUNBZ0lDQWdJQ0FnSUdWeWNtOXlPaUFuN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lYaHV5V3RPeWFsQ0RpZ0pRZzdZU3c2Nis0NjRTUTdKZVE3SVNjSUdOc1lYVmtaU0F0TFhabGNuTnBiMjRnN0oyMElPdVFtT3VLbE95bmdDRHRtWlhzbmJqdGxiUWc3S084N0lTNDdKcVVMaWNzQ2lBZ0lDQWdJQ0FnSUNCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuTEFvZ0lDQWdJQ0FnSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUM4dklPeW5oTzJXaVNEc3BKSHNuYmpyamJBZzY1aVFJT3VJak91Z2dPdUxwQ0RpZ0pRZzZyaUk2N0NwS0RZdzdMU0lJT3VDdENrZzY0dWs3SXVjSU91SWhPdWx1Q0Rxc2JRZ0l1eXd2ZXlkaENEcmk2dnNsWmpyaTZRdjY2cTdJT3UwcE91THBDTHNsNUFnNnJDQTZybU03SnF3NjYrQTY2R2NJT3U0ak91ZHZPeWFzT3lnZ091aG5DRHNucXpzaTV6cmo0VHRsWnpyaTZRdUNpQWdJQ0FnSUM4dklPMlZuT3l3dUNEcmtxVHNsNURyajRRZzY1aVFJT3VJaE91bHRPdUtsQ0Rxc2JRZzY3aU02NTI4N0pxdzdLQ0E2ckNBSUd4dlkyRnNhRzl6ZENEc3ZaenJzTEhzbDVBZzY2cTdJT3VMdit5VmhDRHNucERyajVrZzdKbUU2Nk9NNnJDQUlPeVZpQ0Rya0pqcmlwUWc3Wm1ZNnJLOTdKMjhJT3lJbUNEc25vanNuTHpyaTRnS0lDQWdJQ0FnTHk4ZzZyZTQ2NVdNNjZlTUlPeTlsT3VUbk91bHZDRHJ0cG5zbDZ6cmhLUHNuWVFnN0lpWUlPeWVpT3VLbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJTzJQdE91d3NlMlZuT3VMcENBbzY1R1FJT3V5aU95bnVDRHRnYlRycHEzc2w1QWc3WVN3NjYrNDY0U1E3SjIwSU8yS2dPeVd0T3VDbU95WXBPdXB0Q0RyaTdudG1hbnNpcVRybjczcmk2UXBMZ29nSUNBZ0lDQmpiMjV6ZENCemRHRnNaU0E5SUd4dloybHVVSEp2WXlBbUppQW9SR0YwWlM1dWIzY29LU0F0SUd4dloybHVVM1JoY25SbFpFRjBJRDRnTmpBd01EQXBPd29nSUNBZ0lDQnBaaUFvYkc5bmFXNVFjbTlqSUNZbUlITjBZV3hsS1NCN0NpQWdJQ0FnSUNBZ2EybHNiRXh2WjJsdVVISnZZeWdwT3dvZ0lDQWdJQ0FnSUdsbUlDZ2hiM0JsYmt4dloybHVWR1Z5YldsdVlXd29LU2tnZXdvZ0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ERXNJSHNnWlhKeWIzSTZJQ2ZzbmJRZ1QxUHNsNURzaEtBZzdKNlE2NCtaN0p5ODY2R2NJT3VxdXlEc2w3VHNsclRzbXBRZzRvQ1VJTzJFc091dnVPdUVrT3lYa095RW5DQmpiR0YxWkdVZzdJdWs3WmFKSU8yYmhDQXZiRzluYVc0ZzdaVzBJT3lqdk95RXVPeWFsQzRuSUgwcE93b2dJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3Q2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHRqN1Ryc0xFZzRvQ1VJTzJFc091dnVPdUVrQ0Ryc0tuc2k1M3NuTHpyb1p3ZzdLQ0U3Wm1ZTGljcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCdGIyUmxPaUFuZEdWeWJXbHVZV3duSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNnTHk4ZzdKV2U3SVNnSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianNuYlFnNjR5QTZyaXdJT3lra2V5ZHRPdXB0Q0Rzb0pIcXM2QWc3SU9JNjZHY0lPeVhzT3VMcENBbzdMQzk3SjJFSU91THEreVZtT3F4c091Q21DRHJpNlRzaTV3ZzY0aUU2Nlc0SU9xeXZleWFzQ2tLSUNBZ0lDQWdiRzluYVc1VGRHRnlkR1ZrUVhRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ0lDQXZMeUJDVWs5WFUwVlM2Nlc4SU95YXNPdW1yQ0R0bGJqcms2VHJuNnpyb1p3ZzdLZUE3S0NWSU9LQWxDQkRURW5xc0lBZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95bmdleWdrU0RzbDdUc3A0QWc3SldLNnJPZ0lGVlNUT3VuakNEcmhKanFzcWpzcElEcmk2UXVDaUFnSUNBZ0lDOHZJTzJWdU91VHBPdWZyT3F3Z0NEc2k2VHRqS2p0bFpqcXNiRHJncGdnUTB4SjZyQ0FJRUpTVDFkVFJWTHJwYndnNjZ5MDdJdWM3WlcwNjQrRUlFTk1TZXF3Z0NEc2xZenNsWVRzaEp3ZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUcnI0RHJvWndnNjZHYzZyZTQ3SjI0N0oyQUlPdVFuT3VMcENobVlXbHNMWE52Wm5RcExnb2dJQ0FnSUNCamIyNXpkQ0JzYjJkcGJrVnVkaUE5SUU5aWFtVmpkQzVoYzNOcFoyNG9lMzBzSUVOTVFWVkVSVjlGVGxZc0lIc2dRbEpQVjFORlVqb2dkM0pwZEdWQ2NtOTNjMlZ5U0dGdVpHeGxjaWh6ZDJsMFkyaE5iMlJsSUQ4Z0ozTjNhWFJqYUNjZ09pQW5ibTl5YldGc0p5a2dmU2s3Q2lBZ0lDQWdJR052Ym5OMElIUm9hWE5NYjJkcGJpQTlJSE53WVhkdUtDZGpiR0YxWkdVbkxDQmJKMkYxZEdnbkxDQW5iRzluYVc0bkxDQW5MUzFqYkdGMVpHVmhhU2RkTENCN0NpQWdJQ0FnSUNBZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ2JHOW5hVzVGYm5Zc0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2QybHVaRzkzYzBocFpHVTZJSFJ5ZFdVc0NpQWdJQ0FnSUNBZ1pHVjBZV05vWldRNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ0lUMDlJQ2QzYVc0ek1pY3NJQzh2SUd0cGJHeE1iMmRwYmxCeWIyUHNuWmdnNnJlNDY2TzVJR3RwYkd6c21xa2dLR3RwYkd4UWNtOWo2ck84SU91UG1leWR2Q0R0aktqdGhMUXBDaUFnSUNBZ0lIMHBPd29nSUNBZ0lDQnNiMmRwYmxCeWIyTWdQU0IwYUdselRHOW5hVzQ3Q2lBZ0lDQWdJSFJvYVhOTWIyZHBiaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdsbUlDaHNiMmRwYmxCeWIyTWdQVDA5SUhSb2FYTk1iMmRwYmlrZ2JHOW5hVzVRY205aklEMGdiblZzYkRzZ2ZTazdDaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdJVDA5SUhSb2FYTk1iMmRwYmlrZ2NtVjBkWEp1T3dvZ0lDQWdJQ0FnSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnYVdZZ0tHeHZaMmx1VUhKdlkxUnBiV1Z5S1NCN0lHTnNaV0Z5VkdsdFpXOTFkQ2hzYjJkcGJsQnliMk5VYVcxbGNpazdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdiblZzYkRzZ2ZRb2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQzh2SU95RGlDRHFzNFRzb0pYc25id2c3SWlZSU95ZWlPeWN2T3VMaUNEcmk2VHNuWXdnTDJobFlXeDBhQ0RybFl3ZzY0dWs3SXVjSU95ZHZlcTRzQW9nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJT3lnaU95d3FDRHNvb1hybzR3Z0tHTnZaR1VnSnlBcklHTnZaR1VnS3lBbktTY3BPd29nSUNBZ0lDQWdJQzh2SU95Q3JPdWVqT3lkdENEcm9aenF0N2pzbmJqdGxhQWc3SXVjNnJDRTY0K0VJT3lYaHV5ZHRDRHFzNmZyc0pUcm9ad2c3SXVrN1l5bzY2R2NJT3VCbmV1Q3JPdUxwQ0E5SUdOc1lYVmtaZXF3Z0NEc2w0YnFzYkRyZ3BnZzdJdWs3WmFKN0oyMElPeVZpQ0Rya0p3ZzZyS0RMZ29nSUNBZ0lDQWdJQzh2SU95ZGtldUx0ZXlkZ0NEc25iVHJyN2dnNjdPMDY0T0k3Snk4NjR1SUlPeURnZTJEbk91bHZDRHJpNlRzaTV3ZzdKNnM3SVNjSUM5b1pXRnNkR2pyb1p3ZzdKV002NmF3NjR1a0lDanRsSXpybjZ6cXQ3anNuYmpzbmJRZzY0eUE2cml3SU8yWmxPdXB0T3lkaENEc2k2VHRqS2pyb1p3ZzY3Q1U2cjY4NjR1a0tTNEtJQ0FnSUNBZ0lDQnBaaUFvWTI5a1pTQWhQVDBnTUNBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQQ0ExTURBd0tTQjdDaUFnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNDdKMjBJT3ltaWV5TG5DRHNpNlR0aktqcm9ad2c2NEdkNjRLb0lPS0FsQ0JEYkdGMVpHVWdRMjlrWlNEc2hLVHN1WmdnN0lPQjdZT2M2Nlc4SU91THBPeUxuQ0Rzb0pEcXNvRHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJQ0FnSUNCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BPd29nSUNBZ0lDQWdJSDBLSUNBZ0lDQWdmU2s3Q2lBZ0lDQWdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJnZ01URHJ0b1FnNnJLOTZyTzhJT0tBbENEcmpJRHF1TEFnN1pTRTY2R2M3SVM0N0lxa0lPeWdsZXVtckM0bktUc2dhMmxzYkV4dloybHVVSEp2WXlncE95QjlMQ0EyTURBd01EQXBPd29nSUNBZ0lDQXZMeURyZ3FIc25ZQWc3SjZGN0o2bDZyYU03SjJFSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NHlBNnJpd0lPeUV1T3lGbU95ZGdDRHJzb1RycHJEcmk2UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzZzRnZzdJUzQ3SVdZS095RGlDRHNub1hzbnFYcXRvd3A3Snk4NjZHY0lPeUxuT3lla2UyVm1PcXlqQW9nSUNBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFbklDc2dLSE4zYVhSamFFMXZaR1VnUHlBbklDanFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDRHNpNXp0Z2F6cnByOGc3TEM5S1NjZ09pQW5KeWtnS3lBbklPS0FsQ0Ryb1p6cXQ3anNuYmp0bFpqcnFiUWc3SjZRNjQrWklPeVhzT3F5c091UXFldUxpT3VMcEM0bktUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUcxdlpHVTZJSE4zYVhSamFFMXZaR1VnUHlBblluSnZkM05sY2kxemQybDBZMmduSURvZ0oySnliM2R6WlhJbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNQ3dnZXlCbGNuSnZjam9nSit1aG5PcTN1T3lkdUNEc3NMM3NuWVFnNjZxN0lPeVh0T3lYaU95V3RPeWFsRG9nSnlBcklHVXViV1Z6YzJGblpTQjlLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGdLTzJFc091dnVPdUVrQ0R0ajdUcnNMRWc2cldzN1ppRTY3YUFJT0tBbENEcnVJenJuYnpzbXJEc29JQWc3SjZRNjQrWklPeVpoT3Vqak9xd2dDRHNsWWdnNjVDWTY0cVVJTzJabU9xeXZTRHNvSVRzbXFrcENpQWdablZ1WTNScGIyNGdiM0JsYmt4dloybHVWR1Z5YldsdVlXd29LU0I3Q2lBZ0lDQjdDaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUNBZ0x5OGdjM1JoY25UcXNJQWc3SU9JSU95OW1PeUdsQ0Rzc0wzc25ZUWc2NmVNNjVPZzY0dWtJQ2pyaTZUcnBxenNuWmdnN0lpbzdKMkFJT3k5bU95R2xPcXp2Q0RyckxUcXRJRHRsWmpxc293ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU91enRPeWVoQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdKMjA3SmEwN0lTY0lGQnZkMlZ5VTJobGJHd29MbkJ6TVNuc25iUWdOZXkwaUNEcmtxUWc2cmU0SU95d3ZleVhrQ0RzbDVUdGhMRHJwYndnNjdPMDY0SzBJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbllRZzdKNlE2NCtaSU95RW9PMkRuZTJWbU9xem9Dd0tJQ0FnSUNBZ0lDQXZMeURzc0wzc25ZUWc3TFdjN0lhTTdabVU3WlcwSU95Q3JPeWFxZXlla0NEcmlJanNsNVFnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVPdW5qQ0RyZ3FqcXNvd2c3WldjNjR1a0xpRHNzTDNzbllRZzY2cTdJT3l3dnV5Y3ZPdXB0Q0RzbFlUcnJMVHFzb1ByajRRZzdKV0lJTzJWbk91THBBb2dJQ0FnSUNBZ0lDOHZJQ2pyaTZUcnBiZ2c3TEM5SU95WXBPeWVoZXVncFNEcnNLbnNwNEFnNG9DVUlPcTN1Q0Rxc3Izc21yQWc2Nm1VNjRtMDZyQ0FJT3V6dE95ZHRPdUtsQ0Rzc1lUcm9ad2c2NEtvNnJPZ0lPeUNyT3lhcWV5ZWtPcXdnQ0RzbDVUdGhMQWc3WldjSU91eWlDRHJpSVRycGJUcnFiUWc2NUNvS1M0S0lDQWdJQ0FnSUNBdkx5RHNvN3pzblpnNklHTnNZWFZrWmVxd2dDRHN2WmpzaHBRZzdLQ2M2NnFwN0oyRUlPdXdsT3ErdU91cHRDQkJjSEJCWTNScGRtRjBaUzlHYVc1a1YybHVaRzkzNnJDQUlPdXF1eURzc0w3c25ZUWc3SWlZSU95ZWlPeWRqQ0RpZ0pRZzdKeUk2NCtFN0pxd0lPeUxwT3E0c095WGtPeUVuQ0R0bVpYc25iZ2c3WldFN0pxVUxnb2dJQ0FnSUNBZ0lHTnZibk4wSUhCek1TQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ykc5bmFXNHVjSE14SnlrN0NpQWdJQ0FnSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXlod2N6RXNJRnNLSUNBZ0lDQWdJQ0FnSUNkVGRHRnlkQzFUYkdWbGNDQXRVMlZqYjI1a2N5QTFKeXdLSUNBZ0lDQWdJQ0FnSUNja2QzTWdQU0JPWlhjdFQySnFaV04wSUMxRGIyMVBZbXBsWTNRZ1YxTmpjbWx3ZEM1VGFHVnNiQ2NzQ2lBZ0lDQWdJQ0FnSUNBaWFXWWdLQ1IzY3k1QmNIQkJZM1JwZG1GMFpTZ25ZMnhoZFdSbExXeHZaMmx1SnlrcElIc2lMQW9nSUNBZ0lDQWdJQ0FnSWlBZ0pIZHpMbE5sYm1STFpYbHpLQ2QrSnlraUxBb2dJQ0FnSUNBZ0lDQWdKeUFnVTNSaGNuUXRVMnhsWlhBZ0xWTmxZMjl1WkhNZ01pY3NDaUFnSUNBZ0lDQWdJQ0FpSUNCQlpHUXRWSGx3WlNBdFRtRnRaWE53WVdObElGVWdMVTVoYldVZ1Z5QXRUV1Z0WW1WeVJHVm1hVzVwZEdsdmJpQW5XMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUZONWMzUmxiUzVKYm5SUWRISWdSbWx1WkZkcGJtUnZkeWh6ZEhKcGJtY2dZeXdnYzNSeWFXNW5JSFFwT3lCYlJHeHNTVzF3YjNKMEtGd2lkWE5sY2pNeUxtUnNiRndpS1YwZ2NIVmliR2xqSUhOMFlYUnBZeUJsZUhSbGNtNGdZbTl2YkNCVGFHOTNWMmx1Wkc5M0tGTjVjM1JsYlM1SmJuUlFkSElnYUN3Z2FXNTBJRzRwT3ljaUxBb2dJQ0FnSUNBZ0lDQWdJaUFnSkdnZ1BTQmJWUzVYWFRvNlJtbHVaRmRwYm1SdmR5aGJUblZzYkZOMGNtbHVaMTA2T2xaaGJIVmxMQ0FuWTJ4aGRXUmxMV3h2WjJsdUp5a2lMQW9nSUNBZ0lDQWdJQ0FnSnlBZ2FXWWdLQ1JvSUMxdVpTQmJVM2x6ZEdWdExrbHVkRkIwY2wwNk9scGxjbThwSUhzZ1czWnZhV1JkVzFVdVYxMDZPbE5vYjNkWGFXNWtiM2NvSkdnc0lEWXBJSDBuTENBdkx5QTJJRDBnVTFkZlRVbE9TVTFKV2tVS0lDQWdJQ0FnSUNBZ0lDZDlKeXdLSUNBZ0lDQWdJQ0JkTG1wdmFXNG9KMXh5WEc0bktTQXJJQ2RjY2x4dUp5azdDaUFnSUNBZ0lDQWdZMjl1YzNRZ1ltRjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxc2IyZHBiaTVpWVhRbktUc0tJQ0FnSUNBZ0lDQm1jeTUzY21sMFpVWnBiR1ZUZVc1aktHSmhkQ3dnSjBCbFkyaHZJRzltWmx4eVhHNG5JQ3NLSUNBZ0lDQWdJQ0FnSUNkemRHRnlkQ0FpWTJ4aGRXUmxMV3h2WjJsdUlpQmpiV1FnTDJzZ1kyeGhkV1JsSUM5c2IyZHBibHh5WEc0bklDc0tJQ0FnSUNBZ0lDQWdJQ2R3YjNkbGNuTm9aV3hzSUMxT2IxQnliMlpwYkdVZ0xVVjRaV04xZEdsdmJsQnZiR2xqZVNCQ2VYQmhjM01nTFVacGJHVWdJaWNnS3lCd2N6RWdLeUFuSWx4eVhHNG5LVHNLSUNBZ0lDQWdJQ0J6Y0dGM2JpZ25ZMjFrSnl3Z1d5Y3ZZeWNzSUdKaGRGMHNJSHNnWlc1Mk9pQkRURUZWUkVWZlJVNVdMQ0J6ZEdScGJ6b2dKMmxuYm05eVpTY3NJSGRwYm1SdmQzTklhV1JsT2lCMGNuVmxJSDBwT3dvZ0lDQWdJQ0I5SUdWc2MyVWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZGtZWEozYVc0bktTQjdDaUFnSUNBZ0lDQWdMeThnY0hSNUtHVjRjR1ZqZENucm9ad2c2N08wNjRLNElPMkNwT3lYa0NEdGdiVHJvWnpyazV3Z1ZGVko2ckNBSU91c3RPdXdtT3lka2V5ZHVDRHFzb1BzbmJRZzdJdWs3TGloSU8yWmxleWR1T3VRcUNneU1ESTJMVEEzTENEc25ienJzSmdnWEhMQ3QydHBkSFI1SU95OWxPdVRuQ0RycXFqcmtaQXBJT0tBbEFvZ0lDQWdJQ0FnSUM4dklPeWNvT3lkdk8yVm5DRHNucERyajVudG1aUWc2cks5NjZHYzY0cVVJRk41YzNSbGJTQkZkbVZ1ZEhQc25aZ2c3S2VFN0tlY0lPMkNwQ0Rzbm9Ycm9LVXVJT3lna2VxM3ZPeUVzU0RxdG96dGxaenNuYlFnN0o2STdKeTg2Nm0wSURic3RJZ2c2NUtrSU95WGxPMkVzT3F3Z0NEc25wRHJqNWtnN0o2RjY2Q2w2NCs4Q2lBZ0lDQWdJQ0FnTHk4Z01ldXlpQ2pxdGF6cmo0VWc2ck9FN0tDVktleWR0Q0RzaEtEdGc1M3JrSmpxczZBc0lPcTJqTzJWbk95ZHRDRHNsNGJzbkx6cnFiUWdhMlY1YzNSeWIydGxJT3lraE91bmpDRHNvYkRzbXFudG5vZ2c3SXVrN1l5bzdaVzBJT3lDck95YXFleWVrT3F3Z0NEc2w1VHRoTEFnN1pXY0lPdXlpQ0RyaUlUcnBiVHJxYlFnNjVDYzY0dWtLR1poYVd3dGMyOW1kQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdKZVU3WVN3SU95bmdleWdoT3lYa0NCVVpYSnRhVzVoYk95ZGhDRHJpNlRzaTV3ZzdKV2U3Snk4NjZHY0lPcXdnT3lndU95WmdDRHJpNlRycGJnZzdKV3g3SmVRSU8yQ3BPcXdnQ0RyazZUc2xyVHFzSURyaXBRZzZyS0Q3SjJFSU91bmlldUtsT3VMcEM0S0lDQWdJQ0FnSUNCemNHRjNiaWduYjNOaGMyTnlhWEIwSnl3Z1d3b2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJrYnlCelkzSnBjSFFnSW1Oc1lYVmtaU0F2Ykc5bmFXNGlKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWhiQ0lnZEc4Z1lXTjBhWFpoZEdVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURZbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJoWTNScGRtRjBaU2NzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuWkdWc1lYa2dNQzR6Snl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVGVYTjBaVzBnUlhabGJuUnpJaUIwYnlCclpYbHpkSEp2YTJVZ2NtVjBkWEp1Snl3S0lDQWdJQ0FnSUNBZ0lDOHZJT3lYbE8yRXNPcXdnQ0RzaTZUc29KenJvWndnNjVPazdKYTA2ckNFSU9xeXZleWFzT3lYa091bmpDRHNsNnpxdUxBZzY0K0U2NHVzS09xMmpPMlZuQ0RzbDRic25MenJxYlFnN0p5RTdKZVE3SVNjSU95a2tldUxxQ2tnNG9DVUlPMkVzT3V2dU91RWtPeWRoQ0RzdVpqc200d2c2N2lNNjUyODdKcXc3S0NBNjZlTUlPdUNxT3E0dE91THBBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURFdU5TY3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlWR1Z5YldsdVlXd2lJSFJ2SUhObGRDQnRhVzVwWVhSMWNtbDZaV1FnYjJZZ1puSnZiblFnZDJsdVpHOTNJSFJ2SUhSeWRXVW5MQW9nSUNBZ0lDQWdJRjBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE93b2dJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJtWVd4elpUc2dMeThnN0tlQTdKdVFJT3lWaUNEdGxaanJpcFFnVDFNS0lDQWdJQ0FnZlFvZ0lDQWdJQ0J5WlhSMWNtNGdkSEoxWlRzS0lDQWdJSDBLSUNCOUNpQWdMeThnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0Ryb1p6cXQ3anNsWVRzbTRNZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNEdG1ZanNuWmdnVyt1aG5PcTN1T3lWaE95YmcxMGc2N0tFN1lxODdKMjBJTzJZdU95Mm5DNGdZMnhoZFdSbElHRjFkR2dnYkc5bmIzVjA3Snk4NjZHY0lFTk1TU0Ryb1p6cXQ3anNuYmpzbllRZzdaVzA3S0NjN1pXYzY0dWtMZ29nSUM4dklDanNuYlFnVUVQc25aZ2c3S0NBN0o2bDY1Q2NJT3lla09xeXFleW1uZXVxaGV5ZGhDRHNwNERzbXJUcmk2UWc0b0NVSU91THBPeUxuQ0RzazdEcm9LVHJxYlFnN0o2czY2R2M2cmU0N0oyNElPMlZoT3lhbEM0cElPdWhuT3EzdU95VmhPeWJneUR0bTRUc2w1UWc3SVM0N0lXWXdyZnFzNFRzb0pYc3VwRHNpNXpycGJ3ZzdLQ1Y2NmFzN1pXYzY0dWtMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTlqYkdGMVpHVXRiRzluYjNWMEp5a2dld29nSUNBZ1kyOXVjM1FnYkc4Z1BTQnpjR0YzYmlnblkyeGhkV1JsSnl3Z1d5ZGhkWFJvSnl3Z0oyeHZaMjkxZENkZExDQjdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcE93b2dJQ0FnYkdWMElHVnljaUE5SUNjbk93b2dJQ0FnYkc4dWMzUmtaWEp5TG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzZ1pYSnlJQ3M5SUdRdWRHOVRkSEpwYm1jb0tUc2dmU2s3Q2lBZ0lDQnNieTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXlCcWMyOXVLSEpsY3l3Z05UQXdMQ0I3SUc5ck9pQm1ZV3h6WlN3Z1pYSnliM0k2SUNmcm9aenF0N2pzbFlUc200TWc3SXVrN1phSklPeUxwTzJNcURvZ0p5QXJJR1V1YldWemMyRm5aU0I5S1RzZ2ZTazdDaUFnSUNCc2J5NXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdJQ0JyYVd4c1VISnZZeWdwT3lBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnTHk4ZzY2R2M2cmU0N0pXRTdKdUQ2NUNjSU9xemhPeWdsZXlkaENEcnJMenJqWmdnNjR5QTZyaXdJT3lFdU95Rm1PeWRoQ0Ryc29UcnByRHJpNlFLSUNBZ0lDQWdZV05qYjNWdWRFTmhZMmhsTG1GMElEMGdNRHNnSUNBZ0lDQWdJQzh2SU91THBPeWRqQ0F2WVdOamIzVnVkTUszTDJobFlXeDBhT3lYa095RW5DRHFzNFRzb0pYc25ZUWc3SU9JNjZHY0tEM3NsNGJzbll6c25MenJvWndwSU95ZHZlcXlqQW9nSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNCdWRXeHNPeUFnSUNBZ0lDQWdMeThnN0lPQjdZT2NJT3llck8yTWtPeWdsU2pyaTZUc25Zd2c3WVMwN0plUTdJU2NJT3V2dU91aG5PcTN1T3lkdUNEcXNKRHNwNEFwQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0pXRTdKdURJQ2hqYjJSbElDY2dLeUJqYjJSbElDc2dKeWtuS1RzS0lDQWdJQ0FnYVdZZ0tISmxjeTVvWldGa1pYSnpVMlZ1ZENrZ2NtVjBkWEp1T3lBdkx5Qmxjbkp2Y2lEdGxianJrNlRybjZ6cXNJQWc3SjIwNjYrNElPeWRrZXVMdGUyV2lPeWN2T3VwdENEc3BKSHJzN1VnNjdDcDdLZUFDaUFnSUNBZ0lHbG1JQ2hqYjJSbElEMDlQU0F3S1NCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJQ0FnSUNCbGJITmxJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2diMnM2SUdaaGJITmxMQ0JsY25KdmNqb2dLR1Z5Y2k1MGNtbHRLQ2t1YzJ4cFkyVW9NQ3dnTVRVd0tTa2dmSHdnS0Nmc29vWHJvNHdnN0wyVTY1T2NJQ2NnS3lCamIyUmxLU0I5S1RzS0lDQWdJSDBwT3dvZ0lDQWdjbVYwZFhKdU93b2dJSDBLSUNBdkx5RHNucERxdUxBZzdLS0Y2Nk9NSU9LQWxDRHRnYlRyb1p6cms1enJpNlRycHF3dDY0R0U2cml3TG1KaGRPeWR0Q0R0bUxqc3RwenRsWnpyaTZRZ0tPdWhuT3k3ck95WGtPeUVuT3VuakNEc29KSHF0N3dnNnJDQTY0cWw3WldZNjR1SUlPeVZpT3lnaENrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmMyaDFkR1J2ZDI0bktTQjdDaUFnSUNCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWloZXVqakNEc21wVHNzcTBnNjdDYjdKMk1JT0tBbENEcmk2VHJwcXpycGJ3ZzY0R1Y2NHVJNjR1a0xpY3BPd29nSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBMQ0F5TURBcE93b2dJQ0FnY21WMGRYSnVPd29nSUgwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0p5a2dld29nSUNBZ1kyOXVjM1FnZXlCMFpYaDBMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmc3RwVHNzcHpyc0p2c25ZUWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95MmxPeXluQ0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNzSUcxdlpHVnNJRDhnSnlqcnFxanJqYmc2SUNjZ0t5QnRiMlJsYkNBcklDY3BKeUE2SUNjbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhKaGR5QTlJR0YzWVdsMElHRnphME5zWVhWa1pTaFRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BMQ0J0YjJSbGJDazdDaUFnSUNBZ0lHTnZibk4wSUhOMVoyZGxjM1JwYjI1eklEMGdjR0Z5YzJWVGRXZG5aWE4wYVc5dWN5aHlZWGNwT3dvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBb0tFUmhkR1V1Ym05M0tDa2dMU0J6ZEdGeWRHVmtLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2s3Q2lBZ0lDQWdJR2xtSUNnaGMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0tTQjdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTWpPeUxzU0RzaTZUdGpLZ2dLQ2NnS3lCelpXTWdLeUFuY3lrNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTWpBd0tTazdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKV0lJQ2NnS3lCemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3Q2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z016QXBPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCemRXZG5aWE4wYVc5dWN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFZzRvQ1VJT3lEZ2UyWnFleWRoQ0RzaEtUcnFvWHRsWmpycWJRZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RPeWtnT3VMcENBbzdMYVU3TEtjNnJPOElPcXdtZXlkZ0NEc2hManNoWmdzSU91TWdPMlpsT3VLbENEcnA2UWc3SnFVN0xLdDdKZVFJTzJHdGV5bnVPdWhuQ0RzaTZUcnByd3BDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMk52YlhCdmMyVW5LU0I3Q2lBZ0lDQmpiMjV6ZENCN0lHMWxjM05oWjJWekxDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHTnZibk4wSUd4cGMzUWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHMWxjM05oWjJWektTQS9JRzFsYzNOaFoyVnpMbVpwYkhSbGNpZ29iU2tnUFQ0Z2JTQW1KaUJUZEhKcGJtY29iUzUwWlhoMElIeDhJQ2NuS1M1MGNtbHRLQ2twSURvZ1cxMDdDaUFnSUNCcFppQW9JV3hwYzNRdWJHVnVaM1JvS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKK3VNZ08yWmxDRHJnclRzbXFuc25iUWc2N21FN0phMElPeWVpT3lLdGV1TGlPdUxwQzRuSUgwcE93b2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6ZENCc1lYTjBWWE5sY2lBOUlGc3VMaTVzYVhOMFhTNXlaWFpsY25ObEtDa3VabWx1WkNnb2JTa2dQVDRnYlM1eWIyeGxJQ0U5UFNBbllYTnphWE4wWVc1MEp5azdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3S0NjN0o2UklPdU1nTzJabENEc21wVHNzcTA2Snl3Z1UzUnlhVzVuS0Noc1lYTjBWWE5sY2lBbUppQnNZWE4wVlhObGNpNTBaWGgwS1NCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTlRBcExuSmxjR3hoWTJVb0wxeHVMMmNzSUNjZ0p5a2dLeUFuNG9DbUlDanJqSUR0bVpRZ0p5QXJJR3hwYzNRdWJHVnVaM1JvSUNzZ0orcXduQ2tuS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSEpoZHlBOUlHRjNZV2wwSUdGemEwTnZiWEJ2YzJVb2JHbHpkQzV6YkdsalpTZ3RNVElwTENCdGIyUmxiQ2s3SUM4dklPdU1nTzJabE9xd2dDRHF1TGpzbHJUc3A0RHJxYlFnN0xXYzZyZThJREV5NnJDYzY2ZU1JQ2p0bElUcm9henRsSVR0aXJnZzdZK3Q3S084SU91d3FleW5nQ2tLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY0dGeWMyVkRiMjF3YjNObEtISmhkeWs3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGdmRYUXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU8yTWpPeUxzU0RzaTZUdGpLZ2dLQ2NnS3lCelpXTWdLeUFuY3lrNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTWpBd0tTazdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tDYzdKNlJJT3lka2V1THRTQW9KeUFySUhObFl5QXJJQ2R6TENEc29KenNsWWdnSnlBcklHOTFkQzV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dnS3lBbjZyQ2NLU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnVTNSeWFXNW5LQ2hzWVhOMFZYTmxjaUFtSmlCc1lYTjBWWE5sY2k1MFpYaDBLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNekFwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVTJWaklEMGdjMlZqT3dvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnlaWEJzZVRvZ2IzVjBMbkpsY0d4NUxDQnpkV2RuWlhOMGFXOXVjem9nYjNWMExuTjFaMmRsYzNScGIyNXpMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SjZSSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ0x5OGc2N0tJN0pldElPS0FsQ0R0bFp6cXRhM3NsclFnNG9hVUlPeVlnZXlXdENEc25wRHJqNWtnS095MmxPeXluT3F6dkNEcXNKbnNuWUFnN0lTNDdJV1lJT3lDck95YXFTa0tJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZkSEpoYm5Oc1lYUmxKeWtnZXdvZ0lDQWdZMjl1YzNRZ2V5QjBaWGgwTENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdsbUlDZ2hkR1Y0ZENCOGZDQWhVM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURBc0lIc2daWEp5YjNJNklDZnJzb2pzbDYzdGxhQWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCc1lXTmxLQzljYmk5bkxDQW5JQ2NwSUNzZ0orS0FwaWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTI5dWMzUWdjbUYzSUQwZ1lYZGhhWFFnWVhOclZISmhibk5zWVhSbEtGTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3NJRzF2WkdWc0tUc0tJQ0FnSUNBZ1kyOXVjM1FnYjNWMElEMGdjR0Z5YzJWVWNtRnVjMnhoZEdVb2NtRjNLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVc5MWRDa2dld29nSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnNvanNsNjBnN1l5TTdJdXhJT3lMcE8yTXFDQW9KeUFySUhObFl5QXJJQ2R6S1RvbkxDQlRkSEpwYm1jb2NtRjNLUzV6YkdsalpTZ3dMQ0F5TURBcEtUc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEcnNvanNsNjBnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N0tJN0pldElPeVpoT3VqakNBb0p5QXJJSE5sWXlBcklDZHpMQ0FuSUNzZ0tHOTFkQzVrYVhKbFkzUnBiMjRnZkh3Z0p6OG5LU0FySUNjcEp5azdDaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQlRkSEpwYm1jb2RHVjRkQ2t1YzJ4cFkyVW9NQ3dnTXpBcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUIwY21GdWMyeGhkR1ZrT2lCdmRYUXVkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1T2lCdmRYUXVaR2x5WldOMGFXOXVMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJT3V5aU95WHJTRHNpNlR0aktnNklDY3BLVHNLSUNBZ0lIMEtJQ0I5Q2lBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EUXNJSHNnWlhKeWIzSTZJQ2RPYjNRZ1ptOTFibVFuSUgwcE93cDlLVHNLQ2k4dklPeWR0T3V2dUNEcmk2VHJwcXpxc0lBZzY1YWdJT3llaU91S2xPdU5zQ0RybUpBZzdMeWM2cml3NnJDQUlPdVRwT3lXdE95WXBPdXB0Q2pzb0p6c2lxVHNzcGdnN0o2UTY0K1pJT3k4bk9xNHNDRHNwSkhyczdVZzY1T3hLU0Rzb2JEc21xbnRub2dnN0tLRjY2T01JT0tBbENEcmo0enJqWmdnNjR1azY2YXM2NHFVSU9xM3VPdU1nT3VobkNEc25LRHNwNEFLYzJWeWRtVnlMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUI3Q2lBZ2FXWWdLR1VnSmlZZ1pTNWpiMlJsSUQwOVBTQW5SVUZFUkZKSlRsVlRSU2NwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc25iVHJyN2dnN0x5YzdLQzRJT3llaU95V3RPeWFsQ2p0ajZ6dGlyZ2dKeUFySUZCUFVsUWdLeUFuSU95Q3JPeWFxU0RzcEpFcElPS0FsQ0RzbmJRZzdKMjQ3SXFrN1lTMDdJcWs2NHFVSU95aWhldWpqTzJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJSEJ5YjJObGMzTXVaWGhwZENnd0tUc0tJQ0I5Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFbk91eWhDRHNtS1RycFpnNkp5d2daU0FtSmlCbExtMWxjM05oWjJVcE93b2dJSEJ5YjJObGMzTXVaWGhwZENneEtUc0tmU2s3Q2k4dklPeVd0T3VXcENEcXNyM3JvWnpyb1p3ZzdLTzk2NU9nS095THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBc0lFTjBjbXdyUXl3Z0wzTm9kWFJrYjNkdUxDRHNtS1RycFpncElHTnNZWFZrWlNEc25wRHNpNTNzbllRZzY0S282cml3N0tlQUlPeVZpdXVLbE91THBBcHdjbTlqWlhOekxtOXVLQ2RsZUdsMEp5d2dLQ2tnUFQ0Z2V5QnJhV3hzVUhKdll5Z3BPeUJyYVd4c1RHOW5hVzVRY205aktDazdJSDBwT3dwd2NtOWpaWE56TG05dUtDZFRTVWRKVGxRbkxDQW9LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2twT3dwd2NtOWpaWE56TG05dUtDZFRTVWRVUlZKTkp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwS1RzS0NuTmxjblpsY2k1c2FYTjBaVzRvVUU5U1ZDd2dKekV5Tnk0d0xqQXVNU2NzSUNncElEMCtJSHNLSUNCamIyNXpiMnhsTG14dlp5Z240cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBSnlrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSnlEdGdiVHJvWnpyazV3ZzY0dWs2NmFzSU95OG5PeW5rQ0RpZ0pRZ2FIUjBjRG92TDJ4dlkyRnNhRzl6ZERvbklDc2dVRTlTVkNrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSnlEcnFxanJqYmc2SUNjZ0t5QkRURUZWUkVWZlRVOUVSVXdnS3lBbklNSzNJT3lZaU95TG5DQW5JQ3NnUlZoQlRWQk1SVk11YkdWdVozUm9JQ3NnSitxeHRDRHNucVhzc0trbktUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPeWR0Q0Rzc0wzc25ZUWc3THljNjVHVUlPdVBtZXlWaUNEdGxMenF0N2pycDRnZzdaU002NStzNnJlNDdKMjQ3SjIwSU8yQnRPdWhuT3VUbk91aG5DRHN0cFRzc3B6dGxhbnJpNGpyaTZRdUp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0orS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTm9aV05yUTJ4aGRXUmxRWFpoYVd4aFlteGxLQ2s3SUM4dklFTnNZWFZrWlNCRGIyUmxJT3lDck95YXFTRHFzSURyaXFVZzdKZXM2N2FBSU95Z2tPcXlnQ0FvN1pTTTY1K3M2cmU0N0oyNElPeVZpT3VDdE95YXFTa0tJQ0F2THlEcnI3anJwcXdnN0l1YzY0K1pJQ3NnN0tlQTdJdWM2Nnk0SU95anZPeWVoU0RpZ0pRZzdMS3JJT3kybE95eW5PdTJnTzJFc0NEcnVhRHJwYlRxc293S0lDQmhjMnREYkdGMVpHVW9KK3liak91d2pleVhoVG9nSXV5Z2dPeWVwU0Rya0pqc2w0anNpclhyaTRqcmk2UWlKeWt1ZEdobGJpZ0tJQ0FnSUNncElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc200enJzSTNzbDRVZzdKbUU2Nk9NSU9LQWxDRHN0cFRzc3B3ZzdLU0E2N21FSU91Qm5TNG5LU3dLSUNBZ0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SnVNNjdDTjdKZUZJT3lMcE8yTXFDQW83TEtySU95YWxPeXlyU0RybFl3ZzdKNnM3SXVjNjQrRUtUb25MQ0JsTG0xbGMzTmhaMlVwQ2lBZ0tUc0tmU2s3Q2c9PScKQjY0X1dBVENIRVI9J0x5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tLTHk4ZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU95Wm5DRHRsWVRzbXBUdGxaenFzSUE2SU8yVXZPcTN1T3VuaU9xd2dDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1kyeGhkV1JsWW5KcFpHZGxPaTh2SU95WHRPcTRzQ2gzYVc1a2IzY3ViM0JsYmk5cFpuSmhiV1V2YjNCbGJrVjRkR1Z5Ym1Gc0tldWx2QW92THlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293S0x5OGdVRTlUVkNBdmQyRnJaU0RycGJ3ZzY3TzA2NEswNjZtMElPcXdrT3lMbk95ZWtPcXdnQ0RyaTZUcnBxd29ZMnhoZFdSbExXSnlhV1JuWlM1cWN5bnJwYndnNjR5QTdJdWdJT3k4b091THBDNEtMeThLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQW92THlEcnFaVHJxcWpycHF3Z2ZqRTFUVUxybmJ3ZzY2R2M2cmU0N0oyNElPeUxuQ0RzbnBEcmo1a2c3SXVjN0o2UjdKeTg2NkdjSU95RGdleUxuQ0Rzdkp6cmthenJqNFFnNjdhQTY0dTBJT3lYaHV1THBDQW82NU94NjZHZE9pQnVjRzBnY25WdUlHSjFhV3hrS1M0S0x5OGc2NHVrNjZhczY0cVVJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1TERycWJRZzdLTzk3S2VBNjZlTUtPMlVqT3Vmck9xM3VPeWR1T3F6dkNEc2c1M3NncXdnNjQrWjZyaXc3Wm1VS1N3ZzZyQ1E3SXVjN0o2UTY0cVVJT3F6aE95R2pTRHJncWpzbFlRZzY0dWs3SjJNSU9xNXFPeWFzT3E0c091bHZDRHJzSnZyaXBUcmk2UXVDZ3BqYjI1emRDQm9kSFJ3SUQwZ2NtVnhkV2x5WlNnbmFIUjBjQ2NwT3dwamIyNXpkQ0J3WVhSb0lEMGdjbVZ4ZFdseVpTZ25jR0YwYUNjcE93cGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0NtTnZibk4wSUc5eklEMGdjbVZ4ZFdseVpTZ25iM01uS1RzS1kyOXVjM1FnZXlCemNHRjNiaXdnYzNCaGQyNVRlVzVqSUgwZ1BTQnlaWEYxYVhKbEtDZGphR2xzWkY5d2NtOWpaWE56SnlrN0NncGpiMjV6ZENCUVQxSlVJRDBnTVRFNE9EazdDbU52Ym5OMElGSlBUMVFnUFNCd1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5MaTRuS1RzZ0x5OGc3S0NBN0o2bDdJYU1JT3VqcU8yS3VDRGlnSlFnNjR1azY2YXM2ckNBSUhKbFkyOXRiV1Z1WkMxbGVHRnRjR3hsY3k1dFpPdWx2Q0Rzc0w3cmlwUWc2cml3N0tTQUNncGpiMjV6ZENCRFQxSlRYMGhGUVVSRlVsTWdQU0I3Q2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVTl5YVdkcGJpYzZJQ2NxSnl3S0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxSVpXRmtaWEp6SnpvZ0owTnZiblJsYm5RdFZIbHdaU2NzQ24wN0NtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXdvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzS0lDQnlaWE11Wlc1a0tFcFRUMDR1YzNSeWFXNW5hV1o1S0c5aWFpa3BPd3A5Q2dvdkx5QmpiR0YxWkdVZ1EweEo2ckNBSU95ZWlPdUtsT3luZ0NEaWdKUWc3SmVHN0p5ODY2bTBJQzkzWVd0bElPeWRrZXVMdGV5WGtDRHNpNlRzbHJRZzdaU002NStzNnJlNDdKMjQ3SjIwSU95VmlPdUN0TzJWb0NEc2lKZ2c3SjZJNnJLTUlPMlZuT3VMcEFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzRLTHk4ZzdZeU03SjI4N0oyMElPMkJ0Q0RzaUpnZzdKNkk3SmEwSURNdzdMU0lJT3k2a095TG5DNGc3SjZzNjZHYzZyZTQ3SjI0N1pXWTY2bTBJRU5NU2Vxd2dDRHRqSXpzbmJ6c25ZUWc2ckN4N0l1ZzdaV1k2NitBNjZHY0lPeWVrT3VQbVNEcnNKanNtSUhya0p6cmk2UXVDaTh2SU95NmtPeUxuQ0ExN0xTSUlPS0FsQ0Ryb1p6cXQ3anNuYmdnN0tlQjdadUVJT3lEaUNEcXM0VHNvSlhzbmJRZzZyT242N0NVNjZHY0lPeWVvZTJZZ095VnZDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95WGtPeUVuQ0R0bVlqc25MenJvWndnNjRTWTdKYTA2ckNFNjR1a0tETXc3TFNJNjZtMElPdUVpT3VzdENEcmlxYnNuWXdwQ214bGRDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUF3TENCbGJXRnBiRG9nYm5Wc2JDQjlPd3BtZFc1amRHbHZiaUJqYkdGMVpHVkJZMk52ZFc1MEtDa2dld29nSUdsbUlDaEVZWFJsTG01dmR5Z3BJQzBnWVdOamIzVnVkRU5oWTJobExtRjBJRHdnTlRBd01Da2djbVYwZFhKdUlHRmpZMjkxYm5SRFlXTm9aUzVsYldGcGJEc0tJQ0JzWlhRZ1pXMWhhV3dnUFNCdWRXeHNPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0JxSUQwZ1NsTlBUaTV3WVhKelpTaG1jeTV5WldGa1JtbHNaVk41Ym1Nb2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSnk1amJHRjFaR1V1YW5OdmJpY3BMQ0FuZFhSbU9DY3BLVHNLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdWhuT3EzdU95ZHVDRHNuYlRyb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDQXFMeUI5Q2lBZ1lXTmpiM1Z1ZEVOaFkyaGxJRDBnZXlCaGREb2dSR0YwWlM1dWIzY29LU3dnWlcxaGFXd2dmVHNLSUNCeVpYUjFjbTRnWlcxaGFXdzdDbjBLQ21aMWJtTjBhVzl1SUdoaGMwTnNZWFZrWlNncElIc0tJQ0JqYjI1emRDQm1hVzVrWlhJZ1BTQndjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5JRDhnSjNkb1pYSmxKeUE2SUNkM2FHbGphQ2M3Q2lBZ2RISjVJSHNnY21WMGRYSnVJSE53WVhkdVUzbHVZeWhtYVc1a1pYSXNJRnNuWTJ4aGRXUmxKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuTENCemFHVnNiRG9nZEhKMVpTQjlLUzV6ZEdGMGRYTWdQVDA5SURBN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGRIVnliaUJtWVd4elpUc2dmUXA5Q2dwc1pYUWdkMkZyYVc1bklEMGdabUZzYzJVN0lDOHZJT3lYc08yRGdDRHJzS25zcDRBZzRvQ1VJT3VMcE91bXJPdUtsQ0RzbHJUc3NLanRsTHdnUlVGRVJGSkpUbFZUUmV1aG5DRHNwSkhyczdVZzdLQ1Y2NmFzN1pXWTdLZUE2NmVNSU8yVWhPdWhuT3lFdU95S3BDRHJncTNydVlUcnBid2c3S1NFN0oyNDY0dWtDbVoxYm1OMGFXOXVJSGRoYTJWQ2NtbGtaMlVvS1NCN0NpQWdhV1lnS0hkaGEybHVaeWtnY21WMGRYSnVPd29nSUhkaGEybHVaeUE5SUhSeWRXVTdDaUFnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3SUhkaGEybHVaeUE5SUdaaGJITmxPeUI5TENBMU1EQXdLVHNLSUNCc1pYUWdjSEp2WXpzS0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnTHk4Z1YybHVaRzkzY3pvZ1kyMWt3cmQyWW5NZzZySzk3SnlnSU95WGh1eWR0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTd2dkMmx1Wkc5M2MwaHBaR1VvUTFKRlFWUkZYMDVQWDFkSlRrUlBWeW5yb1p3ZzdJcWs3WSt3SU9LQWxBb2dJQ0FnTHk4ZzdMQzlJT3lYaHV1S2xDRHNpS2pzbllBZzdMMlk3SWFVN0oyMElPdW5qT3VUcE95V3RPeW5nT3F6b0NEcmk2VHJwcXpzblpnZzdKNlE3SXVkS0dOc1lYVmtaU25yajRRZzZyZTRJT3k5bU95R2xPeWRoQ0Ryckx6cm9LVHJzSnZzbFlRZzdKYTA2NWFrSU95d3ZldVBoQ0RzbFlnZzY1eXM2NHVrTGdvZ0lDQWdMeThnWkdWMFlXTm9aV1RyaXBRZzdKT3c3S2VBSU95Vml1dUtsT3VMcENoa1pYUmhZMmhsWkN0M2FXNWtiM2R6U0dsa1pTRHNvYkR0bGFuc25ZQWc3TDJZN0lhVUlPeXd2ZXlkdENEcmhianN0cHpya0tnZzRvQ1VJT3lMcE95NG9Ta3VDaUFnSUNBdkx5QlhhVzVrYjNkejdKZVE3SVNnSUdSbGRHRmphR1ZrSU95WGh1eWR0T3VQaENEcnRvRHJxcWdvNnJDUTdJdWM3SjZRS2Vxd2dDRHNvNzNzbHJUcmo0UWc3SjZRN0l1ZDdKMkFJT3lDdE95VmhPdUNxT3VLbE91THBDNEtJQ0FnSUhCeWIyTWdQU0J6Y0dGM2JpaHdjbTlqWlhOekxtVjRaV05RWVhSb0xDQmJjR0YwYUM1cWIybHVLRjlmWkdseWJtRnRaU3dnSjJOc1lYVmtaUzFpY21sa1oyVXVhbk1uS1Ywc0lIc0tJQ0FnSUNBZ1kzZGtPaUJTVDA5VUxDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbExBb2dJQ0FnZlNrN0NpQWdmU0JsYkhObElIc0tJQ0FnSUM4dklHMWhZMDlUTCt1bXJPdUloZXlLcERvZzZyQ1E3SXVjN0o2UTY2VzhJT3VkaE95YXRDQnViMlJsSU95THBPMldpU0R0akl6c25ienJvWndnN0tlQjdLQ1JJT3lLcE8yUHNDQW9iR0YxYm1Ob1pDRHRtWmpxc3Izc2w1UWdVRUZVU09xd2dDRHJ1WWpzbGIzdGxhQWc3SWlZSU95ZWlPeVd0Q0Rzb0lqcmpJRHFzcjNyb1p3ZzdJS3M3SnFwS1FvZ0lDQWdjSEp2WXlBOUlITndZWGR1S0hCeWIyTmxjM011WlhobFkxQmhkR2dzSUZ0d1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5ZMnhoZFdSbExXSnlhV1JuWlM1cWN5Y3BYU3dnZXdvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUdSbGRHRmphR1ZrT2lCMGNuVmxMQ0J6ZEdScGJ6b2dKMmxuYm05eVpTY3NDaUFnSUNCOUtUc0tJQ0I5Q2lBZ2NISnZZeTUxYm5KbFppZ3BPeUF2THlEcXNKRHNpNXpzbnBBZzdKMjA2N0trN1lxNElPdWpxTzJVaE95WGtPeUVuQ0RydG9UcnBxd2dLT3F3a095TG5PeWVrQ0Rzb29Ycm80enJwYndnNjZlSjdLZUFJT3lWaXVxeWpDa0tmUW9LWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9LSEpsY1N3Z2NtVnpLU0E5UGlCN0NpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RQVUZSSlQwNVRKeWtnZXlCeVpYTXVkM0pwZEdWSVpXRmtLREl3TkN3Z1EwOVNVMTlJUlVGRVJWSlRLVHNnY21WMGRYSnVJSEpsY3k1bGJtUW9LVHNnZlFvZ0lHbG1JQ2h5WlhFdWRYSnNJRDA5UFNBbkwyaGxZV3gwYUNjcElIc0tJQ0FnSUM4dklIWTZJT3F3a095TG5PeWVrQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0RxdGF6cnNvVHNvSVFnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3F6aE95R2pTRHJqNHpxczZBZzdKNkk2NHFVN0tlQUlPdXdsdXlYa095RW5DRHRtWlhzbmJqdGxaanJpcFFnN0pxcDY0K0VDaUFnSUNBdkx5QW9kaklnUFNEc3NMMGc3SWlvNnJtQUlPeUltT3lnbGUyTWtDd2dkak1nUFNBdllXTmpiM1Z1ZENEc3RwVHFzSUR0akpBcENpQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2dkMkYwWTJobGNqb2dkSEoxWlN3Z2Rqb2dNeUI5S1RzS0lDQjlDaUFnTHk4ZzdKMjBJRkJEN0plUUlPdWhuT3EzdU95ZHVPdVFuQ0R0Z2JUcm9aenJrNXdnNnJPRTdLQ1ZJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3TEtySU8yWmxPdXB0TUszN1ptSTdKMjBJQ0xyaUlUcXRhd2c2ck9FN0tDVjdKeTg2NkdjSU95VHNPdUtsT3luZ0NJZzY3TzA3SmVzN0tPODY0cVVJT3VOc0NEc2s3VHJpNlF1Q2lBZ0x5OGc2ckNRN0l1YzdKNlE2ckNBSU91THRlMlZtT3VLbENEc25iVHNuS0E2SU91THBPdW1yT3VsdkNEc3ZKenJxYlFnN0p1TTY3Q043SmVGN0p5ODY2R2NJTzJCdE91aG5PdVRuT3F3Z0NEc2k2VHNvSndnN1ppNDdMYWM2NCs4SU9xMXJPdVBoU0RzZ3F6c21xbnJuNG5zbmJRZzY0S1k2ckNFNjR1a0xnb2dJQzh2SU9xd2tPeUxuT3lla091S2xDRHRqSXpzbmJ6cnA0d2c3SjI5N0p5ODY2K0E2NkdjSU95Q3JPeWFxZXVmaVNBd0lNSzNJT3VNZ09xNHNDQXdJT0tBbENEcXNvRHRocURycDR3ZzdKT3c2NHFVSU95Q3JPdWVqT3lYa09xeWpDRHJ1WVRzbXFuc25ZUWc2Nnk4NjZhczdLZUFJT3lWaXV1S2xPdUxwQzRLSUNBdkx5RHNvN3pzblpnNklPeVhyT3E0c0NEcXM0VHNvSlhzbmJRZzY3TzA3SmVzNjQrRUlPeWVoZXllcGVxMmpPeWR0Q0RycDR6cm80enJrSkRzbllRZzdJaVlJT3llaU91THBDanNuS0R0bXFqc2hMSHNuWUFnN0l1azdLQ2NJTzJZdU95Mm5DRHJsWXpycDR3ZzdKV01JT3lJbUNEc25vanNuWXdnNG9DVUlPdUxwT3VtckNBdmFHVmhiSFJvN0oyWUlIQnliMkpzWlcwZzdMQzQ2ck9nS1M0S0lDQnBaaUFvY21WeExuVnliQ0E5UFQwZ0p5OWhZMk52ZFc1MEp5a2dld29nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUdGalkyOTFiblE2SUdOc1lYVmtaVUZqWTI5MWJuUW9LU3dnWTJ4aGRXUmxPaUJvWVhORGJHRjFaR1VvS1NCOUtUc0tJQ0I5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNkaGEyVW5LU0I3Q2lBZ0lDQnBaaUFvSVdoaGMwTnNZWFZrWlNncEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1WnljZ2ZTazdDaUFnSUNCM1lXdGxRbkpwWkdkbEtDazdDaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnZDJGcmFXNW5PaUIwY25WbElIMHBPd29nSUgwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmMyaDFkR1J2ZDI0bktTQjdDaUFnSUNCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJREl3TUNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQTBMQ0I3SUdWeWNtOXlPaUFuVG05MElHWnZkVzVrSnlCOUtUc0tmU2s3Q2dvdkx5RHNuYlRycjdnZzY1YWdJT3llaU95Y3ZPdXB0Q0Rzb2JEc21xbnRub2dnN0tLRjY2T01JQ2pzbnBEcmo1a2c3SXVjN0o2UklDc2dibkJ0SUdKMWFXeGtJT3lra2V1enRTRHNpNlR0bG9rZzY0eUE2N21FS1FwelpYSjJaWEl1YjI0b0oyVnljbTl5Snl3Z0tHVXBJRDArSUhzS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3dvZ0lIQnliMk5sYzNNdVpYaHBkQ2d4S1RzS2ZTazdDbk5sY25abGNpNXNhWE4wWlc0b1VFOVNWQ3dnSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzS0lDQmpiMjV6YjJ4bExteHZaeWduVzNkaGRHTm9aWEpkSU8yQnRPdWhuT3VUbkNEcmk2VHJwcXdnNnJDUTdJdWM3SjZRSU95OG5PeW5rQ0RpZ0pRZ2FIUjBjRG92TDJ4dlkyRnNhRzl6ZERvbklDc2dVRTlTVkNrN0NuMHBPd289JwpCNjRfRVhBTVBMRVM9J0l5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzcElUc25ZUWc2N0NVNnI2NDZyT2dJT3lMdHV5Y3ZPdXB0Q0JnSUM4Z1lDQW83SldlNjVLa0lPcXp0ZXV3c1NEdGo2enRsYWdnN0lxczY1Nlk3SXVjS1NvcUlPdWhuQ0R0a1p6c2k1enRsWmpzaExqc21wUXVJTzJVak91ZnJPcTN1T3lkdU95WGtPeUVuQ0Rya1pBZzdLU0U2NkdjSU91enRPeVhyT3lua2V1TGlPdUxwQzRLTFNEc2dxenNtcW5zbnBEcXNJQWc3SjZGNjZDbDdaV2NJT3VzdU9xMXJPcXdnQ0JnN0p1UTY3TzRZT3F6dkNBbzZyTzE2N0N4d3JmcnJManNucVhydG9EdG1MZ2c2NnkwN0l1YzdaV1k2ck9nS1NEcXNKbnFzYkRyZ3Bnc0lPeUVuT3VobkNEdGo2enRsYWp0bFpqcnFiUWc2cmU0SU95MmxPeXluT3lWaU91VHBPeWRoQ0RyczdUc2w2enNwSTNyaTRqcmk2UXVDaTBnNjZlazdMbXQ3WldnSU91VmpDQXFLdXVuaU95S3BPMkN1ZXVRbkNEc25iVHJwb1FvN1ptTlhDcnJqNWtwTENEc2lLdnNucEFvN0tDRTdabVU2N0tJN1ppNHdyY2k3Sm00SURMcnFvVWlJT3VUc1NucmlwUWc2NnkwN0l1Y0tpcnRsYW5yaTRqcmk2UWc0b0NVSU95ZHRPdW1oTUszN0lpWTY1K0p3cmZyc29qdG1ManJwNHdnNjR1azY2VzRJT3VzdU9xMXJPdVBoQ0Rxc0puc25ZQWc3SmlJN0l1YzY2R2NJT3llb2UyWWdPeWFsQzRnNjR1b0xDRHN0cFRzc3B6c2xZanNsNUFnN0tDQjdKYTA2NUdVSU95ZHRPdW1oTUszN0lpcjdKNlE2NHFVSU9xM3VPdU1nT3VobkNEcmdwanNtS1RyaTRnZzdJdWs3S0NjSU9xd2t1eVhrQ0RycDU3cXNvd2c2ck9nN0xPUUlPeVRzT3lFdU95YWxDNEtMU0Rzb0p6cnFxa29ZQ01qWUNucXM3d2dZQ01qSTJBc0lHQXRZQ0RxdUxEdG1ManJpcFFnN1ppVjdJdWQ3SjIwNjR1SUlPdXdsT3ErdU95bmdDRHJwNGpzaExqc21wUXVDZ29qSXlEc2lxVHRnNERzbmJ3ZzdKdVE3TG1aSUNqc3NManFzNkFnNG9DVUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZQWdkWGd0ZDNKcGRHbHVaeTV0WkNEcXNJRHNuYlRyazV3cENnb3RJTzJWdE95YWxPeXl0Q3dnNjdhQTY1T2M2NStzN0pxMElPeWloZXF5c0NoZ2Z1eWVpT3lXdE95YWxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrS0xTRHFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NBbzdLQ0U3SWFoNG9hUzY3TzA2NEswNjR1a0tTd2c2N2FBN0tDVklPeURnZTJacWV1UGhDRHJsTEhybExIdGxaanNwNEFnN0pXSzZyS01LQ0xzc0w3cXVMQWc3SXVrN1l5b0l1S2RqQ0FpN0xDKzdKMkVJT3lJbUNEc2w0YnNsclRzbXBRaTRweUZLUW9LSXlNZzdMYVU3TEtjSU95WWlPeUxuQW9LSXlNaklPeW5oTzJXaWUyVm1PdU5tQ0RzbnBIc2w0WHNuYlFnN0o2STdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3S2VFN1phSklPeWtrZXlkdUNEcmdyVHNsNjNzbmJRZzdKNkk3SmEwN0pxVUxpQXZJT3lkdE95V3RPeUVuQ0RzcDRUdGxvbnRsYURxdVl6c21wUS9DZ29qSXlNZzZyTzE3SnlnSU95YWxPeXlyZXlkaENEc3Q2anNob3p0bFpqcnFiUWc3SnFVN0xLdElPdUN0T3lYcmV5ZHRDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTNxT3lHak8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHN0NmpzaG96dGxhQWc2cks5N0pxd0lPeWFsT3l5clNEcmdyVHNsNjNyajRRZzdJS3Q3S0NjNjQrODdKcVVMaUF2SU9xenRleWNvQ0RzbXBUc3NxM3NuWVFnN0xlbzdJYU03WldnNnJtTTdKcVVQd29LSXlNaklPcTRzT3E0c091bHZDRHNzTDdzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXWTdJUzQ3SnFVTGdvdElPcTRzT3E0c091bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaV1k2cml3SU95Z2hPeVhrT3VLbENEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQTdKNkY3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDaTBnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxnb0tJeU1qSU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c3Sm00SURMcnFvWHNsNURxc293ZzZyYU03WldjSU95Q3JleWduQ0RzbFl6cnByenRocUhzbllRZzdLQ0U3SWFoN1pXZzZybU03SnFVUHdvdElPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdE91Z3BPcXpvQ0R0bGJUc21wUXVJQzhnN1ptTkt1dVBtU2d3TVRBdE1USXpOQzAxTmpjNEtTRHJpNWdnN0ptNElETHJxb1hzbDVEcXNvd2c2N08wNjRLODZybU03SnFVUHdvdElPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnNjR1WUlPeVp1Q0F5NjZxRjdKZVE2cktNSU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN2T3E1ak95YWxEOEtMU0RxdG96dGxad2c3SUt0N0tDY0lPeVZqT3Vtdk8yR29leWRoQ0R0bVkwcTY0K1pLREF4TUMweE1qTTBMVFUyTnpncElPdUxtQ0RzbWJnZ011dXFoZXlYa09xeWpDRHJzN1RyZ3J6cXVZenNtcFEvQ2dvakl5TWpJTzJabGV5ZHVNSzM2ckt3N0tDVklPMk1uZXlYaFFvS0l5TWpJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeUNyZXlnbk91UW5DRHJqYkRzbmJUdGhMRHJpcFFnNjdPMTZyV3M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHJrSmpyajR6cnByUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNvSlhycDVBZzdJS3Q3S0NjN1pXZzZybU03SnFVUHdvS0l5TWpJT3V6Z09xeXZleUNyTzJWcmV5ZHRDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdKV1k3SXExNjR1STY0dWtMaURyZ3BqcXNJRHNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SldFN0tlQklPeWdnT3llcGUyVm1PeW5nQ0RzbFlyc25ZQWc2NEswN0pxcDdKMjBJT3llaU95V3RPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpyajd6c21wUXVJQzhnN0xTSTZyaXc3Wm1VN1pXZzZybU03SnFVUHdvS0l5TWpJeURzbDVEcm42ekN0K3lMcE8yTXFBb0tJeU1qSU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU91RXBPMkt1T3liak8yQnJPeVhrQ0RzbDdEcXNyRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzbDdEcXNyQWc3SU9CN1lPYzY2VzhJTzJabGV5ZHVPMlZtT3F6b0NEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPdXduT3lEbmUyV2lPeUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU95RG5lcXl2T3lXdE95YWxDNGdMeURzbnFEc2k1d2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWaE95ZHRPdVVsQ0RybUpEcmlwUWc2N21FNjdDQTY3S0k3Wmk0NnJDQUlPeWR2T3k1bU8yVm1PeW5nQ0RzbFlyc2lyWHJpNGpyaTZRdUNpMGc3SldFN0oyMDY1U1VJT3VZa091S2xDRHJ1WVRyc0lEcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDNyc29qdG1ManFzSUFnN0oyODdMbVk3WldZN0tlQUlPeVZpdXlLdGV1TGlPdUxwQzRLTFNEc25ianNwcDNyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3kwaU9xenZPdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKMjQ3S2FkNjdLSTdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnN0plRjY2R2M2NU9jN0plUUlPeUxwTzJNcU8yV2lPeUt0ZXVMaU91THBDNEtMU0R0akl6c25ienNuWVFnN0ppczY2YXM3S2VBSU91cXUrMldpT3lXdE95YWxDNGdMeURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3S0NRNnJLQUlPeWtrZXllaGV1TGlPdUxwQzRnN0oyMDdKcXA3SmVRSU91MmlPMk91T3lkaENEcms1enJvS1FnN0tPRTdJYWg3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEc2hKenJ1WVRzaXFUcnBid2c3S0NRNnJLQTdaV1k2ck9nSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSkRxc29Ec25iUWc2NEdkNjRLWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bFlUc2lKZ2c3SjZGNjZDbElPMlZyZXVxcWV5ZWhldUxpT3VMcEM0S0xTRHF2SzBnN0o2RjY2Q2w3WlcwN0pXOElPMlZtT3VLbENEdGxhM3JxcW5zbmJUc2w1RHNtcFF1Q2dvakl5TWpJT3Eyak8yVm5NSzM3SVNrN0tDVkNnb2pJeU1nN0xtMDY2bVU2NTI4SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdJcTE2NHVJNjR1a0xpRHNoS1Rzb0pYc2w1RHNoSndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU95THJleUxuT3lZcEM0S0xTRHN1YlRycVpUcm5id2c2cmFNN1pXYzdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0xtMDY2bVU2NTI4SU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmpPdW12Q0RxdG96dGxaenNuYlFnNnJHdzY3YUE2NUNZN0phMElPeVZqT3Vtdk95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHNsWXpycHJ3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PdXB0Q0RzaG96c2k1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUlDOGc3SVNrN0tDVjdKZVE3SVNjSU95VmpPdW12T3lkaENEc3ZKd2c3S084N0lTNDdKcVVMZ29LSXlNaklPeWNoT3k1bUNEc29KWHJzN1FnN0oyMDdKcXA3SmVRSU91UG1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyb1ozc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdVRzZXVobmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWc3SUt0N0tDYzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeUNyZXlnbk8yV2lPeVd0T3lhbEM0S0NpTWpJeUR0Z2JUcnByM3JzN1RyazV6c2w1QWc2N08xN0lLczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0ZXlDck8yV2lPeVd0T3lhbEM0S0NpTWpJeURzbXBUc3NxM3NuWVFnN0xLWTY2YXNJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKcVU3TEt0N0oyRUlPeXltT3Vtck8yVm1PcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPeVZpT3VDdE1LMzdKeWc2NCtFQ2dvakl5TWc3SU9JNjZHYzdKcTBJT3V5aE95Z2hPeWR0Q0RzdHB6c2k1enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlPeVhoZXVOc095ZHRPMkt1Q0R0bTRRZzdKMjA3SnFwSU9xd2dPdUtwZTJWcWV1TGlPdUxwQzRLTFNEc2c0Z2c2N0tFN0tDRTdKMjBJT3VDbU95WmxPeVd0T3lhbEM0Z0x5RHNsNFhyamJEc25iVHRpcmp0bFpqcnFiUWc3SU9JSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0oyMDdKcXA3SjJFSU95Y2hPMlZ0Q0RzbGIzcXRJQWc2NCtaN0oyWTZyQ0FJTzJWaE95YWxPMlZxZXVMaU91THBDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzaTV6c25wSHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25xWHNpNXpxc0lRZzY2KzQ3SUtzN0pxcDdKeTg2NkdjSU95ZWtPdVBtU0Ryb1p6cXQ3anNsWVRzbTRNZzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3lZcE91ZXErdVBtZXlWaUNEc2dxenNtcW50bFpqc3A0QWc3SldLN0pXRUlPdWhuT3EzdU95VmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyaTRqcmk2UXVJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbllRZzdabVY3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3E0c09xNHNPcXdnQ0RyaEtUdGlyanNtNHp0Z2F6c2w1QWc3SmV3NnJLdzY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJpdzZyaXc3SjJZSU95WHNPcXlzQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbUlIc2c0SHNuWVFnNjdhSTY1K3M3SmlrNjRxVUlPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0ppQjdJT0I3SjJFSU91MmlPdWZyT3lZcE9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3kzcU95R2pPMlZtT3lMcENEcXNyM3NtckFnN0l1ZzdMS3Q3WldZN0l1Z0lPdUN0T3lhcWV5ZGdDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdJcTE2NHVJNjR1a0xnb3RJT3kzcU95R2pPMlZtT3VwdENEc2k2RHNzcTN0bFp3ZzY0SzA3SnFwN0oyMElPeWdnT3llcGV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvQ2kwZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvSUM4ZzdMZW83SWFNN1pXWTY2bTBJT3llaGV1Z3BlMlZuQ0RyZ3JUc21xbnNuYlFnN0lLczY1Mjg3S0M0N0pxVUxnb0tJeU1qSXlEcXNJRHNuYlRyazV3ZzdKaUk3SXVjSUNoMWVDMTNjbWwwYVc1bkxtMWs3SmVRN0lTY0lPeVlydXE1Z0NEaWdKUWc2cmVjN0xtWjdKeTg2NkdjSU95ZWtPdVBtZTJabENEcnFyc2c3WldZNjRxVUlPdXN1T3llcFNEc25xenF0YXpzaExFZzdJS3M2NkdBS1FvS0l5TWpJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxczZBZzZyT0U3SXVjNjRLWTdKcVVQd290SU95ZWtPdVBtZXl3cU9xd2dDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUxnb3RJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFF1Q2dvakl5TWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVMZ290SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQzRLQ2lNakl5RHF1SWpzbmJ6cXVZenNwNEFnNjYrNDY0S3BJT3lMbkNEc2w3RHNzclFnN0xLWTY2YXM2NUNwNjR1STY0dWtMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUNxZXUyZ08yVm1PeUxuT3E0c0NEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUF2SU8yYmhPdTJpT3F5c095Z25DRHF1SWpzbGFIc25ZUWc2NEswN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lna09xeWdDRHF1TERxc0lUc2w1RHJpcFFnN0lTYzY3bUU3SXFrSU95ZHRPeWFxZXlkdENEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUxvT3UyaE95bW5TRHRtWlhzbmJnZzdLQ0U3SmVRNjRxVUlPeUdvZXE0aUNEcnNJOGc2ckt3N0tDYzZyQ0FJT3UyaU9xd2dPMlZxZXVMaU91THBDNEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPdXpnT3F5dlNEc2k1d2c3THFRN0l1YzY3Q3hJT3llck95bmdPcTRpZXlkZ0NEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNnNEhyaTdRZzdaS0k3S2VJSU8yV3BleURnZXlkaENEc25JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhbEM0S0NpTWpJeU1nNnJPRTdLQ1Z3cmZzbm9Ycm9LVUtDaU1qSXlEc2xZVHNuYlRybEpRZzY1aVE2NHFVSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWR0T3lEZ1NEc25wanJxcnNnN0o2RjY2Q2w3WldZN0plc0lPcXpoT3lnbGV5ZHRDRHNucURxdUlnZzdMS1k2NmFzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWVtT3VxdXlEc25vWHJvS1h0bGJUc2hKd2c2ck9FN0tDVjdKMjBJT3llb09xeXZPeVd0T3lhbEM0Z0x5RHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzdKNnM3SVNrN0tDVjdaV1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25iVHJyN2dnN0lLczdKcXBJT3lra2V5ZHVDRHNsWVRzbmJUcmxKVHNub1hyaTRqcmk2UXVDaTBnN0oyMDY2KzRJT3lUc09xem9DRHNub2pyaXBRZzdKV0U3SjIwNjVTVTdKaUk3SnFVTGlBdklPdUxwT3VsdUNEc2xZVHNuYlRybEpUcnBid2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNncXpzbXFudGxhQWc3SWlZSU95WGh1dUtsQ0RydVlUcnNJRHJzb2p0bUxqc25vWHJpNGpyaTZRdUlPeVlnZXVzdUN3ZzdJaXI3SjZRTENEdGlybnNpSmpyckxqc25wRHJwYndnN1krczdaV283WldZN0plc0lEanNucEFnN0oyMDdJT0JJT3llaGV1Z3BlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc21JSHJyTGdzSU95SXEreWVrQ3dnN1lxNTdJaVk2Nnk0N0o2UTY2VzhJTzJQck8yVnFPMlZ0Q0E0N0o2UUlPeWR0T3lEZ1NEc25vWHJvS1h0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95ZWhldWdwU0Rxc0lEcmlxWHRsWndnNnJpQTdKNlFJT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzdKNkY2NkNsN1pXZ0lPeUltQ0Rzbm9qcmlwUWc2cmlBN0o2UUlPeUltT3VsdkNEcmhKanNsNGpzbHJUc21wUXVJQzhnNjRLMDdKcXA3SjJFSU95aHNPcTRpQ0RzcElUc2w2d2c3S084N0lTNDdKcVVMZ29LSXlNakl5RHRqSXpzbmJ6Q3QrcXlzT3lnbk1LMzZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzaUpqcmk2anNuWVFnN1ptVjdKMjQ3WldZNnJPZ0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WldZN0plc0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xenRlcXdoT3lkaENEdG1aWHJzN1R0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BDRHNwSURydVlRZzdLU1I3SjZGNjR1STY0dWtMZ290SU95a2dPdTVoTzJWbU9xem9DRHNub2pyaXBRZzZyaXc2NHFsN0oyMDdKZVE3SnFVTGlBdklPeWhzT3E0aU91bmpDRHF1TERyaTZUcm9LUWc3S084N0lTNDdKcVVMZ29LSXlNaklPdVRzZXVoblNEcXNJRHJpcVh0bFp3ZzdMV2M2NHlBSU9xd25PeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnNjQyVUlPdVRzZXVobmUyVm1PdWdwT3VwdENEcXVMRHNvYlFnN1pXdDY2cXA3SjJFSU95Q3JleWduTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095MmxPcXdnQ2tLQ2lNakl5RHN0cHpyajVrZzdKcVU3TEt0N0oyMElPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0xhYzY0K1pJT3lhbE95eXJleWRoQ0Rzb0pIc2lKanRsb2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLOTY3bUVJT3lEZ2UyRG5PdWx2Q0R0bVpYc25ianRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPcXl2ZXU1aENEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3SUNqc2w0YnNsclRzbXBRZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUXBDZ29qSXlNZzY3TzQ3SjI0SU95ZHVPeW1uZXlkaENEdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0Ryczdqc25iZ2c3SjI0N0thZDdKMkVJTzJWbU91cHRDRHJxcWpyazZBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95ZHRPdXBsT3lkdkNEc25ianNwcDBnN0tDRTdKZVE2NHFVSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lkdE91cGxPeWR2Q0RzbmJqc3BwM3NuWVFnNjZlSTdMbVk2Nm0wSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3kvb08yUHNPeWRnQ0Ryb1p6cXQ3anNuYmdnN1p1RTdKZVE2NmVNSU95Q3JPeWFxU0Rxc0lEcmlxWHRsYW5yaTRqcmk2UXVDaTBnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3kvb08yUHNPeWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJyN2pzaExIcmhZVHNucERyaXBRZzY3TzA3Wmk0N0o2UUlPdVBtZXlkbUNEc2w0YnNuYlFnNnJLdzdLQ2M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzY3TzA3Wmk0N0o2UTZyQ0FJT3VQbWV5ZG1PMlZtT3VwdENEcXNyRHNvSnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsSVRyb1p6dGxZVHNuWVFnNjVPeDY2R2Q3WldZN0tlQUlPeVZpdXljdk91cHRDRHNuYlRzbXFuc25iUWc3S0NjN1pXYzY1Q3A2NHVJNjR1a0xnb3RJTzJVaE91aG5PMlZoT3lkaENEcms3SHJvWjN0bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2xiRWc2N0tFN0tDRTdKMjBJT3VDcnV5VmhDRHNuYnpydG9BZzZyaXc2NHFsN0oyMElPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVobmV1UW1PeW5nQ0RzbFlyc2xZUWc3SUtzN0pxcDdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0xhYzdKNkZJT3k1dE91VG5PdWx2Q0RyazdIcm9aM3RsWmpycWJRZzY3Q1U2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3SUNqc21ZVHJvNHdnN0pXSTY0SzBLUW9LSXlNaklPMmFqT3lia09xd2dPeWVoZXlkdENEc21ZVHJvNHpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNnJDQTdKNkY3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEc21JanNsYjNzbmJRZzdMZW83SWFNNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95WWlPeVZ2ZXlkaENEc3Q2anNob3p0bG9qc2xyVHNtcFF1Q2dvakl5TWc2Nnk0N0oyWTZyQ0FJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdJaWM3TENvN0tDQjdKeTg2NkdjSU91THRldXpnT3VUbk91bXJPcXlvT3lLdGV1TGlPdUxwQzRLTFNEcnJManNuWmpycGJ3ZzdLQ1I3SWlZN1phSTdKYTA3SnFVTGlBdklPeUluT3lFbk91TWdPdWhuQ0RyaTdYcnM0RHJrNXpycHJUcXNvenNtcFF1Q2dvakl5TWc3SVNrN0tDVjdKMjBJT3kwaU9xNHNPMlpsT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzaEtUc29KWHNuWVFnN0xTSTZyaXc3Wm1VN1phSTdKYTA3SnFVTGdvS0l5TWpJT3U1aE91d2dPdXlpTzJZdU9xd2dDRHJzNERxc3IzcmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SU91d2xPcS9xT3lXdE95YWxDNEtDaU1qSXlEc25ianNwcDNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHVPeW1uZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNaklPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUWdLT3luaU91c3VDRHNucXpxdGF6c2hMRXBDZ29qSXlNZzdKYTQ3S0NjSU91d3FldXN1TzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEcnNLbnJyTGdnNjRLZzdLZWM2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0phMDY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RycDR6cm80enJvWndnN0oyMDdKcXA3SjIwSU95a2tleW5nT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzbmJUc21xa2c2cml3NnJDRTdKMjBJT3VCbmV1Q21PeUVuQ0RzcDREcXVJanNuWUFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SnFwNjUrSklPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0lEc25xWHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lnZ095ZXBlMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVDZ29qSXlNZzdZYTE3SXVnSU95WXBPdWxtT3VobkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXWTdKaUE3SXExNjR1STY0dWtMZ290SU8yR3RleUxvT3lkdENEc201RHRtWnp0bFpqc3A0QWc3SldLN0pXRUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0pIcXQ3enNuYlFnNnJHdzY3YUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0phMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RxdG96dGxaenNuWVFnN0pxVTdMS3Q3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nN0lPQjdabXBJT3lWaU91Q3RDQW9NdXVMcUNEcXRhenNvYkFwQ2dvakl5TWc3SjZGNjZDbDdaV1k3SXVnSU95anZPeUdqT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnNjR1azdJdWNJTzJabGV5ZHVDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdLTzg3SWFNNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU91THBPeUxuQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lhbE95eXJlMlZtT3lMb0NEdGpwanNuYlRzcDREcnBid2c3TEMrN0oyRUlPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3WTZZN0oyMDdLZUE2Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEdGc0anRoN1R0bFpqcnFiUWc2NnFvNjVPZ0lPdU5zT3lkdE8yRXNPcXdnQ0RzZ3Ezc29KenJrSmpxczZBZzY0dWs3SXVjSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95Z2xldW5rQ0R0ZzRqdGg3VHRsYURxdVl6c21wUS9DZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeURnZTJacVNEc2xZanJnclFwQ2dvakl5TWc2N2FBN0o2c0lPeWtrU0Ryc0tucnJManNucERxc0lBZzZyQ1E3S2VBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91MmdPeWVyQ0RzcEpIc2w1QWc2N0NwNjZ5NDdKNlE2ckNBSU95ZWlPeVhpT3lXdE95YWxDNGdMeURzbUlIc2c0SHNuWVFnN1ptVjdKMjQ3WlcwSU91enRPeUV1T3lhbEM0S0NpTWpJeURxc3IzcnVZUWc3WlcwN0tDY0lPcTJqTzJWbk95ZHRDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZySzk2N21FSU8yVnRPeWduQ0RxdG96dGxaenNuYlFnN1pXRTdKcVU3WlcwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHNtcFRzc3EzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPMlpsT3llckNEcXNKRHNwNERxdUxBZzY3Q3c3WVN3NjZhczZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNEtMU0R0bVpUc25xd2c2ckNRN0tlQTZyaXdJT3V3c08yRXNPdW1yT3F3Z0NEc2xyenJwNGdnN0plRzdKYTA3SnFVTGlBdklPdXdzTzJFc091bXJPdWx2Q0RxdFpEc3NyVHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzdHBYc2xiMGdLeURxdUkzc29KVWc3S0NFN1ptWUlDanJrWkFnNjZ5NDdKNmxJT0tHa2lEcXVJM3NvSlh0bUpVZzdaV2NJT3VzdU95ZXBTa0tDaU1qSXlEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVUHlEc2xZenJwcnpzbllRZzdMeWM3S2VBSU95Vml1eWN2T3VwdENEc3BKSHNtcFR0bFp3ZzdJYU03SXVkN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU95VmpPdW12T3lkaENEc3ZKenJxYlFnN0tTUjdKcVU3WldjSU95R2pPeUxuZXlkaENEcnNKVHJvWndnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0o2UTY0K1o3SjIwN0xLMDY2VzhJT3VUc2V1aG5lMlZtT3luZ0NEc2xZcnFzNkFnNjRTWTdKYTA2ckNJNnJtTTdKcVVQeURyazdIcm9aM3RsWmpzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc25wRHJqNW5zbmJUc3NyVHJwYndnNjVPeDY2R2Q3WldZNjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJzN2dnNnJPRTdKVzk3SjJZSU95Y29PeWR2TzJWbkNEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3lkdk91d21PcTBnT3Vtck95ZWtPdWhuQ0RxdG96dGxaenJzNERxc3Izc25ZUWc3WldZN0l1a0lPeUltQ0RzbDRic2xyVHNtcFF1SU95ZHZPdXdtQ0RxdElEcnBxenNucERyb1p3ZzZyYU03WldjSU91emdPcXl2ZXlkaENEc201RHRsWmpzaTZRZzZySzk3SnF3SU91THBPdWx1Q0RzZ3F6cm5venNsNURxc293ZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtDRHF0b3p0bFp6c25ZUWc3S2VBN0tDVjdaVzBJT3lqdk95TG9DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZuQ0Rya3FRZzdKMjg2N0NZSU9xMGdPdW1yT3lla091aG5DRHJzNERxc3IzdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXpnT3F5dmUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvPScKQjY0X0dVSURFPSdJeUJWV0NCWGNtbDBhVzVuSU9xd2dPeWR0T3VUbkFvS0l5TWdNUzRnN1pXMDdKcVU3TEswQ2dyc29KenRrb2dnN0pXSTdKMllJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWdKKzJWdE95YWxPeXl0Q2Zyb1p3ZzdJMm83SnFVTGdyc25ienF0SURzaExFZzdKNkk2NHFVSU95Q3JPeWFxZXlla0NEcXNyM3RsNWpzbllRZzY2ZU02NU9rSU95SW1DRHNub2pyajRUcm9aMGdLaXJzZzRIdG1ha3NJT3VucGV1ZHZleWRoQ0RydG9qcnJManRsWmpxczZBZzY2cW82NU9nSU91c3VPcTFyT3lYa0NEdGxiVHNtcFRzc3JUcnBid2c3S0NCN0pxcDdaVzA3S084N0lTNDdKcVVMaW9xQ2dyc21JZ3BDaTBnNjdPMDY0T0Y2NHVJNjR1a0lPS0draURyczdUcmdyenFzb3pzbXBRS0Npb3FLZ29LSXlNZ01pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzQW9LN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RzdFp6cmpJRHRsWndnS2lycmlxWHJqNW50bUpVZzY2eTQ3SjZsS2lyc25ZUWc3STJvN0tPODdJUzQ3SnFVTGlEc2lKanJqNW50bUpVZzY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRFdDdJaVk2NCtaN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2s3RHJpcFFnNnJLTUlPeWlpK3lWaE95YWxDNEtDaU1qSXlEcmtKRHNsclRzbXBRZzRvYVNJTzJXaU95V3RPeWFsQW9LN0ppSUtRb3RJT3lFcE95Z2xldVFrT3lXdE95YWxDRGlocElnN0lTazdLQ1Y3WmFJN0phMDdKcVVDZ29qSXlNZ0ozN3NsNGduSU91NXZPcTRzQW9LN0ppSUtRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVUNnb2pJeU1nNjQrWjdJS3NJT3V3bE9xL2xPeVRzT3E0c0FvSzdKaUlLUW90SU91R2t1eVZoT3loak95V3RPeWFsQ0RpaHBJZzdKaXM2NTZRN0phMDdKcVVDZ29xS2lvS0NpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBS0N1eWduTzJTaUNEc2xZanNsNURzaEp3ZzY3YUE3S0NWN0tDQklPeTdwT3V1cE91TGlPeThnT3lkdE95Rm1PeWRoQ0RzdFp6cmpJRHRsWndnN0tTRTdKMjA2ck9nSU9xNGpleWdsZTJZbFNEcnJManNucVhzbllRZzdJMm83S084N0lTNDdKcVVMZ3JydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVE10NjdhQTdLQ1Y3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzamFqc21wUXVDZ3JzbUlnZ09pRHNsWWdnNjQrODdKcVVMQ0RzbDRic2xyVHNtcFFnS0ZncElPS0draUIrN1pXWTY2bTBJTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVJQ2hQS1FvS0l5TWpJT3lYaHV5V3RPeWFsQ0RpaHBJZzdKNkk3SmEwN0pxVUNncnNtSWdwQ2kwZzY3TzA3Wmk0N0o2UTZyQ0FJTzJYaU91ZHZlMlZtT3E0c0NEc29JVHNsNURyaXBRZzZyQ0E3SjZGN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFFnNG9hU0lPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFLQ2lNakl5RHNsNURybjZ3ZzY2bVU3SXVjN0tlQUNncnNsNURybjZ3ZzdJT0I3Wm1wN0plUTdJU2M2NCtFSUNMdGxiVHFzckFnNjdDcDY3S1ZJdXlkaENEcnFMenNvSUFnN0pXTTY2Q2s3S084NjRxVUlPcTRqZXlnbGUyWWxTRHF0YXpzb2JEcm9ad2c3STJvN0pxVUxnb0s3SmlJS1FvdElPeW5nT3E0aUNEcnNvVHNvSVRzbDVEc2hKenJpcFFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95VnNleWRoQ0RzdFp6c2k2QWc2N0tFN0tDRTdKeTg2NkdjSU95WGhldU5zT3lkdE8yS3VDRHRsYlRzbzd6c2hManNtcFF1SU9LR2tpRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwN0tPODdJUzQ3SnFVTGlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDam82T2lCMGFYQWc2NHVrN0oyMDdKYTg2NkdjNnJlNElPeVp2T3lxdlNEcnNvVHRpcnpzbllBZ1crdUxxK3E0c0YwSzY0dWs3SjIwN0phODY2R2M2cmU0SU95WnZPeXF2U0Ryc29UdGlyenNuWUFnS2lycmk2dnF1TEFxS3V1aG5DRHJyTGpxdGF6cnBid2c3WWExN0oyODdaVzA3SnFVTGlBcUt1eTNxT3lHakNvcTY0cVVJT3lDck95YXFleWVrT3F3Z0NEdGxaanFzNkFnN0o2STY0cVVJT3lla2V5WGhleWR0Q0RzdDZqc2hvenJrSnpyaTZUcXM2QWc3SmlrN1pXMDdaV2dJT3lJbUNEc25vanNsclFnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzRLT2pvNkNnb2pJeU1nN1ppYzdZT2Q3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SjJFSU91VmpBb0s3SmlJS1FvdElPdXFxT3llaE95bmdPeWJrT3E0aUNEc2w0YnNuYlFnNjZxbzdKNkU3WWExN0o2bDdKMkVJT3Vuak91VHBPcTVqT3lhbEQ4ZzdLZUE2cmlJSU91d20reW5nQ0RzbFlyc25MenJxYlFnNjZxbzdKNkU3S2VBN0p1UTZyaUk3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnN0pXOTZyU0E3SmVRSU91UG1leWRtTzJWbU91cHRDRHJxcWpzbm9Uc3A0RHNtNURxdUlqc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3WmljN1lPZElPdU1nT3lEZ1NEc2xZanJnclFLQ2lvcTdJU2M2N21FN0lxazY0cVVJT3lUdUNEc2lKZ2c3SjZJN0tlQTY2ZU1MQ0R0aXJuc29KVWc3WmljN1lPZDdKMkFJT3V3bSt5ZGhDRHNpSmdnN0plRzdKMkVJT3VWakNEaWhwSWc2cmlON0tDVjdaaVZJT3VzdU95ZXBleWN2T3VobkNEc2phanNtcFF1S2lvSzdJS3M3SnFwN0o2UTY0cVVJT3VzdU9xMXJPdWx2Q0Rxdkx6cXZMenRub2dnN0oyOTdLZUFJT3lWaXVxem9DRHRtNUhzbHJUcnM3VHF1TEFvN0lxazdMcVVLU0RybFl6cnJManNsNUFzSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzazdEcnFiUWc3S0NjN1pLSUlPeWdoT3l5dE91bHZDRHNrN2dnN0lpWUlPeVhodXVMcE9xem9DRHNtS1R0bGJUdGxaanF1TEFnN0ltczdKdU03SnFVTGdvSzdKaUlLUW90SU9xemhPeWlqQ0Rxc0p6c2hLUWc3WmljN1lPZDdKMkFJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlEaWhwSWdOQzQxSlNEcXVJanJwcXdnN1ppYzdZT2Q2NmVNSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tLaW9xQ2dvakl5QTBMaURzdXBEc283enNscnp0bFp3ZzZySzk3SmEwQ2dyc29KenRrb2dnN0pXSTdKZVE3SVNjSUNkKzdJdWM2cktnN0phMDdKcVVQeWNzSUNmc2k1enJncGpzbXBRL0p5d2dKMzdxdTVnbklPcXdtZXlkZ0NEcXM3enJqNFR0bFp3ZzZySzk3SmEwNjZXOElPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdUN1eTFuT3VNZ08yVm5DRHN1cERzbzd6c2xyenRsWmpxczZBZzdMbWM2cmU4N1pXY0lPdW5rTzJJck91bHZDRHNrN0RyaXBRZzZyS01JT3lpaSt5VmhPeWFsQzRLNnJLOTdKYTA2NHFVSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVEl0NnJLOTdKYTA2Nlc4TGV5TnFPdVBoQzNya0pqcmlwUXQ2cks5N0pxd0tleVhrQ0R0bGJUcmk3bnRsYUFnNjVXTTY2ZU1JT3lOcU95YWxDNEtDaU1qSXlEcmo1bnNncXpzbDVEc2hKd2dKMzdzaTV3bklPdTV2T3E0c0FvSzdKaUlLUW90SU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bFpqc2k1enFzcURzbHJUc21wUS9JT0tHa2lEc3ViVHJrNXpycGJ3ZzdaVzA3S2VBN1pXZzZybU03SnFVUHdvdElPeUxuT3lla2UyVm1PeUxuT3VLbENEcnRvVHNsNURxc293Z05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMaURpaHBJZzdJdWM3SjZSN1pXWTY2bTBJRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0NpTWpJeUFuNnJPRTdJdWM2NHVrSnlEaWhwSWdKK3llaU91THBDY0tDdXlZaUNrS0xTRHNucERyajVuc3NLanJwYndnNnJDQTdLZUE2ck9nSU9xemhPeUxuT3VDbU95YWxEOGc0b2FTSU95ZWtPdVBtZXl3cU9xd2dDRHNub2pyZ3Bqc21wUS9DaTBnNjZlazY0dXNJT3V6dE8yWG1PdWpqQ0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VucE91THJDRHJzN1R0bDVqcm80enJpcFFnN0phODY2ZUk3SjI0NnJDQTdKcVVQeUFxS091THFPeUluQ0RzdVpqdG1aanNuYlFnN0pXRTY0dUk2NTI4SU91c3VPeWVwZXlkaENEc2c0anJvWndnN0pPMElPeUNyT3VoZ095WWlPeWFsQ2txQ2dvakl5TWdKK3lYck95dGlPdUxwQ2NnNG9hU0lDZnRtWlhzbmJqdGxaanJpNlFzSU91c3UrdUxwQ2NLQ3V5WWlDa0tMU0RzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9mcXNJRHNwNEFnNjR1azdJdWNJT3lYck95dHBPdXp2T3F5ak95YWxDNGc0b2FTSU95VmlPeWdoTzJWbkNEcXNKenRoclhzbllRZzdKeUU3WlcwSU91cWgrcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklDZnF1NWduSU9LR2tpQW43SmVRNnJLTUp3b0s3SmlJS1FvdElPMlpqZXE0dU91UG1ldUxtT3E3bUNEcmdxRHNsWVRxc0lEcXM2QWc3SjZJN0phMDdKcVVMaURpaHBJZzdabU42cmk0NjQrWjY0dVk3SmVRNnJLTUlPdUNvT3lWaE9xd2dPcXpvQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc2cks5N0phMDY2VzhJT3U2a095ZGhDRHJsWXdnN0phMDdJT0o3WldjSU9xeXZleWFzQW9LN0lLczdKcXA3SjZRN0oyWUlPeWdsZXV6dE91bHZDRHJzSnZyaXBRZzdLZUk2Nnk0N0plUTdJU2NJT3E0c09xemhPeWdnZXljdk91aG5DQW5mdXlMbkNmcnBid2c2N3FRN0oyRUlPdVZqQ0Ryckxqc25xWHNuYlFnN0phMDdJT0o3WldnSU95SW1DRHNub2pzbHJUc21wUXVDaW9xN1l5TTdKV0Y3WldZNnJPZ0lPeUx0dXlkZ0NEc29KWHJzN1RycGJ3Z0oreWp2T3lXdENmcm9ad2c3STJvN0lTY0lPdXN1T3llcGV5ZGhDRHNnNGpyb2EzcXNvd2c3STJvNjdPMDdJUzQ3SnFVTGlvcUNncnNtSWdwQ2kwZzdKYTA2NWFrSU91cXFleWdnZXljdk91aG5DRHJqSURzdHB6cnNKdnNuTHpzaTV6cmdwanNtcFEvSU9LR2tpRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0xTRHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOGc0b2FTSU95TG9PcXpvQ0RzbmJUc25LRHJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUV1T3lhbEM0S0Npb3FLZ29LSXlNZ05TNGdKM3ZycW9Yc2dxeDlJQ3NnZSt1cWhleUNySDBuSU95VHNPeW5nQ0RzbFlycXVMQUtDaU1qSXlEdGxaenNucERzbHJRZzdaS0E3SmEwN0pPdzZyaXdDZ3J0bFp6c25wRHNsclFnNjZxRjdJS3M2Nlc4SU8yU2dPeVd0T3lFbkNEcmo1bnNncXdnN1ppVjdZT2M2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUlPS0draURzbmJUc25wRHJwYndnNjQrTTY2Q2s2N0NiN0pXWTdKYTA3SnFVQ2kwZzY0SzA3SjI4SU95NXRPdVRuT3F3a3V5ZHRDRHFzckRzb0p6cmtLQWc3SmlJN0tDVjdKMjA3SmVRN0pxVUlPS0draURyZ3JUc25ienNuWUFnN0xtMDY1T2M2ckNTSU91Q21PcXdnT3VLbENEcmdxRHNuYlRzbDVEc21wUUtDaU1qSXlEdGxaenNucERzbHJUcnBid2c3WktBN0phMDdKT3c2cml3SU95V3RPdWdwT3lhdUNEcXNyM3NtckFLQ2lkNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNjZzdaaVY3WU9jNjZHYzY2ZU1JTzJTZ095V3RPeWttT3VQaENEcmpaUWc3THFRN0tPODdKYTg3WldZNnJLTUlPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1FvdElPeWVsT3lWb1NEcnRvRHNvYkhzbkx6cm9ad2c2cldzNjZlazdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDRGlocElnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNnb3FLaW9LQ2lNaklEWXVJTzJSbk9xNHNDRHRoclhzbmJ3S0NpTWpJeURya0pqc2xyVHNtcFFnS0ZncElPS0draURyajd6c21wUWdLRThwQ2dycnFxanJzSlRzbmJ3ZzdabVU2Nm0wN0oyWUlPeWlnZXlkZ0NEcXM3WHFzSVRzbllRZzZyT2c2NkNrN1pXMElDZnJrSmpzbHJUc21wUW42NHFVSU91cXFPdVJrQ0FuNjQrODdKcVVKK3VobkNEdGhyWHNuYnp0bGJUc2hKd2c3STJvN0tPODdJUzQ3SnFVTGdvS0tpb3FDZ29qSXlBM0xpRHJncURzcDV6Q3QreUxuT3F3aE1LMzdJaXI3SjZRSU8yUm5PcTRzQW9LNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3V5aU8yWXVPdUtsQ0RzbFlUcm5wZ2c3WmlWN0l1ZDdKeTg2NkdjSU8yR3RleWR2TzJWdE95RW5DRHNqYWpzbXBRdUNnb2pJeU1nNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3E0c09xd2hBb0tmQ0R0bGEzcnFxa2dmQ0R0bUpYc2k1MGdmQ0RzbUlqc2k1d2dmQXA4TFMwdExTMHRmQzB0TFMwdExYd3RMUzB0TFMxOENud2c2NEtnN0tlY0lId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVZQ0F2SU95bnArcXlqQ0JnVFUwdVJFUmdJSHdnTWpBeU5TNHdNUzR3TVN3Z01qVXVNREV1TURFZ2ZBcDhJT3lMbk9xd2hDQjhJT3E0c091enVDQmdTRWc2VFUwNlUxTmdJQzhnN0tlbjZyS01JR0JJU0RwTlRXQWdLT3lZcE95Z2hDL3NtS1R0bTRRZzdKV0lJT3lVZ0NrZ2ZDQXhORG96TURveE1Td2dNVE02TXpBZ2ZBcDhJT3E0c09xd2hDQjhJT3E0c091enVDQmdXVmxaV1M1TlRTNUVSSDVaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1dWbFpXUzVOVFM1RVJINU5UUzVFUkdBZ2ZDQXlNREkxTGpBeExqQXhmakl3TWpVdU1ERXVNekVzSURJd01qVXVNREV1TURGK01ERXVNekVnZkFwOElPdUNvT3lubkNBcklPeUxuT3F3aENCOElHQlpXVmxaTGsxTkxrUkVJRWhJT2sxTllDQjhJREl3TWpVdU1ERXVNREVnTVRRNk16QWdmQXA4SU95YWxPeWR2Q0I4SUdCWldWbFpMazFOTGtSRUtPeWFsT3lkdkNsZ0lPS0FsQ0RzbTVRdjdabVVMK3lJbUMvcnFxa3Y2cmlJTCsyR29DL3NuYndnZkNBeU1ESTFMakF4TGpBeEtPeUltQ2tnZkFvS0tpcnNpNXpxc0lRZzdKaUk3Sm00S2lvNklPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDQmc3SmlrN0tDRUwreVlwTzJiaENCSU9rMU5ZT3lkaENEc2phanJqNFFnNjQrODdKcVVMZ3JzbUlncElPeVlwTzJiaENBeE9qQXdDZ29qSXlNZzY2eTQ3SjZsSU95R2pTRHNsN0RzbTVUc25id0tDdXVzdU95ZXBTRHNsWWpzbDVEc2hKenJpcFFnS2lyc201VEN0K3lkdkNEc2xaN3NuWmdnTU95ZGhDRHJ1YnpxczZBcUtpRHNqYWpzbXBRdUNncnNtSWdwQ2kwZ01qQXlOdXVGaENBd09PeWJsQ0F3TmV5ZHZDRHNub1hyaTRqcmk2UXVJT0tHa2lBeU1ESTI2NFdFSURqc201UWdOZXlkdkNEc25vWHJpNGpyaTZRdUNnb2pJeU1nN0lPQjY0eUFJT3lMbk9xd2hDQW82NFc0N0xhYzdKcXBLUW9LZkNEc29iRHFzYlFnZkNEdGtaenF1TEFnZkFwOExTMHRMUzB0ZkMwdExTMHRMWHdLZkNBMk1PeTBpQ0RycjdqcnA0d2dmQ0Ryc0tucXVJZ2c3S0NFSUh3S2ZDQTJNT3UyaENEcnI3anJwNHdnZkNCTzY3YUVJT3lnaENCOENud2dNalRzaTV6cXNJUWc2Nis0NjZlTUlId2dUdXlMbk9xd2hDRHNvSVFnZkFwOElETXc3SjI4SU91dnVPdW5qQ0I4SUU3c25id2c3S0NFSUh3S2ZDQXhNdXF3bk95YmxDRHJyN2pycDR3Z2ZDQk82ckNjN0p1VUlPeWdoQ0I4Q253Z01UTHFzSnpzbTVRZzdKMjA3SU9CSUh3Z1R1dUZoQ0Rzb0lRZ2ZBb0s3SmlJS1NEcnNLbnF1SWdnN0tDRUxDQTE2N2FFSU95Z2hDd2dNdXlMbk9xd2hDRHNvSVFzSURQc25id2c3S0NFTENBMjZyQ2M3SnVVSU95Z2hDd2dNdXVGaENEc29JUUtDaU1qSXlEcnA0anFzSkRDdCtxNHNPcXdoQ0RycDR6cm80d0tDbUJFTFU1Z0tFN3NuYndnNjRLbzdKMk1LU0F2SUdCRUxUQmdLT3lZcE91S21DRHJwNGpxc0pBcElDOGdZRVFyVG1Bb1R1eWR2Q0Rxc3IzcXM3d3BDdXlZaUNrZ1JDMDNMQ0JFTFRFc0lFUXRNQ3dnUkNzeENnb2pJeU1nNjdLSTdaaTRJTzJSbk9xNHNDQW83WldZN0oyMDdaU0k3Snk4NjZHY0lPcTFyT3UyaENrS0Nud2c3Wld0NjZxcElId2c3WmlWN0l1ZElId2c3SmlJN0l1Y0lId0tmQzB0TFMwdExYd3RMUzB0TFMxOExTMHRMUzB0ZkFwOElPeWdoTzJabE91eWlPMll1Q0I4SU8yVm1PeWR0TzJVaUNEcXRhenJ0b1FnZkNBd01pMHhNak0wTFRVMk56Z3NJREF4TUMweE1qTTBMVFUyTnpnZ2ZBcDhJT3k1dE91VG5PdXlpTzJZdUNCOElEVHNucERycHF6c2xLa2c3WldZN0oyMDdaU0lJSHdnTVRJek5DMDFOamM0TFRrd01USXRNelExTmlCOENud2c2ck9FN0tLTTY3S0k3Wmk0SUh3ZzdaV1k3SjIwN1pTSUlPcTFyT3UyaENCOElERXlNeTAwTlRZdE56ZzVNREV5SUh3S2ZDRHNvN3pycjd6cms3SHJvWjNyc29qdG1MZ2dmQ0RzbFo0Z051eWVrT3VtckMzcmtxUWdOK3lla091bXJDQjhJREV5TXpRMU5pMHhNak0wTlRZM0lId0tmQ0RzZ3F6c2w0WHNucERyazdIcm9aM3Jzb2p0bUxnZ2ZDQXhNT3lla091bXJDRHRsWmpzbmJUdGxJZ2dmQ0F3TVMweU16UXROVFkzT0RrZ2ZBb0tJeU1qSU95VHNPdXB0Q0RzbFlnZzY1Q1k2NHFVSU8yUm5PcTRzQW9LTFNEcmdxRHNwNXpzbDVBZzdaV1k3SjIwN1pTSXdyZnJ1WmZxdUlnNklPS2RqQ0F5TURJMUxUQXhMVEF4TENBd01TOHdNUW90SU95TG5PcXdoT3lYa0NEc21LVHNvSVF2N0ppazdadUVPaURpbll3ZzdKaWs3S0NFSURIc2k1d2dLaWpyaTZnc0lPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDRHNtSWpzbWJncEtnb0tLaW9xQ2dvaklPeVlpT3ladUNEcXQ1enN1WmtLQ3V5YmtPeTVtU2pyaXFYcmo1bkN0K3E0amV5Z2xjSzM3THFRN0tPODdKYThLZXV6dE91THBDRHNtSWpzbWJqcXNJQWc2NDJVSU91cWhlMlpsZTJWbkNEc3U2VHJycVRyaTRqc3ZJRHNuYlRzaFpqc25ZUWc2NmVNNjVPYzY0cVVJT3F5dmV5YXNPeVlpT3lhbEM0S0NpTWpJT3lZaU95WnVDQXhMaURzaUpqcmo1bnRtSlVnNjZ5NDdKNmw3SjJFSU95TnFPdVBoQ0Rya0pqcmlwUWc2cks5N0pxd0Nnb2pJeU1nN0lTYzY3bUU3SXFrSU95aWhldWpqQ3dnNnJpdzZyQ0VJT3Vuak91ampBb0s3SWlZNjQrWjdaaVY3Snk4NjZHY0lPeVRzT3VwdENEc283enNsclFvN0tLRjY2T01JT3lFbk91NWhPeUtwQ3dnNnJpdzZyQ0VJT3VUc1NucnBid2c2ckNWN0tHdzdaV2dJT3lJbUNEc25vanFzNkFzSUNmc29vWHJvNHduN0ptQUlDZnJwNHpybzR3bjdKMllJT3VKbU95Vm1leUtwT3VsdkNEc29KWHRtWlh0bm9nZzdLQ0U2NHVzN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnVDA5UElPeUVuT3U1aE95S3BDRHNvb1hybzR3ZzdKV0k2NEswSU9LQWxDQXdNT3libENBd01PeWR2T3UyZ08yRXNDRHNoSnpydVlUc2lxVHFzSUFnN0tLRjY2T002NCs4N0pxVUxpRHNucERzaExqdGxad2c2NEswN0pxcDdKMkVJT3lWak91Z3BPdVRuT3VncE95YWxDNEtMU0RzbnBEc2dyQWc3S0d3N1pxTUlPcTRzT3F3aE95ZHRDRHFzNmNnNjZlTTY2T002NCs4N0pxVUxnb0s2NHVvTENBcUt1eWp2T3E0c095Z2dleWN2T3VobkNEc29vWHJvNHpxc0lBZzY3Q1k2N08xNjVDWTY0cVVJT3lnbk8yU2lDb3E3SmVRNjRxVUlDZnNvb1hybzR6cmo3enNtcFFuNjZXOElPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdUNncnNtSWdwQ2kwZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUlPS0draURzbUtUcmlwanNuWmdnN1lDMDdLYUk2ckNBSU9xenB5RHJnWjNyZ3Bqc21wUUtDaU1qSXlEc2dxenNtcW5zbnBEc2w1RHFzb3dnNjYrNDdMbVk2NHFVSU95WWdlMldwZXlkaENEc2xZenJvS1RzcElRZzY1V01DZ29vN0tPODdKcVVJT3VQbWV5Q3JDQTZJT3lYc095eXRDd2c3WlcwN0tlQUxDRHNvSUhzbXFrZzY1T3hLUW9LN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lUc091cHRDRHNuYmpxczd3ZzZyU0E2ck9FNjZXOElPdXFoZTJabGUyVm1PcXlqQ0RzaEtUcnFvWHRsWmpxczZBc0lDZnNncXpzbXFuc25wRHNuWmdnN1phSjY0K1o3SmVRSU91VXNPdWR2T3lZcE91S2xDRHFzckRxczd3bjY1Mjg2NHFVSU95Z2tPeWRoQ0RzbFl6cm9LVHNwSVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHNtS1RyaXBqcXVZenNwNEFnNjRLMDdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbDdEc3NyVHJqN3pzbXBRdUlPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb3RJT3VNZ095Mm5PeWRoQ0Rxc0lqc2xZVHRnNERycWJRZzdKdVE2NTZZSU91TWdPeTJuT3lkdENEdGxiVHNwNERyajd6c21wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXaWV5WGtDRHJnclRzbGJ3ZzdaVzA3SnFVTGdvS0l5TWpJT3lDck95YXFleWVrQ0RzbFlqc2k2d2dLT3lJbU91UG1lMllsU2tLQ2lmc29KWHJzN1FnN0lpWTdLZVJJT3lWaU91Q3RDY2c2NU94N0oyWUlPdXZ2T3F3a08yVm5DRHNnNEh0bWFuc2w1RHNoSndnS2lyc2k1enNpcVR0aFp6c25iUWc3SjZRNjQrWjdKeTg2NkdjSU95eW1PdW1yTzJWbk91THBPdUtsQ0Rzb0pBcUt1eWRoQ0RzaUpqcmo1bnRtSlhzbkx6cm9ad2c3SldNNjZDa0lPeUNyT3lhcWV5ZWtPdWx2Q0RzbFlqc2k2enRsWmpxc293ZzdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdKMjA3S0NjNjdhQTdZU3dJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWR0Q0RxdUxEcm9aM3JqN3pzbXBRS0xTRHJqWlFnN0tLTDdKMkFJT3lEZ2V1THRPeWRoQ0RzbklUdGxiUWc3WWExN1ptVUlPdUN0T3lhcWV5ZGdDRHJoYm5zbll6cmo3enNtcFFLQ2lNaklPeVlpT3ladUNBeUxpRHFzcjNzbHJUcnBid2c3STJvNjQrRUlPdVFtT3VLbENEcXNyM3NtckFLQ3UyS3VleWdsU0RzZzRIdG1hbnNsNURzaEp3ZzdLQ2M3WldjN0tDQjdKeTg2NkdjSUNmc2k1enJncGpzbXBRL0xDRHNoYWpyZ3Bqc21wUS9KeURzblpqcnJManRtSlVnN0phMDY2KzQ2Nlc4SU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lDck95YXFleWVrT3lkbUNEcnA2WHJuYjNzbllRZzdabWM3SnFwN1pXMDdJU2NJT3luaU91c3VPMlZvQ0RybFl3S0NpZnNpNXpyZ3Bqc21wUS9KeXdnSit5RnFPdUNtT3lhbEQ4bklPMllsZTJEbk95ZG1DRHFzcjNzbHJUcnBid2c3Wm1jN0pxcDdaVzA3SVNjSU95Q3JPeWFxZXlla095ZG1DRHJpN250bWFuc2lxVHJuNnpzbTREc25ZUWc3S1NFN0oyOElPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN1ptTjZyaTQ2NCtaNjR1WUxDQlBUMDhnNjR1azY0V0E3SmlrN0lXbzY0S1k3SnFVUHdvdElPeTJxZXlnaE8yVm1PdWZyQ0R0anJqc25aanNvSkFnNnJDQTdJdWM2NEtZN0pxVVB3b0tJeU1qSU95Q3JPeWFxZXlla095ZG1DRHNnNEh0bWFuc25ZUWc3TGFVN0tDVjdaV2dJT3VWakFvSzY2cUY3Wm1WN1pXY0lPeWdsZXV6dE9xd2dDRHNsNGJzbHJUc2hKd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeW5nZXlna1NEdGpKRHJpNmp0bFpqcXNvd2c3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHN1YlRyazV6cnBid2c2N0NiN0p5ODdJV282NEtZN0pxVVB5RHJrN0hyb1ozdGxaanJxYlFnN0xxUTdJdWM2N0N4SU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SVNnN0oyWTZyQ0FJTzJWaE95YWxPMlZvQ0RybFl3S0N1eUVwT3VzdU95aHNPeUNyT3l5bU91ZnZDRHNncXpzbXFuc25wRHNuWmdnN0lTZzdKMlk2Nlc4SU9xNHNPdU1nTzJWdE95VnZDRHRsYUFnNjVXTUlPcXl2ZXlXdE91aG5DRHNvSlhzcEpIdGxaanFzb3dnN0tlSTY2eTQ3WlcwN0pxVUxnb0s3SmlJS1FvdElPeWR0T3V5aUNEcmk2enNsNUFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm1PdXB0T3lFbkNEc2xyenJwNGpyZ3BnZzY2ZU03S0d4N1pXWTdJV282NEtZN0pxVVB3b0tJeU1nN0ppSTdKbTRJRE11SU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU91UW1PdUtsQ0Rxc3Izc21yQUtDdXlDck95YXFleWVrT3lYa09xeWpDRHJxb1h0bVpYdGxaanFzb3dnNjdhQTdLQ1Y3S0NCN0oyNElPdUN0T3lhcWV5ZGhDRHNsWXpyb0tUc3BKanNsYndnN1pXZ0lPdVZqT3VLbENEcnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyRUlPeU5xT3VQaENEc29vdnNsWVRzbXBRdUNnb2pJeU1nN0lTYzY3bUU3SXFrNjZXOElPeWdsZXl4aGV5RGdTRHNrN2dnN0lpWUlPeVhodXlkaENEcmxZd0tDdXUyZ095Z2xlMllsZXljdk91aG5DRHNqYWpzbGJ3ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU95RGdlMlpxZXlkaENEcnFvWHRtWlh0bFpqcXNvd2c3SjI0N0tlQTdJdWM3WUtzSU95SW1DRHNub2pzbHJUc21wUXVJQ29xN0pPNElPeUltQ0RzbDRicmlwUWc3SjIwN0p5ZzY2VzhJTzJWcU9xN21DRHNsWWpyZ3JUdGxiVHNvN3pzaExqc21wUXVLaW9LQ3V5WWlDa0tMU0RzcDREcXVJanNuWUFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJT3l5cmV5R2pPdUZoT3lkaENEc25JVHRsWndnN0lTYzY3bUU3SXFrNjRxVUlPeVZoT3luZ1NEc3BJRHJ1WVFnN0tTUjdKMjA3SmVRN0pxVUxnb3RJT3F6dGV1c3RPeWJrT3lkZ0NEdG00VHNtNURxdUlqc25ZUWc2N08wNjRLOElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SjI4NjdhQUlPcTRzT3VLcGV1bmpDRHNrN2dnN0lpWUlPeVhodXlkaENEcmxZd0tDdXUyZ095Z2xlMllsZXljdk91aG5DRHNqYWpzbGJ3ZzdJS3M3SnFwN0o2UTZyQ0FJT3lXdE91V3BDRHF1TERyaXFYc25ZUWc3Sk80SU95SW1DRHNsNGJyaXBUc3A0QWc2NnFGN1ptVjdaV1k2cktNSU95ZHVPeW5nTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LN0ppSUtRb3RJT3lna09xeWdDRHF1TERxc0lRZzY0K1o3SldJSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla0NEc2hLRHRnNTNzblpnZzZyS3c2ck84NjZXOElPeVZpT3VDdE8yVm9DRHJsWXdLQ3V1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPeUVvTzJEbmV5ZGdDRHJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzY2cUY3Wm1WN1pXWTZyS01JT3lWak91Z3BPeWFsQzRLQ3V5WWlDa0tMU0R0bFp3ZzY3S0lJT3V3bE9xK3VPdXB0Q0RzdXBEc2k1enJzTEhzbllBZzY0dWs3SXVjSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrS0NpZnNvSlhyczdRZzdJaVk3S2VSSU95VmlPdUN0Q2NnNjVPeDdKMllJT3V2dk9xd2tPMlZuQ0RzZzRIdG1hbnNsNURzaEp3Z0tpcnNvSlhyczdUcXNJQWc2N08wN1ppNDY1Q2M2NHVrNjRxVUlPeWdrQ29xN0oyRUlPdTJnT3lnbGUyWWxleWN2T3VobkNEc2xZenJvS1FnN0lLczdKcXA3SjZRNjZXOElPeVZpT3lMck8yVm1PcXlqQ0R0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ3V5WWlDa0tMU0RzZzRIcmk3VHNuYlFnNjRHZDY0S1k2Nm0wSU95Z2hPdXN1T3F3Z091UGhDRHRtWTNxdUxqcmo1bnJpNWpzblpnZzdLQ1Y2N08wNjZXOElPdXp2Q0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHNvSlhyczdUcXNJQWc2cml3NjZHZDY1Q1k3S2VBSU95Vml1eVZoT3lhbEM0S0NpTWpJT3lZaU95WnVDQTBMaURzb0p6dGtvZ2c3SnFwN0phMDY0cVVJT3V3bE9xK3VPeW5nQ0RzbFlycXVMQUtDaWZxc0lUcXNyRHRsWmpxczZBZzdJbXM3SnEwSU91bmtDY2c3SnVRN0xtWjY3TzA2NHVrSUNvcTdabVU2Nm0wN0oyWUlPcTRzT3VLcGV1cWhjSzM2N0tFN1lxODY2cUY2ck84N0oyWUlPeWFxZXlXdENEc25ienN1WmdxS3Vxd2dDRHNtckRzaEtEc25iVHNsNURzbXBRdUN1cTRzT3VLcGV1cWhleVhrQ0RzazdEc25iZ2c2NHVvN0phMEtPdXpnT3F5dlN3ZzdLZUE3S0NWTENEcms3SHJvWjBnNjVPeEtldWx2Q0RzbFlqcmdyUWc2Nnk0NnJXczdKZVE3SVNjSU91THBPdWx1Q0RycDVEcm9ad2c2N0NVNnI2NDY2bTBJT3lDck95YXFleWVrT3F3Z0NEcmk2VHJwYmdnNnJpdzY0cWw3Snk4NjZHY0lPeVlwTzJWdE8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLU0FuNnJhTTdaV2NJT3V6Z09xeXZTY2c2cml3NjRxbDdKMllJT3lWaU91Q3RDRHJyTGpxdGF3S0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXdsT3EvZ0NEc2lKZ2c3SjZJN0phMDdKcVVJQ2hZS1FvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3T0E2cks5N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cENnb2pJeURzbUlqc21iZ2dOUzRnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NJT3lUc095bmdDRHNsWXJxdUxBS0N1dXN1T3Exck91bHZDRHNsWVRyckxUcnBxd2c2NmVrNjRHRTY1Kzk2cktNSU91THBPdVRyT3lXdE91UGhDQXFLdXlMcE95Z25DRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F3cUt1dWx2Q0RzazdEcnFiUWc3SjZZNjZxNzY1Q2NJT3VzdU9xMXJPeVlpT3lhbEM0S0N1eVlpQ2tnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDQW43TGFVNnJDQUlPeW5nT3lnbFNmdGxaanJpcFFnN0l1YzdJcWs3WVdjN0plUTdJU2NJQ2pzbmJUc29JVEN0K3lXa2V1UGhDRHF1TERyaXFYc25iUWc3SldFNjR1WUtRb3RJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDRHJoSmpxc3Fqc283enNoTGpzbXBRZ0tGZ2c0b0NVSU95WGh1dUtsQ0FuNjRTWTZyaXc2cml3SnlEcXVMRHJpcVhzbllRZzdKV1U3SXVjS1FvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsYlFnN0tPODdJUzQ3SnFVSUNoUEtRbz0nCkRJUj0iJEhPTUUvTGlicmFyeS9BcHBsaWNhdGlvbiBTdXBwb3J0L0NsYXVkZUJyaWRnZSIKcHV0KCkgeyBwcmludGYgJXMgIiQxIiB8IGJhc2U2NCAtRCA+ICIkMiI7IH0KIyDrjZTruJTtgbTrpq0oLmNvbW1hbmQg4oCUIOywveydtCDsoIDsoIjroZwg64ur7Z6YKeydvCDrlYzrp4wg7YKkIOuMgOq4sC4g7YyM7J207ZSEIOyLpO2WieydgCDthLDrr7jrhJDsnbQg64Ko7Jy864uIIOq3uOuDpSDrgZ3rgrjri6QuCmZpbmlzaCgpIHsgY2FzZSAiJDAiIGluICouY29tbWFuZCkgcmVhZCAtbiAxIC1zIC1yIC1wICLslYTrrLQg7YKk64KYIOuIhOultOuptCDri6vtmIDsmpQuIiA8IC9kZXYvdHR5IDI+L2Rldi9udWxsOyBlY2hvOzsgZXNhYzsgZXhpdCAiJDEiOyB9CmVjaG8gIuKUgOKUgCDtgbTroZzrk5wg64uk66asIOyEpOy5mCAobWFjT1MpIOKUgOKUgCIKbWtkaXIgLXAgIiRESVIvc2NyaXB0cyIgfHwgeyBlY2hvICLtj7TrjZQg7IOd7ISxIOyLpO2MqDogJERJUiI7IGZpbmlzaCAxOyB9CnB1dCAiJEI2NF9CUklER0UiICAgIiRESVIvc2NyaXB0cy9jbGF1ZGUtYnJpZGdlLmpzIgpwdXQgIiRCNjRfV0FUQ0hFUiIgICIkRElSL3NjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanMiCnB1dCAiJEI2NF9FWEFNUExFUyIgIiRESVIvcmVjb21tZW5kLWV4YW1wbGVzLm1kIgpwdXQgIiRCNjRfR1VJREUiICAgICIkRElSL3V4LXdyaXRpbmcubWQiCmVjaG8gIuKchSDtjIzsnbwg7ISk7LmYOiAkRElSIgojIEdVSeyXkOyEnCDsl7AgVGVybWluYWzsnYAgUEFUSOqwgCDsooHsnYQg7IiYIOyeiOyWtCDtnZTtlZwg7ISk7LmYIOqyveuhnOulvCDrs7Ttg6Dri6QKZXhwb3J0IFBBVEg9IiRIT01FLy5sb2NhbC9iaW46L29wdC9ob21lYnJldy9iaW46L3Vzci9sb2NhbC9iaW46JFBBVEgiCmlmICEgY29tbWFuZCAtdiBub2RlID4vZGV2L251bGwgMj4mMTsgdGhlbgogIGVjaG8gIuKaoO+4jyAgTm9kZS5qc+qwgCDsl4bslrTsmpQg4oCUIOu4jOudvOyasOyggOyXkOyEnCDri6TsmrTroZzrk5wg7Y6Y7J207KeA66W8IOyXtOqyjOyalC4iCiAgZWNobyAiICAgIExUUyDrsoTsoITsnYQg7ISk7LmY7ZWcIOuSpCDsnbQg7ISk7LmY66W8IOuLpOyLnCDsi6TtlontlbQg7KO87IS47JqULiIKICBvcGVuICJodHRwczovL25vZGVqcy5vcmcva28vZG93bmxvYWQiIDI+L2Rldi9udWxsCiAgZmluaXNoIDAKZmkKTk9ERV9CSU49IiQoY29tbWFuZCAtdiBub2RlKSIKZWNobyAi4pyFIE5vZGUuanM6ICQobm9kZSAtLXZlcnNpb24pIgojIOqwkOyLnOyekCBsYXVuY2hkIOuTseuhnSAo66Gc6re47J24IOyekOuPmeyLnOyekSArIOyngOq4iCDquLDrj5kpLiBQQVRI66W8IHBsaXN07JeQIOq1s+2YgCDrhKPripTri6Qg4oCUIGxhdW5jaGQg6riw67O4IFBBVEjsl5QgY2xhdWRl6rCAIOyXhuuLpC4KUExJU1Q9IiRIT01FL0xpYnJhcnkvTGF1bmNoQWdlbnRzL2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlci5wbGlzdCIKbWtkaXIgLXAgIiRIT01FL0xpYnJhcnkvTGF1bmNoQWdlbnRzIgpTQUZFX1BBVEg9IiR7UEFUSC8vJi8mYW1wO30iCmNhdCA+ICIkUExJU1QiIDw8UExJU1RFT0YKPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPCFET0NUWVBFIHBsaXN0IFBVQkxJQyAiLS8vQXBwbGUvL0RURCBQTElTVCAxLjAvL0VOIiAiaHR0cDovL3d3dy5hcHBsZS5jb20vRFREcy9Qcm9wZXJ0eUxpc3QtMS4wLmR0ZCI+CjxwbGlzdCB2ZXJzaW9uPSIxLjAiPgo8ZGljdD4KICA8a2V5PkxhYmVsPC9rZXk+PHN0cmluZz5jb20uY2xhdWRlYnJpZGdlLndhdGNoZXI8L3N0cmluZz4KICA8a2V5PlByb2dyYW1Bcmd1bWVudHM8L2tleT4KICA8YXJyYXk+CiAgICA8c3RyaW5nPiROT0RFX0JJTjwvc3RyaW5nPgogICAgPHN0cmluZz4kRElSL3NjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanM8L3N0cmluZz4KICA8L2FycmF5PgogIDxrZXk+RW52aXJvbm1lbnRWYXJpYWJsZXM8L2tleT4KICA8ZGljdD48a2V5PlBBVEg8L2tleT48c3RyaW5nPiRTQUZFX1BBVEg8L3N0cmluZz48L2RpY3Q+CiAgPGtleT5SdW5BdExvYWQ8L2tleT48dHJ1ZS8+CiAgPGtleT5LZWVwQWxpdmU8L2tleT48ZGljdD48a2V5PlN1Y2Nlc3NmdWxFeGl0PC9rZXk+PGZhbHNlLz48L2RpY3Q+CjwvZGljdD4KPC9wbGlzdD4KUExJU1RFT0YKbGF1bmNoY3RsIGJvb3RvdXQgImd1aS8kKGlkIC11KS9jb20uY2xhdWRlYnJpZGdlLndhdGNoZXIiIDI+L2Rldi9udWxsCmxhdW5jaGN0bCBib290c3RyYXAgImd1aS8kKGlkIC11KSIgIiRQTElTVCIgMj4vZGV2L251bGwgfHwgbGF1bmNoY3RsIGxvYWQgLXcgIiRQTElTVCIgMj4vZGV2L251bGwKZWNobyAi4pyFIOqwkOyLnOyekCDrk7HroZ3Ct+q4sOuPmSAo66Gc6re47J24IOyekOuPmeyLnOyekSkiCmlmICEgY29tbWFuZCAtdiBjbGF1ZGUgPi9kZXYvbnVsbCAyPiYxOyB0aGVuCiAgZWNobyAiIgogIGVjaG8gIuKaoO+4jyAgQ2xhdWRlIENvZGXqsIAg7JeG7Ja07JqUICjrmJDripQgUEFUSOyXkCDsl4bslrTsmpQpLiDthLDrr7jrhJDsl5DshJw6IgogIGVjaG8gIiAgICAgIG5wbSBpbnN0YWxsIC1nIEBhbnRocm9waWMtYWkvY2xhdWRlLWNvZGUiCiAgZWNobyAiICAgICAgY2xhdWRlIGxvZ2luIgogIGVjaG8gIiAgICDshKTsuZjCt+uhnOq3uOyduOunjCDtlZjrqbQg64Gd7J207JeQ7JqUIOKAlCDsnbQg7ISk7LmY66W8IOuLpOyLnCDsi6TtlontlaAg7ZWE7JqU64qUIOyXhuyWtOyalC4iCmVsc2UKICBlY2hvICLinIUgQ2xhdWRlIENvZGU6ICQoY2xhdWRlIC0tdmVyc2lvbiAyPi9kZXYvbnVsbCB8IGhlYWQgLTEpIgogIGVjaG8gIiIKICBlY2hvICLwn46JIOyEpOy5mCDsmYTro4whIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsl5DshJwgW+y2lOyynOuwm+q4sF3rpbwg64iE66W066m0IO2BtOuhnOuTnOqwgCDsl7DqsrDrj7zsmpQuIgpmaQpmaW5pc2ggMApQSwECHgMUAAAIAAAAAAAAFXT1uo2yAQCNsgEAHgAAAAAAAAAAAAAA7YEAAAAA7YG066Gc65Oc64uk66asLeyEpOy5mC5jb21tYW5kUEsFBgAAAAABAAEATAAAAMmyAQAAAA==";
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
            // 다리가 꺼져 있었다 — 감시자로 깨우고(claudebridge:// 보조), 뜰 때까지 기다렸다 다시 시도한다
            figma.ui.postMessage({ type: 'show-toast', message: '클로드를 연결하는 중이에요 — 잠시 후 로그인 창이 열려요.' });
            try {
                await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000);
            }
            catch (_e) {
                try {
                    figma.openExternal('claudebridge://start');
                }
                catch (_e2) { /* 둘 다 실패 — 아래 재시도가 알려준다 */ }
            }
            for (let i = 0; i < 8 && (!r.ok && !r.data); i++) {
                await new Promise((res) => setTimeout(res, 1500));
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
            figma.ui.postMessage({ type: 'installer-file', b64: INSTALLER_MAC_ZIP_B64, name: '클로드다리-설치.zip', mime: 'application/zip' });
        }
        else {
            figma.ui.postMessage({ type: 'installer-file', b64: INSTALLER_B64, name: '클로드다리-설치.bat', mime: 'application/octet-stream' });
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
