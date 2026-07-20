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
function refreshBridgeStatus() {
    bridgeHealth().then((h) => {
        figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem, account: h.account, needConfirm: needsAccountConfirm(h) });
    });
}
// 클로드다리 설치 파일 — 다리+예시+런처를 내장한 자기완결 bat. UI의 [🔧 설치 파일 받기]가 다운로드로 내려준다.
// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드다리-설치.bat을 base64로 주입) =====
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEcmk2VHJwcXdnN0lTazdMbVlJQ2d4THpJcElPS0FsQ0JPYjJSbExtcHpKeXdnSjA5TFEyRnVZMlZzSnl3Z0oxZGhjbTVwYm1jbktRb2dJQ0FnYVdZZ0tDUnlJQzFsY1NBblQwc25LU0I3SUZOMFlYSjBMVkJ5YjJObGMzTWdKMmgwZEhCek9pOHZibTlrWldwekxtOXlaeTlyYnk5a2IzZHViRzloWkNjZ2ZRb2dJSDBLSUNCbGVHbDBDbjBLYVdZZ0tDMXUNCmIzUWdLRWRsZEMxRGIyMXRZVzVrSUdOc1lYVmtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JDYjNnZ0l1eUVwT3k1bU91S2xDRHJnWjNyZ3F6c2xyVHNtcFF1SU9xM3VPdWZzT3VOc0NCRGJHRjFaR1VnUTI5a1plcXdnQ0RzbDRic2xyVHNtcFFnS091WWtPdUtsQ0JRUVZSSTdKZVFJT3lYaHV5V3RPeWFsQ2t1WUc1Z2J1MkVzT3V2dU91RWtPeVhrT3lFbkNEc2xZVHJucGpycGJ3ZzdJU2s3TG1Zd3Jmcm9aenF0N2pzbmJqdGxad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUTZZRzVnYmlBZ2JuQnRJR2x1YzNSaGJHd2dMV2NnUUdGdWRHaHliM0JwWXkxaGFTOWpiR0YxWkdVdFkyOWtaV0J1SUNCamJHRjFaR1VnYkc5bmFXNWdibUJ1N1ptVjdKMjRPaUR0aExEcnI3anJoSkRzbDVEc2hKd2dZMnhoZFdSbElDMHRkbVZ5YzJsdmJpRHNuYlFnNjdLRTdLQ0U3SjJFSU95Mm5PdWdwZTJWbU91cHRDRHNwSURyDQp1WVFnN0ptRTY2T01MbUJ1S095Q3JPeWFxZXVmaWV5ZGdDRHNuYlFnVUVQc2w1QWc2NkdjNnJlNDdKMjQ2NUNjSU8yQnRPdWhuT3VUbkNEcXRhenJqNFVnN1pXYzY0K0U3SmVRN0lTY0lPeXdxT3F3a091UXFldUxpT3VMcEM0cElpQW43WUcwNjZHYzY1T2NJT3VMcE91bXJDRHNoS1RzdVpnZ0tESXZNaWtnNG9DVUlFTnNZWFZrWlNCRGIyUmxKeUFuVjJGeWJtbHVaeWNLSUNCbGVHbDBDbjBLVTNSaGNuUXRVSEp2WTJWemN5QXRSbWxzWlZCaGRHZ2dKMk50WkM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0p5OWpJRzV2WkdVZ2MyTnlhWEIwYzF4amJHRjFaR1V0WW5KcFpHZGxMbXB6SnlBdFYyOXlhMmx1WjBScGNtVmpkRzl5ZVNBa1pHbHlJQzFYYVc1a2IzZFRkSGxzWlNCSWFXUmtaVzRLUW05NElDTHNoS1RzdVpnZzdKbUU2Nk9NSVNEdGdiVHJvWnpyazV3ZzY0dWs2NmFzNjZXOElPeThzT3lXdE95YWxDNWdibUJ1N0oyMDdLQ2NJTzJVdk9xM3VPdW5pQ0R0bEl6cm42enF0N2pzbmJqc25MenJvWndnNjQrTQ0KN0pXRTZyQ0FJRnZzdHBUc3NwenJzSnZxdUxCZDY2VzhJT3VJaE91bHRPdXB0Q0R0Z2JUcm9aenJrNXpxc0lBZzY0dTE3WlcwN0pxVUxtQnU2NHVrN0oyTTY3YUE3WVN3NjRxVUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHN0cFRzc3B6Q3QrdXlpT3lYclNEdG1aVHJxYlRzbDVBZzY1T2s3SmEwNnJDQTY2bTBJT3lla091UG1leWN2T3VobkNEc3ZKenNwNUhyaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU91THBPdW1yQ0RpZ0pRZzdLU0E2N21FSU95WmhPdWpqQ2NnSjBsdVptOXliV0YwYVc5dUp3PT0NCjo6QlJJREdFOjoNCkx5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDaERiR0YxWkdVZ1FuSnBaR2RsS1NEaWdKUWc3WlM4NnJlNDY2ZUlJTzJVak91ZnJPcTN1T3lkdU9xenZDQkRiR0YxWkdVZ1EyOWtaZXVsdkNEc25vZnJpcFFnNjZHYzdMdXNJT3lMck91MmdPdW1oT3ErdkFvdkx5RGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdJS3M3SnFwNjdLVk9pRHRnYlRyb1p6cms1enJpNlRycHF3dDdMeWM2cml3TG1KaGRDRHJqWlRydUpUdGdiVHJwcTBnS091WWtPdUtsQ0J1Y0cwZ2NuVnVJR0p5YVdSblpTa0tMeThnN0x5YzY1R1E2Nm0wDQpJTzJVak91ZnJPcTN1T3lkdU95ZG1DQmI3TGFVN0xLYzY3Q2I2cml3WGVxd2dDQkhaVzFwYm1rZzdZS2tJT3lYaHV5ZHRPdVBoQ0R0Z2JUcm9aenJrNXpyb1p3Z1FVa2c3TGFVN0xLYzdKMkVJT3V3bSt1S2xPdUxwQzRLTHk4S0x5OGc3SWFONjQrRUlPeUVwT3F6aERvZzdZRzA2NkdjNjVPYzY2VzhJT3lhbE95eXJldW5pT3VMcENEc2c0anJvWndnN0l1YzY0K1o3WldZNjZtMElETXdmalF3N0xTSTZyQ0FJT3EzdU91RHBTRHJncURzbFlUcXNJVHJpNlF1Q2k4dklPS0draURyaTZUcnBxenJwYndnN0x5a0lPdVZqQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1k3SjJFSU8yVm1PdUNtQ0RzbDdUc2xyUWc3SU9CN0l1Y0lPdU1nT3E0c095TG5PMkNwT3F6b0NoemRISmxZVzB0YW5OdmJpRHJqSUR0bVpRZzY2cW82NU9jS1N3S0x5OGdJQ0Rxc0lEc25iVHJrNXdyN0ppSTdJdWNLREV4TWVxeHRDbnJpcFFnN0xLcklPdXBsT3lMbk95bmdPdWhuQ0R0bFp3ZzY3S0k2NmVNSU95ZHZlMmVqT3VMcEM0ZzdKMjA3WnVFSU95YQ0KbE95eXJleWRnQ0RyckxqcXRhenJwNHdnNjdPMDY0SzA2NitBNjZHY0lPdTVvT3VsdE91THBDNEtMeThnN0lTNDdJV1k3SjJBSURNdzY3S0lJT3lUc091cHRDRHNucXpzaTV6c25wSHRsYlFnNjR5QTdabVU2ckNBSU91c3RPMlZuTzJlaUNEcXVManNsclRzcDREcmlwUWc2cktEN0oyRUlPdW5pZXVLbE91THBDNEtMeThLTHk4ZzdLQ0U3S0NjT2lEc25iUWdVRVBzbDVBZ1EyeGhkV1JsSUVOdlpHWHFzSUFnN0lTazdMbVl3cmZyb1p6cXQ3anNuYmpyajd3ZzdKNkk3SjJFSU9xeWd5QW9ZMnhoZFdSbElDMHRkbVZ5YzJsdmJpRHNuTHpyb1p3ZzdabVY3SjI0S1Fvdkx5RHNvN3pzblpnNklPeUNyT3lhcWV1ZmlleWRnQ0Rxc0lIc25wQWc3WUcwNjZHYzY1T2NJT3Exck91UGhTRHRsWnpyajRUc2w1RHNoSndnN0xDbzZyQ1E2NUNjNjR1a0xnb0tZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNLWTI5dWMzUWdabk1nUFNCeVpYRjFhWEpsS0NkbWN5Y3BPd3BqYjI1emRDQnZjeUE5SUhKbGNYVnANCmNtVW9KMjl6SnlrN0NtTnZibk4wSUhCaGRHZ2dQU0J5WlhGMWFYSmxLQ2R3WVhSb0p5azdDbU52Ym5OMElIc2djM0JoZDI0c0lITndZWGR1VTNsdVl5QjlJRDBnY21WeGRXbHlaU2duWTJocGJHUmZjSEp2WTJWemN5Y3BPd29LTHk4ZzdZRzA2NkdjNjVPYzY2VzhJT3U1aUNEdGo3VHJqWlRzbDVEc2hKd2c3SXVrN1phSklPS0FsQ0Rzb0lEc25xWHNob3pzbDVEc2hKd2c3SXVrN1phSjdaV1k2Nm0wSU8yVWhPdWhuT3lnbmUyS3VDRHJwNlhybmIwb1EweEJWVVJGTG0xa0lPdVRzU25zbllRS0x5OGc2NmVrSU8yRXRDRHNwNHJzbHJUc29ManNoSndnTkRYc3RJZ3Y3WVMwNnJtTTdLZUFJT3VLa091Z3BPeW5oT3VMcENBbzY3bUlJTzJQdE91TmxDQXJJT3UyZ09xd2dPcTRzT3VLcFNEc3NLanJpNmpzbmJUcnFiUWdmalBzdElndjdZUzBLUzRLWTI5dWMzUWdSVTFRVkZsZlExZEVJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxamQyUW5LVHNLZEhKNUlIc2dabk11DQpiV3RrYVhKVGVXNWpLRVZOVUZSWlgwTlhSQ3dnZXlCeVpXTjFjbk5wZG1VNklIUnlkV1VnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdXN0T3lMbkNBcUx5QjlDbU52Ym5OMElFTk1RVlZFUlY5RlRsWWdQU0JQWW1wbFkzUXVZWE56YVdkdUtIdDlMQ0J3Y205alpYTnpMbVZ1ZGl3Z2V3b2dJRTFCV0Y5VVNFbE9TMGxPUjE5VVQwdEZUbE02SUNjd0p5d2dJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQzh2SU95RG5lcXdnU0RycXFqcms1d2c2NEdVSUNqc3A2ZnNuWUFnNjZ5NDZyV3M3SmVVSU91MmlPMlZoT3lhbENrS0lDQkRURUZWUkVWZlEwOUVSVjlFU1ZOQlFreEZYMDVQVGtWVFUwVk9WRWxCVEY5VVVrRkdSa2xET2lBbk1TY3NJQzh2SU8yRXRDRHNtcFRzbGIwZzY1T3hJT3UyZ09xd2dDRHRtTGpzdHB3ZzY0R1VDaUFnUkVsVFFVSk1SVjlVUlV4RlRVVlVVbGs2SUNjeEp5d0tmU2s3Q2dwamIyNXpkQ0JRVDFKVUlEMGdUblZ0WW1WeUtIQnliMk5sYzNNdVpXNTJMa0pTU1VSSFJWOVFUMUpVS1NCOA0KZkNBeE1UZzRPRHNnTHk4Z1FsSkpSRWRGWDFCUFVsVHJpcFFnN1lXTTdJcWs3WXE0N0pxcElDanRqNG5zaG96c2w1UWdNVEU0T0RnZzZyT2c3S0NWS1Fvdkx5RHJpNlRycHF3ZzdMMlU2NU9jSU91eWhPeWdoQ0RpZ0pRZ0wyaGxZV3gwYU91aG5DRHJoYmpzdHB6dGxaenJpNlF1SU95OWxPdVRuT3VsdkNCd2RXeHN3cmZyczdYc2dxenRsYlRyajRRZ0tpcnNuYlRycjdnZzY1YWdJT3llaU91S2xDRHJpNlRycHF6cmlwUWc3SmliSU95OWxPdVRuQ0RxdDdqcmpJRHJvWndxS3V1ZHZBb3ZMeURxdTVEcmk2UWc3THljNnJpd0lPeWdoT3lYbENEc2c0Z2c2NCtaN0o2UjdKMjBJT3lWaUNEcmdwanNtS2pyaTZRbzdZU3c2Nis0NjRTUTdKMjBJT3VjcU91S2xDRHJrN0VwTGlEdGxJenJuNnpxdDdqc25ianNuYlFnN0oyMElPcXdrdXljdk91aG5DRHF0YXpyc29Uc29JVHNuWVFnNnJDUTdLZUE3WlcwSU95ZXJPeUxuT3lla2V5TG5PMkNxT3VMcEM0S0x5OGc2NCtaN0o2UjdKMjBJT3V3bE91QWpPdUtsQ0RzaUpqc29KWHMNCm5ZUWc3WldZNjZtMElPeWR0Q0RzaUt2c25wRHJwYndnN0ppczY2YXM2ck9nSUdOdlpHVXVkSFBzblpnZ1FsSkpSRWRGWDAxSlRsOVc2NCtFSU9xd21leWR0Q0RzbUt6cnByRHJpNlF1Q21OdmJuTjBJRUpTU1VSSFJWOVdJRDBnTVRFN0NpOHZJT3E0c091enVDRHJxcWpyamJndUlPeWFsT3l5clNqdGxJenJuNnpxdDdqc25iZ3A3SjIwSUcxdlpHVnM3SjJFSU95bmdPeWdsZTJWbU91cHRDRHF0N2dnN0pxVTdMS3Q2NmVNSU9xM3VDRHJxcWpyamJqcm9ad2c3TEtZNjZhczdaV2M2NHVrTGdvdkx5Qm9ZV2xyZFQzcnVhRHJwb1F2NnJDQTY3Szg3SnVBTENCemIyNXVaWFE5N0tTUjZyQ0VMQ0J2Y0hWelBlcTRzT3V6dUNqc3RaenFzNkR0a29qc3A0Z3NJT3loc09xNGlDRHJpcERycHJ3cENtTnZibk4wSUVOTVFWVkVSVjlOVDBSRlRDQTlJSEJ5YjJObGMzTXVaVzUyTGtKU1NVUkhSVjlOVDBSRlRDQjhmQ0FuYjNCMWN5YzdDbU52Ym5OMElFRk1URTlYUlVSZlRVOUVSVXhUSUQwZ1d5ZG9ZV2xyZFNjc0lDZHpiMjV1DQpaWFFuTENBbmIzQjFjeWRkT3dwamIyNXpkQ0JVVlZKT1gxUkpUVVZQVlZSZlRWTWdQU0E1TURBd01Ec2dJQ0F2THlEc21wVHNzcTBnTWVxeHRDRHNvSnp0bFp6c2k1enFzSVFLWTI5dWMzUWdUVUZZWDFSVlVrNVRJRDBnTXpBN0lDQWdJQ0FnSUNBZ0lDQWdMeThnN0oyMDY2ZU03WUc4SU95VHNPdXB0Q0RzaExqc2haZ2c3SjZzN0l1YzdKNlJJQ2pyaklEdG1aUWc2NGlFN0tDQklPdXdxZXluZ0NrS0NpOHZJT0tVZ09LVWdDRHNtSWpzaTV3ZzdJS3M3S0NFSU91aG5PdVRuQ0FvY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xa0lPS0FsQ0JpZFdsc1pDMW5iRzl6YzJGeWVTNXFjK3laZ0NEcXNKbnNuWUFnN1l5TTdJU2NLU0RpbElEaWxJQUtablZ1WTNScGIyNGdiRzloWkVWNFlXMXdiR1Z6S0NrZ2V3b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xaw0KSnlrc0lDZDFkR1k0SnlrN0NpQWdJQ0JqYjI1emRDQnpaV05KWkhnZ1BTQnRaQzV6WldGeVkyZ29MMTRqSXlEc3RwVHNzcHdnN0ppSTdJdWNYSE1xSkM5dEtUc0tJQ0FnSUdsbUlDaHpaV05KWkhnZ1BUMDlJQzB4S1NCeVpYUjFjbTRnVzEwN0NpQWdJQ0JqYjI1emRDQmxlR0Z0Y0d4bGN5QTlJRnRkT3dvZ0lDQWdiR1YwSUdOMWNpQTlJRzUxYkd3N0NpQWdJQ0JtYjNJZ0tHTnZibk4wSUhKaGR5QnZaaUJ0WkM1emJHbGpaU2h6WldOSlpIZ3BMbk53YkdsMEtDZGNiaWNwS1NCN0NpQWdJQ0FnSUdOdmJuTjBJR3hwYm1VZ1BTQnlZWGN1Y21Wd2JHRmpaU2d2WEhNckpDOHNJQ2NuS1RzS0lDQWdJQ0FnWTI5dWMzUWdhQ0E5SUd4cGJtVXViV0YwWTJnb0wxNGpJeU5jY3lzb0xpcy9LVnh6S2lRdktUc0tJQ0FnSUNBZ2FXWWdLR2dwSUhzZ1kzVnlJRDBnZXlCcGJuQjFkRG9nYUZzeFhTd2djM1ZuWjJWemRHbHZibk02SUZ0ZElIMDdJR1Y0WVcxd2JHVnpMbkIxYzJnb1kzVnlLVHNnWTI5dWRHbHVkV1U3SUgwS0lDQWcNCklDQWdZMjl1YzNRZ1lpQTlJR3hwYm1VdWJXRjBZMmdvTDE1Y2N5b3RYSE1yS0M0clB5bGNjeW9rTHlrN0NpQWdJQ0FnSUdsbUlDaGlJQ1ltSUdOMWNpa2dZM1Z5TG5OMVoyZGxjM1JwYjI1ekxuQjFjMmdvWWxzeFhTNXpjR3hwZENnbklDOGdKeWt1YW05cGJpZ25JQ2NwS1RzS0lDQWdJSDBLSUNBZ0lISmxkSFZ5YmlCbGVHRnRjR3hsY3k1bWFXeDBaWElvS0dVcElEMCtJR1V1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUQ0Z01DazdDaUFnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeVlpT3lMbkNEc2dxenNvSVFnNjZHYzY1T2NJT3lMcE8yTXFDQW83SmVHN0oyMElPeW5oTzJXaVNrNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lISmxkSFZ5YmlCYlhUc0tJQ0I5Q24wS0NpOHZJT0tVZ09LVWdDRHNwNERzaTV6cnJMZ2dLT3lFbk91eWhDQnlaV052YlcxbGJtVHNtWUFnNnJDWjdKMkFJT3Ezbk95NW1TRGlnSlFnNjdDVTZyNjQ2Nm0wSU9xM3VPeXF2ZXVQDQpoQ0R0bGFqcXU1Z3BJT0tVZ09LVWdBb3ZMeURzbXFuc2xyVHNwNUVvWjJ4dmMzTmhjbmt1YldRcDdKMkFJT3lkdk91MmdPdWZyQ0R0bElUcm9henRsSVR0aXJqc2w1QWc3SldJSU91RW8rdUtsT3VMcENneU1ESTJMVEEzSU95THBPeTRvU2s2SU91RW8reWN2T3VwdENEdGdiVHJvWnpyazV6cXNJQWc3SnFwN0phMElPcTFrT3lnbGV5ZGhBb3ZMeURzbzd3ZzdKNkU2NnkwNjZHY0lPeVlwTzJWdE8yVnRDQXo2ckNjSU95Z25PeVZpT3lkdENEc29JVHJ0b0FnSXUyUm5PcTRzQ0RxczZEc3VhZ2dLeURzbHJUc2lKd2c2N09BNnJLOUl1eWR0Q0Rya0p6cmk2UXVJT3lYcmUyVm9DRHJ0b1RycHF3ZzRvQ1VDaTh2SU8yQnRPdWhuT3VUbkNBOUlPdXN1T3llcFNEcmk2VHJrNnpxdUxBbzdMQzk3SjJZS1N3ZzdKcXA3SmEwSU8yR3RleWR2TUszNjZlZTdMYWs2N0tWSUQwZ1kyOWtaUzUwY3lCeVpXWnBibVZCYVZOMVoyZGxjM1JwYjI1eklPMmJoT3l5bU91bXJDanF1TERxczRUc29JRXBMZ3BqYjI1emRDQlRWRmxNUlY5Uw0KVlV4RlV5QTlJRnNLSUNBbk1TNGc3WlcwN0pxVTdMSzBPaURycXFqcms2QWc2Nnk0NnJXczY0cVVJTzJWdE95YWxPeXl0T3VobkM0Z0tPdXp0T3VEaGV1TGlPdUxwT0tHa3V1enRPdUN0T3lhbENrbkxBb2dJQ2N5TGlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd09pRHJrSkRzbHJUc21wVGlocEx0bG9qc2xyVHNtcFFzSUg3c2w0Z2c2N204NnJpd0tPdXdsT3VBak95WGlPeVd0T3lhbE9LR2t1dXdsT3EvcU95V3RPeWFsQ2t1SU91THFDd2c3S0tGNjZPTXdyZnJwNHpybzR6Q3QreVhzT3l5dE1LMzdaVzA3S2VBd3JmcXVMRHJvWjNDdCt1RnVleWRqQ0RyazdFZzdJdWM3SXFrN1lXYzdKMjBJT3lqdk95eXRPeWR1Q0Rxc3JEcXM3enJpcFFnN0lpWTY0K1o3WmlWSU95Y29PeW5nQ2pzbDdEc3NyVHJqN3pzbXBRc0lPdUZ1ZXlkak91UHZPeWFsQ2t1Snl3S0lDQW5NeTRnNnJpTjdLQ1Y3S0NCSU91bmtPMlZtT3E0c0RvZ0luN3RsYUFnN0lpWUlPeVhodXlXdE95YWxDSWc2NHlBN0l1Z0lDSis3WldZNjZtMElPMlYNCm9DRHNpSmdnN0o2STdKYTA3SnFVSWlEcXRhenNvYkFnN0pxdzdJU2dMaURyaTZnc0lPeWdsZXl4aGV5RGdTRHJ0b2pxc0lEQ3QreWR2T3UyZ0NEcXVMRHJpcVVnN0tDYzdaV2N3cmZya0pqcmo0enJwclFnN0lpWUlPeVhodXVLbENEcXNyRHFzN3pDdCt5Z2xldXp0Q0RyczdUdG1MZ2c3SldJN0l1czdKMkFJT3UyZ095Z2xlMllsZXljdk91aG5DRHJxb1h0bVpYdG5vZ3VKeXdLSUNBbk5DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0RG9nZnUyVm1PeUxuT3F5b095V3RPeWFsRC9paHBKKzdaV2c2cm1NN0pxVVB5d2c2ck9FN0l1YzY0dWs0b2FTN0o2STY0dWtMQ0RzbDZ6c3JZanJpNlRpaHBMdG1aWHNuYmp0bFpqcmk2UXNJT3E3bU9LR2t1eVhrT3F5akM0Z2Z1eUxuQ0RydWJ6cXVMRHFzSUFnN0phMDdJT0o3WldZNjZtMElPMk1qT3lWaGUyVm1PdWdwT3VLbENEc29KWHJzN1RycGJ3ZzdLTzg3SmEwNjZHY0lPdXN1T3llcGV5ZGhDRHJpNlRzaTV3ZzdKTzA2NHVrTGljc0NpQWdKelV1SU91cWhleUNyQ3ZyDQpxb1hzZ3F3ZzZyaUk3S2VBT2lEdGxaenNucERzbHJUcnBid2c3WktBN0phMElPdVBtZXlDck91aG5DanNuYlRzbnBBZzdabVk2N2FJN0oyRUlPdXdtK3lWbU95V3RPeWFsT0tHa3V5ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRcExDRHN0WnpzaG96dGxad2dlK3VxaGV5Q3JIM3FzSUFnZSt1cWhleUNySDN0bGJUc2hKd2c3WmlWN1lPYzY2R2NLT3llbE95Vm9TRHJ0b0Rzb2JIc25MenJvWnppaHBMc25wVHNsYUhzbmJRZzY3YUE3S0d4N1pXMDdJU2NLUzRuTEFvZ0lDYzJMaUR0a1p6cXVMQTZJT3VRbU95V3RPeWFsT0tHa3V1UHZPeWFsQzRuTEFvZ0lDYzNMaURzcElRZzZyV3M3S0d3T2lEc201RHJzN2pzbmJRZzdaV2NJT3lraE95ZHRPdXB0Q0RzdHBUc3NwenJqNFFnNjdDWTY1T2M3SXVjSU8yVm5DRHNwSVRyb1p3dUlPeWVoT3lkbU91aG5DRHNwSVRzbllRZzY0cVk2NmFzN0tlQUlPeVZpdXVLbE91THBDNGc2NHVvTENEc2w2enJuNndnNjZ5NDdKNmw3SjJFSU8yVm1PdUNtT3lkbUNEcQ0KdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPMlZxZXl6a0NEcmpaUWc2ckNFNnJLdzdaVzA3S2VFNjR1azY2bTBJT3lraENEc2lKanJwYndnN0tTRTdKMjA2NHFVSU9xeWcreWRnQ0R0bVpqc21JRXVKeXdLSUNBbk9DNGc2NHVrN0oyMDdKYTg2NkdjNnJlNElPeVp2T3lxdlNEcnNvVHRpcndnNjUyODY3S283SjJBSUNMcmk2dnF1TEFpS095M3FPeUdqQ0RxdUlqc3A0QXBMaWNzQ2lBZ0p6a3VJT3lkdE91bWhNSzM3S0NFN1ptVTY3S0k3Wmk0d3JmcnA0anNpcVR0Z3Juc25ZQWc2cmU0NjR5QTY2R2NJT3V6dE95aHRDNGc3SUtzNjU2TTdKMkVJT3UyZ091bHZDRHJsWkFnNjR1WTdKMkVJT3UybWV5WHJPdVBoQ0Rzb292cmk2UXVKeXdLSUNBbk1UQXVJT3lnbk8yU2lDRHNtcW5zbHJRZzdKeWc3S2VBT2lEc25vWHJvS1hzbDVBZzdKT3c3SjI0SU9xNHNPdUtwZXlFc1NEcnFvWHNncXdvNjdPQTZySzlMQ0RzcDREc29KVXNJT3VUc2V1aG5Td2c3WlcwN0tDY0lPdVRzU25yaXBRZzdabVU2Nm0wN0oyWUlPcTQNCnNPdUtwZXVxaGNLMzY3S0U3WXE4NjZxRjdKMjhJT3F3Z091S3BleUVzZXlkdENEcmhwTHNuTHpycjREcm9ad2c3SW1zN0pxMElPdW5rT3VobkNEcnNKVHF2cmpzcDRBZzdKV0s2NHFVNjR1a0xpRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F6cnBid2c3SU9JNjZHY0lPdW5qT3VUcE95bmdDRHNsWXJyaXBUcmk2UXVKeXdLWFM1cWIybHVLQ2RjYmljcE93b0tZMjl1YzNRZ1JWaEJUVkJNUlZNZ1BTQnNiMkZrUlhoaGJYQnNaWE1vS1RzS0NpOHZJT0tVZ09LVWdDRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3lnaE91c3VDRHJvWnpyazV3Z0tIVjRMWGR5YVhScGJtY3ViV1FnNG9DVUlPeVlpT3ladUNEcXQ1enN1WmtnN0lTNDY3YUFJT3lMbk91Q21PdW1yT3lZcE9xNWpPeW5nQ0R0bElUcm9henRsSVR0aXJqc2w1QWc3WStzN1pXb0tTRGlsSURpbElBS0x5OGdVMVJaVEVWZlVsVk1SVk1nTVREc3BJUWc3SnFVN0pXOTY2ZU03Snk4NjZHYzY0cVVJT3lZaU95WnVDQXhmak1vDQo3SWlZNjQrWjdaaVZ3cmZxc3Izc2xyVEN0K3UyZ095Z2xlMllsU0R0bDRqc21xa2c3THlBN0oyMDdJcWtLZXlkbUNEcmlaanNsWm5zaXFUcXNJQWc3SnlnN0l1azY1Q2M2NHVrTGdvdkx5RHRqSXpzbmJ6c25iUWc3SmVHN0p5ODY2bTBLT3lFcE95NW1PdXp1Q0RxdGF6cnNvVHNvSVFnNjVPeEtTRHJ1WWdnNjZ5NDdKNlE3SmUwSU9LQWxDRHNtcFRzbGIzcnA0enNuTHpyb1p3ZzY0K1o3SjZSS0daaGFXd3RjMjltZENrdUNtWjFibU4wYVc5dUlHeHZZV1JIZFdsa1pTZ3BJSHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYldRZ1BTQm1jeTV5WldGa1JtbHNaVk41Ym1Nb2NHRjBhQzVxYjJsdUtGOWZaR2x5Ym1GdFpTd2dKeTR1Snl3Z0ozVjRMWGR5YVhScGJtY3ViV1FuS1N3Z0ozVjBaamduS1M1MGNtbHRLQ2s3Q2lBZ0lDQnlaWFIxY200Z2JXUXViR1Z1WjNSb0lENGdNVEF3SUQ4Z2JXUWdPaUFuSnpzS0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0lxaw0KN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Ryb1p6cms1d2c3SXVrN1l5b0lDanNtcFRzbGIzcnA0enNuTHpyb1p3ZzdLZUU3WmFKS1RvbkxDQmxMbTFsYzNOaFoyVXBPd29nSUNBZ2NtVjBkWEp1SUNjbk93b2dJSDBLZlFwamIyNXpkQ0JIVlVsRVJTQTlJR3h2WVdSSGRXbGtaU2dwT3dvS1puVnVZM1JwYjI0Z2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa2dld29nSUdOdmJuTjBJR1psZDFOb2IzUWdQU0JGV0VGTlVFeEZVeTV0WVhBb0tHVjRLU0E5UGlBblNXNXdkWFE2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNobGVDNXBibkIxZENrZ0t5QW5YRzVQZFhSd2RYUTZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2hsZUM1emRXZG5aWE4wYVc5dWN5a3BMbXB2YVc0b0oxeHVKeWs3Q2lBZ2NtVjBkWEp1SUNnS0lDQWdJQ2ZzcDREcXVJanJ0b0R0aExBZzY0U0k2NHFVSU95WGtPeUtwT3lia0NoVExURXNJT3V6dE95VmlPMmFqT3lDckNuc25aZ2c3WldjNnJXdDdKYTBJRlZZSUZkeWFYUnBibWNnN0tDRTY2eTQNCjZyQ0E2NkdjSU95ZHZPMlZuT3VMcEM0Z0p5QXJDaUFnSUNBbjY0SzA2ckNBSUZWSklPdXN1T3Exck91bHZDRHRsWmpyZ3Bqc2xLa2c2N08wNjRLMDY2bTBMQ0RzbFlUcm5wZ2c3SXFrN1lPQTdKMjhJT3Ezbk95NW1leVhrQ0RycDU3cXNvd2c2NHVrNjVPczdKMkFJT3VNZ095VmlDQXo2ckNjNjZXOElPeWduT3lWaU8yVm1PdWR2QzVjYmljZ0t3b2dJQ0FnSit5YWxPeXlyZXVUcE95ZGdDRHNoSnpyb1p3ZzY2eTA2clNBN1pXY0lPdXpoT3F3bkNEcnJManF0YXpyaTZRZzRvQ1VJT3lkdE95Z2hDRHJyTGpxdGF6cnBid2c3TEM0N0tHdzdaV1k3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSit5YmtPdWVtQ0RzblpqcnI3anNtWUFnNjZxbzY1T2dJT3lnbGV1enRDanNuYlRycG9UQ3QreUlxK3lla01LMzdLR3c2ckcwd3JmcmpJRHNnNEVwNjZXOElPeWNvT3luZ08yVm1PcXpvQ3dnNnJDQklPeWduT3lWaU95ZGdDRHNtNURyczdqcXM3enJqNFFnN0lTYzY2R2M3Sm1BNjQrRUlPdUxyT3Vkdk95VnZDRHRsWnpyDQppNlF1SUNjZ0t3b2dJQ0FnSit5aHNPcXh0Q0R0a1p6dG1JUW83SjIwN0lPQndyZnNuYlR0bFpqQ3QreWR0T3VDdE1LMzdMU0k2ck84d3JmcnI3anJwNHpDdCt1MmdPMkVzTUszNnJtTTdLZUFJT3VUc1Nuc25ZQWc3S0NWN0xHRklPeWdsZXV6dE91THBDRGlnSlFnNjdtODZyR3c2NEtZSU91THBPdWx1Q0Rzb2JEcXNiVHNuTHpyb1p3ZzY3Q1U2cjY0N0tlQUlPdW5pT3VkdkNnaU5lMmFqQ0RzbmJUc2c0RWk3SjJFSUNJMTdacU1JdXVobkNEc3BJVHNuYlRycWJRZzdKaWs2NHUxS1M0Z0p5QXJDaUFnSUNBbjdKdVE2Nnk0N0plUUlPeVhodXVLbENEcXRhenNzclFnN0tDVjY3TzBLT3lnaE8yWmxPdXlpTzJZdU1LM1ZWSk13cmZxdUlqc2xhSEN0K3lMbk9xd2hDRHJrN0VwN0ptQUlPMlZ0T3F5c0NEcnNLbnJzcFhDdCt5Z2lPeXdxQ2pzbnF6c2hLVHNvSlhDdCt1c3VPeWRtT3l5bU1LMzdKNnM3SXVjNjQrRUlPdVRzU25ycGJ3ZzdLZUE3SmEwNjRLMElPdTJtZXlkdE91S2xDRHFzb1BzbllBZzdLQ0k2NHlBSU9xNA0KaU95bmdDRGlnSlFnN0pXRTY0cVVJT3F3a3V5ZHRPdWR2T3VQaEN3ZzZyZTQ2NSswNjVPdjdaVzA2NCtFSU95VHNPeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ2N6NnJDY0lPeWduT3lWaU95ZGdDRHNoSnpyb1p3ZzdLQ1I2cmU4N0oyMElPdUxyT3Vkdk95VnZDRHRsWnpyaTZRZzRvQ1VJTzJWbU91Q21PdUtsQ0RzbTVEcnJMZ2c2cldzN0tHdzY2VzhJT3ljb095bmdPMlZuQ0RzdFp6c2hvd2c2NHVrNjVPczZyaXdMQ0R0bFpqcmdwanJpcFFnNjZ5NDdKNmxJT3Exck95aHNPdWx2Q0RzbnF6cXRhenNoTEh0bFp3ZzY0eUE3SldJTENBbklDc0tJQ0FnSUNmcXQ3anJwcXpxczZBZzdLQ0I3SmEwNjQrRUlPMlZtT3VDbU91S2xDRHFzN3pxc0pEdGxad2c3SjZzNnJXczdJU3hPaURzcEpIcnM3VWc3WkdjN1ppRTdKMkVJT3VObk95V3RPdUN0T3F6b0N3ZzdLQ1Y2N08wSU95SW5PeUVuT3VsdkNEc2dxenNtcW5zbnBEcXNJQWc3SldNN0pXRTdKVzhJTzJWb0NEcXNvUHJ0b0R0aExEcm9ad2c3SjZzN0tHdzdLZUINCjdaV2dJT3F5Z3k0Z0p5QXJDaUFnSUNBbjdKdVE2Nnk0N0oyMElPMlZ0T3F5c0NEcnNLbnJzcFhzbllRZzY0dTA2ck9nSU95ZWlPeWRoQ0RybFl6cnA0d2dJdXlXdE91V3UrcXlqQ0R0bFpqcnFiUWc2NHVrN0l1Y0lPdVFuT3VMcENMcnBid2c3SldlN0lTNDdKcXc2NHFVSU9xNGpleWdsZTJZbFNEc25xenF0YXpzaExIc25ZUWc3WldZNjUyOElPS0FsQ0RzbTVEcnJManNsNUFnN1pXMDZyS3c3TEdGN0oyMElPeVhodXljdk91cHRDRHJwNHpyazZUc2xyUWc2N2FaN0oyMDdLZUFJT3VuaU91ZHZDNGdKeUFyQ2lBZ0lDQW43WkdjNnJpd3dyZnNtcW5zbHJUcnA0d2c2ck9nN0xtWTZyT2dJT3lXdE95SW5PeWRoQ0Ryc0pUcXZyd2c3S0NWNjQrRTdKMllJT3lnbk95VmlPeWRoQ0F6NnJDY0lPdUttT3lXdE91R2sreW5nQ0RycDRqcm5id2c0b0NVSU9xM3VPcXh0Q0RzZ3F6c21xbnNucERzbDVEcXNvd2c3TGFVN0xLYzdKMjBJT3lWaE91TGlPdWR2Q0RxdFpEc29KWHNuTHpyb1p3ZzY3TzA3SjI0NjR1a0xpQW5JQ3NLDQpJQ0FnSUNmc2xZVHJucGdnN0ppSTdJdWM2NU9rN0oyQUlPMlZuQ0RzcElUc3A1enJwcXdnN0xXYzdJYU1JT3Exa095Z2xleWR0Q0RycDQ3c3A0RHJwNHdnNnJlNDZyRzBJTzJHcENqdGxiVHNtcFRzc3JUQ3QrcXl2ZXlXdENuc25aZ2c2cldRNjdPNDdKMjA3S2VBSU95R2pPcTN1ZXlFc2V5ZG1DRHF0WkRyczdqc25iUWc3SldFNjR1STY0dWtJT0tBbENEc2w2enJuNndnNjZ5NDdKNmw3S2VjNjZhc0lPeWVoZXVncGV5ZGdDRHJxWlRzaTV6c3A0QWc2NHVvN0p5RTY2R2NJT3VMcE95TG5DRHNoS1RxczRUdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNmcmk3WHNuWUFnNjdDWTY1T2M3SXVjSUVwVFQwNGc2N0N3N0plMDY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvWEN0K3k5bE91VG5PMk9uT3lLcENEcXVJanNwNEE2WEc0bklDc0tJQ0FnSUNkYmV5SjBaWGgwSWpvZ0l1eWduT3lWaUNEcnJManF0YXdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0luSmxZWE52YmlJNg0KSUNMcnJMVHNsNGZzbllRZzdKbWNJT3V3bE9xL3FPdUtsT3luZ0NEdGxaenF0YTNzbHJRZzdaV2NJT3VzdU95ZXBTSjlMQ0F1TGk1ZFhHNWNiaWNnS3dvZ0lDQWdKMXZzaXFUdGc0RHNuYndnNnJlYzdMbVpYVnh1SnlBcklGTlVXVXhGWDFKVlRFVlRJQ3NnSjF4dVhHNG5JQ3NLSUNBZ0lDaEhWVWxFUlNBL0lDZGI3SXFrN1lPQTdKMjhJT3F3Z095ZHRPdVRuQ0Rzb0lUcnJMZ2dLSFY0TFhkeWFYUnBibWN1YldRcElPS0FsQ0RzbklRZzZyZWM3TG1aN0oyWUlPcTN2T3F4c095WmdDRHNtSWpzbWJnZzdJdWM2NEtZNjZhczdKaWtMaUR0aXJudG5vZ2c3SmlJN0ptNElPcTNuT3k1bVNqc2lKanJqNW50bUpYQ3QrcXl2ZXlXdE1LMzY3YUE3S0NWN1ppVjdKMkVJT3ljb095bmdPMlZ0T3lWdkNEdGxaanJpcFFnN0lPQjdabXBLZXlkaENEcXQ3anJqSURyb1p3ZzY1U3c2NlcwNnJPZ0xDRHNtcFRzbGIzcXM3d2c3S0NFNjZ5NDdKMjBJT3VMcE91bHRPdXB0Q0Rzb0lUcnJManNuWVFnNjVTdzY2VzQ2NHVrWFZ4dUp5QXINCklFZFZTVVJGSUNzZ0oxeHVYRzRuSURvZ0p5Y3BJQ3NLSUNBZ0lDaG1aWGRUYUc5MElEOGdKMXZzbXJEcnBxd2c2NnFwN0lhTTY2YXNJT3lZaU95TG5DRGlnSlFnN0oyMElPMkdwT3lkaENEcmxMRHJwYndnNnJLRFhWeHVKeUFySUdabGQxTm9iM1FnS3lBblhHNWNiaWNnT2lBbkp5a2dLd29nSUNBZ0oreWtnT3U1aE91UWtPeWN2T3VwdENBaVQwc2k2NTI4NnJPZzY2ZU1JT3VMdGUyVm1PdWR2QzRuQ2lBZ0tUc0tmUW9LTHk4ZzRwU0E0cFNBSU95RGdleUxuQ0RyaklEcXVMQWc3WUcwNjZHYzY1T2NJT3lFdU95Rm1DRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQUtiR1YwSUhCeWIyTWdQU0J1ZFd4c095QWdJQ0FnSUNBZ0lDQXZMeUR0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxa0NteGxkQ0JzDQphVzVsUW5WbUlEMGdKeWM3SUNBZ0lDQWdJQ0FnTHk4Z2MzUmtiM1YwSU95a2hDRHJzb1R0amJ3S2JHVjBJSGRoYVhSbGNpQTlJRzUxYkd3N0lDQWdJQ0FnSUNBdkx5RHRtSVRzbnF3ZzdZUzA3SjJZSUhzZ2NtVnpiMngyWlN3Z2NtVnFaV04wTENCMGFXMWxjaUI5Q214bGRDQnhkV1YxWlNBOUlGQnliMjFwYzJVdWNtVnpiMngyWlNncE95QXZMeURzbXBUc3NxMGc3S2VCNjZDczdabVVJQ2pyajVuc2k1d2c3SnFVN0xLdDdKMkFJT3lJbk95RW5PdU1nT3VobkNrS2JHVjBJSFIxY201eklEMGdNRHNLYkdWMElIZGhjbTFsWkZWd0lEMGdabUZzYzJVN0NteGxkQ0JqZFhKeVpXNTBUVzlrWld3Z1BTQkRURUZWUkVWZlRVOUVSVXc3SUM4dklPeW5nT3E0aUNEc2hManNoWmpzbmJRZzY2eTg2ck9nSU95ZWlPdUtsQ0RycXFqcmpiZ2dLT3lhbE95eXJleWR0Q0RyaTZUcnBiZ2c2NnFvNjQyNDdKMkVJT3luZ095Z2xlMlZtT3VwdENEc2hManNoWmdnN0o2czdJdWM3SjZSS1Fvdkx5RHNpNXpzbnBFZzdJdWNJRU5zWVhWaw0KWlNCRGIyUmxLR05zWVhWa1pTQkRURWtwNnJDQUlPeVR1Q0RzaUpnZzdKNkk2NHFVN0tlQUlPeWdrT3F5Z0NEaWdKUWc3SmVHN0p5ODY2bTBJQzlvWldGc2RHanJvWndnN0pXTTY2Q2tJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHNsWWpyZ3JUdGxaenJpNlF1Q2k4dklHNTFiR3c5N1ptVjdKMjRJT3lra1N3Z0oyOXJKejNzZ3F6c21xa2c2ckNBNjRxbExDQW5ZMnhoZFdSbExXMXBjM05wYm1jblBXTnNZWFZrWlNEcnFvWHJvTGtnN0plRzdKMk1MQW92THlBblkyeGhkV1JsTFd4dloyOTFkQ2M5WTJ4aGRXUmw2NHFVSU95ZWlPeW5nT3VuakNEcm9aenF0N2pzbmJnZzdJUzQ3SVdZSU91bmpPdWpqQ0FvN1lTMElPeUxwTzJNcUNEc2k1d2c2ckNRN0tlQUxDRHNoTEhxczdVZzdZUzA3SjIwSU95WXBPdXB0Q0RzbnBEcmo1a2c3WlcwN0tDY0tRcHNaWFFnWTJ4aGRXUmxVM1JoZEhWeklEMGdiblZzYkRzS0x5OGc2NkdjNnJlNDdKMjRJT3Vuak91ampDRHFzSkRzcDRBZzRvQ1VJRU5NU2Vxd2dDRHJnclRyaXBRZzdKaUINCjdKYTBJT3lkdU95bW5TRHNtS1RycFpqcnBid2c3SUtzNjU2TTdKMjBJT3lWak95VmhPdVRwT3lkaENEc2xZanJnclRyb1p3ZzY3Q1U2cjY4NjR1a0xnb3ZMeUFvWTJ4aGRXUmxJQzB0ZG1WeWMybHZidXlkZ0NEcm9aenF0N2pzbmJnZzdKZUc3SjIwNjQrRUlPeUVzZXF6dGUyVnRPeUVuQ0RzaTV6cmo1a2c3S0NRNnJLQTdKeTg2NkdjNjRxVUlPdXF1eURzbnFIcXM2QXNJT3lMcE95Z25DRHRoTFRzbDVEc2hKenJwNHdnNjVPYzY1K3M2NEtjNjR1a0tRb3ZMeUFpNjZlTTY2T01JdXVuak95ZHRDRHNsWVRyaTRqcm5id2dJdTJWbkNEcnNvanJqNFFnNjZHYzZyZTQ3SjI0SU95VmlDRHRsYWdpNjQrRUlPcXdtZXlkZ0NEcXNyM3JvWnpyb1p3ZzdKNmg3WjZJNjYrQTY2R2NJT3lra2V1bXZTRHRrWnp0bUlUc25ZUWc3Sk8wNjR1a0NtTnZibk4wSUV4UFIwbE9YMGRWU1VSRklEMGdKKzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNuYmpzbmJRZzdaV0U3SnFVN1pXMDdKcVVLT3lWaUNEcmtKRHFzYkRyZ3BnZzY2ZU02Nk9NDQpLU0RpZ0pRZ1cvQ2ZuNkFnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdUNEdGxZVHNtcFJkSU91eWhPMkt2T3lkaENEcmlJVHJwYlRycWJRZzY2R2M2cmU0N0oyNElPeXd2ZXlkaENEc2w3VHNsclRyazV6cm9LVHNtcFF1SnpzS0x5OGc3SXVrN0xpaDdaV2NJT3VzdU9xMXJPdVRwRG9nSWtaaGFXeGxaQ0IwYnlCaGRYUm9aVzUwYVdOaGRHVTZJRTlCZFhSb0lITmxjM05wYjI0Z1pYaHdhWEpsWkNCaGJtUWdZMjkxYkdRZ2JtOTBJR0psSUhKbFpuSmxjMmhsWkNJbzY2ZU02Nk9NS1N3S0x5OGdJazV2ZENCc2IyZG5aV1FnYVc0Z3dyY2dVR3hsWVhObElISjFiaUF2Ykc5bmFXNGlLT3V2dU91aG5PcTN1T3lkdUNrZzRvQ1VJT3VSbUNEcmk2UWc3SjZoN1o2STZyS01JT3VFaysyZWpPdUxwQXBtZFc1amRHbHZiaUJwYzBGMWRHaEZjbkp2Y2loektTQjdDaUFnY21WMGRYSnVJQzloZFhSb1pXNTBhV05oZEh4dllYVjBhSHhoY0drZ2EyVjVmR3h2WnlBL2FXNThiRzluWjJWa2ZITmxjM05wYjI0Z1pYaHdhWEpsWkM5cA0KTG5SbGMzUW9VM1J5YVc1bktITXBLVHNLZlFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56NjZXOElPeWR2ZXlXdEFvdkx5QXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZuT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbENEc3BKSHNuYmpzcDRBaUlPMlJuT3lMbkNEaWdKUWc2ck8xN0pxcElGQkQ3SmVRN0lTY0lPdUNxT3lkbUNEcXM0VHNvSlVnN0ppazdJS3M3SnFwSU91d3FleW5nQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHQNCmxaanJyNERyb1p3ZzdKNlE2NCtaSU91d21PeVlnZXVRbk91THBDNEtiR1YwSUdGalkyOTFiblJEWVdOb1pTQTlJSHNnWVhRNklEQXNJR1Z0WVdsc09pQnVkV3hzSUgwN0NtWjFibU4wYVc5dUlHTnNZWFZrWlVGalkyOTFiblFvS1NCN0NpQWdhV1lnS0VSaGRHVXVibTkzS0NrZ0xTQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BDQXpNREF3TUNrZ2NtVjBkWEp1SUdGalkyOTFiblJEWVdOb1pTNWxiV0ZwYkRzS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnFJRDBnU2xOUFRpNXdZWEp6WlNobWN5NXlaV0ZrUm1sc1pWTjVibU1vY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKeTVqYkdGMVpHVXVhbk52YmljcExDQW5kWFJtT0NjcEtUc0tJQ0FnSUdWdFlXbHNJRDBnS0dvZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpLU0I4ZkNCdWRXeHNPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxDQpJT3Vobk9xM3VPeWR1Q0RzbmJUcm9LVWc3SmVHN0oyTUlPdVRzU0RpZ0pRZ2JuVnNiQ0RzbktEc3A0QWdLaThnZlFvZ0lHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJRVJoZEdVdWJtOTNLQ2tzSUdWdFlXbHNJSDA3Q2lBZ2NtVjBkWEp1SUdWdFlXbHNPd3A5Q21aMWJtTjBhVzl1SUdOb1pXTnJRMnhoZFdSbFFYWmhhV3hoWW14bEtDa2dld29nSUdOdmJuTjBJSEJ5YjJKbElEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25MUzEyWlhKemFXOXVKMTBzSUhzZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1ZpQjlLVHNLSUNCc1pYUWdiM1YwSUQwZ0p5YzdDaUFnY0hKdlltVXVjM1JrYjNWMExtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc2diM1YwSUNzOUlHUXVkRzlUZEhKcGJtY29LVHNnZlNrN0NpQWdjSEp2WW1VdWIyNG9KMlZ5Y205eUp5d2dLQ2tnUFQ0Z2V5QmpiR0YxWkdWVGRHRjBkWE1nUFNBblkyeGhkV1JsTFcxcGMzTnBibWNuT3lCOUtUc0tJQ0J3Y205aVpTNXZiaWduWTJ4dg0KYzJVbkxDQW9ZMjlrWlNrZ1BUNGdld29nSUNBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnS0dOdlpHVWdQVDA5SURBZ0ppWWdMMXhrSzF3dVhHUXJMeTUwWlhOMEtHOTFkQ2twSUQ4Z0oyOXJKeUE2SUNkamJHRjFaR1V0YldsemMybHVaeWM3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnUTJ4aGRXUmxJRU52WkdVZzdLQ1E2cktBT2lBbklDc2dZMnhoZFdSbFUzUmhkSFZ6SUNzZ0tHOTFkQ0EvSUNjZ0tDY2dLeUJ2ZFhRdWRISnBiU2dwSUNzZ0p5a25JRG9nSnljcEtUc0tJQ0I5S1RzS2ZRb3ZMeURzc3BqcnBxd2c3WmlFN1ptcElPS0FsQ0F2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWdENBaTdLQ1Y2NmVRSU8yQnRPdWhuT3VUbk9xd2dDRHJpN1h0bG9qcmlwVHNwNEFpSU91d2x1eVhrT3lFbkNEdG1aWHNuYmp0bGFBZzdJaVlJT3llaU9xeWpDRHRsWnpyaTZRS1kyOXVjM1FnYzNSaGRITWdQU0I3SUhObGNuWmxaRG9nTUN3Z2JHRnpkRUYwT2lBbkp5d2diR0Z6ZEZSbGVIUTZJQ2NuTENCc1lYTjANClUyVmpPaUFuSnlCOU93b0tMeThnNHBTQTRwU0FJTzJVak91ZnJPcTN1T3lkdUNEc2c1M3NvYlFnNnJDUTdLZUFLT3lMck95ZXBldXdsZXVQbVNrZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBQ2k4dklPMlVqT3Vmck9xM3VPeWR1T3lkdENEcmxxQWc3SjZJNjRxVUlPdVBtZXlWaUNCamIyUmxMblJ6NnJDQUlEWHN0SWpycDRqcmk2UWdVRTlUVkNBdmFHVmhjblJpWldGMDY2VzhJT3V6dE91Q3VPdUxwQzRLTHk4ZzdaV2NJT3V5aU95ZHRPdWR2T3VQaENEcnNKdnNuWUFnNjVLa0lETXc3TFNJNnJDRUlPdUJpdXE0c091cHRDRHRsSXpybjZ6cXQ3anNuYmdvNjVpUTY0cVVJTzJVdk9xM3VPdW5pQ25zbmJRZzY0dXI3WjZNSU9xeWd5RGlnSlFnN1lHMDY2R2M2NU9jNnJtTTdLZUFJT3VOc091bXJPcXpvQ0Rxc0puc25iUWc2cnE4N0tlRTY0dWtMZ292DQpMeURzbFlUc3A0RWc3WldjSU91eWlPdVBoQ0RycXJzZzY3Q2I3SldZN0p5ODY2bTBLT3VMcE91bXJPdW5qQ0RycUx6c29JQWc3THlnSU95RGdlMkRuQ3dnN0o2UTY0K1o3SXVjN0o2UklPdVRzU2tnNnJPRTdJYU5JT3VNZ09xNHNPMlZuT3VMcEM0S1kyOXVjM1FnU0VWQlVsUkNSVUZVWDBSRlFVUmZUVk1nUFNBek1EQXdNRHNLYkdWMElHeGhjM1JDWldGMElEMGdNRHNLYzJWMFNXNTBaWEoyWVd3b0tDa2dQVDRnZXdvZ0lHbG1JQ2hzWVhOMFFtVmhkQ0FtSmlCRVlYUmxMbTV2ZHlncElDMGdiR0Z6ZEVKbFlYUWdQaUJJUlVGU1ZFSkZRVlJmUkVWQlJGOU5VeWtnZXdvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yVWpPdWZyT3EzdU95ZHVDRHNpNnpzbnFYcnNKWHJqNWtnNjRHSzZybUFJT0tBbENEdGxMenF0N2pycDRndjdaU002NStzNnJlNDdKMjQ3SjIwSU91THErMmVqQ0Rxc29Qc25MenJvWndnNjdPMDZyT2dJT3F3bWV5ZHRDRHF1cnpzcDVIcmk0anJpNlF1SnlrN0NpQWdJQ0J3Y205ag0KWlhOekxtVjRhWFFvTUNrN0lDOHZJR1Y0YVhRZzdaVzQ2NU9rNjUrczZyQ0FJR3RwYkd4UWNtOWo3Snk4NjZHY0lHTnNZWFZrWlNEdGlyanJwcXpycGJ3ZzdLQ1Y2NmFzN1pXYzY0dWtDaUFnZlFwOUxDQTFNREF3S1RzS0NpOHZJT3Vobk9xM3VPeWR1Q0JWVWt6c25ZUWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnQ2pyczdUdGhyVWc3TEM5S2V1aG5DRHNsNnpyaXBRZ1FsSlBWMU5GVWlEdGxianJrNlRybjZ3ZzdJcWs3WUdzNjZhOTdZcTQ2Nlc4SU91bmpPdVRvT3VMcEM0S0x5OGdZMnhoZFdSbElFTk1TZXVLbENCQ1VrOVhVMFZTSU8yWm1PcXl2ZXV6Z095SW1PdWx2Q0Rzb2JUc3BKSHRsYlFnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN1RzcDRBZzdKV0s2ck9nSU95ZHRDRHNpcVR0Z2F6cnByM3RpcmpzbDVBZ1lYVjBhRzl5YVhwbElGVlNUT3lkaENEcmhKanF1TFRyaTZRbzdJdWs3TGloSURJd01qWXRNRGNwTGdvdkx5QnRiMlJsUFNkemQybDBZMmduS09xemhPeWdsU0Rzb0lUdG1aZ3ANCklPS0draURzaXJuc25iZ2c3Wm1VNjZtMDdKMkVJT3F4c095NW1PeW5nQ0RzbFlycXM2QWdLaXJxczRUc29KVWc3SVNnN1lPZElPMlpsT3VwdE95Y3ZPdWhuQ0Ryc0pUcm9ad3FLaURyczdUcmdyanJpNlF1Q2k4dklDQWc2NkdjNnJlNDdKMjQ2NUNjSU95RGdlMkRuT3VwdENCaGRYUm9iM0pwZW1YcXNJQWc3SXE1N0oyNElPMlpsT3VwdE95Y3ZPdWhuQ0Rxc0lEcXM2QWdjMlZzWldOMFFXTmpiM1Z1ZEQxMGNuVmx3cmR3Y205dGNIUTljMlZzWldOMFgyRmpZMjkxYm5Ucm9aenJqNFFnNjZxN0lPdWFxK3ljdk91dmdPdWhuQ2pzaTZUc3VLRXBMQW92THlBZ0lPMlZuQ0R0ZzYwZzdKV0k3SmVRN0lTY0lHTnNZWFZrWlM1aGFTOXNiMmR2ZFhRL2NtVjBkWEp1Vkc4OVBIVnliQzFsYm1OdlpHVmtJQzl2WVhWMGFDOWhkWFJvYjNKcGVtVS9VVlZGVWxrbzdJT0I2NHlBNnJLOTY2R2NLVDdyb1p3ZzdKNkg2NHFVNjR1a09nb3ZMeUFnSU91aG5PcTN1T3lWaE95Ymd5anNoTGpzaFpnZzdLZUE3SnVBS1NEaWhwSWdiRzluDQphVzQvYzJWc1pXTjBRV05qYjNWdWREMTBjblZsS09xemhPeWdsU0RzaEtEdGc1MHA2NkdjSU95ZWtPdVBtU0Rzc3JUc25iVHJpNTBvN0l1azdMaWhPaURyaTZqc25id2c3WU90S1M0ZzdJcTU3SjI0SU8yWmxPdXB0Q0R0bFpqcmk2Z0tMeThnSUNCYjZyT0U3S0NWSU95Z2hPMlptRjBnNjdLRTdZcTg3SjIwSU8yVm1PdUtsQ0RzbmJ6cXM3d2c2ckNaN0oyQUlPcXlzT3F6dkNEaWdKUWc2NHVrNjZlTUlPeWFzT3Vtck9xd2dDRHFzNmZzbnFVZzZyZTRJTzJabE91cHRPeWN2T3VobkNEcnM3VHJncmpyaTZRdUNpOHZJQ0FnS091MmdPeWVrZXlhcVRvZzY3aU02NTI4N0pxdzdLQ0E3SjJZSUdOc1lYVmtaUzVoYVNEc203a2c2NkdjNnJlNDdKMjQ2NCtFSU8yU2dPdW12Q0RpZ0pRZzZyT0U3S0NWSU95Z2hPMlptQ0Rzblpqcmo0VHNtWUFnNjdDcDdaYWw3SjIwSU9xd21leVZoQ0RzaUpqc21xa3VLUW92THlCdGIyUmxQU2R1YjNKdFlXd25LT3Vuak91ampDRHNucXpyb1p6cXQ3anNuYmdwSU9LR2tpRHJvWnpxdDdqcw0KbFlUc200TWc3SmVHN0oyMElPcTN1T3VEcFNEc2w3RHJpNlFvNjR5QTZyQ2NJT3F3bWV5ZGdDRHFzNFRzb0pYc25iVHJuYndnN0lTNDdJV1lJT3ljb095bmdPcXdnQ0RydWFEcnBvUXBMZ3BtZFc1amRHbHZiaUIzY21sMFpVSnliM2R6WlhKSVlXNWtiR1Z5S0cxdlpHVXBJSHNLSUNCamIyNXpkQ0JzYjJkdmRYUWdQU0J0YjJSbElEMDlQU0FuYzNkcGRHTm9KenNLSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdZMjl1YzNRZ1kyMWtJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxaWNtOTNjMlZ5TFNjZ0t5QnRiMlJsSUNzZ0p5NWpiV1FuS1RzS0lDQWdJR052Ym5OMElIQnpJRDBnYkc5bmIzVjBDaUFnSUNBZ0lEOGdJaVIxUFNSbGJuWTZRMEpmVlZKTU95QWthVDBrZFM1SmJtUmxlRTltS0NkdllYVjBhQzloZFhSb2IzSnBlbVVuS1RzZ2FXWW9KR2tnTFdkbElEQXBleUFrY21Wc1BTY3ZKeXNrZFM1VGRXSnoNCmRISnBibWNvSkdrcE95QWtaVzVqUFZ0VGVYTjBaVzB1VlhKcFhUbzZSWE5qWVhCbFJHRjBZVk4wY21sdVp5Z2tjbVZzS1RzZ1UzUmhjblF0VUhKdlkyVnpjeUFvSjJoMGRIQnpPaTh2WTJ4aGRXUmxMbUZwTDJ4dloyOTFkRDl5WlhSMWNtNVViejBuS3lSbGJtTXBJSDBnWld4elpTQjdJRk4wWVhKMExWQnliMk5sYzNNZ0pIVWdmU0lLSUNBZ0lDQWdPaUFuVTNSaGNuUXRVSEp2WTJWemN5QWtaVzUyT2tOQ1gxVlNUQ2M3Q2lBZ0lDQm1jeTUzY21sMFpVWnBiR1ZUZVc1aktHTnRaQ3dnSjBCbFkyaHZJRzltWmx4eVhHNXpaWFFnSWtOQ1gxVlNURDBsZmpFaVhISmNibkJ2ZDJWeWMyaGxiR3dnTFU1dlVISnZabWxzWlNBdFJYaGxZM1YwYVc5dVVHOXNhV041SUVKNWNHRnpjeUF0UTI5dGJXRnVaQ0FpSnlBcklIQnpJQ3NnSnlKY2NseHVKeWs3Q2lBZ0lDQnlaWFIxY200Z1kyMWtPd29nSUgwS0lDQmpiMjV6ZENCemFDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0DQpZbkp2ZDNObGNpMG5JQ3NnYlc5a1pTQXJJQ2N1YzJnbktUc0tJQ0JqYjI1emRDQnViMlJsUW1sdUlEMGdjSEp2WTJWemN5NWxlR1ZqVUdGMGFEc2dMeThnN0tDRUlFOVQ3SmVRSUc1dlpHVWc3SjZJN0oyTUtPdUxwT3Vtck9xd2dDQnViMlJsNjZHY0lPdVBqaWt1SU91emdPMlptQ0RzaTZUdGpLZ2c3SXVjSU95YmtPdXp1Q0JWVWt3ZzZyZTQ2NHlBNjZHY0lPeVhzT3VMcENobVlXbHNMWE52Wm5RcExnb2dJR052Ym5OMElHSnZaSGtnUFNCc2IyZHZkWFFLSUNBZ0lEOGdKeU1oTDJKcGJpOXphRnh1SnlBckNpQWdJQ0FnSUNkVlBTUW9JaWNnS3lCdWIyUmxRbWx1SUNzZ0p5SWdMV1VnWENkamIyNXpkQ0IxUFhCeWIyTmxjM011WVhKbmRsc3hYVHRqYjI1emRDQnBQWFV1YVc1a1pYaFBaaWdpYjJGMWRHZ3ZZWFYwYUc5eWFYcGxJaWs3Y0hKdlkyVnpjeTV6ZEdSdmRYUXVkM0pwZEdVb2FUd3dQM1U2SW1oMGRIQnpPaTh2WTJ4aGRXUmxMbUZwTDJ4dloyOTFkRDl5WlhSMWNtNVViejBpSzJWdVkyOWtaVlZTU1VOdg0KYlhCdmJtVnVkQ2dpTHlJcmRTNXpiR2xqWlNocEtTa3BYQ2NnSWlReElpQXlQaTlrWlhZdmJuVnNiQ2xjYmljZ0t3b2dJQ0FnSUNBbmIzQmxiaUFpSkh0Vk9pMGtNWDBpWEc0bkNpQWdJQ0E2SUNjaklTOWlhVzR2YzJoY2JtOXdaVzRnSWlReElseHVKenNLSUNCbWN5NTNjbWwwWlVacGJHVlRlVzVqS0hOb0xDQmliMlI1S1RzS0lDQm1jeTVqYUcxdlpGTjVibU1vYzJnc0lEQnZOelUxS1RzS0lDQnlaWFIxY200Z2MyZzdDbjBLQ2k4dklPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN1pTRTY2R2M3SVM0N0lxa0lDaGpiR0YxWkdVZ1lYVjBhQ0JzYjJkcGJpQXRMV05zWVhWa1pXRnBLU0RpZ0pRZ0wyOXdaVzR0Ykc5bmFXN3NuYlFnN0lPZDdJU3h3cmZxdElEcnBxd3VDaTh2SU91NGpPdWR2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPdXp0T3VDdE95a2hDRHJsWXpxdVl6c3A0QWc3SWlvN0phMDdJU2NJT3VNZ09xNHNPMlZtT3VMcE9xd2dDd2c3Sm1FNjZPTTY1Q1kNCjY2bTBJT3lLcE95S3BPdWhuQ0RyZ1ozcmdwenJpNlF1Q214bGRDQnNiMmRwYmxCeWIyTWdQU0J1ZFd4c093cHNaWFFnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J1ZFd4c093cHNaWFFnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQU0F3T3lBdkx5RHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU95TG5PeWVrU0RzaTV6cXNJRWc0b0NVSU95ZXJPMkJ0T3VtcmV5ZHRDQW43SjZzN0l1YzY0K0VKK3lkdU95bmdDQW43SjZRNjQrWjdKbUU2Nk9NSU95THBPMk1xQ2ZzbmJqc3A0QWc2cldzNjdhRTdaV2M2NHVrQ21aMWJtTjBhVzl1SUd0cGJHeE1iMmRwYmxCeWIyTW9LU0I3Q2lBZ2FXWWdLR3h2WjJsdVVISnZZMVJwYldWeUtTQjdJR05zWldGeVZHbHRaVzkxZENoc2IyZHBibEJ5YjJOVWFXMWxjaWs3SUd4dloybHVVSEp2WTFScGJXVnlJRDBnYm5Wc2JEc2dmUW9nSUdsbUlDZ2hiRzluYVc1UWNtOWpLU0J5WlhSMWNtNDdDaUFnWTI5dWMzUWdjQ0E5SUd4dloybHVVSEp2WXpzS0lDQnNiMmRwYmxCeWIyTWdQU0J1DQpkV3hzT3dvZ0lIUnllU0I3Q2lBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNCemNHRjNibE41Ym1Nb0ozUmhjMnRyYVd4c0p5d2dXeWN2VUVsRUp5d2dVM1J5YVc1bktIQXVjR2xrS1N3Z0p5OVVKeXdnSnk5R0oxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3dvZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ2RISjVJSHNnY0hKdlkyVnpjeTVyYVd4c0tDMXdMbkJwWkN3Z0oxTkpSMVJGVWswbktUc2dmU0JqWVhSamFDQW9YMlV5S1NCN0lIQXVhMmxzYkNncE95QjlDaUFnSUNCOUNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c2NnkwN0l1Y0lDb3ZJSDBLZlFvS1puVnVZM1JwYjI0Z2EybHNiRkJ5YjJNb0tTQjdDaUFnYVdZZ0tIQnliMk1wSUhzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJQ0FnTHk4Z2MyaGxiR3c2ZEhKMVpldWhuQ0RybllUcw0KbTR6c2hKd2djSEp2WSt5ZGdDQmpiV1FnNnJ1TjY0Mnc2cml3SU9LQWxDQXZWT3VobkNEdGlyanJwcXpzcDdnZzdLTzk3SmVzN0pXOElPeW5oT3lubkNCamJHRjFaR1hxc0lBZzZyT2c3SldFNjZHY0lPeVZpQ0RyZ3FqcmlwVHJpNlFLSUNBZ0lDQWdJQ0F2THlBbzZyT2c3SldFSUdOc1lYVmtaZXF3Z0NEc2hLVHN1WmdnN1l5TTdKMjg3SjJFSU91c3ZPcXpvQ0Rzbm9qc25MenJxYlFnN1lHMDY2R2M2NU9jSU95VnNTRHNsNFhyamJEc25iVHRpcmpxc0lBZ0l1eUNyT3lhcVNEc3BKRWk3Snk4NjZHY0lPdW5pZTJlbUNrS0lDQWdJQ0FnSUNCemNHRjNibE41Ym1Nb0ozUmhjMnRyYVd4c0p5d2dXeWN2VUVsRUp5d2dVM1J5YVc1bktIQnliMk11Y0dsa0tTd2dKeTlVSnl3Z0p5OUdKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE93b2dJQ0FnSUNCOUlHVnNjMlVnZXdvZ0lDQWdJQ0FnSUM4dklHMWhZMDlUTCt1bXJPdUloZXlLcERvZ2MyaGxiR3c2ZEhKMVpldWR2Q0J3Y205ajdKMjBJSE5vSU9xN2pldU4NCnNPcTRzT3lkdkNEc2lKZ2c3SjZJN0oyTUlPS0FsQ0J6ZEdGeWRGQnliMlBzblpnZ1pHVjBZV05vWldUcm9ad2c2NmVNNjVPZ0NpQWdJQ0FnSUNBZ0x5OGc3WlNFNjZHYzdJUzQ3SXFrSU9xM3VPdWp1U2d0Y0dsa0tleWRoQ0R0aHJYc3A3anJvWndnN0tDVjY2YXM3WldjNjR1a0lDaDBZWE5yYTJsc2JDQXZWQ0RyaklEc25aRXBDaUFnSUNBZ0lDQWdkSEo1SUhzZ2NISnZZMlZ6Y3k1cmFXeHNLQzF3Y205akxuQnBaQ3dnSjFOSlIxUkZVazBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3SUhCeWIyTXVhMmxzYkNncE95QjlDaUFnSUNBZ0lIMEtJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91c3RPeUxuQ0FxTHlCOUNpQWdmUW9nSUhCeWIyTWdQU0J1ZFd4c093b2dJSGRoY20xbFpGVndJRDBnWm1Gc2MyVTdDaUFnYVdZZ0tIZGhhWFJsY2lrZ2V5QmpiR1ZoY2xScGJXVnZkWFFvZDJGcGRHVnlMblJwYldWeUtUc2dkMkZwZEdWeUxuSmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNoTGpzDQpoWmpzbmJRZzdLS0Y2Nk9NNjVDUTdKYTA3SnFVTGljcEtUc2dkMkZwZEdWeUlEMGdiblZzYkRzZ2ZRcDlDZ3BtZFc1amRHbHZiaUJ6ZEdGeWRGQnliMk1vS1NCN0NpQWdhMmxzYkZCeWIyTW9LVHNLSUNCc2FXNWxRblZtSUQwZ0p5YzdDaUFnZEhWeWJuTWdQU0F3T3dvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT3lMbk91UG1TRHNwSkhpZ0tZZ0tPdXFxT3VOdURvZ0p5QXJJR04xY25KbGJuUk5iMlJsYkNBcklDY3BKeWs3Q2lBZ1kyOXVjM1FnZEdocGMxQnliMk1nUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3ljdGNDY3NJQ2N0TFcxdlpHVnNKeXdnWTNWeWNtVnVkRTF2WkdWc0xDQW5MUzFwYm5CMWRDMW1iM0p0WVhRbkxDQW5jM1J5WldGdExXcHpiMjRuTENBbkxTMXZkWFJ3ZFhRdFptOXliV0YwSnl3Z0ozTjBjbVZoYlMxcWMyOXVKeXdnSnkwdGRtVnlZbTl6WlNkZExDQjdDaUFnSUNCemFHVnNiRG9nZEhKMVpTd2dZM2RrT2lCRlRWQlVXVjlEVjBRcw0KSUdWdWRqb2dRMHhCVlVSRlgwVk9WaXdLSUNBZ0lHUmxkR0ZqYUdWa09pQndjbTlqWlhOekxuQnNZWFJtYjNKdElDRTlQU0FuZDJsdU16SW5MQ0F2THlCUVQxTkpXRG9nN0o2UTZyaXdJTzJVaE91aG5PeUV1T3lLcENEcXQ3anJvN2tnN0lPZDdJU3hJT0tBbENCcmFXeHNVSEp2WSt5ZHRDRHF0N2pybzduc3A3Z2c3S0NWNjZhczdaV2dJT3lJbUNEc25vanFzb3dLSUNCOUtUc0tJQ0J3Y205aklEMGdkR2hwYzFCeWIyTTdDaUFnY0hKdll5NXpkR1J2ZFhRdWIyNG9KMlJoZEdFbkxDQW9aQ2tnUFQ0Z2V3b2dJQ0FnYkdsdVpVSjFaaUFyUFNCa0xuUnZVM1J5YVc1bktDZDFkR1k0SnlrN0NpQWdJQ0JzWlhRZ2FXUjRPd29nSUNBZ2QyaHBiR1VnS0NocFpIZ2dQU0JzYVc1bFFuVm1MbWx1WkdWNFQyWW9KMXh1SnlrcElDRTlQU0F0TVNrZ2V3b2dJQ0FnSUNCamIyNXpkQ0JzYVc1bElEMGdiR2x1WlVKMVppNXpiR2xqWlNnd0xDQnBaSGdwTG5SeWFXMG9LVHNLSUNBZ0lDQWdiR2x1WlVKMVppQTlJR3hwYm1WQ2RXWXUNCmMyeHBZMlVvYVdSNElDc2dNU2s3Q2lBZ0lDQWdJR2xtSUNnaGJHbHVaU2tnWTI5dWRHbHVkV1U3Q2lBZ0lDQWdJR3hsZENCbGRpQTlJRzUxYkd3N0NpQWdJQ0FnSUhSeWVTQjdJR1YySUQwZ1NsTlBUaTV3WVhKelpTaHNhVzVsS1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnWTI5dWRHbHVkV1U3SUgwS0lDQWdJQ0FnYVdZZ0tHVjJJQ1ltSUdWMkxuUjVjR1VnUFQwOUlDZHlaWE4xYkhRbklDWW1JSGRoYVhSbGNpa2dld29nSUNBZ0lDQWdJR052Ym5OMElIY2dQU0IzWVdsMFpYSTdDaUFnSUNBZ0lDQWdkMkZwZEdWeUlEMGdiblZzYkRzS0lDQWdJQ0FnSUNCamJHVmhjbFJwYldWdmRYUW9keTUwYVcxbGNpazdDaUFnSUNBZ0lDQWdhV1lnS0dWMkxtbHpYMlZ5Y205eUtTQjdDaUFnSUNBZ0lDQWdJQ0JqYjI1emRDQnlZWGNnUFNCVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElHVjJMbk4xWW5SNWNHVWdmSHdnSnljcExuTnNhV05sS0RBc0lESXdNQ2s3Q2lBZ0lDQWdJQ0FnSUNCcFppQW9hWE5CZFhSb1JYSnliM0lvDQpjbUYzS1NrZ2V3b2dJQ0FnSUNBZ0lDQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW5ZMnhoZFdSbExXeHZaMjkxZENjN0lDOHZJQzlvWldGc2RHanJvWndnN1pTTTY1K3M2cmU0N0oyNDdKZVFJT3lWak91bXZDRGlocElnNjdLRTdZcTg3SjIwSUZ2cm9aenF0N2pzbmJnZzdaV0U3SnFVWGV1aG5DRHJzSlRyZ0p3S0lDQWdJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJnZzY2ZU02Nk9NSU9xd2tPeW5nRG9uTENCeVlYY3BPd29nSUNBZ0lDQWdJQ0FnSUNCM0xuSmxhbVZqZENodVpYY2dSWEp5YjNJb1RFOUhTVTVmUjFWSlJFVXBLVHNLSUNBZ0lDQWdJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243WUcwNjZHYzY1T2NJT3lZcE91bG1Eb2dKeUFySUhKaGR5a3BPd29nSUNBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJQ0FnSUNCamJHRjFaR1ZUZEdGMA0KZFhNZ1BTQW5iMnNuT3lBdkx5RHNoTEhxczdVZ1BTRHNoS1RzdVpqQ3QrdWhuT3EzdU95ZHVDRHJpNlFnN0tDVjdJT0JJT0tBbENEc2xyVHJscVFnY0hKdllteGxiZXlkdE91VG9DRHRsYlRzb0p3Z0tPeWVyT3Vobk9xM3VPeWR1Qy9zbnF6c2hLVHN1WmdnNjdPMTZyZUFLUW9nSUNBZ0lDQWdJQ0FnZHk1eVpYTnZiSFpsS0ZOMGNtbHVaeWhsZGk1eVpYTjFiSFFnZkh3Z0p5Y3BLVHNLSUNBZ0lDQWdJQ0I5Q2lBZ0lDQWdJSDBLSUNBZ0lIMEtJQ0I5S1RzS0lDQndjbTlqTG5OMFpHVnljaTV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCeklEMGdaQzUwYjFOMGNtbHVaeWduZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUdsbUlDaHpJQ1ltSUNGekxtbHVZMngxWkdWektDZEVaWEJ5WldOaGRHbHZibGRoY201cGJtY25LU2tnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElHTnNZWFZrWlNCemRHUmxjbkk2Snl3Z2N5NXpiR2xqWlNnd0xDQXlNREFwS1RzS0lDQjlLVHNLSUNCd2NtOWoNCkxtOXVLQ2RqYkc5elpTY3NJQ2hqYjJSbEtTQTlQaUI3Q2lBZ0lDQXZMeURzbmJUcnI3Z2c3SU9JSU95RXVPeUZtT3ljdk91aG5DRHF0WkRzc3JUcmtKd2c2NUtrSU95WW15RHNoTGpzaFpqc25iUWc2NHVyN1o2TUlPcXhzT3VwdENEcnJMVHNpNXdnS091cXFPdU51Q0Rzb0lUdG1aZ2c3SXVjSU95RGlDRHNoTGpzaFpqc25ZUWc3S085N0oyMDdLZUFJT3lWaXVxeWpDa0tJQ0FnSUdsbUlDaHdjbTlqSUNFOVBTQjBhR2x6VUhKdll5a2djbVYwZFhKdU93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHNoTGpzaFpnZzdLS0Y2Nk9NSUNoamIyUmxJQ2NnS3lCamIyUmxJQ3NnSnlrZzRvQ1VJT3VMcE95ZGpDRHNtcFRzc3EwZzY1V01JT3VMcE95TG5DRHNpNXpyajVudGxhbnJpNGpyaTZRdUp5azdDaUFnSUNCcmFXeHNVSEp2WXlncE93b2dJSDBwT3dwOUNncG1kVzVqZEdsdmJpQnpaVzVrVkhWeWJpaDBaWGgwS1NCN0NpQWdjbVYwZFhKdUlHNWxkeUJRY205dGFYTmxLQ2h5DQpaWE52YkhabExDQnlaV3BsWTNRcElEMCtJSHNLSUNBZ0lHbG1JQ2doY0hKdll5a2djbVYwZFhKdUlISmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNoTGpzaFpqc25iUWc3SmVHN0phMDdKcVVMaWNwS1RzS0lDQWdJR2xtSUNoM1lXbDBaWElwSUhKbGRIVnliaUJ5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2ZzbFo3c2hLQWc3SnFVN0xLdDdKMjBJT3luaE8yV2lTRHNwSkhzbmJUc2w1RHNtcFF1SnlrcE93b2dJQ0FnWTI5dWMzUWdkR2x0WlhJZ1BTQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJFdENEc2k1enFzSVFnN0xTSTZyTzhJT0tBbENEc2hManNoWmpzbllRZzdKNnM3SXVjN0o2UjdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ2ZTd2dWRlZTVGw5VVNVMUZUMVZVWDAxVEtUc0tJQ0FnSUhkaGFYUmxjaUE5SUhzZ2NtVnpiMngyWlN3Z2NtVnFaV04wTENCMGFXMWxjaUI5T3dvZw0KSUNBZ2NISnZZeTV6ZEdScGJpNTNjbWwwWlNoS1UwOU9Mbk4wY21sdVoybG1lU2g3SUhSNWNHVTZJQ2QxYzJWeUp5d2diV1Z6YzJGblpUb2dleUJ5YjJ4bE9pQW5kWE5sY2ljc0lHTnZiblJsYm5RNklIUmxlSFFnZlNCOUtTQXJJQ2RjYmljc0lDZDFkR1k0SnlrN0NpQWdmU2s3Q24wS0NpOHZJT3F3bWV5ZGdDRHJyTGpxdGF6cnBid2c2NnFISU91eWlPeW51Q0Ryckx2cmlwVHNwNEFnNnJpdzdKYTFJT0tBbENEc25xenNtcFRzc3Ezc25iVHJxYlFnSXV5ZHRPeWdoT3F6dkNEcmk2VHJwYmdnN0lPSUlPeWduT3lWaUNMc25ZUWc3SnFVNnJXczdaV2M2NHVrQ2k4dklDanNsWWdnNnJlNDY1K3M2Nm0wSU8yQnRPdWhuT3VUbk9xd2dDRHNoTEhzaTZUdGxaanFzb3dnNnJDWjdKMkFJT3VMdGV5ZGhDRHJtSkFnNjRLMDdJU2NJRnRCU1NEc3RwVHNzcHdnNjQyVUlPdXdtK3E0c0YzcXNJQWc2NnkwN0oyWTY2KzQ3WlcwN0tlRTY0dWtLUXBqYjI1emRDQmhjMnRsWkVOdmRXNTBJRDBnYm1WM0lFMWhjQ2dwT3dvS0x5OGcNCjdJUzQ3SVdZSU95a2dPdTVoQ2pzaTV6cmo1a3I3S2VBN0l1YzY2eTRJT3lqdk95ZWhTbnJwYndnNjdPMDdKNmw3WldjSU91U3BDRHRsWndnN1lTMElPeUxwTzJXaVNEaWdKUWc2NnFvNjVPZ0lPMll1T3kybk95ZGdDQnhkV1YxWmV1aG5DRHNwNEhyb0t6dG1aUXVDaTh2SUcxdlpHVnM3SjJFSU95anZPdXB0Q0RxdDdnZzY2cW82NDI0NjZHY0lDanJpNlRycGJUcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTa3VJTzJWbkNEcnFxanJqYmpzbllRZzZyT0U3SWFOSU95VHNPdXB0Q0RzbnF6c2k1enNucEhzbllBZzdMV2M3TFNJSURIdG1venJ2NUF1Q21aMWJtTjBhVzl1SUhKMWJsUjFjbTRvWW5WcGJHUkJjMnNzSUcxdlpHVnNLU0I3Q2lBZ1kyOXVjM1FnYW05aUlEMGdjWFZsZFdVdWRHaGxiaWhoYzNsdVl5QW9LU0E5UGlCN0NpQWdJQ0JwWmlBb2JXOWtaV3dnSmlZZ1FVeE1UMWRGUkY5TlQwUkZURk11YVc1a1pYaFBaaWh0YjJSbGJDa2dJVDA5SUMweElDWW1JRzF2WkdWc0lDRTlQU0JqZFhKeVpXNTBUVzlrDQpaV3dwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdXFxT3VOdUNEcnM0RHFzcjA2SUNjZ0t5QmpkWEp5Wlc1MFRXOWtaV3dnS3lBbklPS0draUFuSUNzZ2JXOWtaV3dwT3dvZ0lDQWdJQ0JqZFhKeVpXNTBUVzlrWld3Z1BTQnRiMlJsYkRzS0lDQWdJQ0FnYzNSaGNuUlFjbTlqS0NrN0lDOHZJT3lEaUNEcnFxanJqYmpyb1p3ZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NBbzY0dWs3SjJNSU95YmpPdXdqZXlYaGV5WGtPeUVuQ0RzcDREc2k1enJyTGdnN0o2czdLTzg3SjZGS1FvZ0lDQWdmUW9nSUNBZ2FXWWdLSFIxY201eklENDlJRTFCV0Y5VVZWSk9VeUI4ZkNBaGNISnZZeWtnYzNSaGNuUlFjbTlqS0NrN0NpQWdJQ0JwWmlBb0lYZGhjbTFsWkZWd0tTQjdDaUFnSUNBZ0lHTnZibk4wSUhRd0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lDQWdZWGRoYVhRZ2MyVnVaRlIxY200b2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa3BPd29nSUNBZ0lDQjNZWEp0WldSVmNDQTlJSFJ5ZFdVNw0KQ2lBZ0lDQWdJSFIxY201ekt5czdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haZ2c3S1NBNjdtRUlPeVpoT3VqakNBb0p5QXJJQ2dvUkdGMFpTNXViM2NvS1NBdElIUXdLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2tnS3lBbmN5a2c0b0NVSU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjdtbzY1Mjg3SnFVTGljcE93b2dJQ0FnZlFvZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUhKbGRIVnliaUJ6Wlc1a1ZIVnliaWhpZFdsc1pFRnpheWdwS1RzS0lDQjlLVHNLSUNBdkx5RHRsWndnN0pxVTdMS3Q3SjIwSU95THBPMk1xTzJWdE91UGhDRHJpNlRzbll3ZzdKcVU3TEt0N0oyMElPeWR0T3lXdE95bmdPdVBoT3VoblNEdGdaRHJpcFFnN1pXdDdJT0JJT3lFc2VxenRleWN2T3VobkNEc29KWHJwcXdLSUNCeGRXVjFaU0E5SUdwdllpNWpZWFJqYUNnb0tTQTlQaUI3ZlNrN0NpQWdjbVYwZFhKdUlHcHZZanNLZlFvS0x5OGc2Nnk0NnJXc0lPeTJsT3l5bkNEdGhMUUtablZ1WTNScGIyNGcNCllYTnJRMnhoZFdSbEtIUmxlSFFzSUcxdlpHVnNLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2gwWlhoMEtTQjhmQ0F3S1NBcklERTdDaUFnSUNCaGMydGxaRU52ZFc1MExuTmxkQ2gwWlhoMExDQmhkSFJsYlhCMEtUc0tJQ0FnSUdsbUlDaGhjMnRsWkVOdmRXNTBMbk5wZW1VZ1BpQXlNREFwSUdGemEyVmtRMjkxYm5RdVkyeGxZWElvS1RzZ0x5OGc2NnkwN1pXYzdaNklJT3lNayt5ZHRPeW5nQ0RzbFlycXNvd0tJQ0FnSUhKbGRIVnliaUJoZEhSbGJYQjBJRDRnTVFvZ0lDQWdJQ0EvSUNmcXNKbnNuWUFnNjZ5NDZyV3M2Nlc4SU91THBPeUxuQ0RzbXBUc3NxM3RsWnpyaTZRdUlPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA3S0NFN0plUUlPeWduT3lWaU8yV2lPdU5tQ0Rxc29Qcms2VHFzN3dnNnJLNTdMbVk3S2VBSU95Vml1dUtsQ3dnNnJXczdLR3c2NEtZSU95V3RPMmNtT3F3Z0NEdG1aWHNpNlR0DQpub2dnNjR1azY2VzRJT3lEaU91aG5PeWF0Q0RyaklEc2xZZ2dNK3F3bk91bHZDRHF0NXpzdVpucmpJRHJvWndnU2xOUFRpRHJzTERzbDdUcm9aenJwNHc2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLUW9nSUNBZ0lDQTZJQ2ZyaTZUc25Zd2dWVWtnNjZ5NDZyV3M3SjJZSU91TWdPeVZpQ0F6NnJDYzY2VzhJT3Ezbk95NW1ldU1nT3VobkNCS1UwOU9JT3V3c095WHRPdWhuT3VuakRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwT3dvZ0lIMHNJRzF2WkdWc0tUc0tmUW9LTHk4ZzY3S0k3SmV0SU8yRXRDRGlnSlFnNnJDWjdKMkFJT3lFdU95Rm1PeWRoQ0RzazdEcmtKZ3NJT3lkdE91eWlDRHRoTFRycDR3ZzdMYVU3TEtjSU8yWWxleUxuU2hLVTA5T0lPdXdzT3lYdENrZzY0eUE3SXVnSU91eWlPeVhyU0R0bUpYc2k1MG9TbE5QVGlEcXNKM3NzclFwN0oyRUlPeWFsT3Exck8yVm5PdUxwQXBtZFc1amRHbHZiaUJoYzJ0VWNtRnVjMnhoZEdVb2RHVjRkQ3dnYlc5a1pXd3BJSHNLSUNCeQ0KWlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlBb0NpQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0Ryc29qc2w2MGc3SjZSN0plRjdKMjA2NHVrSUNqcnJManF0YXdnNjR1azY1T3M2cml3SU95VmhPdUxtQ0RpZ0pRZzY0eUE3SldJSURQcXNKd2c2cmVjN0xtWjdKMkFJT3lkdE91eWlDRHRoTFRzbDVBZzdLQ0I3SnFwN1pXWTdLZUFJT3lWaXV1S2xPdUxwQ2t1SUNjZ0t3b2dJQ0FnSit1THBPeWRqQ0JWU1NEcnJManF0YXpxc0lBZzdaV2M2cld0N0phMDY2bTBJT3lla095WHNPeUtwT3Vmck95YXRDRHNtSUhzbHJUcm9ad3NJT3lZZ2V5V3RPdXB0Q0RzbnBEc2w3RHNpcVRybjZ6c21yUWc3WldjNnJXdDdKYTA2NkdjSU91eWlPeVhyZTJWbU91ZHZDNGdKeUFyQ2lBZ0lDQW5WVWtnNjZ5NDZyV3M2NHVrN0pxMElPcXdoT3F5c08yVm5DRHRrWnp0bUlUc25ZUWc3Sk93NnJPZ0xDRHNuYlRycG9UQ3QreUlxK3lla01LMzY2ZUk3SXFrN1lLNXdyZnRsSXpyb0lqc25iVHNpcVR0bVlEcmpaVHJpcFFnNnJlNDY0eUENCjY2R2NJT3V6dE95aHRPMlZuT3VMcEM0Z0p5QXJDaUFnSUNBbjdKdVE2Nnk0N0oyWUlPeWtoQ0RzaUpqcnBid2c2cmU0NjR5QTY2R2NJT3ljb095bmdPMlZuT3VMcENEaWdKUWc3SnVRNjZ5NDdKMjBJTzJWbkNEc3BJVHNuYlRycWJRZzY3S0k3SmV0NjQrRUlPMlZuQ0RzcElUcm9ad3NJT3lraE91d2xPcS9pT3lkaENEc25vVHNuWmpyb1p3ZzdMYVU2ckNBN1pXWTdLZUFJT3lWaXV1S2xPdUxwQzRnSnlBckNpQWdJQ0FuNjR1MTdKMkFJT3V3bU91VG5PeUxuQ0JLVTA5T0lPcXduZXl5dENEdGxaanJncGpycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaFNEcXVJanNwNEE2SUNjZ0t3b2dJQ0FnSjNzaWRISmhibk5zWVhSbFpDSTZJQ0xyc29qc2w2M3JyTGdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0ltUnBjbVZqZEdsdmJpSTZJQ0pyYitLR2ttVnVJT3VZa091S2xDQmxidUtHa210dkluMDZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtRb2dJQ2tzDQpJRzF2WkdWc0tUc0tmUW9LTHk4ZzY3S0k3SmV0SU95ZGtldUx0ZXlYa095RW5DQjdkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1ZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxWSEpoYm5Oc1lYUmxLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQjBjbUZ1YzJ4aGRHVmtJRDBnVTNSeWFXNW5LQ2h2SUNZbUlHOHVkSEpoYm5Oc1lYUmxaQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tUc0tJQ0FnSUdsbQ0KSUNoMGNtRnVjMnhoZEdWa0tTQnlaWFIxY200Z2V5QjBjbUZ1YzJ4aGRHVmtMQ0JrYVhKbFkzUnBiMjQ2SUZOMGNtbHVaeWdvYnlBbUppQnZMbVJwY21WamRHbHZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95VmhPdWVtT3VobkNBcUx5QjlDaUFnY21WMGRYSnVJRzUxYkd3N0NuMEtDaTh2SU95ZGtldUx0ZXlYa095RW5DQjdkR1Y0ZEN3Z2NtVmhjMjl1ZlNEcnNMRHNsN1FnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpWTjFaMmRsYzNScGIyNXpLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNXMXRjYzF4VFhTcGNYUzhwT3dvZ0lHbG0NCklDaHRLU0J6SUQwZ2JWc3dYVHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnWVhKeUlEMGdTbE5QVGk1d1lYSnpaU2h6S1RzS0lDQWdJR2xtSUNoQmNuSmhlUzVwYzBGeWNtRjVLR0Z5Y2lrcElIc0tJQ0FnSUNBZ2NtVjBkWEp1SUdGeWNnb2dJQ0FnSUNBZ0lDNXRZWEFvS0hncElEMCtJQ2g3SUhSbGVIUTZJRk4wY21sdVp5Z29lQ0FtSmlCNExuUmxlSFFwSUh4OElDY25LUzUwY21sdEtDa3NJSEpsWVhOdmJqb2dVM1J5YVc1bktDaDRJQ1ltSUhndWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1FvZ0lDQWdJQ0FnSUM1bWFXeDBaWElvS0hncElEMCtJSGd1ZEdWNGRDazdDaUFnSUNCOUNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3SldFNjU2WTY2R2NJQ292SUgwS0lDQnlaWFIxY200Z1cxMDdDbjBLQ2k4dklPdWhuT3EzdU95ZHVDRHRsWVRzbXBRZzdJT0I3WU9jN0oyOElPdVZqQ0F2YUdWaGJIUm9JT3loc08yYWpPcXdnQ0RzbUtUcnFiUWc2NUtrN0plUTdJU2NJT3liak91d2pleVhoZXlkDQpoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzA2N080NjR1a0lDZ3pNT3kwaU95WGtDQXg2N0tJNjZlTUtTNEtMeThnN0lTeDZyTzE3WldZNjZtMElPcXlzT3F6dkNEdGxianJrNlRybjZ6cXNJQWdZMnhoZFdSbFUzUmhkSFZ6UFNkdmF5ZnJvWndnNjVDWTY0K002NmFzNjYrQTY2R2NMQ0RzbnF6cm9aenF0N2pzbmJnZzdadUVJT3V5aE8yS3ZPeWR0Q0Rzb0lEc29JanJvWndnOEorZm91eWN2T3VobkNEcnM3WHF0NER0bFp6cmk2UXVDaTh2SUNqdGxJenJuNnpxdDdqc25ianNuYlFnNjZHYzZyZTQ3SjI0SU95d3ZleWRoQ0RzbDdBZzY1S2tJT3lqdk9xNHNPeWdnZXljdk91aG5DQXZhR1ZoYkhSbzY2VzhJT3loc08yYWpPMlZtT3VLbENEcXNvUHFzN3dnN0tlZDdKMkVJT3lkdE91anJPdUxwQ2tLYkdWMElHeGhjM1JCZFhSb1VtVjBjbmxCZENBOUlEQTdDbVoxYm1OMGFXOXVJSEpsZEhKNVFYVjBhRWxtVG1WbFpHVmtLQ2tnZXdvZ0lHbG1JQ2hqYkdGMVpHVlRkR0YwZFhNZ0lUMDlJQ2RqYkdGMVpHVXRiRzluYjNWMA0KSnlrZ2NtVjBkWEp1T3dvZ0lHbG1JQ2gzWVdsMFpYSWdmSHdnUkdGMFpTNXViM2NvS1NBdElHeGhjM1JCZFhSb1VtVjBjbmxCZENBOElETXdNREF3S1NCeVpYUjFjbTQ3SUM4dklPeW5oTzJXaVNEc3BKRWc3WVMwSU91d3FlMlZ0Q0RxdUlqc3A0QWdLeUF6TU95MGlDRHFzSVRxc3FrS0lDQnNZWE4wUVhWMGFGSmxkSEo1UVhRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25iZ2c3SjZzN1ptVjdKMjRJT3lMbk91UGhPS0FwaWNwT3dvZ0lISjFibFIxY200b0tDa2dQVDRnSit1aG5PcTN1T3lkdUNEdG1aWHNuYmpzbXFuc25iVHJpNlF1SUNKUFN5THJuYnpxczZEcnA0d2c2NHUxN1pXWTY1MjhMaWNwTG5Sb1pXNG9DaUFnSUNBb0tTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNElPMlpsZXlkdU91UXFDRGlnSlFnN0tDVjdJT0JJT3lEZ2UyRG5PdWhuQ0RyczdYcXQ0QXVKeWtzQ2lBZ0lDQW9aU2tnUFQ0Z1kyOXUNCmMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeVZoT3luZ1NEcm9aenF0N2pzbmJnZzdKV0lJT3VRcURvbkxDQlRkSEpwYm1jb1pTNXRaWE56WVdkbEtTNXpiR2xqWlNnd0xDQTRNQ2twQ2lBZ0tUc0tmUW9LTHk4ZzdJdWs3WXlvSU95ZGtldUx0ZXlkaENEc2dxenJub3pzbXFrZzdKV0k2NEswNjZHY0lPdXpnTzJabUNEaWdKUWc3SnVRN0oyNEtPdWhuT3EzdU95ZHVDL3NoS1RzdVpncDdKMjBJTzJNak95VmhldVFuQ0Rxc3Izc21yRHNsNVFnNnJlNElPeVZpT3VDdE91bHZDd2c3SldFNjR1STY2bTBJT3lna2V1UmtPeVd0Q3ZzbTVEcnJManNuWVFnNjdPMDY0SzQ2NHVrQ21aMWJtTjBhVzl1SUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnY0hKbFptbDRLU0I3Q2lBZ2FXWWdLR1VnSmlZZ1pTNXRaWE56WVdkbElEMDlQU0JNVDBkSlRsOUhWVWxFUlNrZ2NtVjBkWEp1SUhzZ1pYSnliM0k2SUV4UFIwbE9YMGRWU1VSRkxDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXeHZaMjkxZENjZ2ZUc0tJQ0JwWmlBb1kyeGhkV1JsDQpVM1JoZEhWeklEMDlQU0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25LU0I3Q2lBZ0lDQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ0oreWR0Q0JRUSt5WGtDQkRiR0YxWkdVZ1EyOWtaU2hqYkdGMVpHVXA2ckNBSU95RXBPeTVtT3VQdkNEc25vanNwNEFnN0pXSzdKV0U3SnFVSU9LQWxDRHNoS1RzdVpqdGxaanFzNkFnNjZHYzZyZTQ3SjI0N1pXY0lPdVNwQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRuTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuSUgwN0NpQWdmUW9nSUhKbGRIVnliaUI3SUdWeWNtOXlPaUJ3Y21WbWFYZ2dLeUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQeUJsTG0xbGMzTmhaMlVnT2lCVGRISnBibWNvWlNrcElIMDdDbjBLQ21aMWJtTjBhVzl1SUhKbFlXUkNiMlI1S0hKbGNTa2dld29nSUhKbGRIVnliaUJ1WlhjZ1VISnZiV2x6WlNnb2NtVnpiMngyWlNrZ1BUNGdld29nSUNBZ2JHVjBJR0p2WkhrZ1BTQW5KenNLSUNBZ0lISmxjUzV2YmlnblpHRjBZU2NzSUNoag0KS1NBOVBpQjdJR0p2WkhrZ0t6MGdZenNnZlNrN0NpQWdJQ0J5WlhFdWIyNG9KMlZ1WkNjc0lDZ3BJRDArSUhzS0lDQWdJQ0FnZEhKNUlIc2djbVZ6YjJ4MlpTaEtVMDlPTG5CaGNuTmxLR0p2WkhrcEtUc2dmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVnpiMngyWlNoN2ZTazdJSDBLSUNBZ0lIMHBPd29nSUgwcE93cDlDZ3BqYjI1emRDQkRUMUpUWDBoRlFVUkZVbE1nUFNCN0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFU5eWFXZHBiaWM2SUNjcUp5d0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFRXVjBhRzlrY3ljNklDZEhSVlFzSUZCUFUxUXNJRTlRVkVsUFRsTW5MQW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MUlaV0ZrWlhKekp6b2dKME52Ym5SbGJuUXRWSGx3WlNjc0NuMDdDbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3b2dJSEpsY3k1M2NtbDBaVWhsWVdRb2MzUmhkSFZ6TENCUFltcGxZM1F1WVhOemFXZHVLSHNnSjBOdmJuUmwNCmJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzS0lDQnlaWE11Wlc1a0tFcFRUMDR1YzNSeWFXNW5hV1o1S0c5aWFpa3BPd3A5Q2dwamIyNXpkQ0J6WlhKMlpYSWdQU0JvZEhSd0xtTnlaV0YwWlZObGNuWmxjaWhoYzNsdVl5QW9jbVZ4TENCeVpYTXBJRDArSUhzS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMDlRVkVsUFRsTW5LU0I3SUhKbGN5NTNjbWwwWlVobFlXUW9NakEwTENCRFQxSlRYMGhGUVVSRlVsTXBPeUJ5WlhSMWNtNGdjbVZ6TG1WdVpDZ3BPeUI5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZEhSVlFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YUdWaGJIUm9KeWtnZXdvZ0lDQWdjbVYwY25sQmRYUm9TV1pPWldWa1pXUW9LVHNnTHk4ZzY2R2M2cmU0N0oyNElPMlZoT3lhbENEc2c0SHRnNXpycWJRZzdKNnM3Wm1WN0oyNElPeUxuT3VQaENEaWdKUWc3SjZzNjZHYzZyZTQ3SjI0DQo3SjIwSU91Qm5ldUNyT3ljdk91cHRDRHJpNlRzbll3ZzdLR3c3WnFNNjdhQTdZU3dJSEJ5YjJKc1pXM3NuYlFnN1pLQTY2YXc2NHVrQ2lBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXdvZ0lDQWdJQ0J2YXpvZ2RISjFaU3dnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeXdnZGpvZ1FsSkpSRWRGWDFZc0lHUnBjam9nWDE5a2FYSnVZVzFsTENBdkx5QjJ3cmRrYVhJNklPcTFyT3V5aE95Z2hDL3NsNG5ybXJIdGxad2c3SUtzNjdPNDdKMjBJT3VXb0NEc25vanJpcFRzcDRBZzdLZUU2NHVvN0pxcENpQWdJQ0FnSUcxdlpHVnNPaUJqZFhKeVpXNTBUVzlrWld3c0lHMXZaR1ZzY3pvZ1FVeE1UMWRGUkY5TlQwUkZURk1zSUdWNFlXMXdiR1Z6T2lCRldFRk5VRXhGVXk1c1pXNW5kR2dzSUdkMWFXUmxPaUJIVlVsRVJTNXNaVzVuZEdnc0lISmxZV1I1T2lCM1lYSnRaV1JWY0N3S0lDQWdJQ0FnY0hKdllteGxiVG9nS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjI5ckp5QjhmQ0JqYkdGMVpHVlRkR0YwZFhNZw0KUFQwOUlHNTFiR3dwSUQ4Z2JuVnNiQ0E2SUdOc1lYVmtaVk4wWVhSMWN5d0tJQ0FnSUNBZ1lXTmpiM1Z1ZERvZ1kyeGhkV1JsUVdOamIzVnVkQ2dwTEFvZ0lDQWdJQ0J6WlhKMlpXUTZJSE4wWVhSekxuTmxjblpsWkN3Z2JHRnpkRUYwT2lCemRHRjBjeTVzWVhOMFFYUXNJR3hoYzNSVVpYaDBPaUJ6ZEdGMGN5NXNZWE4wVkdWNGRDd2diR0Z6ZEZObFl6b2djM1JoZEhNdWJHRnpkRk5sWXl3S0lDQWdJSDBwT3dvZ0lIMEtJQ0F2THlEdGxJenJuNnpxdDdqc25iZ2c3SXVzN0o2bDY3Q1Y2NCtaSU9LQWxDRHJnWXJxdUxEcnFiUWc3SnlFSU9xd2tPeUxuQ0R0ZzREc25iVHJxTGpxc0lBZzY0dWs2NmFzNjZXOElPdUJpT3VMcEFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5b1pXRnlkR0psWVhRbktTQjdDaUFnSUNCc1lYTjBRbVZoZENBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjENClpTQjlLVHNLSUNCOUNpQWdMeThnNjZHYzZyZTQ3SjI0SU9LQWxDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1cvQ2ZuNkFnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdUNEdGxZVHNtcFJkd3JkYjhKK1VrVjBnNjdLRTdZcTg3SjIwSU8yWXVPeTJuTzJWbk91THBDNEtJQ0F2THlEcXVMRHJzN2dvNjdpTTY1Mjg3SnF3N0tDQUlPeW5nZTJXaVNrNklHQmpiR0YxWkdVZ1lYVjBhQ0JzYjJkcGJpQXRMV05zWVhWa1pXRnBZT3VsdkNEc2lLanNuWUFnN1pTRTY2R2M3SVM0N0lxazY2R2NJT3lMcE8yV2lTRGlnSlFnNjZtVTY0bTBJT3lYaHV5ZHRDRHFzNmZzbnFVZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95WHRPcXpvQ3dLSUNBdkx5QWdJR3h2WTJGc2FHOXpkQ0RzaUpqc2k2QWc3WStzN1lxNDY2R2NJT3F5c09xenZPdWx2Q0RzbnBEcmo1a2c3SWlZNjZDNTdaV2M2NHVrS095THBPeTRvVG9nN1plazY1T2M2NmFzN0lxazdKZVE3SVNjNjQrRUlPdTRqT3Vkdk95YXNPeWdnQ0RzbDdUcnByd2dLeUJNU1ZOVVJVNGc3Wm1WDQo3SjI0TENBeU1ESTJMVEEzS1M0S0lDQXZMeUFnSU8yRXNPdXZ1T3VFa095ZHRDRHRtWlRycWJUc2w1QWc3S0NFN1ppQUlPeVZpQ0Rybkt6cmk2UXVJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqcnA0d2c3WldZNjZtMElPdUJuUzRLSUNBdkx5RHRqN1Ryc0xFbzdZU3c2Nis0NjRTUUtUb2c3SjZRNjQrWklPeVpoT3Vqak9xd2dDRHJwNG50bm93ZzdabVk2cks5S091NGpPdWR2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1RzbDVBZzY2cTdJT3VMdit5VmhDRHN2WlRyazV6cXNJQWc2N08wN0oyMDY0cVVJT3F5dmV5YXNDbnNsNURzaEp3S0lDQXZMeUFnSU91aG5PcTN1T3lkdUNEcmpJRHF1TEFnN0tTUklPdXloTzJLdk95ZGhDRHJtSkFnNjRpRTY2VzA2Nm0wTENEc3ZaVHJrNXpycGJ3ZzY3YVo3SmVzNjRTajdKMkVJT3lJbUNEc25vanJpcFFnN1lTdzY2KzQ2NFNRSU91d3FleUxuZXljdk91aG5DRHNvSVR0bVpqdGxaenJpNlF1Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbQ0KSmlCeVpYRXVkWEpzSUQwOVBTQW5MMjl3Wlc0dGJHOW5hVzRuS1NCN0NpQWdJQ0JqYjI1emRDQmliMlI1SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJSE4zYVhSamFFMXZaR1VnUFNBaElTaGliMlI1SUNZbUlHSnZaSGt1YzNkcGRHTm9RV05qYjNWdWRDazdJQzh2SU9xemhPeWdsU0Rzb0lUdG1aZ2dQU0RzaTV6dGdhenJwcjhnN0xDOTdKeTg2NkdjSU95WHRPeVd0Q0RxczRUc29KWHNuWVFnNnJPZzY2VzhJT3lJbUNEc25vanFzb3dLSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJQzh2SU95bmhPMldpU0RzcEpIc25ianJqYkFnNjVpUUlPdUlqT3VnZ091THBDRGlnSlFnNnJpSTY3Q3BLRFl3N0xTSUlPdUN0Q2tnNjR1azdJdWNJT3VJaE91bHVDRHFzYlFnSXV5d3ZleWRoQ0RyaTZ2c2xaanJpNlF2NjZxN0lPdTBwT3VMcENMc2w1QWc2ckNBNnJtTTdKcXc2NitBNjZHY0lPdTRqT3Vkdk95YXNPeWdnT3VobkNEc25xenNpNXpyajRUdGxaenJpNlF1Q2lBZ0lDQWdJQzh2SU8yVm5PeXcNCnVDRHJrcVRzbDVEcmo0UWc2NWlRSU91SWhPdWx0T3VLbENEcXNiUWc2N2lNNjUyODdKcXc3S0NBNnJDQUlHeHZZMkZzYUc5emRDRHN2Wnpyc0xIc2w1QWc2NnE3SU91THYreVZoQ0RzbnBEcmo1a2c3Sm1FNjZPTTZyQ0FJT3lWaUNEcmtKanJpcFFnN1ptWTZySzk3SjI4SU95SW1DRHNub2pzbkx6cmk0Z0tJQ0FnSUNBZ0x5OGc2cmU0NjVXTTY2ZU1JT3k5bE91VG5PdWx2Q0RydHBuc2w2enJoS1BzbllRZzdJaVlJT3llaU91S2xDRHRoTERycjdqcmhKQWc2N0NwN0l1ZDdKeTg2NkdjSU8yUHRPdXdzZTJWbk91THBDQW82NUdRSU91eWlPeW51Q0R0Z2JUcnBxM3NsNUFnN1lTdzY2KzQ2NFNRN0oyMElPMktnT3lXdE91Q21PeVlwT3VwdENEcmk3bnRtYW5zaXFUcm43M3JpNlFwTGdvZ0lDQWdJQ0JqYjI1emRDQnpkR0ZzWlNBOUlHeHZaMmx1VUhKdll5QW1KaUFvUkdGMFpTNXViM2NvS1NBdElHeHZaMmx1VTNSaGNuUmxaRUYwSUQ0Z05qQXdNREFwT3dvZ0lDQWdJQ0JwWmlBb2JHOW5hVzVRY205aklDWW1JSE4wDQpZV3hsS1NCN0NpQWdJQ0FnSUNBZ2EybHNiRXh2WjJsdVVISnZZeWdwT3dvZ0lDQWdJQ0FnSUdsbUlDZ2hiM0JsYmt4dloybHVWR1Z5YldsdVlXd29LU2tnZXdvZ0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ERXNJSHNnWlhKeWIzSTZJQ2ZzbmJRZ1QxUHNsNURzaEtBZzdKNlE2NCtaN0p5ODY2R2NJT3VxdXlEc2w3VHNsclRzbXBRZzRvQ1VJTzJFc091dnVPdUVrT3lYa095RW5DQmpiR0YxWkdVZzdJdWs3WmFKSU8yYmhDQXZiRzluYVc0ZzdaVzBJT3lqdk95RXVPeWFsQzRuSUgwcE93b2dJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3Q2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHRqN1Ryc0xFZzRvQ1VJTzJFc091dnVPdUVrQ0Ryc0tuc2k1M3NuTHpyb1p3ZzdLQ0U3Wm1ZTGljcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Zw0KTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQW5kR1Z5YldsdVlXd25JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc2dMeThnN0pXZTdJU2dJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqc25iUWc2NHlBNnJpd0lPeWtrZXlkdE91cHRDRHNvSkhxczZBZzdJT0k2NkdjSU95WHNPdUxwQ0FvN0xDOTdKMkVJT3VMcSt5Vm1PcXhzT3VDbUNEcmk2VHNpNXdnNjRpRTY2VzRJT3F5dmV5YXNDa0tJQ0FnSUNBZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNBdkx5QkNVazlYVTBWUzY2VzhJT3lhc091bXJDRHRsYmpyazZUcm42enJvWndnN0tlQTdLQ1ZJT0tBbENCRFRFbnFzSUFnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN1RzcDRBZzdKV0s2ck9nSUZWU1RPdW5qQ0RyaEpqcXNxanNwSURyaTZRdUNpQWdJQ0FnSUM4dklPMlZ1T3VUcE91ZnJPcXdnQ0RzaTZUdGpLanRsWmpxc2JEcmdwZ2dRMHhKNnJDQUlFSlMNClQxZFRSVkxycGJ3ZzY2eTA3SXVjN1pXMDY0K0VJRU5NU2Vxd2dDRHNsWXpzbFlUc2hKd2c2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHJyNERyb1p3ZzY2R2M2cmU0N0oyNDdKMkFJT3VRbk91THBDaG1ZV2xzTFhOdlpuUXBMZ29nSUNBZ0lDQmpiMjV6ZENCc2IyZHBia1Z1ZGlBOUlFOWlhbVZqZEM1aGMzTnBaMjRvZTMwc0lFTk1RVlZFUlY5RlRsWXNJSHNnUWxKUFYxTkZVam9nZDNKcGRHVkNjbTkzYzJWeVNHRnVaR3hsY2loemQybDBZMmhOYjJSbElEOGdKM04zYVhSamFDY2dPaUFuYm05eWJXRnNKeWtnZlNrN0NpQWdJQ0FnSUdOdmJuTjBJSFJvYVhOTWIyZHBiaUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSjJGMWRHZ25MQ0FuYkc5bmFXNG5MQ0FuTFMxamJHRjFaR1ZoYVNkZExDQjdDaUFnSUNBZ0lDQWdjMmhsYkd3NklIUnlkV1VzSUdWdWRqb2diRzluYVc1RmJuWXNJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVXNDaUFnSUNBZ0lDQWdaR1YwDQpZV05vWldRNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ0lUMDlJQ2QzYVc0ek1pY3NJQzh2SUd0cGJHeE1iMmRwYmxCeWIyUHNuWmdnNnJlNDY2TzVJR3RwYkd6c21xa2dLR3RwYkd4UWNtOWo2ck84SU91UG1leWR2Q0R0aktqdGhMUXBDaUFnSUNBZ0lIMHBPd29nSUNBZ0lDQnNiMmRwYmxCeWIyTWdQU0IwYUdselRHOW5hVzQ3Q2lBZ0lDQWdJSFJvYVhOTWIyZHBiaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdsbUlDaHNiMmRwYmxCeWIyTWdQVDA5SUhSb2FYTk1iMmRwYmlrZ2JHOW5hVzVRY205aklEMGdiblZzYkRzZ2ZTazdDaUFnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdJVDA5SUhSb2FYTk1iMmRwYmlrZ2NtVjBkWEp1T3dvZ0lDQWdJQ0FnSUd4dloybHVVSEp2WXlBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnYVdZZ0tHeHZaMmx1VUhKdlkxUnBiV1Z5S1NCN0lHTnNaV0Z5VkdsdFpXOTFkQ2hzYjJkcA0KYmxCeWIyTlVhVzFsY2lrN0lHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2JuVnNiRHNnZlFvZ0lDQWdJQ0FnSUdGalkyOTFiblJEWVdOb1pTNWhkQ0E5SURBN0lDOHZJT3lEaUNEcXM0VHNvSlhzbmJ3ZzdJaVlJT3llaU95Y3ZPdUxpQ0RyaTZUc25Zd2dMMmhsWVd4MGFDRHJsWXdnNjR1azdJdWNJT3lkdmVxNHNBb2dJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeWdpT3l3cUNEc29vWHJvNHdnS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93b2dJQ0FnSUNCOUtUc0tJQ0FnSUNBZ2JHOW5hVzVRY205alZHbHRaWElnUFNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhzZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0F4TU91MmhDRHFzcjNxczd3ZzRvQ1VJT3VNZ09xNHNDRHRsSVRyb1p6c2hManNpcVFnN0tDVjY2YXNMaWNwT3lCcmFXeHNURzluYVc1UWNtOWpLQ2s3SUgwc0lEWXdNREF3TUNrN0NpQWcNCklDQWdJQzh2SU91Q29leWRnQ0Rzbm9Yc25xWHF0b3pzbllRZzY2eTg2ck9nSU95ZWlPdUtsQ0RyaklEcXVMQWc3SVM0N0lXWTdKMkFJT3V5aE91bXNPdUxwQ0RpZ0pRZzdKNnM2NkdjNnJlNDdKMjRJTzJiaENEcmk2VHNuWXdnN0pxVTdMS3Q3SjIwSU95RGlDRHNoTGpzaFpnbzdJT0lJT3llaGV5ZXBlcTJqQ25zbkx6cm9ad2c3SXVjN0o2UjdaV1k2cktNQ2lBZ0lDQWdJR3RwYkd4UWNtOWpLQ2s3Q2lBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJT3lMbk95ZWtTY2dLeUFvYzNkcGRHTm9UVzlrWlNBL0lDY2dLT3F6aE95Z2xTRHNvSVR0bVpnZzRvQ1VJT3lMbk8yQnJPdW12eURzc0wwcEp5QTZJQ2NuS1NBcklDY2c0b0NVSU91aG5PcTN1T3lkdU8yVm1PdXB0Q0RzbnBEcmo1a2c3SmV3NnJLdzY1Q3A2NHVJNjR1a0xpY3BPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5DQpaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnYlc5a1pUb2djM2RwZEdOb1RXOWtaU0EvSUNkaWNtOTNjMlZ5TFhOM2FYUmphQ2NnT2lBblluSnZkM05sY2ljZ2ZTazdDaUFnSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXdMQ0I3SUdWeWNtOXlPaUFuNjZHYzZyZTQ3SjI0SU95d3ZleWRoQ0RycXJzZzdKZTA3SmVJN0phMDdKcVVPaUFuSUNzZ1pTNXRaWE56WVdkbElIMHBPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5QW83WVN3NjYrNDY0U1FJTzJQdE91d3NTRHF0YXp0bUlUcnRvQWc0b0NVSU91NGpPdWR2T3lhc095Z2dDRHNucERyajVrZzdKbUU2Nk9NNnJDQUlPeVZpQ0Rya0pqcmlwUWc3Wm1ZNnJLOUlPeWdoT3lhcVNrS0lDQm1kVzVqZEdsdmJpQnZjR1Z1VEc5bmFXNVVaWEp0YVc1aGJDZ3BJSHNLSUNBZ0lIc0tJQ0FnSUNBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzS0lDQWdJQ0FnSUNBdkx5QnpkR0Z5ZE9xdw0KZ0NEc2c0Z2c3TDJZN0lhVUlPeXd2ZXlkaENEcnA0enJrNkRyaTZRZ0tPdUxwT3Vtck95ZG1DRHNpS2pzbllBZzdMMlk3SWFVNnJPOElPdXN0T3EwZ08yVm1PcXlqQ0RzZ3F6c21xbnNucERzbDVEcXNvd2c2N08wN0o2RUtTNEtJQ0FnSUNBZ0lDQXZMeURzbmJUc2xyVHNoSndnVUc5M1pYSlRhR1ZzYkNndWNITXhLZXlkdENBMTdMU0lJT3VTcENEcXQ3Z2c3TEM5N0plUUlPeVhsTzJFc091bHZDRHJzN1RyZ3JRZ01ldXlpQ2pxdGF6cmo0VWc2ck9FN0tDVktleWRoQ0RzbnBEcmo1a2c3SVNnN1lPZDdaV1k2ck9nTEFvZ0lDQWdJQ0FnSUM4dklPeXd2ZXlkaENEc3RaenNob3p0bVpUdGxiUWc3SUtzN0pxcDdKNlFJT3VJaU95WGxDRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0NjZlTUlPdUNxT3F5akNEdGxaenJpNlF1SU95d3ZleWRoQ0RycXJzZzdMQys3Snk4NjZtMElPeVZoT3VzdE9xeWcrdVBoQ0RzbFlnZzdaV2M2NHVrQ2lBZ0lDQWdJQ0FnTHk4Z0tPdUxwT3VsdUNEc3NMMGc3SmlrN0o2RjY2Q2wNCklPdXdxZXluZ0NEaWdKUWc2cmU0SU9xeXZleWFzQ0RycVpUcmliVHFzSUFnNjdPMDdKMjA2NHFVSU95eGhPdWhuQ0RyZ3FqcXM2QWc3SUtzN0pxcDdKNlE2ckNBSU95WGxPMkVzQ0R0bFp3ZzY3S0lJT3VJaE91bHRPdXB0Q0Rya0tncExnb2dJQ0FnSUNBZ0lDOHZJT3lqdk95ZG1Eb2dZMnhoZFdSbDZyQ0FJT3k5bU95R2xDRHNvSnpycXFuc25ZUWc2N0NVNnI2NDY2bTBJRUZ3Y0VGamRHbDJZWFJsTDBacGJtUlhhVzVrYjNmcXNJQWc2NnE3SU95d3Z1eWRoQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHNuSWpyajRUc21yQWc3SXVrNnJpdzdKZVE3SVNjSU8yWmxleWR1Q0R0bFlUc21wUXVDaUFnSUNBZ0lDQWdZMjl1YzNRZ2NITXhJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxc2IyZHBiaTV3Y3pFbktUc0tJQ0FnSUNBZ0lDQm1jeTUzY21sMFpVWnBiR1ZUZVc1aktIQnpNU3dnV3dvZ0lDQWdJQ0FnSUNBZ0oxTjBZWEowTFZOc1pXVndJQzFUWldOdmJtUnpJRFVuDQpMQW9nSUNBZ0lDQWdJQ0FnSnlSM2N5QTlJRTVsZHkxUFltcGxZM1FnTFVOdmJVOWlhbVZqZENCWFUyTnlhWEIwTGxOb1pXeHNKeXdLSUNBZ0lDQWdJQ0FnSUNKcFppQW9KSGR6TGtGd2NFRmpkR2wyWVhSbEtDZGpiR0YxWkdVdGJHOW5hVzRuS1NrZ2V5SXNDaUFnSUNBZ0lDQWdJQ0FpSUNBa2QzTXVVMlZ1WkV0bGVYTW9KMzRuS1NJc0NpQWdJQ0FnSUNBZ0lDQW5JQ0JUZEdGeWRDMVRiR1ZsY0NBdFUyVmpiMjVrY3lBeUp5d0tJQ0FnSUNBZ0lDQWdJQ0lnSUVGa1pDMVVlWEJsSUMxT1lXMWxjM0JoWTJVZ1ZTQXRUbUZ0WlNCWElDMU5aVzFpWlhKRVpXWnBibWwwYVc5dUlDZGJSR3hzU1cxd2IzSjBLRndpZFhObGNqTXlMbVJzYkZ3aUtWMGdjSFZpYkdsaklITjBZWFJwWXlCbGVIUmxjbTRnVTNsemRHVnRMa2x1ZEZCMGNpQkdhVzVrVjJsdVpHOTNLSE4wY21sdVp5QmpMQ0J6ZEhKcGJtY2dkQ2s3SUZ0RWJHeEpiWEJ2Y25Rb1hDSjFjMlZ5TXpJdVpHeHNYQ0lwWFNCd2RXSnNhV01nYzNSaGRHbGpJR1Y0ZEdWeQ0KYmlCaWIyOXNJRk5vYjNkWGFXNWtiM2NvVTNsemRHVnRMa2x1ZEZCMGNpQm9MQ0JwYm5RZ2JpazdKeUlzQ2lBZ0lDQWdJQ0FnSUNBaUlDQWthQ0E5SUZ0VkxsZGRPanBHYVc1a1YybHVaRzkzS0Z0T2RXeHNVM1J5YVc1blhUbzZWbUZzZFdVc0lDZGpiR0YxWkdVdGJHOW5hVzRuS1NJc0NpQWdJQ0FnSUNBZ0lDQW5JQ0JwWmlBb0pHZ2dMVzVsSUZ0VGVYTjBaVzB1U1c1MFVIUnlYVG82V21WeWJ5a2dleUJiZG05cFpGMWJWUzVYWFRvNlUyaHZkMWRwYm1SdmR5Z2thQ3dnTmlrZ2ZTY3NJQzh2SURZZ1BTQlRWMTlOU1U1SlRVbGFSUW9nSUNBZ0lDQWdJQ0FnSjMwbkxBb2dJQ0FnSUNBZ0lGMHVhbTlwYmlnblhISmNiaWNwSUNzZ0oxeHlYRzRuS1RzS0lDQWdJQ0FnSUNCamIyNXpkQ0JpWVhRZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV3h2WjJsdUxtSmhkQ2NwT3dvZ0lDQWdJQ0FnSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vWW1GMExDQW5RR1ZqYUc4Z2IyWm0NClhISmNiaWNnS3dvZ0lDQWdJQ0FnSUNBZ0ozTjBZWEowSUNKamJHRjFaR1V0Ykc5bmFXNGlJR050WkNBdmF5QmpiR0YxWkdVZ0wyeHZaMmx1WEhKY2JpY2dLd29nSUNBZ0lDQWdJQ0FnSjNCdmQyVnljMmhsYkd3Z0xVNXZVSEp2Wm1sc1pTQXRSWGhsWTNWMGFXOXVVRzlzYVdONUlFSjVjR0Z6Y3lBdFJtbHNaU0FpSnlBcklIQnpNU0FySUNjaVhISmNiaWNwT3dvZ0lDQWdJQ0FnSUhOd1lYZHVLQ2RqYldRbkxDQmJKeTlqSnl3Z1ltRjBYU3dnZXlCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VnZlNrN0NpQWdJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKMlJoY25kcGJpY3BJSHNLSUNBZ0lDQWdJQ0F2THlCd2RIa29aWGh3WldOMEtldWhuQ0RyczdUcmdyZ2c3WUtrN0plUUlPMkJ0T3Vobk91VG5DQlVWVW5xc0lBZzY2eTA2N0NZN0oyUjdKMjRJT3F5Zyt5ZHRDRHNpNlRzdUtFZzdabVY3SjI0DQo2NUNvS0RJd01qWXRNRGNzSU95ZHZPdXdtQ0JjY3NLM2EybDBkSGtnN0wyVTY1T2NJT3VxcU91UmtDa2c0b0NVQ2lBZ0lDQWdJQ0FnTHk4ZzdKeWc3SjI4N1pXY0lPeWVrT3VQbWUyWmxDRHFzcjNyb1p6cmlwUWdVM2x6ZEdWdElFVjJaVzUwYyt5ZG1DRHNwNFRzcDV3ZzdZS2tJT3llaGV1Z3BTNGc3S0NSNnJlODdJU3hJT3Eyak8yVm5PeWR0Q0Rzbm9qc25MenJxYlFnTnV5MGlDRHJrcVFnN0plVTdZU3c2ckNBSU95ZWtPdVBtU0Rzbm9Ycm9LWHJqN3dLSUNBZ0lDQWdJQ0F2THlBeDY3S0lLT3Exck91UGhTRHFzNFRzb0pVcDdKMjBJT3lFb08yRG5ldVFtT3F6b0N3ZzZyYU03WldjN0oyMElPeVhodXljdk91cHRDQnJaWGx6ZEhKdmEyVWc3S1NFNjZlTUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxiUWc3SUtzN0pxcDdKNlE2ckNBSU95WGxPMkVzQ0R0bFp3ZzY3S0lJT3VJaE91bHRPdXB0Q0Rya0p6cmk2UW9abUZwYkMxemIyWjBLUzRLSUNBZ0lDQWdJQ0F2THlEc2w1VHRoTEFnN0tlQjdLQ0U3SmVRSUZSbA0KY20xcGJtRnM3SjJFSU91THBPeUxuQ0RzbFo3c25MenJvWndnNnJDQTdLQzQ3Sm1BSU91THBPdWx1Q0RzbGJIc2w1QWc3WUtrNnJDQUlPdVRwT3lXdE9xd2dPdUtsQ0Rxc29Qc25ZUWc2NmVKNjRxVTY0dWtMZ29nSUNBZ0lDQWdJSE53WVhkdUtDZHZjMkZ6WTNKcGNIUW5MQ0JiQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHUnZJSE5qY21sd2RDQWlZMnhoZFdSbElDOXNiMmRwYmlJbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJoWTNScGRtRjBaU2NzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuWkdWc1lYa2dOaWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHRmpkR2wyWVhSbEp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZGtaV3hoZVNBd0xqTW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2cNCkozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsTjVjM1JsYlNCRmRtVnVkSE1pSUhSdklHdGxlWE4wY205clpTQnlaWFIxY200bkxBb2dJQ0FnSUNBZ0lDQWdMeThnN0plVTdZU3c2ckNBSU95THBPeWduT3VobkNEcms2VHNsclRxc0lRZzZySzk3SnF3N0plUTY2ZU1JT3lYck9xNHNDRHJqNFRyaTZ3bzZyYU03WldjSU95WGh1eWN2T3VwdENEc25JVHNsNURzaEp3ZzdLU1I2NHVvS1NEaWdKUWc3WVN3NjYrNDY0U1E3SjJFSU95NW1PeWJqQ0RydUl6cm5ienNtckRzb0lEcnA0d2c2NEtvNnJpMDY0dWtDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5aR1ZzWVhrZ01TNDFKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWhiQ0lnZEc4Z2MyVjBJRzFwYm1saGRIVnlhWHBsWkNCdlppQm1jbTl1ZENCM2FXNWtiM2NnZEc4Z2RISjFaU2NzQ2lBZ0lDQWdJQ0FnWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdDaUFnSUNBZ0lIMGdaV3h6WlNCN0NpQWdJQ0FnDQpJQ0FnY21WMGRYSnVJR1poYkhObE95QXZMeURzcDREc201QWc3SldJSU8yVm1PdUtsQ0JQVXdvZ0lDQWdJQ0I5Q2lBZ0lDQWdJSEpsZEhWeWJpQjBjblZsT3dvZ0lDQWdmUW9nSUgwS0lDQXZMeUR0Z2JUcm9aenJrNXdnNnJPRTdLQ1ZJT3Vobk9xM3VPeVZoT3liZ3lEaWdKUWc3WlNNNjUrczZyZTQ3SjI0SU8yWmlPeWRtQ0JiNjZHYzZyZTQ3SldFN0p1RFhTRHJzb1R0aXJ6c25iUWc3Wmk0N0xhY0xpQmpiR0YxWkdVZ1lYVjBhQ0JzYjJkdmRYVHNuTHpyb1p3Z1EweEpJT3Vobk9xM3VPeWR1T3lkaENEdGxiVHNvSnp0bFp6cmk2UXVDaUFnTHk4Z0tPeWR0Q0JRUSt5ZG1DRHNvSURzbnFYcmtKd2c3SjZRNnJLcDdLYWQ2NnFGN0oyRUlPeW5nT3lhdE91THBDRGlnSlFnNjR1azdJdWNJT3lUc091Z3BPdXB0Q0RzbnF6cm9aenF0N2pzbmJnZzdaV0U3SnFVTGlrZzY2R2M2cmU0N0pXRTdKdURJTzJiaE95WGxDRHNoTGpzaFpqQ3QrcXpoT3lnbGV5NmtPeUxuT3VsdkNEc29KWHJwcXp0bFp6cmk2UXVDaUFnYVdZZw0KS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyTnNZWFZrWlMxc2IyZHZkWFFuS1NCN0NpQWdJQ0JqYjI1emRDQnNieUE5SUhOd1lYZHVLQ2RqYkdGMVpHVW5MQ0JiSjJGMWRHZ25MQ0FuYkc5bmIzVjBKMTBzSUhzZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVWdmU2s3Q2lBZ0lDQnNaWFFnWlhKeUlEMGdKeWM3Q2lBZ0lDQnNieTV6ZEdSbGNuSXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJsY25JZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc0tJQ0FnSUd4dkxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQjdJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2diMnM2SUdaaGJITmxMQ0JsY25KdmNqb2dKK3Vobk9xM3VPeVZoT3liZ3lEc2k2VHRsb2tnN0l1azdZeW9PaUFuSUNzZ1pTNXRaWE56WVdkbElIMHBPeUI5S1RzS0lDQWdJR3h2TG05dUtDZGpiRzl6WlNjc0lDaGpiMlJsS1NBOVBpQjcNCkNpQWdJQ0FnSUd0cGJHeFFjbTlqS0NrN0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBdkx5RHJvWnpxdDdqc2xZVHNtNFBya0p3ZzZyT0U3S0NWN0oyRUlPdXN2T3VObUNEcmpJRHF1TEFnN0lTNDdJV1k3SjJFSU91eWhPdW1zT3VMcEFvZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQU0F3T3lBZ0lDQWdJQ0FnTHk4ZzY0dWs3SjJNSUM5aFkyTnZkVzUwd3JjdmFHVmhiSFJvN0plUTdJU2NJT3F6aE95Z2xleWRoQ0RzZzRqcm9ad29QZXlYaHV5ZGpPeWN2T3VobkNrZzdKMjk2cktNQ2lBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlHNTFiR3c3SUNBZ0lDQWdJQ0F2THlEc2c0SHRnNXdnN0o2czdZeVE3S0NWS091THBPeWRqQ0R0aExUc2w1RHNoSndnNjYrNDY2R2M2cmU0N0oyNElPcXdrT3luZ0NrS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc2xZVHNtNE1nS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93b2dJQ0FnSUNCcFppQW9jbVZ6DQpMbWhsWVdSbGNuTlRaVzUwS1NCeVpYUjFjbTQ3SUM4dklHVnljbTl5SU8yVnVPdVRwT3Vmck9xd2dDRHNuYlRycjdnZzdKMlI2NHUxN1phSTdKeTg2Nm0wSU95a2tldXp0U0Ryc0tuc3A0QUtJQ0FnSUNBZ2FXWWdLR052WkdVZ1BUMDlJREFwSUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0NpQWdJQ0FnSUdWc2MyVWdhbk52YmloeVpYTXNJRFV3TUN3Z2V5QnZhem9nWm1Gc2MyVXNJR1Z5Y205eU9pQW9aWEp5TG5SeWFXMG9LUzV6YkdsalpTZ3dMQ0F4TlRBcEtTQjhmQ0FvSit5aWhldWpqQ0RzdlpUcms1d2dKeUFySUdOdlpHVXBJSDBwT3dvZ0lDQWdmU2s3Q2lBZ0lDQnlaWFIxY200N0NpQWdmUW9nSUM4dklPeWVrT3E0c0NEc29vWHJvNHdnNG9DVUlPMkJ0T3Vobk91VG5PdUxwT3VtckMzcmdZVHF1TEF1WW1GMDdKMjBJTzJZdU95Mm5PMlZuT3VMcENBbzY2R2M3THVzN0plUTdJU2M2NmVNSU95Z2tlcTN2Q0Rxc0lEcmlxWHRsWmpyaTRnZzdKV0k3S0NFS1FvZ0lHbG1JQ2h5WlhFdQ0KYldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl6YUhWMFpHOTNiaWNwSUhzS0lDQWdJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0tLRjY2T01JT3lhbE95eXJTRHJzSnZzbll3ZzRvQ1VJT3VMcE91bXJPdWx2Q0RyZ1pYcmk0anJpNlF1SnlrN0NpQWdJQ0JyYVd4c1VISnZZeWdwT3dvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrc0lESXdNQ2s3Q2lBZ0lDQnlaWFIxY200N0NpQWdmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl5WldOdmJXMWxibVFuS1NCN0NpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ2FXWWdLQ0YwWlhoMElIeDhJQ0ZUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwS1NCeVpYUjENCmNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0oreTJsT3l5bk91d20reWRoQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdMYVU3TEtjSU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnl3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NtRjNJRDBnWVhkaGFYUWdZWE5yUTJ4aGRXUmxLRk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2tzSUcxdlpHVnNLVHNLSUNBZ0lDQWdZMjl1YzNRZ2MzVm5aMlZ6ZEdsdmJuTWdQU0J3WVhKelpWTjFaMmRsYzNScGIyNXpLSEpoZHlrN0NpQWdJQ0FnSUdOdmJuTjBJSE5sDQpZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElIc0tJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5TTdJdXhJT3lMcE8yTXFDQW9KeUFySUhObFl5QXJJQ2R6S1RvbkxDQlRkSEpwYm1jb2NtRjNLUzV6YkdsalpTZ3dMQ0F5TURBcEtUc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c2xZZ2dKeUFySUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBcklDZnFzSndnS0NjZ0t5QnpaV01nS3lBbmN5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMA0KWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0F6TUNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJSE4xWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUNmdGdiVHJvWnpyazV3ZzdaaTQ3TGFjSU95THBPMk1xRG9nSnlrcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlEcnNvanNsNjBnNG9DVUlPMlZuT3ExcmV5V3RDRGlocFFnN0ppQjdKYTANCklPeWVrT3VQbVNBbzdMYVU3TEtjNnJPOElPcXdtZXlkZ0NEc2hManNoWmdnN0lLczdKcXBLUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkwY21GdWMyeGhkR1VuS1NCN0NpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ2FXWWdLQ0YwWlhoMElIeDhJQ0ZUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKK3V5aU95WHJlMlZvQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnDQpKeWtnS3lBbjRvQ21KeWs3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JqYjI1emRDQnlZWGNnUFNCaGQyRnBkQ0JoYzJ0VWNtRnVjMnhoZEdVb1UzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTd2diVzlrWld3cE93b2dJQ0FnSUNCamIyNXpkQ0J2ZFhRZ1BTQndZWEp6WlZSeVlXNXpiR0YwWlNoeVlYY3BPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0R0akl6c2k3RWc3SXVrN1l5b0lDZ25JQ3NnYzJWaklDc2dKM01wT2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJREl3TUNrcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzblpIcmk3WHNuWVFnN1pXMDdJU2Q3WldZN0tlQQ0KSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnNvanNsNjBnN0ptRTY2T01JQ2duSUNzZ2MyVmpJQ3NnSjNNc0lDY2dLeUFvYjNWMExtUnBjbVZqZEdsdmJpQjhmQ0FuUHljcElDc2dKeWtuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWgwWlhoMEtTNXpiR2xqWlNnd0xDQXpNQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lIUnlZVzV6YkdGMFpXUTZJRzkxZEM1MGNtRnVjMnhoZEdWa0xDQmthWEpsWTNScGIyNDZJRzkxZEM1a2FYSmxZM1JwYjI0c0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjZ2ZTazcNCkNpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0JtY21sbGJtUnNlVVZ5Y205eUtHVXNJQ2Z0Z2JUcm9aenJrNXdnNjdLSTdKZXRJT3lMcE8yTXFEb2dKeWtwT3dvZ0lDQWdmUW9nSUgwS0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdOQ3dnZXlCbGNuSnZjam9nSjA1dmRDQm1iM1Z1WkNjZ2ZTazdDbjBwT3dvS0x5OGc3SjIwNjYrNElPdUxwT3Vtck9xd2dDRHJscUFnN0o2STY0cVU2NDJ3SU91WWtDRHN2SnpxdUxEcXNJQWc2NU9rN0phMDdKaWs2Nm0wS095Z25PeUtwT3l5bUNEc25wRHJqNWtnN0x5YzZyaXdJT3lra2V1enRTRHJrN0VwSU95aHNPeWFxZTJlaUNEc29vWHJvNHdnNG9DVUlPdVBqT3VObUNEcmk2VHJwcXpyaXBRZzZyZTQ2NHlBNjZHY0lPeWNvT3luZ0FwelpYSjJaWEl1YjI0b0oyVnljbTl5DQpKeXdnS0dVcElEMCtJSHNLSUNCcFppQW9aU0FtSmlCbExtTnZaR1VnUFQwOUlDZEZRVVJFVWtsT1ZWTkZKeWtnZXdvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95ZHRPdXZ1Q0Rzdkp6c29MZ2c3SjZJN0phMDdKcVVLTzJQck8yS3VDQW5JQ3NnVUU5U1ZDQXJJQ2NnN0lLczdKcXBJT3lra1NrZzRvQ1VJT3lkdENEc25ianNpcVR0aExUc2lxVHJpcFFnN0tLRjY2T003WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdjSEp2WTJWemN5NWxlR2wwS0RBcE93b2dJSDBLSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SVNjNjdLRUlPeVlwT3VsbURvbkxDQmxJQ1ltSUdVdWJXVnpjMkZuWlNrN0NpQWdjSEp2WTJWemN5NWxlR2wwS0RFcE93cDlLVHNLTHk4ZzdKYTA2NWFrSU9xeXZldWhuT3VobkNEc283M3JrNkFvN0l1czdKNmw2N0NWNjQrWklPdUJpdXE1Z0N3Z1EzUnliQ3RETENBdmMyaDFkR1J2ZDI0c0lPeVlwT3VsbUNrZ1kyeGhkV1JsSU95ZWtPeUxuZXlkaENEcmdxanF1TERzcDRBZw0KN0pXSzY0cVU2NHVrQ25CeWIyTmxjM011YjI0b0oyVjRhWFFuTENBb0tTQTlQaUI3SUd0cGJHeFFjbTlqS0NrN0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ2ZTazdDbkJ5YjJObGMzTXViMjRvSjFOSlIwbE9WQ2NzSUNncElEMCtJSEJ5YjJObGMzTXVaWGhwZENnd0tTazdDbkJ5YjJObGMzTXViMjRvSjFOSlIxUkZVazBuTENBb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3BPd29LYzJWeWRtVnlMbXhwYzNSbGJpaFFUMUpVTENBbk1USTNMakF1TUM0eEp5d2dLQ2tnUFQ0Z2V3b2dJR052Ym5OdmJHVXViRzluS0NmaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQW5LVHNLSUNCamIyNXpiMnhsTG14dlp5Z25JTzJCdE91aG5PdVQNCm5DRHJpNlRycHF3ZzdMeWM3S2VRSU9LQWxDQm9kSFJ3T2k4dmJHOWpZV3hvYjNOME9pY2dLeUJRVDFKVUtUc0tJQ0JqYjI1emIyeGxMbXh2WnlnbklPdXFxT3VOdURvZ0p5QXJJRU5NUVZWRVJWOU5UMFJGVENBcklDY2d3cmNnN0ppSTdJdWNJQ2NnS3lCRldFRk5VRXhGVXk1c1pXNW5kR2dnS3lBbjZyRzBJT3llcGV5d3FTY3BPd29nSUdOdmJuTnZiR1V1Ykc5bktDY2c3SjIwSU95d3ZleWRoQ0Rzdkp6cmtaUWc2NCtaN0pXSUlPMlV2T3EzdU91bmlDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdZRzA2NkdjNjVPYzY2R2NJT3kybE95eW5PMlZxZXVMaU91THBDNG5LVHNLSUNCamIyNXpiMnhsTG14dlp5Z240cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBDQo0cFNBNHBTQTRwU0FKeWs3Q2lBZ1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LVHNnTHk4Z1EyeGhkV1JsSUVOdlpHVWc3SUtzN0pxcElPcXdnT3VLcFNEc2w2enJ0b0FnN0tDUTZyS0FJQ2p0bEl6cm42enF0N2pzbmJnZzdKV0k2NEswN0pxcEtRb2dJQzh2SU91dnVPdW1yQ0RzaTV6cmo1a2dLeURzcDREc2k1enJyTGdnN0tPODdKNkZJT0tBbENEc3Nxc2c3TGFVN0xLYzY3YUE3WVN3SU91NW9PdWx0T3F5akFvZ0lHRnphME5zWVhWa1pTZ243SnVNNjdDTjdKZUZPaUFpN0tDQTdKNmxJT3VRbU95WGlPeUt0ZXVMaU91THBDSW5LUzUwYUdWdUtBb2dJQ0FnS0NrZ1BUNGdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95YmpPdXdqZXlYaFNEc21ZVHJvNHdnNG9DVUlPeTJsT3l5bkNEc3BJRHJ1WVFnNjRHZExpY3BMQW9nSUNBZ0tHVXBJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNtNHpyc0kzc2w0VWc3SXVrN1l5b0lDanNzcXNnN0pxVTdMS3RJT3VWakNEc25xenNpNXpyajRRcA0KT2ljc0lHVXViV1Z6YzJGblpTa0tJQ0FwT3dwOUtUc0sNCjo6RVhBTVBMRVM6Og0KSXlEcnJManF0YXdnN0xhVTdMS2NJT3lZaU95TG5Bb0tJdXVzdU9xMXJDRHN0cFRzc3B6cnNKdnF1TEFpNnJDQUlPeUNyT3lhcWUyVm1PdUtsQ0RzbUlqc2k1d2c2NnFvN0oyTTdKNkY2NHVJNjR1a0xpQXFLdXlkdENEdGpJenNuYnpzbllRZzdJaVk3S0NWN1pXY0lPdVNwQ0R0aExEcnI3anJoSkRzbDVEc2hKd2dZRzV3YlNCeWRXNGdZblZwYkdSZzY2VzhJT3lMcE8yV2llMlZtT3F6b0N3Z1JtbG5iV0hzbDVEc2hKd2c3WlNNNjUrczZyZTQ3SjI0N0oyRUlPdUxwT3lMbkNEc2k2VHRsb250bFpqcnFiUWc2N0NZN0ppQjY1Q3A2NHVJNjR1a0xpb3FDZ29qSXlEc25wSHNoTEVnNjdDcDY3S1ZDZ290SU95WWlPeUxuQ0R0bFpqcmdwanJpcFFnS2lwZ0l5TWpJT3lia091enVHQXFLaUR0bFp3ZzdLU0U2ck84TENEcXQ3Z2c3SldFNjU2WUlDb3FZQzBnN0xhVTdMS2M3SldJWUNvcUlPeVhyT3VmckNEcXNKenJvWndnN0oyMDY2U0U3S2VSNjR1STY0dWtMZ290SU95MmxPeXluT3lWaUNEc2xZanNsNURzaEp3Z0tpcnMNCnBJVHNuWVFnNjdDVTZyNjQ2ck9nSU95THR1eWN2T3VwdENCZ0lDOGdZQ0FvN0pXZTY1S2tJT3F6dGV1d3NTRHRqNnp0bGFnZzdJcXM2NTZZN0l1Y0tTb3FJT3VobkNEdGtaenNpNXp0bFpqc2hManNtcFF1SU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEcmtaQWc3S1NFNjZHY0lPdXp0T3lYck95bmtldUxpT3VMcEM0S0xTRHNncXpzbXFuc25wRHFzSUFnN0o2RjY2Q2w3WldjSU91c3VPcTFyT3F3Z0NCZzdKdVE2N080WU9xenZDQW82ck8xNjdDeHdyZnJyTGpzbnFYcnRvRHRtTGdnNjZ5MDdJdWM3WldZNnJPZ0tTRHFzSm5xc2JEcmdwZ3NJT3lFbk91aG5DRHRqNnp0bGFqdGxaanJxYlFnNnJlNElPeTJsT3l5bk95VmlPdVRwT3lkaENEcnM3VHNsNnpzcEkzcmk0anJpNlF1Q2kwZzY2ZWs3TG10N1pXZ0lPdVZqQ0FxS3V1bmlPeUtwTzJDdWV1UW5DRHNuYlRycG9RbzdabU5YQ3JyajVrcExDRHNpS3ZzbnBBbzdLQ0U3Wm1VNjdLSTdaaTR3cmNpN0ptNElETHJxb1VpSU91VHNTbnJpcFFnNjZ5MDdJdWNLaXJ0DQpsYW5yaTRqcmk2UWc0b0NVSU95ZHRPdW1oTUszN0lpWTY1K0p3cmZyc29qdG1ManJwNHdnNjR1azY2VzRJT3VzdU9xMXJPdVBoQ0Rxc0puc25ZQWc3SmlJN0l1YzY2R2NJT3llb2UyWWdPeWFsQzRnNjR1b0xDRHN0cFRzc3B6c2xZanNsNUFnN0tDQjdKYTA2NUdVSU95ZHRPdW1oTUszN0lpcjdKNlE2NHFVSU9xM3VPdU1nT3VobkNEcmdwanNtS1RyaTRnZzdJdWs3S0NjSU9xd2t1eVhrQ0RycDU3cXNvd2c2ck9nN0xPUUlPeVRzT3lFdU95YWxDNEtMU0Rzb0p6cnFxa29ZQ01qWUNucXM3d2dZQ01qSTJBc0lHQXRZQ0RxdUxEdG1ManJpcFFnN1ppVjdJdWQ3SjIwNjR1SUlPdXdsT3ErdU95bmdDRHJwNGpzaExqc21wUXVDZ29qSXlEc2lxVHRnNERzbmJ3ZzdKdVE3TG1aSUNqc3NManFzNkFnNG9DVUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZQWdkWGd0ZDNKcGRHbHVaeTV0WkNEcXNJRHNuYlRyazV3cENnb3RJTzJWdE95YWxPeXl0Q3dnNjdhQTY1T2M2NStzN0pxMElPeWloZXF5c0NoZ2Z1eWVpT3lXdE95YQ0KbEdBZ1lIN3JqN3pzbXBSZ0lHQis3SmVHN0phMDdKcVVZQ0JnZnUyVnRDRHNvN3pzaExqc21wUmdLUW90SURMcmk2Z2c2cldzN0tHd09pQXFLdXl5cXlEc3BJUTk3SU9CN1ptcElPeUVwT3VxaFNEaWhwSWc2NUdZN0tlNElPeWtoRDNyaTZUc25Zd2c3WmFKNjQrWktpb282ckt3N0tDVjdKMkFJR0IrN1pXZzZybU03SnFVUDJBc0lPMldpZXVQbVNEc25LRHJqNFRyaXBRZ1lIN3RsYlFnN0tPODdJUzQ3SnFVWUNrS0xTRHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdLT3VRa095V3RPeWFsT0tHa3UyV2lPeVd0T3lhbENrc0lPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQW83SmVHN0phMDdKcVU0b2FTZnUyVm1PdXB0Q0R0bGFBZzdJaVlJT3llaU95V3RPeWFsQ2tLTFNEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phMEtIN3NpNXpxc3FEc2xyVHNtcFEvNG9hU2Z1MlZvT3E1ak95YWxEOHBMQ0RycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQ2pzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjNG9hUzdKNlUNCjdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5Da0tMU0Rxc0lUcXNyRHRsWmpxczZBZzdJbXM3SnEwSU91bmtDQW83S0NFN0lhaDRvYVM2N08wNjRLMDY0dWtLU3dnNjdhQTdLQ1ZJT3lEZ2UyWnFldVBoQ0RybExIcmxMSHRsWmpzcDRBZzdKV0s2cktNS0NMc3NMN3F1TEFnN0l1azdZeW9JdUtkakNBaTdMQys3SjJFSU95SW1DRHNsNGJzbHJUc21wUWk0cHlGS1FvS0l5TWc3TGFVN0xLY0lPeVlpT3lMbkFvS0l5TWpJT3luaE8yV2llMlZtT3VObUNEc25wSHNsNFhzbmJRZzdKNkk3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0tlRTdaYUpJT3lra2V5ZHVDRHJnclRzbDYzc25iUWc3SjZJN0phMDdKcVVMaUF2SU95ZHRPeVd0T3lFbkNEc3A0VHRsb250bGFEcXVZenNtcFEvQ2dvakl5TWc2ck8xN0p5Z0lPeWFsT3l5cmV5ZGhDRHN0NmpzaG96dGxaanJxYlFnN0pxVTdMS3RJT3VDdE95WHJleWR0Q0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kzcU95R2pPMlZtT3lMDQpuT3F5b095S3RldUxpT3E1akQ4S0xTRHN0NmpzaG96dGxhQWc2cks5N0pxd0lPeWFsT3l5clNEcmdyVHNsNjNyajRRZzdJS3Q3S0NjNjQrODdKcVVMaUF2SU9xenRleWNvQ0RzbXBUc3NxM3NuWVFnN0xlbzdJYU03WldnNnJtTTdKcVVQd29LSXlNaklPcTRzT3E0c091bHZDRHNzTDdzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXWTdJUzQ3SnFVTGdvdElPcTRzT3E0c091bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaV1k2cml3SU95Z2hPeVhrT3VLbENEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQTdKNkY3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdLZUE2cmlJSU91eQ0KaE95Z2hPeVhrT3lFbk91S2xDRHNrN2dnN0lpWUlPeVhodXlXdE95YWxDNGc3SU9kN0xLMElPeWR1T3ltbmV5ZGhDRHNrN0Ryb0tUcnFiUWc3Sld4N0oyRUlPeTFuT3lMb0NEcnNvVHNvSVRzbkx6cm9ad2c3SmVGNjQydzdKMjA3WXE0SU8yVnRPeWp2T3lFdU95YWxDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMElPeWp2T3lFdU95YWxDNGdMeURzZzUzc3NyUWc3SjI0N0thZDdKMkVJT3lUc091Z3BPdXB0Q0RzdFp6c2k2QWc2N0tFN0tDRTdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0S0NpTWpJeURzbHJUcmxxUWc2NnFwN0tDQjdKeTg2NkdjSU91TWdPeTJuT3V3bSt5Y3ZPeUxuT3VDbU95YWxEOEtMU0RyaklEc3Rwd2c2NnFwN0tDQjdKMjBJT3VzdE95WGgreWR1T3F3Z095YWxEOEtDaU1qSXlEc2xyVHJscVFnN0oyMDdKeWc2NkdjSU95TG9PcXpvTzJWbU95TG5PdUNtT3lhbEQ4S0xTRHNpNkRxczZBZzdKMjA3SnlnNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKNlUNCjdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVQ2kwZzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMZ29LSXlNaklPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnN0ptNElETHJxb1hzbDVEcXNvd2c2cmFNN1pXY0lPeUNyZXlnbkNEc2xZenJwcnp0aHFIc25ZUWc3S0NFN0lhaDdaV2c2cm1NN0pxVVB3b3RJT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3RPdWdwT3F6b0NEdGxiVHNtcFF1SUM4ZzdabU5LdXVQbVNnd01UQXRNVEl6TkMwMU5qYzRLU0RyaTVnZzdKbTRJRExycW9Yc2w1RHFzb3dnNjdPMDY0Szg2cm1NN0pxVVB3b3RJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzY0dVlJT3ladUNBeTY2cUY3SmVRNnJLTUlPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdk9xNWpPeWFsRDhLTFNEcXRvenRsWndnDQo3SUt0N0tDY0lPeVZqT3Vtdk8yR29leWRoQ0R0bVkwcTY0K1pLREF4TUMweE1qTTBMVFUyTnpncElPdUxtQ0RzbWJnZ011dXFoZXlYa09xeWpDRHJzN1RyZ3J6cXVZenNtcFEvQ2dvakl5TWpJTzJabGV5ZHVNSzM2ckt3N0tDVklPMk1uZXlYaFFvS0l5TWpJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeUNyZXlnbk91UW5DRHJqYkRzbmJUdGhMRHJpcFFnNjdPMTZyV3M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHJrSmpyajR6cnByUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNvSlhycDVBZzdJS3Q3S0NjN1pXZzZybU03SnFVUHdvS0l5TWpJT3V6Z09xeXZleUNyTzJWcmV5ZHRDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdKV1k3SXExNjR1STY0dWtMaURyZ3BqcXNJRHNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SldFN0tlQklPeWdnT3llcGUyVm1PeW5nQ0RzbFlyc25ZQWc2NEswN0pxcDdKMjBJT3llaU95Vw0KdE95YWxDNGdMeURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1ak95YWxEOEtDaU1qSXlEcm9aenF0N2pzbFlUc200TWc3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU91aG5PcTN1T3lWaE95YmcrMlZvT3E1ak95YWxEOEtDaU1qSXlEc2xiSHNuWVFnN0tLRjY2T003WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU95VnNleWRoQ0Rzb29Ycm80enRsYURxdVl6c21wUS9DZ29qSXlNZzdaV2NJT3V5aUNEcnM0RHFzcjN0bFpqcnFiUWc2NHVrN0l1Y0lPdXpnT3F5dmUyVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc2NHVrN0l1Y0lPdXdsT3EvZ0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xemhPeUdqZTJWb09xNWpPeWFsRDhLQ2lNakl5RHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTBpT3E0c08yWmxPMlYNCm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmo3enNtcFF1SUM4ZzdMU0k2cml3N1ptVTdaV2c2cm1NN0pxVVB3b0tJeU1qSXlEc2w1RHJuNnpDdCt5THBPMk1xQW9LSXlNaklPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPdUVwTzJLdU95YmpPMkJyT3lYa0NEc2w3RHFzckR0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc2w3RHFzckFnN0lPQjdZT2M2Nlc4SU8yWmxleWR1TzJWbU9xem9DRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ienNpNXpzb0lIc25iZ2c3SmlrNjZXWTZyQ0FJT3V3bk95RG5lMldpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0RzbmJ6c2k1enNvSUhzDQpuYmdnN0ppazY2V1k2ckNBSU95RG5lcXl2T3lXdE95YWxDNGdMeURzbnFEc2k1d2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWaE95ZHRPdVVsQ0RybUpEcmlwUWc2N21FNjdDQTY3S0k3Wmk0NnJDQUlPeWR2T3k1bU8yVm1PeW5nQ0RzbFlyc2lyWHJpNGpyaTZRdUNpMGc3SldFN0oyMDY1U1VJT3VZa091S2xDRHJ1WVRyc0lEcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDNyc29qdG1ManFzSUFnN0oyODdMbVk3WldZN0tlQUlPeVZpdXlLdGV1TGlPdUxwQzRLTFNEc25ianNwcDNyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3kwaU9xenZPdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKMjQ3S2FkNjdLSQ0KN1ppNDY2VzhJT3llck91d25PeUdvZTJWbU95THJleUxuT3lZcEM0S0xTRHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeW5nT3VDck95V3RPeWFsQzRnTHlEc25ianNwcDNyc29qdG1ManJwYndnNjR1azdJdWNJT3V3bSt5VmhDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2xyVHNtcFF1SUM4ZzY0dWs2Nlc0SU9xeWdPeURpZXlXdE91aG5DRHJpNlRzaTV3ZzdMQys3SldFNjdPMDdJUzQ3SnFVTGdvS0l5TWpJT3lnbGV1enRPdWx2Q0RydG9qcm42enNtS1RzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rzb0pYcnM3VHJwYndnNjdhSTY1K3M3SmlzSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeUR0akl6c25id2cNCjdKZUY2NkdjNjVPYzdKZVFJT3lMcE8yTXFPMldpT3lLdGV1TGlPdUxwQzRLTFNEdGpJenNuYnpzbllRZzdKaXM2NmFzN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRnTHlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0tDUTZyS0FJT3lra2V5ZWhldUxpT3VMcEM0ZzdKMjA3SnFwN0plUUlPdTJpTzJPdU95ZGhDRHJrNXpyb0tRZzdLT0U3SWFoN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHNoSnpydVlUc2lxVHJwYndnN0tDUTZyS0E3WldZNnJPZ0lPeWVpT3lXdE95YWxDNGdMeURzb0pEcXNvRHNuYlFnNjRHZDY0S1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxZVHNpSmdnN0o2RjY2Q2xJTzJWcmV1cXFleWVoZXVMaU91THBDNEtMU0RxdkswZzdKNkY2NkNsN1pXMDdKVzhJTzJWbU91S2xDRHRsYTNycXFuc25iVHNsNURzbXBRdUNnb2pJeU1qSU9xMmpPMlZuTUszN0lTazdLQ1ZDZ29qDQpJeU1nN0xtMDY2bVU2NTI4SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdJcTE2NHVJNjR1a0xpRHNoS1Rzb0pYc2w1RHNoSndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU95THJleUxuT3lZcEM0S0xTRHN1YlRycVpUcm5id2c2cmFNN1pXYzdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0xtMDY2bVU2NTI4SU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmpPdW12Q0RxdG96dGxaenNuYlFnNnJHdzY3YUE2NUNZN0phMElPeVZqT3Vtdk95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHNsWXpycHJ3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PdXB0Q0RzaG96c2k1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUlDOGc3SVNrN0tDVjdKZVE3SVNjSU95VmpPdW12T3lkaENEc3ZKd2c3S084N0lTNDdKcVVMZ29LSXlNaklPeWNoT3k1bUNEc29KWHJzN1FnN0oyMDdKcXA3SmVRSU91UA0KbWV5ZG1PMlZtT3luZ0NEc2xZcnNsWVFnN0oyODY3YUFJT3E0c091S3BleWR0Q0Rzb0p6dGxaenJrS25yaTRqcmk2UXVDaTBnN0p5RTdMbVlJT3lnbGV1enRPdWx2Q0R0bDRqc21xbnRsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0p5RTdMbVlJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzbVlUcm80ekN0K3luaE8yV2lRb0tJeU1qSU95Z2dPeWVwZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Rzb0lEc25xWHRsb2pzbHJUc21wUXVDZ29qSXlNZzY3T0E2cks5N0lLczdaV3Q3SjIwSU95Z2dleWFxZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyczREcXNyMGc2NEswN0pxcDdKMkVJT3lnZ2V5YXFlMldpT3lXdE95YWxDNEtDaU1qSXlEc29JVHNocUhzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRPdURpT3lXdE95YWxDNEtDaU1qSXlEcms3SHINCm9aM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3VUc2V1aG5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1nN0lLdDdLQ2M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lDcmV5Z25PMldpT3lXdE95YWxDNEtDaU1qSXlEdGdiVHJwcjNyczdUcms1enNsNUFnNjdPMTdJS3M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dGV5Q3JPMldpT3lXdE95YWxDNEtDaU1qSXlEc21wVHNzcTNzbllRZzdMS1k2NmFzSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SnFVN0xLdDdKMkVJT3l5bU91bXJPMlZtT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3lWaU91Q3RNSzM3SnlnNjQrRUNnb2pJeU1nN0lPSTY2R2M3SnEwSU91eWhPeWdoT3lkdENEc3RwenNpNXpya0pqc2w0anNpclhyaTRqcmk2UXVJT3lYaGV1TnNPeWR0TzJLDQp1Q0R0bTRRZzdKMjA3SnFwSU9xd2dPdUtwZTJWcWV1TGlPdUxwQzRLTFNEc2c0Z2c2N0tFN0tDRTdKMjBJT3VDbU95WmxPeVd0T3lhbEM0Z0x5RHNsNFhyamJEc25iVHRpcmp0bFpqcnFiUWc3SU9JSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0oyMDdKcXA3SjJFSU95Y2hPMlZ0Q0RzbGIzcXRJQWc2NCtaN0oyWTZyQ0FJTzJWaE95YWxPMlZxZXVMaU91THBDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzaTV6c25wSHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25xWHNpNXpxc0lRZzY2KzQ3SUtzN0pxcDdKeTg2NkdjSU95ZWtPdVBtU0Ryb1p6cXQ3anNsWVRzbTRNZzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3lZcE91ZXErdVBtZXlWaUNEc2dxenNtcW50bFpqc3A0QWc3SldLN0pXRUlPdWhuT3EzdU95Vg0KaE95YmcrdVFrT3lXdE95YWxDNGdMeURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUc2xZanNuWVFnN0p5RTdaVzBJT3U1aE91d2dPdXlpTzJZdU91bHZDRHJzNERxc3IzdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHNsWWpzb0lUdGxad2c3SUtzN0pxcDdKMkVJT3ljaE8yVnRDRHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzY3Q1U2citVSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nNjdPMDdKV0lJT3lFbk91NWhPeUtwQW9LSXlNaklPcXl2ZXU1aE91bHZDRHFzSnpzaTV6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc2cks5NjdtRTY2VzhJT3lMbk95ZWtlMlZvT3E1ak95YWxEOEtDaU1qSXlEcXNyM3J1WVRycGJ3ZzdaVzA3S0NjN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPcXl2ZXU1aE91bHZDRHRsYlRzb0p6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJpdzZyaXc2ckNBSU95WXBPMlVoT3Vkdk95ZHVDRHNnNEh0ZzV6c25vWHINCmk0anJpNlF1SU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc25ZUWc3Wm1WN0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU9xNHNPcTRzT3F3Z0NEcmhLVHRpcmpzbTR6dGdhenNsNUFnN0pldzZyS3c2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyaXc2cml3N0oyWUlPeVhzT3F5c0NEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21JSHNnNEhzbllRZzY3YUk2NStzN0ppazY0cVVJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKaUI3SU9CN0oyRUlPdTJpT3Vmck95WXBPcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95M3FPeUdqTzJWbU95THBDRHFzcjNzbXJBZzdJdWc3TEt0N1pXWTdJdWdJT3VDDQp0T3lhcWV5ZGdDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdJcTE2NHVJNjR1a0xnb3RJT3kzcU95R2pPMlZtT3VwdENEc2k2RHNzcTN0bFp3ZzY0SzA3SnFwN0oyMElPeWdnT3llcGV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvQ2kwZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvSUM4ZzdMZW83SWFNN1pXWTY2bTBJT3llaGV1Z3BlMlZuQ0RyZ3JUc21xbnNuYlFnN0lLczY1Mjg3S0M0N0pxVUxnb0tJeU1qSXlEcXNJRHNuYlRyazV3ZzdKaUk3SXVjSUNoMWVDMTNjbWwwYVc1bkxtMWs3SmVRN0lTY0lPeVlydXE1Z0NEaWdKUWc2cmVjN0xtWjdKeTg2NkdjSU95ZWtPdVBtZTJabENEcnFyc2c3WldZNjRxVUlPdXN1T3llcFNEc25xenF0YXpzaExFZzdJS3M2NkdBS1FvS0l5TWpJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxczZBZzZyT0U3SXVjNjRLWTdKcVVQd290SU95ZWtPdVBtZXl3cU9xdw0KZ0NEc25vanJncGpzbXBRL0Nnb2pJeU1nNjZlazY0dXNJT3V6dE8yWG1PdWpqT3VsdkNEc2xyenJwNGpzbEtrZzY0SzA2ck9nSU9xemhPeUxuT3VDbU95YWxEOEtMU0RycDZUcmk2d2c2N08wN1plWTY2T002NHFVSU95V3ZPdW5pT3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2NnNnJDQTdLZUFJT3VMcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUNpMGc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFISU9xd2dPeW5nQ0RyaTZUc2k1d2c3Wm1WN0oyNDdaV2c2cktNN0pxVUxnb0tJeU1qSU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bFpqc2k1enFzcURzbHJUc21wUS9DaTBnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWb09xNWpPeWFsRDhLQ2lNakl5RHNpNXpzbnBIdGxaanNpNXpyaXBRZzY3YUU3SmVRNnJLTUlEVXNNREF3N0p1UTdKMkVJT3VUbk91Z3BPeWFsQzRLTFNEc2k1enNucEh0bFpqcnFiUWdOU3d3TUREc201RHMNCm5ZUWc2NU9jNjZDazdKcVVMZ29LSXlNaklPeWR0T3lla0NEdG1aanJ0b2pzbllRZzY3Q2I3SldZN0phMDdKcVVMZ290SU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRdUNnb2pJeU1nN0ppazY0cVk3SjJZSU8yQXRPeW1pT3F3Z0NEcXM2Y2c3S0tGNjZPTTY0Kzg3SnFVTGdvdElPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEM0S0NpTWpJeURxdUlqc25ienF1WXpzcDRBZzY2KzQ2NEtwSU95TG5DRHNsN0Rzc3JRZzdMS1k2NmFzNjVDcDY0dUk2NHVrTGlEdG00VHJ0b2pxc3JEc29Kd2c2cmlJN0pXaDdKMkVJT3VDcWV1MmdPMlZtT3lMbk9xNHNDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdKaWs2NHFZNnJtTTdLZUFJT3VDdE95bmdDRHNsWXJzbkx6cnFiUWc3SmV3N0xLMDY0Kzg3SnFVTGlBdklPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2tPcXlnQ0RxdUxEcXNJVHNsNURyaXBRZzdJU2M2N21FDQo3SXFrSU95ZHRPeWFxZXlkdENEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUxvT3UyaE95bW5TRHRtWlhzbmJnZzdLQ0U3SmVRNjRxVUlPeUdvZXE0aUNEcnNJOGc2ckt3N0tDYzZyQ0FJT3UyaU9xd2dPMlZxZXVMaU91THBDNEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPdXpnT3F5dlNEc2k1d2c3THFRN0l1YzY3Q3hJT3llck95bmdPcTRpZXlkZ0NEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNnNEhyaTdRZzdaS0k3S2VJSU8yV3BleURnZXlkaENEcw0KbklUdGxiUWc3WWExN1ptVUlPdUN0T3lhcWV5ZHRDRHJoYm5zbll6cmtLbnJpNGpyaTZRdUNpMGc2NDJVSU95aWkreWRnQ0RzZzRIcmk3VHNuWVFnN0p5RTdaVzBJTzJHdGUyWmxDRHJnclRzbXFuc25ZQWc2NFc1N0oyTTY0Kzg3SnFVTGdvS0l5TWpJT3F6b09xd25ldUxtT3lkbUNEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZGdDRHF1TERyb1owZzZyU0E2NmFzNjVDcDY0dUk2NHVrTGdvdElPeWR0T3lnbk91MmdPMkVzQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkdENEcXVMRHJvWjNyajd6c21wUXVDZ29qSXlNZzdMS3Q3SWFNNjRXRTdKMkFJT3lFbk91NWhPeUtwQ0Rxc0lEc25vWHNuYlFnNjdhSTZyQ0E3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc3NxM3Nob3pyaFlUc25ZUWc3SnlFN1pXY0lPeUVuT3U1aE95S3BPdUtsQ0RzbFlUc3A0RWc3S1NBNjdtRUlPeWtrZXlkdE95WGtPeWENCmxDNEtDaU1qSXlNZzZyT0U3S0NWd3Jmc25vWHJvS1VLQ2lNakl5RHNsWVRzbmJUcmxKUWc2NWlRNjRxVUlPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3lkdE95RGdTRHNucGpycXJzZzdKNkY2NkNsN1pXWTdKZXNJT3F6aE95Z2xleWR0Q0RzbnFEcXVJZ2c3TEtZNjZhczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3llbU91cXV5RHNub1hyb0tYdGxiVHNoSndnNnJPRTdLQ1Y3SjIwSU95ZW9PcXl2T3lXdE95YWxDNGdMeURydVlUcnNJRHJzb2p0bUxqcnBid2c3SjZzN0lTazdLQ1Y3WldZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNuYlRycjdnZzdJS3M3SnFwSU95a2tleWR1Q0RzbFlUc25iVHJsSlRzbm9Ycmk0anJpNlF1Q2kwZzdKMjA2Nis0SU95VHNPcXpvQ0Rzbm9qcmlwUWc3SldFN0oyMDY1U1U3SmlJN0pxVUxpQXZJT3VMcE91bHVDRHNsWVRzbmJUcmxKVHJwYndnN0o2RjY2Q2w3WlcwDQpJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNncXpzbXFudGxhQWc3SWlZSU95WGh1dUtsQ0RydVlUcnNJRHJzb2p0bUxqc25vWHJpNGpyaTZRdUlPeVlnZXVzdUN3ZzdJaXI3SjZRTENEdGlybnNpSmpyckxqc25wRHJwYndnN1krczdaV283WldZN0plc0lEanNucEFnN0oyMDdJT0JJT3llaGV1Z3BlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc21JSHJyTGdzSU95SXEreWVrQ3dnN1lxNTdJaVk2Nnk0N0o2UTY2VzhJTzJQck8yVnFPMlZ0Q0E0N0o2UUlPeWR0T3lEZ1NEc25vWHJvS1h0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95ZWhldWdwU0Rxc0lEcmlxWHRsWndnNnJpQTdKNlFJT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzdKNkY2NkNsN1pXZ0lPeUltQ0Rzbm9qcmlwUWc2cmlBN0o2UUlPeUltT3VsdkNEcmhKanNsNGpzbHJUc21wUXVJQzhnNjRLMDdKcXA3SjJFSU95aHNPcTRpQ0RzcElUc2w2d2c3S084N0lTNDdKcVVMZ29LSXlNakl5RHRqSXpzbmJ6Q3QrcXlzT3lnbk1LMw0KNnJpdzdZT0FDZ29qSXlNZzdZeU03SjI4SU95YXFldWZpZXlkdENEc3RJanFzN3pya0pqc2w0anNpclhyaTRqcmk2UXVJREV3VFVJZzdKMjA3WldZN0oyWUlPMk1qT3lkdk91bmpDRHNsNFhyb1p6cms1d2c2ckNBNjRxbDdaV3A2NHVJNjR1a0xnb3RJREV3VFVJZzdKMjA3WldZSU8yTWpPeWR2T3VuakNEc21LenJwclFnN0lpWUlPeWVpT3lXdE95YWxDNGdMeUR0akl6c25id2c3SnFwNjUrSjdKMkVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NHVrN0pxMDY2R2M2NU9jNnJDQUlPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcmk2VHNtclRyb1p6cms1enJwYndnNjZlSTdMT2s3SmEwN0pxVUxnb0tJeU1qSU9xeXNPeWduT3lYa0NEc2k2VHRqS2p0bFpqc21JRHNpclhyaTRqcmk2UXVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHFzckRzb0p6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3F5c095Z25DRHMNCmlKanJpNmpzbllRZzdabVY3SjI0N1pXWTZyT2dJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXWTdKZXNJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXp0ZXF3aE95ZGhDRHRtWlhyczdUdGxad2c2NUtrSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lFbk91NWhPeUtwQ0RzcElEcnVZUWc3S1NSN0o2RjY0dUk2NHVrTGdvdElPeWtnT3U1aE8yVm1PcXpvQ0Rzbm9qcmlwUWc2cml3NjRxbDdKMjA3SmVRN0pxVUxpQXZJT3loc09xNGlPdW5qQ0RxdUxEcmk2VHJvS1FnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3VUc2V1aG5TRHFzSURyaXFYdGxad2c3TFdjNjR5QUlPcXduT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzDQppclhyaTRqcmk2UXVDaTBnNjQyVUlPdVRzZXVobmUyVm1PdWdwT3VwdENEcXVMRHNvYlFnN1pXdDY2cXA3SjJFSU95Q3JleWduTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095MmxPcXdnQ2tLQ2lNakl5RHN0cHpyajVrZzdKcVU3TEt0N0oyMElPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0xhYzY0K1pJT3lhbE95eXJleWRoQ0Rzb0pIc2lKanRsb2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLOTY3bUVJT3lEZ2UyRG5PdWx2Q0R0bVpYc25ianRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPcXl2ZXU1aENEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4Zw0KN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3lnaE8yWm1PMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3V3bE9xL2dPcTVqT3lhbEQ4S0NpTWpJeURyc0tucnJMZ2c3SmlJN0pXOTdKMjBJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzS25yckxnZzdKaUk3Slc5N0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHJ1WVRyc0lEcnNvanRtTGdnTmUyYWpDRHNtS1RycFpqcm9ad2c2ck9FN0tDVjdKMjBJT3llb09xNGlDRHNzcGpycHF6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SURYdG1vd2c3SjZZNjZxN0lPeWVoZXVncGUyVnRPeUVuQ0RxczRUc29KWHNuYlFnN0o2ZzZySzg3SmEwN0pxVUxpQXZJT3U1aE91d2dPdXlpTzJZdU91bHZDRHNucXpzaEtUc29KWHRsWmpycWJRZzY0dWs3SXVjSU95ZHRPeWENCnFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd0lDanNsNGJzbHJUc21wUWc0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFwQ2dvakl5TWc2N080N0oyNElPeWR1T3ltbmV5ZGhDRHRsWmpzcDRBZzdKV0s3Snk4NjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEcnM3anNuYmdnN0oyNDdLYWQ3SjJFSU8yVm1PdXB0Q0RycXFqcms2QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeWR0T3VwbE95ZHZDRHNuYmpzcHAwZzdLQ0U3SmVRNjRxVUlPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95ZHRPdXBsT3lkdkNEc25ianNwcDNzbllRZzY2ZUk3TG1ZNjZtMElPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95L29PMlBzT3lkZ0NEcm9aenF0N2pzDQpuYmdnN1p1RTdKZVE2NmVNSU95Q3JPeWFxU0Rxc0lEcmlxWHRsYW5yaTRqcmk2UXVDaTBnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3kvb08yUHNPeWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJyN2pzaExIcmhZVHNucERyaXBRZzY3TzA3Wmk0N0o2UUlPdVBtZXlkbUNEc2w0YnNuYlFnNnJLdzdLQ2M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzY3TzA3Wmk0N0o2UTZyQ0FJT3VQbWV5ZG1PMlZtT3VwdENEcXNyRHNvSnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsSVRyb1p6dGxZVHNuWVFnNjVPeDY2R2Q3WldZN0tlQUlPeVZpdXljdk91cHRDRHNuYlRzbXFuc25iUWc3S0NjN1pXYzY1Q3A2NHVJNjR1a0xnb3RJTzJVaE91aG5PMlZoT3lkaENEcms3SHJvWjN0bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2xiRWc2N0tFN0tDRTdKMjBJT3VDcnV5VmhDRHNuYnpydG9BZzZyaXc2NHFsN0oyMA0KSU95Z25PMlZuT3VRcWV1TGlPdUxwQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaV1k2Nm0wSU91cXFPdVRvQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc2N2lVNjZPbzdZaXM3SXFrNnJDQUlPcTZ2T3lndUNEc25vanNsclFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPdTRsT3VqcU8ySXJPeUtwT3VsdkNEc3ZKenJxYlFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPdTVoT3lEZ1NEc2w3RHJuYjNzc3BqcXNJQWc2NU94NjZHZDY1Q1k3S2VBSU95Vml1eVZtT3lLdGV1TGlPdUxwQzRLTFNEcnVZVHNnNEVnN0pldzY1Mjk3TEtZNjZXOElPdVRzZXVobmUyVm1PdXB0Q0RxdUxUcXVJbnRsYUFnNjVXTUlPdTVvT3VsdE9xeWpDRHNsN0RybmIzcms1enJwclFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc3RwenNub1VnN0xtMDY1T2M2ckNBSU91VHNldWgNCm5ldVFtT3luZ0NEc2xZcnNsWVFnN0lLczdKcXA3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdMYWM3SjZGSU95NXRPdVRuT3VsdkNEcms3SHJvWjN0bFpqcnFiUWc2N0NVNjZHY0lPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0lDanNtWVRybzR3ZzdKV0k2NEswS1FvS0l5TWpJTzJhak95YmtPcXdnT3llaGV5ZHRDRHNtWVRybzR6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzZyQ0E3SjZGN0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHNtSWpzbGIzc25iUWc3TGVvN0lhTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeVlpT3lWdmV5ZGhDRHN0NmpzaG96dGxvanNsclRzbXBRdUNnb2pJeU1nNjZ5NDdKMlk2ckNBSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SWljN0xDbzdLQ0I3Snk4NjZHY0lPdUx0ZXV6Z091VG5PdW1yT3F5b095S3RldUxpT3VMcEM0S0xTRHJyTGpzblpqcnBid2c3S0NSN0lpWTdaYUk3SmEwDQo3SnFVTGlBdklPeUluT3lFbk91TWdPdWhuQ0RyaTdYcnM0RHJrNXpycHJUcXNvenNtcFF1Q2dvakl5TWc3SVNrN0tDVjdKMjBJT3kwaU9xNHNPMlpsT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzaEtUc29KWHNuWVFnN0xTSTZyaXc3Wm1VN1phSTdKYTA3SnFVTGdvS0l5TWpJT3U1aE91d2dPdXlpTzJZdU9xd2dDRHJzNERxc3IzcmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SU91d2xPcS9xT3lXdE95YWxDNEtDaU1qSXlEc25ianNwcDNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHVPeW1uZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNaklPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUWdLT3luaU91c3VDRHNucXpxdGF6c2hMRXBDZ29qSXlNZzdKYTQ3S0NjSU91d3FldXN1TzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEcnNLbnJyTGdnNjRLZzdLZWM2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0phMA0KNjVha0lPdXdxZXV5bGV5Y3ZPdWhuQ0RzbmJqc3BwM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0oyNDdLYWRJT3V3cWV1eWxleWRoQ0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3F5c095Z25PMlZtT3lMcENEc3ViVHJrNXpycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEcXNyRHNvSnp0bGFBZzdMbTA2NU9jNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKdVE3WldZN0l1YzY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bFpqc2hManNtcFF1Q2kwZzdKdVE3WldZNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc2ck9FN0l1ZzZyQ0E3SnFVUHdvdElPeWp2T3lHak91bHZDRHNsWXpxczZBZzdKNkk2NEtZN0pxVVB3b0tJeU1qSXlEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0FvS0l5TWpJT3E0c09xd2hDRHINCnA0enJvNHpyb1p3ZzdKMjA3SnFwN0oyMElPeWtrZXluZ091UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc25iVHNtcWtnNnJpdzZyQ0U3SjIwSU91Qm5ldUNtT3lFbkNEc3A0RHF1SWpzbllBZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0pxcDY1K0pJT3UyZ095aHNleWN2T3VobkNEc29JRHNucVhzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95Z2dPeWVwZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1Q2dvakl5TWc3WWExN0l1Z0lPeVlwT3VsbU91aG5DRHNtcFRzc3Ezc25iUWc3SXVrN1l5bzdaV1k3SmlBN0lxMTY0dUk2NHVrTGdvdElPMkd0ZXlMb095ZHRDRHNtNUR0bVp6dGxaanNwNEFnN0pXSzdKV0VJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nDQo2cmFNN1pXY0lPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0pIcXQ3enNuYlFnNnJHdzY3YUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0phMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RxdG96dGxaenNuWVFnN0pxVTdMS3Q3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nN0lPQjdabXBJT3lWaU91Q3RDQW9NdXVMcUNEcXRhenNvYkFwQ2dvakl5TWc3SjZGNjZDbDdaV1k3SXVnSU95anZPeUdqT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnNjR1azdJdWNJTzJabGV5ZHVDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdLTzg3SWFNNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU91THBPeUxuQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lhbE95eXJlMlZtT3lMb0NEdGpwanNuYlRzcDREcnBid2c3TEMrN0oyRUlPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3WTZZN0oyMDdLZUE2Nlc4SU95dw0KdnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWp2T3lHak91bHZDRHRtWlhzbmJqdGxaanFzYkRyZ3BnZzdabUk3Snk4NjZHY0lPeWR0T3VQbWUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0K1o3SjI4N1pXY0lPeWFsT3l5cmV5ZHRDRHNzcGpycHF3ZzdLU1I3SjZGNjR1STY0dWtMaURzbnFEc2k1d2c3WnVFSU8yWmxleWR1TzJWdENEc283enNpNjNzaTV6c21LUXVDaTBnNnJDWjdKMkFJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpxczZBZzdKNkk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJUcnNxVHRpcmpxc0lBZzdLS0Y2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHRPdXlwTzJLdU9xd2dDRHJnWjNyZ3F6c2xyVHNtcFF1Q2dvakl5TWc3WU9JN1llMElPeUxuQ0RycXFqcms2QWc2NDJ3N0oyMDdZU3c2ckNBSU95Q3JleWduT3VRbU91cHNDRHJzN1hxdGF6dGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEsNCkxTRHRnNGp0aDdUdGxaanJxYlFnNjZxbzY1T2dJT3VOc095ZHRPMkVzT3F3Z0NEc2dxM3NvSnpya0pqcXM2QWc2NHVrN0l1Y0lPdVFtT3VQak91bXRDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWdsZXVua0NEdGc0anRoN1R0bGFEcXVZenNtcFEvQ2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3lEZ2UyWnFTRHNsWWpyZ3JRcENnb2pJeU1nNjdhQTdKNnNJT3lra1NEcnNLbnJyTGpzbnBEcXNJQWc2ckNRN0tlQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTJnT3llckNEc3BKSHNsNUFnNjdDcDY2eTQ3SjZRNnJDQUlPeWVpT3lYaU95V3RPeWFsQzRnTHlEc21JSHNnNEhzbllRZzdabVY3SjI0N1pXMElPdXp0T3lFdU95YWxDNEtDaU1qSXlEcXNyM3J1WVFnN1pXMDdLQ2NJT3Eyak8yVm5PeWR0Q0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cks5NjdtRUlPMlZ0T3lnbkNEcXRvenRsWnpzbmJRZzdaV0U3SnFVN1pXMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RzbXBUc3NxM3RsYlFnDQo3S084N0lTNDdKcVVMZ29LSXlNaklPMlpsT3llckNEcXNKRHNwNERxdUxBZzY3Q3c3WVN3NjZhczZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNEtMU0R0bVpUc25xd2c2ckNRN0tlQTZyaXdJT3V3c08yRXNPdW1yT3F3Z0NEc2xyenJwNGdnN0plRzdKYTA3SnFVTGlBdklPdXdzTzJFc091bXJPdWx2Q0RxdFpEc3NyVHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzdHBYc2xiMGdLeURxdUkzc29KVWc3S0NFN1ptWUlDanJrWkFnNjZ5NDdKNmxJT0tHa2lEcXVJM3NvSlh0bUpVZzdaV2NJT3VzdU95ZXBTa0tDaU1qSXlEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcg0Kc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bUp6dGc1MGc3SmVHN0oyMElPcXdnT3llaGUyVm9PcTVqT3lhbEQ4ZzdLZUE2cmlJSU95TG9PeXlyZTJWbU95bmdDRHNsWXJzbkx6cnFiUWc3SnV3N0x1MElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc3A0RHF1SWdnN0l1ZzdMS3Q3WldZNjZtMElPeWJzT3k3dENEdG1KenRnNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdMK2c3WSt3SU95WGh1eWR0Q0Rxc3JEc29KenRsYURxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdUNEc3Y2RHRqN0RzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVDaTBnN0wrZzdZK3c3SjJFSU91d20reWN2T3VwdENEcmpaUWc3S0NBNjZDMDdaV1k2cktNSU9xeXNPeWduTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEc2w0YnNuYlFnN0l1YzdKNlI3WldnNnJtTTdKcVUNClB5RHNsWXpycHJ6c25ZUWc3THljN0tlQUlPeVZpdXljdk91cHRDRHNwSkhzbXBUdGxad2c3SWFNN0l1ZDdKMkVJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPeVZqT3Vtdk95ZGhDRHN2SnpycWJRZzdLU1I3SnFVN1pXY0lPeUdqT3lMbmV5ZGhDRHJzSlRyb1p3ZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdKNlE2NCtaN0oyMDdMSzA2Nlc4SU91VHNldWhuZTJWbU95bmdDRHNsWXJxczZBZzY0U1k3SmEwNnJDSTZybU03SnFVUHlEcms3SHJvWjN0bFpqc3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNucERyajVuc25iVHNzclRycGJ3ZzY1T3g2NkdkN1pXWTY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURyczdnZzZyT0U3Slc5N0oyWUlPeWNvT3lkdk8yVm5DRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95ZHZPdXdtT3EwZ091bXJPeWVrT3VoDQpuQ0RxdG96dGxaenJzNERxc3Izc25ZUWc3WldZN0l1a0lPeUltQ0RzbDRic2xyVHNtcFF1SU95ZHZPdXdtQ0RxdElEcnBxenNucERyb1p3ZzZyYU03WldjSU91emdPcXl2ZXlkaENEc201RHRsWmpzaTZRZzZySzk3SnF3SU91THBPdWx1Q0RzZ3F6cm5venNsNURxc293ZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtDRHF0b3p0bFp6c25ZUWc3S2VBN0tDVjdaVzBJT3lqdk95TG9DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZuQ0Rya3FRZzdKMjg2N0NZSU9xMGdPdW1yT3lla091aG5DRHJzNERxc3IzdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXpnT3F5dmUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvPQ0KOjpHVUlERTo6DQpJeUJWV0NCWGNtbDBhVzVuSU9xd2dPeWR0T3VUbkFvS0l5TWdNUzRnN1pXMDdKcVU3TEswQ2dyc29KenRrb2dnN0pXSTdKMllJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWdKKzJWdE95YWxPeXl0Q2Zyb1p3ZzdJMm83SnFVTGdyc25ienF0SURzaExFZzdKNkk2NHFVSU95Q3JPeWFxZXlla0NEcXNyM3RsNWpzbllRZzY2ZU02NU9rSU95SW1DRHNub2pyajRUcm9aMGdLaXJzZzRIdG1ha3NJT3VucGV1ZHZleWRoQ0RydG9qcnJManRsWmpxczZBZzY2cW82NU9nSU91c3VPcTFyT3lYa0NEdGxiVHNtcFRzc3JUcnBid2c3S0NCN0pxcDdaVzA3S084N0lTNDdKcVVMaW9xQ2dyc21JZ3BDaTBnNjdPMDY0T0Y2NHVJNjR1a0lPS0draURyczdUcmdyenFzb3pzbXBRS0Npb3FLZ29LSXlNZ01pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzQW9LN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RzdFp6cmpJRHRsWndnS2lycmlxWHJqNW50bUpVZzY2eTQ3SjZsS2lyc25ZUWc3STJvN0tPODdJUzQ3SnFVTGlEc2lKanJqNW50bUpVZw0KNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVEV0N0lpWTY0K1o3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzazdEcmlwUWc2cktNSU95aWkreVZoT3lhbEM0S0NpTWpJeURya0pEc2xyVHNtcFFnNG9hU0lPMldpT3lXdE95YWxBb0s3SmlJS1FvdElPeUVwT3lnbGV1UWtPeVd0T3lhbENEaWhwSWc3SVNrN0tDVjdaYUk3SmEwN0pxVUNnb2pJeU1nSjM3c2w0Z25JT3U1dk9xNHNBb0s3SmlJS1FvdElPdXdsT3VBak95WGlPeVd0T3lhbENEaWhwSWc2N0NVNnIrbzdKYTA3SnFVQ2dvakl5TWc2NCtaN0lLc0lPdXdsT3EvbE95VHNPcTRzQW9LN0ppSUtRb3RJT3VHa3V5VmhPeWhqT3lXdE95YWxDRGlocElnN0ppczY1NlE3SmEwN0pxVUNnb3FLaW9LQ2lNaklETXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFLQ3V5Z25PMlNpQ0RzbFlqc2w1RHNoSndnNjdhQTdLQ1Y3S0NCSU95N3BPdXUNCnBPdUxpT3k4Z095ZHRPeUZtT3lkaENEc3RaenJqSUR0bFp3ZzdLU0U3SjIwNnJPZ0lPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvN0tPODdJUzQ3SnFVTGdycnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRNdDY3YUE3S0NWN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2phanNtcFF1Q2dyc21JZ2dPaURzbFlnZzY0Kzg3SnFVTENEc2w0YnNsclRzbXBRZ0tGZ3BJT0tHa2lCKzdaV1k2Nm0wSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVSUNoUEtRb0tJeU1qSU95WGh1eVd0T3lhbENEaWhwSWc3SjZJN0phMDdKcVVDZ3JzbUlncENpMGc2N08wN1ppNDdKNlE2ckNBSU8yWGlPdWR2ZTJWbU9xNHNDRHNvSVRzbDVEcmlwUWc2ckNBN0o2RjdaV2dJT3lJbUNEc2w0YnNsclRzbXBRZzRvYVNJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBDQo3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFLQ2lNakl5RHNsNURybjZ3ZzY2bVU3SXVjN0tlQUNncnNsNURybjZ3ZzdJT0I3Wm1wN0plUTdJU2M2NCtFSUNMdGxiVHFzckFnNjdDcDY3S1ZJdXlkaENEcnFMenNvSUFnN0pXTTY2Q2s3S084NjRxVUlPcTRqZXlnbGUyWWxTRHF0YXpzb2JEcm9ad2c3STJvN0pxVUxnb0s3SmlJS1FvdElPeW5nT3E0aUNEcnNvVHNvSVRzbDVEc2hKenJpcFFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95VnNleWRoQ0RzdFp6c2k2QWc2N0tFN0tDRTdKeTg2NkdjSU95WGhldU5zT3lkdE8yS3VDRHRsYlRzbzd6c2hManNtcFF1SU9LR2tpRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwN0tPODdJUzQ3SnFVTGlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDam82T2lCMGFYQWc2NHVrN0oyMDdKYTg2NkdjNnJlNA0KSU95WnZPeXF2U0Ryc29UdGlyenNuWUFnVyt1THErcTRzRjBLNjR1azdKMjA3SmE4NjZHYzZyZTRJT3ladk95cXZTRHJzb1R0aXJ6c25ZQWdLaXJyaTZ2cXVMQXFLdXVobkNEcnJManF0YXpycGJ3ZzdZYTE3SjI4N1pXMDdKcVVMaUFxS3V5M3FPeUdqQ29xNjRxVUlPeUNyT3lhcWV5ZWtPcXdnQ0R0bFpqcXM2QWc3SjZJNjRxVUlPeWVrZXlYaGV5ZHRDRHN0NmpzaG96cmtKenJpNlRxczZBZzdKaWs3WlcwN1pXZ0lPeUltQ0Rzbm9qc2xyUWc3Sk93N0tlQUlPeVZpdXlWaE95YWxDNEtPam82Q2dvakl5TWc3WmljN1lPZDdKMkVJT3V3bSt5ZGhDRHNpSmdnN0plRzdKMkVJT3VWakFvSzdKaUlLUW90SU91cXFPeWVoT3luZ095YmtPcTRpQ0RzbDRic25iUWc2NnFvN0o2RTdZYTE3SjZsN0oyRUlPdW5qT3VUcE9xNWpPeWFsRDhnN0tlQTZyaUlJT3V3bSt5bmdDRHNsWXJzbkx6cnFiUWc2NnFvN0o2RTdLZUE3SnVRNnJpSTdKMkVJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlEaWhwSWc3Slc5NnJTQTdKZVENCklPdVBtZXlkbU8yVm1PdXB0Q0RycXFqc25vVHNwNERzbTVEcXVJanNuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN1ppYzdZT2RJT3VNZ095RGdTRHNsWWpyZ3JRS0Npb3E3SVNjNjdtRTdJcWs2NHFVSU95VHVDRHNpSmdnN0o2STdLZUE2NmVNTENEdGlybnNvSlVnN1ppYzdZT2Q3SjJBSU91d20reWRoQ0RzaUpnZzdKZUc3SjJFSU91VmpDRGlocElnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXljdk91aG5DRHNqYWpzbXBRdUtpb0s3SUtzN0pxcDdKNlE2NHFVSU91c3VPcTFyT3VsdkNEcXZMenF2THp0bm9nZzdKMjk3S2VBSU95Vml1cXpvQ0R0bTVIc2xyVHJzN1RxdUxBbzdJcWs3THFVS1NEcmxZenJyTGpzbDVBc0lPdTJnT3lnbGUyWWxleWN2T3VobkNEc2s3RHJxYlFnN0tDYzdaS0lJT3lnaE95eXRPdWx2Q0RzazdnZzdJaVlJT3lYaHV1THBPcXpvQ0RzbUtUdGxiVHRsWmpxdUxBZzdJbXM3SnVNN0pxVUxnb0s3SmlJS1FvdElPcXpoT3lpakNEcXNKenNoS1FnN1ppYzdZT2Q3SjJBDQpJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlEaWhwSWdOQzQxSlNEcXVJanJwcXdnN1ppYzdZT2Q2NmVNSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tLaW9xQ2dvakl5QTBMaURzdXBEc283enNscnp0bFp3ZzZySzk3SmEwQ2dyc29KenRrb2dnN0pXSTdKZVE3SVNjSUNkKzdJdWM2cktnN0phMDdKcVVQeWNzSUNmc2k1enJncGpzbXBRL0p5d2dKMzdxdTVnbklPcXdtZXlkZ0NEcXM3enJqNFR0bFp3ZzZySzk3SmEwNjZXOElPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdUN1eTFuT3VNZ08yVm5DRHN1cERzbzd6c2xyenRsWmpxczZBZzdMbWM2cmU4N1pXY0lPdW5rTzJJck91bHZDRHNrN0RyaXBRZzZyS01JT3lpaSt5VmhPeWFsQzRLNnJLOTdKYTA2NHFVSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVEl0NnJLOTdKYTA2Nlc4TGV5TnFPdVBoQzNya0pqcmlwUXQ2cks5N0pxd0tleVhrQ0R0bGJUcmk3bnRsYUFnNjVXTTY2ZU1JT3lOcU95YWxDNEtDaU1qSXlEcmo1bnNncXpzbDVEcw0KaEp3Z0ozN3NpNXduSU91NXZPcTRzQW9LN0ppSUtRb3RJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsWmpzaTV6cXNxRHNsclRzbXBRL0lPS0draURzdWJUcms1enJwYndnN1pXMDdLZUE3WldnNnJtTTdKcVVQd290SU95TG5PeWVrZTJWbU95TG5PdUtsQ0RydG9Uc2w1RHFzb3dnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxpRGlocElnN0l1YzdKNlI3WldZNjZtMElEVXNNREF3N0p1UTdKMkVJT3VUbk91Z3BPeWFsQzRLQ2lNakl5QW42ck9FN0l1YzY0dWtKeURpaHBJZ0oreWVpT3VMcENjS0N1eVlpQ2tLTFNEc25wRHJqNW5zc0tqcnBid2c2ckNBN0tlQTZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4ZzRvYVNJT3lla091UG1leXdxT3F3Z0NEc25vanJncGpzbXBRL0NpMGc2NmVrNjR1c0lPdXp0TzJYbU91ampDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhnNG9hU0lPdW5wT3VMckNEcnM3VHRsNWpybzR6cmlwUWc3SmE4NjZlSTdKMjQ2ckNBN0pxVVB5QXFLT3VMcU95SW5DRHMNCnVaanRtWmpzbmJRZzdKV0U2NHVJNjUyOElPdXN1T3llcGV5ZGhDRHNnNGpyb1p3ZzdKTzBJT3lDck91aGdPeVlpT3lhbENrcUNnb2pJeU1nSit5WHJPeXRpT3VMcENjZzRvYVNJQ2Z0bVpYc25ianRsWmpyaTZRc0lPdXN1K3VMcENjS0N1eVlpQ2tLTFNEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvZnFzSURzcDRBZzY0dWs3SXVjSU95WHJPeXRwT3V6dk9xeWpPeWFsQzRnNG9hU0lPeVZpT3lnaE8yVm5DRHFzSnp0aHJYc25ZUWc3SnlFN1pXMElPdXFoK3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJQ2ZxdTVnbklPS0draUFuN0plUTZyS01Kd29LN0ppSUtRb3RJTzJaamVxNHVPdVBtZXVMbU9xN21DRHJncURzbFlUcXNJRHFzNkFnN0o2STdKYTA3SnFVTGlEaWhwSWc3Wm1ONnJpNDY0K1o2NHVZN0plUTZyS01JT3VDb095VmhPcXdnT3F6b0NEc25vanNsclRzbXBRdUNnb2pJeU1nNnJLOTdKYTA2Nlc4SU91NmtPeWRoQ0RybFl3ZzdKYTA3SU9KDQo3WldjSU9xeXZleWFzQW9LN0lLczdKcXA3SjZRN0oyWUlPeWdsZXV6dE91bHZDRHJzSnZyaXBRZzdLZUk2Nnk0N0plUTdJU2NJT3E0c09xemhPeWdnZXljdk91aG5DQW5mdXlMbkNmcnBid2c2N3FRN0oyRUlPdVZqQ0Ryckxqc25xWHNuYlFnN0phMDdJT0o3WldnSU95SW1DRHNub2pzbHJUc21wUXVDaW9xN1l5TTdKV0Y3WldZNnJPZ0lPeUx0dXlkZ0NEc29KWHJzN1RycGJ3Z0oreWp2T3lXdENmcm9ad2c3STJvN0lTY0lPdXN1T3llcGV5ZGhDRHNnNGpyb2EzcXNvd2c3STJvNjdPMDdJUzQ3SnFVTGlvcUNncnNtSWdwQ2kwZzdKYTA2NWFrSU91cXFleWdnZXljdk91aG5DRHJqSURzdHB6cnNKdnNuTHpzaTV6cmdwanNtcFEvSU9LR2tpRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0xTRHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOGc0b2FTSU95TG9PcXpvQ0RzbmJUc25LRHJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUV1T3lhbEM0Sw0KQ2lvcUtnb0tJeU1nTlM0Z0ozdnJxb1hzZ3F4OUlDc2dlK3VxaGV5Q3JIMG5JT3lUc095bmdDRHNsWXJxdUxBS0NpTWpJeUR0bFp6c25wRHNsclFnN1pLQTdKYTA3Sk93NnJpd0NncnRsWnpzbnBEc2xyUWc2NnFGN0lLczY2VzhJTzJTZ095V3RPeUVuQ0RyajVuc2dxd2c3WmlWN1lPYzY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LN0ppSUtRb3RJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVSU9LR2tpRHNuYlRzbnBEcnBid2c2NCtNNjZDazY3Q2I3SldZN0phMDdKcVVDaTBnNjRLMDdKMjhJT3k1dE91VG5PcXdrdXlkdENEcXNyRHNvSnpya0tBZzdKaUk3S0NWN0oyMDdKZVE3SnFVSU9LR2tpRHJnclRzbmJ6c25ZQWc3TG0wNjVPYzZyQ1NJT3VDbU9xd2dPdUtsQ0RyZ3FEc25iVHNsNURzbXBRS0NpTWpJeUR0bFp6c25wRHNsclRycGJ3ZzdaS0E3SmEwN0pPdzZyaXdJT3lXdE91Z3BPeWF1Q0Rxc3Izc21yQUtDaWQ3NjZxRjdJS3NmZXF3Z0NCNzY2cUY3SUtzZmUyVnRPeUUNCm5DY2c3WmlWN1lPYzY2R2M2NmVNSU8yU2dPeVd0T3lrbU91UGhDRHJqWlFnN0xxUTdLTzg3SmE4N1pXWTZyS01JT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LN0ppSUtRb3RJT3llbE95Vm9TRHJ0b0Rzb2JIc25MenJvWndnNnJXczY2ZWs3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQ0RpaHBJZzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDZ29xS2lvS0NpTWpJRFl1SU8yUm5PcTRzQ0R0aHJYc25id0tDaU1qSXlEcmtKanNsclRzbXBRZ0tGZ3BJT0tHa2lEcmo3enNtcFFnS0U4cENncnJxcWpyc0pUc25id2c3Wm1VNjZtMDdKMllJT3lpZ2V5ZGdDRHFzN1hxc0lUc25ZUWc2ck9nNjZDazdaVzBJQ2Zya0pqc2xyVHNtcFFuNjRxVUlPdXFxT3VSa0NBbjY0Kzg3SnFVSit1aG5DRHRoclhzbmJ6dGxiVHNoSndnN0kybzdLTzg3SVM0N0pxVUxnb0tLaW9xQ2dvaklPeVlpT3ladUNEcXQ1enN1WmtLQ3V5YmtPeTVtU2pyaXFYcmo1bkN0K3E0DQpqZXlnbGNLMzdMcVE3S084N0phOEtldXp0T3VMcENEc21JanNtYmpxc0lBZzY0MlVJT3VxaGUyWmxlMlZuQ0RzdTZUcnJxVHJpNGpzdklEc25iVHNoWmpzbllRZzY2ZU02NU9jNjRxVUlPcXl2ZXlhc095WWlPeWFsQzRLQ2lNaklPeVlpT3ladUNBeExpRHNpSmpyajVudG1KVWc2Nnk0N0o2bDdKMkVJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3Q2dvakl5TWc3SVNjNjdtRTdJcWtJT3lpaGV1ampDd2c2cml3NnJDRUlPdW5qT3VqakFvSzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VHNPdXB0Q0Rzbzd6c2xyUW83S0tGNjZPTUlPeUVuT3U1aE95S3BDd2c2cml3NnJDRUlPdVRzU25ycGJ3ZzZyQ1Y3S0d3N1pXZ0lPeUltQ0Rzbm9qcXM2QXNJQ2Zzb29Ycm80d243Sm1BSUNmcnA0enJvNHduN0oyWUlPdUptT3lWbWV5S3BPdWx2Q0Rzb0pYdG1aWHRub2dnN0tDRTY0dXM3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ3JzbUlncENpMGdUMDlQSU95RW5PdTVoT3lLcENEc29vWHJvNHdnN0pXSTY0SzBJT0tBbENBdw0KTU95YmxDQXdNT3lkdk91MmdPMkVzQ0RzaEp6cnVZVHNpcVRxc0lBZzdLS0Y2Nk9NNjQrODdKcVVMaURzbnBEc2hManRsWndnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3VUbk91Z3BPeWFsQzRLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZ29LNjR1b0xDQXFLdXlqdk9xNHNPeWdnZXljdk91aG5DRHNvb1hybzR6cXNJQWc2N0NZNjdPMTY1Q1k2NHFVSU95Z25PMlNpQ29xN0plUTY0cVVJQ2Zzb29Ycm80enJqN3pzbXBRbjY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVDZ3JzbUlncENpMGc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVJT0tHa2lEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURyZ1ozcmdwanNtcFFLQ2lNakl5RHNncXpzbXFuc25wRHNsNURxc293ZzY2KzQ3TG1ZNjRxVUlPeVlnZTJXcGV5ZGhDRHNsWXpyb0tUc3BJUWc2NVdNQ2dvbzdLTzg3SnFVSU91UG1leUNyQ0E2SU95WHNPeXkNCnRDd2c3WlcwN0tlQUxDRHNvSUhzbXFrZzY1T3hLUW9LN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lUc091cHRDRHNuYmpxczd3ZzZyU0E2ck9FNjZXOElPdXFoZTJabGUyVm1PcXlqQ0RzaEtUcnFvWHRsWmpxczZBc0lDZnNncXpzbXFuc25wRHNuWmdnN1phSjY0K1o3SmVRSU91VXNPdWR2T3lZcE91S2xDRHFzckRxczd3bjY1Mjg2NHFVSU95Z2tPeWRoQ0RzbFl6cm9LVHNwSVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHNtS1RyaXBqcXVZenNwNEFnNjRLMDdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbDdEc3NyVHJqN3pzbXBRdUlPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb3RJT3VNZ095Mm5PeWRoQ0Rxc0lqc2xZVHRnNERycWJRZzdKdVE2NTZZSU91TWdPeTJuT3lkdENEdGxiVHNwNERyajd6c21wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXaWV5WGtDRHJnclRzbGJ3ZzdaVzA3SnFVTGdvS0l5TWpJT3lDDQpyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPeUltT3VQbWUyWWxTa0tDaWZzb0pYcnM3UWc3SWlZN0tlUklPeVZpT3VDdENjZzY1T3g3SjJZSU91dnZPcXdrTzJWbkNEc2c0SHRtYW5zbDVEc2hKd2dLaXJzaTV6c2lxVHRoWnpzbmJRZzdKNlE2NCtaN0p5ODY2R2NJT3l5bU91bXJPMlZuT3VMcE91S2xDRHNvSkFxS3V5ZGhDRHNpSmpyajVudG1KWHNuTHpyb1p3ZzdKV002NkNrSU95Q3JPeWFxZXlla091bHZDRHNsWWpzaTZ6dGxaanFzb3dnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0oyMDdLQ2M2N2FBN1lTd0lPMlpqZXE0dU91UG1ldUxtT3lkbUNEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFFLTFNEcmpaUWc3S0tMN0oyQUlPeURnZXVMdE95ZGhDRHNuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkZ0NEcmhibnNuWXpyajd6c21wUUtDaU1qSU95WWlPeVp1Q0F5TGlEcXNyM3NsclRycGJ3ZzdJMm82NCtFSU91UW1PdUtsQ0Rxc3Izcw0KbXJBS0N1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla095ZG1DRHJwNlhybmIzc25ZUWc3Wm1jN0pxcDdaVzA3SVNjSU95bmlPdXN1TzJWb0NEcmxZd0tDaWZzaTV6cmdwanNtcFEvSnl3Z0oreUZxT3VDbU95YWxEOG5JTzJZbGUyRG5PeWRtQ0Rxc3Izc2xyVHJwYndnN1ptYzdKcXA3WlcwN0lTY0lPeUNyT3lhcWV5ZWtPeWRtQ0RyaTdudG1hbnNpcVRybjZ6c200RHNuWVFnN0tTRTdKMjhJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdabU42cmk0NjQrWjY0dVlMQ0JQVDA4ZzY0dWs2NFdBN0ppazdJV282NEtZN0pxVVB3b3RJT3kycWV5Z2hPMlZtT3VmckNEdGpyanNuWmpzb0pBZzZyQ0E3SXVjNjRLWTdKcVVQd29LSXlNaklPeUNyT3lhcWV5ZWtPeWRtQ0RzZzRIdG1hbnMNCm5ZUWc3TGFVN0tDVjdaV2dJT3VWakFvSzY2cUY3Wm1WN1pXY0lPeWdsZXV6dE9xd2dDRHNsNGJzbHJUc2hKd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeW5nZXlna1NEdGpKRHJpNmp0bFpqcXNvd2c3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHN1YlRyazV6cnBid2c2N0NiN0p5ODdJV282NEtZN0pxVVB5RHJrN0hyb1ozdGxaanJxYlFnN0xxUTdJdWM2N0N4SU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SVNnN0oyWTZyQ0FJTzJWaE95YWxPMlZvQ0RybFl3S0N1eUVwT3VzdU95aHNPeUNyT3l5bU91ZnZDRHNncXpzbXFuc25wRHNuWmdnN0lTZzdKMlk2Nlc4SU9xNHNPdU1nTzJWdE95VnZDRHRsYUFnNjVXTUlPcXl2ZXlXdE91aG5DRHNvSlhzcEpIdGxaanFzb3dnN0tlSTY2eTQ3WlcwN0pxVUxnb0s3SmlJDQpLUW90SU95ZHRPdXlpQ0RyaTZ6c2w1QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWbU91cHRPeUVuQ0RzbHJ6cnA0anJncGdnNjZlTTdLR3g3WldZN0lXbzY0S1k3SnFVUHdvS0l5TWc3SmlJN0ptNElETXVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBS0N1eUNyT3lhcWV5ZWtPeVhrT3F5akNEcnFvWHRtWlh0bFpqcXNvd2c2N2FBN0tDVjdLQ0I3SjI0SU91Q3RPeWFxZXlkaENEc2xZenJvS1RzcEpqc2xid2c3WldnSU91VmpPdUtsQ0RydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJFSU95TnFPdVBoQ0Rzb292c2xZVHNtcFF1Q2dvakl5TWc3SVNjNjdtRTdJcWs2Nlc4SU95Z2xleXhoZXlEZ1NEc2s3Z2c3SWlZSU95WGh1eWRoQ0RybFl3S0N1dTJnT3lnbGUyWWxleWN2T3VobkNEc2phanNsYndnN0lLczdKcXA3SjZRN0plUTZyS01JT3lEZ2UyWnFleWRoQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN0l1YzdZS3NJT3lJbUNEc25vanNsclRzbXBRdQ0KSUNvcTdKTzRJT3lJbUNEc2w0YnJpcFFnN0oyMDdKeWc2Nlc4SU8yVnFPcTdtQ0RzbFlqcmdyVHRsYlRzbzd6c2hManNtcFF1S2lvS0N1eVlpQ2tLTFNEc3A0RHF1SWpzbllBZzZyQ0E3SjZGN1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SU95eXJleUdqT3VGaE95ZGhDRHNuSVR0bFp3ZzdJU2M2N21FN0lxazY0cVVJT3lWaE95bmdTRHNwSURydVlRZzdLU1I3SjIwN0plUTdKcVVMZ290SU9xenRldXN0T3lia095ZGdDRHRtNFRzbTVEcXVJanNuWVFnNjdPMDY0SzhJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdLQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE2ckNBSU95V3RPdVdwQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0RzbDRicmlwVHNwNEFnNjZxRjdabVY3WldZNnJLTUlPeWR1T3luZ08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvSzdKaUlLUW90SU95Z2tPcXlnQ0RxdUxEcXNJUWcNCjY0K1o3SldJSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla0NEc2hLRHRnNTNzblpnZzZyS3c2ck84NjZXOElPeVZpT3VDdE8yVm9DRHJsWXdLQ3V1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPeUVvTzJEbmV5ZGdDRHJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzY2cUY3Wm1WN1pXWTZyS01JT3lWak91Z3BPeWFsQzRLQ3V5WWlDa0tMU0R0bFp3ZzY3S0lJT3V3bE9xK3VPdXB0Q0RzdXBEc2k1enJzTEhzbllBZzY0dWs3SXVjSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrS0NpZnNvSlhyczdRZzdJaVk3S2VSSU95VmlPdUN0Q2NnNjVPeDdKMllJT3V2dk9xd2tPMlZuQ0RzDQpnNEh0bWFuc2w1RHNoSndnS2lyc29KWHJzN1Rxc0lBZzY3TzA3Wmk0NjVDYzY0dWs2NHFVSU95Z2tDb3E3SjJFSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzbFl6cm9LUWc3SUtzN0pxcDdKNlE2Nlc4SU95VmlPeUxyTzJWbU9xeWpDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrS0xTRHNnNEhyaTdUc25iUWc2NEdkNjRLWTY2bTBJT3lnaE91c3VPcXdnT3VQaENEdG1ZM3F1TGpyajVucmk1anNuWmdnN0tDVjY3TzA2Nlc4SU91enZDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1Rxc0lBZzZyaXc2NkdkNjVDWTdLZUFJT3lWaXV5VmhPeWFsQzRLQ2lNaklPeVlpT3ladUNBMExpRHNvSnp0a29nZzdKcXA3SmEwNjRxVUlPdXdsT3ErdU95bmdDRHNsWXJxdUxBS0NpZnFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NjZzdKdVE3TG1aNjdPMDY0dWtJQ29xN1ptVTY2bTA3SjJZSU9xNHNPdUtwZXVxaGNLMzY3S0U3WXE4NjZxRjZyTzg3SjJZSU95YQ0KcWV5V3RDRHNuYnpzdVpncUt1cXdnQ0RzbXJEc2hLRHNuYlRzbDVEc21wUXVDdXE0c091S3BldXFoZXlYa0NEc2s3RHNuYmdnNjR1bzdKYTBLT3V6Z09xeXZTd2c3S2VBN0tDVkxDRHJrN0hyb1owZzY1T3hLZXVsdkNEc2xZanJnclFnNjZ5NDZyV3M3SmVRN0lTY0lPdUxwT3VsdUNEcnA1RHJvWndnNjdDVTZyNjQ2Nm0wSU95Q3JPeWFxZXlla09xd2dDRHJpNlRycGJnZzZyaXc2NHFsN0p5ODY2R2NJT3lZcE8yVnRPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1NBbjZyYU03WldjSU91emdPcXl2U2NnNnJpdzY0cWw3SjJZSU95VmlPdUN0Q0RyckxqcXRhd0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V3bE9xL2dDRHNpSmdnN0o2STdKYTA3SnFVSUNoWUtRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N09BNnJLOTdaV2cNCklPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cENnb2pJeURzbUlqc21iZ2dOUzRnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NJT3lUc095bmdDRHNsWXJxdUxBS0N1dXN1T3Exck91bHZDRHNsWVRyckxUcnBxd2c2NmVrNjRHRTY1Kzk2cktNSU91THBPdVRyT3lXdE91UGhDQXFLdXlMcE95Z25DRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F3cUt1dWx2Q0RzazdEcnFiUWc3SjZZNjZxNzY1Q2NJT3VzdU9xMXJPeVlpT3lhbEM0S0N1eVlpQ2tnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDQW43TGFVNnJDQUlPeW5nT3lnbFNmdGxaanJpcFFnN0l1YzdJcWs3WVdjN0plUTdJU2NJQ2pzbmJUc29JVEN0K3lXa2V1UGhDRHF1TERyaXFYc25iUWc3SldFNjR1WUtRb3RJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDRHJoSmpxc3Fqc283enNoTGpzbXBRZ0tGZ2c0b0NVSU95WGh1dUtsQ0FuDQo2NFNZNnJpdzZyaXdKeURxdUxEcmlxWHNuWVFnN0pXVTdJdWNLUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxiUWc3S084N0lTNDdKcVVJQ2hQS1FvPQ0KOjpMQVVOQ0hFUjo6DQovLzRuQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJDQUhJQWFRQmtBR2NBWlFBZ0FHd0FZUUIxQUc0QVl3Qm9BR1VBY2dBZ0FCUWdJQURvc3NTc3hMd2dBQ1RCRmNnZ0FCRElnS3dnQU1UV0lBRGtzcXk1SUFEa3dvblZDZ0FuQUNBQVl3QnNBR0VBZFFCa0FHVUFZZ0J5QUdrQVpBQm5BR1VBT2dBdkFDOEFJQUFFMVZ5NG9ORmN6M1RISUFCMHh5QUFETk44eDBUSElBQ0F2WGk1NUxJZ0FDZ0E4YlJkdURvQUlBQjAwRnk0M0xUa3NxeTVMUURReG5UUXJibnd4YkNzTGdCMkFHSUFjd0FwQUM0QUNnQW5BQ0FBVkxzQXJDQUFZTDQ0eUNBQWlNYzh4M1M2SUFCYzFTQUFpTHpReFNBQVdOV1lzQ25GSUFCSXhiU3dXTlhnckN3QUlBRGtzaUFBQU1sRXZoaTBkTG9nQU9TeXJMbDh1U0FBUGN3Z0FNYkZkTWNnQU9UQ2lkVmMxZVN5TGdBS0FGTUFaUUIwQUNBQVpnQnpBRzhBSUFBOUFDQUFRd0J5QUdVQVlRQjBBR1VBVHdCaUFHb0FaUUJqQUhRQUtBQWlBRk1BWXdCeUFHa0FjQUIwQUdrQWJnQm5BQzRBUmdCcEFHd0FaUUJUQUhrQQ0KY3dCMEFHVUFiUUJQQUdJQWFnQmxBR01BZEFBaUFDa0FDZ0JUQUdVQWRBQWdBSE1BYUFBZ0FEMEFJQUJEQUhJQVpRQmhBSFFBWlFCUEFHSUFhZ0JsQUdNQWRBQW9BQ0lBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRk1BYUFCbEFHd0FiQUFpQUNrQUNnQmtBR2tBY2dBZ0FEMEFJQUJtQUhNQWJ3QXVBRWNBWlFCMEFGQUFZUUJ5QUdVQWJnQjBBRVlBYndCc0FHUUFaUUJ5QUU0QVlRQnRBR1VBS0FCWEFGTUFZd0J5QUdrQWNBQjBBQzRBVXdCakFISUFhUUJ3QUhRQVJnQjFBR3dBYkFCT0FHRUFiUUJsQUNrQUNnQnpBR2dBTGdCREFIVUFjZ0J5QUdVQWJnQjBBRVFBYVFCeUFHVUFZd0IwQUc4QWNnQjVBQ0FBUFFBZ0FHUUFhUUJ5QUFvQUNnQW5BQ0FBTVFBdkFESUFLUUFnQUU0QWJ3QmtBR1VBTGdCcUFITUFJQUFReUlDc0lBQVVJQ0FBeHNVOHgzUzZJQURrc3JUR1hMamN0Q0FBbU5OMHg4REpmTGtnQVBURnRNVUF5ZVN5Q2dCSkFHWUFJQUJ6QUdnQUxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BSUFCM0FHZ0ENClpRQnlBR1VBSUFCdUFHOEFaQUJsQUNJQUxBQWdBREFBTEFBZ0FGUUFjZ0IxQUdVQUtRQWdBRHdBUGdBZ0FEQUFJQUJVQUdnQVpRQnVBQW9BSUFBZ0FFa0FaZ0FnQUUwQWN3Qm5BRUlBYndCNEFDZ0FJZ0JPQUc4QVpBQmxBQzRBYWdCekFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGk0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQmJBRlhXZU1kZEFFVEhJQUFFc25TNWRMb2dBT1N5dE1aY3VOeTBJQUNZMDNUSHdNa0FyQ0FBOU1XOXVjaXk1TEl1QUNBQUpNRll6bnk1SUFESXVWek9JQUNrdEN3QUlBQU0xZXkzK0sxNHg5REZITUVnQUhUUVhMamN0Q0FBaEx5ODBrVEhJQURrc3R6Q0lBQU1zdXkzSUFEOHlEakJsTVl1QUNJQUxBQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUIyQUdJQVR3QkxBRU1BWVFCdUFHTUFaUUJzQUNBQUt3QWdBSFlBDQpZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FERUFMd0F5QUNrQUlBQVVJQ0FBVGdCdkFHUUFaUUF1QUdvQWN3QWlBQ2tBSUFBOUFDQUFkZ0JpQUU4QVN3QWdBRlFBYUFCbEFHNEFDZ0FnQUNBQUlBQWdBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQm9BSFFBZEFCd0FITUFPZ0F2QUM4QWJnQnZBR1FBWlFCcUFITUFMZ0J2QUhJQVp3QXZBR3NBYndBdkFHUUFid0IzQUc0QWJBQnZBR0VBWkFBaUFBb0FJQUFnQUVVQWJnQmtBQ0FBU1FCbUFBb0FJQUFnQUZjQVV3QmpBSElBYVFCd0FIUUFMZ0JSQUhVQWFRQjBBQW9BUlFCdUFHUUFJQUJKQUdZQUNnQUtBQ2NBSUFBeUFDOEFNZ0FwQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0FBRU1pQXJDQUFGQ0FnQU1iRlBNZDB1aUFBSk1GWXpyY0FYTGo0clhqSElBQXB2Slc4Uk1jZ0FFakZ0TEJjMWVTeUNnQkpBR1lBSUFCekFHZ0FMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQQ0KSUFCM0FHZ0FaUUJ5QUdVQUlBQmpBR3dBWVFCMUFHUUFaUUFpQUN3QUlBQXdBQ3dBSUFCVUFISUFkUUJsQUNrQUlBQThBRDRBSUFBd0FDQUFWQUJvQUdVQWJnQUtBQ0FBSUFCTkFITUFad0JDQUc4QWVBQWdBQ0lBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFBQ3NJQUFrd1ZqTy9MTWdBSWpId01rZ0FFckZSTVdVeGlBQUtBQVF0cFN5SUFCUUFFRUFWQUJJQU5ERklBREd4YlRGbE1ZcEFDNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdBdzBmaTdFTEhReFJ6QklBQkV4WmkzZkxrZ0FDVEJXTTYzQUZ5NCtLMTR4MXpWSUFDa3RDd0FJQUIwMEZ5NDNMUWdBSVM4dk5KRXh5QUE1TExjd2lBQURMTHN0eUFBL01nNHdaVEdPZ0FpQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQUpnQWdBSFlBWWdCREFISUFUQUJtQUNBQUpnQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBaUFDQUENCklBQnVBSEFBYlFBZ0FHa0FiZ0J6QUhRQVlRQnNBR3dBSUFBdEFHY0FJQUJBQUdFQWJnQjBBR2dBY2dCdkFIQUFhUUJqQUMwQVlRQnBBQzhBWXdCc0FHRUFkUUJrQUdVQUxRQmpBRzhBWkFCbEFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBSUFBZ0FHTUFiQUJoQUhVQVpBQmxBQ0FBYkFCdkFHY0FhUUJ1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFWZFo0eHlBQUtieVZ2RG9BSUFBdzBmaTdFTEhReFJ6QklBQmpBR3dBWVFCMUFHUUFaUUFnQUMwQUxRQjJBR1VBY2dCekFHa0Fid0J1QUNBQWRNY2dBSVM4Qk1oRXh5QUFuTTBsdUZqVmRMb2dBQURKUkw0Z0FFVEd6TGlGeDhpeTVMSXVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUtBQ3N3S25HDQp5YmRBeHlBQWRNY2dBRkFBUXdEUXhTQUFYTGo0clhqSEhMUWdBSFRRWExqY3RDQUFiSzNGc3lBQVhOWEVzOURGSE1FZ0FDak1FS3dwdE1peTVMSXVBQ2tBSWdBc0FDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUhZQVlnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURJQUx3QXlBQ2tBSUFBVUlDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNJQUNnQWdBQ0FBVndCVEFHTUFjZ0JwQUhBQWRBQXVBRkVBZFFCcEFIUUFDZ0JGQUc0QVpBQWdBRWtBWmdBS0FBb0FKd0FnQUFESlJMNGdBRVRHekxnZ0FCUWdJQURrc3F5NWZMa2dBRDNNSUFER3hYVEhJQURrd29uVklBQW9BQXpWN0xmNHJYakhkTWNnQU9lc0lBQ1F4OW16SUFBUXJNREpLUUFLQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JqQUcwQVpBQWdBQzhBWXdBZ0FHNEFid0JrQUdVQUlBQnpBR01BY2dCcEFIQUFkQUJ6QUZ3QVl3QnNBR0VBZFFCa0FHVUFMUUJpQUhJQQ0KYVFCa0FHY0FaUUF1QUdvQWN3QWlBQ3dBSUFBd0FDd0FJQUJHQUdFQWJBQnpBR1VBQ2dBPQ0KOjpXQVRDSEVSOjoNCkx5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tLTHk4ZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU95Wm5DRHRsWVRzbXBUdGxaenFzSUE2SU8yVXZPcTN1T3VuaU9xd2dDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1kyeGhkV1JsWW5KcFpHZGxPaTh2SU95WHRPcTRzQ2gzYVc1a2IzY3ViM0JsYmk5cFpuSmhiV1V2YjNCbGJrVjRkR1Z5Ym1Gc0tldWx2QW92DQpMeURzb0lUcnRvQWc3SWFNNjZhc0lPeVhodXlkdENEcnA0bnJpcFFnNjdLRTdLQ0U3SjIwSU95ZWlPdUxwQzRnWm1WMFkyanJpcFFnNjZxN0lPdW5pZXljdk91dmdPdWhuQ3dnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKRHNpNXpzbnBEc2w1RHFzb3dLTHk4Z1VFOVRWQ0F2ZDJGclpTRHJwYndnNjdPMDY0SzA2Nm0wSU9xd2tPeUxuT3lla09xd2dDRHJpNlRycHF3b1kyeGhkV1JsTFdKeWFXUm5aUzVxY3lucnBid2c2NHlBN0l1Z0lPeThvT3VMcEM0S0x5OEtMeThnNjR1azY2YXM3Sm1BN0oyWUlPeXdxT3lkdERvZzZyQ1E3SXVjN0o2UTY0cVVJR05zWVhWa1pldWx2Q0Ryckx6c3A0QWc3SldLNjRxVTY0dWtLT3lla095TG5TRHNsNGJzbll3cElPS0draUR0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3VsdkNEc2xZZ2c2NmVKNnJPZ0xBb3ZMeURycVpUcnFxanJwcXdnZmpFMVRVTHJuYndnNjZHYzZyZTQ3SjI0SU95TG5DRHNucERyajVrZzdJdWM3SjZSN0p5ODY2R2NJT3lEZ2V5TA0KbkNEc3ZKenJrYXpyajRRZzY3YUE2NHUwSU95WGh1dUxwQ0FvNjVPeDY2R2RPaUJ1Y0cwZ2NuVnVJR0oxYVd4a0tTNEtMeThnNjR1azY2YXM2NHFVSU95THJPeWVwZXV3bGV1UG1TRHJnWXJxdUxEcnFiUWc3S085N0tlQTY2ZU1LTzJVak91ZnJPcTN1T3lkdU9xenZDRHNnNTNzZ3F3ZzY0K1o2cml3N1ptVUtTd2c2ckNRN0l1YzdKNlE2NHFVSU9xemhPeUdqU0RyZ3Fqc2xZUWc2NHVrN0oyTUlPcTVxT3lhc09xNHNPdWx2Q0Ryc0p2cmlwVHJpNlF1Q2dwamIyNXpkQ0JvZEhSd0lEMGdjbVZ4ZFdseVpTZ25hSFIwY0NjcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQm1jeUE5SUhKbGNYVnBjbVVvSjJaekp5azdDbU52Ym5OMElHOXpJRDBnY21WeGRXbHlaU2duYjNNbktUc0tZMjl1YzNRZ2V5QnpjR0YzYml3Z2MzQmhkMjVUZVc1aklIMGdQU0J5WlhGMWFYSmxLQ2RqYUdsc1pGOXdjbTlqWlhOekp5azdDZ3BqYjI1emRDQlFUMUpVSUQwZ01URTRPRGs3Q21OdmJuTjANCklGSlBUMVFnUFNCd1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5MaTRuS1RzZ0x5OGc3S0NBN0o2bDdJYU1JT3VqcU8yS3VDRGlnSlFnNjR1azY2YXM2ckNBSUhKbFkyOXRiV1Z1WkMxbGVHRnRjR3hsY3k1dFpPdWx2Q0Rzc0w3cmlwUWc2cml3N0tTQUNncGpiMjV6ZENCRFQxSlRYMGhGUVVSRlVsTWdQU0I3Q2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVTl5YVdkcGJpYzZJQ2NxSnl3S0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxSVpXRmtaWEp6SnpvZ0owTnZiblJsYm5RdFZIbHdaU2NzQ24wN0NtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXdvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxDQpjMjl1T3lCamFHRnljMlYwUFhWMFppMDRKeUI5TENCRFQxSlRYMGhGUVVSRlVsTXBLVHNLSUNCeVpYTXVaVzVrS0VwVFQwNHVjM1J5YVc1bmFXWjVLRzlpYWlrcE93cDlDZ292THlCamJHRjFaR1VnUTB4SjZyQ0FJT3llaU91S2xPeW5nQ0RpZ0pRZzdKZUc3Snk4NjZtMElDOTNZV3RsSU95ZGtldUx0ZXlYa0NEc2k2VHNsclFnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPeWR2ZXE0c0NEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpJQ2pyaTZUcnBxenNuWmdnWTJ4aGRXUmxRV05qYjNWdWRPeVpnQ0Rxc0puc25ZQWc3TGFjN0xLWUtTNEtMeThnN1l5TTdKMjg3SjIwSU8yQnRDRHNpSmdnN0o2STdKYTBJRE13N0xTSUlPeTZrT3lMbkM0ZzdKNnM2NkdjNnJlNDdKMjQ3WldZNjZtMA0KSUVOTVNlcXdnQ0R0akl6c25ienNuWVFnNnJDeDdJdWc3WldZNjYrQTY2R2NJT3lla091UG1TRHJzSmpzbUlIcmtKenJpNlF1Q214bGRDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUF3TENCbGJXRnBiRG9nYm5Wc2JDQjlPd3BtZFc1amRHbHZiaUJqYkdGMVpHVkJZMk52ZFc1MEtDa2dld29nSUdsbUlDaEVZWFJsTG01dmR5Z3BJQzBnWVdOamIzVnVkRU5oWTJobExtRjBJRHdnTXpBd01EQXBJSEpsZEhWeWJpQmhZMk52ZFc1MFEyRmphR1V1WlcxaGFXdzdDaUFnYkdWMElHVnRZV2xzSUQwZ2JuVnNiRHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYWlBOUlFcFRUMDR1Y0dGeWMyVW9abk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaHZjeTVvYjIxbFpHbHlLQ2tzSUNjdVkyeGhkV1JsTG1wemIyNG5LU3dnSjNWMFpqZ25LU2s3Q2lBZ0lDQmxiV0ZwYkNBOUlDaHFJQ1ltSUdvdWIyRjFkR2hCWTJOdmRXNTBJQ1ltSUdvdWIyRjFkR2hCWTJOdmRXNTBMbVZ0WVdsc1FXUmtjbVZ6Y3lrZ2ZId2cNCmJuVnNiRHNLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcm9aenF0N2pzbmJnZzdKMjA2NkNsSU95WGh1eWRqQ0RyazdFZzRvQ1VJRzUxYkd3Z0tpOGdmUW9nSUdGalkyOTFiblJEWVdOb1pTQTlJSHNnWVhRNklFUmhkR1V1Ym05M0tDa3NJR1Z0WVdsc0lIMDdDaUFnY21WMGRYSnVJR1Z0WVdsc093cDlDZ3BtZFc1amRHbHZiaUJvWVhORGJHRjFaR1VvS1NCN0NpQWdZMjl1YzNRZ1ptbHVaR1Z5SUQwZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5QS9JQ2QzYUdWeVpTY2dPaUFuZDJocFkyZ25Pd29nSUhSeWVTQjdJSEpsZEhWeWJpQnpjR0YzYmxONWJtTW9abWx1WkdWeUxDQmJKMk5zWVhWa1pTZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnYzJobGJHdzZJSFJ5ZFdVZ2ZTa3VjM1JoZEhWeklEMDlQU0F3T3lCOUlHTmhkR05vSUNoZlpTa2dleUJ5WlhSMWNtNGdabUZzYzJVN0lIMEtmUW9LYkdWMElIZGhhMmx1WnlBOUlHWmhiSE5sT3lBdkx5RHNsN0R0ZzRBZzY3Q3A3S2VBDQpJT0tBbENEcmk2VHJwcXpyaXBRZzdKYTA3TENvN1pTOElFVkJSRVJTU1U1VlUwWHJvWndnN0tTUjY3TzFJT3lnbGV1bXJPMlZtT3luZ091bmpDRHRsSVRyb1p6c2hManNpcVFnNjRLdDY3bUU2Nlc4SU95a2hPeWR1T3VMcEFwbWRXNWpkR2x2YmlCM1lXdGxRbkpwWkdkbEtDa2dld29nSUdsbUlDaDNZV3RwYm1jcElISmxkSFZ5YmpzS0lDQjNZV3RwYm1jZ1BTQjBjblZsT3dvZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V5QjNZV3RwYm1jZ1BTQm1ZV3h6WlRzZ2ZTd2dOVEF3TUNrN0NpQWdiR1YwSUhCeWIyTTdDaUFnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNLSUNBZ0lDOHZJRmRwYm1SdmQzTTZJR050Wk1LM2RtSnpJT3F5dmV5Y29DRHNsNGJzbmJRZ2JtOWtaZXVsdkNEc3A0SHNvSkVzSUhkcGJtUnZkM05JYVdSbEtFTlNSVUZVUlY5T1QxOVhTVTVFVDFjcDY2R2NJT3lLcE8yUHNDRGlnSlFLSUNBZ0lDOHZJT3l3dlNEc2w0YnJpcFFnN0lpbzdKMkFJT3k5bU95Rw0KbE95ZHRDRHJwNHpyazZUc2xyVHNwNERxczZBZzY0dWs2NmFzN0oyWUlPeWVrT3lMblNoamJHRjFaR1VwNjQrRUlPcTN1Q0Rzdlpqc2hwVHNuWVFnNjZ5ODY2Q2s2N0NiN0pXRUlPeVd0T3VXcENEc3NMM3JqNFFnN0pXSUlPdWNyT3VMcEM0S0lDQWdJQzh2SUdSbGRHRmphR1ZrNjRxVUlPeVRzT3luZ0NEc2xZcnJpcFRyaTZRb1pHVjBZV05vWldRcmQybHVaRzkzYzBocFpHVWc3S0d3N1pXcDdKMkFJT3k5bU95R2xDRHNzTDNzbmJRZzY0VzQ3TGFjNjVDb0lPS0FsQ0RzaTZUc3VLRXBMZ29nSUNBZ0x5OGdWMmx1Wkc5M2MreVhrT3lFb0NCa1pYUmhZMmhsWkNEc2w0YnNuYlRyajRRZzY3YUE2NnFvS09xd2tPeUxuT3lla0NucXNJQWc3S085N0phMDY0K0VJT3lla095TG5leWRnQ0RzZ3JUc2xZVHJncWpyaXBUcmk2UXVDaUFnSUNCd2NtOWpJRDBnYzNCaGQyNG9jSEp2WTJWemN5NWxlR1ZqVUdGMGFDd2dXM0JoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNkamJHRjFaR1V0WW5KcFpHZGxMbXB6SnlsZExDQjcNCkNpQWdJQ0FnSUdOM1pEb2dVazlQVkN3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlN3S0lDQWdJSDBwT3dvZ0lIMGdaV3h6WlNCN0NpQWdJQ0F2THlCdFlXTlBVeS9ycHF6cmlJWHNpcVE2SU9xd2tPeUxuT3lla091bHZDRHJuWVRzbXJRZ2JtOWtaU0RzaTZUdGxva2c3WXlNN0oyODY2R2NJT3luZ2V5Z2tTRHNpcVR0ajdBZ0tHeGhkVzVqYUdRZzdabVk2cks5N0plVUlGQkJWRWpxc0lBZzY3bUk3Slc5N1pXZ0lPeUltQ0Rzbm9qc2xyUWc3S0NJNjR5QTZySzk2NkdjSU95Q3JPeWFxU2tLSUNBZ0lIQnliMk1nUFNCemNHRjNiaWh3Y205alpYTnpMbVY0WldOUVlYUm9MQ0JiY0dGMGFDNXFiMmx1S0Y5ZlpHbHlibUZ0WlN3Z0oyTnNZWFZrWlMxaWNtbGtaMlV1YW5NbktWMHNJSHNLSUNBZ0lDQWdZM2RrT2lCU1QwOVVMQ0JrWlhSaFkyaGxaRG9nZEhKMVpTd2djM1JrYVc4NklDZHBaMjV2Y21VbkxBb2dJQ0FnZlNrN0NpQWdmUW9nSUhCeWIyTXVkVzV5WldZb0tUc2dMeThnDQo2ckNRN0l1YzdKNlFJT3lkdE91eXBPMkt1Q0RybzZqdGxJVHNsNURzaEp3ZzY3YUU2NmFzSUNqcXNKRHNpNXpzbnBBZzdLS0Y2Nk9NNjZXOElPdW5pZXluZ0NEc2xZcnFzb3dwQ24wS0NtTnZibk4wSUhObGNuWmxjaUE5SUdoMGRIQXVZM0psWVhSbFUyVnlkbVZ5S0NoeVpYRXNJSEpsY3lrZ1BUNGdld29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIMEtJQ0JwWmlBb2NtVnhMblZ5YkNBOVBUMGdKeTlvWldGc2RHZ25LU0I3Q2lBZ0lDQXZMeUIyT2lEcXNKRHNpNXpzbnBBZzdMMlU2NU9jSU91eWhPeWdoQ0RpZ0pRZzZyV3M2N0tFN0tDRUlPMlVoT3Vobk95RXVPeUtwT3F3Z0NEcXM0VHNobzBnNjQrTTZyT2dJT3llaU91S2xPeW5nQ0Ryc0pic2w1RHNoSndnN1ptVjdKMjQ3WldZNjRxVUlPeWFxZXVQaEFvZ0lDQWdMeThnS0hZeUlEMGc3TEM5SU95SQ0KcU9xNWdDRHNpSmpzb0pYdGpKQXNJSFl6SUQwZ0wyRmpZMjkxYm5RZzdMYVU2ckNBN1l5UUtRb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJSGRoZEdOb1pYSTZJSFJ5ZFdVc0lIWTZJRE1nZlNrN0NpQWdmUW9nSUM4dklPeWR0Q0JRUSt5WGtDRHJvWnpxdDdqc25ianJrSndnN1lHMDY2R2M2NU9jSU9xemhPeWdsU0RpZ0pRZzdaU002NStzNnJlNDdKMjRJT3l5cXlEdG1aVHJxYlRDdCsyWmlPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFRzcDRBaUlPdXp0T3lYck95anZPdUtsQ0RyamJBZzdKTzA2NHVrTGdvZ0lDOHZJT3F3a095TG5PeWVrT3F3Z0NEcmk3WHRsWmpyaXBRZzdKMjA3SnlnT2lEcmk2VHJwcXpycGJ3ZzdMeWM2Nm0wSU95YmpPdXdqZXlYaGV5Y3ZPdWhuQ0R0Z2JUcm9aenJrNXpxc0lBZzdJdWs3S0NjSU8yWXVPeTJuT3VQdkNEcXRhenJqNFVnN0lLczdKcXA2NStKN0oyMElPdUNtT3F3aE91THBDNEtJQ0F2THlEcXNKRHMNCmk1enNucERyaXBRZzdZeU03SjI4NjZlTUlPeWR2ZXljdk91dmdPdWhuQ0RzZ3F6c21xbnJuNGtnTUNEQ3R5RHJqSURxdUxBZ01DRGlnSlFnNnJLQTdZYWc2NmVNSU95VHNPdUtsQ0RzZ3F6cm5venNsNURxc293ZzY3bUU3SnFwN0oyRUlPdXN2T3Vtck95bmdDRHNsWXJyaXBUcmk2UXVDaUFnTHk4ZzdLTzg3SjJZT2lEc2w2enF1TEFnNnJPRTdLQ1Y3SjIwSU91enRPeVhyT3VQaENEc25vWHNucVhxdG96c25iUWc2NmVNNjZPTTY1Q1E3SjJFSU95SW1DRHNub2pyaTZRbzdKeWc3WnFvN0lTeDdKMkFJT3lMcE95Z25DRHRtTGpzdHB3ZzY1V002NmVNSU95VmpDRHNpSmdnN0o2STdKMk1JT0tBbENEcmk2VHJwcXdnTDJobFlXeDBhT3lkbUNCd2NtOWliR1Z0SU95d3VPcXpvQ2t1Q2lBZ2FXWWdLSEpsY1M1MWNtd2dQVDA5SUNjdllXTmpiM1Z1ZENjcElIc0tJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0JoWTJOdmRXNTBPaUJqYkdGMVpHVkJZMk52ZFc1MEtDa3NJR05zDQpZWFZrWlRvZ2FHRnpRMnhoZFdSbEtDa2dmU2s3Q2lBZ2ZRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OTNZV3RsSnlrZ2V3b2dJQ0FnYVdZZ0tDRm9ZWE5EYkdGMVpHVW9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUdaaGJITmxMQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25JSDBwT3dvZ0lDQWdkMkZyWlVKeWFXUm5aU2dwT3dvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lIZGhhMmx1WnpvZ2RISjFaU0I5S1RzS0lDQjlDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM05vZFhSa2IzZHVKeWtnZXdvZ0lDQWdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTQjlLVHNLSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwTENBeU1EQXBPd29nSUNBZw0KY21WMGRYSnVPd29nSUgwS0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdOQ3dnZXlCbGNuSnZjam9nSjA1dmRDQm1iM1Z1WkNjZ2ZTazdDbjBwT3dvS0x5OGc3SjIwNjYrNElPdVdvQ0Rzbm9qc25MenJxYlFnN0tHdzdKcXA3WjZJSU95aWhldWpqQ0FvN0o2UTY0K1pJT3lMbk95ZWtTQXJJRzV3YlNCaWRXbHNaQ0RzcEpIcnM3VWc3SXVrN1phSklPdU1nT3U1aENrS2MyVnlkbVZ5TG05dUtDZGxjbkp2Y2ljc0lDaGxLU0E5UGlCN0NpQWdhV1lnS0dVZ0ppWWdaUzVqYjJSbElEMDlQU0FuUlVGRVJGSkpUbFZUUlNjcElIQnliMk5sYzNNdVpYaHBkQ2d3S1RzS0lDQndjbTlqWlhOekxtVjRhWFFvTVNrN0NuMHBPd3B6WlhKMlpYSXViR2x6ZEdWdUtGQlBVbFFzSUNjeE1qY3VNQzR3TGpFbkxDQW9LU0E5UGlCN0NpQWdZMjl1YzI5c1pTNXNiMmNvSjF0M1lYUmphR1Z5WFNEdGdiVHJvWnpyazV3ZzY0dWs2NmFzSU9xd2tPeUxuT3lla0NEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXINCklGQlBVbFFwT3dwOUtUc0sNCjo6V1NJTEVOVDo6DQpKeUJEYkdGMVpHVWdRbkpwWkdkbElIZGhkR05vWlhJZ2MybHNaVzUwSUd4aGRXNWphR1Z5SUNodWJ5QjNhVzVrYjNjcElDMGdjbVZuYVhOMFpYSmxaQ0IwYnlCeWRXNGdZWFFnYkc5bmFXNEtVMlYwSUdaemJ5QTlJRU55WldGMFpVOWlhbVZqZENnaVUyTnlhWEIwYVc1bkxrWnBiR1ZUZVhOMFpXMVBZbXBsWTNRaUtRcFRaWFFnYzJnZ1BTQkRjbVZoZEdWUFltcGxZM1FvSWxkVFkzSnBjSFF1VTJobGJHd2lLUXBrYVhJZ1BTQm1jMjh1UjJWMFVHRnlaVzUwUm05c1pHVnlUbUZ0WlNoWFUyTnlhWEIwTGxOamNtbHdkRVoxYkd4T1lXMWxLUXB6YUM1RGRYSnlaVzUwUkdseVpXTjBiM0o1SUQwZ1pHbHlDbk5vTGxKMWJpQWlZMjFrSUM5aklHNXZaR1VnYzJOeWFYQjBjMXhpY21sa1oyVXRkMkYwWTJobGNpNXFjeUlzSURBc0lFWmhiSE5sQ2c9PQ0KOjpFTkQ6Og0K";
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
