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
        figma.ui.postMessage({ type: 'show-toast', message: emptyNote || '예시·규칙으로 다듬을 곳을 찾지 못했어요. AI 추천을 쓰려면 [클로드] 버튼으로 클로드를 켜 주세요.' });
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
const NAVER_PROXY_URL = 'https://report-admin-weld.vercel.app/api/';
// 오수정 제보 저장/열람은 별도 Vercel 앱(ux-writing-reports)에서 처리한다.
// 저장 API: POST /api/report, 관리자 페이지: https://report-admin-weld.vercel.app/
// (manifest.json allowedDomains에도 이 도메인 추가)
const REPORT_URL = 'https://report-admin-weld.vercel.app/api/report';
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
const BRIDGE_MIN_V = 11;
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
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEcmk2VHJwcXdnN0lTazdMbVlJQ2d4THpJcElPS0FsQ0JPYjJSbExtcHpKeXdnSjA5TFEyRnVZMlZzSnl3Z0oxZGhjbTVwYm1jbktRb2dJQ0FnYVdZZ0tDUnlJQzFsY1NBblQwc25LU0I3SUZOMFlYSjBMVkJ5YjJObGMzTWdKMmgwZEhCek9pOHZibTlrWldwekxtOXlaeTlyYnk5a2IzZHViRzloWkNjZ2ZRb2dJSDBLSUNCbGVHbDBDbjBLYVdZZ0tDMXUNCmIzUWdLRWRsZEMxRGIyMXRZVzVrSUdOc1lYVmtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JDYjNnZ0l1eUVwT3k1bU91S2xDRHJnWjNyZ3F6c2xyVHNtcFF1SU9xM3VPdWZzT3VOc0NCRGJHRjFaR1VnUTI5a1plcXdnQ0RzbDRic2xyVHNtcFFnS091WWtPdUtsQ0JRUVZSSTdKZVFJT3lYaHV5V3RPeWFsQ2t1WUc1Z2J1MkVzT3V2dU91RWtPeVhrT3lFbkNEc2xZVHJucGpycGJ3ZzdJU2s3TG1Zd3Jmcm9aenF0N2pzbmJqdGxad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUTZZRzVnYmlBZ2JuQnRJR2x1YzNSaGJHd2dMV2NnUUdGdWRHaHliM0JwWXkxaGFTOWpiR0YxWkdVdFkyOWtaV0J1SUNCamJHRjFaR1VnYkc5bmFXNWdibUJ1N1ptVjdKMjRPaUR0aExEcnI3anJoSkRzbDVEc2hKd2dZMnhoZFdSbElDMHRkbVZ5YzJsdmJpRHNuYlFnNjdLRTdLQ0U3SjJFSU95Mm5PdWdwZTJWbU91cHRDRHNwSURyDQp1WVFnN0ptRTY2T01MbUJ1S095Q3JPeWFxZXVmaWV5ZGdDRHNuYlFnVUVQc2w1QWc2NkdjNnJlNDdKMjQ2NUNjSU8yQnRPdWhuT3VUbkNEcXRhenJqNFVnN1pXYzY0K0U3SmVRN0lTY0lPeXdxT3F3a091UXFldUxpT3VMcEM0cElpQW43WUcwNjZHYzY1T2NJT3VMcE91bXJDRHNoS1RzdVpnZ0tESXZNaWtnNG9DVUlFTnNZWFZrWlNCRGIyUmxKeUFuVjJGeWJtbHVaeWNLSUNCbGVHbDBDbjBLVTNSaGNuUXRVSEp2WTJWemN5QXRSbWxzWlZCaGRHZ2dKMk50WkM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0p5OWpJRzV2WkdVZ2MyTnlhWEIwYzF4amJHRjFaR1V0WW5KcFpHZGxMbXB6SnlBdFYyOXlhMmx1WjBScGNtVmpkRzl5ZVNBa1pHbHlJQzFYYVc1a2IzZFRkSGxzWlNCSWFXUmtaVzRLUW05NElDTHNoS1RzdVpnZzdKbUU2Nk9NSVNEdGdiVHJvWnpyazV3ZzY0dWs2NmFzNjZXOElPeThzT3lXdE95YWxDNWdibUJ1N0oyMDdLQ2NJTzJVdk9xM3VPdW5pQ0R0bEl6cm42enF0N2pzbmJqc25MenJvWndnNjQrTQ0KN0pXRTZyQ0FJRnZzdHBUc3NwenJzSnZxdUxCZDY2VzhJT3VJaE91bHRPdXB0Q0R0Z2JUcm9aenJrNXpxc0lBZzY0dTE3WlcwN0pxVUxtQnU2NHVrN0oyTTY3YUE3WVN3NjRxVUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHN0cFRzc3B6Q3QrdXlpT3lYclNEdG1aVHJxYlRzbDVBZzY1T2s3SmEwNnJDQTY2bTBJT3lla091UG1leWN2T3VobkNEc3ZKenNwNUhyaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU91THBPdW1yQ0RpZ0pRZzdLU0E2N21FSU95WmhPdWpqQ2NnSjBsdVptOXliV0YwYVc5dUp3PT0NCjo6QlJJREdFOjoNCkx5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDaERiR0YxWkdVZ1FuSnBaR2RsS1NEaWdKUWc3WlM4NnJlNDY2ZUlJTzJVak91ZnJPcTN1T3lkdU9xenZDQkRiR0YxWkdVZ1EyOWtaZXVsdkNEc25vZnJpcFFnNjZHYzdMdXNJT3lMck91MmdPdW1oT3ErdkEwS0x5OGc0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBRFFvdkx5RHNncXpzbXFucnNwVTZJTzJCdE91aG5PdVRuT3VMcE91bXJDM3N2SnpxdUxBdVltRjBJT3VObE91NGxPMkJ0T3VtclNBbzY1aVE2NHFVSUc1d2JTQnlkVzRnWW5KcFpHZGxLUTBLTHk4ZzdMeWM2NUdRDQo2Nm0wSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JiN0xhVTdMS2M2N0NiNnJpd1hlcXdnQ0JIWlcxcGJta2c3WUtrSU95WGh1eWR0T3VQaENEdGdiVHJvWnpyazV6cm9ad2dRVWtnN0xhVTdMS2M3SjJFSU91d20rdUtsT3VMcEM0TkNpOHZEUW92THlEc2hvM3JqNFFnN0lTazZyT0VPaUR0Z2JUcm9aenJrNXpycGJ3ZzdKcVU3TEt0NjZlSTY0dWtJT3lEaU91aG5DRHNpNXpyajVudGxaanJxYlFnTXpCK05ERHN0SWpxc0lBZzZyZTQ2NE9sSU91Q29PeVZoT3F3aE91THBDNE5DaTh2SU9LR2tpRHJpNlRycHF6cnBid2c3THlrSU91VmpDRHRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMkVJTzJWbU91Q21DRHNsN1RzbHJRZzdJT0I3SXVjSU91TWdPcTRzT3lMbk8yQ3BPcXpvQ2h6ZEhKbFlXMHRhbk52YmlEcmpJRHRtWlFnNjZxbzY1T2NLU3dOQ2k4dklDQWc2ckNBN0oyMDY1T2NLK3lZaU95TG5DZ3hNVEhxc2JRcDY0cVVJT3l5cXlEcnFaVHNpNXpzcDREcm9ad2c3WldjSU91eWlPdW5qQ0RzbmIzdG5venJpNlF1SU95ZA0KdE8yYmhDRHNtcFRzc3Ezc25ZQWc2Nnk0NnJXczY2ZU1JT3V6dE91Q3RPdXZnT3VobkNEcnVhRHJwYlRyaTZRdURRb3ZMeURzaExqc2haanNuWUFnTXpEcnNvZ2c3Sk93NjZtMElPeWVyT3lMbk95ZWtlMlZ0Q0RyaklEdG1aVHFzSUFnNjZ5MDdaV2M3WjZJSU9xNHVPeVd0T3luZ091S2xDRHFzb1BzbllRZzY2ZUo2NHFVNjR1a0xnMEtMeThOQ2k4dklPeWdoT3lnbkRvZzdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0NjQrOElPeWVpT3lkaENEcXNvTWdLR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3Snk4NjZHY0lPMlpsZXlkdUNrTkNpOHZJT3lqdk95ZG1Eb2c3SUtzN0pxcDY1K0o3SjJBSU9xd2dleWVrQ0R0Z2JUcm9aenJrNXdnNnJXczY0K0ZJTzJWbk91UGhPeVhrT3lFbkNEc3NLanFzSkRya0p6cmk2UXVEUW9OQ21OdmJuTjBJR2gwZEhBZ1BTQnlaWEYxYVhKbEtDZG9kSFJ3SnlrN0RRcGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0RRcGoNCmIyNXpkQ0J2Y3lBOUlISmxjWFZwY21Vb0oyOXpKeWs3RFFwamIyNXpkQ0J3WVhSb0lEMGdjbVZ4ZFdseVpTZ25jR0YwYUNjcE93MEtZMjl1YzNRZ2V5QnpjR0YzYml3Z2MzQmhkMjVUZVc1aklIMGdQU0J5WlhGMWFYSmxLQ2RqYUdsc1pGOXdjbTlqWlhOekp5azdEUW9OQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRURRb3ZMeURycDZRZzdZUzBJT3luaXV5V3RPeWd1T3lFbkNBME5leTBpQy90aExUcXVZenNwNEFnNjRxUTY2Q2s3S2VFNjR1a0lDanJ1WWdnN1krMDY0MlVJQ3NnNjdhQTZyQ0E2cml3NjRxbElPeXdxT3VMcU95ZHRPdXB0Q0IrTSt5MGlDL3RoTFFwTGcwS1kyOXVjM1FnUlUxUVZGbGZRMWRFSUQwZ2NHRjBhQzVxYjJsdUtHOXpMblJ0Y0dScGNpZ3BMQ0FuWTJ4aGRXUmxMV0p5DQphV1JuWlMxamQyUW5LVHNOQ25SeWVTQjdJR1p6TG0xclpHbHlVM2x1WXloRlRWQlVXVjlEVjBRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbElIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlEwS1kyOXVjM1FnUTB4QlZVUkZYMFZPVmlBOUlFOWlhbVZqZEM1aGMzTnBaMjRvZTMwc0lIQnliMk5sYzNNdVpXNTJMQ0I3RFFvZ0lFMUJXRjlVU0VsT1MwbE9SMTlVVDB0RlRsTTZJQ2N3Snl3Z0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDOHZJT3lEbmVxd2dTRHJxcWpyazV3ZzY0R1VJQ2pzcDZmc25ZQWc2Nnk0NnJXczdKZVVJT3UyaU8yVmhPeWFsQ2tOQ2lBZ1EweEJWVVJGWDBOUFJFVmZSRWxUUVVKTVJWOU9UMDVGVTFORlRsUkpRVXhmVkZKQlJrWkpRem9nSnpFbkxDQXZMeUR0aExRZzdKcVU3Slc5SU91VHNTRHJ0b0Rxc0lBZzdaaTQ3TGFjSU91QmxBMEtJQ0JFU1ZOQlFreEZYMVJGVEVWTlJWUlNXVG9nSnpFbkxBMEtmU2s3RFFvTkNtTnZibk4wSUZCUFVsUWdQU0JPZFcxaQ0KWlhJb2NISnZZMlZ6Y3k1bGJuWXVRbEpKUkVkRlgxQlBVbFFwSUh4OElERXhPRGc0T3lBdkx5QkNVa2xFUjBWZlVFOVNWT3VLbENEdGhZenNpcVR0aXJqc21xa2dLTzJQaWV5R2pPeVhsQ0F4TVRnNE9DRHFzNkRzb0pVcERRb3ZMeURyaTZUcnBxd2c3TDJVNjVPY0lPdXloT3lnaENEaWdKUWdMMmhsWVd4MGFPdWhuQ0RyaGJqc3RwenRsWnpyaTZRdUlPeTlsT3VUbk91bHZDQndkV3hzd3JmcnM3WHNncXp0bGJUcmo0UWdLaXJzbmJUcnI3Z2c2NWFnSU95ZWlPdUtsQ0RyaTZUcnBxenJpcFFnN0ppYklPeTlsT3VUbkNEcXQ3anJqSURyb1p3cUt1dWR2QTBLTHk4ZzZydVE2NHVrSU95OG5PcTRzQ0Rzb0lUc2w1UWc3SU9JSU91UG1leWVrZXlkdENEc2xZZ2c2NEtZN0ppbzY0dWtLTzJFc091dnVPdUVrT3lkdENEcm5LanJpcFFnNjVPeEtTNGc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeWR0Q0Rxc0pMc25MenJvWndnNnJXczY3S0U3S0NFN0oyRUlPcXdrT3luZ08yVnRDRHNucXpzaTV6c25wSHNpNXp0Z3Fqcmk2UXUNCkRRb3ZMeURyajVuc25wSHNuYlFnNjdDVTY0Q002NHFVSU95SW1PeWdsZXlkaENEdGxaanJxYlFnN0oyMElPeUlxK3lla091bHZDRHNtS3pycHF6cXM2QWdZMjlrWlM1MGMreWRtQ0JDVWtsRVIwVmZUVWxPWDFicmo0UWc2ckNaN0oyMElPeVlyT3Vtc091THBDNE5DbU52Ym5OMElFSlNTVVJIUlY5V0lEMGdNVEU3RFFvdkx5RHF1TERyczdnZzY2cW82NDI0TGlEc21wVHNzcTBvN1pTTTY1K3M2cmU0N0oyNEtleWR0Q0J0YjJSbGJPeWRoQ0RzcDREc29KWHRsWmpycWJRZzZyZTRJT3lhbE95eXJldW5qQ0RxdDdnZzY2cW82NDI0NjZHY0lPeXltT3Vtck8yVm5PdUxwQzROQ2k4dklHaGhhV3QxUGV1NW9PdW1oQy9xc0lEcnNyenNtNEFzSUhOdmJtNWxkRDNzcEpIcXNJUXNJRzl3ZFhNOTZyaXc2N080S095MW5PcXpvTzJTaU95bmlDd2c3S0d3NnJpSUlPdUtrT3VtdkNrTkNtTnZibk4wSUVOTVFWVkVSVjlOVDBSRlRDQTlJSEJ5YjJObGMzTXVaVzUyTGtKU1NVUkhSVjlOVDBSRlRDQjhmQ0FuYjNCMWN5YzdEUXBqDQpiMjV6ZENCQlRFeFBWMFZFWDAxUFJFVk1VeUE5SUZzbmFHRnBhM1VuTENBbmMyOXVibVYwSnl3Z0oyOXdkWE1uWFRzTkNtTnZibk4wSUZSVlVrNWZWRWxOUlU5VlZGOU5VeUE5SURrd01EQXdPeUFnSUM4dklPeWFsT3l5clNBeDZyRzBJT3lnbk8yVm5PeUxuT3F3aEEwS1kyOXVjM1FnVFVGWVgxUlZVazVUSUQwZ016QTdJQ0FnSUNBZ0lDQWdJQ0FnTHk4ZzdKMjA2NmVNN1lHOElPeVRzT3VwdENEc2hManNoWmdnN0o2czdJdWM3SjZSSUNqcmpJRHRtWlFnNjRpRTdLQ0JJT3V3cWV5bmdDa05DZzBLTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPY0lDaHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FnNG9DVUlHSjFhV3hrTFdkc2IzTnpZWEo1TG1wejdKbUFJT3F3bWV5ZGdDRHRqSXpzaEp3cElPS1VnT0tVZ0EwS1puVnVZM1JwYjI0Z2JHOWhaRVY0WVcxd2JHVnpLQ2tnZXcwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHMWtJRDBnWm5NdWNtVmhaRVpwYkdWVGVXNWpLSEJoZEdndQ0KYW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FuS1N3Z0ozVjBaamduS1RzTkNpQWdJQ0JqYjI1emRDQnpaV05KWkhnZ1BTQnRaQzV6WldGeVkyZ29MMTRqSXlEc3RwVHNzcHdnN0ppSTdJdWNYSE1xSkM5dEtUc05DaUFnSUNCcFppQW9jMlZqU1dSNElEMDlQU0F0TVNrZ2NtVjBkWEp1SUZ0ZE93MEtJQ0FnSUdOdmJuTjBJR1Y0WVcxd2JHVnpJRDBnVzEwN0RRb2dJQ0FnYkdWMElHTjFjaUE5SUc1MWJHdzdEUW9nSUNBZ1ptOXlJQ2hqYjI1emRDQnlZWGNnYjJZZ2JXUXVjMnhwWTJVb2MyVmpTV1I0S1M1emNHeHBkQ2duWEc0bktTa2dldzBLSUNBZ0lDQWdZMjl1YzNRZ2JHbHVaU0E5SUhKaGR5NXlaWEJzWVdObEtDOWNjeXNrTHl3Z0p5Y3BPdzBLSUNBZ0lDQWdZMjl1YzNRZ2FDQTlJR3hwYm1VdWJXRjBZMmdvTDE0akl5TmNjeXNvTGlzL0tWeHpLaVF2S1RzTkNpQWdJQ0FnSUdsbUlDaG9LU0I3SUdOMWNpQTlJSHNnYVc1d2RYUTZJR2hiTVYwc0lITjENCloyZGxjM1JwYjI1ek9pQmJYU0I5T3lCbGVHRnRjR3hsY3k1d2RYTm9LR04xY2lrN0lHTnZiblJwYm5WbE95QjlEUW9nSUNBZ0lDQmpiMjV6ZENCaUlEMGdiR2x1WlM1dFlYUmphQ2d2WGx4ektpMWNjeXNvTGlzL0tWeHpLaVF2S1RzTkNpQWdJQ0FnSUdsbUlDaGlJQ1ltSUdOMWNpa2dZM1Z5TG5OMVoyZGxjM1JwYjI1ekxuQjFjMmdvWWxzeFhTNXpjR3hwZENnbklDOGdKeWt1YW05cGJpZ25JQ2NwS1RzTkNpQWdJQ0I5RFFvZ0lDQWdjbVYwZFhKdUlHVjRZVzF3YkdWekxtWnBiSFJsY2lnb1pTa2dQVDRnWlM1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ1BpQXdLVHNOQ2lBZ2ZTQmpZWFJqYUNBb1pTa2dldzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbUlqc2k1d2c3SUtzN0tDRUlPdWhuT3VUbkNEc2k2VHRqS2dnS095WGh1eWR0Q0RzcDRUdGxva3BPaWNzSUdVdWJXVnpjMkZuWlNrN0RRb2dJQ0FnY21WMGRYSnVJRnRkT3cwS0lDQjlEUXA5RFFvTkNpOHZJT0tVZ09LVWdDRHNwNERzDQppNXpyckxnZ0tPeUVuT3V5aENCeVpXTnZiVzFsYm1Uc21ZQWc2ckNaN0oyQUlPcTNuT3k1bVNEaWdKUWc2N0NVNnI2NDY2bTBJT3EzdU95cXZldVBoQ0R0bGFqcXU1Z3BJT0tVZ09LVWdBMEtMeThnN0pxcDdKYTA3S2VSS0dkc2IzTnpZWEo1TG0xa0tleWRnQ0RzbmJ6cnRvRHJuNndnN1pTRTY2R3M3WlNFN1lxNDdKZVFJT3lWaUNEcmhLUHJpcFRyaTZRb01qQXlOaTB3TnlEc2k2VHN1S0VwT2lEcmhLUHNuTHpycWJRZzdZRzA2NkdjNjVPYzZyQ0FJT3lhcWV5V3RDRHF0WkRzb0pYc25ZUU5DaTh2SU95anZDRHNub1RyckxUcm9ad2c3SmlrN1pXMDdaVzBJRFBxc0p3ZzdLQ2M3SldJN0oyMElPeWdoT3UyZ0NBaTdaR2M2cml3SU9xem9PeTVxQ0FySU95V3RPeUluQ0RyczREcXNyMGk3SjIwSU91UW5PdUxwQzRnN0pldDdaV2dJT3UyaE91bXJDRGlnSlFOQ2k4dklPMkJ0T3Vobk91VG5DQTlJT3VzdU95ZXBTRHJpNlRyazZ6cXVMQW83TEM5N0oyWUtTd2c3SnFwN0phMElPMkd0ZXlkdk1LMzY2ZWU3TGFrNjdLVg0KSUQwZ1kyOWtaUzUwY3lCeVpXWnBibVZCYVZOMVoyZGxjM1JwYjI1eklPMmJoT3l5bU91bXJDanF1TERxczRUc29JRXBMZzBLWTI5dWMzUWdVMVJaVEVWZlVsVk1SVk1nUFNCYkRRb2dJQ2N4TGlEdGxiVHNtcFRzc3JRNklPdXFxT3VUb0NEcnJManF0YXpyaXBRZzdaVzA3SnFVN0xLMDY2R2NMaUFvNjdPMDY0T0Y2NHVJNjR1azRvYVM2N08wNjRLMDdKcVVLU2NzRFFvZ0lDY3lMaURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3T2lEcmtKRHNsclRzbXBUaWhwTHRsb2pzbHJUc21wUXNJSDdzbDRnZzY3bTg2cml3S091d2xPdUFqT3lYaU95V3RPeWFsT0tHa3V1d2xPcS9xT3lXdE95YWxDa3VJT3VMcUN3ZzdLS0Y2Nk9Nd3JmcnA0enJvNHpDdCt5WHNPeXl0TUszN1pXMDdLZUF3cmZxdUxEcm9aM0N0K3VGdWV5ZGpDRHJrN0VnN0l1YzdJcWs3WVdjN0oyMElPeWp2T3l5dE95ZHVDRHFzckRxczd6cmlwUWc3SWlZNjQrWjdaaVZJT3ljb095bmdDanNsN0Rzc3JUcmo3enNtcFFzSU91RnVleWRqT3VQdk95YWxDa3UNCkp5d05DaUFnSnpNdUlPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQTZJQ0orN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFFpSU91TWdPeUxvQ0FpZnUyVm1PdXB0Q0R0bGFBZzdJaVlJT3llaU95V3RPeWFsQ0lnNnJXczdLR3dJT3lhc095RW9DNGc2NHVvTENEc29KWHNzWVhzZzRFZzY3YUk2ckNBd3Jmc25ienJ0b0FnNnJpdzY0cWxJT3lnbk8yVm5NSzM2NUNZNjQrTTY2YTBJT3lJbUNEc2w0YnJpcFFnNnJLdzZyTzh3cmZzb0pYcnM3UWc2N08wN1ppNElPeVZpT3lMck95ZGdDRHJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzY2cUY3Wm1WN1o2SUxpY3NEUW9nSUNjMExpRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBPaUIrN1pXWTdJdWM2cktnN0phMDdKcVVQK0tHa243dGxhRHF1WXpzbXBRL0xDRHFzNFRzaTV6cmk2VGlocExzbm9qcmk2UXNJT3lYck95dGlPdUxwT0tHa3UyWmxleWR1TzJWbU91THBDd2c2cnVZNG9hUzdKZVE2cktNTGlCKzdJdWNJT3U1dk9xNHNPcXdnQ0RzbHJUc2c0bnRsWmpycWJRZzdZeU03SldGDQo3WldZNjZDazY0cVVJT3lnbGV1enRPdWx2Q0Rzbzd6c2xyVHJvWndnNjZ5NDdKNmw3SjJFSU91THBPeUxuQ0RzazdUcmk2UXVKeXdOQ2lBZ0p6VXVJT3VxaGV5Q3JDdnJxb1hzZ3F3ZzZyaUk3S2VBT2lEdGxaenNucERzbHJUcnBid2c3WktBN0phMElPdVBtZXlDck91aG5DanNuYlRzbnBBZzdabVk2N2FJN0oyRUlPdXdtK3lWbU95V3RPeWFsT0tHa3V5ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRcExDRHN0WnpzaG96dGxad2dlK3VxaGV5Q3JIM3FzSUFnZSt1cWhleUNySDN0bGJUc2hKd2c3WmlWN1lPYzY2R2NLT3llbE95Vm9TRHJ0b0Rzb2JIc25MenJvWnppaHBMc25wVHNsYUhzbmJRZzY3YUE3S0d4N1pXMDdJU2NLUzRuTEEwS0lDQW5OaTRnN1pHYzZyaXdPaURya0pqc2xyVHNtcFRpaHBMcmo3enNtcFF1Snl3TkNpQWdKemN1SU95a2hDRHF0YXpzb2JBNklPeWJrT3V6dU95ZHRDRHRsWndnN0tTRTdKMjA2Nm0wSU95MmxPeXluT3VQaENEcnNKanJrNXpzaTV3ZzdaV2NJT3lraE91aA0KbkM0ZzdKNkU3SjJZNjZHY0lPeWtoT3lkaENEcmlwanJwcXpzcDRBZzdKV0s2NHFVNjR1a0xpRHJpNmdzSU95WHJPdWZyQ0Ryckxqc25xWHNuWVFnN1pXWTY0S1k3SjJZSU9xNGpleWdsZTJZbFNEcnJManNucVhzbkx6cm9ad2c3WldwN0xPUUlPdU5sQ0Rxc0lUcXNyRHRsYlRzcDRUcmk2VHJxYlFnN0tTRUlPeUltT3VsdkNEc3BJVHNuYlRyaXBRZzZyS0Q3SjJBSU8yWm1PeVlnUzRuTEEwS0lDQW5PQzRnNjR1azdKMjA3SmE4NjZHYzZyZTRJT3ladk95cXZTRHJzb1R0aXJ3ZzY1Mjg2N0tvN0oyQUlDTHJpNnZxdUxBaUtPeTNxT3lHakNEcXVJanNwNEFwTGljc0RRb2dJQ2M1TGlEc25iVHJwb1RDdCt5Z2hPMlpsT3V5aU8yWXVNSzM2NmVJN0lxazdZSzU3SjJBSU9xM3VPdU1nT3VobkNEcnM3VHNvYlF1SU95Q3JPdWVqT3lkaENEcnRvRHJwYndnNjVXUUlPdUxtT3lkaENEcnRwbnNsNnpyajRRZzdLS0w2NHVrTGljc0RRb2dJQ2N4TUM0ZzdLQ2M3WktJSU95YXFleVd0Q0RzbktEc3A0QTZJT3llaGV1Z3BleVgNCmtDRHNrN0RzbmJnZzZyaXc2NHFsN0lTeElPdXFoZXlDckNqcnM0RHFzcjBzSU95bmdPeWdsU3dnNjVPeDY2R2RMQ0R0bGJUc29Kd2c2NU94S2V1S2xDRHRtWlRycWJUc25aZ2c2cml3NjRxbDY2cUZ3cmZyc29UdGlyenJxb1hzbmJ3ZzZyQ0E2NHFsN0lTeDdKMjBJT3VHa3V5Y3ZPdXZnT3VobkNEc2lhenNtclFnNjZlUTY2R2NJT3V3bE9xK3VPeW5nQ0RzbFlycmlwVHJpNlF1SU95TG5PeUtwTzJGbkNEcmo1bnNucEhxczd3ZzY0dWs2Nlc0SU91UG1leUNyT3VsdkNEc2c0anJvWndnNjZlTTY1T2s3S2VBSU95Vml1dUtsT3VMcEM0bkxBMEtYUzVxYjJsdUtDZGNiaWNwT3cwS0RRcGpiMjV6ZENCRldFRk5VRXhGVXlBOUlHeHZZV1JGZUdGdGNHeGxjeWdwT3cwS0RRb3ZMeURpbElEaWxJQWc3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Rzb0lUcnJMZ2c2NkdjNjVPY0lDaDFlQzEzY21sMGFXNW5MbTFrSU9LQWxDRHNtSWpzbWJnZzZyZWM3TG1aSU95RXVPdTJnQ0RzaTV6cmdwanJwcXpzbUtUcXVZenNwNEFnDQo3WlNFNjZHczdaU0U3WXE0N0plUUlPMlByTzJWcUNrZzRwU0E0cFNBRFFvdkx5QlRWRmxNUlY5U1ZVeEZVeUF4TU95a2hDRHNtcFRzbGIzcnA0enNuTHpyb1p6cmlwUWc3SmlJN0ptNElERitNeWpzaUpqcmo1bnRtSlhDdCtxeXZleVd0TUszNjdhQTdLQ1Y3WmlWSU8yWGlPeWFxU0RzdklEc25iVHNpcVFwN0oyWUlPdUptT3lWbWV5S3BPcXdnQ0RzbktEc2k2VHJrSnpyaTZRdURRb3ZMeUR0akl6c25ienNuYlFnN0plRzdKeTg2Nm0wS095RXBPeTVtT3V6dUNEcXRhenJzb1Rzb0lRZzY1T3hLU0RydVlnZzY2eTQ3SjZRN0plMElPS0FsQ0RzbXBUc2xiM3JwNHpzbkx6cm9ad2c2NCtaN0o2UktHWmhhV3d0YzI5bWRDa3VEUXBtZFc1amRHbHZiaUJzYjJGa1IzVnBaR1VvS1NCN0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnWTI5dWMzUWdiV1FnUFNCbWN5NXlaV0ZrUm1sc1pWTjVibU1vY0dGMGFDNXFiMmx1S0Y5ZlpHbHlibUZ0WlN3Z0p5NHVKeXdnSjNWNExYZHlhWFJwYm1jdWJXUW5LU3dnSjNWMFpqZ25LUzUwY21sdA0KS0NrN0RRb2dJQ0FnY21WMGRYSnVJRzFrTG14bGJtZDBhQ0ErSURFd01DQS9JRzFrSURvZ0p5YzdEUW9nSUgwZ1kyRjBZMmdnS0dVcElIc05DaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Ryb1p6cms1d2c3SXVrN1l5b0lDanNtcFRzbGIzcnA0enNuTHpyb1p3ZzdLZUU3WmFKS1RvbkxDQmxMbTFsYzNOaFoyVXBPdzBLSUNBZ0lISmxkSFZ5YmlBbkp6c05DaUFnZlEwS2ZRMEtZMjl1YzNRZ1IxVkpSRVVnUFNCc2IyRmtSM1ZwWkdVb0tUc05DZzBLWm5WdVkzUnBiMjRnYVc1emRISjFZM1JwYjI1TlpYTnpZV2RsS0NrZ2V3MEtJQ0JqYjI1emRDQm1aWGRUYUc5MElEMGdSVmhCVFZCTVJWTXViV0Z3S0NobGVDa2dQVDRnSjBsdWNIVjBPaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvWlhndWFXNXdkWFFwSUNzZ0oxeHVUM1YwY0hWME9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29aWGd1YzNWbloyVnpkR2x2Ym5NcEtTNXFiMmx1S0NkY2JpY3ANCk93MEtJQ0J5WlhSMWNtNGdLQTBLSUNBZ0lDZnNwNERxdUlqcnRvRHRoTEFnNjRTSTY0cVVJT3lYa095S3BPeWJrQ2hUTFRFc0lPdXp0T3lWaU8yYWpPeUNyQ25zblpnZzdaV2M2cld0N0phMElGVllJRmR5YVhScGJtY2c3S0NFNjZ5NDZyQ0E2NkdjSU95ZHZPMlZuT3VMcEM0Z0p5QXJEUW9nSUNBZ0ordUN0T3F3Z0NCVlNTRHJyTGpxdGF6cnBid2c3WldZNjRLWTdKU3BJT3V6dE91Q3RPdXB0Q3dnN0pXRTY1NllJT3lLcE8yRGdPeWR2Q0RxdDV6c3VabnNsNUFnNjZlZTZyS01JT3VMcE91VHJPeWRnQ0RyaklEc2xZZ2dNK3F3bk91bHZDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc05DaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJEUW9nSUNBZ0oreWJrT3VlbUNEc25aanJyN2pzbVlBZzY2cW82NU9nSU95Z2xldXp0Q2pzDQpuYlRycG9UQ3QreUlxK3lla01LMzdLR3c2ckcwd3JmcmpJRHNnNEVwNjZXOElPeWNvT3luZ08yVm1PcXpvQ3dnNnJDQklPeWduT3lWaU95ZGdDRHNtNURyczdqcXM3enJqNFFnN0lTYzY2R2M3Sm1BNjQrRUlPdUxyT3Vkdk95VnZDRHRsWnpyaTZRdUlDY2dLdzBLSUNBZ0lDZnNvYkRxc2JRZzdaR2M3WmlFS095ZHRPeURnY0szN0oyMDdaV1l3cmZzbmJUcmdyVEN0K3kwaU9xenZNSzM2Nis0NjZlTXdyZnJ0b0R0aExEQ3QrcTVqT3luZ0NEcms3RXA3SjJBSU95Z2xleXhoU0Rzb0pYcnM3VHJpNlFnNG9DVUlPdTV2T3F4c091Q21DRHJpNlRycGJnZzdLR3c2ckcwN0p5ODY2R2NJT3V3bE9xK3VPeW5nQ0RycDRqcm5id29Jalh0bW93ZzdKMjA3SU9CSXV5ZGhDQWlOZTJhakNMcm9ad2c3S1NFN0oyMDY2bTBJT3lZcE91THRTa3VJQ2NnS3cwS0lDQWdJQ2ZzbTVEcnJManNsNUFnN0plRzY0cVVJT3Exck95eXRDRHNvSlhyczdRbzdLQ0U3Wm1VNjdLSTdaaTR3cmRWVWt6Q3QrcTRpT3lWb2NLMzdJdWM2ckNFSU91VA0Kc1Nuc21ZQWc3WlcwNnJLd0lPdXdxZXV5bGNLMzdLQ0k3TENvS095ZXJPeUVwT3lnbGNLMzY2eTQ3SjJZN0xLWXdyZnNucXpzaTV6cmo0UWc2NU94S2V1bHZDRHNwNERzbHJUcmdyUWc2N2FaN0oyMDY0cVVJT3F5Zyt5ZGdDRHNvSWpyaklBZzZyaUk3S2VBSU9LQWxDRHNsWVRyaXBRZzZyQ1M3SjIwNjUyODY0K0VMQ0RxdDdqcm43VHJrNi90bGJUcmo0UWc3Sk93N0tlQUlPdW5pT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDY3o2ckNjSU95Z25PeVZpT3lkZ0NEc2hKenJvWndnN0tDUjZyZTg3SjIwSU91THJPdWR2T3lWdkNEdGxaenJpNlFnNG9DVUlPMlZtT3VDbU91S2xDRHNtNURyckxnZzZyV3M3S0d3NjZXOElPeWNvT3luZ08yVm5DRHN0WnpzaG93ZzY0dWs2NU9zNnJpd0xDRHRsWmpyZ3BqcmlwUWc2Nnk0N0o2bElPcTFyT3loc091bHZDRHNucXpxdGF6c2hMSHRsWndnNjR5QTdKV0lMQ0FuSUNzTkNpQWdJQ0FuNnJlNDY2YXM2ck9nSU95Z2dleVd0T3VQaENEdGxaanJncGpyaXBRZzZyTzg2ckNRN1pXY0lPeWUNCnJPcTFyT3lFc1RvZzdLU1I2N08xSU8yUm5PMlloT3lkaENEcmpaenNsclRyZ3JUcXM2QXNJT3lnbGV1enRDRHNpSnpzaEp6cnBid2c3SUtzN0pxcDdKNlE2ckNBSU95VmpPeVZoT3lWdkNEdGxhQWc2cktENjdhQTdZU3c2NkdjSU95ZXJPeWhzT3luZ2UyVm9DRHFzb011SUNjZ0t3MEtJQ0FnSUNmc201RHJyTGpzbmJRZzdaVzA2ckt3SU91d3FldXlsZXlkaENEcmk3VHFzNkFnN0o2STdKMkVJT3VWak91bmpDQWk3SmEwNjVhNzZyS01JTzJWbU91cHRDRHJpNlRzaTV3ZzY1Q2M2NHVrSXV1bHZDRHNsWjdzaExqc21yRHJpcFFnNnJpTjdLQ1Y3WmlWSU95ZXJPcTFyT3lFc2V5ZGhDRHRsWmpybmJ3ZzRvQ1VJT3lia091c3VPeVhrQ0R0bGJUcXNyRHNzWVhzbmJRZzdKZUc3Snk4NjZtMElPdW5qT3VUcE95V3RDRHJ0cG5zbmJUc3A0QWc2NmVJNjUyOExpQW5JQ3NOQ2lBZ0lDQW43WkdjNnJpd3dyZnNtcW5zbHJUcnA0d2c2ck9nN0xtWTZyT2dJT3lXdE95SW5PeWRoQ0Ryc0pUcXZyd2c3S0NWNjQrRTdKMllJT3lnDQpuT3lWaU95ZGhDQXo2ckNjSU91S21PeVd0T3VHayt5bmdDRHJwNGpybmJ3ZzRvQ1VJT3EzdU9xeHRDRHNncXpzbXFuc25wRHNsNURxc293ZzdMYVU3TEtjN0oyMElPeVZoT3VMaU91ZHZDRHF0WkRzb0pYc25MenJvWndnNjdPMDdKMjQ2NHVrTGlBbklDc05DaUFnSUNBbjdKV0U2NTZZSU95WWlPeUxuT3VUcE95ZGdDRHRsWndnN0tTRTdLZWM2NmFzSU95MW5PeUdqQ0RxdFpEc29KWHNuYlFnNjZlTzdLZUE2NmVNSU9xM3VPcXh0Q0R0aHFRbzdaVzA3SnFVN0xLMHdyZnFzcjNzbHJRcDdKMllJT3Exa091enVPeWR0T3luZ0NEc2hvenF0N25zaExIc25aZ2c2cldRNjdPNDdKMjBJT3lWaE91TGlPdUxwQ0RpZ0pRZzdKZXM2NStzSU91c3VPeWVwZXlubk91bXJDRHNub1hyb0tYc25ZQWc2Nm1VN0l1YzdLZUFJT3VMcU95Y2hPdWhuQ0RyaTZUc2k1d2c3SVNrNnJPRTdaV1k2NTI4TGx4dUp5QXJEUW9nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURyc0xEc2w3VHJwNHdnN0xhYzY2Q2w3WldjNjR1aw0KTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhjSzM3TDJVNjVPYzdZNmM3SXFrSU9xNGlPeW5nRHBjYmljZ0t3MEtJQ0FnSUNkYmV5SjBaWGgwSWpvZ0l1eWduT3lWaUNEcnJManF0YXdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0luSmxZWE52YmlJNklDTHJyTFRzbDRmc25ZUWc3Sm1jSU91d2xPcS9xT3VLbE95bmdDRHRsWnpxdGEzc2xyUWc3WldjSU91c3VPeWVwU0o5TENBdUxpNWRYRzVjYmljZ0t3MEtJQ0FnSUNkYjdJcWs3WU9BN0oyOElPcTNuT3k1bVYxY2JpY2dLeUJUVkZsTVJWOVNWVXhGVXlBcklDZGNibHh1SnlBckRRb2dJQ0FnS0VkVlNVUkZJRDhnSjF2c2lxVHRnNERzbmJ3ZzZyQ0E3SjIwNjVPY0lPeWdoT3VzdUNBb2RYZ3RkM0pwZEdsdVp5NXRaQ2tnNG9DVUlPeWNoQ0RxdDV6c3VabnNuWmdnNnJlODZyR3c3Sm1BSU95WWlPeVp1Q0RzaTV6cmdwanJwcXpzbUtRdUlPMkt1ZTJlaUNEc21JanNtYmdnNnJlYzdMbVpLT3lJbU91UG1lMllsY0szNnJLOTdKYTB3cmZydG9Ec29KWHQNCm1KWHNuWVFnN0p5ZzdLZUE3WlcwN0pXOElPMlZtT3VLbENEc2c0SHRtYWtwN0oyRUlPcTN1T3VNZ091aG5DRHJsTERycGJUcXM2QXNJT3lhbE95VnZlcXp2Q0Rzb0lUcnJManNuYlFnNjR1azY2VzA2Nm0wSU95Z2hPdXN1T3lkaENEcmxMRHJwYmpyaTZSZFhHNG5JQ3NnUjFWSlJFVWdLeUFuWEc1Y2JpY2dPaUFuSnlrZ0t3MEtJQ0FnSUNobVpYZFRhRzkwSUQ4Z0oxdnNtckRycHF3ZzY2cXA3SWFNNjZhc0lPeVlpT3lMbkNEaWdKUWc3SjIwSU8yR3BPeWRoQ0RybExEcnBid2c2cktEWFZ4dUp5QXJJR1psZDFOb2IzUWdLeUFuWEc1Y2JpY2dPaUFuSnlrZ0t3MEtJQ0FnSUNmc3BJRHJ1WVRya0pEc25MenJxYlFnSWs5TEl1dWR2T3F6b091bmpDRHJpN1h0bFpqcm5id3VKdzBLSUNBcE93MEtmUTBLRFFvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVDQpnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBMEtiR1YwSUhCeWIyTWdQU0J1ZFd4c095QWdJQ0FnSUNBZ0lDQXZMeUR0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxa0RRcHNaWFFnYkdsdVpVSjFaaUE5SUNjbk95QWdJQ0FnSUNBZ0lDOHZJSE4wWkc5MWRDRHNwSVFnNjdLRTdZMjhEUXBzWlhRZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQzh2SU8yWWhPeWVyQ0R0aExUc25aZ2dleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIME5DbXhsZENCeGRXVjFaU0E5SUZCeWIyMXBjMlV1Y21WemIyeDJaU2dwT3lBdkx5RHNtcFRzc3EwZzdLZUI2NkNzN1ptVUlDanJqNW5zaTV3ZzdKcVU3TEt0N0oyQUlPeUluT3lFbk91TWdPdWhuQ2tOQ214bGRDQjBkWEp1Y3lBOUlEQTdEUXBzWlhRZ2QyRnliV1ZrVlhBZ1BTQm1ZV3h6WlRzTkNteGxkQ0JqZFhKeVpXNTBUVzlrWld3Z1BTQkRURUZWUkVWZg0KVFU5RVJVdzdJQzh2SU95bmdPcTRpQ0RzaExqc2haanNuYlFnNjZ5ODZyT2dJT3llaU91S2xDRHJxcWpyamJnZ0tPeWFsT3l5cmV5ZHRDRHJpNlRycGJnZzY2cW82NDI0N0oyRUlPeW5nT3lnbGUyVm1PdXB0Q0RzaExqc2haZ2c3SjZzN0l1YzdKNlJLUTBLTHk4ZzdJdWM3SjZSSU95TG5DQkRiR0YxWkdVZ1EyOWtaU2hqYkdGMVpHVWdRMHhKS2Vxd2dDRHNrN2dnN0lpWUlPeWVpT3VLbE95bmdDRHNvSkRxc29BZzRvQ1VJT3lYaHV5Y3ZPdXB0Q0F2YUdWaGJIUm82NkdjSU95VmpPdWdwQ0R0bEl6cm42enF0N2pzbmJqc25iUWc3SldJNjRLMDdaV2M2NHVrTGcwS0x5OGdiblZzYkQzdG1aWHNuYmdnN0tTUkxDQW5iMnNuUGV5Q3JPeWFxU0Rxc0lEcmlxVXNJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzlZMnhoZFdSbElPdXFoZXVndVNEc2w0YnNuWXdzRFFvdkx5QW5ZMnhoZFdSbExXeHZaMjkxZENjOVkyeGhkV1JsNjRxVUlPeWVpT3luZ091bmpDRHJvWnpxdDdqc25iZ2c3SVM0N0lXWUlPdW5qT3VqakNBbzdZUzANCklPeUxwTzJNcUNEc2k1d2c2ckNRN0tlQUxDRHNoTEhxczdVZzdZUzA3SjIwSU95WXBPdXB0Q0RzbnBEcmo1a2c3WlcwN0tDY0tRMEtiR1YwSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0RRb3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1RFFvdkx5QW9ZMnhoZFdSbElDMHRkbVZ5YzJsdmJ1eWRnQ0Ryb1p6cXQ3anNuYmdnN0plRzdKMjA2NCtFSU95RXNlcXp0ZTJWdE95RW5DRHNpNXpyajVrZzdLQ1E2cktBN0p5ODY2R2M2NHFVSU91cXV5RHNucUhxczZBc0lPeUxwT3lnbkNEdGhMVHNsNURzaEp6cnA0d2c2NU9jNjUrczY0S2M2NHVrS1EwS0x5OGdJdXVuak91ampDTHJwNHpzbmJRZzdKV0U2NHVJNjUyOElDTHRsWndnNjdLSTY0K0VJT3Vobk9xM3VPeWR1Q0RzbFlnZzdaV29JdXVQDQpoQ0Rxc0puc25ZQWc2cks5NjZHYzY2R2NJT3llb2UyZWlPdXZnT3VobkNEc3BKSHJwcjBnN1pHYzdaaUU3SjJFSU95VHRPdUxwQTBLWTI5dWMzUWdURTlIU1U1ZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVPeWR0Q0R0bFlUc21wVHRsYlRzbXBRbzdKV0lJT3VRa09xeHNPdUNtQ0RycDR6cm80d3BJT0tBbENCYjhKK2ZvQ0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjBnNjdLRTdZcTg3SjJFSU91SWhPdWx0T3VwdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHRPeVd0T3VUbk91Z3BPeWFsQzRuT3cwS0x5OGc3SXVrN0xpaDdaV2NJT3VzdU9xMXJPdVRwRG9nSWtaaGFXeGxaQ0IwYnlCaGRYUm9aVzUwYVdOaGRHVTZJRTlCZFhSb0lITmxjM05wYjI0Z1pYaHdhWEpsWkNCaGJtUWdZMjkxYkdRZ2JtOTBJR0psSUhKbFpuSmxjMmhsWkNJbzY2ZU02Nk9NS1N3TkNpOHZJQ0pPYjNRZ2JHOW5aMlZrSUdsdUlNSzNJRkJzWldGelpTQnlkVzRnTDJ4dloybHVJaWpycjdqcg0Kb1p6cXQ3anNuYmdwSU9LQWxDRHJrWmdnNjR1a0lPeWVvZTJlaU9xeWpDRHJoSlB0bm96cmk2UU5DbVoxYm1OMGFXOXVJR2x6UVhWMGFFVnljbTl5S0hNcElIc05DaUFnY21WMGRYSnVJQzloZFhSb1pXNTBhV05oZEh4dllYVjBhSHhoY0drZ2EyVjVmR3h2WnlBL2FXNThiRzluWjJWa2ZITmxjM05wYjI0Z1pYaHdhWEpsWkM5cExuUmxjM1FvVTNSeWFXNW5LSE1wS1RzTkNuME5DaTh2SU91aG5PcTN1T3lkdU91UW5DRHFzNFRzb0pVZzdabVY3SjI0SU9LQWxDQkRURW5xc0lBZ2ZpOHVZMnhoZFdSbExtcHpiMjdzbDVBZzZyaXc2NkdkN1pXWTY0cVVJRzloZFhSb1FXTmpiM1Z1ZEM1bGJXRnBiRUZrWkhKbGMzUHJwYndnN0oyOTdKYTBEUW92THlBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVm5PdUxwQ0FvN1pTTTY1K3M2cmU0N0oyNDdKMjBJQ0xyaUlUcXRhd2c2ck9FN0tDVjdKeTg2NkdjSU95VHNPdUtsQ0RzcEpIc25ianNwNEFpSU8yUm5PeUxuQ0RpZ0pRZzZyTzE3SnFwSUZCRDdKZVE3SVNjSU91Q3FPeWQNCm1DRHFzNFRzb0pVZzdKaWs3SUtzN0pxcElPdXdxZXluZ0NrdURRb3ZMeUR0akl6c25ienNuYlFnN1lHMElPeUltQ0Rzbm9qc2xyUW83WlNFNjZHYzdLQ2Q3WXE0SU95ZHRPdWdwU0R0ajZ6dGxhZ3BJRE13N0xTSUlPeTZrT3lMbkM0ZzdKNnM2NkdjNnJlNDdKMjQ3WldZNjZtMElFTk1TZXF3Z0NEdGpJenNuYnpzbllRZzZyQ3g3SXVnN1pXWTY2K0E2NkdjSU95ZWtPdVBtU0Ryc0pqc21JSHJrSnpyaTZRdURRcHNaWFFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ01Dd2daVzFoYVd3NklHNTFiR3dnZlRzTkNtWjFibU4wYVc5dUlHTnNZWFZrWlVGalkyOTFiblFvS1NCN0RRb2dJR2xtSUNoRVlYUmxMbTV2ZHlncElDMGdZV05qYjNWdWRFTmhZMmhsTG1GMElEd2dNekF3TURBcElISmxkSFZ5YmlCaFkyTnZkVzUwUTJGamFHVXVaVzFoYVd3N0RRb2dJR3hsZENCbGJXRnBiQ0E5SUc1MWJHdzdEUW9nSUhSeWVTQjdEUW9nSUNBZ1kyOXVjM1FnYWlBOUlFcFRUMDR1Y0dGeWMyVW9abk11Y21WaFpFWnBiR1ZUDQplVzVqS0hCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxMbXB6YjI0bktTd2dKM1YwWmpnbktTazdEUW9nSUNBZ1pXMWhhV3dnUFNBb2FpQW1KaUJxTG05aGRYUm9RV05qYjNWdWRDQW1KaUJxTG05aGRYUm9RV05qYjNWdWRDNWxiV0ZwYkVGa1pISmxjM01wSUh4OElHNTFiR3c3RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdWhuT3EzdU95ZHVDRHNuYlRyb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDRHNuS0RzcDRBZ0tpOGdmUTBLSUNCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQkVZWFJsTG01dmR5Z3BMQ0JsYldGcGJDQjlPdzBLSUNCeVpYUjFjbTRnWlcxaGFXdzdEUXA5RFFwbWRXNWpkR2x2YmlCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BJSHNOQ2lBZ1kyOXVjM1FnY0hKdlltVWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0TFhabGNuTnBiMjRuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdJSDBwT3cwSw0KSUNCc1pYUWdiM1YwSUQwZ0p5YzdEUW9nSUhCeWIySmxMbk4wWkc5MWRDNXZiaWduWkdGMFlTY3NJQ2hrS1NBOVBpQjdJRzkxZENBclBTQmtMblJ2VTNSeWFXNW5LQ2s3SUgwcE93MEtJQ0J3Y205aVpTNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljN0lIMHBPdzBLSUNCd2NtOWlaUzV2YmlnblkyeHZjMlVuTENBb1kyOWtaU2tnUFQ0Z2V3MEtJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2hqYjJSbElEMDlQU0F3SUNZbUlDOWNaQ3RjTGx4a0t5OHVkR1Z6ZENodmRYUXBLU0EvSUNkdmF5Y2dPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25PdzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0JEYkdGMVpHVWdRMjlrWlNEc29KRHFzb0E2SUNjZ0t5QmpiR0YxWkdWVGRHRjBkWE1nS3lBb2IzVjBJRDhnSnlBb0p5QXJJRzkxZEM1MGNtbHRLQ2tnS3lBbktTY2dPaUFuSnlrcE93MEtJQ0I5S1RzTkNuME5DaTh2SU95eW1PdW0NCnJDRHRtSVR0bWFrZzRvQ1VJQzlvWldGc2RHanJvWndnNjRXNDdMYWM3WlcwSUNMc29KWHJwNUFnN1lHMDY2R2M2NU9jNnJDQUlPdUx0ZTJXaU91S2xPeW5nQ0lnNjdDVzdKZVE3SVNjSU8yWmxleWR1TzJWb0NEc2lKZ2c3SjZJNnJLTUlPMlZuT3VMcEEwS1kyOXVjM1FnYzNSaGRITWdQU0I3SUhObGNuWmxaRG9nTUN3Z2JHRnpkRUYwT2lBbkp5d2diR0Z6ZEZSbGVIUTZJQ2NuTENCc1lYTjBVMlZqT2lBbkp5QjlPdzBLRFFvdkx5RGlsSURpbElBZzdaU002NStzNnJlNDdKMjRJT3lEbmV5aHRDRHFzSkRzcDRBbzdJdXM3SjZsNjdDVjY0K1pLU0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQU5DaTh2SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RybHFBZzdKNkk2NHFVSU91UG1leVZpQ0JqYjJSbExuUno2ckNBSURYc3RJanJwNGpyaTZRZ1VFOVRWQ0F2DQphR1ZoY25SaVpXRjA2Nlc4SU91enRPdUN1T3VMcEM0TkNpOHZJTzJWbkNEcnNvanNuYlRybmJ6cmo0UWc2N0NiN0oyQUlPdVNwQ0F6TU95MGlPcXdoQ0RyZ1lycXVMRHJxYlFnN1pTTTY1K3M2cmU0N0oyNEtPdVlrT3VLbENEdGxMenF0N2pycDRncDdKMjBJT3VMcSsyZWpDRHFzb01nNG9DVUlPMkJ0T3Vobk91VG5PcTVqT3luZ0NEcmpiRHJwcXpxczZBZzZyQ1o3SjIwSU9xNnZPeW5oT3VMcEM0TkNpOHZJT3lWaE95bmdTRHRsWndnNjdLSTY0K0VJT3VxdXlEcnNKdnNsWmpzbkx6cnFiUW82NHVrNjZhczY2ZU1JT3Vvdk95Z2dDRHN2S0FnN0lPQjdZT2NMQ0RzbnBEcmo1bnNpNXpzbnBFZzY1T3hLU0RxczRUc2hvMGc2NHlBNnJpdzdaV2M2NHVrTGcwS1kyOXVjM1FnU0VWQlVsUkNSVUZVWDBSRlFVUmZUVk1nUFNBek1EQXdNRHNOQ214bGRDQnNZWE4wUW1WaGRDQTlJREE3RFFwelpYUkpiblJsY25aaGJDZ29LU0E5UGlCN0RRb2dJR2xtSUNoc1lYTjBRbVZoZENBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkdGeg0KZEVKbFlYUWdQaUJJUlVGU1ZFSkZRVlJmUkVWQlJGOU5VeWtnZXcwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJenJuNnpxdDdqc25iZ2c3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTVnQ0RpZ0pRZzdaUzg2cmU0NjZlSUwrMlVqT3Vmck9xM3VPeWR1T3lkdENEcmk2dnRub3dnNnJLRDdKeTg2NkdjSU91enRPcXpvQ0Rxc0puc25iUWc2cnE4N0tlUjY0dUk2NHVrTGljcE93MEtJQ0FnSUhCeWIyTmxjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQc25MenJvWndnWTJ4aGRXUmxJTzJLdU91bXJPdWx2Q0Rzb0pYcnBxenRsWnpyaTZRTkNpQWdmUTBLZlN3Z05UQXdNQ2s3RFFvTkNpOHZJT3Vobk9xM3VPeWR1Q0JWVWt6c25ZUWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnQ2pyczdUdGhyVWc3TEM5S2V1aG5DRHNsNnpyaXBRZ1FsSlBWMU5GVWlEdGxianJrNlRybjZ3ZzdJcWs3WUdzNjZhOTdZcTQ2Nlc4SU91bmpPdVRvT3VMcEM0TkNpOHYNCklHTnNZWFZrWlNCRFRFbnJpcFFnUWxKUFYxTkZVaUR0bVpqcXNyM3JzNERzaUpqcnBid2c3S0cwN0tTUjdaVzBJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNwNEhzb0pFZzdKZTA3S2VBSU95Vml1cXpvQ0RzbmJRZzdJcWs3WUdzNjZhOTdZcTQ3SmVRSUdGMWRHaHZjbWw2WlNCVlVrenNuWVFnNjRTWTZyaTA2NHVrS095THBPeTRvU0F5TURJMkxUQTNLUzROQ2k4dklHMXZaR1U5SjNOM2FYUmphQ2NvNnJPRTdLQ1ZJT3lnaE8yWm1Da2c0b2FTSU95S3VleWR1Q0R0bVpUcnFiVHNuWVFnNnJHdzdMbVk3S2VBSU95Vml1cXpvQ0FxS3VxemhPeWdsU0RzaEtEdGc1MGc3Wm1VNjZtMDdKeTg2NkdjSU91d2xPdWhuQ29xSU91enRPdUN1T3VMcEM0TkNpOHZJQ0FnNjZHYzZyZTQ3SjI0NjVDY0lPeURnZTJEbk91cHRDQmhkWFJvYjNKcGVtWHFzSUFnN0lxNTdKMjRJTzJabE91cHRPeWN2T3VobkNEcXNJRHFzNkFnYzJWc1pXTjBRV05qYjNWdWREMTBjblZsd3Jkd2NtOXRjSFE5YzJWc1pXTjBYMkZqWTI5MWJuVHJvWnpyDQpqNFFnNjZxN0lPdWFxK3ljdk91dmdPdWhuQ2pzaTZUc3VLRXBMQTBLTHk4Z0lDRHRsWndnN1lPdElPeVZpT3lYa095RW5DQmpiR0YxWkdVdVlXa3ZiRzluYjNWMFAzSmxkSFZ5YmxSdlBUeDFjbXd0Wlc1amIyUmxaQ0F2YjJGMWRHZ3ZZWFYwYUc5eWFYcGxQMUZWUlZKWktPeURnZXVNZ09xeXZldWhuQ2srNjZHY0lPeWVoK3VLbE91THBEb05DaTh2SUNBZzY2R2M2cmU0N0pXRTdKdURLT3lFdU95Rm1DRHNwNERzbTRBcElPS0draUJzYjJkcGJqOXpaV3hsWTNSQlkyTnZkVzUwUFhSeWRXVW82ck9FN0tDVklPeUVvTzJEblNucm9ad2c3SjZRNjQrWklPeXl0T3lkdE91TG5TanNpNlRzdUtFNklPdUxxT3lkdkNEdGc2MHBMaURzaXJuc25iZ2c3Wm1VNjZtMElPMlZtT3VMcUEwS0x5OGdJQ0JiNnJPRTdLQ1ZJT3lnaE8yWm1GMGc2N0tFN1lxODdKMjBJTzJWbU91S2xDRHNuYnpxczd3ZzZyQ1o3SjJBSU9xeXNPcXp2Q0RpZ0pRZzY0dWs2NmVNSU95YXNPdW1yT3F3Z0NEcXM2ZnNucVVnNnJlNElPMlpsT3VwdE95Yw0Kdk91aG5DRHJzN1RyZ3Jqcmk2UXVEUW92THlBZ0lDanJ0b0RzbnBIc21xazZJT3U0ak91ZHZPeWFzT3lnZ095ZG1DQmpiR0YxWkdVdVlXa2c3SnU1SU91aG5PcTN1T3lkdU91UGhDRHRrb0RycHJ3ZzRvQ1VJT3F6aE95Z2xTRHNvSVR0bVpnZzdKMlk2NCtFN0ptQUlPdXdxZTJXcGV5ZHRDRHFzSm5zbFlRZzdJaVk3SnFwTGlrTkNpOHZJRzF2WkdVOUoyNXZjbTFoYkNjbzY2ZU02Nk9NSU95ZXJPdWhuT3EzdU95ZHVDa2c0b2FTSU91aG5PcTN1T3lWaE95Ymd5RHNsNGJzbmJRZzZyZTQ2NE9sSU95WHNPdUxwQ2pyaklEcXNKd2c2ckNaN0oyQUlPcXpoT3lnbGV5ZHRPdWR2Q0RzaExqc2haZ2c3SnlnN0tlQTZyQ0FJT3U1b091bWhDa3VEUXBtZFc1amRHbHZiaUIzY21sMFpVSnliM2R6WlhKSVlXNWtiR1Z5S0cxdlpHVXBJSHNOQ2lBZ1kyOXVjM1FnYkc5bmIzVjBJRDBnYlc5a1pTQTlQVDBnSjNOM2FYUmphQ2M3RFFvZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2cNCklDQWdZMjl1YzNRZ1kyMWtJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxaWNtOTNjMlZ5TFNjZ0t5QnRiMlJsSUNzZ0p5NWpiV1FuS1RzTkNpQWdJQ0JqYjI1emRDQndjeUE5SUd4dloyOTFkQTBLSUNBZ0lDQWdQeUFpSkhVOUpHVnVkanBEUWw5VlVrdzdJQ1JwUFNSMUxrbHVaR1Y0VDJZb0oyOWhkWFJvTDJGMWRHaHZjbWw2WlNjcE95QnBaaWdrYVNBdFoyVWdNQ2w3SUNSeVpXdzlKeThuS3lSMUxsTjFZbk4wY21sdVp5Z2thU2s3SUNSbGJtTTlXMU41YzNSbGJTNVZjbWxkT2pwRmMyTmhjR1ZFWVhSaFUzUnlhVzVuS0NSeVpXd3BPeUJUZEdGeWRDMVFjbTlqWlhOeklDZ25hSFIwY0hNNkx5OWpiR0YxWkdVdVlXa3ZiRzluYjNWMFAzSmxkSFZ5YmxSdlBTY3JKR1Z1WXlrZ2ZTQmxiSE5sSUhzZ1UzUmhjblF0VUhKdlkyVnpjeUFrZFNCOUlnMEtJQ0FnSUNBZ09pQW5VM1JoY25RdFVISnZZMlZ6Y3lBa1pXNTJPa05DWDFWU1RDYzdEUW9nSUNBZ1puTXVkM0pwDQpkR1ZHYVd4bFUzbHVZeWhqYldRc0lDZEFaV05vYnlCdlptWmNjbHh1YzJWMElDSkRRbDlWVWt3OUpYNHhJbHh5WEc1d2IzZGxjbk5vWld4c0lDMU9iMUJ5YjJacGJHVWdMVVY0WldOMWRHbHZibEJ2YkdsamVTQkNlWEJoYzNNZ0xVTnZiVzFoYm1RZ0lpY2dLeUJ3Y3lBcklDY2lYSEpjYmljcE93MEtJQ0FnSUhKbGRIVnliaUJqYldRN0RRb2dJSDBOQ2lBZ1kyOXVjM1FnYzJnZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV0p5YjNkelpYSXRKeUFySUcxdlpHVWdLeUFuTG5Ob0p5azdEUW9nSUdOdmJuTjBJRzV2WkdWQ2FXNGdQU0J3Y205alpYTnpMbVY0WldOUVlYUm9PeUF2THlEc29JUWdUMVBzbDVBZ2JtOWtaU0Rzbm9qc25Zd282NHVrNjZhczZyQ0FJRzV2WkdYcm9ad2c2NCtPS1M0ZzY3T0E3Wm1ZSU95THBPMk1xQ0RzaTV3ZzdKdVE2N080SUZWU1RDRHF0N2pyaklEcm9ad2c3SmV3NjR1a0tHWmhhV3d0YzI5bWRDa3VEUW9nSUdOdmJuTjBJR0p2WkhrZw0KUFNCc2IyZHZkWFFOQ2lBZ0lDQS9JQ2NqSVM5aWFXNHZjMmhjYmljZ0t3MEtJQ0FnSUNBZ0oxVTlKQ2dpSnlBcklHNXZaR1ZDYVc0Z0t5QW5JaUF0WlNCY0oyTnZibk4wSUhVOWNISnZZMlZ6Y3k1aGNtZDJXekZkTzJOdmJuTjBJR2s5ZFM1cGJtUmxlRTltS0NKdllYVjBhQzloZFhSb2IzSnBlbVVpS1R0d2NtOWpaWE56TG5OMFpHOTFkQzUzY21sMFpTaHBQREEvZFRvaWFIUjBjSE02THk5amJHRjFaR1V1WVdrdmJHOW5iM1YwUDNKbGRIVnlibFJ2UFNJclpXNWpiMlJsVlZKSlEyOXRjRzl1Wlc1MEtDSXZJaXQxTG5Oc2FXTmxLR2twS1NsY0p5QWlKREVpSURJK0wyUmxkaTl1ZFd4c0tWeHVKeUFyRFFvZ0lDQWdJQ0FuYjNCbGJpQWlKSHRWT2kwa01YMGlYRzRuRFFvZ0lDQWdPaUFuSXlFdlltbHVMM05vWEc1dmNHVnVJQ0lrTVNKY2JpYzdEUW9nSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vYzJnc0lHSnZaSGtwT3cwS0lDQm1jeTVqYUcxdlpGTjVibU1vYzJnc0lEQnZOelUxS1RzTkNpQWdjbVYwZFhKdUlITm8NCk93MEtmUTBLRFFvdkx5RHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU8yVWhPdWhuT3lFdU95S3BDQW9ZMnhoZFdSbElHRjFkR2dnYkc5bmFXNGdMUzFqYkdGMVpHVmhhU2tnNG9DVUlDOXZjR1Z1TFd4dloybHU3SjIwSU95RG5leUVzY0szNnJTQTY2YXNMZzBLTHk4ZzY3aU02NTI4N0pxdzdLQ0E2ckNBSUd4dlkyRnNhRzl6ZE91aG5DRHFzckRxczd6cnBid2c2N08wNjRLMDdLU0VJT3VWak9xNWpPeW5nQ0RzaUtqc2xyVHNoSndnNjR5QTZyaXc3WldZNjR1azZyQ0FMQ0RzbVlUcm80enJrSmpycWJRZzdJcWs3SXFrNjZHY0lPdUJuZXVDbk91THBDNE5DbXhsZENCc2IyZHBibEJ5YjJNZ1BTQnVkV3hzT3cwS2JHVjBJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdiblZzYkRzTkNteGxkQ0JzYjJkcGJsTjBZWEowWldSQmRDQTlJREE3SUM4dklPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN0l1YzdKNlJJT3lMbk9xd2dTRGlnSlFnN0o2czdZRzA2NmF0N0oyMElDZnNucXpzaTV6cmo0UW43SjI0DQo3S2VBSUNmc25wRHJqNW5zbVlUcm80d2c3SXVrN1l5b0oreWR1T3luZ0NEcXRhenJ0b1R0bFp6cmk2UU5DbVoxYm1OMGFXOXVJR3RwYkd4TWIyZHBibEJ5YjJNb0tTQjdEUW9nSUdsbUlDaHNiMmRwYmxCeWIyTlVhVzFsY2lrZ2V5QmpiR1ZoY2xScGJXVnZkWFFvYkc5bmFXNVFjbTlqVkdsdFpYSXBPeUJzYjJkcGJsQnliMk5VYVcxbGNpQTlJRzUxYkd3N0lIME5DaUFnYVdZZ0tDRnNiMmRwYmxCeWIyTXBJSEpsZEhWeWJqc05DaUFnWTI5dWMzUWdjQ0E5SUd4dloybHVVSEp2WXpzTkNpQWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc05DaUFnZEhKNUlIc05DaUFnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXcwS0lDQWdJQ0FnYzNCaGQyNVRlVzVqS0NkMFlYTnJhMmxzYkNjc0lGc25MMUJKUkNjc0lGTjBjbWx1Wnlod0xuQnBaQ2tzSUNjdlZDY3NJQ2N2UmlkZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNOQ2lBZ0lDQjlJR1ZzYzJVZ2V3MEtJQ0FnSUNBZw0KZEhKNUlIc2djSEp2WTJWemN5NXJhV3hzS0Mxd0xuQnBaQ3dnSjFOSlIxUkZVazBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3SUhBdWEybHNiQ2dwT3lCOURRb2dJQ0FnZlEwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUTBLZlEwS0RRcG1kVzVqZEdsdmJpQnJhV3hzVUhKdll5Z3BJSHNOQ2lBZ2FXWWdLSEJ5YjJNcElIc05DaUFnSUNCMGNua2dldzBLSUNBZ0lDQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZDNhVzR6TWljcElIc05DaUFnSUNBZ0lDQWdMeThnYzJobGJHdzZkSEoxWmV1aG5DRHJuWVRzbTR6c2hKd2djSEp2WSt5ZGdDQmpiV1FnNnJ1TjY0Mnc2cml3SU9LQWxDQXZWT3VobkNEdGlyanJwcXpzcDdnZzdLTzk3SmVzN0pXOElPeW5oT3lubkNCamJHRjFaR1hxc0lBZzZyT2c3SldFNjZHY0lPeVZpQ0RyZ3FqcmlwVHJpNlFOQ2lBZ0lDQWdJQ0FnTHk4Z0tPcXpvT3lWaENCamJHRjFaR1hxc0lBZzdJU2s3TG1ZSU8yTWpPeWR2T3lkaENEcnJMenENCnM2QWc3SjZJN0p5ODY2bTBJTzJCdE91aG5PdVRuQ0RzbGJFZzdKZUY2NDJ3N0oyMDdZcTQ2ckNBSUNMc2dxenNtcWtnN0tTUkl1eWN2T3VobkNEcnA0bnRucGdwRFFvZ0lDQWdJQ0FnSUhOd1lYZHVVM2x1WXlnbmRHRnphMnRwYkd3bkxDQmJKeTlRU1VRbkxDQlRkSEpwYm1jb2NISnZZeTV3YVdRcExDQW5MMVFuTENBbkwwWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0RRb2dJQ0FnSUNCOUlHVnNjMlVnZXcwS0lDQWdJQ0FnSUNBdkx5QnRZV05QVXkvcnBxenJpSVhzaXFRNklITm9aV3hzT25SeWRXWHJuYndnY0hKdlkreWR0Q0J6YUNEcXU0M3JqYkRxdUxEc25id2c3SWlZSU95ZWlPeWRqQ0RpZ0pRZ2MzUmhjblJRY205ajdKMllJR1JsZEdGamFHVms2NkdjSU91bmpPdVRvQTBLSUNBZ0lDQWdJQ0F2THlEdGxJVHJvWnpzaExqc2lxUWc2cmU0NjZPNUtDMXdhV1FwN0oyRUlPMkd0ZXludU91aG5DRHNvSlhycHF6dGxaenJpNlFnS0hSaGMydHJhV3hzSUM5VUlPdU1nT3lka1NrTkNpQWdJQ0FnDQpJQ0FnZEhKNUlIc2djSEp2WTJWemN5NXJhV3hzS0Mxd2NtOWpMbkJwWkN3Z0oxTkpSMVJGVWswbktUc2dmU0JqWVhSamFDQW9YMlV5S1NCN0lIQnliMk11YTJsc2JDZ3BPeUI5RFFvZ0lDQWdJQ0I5RFFvZ0lDQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c2NnkwN0l1Y0lDb3ZJSDBOQ2lBZ2ZRMEtJQ0J3Y205aklEMGdiblZzYkRzTkNpQWdkMkZ5YldWa1ZYQWdQU0JtWVd4elpUc05DaUFnYVdZZ0tIZGhhWFJsY2lrZ2V5QmpiR1ZoY2xScGJXVnZkWFFvZDJGcGRHVnlMblJwYldWeUtUc2dkMkZwZEdWeUxuSmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNoTGpzaFpqc25iUWc3S0tGNjZPTTY1Q1E3SmEwN0pxVUxpY3BLVHNnZDJGcGRHVnlJRDBnYm5Wc2JEc2dmUTBLZlEwS0RRcG1kVzVqZEdsdmJpQnpkR0Z5ZEZCeWIyTW9LU0I3RFFvZ0lHdHBiR3hRY205aktDazdEUW9nSUd4cGJtVkNkV1lnUFNBbkp6c05DaUFnZEhWeWJuTWdQU0F3T3cwS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeQ0KYVdSblpWMGc3WUcwNjZHYzY1T2NJT3lFdU95Rm1DRHNpNXpyajVrZzdLU1I0b0NtSUNqcnFxanJqYmc2SUNjZ0t5QmpkWEp5Wlc1MFRXOWtaV3dnS3lBbktTY3BPdzBLSUNCamIyNXpkQ0IwYUdselVISnZZeUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSnkxd0p5d2dKeTB0Ylc5a1pXd25MQ0JqZFhKeVpXNTBUVzlrWld3c0lDY3RMV2x1Y0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzSUNjdExXOTFkSEIxZEMxbWIzSnRZWFFuTENBbmMzUnlaV0Z0TFdwemIyNG5MQ0FuTFMxMlpYSmliM05sSjEwc0lIc05DaUFnSUNCemFHVnNiRG9nZEhKMVpTd2dZM2RrT2lCRlRWQlVXVjlEVjBRc0lHVnVkam9nUTB4QlZVUkZYMFZPVml3TkNpQWdJQ0JrWlhSaFkyaGxaRG9nY0hKdlkyVnpjeTV3YkdGMFptOXliU0FoUFQwZ0ozZHBiak15Snl3Z0x5OGdVRTlUU1ZnNklPeWVrT3E0c0NEdGxJVHJvWnpzaExqc2lxUWc2cmU0NjZPNUlPeURuZXlFc1NEaWdKUWdhMmxzYkZCeWIyUHNuYlFnNnJlNDY2TzUNCjdLZTRJT3lnbGV1bXJPMlZvQ0RzaUpnZzdKNkk2cktNRFFvZ0lIMHBPdzBLSUNCd2NtOWpJRDBnZEdocGMxQnliMk03RFFvZ0lIQnliMk11YzNSa2IzVjBMbTl1S0Nka1lYUmhKeXdnS0dRcElEMCtJSHNOQ2lBZ0lDQnNhVzVsUW5WbUlDczlJR1F1ZEc5VGRISnBibWNvSjNWMFpqZ25LVHNOQ2lBZ0lDQnNaWFFnYVdSNE93MEtJQ0FnSUhkb2FXeGxJQ2dvYVdSNElEMGdiR2x1WlVKMVppNXBibVJsZUU5bUtDZGNiaWNwS1NBaFBUMGdMVEVwSUhzTkNpQWdJQ0FnSUdOdmJuTjBJR3hwYm1VZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0RBc0lHbGtlQ2t1ZEhKcGJTZ3BPdzBLSUNBZ0lDQWdiR2x1WlVKMVppQTlJR3hwYm1WQ2RXWXVjMnhwWTJVb2FXUjRJQ3NnTVNrN0RRb2dJQ0FnSUNCcFppQW9JV3hwYm1VcElHTnZiblJwYm5WbE93MEtJQ0FnSUNBZ2JHVjBJR1YySUQwZ2JuVnNiRHNOQ2lBZ0lDQWdJSFJ5ZVNCN0lHVjJJRDBnU2xOUFRpNXdZWEp6WlNoc2FXNWxLVHNnZlNCallYUmphQ0FvWDJVcElIc2dZMjl1DQpkR2x1ZFdVN0lIME5DaUFnSUNBZ0lHbG1JQ2hsZGlBbUppQmxkaTUwZVhCbElEMDlQU0FuY21WemRXeDBKeUFtSmlCM1lXbDBaWElwSUhzTkNpQWdJQ0FnSUNBZ1kyOXVjM1FnZHlBOUlIZGhhWFJsY2pzTkNpQWdJQ0FnSUNBZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNOQ2lBZ0lDQWdJQ0FnWTJ4bFlYSlVhVzFsYjNWMEtIY3VkR2x0WlhJcE93MEtJQ0FnSUNBZ0lDQnBaaUFvWlhZdWFYTmZaWEp5YjNJcElIc05DaUFnSUNBZ0lDQWdJQ0JqYjI1emRDQnlZWGNnUFNCVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElHVjJMbk4xWW5SNWNHVWdmSHdnSnljcExuTnNhV05sS0RBc0lESXdNQ2s3RFFvZ0lDQWdJQ0FnSUNBZ2FXWWdLR2x6UVhWMGFFVnljbTl5S0hKaGR5a3BJSHNOQ2lBZ0lDQWdJQ0FnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNkamJHRjFaR1V0Ykc5bmIzVjBKenNnTHk4Z0wyaGxZV3gwYU91aG5DRHRsSXpybjZ6cXQ3anNuYmpzbDVBZzdKV002NmE4SU9LR2tpRHJzb1R0aXJ6c25iUWdXK3Vobk9xMw0KdU95ZHVDRHRsWVRzbXBSZDY2R2NJT3V3bE91QW5BMEtJQ0FnSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c2NmVNNjZPTUlPcXdrT3luZ0RvbkxDQnlZWGNwT3cwS0lDQWdJQ0FnSUNBZ0lDQWdkeTV5WldwbFkzUW9ibVYzSUVWeWNtOXlLRXhQUjBsT1gwZFZTVVJGS1NrN0RRb2dJQ0FnSUNBZ0lDQWdmU0JsYkhObElIc05DaUFnSUNBZ0lDQWdJQ0FnSUhjdWNtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdZRzA2NkdjNjVPY0lPeVlwT3VsbURvZ0p5QXJJSEpoZHlrcE93MEtJQ0FnSUNBZ0lDQWdJSDBOQ2lBZ0lDQWdJQ0FnZlNCbGJITmxJSHNOQ2lBZ0lDQWdJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0FuYjJzbk95QXZMeURzaExIcXM3VWdQU0RzaEtUc3VaakN0K3Vobk9xM3VPeWR1Q0RyaTZRZzdLQ1Y3SU9CSU9LQWxDRHNsclRybHFRZ2NISnZZbXhsYmV5ZHRPdVRvQ0R0bGJUc29Kd2dLT3llck91aG5PcTN1T3lkdUMvc25xenMNCmhLVHN1WmdnNjdPMTZyZUFLUTBLSUNBZ0lDQWdJQ0FnSUhjdWNtVnpiMngyWlNoVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElDY25LU2s3RFFvZ0lDQWdJQ0FnSUgwTkNpQWdJQ0FnSUgwTkNpQWdJQ0I5RFFvZ0lIMHBPdzBLSUNCd2NtOWpMbk4wWkdWeWNpNXZiaWduWkdGMFlTY3NJQ2hrS1NBOVBpQjdEUW9nSUNBZ1kyOXVjM1FnY3lBOUlHUXVkRzlUZEhKcGJtY29KM1YwWmpnbktTNTBjbWx0S0NrN0RRb2dJQ0FnYVdZZ0tITWdKaVlnSVhNdWFXNWpiSFZrWlhNb0owUmxjSEpsWTJGMGFXOXVWMkZ5Ym1sdVp5Y3BLU0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZ1kyeGhkV1JsSUhOMFpHVnljam9uTENCekxuTnNhV05sS0RBc0lESXdNQ2twT3cwS0lDQjlLVHNOQ2lBZ2NISnZZeTV2YmlnblkyeHZjMlVuTENBb1kyOWtaU2tnUFQ0Z2V3MEtJQ0FnSUM4dklPeWR0T3V2dUNEc2c0Z2c3SVM0N0lXWTdKeTg2NkdjSU9xMWtPeXl0T3VRbkNEcmtxUWc3SmliSU95RXVPeUZtT3lkdENEcmk2dnRub3dnDQo2ckd3NjZtMElPdXN0T3lMbkNBbzY2cW82NDI0SU95Z2hPMlptQ0RzaTV3ZzdJT0lJT3lFdU95Rm1PeWRoQ0Rzbzczc25iVHNwNEFnN0pXSzZyS01LUTBLSUNBZ0lHbG1JQ2h3Y205aklDRTlQU0IwYUdselVISnZZeWtnY21WMGRYSnVPdzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT3lpaGV1ampDQW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BJT0tBbENEcmk2VHNuWXdnN0pxVTdMS3RJT3VWakNEcmk2VHNpNXdnN0l1YzY0K1o3WldwNjR1STY0dWtMaWNwT3cwS0lDQWdJR3RwYkd4UWNtOWpLQ2s3RFFvZ0lIMHBPdzBLZlEwS0RRcG1kVzVqZEdsdmJpQnpaVzVrVkhWeWJpaDBaWGgwS1NCN0RRb2dJSEpsZEhWeWJpQnVaWGNnVUhKdmJXbHpaU2dvY21WemIyeDJaU3dnY21WcVpXTjBLU0E5UGlCN0RRb2dJQ0FnYVdZZ0tDRndjbTlqS1NCeVpYUjFjbTRnY21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkdENEcw0KbDRic2xyVHNtcFF1SnlrcE93MEtJQ0FnSUdsbUlDaDNZV2wwWlhJcElISmxkSFZ5YmlCeVpXcGxZM1FvYm1WM0lFVnljbTl5S0Nmc2xaN3NoS0FnN0pxVTdMS3Q3SjIwSU95bmhPMldpU0RzcEpIc25iVHNsNURzbXBRdUp5a3BPdzBLSUNBZ0lHTnZibk4wSUhScGJXVnlJRDBnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3RFFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZUzBJT3lMbk9xd2hDRHN0SWpxczd3ZzRvQ1VJT3lFdU95Rm1PeWRoQ0RzbnF6c2k1enNucEh0bGFucmk0anJpNlF1SnlrN0RRb2dJQ0FnSUNCcmFXeHNVSEp2WXlncE93MEtJQ0FnSUgwc0lGUlZVazVmVkVsTlJVOVZWRjlOVXlrN0RRb2dJQ0FnZDJGcGRHVnlJRDBnZXlCeVpYTnZiSFpsTENCeVpXcGxZM1FzSUhScGJXVnlJSDA3RFFvZ0lDQWdjSEp2WXk1emRHUnBiaTUzY21sMFpTaEtVMDlPTG5OMGNtbHVaMmxtZVNoN0lIUjVjR1U2SUNkMWMyVnlKeXdnYldWemMyRm5aVG9nZXlCeWIyeGxPaUFuZFhObGNpY3MNCklHTnZiblJsYm5RNklIUmxlSFFnZlNCOUtTQXJJQ2RjYmljc0lDZDFkR1k0SnlrN0RRb2dJSDBwT3cwS2ZRMEtEUW92THlEcXNKbnNuWUFnNjZ5NDZyV3M2Nlc4SU91cWh5RHJzb2pzcDdnZzY2eTc2NHFVN0tlQUlPcTRzT3lXdFNEaWdKUWc3SjZzN0pxVTdMS3Q3SjIwNjZtMElDTHNuYlRzb0lUcXM3d2c2NHVrNjZXNElPeURpQ0Rzb0p6c2xZZ2k3SjJFSU95YWxPcTFyTzJWbk91THBBMEtMeThnS095VmlDRHF0N2pybjZ6cnFiUWc3WUcwNjZHYzY1T2M2ckNBSU95RXNleUxwTzJWbU9xeWpDRHFzSm5zbllBZzY0dTE3SjJFSU91WWtDRHJnclRzaEp3Z1cwRkpJT3kybE95eW5DRHJqWlFnNjdDYjZyaXdYZXF3Z0NEcnJMVHNuWmpycjdqdGxiVHNwNFRyaTZRcERRcGpiMjV6ZENCaGMydGxaRU52ZFc1MElEMGdibVYzSUUxaGNDZ3BPdzBLRFFvdkx5RHNoTGpzaFpnZzdLU0E2N21FS095TG5PdVBtU3ZzcDREc2k1enJyTGdnN0tPODdKNkZLZXVsdkNEcnM3VHNucVh0bFp3ZzY1S2tJTzJWbkNEdGhMUWc3SXVrDQo3WmFKSU9LQWxDRHJxcWpyazZBZzdaaTQ3TGFjN0oyQUlIRjFaWFZsNjZHY0lPeW5nZXVnck8yWmxDNE5DaTh2SUcxdlpHVnM3SjJFSU95anZPdXB0Q0RxdDdnZzY2cW82NDI0NjZHY0lDanJpNlRycGJUcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTa3VJTzJWbkNEcnFxanJqYmpzbllRZzZyT0U3SWFOSU95VHNPdXB0Q0RzbnF6c2k1enNucEhzbllBZzdMV2M3TFNJSURIdG1venJ2NUF1RFFwbWRXNWpkR2x2YmlCeWRXNVVkWEp1S0dKMWFXeGtRWE5yTENCdGIyUmxiQ2tnZXcwS0lDQmpiMjV6ZENCcWIySWdQU0J4ZFdWMVpTNTBhR1Z1S0dGemVXNWpJQ2dwSUQwK0lIc05DaUFnSUNCcFppQW9iVzlrWld3Z0ppWWdRVXhNVDFkRlJGOU5UMFJGVEZNdWFXNWtaWGhQWmlodGIyUmxiQ2tnSVQwOUlDMHhJQ1ltSUcxdlpHVnNJQ0U5UFNCamRYSnlaVzUwVFc5a1pXd3BJSHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnFxanJqYmdnNjdPQTZySzlPaUFuSUNzZ1kzVnljbVZ1ZEUxdg0KWkdWc0lDc2dKeURpaHBJZ0p5QXJJRzF2WkdWc0tUc05DaUFnSUNBZ0lHTjFjbkpsYm5STmIyUmxiQ0E5SUcxdlpHVnNPdzBLSUNBZ0lDQWdjM1JoY25SUWNtOWpLQ2s3SUM4dklPeURpQ0RycXFqcmpianJvWndnN0lTNDdJV1lJT3llck95TG5PeWVrU0FvNjR1azdKMk1JT3liak91d2pleVhoZXlYa095RW5DRHNwNERzaTV6cnJMZ2c3SjZzN0tPODdKNkZLUTBLSUNBZ0lIME5DaUFnSUNCcFppQW9kSFZ5Ym5NZ1BqMGdUVUZZWDFSVlVrNVRJSHg4SUNGd2NtOWpLU0J6ZEdGeWRGQnliMk1vS1RzTkNpQWdJQ0JwWmlBb0lYZGhjbTFsWkZWd0tTQjdEUW9nSUNBZ0lDQmpiMjV6ZENCME1DQTlJRVJoZEdVdWJtOTNLQ2s3RFFvZ0lDQWdJQ0JoZDJGcGRDQnpaVzVrVkhWeWJpaHBibk4wY25WamRHbHZiazFsYzNOaFoyVW9LU2s3RFFvZ0lDQWdJQ0IzWVhKdFpXUlZjQ0E5SUhSeWRXVTdEUW9nSUNBZ0lDQjBkWEp1Y3lzck93MEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFdU95Rm1DRHMNCnBJRHJ1WVFnN0ptRTY2T01JQ2duSUNzZ0tDaEVZWFJsTG01dmR5Z3BJQzBnZERBcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtTQXJJQ2R6S1NEaWdKUWc3SjIwN1p1RUlPeWFsT3l5cmV5ZGdDRHJ1YWpybmJ6c21wUXVKeWs3RFFvZ0lDQWdmUTBLSUNBZ0lIUjFjbTV6S3lzN0RRb2dJQ0FnY21WMGRYSnVJSE5sYm1SVWRYSnVLR0oxYVd4a1FYTnJLQ2twT3cwS0lDQjlLVHNOQ2lBZ0x5OGc3WldjSU95YWxPeXlyZXlkdENEc2k2VHRqS2p0bGJUcmo0UWc2NHVrN0oyTUlPeWFsT3l5cmV5ZHRDRHNuYlRzbHJUc3A0RHJqNFRyb1owZzdZR1E2NHFVSU8yVnJleURnU0RzaExIcXM3WHNuTHpyb1p3ZzdLQ1Y2NmFzRFFvZ0lIRjFaWFZsSUQwZ2FtOWlMbU5oZEdOb0tDZ3BJRDArSUh0OUtUc05DaUFnY21WMGRYSnVJR3B2WWpzTkNuME5DZzBLTHk4ZzY2eTQ2cldzSU95MmxPeXluQ0R0aExRTkNtWjFibU4wYVc5dUlHRnphME5zWVhWa1pTaDBaWGgwTENCdGIyUmxiQ2tnZXcwS0lDQnlaWFIxY200Z2NuVnVWSFZ5DQpiaWdvS1NBOVBpQjdEUW9nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2gwWlhoMEtTQjhmQ0F3S1NBcklERTdEUW9nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvZEdWNGRDd2dZWFIwWlcxd2RDazdEUW9nSUNBZ2FXWWdLR0Z6YTJWa1EyOTFiblF1YzJsNlpTQStJREl3TUNrZ1lYTnJaV1JEYjNWdWRDNWpiR1ZoY2lncE95QXZMeURyckxUdGxaenRub2dnN0l5VDdKMjA3S2VBSU95Vml1cXlqQTBLSUNBZ0lISmxkSFZ5YmlCaGRIUmxiWEIwSUQ0Z01RMEtJQ0FnSUNBZ1B5QW42ckNaN0oyQUlPdXN1T3Exck91bHZDRHJpNlRzaTV3ZzdKcVU3TEt0N1pXYzY0dWtMaURzbmJRZzdJUzQ3SVdZN0plUTdJU2NJT3lkdE95Z2hPeVhrQ0Rzb0p6c2xZanRsb2pyalpnZzZyS0Q2NU9rNnJPOElPcXl1ZXk1bU95bmdDRHNsWXJyaXBRc0lPcTFyT3loc091Q21DRHNsclR0bkpqcXNJQWc3Wm1WN0l1azdaNklJT3VMcE91bHVDRHNnNGpyb1p6c21yUWc2NHlBN0pXSUlEUHFzSnpycGJ3Zw0KNnJlYzdMbVo2NHlBNjZHY0lFcFRUMDRnNjdDdzdKZTA2NkdjNjZlTU9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29kR1Y0ZENrTkNpQWdJQ0FnSURvZ0ordUxwT3lkakNCVlNTRHJyTGpxdGF6c25aZ2c2NHlBN0pXSUlEUHFzSnpycGJ3ZzZyZWM3TG1aNjR5QTY2R2NJRXBUVDA0ZzY3Q3c3SmUwNjZHYzY2ZU1PaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvZEdWNGRDazdEUW9nSUgwc0lHMXZaR1ZzS1RzTkNuME5DZzBLTHk4ZzY3S0k3SmV0SU8yRXRDRGlnSlFnNnJDWjdKMkFJT3lFdU95Rm1PeWRoQ0RzazdEcmtKZ3NJT3lkdE91eWlDRHRoTFRycDR3ZzdMYVU3TEtjSU8yWWxleUxuU2hLVTA5T0lPdXdzT3lYdENrZzY0eUE3SXVnSU91eWlPeVhyU0R0bUpYc2k1MG9TbE5QVGlEcXNKM3NzclFwN0oyRUlPeWFsT3Exck8yVm5PdUxwQTBLWm5WdVkzUnBiMjRnWVhOclZISmhibk5zWVhSbEtIUmxlSFFzSUcxdlpHVnNLU0I3RFFvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJQ2dOQ2lBZ0lDQW4NCjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NEcnNvanNsNjBnN0o2UjdKZUY3SjIwNjR1a0lDanJyTGpxdGF3ZzY0dWs2NU9zNnJpd0lPeVZoT3VMbUNEaWdKUWc2NHlBN0pXSUlEUHFzSndnNnJlYzdMbVo3SjJBSU95ZHRPdXlpQ0R0aExUc2w1QWc3S0NCN0pxcDdaV1k3S2VBSU95Vml1dUtsT3VMcENrdUlDY2dLdzBLSUNBZ0lDZnJpNlRzbll3Z1ZVa2c2Nnk0NnJXczZyQ0FJTzJWbk9xMXJleVd0T3VwdENEc25wRHNsN0RzaXFUcm42enNtclFnN0ppQjdKYTA2NkdjTENEc21JSHNsclRycWJRZzdKNlE3SmV3N0lxazY1K3M3SnEwSU8yVm5PcTFyZXlXdE91aG5DRHJzb2pzbDYzdGxaanJuYnd1SUNjZ0t3MEtJQ0FnSUNkVlNTRHJyTGpxdGF6cmk2VHNtclFnNnJDRTZyS3c3WldjSU8yUm5PMlloT3lkaENEc2s3RHFzNkFzSU95ZHRPdW1oTUszN0lpcjdKNlF3cmZycDRqc2lxVHRncm5DdCsyVWpPdWdpT3lkdE95S3BPMlpnT3VObE91S2xDRHF0N2pyaklEcm9ad2c2N08wN0tHMDdaV2M2NHVrTGlBbklDc05DaUFnDQpJQ0FuN0p1UTY2eTQ3SjJZSU95a2hDRHNpSmpycGJ3ZzZyZTQ2NHlBNjZHY0lPeWNvT3luZ08yVm5PdUxwQ0RpZ0pRZzdKdVE2Nnk0N0oyMElPMlZuQ0RzcElUc25iVHJxYlFnNjdLSTdKZXQ2NCtFSU8yVm5DRHNwSVRyb1p3c0lPeWtoT3V3bE9xL2lPeWRoQ0Rzbm9Uc25aanJvWndnN0xhVTZyQ0E3WldZN0tlQUlPeVZpdXVLbE91THBDNGdKeUFyRFFvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1VnNnJpSTdLZUFPaUFuSUNzTkNpQWdJQ0FuZXlKMGNtRnVjMnhoZEdWa0lqb2dJdXV5aU95WHJldXN1Q0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpTENBaVpHbHlaV04wYVc5dUlqb2dJbXR2NG9hU1pXNGc2NWlRNjRxVUlHVnU0b2FTYTI4aWZUb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLSFJsZUhRcERRb2dJQ2tzSUcxdlpHVnNLVHNOQ24wTkNnMEtMeThnNjdLSQ0KN0pldElPeWRrZXVMdGV5WGtPeUVuQ0I3ZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dWZTRHN0cFRzdHB3Z0tPeTlsT3VUbk8yT25PeUtwTUszN0pXZTY1S2tJT3llb2V1THRDRHRsNGpzbXFrcERRcG1kVzVqZEdsdmJpQndZWEp6WlZSeVlXNXpiR0YwWlNoeVlYY3BJSHNOQ2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdEUW9nSUdOdmJuTjBJRzBnUFNCekxtMWhkR05vS0M5Y2UxdGNjMXhUWFNwY2ZTOHBPdzBLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3RFFvZ0lIUnllU0I3RFFvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0RRb2dJQ0FnWTI5dWMzUWdkSEpoYm5Oc1lYUmxaQ0E5SUZOMGNtbHVaeWdvYnlBbUppQnZMblJ5WVc1emJHRjBaV1FwSUh4OElDY25LUzUwY21sdEtDazdEUW9nSUNBZ2FXWWdLSFJ5WVc1emJHRjANClpXUXBJSEpsZEhWeWJpQjdJSFJ5WVc1emJHRjBaV1FzSUdScGNtVmpkR2x2YmpvZ1UzUnlhVzVuS0NodklDWW1JRzh1WkdseVpXTjBhVzl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDA3RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5RFFvZ0lISmxkSFZ5YmlCdWRXeHNPdzBLZlEwS0RRb3ZMeURzblpIcmk3WHNsNURzaEp3Z2UzUmxlSFFzSUhKbFlYTnZibjBnNjdDdzdKZTBJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa05DbVoxYm1OMGFXOXVJSEJoY25ObFUzVm5aMlZ6ZEdsdmJuTW9jbUYzS1NCN0RRb2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3cwS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYRnRiWEhOY1UxMHFYRjB2S1RzTkNpQWdhV1lnDQpLRzBwSUhNZ1BTQnRXekJkT3cwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHRnljaUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdEUW9nSUNBZ2FXWWdLRUZ5Y21GNUxtbHpRWEp5WVhrb1lYSnlLU2tnZXcwS0lDQWdJQ0FnY21WMGRYSnVJR0Z5Y2cwS0lDQWdJQ0FnSUNBdWJXRndLQ2g0S1NBOVBpQW9leUIwWlhoME9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1MFpYaDBLU0I4ZkNBbkp5a3VkSEpwYlNncExDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tOQ2lBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvZUNrZ1BUNGdlQzUwWlhoMEtUc05DaUFnSUNCOURRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3lWaE91ZW1PdWhuQ0FxTHlCOURRb2dJSEpsZEhWeWJpQmJYVHNOQ24wTkNnMEtMeThnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsQ0RzZzRIdGc1enNuYndnNjVXTUlDOW9aV0ZzZEdnZzdLR3c3WnFNNnJDQUlPeVlwT3VwdENEcmtxVHNsNURzaEp3Zw0KN0p1TTY3Q043SmVGN0oyRUlPdUxwT3lMbkNEc2k1enJqNFR0bGJUcnM3anJpNlFnS0RNdzdMU0k3SmVRSURIcnNvanJwNHdwTGcwS0x5OGc3SVN4NnJPMTdaV1k2Nm0wSU9xeXNPcXp2Q0R0bGJqcms2VHJuNnpxc0lBZ1kyeGhkV1JsVTNSaGRIVnpQU2R2YXlmcm9ad2c2NUNZNjQrTTY2YXM2NitBNjZHY0xDRHNucXpyb1p6cXQ3anNuYmdnN1p1RUlPdXloTzJLdk95ZHRDRHNvSURzb0lqcm9ad2c4Sitmb3V5Y3ZPdWhuQ0RyczdYcXQ0RHRsWnpyaTZRdURRb3ZMeUFvN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc3SmV3SU91U3BDRHNvN3pxdUxEc29JSHNuTHpyb1p3Z0wyaGxZV3gwYU91bHZDRHNvYkR0bW96dGxaanJpcFFnNnJLRDZyTzhJT3lubmV5ZGhDRHNuYlRybzZ6cmk2UXBEUXBzWlhRZ2JHRnpkRUYxZEdoU1pYUnllVUYwSUQwZ01Ec05DbVoxYm1OMGFXOXVJSEpsZEhKNVFYVjBhRWxtVG1WbFpHVmtLQ2tnZXcwS0lDQnBaaUFvWTJ4aGRXUmxVM1JoZEhWeklDRTkNClBTQW5ZMnhoZFdSbExXeHZaMjkxZENjcElISmxkSFZ5YmpzTkNpQWdhV1lnS0hkaGFYUmxjaUI4ZkNCRVlYUmxMbTV2ZHlncElDMGdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEd2dNekF3TURBcElISmxkSFZ5YmpzZ0x5OGc3S2VFN1phSklPeWtrU0R0aExRZzY3Q3A3WlcwSU9xNGlPeW5nQ0FySURNdzdMU0lJT3F3aE9xeXFRMEtJQ0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQU0JFWVhSbExtNXZkeWdwT3cwS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU95ZXJPMlpsZXlkdUNEc2k1enJqNFRpZ0tZbktUc05DaUFnY25WdVZIVnliaWdvS1NBOVBpQW42NkdjNnJlNDdKMjRJTzJabGV5ZHVPeWFxZXlkdE91THBDNGdJazlMSXV1ZHZPcXpvT3VuakNEcmk3WHRsWmpybmJ3dUp5a3VkR2hsYmlnTkNpQWdJQ0FvS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU8yWmxleWR1T3VRcUNEaWdKUWc3S0NWN0lPQklPeURnZTJEbk91aG5DRHJzN1hxDQp0NEF1Snlrc0RRb2dJQ0FnS0dVcElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2xZVHNwNEVnNjZHYzZyZTQ3SjI0SU95VmlDRHJrS2c2Snl3Z1UzUnlhVzVuS0dVdWJXVnpjMkZuWlNrdWMyeHBZMlVvTUN3Z09EQXBLUTBLSUNBcE93MEtmUTBLRFFvdkx5RHNpNlR0aktnZzdKMlI2NHUxN0oyRUlPeUNyT3Vlak95YXFTRHNsWWpyZ3JUcm9ad2c2N09BN1ptWUlPS0FsQ0RzbTVEc25iZ282NkdjNnJlNDdKMjRMK3lFcE95NW1DbnNuYlFnN1l5TTdKV0Y2NUNjSU9xeXZleWFzT3lYbENEcXQ3Z2c3SldJNjRLMDY2VzhMQ0RzbFlUcmk0anJxYlFnN0tDUjY1R1E3SmEwSyt5YmtPdXN1T3lkaENEcnM3VHJncmpyaTZRTkNtWjFibU4wYVc5dUlHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z2NISmxabWw0S1NCN0RRb2dJR2xtSUNobElDWW1JR1V1YldWemMyRm5aU0E5UFQwZ1RFOUhTVTVmUjFWSlJFVXBJSEpsZEhWeWJpQjdJR1Z5Y205eU9pQk1UMGRKVGw5SFZVbEVSU3dnY0hKdllteGxiVG9nSjJOcw0KWVhWa1pTMXNiMmR2ZFhRbklIMDdEUW9nSUdsbUlDaGpiR0YxWkdWVGRHRjBkWE1nUFQwOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljcElIc05DaUFnSUNCeVpYUjFjbTRnZXlCbGNuSnZjam9nSit5ZHRDQlFRK3lYa0NCRGJHRjFaR1VnUTI5a1pTaGpiR0YxWkdVcDZyQ0FJT3lFcE95NW1PdVB2Q0Rzbm9qc3A0QWc3SldLN0pXRTdKcVVJT0tBbENEc2hLVHN1Wmp0bFpqcXM2QWc2NkdjNnJlNDdKMjQ3WldjSU91U3BDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5MQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25JSDA3RFFvZ0lIME5DaUFnY21WMGRYSnVJSHNnWlhKeWIzSTZJSEJ5WldacGVDQXJJQ2hsSUNZbUlHVXViV1Z6YzJGblpTQS9JR1V1YldWemMyRm5aU0E2SUZOMGNtbHVaeWhsS1NrZ2ZUc05DbjBOQ2cwS1puVnVZM1JwYjI0Z2NtVmhaRUp2Wkhrb2NtVnhLU0I3RFFvZ0lISmxkSFZ5YmlCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpTa2dQVDRnZXcwS0lDQWcNCklHeGxkQ0JpYjJSNUlEMGdKeWM3RFFvZ0lDQWdjbVZ4TG05dUtDZGtZWFJoSnl3Z0tHTXBJRDArSUhzZ1ltOWtlU0FyUFNCak95QjlLVHNOQ2lBZ0lDQnlaWEV1YjI0b0oyVnVaQ2NzSUNncElEMCtJSHNOQ2lBZ0lDQWdJSFJ5ZVNCN0lISmxjMjlzZG1Vb1NsTlBUaTV3WVhKelpTaGliMlI1S1NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGMyOXNkbVVvZTMwcE95QjlEUW9nSUNBZ2ZTazdEUW9nSUgwcE93MEtmUTBLRFFwamIyNXpkQ0JEVDFKVFgwaEZRVVJGVWxNZ1BTQjdEUW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MVBjbWxuYVc0bk9pQW5LaWNzRFFvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFOWlhSb2IyUnpKem9nSjBkRlZDd2dVRTlUVkN3Z1QxQlVTVTlPVXljc0RRb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxSVpXRmtaWEp6SnpvZ0owTnZiblJsYm5RdFZIbHdaU2NzRFFwOU93MEtablZ1WTNScGIyNGdhbk52YmloeVpYTXNJSE4wWVhSMWN5d2diMkpxDQpLU0I3RFFvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzTkNpQWdjbVZ6TG1WdVpDaEtVMDlPTG5OMGNtbHVaMmxtZVNodlltb3BLVHNOQ24wTkNnMEtZMjl1YzNRZ2MyVnlkbVZ5SUQwZ2FIUjBjQzVqY21WaGRHVlRaWEoyWlhJb1lYTjVibU1nS0hKbGNTd2djbVZ6S1NBOVBpQjdEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIME5DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkSFJWUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoYkhSb0p5a2dldzBLSUNBZ0lISmxkSEo1UVhWMGFFbG1UbVZsWkdWa0tDazdJQzh2SU91aA0Kbk9xM3VPeWR1Q0R0bFlUc21wUWc3SU9CN1lPYzY2bTBJT3llck8yWmxleWR1Q0RzaTV6cmo0UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVPeWR0Q0RyZ1ozcmdxenNuTHpycWJRZzY0dWs3SjJNSU95aHNPMmFqT3UyZ08yRXNDQndjbTlpYkdWdDdKMjBJTzJTZ091bXNPdUxwQTBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3RFFvZ0lDQWdJQ0J2YXpvZ2RISjFaU3dnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeXdnZGpvZ1FsSkpSRWRGWDFZc0lHUnBjam9nWDE5a2FYSnVZVzFsTENBdkx5QjJ3cmRrYVhJNklPcTFyT3V5aE95Z2hDL3NsNG5ybXJIdGxad2c3SUtzNjdPNDdKMjBJT3VXb0NEc25vanJpcFRzcDRBZzdLZUU2NHVvN0pxcERRb2dJQ0FnSUNCdGIyUmxiRG9nWTNWeWNtVnVkRTF2WkdWc0xDQnRiMlJsYkhNNklFRk1URTlYUlVSZlRVOUVSVXhUTENCbGVHRnRjR3hsY3pvZ1JWaEJUVkJNUlZNdWJHVnVaM1JvTENCbmRXbGtaVG9nUjFWSlJFVXViR1Z1WjNSb0xDQnlaV0ZrZVRvZ2QyRnkNCmJXVmtWWEFzRFFvZ0lDQWdJQ0J3Y205aWJHVnRPaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuYjJzbklIeDhJR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdiblZzYkNrZ1B5QnVkV3hzSURvZ1kyeGhkV1JsVTNSaGRIVnpMQTBLSUNBZ0lDQWdZV05qYjNWdWREb2dZMnhoZFdSbFFXTmpiM1Z1ZENncExBMEtJQ0FnSUNBZ2MyVnlkbVZrT2lCemRHRjBjeTV6WlhKMlpXUXNJR3hoYzNSQmREb2djM1JoZEhNdWJHRnpkRUYwTENCc1lYTjBWR1Y0ZERvZ2MzUmhkSE11YkdGemRGUmxlSFFzSUd4aGMzUlRaV002SUhOMFlYUnpMbXhoYzNSVFpXTXNEUW9nSUNBZ2ZTazdEUW9nSUgwTkNpQWdMeThnN1pTTTY1K3M2cmU0N0oyNElPeUxyT3llcGV1d2xldVBtU0RpZ0pRZzY0R0s2cml3NjZtMElPeWNoQ0Rxc0pEc2k1d2c3WU9BN0oyMDY2aTQ2ckNBSU91THBPdW1yT3VsdkNEcmdZanJpNlFOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDJobFlYSjBZbVZoDQpkQ2NwSUhzTkNpQWdJQ0JzWVhOMFFtVmhkQ0E5SUVSaGRHVXVibTkzS0NrN0RRb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3RFFvZ0lIME5DaUFnTHk4ZzY2R2M2cmU0N0oyNElPS0FsQ0R0bEl6cm42enF0N2pzbmJqc25aZ2dXL0NmbjZBZzdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVDRHRsWVRzbXBSZHdyZGI4SitVa1YwZzY3S0U3WXE4N0oyMElPMll1T3kybk8yVm5PdUxwQzROQ2lBZ0x5OGc2cml3NjdPNEtPdTRqT3Vkdk95YXNPeWdnQ0RzcDRIdGxva3BPaUJnWTJ4aGRXUmxJR0YxZEdnZ2JHOW5hVzRnTFMxamJHRjFaR1ZoYVdEcnBid2c3SWlvN0oyQUlPMlVoT3Vobk95RXVPeUtwT3VobkNEc2k2VHRsb2tnNG9DVUlPdXBsT3VKdENEc2w0YnNuYlFnNnJPbjdKNmxJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RxczZBc0RRb2dJQzh2SUNBZ2JHOWpZV3hvYjNOMElPeUltT3lMb0NEdGo2enRpcmpyb1p3ZzZyS3c2ck84NjZXOElPeWVrT3VQbVNEcw0KaUpqcm9MbnRsWnpyaTZRbzdJdWs3TGloT2lEdGw2VHJrNXpycHF6c2lxVHNsNURzaEp6cmo0UWc2N2lNNjUyODdKcXc3S0NBSU95WHRPdW12Q0FySUV4SlUxUkZUaUR0bVpYc25iZ3NJREl3TWpZdE1EY3BMZzBLSUNBdkx5QWdJTzJFc091dnVPdUVrT3lkdENEdG1aVHJxYlRzbDVBZzdLQ0U3WmlBSU95VmlDRHJuS3pyaTZRdUlPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmpycDR3ZzdaV1k2Nm0wSU91Qm5TNE5DaUFnTHk4ZzdZKzA2N0N4S08yRXNPdXZ1T3VFa0NrNklPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzY2ZUo3WjZNSU8yWm1PcXl2U2pydUl6cm5ienNtckRzb0lEcXNJQWdiRzlqWVd4b2IzTjA3SmVRSU91cXV5RHJpNy9zbFlRZzdMMlU2NU9jNnJDQUlPdXp0T3lkdE91S2xDRHFzcjNzbXJBcDdKZVE3SVNjRFFvZ0lDOHZJQ0FnNjZHYzZyZTQ3SjI0SU91TWdPcTRzQ0RzcEpFZzY3S0U3WXE4N0oyRUlPdVlrQ0RyaUlUcnBiVHJxYlFzSU95OWxPdVRuT3VsdkNEcnRwbnNsNnpyaEtQc25ZUWcNCjdJaVlJT3llaU91S2xDRHRoTERycjdqcmhKQWc2N0NwN0l1ZDdKeTg2NkdjSU95Z2hPMlptTzJWbk91THBDNE5DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMjl3Wlc0dGJHOW5hVzRuS1NCN0RRb2dJQ0FnWTI5dWMzUWdZbTlrZVNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdEUW9nSUNBZ1kyOXVjM1FnYzNkcGRHTm9UVzlrWlNBOUlDRWhLR0p2WkhrZ0ppWWdZbTlrZVM1emQybDBZMmhCWTJOdmRXNTBLVHNnTHk4ZzZyT0U3S0NWSU95Z2hPMlptQ0E5SU95TG5PMkJyT3VtdnlEc3NMM3NuTHpyb1p3ZzdKZTA3SmEwSU9xemhPeWdsZXlkaENEcXM2RHJwYndnN0lpWUlPeWVpT3F5akEwS0lDQWdJSFJ5ZVNCN0RRb2dJQ0FnSUNBdkx5RHNwNFR0bG9rZzdLU1I3SjI0NjQyd0lPdVlrQ0RyaUl6cm9JRHJpNlFnNG9DVUlPcTRpT3V3cVNnMk1PeTBpQ0RyZ3JRcElPdUxwT3lMbkNEcmlJVHJwYmdnNnJHMElDTHNzTDNzbllRZzY0dXI3SldZDQo2NHVrTCt1cXV5RHJ0S1RyaTZRaTdKZVFJT3F3Z09xNWpPeWFzT3V2Z091aG5DRHJ1SXpybmJ6c21yRHNvSURyb1p3ZzdKNnM3SXVjNjQrRTdaV2M2NHVrTGcwS0lDQWdJQ0FnTHk4ZzdaV2M3TEM0SU91U3BPeVhrT3VQaENEcm1KQWc2NGlFNjZXMDY0cVVJT3F4dENEcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wSU95OW5PdXdzZXlYa0NEcnFyc2c2NHUvN0pXRUlPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzdKV0lJT3VRbU91S2xDRHRtWmpxc3Izc25id2c3SWlZSU95ZWlPeWN2T3VMaUEwS0lDQWdJQ0FnTHk4ZzZyZTQ2NVdNNjZlTUlPeTlsT3VUbk91bHZDRHJ0cG5zbDZ6cmhLUHNuWVFnN0lpWUlPeWVpT3VLbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJTzJQdE91d3NlMlZuT3VMcENBbzY1R1FJT3V5aU95bnVDRHRnYlRycHEzc2w1QWc3WVN3NjYrNDY0U1E3SjIwSU8yS2dPeVd0T3VDbU95WXBPdXB0Q0RyaTdudG1hbnNpcVRybjczcmk2UXBMZzBLSUNBZ0lDQWdZMjl1YzNRZw0KYzNSaGJHVWdQU0JzYjJkcGJsQnliMk1nSmlZZ0tFUmhkR1V1Ym05M0tDa2dMU0JzYjJkcGJsTjBZWEowWldSQmRDQStJRFl3TURBd0tUc05DaUFnSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk1nSmlZZ2MzUmhiR1VwSUhzTkNpQWdJQ0FnSUNBZ2EybHNiRXh2WjJsdVVISnZZeWdwT3cwS0lDQWdJQ0FnSUNCcFppQW9JVzl3Wlc1TWIyZHBibFJsY20xcGJtRnNLQ2twSUhzTkNpQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNU3dnZXlCbGNuSnZjam9nSit5ZHRDQlBVK3lYa095RW9DRHNucERyajVuc25MenJvWndnNjZxN0lPeVh0T3lXdE95YWxDRGlnSlFnN1lTdzY2KzQ2NFNRN0plUTdJU2NJR05zWVhWa1pTRHNpNlR0bG9rZzdadUVJQzlzYjJkcGJpRHRsYlFnN0tPODdJUzQ3SnFVTGljZ2ZTazdEUW9nSUNBZ0lDQWdJSDBOQ2lBZ0lDQWdJQ0FnYTJsc2JGQnliMk1vS1RzTkNpQWdJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec05DaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXMNCmIyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0R0ajdUcnNMRWc0b0NVSU8yRXNPdXZ1T3VFa0NEcnNLbnNpNTNzbkx6cm9ad2c3S0NFN1ptWUxpY3BPdzBLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2diVzlrWlRvZ0ozUmxjbTFwYm1Gc0p5QjlLVHNOQ2lBZ0lDQWdJSDBOQ2lBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc2dMeThnN0pXZTdJU2dJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqc25iUWc2NHlBNnJpd0lPeWtrZXlkdE91cHRDRHNvSkhxczZBZzdJT0k2NkdjSU95WHNPdUxwQ0FvN0xDOTdKMkVJT3VMcSt5Vm1PcXhzT3VDbUNEcmk2VHNpNXdnNjRpRTY2VzRJT3F5dmV5YXNDa05DaUFnSUNBZ0lHeHZaMmx1VTNSaGNuUmxaRUYwSUQwZ1JHRjBaUzV1YjNjb0tUc05DaUFnSUNBZ0lDOHZJRUpTVDFkVFJWTHJwYndnN0pxdzY2YXNJTzJWdU91VHBPdWZyT3VobkNEc3A0RHNvSlVnNG9DVUlFTk1TZXF3Z0NEcnVJenJuYnpzDQptckRzb0lEcnBid2c3S2VCN0tDUklPeVh0T3luZ0NEc2xZcnFzNkFnVlZKTTY2ZU1JT3VFbU9xeXFPeWtnT3VMcEM0TkNpQWdJQ0FnSUM4dklPMlZ1T3VUcE91ZnJPcXdnQ0RzaTZUdGpLanRsWmpxc2JEcmdwZ2dRMHhKNnJDQUlFSlNUMWRUUlZMcnBid2c2NnkwN0l1YzdaVzA2NCtFSUVOTVNlcXdnQ0RzbFl6c2xZVHNoSndnNnJpdzY3TzRJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RycjREcm9ad2c2NkdjNnJlNDdKMjQ3SjJBSU91UW5PdUxwQ2htWVdsc0xYTnZablFwTGcwS0lDQWdJQ0FnWTI5dWMzUWdiRzluYVc1RmJuWWdQU0JQWW1wbFkzUXVZWE56YVdkdUtIdDlMQ0JEVEVGVlJFVmZSVTVXTENCN0lFSlNUMWRUUlZJNklIZHlhWFJsUW5KdmQzTmxja2hoYm1Sc1pYSW9jM2RwZEdOb1RXOWtaU0EvSUNkemQybDBZMmduSURvZ0oyNXZjbTFoYkNjcElIMHBPdzBLSUNBZ0lDQWdZMjl1YzNRZ2RHaHBjMHh2WjJsdUlEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25ZWFYwYUNjc0lDZHNiMmRwYmljcw0KSUNjdExXTnNZWFZrWldGcEoxMHNJSHNOQ2lBZ0lDQWdJQ0FnYzJobGJHdzZJSFJ5ZFdVc0lHVnVkam9nYkc5bmFXNUZibllzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzRFFvZ0lDQWdJQ0FnSUdSbGRHRmphR1ZrT2lCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUNFOVBTQW5kMmx1TXpJbkxDQXZMeUJyYVd4c1RHOW5hVzVRY205ajdKMllJT3EzdU91anVTQnJhV3hzN0pxcElDaHJhV3hzVUhKdlkrcXp2Q0RyajVuc25id2c3WXlvN1lTMEtRMEtJQ0FnSUNBZ2ZTazdEUW9nSUNBZ0lDQnNiMmRwYmxCeWIyTWdQU0IwYUdselRHOW5hVzQ3RFFvZ0lDQWdJQ0IwYUdselRHOW5hVzR1YjI0b0oyVnljbTl5Snl3Z0tDa2dQVDRnZXlCcFppQW9iRzluYVc1UWNtOWpJRDA5UFNCMGFHbHpURzluYVc0cElHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0lIMHBPdzBLSUNBZ0lDQWdkR2hwYzB4dloybHVMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0RRb2dJQ0FnSUNBZ0lHbG0NCklDaHNiMmRwYmxCeWIyTWdJVDA5SUhSb2FYTk1iMmRwYmlrZ2NtVjBkWEp1T3cwS0lDQWdJQ0FnSUNCc2IyZHBibEJ5YjJNZ1BTQnVkV3hzT3cwS0lDQWdJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpWR2x0WlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0d4dloybHVVSEp2WTFScGJXVnlLVHNnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J1ZFd4c095QjlEUW9nSUNBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3SUM4dklPeURpQ0RxczRUc29KWHNuYndnN0lpWUlPeWVpT3ljdk91TGlDRHJpNlRzbll3Z0wyaGxZV3gwYUNEcmxZd2c2NHVrN0l1Y0lPeWR2ZXE0c0EwS0lDQWdJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc29JanNzS2dnN0tLRjY2T01JQ2hqYjJSbElDY2dLeUJqYjJSbElDc2dKeWtuS1RzTkNpQWdJQ0FnSUgwcE93MEtJQ0FnSUNBZ2JHOW5hVzVRY205alZHbHRaWElnUFNCelpYUlVhVzFsYjNWMEtDZ3BJRDArDQpJSHNnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDQXhNT3UyaENEcXNyM3FzN3dnNG9DVUlPdU1nT3E0c0NEdGxJVHJvWnpzaExqc2lxUWc3S0NWNjZhc0xpY3BPeUJyYVd4c1RHOW5hVzVRY205aktDazdJSDBzSURZd01EQXdNQ2s3RFFvZ0lDQWdJQ0F2THlEcmdxSHNuWUFnN0o2RjdKNmw2cmFNN0oyRUlPdXN2T3F6b0NEc25vanJpcFFnNjR5QTZyaXdJT3lFdU95Rm1PeWRnQ0Ryc29UcnByRHJpNlFnNG9DVUlPeWVyT3Vobk9xM3VPeWR1Q0R0bTRRZzY0dWs3SjJNSU95YWxPeXlyZXlkdENEc2c0Z2c3SVM0N0lXWUtPeURpQ0Rzbm9Yc25xWHF0b3dwN0p5ODY2R2NJT3lMbk95ZWtlMlZtT3F5akEwS0lDQWdJQ0FnYTJsc2JGQnliMk1vS1RzTkNpQWdJQ0FnSUdGalkyOTFiblJEWVdOb1pTNWhkQ0E5SURBN0RRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVuSUNzZ0tITjNhWFJqYUUxdg0KWkdVZ1B5QW5JQ2pxczRUc29KVWc3S0NFN1ptWUlPS0FsQ0RzaTV6dGdhenJwcjhnN0xDOUtTY2dPaUFuSnlrZ0t5QW5JT0tBbENEcm9aenF0N2pzbmJqdGxaanJxYlFnN0o2UTY0K1pJT3lYc09xeXNPdVFxZXVMaU91THBDNG5LVHNOQ2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQnRiMlJsT2lCemQybDBZMmhOYjJSbElEOGdKMkp5YjNkelpYSXRjM2RwZEdOb0p5QTZJQ2RpY205M2MyVnlKeUI5S1RzTkNpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJsY25KdmNqb2dKK3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc2NnE3SU95WHRPeVhpT3lXdE95YWxEb2dKeUFySUdVdWJXVnpjMkZuWlNCOUtUc05DaUFnSUNCOURRb2dJSDBOQ2lBZ0x5OGdLTzJFc091dnVPdUVrQ0R0ajdUcnNMRWc2cldzN1ppRTY3YUFJT0tBbENEcnVJenJuYnpzbXJEc29JQWc3SjZRNjQrWklPeVpoT3Vqak9xd2dDRHMNCmxZZ2c2NUNZNjRxVUlPMlptT3F5dlNEc29JVHNtcWtwRFFvZ0lHWjFibU4wYVc5dUlHOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa2dldzBLSUNBZ0lIc05DaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2dJQ0FnSUNBZ0lDOHZJSE4wWVhKMDZyQ0FJT3lEaUNEc3ZaanNocFFnN0xDOTdKMkVJT3Vuak91VG9PdUxwQ0FvNjR1azY2YXM3SjJZSU95SXFPeWRnQ0Rzdlpqc2hwVHFzN3dnNjZ5MDZyU0E3WldZNnJLTUlPeUNyT3lhcWV5ZWtPeVhrT3F5akNEcnM3VHNub1FwTGcwS0lDQWdJQ0FnSUNBdkx5RHNuYlRzbHJUc2hKd2dVRzkzWlhKVGFHVnNiQ2d1Y0hNeEtleWR0Q0ExN0xTSUlPdVNwQ0RxdDdnZzdMQzk3SmVRSU95WGxPMkVzT3VsdkNEcnM3VHJnclFnTWV1eWlDanF0YXpyajRVZzZyT0U3S0NWS2V5ZGhDRHNucERyajVrZzdJU2c3WU9kN1pXWTZyT2dMQTBLSUNBZ0lDQWdJQ0F2THlEc3NMM3NuWVFnN0xXYzdJYU03Wm1VN1pXMElPeUNyT3lhDQpxZXlla0NEcmlJanNsNVFnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVPdW5qQ0RyZ3FqcXNvd2c3WldjNjR1a0xpRHNzTDNzbllRZzY2cTdJT3l3dnV5Y3ZPdXB0Q0RzbFlUcnJMVHFzb1ByajRRZzdKV0lJTzJWbk91THBBMEtJQ0FnSUNBZ0lDQXZMeUFvNjR1azY2VzRJT3l3dlNEc21LVHNub1hyb0tVZzY3Q3A3S2VBSU9LQWxDRHF0N2dnNnJLOTdKcXdJT3VwbE91SnRPcXdnQ0RyczdUc25iVHJpcFFnN0xHRTY2R2NJT3VDcU9xem9DRHNncXpzbXFuc25wRHFzSUFnN0plVTdZU3dJTzJWbkNEcnNvZ2c2NGlFNjZXMDY2bTBJT3VRcUNrdURRb2dJQ0FnSUNBZ0lDOHZJT3lqdk95ZG1Eb2dZMnhoZFdSbDZyQ0FJT3k5bU95R2xDRHNvSnpycXFuc25ZUWc2N0NVNnI2NDY2bTBJRUZ3Y0VGamRHbDJZWFJsTDBacGJtUlhhVzVrYjNmcXNJQWc2NnE3SU95d3Z1eWRoQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHNuSWpyajRUc21yQWc3SXVrNnJpdzdKZVE3SVNjSU8yWmxleWR1Q0R0bFlUc21wUXVEUW9nSUNBZw0KSUNBZ0lHTnZibk4wSUhCek1TQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ykc5bmFXNHVjSE14SnlrN0RRb2dJQ0FnSUNBZ0lHWnpMbmR5YVhSbFJtbHNaVk41Ym1Nb2NITXhMQ0JiRFFvZ0lDQWdJQ0FnSUNBZ0oxTjBZWEowTFZOc1pXVndJQzFUWldOdmJtUnpJRFVuTEEwS0lDQWdJQ0FnSUNBZ0lDY2tkM01nUFNCT1pYY3RUMkpxWldOMElDMURiMjFQWW1wbFkzUWdWMU5qY21sd2RDNVRhR1ZzYkNjc0RRb2dJQ0FnSUNBZ0lDQWdJbWxtSUNna2QzTXVRWEJ3UVdOMGFYWmhkR1VvSjJOc1lYVmtaUzFzYjJkcGJpY3BLU0I3SWl3TkNpQWdJQ0FnSUNBZ0lDQWlJQ0FrZDNNdVUyVnVaRXRsZVhNb0ozNG5LU0lzRFFvZ0lDQWdJQ0FnSUNBZ0p5QWdVM1JoY25RdFUyeGxaWEFnTFZObFkyOXVaSE1nTWljc0RRb2dJQ0FnSUNBZ0lDQWdJaUFnUVdSa0xWUjVjR1VnTFU1aGJXVnpjR0ZqWlNCVklDMU9ZVzFsSUZjZ0xVMWxiV0psY2tSbFptbHVhWFJwYjI0Z0oxdEUNCmJHeEpiWEJ2Y25Rb1hDSjFjMlZ5TXpJdVpHeHNYQ0lwWFNCd2RXSnNhV01nYzNSaGRHbGpJR1Y0ZEdWeWJpQlRlWE4wWlcwdVNXNTBVSFJ5SUVacGJtUlhhVzVrYjNjb2MzUnlhVzVuSUdNc0lITjBjbWx1WnlCMEtUc2dXMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUdKdmIyd2dVMmh2ZDFkcGJtUnZkeWhUZVhOMFpXMHVTVzUwVUhSeUlHZ3NJR2x1ZENCdUtUc25JaXdOQ2lBZ0lDQWdJQ0FnSUNBaUlDQWthQ0E5SUZ0VkxsZGRPanBHYVc1a1YybHVaRzkzS0Z0T2RXeHNVM1J5YVc1blhUbzZWbUZzZFdVc0lDZGpiR0YxWkdVdGJHOW5hVzRuS1NJc0RRb2dJQ0FnSUNBZ0lDQWdKeUFnYVdZZ0tDUm9JQzF1WlNCYlUzbHpkR1Z0TGtsdWRGQjBjbDA2T2xwbGNtOHBJSHNnVzNadmFXUmRXMVV1VjEwNk9sTm9iM2RYYVc1a2IzY29KR2dzSURZcElIMG5MQ0F2THlBMklEMGdVMWRmVFVsT1NVMUpXa1VOQ2lBZ0lDQWdJQ0FnSUNBbmZTY3NEUW9nDQpJQ0FnSUNBZ0lGMHVhbTlwYmlnblhISmNiaWNwSUNzZ0oxeHlYRzRuS1RzTkNpQWdJQ0FnSUNBZ1kyOXVjM1FnWW1GMElEMGdjR0YwYUM1cWIybHVLRzl6TG5SdGNHUnBjaWdwTENBblkyeGhkV1JsTFdKeWFXUm5aUzFzYjJkcGJpNWlZWFFuS1RzTkNpQWdJQ0FnSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloaVlYUXNJQ2RBWldOb2J5QnZabVpjY2x4dUp5QXJEUW9nSUNBZ0lDQWdJQ0FnSjNOMFlYSjBJQ0pqYkdGMVpHVXRiRzluYVc0aUlHTnRaQ0F2YXlCamJHRjFaR1VnTDJ4dloybHVYSEpjYmljZ0t3MEtJQ0FnSUNBZ0lDQWdJQ2R3YjNkbGNuTm9aV3hzSUMxT2IxQnliMlpwYkdVZ0xVVjRaV04xZEdsdmJsQnZiR2xqZVNCQ2VYQmhjM01nTFVacGJHVWdJaWNnS3lCd2N6RWdLeUFuSWx4eVhHNG5LVHNOQ2lBZ0lDQWdJQ0FnYzNCaGQyNG9KMk50WkNjc0lGc25MMk1uTENCaVlYUmRMQ0I3SUdWdWRqb2dRMHhCVlVSRlgwVk9WaXdnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0IzYVc1a2IzZHpTR2xrWlRvZw0KZEhKMVpTQjlLVHNOQ2lBZ0lDQWdJSDBnWld4elpTQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0oyUmhjbmRwYmljcElIc05DaUFnSUNBZ0lDQWdMeThnY0hSNUtHVjRjR1ZqZENucm9ad2c2N08wNjRLNElPMkNwT3lYa0NEdGdiVHJvWnpyazV3Z1ZGVko2ckNBSU91c3RPdXdtT3lka2V5ZHVDRHFzb1BzbmJRZzdJdWs3TGloSU8yWmxleWR1T3VRcUNneU1ESTJMVEEzTENEc25ienJzSmdnWEhMQ3QydHBkSFI1SU95OWxPdVRuQ0RycXFqcmtaQXBJT0tBbEEwS0lDQWdJQ0FnSUNBdkx5RHNuS0RzbmJ6dGxad2c3SjZRNjQrWjdabVVJT3F5dmV1aG5PdUtsQ0JUZVhOMFpXMGdSWFpsYm5SejdKMllJT3luaE95bm5DRHRncVFnN0o2RjY2Q2xMaURzb0pIcXQ3enNoTEVnNnJhTTdaV2M3SjIwSU95ZWlPeWN2T3VwdENBMjdMU0lJT3VTcENEc2w1VHRoTERxc0lBZzdKNlE2NCtaSU95ZWhldWdwZXVQdkEwS0lDQWdJQ0FnSUNBdkx5QXg2N0tJS09xMXJPdVBoU0RxczRUc29KVXA3SjIwSU95RW9PMkQNCm5ldVFtT3F6b0N3ZzZyYU03WldjN0oyMElPeVhodXljdk91cHRDQnJaWGx6ZEhKdmEyVWc3S1NFNjZlTUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxiUWc3SUtzN0pxcDdKNlE2ckNBSU95WGxPMkVzQ0R0bFp3ZzY3S0lJT3VJaE91bHRPdXB0Q0Rya0p6cmk2UW9abUZwYkMxemIyWjBLUzROQ2lBZ0lDQWdJQ0FnTHk4ZzdKZVU3WVN3SU95bmdleWdoT3lYa0NCVVpYSnRhVzVoYk95ZGhDRHJpNlRzaTV3ZzdKV2U3Snk4NjZHY0lPcXdnT3lndU95WmdDRHJpNlRycGJnZzdKV3g3SmVRSU8yQ3BPcXdnQ0RyazZUc2xyVHFzSURyaXBRZzZyS0Q3SjJFSU91bmlldUtsT3VMcEM0TkNpQWdJQ0FnSUNBZ2MzQmhkMjRvSjI5ellYTmpjbWx3ZENjc0lGc05DaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlWR1Z5YldsdVlXd2lJSFJ2SUdSdklITmpjbWx3ZENBaVkyeGhkV1JsSUM5c2IyZHBiaUluTEEwS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1DQpJQ0pVWlhKdGFXNWhiQ0lnZEc4Z1lXTjBhWFpoZEdVbkxBMEtJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZGtaV3hoZVNBMkp5d05DaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlWR1Z5YldsdVlXd2lJSFJ2SUdGamRHbDJZWFJsSnl3TkNpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBblpHVnNZWGtnTUM0ekp5d05DaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlVM2x6ZEdWdElFVjJaVzUwY3lJZ2RHOGdhMlY1YzNSeWIydGxJSEpsZEhWeWJpY3NEUW9nSUNBZ0lDQWdJQ0FnTHk4ZzdKZVU3WVN3NnJDQUlPeUxwT3lnbk91aG5DRHJrNlRzbHJUcXNJUWc2cks5N0pxdzdKZVE2NmVNSU95WHJPcTRzQ0RyajRUcmk2d282cmFNN1pXY0lPeVhodXljdk91cHRDRHNuSVRzbDVEc2hKd2c3S1NSNjR1b0tTRGlnSlFnN1lTdzY2KzQ2NFNRN0oyRUlPeTVtT3liakNEcnVJenJuYnpzbXJEc29JRHJwNHdnNjRLbzZyaTA2NHVrRFFvZ0lDQWdJQ0FnSUNBZw0KSnkxbEp5d2dKMlJsYkdGNUlERXVOU2NzRFFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QnpaWFFnYldsdWFXRjBkWEpwZW1Wa0lHOW1JR1p5YjI1MElIZHBibVJ2ZHlCMGJ5QjBjblZsSnl3TkNpQWdJQ0FnSUNBZ1hTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3RFFvZ0lDQWdJQ0I5SUdWc2MyVWdldzBLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdabUZzYzJVN0lDOHZJT3luZ095YmtDRHNsWWdnN1pXWTY0cVVJRTlURFFvZ0lDQWdJQ0I5RFFvZ0lDQWdJQ0J5WlhSMWNtNGdkSEoxWlRzTkNpQWdJQ0I5RFFvZ0lIME5DaUFnTHk4ZzdZRzA2NkdjNjVPY0lPcXpoT3lnbFNEcm9aenF0N2pzbFlUc200TWc0b0NVSU8yVWpPdWZyT3EzdU95ZHVDRHRtWWpzblpnZ1crdWhuT3EzdU95VmhPeWJnMTBnNjdLRTdZcTg3SjIwSU8yWXVPeTJuQzRnWTJ4aGRXUmxJR0YxZEdnZ2JHOW5iM1YwN0p5ODY2R2NJRU5NU1NEcm9aenF0N2pzbmJqc25ZUWcNCjdaVzA3S0NjN1pXYzY0dWtMZzBLSUNBdkx5QW83SjIwSUZCRDdKMllJT3lnZ095ZXBldVFuQ0RzbnBEcXNxbnNwcDNycW9Yc25ZUWc3S2VBN0pxMDY0dWtJT0tBbENEcmk2VHNpNXdnN0pPdzY2Q2s2Nm0wSU95ZXJPdWhuT3EzdU95ZHVDRHRsWVRzbXBRdUtTRHJvWnpxdDdqc2xZVHNtNE1nN1p1RTdKZVVJT3lFdU95Rm1NSzM2ck9FN0tDVjdMcVE3SXVjNjZXOElPeWdsZXVtck8yVm5PdUxwQzROQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDJOc1lYVmtaUzFzYjJkdmRYUW5LU0I3RFFvZ0lDQWdZMjl1YzNRZ2JHOGdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjI5MWRDZGRMQ0I3SUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUVOTVFWVkVSVjlGVGxZc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbElIMHBPdzBLSUNBZ0lHeGxkQ0JsY25JZ1BTQW5KenNOQ2lBZ0lDQnNieTV6ZEdSbGNuSXViMjRvSjJSaGRHRW5MQ0FvDQpaQ2tnUFQ0Z2V5QmxjbklnS3owZ1pDNTBiMU4wY21sdVp5Z3BPeUI5S1RzTkNpQWdJQ0JzYnk1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V5QnFjMjl1S0hKbGN5d2dOVEF3TENCN0lHOXJPaUJtWVd4elpTd2daWEp5YjNJNklDZnJvWnpxdDdqc2xZVHNtNE1nN0l1azdaYUpJT3lMcE8yTXFEb2dKeUFySUdVdWJXVnpjMkZuWlNCOUtUc2dmU2s3RFFvZ0lDQWdiRzh1YjI0b0oyTnNiM05sSnl3Z0tHTnZaR1VwSUQwK0lIc05DaUFnSUNBZ0lHdHBiR3hRY205aktDazdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQXZMeURyb1p6cXQ3anNsWVRzbTRQcmtKd2c2ck9FN0tDVjdKMkVJT3Vzdk91Tm1DRHJqSURxdUxBZzdJUzQ3SVdZN0oyRUlPdXloT3Vtc091THBBMEtJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec2dJQ0FnSUNBZ0lDOHZJT3VMcE95ZGpDQXZZV05qYjNWdWRNSzNMMmhsWVd4MGFPeVhrT3lFbkNEcXM0VHNvSlhzbllRZzdJT0k2NkdjS0Qzc2w0YnNuWXpzbkx6cm9ad3BJT3lkdmVxeQ0KakEwS0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdiblZzYkRzZ0lDQWdJQ0FnSUM4dklPeURnZTJEbkNEc25xenRqSkRzb0pVbzY0dWs3SjJNSU8yRXRPeVhrT3lFbkNEcnI3anJvWnpxdDdqc25iZ2c2ckNRN0tlQUtRMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNsWVRzbTRNZ0tHTnZaR1VnSnlBcklHTnZaR1VnS3lBbktTY3BPdzBLSUNBZ0lDQWdhV1lnS0hKbGN5NW9aV0ZrWlhKelUyVnVkQ2tnY21WMGRYSnVPeUF2THlCbGNuSnZjaUR0bGJqcms2VHJuNnpxc0lBZzdKMjA2Nis0SU95ZGtldUx0ZTJXaU95Y3ZPdXB0Q0RzcEpIcnM3VWc2N0NwN0tlQURRb2dJQ0FnSUNCcFppQW9ZMjlrWlNBOVBUMGdNQ2tnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU0I5S1RzTkNpQWdJQ0FnSUdWc2MyVWdhbk52YmloeVpYTXNJRFV3TUN3Z2V5QnZhem9nWm1Gc2MyVXNJR1Z5Y205eU9pQW9aWEp5TG5SeWFXMG9LUzV6YkdsalpTZ3cNCkxDQXhOVEFwS1NCOGZDQW9KK3lpaGV1ampDRHN2WlRyazV3Z0p5QXJJR052WkdVcElIMHBPdzBLSUNBZ0lIMHBPdzBLSUNBZ0lISmxkSFZ5YmpzTkNpQWdmUTBLSUNBdkx5RHNucERxdUxBZzdLS0Y2Nk9NSU9LQWxDRHRnYlRyb1p6cms1enJpNlRycHF3dDY0R0U2cml3TG1KaGRPeWR0Q0R0bUxqc3RwenRsWnpyaTZRZ0tPdWhuT3k3ck95WGtPeUVuT3VuakNEc29KSHF0N3dnNnJDQTY0cWw3WldZNjR1SUlPeVZpT3lnaENrTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dldzBLSUNBZ0lHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdEUW9nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lpaGV1ampDRHNtcFRzc3EwZzY3Q2I3SjJNSU9LQWxDRHJpNlRycHF6cnBid2c2NEdWNjR1STY0dWtMaWNwT3cwS0lDQWdJR3RwYkd4UWNtOWpLQ2s3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvDQpLU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdEUW9nSUNBZ2NtVjBkWEp1T3cwS0lDQjlEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl5WldOdmJXMWxibVFuS1NCN0RRb2dJQ0FnWTI5dWMzUWdleUIwWlhoMExDQnRiMlJsYkNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNOQ2lBZ0lDQnBaaUFvSVhSbGVIUWdmSHdnSVZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0NrcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuN0xhVTdMS2M2N0NiN0oyRUlPdXN1T3Exck9xd2dDRHJ1WVRzbHJRZzdKNkk3SXExNjR1STY0dWtMaWNnZlNrN0RRb2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3RFFvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95MmxPeXluQ0RzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lEVXdLUzV5WlhCcw0KWVdObEtDOWNiaTluTENBbklDY3BJQ3NnSitLQXBpY3NJRzF2WkdWc0lEOGdKeWpycXFqcmpiZzZJQ2NnS3lCdGIyUmxiQ0FySUNjcEp5QTZJQ2NuS1RzTkNpQWdJQ0IwY25rZ2V3MEtJQ0FnSUNBZ1kyOXVjM1FnY21GM0lEMGdZWGRoYVhRZ1lYTnJRMnhoZFdSbEtGTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3NJRzF2WkdWc0tUc05DaUFnSUNBZ0lHTnZibk4wSUhOMVoyZGxjM1JwYjI1eklEMGdjR0Z5YzJWVGRXZG5aWE4wYVc5dWN5aHlZWGNwT3cwS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3cwS0lDQWdJQ0FnYVdZZ0tDRnpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ3BJSHNOQ2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1qT3lMc1NEc2k2VHRqS2dnS0NjZ0t5QnpaV01nS3lBbmN5azZKeXdnVTNSeWFXNW5LSEpoZHlrdWMyeHBZMlVvTUN3Z01qQXdLU2s3RFFvZ0lDQWcNCklDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3RFFvZ0lDQWdJQ0I5RFFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SldJSUNjZ0t5QnpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dLeUFuNnJDY0lDZ25JQ3NnYzJWaklDc2dKM01wSnlrN0RRb2dJQ0FnSUNCemRHRjBjeTV6WlhKMlpXUXJLenNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPdzBLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQlRkSEpwYm1jb2RHVjRkQ2t1YzJ4cFkyVW9NQ3dnTXpBcE93MEtJQ0FnSUNBZ2MzUmhkSE11YkdGemRGTmxZeUE5SUhObFl6c05DaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhOMVoyZGxjM1JwDQpiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaTZUdGpLZzZKeXdnWlM1dFpYTnpZV2RsS1RzTkNpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lDZnRnYlRyb1p6cms1d2c3Wmk0N0xhY0lPeUxwTzJNcURvZ0p5a3BPdzBLSUNBZ0lIME5DaUFnZlEwS0lDQXZMeURyc29qc2w2MGc0b0NVSU8yVm5PcTFyZXlXdENEaWhwUWc3SmlCN0phMElPeWVrT3VQbVNBbzdMYVU3TEtjNnJPOElPcXdtZXlkZ0NEc2hManNoWmdnN0lLczdKcXBLUTBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZEhKaGJuTnNZWFJsSnlrZ2V3MEtJQ0FnSUdOdmJuTjBJSHNnZEdWNGRDd2diVzlrWld3Z2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3RFFvZ0lDQWdhV1lnS0NGMA0KWlhoMElIeDhJQ0ZUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKK3V5aU95WHJlMlZvQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPdzBLSUNBZ0lHTnZibk4wSUhOMFlYSjBaV1FnUFNCRVlYUmxMbTV2ZHlncE93MEtJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdKcVU3TEt0T2ljc0lGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0ExTUNrdWNtVndiR0ZqWlNndlhHNHZaeXdnSnlBbktTQXJJQ2ZpZ0tZbktUc05DaUFnSUNCMGNua2dldzBLSUNBZ0lDQWdZMjl1YzNRZ2NtRjNJRDBnWVhkaGFYUWdZWE5yVkhKaGJuTnNZWFJsS0ZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0Nrc0lHMXZaR1ZzS1RzTkNpQWdJQ0FnSUdOdmJuTjBJRzkxZENBOUlIQmhjbk5sVkhKaGJuTnNZWFJsS0hKaGR5azdEUW9nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXUNCmJtOTNLQ2tnTFNCemRHRnlkR1ZrS1NBdklERXdNREFwTG5SdlJtbDRaV1FvTVNrN0RRb2dJQ0FnSUNCcFppQW9JVzkxZENrZ2V3MEtJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdLSTdKZXRJTzJNak95THNTRHNpNlR0aktnZ0tDY2dLeUJ6WldNZ0t5QW5jeWs2Snl3Z1UzUnlhVzVuS0hKaGR5a3VjMnhwWTJVb01Dd2dNakF3S1NrN0RRb2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzblpIcmk3WHNuWVFnN1pXMDdJU2Q3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93MEtJQ0FnSUNBZ2ZRMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNtWVRybzR3Z0tDY2dLeUJ6WldNZ0t5QW5jeXdnSnlBcklDaHZkWFF1WkdseVpXTjBhVzl1SUh4OElDYy9KeWtnS3lBbktTY3BPdzBLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0RRb2dJQ0FnDQpJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURNd0tUc05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdEUW9nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCMGNtRnVjMnhoZEdWa09pQnZkWFF1ZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dU9pQnZkWFF1WkdseVpXTjBhVzl1TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryc29qc2w2MGc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3RFFvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPdXlpT3lYclNEcw0KaTZUdGpLZzZJQ2NwS1RzTkNpQWdJQ0I5RFFvZ0lIME5DaUFnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURRc0lIc2daWEp5YjNJNklDZE9iM1FnWm05MWJtUW5JSDBwT3cwS2ZTazdEUW9OQ2k4dklPeWR0T3V2dUNEcmk2VHJwcXpxc0lBZzY1YWdJT3llaU91S2xPdU5zQ0RybUpBZzdMeWM2cml3NnJDQUlPdVRwT3lXdE95WXBPdXB0Q2pzb0p6c2lxVHNzcGdnN0o2UTY0K1pJT3k4bk9xNHNDRHNwSkhyczdVZzY1T3hLU0Rzb2JEc21xbnRub2dnN0tLRjY2T01JT0tBbENEcmo0enJqWmdnNjR1azY2YXM2NHFVSU9xM3VPdU1nT3VobkNEc25LRHNwNEFOQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXcwS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2V3MEtJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNuYlRycjdnZzdMeWM3S0M0SU95ZWlPeVd0T3lhbENqdGo2enRpcmdnSnlBcklGQlBVbFFnS3lBbklPeUNyT3lhcVNEc3BKRXANCklPS0FsQ0RzbmJRZzdKMjQ3SXFrN1lTMDdJcWs2NHFVSU95aWhldWpqTzJWcWV1TGlPdUxwQzRuS1RzTkNpQWdJQ0J3Y205alpYTnpMbVY0YVhRb01DazdEUW9nSUgwTkNpQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95RW5PdXloQ0RzbUtUcnBaZzZKeXdnWlNBbUppQmxMbTFsYzNOaFoyVXBPdzBLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3RFFwOUtUc05DaTh2SU95V3RPdVdwQ0Rxc3Izcm9aenJvWndnN0tPOTY1T2dLT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFzSUVOMGNtd3JReXdnTDNOb2RYUmtiM2R1TENEc21LVHJwWmdwSUdOc1lYVmtaU0RzbnBEc2k1M3NuWVFnNjRLbzZyaXc3S2VBSU95Vml1dUtsT3VMcEEwS2NISnZZMlZ6Y3k1dmJpZ25aWGhwZENjc0lDZ3BJRDArSUhzZ2EybHNiRkJ5YjJNb0tUc2dhMmxzYkV4dloybHVVSEp2WXlncE95QjlLVHNOQ25CeWIyTmxjM011YjI0b0oxTkpSMGxPVkNjc0lDZ3BJRDArSUhCeWIyTmxjM011WlhocGRDZ3dLU2s3RFFwd2NtOWpaWE56DQpMbTl1S0NkVFNVZFVSVkpOSnl3Z0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBLVHNOQ2cwS2MyVnlkbVZ5TG14cGMzUmxiaWhRVDFKVUxDQW5NVEkzTGpBdU1DNHhKeXdnS0NrZ1BUNGdldzBLSUNCamIyNXpiMnhsTG14dlp5Z240cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBSnlrN0RRb2dJR052Ym5OdmJHVXViRzluS0NjZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93MEtJQ0JqYjI1emIyeGxMbXh2WnlnbklPdXFxT3VOdURvZ0p5QXJJRU5NUVZWRVJWOU5UMFJGVENBcklDY2d3cmNnN0ppSTdJdWNJQ2NnS3lCRldFRk5VRXhGVXk1cw0KWlc1bmRHZ2dLeUFuNnJHMElPeWVwZXl3cVNjcE93MEtJQ0JqYjI1emIyeGxMbXh2WnlnbklPeWR0Q0Rzc0wzc25ZUWc3THljNjVHVUlPdVBtZXlWaUNEdGxMenF0N2pycDRnZzdaU002NStzNnJlNDdKMjQ3SjIwSU8yQnRPdWhuT3VUbk91aG5DRHN0cFRzc3B6dGxhbnJpNGpyaTZRdUp5azdEUW9nSUdOdmJuTnZiR1V1Ykc5bktDZmlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFuS1RzTkNpQWdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1RzZ0x5OGdRMnhoZFdSbElFTnZaR1VnN0lLczdKcXBJT3F3Z091S3BTRHNsNnpydG9BZzdLQ1E2cktBSUNqdGxJenJuNnpxdDdqc25iZ2c3SldJNjRLMDdKcXBLUTBLSUNBdkx5RHINCnI3anJwcXdnN0l1YzY0K1pJQ3NnN0tlQTdJdWM2Nnk0SU95anZPeWVoU0RpZ0pRZzdMS3JJT3kybE95eW5PdTJnTzJFc0NEcnVhRHJwYlRxc293TkNpQWdZWE5yUTJ4aGRXUmxLQ2ZzbTR6cnNJM3NsNFU2SUNMc29JRHNucVVnNjVDWTdKZUk3SXExNjR1STY0dWtJaWNwTG5Sb1pXNG9EUW9nSUNBZ0tDa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWJqT3V3amV5WGhTRHNtWVRybzR3ZzRvQ1VJT3kybE95eW5DRHNwSURydVlRZzY0R2RMaWNwTEEwS0lDQWdJQ2hsS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0p1TTY3Q043SmVGSU95THBPMk1xQ0FvN0xLcklPeWFsT3l5clNEcmxZd2c3SjZzN0l1YzY0K0VLVG9uTENCbExtMWxjM05oWjJVcERRb2dJQ2s3RFFwOUtUc05DZz09DQo6OkVYQU1QTEVTOjoNCkl5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzDQpwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydA0KbGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWENCmxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVDQo3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TA0Kbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXkNCmhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVDQo3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3Zw0KN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVcNCnRPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWDQptT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIcw0KbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0kNCjdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnDQo3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvag0KSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVANCm1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyDQpvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8ySw0KdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVYNCmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyDQppNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Qw0KdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXcNCmdDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzDQpuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRQ0KN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHMNCm5JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhDQpsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMA0KSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzMNCjZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzDQppSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEcw0KaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGcNCjdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhDQpxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqcw0KbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjANCklPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVoDQpuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMA0KN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTANCjY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RyDQpwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZw0KNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXcNCnZ1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLDQpMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZw0KN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHINCnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVDQpQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aA0KbkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0NCjo6R1VJREU6Og0KSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5BMEtEUW9qSXlBeExpRHRsYlRzbXBUc3NyUU5DZzBLN0tDYzdaS0lJT3lWaU95ZG1DRHJxcWpyazZBZzY2eTQ2cldzNjRxVUlDZnRsYlRzbXBUc3NyUW42NkdjSU95TnFPeWFsQzROQ3V5ZHZPcTBnT3lFc1NEc25vanJpcFFnN0lLczdKcXA3SjZRSU9xeXZlMlhtT3lkaENEcnA0enJrNlFnN0lpWUlPeWVpT3VQaE91aG5TQXFLdXlEZ2UyWnFTd2c2NmVsNjUyOTdKMkVJT3UyaU91c3VPMlZtT3F6b0NEcnFxanJrNkFnNjZ5NDZyV3M3SmVRSU8yVnRPeWFsT3l5dE91bHZDRHNvSUhzbXFudGxiVHNvN3pzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEcnM3VHJnNFhyaTRqcmk2UWc0b2FTSU91enRPdUN2T3F5ak95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJT3kxbk91TWdPMlZuQ0FxS3V1S3BldVBtZTJZbFNEcnJManNucVVxS3V5ZGhDRHNqYWpzbzd6c2hManMNCm1wUXVJT3lJbU91UG1lMllsU0Ryckxqc25xWHNuWUFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNUzNzaUpqcmo1bnRtSlV0NjZ5NDdKNmw3SjJFTGV5TnFPdVBoQzNya0pqcmlwUXQ2cks5N0pxd0tleVhrQ0R0bGJUcmk3bnRsYUFnNjVXTTY2ZU1JT3lUc091S2xDRHFzb3dnN0tLTDdKV0U3SnFVTGcwS0RRb2pJeU1nNjVDUTdKYTA3SnFVSU9LR2tpRHRsb2pzbHJUc21wUU5DZzBLN0ppSUtRMEtMU0RzaEtUc29KWHJrSkRzbHJUc21wUWc0b2FTSU95RXBPeWdsZTJXaU95V3RPeWFsQTBLRFFvakl5TWdKMzdzbDRnbklPdTV2T3E0c0EwS0RRcnNtSWdwRFFvdElPdXdsT3VBak95WGlPeVd0T3lhbENEaWhwSWc2N0NVNnIrbzdKYTA3SnFVRFFvTkNpTWpJeURyajVuc2dxd2c2N0NVNnIrVTdKT3c2cml3RFFvTkN1eVlpQ2tOQ2kwZzY0YVM3SldFN0tHTTdKYTA3SnFVSU9LR2tpRHNtS3pybnBEc2xyVHNtcFFOQ2cwS0tpb3FEUW9OQ2lNaklETXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFODQpDZzBLN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RydG9Ec29KWHNvSUVnN0x1azY2Nms2NHVJN0x5QTdKMjA3SVdZN0oyRUlPeTFuT3VNZ08yVm5DRHNwSVRzbmJUcXM2QWc2cmlON0tDVjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqc283enNoTGpzbXBRdURRcnJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUTXQ2N2FBN0tDVjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNqYWpzbXBRdURRb05DdXlZaUNBNklPeVZpQ0Ryajd6c21wUXNJT3lYaHV5V3RPeWFsQ0FvV0NrZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJeURzbDRic2xyVHNtcFFnNG9hU0lPeWVpT3lXdE95YWxBMEtEUXJzbUlncERRb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bFpqcXVMQWc3S0NFN0plUTY0cVVJT3F3Z095ZWhlMlZvQ0RzaUpnZw0KN0plRzdKYTA3SnFVSU9LR2tpRHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WlcwN0pXOElPcXdnT3llaGUyVm9DRHNpSmdnN0o2STdKYTA3SnFVRFFvTkNpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFEUW9OQ3V5WGtPdWZyQ0RzZzRIdG1hbnNsNURzaEp6cmo0UWdJdTJWdE9xeXNDRHJzS25yc3BVaTdKMkVJT3Vvdk95Z2dDRHNsWXpyb0tUc283enJpcFFnNnJpTjdLQ1Y3WmlWSU9xMXJPeWhzT3VobkNEc2phanNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRnNG9hU0lPeVZzZXlkaENEc2w0WHJqYkRzbmJUdGlyanRsYlRzbzd6c2hManNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95MW5PeUwNCm9DRHJzb1Rzb0lUc25iUWc3WldFN0pxVTdaVzA3SnFVTGcwS0RRbzZPam9nZEdsd0lPdUxwT3lkdE95V3ZPdWhuT3EzdUNEc21ienNxcjBnNjdLRTdZcTg3SjJBSUZ2cmk2dnF1TEJkRFFycmk2VHNuYlRzbHJ6cm9aenF0N2dnN0ptODdLcTlJT3V5aE8yS3ZPeWRnQ0FxS3V1THErcTRzQ29xNjZHY0lPdXN1T3Exck91bHZDRHRoclhzbmJ6dGxiVHNtcFF1SUNvcTdMZW83SWFNS2lycmlwUWc3SUtzN0pxcDdKNlE2ckNBSU8yVm1PcXpvQ0Rzbm9qcmlwUWc3SjZSN0plRjdKMjBJT3kzcU95R2pPdVFuT3VMcE9xem9DRHNtS1R0bGJUdGxhQWc3SWlZSU95ZWlPeVd0Q0RzazdEc3A0QWc3SldLN0pXRTdKcVVMZzBLT2pvNkRRb05DaU1qSXlEdG1KenRnNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzbllRZzY1V01EUW9OQ3V5WWlDa05DaTBnNjZxbzdKNkU3S2VBN0p1UTZyaUlJT3lYaHV5ZHRDRHJxcWpzbm9UdGhyWHNucVhzbllRZzY2ZU02NU9rNnJtTTdKcVVQeURzcDREcXVJZ2c2N0NiN0tlQUlPeVZpdXljDQp2T3VwdENEcnFxanNub1RzcDREc201RHF1SWpzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVJT0tHa2lEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEtJeU1qSU8yWW5PMkRuU0RyaklEc2c0RWc3SldJNjRLMERRb05DaW9xN0lTYzY3bUU3SXFrNjRxVUlPeVR1Q0RzaUpnZzdKNkk3S2VBNjZlTUxDRHRpcm5zb0pVZzdaaWM3WU9kN0oyQUlPdXdtK3lkaENEc2lKZ2c3SmVHN0oyRUlPdVZqQ0RpaHBJZzZyaU43S0NWN1ppVklPdXN1T3llcGV5Y3ZPdWhuQ0RzamFqc21wUXVLaW9OQ3V5Q3JPeWFxZXlla091S2xDRHJyTGpxdGF6cnBid2c2cnk4NnJ5ODdaNklJT3lkdmV5bmdDRHNsWXJxczZBZzdadVI3SmEwNjdPMDZyaXdLT3lLcE95NmxDa2c2NVdNNjZ5NDdKZVFMQ0RydG9Ec29KWHRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWduTzJTaUNEc29JVHNzclRycGJ3ZzdKTzRJT3lJbUNEcw0KbDRicmk2VHFzNkFnN0ppazdaVzA3WldZNnJpd0lPeUpyT3liak95YWxDNE5DZzBLN0ppSUtRMEtMU0RxczRUc29vd2c2ckNjN0lTa0lPMlluTzJEbmV5ZGdDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnNG9hU0lEUXVOU1VnNnJpSTY2YXNJTzJZbk8yRG5ldW5qQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEtLaW9xRFFvTkNpTWpJRFF1SU95NmtPeWp2T3lXdk8yVm5DRHFzcjNzbHJRTkNnMEs3S0NjN1pLSUlPeVZpT3lYa095RW5DQW5mdXlMbk9xeW9PeVd0T3lhbEQ4bkxDQW43SXVjNjRLWTdKcVVQeWNzSUNkKzZydVlKeURxc0puc25ZQWc2ck84NjQrRTdaV2NJT3F5dmV5V3RPdWx2Q0RzazdEc3A0QWc3SldLN0pXRTdKcVVMZzBLN0xXYzY0eUE3WldjSU95NmtPeWp2T3lXdk8yVm1PcXpvQ0RzdVp6cXQ3enRsWndnNjZlUTdZaXM2Nlc4SU95VHNPdUtsQ0Rxc293ZzdLS0w3SldFN0pxVUxnMEs2cks5N0phMDY0cVVJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUSXQNCjZySzk3SmEwNjZXOExleU5xT3VQaEMzcmtKanJpcFF0NnJLOTdKcXdLZXlYa0NEdGxiVHJpN250bGFBZzY1V002NmVNSU95TnFPeWFsQzROQ2cwS0l5TWpJT3VQbWV5Q3JPeVhrT3lFbkNBbmZ1eUxuQ2NnNjdtODZyaXdEUW9OQ3V5WWlDa05DaTBnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWbU95TG5PcXlvT3lXdE95YWxEOGc0b2FTSU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bGFEcXVZenNtcFEvRFFvdElPeUxuT3lla2UyVm1PeUxuT3VLbENEcnRvVHNsNURxc293Z05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMaURpaHBJZzdJdWM3SjZSN1pXWTY2bTBJRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0TkNnMEtJeU1qSUNmcXM0VHNpNXpyaTZRbklPS0draUFuN0o2STY0dWtKdzBLRFFyc21JZ3BEUW90SU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc3SjZRNjQrWjdMQ282ckNBSU95ZWlPdUNtT3lhbEQ4TkNpMGc2NmVrNjR1c0lPdXp0TzJYDQptT3VqakNEc2xyenJwNGpzbEtrZzY0SzA2ck9nSU9xemhPeUxuT3VDbU95YWxEOGc0b2FTSU91bnBPdUxyQ0RyczdUdGw1anJvNHpyaXBRZzdKYTg2NmVJN0oyNDZyQ0E3SnFVUHlBcUtPdUxxT3lJbkNEc3VaanRtWmpzbmJRZzdKV0U2NHVJNjUyOElPdXN1T3llcGV5ZGhDRHNnNGpyb1p3ZzdKTzBJT3lDck91aGdPeVlpT3lhbENrcURRb05DaU1qSXlBbjdKZXM3SzJJNjR1a0p5RGlocElnSisyWmxleWR1TzJWbU91THBDd2c2Nnk3NjR1a0p3MEtEUXJzbUlncERRb3RJT3lWaU95Z2hPMlZuQ0Rxc0p6dGhyWHNuWVFnN0p5RTdaVzBJT3VxaCtxd2dPeW5nQ0RyaTZUc2k1d2c3SmVzN0syazY3Tzg2cktNN0pxVUxpRGlocElnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSDZyQ0E3S2VBSU91THBPeUxuQ0R0bVpYc25ianRsYURxc296c21wUXVEUW9OQ2lNakl5QW42cnVZSnlEaWhwSWdKK3lYa09xeWpDY05DZzBLN0ppSUtRMEtMU0R0bVkzcXVManJqNW5yaTVqcXU1Z2c2NEtnN0pXRQ0KNnJDQTZyT2dJT3llaU95V3RPeWFsQzRnNG9hU0lPMlpqZXE0dU91UG1ldUxtT3lYa09xeWpDRHJncURzbFlUcXNJRHFzNkFnN0o2STdKYTA3SnFVTGcwS0RRb2pJeU1nNnJLOTdKYTA2Nlc4SU91NmtPeWRoQ0RybFl3ZzdKYTA3SU9KN1pXY0lPcXl2ZXlhc0EwS0RRcnNncXpzbXFuc25wRHNuWmdnN0tDVjY3TzA2Nlc4SU91d20rdUtsQ0RzcDRqcnJManNsNURzaEp3ZzZyaXc2ck9FN0tDQjdKeTg2NkdjSUNkKzdJdWNKK3VsdkNEcnVwRHNuWVFnNjVXTUlPdXN1T3llcGV5ZHRDRHNsclRzZzRudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNpb3E3WXlNN0pXRjdaV1k2ck9nSU95THR1eWRnQ0Rzb0pYcnM3VHJwYndnSit5anZPeVd0Q2Zyb1p3ZzdJMm83SVNjSU91c3VPeWVwZXlkaENEc2c0anJvYTNxc293ZzdJMm82N08wN0lTNDdKcVVMaW9xRFFvTkN1eVlpQ2tOQ2kwZzdKYTA2NWFrSU91cXFleWdnZXljdk91aG5DRHJqSURzdHB6cnNKdnNuTHpzaTV6cmdwanNtcFEvSU9LR2tpRHJqSURzdHB3ZzY2cXANCjdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhOQ2kwZzdKYTA2NWFrSU95ZHRPeWNvT3VobkNEc2k2RHFzNkR0bFpqc2k1enJncGpzbXBRL0lPS0draURzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1RFFvTkNpb3FLZzBLRFFvakl5QTFMaUFuZSt1cWhleUNySDBnS3lCNzY2cUY3SUtzZlNjZzdKT3c3S2VBSU95Vml1cTRzQTBLRFFvakl5TWc3WldjN0o2UTdKYTBJTzJTZ095V3RPeVRzT3E0c0EwS0RRcnRsWnpzbnBEc2xyUWc2NnFGN0lLczY2VzhJTzJTZ095V3RPeUVuQ0RyajVuc2dxd2c3WmlWN1lPYzY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUlPS0draURzbmJUc25wRHJwYndnNjQrTTY2Q2s2N0NiN0pXWTdKYTA3SnFVRFFvdElPdUN0T3lkdkNEc3ViVHJrNXpxc0pMc25iUWc2ckt3N0tDYzY1Q2dJT3lZaU95Z2xleWR0T3lYa095YWxDRGlocElnDQo2NEswN0oyODdKMkFJT3k1dE91VG5PcXdraURyZ3BqcXNJRHJpcFFnNjRLZzdKMjA3SmVRN0pxVURRb05DaU1qSXlEdGxaenNucERzbHJUcnBid2c3WktBN0phMDdKT3c2cml3SU95V3RPdWdwT3lhdUNEcXNyM3NtckFOQ2cwS0ozdnJxb1hzZ3F4OTZyQ0FJSHZycW9Yc2dxeDk3WlcwN0lTY0p5RHRtSlh0ZzV6cm9aenJwNHdnN1pLQTdKYTA3S1NZNjQrRUlPdU5sQ0RzdXBEc283enNscnp0bFpqcXNvd2c3Sk80SU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0o2VTdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVSU9LR2tpRHNucFRzbGFIc25iUWc2N2FBN0tHeDdaVzA3SVNjSU9xMXJPdW5wTzJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFFOQ2cwS0tpb3FEUW9OQ2lNaklEWXVJTzJSbk9xNHNDRHRoclhzbmJ3TkNnMEtJeU1qSU91UW1PeVd0T3lhbENBb1dDa2c0b2FTSU91UHZPeWFsQ0FvVHlrTkNnMEs2NnFvNjdDVTdKMjhJTzJabE91cA0KdE95ZG1DRHNvb0hzbllBZzZyTzE2ckNFN0oyRUlPcXpvT3VncE8yVnRDQW42NUNZN0phMDdKcVVKK3VLbENEcnFxanJrWkFnSit1UHZPeWFsQ2Zyb1p3ZzdZYTE3SjI4N1pXMDdJU2NJT3lOcU95anZPeUV1T3lhbEM0TkNnMEtLaW9xRFFvTkNpTWpJRGN1SU91Q29PeW5uTUszN0l1YzZyQ0V3cmZzaUt2c25wQWc3WkdjNnJpd0RRb05DdXVDb095bm5NSzM3SXVjNnJDRXdyZnJzb2p0bUxqcmlwUWc3SldFNjU2WUlPMllsZXlMbmV5Y3ZPdWhuQ0R0aHJYc25ienRsYlRzaEp3ZzdJMm83SnFVTGcwS0RRb2pJeU1nNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3E0c09xd2hBMEtEUXA4SU8yVnJldXFxU0I4SU8yWWxleUxuU0I4SU95WWlPeUxuQ0I4RFFwOExTMHRMUzB0ZkMwdExTMHRMWHd0TFMwdExTMThEUXA4SU91Q29PeW5uQ0I4SU9xNHNPdXp1Q0JnV1ZsWldTNU5UUzVFUkdBZ0x5RHNwNmZxc293Z1lFMU5Ma1JFWUNCOElESXdNalV1TURFdU1ERXNJREkxTGpBeExqQXhJSHdOQ253ZzdJdWM2ckNFSUh3ZzZyaXcNCjY3TzRJR0JJU0RwTlRUcFRVMkFnTHlEc3A2ZnFzb3dnWUVoSU9rMU5ZQ0FvN0ppazdLQ0VMK3lZcE8yYmhDRHNsWWdnN0pTQUtTQjhJREUwT2pNd09qRXhMQ0F4TXpvek1DQjhEUXA4SU9xNHNPcXdoQ0I4SU9xNHNPdXp1Q0JnV1ZsWldTNU5UUzVFUkg1WldWbFpMazFOTGtSRVlDQXZJT3lucCtxeWpDQmdXVmxaV1M1TlRTNUVSSDVOVFM1RVJHQWdmQ0F5TURJMUxqQXhMakF4ZmpJd01qVXVNREV1TXpFc0lESXdNalV1TURFdU1ERitNREV1TXpFZ2ZBMEtmQ0RyZ3FEc3A1d2dLeURzaTV6cXNJUWdmQ0JnV1ZsWldTNU5UUzVFUkNCSVNEcE5UV0FnZkNBeU1ESTFMakF4TGpBeElERTBPak13SUh3TkNud2c3SnFVN0oyOElId2dZRmxaV1ZrdVRVMHVSRVFvN0pxVTdKMjhLV0FnNG9DVUlPeWJsQy90bVpRdjdJaVlMK3VxcVMvcXVJZ3Y3WWFnTCt5ZHZDQjhJREl3TWpVdU1ERXVNREVvN0lpWUtTQjhEUW9OQ2lvcTdJdWM2ckNFSU95WWlPeVp1Q29xT2lEc2dxenNtcW5zbnBEcXNJQWc3S2VCN0tDUklPcXpvT3VsDQp0T3VLbENEcnNLbnJyTGpDdCt5WWlPeVZ2U0RzaTV6cXNJVHNuWUFnWU95WXBPeWdoQy9zbUtUdG00UWdTRHBOVFdEc25ZUWc3STJvNjQrRUlPdVB2T3lhbEM0TkN1eVlpQ2tnN0ppazdadUVJREU2TURBTkNnMEtJeU1qSU91c3VPeWVwU0RzaG8wZzdKZXc3SnVVN0oyOERRb05DdXVzdU95ZXBTRHNsWWpzbDVEc2hKenJpcFFnS2lyc201VEN0K3lkdkNEc2xaN3NuWmdnTU95ZGhDRHJ1YnpxczZBcUtpRHNqYWpzbXBRdURRb05DdXlZaUNrTkNpMGdNakF5TnV1RmhDQXdPT3libENBd05leWR2Q0Rzbm9Ycmk0anJpNlF1SU9LR2tpQXlNREkyNjRXRUlEanNtNVFnTmV5ZHZDRHNub1hyaTRqcmk2UXVEUW9OQ2lNakl5RHNnNEhyaklBZzdJdWM2ckNFSUNqcmhianN0cHpzbXFrcERRb05DbndnN0tHdzZyRzBJSHdnN1pHYzZyaXdJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQTBLZkNBMk1PeTBpQ0RycjdqcnA0d2dmQ0Ryc0tucXVJZ2c3S0NFSUh3TkNud2dOakRydG9RZzY2KzQ2NmVNSUh3Z1R1dTJoQ0Rzb0lRZw0KZkEwS2ZDQXlOT3lMbk9xd2hDRHJyN2pycDR3Z2ZDQk83SXVjNnJDRUlPeWdoQ0I4RFFwOElETXc3SjI4SU91dnVPdW5qQ0I4SUU3c25id2c3S0NFSUh3TkNud2dNVExxc0p6c201UWc2Nis0NjZlTUlId2dUdXF3bk95YmxDRHNvSVFnZkEwS2ZDQXhNdXF3bk95YmxDRHNuYlRzZzRFZ2ZDQk82NFdFSU95Z2hDQjhEUW9OQ3V5WWlDa2c2N0NwNnJpSUlPeWdoQ3dnTmV1MmhDRHNvSVFzSURMc2k1enFzSVFnN0tDRUxDQXo3SjI4SU95Z2hDd2dOdXF3bk95YmxDRHNvSVFzSURMcmhZUWc3S0NFRFFvTkNpTWpJeURycDRqcXNKREN0K3E0c09xd2hDRHJwNHpybzR3TkNnMEtZRVF0VG1Bb1R1eWR2Q0RyZ3Fqc25Zd3BJQzhnWUVRdE1HQW83SmlrNjRxWUlPdW5pT3F3a0NrZ0x5QmdSQ3RPWUNoTzdKMjhJT3F5dmVxenZDa05DdXlZaUNrZ1JDMDNMQ0JFTFRFc0lFUXRNQ3dnUkNzeERRb05DaU1qSXlEcnNvanRtTGdnN1pHYzZyaXdJQ2p0bFpqc25iVHRsSWpzbkx6cm9ad2c2cldzNjdhRUtRMEtEUXA4SU8yVnJldXENCnFTQjhJTzJZbGV5TG5TQjhJT3lZaU95TG5DQjhEUXA4TFMwdExTMHRmQzB0TFMwdExYd3RMUzB0TFMxOERRcDhJT3lnaE8yWmxPdXlpTzJZdUNCOElPMlZtT3lkdE8yVWlDRHF0YXpydG9RZ2ZDQXdNaTB4TWpNMExUVTJOemdzSURBeE1DMHhNak0wTFRVMk56Z2dmQTBLZkNEc3ViVHJrNXpyc29qdG1MZ2dmQ0EwN0o2UTY2YXM3SlNwSU8yVm1PeWR0TzJVaUNCOElERXlNelF0TlRZM09DMDVNREV5TFRNME5UWWdmQTBLZkNEcXM0VHNvb3pyc29qdG1MZ2dmQ0R0bFpqc25iVHRsSWdnNnJXczY3YUVJSHdnTVRJekxUUTFOaTAzT0Rrd01USWdmQTBLZkNEc283enJyN3pyazdIcm9aM3Jzb2p0bUxnZ2ZDRHNsWjRnTnV5ZWtPdW1yQzNya3FRZ04reWVrT3VtckNCOElERXlNelExTmkweE1qTTBOVFkzSUh3TkNud2c3SUtzN0plRjdKNlE2NU94NjZHZDY3S0k3Wmk0SUh3Z01URHNucERycHF3ZzdaV1k3SjIwN1pTSUlId2dNREV0TWpNMExUVTJOemc1SUh3TkNnMEtJeU1qSU95VHNPdXB0Q0RzbFlnZzY1Q1k2NHFVDQpJTzJSbk9xNHNBMEtEUW90SU91Q29PeW5uT3lYa0NEdGxaanNuYlR0bElqQ3QrdTVsK3E0aURvZzRwMk1JREl3TWpVdE1ERXRNREVzSURBeEx6QXhEUW90SU95TG5PcXdoT3lYa0NEc21LVHNvSVF2N0ppazdadUVPaURpbll3ZzdKaWs3S0NFSURIc2k1d2dLaWpyaTZnc0lPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDRHNtSWpzbWJncEtnMEtEUW9xS2lvTkNnMEtJeURzbUlqc21iZ2c2cmVjN0xtWkRRb05DdXlia095NW1TanJpcVhyajVuQ3QrcTRqZXlnbGNLMzdMcVE3S084N0phOEtldXp0T3VMcENEc21JanNtYmpxc0lBZzY0MlVJT3VxaGUyWmxlMlZuQ0RzdTZUcnJxVHJpNGpzdklEc25iVHNoWmpzbllRZzY2ZU02NU9jNjRxVUlPcXl2ZXlhc095WWlPeWFsQzROQ2cwS0l5TWc3SmlJN0ptNElERXVJT3lJbU91UG1lMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBTkNnMEtJeU1qSU95RQ0Kbk91NWhPeUtwQ0Rzb29Ycm80d3NJT3E0c09xd2hDRHJwNHpybzR3TkNnMEs3SWlZNjQrWjdaaVY3Snk4NjZHY0lPeVRzT3VwdENEc283enNsclFvN0tLRjY2T01JT3lFbk91NWhPeUtwQ3dnNnJpdzZyQ0VJT3VUc1NucnBid2c2ckNWN0tHdzdaV2dJT3lJbUNEc25vanFzNkFzSUNmc29vWHJvNHduN0ptQUlDZnJwNHpybzR3bjdKMllJT3VKbU95Vm1leUtwT3VsdkNEc29KWHRtWlh0bm9nZzdLQ0U2NHVzN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZ1QwOVBJT3lFbk91NWhPeUtwQ0Rzb29Ycm80d2c3SldJNjRLMElPS0FsQ0F3TU95YmxDQXdNT3lkdk91MmdPMkVzQ0RzaEp6cnVZVHNpcVRxc0lBZzdLS0Y2Nk9NNjQrODdKcVVMaURzbnBEc2hManRsWndnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3VUbk91Z3BPeWFsQzROQ2kwZzdKNlE3SUt3SU95aHNPMmFqQ0RxdUxEcXNJVHNuYlFnNnJPbklPdW5qT3Vqak91UHZPeWFsQzROQ2cwSzY0dW9MQ0FxS3V5anZPcTRzT3lnZ2V5Y3ZPdWgNCm5DRHNvb1hybzR6cXNJQWc2N0NZNjdPMTY1Q1k2NHFVSU95Z25PMlNpQ29xN0plUTY0cVVJQ2Zzb29Ycm80enJqN3pzbXBRbjY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0ppazY0cVk3SjJZSU8yQXRPeW1pT3F3Z0NEcXM2Y2c3S0tGNjZPTTY0Kzg3SnFVSU9LR2tpRHNtS1RyaXBqc25aZ2c3WUMwN0thSTZyQ0FJT3F6cHlEcmdaM3JncGpzbXBRTkNnMEtJeU1qSU95Q3JPeWFxZXlla095WGtPcXlqQ0Rycjdqc3VaanJpcFFnN0ppQjdaYWw3SjJFSU95VmpPdWdwT3lraENEcmxZd05DZzBLS095anZPeWFsQ0RyajVuc2dxd2dPaURzbDdEc3NyUXNJTzJWdE95bmdDd2c3S0NCN0pxcElPdVRzU2tOQ2cwSzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VHNPdXB0Q0RzbmJqcXM3d2c2clNBNnJPRTY2VzhJT3VxaGUyWmxlMlZtT3F5akNEc2hLVHJxb1h0bFpqcXM2QXNJQ2ZzZ3F6c21xbnNucERzblpnZzdaYUo2NCtaN0plUUlPdVVzT3Vkdk95WXBPdUtsQ0Rxc3JEcXM3d242NTI4DQo2NHFVSU95Z2tPeWRoQ0RzbFl6cm9LVHNwSVFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbUtUcmlwanF1WXpzcDRBZzY0SzA3S2VBSU95Vml1eWN2T3VwdENEc2w3RHNzclRyajd6c21wUXVJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZzBLTFNEcmpJRHN0cHpzbllRZzZyQ0k3SldFN1lPQTY2bTBJT3lia091ZW1DRHJqSURzdHB6c25iUWc3WlcwN0tlQTY0Kzg3SnFVTGlEc21LVHJpcGdnNjRLZzdLZWM2cm1NN0tlQTdKMllJT3lkdE95ZWtPdWx2Q0RzbllEdGxvbnNsNUFnNjRLMDdKVzhJTzJWdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPeUltT3VQbWUyWWxTa05DZzBLSit5Z2xldXp0Q0RzaUpqc3A1RWc3SldJNjRLMEp5RHJrN0hzblpnZzY2Kzg2ckNRN1pXY0lPeURnZTJacWV5WGtPeUVuQ0FxS3V5TG5PeUtwTzJGbk95ZHRDRHNucERyajVuc25MenJvWndnN0xLWTY2YXM3WldjNjR1azY0cVVJT3lna0NvcQ0KN0oyRUlPeUltT3VQbWUyWWxleWN2T3VobkNEc2xZenJvS1FnN0lLczdKcXA3SjZRNjZXOElPeVZpT3lMck8yVm1PcXlqQ0R0bGFBZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25iVHNvSnpydG9EdGhMQWc3Wm1ONnJpNDY0K1o2NHVZN0oyWUlPcXduT3lkdU95Z2xldXp0Q0RzbmJUc21xa2c2NEswN0pldDdKMjBJT3E0c091aG5ldVB2T3lhbEEwS0xTRHJqWlFnN0tLTDdKMkFJT3lEZ2V1THRPeWRoQ0RzbklUdGxiUWc3WWExN1ptVUlPdUN0T3lhcWV5ZGdDRHJoYm5zbll6cmo3enNtcFFOQ2cwS0l5TWc3SmlJN0ptNElESXVJT3F5dmV5V3RPdWx2Q0RzamFqcmo0UWc2NUNZNjRxVUlPcXl2ZXlhc0EwS0RRcnRpcm5zb0pVZzdJT0I3Wm1wN0plUTdJU2NJT3lnbk8yVm5PeWdnZXljdk91aG5DQW43SXVjNjRLWTdKcVVQeXdnN0lXbzY0S1k3SnFVUHljZzdKMlk2Nnk0N1ppVklPeVd0T3V2dU91bHZDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtPeWQNCm1DRHJwNlhybmIzc25ZUWc3Wm1jN0pxcDdaVzA3SVNjSU95bmlPdXN1TzJWb0NEcmxZd05DZzBLSit5TG5PdUNtT3lhbEQ4bkxDQW43SVdvNjRLWTdKcVVQeWNnN1ppVjdZT2M3SjJZSU9xeXZleVd0T3VsdkNEdG1aenNtcW50bGJUc2hKd2c3SUtzN0pxcDdKNlE3SjJZSU91THVlMlpxZXlLcE91ZnJPeWJnT3lkaENEc3BJVHNuYndnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0R0bVkzcXVManJqNW5yaTVnc0lFOVBUeURyaTZUcmhZRHNtS1RzaGFqcmdwanNtcFEvRFFvdElPeTJxZXlnaE8yVm1PdWZyQ0R0anJqc25aanNvSkFnNnJDQTdJdWM2NEtZN0pxVVB3MEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKMllJT3lEZ2UyWnFleWRoQ0RzdHBUc29KWHRsYUFnNjVXTURRb05DdXVxaGUyWmxlMlZuQ0Rzb0pYcnM3VHFzSUFnN0plRzdKYTA3SVNjSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzcDRIc29KRWc3WXlRNjR1bzdaV1k2cktNSU8yVnRPeVZ2Q0R0bGFBZzY1V01JT3F5dmV5V3RPdWhuQ0RzDQpvSlhzcEpIdGxaanFzb3dnN0tlSTY2eTQ3WldnSU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0xtMDY1T2M2Nlc4SU91d20reWN2T3lGcU91Q21PeWFsRDhnNjVPeDY2R2Q3WldZNjZtMElPeTZrT3lMbk91d3NTRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkNpTWpJeURzZ3F6c21xbnNucERzblpnZzdJU2c3SjJZNnJDQUlPMlZoT3lhbE8yVm9DRHJsWXdOQ2cwSzdJU2s2Nnk0N0tHdzdJS3M3TEtZNjUrOElPeUNyT3lhcWV5ZWtPeWRtQ0RzaEtEc25aanJwYndnNnJpdzY0eUE3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYlRzbXBRdURRb05DdXlZaUNrTkNpMGc3SjIwNjdLSUlPdUxyT3lYa0NEc2hKenJ1WVRzaXFUcnBid2c3SjIwN0pxcDdaV1k2Nm0wN0lTY0lPeVd2T3VuaU91Q21DRHJwNHpzb2JIdGxaanNoYWpyZ3Bqc21wUS9EUW9OQ2lNaklPeVlpT3ladUNBekxpRHJ0b0Rzb0pYdA0KbUpVZzY2eTQ3SjZsN0oyRUlPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdEUW9OQ3V5Q3JPeWFxZXlla095WGtPcXlqQ0RycW9YdG1aWHRsWmpxc293ZzY3YUE3S0NWN0tDQjdKMjRJT3VDdE95YXFleWRoQ0RzbFl6cm9LVHNwSmpzbGJ3ZzdaV2dJT3VWak91S2xDRHJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkVJT3lOcU91UGhDRHNvb3ZzbFlUc21wUXVEUW9OQ2lNakl5RHNoSnpydVlUc2lxVHJwYndnN0tDVjdMR0Y3SU9CSU95VHVDRHNpSmdnN0plRzdKMkVJT3VWakEwS0RRcnJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzdJMm83Slc4SU95Q3JPeWFxZXlla095WGtPcXlqQ0RzZzRIdG1hbnNuWVFnNjZxRjdabVY3WldZNnJLTUlPeWR1T3luZ095TG5PMkNyQ0RzaUpnZzdKNkk3SmEwN0pxVUxpQXFLdXlUdUNEc2lKZ2c3SmVHNjRxVUlPeWR0T3ljb091bHZDRHRsYWpxdTVnZzdKV0k2NEswN1pXMDdLTzg3SVM0N0pxVUxpb3FEUW9OQ3V5WWlDa05DaTBnN0tlQTZyaUk3SjJBSU9xd2dPeWVoZTJWb0NEc2lKZ2cNCjdKZUc3SmEwN0pxVUxpRHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhbEM0TkNpMGc2ck8xNjZ5MDdKdVE3SjJBSU8yYmhPeWJrT3E0aU95ZGhDRHJzN1RyZ3J3ZzdJaVlJT3lYaHV5V3RPeWFsQzROQ2cwS0l5TWpJT3lkdk91MmdDRHF1TERyaXFYcnA0d2c3Sk80SU95SW1DRHNsNGJzbllRZzY1V01EUW9OQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE2ckNBSU95V3RPdVdwQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0RzbDRicmlwVHNwNEFnNjZxRjdabVY3WldZNnJLTUlPeWR1T3luZ08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeWdrT3F5Z0NEcXVMRHFzSVFnNjQrWjdKV0lJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzROQ2kwZzdJdWc2N2FFN0thZElPMlpsZXlkdU91UW1PcTRzQ0Rzb0lUcXVZenNwNEFnDQo3SWFoNnJpSTZyTzhJT3F5c095Z25PdWx2Q0R0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzROQ2cwS0l5TWpJT3lDck95YXFleWVrQ0RzaEtEdGc1M3NuWmdnNnJLdzZyTzg2Nlc4SU95VmlPdUN0TzJWb0NEcmxZd05DZzBLNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzdJU2c3WU9kN0oyQUlPdTJnT3lnbGUyWWxleWN2T3VobkNEcnFvWHRtWlh0bFpqcXNvd2c3SldNNjZDazdKcVVMZzBLRFFyc21JZ3BEUW90SU8yVm5DRHJzb2dnNjdDVTZyNjQ2Nm0wSU95NmtPeUxuT3V3c2V5ZGdDRHJpNlRzaTV3ZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVEUW9OQ2lNakl5RHNncXpzbXFuc25wQWc3SldJN0l1c0lDanJ0b0Rzb0pYdG1KVXBEUW9OQ2lmc29KWHJzN1FnN0lpWTdLZVJJT3lWaU91Q3RDY2c2NU94N0oyWUlPdXZ2T3F3a08yVm5DRHNnNEh0bWFuc2w1RHNoSndnS2lyc29KWHJzN1Rxc0lBZzY3TzA3Wmk0NjVDYzY0dWs2NHFVSU95Z2tDb3E3SjJFSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzbFl6cg0Kb0tRZzdJS3M3SnFwN0o2UTY2VzhJT3lWaU95THJPMlZtT3F5akNEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNnNEhyaTdUc25iUWc2NEdkNjRLWTY2bTBJT3lnaE91c3VPcXdnT3VQaENEdG1ZM3F1TGpyajVucmk1anNuWmdnN0tDVjY3TzA2Nlc4SU91enZDRHNpSmdnN0plRzdKYTA3SnFVTGcwS0xTRHRtWTNxdUxqcmo1bnJpNWpzblpnZzdLQ1Y2N08wNnJDQUlPcTRzT3VobmV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1RFFvTkNpTWpJT3lZaU95WnVDQTBMaURzb0p6dGtvZ2c3SnFwN0phMDY0cVVJT3V3bE9xK3VPeW5nQ0RzbFlycXVMQU5DZzBLSitxd2hPcXlzTzJWbU9xem9DRHNpYXpzbXJRZzY2ZVFKeURzbTVEc3VabnJzN1RyaTZRZ0tpcnRtWlRycWJUc25aZ2c2cml3NjRxbDY2cUZ3cmZyc29UdGlyenJxb1hxczd6c25aZ2c3SnFwN0phMElPeWR2T3k1bUNvcTZyQ0FJT3lhc095RW9PeWR0T3lYa095YWxDNE5DdXE0c091S3BldXFoZXlYa0NEc2s3RHNuYmdnNjR1bzdKYTANCktPdXpnT3F5dlN3ZzdLZUE3S0NWTENEcms3SHJvWjBnNjVPeEtldWx2Q0RzbFlqcmdyUWc2Nnk0NnJXczdKZVE3SVNjSU91THBPdWx1Q0RycDVEcm9ad2c2N0NVNnI2NDY2bTBJT3lDck95YXFleWVrT3F3Z0NEcmk2VHJwYmdnNnJpdzY0cWw3Snk4NjZHY0lPeVlwTzJWdE8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwSUNmcXRvenRsWndnNjdPQTZySzlKeURxdUxEcmlxWHNuWmdnN0pXSTY0SzBJT3VzdU9xMXJBMEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V3bE9xL2dDRHNpSmdnN0o2STdKYTA3SnFVSUNoWUtRMEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUlDaFBLUTBLRFFvakl5RHNtSWpzbWJnZ05TNGc3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyDQppNlRycGJnZzY0K1o3SUtzSU95VHNPeW5nQ0RzbFlycXVMQU5DZzBLNjZ5NDZyV3M2Nlc4SU95VmhPdXN0T3VtckNEcnA2VHJnWVRybjczcXNvd2c2NHVrNjVPczdKYTA2NCtFSUNvcTdJdWs3S0NjSU95TG5PeUtwTzJGbkNEcmo1bnNucEhxczd3ZzY0dWs2Nlc0SU91UG1leUNyQ29xNjZXOElPeVRzT3VwdENEc25wanJxcnZya0p3ZzY2eTQ2cldzN0ppSTdKcVVMZzBLRFFyc21JZ3BJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERycGJ3Z0oreTJsT3F3Z0NEc3A0RHNvSlVuN1pXWTY0cVVJT3lMbk95S3BPMkZuT3lYa095RW5DQW83SjIwN0tDRXdyZnNscEhyajRRZzZyaXc2NHFsN0oyMElPeVZoT3VMbUNrTkNpMGc2NHVrNjZXNElPeUNyT3Vlak95WGtPcXlqQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZXOElPdUVtT3F5cU95anZPeUV1T3lhbENBb1dDRGlnSlFnN0plRzY0cVVJQ2ZyaEpqcXVMRHF1TEFuSU9xNHNPdUtwZXlkaENEc2xaVHNpNXdwRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZw0KNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxiUWc3S084N0lTNDdKcVVJQ2hQS1EwSw0KOjpMQVVOQ0hFUjo6DQovLzRuQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJDQUhJQWFRQmtBR2NBWlFBZ0FHd0FZUUIxQUc0QVl3Qm9BR1VBY2dBZ0FCUWdJQURvc3NTc3hMd2dBQ1RCRmNnZ0FCRElnS3dnQU1UV0lBRGtzcXk1SUFEa3dvblZDZ0FuQUNBQVl3QnNBR0VBZFFCa0FHVUFZZ0J5QUdrQVpBQm5BR1VBT2dBdkFDOEFJQUFFMVZ5NG9ORmN6M1RISUFCMHh5QUFETk44eDBUSElBQ0F2WGk1NUxJZ0FDZ0E4YlJkdURvQUlBQjAwRnk0M0xUa3NxeTVMUURReG5UUXJibnd4YkNzTGdCMkFHSUFjd0FwQUM0QUNnQW5BQ0FBVkxzQXJDQUFZTDQ0eUNBQWlNYzh4M1M2SUFCYzFTQUFpTHpReFNBQVdOV1lzQ25GSUFCSXhiU3dXTlhnckN3QUlBRGtzaUFBQU1sRXZoaTBkTG9nQU9TeXJMbDh1U0FBUGN3Z0FNYkZkTWNnQU9UQ2lkVmMxZVN5TGdBS0FGTUFaUUIwQUNBQVpnQnpBRzhBSUFBOUFDQUFRd0J5QUdVQVlRQjBBR1VBVHdCaUFHb0FaUUJqQUhRQUtBQWlBRk1BWXdCeUFHa0FjQUIwQUdrQWJnQm5BQzRBUmdCcEFHd0FaUUJUQUhrQQ0KY3dCMEFHVUFiUUJQQUdJQWFnQmxBR01BZEFBaUFDa0FDZ0JUQUdVQWRBQWdBSE1BYUFBZ0FEMEFJQUJEQUhJQVpRQmhBSFFBWlFCUEFHSUFhZ0JsQUdNQWRBQW9BQ0lBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRk1BYUFCbEFHd0FiQUFpQUNrQUNnQmtBR2tBY2dBZ0FEMEFJQUJtQUhNQWJ3QXVBRWNBWlFCMEFGQUFZUUJ5QUdVQWJnQjBBRVlBYndCc0FHUUFaUUJ5QUU0QVlRQnRBR1VBS0FCWEFGTUFZd0J5QUdrQWNBQjBBQzRBVXdCakFISUFhUUJ3QUhRQVJnQjFBR3dBYkFCT0FHRUFiUUJsQUNrQUNnQnpBR2dBTGdCREFIVUFjZ0J5QUdVQWJnQjBBRVFBYVFCeUFHVUFZd0IwQUc4QWNnQjVBQ0FBUFFBZ0FHUUFhUUJ5QUFvQUNnQW5BQ0FBTVFBdkFESUFLUUFnQUU0QWJ3QmtBR1VBTGdCcUFITUFJQUFReUlDc0lBQVVJQ0FBeHNVOHgzUzZJQURrc3JUR1hMamN0Q0FBbU5OMHg4REpmTGtnQVBURnRNVUF5ZVN5Q2dCSkFHWUFJQUJ6QUdnQUxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BSUFCM0FHZ0ENClpRQnlBR1VBSUFCdUFHOEFaQUJsQUNJQUxBQWdBREFBTEFBZ0FGUUFjZ0IxQUdVQUtRQWdBRHdBUGdBZ0FEQUFJQUJVQUdnQVpRQnVBQW9BSUFBZ0FFa0FaZ0FnQUUwQWN3Qm5BRUlBYndCNEFDZ0FJZ0JPQUc4QVpBQmxBQzRBYWdCekFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGk0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQmJBRlhXZU1kZEFFVEhJQUFFc25TNWRMb2dBT1N5dE1aY3VOeTBJQUNZMDNUSHdNa0FyQ0FBOU1XOXVjaXk1TEl1QUNBQUpNRll6bnk1SUFESXVWek9JQUNrdEN3QUlBQU0xZXkzK0sxNHg5REZITUVnQUhUUVhMamN0Q0FBaEx5ODBrVEhJQURrc3R6Q0lBQU1zdXkzSUFEOHlEakJsTVl1QUNJQUxBQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUIyQUdJQVR3QkxBRU1BWVFCdUFHTUFaUUJzQUNBQUt3QWdBSFlBDQpZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FERUFMd0F5QUNrQUlBQVVJQ0FBVGdCdkFHUUFaUUF1QUdvQWN3QWlBQ2tBSUFBOUFDQUFkZ0JpQUU4QVN3QWdBRlFBYUFCbEFHNEFDZ0FnQUNBQUlBQWdBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQm9BSFFBZEFCd0FITUFPZ0F2QUM4QWJnQnZBR1FBWlFCcUFITUFMZ0J2QUhJQVp3QXZBR3NBYndBdkFHUUFid0IzQUc0QWJBQnZBR0VBWkFBaUFBb0FJQUFnQUVVQWJnQmtBQ0FBU1FCbUFBb0FJQUFnQUZjQVV3QmpBSElBYVFCd0FIUUFMZ0JSQUhVQWFRQjBBQW9BUlFCdUFHUUFJQUJKQUdZQUNnQUtBQ2NBSUFBeUFDOEFNZ0FwQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0FBRU1pQXJDQUFGQ0FnQU1iRlBNZDB1aUFBSk1GWXpyY0FYTGo0clhqSElBQXB2Slc4Uk1jZ0FFakZ0TEJjMWVTeUNnQkpBR1lBSUFCekFHZ0FMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQQ0KSUFCM0FHZ0FaUUJ5QUdVQUlBQmpBR3dBWVFCMUFHUUFaUUFpQUN3QUlBQXdBQ3dBSUFCVUFISUFkUUJsQUNrQUlBQThBRDRBSUFBd0FDQUFWQUJvQUdVQWJnQUtBQ0FBSUFCTkFITUFad0JDQUc4QWVBQWdBQ0lBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGlBQUtBQVF0cFN5SUFCUUFFRUFWQUJJQU5ERklBREd4YlRGbE1ZcEFDNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdBdzBmaTdFTEhReFJ6QklBQkV4WmkzZkxrZ0FDVEJXTTYzQUZ5NCtLMTR4MXpWSUFDa3RDd0FJQUIwMEZ5NDNMUWdBSVM4dk5KRXh5QUE1TExjd2lBQURMTHN0eUFBL01nNHdaVEdPZ0FpQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQUpnQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBaUFDQUENCklBQnVBSEFBYlFBZ0FHa0FiZ0J6QUhRQVlRQnNBR3dBSUFBdEFHY0FJQUJBQUdFQWJnQjBBR2dBY2dCdkFIQUFhUUJqQUMwQVlRQnBBQzhBWXdCc0FHRUFkUUJrQUdVQUxRQmpBRzhBWkFCbEFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBSUFBZ0FHTUFiQUJoQUhVQVpBQmxBQ0FBYkFCdkFHY0FhUUJ1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFWZFo0eHlBQUtieVZ2RG9BSUFBdzBmaTdFTEhReFJ6QklBQmpBR3dBWVFCMUFHUUFaUUFnQUMwQUxRQjJBR1VBY2dCekFHa0Fid0J1QUNBQWRNY2dBSVM4Qk1oRXh5QUFuTTBsdUZqVmRMb2dBQURKUkw0Z0FFVEd6TGlGeDhpeTVMSXVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUtBQ3N3S25HDQp5YmRBeHlBQWRNY2dBRkFBUXdEUXhTQUFYTGo0clhqSEhMUWdBSFRRWExqY3RDQUFiSzNGc3lBQVhOWEVzOURGSE1FZ0FDak1FS3dwdE1peTVMSXVBQ2tBSWdBc0FDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUhZQVlnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURJQUx3QXlBQ2tBSUFBVUlDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNJQUNnQWdBQ0FBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRkVBZFFCcEFIUUFDZ0JGQUc0QVpBQWdBRWtBWmdBS0FBb0FKd0FnQUFESlJMNGdBRVRHekxnZ0FCUWdJQURrc3F5NWZMa2dBRDNNSUFER3hYVEhJQURrd29uVklBQW9BQXpWN0xmNHJYakhkTWNnQU9lc0lBQ1F4OW16SUFBUXJNREpLUUFLQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JqQUcwQVpBQWdBQzhBWXdBZ0FHNEFid0JrQUdVQUlBQnpBR01BY2dCcEFIQUFkQUJ6QUZ3QVl3QnNBR0VBZFFCa0FHVUFMUUJpQUhJQQ0KYVFCa0FHY0FaUUF1QUdvQWN3QWlBQ3dBSUFBd0FDd0FJQUJHQUdFQWJBQnpBR1VBQ2dBPQ0KOjpXQVRDSEVSOjoNCkx5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tOQ2k4dklPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQTBLTHk4ZzdKbWNJTzJWaE95YWxPMlZuT3F3Z0RvZzdaUzg2cmU0NjZlSTZyQ0FJTzJVak91ZnJPcTN1T3lkdU95ZG1DQmpiR0YxWkdWaWNtbGtaMlU2THk4ZzdKZTA2cml3S0hkcGJtUnZkeTV2Y0dWdUwybG1jbUZ0WlM5dmNHVnVSWGgwWlhKdVlXd3A2Nlc4DQpEUW92THlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293TkNpOHZJRkJQVTFRZ0wzZGhhMlVnNjZXOElPdXp0T3VDdE91cHRDRHFzSkRzaTV6c25wRHFzSUFnNjR1azY2YXNLR05zWVhWa1pTMWljbWxrWjJVdWFuTXA2Nlc4SU91TWdPeUxvQ0RzdktEcmk2UXVEUW92THcwS0x5OGc2NHVrNjZhczdKbUE3SjJZSU95d3FPeWR0RG9nNnJDUTdJdWM3SjZRNjRxVUlHTnNZWFZrWmV1bHZDRHJyTHpzcDRBZzdKV0s2NHFVNjR1a0tPeWVrT3lMblNEc2w0YnNuWXdwSU9LR2tpRHRnYlRyb1p6cms1d2c3Sld4SU95WGhldU5zT3lkdE8yS3VPdWx2Q0RzbFlnZzY2ZUo2ck9nTEEwS0x5OGc2Nm1VNjZxbzY2YXNJSDR4TlUxQzY1MjhJT3Vobk9xM3VPeWR1Q0RzaTV3ZzdKNlE2NCtaSU95TG5PeWVrZXljdk91aA0KbkNEc2c0SHNpNXdnN0x5YzY1R3M2NCtFSU91MmdPdUx0Q0RzbDRicmk2UWdLT3VUc2V1aG5Ub2dibkJ0SUhKMWJpQmlkV2xzWkNrdURRb3ZMeURyaTZUcnBxenJpcFFnN0l1czdKNmw2N0NWNjQrWklPdUJpdXE0c091cHRDRHNvNzNzcDREcnA0d283WlNNNjUrczZyZTQ3SjI0NnJPOElPeURuZXlDckNEcmo1bnF1TER0bVpRcExDRHFzSkRzaTV6c25wRHJpcFFnNnJPRTdJYU5JT3VDcU95VmhDRHJpNlRzbll3ZzZybW83SnF3NnJpdzY2VzhJT3V3bSt1S2xPdUxwQzROQ2cwS1kyOXVjM1FnYUhSMGNDQTlJSEpsY1hWcGNtVW9KMmgwZEhBbktUc05DbU52Ym5OMElIQmhkR2dnUFNCeVpYRjFhWEpsS0Nkd1lYUm9KeWs3RFFwamIyNXpkQ0JtY3lBOUlISmxjWFZwY21Vb0oyWnpKeWs3RFFwamIyNXpkQ0J2Y3lBOUlISmxjWFZwY21Vb0oyOXpKeWs3RFFwamIyNXpkQ0I3SUhOd1lYZHVMQ0J6Y0dGM2JsTjVibU1nZlNBOUlISmxjWFZwY21Vb0oyTm9hV3hrWDNCeWIyTmxjM01uS1RzTkNnMEtZMjl1YzNRZ1VFOVMNClZDQTlJREV4T0RnNU93MEtZMjl1YzNRZ1VrOVBWQ0E5SUhCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNwT3lBdkx5RHNvSURzbnFYc2hvd2c2Nk9vN1lxNElPS0FsQ0RyaTZUcnBxenFzSUFnY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xazY2VzhJT3l3dnV1S2xDRHF1TERzcElBTkNnMEtZMjl1YzNRZ1EwOVNVMTlJUlVGRVJWSlRJRDBnZXcwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VDNKcFoybHVKem9nSnlvbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFRXVjBhRzlrY3ljNklDZEhSVlFzSUZCUFUxUXNJRTlRVkVsUFRsTW5MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RTR1ZoWkdWeWN5YzZJQ2REYjI1MFpXNTBMVlI1Y0dVbkxBMEtmVHNOQ21aMWJtTjBhVzl1SUdwemIyNG9jbVZ6TENCemRHRjBkWE1zSUc5aWFpa2dldzBLSUNCeVpYTXVkM0pwZEdWSVpXRmtLSE4wWVhSMWN5d2dUMkpxWldOMExtRnpjMmxuYmloN0lDZERiMjUwDQpaVzUwTFZSNWNHVW5PaUFuWVhCd2JHbGpZWFJwYjI0dmFuTnZianNnWTJoaGNuTmxkRDExZEdZdE9DY2dmU3dnUTA5U1UxOUlSVUZFUlZKVEtTazdEUW9nSUhKbGN5NWxibVFvU2xOUFRpNXpkSEpwYm1kcFpua29iMkpxS1NrN0RRcDlEUW9OQ2k4dklHTnNZWFZrWlNCRFRFbnFzSUFnN0o2STY0cVU3S2VBSU9LQWxDRHNsNGJzbkx6cnFiUWdMM2RoYTJVZzdKMlI2NHUxN0plUUlPeUxwT3lXdENEdGxJenJuNnpxdDdqc25ianNuYlFnN0pXSTY0SzA3WldnSU95SW1DRHNub2pxc293ZzdaV2M2NHVrRFFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzROQ2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENBeg0KTU95MGlDRHN1cERzaTV3dUlPeWVyT3Vobk9xM3VPeWR1TzJWbU91cHRDQkRURW5xc0lBZzdZeU03SjI4N0oyRUlPcXdzZXlMb08yVm1PdXZnT3VobkNEc25wRHJqNWtnNjdDWTdKaUI2NUNjNjR1a0xnMEtiR1YwSUdGalkyOTFiblJEWVdOb1pTQTlJSHNnWVhRNklEQXNJR1Z0WVdsc09pQnVkV3hzSUgwN0RRcG1kVzVqZEdsdmJpQmpiR0YxWkdWQlkyTnZkVzUwS0NrZ2V3MEtJQ0JwWmlBb1JHRjBaUzV1YjNjb0tTQXRJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQThJRE13TURBd0tTQnlaWFIxY200Z1lXTmpiM1Z1ZEVOaFkyaGxMbVZ0WVdsc093MEtJQ0JzWlhRZ1pXMWhhV3dnUFNCdWRXeHNPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3cwS0lDQWdJR1Z0WVdsc0lEMGdLR29nSmlZZ2FpNXZZWFYwYUVGalkyOTENCmJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJvWnpxdDdqc25iZ2c3SjIwNjZDbElPeVhodXlkakNEcms3RWc0b0NVSUc1MWJHd2dLaThnZlEwS0lDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUJFWVhSbExtNXZkeWdwTENCbGJXRnBiQ0I5T3cwS0lDQnlaWFIxY200Z1pXMWhhV3c3RFFwOURRb05DbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzTkNpQWdZMjl1YzNRZ1ptbHVaR1Z5SUQwZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5QS9JQ2QzYUdWeVpTY2dPaUFuZDJocFkyZ25PdzBLSUNCMGNua2dleUJ5WlhSMWNtNGdjM0JoZDI1VGVXNWpLR1pwYm1SbGNpd2dXeWRqYkdGMVpHVW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhOb1pXeHNPaUIwY25WbElIMHBMbk4wWVhSMWN5QTlQVDBnTURzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnY21WMGRYSnVJR1poDQpiSE5sT3lCOURRcDlEUW9OQ214bGRDQjNZV3RwYm1jZ1BTQm1ZV3h6WlRzZ0x5OGc3SmV3N1lPQUlPdXdxZXluZ0NEaWdKUWc2NHVrNjZhczY0cVVJT3lXdE95d3FPMlV2Q0JGUVVSRVVrbE9WVk5GNjZHY0lPeWtrZXV6dFNEc29KWHJwcXp0bFpqc3A0RHJwNHdnN1pTRTY2R2M3SVM0N0lxa0lPdUNyZXU1aE91bHZDRHNwSVRzbmJqcmk2UU5DbVoxYm1OMGFXOXVJSGRoYTJWQ2NtbGtaMlVvS1NCN0RRb2dJR2xtSUNoM1lXdHBibWNwSUhKbGRIVnlianNOQ2lBZ2QyRnJhVzVuSUQwZ2RISjFaVHNOQ2lBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0lIZGhhMmx1WnlBOUlHWmhiSE5sT3lCOUxDQTFNREF3S1RzTkNpQWdiR1YwSUhCeWIyTTdEUW9nSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3RFFvZ0lDQWdMeThnVjJsdVpHOTNjem9nWTIxa3dyZDJZbk1nNnJLOTdKeWdJT3lYaHV5ZHRDQnViMlJsNjZXOElPeW5nZXlna1N3Z2QybHVaRzkzYzBocFpHVW9RMUpGUVZSRg0KWDA1UFgxZEpUa1JQVnlucm9ad2c3SXFrN1krd0lPS0FsQTBLSUNBZ0lDOHZJT3l3dlNEc2w0YnJpcFFnN0lpbzdKMkFJT3k5bU95R2xPeWR0Q0RycDR6cms2VHNsclRzcDREcXM2QWc2NHVrNjZhczdKMllJT3lla095TG5TaGpiR0YxWkdVcDY0K0VJT3EzdUNEc3ZaanNocFRzbllRZzY2eTg2NkNrNjdDYjdKV0VJT3lXdE91V3BDRHNzTDNyajRRZzdKV0lJT3Vjck91THBDNE5DaUFnSUNBdkx5QmtaWFJoWTJobFpPdUtsQ0RzazdEc3A0QWc3SldLNjRxVTY0dWtLR1JsZEdGamFHVmtLM2RwYm1SdmQzTklhV1JsSU95aHNPMlZxZXlkZ0NEc3ZaanNocFFnN0xDOTdKMjBJT3VGdU95Mm5PdVFxQ0RpZ0pRZzdJdWs3TGloS1M0TkNpQWdJQ0F2THlCWGFXNWtiM2R6N0plUTdJU2dJR1JsZEdGamFHVmtJT3lYaHV5ZHRPdVBoQ0RydG9EcnFxZ282ckNRN0l1YzdKNlFLZXF3Z0NEc283M3NsclRyajRRZzdKNlE3SXVkN0oyQUlPeUN0T3lWaE91Q3FPdUtsT3VMcEM0TkNpQWdJQ0J3Y205aklEMGdjM0JoZDI0b2NISnYNClkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3RFFvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzRFFvZ0lDQWdmU2s3RFFvZ0lIMGdaV3h6WlNCN0RRb2dJQ0FnTHk4Z2JXRmpUMU12NjZhczY0aUY3SXFrT2lEcXNKRHNpNXpzbnBEcnBid2c2NTJFN0pxMElHNXZaR1VnN0l1azdaYUpJTzJNak95ZHZPdWhuQ0RzcDRIc29KRWc3SXFrN1krd0lDaHNZWFZ1WTJoa0lPMlptT3F5dmV5WGxDQlFRVlJJNnJDQUlPdTVpT3lWdmUyVm9DRHNpSmdnN0o2STdKYTBJT3lnaU91TWdPcXl2ZXVobkNEc2dxenNtcWtwRFFvZ0lDQWdjSEp2WXlBOUlITndZWGR1S0hCeWIyTmxjM011WlhobFkxQmhkR2dzSUZ0d1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5ZMnhoZFdSbExXSnlhV1JuWlM1cWN5Y3BYU3dnZXcwS0lDQWdJQ0FnWTNka09pQlNUMDlVDQpMQ0JrWlhSaFkyaGxaRG9nZEhKMVpTd2djM1JrYVc4NklDZHBaMjV2Y21VbkxBMEtJQ0FnSUgwcE93MEtJQ0I5RFFvZ0lIQnliMk11ZFc1eVpXWW9LVHNnTHk4ZzZyQ1E3SXVjN0o2UUlPeWR0T3V5cE8yS3VDRHJvNmp0bElUc2w1RHNoSndnNjdhRTY2YXNJQ2pxc0pEc2k1enNucEFnN0tLRjY2T002Nlc4SU91bmlleW5nQ0RzbFlycXNvd3BEUXA5RFFvTkNtTnZibk4wSUhObGNuWmxjaUE5SUdoMGRIQXVZM0psWVhSbFUyVnlkbVZ5S0NoeVpYRXNJSEpsY3lrZ1BUNGdldzBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0owOVFWRWxQVGxNbktTQjdJSEpsY3k1M2NtbDBaVWhsWVdRb01qQTBMQ0JEVDFKVFgwaEZRVVJGVWxNcE95QnlaWFIxY200Z2NtVnpMbVZ1WkNncE95QjlEUW9nSUdsbUlDaHlaWEV1ZFhKc0lEMDlQU0FuTDJobFlXeDBhQ2NwSUhzTkNpQWdJQ0F2THlCMk9pRHFzSkRzaTV6c25wQWc3TDJVNjVPY0lPdXloT3lnaENEaWdKUWc2cldzNjdLRTdLQ0VJTzJVaE91aG5PeUV1T3lLcE9xdw0KZ0NEcXM0VHNobzBnNjQrTTZyT2dJT3llaU91S2xPeW5nQ0Ryc0pic2w1RHNoSndnN1ptVjdKMjQ3WldZNjRxVUlPeWFxZXVQaEEwS0lDQWdJQzh2SUNoMk1pQTlJT3l3dlNEc2lLanF1WUFnN0lpWTdLQ1Y3WXlRTENCMk15QTlJQzloWTJOdmRXNTBJT3kybE9xd2dPMk1rQ2tOQ2lBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2QyRjBZMmhsY2pvZ2RISjFaU3dnZGpvZ015QjlLVHNOQ2lBZ2ZRMEtJQ0F2THlEc25iUWdVRVBzbDVBZzY2R2M2cmU0N0oyNDY1Q2NJTzJCdE91aG5PdVRuQ0RxczRUc29KVWc0b0NVSU8yVWpPdWZyT3EzdU95ZHVDRHNzcXNnN1ptVTY2bTB3cmZ0bVlqc25iUWdJdXVJaE9xMXJDRHFzNFRzb0pYc25MenJvWndnN0pPdzY0cVU3S2VBSWlEcnM3VHNsNnpzbzd6cmlwUWc2NDJ3SU95VHRPdUxwQzROQ2lBZ0x5OGc2ckNRN0l1YzdKNlE2ckNBSU91THRlMlZtT3VLbENEc25iVHNuS0E2SU91THBPdW1yT3VsdkNEc3ZKenJxYlFnN0p1TTY3Q04NCjdKZUY3Snk4NjZHY0lPMkJ0T3Vobk91VG5PcXdnQ0RzaTZUc29Kd2c3Wmk0N0xhYzY0KzhJT3Exck91UGhTRHNncXpzbXFucm40bnNuYlFnNjRLWTZyQ0U2NHVrTGcwS0lDQXZMeURxc0pEc2k1enNucERyaXBRZzdZeU03SjI4NjZlTUlPeWR2ZXljdk91dmdPdWhuQ0RzZ3F6c21xbnJuNGtnTUNEQ3R5RHJqSURxdUxBZ01DRGlnSlFnNnJLQTdZYWc2NmVNSU95VHNPdUtsQ0RzZ3F6cm5venNsNURxc293ZzY3bUU3SnFwN0oyRUlPdXN2T3Vtck95bmdDRHNsWXJyaXBUcmk2UXVEUW9nSUM4dklPeWp2T3lkbURvZzdKZXM2cml3SU9xemhPeWdsZXlkdENEcnM3VHNsNnpyajRRZzdKNkY3SjZsNnJhTTdKMjBJT3Vuak91ampPdVFrT3lkaENEc2lKZ2c3SjZJNjR1a0tPeWNvTzJhcU95RXNleWRnQ0RzaTZUc29Kd2c3Wmk0N0xhY0lPdVZqT3VuakNEc2xZd2c3SWlZSU95ZWlPeWRqQ0RpZ0pRZzY0dWs2NmFzSUM5b1pXRnNkR2pzblpnZ2NISnZZbXhsYlNEc3NManFzNkFwTGcwS0lDQnBaaUFvY21WeExuVnliQ0E5DQpQVDBnSnk5aFkyTnZkVzUwSnlrZ2V3MEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0JoWTJOdmRXNTBPaUJqYkdGMVpHVkJZMk52ZFc1MEtDa3NJR05zWVhWa1pUb2dhR0Z6UTJ4aGRXUmxLQ2tnZlNrN0RRb2dJSDBOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNkaGEyVW5LU0I3RFFvZ0lDQWdhV1lnS0NGb1lYTkRiR0YxWkdVb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJR1poYkhObExDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXMXBjM05wYm1jbklIMHBPdzBLSUNBZ0lIZGhhMlZDY21sa1oyVW9LVHNOQ2lBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2QyRnJhVzVuT2lCMGNuVmxJSDBwT3cwS0lDQjlEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl6YUhWMA0KWkc5M2JpY3BJSHNOQ2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPdzBLSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwTENBeU1EQXBPdzBLSUNBZ0lISmxkSFZ5YmpzTkNpQWdmUTBLSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd05Dd2dleUJsY25KdmNqb2dKMDV2ZENCbWIzVnVaQ2NnZlNrN0RRcDlLVHNOQ2cwS0x5OGc3SjIwNjYrNElPdVdvQ0Rzbm9qc25MenJxYlFnN0tHdzdKcXA3WjZJSU95aWhldWpqQ0FvN0o2UTY0K1pJT3lMbk95ZWtTQXJJRzV3YlNCaWRXbHNaQ0RzcEpIcnM3VWc3SXVrN1phSklPdU1nT3U1aENrTkNuTmxjblpsY2k1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V3MEtJQ0JwWmlBb1pTQW1KaUJsTG1OdlpHVWdQVDA5SUNkRlFVUkVVa2xPVlZORkp5a2djSEp2WTJWemN5NWxlR2wwS0RBcE93MEtJQ0J3Y205alpYTnpMbVY0YVhRb01TazdEUXA5S1RzTkNuTmxjblpsY2k1c2FYTjBaVzRvVUU5U1ZDd2cNCkp6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc05DaUFnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHRnYlRyb1p6cms1d2c2NHVrNjZhc0lPcXdrT3lMbk95ZWtDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFySUZCUFVsUXBPdzBLZlNrN0RRbz0NCjo6V1NJTEVOVDo6DQpKeUJEYkdGMVpHVWdRbkpwWkdkbElIZGhkR05vWlhJZ2MybHNaVzUwSUd4aGRXNWphR1Z5SUNodWJ5QjNhVzVrYjNjcElDMGdjbVZuYVhOMFpYSmxaQ0IwYnlCeWRXNGdZWFFnYkc5bmFXNEtVMlYwSUdaemJ5QTlJRU55WldGMFpVOWlhbVZqZENnaVUyTnlhWEIwYVc1bkxrWnBiR1ZUZVhOMFpXMVBZbXBsWTNRaUtRcFRaWFFnYzJnZ1BTQkRjbVZoZEdWUFltcGxZM1FvSWxkVFkzSnBjSFF1VTJobGJHd2lLUXBrYVhJZ1BTQm1jMjh1UjJWMFVHRnlaVzUwUm05c1pHVnlUbUZ0WlNoWFUyTnlhWEIwTGxOamNtbHdkRVoxYkd4T1lXMWxLUXB6YUM1RGRYSnlaVzUwUkdseVpXTjBiM0o1SUQwZ1pHbHlDbk5vTGxKMWJpQWlZMjFrSUM5aklHNXZaR1VnYzJOeWFYQjBjMXhpY21sa1oyVXRkMkYwWTJobGNpNXFjeUlzSURBc0lFWmhiSE5sQ2c9PQ0KOjpFTkQ6Og0K";
// ===== INSTALLER:END =====
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
    // 번역 — 한국어 ↔ 영어 자동 (직접 입력 우선, 없으면 선택 영역 텍스트).
    // 추천과 동일한 구조: 클로드 다리 전용, API 키 안 씀.
    if (msg.type === "TRANSLATE") {
        try {
            const text = (msg.text && msg.text.trim()) ? msg.text.trim() : await collectSelectedText();
            if (!text) {
                figma.ui.postMessage({ type: 'show-toast', message: '번역할 문구를 입력하거나 텍스트를 선택해주세요.' });
                return;
            }
            const bh = await bridgeHealth();
            if (!bh.alive) {
                figma.ui.postMessage({ type: 'show-toast', message: '번역하려면 클로드가 필요해요 — [클로드] 버튼으로 켜 주세요.' });
                return;
            }
            // 계정 확인 게이트 (추천과 동일) — 확인 전엔 남의 계정일 수 있는 저장 로그인을 쓰지 않는다
            if (needsAccountConfirm(bh)) {
                figma.ui.postMessage({ type: 'account-confirm-needed', account: bh.account });
                figma.ui.postMessage({ type: 'show-toast', message: '어느 클로드 계정으로 쓸지 먼저 확인해 주세요.' });
                return;
            }
            figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '클로드가 번역하는 중이에요' });
            const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/translate', { text, model: msg.model }, 130000);
            const data = await res.json();
            figma.ui.postMessage({ type: 'hide-loading' });
            if (!res.ok || data.error || !data.translated) {
                // 원인이 파악된 실패(로그인/설치)는 다리가 이미 사람용 안내문을 보냄 — 접두어 없이 그대로 + 버튼 상태 갱신
                const guided = data && data.problem && data.error;
                figma.ui.postMessage({ type: 'show-toast', message: guided ? String(data.error) : ('번역 실패: ' + (data && data.error ? data.error : ('HTTP ' + res.status))) });
                refreshBridgeStatus();
                return;
            }
            figma.ui.postMessage({ type: 'translate-result', original: text, translated: data.translated, direction: data.direction || '' });
        }
        catch (e) {
            figma.ui.postMessage({ type: 'hide-loading' });
            figma.ui.postMessage({ type: 'show-toast', message: '번역 실패: ' + errStr(e) });
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
            figma.ui.postMessage({ type: 'show-toast', message: '클로드를 켜는 중이에요 — 잠시 후 로그인 창이 열려요.' });
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
        figma.ui.postMessage({ type: 'show-toast', message: '클로드를 새 버전으로 다시 켜는 중이에요…' });
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
            figma.ui.postMessage({ type: 'show-toast', message: '새 버전으로 켜졌어요! 이제 추천받기를 누르면 돼요.' });
        }
        else if (h.problem === 'bridge-old') {
            // 재시작했는데도 옛 코드 = 감시자가 다른 폴더(설치본 등)의 다리를 켜고 있다 — 경로를 알려준다
            figma.ui.postMessage({ type: 'show-toast', message: '아직 옛 버전이 켜져요. 이 폴더의 다리가 실행 중이에요: ' + (h.dir || '경로 불명') + ' — 이 폴더를 최신 코드로 업데이트해 주세요.' });
        }
        else {
            figma.ui.postMessage({ type: 'show-toast', message: '클로드를 다시 켜지 못했어요 — [클로드 꺼짐] 버튼으로 직접 켜 주세요.' });
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
        // ② 감시자가 계정을 확정 못 했으면(구버전·꺼짐) 다리로 폴백. 다리가 켜져 있으면 파일을 읽어 계정을 안다.
        if (source === 'none') {
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
    // 클로드다리 설치 파일 요청 — UI가 base64를 받아 다운로드로 내려준다 (새 PC 첫 설정용)
    if (msg.type === "GET_INSTALLER") {
        figma.ui.postMessage({ type: 'installer-file', b64: INSTALLER_B64 });
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
