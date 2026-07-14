/// <reference types="@figma/plugin-typings" />

// 메시지 타입 정의
interface PreviewItem {
  nodeId: string;
  nodeName: string;
  before: string;
  after: string;
  x: number;
  y: number;
}

interface PluginMessage {
  type: 'PREVIEW' | 'APPLY' | 'CANCEL' | 'TOGGLE_ANNOTATIONS' | 'CLEAR_ANNOTATIONS' | 'RESIZE_UI' | 'FOCUS_NODE' | 'SELECT_NODES' | 'SHOW_LOADING' | 'UPDATE_PROGRESS' | 'HIDE_LOADING' | 'RECOMMEND' | 'TRANSLATE' | 'REPORT' | 'CHECK_BRIDGE' | 'STOP_BRIDGE' | 'GET_INSTALLER' | 'LIKE_SUGGESTION';
  text?: string;
  forceAi?: boolean; // RECOMMEND: 사전 매칭을 건너뛰고 AI로 새 제안 받기 ([AI 추천 더 받기])
  model?: string;    // RECOMMEND: 클로드 다리에 쓸 모델 (haiku|sonnet|opus)
  data?: PreviewItem[];
  nodeId?: string;
  changedNodeIds?: string[];
  nodeIds?: string[];
  progress?: number;
  status?: string;
  width?: number;
  height?: number;
  anchorRight?: boolean;
  anchorBottom?: boolean;
}

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
(figma as any).on('selectionchange', () => {
  const selection = figma.currentPage.selection;

  // 우리가 말풍선 클릭 직후 비운 선택의 메아리 → 흐려짐/포커스 상태를 그대로 두고 종료
  if (suppressSelectionReset) {
    suppressSelectionReset = false;
    return;
  }

  // 캔버스에서 코멘트(어노테이션)를 직접 클릭한 경우 → 그것만 선명, 나머지는 흐리게 + 맨 앞으로
  try {
    const annNodeIds: string[] = [];
    const annSegIds: string[] = [];
    const regularNodes: any[] = [];
    for (const n of selection || []) {
      const p = parseAnnNode(n);
      if (p) {
        annNodeIds.push(p.nodeId);
        annSegIds.push(annSegId(p.key));
      } else {
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
    } else {
      // 일반 노드 선택 시: 관련 코멘트 투명도 갱신 + 앞으로
      updateAnnotationOpacityFromCanvas(selection || []);
    }

    // 캔버스 선택 → 검토 목록에서도 같은 항목을 선택 표시하도록 nodeId 목록 전송
    const targetIds = new Set<string>();
    for (const id of annNodeIds) targetIds.add(id); // 코멘트를 직접 클릭한 경우 그 대상 노드
    if (regularNodes.length > 0) {
      const selIds = new Set<string>();
      for (const n of regularNodes) if (n && n.id) selIds.add(n.id);
      // 선택한 노드(또는 그 프레임) 안에 있는 검토 대상 노드들을 찾는다
      for (const [nodeId, ancestors] of annotationAncestorIds) {
        for (const id of selIds) {
          if (ancestors.has(id)) { targetIds.add(nodeId); break; }
        }
      }
    }
    figma.ui.postMessage({ type: 'canvas-selection', nodeIds: Array.from(targetIds) });

    // 추천/번역 화면 자동 입력용: 선택 영역(프레임/텍스트) 안의 문구를 UI로 전달.
    // 선택 해제(빈 선택) 시엔 빈 문자열을 보내 입력창도 비울 수 있게 한다.
    if (regularNodes.length > 0) {
      collectSelectedText().then((t) => {
        figma.ui.postMessage({ type: 'selection-text', text: (t && t.trim()) ? t : '' });
      }).catch(() => {});
    } else if (!selection || selection.length === 0) {
      figma.ui.postMessage({ type: 'selection-text', text: '' });
    }
  } catch (_e) {}
});

// 초기 선택 상태 전송
const initialSelection = figma.currentPage.selection;
figma.ui.postMessage({
  type: 'selection-changed',
  hasSelection: initialSelection && initialSelection.length > 0
});

// ===============================
// UX Writing 엔진 타입 정의
// ===============================
type SuggestionTag =
  | "tone"
  | "button"
  | "shorten"
  | "typo"
  | "spacing"
  | "term";

interface Suggestion {
  before: string;
  after: string;
  reason: string;
  tags: SuggestionTag[];
}

// UX Writing 패턴 정의
interface UXPattern {
  pattern: string;
  replacement: string;
  description: string;
  tag?: SuggestionTag;
}

const UX_PATTERNS: UXPattern[] = [
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
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 한글 글자의 받침 유무 확인 함수
function hasJongseong(char: string): boolean {
  const code = char.charCodeAt(0);
  // 한글 유니코드 범위: 가(0xAC00) ~ 힣(0xD7A3)
  if (code >= 0xAC00 && code <= 0xD7A3) {
    // 받침이 있으면: (charCode - 0xAC00) % 28 > 0
    return (code - 0xAC00) % 28 > 0;
  }
  return false;
}

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ===============================
// 오타/띄어쓰기 규칙
// ===============================
type FixRule = {
  pattern: RegExp;
  replacement: string | ((match: string, ...args: any[]) => string);
  reason: string;
  tags: SuggestionTag[];
};

const TYPO_RULES: FixRule[] = [
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
const ADVERB_SPACING_RULES: FixRule[] = [
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
const GLOSSARY_TERMS: Array<{ from: string; to: string }> = [
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
const GLOSSARY_COMPOUNDS: string[] = [
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
const GLOSSARY_ACTION_NOUNS: string[] = [
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
const GLOSSARY_KEEP_SPELLINGS: Array<{ keep: string; naver: string }> = [
  { keep: "렌탈", naver: "렌털" },
];
const GLOSSARY_PHRASES: Array<{ from: string; to: string }> = [
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
const RECOMMEND_EXAMPLES: Array<{ input: string; suggestions: string[] }> = [
  { input: "진행하던 작업이 있습니다. 계속하시겠습니까?", suggestions: ["진행 중인 내역이 있어요.\n이어서 진행할까요?"] },
  { input: "공유 요청을 취소하면 요청 내역이 삭제됩니다. 취소하시겠습니까?", suggestions: ["취소할 경우 요청 내역도 삭제돼요.\n공유 요청을 취소할까요?"] },
  { input: "기기를 찾지 못했습니다. QR코드를 다시 스캔하세요.", suggestions: ["기기를 찾을 수 없어요.\nQR코드를 다시 스캔해 주세요."] },
  { input: "보호자가 허락하기 전에는 가입할 수 없어요", suggestions: ["보호자가 허락해야 가입할 수 있어요."] },
  { input: "지금 버전에서는 쓸 수 없어요. 생체 인증을 쓰려면 앱을 최신 버전으로 업데이트 해주세요.", suggestions: ["앱을 업데이트해 주세요.\n생체 인증을 쓰려면 최신 버전이 필요해요."] },
  { input: "어떤 목적으로 대출받으시나요?", suggestions: ["대출 목적이 무엇인가요?"] },
  { input: "어떤 이유로 신고하시나요?", suggestions: ["신고 이유를 선택해 주세요."] },
  { input: "잔액 부족으로 구매하지 못했어요", suggestions: ["잔액이 부족해서 구매하지 못했어요."] },
  { input: "홍*동(010-1234-5678) 외 2명에게 권한 삭제 알림톡을 전송할까요?", suggestions: ["권한 삭제 알림톡을 보내려고 해요.\n홍*동(010-1234-5678) 님 외 2명에게 보낼까요?","홍*동(010-1234-5678) 님 외 2명에게 권한 삭제 알림톡을 보낼까요?","권한 삭제 알림톡을 홍*동(010-1234-5678) 님 외 2명에게 보낼까요?"] },
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
  { input: "권한 신청을 취소하시겠습니까? 취소하실 경우 신청하신 내용은 저장되지 않습니다.", suggestions: ["취소하면 신청한 내용이 저장되지 않아요.\n권한 신청을 취소할까요?","권한 신청을 취소할까요?\n취소하면 입력한 내용이 사라져요."] },
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
  { input: "본 계약의 유일한 마스터 관리자로 일반관리자로 권한변경을 하실 수 없어요. 일반 관리자로 권한 변경을 원하실 경우 다른 사람에게 마스터 관리자 권한을 지정해 주신 후 다시 시도해 주세요.", suggestions: ["다른 사람을 마스터 관리자로 지정한 뒤 일반 관리자로 변경할 수 있어요.","다른 사람을 마스터 관리자로 지정하면 변경할 수 있어요."] },
];
// ===== RECOMMEND:END =====

// 문구 추천 — 예시 사전 기반 (서버 없이 로컬에서 동작).
// 입력을 정규화한 뒤 recommend-examples.md의 원본과
// ① 완전히 같거나 ② 서로 포함하면 그 예시의 추천안을 돌려준다. 없으면 빈 배열.
// 정규화 시 마스킹된 이름(홍*동)·"이름(번호)" 묶음(홍길동(010-… / ***) 포함)·숫자·공백·문장부호를
// 무시하므로 이름/수량/번호만 다른 가변 문구도 같은 예시로 매칭된다.
function normalizeForMatch(s: string): string {
  return s
    .replace(/[가-힣][가-힣*]{1,3}\s*\([*0-9\-\s]*\)/g, '') // 이름(전화번호/마스킹) 묶음 — 실명도 커버
    .replace(/[가-힣]\*[가-힣]+/g, '') // 마스킹된 이름 (홍*동) — 문장부호 제거 전에 먼저
    .replace(/[0-9]+/g, '')            // 숫자 (전화번호·수량·버전 등)
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase();
}
function localRecommend(text: string): string[] {
  const q = normalizeForMatch(text);
  if (!q) return [];
  // 1) 완전 일치 우선
  for (const ex of RECOMMEND_EXAMPLES) {
    if (normalizeForMatch(ex.input) === q) return ex.suggestions;
  }
  // 2) 부분 포함 (입력이 예시를 포함하거나, 예시가 입력을 포함) — 가장 긴 예시 우선.
  //    숫자 제거로 짧아진 입력("2명" 등)이 아무 예시에나 걸리지 않도록 최소 길이 가드.
  if (q.length < 5) return [];
  const contains = RECOMMEND_EXAMPLES
    .filter((ex) => { const n = normalizeForMatch(ex.input); return n.length >= 5 && (q.includes(n) || n.includes(q)); })
    .sort((a, b) => normalizeForMatch(b.input).length - normalizeForMatch(a.input).length);
  return contains.length ? contains[0].suggestions : [];
}

// ── 키 없이 동작하는 로컬 추천 폴백 ──────────────────────────
// 개인 Gemini 키가 없거나 AI 호출이 실패해도(프록시 차단 등) 추천이 비지 않게 한다.
// ① 유사 예시: 예시 사전과 완전 일치는 아니어도 충분히 비슷하면 그 예시의 추천안을 제시
// ② 규칙 기반: 검토 규칙(해요체·용어 통일 등)으로 다듬은 문장을 추천으로 제시
function bigramSet(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
// 두 문자열의 바이그램(연속 2글자 조각) Dice 유사도: 0(다름)~1(같음)
function diceSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigramSet(a);
  const B = bigramSet(b);
  let inter = 0;
  A.forEach((g) => { if (B.has(g)) inter++; });
  return (2 * inter) / (A.size + B.size);
}
// 문장 끝 어미(습니다/할까요/해주세요 등) — 유사도 비교 전에 잘라내는 보조 정규화용.
// 어미 차이("~하시겠습니까?" vs "~할까요?")는 추천 관점에선 같은 문장인데 바이그램 점수를
// 크게 깎아서, 어미를 뗀 몸통끼리도 한 번 더 비교한다. 긴 어미가 먼저 매칭되도록 순서 유지.
const SENTENCE_ENDING_RE = /(해 주시기 바랍니다|주시기 바랍니다|하시겠습니까|하시겠어요|시겠습니까|시겠어요|되었습니다|하였습니다|였습니다|았습니다|었습니다|했습니다|됐습니다|바랍니다|해주십시오|하십시오|해주세요|해 주세요|입니다|합니다|됩니다|습니다|습니까|합니까|할까요|될까요|주세요|십시오|하세요|이에요|예요|세요|어요|아요|해요|돼요|네요|죠)\s*$/;
function normalizeForSimilarity(s: string): string {
  return s
    // 같은 뜻의 다른 표현을 한 형태로 통일 — "이용이 불가합니다" ↔ "이용할 수 없습니다"가
    // 같은 문장으로 비교되게 한다 (유사도 비교 전용 — 완전 일치 매칭에는 영향 없음)
    .replace(/불가능합니다|불가능해요|불가합니다|불가해요/g, '할 수 없습니다')
    .replace(/가능합니다|가능해요/g, '할 수 있습니다')
    .replace(/하시/g, '하') // 경어 '시' 무시 (하시면→하면)
    .replace(/([가-힣])\s+시\s+/g, '$1하면 ') // "탈퇴 시" ↔ "탈퇴하면" (숫자+시(時)는 공백 조건 때문에 안 걸림)
    .split(/[.!?…\n\u2028\u2029]+/)                            // 문장 단위로 쪼개서
    .map((seg) => seg.trim().replace(SENTENCE_ENDING_RE, ''))  // 각 문장의 끝 어미 제거
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
function fuzzyRecommend(text: string): string[] {
  const q = normalizeForMatch(text);
  if (q.length < 8) return []; // 짧은 문장은 우연히 비슷해질 확률이 높아 제외
  const qs = normalizeForSimilarity(text);
  const hits: Array<{ score: number; suggestions: string[] }> = [];
  for (const ex of RECOMMEND_EXAMPLES) {
    const n = normalizeForMatch(ex.input);
    if (n.length < 8) continue;
    const full = diceSimilarity(q, n);
    let stripped = 0;
    if (qs.length >= 5) {
      const ns = normalizeForSimilarity(ex.input);
      if (ns.length >= 5) stripped = diceSimilarity(qs, ns);
    }
    if (full >= FUZZY_RECOMMEND_THRESHOLD || stripped >= FUZZY_STRIPPED_THRESHOLD) {
      hits.push({ score: Math.max(full, stripped), suggestions: ex.suggestions });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const out: string[] = [];
  for (const h of hits.slice(0, FUZZY_MAX_EXAMPLES)) {
    for (const s of h.suggestions) {
      if (out.indexOf(s) === -1) out.push(s);
    }
  }
  return out;
}
// 예시 추천안을 입력 문구의 실제 값으로 각색한다.
// 예시 사전의 더미 값("홍*동(…)", "외 2명")이 그대로 노출되지 않도록,
// 입력에서 같은 유형의 토큰을 찾아 순서대로 끼워 넣는다 (입력에 없으면 예시 값 유지).
const NAME_PHONE_RE = /[가-힣][가-힣*]{1,3}\s*\(\s*[*0-9\-\s]+\s*\)/g; // 이름(전화번호/마스킹)
const PERSON_COUNT_RE = /외\s*[0-9]+\s*명/g;                            // 외 N명
function adaptSuggestionToInput(suggestion: string, input: string): string {
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
function ruleBasedRecommend(text: string): Array<{ text: string; reason: string }> {
  try {
    const s = suggestFriendlyKorean(text, false);
    if (s.length && s[0].after && s[0].after !== text) {
      return [{ text: s[0].after, reason: '규칙 기반 다듬기 — ' + s[0].reason }];
    }
  } catch (e) {
    console.log('[RECOMMEND] 규칙 기반 추천 실패', e);
  }
  return [];
}
// 유사 예시 + 규칙 기반을 합친 로컬 폴백 (같은 문장 중복 제거)
function localFallbackRecommend(text: string): Array<{ text: string; reason: string }> {
  const out: Array<{ text: string; reason: string }> = [];
  for (const s of fuzzyRecommend(text)) out.push({ text: adaptSuggestionToInput(s, text), reason: '비슷한 예시 기반' });
  for (const r of ruleBasedRecommend(text)) {
    if (!out.some((o) => o.text === r.text)) out.push(r);
  }
  return out;
}
// AI 제안 가져오기 — 클로드 다리 전용 (Gemini/API 키 경로 제거됨).
// 성공하면 {text, reason} 배열, 실패하면 사유 메시지를 담은 Error를 던진다.
async function fetchAiSuggestions(text: string, model?: string): Promise<Array<{ text: string; reason: string }>> {
  try {
    const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/recommend', { text, model }, 130000);
    const data = await res.json();
    if (res.ok && data && data.suggestions && data.suggestions.length) return data.suggestions;
    throw new Error('클로드 추천 실패: ' + (data && data.error ? data.error : ('HTTP ' + res.status)));
  } catch (e) {
    if (e instanceof Error && e.message.indexOf('클로드 추천 실패') >= 0) throw e;
    throw new Error('클로드 추천 실패: ' + errStr(e));
  }
}

// 폴백 결과를 UI로 전송. failNote가 있으면(AI 실패) 토스트로 함께 알린다.
// emptyNote: 폴백 결과도 없을 때 보여줄 안내 (기본은 키 등록 안내)
// canAskAi: true면 카드 밑에 [AI 추천 더 받기] 버튼 노출 (AI 실패 후 재시도용)
function postRecommendFallback(text: string, failNote: string, emptyNote?: string, canAskAi?: boolean): void {
  const fallback = localFallbackRecommend(text);
  if (fallback.length) {
    figma.ui.postMessage({ type: 'recommend-result', original: text, suggestions: fallback, canAskAi: !!canAskAi });
    if (failNote) figma.ui.postMessage({ type: 'show-toast', message: failNote + ' — 예시·규칙 기반 추천으로 대신했어요.' });
  } else if (failNote) {
    figma.ui.postMessage({ type: 'show-toast', message: failNote });
  } else {
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
const TERM_RULES: FixRule[] = [
  // --- 용어 통일 (glossary.md "용어 통일" 표에서 자동 생성) ---
  ...GLOSSARY_TERMS.map((t): FixRule => ({
    pattern: new RegExp(escapeRegex(t.from), 'g'),
    replacement: t.to,
    reason: "용어 통일",
    tags: ["term"],
  })),

  // --- 권장 문구 (glossary.md "권장 문구" 표에서 자동 생성 — 말투·어미 규칙) ---
  ...GLOSSARY_PHRASES.map((t): FixRule => ({
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
const COMPOUND_PROTECT_RULES: FixRule[] = GLOSSARY_COMPOUNDS.map((w): FixRule => ({
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
function protectCompounds(s: string): string {
  let t = s;
  for (const r of COMPOUND_PROTECT_RULES) {
    r.pattern.lastIndex = 0;
    t = t.replace(r.pattern, r.replacement as string);
  }
  return t;
}

// 예외 표기 보호 (glossary.md "예외 표기"): 네이버가 표준 표기로 바꾼 단어를 우리 표기로 되돌린다.
// 예: 렌탈 → (네이버) 렌털 → 렌탈 복원. 원문에 우리 표기가 쓰였을 때만 되돌리므로
// 원문이 처음부터 표준 표기(렌털)면 그대로 둔다 — 양쪽 표기 모두 허용.
function revertKeptSpellings(original: string, corrected: string): string {
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
function splitLinesKeepSeps(s: string): { lines: string[]; seps: string[] } {
  const lines: string[] = [];
  const seps: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\r') {
      lines.push(cur); cur = '';
      if (s[i + 1] === '\n') { seps.push('\r\n'); i++; } else { seps.push('\r'); }
    } else if (ch === '\n' || ch === '\u2028' || ch === '\u2029') {
      lines.push(cur); cur = '';
      seps.push(ch);
    } else {
      cur += ch;
    }
  }
  lines.push(cur);
  return { lines, seps };
}

// 네이버는 교정문에서 앞뒤 공백/줄바꿈을 잘라서 돌려준다.
// 그대로 두면 "출입정보 " → "출입정보"처럼 눈에 안 보이는(똑같아 보이는) 제안이 생기므로
// 원문의 앞뒤 공백을 교정문에 그대로 복원한다.
function restoreEdgeWhitespace(original: string, corrected: string): string {
  const lead = (original.match(EDGE_WS_LEAD) || [''])[0];
  const trail = (original.match(EDGE_WS_TRAIL) || [''])[0];
  return lead + corrected.replace(EDGE_WS_LEAD, '').replace(EDGE_WS_TRAIL, '') + trail;
}

// 네이버 교정문의 공백 구조를 원문에 맞춘다 (여러 줄 텍스트 대응):
// - 줄 수가 달라졌으면(줄바꿈 손실/병합) 네이버 교정을 통째로 버리고 원문 유지
//   → "조회⏎ → 조회" 같은 줄바꿈 제거 제안이 생기지 않는다
// - 줄 수가 같으면 원문의 줄바꿈 문자(\n, U+2028 등)를 그대로 쓰고
//   각 줄의 앞뒤 공백도 원문대로 복원
function alignWhitespace(original: string, corrected: string): string {
  const o = splitLinesKeepSeps(original);
  const cLines = corrected.split('\n'); // 네이버 응답은 \n으로 통일돼 돌아온다
  if (o.lines.length !== cLines.length) return original;
  let out = '';
  for (let i = 0; i < o.lines.length; i++) {
    out += restoreEdgeWhitespace(o.lines[i], cLines[i]);
    if (i < o.seps.length) out += o.seps[i];
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

const HAEJUSEYO_RULES: FixRule[] = [
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
const REWRITE_RULES: FixRule[] = [
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
    replacement: (m: string, p1: string) => (jongseongCode(p1) === 20 ? p1 + "어요" : m),
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

function replaceImnidaWithYeyo(text: string): string {
  if (!text.includes("입니다")) return text;

  let t = text;
  const regex = /\s*입니다/g;
  const matches: Array<{ index: number; length: number }> = [];
  let m: RegExpExecArray | null;

  while ((m = regex.exec(t)) !== null) {
    matches.push({ index: m.index, length: m[0].length });
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    const { index, length } = matches[i];
    let replacement = "이에요";
    if (index > 0) {
      // "방법 입니다"처럼 공백이 있으면 앞 단어의 마지막 글자 확인 (받침 있으면 이에요, 없으면 예요)
      let j = index - 1;
      while (j >= 0 && /\s/.test(t[j])) j--;
      const prev = j >= 0 ? t[j] : "";
      replacement = /[가-힣]/.test(prev) && hasJongseong(prev) ? "이에요" : "예요";
    }
    t = t.slice(0, index) + replacement + t.slice(index + length);
  }
  return t;
}

function applyPatternDB(text: string): { text: string; tags: SuggestionTag[]; reasons: string[] } {
  let t = text;
  const tags = new Set<SuggestionTag>();
  const reasons: string[] = [];

  // "입니다"는 별도 처리
  const beforeImnida = t;
  t = replaceImnidaWithYeyo(t);
  if (t !== beforeImnida) {
    tags.add("tone");
    reasons.push("해요체");
  }

  for (const p of UX_PATTERNS) {
    if (!t.includes(p.pattern)) continue;
    const next = t.replace(new RegExp(escapeRegex(p.pattern), "g"), p.replacement);
    if (next !== t) {
      t = next;
      if (p.tag) tags.add(p.tag);
      reasons.push(p.description);
    }
  }

  // "가능 해요" 등 UX_PATTERNS "합니다"→"해요" 적용 시 생긴 띄어쓰기 보정 (가능해요, 불가능해요 등)
  const spacingFix = /(불가능|가능|필요|불필요) (해요)/g;
  if (spacingFix.test(t)) {
    spacingFix.lastIndex = 0;
    t = t.replace(spacingFix, "$1$2");
    tags.add("spacing");
    if (!reasons.includes("띄어쓰기")) reasons.push("띄어쓰기");
  }

  return { text: t, tags: Array.from(tags), reasons };
}

function applyRules(text: string, rules: FixRule[]): { text: string; tags: SuggestionTag[]; reasons: string[] } {
  let t = text;
  const tags = new Set<SuggestionTag>();
  const reasons: string[] = [];

  for (const r of rules) {
    if (!r.pattern.test(t)) {
      // RegExp가 global이면 test 이후 lastIndex가 변할 수 있어 reset
      r.pattern.lastIndex = 0;
      continue;
    }
    r.pattern.lastIndex = 0;
    const next = typeof r.replacement === 'function' 
      ? t.replace(r.pattern, r.replacement as (substring: string, ...args: any[]) => string)
      : t.replace(r.pattern, r.replacement as string);
    if (next !== t) {
      t = next;
      r.tags.forEach((tg) => tags.add(tg));
      reasons.push(r.reason);
    }
  }

  return { text: t, tags: Array.from(tags), reasons };
}

function buildSuggestion(before: string, after: string, reasonParts: string[], tags: SuggestionTag[]): Suggestion | null {
  if (before === after) return null;

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

function applyPeriodRule(text: string, originalText?: string): { text: string; reasons: string[] } {
  let t = text;
  const reasons: string[] = [];
  
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
const PARTICLE_FALSE_POSITIVES = new Set<string>(['마을', '가을', '노을']);

// 받침 종성 코드 (0 = 받침 없음). -1 = 한글 음절 아님
function jongseongCode(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) return (code - 0xAC00) % 28;
  return -1;
}

// 단어 경계(공백/문장부호/끝) 앞의 을/를을, 앞 글자 받침에 맞게 교정
function fixParticles(text: string): { text: string; reasons: string[] } {
  let changed = false;
  const BOUNDARY = `(?=[\\s.,!?)\\]"'»」』]|$)`;
  const re = new RegExp(`([가-힣])(을|를)${BOUNDARY}`, 'g');
  const t = text.replace(re, (m, prev: string, particle: string) => {
    const jong = jongseongCode(prev);
    if (jong < 0) return m;
    if (PARTICLE_FALSE_POSITIVES.has(prev + particle)) return m; // 흔한 단어는 건너뜀
    const correct = jong > 0 ? '을' : '를';
    if (particle !== correct) { changed = true; return prev + correct; }
    return m;
  });
  return { text: t, reasons: changed ? ['맞춤법'] : [] };
}

// ===============================
// 네이버 맞춤법 검사 (비공식 — py-hanspell 방식: 검색페이지에서 passportKey 추출 후 SpellerProxy 호출)
// 공식 API 아님 → 네이버가 바꾸면 깨질 수 있음. 실패 시 조용히 건너뜀(로컬 규칙은 그대로 동작).
// ===============================
let naverPassportKey: string | null = null;
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
async function bridgeHealth(): Promise<{ alive: boolean; ready: boolean; model?: string; problem?: string }> {
  try {
    // 피그마의 네트워크 중계가 첫 요청에 느릴 수 있어 여유 있게 (다리 없으면 연결 거부라 즉시 실패함)
    const res = await fetchWithTimeout(CLAUDE_BRIDGE_URL + '/health', 3000);
    if (!res.ok) return { alive: false, ready: false };
    const d = await res.json().catch(() => ({} as any));
    return { alive: true, ready: !!(d && d.ready), model: d && d.model, problem: d && d.problem };
  } catch (e) {
    console.log('[BRIDGE] 다리 확인 실패 (꺼져 있거나 접근 불가):', errStr(e));
    return { alive: false, ready: false };
  }
}
async function isBridgeAlive(): Promise<boolean> {
  return (await bridgeHealth()).alive;
}

// 클로드다리 설치 파일 — 다리+예시+런처를 내장한 자기완결 bat. UI의 [🔧 설치 파일 받기]가 다운로드로 내려준다.
// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드다리-설치.bat을 base64로 주입) =====
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZE1RVlZPUTBoRlVpY3BLUW9rYkdGMWJtTm9aWElnUFNCS2IybHVMVkJoZEdnZ0pHUnBjaUFuWTJ4aGRXUmxMV0p5YVdSblpTMXphV3hsYm5RdWRtSnpKd3BiU1U4dVJtbHNaVjA2T2xkeWFYUmxRV3hzUW5sMFpYTW9KR3hoZFc1amFHVnlMQ0FvVUdGeWRDQW5URUZWVGtOSVJWSW5JQ2RGVGtRbktTa0tUbVYzTFVsMFpXMGdMVkJoZEdnZ0owaExRMVU2WEZOdlpuUjNZWEpsWEVOc1lYTnpaWE5jWTJ4aGRXUmxZbkpwWkdkbA0KWEhOb1pXeHNYRzl3Wlc1Y1kyOXRiV0Z1WkNjZ0xVWnZjbU5sSUh3Z1QzVjBMVTUxYkd3S1UyVjBMVWwwWlcxUWNtOXdaWEowZVNBdFVHRjBhQ0FuU0V0RFZUcGNVMjltZEhkaGNtVmNRMnhoYzNObGMxeGpiR0YxWkdWaWNtbGtaMlVuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FuVlZKTU9rTnNZWFZrWlNCQ2NtbGtaMlVuQ2xObGRDMUpkR1Z0VUhKdmNHVnlkSGtnTFZCaGRHZ2dKMGhMUTFVNlhGTnZablIzWVhKbFhFTnNZWE56WlhOY1kyeGhkV1JsWW5KcFpHZGxKeUF0VG1GdFpTQW5WVkpNSUZCeWIzUnZZMjlzSnlBdFZtRnNkV1VnSnljS1UyVjBMVWwwWlcxUWNtOXdaWEowZVNBdFVHRjBhQ0FuU0V0RFZUcGNVMjltZEhkaGNtVmNRMnhoYzNObGMxeGpiR0YxWkdWaWNtbGtaMlZjYzJobGJHeGNiM0JsYmx4amIyMXRZVzVrSnlBdFRtRnRaU0FuS0dSbFptRjFiSFFwSnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSc1lYVnVZMmhsY2lBcklDY2lKeWtLYVdZZ0tDMXUNCmIzUWdLRWRsZEMxRGIyMXRZVzVrSUc1dlpHVWdMVVZ5Y205eVFXTjBhVzl1SUZOcGJHVnVkR3g1UTI5dWRHbHVkV1VwS1NCN0NpQWdhV1lnS0MxdWIzUWdKSE5wYkdWdWRDa2dld29nSUNBZ0pISWdQU0JiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0l1eUVwT3k1bU91S2xDRHJnWjNyZ3F6c2xyVHNtcFF1SU9xM3VPdWZzT3VOc0NCT2IyUmxMbXB6NnJDQUlPeVhodXlXdE95YWxDNWdibUJ1VysyWmxleWR1RjNzbllRZzY0aUU2NlcwNjZtMElPdUxwT3lhdE91aG5PdVRuQ0R0anBqc25iVHNwNERxc0lBZzdKZTA2NmE5NjR1STY0dWtMbUJ1VG05a1pTNXFjeURzaEtUc3VaanJwYndnNjZlSTdMbWNJT3VTcENEc25iUWc3WXlNN0oyODdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxiUWc3S084N0lTNDdKcVVMaUlzSUNmdGdiVHJvWnpyazV3ZzY0dWs2NmFzSU95RXBPeTVtQ0FvTVM4eUtTRGlnSlFnVG05a1pTNXFjeWNzSUNkUFMwTmhibU5sYkNjc0lDZFhZWEp1DQphVzVuSnlrS0lDQWdJR2xtSUNna2NpQXRaWEVnSjA5TEp5a2dleUJUZEdGeWRDMVFjbTlqWlhOeklDZG9kSFJ3Y3pvdkwyNXZaR1ZxY3k1dmNtY3ZhMjh2Wkc5M2JteHZZV1FuSUgwS0lDQjlDaUFnWlhocGRBcDlDbWxtSUNndGJtOTBJQ2hIWlhRdFEyOXRiV0Z1WkNCamJHRjFaR1VnTFVWeWNtOXlRV04wYVc5dUlGTnBiR1Z1ZEd4NVEyOXVkR2x1ZFdVcEtTQjdDaUFnUW05NElDTHNoS1RzdVpqcmlwUWc2NEdkNjRLczdKYTA3SnFVTGlEcXQ3anJuN0RyamJBZ1EyeGhkV1JsSUVOdlpHWHFzSUFnN0plRzdKYTA3SnFVSUNqcm1KRHJpcFFnVUVGVVNPeVhrQ0RzbDRic2xyVHNtcFFwTG1CdVlHN3RoTERycjdqcmhKRHNsNURzaEp3ZzdKV0U2NTZZNjZXOElPeUVwT3k1bU1LMzY2R2M2cmU0N0oyNDdaV2NJT3VTcENEc25iUWc3WXlNN0oyODdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxiUWc3S084N0lTNDdKcVVPbUJ1WUc0Z0lHNXdiU0JwYm5OMFlXeHNJQzFuSUVCaGJuUm9jbTl3YVdNdFlXa3ZZMnhoZFdSbA0KTFdOdlpHVmdiaUFnWTJ4aGRXUmxJR3h2WjJsdVlHNWdidTJabGV5ZHVEb2c3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKMjBJT3V5aE95Z2hPeWRoQ0RzdHB6cm9LWHRsWmpycWJRZzdLU0E2N21FSU95WmhPdWpqQzVnYmlqc2dxenNtcW5ybjRuc25ZQWc3SjIwSUZCRDdKZVFJT3Vobk9xM3VPeWR1T3VRbkNEdGdiVHJvWnpyazV3ZzZyV3M2NCtGSU8yVm5PdVBoT3lYa095RW5DRHNzS2pxc0pEcmtLbnJpNGpyaTZRdUtTSWdKKzJCdE91aG5PdVRuQ0RyaTZUcnBxd2c3SVNrN0xtWUlDZ3lMeklwSU9LQWxDQkRiR0YxWkdVZ1EyOWtaU2NnSjFkaGNtNXBibWNuQ2lBZ1pYaHBkQXA5Q2xOMFlYSjBMVkJ5YjJObGMzTWdMVVpwYkdWUVlYUm9JQ2RqYldRdVpYaGxKeUF0UVhKbmRXMWxiblJNYVhOMElDY3ZZeUJ1YjJSbElITmpjbWx3ZEhOY1kyeGhkV1JsTFdKeWFXUm5aUzVxY3ljZ0xWZHZjbXRwYm1kRWFYSmxZM1J2Y25rZ0pHUnBjaUF0VjJsdVpHOTNVM1I1YkdVZ1NHbGsNClpHVnVDa0p2ZUNBaTdJU2s3TG1ZSU95WmhPdWpqQ0VnN1lHMDY2R2M2NU9jSU91THBPdW1yT3VsdkNEc3ZMRHNsclRzbXBRdVlHNWdidXlkdE95Z25DRHRsTHpxdDdqcnA0Z2c3WlNNNjUrczZyZTQ3SjI0N0p5ODY2R2NJT3VQak95VmhPcXdnQ0JiN0xhVTdMS2M2N0NiNnJpd1hldWx2Q0RyaUlUcnBiVHJxYlFnN1lHMDY2R2M2NU9jNnJDQUlPdUx0ZTJWdE95YWxDNWdidXVMcE95ZGpPdTJnTzJFc091S2xDRHRsSXpybjZ6cXQ3anNuYmpzbDVEc2hKd2c3TGFVN0xLY3dyZnJzb2pzbDYwZzdabVU2Nm0wN0plUUlPdVRwT3lXdE9xd2dPdXB0Q0RzbnBEcmo1bnNuTHpyb1p3ZzdMeWM3S2VSNjR1STY0dWtMaUlnSisyQnRPdWhuT3VUbkNEcmk2VHJwcXdnNG9DVUlPeWtnT3U1aENEc21ZVHJvNHduSUNkSmJtWnZjbTFoZEdsdmJpYz0NCjo6QlJJREdFOjoNCkx5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDaERiR0YxWkdVZ1FuSnBaR2RsS1NEaWdKUWc3WlM4NnJlNDY2ZUlJTzJVak91ZnJPcTN1T3lkdU9xenZDQkRiR0YxWkdVZ1EyOWtaZXVsdkNEc25vZnJpcFFnNjZHYzdMdXNJT3lMck91MmdPdW1oT3ErdkFvdkx5RGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdJS3M3SnFwNjdLVk9pRHRnYlRyb1p6cms1enJpNlRycHF3dDdMeWM2cml3TG1KaGRDRHJqWlRydUpUdGdiVHJwcTBnS091WWtPdUtsQ0J1Y0cwZ2NuVnVJR0p5YVdSblpTa0tMeThnN0x5YzY1R1E2Nm0wDQpJTzJVak91ZnJPcTN1T3lkdU95ZG1DQmI3TGFVN0xLYzY3Q2I2cml3WGVxd2dDQkhaVzFwYm1rZzdZS2tJT3lYaHV5ZHRPdVBoQ0R0Z2JUcm9aenJrNXpyb1p3Z1FVa2c3TGFVN0xLYzdKMkVJT3V3bSt1S2xPdUxwQzRLTHk4S0x5OGc3SWFONjQrRUlPeUVwT3F6aERvZzdZRzA2NkdjNjVPYzY2VzhJT3lhbE95eXJldW5pT3VMcENEc2c0anJvWndnN0l1YzY0K1o3WldZNjZtMElETXdmalF3N0xTSTZyQ0FJT3EzdU91RHBTRHJncURzbFlUcXNJVHJpNlF1Q2k4dklPS0draURyaTZUcnBxenJwYndnN0x5a0lPdVZqQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1k3SjJFSU8yVm1PdUNtQ0RzbDdUc2xyUWc3SU9CN0l1Y0lPdU1nT3E0c095TG5PMkNwT3F6b0NoemRISmxZVzB0YW5OdmJpRHJqSUR0bVpRZzY2cW82NU9jS1N3S0x5OGdJQ0Rxc0lEc25iVHJrNXdyN0ppSTdJdWNLREV4TWVxeHRDbnJpcFFnN0xLcklPdXBsT3lMbk95bmdPdWhuQ0R0bFp3ZzY3S0k2NmVNSU95ZHZlMmVqT3VMcEM0ZzdKMjA3WnVFSU95YQ0KbE95eXJleWRnQ0RyckxqcXRhenJwNHdnNjdPMDY0SzA2NitBNjZHY0lPdTVvT3VsdE91THBDNEtMeThnN0lTNDdJV1k3SjJBSURNdzY3S0lJT3lUc091cHRDRHNucXpzaTV6c25wSHRsYlFnNjR5QTdabVU2ckNBSU91c3RPMlZuTzJlaUNEcXVManNsclRzcDREcmlwUWc2cktEN0oyRUlPdW5pZXVLbE91THBDNEtMeThLTHk4ZzdLQ0U3S0NjT2lEc25iUWdVRVBzbDVBZ1EyeGhkV1JsSUVOdlpHWHFzSUFnN0lTazdMbVl3cmZyb1p6cXQ3anNuYmpyajd3ZzdKNkk3SjJFSU9xeWd5QW9ZMnhoZFdSbElDMHRkbVZ5YzJsdmJpRHNuTHpyb1p3ZzdabVY3SjI0S1Fvdkx5RHNvN3pzblpnNklPeUNyT3lhcWV1ZmlleWRnQ0Rxc0lIc25wQWc3WUcwNjZHYzY1T2NJT3Exck91UGhTRHRsWnpyajRUc2w1RHNoSndnN0xDbzZyQ1E2NUNjNjR1a0xnb0tZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNLWTI5dWMzUWdabk1nUFNCeVpYRjFhWEpsS0NkbWN5Y3BPd3BqYjI1emRDQnZjeUE5SUhKbGNYVnANCmNtVW9KMjl6SnlrN0NtTnZibk4wSUhCaGRHZ2dQU0J5WlhGMWFYSmxLQ2R3WVhSb0p5azdDbU52Ym5OMElIc2djM0JoZDI0c0lITndZWGR1VTNsdVl5QjlJRDBnY21WeGRXbHlaU2duWTJocGJHUmZjSEp2WTJWemN5Y3BPd29LTHk4ZzdZRzA2NkdjNjVPYzY2VzhJT3U1aUNEdGo3VHJqWlRzbDVEc2hKd2c3SXVrN1phSklPS0FsQ0Rzb0lEc25xWHNob3pzbDVEc2hKd2c3SXVrN1phSjdaV1k2Nm0wSU8yVWhPdWhuT3lnbmUyS3VDRHJwNlhybmIwb1EweEJWVVJGTG0xa0lPdVRzU25zbllRS0x5OGc2NmVrSU8yRXRDRHNwNHJzbHJUc29ManNoSndnTkRYc3RJZ3Y3WVMwNnJtTTdLZUFJT3VLa091Z3BPeW5oT3VMcENBbzY3bUlJTzJQdE91TmxDQXJJT3UyZ09xd2dPcTRzT3VLcFNEc3NLanJpNmpzbmJUcnFiUWdmalBzdElndjdZUzBLUzRLWTI5dWMzUWdSVTFRVkZsZlExZEVJRDBnY0dGMGFDNXFiMmx1S0c5ekxuUnRjR1JwY2lncExDQW5ZMnhoZFdSbExXSnlhV1JuWlMxamQyUW5LVHNLZEhKNUlIc2dabk11DQpiV3RrYVhKVGVXNWpLRVZOVUZSWlgwTlhSQ3dnZXlCeVpXTjFjbk5wZG1VNklIUnlkV1VnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdXN0T3lMbkNBcUx5QjlDbU52Ym5OMElFTk1RVlZFUlY5RlRsWWdQU0JQWW1wbFkzUXVZWE56YVdkdUtIdDlMQ0J3Y205alpYTnpMbVZ1ZGl3Z2V3b2dJRTFCV0Y5VVNFbE9TMGxPUjE5VVQwdEZUbE02SUNjd0p5d2dJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQzh2SU95RG5lcXdnU0RycXFqcms1d2c2NEdVSUNqc3A2ZnNuWUFnNjZ5NDZyV3M3SmVVSU91MmlPMlZoT3lhbENrS0lDQkRURUZWUkVWZlEwOUVSVjlFU1ZOQlFreEZYMDVQVGtWVFUwVk9WRWxCVEY5VVVrRkdSa2xET2lBbk1TY3NJQzh2SU8yRXRDRHNtcFRzbGIwZzY1T3hJT3UyZ09xd2dDRHRtTGpzdHB3ZzY0R1VDaUFnUkVsVFFVSk1SVjlVUlV4RlRVVlVVbGs2SUNjeEp5d0tmU2s3Q2dwamIyNXpkQ0JRVDFKVUlEMGdNVEU0T0RnN0NpOHZJT3E0c091enVDRHJxcWpyamJndUlPeWFsT3l5clNqdA0KbEl6cm42enF0N2pzbmJncDdKMjBJRzF2WkdWczdKMkVJT3luZ095Z2xlMlZtT3VwdENEcXQ3Z2c3SnFVN0xLdDY2ZU1JT3EzdUNEcnFxanJqYmpyb1p3ZzdMS1k2NmFzN1pXYzY0dWtMZ292THlCb1lXbHJkVDNydWFEcnBvUXY2ckNBNjdLODdKdUFMQ0J6YjI1dVpYUTk3S1NSNnJDRUxDQnZjSFZ6UGVxNHNPdXp1Q2pzdFp6cXM2RHRrb2pzcDRnc0lPeWhzT3E0aUNEcmlwRHJwcndwQ21OdmJuTjBJRU5NUVZWRVJWOU5UMFJGVENBOUlIQnliMk5sYzNNdVpXNTJMa0pTU1VSSFJWOU5UMFJGVENCOGZDQW5iM0IxY3ljN0NtTnZibk4wSUVGTVRFOVhSVVJmVFU5RVJVeFRJRDBnV3lkb1lXbHJkU2NzSUNkemIyNXVaWFFuTENBbmIzQjFjeWRkT3dwamIyNXpkQ0JVVlZKT1gxUkpUVVZQVlZSZlRWTWdQU0E1TURBd01Ec2dJQ0F2THlEc21wVHNzcTBnTWVxeHRDRHNvSnp0bFp6c2k1enFzSVFLWTI5dWMzUWdUVUZZWDFSVlVrNVRJRDBnTXpBN0lDQWdJQ0FnSUNBZ0lDQWdMeThnN0oyMDY2ZU03WUc4SU95VHNPdXANCnRDRHNoTGpzaFpnZzdKNnM3SXVjN0o2UklDanJqSUR0bVpRZzY0aUU3S0NCSU91d3FleW5nQ2tLQ2k4dklPS1VnT0tVZ0NEc21JanNpNXdnN0lLczdLQ0VJT3Vobk91VG5DQW9jbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrSU9LQWxDQmlkV2xzWkMxbmJHOXpjMkZ5ZVM1cWMreVpnQ0Rxc0puc25ZQWc3WXlNN0lTY0tTRGlsSURpbElBS1puVnVZM1JwYjI0Z2JHOWhaRVY0WVcxd2JHVnpLQ2tnZXdvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdFpDQTlJR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bkxDQW5jbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrSnlrc0lDZDFkR1k0SnlrN0NpQWdJQ0JqYjI1emRDQnpaV05KWkhnZ1BTQnRaQzV6WldGeVkyZ29MMTRqSXlEc3RwVHNzcHdnN0ppSTdJdWNYSE1xSkM5dEtUc0tJQ0FnSUdsbUlDaHpaV05KWkhnZ1BUMDlJQzB4S1NCeVpYUjFjbTRnVzEwN0NpQWdJQ0JqYjI1emRDQmxlR0Z0Y0d4bGN5QTlJRnRkDQpPd29nSUNBZ2JHVjBJR04xY2lBOUlHNTFiR3c3Q2lBZ0lDQm1iM0lnS0dOdmJuTjBJSEpoZHlCdlppQnRaQzV6YkdsalpTaHpaV05KWkhncExuTndiR2wwS0NkY2JpY3BLU0I3Q2lBZ0lDQWdJR052Ym5OMElHeHBibVVnUFNCeVlYY3VjbVZ3YkdGalpTZ3ZYSE1ySkM4c0lDY25LVHNLSUNBZ0lDQWdZMjl1YzNRZ2FDQTlJR3hwYm1VdWJXRjBZMmdvTDE0akl5TmNjeXNvTGlzL0tWeHpLaVF2S1RzS0lDQWdJQ0FnYVdZZ0tHZ3BJSHNnWTNWeUlEMGdleUJwYm5CMWREb2dhRnN4WFN3Z2MzVm5aMlZ6ZEdsdmJuTTZJRnRkSUgwN0lHVjRZVzF3YkdWekxuQjFjMmdvWTNWeUtUc2dZMjl1ZEdsdWRXVTdJSDBLSUNBZ0lDQWdZMjl1YzNRZ1lpQTlJR3hwYm1VdWJXRjBZMmdvTDE1Y2N5b3RYSE1yS0M0clB5bGNjeW9rTHlrN0NpQWdJQ0FnSUdsbUlDaGlJQ1ltSUdOMWNpa2dZM1Z5TG5OMVoyZGxjM1JwYjI1ekxuQjFjMmdvWWxzeFhTNXpjR3hwZENnbklDOGdKeWt1YW05cGJpZ25JQ2NwS1RzS0lDQWdJSDBLSUNBZw0KSUhKbGRIVnliaUJsZUdGdGNHeGxjeTVtYVd4MFpYSW9LR1VwSUQwK0lHVXVjM1ZuWjJWemRHbHZibk11YkdWdVozUm9JRDRnTUNrN0NpQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPY0lPeUxwTzJNcUNBbzdKZUc3SjIwSU95bmhPMldpU2s2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUhKbGRIVnliaUJiWFRzS0lDQjlDbjBLQ2k4dklPS1VnT0tVZ0NEc3A0RHNpNXpyckxnZ0tPeUVuT3V5aENCeVpXTnZiVzFsYm1Uc21ZQWc2ckNaN0oyQUlPcTNuT3k1bVNEaWdKUWc2N0NVNnI2NDY2bTBJT3EzdU95cXZldVBoQ0R0bGFqcXU1Z3BJT0tVZ09LVWdBcGpiMjV6ZENCVFZGbE1SVjlTVlV4RlV5QTlJRnNLSUNBbk1TNGc3WlcwN0pxVTdMSzBPaURycXFqcms2QWc2Nnk0NnJXczY0cVVJTzJWdE95YWxPeXl0T3VobkM0Z0tPdXp0T3VEaGV1TGlPdUxwT0tHa3V1enRPdUN0T3lhbENrbkxBb2dJQ2N5TGlEcmlxWHINCmo1bnNvSUVnNjZlUTdaV1k2cml3T2lEcmtKRHNsclRzbXBUaWhwTHRsb2pzbHJUc21wUXNJSDdzbDRnZzY3bTg2cml3S091d2xPdUFqT3lYaU95V3RPeWFsT0tHa3V1d2xPcS9xT3lXdE95YWxDa3VJT3VMcUN3ZzdLS0Y2Nk9Nd3JmcnA0enJvNHpDdCt5WHNPeXl0TUszN1pXMDdLZUF3cmZxdUxEcm9aM0N0K3VGdWV5ZGpDRHJrN0VnN0l1YzdJcWs3WVdjN0oyMElPeWp2T3l5dE95ZHVDRHFzckRxczd6cmlwUWc3SWlZNjQrWjdaaVZJT3ljb095bmdDanNsN0Rzc3JUcmo3enNtcFFzSU91RnVleWRqT3VQdk95YWxDa3VKeXdLSUNBbk15NGc2cmlON0tDVjdLQ0JJT3Vua08yVm1PcTRzRG9nSW43dGxhQWc3SWlZSU95WGh1eVd0T3lhbENJZzY0eUE3SXVnSUNKKzdaV1k2Nm0wSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVSWlEcXRhenNvYkFnN0pxdzdJU2dMaURyaTZnc0lPeWdsZXl4aGV5RGdTRHJ0b2pxc0lEQ3QreWR2T3UyZ0NEcXVMRHJpcVVnN0tDYzdaV2N3cmZya0pqcmo0enJwclFnN0lpWUlPeVhodXVLDQpsQ0Rxc3JEcXM3ekN0K3lnbGV1enRDRHJzN1R0bUxnZzdKV0k3SXVzN0oyQUlPdTJnT3lnbGUyWWxleWN2T3VobkNEcnFvWHRtWlh0bm9ndUp5d0tJQ0FuTkM0ZzdMcVE3S084N0phODdaV2NJT3F5dmV5V3REb2dmdTJWbU95TG5PcXlvT3lXdE95YWxEL2locEorN1pXZzZybU03SnFVUHl3ZzZyT0U3SXVjNjR1azRvYVM3SjZJNjR1a0xDRHNsNnpzcllqcmk2VGlocEx0bVpYc25ianRsWmpyaTZRc0lPcTdtT0tHa3V5WGtPcXlqQzRnZnV5TG5DRHJ1YnpxdUxEcXNJQWc3SmEwN0lPSjdaV1k2Nm0wSU8yTWpPeVZoZTJWbU91Z3BPdUtsQ0Rzb0pYcnM3VHJwYndnN0tPODdKYTA2NkdjSU91c3VPeWVwZXlkaENEcmk2VHNpNXdnN0pPMDY0dWtMaWNzQ2lBZ0p6VXVJT3VxaGV5Q3JDdnJxb1hzZ3F3ZzZyaUk3S2VBT2lEdGxaenNucERzbHJUcnBid2c3WktBN0phMElPdVBtZXlDck91aG5DanNuYlRzbnBBZzdabVk2N2FJN0oyRUlPdXdtK3lWbU95V3RPeWFsT0tHa3V5ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2cw0KbFpqc2xyVHNtcFFwTENEc3RaenNob3p0bFp3Z2UrdXFoZXlDckgzcXNJQWdlK3VxaGV5Q3JIM3RsYlRzaEp3ZzdaaVY3WU9jNjZHY0tPeWVsT3lWb1NEcnRvRHNvYkhzbkx6cm9aemlocExzbnBUc2xhSHNuYlFnNjdhQTdLR3g3WlcwN0lTY0tTNG5MQW9nSUNjMkxpRHRrWnpxdUxBNklPdVFtT3lXdE95YWxPS0drdXVQdk95YWxDNG5MQW9nSUNjM0xpRHNwSVFnNnJXczdLR3dPaURzbTVEcnM3anNuYlFnN1pXY0lPeWtoT3lkdE91cHRDRHN0cFRzc3B6cmo0UWc2N0NZNjVPYzdJdWNJTzJWbkNEc3BJVHJvWnd1SU95ZWhPeWRtT3VobkNEc3BJVHNuWVFnNjRxWTY2YXM3S2VBSU95Vml1dUtsT3VMcEM0ZzY0dW9MQ0RzbDZ6cm42d2c2Nnk0N0o2bDdKMkVJTzJWbU91Q21PeWRtQ0RxdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPMlZxZXl6a0NEcmpaUWc2ckNFNnJLdzdaVzA3S2VFNjR1azY2bTBJT3lraENEc2lKanJwYndnN0tTRTdKMjA2NHFVSU9xeWcreWRnQ0R0bVpqc21JRXVKeXdLSUNBbk9DNGcNCjY0dWs3SjIwN0phODY2R2M2cmU0SU95WnZPeXF2U0Ryc29UdGlyd2c2NTI4NjdLbzdKMkFJQ0xyaTZ2cXVMQWlLT3kzcU95R2pDRHF1SWpzcDRBcExpY3NDaUFnSnprdUlPeWR0T3VtaE1LMzdLQ0U3Wm1VNjdLSTdaaTR3cmZycDRqc2lxVHRncm5zbllBZzZyZTQ2NHlBNjZHY0lPdXp0T3lodEM0ZzdJS3M2NTZNN0oyRUlPdTJnT3VsdkNEcmxaQWc2NHVZN0oyRUlPdTJtZXlYck91UGhDRHNvb3ZyaTZRdUp5d0tJQ0FuTVRBdUlPeWduTzJTaUNEc21xbnNsclFnN0p5ZzdLZUFPaURzbm9Ycm9LWHNsNUFnN0pPdzdKMjRJT3E0c091S3BleUVzU0RycW9Yc2dxd282N09BNnJLOUxDRHNwNERzb0pVc0lPdVRzZXVoblN3ZzdaVzA3S0NjSU91VHNTbnJpcFFnN1ptVTY2bTA3SjJZSU9xNHNPdUtwZXVxaGNLMzY3S0U3WXE4NjZxRjdKMjhJT3F3Z091S3BleUVzZXlkdENEcmhwTHNuTHpycjREcm9ad2c3SW1zN0pxMElPdW5rT3VobkNEcnNKVHF2cmpzcDRBZzdKV0s2NHFVNjR1a0xpRHNpNXpzaXFUdGhad2c2NCtaDQo3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXpycGJ3ZzdJT0k2NkdjSU91bmpPdVRwT3luZ0NEc2xZcnJpcFRyaTZRdUp5d0tYUzVxYjJsdUtDZGNiaWNwT3dvS1kyOXVjM1FnUlZoQlRWQk1SVk1nUFNCc2IyRmtSWGhoYlhCc1pYTW9LVHNLQ21aMWJtTjBhVzl1SUdsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncElIc0tJQ0JqYjI1emRDQm1aWGRUYUc5MElEMGdSVmhCVFZCTVJWTXViV0Z3S0NobGVDa2dQVDRnSjBsdWNIVjBPaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvWlhndWFXNXdkWFFwSUNzZ0oxeHVUM1YwY0hWME9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29aWGd1YzNWbloyVnpkR2x2Ym5NcEtTNXFiMmx1S0NkY2JpY3BPd29nSUhKbGRIVnliaUFvQ2lBZ0lDQW43S2VBNnJpSTY3YUE3WVN3SU91RWlPdUtsQ0RzbDVEc2lxVHNtNUFvVXkweExDRHJzN1RzbFlqdG1venNncXdwN0oyWUlPMlZuT3ExcmV5V3RDQlZXQ0JYY21sMGFXNW5JT3lnaE91c3VPcXdnT3VobkNEc25ienRsWnpyaTZRdQ0KSUNjZ0t3b2dJQ0FnSit1Q3RPcXdnQ0JWU1NEcnJManF0YXpycGJ3ZzdaV1k2NEtZN0pTcElPdXp0T3VDdE91cHRDd2c3SldFNjU2WUlPeUtwTzJEZ095ZHZDRHF0NXpzdVpuc2w1QWc2NmVlNnJLTUlPdUxwT3VUck95ZGdDRHJqSURzbFlnZ00rcXduT3VsdkNEc29KenNsWWp0bFpqcm5id3VYRzRuSUNzS0lDQWdJQ2ZzbXBUc3NxM3JrNlRzbllBZzdJU2M2NkdjSU91c3RPcTBnTzJWbkNEcnM0VHFzSndnNjZ5NDZyV3M2NHVrSU9LQWxDRHNuYlRzb0lRZzY2eTQ2cldzNjZXOElPeXd1T3loc08yVm1PeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ2ZzbTVEcm5wZ2c3SjJZNjYrNDdKbUFJT3VxcU91VG9DRHNvSlhyczdRbzdKMjA2NmFFd3Jmc2lLdnNucERDdCt5aHNPcXh0TUszNjR5QTdJT0JLZXVsdkNEc25LRHNwNER0bFpqcXM2QXNJT3F3Z1NEc29KenNsWWpzbllBZzdKdVE2N080NnJPODY0K0VJT3lFbk91aG5PeVpnT3VQaENEcmk2enJuYnpzbGJ3ZzdaV2M2NHVrTGx4dUp5QXJDaUFnSUNBbjY0dTENCjdKMkFJT3V3bU91VG5PeUxuQ0JLVTA5T0lPdXdzT3lYdE91bmpDRHN0cHpyb0tYdGxaenJpNlF1SU91bmlPMkJyT3VMcE95YXRNSzM3SVNrNjZxRndyZnN2WlRyazV6dGpwenNpcVFnNnJpSTdLZUFPbHh1SnlBckNpQWdJQ0FuVzNzaWRHVjRkQ0k2SUNMc29KenNsWWdnNjZ5NDZyV3NJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKeVpXRnpiMjRpT2lBaTY2eTA3SmVIN0oyRUlPeVpuQ0Ryc0pUcXY2anJpcFRzcDRBZzdaV2M2cld0N0phMElPMlZuQ0Ryckxqc25xVWlmU3dnTGk0dVhWeHVYRzRuSUNzS0lDQWdJQ2RiN0lxazdZT0E3SjI4SU9xM25PeTVtVjFjYmljZ0t5QlRWRmxNUlY5U1ZVeEZVeUFySUNkY2JseHVKeUFyQ2lBZ0lDQW9abVYzVTJodmRDQS9JQ2RiN0pxdzY2YXNJT3VxcWV5R2pPdW1yQ0RzbUlqc2k1d2c0b0NVSU95ZHRDRHRocVRzbllRZzY1U3c2Nlc4SU9xeWcxMWNiaWNnS3lCbVpYZFRhRzkwSUNzZ0oxeHVYRzRuSURvZ0p5Y3BJQ3NLSUNBZ0lDZnNwSURydVlUcmtKRHNuTHpyDQpxYlFnSWs5TEl1dWR2T3F6b091bmpDRHJpN1h0bFpqcm5id3VKd29nSUNrN0NuMEtDaTh2SU9LVWdPS1VnQ0RzZzRIc2k1d2c2NHlBNnJpd0lPMkJ0T3Vobk91VG5DRHNoTGpzaFpnZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUNteGxkQ0J3Y205aklEMGdiblZzYkRzZ0lDQWdJQ0FnSUNBZ0x5OGc3WUcwNjZHYzY1T2NJTzJVaE91aG5PeUV1T3lLcEFwc1pYUWdiR2x1WlVKMVppQTlJQ2NuT3lBZ0lDQWdJQ0FnSUM4dklITjBaRzkxZENEc3BJUWc2N0tFN1kyOENteGxkQ0IzWVdsMFpYSWdQU0J1ZFd4c095QWdJQ0FnSUNBZ0x5OGc3WmlFN0o2c0lPMkV0T3lkbUNCN0lISmxjMjlzZG1Vc0lISmxhbVZqZEN3Z2RHbHRaWElnZlFwc1pYUWdjWFZsZFdVZ1BTQlFjbTl0YVhObExuSmxjMjlzZG1Vbw0KS1RzZ0x5OGc3SnFVN0xLdElPeW5nZXVnck8yWmxDQW82NCtaN0l1Y0lPeWFsT3l5cmV5ZGdDRHNpSnpzaEp6cmpJRHJvWndwQ214bGRDQjBkWEp1Y3lBOUlEQTdDbXhsZENCM1lYSnRaV1JWY0NBOUlHWmhiSE5sT3dwc1pYUWdZM1Z5Y21WdWRFMXZaR1ZzSUQwZ1EweEJWVVJGWDAxUFJFVk1PeUF2THlEc3A0RHF1SWdnN0lTNDdJV1k3SjIwSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NnFvNjQyNElDanNtcFRzc3Ezc25iUWc2NHVrNjZXNElPdXFxT3VOdU95ZGhDRHNwNERzb0pYdGxaanJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU2tLTHk4ZzdJdWM3SjZSSU95TG5DQkRiR0YxWkdVZ1EyOWtaU2hqYkdGMVpHVWdRMHhKS2Vxd2dDRHNrN2dnN0lpWUlPeWVpT3VLbE95bmdDRHNvSkRxc29BZzRvQ1VJT3lYaHV5Y3ZPdXB0Q0F2YUdWaGJIUm82NkdjSU95VmpPdWdwQ0R0bEl6cm42enF0N2pzbmJqc25iUWc3SldJNjRLMDdaV2M2NHVrTGdvdkx5QnVkV3hzUGUyWmxleWR1Q0RzcEpFc0lDZHZheWM5N0lLczdKcXANCklPcXdnT3VLcFN3Z0oyTnNZWFZrWlMxdGFYTnphVzVuSnoxamJHRjFaR1VnNjZxRjY2QzVJT3lYaHV5ZGpDL3JvWnpxdDdqc25iZ2c3SldJSU91UXFBcHNaWFFnWTJ4aGRXUmxVM1JoZEhWeklEMGdiblZzYkRzS1puVnVZM1JwYjI0Z1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LU0I3Q2lBZ1kyOXVjM1FnY0hKdlltVWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0TFhabGNuTnBiMjRuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdJSDBwT3dvZ0lHeGxkQ0J2ZFhRZ1BTQW5KenNLSUNCd2NtOWlaUzV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJ2ZFhRZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc0tJQ0J3Y205aVpTNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljN0lIMHBPd29nSUhCeWIySmxMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqDQpiR0YxWkdWVGRHRjBkWE1nUFNBb1kyOWtaU0E5UFQwZ01DQW1KaUF2WEdRclhDNWNaQ3N2TG5SbGMzUW9iM1YwS1NrZ1B5QW5iMnNuSURvZ0oyTnNZWFZrWlMxdGFYTnphVzVuSnpzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCRGJHRjFaR1VnUTI5a1pTRHNvSkRxc29BNklDY2dLeUJqYkdGMVpHVlRkR0YwZFhNZ0t5QW9iM1YwSUQ4Z0p5QW9KeUFySUc5MWRDNTBjbWx0S0NrZ0t5QW5LU2NnT2lBbkp5a3BPd29nSUgwcE93cDlDaTh2SU95eW1PdW1yQ0R0bUlUdG1ha2c0b0NVSUM5b1pXRnNkR2pyb1p3ZzY0VzQ3TGFjN1pXMElDTHNvSlhycDVBZzdZRzA2NkdjNjVPYzZyQ0FJT3VMdGUyV2lPdUtsT3luZ0NJZzY3Q1c3SmVRN0lTY0lPMlpsZXlkdU8yVm9DRHNpSmdnN0o2STZyS01JTzJWbk91THBBcGpiMjV6ZENCemRHRjBjeUE5SUhzZ2MyVnlkbVZrT2lBd0xDQnNZWE4wUVhRNklDY25MQ0JzWVhOMFZHVjRkRG9nSnljc0lHeGhjM1JUWldNNklDY25JSDA3Q2dvdkx5RGlsSURpbElBZw0KN1pTTTY1K3M2cmU0N0oyNElPeURuZXlodENEcXNKRHNwNEFvN0l1czdKNmw2N0NWNjQrWktTRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3WlNNNjUrczZyZTQ3SjI0N0oyMElPdVdvQ0Rzbm9qcmlwUWc2NCtaN0pXSUlHTnZaR1V1ZEhQcXNJQWdOZXkwaU91bmlPdUxwQ0JRVDFOVUlDOW9aV0Z5ZEdKbFlYVHJwYndnNjdPMDY0SzQ2NHVrTGdvdkx5RHRsWndnNjdLSTdKMjA2NTI4NjQrRUlPdXdtK3lkZ0NEcmtxUWdNekRzdElqcXNJUWc2NEdLNnJpdzY2bTBJTzJVak91ZnJPcTN1T3lkdUNqcm1KRHJpcFFnN1pTODZyZTQ2NmVJS2V5ZHRDRHJpNnZ0bm93ZzZyS0RJT0tBbENEdGdiVHJvWnpyazV6cXVZenNwNEFnNjQydzY2YXM2ck9nSU9xd21leWR0Q0RxdXJ6c3A0VHJpNlF1Q2k4dklPeVZoT3luZ1NEdGxad2c2N0tJNjQrRUlPdXENCnV5RHJzSnZzbFpqc25MenJxYlFvNjR1azY2YXM2NmVNSU91b3ZPeWdnQ0RzdktBZzdJT0I3WU9jTENEc25wRHJqNW5zaTV6c25wRWc2NU94S1NEcXM0VHNobzBnNjR5QTZyaXc3WldjNjR1a0xncGpiMjV6ZENCSVJVRlNWRUpGUVZSZlJFVkJSRjlOVXlBOUlETXdNREF3T3dwc1pYUWdiR0Z6ZEVKbFlYUWdQU0F3T3dwelpYUkpiblJsY25aaGJDZ29LU0E5UGlCN0NpQWdhV1lnS0d4aGMzUkNaV0YwSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFtVmhkQ0ErSUVoRlFWSlVRa1ZCVkY5RVJVRkVYMDFUS1NCN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1WUFnNG9DVUlPMlV2T3EzdU91bmlDL3RsSXpybjZ6cXQ3anNuYmpzbmJRZzY0dXI3WjZNSU9xeWcreWN2T3VobkNEcnM3VHFzNkFnNnJDWjdKMjBJT3E2dk95bmtldUxpT3VMcEM0bktUc0tJQ0FnSUhCeWIyTmxjM011WlhocGRDZ3dLVHNnTHk4Z1pYaHBkQ0R0DQpsYmpyazZUcm42enFzSUFnYTJsc2JGQnliMlBzbkx6cm9ad2dZMnhoZFdSbElPMkt1T3Vtck91bHZDRHNvSlhycHF6dGxaenJpNlFLSUNCOUNuMHNJRFV3TURBcE93b0tablZ1WTNScGIyNGdhMmxzYkZCeWIyTW9LU0I3Q2lBZ2FXWWdLSEJ5YjJNcElIc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUNBZ0x5OGdjMmhsYkd3NmRISjFaZXVobkNEcm5ZVHNtNHpzaEp3Z2NISnZZK3lkZ0NCamJXUWc2cnVONjQydzZyaXdJT0tBbENBdlZPdWhuQ0R0aXJqcnBxenNwN2dnN0tPOTdKZXM3Slc4SU95bmhPeW5uQ0JqYkdGMVpHWHFzSUFnNnJPZzdKV0U2NkdjSU95VmlDRHJncWpyaXBUcmk2UUtJQ0FnSUNBZ0lDQXZMeUFvNnJPZzdKV0VJR05zWVhWa1plcXdnQ0RzaEtUc3VaZ2c3WXlNN0oyODdKMkVJT3Vzdk9xem9DRHNub2pzbkx6cnFiUWc3WUcwNjZHYzY1T2NJT3lWc1NEc2w0WHJqYkRzbmJUdGlyanFzSUFnSXV5Qw0Kck95YXFTRHNwSkVpN0p5ODY2R2NJT3VuaWUyZW1Da0tJQ0FnSUNBZ0lDQnpjR0YzYmxONWJtTW9KM1JoYzJ0cmFXeHNKeXdnV3ljdlVFbEVKeXdnVTNSeWFXNW5LSEJ5YjJNdWNHbGtLU3dnSnk5VUp5d2dKeTlHSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPd29nSUNBZ0lDQjlJR1ZzYzJVZ2V3b2dJQ0FnSUNBZ0lIQnliMk11YTJsc2JDZ3BPd29nSUNBZ0lDQjlDaUFnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRb2dJSDBLSUNCd2NtOWpJRDBnYm5Wc2JEc0tJQ0IzWVhKdFpXUlZjQ0E5SUdaaGJITmxPd29nSUdsbUlDaDNZV2wwWlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0hkaGFYUmxjaTUwYVcxbGNpazdJSGRoYVhSbGNpNXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lpaGV1ampPdVFrT3lXdE95YWxDNG5LU2s3SUhkaGFYUmxjaUE5SUc1MWJHdzdJSDBLZlFvS1puVnVZM1JwYjI0Z2MzUmhjblJRY205aktDa2cNCmV3b2dJR3RwYkd4UWNtOWpLQ2s3Q2lBZ2JHbHVaVUoxWmlBOUlDY25Pd29nSUhSMWNtNXpJRDBnTURzS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RzaTV6cmo1a2c3S1NSNG9DbUlDanJxcWpyamJnNklDY2dLeUJqZFhKeVpXNTBUVzlrWld3Z0t5QW5LU2NwT3dvZ0lHTnZibk4wSUhSb2FYTlFjbTlqSUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbkxYQW5MQ0FuTFMxdGIyUmxiQ2NzSUdOMWNuSmxiblJOYjJSbGJDd2dKeTB0YVc1d2RYUXRabTl5YldGMEp5d2dKM04wY21WaGJTMXFjMjl1Snl3Z0p5MHRiM1YwY0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzSUNjdExYWmxjbUp2YzJVblhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1kzZGtPaUJGVFZCVVdWOURWMFFzSUdWdWRqb2dRMHhCVlVSRlgwVk9WaUI5S1RzS0lDQndjbTlqSUQwZ2RHaHBjMUJ5YjJNN0NpQWdjSEp2WXk1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnDQpld29nSUNBZ2JHbHVaVUoxWmlBclBTQmtMblJ2VTNSeWFXNW5LQ2QxZEdZNEp5azdDaUFnSUNCc1pYUWdhV1I0T3dvZ0lDQWdkMmhwYkdVZ0tDaHBaSGdnUFNCc2FXNWxRblZtTG1sdVpHVjRUMllvSjF4dUp5a3BJQ0U5UFNBdE1Ta2dld29nSUNBZ0lDQmpiMjV6ZENCc2FXNWxJRDBnYkdsdVpVSjFaaTV6YkdsalpTZ3dMQ0JwWkhncExuUnlhVzBvS1RzS0lDQWdJQ0FnYkdsdVpVSjFaaUE5SUd4cGJtVkNkV1l1YzJ4cFkyVW9hV1I0SUNzZ01TazdDaUFnSUNBZ0lHbG1JQ2doYkdsdVpTa2dZMjl1ZEdsdWRXVTdDaUFnSUNBZ0lHeGxkQ0JsZGlBOUlHNTFiR3c3Q2lBZ0lDQWdJSFJ5ZVNCN0lHVjJJRDBnU2xOUFRpNXdZWEp6WlNoc2FXNWxLVHNnZlNCallYUmphQ0FvWDJVcElIc2dZMjl1ZEdsdWRXVTdJSDBLSUNBZ0lDQWdhV1lnS0dWMklDWW1JR1YyTG5SNWNHVWdQVDA5SUNkeVpYTjFiSFFuSUNZbUlIZGhhWFJsY2lrZ2V3b2dJQ0FnSUNBZ0lHTnZibk4wSUhjZ1BTQjNZV2wwWlhJN0NpQWdJQ0FnSUNBZw0KZDJGcGRHVnlJRDBnYm5Wc2JEc0tJQ0FnSUNBZ0lDQmpiR1ZoY2xScGJXVnZkWFFvZHk1MGFXMWxjaWs3Q2lBZ0lDQWdJQ0FnYVdZZ0tHVjJMbWx6WDJWeWNtOXlLU0IzTG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSisyQnRPdWhuT3VUbkNEc21LVHJwWmc2SUNjZ0t5QlRkSEpwYm1jb1pYWXVjbVZ6ZFd4MElIeDhJR1YyTG5OMVluUjVjR1VnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJREl3TUNrcEtUc0tJQ0FnSUNBZ0lDQmxiSE5sSUhjdWNtVnpiMngyWlNoVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElDY25LU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lIMEtJQ0I5S1RzS0lDQndjbTlqTG5OMFpHVnljaTV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCeklEMGdaQzUwYjFOMGNtbHVaeWduZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUdsbUlDaHpJQ1ltSUNGekxtbHVZMngxWkdWektDZEVaWEJ5WldOaGRHbHZibGRoY201cGJtY25LU2tnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElHTnMNCllYVmtaU0J6ZEdSbGNuSTZKeXdnY3k1emJHbGpaU2d3TENBeU1EQXBLVHNLSUNCOUtUc0tJQ0J3Y205akxtOXVLQ2RqYkc5elpTY3NJQ2hqYjJSbEtTQTlQaUI3Q2lBZ0lDQXZMeURzbmJUcnI3Z2c3SU9JSU95RXVPeUZtT3ljdk91aG5DRHF0WkRzc3JUcmtKd2c2NUtrSU95WW15RHNoTGpzaFpqc25iUWc2NHVyN1o2TUlPcXhzT3VwdENEcnJMVHNpNXdnS091cXFPdU51Q0Rzb0lUdG1aZ2c3SXVjSU95RGlDRHNoTGpzaFpqc25ZUWc3S085N0oyMDdLZUFJT3lWaXVxeWpDa0tJQ0FnSUdsbUlDaHdjbTlqSUNFOVBTQjBhR2x6VUhKdll5a2djbVYwZFhKdU93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHNoTGpzaFpnZzdLS0Y2Nk9NSUNoamIyUmxJQ2NnS3lCamIyUmxJQ3NnSnlrZzRvQ1VJT3VMcE95ZGpDRHNtcFRzc3EwZzY1V01JT3VMcE95TG5DRHNpNXpyajVudGxhbnJpNGpyaTZRdUp5azdDaUFnSUNCcmFXeHNVSEp2WXlncE93b2dJSDBwT3dwOUNncG1kVzVqDQpkR2x2YmlCelpXNWtWSFZ5YmloMFpYaDBLU0I3Q2lBZ2NtVjBkWEp1SUc1bGR5QlFjbTl0YVhObEtDaHlaWE52YkhabExDQnlaV3BsWTNRcElEMCtJSHNLSUNBZ0lHbG1JQ2doY0hKdll5a2djbVYwZFhKdUlISmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNoTGpzaFpqc25iUWc3SmVHN0phMDdKcVVMaWNwS1RzS0lDQWdJR2xtSUNoM1lXbDBaWElwSUhKbGRIVnliaUJ5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2ZzbFo3c2hLQWc3SnFVN0xLdDdKMjBJT3luaE8yV2lTRHNwSkhzbmJUc2w1RHNtcFF1SnlrcE93b2dJQ0FnWTI5dWMzUWdkR2x0WlhJZ1BTQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJFdENEc2k1enFzSVFnN0xTSTZyTzhJT0tBbENEc2hManNoWmpzbllRZzdKNnM3SXVjN0o2UjdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ2ZTd2dWRlZTVGw5VVNVMUZUMVZVWDAxVA0KS1RzS0lDQWdJSGRoYVhSbGNpQTlJSHNnY21WemIyeDJaU3dnY21WcVpXTjBMQ0IwYVcxbGNpQjlPd29nSUNBZ2NISnZZeTV6ZEdScGJpNTNjbWwwWlNoS1UwOU9Mbk4wY21sdVoybG1lU2g3SUhSNWNHVTZJQ2QxYzJWeUp5d2diV1Z6YzJGblpUb2dleUJ5YjJ4bE9pQW5kWE5sY2ljc0lHTnZiblJsYm5RNklIUmxlSFFnZlNCOUtTQXJJQ2RjYmljc0lDZDFkR1k0SnlrN0NpQWdmU2s3Q24wS0NpOHZJT3F3bWV5ZGdDRHJyTGpxdGF6cnBid2c2NnFISU91eWlPeW51Q0Ryckx2cmlwVHNwNEFnNnJpdzdKYTFJT0tBbENEc25xenNtcFRzc3Ezc25iVHJxYlFnSXV5ZHRPeWdoT3F6dkNEcmk2VHJwYmdnN0lPSUlPeWduT3lWaUNMc25ZUWc3SnFVNnJXczdaV2M2NHVrQ2k4dklDanNsWWdnNnJlNDY1K3M2Nm0wSU8yQnRPdWhuT3VUbk9xd2dDRHNoTEhzaTZUdGxaanFzb3dnNnJDWjdKMkFJT3VMdGV5ZGhDRHJtSkFnNjRLMDdJU2NJRnRCU1NEc3RwVHNzcHdnNjQyVUlPdXdtK3E0c0YzcXNJQWc2NnkwN0oyWTY2KzQNCjdaVzA3S2VFNjR1a0tRcGpiMjV6ZENCaGMydGxaRU52ZFc1MElEMGdibVYzSUUxaGNDZ3BPd29LTHk4ZzdJUzQ3SVdZSU95a2dPdTVoQ2pzaTV6cmo1a3I3S2VBN0l1YzY2eTRJT3lqdk95ZWhTbnJwYndnNjdPMDdKNmw3WldjSU91U3BDRHRsWndnN1lTMElPeUxwTzJXaVNEaWdKUWc2NnFvNjVPZ0lPMll1T3kybk95ZGdDQnhkV1YxWmV1aG5DRHNwNEhyb0t6dG1aUXVDaTh2SUcxdlpHVnM3SjJFSU95anZPdXB0Q0RxdDdnZzY2cW82NDI0NjZHY0lDanJpNlRycGJUcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTa3VJTzJWbkNEcnFxanJqYmpzbllRZzZyT0U3SWFOSU95VHNPdXB0Q0RzbnF6c2k1enNucEhzbllBZzdMV2M3TFNJSURIdG1venJ2NUF1Q21aMWJtTjBhVzl1SUhKMWJsUjFjbTRvWW5WcGJHUkJjMnNzSUcxdlpHVnNLU0I3Q2lBZ1kyOXVjM1FnYW05aUlEMGdjWFZsZFdVdWRHaGxiaWhoYzNsdVl5QW9LU0E5UGlCN0NpQWdJQ0JwWmlBb2JXOWtaV3dnSmlZZ1FVeE1UMWRGUkY5TlQwUkZURk11DQphVzVrWlhoUFppaHRiMlJsYkNrZ0lUMDlJQzB4SUNZbUlHMXZaR1ZzSUNFOVBTQmpkWEp5Wlc1MFRXOWtaV3dwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdXFxT3VOdUNEcnM0RHFzcjA2SUNjZ0t5QmpkWEp5Wlc1MFRXOWtaV3dnS3lBbklPS0draUFuSUNzZ2JXOWtaV3dwT3dvZ0lDQWdJQ0JqZFhKeVpXNTBUVzlrWld3Z1BTQnRiMlJsYkRzS0lDQWdJQ0FnYzNSaGNuUlFjbTlqS0NrN0lDOHZJT3lEaUNEcnFxanJqYmpyb1p3ZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NBbzY0dWs3SjJNSU95YmpPdXdqZXlYaGV5WGtPeUVuQ0RzcDREc2k1enJyTGdnN0o2czdLTzg3SjZGS1FvZ0lDQWdmUW9nSUNBZ2FXWWdLSFIxY201eklENDlJRTFCV0Y5VVZWSk9VeUI4ZkNBaGNISnZZeWtnYzNSaGNuUlFjbTlqS0NrN0NpQWdJQ0JwWmlBb0lYZGhjbTFsWkZWd0tTQjdDaUFnSUNBZ0lHTnZibk4wSUhRd0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lDQWdZWGRoYVhRZ2MyVnVaRlIxY200bw0KYVc1emRISjFZM1JwYjI1TlpYTnpZV2RsS0NrcE93b2dJQ0FnSUNCM1lYSnRaV1JWY0NBOUlIUnlkV1U3Q2lBZ0lDQWdJSFIxY201ekt5czdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haZ2c3S1NBNjdtRUlPeVpoT3VqakNBb0p5QXJJQ2dvUkdGMFpTNXViM2NvS1NBdElIUXdLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2tnS3lBbmN5a2c0b0NVSU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjdtbzY1Mjg3SnFVTGljcE93b2dJQ0FnZlFvZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUhKbGRIVnliaUJ6Wlc1a1ZIVnliaWhpZFdsc1pFRnpheWdwS1RzS0lDQjlLVHNLSUNBdkx5RHRsWndnN0pxVTdMS3Q3SjIwSU95THBPMk1xTzJWdE91UGhDRHJpNlRzbll3ZzdKcVU3TEt0N0oyMElPeWR0T3lXdE95bmdPdVBoT3VoblNEdGdaRHJpcFFnN1pXdDdJT0JJT3lFc2VxenRleWN2T3VobkNEc29KWHJwcXdLSUNCeGRXVjFaU0E5SUdwdllpNWpZWFJqYUNnb0tTQTlQaUI3ZlNrN0NpQWcNCmNtVjBkWEp1SUdwdllqc0tmUW9LTHk4ZzY2eTQ2cldzSU95MmxPeXluQ0R0aExRS1puVnVZM1JwYjI0Z1lYTnJRMnhoZFdSbEtIUmxlSFFzSUcxdlpHVnNLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2gwWlhoMEtTQjhmQ0F3S1NBcklERTdDaUFnSUNCaGMydGxaRU52ZFc1MExuTmxkQ2gwWlhoMExDQmhkSFJsYlhCMEtUc0tJQ0FnSUdsbUlDaGhjMnRsWkVOdmRXNTBMbk5wZW1VZ1BpQXlNREFwSUdGemEyVmtRMjkxYm5RdVkyeGxZWElvS1RzZ0x5OGc2NnkwN1pXYzdaNklJT3lNayt5ZHRPeW5nQ0RzbFlycXNvd0tJQ0FnSUhKbGRIVnliaUJoZEhSbGJYQjBJRDRnTVFvZ0lDQWdJQ0EvSUNmcXNKbnNuWUFnNjZ5NDZyV3M2Nlc4SU91THBPeUxuQ0RzbXBUc3NxM3RsWnpyaTZRdUlPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA3S0NFN0plUUlPeWduT3lWaU8yV2lPdU5tQ0Rxc29Qcms2VHFzN3dnDQo2cks1N0xtWTdLZUFJT3lWaXV1S2xDd2c2cldzN0tHdzY0S1lJT3lXdE8yY21PcXdnQ0R0bVpYc2k2VHRub2dnNjR1azY2VzRJT3lEaU91aG5PeWF0Q0RyaklEc2xZZ2dNK3F3bk91bHZDRHF0NXpzdVpucmpJRHJvWndnU2xOUFRpRHJzTERzbDdUcm9aenJwNHc2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLUW9nSUNBZ0lDQTZJQ2ZyaTZUc25Zd2dWVWtnNjZ5NDZyV3M3SjJZSU91TWdPeVZpQ0F6NnJDYzY2VzhJT3Ezbk95NW1ldU1nT3VobkNCS1UwOU9JT3V3c095WHRPdWhuT3VuakRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwT3dvZ0lIMHNJRzF2WkdWc0tUc0tmUW9LTHk4ZzY3S0k3SmV0SU8yRXRDRGlnSlFnNnJDWjdKMkFJT3lFdU95Rm1PeWRoQ0RzazdEcmtKZ3NJT3lkdE91eWlDRHRoTFRycDR3ZzdMYVU3TEtjSU8yWWxleUxuU2hLVTA5T0lPdXdzT3lYdENrZzY0eUE3SXVnSU91eWlPeVhyU0R0bUpYc2k1MG9TbE5QVGlEcXNKM3NzclFwN0oyRUlPeWFsT3Exck8yVg0Kbk91THBBcG1kVzVqZEdsdmJpQmhjMnRVY21GdWMyeGhkR1VvZEdWNGRDd2diVzlrWld3cElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlBb0NpQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0Ryc29qc2w2MGc3SjZSN0plRjdKMjA2NHVrSUNqcnJManF0YXdnNjR1azY1T3M2cml3SU95VmhPdUxtQ0RpZ0pRZzY0eUE3SldJSURQcXNKd2c2cmVjN0xtWjdKMkFJT3lkdE91eWlDRHRoTFRzbDVBZzdLQ0I3SnFwN1pXWTdLZUFJT3lWaXV1S2xPdUxwQ2t1SUNjZ0t3b2dJQ0FnSit1THBPeWRqQ0JWU1NEcnJManF0YXpxc0lBZzdaV2M2cld0N0phMDY2bTBJT3lla095WHNPeUtwT3Vmck95YXRDRHNtSUhzbHJUcm9ad3NJT3lZZ2V5V3RPdXB0Q0RzbnBEc2w3RHNpcVRybjZ6c21yUWc3WldjNnJXdDdKYTA2NkdjSU91eWlPeVhyZTJWbU91ZHZDNGdKeUFyQ2lBZ0lDQW5WVWtnNjZ5NDZyV3M2NHVrN0pxMElPcXdoT3F5c08yVm5DRHRrWnp0bUlUc25ZUWc3Sk93NnJPZ0xDRHNuYlRycG9UQ3QreUkNCnEreWVrTUszNjZlSTdJcWs3WUs1d3JmdGxJenJvSWpzbmJUc2lxVHRtWURyalpUcmlwUWc2cmU0NjR5QTY2R2NJT3V6dE95aHRPMlZuT3VMcEM0Z0p5QXJDaUFnSUNBbjdKdVE2Nnk0N0oyWUlPeWtoQ0RzaUpqcnBid2c2cmU0NjR5QTY2R2NJT3ljb095bmdPMlZuT3VMcENEaWdKUWc3SnVRNjZ5NDdKMjBJTzJWbkNEc3BJVHNuYlRycWJRZzY3S0k3SmV0NjQrRUlPMlZuQ0RzcElUcm9ad3NJT3lraE91d2xPcS9pT3lkaENEc25vVHNuWmpyb1p3ZzdMYVU2ckNBN1pXWTdLZUFJT3lWaXV1S2xPdUxwQzRnSnlBckNpQWdJQ0FuNjR1MTdKMkFJT3V3bU91VG5PeUxuQ0JLVTA5T0lPcXduZXl5dENEdGxaanJncGpycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaFNEcXVJanNwNEE2SUNjZ0t3b2dJQ0FnSjNzaWRISmhibk5zWVhSbFpDSTZJQ0xyc29qc2w2M3JyTGdnS095a2hPdXdsT3EvaU95ZGdDQmNYRzRwSWl3Z0ltUnBjbVZqZEdsdmJpSTZJQ0pyYitLR2ttVnVJT3VZDQprT3VLbENCbGJ1S0drbXR2SW4wNklDY2dLeUJLVTA5T0xuTjBjbWx1WjJsbWVTaDBaWGgwS1FvZ0lDa3NJRzF2WkdWc0tUc0tmUW9LTHk4ZzY3S0k3SmV0SU95ZGtldUx0ZXlYa095RW5DQjdkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1ZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwQ21aMWJtTjBhVzl1SUhCaGNuTmxWSEpoYm5Oc1lYUmxLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQjBjbUZ1YzJ4aGRHVmtJRDBnVTNSeQ0KYVc1bktDaHZJQ1ltSUc4dWRISmhibk5zWVhSbFpDa2dmSHdnSnljcExuUnlhVzBvS1RzS0lDQWdJR2xtSUNoMGNtRnVjMnhoZEdWa0tTQnlaWFIxY200Z2V5QjBjbUZ1YzJ4aGRHVmtMQ0JrYVhKbFkzUnBiMjQ2SUZOMGNtbHVaeWdvYnlBbUppQnZMbVJwY21WamRHbHZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95VmhPdWVtT3VobkNBcUx5QjlDaUFnY21WMGRYSnVJRzUxYkd3N0NuMEtDaTh2SU95ZGtldUx0ZXlYa095RW5DQjdkR1Y0ZEN3Z2NtVmhjMjl1ZlNEcnNMRHNsN1FnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpWTjFaMmRsYzNScGIyNXpLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2cNCkp5Y3BPd29nSUdOdmJuTjBJRzBnUFNCekxtMWhkR05vS0M5Y1cxdGNjMXhUWFNwY1hTOHBPd29nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnWVhKeUlEMGdTbE5QVGk1d1lYSnpaU2h6S1RzS0lDQWdJR2xtSUNoQmNuSmhlUzVwYzBGeWNtRjVLR0Z5Y2lrcElIc0tJQ0FnSUNBZ2NtVjBkWEp1SUdGeWNnb2dJQ0FnSUNBZ0lDNXRZWEFvS0hncElEMCtJQ2g3SUhSbGVIUTZJRk4wY21sdVp5Z29lQ0FtSmlCNExuUmxlSFFwSUh4OElDY25LUzUwY21sdEtDa3NJSEpsWVhOdmJqb2dVM1J5YVc1bktDaDRJQ1ltSUhndWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1FvZ0lDQWdJQ0FnSUM1bWFXeDBaWElvS0hncElEMCtJSGd1ZEdWNGRDazdDaUFnSUNCOUNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3SldFNjU2WTY2R2NJQ292SUgwS0lDQnlaWFIxY200Z1cxMDdDbjBLQ21aMWJtTjBhVzl1SUhKbFlXUkNiMlI1S0hKbGNTa2dld29nSUhKbGRIVnliaUJ1DQpaWGNnVUhKdmJXbHpaU2dvY21WemIyeDJaU2tnUFQ0Z2V3b2dJQ0FnYkdWMElHSnZaSGtnUFNBbkp6c0tJQ0FnSUhKbGNTNXZiaWduWkdGMFlTY3NJQ2hqS1NBOVBpQjdJR0p2WkhrZ0t6MGdZenNnZlNrN0NpQWdJQ0J5WlhFdWIyNG9KMlZ1WkNjc0lDZ3BJRDArSUhzS0lDQWdJQ0FnZEhKNUlIc2djbVZ6YjJ4MlpTaEtVMDlPTG5CaGNuTmxLR0p2WkhrcEtUc2dmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVnpiMngyWlNoN2ZTazdJSDBLSUNBZ0lIMHBPd29nSUgwcE93cDlDZ3BqYjI1emRDQkRUMUpUWDBoRlFVUkZVbE1nUFNCN0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFU5eWFXZHBiaWM2SUNjcUp5d0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFRXVjBhRzlrY3ljNklDZEhSVlFzSUZCUFUxUXNJRTlRVkVsUFRsTW5MQW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MUlaV0ZrWlhKekp6b2dKME52Ym5SbGJuUXRWSGx3WlNjc0NuMDdDbVoxYm1OMGFXOXVJR3B6YjI0bw0KY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXdvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzS0lDQnlaWE11Wlc1a0tFcFRUMDR1YzNSeWFXNW5hV1o1S0c5aWFpa3BPd3A5Q2dwamIyNXpkQ0J6WlhKMlpYSWdQU0JvZEhSd0xtTnlaV0YwWlZObGNuWmxjaWhoYzNsdVl5QW9jbVZ4TENCeVpYTXBJRDArSUhzS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMDlRVkVsUFRsTW5LU0I3SUhKbGN5NTNjbWwwWlVobFlXUW9NakEwTENCRFQxSlRYMGhGUVVSRlVsTXBPeUJ5WlhSMWNtNGdjbVZ6TG1WdVpDZ3BPeUI5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZEhSVlFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YUdWaGJIUm9KeWtnZXdvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXkNCk1EQXNJSHNLSUNBZ0lDQWdiMnM2SUhSeWRXVXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY3NJRzF2WkdWc09pQmpkWEp5Wlc1MFRXOWtaV3dzSUcxdlpHVnNjem9nUVV4TVQxZEZSRjlOVDBSRlRGTXNJR1Y0WVcxd2JHVnpPaUJGV0VGTlVFeEZVeTVzWlc1bmRHZ3NJSEpsWVdSNU9pQjNZWEp0WldSVmNDd0tJQ0FnSUNBZ2NISnZZbXhsYlRvZ1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBblkyeGhkV1JsTFcxcGMzTnBibWNuSUQ4Z0oyTnNZWFZrWlMxdGFYTnphVzVuSnlBNklHNTFiR3dzQ2lBZ0lDQWdJSE5sY25abFpEb2djM1JoZEhNdWMyVnlkbVZrTENCc1lYTjBRWFE2SUhOMFlYUnpMbXhoYzNSQmRDd2diR0Z6ZEZSbGVIUTZJSE4wWVhSekxteGhjM1JVWlhoMExDQnNZWE4wVTJWak9pQnpkR0YwY3k1c1lYTjBVMlZqTEFvZ0lDQWdmU2s3Q2lBZ2ZRb2dJQzh2SU8yVWpPdWZyT3EzdU95ZHVDRHNpNnpzbnFYcnNKWHJqNWtnNG9DVUlPdUJpdXE0c091cHRDRHNuSVFnNnJDUTdJdWNJTzJEZ095ZHRPdW91T3F3DQpnQ0RyaTZUcnBxenJwYndnNjRHSTY0dWtDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMmhsWVhKMFltVmhkQ2NwSUhzS0lDQWdJR3hoYzNSQ1pXRjBJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUgwS0lDQXZMeURzbnBEcXVMQWc3S0tGNjZPTUlPS0FsQ0R0Z2JUcm9aenJrNXpyaTZUcnBxd3Q2NEdFNnJpd0xtSmhkT3lkdENEdG1ManN0cHp0bFp6cmk2UWdLT3Vobk95N3JPeVhrT3lFbk91bmpDRHNvSkhxdDd3ZzZyQ0E2NHFsN1pXWTY0dUlJT3lWaU95Z2hDa0tJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjMmgxZEdSdmQyNG5LU0I3Q2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lpaGV1ag0KakNEc21wVHNzcTBnNjdDYjdKMk1JT0tBbENEcmk2VHJwcXpycGJ3ZzY0R1Y2NHVJNjR1a0xpY3BPd29nSUNBZ2EybHNiRkJ5YjJNb0tUc0tJQ0FnSUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBMQ0F5TURBcE93b2dJQ0FnY21WMGRYSnVPd29nSUgwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0p5a2dld29nSUNBZ1kyOXVjM1FnZXlCMFpYaDBMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmc3RwVHNzcHpyc0p2c25ZUWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc0tJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3dvZ0lDQWcNClkyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3kybE95eW5DRHNtcFRzc3EwNkp5d2dVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURVd0tTNXlaWEJzWVdObEtDOWNiaTluTENBbklDY3BJQ3NnSitLQXBpY3NJRzF2WkdWc0lEOGdKeWpycXFqcmpiZzZJQ2NnS3lCdGIyUmxiQ0FySUNjcEp5QTZJQ2NuS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSEpoZHlBOUlHRjNZV2wwSUdGemEwTnNZWFZrWlNoVGRISnBibWNvZEdWNGRDa3VkSEpwYlNncExDQnRiMlJsYkNrN0NpQWdJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ2NHRnljMlZUZFdkblpYTjBhVzl1Y3loeVlYY3BPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvS1NCN0NpQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNDQpqT3lMc1NEc2k2VHRqS2dnS0NjZ0t5QnpaV01nS3lBbmN5azZKeXdnVTNSeWFXNW5LSEpoZHlrdWMyeHBZMlVvTUN3Z01qQXdLU2s3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lIc2daWEp5YjNJNklDZnRnYlRyb1p6cms1d2c3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdLQ2M3SldJSUNjZ0t5QnpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dLeUFuNnJDY0lDZ25JQ3NnYzJWaklDc2dKM01wSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbk5sY25abFpDc3JPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dNekFwT3dvZ0lDQWdJQ0J6ZEdGMA0KY3k1c1lYTjBVMlZqSUQwZ2MyVmpPd29nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCemRXZG5aWE4wYVc5dWN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93b2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5JQ3NnWlM1dFpYTnpZV2RsSUgwcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlEcnNvanNsNjBnNG9DVUlPMlZuT3ExcmV5V3RDRGlocFFnN0ppQjdKYTBJT3lla091UG1TQW83TGFVN0xLYzZyTzhJT3F3bWV5ZGdDRHNoTGpzaFpnZzdJS3M3SnFwS1FvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5MGNtRnVjMnhoZEdVbktTQjdDaUFnSUNCamIyNXoNCmRDQjdJSFJsZUhRc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ2FXWWdLQ0YwWlhoMElIeDhJQ0ZUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd01Dd2dleUJsY25KdmNqb2dKK3V5aU95WHJlMlZvQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY3S0k3SmV0SU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnlrN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCamIyNXpkQ0J5WVhjZ1BTQmhkMkZwZENCaGMydFVjbUZ1YzJ4aGRHVW9VM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU3dnYlc5a1pXd3BPd29nSUNBZ0lDQmpiMjV6ZENCdmRYUWdQU0J3DQpZWEp6WlZSeVlXNXpiR0YwWlNoeVlYY3BPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0R0akl6c2k3RWc3SXVrN1l5b0lDZ25JQ3NnYzJWaklDc2dKM01wT2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJREl3TUNrcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzblpIcmk3WHNuWVFnN1pXMDdJU2Q3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdKbUU2Nk9NSUNnbklDc2djMlZqSUNzZ0ozTXNJQ2NnS3lBb2IzVjBMbVJwY21WamRHbHZiaUI4ZkNBbg0KUHljcElDc2dKeWtuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWgwWlhoMEtTNXpiR2xqWlNnd0xDQXpNQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lIUnlZVzV6YkdGMFpXUTZJRzkxZEM1MGNtRnVjMnhoZEdWa0xDQmthWEpsWTNScGIyNDZJRzkxZEM1a2FYSmxZM1JwYjI0c0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjZ2ZTazdDaUFnSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryc29qc2w2MGc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnkNCmNtOXlPaUFuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzaTZUdGpLZzZJQ2NnS3lCbExtMWxjM05oWjJVZ2ZTazdDaUFnSUNCOUNpQWdmUW9nSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBMExDQjdJR1Z5Y205eU9pQW5UbTkwSUdadmRXNWtKeUI5S1RzS2ZTazdDZ292THlEc25iVHJyN2dnNjR1azY2YXM2ckNBSU91V29DRHNub2pyaXBUcmpiQWc2NWlRSU95OG5PcTRzT3F3Z0NEcms2VHNsclRzbUtUcnFiUW83S0NjN0lxazdMS1lJT3lla091UG1TRHN2SnpxdUxBZzdLU1I2N08xSU91VHNTa2c3S0d3N0pxcDdaNklJT3lpaGV1ampDRGlnSlFnNjQrTTY0MllJT3VMcE91bXJPdUtsQ0RxdDdqcmpJRHJvWndnN0p5ZzdLZUFDbk5sY25abGNpNXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdld29nSUdsbUlDaGxJQ1ltSUdVdVkyOWtaU0E5UFQwZ0owVkJSRVJTU1U1VlUwVW5LU0I3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0oyMDY2KzRJT3k4bk95Z3VDRHNub2pzbHJUc21wUW83WStzDQo3WXE0SUNjZ0t5QlFUMUpVSUNzZ0p5RHNncXpzbXFrZzdLU1JLU0RpZ0pRZzdKMjBJT3lkdU95S3BPMkV0T3lLcE91S2xDRHNvb1hybzR6dGxhbnJpNGpyaTZRdUp5azdDaUFnSUNCd2NtOWpaWE56TG1WNGFYUW9NQ2s3Q2lBZ2ZRb2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2hKenJzb1FnN0ppazY2V1lPaWNzSUdVZ0ppWWdaUzV0WlhOellXZGxLVHNLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3Q24wcE93b3ZMeURzbHJUcmxxUWc2cks5NjZHYzY2R2NJT3lqdmV1VG9DanNpNnpzbnFYcnNKWHJqNWtnNjRHSzZybUFMQ0JEZEhKc0swTXNJQzl6YUhWMFpHOTNiaXdnN0ppazY2V1lLU0JqYkdGMVpHVWc3SjZRN0l1ZDdKMkVJT3VDcU9xNHNPeW5nQ0RzbFlycmlwVHJpNlFLY0hKdlkyVnpjeTV2YmlnblpYaHBkQ2NzSUNncElEMCtJR3RwYkd4UWNtOWpLQ2twT3dwd2NtOWpaWE56TG05dUtDZFRTVWRKVGxRbkxDQW9LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2twT3dwd2NtOWpaWE56TG05dQ0KS0NkVFNVZFVSVkpOSnl3Z0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBLVHNLQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc0tJQ0JqYjI1emIyeGxMbXh2WnlnbjRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FKeWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeUR0Z2JUcm9aenJrNXdnNjR1azY2YXNJT3k4bk95bmtDRGlnSlFnYUhSMGNEb3ZMMnh2WTJGc2FHOXpkRG9uSUNzZ1VFOVNWQ2s3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeURycXFqcmpiZzZJQ2NnS3lCRFRFRlZSRVZmVFU5RVJVd2dLeUFuSU1LM0lPeVlpT3lMbkNBbklDc2dSVmhCVFZCTVJWTXViR1Z1WjNSb0lDc2cNCkorcXh0Q0RzbnFYc3NLa25LVHNLSUNCamIyNXpiMnhsTG14dlp5Z25JT3lkdENEc3NMM3NuWVFnN0x5YzY1R1VJT3VQbWV5VmlDRHRsTHpxdDdqcnA0Z2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPMkJ0T3Vobk91VG5PdWhuQ0RzdHBUc3NwenRsYW5yaTRqcmk2UXVKeWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KK0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0NjcE93b2dJR05vWldOclEyeGhkV1JsUVhaaGFXeGhZbXhsS0NrN0lDOHZJRU5zWVhWa1pTQkRiMlJsSU95Q3JPeWFxU0Rxc0lEcmlxVWc3SmVzNjdhQUlPeWdrT3F5Z0NBbzdaU002NStzNnJlNDdKMjRJT3lWaU91Q3RPeWFxU2tLSUNBdkx5RHJyN2pycHF3ZzdJdWM2NCtaDQpJQ3NnN0tlQTdJdWM2Nnk0SU95anZPeWVoU0RpZ0pRZzdMS3JJT3kybE95eW5PdTJnTzJFc0NEcnVhRHJwYlRxc293S0lDQmhjMnREYkdGMVpHVW9KK3liak91d2pleVhoVG9nSXV5Z2dPeWVwU0Rya0pqc2w0anNpclhyaTRqcmk2UWlKeWt1ZEdobGJpZ0tJQ0FnSUNncElEMCtJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc200enJzSTNzbDRVZzdKbUU2Nk9NSU9LQWxDRHN0cFRzc3B3ZzdLU0E2N21FSU91Qm5TNG5LU3dLSUNBZ0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SnVNNjdDTjdKZUZJT3lMcE8yTXFDQW83TEtySU95YWxPeXlyU0RybFl3ZzdKNnM3SXVjNjQrRUtUb25MQ0JsTG0xbGMzTmhaMlVwQ2lBZ0tUc0tmU2s3Q2c9PQ0KOjpFWEFNUExFUzo6DQpJeURyckxqcXRhd2c3TGFVN0xLY0lPeVlpT3lMbkFvS0l1dXN1T3ExckNEc3RwVHNzcHpyc0p2cXVMQWk2ckNBSU95Q3JPeWFxZTJWbU91S2xDRHNtSWpzaTV3ZzY2cW83SjJNN0o2RjY0dUk2NHVrTGlBcUt1eWR0Q0R0akl6c25ienNuWVFnN0lpWTdLQ1Y3WldjSU91U3BDRHRoTERycjdqcmhKRHNsNURzaEp3Z1lHNXdiU0J5ZFc0Z1luVnBiR1JnNjZXOElPeUxwTzJXaWUyVm1PcXpvQ3dnUm1sbmJXSHNsNURzaEp3ZzdaU002NStzNnJlNDdKMjQ3SjJFSU91THBPeUxuQ0RzaTZUdGxvbnRsWmpycWJRZzY3Q1k3SmlCNjVDcDY0dUk2NHVrTGlvcUNnb2pJeURzbnBIc2hMRWc2N0NwNjdLVkNnb3RJT3lZaU95TG5DRHRsWmpyZ3BqcmlwUWdLaXBnSXlNaklPeWJrT3V6dUdBcUtpRHRsWndnN0tTRTZyTzhMQ0RxdDdnZzdKV0U2NTZZSUNvcVlDMGc3TGFVN0xLYzdKV0lZQ29xSU95WHJPdWZyQ0Rxc0p6cm9ad2c3SjIwNjZTRTdLZVI2NHVJNjR1a0xnb3RJT3kybE95eW5PeVZpQ0RzbFlqc2w1RHNoSndnS2lycw0KcElUc25ZUWc2N0NVNnI2NDZyT2dJT3lMdHV5Y3ZPdXB0Q0JnSUM4Z1lDQW83SldlNjVLa0lPcXp0ZXV3c1NEdGo2enRsYWdnN0lxczY1Nlk3SXVjS1NvcUlPdWhuQ0R0a1p6c2k1enRsWmpzaExqc21wUXVJTzJVak91ZnJPcTN1T3lkdU95WGtPeUVuQ0Rya1pBZzdLU0U2NkdjSU91enRPeVhyT3lua2V1TGlPdUxwQzRLTFNEc2dxenNtcW5zbnBEcXNJQWc3SjZGNjZDbDdaV2NJT3VzdU9xMXJPcXdnQ0JnN0p1UTY3TzRZT3F6dkNBbzZyTzE2N0N4d3JmcnJManNucVhydG9EdG1MZ2c2NnkwN0l1YzdaV1k2ck9nS1NEcXNKbnFzYkRyZ3Bnc0lPeUVuT3VobkNEdGo2enRsYWp0bFpqcnFiUWc2cmU0SU95MmxPeXluT3lWaU91VHBPeWRoQ0RyczdUc2w2enNwSTNyaTRqcmk2UXVDaTBnNjZlazdMbXQ3WldnSU91VmpDQXFLdXVuaU95S3BPMkN1ZXVRbkNEc25iVHJwb1FvN1ptTlhDcnJqNWtwTENEc2lLdnNucEFvN0tDRTdabVU2N0tJN1ppNHdyY2k3Sm00SURMcnFvVWlJT3VUc1NucmlwUWc2NnkwN0l1Y0tpcnQNCmxhbnJpNGpyaTZRZzRvQ1VJT3lkdE91bWhNSzM3SWlZNjUrSndyZnJzb2p0bUxqcnA0d2c2NHVrNjZXNElPdXN1T3Exck91UGhDRHFzSm5zbllBZzdKaUk3SXVjNjZHY0lPeWVvZTJZZ095YWxDNGc2NHVvTENEc3RwVHNzcHpzbFlqc2w1QWc3S0NCN0phMDY1R1VJT3lkdE91bWhNSzM3SWlyN0o2UTY0cVVJT3EzdU91TWdPdWhuQ0RyZ3Bqc21LVHJpNGdnN0l1azdLQ2NJT3F3a3V5WGtDRHJwNTdxc293ZzZyT2c3TE9RSU95VHNPeUV1T3lhbEM0S0xTRHNvSnpycXFrb1lDTWpZQ25xczd3Z1lDTWpJMkFzSUdBdFlDRHF1TER0bUxqcmlwUWc3WmlWN0l1ZDdKMjA2NHVJSU91d2xPcSt1T3luZ0NEcnA0anNoTGpzbXBRdUNnb2pJeURzaXFUdGc0RHNuYndnN0p1UTdMbVpJQ2pzc0xqcXM2QWc0b0NVSU95ZWtPeUV1TzJWbkNEcmdyVHNtcW5zbllBZ2RYZ3RkM0pwZEdsdVp5NXRaQ0Rxc0lEc25iVHJrNXdwQ2dvdElPMlZ0T3lhbE95eXRDd2c2N2FBNjVPYzY1K3M3SnEwSU95aWhlcXlzQ2hnZnV5ZWlPeVd0T3lhDQpsR0FnWUg3cmo3enNtcFJnSUdCKzdKZUc3SmEwN0pxVVlDQmdmdTJWdENEc283enNoTGpzbXBSZ0tRb3RJRExyaTZnZzZyV3M3S0d3T2lBcUt1eXlxeURzcElROTdJT0I3Wm1wSU95RXBPdXFoU0RpaHBJZzY1R1k3S2U0SU95a2hEM3JpNlRzbll3ZzdaYUo2NCtaS2lvbzZyS3c3S0NWN0oyQUlHQis3WldnNnJtTTdKcVVQMkFzSU8yV2lldVBtU0RzbktEcmo0VHJpcFFnWUg3dGxiUWc3S084N0lTNDdKcVVZQ2tLTFNEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0tPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ2tzSU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBbzdKZUc3SmEwN0pxVTRvYVNmdTJWbU91cHRDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDa0tMU0RzdXBEc283enNscnp0bFp3ZzZySzk3SmEwS0g3c2k1enFzcURzbHJUc21wUS80b2FTZnUyVm9PcTVqT3lhbEQ4cExDRHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNDanNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2M0b2FTN0o2VQ0KN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrS0xTRHFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NBbzdLQ0U3SWFoNG9hUzY3TzA2NEswNjR1a0tTd2c2N2FBN0tDVklPeURnZTJacWV1UGhDRHJsTEhybExIdGxaanNwNEFnN0pXSzZyS01LQ0xzc0w3cXVMQWc3SXVrN1l5b0l1S2RqQ0FpN0xDKzdKMkVJT3lJbUNEc2w0YnNsclRzbXBRaTRweUZLUW9LSXlNZzdMYVU3TEtjSU95WWlPeUxuQW9LSXlNaklPeW5oTzJXaWUyVm1PdU5tQ0RzbnBIc2w0WHNuYlFnN0o2STdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3S2VFN1phSklPeWtrZXlkdUNEcmdyVHNsNjNzbmJRZzdKNkk3SmEwN0pxVUxpQXZJT3lkdE95V3RPeUVuQ0RzcDRUdGxvbnRsYURxdVl6c21wUS9DZ29qSXlNZzZyTzE3SnlnSU95YWxPeXlyZXlkaENEc3Q2anNob3p0bFpqcnFiUWc3SnFVN0xLdElPdUN0T3lYcmV5ZHRDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTNxT3lHak8yVm1PeUwNCm5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc3Q2anNob3p0bGFBZzZySzk3SnF3SU95YWxPeXlyU0RyZ3JUc2w2M3JqNFFnN0lLdDdLQ2M2NCs4N0pxVUxpQXZJT3F6dGV5Y29DRHNtcFRzc3Ezc25ZUWc3TGVvN0lhTTdaV2c2cm1NN0pxVVB3b0tJeU1qSU9xNHNPcTRzT3VsdkNEc3NMN3NwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WldZN0lTNDdKcVVMZ290SU9xNHNPcTRzT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlXdE95YWxDNGdMeUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXWTZyaXdJT3lnaE95WGtPdUtsQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxBb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0tlQTZyaUlJT3V5DQpoT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwSU95anZPeUV1T3lhbEM0Z0x5RHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2lNakl5RHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4S0xTRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhLTFNEc2k2RHFzNkFnN0oyMDdKeWc2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0o2VQ0KN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDaTBnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxnb0tJeU1qSU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c3Sm00SURMcnFvWHNsNURxc293ZzZyYU03WldjSU95Q3JleWduQ0RzbFl6cnByenRocUhzbllRZzdLQ0U3SWFoN1pXZzZybU03SnFVUHdvdElPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdE91Z3BPcXpvQ0R0bGJUc21wUXVJQzhnN1ptTkt1dVBtU2d3TVRBdE1USXpOQzAxTmpjNEtTRHJpNWdnN0ptNElETHJxb1hzbDVEcXNvd2c2N08wNjRLODZybU03SnFVUHdvdElPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnNjR1WUlPeVp1Q0F5NjZxRjdKZVE2cktNSU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN2T3E1ak95YWxEOEtMU0RxdG96dGxad2cNCjdJS3Q3S0NjSU95VmpPdW12TzJHb2V5ZGhDRHRtWTBxNjQrWktEQXhNQzB4TWpNMExUVTJOemdwSU91TG1DRHNtYmdnTXV1cWhleVhrT3F5akNEcnM3VHJncnpxdVl6c21wUS9DZ29qSXlNaklPMlpsZXlkdU1LMzZyS3c3S0NWSU8yTW5leVhoUW9LSXlNaklPeWdsZXVua0NEc2dxM3NvSnp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95Q3JleWduT3VRbkNEcmpiRHNuYlR0aExEcmlwUWc2N08xNnJXczdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEcmtKanJqNHpycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc29KWHJwNUFnN0lLdDdLQ2M3WldnNnJtTTdKcVVQd29LSXlNaklPdXpnT3F5dmV5Q3JPMlZyZXlkdENEc29JRHNucVhya0pqc3A0QWc3SldLN0pXWTdJcTE2NHVJNjR1a0xpRHJncGpxc0lEc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKV0U3S2VCSU95Z2dPeWVwZTJWbU95bmdDRHNsWXJzbllBZzY0SzA3SnFwN0oyMElPeWVpT3lXDQp0T3lhbEM0Z0x5RHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4S0NpTWpJeURyb1p6cXQ3anNsWVRzbTRNZzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3Vobk9xM3VPeVZoT3liZysyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbGJIc25ZUWc3S0tGNjZPTTdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3lWc2V5ZGhDRHNvb1hybzR6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nN1pXY0lPdXlpQ0RyczREcXNyM3RsWmpycWJRZzY0dWs3SXVjSU91emdPcXl2ZTJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzY0dWs3SXVjSU91d2xPcS9nQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6aE95R2plMlZvT3E1ak95YWxEOEtDaU1qSXlEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpya0tucmk0anJpNlF1SU95MGlPcTRzTzJabE8yVg0KbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpyajd6c21wUXVJQzhnN0xTSTZyaXc3Wm1VN1pXZzZybU03SnFVUHdvS0l5TWpJeURzbDVEcm42ekN0K3lMcE8yTXFBb0tJeU1qSU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU91RXBPMkt1T3liak8yQnJPeVhrQ0RzbDdEcXNyRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzbDdEcXNyQWc3SU9CN1lPYzY2VzhJTzJabGV5ZHVPMlZtT3F6b0NEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPdXduT3lEbmUyV2lPeUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNuYnpzaTV6c29JSHMNCm5iZ2c3SmlrNjZXWTZyQ0FJT3lEbmVxeXZPeVd0T3lhbEM0Z0x5RHNucURzaTV3ZzdadUVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZoT3lkdE91VWxDRHJtSkRyaXBRZzY3bUU2N0NBNjdLSTdaaTQ2ckNBSU95ZHZPeTVtTzJWbU95bmdDRHNsWXJzaXJYcmk0anJpNlF1Q2kwZzdKV0U3SjIwNjVTVUlPdVlrT3VLbENEcnVZVHJzSURyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwM3Jzb2p0bUxqcXNJQWc3SjI4N0xtWTdaV1k3S2VBSU95Vml1eUt0ZXVMaU91THBDNEtMU0RzbmJqc3BwM3Jzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeTBpT3F6dk91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0oyNDdLYWQ2N0tJDQo3Wmk0NjZXOElPeWVyT3V3bk95R29lMlZtT3lMcmV5TG5PeVlwQzRLTFNEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95bmdPdUNyT3lXdE95YWxDNGdMeURzbmJqc3BwM3Jzb2p0bUxqcnBid2c2NHVrN0l1Y0lPdXdtK3lWaENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzbHJUc21wUXVJQzhnNjR1azY2VzRJT3F5Z095RGlleVd0T3VobkNEcmk2VHNpNXdnN0xDKzdKV0U2N08wN0lTNDdKcVVMZ29LSXlNaklPeWdsZXV6dE91bHZDRHJ0b2pybjZ6c21LVHNwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNvSlhyczdUcnBid2c2N2FJNjUrczdKaXNJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHRqSXpzbmJ3Zw0KN0plRjY2R2M2NU9jN0plUUlPeUxwTzJNcU8yV2lPeUt0ZXVMaU91THBDNEtMU0R0akl6c25ienNuWVFnN0ppczY2YXM3S2VBSU91cXUrMldpT3lXdE95YWxDNGdMeURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3S0NRNnJLQUlPeWtrZXllaGV1TGlPdUxwQzRnN0oyMDdKcXA3SmVRSU91MmlPMk91T3lkaENEcms1enJvS1FnN0tPRTdJYWg3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEc2hKenJ1WVRzaXFUcnBid2c3S0NRNnJLQTdaV1k2ck9nSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSkRxc29Ec25iUWc2NEdkNjRLWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bFlUc2lKZ2c3SjZGNjZDbElPMlZyZXVxcWV5ZWhldUxpT3VMcEM0S0xTRHF2SzBnN0o2RjY2Q2w3WlcwN0pXOElPMlZtT3VLbENEdGxhM3JxcW5zbmJUc2w1RHNtcFF1Q2dvakl5TWpJT3Eyak8yVm5NSzM3SVNrN0tDVkNnb2oNCkl5TWc3TG0wNjZtVTY1MjhJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0lxMTY0dUk2NHVrTGlEc2hLVHNvSlhzbDVEc2hKd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc3ViVHJxWlRybmJ3ZzZyYU03WldjN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3TG0wNjZtVTY1MjhJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWak91bXZDRHF0b3p0bFp6c25iUWc2ckd3NjdhQTY1Q1k3SmEwSU95VmpPdW12T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEc2xZenJwcndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU91cHRDRHNob3pzaTUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdJU2s3S0NWN0plUTdJU2NJT3lWak91bXZPeWRoQ0Rzdkp3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Y2hPeTVtQ0Rzb0pYcnM3UWc3SjIwN0pxcDdKZVFJT3VQDQptZXlkbU8yVm1PeW5nQ0RzbFlyc2xZUWc3SjI4NjdhQUlPcTRzT3VLcGV5ZHRDRHNvSnp0bFp6cmtLbnJpNGpyaTZRdUNpMGc3SnlFN0xtWUlPeWdsZXV6dE91bHZDRHRsNGpzbXFudGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3SnlFN0xtWUlPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHNtWVRybzR6Q3QreW5oTzJXaVFvS0l5TWpJT3lnZ095ZXBldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNvSURzbnFYdGxvanNsclRzbXBRdUNnb2pJeU1nNjdPQTZySzk3SUtzN1pXdDdKMjBJT3lnZ2V5YXFldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzNERxc3IwZzY0SzA3SnFwN0oyRUlPeWdnZXlhcWUyV2lPeVd0T3lhbEM0S0NpTWpJeURzb0lUc2hxSHNuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dE91RGlPeVd0T3lhbEM0S0NpTWpJeURyazdIcg0Kb1ozc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdVRzZXVobmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWc3SUt0N0tDYzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeUNyZXlnbk8yV2lPeVd0T3lhbEM0S0NpTWpJeUR0Z2JUcnByM3JzN1RyazV6c2w1QWc2N08xN0lLczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0ZXlDck8yV2lPeVd0T3lhbEM0S0NpTWpJeURzbXBUc3NxM3NuWVFnN0xLWTY2YXNJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKcVU3TEt0N0oyRUlPeXltT3Vtck8yVm1PcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPeVZpT3VDdE1LMzdKeWc2NCtFQ2dvakl5TWc3SU9JNjZHYzdKcTBJT3V5aE95Z2hPeWR0Q0RzdHB6c2k1enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlPeVhoZXVOc095ZHRPMksNCnVDRHRtNFFnN0oyMDdKcXBJT3F3Z091S3BlMlZxZXVMaU91THBDNEtMU0RzZzRnZzY3S0U3S0NFN0oyMElPdUNtT3labE95V3RPeWFsQzRnTHlEc2w0WHJqYkRzbmJUdGlyanRsWmpycWJRZzdJT0lJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3SjIwN0pxcDdKMkVJT3ljaE8yVnRDRHNsYjNxdElBZzY0K1o3SjJZNnJDQUlPMlZoT3lhbE8yVnFldUxpT3VMcEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNpNXpzbnBIdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbnFYc2k1enFzSVFnNjYrNDdJS3M3SnFwN0p5ODY2R2NJT3lla091UG1TRHJvWnpxdDdqc2xZVHNtNE1nNjVDWTdKZUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPeVlwT3VlcSt1UG1leVZpQ0RzZ3F6c21xbnRsWmpzcDRBZzdKV0s3SldFSU91aG5PcTN1T3lWDQpoT3liZyt1UWtPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1RzbFlqc25ZUWc3SnlFN1pXMElPdTVoT3V3Z091eWlPMll1T3VsdkNEcnM0RHFzcjN0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEc2xZanNvSVR0bFp3ZzdJS3M3SnFwN0oyRUlPeWNoTzJWdENEcnVZVHJzSURyc29qdG1ManJwYndnNjdDVTZyK1VJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc2N08wN0pXSUlPeUVuT3U1aE95S3BBb0tJeU1qSU9xeXZldTVoT3VsdkNEcXNKenNpNXp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzZySzk2N21FNjZXOElPeUxuT3lla2UyVm9PcTVqT3lhbEQ4S0NpTWpJeURxc3IzcnVZVHJwYndnN1pXMDdLQ2M3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU9xeXZldTVoT3VsdkNEdGxiVHNvSnp0bGFEcXVZenNtcFEvQ2dvakl5TWc2cml3NnJpdzZyQ0FJT3lZcE8yVWhPdWR2T3lkdUNEc2c0SHRnNXpzbm9Ycg0KaTRqcmk2UXVJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbllRZzdabVY3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3E0c09xNHNPcXdnQ0RyaEtUdGlyanNtNHp0Z2F6c2w1QWc3SmV3NnJLdzY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJpdzZyaXc3SjJZSU95WHNPcXlzQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbUlIc2c0SHNuWVFnNjdhSTY1K3M3SmlrNjRxVUlPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0ppQjdJT0I3SjJFSU91MmlPdWZyT3lZcE9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3kzcU95R2pPMlZtT3lMcENEcXNyM3NtckFnN0l1ZzdMS3Q3WldZN0l1Z0lPdUMNCnRPeWFxZXlkZ0NEc29JRHNucVhya0pqc3A0QWc3SldLN0lxMTY0dUk2NHVrTGdvdElPeTNxT3lHak8yVm1PdXB0Q0RzaTZEc3NxM3RsWndnNjRLMDdKcXA3SjIwSU95Z2dPeWVwZXVRbU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9DaTBnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9JQzhnN0xlbzdJYU03WldZNjZtMElPeWVoZXVncGUyVm5DRHJnclRzbXFuc25iUWc3SUtzNjUyODdLQzQ3SnFVTGdvS0l5TWpJeURxc0lEc25iVHJrNXdnN0ppSTdJdWNJQ2gxZUMxM2NtbDBhVzVuTG0xazdKZVE3SVNjSU95WXJ1cTVnQ0RpZ0pRZzZyZWM3TG1aN0p5ODY2R2NJT3lla091UG1lMlpsQ0RycXJzZzdaV1k2NHFVSU91c3VPeWVwU0RzbnF6cXRhenNoTEVnN0lLczY2R0FLUW9LSXlNaklPeWVrT3VQbWV5d3FPdWx2Q0Rxc0lEc3A0RHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB3b3RJT3lla091UG1leXdxT3F3DQpnQ0Rzbm9qcmdwanNtcFEvQ2dvakl5TWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdWx2Q0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTTY0cVVJT3lXdk91bmlPeWR1T3F3Z095YWxEOEtDaU1qSXlEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvY2c2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1Q2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUhJT3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsWmpzaTV6cXNxRHNsclRzbXBRL0NpMGc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOEtDaU1qSXlEc2k1enNucEh0bFpqc2k1enJpcFFnNjdhRTdKZVE2cktNSURVc01EQXc3SnVRN0oyRUlPdVRuT3VncE95YWxDNEtMU0RzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEcw0KbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUxnb3RJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFF1Q2dvakl5TWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVMZ290SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQzRLQ2lNakl5RHF1SWpzbmJ6cXVZenNwNEFnNjYrNDY0S3BJT3lMbkNEc2w3RHNzclFnN0xLWTY2YXM2NUNwNjR1STY0dWtMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUNxZXUyZ08yVm1PeUxuT3E0c0NEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUF2SU8yYmhPdTJpT3F5c095Z25DRHF1SWpzbGFIc25ZUWc2NEswN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lna09xeWdDRHF1TERxc0lUc2w1RHJpcFFnN0lTYzY3bUUNCjdJcWtJT3lkdE95YXFleWR0Q0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95TG9PdTJoT3ltblNEdG1aWHNuYmdnN0tDRTdKZVE2NHFVSU95R29lcTRpQ0Ryc0k4ZzZyS3c3S0NjNnJDQUlPdTJpT3F3Z08yVnFldUxpT3VMcEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU91emdPcXl2U0RzaTV3ZzdMcVE3SXVjNjdDeElPeWVyT3luZ09xNGlleWRnQ0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtDaU1qSXlEc2c0SHJpN1FnN1pLSTdLZUlJTzJXcGV5RGdleWRoQ0RzDQpuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkdENEcmhibnNuWXpya0tucmk0anJpNlF1Q2kwZzY0MlVJT3lpaSt5ZGdDRHNnNEhyaTdUc25ZUWc3SnlFN1pXMElPMkd0ZTJabENEcmdyVHNtcW5zbllBZzY0VzU3SjJNNjQrODdKcVVMZ29LSXlNaklPcXpvT3F3bmV1TG1PeWRtQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkZ0NEcXVMRHJvWjBnNnJTQTY2YXM2NUNwNjR1STY0dWtMZ290SU95ZHRPeWduT3UyZ08yRXNDRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWR0Q0RxdUxEcm9aM3JqN3pzbXBRdUNnb2pJeU1nN0xLdDdJYU02NFdFN0oyQUlPeUVuT3U1aE95S3BDRHFzSURzbm9Yc25iUWc2N2FJNnJDQTdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YQ0KbEM0S0NpTWpJeU1nNnJPRTdLQ1Z3cmZzbm9Ycm9LVUtDaU1qSXlEc2xZVHNuYlRybEpRZzY1aVE2NHFVSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWR0T3lEZ1NEc25wanJxcnNnN0o2RjY2Q2w3WldZN0plc0lPcXpoT3lnbGV5ZHRDRHNucURxdUlnZzdMS1k2NmFzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWVtT3VxdXlEc25vWHJvS1h0bGJUc2hKd2c2ck9FN0tDVjdKMjBJT3llb09xeXZPeVd0T3lhbEM0Z0x5RHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzdKNnM3SVNrN0tDVjdaV1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25iVHJyN2dnN0lLczdKcXBJT3lra2V5ZHVDRHNsWVRzbmJUcmxKVHNub1hyaTRqcmk2UXVDaTBnN0oyMDY2KzRJT3lUc09xem9DRHNub2pyaXBRZzdKV0U3SjIwNjVTVTdKaUk3SnFVTGlBdklPdUxwT3VsdUNEc2xZVHNuYlRybEpUcnBid2c3SjZGNjZDbDdaVzANCklPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2dxenNtcW50bGFBZzdJaVlJT3lYaHV1S2xDRHJ1WVRyc0lEcnNvanRtTGpzbm9Ycmk0anJpNlF1SU95WWdldXN1Q3dnN0lpcjdKNlFMQ0R0aXJuc2lKanJyTGpzbnBEcnBid2c3WStzN1pXbzdaV1k3SmVzSURqc25wQWc3SjIwN0lPQklPeWVoZXVncGUyVm1PeUxyZXlMbk95WXBDNEtMU0RzbUlIcnJMZ3NJT3lJcSt5ZWtDd2c3WXE1N0lpWTY2eTQ3SjZRNjZXOElPMlByTzJWcU8yVnRDQTQ3SjZRSU95ZHRPeURnU0Rzbm9Ycm9LWHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3llaGV1Z3BTRHFzSURyaXFYdGxad2c2cmlBN0o2UUlPeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnN0o2RjY2Q2w3WldnSU95SW1DRHNub2pyaXBRZzZyaUE3SjZRSU95SW1PdWx2Q0RyaEpqc2w0anNsclRzbXBRdUlDOGc2NEswN0pxcDdKMkVJT3loc09xNGlDRHNwSVRzbDZ3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEdGpJenNuYnpDdCtxeXNPeWduTUszDQo2cml3N1lPQUNnb2pJeU1nN1l5TTdKMjhJT3lhcWV1ZmlleWR0Q0RzdElqcXM3enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlERXdUVUlnN0oyMDdaV1k3SjJZSU8yTWpPeWR2T3VuakNEc2w0WHJvWnpyazV3ZzZyQ0E2NHFsN1pXcDY0dUk2NHVrTGdvdElERXdUVUlnN0oyMDdaV1lJTzJNak95ZHZPdW5qQ0RzbUt6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHRqSXpzbmJ3ZzdKcXA2NStKN0oyRUlPMlpsZXlkdU8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0dWs3SnEwNjZHYzY1T2M2ckNBSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyaTZUc21yVHJvWnpyazV6cnBid2c2NmVJN0xPazdKYTA3SnFVTGdvS0l5TWpJT3F5c095Z25PeVhrQ0RzaTZUdGpLanRsWmpzbUlEc2lyWHJpNGpyaTZRdUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEcXNyRHNvSnp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPcXlzT3lnbkNEcw0KaUpqcmk2anNuWVFnN1ptVjdKMjQ3WldZNnJPZ0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WldZN0plc0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xenRlcXdoT3lkaENEdG1aWHJzN1R0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BDRHNwSURydVlRZzdLU1I3SjZGNjR1STY0dWtMZ290SU95a2dPdTVoTzJWbU9xem9DRHNub2pyaXBRZzZyaXc2NHFsN0oyMDdKZVE3SnFVTGlBdklPeWhzT3E0aU91bmpDRHF1TERyaTZUcm9LUWc3S084N0lTNDdKcVVMZ29LSXlNaklPdVRzZXVoblNEcXNJRHJpcVh0bFp3ZzdMV2M2NHlBSU9xd25PeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHMNCmlyWHJpNGpyaTZRdUNpMGc2NDJVSU91VHNldWhuZTJWbU91Z3BPdXB0Q0RxdUxEc29iUWc3Wld0NjZxcDdKMkVJT3lDcmV5Z25PMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3kybE9xd2dDa0tDaU1qSXlEc3RwenJqNWtnN0pxVTdMS3Q3SjIwSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3TGFjNjQrWklPeWFsT3l5cmV5ZGhDRHNvSkhzaUpqdGxvanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cks5NjdtRUlPeURnZTJEbk91bHZDRHRtWlhzbmJqdGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU9xeXZldTVoQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnDQo3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPeWdoTzJabU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPdXdsT3EvZ09xNWpPeWFsRDhLQ2lNakl5RHJzS25yckxnZzdKaUk3Slc5N0oyMElPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnNLbnJyTGdnN0ppSTdKVzk3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEcnVZVHJzSURyc29qdG1MZ2dOZTJhakNEc21LVHJwWmpyb1p3ZzZyT0U3S0NWN0oyMElPeWVvT3E0aUNEc3NwanJwcXpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJRFh0bW93ZzdKNlk2NnE3SU95ZWhldWdwZTJWdE95RW5DRHFzNFRzb0pYc25iUWc3SjZnNnJLODdKYTA3SnFVTGlBdklPdTVoT3V3Z091eWlPMll1T3VsdkNEc25xenNoS1Rzb0pYdGxaanJxYlFnNjR1azdJdWNJT3lkdE95YQ0KcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3SUNqc2w0YnNsclRzbXBRZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUXBDZ29qSXlNZzY3TzQ3SjI0SU95ZHVPeW1uZXlkaENEdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0Ryczdqc25iZ2c3SjI0N0thZDdKMkVJTzJWbU91cHRDRHJxcWpyazZBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95ZHRPdXBsT3lkdkNEc25ianNwcDBnN0tDRTdKZVE2NHFVSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lkdE91cGxPeWR2Q0RzbmJqc3BwM3NuWVFnNjZlSTdMbVk2Nm0wSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3kvb08yUHNPeWRnQ0Ryb1p6cXQ3anMNCm5iZ2c3WnVFN0plUTY2ZU1JT3lDck95YXFTRHFzSURyaXFYdGxhbnJpNGpyaTZRdUNpMGc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeS9vTzJQc095ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnI3anNoTEhyaFlUc25wRHJpcFFnNjdPMDdaaTQ3SjZRSU91UG1leWRtQ0RzbDRic25iUWc2ckt3N0tDYzdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnNjdPMDdaaTQ3SjZRNnJDQUlPdVBtZXlkbU8yVm1PdXB0Q0Rxc3JEc29KenRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxJVHJvWnp0bFlUc25ZUWc2NU94NjZHZDdaV1k3S2VBSU95Vml1eWN2T3VwdENEc25iVHNtcW5zbmJRZzdLQ2M3WldjNjVDcDY0dUk2NHVrTGdvdElPMlVoT3Vobk8yVmhPeWRoQ0RyazdIcm9aM3RsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbGJFZzY3S0U3S0NFN0oyMElPdUNydXlWaENEc25ienJ0b0FnNnJpdzY0cWw3SjIwDQpJT3lnbk8yVm5PdVFxZXVMaU91THBDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXWTY2bTBJT3VxcU91VG9DRHF1TERyaXFYc25ZUWc3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzY3aVU2Nk9vN1lpczdJcWs2ckNBSU9xNnZPeWd1Q0Rzbm9qc2xyUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU91NGxPdWpxTzJJck95S3BPdWx2Q0Rzdkp6cnFiUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU91NWhPeURnU0RzbDdEcm5iM3NzcGpxc0lBZzY1T3g2NkdkNjVDWTdLZUFJT3lWaXV5Vm1PeUt0ZXVMaU91THBDNEtMU0RydVlUc2c0RWc3SmV3NjUyOTdMS1k2Nlc4SU91VHNldWhuZTJWbU91cHRDRHF1TFRxdUludGxhQWc2NVdNSU91NW9PdWx0T3F5akNEc2w3RHJuYjNyazV6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzdHB6c25vVWc3TG0wNjVPYzZyQ0FJT3VUc2V1aA0KbmV1UW1PeW5nQ0RzbFlyc2xZUWc3SUtzN0pxcDdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0xhYzdKNkZJT3k1dE91VG5PdWx2Q0RyazdIcm9aM3RsWmpycWJRZzY3Q1U2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3SUNqc21ZVHJvNHdnN0pXSTY0SzBLUW9LSXlNaklPMmFqT3lia09xd2dPeWVoZXlkdENEc21ZVHJvNHpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNnJDQTdKNkY3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEc21JanNsYjNzbmJRZzdMZW83SWFNNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95WWlPeVZ2ZXlkaENEc3Q2anNob3p0bG9qc2xyVHNtcFF1Q2dvakl5TWc2Nnk0N0oyWTZyQ0FJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdJaWM3TENvN0tDQjdKeTg2NkdjSU91THRldXpnT3VUbk91bXJPcXlvT3lLdGV1TGlPdUxwQzRLTFNEcnJManNuWmpycGJ3ZzdLQ1I3SWlZN1phSTdKYTANCjdKcVVMaUF2SU95SW5PeUVuT3VNZ091aG5DRHJpN1hyczREcms1enJwclRxc296c21wUXVDZ29qSXlNZzdJU2s3S0NWN0oyMElPeTBpT3E0c08yWmxPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNoS1Rzb0pYc25ZUWc3TFNJNnJpdzdabVU3WmFJN0phMDdKcVVMZ29LSXlNaklPdTVoT3V3Z091eWlPMll1T3F3Z0NEcnM0RHFzcjNya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJT3V3bE9xL3FPeVd0T3lhbEM0S0NpTWpJeURzbmJqc3BwM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdU95bW5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1qSU95NmtPeWp2T3lXdk8yVm5DRHFzcjNzbHJRZ0tPeW5pT3VzdUNEc25xenF0YXpzaExFcENnb2pJeU1nN0phNDdLQ2NJT3V3cWV1c3VPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Ryc0tucnJMZ2c2NEtnN0tlYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SmEwDQo2NWFrSU91d3FldXlsZXljdk91aG5DRHNuYmpzcHAzdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SjI0N0thZElPdXdxZXV5bGV5ZGhDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPcXlzT3lnbk8yVm1PeUxwQ0RzdWJUcms1enJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rxc3JEc29KenRsYUFnN0xtMDY1T2M2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0p1UTdaV1k3SXVjNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsWmpzaExqc21wUXVDaTBnN0p1UTdaV1k2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWp2T3lHak91bHZDRHNsWXpxczZBZzZyT0U3SXVnNnJDQTdKcVVQd290SU95anZPeUdqT3VsdkNEc2xZenFzNkFnN0o2STY0S1k3SnFVUHdvS0l5TWpJeURycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQW9LSXlNaklPcTRzT3F3aENEcg0KcDR6cm80enJvWndnN0oyMDdKcXA3SjIwSU95a2tleW5nT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzbmJUc21xa2c2cml3NnJDRTdKMjBJT3VCbmV1Q21PeUVuQ0RzcDREcXVJanNuWUFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SnFwNjUrSklPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0lEc25xWHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lnZ095ZXBlMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVDZ29qSXlNZzdZYTE3SXVnSU95WXBPdWxtT3VobkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXWTdKaUE3SXExNjR1STY0dWtMZ290SU8yR3RleUxvT3lkdENEc201RHRtWnp0bFpqc3A0QWc3SldLN0pXRUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWcNCjZyYU03WldjSU91MmdPeWhzZXljdk91aG5DRHNvSkhxdDd6c25iUWc2ckd3NjdhQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SmEwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHF0b3p0bFp6c25ZUWc3SnFVN0xLdDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc3SU9CN1ptcElPeVZpT3VDdENBb011dUxxQ0RxdGF6c29iQXBDZ29qSXlNZzdKNkY2NkNsN1pXWTdJdWdJT3lqdk95R2pPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc2NHVrN0l1Y0lPMlpsZXlkdUNEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0tPODdJYU02Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3VMcE95TG5DRHRtWlhzbmJqdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWFsT3l5cmUyVm1PeUxvQ0R0anBqc25iVHNwNERycGJ3ZzdMQys3SjJFSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdZNlk3SjIwN0tlQTY2VzhJT3l3DQp2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95anZPeUdqT3VsdkNEdG1aWHNuYmp0bFpqcXNiRHJncGdnN1ptSTdKeTg2NkdjSU95ZHRPdVBtZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjQrWjdKMjg3WldjSU95YWxPeXlyZXlkdENEc3NwanJwcXdnN0tTUjdKNkY2NHVJNjR1a0xpRHNucURzaTV3ZzdadUVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc2ckNaN0oyQUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanFzNkFnN0o2STdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYlRyc3FUdGlyanFzSUFnN0tLRjY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdE91eXBPMkt1T3F3Z0NEcmdaM3JncXpzbHJUc21wUXVDZ29qSXlNZzdZT0k3WWUwSU95TG5DRHJxcWpyazZBZzY0Mnc3SjIwN1lTdzZyQ0FJT3lDcmV5Z25PdVFtT3Vwc0NEcnM3WHF0YXp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0Sw0KTFNEdGc0anRoN1R0bFpqcnFiUWc2NnFvNjVPZ0lPdU5zT3lkdE8yRXNPcXdnQ0RzZ3Ezc29KenJrSmpxczZBZzY0dWs3SXVjSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95Z2xldW5rQ0R0ZzRqdGg3VHRsYURxdVl6c21wUS9DZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeURnZTJacVNEc2xZanJnclFwQ2dvakl5TWc2N2FBN0o2c0lPeWtrU0Ryc0tucnJManNucERxc0lBZzZyQ1E3S2VBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91MmdPeWVyQ0RzcEpIc2w1QWc2N0NwNjZ5NDdKNlE2ckNBSU95ZWlPeVhpT3lXdE95YWxDNGdMeURzbUlIc2c0SHNuWVFnN1ptVjdKMjQ3WlcwSU91enRPeUV1T3lhbEM0S0NpTWpJeURxc3IzcnVZUWc3WlcwN0tDY0lPcTJqTzJWbk95ZHRDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZySzk2N21FSU8yVnRPeWduQ0RxdG96dGxaenNuYlFnN1pXRTdKcVU3WlcwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHNtcFRzc3EzdGxiUWcNCjdLTzg3SVM0N0pxVUxnb0tJeU1qSU8yWmxPeWVyQ0Rxc0pEc3A0RHF1TEFnNjdDdzdZU3c2NmFzNnJDQUlPdTJnT3loc2UyVnFldUxpT3VMcEM0S0xTRHRtWlRzbnF3ZzZyQ1E3S2VBNnJpd0lPdXdzTzJFc091bXJPcXdnQ0RzbHJ6cnA0Z2c3SmVHN0phMDdKcVVMaUF2SU91d3NPMkVzT3Vtck91bHZDRHF0WkRzc3JUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHN0cFhzbGIwZ0t5RHF1STNzb0pVZzdLQ0U3Wm1ZSUNqcmtaQWc2Nnk0N0o2bElPS0draURxdUkzc29KWHRtSlVnN1pXY0lPdXN1T3llcFNrS0NpTWpJeURycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0RyDQpzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRtSnp0ZzUwZzdKZUc3SjIwSU9xd2dPeWVoZTJWb09xNWpPeWFsRDhnN0tlQTZyaUlJT3lMb095eXJlMlZtT3luZ0NEc2xZcnNuTHpycWJRZzdKdXc3THUwSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzcDREcXVJZ2c3SXVnN0xLdDdaV1k2Nm0wSU95YnNPeTd0Q0R0bUp6dGc1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0wrZzdZK3dJT3lYaHV5ZHRDRHFzckRzb0p6dGxhRHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1Q0RzdjZEdGo3RHNuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUNpMGc3TCtnN1krdzdKMkVJT3V3bSt5Y3ZPdXB0Q0RyalpRZzdLQ0E2NkMwN1pXWTZyS01JT3F5c095Z25PMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95VmpPdW12Q0RzbDRic25iUWc3SXVjN0o2UjdaV2c2cm1NN0pxVQ0KUHlEc2xZenJwcnpzbllRZzdMeWM3S2VBSU95Vml1eWN2T3VwdENEc3BKSHNtcFR0bFp3ZzdJYU03SXVkN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU95VmpPdW12T3lkaENEc3ZKenJxYlFnN0tTUjdKcVU3WldjSU95R2pPeUxuZXlkaENEcnNKVHJvWndnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0o2UTY0K1o3SjIwN0xLMDY2VzhJT3VUc2V1aG5lMlZtT3luZ0NEc2xZcnFzNkFnNjRTWTdKYTA2ckNJNnJtTTdKcVVQeURyazdIcm9aM3RsWmpzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc25wRHJqNW5zbmJUc3NyVHJwYndnNjVPeDY2R2Q3WldZNjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJzN2dnNnJPRTdKVzk3SjJZSU95Y29PeWR2TzJWbkNEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3lkdk91d21PcTBnT3Vtck95ZWtPdWgNCm5DRHF0b3p0bFp6cnM0RHFzcjNzbllRZzdaV1k3SXVrSU95SW1DRHNsNGJzbHJUc21wUXVJT3lkdk91d21DRHF0SURycHF6c25wRHJvWndnNnJhTTdaV2NJT3V6Z09xeXZleWRoQ0RzbTVEdGxaanNpNlFnNnJLOTdKcXdJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla0NEcXRvenRsWnpzbllRZzdLZUE3S0NWN1pXMElPeWp2T3lMb0NEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVm5DRHJrcVFnN0oyODY3Q1lJT3EwZ091bXJPeWVrT3VobkNEcnM0RHFzcjN0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLTFNEcmk2VHJwYmdnN0lLczY1Nk03SjJFSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcm9ad2c3S2VBN0tDVjdaV1k2Nm0wSU91emdPcXl2ZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ289DQo6OkxBVU5DSEVSOjoNCi8vNG5BQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkNBSElBYVFCa0FHY0FaUUFnQUd3QVlRQjFBRzRBWXdCb0FHVUFjZ0FnQUJRZ0lBRG9zc1NzeEx3Z0FDVEJGY2dnQUJESWdLd2dBTVRXSUFEa3NxeTVJQURrd29uVkNnQW5BQ0FBWXdCc0FHRUFkUUJrQUdVQVlnQnlBR2tBWkFCbkFHVUFPZ0F2QUM4QUlBQUUxVnk0b05GY3ozVEhJQUIweHlBQUROTjh4MFRISUFDQXZYaTU1TElnQUNnQThiUmR1RG9BSUFCMDBGeTQzTFRrc3F5NUxRRFF4blRRcmJud3hiQ3NMZ0IyQUdJQWN3QXBBQzRBQ2dBbkFDQUFWTHNBckNBQVlMNDR5Q0FBaU1jOHgzUzZJQUJjMVNBQWlMelF4U0FBV05XWXNDbkZJQUJJeGJTd1dOWGdyQ3dBSUFEa3NpQUFBTWxFdmhpMGRMb2dBT1N5ckxsOHVTQUFQY3dnQU1iRmRNY2dBT1RDaWRWYzFlU3lMZ0FLQUZNQVpRQjBBQ0FBWmdCekFHOEFJQUE5QUNBQVF3QnlBR1VBWVFCMEFHVUFUd0JpQUdvQVpRQmpBSFFBS0FBaUFGTUFZd0J5QUdrQWNBQjBBR2tBYmdCbkFDNEFSZ0JwQUd3QVpRQlRBSGtBDQpjd0IwQUdVQWJRQlBBR0lBYWdCbEFHTUFkQUFpQUNrQUNnQlRBR1VBZEFBZ0FITUFhQUFnQUQwQUlBQkRBSElBWlFCaEFIUUFaUUJQQUdJQWFnQmxBR01BZEFBb0FDSUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGTUFhQUJsQUd3QWJBQWlBQ2tBQ2dCa0FHa0FjZ0FnQUQwQUlBQm1BSE1BYndBdUFFY0FaUUIwQUZBQVlRQnlBR1VBYmdCMEFFWUFid0JzQUdRQVpRQnlBRTRBWVFCdEFHVUFLQUJYQUZNQVl3QnlBR2tBY0FCMEFDNEFVd0JqQUhJQWFRQndBSFFBUmdCMUFHd0FiQUJPQUdFQWJRQmxBQ2tBQ2dCekFHZ0FMZ0JEQUhVQWNnQnlBR1VBYmdCMEFFUUFhUUJ5QUdVQVl3QjBBRzhBY2dCNUFDQUFQUUFnQUdRQWFRQnlBQW9BQ2dBbkFDQUFNUUF2QURJQUtRQWdBRTRBYndCa0FHVUFMZ0JxQUhNQUlBQVF5SUNzSUFBVUlDQUF4c1U4eDNTNklBRGtzclRHWExqY3RDQUFtTk4weDhESmZMa2dBUFRGdE1VQXllU3lDZ0JKQUdZQUlBQnpBR2dBTGdCU0FIVUFiZ0FvQUNJQVl3QnRBR1FBSUFBdkFHTUFJQUIzQUdnQQ0KWlFCeUFHVUFJQUJ1QUc4QVpBQmxBQ0lBTEFBZ0FEQUFMQUFnQUZRQWNnQjFBR1VBS1FBZ0FEd0FQZ0FnQURBQUlBQlVBR2dBWlFCdUFBb0FJQUFnQUVrQVpnQWdBRTBBY3dCbkFFSUFid0I0QUNnQUlnQk9BRzhBWkFCbEFDNEFhZ0J6QUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aTRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdCYkFGWFdlTWRkQUVUSElBQUVzblM1ZExvZ0FPU3l0TVpjdU55MElBQ1kwM1RId01rQXJDQUE5TVc5dWNpeTVMSXVBQ0FBSk1GWXpueTVJQURJdVZ6T0lBQ2t0Q3dBSUFBTTFleTMrSzE0eDlERkhNRWdBSFRRWExqY3RDQUFoTHk4MGtUSElBRGtzdHpDSUFBTXN1eTNJQUQ4eURqQmxNWXVBQ0lBTEFBZ0FGOEFDZ0FnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQjJBR0lBVHdCTEFFTUFZUUJ1QUdNQVpRQnNBQ0FBS3dBZ0FIWUENCllnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURFQUx3QXlBQ2tBSUFBVUlDQUFUZ0J2QUdRQVpRQXVBR29BY3dBaUFDa0FJQUE5QUNBQWRnQmlBRThBU3dBZ0FGUUFhQUJsQUc0QUNnQWdBQ0FBSUFBZ0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCb0FIUUFkQUJ3QUhNQU9nQXZBQzhBYmdCdkFHUUFaUUJxQUhNQUxnQnZBSElBWndBdkFHc0Fid0F2QUdRQWJ3QjNBRzRBYkFCdkFHRUFaQUFpQUFvQUlBQWdBRVVBYmdCa0FDQUFTUUJtQUFvQUlBQWdBRmNBVXdCakFISUFhUUJ3QUhRQUxnQlJBSFVBYVFCMEFBb0FSUUJ1QUdRQUlBQkpBR1lBQ2dBS0FDY0FJQUF5QUM4QU1nQXBBQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDQUFFTWlBckNBQUZDQWdBTWJGUE1kMHVpQUFKTUZZenJjQVhMajRyWGpISUFBcHZKVzhSTWNnQUVqRnRMQmMxZVN5Q2dCSkFHWUFJQUJ6QUdnQUxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BDQpJQUIzQUdnQVpRQnlBR1VBSUFCakFHd0FZUUIxQUdRQVpRQWlBQ3dBSUFBd0FDd0FJQUJVQUhJQWRRQmxBQ2tBSUFBOEFENEFJQUF3QUNBQVZBQm9BR1VBYmdBS0FDQUFJQUJOQUhNQVp3QkNBRzhBZUFBZ0FDSUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aUFBS0FBUXRwU3lJQUJRQUVFQVZBQklBTkRGSUFER3hiVEZsTVlwQUM0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0F3MGZpN0VMSFF4UnpCSUFCRXhaaTNmTGtnQUNUQldNNjNBRnk0K0sxNHgxelZJQUNrdEN3QUlBQjAwRnk0M0xRZ0FJUzh2TkpFeHlBQTVMTGN3aUFBRExMc3R5QUEvTWc0d1pUR09nQWlBQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBSmdBZ0FGOEFDZ0FnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFpQUNBQQ0KSUFCdUFIQUFiUUFnQUdrQWJnQnpBSFFBWVFCc0FHd0FJQUF0QUdjQUlBQkFBR0VBYmdCMEFHZ0FjZ0J2QUhBQWFRQmpBQzBBWVFCcEFDOEFZd0JzQUdFQWRRQmtBR1VBTFFCakFHOEFaQUJsQUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFJQUFnQUdNQWJBQmhBSFVBWkFCbEFDQUFiQUJ2QUdjQWFRQnVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQVZkWjR4eUFBS2J5VnZEb0FJQUF3MGZpN0VMSFF4UnpCSUFCakFHd0FZUUIxQUdRQVpRQWdBQzBBTFFCMkFHVUFjZ0J6QUdrQWJ3QnVBQ0FBZE1jZ0FJUzhCTWhFeHlBQW5NMGx1RmpWZExvZ0FBREpSTDRnQUVUR3pMaUZ4OGl5NUxJdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBS0FDc3dLbkcNCnliZEF4eUFBZE1jZ0FGQUFRd0RReFNBQVhMajRyWGpISExRZ0FIVFFYTGpjdENBQWJLM0ZzeUFBWE5YRXM5REZITUVnQUNqTUVLd3B0TWl5NUxJdUFDa0FJZ0FzQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBSFlBWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BRElBTHdBeUFDa0FJQUFVSUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0lBQ2dBZ0FDQUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGRUFkUUJwQUhRQUNnQkZBRzRBWkFBZ0FFa0FaZ0FLQUFvQUp3QWdBQURKUkw0Z0FFVEd6TGdnQUJRZ0lBRGtzcXk1ZkxrZ0FEM01JQURHeFhUSElBRGt3b25WSUFBb0FBelY3TGY0clhqSGRNY2dBT2VzSUFDUXg5bXpJQUFRck1ESktRQUtBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQmpBRzBBWkFBZ0FDOEFZd0FnQUc0QWJ3QmtBR1VBSUFCekFHTUFjZ0JwQUhBQWRBQnpBRndBWXdCc0FHRUFkUUJrQUdVQUxRQmlBSElBDQphUUJrQUdjQVpRQXVBR29BY3dBaUFDd0FJQUF3QUN3QUlBQkdBR0VBYkFCekFHVUFDZ0E9DQo6OkVORDo6DQo=";
// ===== INSTALLER:END =====

// 다리 심장박동 — 플러그인이 떠 있는 동안 5초마다 생존 신호를 보낸다.
// 플러그인/피그마가 닫혀 박동이 30초 끊기면 다리가 claude와 함께 스스로 꺼진다 (claude-bridge.js /heartbeat).
// 다리가 꺼져 있으면 그냥 실패 — 심장박동이 다리를 켜지는 않는다 (켜기는 ensureBridgeFromGesture 담당).
function sendHeartbeat() {
  postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/heartbeat', {}, 3000).catch(() => { /* 다리 꺼짐 — 무시 */ });
}
sendHeartbeat();
setInterval(sendHeartbeat, 5000);

// 타임아웃 있는 fetch — 한 요청이 멈춰도 그 슬롯이 영원히 막히지 않게 한다.
// Figma 플러그인 런타임엔 AbortController가 없어 Promise.race로 구현 (느린 fetch는 버려지고 슬롯만 푼다).
function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return Promise.race([
    fetch(url),
    new Promise<Response>((_resolve, reject) => setTimeout(() => reject(new Error('타임아웃 ' + ms + 'ms')), ms)),
  ]);
}

// 에러 객체에서 사람이 읽을 메시지 추출 ([object Object] 방지)
function errStr(e: any): string {
  if (!e) return 'unknown';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  try { return JSON.stringify(e); } catch (_e) { return String(e); }
}

// ── AI 기능(문구 추천 / 번역) — 같은 서버의 다른 경로로 POST 요청 ──
// NAVER_PROXY_URL은 끝에 '/'가 있으므로 경로를 그대로 이어 붙인다.
async function postJsonWithTimeout(url: string, body: any, ms: number): Promise<Response> {
  return Promise.race([
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    new Promise<Response>((_resolve, reject) => setTimeout(() => reject(new Error('타임아웃 ' + ms + 'ms')), ms)),
  ]);
}

// 현재 선택 영역 안의 모든 텍스트를 하나의 문자열로 모은다 (직접 입력이 없을 때 사용)
async function collectSelectedText(): Promise<string> {
  const selection = figma.currentPage.selection;
  if (!selection || selection.length === 0) return '';
  const parts: string[] = [];
  for (const node of selection) {
    if (node.type === 'TEXT') {
      parts.push((node as TextNode).characters);
    } else {
      const found = await findAllTextNodes(node, 10000);
      for (const t of found) parts.push(t.characters);
    }
  }
  return parts.join('\n').trim();
}

// 진행 중인 키 요청 공유 — 동시 작업들이 각자 키를 다시 가져오지 않게 한다
let naverKeyPromise: Promise<string | null> | null = null;

async function getNaverPassportKey(force = false): Promise<string | null> {
  if (naverPassportKey && !force) return naverPassportKey;
  if (naverKeyPromise && !force) return naverKeyPromise;
  naverKeyPromise = fetchNaverPassportKey();
  try {
    return await naverKeyPromise;
  } finally {
    naverKeyPromise = null;
  }
}

async function fetchNaverPassportKey(): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(NAVER_PROXY_URL + 'passport', 8000);
    if (!res.ok) { naverDiag = '프록시 HTTP ' + res.status; console.log('[UX-SPELL]', naverDiag); return null; }
    const data = await res.json();
    naverPassportKey = (data && typeof data.passportKey === 'string') ? data.passportKey : null;
    if (!naverPassportKey) {
      naverDiag = 'passportKey 못 받음: ' + (data && data.error ? data.error : '알 수 없음');
      console.log('[UX-SPELL]', naverDiag);
    } else {
      console.log('[UX-SPELL] passportKey OK:', naverPassportKey.slice(0, 10) + '…');
    }
    return naverPassportKey;
  } catch (e) {
    naverDiag = '프록시 fetch 실패: ' + errStr(e);
    console.log('[UX-SPELL] proxy fetch error', e);
    return null;
  }
}

function decodeEntities(s: string): string {
  // 네이버 notag_html은 줄바꿈을 <br> 태그로 돌려준다 → 실제 줄바꿈으로 복원
  return s.replace(/<br\s*\/?>/gi, '\n')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// 네이버 교정 유형(색깔 클래스) → 한글 라벨. 4종으로 분류된다.
const NAVER_TYPE_LABEL: { [cls: string]: string } = {
  red_text: '맞춤법',
  green_text: '띄어쓰기',
  violet_text: '표준어 의심',
  blue_text: '통계적 교정',
};

// 변경점으로 취급하지 않을 교정 유형(클래스). 통계적 교정은 우리 기준과 안 맞아 제외한다.
const NAVER_EXCLUDED_CLASSES = new Set<string>(['blue_text']);

// 네이버 교정 유형 라벨 → 로컬 규칙과 같은 문장형 사유
function naverReasonSentence(typeLabel: string): string {
  switch (typeLabel) {
    case '맞춤법': return '맞춤법';
    case '띄어쓰기': return '띄어쓰기';
    case '표준어 의심': return '표준어';
    default: return '맞춤법·띄어쓰기'; // 정의된 4유형 외에는 도달하지 않음
  }
}

// result.html에서 교정 유형 라벨을 등장 순서대로(중복 제거) 추출. 제외 유형은 빼고 반환.
function extractNaverTypes(html: string): string[] {
  const types: string[] = [];
  const re = /<em\s+class='([a-z_]+)'>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (NAVER_EXCLUDED_CLASSES.has(m[1])) continue;
    const label = NAVER_TYPE_LABEL[m[1]];
    if (label && types.indexOf(label) === -1) types.push(label);
  }
  return types;
}

// 교정문 재조립: 제외 유형(통계적 교정) 구간은 원문(origin_html) 그대로 되돌리고 나머지는 교정 적용.
// origin_html의 밑줄 구간과 html의 <em> 구간은 같은 순서로 1:1 대응한다.
function buildCorrectedExcluding(originHtml: string, html: string): string {
  const origins: string[] = [];
  const oRe = /<span class='result_underline'>([\s\S]*?)<\/span>/gi;
  let om: RegExpExecArray | null;
  while ((om = oRe.exec(originHtml)) !== null) origins.push(om[1]);
  let i = 0;
  const out = html.replace(/<em\s+class='([a-z_]+)'>([\s\S]*?)<\/em>/gi, (_full: string, cls: string, corrected: string) => {
    const original = origins[i] !== undefined ? origins[i] : corrected;
    i++;
    return NAVER_EXCLUDED_CLASSES.has(cls) ? original : corrected;
  });
  return decodeEntities(out);
}

// SpellerProxy 호출 공통 부분: URL 조립 → fetch → JSON 파싱 → 오류 검사까지.
// 성공하면 data.message.result(notag_html 포함)를 돌려주고, 실패는 null + naverDiag 설정.
// 단건(naverSpellChunk)과 배치(naverSpellChunkLines)가 이 헬퍼를 공유한다.
async function fetchSpellerResult(q: string, key: string): Promise<any | null> {
  try {
    const url = 'https://m.search.naver.com/p/csearch/ocontent/util/SpellerProxy'
      + '?passportKey=' + encodeURIComponent(key)
      + '&color_blindness=0&q=' + encodeURIComponent(q);
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) { naverDiag = 'SpellerProxy HTTP ' + res.status; console.log('[UX-SPELL]', naverDiag); return null; }
    const raw = await res.text();
    let data: any = null;
    try { data = JSON.parse(raw); } catch (_e) { naverDiag = 'SpellerProxy 응답 JSON 파싱 실패'; console.log('[UX-SPELL]', naverDiag, raw.slice(0, 120)); return null; }
    if (!data || !data.message || data.message.error) {
      naverDiag = 'SpellerProxy 오류: ' + (data && data.message && data.message.error ? data.message.error : '알 수 없음');
      console.log('[UX-SPELL]', naverDiag);
      return null;
    }
    const result = data.message.result;
    if (!result || typeof result.notag_html !== 'string') return null;
    naverOkCount++; // 정상 응답 1건
    return result;
  } catch (e) {
    naverDiag = 'SpellerProxy fetch 실패: ' + errStr(e);
    console.log('[UX-SPELL] SpellerProxy fetch error', e);
    return null;
  }
}

// ≤500자 한 덩어리 검사. 반환: {corrected, errata, types} 또는 null(실패/키만료)
async function naverSpellChunk(text: string, key: string): Promise<{ corrected: string; errata: number; types: string[] } | null> {
  const result = await fetchSpellerResult(text, key);
  if (!result) return null;
  // html + origin_html이 있으면 통계적 교정을 제외하고 재조립, 없으면 notag_html 그대로
  const corrected = (typeof result.html === 'string' && typeof result.origin_html === 'string')
    ? buildCorrectedExcluding(result.origin_html, result.html)
    : decodeEntities(result.notag_html);
  const types = typeof result.html === 'string' ? extractNaverTypes(result.html) : [];
  return { corrected, errata: result.errata_count || 0, types };
}

// 노드 텍스트 1건 맞춤법 검사. 500자 초과면 건너뜀(로컬 규칙만). 실패 시 원문 유지.
// checked: 네이버가 이 텍스트를 실제로 검사했는지 여부 (false면 부사 띄어쓰기 폴백 규칙이 적용됨)
type SpellResult = { text: string; reasons: string[]; checked: boolean };

async function naverSpellCheck(text: string): Promise<SpellResult> {
  if (!text || !text.trim() || text.length > 500) return { text, reasons: [], checked: false };
  // 한글이 없으면(숫자·영문·기호만) 맞춤법 검사할 게 없으니 네트워크 요청 생략
  if (!/[가-힣]/.test(text)) return { text, reasons: [], checked: false };
  let key = await getNaverPassportKey();
  if (!key) return { text, reasons: [], checked: false };

  // 네이버에는 모든 줄바꿈을 \n으로 통일해 보낸다
  // (U+2028 등을 그대로 보내면 일반 공백으로 뭉개져 "보이지 않는 차이" 제안이 생긴다)
  const sendText = text.replace(/\r\n|[\r\u2028\u2029]/g, '\n');
  let r = await naverSpellChunk(sendText, key);
  if (r === null) {
    // 키 만료 가능 → 1회 재발급 후 재시도
    key = await getNaverPassportKey(true);
    if (key) r = await naverSpellChunk(sendText, key);
  }
  if (r === null) return { text, reasons: [], checked: false };
  // 네이버가 합성어를 띄어 쓰거나 예외 표기를 바꾼 경우 용어집 표기로 되돌린다
  // — 되돌려서 원문과 같아지면 제안 자체가 사라진다.
  // 공백 구조(줄바꿈·각 줄 앞뒤 공백)도 원문대로 복원 (네이버가 잘라내면 똑같아 보이는 제안이 생김)
  const cleaned = r.errata > 0 ? revertKeptSpellings(text, protectCompounds(r.corrected)) : r.corrected;
  const corrected = alignWhitespace(text, cleaned);
  let reasons: string[] = [];
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
async function naverSpellChunkLines(
  joined: string,
  key: string,
  lineCount: number
): Promise<Array<{ corrected: string; types: string[] }> | null> {
  try {
    const result = await fetchSpellerResult(joined, key);
    if (!result) return null;
    // html + origin_html이 있으면 줄별로 통계 교정 제외 + 유형 추출
    if (typeof result.html === 'string' && typeof result.origin_html === 'string') {
      const hLines = result.html.split(/<br\s*\/?>/i);
      const oLines = result.origin_html.split(/<br\s*\/?>/i);
      if (hLines.length === lineCount && oLines.length === lineCount) {
        const outLines: Array<{ corrected: string; types: string[] }> = [];
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
    if (plain.length === lineCount) return plain.map((c) => ({ corrected: c, types: [] }));
    naverDiag = '배치 응답 줄 수 불일치';
    return null;
  } catch (e) {
    naverDiag = 'SpellerProxy fetch 실패: ' + errStr(e);
    return null;
  }
}

// 네이버 검사 결과 캐시 (플러그인 세션 동안 유지) — 재검토 시 같은 문구는 네트워크를 생략한다
const naverCache = new Map<string, SpellResult>();

// 동시 실행 개수를 제한해 비동기 작업 처리 (네트워크 과다 호출 방지)
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
      done++;
      if (onProgress) onProgress(done);
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// 여러 텍스트를 한 번에 검사: 캐시 → 배치(여러 문구를 \n으로 묶어 요청 1개) → 실패 시 단건 폴백.
// 문구당 요청 1개씩 보내던 방식 대비 요청 수가 1/N로 줄어 검토가 크게 빨라진다.
async function naverSpellCheckAll(
  uniqueTexts: string[],
  onProgress?: (done: number) => void
): Promise<Map<string, SpellResult>> {
  const out = new Map<string, SpellResult>();
  let done = 0;
  const report = (n: number) => { done += n; if (onProgress) onProgress(done); };
  const setResult = (t: string, r: SpellResult) => {
    out.set(t, r);
    if (r.checked) naverCache.set(t, r); // 성공한 결과만 캐시 (실패는 다음 검토 때 재시도)
  };

  const toCheck: string[] = [];
  for (const t of uniqueTexts) {
    const cached = naverCache.get(t);
    if (cached) { out.set(t, cached); report(1); continue; }
    if (!t || !t.trim() || t.length > 500 || !/[가-힣]/.test(t)) {
      out.set(t, { text: t, reasons: [], checked: false });
      report(1);
      continue;
    }
    toCheck.push(t);
  }
  if (toCheck.length === 0) return out;

  // 줄바꿈(\n, \r, U+2028, U+2029) 포함 텍스트는 단건 검사
  // (배치 구분자로 \n을 쓰므로 섞으면 줄 복원이 모호해진다)
  const singles = toCheck.filter((t) => LINE_BREAK_CHARS.test(t));
  const flats = toCheck.filter((t) => !LINE_BREAK_CHARS.test(t));

  // 한 줄짜리 문구들을 450자/30개 한도로 묶는다
  const batches: string[][] = [];
  let cur: string[] = [];
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
  if (cur.length > 0) batches.push(cur);

  // 배치 1개 처리: 줄 복원이 안 되면 단건 검사로 폴백
  const runBatch = async (texts: string[]): Promise<void> => {
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
      if (key) lines = await naverSpellChunkLines(texts.join('\n'), key, texts.length);
    }
    if (lines === null) {
      for (const t of texts) { setResult(t, await naverSpellCheck(t)); report(1); }
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

  const jobs: Array<() => Promise<void>> = [];
  for (const b of batches) jobs.push(() => runBatch(b));
  for (const t of singles) jobs.push(async () => { setResult(t, await naverSpellCheck(t)); report(1); });
  await mapWithConcurrency(jobs, 6, (job) => job());
  return out;
}

/**
 * 새로운 엔진: 텍스트에 대한 제안 생성
 * naverChecked: 이 텍스트가 네이버 맞춤법 검사를 통과했으면 true.
 *               띄어쓰기는 네이버 결과를 우선하므로 부사 띄어쓰기 폴백 규칙을 건너뛴다.
 */
function suggestFriendlyKorean(text: string, naverChecked = false): Suggestion[] {
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

  const suggestions: Suggestion[] = [];

  const mainSuggestion = buildSuggestion(original, finalAfter, mergedReasons, mergedTags);
  if (mainSuggestion) suggestions.push(mainSuggestion);

  return suggestions;
}

// 자식을 가질 수 있는 노드 타입 (최적화를 위해 미리 정의)
const CONTAINER_NODE_TYPES = new Set([
  "FRAME", "GROUP", "COMPONENT", "INSTANCE", "SECTION", "PAGE"
]);

// 선택된 노드 내부의 모든 텍스트 노드를 재귀적으로 찾기 (최적화 버전 - 비동기)
async function findAllTextNodes(
  node: SceneNode, 
  maxNodes: number = 10000,
  onProgress?: (progress: number) => void
): Promise<TextNode[]> {
  const textNodes: TextNode[] = [];
  const stack: SceneNode[] = [node]; // 스택 기반 반복 방식으로 재귀 최적화
  let processedCount = 0;
  const CHUNK_SIZE = 100; // 100개씩 처리 후 yield (성능 최적화)
  let lastProgressUpdateTime = Date.now();
  const PROGRESS_UPDATE_TIME_INTERVAL = 50; // 50ms마다 시간 기반 업데이트
  
  // 스택이 빌 때까지 반복
  while (stack.length > 0 && textNodes.length < maxNodes) {
    const current = stack.pop()!;
    processedCount++;
    
    // 비활성화된 노드는 스킵 (최적화)
    if ('visible' in current && current.visible === false) {
      continue;
    }
    
    // 현재 노드가 텍스트 노드인 경우
    if (current.type === "TEXT") {
      textNodes.push(current as TextNode);
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
function saveRangeStyle(node: TextNode, pos: number): Record<string, any> {
  const style: Record<string, any> = {};
  try {
    if (node.getRangeFills) {
      const v = node.getRangeFills(pos, pos + 1);
      if (v !== figma.mixed) style.fills = v;
    }
    if (node.getRangeFontName) {
      const v = node.getRangeFontName(pos, pos + 1);
      if (v !== figma.mixed) style.fontName = v;
    }
    if (node.getRangeFontSize) {
      const v = node.getRangeFontSize(pos, pos + 1);
      if (v !== figma.mixed) style.fontSize = v;
    }
    if (node.getRangeLetterSpacing) {
      const v = node.getRangeLetterSpacing(pos, pos + 1);
      if (v !== figma.mixed) style.letterSpacing = v;
    }
    if (node.getRangeTextDecoration) {
      const v = node.getRangeTextDecoration(pos, pos + 1);
      if (v !== figma.mixed) style.textDecoration = v;
    }
  } catch {}
  return style;
}

// 저장된 스타일을 범위에 복원하는 헬퍼
function restoreRangeStyle(node: TextNode, start: number, end: number, style: Record<string, any>): void {
  try {
    if (style.fills && node.setRangeFills) node.setRangeFills(start, end, style.fills);
    if (style.fontName && node.setRangeFontName) node.setRangeFontName(start, end, style.fontName);
    if (style.fontSize && node.setRangeFontSize) node.setRangeFontSize(start, end, style.fontSize);
    if (style.letterSpacing && node.setRangeLetterSpacing) node.setRangeLetterSpacing(start, end, style.letterSpacing);
    if (style.textDecoration && node.setRangeTextDecoration) node.setRangeTextDecoration(start, end, style.textDecoration);
  } catch {}
}

// 노드에 변경 적용하는 헬퍼 함수 (캐릭터 레벨 포매팅 보존)
function applyChangeToNode(
  node: TextNode,
  previewMap: Map<string, { before: string; after: string }>,
  changedNodeIds: Set<string>,
  _errors: string[]
): void {
  const previewItem = previewMap.get(node.id);
  if (!previewItem) return;
  if (node.characters !== previewItem.before) return;

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
function tagAnnotation(node: any, key: string): void {
  try { node.setPluginData(PLUGIN_DATA_KEY, key); } catch (_e) {}
}

// 노드에서 어노테이션 키를 읽는다 (pluginData 우선, 옛 버전의 이름 기반도 폴백 인식)
function getAnnNodeKey(node: any): string {
  try {
    const k = node.getPluginData(PLUGIN_DATA_KEY);
    if (k) return k;
  } catch (_e) {}
  if (typeof node.name === 'string' && node.name.startsWith(ANNOTATION_PREFIX)) {
    return node.name.slice(ANNOTATION_PREFIX.length);
  }
  return '';
}

function isAnnotationNode(node: any): boolean {
  return getAnnNodeKey(node) !== '';
}

// 키 문자열 파싱 -> { kind, nodeId, seg, key }
// 키 형식: [HL_INFIX] + nodeId + SEG_SEP + segIndex (+ LINE_SEP + lineIndex)
function parseAnnKey(key: string): { kind: 'hl' | 'tooltip'; nodeId: string; seg: string; key: string } | null {
  if (!key) return null;
  let rest = key;
  let kind: 'hl' | 'tooltip' = 'tooltip';
  if (rest.startsWith(HL_INFIX)) { kind = 'hl'; rest = rest.slice(HL_INFIX.length); }
  const sep = rest.lastIndexOf(SEG_SEP);
  const nodeId = sep >= 0 ? rest.slice(0, sep) : rest;
  const seg = sep >= 0 ? rest.slice(sep + SEG_SEP.length) : '0';
  return { kind, nodeId, seg, key };
}

// 노드 파싱
function parseAnnNode(node: any): { kind: 'hl' | 'tooltip'; nodeId: string; seg: string; key: string } | null {
  return parseAnnKey(getAnnNodeKey(node));
}

// 어노테이션이 속한 "세그먼트(코멘트) 식별자" = nodeId##segIndex.
// 형광펜(HL_INFIX)·줄 접미사(LINE_SEP)를 떼서, 같은 변경의 코멘트와 형광펜이 같은 값을 갖게 한다.
function annSegId(key: string): string {
  let rest = key || '';
  if (rest.startsWith(HL_INFIX)) rest = rest.slice(HL_INFIX.length);
  const li = rest.indexOf(LINE_SEP);
  if (li >= 0) rest = rest.slice(0, li);
  return rest;
}

// nodeId -> 대상 노드 참조 캐시 (폴링 시 동기적으로 위치 읽기용)
const annotationNodeCache = new Map<string, any>();

// nodeId -> 대상 노드 자신 + 조상 노드 id 집합 (캔버스 선택 매칭용)
const annotationAncestorIds = new Map<string, Set<string>>();

// 조상 노드 id -> 그 아래에 있는 추적 대상 텍스트 nodeId 집합 (documentchange에서 역방향 조회용)
// 프레임 하나가 움직이면 이 인덱스로 영향받는 텍스트만 골라 위치를 갱신한다.
const ancestorToTracked = new Map<string, Set<string>>();

// 어노테이션 노드 id -> 대상 텍스트 nodeId (코멘트를 손으로 끌면 제자리로 되돌리기 위한 역추적)
const annIdToTracked = new Map<string, string>();

// 어노테이션 key(이름에서 PREFIX 뗀 부분) -> 대상 노드 기준 상대 위치 (프레임 이동 시 위치 갱신용)
// 코멘트/형광펜 모두 이 맵으로 위치를 따라감
const annotationOffset = new Map<string, { dx: number; dy: number }>();

// nodeId -> 그 노드의 어노테이션 노드들.
// 생성/제거/위치추적 모두 이 인덱스를 사용해 페이지 전수 스캔(getAllAnnotations)을 피한다.
// op: 마지막으로 쓴 투명도 (같은 값이면 다시 쓰지 않아 수천 개일 때 브리지 호출을 줄인다)
const annotationsByNode = new Map<string, Array<{ ann: any; key: string; op?: number }>>();

// 방금 만든 어노테이션을 인덱스에 등록
function registerAnnotation(ann: any): void {
  const p = parseAnnNode(ann);
  if (!p) return;
  let arr = annotationsByNode.get(p.nodeId);
  if (!arr) { arr = []; annotationsByNode.set(p.nodeId, arr); }
  arr.push({ ann, key: p.key, op: 1 }); // 생성 시 불투명(1)
  try { if (ann.id) annIdToTracked.set(ann.id, p.nodeId); } catch (_e) {}
}

// 형광펜 색 (노란 형광)
const HIGHLIGHT_COLOR = { r: 1, g: 0.92, b: 0.2 };

// 어노테이션 폰트 캐시
let annotationFontName: { family: string; style: string } | null = null;

async function ensureAnnotationFont(): Promise<{ family: string; style: string } | null> {
  if (annotationFontName) return annotationFontName;
  for (const font of [{ family: "Inter", style: "Medium" }, { family: "Roboto", style: "Medium" }]) {
    try {
      await figma.loadFontAsync(font);
      annotationFontName = font;
      return font;
    } catch {}
  }
  return null;
}

// 특정 노드의 어노테이션이 하나라도 있는지 검색 (인덱스 사용 — 텍스트 편집마다 호출되므로 전수 스캔 회피)
function findAnnotation(nodeId: string): any | null {
  const arr = annotationsByNode.get(nodeId);
  if (arr) {
    for (const { ann } of arr) {
      if (ann && !ann.removed) return ann;
    }
  }
  return null;
}

// 특정 노드의 모든 어노테이션(코멘트 + 형광펜, 모든 세그먼트) 제거
// 인덱스(annotationsByNode)로 바로 찾으므로 페이지 전수 스캔이 없다.
function removeAnnotationByNodeId(nodeId: string): void {
  // 네이티브 어노테이션 정리 (형광펜이 하나도 없는 노드여도 실행되도록 맨 앞에서)
  clearNativeAnnotation(nodeId);
  // 역방향 인덱스 정리
  const ancestors = annotationAncestorIds.get(nodeId);
  if (ancestors) {
    for (const aid of ancestors) {
      const set = ancestorToTracked.get(aid);
      if (set) {
        set.delete(nodeId);
        if (set.size === 0) ancestorToTracked.delete(aid);
      }
    }
    annotationAncestorIds.delete(nodeId);
  }
  const arr = annotationsByNode.get(nodeId);
  if (!arr) return;
  for (const { ann, key } of arr) {
    annotationOffset.delete(key);
    try { if (ann && ann.id) annIdToTracked.delete(ann.id); } catch (_e) {}
    try { ann.remove(); } catch (_e) {}
  }
  annotationsByNode.delete(nodeId);
}

// 모든 어노테이션 노드 수집 (제거/토글용 — pluginData 태그 또는 옛 이름 기반 모두 인식)
function getAllAnnotations(): any[] {
  const result: any[] = [];
  for (const child of figma.currentPage.children as any[]) {
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
function updateAnnotationOpacity(selectedIds: string[]): void {
  const selected = new Set(selectedIds);
  for (const [nodeId, arr] of annotationsByNode) {
    const op = (selected.size === 0 || selected.has(nodeId)) ? 1 : DIM_OPACITY;
    for (const entry of arr) {
      if (entry.op === op) continue; // 같은 값이면 브리지 호출 생략 (수천 개일 때 중요)
      try {
        if (entry.ann && !entry.ann.removed) {
          entry.ann.opacity = op;
          entry.op = op;
        }
      } catch (_e) {}
    }
  }
}

// 세그먼트(코멘트) 단위 투명도 조절 — 같은 노드에 여러 코멘트가 있어도 선택한 것만 선명.
// selectedSegIds가 비어있으면 전부 불투명.
function updateAnnotationOpacityBySeg(selectedSegIds: string[]): void {
  const selected = new Set(selectedSegIds);
  for (const [, arr] of annotationsByNode) {
    for (const entry of arr) {
      const op = (selected.size === 0 || selected.has(annSegId(entry.key))) ? 1 : DIM_OPACITY;
      if (entry.op === op) continue;
      try {
        if (entry.ann && !entry.ann.removed) {
          entry.ann.opacity = op;
          entry.op = op;
        }
      } catch (_e) {}
    }
  }
}

// 캔버스 선택에 따라 어노테이션 투명도 조절
// 선택된 노드 자신 또는 그 하위에 대상 텍스트가 있으면 해당 코멘트를 불투명 처리
function updateAnnotationOpacityFromCanvas(selection: ReadonlyArray<any>): void {
  // 선택된 노드들의 id 집합
  const selectedIds = new Set<string>();
  for (const n of selection) {
    if (n && n.id) selectedIds.add(n.id);
  }

  // 각 어노테이션의 대상 노드가 선택 범위(자신/조상)에 속하는지 판정
  // (생성 시점에 캐시해 둔 조상 id 집합과 교집합으로 판정 — dynamic-page에서도 안정적)
  const matched: string[] = [];
  if (selectedIds.size > 0) {
    for (const nodeId of annotationsByNode.keys()) {
      const ancestors = annotationAncestorIds.get(nodeId);
      if (!ancestors) continue;
      for (const id of selectedIds) {
        if (ancestors.has(id)) { matched.push(nodeId); break; }
      }
    }
  }

  // 관련된 코멘트가 하나도 없으면 전부 불투명(평상 상태) 유지
  updateAnnotationOpacity(matched);
  // 선택된 노드의 코멘트/형광펜을 맨 앞으로 (겹칠 때 가려지지 않도록)
  bringAnnotationsToFront(matched);
}

// 지정한 노드들의 어노테이션을 z-order 맨 앞으로 올린다 (페이지 끝에 다시 붙이면 최상단)
function raiseAnnotations(nodeIds: string[]): void {
  for (const nodeId of nodeIds) {
    const arr = annotationsByNode.get(nodeId);
    if (!arr) continue;
    // 생성 순서(형광펜 → 배경 → 텍스트)대로 다시 붙여 상대 순서 유지 (텍스트가 위)
    for (const { ann } of arr) {
      try {
        if (ann && !ann.removed) figma.currentPage.appendChild(ann);
      } catch (_e) {}
    }
  }
}

let raiseRetryTimer: ReturnType<typeof setTimeout> | null = null;

function bringAnnotationsToFront(nodeIds: string[]): void {
  raiseAnnotations(nodeIds);
  // 선택 이벤트는 마우스를 누르는 순간 발생해, 클릭 제스처 중의 순서 변경을
  // Figma가 되돌리는 경우가 있다 → 클릭이 끝난 시점에 한 번 더 올린다
  const ids = nodeIds.slice();
  if (raiseRetryTimer !== null) clearTimeout(raiseRetryTimer);
  raiseRetryTimer = setTimeout(() => {
    raiseRetryTimer = null;
    raiseAnnotations(ids);
  }, 120);
}

// before/after에서 바뀐 구간만 추출 (공통 접두/접미 제거)
function computeChangedSegment(before: string, after: string): { beforeSeg: string; afterSeg: string } {
  if (before === after) return { beforeSeg: '', afterSeg: after };
  let start = 0;
  const minLen = Math.min(before.length, after.length);
  while (start < minLen && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  return { beforeSeg: before.slice(start, endB), afterSeg: after.slice(start, endA) };
}

// 코멘트에 표시할 라벨 생성: 변경이 필요한 부분만 "원래 → 변경" 형태로
function buildAnnotationLabel(before: string, after: string): string {
  const seg = computeChangedSegment(before, after);
  const clip = (s: string) => (s.length > 24 ? s.slice(0, 24) + '…' : s);
  // 깔끔한 diff가 안 나오면(전체 변경 등) 변경 후 전체를 표시
  if (!seg.beforeSeg && !seg.afterSeg) {
    return clip(after);
  }
  const b = seg.beforeSeg ? clip(seg.beforeSeg) : '(없음)';
  const a = seg.afterSeg ? clip(seg.afterSeg) : '(삭제)';
  return b + ' → ' + a;
}

// before/after에서 바뀐 글자 구간의 인덱스(before 기준) 반환
function computeChangedRange(before: string, after: string): { start: number; end: number } {
  let start = 0;
  const minLen = Math.min(before.length, after.length);
  while (start < minLen && before[start] === after[start]) start++;
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
function diffSegments(before: string, after: string): Array<{ bStart: number; bEnd: number; aStart: number; aEnd: number }> {
  const n = before.length;
  const m = after.length;
  if (n === 0 && m === 0) return [];
  // dp[i][j] = LCS length of before[i:], after[j:]
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (before[i] === after[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // 백트래킹으로 연속된 비-동일 구간을 세그먼트로 묶기
  const segments: Array<{ bStart: number; bEnd: number; aStart: number; aEnd: number }> = [];
  let i = 0;
  let j = 0;
  let cur: { bStart: number; bEnd: number; aStart: number; aEnd: number } | null = null;
  const close = () => { if (cur) { segments.push(cur); cur = null; } };
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      close();
      i++; j++;
    } else {
      if (!cur) cur = { bStart: i, bEnd: i, aStart: j, aEnd: j };
      if (dp[i + 1][j] >= dp[i][j + 1]) { i++; cur.bEnd = i; }
      else { j++; cur.aEnd = j; }
    }
  }
  while (i < n) { if (!cur) cur = { bStart: i, bEnd: i, aStart: j, aEnd: j }; i++; cur.bEnd = i; }
  while (j < m) { if (!cur) cur = { bStart: i, bEnd: i, aStart: j, aEnd: j }; j++; cur.aEnd = j; }
  close();
  return segments;
}

// 변경 구간 사이의 "공통(안 바뀐) 글자"가 이 이하면 한 덩어리로 합친다.
// LCS가 중간에 우연히 겹치는 한두 글자(예: "하시겠습니까"→"할까요"의 "까") 때문에
// 변경이 둘로 쪼개져 표시되는 걸 방지 — 미리보기 목록처럼 하나로 보이게 한다.
const SEGMENT_MERGE_GAP = 3;

function mergeCloseSegments(
  segs: Array<{ bStart: number; bEnd: number; aStart: number; aEnd: number }>,
  gap: number,
  before: string,
  after: string
): Array<{ bStart: number; bEnd: number; aStart: number; aEnd: number }> {
  if (segs.length <= 1) return segs;
  const merged = [{ ...segs[0] }];
  for (let i = 1; i < segs.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = segs[i];
    const bGap = cur.bStart - prev.bEnd; // 두 변경 사이 안 바뀐 글자 수 (before 기준)
    const aGap = cur.aStart - prev.aEnd; // (after 기준)
    // 변경 사이에 줄바꿈이 있으면 다른 문장/줄로 보고 합치지 않는다 (빈 줄까지 끌려와 한 코멘트로 뭉치는 것 방지)
    const crossesLine =
      LINE_BREAK_CHARS.test(before.slice(prev.bEnd, cur.bStart)) ||
      LINE_BREAK_CHARS.test(after.slice(prev.aEnd, cur.aStart));
    if (!crossesLine && Math.min(bGap, aGap) <= gap) {
      // 사이의 공통 글자까지 포함해 하나로 확장
      prev.bEnd = cur.bEnd;
      prev.aEnd = cur.aEnd;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function isSpaceChar(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
    || c === '\u00A0' || c === '\u2028' || c === '\u2029';
}

// 변경 구간을 단어 경계까지 넓힌다.
// "방범구역"→"경비구역"이 "방범 → 경비"로 조각나거나, "업그레이드"→"업데이트"가
// "그레이드 → 데이트"로 보이지 않게, 양옆의 안 바뀐 글자를 공백/줄바꿈 전까지 포함해
// 단어 전체를 표시한다. (마침표만 바뀐 "(없음) → ." 표시 문제도 함께 해결)
function expandSegmentToWord(
  s: { bStart: number; bEnd: number; aStart: number; aEnd: number },
  before: string,
  after: string
): { bStart: number; bEnd: number; aStart: number; aEnd: number } {
  let { bStart, bEnd, aStart, aEnd } = s;
  while (bStart > 0 && aStart > 0 && before[bStart - 1] === after[aStart - 1] && !isSpaceChar(before[bStart - 1])) {
    bStart--; aStart--;
  }
  while (bEnd < before.length && aEnd < after.length && before[bEnd] === after[aEnd] && !isSpaceChar(before[bEnd])) {
    bEnd++; aEnd++;
  }
  return { bStart, bEnd, aStart, aEnd };
}

// 단어 확장으로 끌려온 "변경과 무관한 꼬리 조사"는 표시에서 떼어낸다.
// 예: "고객인증번호를 → 사용자번호(고객인증번호)를"의 '를' — 양쪽 끝의 공통 글자가
// 조사일 때만 자르므로 실제 변경 내용은 잘리지 않는다. (표시 전용 — 적용 텍스트와 무관)
const TRAILING_PARTICLES = /(에게서|에서|에게|까지|부터|처럼|보다|으로|이나|라도|마저|조차|[을를이가은는과와도만의에로])$/;

function shrinkTrailingParticle(
  s: { bStart: number; bEnd: number; aStart: number; aEnd: number },
  before: string,
  after: string
): { bStart: number; bEnd: number; aStart: number; aEnd: number } {
  const { bStart, bEnd, aStart, aEnd } = s;
  // 끝에서부터 양쪽이 같은(=확장으로 끌려온) 글자 수
  let common = 0;
  while (
    common < bEnd - bStart && common < aEnd - aStart &&
    before[bEnd - 1 - common] === after[aEnd - 1 - common]
  ) common++;
  if (common === 0) return s;
  const m = before.slice(bEnd - common, bEnd).match(TRAILING_PARTICLES);
  if (!m) return s;
  const cut = m[0].length;
  // 조사를 떼고도 양쪽에 내용이 남을 때만 (세그먼트가 비어버리지 않게)
  if (cut >= bEnd - bStart || cut >= aEnd - aStart) return s;
  // 조사를 떼고 남는 차이가 공백뿐이면(따옴표 뒤 띄어쓰기 등) 조사를 남긴다
  // — 안 그러면 '세금계산서” → 세금계산서”'처럼 차이가 안 보이는 표시가 된다
  const stripWs = (str: string) => str.replace(/[\s\u00A0\u200B]/g, '');
  if (stripWs(before.slice(bStart, bEnd - cut)) === stripWs(after.slice(aStart, aEnd - cut))) return s;
  return { bStart, bEnd: bEnd - cut, aStart, aEnd: aEnd - cut };
}

// 단어 경계로 넓힌 뒤 겹치거나 맞닿은 구간을 하나로 합친다.
// 예: "고객인증번호"→"사용자번호(고객인증번호)"는 앞뒤 삽입 2개가 같은 단어로 넓혀져 겹친다.
function mergeOverlappingSegments(
  segs: Array<{ bStart: number; bEnd: number; aStart: number; aEnd: number }>
): Array<{ bStart: number; bEnd: number; aStart: number; aEnd: number }> {
  if (segs.length <= 1) return segs;
  const sorted = segs.slice().sort((a, b) => (a.bStart - b.bStart) || (a.aStart - b.aStart));
  const out = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.bStart <= prev.bEnd && cur.aStart <= prev.aEnd) {
      prev.bEnd = Math.max(prev.bEnd, cur.bEnd);
      prev.aEnd = Math.max(prev.aEnd, cur.aEnd);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

// 세그먼트 라벨: "원래 → 변경" (줄바꿈은 ↵로 표시해 차이가 눈에 보이게)
function buildSegmentLabel(beforeSeg: string, afterSeg: string): string {
  const clip = (s: string) => {
    const t = s.replace(/[\n\r\u2028\u2029]/g, '↵');
    return t.length > 24 ? t.slice(0, 24) + '…' : t;
  };
  const b = beforeSeg ? clip(beforeSeg) : '(없음)';
  const a = afterSeg ? clip(afterSeg) : '(삭제)';
  return b + ' → ' + a;
}

// 이미 로드한 폰트는 다시 await하지 않는다 (로드 자체는 idempotent지만 매번 await하면 누적 비용이 큼)
const loadedFontKeys = new Set<string>();
async function loadFontCached(f: any): Promise<void> {
  if (!f || !f.family) return;
  const k = f.family + ' ' + f.style;
  if (loadedFontKeys.has(k)) return;
  try { await figma.loadFontAsync(f); loadedFontKeys.add(k); } catch (_e) {}
}

// 노드에 사용된 모든 폰트 로드 (setRangeFills 전 필요)
async function loadAllNodeFonts(node: any): Promise<void> {
  try {
    const len = node.characters ? node.characters.length : 0;
    if (len === 0) return;
    const fonts = node.getRangeAllFontNames(0, len);
    for (const f of fonts) {
      await loadFontCached(f);
    }
  } catch (_e) {}
}

// 변경 구간의 기준 스타일 추출
function getRangeStyle(node: any, idx: number): { font: any; size: number; ls: any; lineHeight: any; textCase: any } {
  const MIXED = (figma as any).mixed;
  let font = node.fontName;
  if (font === MIXED) {
    try { font = node.getRangeFontName(idx, idx + 1); } catch (_e) { font = null; }
    if (!font || font === MIXED) {
      try { font = node.getRangeAllFontNames(0, node.characters.length)[0]; } catch (_e) { font = null; }
    }
  }
  let size = node.fontSize;
  if (size === MIXED) {
    try { size = node.getRangeFontSize(idx, idx + 1); } catch (_e) { size = 16; }
    if (size === MIXED) size = 16;
  }
  let ls = node.letterSpacing;
  if (ls === MIXED) {
    try { ls = node.getRangeLetterSpacing(idx, idx + 1); } catch (_e) { ls = null; }
    if (ls === MIXED) ls = null;
  }
  let lineHeight = node.lineHeight;
  if (lineHeight === MIXED) {
    try { lineHeight = node.getRangeLineHeight(idx, idx + 1); } catch (_e) { lineHeight = null; }
    if (lineHeight === MIXED) lineHeight = null;
  }
  let textCase = node.textCase;
  if (textCase === MIXED) {
    try { textCase = node.getRangeTextCase(idx, idx + 1); } catch (_e) { textCase = null; }
    if (textCase === MIXED) textCase = null;
  }
  return { font, size, ls, lineHeight, textCase };
}

// 변경 세그먼트들의 화면상 위치/크기를 동기 측정 (줄바꿈/정렬/멀티라인 정확 대응)
// 방법: 원본과 같은 너비의 클론으로 줄바꿈을 복제 -> 줄 높이로 줄 번호 산출,
//       단일라인 임시 노드로 줄 안에서의 x 오프셋 측정. (absoluteRenderBounds는 실행 중 null이라 사용 불가)
type Box = { x: number; y: number; w: number; h: number };

async function measureSegments(
  node: any,
  before: string,
  segs: Array<{ bStart: number; bEnd: number; aStart: number; aEnd: number }>,
  absX: number,
  absY: number,
  scratch: any
): Promise<Array<{ anchor: Box; rects: Box[] } | null>> {
  const out: Array<{ anchor: Box; rects: Box[] } | null> = segs.map(() => null);
  let clone: any = null;
  // 임시 측정 노드는 호출자가 만들어 재사용한다 (항목마다 createText/remove하면 매우 느림)
  const t: any = scratch;
  try {
    await loadAllNodeFonts(node);
    const { font, size, ls, lineHeight, textCase } = getRangeStyle(node, 0);
    const align = node.textAlignHorizontal;
    const vAlign = node.textAlignVertical;
    const origW = node.width;
    const nodeH = node.height;
    const len = before.length;

    // 단일 라인 폭/높이 측정 (폰트 메트릭 기반) — 재사용 노드를 이 노드 스타일로 다시 설정
    if (font) t.fontName = font;
    t.fontSize = size || 16;
    if (ls) { try { t.letterSpacing = ls; } catch (_e) {} }
    if (lineHeight) { try { t.lineHeight = lineHeight; } catch (_e) {} }
    if (textCase) { try { t.textCase = textCase; } catch (_e) {} }
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
    const ANCHOR = " ";
    t.characters = ANCHOR;
    const anchorW = t.width;
    const lineH = t.height || (size || 16) * 1.3;
    const adv = (s: string): number => {
      if (!s) return 0;
      t.characters = s + ANCHOR;
      return t.width - anchorW;
    };

    // 한 줄에 들어가는 텍스트면 클론/줄바꿈 계산을 통째로 건너뛴다 (대부분의 UX 문구가 한 줄 → 큰 속도 이득).
    const fullW = adv(before);
    const singleLine = before.indexOf('\n') === -1 && fullW <= origW + 1;

    let realLineH = lineH;
    let totalLines = 1;
    // 줄바꿈 계산용(멀티라인일 때만 채워짐)
    let linesUpTo: (p: number) => number = () => 1;
    let firstK: (L: number) => number = () => 0;
    let lineTopOffset: (L: number) => number = () => 0;

    if (!singleLine) {
      // 줄바꿈을 원본과 동일하게 재현하기 위한 클론 (너비 고정)
      clone = node.clone();
      figma.currentPage.appendChild(clone);
      try { clone.effects = []; } catch (_e) {}
      try { clone.strokes = []; } catch (_e) {}
      // 잘림/최대 줄 수가 걸려 있으면 자동 높이가 안 먹어 클론 높이가 박스 전체로 측정된다.
      try { clone.textTruncation = 'DISABLED'; } catch (_e) {}
      try { clone.maxLines = null; } catch (_e) {}
      try { clone.textAutoResize = 'HEIGHT'; } catch (_e) {}
      try { clone.resize(origW, clone.height); } catch (_e) {}

      // 줄 높이: 한 줄인 임시 노드 기준. 클론으로 재보되 비정상(>1.8배)이면 버린다.
      try {
        clone.characters = '가';
        const ch = clone.height;
        if (ch > 0 && ch < lineH * 1.8) realLineH = ch;
      } catch (_e) {}

      // clone.characters 대입은 매번 레이아웃을 다시 계산해 비싸다.
      // 같은 인덱스를 이진 탐색이 반복 조회하므로 결과를 메모이즈해 대입 횟수를 줄인다.
      const linesMemo = new Map<number, number>();
      linesUpTo = (p: number): number => {
        if (p <= 0) return 0;
        const hit = linesMemo.get(p);
        if (hit !== undefined) return hit;
        clone.characters = before.slice(0, p);
        const v = Math.max(1, Math.round(clone.height / realLineH));
        linesMemo.set(p, v);
        return v;
      };
      const firstKMemo = new Map<number, number>();
      firstK = (L: number): number => {
        const hit = firstKMemo.get(L);
        if (hit !== undefined) return hit;
        let lo = 0, hi = len;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (linesUpTo(mid) >= L) hi = mid; else lo = mid + 1;
        }
        firstKMemo.set(L, lo);
        return lo;
      };
      // 줄 L의 상단 y 오프셋 = 그 앞의 (L-1)개 줄 높이.
      // firstK(L)은 'L번째 줄의 첫 글자' 인덱스라, 그 글자를 빼야(=firstK(L)-1) (L-1)줄 높이가 된다.
      const offsetMemo = new Map<number, number>();
      lineTopOffset = (L: number): number => {
        if (L <= 1) return 0;
        const hit = offsetMemo.get(L);
        if (hit !== undefined) return hit;
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
      if (vAlign === 'CENTER') extraTop = extra / 2;
      else if (vAlign === 'BOTTOM') extraTop = extra;
      textTop = absY + extraTop;

      let rb: any = null;
      try { rb = node.absoluteRenderBounds; } catch (_e) {}
      if (rb && typeof rb.y === 'number' && typeof rb.height === 'number') {
        const inkPerLine = rb.height / Math.max(1, totalLines);
        const topGap = Math.max(0, (realLineH - inkPerLine) / 2);
        textTop = rb.y - topGap;
      }
    }

    // 한 줄 [a,e) 안에서 [segStart, segEnd] 구간이 차지하는 박스 (y는 호출자가 전달)
    const makeBox = (a: number, e: number, segStart: number, segEnd: number, yTop: number): Box => {
      if (before[a] === '\n') a += 1; // 줄 경계의 \n은 다음 줄 시작 문자이므로 건너뜀
      const cs = Math.min(Math.max(segStart, a), e);
      const ce = Math.min(Math.max(segEnd, a), e);
      const xStartInLine = adv(before.slice(a, cs));
      const xEndInLine = adv(before.slice(a, ce));
      const lineW = (a === 0 && e === len) ? fullW : adv(before.slice(a, e));
      let leftEdge = 0;
      if (align === 'CENTER') leftEdge = (origW - lineW) / 2;
      else if (align === 'RIGHT') leftEdge = origW - lineW;
      return { x: absX + leftEdge + xStartInLine, y: yTop, w: Math.max(1, xEndInLine - xStartInLine), h: realLineH };
    };

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const startPos = s.bStart;
      const endPos = Math.max(s.bEnd, s.bStart);

      const rects: Box[] = [];
      if (singleLine) {
        // 클론 없이 한 박스로
        rects.push(makeBox(0, len, startPos, endPos, textTop));
      } else {
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
  } catch (e) {
    console.log('[UX-HL] measureSegments error', e);
  } finally {
    if (clone) { try { clone.remove(); } catch (_e) {} }
    // 재사용 노드(t)는 여기서 지우지 않는다 — 호출자가 마지막에 한 번만 제거
  }
  return out;
}

// 형광펜 박스 생성 (key = HL_INFIX + nodeId + SEG_SEP + segIdx)
// geom은 해당 줄의 영역(높이=lineH). 줄 높이를 넘지 않게 살짝만 여백.
function createHighlightRect(
  key: string, geom: { x: number; y: number; w: number; h: number }, absX: number, absY: number
): void {
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
    if (!annotationsVisible) hl.visible = false;
    hl.locked = true;
    annotationOffset.set(key, { dx: boxX - absX, dy: boxY - absY });
    registerAnnotation(hl);
  } catch (_e) {}
}

// 코멘트 말풍선 생성 (해당 세그먼트 바로 위에 배치)
// 배경 사각형 + 텍스트를 "그룹"으로 묶는다. 그룹은 프레임과 달리 캔버스에 상시 이름표가 안 뜨고
// (선택/호버 시에만 잠깐 보임), 클릭 한 번에 통째로 선택돼 앞으로 가져오기 좋다.
function createCommentFrame(
  key: string, label: string, fontName: { family: string; style: string },
  anchorX: number, anchorY: number, absX: number, absY: number
): void {
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
    if (!annotationsVisible) group.visible = false;
    // 잠그지 않는다: 클릭으로 선택돼야 "그 코멘트만 선명" 동작이 작동한다.
    // 클릭 직후 selectionchange 핸들러가 선택을 즉시 비워 크기 배지는 뜨지 않는다.
    group.locked = false;

    // 그룹 하나만 추적 (배경/텍스트는 그룹 안에 있어 함께 이동·제거됨)
    tagAnnotation(group, key);
    annotationOffset.set(key, { dx: group.x - absX, dy: group.y - absY });
    registerAnnotation(group);
  } catch (_e) {}
}

// 한 노드의 어노테이션 "그릴 내용"만 측정해서 모은다 (실제 노드 생성은 안 함 → 화면에 안 나타남)
type DrawJob = {
  nodeId: string;
  absX: number;
  absY: number;
  highlights: Array<{ key: string; geom: Box }>;
  comments: Array<{ key: string; label: string; anchorX: number; anchorY: number }>;
};

// 네이티브 어노테이션(코멘트) 상태 — nodeId 기준
// (코멘트를 씬 노드 대신 Figma 기본 주석으로 달면 클릭해도 크기 배지가 뜨지 않는다)
const annotatedNodeIds = new Set<string>();
const nativeAnnotationLabels = new Map<string, string>(); // 숨기기 토글 복원용

function setNativeAnnotation(nodeId: string, labelMarkdown: string): void {
  const node = annotationNodeCache.get(nodeId);
  if (!node || node.removed) return;
  try {
    node.annotations = [{ labelMarkdown }];
    annotatedNodeIds.add(nodeId);
    nativeAnnotationLabels.set(nodeId, labelMarkdown);
  } catch (e) {
    console.log('[UX-ANN] 네이티브 어노테이션 설정 실패', e);
  }
}

function clearNativeAnnotation(nodeId: string): void {
  const node = annotationNodeCache.get(nodeId);
  try {
    if (node && !node.removed && annotatedNodeIds.has(nodeId)) node.annotations = [];
  } catch (_e) {}
  annotatedNodeIds.delete(nodeId);
  nativeAnnotationLabels.delete(nodeId);
}

async function measureAnnotation(item: { nodeId: string; before: string; after: string; x: number; y: number }, scratch: any): Promise<DrawJob | null> {
  // 기존 어노테이션(코멘트 + 형광펜, 모든 세그먼트) 제거
  removeAnnotationByNodeId(item.nodeId);

  let node: any = null;
  try { node = await figma.getNodeByIdAsync(item.nodeId); } catch (_e) {}
  if (!node) return null;

  annotationNodeCache.set(item.nodeId, node);
  const ancestors = new Set<string>();
  let cur: any = node;
  while (cur && cur.type !== 'PAGE') {
    if (cur.id) ancestors.add(cur.id);
    cur = cur.parent;
  }
  annotationAncestorIds.set(item.nodeId, ancestors);
  // 역방향 인덱스 갱신 (documentchange에서 "움직인 프레임 → 영향받는 텍스트" 조회용)
  for (const aid of ancestors) {
    let set = ancestorToTracked.get(aid);
    if (!set) { set = new Set(); ancestorToTracked.set(aid, set); }
    set.add(item.nodeId);
  }

  const absX = item.x;
  const absY = item.y;

  const segs = mergeOverlappingSegments(
    mergeCloseSegments(diffSegments(item.before, item.after), SEGMENT_MERGE_GAP, item.before, item.after)
      .map((s) => expandSegmentToWord(s, item.before, item.after))
  ).map((s) => shrinkTrailingParticle(s, item.before, item.after));
  if (segs.length === 0) return null;
  const geoms = await measureSegments(node, item.before, segs, absX, absY, scratch);

  const job: DrawJob = { nodeId: item.nodeId, absX, absY, highlights: [], comments: [] };
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

async function createAnnotations(
  previewData: Array<{ nodeId: string; before: string; after: string; x: number; y: number }>,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const fontName = await ensureAnnotationFont();
  if (!fontName) return;

  // 1) 측정 단계 (비동기): 위치만 계산하고 화면엔 아무것도 안 그린다
  // 임시 측정 노드를 하나만 만들어 모든 항목이 재사용 (항목마다 createText/remove 하던 비용 제거)
  const jobs: DrawJob[] = [];
  const total = previewData.length;
  const scratch = figma.createText();
  try {
    for (let i = 0; i < total; i++) {
      const job = await measureAnnotation(previewData[i], scratch);
      if (job) jobs.push(job);
      if (onProgress && (i + 1 === total || (i + 1) % 5 === 0)) onProgress(i + 1, total);
    }
  } finally {
    try { scratch.remove(); } catch (_e) {}
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

function removeAnnotations(): void {
  for (const nodeId of Array.from(annotatedNodeIds)) clearNativeAnnotation(nodeId);
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
const applyingNodeIds = new Set<string>();

// 어노테이션 위치 추적 — 폴링이 아니라 documentchange 이벤트 기반.
// (예전 250ms 폴링은 어노테이션이 수천 개면 캔버스가 가만히 있어도 매 틱마다
//  좌표 읽기/비교 브리지 호출을 쏟아내 100개 화면 검토 시 캔버스 렉의 원인이 됐다.
//  이제 실제로 노드가 움직였을 때, 영향받는 텍스트의 어노테이션만 갱신한다.)
let repositionPending: Set<string> | null = null;
let repositionFlushTimer: ReturnType<typeof setTimeout> | null = null;

// 지정한 대상 노드들의 어노테이션만 위치 갱신
function repositionAnnotationsFor(nodeIds: string[]): void {
  for (const nodeId of nodeIds) {
    const arr = annotationsByNode.get(nodeId);
    if (!arr) continue;
    const node = annotationNodeCache.get(nodeId);
    let pos: { x: number; y: number } | null = null;
    if (node) {
      try {
        if (node.removed) {
          annotationNodeCache.delete(nodeId);
        } else {
          const at = node.absoluteTransform;
          pos = at ? { x: at[0][2], y: at[1][2] } : { x: node.x || 0, y: node.y || 0 };
        }
      } catch (_e) {
        annotationNodeCache.delete(nodeId);
      }
    }

    // 살아있는 어노테이션만 남기며(제거된 건 정리) 위치 갱신
    let alive = 0;
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (!entry.ann || entry.ann.removed) continue;
      arr[alive++] = entry;
      if (!pos) continue;
      const off = annotationOffset.get(entry.key);
      if (!off) continue;
      const newX = pos.x + off.dx;
      const newY = pos.y + off.dy;
      try {
        // 달라졌을 때만 쓴다 — 우리가 쓴 좌표가 다시 documentchange를 일으켜도
        // 다음 갱신에서 값이 같아 멈춘다 (이벤트 루프 방지)
        if (Math.abs(entry.ann.x - newX) > 0.5 || Math.abs(entry.ann.y - newY) > 0.5) {
          entry.ann.x = newX;
          entry.ann.y = newY;
        }
      } catch (_e) {}
    }
    arr.length = alive;
    if (alive === 0) annotationsByNode.delete(nodeId);
  }
}

// 움직인 노드들을 모아 100ms에 한 번만 갱신 (드래그 중 이벤트 폭주 대비)
function scheduleReposition(nodeIds: Set<string>): void {
  if (!repositionPending) repositionPending = new Set();
  for (const id of nodeIds) repositionPending.add(id);
  if (repositionFlushTimer) return;
  repositionFlushTimer = setTimeout(() => {
    repositionFlushTimer = null;
    const ids = repositionPending;
    repositionPending = null;
    if (ids && ids.size > 0) repositionAnnotationsFor(Array.from(ids));
  }, 100);
}

function cancelPendingReposition(): void {
  if (repositionFlushTimer !== null) {
    clearTimeout(repositionFlushTimer);
    repositionFlushTimer = null;
  }
  repositionPending = null;
}

// 어노테이션 표시 상태
let annotationsVisible = true;

// 어노테이션 토글
function toggleAnnotations(): void {
  annotationsVisible = !annotationsVisible;
  for (const ann of getAllAnnotations()) {
    ann.visible = annotationsVisible;
  }
  // 네이티브 어노테이션은 visible 속성이 없어 제거/복원으로 토글한다
  if (annotationsVisible) {
    for (const [nodeId, md] of nativeAnnotationLabels) {
      const node = annotationNodeCache.get(nodeId);
      if (!node || node.removed) continue;
      try { node.annotations = [{ labelMarkdown: md }]; annotatedNodeIds.add(nodeId); } catch (_e) {}
    }
  } else {
    for (const nodeId of Array.from(annotatedNodeIds)) {
      const node = annotationNodeCache.get(nodeId);
      try { if (node && !node.removed) node.annotations = []; } catch (_e) {}
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

function handleNodeChanges(changes: any[]): void {
  const moved = new Set<string>();
  for (const change of changes) {
    if (!change || change.type !== 'PROPERTY_CHANGE') continue;
    const props: string[] = Array.isArray(change.properties) ? change.properties : [];

    // ② 기하 변경 → 이 노드를 조상으로 둔 추적 텍스트들만 골라 위치 갱신 예약
    if (ancestorToTracked.size > 0 && props.some((p) => GEOMETRY_PROPS.has(p))) {
      const tracked = ancestorToTracked.get(change.id);
      if (tracked) {
        for (const t of tracked) moved.add(t);
      }
      // 코멘트/형광펜 자체를 끌었으면 제자리로 되돌리기 위해 갱신 예약
      const byAnn = annIdToTracked.get(change.id);
      if (byAnn) moved.add(byAnn);
    }

    // ① 텍스트 내용 변경 → 어노테이션 제거
    if (
      change.node?.type === 'TEXT' &&
      props.includes('characters')
    ) {
      const nodeId = change.node.id;
      if (applyingNodeIds.has(nodeId)) continue;

      if (findAnnotation(nodeId)) {
        removeAnnotationByNodeId(nodeId);
        figma.ui.postMessage({ type: 'remove-changed-items', changedNodeIds: [nodeId] });
      }
    }
  }
  if (moved.size > 0) scheduleReposition(moved);
}

// 페이지별 nodechange 구독 (중복 구독 방지). 페이지를 옮기면 새 페이지도 구독한다.
const nodeChangeSubscribedPages = new Set<string>();

function subscribeNodeChange(page: any): void {
  if (!page || !page.id || nodeChangeSubscribedPages.has(page.id)) return;
  try {
    page.on('nodechange', (event: any) => {
      if (event && event.nodeChanges) handleNodeChanges(event.nodeChanges);
    });
    nodeChangeSubscribedPages.add(page.id);
  } catch (e) {
    console.log('[UX-ANN] nodechange 구독 실패', e);
  }
}

subscribeNodeChange(figma.currentPage);
try {
  (figma as any).on('currentpagechange', () => subscribeNodeChange(figma.currentPage));
} catch (_e) {}

// 플러그인 닫힐 때 어노테이션 자동 제거
(figma as any).on('close', () => {
  removeAnnotations();
});

// PREVIEW에서 찾은 노드들을 캐시 (FOCUS_NODE에서 사용)
const previewNodeCache = new Map<string, TextNode>();


// 메시지 수신: UI 버튼 클릭 → 실행
figma.ui.onmessage = async (msg: any) => {
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
    const textNodes: TextNode[] = [];
    const totalSelectionNodes = selection.length;
    
    // 각 선택된 노드에 대해 진행률 업데이트하면서 찾기
    for (let i = 0; i < selection.length; i++) {
      const node = selection[i];
      const nodeIndex = i; // 클로저 문제 방지
      
      // 진행률 업데이트 콜백 함수
      const progressCallback = (nodeProgress: number) => {
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
    
    const previewData: Array<{ nodeId: string; nodeName: string; before: string; after: string; reason: string; y: number; x: number; frameId: string; frameName: string; frameX: number; frameY: number }> = [];
    const nodesToSelect: TextNode[] = [];
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
      const preferredSuggestion = suggestions.find((s) => s.tags.includes("button")) ?? suggestions[0];
      const after = preferredSuggestion ? preferredSuggestion.after : spell.text;
      // 사유: 맞춤법(네이버) + 톤/규칙 사유 합치기 (UI는 ' - '로 분리 표시)
      const reasonParts = spell.reasons.slice();
      if (preferredSuggestion && preferredSuggestion.reason) reasonParts.push(preferredSuggestion.reason);
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
          } else {
            x = (node as any).x || 0;
            y = (node as any).y || 0;
          }
        } catch (e) {
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
          let cur: any = node;
          while (cur.parent && cur.parent.type !== 'PAGE') cur = cur.parent;
          if (cur && cur.id) {
            frameId = cur.id;
            frameName = cur.name || '';
            // 페이지 직속 노드라 x/y가 곧 캔버스 좌표
            if (typeof cur.x === 'number') frameX = cur.x;
            if (typeof cur.y === 'number') frameY = cur.y;
          }
        } catch (_e) {}

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
        if (Math.abs(a.frameY - b.frameY) > 1) return a.frameY - b.frameY;
        if (Math.abs(a.frameX - b.frameX) > 1) return a.frameX - b.frameX;
      }
      if (Math.abs(a.y - b.y) > 1) return a.y - b.y;
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
    } catch (annErr) {
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
      const targetNodeIds = new Set<string>();
      for (const item of previewData) {
        targetNodeIds.add(item.nodeId);
      }


    // 미리보기 데이터를 맵으로 변환 (nodeId를 키로)
    const previewMap = new Map<string, { before: string; after: string }>();
    for (const item of previewData) {
      previewMap.set(item.nodeId, { before: item.before, after: item.after });
    }

    const changedNodeIds = new Set<string>();

    // 진행률 업데이트 (노드 찾기 시작)
    figma.ui.postMessage({
      type: 'update-progress',
      progress: 10,
      status: '변경할 노드 찾는 중...'
    });

    // 변경할 노드들 수집 (dynamic-page에서는 동기 getNodeById가 동작 안 함 → async 사용)
    // getNodeByIdAsync는 선택 상태와 무관하게 id로 찾으므로, 못 찾으면 노드가 삭제된 것 → 건너뛰고 나중에 알림
    const nodesToChange: TextNode[] = [];
    const totalTargetNodes = targetNodeIds.size;
    let processedCount = 0;
    for (const nodeId of targetNodeIds) {
      try {
        const nodeById = await figma.getNodeByIdAsync(nodeId);
        if (nodeById && nodeById.type === "TEXT") {
          nodesToChange.push(nodeById as TextNode);
        }
      } catch (e) {
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
    const fontsToLoad = new Map<string, FontName>();
    for (const node of nodesToChange) {
      if (node.fontName !== figma.mixed) {
        const font = node.fontName as FontName;
        const key = font.family + "::" + font.style;
        fontsToLoad.set(key, font);
      } else {
        // mixed 폰트: 글자 단위로 모든 폰트 수집
        try {
          const len = node.characters.length;
          for (let i = 0; i < len; i++) {
            const fn = node.getRangeFontName(i, i + 1);
            if (fn !== figma.mixed) {
              const font = fn as FontName;
              const key = font.family + "::" + font.style;
              fontsToLoad.set(key, font);
            }
          }
        } catch (_e) {
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
      } catch (_e) {
        // 개별 노드 변경 실패 시 계속 진행
      } finally {
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
    let message: string;
    if (changedNodeIds.size > 0 && skippedCount === 0) {
      message = changedNodeIds.size === 1
        ? '변경이 완료되었어요.'
        : `${changedNodeIds.size}건이 변경 완료되었어요.`;
    } else if (changedNodeIds.size > 0) {
      message = `${changedNodeIds.size}건 적용 완료. ${skippedCount}건은 검토 후 텍스트가 바뀌었거나 삭제되어 적용하지 못했어요.`;
    } else {
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
    } catch (e) {
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
      let pos: { x: number; y: number } | null = null;
      try { pos = figma.ui.getPosition().canvasSpace; } catch (_e) { pos = null; }
      figma.ui.resize(w, h);
      if (pos) {
        const zoom = figma.viewport.zoom || 1;
        let nx = pos.x;
        let ny = pos.y;
        if (msg.anchorRight) nx = pos.x + (uiLastW - w) / zoom;   // 오른쪽 가장자리 고정 → 왼쪽으로 확장
        if (msg.anchorBottom) ny = pos.y + (uiLastH - h) / zoom;  // 아래 가장자리 고정 → 위로 확장
        try { figma.ui.reposition(nx, ny); } catch (_e) {}
      }
    } else {
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
    const ids: string[] = msg.nodeIds || [];
    for (const id of ids) removeAnnotationByNodeId(id);
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
      let node: TextNode | null = previewNodeCache.get(nodeId) || null;
      
      // 2. 캐시에 없으면 getNodeByIdAsync로 찾기 (dynamic-page에서는 동기 getNodeById가 동작 안 함)
      if (!node) {
        try {
          const nodeById = await figma.getNodeByIdAsync(nodeId);
          if (nodeById && nodeById.type === "TEXT") {
            node = nodeById as TextNode;
          }
        } catch (e) {
          // 조회 실패 시 무시
        }
      }

      // 3. 노드를 찾았으면 선택 및 뷰포트 이동
      if (node && node.type === "TEXT" && !(node as any).removed) {
        // 해당 노드 선택
        figma.currentPage.selection = [node];

        // 뷰포트 이동 및 확대
        figma.viewport.scrollAndZoomIntoView([node]);

        // 해당 코멘트를 맨 앞으로 (selectionchange에 의존하지 않고 직접 호출)
        bringAnnotationsToFront([nodeId]);
      }
    } catch (e) {
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
      const nodesToSelect: TextNode[] = [];
      for (const nodeId of nodeIds) {
        // 1. 캐시에서 찾기
        let node = previewNodeCache.get(nodeId) || null;
        
        // 2. 캐시에 없으면 getNodeByIdAsync로 찾기 (dynamic-page에서는 동기 getNodeById가 동작 안 함)
        if (!node) {
          try {
            const nodeById = await figma.getNodeByIdAsync(nodeId);
            if (nodeById && nodeById.type === "TEXT") {
              node = nodeById as TextNode;
            }
          } catch (e) {
            // 무시
          }
        }

        if (node && !(node as any).removed) {
          nodesToSelect.push(node);
        }
      }

      // 선택된 노드들을 Figma에서 선택
      // (뷰포트 이동은 하지 않는다 — 전체 선택 시 캔버스가 첫 노드로 튕기는 문제.
      //  카드 클릭으로 이동하는 건 FOCUS_NODE가 담당)
      if (nodesToSelect.length > 0) {
        figma.currentPage.selection = nodesToSelect;
      }
    } catch (e) {
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
    const bridge = await isBridgeAlive();
    if (!bridge) {
      // 클로드를 못 쓰는 상태 — 예시·규칙 폴백 (forceAi여도 폴백이라도 보여준다)
      postRecommendFallback(text, '');
      return;
    }
    // AI 추천은 진행률을 알 수 없다(다 만들어지면 한 번에 옴) → 가짜 %가 아니라 경과 시간 기반 표시.
    figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '클로드가 문구를 다듬는 중이에요' });
    try {
      const suggestions = await fetchAiSuggestions(text, msg.model);
      figma.ui.postMessage({ type: 'hide-loading' });
      // forceAi([AI 추천 더 받기])면 기존 결과 아래에 덧붙이고, 아니면 새로 표시
      figma.ui.postMessage({ type: 'recommend-result', original: text, suggestions, appendAi: !!msg.forceAi });
    } catch (e) {
      figma.ui.postMessage({ type: 'hide-loading' });
      if (msg.forceAi) figma.ui.postMessage({ type: 'show-toast', message: errStr(e) });
      else postRecommendFallback(text, errStr(e), undefined, true); // AI 실패 → 폴백 + 재시도 버튼
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
      const bridge = await isBridgeAlive();
      if (!bridge) {
        figma.ui.postMessage({ type: 'show-toast', message: '번역하려면 클로드가 필요해요 — [클로드] 버튼으로 켜 주세요.' });
        return;
      }
      figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '클로드가 번역하는 중이에요' });
      const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/translate', { text, model: msg.model }, 130000);
      const data = await res.json();
      figma.ui.postMessage({ type: 'hide-loading' });
      if (!res.ok || data.error || !data.translated) {
        figma.ui.postMessage({ type: 'show-toast', message: '번역 실패: ' + (data && data.error ? data.error : ('HTTP ' + res.status)) });
        return;
      }
      figma.ui.postMessage({ type: 'translate-result', original: text, translated: data.translated, direction: data.direction || '' });
    } catch (e) {
      figma.ui.postMessage({ type: 'hide-loading' });
      figma.ui.postMessage({ type: 'show-toast', message: '번역 실패: ' + errStr(e) });
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
    } catch (e) {
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
        before: msg.before || '',   // 원본 문구
        after: msg.after || '',     // 좋아요한 추천 문구
        reason: '추천 좋아요',       // sync-feedback.js가 이 값으로 좋아요를 식별한다 — 바꾸면 스크립트도 같이
        comment: msg.comment || '', // AI가 붙인 추천 사유
        fileName: (figma.root && figma.root.name) || '',
      };
      const res = await postJsonWithTimeout(REPORT_URL, payload, 15000);
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && !(data && data.error);
      figma.ui.postMessage({ type: 'like-result', key: msg.key, ok, error: ok ? '' : ((data && data.error) || ('HTTP ' + res.status)) });
    } catch (e) {
      figma.ui.postMessage({ type: 'like-result', key: msg.key, ok: false, error: errStr(e) });
    }
    return;
  }

  // 클로드 다리 상태 조회 — UI의 [🔌 클로드] 버튼 표시/깨우기 피드백용
  if (msg.type === "CHECK_BRIDGE") {
    const h = await bridgeHealth();
    figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem });
    return;
  }
  // 클로드 다리 끄기 — [🟢 클로드 켜짐] 버튼을 다시 누르면 호출 (다리의 자기 종료 API)
  if (msg.type === "STOP_BRIDGE") {
    try { await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/shutdown', {}, 3000); } catch (_e) { /* 이미 꺼져 있으면 무시 */ }
    // 다리는 응답 후 스스로 종료(약 200ms) — 잠깐 기다렸다 실제로 꺼졌는지 확인해 회신
    await new Promise((r) => setTimeout(r, 700));
    let h = await bridgeHealth();
    if (h.alive) { await new Promise((r) => setTimeout(r, 800)); h = await bridgeHealth(); }
    figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem, stopped: !h.alive });
    return;
  }
  // 클로드다리 설치 파일 요청 — UI가 base64를 받아 다운로드로 내려준다 (새 PC 첫 설정용)
  if (msg.type === "GET_INSTALLER") {
    figma.ui.postMessage({ type: 'installer-file', b64: INSTALLER_B64 });
    return;
  }
};
