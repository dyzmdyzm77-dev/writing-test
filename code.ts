// /// <reference types="@figma/plugin-typings" />

// 타입 정의 (Figma 플러그인 환경에서 제공됨)
declare const __html__: string;

// Figma 플러그인 타입 정의 (타입 패키지가 없을 경우를 대비)
declare const figma: {
  showUI: (html: string, options?: { width?: number; height?: number }) => void;
  ui: {
    postMessage: (message: any) => void;
    onmessage: (callback: (message: any) => void | Promise<void>) => void;
    resize: (width: number, height: number) => void;

  };
  currentPage: {
    selection: any[];
    children: any[];
    appendChild: (node: any) => void;
  };
  notify: (message: string) => void;
  getNodeById: (id: string) => any | null;
  getNodeByIdAsync: (id: string) => Promise<any | null>;
  viewport: {
    scrollAndZoomIntoView: (nodes: any[]) => void;
  };
  loadFontAsync: (fontName: { family: string; style: string }) => Promise<void>;
  createFrame: () => any;
  createRectangle: () => any;
  createText: () => any;
  mixed: symbol;
  on: (event: 'selectionchange' | 'close' | 'documentchange', callback: (event?: any) => void) => void;
};

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
  type: 'PREVIEW' | 'APPLY' | 'CANCEL' | 'TOGGLE_ANNOTATIONS' | 'CLEAR_ANNOTATIONS' | 'RESIZE_UI' | 'FOCUS_NODE' | 'SELECT_NODES' | 'SHOW_LOADING' | 'UPDATE_PROGRESS' | 'HIDE_LOADING';
  data?: PreviewItem[];
  nodeId?: string;
  changedNodeIds?: string[];
  nodeIds?: string[];
  progress?: number;
  status?: string;
}

// Figma 노드 타입 정의
interface SceneNode {
  id: string;
  type: string;
  name: string;
  children?: SceneNode[];
  x?: number;
  y?: number;
}

interface TextNode extends SceneNode {
  type: 'TEXT';
  characters: string;
  fontName: FontName | any;
  fontSize: number;
  getRangeFontName?: (start: number, end: number) => FontName | any;
  getRangeFills?: (start: number, end: number) => any;
  getRangeFontSize?: (start: number, end: number) => number | any;
  getRangeLetterSpacing?: (start: number, end: number) => any;
  getRangeTextDecoration?: (start: number, end: number) => any;
  setRangeFills?: (start: number, end: number, fills: any) => void;
  setRangeFontName?: (start: number, end: number, fontName: FontName) => void;
  setRangeFontSize?: (start: number, end: number, size: number) => void;
  setRangeLetterSpacing?: (start: number, end: number, spacing: any) => void;
  setRangeTextDecoration?: (start: number, end: number, decoration: any) => void;
  absoluteTransform?: number[][];
  deleteCharacters?: (start: number, end: number) => void;
  insertCharacters?: (index: number, characters: string, useStyle?: 'BEFORE_CHARACTER' | 'AFTER_CHARACTER') => void;
}

interface FontName {
  family: string;
  style: string;
}

// UI 띄우기
figma.showUI(__html__, { width: 360, height: 780 });

