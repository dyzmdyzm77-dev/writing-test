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
function normalizeSpaces(s) {
    return s.replace(/\s+/g, " ").trim();
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
function localRecommend(text) {
    const q = normalizeForMatch(text);
    if (!q)
        return [];
    // 1) 완전 일치 우선
    for (const ex of RECOMMEND_EXAMPLES) {
        if (normalizeForMatch(ex.input) === q)
            return ex.suggestions;
    }
    // 2) 부분 포함 (입력이 예시를 포함하거나, 예시가 입력을 포함) — 가장 긴 예시 우선.
    //    숫자 제거로 짧아진 입력("2명" 등)이 아무 예시에나 걸리지 않도록 최소 길이 가드.
    if (q.length < 5)
        return [];
    const contains = RECOMMEND_EXAMPLES
        .filter((ex) => { const n = normalizeForMatch(ex.input); return n.length >= 5 && (q.includes(n) || n.includes(q)); })
        .sort((a, b) => normalizeForMatch(b.input).length - normalizeForMatch(a.input).length);
    return contains.length ? contains[0].suggestions : [];
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
// 원래 Cloudflare Worker(naver-passport-proxy/worker.js)였지만 사내 프록시가 workers.dev를
// 차단해서(1회성 사용 안내 페이지) 제보 앱과 같은 Vercel(ux-writing-reports)로 이사함 — 2026-07.
// 경로: GET {URL}passport / POST {URL}recommend / POST {URL}translate
// ↓ 주소를 바꾸면 manifest.json allowedDomains에도 같은 도메인 추가할 것.
//   구 워커('https://writingtest.dyzmdyzm77.workers.dev/')는 롤백용으로 살아 있음 — 되돌리려면
//   이 값을 워커 주소로 바꾸고 passport 경로를 ''로(워커는 루트가 passportKey).
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
const BRIDGE_MIN_V = 3;
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
function refreshBridgeStatus() {
    bridgeHealth().then((h) => {
        figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem, account: h.account, needConfirm: needsAccountConfirm(h) });
    });
}
// 클로드다리 설치 파일 — 다리+예시+런처를 내장한 자기완결 bat. UI의 [🔧 설치 파일 받기]가 다운로드로 내려준다.
// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드다리-설치.bat을 base64로 주입) =====
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZE1RVlZPUTBoRlVpY3BLUW9rYkdGMWJtTm9aWElnUFNCS2IybHVMVkJoZEdnZ0pHUnBjaUFuWTJ4aGRXUmxMV0p5YVdSblpTMXphV3hsYm5RdWRtSnpKd3BiU1U4dVJtbHNaVjA2T2xkeWFYUmxRV3hzUW5sMFpYTW9KR3hoZFc1amFHVnlMQ0FvVUdGeWRDQW5URUZWVGtOSVJWSW5JQ2RYUVZSRFNFVlNKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM05qY21sdw0KZEhOY1luSnBaR2RsTFhkaGRHTm9aWEl1YW5NbktTd2dLRkJoY25RZ0oxZEJWRU5JUlZJbklDZFhVMGxNUlU1VUp5a3BDaVIzZG1KeklEMGdTbTlwYmkxUVlYUm9JQ1JrYVhJZ0oyTnNZWFZrWlMxM1lYUmphR1Z5TFhOcGJHVnVkQzUyWW5NbkNsdEpUeTVHYVd4bFhUbzZWM0pwZEdWQmJHeENlWFJsY3lna2QzWmljeXdnS0ZCaGNuUWdKMWRUU1V4RlRsUW5JQ2RGVGtRbktTa0tJeURxc0pEc2k1enNucEE2SU91aG5PcTN1T3lkdUNEc25wRHJqNW5zaTV6c25wRWdLeURzcDREcXVJZ2c2cml3NjQrWklDanRsSXpybjZ6cXQ3anNuYmdnWm1WMFkyanFzSUFnNjR1azY2YXM2Nlc4SU95OHBDRHNpSmdnN0o2STZyS01JT0tBbENEdGxMenF0N2pycDRqcXNJQWc3WlNFNjZHYzdZYWc3TDJjSU95WHRPcTRzT3VsdkNEcnA0bnJpcFFnNjdLRTdLQ0VJT3VNZ095ZGtTa0tVMlYwTFVsMFpXMVFjbTl3WlhKMGVTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjVFdsamNtOXpiMlowWEZkcGJtUnZkM05jUTNWeWNtVnUNCmRGWmxjbk5wYjI1Y1VuVnVKeUF0VG1GdFpTQW5RMnhoZFdSbFFuSnBaR2RsVjJGMFkyaGxjaWNnTFZaaGJIVmxJQ2duZDNOamNtbHdkQzVsZUdVZ0lpY2dLeUFrZDNaaWN5QXJJQ2NpSnlrS1UzUmhjblF0VUhKdlkyVnpjeUF0Um1sc1pWQmhkR2dnSjNkelkzSnBjSFF1WlhobEp5QXRRWEpuZFcxbGJuUk1hWE4wSUNnbklpY2dLeUFrZDNaaWN5QXJJQ2NpSnlrS1RtVjNMVWwwWlcwZ0xWQmhkR2dnSjBoTFExVTZYRk52Wm5SM1lYSmxYRU5zWVhOelpYTmNZMnhoZFdSbFluSnBaR2RsWEhOb1pXeHNYRzl3Wlc1Y1kyOXRiV0Z1WkNjZ0xVWnZjbU5sSUh3Z1QzVjBMVTUxYkd3S1UyVjBMVWwwWlcxUWNtOXdaWEowZVNBdFVHRjBhQ0FuU0V0RFZUcGNVMjltZEhkaGNtVmNRMnhoYzNObGMxeGpiR0YxWkdWaWNtbGtaMlVuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FuVlZKTU9rTnNZWFZrWlNCQ2NtbGtaMlVuQ2xObGRDMUpkR1Z0VUhKdmNHVnlkSGtnTFZCaGRHZ2dKMGhMUTFVNlhGTnZablIzDQpZWEpsWEVOc1lYTnpaWE5jWTJ4aGRXUmxZbkpwWkdkbEp5QXRUbUZ0WlNBblZWSk1JRkJ5YjNSdlkyOXNKeUF0Vm1Gc2RXVWdKeWNLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVmNjMmhsYkd4Y2IzQmxibHhqYjIxdFlXNWtKeUF0VG1GdFpTQW5LR1JsWm1GMWJIUXBKeUF0Vm1Gc2RXVWdLQ2QzYzJOeWFYQjBMbVY0WlNBaUp5QXJJQ1JzWVhWdVkyaGxjaUFySUNjaUp5a0thV1lnS0MxdWIzUWdLRWRsZEMxRGIyMXRZVzVrSUc1dlpHVWdMVVZ5Y205eVFXTjBhVzl1SUZOcGJHVnVkR3g1UTI5dWRHbHVkV1VwS1NCN0NpQWdhV1lnS0MxdWIzUWdKSE5wYkdWdWRDa2dld29nSUNBZ0pISWdQU0JiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0l1eUVwT3k1bU91S2xDRHJnWjNyZ3F6c2xyVHNtcFF1SU9xM3VPdWZzT3VOc0NCT2IyUmxMbXB6NnJDQUlPeVhodXlXdE95YQ0KbEM1Z2JtQnVXKzJabGV5ZHVGM3NuWVFnNjRpRTY2VzA2Nm0wSU91THBPeWF0T3Vobk91VG5DRHRqcGpzbmJUc3A0RHFzSUFnN0plMDY2YTk2NHVJNjR1a0xtQnVUbTlrWlM1cWN5RHNoS1RzdVpqcnBid2c2NmVJN0xtY0lPdVNwQ0RzbmJRZzdZeU03SjI4N0oyRUlPdUxwT3lMbkNEc2k2VHRsb250bGJRZzdLTzg3SVM0N0pxVUxpSXNJQ2Z0Z2JUcm9aenJrNXdnNjR1azY2YXNJT3lFcE95NW1DQW9NUzh5S1NEaWdKUWdUbTlrWlM1cWN5Y3NJQ2RQUzBOaGJtTmxiQ2NzSUNkWFlYSnVhVzVuSnlrS0lDQWdJR2xtSUNna2NpQXRaWEVnSjA5TEp5a2dleUJUZEdGeWRDMVFjbTlqWlhOeklDZG9kSFJ3Y3pvdkwyNXZaR1ZxY3k1dmNtY3ZhMjh2Wkc5M2JteHZZV1FuSUgwS0lDQjlDaUFnWlhocGRBcDlDbWxtSUNndGJtOTBJQ2hIWlhRdFEyOXRiV0Z1WkNCamJHRjFaR1VnTFVWeWNtOXlRV04wYVc5dUlGTnBiR1Z1ZEd4NVEyOXVkR2x1ZFdVcEtTQjdDaUFnUW05NElDTHNoS1RzdVpqcmlwUWc2NEdkNjRLczdKYTANCjdKcVVMaURxdDdqcm43RHJqYkFnUTJ4aGRXUmxJRU52WkdYcXNJQWc3SmVHN0phMDdKcVVJQ2pybUpEcmlwUWdVRUZVU095WGtDRHNsNGJzbHJUc21wUXBMbUJ1WUc3dGhMRHJyN2pyaEpEc2w1RHNoSndnN0pXRTY1Nlk2Nlc4SU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0N1pXY0lPdVNwQ0RzbmJRZzdZeU03SjI4N0oyRUlPdUxwT3lMbkNEc2k2VHRsb250bGJRZzdLTzg3SVM0N0pxVU9tQnVZRzRnSUc1d2JTQnBibk4wWVd4c0lDMW5JRUJoYm5Sb2NtOXdhV010WVdrdlkyeGhkV1JsTFdOdlpHVmdiaUFnWTJ4aGRXUmxJR3h2WjJsdVlHNWdidTJabGV5ZHVEb2c3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKMjBJT3V5aE95Z2hPeWRoQ0RzdHB6cm9LWHRsWmpycWJRZzdLU0E2N21FSU95WmhPdWpqQzVnYmlqc2dxenNtcW5ybjRuc25ZQWc3SjIwSUZCRDdKZVFJT3Vobk9xM3VPeWR1T3VRbkNEdGdiVHJvWnpyazV3ZzZyV3M2NCtGSU8yVm5PdVBoT3lYa095RW5DRHNzS2pxDQpzSkRya0tucmk0anJpNlF1S1NJZ0orMkJ0T3Vobk91VG5DRHJpNlRycHF3ZzdJU2s3TG1ZSUNneUx6SXBJT0tBbENCRGJHRjFaR1VnUTI5a1pTY2dKMWRoY201cGJtY25DaUFnWlhocGRBcDlDbE4wWVhKMExWQnliMk5sYzNNZ0xVWnBiR1ZRWVhSb0lDZGpiV1F1WlhobEp5QXRRWEpuZFcxbGJuUk1hWE4wSUNjdll5QnViMlJsSUhOamNtbHdkSE5jWTJ4aGRXUmxMV0p5YVdSblpTNXFjeWNnTFZkdmNtdHBibWRFYVhKbFkzUnZjbmtnSkdScGNpQXRWMmx1Wkc5M1UzUjViR1VnU0dsa1pHVnVDa0p2ZUNBaTdJU2s3TG1ZSU95WmhPdWpqQ0VnN1lHMDY2R2M2NU9jSU91THBPdW1yT3VsdkNEc3ZMRHNsclRzbXBRdVlHNWdidXlkdE95Z25DRHRsTHpxdDdqcnA0Z2c3WlNNNjUrczZyZTQ3SjI0N0p5ODY2R2NJT3VQak95VmhPcXdnQ0JiN0xhVTdMS2M2N0NiNnJpd1hldWx2Q0RyaUlUcnBiVHJxYlFnN1lHMDY2R2M2NU9jNnJDQUlPdUx0ZTJWdE95YWxDNWdidXVMcE95ZGpPdTJnTzJFc091S2xDRHRsSXpybjZ6cQ0KdDdqc25ianNsNURzaEp3ZzdMYVU3TEtjd3JmcnNvanNsNjBnN1ptVTY2bTA3SmVRSU91VHBPeVd0T3F3Z091cHRDRHNucERyajVuc25MenJvWndnN0x5YzdLZVI2NHVJNjR1a0xpSWdKKzJCdE91aG5PdVRuQ0RyaTZUcnBxd2c0b0NVSU95a2dPdTVoQ0RzbVlUcm80d25JQ2RKYm1admNtMWhkR2x2YmljPQ0KOjpCUklER0U6Og0KTHk4ZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNoRGJHRjFaR1VnUW5KcFpHZGxLU0RpZ0pRZzdaUzg2cmU0NjZlSUlPMlVqT3Vmck9xM3VPeWR1T3F6dkNCRGJHRjFaR1VnUTI5a1pldWx2Q0Rzbm9mcmlwUWc2NkdjN0x1c0lPeUxyT3UyZ091bWhPcSt2QW92THlEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQUtMeThnN0lLczdKcXA2N0tWT2lEdGdiVHJvWnpyazV6cmk2VHJwcXd0N0x5YzZyaXdMbUpoZENEcmpaVHJ1SlR0Z2JUcnBxMGdLT3VZa091S2xDQnVjRzBnY25WdUlHSnlhV1JuWlNrS0x5OGc3THljNjVHUTY2bTANCklPMlVqT3Vmck9xM3VPeWR1T3lkbUNCYjdMYVU3TEtjNjdDYjZyaXdYZXF3Z0NCSFpXMXBibWtnN1lLa0lPeVhodXlkdE91UGhDRHRnYlRyb1p6cms1enJvWndnUVVrZzdMYVU3TEtjN0oyRUlPdXdtK3VLbE91THBDNEtMeThLTHk4ZzdJYU42NCtFSU95RXBPcXpoRG9nN1lHMDY2R2M2NU9jNjZXOElPeWFsT3l5cmV1bmlPdUxwQ0RzZzRqcm9ad2c3SXVjNjQrWjdaV1k2Nm0wSURNd2ZqUXc3TFNJNnJDQUlPcTN1T3VEcFNEcmdxRHNsWVRxc0lUcmk2UXVDaTh2SU9LR2tpRHJpNlRycHF6cnBid2c3THlrSU91VmpDRHRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMkVJTzJWbU91Q21DRHNsN1RzbHJRZzdJT0I3SXVjSU91TWdPcTRzT3lMbk8yQ3BPcXpvQ2h6ZEhKbFlXMHRhbk52YmlEcmpJRHRtWlFnNjZxbzY1T2NLU3dLTHk4Z0lDRHFzSURzbmJUcms1d3I3SmlJN0l1Y0tERXhNZXF4dENucmlwUWc3TEtySU91cGxPeUxuT3luZ091aG5DRHRsWndnNjdLSTY2ZU1JT3lkdmUyZWpPdUxwQzRnN0oyMDdadUVJT3lhDQpsT3l5cmV5ZGdDRHJyTGpxdGF6cnA0d2c2N08wNjRLMDY2K0E2NkdjSU91NW9PdWx0T3VMcEM0S0x5OGc3SVM0N0lXWTdKMkFJRE13NjdLSUlPeVRzT3VwdENEc25xenNpNXpzbnBIdGxiUWc2NHlBN1ptVTZyQ0FJT3VzdE8yVm5PMmVpQ0RxdUxqc2xyVHNwNERyaXBRZzZyS0Q3SjJFSU91bmlldUtsT3VMcEM0S0x5OEtMeThnN0tDRTdLQ2NPaURzbmJRZ1VFUHNsNUFnUTJ4aGRXUmxJRU52WkdYcXNJQWc3SVNrN0xtWXdyZnJvWnpxdDdqc25ianJqN3dnN0o2STdKMkVJT3F5Z3lBb1kyeGhkV1JsSUMwdGRtVnljMmx2YmlEc25MenJvWndnN1ptVjdKMjRLUW92THlEc283enNuWmc2SU95Q3JPeWFxZXVmaWV5ZGdDRHFzSUhzbnBBZzdZRzA2NkdjNjVPY0lPcTFyT3VQaFNEdGxaenJqNFRzbDVEc2hKd2c3TENvNnJDUTY1Q2M2NHVrTGdvS1kyOXVjM1FnYUhSMGNDQTlJSEpsY1hWcGNtVW9KMmgwZEhBbktUc0tZMjl1YzNRZ1puTWdQU0J5WlhGMWFYSmxLQ2RtY3ljcE93cGpiMjV6ZENCdmN5QTlJSEpsY1hWcA0KY21Vb0oyOXpKeWs3Q21OdmJuTjBJSEJoZEdnZ1BTQnlaWEYxYVhKbEtDZHdZWFJvSnlrN0NtTnZibk4wSUhzZ2MzQmhkMjRzSUhOd1lYZHVVM2x1WXlCOUlEMGdjbVZ4ZFdseVpTZ25ZMmhwYkdSZmNISnZZMlZ6Y3ljcE93b0tMeThnN1lHMDY2R2M2NU9jNjZXOElPdTVpQ0R0ajdUcmpaVHNsNURzaEp3ZzdJdWs3WmFKSU9LQWxDRHNvSURzbnFYc2hvenNsNURzaEp3ZzdJdWs3WmFKN1pXWTY2bTBJTzJVaE91aG5PeWduZTJLdUNEcnA2WHJuYjBvUTB4QlZVUkZMbTFrSU91VHNTbnNuWVFLTHk4ZzY2ZWtJTzJFdENEc3A0cnNsclRzb0xqc2hKd2dORFhzdElndjdZUzA2cm1NN0tlQUlPdUtrT3VncE95bmhPdUxwQ0FvNjdtSUlPMlB0T3VObENBcklPdTJnT3F3Z09xNHNPdUtwU0Rzc0tqcmk2anNuYlRycWJRZ2ZqUHN0SWd2N1lTMEtTNEtZMjl1YzNRZ1JVMVFWRmxmUTFkRUlEMGdjR0YwYUM1cWIybHVLRzl6TG5SdGNHUnBjaWdwTENBblkyeGhkV1JsTFdKeWFXUm5aUzFqZDJRbktUc0tkSEo1SUhzZ1puTXUNCmJXdGthWEpUZVc1aktFVk5VRlJaWDBOWFJDd2dleUJ5WldOMWNuTnBkbVU2SUhSeWRXVWdmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91c3RPeUxuQ0FxTHlCOUNtTnZibk4wSUVOTVFWVkVSVjlGVGxZZ1BTQlBZbXBsWTNRdVlYTnphV2R1S0h0OUxDQndjbTlqWlhOekxtVnVkaXdnZXdvZ0lFMUJXRjlVU0VsT1MwbE9SMTlVVDB0RlRsTTZJQ2N3Snl3Z0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDOHZJT3lEbmVxd2dTRHJxcWpyazV3ZzY0R1VJQ2pzcDZmc25ZQWc2Nnk0NnJXczdKZVVJT3UyaU8yVmhPeWFsQ2tLSUNCRFRFRlZSRVZmUTA5RVJWOUVTVk5CUWt4RlgwNVBUa1ZUVTBWT1ZFbEJURjlVVWtGR1JrbERPaUFuTVNjc0lDOHZJTzJFdENEc21wVHNsYjBnNjVPeElPdTJnT3F3Z0NEdG1ManN0cHdnNjRHVUNpQWdSRWxUUVVKTVJWOVVSVXhGVFVWVVVsazZJQ2N4Snl3S2ZTazdDZ3BqYjI1emRDQlFUMUpVSUQwZ1RuVnRZbVZ5S0hCeWIyTmxjM011Wlc1MkxrSlNTVVJIUlY5UVQxSlVLU0I4DQpmQ0F4TVRnNE9Ec2dMeThnUWxKSlJFZEZYMUJQVWxUcmlwUWc3WVdNN0lxazdZcTQ3SnFwSUNqdGo0bnNob3pzbDVRZ01URTRPRGdnNnJPZzdLQ1ZLUW92THlEcmk2VHJwcXdnN0wyVTY1T2NJT3V5aE95Z2hDRGlnSlFnTDJobFlXeDBhT3VobkNEcmhianN0cHp0bFp6cmk2UXVJT3k5bE91VG5PdWx2Q0J3ZFd4c3dyZnJzN1hzZ3F6dGxiVHJqNFFnS2lyc25iVHJyN2dnNjVhZ0lPeWVpT3VLbENEcmk2VHJwcXpyaXBRZzdKaWJJT3k5bE91VG5DRHF0N2pyaklEcm9ad3FLdXVkdkFvdkx5RHF1NURyaTZRZzdMeWM2cml3SU95Z2hPeVhsQ0RzZzRnZzY0K1o3SjZSN0oyMElPeVZpQ0RyZ3Bqc21LanJpNlFvN1lTdzY2KzQ2NFNRN0oyMElPdWNxT3VLbENEcms3RXBMaUR0bEl6cm42enF0N2pzbmJqc25iUWc3SjIwSU9xd2t1eWN2T3VobkNEcXRhenJzb1Rzb0lUc25ZUWc2ckNRN0tlQTdaVzBJT3llck95TG5PeWVrZXlMbk8yQ3FPdUxwQzRLTHk4ZzY0K1o3SjZSN0oyMElPdXdsT3VBak91S2xDRHNpSmpzb0pYcw0KbllRZzdaV1k2Nm0wSU95ZHRDRHNpS3ZzbnBEcnBid2c3SmlzNjZhczZyT2dJR052WkdVdWRIUHNuWmdnUWxKSlJFZEZYMDFKVGw5VzY0K0VJT3F3bWV5ZHRDRHNtS3pycHJEcmk2UXVDbU52Ym5OMElFSlNTVVJIUlY5V0lEMGdNenNLTHk4ZzZyaXc2N080SU91cXFPdU51QzRnN0pxVTdMS3RLTzJVak91ZnJPcTN1T3lkdUNuc25iUWdiVzlrWld6c25ZUWc3S2VBN0tDVjdaV1k2Nm0wSU9xM3VDRHNtcFRzc3EzcnA0d2c2cmU0SU91cXFPdU51T3VobkNEc3NwanJwcXp0bFp6cmk2UXVDaTh2SUdoaGFXdDFQZXU1b091bWhDL3FzSURyc3J6c200QXNJSE52Ym01bGREM3NwSkhxc0lRc0lHOXdkWE05NnJpdzY3TzRLT3kxbk9xem9PMlNpT3luaUN3ZzdLR3c2cmlJSU91S2tPdW12Q2tLWTI5dWMzUWdRMHhCVlVSRlgwMVBSRVZNSUQwZ2NISnZZMlZ6Y3k1bGJuWXVRbEpKUkVkRlgwMVBSRVZNSUh4OElDZHZjSFZ6SnpzS1kyOXVjM1FnUVV4TVQxZEZSRjlOVDBSRlRGTWdQU0JiSjJoaGFXdDFKeXdnSjNOdmJtNWwNCmRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPY0lDaHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FnNG9DVUlHSjFhV3hrTFdkc2IzTnpZWEo1TG1wejdKbUFJT3F3bWV5ZGdDRHRqSXpzaEp3cElPS1VnT0tVZ0FwbWRXNWpkR2x2YmlCc2IyRmtSWGhoYlhCc1pYTW9LU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FuDQpLU3dnSjNWMFpqZ25LVHNLSUNBZ0lHTnZibk4wSUhObFkwbGtlQ0E5SUcxa0xuTmxZWEpqYUNndlhpTWpJT3kybE95eW5DRHNtSWpzaTV4Y2N5b2tMMjBwT3dvZ0lDQWdhV1lnS0hObFkwbGtlQ0E5UFQwZ0xURXBJSEpsZEhWeWJpQmJYVHNLSUNBZ0lHTnZibk4wSUdWNFlXMXdiR1Z6SUQwZ1cxMDdDaUFnSUNCc1pYUWdZM1Z5SUQwZ2JuVnNiRHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjbUYzSUc5bUlHMWtMbk5zYVdObEtITmxZMGxrZUNrdWMzQnNhWFFvSjF4dUp5a3BJSHNLSUNBZ0lDQWdZMjl1YzNRZ2JHbHVaU0E5SUhKaGR5NXlaWEJzWVdObEtDOWNjeXNrTHl3Z0p5Y3BPd29nSUNBZ0lDQmpiMjV6ZENCb0lEMGdiR2x1WlM1dFlYUmphQ2d2WGlNakkxeHpLeWd1S3o4cFhITXFKQzhwT3dvZ0lDQWdJQ0JwWmlBb2FDa2dleUJqZFhJZ1BTQjdJR2x1Y0hWME9pQm9XekZkTENCemRXZG5aWE4wYVc5dWN6b2dXMTBnZlRzZ1pYaGhiWEJzWlhNdWNIVnphQ2hqZFhJcE95QmpiMjUwYVc1MVpUc2dmUW9nSUNBZw0KSUNCamIyNXpkQ0JpSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYbHh6S2kxY2N5c29MaXMvS1Z4ektpUXZLVHNLSUNBZ0lDQWdhV1lnS0dJZ0ppWWdZM1Z5S1NCamRYSXVjM1ZuWjJWemRHbHZibk11Y0hWemFDaGlXekZkTG5Od2JHbDBLQ2NnTHlBbktTNXFiMmx1S0NjZ0p5a3BPd29nSUNBZ2ZRb2dJQ0FnY21WMGRYSnVJR1Y0WVcxd2JHVnpMbVpwYkhSbGNpZ29aU2tnUFQ0Z1pTNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dQaUF3S1RzS0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0ppSTdJdWNJT3lDck95Z2hDRHJvWnpyazV3ZzdJdWs3WXlvSUNqc2w0YnNuYlFnN0tlRTdaYUpLVG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnY21WMGRYSnVJRnRkT3dvZ0lIMEtmUW9LTHk4ZzRwU0E0cFNBSU95bmdPeUxuT3VzdUNBbzdJU2M2N0tFSUhKbFkyOXRiV1Z1Wk95WmdDRHFzSm5zbllBZzZyZWM3TG1aSU9LQWxDRHJzSlRxdnJqcnFiUWc2cmU0N0txOTY0K0UNCklPMlZxT3E3bUNrZzRwU0E0cFNBQ21OdmJuTjBJRk5VV1V4RlgxSlZURVZUSUQwZ1d3b2dJQ2N4TGlEdGxiVHNtcFRzc3JRNklPdXFxT3VUb0NEcnJManF0YXpyaXBRZzdaVzA3SnFVN0xLMDY2R2NMaUFvNjdPMDY0T0Y2NHVJNjR1azRvYVM2N08wNjRLMDdKcVVLU2NzQ2lBZ0p6SXVJT3VLcGV1UG1leWdnU0RycDVEdGxaanF1TEE2SU91UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDd2dmdXlYaUNEcnVienF1TEFvNjdDVTY0Q003SmVJN0phMDdKcVU0b2FTNjdDVTZyK283SmEwN0pxVUtTNGc2NHVvTENEc29vWHJvNHpDdCt1bmpPdWpqTUszN0pldzdMSzB3cmZ0bGJUc3A0REN0K3E0c091aG5jSzM2NFc1N0oyTUlPdVRzU0RzaTV6c2lxVHRoWnpzbmJRZzdLTzg3TEswN0oyNElPcXlzT3F6dk91S2xDRHNpSmpyajVudG1KVWc3SnlnN0tlQUtPeVhzT3l5dE91UHZPeWFsQ3dnNjRXNTdKMk02NCs4N0pxVUtTNG5MQW9nSUNjekxpRHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdPaUFpZnUyVm9DRHNpSmdnDQo3SmVHN0phMDdKcVVJaURyaklEc2k2QWdJbjd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWlJT3Exck95aHNDRHNtckRzaEtBdUlPdUxxQ3dnN0tDVjdMR0Y3SU9CSU91MmlPcXdnTUszN0oyODY3YUFJT3E0c091S3BTRHNvSnp0bFp6Q3QrdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3F5c09xenZNSzM3S0NWNjdPMElPdXp0TzJZdUNEc2xZanNpNnpzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJlaUM0bkxBb2dJQ2MwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phME9pQis3WldZN0l1YzZyS2c3SmEwN0pxVVArS0drbjd0bGFEcXVZenNtcFEvTENEcXM0VHNpNXpyaTZUaWhwTHNub2pyaTZRc0lPeVhyT3l0aU91THBPS0drdTJabGV5ZHVPMlZtT3VMcEN3ZzZydVk0b2FTN0plUTZyS01MaUIrN0l1Y0lPdTV2T3E0c09xd2dDRHNsclRzZzRudGxaanJxYlFnN1l5TTdKV0Y3WldZNjZDazY0cVVJT3lnbGV1enRPdWx2Q0Rzbzd6c2xyVHJvWndnNjZ5NDdKNmw3SjJFSU91TA0KcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cExpY3NDaUFnSnpZdUlPMlJuT3E0c0RvZzY1Q1k3SmEwN0pxVTRvYVM2NCs4N0pxVUxpY3NDaUFnSnpjdUlPeWtoQ0RxdGF6c29iQTZJT3lia091enVPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPeTJsT3l5bk91UGhDRHJzSmpyazV6c2k1d2c3WldjSU95a2hPdWhuQzRnN0o2RTdKMlk2NkdjSU95a2hPeWRoQ0RyaXBqcnBxenNwNEFnN0pXSzY0cVU2NHVrTGlEcmk2Z3MNCklPeVhyT3VmckNEcnJManNucVhzbllRZzdaV1k2NEtZN0oyWUlPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25MenJvWndnN1pXcDdMT1FJT3VObENEcXNJVHFzckR0bGJUc3A0VHJpNlRycWJRZzdLU0VJT3lJbU91bHZDRHNwSVRzbmJUcmlwUWc2cktEN0oyQUlPMlptT3lZZ1M0bkxBb2dJQ2M0TGlEcmk2VHNuYlRzbHJ6cm9aenF0N2dnN0ptODdLcTlJT3V5aE8yS3ZDRHJuYnpyc3Fqc25ZQWdJdXVMcStxNHNDSW83TGVvN0lhTUlPcTRpT3luZ0NrdUp5d0tJQ0FuT1M0ZzdKMjA2NmFFd3Jmc29JVHRtWlRyc29qdG1MakN0K3VuaU95S3BPMkN1ZXlkZ0NEcXQ3anJqSURyb1p3ZzY3TzA3S0cwTGlEc2dxenJub3pzbllRZzY3YUE2Nlc4SU91VmtDRHJpNWpzbllRZzY3YVo3SmVzNjQrRUlPeWlpK3VMcEM0bkxBb2dJQ2N4TUM0ZzdLQ2M3WktJSU95YXFleVd0Q0RzbktEc3A0QTZJT3llaGV1Z3BleVhrQ0RzazdEc25iZ2c2cml3NjRxbDdJU3hJT3VxaGV5Q3JDanJzNERxc3Iwc0lPeW5nT3lnbFN3ZzY1T3g2NkdkDQpMQ0R0bGJUc29Kd2c2NU94S2V1S2xDRHRtWlRycWJUc25aZ2c2cml3NjRxbDY2cUZ3cmZyc29UdGlyenJxb1hzbmJ3ZzZyQ0E2NHFsN0lTeDdKMjBJT3VHa3V5Y3ZPdXZnT3VobkNEc2lhenNtclFnNjZlUTY2R2NJT3V3bE9xK3VPeW5nQ0RzbFlycmlwVHJpNlF1SU95TG5PeUtwTzJGbkNEcmo1bnNucEhxczd3ZzY0dWs2Nlc0SU91UG1leUNyT3VsdkNEc2c0anJvWndnNjZlTTY1T2s3S2VBSU95Vml1dUtsT3VMcEM0bkxBcGRMbXB2YVc0b0oxeHVKeWs3Q2dwamIyNXpkQ0JGV0VGTlVFeEZVeUE5SUd4dllXUkZlR0Z0Y0d4bGN5Z3BPd29LWm5WdVkzUnBiMjRnYVc1emRISjFZM1JwYjI1TlpYTnpZV2RsS0NrZ2V3b2dJR052Ym5OMElHWmxkMU5vYjNRZ1BTQkZXRUZOVUV4RlV5NXRZWEFvS0dWNEtTQTlQaUFuU1c1d2RYUTZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2hsZUM1cGJuQjFkQ2tnS3lBblhHNVBkWFJ3ZFhRNklDY2dLeUJLVTA5T0xuTjBjbWx1WjJsbWVTaGxlQzV6ZFdkblpYTjBhVzl1Y3lrcA0KTG1wdmFXNG9KMXh1SnlrN0NpQWdjbVYwZFhKdUlDZ0tJQ0FnSUNmc3A0RHF1SWpydG9EdGhMQWc2NFNJNjRxVUlPeVhrT3lLcE95YmtDaFRMVEVzSU91enRPeVZpTzJhak95Q3JDbnNuWmdnN1pXYzZyV3Q3SmEwSUZWWUlGZHlhWFJwYm1jZzdLQ0U2Nnk0NnJDQTY2R2NJT3lkdk8yVm5PdUxwQzRnSnlBckNpQWdJQ0FuNjRLMDZyQ0FJRlZKSU91c3VPcTFyT3VsdkNEdGxaanJncGpzbEtrZzY3TzA2NEswNjZtMExDRHNsWVRybnBnZzdJcWs3WU9BN0oyOElPcTNuT3k1bWV5WGtDRHJwNTdxc293ZzY0dWs2NU9zN0oyQUlPdU1nT3lWaUNBejZyQ2M2Nlc4SU95Z25PeVZpTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdKK3lhbE95eXJldVRwT3lkZ0NEc2hKenJvWndnNjZ5MDZyU0E3WldjSU91emhPcXduQ0RyckxqcXRhenJpNlFnNG9DVUlPeWR0T3lnaENEcnJManF0YXpycGJ3ZzdMQzQ3S0d3N1pXWTdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdKK3lia091ZW1DRHNuWmpycjdqc21ZQWc2NnFvNjVPZ0lPeWcNCmxldXp0Q2pzbmJUcnBvVEN0K3lJcSt5ZWtNSzM3S0d3NnJHMHdyZnJqSURzZzRFcDY2VzhJT3ljb095bmdPMlZtT3F6b0N3ZzZyQ0JJT3lnbk95VmlPeWRnQ0RzbTVEcnM3anFzN3pyajRRZzdJU2M2NkdjN0ptQTY0K0VJT3VMck91ZHZPeVZ2Q0R0bFp6cmk2UXVYRzRuSUNzS0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzY3Q3c3SmUwNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9YQ3QreTlsT3VUbk8yT25PeUtwQ0RxdUlqc3A0QTZYRzRuSUNzS0lDQWdJQ2RiZXlKMFpYaDBJam9nSXV5Z25PeVZpQ0RyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW5KbFlYTnZiaUk2SUNMcnJMVHNsNGZzbllRZzdKbWNJT3V3bE9xL3FPdUtsT3luZ0NEdGxaenF0YTNzbHJRZzdaV2NJT3VzdU95ZXBTSjlMQ0F1TGk1ZFhHNWNiaWNnS3dvZ0lDQWdKMXZzaXFUdGc0RHNuYndnNnJlYzdMbVpYVnh1SnlBcklGTlVXVXhGWDFKVlRFVlRJQ3NnDQpKMXh1WEc0bklDc0tJQ0FnSUNobVpYZFRhRzkwSUQ4Z0oxdnNtckRycHF3ZzY2cXA3SWFNNjZhc0lPeVlpT3lMbkNEaWdKUWc3SjIwSU8yR3BPeWRoQ0RybExEcnBid2c2cktEWFZ4dUp5QXJJR1psZDFOb2IzUWdLeUFuWEc1Y2JpY2dPaUFuSnlrZ0t3b2dJQ0FnSit5a2dPdTVoT3VRa095Y3ZPdXB0Q0FpVDBzaTY1Mjg2ck9nNjZlTUlPdUx0ZTJWbU91ZHZDNG5DaUFnS1RzS2ZRb0tMeThnNHBTQTRwU0FJT3lEZ2V5TG5DRHJqSURxdUxBZzdZRzA2NkdjNjVPY0lPeUV1T3lGbUNEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS2JHVjBJSEJ5YjJNZ1BTQnVkV3hzT3lBZ0lDQWdJQ0FnSUNBdkx5RHRnYlRyb1p6cms1d2c3WlNFNjZHYzdJUzQ3SXFrQ214bGRDQnNhVzVsUW5WbUlEMGdKeWM3SUNBZw0KSUNBZ0lDQWdMeThnYzNSa2IzVjBJT3lraENEcnNvVHRqYndLYkdWMElIZGhhWFJsY2lBOUlHNTFiR3c3SUNBZ0lDQWdJQ0F2THlEdG1JVHNucXdnN1lTMDdKMllJSHNnY21WemIyeDJaU3dnY21WcVpXTjBMQ0IwYVcxbGNpQjlDbXhsZENCeGRXVjFaU0E5SUZCeWIyMXBjMlV1Y21WemIyeDJaU2dwT3lBdkx5RHNtcFRzc3EwZzdLZUI2NkNzN1ptVUlDanJqNW5zaTV3ZzdKcVU3TEt0N0oyQUlPeUluT3lFbk91TWdPdWhuQ2tLYkdWMElIUjFjbTV6SUQwZ01Ec0tiR1YwSUhkaGNtMWxaRlZ3SUQwZ1ptRnNjMlU3Q214bGRDQmpkWEp5Wlc1MFRXOWtaV3dnUFNCRFRFRlZSRVZmVFU5RVJVdzdJQzh2SU95bmdPcTRpQ0RzaExqc2haanNuYlFnNjZ5ODZyT2dJT3llaU91S2xDRHJxcWpyamJnZ0tPeWFsT3l5cmV5ZHRDRHJpNlRycGJnZzY2cW82NDI0N0oyRUlPeW5nT3lnbGUyVm1PdXB0Q0RzaExqc2haZ2c3SjZzN0l1YzdKNlJLUW92THlEc2k1enNucEVnN0l1Y0lFTnNZWFZrWlNCRGIyUmxLR05zWVhWa1pTQkQNClRFa3A2ckNBSU95VHVDRHNpSmdnN0o2STY0cVU3S2VBSU95Z2tPcXlnQ0RpZ0pRZzdKZUc3Snk4NjZtMElDOW9aV0ZzZEdqcm9ad2c3SldNNjZDa0lPMlVqT3Vmck9xM3VPeWR1T3lkdENEc2xZanJnclR0bFp6cmk2UXVDaTh2SUc1MWJHdzk3Wm1WN0oyNElPeWtrU3dnSjI5ckp6M3NncXpzbXFrZzZyQ0E2NHFsTENBblkyeGhkV1JsTFcxcGMzTnBibWNuUFdOc1lYVmtaU0RycW9Ycm9Ma2c3SmVHN0oyTUxBb3ZMeUFuWTJ4aGRXUmxMV3h2WjI5MWRDYzlZMnhoZFdSbDY0cVVJT3llaU95bmdPdW5qQ0Ryb1p6cXQ3anNuYmdnN0lTNDdJV1lJT3Vuak91ampDQW83WVMwSU95THBPMk1xQ0RzaTV3ZzZyQ1E3S2VBTENEc2hMSHFzN1VnN1lTMDdKMjBJT3lZcE91cHRDRHNucERyajVrZzdaVzA3S0NjS1Fwc1pYUWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ2JuVnNiRHNLTHk4ZzY2R2M2cmU0N0oyNElPdW5qT3VqakNEcXNKRHNwNEFnNG9DVUlFTk1TZXF3Z0NEcmdyVHJpcFFnN0ppQjdKYTBJT3lkdU95bW5TRHNtS1RyDQpwWmpycGJ3ZzdJS3M2NTZNN0oyMElPeVZqT3lWaE91VHBPeWRoQ0RzbFlqcmdyVHJvWndnNjdDVTZyNjg2NHVrTGdvdkx5QW9ZMnhoZFdSbElDMHRkbVZ5YzJsdmJ1eWRnQ0Ryb1p6cXQ3anNuYmdnN0plRzdKMjA2NCtFSU95RXNlcXp0ZTJWdE95RW5DRHNpNXpyajVrZzdLQ1E2cktBN0p5ODY2R2M2NHFVSU91cXV5RHNucUhxczZBc0lPeUxwT3lnbkNEdGhMVHNsNURzaEp6cnA0d2c2NU9jNjUrczY0S2M2NHVrS1Fvdkx5QWk2NmVNNjZPTUl1dW5qT3lkdENEc2xZVHJpNGpybmJ3Z0l1MlZuQ0Ryc29qcmo0UWc2NkdjNnJlNDdKMjRJT3lWaUNEdGxhZ2k2NCtFSU9xd21leWRnQ0Rxc3Izcm9aenJvWndnN0o2aDdaNkk2NitBNjZHY0lPeWtrZXVtdlNEdGtaenRtSVRzbllRZzdKTzA2NHVrQ21OdmJuTjBJRXhQUjBsT1gwZFZTVVJGSUQwZ0orMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25ianNuYlFnN1pXRTdKcVU3WlcwN0pxVUtPeVZpQ0Rya0pEcXNiRHJncGdnNjZlTTY2T01LU0RpZ0pRZ1cvQ2ZuNkFnN1lHMA0KNjZHYzY1T2NJT3Vobk9xM3VPeWR1Q0R0bFlUc21wUmRJT3V5aE8yS3ZPeWRoQ0RyaUlUcnBiVHJxYlFnNjZHYzZyZTQ3SjI0SU95d3ZleWRoQ0RzbDdUc2xyVHJrNXpyb0tUc21wUXVKenNLTHk4ZzdJdWs3TGloN1pXY0lPdXN1T3Exck91VHBEb2dJa1poYVd4bFpDQjBieUJoZFhSb1pXNTBhV05oZEdVNklFOUJkWFJvSUhObGMzTnBiMjRnWlhod2FYSmxaQ0JoYm1RZ1kyOTFiR1FnYm05MElHSmxJSEpsWm5KbGMyaGxaQ0lvNjZlTTY2T01LU3dLTHk4Z0lrNXZkQ0JzYjJkblpXUWdhVzRnd3JjZ1VHeGxZWE5sSUhKMWJpQXZiRzluYVc0aUtPdXZ1T3Vobk9xM3VPeWR1Q2tnNG9DVUlPdVJtQ0RyaTZRZzdKNmg3WjZJNnJLTUlPdUVrKzJlak91THBBcG1kVzVqZEdsdmJpQnBjMEYxZEdoRmNuSnZjaWh6S1NCN0NpQWdjbVYwZFhKdUlDOWhkWFJvWlc1MGFXTmhkSHh2WVhWMGFIeGhjR2tnYTJWNWZHeHZaeUEvYVc1OGJHOW5aMlZrZkhObGMzTnBiMjRnWlhod2FYSmxaQzlwTG5SbGMzUW9VM1J5YVc1bktITXANCktUc0tmUW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPMlpsZXlkdUNEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTno2Nlc4SU95ZHZleVd0QW92THlBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVm5PdUxwQ0FvN1pTTTY1K3M2cmU0N0oyNDdKMjBJQ0xyaUlUcXRhd2c2ck9FN0tDVjdKeTg2NkdjSU95VHNPdUtsQ0RzcEpIc25ianNwNEFpSU8yUm5PeUxuQ0RpZ0pRZzZyTzE3SnFwSUZCRDdKZVE3SVNjSU91Q3FPeWRtQ0RxczRUc29KVWc3SmlrN0lLczdKcXBJT3V3cWV5bmdDa3VDaTh2SU8yTWpPeWR2T3lkdENEdGdiUWc3SWlZSU95ZWlPeVd0Q2p0bElUcm9aenNvSjN0aXJnZzdKMjA2NkNsSU8yUHJPMlZxQ2tnTXpEc3RJZ2c3THFRN0l1Y0xpRHNucXpyb1p6cXQ3anNuYmp0bFpqcnFiUWdRMHhKNnJDQUlPMk1qT3lkdk95ZGhDRHFzTEhzaTZEdGxaanJyNERyb1p3ZzdKNlE2NCtaDQpJT3V3bU95WWdldVFuT3VMcEM0S2JHVjBJR0ZqWTI5MWJuUkRZV05vWlNBOUlIc2dZWFE2SURBc0lHVnRZV2xzT2lCdWRXeHNJSDA3Q21aMWJtTjBhVzl1SUdOc1lYVmtaVUZqWTI5MWJuUW9LU0I3Q2lBZ2FXWWdLRVJoZEdVdWJtOTNLQ2tnTFNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUENBek1EQXdNQ2tnY21WMGRYSnVJR0ZqWTI5MWJuUkRZV05vWlM1bGJXRnBiRHNLSUNCc1pYUWdaVzFoYVd3Z1BTQnVkV3hzT3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCcUlEMGdTbE5QVGk1d1lYSnpaU2htY3k1eVpXRmtSbWxzWlZONWJtTW9jR0YwYUM1cWIybHVLRzl6TG1odmJXVmthWElvS1N3Z0p5NWpiR0YxWkdVdWFuTnZiaWNwTENBbmRYUm1PQ2NwS1RzS0lDQWdJR1Z0WVdsc0lEMGdLR29nSmlZZ2FpNXZZWFYwYUVGalkyOTFiblFnSmlZZ2FpNXZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOektTQjhmQ0J1ZFd4c093b2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3Vobk9xM3VPeWR1Q0RzbmJUcg0Kb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDRHNuS0RzcDRBZ0tpOGdmUW9nSUdGalkyOTFiblJEWVdOb1pTQTlJSHNnWVhRNklFUmhkR1V1Ym05M0tDa3NJR1Z0WVdsc0lIMDdDaUFnY21WMGRYSnVJR1Z0WVdsc093cDlDbVoxYm1OMGFXOXVJR05vWldOclEyeGhkV1JsUVhaaGFXeGhZbXhsS0NrZ2V3b2dJR052Ym5OMElIQnliMkpsSUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbkxTMTJaWEp6YVc5dUoxMHNJSHNnYzJobGJHdzZJSFJ5ZFdVc0lHVnVkam9nUTB4QlZVUkZYMFZPVmlCOUtUc0tJQ0JzWlhRZ2IzVjBJRDBnSnljN0NpQWdjSEp2WW1VdWMzUmtiM1YwTG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzZ2IzVjBJQ3M5SUdRdWRHOVRkSEpwYm1jb0tUc2dmU2s3Q2lBZ2NISnZZbVV1YjI0b0oyVnljbTl5Snl3Z0tDa2dQVDRnZXlCamJHRjFaR1ZUZEdGMGRYTWdQU0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25PeUI5S1RzS0lDQndjbTlpWlM1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGcNCmV3b2dJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdLR052WkdVZ1BUMDlJREFnSmlZZ0wxeGtLMXd1WEdRckx5NTBaWE4wS0c5MWRDa3BJRDhnSjI5ckp5QTZJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGdRMnhoZFdSbElFTnZaR1VnN0tDUTZyS0FPaUFuSUNzZ1kyeGhkV1JsVTNSaGRIVnpJQ3NnS0c5MWRDQS9JQ2NnS0NjZ0t5QnZkWFF1ZEhKcGJTZ3BJQ3NnSnlrbklEb2dKeWNwS1RzS0lDQjlLVHNLZlFvdkx5RHNzcGpycHF3ZzdaaUU3Wm1wSU9LQWxDQXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZ0Q0FpN0tDVjY2ZVFJTzJCdE91aG5PdVRuT3F3Z0NEcmk3WHRsb2pyaXBUc3A0QWlJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsYUFnN0lpWUlPeWVpT3F5akNEdGxaenJpNlFLWTI5dWMzUWdjM1JoZEhNZ1BTQjdJSE5sY25abFpEb2dNQ3dnYkdGemRFRjBPaUFuSnl3Z2JHRnpkRlJsZUhRNklDY25MQ0JzWVhOMFUyVmpPaUFuSnlCOU93b0tMeThnDQo0cFNBNHBTQUlPMlVqT3Vmck9xM3VPeWR1Q0RzZzUzc29iUWc2ckNRN0tlQUtPeUxyT3llcGV1d2xldVBtU2tnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RybHFBZzdKNkk2NHFVSU91UG1leVZpQ0JqYjJSbExuUno2ckNBSURYc3RJanJwNGpyaTZRZ1VFOVRWQ0F2YUdWaGNuUmlaV0YwNjZXOElPdXp0T3VDdU91THBDNEtMeThnN1pXY0lPdXlpT3lkdE91ZHZPdVBoQ0Ryc0p2c25ZQWc2NUtrSURNdzdMU0k2ckNFSU91Qml1cTRzT3VwdENEdGxJenJuNnpxdDdqc25iZ282NWlRNjRxVUlPMlV2T3EzdU91bmlDbnNuYlFnNjR1cjdaNk1JT3F5Z3lEaWdKUWc3WUcwNjZHYzY1T2M2cm1NN0tlQUlPdU5zT3Vtck9xem9DRHFzSm5zbmJRZzZycTg3S2VFNjR1a0xnb3ZMeURzbFlUc3A0RWc3WldjSU91eQ0KaU91UGhDRHJxcnNnNjdDYjdKV1k3Snk4NjZtMEtPdUxwT3Vtck91bmpDRHJxTHpzb0lBZzdMeWdJT3lEZ2UyRG5Dd2c3SjZRNjQrWjdJdWM3SjZSSU91VHNTa2c2ck9FN0lhTklPdU1nT3E0c08yVm5PdUxwQzRLWTI5dWMzUWdTRVZCVWxSQ1JVRlVYMFJGUVVSZlRWTWdQU0F6TURBd01Ec0tiR1YwSUd4aGMzUkNaV0YwSUQwZ01Ec0tjMlYwU1c1MFpYSjJZV3dvS0NrZ1BUNGdld29nSUdsbUlDaHNZWE4wUW1WaGRDQW1KaUJFWVhSbExtNXZkeWdwSUMwZ2JHRnpkRUpsWVhRZ1BpQklSVUZTVkVKRlFWUmZSRVZCUkY5TlV5a2dld29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJVak91ZnJPcTN1T3lkdUNEc2k2enNucVhyc0pYcmo1a2c2NEdLNnJtQUlPS0FsQ0R0bEx6cXQ3anJwNGd2N1pTTTY1K3M2cmU0N0oyNDdKMjBJT3VMcSsyZWpDRHFzb1Bzbkx6cm9ad2c2N08wNnJPZ0lPcXdtZXlkdENEcXVyenNwNUhyaTRqcmk2UXVKeWs3Q2lBZ0lDQndjbTlqWlhOekxtVjRhWFFvTUNrN0lDOHYNCklHVjRhWFFnN1pXNDY1T2s2NStzNnJDQUlHdHBiR3hRY205ajdKeTg2NkdjSUdOc1lYVmtaU0R0aXJqcnBxenJwYndnN0tDVjY2YXM3WldjNjR1a0NpQWdmUXA5TENBMU1EQXdLVHNLQ2k4dklPdWhuT3EzdU95ZHVDQlZVa3pzbllRZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dDanJzN1R0aHJVZzdMQzlLZXVobkNEc2w2enJpcFFnUWxKUFYxTkZVaUR0bGJqcms2VHJuNndnN0lxazdZR3M2NmE5N1lxNDY2VzhJT3Vuak91VG9PdUxwQzRLTHk4Z1kyeGhkV1JsSUVOTVNldUtsQ0JDVWs5WFUwVlNJTzJabU9xeXZldXpnT3lJbU91bHZDRHNvYlRzcEpIdGxiUWc2N2lNNjUyODdKcXc3S0NBNjZXOElPeW5nZXlna1NEc2w3VHNwNEFnN0pXSzZyT2dJT3lkdENEc2lxVHRnYXpycHIzdGlyanNsNUFnWVhWMGFHOXlhWHBsSUZWU1RPeWRoQ0RyaEpqcXVMVHJpNlFvN0l1azdMaWhJREl3TWpZdE1EY3BMZ292THlCdGIyUmxQU2R6ZDJsMFkyZ25LT3F6aE95Z2xTRHNvSVR0bVpncElPS0draURyb1p6cXQ3anNuYmdnDQpWVkpNN0oyRUlPeVh0T3E0c0NEc29JVHNsNUFnWTJ4aGRXUmxMbUZwSU91aG5PcTN1T3lWaE95YmcreWRoQ0RycUx6c29JQWc3WU9jN0pxMDY0dWtMZ292THlBZ0lPeWR0T3ljb0Nqc2k2VHN1S0VwT2lEcm9aenF0N2pzbmJqcmtKd2c3SU9CN1lPYzY2bTBJR0YxZEdodmNtbDZaU0JWVWt6c25iUWc2ck9uN0o2bElPeUt1ZXlkdUNEdG1aVHJxYlRzbkx6cm9ad2c2ckNBSU9xemhPeWdsZXlkaENEcnFyc2c2ck9nNjZXNDY0dWtMZ292THlBZ0lPdWhuT3EzdU95VmhPeWJnKzJWdENEc2hManNoWmpzbllRZzdLZUE3SnF3NjZtMElHRjFkR2h2Y21sNlplcXdnQ0JzYjJkcGJqOXpaV3hsWTNSQlkyTnZkVzUwUFhSeWRXVW82ck9FN0tDVklPeUVvTzJEblNucm9ad2c2ckNBSU91THBPdWx1Q0RxczRUc29KWHNuWVFnNnJPZzY2VzhJT3lJbUNEc25vanJpNlF1Q2k4dklDQWdWVkpNSU8yTWpPdWR2T3V2dU8yRXNDaHpaV3hsWTNSQlkyTnZkVzUwUFhSeWRXVXNJSEJ5YjIxd2REMXpaV3hsWTNSZllXTmpiM1Z1ZENucg0Kb1p6cmlwUWc2NkdjNnJlNDdKMjRJT3lEZ2UyRG5PdWx2Q0RycXJzZzY1cXI2NHFVSU9xeWcrdVBoQ0RzaTZUc3VLRWc3Wm1WN0oyNExnb3ZMeUJ0YjJSbFBTZHViM0p0WVd3bktPdW5qT3VqakNEc25xenJvWnpxdDdqc25iZ2c2NU94S1NEaWhwSWc2NkdjNnJlNDdKV0U3SnVESU95WGh1eWR0Q0RxdDdqcmc2VWc3SmV3NjR1a0tPdU1nT3F3bkNEcXNKbnNuWUFnNnJPRTdLQ1Y3SjIwNjUyOElPeUV1T3lGbUNEc25LRHNwNERxc0lBZzY0MlVJT3U1b091bWhDa3VDbU52Ym5OMElFTk1RVlZFUlY5TVQwZFBWVlJmVlZKTUlEMGdKMmgwZEhCek9pOHZZMnhoZFdSbExtRnBMMnh2WjI5MWRDYzdDbVoxYm1OMGFXOXVJSGR5YVhSbFFuSnZkM05sY2toaGJtUnNaWElvYlc5a1pTa2dld29nSUdOdmJuTjBJR3h2WjI5MWRDQTlJRzF2WkdVZ1BUMDlJQ2R6ZDJsMFkyZ25Pd29nSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQmpiMjV6ZENCamJXUWdQU0J3WVhSb0xtcHYNCmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV0p5YjNkelpYSXRKeUFySUcxdlpHVWdLeUFuTG1OdFpDY3BPd29nSUNBZ1kyOXVjM1FnY0hNZ1BTQnNiMmR2ZFhRS0lDQWdJQ0FnUHlBaVUzUmhjblF0VUhKdlkyVnpjeUFuSWlBcklFTk1RVlZFUlY5TVQwZFBWVlJmVlZKTUlDc2dJaWM3SUZOMFlYSjBMVk5zWldWd0lDMVRaV052Ym1SeklEUTdJRk4wWVhKMExWQnliMk5sYzNNZ0pHVnVkanBEUWw5VlVrd2lDaUFnSUNBZ0lEb2dKMU4wWVhKMExWQnliMk5sYzNNZ0pHVnVkanBEUWw5VlVrd25Pd29nSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloamJXUXNJQ2RBWldOb2J5QnZabVpjY2x4dWMyVjBJQ0pEUWw5VlVrdzlKWDR4SWx4eVhHNXdiM2RsY25Ob1pXeHNJQzFPYjFCeWIyWnBiR1VnTFVWNFpXTjFkR2x2YmxCdmJHbGplU0JDZVhCaGMzTWdMVU52YlcxaGJtUWdJaWNnS3lCd2N5QXJJQ2NpWEhKY2JpY3BPd29nSUNBZ2NtVjBkWEp1SUdOdFpEc0tJQ0I5Q2lBZ1kyOXVjM1FnDQpjMmdnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExXSnliM2R6WlhJdEp5QXJJRzF2WkdVZ0t5QW5Mbk5vSnlrN0NpQWdZMjl1YzNRZ1ltOWtlU0E5SUd4dloyOTFkQW9nSUNBZ1B5QW5JeUV2WW1sdUwzTm9YRzV2Y0dWdUlDSW5JQ3NnUTB4QlZVUkZYMHhQUjA5VlZGOVZVa3dnS3lBbklseHVjMnhsWlhBZ05GeHViM0JsYmlBaUpERWlYRzRuSUNBZ0x5OGc2NkdjNnJlNDdKV0U3SnVES095RXVPeUZtQ0RzcDREc200QXBJT0tHa2lBMDdMU0lJT3VTcENEcm9aenF0N2pzbmJnS0lDQWdJRG9nSnlNaEwySnBiaTl6YUZ4dWIzQmxiaUFpSkRFaVhHNG5Pd29nSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vYzJnc0lHSnZaSGtwT3dvZ0lHWnpMbU5vYlc5a1UzbHVZeWh6YUN3Z01HODNOVFVwT3dvZ0lISmxkSFZ5YmlCemFEc0tmUW9LTHk4ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1Q0R0bElUcm9aenNoTGpzaXFRZ0tHTnNZWFZrWlNCaGRYUm9JR3h2WjJsdQ0KSUMwdFkyeGhkV1JsWVdrcElPS0FsQ0F2YjNCbGJpMXNiMmRwYnV5ZHRDRHNnNTNzaExIQ3QrcTBnT3VtckM0S0x5OGc2N2lNNjUyODdKcXc3S0NBNnJDQUlHeHZZMkZzYUc5emRPdWhuQ0Rxc3JEcXM3enJwYndnNjdPMDY0SzA3S1NFSU91VmpPcTVqT3luZ0NEc2lLanNsclRzaEp3ZzY0eUE2cml3N1pXWTY0dWs2ckNBTENEc21ZVHJvNHpya0pqcnFiUWc3SXFrN0lxazY2R2NJT3VCbmV1Q25PdUxwQzRLYkdWMElHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0NteGxkQ0JzYjJkcGJsQnliMk5VYVcxbGNpQTlJRzUxYkd3N0NteGxkQ0JzYjJkcGJsTjBZWEowWldSQmRDQTlJREE3SUM4dklPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN0l1YzdKNlJJT3lMbk9xd2dTRGlnSlFnN0o2czdZRzA2NmF0N0oyMElDZnNucXpzaTV6cmo0UW43SjI0N0tlQUlDZnNucERyajVuc21ZVHJvNHdnN0l1azdZeW9KK3lkdU95bmdDRHF0YXpydG9UdGxaenJpNlFLWm5WdVkzUnBiMjRnYTJsc2JFeHZaMmx1VUhKdll5Z3ANCklIc0tJQ0JwWmlBb2JHOW5hVzVRY205alZHbHRaWElwSUhzZ1kyeGxZWEpVYVcxbGIzVjBLR3h2WjJsdVVISnZZMVJwYldWeUtUc2diRzluYVc1UWNtOWpWR2x0WlhJZ1BTQnVkV3hzT3lCOUNpQWdhV1lnS0NGc2IyZHBibEJ5YjJNcElISmxkSFZ5YmpzS0lDQmpiMjV6ZENCd0lEMGdiRzluYVc1UWNtOWpPd29nSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3Q2lBZ2RISjVJSHNLSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUhOd1lYZHVVM2x1WXlnbmRHRnphMnRwYkd3bkxDQmJKeTlRU1VRbkxDQlRkSEpwYm1jb2NDNXdhV1FwTENBbkwxUW5MQ0FuTDBZblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3Q2lBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNCMGNua2dleUJ3Y205alpYTnpMbXRwYkd3b0xYQXVjR2xrTENBblUwbEhWRVZTVFNjcE95QjlJR05oZEdOb0lDaGZaVElwSUhzZ2NDNXJhV3hzS0NrN0lIMEtJQ0FnSUgwS0lDQjlJR05oDQpkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRcDlDZ3BtZFc1amRHbHZiaUJyYVd4c1VISnZZeWdwSUhzS0lDQnBaaUFvY0hKdll5a2dld29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZDNhVzR6TWljcElIc0tJQ0FnSUNBZ0lDQXZMeUJ6YUdWc2JEcDBjblZsNjZHY0lPdWRoT3liak95RW5DQndjbTlqN0oyQUlHTnRaQ0RxdTQzcmpiRHF1TEFnNG9DVUlDOVU2NkdjSU8yS3VPdW1yT3ludUNEc283M3NsNnpzbGJ3ZzdLZUU3S2VjSUdOc1lYVmtaZXF3Z0NEcXM2RHNsWVRyb1p3ZzdKV0lJT3VDcU91S2xPdUxwQW9nSUNBZ0lDQWdJQzh2SUNqcXM2RHNsWVFnWTJ4aGRXUmw2ckNBSU95RXBPeTVtQ0R0akl6c25ienNuWVFnNjZ5ODZyT2dJT3llaU95Y3ZPdXB0Q0R0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3F3Z0NBaTdJS3M3SnFwSU95a2tTTHNuTHpyb1p3ZzY2ZUo3WjZZS1FvZ0lDQWdJQ0FnSUhOd1lYZHVVM2x1WXlnbg0KZEdGemEydHBiR3duTENCYkp5OVFTVVFuTENCVGRISnBibWNvY0hKdll5NXdhV1FwTENBbkwxUW5MQ0FuTDBZblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3Q2lBZ0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lDQWdMeThnYldGalQxTXY2NmFzNjRpRjdJcWtPaUJ6YUdWc2JEcDBjblZsNjUyOElIQnliMlBzbmJRZ2MyZ2c2cnVONjQydzZyaXc3SjI4SU95SW1DRHNub2pzbll3ZzRvQ1VJSE4wWVhKMFVISnZZK3lkbUNCa1pYUmhZMmhsWk91aG5DRHJwNHpyazZBS0lDQWdJQ0FnSUNBdkx5RHRsSVRyb1p6c2hManNpcVFnNnJlNDY2TzVLQzF3YVdRcDdKMkVJTzJHdGV5bnVPdWhuQ0Rzb0pYcnBxenRsWnpyaTZRZ0tIUmhjMnRyYVd4c0lDOVVJT3VNZ095ZGtTa0tJQ0FnSUNBZ0lDQjBjbmtnZXlCd2NtOWpaWE56TG10cGJHd29MWEJ5YjJNdWNHbGtMQ0FuVTBsSFZFVlNUU2NwT3lCOUlHTmhkR05vSUNoZlpUSXBJSHNnY0hKdll5NXJhV3hzS0NrN0lIMEtJQ0FnSUNBZ2ZRb2dJQ0FnZlNCallYUmoNCmFDQW9YMlVwSUhzZ0x5b2c2NnkwN0l1Y0lDb3ZJSDBLSUNCOUNpQWdjSEp2WXlBOUlHNTFiR3c3Q2lBZ2QyRnliV1ZrVlhBZ1BTQm1ZV3h6WlRzS0lDQnBaaUFvZDJGcGRHVnlLU0I3SUdOc1pXRnlWR2x0Wlc5MWRDaDNZV2wwWlhJdWRHbHRaWElwT3lCM1lXbDBaWEl1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkdENEc29vWHJvNHpya0pEc2xyVHNtcFF1SnlrcE95QjNZV2wwWlhJZ1BTQnVkV3hzT3lCOUNuMEtDbVoxYm1OMGFXOXVJSE4wWVhKMFVISnZZeWdwSUhzS0lDQnJhV3hzVUhKdll5Z3BPd29nSUd4cGJtVkNkV1lnUFNBbkp6c0tJQ0IwZFhKdWN5QTlJREE3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzaExqc2haZ2c3SXVjNjQrWklPeWtrZUtBcGlBbzY2cW82NDI0T2lBbklDc2dZM1Z5Y21WdWRFMXZaR1ZzSUNzZ0p5a25LVHNLSUNCamIyNXpkQ0IwYUdselVISnZZeUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiDQpKeTF3Snl3Z0p5MHRiVzlrWld3bkxDQmpkWEp5Wlc1MFRXOWtaV3dzSUNjdExXbHVjSFYwTFdadmNtMWhkQ2NzSUNkemRISmxZVzB0YW5OdmJpY3NJQ2N0TFc5MWRIQjFkQzFtYjNKdFlYUW5MQ0FuYzNSeVpXRnRMV3B6YjI0bkxDQW5MUzEyWlhKaWIzTmxKMTBzSUhzS0lDQWdJSE5vWld4c09pQjBjblZsTENCamQyUTZJRVZOVUZSWlgwTlhSQ3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdMQW9nSUNBZ1pHVjBZV05vWldRNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ0lUMDlJQ2QzYVc0ek1pY3NJQzh2SUZCUFUwbFlPaURzbnBEcXVMQWc3WlNFNjZHYzdJUzQ3SXFrSU9xM3VPdWp1U0RzZzUzc2hMRWc0b0NVSUd0cGJHeFFjbTlqN0oyMElPcTN1T3VqdWV5bnVDRHNvSlhycHF6dGxhQWc3SWlZSU95ZWlPcXlqQW9nSUgwcE93b2dJSEJ5YjJNZ1BTQjBhR2x6VUhKdll6c0tJQ0J3Y205akxuTjBaRzkxZEM1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0NpQWdJQ0JzYVc1bFFuVm1JQ3M5SUdRdWRHOVRkSEpwYm1jbw0KSjNWMFpqZ25LVHNLSUNBZ0lHeGxkQ0JwWkhnN0NpQWdJQ0IzYUdsc1pTQW9LR2xrZUNBOUlHeHBibVZDZFdZdWFXNWtaWGhQWmlnblhHNG5LU2tnSVQwOUlDMHhLU0I3Q2lBZ0lDQWdJR052Ym5OMElHeHBibVVnUFNCc2FXNWxRblZtTG5Oc2FXTmxLREFzSUdsa2VDa3VkSEpwYlNncE93b2dJQ0FnSUNCc2FXNWxRblZtSUQwZ2JHbHVaVUoxWmk1emJHbGpaU2hwWkhnZ0t5QXhLVHNLSUNBZ0lDQWdhV1lnS0NGc2FXNWxLU0JqYjI1MGFXNTFaVHNLSUNBZ0lDQWdiR1YwSUdWMklEMGdiblZzYkRzS0lDQWdJQ0FnZEhKNUlIc2daWFlnUFNCS1UwOU9MbkJoY25ObEtHeHBibVVwT3lCOUlHTmhkR05vSUNoZlpTa2dleUJqYjI1MGFXNTFaVHNnZlFvZ0lDQWdJQ0JwWmlBb1pYWWdKaVlnWlhZdWRIbHdaU0E5UFQwZ0ozSmxjM1ZzZENjZ0ppWWdkMkZwZEdWeUtTQjdDaUFnSUNBZ0lDQWdZMjl1YzNRZ2R5QTlJSGRoYVhSbGNqc0tJQ0FnSUNBZ0lDQjNZV2wwWlhJZ1BTQnVkV3hzT3dvZ0lDQWdJQ0FnSUdOc1pXRnkNClZHbHRaVzkxZENoM0xuUnBiV1Z5S1RzS0lDQWdJQ0FnSUNCcFppQW9aWFl1YVhOZlpYSnliM0lwSUhzS0lDQWdJQ0FnSUNBZ0lHTnZibk4wSUhKaGR5QTlJRk4wY21sdVp5aGxkaTV5WlhOMWJIUWdmSHdnWlhZdWMzVmlkSGx3WlNCOGZDQW5KeWt1YzJ4cFkyVW9NQ3dnTWpBd0tUc0tJQ0FnSUNBZ0lDQWdJR2xtSUNocGMwRjFkR2hGY25KdmNpaHlZWGNwS1NCN0NpQWdJQ0FnSUNBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJHOW5iM1YwSnpzZ0x5OGdMMmhsWVd4MGFPdWhuQ0R0bEl6cm42enF0N2pzbmJqc2w1QWc3SldNNjZhOElPS0draURyc29UdGlyenNuYlFnVyt1aG5PcTN1T3lkdUNEdGxZVHNtcFJkNjZHY0lPdXdsT3VBbkFvZ0lDQWdJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdUNEcnA0enJvNHdnNnJDUTdLZUFPaWNzSUhKaGR5azdDaUFnSUNBZ0lDQWdJQ0FnSUhjdWNtVnFaV04wS0c1bGR5QkZjbkp2DQpjaWhNVDBkSlRsOUhWVWxFUlNrcE93b2dJQ0FnSUNBZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ0lDQWdJQ0FnZHk1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0NmdGdiVHJvWnpyazV3ZzdKaWs2NldZT2lBbklDc2djbUYzS1NrN0NpQWdJQ0FnSUNBZ0lDQjlDaUFnSUNBZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZHZheWM3SUM4dklPeUVzZXF6dFNBOUlPeUVwT3k1bU1LMzY2R2M2cmU0N0oyNElPdUxwQ0Rzb0pYc2c0RWc0b0NVSU95V3RPdVdwQ0J3Y205aWJHVnQ3SjIwNjVPZ0lPMlZ0T3lnbkNBbzdKNnM2NkdjNnJlNDdKMjRMK3llck95RXBPeTVtQ0RyczdYcXQ0QXBDaUFnSUNBZ0lDQWdJQ0IzTG5KbGMyOXNkbVVvVTNSeWFXNW5LR1YyTG5KbGMzVnNkQ0I4ZkNBbkp5a3BPd29nSUNBZ0lDQWdJSDBLSUNBZ0lDQWdmUW9nSUNBZ2ZRb2dJSDBwT3dvZ0lIQnliMk11YzNSa1pYSnlMbTl1S0Nka1lYUmhKeXdnS0dRcElEMCtJSHNLSUNBZ0lHTnZibk4wSUhNZw0KUFNCa0xuUnZVM1J5YVc1bktDZDFkR1k0SnlrdWRISnBiU2dwT3dvZ0lDQWdhV1lnS0hNZ0ppWWdJWE11YVc1amJIVmtaWE1vSjBSbGNISmxZMkYwYVc5dVYyRnlibWx1WnljcEtTQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnWTJ4aGRXUmxJSE4wWkdWeWNqb25MQ0J6TG5Oc2FXTmxLREFzSURJd01Da3BPd29nSUgwcE93b2dJSEJ5YjJNdWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lDOHZJT3lkdE91dnVDRHNnNGdnN0lTNDdJV1k3Snk4NjZHY0lPcTFrT3l5dE91UW5DRHJrcVFnN0ppYklPeUV1T3lGbU95ZHRDRHJpNnZ0bm93ZzZyR3c2Nm0wSU91c3RPeUxuQ0FvNjZxbzY0MjRJT3lnaE8yWm1DRHNpNXdnN0lPSUlPeUV1T3lGbU95ZGhDRHNvNzNzbmJUc3A0QWc3SldLNnJLTUtRb2dJQ0FnYVdZZ0tIQnliMk1nSVQwOUlIUm9hWE5RY205aktTQnlaWFIxY200N0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPeUV1T3lGbUNEc29vWHINCm80d2dLR052WkdVZ0p5QXJJR052WkdVZ0t5QW5LU0RpZ0pRZzY0dWs3SjJNSU95YWxPeXlyU0RybFl3ZzY0dWs3SXVjSU95TG5PdVBtZTJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJR3RwYkd4UWNtOWpLQ2s3Q2lBZ2ZTazdDbjBLQ21aMWJtTjBhVzl1SUhObGJtUlVkWEp1S0hSbGVIUXBJSHNLSUNCeVpYUjFjbTRnYm1WM0lGQnliMjFwYzJVb0tISmxjMjlzZG1Vc0lISmxhbVZqZENrZ1BUNGdld29nSUNBZ2FXWWdLQ0Z3Y205aktTQnlaWFIxY200Z2NtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZHRDRHNsNGJzbHJUc21wUXVKeWtwT3dvZ0lDQWdhV1lnS0hkaGFYUmxjaWtnY21WMGRYSnVJSEpsYW1WamRDaHVaWGNnUlhKeWIzSW9KK3lWbnV5RW9DRHNtcFRzc3Ezc25iUWc3S2VFN1phSklPeWtrZXlkdE95WGtPeWFsQzRuS1NrN0NpQWdJQ0JqYjI1emRDQjBhVzFsY2lBOUlITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5DQphV1JuWlYwZzdZUzBJT3lMbk9xd2hDRHN0SWpxczd3ZzRvQ1VJT3lFdU95Rm1PeWRoQ0RzbnF6c2k1enNucEh0bGFucmk0anJpNlF1SnlrN0NpQWdJQ0FnSUd0cGJHeFFjbTlqS0NrN0NpQWdJQ0I5TENCVVZWSk9YMVJKVFVWUFZWUmZUVk1wT3dvZ0lDQWdkMkZwZEdWeUlEMGdleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIMDdDaUFnSUNCd2NtOWpMbk4wWkdsdUxuZHlhWFJsS0VwVFQwNHVjM1J5YVc1bmFXWjVLSHNnZEhsd1pUb2dKM1Z6WlhJbkxDQnRaWE56WVdkbE9pQjdJSEp2YkdVNklDZDFjMlZ5Snl3Z1kyOXVkR1Z1ZERvZ2RHVjRkQ0I5SUgwcElDc2dKMXh1Snl3Z0ozVjBaamduS1RzS0lDQjlLVHNLZlFvS0x5OGc2ckNaN0oyQUlPdXN1T3Exck91bHZDRHJxb2NnNjdLSTdLZTRJT3VzdSt1S2xPeW5nQ0RxdUxEc2xyVWc0b0NVSU95ZXJPeWFsT3l5cmV5ZHRPdXB0Q0FpN0oyMDdLQ0U2ck84SU91THBPdWx1Q0RzZzRnZzdLQ2M3SldJSXV5ZGhDRHNtcFRxdGF6dGxaenJpNlFLTHk4Zw0KS095VmlDRHF0N2pybjZ6cnFiUWc3WUcwNjZHYzY1T2M2ckNBSU95RXNleUxwTzJWbU9xeWpDRHFzSm5zbllBZzY0dTE3SjJFSU91WWtDRHJnclRzaEp3Z1cwRkpJT3kybE95eW5DRHJqWlFnNjdDYjZyaXdYZXF3Z0NEcnJMVHNuWmpycjdqdGxiVHNwNFRyaTZRcENtTnZibk4wSUdGemEyVmtRMjkxYm5RZ1BTQnVaWGNnVFdGd0tDazdDZ292THlEc2hManNoWmdnN0tTQTY3bUVLT3lMbk91UG1TdnNwNERzaTV6cnJMZ2c3S084N0o2RktldWx2Q0RyczdUc25xWHRsWndnNjVLa0lPMlZuQ0R0aExRZzdJdWs3WmFKSU9LQWxDRHJxcWpyazZBZzdaaTQ3TGFjN0oyQUlIRjFaWFZsNjZHY0lPeW5nZXVnck8yWmxDNEtMeThnYlc5a1pXenNuWVFnN0tPODY2bTBJT3EzdUNEcnFxanJqYmpyb1p3Z0tPdUxwT3VsdE91cHRDRHNoTGpzaFpnZzdKNnM3SXVjN0o2UktTNGc3WldjSU91cXFPdU51T3lkaENEcXM0VHNobzBnN0pPdzY2bTBJT3llck95TG5PeWVrZXlkZ0NEc3RaenN0SWdnTWUyYWpPdS9rQzRLWm5WdVkzUnANCmIyNGdjblZ1VkhWeWJpaGlkV2xzWkVGemF5d2diVzlrWld3cElIc0tJQ0JqYjI1emRDQnFiMklnUFNCeGRXVjFaUzUwYUdWdUtHRnplVzVqSUNncElEMCtJSHNLSUNBZ0lHbG1JQ2h0YjJSbGJDQW1KaUJCVEV4UFYwVkVYMDFQUkVWTVV5NXBibVJsZUU5bUtHMXZaR1ZzS1NBaFBUMGdMVEVnSmlZZ2JXOWtaV3dnSVQwOUlHTjFjbkpsYm5STmIyUmxiQ2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2cW82NDI0SU91emdPcXl2VG9nSnlBcklHTjFjbkpsYm5STmIyUmxiQ0FySUNjZzRvYVNJQ2NnS3lCdGIyUmxiQ2s3Q2lBZ0lDQWdJR04xY25KbGJuUk5iMlJsYkNBOUlHMXZaR1ZzT3dvZ0lDQWdJQ0J6ZEdGeWRGQnliMk1vS1RzZ0x5OGc3SU9JSU91cXFPdU51T3VobkNEc2hManNoWmdnN0o2czdJdWM3SjZSSUNqcmk2VHNuWXdnN0p1TTY3Q043SmVGN0plUTdJU2NJT3luZ095TG5PdXN1Q0RzbnF6c283enNub1VwQ2lBZ0lDQjlDaUFnSUNCcFppQW9kSFZ5Ym5NZ1BqMGdUVUZZDQpYMVJWVWs1VElIeDhJQ0Z3Y205aktTQnpkR0Z5ZEZCeWIyTW9LVHNLSUNBZ0lHbG1JQ2doZDJGeWJXVmtWWEFwSUhzS0lDQWdJQ0FnWTI5dWMzUWdkREFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhwYm5OMGNuVmpkR2x2YmsxbGMzTmhaMlVvS1NrN0NpQWdJQ0FnSUhkaGNtMWxaRlZ3SUQwZ2RISjFaVHNLSUNBZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFdU95Rm1DRHNwSURydVlRZzdKbUU2Nk9NSUNnbklDc2dLQ2hFWVhSbExtNXZkeWdwSUMwZ2REQXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLU0FySUNkektTRGlnSlFnN0oyMDdadUVJT3lhbE95eXJleWRnQ0RydWFqcm5ienNtcFF1SnlrN0NpQWdJQ0I5Q2lBZ0lDQjBkWEp1Y3lzck93b2dJQ0FnY21WMGRYSnVJSE5sYm1SVWRYSnVLR0oxYVd4a1FYTnJLQ2twT3dvZ0lIMHBPd29nSUM4dklPMlZuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WlcwNjQrRQ0KSU91THBPeWRqQ0RzbXBUc3NxM3NuYlFnN0oyMDdKYTA3S2VBNjQrRTY2R2RJTzJCa091S2xDRHRsYTNzZzRFZzdJU3g2ck8xN0p5ODY2R2NJT3lnbGV1bXJBb2dJSEYxWlhWbElEMGdhbTlpTG1OaGRHTm9LQ2dwSUQwK0lIdDlLVHNLSUNCeVpYUjFjbTRnYW05aU93cDlDZ292THlEcnJManF0YXdnN0xhVTdMS2NJTzJFdEFwbWRXNWpkR2x2YmlCaGMydERiR0YxWkdVb2RHVjRkQ3dnYlc5a1pXd3BJSHNLSUNCeVpYUjFjbTRnY25WdVZIVnliaWdvS1NBOVBpQjdDaUFnSUNCamIyNXpkQ0JoZEhSbGJYQjBJRDBnS0dGemEyVmtRMjkxYm5RdVoyVjBLSFJsZUhRcElIeDhJREFwSUNzZ01Uc0tJQ0FnSUdGemEyVmtRMjkxYm5RdWMyVjBLSFJsZUhRc0lHRjBkR1Z0Y0hRcE93b2dJQ0FnYVdZZ0tHRnphMlZrUTI5MWJuUXVjMmw2WlNBK0lESXdNQ2tnWVhOclpXUkRiM1Z1ZEM1amJHVmhjaWdwT3lBdkx5RHJyTFR0bFp6dG5vZ2c3SXlUN0oyMDdLZUFJT3lWaXVxeWpBb2dJQ0FnY21WMGRYSnVJR0YwZEdWdGNIUWcNClBpQXhDaUFnSUNBZ0lEOGdKK3F3bWV5ZGdDRHJyTGpxdGF6cnBid2c2NHVrN0l1Y0lPeWFsT3l5cmUyVm5PdUxwQzRnN0oyMElPeUV1T3lGbU95WGtPeUVuQ0RzbmJUc29JVHNsNUFnN0tDYzdKV0k3WmFJNjQyWUlPcXlnK3VUcE9xenZDRHFzcm5zdVpqc3A0QWc3SldLNjRxVUxDRHF0YXpzb2JEcmdwZ2c3SmEwN1p5WTZyQ0FJTzJabGV5THBPMmVpQ0RyaTZUcnBiZ2c3SU9JNjZHYzdKcTBJT3VNZ095VmlDQXo2ckNjNjZXOElPcTNuT3k1bWV1TWdPdWhuQ0JLVTA5T0lPdXdzT3lYdE91aG5PdW5qRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0hSbGVIUXBDaUFnSUNBZ0lEb2dKK3VMcE95ZGpDQlZTU0RyckxqcXRhenNuWmdnNjR5QTdKV0lJRFBxc0p6cnBid2c2cmVjN0xtWjY0eUE2NkdjSUVwVFQwNGc2N0N3N0plMDY2R2M2NmVNT2lBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb2RHVjRkQ2s3Q2lBZ2ZTd2diVzlrWld3cE93cDlDZ292THlEcnNvanNsNjBnN1lTMElPS0FsQ0Rxc0puc25ZQWc3SVM0DQo3SVdZN0oyRUlPeVRzT3VRbUN3ZzdKMjA2N0tJSU8yRXRPdW5qQ0RzdHBUc3Nwd2c3WmlWN0l1ZEtFcFRUMDRnNjdDdzdKZTBLU0RyaklEc2k2QWc2N0tJN0pldElPMllsZXlMblNoS1UwOU9JT3F3bmV5eXRDbnNuWVFnN0pxVTZyV3M3WldjNjR1a0NtWjFibU4wYVc5dUlHRnphMVJ5WVc1emJHRjBaU2gwWlhoMExDQnRiMlJsYkNrZ2V3b2dJSEpsZEhWeWJpQnlkVzVVZFhKdUtDZ3BJRDArSUNnS0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJT3V5aU95WHJTRHNucEhzbDRYc25iVHJpNlFnS091c3VPcTFyQ0RyaTZUcms2enF1TEFnN0pXRTY0dVlJT0tBbENEcmpJRHNsWWdnTStxd25DRHF0NXpzdVpuc25ZQWc3SjIwNjdLSUlPMkV0T3lYa0NEc29JSHNtcW50bFpqc3A0QWc3SldLNjRxVTY0dWtLUzRnSnlBckNpQWdJQ0FuNjR1azdKMk1JRlZKSU91c3VPcTFyT3F3Z0NEdGxaenF0YTNzbHJUcnFiUWc3SjZRN0pldzdJcWs2NStzN0pxMElPeVlnZXlXdE91aG5Dd2c3SmlCN0phMDY2bTBJT3lla095WA0Kc095S3BPdWZyT3lhdENEdGxaenF0YTNzbHJUcm9ad2c2N0tJN0pldDdaV1k2NTI4TGlBbklDc0tJQ0FnSUNkVlNTRHJyTGpxdGF6cmk2VHNtclFnNnJDRTZyS3c3WldjSU8yUm5PMlloT3lkaENEc2s3RHFzNkFzSU95ZHRPdW1oTUszN0lpcjdKNlF3cmZycDRqc2lxVHRncm5DdCsyVWpPdWdpT3lkdE95S3BPMlpnT3VObE91S2xDRHF0N2pyaklEcm9ad2c2N08wN0tHMDdaV2M2NHVrTGlBbklDc0tJQ0FnSUNmc201RHJyTGpzblpnZzdLU0VJT3lJbU91bHZDRHF0N2pyaklEcm9ad2c3SnlnN0tlQTdaV2M2NHVrSU9LQWxDRHNtNURyckxqc25iUWc3WldjSU95a2hPeWR0T3VwdENEcnNvanNsNjNyajRRZzdaV2NJT3lraE91aG5Dd2c3S1NFNjdDVTZyK0k3SjJFSU95ZWhPeWRtT3VobkNEc3RwVHFzSUR0bFpqc3A0QWc3SldLNjRxVTY0dWtMaUFuSUNzS0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzZyQ2Q3TEswSU8yVm1PdUNtT3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUwNCnBPeWF0TUszN0lTazY2cUZJT3E0aU95bmdEb2dKeUFyQ2lBZ0lDQW5leUowY21GdWMyeGhkR1ZrSWpvZ0l1dXlpT3lYcmV1c3VDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpWkdseVpXTjBhVzl1SWpvZ0ltdHY0b2FTWlc0ZzY1aVE2NHFVSUdWdTRvYVNhMjhpZlRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwQ2lBZ0tTd2diVzlrWld3cE93cDlDZ292THlEcnNvanNsNjBnN0oyUjY0dTE3SmVRN0lTY0lIdDBjbUZ1YzJ4aGRHVmtMQ0JrYVhKbFkzUnBiMjU5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlVjbUZ1YzJ4aGRHVW9jbUYzS1NCN0NpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3Q2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwDQpZMmdvTDF4N1cxeHpYRk5kS2x4OUx5azdDaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0J2SUQwZ1NsTlBUaTV3WVhKelpTaHpLVHNLSUNBZ0lHTnZibk4wSUhSeVlXNXpiR0YwWldRZ1BTQlRkSEpwYm1jb0tHOGdKaVlnYnk1MGNtRnVjMnhoZEdWa0tTQjhmQ0FuSnlrdWRISnBiU2dwT3dvZ0lDQWdhV1lnS0hSeVlXNXpiR0YwWldRcElISmxkSFZ5YmlCN0lIUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZiam9nVTNSeWFXNW5LQ2h2SUNZbUlHOHVaR2x5WldOMGFXOXVLU0I4ZkNBbkp5a3VkSEpwYlNncElIMDdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIMEtJQ0J5WlhSMWNtNGdiblZzYkRzS2ZRb0tMeThnN0oyUjY0dTE3SmVRN0lTY0lIdDBaWGgwTENCeVpXRnpiMjU5SU91d3NPeVh0Q0RzdHBUc3Rwd2dLT3k5bE91VG5PMk9uT3lLcE1LMzdKV2U2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3BDbVoxYm1OMGFXOXVJSEJoY25ObA0KVTNWbloyVnpkR2x2Ym5Nb2NtRjNLU0I3Q2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdDaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4YlcxeHpYRk5kS2x4ZEx5azdDaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPd29nSUhSeWVTQjdDaUFnSUNCamIyNXpkQ0JoY25JZ1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdhV1lnS0VGeWNtRjVMbWx6UVhKeVlYa29ZWEp5S1NrZ2V3b2dJQ0FnSUNCeVpYUjFjbTRnWVhKeUNpQWdJQ0FnSUNBZ0xtMWhjQ2dvZUNrZ1BUNGdLSHNnZEdWNGREb2dVM1J5YVc1bktDaDRJQ1ltSUhndWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd2djbVZoYzI5dU9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1eVpXRnpiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmU2twQ2lBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvZUNrZ1BUNGcNCmVDNTBaWGgwS1RzS0lDQWdJSDBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc2xZVHJucGpyb1p3Z0tpOGdmUW9nSUhKbGRIVnliaUJiWFRzS2ZRb0tMeThnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsQ0RzZzRIdGc1enNuYndnNjVXTUlDOW9aV0ZzZEdnZzdLR3c3WnFNNnJDQUlPeVlwT3VwdENEcmtxVHNsNURzaEp3ZzdKdU02N0NON0plRjdKMkVJT3VMcE95TG5DRHNpNXpyajRUdGxiVHJzN2pyaTZRZ0tETXc3TFNJN0plUUlESHJzb2pycDR3cExnb3ZMeURzaExIcXM3WHRsWmpycWJRZzZyS3c2ck84SU8yVnVPdVRwT3Vmck9xd2dDQmpiR0YxWkdWVGRHRjBkWE05SjI5ckordWhuQ0Rya0pqcmo0enJwcXpycjREcm9ad3NJT3llck91aG5PcTN1T3lkdUNEdG00UWc2N0tFN1lxODdKMjBJT3lnZ095Z2lPdWhuQ0R3bjUraTdKeTg2NkdjSU91enRlcTNnTzJWbk91THBDNEtMeThnS08yVWpPdWZyT3EzdU95ZHVPeWR0Q0Ryb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3lYc0NEcmtxUWc3S084NnJpdzdLQ0I3Snk4DQo2NkdjSUM5b1pXRnNkR2pycGJ3ZzdLR3c3WnFNN1pXWTY0cVVJT3F5ZytxenZDRHNwNTNzbllRZzdKMjA2Nk9zNjR1a0tRcHNaWFFnYkdGemRFRjFkR2hTWlhSeWVVRjBJRDBnTURzS1puVnVZM1JwYjI0Z2NtVjBjbmxCZFhSb1NXWk9aV1ZrWldRb0tTQjdDaUFnYVdZZ0tHTnNZWFZrWlZOMFlYUjFjeUFoUFQwZ0oyTnNZWFZrWlMxc2IyZHZkWFFuS1NCeVpYUjFjbTQ3Q2lBZ2FXWWdLSGRoYVhSbGNpQjhmQ0JFWVhSbExtNXZkeWdwSUMwZ2JHRnpkRUYxZEdoU1pYUnllVUYwSUR3Z016QXdNREFwSUhKbGRIVnlianNnTHk4ZzdLZUU3WmFKSU95a2tTRHRoTFFnNjdDcDdaVzBJT3E0aU95bmdDQXJJRE13N0xTSUlPcXdoT3F5cVFvZ0lHeGhjM1JCZFhSb1VtVjBjbmxCZENBOUlFUmhkR1V1Ym05M0tDazdDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHNucXp0bVpYc25iZ2c3SXVjNjQrRTRvQ21KeWs3Q2lBZ2NuVnVWSFZ5Ymlnb0tTQTlQaUFuNjZHYzZyZTQ3SjI0SU8yWg0KbGV5ZHVPeWFxZXlkdE91THBDNGdJazlMSXV1ZHZPcXpvT3VuakNEcmk3WHRsWmpybmJ3dUp5a3VkR2hsYmlnS0lDQWdJQ2dwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryb1p6cXQ3anNuYmdnN1ptVjdKMjQ2NUNvSU9LQWxDRHNvSlhzZzRFZzdJT0I3WU9jNjZHY0lPdXp0ZXEzZ0M0bktTd0tJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKV0U3S2VCSU91aG5PcTN1T3lkdUNEc2xZZ2c2NUNvT2ljc0lGTjBjbWx1WnlobExtMWxjM05oWjJVcExuTnNhV05sS0RBc0lEZ3dLU2tLSUNBcE93cDlDZ292THlEc2k2VHRqS2dnN0oyUjY0dTE3SjJFSU95Q3JPdWVqT3lhcVNEc2xZanJnclRyb1p3ZzY3T0E3Wm1ZSU9LQWxDRHNtNURzbmJnbzY2R2M2cmU0N0oyNEwreUVwT3k1bUNuc25iUWc3WXlNN0pXRjY1Q2NJT3F5dmV5YXNPeVhsQ0RxdDdnZzdKV0k2NEswNjZXOExDRHNsWVRyaTRqcnFiUWc3S0NSNjVHUTdKYTBLK3lia091c3VPeWRoQ0RyczdUcmdyanINCmk2UUtablZ1WTNScGIyNGdabkpwWlc1a2JIbEZjbkp2Y2lobExDQndjbVZtYVhncElIc0tJQ0JwWmlBb1pTQW1KaUJsTG0xbGMzTmhaMlVnUFQwOUlFeFBSMGxPWDBkVlNVUkZLU0J5WlhSMWNtNGdleUJsY25KdmNqb2dURTlIU1U1ZlIxVkpSRVVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0Ykc5bmIzVjBKeUI5T3dvZ0lHbG1JQ2hqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y3BJSHNLSUNBZ0lISmxkSFZ5YmlCN0lHVnljbTl5T2lBbjdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmxLR05zWVhWa1pTbnFzSUFnN0lTazdMbVk2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFFnNG9DVUlPeUVwT3k1bU8yVm1PcXpvQ0Ryb1p6cXQ3anNuYmp0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMaWNzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNnZlRzS0lDQjlDaUFnY21WMGRYSnVJSHNnWlhKeWIzSTZJSEJ5WldacGVDQXJJQ2hsDQpJQ1ltSUdVdWJXVnpjMkZuWlNBL0lHVXViV1Z6YzJGblpTQTZJRk4wY21sdVp5aGxLU2tnZlRzS2ZRb0tablZ1WTNScGIyNGdjbVZoWkVKdlpIa29jbVZ4S1NCN0NpQWdjbVYwZFhKdUlHNWxkeUJRY205dGFYTmxLQ2h5WlhOdmJIWmxLU0E5UGlCN0NpQWdJQ0JzWlhRZ1ltOWtlU0E5SUNjbk93b2dJQ0FnY21WeExtOXVLQ2RrWVhSaEp5d2dLR01wSUQwK0lIc2dZbTlrZVNBclBTQmpPeUI5S1RzS0lDQWdJSEpsY1M1dmJpZ25aVzVrSnl3Z0tDa2dQVDRnZXdvZ0lDQWdJQ0IwY25rZ2V5QnlaWE52YkhabEtFcFRUMDR1Y0dGeWMyVW9ZbTlrZVNrcE95QjlJR05oZEdOb0lDaGZaU2tnZXlCeVpYTnZiSFpsS0h0OUtUc2dmUW9nSUNBZ2ZTazdDaUFnZlNrN0NuMEtDbU52Ym5OMElFTlBVbE5mU0VWQlJFVlNVeUE5SUhzS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VDNKcFoybHVKem9nSnlvbkxBb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxTlpYUm9iMlJ6SnpvZ0owZEZWQ3dnVUU5VA0KVkN3Z1QxQlVTVTlPVXljc0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFVobFlXUmxjbk1uT2lBblEyOXVkR1Z1ZEMxVWVYQmxKeXdLZlRzS1puVnVZM1JwYjI0Z2FuTnZiaWh5WlhNc0lITjBZWFIxY3l3Z2IySnFLU0I3Q2lBZ2NtVnpMbmR5YVhSbFNHVmhaQ2h6ZEdGMGRYTXNJRTlpYW1WamRDNWhjM05wWjI0b2V5QW5RMjl1ZEdWdWRDMVVlWEJsSnpvZ0oyRndjR3hwWTJGMGFXOXVMMnB6YjI0N0lHTm9ZWEp6WlhROWRYUm1MVGduSUgwc0lFTlBVbE5mU0VWQlJFVlNVeWtwT3dvZ0lISmxjeTVsYm1Rb1NsTlBUaTV6ZEhKcGJtZHBabmtvYjJKcUtTazdDbjBLQ21OdmJuTjBJSE5sY25abGNpQTlJR2gwZEhBdVkzSmxZWFJsVTJWeWRtVnlLR0Z6ZVc1aklDaHlaWEVzSUhKbGN5a2dQVDRnZXdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5UMUJVU1U5T1V5Y3BJSHNnY21WekxuZHlhWFJsU0dWaFpDZ3lNRFFzSUVOUFVsTmZTRVZCUkVWU1V5azdJSEpsZEhWeWJpQnlaWE11Wlc1a0tDazcNCklIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjBkRlZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OW9aV0ZzZEdnbktTQjdDaUFnSUNCeVpYUnllVUYxZEdoSlprNWxaV1JsWkNncE95QXZMeURyb1p6cXQ3anNuYmdnN1pXRTdKcVVJT3lEZ2UyRG5PdXB0Q0RzbnF6dG1aWHNuYmdnN0l1YzY0K0VJT0tBbENEc25xenJvWnpxdDdqc25ianNuYlFnNjRHZDY0S3M3Snk4NjZtMElPdUxwT3lkakNEc29iRHRtb3pydG9EdGhMQWdjSEp2WW14bGJleWR0Q0R0a29EcnByRHJpNlFLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3Q2lBZ0lDQWdJRzlyT2lCMGNuVmxMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5MQ0IyT2lCQ1VrbEVSMFZmVml3Z1pHbHlPaUJmWDJScGNtNWhiV1VzSUM4dklIYkN0MlJwY2pvZzZyV3M2N0tFN0tDRUwreVhpZXVhc2UyVm5DRHNncXpyczdqc25iUWc2NWFnSU95ZWlPdUtsT3luZ0NEc3A0VHJpNmpzbXFrS0lDQWdJQ0FnYlc5a1pXdzZJR04xY25KbGJuUk5iMlJsDQpiQ3dnYlc5a1pXeHpPaUJCVEV4UFYwVkVYMDFQUkVWTVV5d2daWGhoYlhCc1pYTTZJRVZZUVUxUVRFVlRMbXhsYm1kMGFDd2djbVZoWkhrNklIZGhjbTFsWkZWd0xBb2dJQ0FnSUNCd2NtOWliR1Z0T2lBb1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBbmIyc25JSHg4SUdOc1lYVmtaVk4wWVhSMWN5QTlQVDBnYm5Wc2JDa2dQeUJ1ZFd4c0lEb2dZMnhoZFdSbFUzUmhkSFZ6TEFvZ0lDQWdJQ0JoWTJOdmRXNTBPaUJqYkdGMVpHVkJZMk52ZFc1MEtDa3NDaUFnSUNBZ0lITmxjblpsWkRvZ2MzUmhkSE11YzJWeWRtVmtMQ0JzWVhOMFFYUTZJSE4wWVhSekxteGhjM1JCZEN3Z2JHRnpkRlJsZUhRNklITjBZWFJ6TG14aGMzUlVaWGgwTENCc1lYTjBVMlZqT2lCemRHRjBjeTVzWVhOMFUyVmpMQW9nSUNBZ2ZTazdDaUFnZlFvZ0lDOHZJTzJVak91ZnJPcTN1T3lkdUNEc2k2enNucVhyc0pYcmo1a2c0b0NVSU91Qml1cTRzT3VwdENEc25JUWc2ckNRN0l1Y0lPMkRnT3lkdE91b3VPcXdnQ0RyaTZUcnBxenJwYndnNjRHSQ0KNjR1a0NpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyaGxZWEowWW1WaGRDY3BJSHNLSUNBZ0lHeGhjM1JDWldGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJSDBLSUNBdkx5RHJvWnpxdDdqc25iZ2c0b0NVSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGM0N0MXZ3bjVTUlhTRHJzb1R0aXJ6c25iUWc3Wmk0N0xhYzdaV2M2NHVrTGdvZ0lDOHZJT3E0c091enVDanJ1SXpybmJ6c21yRHNvSUFnN0tlQjdaYUpLVG9nWUdOc1lYVmtaU0JoZFhSb0lHeHZaMmx1SUMwdFkyeGhkV1JsWVdsZzY2VzhJT3lJcU95ZGdDRHRsSVRyb1p6c2hManNpcVRyb1p3ZzdJdWs3WmFKSU9LQWxDRHJxWlRyaWJRZzdKZUc3SjIwSU9xenAreWVwU0RydUl6cm5ienNtckRzb0lEcnBid2c3SmUwNnJPZ0xBb2cNCklDOHZJQ0FnYkc5allXeG9iM04wSU95SW1PeUxvQ0R0ajZ6dGlyanJvWndnNnJLdzZyTzg2Nlc4SU95ZWtPdVBtU0RzaUpqcm9MbnRsWnpyaTZRbzdJdWs3TGloT2lEdGw2VHJrNXpycHF6c2lxVHNsNURzaEp6cmo0UWc2N2lNNjUyODdKcXc3S0NBSU95WHRPdW12Q0FySUV4SlUxUkZUaUR0bVpYc25iZ3NJREl3TWpZdE1EY3BMZ29nSUM4dklDQWc3WVN3NjYrNDY0U1E3SjIwSU8yWmxPdXB0T3lYa0NEc29JVHRtSUFnN0pXSUlPdWNyT3VMcEM0ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1T3VuakNEdGxaanJxYlFnNjRHZExnb2dJQzh2SU8yUHRPdXdzU2p0aExEcnI3anJoSkFwT2lEc25wRHJqNWtnN0ptRTY2T002ckNBSU91bmllMmVqQ0R0bVpqcXNyMG82N2lNNjUyODdKcXc3S0NBNnJDQUlHeHZZMkZzYUc5emRPeVhrQ0RycXJzZzY0dS83SldFSU95OWxPdVRuT3F3Z0NEcnM3VHNuYlRyaXBRZzZySzk3SnF3S2V5WGtPeUVuQW9nSUM4dklDQWc2NkdjNnJlNDdKMjRJT3VNZ09xNHNDRHNwSkVnDQo2N0tFN1lxODdKMkVJT3VZa0NEcmlJVHJwYlRycWJRc0lPeTlsT3VUbk91bHZDRHJ0cG5zbDZ6cmhLUHNuWVFnN0lpWUlPeWVpT3VLbENEdGhMRHJyN2pyaEpBZzY3Q3A3SXVkN0p5ODY2R2NJT3lnaE8yWm1PMlZuT3VMcEM0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmIzQmxiaTFzYjJkcGJpY3BJSHNLSUNBZ0lHTnZibk4wSUdKdlpIa2dQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3dvZ0lDQWdZMjl1YzNRZ2MzZHBkR05vVFc5a1pTQTlJQ0VoS0dKdlpIa2dKaVlnWW05a2VTNXpkMmwwWTJoQlkyTnZkVzUwS1RzZ0x5OGc2ck9FN0tDVklPeWdoTzJabUNBOUlPeUxuTzJCck91bXZ5RHNzTDNzbkx6cm9ad2c3SmUwN0phMElPcXpoT3lnbGV5ZGhDRHFzNkRycGJ3ZzdJaVlJT3llaU9xeWpBb2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ0x5OGc3S2VFN1phSklPeWtrZXlkdU91TnNDRHJtSkFnNjRpTTY2Q0E2NHVrSU9LQWxDRHF1SWpyc0trbw0KTmpEc3RJZ2c2NEswS1NEcmk2VHNpNXdnNjRpRTY2VzRJT3F4dENBaTdMQzk3SjJFSU91THEreVZtT3VMcEMvcnFyc2c2N1NrNjR1a0l1eVhrQ0Rxc0lEcXVZenNtckRycjREcm9ad2c2N2lNNjUyODdKcXc3S0NBNjZHY0lPeWVyT3lMbk91UGhPMlZuT3VMcEM0S0lDQWdJQ0FnTHk4ZzdaV2M3TEM0SU91U3BPeVhrT3VQaENEcm1KQWc2NGlFNjZXMDY0cVVJT3F4dENEcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wSU95OW5PdXdzZXlYa0NEcnFyc2c2NHUvN0pXRUlPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzdKV0lJT3VRbU91S2xDRHRtWmpxc3Izc25id2c3SWlZSU95ZWlPeWN2T3VMaUFvZ0lDQWdJQ0F2THlEcXQ3anJsWXpycDR3ZzdMMlU2NU9jNjZXOElPdTJtZXlYck91RW8reWRoQ0RzaUpnZzdKNkk2NHFVSU8yRXNPdXZ1T3VFa0NEcnNLbnNpNTNzbkx6cm9ad2c3WSswNjdDeDdaV2M2NHVrSUNqcmtaQWc2N0tJN0tlNElPMkJ0T3VtcmV5WGtDRHRoTERycjdqcmhKRHNuYlFnN1lxQTdKYTANCjY0S1k3SmlrNjZtMElPdUx1ZTJacWV5S3BPdWZ2ZXVMcENrdUNpQWdJQ0FnSUdOdmJuTjBJSE4wWVd4bElEMGdiRzluYVc1UWNtOWpJQ1ltSUNoRVlYUmxMbTV2ZHlncElDMGdiRzluYVc1VGRHRnlkR1ZrUVhRZ1BpQTJNREF3TUNrN0NpQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdKaVlnYzNSaGJHVXBJSHNLSUNBZ0lDQWdJQ0JyYVd4c1RHOW5hVzVRY205aktDazdDaUFnSUNBZ0lDQWdhV1lnS0NGdmNHVnVURzluYVc1VVpYSnRhVzVoYkNncEtTQjdDaUFnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TVN3Z2V5Qmxjbkp2Y2pvZ0oreWR0Q0JQVSt5WGtPeUVvQ0RzbnBEcmo1bnNuTHpyb1p3ZzY2cTdJT3lYdE95V3RPeWFsQ0RpZ0pRZzdZU3c2Nis0NjRTUTdKZVE3SVNjSUdOc1lYVmtaU0RzaTZUdGxva2c3WnVFSUM5c2IyZHBiaUR0bGJRZzdLTzg3SVM0N0pxVUxpY2dmU2s3Q2lBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0FnSUd0cGJHeFFjbTlqS0NrN0NpQWdJQ0FnSUNBZ1lXTmpiM1Z1DQpkRU5oWTJobExtRjBJRDBnTURzS0lDQWdJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJTzJQdE91d3NTRGlnSlFnN1lTdzY2KzQ2NFNRSU91d3FleUxuZXljdk91aG5DRHNvSVR0bVpndUp5azdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHMXZaR1U2SUNkMFpYSnRhVzVoYkNjZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2EybHNiRXh2WjJsdVVISnZZeWdwT3lBdkx5RHNsWjdzaEtBZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1T3lkdENEcmpJRHF1TEFnN0tTUjdKMjA2Nm0wSU95Z2tlcXpvQ0RzZzRqcm9ad2c3SmV3NjR1a0lDanNzTDNzbllRZzY0dXI3SldZNnJHdzY0S1lJT3VMcE95TG5DRHJpSVRycGJnZzZySzk3SnF3S1FvZ0lDQWdJQ0JzYjJkcGJsTjBZWEowWldSQmRDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQWdJQzh2SUVKU1QxZFRSVkxycGJ3ZzdKcXc2NmFzSU8yVnVPdVRwT3Vmck91aA0KbkNEc3A0RHNvSlVnNG9DVUlFTk1TZXF3Z0NEcnVJenJuYnpzbXJEc29JRHJwYndnN0tlQjdLQ1JJT3lYdE95bmdDRHNsWXJxczZBZ1ZWSk02NmVNSU91RW1PcXlxT3lrZ091THBDNEtJQ0FnSUNBZ0x5OGc3Wlc0NjVPazY1K3M2ckNBSU95THBPMk1xTzJWbU9xeHNPdUNtQ0JEVEVucXNJQWdRbEpQVjFORlV1dWx2Q0RyckxUc2k1enRsYlRyajRRZ1EweEo2ckNBSU95VmpPeVZoT3lFbkNEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lYdE91dmdPdWhuQ0Ryb1p6cXQ3anNuYmpzbllBZzY1Q2M2NHVrS0daaGFXd3RjMjltZENrdUNpQWdJQ0FnSUdOdmJuTjBJR3h2WjJsdVJXNTJJRDBnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnUTB4QlZVUkZYMFZPVml3Z2V5QkNVazlYVTBWU09pQjNjbWwwWlVKeWIzZHpaWEpJWVc1a2JHVnlLSE4zYVhSamFFMXZaR1VnUHlBbmMzZHBkR05vSnlBNklDZHViM0p0WVd3bktTQjlLVHNLSUNBZ0lDQWdZMjl1YzNRZ2RHaHBjMHh2WjJsdUlEMGdjM0JoZDI0b0oyTnMNCllYVmtaU2NzSUZzbllYVjBhQ2NzSUNkc2IyZHBiaWNzSUNjdExXTnNZWFZrWldGcEoxMHNJSHNLSUNBZ0lDQWdJQ0J6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJzYjJkcGJrVnVkaXdnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0IzYVc1a2IzZHpTR2xrWlRvZ2RISjFaU3dLSUNBZ0lDQWdJQ0JrWlhSaFkyaGxaRG9nY0hKdlkyVnpjeTV3YkdGMFptOXliU0FoUFQwZ0ozZHBiak15Snl3Z0x5OGdhMmxzYkV4dloybHVVSEp2WSt5ZG1DRHF0N2pybzdrZ2EybHNiT3lhcVNBb2EybHNiRkJ5YjJQcXM3d2c2NCtaN0oyOElPMk1xTzJFdENrS0lDQWdJQ0FnZlNrN0NpQWdJQ0FnSUd4dloybHVVSEp2WXlBOUlIUm9hWE5NYjJkcGJqc0tJQ0FnSUNBZ2RHaHBjMHh2WjJsdUxtOXVLQ2RsY25KdmNpY3NJQ2dwSUQwK0lIc2dhV1lnS0d4dloybHVVSEp2WXlBOVBUMGdkR2hwYzB4dloybHVLU0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPeUI5S1RzS0lDQWdJQ0FnZEdocGMweHZaMmx1TG05dUtDZGpiRzl6WlNjc0lDaGpiMlJsDQpLU0E5UGlCN0NpQWdJQ0FnSUNBZ2FXWWdLR3h2WjJsdVVISnZZeUFoUFQwZ2RHaHBjMHh2WjJsdUtTQnlaWFIxY200N0NpQWdJQ0FnSUNBZ2JHOW5hVzVRY205aklEMGdiblZzYkRzS0lDQWdJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpWR2x0WlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0d4dloybHVVSEp2WTFScGJXVnlLVHNnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J1ZFd4c095QjlDaUFnSUNBZ0lDQWdZV05qYjNWdWRFTmhZMmhsTG1GMElEMGdNRHNnTHk4ZzdJT0lJT3F6aE95Z2xleWR2Q0RzaUpnZzdKNkk3Snk4NjR1SUlPdUxwT3lkakNBdmFHVmhiSFJvSU91VmpDRHJpNlRzaTV3ZzdKMjk2cml3Q2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN0tDSTdMQ29JT3lpaGV1ampDQW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BKeWs3Q2lBZ0lDQWdJSDBwT3dvZ0lDQWdJQ0JzYjJkcGJsQnliMk5VYVcxbGNpQTlJSE5sZEZScA0KYldWdmRYUW9LQ2tnUFQ0Z2V5QmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SURFdzY3YUVJT3F5dmVxenZDRGlnSlFnNjR5QTZyaXdJTzJVaE91aG5PeUV1T3lLcENEc29KWHJwcXd1SnlrN0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ2ZTd2dOakF3TURBd0tUc0tJQ0FnSUNBZ0x5OGc2NEtoN0oyQUlPeWVoZXllcGVxMmpPeWRoQ0Ryckx6cXM2QWc3SjZJNjRxVUlPdU1nT3E0c0NEc2hManNoWmpzbllBZzY3S0U2NmF3NjR1a0lPS0FsQ0RzbnF6cm9aenF0N2pzbmJnZzdadUVJT3VMcE95ZGpDRHNtcFRzc3Ezc25iUWc3SU9JSU95RXVPeUZtQ2pzZzRnZzdKNkY3SjZsNnJhTUtleWN2T3VobkNEc2k1enNucEh0bFpqcXNvd0tJQ0FnSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJnZzdJdWM3SjZSSnlBcklDaHoNCmQybDBZMmhOYjJSbElEOGdKeUFvNnJPRTdLQ1ZJT3lnaE8yWm1DRGlnSlFnN0l1YzdZR3M2NmEvSU95d3ZTa25JRG9nSnljcElDc2dKeURpZ0pRZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95ZWtPdVBtU0RzbDdEcXNyRHJrS25yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQnRiMlJsT2lCemQybDBZMmhOYjJSbElEOGdKMkp5YjNkelpYSXRjM2RwZEdOb0p5QTZJQ2RpY205M2MyVnlKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2daWEp5YjNJNklDZnJvWnpxdDdqc25iZ2c3TEM5N0oyRUlPdXF1eURzbDdUc2w0anNsclRzbXBRNklDY2dLeUJsTG0xbGMzTmhaMlVnZlNrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SUNqdGhMRHJyN2pyaEpBZzdZKzA2N0N4SU9xMXJPMlloT3UyZ0NEaWdKUWc2N2lNNjUyODdKcXc3S0NBSU95ZWtPdVBtU0RzbVlUcm80enFzSUFnDQo3SldJSU91UW1PdUtsQ0R0bVpqcXNyMGc3S0NFN0pxcEtRb2dJR1oxYm1OMGFXOXVJRzl3Wlc1TWIyZHBibFJsY20xcGJtRnNLQ2tnZXdvZ0lDQWdld29nSUNBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSE4wWVhKMDZyQ0FJT3lEaUNEc3ZaanNocFFnN0xDOTdKMkVJT3Vuak91VG9PdUxwQ0FvNjR1azY2YXM3SjJZSU95SXFPeWRnQ0Rzdlpqc2hwVHFzN3dnNjZ5MDZyU0E3WldZNnJLTUlPeUNyT3lhcWV5ZWtPeVhrT3F5akNEcnM3VHNub1FwTGdvZ0lDQWdJQ0FnSUM4dklPeWR0T3lXdE95RW5DQlFiM2RsY2xOb1pXeHNLQzV3Y3pFcDdKMjBJRFhzdElnZzY1S2tJT3EzdUNEc3NMM3NsNUFnN0plVTdZU3c2Nlc4SU91enRPdUN0Q0F4NjdLSUtPcTFyT3VQaFNEcXM0VHNvSlVwN0oyRUlPeWVrT3VQbVNEc2hLRHRnNTN0bFpqcXM2QXNDaUFnSUNBZ0lDQWdMeThnN0xDOTdKMkVJT3kxbk95R2pPMlpsTzJWdENEc2dxenNtcW5zbnBBZw0KNjRpSTdKZVVJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqcnA0d2c2NEtvNnJLTUlPMlZuT3VMcEM0ZzdMQzk3SjJFSU91cXV5RHNzTDdzbkx6cnFiUWc3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHRsWnpyaTZRS0lDQWdJQ0FnSUNBdkx5QW82NHVrNjZXNElPeXd2U0RzbUtUc25vWHJvS1VnNjdDcDdLZUFJT0tBbENEcXQ3Z2c2cks5N0pxd0lPdXBsT3VKdE9xd2dDRHJzN1RzbmJUcmlwUWc3TEdFNjZHY0lPdUNxT3F6b0NEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFxQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdLTzg3SjJZT2lCamJHRjFaR1hxc0lBZzdMMlk3SWFVSU95Z25PdXFxZXlkaENEcnNKVHF2cmpycWJRZ1FYQndRV04wYVhaaGRHVXZSbWx1WkZkcGJtUnZkK3F3Z0NEcnFyc2c3TEMrN0oyRUlPeUltQ0Rzbm9qc25Zd2c0b0NVSU95Y2lPdVBoT3lhc0NEc2k2VHF1TERzbDVEc2hKd2c3Wm1WN0oyNElPMlZoT3lhbEM0S0lDQWdJQ0FnSUNCamIyNXoNCmRDQndjekVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExXeHZaMmx1TG5Cek1TY3BPd29nSUNBZ0lDQWdJR1p6TG5keWFYUmxSbWxzWlZONWJtTW9jSE14TENCYkNpQWdJQ0FnSUNBZ0lDQW5VM1JoY25RdFUyeGxaWEFnTFZObFkyOXVaSE1nTlNjc0NpQWdJQ0FnSUNBZ0lDQW5KSGR6SUQwZ1RtVjNMVTlpYW1WamRDQXRRMjl0VDJKcVpXTjBJRmRUWTNKcGNIUXVVMmhsYkd3bkxBb2dJQ0FnSUNBZ0lDQWdJbWxtSUNna2QzTXVRWEJ3UVdOMGFYWmhkR1VvSjJOc1lYVmtaUzFzYjJkcGJpY3BLU0I3SWl3S0lDQWdJQ0FnSUNBZ0lDSWdJQ1IzY3k1VFpXNWtTMlY1Y3lnbmZpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lGTjBZWEowTFZOc1pXVndJQzFUWldOdmJtUnpJREluTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdRV1JrTFZSNWNHVWdMVTVoYldWemNHRmpaU0JWSUMxT1lXMWxJRmNnTFUxbGJXSmxja1JsWm1sdWFYUnBiMjRnSjF0RWJHeEpiWEJ2Y25Rb1hDSjFjMlZ5DQpNekl1Wkd4c1hDSXBYU0J3ZFdKc2FXTWdjM1JoZEdsaklHVjRkR1Z5YmlCVGVYTjBaVzB1U1c1MFVIUnlJRVpwYm1SWGFXNWtiM2NvYzNSeWFXNW5JR01zSUhOMGNtbHVaeUIwS1RzZ1cwUnNiRWx0Y0c5eWRDaGNJblZ6WlhJek1pNWtiR3hjSWlsZElIQjFZbXhwWXlCemRHRjBhV01nWlhoMFpYSnVJR0p2YjJ3Z1UyaHZkMWRwYm1SdmR5aFRlWE4wWlcwdVNXNTBVSFJ5SUdnc0lHbHVkQ0J1S1Rzbklpd0tJQ0FnSUNBZ0lDQWdJQ0lnSUNSb0lEMGdXMVV1VjEwNk9rWnBibVJYYVc1a2IzY29XMDUxYkd4VGRISnBibWRkT2pwV1lXeDFaU3dnSjJOc1lYVmtaUzFzYjJkcGJpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lHbG1JQ2drYUNBdGJtVWdXMU41YzNSbGJTNUpiblJRZEhKZE9qcGFaWEp2S1NCN0lGdDJiMmxrWFZ0VkxsZGRPanBUYUc5M1YybHVaRzkzS0NSb0xDQTJLU0I5Snl3Z0x5OGdOaUE5SUZOWFgwMUpUa2xOU1ZwRkNpQWdJQ0FnSUNBZ0lDQW5mU2NzQ2lBZ0lDQWdJQ0FnWFM1cWIybHVLQ2RjY2x4dQ0KSnlrZ0t5QW5YSEpjYmljcE93b2dJQ0FnSUNBZ0lHTnZibk4wSUdKaGRDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ykc5bmFXNHVZbUYwSnlrN0NpQWdJQ0FnSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloaVlYUXNJQ2RBWldOb2J5QnZabVpjY2x4dUp5QXJDaUFnSUNBZ0lDQWdJQ0FuYzNSaGNuUWdJbU5zWVhWa1pTMXNiMmRwYmlJZ1kyMWtJQzlySUdOc1lYVmtaU0F2Ykc5bmFXNWNjbHh1SnlBckNpQWdJQ0FnSUNBZ0lDQW5jRzkzWlhKemFHVnNiQ0F0VG05UWNtOW1hV3hsSUMxRmVHVmpkWFJwYjI1UWIyeHBZM2tnUW5sd1lYTnpJQzFHYVd4bElDSW5JQ3NnY0hNeElDc2dKeUpjY2x4dUp5azdDaUFnSUNBZ0lDQWdjM0JoZDI0b0oyTnRaQ2NzSUZzbkwyTW5MQ0JpWVhSZExDQjdJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2djM1JrYVc4NklDZHBaMjV2Y21VbkxDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNLSUNBZ0lDQWdmU0JsYkhObElHbG0NCklDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXdvZ0lDQWdJQ0FnSUM4dklIQjBlU2hsZUhCbFkzUXA2NkdjSU91enRPdUN1Q0R0Z3FUc2w1QWc3WUcwNjZHYzY1T2NJRlJWU2Vxd2dDRHJyTFRyc0pqc25aSHNuYmdnNnJLRDdKMjBJT3lMcE95NG9TRHRtWlhzbmJqcmtLZ29NakF5Tmkwd055d2c3SjI4NjdDWUlGeHl3cmRyYVhSMGVTRHN2WlRyazV3ZzY2cW82NUdRS1NEaWdKUUtJQ0FnSUNBZ0lDQXZMeURzbktEc25ienRsWndnN0o2UTY0K1o3Wm1VSU9xeXZldWhuT3VLbENCVGVYTjBaVzBnUlhabGJuUno3SjJZSU95bmhPeW5uQ0R0Z3FRZzdKNkY2NkNsTGlEc29KSHF0N3pzaExFZzZyYU03WldjN0oyMElPeWVpT3ljdk91cHRDQTI3TFNJSU91U3BDRHNsNVR0aExEcXNJQWc3SjZRNjQrWklPeWVoZXVncGV1UHZBb2dJQ0FnSUNBZ0lDOHZJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbmJRZzdJU2c3WU9kNjVDWTZyT2dMQ0RxdG96dGxaenNuYlFnN0plRzdKeTg2Nm0wDQpJR3RsZVhOMGNtOXJaU0RzcElUcnA0d2c3S0d3N0pxcDdaNklJT3lMcE8yTXFPMlZ0Q0RzZ3F6c21xbnNucERxc0lBZzdKZVU3WVN3SU8yVm5DRHJzb2dnNjRpRTY2VzA2Nm0wSU91UW5PdUxwQ2htWVdsc0xYTnZablFwTGdvZ0lDQWdJQ0FnSUM4dklPeVhsTzJFc0NEc3A0SHNvSVRzbDVBZ1ZHVnliV2x1WVd6c25ZUWc2NHVrN0l1Y0lPeVZudXljdk91aG5DRHFzSURzb0xqc21ZQWc2NHVrNjZXNElPeVZzZXlYa0NEdGdxVHFzSUFnNjVPazdKYTA2ckNBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpQWdJQ0FnSUNBZ2MzQmhkMjRvSjI5ellYTmpjbWx3ZENjc0lGc0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWkc4Z2MyTnlhWEIwSUNKamJHRjFaR1VnTDJ4dloybHVJaWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHRmpkR2wyWVhSbEp5d0tJQ0FnSUNBZw0KSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0EySnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdZV04wYVhaaGRHVW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlEQXVNeWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVTNsemRHVnRJRVYyWlc1MGN5SWdkRzhnYTJWNWMzUnliMnRsSUhKbGRIVnliaWNzQ2lBZ0lDQWdJQ0FnSUNBdkx5RHNsNVR0aExEcXNJQWc3SXVrN0tDYzY2R2NJT3VUcE95V3RPcXdoQ0Rxc3Izc21yRHNsNURycDR3ZzdKZXM2cml3SU91UGhPdUxyQ2pxdG96dGxad2c3SmVHN0p5ODY2bTBJT3ljaE95WGtPeUVuQ0RzcEpIcmk2Z3BJT0tBbENEdGhMRHJyN2pyaEpEc25ZUWc3TG1ZN0p1TUlPdTRqT3Vkdk95YXNPeWdnT3VuakNEcmdxanF1TFRyaTZRS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0F4TGpVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmwNCmJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QnpaWFFnYldsdWFXRjBkWEpwZW1Wa0lHOW1JR1p5YjI1MElIZHBibVJ2ZHlCMGJ5QjBjblZsSnl3S0lDQWdJQ0FnSUNCZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNLSUNBZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z1ptRnNjMlU3SUM4dklPeW5nT3lia0NEc2xZZ2c3WldZNjRxVUlFOVRDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2NtVjBkWEp1SUhSeWRXVTdDaUFnSUNCOUNpQWdmUW9nSUM4dklPeWVrT3E0c0NEc29vWHJvNHdnNG9DVUlPMkJ0T3Vobk91VG5PdUxwT3VtckMzcmdZVHF1TEF1WW1GMDdKMjBJTzJZdU95Mm5PMlZuT3VMcENBbzY2R2M3THVzN0plUTdJU2M2NmVNSU95Z2tlcTN2Q0Rxc0lEcmlxWHRsWmpyaTRnZzdKV0k3S0NFS1FvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5emFIVjBaRzkzYmljcElIc0tJQ0FnSUdwemIyNG9jbVZ6DQpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tLRjY2T01JT3lhbE95eXJTRHJzSnZzbll3ZzRvQ1VJT3VMcE91bXJPdWx2Q0RyZ1pYcmk0anJpNlF1SnlrN0NpQWdJQ0JyYVd4c1VISnZZeWdwT3dvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrc0lESXdNQ2s3Q2lBZ0lDQnlaWFIxY200N0NpQWdmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl5WldOdmJXMWxibVFuS1NCN0NpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ2FXWWdLQ0YwWlhoMElIeDhJQ0ZUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKK3kybE95eW5PdXdtK3lkaENEcnJManF0YXpxc0lBZzY3bUU3SmEwSU95ZQ0KaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdMYVU3TEtjSU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnl3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NtRjNJRDBnWVhkaGFYUWdZWE5yUTJ4aGRXUmxLRk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2tzSUcxdlpHVnNLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MzVm5aMlZ6ZEdsdmJuTWdQU0J3WVhKelpWTjFaMmRsYzNScGIyNXpLSEpoZHlrN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnoNCmRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElIc0tJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5TTdJdXhJT3lMcE8yTXFDQW9KeUFySUhObFl5QXJJQ2R6S1RvbkxDQlRkSEpwYm1jb2NtRjNLUzV6YkdsalpTZ3dMQ0F5TURBcEtUc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c2xZZ2dKeUFySUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBcklDZnFzSndnS0NjZ0t5QnpaV01nS3lBbmN5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3dvZ0lDQWdJQ0J6DQpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0F6TUNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJSE4xWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUNmdGdiVHJvWnpyazV3ZzdaaTQ3TGFjSU95THBPMk1xRG9nSnlrcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlEcnNvanNsNjBnNG9DVUlPMlZuT3ExcmV5V3RDRGlocFFnN0ppQjdKYTBJT3lla091UG1TQW83TGFVN0xLYzZyTzhJT3F3bWV5ZGdDRHNoTGpzaFpnZzdJS3M3SnFwS1FvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOQ0KUFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkwY21GdWMyeGhkR1VuS1NCN0NpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ2FXWWdLQ0YwWlhoMElIeDhJQ0ZUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKK3V5aU95WHJlMlZvQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnlrN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCamIyNXpkQ0J5WVhjZ1BTQmhkMkZwZENCaGMydFVjbUZ1YzJ4aGRHVW8NClUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTd2diVzlrWld3cE93b2dJQ0FnSUNCamIyNXpkQ0J2ZFhRZ1BTQndZWEp6WlZSeVlXNXpiR0YwWlNoeVlYY3BPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0R0akl6c2k3RWc3SXVrN1l5b0lDZ25JQ3NnYzJWaklDc2dKM01wT2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJREl3TUNrcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzblpIcmk3WHNuWVFnN1pXMDdJU2Q3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzDQpsNjBnN0ptRTY2T01JQ2duSUNzZ2MyVmpJQ3NnSjNNc0lDY2dLeUFvYjNWMExtUnBjbVZqZEdsdmJpQjhmQ0FuUHljcElDc2dKeWtuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWgwWlhoMEtTNXpiR2xqWlNnd0xDQXpNQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lIUnlZVzV6YkdGMFpXUTZJRzkxZEM1MGNtRnVjMnhoZEdWa0xDQmthWEpsWTNScGIyNDZJRzkxZEM1a2FYSmxZM1JwYjI0c0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjZ2ZTazdDaUFnSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryc29qc2w2MGc3SXVrN1l5bw0KT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0JtY21sbGJtUnNlVVZ5Y205eUtHVXNJQ2Z0Z2JUcm9aenJrNXdnNjdLSTdKZXRJT3lMcE8yTXFEb2dKeWtwT3dvZ0lDQWdmUW9nSUgwS0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdOQ3dnZXlCbGNuSnZjam9nSjA1dmRDQm1iM1Z1WkNjZ2ZTazdDbjBwT3dvS0x5OGc3SjIwNjYrNElPdUxwT3Vtck9xd2dDRHJscUFnN0o2STY0cVU2NDJ3SU91WWtDRHN2SnpxdUxEcXNJQWc2NU9rN0phMDdKaWs2Nm0wS095Z25PeUtwT3l5bUNEc25wRHJqNWtnN0x5YzZyaXdJT3lra2V1enRTRHJrN0VwSU95aHNPeWFxZTJlaUNEc29vWHJvNHdnNG9DVUlPdVBqT3VObUNEcmk2VHJwcXpyaXBRZzZyZTQ2NHlBNjZHY0lPeWNvT3luZ0FwelpYSjJaWEl1YjI0b0oyVnljbTl5Snl3Z0tHVXBJRDArSUhzS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2V3b2dJQ0FnWTI5dWMyOXMNClpTNXNiMmNvSjF0aWNtbGtaMlZkSU95ZHRPdXZ1Q0Rzdkp6c29MZ2c3SjZJN0phMDdKcVVLTzJQck8yS3VDQW5JQ3NnVUU5U1ZDQXJJQ2NnN0lLczdKcXBJT3lra1NrZzRvQ1VJT3lkdENEc25ianNpcVR0aExUc2lxVHJpcFFnN0tLRjY2T003WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdjSEp2WTJWemN5NWxlR2wwS0RBcE93b2dJSDBLSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SVNjNjdLRUlPeVlwT3VsbURvbkxDQmxJQ1ltSUdVdWJXVnpjMkZuWlNrN0NpQWdjSEp2WTJWemN5NWxlR2wwS0RFcE93cDlLVHNLTHk4ZzdKYTA2NWFrSU9xeXZldWhuT3VobkNEc283M3JrNkFvN0l1czdKNmw2N0NWNjQrWklPdUJpdXE1Z0N3Z1EzUnliQ3RETENBdmMyaDFkR1J2ZDI0c0lPeVlwT3VsbUNrZ1kyeGhkV1JsSU95ZWtPeUxuZXlkaENEcmdxanF1TERzcDRBZzdKV0s2NHFVNjR1a0NuQnliMk5sYzNNdWIyNG9KMlY0YVhRbkxDQW9LU0E5UGlCN0lHdHBiR3hRY205aktDazdJR3RwYkd4TWIyZHBibEJ5DQpiMk1vS1RzZ2ZTazdDbkJ5YjJObGMzTXViMjRvSjFOSlIwbE9WQ2NzSUNncElEMCtJSEJ5YjJObGMzTXVaWGhwZENnd0tTazdDbkJ5YjJObGMzTXViMjRvSjFOSlIxUkZVazBuTENBb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3BPd29LYzJWeWRtVnlMbXhwYzNSbGJpaFFUMUpVTENBbk1USTNMakF1TUM0eEp5d2dLQ2tnUFQ0Z2V3b2dJR052Ym5OdmJHVXViRzluS0NmaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQW5LVHNLSUNCamIyNXpiMnhsTG14dlp5Z25JTzJCdE91aG5PdVRuQ0RyaTZUcnBxd2c3THljN0tlUUlPS0FsQ0JvZEhSd09pOHZiRzlqWVd4b2IzTjBPaWNnS3lCUVQxSlVLVHNLSUNCamIyNXpiMnhsTG14dg0KWnlnbklPdXFxT3VOdURvZ0p5QXJJRU5NUVZWRVJWOU5UMFJGVENBcklDY2d3cmNnN0ppSTdJdWNJQ2NnS3lCRldFRk5VRXhGVXk1c1pXNW5kR2dnS3lBbjZyRzBJT3llcGV5d3FTY3BPd29nSUdOdmJuTnZiR1V1Ykc5bktDY2c3SjIwSU95d3ZleWRoQ0Rzdkp6cmtaUWc2NCtaN0pXSUlPMlV2T3EzdU91bmlDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdZRzA2NkdjNjVPYzY2R2NJT3kybE95eW5PMlZxZXVMaU91THBDNG5LVHNLSUNCamIyNXpiMnhsTG14dlp5Z240cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBSnlrN0NpQWdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1RzZ0x5OGdRMnhoZFdSbElFTnZaR1VnN0lLczdKcXANCklPcXdnT3VLcFNEc2w2enJ0b0FnN0tDUTZyS0FJQ2p0bEl6cm42enF0N2pzbmJnZzdKV0k2NEswN0pxcEtRb2dJQzh2SU91dnVPdW1yQ0RzaTV6cmo1a2dLeURzcDREc2k1enJyTGdnN0tPODdKNkZJT0tBbENEc3Nxc2c3TGFVN0xLYzY3YUE3WVN3SU91NW9PdWx0T3F5akFvZ0lHRnphME5zWVhWa1pTZ243SnVNNjdDTjdKZUZPaUFpN0tDQTdKNmxJT3VRbU95WGlPeUt0ZXVMaU91THBDSW5LUzUwYUdWdUtBb2dJQ0FnS0NrZ1BUNGdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95YmpPdXdqZXlYaFNEc21ZVHJvNHdnNG9DVUlPeTJsT3l5bkNEc3BJRHJ1WVFnNjRHZExpY3BMQW9nSUNBZ0tHVXBJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNtNHpyc0kzc2w0VWc3SXVrN1l5b0lDanNzcXNnN0pxVTdMS3RJT3VWakNEc25xenNpNXpyajRRcE9pY3NJR1V1YldWemMyRm5aU2tLSUNBcE93cDlLVHNLDQo6OkVYQU1QTEVTOjoNCkl5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzDQpwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydA0KbGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWENCmxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVDQo3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TA0Kbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXkNCmhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVDQo3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3Zw0KN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVcNCnRPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWDQptT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIcw0KbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0kNCjdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnDQo3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvag0KSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVANCm1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyDQpvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8ySw0KdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVYNCmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyDQppNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Qw0KdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXcNCmdDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzDQpuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRQ0KN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHMNCm5JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhDQpsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMA0KSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzMNCjZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzDQppSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEcw0KaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGcNCjdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhDQpxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqcw0KbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjANCklPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVoDQpuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMA0KN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTANCjY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RyDQpwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZw0KNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXcNCnZ1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLDQpMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZw0KN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHINCnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVDQpQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aA0KbkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0NCjo6TEFVTkNIRVI6Og0KLy80bkFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCQ0FISUFhUUJrQUdjQVpRQWdBR3dBWVFCMUFHNEFZd0JvQUdVQWNnQWdBQlFnSUFEb3NzU3N4THdnQUNUQkZjZ2dBQkRJZ0t3Z0FNVFdJQURrc3F5NUlBRGt3b25WQ2dBbkFDQUFZd0JzQUdFQWRRQmtBR1VBWWdCeUFHa0FaQUJuQUdVQU9nQXZBQzhBSUFBRTFWeTRvTkZjejNUSElBQjB4eUFBRE5OOHgwVEhJQUNBdlhpNTVMSWdBQ2dBOGJSZHVEb0FJQUIwMEZ5NDNMVGtzcXk1TFFEUXhuVFFyYm53eGJDc0xnQjJBR0lBY3dBcEFDNEFDZ0FuQUNBQVZMc0FyQ0FBWUw0NHlDQUFpTWM4eDNTNklBQmMxU0FBaUx6UXhTQUFXTldZc0NuRklBQkl4YlN3V05YZ3JDd0FJQURrc2lBQUFNbEV2aGkwZExvZ0FPU3lyTGw4dVNBQVBjd2dBTWJGZE1jZ0FPVENpZFZjMWVTeUxnQUtBRk1BWlFCMEFDQUFaZ0J6QUc4QUlBQTlBQ0FBUXdCeUFHVUFZUUIwQUdVQVR3QmlBR29BWlFCakFIUUFLQUFpQUZNQVl3QnlBR2tBY0FCMEFHa0FiZ0JuQUM0QVJnQnBBR3dBWlFCVEFIa0ENCmN3QjBBR1VBYlFCUEFHSUFhZ0JsQUdNQWRBQWlBQ2tBQ2dCVEFHVUFkQUFnQUhNQWFBQWdBRDBBSUFCREFISUFaUUJoQUhRQVpRQlBBR0lBYWdCbEFHTUFkQUFvQUNJQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZNQWFBQmxBR3dBYkFBaUFDa0FDZ0JrQUdrQWNnQWdBRDBBSUFCbUFITUFid0F1QUVjQVpRQjBBRkFBWVFCeUFHVUFiZ0IwQUVZQWJ3QnNBR1FBWlFCeUFFNEFZUUJ0QUdVQUtBQlhBRk1BWXdCeUFHa0FjQUIwQUM0QVV3QmpBSElBYVFCd0FIUUFSZ0IxQUd3QWJBQk9BR0VBYlFCbEFDa0FDZ0J6QUdnQUxnQkRBSFVBY2dCeUFHVUFiZ0IwQUVRQWFRQnlBR1VBWXdCMEFHOEFjZ0I1QUNBQVBRQWdBR1FBYVFCeUFBb0FDZ0FuQUNBQU1RQXZBRElBS1FBZ0FFNEFid0JrQUdVQUxnQnFBSE1BSUFBUXlJQ3NJQUFVSUNBQXhzVTh4M1M2SUFEa3NyVEdYTGpjdENBQW1OTjB4OERKZkxrZ0FQVEZ0TVVBeWVTeUNnQkpBR1lBSUFCekFHZ0FMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQUlBQjNBR2dBDQpaUUJ5QUdVQUlBQnVBRzhBWkFCbEFDSUFMQUFnQURBQUxBQWdBRlFBY2dCMUFHVUFLUUFnQUR3QVBnQWdBREFBSUFCVUFHZ0FaUUJ1QUFvQUlBQWdBRWtBWmdBZ0FFMEFjd0JuQUVJQWJ3QjRBQ2dBSWdCT0FHOEFaQUJsQUM0QWFnQnpBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0JiQUZYV2VNZGRBRVRISUFBRXNuUzVkTG9nQU9TeXRNWmN1TnkwSUFDWTAzVEh3TWtBckNBQTlNVzl1Y2l5NUxJdUFDQUFKTUZZem55NUlBREl1VnpPSUFDa3RDd0FJQUFNMWV5MytLMTR4OURGSE1FZ0FIVFFYTGpjdENBQWhMeTgwa1RISUFEa3N0ekNJQUFNc3V5M0lBRDh5RGpCbE1ZdUFDSUFMQUFnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFCMkFHSUFUd0JMQUVNQVlRQnVBR01BWlFCc0FDQUFLd0FnQUhZQQ0KWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BREVBTHdBeUFDa0FJQUFVSUNBQVRnQnZBR1FBWlFBdUFHb0Fjd0FpQUNrQUlBQTlBQ0FBZGdCaUFFOEFTd0FnQUZRQWFBQmxBRzRBQ2dBZ0FDQUFJQUFnQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JvQUhRQWRBQndBSE1BT2dBdkFDOEFiZ0J2QUdRQVpRQnFBSE1BTGdCdkFISUFad0F2QUdzQWJ3QXZBR1FBYndCM0FHNEFiQUJ2QUdFQVpBQWlBQW9BSUFBZ0FFVUFiZ0JrQUNBQVNRQm1BQW9BSUFBZ0FGY0FVd0JqQUhJQWFRQndBSFFBTGdCUkFIVUFhUUIwQUFvQVJRQnVBR1FBSUFCSkFHWUFDZ0FLQUNjQUlBQXlBQzhBTWdBcEFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNBQUVNaUFyQ0FBRkNBZ0FNYkZQTWQwdWlBQUpNRll6cmNBWExqNHJYakhJQUFwdkpXOFJNY2dBRWpGdExCYzFlU3lDZ0JKQUdZQUlBQnpBR2dBTGdCU0FIVUFiZ0FvQUNJQVl3QnRBR1FBSUFBdkFHTUENCklBQjNBR2dBWlFCeUFHVUFJQUJqQUd3QVlRQjFBR1FBWlFBaUFDd0FJQUF3QUN3QUlBQlVBSElBZFFCbEFDa0FJQUE4QUQ0QUlBQXdBQ0FBVkFCb0FHVUFiZ0FLQUNBQUlBQk5BSE1BWndCQ0FHOEFlQUFnQUNJQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpQUFLQUFRdHBTeUlBQlFBRUVBVkFCSUFOREZJQURHeGJURmxNWXBBQzRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQXcwZmk3RUxIUXhSekJJQUJFeFppM2ZMa2dBQ1RCV002M0FGeTQrSzE0eDF6VklBQ2t0Q3dBSUFCMDBGeTQzTFFnQUlTOHZOSkV4eUFBNUxMY3dpQUFETExzdHlBQS9NZzR3WlRHT2dBaUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUFKZ0FnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWlBQ0FBDQpJQUJ1QUhBQWJRQWdBR2tBYmdCekFIUUFZUUJzQUd3QUlBQXRBR2NBSUFCQUFHRUFiZ0IwQUdnQWNnQnZBSEFBYVFCakFDMEFZUUJwQUM4QVl3QnNBR0VBZFFCa0FHVUFMUUJqQUc4QVpBQmxBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUlBQWdBR01BYkFCaEFIVUFaQUJsQUNBQWJBQnZBR2NBYVFCdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBVmRaNHh5QUFLYnlWdkRvQUlBQXcwZmk3RUxIUXhSekJJQUJqQUd3QVlRQjFBR1FBWlFBZ0FDMEFMUUIyQUdVQWNnQnpBR2tBYndCdUFDQUFkTWNnQUlTOEJNaEV4eUFBbk0wbHVGalZkTG9nQUFESlJMNGdBRVRHekxpRng4aXk1TEl1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFLQUNzd0tuRw0KeWJkQXh5QUFkTWNnQUZBQVF3RFF4U0FBWExqNHJYakhITFFnQUhUUVhMamN0Q0FBYkszRnN5QUFYTlhFczlERkhNRWdBQ2pNRUt3cHRNaXk1TEl1QUNrQUlnQXNBQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FIWUFZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FESUFMd0F5QUNrQUlBQVVJQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDSUFDZ0FnQUNBQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZFQWRRQnBBSFFBQ2dCRkFHNEFaQUFnQUVrQVpnQUtBQW9BSndBZ0FBREpSTDRnQUVUR3pMZ2dBQlFnSUFEa3NxeTVmTGtnQUQzTUlBREd4WFRISUFEa3dvblZJQUFvQUF6VjdMZjRyWGpIZE1jZ0FPZXNJQUNReDlteklBQVFyTURKS1FBS0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCakFHMEFaQUFnQUM4QVl3QWdBRzRBYndCa0FHVUFJQUJ6QUdNQWNnQnBBSEFBZEFCekFGd0FZd0JzQUdFQWRRQmtBR1VBTFFCaUFISUENCmFRQmtBR2NBWlFBdUFHb0Fjd0FpQUN3QUlBQXdBQ3dBSUFCR0FHRUFiQUJ6QUdVQUNnQT0NCjo6V0FUQ0hFUjo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rxc0pEc2k1enNucEFnNG9DVUlPMlZyZXlEZ1NEcmxxQWc3SjZJNjRxVUlPeTBpT3lHak8yWWxTRHNoSnpyc29RZ0tHeHZZMkZzYUc5emREb3hNVGc0T1NrS0x5OGc0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBQ2k4dklPeVpuQ0R0bFlUc21wVHRsWnpxc0lBNklPMlV2T3EzdU91bmlPcXdnQ0R0bEl6cm42enF0N2pzbmJqc25aZ2dZMnhoZFdSbFluSnBaR2RsT2k4dklPeVh0T3E0c0NoM2FXNWtiM2N1YjNCbGJpOXBabkpoYldVdmIzQmxia1Y0ZEdWeWJtRnNLZXVsdkFvdg0KTHlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293S0x5OGdVRTlUVkNBdmQyRnJaU0RycGJ3ZzY3TzA2NEswNjZtMElPcXdrT3lMbk95ZWtPcXdnQ0RyaTZUcnBxd29ZMnhoZFdSbExXSnlhV1JuWlM1cWN5bnJwYndnNjR5QTdJdWdJT3k4b091THBDNEtMeThLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQW92THlEcnFaVHJxcWpycHF3Z2ZqRTFUVUxybmJ3ZzY2R2M2cmU0N0oyNElPeUxuQ0RzbnBEcmo1a2c3SXVjN0o2UjdKeTg2NkdjSU95RGdleUwNCm5DRHN2Snpya2F6cmo0UWc2N2FBNjR1MElPeVhodXVMcENBbzY1T3g2NkdkT2lCdWNHMGdjblZ1SUdKMWFXeGtLUzRLTHk4ZzY0dWs2NmFzNjRxVUlPeUxyT3llcGV1d2xldVBtU0RyZ1lycXVMRHJxYlFnN0tPOTdLZUE2NmVNS08yVWpPdWZyT3EzdU95ZHVPcXp2Q0RzZzUzc2dxd2c2NCtaNnJpdzdabVVLU3dnNnJDUTdJdWM3SjZRNjRxVUlPcXpoT3lHalNEcmdxanNsWVFnNjR1azdKMk1JT3E1cU95YXNPcTRzT3VsdkNEcnNKdnJpcFRyaTZRdUNncGpiMjV6ZENCb2RIUndJRDBnY21WeGRXbHlaU2duYUhSMGNDY3BPd3BqYjI1emRDQndZWFJvSUQwZ2NtVnhkV2x5WlNnbmNHRjBhQ2NwT3dwamIyNXpkQ0JtY3lBOUlISmxjWFZwY21Vb0oyWnpKeWs3Q21OdmJuTjBJRzl6SUQwZ2NtVnhkV2x5WlNnbmIzTW5LVHNLWTI5dWMzUWdleUJ6Y0dGM2Jpd2djM0JoZDI1VGVXNWpJSDBnUFNCeVpYRjFhWEpsS0NkamFHbHNaRjl3Y205alpYTnpKeWs3Q2dwamIyNXpkQ0JRVDFKVUlEMGdNVEU0T0RrN0NtTnZibk4wDQpJRkpQVDFRZ1BTQndZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bktUc2dMeThnN0tDQTdKNmw3SWFNSU91anFPMkt1Q0RpZ0pRZzY0dWs2NmFzNnJDQUlISmxZMjl0YldWdVpDMWxlR0Z0Y0d4bGN5NXRaT3VsdkNEc3NMN3JpcFFnNnJpdzdLU0FDZ3BqYjI1emRDQkRUMUpUWDBoRlFVUkZVbE1nUFNCN0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFU5eWFXZHBiaWM2SUNjcUp5d0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFRXVjBhRzlrY3ljNklDZEhSVlFzSUZCUFUxUXNJRTlRVkVsUFRsTW5MQW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MUlaV0ZrWlhKekp6b2dKME52Ym5SbGJuUXRWSGx3WlNjc0NuMDdDbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3b2dJSEpsY3k1M2NtbDBaVWhsWVdRb2MzUmhkSFZ6TENCUFltcGxZM1F1WVhOemFXZHVLSHNnSjBOdmJuUmxiblF0Vkhsd1pTYzZJQ2RoY0hCc2FXTmhkR2x2Ymk5cQ0KYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzS0lDQnlaWE11Wlc1a0tFcFRUMDR1YzNSeWFXNW5hV1o1S0c5aWFpa3BPd3A5Q2dvdkx5QmpiR0YxWkdVZ1EweEo2ckNBSU95ZWlPdUtsT3luZ0NEaWdKUWc3SmVHN0p5ODY2bTBJQzkzWVd0bElPeWRrZXVMdGV5WGtDRHNpNlRzbHJRZzdaU002NStzNnJlNDdKMjQ3SjIwSU95VmlPdUN0TzJWb0NEc2lKZ2c3SjZJNnJLTUlPMlZuT3VMcEFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzRLTHk4ZzdZeU03SjI4N0oyMElPMkJ0Q0RzaUpnZzdKNkk3SmEwSURNdzdMU0lJT3k2a095TG5DNGc3SjZzNjZHYzZyZTQ3SjI0N1pXWTY2bTANCklFTk1TZXF3Z0NEdGpJenNuYnpzbllRZzZyQ3g3SXVnN1pXWTY2K0E2NkdjSU95ZWtPdVBtU0Ryc0pqc21JSHJrSnpyaTZRdUNteGxkQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lBd0xDQmxiV0ZwYkRvZ2JuVnNiQ0I5T3dwbWRXNWpkR2x2YmlCamJHRjFaR1ZCWTJOdmRXNTBLQ2tnZXdvZ0lHbG1JQ2hFWVhSbExtNXZkeWdwSUMwZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUR3Z016QXdNREFwSUhKbGRIVnliaUJoWTJOdmRXNTBRMkZqYUdVdVpXMWhhV3c3Q2lBZ2JHVjBJR1Z0WVdsc0lEMGdiblZzYkRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2FpQTlJRXBUVDA0dWNHRnljMlVvWm5NdWNtVmhaRVpwYkdWVGVXNWpLSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDY3VZMnhoZFdSbExtcHpiMjRuS1N3Z0ozVjBaamduS1NrN0NpQWdJQ0JsYldGcGJDQTlJQ2hxSUNZbUlHb3ViMkYxZEdoQlkyTnZkVzUwSUNZbUlHb3ViMkYxZEdoQlkyTnZkVzUwTG1WdFlXbHNRV1JrY21WemN5a2dmSHdnDQpiblZzYkRzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJvWnpxdDdqc25iZ2c3SjIwNjZDbElPeVhodXlkakNEcms3RWc0b0NVSUc1MWJHd2dLaThnZlFvZ0lHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJRVJoZEdVdWJtOTNLQ2tzSUdWdFlXbHNJSDA3Q2lBZ2NtVjBkWEp1SUdWdFlXbHNPd3A5Q2dwbWRXNWpkR2x2YmlCb1lYTkRiR0YxWkdVb0tTQjdDaUFnWTI5dWMzUWdabWx1WkdWeUlEMGdjSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeUEvSUNkM2FHVnlaU2NnT2lBbmQyaHBZMmduT3dvZ0lIUnllU0I3SUhKbGRIVnliaUJ6Y0dGM2JsTjVibU1vWm1sdVpHVnlMQ0JiSjJOc1lYVmtaU2RkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2MyaGxiR3c2SUhSeWRXVWdmU2t1YzNSaGRIVnpJRDA5UFNBd095QjlJR05oZEdOb0lDaGZaU2tnZXlCeVpYUjFjbTRnWm1Gc2MyVTdJSDBLZlFvS2JHVjBJSGRoYTJsdVp5QTlJR1poYkhObE95QXZMeURzbDdEdGc0QWc2N0NwN0tlQQ0KSU9LQWxDRHJpNlRycHF6cmlwUWc3SmEwN0xDbzdaUzhJRVZCUkVSU1NVNVZVMFhyb1p3ZzdLU1I2N08xSU95Z2xldW1yTzJWbU95bmdPdW5qQ0R0bElUcm9aenNoTGpzaXFRZzY0S3Q2N21FNjZXOElPeWtoT3lkdU91THBBcG1kVzVqZEdsdmJpQjNZV3RsUW5KcFpHZGxLQ2tnZXdvZ0lHbG1JQ2gzWVd0cGJtY3BJSEpsZEhWeWJqc0tJQ0IzWVd0cGJtY2dQU0IwY25WbE93b2dJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdleUIzWVd0cGJtY2dQU0JtWVd4elpUc2dmU3dnTlRBd01DazdDaUFnYkdWMElIQnliMk03Q2lBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzS0lDQWdJQzh2SUZkcGJtUnZkM002SUdOdFpNSzNkbUp6SU9xeXZleWNvQ0RzbDRic25iUWdibTlrWmV1bHZDRHNwNEhzb0pFc0lIZHBibVJ2ZDNOSWFXUmxLRU5TUlVGVVJWOU9UMTlYU1U1RVQxY3A2NkdjSU95S3BPMlBzQ0RpZ0pRS0lDQWdJQzh2SU95d3ZTRHNsNGJyaXBRZzdJaW83SjJBSU95OW1PeUcNCmxPeWR0Q0RycDR6cms2VHNsclRzcDREcXM2QWc2NHVrNjZhczdKMllJT3lla095TG5TaGpiR0YxWkdVcDY0K0VJT3EzdUNEc3ZaanNocFRzbllRZzY2eTg2NkNrNjdDYjdKV0VJT3lXdE91V3BDRHNzTDNyajRRZzdKV0lJT3Vjck91THBDNEtJQ0FnSUM4dklHUmxkR0ZqYUdWazY0cVVJT3lUc095bmdDRHNsWXJyaXBUcmk2UW9aR1YwWVdOb1pXUXJkMmx1Wkc5M2MwaHBaR1VnN0tHdzdaV3A3SjJBSU95OW1PeUdsQ0Rzc0wzc25iUWc2NFc0N0xhYzY1Q29JT0tBbENEc2k2VHN1S0VwTGdvZ0lDQWdMeThnVjJsdVpHOTNjK3lYa095RW9DQmtaWFJoWTJobFpDRHNsNGJzbmJUcmo0UWc2N2FBNjZxb0tPcXdrT3lMbk95ZWtDbnFzSUFnN0tPOTdKYTA2NCtFSU95ZWtPeUxuZXlkZ0NEc2dyVHNsWVRyZ3FqcmlwVHJpNlF1Q2lBZ0lDQndjbTlqSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3DQpDaUFnSUNBZ0lHTjNaRG9nVWs5UFZDd2djM1JrYVc4NklDZHBaMjV2Y21VbkxDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTd0tJQ0FnSUgwcE93b2dJSDBnWld4elpTQjdDaUFnSUNBdkx5QnRZV05QVXkvcnBxenJpSVhzaXFRNklPcXdrT3lMbk95ZWtPdWx2Q0RybllUc21yUWdibTlrWlNEc2k2VHRsb2tnN1l5TTdKMjg2NkdjSU95bmdleWdrU0RzaXFUdGo3QWdLR3hoZFc1amFHUWc3Wm1ZNnJLOTdKZVVJRkJCVkVqcXNJQWc2N21JN0pXOTdaV2dJT3lJbUNEc25vanNsclFnN0tDSTY0eUE2cks5NjZHY0lPeUNyT3lhcVNrS0lDQWdJSEJ5YjJNZ1BTQnpjR0YzYmlod2NtOWpaWE56TG1WNFpXTlFZWFJvTENCYmNHRjBhQzVxYjJsdUtGOWZaR2x5Ym1GdFpTd2dKMk5zWVhWa1pTMWljbWxrWjJVdWFuTW5LVjBzSUhzS0lDQWdJQ0FnWTNka09pQlNUMDlVTENCa1pYUmhZMmhsWkRvZ2RISjFaU3dnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQW9nSUNBZ2ZTazdDaUFnZlFvZ0lIQnliMk11ZFc1eVpXWW9LVHNnTHk4Zw0KNnJDUTdJdWM3SjZRSU95ZHRPdXlwTzJLdUNEcm82anRsSVRzbDVEc2hKd2c2N2FFNjZhc0lDanFzSkRzaTV6c25wQWc3S0tGNjZPTTY2VzhJT3VuaWV5bmdDRHNsWXJxc293cENuMEtDbU52Ym5OMElITmxjblpsY2lBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtDaHlaWEVzSUhKbGN5a2dQVDRnZXdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5UMUJVU1U5T1V5Y3BJSHNnY21WekxuZHlhWFJsU0dWaFpDZ3lNRFFzSUVOUFVsTmZTRVZCUkVWU1V5azdJSEpsZEhWeWJpQnlaWE11Wlc1a0tDazdJSDBLSUNCcFppQW9jbVZ4TG5WeWJDQTlQVDBnSnk5b1pXRnNkR2duS1NCN0NpQWdJQ0F2THlCMk9pRHFzSkRzaTV6c25wQWc3TDJVNjVPY0lPdXloT3lnaENEaWdKUWc2cldzNjdLRTdLQ0VJTzJVaE91aG5PeUV1T3lLcE9xd2dDRHFzNFRzaG8wZzY0K002ck9nSU95ZWlPdUtsT3luZ0NEcnNKYnNsNURzaEp3ZzdabVY3SjI0N1pXWTY0cVVJT3lhcWV1UGhBb2dJQ0FnTHk4Z0tIWXlJRDBnN0xDOUlPeUkNCnFPcTVnQ0RzaUpqc29KWHRqSkFzSUhZeklEMGdMMkZqWTI5MWJuUWc3TGFVNnJDQTdZeVFLUW9nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUhkaGRHTm9aWEk2SUhSeWRXVXNJSFk2SURNZ2ZTazdDaUFnZlFvZ0lDOHZJT3lkdENCUVEreVhrQ0Ryb1p6cXQ3anNuYmpya0p3ZzdZRzA2NkdjNjVPY0lPcXpoT3lnbFNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SU95eXF5RHRtWlRycWJUQ3QrMlppT3lkdENBaTY0aUU2cldzSU9xemhPeWdsZXljdk91aG5DRHNrN0RyaXBUc3A0QWlJT3V6dE95WHJPeWp2T3VLbENEcmpiQWc3Sk8wNjR1a0xnb2dJQzh2SU9xd2tPeUxuT3lla09xd2dDRHJpN1h0bFpqcmlwUWc3SjIwN0p5Z09pRHJpNlRycHF6cnBid2c3THljNjZtMElPeWJqT3V3amV5WGhleWN2T3VobkNEdGdiVHJvWnpyazV6cXNJQWc3SXVrN0tDY0lPMll1T3kybk91UHZDRHF0YXpyajRVZzdJS3M3SnFwNjUrSjdKMjBJT3VDbU9xd2hPdUxwQzRLSUNBdkx5RHFzSkRzDQppNXpzbnBEcmlwUWc3WXlNN0oyODY2ZU1JT3lkdmV5Y3ZPdXZnT3VobkNEc2dxenNtcW5ybjRrZ01DREN0eURyaklEcXVMQWdNQ0RpZ0pRZzZyS0E3WWFnNjZlTUlPeVRzT3VLbENEc2dxenJub3pzbDVEcXNvd2c2N21FN0pxcDdKMkVJT3Vzdk91bXJPeW5nQ0RzbFlycmlwVHJpNlF1Q2lBZ0x5OGc3S084N0oyWU9pRHNsNnpxdUxBZzZyT0U3S0NWN0oyMElPdXp0T3lYck91UGhDRHNub1hzbnFYcXRvenNuYlFnNjZlTTY2T002NUNRN0oyRUlPeUltQ0Rzbm9qcmk2UW83SnlnN1pxbzdJU3g3SjJBSU95THBPeWduQ0R0bUxqc3Rwd2c2NVdNNjZlTUlPeVZqQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHJpNlRycHF3Z0wyaGxZV3gwYU95ZG1DQndjbTlpYkdWdElPeXd1T3F6b0NrdUNpQWdhV1lnS0hKbGNTNTFjbXdnUFQwOUlDY3ZZV05qYjNWdWRDY3BJSHNLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCaFkyTnZkVzUwT2lCamJHRjFaR1ZCWTJOdmRXNTBLQ2tzSUdOcw0KWVhWa1pUb2dhR0Z6UTJ4aGRXUmxLQ2tnZlNrN0NpQWdmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkzWVd0bEp5a2dld29nSUNBZ2FXWWdLQ0ZvWVhORGJHRjFaR1VvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklHWmhiSE5sTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuSUgwcE93b2dJQ0FnZDJGclpVSnlhV1JuWlNncE93b2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJSGRoYTJsdVp6b2dkSEoxWlNCOUtUc0tJQ0I5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNOb2RYUmtiM2R1SnlrZ2V3b2dJQ0FnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU0I5S1RzS0lDQWdJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdjSEp2WTJWemN5NWxlR2wwS0RBcExDQXlNREFwT3dvZ0lDQWcNCmNtVjBkWEp1T3dvZ0lIMEtJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TkN3Z2V5Qmxjbkp2Y2pvZ0owNXZkQ0JtYjNWdVpDY2dmU2s3Q24wcE93b0tMeThnN0oyMDY2KzRJT3VXb0NEc25vanNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeWloZXVqakNBbzdKNlE2NCtaSU95TG5PeWVrU0FySUc1d2JTQmlkV2xzWkNEc3BKSHJzN1VnN0l1azdaYUpJT3VNZ091NWhDa0tjMlZ5ZG1WeUxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQjdDaUFnYVdZZ0tHVWdKaVlnWlM1amIyUmxJRDA5UFNBblJVRkVSRkpKVGxWVFJTY3BJSEJ5YjJObGMzTXVaWGhwZENnd0tUc0tJQ0J3Y205alpYTnpMbVY0YVhRb01TazdDbjBwT3dwelpYSjJaWEl1YkdsemRHVnVLRkJQVWxRc0lDY3hNamN1TUM0d0xqRW5MQ0FvS1NBOVBpQjdDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHRnYlRyb1p6cms1d2c2NHVrNjZhc0lPcXdrT3lMbk95ZWtDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFyDQpJRkJQVWxRcE93cDlLVHNLDQo6OldTSUxFTlQ6Og0KSnlCRGJHRjFaR1VnUW5KcFpHZGxJSGRoZEdOb1pYSWdjMmxzWlc1MElHeGhkVzVqYUdWeUlDaHVieUIzYVc1a2IzY3BJQzBnY21WbmFYTjBaWEpsWkNCMGJ5QnlkVzRnWVhRZ2JHOW5hVzRLVTJWMElHWnpieUE5SUVOeVpXRjBaVTlpYW1WamRDZ2lVMk55YVhCMGFXNW5Ma1pwYkdWVGVYTjBaVzFQWW1wbFkzUWlLUXBUWlhRZ2MyZ2dQU0JEY21WaGRHVlBZbXBsWTNRb0lsZFRZM0pwY0hRdVUyaGxiR3dpS1Fwa2FYSWdQU0JtYzI4dVIyVjBVR0Z5Wlc1MFJtOXNaR1Z5VG1GdFpTaFhVMk55YVhCMExsTmpjbWx3ZEVaMWJHeE9ZVzFsS1FwemFDNURkWEp5Wlc1MFJHbHlaV04wYjNKNUlEMGdaR2x5Q25Ob0xsSjFiaUFpWTIxa0lDOWpJRzV2WkdVZ2MyTnlhWEIwYzF4aWNtbGtaMlV0ZDJGMFkyaGxjaTVxY3lJc0lEQXNJRVpoYkhObENnPT0NCjo6RU5EOjoNCg==";
// ===== INSTALLER:END =====
// 다리 심장박동 — 플러그인이 떠 있는 동안 5초마다 생존 신호를 보낸다.
// 플러그인/피그마가 닫혀 박동이 30초 끊기면 다리가 claude와 함께 스스로 꺼진다 (claude-bridge.js /heartbeat).
// 다리가 꺼져 있으면 그냥 실패 — 심장박동이 다리를 켜지는 않는다 (켜기는 ensureBridgeFromGesture 담당).
function sendHeartbeat() {
    postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/heartbeat', {}, 3000).catch(() => { });
}
sendHeartbeat();
setInterval(sendHeartbeat, 5000);
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
    // 2) 조사 교정 (받침 기반: 을/를)
    const particle = fixParticles(typo.text);
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
    const mergedReasons = [...protect.reasons, ...term.reasons, ...typo.reasons, ...particle.reasons, ...structural.reasons, ...pattern.reasons, ...hae.reasons, ...period.reasons];
    const mergedTags = [...protect.tags, ...term.tags, ...typo.tags, ...structural.tags, ...pattern.tags, ...hae.tags];
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
    // 네이티브 어노테이션 정리 (형광펜이 하나도 없는 노드여도 실행되도록 맨 앞에서)
    clearNativeAnnotation(nodeId);
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
// before/after에서 바뀐 구간만 추출 (공통 접두/접미 제거)
function computeChangedSegment(before, after) {
    if (before === after)
        return { beforeSeg: '', afterSeg: after };
    let start = 0;
    const minLen = Math.min(before.length, after.length);
    while (start < minLen && before[start] === after[start])
        start++;
    let endB = before.length;
    let endA = after.length;
    while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
        endB--;
        endA--;
    }
    return { beforeSeg: before.slice(start, endB), afterSeg: after.slice(start, endA) };
}
// 코멘트에 표시할 라벨 생성: 변경이 필요한 부분만 "원래 → 변경" 형태로
function buildAnnotationLabel(before, after) {
    const seg = computeChangedSegment(before, after);
    const clip = (s) => (s.length > 24 ? s.slice(0, 24) + '…' : s);
    // 깔끔한 diff가 안 나오면(전체 변경 등) 변경 후 전체를 표시
    if (!seg.beforeSeg && !seg.afterSeg) {
        return clip(after);
    }
    const b = seg.beforeSeg ? clip(seg.beforeSeg) : '(없음)';
    const a = seg.afterSeg ? clip(seg.afterSeg) : '(삭제)';
    return b + ' → ' + a;
}
// before/after에서 바뀐 글자 구간의 인덱스(before 기준) 반환
function computeChangedRange(before, after) {
    let start = 0;
    const minLen = Math.min(before.length, after.length);
    while (start < minLen && before[start] === after[start])
        start++;
    let endB = before.length;
    let endA = after.length;
    while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
        endB--;
        endA--;
    }
    return { start, end: endB };
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
        if (!annotationsVisible)
            hl.visible = false;
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
        if (!annotationsVisible)
            group.visible = false;
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
// 네이티브 어노테이션(코멘트) 상태 — nodeId 기준
// (코멘트를 씬 노드 대신 Figma 기본 주석으로 달면 클릭해도 크기 배지가 뜨지 않는다)
const annotatedNodeIds = new Set();
const nativeAnnotationLabels = new Map(); // 숨기기 토글 복원용
function setNativeAnnotation(nodeId, labelMarkdown) {
    const node = annotationNodeCache.get(nodeId);
    if (!node || node.removed)
        return;
    try {
        node.annotations = [{ labelMarkdown }];
        annotatedNodeIds.add(nodeId);
        nativeAnnotationLabels.set(nodeId, labelMarkdown);
    }
    catch (e) {
        console.log('[UX-ANN] 네이티브 어노테이션 설정 실패', e);
    }
}
function clearNativeAnnotation(nodeId) {
    const node = annotationNodeCache.get(nodeId);
    try {
        if (node && !node.removed && annotatedNodeIds.has(nodeId))
            node.annotations = [];
    }
    catch (_e) { }
    annotatedNodeIds.delete(nodeId);
    nativeAnnotationLabels.delete(nodeId);
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
    for (const nodeId of Array.from(annotatedNodeIds))
        clearNativeAnnotation(nodeId);
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
// 어노테이션 표시 상태
let annotationsVisible = true;
// 어노테이션 토글
function toggleAnnotations() {
    annotationsVisible = !annotationsVisible;
    for (const ann of getAllAnnotations()) {
        ann.visible = annotationsVisible;
    }
    // 네이티브 어노테이션은 visible 속성이 없어 제거/복원으로 토글한다
    if (annotationsVisible) {
        for (const [nodeId, md] of nativeAnnotationLabels) {
            const node = annotationNodeCache.get(nodeId);
            if (!node || node.removed)
                continue;
            try {
                node.annotations = [{ labelMarkdown: md }];
                annotatedNodeIds.add(nodeId);
            }
            catch (_e) { }
        }
    }
    else {
        for (const nodeId of Array.from(annotatedNodeIds)) {
            const node = annotationNodeCache.get(nodeId);
            try {
                if (node && !node.removed)
                    node.annotations = [];
            }
            catch (_e) { }
            annotatedNodeIds.delete(nodeId); // 라벨(nativeAnnotationLabels)은 복원 위해 유지
        }
    }
    figma.ui.postMessage({ type: 'annotations-visibility', visible: annotationsVisible });
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
    // 어노테이션 전체 삭제
    if (msg.type === "CLEAR_ANNOTATIONS") {
        removeAnnotations();
        annotationsVisible = true;
        figma.ui.postMessage({ type: 'annotations-cleared' });
        return;
    }
    // 어노테이션 숨기기/보이기 토글
    if (msg.type === "TOGGLE_ANNOTATIONS") {
        toggleAnnotations();
        return;
    }
    // 선택한 항목들의 어노테이션만 삭제
    if (msg.type === "CLEAR_ANNOTATIONS_NODES") {
        const ids = msg.nodeIds || [];
        for (const id of ids)
            removeAnnotationByNodeId(id);
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
            const suggestions = await fetchAiSuggestions(text, msg.model);
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
        try {
            // switchAccount=true면 다리가 시크릿 창으로 연다 — 기존 claude.ai 로그인 세션이 없어야 계정을 고를 수 있다
            const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/open-login', { switchAccount: !!msg.switchAccount }, 5000);
            const data = await res.json().catch(() => ({}));
            figma.ui.postMessage({
                type: 'show-toast',
                message: !res.ok
                    ? ((data && data.error) || '로그인 창을 못 열었어요 — 터미널에서 claude 실행 후 /login 해 주세요.')
                    : data && data.mode === 'terminal'
                        ? '이번엔 터미널 로그인 창을 열었어요 — 안내에 따라 진행하고, 브라우저에 코드가 보이면 터미널에 붙여넣으세요.'
                        : data && data.mode === 'browser-switch'
                            ? '브라우저에서 로그아웃 후 계정 선택 화면을 열어요 — 잠깐 기다렸다가 쓰려는 계정을 고르면 자동으로 바뀌어요.'
                            : '브라우저에 클로드 로그인 페이지를 열었어요 — 로그인하면 자동으로 연결돼요. 완료가 안 되면 버튼을 한 번 더 누르세요.',
            });
        }
        catch (e) {
            figma.ui.postMessage({ type: 'show-toast', message: '로그인 창을 못 열었어요(다리 꺼짐?) — 터미널에서 claude 실행 후 /login 해 주세요.' });
        }
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
    // 이 PC의 클로드 계정 조회 — 감시자(항상 떠 있음)가 파일만 읽어 답한다.
    // 다리를 켜지 않는 것이 핵심: 다리는 켜질 때 워밍업으로 클로드를 실제 호출해 구독 사용량이 나가므로,
    // 검토만 쓰는 사람에게 비용을 물리지 않으려면 계정 표시용으로 다리를 켜면 안 된다.
    if (msg.type === "CHECK_ACCOUNT") {
        await confirmedAccountLoaded; // 저장된 확인 계정을 읽은 뒤 답해야 UI가 첫 화면을 옳게 정한다
        let account = null;
        let claudeInstalled = null;
        let source = 'none';
        try {
            const res = await fetchWithTimeout(WATCHER_URL + '/account', 3000);
            const d = await res.json().catch(() => ({}));
            if (d && d.ok) {
                account = d.account || null;
                claudeInstalled = (typeof d.claude === 'boolean') ? d.claude : null;
                source = 'watcher';
            }
        }
        catch (_e) {
            // 감시자가 없거나 구버전(/account 없음) — 다리가 이미 켜져 있으면 거기서라도 계정을 얻는다
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
        figma.ui.postMessage({ type: 'account-info', account, claudeInstalled, source, confirmed: confirmedClaudeAccount });
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