// 선택 상태 변경 감지
(figma as any).on('selectionchange', () => {
  const selection = figma.currentPage.selection;
  const hasSelection = selection && selection.length > 0;

  // UI에 선택 상태 전송
  figma.ui.postMessage({
    type: 'selection-changed',
    hasSelection: hasSelection
  });

  // 캔버스 선택에 따라 코멘트 투명도 갱신
  try {
    updateAnnotationOpacityFromCanvas(selection || []);
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
  { pattern: "됩니다", replacement: "돼요", description: "해요체로 톤을 맞춰요.", tag: "tone" },
  { pattern: "합니다", replacement: "해요", description: "해요체로 톤을 맞춰요.", tag: "tone" },
  { pattern: "있습니다", replacement: "있어요", description: "해요체로 톤을 맞춰요.", tag: "tone" },
  { pattern: "하시면", replacement: "하면", description: "조건 표현을 더 간결하게 해요.", tag: "shorten" },
  { pattern: "하십시오", replacement: "해주세요", description: "과한 격식을 줄여 자연스럽게 해요.", tag: "tone" },
  { pattern: "관리자 리스트", replacement: "관리자 목록", description: "표준 용어로 통일해요.", tag: "term" },
  { pattern: "자격별", replacement: "권한별", description: "표준 용어로 통일해요.", tag: "term" },
  { pattern: "총 사용자", replacement: "전체 사용자", description: "표준 용어로 통일해요.", tag: "term" },
  { pattern: "휴대폰번호", replacement: "휴대전화번호", description: "표준 용어로 통일해요.", tag: "term" },
  { pattern: "휴대폰", replacement: "휴대전화", description: "표준 용어로 통일해요.", tag: "term" },
  { pattern: "폰번호", replacement: "휴대전화번호", description: "표준 용어로 통일해요.", tag: "term" },
];

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
  { pattern: /\b되요\b/g, replacement: "돼요", reason: "맞춤법을 바로잡아요.", tags: ["typo", "tone"] },
  { pattern: /안되(?=[\s.,!?]|$)/g, replacement: "안 돼", reason: "맞춤법/띄어쓰기를 바로잡아요.", tags: ["typo", "spacing"] },
  { pattern: /\b몇일\b/g, replacement: "며칠", reason: "맞춤법을 바로잡아요.", tags: ["typo"] },
  { pattern: /\b웬지\b/g, replacement: "왠지", reason: "맞춤법을 바로잡아요.", tags: ["typo"] },
  
  // 띄어쓰기 - 조사 앞 (명사+조사 다음에 명사/동사가 올 때)
  // 주의: 외래어나 합성어에 잘못 적용되지 않도록 제한적으로 적용
  // 일반 단어에 잘못 적용되는 문제로 주석 처리
  // { pattern: /([가-힣]{2,})(의)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // { pattern: /([가-힣]{2,})(을|를)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // { pattern: /([가-힣]{2,})(이|가)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // { pattern: /([가-힣]{2,})(은|는)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // { pattern: /([가-힣]{2,})(와|과)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // "에" 조사는 외래어(크리에이터 등)와 구분하기 위해 제외
  // { pattern: /([가-힣]{2,})(에|에서|에게|에게서|로|으로|만|도|까지|부터|처럼|같이|보다|커녕)([가-힣]{2,})/g, replacement: "$1$2 $3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  
  // 띄어쓰기 - "-하다" 형용사 + 종결어미 (불가능합니다, 가능해요 등 - 붙여쓰기)
  { pattern: /(불가능|가능|필요|불필요) (합니다|해요)/g, replacement: "$1$2", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // 띄어쓰기 - 보조동사/의존명사
  { pattern: /할수/g, replacement: "할 수", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /될수/g, replacement: "될 수", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // "~할 수 있", "~길어질 수 있" 등: 앞 단어 + 의존명사 "수" + "있" 분리 (할수있, 수있보다 먼저 적용)
  { pattern: /([가-힣]{1,})(수)(있)/g, replacement: "$1 $2 $3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /할수있/g, replacement: "할 수 있", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /수있/g, replacement: "수 있", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /하시는게/g, replacement: "하는 게", reason: "격식을 줄이고 띄어쓰기를 자연스럽게 해요.", tags: ["spacing", "tone"] },
  { pattern: /하는게/g, replacement: "하는 게", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // 일반 단어에 잘못 적용되는 문제로 주석 처리
  // { pattern: /([가-힣])(것|수|때|곳|데|줄|지|뿐|만큼|대로|듯이|만|뿐)([가-힣])/g, replacement: "$1$2 $3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // { pattern: /([가-힣])(있다|없다|주다|보내다|받다|주시다|드리다|보이다|되다|하다)([가-힣])/g, replacement: "$1 $2$3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  
  // 띄어쓰기 - 일반적인 부사 뒤 띄어쓰기
  // 일반 단어에 잘못 적용되는 문제로 주석 처리
  // { pattern: /바로([가-힣])/g, replacement: "바로 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // { pattern: /여기서([가-힣])/g, replacement: "여기서 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // { pattern: /거기서([가-힣])/g, replacement: "거기서 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // { pattern: /저기서([가-힣])/g, replacement: "저기서 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /지금([가-힣]{2,})/g, replacement: "지금 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // "이미" + 다음 단어 (부사) - "이미지"(image)는 예외
  { pattern: /이미(?!지)([가-힣]{2,})/g, replacement: "이미 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /아직([가-힣]{2,})/g, replacement: "아직 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /곧([가-힣]{2,})/g, replacement: "곧 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /다시([가-힣]{2,})/g, replacement: "다시 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /계속([가-힣]{2,})/g, replacement: "계속 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /항상([가-힣]{2,})/g, replacement: "항상 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // "보통" + 다음 단어 - "정보통신망" 등 합성어는 예외
  { pattern: /보통(?!신)([가-힣]{2,})/g, replacement: "보통 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /가끔([가-힣]{2,})/g, replacement: "가끔 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /자주([가-힣]{2,})/g, replacement: "자주 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /때때로([가-힣]{2,})/g, replacement: "때때로 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /빨리([가-힣]{2,})/g, replacement: "빨리 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /천천히([가-힣]{2,})/g, replacement: "천천히 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /갑자기([가-힣]{2,})/g, replacement: "갑자기 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /같이([가-힣]{2,})/g, replacement: "같이 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /함께([가-힣]{2,})/g, replacement: "함께 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /혼자([가-힣]{2,})/g, replacement: "혼자 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /먼저([가-힣]{2,})/g, replacement: "먼저 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /나중에([가-힣]{2,})/g, replacement: "나중에 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /처음([가-힣]{2,})/g, replacement: "처음 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /마지막([가-힣]{2,})/g, replacement: "마지막 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /오늘([가-힣]{2,})/g, replacement: "오늘 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /내일([가-힣]{2,})/g, replacement: "내일 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /어제([가-힣]{2,})/g, replacement: "어제 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /내년([가-힣]{2,})/g, replacement: "내년 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  { pattern: /작년([가-힣]{2,})/g, replacement: "작년 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // 띄어쓰기 - 층수 + 장소명 (7층 사무실, 3층 회의실 등)
  { pattern: /([0-9]+층)(사무실|회의실|휴게실|복도)([가-힣])/g, replacement: "$1 $2 $3", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // 띄어쓰기 - 수사 + 단위명사 (두 줄)
  { pattern: /두줄/g, replacement: "두 줄", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // 띄어쓰기 - 조사 "로/으로" + 동사 "들어갈"
  { pattern: /(로|으로)(들어갈)/g, replacement: "$1 $2", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // 띄어쓰기 - "정도로" 뒤 (정도로 길어질)
  { pattern: /정도로([가-힣])/g, replacement: "정도로 $1", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  
  // 띄어쓰기 - 일반적인 동사/명사 앞 띄어쓰기
  // 주의: 외래어(크리에이터 등)에 잘못 적용되지 않도록 제한적으로 적용
  // { pattern: /([가-힣]{2,})(시작|종료|완료|중지|재개|변경|수정|삭제|추가|생성|등록|확인|조회|검색|저장|업로드|다운로드|열기|닫기|보기|보내기|받기|전송|수신|발송|접수|처리|승인|거부|반려|취소|해제|설정|해제|초기화|복구|백업|복원|이동|복사|붙여넣기|잠금|잠금해제|공유|다운로드|인쇄|출력|보관|삭제|복원|복구|수정|편집|저장|불러오기|내보내기|가져오기|연결|연결해제|접속|접속해제|로그인|로그아웃|가입|탈퇴|신청|취소|결제|환불|교환|반품|배송|수령|확인|리뷰|평가|추천|신고|차단|해제|차단해제|팔로우|언팔로우|구독|구독해제|알림|알림해제|공지|이벤트|쿠폰|적립|사용|적용|해제|적용해제|변경|변경해제|수정|수정해제|삭제|삭제해제|추가|추가해제|생성|생성해제|등록|등록해제|확인|확인해제|조회|조회해제|검색|검색해제|저장|저장해제|업로드|업로드해제|다운로드|다운로드해제)/g, replacement: "$1 $2", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  
  // 띄어쓰기 - 수사 + 단위명사
  // 주의: "2026년", "6000억원" 등은 일반적으로 붙여쓰기도 허용되므로 주석 처리
  // { pattern: /([0-9]+)(개|명|장|권|대|마리|벌|자루|개월|년|일|시간|분|초|원|달러|엔|위안|파운드|유로|킬로|그램|리터|미터|센티미터|킬로미터|평|제곱미터|세제곱미터)/g, replacement: "$1 $2", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
  // { pattern: /([일이삼사오육칠팔구십백천만억조]+)(개|명|장|권|대|마리|벌|자루|개월|년|일|시간|분|초|원|달러|엔|위안|파운드|유로|킬로|그램|리터|미터|센티미터|킬로미터|평|제곱미터|세제곱미터)/g, replacement: "$1 $2", reason: "띄어쓰기를 자연스럽게 해요.", tags: ["spacing"] },
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
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시려고 → ~하려고
  {
    pattern: /하시려고/g,
    replacement: "하려고",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시려면 → ~하려면
  {
    pattern: /하시려면/g,
    replacement: "하려면",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시려는 → ~하려는
  {
    pattern: /하시려는/g,
    replacement: "하려는",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시다가 → ~하다가
  {
    pattern: /하시다가/g,
    replacement: "하다가",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시던 → ~하던
  {
    pattern: /하시던/g,
    replacement: "하던",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하셨더라도 → ~하더라도
  {
    pattern: /하셨더라도/g,
    replacement: "하더라도",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시고 → ~하고
  {
    pattern: /하시고/g,
    replacement: "하고",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시지만 → ~하지만
  {
    pattern: /하시지만/g,
    replacement: "하지만",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시는지 → ~하는지
  {
    pattern: /하시는지/g,
    replacement: "하는지",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시는가 → ~하는가
  {
    pattern: /하시는가/g,
    replacement: "하는가",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시게 → ~하게
  {
    pattern: /하시게/g,
    replacement: "하게",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // ~하시기 → ~하기
  {
    pattern: /하시기/g,
    replacement: "하기",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // 격식 높임말을 친근하게: ~하시는 → ~하는 (일반 패턴)
  {
    pattern: /하시는/g,
    replacement: "하는",
    reason: "격식을 줄여 더 친근하게 해요.",
    tags: ["tone"],
  },
  // 구조 변환: ~하시면 ~됩니다 → ~하면 ~돼요
  {
    pattern: /(.+?)하시면\s+(.+?)됩니다/g,
    replacement: "$1하면 $2돼요",
    reason: "조건 표현을 더 자연스럽고 간결하게 바꿔요.",
    tags: ["shorten", "tone"],
  },
  // ~할 수 있습니다 → ~할 수 있어요
  {
    pattern: /할 수 있습니다/g,
    replacement: "할 수 있어요",
    reason: "딱딱한 표현을 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~가능합니다 → ~가능해요
  {
    pattern: /가능합니다/g,
    replacement: "가능해요",
    reason: "딱딱한 표현을 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~하시겠습니까? → ~할까요?
  {
    pattern: /하시겠습니까\?/g,
    replacement: "할까요?",
    reason: "질문 표현을 더 자연스럽게 바꿔요.",
    tags: ["tone"],
  },
  // ~하시기 바랍니다 → ~해주세요
  {
    pattern: /하시기 바랍니다/g,
    replacement: "해주세요",
    reason: "딱딱한 요청을 부드럽게 바꿔요.",
    tags: ["tone"],
  },
  // ~하십시오 → ~해주세요 (이미 UX_PATTERNS에 있지만 문장 레벨에서도 처리)
  {
    pattern: /하십시오/g,
    replacement: "해주세요",
    reason: "과한 격식을 줄여 자연스럽게 해요.",
    tags: ["tone"],
  },
  // ~입니까? → ~인가요? / ~예요?
  {
    pattern: /([가-힣]+)입니까\?/g,
    replacement: (match, p1) => {
      const lastChar = p1[p1.length - 1];
      return hasJongseong(lastChar) ? `${p1}인가요?` : `${p1}예요?`;
    },
    reason: "질문 표현을 더 자연스럽게 바꿔요.",
    tags: ["tone"],
  },
  // ~되어야 합니다 → ~되어야 해요
  {
    pattern: /되어야 합니다/g,
    replacement: "되어야 해요",
    reason: "딱딱한 표현을 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~해야 합니다 → ~해야 해요
  {
    pattern: /해야 합니다/g,
    replacement: "해야 해요",
    reason: "딱딱한 표현을 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~하지 않으면 안 됩니다 → ~해야 해요
  {
    pattern: /하지 않으면 안 됩니다/g,
    replacement: "해야 해요",
    reason: "복잡한 표현을 간결하게 바꿔요.",
    tags: ["shorten", "tone"],
  },
  // ~하지 않으면 안 돼요 → ~해야 해요
  {
    pattern: /하지 않으면 안 돼요/g,
    replacement: "해야 해요",
    reason: "복잡한 표현을 간결하게 바꿔요.",
    tags: ["shorten"],
  },
  // ~할 수 없습니다 → ~할 수 없어요
  {
    pattern: /할 수 없습니다/g,
    replacement: "할 수 없어요",
    reason: "딱딱한 표현을 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~하지 마십시오 → ~하지 마세요
  {
    pattern: /하지 마십시오/g,
    replacement: "하지 마세요",
    reason: "딱딱한 금지 표현을 부드럽게 바꿔요.",
    tags: ["tone"],
  },
  // ~하도록 하십시오 → ~하세요
  {
    pattern: /하도록 하십시오/g,
    replacement: "하세요",
    reason: "복잡한 표현을 간결하게 바꿔요.",
    tags: ["shorten", "tone"],
  },
  // ~하시는 것이 좋습니다 → ~하는 게 좋아요
  {
    pattern: /하시는 것이 좋습니다/g,
    replacement: "하는 게 좋아요",
    reason: "격식을 줄이고 조언을 부드럽게 바꿔요.",
    tags: ["tone"],
  },
  // ~하는 것이 좋습니다 → ~하는 게 좋아요
  {
    pattern: /하는 것이 좋습니다/g,
    replacement: "하는 게 좋아요",
    reason: "딱딱한 조언을 부드럽게 바꿔요.",
    tags: ["tone"],
  },
  // ~하는 것이 좋아요 → ~하는 게 좋아요
  {
    pattern: /하는 것이 좋아요/g,
    replacement: "하는 게 좋아요",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["shorten"],
  },
  // ~하는 것이 → ~하는 게
  {
    pattern: /하는 것이/g,
    replacement: "하는 게",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["shorten"],
  },
  // ~하는 것을 → ~하는 걸
  {
    pattern: /하는 것을/g,
    replacement: "하는 걸",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["shorten"],
  },
  // ~하는 것으로 → ~하는 걸로
  {
    pattern: /하는 것으로/g,
    replacement: "하는 걸로",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["shorten"],
  },
  // ~하는 것도 → ~하는 것도 (변경 없음, 예시용)
  // ~하는 것만 → ~하는 것만 (변경 없음, 예시용)
  
  // 더 많은 자연스러운 표현 패턴
  // ~해주시기 바랍니다 → ~해주세요
  {
    pattern: /해주시기 바랍니다/g,
    replacement: "해주세요",
    reason: "딱딱한 요청을 부드럽게 바꿔요.",
    tags: ["tone"],
  },
  // ~해주시기 바라요 → ~해주세요
  {
    pattern: /해주시기 바라요/g,
    replacement: "해주세요",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["tone"],
  },
  // ~하시기 바라요 → ~해주세요
  {
    pattern: /하시기 바라요/g,
    replacement: "해주세요",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["tone"],
  },
  // ~해주시면 됩니다 → ~해주시면 돼요
  {
    pattern: /해주시면 됩니다/g,
    replacement: "해주시면 돼요",
    reason: "딱딱한 표현을 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~하시면 됩니다 → ~하면 돼요
  {
    pattern: /하시면 됩니다/g,
    replacement: "하면 돼요",
    reason: "격식을 줄이고 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~하실 수 있습니다 → ~하실 수 있어요
  {
    pattern: /하실 수 있습니다/g,
    replacement: "하실 수 있어요",
    reason: "딱딱한 표현을 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~하실 수 없습니다 → ~하실 수 없어요
  {
    pattern: /하실 수 없습니다/g,
    replacement: "하실 수 없어요",
    reason: "딱딱한 표현을 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~하시는 것이 좋겠습니다 → ~하는 게 좋을 것 같아요
  {
    pattern: /하시는 것이 좋겠습니다/g,
    replacement: "하는 게 좋을 것 같아요",
    reason: "격식을 줄이고 조언을 부드럽게 바꿔요.",
    tags: ["tone"],
  },
  // ~하는 것이 좋겠습니다 → ~하는 게 좋을 것 같아요
  {
    pattern: /하는 것이 좋겠습니다/g,
    replacement: "하는 게 좋을 것 같아요",
    reason: "딱딱한 조언을 부드럽게 바꿔요.",
    tags: ["tone"],
  },
  // ~하시는 것이 좋겠어요 → ~하는 게 좋을 것 같아요
  {
    pattern: /하시는 것이 좋겠어요/g,
    replacement: "하는 게 좋을 것 같아요",
    reason: "격식을 줄이고 자연스럽게 바꿔요.",
    tags: ["shorten", "tone"],
  },
  // ~하는 것이 좋겠어요 → ~하는 게 좋을 것 같아요
  {
    pattern: /하는 것이 좋겠어요/g,
    replacement: "하는 게 좋을 것 같아요",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["shorten"],
  },
  // ~하시는 것이 좋을 것 같습니다 → ~하는 게 좋을 것 같아요
  {
    pattern: /하시는 것이 좋을 것 같습니다/g,
    replacement: "하는 게 좋을 것 같아요",
    reason: "격식을 줄이고 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~하는 것이 좋을 것 같습니다 → ~하는 게 좋을 것 같아요
  {
    pattern: /하는 것이 좋을 것 같습니다/g,
    replacement: "하는 게 좋을 것 같아요",
    reason: "딱딱한 표현을 해요체로 바꿔요.",
    tags: ["tone"],
  },
  // ~하시는 것이 좋을 것 같아요 → ~하는 게 좋을 것 같아요
  {
    pattern: /하시는 것이 좋을 것 같아요/g,
    replacement: "하는 게 좋을 것 같아요",
    reason: "격식을 줄이고 자연스럽게 바꿔요.",
    tags: ["shorten", "tone"],
  },
  // ~하는 것이 좋을 것 같아요 → ~하는 게 좋을 것 같아요
  {
    pattern: /하는 것이 좋을 것 같아요/g,
    replacement: "하는 게 좋을 것 같아요",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["shorten"],
  },
  // ~하시는 것이 좋겠어요 → ~하시는 게 좋을 것 같아요
  {
    pattern: /하시는 것이 좋겠어요/g,
    replacement: "하시는 게 좋을 것 같아요",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["shorten"],
  },
  // ~하는 것이 좋겠어요 → ~하는 게 좋을 것 같아요
  {
    pattern: /하는 것이 좋겠어요/g,
    replacement: "하는 게 좋을 것 같아요",
    reason: "자연스러운 표현으로 바꿔요.",
    tags: ["shorten"],
  },
  
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
    reasons.push("'입니다'를 해요체로 바꿔요.");
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
    if (!reasons.includes("띄어쓰기를 자연스럽게 해요.")) reasons.push("띄어쓰기를 자연스럽게 해요.");
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
  const reason = uniq.length ? uniq.join(" - ") : "더 자연스럽게 다듬어요.";

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
  // 패턴: "해요/돼요/이에요/예요/있어요/주세요/까요" 다음에 공백이 있고 그 다음 한글이 오거나, 문장 끝일 때
  const periodPattern = /(해요|돼요|이에요|예요|있어요|주세요|까요)(\s+)(?![.,!?])([가-힣])/g;
  const periodPatternEnd = /(해요|돼요|이에요|예요|있어요|주세요|까요)(?![.,!?])(?=\s*$)/g;
  const periodPatternComma = /(해요|돼요|이에요|예요|있어요|주세요|까요)(?![.,!?])(?=[,])/g;
  
  // 쉼표 앞에 있는 경우: "시작돼요," → "시작돼요.,"
  if (periodPatternComma.test(t)) {
    periodPatternComma.lastIndex = 0;
    const next = t.replace(periodPatternComma, "$1.");
    if (next !== t) {
      t = next;
      reasons.push("문장 끝에 마침표를 추가해요.");
    }
  }
  
  // 중간에 있는 경우: "돼요  안되" → "돼요.  안되"
  if (periodPattern.test(t)) {
    periodPattern.lastIndex = 0;
    const next = t.replace(periodPattern, "$1.$2$3");
    if (next !== t) {
      t = next;
      if (reasons.length === 0) {
        reasons.push("문장 끝에 마침표를 추가해요.");
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
        reasons.push("문장 끝에 마침표를 추가해요.");
      }
    }
  }
  
  return { text: t, reasons };
}

/**
 * 새로운 엔진: 텍스트에 대한 제안 생성
 */
function suggestFriendlyKorean(text: string): Suggestion[] {
  const original = text;

  // 1) 오타/띄어쓰기(가벼운 룰)
  const typo = applyRules(original, TYPO_RULES);

  // 2) 구조 변환(문장 레벨)
  const structural = applyRules(typo.text, REWRITE_RULES);

  // 3) 패턴 DB(해요체+용어 통일)
  const pattern = applyPatternDB(structural.text);

  // 4) 마침표 추가 (패턴 적용 후) - 원본에 마침표가 있으면 reason 추가 안 함
  const period = applyPeriodRule(pattern.text, original);

  // 최종 after (문장일 때)
  const finalAfter = period.text;

  // reason/tags 합치기
  const mergedReasons = [...typo.reasons, ...structural.reasons, ...pattern.reasons, ...period.reasons];
  const mergedTags = [...typo.tags, ...structural.tags, ...pattern.tags];

  const suggestions: Suggestion[] = [];

  const mainSuggestion = buildSuggestion(original, finalAfter, mergedReasons, mergedTags);
  if (mainSuggestion) suggestions.push(mainSuggestion);

  return suggestions;
}

/**
 * 기존 호환성 유지: 친근한 톤으로 변환하는 메인 함수
 * 새로운 엔진을 사용하되 기존 인터페이스 유지
 * 모든 변경점을 순차적으로 적용하여 최종 결과 반환
 */
function toFriendlyKoreanUX(text: string): string {
  const sugg = suggestFriendlyKorean(text);
  
  if (sugg.length === 0) {
    return text;
  }

  const mainSuggestion = sugg[0];
  return mainSuggestion ? mainSuggestion.after : text;
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
    node.insertCharacters(start, toInsert, 'BEFORE_CHARACTER');
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

// 어노테이션 노드 이름 파싱 -> { kind, nodeId, seg, key }
// 이름 형식: PREFIX + [HL_INFIX] + nodeId + SEG_SEP + segIndex
function parseAnnName(name: string): { kind: 'hl' | 'tooltip'; nodeId: string; seg: string; key: string } | null {
  if (typeof name !== 'string' || !name.startsWith(ANNOTATION_PREFIX)) return null;
  const key = name.slice(ANNOTATION_PREFIX.length); // 오프셋 맵 키 (HL_INFIX/세그 포함)
  let rest = key;
  let kind: 'hl' | 'tooltip' = 'tooltip';
  if (rest.startsWith(HL_INFIX)) { kind = 'hl'; rest = rest.slice(HL_INFIX.length); }
  const sep = rest.lastIndexOf(SEG_SEP);
  const nodeId = sep >= 0 ? rest.slice(0, sep) : rest;
  const seg = sep >= 0 ? rest.slice(sep + SEG_SEP.length) : '0';
  return { kind, nodeId, seg, key };
}

// nodeId -> 대상 노드 참조 캐시 (폴링 시 동기적으로 위치 읽기용)
const annotationNodeCache = new Map<string, any>();

// nodeId -> 대상 노드 자신 + 조상 노드 id 집합 (캔버스 선택 매칭용)
const annotationAncestorIds = new Map<string, Set<string>>();

// 어노테이션 key(이름에서 PREFIX 뗀 부분) -> 대상 노드 기준 상대 위치 (프레임 이동 시 위치 갱신용)
// 코멘트/형광펜 모두 이 맵으로 위치를 따라감
const annotationOffset = new Map<string, { dx: number; dy: number }>();

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

// 텍스트 노드의 페이지 직속 최상위 부모 프레임 반환
function getTopLevelParentFrame(nodeId: string): any | null {
  const node = figma.getNodeById(nodeId);
  if (!node) return null;
  let current: any = node;
  while (current.parent && current.parent.type !== 'PAGE') {
    current = current.parent;
  }
  // TEXT가 페이지 직속이면 자식을 가질 수 없으므로 null
  if (!current || current.type === 'TEXT' || current.type === 'PAGE') return null;
  return current;
}

// 특정 노드의 어노테이션이 하나라도 있는지 검색
function findAnnotation(nodeId: string): any | null {
  for (const child of figma.currentPage.children as any[]) {
    const p = parseAnnName(child.name);
    if (p && p.nodeId === nodeId) return child;
  }
  return null;
}

// 특정 노드의 모든 어노테이션(코멘트 + 형광펜, 모든 세그먼트) 제거
function removeAnnotationByNodeId(nodeId: string): void {
  for (const child of [...(figma.currentPage.children as any[])]) {
    const p = parseAnnName(child.name);
    if (p && p.nodeId === nodeId) {
      annotationOffset.delete(p.key);
      try { child.remove(); } catch (_e) {}
    }
  }
}

// 모든 어노테이션 프레임 수집
function getAllAnnotations(): any[] {
  const result: any[] = [];
  for (const child of figma.currentPage.children as any[]) {
    if (typeof child.name === 'string' && child.name.startsWith(ANNOTATION_PREFIX)) {
      result.push(child);
    }
    if (child.children) {
      for (const gc of child.children) {
        if (typeof gc.name === 'string' && gc.name.startsWith(ANNOTATION_PREFIX)) {
          result.push(gc);
        }
      }
    }
  }
  return result;
}

// 선택 상태에 따라 어노테이션 투명도 조절
// selectedIds가 비어있으면 전부 불투명, 아니면 선택된 것만 불투명/나머지는 반투명
function updateAnnotationOpacity(selectedIds: string[]): void {
  const selected = new Set(selectedIds);
  for (const ann of getAllAnnotations()) {
    const parsed = parseAnnName(ann.name);
    if (!parsed) continue;
    try {
      if (selected.size === 0 || selected.has(parsed.nodeId)) {
        ann.opacity = 1;
      } else {
        ann.opacity = 0.35;
      }
    } catch (_e) {}
  }
}

// 캔버스 선택에 따라 어노테이션 투명도 조절
// 선택된 노드 자신 또는 그 하위에 대상 텍스트가 있으면 해당 코멘트를 불투명 처리
function updateAnnotationOpacityFromCanvas(selection: any[]): void {
  // 선택된 노드들의 id 집합
  const selectedIds = new Set<string>();
  for (const n of selection) {
    if (n && n.id) selectedIds.add(n.id);
  }

  // 각 어노테이션의 대상 노드가 선택 범위(자신/조상)에 속하는지 판정
  // (생성 시점에 캐시해 둔 조상 id 집합과 교집합으로 판정 — dynamic-page에서도 안정적)
  const matched: string[] = [];
  if (selectedIds.size > 0) {
    for (const ann of getAllAnnotations()) {
      const parsed = parseAnnName(ann.name);
      if (!parsed) continue;
      const ancestors = annotationAncestorIds.get(parsed.nodeId);
      if (!ancestors) continue;
      let hit = false;
      for (const id of selectedIds) {
        if (ancestors.has(id)) { hit = true; break; }
      }
      if (hit) matched.push(parsed.nodeId);
    }
  }

  // 관련된 코멘트가 하나도 없으면 전부 불투명(평상 상태) 유지
  updateAnnotationOpacity(matched);
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

// 세그먼트 라벨: "원래 → 변경"
function buildSegmentLabel(beforeSeg: string, afterSeg: string): string {
  const clip = (s: string) => (s.length > 24 ? s.slice(0, 24) + '…' : s);
  const b = beforeSeg ? clip(beforeSeg) : '(없음)';
  const a = afterSeg ? clip(afterSeg) : '(삭제)';
  return b + ' → ' + a;
}

// 노드에 사용된 모든 폰트 로드 (setRangeFills 전 필요)
async function loadAllNodeFonts(node: any): Promise<void> {
  try {
    const len = node.characters ? node.characters.length : 0;
    if (len === 0) return;
    const fonts = node.getRangeAllFontNames(0, len);
    for (const f of fonts) {
      try { await figma.loadFontAsync(f); } catch (_e) {}
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
async function measureSegments(
  node: any,
  before: string,
  segs: Array<{ bStart: number; bEnd: number; aStart: number; aEnd: number }>,
  absX: number,
  absY: number
): Promise<Array<{ x: number; y: number; w: number; h: number } | null>> {
  const out: Array<{ x: number; y: number; w: number; h: number } | null> = segs.map(() => null);
  let clone: any = null;
  let t: any = null;
  try {
    await loadAllNodeFonts(node);
    const { font, size, ls, lineHeight, textCase } = getRangeStyle(node, 0);
    const align = node.textAlignHorizontal;
    const vAlign = node.textAlignVertical;
    const origW = node.width;
    const nodeH = node.height;

    // 단일 라인 너비 측정용 임시 노드
    t = figma.createText();
    if (font) t.fontName = font;
    t.fontSize = size || 16;
    if (ls) { try { t.letterSpacing = ls; } catch (_e) {} }
    if (lineHeight) { try { t.lineHeight = lineHeight; } catch (_e) {} }
    if (textCase) { try { t.textCase = textCase; } catch (_e) {} }
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
    const ANCHOR = " ";
    t.characters = ANCHOR;
    const anchorW = t.width;
    const lineH = t.height || (size || 16) * 1.2;
    const adv = (s: string): number => {
      if (!s) return 0;
      t.characters = s + ANCHOR;
      return t.width - anchorW;
    };

    // 줄바꿈 복제용 클론 (너비 고정)
    clone = node.clone();
    figma.currentPage.appendChild(clone);
    try { clone.effects = []; } catch (_e) {}
    try { clone.strokes = []; } catch (_e) {}
    try { clone.textAutoResize = 'HEIGHT'; } catch (_e) {}
    try { clone.resize(origW, nodeH); } catch (_e) {}

    // 첫 p글자가 차지하는 줄 수
    const linesUpTo = (p: number): number => {
      if (p <= 0) return 0;
      clone.characters = before.slice(0, p);
      return Math.max(1, Math.round(clone.height / lineH));
    };
    // linesUpTo(k) >= L 을 만족하는 최소 k (이분 탐색)
    const firstK = (L: number): number => {
      let lo = 0, hi = before.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (linesUpTo(mid) >= L) hi = mid; else lo = mid + 1;
      }
      return lo;
    };
    const totalLines = Math.max(1, linesUpTo(before.length));
    // 세로 정렬 보정 (텍스트 전체가 노드보다 짧을 때)
    let extraTop = 0;
    const textH = totalLines * lineH;
    const extra = Math.max(0, nodeH - textH);
    if (vAlign === 'CENTER') extraTop = extra / 2;
    else if (vAlign === 'BOTTOM') extraTop = extra;

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const startPos = s.bStart;
      const endPos = Math.max(s.bEnd, s.bStart);
      // 시작 글자가 위치한 줄 (1-based). 글자가 있으면 그 글자의 줄, 없으면(맨끝 삽입) 마지막 줄
      const Lstart = startPos < before.length ? Math.max(1, linesUpTo(startPos + 1)) : totalLines;
      const ls0 = Math.max(0, firstK(Lstart) - 1); // 해당 줄의 첫 글자 인덱스
      const Lend = endPos > startPos ? Math.max(1, linesUpTo(endPos)) : Lstart;

      if (Lend === Lstart) {
        // 단일 라인 세그먼트
        const xStartInLine = adv(before.slice(ls0, startPos));
        const xEndInLine = adv(before.slice(ls0, endPos));
        // 줄 전체 너비 (정렬 보정용)
        const le = Lstart < totalLines ? firstK(Lstart + 1) : before.length;
        const lineW = adv(before.slice(ls0, le));
        let leftEdge = 0;
        if (align === 'CENTER') leftEdge = (origW - lineW) / 2;
        else if (align === 'RIGHT') leftEdge = origW - lineW;
        const x = absX + leftEdge + xStartInLine;
        const y = absY + extraTop + (Lstart - 1) * lineH;
        const w = Math.max(1, xEndInLine - xStartInLine);
        out[i] = { x, y, w, h: lineH };
      } else {
        // 여러 줄에 걸친 세그먼트: 줄 밴드로 근사 (전체 너비)
        const yTop = absY + extraTop + (Lstart - 1) * lineH;
        const yBot = absY + extraTop + Lend * lineH;
        out[i] = { x: absX, y: yTop, w: origW, h: Math.max(lineH, yBot - yTop) };
      }
    }
  } catch (e) {
    console.log('[UX-HL] measureSegments error', e);
  } finally {
    if (clone) { try { clone.remove(); } catch (_e) {} }
    if (t) { try { t.remove(); } catch (_e) {} }
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
    hl.name = ANNOTATION_PREFIX + key;
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
  } catch (_e) {}
}

// 코멘트 말풍선 생성 (해당 세그먼트 바로 위에 배치)
function createCommentFrame(
  key: string, label: string, fontName: { family: string; style: string },
  anchorX: number, anchorY: number, absX: number, absY: number
): void {
  try {
    const tooltip = figma.createFrame();
    tooltip.name = ANNOTATION_PREFIX + key;
    tooltip.cornerRadius = 8;
    tooltip.fills = [{ type: 'SOLID', color: { r: 0.2, g: 0.78, b: 0.35 } }];
    tooltip.layoutMode = 'HORIZONTAL';
    tooltip.primaryAxisSizingMode = 'AUTO';
    tooltip.counterAxisSizingMode = 'AUTO';
    tooltip.paddingLeft = 10;
    tooltip.paddingRight = 10;
    tooltip.paddingTop = 6;
    tooltip.paddingBottom = 6;
    tooltip.itemSpacing = 0;

    const text = figma.createText();
    text.fontName = fontName;
    text.characters = label;
    text.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    text.fontSize = 12;
    tooltip.appendChild(text);

    figma.currentPage.appendChild(tooltip);
    const tx = anchorX;
    const ty = anchorY - tooltip.height - 6;
    tooltip.x = tx;
    tooltip.y = ty;
    if (!annotationsVisible) tooltip.visible = false;
    tooltip.locked = true;
    annotationOffset.set(key, { dx: tx - absX, dy: ty - absY });
  } catch (_e) {}
}

// 한 노드의 어노테이션 생성/교체 (변경 구간마다 코멘트 + 형광펜)
async function upsertAnnotation(item: { nodeId: string; before: string; after: string; x: number; y: number }): Promise<void> {
  const fontName = await ensureAnnotationFont();
  if (!fontName) return;

  // 기존 어노테이션(코멘트 + 형광펜, 모든 세그먼트) 제거
  removeAnnotationByNodeId(item.nodeId);

  let node: any = null;
  try { node = await figma.getNodeByIdAsync(item.nodeId); } catch (_e) {}
  if (!node) return;

  annotationNodeCache.set(item.nodeId, node);
  const ancestors = new Set<string>();
  let cur: any = node;
  while (cur && cur.type !== 'PAGE') {
    if (cur.id) ancestors.add(cur.id);
    cur = cur.parent;
  }
  annotationAncestorIds.set(item.nodeId, ancestors);

  const absX = item.x;
  const absY = item.y;

  // 변경 구간을 모두 찾아 각각의 화면 위치를 한 번에 측정
  const segs = diffSegments(item.before, item.after);
  if (segs.length === 0) return;
  const geoms = await measureSegments(node, item.before, segs, absX, absY);

  let idx = 0;
  for (const s of segs) {
    const bSeg = item.before.slice(s.bStart, s.bEnd);
    const aSeg = item.after.slice(s.aStart, s.aEnd);
    const label = buildSegmentLabel(bSeg, aSeg);
    const segKey = item.nodeId + SEG_SEP + idx;
    const geom = geoms[idx] || { x: absX, y: absY, w: 1, h: 16 };

    // 변경된 기존 글자가 있을 때만 형광펜 박스
    if (s.bEnd > s.bStart) {
      createHighlightRect(HL_INFIX + segKey, geom, absX, absY);
    }
    // 코멘트는 해당 세그먼트 바로 위에
    createCommentFrame(segKey, label, fontName, geom.x, geom.y, absX, absY);
    idx++;
  }
}

async function createAnnotations(
  previewData: Array<{ nodeId: string; before: string; after: string; x: number; y: number }>
): Promise<void> {
  for (const item of previewData) {
    await upsertAnnotation(item);
  }
  startRepositionPolling();
}

function removeAnnotations(): void {
  stopRepositionPolling();
  annotationFontName = null;
  annotationNodeCache.clear();
  annotationAncestorIds.clear();
  annotationOffset.clear();
  for (const ann of getAllAnnotations()) {
    ann.remove();
  }
}

// APPLY 중인 노드 ID 추적 (documentchange에서 오탐 방지)
const applyingNodeIds = new Set<string>();

// 어노테이션 위치 폴링 (프레임 이동 추적)
let repositionTimer: ReturnType<typeof setInterval> | null = null;

function repositionAnnotations(): void {
  const anns = getAllAnnotations();
  for (const ann of anns) {
    const parsed = parseAnnName(ann.name);
    if (!parsed) continue;
    const nodeId = parsed.nodeId;
    let node = annotationNodeCache.get(nodeId);
    if (!node) continue;
    try {
      // 노드가 삭제됐으면 캐시에서 제거
      if (node.removed) {
        annotationNodeCache.delete(nodeId);
        continue;
      }
      const at = node.absoluteTransform;
      const x: number = at ? at[0][2] : (node.x || 0);
      const y: number = at ? at[1][2] : (node.y || 0);
      // 코멘트/형광펜 모두 생성 시 저장한 상대 오프셋만큼 텍스트 노드 기준으로 이동
      const off = annotationOffset.get(parsed.key);
      if (off) {
        const newX = x + off.dx;
        const newY = y + off.dy;
        if (Math.abs(ann.x - newX) > 0.5 || Math.abs(ann.y - newY) > 0.5) {
          ann.x = newX;
          ann.y = newY;
        }
      }
    } catch (_e) {
      // 접근 불가(삭제 등) 시 캐시 제거
      annotationNodeCache.delete(nodeId);
    }
  }
}

function startRepositionPolling(): void {
  if (repositionTimer) return;
  repositionTimer = setInterval(() => {
    if (getAllAnnotations().length > 0) {
      repositionAnnotations();
    } else {
      stopRepositionPolling();
    }
  }, 32);
}

function stopRepositionPolling(): void {
  if (repositionTimer !== null) {
    clearInterval(repositionTimer);
    repositionTimer = null;
  }
}

// 어노테이션 표시 상태
let annotationsVisible = true;

// 어노테이션 토글
function toggleAnnotations(): void {
  annotationsVisible = !annotationsVisible;
  for (const ann of getAllAnnotations()) {
    ann.visible = annotationsVisible;
  }
  figma.ui.postMessage({ type: 'annotations-visibility', visible: annotationsVisible });
}

// 텍스트 노드 외부 변경(Ctrl+Z 등) 감지 → 해당 어노테이션 제거
try {
  (figma as any).on('documentchange', (event: any) => {
    if (!event || !event.documentChanges) return;

    for (const change of event.documentChanges) {
      if (
        change.type === 'PROPERTY_CHANGE' &&
        change.node?.type === 'TEXT' &&
        Array.isArray(change.properties) &&
        change.properties.includes('characters')
      ) {
        const nodeId = change.node.id;
        if (applyingNodeIds.has(nodeId)) continue;

        if (findAnnotation(nodeId)) {
          removeAnnotationByNodeId(nodeId);
          figma.ui.postMessage({ type: 'remove-changed-items', changedNodeIds: [nodeId] });
        }
      }
    }
  });
} catch (_e) {
  // documentchange 미지원 환경에서는 무시
}

// 플러그인 닫힐 때 어노테이션 자동 제거
(figma as any).on('close', () => {
  removeAnnotations();
});

// PREVIEW에서 찾은 노드들을 캐시 (FOCUS_NODE에서 사용)
const previewNodeCache = new Map<string, TextNode>();


// 텍스트 수정 전에 폰트 로드(필수)
async function loadFontsForTextNode(textNode: TextNode): Promise<void> {
  // 단일 폰트면 그대로 로드
  if (textNode.fontName !== figma.mixed) {
    await figma.loadFontAsync(textNode.fontName as FontName);
    return;
  }

  // mixed 폰트면: 글자 단위로 폰트 수집 후 로드
  const fonts = new Map<string, FontName>();
  const len = textNode.characters.length;

  for (let i = 0; i < len; i++) {
    const fn = textNode.getRangeFontName(i, i + 1);
    if (fn !== figma.mixed) {
      const key = (fn as FontName).family + "::" + (fn as FontName).style;
      fonts.set(key, fn as FontName);
    }
  }

  // 수집한 폰트들을 모두 로드
  await Promise.all(Array.from(fonts.values()).map(f => figma.loadFontAsync(f)));
}

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
    
    const previewData: Array<{ nodeId: string; nodeName: string; before: string; after: string; reason: string; y: number; x: number }> = [];
    const nodesToSelect: TextNode[] = [];
    const CHUNK_SIZE = 50; // 50개씩 처리 후 yield
    let lastProgressUpdateTime = Date.now();
    const PROGRESS_UPDATE_TIME_INTERVAL = 100; // 100ms마다 시간 기반 업데이트

    // 텍스트 변환 처리 (청크 단위로 나누어 처리하여 UI 블로킹 방지)
    const totalTextNodes = textNodes.length;
    for (let i = 0; i < textNodes.length; i++) {
      const node = textNodes[i];
      const before = node.characters;
      // 패턴이 있는지 빠르게 확인 후 변환
      const suggestions = suggestFriendlyKorean(before);
      const preferredSuggestion = suggestions.find((s) => s.tags.includes("button")) ?? suggestions[0];
      const after = preferredSuggestion ? preferredSuggestion.after : before;
      const reason = preferredSuggestion ? preferredSuggestion.reason : "";

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

        previewData.push({
          nodeId: node.id,
          nodeName: node.name,
          before: before,
          after: after,
          reason: reason,
          y: y,
          x: x
        });
        nodesToSelect.push(node);
      }
      
      // 진행률 업데이트 (30% ~ 90%) - 처리량 기반 또는 시간 기반
      const now = Date.now();
      const progress = 30 + (i + 1) / totalTextNodes * 60;
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

    // 위치 기준으로 정렬 (위에서 아래, 왼쪽에서 오른쪽)
    previewData.sort((a, b) => {
      // 먼저 y 좌표로 정렬 (위에서 아래)
      if (Math.abs(a.y - b.y) > 1) {
        return a.y - b.y;
      }
      // y 좌표가 비슷하면 x 좌표로 정렬 (왼쪽에서 오른쪽)
      return a.x - b.x;
    });

    // 변경점이 있는 텍스트 노드들을 자동으로 선택
    if (nodesToSelect.length > 0) {
      figma.currentPage.selection = nodesToSelect;
      figma.viewport.scrollAndZoomIntoView(nodesToSelect);
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

    // 새 결과를 먼저 누적 방식으로 UI에 전송 (어노테이션 생성 실패와 무관하게 검토 결과 표시)
    figma.ui.postMessage({
      type: 'preview-add',
      data: previewData
    });

    // 캔버스에 어노테이션 생성 (누적) — 실패해도 검토 결과에는 영향 없음
    try {
      await createAnnotations(previewData);
    } catch (annErr) {
      console.error('어노테이션 생성 실패:', annErr);
    }

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

    // 변경할 노드들 수집 - getNodeById 우선 사용, 실패 시에만 제한적 스캔
    const nodesToChange: TextNode[] = [];
    const failedNodeIds: string[] = [];
    
    // 먼저 getNodeById로 시도 (대부분의 경우 성공, 매우 빠름)
    const totalTargetNodes = targetNodeIds.size;
    let processedCount = 0;
    for (const nodeId of targetNodeIds) {
      try {
        const nodeById = figma.getNodeById(nodeId);
        if (nodeById && nodeById.type === "TEXT") {
          nodesToChange.push(nodeById as TextNode);
        } else {
          // 노드가 TEXT 타입이 아니거나 null인 경우
          failedNodeIds.push(nodeId);
        }
      } catch (e) {
        // getNodeById 실패 시 나중에 스캔으로 찾기 시도
        failedNodeIds.push(nodeId);
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

    // getNodeById로 찾지 못한 노드들만 제한적으로 스캔 (필요한 경우에만)
    // 하지만 전체 페이지가 아닌 현재 선택된 영역만 스캔하여 성능 최적화
    if (failedNodeIds.length > 0) {
      // 현재 선택된 노드들에서만 스캔 (전체 페이지 스캔 대신)
      const selection = figma.currentPage.selection;
      const scannedNodes = new Map<string, TextNode>();
      
      // 선택된 노드들 내부의 텍스트 노드만 스캔
      for (const selectedNode of selection) {
        const foundNodes = await findAllTextNodes(selectedNode);
        for (const node of foundNodes) {
          scannedNodes.set(node.id, node);
        }
      }
      
      // 실패한 노드 ID들만 스캔된 노드에서 찾기
      for (const nodeId of failedNodeIds) {
        const node = scannedNodes.get(nodeId);
        if (node) {
          nodesToChange.push(node);
        }
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

    // 변경된 항목 ID를 UI에 전송하여 UI에서 필터링하도록 함
    if (changedNodeIds.size > 0) {
      // 토스트 알림 표시 (UI에 전송)
      const message = changedNodeIds.size === 1
        ? '변경이 완료되었어요.'
        : `${changedNodeIds.size}건이 변경 완료되었어요.`;
      
      figma.ui.postMessage({
        type: 'show-toast',
        message: message
      });
      
      figma.ui.postMessage({
        type: 'remove-changed-items',
        changedNodeIds: Array.from(changedNodeIds)
      });
    }
    } catch (e) {
      // 에러 발생 시에도 로딩 숨기기
      figma.ui.postMessage({
        type: 'hide-loading'
      });
    }

    return;
  }

  // 플러그인 창 크기 조절
  if (msg.type === "RESIZE_UI") {
    const w = Math.max(300, Math.min(800, msg.width || 360));
    const h = Math.max(400, Math.min(1200, msg.height || 780));
    figma.ui.resize(w, h);
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
      
      // 2. 캐시에 없으면 getNodeById로 찾기
      if (!node) {
        try {
          const nodeById = figma.getNodeById(nodeId);
          if (nodeById && nodeById.type === "TEXT") {
            node = nodeById as TextNode;
          }
        } catch (e) {
          // getNodeById 실패 시 무시
        }
      }
      
      // 3. 노드를 찾았으면 선택 및 뷰포트 이동
      if (node && node.type === "TEXT") {
        // 해당 노드 선택
        figma.currentPage.selection = [node];
        
        // 뷰포트 이동 및 확대
        figma.viewport.scrollAndZoomIntoView([node]);
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
        
        // 2. 캐시에 없으면 getNodeById로 찾기
        if (!node) {
          try {
            const nodeById = figma.getNodeById(nodeId);
            if (nodeById && nodeById.type === "TEXT") {
              node = nodeById as TextNode;
            }
          } catch (e) {
            // 무시
          }
        }
        
        if (node) {
          nodesToSelect.push(node);
        }
      }

      // 선택된 노드들을 Figma에서 선택
      if (nodesToSelect.length > 0) {
        figma.currentPage.selection = nodesToSelect;
        // 뷰포트 이동 (첫 번째 노드로)
        figma.viewport.scrollAndZoomIntoView([nodesToSelect[0]]);
      }
    } catch (e) {
      console.error("[SELECT_NODES] 오류:", e);
    }
    return;
  }
};
