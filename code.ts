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
      // '텍스트 여러 개 든 컴포넌트'(팝업)면 입력창을 채우지 않고 팝업 신호만 — [추천받기]가 요소별로 갈린다.
      const sel0 = selection && selection[0];
      const popupEls = (sel0 && sel0.type !== 'TEXT') ? classifyPopup(sel0) : [];
      if (isDialogLike(sel0, popupEls)) {
        figma.ui.postMessage({ type: 'selection-text', text: '', popup: popupEls.length, popupElements: popupEls });
      } else {
        // 팝업이 아니면 문구를 입력창에 채우고, '프레임 안 프레임'이면 하위 프레임별 묶음도 함께 보낸다.
        // 버튼을 고른 경우엔 역할(버튼)도 실어 보낸다 — 버튼 문구는 문장이 아니라 동작 이름이라 규칙이 다르다.
        const groups = frameGroupsForSelection(selection);
        const role = (selection.length === 1 && detectButtonRole(sel0)) ? '버튼' : undefined;
        collectSelectedText().then((t) => {
          figma.ui.postMessage({ type: 'selection-text', text: (t && t.trim()) ? t : '', popup: 0, groups, role });
        }).catch(() => {});
      }
    } else if (!selection || selection.length === 0) {
      figma.ui.postMessage({ type: 'selection-text', text: '', popup: 0 });
    }
  } catch (_e) {}
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
  } else {
    const groups0 = frameGroupsForSelection(initialSelection);
    const role0 = (initialSelection.length === 1 && detectButtonRole(s0)) ? '버튼' : undefined;
    collectSelectedText().then((t) => {
      if (t && t.trim()) figma.ui.postMessage({ type: 'selection-text', text: t, groups: groups0, role: role0, onEnter: true });
    }).catch(() => {});
  }
}

// ===============================
// UX Writing 엔진 타입 정의
// ===============================
type SuggestionTag =
  | "tone"
  | "button"
  | "shorten"
  | "typo"
  | "spacing"
  | "term"
  | "format";

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

// ===============================
// 날짜·시간 표기 규칙 (ux-writing.md "7. 날짜·시간·숫자 표기" — 항상 적용)
// 오탐 없이 결정적으로 고칠 수 있는 것만 자동화한다.
// - 번호(전화/카드/계좌): raw 숫자만으론 구분 위치를 확정할 수 없어 제외
// - 오전/오후: "사용자가 직접 고르는 방문·예약 시간" 예외를 텍스트만으론 구분 못 해 제외
// ===============================
const DATE_FORMAT_RULES: FixRule[] = [
  // 날짜 구분자 통일: YYYY-MM-DD, YYYY/MM/DD, YYYY.M.D → YYYY.MM.DD (0 채움)
  // 월(1~12)·일(1~31) 범위를 벗어나면 날짜가 아니라고 보고 그대로 둔다.
  // \b(\d{4}) 로 4자리 연도만 잡아 카드번호·버전 문자열(10.0.x 등)을 건드리지 않는다.
  {
    pattern: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g,
    replacement: (_m: string, y: string, mo: string, d: string) => {
      const mn = parseInt(mo, 10), dn = parseInt(d, 10);
      if (mn < 1 || mn > 12 || dn < 1 || dn > 31) return _m; // 날짜 아님 → 그대로
      const pad = (n: number) => (n < 10 ? "0" + n : String(n));
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
// 팝업(컨테이너) 안의 텍스트를 스타일로 역할 분류 → [{role, text}] (화면 위→아래 순).
// 규칙: 버튼 컴포넌트 안 = 버튼(채움색이 흰색 아니면 주요), 나머지 중 제일 큰/위 = 타이틀, 그 외 = 안내.
function classifyPopup(root: any): Array<{ role: string; text: string }> {
  const hexOf = (node: any): string | null => {
    const f = node.fills;
    if (Array.isArray(f) && f[0] && f[0].type === 'SOLID' && f[0].visible !== false) {
      const c = f[0].color; const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
      return ('#' + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
    }
    return null;
  };
  const isWhite = (hex: string | null) => !!hex && (hex === '#FFFFFF' || hex === '#FEFEFE');
  const isNameButton = (node: any) => (node.type === 'INSTANCE' || node.type === 'COMPONENT' || node.type === 'FRAME' || node.type === 'GROUP') && /button|btn|버튼|cta|action/i.test(node.name || '');
  const isContainer = (node: any) => node.type === 'INSTANCE' || node.type === 'COMPONENT' || node.type === 'FRAME' || node.type === 'GROUP';
  // 노드 '자기' 배경: 채움 페인트가 있으면 has=true. 솔리드면 hex, 그라디언트/이미지면 hex=null(색은 몰라도 배경은 있음).
  const nodeBg = (node: any): { has: boolean; hex: string | null } => {
    const f = node.fills;
    if (!Array.isArray(f)) return { has: false, hex: null };
    const vis = f.filter((p: any) => p && p.visible !== false);
    if (!vis.length) return { has: false, hex: null };
    return { has: true, hex: hexOf(node) };
  };
  // 버튼 상자의 대표 배경: 자기 배경 우선, 없으면 자식(주로 배경 사각형) 중 '가장 큰' 배경.
  // 아이콘 같은 작은 색을 안 줍고 진짜 배경을 잡으려고 면적 최대를 고른다.
  const boxBg = (node: any): { has: boolean; hex: string | null } => {
    const own = nodeBg(node);
    if (own.has) return own;
    let best: { has: boolean; hex: string | null } | null = null, bestArea = -1;
    const walk = (n: any) => {
      if (n !== node && n.type !== 'TEXT') {
        const bg = nodeBg(n);
        if (bg.has) { const bb = n.absoluteBoundingBox; const a = bb ? bb.width * bb.height : 0; if (a > bestArea) { bestArea = a; best = bg; } }
      }
      if ('children' in n && n.children) n.children.forEach(walk);
    };
    walk(node);
    return best || { has: false, hex: null };
  };
  const isBold = (s: string) => /bold|semibold|heavy|black/i.test(s || '');
  const lumOf = (hex: string | null): number | null => {
    if (!hex) return null;
    const n = parseInt(hex.slice(1), 16); if (isNaN(n)) return null;
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255; // 0=검정 … 1=흰색
  };
  const rootBB = root.absoluteBoundingBox; const oy = rootBB ? rootBB.y : 0; const rootH = rootBB ? rootBB.height : 9999;
  // 버튼 컨테이너 판정: (1)이름에 button/버튼 등이 있거나, (2)이름이 없어도 '채움색 있는 작은 상자(버튼 높이)'면 버튼.
  // 루트(팝업 배경)는 흰색 큰 상자라 제외 — 높이로 걸러진다.
  //  버튼 상자 판정: (1)이름 규칙, 또는 (2)이름 없이도 '배경 있는 컨테이너 중 팝업보다 확실히 낮은 것'.
  //  루트(팝업 배경)는 크고 하나뿐이라 높이 비율(0.7)에서 걸러진다.
  const isButtonContainer = (node: any, isRoot: boolean): boolean => {
    if (isRoot) return false;
    if (isNameButton(node)) return true; // 이름 규칙(button/버튼/cta…)은 FRAME이어도 인정
    // 이름이 없으면 '재사용 컴포넌트(인스턴스)'만 버튼 후보로 본다 — 배경만 있는 레이아웃 FRAME을 버튼으로 오인하지 않게.
    // (버튼은 컴포넌트로 만든다는 전제. 배경 있고 팝업보다 확실히 낮은 인스턴스면 버튼.)
    if (node.type === 'INSTANCE' || node.type === 'COMPONENT') {
      const bb = node.absoluteBoundingBox;
      if (bb && bb.height > 0 && bb.height < rootH * 0.7 && boxBg(node).has) return true;
    }
    return false;
  };
  const texts: Array<{ text: string; fontSize: number; bold: boolean; lum: number | null; y: number; inBtn: boolean; btnFill: string | null }> = [];
  const collect = (node: any, inBtn: boolean, bf: string | null, isRoot: boolean) => {
    let ib = inBtn, fill = bf;
    if (!inBtn && isButtonContainer(node, isRoot)) { ib = true; fill = boxBg(node).hex; }
    if (node.type === 'TEXT' && node.characters && node.characters.trim()) {
      const bb = node.absoluteBoundingBox;
      const style = (node.fontName && node.fontName !== figma.mixed) ? node.fontName.style : '';
      texts.push({ text: node.characters.trim(), fontSize: (typeof node.fontSize === 'number') ? node.fontSize : 0, bold: isBold(style), lum: lumOf(hexOf(node)), y: bb ? bb.y - oy : 0, inBtn: ib, btnFill: fill });
    }
    if ('children' in node && node.children) node.children.forEach((c: any) => collect(c, ib, fill, false));
  };
  collect(root, false, null, true);
  // 버튼 판정에 '글자색'을 더한다(사용자 기준):
  //   흰 글씨 = 주요 버튼(본문·타이틀은 흰색일 리 없어 확실). 그 외 버튼 후보(컴포넌트 안)는 검정 글씨 = 일반 버튼.
  const isWhiteText = (t: { lum: number | null }) => t.lum != null && t.lum > 0.72;
  const isBtn = (t: { inBtn: boolean; lum: number | null }) => t.inBtn || isWhiteText(t);
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
      if (better) best = i;
    });
    const cand = nonBtn[best];
    const cl = cand.lum;
    const distinguishable =
      nonBtn.some(t => t.fontSize < cand.fontSize)                              // 크기로 구분
      || (cand.bold && nonBtn.some(t => !t.bold))                               // 두께로 구분
      || (cl != null && nonBtn.some(t => t.lum != null && t.lum - cl > 0.12));  // 색: 더 연한 본문이 있음
    if (distinguishable) titleIdx = best;
  }
  const out: Array<{ role: string; text: string; y: number }> = [];
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
function isDialogLike(root: any, elements: Array<{ role: string; text: string }>): boolean {
  if (!elements || elements.length < 2) return false;
  // 이름 신호가 1차 기준 — 아무 프레임이나 '텍스트 여러 개'만으로 잡던 오탐을 없앤다.
  // 팝업/모달/다이얼로그 등으로 명명된 컨테이너만 팝업으로 본다. (이름 없으면 일반 텍스트로 처리)
  const name = String((root && root.name) || '');
  const named = /pop[\s_-]?up|modal|dialog|alert|toast|snackbar|팝업|모달|다이얼로그|얼럿|바텀시트/i.test(name);
  if (!named) return false;
  // 2차 — 이름이 팝업이어도 타이틀·버튼 같은 구조가 하나라도 있어야 (단순 배너/이미지 컨테이너 제외)
  const hasTitle = elements.some((e) => e.role === '타이틀');
  const hasButton = elements.some((e) => e.role.indexOf('버튼') === 0);
  return hasTitle || hasButton;
}

// 마지막으로 추천받은 팝업의 구성요소 — [케이스 더 받기]가 이걸로 다시 요청한다.
// 결과를 보는 동안 캔버스 선택이 풀리거나 바뀔 수 있어(초기화·다른 프레임 클릭) 선택에 의존하면 안 된다.
let lastPopupElements: Array<{ role: string; text: string }> | null = null;

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
function detectButtonRole(node: any): boolean {
  if (!node) return false;
  const NAME_RE = /button|btn|버튼|cta|action/i;
  const MAX_LABEL = 14; // 버튼 라벨 길이 상한 (이보다 길면 문장으로 본다)
  const texts: string[] = [];
  const collect = (n: any) => {
    if (!n || n.visible === false || texts.length > 2) return;
    if (n.type === 'TEXT') { const t = String(n.characters || '').trim(); if (t) texts.push(t); return; }
    if ('children' in n && n.children) n.children.forEach(collect);
  };
  collect(node);
  if (!texts.length || texts.length > 2) return false;
  if (texts.some((t) => t.length > MAX_LABEL || /[.!?]$/.test(t))) return false; // 문장부호로 끝나면 문장
  // 자기 또는 위로 3단까지의 이름에 button/버튼/cta…
  let cur: any = node, up = 0;
  while (cur && up <= 3) {
    if (NAME_RE.test(String(cur.name || ''))) return true;
    try { cur = cur.parent; } catch (_e) { break; }
    up++;
  }
  // 이름 규칙이 없으면 '배경 있는 작은 컴포넌트'만 버튼 후보로 (버튼은 컴포넌트로 만든다는 전제)
  const hasFill = (n: any) => Array.isArray(n.fills) && n.fills.some((f: any) => f && f.visible !== false);
  const box = node.type === 'TEXT' ? node.parent : node;
  if (box && (box.type === 'INSTANCE' || box.type === 'COMPONENT') && hasFill(box)) {
    const bb = box.absoluteBoundingBox;
    if (bb && bb.height > 0 && bb.height <= 80) return true;
  }
  return false;
}

// own=true는 '자기 안에 또 문구 든 프레임이 있는데, 자기도 문구를 직접 들고 있는' 프레임의 그룹.
// 그대로 두면 자식 그룹들 사이에 상위(또는 선택한) 프레임 이름이 섞여 "왜 상위 프레임도 같이 뜨지?"가
// 된다(실제 신고) → UI가 '이 프레임 문구' 표시를 붙여 자식 그룹과 구분한다.
// role='버튼'이면 그 영역은 버튼 규칙(동작 이름·마침표 없음)으로 다듬어야 한다 — 프롬프트에 실린다
type FrameGroup = { name: string; texts: string[]; own?: boolean; role?: string };
function classifyFrameGroups(root: any): Array<FrameGroup> {
  if (!root || root.type === 'TEXT') return [];
  const MAX_DEPTH = 12;   // 아주 깊게 중첩된 파일에서 무한정 내려가지 않게
  const MAX_GROUPS = 60;  // 목록이 끝없이 길어지지 않게 (넘으면 그 뒤는 버린다)
  const isContainer = (n: any) => !!n && (n.type === 'FRAME' || n.type === 'GROUP' || n.type === 'COMPONENT' || n.type === 'INSTANCE' || n.type === 'SECTION');
  const yOf = (n: any) => { const bb = n.absoluteBoundingBox; return bb ? bb.y : 0; };
  const xOf = (n: any) => { const bb = n.absoluteBoundingBox; return bb ? bb.x : 0; };
  const kidsOf = (n: any): any[] => (('children' in n && n.children) ? n.children.filter((k: any) => k && k.visible !== false) : []);
  // 이 프레임 아래(자기 직속 문구 제외)에 문구가 있나 — 자식 그룹이 생길지 판단용
  const anyTextInside = (n: any): boolean => {
    const stack = kidsOf(n).filter(isContainer);
    let guard = 0;
    while (stack.length && guard++ < 5000) {
      const cur = stack.pop();
      const kids = kidsOf(cur);
      if (kids.some((k: any) => k.type === 'TEXT' && String(k.characters || '').trim())) return true;
      kids.filter(isContainer).forEach((c: any) => stack.push(c));
    }
    return false;
  };
  // 이름이 뻔한 래퍼(Frame 12, Auto layout, Group…)는 경로에서 뺀다 — '헤더 › 타이틀'처럼 읽히게
  const isPlainName = (s: string) => !s || /^(frame|group|auto[\s_-]?layout|autolayout|container|wrapper|content|div|rect(angle)?|vector|layer|컨테이너|그룹|프레임)[\s_-]*\d*$/i.test(s.trim());
  const out: Array<{ name: string; texts: string[]; own: boolean; role?: string; y: number; x: number }> = [];
  const walk = (node: any, path: string[], depth: number) => {
    if (out.length >= MAX_GROUPS) return;
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
    if (depth >= MAX_DEPTH) return;
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
function frameGroupsForSelection(selection: readonly any[] | any[]): Array<FrameGroup> {
  if (!selection || selection.length !== 1) return [];
  try { return classifyFrameGroups(selection[0]); } catch (_e) { return []; }
}

// 팝업 요소별 추천 — 선택이 '팝업 같은 구조'(isDialogLike)면 역할별로 갈라 요소마다 추천하고 true 반환.
// 아니면(단일 텍스트·카드·빈 선택 등) 처리하지 않고 false → 호출부가 일반 추천으로 넘어간다.
// opts.elements를 주면(=[케이스 더 받기]) 선택을 보지 않고 그 요소로 다시 추천하고, 결과는 기존 카드 아래에 덧붙인다.
async function popupRecommendFlow(
  model: string | undefined,
  opts?: { elements?: Array<{ role: string; text: string }>; append?: boolean }
): Promise<boolean> {
  const more = !!(opts && opts.elements && opts.elements.length);
  let elements: Array<{ role: string; text: string }>;
  if (more) {
    elements = opts!.elements!;
  } else {
    const sel = figma.currentPage.selection;
    if (!sel.length || sel[0].type === "TEXT") return false;
    elements = classifyPopup(sel[0]);
    if (!isDialogLike(sel[0], elements)) return false;
    lastPopupElements = elements; // [케이스 더 받기]가 쓸 요소 기억
  }
  const append = !!(opts && opts.append);
  let bh = await bridgeHealth();
  if (!bh.alive) { figma.ui.postMessage({ type: 'show-toast', message: '클로드가 연동돼 있지 않아요 — [클로드] 버튼으로 연결한 뒤 다시 눌러 주세요.' }); return true; }
  // 다리가 구버전이면 사용자가 [업데이트] 버튼을 안 눌러도 여기서 자동으로 재연결한다.
  bh = await autoUpgradeIfOld(bh);
  if (!bh.alive || bh.problem === 'bridge-old') {
    figma.ui.postMessage({ type: 'hide-loading' });
    figma.ui.postMessage({ type: 'show-toast', message: bh.problem === 'bridge-old'
      ? ('아직 옛 버전이 연결돼요. 이 폴더예요: ' + (bh.dir || '경로 불명') + ' — 최신 코드로 업데이트해 주세요.')
      : '클로드를 다시 연결하지 못했어요 — 잠시 후 다시 눌러 주세요.' });
    return true;
  }
  if (needsAccountConfirm(bh)) { figma.ui.postMessage({ type: 'account-confirm-needed', account: bh.account }); return true; }
  figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '문구를 다듬는 중이에요.' });
  try {
    // 팝업 전체를 한 요청에 묶어 보내 타이틀·안내·버튼이 일관된 "세트"를 받는다.
    // (요소별로 따로 뽑아 조합하면 서로 안 맞을 수 있어 세트 단위로 받는다.)
    const data = await fetchAiPopup(elements, model, more);
    const sets = await refinePopupSets(data.sets || []);
    figma.ui.postMessage({ type: 'hide-loading' });
    figma.ui.postMessage({ type: 'popup-recommend-result', sets, append });
  } catch (e) {
    figma.ui.postMessage({ type: 'hide-loading' });
    // 더 받기 실패는 이미 화면에 있는 카드를 지우면 안 된다 → 토스트만 (append=true면 UI가 카드를 유지)
    if (append) figma.ui.postMessage({ type: 'show-toast', message: errStr(e) });
    else figma.ui.postMessage({ type: 'popup-recommend-result', sets: [], error: errStr(e) });
  }
  refreshBridgeStatus();
  return true;
}
// 버튼 라벨 안전망 — 버튼엔 마침표·물음표·종결어미를 쓰지 않는다(ux-writing.md "8. 팝업" 버튼 규칙).
// 프롬프트에도 같은 규칙을 넣지만 모델이 문장형('확인했어요')을 섞어 내는 일이 있어(실측) 여기서 잡는다:
//   ① 끝의 문장부호는 뗀다 ② 종결어미로 끝나는 제안은 버린다 — 단 2개 이상 남을 때만
//      (다 버려서 빈손이 되는 것보다 문장형이라도 보여주는 게 낫다)
// '네'·'아니오'는 걸리지 않는다(길이 2 이하 / '오' 끝).
function refineButtonSuggestions<T extends { text: string; reason: string }>(list: Array<T>, role?: string): Array<T> {
  if (role !== '버튼') return list;
  const cleaned = list.map((s) => {
    const t = s.text.replace(/\s*[.!?。]+\s*$/, '');
    return t !== s.text ? Object.assign({}, s, { text: t }) : s;
  });
  const looksSentence = (t: string) => t.length > 2 && /(요|다|까)$/.test(t);
  const keep = cleaned.filter((s) => !looksSentence(s.text));
  return keep.length >= 2 ? keep : cleaned;
}

// 프레임별(하위 프레임 묶음) 추천 — 영역마다 따로 대안을 받는다. 한 요청에 다 실어 보낸다
// (영역 수만큼 쪼개면 그만큼 느리고 구독 사용량도 그만큼 나간다).
type GroupSuggest = { name: string; suggestions: Array<{ text: string; reason: string }> };
async function fetchAiGroups(
  groups: Array<{ name: string; texts: string[]; role?: string }>,
  model?: string,
  more?: boolean
): Promise<Array<GroupSuggest>> {
  try {
    const payload = groups.map((g) => ({ name: g.name, texts: g.texts, role: g.role }));
    const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/recommend-groups', { groups: payload, model, more: !!more }, 130000);
    const data = await res.json();
    if (res.ok && data && Array.isArray(data.groups)) return data.groups;
    if (data && data.error) throw new Error('BRIDGE_GUIDE:' + String(data.error));
    // 200인데 groups가 없다 = 옛 버전 다리(이 경로를 모른다)
    if (res.ok) throw new Error('BRIDGE_GUIDE:클로드가 옛 버전으로 연결돼 있어요 — 다시 눌러 새 버전으로 연결해 주세요.');
    throw new Error('클로드 추천 실패: HTTP ' + res.status);
  } catch (e) {
    if (e instanceof Error && e.message.indexOf('BRIDGE_GUIDE:') === 0) throw new Error(e.message.slice('BRIDGE_GUIDE:'.length));
    if (e instanceof Error && e.message.indexOf('클로드 추천 실패') >= 0) throw e;
    throw new Error('클로드 추천 실패: ' + errStr(e));
  }
}

// 하위 프레임 묶음이 있는 선택에서 [전체]로 추천받을 때 — 영역마다 따로 결과를 만든다.
// 한 덩어리로 다듬으면 화면 전체가 한 문구처럼 섞여 나와 어느 영역 것인지 알 수 없다(사용자 지적).
const MAX_RECOMMEND_GROUPS = 10; // 한 번에 보낼 영역 수 상한 (프롬프트·응답 폭주 방지)
async function groupsRecommendFlow(
  groups: Array<{ name: string; texts: string[]; own?: boolean; role?: string }>,
  model: string | undefined,
  more?: boolean
): Promise<void> {
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
    const out: Array<GroupSuggest> = [];
    for (let i = 0; i < raw.length; i++) {
      const g = raw[i];
      // 버튼 영역이면 문장부호를 떼는 안전망까지 (단일 추천과 같은 처리)
      const suggestions = refineButtonSuggestions(
        await refineAiSuggestions(g.suggestions || []),
        send[i] && send[i].role
      );
      // 이름은 클로드 응답보다 우리가 보낸 것을 신뢰한다 (모델이 이름을 바꿔 적는 일이 있다)
      out.push({ name: (send[i] && send[i].name) || g.name || ('영역 ' + (i + 1)), suggestions });
    }
    figma.ui.postMessage({ type: 'hide-loading' });
    figma.ui.postMessage({ type: 'groups-recommend-result', groups: out, sent: send });
    if (dropped > 0) {
      figma.ui.postMessage({ type: 'show-toast', message: '영역이 많아 위에서부터 ' + send.length + '개만 다듬었어요. 나머지 ' + dropped + '개는 그 영역을 눌러 따로 받아 주세요.' });
    }
  } catch (e) {
    figma.ui.postMessage({ type: 'hide-loading' });
    figma.ui.postMessage({ type: 'groups-recommend-result', groups: [], error: errStr(e) });
    refreshBridgeStatus();
  }
}

// AI 제안 가져오기 — 클로드 다리 전용 (Gemini/API 키 경로 제거됨).
// 성공하면 {text, reason} 배열, 실패하면 사유 메시지를 담은 Error를 던진다.
async function fetchAiSuggestions(text: string, model?: string, role?: string): Promise<Array<{ text: string; reason: string }>> {
  try {
    // role='버튼'이면 다리가 버튼 규칙(동작 이름·마침표 없음)을 프롬프트에 얹는다
    const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/recommend', { text, model, role }, 130000);
    const data = await res.json();
    if (res.ok && data && data.suggestions && data.suggestions.length) return data.suggestions;
    // 다리의 error는 이미 사람용 안내문(자체 접두어 포함) — 여기서 또 접두어를 붙이면 "실패: 실패:"로 겹친다
    if (data && data.error) throw new Error('BRIDGE_GUIDE:' + String(data.error));
    throw new Error('클로드 추천 실패: HTTP ' + res.status);
  } catch (e) {
    if (e instanceof Error && e.message.indexOf('BRIDGE_GUIDE:') === 0) throw new Error(e.message.slice('BRIDGE_GUIDE:'.length));
    if (e instanceof Error && e.message.indexOf('클로드 추천 실패') >= 0) throw e;
    throw new Error('클로드 추천 실패: ' + errStr(e));
  }
}

// 팝업 세트 추천 — 팝업 전체(역할+문구)를 한 번에 다리로 보내 완성된 세트 2~3개를 받는다.
// 성공하면 { sets: [{reason, elements:[{role,text}]}] }, 실패하면 사유 메시지를 담은 Error를 던진다.
type PopupSet = { reason: string; elements: Array<{ role: string; text: string }> };
async function fetchAiPopup(
  elements: Array<{ role: string; text: string }>,
  model?: string,
  more?: boolean
): Promise<{ sets: Array<PopupSet> }> {
  try {
    const payload = elements.map((e) => ({ role: e.role, text: e.text }));
    // more=true면 다리가 "앞서 낸 세트와 겹치지 않는 새 세트"를 요구한다 (같은 세션 기억 활용)
    const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/recommend-popup', { elements: payload, model, more: !!more }, 130000);
    const data = await res.json();
    if (res.ok && data && Array.isArray(data.sets)) return data;
    // 다리의 error는 이미 사람용 안내문(자체 접두어 포함) — 여기서 또 접두어를 붙이면 "실패: 실패:"로 겹친다
    if (data && data.error) throw new Error('BRIDGE_GUIDE:' + String(data.error));
    // 200인데 sets가 없다 = 옛 버전 다리(응답 형식이 다름). 재연결이 필요하다는 신호.
    if (res.ok) throw new Error('BRIDGE_GUIDE:클로드가 옛 버전으로 연결돼 있어요 — 다시 눌러 새 버전으로 연결해 주세요.');
    throw new Error('클로드 추천 실패: HTTP ' + res.status);
  } catch (e) {
    if (e instanceof Error && e.message.indexOf('BRIDGE_GUIDE:') === 0) throw new Error(e.message.slice('BRIDGE_GUIDE:'.length));
    if (e instanceof Error && e.message.indexOf('클로드 추천 실패') >= 0) throw e;
    throw new Error('클로드 추천 실패: ' + errStr(e));
  }
}

// 팝업 세트 후처리 — 각 세트의 모든 문구에 사내 용어집(치환) + 네이버 맞춤법(검수)을 통과시킨다.
// refineAiSuggestions와 같은 안전망이지만, 세트는 역할이 다른 문구들이라 중복 제거는 하지 않는다
// (같은 버튼 문구가 여러 세트에 겹쳐도 각 세트를 온전히 유지해야 하므로).
async function refinePopupSets(sets: Array<PopupSet>): Promise<Array<PopupSet>> {
  // 1) 용어집 치환: 원문 → 치환문 매핑
  const map = new Map<string, string>();
  for (const st of sets) {
    for (const el of st.elements) {
      if (map.has(el.text)) continue;
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
      if (r && r.checked && r.text) map.set(orig, r.text);
    }
  } catch (e) {
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
function alignPopupButtons(set: PopupSet): PopupSet {
  const asking = set.elements.some((el) => el.role === '안내' && /까요\s*\?/.test(el.text));
  if (!asking) return set;
  const btnIdx: number[] = [];
  set.elements.forEach((el, i) => { if (el.role.indexOf('버튼') === 0) btnIdx.push(i); });
  if (btnIdx.length !== 2) return set;
  // 긍정(=네)은 주요 버튼. 둘 다 같은 역할이면 나중(오른쪽·아래)을 긍정으로 본다 — 확인 버튼이 오른쪽인 관례.
  const primaryPos = set.elements[btnIdx[0]].role === '버튼(주요)' ? 0
    : set.elements[btnIdx[1]].role === '버튼(주요)' ? 1 : 1;
  const want = [primaryPos === 0 ? '네' : '아니오', primaryPos === 0 ? '아니오' : '네'];
  if (btnIdx.every((idx, k) => set.elements[idx].text === want[k])) return set; // 이미 맞음
  const elements = set.elements.map((el) => ({ role: el.role, text: el.text }));
  btnIdx.forEach((idx, k) => { elements[idx].text = want[k]; });
  console.log('[POPUP] 물음형 본문 — 버튼을 [아니오]·[네]로 맞춤:', set.elements.map((e) => e.text).join(' / '));
  return { reason: set.reason, elements };
}

// AI 추천 후처리 — 클로드 결과에도 사내 용어집(치환)과 네이버 맞춤법(검수)을 한 번 통과시킨다.
// 다리 프롬프트에도 용어 규칙이 들어가지만(instructionMessage의 glossaryRules), 모델이 어겨도 여기서 잡는 안전망.
// 톤·문장 구조 규칙(REWRITE_RULES 등)은 AI가 이미 다룬 영역이라 건드리지 않는다 — 검사 파이프라인 0단계(합성어 보호→용어 통일)만 적용.
async function refineAiSuggestions(list: Array<{ text: string; reason: string }>): Promise<Array<{ text: string; reason: string }>> {
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
  } catch (e) {
    console.log('[RECOMMEND] AI 결과 맞춤법 검수 실패 — 교정 없이 표시', e);
  }
  // 교정으로 같은 문장이 된 제안 중복 제거
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.text) ? false : (seen.add(s.text), true)));
}

// 폴백 결과를 UI로 전송. failNote가 있으면(AI 실패) 토스트로 함께 알린다.
// emptyNote: 폴백 결과도 없을 때 보여줄 안내 (기본은 키 등록 안내)
// canAskAi: true면 카드 밑에 [AI 추천 더 받기] 버튼 노출 (AI 실패 후 재시도용)
function postRecommendFallback(text: string, failNote: string, emptyNote?: string, canAskAi?: boolean): void {
  const fallback = localFallbackRecommend(text);
  if (fallback.length) {
    figma.ui.postMessage({ type: 'recommend-result', original: text, suggestions: fallback, canAskAi: !!canAskAi });
    if (failNote) figma.ui.postMessage({ type: 'show-toast', message: 'AI 추천은 실패했어요. 예시와 규칙 기반으로 검토했어요. (' + failNote + ')' });
  } else if (failNote) {
    figma.ui.postMessage({ type: 'show-toast', message: failNote });
  } else {
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
const BRIDGE_MIN_V = 41;
async function bridgeHealth(): Promise<{ alive: boolean; ready: boolean; model?: string; problem?: string; account?: string; dir?: string }> {
  try {
    // 피그마의 네트워크 중계가 첫 요청에 느릴 수 있어 여유 있게 (다리 없으면 연결 거부라 즉시 실패함)
    const res = await fetchWithTimeout(CLAUDE_BRIDGE_URL + '/health', 3000);
    if (!res.ok) return { alive: false, ready: false };
    const d = await res.json().catch(() => ({} as any));
    // 11888을 우리 다리가 아닌 다른 앱이 점유한 경우 — 켜짐으로 착각하지 않는다
    if (!d || d.ok !== true || d.engine !== 'claude') return { alive: false, ready: false };
    // 구버전 다리가 떠 있음(코드는 새것인데 프로세스가 옛것) — 다른 problem보다 먼저 알린다.
    // 이걸 안 잡으면 새 코드의 동작을 기대한 사용자가 옛 동작을 보고 원인을 못 찾는다.
    if (!(typeof d.v === 'number' && d.v >= BRIDGE_MIN_V)) {
      return { alive: true, ready: !!d.ready, model: d.model, problem: 'bridge-old', account: d.account || undefined, dir: d.dir };
    }
    return { alive: true, ready: !!d.ready, model: d.model, problem: d.problem, account: d.account || undefined, dir: d.dir };
  } catch (e) {
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
let confirmedClaudeAccount: string | null = null;
// 저장된 확인 계정을 읽어 UI에 알린다 — UI는 이 값으로 첫 화면을 정한다
// (확인된 계정이 그대로면 계정 화면을 건너뛰고 홈으로).
const confirmedAccountLoaded: Promise<void> = figma.clientStorage.getAsync(CONFIRMED_ACCOUNT_KEY).then((v) => {
  confirmedClaudeAccount = (typeof v === 'string' && v) ? v : null;
  figma.ui.postMessage({ type: 'confirmed-account', account: confirmedClaudeAccount });
}).catch(() => { figma.ui.postMessage({ type: 'confirmed-account', account: null }); });
function accountNeedsConfirm(account?: string): boolean {
  return !!(account && account !== confirmedClaudeAccount);
}
// 확인 배너를 띄울 상황인가 — 계정을 알 수 있고(다리가 알려줌) 아직 확인 안 된 계정일 때.
// bridge-old는 다리가 낡았을 뿐 계정·추천은 정상 동작하므로 확인 대상에 포함한다
// (로그인 필요·설치 필요 상태에선 계정 확인보다 그 안내가 먼저라 제외).
function needsAccountConfirm(h: { alive: boolean; problem?: string; account?: string }): boolean {
  if (!h.alive) return false;
  if (h.problem && h.problem !== 'bridge-old') return false;
  return accountNeedsConfirm(h.account);
}

// 다리 상태를 다시 조회해 UI 버튼에 반영 — AI 호출 실패 직후 호출해서
// 로그인 만료(claude-logout) 같은 problem이 [클로드 켜짐] 표시를 바로 갱신하게 한다.
function refreshBridgeStatus(periodic?: boolean): void {
  bridgeHealth().then((h) => {
    // periodic=true(주기 갱신)이면 UI가 일회성 토스트(껐어요/켜졌어요)를 건너뛰고 라벨만 갱신한다
    figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem, account: h.account, needConfirm: needsAccountConfirm(h), periodic: !!periodic });
  });
}

// 다리를 새 코드로 재시작한다 — /shutdown → 감시자 /wake → /health 폴링. 재시작 후 health를 돌려준다.
// bridge-old(구버전 다리)일 때 사용자가 버튼을 누르지 않아도 자동 업그레이드하는 데 쓴다.
async function restartBridge(): Promise<ReturnType<typeof bridgeHealth> extends Promise<infer T> ? T : never> {
  try { await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/shutdown', {}, 3000); } catch (_e) { /* 이미 꺼졌으면 무시 */ }
  await new Promise((r) => setTimeout(r, 1200)); // 옛 다리가 스스로 종료할 시간
  try { await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000); } catch (_e) {
    try { figma.openExternal('claudebridge://start'); } catch (_e2) { /* 보조 경로도 실패 — 아래 상태 확인이 알려준다 */ }
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
async function autoUpgradeIfOld(bh: ReturnType<typeof bridgeHealth> extends Promise<infer T> ? T : never) {
  if (!bh.alive || bh.problem !== 'bridge-old') return bh;
  figma.ui.postMessage({ type: 'show-loading', indeterminate: true, status: '클로드를 새 버전으로 다시 연결하는 중이에요…' });
  const h = await restartBridge();
  refreshBridgeStatus();
  return h;
}

// 클로드다리 설치 파일 — 다리+예시+런처를 내장한 자기완결 bat. UI의 [🔧 설치 파일 받기]가 다운로드로 내려준다.
// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.bat을 base64로 주입) =====
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21saw0KWjJVcENpOHZJT3k4bk91UmtPdXB0Q0R0bEl6cm42enF0N2pzbmJqc25aZ2dXK3kybE95eW5PdXdtK3E0c0YzcXNJQWdSMlZ0YVc1cElPMkNwQ0RzbDRic25iVHJqNFFnN1lHMDY2R2M2NU9jNjZHY0lFRkpJT3kybE95eW5PeWRoQ0Ryc0p2cmlwVHJpNlF1Q2k4dkNpOHZJT3lHamV1UGhDRHNoS1RxczRRNklPMkJ0T3Vobk91VG5PdWx2Q0RzbXBUc3NxM3JwNGpyaTZRZzdJT0k2NkdjSU95TG5PdVBtZTJWbU91cHRDQXpNSDQwTU95MGlPcXdnQ0RxdDdqcmc2VWc2NEtnN0pXRTZyQ0U2NHVrTGdvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0NpOHZJQ0FnNnJDQTdKMjA2NU9jSyt5WWlPeUxuQ2d4TVRIcXNiUXA2NHFVSU95eXF5RHJxWlRzaTV6c3A0RHJvWndnN1pXY0lPdXlpT3VuakNEc25iM3QNCm5venJpNlF1SU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjZ5NDZyV3M2NmVNSU91enRPdUN0T3V2Z091aG5DRHJ1YURycGJUcmk2UXVDaTh2SU95RXVPeUZtT3lkZ0NBek1PdXlpQ0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3WlcwSU91TWdPMlpsT3F3Z0NEcnJMVHRsWnp0bm9nZzZyaTQ3SmEwN0tlQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaTh2Q2k4dklPeWdoT3lnbkRvZzdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0NjQrOElPeWVpT3lkaENEcXNvTWdLR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3Snk4NjZHY0lPMlpsZXlkdUNrS0x5OGc3S084N0oyWU9pRHNncXpzbXFucm40bnNuWUFnNnJDQjdKNlFJTzJCdE91aG5PdVRuQ0RxdGF6cmo0VWc3WldjNjQrRTdKZVE3SVNjSU95d3FPcXdrT3VRbk91THBDNEtDbU52Ym5OMElHaDBkSEFnUFNCeVpYRjFhWEpsS0Nkb2RIUndKeWs3Q21OdmJuTjBJR1p6SUQwZ2NtVnhkV2x5WlNnblpuTW5LVHNLDQpZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdA0KWTNka0p5azdDblJ5ZVNCN0lHWnpMbTFyWkdseVUzbHVZeWhGVFZCVVdWOURWMFFzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsSUgwcE95QjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUXBqYjI1emRDQkRURUZWUkVWZlJVNVdJRDBnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnY0hKdlkyVnpjeTVsYm5Zc0lIc0tJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcENpQWdRMHhCVlVSRlgwTlBSRVZmUkVsVFFVSk1SVjlPVDA1RlUxTkZUbFJKUVV4ZlZGSkJSa1pKUXpvZ0p6RW5MQ0F2THlEdGhMUWc3SnFVN0pXOUlPdVRzU0RydG9EcXNJQWc3Wmk0N0xhY0lPdUJsQW9nSUVSSlUwRkNURVZmVkVWTVJVMUZWRkpaT2lBbk1TY3NDbjBwT3dvS0x5OGc3SWlvNnJtQUlPeUxwTzJXaVNqcXNKRHNpNXpzbnBBZzdJcWsNCjdZK3c3SjJBSUhOMFpHbHZJR2xuYm05eVpTbnNsNURzaEp6cmo0UWc2Nnk0N0tDYzY2VzhJT3kybE95Z2dlMlZvQ0RzaUpnZzdKNkk2cktNSU95OW1PeUdsQ0Ryb1p6cXQ3anJwYndnN1l5TTdKMjg3SmVRNjQrRUlPdUNxT3E0dE91THBDNEtMeThnN0p5RTdMbVlPaURzbm9Uc2k1d2c3WSswNjQyVTdKMllJR05zWVhWa1pTMWljbWxrWjJVdWJHOW5JQ2pzbklqcmo0VHNtckFnSlZSRlRWQWxMQ0RycDZVZ0pGUk5VRVJKVWlrdUlESk5RaURyaEpqc25MenJxYlFnTG05c1pPdWhuQ0R0bFp3ZzdJUzQ2NHlBNjZlTUlPdXp0T3EwZ0M0S1kyOXVjM1FnVEU5SFgwWkpURVVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExteHZaeWNwT3dwamIyNXpkQ0JmYjNKcFoweHZaeUE5SUdOdmJuTnZiR1V1Ykc5bkxtSnBibVFvWTI5dWMyOXNaU2s3Q21OdmJuTnZiR1V1Ykc5bklEMGdablZ1WTNScGIyNGdLQ2tnZXdvZ0lHTnZibk4wSUdGeVozTWdQU0JCY25KaGVTNXdjbTkwDQpiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bg0KYVdaNUtHRXBLU2t1YW05cGJpZ25JQ2NwSUNzZ0oxeHVKenNLSUNBZ0lHWnpMbUZ3Y0dWdVpFWnBiR1ZUZVc1aktFeFBSMTlHU1V4RkxDQnNhVzVsS1RzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHRqSXpzbmJ3ZzY2R2M2cmU0SU95THBPMk1xTzJWdE91UGhDRHJpNlRycHF6cmlwUWc2ck9FN0lhTklDb3ZJSDBLZlRzS0NtTnZibk4wSUZCUFVsUWdQU0JPZFcxaVpYSW9jSEp2WTJWemN5NWxibll1UWxKSlJFZEZYMUJQVWxRcElIeDhJREV4T0RnNE95QXZMeUJDVWtsRVIwVmZVRTlTVk91S2xDRHRoWXpzaXFUdGlyanNtcWtnS08yUGlleUdqT3lYbENBeE1UZzRPQ0RxczZEc29KVXBDaTh2SU91THBPdW1yQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0F2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDNGc3TDJVNjVPYzY2VzhJSEIxYkd6Q3QrdXp0ZXlDck8yVnRPdVBoQ0FxS3V5ZHRPdXZ1Q0RybHFBZzdKNkk2NHFVSU91THBPdW1yT3VLbENEc21Kc2c3TDJVNjVPY0lPcTN1T3VNZ091aG5Db3ENCjY1MjhDaTh2SU9xN2tPdUxwQ0Rzdkp6cXVMQWc3S0NFN0plVUlPeURpQ0RyajVuc25wSHNuYlFnN0pXSUlPdUNtT3lZcU91THBDanRoTERycjdqcmhKRHNuYlFnNjV5bzY0cVVJT3VUc1NrdUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEc25iUWc2ckNTN0p5ODY2R2NJT3Exck91eWhPeWdoT3lkaENEcXNKRHNwNER0bGJRZzdKNnM3SXVjN0o2UjdJdWM3WUtvNjR1a0xnb3ZMeURyajVuc25wSHNuYlFnNjdDVTY0Q002NHFVSU95SW1PeWdsZXlkaENEdGxaanJxYlFnN0oyMElPeUlxK3lla091bHZDRHNtS3pycHF6cXM2QWdZMjlrWlM1MGMreWRtQ0JDVWtsRVIwVmZUVWxPWDFicmo0UWc2ckNaN0oyMElPeVlyT3Vtc091THBDNEtZMjl1YzNRZ1FsSkpSRWRGWDFZZ1BTQTBNVHNLTHk4ZzZyaXc2N080SU91cXFPdU51QzRnN0pxVTdMS3RLTzJVak91ZnJPcTN1T3lkdUNuc25iUWdiVzlrWld6c25ZUWc3S2VBN0tDVjdaV1k2Nm0wSU9xM3VDRHNtcFRzc3EzcnA0d2c2cmU0SU91cXFPdU51T3VobkNEc3NwanJwcXp0DQpsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPYw0KSUNoeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUWc0b0NVSUdKMWFXeGtMV2RzYjNOellYSjVMbXB6N0ptQUlPcXdtZXlkZ0NEdGpJenNoSndwSU9LVWdPS1VnQXBtZFc1amRHbHZiaUJzYjJGa1JYaGhiWEJzWlhNb0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzFrSUQwZ1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNzSUNkeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUW5LU3dnSjNWMFpqZ25LVHNLSUNBZ0lHTnZibk4wSUhObFkwbGtlQ0E5SUcxa0xuTmxZWEpqYUNndlhpTWpJT3kybE95eW5DRHNtSWpzaTV4Y2N5b2tMMjBwT3dvZ0lDQWdhV1lnS0hObFkwbGtlQ0E5UFQwZ0xURXBJSEpsZEhWeWJpQmJYVHNLSUNBZ0lHTnZibk4wSUdWNFlXMXdiR1Z6SUQwZ1cxMDdDaUFnSUNCc1pYUWdZM1Z5SUQwZ2JuVnNiRHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjbUYzSUc5bUlHMWtMbk5zYVdObEtITmxZMGxrZUNrdWMzQnNhWFFvSjF4dUp5a3ANCklIc0tJQ0FnSUNBZ1kyOXVjM1FnYkdsdVpTQTlJSEpoZHk1eVpYQnNZV05sS0M5Y2N5c2tMeXdnSnljcE93b2dJQ0FnSUNCamIyNXpkQ0JvSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYaU1qSTF4ekt5Z3VLejhwWEhNcUpDOHBPd29nSUNBZ0lDQnBaaUFvYUNrZ2V5QmpkWElnUFNCN0lHbHVjSFYwT2lCb1d6RmRMQ0J6ZFdkblpYTjBhVzl1Y3pvZ1cxMGdmVHNnWlhoaGJYQnNaWE11Y0hWemFDaGpkWElwT3lCamIyNTBhVzUxWlRzZ2ZRb2dJQ0FnSUNCamIyNXpkQ0JpSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYbHh6S2kxY2N5c29MaXMvS1Z4ektpUXZLVHNLSUNBZ0lDQWdhV1lnS0dJZ0ppWWdZM1Z5S1NCamRYSXVjM1ZuWjJWemRHbHZibk11Y0hWemFDaGlXekZkTG5Od2JHbDBLQ2NnTHlBbktTNXFiMmx1S0NjZ0p5a3BPd29nSUNBZ2ZRb2dJQ0FnY21WMGRYSnVJR1Y0WVcxd2JHVnpMbVpwYkhSbGNpZ29aU2tnUFQ0Z1pTNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dQaUF3S1RzS0lDQjlJR05oZEdOb0lDaGxLU0I3DQpDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpdw0KSU9xem9PeTVxQ0FySU95V3RPeUluQ0RyczREcXNyMGk3SjIwSU91UW5PdUxwQzRnN0pldDdaV2dJT3UyaE91bXJDRGlnSlFLTHk4ZzdZRzA2NkdjNjVPY0lEMGc2Nnk0N0o2bElPdUxwT3VUck9xNHNDanNzTDNzblpncExDRHNtcW5zbHJRZzdZYTE3SjI4d3JmcnA1N3N0cVRyc3BVZ1BTQmpiMlJsTG5SeklISmxabWx1WlVGcFUzVm5aMlZ6ZEdsdmJuTWc3WnVFN0xLWTY2YXNLT3E0c09xemhPeWdnU2t1Q21OdmJuTjBJRk5VV1V4RlgxSlZURVZUSUQwZ1d3b2dJQ2N4TGlEdGxiVHNtcFRzc3JRNklPdXFxT3VUb0NEcnJManF0YXpyaXBRZzdaVzA3SnFVN0xLMDY2R2NMaUFvNjdPMDY0T0Y2NHVJNjR1azRvYVM2N08wNjRLMDdKcVVLU2NzQ2lBZ0p6SXVJT3VLcGV1UG1leWdnU0RycDVEdGxaanF1TEE2SU91UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDd2dmdXlYaUNEcnVienF1TEFvNjdDVTY0Q003SmVJN0phMDdKcVU0b2FTNjdDVTZyK283SmEwN0pxVUtTNGc2NHVvTENEc29vWHJvNHpDdCt1bmpPdWoNCmpNSzM3SmV3N0xLMHdyZnRsYlRzcDREQ3QrcTRzT3VobmNLMzY0VzU3SjJNSU91VHNTRHNpNXpzaXFUdGhaenNuYlFnN0tPODdMSzA3SjI0SU9xeXNPcXp2T3VLbENEc2lKanJqNW50bUpVZzdKeWc3S2VBS095WHNPeXl0T3VQdk95YWxDd2c2NFc1N0oyTTY0Kzg3SnFVS1M0bkxBb2dJQ2N6TGlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd09pQWlmdTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVJaURyaklEc2k2QWdJbjd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWlJT3Exck95aHNDRHNtckRzaEtBdUlPdUxxQ3dnN0tDVjdMR0Y3SU9CSU91MmlPcXdnTUszN0oyODY3YUFJT3E0c091S3BTRHNvSnp0bFp6Q3QrdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3F5c09xenZNSzM3S0NWNjdPMElPdXp0TzJZdUNEc2xZanNpNnpzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJlaUM0bkxBb2dJQ2MwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phME9pQis3WldZN0l1YzZyS2c3SmEwDQo3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cA0KTGljc0NpQWdKell1SU8yUm5PcTRzRG9nNjVDWTdKYTA3SnFVNG9hUzY0Kzg3SnFVTGljc0NpQWdKemN1SU95a2hDRHF0YXpzb2JBNklPeWJrT3V6dU95ZHRDRHRsWndnN0tTRTdKMjA2Nm0wSU95MmxPeXluT3VQaENEcnNKanJrNXpzaTV3ZzdaV2NJT3lraE91aG5DNGc3SjZFN0oyWTY2R2NJT3lraE95ZGhDRHJpcGpycHF6c3A0QWc3SldLNjRxVTY0dWtMaURyaTZnc0lPeVhyT3VmckNEcnJManNucVhzbllRZzdaV1k2NEtZN0oyWUlPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25MenJvWndnN1pXcDdMT1FJT3VObENEcXNJVHFzckR0bGJUc3A0VHJpNlRycWJRZzdLU0VJT3lJbU91bHZDRHNwSVRzbmJUcmlwUWc2cktEN0oyQUlPMlptT3lZZ1M0bkxBb2dJQ2M0TGlEdGpKM3NsNFVvNjR1azdKMjA3SmE4NjZHYzZyZTRLU0Ryc29UdGlydzZJT3F5c09xenZDRHRoclhyczdUcmlwUWdXKzJabGV5ZHVGMHNJT3lZaUMvc2xZVHJpNGpzbUtRZzdZeVE2NHVvN0oyQUlGdnNsWVRyaTRqc21LUmRMMXZyaEtSZExDRHINCmo1bnNucEVnN0p5ZzY0K0U2NHFVSUZ2c3Q2anNob3hkTDF0NzY0K1o3SjZSZlYwdUlDTHN0NmpzaG93aTY0cVVJT3VQbWV5ZWtTRHJzb1R0aXJ6cXM3d2c3S2VkN0oyOElPdVZqT3VuakNEc2s3RHFzNkFnSXV1THErcTRzTUszNjQrWjdKNlJJdXl5bU91ZnZDRHNwNTBnN0pXSUlPdW5udXVLbENEc29iRHRsYW5DdCt1THFPdVBoU0FpN0xlbzdJYU1JdXVLbENEcXVJanNwNEF1Snl3S0lDQW5PUzRnN0oyMDY2YUV3cmZzb0lUdG1aVHJzb2p0bUxqQ3QrdW5pT3lLcE8yQ3VleWRnQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzBMaURzZ3F6cm5venNuWVFnNjdhQTY2VzhJT3VWa0NEcmk1anNuWVFnNjdhWjdKZXM2NCtFSU95aWkrdUxwQzRuTEFvZ0lDY3hNQzRnN0tDYzdaS0lJT3lhcWV5V3RDRHNuS0RzcDRBNklPeWVoZXVncGV5WGtDRHNrN0RzbmJnZzZyaXc2NHFsN0lTeElPdXFoZXlDckNqcnM0RHFzcjBzSU95bmdPeWdsU3dnNjVPeDY2R2RMQ0R0bGJUc29Kd2c2NU94S2V1S2xDRHRtWlRycWJUc25aZ2c2cml3DQo2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqcw0KaUpqcmo1bnRtSlhDdCtxeXZleVd0TUszNjdhQTdLQ1Y3WmlWSU8yWGlPeWFxU0RzdklEc25iVHNpcVFwN0oyWUlPdUptT3lWbWV5S3BPcXdnQ0RzbktEc2k2VHJrSnpyaTZRdUNpOHZJTzJNak95ZHZPeWR0Q0RzbDRic25MenJxYlFvN0lTazdMbVk2N080SU9xMXJPdXloT3lnaENEcms3RXBJT3U1aUNEcnJManNucERzbDdRZzRvQ1VJT3lhbE95VnZldW5qT3ljdk91aG5DRHJqNW5zbnBFb1ptRnBiQzF6YjJaMEtTNEtablZ1WTNScGIyNGdiRzloWkVkMWFXUmxLQ2tnZXdvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdFpDQTlJR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bkxDQW5kWGd0ZDNKcGRHbHVaeTV0WkNjcExDQW5kWFJtT0NjcExuUnlhVzBvS1RzS0lDQWdJSEpsZEhWeWJpQnRaQzVzWlc1bmRHZ2dQaUF4TURBZ1B5QnRaQ0E2SUNjbk93b2dJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2lxVHQNCmc0RHNuYndnNnJDQTdKMjA2NU9jSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lhbE95VnZldW5qT3ljdk91aG5DRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z0p5YzdDaUFnZlFwOUNtTnZibk4wSUVkVlNVUkZJRDBnYkc5aFpFZDFhV1JsS0NrN0NncG1kVzVqZEdsdmJpQnBibk4wY25WamRHbHZiazFsYzNOaFoyVW9LU0I3Q2lBZ1kyOXVjM1FnWm1WM1UyaHZkQ0E5SUVWWVFVMVFURVZUTG0xaGNDZ29aWGdwSUQwK0lDZEpibkIxZERvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtHVjRMbWx1Y0hWMEtTQXJJQ2RjYms5MWRIQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExuTjFaMmRsYzNScGIyNXpLU2t1YW05cGJpZ25YRzRuS1RzS0lDQnlaWFIxY200Z0tBb2dJQ0FnSit5bmdPcTRpT3UyZ08yRXNDRHJoSWpyaXBRZzdKZVE3SXFrN0p1UUtGTXRNU3dnNjdPMDdKV0k3WnFNN0lLc0tleWRtQ0R0bFp6cXRhM3NsclFnVlZnZ1YzSnBkR2x1WnlEc29JVHJyTGpxDQpzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91TA0KcEM0Z0p5QXJDaUFnSUNBbjdLR3c2ckcwSU8yUm5PMlloQ2pzbmJUc2c0SEN0K3lkdE8yVm1NSzM3SjIwNjRLMHdyZnN0SWpxczd6Q3QrdXZ1T3Vuak1LMzY3YUE3WVN3d3JmcXVZenNwNEFnNjVPeEtleWRnQ0Rzb0pYc3NZVWc3S0NWNjdPMDY0dWtJT0tBbENEcnVienFzYkRyZ3BnZzY0dWs2Nlc0SU95aHNPcXh0T3ljdk91aG5DRHJzSlRxdnJqc3A0QWc2NmVJNjUyOEtDSTE3WnFNSU95ZHRPeURnU0xzbllRZ0lqWHRtb3dpNjZHY0lPeWtoT3lkdE91cHRDRHNtS1RyaTdVcExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc2w1QWc3SmVHNjRxVUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN0l1YzZyQ0VJT3VUc1Nuc21ZQWc3WlcwNnJLd0lPdXdxZXV5bGNLMzdLQ0k3TENvS095ZXJPeUVwT3lnbGNLMzY2eTQ3SjJZN0xLWXdyZnNucXpzaTV6cmo0UWc2NU94S2V1bHZDRHNwNERzbHJUcmdyUWc2N2FaN0oyMDY0cVVJT3F5Zyt5ZGdDRHNvSWpyaklBZzZyaUkNCjdLZUFJT0tBbENEc2xZVHJpcFFnNnJDUzdKMjA2NTI4NjQrRUxDRHF0N2pybjdUcms2L3RsYlRyajRRZzdKT3c3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSnpQcXNKd2c3S0NjN0pXSTdKMkFJT3lFbk91aG5DRHNvSkhxdDd6c25iUWc2NHVzNjUyODdKVzhJTzJWbk91THBDRGlnSlFnN1pXWTY0S1k2NHFVSU95YmtPdXN1Q0RxdGF6c29iRHJwYndnN0p5ZzdLZUE3WldjSU95MW5PeUdqQ0RyaTZUcms2enF1TEFzSU8yVm1PdUNtT3VLbENEcnJManNucVVnNnJXczdLR3c2Nlc4SU95ZXJPcTFyT3lFc2UyVm5DRHJqSURzbFlnc0lDY2dLd29nSUNBZ0orcTN1T3Vtck9xem9DRHNvSUhzbHJUcmo0UWc3WldZNjRLWTY0cVVJT3F6dk9xd2tPMlZuQ0RzbnF6cXRhenNoTEU2SU95a2tldXp0U0R0a1p6dG1JVHNuWVFnNjQyYzdKYTA2NEswNnJPZ0xDRHNvSlhyczdRZzdJaWM3SVNjNjZXOElPeUNyT3lhcWV5ZWtPcXdnQ0RzbFl6c2xZVHNsYndnN1pXZ0lPcXlnK3UyZ08yRXNPdWhuQ0RzbnF6c29iRHNwNEh0DQpsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZw0KSUNBZ0oreVZoT3VlbUNEc21JanNpNXpyazZUc25ZQWc3WldjSU95a2hPeW5uT3VtckNEc3RaenNob3dnNnJXUTdLQ1Y3SjIwSU91bmp1eW5nT3VuakNEcXQ3anFzYlFnN1lha0tPMlZ0T3lhbE95eXRNSzM2cks5N0phMEtleWRtQ0RxdFpEcnM3anNuYlRzcDRBZzdJYU02cmU1N0lTeDdKMllJT3Exa091enVPeWR0Q0RzbFlUcmk0anJpNlFnNG9DVUlPeVhyT3VmckNEcnJManNucVhzcDV6cnBxd2c3SjZGNjZDbDdKMkFJT3VwbE95TG5PeW5nQ0RyaTZqc25JVHJvWndnNjR1azdJdWNJT3lFcE9xemhPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURyc0xEc2w3VHJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoY0szN0wyVTY1T2M3WTZjN0lxa0lPcTRpT3luZ0RwY2JpY2dLd29nSUNBZ0oxdDdJblJsZUhRaU9pQWk3S0NjN0pXSUlPdXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2cNCkl1dXN0T3lYaCt5ZGhDRHNtWndnNjdDVTZyK282NHFVN0tlQUlPMlZuT3ExcmV5V3RDRHRsWndnNjZ5NDdKNmxJbjBzSUM0dUxsMWNibHh1SnlBckNpQWdJQ0FuVyt5S3BPMkRnT3lkdkNEcXQ1enN1WmxkWEc0bklDc2dVMVJaVEVWZlVsVk1SVk1nS3lBblhHNWNiaWNnS3dvZ0lDQWdLRWRWU1VSRklEOGdKMXZzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jSU95Z2hPdXN1Q0FvZFhndGQzSnBkR2x1Wnk1dFpDa2c0b0NVSU95Y2hDRHF0NXpzdVpuc25aZ2c2cmU4NnJHdzdKbUFJT3lZaU95WnVDRHNpNXpyZ3BqcnBxenNtS1F1SU8yS3VlMmVpQ0RzbUlqc21iZ2c2cmVjN0xtWktPeUltT3VQbWUyWWxjSzM2cks5N0phMHdyZnJ0b0Rzb0pYdG1KWHNuWVFnN0p5ZzdLZUE3WlcwN0pXOElPMlZtT3VLbENEc2c0SHRtYWtwN0oyRUlPcTN1T3VNZ091aG5DRHJsTERycGJUcXM2QXNJT3lhbE95VnZlcXp2Q0Rzb0lUcnJManNuYlFnNjR1azY2VzA2Nm0wSU95Z2hPdXN1T3lkaENEcmxMRHJwYmpyaTZSZFhHNG5JQ3NnDQpSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cA0KYm1WQ2RXWWdQU0FuSnpzZ0lDQWdJQ0FnSUNBdkx5QnpkR1J2ZFhRZzdLU0VJT3V5aE8yTnZBcHNaWFFnZDJGcGRHVnlJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDOHZJTzJZaE95ZXJDRHRoTFRzblpnZ2V5QnlaWE52YkhabExDQnlaV3BsWTNRc0lIUnBiV1Z5SUgwS2JHVjBJSEYxWlhWbElEMGdVSEp2YldselpTNXlaWE52YkhabEtDazdJQzh2SU95YWxPeXlyU0RzcDRIcm9LenRtWlFnS091UG1leUxuQ0RzbXBUc3NxM3NuWUFnN0lpYzdJU2M2NHlBNjZHY0tRcHNaWFFnZEhWeWJuTWdQU0F3T3dwc1pYUWdkMkZ5YldWa1ZYQWdQU0JtWVd4elpUc0tiR1YwSUdOMWNuSmxiblJOYjJSbGJDQTlJRU5NUVZWRVJWOU5UMFJGVERzZ0x5OGc3S2VBNnJpSUlPeUV1T3lGbU95ZHRDRHJyTHpxczZBZzdKNkk2NHFVSU91cXFPdU51Q0FvN0pxVTdMS3Q3SjIwSU91THBPdWx1Q0RycXFqcmpianNuWVFnN0tlQTdLQ1Y3WldZNjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFcENpOHZJT3lMbk95ZWtTRHNpNXdnUTJ4aGRXUmwNCklFTnZaR1VvWTJ4aGRXUmxJRU5NU1NucXNJQWc3Sk80SU95SW1DRHNub2pyaXBUc3A0QWc3S0NRNnJLQUlPS0FsQ0RzbDRic25MenJxYlFnTDJobFlXeDBhT3VobkNEc2xZenJvS1FnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZuT3VMcEM0S0x5OGdiblZzYkQzdG1aWHNuYmdnN0tTUkxDQW5iMnNuUGV5Q3JPeWFxU0Rxc0lEcmlxVXNJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzlZMnhoZFdSbElPdXFoZXVndVNEc2w0YnNuWXdzQ2k4dklDZGpiR0YxWkdVdGJHOW5iM1YwSnoxamJHRjFaR1hyaXBRZzdKNkk3S2VBNjZlTUlPdWhuT3EzdU95ZHVDRHNoTGpzaFpnZzY2ZU02Nk9NSUNqdGhMUWc3SXVrN1l5b0lPeUxuQ0Rxc0pEc3A0QXNJT3lFc2VxenRTRHRoTFRzbmJRZzdKaWs2Nm0wSU95ZWtPdVBtU0R0bGJUc29Kd3BDaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzDQpucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWg0KN0oyQUlPcXl2ZXVobk91aG5DRHNucUh0bm9qcnI0RHJvWndnN0tTUjY2YTlJTzJSbk8yWWhPeWRoQ0RzazdUcmk2UUtZMjl1YzNRZ1RFOUhTVTVmUjFWSlJFVWdQU0FuN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdU95ZHRDRHRsWVRzbXBUdGxiVHNtcFFvN0pXSUlPdVFrT3F4c091Q21DRHJwNHpybzR3cElPS0FsQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGMGc2N0tFN1lxODdKMkVJT3VJaE91bHRPdXB0Q0Ryb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3lYdE95V3RPdVRuT3VncE95YWxDNG5Pd292THlEc2k2VHN1S0h0bFp3ZzY2eTQ2cldzNjVPa09pQWlSbUZwYkdWa0lIUnZJR0YxZEdobGJuUnBZMkYwWlRvZ1QwRjFkR2dnYzJWemMybHZiaUJsZUhCcGNtVmtJR0Z1WkNCamIzVnNaQ0J1YjNRZ1ltVWdjbVZtY21WemFHVmtJaWpycDR6cm80d3BMQW92THlBaVRtOTBJR3h2WjJkbFpDQnBiaURDdHlCUWJHVmhjMlVnY25WdUlDOXNiMmRwYmlJbzY2KzQ2NkdjNnJlNDdKMjQNCktTRGlnSlFnNjVHWUlPdUxwQ0RzbnFIdG5vanFzb3dnNjRTVDdaNk02NHVrQ21aMWJtTjBhVzl1SUdselFYVjBhRVZ5Y205eUtITXBJSHNLSUNCeVpYUjFjbTRnTDJGMWRHaGxiblJwWTJGMGZHOWhkWFJvZkdGd2FTQnJaWGw4Ykc5bklEOXBibnhzYjJkblpXUjhjMlZ6YzJsdmJpQmxlSEJwY21Wa0wya3VkR1Z6ZENoVGRISnBibWNvY3lrcE93cDlDaTh2SU95Q3JPeWFxU0R0bFp6cmo0UWc3TFNJNnJPOElPcXdrT3luZ0NEaWdKUWc2NkdjNnJlNDdKMjQ3SjJBSU91cGdPeXBvZTJWbk91TnNDQWk2NDJVSU91cXV5RHNrN1RyaTZRaTY0cVVJT3F5dmV5YXNDNGc2NkdjNnJlNDdKMjRJT3Vuak91ampPeVpnQ0Rzb2JEc3VaanFzSUFnNjR1czY1Mjg3SVNjSU91VXNPdWhuQ0RzbnFIcmlwVHJpNlF1Q2k4dklPeUxwT3k0b1NneU1ESTJMVEE0TENEdG1venNncXdnN0plVTdZU3c3WlNFNjUyODdKMjA3S2FJSU95aWpPeUVuU2s2SUNKWmIzVW5kbVVnYUdsMElIbHZkWElnYVc1a2FYWnBaSFZoYkNCemNHVnVaQ0JzDQphVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6cw0KbnBEc2w1RHFzb3dnN1pXYzY0K0U2Nlc4SU95WXJPdWdwQ0RyaTZ6cm5ienFzNkFnN0pxVTdMS3Q3WldZNnJPZ0xDRHNsWVRyaTRqcnFiUWdXL0NmbjZBZzdZRzA2NkdjNjVPY0lPMlZuT3VQaENEc3RJanFzN3hkSU91eWhPMkt2T3lkaENEcmlJenJuNndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxiUWc3S084N0lTNDdKcVVMaWM3Q2k4dklDZnRsWnpyajRRbjY2R2NJT3V0aWV1YXNlcTN1T3Vtck91cHRDRHNsWWdnNjVDYzY0dWtJT0tBbENEc25xRHF1WkFnNjZxdzY2YTBJT3VWakNEcmdwanJpcFFnY21GMFpTQnNhVzFwZE95ZHRPdUNtQ0RyckxqcnA2VWc2cmk0N0oyMElPeTBpT3F6dk9xNWpPeW5nQ0RzbnFIc2xZUUtMeThnN0plSjY1cXg3WldZNnJLTUlDTHJpNlRycGJnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJWbU91ZHZDTHFzNkFnN0pXSTY0SzA3WldZNnJLTUlPdVFuT3VMcEM0ZzdLZUE3TGFjd3Jmc2dxenNtcW5ybjRrZzdJT0I3WldjSU91c3VPcTENCnJPdW5qQ0Rzb29IdG1JRHNoSndnNjdPNDY0dWtDbVoxYm1OMGFXOXVJR2x6VEdsdGFYUkZjbkp2Y2loektTQjdDaUFnY21WMGRYSnVJQzl6Y0dWdVpDQnNhVzFwZEh4MWMyRm5aUzFqY21Wa2FYUnpmSFZ6WVdkbElHeHBiV2wwSUNoeVpXRmphR1ZrZkdWNFkyVmxaR1ZrS1M5cExuUmxjM1FvVTNSeWFXNW5LSE1wS1RzS2ZRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU8yWmxleWR1Q0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOejY2VzhJT3lkdmV5V3RBb3ZMeUF2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDQW83WlNNNjUrczZyZTQ3SjI0N0oyMElDTHJpSVRxdGF3ZzZyT0U3S0NWN0p5ODY2R2NJT3lUc091S2xDRHNwSkhzbmJqc3A0QWlJTzJSbk95TG5DRGlnSlFnNnJPMTdKcXBJRkJEN0plUTdJU2NJT3VDcU95ZG1DRHFzNFRzb0pVZzdKaWs3SUtzN0pxcElPdXdxZXluDQpnQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMA0KSU95ZHRDRHFzSkxxczd3ZzdZeU03SjI4N0oyWUlPcXpoT3lnbGV5ZHRDRHNsclRxdUl2cmdwenJpNlFLYkdWMElITmxjM05wYjI1QlkyTnZkVzUwSUQwZ2JuVnNiRHNLTHk4ZzdJdWs3S0NjSU91aG5PcTN1T3lkdUNEc2w2enJ0b0RyaXBRZzdKNlE2cktwN0thZDY2cUZJTzJNak95ZHZPdWhuQ0R0akpEcmk2anRsWnpyaTZRZzRvQ1VJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKMllJRzloZFhSb1FXTmpiM1Z1ZE91S2xDQXFLdXVobk9xM3VPeVZoT3liZysyVnRPdVBoQ0RyZ3FqcmlwVHJpNlFxS2dvdkx5QW83SXVrN0xpaE9pQmpiR0YxWkdVZ1lYVjBhQ0J6ZEdGMGRYUHJpcFFnYkc5bloyVmtTVzQ2Wm1Gc2MyWHNuYmpyamJBZzZyZTRJTzJWaE91VG5PdUtsQ0RxdDdqcmpJRHJvWndnNG9hU0lPMlVqT3Vmck9xM3VPeWR1T3lkdENEcm9aenF0N2pzbmJqcmtKd2c2cktEN0xLWTY1KzhJTzJSbk95TG5PMldpT3VMcENrdUNpOHZJTzJNak95ZHZPdW5qQ0RzbmIzc25MenJyNERyb1p3ZzY3bUU3SnFwSURBdUlHTnMNCllYVmtaU0JoZFhSb0lITjBZWFIxYyt1bHZDRHJ0b0RycGJUcnFiUWc3S0NWN1ptVjdaV1k3S2VBNjZlTUlPMlVoT3Vobk95RXVPeUtwT3VsdkNEcm5ZVHNtNHpzbGJ3ZzdaVzA3SVNjSU95aHNPMmFqT3VuaU91THBDRHNrN0RxdUxEc2w1UWc2NnkwNnJLQjY0dWtMZ3BtZFc1amRHbHZiaUJvWVhORGJHRjFaR1ZEY21Wa1pXNTBhV0ZzY3lncElIc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdaaUE5SUhCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxKeXdnSnk1amNtVmtaVzUwYVdGc2N5NXFjMjl1SnlrN0NpQWdJQ0JqYjI1emRDQnFJRDBnU2xOUFRpNXdZWEp6WlNobWN5NXlaV0ZrUm1sc1pWTjVibU1vWml3Z0ozVjBaamduS1NrN0NpQWdJQ0JwWmlBb2FpQW1KaUJxTG1Oc1lYVmtaVUZwVDJGMWRHZ2dKaVlnYWk1amJHRjFaR1ZCYVU5aGRYUm9MbUZqWTJWemMxUnZhMlZ1S1NCeVpYUjFjbTRnZEhKMVpUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUR0akl6c25id2c3SmVHDQo3SjJNd3JmcnFyc2c3SjI5N0oyTUlPS0FsQ0RycDZYc25iVHJxYlFnN1lLazdMSzA3SjI0N0oyRUlPdW5pT3lnZ0NEcnM3anJpNlFnS2k4Z2ZRb2dJQzh2SUNvcTY2ZWw3SjJBSU95ZWtPcXlxZXltbmV1cWhleWRoQ0R0akl6c25ienNuYlFnN0pXRTY0dUk2NTI4SU8yQ3BPeXl0T3lkdU95WGtDRHJoS1ByaXBUcmk2UXFLaUFvTWpBeU5pMHdPQ0RzaTZUc3VLRXNJT3VMcE91bXJDQjJOREVnTHlEcXNKRHNpNXpzbnBBZ2RqWXBMZ29nSUM4dklPdW5wZXlkbUNCRGJHRjFaR1VnUTI5a1pldUtsQ0IrTHk1amJHRjFaR1V2TG1OeVpXUmxiblJwWVd4ekxtcHpiMjdzbllRZzdKV0U3SmlJSU91bmpPdVRwT3luZ0NEc2xZcnFzNkFnN1lLazdMSzA3SjI0SU8yVnJldXFxUW9nSUM4dklDZERiR0YxWkdVZ1EyOWtaUzFqY21Wa1pXNTBhV0ZzY3lmc2w1QWc3S0NBN0o2bDdaV2M2NHVrSU9LR2tpRHRqSXpzbmJ6cnA0d2c2N08wNjZtMElPdXBnT3lwb2UyZWlDRHJvWnpxdDdqc25ianJrSndnNjZlbDdKMjBJT3VLbUNBbg0KNjZHYzZyZTQ3SjI0SU95VmlDRHJrS2duN0oyMElPdVFtT3F6b0N3S0lDQXZMeURyb1p6cXQ3anNuYmdnNjR5QTZyaXdJTzJabE91cHRPeWR0Q0RzbUlIc21JRWc2NCtJNjR1a0tPdUlqT3Vmck91UGhDQkRURW5xc0lBZ0l1eWR0T3V2dUNEcm9aenF0N2pzbmJqcmtLZ2k3Snk4NjZHY0lPeW1pZXlMbkNEcmdaM3JncGdnNjdpTTY1Mjg3SnF3N0tDQTdLR3c3TENvSU95VmlDRHNsN1RycHJEcmk2UXBMZ29nSUM4dklDb3E3S0cwN0o2czY2ZU1JTzJabGV5ZHVPMlZuT3VMcENndGR5RHNsNGJzbll3cEtpb2c0b0NVSU91NWhPdXdnT3V5aU8yWXVDRHFzSkxzbllRZzdKMjk3Snk4NjZtMElPMkNwT3l5dE95ZHVDRHNvSkhxdDd3ZzdaZUk3SnFwSU8yTW5leVhoZXlkdENEcm5MQWc3SWlZSU95ZWlPdUxwQzRnN0pXOUlETXdiWE11Q2lBZ0x5OGdRMEpmVGs5ZlMwVlpRMGhCU1U0OU1leWR0T3VwdENEdGpJenNuYnpycDR3ZzY3TzQ2NHVrSUNqcnFxanNuWmdnN1ptSTdKeTg2NkdjSUNmcm9aenF0N2pzbmJnZzdKZUcNCjdKMk1KK3lkaENEc25xenRtSVR0bFpqcmlwUWc3WVdNN0lxazdZcTQ3SnFwSU9LQWxDRHRncVRzc3JUc25ianNuWUFnU0U5TlJleWRoQ0RzbFlnZzY1U3c2Nlc0NjR1a0tTNEtJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBaFBUMGdKMlJoY25kcGJpY2dmSHdnY0hKdlkyVnpjeTVsYm5ZdVEwSmZUazlmUzBWWlEwaEJTVTRnUFQwOUlDY3hKeWtnY21WMGRYSnVJR1poYkhObE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnlJRDBnYzNCaGQyNVRlVzVqS0NkelpXTjFjbWwwZVNjc0lGc25abWx1WkMxblpXNWxjbWxqTFhCaGMzTjNiM0prSnl3Z0p5MXpKeXdnSjBOc1lYVmtaU0JEYjJSbExXTnlaV1JsYm5ScFlXeHpKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuTENCMGFXMWxiM1YwT2lBek1EQXdJSDBwT3dvZ0lDQWdjbVYwZFhKdUlISXVjM1JoZEhWeklEMDlQU0F3T3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGRIVnliaUJtWVd4elpUc2dmU0F2THlCelpXTjFjbWwwZWV1bHZDRHJxcnNnDQo2N2FBNjZhRUlEMGc2NkdjNnJlNDdKMjRJT3lWaUNEcmtLanNuTHpyb1p3ZzY3TzQ2NHVrQ24wS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzS0lDQnBaaUFvUkdGMFpTNXViM2NvS1NBdElHRmpZMjkxYm5SRFlXTm9aUzVoZENBOElETXdNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3dvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0NpQWdkSEo1SUhzS0lDQWdJR2xtSUNob1lYTkRiR0YxWkdWRGNtVmtaVzUwYVdGc2N5Z3BLU0I3SUM4dklPeWVrT3F5cWV5bW5ldXFoZXlkdENEc2w0YnNuTHpycWJRZzY0S283SjJBSU95ZHRPdXBsT3lkdk95ZGdDRHJyTFRzaTV6dGxaenJpNlFLSUNBZ0lDQWdZMjl1YzNRZ2FpQTlJRXBUVDA0dWNHRnljMlVvWm5NdWNtVmhaRVpwYkdWVGVXNWpLSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDY3VZMnhoZFdSbExtcHpiMjRuS1N3Z0ozVjBaamduS1NrN0NpQWdJQ0FnSUdWdFlXbHNJRDBnS0dvZ0ppWWdhaTV2WVhWMA0KYUVGalkyOTFiblFnSmlZZ2FpNXZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOektTQjhmQ0J1ZFd4c093b2dJQ0FnZlFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdWhuT3EzdU95ZHVDRHNuYlRyb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDRHNuS0RzcDRBZ0tpOGdmUW9nSUdGalkyOTFiblJEWVdOb1pTQTlJSHNnWVhRNklFUmhkR1V1Ym05M0tDa3NJR1Z0WVdsc0lIMDdDaUFnY21WMGRYSnVJR1Z0WVdsc093cDlDbVoxYm1OMGFXOXVJR05vWldOclEyeGhkV1JsUVhaaGFXeGhZbXhsS0NrZ2V3b2dJR052Ym5OMElIQnliMkpsSUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbkxTMTJaWEp6YVc5dUoxMHNJSHNnYzJobGJHdzZJSFJ5ZFdVc0lHVnVkam9nUTB4QlZVUkZYMFZPVmlCOUtUc0tJQ0JzWlhRZ2IzVjBJRDBnSnljN0NpQWdjSEp2WW1VdWMzUmtiM1YwTG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzZ2IzVjBJQ3M5SUdRdWRHOVRkSEpwYm1jb0tUc2dmU2s3Q2lBZ2NISnYNClltVXViMjRvSjJWeWNtOXlKeXdnS0NrZ1BUNGdleUJqYkdGMVpHVlRkR0YwZFhNZ1BTQW5ZMnhoZFdSbExXMXBjM05wYm1jbk95QjlLVHNLSUNCd2NtOWlaUzV2YmlnblkyeHZjMlVuTENBb1kyOWtaU2tnUFQ0Z2V3b2dJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdLR052WkdVZ1BUMDlJREFnSmlZZ0wxeGtLMXd1WEdRckx5NTBaWE4wS0c5MWRDa3BJRDhnSjI5ckp5QTZJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGdRMnhoZFdSbElFTnZaR1VnN0tDUTZyS0FPaUFuSUNzZ1kyeGhkV1JsVTNSaGRIVnpJQ3NnS0c5MWRDQS9JQ2NnS0NjZ0t5QnZkWFF1ZEhKcGJTZ3BJQ3NnSnlrbklEb2dKeWNwS1RzS0lDQjlLVHNLZlFvdkx5RHNzcGpycHF3ZzdaaUU3Wm1wSU9LQWxDQXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZ0Q0FpN0tDVjY2ZVFJTzJCdE91aG5PdVRuT3F3Z0NEcmk3WHRsb2pyaXBUc3A0QWlJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsYUFnDQo3SWlZSU95ZWlPcXlqQ0R0bFp6cmk2UUtZMjl1YzNRZ2MzUmhkSE1nUFNCN0lITmxjblpsWkRvZ01Dd2diR0Z6ZEVGME9pQW5KeXdnYkdGemRGUmxlSFE2SUNjbkxDQnNZWE4wVTJWak9pQW5KeUI5T3dvS0x5OGc0cFNBNHBTQUlPMlVqT3Vmck9xM3VPeWR1Q0RzZzUzc29iUWc2ckNRN0tlQUtPeUxyT3llcGV1d2xldVBtU2tnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RybHFBZzdKNkk2NHFVSU91UG1leVZpQ0JqYjJSbExuUno2ckNBSURYc3RJanJwNGpyaTZRZ1VFOVRWQ0F2YUdWaGNuUmlaV0YwNjZXOElPdXp0T3VDdU91THBDNEtMeThnN1pXY0lPdXlpT3lkdE91ZHZPdVBoQ0Ryc0p2c25ZQWc2NUtrSURNdzdMU0k2ckNFSU91Qml1cTRzT3VwdENEdGxJenJuNnpxdDdqc25iZ282NWlRNjRxVQ0KSU8yVXZPcTN1T3VuaUNuc25iUWc2NHVyN1o2TUlPcXlneURpZ0pRZzdZRzA2NkdjNjVPYzZybU03S2VBSU91TnNPdW1yT3F6b0NEcXNKbnNuYlFnNnJxODdLZUU2NHVrTGdvdkx5RHNsWVRzcDRFZzdaV2NJT3V5aU91UGhDRHJxcnNnNjdDYjdKV1k3Snk4NjZtMEtPdUxwT3Vtck91bmpDRHJxTHpzb0lBZzdMeWdJT3lEZ2UyRG5Dd2c3SjZRNjQrWjdJdWM3SjZSSU91VHNTa2c2ck9FN0lhTklPdU1nT3E0c08yVm5PdUxwQzRLWTI5dWMzUWdTRVZCVWxSQ1JVRlVYMFJGUVVSZlRWTWdQU0F6TURBd01Ec0tiR1YwSUd4aGMzUkNaV0YwSUQwZ01Ec0tjMlYwU1c1MFpYSjJZV3dvS0NrZ1BUNGdld29nSUdsbUlDaHNZWE4wUW1WaGRDQW1KaUJFWVhSbExtNXZkeWdwSUMwZ2JHRnpkRUpsWVhRZ1BpQklSVUZTVkVKRlFWUmZSRVZCUkY5TlV5a2dld29nSUNBZ0x5OGdLaXJyb1p6cXQ3anNuYmdnN0tTUjdKMjA2Nm0wSU95VmlDRHF1cnpzcDRUcmk2UXFLaUFvTWpBeU5pMHdPQ3dnUWxKSlJFZEZYMVk5TXpjcE9pQmwNCmVHbDBJTzJWdU91VHBPdWZyT3F3Z0NCcmFXeHNURzluYVc1UWNtOWo2cm1NN0tlQUlPdTJnT3VsdE91dmdPdWhuQW9nSUNBZ0x5OGc3SmVzNnJpdzdJU2NJT3E2dk95bmdPdXB0Q0RydUl6cm5ienNtckRzb0lEc2w1RHNoSndnNjZHYzZyZTQ3SjI0N1pXWTY0MllJT3lDck91ZWpPeWRtQ0Rzdlp6cnNMRWc3WStzN1lxNDZyQ0FJT3VMcSsyWWdDQWliRzlqWVd4b2IzTjA3SmVRN0lTY0lPeVhzT3F5c095ZGhDRHFzYkRydG9EdGxvanNpclhyaTRqcmk2UWk2ckNBQ2lBZ0lDQXZMeURybktqcXNiRHJncGdzSU91aG5PcTN1T3lkdUNEc3NMM3NuYlFnN0lhTTY2YXNJT3lYaHV5ZHRDRHJyTFR0bXFqcXNJQWc2NUNjNjR1a0tPeUxwT3k0b1NEaWdKUWc3WlNNNjUrczZyZTQ3SjI0N0oyRUlPdUxxK3lWaENEcmtaUWc3TEdFSU91aG5PcTN1T3lkdU8yVm1PdXB0Q0RycDZUcnNvZ2c3SjIwNjU2czY0dWtLUzRLSUNBZ0lDOHZJT3Vobk9xM3VPeWR1T3lkZ0NEcnVJenJuYnpzbXJEc29JRHNsNURzaEp3ZzdJS3M2NTZNDQo3SjIwSU95bmhPMldpZTJWbU91S2xDRHNuYnpzbmJUcm5id2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPdVdvQ0Rzbm9qc25ZUWc3WldFN0pxVTZyQ0FJT3lYaHV1THBDNGc2NnkwN1pXY0lPdU1nT3E0c0NEc25JVHRsNWpzbllBS0lDQWdJQzh2SUd4dloybHVVSEp2WTFScGJXVnlLRE13NjdhRUtlcXdnQ0RycDRucmlwVHJpNlFnNG9DVUlPcTN1Q0R0ZzREc25iVHJxTGpxc0lBZzY2R2M2cmU0N0oyNDdKMkVJT3lnbGV1bXJPMlZtT3VwdENEcmk2VHNuWXdnN0tDUTZyS0E3SmVRN0lTY0lPeWdsZXlEZ2V5Z2dleWN2T3VobkNEcXVyenNwNFRyaTZRdUNpQWdJQ0JwWmlBb2JHOW5hVzVRY205aktTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaTZ6c25xWHJzSlhyajVuc25ZQWc2NEdLNnJLODdLZUE2NmVNSU91aG5PcTN1T3lkdU95ZHRDRHNwNFR0bG9rZzdLU1I3SjIwNjUyOElPcTRzT3VMcE91bXZldUxpT3VMcENBbzY2R2M2cmU0N0oyNElPdUJuZXVDbU91cHRDRHNvSlhycHF6cg0Ka0tucmk0anJpNlFwTGljcE93b2dJQ0FnSUNCeVpYUjFjbTQ3Q2lBZ0lDQjlDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNNNjUrczZyZTQ3SjI0SU95THJPeWVwZXV3bGV1UG1TRHJnWXJxdVlBZzRvQ1VJTzJVdk9xM3VPdW5pQy90bEl6cm42enF0N2pzbmJqc25iUWc2NHVyN1o2TUlPcXlnK3ljdk91aG5DRHJzN1RxczZBZzZyQ1o3SjIwSU9xNnZPeW5rZXVMaU91THBDNG5LVHNLSUNBZ0lIQnliMk5sYzNNdVpYaHBkQ2d3S1RzZ0x5OGdaWGhwZENEdGxianJrNlRybjZ6cXNJQWdhMmxzYkZCeWIyUHNuTHpyb1p3Z1kyeGhkV1JsSU8yS3VPdW1yT3VsdkNEc29KWHJwcXp0bFp6cmk2UUtJQ0I5Q24wc0lEVXdNREFwT3dvS0x5OGc3SnU1SU91aG5PcTN1T3lWaE95YmcreWRoQ0RydUl6cm5ienNtckRzb0lEcm9ad2c3SmVzNjRxVUlPeTlsT3VUbk91S2xDRHNvSnpxc2JEdGxvanJpNlFnS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRRd0tTRGlnSlFnNjZHYzZyZTQ3SjI0SU8yWmxPdXANCnRPeWR0Q0Rya1pBZzZyQ2NJT3VXb095RW5Bb3ZMeURzbHJUcmlwQWc3S3E5N0plUUlPdWhuT3EzdU95ZHVPMlZ0T3lWdkNEdGxaanJpcFRzcDRBZzdKV01JT3lJbUNEc2w0YnNsNGpyaTZRbzdJdWs3TGloSU95TG9PcXpvQ2t1SU95S3VleWR1Q0R0bVpUcnFiVHNuWVFnNnJHMDY0U0k2NXV3NjZDazY2bTBJT3lDck95YXFleWVrT3F3Z0NEcnVJenJuYnpzbXJEc29JRHNsNURzaEp3S0x5OGc3S2VCN0tDUklHTnNZWFZrWlNEcm9aenF0N2pzbFlUc200UHNuWVFnN1pXWTZyR3c2NEtZTENEc2lybnNuYmdnN1ptVTY2bTBJTzJWbU91THFDQmI2ck9FN0tDVklPeWdoTzJabUYzc25ZUWc3Sk93NjZtMElPdVFuT3VMcEM0Z0tpcnRnNjNzbllBZzdaV3Q3SU9CSURIcXNKenJvWndnN0p5ZzdLZUE3WldnSU9xeWd5NHFLZ29LTHk4ZzRwcWc3N2lQSU91aG5PcTN1T3lkdUNEcXNyM3JvWnpzbDVEc2hKd2dLaXBDVWs5WFUwVlM2Nlc4SU9xeHRPdVRuT3Vtck91cHRDRHNsWWdnNjVDYzY0dWtLaW9nS0RJd01qWXRNRGdnDQo3SXVrN0xpaElETHRtb3pyb1p3ZzdabVY3S0NWS1RvS0x5OGdJQ0JDVWs5WFUwVlM2Nlc4SU95RXBPeWdsZTJWbU91cHRDanJnclRzbXFuc25iUWc2NnkwN0plSDdKMjA2NU9nTENEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU8yVm1PdUtsQ0J1YnkxdmNPeWR0T3lXdE91UGhDa2dZMnhoZFdSbElFTk1TZXF3Z0NEcnVJenJuYnpzbXJEc29JQWc3Wlc0NjVPYzdKaWs3WlNFNjZXOENpOHZJQ0FnN1krczZyaXc3WldZNnJPZ0lDb3FJdXlkdU95bW5TRHN2WlRyazV6cnBid2dRMnhoZFdSbElFTnZaR1hzbDVBZzY3YVo3SmVzNjRTajdKeTg3SVM0N0pxVUlpRHJzS25zaTUzc25MenJvWndnNjdDVTY0Q1E2NHVrS2lvdUlPdUxwT3Vtck91S2xDRHJvWnpxdDdqc25iZ2c3WlNFNjZHYzdJUzQ3SXFrNjZXOENpOHZJQ0FnN0lpbzZyS283SVNjSUhOMFpHbHVJT3lYaHV5ZHRDRHJuWVRzbXJEcnI0RHJvWndnNjdhWjdKZXM2NFNqN0oyRUlPcXpzK3lkdENEc2w0YnNsclFnNjZHYzZyZTQ3SjI0N0oyMElPeVZoT3lZaUNEcg0KdG9qcXNJRHJpcVh0bGJUc3A0VHJpNlF1Q2k4dklDQWdLR3h2WTJGc2FHOXpkQ0JNU1ZOVVJVN3NuYlFnNjVhZ0lPeWVpT3VLbENEcXNvUHJwNHdnNjdPMDZyT2dJT3lla091UG1TRHNpSmpyb0xuc25iUWc3SnlnN0tlQTY1Q2M2NHVrNnJPZ0lPMk1rT3VMcU8yV2lPdU5tQ0Rxc293ZzdKaWs3S2VFN0oyMDdKZUk2NHVrTGlrS0x5OGdJQ0RpaHBJZzZyZTQ2NTZZN0lTY0lDTHRnNjBnTWVxd25DQXJJT3F6aE95Z2xTRHNoS0R0ZzUwZzdabVU2Nm0wSXV5ZGdDRHNuYlFnUTB4SjY2R2NJT3UyaU9xd2dPdUtwZTJWbU91THBEb2c3WldjSU8yRHJleWN2T3VobkNEc25vZnNucERycWJRZ1EweEo3SjJZSU95WHRPcTRzT3VsdkNEcnA0bnNsWVRzbGJ3S0x5OGdJQ0R0bFpqcXM2QXNJT3VuaWV5Y3ZPdXB0Q0RzdlpUcms1d2c2N2FaN0plczY0U2o2cml3NnJDQUlPdVFuT3VMcEM0ZzY2R2M2cmU0N0pXRTdKdUQ3SjJFSU91VXNPdWhuQ0RzbDdUcnFiUWc3WU90N0oyMElETHFzSnpxc0lBZzY1Q2M2NHVrTGdvdkx5QWcNCklPcXlzT3Vob0Nqc2dxenNtcW5zbnBBZzZyS3c3S0NWS1RvZ0tpcnRnNjBnTWVxd25DQXJJT3lLdWV5ZHVDRHRtWlRycWJRcUt1eWRoQ0RzazdEcXM2QXNJT3F6aE95Z2xTRHNvSVR0bVpqc25ZQWc2cmU0SU8yWmxPdXB0T3lkbUNCYjZyT0U3S0NWSU95Z2hPMlptRjBnNjdLRTdZcTg3Snk4NjZHY0lPMlZuT3VMcEM0S0x5OGdJQ0RzZ3Ezc29KenJrSndnN0l1YzY0K0U2NU9rT2lCM2NtbDBaVTV2YjNCQ2NtOTNjMlZ5SUM4Z2IzQmxibFZ5YkVsdVJHVm1ZWFZzZEVKeWIzZHpaWElnTHlCaWRXbHNaRXh2WjI5MWRFTm9ZV2x1VlhKc0lDanJzN1hxdGF6cmlwUWdaMmwwSU8yZWlPeUtwTzJHb091bXJDa3VDaTh2SU9LVWdPS1VnQ0Ryb1p6cXQ3anNuYmpzbllBZ1EweEo2ckNBSU9xNHNPdXp1Q0RydUl6cm5ienNtckRzb0lEcnBid2c3S2VCN0tDUklPeVh0T3F5akNEdGxaenJpNlFnS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRNd0tTRGlsSURpbElBS0x5OGc3SnF3NjZhczZyQ0FJRUpTVDFkVFJWTHJwYndnDQo2ckNBNjZHYzdMR0U2ckd3NjRLWUlPeXd2ZXlkaENEcXM2anJuYndnN0plczY0cVVJT3lMbk91UGhPdUtsQ0FxS3V5Z2hPdTJnQ0RzaTZUdGpLanRsYlRzaEp3ZzY1Q1k2NCtNNjZDNDY0dWtLaW91SU91Q3FPcTR0Q0RxdFpEdG00ZzZDaTh2SUNBZzRwR2dJRUpTVDFkVFJWSWc3Wlc0NjVPazY1K3M2NkdjSUZWU1RPeWRoQ0Ryc0p2c25MenJxYlFnWTIxazZyQ0FJR0FtWU95WGtPeUVuQ0RzbnBqcm5ienJxTG5yaXBUcmk2UWc0b2FTSUdOc2FXVnVkRjlwWkNEc2hvenNpNlFvSXV5ZW1PdXF1K3VRbkNCUFFYVjBhQ0RzbXBUc3NxMGlLUzRLTHk4Z0lDRGlrYUVnUWxKUFYxTkZVdXVsdkNCdWJ5MXZjT3ljdk91aG5DRHJwNG5xczZBZ2MzUmtiM1YwN0oyWUlGVlNUT3lkaENEc21yRHJwcXpxc0lBZzdKZTA2Nm0wSUNvcTdJcTU3SjI0SU91U3BDRHNuYmpzcHAzc3ZaVHJrNXpycGJ3ZzY3YVo3SmVzNjRTajdKeTg2NTI4NjRxVUlPMlpsT3VwdENvcTdKMjBDaTh2SUNBZ0lDQWc2NXlzNjR1a0tPeUxwT3k0b1NEcw0KaTZEcXM2QTZJQ0xzbmJUcm43QWc2ckd3SU95WGh1eVhpT3VLbE91TnNDRHFzSkhzbnBEcXVMQWc3Sm1jSU95RG5lcXlxQ0lwSU9LQWxDRHNucERyajVrZzdJaVk2NkM1N0oyMElPcTVxT3luaE91THBDNEtMeThnSUNEaWthSWc3SXVjN1lHczY2YS9JT3l3dmV5Y3ZPdWhuQ0RzbDdUcm9LVHJxYlFnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lhc091bXJPcXdnQ0RxczZqcm5ienNsYndnN1pXMDdJU2NJQ29xNnJpdzY3TzRJT3U0ak91ZHZPeWFzT3lnZ09xd2dDRHNsWVRyaTR3ZzdZR3M2Nkdzd3Jmc2w2UHNwNERxc0lBZzdKZTA2NmF3NjR1a0tpb0tMeThnSUNBZ0lDQW83SXVrN0xpaElPeUxvT3F6b0RvZ0l1eVpuQ0R0Z2F6cm9henNuTHpyb1p3ZzdKZTA2NkNrSWl3Z0l1cTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJvWndnN1pXWTY1Mjg2NHVJNnJtTUlpa3VJT3F5ak91THBPcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNnJDQUlPeUxuTzJCck91bXZ3b3ZMeUFnSUNBZ0lPeWR1T3lla091bHZDRHINCnJMVHNpNXp0bFpqcnFiUW83SUs4N0lTeElPeWR1TzJFc091RXR5RHNpNlRzdUtFcElPeWR2T3V3bUNEc3NMM3NuYlFnNjVhZ0lPeUt1ZXlkdUNEdG1aVHJxYlRzbmJRZzZyZTQ2NHlBNjZHYzY0dWtMZ292THlEcXQ3anJucGpzaEp3Z0tpcENVazlYVTBWUzY2VzhJT3F4dE91VG5PdW1yT3luZ0NEc2xZcnJpcFRyaTZRcUtpRGlnSlFnWTJ4aGRXUmxJRU5NU2Vxd2dDRHF1TERyczdnZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95WHRPcXpvQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPeWVrT3VQbVFvdkx5RHNpSmpyb0xudGxaenJpNlFvN0wyVTY1T2NJT3UybWV5WHJPdUVvK3E0c0NEc2w0YnNuWXdwTGlEcXM0VHNvSlVnN0tDRTdabVk3SjJBSU95S3VleWR1Q0R0bVpUcnFiUWc3WldZNjR1b0lGdnFzNFRzb0pVZzdLQ0U3Wm1ZWFNEcnNvVHRpcnpzbkx6cm9ad2c3WldjNjR1a0xnb3ZMeUFxS3V5ZHRDRHFzcjNyb1p6c2w1QWdWVkpNSU9xd2dPcXp0Y0szN0tTUjZyQ0VJT3lLcE8yQnJPdW12ZTJLDQp1TUszNjdpTTY1Mjg3SnF3N0tDQUlPeW5nT3lnbGV5ZGhDRHJpNlRzaTV3ZzY0U2o3S2VBSU91bmtDRHFzb011S2lvS0NpOHZJT0tVZ09LVWdDQkNVazlYVTBWU0lPcXdnT3Vobk95eGhPcTRzT3VLbENEc29KenFzYkRya0pEcmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVEkxS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdKaUk3S0NFN0plVUlFSlNUMWRUUlZJZzdabVk2cks5NjdPQTdJaVk3SmVRSU95ZWhPeUxuQ0RzaXFUdGdhenJwcjN0aXJqcnBid2c2cjJDN0pXRUlFTk1TZXF3Z0NEc3BJQWdZWFYwYUc5eWFYcGxJRlZTVE95ZGhDRHNtckRycHF6cXNJQWc2N0NiN0pXRTdJU2NJT3lYdE95WGlPdUxwQzRLTHk4ZzY2cXA3S0NCN0oyQUlPMlZtT3VDbU91L2tPeWR0T3lYaU91THBDRGlnSlFnNnJPRTdLQ1ZJT3lnaE8yWm1PeWFxZXljdk91aG5DQlZVa3pzbllRZ1kyeGhkV1JsTG1GcEwyeHZaMjkxZEQ5eVpYUjFjbTVVYnozaQ0KZ0ticm9ad2c3SjZzN0o2UjdJU3g3WlcwQ2k4dklPeUt1ZXlkdUNEdG1aVHJxYlRzbllRZzZyRzA2NFNJNjV1dzZyT2dJT3F6aE95Z2xTRHNoS0R0ZzUwZzdabVU2Nm0wN0plUUlPeW5nZTJXaWV5TG5PMkNwT3E0c0M0ZzZyZTRJT3llck95ZWtleUVzZXlkaENEdGo1RHF1TER0bFpqc25wQW83SUtzN0pxcDdKNlFJT3F5c095Z2xTa2c3Wlc0NjVPazY1K3M2NHFVQ2k4dklPdXFxZXlnZ2V5ZHRDRHNsNGJzbHJUc29ZenFzNkFzSUNvcTY0S282cktvSU91UmtPdXB0Q0RzbUtUdG5vanJvS1FnNjZHYzZyZTQ3SjI0N0oyRUlPdW5uZXF3Z091Y3FPdW1zT3VMcENvcU9nb3ZMeUFnSUVOTVNlcXdnQ0JWVWt6c25ZUWc2NVN3N0ppMDdaR2NJT3lYaHV5ZHRDRHJoSmpxdUxEcnFiUWdZMjFrNnJDQUlHQW1ZT3lYa095RW5DQlZVa3pzbllRZzdKNlk2NTI4SU91eWhPdWdwQ2pzbklqcmo0VHNtckFwSUdOc2FXVnVkRjlwWkNEcXNKbnNuWUFnNjVLazdLcTlDaTh2SUNBZzY2ZWs2ckNjNjdPQTdJaVk2ckNBSU95Q3JPdWQNCnZPeW5nT3F6b0N3ZzY3aU02NTI4N0pxdzdLQ0E3SmVVSUNMc25wanJxcnZya0p3Z1QwRjFkR2dnN0pxVTdMS3RJTUszSUdOc2FXVnVkRjlwWkNEcnA2VHFzSnpyczREc2lKanFzSUFnNjRpRTY1Mjk2NUNZN0plSTdJcTE2NHVJNjR1a0l1cXdnQ0Rybkt6cmk2UXVDaTh2SUNBZzdJdXM3WldZNjZtMElPdTRqT3Vkdk95YXNPeWdnT3F3Z0NEc2xZVHNtSWdnN0pXSUlPeVh0T3Vtc091THBDanNpNlRzdUtFZ01qQXlOaTB3T0RvZ1EweEpJTzJVaE91aG5PeUV1T3lLcE91S2xDRHJqSURxdUxBZzdLU1I3SjI0NjQyd0lPeXd2ZXlkdENEc2xZZ2c2NXk0S1M0S0x5OGc3SjIwN0tDY0lFSlNUMWRUUlZMcnBid2c2ckcwNjVPYzY2YXM3S2VBSU95Vml1dUtsT3VMcENEaWhwSWdZMnhoZFdSbElFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN0RyaTZRb1EweEpJT3E0c091enVDRHJqNW5zbnBFcExnb3ZMeUFxS3V5ZHRDRHFzcjNyb1p6c2w1QWdWVkpNSU9xd2dPcXp0Y0szDQo3S1NSNnJDRUlPeUtwTzJCck91bXZlMkt1T3VsdkNEcmk2VHNpNXdnNjRTajdLZUFJT3Vua0NEcXNvTXVLaW9nNnJPRTdLQ1ZJT3lnaE8yWm1PeWRnQ0RzaXJuc25iZ2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjBnNjdLRTdZcTg3Snk4NjZHY0xnb0tMeThnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHRsSVRyb1p6c2hManNpcVFnS0dOc1lYVmtaU0JoZFhSb0lHeHZaMmx1SUMwdFkyeGhkV1JsWVdrcElPS0FsQ0F2YjNCbGJpMXNiMmRwYnV5ZHRDRHNnNTNzaExIQ3QrcTBnT3VtckM0S0x5OGc2N2lNNjUyODdKcXc3S0NBNnJDQUlHeHZZMkZzYUc5emRPdWhuQ0Rxc3JEcXM3enJwYndnNjdPMDY0SzA3S1NFSU91VmpPcTVqT3luZ0NEc2lLanNsclRzaEp3ZzY0eUE2cml3N1pXWTY0dWs2ckNBTENEc21ZVHJvNHpya0pqcnFiUWc3SXFrN0lxazY2R2NJT3VCbmV1Q25PdUxwQzRLYkdWMElHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0NteGxkQ0JzYjJkcGJsQnliMk5VYVcxbA0KY2lBOUlHNTFiR3c3Q214bGRDQnNiMmRwYmxOMFlYSjBaV1JCZENBOUlEQTdJQzh2SU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25iZ2c3SXVjN0o2UklPeUxuT3F3Z1NEaWdKUWc3SjZzN1lHMDY2YXQ3SjIwSUNmc25xenNpNXpyajRRbjdKMjQ3S2VBSUNmc25wRHJqNW5zbVlUcm80d2c3SXVrN1l5b0oreWR1T3luZ0NEcXRhenJ0b1R0bFp6cmk2UUtMeThnN0oyMDY3S0lJT3Vobk9xM3VPeWR1T3lYa095RW5DRHJ1SXpybmJ6c21yRHNvSUFnN0xDOTdKMkVJT3lMcE95Z25PdWhuQ0RybllUc202RHJpcFRxc0lBZzRvQ1VJTzJFc091dnVPdUVrQ0R0ajdUcnNMSHNuWUFnN0oyMDZyS01JR1poYkhObDdKMjhJT3VWak91bmpDRHNrN1RyaTZRS0x5OGdLT3lMbk9xd2hPdW5qT3ljdk91aG5DRHRqSkRyaTZqdGxaanJxYlFnN0tDVjdJT0JJT3llck8yQnRPdW1yZXlYa091UGhDQmpiV1FnN0xDOTdKMjBJTzJLZ095V3RPdUNtT3lZcU91THBDa0tiR1YwSUd4dloybHVWMmx1Wkc5M1QzQmxibVZrSUQwZ1ptRnMNCmMyVTdDbVoxYm1OMGFXOXVJR3RwYkd4TWIyZHBibEJ5YjJNb0tTQjdDaUFnYVdZZ0tHeHZaMmx1VUhKdlkxUnBiV1Z5S1NCN0lHTnNaV0Z5VkdsdFpXOTFkQ2hzYjJkcGJsQnliMk5VYVcxbGNpazdJR3h2WjJsdVVISnZZMVJwYldWeUlEMGdiblZzYkRzZ2ZRb2dJR2xtSUNnaGJHOW5hVzVRY205aktTQnlaWFIxY200N0NpQWdZMjl1YzNRZ2NDQTlJR3h2WjJsdVVISnZZenNLSUNCc2IyZHBibEJ5YjJNZ1BTQnVkV3hzT3dvZ0lIUnllU0I3Q2lBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNCemNHRjNibE41Ym1Nb0ozUmhjMnRyYVd4c0p5d2dXeWN2VUVsRUp5d2dVM1J5YVc1bktIQXVjR2xrS1N3Z0p5OVVKeXdnSnk5R0oxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3dvZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ2RISjVJSHNnY0hKdlkyVnpjeTVyYVd4c0tDMXdMbkJwWkN3Z0oxTkpSMVJGVWswbktUc2dmU0JqWVhSamFDQW9YMlV5DQpLU0I3SUhBdWEybHNiQ2dwT3lCOUNpQWdJQ0I5Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIMEtmUW9LTHk4ZzdZUzBJT3VQaE95a2tTRHRnYlRyb1p6cms1d2c3WlNFNjZHYzdJUzQ3SXFrNnJDQUlPeWp2ZXlYaU95ZGhDRHJsWXpzblpnZzdJdWs3WXlvSU91cGxPeUxuT3luZ0NEaWdKUWdjblZ1VkhWeWJ1eWR0Q0RzbmJRZzY2bVU3SXVjN0tlQTdKMjhJT3VWak91bmpDQXg3WnFNSU95ZWtPdVBtU0RzbnF6c2k1enJqNFR0bFp6cmk2UUtZMjl1YzNRZ1UwVlRVMGxQVGw5RVNVVkVJRDBnSisyQnRPdWhuT3VUbkNEc2hManNoWmpzbmJRZzdLS0Y2Nk9NNjVDUTdKYTA3SnFVTGljN0NteGxkQ0J6YUhWMGRHbHVaMFJ2ZDI0Z1BTQm1ZV3h6WlRzZ0x5OGdMM05vZFhSa2IzZHVJT3luaE8yV2lTRHNwSkVnNG9DVUlPeWVyT3lMbk91UGhPdWhuQ0RzaExqc2haanNuWVFnNjVDWTdJSzA2NmFzN0tlQUlPeVZpdXF5akNEdGtaenNpNXdLQ2k4dklISmxZWE52YnV5ZGhDRHNvN3pycWJRZw0KSit5ZG1PdVBoT3lnZ1NEc29vWHJvNHduS09xemhPeWdsU0Rzb0lUdG1aakN0K3Vobk9xM3VPeVZoT3liZ3lEcms3RXBJT0tBbENEc3A0VHRsb2tnN0tTUjdKMjA2NDJZSU8yRXRPeWRoQ0RxdDdnZzY2bVU3SXVjN0tlQTY2R2NJT3VCbmV1Q3RPeUVuQW92THlCeWRXNVVkWEp1N0oyWUlGTkZVMU5KVDA1ZlJFbEZSQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95WW15RHNucERxc3Fuc3BwM3Jxb1hzbkx6cm9ad2c3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1yT3luZ0NEc2xZcnFzb3dnN1pXYzY0dWtMZ292THlBbzdKV0lJT3EzdU91ZnJPdXB0Q0RxczRUc29KVWc3S0NFN1ptWUlPeW5nZTJiaENEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZHRDRHJ0b0R0bVp6dGxiUWdUVUZZWDFSVlVrNVQ2cm1NN0tlQUlPcXpoT3lHalNEc2s3RHNuYlRyaXBRZzY3S0U2cmU0SU9LQWxDQXlNREkyTFRBM0lPdW1yT3Uzc095WGtPeUVuQ0R0bVpYc25iZ3BDbVoxYm1OMGFXOXVJR3RwYkd4UWNtOWpLSEpsWVhOdmJpa2cNCmV3b2dJR2xtSUNod2NtOWpLU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ0lDQWdJQzh2SUhOb1pXeHNPblJ5ZFdYcm9ad2c2NTJFN0p1TTdJU2NJSEJ5YjJQc25ZQWdZMjFrSU9xN2pldU5zT3E0c0NEaWdKUWdMMVRyb1p3ZzdZcTQ2NmFzN0tlNElPeWp2ZXlYck95VnZDRHNwNFRzcDV3Z1kyeGhkV1JsNnJDQUlPcXpvT3lWaE91aG5DRHNsWWdnNjRLbzY0cVU2NHVrQ2lBZ0lDQWdJQ0FnTHk4Z0tPcXpvT3lWaENCamJHRjFaR1hxc0lBZzdJU2s3TG1ZSU8yTWpPeWR2T3lkaENEcnJMenFzNkFnN0o2STdKeTg2Nm0wSU8yQnRPdWhuT3VUbkNEc2xiRWc3SmVGNjQydzdKMjA3WXE0NnJDQUlDTHNncXpzbXFrZzdLU1JJdXljdk91aG5DRHJwNG50bnBncENpQWdJQ0FnSUNBZ2MzQmhkMjVUZVc1aktDZDBZWE5yYTJsc2JDY3NJRnNuTDFCSlJDY3NJRk4wY21sdVp5aHdjbTlqTG5CcFpDa3NJQ2N2VkNjc0lDY3ZSaWRkDQpMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0F2THlCdFlXTlBVeS9ycHF6cmlJWHNpcVE2SUhOb1pXeHNPblJ5ZFdYcm5id2djSEp2WSt5ZHRDQnphQ0RxdTQzcmpiRHF1TERzbmJ3ZzdJaVlJT3llaU95ZGpDRGlnSlFnYzNSaGNuUlFjbTlqN0oyWUlHUmxkR0ZqYUdWazY2R2NJT3Vuak91VG9Bb2dJQ0FnSUNBZ0lDOHZJTzJVaE91aG5PeUV1T3lLcENEcXQ3anJvN2tvTFhCcFpDbnNuWVFnN1lhMTdLZTQ2NkdjSU95Z2xldW1yTzJWbk91THBDQW9kR0Z6YTJ0cGJHd2dMMVFnNjR5QTdKMlJLUW9nSUNBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0hKdll5NXdhV1FzSUNkVFNVZFVSVkpOSnlrN0lIMGdZMkYwWTJnZ0tGOWxNaWtnZXlCd2NtOWpMbXRwYkd3b0tUc2dmUW9nSUNBZ0lDQjlDaUFnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRb2dJSDBLSUNCd2NtOWpJRDBnYm5Wc2JEc0tJQ0IzWVhKdA0KWldSVmNDQTlJR1poYkhObE93b2dJR2xtSUNoM1lXbDBaWElwSUhzZ1kyeGxZWEpVYVcxbGIzVjBLSGRoYVhSbGNpNTBhVzFsY2lrN0lIZGhhWFJsY2k1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0hKbFlYTnZiaUI4ZkNCVFJWTlRTVTlPWDBSSlJVUXBLVHNnZDJGcGRHVnlJRDBnYm5Wc2JEc2dmUXA5Q2dwbWRXNWpkR2x2YmlCemRHRnlkRkJ5YjJNb0tTQjdDaUFnYTJsc2JGQnliMk1vS1RzS0lDQnNhVzVsUW5WbUlEMGdKeWM3Q2lBZ2RIVnlibk1nUFNBd093b2dJQzh2SU95ZHRDRHNoTGpzaFpqc25iUWc3SmEwNjRxUUlPcXpoT3lnbGV5ZG1DRHNub1hzbnFYcXRvenNuTHpyb1p3ZzY0K0U2NHFVN0tlQUlPcTRzT3VoblNEaWdKUWc2N0NXN0plUTdJU2NJT3F6aE95Z2xleWR0Q0Ryc0pUcmdJenNsNGpyaXBUc3A0QWc2N21FNnJXUTdaV1k2NHFVSU9xNHNPeWtnQW9nSUhObGMzTnBiMjVCWTJOdmRXNTBJRDBnWTJ4aGRXUmxRV05qYjNWdWRDZ3BPd29nSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHQNCmdiVHJvWnpyazV3ZzdJUzQ3SVdZSU95TG5PdVBtU0RzcEpIaWdLWWdLT3VxcU91TnVEb2dKeUFySUdOMWNuSmxiblJOYjJSbGJDQXJJQ2NwSnlrN0NpQWdZMjl1YzNRZ2RHaHBjMUJ5YjJNZ1BTQnpjR0YzYmlnblkyeGhkV1JsSnl3Z1d5Y3RjQ2NzSUNjdExXMXZaR1ZzSnl3Z1kzVnljbVZ1ZEUxdlpHVnNMQ0FuTFMxcGJuQjFkQzFtYjNKdFlYUW5MQ0FuYzNSeVpXRnRMV3B6YjI0bkxDQW5MUzF2ZFhSd2RYUXRabTl5YldGMEp5d2dKM04wY21WaGJTMXFjMjl1Snl3Z0p5MHRkbVZ5WW05elpTZGRMQ0I3Q2lBZ0lDQnphR1ZzYkRvZ2RISjFaU3dnWTNka09pQkZUVkJVV1Y5RFYwUXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd0tJQ0FnSUdSbGRHRmphR1ZrT2lCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUNFOVBTQW5kMmx1TXpJbkxDQXZMeUJRVDFOSldEb2c3SjZRNnJpd0lPMlVoT3Vobk95RXVPeUtwQ0RxdDdqcm83a2c3SU9kN0lTeElPS0FsQ0JyYVd4c1VISnZZK3lkdENEcXQ3anJvN25zcDdnZzdLQ1Y2NmFzDQo3WldnSU95SW1DRHNub2pxc293S0lDQjlLVHNLSUNCd2NtOWpJRDBnZEdocGMxQnliMk03Q2lBZ2NISnZZeTV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdld29nSUNBZ2JHbHVaVUoxWmlBclBTQmtMblJ2VTNSeWFXNW5LQ2QxZEdZNEp5azdDaUFnSUNCc1pYUWdhV1I0T3dvZ0lDQWdkMmhwYkdVZ0tDaHBaSGdnUFNCc2FXNWxRblZtTG1sdVpHVjRUMllvSjF4dUp5a3BJQ0U5UFNBdE1Ta2dld29nSUNBZ0lDQmpiMjV6ZENCc2FXNWxJRDBnYkdsdVpVSjFaaTV6YkdsalpTZ3dMQ0JwWkhncExuUnlhVzBvS1RzS0lDQWdJQ0FnYkdsdVpVSjFaaUE5SUd4cGJtVkNkV1l1YzJ4cFkyVW9hV1I0SUNzZ01TazdDaUFnSUNBZ0lHbG1JQ2doYkdsdVpTa2dZMjl1ZEdsdWRXVTdDaUFnSUNBZ0lHeGxkQ0JsZGlBOUlHNTFiR3c3Q2lBZ0lDQWdJSFJ5ZVNCN0lHVjJJRDBnU2xOUFRpNXdZWEp6WlNoc2FXNWxLVHNnZlNCallYUmphQ0FvWDJVcElIc2dZMjl1ZEdsdWRXVTdJSDBLSUNBZ0lDQWdhV1lnS0dWMg0KSUNZbUlHVjJMblI1Y0dVZ1BUMDlJQ2R5WlhOMWJIUW5JQ1ltSUhkaGFYUmxjaWtnZXdvZ0lDQWdJQ0FnSUdOdmJuTjBJSGNnUFNCM1lXbDBaWEk3Q2lBZ0lDQWdJQ0FnZDJGcGRHVnlJRDBnYm5Wc2JEc0tJQ0FnSUNBZ0lDQmpiR1ZoY2xScGJXVnZkWFFvZHk1MGFXMWxjaWs3Q2lBZ0lDQWdJQ0FnYVdZZ0tHVjJMbWx6WDJWeWNtOXlLU0I3Q2lBZ0lDQWdJQ0FnSUNCamIyNXpkQ0J5WVhjZ1BTQlRkSEpwYm1jb1pYWXVjbVZ6ZFd4MElIeDhJR1YyTG5OMVluUjVjR1VnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJREl3TUNrN0NpQWdJQ0FnSUNBZ0lDQXZMeUR0bFp6cmo0UWc3TFNJNnJPODY2VzhJT3Vvdk95Z2dDRHJzN2pyaTZRZzRvQ1VJT3Vobk9xM3VPeWR1Q0RzbUtUcnBaZ2c3S0NWNnJlYzdJdWQ3SjIwSU91RWsreVd0T3lFbkNoc2IyY2dQMmx1SU91VHNTa2c2Nnk0NnJXczZyQ0FJT3V3bE91QWpPdXB0Q0RzZ3J6dGdxd2c3SWlZSU95ZWlPdUxwQW9nSUNBZ0lDQWdJQ0FnYVdZZ0tHbHpUR2x0YVhSRmNuSnYNCmNpaHlZWGNwS1NCN0NpQWdJQ0FnSUNBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJHbHRhWFFuT3lBdkx5QXZhR1ZoYkhSbzY2R2NJT3lWak91bXZDRGlocElnNjdLRTdZcTg3SjIwSUZ2dGxaenJqNFFnN0xTSTZyTzhYZXVobkNEcnNKVHJnSXpxczZBZzZyT0U3S0NWSU95Z2hPMlptT3lkaENEc2xZanJnclFLSUNBZ0lDQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0RzZ3F6c21xa2c3WldjNjQrRUlPeTBpT3F6dkNEcXNKRHNwNEE2Snl3Z2NtRjNLVHNLSUNBZ0lDQWdJQ0FnSUNBZ2R5NXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtFeEpUVWxVWDBkVlNVUkZLU2s3Q2lBZ0lDQWdJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tHbHpRWFYwYUVWeWNtOXlLSEpoZHlrcElIc0tJQ0FnSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMk5zWVhWa1pTMXNiMmR2ZFhRbk95QXZMeUF2YUdWaGJIUm82NkdjSU8yVWpPdWZyT3EzdU95ZHVPeVhrQ0RzDQpsWXpycHJ3ZzRvYVNJT3V5aE8yS3ZPeWR0Q0JiNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjNyb1p3ZzY3Q1U2NENjQ2lBZ0lDQWdJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0SU91bmpPdWpqQ0Rxc0pEc3A0QTZKeXdnY21GM0tUc0tJQ0FnSUNBZ0lDQWdJQ0FnZHk1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0V4UFIwbE9YMGRWU1VSRktTazdDaUFnSUNBZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJQ0FnSUNCM0xuSmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNtS1RycFpnNklDY2dLeUJ5WVhjcEtUc0tJQ0FnSUNBZ0lDQWdJSDBLSUNBZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMjlySnpzZ0x5OGc3SVN4NnJPMUlEMGc3SVNrN0xtWXdyZnJvWnpxdDdqc25iZ2c2NHVrSU95Z2xleURnU0RpZ0pRZzdKYTA2NWFrSUhCeWIySnNaVzNzbmJUcms2QWc3WlcwN0tDYw0KSUNqc25xenJvWnpxdDdqc25iZ3Y3SjZzN0lTazdMbVlJT3V6dGVxM2dDa0tJQ0FnSUNBZ0lDQWdJSGN1Y21WemIyeDJaU2hUZEhKcGJtY29aWFl1Y21WemRXeDBJSHg4SUNjbktTazdDaUFnSUNBZ0lDQWdmUW9nSUNBZ0lDQjlDaUFnSUNCOUNpQWdmU2s3Q2lBZ2NISnZZeTV6ZEdSbGNuSXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdld29nSUNBZ1kyOXVjM1FnY3lBOUlHUXVkRzlUZEhKcGJtY29KM1YwWmpnbktTNTBjbWx0S0NrN0NpQWdJQ0JwWmlBb2N5QW1KaUFoY3k1cGJtTnNkV1JsY3lnblJHVndjbVZqWVhScGIyNVhZWEp1YVc1bkp5a3BJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCamJHRjFaR1VnYzNSa1pYSnlPaWNzSUhNdWMyeHBZMlVvTUN3Z01qQXdLU2s3Q2lBZ2ZTazdDaUFnY0hKdll5NXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdMeThnN0oyMDY2KzRJT3lEaUNEc2hManNoWmpzbkx6cm9ad2c2cldRN0xLMDY1Q2NJT3VTcENEc21Kc2c3SVM0N0lXWTdKMjANCklPdUxxKzJlakNEcXNiRHJxYlFnNjZ5MDdJdWNJQ2pycXFqcmpiZ2c3S0NFN1ptWUlPeUxuQ0RzZzRnZzdJUzQ3SVdZN0oyRUlPeWp2ZXlkdE95bmdDRHNsWXJxc293cENpQWdJQ0JwWmlBb2NISnZZeUFoUFQwZ2RHaHBjMUJ5YjJNcElISmxkSFZ5YmpzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzdJUzQ3SVdZSU95aWhldWpqQ0FvWTI5a1pTQW5JQ3NnWTI5a1pTQXJJQ2NwSU9LQWxDRHJpNlRzbll3ZzdKcVU3TEt0SU91VmpDRHJpNlRzaTV3ZzdJdWM2NCtaN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnYTJsc2JGQnliMk1vS1RzS0lDQjlLVHNLZlFvS1puVnVZM1JwYjI0Z2MyVnVaRlIxY200b2RHVjRkQ2tnZXdvZ0lISmxkSFZ5YmlCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpTd2djbVZxWldOMEtTQTlQaUI3Q2lBZ0lDQnBaaUFvSVhCeWIyTXBJSEpsZEhWeWJpQnlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lYDQpodXlXdE95YWxDNG5LU2s3Q2lBZ0lDQnBaaUFvZDJGcGRHVnlLU0J5WlhSMWNtNGdjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243SldlN0lTZ0lPeWFsT3l5cmV5ZHRDRHNwNFR0bG9rZzdLU1I3SjIwN0plUTdKcVVMaWNwS1RzS0lDQWdJR052Ym5OMElIUnBiV1Z5SUQwZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRoTFFnN0l1YzZyQ0VJT3kwaU9xenZDRGlnSlFnN0lTNDdJV1k3SjJFSU95ZXJPeUxuT3lla2UyVnFldUxpT3VMcEM0bktUc0tJQ0FnSUNBZ0x5OGc3SXVjNnJDRUlPeTBpT3F6dk91S2xDQW43SVM0N0lXWUlPeWloZXVqakNmc21ZQWc2cldzNjdhRTY1Q1k2NHFVSU95Z25DRHJxWlRzaTV6c3A0RHJvWndnNjRHZDY0SzQ2NHVrSU9LQWxDQnJhV3hzVUhKdlkreWRtQ0RzaExqc2haZ2c3S0tGNjZPTUlISmxhbVZqZE9xd2dBb2dJQ0FnSUNBdkx5QnlkVzVVZFhKdTdKMllJT3lla091UG1TRHNucXpzaTV6cmo0VHJwYndnNjdhQQ0KNjZXMDY2bTBJT3lWaUNEcmtKanF1TEFnNjVXTTY2eTRLT3VLa091bXNDRHRoTFRzbllRZzY1R1FJT3V5aUNEcmo0enJxYlFnN1pTTTY1K3M2cmU0N0oyNElERXpNT3kwaUNEc29KenRsWnpzbllRZzY0U1k2cmkwNjR1a0tRb2dJQ0FnSUNCcFppQW9kMkZwZEdWeUtTQjdDaUFnSUNBZ0lDQWdZMjl1YzNRZ2R5QTlJSGRoYVhSbGNqc2dkMkZwZEdWeUlEMGdiblZzYkRzS0lDQWdJQ0FnSUNCM0xuSmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNuWkhyaTdYc25iUWc2NFNJNjZ5MElPeVlwT3VlbUNEcXNianJvS1FnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQ0RpZ0pRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUp5a3BPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHdHBiR3hRY205aktDazdDaUFnSUNCOUxDQlVWVkpPWDFSSlRVVlBWVlJmVFZNcE93b2dJQ0FnZDJGcGRHVnlJRDBnZXlCeVpYTnZiSFpsTENCeVpXcGxZM1FzSUhScGJXVnlJSDA3Q2lBZ0lDQncNCmNtOWpMbk4wWkdsdUxuZHlhWFJsS0VwVFQwNHVjM1J5YVc1bmFXWjVLSHNnZEhsd1pUb2dKM1Z6WlhJbkxDQnRaWE56WVdkbE9pQjdJSEp2YkdVNklDZDFjMlZ5Snl3Z1kyOXVkR1Z1ZERvZ2RHVjRkQ0I5SUgwcElDc2dKMXh1Snl3Z0ozVjBaamduS1RzS0lDQjlLVHNLZlFvS0x5OGc2ckNaN0oyQUlPdXN1T3Exck91bHZDRHJxb2NnNjdLSTdLZTRJT3VzdSt1S2xPeW5nQ0RxdUxEc2xyVWc0b0NVSU95ZXJPeWFsT3l5cmV5ZHRPdXB0Q0FpN0oyMDdLQ0U2ck84SU91THBPdWx1Q0RzZzRnZzdLQ2M3SldJSXV5ZGhDRHNtcFRxdGF6dGxaenJpNlFLTHk4Z0tPeVZpQ0RxdDdqcm42enJxYlFnN1lHMDY2R2M2NU9jNnJDQUlPeUVzZXlMcE8yVm1PcXlqQ0Rxc0puc25ZQWc2NHUxN0oyRUlPdVlrQ0RyZ3JUc2hKd2dXMEZKSU95MmxPeXluQ0RyalpRZzY3Q2I2cml3WGVxd2dDRHJyTFRzblpqcnI3anRsYlRzcDRUcmk2UXBDbU52Ym5OMElHRnphMlZrUTI5MWJuUWdQU0J1WlhjZ1RXRndLQ2s3Q2dvdkx5RHNoTGpzDQpoWmdnN0tTQTY3bUVLT3lMbk91UG1TdnNwNERzaTV6cnJMZ2c3S084N0o2RktldWx2Q0RyczdUc25xWHRsWndnNjVLa0lPMlZuQ0R0aExRZzdJdWs3WmFKSU9LQWxDRHJxcWpyazZBZzdaaTQ3TGFjN0oyQUlIRjFaWFZsNjZHY0lPeW5nZXVnck8yWmxDNEtMeThnYlc5a1pXenNuWVFnN0tPODY2bTBJT3EzdUNEcnFxanJqYmpyb1p3Z0tPdUxwT3VsdE91cHRDRHNoTGpzaFpnZzdKNnM3SXVjN0o2UktTNGc3WldjSU91cXFPdU51T3lkaENEcXM0VHNobzBnN0pPdzY2bTBJT3llck95TG5PeWVrZXlkZ0NEc3RaenN0SWdnTWUyYWpPdS9rQzRLTHk4Z2NtVndZWEp6WlQxN2NHRnljMlVzSUdadmNtMWhkRVJsYzJOOTY2VzhJT3lqdk91cHRDRHRqSXpzaTdIcXVZenNwNEFnN0oyMElPeWVvU0RzbFlqc2w1RHNoSndnN0xLWTY2YXM3WldZNnJPZ0lIdHlZWGNzSUhCaGNuTmxaSDNycGJ3ZzY0K002NkNrN0tTQTY0dWtPZ292THlEdG1KWHNpNTBnN0oyMDdZT0lJT3lMbkNEcXNKbnNuWUFnN0lTNDdJV1k3SmVRSUNMdA0KbUpYc2k1M3JqSURyb1p3ZzY0dWs3SXVjSXV1bHZDRHNtcFRxdGF6dGxaanJpcFFnN0o2czdKcVU3TEt0SU8yRXRPeWRoQ0FxS3Vxd21leWRnQ0R0Z1pBZzdKNmhJT3lWaU95WGtPeUVuQ29xSU91Mm1leWR1T3VMcEM0S0x5OGc2N09FNjQrRUlPeWVvZXljdk91aG5DRHJ1YnpycWJRZ0tHRXBJT3lDck95ZHRPeVhrQ0RyaTZUcnBiZ2c3SnFVN0xLdElPMkV0T3lkdENEcmdienNsclFnSit1d3FlcTRpQ0RyaTdVbjdKMjBJT3VDcU95ZG1DRHJpN1hzbmJRZzY1Q1k2ck9nS091Q3RPeWFxU0RzbUtUc2w3d3BMQW92THlBb1lpa2dUVUZZWDFSVlVrNVRJT3F5dmVxemhPeVhrT3lFbkNEc2hManNoWmpzbmJRZzdKNnM3SXVjN0o2UjY0KzhJQ2Zyc0tucXVJZ2c2NHUxSit5ZHRDRHNsNGJyaXBRZzdJT0lJT3lFdU95Rm1PeWR0Q0RyZ3JUc21xbnNuWVFnN0tlQTdKYTA2NEs4SU95SW1DRHNub2pyaTZRZ0tESXdNall0TURjZzY2YXM2N2V3N0plUTdJU2NJTzJabGV5ZHVDa3VDbU52Ym5OMElGSkZVRUZTVTBWZlFrRkUNCklEMGdLSFlwSUQwK0lIWWdQVDBnYm5Wc2JDQjhmQ0FvUVhKeVlYa3VhWE5CY25KaGVTaDJLU0FtSmlCMkxteGxibWQwYUNBOVBUMGdNQ2s3Q21aMWJtTjBhVzl1SUhKMWJsUjFjbTRvWW5WcGJHUkJjMnNzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLU0I3Q2lBZ1kyOXVjM1FnYW05aUlEMGdjWFZsZFdVdWRHaGxiaWhoYzNsdVl5QW9LU0E5UGlCN0NpQWdJQ0JqYjI1emRDQnFiMkpUZEdGeWRDQTlJRVJoZEdVdWJtOTNLQ2s3SUM4dklPeUxuT3F3aENEc21JanNnckFnNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0RzcXIwZzdLQ2M3WldjS0RFek1PeTBpQ25zbllRZzY0U1k2cmk0SU95ZXJPeUxuT3VQaE91S2xDRHRqNnpxdUxEdGxaenJpNlFLSUNBZ0lHbG1JQ2h0YjJSbGJDQW1KaUJCVEV4UFYwVkVYMDFQUkVWTVV5NXBibVJsZUU5bUtHMXZaR1ZzS1NBaFBUMGdMVEVnSmlZZ2JXOWtaV3dnSVQwOUlHTjFjbkpsYm5STmIyUmxiQ2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2cW82NDI0DQpJT3V6Z09xeXZUb2dKeUFySUdOMWNuSmxiblJOYjJSbGJDQXJJQ2NnNG9hU0lDY2dLeUJ0YjJSbGJDazdDaUFnSUNBZ0lHTjFjbkpsYm5STmIyUmxiQ0E5SUcxdlpHVnNPd29nSUNBZ0lDQnpkR0Z5ZEZCeWIyTW9LVHNnTHk4ZzdJT0lJT3VxcU91TnVPdWhuQ0RzaExqc2haZ2c3SjZzN0l1YzdKNlJJQ2pyaTZUc25Zd2c3SnVNNjdDTjdKZUY3SmVRN0lTY0lPeW5nT3lMbk91c3VDRHNucXpzbzd6c25vVXBDaUFnSUNCOUNpQWdJQ0JwWmlBb2RIVnlibk1nUGowZ1RVRllYMVJWVWs1VElIeDhJQ0Z3Y205aktTQnpkR0Z5ZEZCeWIyTW9LVHNLSUNBZ0lHbG1JQ2doZDJGeWJXVmtWWEFwSUhzS0lDQWdJQ0FnWTI5dWMzUWdkREFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhwYm5OMGNuVmpkR2x2YmsxbGMzTmhaMlVvS1NrN0NpQWdJQ0FnSUhkaGNtMWxaRlZ3SUQwZ2RISjFaVHNLSUNBZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21saw0KWjJWZElPeUV1T3lGbUNEc3BJRHJ1WVFnN0ptRTY2T01JQ2duSUNzZ0tDaEVZWFJsTG01dmR5Z3BJQzBnZERBcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtTQXJJQ2R6S1NEaWdKUWc3SjIwN1p1RUlPeWFsT3l5cmV5ZGdDRHJ1YWpybmJ6c21wUXVKeWs3Q2lBZ0lDQjlDaUFnSUNCMGRYSnVjeXNyT3dvZ0lDQWdZMjl1YzNRZ1lYTnJJRDBnWW5WcGJHUkJjMnNvS1RzZ0x5OGc3SjZzN0l1YzY0K0VJT3VWakNEcXNKbnNuWUFnN0tlSTY2eTQ3SjJFSU91THBPeUxuQ0RzazdUcmk2UWdLR0Z6YTJWa1EyOTFiblFnN0oyMDdLU1JJT3ltbmVxd2dDRHJzS25zcDRBcENpQWdJQ0JzWlhRZ2NtRjNPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdjbUYzSUQwZ1lYZGhhWFFnYzJWdVpGUjFjbTRvWVhOcktUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUNBZ0x5OGc3WVMwSU91UGhPeWtrU0R0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lqdmV5ZGdDRHFzcjNzbXJBb1UwVlRVMGxQVGw5RVNVVkUNCktTQXg3WnFNSU95ZWtPdVBtU0RzbnF6c2k1enJqNFFnNG9DVUlPeUNyT3lhcWV5ZWtPeVhrT3F5a0NEc2k2VHRqS2pyb1p3ZzdKV0lJT3V6dE95ZHRPcXlqQzRLSUNBZ0lDQWdMeThnN0l1YzZyQ0VJT3kwaU9xenZNSzM2NkdjNnJlNDdKMjRJT3Vuak91ampNSzM3WUcwNjZHYzY1T2NJT3lZcE91bG1NSzM3SjJZNjQrRTdLQ0JJT3lpaGV1ampDanFzNFRzb0pVZzdLQ0U3Wm1ZTCt1aG5PcTN1T3lWaE95Ymd5d2dhMmxzYkZCeWIyTW9jbVZoYzI5dUtTbnJpcFFLSUNBZ0lDQWdMeThnN0tDY0lPdXBsT3lMbk95bmdPcXdnQ0RybExEcm9ad2c3SjZJN0phMElPeVhyT3E0c0NEc2xZZ2c2ckc0NjZhdzY0dWtMaURzb29Ycm80d2c3SnFVN0xLdElPeWtrZXlkdE9xeHNPdUNtQ0RzaTV6cXNJUWc3SmlJN0lLdzdKMjBJT3lXdk91bmlDRHNsWWdnNjRLbzdKV1k3Snk4NjZtMElPdVFtT3lDdE91bXJPeW5nQ0RzbFlycmlwVHJpNlF1Q2lBZ0lDQWdJR2xtSUNoemFIVjBkR2x1WjBSdmQyNGdmSHdnSVNobElDWW1JR1V1DQpiV1Z6YzJGblpTQTlQVDBnVTBWVFUwbFBUbDlFU1VWRUtTQjhmQ0JFWVhSbExtNXZkeWdwSUMwZ2FtOWlVM1JoY25RZ1BpQTBNREF3TUNrZ2RHaHliM2NnWlRzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUV1T3lGbU95ZHRDRHRoTFFnNjQrRTdLU1JJT3VCaXVxNWdDRGlnSlFnN0o2czdJdWM2NCtaSU8yYmhDQXg3WnFNSU95ZXJPeUxuT3VQaE8yVnFldUxpT3VMcEM0bktUc0tJQ0FnSUNBZ2MzUmhjblJRY205aktDazdDaUFnSUNBZ0lHRjNZV2wwSUhObGJtUlVkWEp1S0dsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncEtUc0tJQ0FnSUNBZ2QyRnliV1ZrVlhBZ1BTQjBjblZsT3dvZ0lDQWdJQ0IwZFhKdWN5QTlJREk3SUM4dklPeWJqT3V3amV5WGhTQXhJQ3NnN0oyMDY3S0lJTzJFdENBb2MzUmhjblJRY205ajdKMjBJRERzbkx6cm9ad2c3TFNJNnJpdzdabVVLUW9nSUNBZ0lDQnlZWGNnUFNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhoYzJzcE93b2dJQ0FnZlFvZ0lDQWdhV1lnS0NGeQ0KWlhCaGNuTmxLU0J5WlhSMWNtNGdjbUYzT3dvZ0lDQWdiR1YwSUhCaGNuTmxaQ0E5SUhKbGNHRnljMlV1Y0dGeWMyVW9jbUYzS1RzS0lDQWdJQzh2SU8yWWxleUxuU0RzbmJUdGc0anNuYlRycWJRZzZyQ1o3SjJBSU95RXVPeUZtTUszNnJDWjdKMkFJT3llb2V5WGtPeUVuQ0RxczZmc25xVWc3SjZzN0pxVTdMS3RJT0tBbENEc25iUWc3WVMwN0oyMElPeWp2ZXljdk91cHRDRHNnNGdnN0lTNDdJV1k3SjJBSUNmcnNLbnF1SWdnNjR1MUoreWRoQ0RycXJEcm5id0tJQ0FnSUM4dklPeW5nT3lXdE91Q3ZDRHNpSmdnN0o2STdKeTg2NitBNjZHY0lPeUV1T3lGbUNEc2dxenJwNTBnN0o2czdJdWM2NCtFNjRxVUlPMlZtT3luZ0NEc2xZcnFzNkFnNnJlNDY0eUE2NkdjSU95THBPMk1xT3lMbk8yQ3FPdUxwQ2p0akl6c2k3RWc3SXVrN1l5bzY2R2NJT3EzZ09xeXNDa3VDaUFnSUNCcFppQW9Va1ZRUVZKVFJWOUNRVVFvY0dGeWMyVmtLU0FtSmlCRVlYUmxMbTV2ZHlncElDMGdhbTlpVTNSaGNuUWdQQ0EzTURBd01Da2cNCmV3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlNN0l1eElPeUxwTzJNcUNEaWdKUWc3WmlWN0l1ZElPeWVyT3lhbE95eXJUb25MQ0JUZEhKcGJtY29jbUYzS1M1emJHbGpaU2d3TENBek1EQXBLVHNLSUNBZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUNBZ2RISjVJSHNLSUNBZ0lDQWdJQ0J5WVhjZ1BTQmhkMkZwZENCelpXNWtWSFZ5YmlnbjY3Q3A2cmlJSU91THRleWR0Q0RzbXBUcXRhenRsWndnN1ppVjdJdWQ3SmVRSU95V3RPcTRpK3VDck91THBDNGc2N0NwNnJpSUlPdUx0ZTJWbkNEcmdyVHNtcW5zbllRZzdJU2s2NnFGd3Jmc2dxenFzN3pDdCt5OWxPdVRuTzJPbk95S3BDRHNsNGJzbmJRZzdKV0U2NTZZSUVwVFQwN3NuTHpyb1p6cnA0d2c2NHVrN0l1Y0lPeTJuT3VncGUyVm1PdWR2RG9nSnlBcklISmxjR0Z5YzJVdVptOXliV0YwUkdWell5azdDaUFnSUNBZ0lDQWdjR0Z5YzJWa0lEMGdjbVZ3WVhKelpTNXdZWEp6WlNoeVlYY3BPd29nSUNBZ0lDQjlJR05oZEdOb0lDaGZaU2tnDQpleUF2S2lEc25xenNtcFRzc3EwZzdJdWs3WXlvSU9LQWxDRHNsWVRybnBqc2w1RHNoSndnN1l5TTdJdXhJT3lMcE8yTXFPdWhuQ0Rzc3BqcnBxd2dLaThnZlFvZ0lDQWdmUW9nSUNBZ2FXWWdLRkpGVUVGU1UwVmZRa0ZFS0hCaGNuTmxaQ2twSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRqSXpzaTdFZzdJdWs3WXlvSUNqc25xenNtcFRzc3EwZzdadUU3SmVRNjQrRUtUb25MQ0JUZEhKcGJtY29jbUYzS1M1emJHbGpaU2d3TENBek1EQXBLVHNLSUNBZ0lISmxkSFZ5YmlCN0lISmhkeXdnY0dGeWMyVmtPaUJTUlZCQlVsTkZYMEpCUkNod1lYSnpaV1FwSUQ4Z2JuVnNiQ0E2SUhCaGNuTmxaQ0I5T3dvZ0lIMHBPd29nSUM4dklPMlZuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WlcwNjQrRUlPdUxwT3lkakNEc21wVHNzcTNzbmJRZzdKMjA3SmEwN0tlQTY0K0U2NkdkSU8yQmtPdUtsQ0R0bGEzc2c0RWc3SVN4NnJPMTdKeTg2NkdjSU95Z2xldW1yQW9nSUhGMVpYVmxJRDBnYW05aUxtTmhkR05vS0NncA0KSUQwK0lIdDlLVHNLSUNCeVpYUjFjbTRnYW05aU93cDlDZ292THlEcnNvVHRpcndnNjUyODY3S29JT3Ezbk95NW1TRGlnSlFnN1pTTTY1K3M2cmU0N0oyNDdKMjBJQ2Zyc29UdGlyenNuWVFnNnJPbzY1NlE2NHVrSitxem9DRHNsWXpyb0tUc3BJUWc2NVdNNjZlTUlPeVd1ZXVLbE91THBDNEtMeThnNjdLRTdZcThJT3VzdU9xMXJPdUtsQ0Ryckxqc25xWHNuYlFnN0pXRTY0dUk2NTI4SU91UG1leWVrU0RzbmJUcnBvVHNuYlRzbHJUc2hKd3NJT3lkdENEc3A0RHNpNXpxc0lBZzdKZUc3Snk4NjZtMElPdXN1T3llcGUyWWxTRHJqSURzbFlqc25iUWc3SVNlN0plc0lPdUNtT3lZcU91THBDNEtZMjl1YzNRZ1FsVlVWRTlPWDFKVlRFVWdQUW9nSUNmc25iUWc2Nnk0NnJXczY0cVVJQ29xNjdLRTdZcThJT3Vkdk91eXFDb3E3SjIwNjR1a0xpRHJyTGpzbnFYc25iUWc3SldFNjR1STY1MjhJT3VQbWV5ZWtTRHNuYlRycG9Uc25iVHJyNERyb1p3NklPdW5pT3k1cU8yUm5NSzM2Nnk4N0oyTTdaR2N3cmZzb29YcXNyRHMNCmxyVHJyN2dvZnV5YWxDOSs2NHVrTDM3cXVZenNtcFFwSU9xNGlPeW5nQ3dnSnlBckNpQWdKK3VRbU91UGhPdWhuU0RzcDZmc25ZQWc2NCtaN0o2UklPdXFoZXlDckNqc29JRHNucVhDdCt5Q3JleWduTUszN0pldzZyS3dJTzJWdE95Z25DRHJrN0VwNjZHY0xDRHRoclhyczdUc2hMRWc2NHVvN0oyOElPdXloTzJLdk95ZHRPdXB0Q0FpN1ptVjdKMjRJaTRnSnlBckNpQWdKeUxzdDZqc2hvd2k2NHFVSU91UG1leWVrU0Ryc29UdGlyenFzN3dnN0tlZDdKMjhJT3VWak91bmpDRHNrN0RxczZBc0lPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRnQ0RxdDdqcmpJRHJvWndnNjVHVTY0dWtMbHh1SnpzS0NpOHZJT3VzdU9xMXJDRHN0cFRzc3B3ZzdZUzBJQ2h5YjJ4bFBTZnJzb1R0aXJ3bjdKMjA2Nm0wSU91eWhPMkt2Q0RxdDV6c3VabnNuWVFnN0phNTY0cVU2NHVrS1FwbWRXNWpkR2x2YmlCaGMydERiR0YxWkdVb2RHVjRkQ3dnYlc5a1pXd3NJSEpsY0dGeWMyVXNJSEp2DQpiR1VwSUhzS0lDQnlaWFIxY200Z2NuVnVWSFZ5Ymlnb0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCaGRIUmxiWEIwSUQwZ0tHRnphMlZrUTI5MWJuUXVaMlYwS0hSbGVIUXBJSHg4SURBcElDc2dNVHNLSUNBZ0lHRnphMlZrUTI5MWJuUXVjMlYwS0hSbGVIUXNJR0YwZEdWdGNIUXBPd29nSUNBZ2FXWWdLR0Z6YTJWa1EyOTFiblF1YzJsNlpTQStJREl3TUNrZ1lYTnJaV1JEYjNWdWRDNWpiR1ZoY2lncE95QXZMeURyckxUdGxaenRub2dnN0l5VDdKMjA3S2VBSU95Vml1cXlqQW9nSUNBZ1kyOXVjM1FnY25Wc1pTQTlJSEp2YkdVZ1BUMDlJQ2Zyc29UdGlyd25JRDhnUWxWVVZFOU9YMUpWVEVVZ09pQW5KenNLSUNBZ0lISmxkSFZ5YmlCeWRXeGxJQ3NnS0dGMGRHVnRjSFFnUGlBeENpQWdJQ0FnSUQ4Z0orcXdtZXlkZ0NEcnJManF0YXpycGJ3ZzY0dWs3SXVjSU95YWxPeXlyZTJWbk91THBDNGc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRzb0lUc2w1QWc3S0NjN0pXSTdaYUk2NDJZSU9xeWcrdVRwT3F6dkNEcQ0Kc3Juc3VaanNwNEFnN0pXSzY0cVVMQ0RxdGF6c29iRHJncGdnN0phMDdaeVk2ckNBSU8yWmxleUxwTzJlaUNEcmk2VHJwYmdnN0lPSTY2R2M3SnEwSU91TWdPeVZpQ0F6NnJDYzY2VzhJT3Ezbk95NW1ldU1nT3VobkNCS1UwOU9JT3V3c095WHRPdWhuT3VuakRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwQ2lBZ0lDQWdJRG9nSit1THBPeWRqQ0JWU1NEcnJManF0YXpzblpnZzY0eUE3SldJSURQcXNKenJwYndnNnJlYzdMbVo2NHlBNjZHY0lFcFRUMDRnNjdDdzdKZTA2NkdjNjZlTU9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29kR1Y0ZENrcE93b2dJSDBzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLVHNLZlFvS0x5OGc2N0tJN0pldElPMkV0Q0RpZ0pRZzZyQ1o3SjJBSU95RXVPeUZtT3lkaENEc2s3RHJrSmdzSU95ZHRPdXlpQ0R0aExUcnA0d2c3TGFVN0xLY0lPMllsZXlMblNoS1UwOU9JT3V3c095WHRDa2c2NHlBN0l1Z0lPdXlpT3lYclNEdG1KWHNpNTBvU2xOUFRpRHFzSjNzc3JRcDdKMkUNCklPeWFsT3Exck8yVm5PdUxwQXBtZFc1amRHbHZiaUJoYzJ0VWNtRnVjMnhoZEdVb2RHVjRkQ3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBJSHNLSUNCeVpYUjFjbTRnY25WdVZIVnliaWdvS1NBOVBpQW9DaUFnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NEcnNvanNsNjBnN0o2UjdKZUY3SjIwNjR1a0lDanJyTGpxdGF3ZzY0dWs2NU9zNnJpd0lPeVZoT3VMbUNEaWdKUWc2NHlBN0pXSUlEUHFzSndnNnJlYzdMbVo3SjJBSU95ZHRPdXlpQ0R0aExUc2w1QWc3S0NCN0pxcDdaV1k3S2VBSU95Vml1dUtsT3VMcENrdUlDY2dLd29nSUNBZ0ordUxwT3lkakNCVlNTRHJyTGpxdGF6cXNJQWc3WldjNnJXdDdKYTA2Nm0wSU95ZWtPeVhzT3lLcE91ZnJPeWF0Q0RzbUlIc2xyVHJvWndzSU95WWdleVd0T3VwdENEc25wRHNsN0RzaXFUcm42enNtclFnN1pXYzZyV3Q3SmEwNjZHY0lPdXlpT3lYcmUyVm1PdWR2QzRnSnlBckNpQWdJQ0FuVlVrZzY2eTQ2cldzNjR1azdKcTBJT3F3aE9xeXNPMlZuQ0R0a1p6dG1JVHNuWVFnDQo3Sk93NnJPZ0xDRHNuYlRycG9UQ3QreUlxK3lla01LMzY2ZUk3SXFrN1lLNXdyZnRsSXpyb0lqc25iVHNpcVR0bVlEcmpaVHJpcFFnNnJlNDY0eUE2NkdjSU91enRPeWh0TzJWbk91THBDNGdKeUFyQ2lBZ0lDQW43SnVRNjZ5NDdKMllJT3lraENEc2lKanJwYndnNnJlNDY0eUE2NkdjSU95Y29PeW5nTzJWbk91THBDRGlnSlFnN0p1UTY2eTQ3SjIwSU8yVm5DRHNwSVRzbmJUcnFiUWc2N0tJN0pldDY0K0VJTzJWbkNEc3BJVHJvWndzSU95a2hPdXdsT3EvaU95ZGhDRHNub1Rzblpqcm9ad2c3TGFVNnJDQTdaV1k3S2VBSU95Vml1dUtsT3VMcEM0Z0p5QXJDaUFnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhTRHF1SWpzcDRBNklDY2dLd29nSUNBZ0ozc2lkSEpoYm5Oc1lYUmxaQ0k2SUNMcnNvanNsNjNyckxnZ0tPeWtoT3V3bE9xL2lPeWRnQ0JjWEc0cElpd2dJbVJwY21Wag0KZEdsdmJpSTZJQ0pyYitLR2ttVnVJT3VZa091S2xDQmxidUtHa210dkluMDZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtRb2dJQ2tzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLVHNLZlFvS0x5OGc2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFZzdZUzBJT0tBbENEc2dxenNtcW5zbnBEcXNJQWc3SU9CN1ptcDdKMkVJT3lFcE91cWhlMlZtT3VwdENEcnA2WHJuYjNzbDVBZzY2ZWU2NHFVSU91c3VPcTFyT3VsdkNEcnA0enJrNlRzbHJUc3BJRHJpNlF1Q2k4dklHMWxjM05oWjJWek9pQmJlM0p2YkdVNkozVnpaWEluZkNkaGMzTnBjM1JoYm5RbkxDQjBaWGgwZlYwZzdLQ0U3TEswSU91TWdPMlpsT3VsdkNEcnA2VHJzb2dnNjdDYjY0cVU2NHVrS091THBPdW1yT3VLbENEcnJMVHNnNEh0ZzV3ZzRvQ1VDaTh2SU95YmpPdXdqZXlYaFNEc3A0RHNpNXpyckxqc25aZ2dJdXlhbE95eXJldVRwT3lkZ0NEc2hKenJvWndnNjZ5MDZyU0FJaURzb0lUc29KenJwYndnN0tlQTdZS2s2cml3SU95Y2hPMlYNCnRDRHJqSUR0bVpRZzY2ZWw2NTI5N0oyRUlPMkV0Q0RzbFlqc2w1QWc2NnE5NjVXRklPeUxvK3VLbE91THBDa3VDbVoxYm1OMGFXOXVJR0Z6YTBOdmJYQnZjMlVvYldWemMyRm5aWE1zSUcxdlpHVnNMQ0J5WlhCaGNuTmxLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnZEhKaGJuTmpjbWx3ZENBOUlDaHRaWE56WVdkbGN5QjhmQ0JiWFNrdWJXRndLQ2h0S1NBOVBnb2dJQ0FnSUNBb2JTNXliMnhsSUQwOVBTQW5ZWE56YVhOMFlXNTBKeUEvSUNmc2xyVHNpNXpzaXFUdGhMVHRpcmc2SUNjZ09pQW43SUtzN0pxcDdKNlFPaUFuS1NBcklGTjBjbWx1WnlodExuUmxlSFFnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJREUxTURBcENpQWdJQ0FwTG1wdmFXNG9KMXh1SnlrN0NpQWdJQ0J5WlhSMWNtNGdLQW9nSUNBZ0lDQW43SjIwNjdLSUlPeWFsT3l5cmV5ZGdDQWk2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFaTdKMjA2NHVrSUNqcXVMRHNvYlFnNjZ5NDZyV3NJT3VMDQpwT3VUck9xNHNDRHNsWVRyaTVnZzRvQ1VJT3lWaE91ZW1DRHJqSUR0bVpUcXNJQWc3SjIwNjdLSUlPMkV0T3lkbUNEc29JVHNzclFnNjZlbDY1Mjk3SjIwNjR1a0tTNGdKeUFyQ2lBZ0lDQWdJQ2ZzZ3F6c21xbnNucERxc0lBZzdabVU2Nm0wSU95RGdlMlpxY0szNjZlbDY1Mjk3SjJFSU95RXBPdXFoZTJWbU91cHRDd2c3SXFrN1lPQTdKMjhJT3Ezbk95NW1lcXp2Q0RzbUlqc2k1d2c3WWFrN0plUUlPdW5udXVLbENCVlNTRHJyTGpxdGF6cnBid2c2NmVNNjVPazdKYTBJT3lnbk95VmlPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RycDZYcm5iM3NuYlFnNjdhQTdLR3g3WldZNjZtMElPMk91TzJWbU9xeWpDRHJrSmpyckx6c2xyVHJuYnc2SU95V3RPdVdwQ0R0bVpUcnFiVEN0K3E0c091S3BleWRtQ0RyckxqcXRhenNuYmpzcDRBc0lPdVRwT3lXdE9xd2lDRHNucERycHF6cmlwUWc3SmEwNjVTVTdKMjQ3S2VBS08yTW5leVhoU0R0ZzREc25iVHRpNEF2NjdPNDY2eTRMK3V5aE8yS3ZDd2c3WWFnN0lxaw0KN1lxNExDRHJ1WWdnN1ptVTY2bTBJT3lWaU91Q3RDd2c2N0N3NjRTSUlPdVRzU2tzSU95V3RPdVdwQ0RzZzRIdG1hbnNuYmpzcDRBbzdJU3g2ck8xSU8yR3RldXp0Qy9zbUtUcnBaZ3Y3Wm1WN0oyNElPeWFsT3l5clMvc2xZanJnclFwSU9xd21leWRnQ0Rxc29NdUlPcThyU0R0bFlUc21wVHRsWndnNnJLRDY2ZU1JT3F6cU91ZHZDRHRsWndnNjdLSTdKZVFJT3kxbk91TWdDQXk2ckNjNnJtTTdLZUFMQ0RzcDZmcXNvd3VJT3lkdE91VmpDQnpkV2RuWlhOMGFXOXVjK3VLbENEcnVZZ2c2N0N3N0plMExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU9xd2tPeWR0Q0RzbHJUcmlwQWc3S0NWNjQrRUlPeVlwT3VwdENEcnJMdnF1TERycDR3ZzdaV1k3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyQ0E3S0NWN0oyRUlPeUV1T3lhc09xem9DRHN0SWpzbFlnZ2MzVm5aMlZ6ZEdsdmJuUHJwYndnN1pXbzZydVlJT3VDdE91cHRPeUVuQ3dnY21Wd2JIbnNsNUFnNnJDQTdLQ1Y3SjJFSU91d25lMmVpT3F6b0NEcnJMVHNsNGZzbllRZzdKV00NCjY2Q2s3S084NjZtMElPdU5sQ0RycDU3c3Rwd2c3SWlZSU95ZWlPdUtsT3luZ0NEdGxad2c2Nnk0N0o2bDdKeTg2NkdjSU91TnArdTJtZXlYck91ZHZDanNtSWc2SUNMdG1aWHNuYmdnN1l5ZDdKZUY3SjIwNjUyODZyT2dJT3F3Z095Z2xlMldpT3lXdE95YWxDRGlnSlFnN1lhZzdJcWs3WXE0NjUyODY2bTBJT3lWak91Z3BPeWp2T3lFdU95YWxDSXBMbHh1SnlBckNpQWdJQ0FnSUNjdElPdXN1T3Exck91bHZDRHNvSnpzbFlqdGxhQWc2NVdRSU95RW5PdWhuQ0Rzb0pIcXQ3enNuYlFnNjR1azY2VzRJREorTStxd25DNGc2ckNCSU95Z25PeVZpT3lYbENEc21ad2c2cmU0NjZDSDZyS01JT3lOdk91S2xPeW5nQ0RzbmJUc25LRHJwYndnNjdhWjdKMjQ2NHVrTGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lDck95YXFleWVrT3F3Z0NEc2xyanF1SW50bFpqc3A0QWc3SldLN0oyQUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN1pxZjdJaVlJT3VUc1NucnBid2c3S2VBDQo3SmEwNjRLMElPdUVvK3luZ0NEcnA0anJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc3WnVFN0lhTklPeWFsT3l5clNnaTY0MlVJT3lucCtxeWpDSXNJQ0xyc29UdGlyenNtcW5zbkx6cm9ad2lJT3VUc1Nuc25iVHJxYlFnN0tlQjdLQ0VJT3lnbk95VmlPeWRoQ0RxdDdnZzY3Q3A3WmFsN0p5ODY2R2NJT3F6b095emtDRHJpNlRzaTV3ZzdLQ2M3SldJN1pXWTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNmcmk3WHNuWUFnNjdDWTY1T2M3SXVjSUVwVFQwNGc2ckNkN0xLMElPMlZtT3VDbU91bmpDRHN0cHpyb0tYdGxaenJpNlF1SU91bmlPMkJyT3VMcE95YXRNSzM3SVNrNjZxRklPcTRpT3luZ0RvZ0p5QXJDaUFnSUNBZ0lDZDdJbkpsY0d4NUlqb2dJdXVNZ08yWmxDRHNuWkhyaTdVZzdaV2M2NUdRSU91c3VPeWVwU0FvN1pXMDdKcVU3TEswS1NJc0lDSnpkV2RuWlhOMGFXOXVjeUk2SUZ0N0luUmxlSFFpT2lBaTY2eTQ2cldzSUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSnlaV0Z6YjI0aU9pQWk3SjIwN0p5Zw0KSU8yVm5DRHJyTGpzbnFVaWZWMTlYRzVjYmljZ0t3b2dJQ0FnSUNBblcrdU1nTzJabEYxY2JpY2dLeUIwY21GdWMyTnlhWEIwQ2lBZ0lDQXBPd29nSUgwc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzS2ZRb0tMeThnN1pTRTY2Q0k3SjZFNjdPRUtPMlZtT3ljaENEdGxJVHJvSWpzbm9RZzY2eTI3SjJNS1NEc3RwVHNzcHdnN1lTMElPS0FsQ0R0bFp3ZzdabVU2Nm0wN0oyRUlPMlZtT3ljaENEdGxJVHJvSWpzbm9RZzY0dW83SnlFNjZHY0lPdUNtT3VJb0NEcnM3VHJnclRxczZBc0NpOHZJQ29xN1pTRTY2Q0k3SjZFNjZlSTY0dWtJT3VVc091aG5Db3FJT3VNZ095VmlPeWRoQ0Ryc0p2cmlwVHJpNlF1SU8yVm5DRHNtcFRzc3Ezc2w1QWc2NHVrSU95THBPeVd0Q0RyczdUcmdyVHJpcFFnNnJLRDdKMjBJTzJWdGV5THJEb0tMeThnN1pTRTY2Q0k3SjZFSU95SW1PdW5qTzJCdkNEc21wVHNzcTNzbllRZzdLcTg2ckNjNjZtMElPcTN1T3Vuak8yQnZDRHJpcERyb0tUc3A0RHFzNkFvNnJDQklEVitNVERzdElncElPcTENCnJPdVBoU0RzZ3F6c21xbnJuNG5yajRRZzZyZTQ2NmVNN1lHOElPdUNtT3F3aE91THBDNEtMeThnWjNKdmRYQnpPaUJiZTI1aGJXVXNJSFJsZUhSek9sdGRmVjBnS08yWmxPdXB0Q0RzbklUaWhwTHNsWVRybnBnZzdJaWNLUzRLWm5WdVkzUnBiMjRnWVhOclIzSnZkWEJ6S0dkeWIzVndjeXdnYlc5a1pXd3NJSEpsY0dGeWMyVXNJRzF2Y21VcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlCN0NpQWdJQ0F2THlEcnNvVHRpcndnN0ppQjdKZXQ3SjJBSUNqcnNvVHRpcndwN0p5ODY2R2NJT3l3amV5V3RDRHJzN1RyZ3Jqcmk2UWc0b0NVSU91eWhPMkt2Q0RyckxqcXRhenJpcFFnNjZ5NDdKNmw3SjIwSU95VmhPdUxpT3VkdkNEcmo1bnNucEVnN0oyMDY2YUU3SjIwNjUyOElPcTNuT3k1bWV5ZHRDRHJpNlRycGJUcmk2UUtJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQW9aM0p2ZFhCeklIeDhJRnRkS1M1dFlYQW9LR2NzSUdrcElEMCtDaUFnSUNBZ0lDZGJKeUFySUNocElDc2dNU2tnS3lBblhTQW5JQ3NnDQpVM1J5YVc1bktDaG5JQ1ltSUdjdWJtRnRaU2tnZkh3Z0tDZnF0N2pybzdrbklDc2dLR2tnS3lBeEtTa3BJQ3NnS0djZ0ppWWdaeTV5YjJ4bElEMDlQU0FuNjdLRTdZcThKeUEvSUNjZ0tPdXloTzJLdkNrbklEb2dKeWNwSUNzZ0oxeHVKeUFyQ2lBZ0lDQWdJQ2huSUNZbUlFRnljbUY1TG1selFYSnlZWGtvWnk1MFpYaDBjeWtnUHlCbkxuUmxlSFJ6SURvZ1cxMHBMbTFoY0Nnb2RDa2dQVDRnSnlBZ0xTQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29VM1J5YVc1bktIUWdmSHdnSnljcEtTa3VhbTlwYmlnblhHNG5LUW9nSUNBZ0tTNXFiMmx1S0NkY2JpY3BPd29nSUNBZ1kyOXVjM1FnYUdGelFuUnVJRDBnS0dkeWIzVndjeUI4ZkNCYlhTa3VjMjl0WlNnb1p5a2dQVDRnWnlBbUppQm5Mbkp2YkdVZ1BUMDlJQ2Zyc29UdGlyd25LVHNLSUNBZ0lHTnZibk4wSUd0bGVTQTlJQ2RuY205MWNITW5JQ3NnS0dkeWIzVndjeUI4ZkNCYlhTa3ViV0Z3S0NobktTQTlQaUFvWnlBbUppQm5MblJsZUhSeklEOGdaeTUwWlhoMA0KY3k1cWIybHVLQ2NuS1NBNklDY25LU2t1YW05cGJpZ25KeWs3Q2lBZ0lDQmpiMjV6ZENCaGRIUmxiWEIwSUQwZ0tHRnphMlZrUTI5MWJuUXVaMlYwS0d0bGVTa2dmSHdnTUNrZ0t5QXhPd29nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvYTJWNUxDQmhkSFJsYlhCMEtUc0tJQ0FnSUdsbUlDaGhjMnRsWkVOdmRXNTBMbk5wZW1VZ1BpQXlNREFwSUdGemEyVmtRMjkxYm5RdVkyeGxZWElvS1RzS0lDQWdJR052Ym5OMElHRm5ZV2x1SUQwZ2JXOXlaU0I4ZkNCaGRIUmxiWEIwSUQ0Z01Rb2dJQ0FnSUNBL0lDZnNuYlFnN1ptVTY2bTA3SjJBSU95ZHRDRHNoTGpzaFpqc2w1RHNoSndnN0oyMDY2KzRJT3VMcE91a21PdUxwQzRnN0pXZTdJU2NJT3VDdUNEcmpJRHNsWWpxczd3ZzdKYTA3WnlZd3JmcXRhenNvYkRxc0lBZzdabVY3SXVrN1o2SUlPdUxwT3VsdUNEc2c0Z2c2NHlBN0pXSTY2ZU1JT3VDdE91ZHZDNWNiaWNLSUNBZ0lDQWdPaUFuSnpzS0lDQWdJSEpsZEhWeWJpQW9DaUFnSUNBZ0lHRm5ZV2x1SUNzS0lDQWcNCklDQWdKK3lkdE91eWlDRHNtcFRzc3Ezc25ZQWdJdTJabE91cHRPeWRoQ0R0bFpqc25JUWc3WlNFNjZDSTdKNkU2N09FNjZHY0lPdUNtT3VJb0NEcmk2VHJrNnpxdUxBaTY0dWtMaURzbFlUcm5wanJpcFFnN1pXY0lPMlpsT3VwdE95ZG1DRHJyTGpxdGF6cnBid2c3WldZN0p5RUlPMlVoT3VnaU95ZWhDanNtSUhzbDYwcElPdUxxT3ljaE91aG5DRHJyTGJzbllBZzZyS0Q3SjIwNjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2NxS3V5WWdleVhyZXVuaU91THBDRHJsTERyb1p3cUtpRHJqSURzbFlqc25ZUWc2NEswNjUyOElPS0FsQ0RzbUlIc2w2M3NuWVFnN0lTYzY2R2NJTzJWcWV5NW1PcXhzT3VDbUNEc2lKenNoSnpycGJ3ZzY3Q1U2cjY0N0tlQUlPdW5pT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0Rxc0lFZzdKaUI3SmV0N0plUUlPdU1nT3lWaUNBeTZyQ2NMaURxdDdnZzdKaUI3SmV0N0oyMElPeVhyT3VmckNEc3BJVHNuYlRycWJRZzY0eUE3SldJNjQrRUlDb3E2ckNaN0oyQUlPeWtoQ0RzaUpncUt1dWhuQ2pzDQpwSVRyc0pUcXY0Z2dYRnh1N0p5ODY2R2NJT3Exck91MmhDd2c3S1NFSU95SW5PeUVuQ0RzbktEc3A0QXBMbHh1SnlBckNpQWdJQ0FnSUNjdElPeVlnZXlYcmV5ZG1DRHNsNjN0bGFBbzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdkNEcms3RXA2ck84SU95YmtPdXN1T3lkbUNEc29KWHJzN1RDdCt5aHNPcXh0Q2pzaUt2c25wREN0K3VNZ095RGdjSzM3S0d3NnJHMEtleWRnQ0RzbktEc3A0RHRsWmpxczZBc0lPeVhodXVLbENEc29KWHJzN1RycGJ3ZzdLZUE3SmEwNjRLMDdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcXM2RHN1YUFnNnJLTUlPeVhodXVLbENEc21JSHNsNjNzbmJUcnFiUWc2NHlBN0pXSUlESHFzSnpycDR3ZzY0SzA2ckd3NjRLWUlPdTVpQ0Ryc0xEc2w3VHJvWndnNjVHUTdKYTA2NCtFSU91UW5PdUxwQ0RpZ0pRZzdKYTE3S2VBNjZHY0lPdXdsT3ErdU95bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN1ptVTY2bTBJT3E0c091S3BldXFoU2pyczREcQ0Kc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bklDc0tJQ0FnSUNBZ0tHaGhjMEowYmlBL0lDY3RJQ2pyc29UdGlyd3A3Snk4NjZHY0lPMlJuT3lMbk91UW5DRHNtSUhzbDYzc25ZQWdKeUFySUVKVlZGUlBUbDlTVlV4RklEb2dKeWNwSUNzS0lDQWdJQ0FnSit1THRleWRnQ0Ryc0pqcms1enNpNXdnU2xOUFRpRHFzSjNzc3JRZzdaV1k2NEtZNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9YQ3QreTlsT3VUbk8yT25PeUtwQ0RxdUlqc3A0QTZYRzRuSUNzS0lDQWdJQ0FnSjNzaVozSnZkWEJ6SWpvZ1czc2libUZ0WlNJNklDTHNtSUhzbDYwZzdKMjA2NmFFS095ZWhldWdwZXF6dkNEcmo1bnNuYndwSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcmpJRHNsWWdnNjZ5NDZyV3NJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKeVpXRnpiMjRpT2lBaTdKMjA3SnlnSU8yVm5DRHJyTGpzbnFVaWZWMTkNClhYMWNiaWNnS3dvZ0lDQWdJQ0FuN0ppQjdKZXQ3SjJBSU95ZWhldWdwU0RzaUp6c2hKekN0K3F3bk95SW1PdWx2Q0RxdDdqcmpJRHJvWndnN0tlQTdZS282NHVrTGx4dVhHNG5JQ3NLSUNBZ0lDQWdKMXZzbUlIc2w2M3JzNFFnNjZ5NDZyV3NYVnh1SnlBcklHeHBjM1FLSUNBZ0lDazdDaUFnZlN3Z2JXOWtaV3dzSUhKbGNHRnljMlVwT3dwOUNnb3ZMeUR0bElUcm9JanNub1RyczRRZzdMYVU3TEtjSU95ZGtldUx0ZXlYa095RW5DQmJlMjVoYldVc0lITjFaMmRsYzNScGIyNXpPbHQ3ZEdWNGRDd2djbVZoYzI5dWZWMTlYU0RzdHBUc3Rwd0tablZ1WTNScGIyNGdjR0Z5YzJWSGNtOTFjSE1vY21GM0tTQjdDaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXg3VzF4elhGTmRLbHg5THlrN0NpQWdhV1lnDQpLRzBwSUhNZ1BTQnRXekJkT3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdklEMGdTbE5QVGk1d1lYSnpaU2h6S1RzS0lDQWdJR052Ym5OMElHRnljaUE5SUVGeWNtRjVMbWx6UVhKeVlYa29ieUFtSmlCdkxtZHliM1Z3Y3lrZ1B5QnZMbWR5YjNWd2N5QTZJRnRkT3dvZ0lDQWdZMjl1YzNRZ1ozSnZkWEJ6SUQwZ1lYSnlMbTFoY0Nnb1p5a2dQVDRnS0hzS0lDQWdJQ0FnYm1GdFpUb2dVM1J5YVc1bktDaG5JQ1ltSUdjdWJtRnRaU2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd0tJQ0FnSUNBZ2MzVm5aMlZ6ZEdsdmJuTTZJRUZ5Y21GNUxtbHpRWEp5WVhrb1p5QW1KaUJuTG5OMVoyZGxjM1JwYjI1ektRb2dJQ0FnSUNBZ0lEOGdaeTV6ZFdkblpYTjBhVzl1Y3dvZ0lDQWdJQ0FnSUNBZ0lDQXViV0Z3S0NoNEtTQTlQaUFvZEhsd1pXOW1JSGdnUFQwOUlDZHpkSEpwYm1jbkNpQWdJQ0FnSUNBZ0lDQWdJQ0FnUHlCN0lIUmxlSFE2SUhndWRISnBiU2dwTENCeVpXRnpiMjQ2SUNjbklIMEtJQ0FnSUNBZ0lDQWdJQ0FnSUNBNg0KSUhzZ2RHVjRkRG9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VkR1Y0ZENrZ2ZId2dKeWNwTG5SeWFXMG9LU3dnY21WaGMyOXVPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNXlaV0Z6YjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcENpQWdJQ0FnSUNBZ0lDQWdJQzVtYVd4MFpYSW9LSGdwSUQwK0lIZ3VkR1Y0ZENrS0lDQWdJQ0FnSUNBNklGdGRMQW9nSUNBZ2ZTa3BPd29nSUNBZ0x5OGc3SjIwNjZhRTdLR3c3TENvSU95WGh1cXpvQ0Rzb0p6c2xZanJqNFFnN0plRzY0cVVJT3E3amV1TnNPcTRzT3VuakNEc21aVHNuTHpycWJRZzdaaVY3SXVkSU95ZHRPMkRpT3VobkNEcnM3anJpNlFvNnJDWjdKMkFJT3lFdU95Rm1PeVhrQ0RzbnF6c21wVHNzcTBwQ2lBZ0lDQnlaWFIxY200Z1ozSnZkWEJ6TG5OdmJXVW9LR2NwSUQwK0lHY3VjM1ZuWjJWemRHbHZibk11YkdWdVozUm9LU0EvSUdkeWIzVndjeUE2SUc1MWJHdzdDaUFnZlNCallYUmphQ0FvWDJVcElIc0tJQ0FnSUhKbGRIVnliaUJ1ZFd4c093b2dJSDBLZlFvS0x5OGcNCjdZeWQ3SmVGSU95RXVPMkt1Q0RzdHBUc3Nwd2c3WVMwSU9LQWxDRHRsWndnN1l5ZDdKZUY3SjJZSU9xMXJPeUVzZXlhbE95R2pDanNsNjN0bGFBcjY2eTQ2cldzS2V1bHZDRHRsWndnNjdLSTdKZVFJT3V6dE91Q3RPcXpvQ3dLTHk4ZzdKcVU3SWFNNjdPRUlPdUNzZXF3bk9xd2dDRHNsWVRyaTRqcm5id2dLaXJzbVlUc2hMSHJrSndnN1l5ZDdKZUZJT3lFdU8yS3VDanN2SURzbmJUc2lxUXBJREorTStxd25Db3E2Nlc4SU8yR3RleWN2T3VobkNEcnNKdnJpcFRyaTZRdUNpOHZJTzJEZ095ZHRPMkxnTUszN0pXSTY0SzB3cmZyc29UdGlyenNuYlFnN1pXY0lPdXF1T3ljdk91aG5DRHNuYnpxdElEcmo3enNsYndnN1pXWTY2K0E2NkdjS091VXNPdWhuQ0RydlpIc2xZUWc3S0d3N1pXcDdaV1k2Nm0wSU95V3RPcTRpK3VDbk91THBDa2c3SVM0N1lxNElPdUxxT3ljaE91aG5DRHNvSnpzbFlqdGxaanFzb3dnN1pXYzY0dWtMZ292THlCbGJHVnRaVzUwY3pvZ1czdHliMnhsTENCMFpYaDBmVjBnS08yWmxPdXB0Q0RzDQpuSVRpaHBMc2xZVHJucGdnN0lpY0tTNEtMeThnYlc5eVpUMTBjblZsS0Z2c3ZJRHNuYlRzaXFRZzY0MlVJT3V3bStxNHNGMHA2Nm0wSU95ZHRDRHNoTGpzaFpqc2w1RHNoSndnN0oyMDY2KzRJT3VDdUNEc2hManRpcmpzbVlBZzZySzU3TG1ZN0tlQUlPeVZpdXVLbENEc2c0Z2c3SVM0N1lxNDY2VzhJT3lhbE9xMXJPMlZuT3VMcEM0S1puVnVZM1JwYjI0Z1lYTnJVRzl3ZFhBb1pXeGxiV1Z1ZEhNc0lHMXZaR1ZzTENCeVpYQmhjbk5sTENCdGIzSmxLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnY205c1pYTWdQU0FvWld4bGJXVnVkSE1nZkh3Z1cxMHBMbTFoY0Nnb1pTa2dQVDRnVTNSeWFXNW5LQ2hsSUNZbUlHVXVjbTlzWlNrZ2ZId2dKeWNwS1M1cWIybHVLQ2NzSUNjcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlDaGxiR1Z0Wlc1MGN5QjhmQ0JiWFNrdWJXRndLQ2hsTENCcEtTQTlQZ29nSUNBZ0lDQW9hU0FySURFcElDc2dKeTRnV3ljZ0t5QlRkSEpwYm1jbw0KS0dVZ0ppWWdaUzV5YjJ4bEtTQjhmQ0FuSnlrZ0t5QW5YU0FuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvVTNSeWFXNW5LQ2hsSUNZbUlHVXVkR1Y0ZENrZ2ZId2dKeWNwS1FvZ0lDQWdLUzVxYjJsdUtDZGNiaWNwT3dvZ0lDQWdMeThnNnJDWjdKMkFJTzJNbmV5WGhleWRoQ0RycW9jZzY3S0k3S2U0SU91c3UrdUtsT3luZ0NEcXVMRHNsclVnNG9DVUlPeWVyT3lhbE95eXJleWR0T3VwdENBaTdKMjA3S0NFNnJPOElPdUxwT3VsdUNEc2hManRpcmdpNjZXOElPeWFsT3Exck8yVm5PdUxwQW9nSUNBZ0x5OGdLR0Z6YTBOc1lYVmtaZXlaZ0NEcXNKbnNuWUFnN0oyMDdKeWdPaURzbFlnZzZyZTQ2NStzNjZtMElPMkJ0T3Vobk91VG5PcXdnQ0Rxc0puc25ZQWc3SVM0N1lxNDY2VzhJT3VZa0NEcmdyVHNoSndnVyt5OGdPeWR0T3lLcENEcmpaUWc2N0NiNnJpd1hlcXdnQ0RyckxUc25aanJyN2p0bGJUc3A0VHJpNlFwQ2lBZ0lDQmpiMjV6ZENCclpYa2dQU0FuY0c5d2RYQUJKeUFySUNobGJHVnRaVzUwY3lCOGZDQmINClhTa3ViV0Z3S0NobEtTQTlQaUJUZEhKcGJtY29LR1VnSmlZZ1pTNTBaWGgwS1NCOGZDQW5KeWtwTG1wdmFXNG9Kd0VuS1RzS0lDQWdJR052Ym5OMElHRjBkR1Z0Y0hRZ1BTQW9ZWE5yWldSRGIzVnVkQzVuWlhRb2EyVjVLU0I4ZkNBd0tTQXJJREU3Q2lBZ0lDQmhjMnRsWkVOdmRXNTBMbk5sZENoclpYa3NJR0YwZEdWdGNIUXBPd29nSUNBZ2FXWWdLR0Z6YTJWa1EyOTFiblF1YzJsNlpTQStJREl3TUNrZ1lYTnJaV1JEYjNWdWRDNWpiR1ZoY2lncE95QXZMeURyckxUdGxaenRub2dnN0l5VDdKMjA3S2VBSU95Vml1cXlqQW9nSUNBZ1kyOXVjM1FnWVdkaGFXNGdQU0J0YjNKbElIeDhJR0YwZEdWdGNIUWdQaUF4Q2lBZ0lDQWdJRDhnSit5ZHRDRHRqSjNzbDRYc25ZQWc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRycjdnZzY0dWs2NlNZNjR1a0xpRHNsWjdzaEp3ZzdLQ2M3SldJN1pXY0lPeUV1TzJLdU91VHBPcXp2Q0FxS3V5Z2tlcTN2TUszN0phMDdaeVk2ckNBSU8yWmxleUxwTzJlaUNEcmk2VHJwYmdnDQo3SU9JSU95RXVPMkt1Q29xNjZlTUlPdUN0T3VkdkNqcXNKbnNuWUFnN0lTNDdZcTRJT3V3bU91enRTRHF1SWpzcDRBcExseHVKd29nSUNBZ0lDQTZJQ2NuT3dvZ0lDQWdjbVYwZFhKdUlDZ0tJQ0FnSUNBZ1lXZGhhVzRnS3dvZ0lDQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0FpN1l5ZDdKZUZLT3VMcE95ZHRPeVd2T3Vobk9xM3VDa2c3SVM0N1lxNElPdUxwT3VUck9xNHNDTHJpNlF1SU95VmhPdWVtT3VLbENEdGxad2c3WXlkN0plRjdKMkVJT3ljaE9LR2t1eVZoT3VlbU91aG5DRHJncGpzbDdUdGxad2c2cldzN0lTeDdKcVU3SWFNNjVPazdKMjA2NHVrS095RW5PdWhuQ0RyckxUcXRJRHRsWndnNjdPRTZyQ2NJT3VzdU9xMXJPcXdnQ0RzbFlUcmk0anJpNlFwTGlBbklDc0tJQ0FnSUNBZ0oreWFsT3lHak91bHZDRHJnckhxc0p6cm9ad2c2ck9nN0xtWTdLZUFJT3Vua09xem9Dd2dLaXJ0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcTg3SjIwSU95RW5PdWhuQ0RzbmJ6cXRJRHJrSndnSXV5Wg0KaE95RXNldVFuQ0R0akozc2w0VWc3SVM0N1lxNElpQXlmalBxc0p3cUt1dWx2Q0Rzb0p6c2xZanRsWmpybmJ3dUlPcXdnU0RzaExqdGlyanJpcFFnN0lTYzY2R2NJT3VMcE91bHVDRHNvSkhxdDd6c25iVHNsclRzbGJ3ZzdaV2M2NHVrTGx4dUp5QXJDaUFnSUNBZ0lDZnFzSUVnN0lTNDdZcTQ2NHFVSU95ZWhldWdwZXF6dkNBcUt1cXdtZXlkZ0NEc2w2M3RsYURDdCtxd21leWRnQ0Rxc0p6c2lKakN0K3F3bWV5ZGdDRHNpSnpzaEp3cUt1eWRtQ0RzbXBUc2hvenJwYndnNjZxbzY1R1FJTzJQck8yVnFPMlZuT3VMcEM0ZzdJUzQ3WXE0SU95VmlPeVhrT3lFbkNEdGc0RHNuYlR0aTREQ3QreVZpT3VDdE1LMzY3S0U3WXE4N0oyQUlPMlZuQ0RycXJqc25MenJvWndnNjZlZTdKV0U2NWFvN0phMDdLQzQ3Slc4SU8yVm5PdUxwQ2pzbUlnNklPdXp1T3VzdU95ZHRDQWlmdTJWb09xNWpPeWFsRDhpNjZtMElPdXloTzJLdk95ZGdDQmI3SldFNjR1STdKaWtYUzliNjRTa1hTa3VYRzRuSUNzS0lDQWdJQ0FnSjF2dGpKM3MNCmw0VWc2Nnk0N0xLMElPcTNuT3k1bVNEaWdKUWc3SnlFSU95S3BPMkRnT3lkdkNEcXNJRHNuYlRyazV6c25aZ2dJamd1SU8yTW5leVhoU0lnN0lTNTdJV1k3SjJFSU91VXNPdWx1T3VMcEYxY2JpY2dLd29nSUNBZ0lDQW5MU0R0ZzREc25iVHRpNEE2SU95bnAreWRnQ0RycW9Yc2dxenF0YXdvTW40MDdKYTA3S0NJS1N3ZzdLS0Y2ckt3N0phMDY2KzR3cmZycDRqc3VhanRrWndnN0plRzdKMjBLSDdzbXBRdmZ1dUxwQzkrNnJtTTdKcVVQeURxdUlqc3A0QXBMaURyc0pqcms1enNpNXdnN0pXSTY0SzBLT3V6dU91c3VDa2c2NmVsNjUyOTdKMkVJT3lhbE95VnZlMlZ0Q0R0ZzREc25iVHRpNERycDR3ZzY3U1E2NCtFSU91c3RPeUtxQ0R0akozc2w0WHNuYmpzcDRBZzdKV002cktNSU8yVm1PdWR2QzRnN0p1UTY3TzQ3SjIwSUNMc2xZenJwcnd2N1ptVjdKMjRJdXl5bU91ZnZDRHJwNG5zbDdEdGxaanJxYlFnNjdPNDY2eTQ3SjJFSU9xM3ZPcXhzT3VobkNEcXRhenNzclR0bVpUdGxaanJuYnd1WEc0bklDc0tJQ0FnDQpJQ0FnSnkwZzdKV0k2NEswS091enVPdXN1Q2s2SU8yVnRPeWFsT3l5dEM0ZzdZeVE2NHVvN0oyMElPMlZoT3lhbE8yVm1PdXB0Q0FpZnUyVm9PcTVqT3lhbEQ4aTY2R2NJT3VzdStxem9Dd2c2NUNZNjQrTTY2YTBJT3lJbUNEc2w0YnJpcFFnN0p5RTdaZVlLT3lDcmV5Z25NSzM3WU9JN1llMElPdVRzU25zbllBZzZyS3c2ck84NjZXOElPdW92T3lnZ0NEcXNyM3FzNkR0bFp6cmk2UXVJT3F5c09xenZNSzM3SU9CN1lPY0lPMkd0ZXV6dE91cHRDRHNoSnpzaUtEdG1KWHNuTHpyb1p3ZzdKV002NmF3NjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2N0SU91eWhPMkt2RG9nNjdPNDY2eTQ3SjIwSUNKKzdaV2c2cm1NN0pxVVB5THJxYlFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBzSU91enVPdXN1T3lkdENEc2c0SHRtYW5zbllRZzdJU2M3SWlnN1pXWTZyT2dJT3lkdENEcnNvVHRpcnpzbmJRZzdJdWs3S0NjSU91UG1leWVrZXlkdE91cHRDRHJqNW5zbnBFZzY0K1o3SUtzS095Q3JleWduQy9zb0lEc25xVXY3SmV3NnJLdw0KSU8yVnRPeWduQ0RyazdFcExDRHRoclhyczdRZzdZeWQ3SmVGN0oyWUlPdUxxT3lkdkNEcnNvVHRpcnpzbmJUcnFiUWdJdTJabGV5ZHVDSXVJQ0xzdDZqc2hvd2k2NHFVSU91UG1leWVrU0Ryc29UdGlyenFzN3dnN0tlZDdKMjhJT3VWak91bmpDd2dJdXVMcStxNHNNSzM2NCtaN0o2UklpRHNvYkR0bGFrZzZyaUk3S2VBTGlEdG1aVHJxYlFnNnJpdzY0cWw2NnFGS091emdPcXl2Y0szN1pXMDdLQ2NJT3VUc1Nuc25ZQWc2cmU0NjR5QTY2R2NJT3VSbE91THBDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEc201RHJyTGpzblpnZzdLQ1Y2N08wd3Jmc29iRHFzYlFvN0lpcjdKNlF3cmZzbmJUc2c0RXY3SjIwN1pXWXdyZnJqSURzZzRFcDdKMkFJT3ljb095bmdPMlZtT3F6b0N3ZzdKdVE2Nnk0N0plUUlPeVhodXVLbENEc29KWHJzN1RDdCt5Z2lPeXdxTUszN0pldzY1Mjk3TEtZNjZXOElPeW5nT3lXdE91Q3RPeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSit1THRleWRnQ0Ryc0pqcms1enNpNXdnU2xOUFRpRHENCnNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1hDdCt5OWxPdVRuTzJPbk95S3BDRHF1SWpzcDRBNlhHNG5JQ3NLSUNBZ0lDQWdKM3NpYzJWMGN5STZJRnQ3SW5KbFlYTnZiaUk2SUNMc25iUWc3SVM0N1lxNDdKMllJT3V3cWUyV3BleWRoQ0R0bFp6cXRhM3NsclFnN1pXY0lPdXN1T3llcGV5Y3ZPdWhuQ0lzSUNKbGJHVnRaVzUwY3lJNklGdDdJbkp2YkdVaU9pQWk3SmV0N1pXZ0lpd2dJblJsZUhRaU9pQWk2Nnk0NnJXc0lDanNwSVRyc0pUcXY0anNuWUFnWEZ4dUtTSjlMQ0F1TGk1ZGZTd2dMaTR1WFgxY2JpY2dLd29nSUNBZ0lDQW43SmV0N1pXZzdKMkFJT3llaGV1Z3BTRHNpSnpzaEp6cmpJRHJvWnc2SUNjZ0t5QnliMnhsY3lBcklDZGNibHh1SnlBckNpQWdJQ0FnSUNkYjdZeWQ3SmVGSU95YWxPeUdqRjFjYmljZ0t5QnNhWE4wQ2lBZ0lDQXBPd29nSUgwc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzS2ZRb0tMeThnN1l5ZDdKZUZJT3lkDQprZXVMdGV5WGtPeUVuQ0I3YzJWMGN6b2dXM3R5WldGemIyNHNJR1ZzWlcxbGJuUnpPbHQ3Y205c1pTeDBaWGgwZlYxOVhYMGc3TGFVN0xhY0lDanN2WlRyazV6dGpwenNpcVRDdCt5Vm51dVNwQ0RzbnFIcmk3UWc3WmVJN0pxcEtRcG1kVzVqZEdsdmJpQndZWEp6WlZCdmNIVndLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQnpaWFJ6U1c0Z1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTV6WlhSektTQS9JRzh1YzJWMGN5QTZJRnRkT3dvZ0lDQWdZMjl1YzNRZ2MyVjBjeUE5SUhObA0KZEhOSmJnb2dJQ0FnSUNBdWJXRndLQ2h6ZENrZ1BUNGdLSHNLSUNBZ0lDQWdJQ0J5WldGemIyNDZJRk4wY21sdVp5Z29jM1FnSmlZZ2MzUXVjbVZoYzI5dUtTQjhmQ0FuSnlrdWRISnBiU2dwTEFvZ0lDQWdJQ0FnSUdWc1pXMWxiblJ6T2lCQmNuSmhlUzVwYzBGeWNtRjVLSE4wSUNZbUlITjBMbVZzWlcxbGJuUnpLUW9nSUNBZ0lDQWdJQ0FnUHlCemRDNWxiR1Z0Wlc1MGN3b2dJQ0FnSUNBZ0lDQWdJQ0FnSUM1dFlYQW9LR1ZzS1NBOVBpQW9leUJ5YjJ4bE9pQlRkSEpwYm1jb0tHVnNJQ1ltSUdWc0xuSnZiR1VwSUh4OElDY25LUzUwY21sdEtDa3NJSFJsZUhRNklGTjBjbWx1Wnlnb1pXd2dKaVlnWld3dWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tLSUNBZ0lDQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaGxiQ2tnUFQ0Z1pXd3VkR1Y0ZENrS0lDQWdJQ0FnSUNBZ0lEb2dXMTBzQ2lBZ0lDQWdJSDBwS1FvZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2h6ZENrZ1BUNGdjM1F1Wld4bGJXVnVkSE11YkdWdVozUm8NCktUc0tJQ0FnSUhKbGRIVnliaUJ6WlhSekxteGxibWQwYUNBL0lITmxkSE1nT2lCdWRXeHNPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdDaUFnSUNCeVpYUjFjbTRnYm5Wc2JEc0tJQ0I5Q24wS0NpOHZJT3VNZ08yWmxPMllsU0Rzb0p6c25wRWc3SjJSNjR1MTdKZVE3SVNjSUh0eVpYQnNlU3dnYzNWbloyVnpkR2x2Ym5OYlhYMGc3TGFVN0xhY0lDanN2WlRyazV6dGpwenNpcVRDdCt5Vm51dVNwQ0RzbnFIcmk3UWc3WmVJN0pxcEtRcG1kVzVqZEdsdmJpQndZWEp6WlVOdmJYQnZjMlVvY21GM0tTQjdDaUFnYkdWMElITWdQU0JUZEhKcGJtY29jbUYzS1M1MGNtbHRLQ2t1Y21Wd2JHRmpaU2d2WG1CZ1lDZy9PbXB6YjI0cFAxeHpLaTlwTENBbkp5a3VjbVZ3YkdGalpTZ3ZYSE1xWUdCZ0pDOXBMQ0FuSnlrN0NpQWdZMjl1YzNRZ2JTQTlJSE11YldGMFkyZ29MMXg3VzF4elhGTmRLbHg5THlrN0NpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnZJRDBnU2xOUFRpNXdZWEp6DQpaU2h6S1RzS0lDQWdJR052Ym5OMElISmxjR3g1SUQwZ1UzUnlhVzVuS0NodklDWW1JRzh1Y21Wd2JIa3BJSHg4SUNjbktTNTBjbWx0S0NrN0NpQWdJQ0JqYjI1emRDQnpkV2RuWlhOMGFXOXVjeUE5SUVGeWNtRjVMbWx6UVhKeVlYa29ieUFtSmlCdkxuTjFaMmRsYzNScGIyNXpLUW9nSUNBZ0lDQS9JRzh1YzNWbloyVnpkR2x2Ym5NS0lDQWdJQ0FnSUNBZ0lDNXRZWEFvS0hncElEMCtJQ2g3SUhSbGVIUTZJRk4wY21sdVp5Z29lQ0FtSmlCNExuUmxlSFFwSUh4OElDY25LUzUwY21sdEtDa3NJSEpsWVhOdmJqb2dVM1J5YVc1bktDaDRJQ1ltSUhndWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1FvZ0lDQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb2VDa2dQVDRnZUM1MFpYaDBLUW9nSUNBZ0lDQTZJRnRkT3dvZ0lDQWdhV1lnS0hKbGNHeDVJSHg4SUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNrZ2NtVjBkWEp1SUhzZ2NtVndiSGtzSUhOMVoyZGxjM1JwYjI1eklIMDdDaUFnZlNCallYUmphQ0FvWDJVcA0KSUhzZ0x5b2c3SldFNjU2WTY2R2NJQ292SUgwS0lDQnlaWFIxY200Z2JuVnNiRHNLZlFvS0x5OGc2N0tJN0pldElPeWRrZXVMdGV5WGtPeUVuQ0I3ZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dWZTRHN0cFRzdHB3Z0tPeTlsT3VUbk8yT25PeUtwTUszN0pXZTY1S2tJT3llb2V1THRDRHRsNGpzbXFrcENtWjFibU4wYVc5dUlIQmhjbk5sVkhKaGJuTnNZWFJsS0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdieUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCamIyNXpkQ0IwY21GdWMyeGhkR1ZrSUQwZ1UzUnlhVzVuS0NodklDWW1JRzh1ZEhKaGJuTnMNCllYUmxaQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tUc0tJQ0FnSUdsbUlDaDBjbUZ1YzJ4aGRHVmtLU0J5WlhSMWNtNGdleUIwY21GdWMyeGhkR1ZrTENCa2FYSmxZM1JwYjI0NklGTjBjbWx1Wnlnb2J5QW1KaUJ2TG1ScGNtVmpkR2x2YmlrZ2ZId2dKeWNwTG5SeWFXMG9LU0I5T3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUc1MWJHdzdDbjBLQ2k4dklPeWRrZXVMdGV5WGtPeUVuQ0I3ZEdWNGRDd2djbVZoYzI5dWZTRHJzTERzbDdRZzdMYVU3TGFjSUNqc3ZaVHJrNXp0anB6c2lxVEN0K3lWbnV1U3BDRHNucUhyaTdRZzdaZUk3SnFwS1FwbWRXNWpkR2x2YmlCd1lYSnpaVk4xWjJkbGMzUnBiMjV6S0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6DQpMbTFoZEdOb0tDOWNXMXRjYzF4VFhTcGNYUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ1lYSnlJRDBnU2xOUFRpNXdZWEp6WlNoektUc0tJQ0FnSUdsbUlDaEJjbkpoZVM1cGMwRnljbUY1S0dGeWNpa3BJSHNLSUNBZ0lDQWdjbVYwZFhKdUlHRnljZ29nSUNBZ0lDQWdJQzV0WVhBb0tIZ3BJRDArSUNoN0lIUmxlSFE2SUZOMGNtbHVaeWdvZUNBbUppQjRMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tzSUhKbFlYTnZiam9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VjbVZoYzI5dUtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwcEtRb2dJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tIZ3BJRDArSUhndWRHVjRkQ2s3Q2lBZ0lDQjlDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIMEtJQ0J5WlhSMWNtNGdXMTA3Q24wS0NpOHZJT3Vobk9xM3VPeWR1Q0R0bFlUc21wVEN0KzJWbk91UGhDRHN0SWpxczd3ZzdJT0I3WU9jN0oyOElPdVZqQ0F2YUdWaA0KYkhSb0lPeWhzTzJhak9xd2dDRHNtS1RycWJRZzY1S2s3SmVRN0lTY0lPeWJqT3V3amV5WGhleWRoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzA2N080NjR1a0lDZ3pNT3kwaU95WGtDQXg2N0tJNjZlTUtTNEtMeThnN0lTeDZyTzE3WldZNjZtMElPcXlzT3F6dkNEdGxianJrNlRybjZ6cXNJQWdZMnhoZFdSbFUzUmhkSFZ6UFNkdmF5ZnJvWndnNjVDWTY0K002NmFzNjYrQTY2R2NMQ0RzbnF6cm9aenF0N2pzbmJnZzdadUVJT3V5aE8yS3ZPeWR0Q0Rzb0lEc29JanJvWndnOEorZm91eWN2T3VobkNEcnM3WHF0NER0bFp6cmk2UXVDaTh2SUNqdGxJenJuNnpxdDdqc25ianNuYlFnNjZHYzZyZTQ3SjI0SU95d3ZleWRoQ0RzbDdBZzY1S2tJT3lqdk9xNHNPeWdnZXljdk91aG5DQXZhR1ZoYkhSbzY2VzhJT3loc08yYWpPMlZtT3VLbENEcXNvUHFzN3dnN0tlZDdKMkVJT3lkdE91anJPdUxwQ2tLTHk4ZzdaV2M2NCtFSU95MGlPcXp2T3VQaENEcXNKbnNuWUFnNnJLOTY2R2M2NkdjSU91enRlcTNnT3lMbk8yQ3FPdUwNCnBDRGlnSlFnNnJTQTY2YXM3SjZRNnJDQUlPMlZuT3VQaE91bHZDRHNtS3pyb0tUc283enFzYkRyZ3BnZzdaV2M2NCtFNnJDQUlPeTBpT3E0c08yWmxPdVFtT3VwdEFvdkx5RHNncXpzbXFuc25wRHFzSUFnN0pXRTY2eTA2cktENjQrRUlPeVZpQ0RyaUl6cm42enJqNFFnNjdLRTdZcTg3SjIwSVBDZm42THNuTHpyb1p3ZzY0K003SldFN0ppbzY0dWtMaUR0bFp6cmo0VHNsNUFnNnJHNDY2YXdJTzJZdU95Mm5PeWRnQ0Rxc2JEc29JanJrSmpycjREcm9ad2c3SUtzN0pxcDY1K0o3SjJBSU95VmlDRHJncGpxc0lUcmk2UUtMeThnNnJPRTdLQ1Y3SjIwSUNvcTY3Q1c3SmVRN0lTY0tpb2c2N0NVNjRDUUlPcXlnK3lkaENEc2xZenNsWVRzc1lqcmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVEkyS1M0S0x5OGc3WVN3NjYrNDY0U1E3SjIwNjRLWUlPdTRqT3Vkdk95YXNPeWdnT3lYa095RW5DRHJpNlRycGJnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJWbU91cHRDRHNucERxc3Fuc3BwM3Jxb1VnDQo3WXlNN0oyODdKMkFJT3V3bE91QWpPeW5nT3VuakN3ZzdKMjA2Nis0SU91V29DRHNub2pyaXBRZ1kyeGhkV1JsQ2k4dklPeUV1T3lGbU95ZGdDRHNpNXpyajVudGxhQWc2NVdNSU91d20reWRnQ0RzbUpzZzZyT0U3S0NWSU95ZWhleWVwZXEyak95ZGhDRHF0N2pyaklEcm9ad2c3Sk8wNjR1a0lPS0draURzZzRnZzZyT0U3S0NWN0plUUlPeUNyT3lhcWV1ZmlleWR0Q0RyZ3Fqc2xZUWc3SjZJN0phMDY0K0VJQ0x0bFp6cmo0UWc3TFNJNnJPOEl1cXdnQW92THlEcXM0VHNobzBnNjRLWTdKaW82NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Eb2dJdXlEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NkdjNnJlNDdKMjQ3WmFJNjRxVTY0MndJT3labkNEcXQ3Z2c2ck9FN0tDVklPeUNyT3lhcWV1ZmlleWRoQ0RycXJzZzdKT3c2NE9RSWlrdUNpOHZJTzJVak91ZnJPcTN1T3lkdU95ZGhDRHFzYkRzdVp3ZzY2R2M2cmU0N0oyNHdyZnJvWnpxdDdqc2xZVHNtNE1vTDI5d1pXNHRiRzluYVc3Q3R5OWpiR0YxWkdVdA0KYkc5bmIzVjBLZXlkZ0NCcmFXeHNVSEp2WSt5Y3ZPdWhuQ0RzaExqc2haanNuWVFnNjdLRTY2Q2s3SVNjSU95ZHRDRHJyTGpzb0p6cXNJQUtMeThnN0plRzdKZUk2NHFVNjQyd0xDRHJzSmJzbDVEc2hKd2c2N0NVNnI2NDY2bTBJT3VMcE91bXJPcXdnQ0RzbFl3ZzY3Q3A2N0tWN0oyMElPeVhodXlYaU91THBDNGc2cmU0NjU2WTdJU2NJQzlvWldGc2RHZ2c3S0d3N1pxTTY2ZUk2NHVrSU8yTWpPeWR2T3lkbUNEcXM0VHNvSlhxczd3ZzY3bUU2cldRN1pXYzY0dWtMZ292THlEcnVZVHNtcWtnTUNqdGpJenNuYnpycDR3ZzdKMjk2ck9nTENCamJHRjFaR1ZCWTJOdmRXNTA3SjJZSURNdzdMU0lJT3k2a095TG5PdWx2Q0RxdDdqcmpJRHJvWndnN0pPMDY0dWtJT0tBbENBdVkyeGhkV1JsTG1wemIyN3NuYlFnN0x1azdJU2NJT3VucE91eWlDRHNuYjNzcDRBZzdKV0s2NHFVNjR1a0tTNEtMeThnNnJPRTdLQ1ZJT3llaU95ZGpDRGlocElnN0plRzdKMk1LT3Vobk9xM3VPeVZoT3liZ3lrZzY3Q3A3WmFsN0oyQUlPcXgNCnRPdVRuT3Vtck95bmdDRHNsWXJyaXBUcmk2UTZJTzJNak95ZHZPeWRoQ0RyamE3c2xyVHNrN0RyaXBRZzdJaWM2ckNFSU95ZW9PcTVrQ0RycXJzZzdKMjk2NHFVSU9xeWcrcXp2QW92THlEcXRhenJ0b1Rya0pqc3A0QWc3SldLN0pXRUlPMlhteURzbnF6c2k1enNucEhzbllRZzY3YUE2NlcwNnJPZ0xDRHF0N2dnNjdDcDdaYWw3SjJBSU95ZHVPeW1uU0RzbUtUcnBaZ2c2cks5NjZHY0tHbHpRWFYwYUVWeWNtOXlLZXF3Z0NEc25iVHJyN2dnN0xLWTY2YXM3WldjNjR1a0xncG1kVzVqZEdsdmJpQnlaWE4wWVhKMFNXWkJZMk52ZFc1MFEyaGhibWRsWkNncElIc0tJQ0JwWmlBb0lYQnliMk1nZkh3Z2QyRnBkR1Z5S1NCeVpYUjFjbTQ3SUNBZ0lDQWdJQ0FnTHk4ZzdJUzQ3SVdZSU95WGh1eWRqQ2pyaTZUc25Zd2c3WVMwN0oyMElPeURpT3VobkNEc2k1enJqNWtwSUM4ZzdZUzBJT3luaE8yV2lTRHNwSkhzbmJUcnFiUWc2NHVrN0oyTUlPeWhzTzJhak95WGtPeUVuQW9nSUdOdmJuTjBJRzV2ZHlBOUlHTnNZWFZrDQpaVUZqWTI5MWJuUW9LVHNLSUNCcFppQW9JVzV2ZHlCOGZDQnViM2NnUFQwOUlITmxjM05wYjI1QlkyTnZkVzUwS1NCeVpYUjFjbTQ3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3F6aE95Z2xleWR0Q0Ryc0pUcmdJenNsNGpzbHJUc21wUWdLQ2NnS3lBb2MyVnpjMmx2YmtGalkyOTFiblFnZkh3Z0oreVhodXlkakNjcElDc2dKeURpaHBJZ0p5QXJJRzV2ZHlBcklDY3BJT0tBbENEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJzb1RycHF6cXM2QWc3SU9JSU9xemhPeWdsZXljdk91aG5DRHJpNlRzaTV3ZzdJdWM3SjZSN1pXcDY0dUk2NHVrTGljcE93b2dJQzh2SU95ZG1PdVBoT3lnZ1NEc29vWHJvNHdvY21WaGMyOXVJT3luZ095Z2xTa2c0b0NVSUZORlUxTkpUMDVmUkVsRlJPdWhuQ0RyZ1ozcmdyVHJxYlFnN0o2UTY0K1pJT3llck95TG5PdVBoT3F3Z0NEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcnByRHJpNlFLSUNCcmFXeHNVSEp2WXlnbjZyT0U3S0NWN0oyMA0KSU91d2xPdUFqT3lXdE95RW5DRHNoTGpzaFpqc25ZUWc3SU9JNjZHY0lPeUxuT3lla2UyV2lPeVd0T3lhbENEaWdKUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeWs3Q2lBZ1kyeGhkV1JsVTNSaGRIVnpJRDBnYm5Wc2JEc2dMeThnN1pXYzY0K0V3cmZyb1p6cXQ3anNuYmdnN0lPQjdZT2M2NHFVSU9xemhPeWdsZXVuaU91THBDRHJpNlRycGJUcmk2UWc0b0NVSU95RGlDRHFzNFRzb0pYc25MenJvWndnNjR1azdJdWNJTzJNa095Z2xlMlZtT3F5akFvZ0lITmxjM05wYjI1QlkyTnZkVzUwSUQwZ2JtOTNPd3A5Q2dwc1pYUWdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEMGdNRHNLWm5WdVkzUnBiMjRnY21WMGNubEJkWFJvU1daT1pXVmtaV1FvS1NCN0NpQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QWhQVDBnSjJOc1lYVmtaUzFzYjJkdmRYUW5JQ1ltSUdOc1lYVmtaVk4wWVhSMWN5QWhQVDBnSjJOc1lYVmtaUzFzYVcxcGRDY3BJSEpsZEhWeWJqc0tJQ0JwWmlBb2QyRnBkR1Z5SUh4OElFUmgNCmRHVXVibTkzS0NrZ0xTQnNZWE4wUVhWMGFGSmxkSEo1UVhRZ1BDQXpNREF3TUNrZ2NtVjBkWEp1T3lBdkx5RHNwNFR0bG9rZzdLU1JJTzJFdENEcnNLbnRsYlFnNnJpSTdLZUFJQ3NnTXpEc3RJZ2c2ckNFNnJLcENpQWdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJT3llck8yWmxleWR1Q0RzaTV6cmo0VGlnS1luS1RzS0lDQnlkVzVVZFhKdUtDZ3BJRDArSUNmcm9aenF0N2pzbmJnZzdabVY3SjI0N0pxcDdKMjA2NHVrTGlBaVQwc2k2NTI4NnJPZzY2ZU1JT3VMdGUyVm1PdWR2QzRuS1M1MGFHVnVLQW9nSUNBZ0tDa2dQVDRnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHRtWlhzbmJqcmtLZ2c0b0NVSU95Z2xleURnU0RzZzRIdGc1enJvWndnNjdPMTZyZUFMaWNwTEFvZ0lDQWdLR1VwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbFlUc3A0RWc2NkdjDQo2cmU0N0oyNElPeVZpQ0Rya0tnNkp5d2dVM1J5YVc1bktHVXViV1Z6YzJGblpTa3VjMnhwWTJVb01Dd2dPREFwS1FvZ0lDazdDbjBLQ2k4dklPeUxwTzJNcUNEc25aSHJpN1hzbllRZzdJS3M2NTZNN0pxcElPeVZpT3VDdE91aG5DRHJzNER0bVpnZzRvQ1VJT3lia095ZHVDanJvWnpxdDdqc25iZ3Y3SVNrN0xtWUtleWR0Q0R0akl6c2xZWHJrSndnNnJLOTdKcXc3SmVVSU9xM3VDRHNsWWpyZ3JUcnBid3NJT3lWaE91TGlPdXB0Q0Rzb0pIcmtaRHNsclFyN0p1UTY2eTQ3SjJFSU91enRPdUN1T3VMcEFwbWRXNWpkR2x2YmlCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUhCeVpXWnBlQ2tnZXdvZ0lHbG1JQ2hsSUNZbUlHVXViV1Z6YzJGblpTQTlQVDBnVEU5SFNVNWZSMVZKUkVVcElISmxkSFZ5YmlCN0lHVnljbTl5T2lCTVQwZEpUbDlIVlVsRVJTd2djSEp2WW14bGJUb2dKMk5zWVhWa1pTMXNiMmR2ZFhRbklIMDdDaUFnYVdZZ0tHVWdKaVlnWlM1dFpYTnpZV2RsSUQwOVBTQk1TVTFKVkY5SFZVbEVSU2tnY21WMA0KZFhKdUlIc2daWEp5YjNJNklFeEpUVWxVWDBkVlNVUkZMQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMV3hwYldsMEp5QjlPd29nSUdsbUlDaGpiR0YxWkdWVGRHRjBkWE1nUFQwOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljcElIc0tJQ0FnSUhKbGRIVnliaUI3SUdWeWNtOXlPaUFuN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbEtHTnNZWFZrWlNucXNJQWc3SVNrN0xtWTY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUWc0b0NVSU95RXBPeTVtTzJWbU9xem9DRHJvWnpxdDdqc25ianRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3NJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y2dmVHNLSUNCOUNpQWdjbVYwZFhKdUlIc2daWEp5YjNJNklIQnlaV1pwZUNBcklDaGxJQ1ltSUdVdWJXVnpjMkZuWlNBL0lHVXViV1Z6YzJGblpTQTZJRk4wY21sdVp5aGxLU2tnZlRzS2ZRb0tablZ1WTNScGIyNGdjbVZoWkVKdlpIa29jbVZ4S1NCN0NpQWdjbVYwZFhKdUlHNWwNCmR5QlFjbTl0YVhObEtDaHlaWE52YkhabEtTQTlQaUI3Q2lBZ0lDQnNaWFFnWW05a2VTQTlJQ2NuT3dvZ0lDQWdjbVZ4TG05dUtDZGtZWFJoSnl3Z0tHTXBJRDArSUhzZ1ltOWtlU0FyUFNCak95QjlLVHNLSUNBZ0lISmxjUzV2YmlnblpXNWtKeXdnS0NrZ1BUNGdld29nSUNBZ0lDQjBjbmtnZXlCeVpYTnZiSFpsS0VwVFQwNHVjR0Z5YzJVb1ltOWtlU2twT3lCOUlHTmhkR05vSUNoZlpTa2dleUJ5WlhOdmJIWmxLSHQ5S1RzZ2ZRb2dJQ0FnZlNrN0NpQWdmU2s3Q24wS0NtTnZibk4wSUVOUFVsTmZTRVZCUkVWU1V5QTlJSHNLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUM0pwWjJsdUp6b2dKeW9uTEFvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFOWlhSb2IyUnpKem9nSjBkRlZDd2dVRTlUVkN3Z1QxQlVTVTlPVXljc0NpQWdKMEZqWTJWemN5MURiMjUwY205c0xVRnNiRzkzTFVobFlXUmxjbk1uT2lBblEyOXVkR1Z1ZEMxVWVYQmxKeXdLZlRzS1puVnVZM1JwYjI0Z2FuTnZiaWh5DQpaWE1zSUhOMFlYUjFjeXdnYjJKcUtTQjdDaUFnY21WekxuZHlhWFJsU0dWaFpDaHpkR0YwZFhNc0lFOWlhbVZqZEM1aGMzTnBaMjRvZXlBblEyOXVkR1Z1ZEMxVWVYQmxKem9nSjJGd2NHeHBZMkYwYVc5dUwycHpiMjQ3SUdOb1lYSnpaWFE5ZFhSbUxUZ25JSDBzSUVOUFVsTmZTRVZCUkVWU1V5a3BPd29nSUhKbGN5NWxibVFvU2xOUFRpNXpkSEpwYm1kcFpua29iMkpxS1NrN0NuMEtDbU52Ym5OMElITmxjblpsY2lBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtHRnplVzVqSUNoeVpYRXNJSEpsY3lrZ1BUNGdld29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjBkRlZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OW9aV0ZzZEdnbktTQjdDaUFnSUNCeVpYTjBZWEowU1daQlkyTnZkVzUwUTJoaA0KYm1kbFpDZ3BPeUF2THlEcnNKYnNsNURzaEp3ZzZyT0U3S0NWN0oyRUlPdXdsT3EvcU95Y3ZPdXB0Q0RzbUpzZzZyT0U3S0NWSU95RXVPeUZtT3lkaENEcnFMenNvSUFnNjdLRTY2YXc2NHVrSUNqc2xZVHJucGdnN0p1TTY3Q043SmVGN0oyMElPeVlteURxczRUc29KWHNuTHpyb1p3ZzY0K003S2VBSU95Vml1cXlqQ2tLSUNBZ0lISmxkSEo1UVhWMGFFbG1UbVZsWkdWa0tDazdJQzh2SU91aG5PcTN1T3lkdUNEdGxZVHNtcFFnN0lPQjdZT2M2Nm0wSU95ZXJPMlpsZXlkdUNEc2k1enJqNFFnNG9DVUlPeWVyT3Vobk9xM3VPeWR1T3lkdENEcmdaM3JncXpzbkx6cnFiUWc2NHVrN0oyTUlPeWhzTzJhak91MmdPMkVzQ0J3Y205aWJHVnQ3SjIwSU8yU2dPdW1zT3VMcEFvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzS0lDQWdJQ0FnYjJzNklIUnlkV1VzSUdWdVoybHVaVG9nSjJOc1lYVmtaU2NzSUhZNklFSlNTVVJIUlY5V0xDQmthWEk2SUY5ZlpHbHlibUZ0WlN3Z0x5OGdkc0szWkdseU9pRHENCnRhenJzb1Rzb0lRdjdKZUo2NXF4N1pXY0lPeUNyT3V6dU95ZHRDRHJscUFnN0o2STY0cVU3S2VBSU95bmhPdUxxT3lhcVFvZ0lDQWdJQ0J0YjJSbGJEb2dZM1Z5Y21WdWRFMXZaR1ZzTENCdGIyUmxiSE02SUVGTVRFOVhSVVJmVFU5RVJVeFRMQ0JsZUdGdGNHeGxjem9nUlZoQlRWQk1SVk11YkdWdVozUm9MQ0JuZFdsa1pUb2dSMVZKUkVVdWJHVnVaM1JvTENCeVpXRmtlVG9nZDJGeWJXVmtWWEFzQ2lBZ0lDQWdJSEJ5YjJKc1pXMDZJQ2hqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJQ2R2YXljZ2ZId2dZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQnVkV3hzS1NBL0lHNTFiR3dnT2lCamJHRjFaR1ZUZEdGMGRYTXNDaUFnSUNBZ0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3S0lDQWdJQ0FnYzJWeWRtVmtPaUJ6ZEdGMGN5NXpaWEoyWldRc0lHeGhjM1JCZERvZ2MzUmhkSE11YkdGemRFRjBMQ0JzWVhOMFZHVjRkRG9nYzNSaGRITXViR0Z6ZEZSbGVIUXNJR3hoYzNSVFpXTTZJSE4wWVhSekxteGhjM1JUDQpaV01zQ2lBZ0lDQjlLVHNLSUNCOUNpQWdMeThnN1pTTTY1K3M2cmU0N0oyNElPeUxyT3llcGV1d2xldVBtU0RpZ0pRZzY0R0s2cml3NjZtMElPeWNoQ0Rxc0pEc2k1d2c3WU9BN0oyMDY2aTQ2ckNBSU91THBPdW1yT3VsdkNEcmdZanJpNlFLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YUdWaGNuUmlaV0YwSnlrZ2V3b2dJQ0FnYkdGemRFSmxZWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ2ZRb2dJQzh2SU91aG5PcTN1T3lkdUNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0N0oyWUlGdnduNStnSU8yQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJnZzdaV0U3SnFVWGNLM1cvQ2ZsSkZkSU91eWhPMkt2T3lkdENEdG1ManN0cHp0bFp6cmk2UXVDaUFnTHk4ZzZyaXc2N080S091NGpPdWR2T3lhc095Z2dDRHNwNEh0bG9rcE9pQmdZMnhoZFdSbElHRjFkR2dnYkc5bg0KYVc0Z0xTMWpiR0YxWkdWaGFXRHJwYndnN0lpbzdKMkFJTzJVaE91aG5PeUV1T3lLcE91aG5DRHNpNlR0bG9rZzRvQ1VJT3VwbE91SnRDRHNsNGJzbmJRZzZyT243SjZsSU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUcXM2QXNDaUFnTHk4Z0lDQnNiMk5oYkdodmMzUWc3SWlZN0l1Z0lPMlByTzJLdU91aG5DRHFzckRxczd6cnBid2c3SjZRNjQrWklPeUltT3VndWUyVm5PdUxwQ2pzaTZUc3VLRTZJTzJYcE91VG5PdW1yT3lLcE95WGtPeUVuT3VQaENEcnVJenJuYnpzbXJEc29JQWc3SmUwNjZhOElDc2dURWxUVkVWT0lPMlpsZXlkdUN3Z01qQXlOaTB3TnlrdUNpQWdMeThnSUNEdGhMRHJyN2pyaEpEc25iUWc3Wm1VNjZtMDdKZVFJT3lnaE8yWWdDRHNsWWdnNjV5czY0dWtMaURydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNDY2ZU1JTzJWbU91cHRDRHJnWjB1Q2lBZ0x5OGc3WSswNjdDeEtPMkVzT3V2dU91RWtDazZJT3lla091UG1TRHNtWVRybzR6cXNJQWc2NmVKN1o2TUlPMlptT3F5dlNqcnVJenINCm5ienNtckRzb0lEcXNJQWdiRzlqWVd4b2IzTjA3SmVRSU91cXV5RHJpNy9zbFlRZzdMMlU2NU9jNnJDQUlPdXp0T3lkdE91S2xDRHFzcjNzbXJBcDdKZVE3SVNjQ2lBZ0x5OGdJQ0Ryb1p6cXQ3anNuYmdnNjR5QTZyaXdJT3lra1NEcnNvVHRpcnpzbllRZzY1aVFJT3VJaE91bHRPdXB0Q3dnN0wyVTY1T2M2Nlc4SU91Mm1leVhyT3VFbyt5ZGhDRHNpSmdnN0o2STY0cVVJTzJFc091dnVPdUVrQ0Ryc0tuc2k1M3NuTHpyb1p3ZzdLQ0U3Wm1ZN1pXYzY0dWtMZ29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl2Y0dWdUxXeHZaMmx1SnlrZ2V3b2dJQ0FnWTI5dWMzUWdZbTlrZVNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdDaUFnSUNCamIyNXpkQ0J6ZDJsMFkyaE5iMlJsSUQwZ0lTRW9ZbTlrZVNBbUppQmliMlI1TG5OM2FYUmphRUZqWTI5MWJuUXBPeUF2THlEcXM0VHNvSlVnN0tDRTdabVlJRDBnN0l1YzdZR3M2NmEvSU95d3ZleWN2T3VoDQpuQ0RzbDdUc2xyUWc2ck9FN0tDVjdKMkVJT3F6b091bHZDRHNpSmdnN0o2STZyS01DaUFnSUNCMGNua2dld29nSUNBZ0lDQXZMeUJqYkdGMVpHWHFzSUFnN0plRzdKeTg2Nm0wSU95WHJPcTRzT3lFbkNEcmdZcnJpcFRyaTZRdUlITm9aV3hzT25SeWRXWHJuYndnWTJ4aGRXUmw2ckNBSU95WGh1eVd0T3VQaENEc2hianNuWUFnN0tDVjdJT0JJT3lMcE8yV2lldVB2QW9nSUNBZ0lDQXZMeUJ6Y0dGM2J1eWRtQ0FuWlhKeWIzSW42ckNBSU95VmlDRHJuS2pxczZBc0lPeVlpT3lnaE95WGxDRHF0N2pyaklEcm9ad2diMnM2ZEhKMVpldWx2Q0RyajR6cm9LVHNwS3pyaTZRZzRvQ1VDaUFnSUNBZ0lDOHZJTzJVak91ZnJPcTN1T3lkdU95ZGdDQWk2N2lNNjUyODdKcXc3S0NBNjZXOElPeVh0T3lYaU95V3RPeWFsQ0xybmJ6cXM2QWc3WldZNjRxVTY0MndJT3lMcE95Z25PdWhuT3VLbENEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU91Y3FPdUtsQ0RzZzRIdGc1enFzSUFnNjVDUTY0dWtLT3lMcE95Z25DRHNpNkRxczZBcA0KTGdvZ0lDQWdJQ0JwWmlBb1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBblkyeGhkV1JsTFcxcGMzTnBibWNuS1NCN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ERXNJSHNLSUNBZ0lDQWdJQ0FnSUdWeWNtOXlPaUFuN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lYaHV5V3RPeWFsQ0RpZ0pRZzdZU3c2Nis0NjRTUTdKZVE3SVNjSUdOc1lYVmtaU0F0TFhabGNuTnBiMjRnN0oyMElPdVFtT3VLbE95bmdDRHRtWlhzbmJqdGxiUWc3S084N0lTNDdKcVVMaWNzQ2lBZ0lDQWdJQ0FnSUNCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuTEFvZ0lDQWdJQ0FnSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUM4dklPeW5oTzJXaVNEc3BKSHNuYmpyamJBZzY1aVFJT3VJak91Z2dPdUxwQ0RpZ0pRZzdKdVE3TG1aN0oyQUlDTHJ1SXpybmJ6c21yRHNvSURyb1p3ZzY0dWs3SXVjSU95WHRPcTRzQ0xyaTZRdUlPMkVzT3V2dU91RWtPeWRnQ0FxS3V5d3ZleWRoQ0RzbFlUcnJMVHENCnNvUHJqNFFnNjZxN0lPdWRoT3lib095ZGhDRHJsWXpycDR3cUtpNEtJQ0FnSUNBZ0x5OGc3SmlJN0tDRTdKZVVJQ2MyTU95MGlDRHJoSmpxc293ZzY0eUE2cml3SU95a2tleWR0T3VwdENEdGhMRHJyN2pyaEpBbjdKMjA3SmVJNjRxVTY0MndMQ0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA3SjJFSU95ZHZlcXhzT3VDbUNEc25xRHF1WkFnNjVTMElPeWR2Q0R0bFpqcmk2UWc2NHVrN0l1Y0lPdUloT3VsdUFvZ0lDQWdJQ0F2THlEc29KWHNnNEhzb0lIc25iZ2c2cks5N0pxdzdKZVE2NCtFSUdOdFpDRHNzTDNzbmJRZzdZcUE3SmEwNjRLWTdKbVU2NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Eb2dJdTJFc091dnVPdUVrQ0R0bVpUcnFiVHNuWUFnN0ptY0lPdVdvQ0Rxc0pIc25wRHF1TEFpS1M0S0lDQWdJQ0FnTHk4ZzdKMjA3S0NjSU95YXNPdW1yT3F3Z0NEc3NMM3NuWVFnN0tlQjdLQ1JJT3lYdE9xem9DRHNoTEhxczdVZzdKZXM2N2FBS0d4dloybHVWMmx1Wkc5M1QzQmxibVZrS2V1bHZDRHNsWVRyDQppNGpxdVl3c0lPeUxuT3F3aE95ZHRDRHNsWVRyaTRqcm5id2c2cmU0SU95Q3JPeUxwT3VobkNEdGpKRHJpNmp0bFp6cmk2UXVDaUFnSUNBZ0lHTnZibk4wSUhOMFlXeGxJRDBnYkc5bmFXNVFjbTlqSUNZbUlDRnNiMmRwYmxkcGJtUnZkMDl3Wlc1bFpDQW1KaUFvUkdGMFpTNXViM2NvS1NBdElHeHZaMmx1VTNSaGNuUmxaRUYwSUQ0Z01qQXdNREFwT3dvZ0lDQWdJQ0JwWmlBb2JHOW5hVzVRY205aklDWW1JSE4wWVd4bEtTQjdDaUFnSUNBZ0lDQWdhMmxzYkV4dloybHVVSEp2WXlncE93b2dJQ0FnSUNBZ0lHbG1JQ2doYjNCbGJreHZaMmx1VkdWeWJXbHVZV3dvS1NrZ2V3b2dJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNREVzSUhzZ1pYSnliM0k2SUNmc25iUWdUMVBzbDVEc2hLQWc3SjZRNjQrWjdKeTg2NkdjSU91cXV5RHNsN1RzbHJUc21wUWc0b0NVSU8yRXNPdXZ1T3VFa095WGtPeUVuQ0JqYkdGMVpHVWc3SXVrN1phSklPMmJoQ0F2Ykc5bmFXNGc3WlcwSU95anZPeUV1T3lhbEM0bg0KSUgwcE93b2dJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ0lDQXZMeURzblpqcmo0VHNvSUVnN0tLRjY2T01LSEpsWVhOdmJpRHNwNERzb0pVcElPS0FsQ0RzcDRUdGxva2c3S1NSSU8yRXRPeWRoQ0JUUlZOVFNVOU9YMFJKUlVUcm9ad2c2NEdkNjRLMDY2bTBJT3lla091UG1TRHNucXpzaTV6cmo0VHFzSUFnN0ppYklPcXpoT3lnbFNEc2hManNoWmpzbllRZzY1Q1k3SUswNjZhdzY0dWtDaUFnSUNBZ0lDQWdhMmxzYkZCeWIyTW9KK3Vobk9xM3VPeWR1T3lkaENEc3A0VHRsb250bFpqcmlwUWc3S1NSN0oyMDY1MjhJT3lhbE95eXJleWRoQ0RzcEpIcmk2anRsb2pzbHJUc21wUWc0b0NVSU91aG5PcTN1T3lkdUNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeWs3Q2lBZ0lDQWdJQ0FnWVdOamIzVnVkRU5oWTJobExtRjBJRDBnTURzS0lDQWdJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJTzJQdE91d3NTRGlnSlFnN1lTdzY2KzQ2NFNRSU91d3FleUwNCm5leWN2T3VobkNEc29JVHRtWmd1SnlrN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUcxdlpHVTZJQ2QwWlhKdGFXNWhiQ2NnZlNrN0NpQWdJQ0FnSUgwS0lDQWdJQ0FnTHk4ZzY3Q3A2cmlJSU95TG5PeWVrZTJWbkNEcm9aenF0N2pzbmJqc25iUWc3SUswN0pXRUlPeWVpT3ljdk91cHRDRHNocERyaklEc3A0QWc3SldLNjRxVTY0dWtJT0tBbENEc283M3NuYlRycWJRZzdJS3M3SnFwN0o2UTZyQ0FJT3V6dE9xem9DRHNub2pyaXBRZzdZT3Q3SjJZSU95OW5PdXdzU0R0ajZ6dGlyanFzSUFLSUNBZ0lDQWdMeThnNjR1cjdaaUFJQ0pzYjJOaGJHaHZjM1RzbDVEc2hKd2c3SmV3NnJLdzdKMkVJT3F4c091MmdPMldpT3lLdGV1TGlPdUxwQ0xxc0lBZzY1eXM2NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Da3VDaUFnSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk1nSmlZZ1JHRjBaUzV1YjNjb0tTQXRJR3h2WjJsdVUzUmhjblJsWkVGMElEd2dNVFV3DQpNREFwSUhzS0lDQWdJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJT3l3dmV5ZHRDRHNuYlRycjdnZzdKZTA2NkNrSU95ZWlPeVd0T3lhbENEaWdKUWc3SU9JNjZHY0lPeVh0T3luZ0NEc2xZcnFzNkFnNnJlNElPeXd2ZXlkaENEc2s3RHNoTGpzbXBRdUp5azdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHMXZaR1U2SUNkaGJISmxZV1I1TFc5d1pXNG5JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc2dMeThnN0pXZTdJU2dJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqc25iUWc2NHlBNnJpd0lPeWtrZXlkdE91cHRDRHNvSkhxczZBZzdJT0k2NkdjSU95WHNPdUxwQ0FvN0xDOTdKMkVJT3VMcSt5Vm1PcXhzT3VDbUNEcmk2VHNpNXdnNjRpRTY2VzRJT3F5dmV5YXNDa0tJQ0FnSUNBZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNCcw0KYjJkcGJsZHBibVJ2ZDA5d1pXNWxaQ0E5SUdaaGJITmxPeUF2THlEc25iVHJzb2dnN0l1YzY0K0U3SjJZSU95d3ZTRHNsN1RxdUxBZzdJU3g2ck8xSU95WHJPdTJnQ0RpZ0pRZzdKV0U2NTZZN0plUTdJU2NJT3lFdU95YXRPdUxwQW9nSUNBZ0lDQXZMeUJDVWs5WFUwVlM2NHFVSU9xeHRPdVRuT3Vtck95bmdDRHNsWXJyaXBUcmk2UWc0b0NVSUVOTVNlcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNjZXOElPeVh0T3F6b0NCc2IyTmhiR2h2YzNUcm9ad2c2ckt3NnJPODY2VzhJT3lla091UG1TRHNpSmpyb0xudGxaenJpNlFLSUNBZ0lDQWdMeThnS095Y2hDQW42NkdjNnJlNDdKMjQ3SjJBSUVOTVNlcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNjZXOElPeW5nZXlna1NEc2w3VHFzb3dnN1pXYzY0dWtKeURzbzd6c2hKMGc0b0NVSU9xd2dPdWhuT3l4aE91cHRDRHN2WlRyazV3ZzY3YVo3SmVzNjRTajZyaXdJTzJabE91cHRPeWR0Q0Rybkt6cmk2UXBMZ29nSUNBZ0lDQXZMeUFxS3VxemhPeWcNCmxTRHNvSVR0bVpqc25ZQWc3SnU1SU91aG5PcTN1T3lWaE95YmcreWRoQ0RycUx6c29JQWc3SmV3NjR1a0tpb29NakF5Tmkwd09Dd2dRbEpKUkVkRlgxWTlNekVwT2lEcnVJenJuYnpzbXJEc29JRHNsNUFnN0lTNDdJV1k3SjIwSU91Q3FPeVZoQ0Rzbm9qc25MenJxYlFLSUNBZ0lDQWdMeThnWVhWMGFHOXlhWHBsNnJDQUlPcXpoT3lnbGV5ZGhDRHJyTHZzcDRBZzdKV0s2ck9nSU95S3VleWR1Q0R0bVpUcnFiVHJwNHdnNjUyRTdKcTA2NHVrS0NMc2lybnNuYmdnN1ptVTY2bTBJT3Vua09xem9DRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKeTg2NkdjSU9xd2dPcXpvQ0RzaTdicmk2UWlJT3lhbE9xMXJDa3VDaUFnSUNBZ0lDOHZJT3lFdU95Rm1PeWRoQ0RzcDREc21yUWc2NUtrSU95WHRPdXB0Q0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA2N2FBN1lTd0lPdUNtT3lZcU91THBDRGlnSlFnVlZKTTdKMkVJT3F3Z09xenRlMlZtT3luZ091UGhDanNzclRzbmJUcmk1MGc3SXVrN1l5b0tTd2dRbEpQVjFORlV1dWx2Q0RxDQpzSURyb1p6c3NZVHNwNERyajRRS0lDQWdJQ0FnTHk4Z0tPeTlsT3VUbkNEcnRwbnNsNnpyaEtQcXVMQWc3SnlnNjdDY0tTd2c2N2lNNjUyODdKcXc3S0NBNjZXOElPcXpvT3VsdE95bmdPdVBoQ2pxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBSU95VmhPdUxtQ2tnN0pXSzY0cVVJT3ljb095ZHZPMlZuQ0Ryc0tucnNwVXVDaUFnSUNBZ0lDOHZJT3UyZ095ZWtleWFxVG9nNjdpTTY1Mjg3SnF3N0tDQTdKMllJR05zWVhWa1pTRHNtN2tnNjZHYzZyZTQ3SjI0NjQrRUlPMlNnT3Vtc091THBDRGlnSlFnNnJPRTdLQ1Y3SjJFSU91d2xPcSt1T3VncE91S2xDRHNuWmpyajRUc21ZQWc2N0NwN1phbDdKMjBJT3F3bWV5VmhDRHNpSmpzbXFrdUNpQWdJQ0FnSUdOdmJuTjBJSE4wWVhKMFRHOW5hVzRnUFNBb0tTQTlQaUI3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdkR2hwYzB4dloybHVJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuWVhWMGFDY3NJQ2RzYjJkcGJpY3NJQ2N0TFdOc1lYVmtaV0ZwSjEwc0lIc0tJQ0FnSUNBZw0KSUNBZ0lITm9aV3hzT2lCMGNuVmxMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWXNJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVXNDaUFnSUNBZ0lDQWdJQ0JrWlhSaFkyaGxaRG9nY0hKdlkyVnpjeTV3YkdGMFptOXliU0FoUFQwZ0ozZHBiak15Snl3Z0x5OGdhMmxzYkV4dloybHVVSEp2WSt5ZG1DRHF0N2pybzdrZ2EybHNiT3lhcVNBb2EybHNiRkJ5YjJQcXM3d2c2NCtaN0oyOElPMk1xTzJFdENrS0lDQWdJQ0FnSUNCOUtUc0tJQ0FnSUNBZ0lDQnNiMmRwYmxCeWIyTWdQU0IwYUdselRHOW5hVzQ3Q2lBZ0lDQWdJQ0FnYkc5bmFXNVhhVzVrYjNkUGNHVnVaV1FnUFNCMGNuVmxPeUF2THlCRFRFbnFzSUFnN0plczY0cVVJT3F4dENEcXRJRHNzTER0bGFBZzdJaVlJT3lYaHV5Y3ZPdUxpQ0RzbDdUcnByQWc2cktEN0p5ODY2R2NJT3V6dU91THBDQW83SjZzN1lHMDY2YXQ3SmVRSU8yRXNPdXZ1T3VFa0NEcnNLbnNwNEFwQ2lBZ0lDQWdJQ0FnZEdocGMweHZaMmx1TG05dUtDZGwNCmNuSnZjaWNzSUNncElEMCtJSHNnYVdZZ0tHeHZaMmx1VUhKdll5QTlQVDBnZEdocGMweHZaMmx1S1NCc2IyZHBibEJ5YjJNZ1BTQnVkV3hzT3lCOUtUc0tJQ0FnSUNBZ0lDQjBhR2x6VEc5bmFXNHViMjRvSjJOc2IzTmxKeXdnS0dOdlpHVXBJRDArSUhzS0lDQWdJQ0FnSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk1nSVQwOUlIUm9hWE5NYjJkcGJpa2djbVYwZFhKdU93b2dJQ0FnSUNBZ0lDQWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc0tJQ0FnSUNBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJOVWFXMWxjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9iRzluYVc1UWNtOWpWR2x0WlhJcE95QnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlHNTFiR3c3SUgwS0lDQWdJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdJQzh2SU95RGlDRHFzNFRzb0pYc25id2c3SWlZSU95ZWlPeWN2T3VMaUNEcmk2VHNuWXdnTDJobFlXeDBhQ0RybFl3ZzY0dWs3SXVjSU95ZHZlcTRzQW9nSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzDQpiMmNvSjF0aWNtbGtaMlZkSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25iZ2c3S0NJN0xDb0lPeWloZXVqakNBb1kyOWtaU0FuSUNzZ1kyOWtaU0FySUNjcEp5azdDaUFnSUNBZ0lDQWdJQ0F2THlEc2dxenJub3pzbmJRZzY2R2M2cmU0N0oyNDdaV2dJT3lMbk9xd2hPdVBoQ0RzbDRic25iUWc2ck9uNjdDVTY2R2NJT3lMcE8yTXFPdWhuQ0RyZ1ozcmdxenJpNlFnUFNCamJHRjFaR1hxc0lBZzdKZUc2ckd3NjRLWUlPeUxwTzJXaWV5ZHRDRHNsWWdnNjVDY0lPcXlneTRLSUNBZ0lDQWdJQ0FnSUM4dklPeWRrZXVMdGV5ZGdDRHNuYlRycjdnZzY3TzA2NE9JN0p5ODY0dUlJT3lEZ2UyRG5PdWx2Q0RyaTZUc2k1d2c3SjZzN0lTY0lDOW9aV0ZzZEdqcm9ad2c3SldNNjZhdzY0dWtJQ2p0bEl6cm42enF0N2pzbmJqc25iUWc2NHlBNnJpd0lPMlpsT3VwdE95ZGhDRHNpNlR0aktqcm9ad2c2N0NVNnI2ODY0dWtLUzRLSUNBZ0lDQWdJQ0FnSUdsbUlDaGpiMlJsSUNFOVBTQXdJQ1ltSUVSaGRHVXVibTkzS0NrZw0KTFNCc2IyZHBibE4wWVhKMFpXUkJkQ0E4SURVd01EQXBJSHNLSUNBZ0lDQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1T3lkdENEc3BvbnNpNXdnN0l1azdZeW82NkdjSU91Qm5ldUNxQ0RpZ0pRZ1EyeGhkV1JsSUVOdlpHVWc3SVNrN0xtWUlPeURnZTJEbk91bHZDRHJpNlRzaTV3ZzdLQ1E2cktBN1pXcDY0dUk2NHVrTGljcE93b2dJQ0FnSUNBZ0lDQWdJQ0JqYUdWamEwTnNZWFZrWlVGMllXbHNZV0pzWlNncE93b2dJQ0FnSUNBZ0lDQWdmUW9nSUNBZ0lDQWdJSDBwT3dvZ0lDQWdJQ0FnSUM4dklETXc2N2FFSU9LQWxDRHNuYlFnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lqdmV5Y3ZPdXB0Q0RydUl6cm5ienNtckRzb0lBZzdMMmM2N0N4N0oyMElPcXdpQ0JzYjJOaGJHaHZjM1FnN1krczdZcTQ2NCtFSU91THErMllnQ0FuN0pldzZyS3c3SjJFSU9xeHNPdTJnTzJXaU95S3RldUxpT3VMcENmcXNJQWc2NXlzNjR1a0xnb2dJQ0FnSUNBZ0lDOHZJT3lZaU95Z2hDQXgNCk1PdTJoT3lkZ0NEc3A2ZnNsWVRzaEp3c0lPdWhuT3EzdU95ZHVPMlZtT3VMcENEc25xRHF1WkFnNjR1azY2VzRJT3lkdk95ZGhDRHRsWmpycWJRZzdZT3Q3SjIwSU91c3RPMmFxT3F3Z0NEcmtKRHJpNlFvTWpBeU5pMHdPQ0RzaTZUc3VLRWc3SXVnNnJPZ0tTNEtJQ0FnSUNBZ0lDQnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V5QmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SURNdzY3YUVJT3F5dmVxenZDRGlnSlFnNjR5QTZyaXdJTzJVaE91aG5PeUV1T3lLcENEc29KWHJwcXd1SnlrN0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzZ2ZTd2dNVGd3TURBd01DazdDaUFnSUNBZ0lIMDdDaUFnSUNBZ0lDOHZJQ29xNnJPRTdLQ1ZJT3lnaE8yWm1DQTlJT3Vobk9xM3VPeVZoT3liZ3lBcklPdTRqT3Vkdk95YXNPeWdnT3lYa0NEcm9aenF0N2pzbmJnZzdabVU2Nm0wS2lvZ0tESXdNall0TURnc0lFSlNTVVJIUlY5V1BUTTJMQ0RzZ3F6c21xbnNucEFnDQo2ckt3N0tDVktTNEtJQ0FnSUNBZ0x5OGc3SXE1N0oyNElPMlpsT3VwdE95ZHRDRHJuS2pyaXBRZzZyZTg2N080SU95YmtPeWR1T3lkZ0NBaTY3aU02NTI4N0pxdzdLQ0E3SmVRSU95WW15RHFzNFRzb0pYc25iUWc2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPdUxwQ0xyaXBRZzZyS0Q3SjIwNjYrQTY2R2NMQ0Rzb0lUdG1aanNuWmdnN0xLcklPdVBtZXlla2V5ZGdBb2dJQ0FnSUNBdkx5RHJvWnpxdDdqc25ianNuYlFnN0pXRTY0dUk2NTI4SUNvcTY2R2M2cmU0N0pXRTdKdURLaXJzbmJUc2xyVHNsYndnNjZlZTY0dWtMaURxdDdqcm5wanNoSndnN0plczZyaXc3SVNjNjRxVUlPdWhuT3EzdU95ZHVPeWRoQ0RzaTV6c25wSHRsWmpzcDRBZzdKV0s2NHFVNjR1a09nb2dJQ0FnSUNBdkx5QWdJT0tSb0NCRFRFa2c2NkdjNnJlNDdKV0U3SnVES0dOc1lYVmtaU0JoZFhSb0lHeHZaMjkxZENrZzRvQ1VJT3lZbXlEc25wRHFzcW5zcHAzcnFvWEN0K3lFdU95Rm1DRHRqNURxdUxBS0lDQWdJQ0FnTHk4Z0lDRGlrYUVnNjdpTQ0KNjUyODdKcXc3S0NBSU95YnVTRHJvWnpxdDdqc2xZVHNtNE1nN0plMDZyaXdJT0tBbENCamJHRjFaR1V1WVdrdmJHOW5iM1YwN0oyQUlPdWhuT3EzdU95VmhPeWJneUR0bTRRZ0tpcnJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKeTg2NkdjSU95d3FleW5nQ29xN1pXYzY0dWtLTzJEclNBeDZyQ2NLUW9nSUNBZ0lDQXZMeURyb1p6cXQ3anNsWVRzbTRQc25iUWc2NEdkNjRLWTY2bTBJT3F6cCt1d2xPdWhuQ0JEVEVrZzY2R2M2cmU0N0oyNDZybU03S2VBSU95ZHRPeVd0T3lFbkNEc2k1enNucEh0bFp6cmk2UWc0b0NVSU95RXVPeUZtT3lkdENEcnVZVHNtNHpzcDRRZzY1S2s2NTI4SU95S3VleWR1Q0R0bVpUcnFiVHNuYlFnN0pXRTY0dUk2NTI4Q2lBZ0lDQWdJQzh2SU91aG5PcTN1T3lkdUNEdG1aVHJxYlRzbmJRZzY0S1k3SmlvNjR1a0xpRHRnYlRycHEwZzdaV2NJT3V5aU95Y3ZPdWhuQ0FpNjZHYzZyZTQ3SldFN0p1RElPS0draURzZzRnZzZyT0U3S0NWSU91aG5PcTN1T3lkdUNMc25iUWc2NEdkNjRLYzY0dWsNCkxnb2dJQ0FnSUNCcFppQW9jM2RwZEdOb1RXOWtaU2tnZXdvZ0lDQWdJQ0FnSUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNnTHk4ZzY0eUE2cml3SU95a2tleWR1Q0RzbUpzZzY2R2M2cmU0N0oyNElPeWdpT3l3cU9xd2dDRHNub2pzbkx6cnFiUWc3S0NSNjRxVTY0dWtDaUFnSUNBZ0lDQWdZMjl1YzNRZ2JHOGdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjI5MWRDZGRMQ0I3SUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUVOTVFWVkVSVjlGVGxZc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbElIMHBPd29nSUNBZ0lDQWdJR3h2TG05dUtDZGxjbkp2Y2ljc0lDZ3BJRDArSUhzZ0x5b2dZMnhoZFdSbElPeVhodXlkakNEcms3RWc0b0NVSU95VmhPdWVtQ0RzbTdrZzY2R2M2cmU0N0pXRTdKdUQ3SjJBSU9xM3VPdU1nT3VobkNEc3A0VHRsb2tnS2k4Z2ZTazdDaUFnSUNBZ0lDQWdMeThnS2lydGc2M3NuWUFnNjdDWTY1T2M3SXVjSURIcXNKd3FLaUFvTWpBeU5pMHdPQ3dnUWxKSlJFZEZYMVk5DQpOREFzSU95Q3JPeWFxZXlla0NEc21wVHF0YXdwT2lEc203a2c2NkdjNnJlNDdKV0U3SnVESU95anZPeUdqT3VsdkNEcmxMRHJvWndnN0plMDY2bTBDaUFnSUNBZ0lDQWdMeThnNjZHYzZyZTQ3SjI0SU8yWmxPdXB0T3lkdENEcmtaQWc2ckNjS091aG5PcTN1T3lWaE95Ymd5RHNzS25zcDRBZzdabVU2Nm0wSUNzZ1QwRjFkR2dnN1ptVTY2bTBLU0RybHFEc2hKd2c3SmEwNjRxUUlPeXF2ZXlYa0NEcm9aenF0N2pzbmJqdGxiVHNsYndnN1pXWTY0cVU3S2VBSU95VmpDRHNpSmdnN0plRzZyT2dMQW9nSUNBZ0lDQWdJQzh2SU95WGlldWFzZTJWbkNEc3FyM3NsNUFnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJTzJVak91ZnJPcTN1T3lkdU95ZGdDRHNsN0Rxc3JEcmtKanNwNEFnN0pXSzY0cVU2NHVrS095THBPeTRvU0RzaTZEcXM2QWdNdTJhakRvZ0l1eVpuQ0Rya1pBZzZyQ2M2NEtZSU91V29DSXNJQ0xyb1p6cXQ3anNuYmp0bG9qcmlwVHJqYkFnN0ptY0lpa3VDaUFnSUNBZ0lDQWdMeThnNnJlNDY1Nlk3SVNjSU95Yg0KdVNEcm9aenF0N2pzbFlUc200UHNuWUFnN0plMDdLZUFJT3lWaXV1S2xPdUxwQ0RpZ0pRZ1EweEpJT3Vobk9xM3VPeVZoT3liZyt1bmpDRHRsWmpxczZBZzY2R2M2cmU0N0oyNElPeXd2U0R0bFpqcmdwanJwNHdnNjUyRTdKcTA2NHVrTGdvZ0lDQWdJQ0FnSUM4dklDQWd3cmNnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJT3Vobk9xM3VPeVZoT3liZyt1UHZDRHNub2pzbkx6cnFiUWc0b2FTSU91aG5PcTN1T3lkdUNEdG1aVHJxYlRzbmJRZzY3Q1U2NkdjSU91Q21PeVlxT3VMcEFvZ0lDQWdJQ0FnSUM4dklDQWd3cmNnNjdpTTY1Mjg3SnF3N0tDQTdKZVFJT3lFdU95Rm1PeWR0Q0RyZ3Fqc2xZUWc3SjZJN0p5ODY2bTBJT0tHa2lEc2lybnNuYmdnN1ptVTY2bTA3SjIwSU91Q21PeVlxT3VMcEM0ZzZyZTRJTzJabE91cHRDRHRsWmpyaTZnZ1crcXpoT3lnbFNEc29JVHRtWmhkN0p5ODY2R2NJT3F6aE95Z2xleWRoQ0RxczZEcnBianJpNlFLSUNBZ0lDQWdJQ0F2THlBZ0lDQWdLT3lLdWV5ZHVDRHRtWlRycWJUc25ZUWcNCjZyRzA2NFNJNjV1dzY2Q2s2Nm0wSU91NGpPdWR2T3lhc095Z2dPeVhrT3lFbkNCamJHRjFaR1VnNjZHYzZyZTQ3SldFN0p1RDdKMkVJT3Vvdk95Z2dDRHRsYlRzbGJ3ZzdaV1k2NHFVNjQyd0xDRHF0N2pxc2JRZzdZT3Q3SjIwSU8yVm1PdUNtQ0RyalpRZzdaV0U3SnFVN1pXWTY0dWtLUW9nSUNBZ0lDQWdJQzh2SU91aG5PcTN1T3lkdU95ZGdDQXFLdXVobk9xM3VPeVZoT3liZyt5ZHRDRHJnWjNyZ3B3ZzY1S2tLaW9nN0l1YzdKNlI3WldjNjR1a0lPS0FsQ0RycUx6c29JQWc2NTJFN0pxdzY2bTBJT3Vobk9xM3VPeVZoT3liZyt5ZHRDRHNnNGdnN0o2UTZyS3A3S2FkNjZxRjdKMkVJT3luZ095YXVDRHNpSmdnN0o2STY0dWtMZ29nSUNBZ0lDQWdJR3h2TG05dUtDZGpiRzl6WlNjc0lDaGpiMlJsS1NBOVBpQjdDaUFnSUNBZ0lDQWdJQ0JyYVd4c1VISnZZeWduNnJPRTdLQ1Y3SjJFSU91d2xPcSt1T3VncE9xem9DRHJvWnpxdDdqc2xZVHNtNFB0bGJUc2hKd2c3SnFVN0xLdDdKMkVJT3lra2V1THFPMldpT3lXDQp0T3lhbEM0bktUc2dMeThnN0oyWTY0K0U3S0NCSU95aWhldWpqQ0FvN0o2UTY0K1pJT3llck95TG5PdVBoQ0Ryc0tuc3A0QXBDaUFnSUNBZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQU0F3T3lBdkx5RHJpNlRzbll3ZzdLR3c3WnFNN0plUTdJU2NJQ2ZxczRUc29KVWc3SmVHN0oyTUoreWN2T3VobkNEc25iM3Rub2pxc293S0lDQWdJQ0FnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUc1MWJHdzdJQzh2SU95RGdlMkRuQ0RzbnF6dGpKRHNvSlVLSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDQkRURWtnNjZHYzZyZTQ3SldFN0p1RElDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a2c0b2FTSU91aG5PcTN1T3lkdUNEc3NMM3NuWVFnN0plOTY0dUk2NHVrTGljcE93b2dJQ0FnSUNBZ0lDQWdhV1lnS0NGc2IyZHBibEJ5YjJNcElITjBZWEowVEc5bmFXNG9LVHNLSUNBZ0lDQWdJQ0I5S1RzS0lDQWdJQ0FnSUNCc2IyZHBibE4wWVhKMA0KWldSQmRDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJRzF2WkdVNklDZGljbTkzYzJWeUxYTjNhWFJqYUNjZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ0x5OGc2NmVNNjZPTUlPeWVyT3Vobk9xM3VPeWR1Q0RpZ0pRZzZyQ1o3SjJBSU9xemhPeWdsZXlkdE91ZHZDRHNoTGpzaFpqc25ZUWc3S2VBN0pxdzdLZUFJT3lWaXVxem9DRHF0N2pyaklEcm9ad2c3SmV3NjR1a0tPdTVvT3VsdE91THBDa0tJQ0FnSUNBZ2MzUmhjblJNYjJkcGJpZ3BPd29nSUNBZ0lDQXZMeURyZ3FIc25ZQWc3SjZGN0o2bDZyYU03SjJFSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NHlBNnJpd0lPeUV1T3lGbU95ZGdDRHJzb1RycHJEcmk2UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzZzRnZzdJUzQ3SVdZS095RGlDRHNub1hzbnFYcXRvd3A3Snk4NjZHY0lPeUxuT3lla2UyVm1PcXlqQzRLSUNBZ0lDQWcNCkx5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDaHlaV0Z6YjI0ZzdLZUE3S0NWS1NEaWdKUWdVMFZUVTBsUFRsOUVTVVZFNjZHY0lPdUJuZXVDdE91cHRDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3VncEFvZ0lDQWdJQ0F2THlEc25xenJvWnpxdDdqc25iZ2c2NUtrN0plUTY0K0VJRTFCV0Y5VVZWSk9VK3E1ak95bmdDRHNtSnNnNnJPRTdLQ1Y3Snk4NjZHY0lPeXltT3Vtck91UW1PdUtsQ0Ryc29UcXQ3anFzSUFnNjVDYzY0dWtJQ2d5TURJMkxUQTNJT3Vtck91M3NPeVhrT3lFbkNEdG1aWHNuYmdwQ2lBZ0lDQWdJR3RwYkd4UWNtOWpLQ2Zyb1p6cXQ3anNuYmpzbllRZzdLZUU3WmFKN1pXWTY0cVVJT3lra2V5ZHRPdWR2Q0RzbXBUc3NxM3NuWVFnN0tTUjY0dW83WmFJN0phMDdKcVVJT0tBbENEcm9aenF0N2pzbmJnZzdadUVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMaWNwT3dvZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqDQphR1V1WVhRZ1BTQXdPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFbklDc2dLSE4zYVhSamFFMXZaR1VnUHlBbklDanFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDRHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPdWNxT3VwdENEcXQ3Z2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjNzbkx6cm9ad2c2NHVrNjZXNElPcXpoT3lnbGV5ZGhDRHFzNkRycGJ3ZzdJaVlJT3llaU95V3RPeWFsQ2tuSURvZ0p5Y3BJQ3NnSnlEaWdKUWc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeWVrT3VQbVNEc2w3RHFzckRya0tucmk0anJpNlF1SnlrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQnpkMmwwWTJoTmIyUmxJRDhnSjJKeWIzZHpaWEl0YzNkcGRHTm9KeUE2SUNkaWNtOTNjMlZ5SnlCOUtUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUNBZw0KY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2daWEp5YjNJNklDZnJvWnpxdDdqc25iZ2c3TEM5N0oyRUlPdXF1eURzbDdUc2w0anNsclRzbXBRNklDY2dLeUJsTG0xbGMzTmhaMlVnZlNrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SUNqdGhMRHJyN2pyaEpBZzdZKzA2N0N4SU9xMXJPMlloT3UyZ0NEaWdKUWc2N2lNNjUyODdKcXc3S0NBSU95ZWtPdVBtU0RzbVlUcm80enFzSUFnN0pXSUlPdVFtT3VLbENEdG1aanFzcjBnN0tDRTdKcXBLUW9nSUdaMWJtTjBhVzl1SUc5d1pXNU1iMmRwYmxSbGNtMXBibUZzS0NrZ2V3b2dJQ0FnZXdvZ0lDQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ0lDQWdJQzh2SUhOMFlYSjA2ckNBSU95RGlDRHN2WmpzaHBRZzdMQzk3SjJFSU91bmpPdVRvT3VMcENBbzY0dWs2NmFzN0oyWUlPeUlxT3lkZ0NEc3ZaanNocFRxczd3ZzY2eTA2clNBN1pXWTZyS01JT3lDck95YXFleWVrT3lYa09xeWpDRHJzN1Rzbm9RcExnb2cNCklDQWdJQ0FnSUM4dklPeWR0T3lXdE95RW5DQlFiM2RsY2xOb1pXeHNLQzV3Y3pFcDdKMjBJRFhzdElnZzY1S2tJT3EzdUNEc3NMM3NsNUFnN0plVTdZU3c2Nlc4SU91enRPdUN0Q0F4NjdLSUtPcTFyT3VQaFNEcXM0VHNvSlVwN0oyRUlPeWVrT3VQbVNEc2hLRHRnNTN0bFpqcXM2QXNDaUFnSUNBZ0lDQWdMeThnN0xDOTdKMkVJT3kxbk95R2pPMlpsTzJWdENEc2dxenNtcW5zbnBBZzY0aUk3SmVVSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianJwNHdnNjRLbzZyS01JTzJWbk91THBDNGc3TEM5N0oyRUlPdXF1eURzc0w3c25MenJxYlFnN0pXRTY2eTA2cktENjQrRUlPeVZpQ0R0bFp6cmk2UUtJQ0FnSUNBZ0lDQXZMeUFvNjR1azY2VzRJT3l3dlNEc21LVHNub1hyb0tVZzY3Q3A3S2VBSU9LQWxDRHF0N2dnNnJLOTdKcXdJT3VwbE91SnRPcXdnQ0RyczdUc25iVHJpcFFnN0xHRTY2R2NJT3VDcU9xem9DRHNncXpzbXFuc25wRHFzSUFnN0plVTdZU3dJTzJWbkNEcnNvZ2c2NGlFNjZXMDY2bTBJT3VRDQpxQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdLTzg3SjJZT2lCamJHRjFaR1hxc0lBZzdMMlk3SWFVSU95Z25PdXFxZXlkaENEcnNKVHF2cmpycWJRZ1FYQndRV04wYVhaaGRHVXZSbWx1WkZkcGJtUnZkK3F3Z0NEcnFyc2c3TEMrN0oyRUlPeUltQ0Rzbm9qc25Zd2c0b0NVSU95Y2lPdVBoT3lhc0NEc2k2VHF1TERzbDVEc2hKd2c3Wm1WN0oyNElPMlZoT3lhbEM0S0lDQWdJQ0FnSUNCamIyNXpkQ0J3Y3pFZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV3h2WjJsdUxuQnpNU2NwT3dvZ0lDQWdJQ0FnSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vY0hNeExDQmJDaUFnSUNBZ0lDQWdJQ0FuVTNSaGNuUXRVMnhsWlhBZ0xWTmxZMjl1WkhNZ05TY3NDaUFnSUNBZ0lDQWdJQ0FuSkhkeklEMGdUbVYzTFU5aWFtVmpkQ0F0UTI5dFQySnFaV04wSUZkVFkzSnBjSFF1VTJobGJHd25MQW9nSUNBZ0lDQWdJQ0FnSW1sbUlDZ2tkM011UVhCd1FXTjBhWFpoZEdVb0oyTnNZWFZrWlMxcw0KYjJkcGJpY3BLU0I3SWl3S0lDQWdJQ0FnSUNBZ0lDSWdJQ1IzY3k1VFpXNWtTMlY1Y3lnbmZpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lGTjBZWEowTFZOc1pXVndJQzFUWldOdmJtUnpJREluTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdRV1JrTFZSNWNHVWdMVTVoYldWemNHRmpaU0JWSUMxT1lXMWxJRmNnTFUxbGJXSmxja1JsWm1sdWFYUnBiMjRnSjF0RWJHeEpiWEJ2Y25Rb1hDSjFjMlZ5TXpJdVpHeHNYQ0lwWFNCd2RXSnNhV01nYzNSaGRHbGpJR1Y0ZEdWeWJpQlRlWE4wWlcwdVNXNTBVSFJ5SUVacGJtUlhhVzVrYjNjb2MzUnlhVzVuSUdNc0lITjBjbWx1WnlCMEtUc2dXMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUdKdmIyd2dVMmh2ZDFkcGJtUnZkeWhUZVhOMFpXMHVTVzUwVUhSeUlHZ3NJR2x1ZENCdUtUc25JaXdLSUNBZ0lDQWdJQ0FnSUNJZ0lDUm9JRDBnVzFVdVYxMDZPa1pwYm1SWGFXNWtiM2NvVzA1MWJHeFRkSEpwYm1kZE9qcFcNCllXeDFaU3dnSjJOc1lYVmtaUzFzYjJkcGJpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lHbG1JQ2drYUNBdGJtVWdXMU41YzNSbGJTNUpiblJRZEhKZE9qcGFaWEp2S1NCN0lGdDJiMmxrWFZ0VkxsZGRPanBUYUc5M1YybHVaRzkzS0NSb0xDQTJLU0I5Snl3Z0x5OGdOaUE5SUZOWFgwMUpUa2xOU1ZwRkNpQWdJQ0FnSUNBZ0lDQW5mU2NzQ2lBZ0lDQWdJQ0FnWFM1cWIybHVLQ2RjY2x4dUp5a2dLeUFuWEhKY2JpY3BPd29nSUNBZ0lDQWdJR052Ym5OMElHSmhkQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdGJHOW5hVzR1WW1GMEp5azdDaUFnSUNBZ0lDQWdabk11ZDNKcGRHVkdhV3hsVTNsdVl5aGlZWFFzSUNkQVpXTm9ieUJ2Wm1aY2NseHVKeUFyQ2lBZ0lDQWdJQ0FnSUNBbmMzUmhjblFnSW1Oc1lYVmtaUzFzYjJkcGJpSWdZMjFrSUM5cklHTnNZWFZrWlNBdmJHOW5hVzVjY2x4dUp5QXJDaUFnSUNBZ0lDQWdJQ0FuY0c5M1pYSnphR1ZzYkNBdFRtOVFjbTltDQphV3hsSUMxRmVHVmpkWFJwYjI1UWIyeHBZM2tnUW5sd1lYTnpJQzFHYVd4bElDSW5JQ3NnY0hNeElDc2dKeUpjY2x4dUp5azdDaUFnSUNBZ0lDQWdjM0JoZDI0b0oyTnRaQ2NzSUZzbkwyTW5MQ0JpWVhSZExDQjdJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2djM1JrYVc4NklDZHBaMjV2Y21VbkxDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNLSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBblpHRnlkMmx1SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSEIwZVNobGVIQmxZM1FwNjZHY0lPdXp0T3VDdUNEdGdxVHNsNUFnN1lHMDY2R2M2NU9jSUZSVlNlcXdnQ0RyckxUcnNKanNuWkhzbmJnZzZyS0Q3SjIwSU95THBPeTRvU0R0bVpYc25ianJrS2dvTWpBeU5pMHdOeXdnN0oyODY3Q1lJRnh5d3JkcmFYUjBlU0RzdlpUcms1d2c2NnFvNjVHUUtTRGlnSlFLSUNBZ0lDQWdJQ0F2THlEc25LRHNuYnp0bFp3ZzdKNlE2NCtaN1ptVUlPcXl2ZXVobk91S2xDQlRlWE4wWlcwZw0KUlhabGJuUno3SjJZSU95bmhPeW5uQ0R0Z3FRZzdKNkY2NkNsTGlEc29KSHF0N3pzaExFZzZyYU03WldjN0oyMElPeWVpT3ljdk91cHRDQTI3TFNJSU91U3BDRHNsNVR0aExEcXNJQWc3SjZRNjQrWklPeWVoZXVncGV1UHZBb2dJQ0FnSUNBZ0lDOHZJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbmJRZzdJU2c3WU9kNjVDWTZyT2dMQ0RxdG96dGxaenNuYlFnN0plRzdKeTg2Nm0wSUd0bGVYTjBjbTlyWlNEc3BJVHJwNHdnN0tHdzdKcXA3WjZJSU95THBPMk1xTzJWdENEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFuT3VMcENobVlXbHNMWE52Wm5RcExnb2dJQ0FnSUNBZ0lDOHZJT3lYbE8yRXNDRHNwNEhzb0lUc2w1QWdWR1Z5YldsdVlXenNuWVFnNjR1azdJdWNJT3lWbnV5Y3ZPdWhuQ0Rxc0lEc29ManNtWUFnNjR1azY2VzRJT3lWc2V5WGtDRHRncVRxc0lBZzY1T2s3SmEwNnJDQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaUFnSUNBZ0lDQWcNCmMzQmhkMjRvSjI5ellYTmpjbWx3ZENjc0lGc0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWkc4Z2MyTnlhWEIwSUNKamJHRjFaR1VnTDJ4dloybHVJaWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHRmpkR2wyWVhSbEp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZGtaV3hoZVNBMkp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWVdOMGFYWmhkR1VuTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjJSbGJHRjVJREF1TXljc0NpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBbmRHVnNiQ0JoY0hCc2FXTmhkR2x2YmlBaVUzbHpkR1Z0SUVWMlpXNTBjeUlnZEc4Z2EyVjVjM1J5YjJ0bElISmxkSFZ5Ymljc0NpQWdJQ0FnSUNBZ0lDQXZMeURzbDVUdGhMRHFzSUFnN0l1azdLQ2M2NkdjSU91VHBPeVd0T3F3DQpoQ0Rxc3Izc21yRHNsNURycDR3ZzdKZXM2cml3SU91UGhPdUxyQ2pxdG96dGxad2c3SmVHN0p5ODY2bTBJT3ljaE95WGtPeUVuQ0RzcEpIcmk2Z3BJT0tBbENEdGhMRHJyN2pyaEpEc25ZUWc3TG1ZN0p1TUlPdTRqT3Vkdk95YXNPeWdnT3VuakNEcmdxanF1TFRyaTZRS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0F4TGpVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJ6WlhRZ2JXbHVhV0YwZFhKcGVtVmtJRzltSUdaeWIyNTBJSGRwYm1SdmR5QjBieUIwY25WbEp5d0tJQ0FnSUNBZ0lDQmRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdabUZzYzJVN0lDOHZJT3luZ095YmtDRHNsWWdnN1pXWTY0cVVJRTlUQ2lBZ0lDQWdJSDBLSUNBZ0lDQWdjbVYwZFhKdUlIUnlkV1U3Q2lBZ0lDQjlDaUFnZlFvZ0lDOHZJTzJCdE91aG5PdVRuQ0RxczRUcw0Kb0pVZzY2R2M2cmU0N0pXRTdKdURJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3Wm1JN0oyWUlGdnJvWnpxdDdqc2xZVHNtNE5kSU91eWhPMkt2T3lkdENEdG1ManN0cHd1SUdOc1lYVmtaU0JoZFhSb0lHeHZaMjkxZE95Y3ZPdWhuQ0JEVEVrZzY2R2M2cmU0N0oyNDdKMkVJTzJWdE95Z25PMlZuT3VMcEM0S0lDQXZMeUFvN0oyMElGQkQ3SjJZSU95Z2dPeWVwZXVRbkNEc25wRHFzcW5zcHAzcnFvWHNuWVFnN0tlQTdKcTA2NHVrSU9LQWxDRHJpNlRzaTV3ZzdKT3c2NkNrNjZtMElPeWVyT3Vobk9xM3VPeWR1Q0R0bFlUc21wUXVLU0Ryb1p6cXQ3anNsWVRzbTRNZzdadUU3SmVVSU95RXVPeUZtTUszNnJPRTdLQ1Y3THFRN0l1YzY2VzhJT3lnbGV1bXJPMlZuT3VMcEM0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdlkyeGhkV1JsTFd4dloyOTFkQ2NwSUhzS0lDQWdJR052Ym5OMElHeHZJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuWVhWMGFDY3MNCklDZHNiMmR2ZFhRblhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc0tJQ0FnSUd4bGRDQmxjbklnUFNBbkp6c0tJQ0FnSUd4dkxuTjBaR1Z5Y2k1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0lHVnljaUFyUFNCa0xuUnZVM1J5YVc1bktDazdJSDBwT3dvZ0lDQWdiRzh1YjI0b0oyVnljbTl5Snl3Z0tHVXBJRDArSUhzZ2FuTnZiaWh5WlhNc0lEVXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lHVnljbTl5T2lBbjY2R2M2cmU0N0pXRTdKdURJT3lMcE8yV2lTRHNpNlR0aktnNklDY2dLeUJsTG0xbGMzTmhaMlVnZlNrN0lIMHBPd29nSUNBZ2JHOHViMjRvSjJOc2IzTmxKeXdnS0dOdlpHVXBJRDArSUhzS0lDQWdJQ0FnYTJsc2JGQnliMk1vSit1aG5PcTN1T3lWaE95YmcrMlZ0T3lFbkNEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVTGljcE95QXZMeURzblpqcmo0VHNvSUVnN0tLRjY2T01JT0tBbENEc25wRHJqNWtnDQo3SjZzN0l1YzY0K0U2ckNBSU95RXVPeUZtT3lkaENEcmtKanNnclRycHF6cnFiUWc3SldJSU91UXFBb2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QWdJQ0FnSUNBZ0x5OGc2NHVrN0oyTUlDOWhZMk52ZFc1MHdyY3ZhR1ZoYkhSbzdKZVE3SVNjSU9xemhPeWdsZXlkaENEc2c0anJvWndvUGV5WGh1eWRqT3ljdk91aG5Da2c3SjI5NnJLTUNpQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0lDQWdJQ0FnSUNBdkx5RHNnNEh0ZzV3ZzdKNnM3WXlRN0tDVktPdUxwT3lkakNEdGhMVHNsNURzaEp3ZzY2KzQ2NkdjNnJlNDdKMjRJT3F3a095bmdDa0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNsWVRzbTRNZ0tHTnZaR1VnSnlBcklHTnZaR1VnS3lBbktTY3BPd29nSUNBZ0lDQnBaaUFvY21WekxtaGxZV1JsY25OVFpXNTBLU0J5WlhSMWNtNDdJQzh2SUdWeWNtOXlJTzJWdU91VHBPdWZyT3F3Z0NEc25iVHJyN2dnN0oyUg0KNjR1MTdaYUk3Snk4NjZtMElPeWtrZXV6dFNEcnNLbnNwNEFLSUNBZ0lDQWdhV1lnS0dOdlpHVWdQVDA5SURBcElHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdDaUFnSUNBZ0lHVnNjMlVnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUdWeWNtOXlPaUFvWlhKeUxuUnlhVzBvS1M1emJHbGpaU2d3TENBeE5UQXBLU0I4ZkNBb0oreWloZXVqakNEc3ZaVHJrNXdnSnlBcklHTnZaR1VwSUgwcE93b2dJQ0FnZlNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lDOHZJT3lla09xNHNDRHNvb1hybzR3ZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNCVFZFOVFYMEpTU1VSSFJTL3RsWmp0aXJqcnVZVHRpcmpxc0lBZzdaaTQ3TGFjN1pXYzY0dWtJQ2pyb1p6c3U2enNsNURzaEp6cnA0d2c3S0NSNnJlOElPcXdnT3VLcGUyVm1PdUxpQ0RzbFlqc29JUXBDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM05vZFhSa2IzZHUNCkp5a2dld29nSUNBZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlNCOUtUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvb1hybzR3ZzdKcVU3TEt0SU91d20reWRqQ0RpZ0pRZzY0dWs2NmFzNjZXOElPdUJsZXVMaU91THBDNG5LVHNLSUNBZ0lITm9kWFIwYVc1blJHOTNiaUE5SUhSeWRXVTdDaUFnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJREl3TUNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5eVpXTnZiVzFsYm1RbktTQjdDaUFnSUNCamIyNXpkQ0I3SUhSbGVIUXNJRzF2WkdWc0xDQnliMnhsSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ2FXWWdLQ0YwWlhoMElIeDhJQ0ZUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zDQpJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0oreTJsT3l5bk91d20reWRoQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdMYVU3TEtjSU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnl3Z2NtOXNaU0EvSUNkYkp5QXJJSEp2YkdVZ0t5QW5YU2NnT2lBbkp5d2diVzlrWld3Z1B5QW5LT3VxcU91TnVEb2dKeUFySUcxdlpHVnNJQ3NnSnlrbklEb2dKeWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTI5dWMzUWdjaUE5SUdGM1lXbDBJR0Z6YTBOc1lYVmtaU2hUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwTENCdGIyUmxiQ3dnZXlCd1lYSnpaVG9nY0dGeWMyVlRkV2RuWlhOMGFXOXVjeXdnWm05eWJXRjBSR1Z6WXpvZ0oxdDdJblJsZUhRaQ0KT2lBaTY2eTQ2cldzSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBaWZTd2dMaTR1WFNjZ2ZTd2djbTlzWlNrN0NpQWdJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ2NpNXdZWEp6WldRZ2ZId2dXMTA3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c2xZZ2dKeUFySUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBcklDZnFzSndnS0NjZ0t5QnpaV01nS3lBbmN5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnkNCmRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0F6TUNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJSE4xWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUNmdGdiVHJvWnpyazV3ZzdaaTQ3TGFjSU95THBPMk1xRG9nSnlrcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlEdGxJVHJvSWpzbm9UcnM0UWc3TGFVDQo3TEtjSU9LQWxDRHRsWndnN1ptVTY2bTA3SjJFSU8yVm1PeWNoQ0R0bElUcm9JanNub1FvN0ppQjdKZXRLU0RyaTZqc25JVHJvWndnNjRLWTY0aWdJT3V3bStxem9Dd2c3SmlCN0pldDY2ZUk2NHVrSU91VXNPdWhuQ0RyaklEc2xZanNuWVFnNjRLNDY0dWtMZ29nSUM4dklPeVlnZXlYclNEc2lKanJwNHp0Z2J3ZzdKcVU3TEt0N0oyRUlPeXF2T3F3bk95bmdDRHNsWXJyaXBRZzZyS0Q3SjIwSU8yVnRleUxyQ0FvNjRxUTY2Q2s3S2VBNnJPZ0lPeUNyT3lhcWV1ZmlldVBoQ0RxdDdqcnA0enRnYndnNjRLWTZyQ0U2NHVrS1M0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0xXZHliM1Z3Y3ljcElIc0tJQ0FnSUdOdmJuTjBJSHNnWjNKdmRYQnpMQ0J0YjJSbGJDd2diVzl5WlNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHTnZibk4wSUd4cGMzUWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHZHliM1Z3Y3lrSw0KSUNBZ0lDQWdQeUJuY205MWNITUtJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tHY3BJRDArSUNoN0NpQWdJQ0FnSUNBZ0lDQWdJRzVoYldVNklGTjBjbWx1Wnlnb1p5QW1KaUJuTG01aGJXVXBJSHg4SUNjbktTNTBjbWx0S0Nrc0NpQWdJQ0FnSUNBZ0lDQWdJSFJsZUhSek9pQW9aeUFtSmlCQmNuSmhlUzVwYzBGeWNtRjVLR2N1ZEdWNGRITXBJRDhnWnk1MFpYaDBjeUE2SUZ0ZEtTNXRZWEFvS0hRcElEMCtJRk4wY21sdVp5aDBJSHg4SUNjbktTNTBjbWx0S0NrcExtWnBiSFJsY2loQ2IyOXNaV0Z1S1N3S0lDQWdJQ0FnSUNBZ0lDQWdjbTlzWlRvZ0tHY2dKaVlnWnk1eWIyeGxLU0EvSUZOMGNtbHVaeWhuTG5KdmJHVXBJRG9nZFc1a1pXWnBibVZrTEFvZ0lDQWdJQ0FnSUNBZ2ZTa3BDaUFnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2huS1NBOVBpQm5MblJsZUhSekxteGxibWQwYUNrS0lDQWdJQ0FnT2lCYlhUc0tJQ0FnSUdsbUlDaHNhWE4wTG14bGJtZDBhQ0E4SURJcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXcNCkxDQjdJR1Z5Y205eU9pQW43SmlCN0pldDdKMjBJT3UyZ095aHNlMlZxZXVMaU91THBDNG5JSDBwT3dvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RzbXBUc3NxMDZJT3lZZ2V5WHJTQW5JQ3NnYkdsemRDNXNaVzVuZEdnZ0t5QW42ckNjSnlBcklDaHRiM0psSUQ4Z0p5QW82NDJVSU91d20rcTRzQ2tuSURvZ0p5Y3BMQ0J0YjJSbGJDQS9JQ2NvNjZxbzY0MjRPaUFuSUNzZ2JXOWtaV3dnS3lBbktTY2dPaUFuSnlrN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclIzSnZkWEJ6S0d4cGMzUXNJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlVkeWIzVndjeXdnWm05eWJXRjBSR1Z6WXpvZ0ozc2laM0p2ZFhCeklqb2dXM3NpYm1GdFpTSTZJQ0xzbUlIc2w2MGc3SjIwNjZhRUlpd2dJbk4xWjJkbGMzUnBiMjV6SWpvZ1czc2lkR1Y0DQpkQ0k2SUNMcmpJRHNsWWdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOVhYMWRmU2NnZlN3Z0lTRnRiM0psS1RzS0lDQWdJQ0FnWTI5dWMzUWdiM1YwSUQwZ2NpNXdZWEp6WldRN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnZkWFFwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRsSVRyb0lqc25vVHJzNFFnN0tDYzdKV0lJQ2NnS3lCdmRYUXVjbVZrZFdObEtDaHVMQ0JuS1NBOVBpQnVJQ3NnWnk1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnc0lEQXBJQ3NnSitxd25DQXZJT3lZZ2V5WHJTQW5JQ3NnYjNWMExteGxibWQwYUNBcklDZnFzSndnS0NjZw0KS3lCelpXTWdLeUFuY3lrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlDZGI3WlNFNjZDSTdKNkU2N09FWFNBbklDc2dVM1J5YVc1bktDaHNhWE4wV3pCZElDWW1JR3hwYzNSYk1GMHVkR1Y0ZEhOYk1GMHBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlOQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHZHliM1Z3Y3pvZ2IzVjBMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU0U2NkNJN0o2RTY3T0VJT3kybE95eW5DRHNpNlR0aktnNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lDQWcNCmNtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5LU2s3Q2lBZ0lDQjlDaUFnZlFvZ0lDOHZJTzJNbmV5WGhTRHNtcFRzaG96cnM0UWc3TGFVN0xLY0lPS0FsQ0R0bFp3ZzdZeWQ3SmVGN0oyWUlPcTFyT3lFc2V5YWxPeUdqQ2pzbDYzdGxhQXI2Nnk0NnJXc0tldWx2Q0R0bFp3ZzY3S0k3SmVRSU91d20reVZoQ0RzbDYzdGxhRHJzNFRyb1p3ZzY0dWs2NU9zNjRxVTY0dWtMZ29nSUM4dklPeWFsT3lHak91bHZDRHRsYWpxdTVnZzY3TzA2NEswN0pXOElPMkRnT3lkdE8yTGdPeWR0Q0RyczdqcnJMZ2c2NmVsNjUyOTdKMkVJT3l3dU95aHNPMlZvQ0RzaUpnZzdKNkk2NHVrS095YWxPeUdqT3V6aENEcXNKenJzNFFnN0pxVTdMS3Q2ck84N0oyWUlPeXdxT3lkdENrdUNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzSmxZMjl0YldWdVpDMXdiM0IxDQpjQ2NwSUhzS0lDQWdJR052Ym5OMElIc2daV3hsYldWdWRITXNJRzF2WkdWc0xDQnRiM0psSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ1kyOXVjM1FnYkdsemRDQTlJRUZ5Y21GNUxtbHpRWEp5WVhrb1pXeGxiV1Z1ZEhNcElEOGdaV3hsYldWdWRITXVabWxzZEdWeUtDaGxLU0E5UGlCbElDWW1JRk4wY21sdVp5aGxMblJsZUhRZ2ZId2dKeWNwTG5SeWFXMG9LU2tnT2lCYlhUc0tJQ0FnSUdsbUlDaHNhWE4wTG14bGJtZDBhQ0E4SURJcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuN1l5ZDdKZUZJT3lhbE95R2pPcXdnQ0RydG9Ec29iSHRsYW5yaTRqcmk2UXVKeUI5S1RzS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNbmV5WGhTRHN0cFRzc3B3ZzdKcVU3TEt0T2lEc21wVHNob3dnSnlBcklHeHBjM1F1YkdWdVozUm9JQ3NnSitxd25DY2dLeUFvYlc5eQ0KWlNBL0lDY2dLT3VObENEcnNKdnF1TEFwSnlBNklDY25LU3dnYlc5a1pXd2dQeUFuS091cXFPdU51RG9nSnlBcklHMXZaR1ZzSUNzZ0p5a25JRG9nSnljcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ1kyOXVjM1FnY2lBOUlHRjNZV2wwSUdGemExQnZjSFZ3S0d4cGMzUXNJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlZCdmNIVndMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXV3cWUyV3BTRHRsWndnNjZ5NDdKNmxJaXdnSW1Wc1pXMWxiblJ6SWpvZ1czc2ljbTlzWlNJNklDTHNsNjN0bGFBaUxDQWlkR1Y0ZENJNklDTHJyTGpxdGF3aWZTd2dMaTR1WFgwc0lDNHVMbDE5SnlCOUxDQWhJVzF2Y21VcE93b2dJQ0FnSUNCamIyNXpkQ0J6WlhSeklEMGdjaTV3WVhKelpXUTdDaUFnSUNBZ0lHTnZibk4wSUhObFl5QTlJQ2dvUkdGMFpTNXViM2NvS1NBdElITjBZWEowWldRcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtUc0tJQ0FnSUNBZ2FXWWdLQ0Z6WlhSektTQjcNCkNpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJSHNnWlhKeWIzSTZJQ2Z0Z2JUcm9aenJrNXdnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlkN0plRklPeUV1TzJLdUNBbklDc2djMlYwY3k1c1pXNW5kR2dnS3lBbjZyQ2NJQ2duSUNzZ2MyVmpJQ3NnSjNNcEp5azdDaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQW5XKzJNbmV5WGhWMGdKeUFySUZOMGNtbHVaeWdvYkdsemRGc3dYU0FtSmlCc2FYTjBXekJkTG5SbGVIUXBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlOQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003DQpDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhObGRITXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY2dmU2s3Q2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpKM3NsNFVnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lDZnRnYlRyb1p6cms1d2c3Wmk0N0xhY0lPeUxwTzJNcURvZ0p5a3BPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5RHJqSUR0bVpUdG1KVWc2Nnk0NnJXc0lPeWduT3lla1NEaWdKUWc3SU9CN1ptcDdKMkVJT3lFcE91cWhlMlZtT3VwdENEcnJManF0YXpycGJ3ZzY2ZU02NU9rN0phMDdLU0E2NHVrSUNqc3RwVHNzcHpxczd3ZzZyQ1o3SjJBSU95RXVPeUZtQ3dnNjR5QTdabVU2NHFVSU91bnBDRHNtcFRzc3Ezc2w1QWc3WWExN0tlNDY2R2NJT3lMcE91bXZDa0tJQ0JwWmlBb2NtVnhMbTFsZEdodg0KWkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdlkyOXRjRzl6WlNjcElIc0tJQ0FnSUdOdmJuTjBJSHNnYldWemMyRm5aWE1zSUcxdlpHVnNJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlFRnljbUY1TG1selFYSnlZWGtvYldWemMyRm5aWE1wSUQ4Z2JXVnpjMkZuWlhNdVptbHNkR1Z5S0NodEtTQTlQaUJ0SUNZbUlGTjBjbWx1WnlodExuUmxlSFFnZkh3Z0p5Y3BMblJ5YVcwb0tTa2dPaUJiWFRzS0lDQWdJR2xtSUNnaGJHbHpkQzVzWlc1bmRHZ3BJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREF3TENCN0lHVnljbTl5T2lBbjY0eUE3Wm1VSU91Q3RPeWFxZXlkdENEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTjBJR3hoYzNSVmMyVnlJRDBnV3k0dUxteHBjM1JkTG5KbGRtVnljMlVvS1M1bWFXNWtLQ2h0S1NBOVBpQnQNCkxuSnZiR1VnSVQwOUlDZGhjM05wYzNSaGJuUW5LVHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c25wRWc2NHlBN1ptVUlPeWFsT3l5clRvbkxDQlRkSEpwYm1jb0tHeGhjM1JWYzJWeUlDWW1JR3hoYzNSVmMyVnlMblJsZUhRcElIeDhJQ2NuS1M1emJHbGpaU2d3TENBMU1Da3VjbVZ3YkdGalpTZ3ZYRzR2Wnl3Z0p5QW5LU0FySUNmaWdLWWdLT3VNZ08yWmxDQW5JQ3NnYkdsemRDNXNaVzVuZEdnZ0t5QW42ckNjS1NjcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ0x5OGc2NHlBN1ptVTZyQ0FJT3E0dU95V3RPeW5nT3VwdENEc3RaenF0N3dnTVRMcXNKenJwNHdnS08yVWhPdWhyTzJVaE8yS3VDRHRqNjNzbzd3ZzY3Q3A3S2VBS1FvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUTI5dGNHOXpaU2hzYVhOMExuTnNhV05sS0MweE1pa3NJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlVOdmJYQnZjMlVzSUdadmNtMWhkRVJsYzJNNklDZDdJbkpsY0d4NUlqb2dJdXVNDQpnTzJabENEc25aSHJpN1VnN1pXYzY1R1FJT3VzdU95ZXBTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2Nnk0NnJXc0lpd2dJbkpsWVhOdmJpSTZJQ0xzbmJUc25LQWlmU3dnTGk0dVhYMG5JSDBwT3dvZ0lDQWdJQ0JqYjI1emRDQnZkWFFnUFNCeUxuQmhjbk5sWkRzS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3dvZ0lDQWdJQ0JwWmlBb0lXOTFkQ2tnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0NpQWdJQ0FnSUgwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lla1NEc25aSHJpN1VnS0NjZ0t5QnpaV01nS3lBbmN5d2c3S0NjN0pXSUlDY2dLeUJ2ZFhRdWMzVm5aMlZ6ZEdsdg0KYm5NdWJHVnVaM1JvSUNzZ0orcXduQ2tuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWdvYkdGemRGVnpaWElnSmlZZ2JHRnpkRlZ6WlhJdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djbVZ3YkhrNklHOTFkQzV5WlhCc2VTd2djM1ZuWjJWemRHbHZibk02SUc5MWRDNXpkV2RuWlhOMGFXOXVjeXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lla1NEc2k2VHRqS2c2Snl3Z1pTNXRaWE56WVdkbEtUc0sNCklDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdDaUFnSUNCOUNpQWdmUW9nSUM4dklPdXlpT3lYclNEaWdKUWc3WldjNnJXdDdKYTBJT0tHbENEc21JSHNsclFnN0o2UTY0K1pJQ2pzdHBUc3NwenFzN3dnNnJDWjdKMkFJT3lFdU95Rm1DRHNncXpzbXFrcENpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzUnlZVzV6YkdGMFpTY3BJSHNLSUNBZ0lHTnZibk4wSUhzZ2RHVjRkQ3dnYlc5a1pXd2dmU0E5SUdGM1lXbDBJSEpsWVdSQ2IyUjVLSEpsY1NrN0NpQWdJQ0JwWmlBb0lYUmxlSFFnZkh3Z0lWTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3BJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREF3TENCN0lHVnljbTl5T2lBbjY3S0k3SmV0N1pXZ0lPdXN1T3Exck9xd2dDRHJ1WVRzbHJRZzdKNkk3SXExNjR1STY0dWtMaWNnDQpmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdKcVU3TEt0T2ljc0lGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0ExTUNrdWNtVndiR0ZqWlNndlhHNHZaeXdnSnlBbktTQXJJQ2ZpZ0tZbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhJZ1BTQmhkMkZwZENCaGMydFVjbUZ1YzJ4aGRHVW9VM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFZISmhibk5zWVhSbExDQm1iM0p0WVhSRVpYTmpPaUFuZXlKMGNtRnVjMnhoZEdWa0lqb2dJdXV5aU95WHJldXN1Q0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpTENBaVpHbHlaV04wYVc5dUlqb2dJbXR2NG9hU1pXNGc2NWlRNjRxVUlHVnU0b2FTYTI4aWZTY2dmU2s3Q2lBZ0lDQWdJR052Ym5OMElHOTFkQ0E5SUhJdWNHRnljMlZrT3dvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBbw0KS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzY3S0k3SmV0SU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNtWVRybzR3Z0tDY2dLeUJ6WldNZ0t5QW5jeXdnSnlBcklDaHZkWFF1WkdseVpXTjBhVzl1SUh4OElDYy9KeWtnS3lBbktTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmwNCktEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2dkSEpoYm5Oc1lYUmxaRG9nYjNWMExuUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZiam9nYjNWMExtUnBjbVZqZEdsdmJpd2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzaTZUdGpLZzZKeXdnWlM1dFpYTnpZV2RsS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHJzb2pzbDYwZzdJdWs3WXlvT2lBbktTazdDaUFnSUNCOUNpQWdmUW9nSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBMExDQjdJR1Z5Y205eU9pQW5UbTkwSUdadmRXNWtKeUI5S1RzS2ZTazdDZ292THlEc25iVHJyN2dnNjR1azY2YXM2ckNBSU91V29DRHNub2pyDQppcFRyamJBZzY1aVFJT3k4bk9xNHNPcXdnQ0RyazZUc2xyVHNtS1RycWJRbzdLQ2M3SXFrN0xLWUlPeWVrT3VQbVNEc3ZKenF1TEFnN0tTUjY3TzFJT3VUc1NrZzdLR3c3SnFwN1o2SUlPeWloZXVqakNEaWdKUWc2NCtNNjQyWUlPdUxwT3Vtck91S2xDRHF0N2pyaklEcm9ad2c3SnlnN0tlQUNuTmxjblpsY2k1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V3b2dJR2xtSUNobElDWW1JR1V1WTI5a1pTQTlQVDBnSjBWQlJFUlNTVTVWVTBVbktTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SjIwNjYrNElPeThuT3lndUNEc25vanNsclRzbXBRbzdZK3M3WXE0SUNjZ0t5QlFUMUpVSUNzZ0p5RHNncXpzbXFrZzdLU1JLU0RpZ0pRZzdKMjBJT3lkdU95S3BPMkV0T3lLcE91S2xDRHNvb1hybzR6dGxhbnJpNGpyaTZRdUp5azdDaUFnSUNCd2NtOWpaWE56TG1WNGFYUW9NQ2s3Q2lBZ2ZRb2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2hKenJzb1FnN0ppazY2V1lPaWNzSUdVZw0KSmlZZ1pTNXRaWE56WVdkbEtUc0tJQ0J3Y205alpYTnpMbVY0YVhRb01TazdDbjBwT3dvdkx5RHNsclRybHFRZzZySzk2NkdjNjZHY0lPeWp2ZXVUb0Nqc2k2enNucVhyc0pYcmo1a2c2NEdLNnJtQUxDQkRkSEpzSzBNc0lDOXphSFYwWkc5M2Jpd2c3SmlrNjZXWUtTQmpiR0YxWkdVZzdKNlE3SXVkN0oyRUlPdUNxT3E0c095bmdDRHNsWXJyaXBUcmk2UUtjSEp2WTJWemN5NXZiaWduWlhocGRDY3NJQ2dwSUQwK0lIc2dhMmxzYkZCeWIyTW9LVHNnYTJsc2JFeHZaMmx1VUhKdll5Z3BPeUI5S1RzS2NISnZZMlZ6Y3k1dmJpZ25VMGxIU1U1VUp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwS1RzS2NISnZZMlZ6Y3k1dmJpZ25VMGxIVkVWU1RTY3NJQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1NrN0NncHpaWEoyWlhJdWJHbHpkR1Z1S0ZCUFVsUXNJQ2N4TWpjdU1DNHdMakVuTENBb0tTQTlQaUI3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KK0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1UNCmdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2NnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rzdkp6c3A1QWc0b0NVSUdoMGRIQTZMeTlzYjJOaGJHaHZjM1E2SnlBcklGQlBVbFFwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2NnNjZxbzY0MjRPaUFuSUNzZ1EweEJWVVJGWDAxUFJFVk1JQ3NnSnlEQ3R5RHNtSWpzaTV3Z0p5QXJJRVZZUVUxUVRFVlRMbXhsYm1kMGFDQXJJQ2Zxc2JRZzdKNmw3TENwSnlrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSnlEc25iUWc3TEM5N0oyRUlPeThuT3VSbENEcmo1bnNsWWdnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0R0Z2JUcm9aenJrNXpyb1p3ZzdMYVU3TEtjN1pXcDY0dUk2NHVrTGljcE93b2dJR052DQpibk52YkdVdWJHOW5LQ2ZpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBbktUc0tJQ0JqYUdWamEwTnNZWFZrWlVGMllXbHNZV0pzWlNncE95QXZMeUJEYkdGMVpHVWdRMjlrWlNEc2dxenNtcWtnNnJDQTY0cWxJT3lYck91MmdDRHNvSkRxc29BZ0tPMlVqT3Vmck9xM3VPeWR1Q0RzbFlqcmdyVHNtcWtwQ2lBZ0x5OGc2Nis0NjZhc0lPeUxuT3VQbVNBcklPeW5nT3lMbk91c3VDRHNvN3pzbm9VZzRvQ1VJT3l5cXlEc3RwVHNzcHpydG9EdGhMQWc2N21nNjZXMDZyS01DaUFnWVhOclEyeGhkV1JsS0Nmc200enJzSTNzbDRVNklDTHNvSURzbnFVZzY1Q1k3SmVJN0lxMTY0dUk2NHVrSWljcExuUm9aVzRvQ2lBZ0lDQW9LU0E5UGlCag0KYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeVpoT3VqakNEaWdKUWc3TGFVN0xLY0lPeWtnT3U1aENEcmdaMHVKeWtzQ2lBZ0lDQW9aU2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3liak91d2pleVhoU0RzaTZUdGpLZ2dLT3l5cXlEc21wVHNzcTBnNjVXTUlPeWVyT3lMbk91UGhDazZKeXdnWlM1dFpYTnpZV2RsS1FvZ0lDazdDbjBwT3dvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJRzFoWTA5VElPdVRzZXlYa095RW5DQW5iRzlqWVd4b2IzTjBKK3F3Z0NBNk9qSHJvWndnNjZpODdLQ0FJTzJWdE95RW5ldVFtT3VLbE91TnNBb3ZMeUR0bEx6cXQ3anJwNGdvUld4bFkzUnliMjRwSUdabGRHTm82NHFVSUdOMWNtenFzN3dnNjR1czY2YXNJRWxRZGpUcm9ad2c3SjZRNjQrWklPMlB0T3V3c2UyVm1PeW5nQ0RzbFlyc2xZUXNJRWxRZGpUcnA0d2c2NU9qNjQyWUlPdUxwT3Vtck95WGtDRHMNCmw3RHFzckRzbmJRZzZyR3c2N2FBNjQrOENpOHZJT3kybE95eW5NSzM3WmVzN0lxazdMSzA3WUdzNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxvanJpNlFvN0l1azdMaWhJREl3TWpZdE1EY3BMaURxc0puc25ZQWc3SnFVN0xLdElPMlZ1T3VUcE91ZnJPdWx2Q0JKVUhZMklPdWpxTzJVaE91d3NleVhrT3VQaENEc2xybnJpcFRyaTZRdUNtTnZibk4wSUhObGNuWmxjallnUFNCb2RIUndMbU55WldGMFpWTmxjblpsY2loelpYSjJaWEl1YkdsemRHVnVaWEp6S0NkeVpYRjFaWE4wSnlsYk1GMHBPd3B6WlhKMlpYSTJMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZ1NWQjJOaWc2T2pFcElPdW1yT3lLcUNEc2c1M3JuclVnNG9DVUlFbFFkalRycDR3ZzdJS3M3SnFwT2ljc0lHVWdKaVlnWlM1dFpYTnpZV2RsS1NrN0NuTmxjblpsY2pZdWJHbHpkR1Z1S0ZCUFVsUXNJQ2M2T2pFbktUc0sNCjo6RVhBTVBMRVM6Og0KSXlEcnJManF0YXdnN0xhVTdMS2NJT3lZaU95TG5Bb0tJdXVzdU9xMXJDRHN0cFRzc3B6cnNKdnF1TEFpNnJDQUlPeUNyT3lhcWUyVm1PdUtsQ0RzbUlqc2k1d2c2NnFvN0oyTTdKNkY2NHVJNjR1a0xpQXFLdXlkdENEdGpJenNuYnpzbllRZzdJaVk3S0NWN1pXY0lPdVNwQ0R0aExEcnI3anJoSkRzbDVEc2hKd2dZRzV3YlNCeWRXNGdZblZwYkdSZzY2VzhJT3lMcE8yV2llMlZtT3F6b0N3Z1JtbG5iV0hzbDVEc2hKd2c3WlNNNjUrczZyZTQ3SjI0N0oyRUlPdUxwT3lMbkNEc2k2VHRsb250bFpqcnFiUWc2N0NZN0ppQjY1Q3A2NHVJNjR1a0xpb3FDZ29qSXlEc25wSHNoTEVnNjdDcDY3S1ZDZ290SU95WWlPeUxuQ0R0bFpqcmdwanJpcFFnS2lwZ0l5TWpJT3lia091enVHQXFLaUR0bFp3ZzdLU0U2ck84TENEcXQ3Z2c3SldFNjU2WUlDb3FZQzBnN0xhVTdMS2M3SldJWUNvcUlPeVhyT3VmckNEcXNKenJvWndnN0oyMDY2U0U3S2VSNjR1STY0dWtMZ290SU95MmxPeXluT3lWaUNEc2xZanNsNURzaEp3Z0tpcnMNCnBJVHNuWVFnNjdDVTZyNjQ2ck9nSU95THR1eWN2T3VwdENCZ0lDOGdZQ0FvN0pXZTY1S2tJT3F6dGV1d3NTRHRqNnp0bGFnZzdJcXM2NTZZN0l1Y0tTb3FJT3VobkNEdGtaenNpNXp0bFpqc2hManNtcFF1SU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEcmtaQWc3S1NFNjZHY0lPdXp0T3lYck95bmtldUxpT3VMcEM0S0xTRHNncXpzbXFuc25wRHFzSUFnN0o2RjY2Q2w3WldjSU91c3VPcTFyT3F3Z0NCZzdKdVE2N080WU9xenZDQW82ck8xNjdDeHdyZnJyTGpzbnFYcnRvRHRtTGdnNjZ5MDdJdWM3WldZNnJPZ0tTRHFzSm5xc2JEcmdwZ3NJT3lFbk91aG5DRHRqNnp0bGFqdGxaanJxYlFnNnJlNElPeTJsT3l5bk95VmlPdVRwT3lkaENEcnM3VHNsNnpzcEkzcmk0anJpNlF1Q2kwZzY2ZWs3TG10N1pXZ0lPdVZqQ0FxS3V1bmlPeUtwTzJDdWV1UW5DRHNuYlRycG9RbzdabU5YQ3JyajVrcExDRHNpS3ZzbnBBbzdLQ0U3Wm1VNjdLSTdaaTR3cmNpN0ptNElETHJxb1VpSU91VHNTbnJpcFFnNjZ5MDdJdWNLaXJ0DQpsYW5yaTRqcmk2UWc0b0NVSU95ZHRPdW1oTUszN0lpWTY1K0p3cmZyc29qdG1ManJwNHdnNjR1azY2VzRJT3VzdU9xMXJPdVBoQ0Rxc0puc25ZQWc3SmlJN0l1YzY2R2NJT3llb2UyWWdPeWFsQzRnNjR1b0xDRHN0cFRzc3B6c2xZanNsNUFnN0tDQjdKYTA2NUdVSU95ZHRPdW1oTUszN0lpcjdKNlE2NHFVSU9xM3VPdU1nT3VobkNEcmdwanNtS1RyaTRnZzdJdWs3S0NjSU9xd2t1eVhrQ0RycDU3cXNvd2c2ck9nN0xPUUlPeVRzT3lFdU95YWxDNEtMU0Rzb0p6cnFxa29ZQ01qWUNucXM3d2dZQ01qSTJBc0lHQXRZQ0RxdUxEdG1ManJpcFFnN1ppVjdJdWQ3SjIwNjR1SUlPdXdsT3ErdU95bmdDRHJwNGpzaExqc21wUXVDZ29qSXlEc2lxVHRnNERzbmJ3ZzdKdVE3TG1aSUNqc3NManFzNkFnNG9DVUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZQWdkWGd0ZDNKcGRHbHVaeTV0WkNEcXNJRHNuYlRyazV3cENnb3RJTzJWdE95YWxPeXl0Q3dnNjdhQTY1T2M2NStzN0pxMElPeWloZXF5c0NoZ2Z1eWVpT3lXdE95YQ0KbEdBZ1lIN3JqN3pzbXBSZ0lHQis3SmVHN0phMDdKcVVZQ0JnZnUyVnRDRHNvN3pzaExqc21wUmdLUW90SURMcmk2Z2c2cldzN0tHd09pQXFLdXl5cXlEc3BJUTk3SU9CN1ptcElPeUVwT3VxaFNEaWhwSWc2NUdZN0tlNElPeWtoRDNyaTZUc25Zd2c3WmFKNjQrWktpb282ckt3N0tDVjdKMkFJR0IrN1pXZzZybU03SnFVUDJBc0lPMldpZXVQbVNEc25LRHJqNFRyaXBRZ1lIN3RsYlFnN0tPODdJUzQ3SnFVWUNrS0xTRHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdLT3VRa095V3RPeWFsT0tHa3UyV2lPeVd0T3lhbENrc0lPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQW83SmVHN0phMDdKcVU0b2FTZnUyVm1PdXB0Q0R0bGFBZzdJaVlJT3llaU95V3RPeWFsQ2tLTFNEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phMEtIN3NpNXpxc3FEc2xyVHNtcFEvNG9hU2Z1MlZvT3E1ak95YWxEOHBMQ0RycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQ2pzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjNG9hUzdKNlUNCjdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5Da0tMU0Rxc0lUcXNyRHRsWmpxczZBZzdJbXM3SnEwSU91bmtDQW83S0NFN0lhaDRvYVM2N08wNjRLMDY0dWtLU3dnNjdhQTdLQ1ZJT3lEZ2UyWnFldVBoQ0RybExIcmxMSHRsWmpzcDRBZzdKV0s2cktNS0NMc3NMN3F1TEFnN0l1azdZeW9JdUtkakNBaTdMQys3SjJFSU95SW1DRHNsNGJzbHJUc21wUWk0cHlGS1FvS0l5TWc3TGFVN0xLY0lPeVlpT3lMbkFvS0l5TWpJT3luaE8yV2llMlZtT3VObUNEc25wSHNsNFhzbmJRZzdKNkk3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0tlRTdaYUpJT3lra2V5ZHVDRHJnclRzbDYzc25iUWc3SjZJN0phMDdKcVVMaUF2SU95ZHRPeVd0T3lFbkNEc3A0VHRsb250bGFEcXVZenNtcFEvQ2dvakl5TWc2ck8xN0p5Z0lPeWFsT3l5cmV5ZGhDRHN0NmpzaG96dGxaanJxYlFnN0pxVTdMS3RJT3VDdE95WHJleWR0Q0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kzcU95R2pPMlZtT3lMDQpuT3F5b095S3RldUxpT3E1akQ4S0xTRHN0NmpzaG96dGxhQWc2cks5N0pxd0lPeWFsT3l5clNEcmdyVHNsNjNyajRRZzdJS3Q3S0NjNjQrODdKcVVMaUF2SU9xenRleWNvQ0RzbXBUc3NxM3NuWVFnN0xlbzdJYU03WldnNnJtTTdKcVVQd29LSXlNaklPcTRzT3E0c091bHZDRHNzTDdzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXWTdJUzQ3SnFVTGdvdElPcTRzT3E0c091bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaV1k2cml3SU95Z2hPeVhrT3VLbENEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQTdKNkY3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdLZUE2cmlJSU91eQ0KaE95Z2hPeVhrT3lFbk91S2xDRHNrN2dnN0lpWUlPeVhodXlXdE95YWxDNGc3SU9kN0xLMElPeWR1T3ltbmV5ZGhDRHNrN0Ryb0tUcnFiUWc3Sld4N0oyRUlPeTFuT3lMb0NEcnNvVHNvSVRzbkx6cm9ad2c3SmVGNjQydzdKMjA3WXE0SU8yVnRPeWp2T3lFdU95YWxDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMElPeWp2T3lFdU95YWxDNGdMeURzZzUzc3NyUWc3SjI0N0thZDdKMkVJT3lUc091Z3BPdXB0Q0RzdFp6c2k2QWc2N0tFN0tDRTdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0S0NpTWpJeURzbHJUcmxxUWc2NnFwN0tDQjdKeTg2NkdjSU91TWdPeTJuT3V3bSt5Y3ZPeUxuT3VDbU95YWxEOEtMU0RyaklEc3Rwd2c2NnFwN0tDQjdKMjBJT3VzdE95WGgreWR1T3F3Z095YWxEOEtDaU1qSXlEc2xyVHJscVFnN0oyMDdKeWc2NkdjSU95TG9PcXpvTzJWbU95TG5PdUNtT3lhbEQ4S0xTRHNpNkRxczZBZzdKMjA3SnlnNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKNlUNCjdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVQ2kwZzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMZ29LSXlNaklPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnN0ptNElETHJxb1hzbDVEcXNvd2c2cmFNN1pXY0lPeUNyZXlnbkNEc2xZenJwcnp0aHFIc25ZUWc3S0NFN0lhaDdaV2c2cm1NN0pxVVB3b3RJT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3RPdWdwT3F6b0NEdGxiVHNtcFF1SUM4ZzdabU5LdXVQbVNnd01UQXRNVEl6TkMwMU5qYzRLU0RyaTVnZzdKbTRJRExycW9Yc2w1RHFzb3dnNjdPMDY0Szg2cm1NN0pxVVB3b3RJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzY0dVlJT3ladUNBeTY2cUY3SmVRNnJLTUlPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdk9xNWpPeWFsRDhLTFNEcXRvenRsWndnDQo3SUt0N0tDY0lPeVZqT3Vtdk8yR29leWRoQ0R0bVkwcTY0K1pLREF4TUMweE1qTTBMVFUyTnpncElPdUxtQ0RzbWJnZ011dXFoZXlYa09xeWpDRHJzN1RyZ3J6cXVZenNtcFEvQ2dvakl5TWpJTzJabGV5ZHVNSzM2ckt3N0tDVklPMk1uZXlYaFFvS0l5TWpJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeUNyZXlnbk91UW5DRHJqYkRzbmJUdGhMRHJpcFFnNjdPMTZyV3M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHJrSmpyajR6cnByUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNvSlhycDVBZzdJS3Q3S0NjN1pXZzZybU03SnFVUHdvS0l5TWpJT3V6Z09xeXZleUNyTzJWcmV5ZHRDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdKV1k3SXExNjR1STY0dWtMaURyZ3BqcXNJRHNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SldFN0tlQklPeWdnT3llcGUyVm1PeW5nQ0RzbFlyc25ZQWc2NEswN0pxcDdKMjBJT3llaU95Vw0KdE95YWxDNGdMeURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1ak95YWxEOEtDaU1qSXlEcm9aenF0N2pzbFlUc200TWc3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU91aG5PcTN1T3lWaE95YmcrMlZvT3E1ak95YWxEOEtDaU1qSXlEc2xiSHNuWVFnN0tLRjY2T003WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU95VnNleWRoQ0Rzb29Ycm80enRsYURxdVl6c21wUS9DZ29qSXlNZzdaV2NJT3V5aUNEcnM0RHFzcjN0bFpqcnFiUWc2NHVrN0l1Y0lPdXpnT3F5dmUyVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc2NHVrN0l1Y0lPdXdsT3EvZ0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xemhPeUdqZTJWb09xNWpPeWFsRDhLQ2lNakl5RHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTBpT3E0c08yWmxPMlYNCm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmo3enNtcFF1SUM4ZzdMU0k2cml3N1ptVTdaV2c2cm1NN0pxVVB3b0tJeU1qSXlEc2w1RHJuNnpDdCt5THBPMk1xQW9LSXlNaklPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPdUVwTzJLdU95YmpPMkJyT3lYa0NEc2w3RHFzckR0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc2w3RHFzckFnN0lPQjdZT2M2Nlc4SU8yWmxleWR1TzJWbU9xem9DRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ienNpNXpzb0lIc25iZ2c3SmlrNjZXWTZyQ0FJT3V3bk95RG5lMldpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0RzbmJ6c2k1enNvSUhzDQpuYmdnN0ppazY2V1k2ckNBSU95RG5lcXl2T3lXdE95YWxDNGdMeURzbnFEc2k1d2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWaE95ZHRPdVVsQ0RybUpEcmlwUWc2N21FNjdDQTY3S0k3Wmk0NnJDQUlPeWR2T3k1bU8yVm1PeW5nQ0RzbFlyc2lyWHJpNGpyaTZRdUNpMGc3SldFN0oyMDY1U1VJT3VZa091S2xDRHJ1WVRyc0lEcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDNyc29qdG1ManFzSUFnN0oyODdMbVk3WldZN0tlQUlPeVZpdXlLdGV1TGlPdUxwQzRLTFNEc25ianNwcDNyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3kwaU9xenZPdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKMjQ3S2FkNjdLSQ0KN1ppNDY2VzhJT3llck91d25PeUdvZTJWbU95THJleUxuT3lZcEM0S0xTRHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeW5nT3VDck95V3RPeWFsQzRnTHlEc25ianNwcDNyc29qdG1ManJwYndnNjR1azdJdWNJT3V3bSt5VmhDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2xyVHNtcFF1SUM4ZzY0dWs2Nlc0SU9xeWdPeURpZXlXdE91aG5DRHJpNlRzaTV3ZzdMQys3SldFNjdPMDdJUzQ3SnFVTGdvS0l5TWpJT3lnbGV1enRPdWx2Q0RydG9qcm42enNtS1RzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rzb0pYcnM3VHJwYndnNjdhSTY1K3M3SmlzSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeUR0akl6c25id2cNCjdKZUY2NkdjNjVPYzdKZVFJT3lMcE8yTXFPMldpT3lLdGV1TGlPdUxwQzRLTFNEdGpJenNuYnpzbllRZzdKaXM2NmFzN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRnTHlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0tDUTZyS0FJT3lra2V5ZWhldUxpT3VMcEM0ZzdKMjA3SnFwN0plUUlPdTJpTzJPdU95ZGhDRHJrNXpyb0tRZzdLT0U3SWFoN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHNoSnpydVlUc2lxVHJwYndnN0tDUTZyS0E3WldZNnJPZ0lPeWVpT3lXdE95YWxDNGdMeURzb0pEcXNvRHNuYlFnNjRHZDY0S1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxZVHNpSmdnN0o2RjY2Q2xJTzJWcmV1cXFleWVoZXVMaU91THBDNEtMU0RxdkswZzdKNkY2NkNsN1pXMDdKVzhJTzJWbU91S2xDRHRsYTNycXFuc25iVHNsNURzbXBRdUNnb2pJeU1qSU9xMmpPMlZuTUszN0lTazdLQ1ZDZ29qDQpJeU1nN0xtMDY2bVU2NTI4SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdJcTE2NHVJNjR1a0xpRHNoS1Rzb0pYc2w1RHNoSndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU95THJleUxuT3lZcEM0S0xTRHN1YlRycVpUcm5id2c2cmFNN1pXYzdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0xtMDY2bVU2NTI4SU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmpPdW12Q0RxdG96dGxaenNuYlFnNnJHdzY3YUE2NUNZN0phMElPeVZqT3Vtdk95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHNsWXpycHJ3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PdXB0Q0RzaG96c2k1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUlDOGc3SVNrN0tDVjdKZVE3SVNjSU95VmpPdW12T3lkaENEc3ZKd2c3S084N0lTNDdKcVVMZ29LSXlNaklPeWNoT3k1bUNEc29KWHJzN1FnN0oyMDdKcXA3SmVRSU91UA0KbWV5ZG1PMlZtT3luZ0NEc2xZcnNsWVFnN0oyODY3YUFJT3E0c091S3BleWR0Q0Rzb0p6dGxaenJrS25yaTRqcmk2UXVDaTBnN0p5RTdMbVlJT3lnbGV1enRPdWx2Q0R0bDRqc21xbnRsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0p5RTdMbVlJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzbVlUcm80ekN0K3luaE8yV2lRb0tJeU1qSU95Z2dPeWVwZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Rzb0lEc25xWHRsb2pzbHJUc21wUXVDZ29qSXlNZzY3T0E2cks5N0lLczdaV3Q3SjIwSU95Z2dleWFxZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyczREcXNyMGc2NEswN0pxcDdKMkVJT3lnZ2V5YXFlMldpT3lXdE95YWxDNEtDaU1qSXlEc29JVHNocUhzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRPdURpT3lXdE95YWxDNEtDaU1qSXlEcms3SHINCm9aM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3VUc2V1aG5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1nN0lLdDdLQ2M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lDcmV5Z25PMldpT3lXdE95YWxDNEtDaU1qSXlEdGdiVHJwcjNyczdUcms1enNsNUFnNjdPMTdJS3M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dGV5Q3JPMldpT3lXdE95YWxDNEtDaU1qSXlEc21wVHNzcTNzbllRZzdMS1k2NmFzSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SnFVN0xLdDdKMkVJT3l5bU91bXJPMlZtT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3lWaU91Q3RNSzM3SnlnNjQrRUNnb2pJeU1nN0lPSTY2R2M3SnEwSU91eWhPeWdoT3lkdENEc3RwenNpNXpya0pqc2w0anNpclhyaTRqcmk2UXVJT3lYaGV1TnNPeWR0TzJLDQp1Q0R0bTRRZzdKMjA3SnFwSU9xd2dPdUtwZTJWcWV1TGlPdUxwQzRLTFNEc2c0Z2c2N0tFN0tDRTdKMjBJT3VDbU95WmxPeVd0T3lhbEM0Z0x5RHNsNFhyamJEc25iVHRpcmp0bFpqcnFiUWc3SU9JSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0oyMDdKcXA3SjJFSU95Y2hPMlZ0Q0RzbGIzcXRJQWc2NCtaN0oyWTZyQ0FJTzJWaE95YWxPMlZxZXVMaU91THBDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzaTV6c25wSHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25xWHNpNXpxc0lRZzY2KzQ3SUtzN0pxcDdKeTg2NkdjSU95ZWtPdVBtU0Ryb1p6cXQ3anNsWVRzbTRNZzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3lZcE91ZXErdVBtZXlWaUNEc2dxenNtcW50bFpqc3A0QWc3SldLN0pXRUlPdWhuT3EzdU95Vg0KaE95YmcrdVFrT3lXdE95YWxDNGdMeURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUc2xZanNuWVFnN0p5RTdaVzBJT3U1aE91d2dPdXlpTzJZdU91bHZDRHJzNERxc3IzdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHNsWWpzb0lUdGxad2c3SUtzN0pxcDdKMkVJT3ljaE8yVnRDRHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzY3Q1U2citVSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nNjdPMDdKV0lJT3lFbk91NWhPeUtwQW9LSXlNaklPcXl2ZXU1aE91bHZDRHFzSnpzaTV6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc2cks5NjdtRTY2VzhJT3lMbk95ZWtlMlZvT3E1ak95YWxEOEtDaU1qSXlEcXNyM3J1WVRycGJ3ZzdaVzA3S0NjN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPcXl2ZXU1aE91bHZDRHRsYlRzb0p6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJpdzZyaXc2ckNBSU95WXBPMlVoT3Vkdk95ZHVDRHNnNEh0ZzV6c25vWHINCmk0anJpNlF1SU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc25ZUWc3Wm1WN0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU9xNHNPcTRzT3F3Z0NEcmhLVHRpcmpzbTR6dGdhenNsNUFnN0pldzZyS3c2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyaXc2cml3N0oyWUlPeVhzT3F5c0NEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21JSHNnNEhzbllRZzY3YUk2NStzN0ppazY0cVVJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKaUI3SU9CN0oyRUlPdTJpT3Vmck95WXBPcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95M3FPeUdqTzJWbU95THBDRHFzcjNzbXJBZzdJdWc3TEt0N1pXWTdJdWdJT3VDDQp0T3lhcWV5ZGdDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdJcTE2NHVJNjR1a0xnb3RJT3kzcU95R2pPMlZtT3VwdENEc2k2RHNzcTN0bFp3ZzY0SzA3SnFwN0oyMElPeWdnT3llcGV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvQ2kwZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvSUM4ZzdMZW83SWFNN1pXWTY2bTBJT3llaGV1Z3BlMlZuQ0RyZ3JUc21xbnNuYlFnN0lLczY1Mjg3S0M0N0pxVUxnb0tJeU1qSXlEcXNJRHNuYlRyazV3ZzdKaUk3SXVjSUNoMWVDMTNjbWwwYVc1bkxtMWs3SmVRN0lTY0lPeVlydXE1Z0NEaWdKUWc2cmVjN0xtWjdKeTg2NkdjSU95ZWtPdVBtZTJabENEcnFyc2c3WldZNjRxVUlPdXN1T3llcFNEc25xenF0YXpzaExFZzdJS3M2NkdBS1FvS0l5TWpJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxczZBZzZyT0U3SXVjNjRLWTdKcVVQd290SU95ZWtPdVBtZXl3cU9xdw0KZ0NEc25vanJncGpzbXBRL0Nnb2pJeU1nNjZlazY0dXNJT3V6dE8yWG1PdWpqT3VsdkNEc2xyenJwNGpzbEtrZzY0SzA2ck9nSU9xemhPeUxuT3VDbU95YWxEOEtMU0RycDZUcmk2d2c2N08wN1plWTY2T002NHFVSU95V3ZPdW5pT3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2NnNnJDQTdLZUFJT3VMcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUNpMGc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFISU9xd2dPeW5nQ0RyaTZUc2k1d2c3Wm1WN0oyNDdaV2c2cktNN0pxVUxnb0tJeU1qSU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bFpqc2k1enFzcURzbHJUc21wUS9DaTBnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWb09xNWpPeWFsRDhLQ2lNakl5RHNpNXpzbnBIdGxaanNpNXpyaXBRZzY3YUU3SmVRNnJLTUlEVXNNREF3N0p1UTdKMkVJT3VUbk91Z3BPeWFsQzRLTFNEc2k1enNucEh0bFpqcnFiUWdOU3d3TUREc201RHMNCm5ZUWc2NU9jNjZDazdKcVVMZ29LSXlNaklPeWR0T3lla0NEdG1aanJ0b2pzbllRZzY3Q2I3SldZN0phMDdKcVVMZ290SU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRdUNnb2pJeU1nN0ppazY0cVk3SjJZSU8yQXRPeW1pT3F3Z0NEcXM2Y2c3S0tGNjZPTTY0Kzg3SnFVTGdvdElPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEM0S0NpTWpJeURxdUlqc25ienF1WXpzcDRBZzY2KzQ2NEtwSU95TG5DRHNsN0Rzc3JRZzdMS1k2NmFzNjVDcDY0dUk2NHVrTGlEdG00VHJ0b2pxc3JEc29Kd2c2cmlJN0pXaDdKMkVJT3VDcWV1MmdPMlZtT3lMbk9xNHNDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdKaWs2NHFZNnJtTTdLZUFJT3VDdE95bmdDRHNsWXJzbkx6cnFiUWc3SmV3N0xLMDY0Kzg3SnFVTGlBdklPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2tPcXlnQ0RxdUxEcXNJVHNsNURyaXBRZzdJU2M2N21FDQo3SXFrSU95ZHRPeWFxZXlkdENEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUxvT3UyaE95bW5TRHRtWlhzbmJnZzdLQ0U3SmVRNjRxVUlPeUdvZXE0aUNEcnNJOGc2ckt3N0tDYzZyQ0FJT3UyaU9xd2dPMlZxZXVMaU91THBDNEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPdXpnT3F5dlNEc2k1d2c3THFRN0l1YzY3Q3hJT3llck95bmdPcTRpZXlkZ0NEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNnNEhyaTdRZzdaS0k3S2VJSU8yV3BleURnZXlkaENEcw0KbklUdGxiUWc3WWExN1ptVUlPdUN0T3lhcWV5ZHRDRHJoYm5zbll6cmtLbnJpNGpyaTZRdUNpMGc2NDJVSU95aWkreWRnQ0RzZzRIcmk3VHNuWVFnN0p5RTdaVzBJTzJHdGUyWmxDRHJnclRzbXFuc25ZQWc2NFc1N0oyTTY0Kzg3SnFVTGdvS0l5TWpJT3F6b09xd25ldUxtT3lkbUNEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZGdDRHF1TERyb1owZzZyU0E2NmFzNjVDcDY0dUk2NHVrTGdvdElPeWR0T3lnbk91MmdPMkVzQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkdENEcXVMRHJvWjNyajd6c21wUXVDZ29qSXlNZzdMS3Q3SWFNNjRXRTdKMkFJT3lFbk91NWhPeUtwQ0Rxc0lEc25vWHNuYlFnNjdhSTZyQ0E3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc3NxM3Nob3pyaFlUc25ZUWc3SnlFN1pXY0lPeUVuT3U1aE95S3BPdUtsQ0RzbFlUc3A0RWc3S1NBNjdtRUlPeWtrZXlkdE95WGtPeWENCmxDNEtDaU1qSXlNZzZyT0U3S0NWd3Jmc25vWHJvS1VLQ2lNakl5RHNsWVRzbmJUcmxKUWc2NWlRNjRxVUlPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3lkdE95RGdTRHNucGpycXJzZzdKNkY2NkNsN1pXWTdKZXNJT3F6aE95Z2xleWR0Q0RzbnFEcXVJZ2c3TEtZNjZhczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3llbU91cXV5RHNub1hyb0tYdGxiVHNoSndnNnJPRTdLQ1Y3SjIwSU95ZW9PcXl2T3lXdE95YWxDNGdMeURydVlUcnNJRHJzb2p0bUxqcnBid2c3SjZzN0lTazdLQ1Y3WldZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNuYlRycjdnZzdJS3M3SnFwSU95a2tleWR1Q0RzbFlUc25iVHJsSlRzbm9Ycmk0anJpNlF1Q2kwZzdKMjA2Nis0SU95VHNPcXpvQ0Rzbm9qcmlwUWc3SldFN0oyMDY1U1U3SmlJN0pxVUxpQXZJT3VMcE91bHVDRHNsWVRzbmJUcmxKVHJwYndnN0o2RjY2Q2w3WlcwDQpJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNncXpzbXFudGxhQWc3SWlZSU95WGh1dUtsQ0RydVlUcnNJRHJzb2p0bUxqc25vWHJpNGpyaTZRdUlPeVlnZXVzdUN3ZzdJaXI3SjZRTENEdGlybnNpSmpyckxqc25wRHJwYndnN1krczdaV283WldZN0plc0lEanNucEFnN0oyMDdJT0JJT3llaGV1Z3BlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc21JSHJyTGdzSU95SXEreWVrQ3dnN1lxNTdJaVk2Nnk0N0o2UTY2VzhJTzJQck8yVnFPMlZ0Q0E0N0o2UUlPeWR0T3lEZ1NEc25vWHJvS1h0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95ZWhldWdwU0Rxc0lEcmlxWHRsWndnNnJpQTdKNlFJT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzdKNkY2NkNsN1pXZ0lPeUltQ0Rzbm9qcmlwUWc2cmlBN0o2UUlPeUltT3VsdkNEcmhKanNsNGpzbHJUc21wUXVJQzhnNjRLMDdKcXA3SjJFSU95aHNPcTRpQ0RzcElUc2w2d2c3S084N0lTNDdKcVVMZ29LSXlNakl5RHRqSXpzbmJ6Q3QrcXlzT3lnbk1LMw0KNnJpdzdZT0FDZ29qSXlNZzdZeU03SjI4SU95YXFldWZpZXlkdENEc3RJanFzN3pya0pqc2w0anNpclhyaTRqcmk2UXVJREV3VFVJZzdKMjA3WldZN0oyWUlPMk1qT3lkdk91bmpDRHNsNFhyb1p6cms1d2c2ckNBNjRxbDdaV3A2NHVJNjR1a0xnb3RJREV3VFVJZzdKMjA3WldZSU8yTWpPeWR2T3VuakNEc21LenJwclFnN0lpWUlPeWVpT3lXdE95YWxDNGdMeUR0akl6c25id2c3SnFwNjUrSjdKMkVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NHVrN0pxMDY2R2M2NU9jNnJDQUlPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcmk2VHNtclRyb1p6cms1enJwYndnNjZlSTdMT2s3SmEwN0pxVUxnb0tJeU1qSU9xeXNPeWduT3lYa0NEc2k2VHRqS2p0bFpqc21JRHNpclhyaTRqcmk2UXVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHFzckRzb0p6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3F5c095Z25DRHMNCmlKanJpNmpzbllRZzdabVY3SjI0N1pXWTZyT2dJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXWTdKZXNJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXp0ZXF3aE95ZGhDRHRtWlhyczdUdGxad2c2NUtrSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lFbk91NWhPeUtwQ0RzcElEcnVZUWc3S1NSN0o2RjY0dUk2NHVrTGdvdElPeWtnT3U1aE8yVm1PcXpvQ0Rzbm9qcmlwUWc2cml3NjRxbDdKMjA3SmVRN0pxVUxpQXZJT3loc09xNGlPdW5qQ0RxdUxEcmk2VHJvS1FnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3VUc2V1aG5TRHFzSURyaXFYdGxad2c3TFdjNjR5QUlPcXduT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzDQppclhyaTRqcmk2UXVDaTBnNjQyVUlPdVRzZXVobmUyVm1PdWdwT3VwdENEcXVMRHNvYlFnN1pXdDY2cXA3SjJFSU95Q3JleWduTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095MmxPcXdnQ2tLQ2lNakl5RHN0cHpyajVrZzdKcVU3TEt0N0oyMElPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0xhYzY0K1pJT3lhbE95eXJleWRoQ0Rzb0pIc2lKanRsb2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLOTY3bUVJT3lEZ2UyRG5PdWx2Q0R0bVpYc25ianRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPcXl2ZXU1aENEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4Zw0KN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3lnaE8yWm1PMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3V3bE9xL2dPcTVqT3lhbEQ4S0NpTWpJeURyc0tucnJMZ2c3SmlJN0pXOTdKMjBJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzS25yckxnZzdKaUk3Slc5N0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHJ1WVRyc0lEcnNvanRtTGdnTmUyYWpDRHNtS1RycFpqcm9ad2c2ck9FN0tDVjdKMjBJT3llb09xNGlDRHNzcGpycHF6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SURYdG1vd2c3SjZZNjZxN0lPeWVoZXVncGUyVnRPeUVuQ0RxczRUc29KWHNuYlFnN0o2ZzZySzg3SmEwN0pxVUxpQXZJT3U1aE91d2dPdXlpTzJZdU91bHZDRHNucXpzaEtUc29KWHRsWmpycWJRZzY0dWs3SXVjSU95ZHRPeWENCnFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd0lDanNsNGJzbHJUc21wUWc0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFwQ2dvakl5TWc2N080N0oyNElPeWR1T3ltbmV5ZGhDRHRsWmpzcDRBZzdKV0s3Snk4NjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEcnM3anNuYmdnN0oyNDdLYWQ3SjJFSU8yVm1PdXB0Q0RycXFqcms2QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeWR0T3VwbE95ZHZDRHNuYmpzcHAwZzdLQ0U3SmVRNjRxVUlPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95ZHRPdXBsT3lkdkNEc25ianNwcDNzbllRZzY2ZUk3TG1ZNjZtMElPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95L29PMlBzT3lkZ0NEcm9aenF0N2pzDQpuYmdnN1p1RTdKZVE2NmVNSU95Q3JPeWFxU0Rxc0lEcmlxWHRsYW5yaTRqcmk2UXVDaTBnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3kvb08yUHNPeWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJyN2pzaExIcmhZVHNucERyaXBRZzY3TzA3Wmk0N0o2UUlPdVBtZXlkbUNEc2w0YnNuYlFnNnJLdzdLQ2M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzY3TzA3Wmk0N0o2UTZyQ0FJT3VQbWV5ZG1PMlZtT3VwdENEcXNyRHNvSnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsSVRyb1p6dGxZVHNuWVFnNjVPeDY2R2Q3WldZN0tlQUlPeVZpdXljdk91cHRDRHNuYlRzbXFuc25iUWc3S0NjN1pXYzY1Q3A2NHVJNjR1a0xnb3RJTzJVaE91aG5PMlZoT3lkaENEcms3SHJvWjN0bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2xiRWc2N0tFN0tDRTdKMjBJT3VDcnV5VmhDRHNuYnpydG9BZzZyaXc2NHFsN0oyMA0KSU95Z25PMlZuT3VRcWV1TGlPdUxwQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaV1k2Nm0wSU91cXFPdVRvQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc2N2lVNjZPbzdZaXM3SXFrNnJDQUlPcTZ2T3lndUNEc25vanNsclFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPdTRsT3VqcU8ySXJPeUtwT3VsdkNEc3ZKenJxYlFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPdTVoT3lEZ1NEc2w3RHJuYjNzc3BqcXNJQWc2NU94NjZHZDY1Q1k3S2VBSU95Vml1eVZtT3lLdGV1TGlPdUxwQzRLTFNEcnVZVHNnNEVnN0pldzY1Mjk3TEtZNjZXOElPdVRzZXVobmUyVm1PdXB0Q0RxdUxUcXVJbnRsYUFnNjVXTUlPdTVvT3VsdE9xeWpDRHNsN0RybmIzcms1enJwclFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc3RwenNub1VnN0xtMDY1T2M2ckNBSU91VHNldWgNCm5ldVFtT3luZ0NEc2xZcnNsWVFnN0lLczdKcXA3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdMYWM3SjZGSU95NXRPdVRuT3VsdkNEcms3SHJvWjN0bFpqcnFiUWc2N0NVNjZHY0lPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0lDanNtWVRybzR3ZzdKV0k2NEswS1FvS0l5TWpJTzJhak95YmtPcXdnT3llaGV5ZHRDRHNtWVRybzR6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzZyQ0E3SjZGN0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHNtSWpzbGIzc25iUWc3TGVvN0lhTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeVlpT3lWdmV5ZGhDRHN0NmpzaG96dGxvanNsclRzbXBRdUNnb2pJeU1nNjZ5NDdKMlk2ckNBSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SWljN0xDbzdLQ0I3Snk4NjZHY0lPdUx0ZXV6Z091VG5PdW1yT3F5b095S3RldUxpT3VMcEM0S0xTRHJyTGpzblpqcnBid2c3S0NSN0lpWTdaYUk3SmEwDQo3SnFVTGlBdklPeUluT3lFbk91TWdPdWhuQ0RyaTdYcnM0RHJrNXpycHJUcXNvenNtcFF1Q2dvakl5TWc3SVNrN0tDVjdKMjBJT3kwaU9xNHNPMlpsT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzaEtUc29KWHNuWVFnN0xTSTZyaXc3Wm1VN1phSTdKYTA3SnFVTGdvS0l5TWpJT3U1aE91d2dPdXlpTzJZdU9xd2dDRHJzNERxc3IzcmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SU91d2xPcS9xT3lXdE95YWxDNEtDaU1qSXlEc25ianNwcDNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHVPeW1uZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNaklPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUWdLT3luaU91c3VDRHNucXpxdGF6c2hMRXBDZ29qSXlNZzdKYTQ3S0NjSU91d3FldXN1TzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEcnNLbnJyTGdnNjRLZzdLZWM2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0phMA0KNjVha0lPdXdxZXV5bGV5Y3ZPdWhuQ0RzbmJqc3BwM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0oyNDdLYWRJT3V3cWV1eWxleWRoQ0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3F5c095Z25PMlZtT3lMcENEc3ViVHJrNXpycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEcXNyRHNvSnp0bGFBZzdMbTA2NU9jNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKdVE3WldZN0l1YzY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bFpqc2hManNtcFF1Q2kwZzdKdVE3WldZNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc2ck9FN0l1ZzZyQ0E3SnFVUHdvdElPeWp2T3lHak91bHZDRHNsWXpxczZBZzdKNkk2NEtZN0pxVVB3b0tJeU1qSXlEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0FvS0l5TWpJT3E0c09xd2hDRHINCnA0enJvNHpyb1p3ZzdKMjA3SnFwN0oyMElPeWtrZXluZ091UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc25iVHNtcWtnNnJpdzZyQ0U3SjIwSU91Qm5ldUNtT3lFbkNEc3A0RHF1SWpzbllBZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0pxcDY1K0pJT3UyZ095aHNleWN2T3VobkNEc29JRHNucVhzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95Z2dPeWVwZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1Q2dvakl5TWc3WWExN0l1Z0lPeVlwT3VsbU91aG5DRHNtcFRzc3Ezc25iUWc3SXVrN1l5bzdaV1k3SmlBN0lxMTY0dUk2NHVrTGdvdElPMkd0ZXlMb095ZHRDRHNtNUR0bVp6dGxaanNwNEFnN0pXSzdKV0VJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nDQo2cmFNN1pXY0lPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0pIcXQ3enNuYlFnNnJHdzY3YUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0phMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RxdG96dGxaenNuWVFnN0pxVTdMS3Q3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nN0lPQjdabXBJT3lWaU91Q3RDQW9NdXVMcUNEcXRhenNvYkFwQ2dvakl5TWc3SjZGNjZDbDdaV1k3SXVnSU95anZPeUdqT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnNjR1azdJdWNJTzJabGV5ZHVDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdLTzg3SWFNNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU91THBPeUxuQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lhbE95eXJlMlZtT3lMb0NEdGpwanNuYlRzcDREcnBid2c3TEMrN0oyRUlPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3WTZZN0oyMDdLZUE2Nlc4SU95dw0KdnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWp2T3lHak91bHZDRHRtWlhzbmJqdGxaanFzYkRyZ3BnZzdabUk3Snk4NjZHY0lPeWR0T3VQbWUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0K1o3SjI4N1pXY0lPeWFsT3l5cmV5ZHRDRHNzcGpycHF3ZzdLU1I3SjZGNjR1STY0dWtMaURzbnFEc2k1d2c3WnVFSU8yWmxleWR1TzJWdENEc283enNpNjNzaTV6c21LUXVDaTBnNnJDWjdKMkFJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpxczZBZzdKNkk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJUcnNxVHRpcmpxc0lBZzdLS0Y2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHRPdXlwTzJLdU9xd2dDRHJnWjNyZ3F6c2xyVHNtcFF1Q2dvakl5TWc3WU9JN1llMElPeUxuQ0RycXFqcms2QWc2NDJ3N0oyMDdZU3c2ckNBSU95Q3JleWduT3VRbU91cHNDRHJzN1hxdGF6dGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEsNCkxTRHRnNGp0aDdUdGxaanJxYlFnNjZxbzY1T2dJT3VOc095ZHRPMkVzT3F3Z0NEc2dxM3NvSnpya0pqcXM2QWc2NHVrN0l1Y0lPdVFtT3VQak91bXRDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWdsZXVua0NEdGc0anRoN1R0bGFEcXVZenNtcFEvQ2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3lEZ2UyWnFTRHNsWWpyZ3JRcENnb2pJeU1nNjdhQTdKNnNJT3lra1NEcnNLbnJyTGpzbnBEcXNJQWc2ckNRN0tlQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTJnT3llckNEc3BKSHNsNUFnNjdDcDY2eTQ3SjZRNnJDQUlPeWVpT3lYaU95V3RPeWFsQzRnTHlEc21JSHNnNEhzbllRZzdabVY3SjI0N1pXMElPdXp0T3lFdU95YWxDNEtDaU1qSXlEcXNyM3J1WVFnN1pXMDdLQ2NJT3Eyak8yVm5PeWR0Q0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cks5NjdtRUlPMlZ0T3lnbkNEcXRvenRsWnpzbmJRZzdaV0U3SnFVN1pXMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RzbXBUc3NxM3RsYlFnDQo3S084N0lTNDdKcVVMZ29LSXlNaklPMlpsT3llckNEcXNKRHNwNERxdUxBZzY3Q3c3WVN3NjZhczZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNEtMU0R0bVpUc25xd2c2ckNRN0tlQTZyaXdJT3V3c08yRXNPdW1yT3F3Z0NEc2xyenJwNGdnN0plRzdKYTA3SnFVTGlBdklPdXdzTzJFc091bXJPdWx2Q0RxdFpEc3NyVHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzdHBYc2xiMGdLeURxdUkzc29KVWc3S0NFN1ptWUlDanJrWkFnNjZ5NDdKNmxJT0tHa2lEcXVJM3NvSlh0bUpVZzdaV2NJT3VzdU95ZXBTa0tDaU1qSXlEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcg0Kc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bUp6dGc1MGc3SmVHN0oyMElPcXdnT3llaGUyVm9PcTVqT3lhbEQ4ZzdLZUE2cmlJSU95TG9PeXlyZTJWbU95bmdDRHNsWXJzbkx6cnFiUWc3SnV3N0x1MElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc3A0RHF1SWdnN0l1ZzdMS3Q3WldZNjZtMElPeWJzT3k3dENEdG1KenRnNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdMK2c3WSt3SU95WGh1eWR0Q0Rxc3JEc29KenRsYURxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdUNEc3Y2RHRqN0RzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVDaTBnN0wrZzdZK3c3SjJFSU91d20reWN2T3VwdENEcmpaUWc3S0NBNjZDMDdaV1k2cktNSU9xeXNPeWduTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEc2w0YnNuYlFnN0l1YzdKNlI3WldnNnJtTTdKcVUNClB5RHNsWXpycHJ6c25ZUWc3THljN0tlQUlPeVZpdXljdk91cHRDRHNwSkhzbXBUdGxad2c3SWFNN0l1ZDdKMkVJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPeVZqT3Vtdk95ZGhDRHN2SnpycWJRZzdLU1I3SnFVN1pXY0lPeUdqT3lMbmV5ZGhDRHJzSlRyb1p3ZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdKNlE2NCtaN0oyMDdMSzA2Nlc4SU91VHNldWhuZTJWbU95bmdDRHNsWXJxczZBZzY0U1k3SmEwNnJDSTZybU03SnFVUHlEcms3SHJvWjN0bFpqc3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNucERyajVuc25iVHNzclRycGJ3ZzY1T3g2NkdkN1pXWTY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURyczdnZzZyT0U3Slc5N0oyWUlPeWNvT3lkdk8yVm5DRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95ZHZPdXdtT3EwZ091bXJPeWVrT3VoDQpuQ0RxdG96dGxaenJzNERxc3Izc25ZUWc3WldZN0l1a0lPeUltQ0RzbDRic2xyVHNtcFF1SU95ZHZPdXdtQ0RxdElEcnBxenNucERyb1p3ZzZyYU03WldjSU91emdPcXl2ZXlkaENEc201RHRsWmpzaTZRZzZySzk3SnF3SU91THBPdWx1Q0RzZ3F6cm5venNsNURxc293ZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtDRHF0b3p0bFp6c25ZUWc3S2VBN0tDVjdaVzBJT3lqdk95TG9DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZuQ0Rya3FRZzdKMjg2N0NZSU9xMGdPdW1yT3lla091aG5DRHJzNERxc3IzdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXpnT3F5dmUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvPQ0KOjpHVUlERTo6DQpJeUJWV0NCWGNtbDBhVzVuSU9xd2dPeWR0T3VUbkFvS0l5TWdNUzRnN1pXMDdKcVU3TEswQ2dyc29KenRrb2dnN0pXSTdKMllJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWdKKzJWdE95YWxPeXl0Q2Zyb1p3ZzdJMm83SnFVTGdyc25ienF0SURzaExFZzdKNkk2NHFVSU95Q3JPeWFxZXlla0NEcXNyM3RsNWpzbllRZzY2ZU02NU9rSU95SW1DRHNub2pyajRUcm9aMGdLaXJzZzRIdG1ha3NJT3VucGV1ZHZleWRoQ0RydG9qcnJManRsWmpxczZBZzY2cW82NU9nSU91c3VPcTFyT3lYa0NEdGxiVHNtcFRzc3JUcnBid2c3S0NCN0pxcDdaVzA3S084N0lTNDdKcVVMaW9xQ2dyc21JZ3BDaTBnNjdPMDY0T0Y2NHVJNjR1a0lPS0draURyczdUcmdyenFzb3pzbXBRS0Npb3FLZ29LSXlNZ01pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzQW9LN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RzdFp6cmpJRHRsWndnS2lycmlxWHJqNW50bUpVZzY2eTQ3SjZsS2lyc25ZUWc3STJvN0tPODdJUzQ3SnFVTGlEc2lKanJqNW50bUpVZw0KNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVEV0N0lpWTY0K1o3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzazdEcmlwUWc2cktNSU95aWkreVZoT3lhbEM0S0NpTWpJeURya0pEc2xyVHNtcFFnNG9hU0lPMldpT3lXdE95YWxBb0s3SmlJS1FvdElPeUVwT3lnbGV1UWtPeVd0T3lhbENEaWhwSWc3SVNrN0tDVjdaYUk3SmEwN0pxVUNnb2pJeU1nSjM3c2w0Z25JT3U1dk9xNHNBb0s3SmlJS1FvdElPdXdsT3VBak95WGlPeVd0T3lhbENEaWhwSWc2N0NVNnIrbzdKYTA3SnFVQ2dvakl5TWc2NCtaN0lLc0lPdXdsT3EvbE95VHNPcTRzQW9LN0ppSUtRb3RJT3VHa3V5VmhPeWhqT3lXdE95YWxDRGlocElnN0ppczY1NlE3SmEwN0pxVUNnb3FLaW9LQ2lNaklETXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFLQ3V5Z25PMlNpQ0RzbFlqc2w1RHNoSndnNjdhQTdLQ1Y3S0NCSU95N3BPdXUNCnBPdUxpT3k4Z095ZHRPeUZtT3lkaENEc3RaenJqSUR0bFp3ZzdLU0U3SjIwNnJPZ0lPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvN0tPODdJUzQ3SnFVTGdycnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRNdDY3YUE3S0NWN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2phanNtcFF1Q2dyc21JZ2dPaURzbFlnZzY0Kzg3SnFVTENEc2w0YnNsclRzbXBRZ0tGZ3BJT0tHa2lCKzdaV1k2Nm0wSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVSUNoUEtRb0tJeU1qSU95WGh1eVd0T3lhbENEaWhwSWc3SjZJN0phMDdKcVVDZ3JzbUlncENpMGc2N08wN1ppNDdKNlE2ckNBSU8yWGlPdWR2ZTJWbU9xNHNDRHNvSVRzbDVEcmlwUWc2ckNBN0o2RjdaV2dJT3lJbUNEc2w0YnNsclRzbXBRZzRvYVNJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBDQo3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFLQ2lNakl5RHNsNURybjZ3ZzY2bVU3SXVjN0tlQUNncnNsNURybjZ3ZzdJT0I3Wm1wN0plUTdJU2M2NCtFSUNMdGxiVHFzckFnNjdDcDY3S1ZJdXlkaENEcnFMenNvSUFnN0pXTTY2Q2s3S084NjRxVUlPcTRqZXlnbGUyWWxTRHF0YXpzb2JEcm9ad2c3STJvN0pxVUxnb0s3SmlJS1FvdElPeW5nT3E0aUNEcnNvVHNvSVRzbDVEc2hKenJpcFFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95VnNleWRoQ0RzdFp6c2k2QWc2N0tFN0tDRTdKeTg2NkdjSU95WGhldU5zT3lkdE8yS3VDRHRsYlRzbzd6c2hManNtcFF1SU9LR2tpRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwN0tPODdJUzQ3SnFVTGlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDam82T2lCMGFYQWc3WXlkN0plRklPdXloTzJLdk95ZA0KZ0NCYk9DNGc3WXlkN0plRlhTRHF0NXpzdVpuc25ZUWc2NVN3NjUyODdKcVVDdTJNbmV5WGhTanJpNlRzbmJUc2xyenJvWnpxdDdncElPdXloTzJLdkNEcnJManF0YXpyaXBRZzdKV0U2NTZZSUNvcU9DNGc3WXlkN0plRktpb2c3SVM1N0lXWUlPcTNuT3k1bWV5ZGhDRHJsTERybmJ6c21wUWc0b0NVSU8yR3RldXp0T3VLbENCYjdabVY3SjI0WFN3ZzdKaUlMK3lWaE91TGlPeVlwQ0R0akpEcmk2anNuWUFnVyt5VmhPdUxpT3lZcEYzQ3QxdnJoS1JkTENEcmo1bnNucEVnN0p5ZzY0K0U2NHFVSUZ2c3Q2anNob3hkd3JkYjY0K1o3SjZSWFM0Z0l1eTNxT3lHakNMcmlwUWc2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNSU95VHNPcXpvQ3dnSXV1THErcTRzQ0RDdHlEcmo1bnNucEVpN0xLWTY1KzhJT3lubmV5ZHRDRHNsWWdnNjZlZTY0cVVJT3loc08yVnFleWRnQ0RzazdEc3A0QWc3SldLN0pXRTdKcVVMZ282T2pvS0NpTWpJeUR0bUp6dGc1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnMNCm5ZUWc2NVdNQ2dyc21JZ3BDaTBnNjZxbzdKNkU3S2VBN0p1UTZyaUlJT3lYaHV5ZHRDRHJxcWpzbm9UdGhyWHNucVhzbllRZzY2ZU02NU9rNnJtTTdKcVVQeURzcDREcXVJZ2c2N0NiN0tlQUlPeVZpdXljdk91cHRDRHJxcWpzbm9Uc3A0RHNtNURxdUlqc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1SU9LR2tpRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnNjR5QTdJT0JJT3lWaU91Q3RBb0tLaXJzaEp6cnVZVHNpcVRyaXBRZzdKTzRJT3lJbUNEc25vanNwNERycDR3c0lPMkt1ZXlnbFNEdG1KenRnNTNzbllBZzY3Q2I3SjJFSU95SW1DRHNsNGJzbllRZzY1V01JT0tHa2lEcXVJM3NvSlh0bUpVZzY2eTQ3SjZsN0p5ODY2R2NJT3lOcU95YWxDNHFLZ3JzZ3F6c21xbnNucERyaXBRZzY2eTQ2cldzNjZXOElPcTh2T3E4dk8yZWlDRHNuYjNzcDRBZzdKV0s2ck9nDQpJTzJia2V5V3RPdXp0T3E0c0Nqc2lxVHN1cFFwSU91VmpPdXN1T3lYa0N3ZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU95VHNPdXB0Q0Rzb0p6dGtvZ2c3S0NFN0xLMDY2VzhJT3lUdUNEc2lKZ2c3SmVHNjR1azZyT2dJT3lZcE8yVnRPMlZtT3E0c0NEc2lhenNtNHpzbXBRdUNncnNtSWdwQ2kwZzZyT0U3S0tNSU9xd25PeUVwQ0R0bUp6dGc1M3NuWUFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUlPS0draUEwTGpVbElPcTRpT3VtckNEdG1KenRnNTNycDR3ZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29xS2lvS0NpTWpJRFF1SU95NmtPeWp2T3lXdk8yVm5DRHFzcjNzbHJRS0N1eWduTzJTaUNEc2xZanNsNURzaEp3Z0ozN3NpNXpxc3FEc2xyVHNtcFEvSnl3Z0oreUxuT3VDbU95YWxEOG5MQ0FuZnVxN21DY2c2ckNaN0oyQUlPcXp2T3VQaE8yVm5DRHFzcjNzbHJUcnBid2c3Sk93N0tlQUlPeVZpdXlWaE95YWxDNEs3TFdjNjR5QTdaV2NJT3k2a095anZPeVd2TzJWbU9xem9DRHN1WnpxdDd6dA0KbFp3ZzY2ZVE3WWlzNjZXOElPeVRzT3VLbENEcXNvd2c3S0tMN0pXRTdKcVVMZ3Jxc3Izc2xyVHJpcFFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNaTNxc3Izc2xyVHJwYnd0N0kybzY0K0VMZXVRbU91S2xDM3FzcjNzbXJBcDdKZVFJTzJWdE91THVlMlZvQ0RybFl6cnA0d2c3STJvN0pxVUxnb0tJeU1qSU91UG1leUNyT3lYa095RW5DQW5mdXlMbkNjZzY3bTg2cml3Q2dyc21JZ3BDaTBnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWbU95TG5PcXlvT3lXdE95YWxEOGc0b2FTSU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bGFEcXVZenNtcFEvQ2kwZzdJdWM3SjZSN1pXWTdJdWM2NHFVSU91MmhPeVhrT3F5akNBMUxEQXdNT3lia095ZGhDRHJrNXpyb0tUc21wUXVJT0tHa2lEc2k1enNucEh0bFpqcnFiUWdOU3d3TUREc201RHNuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJQ2ZxczRUc2k1enJpNlFuSU9LR2tpQW43SjZJNjR1a0p3b0s3SmlJS1FvdElPeWVrT3VQbWV5d3FPdWx2Q0Rxc0lEc3A0RHENCnM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc3SjZRNjQrWjdMQ282ckNBSU95ZWlPdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTUlPeVd2T3VuaU95VXFTRHJnclRxczZBZzZyT0U3SXVjNjRLWTdKcVVQeURpaHBJZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91S2xDRHNscnpycDRqc25ianFzSURzbXBRL0lDb282NHVvN0lpY0lPeTVtTzJabU95ZHRDRHNsWVRyaTRqcm5id2c2Nnk0N0o2bDdKMkVJT3lEaU91aG5DRHNrN1FnN0lLczY2R0E3SmlJN0pxVUtTb0tDaU1qSXlBbjdKZXM3SzJJNjR1a0p5RGlocElnSisyWmxleWR1TzJWbU91THBDd2c2Nnk3NjR1a0p3b0s3SmlJS1FvdElPeVZpT3lnaE8yVm5DRHFzSnp0aHJYc25ZUWc3SnlFN1pXMElPdXFoK3F3Z095bmdDRHJpNlRzaTV3ZzdKZXM3SzJrNjdPODZyS003SnFVTGlEaWhwSWc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFINnJDQTdLZUFJT3VMcE95TG5DRHRtWlhzbmJqdGxhRHFzb3pzbXBRdUNnb2pJeU1nDQpKK3E3bUNjZzRvYVNJQ2ZzbDVEcXNvd25DZ3JzbUlncENpMGc3Wm1ONnJpNDY0K1o2NHVZNnJ1WUlPdUNvT3lWaE9xd2dPcXpvQ0Rzbm9qc2xyVHNtcFF1SU9LR2tpRHRtWTNxdUxqcmo1bnJpNWpzbDVEcXNvd2c2NEtnN0pXRTZyQ0E2ck9nSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURxc3Izc2xyVHJwYndnNjdxUTdKMkVJT3VWakNEc2xyVHNnNG50bFp3ZzZySzk3SnF3Q2dyc2dxenNtcW5zbnBEc25aZ2c3S0NWNjdPMDY2VzhJT3V3bSt1S2xDRHNwNGpyckxqc2w1RHNoSndnNnJpdzZyT0U3S0NCN0p5ODY2R2NJQ2QrN0l1Y0ordWx2Q0RydXBEc25ZUWc2NVdNSU91c3VPeWVwZXlkdENEc2xyVHNnNG50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLS2lydGpJenNsWVh0bFpqcXM2QWc3SXUyN0oyQUlPeWdsZXV6dE91bHZDQW43S084N0phMEordWhuQ0RzamFqc2hKd2c2Nnk0N0o2bDdKMkVJT3lEaU91aHJlcXlqQ0RzamFqcnM3VHNoTGpzbXBRdUtpb0tDdXlZaUNrS0xTRHNsclRybHFRZzY2cXA3S0NCN0p5OA0KNjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhnNG9hU0lPdU1nT3kybkNEcnFxbnNvSUhzbmJRZzY2eTA3SmVIN0oyNDZyQ0E3SnFVUHdvdElPeVd0T3VXcENEc25iVHNuS0Ryb1p3ZzdJdWc2ck9nN1pXWTdJdWM2NEtZN0pxVVB5RGlocElnN0l1ZzZyT2dJT3lkdE95Y29PdWx2Q0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0tpb3FDZ29qSXlBMUxpQW5lK3VxaGV5Q3JIMGdLeUI3NjZxRjdJS3NmU2NnN0pPdzdLZUFJT3lWaXVxNHNBb0tJeU1qSU8yVm5PeWVrT3lXdENEdGtvRHNsclRzazdEcXVMQUtDdTJWbk95ZWtPeVd0Q0RycW9Yc2dxenJwYndnN1pLQTdKYTA3SVNjSU91UG1leUNyQ0R0bUpYdGc1enJvWndnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBRZzRvYVNJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFFLTFNEcmdyVHNuYndnN0xtMDY1T2M2ckNTN0oyMElPcXkNCnNPeWduT3VRb0NEc21JanNvSlhzbmJUc2w1RHNtcFFnNG9hU0lPdUN0T3lkdk95ZGdDRHN1YlRyazV6cXNKSWc2NEtZNnJDQTY0cVVJT3VDb095ZHRPeVhrT3lhbEFvS0l5TWpJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclRzazdEcXVMQWc3SmEwNjZDazdKcTRJT3F5dmV5YXNBb0tKM3ZycW9Yc2dxeDk2ckNBSUh2cnFvWHNncXg5N1pXMDdJU2NKeUR0bUpYdGc1enJvWnpycDR3ZzdaS0E3SmEwN0tTWTY0K0VJT3VObENEc3VwRHNvN3pzbHJ6dGxaanFzb3dnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0o2VTdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVSU9LR2tpRHNucFRzbGFIc25iUWc2N2FBN0tHeDdaVzA3SVNjSU9xMXJPdW5wTzJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFFLQ2lvcUtnb0tJeU1nTmk0ZzdaR2M2cml3SU8yR3RleWR2QW9LSXlNaklPdVFtT3lXdE95YWxDQW9XQ2tnNG9hU0lPdVB2T3lhbENBb1R5a0tDdXVxDQpxT3V3bE95ZHZDRHRtWlRycWJUc25aZ2c3S0tCN0oyQUlPcXp0ZXF3aE95ZGhDRHFzNkRyb0tUdGxiUWdKK3VRbU95V3RPeWFsQ2ZyaXBRZzY2cW82NUdRSUNmcmo3enNtcFFuNjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc283enNoTGpzbXBRdUNnb3FLaW9LQ2lNaklEY3VJT3VDb095bm5NSzM3SXVjNnJDRXdyZnNpS3ZzbnBBZzdaR2M2cml3Q2dycmdxRHNwNXpDdCt5TG5PcXdoTUszNjdLSTdaaTQ2NHFVSU95VmhPdWVtQ0R0bUpYc2k1M3NuTHpyb1p3ZzdZYTE3SjI4N1pXMDdJU2NJT3lOcU95YWxDNEtDaU1qSXlEcmdxRHNwNXpDdCt5TG5PcXdoTUszNnJpdzZyQ0VDZ3A4SU8yVnJldXFxU0I4SU8yWWxleUxuU0I4SU95WWlPeUxuQ0I4Q253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd0tmQ0RyZ3FEc3A1d2dmQ0RxdUxEcnM3Z2dZRmxaV1ZrdVRVMHVSRVJnSUM4ZzdLZW42cktNSUdCTlRTNUVSR0FnZkNBeU1ESTFMakF4TGpBeExDQXlOUzR3TVM0d01TQjhDbndnN0l1YzZyQ0VJSHdnNnJpdw0KNjdPNElHQklTRHBOVFRwVFUyQWdMeURzcDZmcXNvd2dZRWhJT2sxTllDQW83SmlrN0tDRUwreVlwTzJiaENEc2xZZ2c3SlNBS1NCOElERTBPak13T2pFeExDQXhNem96TUNCOENud2c2cml3NnJDRUlId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVmbGxaV1ZrdVRVMHVSRVJnSUM4ZzdLZW42cktNSUdCWldWbFpMazFOTGtSRWZrMU5Ma1JFWUNCOElESXdNalV1TURFdU1ERitNakF5TlM0d01TNHpNU3dnTWpBeU5TNHdNUzR3TVg0d01TNHpNU0I4Q253ZzY0S2c3S2VjSUNzZzdJdWM2ckNFSUh3Z1lGbFpXVmt1VFUwdVJFUWdTRWc2VFUxZ0lId2dNakF5TlM0d01TNHdNU0F4TkRvek1DQjhDbndnN0pxVTdKMjhJSHdnWUZsWldWa3VUVTB1UkVRbzdKcVU3SjI4S1dBZzRvQ1VJT3libEMvdG1aUXY3SWlZTCt1cXFTL3F1SWd2N1lhZ0wreWR2Q0I4SURJd01qVXVNREV1TURFbzdJaVlLU0I4Q2dvcUt1eUxuT3F3aENEc21JanNtYmdxS2pvZzdJS3M3SnFwN0o2UTZyQ0FJT3luZ2V5Z2tTRHFzNkRycGJUcmlwUWcNCjY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSUdEc21LVHNvSVF2N0ppazdadUVJRWc2VFUxZzdKMkVJT3lOcU91UGhDRHJqN3pzbXBRdUN1eVlpQ2tnN0ppazdadUVJREU2TURBS0NpTWpJeURyckxqc25xVWc3SWFOSU95WHNPeWJsT3lkdkFvSzY2eTQ3SjZsSU95VmlPeVhrT3lFbk91S2xDQXFLdXlibE1LMzdKMjhJT3lWbnV5ZG1DQXc3SjJFSU91NXZPcXpvQ29xSU95TnFPeWFsQzRLQ3V5WWlDa0tMU0F5TURJMjY0V0VJREE0N0p1VUlEQTE3SjI4SU95ZWhldUxpT3VMcEM0ZzRvYVNJREl3TWpicmhZUWdPT3libENBMTdKMjhJT3llaGV1TGlPdUxwQzRLQ2lNakl5RHNnNEhyaklBZzdJdWM2ckNFSUNqcmhianN0cHpzbXFrcENncDhJT3loc09xeHRDQjhJTzJSbk9xNHNDQjhDbnd0TFMwdExTMThMUzB0TFMwdGZBcDhJRFl3N0xTSUlPdXZ1T3VuakNCOElPdXdxZXE0aUNEc29JUWdmQXA4SURZdzY3YUVJT3V2dU91bmpDQjhJRTdydG9RZzdLQ0VJSHdLZkNBeU5PeUxuT3F3aENEcnI3anJwNHdnDQpmQ0JPN0l1YzZyQ0VJT3lnaENCOENud2dNekRzbmJ3ZzY2KzQ2NmVNSUh3Z1R1eWR2Q0Rzb0lRZ2ZBcDhJREV5NnJDYzdKdVVJT3V2dU91bmpDQjhJRTdxc0p6c201UWc3S0NFSUh3S2ZDQXhNdXF3bk95YmxDRHNuYlRzZzRFZ2ZDQk82NFdFSU95Z2hDQjhDZ3JzbUlncElPdXdxZXE0aUNEc29JUXNJRFhydG9RZzdLQ0VMQ0F5N0l1YzZyQ0VJT3lnaEN3Z00reWR2Q0Rzb0lRc0lEYnFzSnpzbTVRZzdLQ0VMQ0F5NjRXRUlPeWdoQW9LSXlNaklPdW5pT3F3a01LMzZyaXc2ckNFSU91bmpPdWpqQW9LWUVRdFRtQW9UdXlkdkNEcmdxanNuWXdwSUM4Z1lFUXRNR0FvN0ppazY0cVlJT3VuaU9xd2tDa2dMeUJnUkN0T1lDaE83SjI4SU9xeXZlcXp2Q2tLN0ppSUtTQkVMVGNzSUVRdE1Td2dSQzB3TENCRUt6RUtDaU1qSXlEcnNvanRtTGdnN1pHYzZyaXdJQ2p0bFpqc25iVHRsSWpzbkx6cm9ad2c2cldzNjdhRUtRb0tmQ0R0bGEzcnFxa2dmQ0R0bUpYc2k1MGdmQ0RzbUlqc2k1d2dmQXA4TFMwdExTMHRmQzB0TFMwdA0KTFh3dExTMHRMUzE4Q253ZzdLQ0U3Wm1VNjdLSTdaaTRJSHdnN1pXWTdKMjA3WlNJSU9xMXJPdTJoQ0I4SURBeUxURXlNelF0TlRZM09Dd2dNREV3TFRFeU16UXROVFkzT0NCOENud2c3TG0wNjVPYzY3S0k3Wmk0SUh3Z05PeWVrT3Vtck95VXFTRHRsWmpzbmJUdGxJZ2dmQ0F4TWpNMExUVTJOemd0T1RBeE1pMHpORFUySUh3S2ZDRHFzNFRzb296cnNvanRtTGdnZkNEdGxaanNuYlR0bElnZzZyV3M2N2FFSUh3Z01USXpMVFExTmkwM09Ea3dNVElnZkFwOElPeWp2T3V2dk91VHNldWhuZXV5aU8yWXVDQjhJT3lWbmlBMjdKNlE2NmFzTGV1U3BDQTM3SjZRNjZhc0lId2dNVEl6TkRVMkxURXlNelExTmpjZ2ZBcDhJT3lDck95WGhleWVrT3VUc2V1aG5ldXlpTzJZdUNCOElERXc3SjZRNjZhc0lPMlZtT3lkdE8yVWlDQjhJREF4TFRJek5DMDFOamM0T1NCOENnb2pJeU1nN0pPdzY2bTBJT3lWaUNEcmtKanJpcFFnN1pHYzZyaXdDZ290SU91Q29PeW5uT3lYa0NEdGxaanNuYlR0bElqQ3QrdTVsK3E0aURvZzRwMk0NCklESXdNalV0TURFdE1ERXNJREF4THpBeENpMGc3SXVjNnJDRTdKZVFJT3lZcE95Z2hDL3NtS1R0bTRRNklPS2RqQ0RzbUtUc29JUWdNZXlMbkNBcUtPdUxxQ3dnN0lLczdKcXA3SjZRNnJDQUlPeW5nZXlna1NEcXM2RHJwYlRyaXBRZzY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSU95WWlPeVp1Q2txQ2dvcUtpb0tDaU1qSURndUlPMk1uZXlYaFNqcmk2VHNuYlRzbHJ6cm9aenF0N2dwQ2dydGpKM3NsNFVnNjZ5NDZyV3M2NHFVSUNvcTdKZXQ3WldnS2lvbzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdkNucXM3d2dLaXJzbktEdG1KVXFLaWp0aHJYcnM3UXY3WXlRNjR1b0tleVhrQ0RybExEcm5id2c2Nnk0N0xLMDZyQ0FJT3VMck91ZHZPeWFsQzRnN1lPQTdKMjA3WXVBN0oyRUlPdUxwT3VUck95ZGhDRHJsWkFnNjdDWTY1T2M3SXVjSU95VmlPdUN0Q2pyczdqcnJMZ3A2cm1NN0tlQUlPcXdtZXlkdENEcnM3VHFzNkFzSU91enVPdXN1Q0RycDZYcm5iM3NuWVFnNjR1MDdKV0U3Slc4DQpJTzJWdE95YWxDNEtDaU1qSXlBdzY0dW82ck9FSU9LQWxDRHRpcmpycHF6cXNiRHJ0b0R0aExBZzY3U1E3SnFVQ2dydGpKM3NsNFhzbmJRZzdJS3M3SnFwN0o2UTdKMllJT3lXdE91V3BDRHRsb25yajVrZzY1S2s3SmVRSU91Y3FPdUtsT3luZ0NEcnFMenNvSUFnN1l5TTdKV0Y3WlcwN0pxVUxnb0tMU0R0bG9ucmo1bnNuWVFnS2lycXNJRHJvWnpycDRucXNiRHJncGdnN1l5UTY0dW83SjJFSU95YWxPcTFyQ29xS095ZHRPMkRpTUszN0lLdDdLQ2N3cmZyb1p6cXQ3anNsWVRzbTRQQ3QreWloZXVqakNrZzRvYVNJQ29xN1l5UTY0dW83WmlWS2lvZ0tPdXN2T3lXdE91MGtPeWFsQ2tLTFNEcXNyRHFzN3pDdCt5RGdlMkRuT3VsdkNBcUt1Mkd0ZXV6dE91bmpDb3FJQ2pzbVlUcm80ekN0K3lMcE8yTXFDa2c0b2FTSUNvcTdKV0k2NEswN1ppVktpb2dLT3lWak91Z3BPeWttT3lhbENrS0NpTWpJeUR0ZzREc25iVHRpNEFnNG9DVUlPeW5wK3lkZ0NEcnFvWHNncXpxdGF3S0NpMGc2NnFGN0lLczdaaVY3Snk4NjZHYw0KSU91Qm5ldUN0T3lhbEM0ZzdLS0Y2ckt3N0phMDY2KzR3cmZycDRqc3VhanRrWnpycGJ3ZzdKT3c3S2VBSU95Vml1eVZoT3lhbENBb2Z1eWFsQ0F2SUg3cmk2UWdMeUIrNnJtTTdKcVVQeURpbll3cExnb3RJREorTk95V3RPeWdpT3VobkNEc3A2ZnFzNkFnN0ltOTZyS01MaUR0bFp6c25wRHNsclRDdCt5SW1PeUxuZXlkaENEcXVManFzb3dnN0l5VDdLZUFJT3lWaXV5VmhPeWFsQzRLTFNEc2xZanJnclFvNjdPNDY2eTRLU0RycDZYcm5iM3NuWVFnN0pxVTdKVzk3WlcwTENBcUt1MkRnT3lkdE8yTGdPdW5qQ0RydEpEcmo0UWc2NnkwN0lxb0lPMk1uZXlYaGV5ZHVPeW5nQ29xSU95VmpPcXlqQ0R0bGJUc21wUXVJT3lia091enVPeWR0Q0FuN0pXTTY2YTh3cmZ0bVpYc25iZ243TEtZNjUrOElPdW5pZXlYc08yVm1PdXB0Q0RyczdqcnJManNuWVFnNnJlODZyR3c2NkdjSU9xMXJPeXl0TzJabE8yVnRPeWFsQzRLQ253ZzdKMjA2NkNINnJLTUlPdW5rT3F6b0NCOElPeWR0T3VnaCtxeWpDQjhDbnd0TFMxOExTMHQNCmZBcDhJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnFzNkFnNjRLWTZyQ0E3SXVjNnJLZzdKYTA3SnFVUHlCOElPeWdnT3llcFNEc2xZZ2c3WldjSU91Q3RPeWFxU0I4Q253ZzdKV002NmE4SUh3ZzZyS3c3S0NjSU95WmhPdWpqQ0I4Q253ZzdLQ1Y2NmVRSU95Q3JleWduTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhnZkNEcmpiRHNuYlR0aExBZzdJS3Q3S0NjSUh3S0NpTWpJeURzbFlqcmdyUW82N080NjZ5NEtTRGlnSlFnN1pXMDdKcVU3TEswQ2dvdElDb3E3WXlRNjR1bzdaaVZLaXJzbllBZ0ozN3RsYURxdVl6c21wUS9KK3VobkNEcnJMenNsclRzbXBRdUlPdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3ljaE8yWG1DanNncTNzb0p6Q3QrMkRpTzJIdENEcms3RXA3SjJBSU9xeXNPcXp2T3VsdkNEcnFMenNvSUFnNnJLOTZyT2c3WlcwN0pxVUxnb3RJQ29xN0pXSTY0SzA3WmlWS2lyc25ZQWc3SUtzN0l1azdKMkVJT3lFbk95SW9PMlZ0T3lhbEM0S0xTRHJwNGpzdWFqdGtaenJwYndnN0kybzdKcVVMaURzDQppS3ZzbnBEQ3QreWhzT3F4dENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzBJT3VUc1Nuc25ZQWc2cmU0NjR5QTY2R2NJT3VSa09xem9Dd2c3SnVRNjZ5NDdKZVFJT3lYaHV1S2xDRHNvSlhyczdUQ3QreWdpT3l3cU1LMzdKZXc2NTI5N0xLWTY2VzhJT3luZ095V3RPdUN0T3luZ0NEc2xZcnNsWVRzbXBRdUNnb2pJeU1nNjdLRTdZcThJT0tBbENEc2xZanJnclFnNjZ5NDY2ZWw3SjIwSU95Z2xlMlZ0T3lhbEFvS2ZDRHJzN2pyckxqc25iUWc3SjIwNjZDSDY0dWtJSHdnNjdLRTdZcThJSHdLZkMwdExYd3RMUzE4Q253ZzZyS3c2ck84d3Jmc2c0SHRnNXpycGJ3ZzdZYTE2N08wSUh3Z1crMlpsZXlkdUYwZ2ZBcDhJQ2QrN1pXZzZybU03SnFVUHlmcm9ad2c2Nnk4N0oyTUlId2dXK3lWaE91TGlPeVlwRjBnd3JjZ1crdUVwRjBnZkFwOElPeURnZTJacVNEc2hKenNpS0FnS3lEc21LVHJwYmpzcXIzc25iUWc3SXVrN0tDY0lPdVBtZXlla1NCOElGdnN0NmpzaG94ZElNSzNJRnQ3NjQrWjdKNlJmVjBnZkFvSw0KTFNBbjdMZW83SWFNSit1S2xDQXFLdXVQbWV5ZWtTRHJzb1R0aXJ6cXM3d2c3S2VkN0oyOElPdVZqT3VuakNvcUlPeU5xT3lhbENBbzdKaUlPaUJiN0xlbzdJYU1YY0szVyt5Q3JleWduRjBwTGlBbjY0dXI2cml3SU1LM0lPdVBtZXlla1Nmc3NwanJuN3dnN0tlZDdKMjBJT3lWaUNEcnA1N3JpcFFnN0tHdzdaV3A3SjIwNjRLWUlPdUxxT3VQaFNBbjdMZW83SWFNSit1S2xDRHNrN0RzcDRBZzdKV0s3SldFN0pxVUxnb3RJT3V5aE8yS3ZPeWRtQ0RyajVuc25wRWc3SjIwNjZhRTdKMkFJTzJabE91cHRDRHF1TERyaXFYcnFvVW82N09BNnJLOXdyZnRsYlRzb0p3ZzY1T3hLZXlkaENEcXQ3anJqSURyb1p3ZzdJSzA2NkNrN0pxVUxnb0tJeU1qSU8yR3RleW5uQ0RzbUlqc2k1d0tDaW9xN1l5UTY0dW83WmlWSU9LQWxDRHNuYlR0ZzRncUtnb3RJTzJEZ095ZHRPMkxnRG9nN0tDQTdKNmxJT3lWaUNEdGxad2c2NEswN0pxcENpMGc3SldJNjRLME9pRHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTUNCmpPeWFsRDhnN0o2RjY2Q2w3WldjSU91Q3RPeWFxZXlkdENEc2dxenJuYnpzb0xqc21wUXVDaTBnNjdLRTdZcThPaURzbFlUcmk0anNtS1Fnd3JjZzY0U2tDZ29xS3UyTWtPdUxxTzJZbFNEaWdKUWc3SUt0N0tDY0lDanNuSVR0bDVncEtpb0tMU0R0ZzREc25iVHRpNEE2SU91TnNPeWR0TzJFc0NEc2dxM3NvSndLTFNEc2xZanJnclE2SU95Q3JleWduTzJWbU91cHRDRHJpNlRzaTV3ZzdJSzA2NmEwSU95SW1DRHNsNGJzbHJUc21wUXVJT3lDcmV5Z25PMlZvT3E1ak95YWxEOEtMU0Ryc29UdGlydzZJT3lWaE91TGlPeVlwQ0RDdHlEcmhLUUtDaW9xNjQrWjdKNlI3WmlWSU9LQWxDRHNoSnpzaUtBZ0t5RHJqNW5zbnBFZzY3S0U3WXE4S2lvS0xTRHRnNERzbmJUdGk0QTZJT3E0c09xNHNDRHNsN0Rxc3JBZzdaVzA3S0NjQ2kwZzdKV0k2NEswT2lEc2hLRHRnNTN0bFp3ZzZyaXc2cml3N0oyWUlPeVhzT3F5c095ZGhDRHJnWXJzbHJUc21wUXVDaTBnNjdLRTdZcThPaURzdDZqc2hvd2d3cmNnN0pldzZyS3dJTzJWDQp0T3lnbkFvS0tpcnNsWWpyZ3JUdG1KVWc0b0NVSU95WmhPdWpqQ0R0aHJYcnM3UXFLZ290SU8yRGdPeWR0TzJMZ0RvZzZyS3c3S0NjSU95WmhPdWpqQW90SU95VmlPdUN0RG9nNnJLdzdLQ2M2ckNBSU95Z2xleURnU0Rzc3BqcnBxenJrSkRzbHJUc21wUXVDaTBnNjdLRTdZcThPaUR0bVpYc25iZ0tDaW9xS2dvS0l5RHNtSWpzbWJnZzZyZWM3TG1aQ2dyc201RHN1WmtvNjRxbDY0K1p3cmZxdUkzc29KWEN0K3k2a095anZPeVd2Q25yczdUcmk2UWc3SmlJN0ptNDZyQ0FJT3VObENEcnFvWHRtWlh0bFp3ZzdMdWs2NjZrNjR1STdMeUE3SjIwN0lXWTdKMkVJT3Vuak91VG5PdUtsQ0Rxc3Izc21yRHNtSWpzbXBRdUNnb2pJeURzbUlqc21iZ2dNUzRnN0lpWTY0K1o3WmlWSU91c3VPeWVwZXlkaENEc2phanJqNFFnNjVDWTY0cVVJT3F5dmV5YXNBb0tJeU1qSU95RW5PdTVoT3lLcENEc29vWHJvNHdzSU9xNHNPcXdoQ0RycDR6cm80d0tDdXlJbU91UG1lMllsZXljdk91aG5DRHNrN0RycWJRZzdLTzg3SmEwS095aQ0KaGV1ampDRHNoSnpydVlUc2lxUXNJT3E0c09xd2hDRHJrN0VwNjZXOElPcXdsZXloc08yVm9DRHNpSmdnN0o2STZyT2dMQ0FuN0tLRjY2T01KK3laZ0NBbjY2ZU02Nk9NSit5ZG1DRHJpWmpzbFpuc2lxVHJwYndnN0tDVjdabVY3WjZJSU95Z2hPdUxyTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LN0ppSUtRb3RJRTlQVHlEc2hKenJ1WVRzaXFRZzdLS0Y2Nk9NSU95VmlPdUN0Q0RpZ0pRZ01ERHNtNVFnTUREc25ienJ0b0R0aExBZzdJU2M2N21FN0lxazZyQ0FJT3lpaGV1ampPdVB2T3lhbEM0ZzdKNlE3SVM0N1pXY0lPdUN0T3lhcWV5ZGhDRHNsWXpyb0tUcms1enJvS1RzbXBRdUNpMGc3SjZRN0lLd0lPeWhzTzJhakNEcXVMRHFzSVRzbmJRZzZyT25JT3Vuak91ampPdVB2T3lhbEM0S0N1dUxxQ3dnS2lyc283enF1TERzb0lIc25MenJvWndnN0tLRjY2T002ckNBSU91d21PdXp0ZXVRbU91S2xDRHNvSnp0a29ncUt1eVhrT3VLbENBbjdLS0Y2Nk9NNjQrODdKcVVKK3VsdkNEc2s3RHNwNEFnN0pXSzdKV0UNCjdKcVVMZ29LN0ppSUtRb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPeWloZXVqak91UHZPeWFsQ0RpaHBJZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnNjRHZDY0S1k3SnFVQ2dvakl5TWc3SUtzN0pxcDdKNlE3SmVRNnJLTUlPdXZ1T3k1bU91S2xDRHNtSUh0bHFYc25ZUWc3SldNNjZDazdLU0VJT3VWakFvS0tPeWp2T3lhbENEcmo1bnNncXdnT2lEc2w3RHNzclFzSU8yVnRPeW5nQ3dnN0tDQjdKcXBJT3VUc1NrS0N1eUltT3VQbWUyWWxleWN2T3VobkNEc2s3RHJxYlFnN0oyNDZyTzhJT3EwZ09xemhPdWx2Q0RycW9YdG1aWHRsWmpxc293ZzdJU2s2NnFGN1pXWTZyT2dMQ0FuN0lLczdKcXA3SjZRN0oyWUlPMldpZXVQbWV5WGtDRHJsTERybmJ6c21LVHJpcFFnNnJLdzZyTzhKK3Vkdk91S2xDRHNvSkRzbllRZzdKV002NkNrN0tTRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswDQo2NCs4N0pxVUxpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3RPeWp2T3lFdU95YWxDNEtMU0RyaklEc3RwenNuWVFnNnJDSTdKV0U3WU9BNjZtMElPeWJrT3VlbUNEcmpJRHN0cHpzbmJRZzdaVzA3S2VBNjQrODdKcVVMaURzbUtUcmlwZ2c2NEtnN0tlYzZybU03S2VBN0oyWUlPeWR0T3lla091bHZDRHNuWUR0bG9uc2w1QWc2NEswN0pXOElPMlZ0T3lhbEM0S0NpTWpJeURzZ3F6c21xbnNucEFnN0pXSTdJdXNJQ2pzaUpqcmo1bnRtSlVwQ2dvbjdLQ1Y2N08wSU95SW1PeW5rU0RzbFlqcmdyUW5JT3VUc2V5ZG1DRHJyN3pxc0pEdGxad2c3SU9CN1ptcDdKZVE3SVNjSUNvcTdJdWM3SXFrN1lXYzdKMjBJT3lla091UG1leWN2T3VobkNEc3NwanJwcXp0bFp6cmk2VHJpcFFnN0tDUUtpcnNuWVFnN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1FvdElPeWR0T3lnbk91Mg0KZ08yRXNDRHRtWTNxdUxqcmo1bnJpNWpzblpnZzZyQ2M3SjI0N0tDVjY3TzBJT3lkdE95YXFTRHJnclRzbDYzc25iUWc2cml3NjZHZDY0Kzg3SnFVQ2kwZzY0MlVJT3lpaSt5ZGdDRHNnNEhyaTdUc25ZUWc3SnlFN1pXMElPMkd0ZTJabENEcmdyVHNtcW5zbllBZzY0VzU3SjJNNjQrODdKcVVDZ29qSXlEc21JanNtYmdnTWk0ZzZySzk3SmEwNjZXOElPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdDZ3J0aXJuc29KVWc3SU9CN1ptcDdKZVE3SVNjSU95Z25PMlZuT3lnZ2V5Y3ZPdWhuQ0FuN0l1YzY0S1k3SnFVUHl3ZzdJV282NEtZN0pxVVB5Y2c3SjJZNjZ5NDdaaVZJT3lXdE91dnVPdWx2Q0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNncXpzbXFuc25wRHNuWmdnNjZlbDY1Mjk3SjJFSU8yWm5PeWFxZTJWdE95RW5DRHNwNGpyckxqdGxhQWc2NVdNQ2dvbjdJdWM2NEtZN0pxVVB5Y3NJQ2ZzaGFqcmdwanNtcFEvSnlEdG1KWHRnNXpzblpnZzZySzk3SmEwNjZXOElPMlpuT3lhcWUyVnRPeUUNCm5DRHNncXpzbXFuc25wRHNuWmdnNjR1NTdabXA3SXFrNjUrczdKdUE3SjJFSU95a2hPeWR2Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1FvdElPMlpqZXE0dU91UG1ldUxtQ3dnVDA5UElPdUxwT3VGZ095WXBPeUZxT3VDbU95YWxEOEtMU0RzdHFuc29JVHRsWmpybjZ3ZzdZNjQ3SjJZN0tDUUlPcXdnT3lMbk91Q21PeWFsRDhLQ2lNakl5RHNncXpzbXFuc25wRHNuWmdnN0lPQjdabXA3SjJFSU95MmxPeWdsZTJWb0NEcmxZd0tDdXVxaGUyWmxlMlZuQ0Rzb0pYcnM3VHFzSUFnN0plRzdKYTA3SVNjSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzcDRIc29KRWc3WXlRNjR1bzdaV1k2cktNSU8yVnRPeVZ2Q0R0bGFBZzY1V01JT3F5dmV5V3RPdWhuQ0Rzb0pYc3BKSHRsWmpxc293ZzdLZUk2Nnk0N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0xtMDY1T2M2Nlc4SU91d20reWN2T3lGcU91Q21PeWFsRDhnNjVPeDY2R2Q3WldZNjZtMElPeTZrT3lMbk91d3NTRHRtSnp0ZzUzc25ZUWc2N0NiDQo3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdJS3M3SnFwN0o2UTdKMllJT3lFb095ZG1PcXdnQ0R0bFlUc21wVHRsYUFnNjVXTUNncnNoS1Ryckxqc29iRHNncXpzc3Bqcm43d2c3SUtzN0pxcDdKNlE3SjJZSU95RW9PeWRtT3VsdkNEcXVMRHJqSUR0bGJUc2xid2c3WldnSU91VmpDRHFzcjNzbHJUcm9ad2c3S0NWN0tTUjdaV1k2cktNSU95bmlPdXN1TzJWdE95YWxDNEtDdXlZaUNrS0xTRHNuYlRyc29nZzY0dXM3SmVRSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxaanJxYlRzaEp3ZzdKYTg2NmVJNjRLWUlPdW5qT3loc2UyVm1PeUZxT3VDbU95YWxEOEtDaU1qSU95WWlPeVp1Q0F6TGlEcnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyRUlPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdDZ3JzZ3F6c21xbnNucERzbDVEcXNvd2c2NnFGN1ptVjdaV1k2cktNSU91MmdPeWdsZXlnZ2V5ZHVDRHJnclRzbXFuc25ZUWc3SldNNjZDazdLU1k3Slc4SU8yVm9DRHJsWXpyaXBRZzY3YUE3S0NWN1ppVg0KSU91c3VPeWVwZXlkaENEc2phanJqNFFnN0tLTDdKV0U3SnFVTGdvS0l5TWpJT3lFbk91NWhPeUtwT3VsdkNEc29KWHNzWVhzZzRFZzdKTzRJT3lJbUNEc2w0YnNuWVFnNjVXTUNncnJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzdJMm83Slc4SU95Q3JPeWFxZXlla095WGtPcXlqQ0RzZzRIdG1hbnNuWVFnNjZxRjdabVY3WldZNnJLTUlPeWR1T3luZ095TG5PMkNyQ0RzaUpnZzdKNkk3SmEwN0pxVUxpQXFLdXlUdUNEc2lKZ2c3SmVHNjRxVUlPeWR0T3ljb091bHZDRHRsYWpxdTVnZzdKV0k2NEswN1pXMDdLTzg3SVM0N0pxVUxpb3FDZ3JzbUlncENpMGc3S2VBNnJpSTdKMkFJT3F3Z095ZWhlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhbEM0S0xTRHFzN1hyckxUc201RHNuWUFnN1p1RTdKdVE2cmlJN0oyRUlPdXp0T3VDdkNEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeWQNCnZPdTJnQ0RxdUxEcmlxWHJwNHdnN0pPNElPeUltQ0RzbDRic25ZUWc2NVdNQ2dycnRvRHNvSlh0bUpYc25MenJvWndnN0kybzdKVzhJT3lDck95YXFleWVrT3F3Z0NEc2xyVHJscVFnNnJpdzY0cWw3SjJFSU95VHVDRHNpSmdnN0plRzY0cVU3S2VBSU91cWhlMlpsZTJWbU9xeWpDRHNuYmpzcDREdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0N1eVlpQ2tLTFNEc29KRHFzb0FnNnJpdzZyQ0VJT3VQbWV5VmlDRHNoSnpydVlUc2lxVHJwYndnN0oyMDdKcXA3WldnSU95SW1DRHNsNGJzbHJUc21wUXVDaTBnN0l1ZzY3YUU3S2FkSU8yWmxleWR1T3VRbU9xNHNDRHNvSVRxdVl6c3A0QWc3SWFoNnJpSTZyTzhJT3F5c095Z25PdWx2Q0R0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNncXpzbXFuc25wQWc3SVNnN1lPZDdKMllJT3F5c09xenZPdWx2Q0RzbFlqcmdyVHRsYUFnNjVXTUNncnJrSmpyajR6cnByUWc3SWlZSU95WGh1dUtsQ0RzaEtEdGc1M3NuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxDQpoZTJabGUyVm1PcXlqQ0RzbFl6cm9LVHNtcFF1Q2dyc21JZ3BDaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBBZzdKV0k3SXVzSUNqcnRvRHNvSlh0bUpVcENnb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3S0NWNjdPMDZyQ0FJT3V6dE8yWXVPdVFuT3VMcE91S2xDRHNvSkFxS3V5ZGhDRHJ0b0Rzb0pYdG1KWHNuTHpyb1p3ZzdKV002NkNrSU95Q3JPeWFxZXlla091bHZDRHNsWWpzaTZ6dGxaanFzb3dnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0lPQjY0dTA3SjIwSU91Qm5ldUNtT3VwdENEc29JVHJyTGpxc0lEcmo0UWc3Wm1ONnJpNDY0K1o2NHVZN0oyWUlPeWdsZXV6dE91bHZDRHJzN3dnN0lpWUlPeVhodXlXdE95YWxDNEtMU0R0bVkzcXVManJqNW5yaTVqcw0KblpnZzdLQ1Y2N08wNnJDQUlPcTRzT3VobmV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1Q2dvakl5RHNtSWpzbWJnZ05DNGc3S0NjN1pLSUlPeWFxZXlXdE91S2xDRHJzSlRxdnJqc3A0QWc3SldLNnJpd0Nnb242ckNFNnJLdzdaV1k2ck9nSU95SnJPeWF0Q0RycDVBbklPeWJrT3k1bWV1enRPdUxwQ0FxS3UyWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhlcXp2T3lkbUNEc21xbnNsclFnN0oyODdMbVlLaXJxc0lBZzdKcXc3SVNnN0oyMDdKZVE3SnFVTGdycXVMRHJpcVhycW9Yc2w1QWc3Sk93N0oyNElPdUxxT3lXdENqcnM0RHFzcjBzSU95bmdPeWdsU3dnNjVPeDY2R2RJT3VUc1NucnBid2c3SldJNjRLMElPdXN1T3Exck95WGtPeUVuQ0RyaTZUcnBiZ2c2NmVRNjZHY0lPdXdsT3ErdU91cHRDRHNncXpzbXFuc25wRHFzSUFnNjR1azY2VzRJT3E0c091S3BleWN2T3VobkNEc21LVHRsYlR0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ3V5WWlDa2dKK3Eyak8yVm5DRHJzNERxc3IwbklPcTQNCnNPdUtwZXlkbUNEc2xZanJnclFnNjZ5NDZyV3NDaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVm1PdXB0Q0Ryc0pUcXY0QWc3SWlZSU95ZWlPeVd0T3lhbENBb1dDa0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUlDaFBLUW9LSXlNZzdKaUk3Sm00SURVdUlPeUxuT3lLcE8yRm5DRHJqNW5zbnBIcXM3d2c2NHVrNjZXNElPdVBtZXlDckNEc2s3RHNwNEFnN0pXSzZyaXdDZ3JyckxqcXRhenJwYndnN0pXRTY2eTA2NmFzSU91bnBPdUJoT3VmdmVxeWpDRHJpNlRyazZ6c2xyVHJqNFFnS2lyc2k2VHNvSndnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NLaXJycGJ3ZzdKT3c2Nm0wSU95ZW1PdXF1K3VRbkNEcnJManF0YXpzbUlqc21wUXVDZ3JzbUlncElPdW5pT3lLDQpwTzJFc0NEcXRJRHJwcXpzbnBEcnBid2dKK3kybE9xd2dDRHNwNERzb0pVbjdaV1k2NHFVSU95TG5PeUtwTzJGbk95WGtPeUVuQ0FvN0oyMDdLQ0V3cmZzbHBIcmo0UWc2cml3NjRxbDdKMjBJT3lWaE91TG1Da0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKZVE2cktNSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcnBid2c2NFNZNnJLbzdLTzg3SVM0N0pxVUlDaFlJT0tBbENEc2w0YnJpcFFnSit1RW1PcTRzT3E0c0NjZzZyaXc2NHFsN0oyRUlPeVZsT3lMbkNrS0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WlcwSU95anZPeUV1T3lhbENBb1R5a0sNCjo6TEFVTkNIRVI6Og0KLy80bkFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCQ0FISUFhUUJrQUdjQVpRQWdBR3dBWVFCMUFHNEFZd0JvQUdVQWNnQWdBQlFnSUFEb3NzU3N4THdnQUNUQkZjZ2dBQkRJZ0t3Z0FNVFdJQURrc3F5NUlBRGt3b25WQ2dBbkFDQUFZd0JzQUdFQWRRQmtBR1VBWWdCeUFHa0FaQUJuQUdVQU9nQXZBQzhBSUFBRTFWeTRvTkZjejNUSElBQjB4eUFBRE5OOHgwVEhJQUNBdlhpNTVMSWdBQ2dBOGJSZHVEb0FJQUJ1QUhBQWJRQWdBR2tBYmdCekFIUUFZUUJzQUd3QUlBQVF0cFN5SUFBaUFIVFFYTGpjdENBQTVNNGxzVERSSWdBZ0FDVEJXTTRnQUF6VGZNY3BBQzRBQ2dBbkFDQUFWTHNBckNBQVlMNDR5Q0FBaU1jOHgzUzZJQUJjMVNBQWlMelF4U0FBV05XWXNDbkZJQUJJeGJTd1dOWGdyQ3dBSUFEa3NpQUFBTWxFdmhpMGRMb2dBT1N5ckxsOHVTQUFQY3dnQU1iRmRNY2dBT1RDaWRWYzFlU3lMZ0FLQUZNQVpRQjBBQ0FBWmdCekFHOEFJQUE5QUNBQVF3QnlBR1VBWVFCMEFHVUFUd0JpQUdvQVpRQmpBSFFBS0FBaUFGTUENCll3QnlBR2tBY0FCMEFHa0FiZ0JuQUM0QVJnQnBBR3dBWlFCVEFIa0Fjd0IwQUdVQWJRQlBBR0lBYWdCbEFHTUFkQUFpQUNrQUNnQlRBR1VBZEFBZ0FITUFhQUFnQUQwQUlBQkRBSElBWlFCaEFIUUFaUUJQQUdJQWFnQmxBR01BZEFBb0FDSUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGTUFhQUJsQUd3QWJBQWlBQ2tBQ2dCa0FHa0FjZ0FnQUQwQUlBQm1BSE1BYndBdUFFY0FaUUIwQUZBQVlRQnlBR1VBYmdCMEFFWUFid0JzQUdRQVpRQnlBRTRBWVFCdEFHVUFLQUJYQUZNQVl3QnlBR2tBY0FCMEFDNEFVd0JqQUhJQWFRQndBSFFBUmdCMUFHd0FiQUJPQUdFQWJRQmxBQ2tBQ2dCekFHZ0FMZ0JEQUhVQWNnQnlBR1VBYmdCMEFFUUFhUUJ5QUdVQVl3QjBBRzhBY2dCNUFDQUFQUUFnQUdRQWFRQnlBQW9BQ2dBbkFDQUFNUUF2QURJQUtRQWdBRTRBYndCa0FHVUFMZ0JxQUhNQUlBQVF5SUNzSUFBVUlDQUF4c1U4eDNTNklBRGtzclRHWExqY3RDQUFtTk4weDhESmZMa2dBUFRGdE1VQXllU3lDZ0JKQUdZQUlBQnpBR2dBDQpMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQUlBQjNBR2dBWlFCeUFHVUFJQUJ1QUc4QVpBQmxBQ0lBTEFBZ0FEQUFMQUFnQUZRQWNnQjFBR1VBS1FBZ0FEd0FQZ0FnQURBQUlBQlVBR2dBWlFCdUFBb0FJQUFnQUVrQVpnQWdBRTBBY3dCbkFFSUFid0I0QUNnQUlnQk9BRzhBWkFCbEFDNEFhZ0J6QUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aTRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdCYkFGWFdlTWRkQUVUSElBQUVzblM1ZExvZ0FPU3l0TVpjdU55MElBQ1kwM1RId01rQXJDQUE5TVc5dWNpeTVMSXVBQ0FBSk1GWXpueTVJQURJdVZ6T0lBQ2t0Q3dBSUFBTTFleTMrSzE0eDlERkhNRWdBSFRRWExqY3RDQUFoTHk4MGtUSElBRGtzdHpDSUFBTXN1eTNJQUQ4eURqQmxNWXVBQ0lBTEFBZ0FGOEFDZ0FnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQQ0KSUFCMkFHSUFUd0JMQUVNQVlRQnVBR01BWlFCc0FDQUFLd0FnQUhZQVlnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURFQUx3QXlBQ2tBSUFBVUlDQUFUZ0J2QUdRQVpRQXVBR29BY3dBaUFDa0FJQUE5QUNBQWRnQmlBRThBU3dBZ0FGUUFhQUJsQUc0QUNnQWdBQ0FBSUFBZ0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCb0FIUUFkQUJ3QUhNQU9nQXZBQzhBYmdCdkFHUUFaUUJxQUhNQUxnQnZBSElBWndBdkFHc0Fid0F2QUdRQWJ3QjNBRzRBYkFCdkFHRUFaQUFpQUFvQUlBQWdBRVVBYmdCa0FDQUFTUUJtQUFvQUlBQWdBRmNBVXdCakFISUFhUUJ3QUhRQUxnQlJBSFVBYVFCMEFBb0FSUUJ1QUdRQUlBQkpBR1lBQ2dBS0FDY0FJQUF5QUM4QU1nQXBBQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDQUFFTWlBckNBQUZDQWdBTWJGUE1kMHVpQUFKTUZZenJjQVhMajRyWGpISUFBcHZKVzhSTWNnQUVqRnRMQmMxZVN5Q2dCSkFHWUENCklBQnpBR2dBTGdCU0FIVUFiZ0FvQUNJQVl3QnRBR1FBSUFBdkFHTUFJQUIzQUdnQVpRQnlBR1VBSUFCakFHd0FZUUIxQUdRQVpRQWlBQ3dBSUFBd0FDd0FJQUJVQUhJQWRRQmxBQ2tBSUFBOEFENEFJQUF3QUNBQVZBQm9BR1VBYmdBS0FDQUFJQUJOQUhNQVp3QkNBRzhBZUFBZ0FDSUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aUFBS0FBUXRwU3lJQUJRQUVFQVZBQklBTkRGSUFER3hiVEZsTVlwQUM0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0F3MGZpN0VMSFF4UnpCSUFCRXhaaTNmTGtnQUNUQldNNjNBRnk0K0sxNHgxelZJQUNrdEN3QUlBQjAwRnk0M0xRZ0FJUzh2TkpFeHlBQTVMTGN3aUFBRExMc3R5QUEvTWc0d1pUR09nQWlBQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBDQpKZ0FnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWlBQ0FBSUFCdUFIQUFiUUFnQUdrQWJnQnpBSFFBWVFCc0FHd0FJQUF0QUdjQUlBQkFBR0VBYmdCMEFHZ0FjZ0J2QUhBQWFRQmpBQzBBWVFCcEFDOEFZd0JzQUdFQWRRQmtBR1VBTFFCakFHOEFaQUJsQUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFJQUFnQUdNQWJBQmhBSFVBWkFCbEFDQUFiQUJ2QUdjQWFRQnVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQVZkWjR4eUFBS2J5VnZEb0FJQUF3MGZpN0VMSFF4UnpCSUFCakFHd0FZUUIxQUdRQVpRQWdBQzBBTFFCMkFHVUFjZ0J6QUdrQWJ3QnVBQ0FBZE1jZ0FJUzhCTWhFeHlBQW5NMGx1RmpWZExvZ0FBREpSTDRnQUVUR3pMaUZ4OGl5NUxJdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQQ0KWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFLQUNzd0tuR3liZEF4eUFBZE1jZ0FGQUFRd0RReFNBQVhMajRyWGpISExRZ0FIVFFYTGpjdENBQWJLM0ZzeUFBWE5YRXM5REZITUVnQUNqTUVLd3B0TWl5NUxJdUFDa0FJZ0FzQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBSFlBWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BRElBTHdBeUFDa0FJQUFVSUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0lBQ2dBZ0FDQUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGRUFkUUJwQUhRQUNnQkZBRzRBWkFBZ0FFa0FaZ0FLQUFvQUp3QWdBQURKUkw0Z0FFVEd6TGdnQUJRZ0lBRGtzcXk1ZkxrZ0FEM01JQURHeFhUSElBRGt3b25WSUFBb0FBelY3TGY0clhqSGRNY2dBT2VzSUFDUXg5bXpJQUFRck1ESktRQUtBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQmpBRzBBWkFBZ0FDOEFZd0FnQUc0QWJ3QmtBR1VBSUFCekFHTUENCmNnQnBBSEFBZEFCekFGd0FZd0JzQUdFQWRRQmtBR1VBTFFCaUFISUFhUUJrQUdjQVpRQXVBR29BY3dBaUFDd0FJQUF3QUN3QUlBQkdBR0VBYkFCekFHVUFDZ0E9DQo6OldBVENIRVI6Og0KTHk4ZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzRvQ1VJTzJWcmV5RGdTRHJscUFnN0o2STY0cVVJT3kwaU95R2pPMllsU0RzaEp6cnNvUWdLR3h2WTJGc2FHOXpkRG94TVRnNE9Ta0tMeThnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUNpOHZJT3labkNEdGxZVHNtcFR0bFp6cXNJQTZJTzJVdk9xM3VPdW5pT3F3Z0NEdGxJenJuNnpxdDdqc25ianNuWmdnWTJ4aGRXUmxZbkpwWkdkbE9pOHZJT3lYdE9xNHNDaDNhVzVrYjNjdWIzQmxiaTlwWm5KaGJXVXZiM0JsYmtWNGRHVnlibUZzS2V1bHZBb3YNCkx5RHNvSVRydG9BZzdJYU02NmFzSU95WGh1eWR0Q0RycDRucmlwUWc2N0tFN0tDRTdKMjBJT3llaU91THBDNGdabVYwWTJqcmlwUWc2NnE3SU91bmlleWN2T3V2Z091aG5Dd2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPeWR0Q0Rxc0pEc2k1enNucERzbDVEcXNvd0tMeThnVUU5VFZDQXZkMkZyWlNEcnBid2c2N08wNjRLMDY2bTBJT3F3a095TG5PeWVrT3F3Z0NEcmk2VHJwcXdvWTJ4aGRXUmxMV0p5YVdSblpTNXFjeW5ycGJ3ZzY0eUE3SXVnSU95OG9PdUxwQzRLTHk4S0x5OGc2NHVrNjZhczdKbUE3SjJZSU95d3FPeWR0RG9nNnJDUTdJdWM3SjZRNjRxVUlHTnNZWFZrWmV1bHZDRHJyTHpzcDRBZzdKV0s2NHFVNjR1a0tPeWVrT3lMblNEc2w0YnNuWXdwSU9LR2tpRHRnYlRyb1p6cms1d2c3Sld4SU95WGhldU5zT3lkdE8yS3VPdWx2Q0RzbFlnZzY2ZUo2ck9nTEFvdkx5RHJxWlRycXFqcnBxd2dmakUxVFVMcm5id2c2NkdjNnJlNDdKMjRJT3lMbkNEc25wRHJqNWtnN0l1YzdKNlI3Snk4NjZHY0lPeURnZXlMDQpuQ0Rzdkp6cmthenJqNFFnNjdhQTY0dTBJT3lYaHV1THBDQW82NU94NjZHZE9pQnVjRzBnY25WdUlHSjFhV3hrS1M0S0x5OGc2NHVrNjZhczY0cVVJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1TERycWJRZzdLTzk3S2VBNjZlTUtPMlVqT3Vmck9xM3VPeWR1T3F6dkNEc2c1M3NncXdnNjQrWjZyaXc3Wm1VS1N3ZzZyQ1E3SXVjN0o2UTY0cVVJT3F6aE95R2pTRHJncWpzbFlRZzY0dWs3SjJNSU9xNXFPeWFzT3E0c091bHZDRHJzSnZyaXBUcmk2UXVDZ3BqYjI1emRDQm9kSFJ3SUQwZ2NtVnhkV2x5WlNnbmFIUjBjQ2NwT3dwamIyNXpkQ0J3WVhSb0lEMGdjbVZ4ZFdseVpTZ25jR0YwYUNjcE93cGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0NtTnZibk4wSUc5eklEMGdjbVZ4ZFdseVpTZ25iM01uS1RzS1kyOXVjM1FnZXlCemNHRjNiaXdnYzNCaGQyNVRlVzVqSUgwZ1BTQnlaWEYxYVhKbEtDZGphR2xzWkY5d2NtOWpaWE56SnlrN0NncGpiMjV6ZENCUVQxSlVJRDBnTVRFNE9EazdDbU52Ym5OMA0KSUZKUFQxUWdQU0J3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5LVHNnTHk4ZzdLQ0E3SjZsN0lhTUlPdWpxTzJLdUNEaWdKUWc2NHVrNjZhczZyQ0FJSEpsWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0Wk91bHZDRHNzTDdyaXBRZzZyaXc3S1NBQ2dwamIyNXpkQ0JEVDFKVFgwaEZRVVJGVWxNZ1BTQjdDaUFnSjBGalkyVnpjeTFEYjI1MGNtOXNMVUZzYkc5M0xVOXlhV2RwYmljNklDY3FKeXdLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEFvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFJWldGa1pYSnpKem9nSjBOdmJuUmxiblF0Vkhsd1pTY3NDbjA3Q21aMWJtTjBhVzl1SUdwemIyNG9jbVZ6TENCemRHRjBkWE1zSUc5aWFpa2dld29nSUhKbGN5NTNjbWwwWlVobFlXUW9jM1JoZEhWekxDQlBZbXBsWTNRdVlYTnphV2R1S0hzZ0owTnZiblJsYm5RdFZIbHdaU2M2SUNkaGNIQnNhV05oZEdsdmJpOXENCmMyOXVPeUJqYUdGeWMyVjBQWFYwWmkwNEp5QjlMQ0JEVDFKVFgwaEZRVVJGVWxNcEtUc0tJQ0J5WlhNdVpXNWtLRXBUVDA0dWMzUnlhVzVuYVdaNUtHOWlhaWtwT3dwOUNnb3ZMeUJqYkdGMVpHVWdRMHhKNnJDQUlPeWVpT3VLbE95bmdDRGlnSlFnN0plRzdKeTg2Nm0wSUM5M1lXdGxJT3lka2V1THRleVhrQ0RzaTZUc2xyUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeVZpT3VDdE8yVm9DRHNpSmdnN0o2STZyS01JTzJWbk91THBBb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU95ZHZlcTRzQ0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOeklDanJpNlRycHF6c25aZ2dZMnhoZFdSbFFXTmpiM1Z1ZE95WmdDRHFzSm5zbllBZzdMYWM3TEtZS1M0S0x5OGc3WXlNN0oyODdKMjBJTzJCdENEc2lKZ2c3SjZJN0phMElETXc3TFNJSU95NmtPeUxuQzRnN0o2czY2R2M2cmU0N0oyNDdaV1k2Nm0wDQpJRU5NU2Vxd2dDRHRqSXpzbmJ6c25ZUWc2ckN4N0l1ZzdaV1k2NitBNjZHY0lPeWVrT3VQbVNEcnNKanNtSUhya0p6cmk2UXVDaTh2SU95NmtPeUxuQ0ExN0xTSUlPS0FsQ0Ryb1p6cXQ3anNuYmdnN0tlQjdadUVJT3lEaUNEcXM0VHNvSlhzbmJRZzZyT242N0NVNjZHY0lPeWVvZTJZZ095VnZDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95WGtPeUVuQ0R0bVlqc25MenJvWndnNjRTWTdKYTA2ckNFNjR1a0tETXc3TFNJNjZtMElPdUVpT3VzdENEcmlxYnNuWXdwQ214bGRDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUF3TENCbGJXRnBiRG9nYm5Wc2JDQjlPd292THlEc2k2VHNvSndnNjZHYzZyZTQ3SjI0SU95WHJPdTJnT3VLbENEc25wRHFzcW5zcHAzcnFvVWc3WXlNN0oyODY2R2NJTzJNa091THFPMlZuT3VMcENEaWdKUWdmaTh1WTJ4aGRXUmxMbXB6YjI3c25aZ2diMkYxZEdoQlkyTnZkVzUwNjRxVUlDb3E2NkdjNnJlNDdKV0U3SnVEN1pXMDY0K0VJT3VDcU91Sw0KbE91THBDb3FDaTh2SUNqc2k2VHN1S0U2SUdOc1lYVmtaU0JoZFhSb0lITjBZWFIxYyt1S2xDQnNiMmRuWldSSmJqcG1ZV3h6WmV5ZHVPdU5zQ0RxdDdnZzdaV0U2NU9jNjRxVUlPcTN1T3VNZ091aG5DRGlocElnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3Vobk9xM3VPeWR1T3VRbkNEcXNvUHNzcGpybjd3ZzdaR2M3SXVjN1phSTY0dWtLUzRLTHk4ZzdZeU03SjI4NjZlTUlPeWR2ZXljdk91dmdPdWhuQ0RydVlUc21xa2dNQzRnWTJ4aGRXUmxJR0YxZEdnZ2MzUmhkSFZ6NnJDQUlPeWdsZTJabGUyVm1PeW5nT3VuakNEdGxJVHJvWnpzaExqc2lxVHJwYndnNjUyRTdKdU03Slc4SU8yVnRPeUVuQ0Rzb2JEdG1venJwNGpyaTZRZzdKT3c2cml3N0plVUlPdXN0T3F5Z2V1THBDNEtablZ1WTNScGIyNGdhR0Z6UTJ4aGRXUmxRM0psWkdWdWRHbGhiSE1vS1NCN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHWWdQU0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTY3NJQ2N1WTNKbFpHVnUNCmRHbGhiSE11YW5OdmJpY3BPd29nSUNBZ1kyOXVjM1FnYWlBOUlFcFRUMDR1Y0dGeWMyVW9abk11Y21WaFpFWnBiR1ZUZVc1aktHWXNJQ2QxZEdZNEp5a3BPd29nSUNBZ2FXWWdLR29nSmlZZ2FpNWpiR0YxWkdWQmFVOWhkWFJvSUNZbUlHb3VZMnhoZFdSbFFXbFBZWFYwYUM1aFkyTmxjM05VYjJ0bGJpa2djbVYwZFhKdUlIUnlkV1U3Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzdZeU03SjI4SU95WGh1eWRqTUszNjZxN0lPeWR2ZXlkakNEaWdKUWc2NmVsN0oyMDY2bTBJTzJDcE95eXRPeWR1T3lkaENEcnA0anNvSUFnNjdPNDY0dWtJQ292SUgwS0lDQXZMeUFxS3V1bnBleWRnQ0RzbnBEcXNxbnNwcDNycW9Yc25ZUWc3WXlNN0oyODdKMjBJT3lWaE91TGlPdWR2Q0R0Z3FUc3NyVHNuYmpzbDVBZzY0U2o2NHFVNjR1a0tpb2dLREl3TWpZdE1EZ2c3SXVrN0xpaExDRHJpNlRycHF3Z2RqUXhJQzhnNnJDUTdJdWM3SjZRSUhZMktTNEtJQ0F2THlEcnA2WHNuWmdnUTJ4aGRXUmxJRU52WkdYcmlwUWdmaTh1DQpZMnhoZFdSbEx5NWpjbVZrWlc1MGFXRnNjeTVxYzI5dTdKMkVJT3lWaE95WWlDRHJwNHpyazZUc3A0QWc3SldLNnJPZ0lPMkNwT3l5dE95ZHVDRHRsYTNycXFrS0lDQXZMeUFuUTJ4aGRXUmxJRU52WkdVdFkzSmxaR1Z1ZEdsaGJITW43SmVRSU95Z2dPeWVwZTJWbk91THBDRGlocElnN1l5TTdKMjg2NmVNSU91enRPdXB0Q0RycVlEc3FhSHRub2dnNjZHYzZyZTQ3SjI0NjVDY0lPdW5wZXlkdENEcmlwZ2dKK3Vobk9xM3VPeWR1Q0RzbFlnZzY1Q29KK3lkdENEcmtKanFzNkFzQ2lBZ0x5OGc2NkdjNnJlNDdKMjRJT3VNZ09xNHNDRHRtWlRycWJUc25iUWc3SmlCN0ppQklPdVBpT3VMcENqcmlJenJuNnpyajRRZ1EweEo2ckNBSUNMc25iVHJyN2dnNjZHYzZyZTQ3SjI0NjVDb0l1eWN2T3VobkNEc3BvbnNpNXdnNjRHZDY0S1lJT3U0ak91ZHZPeWFzT3lnZ095aHNPeXdxQ0RzbFlnZzdKZTA2NmF3NjR1a0tTNEtJQ0F2THlBcUt1eWh0T3llck91bmpDRHRtWlhzbmJqdGxaenJpNlFvTFhjZzdKZUc3SjJNS1NvcQ0KSU9LQWxDRHJ1WVRyc0lEcnNvanRtTGdnNnJDUzdKMkVJT3lkdmV5Y3ZPdXB0Q0R0Z3FUc3NyVHNuYmdnN0tDUjZyZThJTzJYaU95YXFTRHRqSjNzbDRYc25iUWc2NXl3SU95SW1DRHNub2pyaTZRdUlPeVZ2U0F6TUcxekxnb2dJQzh2SUVOQ1gwNVBYMHRGV1VOSVFVbE9QVEhzbmJUcnFiUWc3WXlNN0oyODY2ZU1JT3V6dU91THBDQW82NnFvN0oyWUlPMlppT3ljdk91aG5DQW42NkdjNnJlNDdKMjRJT3lYaHV5ZGpDZnNuWVFnN0o2czdaaUU3WldZNjRxVUlPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZS2s3TEswN0oyNDdKMkFJRWhQVFVYc25ZUWc3SldJSU91VXNPdWx1T3VMcENrdUNpQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnSVQwOUlDZGtZWEozYVc0bklIeDhJSEJ5YjJObGMzTXVaVzUyTGtOQ1gwNVBYMHRGV1VOSVFVbE9JRDA5UFNBbk1TY3BJSEpsZEhWeWJpQm1ZV3h6WlRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2NpQTlJSE53WVhkdVUzbHVZeWduYzJWamRYSnBkSGtuTENCYkoyWnANCmJtUXRaMlZ1WlhKcFl5MXdZWE56ZDI5eVpDY3NJQ2N0Y3ljc0lDZERiR0YxWkdVZ1EyOWtaUzFqY21Wa1pXNTBhV0ZzY3lkZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkR2x0Wlc5MWREb2dNekF3TUNCOUtUc0tJQ0FnSUhKbGRIVnliaUJ5TG5OMFlYUjFjeUE5UFQwZ01Ec0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QnlaWFIxY200Z1ptRnNjMlU3SUgwZ0x5OGdjMlZqZFhKcGRIbnJwYndnNjZxN0lPdTJnT3VtaENBOUlPdWhuT3EzdU95ZHVDRHNsWWdnNjVDbzdKeTg2NkdjSU91enVPdUxwQXA5Q21aMWJtTjBhVzl1SUdOc1lYVmtaVUZqWTI5MWJuUW9LU0I3Q2lBZ2FXWWdLRVJoZEdVdWJtOTNLQ2tnTFNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUENBMU1EQXdLU0J5WlhSMWNtNGdZV05qYjNWdWRFTmhZMmhsTG1WdFlXbHNPd29nSUd4bGRDQmxiV0ZwYkNBOUlHNTFiR3c3Q2lBZ2RISjVJSHNLSUNBZ0lHbG1JQ2hvWVhORGJHRjFaR1ZEY21Wa1pXNTBhV0ZzY3lncEtTQjdJQzh2SU95ZWtPcXlxZXltDQpuZXVxaGV5ZHRDRHNsNGJzbkx6cnFiUWc2NEtvN0oyQUlPeWR0T3VwbE95ZHZPeWRnQ0RyckxUc2k1enRsWnpyaTZRS0lDQWdJQ0FnWTI5dWMzUWdhaUE5SUVwVFQwNHVjR0Z5YzJVb1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxMbXB6YjI0bktTd2dKM1YwWmpnbktTazdDaUFnSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3dvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91aG5PcTN1T3lkdUNEc25iVHJvS1VnN0plRzdKMk1JT3VUc1NEaWdKUWdiblZzYkNBcUx5QjlDaUFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ1JHRjBaUzV1YjNjb0tTd2daVzFoYVd3Z2ZUc0tJQ0J5WlhSMWNtNGdaVzFoYVd3N0NuMEtDbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzS0lDQmpiMjV6ZENCbQ0KYVc1a1pYSWdQU0J3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluSUQ4Z0ozZG9aWEpsSnlBNklDZDNhR2xqYUNjN0NpQWdkSEo1SUhzZ2NtVjBkWEp1SUhOd1lYZHVVM2x1WXlobWFXNWtaWElzSUZzblkyeGhkV1JsSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbkxDQnphR1ZzYkRvZ2RISjFaU0I5S1M1emRHRjBkWE1nUFQwOUlEQTdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lISmxkSFZ5YmlCbVlXeHpaVHNnZlFwOUNncHNaWFFnZDJGcmFXNW5JRDBnWm1Gc2MyVTdJQzh2SU95WHNPMkRnQ0Ryc0tuc3A0QWc0b0NVSU91THBPdW1yT3VLbENEc2xyVHNzS2p0bEx3Z1JVRkVSRkpKVGxWVFJldWhuQ0RzcEpIcnM3VWc3S0NWNjZhczdaV1k3S2VBNjZlTUlPMlVoT3Vobk95RXVPeUtwQ0RyZ3EzcnVZVHJwYndnN0tTRTdKMjQ2NHVrQ21aMWJtTjBhVzl1SUhkaGEyVkNjbWxrWjJVb0tTQjdDaUFnYVdZZ0tIZGhhMmx1WnlrZ2NtVjBkWEp1T3dvZ0lIZGhhMmx1WnlBOUlIUnlkV1U3Q2lBZ2MyVjANClZHbHRaVzkxZENnb0tTQTlQaUI3SUhkaGEybHVaeUE5SUdaaGJITmxPeUI5TENBMU1EQXdLVHNLSUNCc1pYUWdjSEp2WXpzS0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnTHk4Z1YybHVaRzkzY3pvZ1kyMWt3cmQyWW5NZzZySzk3SnlnSU95WGh1eWR0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTd2dkMmx1Wkc5M2MwaHBaR1VvUTFKRlFWUkZYMDVQWDFkSlRrUlBWeW5yb1p3ZzdJcWs3WSt3SU9LQWxBb2dJQ0FnTHk4ZzdMQzlJT3lYaHV1S2xDRHNpS2pzbllBZzdMMlk3SWFVN0oyMElPdW5qT3VUcE95V3RPeW5nT3F6b0NEcmk2VHJwcXpzblpnZzdKNlE3SXVkS0dOc1lYVmtaU25yajRRZzZyZTRJT3k5bU95R2xPeWRoQ0Ryckx6cm9LVHJzSnZzbFlRZzdKYTA2NWFrSU95d3ZldVBoQ0RzbFlnZzY1eXM2NHVrTGdvZ0lDQWdMeThnWkdWMFlXTm9aV1RyaXBRZzdKT3c3S2VBSU95Vml1dUtsT3VMcENoa1pYUmhZMmhsWkN0M2FXNWtiM2R6U0dsa1pTRHNvYkR0DQpsYW5zbllBZzdMMlk3SWFVSU95d3ZleWR0Q0RyaGJqc3RwenJrS2dnNG9DVUlPeUxwT3k0b1NrdUNpQWdJQ0F2THlCWGFXNWtiM2R6N0plUTdJU2dJR1JsZEdGamFHVmtJT3lYaHV5ZHRPdVBoQ0RydG9EcnFxZ282ckNRN0l1YzdKNlFLZXF3Z0NEc283M3NsclRyajRRZzdKNlE3SXVkN0oyQUlPeUN0T3lWaE91Q3FPdUtsT3VMcEM0S0lDQWdJSEJ5YjJNZ1BTQnpjR0YzYmlod2NtOWpaWE56TG1WNFpXTlFZWFJvTENCYmNHRjBhQzVxYjJsdUtGOWZaR2x5Ym1GdFpTd2dKMk5zWVhWa1pTMWljbWxrWjJVdWFuTW5LVjBzSUhzS0lDQWdJQ0FnWTNka09pQlNUMDlVTENCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsTEFvZ0lDQWdmU2s3Q2lBZ2ZTQmxiSE5sSUhzS0lDQWdJQzh2SUcxaFkwOVRMK3Vtck91SWhleUtwRG9nNnJDUTdJdWM3SjZRNjZXOElPdWRoT3lhdENCdWIyUmxJT3lMcE8yV2lTRHRqSXpzbmJ6cm9ad2c3S2VCN0tDUklPeUtwTzJQc0NBb2JHRjFibU5vWkNEdA0KbVpqcXNyM3NsNVFnVUVGVVNPcXdnQ0RydVlqc2xiM3RsYUFnN0lpWUlPeWVpT3lXdENEc29JanJqSURxc3Izcm9ad2c3SUtzN0pxcEtRb2dJQ0FnY0hKdll5QTlJSE53WVhkdUtIQnliMk5sYzNNdVpYaGxZMUJoZEdnc0lGdHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTNXFjeWNwWFN3Z2V3b2dJQ0FnSUNCamQyUTZJRkpQVDFRc0lHUmxkR0ZqYUdWa09pQjBjblZsTENCemRHUnBiem9nSjJsbmJtOXlaU2NzQ2lBZ0lDQjlLVHNLSUNCOUNpQWdjSEp2WXk1MWJuSmxaaWdwT3lBdkx5RHFzSkRzaTV6c25wQWc3SjIwNjdLazdZcTRJT3VqcU8yVWhPeVhrT3lFbkNEcnRvVHJwcXdnS09xd2tPeUxuT3lla0NEc29vWHJvNHpycGJ3ZzY2ZUo3S2VBSU95Vml1cXlqQ2tLZlFvS0x5OGc3SjIwSUZCRDY2VzhJQ2ZzaEtUc3VaZ2c3S0NFS095RGlDQlFReWtuSU95RGdlMkRuT3VobkNEcmtKanJqNHpycHJEcmk2UWc0b0NVSU8yVWpPdWZyT3EzdU95ZHVDQmI3TFNJNnJpdzdabVUNClhTRHJzb1R0aXJ3b1VFOVRWQ0F2ZFc1cGJuTjBZV3hzS2V5ZHRDRHJ0b0RycGJqcmk2UXVDaTh2SUhKbFoybHpkR1Z5TFhCeWIzUnZZMjlzTG1wejZyQ0FJT3lFcE95NW1PMlZuQ0Rxc29Qc25ZUWc2cmU0NjR5QTY2R2NJT3VRbU91UGpPdW1zT3VMcERvZzZyQ1E3SXVjN0o2UUlPeWVrT3VQbWV5TG5PeWVrU0FySUNqc25vanNuTHpycWJRcElPeUVwT3k1bUNEdGo3VHJqWlF1Q2k4dklPS2FvTys0anlEcnNKanJrNXpzaTV3Z1NGUlVVQ0RzblpIcmk3WHNuWVFnNjZpODdLQ0FJT3V6dE91Q3VDRHJrcVFnN1ppNDdMYWM3WldnSU9xeWd5RGlnSlFnYldGalQxTWdiR0YxYm1Ob1kzUnNJR0p2YjNSdmRYVHNuYlFnN0oyMElPMlVoT3Vobk95RXVPeUtwT3VsdkNEc3BvbnNpNXdnN0tLRjY2T003SXVjN1lLc0lPeUltQ0Rzbm9qcmk2UXVDaTh2SUNBZ0lPcTN1T3VlbU95RW5DRHRqSXpzbmJ3b2NHeHBjM1RDdCt5RXBPeTVtQ0R0ajdUcmpaUXA3SjJFSUd4aGRXNWphR04wYk91enRPdUxwQ0RycUx6c29JQWc3S2VBDQo3SnEwNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc283M3NsNnpyajRRZzdKNlE2NCtaN0l1YzdKNlI3SjJBSU95ZHRPdXZ1Q0RzZ3F6cm5ienNwNFRyaTZRdUNtWjFibU4wYVc5dUlIVnVhVzV6ZEdGc2JGTmxiR1lvS1NCN0NpQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlGdGRPd29nSUhSeWVTQjdDaUFnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjJSaGNuZHBiaWNwSUhzS0lDQWdJQ0FnWTI5dWMzUWdURUZDUlV3Z1BTQW5ZMjl0TG1Oc1lYVmtaV0p5YVdSblpTNTNZWFJqYUdWeUp6c0tJQ0FnSUNBZ1kyOXVjM1FnY0d4cGMzUWdQU0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5UR2xpY21GeWVTY3NJQ2RNWVhWdVkyaEJaMlZ1ZEhNbkxDQk1RVUpGVENBcklDY3VjR3hwYzNRbktUc0tJQ0FnSUNBZ1kyOXVjM1FnYVc1emRDQTlJSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDZE1hV0p5WVhKNUp5d2dKMEZ3Y0d4cFkyRjBhVzl1SUZOMQ0KY0hCdmNuUW5MQ0FuUTJ4aGRXUmxRbkpwWkdkbEp5azdDaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0hCc2FYTjBLU2tnZXlCbWN5NTFibXhwYm10VGVXNWpLSEJzYVhOMEtUc2djbVZ0YjNabFpDNXdkWE5vS0hCc2FYTjBLVHNnZlNCOUlHTmhkR05vSUNoZlpTa2dlMzBLSUNBZ0lDQWdkSEo1SUhzZ2FXWWdLR1p6TG1WNGFYTjBjMU41Ym1Nb2FXNXpkQ2twSUhzZ1puTXVjbTFUZVc1aktHbHVjM1FzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsTENCbWIzSmpaVG9nZEhKMVpTQjlLVHNnY21WdGIzWmxaQzV3ZFhOb0tHbHVjM1FwT3lCOUlIMGdZMkYwWTJnZ0tGOWxLU0I3ZlFvZ0lDQWdJQ0IwY25rZ2V5QnpjR0YzYmxONWJtTW9KMnhoZFc1amFHTjBiQ2NzSUZzblltOXZkRzkxZENjc0lDZG5kV2t2SnlBcklIQnliMk5sYzNNdVoyVjBkV2xrS0NrZ0t5QW5MeWNnS3lCTVFVSkZURjBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE95QjlJR05oZEdOb0lDaGZaU2tnZTMwS0lDQWcNCklDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHNZWFZ1WTJoamRHd25MQ0JiSjNKbGJXOTJaU2NzSUV4QlFrVk1YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlFvZ0lDQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0NpQWdJQ0FnSUhSeWVTQjdJSE53WVhkdVUzbHVZeWduY21Wbkp5d2dXeWRrWld4bGRHVW5MQ0FuU0V0RFZWeGNVMjltZEhkaGNtVmNYRTFwWTNKdmMyOW1kRnhjVjJsdVpHOTNjMXhjUTNWeWNtVnVkRlpsY25OcGIyNWNYRkoxYmljc0lDY3ZkaWNzSUNkRGJHRjFaR1ZDY21sa1oyVlhZWFJqYUdWeUp5d2dKeTltSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPeUJ5WlcxdmRtVmtMbkIxYzJnb0oreWVrT3VQbWV5TG5PeWVrU2hEYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5S1NjcE95QjlJR05oZEdOb0lDaGZaU2tnZTMwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5DQpaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KMk5zWVhWa1pXSnlhV1JuWlRvdkx5RHJrN0hyb1owbktUc2dmU0JqWVhSamFDQW9YMlVwSUh0OUNpQWdJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lDQWdZMjl1YzNRZ2FXNXpkQ0E5SUhCaGRHZ3VhbTlwYmlod2NtOWpaWE56TG1WdWRpNU1UME5CVEVGUVVFUkJWRUVnZkh3Z2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSjBGd2NFUmhkR0VuTENBblRHOWpZV3duS1N3Z0owTnNZWFZrWlVKeWFXUm5aU2NwT3dvZ0lDQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlFvZw0KSUNBZ0lDQjlJR05oZEdOb0lDaGZaU2tnZTMwS0lDQWdJSDBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lCbVlXbHNMWE52Wm5RZzRvQ1VJT3VxdXlEc3A0RHNtclFnNnJLTUlPeWVpT3lXdE91UGhDRHRsSXpybjZ6cXQ3anNuYmdnN0txOUlPcTRzT3lXdFNEc2dxM3NvSnpyaXBRZzdKMjA2Nis0SU91Qm5ldUNyT3VMcENBcUx5QjlDaUFnY21WMGRYSnVJSEpsYlc5MlpXUTdDbjBLQ2k4dklPdUxwT3VtckNneE1UZzRPQ25xc0lBZzY1YWdJT3llaU95Y3ZPdXB0Q0RyZ1lqcmk2UWc0b0NVSU95MGlPcTRzTzJabENEc2k1d2c2NEtvN0oyQUlPeUV1T3lGbUNEc29KWHJwcXdnS095WGh1eWN2T3VwdENEc29iRHNtcW50bm9nZzdJdWs3WXlvS1FwbWRXNWpkR2x2YmlCemFIVjBaRzkzYmtKeWFXUm5aU2dwSUhzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2NpQTlJR2gwZEhBdWNtVnhkV1Z6ZENoN0lHaHZjM1E2SUNjeE1qY3VNQzR3TGpFbkxDQndiM0owT2lBeE1UZzRPQ3dnY0dGMGFEb2dKeTl6YUhWMFpHOTMNCmJpY3NJRzFsZEdodlpEb2dKMUJQVTFRbkxDQjBhVzFsYjNWME9pQXhOVEF3SUgwc0lDZ3BJRDArSUh0OUtUc0tJQ0FnSUhJdWIyNG9KMlZ5Y205eUp5d2dLQ2tnUFQ0Z2UzMHBPd29nSUNBZ2NpNXZiaWduZEdsdFpXOTFkQ2NzSUNncElEMCtJSHNnZEhKNUlIc2djaTVrWlhOMGNtOTVLQ2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmU0I5S1RzS0lDQWdJSEl1Wlc1a0tDazdDaUFnZlNCallYUmphQ0FvWDJVcElIdDlDbjBLQ21OdmJuTjBJSE5sY25abGNpQTlJR2gwZEhBdVkzSmxZWFJsVTJWeWRtVnlLQ2h5WlhFc0lISmxjeWtnUFQ0Z2V3b2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwS0lDQnBaaUFvY21WeExuVnliQ0E5UFQwZ0p5OW9aV0ZzZEdnbktTQjdDaUFnSUNBdkx5QjJPaURxc0pEc2k1enNucEFnN0wyVTY1T2NJT3V5aE95Z2hDRGlnSlFnDQo2cldzNjdLRTdLQ0VJTzJVaE91aG5PeUV1T3lLcE9xd2dDRHFzNFRzaG8wZzY0K002ck9nSU95ZWlPdUtsT3luZ0NEcnNKYnNsNURzaEp3ZzdabVY3SjI0N1pXWTY0cVVJT3lhcWV1UGhBb2dJQ0FnTHk4Z0tIWXlJRDBnN0xDOUlPeUlxT3E1Z0NEc2lKanNvSlh0akpBc0lIWXpJRDBnTDJGalkyOTFiblFnN0xhVTZyQ0E3WXlRTENCMk5DQTlJQzkxYm1sdWMzUmhiR3dnN0xhVTZyQ0E3WXlRTEFvZ0lDQWdMeThnSUhZMUlEMGc2ck9FN0tDVjdKMkVJT3lla09xeXFleW1uZXVxaFNEc25LRHJyTFRyb1p3ZzdZeVE3S0NWSU9LQWxDRHJvWnpxdDdqc2xZVHNtNE1nNjVLa0lPdUNxT3lkZ0NEc25iVHJxWlRzbmJ6c25ZUWc2NkdjNnJlNDdKMjQ3Snk4NjZHY0lPeVlwTzJWdE8yVm1PeW5nQ0RzbFlycXNvd3BDaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnZDJGMFkyaGxjam9nZEhKMVpTd2dkam9nTmlCOUtUc0tJQ0I5Q2lBZ0x5OGc3SjIwSUZCRDdKZVFJT3Vobk9xMw0KdU95ZHVPdVFuQ0R0Z2JUcm9aenJrNXdnNnJPRTdLQ1ZJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3TEtySU8yWmxPdXB0TUszN1ptSTdKMjBJQ0xyaUlUcXRhd2c2ck9FN0tDVjdKeTg2NkdjSU95VHNPdUtsT3luZ0NJZzY3TzA3SmVzN0tPODY0cVVJT3VOc0NEc2s3VHJpNlF1Q2lBZ0x5OGc2ckNRN0l1YzdKNlE2ckNBSU91THRlMlZtT3VLbENEc25iVHNuS0E2SU91THBPdW1yT3VsdkNEc3ZKenJxYlFnN0p1TTY3Q043SmVGN0p5ODY2R2NJTzJCdE91aG5PdVRuT3F3Z0NEc2k2VHNvSndnN1ppNDdMYWM2NCs4SU9xMXJPdVBoU0RzZ3F6c21xbnJuNG5zbmJRZzY0S1k2ckNFNjR1a0xnb2dJQzh2SU9xd2tPeUxuT3lla091S2xDRHRqSXpzbmJ6cnA0d2c3SjI5N0p5ODY2K0E2NkdjSU95Q3JPeWFxZXVmaVNBd0lNSzNJT3VNZ09xNHNDQXdJT0tBbENEcXNvRHRocURycDR3ZzdKT3c2NHFVSU95Q3JPdWVqT3lYa09xeWpDRHJ1WVRzbXFuc25ZUWc2Nnk4NjZhczdLZUFJT3lWaXV1S2xPdUxwQzRLSUNBdkx5RHMNCm83enNuWmc2SU95WHJPcTRzQ0RxczRUc29KWHNuYlFnNjdPMDdKZXM2NCtFSU95ZWhleWVwZXEyak95ZHRDRHJwNHpybzR6cmtKRHNuWVFnN0lpWUlPeWVpT3VMcENqc25LRHRtcWpzaExIc25ZQWc3SXVrN0tDY0lPMll1T3kybkNEcmxZenJwNHdnN0pXTUlPeUltQ0Rzbm9qc25Zd2c0b0NVSU91THBPdW1yQ0F2YUdWaGJIUm83SjJZSUhCeWIySnNaVzBnN0xDNDZyT2dLUzRLSUNCcFppQW9jbVZ4TG5WeWJDQTlQVDBnSnk5aFkyTnZkVzUwSnlrZ2V3b2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJR0ZqWTI5MWJuUTZJR05zWVhWa1pVRmpZMjkxYm5Rb0tTd2dZMnhoZFdSbE9pQm9ZWE5EYkdGMVpHVW9LU0I5S1RzS0lDQjlDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM2RoYTJVbktTQjdDaUFnSUNCcFppQW9JV2hoYzBOc1lYVmtaU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2DQphem9nWm1Gc2MyVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y2dmU2s3Q2lBZ0lDQjNZV3RsUW5KcFpHZGxLQ2s3Q2lBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2QyRnJhVzVuT2lCMGNuVmxJSDBwT3dvZ0lIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjMmgxZEdSdmQyNG5LU0I3Q2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdDaUFnSUNCeVpYUjFjbTQ3Q2lBZ2ZRb2dJQzh2SU95MGlPcTRzTzJabENEaWdKUWc3SjIwSUZCRDY2VzhJQ2ZzZzRnZ1VFTW5JT3lEZ2UyRG5PdWhuQ0Rya0pqcmo0enJwckRyaTZRZ0tPMlVqT3Vmck9xM3VPeWR1Q0JiN0xTSTZyaXc3Wm1VWFNEcnNvVHRpcndwTGdvZ0lDOHZJT3lka2V1THRleWRoQ0RycUx6cw0Kb0lBZzdaMlk2NkNrNjdPMDY0SzRJT3VTcENEc29KWHJwcXp0bFp6cmk2UWc0b0NVSUdKdmIzUnZkWFRzbmJRZzdKcXc2NmFzNjZXOElPeW1pZXlMbkNEc283M3NsNnpyajRRZzdacU03SXVnN0oyQUlPdVBoT3l3cWUyVm5PdUxwQzRLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZFc1cGJuTjBZV3hzSnlrZ2V3b2dJQ0FnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnY0d4aGRHWnZjbTA2SUhCeWIyTmxjM011Y0d4aGRHWnZjbTBnZlNrN0NpQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSHNLSUNBZ0lDQWdjMmgxZEdSdmQyNUNjbWxrWjJVb0tUc0tJQ0FnSUNBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUhWdWFXNXpkR0ZzYkZObGJHWW9LVHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0M1lYUmphR1Z5WFNEc3RJanF1TER0bVpRb2RXNXBibk4wWVd4c0tTRGlnSlFnN0tDYzZyR3dPaWNzSUhKbGJXOTJaV1F1YW05cGJpZ24NCkxDQW5LU0I4ZkNBbktPeVhodXlkakNrbktUc0tJQ0FnSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdDaUFnSUNCOUxDQXlOVEFwT3dvZ0lDQWdjbVYwZFhKdU93b2dJSDBLSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURRd05Dd2dleUJsY25KdmNqb2dKMDV2ZENCbWIzVnVaQ2NnZlNrN0NuMHBPd29LTHk4ZzdKMjA2Nis0SU91V29DRHNub2pzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lpaGV1ampDQW83SjZRNjQrWklPeUxuT3lla1NBcklHNXdiU0JpZFdsc1pDRHNwSkhyczdVZzdJdWs3WmFKSU91TWdPdTVoQ2tLYzJWeWRtVnlMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUI3Q2lBZ2FXWWdLR1VnSmlZZ1pTNWpiMlJsSUQwOVBTQW5SVUZFUkZKSlRsVlRSU2NwSUhCeWIyTmxjM011WlhocGRDZ3dLVHNLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3Q24wcE93cHpaWEoyWlhJdWJHbHpkR1Z1S0ZCUFVsUXNJQ2N4TWpjdU1DNHdMakVuTENBb0tTQTlQaUI3DQpDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHRnYlRyb1p6cms1d2c2NHVrNjZhc0lPcXdrT3lMbk95ZWtDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFySUZCUFVsUXBPd3A5S1RzS0x5OGdTVkIyTmlEcm82anRsSVRyc0xFb09qb3hLZXlYa091UGhDRHRsYWpxdTVnZzY1T2o2NHFVNjR1a0lPS0FsQ0FuYkc5allXeG9iM04wSitxd2dDQTZPakhyb1p3ZzY2aTg3S0NBSU8yVnRPeUVuZXVRbU91S2xDRHRtWmpxc3Izc2w1RHNoSndLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlFbFFkalRyb1p3ZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDRHJpNlRycHF3ZzZybW83SnF3NnJpd3dyZnFzNFRzb0pVZzdLR3c3WnFNNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJqWmdnNjZ5NDdLQ2NJT3VNZ095ZGtTanJpNlRycHF6c21ZQWc2NCtaN0oyOEtTNEtZMjl1YzNRZ2MyVnlkbVZ5TmlBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtITmxjblpsY2k1cw0KYVhOMFpXNWxjbk1vSjNKbGNYVmxjM1FuS1Zzd1hTazdDbk5sY25abGNqWXViMjRvSjJWeWNtOXlKeXdnS0NrZ1BUNGdlMzBwT3lBdkx5QTZPakhzbllRZzY2cTdJT3llb2V5VmhPdVBoQ2hGUVVSRVVrbE9WVk5Gd3JkSlVIWTJJT3lYaHV5ZGpDa2dTVkIyTk91bmpPeWN2T3VobkNEcXM0VHNobzBnNjQrWjdKNlJDbk5sY25abGNqWXViR2x6ZEdWdUtGQlBVbFFzSUNjNk9qRW5LVHNLDQo6OldTSUxFTlQ6Og0KSnlCRGJHRjFaR1VnUW5KcFpHZGxJSGRoZEdOb1pYSWdjMmxzWlc1MElHeGhkVzVqYUdWeUlDaHVieUIzYVc1a2IzY3BJQzBnY21WbmFYTjBaWEpsWkNCMGJ5QnlkVzRnWVhRZ2JHOW5hVzRLVTJWMElHWnpieUE5SUVOeVpXRjBaVTlpYW1WamRDZ2lVMk55YVhCMGFXNW5Ma1pwYkdWVGVYTjBaVzFQWW1wbFkzUWlLUXBUWlhRZ2MyZ2dQU0JEY21WaGRHVlBZbXBsWTNRb0lsZFRZM0pwY0hRdVUyaGxiR3dpS1Fwa2FYSWdQU0JtYzI4dVIyVjBVR0Z5Wlc1MFJtOXNaR1Z5VG1GdFpTaFhVMk55YVhCMExsTmpjbWx3ZEVaMWJHeE9ZVzFsS1FwemFDNURkWEp5Wlc1MFJHbHlaV04wYjNKNUlEMGdaR2x5Q25Ob0xsSjFiaUFpWTIxa0lDOWpJRzV2WkdVZ2MyTnlhWEIwYzF4aWNtbGtaMlV0ZDJGMFkyaGxjaTVxY3lJc0lEQXNJRVpoYkhObENnPT0NCjo6RU5EOjoNCg==";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAAAhN8sCf5MCAH+TAgAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21sa1oyVXBDaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdUNpOHZDaTh2SU95R2pldVBoQ0RzaEtUcXM0UTZJTzJCdE91aG5PdVRuT3VsdkNEc21wVHNzcTNycDRqcmk2UWc3SU9JNjZHY0lPeUxuT3VQbWUyVm1PdXB0Q0F6TUg0ME1PeTBpT3F3Z0NEcXQ3anJnNlVnNjRLZzdKV0U2ckNFNjR1a0xnb3ZMeURpaHBJZzY0dWs2NmFzNjZXOElPeThwQ0RybFl3ZzdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZGhDRHRsWmpyZ3BnZzdKZTA3SmEwSU95RGdleUxuQ0RyaklEcXVMRHNpNXp0Z3FUcXM2QW9jM1J5WldGdExXcHpiMjRnNjR5QTdabVVJT3VxcU91VG5Da3NDaTh2SUNBZzZyQ0E3SjIwNjVPY0sreVlpT3lMbkNneE1USHFzYlFwNjRxVUlPeXlxeURycVpUc2k1enNwNERyb1p3ZzdaV2NJT3V5aU91bmpDRHNuYjN0bm96cmk2UXVJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2Nnk0NnJXczY2ZU1JT3V6dE91Q3RPdXZnT3VobkNEcnVhRHJwYlRyaTZRdUNpOHZJT3lFdU95Rm1PeWRnQ0F6TU91eWlDRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdaVzBJT3VNZ08yWmxPcXdnQ0RyckxUdGxaenRub2dnNnJpNDdKYTA3S2VBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpOHZDaTh2SU95Z2hPeWduRG9nN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPeWRoQ0Rxc29NZ0tHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKeTg2NkdjSU8yWmxleWR1Q2tLTHk4ZzdLTzg3SjJZT2lEc2dxenNtcW5ybjRuc25ZQWc2ckNCN0o2UUlPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFuT3VMcEM0S0NtTnZibk4wSUdoMGRIQWdQU0J5WlhGMWFYSmxLQ2RvZEhSd0p5azdDbU52Ym5OMElHWnpJRDBnY21WeGRXbHlaU2duWm5NbktUc0tZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3Q25SeWVTQjdJR1p6TG0xclpHbHlVM2x1WXloRlRWQlVXVjlEVjBRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbElIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwamIyNXpkQ0JEVEVGVlJFVmZSVTVXSUQwZ1QySnFaV04wTG1GemMybG5iaWg3ZlN3Z2NISnZZMlZ6Y3k1bGJuWXNJSHNLSUNCTlFWaGZWRWhKVGt0SlRrZGZWRTlMUlU1VE9pQW5NQ2NzSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNnNTNxc0lFZzY2cW82NU9jSU91QmxDQW83S2VuN0oyQUlPdXN1T3Exck95WGxDRHJ0b2p0bFlUc21wUXBDaUFnUTB4QlZVUkZYME5QUkVWZlJFbFRRVUpNUlY5T1QwNUZVMU5GVGxSSlFVeGZWRkpCUmtaSlF6b2dKekVuTENBdkx5RHRoTFFnN0pxVTdKVzlJT3VUc1NEcnRvRHFzSUFnN1ppNDdMYWNJT3VCbEFvZ0lFUkpVMEZDVEVWZlZFVk1SVTFGVkZKWk9pQW5NU2NzQ24wcE93b0tMeThnN0lpbzZybUFJT3lMcE8yV2lTanFzSkRzaTV6c25wQWc3SXFrN1krdzdKMkFJSE4wWkdsdklHbG5ibTl5WlNuc2w1RHNoSnpyajRRZzY2eTQ3S0NjNjZXOElPeTJsT3lnZ2UyVm9DRHNpSmdnN0o2STZyS01JT3k5bU95R2xDRHJvWnpxdDdqcnBid2c3WXlNN0oyODdKZVE2NCtFSU91Q3FPcTR0T3VMcEM0S0x5OGc3SnlFN0xtWU9pRHNub1RzaTV3ZzdZKzA2NDJVN0oyWUlHTnNZWFZrWlMxaWNtbGtaMlV1Ykc5bklDanNuSWpyajRUc21yQWdKVlJGVFZBbExDRHJwNlVnSkZSTlVFUkpVaWt1SURKTlFpRHJoSmpzbkx6cnFiUWdMbTlzWk91aG5DRHRsWndnN0lTNDY0eUE2NmVNSU91enRPcTBnQzRLWTI5dWMzUWdURTlIWDBaSlRFVWdQU0J3WVhSb0xtcHZhVzRvYjNNdWRHMXdaR2x5S0Nrc0lDZGpiR0YxWkdVdFluSnBaR2RsTG14dlp5Y3BPd3BqYjI1emRDQmZiM0pwWjB4dlp5QTlJR052Ym5OdmJHVXViRzluTG1KcGJtUW9ZMjl1YzI5c1pTazdDbU52Ym5OdmJHVXViRzluSUQwZ1puVnVZM1JwYjI0Z0tDa2dld29nSUdOdmJuTjBJR0Z5WjNNZ1BTQkJjbkpoZVM1d2NtOTBiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bmFXWjVLR0VwS1NrdWFtOXBiaWduSUNjcElDc2dKMXh1SnpzS0lDQWdJR1p6TG1Gd2NHVnVaRVpwYkdWVGVXNWpLRXhQUjE5R1NVeEZMQ0JzYVc1bEtUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUR0akl6c25id2c2NkdjNnJlNElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUcnBxenJpcFFnNnJPRTdJYU5JQ292SUgwS2ZUc0tDbU52Ym5OMElGQlBVbFFnUFNCT2RXMWlaWElvY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDFCUFVsUXBJSHg4SURFeE9EZzRPeUF2THlCQ1VrbEVSMFZmVUU5U1ZPdUtsQ0R0aFl6c2lxVHRpcmpzbXFrZ0tPMlBpZXlHak95WGxDQXhNVGc0T0NEcXM2RHNvSlVwQ2k4dklPdUxwT3VtckNEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVm5PdUxwQzRnN0wyVTY1T2M2Nlc4SUhCMWJHekN0K3V6dGV5Q3JPMlZ0T3VQaENBcUt1eWR0T3V2dUNEcmxxQWc3SjZJNjRxVUlPdUxwT3Vtck91S2xDRHNtSnNnN0wyVTY1T2NJT3EzdU91TWdPdWhuQ29xNjUyOENpOHZJT3E3a091THBDRHN2SnpxdUxBZzdLQ0U3SmVVSU95RGlDRHJqNW5zbnBIc25iUWc3SldJSU91Q21PeVlxT3VMcENqdGhMRHJyN2pyaEpEc25iUWc2NXlvNjRxVUlPdVRzU2t1SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RzbmJRZzZyQ1M3Snk4NjZHY0lPcTFyT3V5aE95Z2hPeWRoQ0Rxc0pEc3A0RHRsYlFnN0o2czdJdWM3SjZSN0l1YzdZS282NHVrTGdvdkx5RHJqNW5zbnBIc25iUWc2N0NVNjRDTTY0cVVJT3lJbU95Z2xleWRoQ0R0bFpqcnFiUWc3SjIwSU95SXEreWVrT3VsdkNEc21LenJwcXpxczZBZ1kyOWtaUzUwYyt5ZG1DQkNVa2xFUjBWZlRVbE9YMWJyajRRZzZyQ1o3SjIwSU95WXJPdW1zT3VMcEM0S1kyOXVjM1FnUWxKSlJFZEZYMVlnUFNBME1Uc0tMeThnNnJpdzY3TzRJT3VxcU91TnVDNGc3SnFVN0xLdEtPMlVqT3Vmck9xM3VPeWR1Q25zbmJRZ2JXOWtaV3pzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3EzdUNEc21wVHNzcTNycDR3ZzZyZTRJT3VxcU91TnVPdWhuQ0Rzc3BqcnBxenRsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPY0lDaHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FnNG9DVUlHSjFhV3hrTFdkc2IzTnpZWEo1TG1wejdKbUFJT3F3bWV5ZGdDRHRqSXpzaEp3cElPS1VnT0tVZ0FwbWRXNWpkR2x2YmlCc2IyRmtSWGhoYlhCc1pYTW9LU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FuS1N3Z0ozVjBaamduS1RzS0lDQWdJR052Ym5OMElITmxZMGxrZUNBOUlHMWtMbk5sWVhKamFDZ3ZYaU1qSU95MmxPeXluQ0RzbUlqc2k1eGNjeW9rTDIwcE93b2dJQ0FnYVdZZ0tITmxZMGxrZUNBOVBUMGdMVEVwSUhKbGRIVnliaUJiWFRzS0lDQWdJR052Ym5OMElHVjRZVzF3YkdWeklEMGdXMTA3Q2lBZ0lDQnNaWFFnWTNWeUlEMGdiblZzYkRzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnY21GM0lHOW1JRzFrTG5Oc2FXTmxLSE5sWTBsa2VDa3VjM0JzYVhRb0oxeHVKeWtwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlISmhkeTV5WlhCc1lXTmxLQzljY3lza0x5d2dKeWNwT3dvZ0lDQWdJQ0JqYjI1emRDQm9JRDBnYkdsdVpTNXRZWFJqYUNndlhpTWpJMXh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9hQ2tnZXlCamRYSWdQU0I3SUdsdWNIVjBPaUJvV3pGZExDQnpkV2RuWlhOMGFXOXVjem9nVzEwZ2ZUc2daWGhoYlhCc1pYTXVjSFZ6YUNoamRYSXBPeUJqYjI1MGFXNTFaVHNnZlFvZ0lDQWdJQ0JqYjI1emRDQmlJRDBnYkdsdVpTNXRZWFJqYUNndlhseHpLaTFjY3lzb0xpcy9LVnh6S2lRdktUc0tJQ0FnSUNBZ2FXWWdLR0lnSmlZZ1kzVnlLU0JqZFhJdWMzVm5aMlZ6ZEdsdmJuTXVjSFZ6YUNoaVd6RmRMbk53YkdsMEtDY2dMeUFuS1M1cWIybHVLQ2NnSnlrcE93b2dJQ0FnZlFvZ0lDQWdjbVYwZFhKdUlHVjRZVzF3YkdWekxtWnBiSFJsY2lnb1pTa2dQVDRnWlM1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ1BpQXdLVHNLSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpd0lPcXpvT3k1cUNBcklPeVd0T3lJbkNEcnM0RHFzcjBpN0oyMElPdVFuT3VMcEM0ZzdKZXQ3WldnSU91MmhPdW1yQ0RpZ0pRS0x5OGc3WUcwNjZHYzY1T2NJRDBnNjZ5NDdKNmxJT3VMcE91VHJPcTRzQ2pzc0wzc25aZ3BMQ0RzbXFuc2xyUWc3WWExN0oyOHdyZnJwNTdzdHFUcnNwVWdQU0JqYjJSbExuUnpJSEpsWm1sdVpVRnBVM1ZuWjJWemRHbHZibk1nN1p1RTdMS1k2NmFzS09xNHNPcXpoT3lnZ1NrdUNtTnZibk4wSUZOVVdVeEZYMUpWVEVWVElEMGdXd29nSUNjeExpRHRsYlRzbXBUc3NyUTZJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWc3WlcwN0pxVTdMSzA2NkdjTGlBbzY3TzA2NE9GNjR1STY0dWs0b2FTNjdPMDY0SzA3SnFVS1Njc0NpQWdKekl1SU91S3BldVBtZXlnZ1NEcnA1RHRsWmpxdUxBNklPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ3dnZnV5WGlDRHJ1YnpxdUxBbzY3Q1U2NENNN0plSTdKYTA3SnFVNG9hUzY3Q1U2citvN0phMDdKcVVLUzRnNjR1b0xDRHNvb1hybzR6Q3QrdW5qT3Vqak1LMzdKZXc3TEswd3JmdGxiVHNwNERDdCtxNHNPdWhuY0szNjRXNTdKMk1JT3VUc1NEc2k1enNpcVR0aFp6c25iUWc3S084N0xLMDdKMjRJT3F5c09xenZPdUtsQ0RzaUpqcmo1bnRtSlVnN0p5ZzdLZUFLT3lYc095eXRPdVB2T3lhbEN3ZzY0VzU3SjJNNjQrODdKcVVLUzRuTEFvZ0lDY3pMaURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3T2lBaWZ1MlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlpRHJqSURzaTZBZ0luN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRaUlPcTFyT3loc0NEc21yRHNoS0F1SU91THFDd2c3S0NWN0xHRjdJT0JJT3UyaU9xd2dNSzM3SjI4NjdhQUlPcTRzT3VLcFNEc29KenRsWnpDdCt1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPcXlzT3F6dk1LMzdLQ1Y2N08wSU91enRPMll1Q0RzbFlqc2k2enNuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMmVpQzRuTEFvZ0lDYzBMaURzdXBEc283enNscnp0bFp3ZzZySzk3SmEwT2lCKzdaV1k3SXVjNnJLZzdKYTA3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cExpY3NDaUFnSnpZdUlPMlJuT3E0c0RvZzY1Q1k3SmEwN0pxVTRvYVM2NCs4N0pxVUxpY3NDaUFnSnpjdUlPeWtoQ0RxdGF6c29iQTZJT3lia091enVPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPeTJsT3l5bk91UGhDRHJzSmpyazV6c2k1d2c3WldjSU95a2hPdWhuQzRnN0o2RTdKMlk2NkdjSU95a2hPeWRoQ0RyaXBqcnBxenNwNEFnN0pXSzY0cVU2NHVrTGlEcmk2Z3NJT3lYck91ZnJDRHJyTGpzbnFYc25ZUWc3WldZNjRLWTdKMllJT3E0amV5Z2xlMllsU0Ryckxqc25xWHNuTHpyb1p3ZzdaV3A3TE9RSU91TmxDRHFzSVRxc3JEdGxiVHNwNFRyaTZUcnFiUWc3S1NFSU95SW1PdWx2Q0RzcElUc25iVHJpcFFnNnJLRDdKMkFJTzJabU95WWdTNG5MQW9nSUNjNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1NEcnNvVHRpcnc2SU9xeXNPcXp2Q0R0aHJYcnM3VHJpcFFnVysyWmxleWR1RjBzSU95WWlDL3NsWVRyaTRqc21LUWc3WXlRNjR1bzdKMkFJRnZzbFlUcmk0anNtS1JkTDF2cmhLUmRMQ0RyajVuc25wRWc3SnlnNjQrRTY0cVVJRnZzdDZqc2hveGRMMXQ3NjQrWjdKNlJmVjB1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ0RzazdEcXM2QWdJdXVMcStxNHNNSzM2NCtaN0o2Ukl1eXltT3VmdkNEc3A1MGc3SldJSU91bm51dUtsQ0Rzb2JEdGxhbkN0K3VMcU91UGhTQWk3TGVvN0lhTUl1dUtsQ0RxdUlqc3A0QXVKeXdLSUNBbk9TNGc3SjIwNjZhRXdyZnNvSVR0bVpUcnNvanRtTGpDdCt1bmlPeUtwTzJDdWV5ZGdDRHF0N2pyaklEcm9ad2c2N08wN0tHMExpRHNncXpybm96c25ZUWc2N2FBNjZXOElPdVZrQ0RyaTVqc25ZUWc2N2FaN0plczY0K0VJT3lpaSt1THBDNG5MQW9nSUNjeE1DNGc3S0NjN1pLSUlPeWFxZXlXdENEc25LRHNwNEE2SU95ZWhldWdwZXlYa0NEc2s3RHNuYmdnNnJpdzY0cWw3SVN4SU91cWhleUNyQ2pyczREcXNyMHNJT3luZ095Z2xTd2c2NU94NjZHZExDRHRsYlRzb0p3ZzY1T3hLZXVLbENEdG1aVHJxYlRzblpnZzZyaXc2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqc2lKanJqNW50bUpYQ3QrcXl2ZXlXdE1LMzY3YUE3S0NWN1ppVklPMlhpT3lhcVNEc3ZJRHNuYlRzaXFRcDdKMllJT3VKbU95Vm1leUtwT3F3Z0NEc25LRHNpNlRya0p6cmk2UXVDaTh2SU8yTWpPeWR2T3lkdENEc2w0YnNuTHpycWJRbzdJU2s3TG1ZNjdPNElPcTFyT3V5aE95Z2hDRHJrN0VwSU91NWlDRHJyTGpzbnBEc2w3UWc0b0NVSU95YWxPeVZ2ZXVuak95Y3ZPdWhuQ0RyajVuc25wRW9abUZwYkMxemIyWjBLUzRLWm5WdVkzUnBiMjRnYkc5aFpFZDFhV1JsS0NrZ2V3b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuZFhndGQzSnBkR2x1Wnk1dFpDY3BMQ0FuZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUhKbGRIVnliaUJ0WkM1c1pXNW5kR2dnUGlBeE1EQWdQeUJ0WkNBNklDY25Pd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3Vobk91VG5DRHNpNlR0aktnZ0tPeWFsT3lWdmV1bmpPeWN2T3VobkNEc3A0VHRsb2twT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNCeVpYUjFjbTRnSnljN0NpQWdmUXA5Q21OdmJuTjBJRWRWU1VSRklEMGdiRzloWkVkMWFXUmxLQ2s3Q2dwbWRXNWpkR2x2YmlCcGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTQjdDaUFnWTI5dWMzUWdabVYzVTJodmRDQTlJRVZZUVUxUVRFVlRMbTFoY0Nnb1pYZ3BJRDArSUNkSmJuQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExtbHVjSFYwS1NBcklDZGNiazkxZEhCMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG5OMVoyZGxjM1JwYjI1ektTa3VhbTlwYmlnblhHNG5LVHNLSUNCeVpYUjFjbTRnS0FvZ0lDQWdKK3luZ09xNGlPdTJnTzJFc0NEcmhJanJpcFFnN0plUTdJcWs3SnVRS0ZNdE1Td2c2N08wN0pXSTdacU03SUtzS2V5ZG1DRHRsWnpxdGEzc2xyUWdWVmdnVjNKcGRHbHVaeURzb0lUcnJManFzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91THBDNGdKeUFyQ2lBZ0lDQW43S0d3NnJHMElPMlJuTzJZaENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzB3cmZzdElqcXM3ekN0K3V2dU91bmpNSzM2N2FBN1lTd3dyZnF1WXpzcDRBZzY1T3hLZXlkZ0NEc29KWHNzWVVnN0tDVjY3TzA2NHVrSU9LQWxDRHJ1Ynpxc2JEcmdwZ2c2NHVrNjZXNElPeWhzT3F4dE95Y3ZPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhLQ0kxN1pxTUlPeWR0T3lEZ1NMc25ZUWdJalh0bW93aTY2R2NJT3lraE95ZHRPdXB0Q0RzbUtUcmk3VXBMaUFuSUNzS0lDQWdJQ2ZzbTVEcnJManNsNUFnN0plRzY0cVVJT3Exck95eXRDRHNvSlhyczdRbzdLQ0U3Wm1VNjdLSTdaaTR3cmRWVWt6Q3QrcTRpT3lWb2NLMzdJdWM2ckNFSU91VHNTbnNtWUFnN1pXMDZyS3dJT3V3cWV1eWxjSzM3S0NJN0xDb0tPeWVyT3lFcE95Z2xjSzM2Nnk0N0oyWTdMS1l3cmZzbnF6c2k1enJqNFFnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjdhWjdKMjA2NHFVSU9xeWcreWRnQ0Rzb0lqcmpJQWc2cmlJN0tlQUlPS0FsQ0RzbFlUcmlwUWc2ckNTN0oyMDY1Mjg2NCtFTENEcXQ3anJuN1RyazYvdGxiVHJqNFFnN0pPdzdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdKelBxc0p3ZzdLQ2M3SldJN0oyQUlPeUVuT3VobkNEc29KSHF0N3pzbmJRZzY0dXM2NTI4N0pXOElPMlZuT3VMcENEaWdKUWc3WldZNjRLWTY0cVVJT3lia091c3VDRHF0YXpzb2JEcnBid2c3SnlnN0tlQTdaV2NJT3kxbk95R2pDRHJpNlRyazZ6cXVMQXNJTzJWbU91Q21PdUtsQ0Ryckxqc25xVWc2cldzN0tHdzY2VzhJT3llck9xMXJPeUVzZTJWbkNEcmpJRHNsWWdzSUNjZ0t3b2dJQ0FnSitxM3VPdW1yT3F6b0NEc29JSHNsclRyajRRZzdaV1k2NEtZNjRxVUlPcXp2T3F3a08yVm5DRHNucXpxdGF6c2hMRTZJT3lra2V1enRTRHRrWnp0bUlUc25ZUWc2NDJjN0phMDY0SzA2ck9nTENEc29KWHJzN1FnN0lpYzdJU2M2Nlc4SU95Q3JPeWFxZXlla09xd2dDRHNsWXpzbFlUc2xid2c3WldnSU9xeWcrdTJnTzJFc091aG5DRHNucXpzb2JEc3A0SHRsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZ0lDQWdKK3lWaE91ZW1DRHNtSWpzaTV6cms2VHNuWUFnN1pXY0lPeWtoT3lubk91bXJDRHN0WnpzaG93ZzZyV1E3S0NWN0oyMElPdW5qdXluZ091bmpDRHF0N2pxc2JRZzdZYWtLTzJWdE95YWxPeXl0TUszNnJLOTdKYTBLZXlkbUNEcXRaRHJzN2pzbmJUc3A0QWc3SWFNNnJlNTdJU3g3SjJZSU9xMWtPdXp1T3lkdENEc2xZVHJpNGpyaTZRZzRvQ1VJT3lYck91ZnJDRHJyTGpzbnFYc3A1enJwcXdnN0o2RjY2Q2w3SjJBSU91cGxPeUxuT3luZ0NEcmk2anNuSVRyb1p3ZzY0dWs3SXVjSU95RXBPcXpoTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcnNMRHNsN1RycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaGNLMzdMMlU2NU9jN1k2YzdJcWtJT3E0aU95bmdEcGNiaWNnS3dvZ0lDQWdKMXQ3SW5SbGVIUWlPaUFpN0tDYzdKV0lJT3VzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV1c3RPeVhoK3lkaENEc21ad2c2N0NVNnIrbzY0cVU3S2VBSU8yVm5PcTFyZXlXdENEdGxad2c2Nnk0N0o2bEluMHNJQzR1TGwxY2JseHVKeUFyQ2lBZ0lDQW5XK3lLcE8yRGdPeWR2Q0RxdDV6c3VabGRYRzRuSUNzZ1UxUlpURVZmVWxWTVJWTWdLeUFuWEc1Y2JpY2dLd29nSUNBZ0tFZFZTVVJGSUQ4Z0oxdnNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3lnaE91c3VDQW9kWGd0ZDNKcGRHbHVaeTV0WkNrZzRvQ1VJT3ljaENEcXQ1enN1Wm5zblpnZzZyZTg2ckd3N0ptQUlPeVlpT3ladUNEc2k1enJncGpycHF6c21LUXVJTzJLdWUyZWlDRHNtSWpzbWJnZzZyZWM3TG1aS095SW1PdVBtZTJZbGNLMzZySzk3SmEwd3JmcnRvRHNvSlh0bUpYc25ZUWc3SnlnN0tlQTdaVzA3Slc4SU8yVm1PdUtsQ0RzZzRIdG1ha3A3SjJFSU9xM3VPdU1nT3VobkNEcmxMRHJwYlRxczZBc0lPeWFsT3lWdmVxenZDRHNvSVRyckxqc25iUWc2NHVrNjZXMDY2bTBJT3lnaE91c3VPeWRoQ0RybExEcnBianJpNlJkWEc0bklDc2dSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cGJtVkNkV1lnUFNBbkp6c2dJQ0FnSUNBZ0lDQXZMeUJ6ZEdSdmRYUWc3S1NFSU91eWhPMk52QXBzWlhRZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQzh2SU8yWWhPeWVyQ0R0aExUc25aZ2dleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIMEtiR1YwSUhGMVpYVmxJRDBnVUhKdmJXbHpaUzV5WlhOdmJIWmxLQ2s3SUM4dklPeWFsT3l5clNEc3A0SHJvS3p0bVpRZ0tPdVBtZXlMbkNEc21wVHNzcTNzbllBZzdJaWM3SVNjNjR5QTY2R2NLUXBzWlhRZ2RIVnlibk1nUFNBd093cHNaWFFnZDJGeWJXVmtWWEFnUFNCbVlXeHpaVHNLYkdWMElHTjFjbkpsYm5STmIyUmxiQ0E5SUVOTVFWVkVSVjlOVDBSRlREc2dMeThnN0tlQTZyaUlJT3lFdU95Rm1PeWR0Q0Ryckx6cXM2QWc3SjZJNjRxVUlPdXFxT3VOdUNBbzdKcVU3TEt0N0oyMElPdUxwT3VsdUNEcnFxanJqYmpzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3lFdU95Rm1DRHNucXpzaTV6c25wRXBDaTh2SU95TG5PeWVrU0RzaTV3Z1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbElFTk1TU25xc0lBZzdKTzRJT3lJbUNEc25vanJpcFRzcDRBZzdLQ1E2cktBSU9LQWxDRHNsNGJzbkx6cnFiUWdMMmhsWVd4MGFPdWhuQ0RzbFl6cm9LUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeVZpT3VDdE8yVm5PdUxwQzRLTHk4Z2JuVnNiRDN0bVpYc25iZ2c3S1NSTENBbmIyc25QZXlDck95YXFTRHFzSURyaXFVc0lDZGpiR0YxWkdVdGJXbHpjMmx1WnljOVkyeGhkV1JsSU91cWhldWd1U0RzbDRic25Zd3NDaTh2SUNkamJHRjFaR1V0Ykc5bmIzVjBKejFqYkdGMVpHWHJpcFFnN0o2STdLZUE2NmVNSU91aG5PcTN1T3lkdUNEc2hManNoWmdnNjZlTTY2T01JQ2p0aExRZzdJdWs3WXlvSU95TG5DRHFzSkRzcDRBc0lPeUVzZXF6dFNEdGhMVHNuYlFnN0ppazY2bTBJT3lla091UG1TRHRsYlRzb0p3cENpOHZJQ2RqYkdGMVpHVXRiR2x0YVhRblBldWhuT3EzdU95ZHVPeWRnQ0Rya0pEc3A0RHJwNHdnN0lLczdKcXBJTzJWbk91UGhDRHN0SWpxczd3Z0tPeWhzT3k1bU9xd2dDRHNucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWjdKMkFJT3F5dmV1aG5PdWhuQ0RzbnFIdG5vanJyNERyb1p3ZzdLU1I2NmE5SU8yUm5PMlloT3lkaENEc2s3VHJpNlFLWTI5dWMzUWdURTlIU1U1ZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVPeWR0Q0R0bFlUc21wVHRsYlRzbXBRbzdKV0lJT3VRa09xeHNPdUNtQ0RycDR6cm80d3BJT0tBbENCYjhKK2ZvQ0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjBnNjdLRTdZcTg3SjJFSU91SWhPdWx0T3VwdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHRPeVd0T3VUbk91Z3BPeWFsQzRuT3dvdkx5RHNpNlRzdUtIdGxad2c2Nnk0NnJXczY1T2tPaUFpUm1GcGJHVmtJSFJ2SUdGMWRHaGxiblJwWTJGMFpUb2dUMEYxZEdnZ2MyVnpjMmx2YmlCbGVIQnBjbVZrSUdGdVpDQmpiM1ZzWkNCdWIzUWdZbVVnY21WbWNtVnphR1ZrSWlqcnA0enJvNHdwTEFvdkx5QWlUbTkwSUd4dloyZGxaQ0JwYmlEQ3R5QlFiR1ZoYzJVZ2NuVnVJQzlzYjJkcGJpSW82Nis0NjZHYzZyZTQ3SjI0S1NEaWdKUWc2NUdZSU91THBDRHNucUh0bm9qcXNvd2c2NFNUN1o2TTY0dWtDbVoxYm1OMGFXOXVJR2x6UVhWMGFFVnljbTl5S0hNcElIc0tJQ0J5WlhSMWNtNGdMMkYxZEdobGJuUnBZMkYwZkc5aGRYUm9mR0Z3YVNCclpYbDhiRzluSUQ5cGJueHNiMmRuWldSOGMyVnpjMmx2YmlCbGVIQnBjbVZrTDJrdWRHVnpkQ2hUZEhKcGJtY29jeWtwT3dwOUNpOHZJT3lDck95YXFTRHRsWnpyajRRZzdMU0k2ck84SU9xd2tPeW5nQ0RpZ0pRZzY2R2M2cmU0N0oyNDdKMkFJT3VwZ095cG9lMlZuT3VOc0NBaTY0MlVJT3VxdXlEc2s3VHJpNlFpNjRxVUlPcXl2ZXlhc0M0ZzY2R2M2cmU0N0oyNElPdW5qT3Vqak95WmdDRHNvYkRzdVpqcXNJQWc2NHVzNjUyODdJU2NJT3VVc091aG5DRHNucUhyaXBUcmk2UXVDaTh2SU95THBPeTRvU2d5TURJMkxUQTRMQ0R0bW96c2dxd2c3SmVVN1lTdzdaU0U2NTI4N0oyMDdLYUlJT3lpak95RW5TazZJQ0paYjNVbmRtVWdhR2wwSUhsdmRYSWdhVzVrYVhacFpIVmhiQ0J6Y0dWdVpDQnNhVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6c25wRHNsNURxc293ZzdaV2M2NCtFNjZXOElPeVlyT3VncENEcmk2enJuYnpxczZBZzdKcVU3TEt0N1pXWTZyT2dMQ0RzbFlUcmk0anJxYlFnVy9DZm42QWc3WUcwNjZHYzY1T2NJTzJWbk91UGhDRHN0SWpxczd4ZElPdXloTzJLdk95ZGhDRHJpSXpybjZ3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsYlFnN0tPODdJUzQ3SnFVTGljN0NpOHZJQ2Z0bFp6cmo0UW42NkdjSU91dGlldWFzZXEzdU91bXJPdXB0Q0RzbFlnZzY1Q2M2NHVrSU9LQWxDRHNucURxdVpBZzY2cXc2NmEwSU91VmpDRHJncGpyaXBRZ2NtRjBaU0JzYVcxcGRPeWR0T3VDbUNEcnJManJwNlVnNnJpNDdKMjBJT3kwaU9xenZPcTVqT3luZ0NEc25xSHNsWVFLTHk4ZzdKZUo2NXF4N1pXWTZyS01JQ0xyaTZUcnBiZ2c2ck9FN0tDVjdKeTg2NkdjSU91aG5PcTN1T3lkdU8yVm1PdWR2Q0xxczZBZzdKV0k2NEswN1pXWTZyS01JT3VRbk91THBDNGc3S2VBN0xhY3dyZnNncXpzbXFucm40a2c3SU9CN1pXY0lPdXN1T3Exck91bmpDRHNvb0h0bUlEc2hKd2c2N080NjR1a0NtWjFibU4wYVc5dUlHbHpUR2x0YVhSRmNuSnZjaWh6S1NCN0NpQWdjbVYwZFhKdUlDOXpjR1Z1WkNCc2FXMXBkSHgxYzJGblpTMWpjbVZrYVhSemZIVnpZV2RsSUd4cGJXbDBJQ2h5WldGamFHVmtmR1Y0WTJWbFpHVmtLUzlwTG5SbGMzUW9VM1J5YVc1bktITXBLVHNLZlFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56NjZXOElPeWR2ZXlXdEFvdkx5QXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZuT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbENEc3BKSHNuYmpzcDRBaUlPMlJuT3lMbkNEaWdKUWc2ck8xN0pxcElGQkQ3SmVRN0lTY0lPdUNxT3lkbUNEcXM0VHNvSlVnN0ppazdJS3M3SnFwSU91d3FleW5nQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMElPeWR0Q0Rxc0pMcXM3d2c3WXlNN0oyODdKMllJT3F6aE95Z2xleWR0Q0RzbHJUcXVJdnJncHpyaTZRS2JHVjBJSE5sYzNOcGIyNUJZMk52ZFc1MElEMGdiblZzYkRzS0x5OGc3SXVrN0tDY0lPdWhuT3EzdU95ZHVDRHNsNnpydG9EcmlwUWc3SjZRNnJLcDdLYWQ2NnFGSU8yTWpPeWR2T3VobkNEdGpKRHJpNmp0bFp6cmk2UWc0b0NVSUg0dkxtTnNZWFZrWlM1cWMyOXU3SjJZSUc5aGRYUm9RV05qYjNWdWRPdUtsQ0FxS3V1aG5PcTN1T3lWaE95YmcrMlZ0T3VQaENEcmdxanJpcFRyaTZRcUtnb3ZMeUFvN0l1azdMaWhPaUJqYkdGMVpHVWdZWFYwYUNCemRHRjBkWFByaXBRZ2JHOW5aMlZrU1c0NlptRnNjMlhzbmJqcmpiQWc2cmU0SU8yVmhPdVRuT3VLbENEcXQ3anJqSURyb1p3ZzRvYVNJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJvWnpxdDdqc25ianJrSndnNnJLRDdMS1k2NSs4SU8yUm5PeUxuTzJXaU91THBDa3VDaTh2SU8yTWpPeWR2T3VuakNEc25iM3NuTHpycjREcm9ad2c2N21FN0pxcElEQXVJR05zWVhWa1pTQmhkWFJvSUhOMFlYUjFjK3VsdkNEcnRvRHJwYlRycWJRZzdLQ1Y3Wm1WN1pXWTdLZUE2NmVNSU8yVWhPdWhuT3lFdU95S3BPdWx2Q0RybllUc200enNsYndnN1pXMDdJU2NJT3loc08yYWpPdW5pT3VMcENEc2s3RHF1TERzbDVRZzY2eTA2cktCNjR1a0xncG1kVzVqZEdsdmJpQm9ZWE5EYkdGMVpHVkRjbVZrWlc1MGFXRnNjeWdwSUhzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ1ppQTlJSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDY3VZMnhoZFdSbEp5d2dKeTVqY21Wa1pXNTBhV0ZzY3k1cWMyOXVKeWs3Q2lBZ0lDQmpiMjV6ZENCcUlEMGdTbE5QVGk1d1lYSnpaU2htY3k1eVpXRmtSbWxzWlZONWJtTW9aaXdnSjNWMFpqZ25LU2s3Q2lBZ0lDQnBaaUFvYWlBbUppQnFMbU5zWVhWa1pVRnBUMkYxZEdnZ0ppWWdhaTVqYkdGMVpHVkJhVTloZFhSb0xtRmpZMlZ6YzFSdmEyVnVLU0J5WlhSMWNtNGdkSEoxWlRzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHRqSXpzbmJ3ZzdKZUc3SjJNd3JmcnFyc2c3SjI5N0oyTUlPS0FsQ0RycDZYc25iVHJxYlFnN1lLazdMSzA3SjI0N0oyRUlPdW5pT3lnZ0NEcnM3anJpNlFnS2k4Z2ZRb2dJQzh2SUNvcTY2ZWw3SjJBSU95ZWtPcXlxZXltbmV1cWhleWRoQ0R0akl6c25ienNuYlFnN0pXRTY0dUk2NTI4SU8yQ3BPeXl0T3lkdU95WGtDRHJoS1ByaXBUcmk2UXFLaUFvTWpBeU5pMHdPQ0RzaTZUc3VLRXNJT3VMcE91bXJDQjJOREVnTHlEcXNKRHNpNXpzbnBBZ2RqWXBMZ29nSUM4dklPdW5wZXlkbUNCRGJHRjFaR1VnUTI5a1pldUtsQ0IrTHk1amJHRjFaR1V2TG1OeVpXUmxiblJwWVd4ekxtcHpiMjdzbllRZzdKV0U3SmlJSU91bmpPdVRwT3luZ0NEc2xZcnFzNkFnN1lLazdMSzA3SjI0SU8yVnJldXFxUW9nSUM4dklDZERiR0YxWkdVZ1EyOWtaUzFqY21Wa1pXNTBhV0ZzY3lmc2w1QWc3S0NBN0o2bDdaV2M2NHVrSU9LR2tpRHRqSXpzbmJ6cnA0d2c2N08wNjZtMElPdXBnT3lwb2UyZWlDRHJvWnpxdDdqc25ianJrSndnNjZlbDdKMjBJT3VLbUNBbjY2R2M2cmU0N0oyNElPeVZpQ0Rya0tnbjdKMjBJT3VRbU9xem9Dd0tJQ0F2THlEcm9aenF0N2pzbmJnZzY0eUE2cml3SU8yWmxPdXB0T3lkdENEc21JSHNtSUVnNjQrSTY0dWtLT3VJak91ZnJPdVBoQ0JEVEVucXNJQWdJdXlkdE91dnVDRHJvWnpxdDdqc25ianJrS2dpN0p5ODY2R2NJT3ltaWV5TG5DRHJnWjNyZ3BnZzY3aU02NTI4N0pxdzdLQ0E3S0d3N0xDb0lPeVZpQ0RzbDdUcnByRHJpNlFwTGdvZ0lDOHZJQ29xN0tHMDdKNnM2NmVNSU8yWmxleWR1TzJWbk91THBDZ3RkeURzbDRic25Zd3BLaW9nNG9DVUlPdTVoT3V3Z091eWlPMll1Q0Rxc0pMc25ZUWc3SjI5N0p5ODY2bTBJTzJDcE95eXRPeWR1Q0Rzb0pIcXQ3d2c3WmVJN0pxcElPMk1uZXlYaGV5ZHRDRHJuTEFnN0lpWUlPeWVpT3VMcEM0ZzdKVzlJRE13YlhNdUNpQWdMeThnUTBKZlRrOWZTMFZaUTBoQlNVNDlNZXlkdE91cHRDRHRqSXpzbmJ6cnA0d2c2N080NjR1a0lDanJxcWpzblpnZzdabUk3Snk4NjZHY0lDZnJvWnpxdDdqc25iZ2c3SmVHN0oyTUoreWRoQ0RzbnF6dG1JVHRsWmpyaXBRZzdZV003SXFrN1lxNDdKcXBJT0tBbENEdGdxVHNzclRzbmJqc25ZQWdTRTlOUmV5ZGhDRHNsWWdnNjVTdzY2VzQ2NHVrS1M0S0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0FoUFQwZ0oyUmhjbmRwYmljZ2ZId2djSEp2WTJWemN5NWxibll1UTBKZlRrOWZTMFZaUTBoQlNVNGdQVDA5SUNjeEp5a2djbVYwZFhKdUlHWmhiSE5sT3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCeUlEMGdjM0JoZDI1VGVXNWpLQ2R6WldOMWNtbDBlU2NzSUZzblptbHVaQzFuWlc1bGNtbGpMWEJoYzNOM2IzSmtKeXdnSnkxekp5d2dKME5zWVhWa1pTQkRiMlJsTFdOeVpXUmxiblJwWVd4ekoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0IwYVcxbGIzVjBPaUF6TURBd0lIMHBPd29nSUNBZ2NtVjBkWEp1SUhJdWMzUmhkSFZ6SUQwOVBTQXdPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJSEpsZEhWeWJpQm1ZV3h6WlRzZ2ZTQXZMeUJ6WldOMWNtbDBlZXVsdkNEcnFyc2c2N2FBNjZhRUlEMGc2NkdjNnJlNDdKMjRJT3lWaUNEcmtLanNuTHpyb1p3ZzY3TzQ2NHVrQ24wS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzS0lDQnBaaUFvUkdGMFpTNXViM2NvS1NBdElHRmpZMjkxYm5SRFlXTm9aUzVoZENBOElETXdNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3dvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0NpQWdkSEo1SUhzS0lDQWdJR2xtSUNob1lYTkRiR0YxWkdWRGNtVmtaVzUwYVdGc2N5Z3BLU0I3SUM4dklPeWVrT3F5cWV5bW5ldXFoZXlkdENEc2w0YnNuTHpycWJRZzY0S283SjJBSU95ZHRPdXBsT3lkdk95ZGdDRHJyTFRzaTV6dGxaenJpNlFLSUNBZ0lDQWdZMjl1YzNRZ2FpQTlJRXBUVDA0dWNHRnljMlVvWm5NdWNtVmhaRVpwYkdWVGVXNWpLSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDY3VZMnhoZFdSbExtcHpiMjRuS1N3Z0ozVjBaamduS1NrN0NpQWdJQ0FnSUdWdFlXbHNJRDBnS0dvZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RZ0ppWWdhaTV2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpLU0I4ZkNCdWRXeHNPd29nSUNBZ2ZRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3Vobk9xM3VPeWR1Q0RzbmJUcm9LVWc3SmVHN0oyTUlPdVRzU0RpZ0pRZ2JuVnNiQ0RzbktEc3A0QWdLaThnZlFvZ0lHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJRVJoZEdVdWJtOTNLQ2tzSUdWdFlXbHNJSDA3Q2lBZ2NtVjBkWEp1SUdWdFlXbHNPd3A5Q21aMWJtTjBhVzl1SUdOb1pXTnJRMnhoZFdSbFFYWmhhV3hoWW14bEtDa2dld29nSUdOdmJuTjBJSEJ5YjJKbElEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25MUzEyWlhKemFXOXVKMTBzSUhzZ2MyaGxiR3c2SUhSeWRXVXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1ZpQjlLVHNLSUNCc1pYUWdiM1YwSUQwZ0p5YzdDaUFnY0hKdlltVXVjM1JrYjNWMExtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc2diM1YwSUNzOUlHUXVkRzlUZEhKcGJtY29LVHNnZlNrN0NpQWdjSEp2WW1VdWIyNG9KMlZ5Y205eUp5d2dLQ2tnUFQ0Z2V5QmpiR0YxWkdWVGRHRjBkWE1nUFNBblkyeGhkV1JsTFcxcGMzTnBibWNuT3lCOUtUc0tJQ0J3Y205aVpTNXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXdvZ0lDQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ0tHTnZaR1VnUFQwOUlEQWdKaVlnTDF4a0sxd3VYR1FyTHk1MFpYTjBLRzkxZENrcElEOGdKMjlySnlBNklDZGpiR0YxWkdVdGJXbHpjMmx1WnljN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZ1EyeGhkV1JsSUVOdlpHVWc3S0NRNnJLQU9pQW5JQ3NnWTJ4aGRXUmxVM1JoZEhWeklDc2dLRzkxZENBL0lDY2dLQ2NnS3lCdmRYUXVkSEpwYlNncElDc2dKeWtuSURvZ0p5Y3BLVHNLSUNCOUtUc0tmUW92THlEc3NwanJwcXdnN1ppRTdabXBJT0tBbENBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVnRDQWk3S0NWNjZlUUlPMkJ0T3Vobk91VG5PcXdnQ0RyaTdYdGxvanJpcFRzcDRBaUlPdXdsdXlYa095RW5DRHRtWlhzbmJqdGxhQWc3SWlZSU95ZWlPcXlqQ0R0bFp6cmk2UUtZMjl1YzNRZ2MzUmhkSE1nUFNCN0lITmxjblpsWkRvZ01Dd2diR0Z6ZEVGME9pQW5KeXdnYkdGemRGUmxlSFE2SUNjbkxDQnNZWE4wVTJWak9pQW5KeUI5T3dvS0x5OGc0cFNBNHBTQUlPMlVqT3Vmck9xM3VPeWR1Q0RzZzUzc29iUWc2ckNRN0tlQUtPeUxyT3llcGV1d2xldVBtU2tnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RybHFBZzdKNkk2NHFVSU91UG1leVZpQ0JqYjJSbExuUno2ckNBSURYc3RJanJwNGpyaTZRZ1VFOVRWQ0F2YUdWaGNuUmlaV0YwNjZXOElPdXp0T3VDdU91THBDNEtMeThnN1pXY0lPdXlpT3lkdE91ZHZPdVBoQ0Ryc0p2c25ZQWc2NUtrSURNdzdMU0k2ckNFSU91Qml1cTRzT3VwdENEdGxJenJuNnpxdDdqc25iZ282NWlRNjRxVUlPMlV2T3EzdU91bmlDbnNuYlFnNjR1cjdaNk1JT3F5Z3lEaWdKUWc3WUcwNjZHYzY1T2M2cm1NN0tlQUlPdU5zT3Vtck9xem9DRHFzSm5zbmJRZzZycTg3S2VFNjR1a0xnb3ZMeURzbFlUc3A0RWc3WldjSU91eWlPdVBoQ0RycXJzZzY3Q2I3SldZN0p5ODY2bTBLT3VMcE91bXJPdW5qQ0RycUx6c29JQWc3THlnSU95RGdlMkRuQ3dnN0o2UTY0K1o3SXVjN0o2UklPdVRzU2tnNnJPRTdJYU5JT3VNZ09xNHNPMlZuT3VMcEM0S1kyOXVjM1FnU0VWQlVsUkNSVUZVWDBSRlFVUmZUVk1nUFNBek1EQXdNRHNLYkdWMElHeGhjM1JDWldGMElEMGdNRHNLYzJWMFNXNTBaWEoyWVd3b0tDa2dQVDRnZXdvZ0lHbG1JQ2hzWVhOMFFtVmhkQ0FtSmlCRVlYUmxMbTV2ZHlncElDMGdiR0Z6ZEVKbFlYUWdQaUJJUlVGU1ZFSkZRVlJmUkVWQlJGOU5VeWtnZXdvZ0lDQWdMeThnS2lycm9aenF0N2pzbmJnZzdLU1I3SjIwNjZtMElPeVZpQ0RxdXJ6c3A0VHJpNlFxS2lBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU16Y3BPaUJsZUdsMElPMlZ1T3VUcE91ZnJPcXdnQ0JyYVd4c1RHOW5hVzVRY205ajZybU03S2VBSU91MmdPdWx0T3V2Z091aG5Bb2dJQ0FnTHk4ZzdKZXM2cml3N0lTY0lPcTZ2T3luZ091cHRDRHJ1SXpybmJ6c21yRHNvSURzbDVEc2hKd2c2NkdjNnJlNDdKMjQ3WldZNjQyWUlPeUNyT3Vlak95ZG1DRHN2Wnpyc0xFZzdZK3M3WXE0NnJDQUlPdUxxKzJZZ0NBaWJHOWpZV3hvYjNOMDdKZVE3SVNjSU95WHNPcXlzT3lkaENEcXNiRHJ0b0R0bG9qc2lyWHJpNGpyaTZRaTZyQ0FDaUFnSUNBdkx5RHJuS2pxc2JEcmdwZ3NJT3Vobk9xM3VPeWR1Q0Rzc0wzc25iUWc3SWFNNjZhc0lPeVhodXlkdENEcnJMVHRtcWpxc0lBZzY1Q2M2NHVrS095THBPeTRvU0RpZ0pRZzdaU002NStzNnJlNDdKMjQ3SjJFSU91THEreVZoQ0Rya1pRZzdMR0VJT3Vobk9xM3VPeWR1TzJWbU91cHRDRHJwNlRyc29nZzdKMjA2NTZzNjR1a0tTNEtJQ0FnSUM4dklPdWhuT3EzdU95ZHVPeWRnQ0RydUl6cm5ienNtckRzb0lEc2w1RHNoSndnN0lLczY1Nk03SjIwSU95bmhPMldpZTJWbU91S2xDRHNuYnpzbmJUcm5id2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPdVdvQ0Rzbm9qc25ZUWc3WldFN0pxVTZyQ0FJT3lYaHV1THBDNGc2NnkwN1pXY0lPdU1nT3E0c0NEc25JVHRsNWpzbllBS0lDQWdJQzh2SUd4dloybHVVSEp2WTFScGJXVnlLRE13NjdhRUtlcXdnQ0RycDRucmlwVHJpNlFnNG9DVUlPcTN1Q0R0ZzREc25iVHJxTGpxc0lBZzY2R2M2cmU0N0oyNDdKMkVJT3lnbGV1bXJPMlZtT3VwdENEcmk2VHNuWXdnN0tDUTZyS0E3SmVRN0lTY0lPeWdsZXlEZ2V5Z2dleWN2T3VobkNEcXVyenNwNFRyaTZRdUNpQWdJQ0JwWmlBb2JHOW5hVzVRY205aktTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaTZ6c25xWHJzSlhyajVuc25ZQWc2NEdLNnJLODdLZUE2NmVNSU91aG5PcTN1T3lkdU95ZHRDRHNwNFR0bG9rZzdLU1I3SjIwNjUyOElPcTRzT3VMcE91bXZldUxpT3VMcENBbzY2R2M2cmU0N0oyNElPdUJuZXVDbU91cHRDRHNvSlhycHF6cmtLbnJpNGpyaTZRcExpY3BPd29nSUNBZ0lDQnlaWFIxY200N0NpQWdJQ0I5Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1pTTTY1K3M2cmU0N0oyNElPeUxyT3llcGV1d2xldVBtU0RyZ1lycXVZQWc0b0NVSU8yVXZPcTN1T3VuaUMvdGxJenJuNnpxdDdqc25ianNuYlFnNjR1cjdaNk1JT3F5Zyt5Y3ZPdWhuQ0RyczdUcXM2QWc2ckNaN0oyMElPcTZ2T3lua2V1TGlPdUxwQzRuS1RzS0lDQWdJSEJ5YjJObGMzTXVaWGhwZENnd0tUc2dMeThnWlhocGRDRHRsYmpyazZUcm42enFzSUFnYTJsc2JGQnliMlBzbkx6cm9ad2dZMnhoZFdSbElPMkt1T3Vtck91bHZDRHNvSlhycHF6dGxaenJpNlFLSUNCOUNuMHNJRFV3TURBcE93b0tMeThnN0p1NUlPdWhuT3EzdU95VmhPeWJnK3lkaENEcnVJenJuYnpzbXJEc29JRHJvWndnN0plczY0cVVJT3k5bE91VG5PdUtsQ0Rzb0p6cXNiRHRsb2pyaTZRZ0tESXdNall0TURnc0lFSlNTVVJIUlY5V1BUUXdLU0RpZ0pRZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95ZHRDRHJrWkFnNnJDY0lPdVdvT3lFbkFvdkx5RHNsclRyaXBBZzdLcTk3SmVRSU91aG5PcTN1T3lkdU8yVnRPeVZ2Q0R0bFpqcmlwVHNwNEFnN0pXTUlPeUltQ0RzbDRic2w0anJpNlFvN0l1azdMaWhJT3lMb09xem9Da3VJT3lLdWV5ZHVDRHRtWlRycWJUc25ZUWc2ckcwNjRTSTY1dXc2NkNrNjZtMElPeUNyT3lhcWV5ZWtPcXdnQ0RydUl6cm5ienNtckRzb0lEc2w1RHNoSndLTHk4ZzdLZUI3S0NSSUdOc1lYVmtaU0Ryb1p6cXQ3anNsWVRzbTRQc25ZUWc3WldZNnJHdzY0S1lMQ0RzaXJuc25iZ2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjNzbllRZzdKT3c2Nm0wSU91UW5PdUxwQzRnS2lydGc2M3NuWUFnN1pXdDdJT0JJREhxc0p6cm9ad2c3SnlnN0tlQTdaV2dJT3F5Z3k0cUtnb0tMeThnNHBxZzc3aVBJT3Vobk9xM3VPeWR1Q0Rxc3Izcm9aenNsNURzaEp3Z0tpcENVazlYVTBWUzY2VzhJT3F4dE91VG5PdW1yT3VwdENEc2xZZ2c2NUNjNjR1a0tpb2dLREl3TWpZdE1EZ2c3SXVrN0xpaElETHRtb3pyb1p3ZzdabVY3S0NWS1RvS0x5OGdJQ0JDVWs5WFUwVlM2Nlc4SU95RXBPeWdsZTJWbU91cHRDanJnclRzbXFuc25iUWc2NnkwN0plSDdKMjA2NU9nTENEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU8yVm1PdUtsQ0J1YnkxdmNPeWR0T3lXdE91UGhDa2dZMnhoZFdSbElFTk1TZXF3Z0NEcnVJenJuYnpzbXJEc29JQWc3Wlc0NjVPYzdKaWs3WlNFNjZXOENpOHZJQ0FnN1krczZyaXc3WldZNnJPZ0lDb3FJdXlkdU95bW5TRHN2WlRyazV6cnBid2dRMnhoZFdSbElFTnZaR1hzbDVBZzY3YVo3SmVzNjRTajdKeTg3SVM0N0pxVUlpRHJzS25zaTUzc25MenJvWndnNjdDVTY0Q1E2NHVrS2lvdUlPdUxwT3Vtck91S2xDRHJvWnpxdDdqc25iZ2c3WlNFNjZHYzdJUzQ3SXFrNjZXOENpOHZJQ0FnN0lpbzZyS283SVNjSUhOMFpHbHVJT3lYaHV5ZHRDRHJuWVRzbXJEcnI0RHJvWndnNjdhWjdKZXM2NFNqN0oyRUlPcXpzK3lkdENEc2w0YnNsclFnNjZHYzZyZTQ3SjI0N0oyMElPeVZoT3lZaUNEcnRvanFzSURyaXFYdGxiVHNwNFRyaTZRdUNpOHZJQ0FnS0d4dlkyRnNhRzl6ZENCTVNWTlVSVTdzbmJRZzY1YWdJT3llaU91S2xDRHFzb1BycDR3ZzY3TzA2ck9nSU95ZWtPdVBtU0RzaUpqcm9MbnNuYlFnN0p5ZzdLZUE2NUNjNjR1azZyT2dJTzJNa091THFPMldpT3VObUNEcXNvd2c3SmlrN0tlRTdKMjA3SmVJNjR1a0xpa0tMeThnSUNEaWhwSWc2cmU0NjU2WTdJU2NJQ0x0ZzYwZ01lcXduQ0FySU9xemhPeWdsU0RzaEtEdGc1MGc3Wm1VNjZtMEl1eWRnQ0RzbmJRZ1EweEo2NkdjSU91MmlPcXdnT3VLcGUyVm1PdUxwRG9nN1pXY0lPMkRyZXljdk91aG5DRHNub2ZzbnBEcnFiUWdRMHhKN0oyWUlPeVh0T3E0c091bHZDRHJwNG5zbFlUc2xid0tMeThnSUNEdGxaanFzNkFzSU91bmlleWN2T3VwdENEc3ZaVHJrNXdnNjdhWjdKZXM2NFNqNnJpdzZyQ0FJT3VRbk91THBDNGc2NkdjNnJlNDdKV0U3SnVEN0oyRUlPdVVzT3VobkNEc2w3VHJxYlFnN1lPdDdKMjBJRExxc0p6cXNJQWc2NUNjNjR1a0xnb3ZMeUFnSU9xeXNPdWhvQ2pzZ3F6c21xbnNucEFnNnJLdzdLQ1ZLVG9nS2lydGc2MGdNZXF3bkNBcklPeUt1ZXlkdUNEdG1aVHJxYlFxS3V5ZGhDRHNrN0RxczZBc0lPcXpoT3lnbFNEc29JVHRtWmpzbllBZzZyZTRJTzJabE91cHRPeWRtQ0JiNnJPRTdLQ1ZJT3lnaE8yWm1GMGc2N0tFN1lxODdKeTg2NkdjSU8yVm5PdUxwQzRLTHk4Z0lDRHNncTNzb0p6cmtKd2c3SXVjNjQrRTY1T2tPaUIzY21sMFpVNXZiM0JDY205M2MyVnlJQzhnYjNCbGJsVnliRWx1UkdWbVlYVnNkRUp5YjNkelpYSWdMeUJpZFdsc1pFeHZaMjkxZEVOb1lXbHVWWEpzSUNqcnM3WHF0YXpyaXBRZ1oybDBJTzJlaU95S3BPMkdvT3VtckNrdUNpOHZJT0tVZ09LVWdDRHJvWnpxdDdqc25ianNuWUFnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdLZUI3S0NSSU95WHRPcXlqQ0R0bFp6cmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVE13S1NEaWxJRGlsSUFLTHk4ZzdKcXc2NmFzNnJDQUlFSlNUMWRUUlZMcnBid2c2ckNBNjZHYzdMR0U2ckd3NjRLWUlPeXd2ZXlkaENEcXM2anJuYndnN0plczY0cVVJT3lMbk91UGhPdUtsQ0FxS3V5Z2hPdTJnQ0RzaTZUdGpLanRsYlRzaEp3ZzY1Q1k2NCtNNjZDNDY0dWtLaW91SU91Q3FPcTR0Q0RxdFpEdG00ZzZDaTh2SUNBZzRwR2dJRUpTVDFkVFJWSWc3Wlc0NjVPazY1K3M2NkdjSUZWU1RPeWRoQ0Ryc0p2c25MenJxYlFnWTIxazZyQ0FJR0FtWU95WGtPeUVuQ0RzbnBqcm5ienJxTG5yaXBUcmk2UWc0b2FTSUdOc2FXVnVkRjlwWkNEc2hvenNpNlFvSXV5ZW1PdXF1K3VRbkNCUFFYVjBhQ0RzbXBUc3NxMGlLUzRLTHk4Z0lDRGlrYUVnUWxKUFYxTkZVdXVsdkNCdWJ5MXZjT3ljdk91aG5DRHJwNG5xczZBZ2MzUmtiM1YwN0oyWUlGVlNUT3lkaENEc21yRHJwcXpxc0lBZzdKZTA2Nm0wSUNvcTdJcTU3SjI0SU91U3BDRHNuYmpzcHAzc3ZaVHJrNXpycGJ3ZzY3YVo3SmVzNjRTajdKeTg2NTI4NjRxVUlPMlpsT3VwdENvcTdKMjBDaTh2SUNBZ0lDQWc2NXlzNjR1a0tPeUxwT3k0b1NEc2k2RHFzNkE2SUNMc25iVHJuN0FnNnJHd0lPeVhodXlYaU91S2xPdU5zQ0Rxc0pIc25wRHF1TEFnN0ptY0lPeURuZXF5cUNJcElPS0FsQ0RzbnBEcmo1a2c3SWlZNjZDNTdKMjBJT3E1cU95bmhPdUxwQzRLTHk4Z0lDRGlrYUlnN0l1YzdZR3M2NmEvSU95d3ZleWN2T3VobkNEc2w3VHJvS1RycWJRZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95YXNPdW1yT3F3Z0NEcXM2anJuYnpzbGJ3ZzdaVzA3SVNjSUNvcTZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPcXdnQ0RzbFlUcmk0d2c3WUdzNjZHc3dyZnNsNlBzcDREcXNJQWc3SmUwNjZhdzY0dWtLaW9LTHk4Z0lDQWdJQ0FvN0l1azdMaWhJT3lMb09xem9Eb2dJdXlabkNEdGdhenJvYXpzbkx6cm9ad2c3SmUwNjZDa0lpd2dJdXE0c091enVDRHJ1SXpybmJ6c21yRHNvSURyb1p3ZzdaV1k2NTI4NjR1STZybU1JaWt1SU9xeWpPdUxwT3F3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJT3lMbk8yQnJPdW12d292THlBZ0lDQWdJT3lkdU95ZWtPdWx2Q0RyckxUc2k1enRsWmpycWJRbzdJSzg3SVN4SU95ZHVPMkVzT3VFdHlEc2k2VHN1S0VwSU95ZHZPdXdtQ0Rzc0wzc25iUWc2NWFnSU95S3VleWR1Q0R0bVpUcnFiVHNuYlFnNnJlNDY0eUE2NkdjNjR1a0xnb3ZMeURxdDdqcm5wanNoSndnS2lwQ1VrOVhVMFZTNjZXOElPcXh0T3VUbk91bXJPeW5nQ0RzbFlycmlwVHJpNlFxS2lEaWdKUWdZMnhoZFdSbElFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lYdE9xem9DQnNiMk5oYkdodmMzVHJvWndnNnJLdzZyTzg2Nlc4SU95ZWtPdVBtUW92THlEc2lKanJvTG50bFp6cmk2UW83TDJVNjVPY0lPdTJtZXlYck91RW8rcTRzQ0RzbDRic25Zd3BMaURxczRUc29KVWc3S0NFN1ptWTdKMkFJT3lLdWV5ZHVDRHRtWlRycWJRZzdaV1k2NHVvSUZ2cXM0VHNvSlVnN0tDRTdabVlYU0Ryc29UdGlyenNuTHpyb1p3ZzdaV2M2NHVrTGdvdkx5QXFLdXlkdENEcXNyM3JvWnpzbDVBZ1ZWSk1JT3F3Z09xenRjSzM3S1NSNnJDRUlPeUtwTzJCck91bXZlMkt1TUszNjdpTTY1Mjg3SnF3N0tDQUlPeW5nT3lnbGV5ZGhDRHJpNlRzaTV3ZzY0U2o3S2VBSU91bmtDRHFzb011S2lvS0NpOHZJT0tVZ09LVWdDQkNVazlYVTBWU0lPcXdnT3Vobk95eGhPcTRzT3VLbENEc29KenFzYkRya0pEcmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVEkxS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdKaUk3S0NFN0plVUlFSlNUMWRUUlZJZzdabVk2cks5NjdPQTdJaVk3SmVRSU95ZWhPeUxuQ0RzaXFUdGdhenJwcjN0aXJqcnBid2c2cjJDN0pXRUlFTk1TZXF3Z0NEc3BJQWdZWFYwYUc5eWFYcGxJRlZTVE95ZGhDRHNtckRycHF6cXNJQWc2N0NiN0pXRTdJU2NJT3lYdE95WGlPdUxwQzRLTHk4ZzY2cXA3S0NCN0oyQUlPMlZtT3VDbU91L2tPeWR0T3lYaU91THBDRGlnSlFnNnJPRTdLQ1ZJT3lnaE8yWm1PeWFxZXljdk91aG5DQlZVa3pzbllRZ1kyeGhkV1JsTG1GcEwyeHZaMjkxZEQ5eVpYUjFjbTVVYnozaWdLYnJvWndnN0o2czdKNlI3SVN4N1pXMENpOHZJT3lLdWV5ZHVDRHRtWlRycWJUc25ZUWc2ckcwNjRTSTY1dXc2ck9nSU9xemhPeWdsU0RzaEtEdGc1MGc3Wm1VNjZtMDdKZVFJT3luZ2UyV2lleUxuTzJDcE9xNHNDNGc2cmU0SU95ZXJPeWVrZXlFc2V5ZGhDRHRqNURxdUxEdGxaanNucEFvN0lLczdKcXA3SjZRSU9xeXNPeWdsU2tnN1pXNDY1T2s2NStzNjRxVUNpOHZJT3VxcWV5Z2dleWR0Q0RzbDRic2xyVHNvWXpxczZBc0lDb3E2NEtvNnJLb0lPdVJrT3VwdENEc21LVHRub2pyb0tRZzY2R2M2cmU0N0oyNDdKMkVJT3VubmVxd2dPdWNxT3Vtc091THBDb3FPZ292THlBZ0lFTk1TZXF3Z0NCVlVrenNuWVFnNjVTdzdKaTA3WkdjSU95WGh1eWR0Q0RyaEpqcXVMRHJxYlFnWTIxazZyQ0FJR0FtWU95WGtPeUVuQ0JWVWt6c25ZUWc3SjZZNjUyOElPdXloT3VncENqc25JanJqNFRzbXJBcElHTnNhV1Z1ZEY5cFpDRHFzSm5zbllBZzY1S2s3S3E5Q2k4dklDQWc2NmVrNnJDYzY3T0E3SWlZNnJDQUlPeUNyT3Vkdk95bmdPcXpvQ3dnNjdpTTY1Mjg3SnF3N0tDQTdKZVVJQ0xzbnBqcnFydnJrSndnVDBGMWRHZ2c3SnFVN0xLdElNSzNJR05zYVdWdWRGOXBaQ0RycDZUcXNKenJzNERzaUpqcXNJQWc2NGlFNjUyOTY1Q1k3SmVJN0lxMTY0dUk2NHVrSXVxd2dDRHJuS3pyaTZRdUNpOHZJQ0FnN0l1czdaV1k2Nm0wSU91NGpPdWR2T3lhc095Z2dPcXdnQ0RzbFlUc21JZ2c3SldJSU95WHRPdW1zT3VMcENqc2k2VHN1S0VnTWpBeU5pMHdPRG9nUTB4SklPMlVoT3Vobk95RXVPeUtwT3VLbENEcmpJRHF1TEFnN0tTUjdKMjQ2NDJ3SU95d3ZleWR0Q0RzbFlnZzY1eTRLUzRLTHk4ZzdKMjA3S0NjSUVKU1QxZFRSVkxycGJ3ZzZyRzA2NU9jNjZhczdLZUFJT3lWaXV1S2xPdUxwQ0RpaHBJZ1kyeGhkV1JsSUVOTVNlcXdnQ0RxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNjZXOElPeW5nZXlna1NEc2w3RHJpNlFvUTB4SklPcTRzT3V6dUNEcmo1bnNucEVwTGdvdkx5QXFLdXlkdENEcXNyM3JvWnpzbDVBZ1ZWSk1JT3F3Z09xenRjSzM3S1NSNnJDRUlPeUtwTzJCck91bXZlMkt1T3VsdkNEcmk2VHNpNXdnNjRTajdLZUFJT3Vua0NEcXNvTXVLaW9nNnJPRTdLQ1ZJT3lnaE8yWm1PeWRnQ0RzaXJuc25iZ2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjBnNjdLRTdZcTg3Snk4NjZHY0xnb0tMeThnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHRsSVRyb1p6c2hManNpcVFnS0dOc1lYVmtaU0JoZFhSb0lHeHZaMmx1SUMwdFkyeGhkV1JsWVdrcElPS0FsQ0F2YjNCbGJpMXNiMmRwYnV5ZHRDRHNnNTNzaExIQ3QrcTBnT3VtckM0S0x5OGc2N2lNNjUyODdKcXc3S0NBNnJDQUlHeHZZMkZzYUc5emRPdWhuQ0Rxc3JEcXM3enJwYndnNjdPMDY0SzA3S1NFSU91VmpPcTVqT3luZ0NEc2lLanNsclRzaEp3ZzY0eUE2cml3N1pXWTY0dWs2ckNBTENEc21ZVHJvNHpya0pqcnFiUWc3SXFrN0lxazY2R2NJT3VCbmV1Q25PdUxwQzRLYkdWMElHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0NteGxkQ0JzYjJkcGJsQnliMk5VYVcxbGNpQTlJRzUxYkd3N0NteGxkQ0JzYjJkcGJsTjBZWEowWldSQmRDQTlJREE3SUM4dklPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN0l1YzdKNlJJT3lMbk9xd2dTRGlnSlFnN0o2czdZRzA2NmF0N0oyMElDZnNucXpzaTV6cmo0UW43SjI0N0tlQUlDZnNucERyajVuc21ZVHJvNHdnN0l1azdZeW9KK3lkdU95bmdDRHF0YXpydG9UdGxaenJpNlFLTHk4ZzdKMjA2N0tJSU91aG5PcTN1T3lkdU95WGtPeUVuQ0RydUl6cm5ienNtckRzb0lBZzdMQzk3SjJFSU95THBPeWduT3VobkNEcm5ZVHNtNkRyaXBUcXNJQWc0b0NVSU8yRXNPdXZ1T3VFa0NEdGo3VHJzTEhzbllBZzdKMjA2cktNSUdaaGJITmw3SjI4SU91VmpPdW5qQ0RzazdUcmk2UUtMeThnS095TG5PcXdoT3Vuak95Y3ZPdWhuQ0R0akpEcmk2anRsWmpycWJRZzdLQ1Y3SU9CSU95ZXJPMkJ0T3VtcmV5WGtPdVBoQ0JqYldRZzdMQzk3SjIwSU8yS2dPeVd0T3VDbU95WXFPdUxwQ2tLYkdWMElHeHZaMmx1VjJsdVpHOTNUM0JsYm1Wa0lEMGdabUZzYzJVN0NtWjFibU4wYVc5dUlHdHBiR3hNYjJkcGJsQnliMk1vS1NCN0NpQWdhV1lnS0d4dloybHVVSEp2WTFScGJXVnlLU0I3SUdOc1pXRnlWR2x0Wlc5MWRDaHNiMmRwYmxCeWIyTlVhVzFsY2lrN0lHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2JuVnNiRHNnZlFvZ0lHbG1JQ2doYkc5bmFXNVFjbTlqS1NCeVpYUjFjbTQ3Q2lBZ1kyOXVjM1FnY0NBOUlHeHZaMmx1VUhKdll6c0tJQ0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPd29nSUhSeWVTQjdDaUFnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdJQ0J6Y0dGM2JsTjVibU1vSjNSaGMydHJhV3hzSnl3Z1d5Y3ZVRWxFSnl3Z1UzUnlhVzVuS0hBdWNHbGtLU3dnSnk5VUp5d2dKeTlHSjEwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPd29nSUNBZ2ZTQmxiSE5sSUhzS0lDQWdJQ0FnZEhKNUlIc2djSEp2WTJWemN5NXJhV3hzS0Mxd0xuQnBaQ3dnSjFOSlIxUkZVazBuS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3SUhBdWEybHNiQ2dwT3lCOUNpQWdJQ0I5Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIMEtmUW9LTHk4ZzdZUzBJT3VQaE95a2tTRHRnYlRyb1p6cms1d2c3WlNFNjZHYzdJUzQ3SXFrNnJDQUlPeWp2ZXlYaU95ZGhDRHJsWXpzblpnZzdJdWs3WXlvSU91cGxPeUxuT3luZ0NEaWdKUWdjblZ1VkhWeWJ1eWR0Q0RzbmJRZzY2bVU3SXVjN0tlQTdKMjhJT3VWak91bmpDQXg3WnFNSU95ZWtPdVBtU0RzbnF6c2k1enJqNFR0bFp6cmk2UUtZMjl1YzNRZ1UwVlRVMGxQVGw5RVNVVkVJRDBnSisyQnRPdWhuT3VUbkNEc2hManNoWmpzbmJRZzdLS0Y2Nk9NNjVDUTdKYTA3SnFVTGljN0NteGxkQ0J6YUhWMGRHbHVaMFJ2ZDI0Z1BTQm1ZV3h6WlRzZ0x5OGdMM05vZFhSa2IzZHVJT3luaE8yV2lTRHNwSkVnNG9DVUlPeWVyT3lMbk91UGhPdWhuQ0RzaExqc2haanNuWVFnNjVDWTdJSzA2NmFzN0tlQUlPeVZpdXF5akNEdGtaenNpNXdLQ2k4dklISmxZWE52YnV5ZGhDRHNvN3pycWJRZ0oreWRtT3VQaE95Z2dTRHNvb1hybzR3bktPcXpoT3lnbFNEc29JVHRtWmpDdCt1aG5PcTN1T3lWaE95Ymd5RHJrN0VwSU9LQWxDRHNwNFR0bG9rZzdLU1I3SjIwNjQyWUlPMkV0T3lkaENEcXQ3Z2c2Nm1VN0l1YzdLZUE2NkdjSU91Qm5ldUN0T3lFbkFvdkx5QnlkVzVVZFhKdTdKMllJRk5GVTFOSlQwNWZSRWxGUkNEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURzbnBEcXNxbnNwcDNycW9Yc25MenJvWndnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtck95bmdDRHNsWXJxc293ZzdaV2M2NHVrTGdvdkx5QW83SldJSU9xM3VPdWZyT3VwdENEcXM0VHNvSlVnN0tDRTdabVlJT3luZ2UyYmhDRHNtSnNnNnJPRTdLQ1ZJT3lFdU95Rm1PeWR0Q0RydG9EdG1aenRsYlFnVFVGWVgxUlZVazVUNnJtTTdLZUFJT3F6aE95R2pTRHNrN0RzbmJUcmlwUWc2N0tFNnJlNElPS0FsQ0F5TURJMkxUQTNJT3Vtck91M3NPeVhrT3lFbkNEdG1aWHNuYmdwQ21aMWJtTjBhVzl1SUd0cGJHeFFjbTlqS0hKbFlYTnZiaWtnZXdvZ0lHbG1JQ2h3Y205aktTQjdDaUFnSUNCMGNua2dld29nSUNBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSE5vWld4c09uUnlkV1hyb1p3ZzY1MkU3SnVNN0lTY0lIQnliMlBzbllBZ1kyMWtJT3E3amV1TnNPcTRzQ0RpZ0pRZ0wxVHJvWndnN1lxNDY2YXM3S2U0SU95anZleVhyT3lWdkNEc3A0VHNwNXdnWTJ4aGRXUmw2ckNBSU9xem9PeVZoT3VobkNEc2xZZ2c2NEtvNjRxVTY0dWtDaUFnSUNBZ0lDQWdMeThnS09xem9PeVZoQ0JqYkdGMVpHWHFzSUFnN0lTazdMbVlJTzJNak95ZHZPeWRoQ0Ryckx6cXM2QWc3SjZJN0p5ODY2bTBJTzJCdE91aG5PdVRuQ0RzbGJFZzdKZUY2NDJ3N0oyMDdZcTQ2ckNBSUNMc2dxenNtcWtnN0tTUkl1eWN2T3VobkNEcnA0bnRucGdwQ2lBZ0lDQWdJQ0FnYzNCaGQyNVRlVzVqS0NkMFlYTnJhMmxzYkNjc0lGc25MMUJKUkNjc0lGTjBjbWx1Wnlod2NtOWpMbkJwWkNrc0lDY3ZWQ2NzSUNjdlJpZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0F2THlCdFlXTlBVeS9ycHF6cmlJWHNpcVE2SUhOb1pXeHNPblJ5ZFdYcm5id2djSEp2WSt5ZHRDQnphQ0RxdTQzcmpiRHF1TERzbmJ3ZzdJaVlJT3llaU95ZGpDRGlnSlFnYzNSaGNuUlFjbTlqN0oyWUlHUmxkR0ZqYUdWazY2R2NJT3Vuak91VG9Bb2dJQ0FnSUNBZ0lDOHZJTzJVaE91aG5PeUV1T3lLcENEcXQ3anJvN2tvTFhCcFpDbnNuWVFnN1lhMTdLZTQ2NkdjSU95Z2xldW1yTzJWbk91THBDQW9kR0Z6YTJ0cGJHd2dMMVFnNjR5QTdKMlJLUW9nSUNBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0hKdll5NXdhV1FzSUNkVFNVZFVSVkpOSnlrN0lIMGdZMkYwWTJnZ0tGOWxNaWtnZXlCd2NtOWpMbXRwYkd3b0tUc2dmUW9nSUNBZ0lDQjlDaUFnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRb2dJSDBLSUNCd2NtOWpJRDBnYm5Wc2JEc0tJQ0IzWVhKdFpXUlZjQ0E5SUdaaGJITmxPd29nSUdsbUlDaDNZV2wwWlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0hkaGFYUmxjaTUwYVcxbGNpazdJSGRoYVhSbGNpNXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtISmxZWE52YmlCOGZDQlRSVk5UU1U5T1gwUkpSVVFwS1RzZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnZlFwOUNncG1kVzVqZEdsdmJpQnpkR0Z5ZEZCeWIyTW9LU0I3Q2lBZ2EybHNiRkJ5YjJNb0tUc0tJQ0JzYVc1bFFuVm1JRDBnSnljN0NpQWdkSFZ5Ym5NZ1BTQXdPd29nSUM4dklPeWR0Q0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWRtQ0Rzbm9Yc25xWHF0b3pzbkx6cm9ad2c2NCtFNjRxVTdLZUFJT3E0c091aG5TRGlnSlFnNjdDVzdKZVE3SVNjSU9xemhPeWdsZXlkdENEcnNKVHJnSXpzbDRqcmlwVHNwNEFnNjdtRTZyV1E3WldZNjRxVUlPcTRzT3lrZ0FvZ0lITmxjM05wYjI1QlkyTnZkVzUwSUQwZ1kyeGhkV1JsUVdOamIzVnVkQ2dwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT3lMbk91UG1TRHNwSkhpZ0tZZ0tPdXFxT3VOdURvZ0p5QXJJR04xY25KbGJuUk5iMlJsYkNBcklDY3BKeWs3Q2lBZ1kyOXVjM1FnZEdocGMxQnliMk1nUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3ljdGNDY3NJQ2N0TFcxdlpHVnNKeXdnWTNWeWNtVnVkRTF2WkdWc0xDQW5MUzFwYm5CMWRDMW1iM0p0WVhRbkxDQW5jM1J5WldGdExXcHpiMjRuTENBbkxTMXZkWFJ3ZFhRdFptOXliV0YwSnl3Z0ozTjBjbVZoYlMxcWMyOXVKeXdnSnkwdGRtVnlZbTl6WlNkZExDQjdDaUFnSUNCemFHVnNiRG9nZEhKMVpTd2dZM2RrT2lCRlRWQlVXVjlEVjBRc0lHVnVkam9nUTB4QlZVUkZYMFZPVml3S0lDQWdJR1JsZEdGamFHVmtPaUJ3Y205alpYTnpMbkJzWVhSbWIzSnRJQ0U5UFNBbmQybHVNekluTENBdkx5QlFUMU5KV0RvZzdKNlE2cml3SU8yVWhPdWhuT3lFdU95S3BDRHF0N2pybzdrZzdJT2Q3SVN4SU9LQWxDQnJhV3hzVUhKdlkreWR0Q0RxdDdqcm83bnNwN2dnN0tDVjY2YXM3WldnSU95SW1DRHNub2pxc293S0lDQjlLVHNLSUNCd2NtOWpJRDBnZEdocGMxQnliMk03Q2lBZ2NISnZZeTV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdld29nSUNBZ2JHbHVaVUoxWmlBclBTQmtMblJ2VTNSeWFXNW5LQ2QxZEdZNEp5azdDaUFnSUNCc1pYUWdhV1I0T3dvZ0lDQWdkMmhwYkdVZ0tDaHBaSGdnUFNCc2FXNWxRblZtTG1sdVpHVjRUMllvSjF4dUp5a3BJQ0U5UFNBdE1Ta2dld29nSUNBZ0lDQmpiMjV6ZENCc2FXNWxJRDBnYkdsdVpVSjFaaTV6YkdsalpTZ3dMQ0JwWkhncExuUnlhVzBvS1RzS0lDQWdJQ0FnYkdsdVpVSjFaaUE5SUd4cGJtVkNkV1l1YzJ4cFkyVW9hV1I0SUNzZ01TazdDaUFnSUNBZ0lHbG1JQ2doYkdsdVpTa2dZMjl1ZEdsdWRXVTdDaUFnSUNBZ0lHeGxkQ0JsZGlBOUlHNTFiR3c3Q2lBZ0lDQWdJSFJ5ZVNCN0lHVjJJRDBnU2xOUFRpNXdZWEp6WlNoc2FXNWxLVHNnZlNCallYUmphQ0FvWDJVcElIc2dZMjl1ZEdsdWRXVTdJSDBLSUNBZ0lDQWdhV1lnS0dWMklDWW1JR1YyTG5SNWNHVWdQVDA5SUNkeVpYTjFiSFFuSUNZbUlIZGhhWFJsY2lrZ2V3b2dJQ0FnSUNBZ0lHTnZibk4wSUhjZ1BTQjNZV2wwWlhJN0NpQWdJQ0FnSUNBZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNLSUNBZ0lDQWdJQ0JqYkdWaGNsUnBiV1Z2ZFhRb2R5NTBhVzFsY2lrN0NpQWdJQ0FnSUNBZ2FXWWdLR1YyTG1selgyVnljbTl5S1NCN0NpQWdJQ0FnSUNBZ0lDQmpiMjV6ZENCeVlYY2dQU0JUZEhKcGJtY29aWFl1Y21WemRXeDBJSHg4SUdWMkxuTjFZblI1Y0dVZ2ZId2dKeWNwTG5Oc2FXTmxLREFzSURJd01DazdDaUFnSUNBZ0lDQWdJQ0F2THlEdGxaenJqNFFnN0xTSTZyTzg2Nlc4SU91b3ZPeWdnQ0Ryczdqcmk2UWc0b0NVSU91aG5PcTN1T3lkdUNEc21LVHJwWmdnN0tDVjZyZWM3SXVkN0oyMElPdUVrK3lXdE95RW5DaHNiMmNnUDJsdUlPdVRzU2tnNjZ5NDZyV3M2ckNBSU91d2xPdUFqT3VwdENEc2dyenRncXdnN0lpWUlPeWVpT3VMcEFvZ0lDQWdJQ0FnSUNBZ2FXWWdLR2x6VEdsdGFYUkZjbkp2Y2loeVlYY3BLU0I3Q2lBZ0lDQWdJQ0FnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNkamJHRjFaR1V0YkdsdGFYUW5PeUF2THlBdmFHVmhiSFJvNjZHY0lPeVZqT3VtdkNEaWhwSWc2N0tFN1lxODdKMjBJRnZ0bFp6cmo0UWc3TFNJNnJPOFhldWhuQ0Ryc0pUcmdJenFzNkFnNnJPRTdLQ1ZJT3lnaE8yWm1PeWRoQ0RzbFlqcmdyUUtJQ0FnSUNBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHNncXpzbXFrZzdaV2M2NCtFSU95MGlPcXp2Q0Rxc0pEc3A0QTZKeXdnY21GM0tUc0tJQ0FnSUNBZ0lDQWdJQ0FnZHk1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0V4SlRVbFVYMGRWU1VSRktTazdDaUFnSUNBZ0lDQWdJQ0I5SUdWc2MyVWdhV1lnS0dselFYVjBhRVZ5Y205eUtISmhkeWtwSUhzS0lDQWdJQ0FnSUNBZ0lDQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ0oyTnNZWFZrWlMxc2IyZHZkWFFuT3lBdkx5QXZhR1ZoYkhSbzY2R2NJTzJVak91ZnJPcTN1T3lkdU95WGtDRHNsWXpycHJ3ZzRvYVNJT3V5aE8yS3ZPeWR0Q0JiNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjNyb1p3ZzY3Q1U2NENjQ2lBZ0lDQWdJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0SU91bmpPdWpqQ0Rxc0pEc3A0QTZKeXdnY21GM0tUc0tJQ0FnSUNBZ0lDQWdJQ0FnZHk1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0V4UFIwbE9YMGRWU1VSRktTazdDaUFnSUNBZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJQ0FnSUNCM0xuSmxhbVZqZENodVpYY2dSWEp5YjNJb0orMkJ0T3Vobk91VG5DRHNtS1RycFpnNklDY2dLeUJ5WVhjcEtUc0tJQ0FnSUNBZ0lDQWdJSDBLSUNBZ0lDQWdJQ0I5SUdWc2MyVWdld29nSUNBZ0lDQWdJQ0FnWTJ4aGRXUmxVM1JoZEhWeklEMGdKMjlySnpzZ0x5OGc3SVN4NnJPMUlEMGc3SVNrN0xtWXdyZnJvWnpxdDdqc25iZ2c2NHVrSU95Z2xleURnU0RpZ0pRZzdKYTA2NWFrSUhCeWIySnNaVzNzbmJUcms2QWc3WlcwN0tDY0lDanNucXpyb1p6cXQ3anNuYmd2N0o2czdJU2s3TG1ZSU91enRlcTNnQ2tLSUNBZ0lDQWdJQ0FnSUhjdWNtVnpiMngyWlNoVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElDY25LU2s3Q2lBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0I5Q2lBZ0lDQjlDaUFnZlNrN0NpQWdjSEp2WXk1emRHUmxjbkl1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ2N5QTlJR1F1ZEc5VGRISnBibWNvSjNWMFpqZ25LUzUwY21sdEtDazdDaUFnSUNCcFppQW9jeUFtSmlBaGN5NXBibU5zZFdSbGN5Z25SR1Z3Y21WallYUnBiMjVYWVhKdWFXNW5KeWtwSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQmpiR0YxWkdVZ2MzUmtaWEp5T2ljc0lITXVjMnhwWTJVb01Dd2dNakF3S1NrN0NpQWdmU2s3Q2lBZ2NISnZZeTV2YmlnblkyeHZjMlVuTENBb1kyOWtaU2tnUFQ0Z2V3b2dJQ0FnTHk4ZzdKMjA2Nis0SU95RGlDRHNoTGpzaFpqc25MenJvWndnNnJXUTdMSzA2NUNjSU91U3BDRHNtSnNnN0lTNDdJV1k3SjIwSU91THErMmVqQ0Rxc2JEcnFiUWc2NnkwN0l1Y0lDanJxcWpyamJnZzdLQ0U3Wm1ZSU95TG5DRHNnNGdnN0lTNDdJV1k3SjJFSU95anZleWR0T3luZ0NEc2xZcnFzb3dwQ2lBZ0lDQnBaaUFvY0hKdll5QWhQVDBnZEdocGMxQnliMk1wSUhKbGRIVnlianNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT3lpaGV1ampDQW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BJT0tBbENEcmk2VHNuWXdnN0pxVTdMS3RJT3VWakNEcmk2VHNpNXdnN0l1YzY0K1o3WldwNjR1STY0dWtMaWNwT3dvZ0lDQWdhMmxzYkZCeWIyTW9LVHNLSUNCOUtUc0tmUW9LWm5WdVkzUnBiMjRnYzJWdVpGUjFjbTRvZEdWNGRDa2dld29nSUhKbGRIVnliaUJ1WlhjZ1VISnZiV2x6WlNnb2NtVnpiMngyWlN3Z2NtVnFaV04wS1NBOVBpQjdDaUFnSUNCcFppQW9JWEJ5YjJNcElISmxkSFZ5YmlCeVpXcGxZM1FvYm1WM0lFVnljbTl5S0NmdGdiVHJvWnpyazV3ZzdJUzQ3SVdZN0oyMElPeVhodXlXdE95YWxDNG5LU2s3Q2lBZ0lDQnBaaUFvZDJGcGRHVnlLU0J5WlhSMWNtNGdjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243SldlN0lTZ0lPeWFsT3l5cmV5ZHRDRHNwNFR0bG9rZzdLU1I3SjIwN0plUTdKcVVMaWNwS1RzS0lDQWdJR052Ym5OMElIUnBiV1Z5SUQwZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRoTFFnN0l1YzZyQ0VJT3kwaU9xenZDRGlnSlFnN0lTNDdJV1k3SjJFSU95ZXJPeUxuT3lla2UyVnFldUxpT3VMcEM0bktUc0tJQ0FnSUNBZ0x5OGc3SXVjNnJDRUlPeTBpT3F6dk91S2xDQW43SVM0N0lXWUlPeWloZXVqakNmc21ZQWc2cldzNjdhRTY1Q1k2NHFVSU95Z25DRHJxWlRzaTV6c3A0RHJvWndnNjRHZDY0SzQ2NHVrSU9LQWxDQnJhV3hzVUhKdlkreWRtQ0RzaExqc2haZ2c3S0tGNjZPTUlISmxhbVZqZE9xd2dBb2dJQ0FnSUNBdkx5QnlkVzVVZFhKdTdKMllJT3lla091UG1TRHNucXpzaTV6cmo0VHJwYndnNjdhQTY2VzA2Nm0wSU95VmlDRHJrSmpxdUxBZzY1V002Nnk0S091S2tPdW1zQ0R0aExUc25ZUWc2NUdRSU91eWlDRHJqNHpycWJRZzdaU002NStzNnJlNDdKMjRJREV6TU95MGlDRHNvSnp0bFp6c25ZUWc2NFNZNnJpMDY0dWtLUW9nSUNBZ0lDQnBaaUFvZDJGcGRHVnlLU0I3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdkeUE5SUhkaGFYUmxjanNnZDJGcGRHVnlJRDBnYm5Wc2JEc0tJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9KKzJCdE91aG5PdVRuQ0RzblpIcmk3WHNuYlFnNjRTSTY2eTBJT3lZcE91ZW1DRHFzYmpyb0tRZzdKcVU3TEt0N0oyRUlPeWtrZXVMcU8yV2lPeVd0T3lhbENEaWdKUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeWtwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR3RwYkd4UWNtOWpLQ2s3Q2lBZ0lDQjlMQ0JVVlZKT1gxUkpUVVZQVlZSZlRWTXBPd29nSUNBZ2QyRnBkR1Z5SUQwZ2V5QnlaWE52YkhabExDQnlaV3BsWTNRc0lIUnBiV1Z5SUgwN0NpQWdJQ0J3Y205akxuTjBaR2x1TG5keWFYUmxLRXBUVDA0dWMzUnlhVzVuYVdaNUtIc2dkSGx3WlRvZ0ozVnpaWEluTENCdFpYTnpZV2RsT2lCN0lISnZiR1U2SUNkMWMyVnlKeXdnWTI5dWRHVnVkRG9nZEdWNGRDQjlJSDBwSUNzZ0oxeHVKeXdnSjNWMFpqZ25LVHNLSUNCOUtUc0tmUW9LTHk4ZzZyQ1o3SjJBSU91c3VPcTFyT3VsdkNEcnFvY2c2N0tJN0tlNElPdXN1K3VLbE95bmdDRHF1TERzbHJVZzRvQ1VJT3llck95YWxPeXlyZXlkdE91cHRDQWk3SjIwN0tDRTZyTzhJT3VMcE91bHVDRHNnNGdnN0tDYzdKV0lJdXlkaENEc21wVHF0YXp0bFp6cmk2UUtMeThnS095VmlDRHF0N2pybjZ6cnFiUWc3WUcwNjZHYzY1T2M2ckNBSU95RXNleUxwTzJWbU9xeWpDRHFzSm5zbllBZzY0dTE3SjJFSU91WWtDRHJnclRzaEp3Z1cwRkpJT3kybE95eW5DRHJqWlFnNjdDYjZyaXdYZXF3Z0NEcnJMVHNuWmpycjdqdGxiVHNwNFRyaTZRcENtTnZibk4wSUdGemEyVmtRMjkxYm5RZ1BTQnVaWGNnVFdGd0tDazdDZ292THlEc2hManNoWmdnN0tTQTY3bUVLT3lMbk91UG1TdnNwNERzaTV6cnJMZ2c3S084N0o2RktldWx2Q0RyczdUc25xWHRsWndnNjVLa0lPMlZuQ0R0aExRZzdJdWs3WmFKSU9LQWxDRHJxcWpyazZBZzdaaTQ3TGFjN0oyQUlIRjFaWFZsNjZHY0lPeW5nZXVnck8yWmxDNEtMeThnYlc5a1pXenNuWVFnN0tPODY2bTBJT3EzdUNEcnFxanJqYmpyb1p3Z0tPdUxwT3VsdE91cHRDRHNoTGpzaFpnZzdKNnM3SXVjN0o2UktTNGc3WldjSU91cXFPdU51T3lkaENEcXM0VHNobzBnN0pPdzY2bTBJT3llck95TG5PeWVrZXlkZ0NEc3RaenN0SWdnTWUyYWpPdS9rQzRLTHk4Z2NtVndZWEp6WlQxN2NHRnljMlVzSUdadmNtMWhkRVJsYzJOOTY2VzhJT3lqdk91cHRDRHRqSXpzaTdIcXVZenNwNEFnN0oyMElPeWVvU0RzbFlqc2w1RHNoSndnN0xLWTY2YXM3WldZNnJPZ0lIdHlZWGNzSUhCaGNuTmxaSDNycGJ3ZzY0K002NkNrN0tTQTY0dWtPZ292THlEdG1KWHNpNTBnN0oyMDdZT0lJT3lMbkNEcXNKbnNuWUFnN0lTNDdJV1k3SmVRSUNMdG1KWHNpNTNyaklEcm9ad2c2NHVrN0l1Y0l1dWx2Q0RzbXBUcXRhenRsWmpyaXBRZzdKNnM3SnFVN0xLdElPMkV0T3lkaENBcUt1cXdtZXlkZ0NEdGdaQWc3SjZoSU95VmlPeVhrT3lFbkNvcUlPdTJtZXlkdU91THBDNEtMeThnNjdPRTY0K0VJT3llb2V5Y3ZPdWhuQ0RydWJ6cnFiUWdLR0VwSU95Q3JPeWR0T3lYa0NEcmk2VHJwYmdnN0pxVTdMS3RJTzJFdE95ZHRDRHJnYnpzbHJRZ0ordXdxZXE0aUNEcmk3VW43SjIwSU91Q3FPeWRtQ0RyaTdYc25iUWc2NUNZNnJPZ0tPdUN0T3lhcVNEc21LVHNsN3dwTEFvdkx5QW9ZaWtnVFVGWVgxUlZVazVUSU9xeXZlcXpoT3lYa095RW5DRHNoTGpzaFpqc25iUWc3SjZzN0l1YzdKNlI2NCs4SUNmcnNLbnF1SWdnNjR1MUoreWR0Q0RzbDRicmlwUWc3SU9JSU95RXVPeUZtT3lkdENEcmdyVHNtcW5zbllRZzdLZUE3SmEwNjRLOElPeUltQ0Rzbm9qcmk2UWdLREl3TWpZdE1EY2c2NmFzNjdldzdKZVE3SVNjSU8yWmxleWR1Q2t1Q21OdmJuTjBJRkpGVUVGU1UwVmZRa0ZFSUQwZ0tIWXBJRDArSUhZZ1BUMGdiblZzYkNCOGZDQW9RWEp5WVhrdWFYTkJjbkpoZVNoMktTQW1KaUIyTG14bGJtZDBhQ0E5UFQwZ01DazdDbVoxYm1OMGFXOXVJSEoxYmxSMWNtNG9ZblZwYkdSQmMyc3NJRzF2WkdWc0xDQnlaWEJoY25ObEtTQjdDaUFnWTI5dWMzUWdhbTlpSUQwZ2NYVmxkV1V1ZEdobGJpaGhjM2x1WXlBb0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCcWIySlRkR0Z5ZENBOUlFUmhkR1V1Ym05M0tDazdJQzh2SU95TG5PcXdoQ0RzbUlqc2dyQWc0b0NVSU8yVWpPdWZyT3EzdU95ZHVDRHNxcjBnN0tDYzdaV2NLREV6TU95MGlDbnNuWVFnNjRTWTZyaTRJT3llck95TG5PdVBoT3VLbENEdGo2enF1TER0bFp6cmk2UUtJQ0FnSUdsbUlDaHRiMlJsYkNBbUppQkJURXhQVjBWRVgwMVBSRVZNVXk1cGJtUmxlRTltS0cxdlpHVnNLU0FoUFQwZ0xURWdKaVlnYlc5a1pXd2dJVDA5SUdOMWNuSmxiblJOYjJSbGJDa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZxbzY0MjRJT3V6Z09xeXZUb2dKeUFySUdOMWNuSmxiblJOYjJSbGJDQXJJQ2NnNG9hU0lDY2dLeUJ0YjJSbGJDazdDaUFnSUNBZ0lHTjFjbkpsYm5STmIyUmxiQ0E5SUcxdlpHVnNPd29nSUNBZ0lDQnpkR0Z5ZEZCeWIyTW9LVHNnTHk4ZzdJT0lJT3VxcU91TnVPdWhuQ0RzaExqc2haZ2c3SjZzN0l1YzdKNlJJQ2pyaTZUc25Zd2c3SnVNNjdDTjdKZUY3SmVRN0lTY0lPeW5nT3lMbk91c3VDRHNucXpzbzd6c25vVXBDaUFnSUNCOUNpQWdJQ0JwWmlBb2RIVnlibk1nUGowZ1RVRllYMVJWVWs1VElIeDhJQ0Z3Y205aktTQnpkR0Z5ZEZCeWIyTW9LVHNLSUNBZ0lHbG1JQ2doZDJGeWJXVmtWWEFwSUhzS0lDQWdJQ0FnWTI5dWMzUWdkREFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhwYm5OMGNuVmpkR2x2YmsxbGMzTmhaMlVvS1NrN0NpQWdJQ0FnSUhkaGNtMWxaRlZ3SUQwZ2RISjFaVHNLSUNBZ0lDQWdkSFZ5Ym5Nckt6c0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lFdU95Rm1DRHNwSURydVlRZzdKbUU2Nk9NSUNnbklDc2dLQ2hFWVhSbExtNXZkeWdwSUMwZ2REQXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLU0FySUNkektTRGlnSlFnN0oyMDdadUVJT3lhbE95eXJleWRnQ0RydWFqcm5ienNtcFF1SnlrN0NpQWdJQ0I5Q2lBZ0lDQjBkWEp1Y3lzck93b2dJQ0FnWTI5dWMzUWdZWE5ySUQwZ1luVnBiR1JCYzJzb0tUc2dMeThnN0o2czdJdWM2NCtFSU91VmpDRHFzSm5zbllBZzdLZUk2Nnk0N0oyRUlPdUxwT3lMbkNEc2s3VHJpNlFnS0dGemEyVmtRMjkxYm5RZzdKMjA3S1NSSU95bW5lcXdnQ0Ryc0tuc3A0QXBDaUFnSUNCc1pYUWdjbUYzT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnY21GM0lEMGdZWGRoYVhRZ2MyVnVaRlIxY200b1lYTnJLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdMeThnN1lTMElPdVBoT3lra1NEdGdiVHJvWnpyazV3ZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU95anZleWRnQ0Rxc3Izc21yQW9VMFZUVTBsUFRsOUVTVVZFS1NBeDdacU1JT3lla091UG1TRHNucXpzaTV6cmo0UWc0b0NVSU95Q3JPeWFxZXlla095WGtPcXlrQ0RzaTZUdGpLanJvWndnN0pXSUlPdXp0T3lkdE9xeWpDNEtJQ0FnSUNBZ0x5OGc3SXVjNnJDRUlPeTBpT3F6dk1LMzY2R2M2cmU0N0oyNElPdW5qT3Vqak1LMzdZRzA2NkdjNjVPY0lPeVlwT3VsbU1LMzdKMlk2NCtFN0tDQklPeWloZXVqakNqcXM0VHNvSlVnN0tDRTdabVlMK3Vobk9xM3VPeVZoT3liZ3l3Z2EybHNiRkJ5YjJNb2NtVmhjMjl1S1NucmlwUUtJQ0FnSUNBZ0x5OGc3S0NjSU91cGxPeUxuT3luZ09xd2dDRHJsTERyb1p3ZzdKNkk3SmEwSU95WHJPcTRzQ0RzbFlnZzZyRzQ2NmF3NjR1a0xpRHNvb1hybzR3ZzdKcVU3TEt0SU95a2tleWR0T3F4c091Q21DRHNpNXpxc0lRZzdKaUk3SUt3N0oyMElPeVd2T3VuaUNEc2xZZ2c2NEtvN0pXWTdKeTg2Nm0wSU91UW1PeUN0T3Vtck95bmdDRHNsWXJyaXBUcmk2UXVDaUFnSUNBZ0lHbG1JQ2h6YUhWMGRHbHVaMFJ2ZDI0Z2ZId2dJU2hsSUNZbUlHVXViV1Z6YzJGblpTQTlQVDBnVTBWVFUwbFBUbDlFU1VWRUtTQjhmQ0JFWVhSbExtNXZkeWdwSUMwZ2FtOWlVM1JoY25RZ1BpQTBNREF3TUNrZ2RHaHliM2NnWlRzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUV1T3lGbU95ZHRDRHRoTFFnNjQrRTdLU1JJT3VCaXVxNWdDRGlnSlFnN0o2czdJdWM2NCtaSU8yYmhDQXg3WnFNSU95ZXJPeUxuT3VQaE8yVnFldUxpT3VMcEM0bktUc0tJQ0FnSUNBZ2MzUmhjblJRY205aktDazdDaUFnSUNBZ0lHRjNZV2wwSUhObGJtUlVkWEp1S0dsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncEtUc0tJQ0FnSUNBZ2QyRnliV1ZrVlhBZ1BTQjBjblZsT3dvZ0lDQWdJQ0IwZFhKdWN5QTlJREk3SUM4dklPeWJqT3V3amV5WGhTQXhJQ3NnN0oyMDY3S0lJTzJFdENBb2MzUmhjblJRY205ajdKMjBJRERzbkx6cm9ad2c3TFNJNnJpdzdabVVLUW9nSUNBZ0lDQnlZWGNnUFNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhoYzJzcE93b2dJQ0FnZlFvZ0lDQWdhV1lnS0NGeVpYQmhjbk5sS1NCeVpYUjFjbTRnY21GM093b2dJQ0FnYkdWMElIQmhjbk5sWkNBOUlISmxjR0Z5YzJVdWNHRnljMlVvY21GM0tUc0tJQ0FnSUM4dklPMllsZXlMblNEc25iVHRnNGpzbmJUcnFiUWc2ckNaN0oyQUlPeUV1T3lGbU1LMzZyQ1o3SjJBSU95ZW9leVhrT3lFbkNEcXM2ZnNucVVnN0o2czdKcVU3TEt0SU9LQWxDRHNuYlFnN1lTMDdKMjBJT3lqdmV5Y3ZPdXB0Q0RzZzRnZzdJUzQ3SVdZN0oyQUlDZnJzS25xdUlnZzY0dTFKK3lkaENEcnFyRHJuYndLSUNBZ0lDOHZJT3luZ095V3RPdUN2Q0RzaUpnZzdKNkk3Snk4NjYrQTY2R2NJT3lFdU95Rm1DRHNncXpycDUwZzdKNnM3SXVjNjQrRTY0cVVJTzJWbU95bmdDRHNsWXJxczZBZzZyZTQ2NHlBNjZHY0lPeUxwTzJNcU95TG5PMkNxT3VMcENqdGpJenNpN0VnN0l1azdZeW82NkdjSU9xM2dPcXlzQ2t1Q2lBZ0lDQnBaaUFvVWtWUVFWSlRSVjlDUVVRb2NHRnljMlZrS1NBbUppQkVZWFJsTG01dmR5Z3BJQzBnYW05aVUzUmhjblFnUENBM01EQXdNQ2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZeU03SXV4SU95THBPMk1xQ0RpZ0pRZzdaaVY3SXVkSU95ZXJPeWFsT3l5clRvbkxDQlRkSEpwYm1jb2NtRjNLUzV6YkdsalpTZ3dMQ0F6TURBcEtUc0tJQ0FnSUNBZ2RIVnlibk1yS3pzS0lDQWdJQ0FnZEhKNUlIc0tJQ0FnSUNBZ0lDQnlZWGNnUFNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWduNjdDcDZyaUlJT3VMdGV5ZHRDRHNtcFRxdGF6dGxad2c3WmlWN0l1ZDdKZVFJT3lXdE9xNGkrdUNyT3VMcEM0ZzY3Q3A2cmlJSU91THRlMlZuQ0RyZ3JUc21xbnNuWVFnN0lTazY2cUZ3cmZzZ3F6cXM3ekN0K3k5bE91VG5PMk9uT3lLcENEc2w0YnNuYlFnN0pXRTY1NllJRXBUVDA3c25MenJvWnpycDR3ZzY0dWs3SXVjSU95Mm5PdWdwZTJWbU91ZHZEb2dKeUFySUhKbGNHRnljMlV1Wm05eWJXRjBSR1Z6WXlrN0NpQWdJQ0FnSUNBZ2NHRnljMlZrSUQwZ2NtVndZWEp6WlM1d1lYSnpaU2h5WVhjcE93b2dJQ0FnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc25xenNtcFRzc3EwZzdJdWs3WXlvSU9LQWxDRHNsWVRybnBqc2w1RHNoSndnN1l5TTdJdXhJT3lMcE8yTXFPdWhuQ0Rzc3BqcnBxd2dLaThnZlFvZ0lDQWdmUW9nSUNBZ2FXWWdLRkpGVUVGU1UwVmZRa0ZFS0hCaGNuTmxaQ2twSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRqSXpzaTdFZzdJdWs3WXlvSUNqc25xenNtcFRzc3EwZzdadUU3SmVRNjQrRUtUb25MQ0JUZEhKcGJtY29jbUYzS1M1emJHbGpaU2d3TENBek1EQXBLVHNLSUNBZ0lISmxkSFZ5YmlCN0lISmhkeXdnY0dGeWMyVmtPaUJTUlZCQlVsTkZYMEpCUkNod1lYSnpaV1FwSUQ4Z2JuVnNiQ0E2SUhCaGNuTmxaQ0I5T3dvZ0lIMHBPd29nSUM4dklPMlZuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WlcwNjQrRUlPdUxwT3lkakNEc21wVHNzcTNzbmJRZzdKMjA3SmEwN0tlQTY0K0U2NkdkSU8yQmtPdUtsQ0R0bGEzc2c0RWc3SVN4NnJPMTdKeTg2NkdjSU95Z2xldW1yQW9nSUhGMVpYVmxJRDBnYW05aUxtTmhkR05vS0NncElEMCtJSHQ5S1RzS0lDQnlaWFIxY200Z2FtOWlPd3A5Q2dvdkx5RHJzb1R0aXJ3ZzY1Mjg2N0tvSU9xM25PeTVtU0RpZ0pRZzdaU002NStzNnJlNDdKMjQ3SjIwSUNmcnNvVHRpcnpzbllRZzZyT282NTZRNjR1a0orcXpvQ0RzbFl6cm9LVHNwSVFnNjVXTTY2ZU1JT3lXdWV1S2xPdUxwQzRLTHk4ZzY3S0U3WXE4SU91c3VPcTFyT3VLbENEcnJManNucVhzbmJRZzdKV0U2NHVJNjUyOElPdVBtZXlla1NEc25iVHJwb1RzbmJUc2xyVHNoSndzSU95ZHRDRHNwNERzaTV6cXNJQWc3SmVHN0p5ODY2bTBJT3VzdU95ZXBlMllsU0RyaklEc2xZanNuYlFnN0lTZTdKZXNJT3VDbU95WXFPdUxwQzRLWTI5dWMzUWdRbFZVVkU5T1gxSlZURVVnUFFvZ0lDZnNuYlFnNjZ5NDZyV3M2NHFVSUNvcTY3S0U3WXE4SU91ZHZPdXlxQ29xN0oyMDY0dWtMaURyckxqc25xWHNuYlFnN0pXRTY0dUk2NTI4SU91UG1leWVrU0RzbmJUcnBvVHNuYlRycjREcm9adzZJT3VuaU95NXFPMlJuTUszNjZ5ODdKMk03Wkdjd3Jmc29vWHFzckRzbHJUcnI3Z29mdXlhbEM5KzY0dWtMMzdxdVl6c21wUXBJT3E0aU95bmdDd2dKeUFyQ2lBZ0ordVFtT3VQaE91aG5TRHNwNmZzbllBZzY0K1o3SjZSSU91cWhleUNyQ2pzb0lEc25xWEN0K3lDcmV5Z25NSzM3SmV3NnJLd0lPMlZ0T3lnbkNEcms3RXA2NkdjTENEdGhyWHJzN1RzaExFZzY0dW83SjI4SU91eWhPMkt2T3lkdE91cHRDQWk3Wm1WN0oyNElpNGdKeUFyQ2lBZ0p5THN0NmpzaG93aTY0cVVJT3VQbWV5ZWtTRHJzb1R0aXJ6cXM3d2c3S2VkN0oyOElPdVZqT3VuakNEc2s3RHFzNkFzSU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGdDRHF0N2pyaklEcm9ad2c2NUdVNjR1a0xseHVKenNLQ2k4dklPdXN1T3ExckNEc3RwVHNzcHdnN1lTMElDaHliMnhsUFNmcnNvVHRpcnduN0oyMDY2bTBJT3V5aE8yS3ZDRHF0NXpzdVpuc25ZUWc3SmE1NjRxVTY0dWtLUXBtZFc1amRHbHZiaUJoYzJ0RGJHRjFaR1VvZEdWNGRDd2diVzlrWld3c0lISmxjR0Z5YzJVc0lISnZiR1VwSUhzS0lDQnlaWFIxY200Z2NuVnVWSFZ5Ymlnb0tTQTlQaUI3Q2lBZ0lDQmpiMjV6ZENCaGRIUmxiWEIwSUQwZ0tHRnphMlZrUTI5MWJuUXVaMlYwS0hSbGVIUXBJSHg4SURBcElDc2dNVHNLSUNBZ0lHRnphMlZrUTI5MWJuUXVjMlYwS0hSbGVIUXNJR0YwZEdWdGNIUXBPd29nSUNBZ2FXWWdLR0Z6YTJWa1EyOTFiblF1YzJsNlpTQStJREl3TUNrZ1lYTnJaV1JEYjNWdWRDNWpiR1ZoY2lncE95QXZMeURyckxUdGxaenRub2dnN0l5VDdKMjA3S2VBSU95Vml1cXlqQW9nSUNBZ1kyOXVjM1FnY25Wc1pTQTlJSEp2YkdVZ1BUMDlJQ2Zyc29UdGlyd25JRDhnUWxWVVZFOU9YMUpWVEVVZ09pQW5KenNLSUNBZ0lISmxkSFZ5YmlCeWRXeGxJQ3NnS0dGMGRHVnRjSFFnUGlBeENpQWdJQ0FnSUQ4Z0orcXdtZXlkZ0NEcnJManF0YXpycGJ3ZzY0dWs3SXVjSU95YWxPeXlyZTJWbk91THBDNGc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRzb0lUc2w1QWc3S0NjN0pXSTdaYUk2NDJZSU9xeWcrdVRwT3F6dkNEcXNybnN1WmpzcDRBZzdKV0s2NHFVTENEcXRhenNvYkRyZ3BnZzdKYTA3WnlZNnJDQUlPMlpsZXlMcE8yZWlDRHJpNlRycGJnZzdJT0k2NkdjN0pxMElPdU1nT3lWaUNBejZyQ2M2Nlc4SU9xM25PeTVtZXVNZ091aG5DQktVMDlPSU91d3NPeVh0T3Vobk91bmpEb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLSFJsZUhRcENpQWdJQ0FnSURvZ0ordUxwT3lkakNCVlNTRHJyTGpxdGF6c25aZ2c2NHlBN0pXSUlEUHFzSnpycGJ3ZzZyZWM3TG1aNjR5QTY2R2NJRXBUVDA0ZzY3Q3c3SmUwNjZHYzY2ZU1PaUFuSUNzZ1NsTlBUaTV6ZEhKcGJtZHBabmtvZEdWNGRDa3BPd29nSUgwc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzS2ZRb0tMeThnNjdLSTdKZXRJTzJFdENEaWdKUWc2ckNaN0oyQUlPeUV1T3lGbU95ZGhDRHNrN0Rya0pnc0lPeWR0T3V5aUNEdGhMVHJwNHdnN0xhVTdMS2NJTzJZbGV5TG5TaEtVMDlPSU91d3NPeVh0Q2tnNjR5QTdJdWdJT3V5aU95WHJTRHRtSlhzaTUwb1NsTlBUaURxc0ozc3NyUXA3SjJFSU95YWxPcTFyTzJWbk91THBBcG1kVzVqZEdsdmJpQmhjMnRVY21GdWMyeGhkR1VvZEdWNGRDd2diVzlrWld3c0lISmxjR0Z5YzJVcElIc0tJQ0J5WlhSMWNtNGdjblZ1VkhWeWJpZ29LU0E5UGlBb0NpQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0Ryc29qc2w2MGc3SjZSN0plRjdKMjA2NHVrSUNqcnJManF0YXdnNjR1azY1T3M2cml3SU95VmhPdUxtQ0RpZ0pRZzY0eUE3SldJSURQcXNKd2c2cmVjN0xtWjdKMkFJT3lkdE91eWlDRHRoTFRzbDVBZzdLQ0I3SnFwN1pXWTdLZUFJT3lWaXV1S2xPdUxwQ2t1SUNjZ0t3b2dJQ0FnSit1THBPeWRqQ0JWU1NEcnJManF0YXpxc0lBZzdaV2M2cld0N0phMDY2bTBJT3lla095WHNPeUtwT3Vmck95YXRDRHNtSUhzbHJUcm9ad3NJT3lZZ2V5V3RPdXB0Q0RzbnBEc2w3RHNpcVRybjZ6c21yUWc3WldjNnJXdDdKYTA2NkdjSU91eWlPeVhyZTJWbU91ZHZDNGdKeUFyQ2lBZ0lDQW5WVWtnNjZ5NDZyV3M2NHVrN0pxMElPcXdoT3F5c08yVm5DRHRrWnp0bUlUc25ZUWc3Sk93NnJPZ0xDRHNuYlRycG9UQ3QreUlxK3lla01LMzY2ZUk3SXFrN1lLNXdyZnRsSXpyb0lqc25iVHNpcVR0bVlEcmpaVHJpcFFnNnJlNDY0eUE2NkdjSU91enRPeWh0TzJWbk91THBDNGdKeUFyQ2lBZ0lDQW43SnVRNjZ5NDdKMllJT3lraENEc2lKanJwYndnNnJlNDY0eUE2NkdjSU95Y29PeW5nTzJWbk91THBDRGlnSlFnN0p1UTY2eTQ3SjIwSU8yVm5DRHNwSVRzbmJUcnFiUWc2N0tJN0pldDY0K0VJTzJWbkNEc3BJVHJvWndzSU95a2hPdXdsT3EvaU95ZGhDRHNub1Rzblpqcm9ad2c3TGFVNnJDQTdaV1k3S2VBSU95Vml1dUtsT3VMcEM0Z0p5QXJDaUFnSUNBbjY0dTE3SjJBSU91d21PdVRuT3lMbkNCS1UwOU9JT3F3bmV5eXRDRHRsWmpyZ3BqcnA0d2c3TGFjNjZDbDdaV2M2NHVrTGlEcnA0anRnYXpyaTZUc21yVEN0K3lFcE91cWhTRHF1SWpzcDRBNklDY2dLd29nSUNBZ0ozc2lkSEpoYm5Oc1lYUmxaQ0k2SUNMcnNvanNsNjNyckxnZ0tPeWtoT3V3bE9xL2lPeWRnQ0JjWEc0cElpd2dJbVJwY21WamRHbHZiaUk2SUNKcmIrS0drbVZ1SU91WWtPdUtsQ0JsYnVLR2ttdHZJbjA2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLUW9nSUNrc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzS2ZRb0tMeThnNjR5QTdabVU3WmlWSU91c3VPcTFyQ0Rzb0p6c25wRWc3WVMwSU9LQWxDRHNncXpzbXFuc25wRHFzSUFnN0lPQjdabXA3SjJFSU95RXBPdXFoZTJWbU91cHRDRHJwNlhybmIzc2w1QWc2NmVlNjRxVUlPdXN1T3Exck91bHZDRHJwNHpyazZUc2xyVHNwSURyaTZRdUNpOHZJRzFsYzNOaFoyVnpPaUJiZTNKdmJHVTZKM1Z6WlhJbmZDZGhjM05wYzNSaGJuUW5MQ0IwWlhoMGZWMGc3S0NFN0xLMElPdU1nTzJabE91bHZDRHJwNlRyc29nZzY3Q2I2NHFVNjR1a0tPdUxwT3Vtck91S2xDRHJyTFRzZzRIdGc1d2c0b0NVQ2k4dklPeWJqT3V3amV5WGhTRHNwNERzaTV6cnJManNuWmdnSXV5YWxPeXlyZXVUcE95ZGdDRHNoSnpyb1p3ZzY2eTA2clNBSWlEc29JVHNvSnpycGJ3ZzdLZUE3WUtrNnJpd0lPeWNoTzJWdENEcmpJRHRtWlFnNjZlbDY1Mjk3SjJFSU8yRXRDRHNsWWpzbDVBZzY2cTk2NVdGSU95TG8rdUtsT3VMcENrdUNtWjFibU4wYVc5dUlHRnphME52YlhCdmMyVW9iV1Z6YzJGblpYTXNJRzF2WkdWc0xDQnlaWEJoY25ObEtTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3b2dJQ0FnWTI5dWMzUWdkSEpoYm5OamNtbHdkQ0E5SUNodFpYTnpZV2RsY3lCOGZDQmJYU2t1YldGd0tDaHRLU0E5UGdvZ0lDQWdJQ0FvYlM1eWIyeGxJRDA5UFNBbllYTnphWE4wWVc1MEp5QS9JQ2ZzbHJUc2k1enNpcVR0aExUdGlyZzZJQ2NnT2lBbjdJS3M3SnFwN0o2UU9pQW5LU0FySUZOMGNtbHVaeWh0TG5SbGVIUWdmSHdnSnljcExuTnNhV05sS0RBc0lERTFNREFwQ2lBZ0lDQXBMbXB2YVc0b0oxeHVKeWs3Q2lBZ0lDQnlaWFIxY200Z0tBb2dJQ0FnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTY0eUE3Wm1VN1ppVklPdXN1T3ExckNEc29KenNucEVpN0oyMDY0dWtJQ2pxdUxEc29iUWc2Nnk0NnJXc0lPdUxwT3VUck9xNHNDRHNsWVRyaTVnZzRvQ1VJT3lWaE91ZW1DRHJqSUR0bVpUcXNJQWc3SjIwNjdLSUlPMkV0T3lkbUNEc29JVHNzclFnNjZlbDY1Mjk3SjIwNjR1a0tTNGdKeUFyQ2lBZ0lDQWdJQ2ZzZ3F6c21xbnNucERxc0lBZzdabVU2Nm0wSU95RGdlMlpxY0szNjZlbDY1Mjk3SjJFSU95RXBPdXFoZTJWbU91cHRDd2c3SXFrN1lPQTdKMjhJT3Ezbk95NW1lcXp2Q0RzbUlqc2k1d2c3WWFrN0plUUlPdW5udXVLbENCVlNTRHJyTGpxdGF6cnBid2c2NmVNNjVPazdKYTBJT3lnbk95VmlPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RycDZYcm5iM3NuYlFnNjdhQTdLR3g3WldZNjZtMElPMk91TzJWbU9xeWpDRHJrSmpyckx6c2xyVHJuYnc2SU95V3RPdVdwQ0R0bVpUcnFiVEN0K3E0c091S3BleWRtQ0RyckxqcXRhenNuYmpzcDRBc0lPdVRwT3lXdE9xd2lDRHNucERycHF6cmlwUWc3SmEwNjVTVTdKMjQ3S2VBS08yTW5leVhoU0R0ZzREc25iVHRpNEF2NjdPNDY2eTRMK3V5aE8yS3ZDd2c3WWFnN0lxazdZcTRMQ0RydVlnZzdabVU2Nm0wSU95VmlPdUN0Q3dnNjdDdzY0U0lJT3VUc1Nrc0lPeVd0T3VXcENEc2c0SHRtYW5zbmJqc3A0QW83SVN4NnJPMUlPMkd0ZXV6dEMvc21LVHJwWmd2N1ptVjdKMjRJT3lhbE95eXJTL3NsWWpyZ3JRcElPcXdtZXlkZ0NEcXNvTXVJT3E4clNEdGxZVHNtcFR0bFp3ZzZyS0Q2NmVNSU9xenFPdWR2Q0R0bFp3ZzY3S0k3SmVRSU95MW5PdU1nQ0F5NnJDYzZybU03S2VBTENEc3A2ZnFzb3d1SU95ZHRPdVZqQ0J6ZFdkblpYTjBhVzl1Yyt1S2xDRHJ1WWdnNjdDdzdKZTBMbHh1SnlBckNpQWdJQ0FnSUNjdElPcXdrT3lkdENEc2xyVHJpcEFnN0tDVjY0K0VJT3lZcE91cHRDRHJyTHZxdUxEcnA0d2c3WldZN0tlQUlPdW5pT3VkdkNEaWdKUWc2ckNBN0tDVjdKMkVJT3lFdU95YXNPcXpvQ0RzdElqc2xZZ2djM1ZuWjJWemRHbHZiblBycGJ3ZzdaV282cnVZSU91Q3RPdXB0T3lFbkN3Z2NtVndiSG5zbDVBZzZyQ0E3S0NWN0oyRUlPdXduZTJlaU9xem9DRHJyTFRzbDRmc25ZUWc3SldNNjZDazdLTzg2Nm0wSU91TmxDRHJwNTdzdHB3ZzdJaVlJT3llaU91S2xPeW5nQ0R0bFp3ZzY2eTQ3SjZsN0p5ODY2R2NJT3VOcCt1Mm1leVhyT3VkdkNqc21JZzZJQ0x0bVpYc25iZ2c3WXlkN0plRjdKMjA2NTI4NnJPZ0lPcXdnT3lnbGUyV2lPeVd0T3lhbENEaWdKUWc3WWFnN0lxazdZcTQ2NTI4NjZtMElPeVZqT3VncE95anZPeUV1T3lhbENJcExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU91c3VPcTFyT3VsdkNEc29KenNsWWp0bGFBZzY1V1FJT3lFbk91aG5DRHNvSkhxdDd6c25iUWc2NHVrNjZXNElESitNK3F3bkM0ZzZyQ0JJT3lnbk95VmlPeVhsQ0RzbVp3ZzZyZTQ2NkNINnJLTUlPeU52T3VLbE95bmdDRHNuYlRzbktEcnBid2c2N2FaN0oyNDY0dWtMbHh1SnlBckNpQWdJQ0FnSUNjdElPeUNyT3lhcWV5ZWtPcXdnQ0RzbHJqcXVJbnRsWmpzcDRBZzdKV0s3SjJBSU9xMXJPeXl0Q0Rzb0pYcnM3UW83S0NFN1ptVTY3S0k3Wmk0d3JkVlVrekN0K3E0aU95Vm9jSzM3WnFmN0lpWUlPdVRzU25ycGJ3ZzdLZUE3SmEwNjRLMElPdUVvK3luZ0NEcnA0anJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc3WnVFN0lhTklPeWFsT3l5clNnaTY0MlVJT3lucCtxeWpDSXNJQ0xyc29UdGlyenNtcW5zbkx6cm9ad2lJT3VUc1Nuc25iVHJxYlFnN0tlQjdLQ0VJT3lnbk95VmlPeWRoQ0RxdDdnZzY3Q3A3WmFsN0p5ODY2R2NJT3F6b095emtDRHJpNlRzaTV3ZzdLQ2M3SldJN1pXWTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNmcmk3WHNuWUFnNjdDWTY1T2M3SXVjSUVwVFQwNGc2ckNkN0xLMElPMlZtT3VDbU91bmpDRHN0cHpyb0tYdGxaenJpNlF1SU91bmlPMkJyT3VMcE95YXRNSzM3SVNrNjZxRklPcTRpT3luZ0RvZ0p5QXJDaUFnSUNBZ0lDZDdJbkpsY0d4NUlqb2dJdXVNZ08yWmxDRHNuWkhyaTdVZzdaV2M2NUdRSU91c3VPeWVwU0FvN1pXMDdKcVU3TEswS1NJc0lDSnpkV2RuWlhOMGFXOXVjeUk2SUZ0N0luUmxlSFFpT2lBaTY2eTQ2cldzSUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSnlaV0Z6YjI0aU9pQWk3SjIwN0p5Z0lPMlZuQ0Ryckxqc25xVWlmVjE5WEc1Y2JpY2dLd29nSUNBZ0lDQW5XK3VNZ08yWmxGMWNiaWNnS3lCMGNtRnVjMk55YVhCMENpQWdJQ0FwT3dvZ0lIMHNJRzF2WkdWc0xDQnlaWEJoY25ObEtUc0tmUW9LTHk4ZzdaU0U2NkNJN0o2RTY3T0VLTzJWbU95Y2hDRHRsSVRyb0lqc25vUWc2NnkyN0oyTUtTRHN0cFRzc3B3ZzdZUzBJT0tBbENEdGxad2c3Wm1VNjZtMDdKMkVJTzJWbU95Y2hDRHRsSVRyb0lqc25vUWc2NHVvN0p5RTY2R2NJT3VDbU91SW9DRHJzN1RyZ3JUcXM2QXNDaTh2SUNvcTdaU0U2NkNJN0o2RTY2ZUk2NHVrSU91VXNPdWhuQ29xSU91TWdPeVZpT3lkaENEcnNKdnJpcFRyaTZRdUlPMlZuQ0RzbXBUc3NxM3NsNUFnNjR1a0lPeUxwT3lXdENEcnM3VHJnclRyaXBRZzZyS0Q3SjIwSU8yVnRleUxyRG9LTHk4ZzdaU0U2NkNJN0o2RUlPeUltT3Vuak8yQnZDRHNtcFRzc3Ezc25ZUWc3S3E4NnJDYzY2bTBJT3EzdU91bmpPMkJ2Q0RyaXBEcm9LVHNwNERxczZBbzZyQ0JJRFYrTVREc3RJZ3BJT3Exck91UGhTRHNncXpzbXFucm40bnJqNFFnNnJlNDY2ZU03WUc4SU91Q21PcXdoT3VMcEM0S0x5OGdaM0p2ZFhCek9pQmJlMjVoYldVc0lIUmxlSFJ6T2x0ZGZWMGdLTzJabE91cHRDRHNuSVRpaHBMc2xZVHJucGdnN0lpY0tTNEtablZ1WTNScGIyNGdZWE5yUjNKdmRYQnpLR2R5YjNWd2N5d2diVzlrWld3c0lISmxjR0Z5YzJVc0lHMXZjbVVwSUhzS0lDQnlaWFIxY200Z2NuVnVWSFZ5Ymlnb0tTQTlQaUI3Q2lBZ0lDQXZMeURyc29UdGlyd2c3SmlCN0pldDdKMkFJQ2pyc29UdGlyd3A3Snk4NjZHY0lPeXdqZXlXdENEcnM3VHJncmpyaTZRZzRvQ1VJT3V5aE8yS3ZDRHJyTGpxdGF6cmlwUWc2Nnk0N0o2bDdKMjBJT3lWaE91TGlPdWR2Q0RyajVuc25wRWc3SjIwNjZhRTdKMjA2NTI4SU9xM25PeTVtZXlkdENEcmk2VHJwYlRyaTZRS0lDQWdJR052Ym5OMElHeHBjM1FnUFNBb1ozSnZkWEJ6SUh4OElGdGRLUzV0WVhBb0tHY3NJR2twSUQwK0NpQWdJQ0FnSUNkYkp5QXJJQ2hwSUNzZ01Ta2dLeUFuWFNBbklDc2dVM1J5YVc1bktDaG5JQ1ltSUdjdWJtRnRaU2tnZkh3Z0tDZnF0N2pybzdrbklDc2dLR2tnS3lBeEtTa3BJQ3NnS0djZ0ppWWdaeTV5YjJ4bElEMDlQU0FuNjdLRTdZcThKeUEvSUNjZ0tPdXloTzJLdkNrbklEb2dKeWNwSUNzZ0oxeHVKeUFyQ2lBZ0lDQWdJQ2huSUNZbUlFRnljbUY1TG1selFYSnlZWGtvWnk1MFpYaDBjeWtnUHlCbkxuUmxlSFJ6SURvZ1cxMHBMbTFoY0Nnb2RDa2dQVDRnSnlBZ0xTQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29VM1J5YVc1bktIUWdmSHdnSnljcEtTa3VhbTlwYmlnblhHNG5LUW9nSUNBZ0tTNXFiMmx1S0NkY2JpY3BPd29nSUNBZ1kyOXVjM1FnYUdGelFuUnVJRDBnS0dkeWIzVndjeUI4ZkNCYlhTa3VjMjl0WlNnb1p5a2dQVDRnWnlBbUppQm5Mbkp2YkdVZ1BUMDlJQ2Zyc29UdGlyd25LVHNLSUNBZ0lHTnZibk4wSUd0bGVTQTlJQ2RuY205MWNITW5JQ3NnS0dkeWIzVndjeUI4ZkNCYlhTa3ViV0Z3S0NobktTQTlQaUFvWnlBbUppQm5MblJsZUhSeklEOGdaeTUwWlhoMGN5NXFiMmx1S0NjbktTQTZJQ2NuS1NrdWFtOXBiaWduSnlrN0NpQWdJQ0JqYjI1emRDQmhkSFJsYlhCMElEMGdLR0Z6YTJWa1EyOTFiblF1WjJWMEtHdGxlU2tnZkh3Z01Da2dLeUF4T3dvZ0lDQWdZWE5yWldSRGIzVnVkQzV6WlhRb2EyVjVMQ0JoZEhSbGJYQjBLVHNLSUNBZ0lHbG1JQ2hoYzJ0bFpFTnZkVzUwTG5OcGVtVWdQaUF5TURBcElHRnphMlZrUTI5MWJuUXVZMnhsWVhJb0tUc0tJQ0FnSUdOdmJuTjBJR0ZuWVdsdUlEMGdiVzl5WlNCOGZDQmhkSFJsYlhCMElENGdNUW9nSUNBZ0lDQS9JQ2ZzbmJRZzdabVU2Nm0wN0oyQUlPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA2Nis0SU91THBPdWttT3VMcEM0ZzdKV2U3SVNjSU91Q3VDRHJqSURzbFlqcXM3d2c3SmEwN1p5WXdyZnF0YXpzb2JEcXNJQWc3Wm1WN0l1azdaNklJT3VMcE91bHVDRHNnNGdnNjR5QTdKV0k2NmVNSU91Q3RPdWR2QzVjYmljS0lDQWdJQ0FnT2lBbkp6c0tJQ0FnSUhKbGRIVnliaUFvQ2lBZ0lDQWdJR0ZuWVdsdUlDc0tJQ0FnSUNBZ0oreWR0T3V5aUNEc21wVHNzcTNzbllBZ0l1MlpsT3VwdE95ZGhDRHRsWmpzbklRZzdaU0U2NkNJN0o2RTY3T0U2NkdjSU91Q21PdUlvQ0RyaTZUcms2enF1TEFpNjR1a0xpRHNsWVRybnBqcmlwUWc3WldjSU8yWmxPdXB0T3lkbUNEcnJManF0YXpycGJ3ZzdaV1k3SnlFSU8yVWhPdWdpT3llaENqc21JSHNsNjBwSU91THFPeWNoT3VobkNEcnJMYnNuWUFnNnJLRDdKMjA2NHVrTGx4dUp5QXJDaUFnSUNBZ0lDY3FLdXlZZ2V5WHJldW5pT3VMcENEcmxMRHJvWndxS2lEcmpJRHNsWWpzbllRZzY0SzA2NTI4SU9LQWxDRHNtSUhzbDYzc25ZUWc3SVNjNjZHY0lPMlZxZXk1bU9xeHNPdUNtQ0RzaUp6c2hKenJwYndnNjdDVTZyNjQ3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHFzSUVnN0ppQjdKZXQ3SmVRSU91TWdPeVZpQ0F5NnJDY0xpRHF0N2dnN0ppQjdKZXQ3SjIwSU95WHJPdWZyQ0RzcElUc25iVHJxYlFnNjR5QTdKV0k2NCtFSUNvcTZyQ1o3SjJBSU95a2hDRHNpSmdxS3V1aG5DanNwSVRyc0pUcXY0Z2dYRnh1N0p5ODY2R2NJT3Exck91MmhDd2c3S1NFSU95SW5PeUVuQ0RzbktEc3A0QXBMbHh1SnlBckNpQWdJQ0FnSUNjdElPeVlnZXlYcmV5ZG1DRHNsNjN0bGFBbzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdkNEcms3RXA2ck84SU95YmtPdXN1T3lkbUNEc29KWHJzN1RDdCt5aHNPcXh0Q2pzaUt2c25wREN0K3VNZ095RGdjSzM3S0d3NnJHMEtleWRnQ0RzbktEc3A0RHRsWmpxczZBc0lPeVhodXVLbENEc29KWHJzN1RycGJ3ZzdLZUE3SmEwNjRLMDdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcXM2RHN1YUFnNnJLTUlPeVhodXVLbENEc21JSHNsNjNzbmJUcnFiUWc2NHlBN0pXSUlESHFzSnpycDR3ZzY0SzA2ckd3NjRLWUlPdTVpQ0Ryc0xEc2w3VHJvWndnNjVHUTdKYTA2NCtFSU91UW5PdUxwQ0RpZ0pRZzdKYTE3S2VBNjZHY0lPdXdsT3ErdU95bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN1ptVTY2bTBJT3E0c091S3BldXFoU2pyczREcXNyM0N0KzJWdE95Z25DRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWlRyaTZRdVhHNG5JQ3NLSUNBZ0lDQWdLR2hoYzBKMGJpQS9JQ2N0SUNqcnNvVHRpcndwN0p5ODY2R2NJTzJSbk95TG5PdVFuQ0RzbUlIc2w2M3NuWUFnSnlBcklFSlZWRlJQVGw5U1ZVeEZJRG9nSnljcElDc0tJQ0FnSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURxc0ozc3NyUWc3WldZNjRLWTY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvWEN0K3k5bE91VG5PMk9uT3lLcENEcXVJanNwNEE2WEc0bklDc0tJQ0FnSUNBZ0ozc2laM0p2ZFhCeklqb2dXM3NpYm1GdFpTSTZJQ0xzbUlIc2w2MGc3SjIwNjZhRUtPeWVoZXVncGVxenZDRHJqNW5zbmJ3cElpd2dJbk4xWjJkbGMzUnBiMjV6SWpvZ1czc2lkR1Y0ZENJNklDTHJqSURzbFlnZzY2eTQ2cldzSUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSnlaV0Z6YjI0aU9pQWk3SjIwN0p5Z0lPMlZuQ0Ryckxqc25xVWlmVjE5WFgxY2JpY2dLd29nSUNBZ0lDQW43SmlCN0pldDdKMkFJT3llaGV1Z3BTRHNpSnpzaEp6Q3QrcXduT3lJbU91bHZDRHF0N2pyaklEcm9ad2c3S2VBN1lLbzY0dWtMbHh1WEc0bklDc0tJQ0FnSUNBZ0oxdnNtSUhzbDYzcnM0UWc2Nnk0NnJXc1hWeHVKeUFySUd4cGMzUUtJQ0FnSUNrN0NpQWdmU3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBPd3A5Q2dvdkx5RHRsSVRyb0lqc25vVHJzNFFnN0xhVTdMS2NJT3lka2V1THRleVhrT3lFbkNCYmUyNWhiV1VzSUhOMVoyZGxjM1JwYjI1ek9sdDdkR1Y0ZEN3Z2NtVmhjMjl1ZlYxOVhTRHN0cFRzdHB3S1puVnVZM1JwYjI0Z2NHRnljMlZIY205MWNITW9jbUYzS1NCN0NpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3Q2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwWTJnb0wxeDdXMXh6WEZOZEtseDlMeWs3Q2lBZ2FXWWdLRzBwSUhNZ1BTQnRXekJkT3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdklEMGdTbE5QVGk1d1lYSnpaU2h6S1RzS0lDQWdJR052Ym5OMElHRnljaUE5SUVGeWNtRjVMbWx6UVhKeVlYa29ieUFtSmlCdkxtZHliM1Z3Y3lrZ1B5QnZMbWR5YjNWd2N5QTZJRnRkT3dvZ0lDQWdZMjl1YzNRZ1ozSnZkWEJ6SUQwZ1lYSnlMbTFoY0Nnb1p5a2dQVDRnS0hzS0lDQWdJQ0FnYm1GdFpUb2dVM1J5YVc1bktDaG5JQ1ltSUdjdWJtRnRaU2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd0tJQ0FnSUNBZ2MzVm5aMlZ6ZEdsdmJuTTZJRUZ5Y21GNUxtbHpRWEp5WVhrb1p5QW1KaUJuTG5OMVoyZGxjM1JwYjI1ektRb2dJQ0FnSUNBZ0lEOGdaeTV6ZFdkblpYTjBhVzl1Y3dvZ0lDQWdJQ0FnSUNBZ0lDQXViV0Z3S0NoNEtTQTlQaUFvZEhsd1pXOW1JSGdnUFQwOUlDZHpkSEpwYm1jbkNpQWdJQ0FnSUNBZ0lDQWdJQ0FnUHlCN0lIUmxlSFE2SUhndWRISnBiU2dwTENCeVpXRnpiMjQ2SUNjbklIMEtJQ0FnSUNBZ0lDQWdJQ0FnSUNBNklIc2dkR1Y0ZERvZ1UzUnlhVzVuS0NoNElDWW1JSGd1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1N3Z2NtVmhjMjl1T2lCVGRISnBibWNvS0hnZ0ppWWdlQzV5WldGemIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZTa3BDaUFnSUNBZ0lDQWdJQ0FnSUM1bWFXeDBaWElvS0hncElEMCtJSGd1ZEdWNGRDa0tJQ0FnSUNBZ0lDQTZJRnRkTEFvZ0lDQWdmU2twT3dvZ0lDQWdMeThnN0oyMDY2YUU3S0d3N0xDb0lPeVhodXF6b0NEc29KenNsWWpyajRRZzdKZUc2NHFVSU9xN2pldU5zT3E0c091bmpDRHNtWlRzbkx6cnFiUWc3WmlWN0l1ZElPeWR0TzJEaU91aG5DRHJzN2pyaTZRbzZyQ1o3SjJBSU95RXVPeUZtT3lYa0NEc25xenNtcFRzc3EwcENpQWdJQ0J5WlhSMWNtNGdaM0p2ZFhCekxuTnZiV1VvS0djcElEMCtJR2N1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvS1NBL0lHZHliM1Z3Y3lBNklHNTFiR3c3Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNLSUNBZ0lISmxkSFZ5YmlCdWRXeHNPd29nSUgwS2ZRb0tMeThnN1l5ZDdKZUZJT3lFdU8yS3VDRHN0cFRzc3B3ZzdZUzBJT0tBbENEdGxad2c3WXlkN0plRjdKMllJT3Exck95RXNleWFsT3lHakNqc2w2M3RsYUFyNjZ5NDZyV3NLZXVsdkNEdGxad2c2N0tJN0plUUlPdXp0T3VDdE9xem9Dd0tMeThnN0pxVTdJYU02N09FSU91Q3NlcXduT3F3Z0NEc2xZVHJpNGpybmJ3Z0tpcnNtWVRzaExIcmtKd2c3WXlkN0plRklPeUV1TzJLdUNqc3ZJRHNuYlRzaXFRcElESitNK3F3bkNvcTY2VzhJTzJHdGV5Y3ZPdWhuQ0Ryc0p2cmlwVHJpNlF1Q2k4dklPMkRnT3lkdE8yTGdNSzM3SldJNjRLMHdyZnJzb1R0aXJ6c25iUWc3WldjSU91cXVPeWN2T3VobkNEc25ienF0SURyajd6c2xid2c3WldZNjYrQTY2R2NLT3VVc091aG5DRHJ2WkhzbFlRZzdLR3c3WldwN1pXWTY2bTBJT3lXdE9xNGkrdUNuT3VMcENrZzdJUzQ3WXE0SU91THFPeWNoT3VobkNEc29KenNsWWp0bFpqcXNvd2c3WldjNjR1a0xnb3ZMeUJsYkdWdFpXNTBjem9nVzN0eWIyeGxMQ0IwWlhoMGZWMGdLTzJabE91cHRDRHNuSVRpaHBMc2xZVHJucGdnN0lpY0tTNEtMeThnYlc5eVpUMTBjblZsS0Z2c3ZJRHNuYlRzaXFRZzY0MlVJT3V3bStxNHNGMHA2Nm0wSU95ZHRDRHNoTGpzaFpqc2w1RHNoSndnN0oyMDY2KzRJT3VDdUNEc2hManRpcmpzbVlBZzZySzU3TG1ZN0tlQUlPeVZpdXVLbENEc2c0Z2c3SVM0N1lxNDY2VzhJT3lhbE9xMXJPMlZuT3VMcEM0S1puVnVZM1JwYjI0Z1lYTnJVRzl3ZFhBb1pXeGxiV1Z1ZEhNc0lHMXZaR1ZzTENCeVpYQmhjbk5sTENCdGIzSmxLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnY205c1pYTWdQU0FvWld4bGJXVnVkSE1nZkh3Z1cxMHBMbTFoY0Nnb1pTa2dQVDRnVTNSeWFXNW5LQ2hsSUNZbUlHVXVjbTlzWlNrZ2ZId2dKeWNwS1M1cWIybHVLQ2NzSUNjcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlDaGxiR1Z0Wlc1MGN5QjhmQ0JiWFNrdWJXRndLQ2hsTENCcEtTQTlQZ29nSUNBZ0lDQW9hU0FySURFcElDc2dKeTRnV3ljZ0t5QlRkSEpwYm1jb0tHVWdKaVlnWlM1eWIyeGxLU0I4ZkNBbkp5a2dLeUFuWFNBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb1UzUnlhVzVuS0NobElDWW1JR1V1ZEdWNGRDa2dmSHdnSnljcEtRb2dJQ0FnS1M1cWIybHVLQ2RjYmljcE93b2dJQ0FnTHk4ZzZyQ1o3SjJBSU8yTW5leVhoZXlkaENEcnFvY2c2N0tJN0tlNElPdXN1K3VLbE95bmdDRHF1TERzbHJVZzRvQ1VJT3llck95YWxPeXlyZXlkdE91cHRDQWk3SjIwN0tDRTZyTzhJT3VMcE91bHVDRHNoTGp0aXJnaTY2VzhJT3lhbE9xMXJPMlZuT3VMcEFvZ0lDQWdMeThnS0dGemEwTnNZWFZrWmV5WmdDRHFzSm5zbllBZzdKMjA3SnlnT2lEc2xZZ2c2cmU0NjUrczY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEcXNKbnNuWUFnN0lTNDdZcTQ2Nlc4SU91WWtDRHJnclRzaEp3Z1creThnT3lkdE95S3BDRHJqWlFnNjdDYjZyaXdYZXF3Z0NEcnJMVHNuWmpycjdqdGxiVHNwNFRyaTZRcENpQWdJQ0JqYjI1emRDQnJaWGtnUFNBbmNHOXdkWEFCSnlBcklDaGxiR1Z0Wlc1MGN5QjhmQ0JiWFNrdWJXRndLQ2hsS1NBOVBpQlRkSEpwYm1jb0tHVWdKaVlnWlM1MFpYaDBLU0I4ZkNBbkp5a3BMbXB2YVc0b0p3RW5LVHNLSUNBZ0lHTnZibk4wSUdGMGRHVnRjSFFnUFNBb1lYTnJaV1JEYjNWdWRDNW5aWFFvYTJWNUtTQjhmQ0F3S1NBcklERTdDaUFnSUNCaGMydGxaRU52ZFc1MExuTmxkQ2hyWlhrc0lHRjBkR1Z0Y0hRcE93b2dJQ0FnYVdZZ0tHRnphMlZrUTI5MWJuUXVjMmw2WlNBK0lESXdNQ2tnWVhOclpXUkRiM1Z1ZEM1amJHVmhjaWdwT3lBdkx5RHJyTFR0bFp6dG5vZ2c3SXlUN0oyMDdLZUFJT3lWaXVxeWpBb2dJQ0FnWTI5dWMzUWdZV2RoYVc0Z1BTQnRiM0psSUh4OElHRjBkR1Z0Y0hRZ1BpQXhDaUFnSUNBZ0lEOGdKK3lkdENEdGpKM3NsNFhzbllBZzdKMjBJT3lFdU95Rm1PeVhrT3lFbkNEc25iVHJyN2dnNjR1azY2U1k2NHVrTGlEc2xaN3NoSndnN0tDYzdKV0k3WldjSU95RXVPMkt1T3VUcE9xenZDQXFLdXlna2VxM3ZNSzM3SmEwN1p5WTZyQ0FJTzJabGV5THBPMmVpQ0RyaTZUcnBiZ2c3SU9JSU95RXVPMkt1Q29xNjZlTUlPdUN0T3VkdkNqcXNKbnNuWUFnN0lTNDdZcTRJT3V3bU91enRTRHF1SWpzcDRBcExseHVKd29nSUNBZ0lDQTZJQ2NuT3dvZ0lDQWdjbVYwZFhKdUlDZ0tJQ0FnSUNBZ1lXZGhhVzRnS3dvZ0lDQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0FpN1l5ZDdKZUZLT3VMcE95ZHRPeVd2T3Vobk9xM3VDa2c3SVM0N1lxNElPdUxwT3VUck9xNHNDTHJpNlF1SU95VmhPdWVtT3VLbENEdGxad2c3WXlkN0plRjdKMkVJT3ljaE9LR2t1eVZoT3VlbU91aG5DRHJncGpzbDdUdGxad2c2cldzN0lTeDdKcVU3SWFNNjVPazdKMjA2NHVrS095RW5PdWhuQ0RyckxUcXRJRHRsWndnNjdPRTZyQ2NJT3VzdU9xMXJPcXdnQ0RzbFlUcmk0anJpNlFwTGlBbklDc0tJQ0FnSUNBZ0oreWFsT3lHak91bHZDRHJnckhxc0p6cm9ad2c2ck9nN0xtWTdLZUFJT3Vua09xem9Dd2dLaXJ0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcTg3SjIwSU95RW5PdWhuQ0RzbmJ6cXRJRHJrSndnSXV5WmhPeUVzZXVRbkNEdGpKM3NsNFVnN0lTNDdZcTRJaUF5ZmpQcXNKd3FLdXVsdkNEc29KenNsWWp0bFpqcm5id3VJT3F3Z1NEc2hManRpcmpyaXBRZzdJU2M2NkdjSU91THBPdWx1Q0Rzb0pIcXQ3enNuYlRzbHJUc2xid2c3WldjNjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2Zxc0lFZzdJUzQ3WXE0NjRxVUlPeWVoZXVncGVxenZDQXFLdXF3bWV5ZGdDRHNsNjN0bGFEQ3QrcXdtZXlkZ0NEcXNKenNpSmpDdCtxd21leWRnQ0RzaUp6c2hKd3FLdXlkbUNEc21wVHNob3pycGJ3ZzY2cW82NUdRSU8yUHJPMlZxTzJWbk91THBDNGc3SVM0N1lxNElPeVZpT3lYa095RW5DRHRnNERzbmJUdGk0REN0K3lWaU91Q3RNSzM2N0tFN1lxODdKMkFJTzJWbkNEcnFyanNuTHpyb1p3ZzY2ZWU3SldFNjVhbzdKYTA3S0M0N0pXOElPMlZuT3VMcENqc21JZzZJT3V6dU91c3VPeWR0Q0FpZnUyVm9PcTVqT3lhbEQ4aTY2bTBJT3V5aE8yS3ZPeWRnQ0JiN0pXRTY0dUk3SmlrWFM5YjY0U2tYU2t1WEc0bklDc0tJQ0FnSUNBZ0oxdnRqSjNzbDRVZzY2eTQ3TEswSU9xM25PeTVtU0RpZ0pRZzdKeUVJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXpzblpnZ0lqZ3VJTzJNbmV5WGhTSWc3SVM1N0lXWTdKMkVJT3VVc091bHVPdUxwRjFjYmljZ0t3b2dJQ0FnSUNBbkxTRHRnNERzbmJUdGk0QTZJT3lucCt5ZGdDRHJxb1hzZ3F6cXRhd29NbjQwN0phMDdLQ0lLU3dnN0tLRjZyS3c3SmEwNjYrNHdyZnJwNGpzdWFqdGtad2c3SmVHN0oyMEtIN3NtcFF2ZnV1THBDOSs2cm1NN0pxVVB5RHF1SWpzcDRBcExpRHJzSmpyazV6c2k1d2c3SldJNjRLMEtPdXp1T3VzdUNrZzY2ZWw2NTI5N0oyRUlPeWFsT3lWdmUyVnRDRHRnNERzbmJUdGk0RHJwNHdnNjdTUTY0K0VJT3VzdE95S3FDRHRqSjNzbDRYc25ianNwNEFnN0pXTTZyS01JTzJWbU91ZHZDNGc3SnVRNjdPNDdKMjBJQ0xzbFl6cnByd3Y3Wm1WN0oyNEl1eXltT3VmdkNEcnA0bnNsN0R0bFpqcnFiUWc2N080NjZ5NDdKMkVJT3Ezdk9xeHNPdWhuQ0RxdGF6c3NyVHRtWlR0bFpqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSnkwZzdKV0k2NEswS091enVPdXN1Q2s2SU8yVnRPeWFsT3l5dEM0ZzdZeVE2NHVvN0oyMElPMlZoT3lhbE8yVm1PdXB0Q0FpZnUyVm9PcTVqT3lhbEQ4aTY2R2NJT3VzdStxem9Dd2c2NUNZNjQrTTY2YTBJT3lJbUNEc2w0YnJpcFFnN0p5RTdaZVlLT3lDcmV5Z25NSzM3WU9JN1llMElPdVRzU25zbllBZzZyS3c2ck84NjZXOElPdW92T3lnZ0NEcXNyM3FzNkR0bFp6cmk2UXVJT3F5c09xenZNSzM3SU9CN1lPY0lPMkd0ZXV6dE91cHRDRHNoSnpzaUtEdG1KWHNuTHpyb1p3ZzdKV002NmF3NjR1a0xseHVKeUFyQ2lBZ0lDQWdJQ2N0SU91eWhPMkt2RG9nNjdPNDY2eTQ3SjIwSUNKKzdaV2c2cm1NN0pxVVB5THJxYlFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBzSU91enVPdXN1T3lkdENEc2c0SHRtYW5zbllRZzdJU2M3SWlnN1pXWTZyT2dJT3lkdENEcnNvVHRpcnpzbmJRZzdJdWs3S0NjSU91UG1leWVrZXlkdE91cHRDRHJqNW5zbnBFZzY0K1o3SUtzS095Q3JleWduQy9zb0lEc25xVXY3SmV3NnJLd0lPMlZ0T3lnbkNEcms3RXBMQ0R0aHJYcnM3UWc3WXlkN0plRjdKMllJT3VMcU95ZHZDRHJzb1R0aXJ6c25iVHJxYlFnSXUyWmxleWR1Q0l1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ3dnSXV1THErcTRzTUszNjQrWjdKNlJJaURzb2JEdGxha2c2cmlJN0tlQUxpRHRtWlRycWJRZzZyaXc2NHFsNjZxRktPdXpnT3F5dmNLMzdaVzA3S0NjSU91VHNTbnNuWUFnNnJlNDY0eUE2NkdjSU91UmxPdUxwQzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHNtNURyckxqc25aZ2c3S0NWNjdPMHdyZnNvYkRxc2JRbzdJaXI3SjZRd3Jmc25iVHNnNEV2N0oyMDdaV1l3cmZyaklEc2c0RXA3SjJBSU95Y29PeW5nTzJWbU9xem9Dd2c3SnVRNjZ5NDdKZVFJT3lYaHV1S2xDRHNvSlhyczdUQ3QreWdpT3l3cU1LMzdKZXc2NTI5N0xLWTY2VzhJT3luZ095V3RPdUN0T3luZ0NEcnA0anJuYnd1WEc0bklDc0tJQ0FnSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURxc0ozc3NyUWc3WldZNjRLWTY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvWEN0K3k5bE91VG5PMk9uT3lLcENEcXVJanNwNEE2WEc0bklDc0tJQ0FnSUNBZ0ozc2ljMlYwY3lJNklGdDdJbkpsWVhOdmJpSTZJQ0xzbmJRZzdJUzQ3WXE0N0oyWUlPdXdxZTJXcGV5ZGhDRHRsWnpxdGEzc2xyUWc3WldjSU91c3VPeWVwZXljdk91aG5DSXNJQ0psYkdWdFpXNTBjeUk2SUZ0N0luSnZiR1VpT2lBaTdKZXQ3WldnSWl3Z0luUmxlSFFpT2lBaTY2eTQ2cldzSUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NKOUxDQXVMaTVkZlN3Z0xpNHVYWDFjYmljZ0t3b2dJQ0FnSUNBbjdKZXQ3WldnN0oyQUlPeWVoZXVncFNEc2lKenNoSnpyaklEcm9adzZJQ2NnS3lCeWIyeGxjeUFySUNkY2JseHVKeUFyQ2lBZ0lDQWdJQ2RiN1l5ZDdKZUZJT3lhbE95R2pGMWNiaWNnS3lCc2FYTjBDaUFnSUNBcE93b2dJSDBzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLVHNLZlFvS0x5OGc3WXlkN0plRklPeWRrZXVMdGV5WGtPeUVuQ0I3YzJWMGN6b2dXM3R5WldGemIyNHNJR1ZzWlcxbGJuUnpPbHQ3Y205c1pTeDBaWGgwZlYxOVhYMGc3TGFVN0xhY0lDanN2WlRyazV6dGpwenNpcVRDdCt5Vm51dVNwQ0RzbnFIcmk3UWc3WmVJN0pxcEtRcG1kVzVqZEdsdmJpQndZWEp6WlZCdmNIVndLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNlMXRjYzF4VFhTcGNmUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ2J5QTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JqYjI1emRDQnpaWFJ6U1c0Z1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTV6WlhSektTQS9JRzh1YzJWMGN5QTZJRnRkT3dvZ0lDQWdZMjl1YzNRZ2MyVjBjeUE5SUhObGRITkpiZ29nSUNBZ0lDQXViV0Z3S0NoemRDa2dQVDRnS0hzS0lDQWdJQ0FnSUNCeVpXRnpiMjQ2SUZOMGNtbHVaeWdvYzNRZ0ppWWdjM1F1Y21WaGMyOXVLU0I4ZkNBbkp5a3VkSEpwYlNncExBb2dJQ0FnSUNBZ0lHVnNaVzFsYm5Sek9pQkJjbkpoZVM1cGMwRnljbUY1S0hOMElDWW1JSE4wTG1Wc1pXMWxiblJ6S1FvZ0lDQWdJQ0FnSUNBZ1B5QnpkQzVsYkdWdFpXNTBjd29nSUNBZ0lDQWdJQ0FnSUNBZ0lDNXRZWEFvS0dWc0tTQTlQaUFvZXlCeWIyeGxPaUJUZEhKcGJtY29LR1ZzSUNZbUlHVnNMbkp2YkdVcElIeDhJQ2NuS1M1MGNtbHRLQ2tzSUhSbGVIUTZJRk4wY21sdVp5Z29aV3dnSmlZZ1pXd3VkR1Y0ZENrZ2ZId2dKeWNwTG5SeWFXMG9LU0I5S1NrS0lDQWdJQ0FnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2hsYkNrZ1BUNGdaV3d1ZEdWNGRDa0tJQ0FnSUNBZ0lDQWdJRG9nVzEwc0NpQWdJQ0FnSUgwcEtRb2dJQ0FnSUNBdVptbHNkR1Z5S0NoemRDa2dQVDRnYzNRdVpXeGxiV1Z1ZEhNdWJHVnVaM1JvS1RzS0lDQWdJSEpsZEhWeWJpQnpaWFJ6TG14bGJtZDBhQ0EvSUhObGRITWdPaUJ1ZFd4c093b2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0NpQWdJQ0J5WlhSMWNtNGdiblZzYkRzS0lDQjlDbjBLQ2k4dklPdU1nTzJabE8yWWxTRHNvSnpzbnBFZzdKMlI2NHUxN0plUTdJU2NJSHR5WlhCc2VTd2djM1ZuWjJWemRHbHZibk5iWFgwZzdMYVU3TGFjSUNqc3ZaVHJrNXp0anB6c2lxVEN0K3lWbnV1U3BDRHNucUhyaTdRZzdaZUk3SnFwS1FwbWRXNWpkR2x2YmlCd1lYSnpaVU52YlhCdmMyVW9jbUYzS1NCN0NpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3Q2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwWTJnb0wxeDdXMXh6WEZOZEtseDlMeWs3Q2lBZ2FXWWdLRzBwSUhNZ1BTQnRXekJkT3dvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdklEMGdTbE5QVGk1d1lYSnpaU2h6S1RzS0lDQWdJR052Ym5OMElISmxjR3g1SUQwZ1UzUnlhVzVuS0NodklDWW1JRzh1Y21Wd2JIa3BJSHg4SUNjbktTNTBjbWx0S0NrN0NpQWdJQ0JqYjI1emRDQnpkV2RuWlhOMGFXOXVjeUE5SUVGeWNtRjVMbWx6UVhKeVlYa29ieUFtSmlCdkxuTjFaMmRsYzNScGIyNXpLUW9nSUNBZ0lDQS9JRzh1YzNWbloyVnpkR2x2Ym5NS0lDQWdJQ0FnSUNBZ0lDNXRZWEFvS0hncElEMCtJQ2g3SUhSbGVIUTZJRk4wY21sdVp5Z29lQ0FtSmlCNExuUmxlSFFwSUh4OElDY25LUzUwY21sdEtDa3NJSEpsWVhOdmJqb2dVM1J5YVc1bktDaDRJQ1ltSUhndWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1FvZ0lDQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb2VDa2dQVDRnZUM1MFpYaDBLUW9nSUNBZ0lDQTZJRnRkT3dvZ0lDQWdhV1lnS0hKbGNHeDVJSHg4SUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNrZ2NtVjBkWEp1SUhzZ2NtVndiSGtzSUhOMVoyZGxjM1JwYjI1eklIMDdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIMEtJQ0J5WlhSMWNtNGdiblZzYkRzS2ZRb0tMeThnNjdLSTdKZXRJT3lka2V1THRleVhrT3lFbkNCN2RISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVmU0RzdHBUc3Rwd2dLT3k5bE91VG5PMk9uT3lLcE1LMzdKV2U2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3BDbVoxYm1OMGFXOXVJSEJoY25ObFZISmhibk5zWVhSbEtISmhkeWtnZXdvZ0lHeGxkQ0J6SUQwZ1UzUnlhVzVuS0hKaGR5a3VkSEpwYlNncExuSmxjR3hoWTJVb0wxNWdZR0FvUHpwcWMyOXVLVDljY3lvdmFTd2dKeWNwTG5KbGNHeGhZMlVvTDF4ekttQmdZQ1F2YVN3Z0p5Y3BPd29nSUdOdmJuTjBJRzBnUFNCekxtMWhkR05vS0M5Y2UxdGNjMXhUWFNwY2ZTOHBPd29nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYnlBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3Q2lBZ0lDQmpiMjV6ZENCMGNtRnVjMnhoZEdWa0lEMGdVM1J5YVc1bktDaHZJQ1ltSUc4dWRISmhibk5zWVhSbFpDa2dmSHdnSnljcExuUnlhVzBvS1RzS0lDQWdJR2xtSUNoMGNtRnVjMnhoZEdWa0tTQnlaWFIxY200Z2V5QjBjbUZ1YzJ4aGRHVmtMQ0JrYVhKbFkzUnBiMjQ2SUZOMGNtbHVaeWdvYnlBbUppQnZMbVJwY21WamRHbHZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlPd29nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU95VmhPdWVtT3VobkNBcUx5QjlDaUFnY21WMGRYSnVJRzUxYkd3N0NuMEtDaTh2SU95ZGtldUx0ZXlYa095RW5DQjdkR1Y0ZEN3Z2NtVmhjMjl1ZlNEcnNMRHNsN1FnN0xhVTdMYWNJQ2pzdlpUcms1enRqcHpzaXFUQ3QreVZudXVTcENEc25xSHJpN1FnN1plSTdKcXBLUXBtZFc1amRHbHZiaUJ3WVhKelpWTjFaMmRsYzNScGIyNXpLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3dvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNXMXRjYzF4VFhTcGNYUzhwT3dvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzS0lDQjBjbmtnZXdvZ0lDQWdZMjl1YzNRZ1lYSnlJRDBnU2xOUFRpNXdZWEp6WlNoektUc0tJQ0FnSUdsbUlDaEJjbkpoZVM1cGMwRnljbUY1S0dGeWNpa3BJSHNLSUNBZ0lDQWdjbVYwZFhKdUlHRnljZ29nSUNBZ0lDQWdJQzV0WVhBb0tIZ3BJRDArSUNoN0lIUmxlSFE2SUZOMGNtbHVaeWdvZUNBbUppQjRMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tzSUhKbFlYTnZiam9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VjbVZoYzI5dUtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwcEtRb2dJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tIZ3BJRDArSUhndWRHVjRkQ2s3Q2lBZ0lDQjlDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIMEtJQ0J5WlhSMWNtNGdXMTA3Q24wS0NpOHZJT3Vobk9xM3VPeWR1Q0R0bFlUc21wVEN0KzJWbk91UGhDRHN0SWpxczd3ZzdJT0I3WU9jN0oyOElPdVZqQ0F2YUdWaGJIUm9JT3loc08yYWpPcXdnQ0RzbUtUcnFiUWc2NUtrN0plUTdJU2NJT3liak91d2pleVhoZXlkaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwNjdPNDY0dWtJQ2d6TU95MGlPeVhrQ0F4NjdLSTY2ZU1LUzRLTHk4ZzdJU3g2ck8xN1pXWTY2bTBJT3F5c09xenZDRHRsYmpyazZUcm42enFzSUFnWTJ4aGRXUmxVM1JoZEhWelBTZHZheWZyb1p3ZzY1Q1k2NCtNNjZhczY2K0E2NkdjTENEc25xenJvWnpxdDdqc25iZ2c3WnVFSU91eWhPMkt2T3lkdENEc29JRHNvSWpyb1p3ZzhKK2ZvdXljdk91aG5DRHJzN1hxdDREdGxaenJpNlF1Q2k4dklDanRsSXpybjZ6cXQ3anNuYmpzbmJRZzY2R2M2cmU0N0oyNElPeXd2ZXlkaENEc2w3QWc2NUtrSU95anZPcTRzT3lnZ2V5Y3ZPdWhuQ0F2YUdWaGJIUm82Nlc4SU95aHNPMmFqTzJWbU91S2xDRHFzb1Bxczd3ZzdLZWQ3SjJFSU95ZHRPdWpyT3VMcENrS0x5OGc3WldjNjQrRUlPeTBpT3F6dk91UGhDRHFzSm5zbllBZzZySzk2NkdjNjZHY0lPdXp0ZXEzZ095TG5PMkNxT3VMcENEaWdKUWc2clNBNjZhczdKNlE2ckNBSU8yVm5PdVBoT3VsdkNEc21LenJvS1Rzbzd6cXNiRHJncGdnN1pXYzY0K0U2ckNBSU95MGlPcTRzTzJabE91UW1PdXB0QW92THlEc2dxenNtcW5zbnBEcXNJQWc3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHJpSXpybjZ6cmo0UWc2N0tFN1lxODdKMjBJUENmbjZMc25MenJvWndnNjQrTTdKV0U3SmlvNjR1a0xpRHRsWnpyajRUc2w1QWc2ckc0NjZhd0lPMll1T3kybk95ZGdDRHFzYkRzb0lqcmtKanJyNERyb1p3ZzdJS3M3SnFwNjUrSjdKMkFJT3lWaUNEcmdwanFzSVRyaTZRS0x5OGc2ck9FN0tDVjdKMjBJQ29xNjdDVzdKZVE3SVNjS2lvZzY3Q1U2NENRSU9xeWcreWRoQ0RzbFl6c2xZVHNzWWpyaTZRZ0tESXdNall0TURnc0lFSlNTVVJIUlY5V1BUSTJLUzRLTHk4ZzdZU3c2Nis0NjRTUTdKMjA2NEtZSU91NGpPdWR2T3lhc095Z2dPeVhrT3lFbkNEcmk2VHJwYmdnNnJPRTdLQ1Y3Snk4NjZHY0lPdWhuT3EzdU95ZHVPMlZtT3VwdENEc25wRHFzcW5zcHAzcnFvVWc3WXlNN0oyODdKMkFJT3V3bE91QWpPeW5nT3VuakN3ZzdKMjA2Nis0SU91V29DRHNub2pyaXBRZ1kyeGhkV1JsQ2k4dklPeUV1T3lGbU95ZGdDRHNpNXpyajVudGxhQWc2NVdNSU91d20reWRnQ0RzbUpzZzZyT0U3S0NWSU95ZWhleWVwZXEyak95ZGhDRHF0N2pyaklEcm9ad2c3Sk8wNjR1a0lPS0draURzZzRnZzZyT0U3S0NWN0plUUlPeUNyT3lhcWV1ZmlleWR0Q0RyZ3Fqc2xZUWc3SjZJN0phMDY0K0VJQ0x0bFp6cmo0UWc3TFNJNnJPOEl1cXdnQW92THlEcXM0VHNobzBnNjRLWTdKaW82NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Eb2dJdXlEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NkdjNnJlNDdKMjQ3WmFJNjRxVTY0MndJT3labkNEcXQ3Z2c2ck9FN0tDVklPeUNyT3lhcWV1ZmlleWRoQ0RycXJzZzdKT3c2NE9RSWlrdUNpOHZJTzJVak91ZnJPcTN1T3lkdU95ZGhDRHFzYkRzdVp3ZzY2R2M2cmU0N0oyNHdyZnJvWnpxdDdqc2xZVHNtNE1vTDI5d1pXNHRiRzluYVc3Q3R5OWpiR0YxWkdVdGJHOW5iM1YwS2V5ZGdDQnJhV3hzVUhKdlkreWN2T3VobkNEc2hManNoWmpzbllRZzY3S0U2NkNrN0lTY0lPeWR0Q0Ryckxqc29KenFzSUFLTHk4ZzdKZUc3SmVJNjRxVTY0MndMQ0Ryc0pic2w1RHNoSndnNjdDVTZyNjQ2Nm0wSU91THBPdW1yT3F3Z0NEc2xZd2c2N0NwNjdLVjdKMjBJT3lYaHV5WGlPdUxwQzRnNnJlNDY1Nlk3SVNjSUM5b1pXRnNkR2dnN0tHdzdacU02NmVJNjR1a0lPMk1qT3lkdk95ZG1DRHFzNFRzb0pYcXM3d2c2N21FNnJXUTdaV2M2NHVrTGdvdkx5RHJ1WVRzbXFrZ01DanRqSXpzbmJ6cnA0d2c3SjI5NnJPZ0xDQmpiR0YxWkdWQlkyTnZkVzUwN0oyWUlETXc3TFNJSU95NmtPeUxuT3VsdkNEcXQ3anJqSURyb1p3ZzdKTzA2NHVrSU9LQWxDQXVZMnhoZFdSbExtcHpiMjdzbmJRZzdMdWs3SVNjSU91bnBPdXlpQ0RzbmIzc3A0QWc3SldLNjRxVTY0dWtLUzRLTHk4ZzZyT0U3S0NWSU95ZWlPeWRqQ0RpaHBJZzdKZUc3SjJNS091aG5PcTN1T3lWaE95Ymd5a2c2N0NwN1phbDdKMkFJT3F4dE91VG5PdW1yT3luZ0NEc2xZcnJpcFRyaTZRNklPMk1qT3lkdk95ZGhDRHJqYTdzbHJUc2s3RHJpcFFnN0lpYzZyQ0VJT3llb09xNWtDRHJxcnNnN0oyOTY0cVVJT3F5ZytxenZBb3ZMeURxdGF6cnRvVHJrSmpzcDRBZzdKV0s3SldFSU8yWG15RHNucXpzaTV6c25wSHNuWVFnNjdhQTY2VzA2ck9nTENEcXQ3Z2c2N0NwN1phbDdKMkFJT3lkdU95bW5TRHNtS1RycFpnZzZySzk2NkdjS0dselFYVjBhRVZ5Y205eUtlcXdnQ0RzbmJUcnI3Z2c3TEtZNjZhczdaV2M2NHVrTGdwbWRXNWpkR2x2YmlCeVpYTjBZWEowU1daQlkyTnZkVzUwUTJoaGJtZGxaQ2dwSUhzS0lDQnBaaUFvSVhCeWIyTWdmSHdnZDJGcGRHVnlLU0J5WlhSMWNtNDdJQ0FnSUNBZ0lDQWdMeThnN0lTNDdJV1lJT3lYaHV5ZGpDanJpNlRzbll3ZzdZUzA3SjIwSU95RGlPdWhuQ0RzaTV6cmo1a3BJQzhnN1lTMElPeW5oTzJXaVNEc3BKSHNuYlRycWJRZzY0dWs3SjJNSU95aHNPMmFqT3lYa095RW5Bb2dJR052Ym5OMElHNXZkeUE5SUdOc1lYVmtaVUZqWTI5MWJuUW9LVHNLSUNCcFppQW9JVzV2ZHlCOGZDQnViM2NnUFQwOUlITmxjM05wYjI1QlkyTnZkVzUwS1NCeVpYUjFjbTQ3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3F6aE95Z2xleWR0Q0Ryc0pUcmdJenNsNGpzbHJUc21wUWdLQ2NnS3lBb2MyVnpjMmx2YmtGalkyOTFiblFnZkh3Z0oreVhodXlkakNjcElDc2dKeURpaHBJZ0p5QXJJRzV2ZHlBcklDY3BJT0tBbENEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJzb1RycHF6cXM2QWc3SU9JSU9xemhPeWdsZXljdk91aG5DRHJpNlRzaTV3ZzdJdWM3SjZSN1pXcDY0dUk2NHVrTGljcE93b2dJQzh2SU95ZG1PdVBoT3lnZ1NEc29vWHJvNHdvY21WaGMyOXVJT3luZ095Z2xTa2c0b0NVSUZORlUxTkpUMDVmUkVsRlJPdWhuQ0RyZ1ozcmdyVHJxYlFnN0o2UTY0K1pJT3llck95TG5PdVBoT3F3Z0NEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcnByRHJpNlFLSUNCcmFXeHNVSEp2WXlnbjZyT0U3S0NWN0oyMElPdXdsT3VBak95V3RPeUVuQ0RzaExqc2haanNuWVFnN0lPSTY2R2NJT3lMbk95ZWtlMldpT3lXdE95YWxDRGlnSlFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1SnlrN0NpQWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ2JuVnNiRHNnTHk4ZzdaV2M2NCtFd3Jmcm9aenF0N2pzbmJnZzdJT0I3WU9jNjRxVUlPcXpoT3lnbGV1bmlPdUxwQ0RyaTZUcnBiVHJpNlFnNG9DVUlPeURpQ0RxczRUc29KWHNuTHpyb1p3ZzY0dWs3SXVjSU8yTWtPeWdsZTJWbU9xeWpBb2dJSE5sYzNOcGIyNUJZMk52ZFc1MElEMGdibTkzT3dwOUNncHNaWFFnYkdGemRFRjFkR2hTWlhSeWVVRjBJRDBnTURzS1puVnVZM1JwYjI0Z2NtVjBjbmxCZFhSb1NXWk9aV1ZrWldRb0tTQjdDaUFnYVdZZ0tHTnNZWFZrWlZOMFlYUjFjeUFoUFQwZ0oyTnNZWFZrWlMxc2IyZHZkWFFuSUNZbUlHTnNZWFZrWlZOMFlYUjFjeUFoUFQwZ0oyTnNZWFZrWlMxc2FXMXBkQ2NwSUhKbGRIVnlianNLSUNCcFppQW9kMkZwZEdWeUlIeDhJRVJoZEdVdWJtOTNLQ2tnTFNCc1lYTjBRWFYwYUZKbGRISjVRWFFnUENBek1EQXdNQ2tnY21WMGRYSnVPeUF2THlEc3A0VHRsb2tnN0tTUklPMkV0Q0Ryc0tudGxiUWc2cmlJN0tlQUlDc2dNekRzdElnZzZyQ0U2cktwQ2lBZ2JHRnpkRUYxZEdoU1pYUnllVUYwSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2R2M2cmU0N0oyNElPeWVyTzJabGV5ZHVDRHNpNXpyajRUaWdLWW5LVHNLSUNCeWRXNVVkWEp1S0NncElEMCtJQ2Zyb1p6cXQ3anNuYmdnN1ptVjdKMjQ3SnFwN0oyMDY0dWtMaUFpVDBzaTY1Mjg2ck9nNjZlTUlPdUx0ZTJWbU91ZHZDNG5LUzUwYUdWdUtBb2dJQ0FnS0NrZ1BUNGdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEdG1aWHNuYmpya0tnZzRvQ1VJT3lnbGV5RGdTRHNnNEh0ZzV6cm9ad2c2N08xNnJlQUxpY3BMQW9nSUNBZ0tHVXBJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNsWVRzcDRFZzY2R2M2cmU0N0oyNElPeVZpQ0Rya0tnNkp5d2dVM1J5YVc1bktHVXViV1Z6YzJGblpTa3VjMnhwWTJVb01Dd2dPREFwS1FvZ0lDazdDbjBLQ2k4dklPeUxwTzJNcUNEc25aSHJpN1hzbllRZzdJS3M2NTZNN0pxcElPeVZpT3VDdE91aG5DRHJzNER0bVpnZzRvQ1VJT3lia095ZHVDanJvWnpxdDdqc25iZ3Y3SVNrN0xtWUtleWR0Q0R0akl6c2xZWHJrSndnNnJLOTdKcXc3SmVVSU9xM3VDRHNsWWpyZ3JUcnBid3NJT3lWaE91TGlPdXB0Q0Rzb0pIcmtaRHNsclFyN0p1UTY2eTQ3SjJFSU91enRPdUN1T3VMcEFwbWRXNWpkR2x2YmlCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUhCeVpXWnBlQ2tnZXdvZ0lHbG1JQ2hsSUNZbUlHVXViV1Z6YzJGblpTQTlQVDBnVEU5SFNVNWZSMVZKUkVVcElISmxkSFZ5YmlCN0lHVnljbTl5T2lCTVQwZEpUbDlIVlVsRVJTd2djSEp2WW14bGJUb2dKMk5zWVhWa1pTMXNiMmR2ZFhRbklIMDdDaUFnYVdZZ0tHVWdKaVlnWlM1dFpYTnpZV2RsSUQwOVBTQk1TVTFKVkY5SFZVbEVSU2tnY21WMGRYSnVJSHNnWlhKeWIzSTZJRXhKVFVsVVgwZFZTVVJGTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFd4cGJXbDBKeUI5T3dvZ0lHbG1JQ2hqYkdGMVpHVlRkR0YwZFhNZ1BUMDlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y3BJSHNLSUNBZ0lISmxkSFZ5YmlCN0lHVnljbTl5T2lBbjdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmxLR05zWVhWa1pTbnFzSUFnN0lTazdMbVk2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFFnNG9DVUlPeUVwT3k1bU8yVm1PcXpvQ0Ryb1p6cXQ3anNuYmp0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMaWNzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNnZlRzS0lDQjlDaUFnY21WMGRYSnVJSHNnWlhKeWIzSTZJSEJ5WldacGVDQXJJQ2hsSUNZbUlHVXViV1Z6YzJGblpTQS9JR1V1YldWemMyRm5aU0E2SUZOMGNtbHVaeWhsS1NrZ2ZUc0tmUW9LWm5WdVkzUnBiMjRnY21WaFpFSnZaSGtvY21WeEtTQjdDaUFnY21WMGRYSnVJRzVsZHlCUWNtOXRhWE5sS0NoeVpYTnZiSFpsS1NBOVBpQjdDaUFnSUNCc1pYUWdZbTlrZVNBOUlDY25Pd29nSUNBZ2NtVnhMbTl1S0Nka1lYUmhKeXdnS0dNcElEMCtJSHNnWW05a2VTQXJQU0JqT3lCOUtUc0tJQ0FnSUhKbGNTNXZiaWduWlc1a0p5d2dLQ2tnUFQ0Z2V3b2dJQ0FnSUNCMGNua2dleUJ5WlhOdmJIWmxLRXBUVDA0dWNHRnljMlVvWW05a2VTa3BPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QnlaWE52YkhabEtIdDlLVHNnZlFvZ0lDQWdmU2s3Q2lBZ2ZTazdDbjBLQ21OdmJuTjBJRU5QVWxOZlNFVkJSRVZTVXlBOUlIc0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MU5aWFJvYjJSekp6b2dKMGRGVkN3Z1VFOVRWQ3dnVDFCVVNVOU9VeWNzQ2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVWhsWVdSbGNuTW5PaUFuUTI5dWRHVnVkQzFVZVhCbEp5d0tmVHNLWm5WdVkzUnBiMjRnYW5OdmJpaHlaWE1zSUhOMFlYUjFjeXdnYjJKcUtTQjdDaUFnY21WekxuZHlhWFJsU0dWaFpDaHpkR0YwZFhNc0lFOWlhbVZqZEM1aGMzTnBaMjRvZXlBblEyOXVkR1Z1ZEMxVWVYQmxKem9nSjJGd2NHeHBZMkYwYVc5dUwycHpiMjQ3SUdOb1lYSnpaWFE5ZFhSbUxUZ25JSDBzSUVOUFVsTmZTRVZCUkVWU1V5a3BPd29nSUhKbGN5NWxibVFvU2xOUFRpNXpkSEpwYm1kcFpua29iMkpxS1NrN0NuMEtDbU52Ym5OMElITmxjblpsY2lBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtHRnplVzVqSUNoeVpYRXNJSEpsY3lrZ1BUNGdld29nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjBkRlZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OW9aV0ZzZEdnbktTQjdDaUFnSUNCeVpYTjBZWEowU1daQlkyTnZkVzUwUTJoaGJtZGxaQ2dwT3lBdkx5RHJzSmJzbDVEc2hKd2c2ck9FN0tDVjdKMkVJT3V3bE9xL3FPeWN2T3VwdENEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZGhDRHJxTHpzb0lBZzY3S0U2NmF3NjR1a0lDanNsWVRybnBnZzdKdU02N0NON0plRjdKMjBJT3lZbXlEcXM0VHNvSlhzbkx6cm9ad2c2NCtNN0tlQUlPeVZpdXF5akNrS0lDQWdJSEpsZEhKNVFYVjBhRWxtVG1WbFpHVmtLQ2s3SUM4dklPdWhuT3EzdU95ZHVDRHRsWVRzbXBRZzdJT0I3WU9jNjZtMElPeWVyTzJabGV5ZHVDRHNpNXpyajRRZzRvQ1VJT3llck91aG5PcTN1T3lkdU95ZHRDRHJnWjNyZ3F6c25MenJxYlFnNjR1azdKMk1JT3loc08yYWpPdTJnTzJFc0NCd2NtOWliR1Z0N0oyMElPMlNnT3Vtc091THBBb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc0tJQ0FnSUNBZ2IyczZJSFJ5ZFdVc0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjc0lIWTZJRUpTU1VSSFJWOVdMQ0JrYVhJNklGOWZaR2x5Ym1GdFpTd2dMeThnZHNLM1pHbHlPaURxdGF6cnNvVHNvSVF2N0plSjY1cXg3WldjSU95Q3JPdXp1T3lkdENEcmxxQWc3SjZJNjRxVTdLZUFJT3luaE91THFPeWFxUW9nSUNBZ0lDQnRiMlJsYkRvZ1kzVnljbVZ1ZEUxdlpHVnNMQ0J0YjJSbGJITTZJRUZNVEU5WFJVUmZUVTlFUlV4VExDQmxlR0Z0Y0d4bGN6b2dSVmhCVFZCTVJWTXViR1Z1WjNSb0xDQm5kV2xrWlRvZ1IxVkpSRVV1YkdWdVozUm9MQ0J5WldGa2VUb2dkMkZ5YldWa1ZYQXNDaUFnSUNBZ0lIQnliMkpzWlcwNklDaGpiR0YxWkdWVGRHRjBkWE1nUFQwOUlDZHZheWNnZkh3Z1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNCdWRXeHNLU0EvSUc1MWJHd2dPaUJqYkdGMVpHVlRkR0YwZFhNc0NpQWdJQ0FnSUdGalkyOTFiblE2SUdOc1lYVmtaVUZqWTI5MWJuUW9LU3dLSUNBZ0lDQWdjMlZ5ZG1Wa09pQnpkR0YwY3k1elpYSjJaV1FzSUd4aGMzUkJkRG9nYzNSaGRITXViR0Z6ZEVGMExDQnNZWE4wVkdWNGREb2djM1JoZEhNdWJHRnpkRlJsZUhRc0lHeGhjM1JUWldNNklITjBZWFJ6TG14aGMzUlRaV01zQ2lBZ0lDQjlLVHNLSUNCOUNpQWdMeThnN1pTTTY1K3M2cmU0N0oyNElPeUxyT3llcGV1d2xldVBtU0RpZ0pRZzY0R0s2cml3NjZtMElPeWNoQ0Rxc0pEc2k1d2c3WU9BN0oyMDY2aTQ2ckNBSU91THBPdW1yT3VsdkNEcmdZanJpNlFLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YUdWaGNuUmlaV0YwSnlrZ2V3b2dJQ0FnYkdGemRFSmxZWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ2ZRb2dJQzh2SU91aG5PcTN1T3lkdUNEaWdKUWc3WlNNNjUrczZyZTQ3SjI0N0oyWUlGdnduNStnSU8yQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJnZzdaV0U3SnFVWGNLM1cvQ2ZsSkZkSU91eWhPMkt2T3lkdENEdG1ManN0cHp0bFp6cmk2UXVDaUFnTHk4ZzZyaXc2N080S091NGpPdWR2T3lhc095Z2dDRHNwNEh0bG9rcE9pQmdZMnhoZFdSbElHRjFkR2dnYkc5bmFXNGdMUzFqYkdGMVpHVmhhV0RycGJ3ZzdJaW83SjJBSU8yVWhPdWhuT3lFdU95S3BPdWhuQ0RzaTZUdGxva2c0b0NVSU91cGxPdUp0Q0RzbDRic25iUWc2ck9uN0o2bElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHFzNkFzQ2lBZ0x5OGdJQ0JzYjJOaGJHaHZjM1FnN0lpWTdJdWdJTzJQck8yS3VPdWhuQ0Rxc3JEcXM3enJwYndnN0o2UTY0K1pJT3lJbU91Z3VlMlZuT3VMcENqc2k2VHN1S0U2SU8yWHBPdVRuT3Vtck95S3BPeVhrT3lFbk91UGhDRHJ1SXpybmJ6c21yRHNvSUFnN0plMDY2YThJQ3NnVEVsVFZFVk9JTzJabGV5ZHVDd2dNakF5Tmkwd055a3VDaUFnTHk4Z0lDRHRoTERycjdqcmhKRHNuYlFnN1ptVTY2bTA3SmVRSU95Z2hPMllnQ0RzbFlnZzY1eXM2NHVrTGlEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjQ2NmVNSU8yVm1PdXB0Q0RyZ1owdUNpQWdMeThnN1krMDY3Q3hLTzJFc091dnVPdUVrQ2s2SU95ZWtPdVBtU0RzbVlUcm80enFzSUFnNjZlSjdaNk1JTzJabU9xeXZTanJ1SXpybmJ6c21yRHNvSURxc0lBZ2JHOWpZV3hvYjNOMDdKZVFJT3VxdXlEcmk3L3NsWVFnN0wyVTY1T2M2ckNBSU91enRPeWR0T3VLbENEcXNyM3NtckFwN0plUTdJU2NDaUFnTHk4Z0lDRHJvWnpxdDdqc25iZ2c2NHlBNnJpd0lPeWtrU0Ryc29UdGlyenNuWVFnNjVpUUlPdUloT3VsdE91cHRDd2c3TDJVNjVPYzY2VzhJT3UybWV5WHJPdUVvK3lkaENEc2lKZ2c3SjZJNjRxVUlPMkVzT3V2dU91RWtDRHJzS25zaTUzc25MenJvWndnN0tDRTdabVk3WldjNjR1a0xnb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXZjR1Z1TFd4dloybHVKeWtnZXdvZ0lDQWdZMjl1YzNRZ1ltOWtlU0E5SUdGM1lXbDBJSEpsWVdSQ2IyUjVLSEpsY1NrN0NpQWdJQ0JqYjI1emRDQnpkMmwwWTJoTmIyUmxJRDBnSVNFb1ltOWtlU0FtSmlCaWIyUjVMbk4zYVhSamFFRmpZMjkxYm5RcE95QXZMeURxczRUc29KVWc3S0NFN1ptWUlEMGc3SXVjN1lHczY2YS9JT3l3dmV5Y3ZPdWhuQ0RzbDdUc2xyUWc2ck9FN0tDVjdKMkVJT3F6b091bHZDRHNpSmdnN0o2STZyS01DaUFnSUNCMGNua2dld29nSUNBZ0lDQXZMeUJqYkdGMVpHWHFzSUFnN0plRzdKeTg2Nm0wSU95WHJPcTRzT3lFbkNEcmdZcnJpcFRyaTZRdUlITm9aV3hzT25SeWRXWHJuYndnWTJ4aGRXUmw2ckNBSU95WGh1eVd0T3VQaENEc2hianNuWUFnN0tDVjdJT0JJT3lMcE8yV2lldVB2QW9nSUNBZ0lDQXZMeUJ6Y0dGM2J1eWRtQ0FuWlhKeWIzSW42ckNBSU95VmlDRHJuS2pxczZBc0lPeVlpT3lnaE95WGxDRHF0N2pyaklEcm9ad2diMnM2ZEhKMVpldWx2Q0RyajR6cm9LVHNwS3pyaTZRZzRvQ1VDaUFnSUNBZ0lDOHZJTzJVak91ZnJPcTN1T3lkdU95ZGdDQWk2N2lNNjUyODdKcXc3S0NBNjZXOElPeVh0T3lYaU95V3RPeWFsQ0xybmJ6cXM2QWc3WldZNjRxVTY0MndJT3lMcE95Z25PdWhuT3VLbENEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU91Y3FPdUtsQ0RzZzRIdGc1enFzSUFnNjVDUTY0dWtLT3lMcE95Z25DRHNpNkRxczZBcExnb2dJQ0FnSUNCcFppQW9ZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQW5ZMnhoZFdSbExXMXBjM05wYm1jbktTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNREVzSUhzS0lDQWdJQ0FnSUNBZ0lHVnljbTl5T2lBbjdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95WGh1eVd0T3lhbENEaWdKUWc3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKMjBJT3VRbU91S2xPeW5nQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGljc0NpQWdJQ0FnSUNBZ0lDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXMXBjM05wYm1jbkxBb2dJQ0FnSUNBZ0lIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lDOHZJT3luaE8yV2lTRHNwSkhzbmJqcmpiQWc2NWlRSU91SWpPdWdnT3VMcENEaWdKUWc3SnVRN0xtWjdKMkFJQ0xydUl6cm5ienNtckRzb0lEcm9ad2c2NHVrN0l1Y0lPeVh0T3E0c0NMcmk2UXVJTzJFc091dnVPdUVrT3lkZ0NBcUt1eXd2ZXlkaENEc2xZVHJyTFRxc29Qcmo0UWc2NnE3SU91ZGhPeWJvT3lkaENEcmxZenJwNHdxS2k0S0lDQWdJQ0FnTHk4ZzdKaUk3S0NFN0plVUlDYzJNT3kwaUNEcmhKanFzb3dnNjR5QTZyaXdJT3lra2V5ZHRPdXB0Q0R0aExEcnI3anJoSkFuN0oyMDdKZUk2NHFVNjQyd0xDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKMkVJT3lkdmVxeHNPdUNtQ0RzbnFEcXVaQWc2NVMwSU95ZHZDRHRsWmpyaTZRZzY0dWs3SXVjSU91SWhPdWx1QW9nSUNBZ0lDQXZMeURzb0pYc2c0SHNvSUhzbmJnZzZySzk3SnF3N0plUTY0K0VJR050WkNEc3NMM3NuYlFnN1lxQTdKYTA2NEtZN0ptVTY0dWtLREl3TWpZdE1EZ2c3SXVrN0xpaElPeUxvT3F6b0RvZ0l1MkVzT3V2dU91RWtDRHRtWlRycWJUc25ZQWc3Sm1jSU91V29DRHFzSkhzbnBEcXVMQWlLUzRLSUNBZ0lDQWdMeThnN0oyMDdLQ2NJT3lhc091bXJPcXdnQ0Rzc0wzc25ZUWc3S2VCN0tDUklPeVh0T3F6b0NEc2hMSHFzN1VnN0plczY3YUFLR3h2WjJsdVYybHVaRzkzVDNCbGJtVmtLZXVsdkNEc2xZVHJpNGpxdVl3c0lPeUxuT3F3aE95ZHRDRHNsWVRyaTRqcm5id2c2cmU0SU95Q3JPeUxwT3VobkNEdGpKRHJpNmp0bFp6cmk2UXVDaUFnSUNBZ0lHTnZibk4wSUhOMFlXeGxJRDBnYkc5bmFXNVFjbTlqSUNZbUlDRnNiMmRwYmxkcGJtUnZkMDl3Wlc1bFpDQW1KaUFvUkdGMFpTNXViM2NvS1NBdElHeHZaMmx1VTNSaGNuUmxaRUYwSUQ0Z01qQXdNREFwT3dvZ0lDQWdJQ0JwWmlBb2JHOW5hVzVRY205aklDWW1JSE4wWVd4bEtTQjdDaUFnSUNBZ0lDQWdhMmxzYkV4dloybHVVSEp2WXlncE93b2dJQ0FnSUNBZ0lHbG1JQ2doYjNCbGJreHZaMmx1VkdWeWJXbHVZV3dvS1NrZ2V3b2dJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNREVzSUhzZ1pYSnliM0k2SUNmc25iUWdUMVBzbDVEc2hLQWc3SjZRNjQrWjdKeTg2NkdjSU91cXV5RHNsN1RzbHJUc21wUWc0b0NVSU8yRXNPdXZ1T3VFa095WGtPeUVuQ0JqYkdGMVpHVWc3SXVrN1phSklPMmJoQ0F2Ykc5bmFXNGc3WlcwSU95anZPeUV1T3lhbEM0bklIMHBPd29nSUNBZ0lDQWdJSDBLSUNBZ0lDQWdJQ0F2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NS0hKbFlYTnZiaURzcDREc29KVXBJT0tBbENEc3A0VHRsb2tnN0tTUklPMkV0T3lkaENCVFJWTlRTVTlPWDBSSlJVVHJvWndnNjRHZDY0SzA2Nm0wSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRxc0lBZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2YXc2NHVrQ2lBZ0lDQWdJQ0FnYTJsc2JGQnliMk1vSit1aG5PcTN1T3lkdU95ZGhDRHNwNFR0bG9udGxaanJpcFFnN0tTUjdKMjA2NTI4SU95YWxPeXlyZXlkaENEc3BKSHJpNmp0bG9qc2xyVHNtcFFnNG9DVUlPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1SnlrN0NpQWdJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec0tJQ0FnSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjZHYzZyZTQ3SjI0SU8yUHRPdXdzU0RpZ0pRZzdZU3c2Nis0NjRTUUlPdXdxZXlMbmV5Y3ZPdWhuQ0Rzb0lUdG1aZ3VKeWs3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJRzF2WkdVNklDZDBaWEp0YVc1aGJDY2dmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdMeThnNjdDcDZyaUlJT3lMbk95ZWtlMlZuQ0Ryb1p6cXQ3anNuYmpzbmJRZzdJSzA3SldFSU95ZWlPeWN2T3VwdENEc2hwRHJqSURzcDRBZzdKV0s2NHFVNjR1a0lPS0FsQ0Rzbzczc25iVHJxYlFnN0lLczdKcXA3SjZRNnJDQUlPdXp0T3F6b0NEc25vanJpcFFnN1lPdDdKMllJT3k5bk91d3NTRHRqNnp0aXJqcXNJQUtJQ0FnSUNBZ0x5OGc2NHVyN1ppQUlDSnNiMk5oYkdodmMzVHNsNURzaEp3ZzdKZXc2ckt3N0oyRUlPcXhzT3UyZ08yV2lPeUt0ZXVMaU91THBDTHFzSUFnNjV5czY0dWtLREl3TWpZdE1EZ2c3SXVrN0xpaElPeUxvT3F6b0NrdUNpQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdKaVlnUkdGMFpTNXViM2NvS1NBdElHeHZaMmx1VTNSaGNuUmxaRUYwSUR3Z01UVXdNREFwSUhzS0lDQWdJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJT3l3dmV5ZHRDRHNuYlRycjdnZzdKZTA2NkNrSU95ZWlPeVd0T3lhbENEaWdKUWc3SU9JNjZHY0lPeVh0T3luZ0NEc2xZcnFzNkFnNnJlNElPeXd2ZXlkaENEc2s3RHNoTGpzbXBRdUp5azdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHMXZaR1U2SUNkaGJISmxZV1I1TFc5d1pXNG5JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc2dMeThnN0pXZTdJU2dJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqc25iUWc2NHlBNnJpd0lPeWtrZXlkdE91cHRDRHNvSkhxczZBZzdJT0k2NkdjSU95WHNPdUxwQ0FvN0xDOTdKMkVJT3VMcSt5Vm1PcXhzT3VDbUNEcmk2VHNpNXdnNjRpRTY2VzRJT3F5dmV5YXNDa0tJQ0FnSUNBZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnSUNCc2IyZHBibGRwYm1SdmQwOXdaVzVsWkNBOUlHWmhiSE5sT3lBdkx5RHNuYlRyc29nZzdJdWM2NCtFN0oyWUlPeXd2U0RzbDdUcXVMQWc3SVN4NnJPMUlPeVhyT3UyZ0NEaWdKUWc3SldFNjU2WTdKZVE3SVNjSU95RXVPeWF0T3VMcEFvZ0lDQWdJQ0F2THlCQ1VrOVhVMFZTNjRxVUlPcXh0T3VUbk91bXJPeW5nQ0RzbFlycmlwVHJpNlFnNG9DVUlFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3lYdE9xem9DQnNiMk5oYkdodmMzVHJvWndnNnJLdzZyTzg2Nlc4SU95ZWtPdVBtU0RzaUpqcm9MbnRsWnpyaTZRS0lDQWdJQ0FnTHk4Z0tPeWNoQ0FuNjZHYzZyZTQ3SjI0N0oyQUlFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN1Rxc293ZzdaV2M2NHVrSnlEc283enNoSjBnNG9DVUlPcXdnT3Vobk95eGhPdXB0Q0RzdlpUcms1d2c2N2FaN0plczY0U2o2cml3SU8yWmxPdXB0T3lkdENEcm5LenJpNlFwTGdvZ0lDQWdJQ0F2THlBcUt1cXpoT3lnbFNEc29JVHRtWmpzbllBZzdKdTVJT3Vobk9xM3VPeVZoT3liZyt5ZGhDRHJxTHpzb0lBZzdKZXc2NHVrS2lvb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU16RXBPaURydUl6cm5ienNtckRzb0lEc2w1QWc3SVM0N0lXWTdKMjBJT3VDcU95VmhDRHNub2pzbkx6cnFiUUtJQ0FnSUNBZ0x5OGdZWFYwYUc5eWFYcGw2ckNBSU9xemhPeWdsZXlkaENEcnJMdnNwNEFnN0pXSzZyT2dJT3lLdWV5ZHVDRHRtWlRycWJUcnA0d2c2NTJFN0pxMDY0dWtLQ0xzaXJuc25iZ2c3Wm1VNjZtMElPdW5rT3F6b0NEcm9aenF0N2pzbmJnZzdabVU2Nm0wN0p5ODY2R2NJT3F3Z09xem9DRHNpN2JyaTZRaUlPeWFsT3ExckNrdUNpQWdJQ0FnSUM4dklPeUV1T3lGbU95ZGhDRHNwNERzbXJRZzY1S2tJT3lYdE91cHRDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDY3YUE3WVN3SU91Q21PeVlxT3VMcENEaWdKUWdWVkpNN0oyRUlPcXdnT3F6dGUyVm1PeW5nT3VQaENqc3NyVHNuYlRyaTUwZzdJdWs3WXlvS1N3Z1FsSlBWMU5GVXV1bHZDRHFzSURyb1p6c3NZVHNwNERyajRRS0lDQWdJQ0FnTHk4Z0tPeTlsT3VUbkNEcnRwbnNsNnpyaEtQcXVMQWc3SnlnNjdDY0tTd2c2N2lNNjUyODdKcXc3S0NBNjZXOElPcXpvT3VsdE95bmdPdVBoQ2pxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBSU95VmhPdUxtQ2tnN0pXSzY0cVVJT3ljb095ZHZPMlZuQ0Ryc0tucnNwVXVDaUFnSUNBZ0lDOHZJT3UyZ095ZWtleWFxVG9nNjdpTTY1Mjg3SnF3N0tDQTdKMllJR05zWVhWa1pTRHNtN2tnNjZHYzZyZTQ3SjI0NjQrRUlPMlNnT3Vtc091THBDRGlnSlFnNnJPRTdLQ1Y3SjJFSU91d2xPcSt1T3VncE91S2xDRHNuWmpyajRUc21ZQWc2N0NwN1phbDdKMjBJT3F3bWV5VmhDRHNpSmpzbXFrdUNpQWdJQ0FnSUdOdmJuTjBJSE4wWVhKMFRHOW5hVzRnUFNBb0tTQTlQaUI3Q2lBZ0lDQWdJQ0FnWTI5dWMzUWdkR2hwYzB4dloybHVJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuWVhWMGFDY3NJQ2RzYjJkcGJpY3NJQ2N0TFdOc1lYVmtaV0ZwSjEwc0lIc0tJQ0FnSUNBZ0lDQWdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzQ2lBZ0lDQWdJQ0FnSUNCa1pYUmhZMmhsWkRvZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBaFBUMGdKM2RwYmpNeUp5d2dMeThnYTJsc2JFeHZaMmx1VUhKdlkreWRtQ0RxdDdqcm83a2dhMmxzYk95YXFTQW9hMmxzYkZCeWIyUHFzN3dnNjQrWjdKMjhJTzJNcU8yRXRDa0tJQ0FnSUNBZ0lDQjlLVHNLSUNBZ0lDQWdJQ0JzYjJkcGJsQnliMk1nUFNCMGFHbHpURzluYVc0N0NpQWdJQ0FnSUNBZ2JHOW5hVzVYYVc1a2IzZFBjR1Z1WldRZ1BTQjBjblZsT3lBdkx5QkRURW5xc0lBZzdKZXM2NHFVSU9xeHRDRHF0SURzc0xEdGxhQWc3SWlZSU95WGh1eWN2T3VMaUNEc2w3VHJwckFnNnJLRDdKeTg2NkdjSU91enVPdUxwQ0FvN0o2czdZRzA2NmF0N0plUUlPMkVzT3V2dU91RWtDRHJzS25zcDRBcENpQWdJQ0FnSUNBZ2RHaHBjMHh2WjJsdUxtOXVLQ2RsY25KdmNpY3NJQ2dwSUQwK0lIc2dhV1lnS0d4dloybHVVSEp2WXlBOVBUMGdkR2hwYzB4dloybHVLU0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPeUI5S1RzS0lDQWdJQ0FnSUNCMGFHbHpURzluYVc0dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lDQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdJVDA5SUhSb2FYTk1iMmRwYmlrZ2NtVjBkWEp1T3dvZ0lDQWdJQ0FnSUNBZ2JHOW5hVzVRY205aklEMGdiblZzYkRzS0lDQWdJQ0FnSUNBZ0lHbG1JQ2hzYjJkcGJsQnliMk5VYVcxbGNpa2dleUJqYkdWaGNsUnBiV1Z2ZFhRb2JHOW5hVzVRY205alZHbHRaWElwT3lCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUc1MWJHdzdJSDBLSUNBZ0lDQWdJQ0FnSUdGalkyOTFiblJEWVdOb1pTNWhkQ0E5SURBN0lDOHZJT3lEaUNEcXM0VHNvSlhzbmJ3ZzdJaVlJT3llaU95Y3ZPdUxpQ0RyaTZUc25Zd2dMMmhsWVd4MGFDRHJsWXdnNjR1azdJdWNJT3lkdmVxNHNBb2dJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25iZ2c3S0NJN0xDb0lPeWloZXVqakNBb1kyOWtaU0FuSUNzZ1kyOWtaU0FySUNjcEp5azdDaUFnSUNBZ0lDQWdJQ0F2THlEc2dxenJub3pzbmJRZzY2R2M2cmU0N0oyNDdaV2dJT3lMbk9xd2hPdVBoQ0RzbDRic25iUWc2ck9uNjdDVTY2R2NJT3lMcE8yTXFPdWhuQ0RyZ1ozcmdxenJpNlFnUFNCamJHRjFaR1hxc0lBZzdKZUc2ckd3NjRLWUlPeUxwTzJXaWV5ZHRDRHNsWWdnNjVDY0lPcXlneTRLSUNBZ0lDQWdJQ0FnSUM4dklPeWRrZXVMdGV5ZGdDRHNuYlRycjdnZzY3TzA2NE9JN0p5ODY0dUlJT3lEZ2UyRG5PdWx2Q0RyaTZUc2k1d2c3SjZzN0lTY0lDOW9aV0ZzZEdqcm9ad2c3SldNNjZhdzY0dWtJQ2p0bEl6cm42enF0N2pzbmJqc25iUWc2NHlBNnJpd0lPMlpsT3VwdE95ZGhDRHNpNlR0aktqcm9ad2c2N0NVNnI2ODY0dWtLUzRLSUNBZ0lDQWdJQ0FnSUdsbUlDaGpiMlJsSUNFOVBTQXdJQ1ltSUVSaGRHVXVibTkzS0NrZ0xTQnNiMmRwYmxOMFlYSjBaV1JCZENBOElEVXdNREFwSUhzS0lDQWdJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdU95ZHRDRHNwb25zaTV3ZzdJdWs3WXlvNjZHY0lPdUJuZXVDcUNEaWdKUWdRMnhoZFdSbElFTnZaR1VnN0lTazdMbVlJT3lEZ2UyRG5PdWx2Q0RyaTZUc2k1d2c3S0NRNnJLQTdaV3A2NHVJNjR1a0xpY3BPd29nSUNBZ0lDQWdJQ0FnSUNCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BPd29nSUNBZ0lDQWdJQ0FnZlFvZ0lDQWdJQ0FnSUgwcE93b2dJQ0FnSUNBZ0lDOHZJRE13NjdhRUlPS0FsQ0RzbmJRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU95anZleWN2T3VwdENEcnVJenJuYnpzbXJEc29JQWc3TDJjNjdDeDdKMjBJT3F3aUNCc2IyTmhiR2h2YzNRZzdZK3M3WXE0NjQrRUlPdUxxKzJZZ0NBbjdKZXc2ckt3N0oyRUlPcXhzT3UyZ08yV2lPeUt0ZXVMaU91THBDZnFzSUFnNjV5czY0dWtMZ29nSUNBZ0lDQWdJQzh2SU95WWlPeWdoQ0F4TU91MmhPeWRnQ0RzcDZmc2xZVHNoSndzSU91aG5PcTN1T3lkdU8yVm1PdUxwQ0RzbnFEcXVaQWc2NHVrNjZXNElPeWR2T3lkaENEdGxaanJxYlFnN1lPdDdKMjBJT3VzdE8yYXFPcXdnQ0Rya0pEcmk2UW9NakF5Tmkwd09DRHNpNlRzdUtFZzdJdWc2ck9nS1M0S0lDQWdJQ0FnSUNCc2IyZHBibEJ5YjJOVWFXMWxjaUE5SUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnZXlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NkdjNnJlNDdKMjRJRE13NjdhRUlPcXl2ZXF6dkNEaWdKUWc2NHlBNnJpd0lPMlVoT3Vobk95RXVPeUtwQ0Rzb0pYcnBxd3VKeWs3SUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNnZlN3Z01UZ3dNREF3TUNrN0NpQWdJQ0FnSUgwN0NpQWdJQ0FnSUM4dklDb3E2ck9FN0tDVklPeWdoTzJabUNBOUlPdWhuT3EzdU95VmhPeWJneUFySU91NGpPdWR2T3lhc095Z2dPeVhrQ0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTBLaW9nS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRNMkxDRHNncXpzbXFuc25wQWc2ckt3N0tDVktTNEtJQ0FnSUNBZ0x5OGc3SXE1N0oyNElPMlpsT3VwdE95ZHRDRHJuS2pyaXBRZzZyZTg2N080SU95YmtPeWR1T3lkZ0NBaTY3aU02NTI4N0pxdzdLQ0E3SmVRSU95WW15RHFzNFRzb0pYc25iUWc2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPdUxwQ0xyaXBRZzZyS0Q3SjIwNjYrQTY2R2NMQ0Rzb0lUdG1aanNuWmdnN0xLcklPdVBtZXlla2V5ZGdBb2dJQ0FnSUNBdkx5RHJvWnpxdDdqc25ianNuYlFnN0pXRTY0dUk2NTI4SUNvcTY2R2M2cmU0N0pXRTdKdURLaXJzbmJUc2xyVHNsYndnNjZlZTY0dWtMaURxdDdqcm5wanNoSndnN0plczZyaXc3SVNjNjRxVUlPdWhuT3EzdU95ZHVPeWRoQ0RzaTV6c25wSHRsWmpzcDRBZzdKV0s2NHFVNjR1a09nb2dJQ0FnSUNBdkx5QWdJT0tSb0NCRFRFa2c2NkdjNnJlNDdKV0U3SnVES0dOc1lYVmtaU0JoZFhSb0lHeHZaMjkxZENrZzRvQ1VJT3lZbXlEc25wRHFzcW5zcHAzcnFvWEN0K3lFdU95Rm1DRHRqNURxdUxBS0lDQWdJQ0FnTHk4Z0lDRGlrYUVnNjdpTTY1Mjg3SnF3N0tDQUlPeWJ1U0Ryb1p6cXQ3anNsWVRzbTRNZzdKZTA2cml3SU9LQWxDQmpiR0YxWkdVdVlXa3ZiRzluYjNWMDdKMkFJT3Vobk9xM3VPeVZoT3liZ3lEdG00UWdLaXJyb1p6cXQ3anNuYmdnN1ptVTY2bTA3Snk4NjZHY0lPeXdxZXluZ0NvcTdaV2M2NHVrS08yRHJTQXg2ckNjS1FvZ0lDQWdJQ0F2THlEcm9aenF0N2pzbFlUc200UHNuYlFnNjRHZDY0S1k2Nm0wSU9xenArdXdsT3VobkNCRFRFa2c2NkdjNnJlNDdKMjQ2cm1NN0tlQUlPeWR0T3lXdE95RW5DRHNpNXpzbnBIdGxaenJpNlFnNG9DVUlPeUV1T3lGbU95ZHRDRHJ1WVRzbTR6c3A0UWc2NUtrNjUyOElPeUt1ZXlkdUNEdG1aVHJxYlRzbmJRZzdKV0U2NHVJNjUyOENpQWdJQ0FnSUM4dklPdWhuT3EzdU95ZHVDRHRtWlRycWJUc25iUWc2NEtZN0ppbzY0dWtMaUR0Z2JUcnBxMGc3WldjSU91eWlPeWN2T3VobkNBaTY2R2M2cmU0N0pXRTdKdURJT0tHa2lEc2c0Z2c2ck9FN0tDVklPdWhuT3EzdU95ZHVDTHNuYlFnNjRHZDY0S2M2NHVrTGdvZ0lDQWdJQ0JwWmlBb2MzZHBkR05vVFc5a1pTa2dld29nSUNBZ0lDQWdJR3RwYkd4TWIyZHBibEJ5YjJNb0tUc2dMeThnNjR5QTZyaXdJT3lra2V5ZHVDRHNtSnNnNjZHYzZyZTQ3SjI0SU95Z2lPeXdxT3F3Z0NEc25vanNuTHpycWJRZzdLQ1I2NHFVNjR1a0NpQWdJQ0FnSUNBZ1kyOXVjM1FnYkc4Z1BTQnpjR0YzYmlnblkyeGhkV1JsSnl3Z1d5ZGhkWFJvSnl3Z0oyeHZaMjkxZENkZExDQjdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcE93b2dJQ0FnSUNBZ0lHeHZMbTl1S0NkbGNuSnZjaWNzSUNncElEMCtJSHNnTHlvZ1kyeGhkV1JsSU95WGh1eWRqQ0RyazdFZzRvQ1VJT3lWaE91ZW1DRHNtN2tnNjZHYzZyZTQ3SldFN0p1RDdKMkFJT3EzdU91TWdPdWhuQ0RzcDRUdGxva2dLaThnZlNrN0NpQWdJQ0FnSUNBZ0x5OGdLaXJ0ZzYzc25ZQWc2N0NZNjVPYzdJdWNJREhxc0p3cUtpQW9NakF5Tmkwd09Dd2dRbEpKUkVkRlgxWTlOREFzSU95Q3JPeWFxZXlla0NEc21wVHF0YXdwT2lEc203a2c2NkdjNnJlNDdKV0U3SnVESU95anZPeUdqT3VsdkNEcmxMRHJvWndnN0plMDY2bTBDaUFnSUNBZ0lDQWdMeThnNjZHYzZyZTQ3SjI0SU8yWmxPdXB0T3lkdENEcmtaQWc2ckNjS091aG5PcTN1T3lWaE95Ymd5RHNzS25zcDRBZzdabVU2Nm0wSUNzZ1QwRjFkR2dnN1ptVTY2bTBLU0RybHFEc2hKd2c3SmEwNjRxUUlPeXF2ZXlYa0NEcm9aenF0N2pzbmJqdGxiVHNsYndnN1pXWTY0cVU3S2VBSU95VmpDRHNpSmdnN0plRzZyT2dMQW9nSUNBZ0lDQWdJQzh2SU95WGlldWFzZTJWbkNEc3FyM3NsNUFnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJTzJVak91ZnJPcTN1T3lkdU95ZGdDRHNsN0Rxc3JEcmtKanNwNEFnN0pXSzY0cVU2NHVrS095THBPeTRvU0RzaTZEcXM2QWdNdTJhakRvZ0l1eVpuQ0Rya1pBZzZyQ2M2NEtZSU91V29DSXNJQ0xyb1p6cXQ3anNuYmp0bG9qcmlwVHJqYkFnN0ptY0lpa3VDaUFnSUNBZ0lDQWdMeThnNnJlNDY1Nlk3SVNjSU95YnVTRHJvWnpxdDdqc2xZVHNtNFBzbllBZzdKZTA3S2VBSU95Vml1dUtsT3VMcENEaWdKUWdRMHhKSU91aG5PcTN1T3lWaE95YmcrdW5qQ0R0bFpqcXM2QWc2NkdjNnJlNDdKMjRJT3l3dlNEdGxaanJncGpycDR3ZzY1MkU3SnEwNjR1a0xnb2dJQ0FnSUNBZ0lDOHZJQ0Fnd3JjZzY3aU02NTI4N0pxdzdLQ0E2ckNBSU91aG5PcTN1T3lWaE95YmcrdVB2Q0Rzbm9qc25MenJxYlFnNG9hU0lPdWhuT3EzdU95ZHVDRHRtWlRycWJUc25iUWc2N0NVNjZHY0lPdUNtT3lZcU91THBBb2dJQ0FnSUNBZ0lDOHZJQ0Fnd3JjZzY3aU02NTI4N0pxdzdLQ0E3SmVRSU95RXVPeUZtT3lkdENEcmdxanNsWVFnN0o2STdKeTg2Nm0wSU9LR2tpRHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPdUNtT3lZcU91THBDNGc2cmU0SU8yWmxPdXB0Q0R0bFpqcmk2Z2dXK3F6aE95Z2xTRHNvSVR0bVpoZDdKeTg2NkdjSU9xemhPeWdsZXlkaENEcXM2RHJwYmpyaTZRS0lDQWdJQ0FnSUNBdkx5QWdJQ0FnS095S3VleWR1Q0R0bVpUcnFiVHNuWVFnNnJHMDY0U0k2NXV3NjZDazY2bTBJT3U0ak91ZHZPeWFzT3lnZ095WGtPeUVuQ0JqYkdGMVpHVWc2NkdjNnJlNDdKV0U3SnVEN0oyRUlPdW92T3lnZ0NEdGxiVHNsYndnN1pXWTY0cVU2NDJ3TENEcXQ3anFzYlFnN1lPdDdKMjBJTzJWbU91Q21DRHJqWlFnN1pXRTdKcVU3WldZNjR1a0tRb2dJQ0FnSUNBZ0lDOHZJT3Vobk9xM3VPeWR1T3lkZ0NBcUt1dWhuT3EzdU95VmhPeWJnK3lkdENEcmdaM3JncHdnNjVLa0tpb2c3SXVjN0o2UjdaV2M2NHVrSU9LQWxDRHJxTHpzb0lBZzY1MkU3SnF3NjZtMElPdWhuT3EzdU95VmhPeWJnK3lkdENEc2c0Z2c3SjZRNnJLcDdLYWQ2NnFGN0oyRUlPeW5nT3lhdUNEc2lKZ2c3SjZJNjR1a0xnb2dJQ0FnSUNBZ0lHeHZMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0FnSUNBZ0lDQnJhV3hzVUhKdll5Z242ck9FN0tDVjdKMkVJT3V3bE9xK3VPdWdwT3F6b0NEcm9aenF0N2pzbFlUc200UHRsYlRzaEp3ZzdKcVU3TEt0N0oyRUlPeWtrZXVMcU8yV2lPeVd0T3lhbEM0bktUc2dMeThnN0oyWTY0K0U3S0NCSU95aWhldWpqQ0FvN0o2UTY0K1pJT3llck95TG5PdVBoQ0Ryc0tuc3A0QXBDaUFnSUNBZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQU0F3T3lBdkx5RHJpNlRzbll3ZzdLR3c3WnFNN0plUTdJU2NJQ2ZxczRUc29KVWc3SmVHN0oyTUoreWN2T3VobkNEc25iM3Rub2pxc293S0lDQWdJQ0FnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUc1MWJHdzdJQzh2SU95RGdlMkRuQ0RzbnF6dGpKRHNvSlVLSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDQkRURWtnNjZHYzZyZTQ3SldFN0p1RElDaGpiMlJsSUNjZ0t5QmpiMlJsSUNzZ0p5a2c0b2FTSU91aG5PcTN1T3lkdUNEc3NMM3NuWVFnN0plOTY0dUk2NHVrTGljcE93b2dJQ0FnSUNBZ0lDQWdhV1lnS0NGc2IyZHBibEJ5YjJNcElITjBZWEowVEc5bmFXNG9LVHNLSUNBZ0lDQWdJQ0I5S1RzS0lDQWdJQ0FnSUNCc2IyZHBibE4wWVhKMFpXUkJkQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUcxdlpHVTZJQ2RpY205M2MyVnlMWE4zYVhSamFDY2dmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdMeThnNjZlTTY2T01JT3llck91aG5PcTN1T3lkdUNEaWdKUWc2ckNaN0oyQUlPcXpoT3lnbGV5ZHRPdWR2Q0RzaExqc2haanNuWVFnN0tlQTdKcXc3S2VBSU95Vml1cXpvQ0RxdDdqcmpJRHJvWndnN0pldzY0dWtLT3U1b091bHRPdUxwQ2tLSUNBZ0lDQWdjM1JoY25STWIyZHBiaWdwT3dvZ0lDQWdJQ0F2THlEcmdxSHNuWUFnN0o2RjdKNmw2cmFNN0oyRUlPdXN2T3F6b0NEc25vanJpcFFnNjR5QTZyaXdJT3lFdU95Rm1PeWRnQ0Ryc29UcnByRHJpNlFnNG9DVUlPeWVyT3Vobk9xM3VPeWR1Q0R0bTRRZzY0dWs3SjJNSU95YWxPeXlyZXlkdENEc2c0Z2c3SVM0N0lXWUtPeURpQ0Rzbm9Yc25xWHF0b3dwN0p5ODY2R2NJT3lMbk95ZWtlMlZtT3F5akM0S0lDQWdJQ0FnTHk4ZzdKMlk2NCtFN0tDQklPeWloZXVqakNoeVpXRnpiMjRnN0tlQTdLQ1ZLU0RpZ0pRZ1UwVlRVMGxQVGw5RVNVVkU2NkdjSU91Qm5ldUN0T3VwdENEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdWdwQW9nSUNBZ0lDQXZMeURzbnF6cm9aenF0N2pzbmJnZzY1S2s3SmVRNjQrRUlFMUJXRjlVVlZKT1UrcTVqT3luZ0NEc21Kc2c2ck9FN0tDVjdKeTg2NkdjSU95eW1PdW1yT3VRbU91S2xDRHJzb1RxdDdqcXNJQWc2NUNjNjR1a0lDZ3lNREkyTFRBM0lPdW1yT3Uzc095WGtPeUVuQ0R0bVpYc25iZ3BDaUFnSUNBZ0lHdHBiR3hRY205aktDZnJvWnpxdDdqc25ianNuWVFnN0tlRTdaYUo3WldZNjRxVUlPeWtrZXlkdE91ZHZDRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bzdaYUk3SmEwN0pxVUlPS0FsQ0Ryb1p6cXQ3anNuYmdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3BPd29nSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFbklDc2dLSE4zYVhSamFFMXZaR1VnUHlBbklDanFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDRHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPdWNxT3VwdENEcXQ3Z2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjNzbkx6cm9ad2c2NHVrNjZXNElPcXpoT3lnbGV5ZGhDRHFzNkRycGJ3ZzdJaVlJT3llaU95V3RPeWFsQ2tuSURvZ0p5Y3BJQ3NnSnlEaWdKUWc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeWVrT3VQbVNEc2w3RHFzckRya0tucmk0anJpNlF1SnlrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQnpkMmwwWTJoTmIyUmxJRDhnSjJKeWIzZHpaWEl0YzNkcGRHTm9KeUE2SUNkaWNtOTNjMlZ5SnlCOUtUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1EQXNJSHNnWlhKeWIzSTZJQ2Zyb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3VxdXlEc2w3VHNsNGpzbHJUc21wUTZJQ2NnS3lCbExtMWxjM05oWjJVZ2ZTazdDaUFnSUNCOUNpQWdmUW9nSUM4dklDanRoTERycjdqcmhKQWc3WSswNjdDeElPcTFyTzJZaE91MmdDRGlnSlFnNjdpTTY1Mjg3SnF3N0tDQUlPeWVrT3VQbVNEc21ZVHJvNHpxc0lBZzdKV0lJT3VRbU91S2xDRHRtWmpxc3IwZzdLQ0U3SnFwS1FvZ0lHWjFibU4wYVc5dUlHOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa2dld29nSUNBZ2V3b2dJQ0FnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdJQ0FnSUM4dklITjBZWEowNnJDQUlPeURpQ0Rzdlpqc2hwUWc3TEM5N0oyRUlPdW5qT3VUb091THBDQW82NHVrNjZhczdKMllJT3lJcU95ZGdDRHN2WmpzaHBUcXM3d2c2NnkwNnJTQTdaV1k2cktNSU95Q3JPeWFxZXlla095WGtPcXlqQ0RyczdUc25vUXBMZ29nSUNBZ0lDQWdJQzh2SU95ZHRPeVd0T3lFbkNCUWIzZGxjbE5vWld4c0tDNXdjekVwN0oyMElEWHN0SWdnNjVLa0lPcTN1Q0Rzc0wzc2w1QWc3SmVVN1lTdzY2VzhJT3V6dE91Q3RDQXg2N0tJS09xMXJPdVBoU0RxczRUc29KVXA3SjJFSU95ZWtPdVBtU0RzaEtEdGc1M3RsWmpxczZBc0NpQWdJQ0FnSUNBZ0x5OGc3TEM5N0oyRUlPeTFuT3lHak8yWmxPMlZ0Q0RzZ3F6c21xbnNucEFnNjRpSTdKZVVJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqcnA0d2c2NEtvNnJLTUlPMlZuT3VMcEM0ZzdMQzk3SjJFSU91cXV5RHNzTDdzbkx6cnFiUWc3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHRsWnpyaTZRS0lDQWdJQ0FnSUNBdkx5QW82NHVrNjZXNElPeXd2U0RzbUtUc25vWHJvS1VnNjdDcDdLZUFJT0tBbENEcXQ3Z2c2cks5N0pxd0lPdXBsT3VKdE9xd2dDRHJzN1RzbmJUcmlwUWc3TEdFNjZHY0lPdUNxT3F6b0NEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFxQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdLTzg3SjJZT2lCamJHRjFaR1hxc0lBZzdMMlk3SWFVSU95Z25PdXFxZXlkaENEcnNKVHF2cmpycWJRZ1FYQndRV04wYVhaaGRHVXZSbWx1WkZkcGJtUnZkK3F3Z0NEcnFyc2c3TEMrN0oyRUlPeUltQ0Rzbm9qc25Zd2c0b0NVSU95Y2lPdVBoT3lhc0NEc2k2VHF1TERzbDVEc2hKd2c3Wm1WN0oyNElPMlZoT3lhbEM0S0lDQWdJQ0FnSUNCamIyNXpkQ0J3Y3pFZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV3h2WjJsdUxuQnpNU2NwT3dvZ0lDQWdJQ0FnSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vY0hNeExDQmJDaUFnSUNBZ0lDQWdJQ0FuVTNSaGNuUXRVMnhsWlhBZ0xWTmxZMjl1WkhNZ05TY3NDaUFnSUNBZ0lDQWdJQ0FuSkhkeklEMGdUbVYzTFU5aWFtVmpkQ0F0UTI5dFQySnFaV04wSUZkVFkzSnBjSFF1VTJobGJHd25MQW9nSUNBZ0lDQWdJQ0FnSW1sbUlDZ2tkM011UVhCd1FXTjBhWFpoZEdVb0oyTnNZWFZrWlMxc2IyZHBiaWNwS1NCN0lpd0tJQ0FnSUNBZ0lDQWdJQ0lnSUNSM2N5NVRaVzVrUzJWNWN5Z25maWNwSWl3S0lDQWdJQ0FnSUNBZ0lDY2dJRk4wWVhKMExWTnNaV1Z3SUMxVFpXTnZibVJ6SURJbkxBb2dJQ0FnSUNBZ0lDQWdJaUFnUVdSa0xWUjVjR1VnTFU1aGJXVnpjR0ZqWlNCVklDMU9ZVzFsSUZjZ0xVMWxiV0psY2tSbFptbHVhWFJwYjI0Z0oxdEViR3hKYlhCdmNuUW9YQ0oxYzJWeU16SXVaR3hzWENJcFhTQndkV0pzYVdNZ2MzUmhkR2xqSUdWNGRHVnliaUJUZVhOMFpXMHVTVzUwVUhSeUlFWnBibVJYYVc1a2IzY29jM1J5YVc1bklHTXNJSE4wY21sdVp5QjBLVHNnVzBSc2JFbHRjRzl5ZENoY0luVnpaWEl6TWk1a2JHeGNJaWxkSUhCMVlteHBZeUJ6ZEdGMGFXTWdaWGgwWlhKdUlHSnZiMndnVTJodmQxZHBibVJ2ZHloVGVYTjBaVzB1U1c1MFVIUnlJR2dzSUdsdWRDQnVLVHNuSWl3S0lDQWdJQ0FnSUNBZ0lDSWdJQ1JvSUQwZ1cxVXVWMTA2T2tacGJtUlhhVzVrYjNjb1cwNTFiR3hUZEhKcGJtZGRPanBXWVd4MVpTd2dKMk5zWVhWa1pTMXNiMmRwYmljcElpd0tJQ0FnSUNBZ0lDQWdJQ2NnSUdsbUlDZ2thQ0F0Ym1VZ1cxTjVjM1JsYlM1SmJuUlFkSEpkT2pwYVpYSnZLU0I3SUZ0MmIybGtYVnRWTGxkZE9qcFRhRzkzVjJsdVpHOTNLQ1JvTENBMktTQjlKeXdnTHk4Z05pQTlJRk5YWDAxSlRrbE5TVnBGQ2lBZ0lDQWdJQ0FnSUNBbmZTY3NDaUFnSUNBZ0lDQWdYUzVxYjJsdUtDZGNjbHh1SnlrZ0t5QW5YSEpjYmljcE93b2dJQ0FnSUNBZ0lHTnZibk4wSUdKaGRDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ykc5bmFXNHVZbUYwSnlrN0NpQWdJQ0FnSUNBZ1puTXVkM0pwZEdWR2FXeGxVM2x1WXloaVlYUXNJQ2RBWldOb2J5QnZabVpjY2x4dUp5QXJDaUFnSUNBZ0lDQWdJQ0FuYzNSaGNuUWdJbU5zWVhWa1pTMXNiMmRwYmlJZ1kyMWtJQzlySUdOc1lYVmtaU0F2Ykc5bmFXNWNjbHh1SnlBckNpQWdJQ0FnSUNBZ0lDQW5jRzkzWlhKemFHVnNiQ0F0VG05UWNtOW1hV3hsSUMxRmVHVmpkWFJwYjI1UWIyeHBZM2tnUW5sd1lYTnpJQzFHYVd4bElDSW5JQ3NnY0hNeElDc2dKeUpjY2x4dUp5azdDaUFnSUNBZ0lDQWdjM0JoZDI0b0oyTnRaQ2NzSUZzbkwyTW5MQ0JpWVhSZExDQjdJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2djM1JrYVc4NklDZHBaMjV2Y21VbkxDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNLSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBblpHRnlkMmx1SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSEIwZVNobGVIQmxZM1FwNjZHY0lPdXp0T3VDdUNEdGdxVHNsNUFnN1lHMDY2R2M2NU9jSUZSVlNlcXdnQ0RyckxUcnNKanNuWkhzbmJnZzZyS0Q3SjIwSU95THBPeTRvU0R0bVpYc25ianJrS2dvTWpBeU5pMHdOeXdnN0oyODY3Q1lJRnh5d3JkcmFYUjBlU0RzdlpUcms1d2c2NnFvNjVHUUtTRGlnSlFLSUNBZ0lDQWdJQ0F2THlEc25LRHNuYnp0bFp3ZzdKNlE2NCtaN1ptVUlPcXl2ZXVobk91S2xDQlRlWE4wWlcwZ1JYWmxiblJ6N0oyWUlPeW5oT3lubkNEdGdxUWc3SjZGNjZDbExpRHNvSkhxdDd6c2hMRWc2cmFNN1pXYzdKMjBJT3llaU95Y3ZPdXB0Q0EyN0xTSUlPdVNwQ0RzbDVUdGhMRHFzSUFnN0o2UTY0K1pJT3llaGV1Z3BldVB2QW9nSUNBZ0lDQWdJQzh2SURIcnNvZ282cldzNjQrRklPcXpoT3lnbFNuc25iUWc3SVNnN1lPZDY1Q1k2ck9nTENEcXRvenRsWnpzbmJRZzdKZUc3Snk4NjZtMElHdGxlWE4wY205clpTRHNwSVRycDR3ZzdLR3c3SnFwN1o2SUlPeUxwTzJNcU8yVnRDRHNncXpzbXFuc25wRHFzSUFnN0plVTdZU3dJTzJWbkNEcnNvZ2c2NGlFNjZXMDY2bTBJT3VRbk91THBDaG1ZV2xzTFhOdlpuUXBMZ29nSUNBZ0lDQWdJQzh2SU95WGxPMkVzQ0RzcDRIc29JVHNsNUFnVkdWeWJXbHVZV3pzbllRZzY0dWs3SXVjSU95Vm51eWN2T3VobkNEcXNJRHNvTGpzbVlBZzY0dWs2Nlc0SU95VnNleVhrQ0R0Z3FUcXNJQWc2NU9rN0phMDZyQ0E2NHFVSU9xeWcreWRoQ0RycDRucmlwVHJpNlF1Q2lBZ0lDQWdJQ0FnYzNCaGQyNG9KMjl6WVhOamNtbHdkQ2NzSUZzS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdaRzhnYzJOeWFYQjBJQ0pqYkdGMVpHVWdMMnh2WjJsdUlpY3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlWR1Z5YldsdVlXd2lJSFJ2SUdGamRHbDJZWFJsSnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0EySnl3S0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNkMFpXeHNJR0Z3Y0d4cFkyRjBhVzl1SUNKVVpYSnRhVzVoYkNJZ2RHOGdZV04wYVhaaGRHVW5MQW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlEQXVNeWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVTNsemRHVnRJRVYyWlc1MGN5SWdkRzhnYTJWNWMzUnliMnRsSUhKbGRIVnliaWNzQ2lBZ0lDQWdJQ0FnSUNBdkx5RHNsNVR0aExEcXNJQWc3SXVrN0tDYzY2R2NJT3VUcE95V3RPcXdoQ0Rxc3Izc21yRHNsNURycDR3ZzdKZXM2cml3SU91UGhPdUxyQ2pxdG96dGxad2c3SmVHN0p5ODY2bTBJT3ljaE95WGtPeUVuQ0RzcEpIcmk2Z3BJT0tBbENEdGhMRHJyN2pyaEpEc25ZUWc3TG1ZN0p1TUlPdTRqT3Vkdk95YXNPeWdnT3VuakNEcmdxanF1TFRyaTZRS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0F4TGpVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJ6WlhRZ2JXbHVhV0YwZFhKcGVtVmtJRzltSUdaeWIyNTBJSGRwYm1SdmR5QjBieUIwY25WbEp5d0tJQ0FnSUNBZ0lDQmRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdabUZzYzJVN0lDOHZJT3luZ095YmtDRHNsWWdnN1pXWTY0cVVJRTlUQ2lBZ0lDQWdJSDBLSUNBZ0lDQWdjbVYwZFhKdUlIUnlkV1U3Q2lBZ0lDQjlDaUFnZlFvZ0lDOHZJTzJCdE91aG5PdVRuQ0RxczRUc29KVWc2NkdjNnJlNDdKV0U3SnVESU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnN1ptSTdKMllJRnZyb1p6cXQ3anNsWVRzbTROZElPdXloTzJLdk95ZHRDRHRtTGpzdHB3dUlHTnNZWFZrWlNCaGRYUm9JR3h2WjI5MWRPeWN2T3VobkNCRFRFa2c2NkdjNnJlNDdKMjQ3SjJFSU8yVnRPeWduTzJWbk91THBDNEtJQ0F2THlBbzdKMjBJRkJEN0oyWUlPeWdnT3llcGV1UW5DRHNucERxc3Fuc3BwM3Jxb1hzbllRZzdLZUE3SnEwNjR1a0lPS0FsQ0RyaTZUc2k1d2c3Sk93NjZDazY2bTBJT3llck91aG5PcTN1T3lkdUNEdGxZVHNtcFF1S1NEcm9aenF0N2pzbFlUc200TWc3WnVFN0plVUlPeUV1T3lGbU1LMzZyT0U3S0NWN0xxUTdJdWM2Nlc4SU95Z2xldW1yTzJWbk91THBDNEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZZMnhoZFdSbExXeHZaMjkxZENjcElIc0tJQ0FnSUdOdmJuTjBJR3h2SUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbllYVjBhQ2NzSUNkc2IyZHZkWFFuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdMQ0IzYVc1a2IzZHpTR2xrWlRvZ2RISjFaU0I5S1RzS0lDQWdJR3hsZENCbGNuSWdQU0FuSnpzS0lDQWdJR3h2TG5OMFpHVnljaTV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3SUdWeWNpQXJQU0JrTG5SdlUzUnlhVzVuS0NrN0lIMHBPd29nSUNBZ2JHOHViMjRvSjJWeWNtOXlKeXdnS0dVcElEMCtJSHNnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUdWeWNtOXlPaUFuNjZHYzZyZTQ3SldFN0p1RElPeUxwTzJXaVNEc2k2VHRqS2c2SUNjZ0t5QmxMbTFsYzNOaFoyVWdmU2s3SUgwcE93b2dJQ0FnYkc4dWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lDQWdhMmxzYkZCeWIyTW9KK3Vobk9xM3VPeVZoT3liZysyVnRPeUVuQ0RzbXBUc3NxM3NuWVFnN0tTUjY0dW83WmFJN0phMDdKcVVMaWNwT3lBdkx5RHNuWmpyajRUc29JRWc3S0tGNjZPTUlPS0FsQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95RXVPeUZtT3lkaENEcmtKanNnclRycHF6cnFiUWc3SldJSU91UXFBb2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QWdJQ0FnSUNBZ0x5OGc2NHVrN0oyTUlDOWhZMk52ZFc1MHdyY3ZhR1ZoYkhSbzdKZVE3SVNjSU9xemhPeWdsZXlkaENEc2c0anJvWndvUGV5WGh1eWRqT3ljdk91aG5Da2c3SjI5NnJLTUNpQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0lDQWdJQ0FnSUNBdkx5RHNnNEh0ZzV3ZzdKNnM3WXlRN0tDVktPdUxwT3lkakNEdGhMVHNsNURzaEp3ZzY2KzQ2NkdjNnJlNDdKMjRJT3F3a095bmdDa0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNsWVRzbTRNZ0tHTnZaR1VnSnlBcklHTnZaR1VnS3lBbktTY3BPd29nSUNBZ0lDQnBaaUFvY21WekxtaGxZV1JsY25OVFpXNTBLU0J5WlhSMWNtNDdJQzh2SUdWeWNtOXlJTzJWdU91VHBPdWZyT3F3Z0NEc25iVHJyN2dnN0oyUjY0dTE3WmFJN0p5ODY2bTBJT3lra2V1enRTRHJzS25zcDRBS0lDQWdJQ0FnYVdZZ0tHTnZaR1VnUFQwOUlEQXBJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVWdmU2s3Q2lBZ0lDQWdJR1ZzYzJVZ2FuTnZiaWh5WlhNc0lEVXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lHVnljbTl5T2lBb1pYSnlMblJ5YVcwb0tTNXpiR2xqWlNnd0xDQXhOVEFwS1NCOGZDQW9KK3lpaGV1ampDRHN2WlRyazV3Z0p5QXJJR052WkdVcElIMHBPd29nSUNBZ2ZTazdDaUFnSUNCeVpYUjFjbTQ3Q2lBZ2ZRb2dJQzh2SU95ZWtPcTRzQ0Rzb29Ycm80d2c0b0NVSU8yVWpPdWZyT3EzdU95ZHVDQlRWRTlRWDBKU1NVUkhSUy90bFpqdGlyanJ1WVR0aXJqcXNJQWc3Wmk0N0xhYzdaV2M2NHVrSUNqcm9aenN1NnpzbDVEc2hKenJwNHdnN0tDUjZyZThJT3F3Z091S3BlMlZtT3VMaUNEc2xZanNvSVFwQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNOb2RYUmtiM2R1SnlrZ2V3b2dJQ0FnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU0I5S1RzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc29vWHJvNHdnN0pxVTdMS3RJT3V3bSt5ZGpDRGlnSlFnNjR1azY2YXM2Nlc4SU91QmxldUxpT3VMcEM0bktUc0tJQ0FnSUhOb2RYUjBhVzVuUkc5M2JpQTlJSFJ5ZFdVN0NpQWdJQ0JyYVd4c1VISnZZeWdwT3dvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQndjbTlqWlhOekxtVjRhWFFvTUNrc0lESXdNQ2s3Q2lBZ0lDQnlaWFIxY200N0NpQWdmUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTl5WldOdmJXMWxibVFuS1NCN0NpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzTENCeWIyeGxJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnYVdZZ0tDRjBaWGgwSUh4OElDRlRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0oreTJsT3l5bk91d20reWRoQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdMYVU3TEtjSU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnl3Z2NtOXNaU0EvSUNkYkp5QXJJSEp2YkdVZ0t5QW5YU2NnT2lBbkp5d2diVzlrWld3Z1B5QW5LT3VxcU91TnVEb2dKeUFySUcxdlpHVnNJQ3NnSnlrbklEb2dKeWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTI5dWMzUWdjaUE5SUdGM1lXbDBJR0Z6YTBOc1lYVmtaU2hUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwTENCdGIyUmxiQ3dnZXlCd1lYSnpaVG9nY0dGeWMyVlRkV2RuWlhOMGFXOXVjeXdnWm05eWJXRjBSR1Z6WXpvZ0oxdDdJblJsZUhRaU9pQWk2Nnk0NnJXc0lpd2dJbkpsWVhOdmJpSTZJQ0xzbmJUc25LQWlmU3dnTGk0dVhTY2dmU3dnY205c1pTazdDaUFnSUNBZ0lHTnZibk4wSUhOMVoyZGxjM1JwYjI1eklEMGdjaTV3WVhKelpXUWdmSHdnVzEwN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ3BJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z2V5Qmxjbkp2Y2pvZ0orMkJ0T3Vobk91VG5DRHNuWkhyaTdYc25ZUWc3WlcwN0lTZDdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc29KenNsWWdnSnlBcklITjFaMmRsYzNScGIyNXpMbXhsYm1kMGFDQXJJQ2Zxc0p3Z0tDY2dLeUJ6WldNZ0t5QW5jeWtuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWgwWlhoMEtTNXpiR2xqWlNnd0xDQXpNQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lITjFaMmRsYzNScGIyNXpMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0JtY21sbGJtUnNlVVZ5Y205eUtHVXNJQ2Z0Z2JUcm9aenJrNXdnN1ppNDdMYWNJT3lMcE8yTXFEb2dKeWtwT3dvZ0lDQWdmUW9nSUgwS0lDQXZMeUR0bElUcm9JanNub1RyczRRZzdMYVU3TEtjSU9LQWxDRHRsWndnN1ptVTY2bTA3SjJFSU8yVm1PeWNoQ0R0bElUcm9JanNub1FvN0ppQjdKZXRLU0RyaTZqc25JVHJvWndnNjRLWTY0aWdJT3V3bStxem9Dd2c3SmlCN0pldDY2ZUk2NHVrSU91VXNPdWhuQ0RyaklEc2xZanNuWVFnNjRLNDY0dWtMZ29nSUM4dklPeVlnZXlYclNEc2lKanJwNHp0Z2J3ZzdKcVU3TEt0N0oyRUlPeXF2T3F3bk95bmdDRHNsWXJyaXBRZzZyS0Q3SjIwSU8yVnRleUxyQ0FvNjRxUTY2Q2s3S2VBNnJPZ0lPeUNyT3lhcWV1ZmlldVBoQ0RxdDdqcnA0enRnYndnNjRLWTZyQ0U2NHVrS1M0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0xXZHliM1Z3Y3ljcElIc0tJQ0FnSUdOdmJuTjBJSHNnWjNKdmRYQnpMQ0J0YjJSbGJDd2diVzl5WlNCOUlEMGdZWGRoYVhRZ2NtVmhaRUp2Wkhrb2NtVnhLVHNLSUNBZ0lHTnZibk4wSUd4cGMzUWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHZHliM1Z3Y3lrS0lDQWdJQ0FnUHlCbmNtOTFjSE1LSUNBZ0lDQWdJQ0FnSUM1dFlYQW9LR2NwSUQwK0lDaDdDaUFnSUNBZ0lDQWdJQ0FnSUc1aGJXVTZJRk4wY21sdVp5Z29aeUFtSmlCbkxtNWhiV1VwSUh4OElDY25LUzUwY21sdEtDa3NDaUFnSUNBZ0lDQWdJQ0FnSUhSbGVIUnpPaUFvWnlBbUppQkJjbkpoZVM1cGMwRnljbUY1S0djdWRHVjRkSE1wSUQ4Z1p5NTBaWGgwY3lBNklGdGRLUzV0WVhBb0tIUXBJRDArSUZOMGNtbHVaeWgwSUh4OElDY25LUzUwY21sdEtDa3BMbVpwYkhSbGNpaENiMjlzWldGdUtTd0tJQ0FnSUNBZ0lDQWdJQ0FnY205c1pUb2dLR2NnSmlZZ1p5NXliMnhsS1NBL0lGTjBjbWx1WnlobkxuSnZiR1VwSURvZ2RXNWtaV1pwYm1Wa0xBb2dJQ0FnSUNBZ0lDQWdmU2twQ2lBZ0lDQWdJQ0FnSUNBdVptbHNkR1Z5S0NobktTQTlQaUJuTG5SbGVIUnpMbXhsYm1kMGFDa0tJQ0FnSUNBZ09pQmJYVHNLSUNBZ0lHbG1JQ2hzYVhOMExteGxibWQwYUNBOElESXBJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREF3TENCN0lHVnljbTl5T2lBbjdKaUI3SmV0N0oyMElPdTJnT3loc2UyVnFldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU0U2NkNJN0o2RTY3T0VJT3kybE95eW5DRHNtcFRzc3EwNklPeVlnZXlYclNBbklDc2diR2x6ZEM1c1pXNW5kR2dnS3lBbjZyQ2NKeUFySUNodGIzSmxJRDhnSnlBbzY0MlVJT3V3bStxNHNDa25JRG9nSnljcExDQnRiMlJsYkNBL0lDY282NnFvNjQyNE9pQW5JQ3NnYlc5a1pXd2dLeUFuS1NjZ09pQW5KeWs3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUjNKdmRYQnpLR3hwYzNRc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVWR5YjNWd2N5d2dabTl5YldGMFJHVnpZem9nSjNzaVozSnZkWEJ6SWpvZ1czc2libUZ0WlNJNklDTHNtSUhzbDYwZzdKMjA2NmFFSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcmpJRHNsWWdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOVhYMWRmU2NnZlN3Z0lTRnRiM0psS1RzS0lDQWdJQ0FnWTI5dWMzUWdiM1YwSUQwZ2NpNXdZWEp6WldRN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnZkWFFwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRsSVRyb0lqc25vVHJzNFFnN0tDYzdKV0lJQ2NnS3lCdmRYUXVjbVZrZFdObEtDaHVMQ0JuS1NBOVBpQnVJQ3NnWnk1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnc0lEQXBJQ3NnSitxd25DQXZJT3lZZ2V5WHJTQW5JQ3NnYjNWMExteGxibWQwYUNBcklDZnFzSndnS0NjZ0t5QnpaV01nS3lBbmN5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVkdWNGRDQTlJQ2RiN1pTRTY2Q0k3SjZFNjdPRVhTQW5JQ3NnVTNSeWFXNW5LQ2hzYVhOMFd6QmRJQ1ltSUd4cGMzUmJNRjB1ZEdWNGRITmJNRjBwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0F5TkNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJR2R5YjNWd2N6b2diM1YwTENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RzaTZUdGpLZzZKeXdnWlM1dFpYTnpZV2RsS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdDaUFnSUNCOUNpQWdmUW9nSUM4dklPMk1uZXlYaFNEc21wVHNob3pyczRRZzdMYVU3TEtjSU9LQWxDRHRsWndnN1l5ZDdKZUY3SjJZSU9xMXJPeUVzZXlhbE95R2pDanNsNjN0bGFBcjY2eTQ2cldzS2V1bHZDRHRsWndnNjdLSTdKZVFJT3V3bSt5VmhDRHNsNjN0bGFEcnM0VHJvWndnNjR1azY1T3M2NHFVNjR1a0xnb2dJQzh2SU95YWxPeUdqT3VsdkNEdGxhanF1NWdnNjdPMDY0SzA3Slc4SU8yRGdPeWR0TzJMZ095ZHRDRHJzN2pyckxnZzY2ZWw2NTI5N0oyRUlPeXd1T3loc08yVm9DRHNpSmdnN0o2STY0dWtLT3lhbE95R2pPdXpoQ0Rxc0p6cnM0UWc3SnFVN0xLdDZyTzg3SjJZSU95d3FPeWR0Q2t1Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNKbFkyOXRiV1Z1WkMxd2IzQjFjQ2NwSUhzS0lDQWdJR052Ym5OMElIc2daV3hsYldWdWRITXNJRzF2WkdWc0xDQnRiM0psSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ1kyOXVjM1FnYkdsemRDQTlJRUZ5Y21GNUxtbHpRWEp5WVhrb1pXeGxiV1Z1ZEhNcElEOGdaV3hsYldWdWRITXVabWxzZEdWeUtDaGxLU0E5UGlCbElDWW1JRk4wY21sdVp5aGxMblJsZUhRZ2ZId2dKeWNwTG5SeWFXMG9LU2tnT2lCYlhUc0tJQ0FnSUdsbUlDaHNhWE4wTG14bGJtZDBhQ0E4SURJcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuN1l5ZDdKZUZJT3lhbE95R2pPcXdnQ0RydG9Ec29iSHRsYW5yaTRqcmk2UXVKeUI5S1RzS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNbmV5WGhTRHN0cFRzc3B3ZzdKcVU3TEt0T2lEc21wVHNob3dnSnlBcklHeHBjM1F1YkdWdVozUm9JQ3NnSitxd25DY2dLeUFvYlc5eVpTQS9JQ2NnS091TmxDRHJzSnZxdUxBcEp5QTZJQ2NuS1N3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NpQTlJR0YzWVdsMElHRnphMUJ2Y0hWd0tHeHBjM1FzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpWQnZjSFZ3TENCbWIzSnRZWFJFWlhOak9pQW5leUp6WlhSeklqb2dXM3NpY21WaGMyOXVJam9nSXV1d3FlMldwU0R0bFp3ZzY2eTQ3SjZsSWl3Z0ltVnNaVzFsYm5Seklqb2dXM3NpY205c1pTSTZJQ0xzbDYzdGxhQWlMQ0FpZEdWNGRDSTZJQ0xyckxqcXRhd2lmU3dnTGk0dVhYMHNJQzR1TGwxOUp5QjlMQ0FoSVcxdmNtVXBPd29nSUNBZ0lDQmpiMjV6ZENCelpYUnpJRDBnY2k1d1lYSnpaV1E3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGelpYUnpLU0I3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lIc2daWEp5YjNJNklDZnRnYlRyb1p6cms1d2c3SjJSNjR1MTdKMkVJTzJWdE95RW5lMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVKeUI5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZeWQ3SmVGSU95RXVPMkt1Q0FuSUNzZ2MyVjBjeTVzWlc1bmRHZ2dLeUFuNnJDY0lDZ25JQ3NnYzJWaklDc2dKM01wSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbk5sY25abFpDc3JPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNBblcrMk1uZXlYaFYwZ0p5QXJJRk4wY21sdVp5Z29iR2x6ZEZzd1hTQW1KaUJzYVhOMFd6QmRMblJsZUhRcElIeDhJQ2NuS1M1emJHbGpaU2d3TENBeU5DazdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhObGRITXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY2dmU2s3Q2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpKM3NsNFVnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lDZnRnYlRyb1p6cms1d2c3Wmk0N0xhY0lPeUxwTzJNcURvZ0p5a3BPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5RHJqSUR0bVpUdG1KVWc2Nnk0NnJXc0lPeWduT3lla1NEaWdKUWc3SU9CN1ptcDdKMkVJT3lFcE91cWhlMlZtT3VwdENEcnJManF0YXpycGJ3ZzY2ZU02NU9rN0phMDdLU0E2NHVrSUNqc3RwVHNzcHpxczd3ZzZyQ1o3SjJBSU95RXVPeUZtQ3dnNjR5QTdabVU2NHFVSU91bnBDRHNtcFRzc3Ezc2w1QWc3WWExN0tlNDY2R2NJT3lMcE91bXZDa0tJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZZMjl0Y0c5elpTY3BJSHNLSUNBZ0lHTnZibk4wSUhzZ2JXVnpjMkZuWlhNc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ1kyOXVjM1FnYkdsemRDQTlJRUZ5Y21GNUxtbHpRWEp5WVhrb2JXVnpjMkZuWlhNcElEOGdiV1Z6YzJGblpYTXVabWxzZEdWeUtDaHRLU0E5UGlCdElDWW1JRk4wY21sdVp5aHRMblJsZUhRZ2ZId2dKeWNwTG5SeWFXMG9LU2tnT2lCYlhUc0tJQ0FnSUdsbUlDZ2hiR2x6ZEM1c1pXNW5kR2dwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW42NHlBN1ptVUlPdUN0T3lhcWV5ZHRDRHJ1WVRzbHJRZzdKNkk3SXExNjR1STY0dWtMaWNnZlNrN0NpQWdJQ0JqYjI1emRDQnpkR0Z5ZEdWa0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lHTnZibk4wSUd4aGMzUlZjMlZ5SUQwZ1d5NHVMbXhwYzNSZExuSmxkbVZ5YzJVb0tTNW1hVzVrS0NodEtTQTlQaUJ0TG5KdmJHVWdJVDA5SUNkaGMzTnBjM1JoYm5RbktUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvSnpzbnBFZzY0eUE3Wm1VSU95YWxPeXlyVG9uTENCVGRISnBibWNvS0d4aGMzUlZjMlZ5SUNZbUlHeGhjM1JWYzJWeUxuUmxlSFFwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0ExTUNrdWNtVndiR0ZqWlNndlhHNHZaeXdnSnlBbktTQXJJQ2ZpZ0tZZ0tPdU1nTzJabENBbklDc2diR2x6ZEM1c1pXNW5kR2dnS3lBbjZyQ2NLU2NwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnTHk4ZzY0eUE3Wm1VNnJDQUlPcTR1T3lXdE95bmdPdXB0Q0RzdFp6cXQ3d2dNVExxc0p6cnA0d2dLTzJVaE91aHJPMlVoTzJLdUNEdGo2M3NvN3dnNjdDcDdLZUFLUW9nSUNBZ0lDQmpiMjV6ZENCeUlEMGdZWGRoYVhRZ1lYTnJRMjl0Y0c5elpTaHNhWE4wTG5Oc2FXTmxLQzB4TWlrc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVU52YlhCdmMyVXNJR1p2Y20xaGRFUmxjMk02SUNkN0luSmxjR3g1SWpvZ0l1dU1nTzJabENEc25aSHJpN1VnN1pXYzY1R1FJT3VzdU95ZXBTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2Nnk0NnJXc0lpd2dJbkpsWVhOdmJpSTZJQ0xzbmJUc25LQWlmU3dnTGk0dVhYMG5JSDBwT3dvZ0lDQWdJQ0JqYjI1emRDQnZkWFFnUFNCeUxuQmhjbk5sWkRzS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3dvZ0lDQWdJQ0JwWmlBb0lXOTFkQ2tnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0NpQWdJQ0FnSUgwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lla1NEc25aSHJpN1VnS0NjZ0t5QnpaV01nS3lBbmN5d2c3S0NjN0pXSUlDY2dLeUJ2ZFhRdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lDc2dKK3F3bkNrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlGTjBjbWx1Wnlnb2JHRnpkRlZ6WlhJZ0ppWWdiR0Z6ZEZWelpYSXVkR1Y0ZENrZ2ZId2dKeWNwTG5Oc2FXTmxLREFzSURNd0tUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGTmxZeUE5SUhObFl6c0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnY21Wd2JIazZJRzkxZEM1eVpYQnNlU3dnYzNWbloyVnpkR2x2Ym5NNklHOTFkQzV6ZFdkblpYTjBhVzl1Y3l3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnlCOUtUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lnbk95ZWtTRHNpNlR0aktnNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEdG1ManN0cHdnN0l1azdZeW9PaUFuS1NrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SU91eWlPeVhyU0RpZ0pRZzdaV2M2cld0N0phMElPS0dsQ0RzbUlIc2xyUWc3SjZRNjQrWklDanN0cFRzc3B6cXM3d2c2ckNaN0oyQUlPeUV1T3lGbUNEc2dxenNtcWtwQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNSeVlXNXpiR0YwWlNjcElIc0tJQ0FnSUdOdmJuTjBJSHNnZEdWNGRDd2diVzlrWld3Z2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3Q2lBZ0lDQnBaaUFvSVhSbGVIUWdmSHdnSVZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0NrcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuNjdLSTdKZXQ3WldnSU91c3VPcTFyT3F3Z0NEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdKcVU3TEt0T2ljc0lGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0ExTUNrdWNtVndiR0ZqWlNndlhHNHZaeXdnSnlBbktTQXJJQ2ZpZ0tZbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhJZ1BTQmhkMkZwZENCaGMydFVjbUZ1YzJ4aGRHVW9VM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFZISmhibk5zWVhSbExDQm1iM0p0WVhSRVpYTmpPaUFuZXlKMGNtRnVjMnhoZEdWa0lqb2dJdXV5aU95WHJldXN1Q0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpTENBaVpHbHlaV04wYVc5dUlqb2dJbXR2NG9hU1pXNGc2NWlRNjRxVUlHVnU0b2FTYTI4aWZTY2dmU2s3Q2lBZ0lDQWdJR052Ym5OMElHOTFkQ0E5SUhJdWNHRnljMlZrT3dvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBb0tFUmhkR1V1Ym05M0tDa2dMU0J6ZEdGeWRHVmtLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2s3Q2lBZ0lDQWdJR2xtSUNnaGIzVjBLU0I3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lIc2daWEp5YjNJNklDZnRnYlRyb1p6cms1d2c2N0tJN0pldElPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzbVlUcm80d2dLQ2NnS3lCelpXTWdLeUFuY3l3Z0p5QXJJQ2h2ZFhRdVpHbHlaV04wYVc5dUlIeDhJQ2MvSnlrZ0t5QW5LU2NwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVVpYaDBJRDBnVTNSeWFXNW5LSFJsZUhRcExuTnNhV05sS0RBc0lETXdLVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRk5sWXlBOUlITmxZenNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2RISmhibk5zWVhSbFpEb2diM1YwTG5SeVlXNXpiR0YwWldRc0lHUnBjbVZqZEdsdmJqb2diM1YwTG1ScGNtVmpkR2x2Yml3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnlCOUtUc0tJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNpNlR0aktnNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEcnNvanNsNjBnN0l1azdZeW9PaUFuS1NrN0NpQWdJQ0I5Q2lBZ2ZRb2dJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREEwTENCN0lHVnljbTl5T2lBblRtOTBJR1p2ZFc1a0p5QjlLVHNLZlNrN0Nnb3ZMeURzbmJUcnI3Z2c2NHVrNjZhczZyQ0FJT3VXb0NEc25vanJpcFRyamJBZzY1aVFJT3k4bk9xNHNPcXdnQ0RyazZUc2xyVHNtS1RycWJRbzdLQ2M3SXFrN0xLWUlPeWVrT3VQbVNEc3ZKenF1TEFnN0tTUjY3TzFJT3VUc1NrZzdLR3c3SnFwN1o2SUlPeWloZXVqakNEaWdKUWc2NCtNNjQyWUlPdUxwT3Vtck91S2xDRHF0N2pyaklEcm9ad2c3SnlnN0tlQUNuTmxjblpsY2k1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V3b2dJR2xtSUNobElDWW1JR1V1WTI5a1pTQTlQVDBnSjBWQlJFUlNTVTVWVTBVbktTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SjIwNjYrNElPeThuT3lndUNEc25vanNsclRzbXBRbzdZK3M3WXE0SUNjZ0t5QlFUMUpVSUNzZ0p5RHNncXpzbXFrZzdLU1JLU0RpZ0pRZzdKMjBJT3lkdU95S3BPMkV0T3lLcE91S2xDRHNvb1hybzR6dGxhbnJpNGpyaTZRdUp5azdDaUFnSUNCd2NtOWpaWE56TG1WNGFYUW9NQ2s3Q2lBZ2ZRb2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2hKenJzb1FnN0ppazY2V1lPaWNzSUdVZ0ppWWdaUzV0WlhOellXZGxLVHNLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3Q24wcE93b3ZMeURzbHJUcmxxUWc2cks5NjZHYzY2R2NJT3lqdmV1VG9DanNpNnpzbnFYcnNKWHJqNWtnNjRHSzZybUFMQ0JEZEhKc0swTXNJQzl6YUhWMFpHOTNiaXdnN0ppazY2V1lLU0JqYkdGMVpHVWc3SjZRN0l1ZDdKMkVJT3VDcU9xNHNPeW5nQ0RzbFlycmlwVHJpNlFLY0hKdlkyVnpjeTV2YmlnblpYaHBkQ2NzSUNncElEMCtJSHNnYTJsc2JGQnliMk1vS1RzZ2EybHNiRXh2WjJsdVVISnZZeWdwT3lCOUtUc0tjSEp2WTJWemN5NXZiaWduVTBsSFNVNVVKeXdnS0NrZ1BUNGdjSEp2WTJWemN5NWxlR2wwS0RBcEtUc0tjSEp2WTJWemN5NXZiaWduVTBsSFZFVlNUU2NzSUNncElEMCtJSEJ5YjJObGMzTXVaWGhwZENnd0tTazdDZ3B6WlhKMlpYSXViR2x6ZEdWdUtGQlBVbFFzSUNjeE1qY3VNQzR3TGpFbkxDQW9LU0E5UGlCN0NpQWdZMjl1YzI5c1pTNXNiMmNvSitLVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdDY3BPd29nSUdOdmJuTnZiR1V1Ykc5bktDY2c3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFySUZCUFVsUXBPd29nSUdOdmJuTnZiR1V1Ykc5bktDY2c2NnFvNjQyNE9pQW5JQ3NnUTB4QlZVUkZYMDFQUkVWTUlDc2dKeURDdHlEc21JanNpNXdnSnlBcklFVllRVTFRVEVWVExteGxibWQwYUNBcklDZnFzYlFnN0o2bDdMQ3BKeWs3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KeURzbmJRZzdMQzk3SjJFSU95OG5PdVJsQ0RyajVuc2xZZ2c3WlM4NnJlNDY2ZUlJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHRnYlRyb1p6cms1enJvWndnN0xhVTdMS2M3WldwNjR1STY0dWtMaWNwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2ZpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBbktUc0tJQ0JqYUdWamEwTnNZWFZrWlVGMllXbHNZV0pzWlNncE95QXZMeUJEYkdGMVpHVWdRMjlrWlNEc2dxenNtcWtnNnJDQTY0cWxJT3lYck91MmdDRHNvSkRxc29BZ0tPMlVqT3Vmck9xM3VPeWR1Q0RzbFlqcmdyVHNtcWtwQ2lBZ0x5OGc2Nis0NjZhc0lPeUxuT3VQbVNBcklPeW5nT3lMbk91c3VDRHNvN3pzbm9VZzRvQ1VJT3l5cXlEc3RwVHNzcHpydG9EdGhMQWc2N21nNjZXMDZyS01DaUFnWVhOclEyeGhkV1JsS0Nmc200enJzSTNzbDRVNklDTHNvSURzbnFVZzY1Q1k3SmVJN0lxMTY0dUk2NHVrSWljcExuUm9aVzRvQ2lBZ0lDQW9LU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SnVNNjdDTjdKZUZJT3laaE91ampDRGlnSlFnN0xhVTdMS2NJT3lrZ091NWhDRHJnWjB1Snlrc0NpQWdJQ0FvWlNrZ1BUNGdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95YmpPdXdqZXlYaFNEc2k2VHRqS2dnS095eXF5RHNtcFRzc3EwZzY1V01JT3llck95TG5PdVBoQ2s2Snl3Z1pTNXRaWE56WVdkbEtRb2dJQ2s3Q24wcE93b3ZMeUJKVUhZMklPdWpxTzJVaE91d3NTZzZPakVwN0plUTY0K0VJTzJWcU9xN21DRHJrNlByaXBUcmk2UWc0b0NVSUcxaFkwOVRJT3VUc2V5WGtPeUVuQ0FuYkc5allXeG9iM04wSitxd2dDQTZPakhyb1p3ZzY2aTg3S0NBSU8yVnRPeUVuZXVRbU91S2xPdU5zQW92THlEdGxMenF0N2pycDRnb1JXeGxZM1J5YjI0cElHWmxkR05vNjRxVUlHTjFjbXpxczd3ZzY0dXM2NmFzSUVsUWRqVHJvWndnN0o2UTY0K1pJTzJQdE91d3NlMlZtT3luZ0NEc2xZcnNsWVFzSUVsUWRqVHJwNHdnNjVPajY0MllJT3VMcE91bXJPeVhrQ0RzbDdEcXNyRHNuYlFnNnJHdzY3YUE2NCs4Q2k4dklPeTJsT3l5bk1LMzdaZXM3SXFrN0xLMDdZR3M2ckNBSU95aHNPeWFxZTJlaUNEc2k2VHRqS2p0bG9qcmk2UW83SXVrN0xpaElESXdNall0TURjcExpRHFzSm5zbllBZzdKcVU3TEt0SU8yVnVPdVRwT3Vmck91bHZDQkpVSFkySU91anFPMlVoT3V3c2V5WGtPdVBoQ0RzbHJucmlwVHJpNlF1Q21OdmJuTjBJSE5sY25abGNqWWdQU0JvZEhSd0xtTnlaV0YwWlZObGNuWmxjaWh6WlhKMlpYSXViR2x6ZEdWdVpYSnpLQ2R5WlhGMVpYTjBKeWxiTUYwcE93cHpaWEoyWlhJMkxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnU1ZCMk5pZzZPakVwSU91bXJPeUtxQ0RzZzUzcm5yVWc0b0NVSUVsUWRqVHJwNHdnN0lLczdKcXBPaWNzSUdVZ0ppWWdaUzV0WlhOellXZGxLU2s3Q25ObGNuWmxjall1YkdsemRHVnVLRkJQVWxRc0lDYzZPakVuS1RzSycKQjY0X1dBVENIRVI9J0x5OGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc0b0NVSU8yVnJleURnU0RybHFBZzdKNkk2NHFVSU95MGlPeUdqTzJZbFNEc2hKenJzb1FnS0d4dlkyRnNhRzl6ZERveE1UZzRPU2tLTHk4ZzRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU95Wm5DRHRsWVRzbXBUdGxaenFzSUE2SU8yVXZPcTN1T3VuaU9xd2dDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1kyeGhkV1JsWW5KcFpHZGxPaTh2SU95WHRPcTRzQ2gzYVc1a2IzY3ViM0JsYmk5cFpuSmhiV1V2YjNCbGJrVjRkR1Z5Ym1Gc0tldWx2QW92THlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293S0x5OGdVRTlUVkNBdmQyRnJaU0RycGJ3ZzY3TzA2NEswNjZtMElPcXdrT3lMbk95ZWtPcXdnQ0RyaTZUcnBxd29ZMnhoZFdSbExXSnlhV1JuWlM1cWN5bnJwYndnNjR5QTdJdWdJT3k4b091THBDNEtMeThLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQW92THlEcnFaVHJxcWpycHF3Z2ZqRTFUVUxybmJ3ZzY2R2M2cmU0N0oyNElPeUxuQ0RzbnBEcmo1a2c3SXVjN0o2UjdKeTg2NkdjSU95RGdleUxuQ0Rzdkp6cmthenJqNFFnNjdhQTY0dTBJT3lYaHV1THBDQW82NU94NjZHZE9pQnVjRzBnY25WdUlHSjFhV3hrS1M0S0x5OGc2NHVrNjZhczY0cVVJT3lMck95ZXBldXdsZXVQbVNEcmdZcnF1TERycWJRZzdLTzk3S2VBNjZlTUtPMlVqT3Vmck9xM3VPeWR1T3F6dkNEc2c1M3NncXdnNjQrWjZyaXc3Wm1VS1N3ZzZyQ1E3SXVjN0o2UTY0cVVJT3F6aE95R2pTRHJncWpzbFlRZzY0dWs3SjJNSU9xNXFPeWFzT3E0c091bHZDRHJzSnZyaXBUcmk2UXVDZ3BqYjI1emRDQm9kSFJ3SUQwZ2NtVnhkV2x5WlNnbmFIUjBjQ2NwT3dwamIyNXpkQ0J3WVhSb0lEMGdjbVZ4ZFdseVpTZ25jR0YwYUNjcE93cGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0NtTnZibk4wSUc5eklEMGdjbVZ4ZFdseVpTZ25iM01uS1RzS1kyOXVjM1FnZXlCemNHRjNiaXdnYzNCaGQyNVRlVzVqSUgwZ1BTQnlaWEYxYVhKbEtDZGphR2xzWkY5d2NtOWpaWE56SnlrN0NncGpiMjV6ZENCUVQxSlVJRDBnTVRFNE9EazdDbU52Ym5OMElGSlBUMVFnUFNCd1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5MaTRuS1RzZ0x5OGc3S0NBN0o2bDdJYU1JT3VqcU8yS3VDRGlnSlFnNjR1azY2YXM2ckNBSUhKbFkyOXRiV1Z1WkMxbGVHRnRjR3hsY3k1dFpPdWx2Q0Rzc0w3cmlwUWc2cml3N0tTQUNncGpiMjV6ZENCRFQxSlRYMGhGUVVSRlVsTWdQU0I3Q2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVTl5YVdkcGJpYzZJQ2NxSnl3S0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxSVpXRmtaWEp6SnpvZ0owTnZiblJsYm5RdFZIbHdaU2NzQ24wN0NtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXdvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzS0lDQnlaWE11Wlc1a0tFcFRUMDR1YzNSeWFXNW5hV1o1S0c5aWFpa3BPd3A5Q2dvdkx5QmpiR0YxWkdVZ1EweEo2ckNBSU95ZWlPdUtsT3luZ0NEaWdKUWc3SmVHN0p5ODY2bTBJQzkzWVd0bElPeWRrZXVMdGV5WGtDRHNpNlRzbHJRZzdaU002NStzNnJlNDdKMjQ3SjIwSU95VmlPdUN0TzJWb0NEc2lKZ2c3SjZJNnJLTUlPMlZuT3VMcEFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzRLTHk4ZzdZeU03SjI4N0oyMElPMkJ0Q0RzaUpnZzdKNkk3SmEwSURNdzdMU0lJT3k2a095TG5DNGc3SjZzNjZHYzZyZTQ3SjI0N1pXWTY2bTBJRU5NU2Vxd2dDRHRqSXpzbmJ6c25ZUWc2ckN4N0l1ZzdaV1k2NitBNjZHY0lPeWVrT3VQbVNEcnNKanNtSUhya0p6cmk2UXVDaTh2SU95NmtPeUxuQ0ExN0xTSUlPS0FsQ0Ryb1p6cXQ3anNuYmdnN0tlQjdadUVJT3lEaUNEcXM0VHNvSlhzbmJRZzZyT242N0NVNjZHY0lPeWVvZTJZZ095VnZDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95WGtPeUVuQ0R0bVlqc25MenJvWndnNjRTWTdKYTA2ckNFNjR1a0tETXc3TFNJNjZtMElPdUVpT3VzdENEcmlxYnNuWXdwQ214bGRDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUF3TENCbGJXRnBiRG9nYm5Wc2JDQjlPd292THlEc2k2VHNvSndnNjZHYzZyZTQ3SjI0SU95WHJPdTJnT3VLbENEc25wRHFzcW5zcHAzcnFvVWc3WXlNN0oyODY2R2NJTzJNa091THFPMlZuT3VMcENEaWdKUWdmaTh1WTJ4aGRXUmxMbXB6YjI3c25aZ2diMkYxZEdoQlkyTnZkVzUwNjRxVUlDb3E2NkdjNnJlNDdKV0U3SnVEN1pXMDY0K0VJT3VDcU91S2xPdUxwQ29xQ2k4dklDanNpNlRzdUtFNklHTnNZWFZrWlNCaGRYUm9JSE4wWVhSMWMrdUtsQ0JzYjJkblpXUkpianBtWVd4elpleWR1T3VOc0NEcXQ3Z2c3WldFNjVPYzY0cVVJT3EzdU91TWdPdWhuQ0RpaHBJZzdaU002NStzNnJlNDdKMjQ3SjIwSU91aG5PcTN1T3lkdU91UW5DRHFzb1Bzc3Bqcm43d2c3WkdjN0l1YzdaYUk2NHVrS1M0S0x5OGc3WXlNN0oyODY2ZU1JT3lkdmV5Y3ZPdXZnT3VobkNEcnVZVHNtcWtnTUM0Z1kyeGhkV1JsSUdGMWRHZ2djM1JoZEhWejZyQ0FJT3lnbGUyWmxlMlZtT3luZ091bmpDRHRsSVRyb1p6c2hManNpcVRycGJ3ZzY1MkU3SnVNN0pXOElPMlZ0T3lFbkNEc29iRHRtb3pycDRqcmk2UWc3Sk93NnJpdzdKZVVJT3VzdE9xeWdldUxwQzRLWm5WdVkzUnBiMjRnYUdGelEyeGhkV1JsUTNKbFpHVnVkR2xoYkhNb0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJR1lnUFNCd1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuTG1Oc1lYVmtaU2NzSUNjdVkzSmxaR1Z1ZEdsaGJITXVhbk52YmljcE93b2dJQ0FnWTI5dWMzUWdhaUE5SUVwVFQwNHVjR0Z5YzJVb1puTXVjbVZoWkVacGJHVlRlVzVqS0dZc0lDZDFkR1k0SnlrcE93b2dJQ0FnYVdZZ0tHb2dKaVlnYWk1amJHRjFaR1ZCYVU5aGRYUm9JQ1ltSUdvdVkyeGhkV1JsUVdsUFlYVjBhQzVoWTJObGMzTlViMnRsYmlrZ2NtVjBkWEp1SUhSeWRXVTdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN1l5TTdKMjhJT3lYaHV5ZGpNSzM2NnE3SU95ZHZleWRqQ0RpZ0pRZzY2ZWw3SjIwNjZtMElPMkNwT3l5dE95ZHVPeWRoQ0RycDRqc29JQWc2N080NjR1a0lDb3ZJSDBLSUNBdkx5QXFLdXVucGV5ZGdDRHNucERxc3Fuc3BwM3Jxb1hzbllRZzdZeU03SjI4N0oyMElPeVZoT3VMaU91ZHZDRHRncVRzc3JUc25ianNsNUFnNjRTajY0cVU2NHVrS2lvZ0tESXdNall0TURnZzdJdWs3TGloTENEcmk2VHJwcXdnZGpReElDOGc2ckNRN0l1YzdKNlFJSFkyS1M0S0lDQXZMeURycDZYc25aZ2dRMnhoZFdSbElFTnZaR1hyaXBRZ2ZpOHVZMnhoZFdSbEx5NWpjbVZrWlc1MGFXRnNjeTVxYzI5dTdKMkVJT3lWaE95WWlDRHJwNHpyazZUc3A0QWc3SldLNnJPZ0lPMkNwT3l5dE95ZHVDRHRsYTNycXFrS0lDQXZMeUFuUTJ4aGRXUmxJRU52WkdVdFkzSmxaR1Z1ZEdsaGJITW43SmVRSU95Z2dPeWVwZTJWbk91THBDRGlocElnN1l5TTdKMjg2NmVNSU91enRPdXB0Q0RycVlEc3FhSHRub2dnNjZHYzZyZTQ3SjI0NjVDY0lPdW5wZXlkdENEcmlwZ2dKK3Vobk9xM3VPeWR1Q0RzbFlnZzY1Q29KK3lkdENEcmtKanFzNkFzQ2lBZ0x5OGc2NkdjNnJlNDdKMjRJT3VNZ09xNHNDRHRtWlRycWJUc25iUWc3SmlCN0ppQklPdVBpT3VMcENqcmlJenJuNnpyajRRZ1EweEo2ckNBSUNMc25iVHJyN2dnNjZHYzZyZTQ3SjI0NjVDb0l1eWN2T3VobkNEc3BvbnNpNXdnNjRHZDY0S1lJT3U0ak91ZHZPeWFzT3lnZ095aHNPeXdxQ0RzbFlnZzdKZTA2NmF3NjR1a0tTNEtJQ0F2THlBcUt1eWh0T3llck91bmpDRHRtWlhzbmJqdGxaenJpNlFvTFhjZzdKZUc3SjJNS1NvcUlPS0FsQ0RydVlUcnNJRHJzb2p0bUxnZzZyQ1M3SjJFSU95ZHZleWN2T3VwdENEdGdxVHNzclRzbmJnZzdLQ1I2cmU4SU8yWGlPeWFxU0R0akozc2w0WHNuYlFnNjV5d0lPeUltQ0Rzbm9qcmk2UXVJT3lWdlNBek1HMXpMZ29nSUM4dklFTkNYMDVQWDB0RldVTklRVWxPUFRIc25iVHJxYlFnN1l5TTdKMjg2NmVNSU91enVPdUxwQ0FvNjZxbzdKMllJTzJaaU95Y3ZPdWhuQ0FuNjZHYzZyZTQ3SjI0SU95WGh1eWRqQ2ZzbllRZzdKNnM3WmlFN1pXWTY0cVVJTzJGak95S3BPMkt1T3lhcVNEaWdKUWc3WUtrN0xLMDdKMjQ3SjJBSUVoUFRVWHNuWVFnN0pXSUlPdVVzT3VsdU91THBDa3VDaUFnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ0lUMDlJQ2RrWVhKM2FXNG5JSHg4SUhCeWIyTmxjM011Wlc1MkxrTkNYMDVQWDB0RldVTklRVWxPSUQwOVBTQW5NU2NwSUhKbGRIVnliaUJtWVd4elpUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdjaUE5SUhOd1lYZHVVM2x1WXlnbmMyVmpkWEpwZEhrbkxDQmJKMlpwYm1RdFoyVnVaWEpwWXkxd1lYTnpkMjl5WkNjc0lDY3RjeWNzSUNkRGJHRjFaR1VnUTI5a1pTMWpjbVZrWlc1MGFXRnNjeWRkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2RHbHRaVzkxZERvZ016QXdNQ0I5S1RzS0lDQWdJSEpsZEhWeWJpQnlMbk4wWVhSMWN5QTlQVDBnTURzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlCeVpYUjFjbTRnWm1Gc2MyVTdJSDBnTHk4Z2MyVmpkWEpwZEhucnBid2c2NnE3SU91MmdPdW1oQ0E5SU91aG5PcTN1T3lkdUNEc2xZZ2c2NUNvN0p5ODY2R2NJT3V6dU91THBBcDlDbVoxYm1OMGFXOXVJR05zWVhWa1pVRmpZMjkxYm5Rb0tTQjdDaUFnYVdZZ0tFUmhkR1V1Ym05M0tDa2dMU0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQQ0ExTURBd0tTQnlaWFIxY200Z1lXTmpiM1Z1ZEVOaFkyaGxMbVZ0WVdsc093b2dJR3hsZENCbGJXRnBiQ0E5SUc1MWJHdzdDaUFnZEhKNUlIc0tJQ0FnSUdsbUlDaG9ZWE5EYkdGMVpHVkRjbVZrWlc1MGFXRnNjeWdwS1NCN0lDOHZJT3lla09xeXFleW1uZXVxaGV5ZHRDRHNsNGJzbkx6cnFiUWc2NEtvN0oyQUlPeWR0T3VwbE95ZHZPeWRnQ0RyckxUc2k1enRsWnpyaTZRS0lDQWdJQ0FnWTI5dWMzUWdhaUE5SUVwVFQwNHVjR0Z5YzJVb1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxMbXB6YjI0bktTd2dKM1YwWmpnbktTazdDaUFnSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3dvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91aG5PcTN1T3lkdUNEc25iVHJvS1VnN0plRzdKMk1JT3VUc1NEaWdKUWdiblZzYkNBcUx5QjlDaUFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ1JHRjBaUzV1YjNjb0tTd2daVzFoYVd3Z2ZUc0tJQ0J5WlhSMWNtNGdaVzFoYVd3N0NuMEtDbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzS0lDQmpiMjV6ZENCbWFXNWtaWElnUFNCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbklEOGdKM2RvWlhKbEp5QTZJQ2QzYUdsamFDYzdDaUFnZEhKNUlIc2djbVYwZFhKdUlITndZWGR1VTNsdVl5aG1hVzVrWlhJc0lGc25ZMnhoZFdSbEoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0J6YUdWc2JEb2dkSEoxWlNCOUtTNXpkR0YwZFhNZ1BUMDlJREE3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJSEpsZEhWeWJpQm1ZV3h6WlRzZ2ZRcDlDZ3BzWlhRZ2QyRnJhVzVuSUQwZ1ptRnNjMlU3SUM4dklPeVhzTzJEZ0NEcnNLbnNwNEFnNG9DVUlPdUxwT3Vtck91S2xDRHNsclRzc0tqdGxMd2dSVUZFUkZKSlRsVlRSZXVobkNEc3BKSHJzN1VnN0tDVjY2YXM3WldZN0tlQTY2ZU1JTzJVaE91aG5PeUV1T3lLcENEcmdxM3J1WVRycGJ3ZzdLU0U3SjI0NjR1a0NtWjFibU4wYVc5dUlIZGhhMlZDY21sa1oyVW9LU0I3Q2lBZ2FXWWdLSGRoYTJsdVp5a2djbVYwZFhKdU93b2dJSGRoYTJsdVp5QTlJSFJ5ZFdVN0NpQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJSGRoYTJsdVp5QTlJR1poYkhObE95QjlMQ0ExTURBd0tUc0tJQ0JzWlhRZ2NISnZZenNLSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXdvZ0lDQWdMeThnVjJsdVpHOTNjem9nWTIxa3dyZDJZbk1nNnJLOTdKeWdJT3lYaHV5ZHRDQnViMlJsNjZXOElPeW5nZXlna1N3Z2QybHVaRzkzYzBocFpHVW9RMUpGUVZSRlgwNVBYMWRKVGtSUFZ5bnJvWndnN0lxazdZK3dJT0tBbEFvZ0lDQWdMeThnN0xDOUlPeVhodXVLbENEc2lLanNuWUFnN0wyWTdJYVU3SjIwSU91bmpPdVRwT3lXdE95bmdPcXpvQ0RyaTZUcnBxenNuWmdnN0o2UTdJdWRLR05zWVhWa1pTbnJqNFFnNnJlNElPeTltT3lHbE95ZGhDRHJyTHpyb0tUcnNKdnNsWVFnN0phMDY1YWtJT3l3dmV1UGhDRHNsWWdnNjV5czY0dWtMZ29nSUNBZ0x5OGdaR1YwWVdOb1pXVHJpcFFnN0pPdzdLZUFJT3lWaXV1S2xPdUxwQ2hrWlhSaFkyaGxaQ3QzYVc1a2IzZHpTR2xrWlNEc29iRHRsYW5zbllBZzdMMlk3SWFVSU95d3ZleWR0Q0RyaGJqc3RwenJrS2dnNG9DVUlPeUxwT3k0b1NrdUNpQWdJQ0F2THlCWGFXNWtiM2R6N0plUTdJU2dJR1JsZEdGamFHVmtJT3lYaHV5ZHRPdVBoQ0RydG9EcnFxZ282ckNRN0l1YzdKNlFLZXF3Z0NEc283M3NsclRyajRRZzdKNlE3SXVkN0oyQUlPeUN0T3lWaE91Q3FPdUtsT3VMcEM0S0lDQWdJSEJ5YjJNZ1BTQnpjR0YzYmlod2NtOWpaWE56TG1WNFpXTlFZWFJvTENCYmNHRjBhQzVxYjJsdUtGOWZaR2x5Ym1GdFpTd2dKMk5zWVhWa1pTMWljbWxrWjJVdWFuTW5LVjBzSUhzS0lDQWdJQ0FnWTNka09pQlNUMDlVTENCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsTEFvZ0lDQWdmU2s3Q2lBZ2ZTQmxiSE5sSUhzS0lDQWdJQzh2SUcxaFkwOVRMK3Vtck91SWhleUtwRG9nNnJDUTdJdWM3SjZRNjZXOElPdWRoT3lhdENCdWIyUmxJT3lMcE8yV2lTRHRqSXpzbmJ6cm9ad2c3S2VCN0tDUklPeUtwTzJQc0NBb2JHRjFibU5vWkNEdG1aanFzcjNzbDVRZ1VFRlVTT3F3Z0NEcnVZanNsYjN0bGFBZzdJaVlJT3llaU95V3RDRHNvSWpyaklEcXNyM3JvWndnN0lLczdKcXBLUW9nSUNBZ2NISnZZeUE5SUhOd1lYZHVLSEJ5YjJObGMzTXVaWGhsWTFCaGRHZ3NJRnR3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBblkyeGhkV1JsTFdKeWFXUm5aUzVxY3ljcFhTd2dld29nSUNBZ0lDQmpkMlE2SUZKUFQxUXNJR1JsZEdGamFHVmtPaUIwY25WbExDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0NpQWdJQ0I5S1RzS0lDQjlDaUFnY0hKdll5NTFibkpsWmlncE95QXZMeURxc0pEc2k1enNucEFnN0oyMDY3S2s3WXE0SU91anFPMlVoT3lYa095RW5DRHJ0b1RycHF3Z0tPcXdrT3lMbk95ZWtDRHNvb1hybzR6cnBid2c2NmVKN0tlQUlPeVZpdXF5akNrS2ZRb0tMeThnN0oyMElGQkQ2Nlc4SUNmc2hLVHN1WmdnN0tDRUtPeURpQ0JRUXlrbklPeURnZTJEbk91aG5DRHJrSmpyajR6cnByRHJpNlFnNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0JiN0xTSTZyaXc3Wm1VWFNEcnNvVHRpcndvVUU5VFZDQXZkVzVwYm5OMFlXeHNLZXlkdENEcnRvRHJwYmpyaTZRdUNpOHZJSEpsWjJsemRHVnlMWEJ5YjNSdlkyOXNMbXB6NnJDQUlPeUVwT3k1bU8yVm5DRHFzb1BzbllRZzZyZTQ2NHlBNjZHY0lPdVFtT3VQak91bXNPdUxwRG9nNnJDUTdJdWM3SjZRSU95ZWtPdVBtZXlMbk95ZWtTQXJJQ2pzbm9qc25MenJxYlFwSU95RXBPeTVtQ0R0ajdUcmpaUXVDaTh2SU9LYW9PKzRqeURyc0pqcms1enNpNXdnU0ZSVVVDRHNuWkhyaTdYc25ZUWc2Nmk4N0tDQUlPdXp0T3VDdUNEcmtxUWc3Wmk0N0xhYzdaV2dJT3F5Z3lEaWdKUWdiV0ZqVDFNZ2JHRjFibU5vWTNSc0lHSnZiM1J2ZFhUc25iUWc3SjIwSU8yVWhPdWhuT3lFdU95S3BPdWx2Q0RzcG9uc2k1d2c3S0tGNjZPTTdJdWM3WUtzSU95SW1DRHNub2pyaTZRdUNpOHZJQ0FnSU9xM3VPdWVtT3lFbkNEdGpJenNuYndvY0d4cGMzVEN0K3lFcE95NW1DRHRqN1RyalpRcDdKMkVJR3hoZFc1amFHTjBiT3V6dE91THBDRHJxTHpzb0lBZzdLZUE3SnEwNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc283M3NsNnpyajRRZzdKNlE2NCtaN0l1YzdKNlI3SjJBSU95ZHRPdXZ1Q0RzZ3F6cm5ienNwNFRyaTZRdUNtWjFibU4wYVc5dUlIVnVhVzV6ZEdGc2JGTmxiR1lvS1NCN0NpQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlGdGRPd29nSUhSeWVTQjdDaUFnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjJSaGNuZHBiaWNwSUhzS0lDQWdJQ0FnWTI5dWMzUWdURUZDUlV3Z1BTQW5ZMjl0TG1Oc1lYVmtaV0p5YVdSblpTNTNZWFJqYUdWeUp6c0tJQ0FnSUNBZ1kyOXVjM1FnY0d4cGMzUWdQU0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5UR2xpY21GeWVTY3NJQ2RNWVhWdVkyaEJaMlZ1ZEhNbkxDQk1RVUpGVENBcklDY3VjR3hwYzNRbktUc0tJQ0FnSUNBZ1kyOXVjM1FnYVc1emRDQTlJSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDZE1hV0p5WVhKNUp5d2dKMEZ3Y0d4cFkyRjBhVzl1SUZOMWNIQnZjblFuTENBblEyeGhkV1JsUW5KcFpHZGxKeWs3Q2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktIQnNhWE4wS1NrZ2V5Qm1jeTUxYm14cGJtdFRlVzVqS0hCc2FYTjBLVHNnY21WdGIzWmxaQzV3ZFhOb0tIQnNhWE4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwS0lDQWdJQ0FnZEhKNUlIc2dhV1lnS0daekxtVjRhWE4wYzFONWJtTW9hVzV6ZENrcElIc2dabk11Y20xVGVXNWpLR2x1YzNRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbExDQm1iM0pqWlRvZ2RISjFaU0I5S1RzZ2NtVnRiM1psWkM1d2RYTm9LR2x1YzNRcE95QjlJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRb2dJQ0FnSUNCMGNua2dleUJ6Y0dGM2JsTjVibU1vSjJ4aGRXNWphR04wYkNjc0lGc25ZbTl2ZEc5MWRDY3NJQ2RuZFdrdkp5QXJJSEJ5YjJObGMzTXVaMlYwZFdsa0tDa2dLeUFuTHljZ0t5Qk1RVUpGVEYwc0lIc2djM1JrYVc4NklDZHBaMjV2Y21VbklIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2UzMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0Nkc1lYVnVZMmhqZEd3bkxDQmJKM0psYlc5MlpTY3NJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUW9nSUNBZ2ZTQmxiSE5sSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3Q2lBZ0lDQWdJSFJ5ZVNCN0lITndZWGR1VTNsdVl5Z25jbVZuSnl3Z1d5ZGtaV3hsZEdVbkxDQW5TRXREVlZ4Y1UyOW1kSGRoY21WY1hFMXBZM0p2YzI5bWRGeGNWMmx1Wkc5M2MxeGNRM1Z5Y21WdWRGWmxjbk5wYjI1Y1hGSjFiaWNzSUNjdmRpY3NJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5Snl3Z0p5OW1KMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE95QnlaVzF2ZG1Wa0xuQjFjMmdvSit5ZWtPdVBtZXlMbk95ZWtTaERiR0YxWkdWQ2NtbGtaMlZYWVhSamFHVnlLU2NwT3lCOUlHTmhkR05vSUNoZlpTa2dlMzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KMk5zWVhWa1pXSnlhV1JuWlRvdkx5RHJrN0hyb1owbktUc2dmU0JqWVhSamFDQW9YMlVwSUh0OUNpQWdJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lDQWdZMjl1YzNRZ2FXNXpkQ0E5SUhCaGRHZ3VhbTlwYmlod2NtOWpaWE56TG1WdWRpNU1UME5CVEVGUVVFUkJWRUVnZkh3Z2NHRjBhQzVxYjJsdUtHOXpMbWh2YldWa2FYSW9LU3dnSjBGd2NFUmhkR0VuTENBblRHOWpZV3duS1N3Z0owTnNZWFZrWlVKeWFXUm5aU2NwT3dvZ0lDQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlFvZ0lDQWdJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2UzMEtJQ0FnSUgwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpQm1ZV2xzTFhOdlpuUWc0b0NVSU91cXV5RHNwNERzbXJRZzZyS01JT3llaU95V3RPdVBoQ0R0bEl6cm42enF0N2pzbmJnZzdLcTlJT3E0c095V3RTRHNncTNzb0p6cmlwUWc3SjIwNjYrNElPdUJuZXVDck91THBDQXFMeUI5Q2lBZ2NtVjBkWEp1SUhKbGJXOTJaV1E3Q24wS0NpOHZJT3VMcE91bXJDZ3hNVGc0T0NucXNJQWc2NWFnSU95ZWlPeWN2T3VwdENEcmdZanJpNlFnNG9DVUlPeTBpT3E0c08yWmxDRHNpNXdnNjRLbzdKMkFJT3lFdU95Rm1DRHNvSlhycHF3Z0tPeVhodXljdk91cHRDRHNvYkRzbXFudG5vZ2c3SXVrN1l5b0tRcG1kVzVqZEdsdmJpQnphSFYwWkc5M2JrSnlhV1JuWlNncElIc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdjaUE5SUdoMGRIQXVjbVZ4ZFdWemRDaDdJR2h2YzNRNklDY3hNamN1TUM0d0xqRW5MQ0J3YjNKME9pQXhNVGc0T0N3Z2NHRjBhRG9nSnk5emFIVjBaRzkzYmljc0lHMWxkR2h2WkRvZ0oxQlBVMVFuTENCMGFXMWxiM1YwT2lBeE5UQXdJSDBzSUNncElEMCtJSHQ5S1RzS0lDQWdJSEl1YjI0b0oyVnljbTl5Snl3Z0tDa2dQVDRnZTMwcE93b2dJQ0FnY2k1dmJpZ25kR2x0Wlc5MWRDY3NJQ2dwSUQwK0lIc2dkSEo1SUhzZ2NpNWtaWE4wY205NUtDazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZTQjlLVHNLSUNBZ0lISXVaVzVrS0NrN0NpQWdmU0JqWVhSamFDQW9YMlVwSUh0OUNuMEtDbU52Ym5OMElITmxjblpsY2lBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtDaHlaWEVzSUhKbGN5a2dQVDRnZXdvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5UMUJVU1U5T1V5Y3BJSHNnY21WekxuZHlhWFJsU0dWaFpDZ3lNRFFzSUVOUFVsTmZTRVZCUkVWU1V5azdJSEpsZEhWeWJpQnlaWE11Wlc1a0tDazdJSDBLSUNCcFppQW9jbVZ4TG5WeWJDQTlQVDBnSnk5b1pXRnNkR2duS1NCN0NpQWdJQ0F2THlCMk9pRHFzSkRzaTV6c25wQWc3TDJVNjVPY0lPdXloT3lnaENEaWdKUWc2cldzNjdLRTdLQ0VJTzJVaE91aG5PeUV1T3lLcE9xd2dDRHFzNFRzaG8wZzY0K002ck9nSU95ZWlPdUtsT3luZ0NEcnNKYnNsNURzaEp3ZzdabVY3SjI0N1pXWTY0cVVJT3lhcWV1UGhBb2dJQ0FnTHk4Z0tIWXlJRDBnN0xDOUlPeUlxT3E1Z0NEc2lKanNvSlh0akpBc0lIWXpJRDBnTDJGalkyOTFiblFnN0xhVTZyQ0E3WXlRTENCMk5DQTlJQzkxYm1sdWMzUmhiR3dnN0xhVTZyQ0E3WXlRTEFvZ0lDQWdMeThnSUhZMUlEMGc2ck9FN0tDVjdKMkVJT3lla09xeXFleW1uZXVxaFNEc25LRHJyTFRyb1p3ZzdZeVE3S0NWSU9LQWxDRHJvWnpxdDdqc2xZVHNtNE1nNjVLa0lPdUNxT3lkZ0NEc25iVHJxWlRzbmJ6c25ZUWc2NkdjNnJlNDdKMjQ3Snk4NjZHY0lPeVlwTzJWdE8yVm1PeW5nQ0RzbFlycXNvd3BDaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnZDJGMFkyaGxjam9nZEhKMVpTd2dkam9nTmlCOUtUc0tJQ0I5Q2lBZ0x5OGc3SjIwSUZCRDdKZVFJT3Vobk9xM3VPeWR1T3VRbkNEdGdiVHJvWnpyazV3ZzZyT0U3S0NWSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnN0xLcklPMlpsT3VwdE1LMzdabUk3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbE95bmdDSWc2N08wN0plczdLTzg2NHFVSU91TnNDRHNrN1RyaTZRdUNpQWdMeThnNnJDUTdJdWM3SjZRNnJDQUlPdUx0ZTJWbU91S2xDRHNuYlRzbktBNklPdUxwT3Vtck91bHZDRHN2SnpycWJRZzdKdU02N0NON0plRjdKeTg2NkdjSU8yQnRPdWhuT3VUbk9xd2dDRHNpNlRzb0p3ZzdaaTQ3TGFjNjQrOElPcTFyT3VQaFNEc2dxenNtcW5ybjRuc25iUWc2NEtZNnJDRTY0dWtMZ29nSUM4dklPcXdrT3lMbk95ZWtPdUtsQ0R0akl6c25ienJwNHdnN0oyOTdKeTg2NitBNjZHY0lPeUNyT3lhcWV1ZmlTQXdJTUszSU91TWdPcTRzQ0F3SU9LQWxDRHFzb0R0aHFEcnA0d2c3Sk93NjRxVUlPeUNyT3Vlak95WGtPcXlqQ0RydVlUc21xbnNuWVFnNjZ5ODY2YXM3S2VBSU95Vml1dUtsT3VMcEM0S0lDQXZMeURzbzd6c25aZzZJT3lYck9xNHNDRHFzNFRzb0pYc25iUWc2N08wN0plczY0K0VJT3llaGV5ZXBlcTJqT3lkdENEcnA0enJvNHpya0pEc25ZUWc3SWlZSU95ZWlPdUxwQ2pzbktEdG1xanNoTEhzbllBZzdJdWs3S0NjSU8yWXVPeTJuQ0RybFl6cnA0d2c3SldNSU95SW1DRHNub2pzbll3ZzRvQ1VJT3VMcE91bXJDQXZhR1ZoYkhSbzdKMllJSEJ5YjJKc1pXMGc3TEM0NnJPZ0tTNEtJQ0JwWmlBb2NtVnhMblZ5YkNBOVBUMGdKeTloWTJOdmRXNTBKeWtnZXdvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3Z1kyeGhkV1JsT2lCb1lYTkRiR0YxWkdVb0tTQjlLVHNLSUNCOUNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzZGhhMlVuS1NCN0NpQWdJQ0JwWmlBb0lXaGhjME5zWVhWa1pTZ3BLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nWm1Gc2MyVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5Y2dmU2s3Q2lBZ0lDQjNZV3RsUW5KcFpHZGxLQ2s3Q2lBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2QyRnJhVzVuT2lCMGNuVmxJSDBwT3dvZ0lIMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjMmgxZEdSdmQyNG5LU0I3Q2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdDaUFnSUNCeVpYUjFjbTQ3Q2lBZ2ZRb2dJQzh2SU95MGlPcTRzTzJabENEaWdKUWc3SjIwSUZCRDY2VzhJQ2ZzZzRnZ1VFTW5JT3lEZ2UyRG5PdWhuQ0Rya0pqcmo0enJwckRyaTZRZ0tPMlVqT3Vmck9xM3VPeWR1Q0JiN0xTSTZyaXc3Wm1VWFNEcnNvVHRpcndwTGdvZ0lDOHZJT3lka2V1THRleWRoQ0RycUx6c29JQWc3WjJZNjZDazY3TzA2NEs0SU91U3BDRHNvSlhycHF6dGxaenJpNlFnNG9DVUlHSnZiM1J2ZFhUc25iUWc3SnF3NjZhczY2VzhJT3ltaWV5TG5DRHNvNzNzbDZ6cmo0UWc3WnFNN0l1ZzdKMkFJT3VQaE95d3FlMlZuT3VMcEM0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmRXNXBibk4wWVd4c0p5a2dld29nSUNBZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2NHeGhkR1p2Y20wNklIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ2ZTazdDaUFnSUNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhzS0lDQWdJQ0FnYzJoMWRHUnZkMjVDY21sa1oyVW9LVHNLSUNBZ0lDQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlIVnVhVzV6ZEdGc2JGTmxiR1lvS1RzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHN0SWpxdUxEdG1aUW9kVzVwYm5OMFlXeHNLU0RpZ0pRZzdLQ2M2ckd3T2ljc0lISmxiVzkyWldRdWFtOXBiaWduTENBbktTQjhmQ0FuS095WGh1eWRqQ2tuS1RzS0lDQWdJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJREl3TUNrN0NpQWdJQ0I5TENBeU5UQXBPd29nSUNBZ2NtVjBkWEp1T3dvZ0lIMEtJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TkN3Z2V5Qmxjbkp2Y2pvZ0owNXZkQ0JtYjNWdVpDY2dmU2s3Q24wcE93b0tMeThnN0oyMDY2KzRJT3VXb0NEc25vanNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeWloZXVqakNBbzdKNlE2NCtaSU95TG5PeWVrU0FySUc1d2JTQmlkV2xzWkNEc3BKSHJzN1VnN0l1azdaYUpJT3VNZ091NWhDa0tjMlZ5ZG1WeUxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQjdDaUFnYVdZZ0tHVWdKaVlnWlM1amIyUmxJRDA5UFNBblJVRkVSRkpKVGxWVFJTY3BJSEJ5YjJObGMzTXVaWGhwZENnd0tUc0tJQ0J3Y205alpYTnpMbVY0YVhRb01TazdDbjBwT3dwelpYSjJaWEl1YkdsemRHVnVLRkJQVWxRc0lDY3hNamN1TUM0d0xqRW5MQ0FvS1NBOVBpQjdDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHRnYlRyb1p6cms1d2c2NHVrNjZhc0lPcXdrT3lMbk95ZWtDRHN2SnpzcDVBZzRvQ1VJR2gwZEhBNkx5OXNiMk5oYkdodmMzUTZKeUFySUZCUFVsUXBPd3A5S1RzS0x5OGdTVkIyTmlEcm82anRsSVRyc0xFb09qb3hLZXlYa091UGhDRHRsYWpxdTVnZzY1T2o2NHFVNjR1a0lPS0FsQ0FuYkc5allXeG9iM04wSitxd2dDQTZPakhyb1p3ZzY2aTg3S0NBSU8yVnRPeUVuZXVRbU91S2xDRHRtWmpxc3Izc2w1RHNoSndLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlFbFFkalRyb1p3ZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDRHJpNlRycHF3ZzZybW83SnF3NnJpd3dyZnFzNFRzb0pVZzdLR3c3WnFNNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJqWmdnNjZ5NDdLQ2NJT3VNZ095ZGtTanJpNlRycHF6c21ZQWc2NCtaN0oyOEtTNEtZMjl1YzNRZ2MyVnlkbVZ5TmlBOUlHaDBkSEF1WTNKbFlYUmxVMlZ5ZG1WeUtITmxjblpsY2k1c2FYTjBaVzVsY25Nb0ozSmxjWFZsYzNRbktWc3dYU2s3Q25ObGNuWmxjall1YjI0b0oyVnljbTl5Snl3Z0tDa2dQVDRnZTMwcE95QXZMeUE2T2pIc25ZUWc2NnE3SU95ZW9leVZoT3VQaENoRlFVUkVVa2xPVlZORndyZEpVSFkySU95WGh1eWRqQ2tnU1ZCMk5PdW5qT3ljdk91aG5DRHFzNFRzaG8wZzY0K1o3SjZSQ25ObGNuWmxjall1YkdsemRHVnVLRkJQVWxRc0lDYzZPakVuS1RzSycKQjY0X0VYQU1QTEVTPSdJeURyckxqcXRhd2c3TGFVN0xLY0lPeVlpT3lMbkFvS0l1dXN1T3ExckNEc3RwVHNzcHpyc0p2cXVMQWk2ckNBSU95Q3JPeWFxZTJWbU91S2xDRHNtSWpzaTV3ZzY2cW83SjJNN0o2RjY0dUk2NHVrTGlBcUt1eWR0Q0R0akl6c25ienNuWVFnN0lpWTdLQ1Y3WldjSU91U3BDRHRoTERycjdqcmhKRHNsNURzaEp3Z1lHNXdiU0J5ZFc0Z1luVnBiR1JnNjZXOElPeUxwTzJXaWUyVm1PcXpvQ3dnUm1sbmJXSHNsNURzaEp3ZzdaU002NStzNnJlNDdKMjQ3SjJFSU91THBPeUxuQ0RzaTZUdGxvbnRsWmpycWJRZzY3Q1k3SmlCNjVDcDY0dUk2NHVrTGlvcUNnb2pJeURzbnBIc2hMRWc2N0NwNjdLVkNnb3RJT3lZaU95TG5DRHRsWmpyZ3BqcmlwUWdLaXBnSXlNaklPeWJrT3V6dUdBcUtpRHRsWndnN0tTRTZyTzhMQ0RxdDdnZzdKV0U2NTZZSUNvcVlDMGc3TGFVN0xLYzdKV0lZQ29xSU95WHJPdWZyQ0Rxc0p6cm9ad2c3SjIwNjZTRTdLZVI2NHVJNjR1a0xnb3RJT3kybE95eW5PeVZpQ0RzbFlqc2w1RHNoSndnS2lyc3BJVHNuWVFnNjdDVTZyNjQ2ck9nSU95THR1eWN2T3VwdENCZ0lDOGdZQ0FvN0pXZTY1S2tJT3F6dGV1d3NTRHRqNnp0bGFnZzdJcXM2NTZZN0l1Y0tTb3FJT3VobkNEdGtaenNpNXp0bFpqc2hManNtcFF1SU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEcmtaQWc3S1NFNjZHY0lPdXp0T3lYck95bmtldUxpT3VMcEM0S0xTRHNncXpzbXFuc25wRHFzSUFnN0o2RjY2Q2w3WldjSU91c3VPcTFyT3F3Z0NCZzdKdVE2N080WU9xenZDQW82ck8xNjdDeHdyZnJyTGpzbnFYcnRvRHRtTGdnNjZ5MDdJdWM3WldZNnJPZ0tTRHFzSm5xc2JEcmdwZ3NJT3lFbk91aG5DRHRqNnp0bGFqdGxaanJxYlFnNnJlNElPeTJsT3l5bk95VmlPdVRwT3lkaENEcnM3VHNsNnpzcEkzcmk0anJpNlF1Q2kwZzY2ZWs3TG10N1pXZ0lPdVZqQ0FxS3V1bmlPeUtwTzJDdWV1UW5DRHNuYlRycG9RbzdabU5YQ3JyajVrcExDRHNpS3ZzbnBBbzdLQ0U3Wm1VNjdLSTdaaTR3cmNpN0ptNElETHJxb1VpSU91VHNTbnJpcFFnNjZ5MDdJdWNLaXJ0bGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWFsR0FnWUg3cmo3enNtcFJnSUdCKzdKZUc3SmEwN0pxVVlDQmdmdTJWdENEc283enNoTGpzbXBSZ0tRb3RJRExyaTZnZzZyV3M3S0d3T2lBcUt1eXlxeURzcElROTdJT0I3Wm1wSU95RXBPdXFoU0RpaHBJZzY1R1k3S2U0SU95a2hEM3JpNlRzbll3ZzdaYUo2NCtaS2lvbzZyS3c3S0NWN0oyQUlHQis3WldnNnJtTTdKcVVQMkFzSU8yV2lldVBtU0RzbktEcmo0VHJpcFFnWUg3dGxiUWc3S084N0lTNDdKcVVZQ2tLTFNEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0tPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ2tzSU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBbzdKZUc3SmEwN0pxVTRvYVNmdTJWbU91cHRDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDa0tMU0RzdXBEc283enNscnp0bFp3ZzZySzk3SmEwS0g3c2k1enFzcURzbHJUc21wUS80b2FTZnUyVm9PcTVqT3lhbEQ4cExDRHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNDanNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2M0b2FTN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5Da0tMU0Rxc0lUcXNyRHRsWmpxczZBZzdJbXM3SnEwSU91bmtDQW83S0NFN0lhaDRvYVM2N08wNjRLMDY0dWtLU3dnNjdhQTdLQ1ZJT3lEZ2UyWnFldVBoQ0RybExIcmxMSHRsWmpzcDRBZzdKV0s2cktNS0NMc3NMN3F1TEFnN0l1azdZeW9JdUtkakNBaTdMQys3SjJFSU95SW1DRHNsNGJzbHJUc21wUWk0cHlGS1FvS0l5TWc3TGFVN0xLY0lPeVlpT3lMbkFvS0l5TWpJT3luaE8yV2llMlZtT3VObUNEc25wSHNsNFhzbmJRZzdKNkk3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0tlRTdaYUpJT3lra2V5ZHVDRHJnclRzbDYzc25iUWc3SjZJN0phMDdKcVVMaUF2SU95ZHRPeVd0T3lFbkNEc3A0VHRsb250bGFEcXVZenNtcFEvQ2dvakl5TWc2ck8xN0p5Z0lPeWFsT3l5cmV5ZGhDRHN0NmpzaG96dGxaanJxYlFnN0pxVTdMS3RJT3VDdE95WHJleWR0Q0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kzcU95R2pPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXloT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwSU95anZPeUV1T3lhbEM0Z0x5RHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2lNakl5RHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4S0xTRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhLTFNEc2k2RHFzNkFnN0oyMDdKeWc2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0o2VTdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVQ2kwZzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMZ29LSXlNaklPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnN0ptNElETHJxb1hzbDVEcXNvd2c2cmFNN1pXY0lPeUNyZXlnbkNEc2xZenJwcnp0aHFIc25ZUWc3S0NFN0lhaDdaV2c2cm1NN0pxVVB3b3RJT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3RPdWdwT3F6b0NEdGxiVHNtcFF1SUM4ZzdabU5LdXVQbVNnd01UQXRNVEl6TkMwMU5qYzRLU0RyaTVnZzdKbTRJRExycW9Yc2w1RHFzb3dnNjdPMDY0Szg2cm1NN0pxVVB3b3RJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzY0dVlJT3ladUNBeTY2cUY3SmVRNnJLTUlPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdk9xNWpPeWFsRDhLTFNEcXRvenRsWndnN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4S0NpTWpJeURyb1p6cXQ3anNsWVRzbTRNZzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3Vobk9xM3VPeVZoT3liZysyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbGJIc25ZUWc3S0tGNjZPTTdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3lWc2V5ZGhDRHNvb1hybzR6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nN1pXY0lPdXlpQ0RyczREcXNyM3RsWmpycWJRZzY0dWs3SXVjSU91emdPcXl2ZTJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzY0dWs3SXVjSU91d2xPcS9nQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6aE95R2plMlZvT3E1ak95YWxEOEtDaU1qSXlEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpya0tucmk0anJpNlF1SU95MGlPcTRzTzJabE8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmo3enNtcFF1SUM4ZzdMU0k2cml3N1ptVTdaV2c2cm1NN0pxVVB3b0tJeU1qSXlEc2w1RHJuNnpDdCt5THBPMk1xQW9LSXlNaklPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPdUVwTzJLdU95YmpPMkJyT3lYa0NEc2w3RHFzckR0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc2w3RHFzckFnN0lPQjdZT2M2Nlc4SU8yWmxleWR1TzJWbU9xem9DRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ienNpNXpzb0lIc25iZ2c3SmlrNjZXWTZyQ0FJT3V3bk95RG5lMldpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0RzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0k3Wmk0NjZXOElPeWVyT3V3bk95R29lMlZtT3lMcmV5TG5PeVlwQzRLTFNEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95bmdPdUNyT3lXdE95YWxDNGdMeURzbmJqc3BwM3Jzb2p0bUxqcnBid2c2NHVrN0l1Y0lPdXdtK3lWaENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzbHJUc21wUXVJQzhnNjR1azY2VzRJT3F5Z095RGlleVd0T3VobkNEcmk2VHNpNXdnN0xDKzdKV0U2N08wN0lTNDdKcVVMZ29LSXlNaklPeWdsZXV6dE91bHZDRHJ0b2pybjZ6c21LVHNwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNvSlhyczdUcnBid2c2N2FJNjUrczdKaXNJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHRqSXpzbmJ3ZzdKZUY2NkdjNjVPYzdKZVFJT3lMcE8yTXFPMldpT3lLdGV1TGlPdUxwQzRLTFNEdGpJenNuYnpzbllRZzdKaXM2NmFzN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRnTHlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0tDUTZyS0FJT3lra2V5ZWhldUxpT3VMcEM0ZzdKMjA3SnFwN0plUUlPdTJpTzJPdU95ZGhDRHJrNXpyb0tRZzdLT0U3SWFoN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHNoSnpydVlUc2lxVHJwYndnN0tDUTZyS0E3WldZNnJPZ0lPeWVpT3lXdE95YWxDNGdMeURzb0pEcXNvRHNuYlFnNjRHZDY0S1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxZVHNpSmdnN0o2RjY2Q2xJTzJWcmV1cXFleWVoZXVMaU91THBDNEtMU0RxdkswZzdKNkY2NkNsN1pXMDdKVzhJTzJWbU91S2xDRHRsYTNycXFuc25iVHNsNURzbXBRdUNnb2pJeU1qSU9xMmpPMlZuTUszN0lTazdLQ1ZDZ29qSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVBtZXlkbU8yVm1PeW5nQ0RzbFlyc2xZUWc3SjI4NjdhQUlPcTRzT3VLcGV5ZHRDRHNvSnp0bFp6cmtLbnJpNGpyaTZRdUNpMGc3SnlFN0xtWUlPeWdsZXV6dE91bHZDRHRsNGpzbXFudGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3SnlFN0xtWUlPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHNtWVRybzR6Q3QreW5oTzJXaVFvS0l5TWpJT3lnZ095ZXBldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNvSURzbnFYdGxvanNsclRzbXBRdUNnb2pJeU1nNjdPQTZySzk3SUtzN1pXdDdKMjBJT3lnZ2V5YXFldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzNERxc3IwZzY0SzA3SnFwN0oyRUlPeWdnZXlhcWUyV2lPeVd0T3lhbEM0S0NpTWpJeURzb0lUc2hxSHNuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dE91RGlPeVd0T3lhbEM0S0NpTWpJeURyazdIcm9aM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3VUc2V1aG5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1nN0lLdDdLQ2M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lDcmV5Z25PMldpT3lXdE95YWxDNEtDaU1qSXlEdGdiVHJwcjNyczdUcms1enNsNUFnNjdPMTdJS3M2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dGV5Q3JPMldpT3lXdE95YWxDNEtDaU1qSXlEc21wVHNzcTNzbllRZzdMS1k2NmFzSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SnFVN0xLdDdKMkVJT3l5bU91bXJPMlZtT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3lWaU91Q3RNSzM3SnlnNjQrRUNnb2pJeU1nN0lPSTY2R2M3SnEwSU91eWhPeWdoT3lkdENEc3RwenNpNXpya0pqc2w0anNpclhyaTRqcmk2UXVJT3lYaGV1TnNPeWR0TzJLdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVZoT3liZyt1UWtPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1RzbFlqc25ZUWc3SnlFN1pXMElPdTVoT3V3Z091eWlPMll1T3VsdkNEcnM0RHFzcjN0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEc2xZanNvSVR0bFp3ZzdJS3M3SnFwN0oyRUlPeWNoTzJWdENEcnVZVHJzSURyc29qdG1ManJwYndnNjdDVTZyK1VJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc2N08wN0pXSUlPeUVuT3U1aE95S3BBb0tJeU1qSU9xeXZldTVoT3VsdkNEcXNKenNpNXp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzZySzk2N21FNjZXOElPeUxuT3lla2UyVm9PcTVqT3lhbEQ4S0NpTWpJeURxc3IzcnVZVHJwYndnN1pXMDdLQ2M3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU9xeXZldTVoT3VsdkNEdGxiVHNvSnp0bGFEcXVZenNtcFEvQ2dvakl5TWc2cml3NnJpdzZyQ0FJT3lZcE8yVWhPdWR2T3lkdUNEc2c0SHRnNXpzbm9Ycmk0anJpNlF1SU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc25ZUWc3Wm1WN0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU9xNHNPcTRzT3F3Z0NEcmhLVHRpcmpzbTR6dGdhenNsNUFnN0pldzZyS3c2NCs4SU95ZWlPeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyaXc2cml3N0oyWUlPeVhzT3F5c0NEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21JSHNnNEhzbllRZzY3YUk2NStzN0ppazY0cVVJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKaUI3SU9CN0oyRUlPdTJpT3Vmck95WXBPcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95M3FPeUdqTzJWbU95THBDRHFzcjNzbXJBZzdJdWc3TEt0N1pXWTdJdWdJT3VDdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXdnQ0Rzbm9qcmdwanNtcFEvQ2dvakl5TWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdWx2Q0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTTY0cVVJT3lXdk91bmlPeWR1T3F3Z095YWxEOEtDaU1qSXlEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvY2c2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1Q2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUhJT3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsWmpzaTV6cXNxRHNsclRzbXBRL0NpMGc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOEtDaU1qSXlEc2k1enNucEh0bFpqc2k1enJpcFFnNjdhRTdKZVE2cktNSURVc01EQXc3SnVRN0oyRUlPdVRuT3VncE95YWxDNEtMU0RzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMZ29LSXlNaklPeWR0T3lla0NEdG1aanJ0b2pzbllRZzY3Q2I3SldZN0phMDdKcVVMZ290SU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRdUNnb2pJeU1nN0ppazY0cVk3SjJZSU8yQXRPeW1pT3F3Z0NEcXM2Y2c3S0tGNjZPTTY0Kzg3SnFVTGdvdElPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEM0S0NpTWpJeURxdUlqc25ienF1WXpzcDRBZzY2KzQ2NEtwSU95TG5DRHNsN0Rzc3JRZzdMS1k2NmFzNjVDcDY0dUk2NHVrTGlEdG00VHJ0b2pxc3JEc29Kd2c2cmlJN0pXaDdKMkVJT3VDcWV1MmdPMlZtT3lMbk9xNHNDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdKaWs2NHFZNnJtTTdLZUFJT3VDdE95bmdDRHNsWXJzbkx6cnFiUWc3SmV3N0xLMDY0Kzg3SnFVTGlBdklPMmJoT3UyaU9xeXNPeWduQ0RxdUlqc2xhSHNuWVFnNjRLMDdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2tPcXlnQ0RxdUxEcXNJVHNsNURyaXBRZzdJU2M2N21FN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHNuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkdENEcmhibnNuWXpya0tucmk0anJpNlF1Q2kwZzY0MlVJT3lpaSt5ZGdDRHNnNEhyaTdUc25ZUWc3SnlFN1pXMElPMkd0ZTJabENEcmdyVHNtcW5zbllBZzY0VzU3SjJNNjQrODdKcVVMZ29LSXlNaklPcXpvT3F3bmV1TG1PeWRtQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkZ0NEcXVMRHJvWjBnNnJTQTY2YXM2NUNwNjR1STY0dWtMZ290SU95ZHRPeWduT3UyZ08yRXNDRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWR0Q0RxdUxEcm9aM3JqN3pzbXBRdUNnb2pJeU1nN0xLdDdJYU02NFdFN0oyQUlPeUVuT3U1aE95S3BDRHFzSURzbm9Yc25iUWc2N2FJNnJDQTdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YWxDNEtDaU1qSXlNZzZyT0U3S0NWd3Jmc25vWHJvS1VLQ2lNakl5RHNsWVRzbmJUcmxKUWc2NWlRNjRxVUlPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3lkdE95RGdTRHNucGpycXJzZzdKNkY2NkNsN1pXWTdKZXNJT3F6aE95Z2xleWR0Q0RzbnFEcXVJZ2c3TEtZNjZhczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTVoT3V3Z091eWlPMll1T3VsdkNBMTdacU1JT3llbU91cXV5RHNub1hyb0tYdGxiVHNoSndnNnJPRTdLQ1Y3SjIwSU95ZW9PcXl2T3lXdE95YWxDNGdMeURydVlUcnNJRHJzb2p0bUxqcnBid2c3SjZzN0lTazdLQ1Y3WldZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNuYlRycjdnZzdJS3M3SnFwSU95a2tleWR1Q0RzbFlUc25iVHJsSlRzbm9Ycmk0anJpNlF1Q2kwZzdKMjA2Nis0SU95VHNPcXpvQ0Rzbm9qcmlwUWc3SldFN0oyMDY1U1U3SmlJN0pxVUxpQXZJT3VMcE91bHVDRHNsWVRzbmJUcmxKVHJwYndnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzM2cml3N1lPQUNnb2pJeU1nN1l5TTdKMjhJT3lhcWV1ZmlleWR0Q0RzdElqcXM3enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlERXdUVUlnN0oyMDdaV1k3SjJZSU8yTWpPeWR2T3VuakNEc2w0WHJvWnpyazV3ZzZyQ0E2NHFsN1pXcDY0dUk2NHVrTGdvdElERXdUVUlnN0oyMDdaV1lJTzJNak95ZHZPdW5qQ0RzbUt6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHRqSXpzbmJ3ZzdKcXA2NStKN0oyRUlPMlpsZXlkdU8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0dWs3SnEwNjZHYzY1T2M2ckNBSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyaTZUc21yVHJvWnpyazV6cnBid2c2NmVJN0xPazdKYTA3SnFVTGdvS0l5TWpJT3F5c095Z25PeVhrQ0RzaTZUdGpLanRsWmpzbUlEc2lyWHJpNGpyaTZRdUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEcXNyRHNvSnp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPcXlzT3lnbkNEc2lKanJpNmpzbllRZzdabVY3SjI0N1pXWTZyT2dJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXWTdKZXNJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXp0ZXF3aE95ZGhDRHRtWlhyczdUdGxad2c2NUtrSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lFbk91NWhPeUtwQ0RzcElEcnVZUWc3S1NSN0o2RjY0dUk2NHVrTGdvdElPeWtnT3U1aE8yVm1PcXpvQ0Rzbm9qcmlwUWc2cml3NjRxbDdKMjA3SmVRN0pxVUxpQXZJT3loc09xNGlPdW5qQ0RxdUxEcmk2VHJvS1FnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3VUc2V1aG5TRHFzSURyaXFYdGxad2c3TFdjNjR5QUlPcXduT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPeWdoTzJabU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPdXdsT3EvZ09xNWpPeWFsRDhLQ2lNakl5RHJzS25yckxnZzdKaUk3Slc5N0oyMElPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnNLbnJyTGdnN0ppSTdKVzk3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEcnVZVHJzSURyc29qdG1MZ2dOZTJhakNEc21LVHJwWmpyb1p3ZzZyT0U3S0NWN0oyMElPeWVvT3E0aUNEc3NwanJwcXpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJRFh0bW93ZzdKNlk2NnE3SU95ZWhldWdwZTJWdE95RW5DRHFzNFRzb0pYc25iUWc3SjZnNnJLODdKYTA3SnFVTGlBdklPdTVoT3V3Z091eWlPMll1T3VsdkNEc25xenNoS1Rzb0pYdGxaanJxYlFnNjR1azdJdWNJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd0lDanNsNGJzbHJUc21wUWc0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFwQ2dvakl5TWc2N080N0oyNElPeWR1T3ltbmV5ZGhDRHRsWmpzcDRBZzdKV0s3Snk4NjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEcnM3anNuYmdnN0oyNDdLYWQ3SjJFSU8yVm1PdXB0Q0RycXFqcms2QWc3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeWR0T3VwbE95ZHZDRHNuYmpzcHAwZzdLQ0U3SmVRNjRxVUlPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU95ZHRPdXBsT3lkdkNEc25ianNwcDNzbllRZzY2ZUk3TG1ZNjZtMElPdWhuT3EzdU95ZHVPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95L29PMlBzT3lkZ0NEcm9aenF0N2pzbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjBJT3lnbk8yVm5PdVFxZXVMaU91THBDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXWTY2bTBJT3VxcU91VG9DRHF1TERyaXFYc25ZUWc3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzY3aVU2Nk9vN1lpczdJcWs2ckNBSU9xNnZPeWd1Q0Rzbm9qc2xyUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU91NGxPdWpxTzJJck95S3BPdWx2Q0Rzdkp6cnFiUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU91NWhPeURnU0RzbDdEcm5iM3NzcGpxc0lBZzY1T3g2NkdkNjVDWTdLZUFJT3lWaXV5Vm1PeUt0ZXVMaU91THBDNEtMU0RydVlUc2c0RWc3SmV3NjUyOTdMS1k2Nlc4SU91VHNldWhuZTJWbU91cHRDRHF1TFRxdUludGxhQWc2NVdNSU91NW9PdWx0T3F5akNEc2w3RHJuYjNyazV6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzdHB6c25vVWc3TG0wNjVPYzZyQ0FJT3VUc2V1aG5ldVFtT3luZ0NEc2xZcnNsWVFnN0lLczdKcXA3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdMYWM3SjZGSU95NXRPdVRuT3VsdkNEcms3SHJvWjN0bFpqcnFiUWc2N0NVNjZHY0lPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSXlEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0lDanNtWVRybzR3ZzdKV0k2NEswS1FvS0l5TWpJTzJhak95YmtPcXdnT3llaGV5ZHRDRHNtWVRybzR6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzZyQ0E3SjZGN0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHNtSWpzbGIzc25iUWc3TGVvN0lhTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeVlpT3lWdmV5ZGhDRHN0NmpzaG96dGxvanNsclRzbXBRdUNnb2pJeU1nNjZ5NDdKMlk2ckNBSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SWljN0xDbzdLQ0I3Snk4NjZHY0lPdUx0ZXV6Z091VG5PdW1yT3F5b095S3RldUxpT3VMcEM0S0xTRHJyTGpzblpqcnBid2c3S0NSN0lpWTdaYUk3SmEwN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTA2NWFrSU91d3FldXlsZXljdk91aG5DRHNuYmpzcHAzdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SjI0N0thZElPdXdxZXV5bGV5ZGhDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPcXlzT3lnbk8yVm1PeUxwQ0RzdWJUcms1enJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rxc3JEc29KenRsYUFnN0xtMDY1T2M2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0p1UTdaV1k3SXVjNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsWmpzaExqc21wUXVDaTBnN0p1UTdaV1k2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWp2T3lHak91bHZDRHNsWXpxczZBZzZyT0U3SXVnNnJDQTdKcVVQd290SU95anZPeUdqT3VsdkNEc2xZenFzNkFnN0o2STY0S1k3SnFVUHdvS0l5TWpJeURycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQW9LSXlNaklPcTRzT3F3aENEcnA0enJvNHpyb1p3ZzdKMjA3SnFwN0oyMElPeWtrZXluZ091UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc25iVHNtcWtnNnJpdzZyQ0U3SjIwSU91Qm5ldUNtT3lFbkNEc3A0RHF1SWpzbllBZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUNnb2pJeU1nN0pxcDY1K0pJT3UyZ095aHNleWN2T3VobkNEc29JRHNucVhzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95Z2dPeWVwZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1Q2dvakl5TWc3WWExN0l1Z0lPeVlwT3VsbU91aG5DRHNtcFRzc3Ezc25iUWc3SXVrN1l5bzdaV1k3SmlBN0lxMTY0dUk2NHVrTGdvdElPMkd0ZXlMb095ZHRDRHNtNUR0bVp6dGxaanNwNEFnN0pXSzdKV0VJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95anZPeUdqT3VsdkNEdG1aWHNuYmp0bFpqcXNiRHJncGdnN1ptSTdKeTg2NkdjSU95ZHRPdVBtZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjQrWjdKMjg3WldjSU95YWxPeXlyZXlkdENEc3NwanJwcXdnN0tTUjdKNkY2NHVJNjR1a0xpRHNucURzaTV3ZzdadUVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc2ckNaN0oyQUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanFzNkFnN0o2STdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYlRyc3FUdGlyanFzSUFnN0tLRjY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdE91eXBPMkt1T3F3Z0NEcmdaM3JncXpzbHJUc21wUXVDZ29qSXlNZzdZT0k3WWUwSU95TG5DRHJxcWpyazZBZzY0Mnc3SjIwN1lTdzZyQ0FJT3lDcmV5Z25PdVFtT3Vwc0NEcnM3WHF0YXp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHRnNGp0aDdUdGxaanJxYlFnNjZxbzY1T2dJT3VOc095ZHRPMkVzT3F3Z0NEc2dxM3NvSnpya0pqcXM2QWc2NHVrN0l1Y0lPdVFtT3VQak91bXRDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWdsZXVua0NEdGc0anRoN1R0bGFEcXVZenNtcFEvQ2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3lEZ2UyWnFTRHNsWWpyZ3JRcENnb2pJeU1nNjdhQTdKNnNJT3lra1NEcnNLbnJyTGpzbnBEcXNJQWc2ckNRN0tlQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdTJnT3llckNEc3BKSHNsNUFnNjdDcDY2eTQ3SjZRNnJDQUlPeWVpT3lYaU95V3RPeWFsQzRnTHlEc21JSHNnNEhzbllRZzdabVY3SjI0N1pXMElPdXp0T3lFdU95YWxDNEtDaU1qSXlEcXNyM3J1WVFnN1pXMDdLQ2NJT3Eyak8yVm5PeWR0Q0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cks5NjdtRUlPMlZ0T3lnbkNEcXRvenRsWnpzbmJRZzdaV0U3SnFVN1pXMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RzbXBUc3NxM3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRtSnp0ZzUwZzdKZUc3SjIwSU9xd2dPeWVoZTJWb09xNWpPeWFsRDhnN0tlQTZyaUlJT3lMb095eXJlMlZtT3luZ0NEc2xZcnNuTHpycWJRZzdKdXc3THUwSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzcDREcXVJZ2c3SXVnN0xLdDdaV1k2Nm0wSU95YnNPeTd0Q0R0bUp6dGc1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0wrZzdZK3dJT3lYaHV5ZHRDRHFzckRzb0p6dGxhRHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1Q0RzdjZEdGo3RHNuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUNpMGc3TCtnN1krdzdKMkVJT3V3bSt5Y3ZPdXB0Q0RyalpRZzdLQ0E2NkMwN1pXWTZyS01JT3F5c095Z25PMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95VmpPdW12Q0RzbDRic25iUWc3SXVjN0o2UjdaV2c2cm1NN0pxVVB5RHNsWXpycHJ6c25ZUWc3THljN0tlQUlPeVZpdXljdk91cHRDRHNwSkhzbXBUdGxad2c3SWFNN0l1ZDdKMkVJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGdvdElPeVZqT3Vtdk95ZGhDRHN2SnpycWJRZzdLU1I3SnFVN1pXY0lPeUdqT3lMbmV5ZGhDRHJzSlRyb1p3ZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdKNlE2NCtaN0oyMDdMSzA2Nlc4SU91VHNldWhuZTJWbU95bmdDRHNsWXJxczZBZzY0U1k3SmEwNnJDSTZybU03SnFVUHlEcms3SHJvWjN0bFpqc3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNucERyajVuc25iVHNzclRycGJ3ZzY1T3g2NkdkN1pXWTY2bTBJTzJWb095ZHVPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURyczdnZzZyT0U3Slc5N0oyWUlPeWNvT3lkdk8yVm5DRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95ZHZPdXdtT3EwZ091bXJPeWVrT3VobkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0nCkI2NF9HVUlERT0nSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5Bb0tJeU1nTVM0ZzdaVzA3SnFVN0xLMENncnNvSnp0a29nZzdKV0k3SjJZSU91cXFPdVRvQ0RyckxqcXRhenJpcFFnSisyVnRPeWFsT3l5dENmcm9ad2c3STJvN0pxVUxncnNuYnpxdElEc2hMRWc3SjZJNjRxVUlPeUNyT3lhcWV5ZWtDRHFzcjN0bDVqc25ZUWc2NmVNNjVPa0lPeUltQ0Rzbm9qcmo0VHJvWjBnS2lyc2c0SHRtYWtzSU91bnBldWR2ZXlkaENEcnRvanJyTGp0bFpqcXM2QWc2NnFvNjVPZ0lPdXN1T3Exck95WGtDRHRsYlRzbXBUc3NyVHJwYndnN0tDQjdKcXA3WlcwN0tPODdJUzQ3SnFVTGlvcUNncnNtSWdwQ2kwZzY3TzA2NE9GNjR1STY0dWtJT0tHa2lEcnM3VHJncnpxc296c21wUUtDaW9xS2dvS0l5TWdNaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0FvSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEc3RaenJqSUR0bFp3Z0tpcnJpcVhyajVudG1KVWc2Nnk0N0o2bEtpcnNuWVFnN0kybzdLTzg3SVM0N0pxVUxpRHNpSmpyajVudG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExURXQ3SWlZNjQrWjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNrN0RyaXBRZzZyS01JT3lpaSt5VmhPeWFsQzRLQ2lNakl5RHJrSkRzbHJUc21wUWc0b2FTSU8yV2lPeVd0T3lhbEFvSzdKaUlLUW90SU95RXBPeWdsZXVRa095V3RPeWFsQ0RpaHBJZzdJU2s3S0NWN1phSTdKYTA3SnFVQ2dvakl5TWdKMzdzbDRnbklPdTV2T3E0c0FvSzdKaUlLUW90SU91d2xPdUFqT3lYaU95V3RPeWFsQ0RpaHBJZzY3Q1U2citvN0phMDdKcVVDZ29qSXlNZzY0K1o3SUtzSU91d2xPcS9sT3lUc09xNHNBb0s3SmlJS1FvdElPdUdrdXlWaE95aGpPeVd0T3lhbENEaWhwSWc3SmlzNjU2UTdKYTA3SnFVQ2dvcUtpb0tDaU1qSURNdUlPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQUtDdXlnbk8yU2lDRHNsWWpzbDVEc2hKd2c2N2FBN0tDVjdLQ0JJT3k3cE91dXBPdUxpT3k4Z095ZHRPeUZtT3lkaENEc3RaenJqSUR0bFp3ZzdLU0U3SjIwNnJPZ0lPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvN0tPODdJUzQ3SnFVTGdycnRvRHNvSlh0bUpVZzY2eTQ3SjZsN0oyQUlGdnNtSWpzbWJnZzZyZWM3TG1aWFNnajdKaUk3Sm00TFRNdDY3YUE3S0NWN1ppVkxldXN1T3llcGV5ZGhDM3NqYWpyajRRdDY1Q1k2NHFVTGVxeXZleWFzQ25zbDVBZzdaVzA2NHU1N1pXZ0lPdVZqT3VuakNEc2phanNtcFF1Q2dyc21JZ2dPaURzbFlnZzY0Kzg3SnFVTENEc2w0YnNsclRzbXBRZ0tGZ3BJT0tHa2lCKzdaV1k2Nm0wSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVSUNoUEtRb0tJeU1qSU95WGh1eVd0T3lhbENEaWhwSWc3SjZJN0phMDdKcVVDZ3JzbUlncENpMGc2N08wN1ppNDdKNlE2ckNBSU8yWGlPdWR2ZTJWbU9xNHNDRHNvSVRzbDVEcmlwUWc2ckNBN0o2RjdaV2dJT3lJbUNEc2w0YnNsclRzbXBRZzRvYVNJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRS0NpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFDZ3JzbDVEcm42d2c3SU9CN1ptcDdKZVE3SVNjNjQrRUlDTHRsYlRxc3JBZzY3Q3A2N0tWSXV5ZGhDRHJxTHpzb0lBZzdKV002NkNrN0tPODY0cVVJT3E0amV5Z2xlMllsU0RxdGF6c29iRHJvWndnN0kybzdKcVVMZ29LN0ppSUtRb3RJT3luZ09xNGlDRHJzb1Rzb0lUc2w1RHNoSnpyaXBRZzdKTzRJT3lJbUNEc2w0YnNsclRzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeVZzZXlkaENEc3RaenNpNkFnNjdLRTdLQ0U3Snk4NjZHY0lPeVhoZXVOc095ZHRPMkt1Q0R0bGJUc283enNoTGpzbXBRdUlPS0draURzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMDdLTzg3SVM0N0pxVUxpRHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2pvNk9pQjBhWEFnN1l5ZDdKZUZJT3V5aE8yS3ZPeWRnQ0JiT0M0ZzdZeWQ3SmVGWFNEcXQ1enN1Wm5zbllRZzY1U3c2NTI4N0pxVUN1Mk1uZXlYaFNqcmk2VHNuYlRzbHJ6cm9aenF0N2dwSU91eWhPMkt2Q0RyckxqcXRhenJpcFFnN0pXRTY1NllJQ29xT0M0ZzdZeWQ3SmVGS2lvZzdJUzU3SVdZSU9xM25PeTVtZXlkaENEcmxMRHJuYnpzbXBRZzRvQ1VJTzJHdGV1enRPdUtsQ0JiN1ptVjdKMjRYU3dnN0ppSUwreVZoT3VMaU95WXBDRHRqSkRyaTZqc25ZQWdXK3lWaE91TGlPeVlwRjNDdDF2cmhLUmRMQ0RyajVuc25wRWc3SnlnNjQrRTY0cVVJRnZzdDZqc2hveGR3cmRiNjQrWjdKNlJYUzRnSXV5M3FPeUdqQ0xyaXBRZzY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1JT3lUc09xem9Dd2dJdXVMcStxNHNDREN0eURyajVuc25wRWk3TEtZNjUrOElPeW5uZXlkdENEc2xZZ2c2NmVlNjRxVUlPeWhzTzJWcWV5ZGdDRHNrN0RzcDRBZzdKV0s3SldFN0pxVUxnbzZPam9LQ2lNakl5RHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic25ZUWc2NVdNQ2dyc21JZ3BDaTBnNjZxbzdKNkU3S2VBN0p1UTZyaUlJT3lYaHV5ZHRDRHJxcWpzbm9UdGhyWHNucVhzbllRZzY2ZU02NU9rNnJtTTdKcVVQeURzcDREcXVJZ2c2N0NiN0tlQUlPeVZpdXljdk91cHRDRHJxcWpzbm9Uc3A0RHNtNURxdUlqc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1SU9LR2tpRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnNjR5QTdJT0JJT3lWaU91Q3RBb0tLaXJzaEp6cnVZVHNpcVRyaXBRZzdKTzRJT3lJbUNEc25vanNwNERycDR3c0lPMkt1ZXlnbFNEdG1KenRnNTNzbllBZzY3Q2I3SjJFSU95SW1DRHNsNGJzbllRZzY1V01JT0tHa2lEcXVJM3NvSlh0bUpVZzY2eTQ3SjZsN0p5ODY2R2NJT3lOcU95YWxDNHFLZ3JzZ3F6c21xbnNucERyaXBRZzY2eTQ2cldzNjZXOElPcTh2T3E4dk8yZWlDRHNuYjNzcDRBZzdKV0s2ck9nSU8yYmtleVd0T3V6dE9xNHNDanNpcVRzdXBRcElPdVZqT3VzdU95WGtDd2c2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeVRzT3VwdENEc29KenRrb2dnN0tDRTdMSzA2Nlc4SU95VHVDRHNpSmdnN0plRzY0dWs2ck9nSU95WXBPMlZ0TzJWbU9xNHNDRHNpYXpzbTR6c21wUXVDZ3JzbUlncENpMGc2ck9FN0tLTUlPcXduT3lFcENEdG1KenRnNTNzbllBZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVJT0tHa2lBMExqVWxJT3E0aU91bXJDRHRtSnp0ZzUzcnA0d2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvcUtpb0tDaU1qSURRdUlPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUUtDdXlnbk8yU2lDRHNsWWpzbDVEc2hKd2dKMzdzaTV6cXNxRHNsclRzbXBRL0p5d2dKK3lMbk91Q21PeWFsRDhuTENBbmZ1cTdtQ2NnNnJDWjdKMkFJT3F6dk91UGhPMlZuQ0Rxc3Izc2xyVHJwYndnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzRLN0xXYzY0eUE3WldjSU95NmtPeWp2T3lXdk8yVm1PcXpvQ0RzdVp6cXQ3enRsWndnNjZlUTdZaXM2Nlc4SU95VHNPdUtsQ0Rxc293ZzdLS0w3SldFN0pxVUxncnFzcjNzbHJUcmlwUWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1pM3FzcjNzbHJUcnBid3Q3STJvNjQrRUxldVFtT3VLbEMzcXNyM3NtckFwN0plUUlPMlZ0T3VMdWUyVm9DRHJsWXpycDR3ZzdJMm83SnFVTGdvS0l5TWpJT3VQbWV5Q3JPeVhrT3lFbkNBbmZ1eUxuQ2NnNjdtODZyaXdDZ3JzbUlncENpMGc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZtT3lMbk9xeW9PeVd0T3lhbEQ4ZzRvYVNJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsYURxdVl6c21wUS9DaTBnN0l1YzdKNlI3WldZN0l1YzY0cVVJT3UyaE95WGtPcXlqQ0ExTERBd01PeWJrT3lkaENEcms1enJvS1RzbXBRdUlPS0draURzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEc25ZUWc2NU9jNjZDazdKcVVMZ29LSXlNaklDZnFzNFRzaTV6cmk2UW5JT0tHa2lBbjdKNkk2NHVrSndvSzdKaUlLUW90SU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc3SjZRNjQrWjdMQ282ckNBSU95ZWlPdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTUlPeVd2T3VuaU95VXFTRHJnclRxczZBZzZyT0U3SXVjNjRLWTdKcVVQeURpaHBJZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91S2xDRHNscnpycDRqc25ianFzSURzbXBRL0lDb282NHVvN0lpY0lPeTVtTzJabU95ZHRDRHNsWVRyaTRqcm5id2c2Nnk0N0o2bDdKMkVJT3lEaU91aG5DRHNrN1FnN0lLczY2R0E3SmlJN0pxVUtTb0tDaU1qSXlBbjdKZXM3SzJJNjR1a0p5RGlocElnSisyWmxleWR1TzJWbU91THBDd2c2Nnk3NjR1a0p3b0s3SmlJS1FvdElPeVZpT3lnaE8yVm5DRHFzSnp0aHJYc25ZUWc3SnlFN1pXMElPdXFoK3F3Z095bmdDRHJpNlRzaTV3ZzdKZXM3SzJrNjdPODZyS003SnFVTGlEaWhwSWc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFINnJDQTdLZUFJT3VMcE95TG5DRHRtWlhzbmJqdGxhRHFzb3pzbXBRdUNnb2pJeU1nSitxN21DY2c0b2FTSUNmc2w1RHFzb3duQ2dyc21JZ3BDaTBnN1ptTjZyaTQ2NCtaNjR1WTZydVlJT3VDb095VmhPcXdnT3F6b0NEc25vanNsclRzbXBRdUlPS0draUR0bVkzcXVManJqNW5yaTVqc2w1RHFzb3dnNjRLZzdKV0U2ckNBNnJPZ0lPeWVpT3lXdE95YWxDNEtDaU1qSXlEcXNyM3NsclRycGJ3ZzY3cVE3SjJFSU91VmpDRHNsclRzZzRudGxad2c2cks5N0pxd0NncnNncXpzbXFuc25wRHNuWmdnN0tDVjY3TzA2Nlc4SU91d20rdUtsQ0RzcDRqcnJManNsNURzaEp3ZzZyaXc2ck9FN0tDQjdKeTg2NkdjSUNkKzdJdWNKK3VsdkNEcnVwRHNuWVFnNjVXTUlPdXN1T3llcGV5ZHRDRHNsclRzZzRudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0tpcnRqSXpzbFlYdGxaanFzNkFnN0l1MjdKMkFJT3lnbGV1enRPdWx2Q0FuN0tPODdKYTBKK3VobkNEc2phanNoSndnNjZ5NDdKNmw3SjJFSU95RGlPdWhyZXF5akNEc2phanJzN1RzaExqc21wUXVLaW9LQ3V5WWlDa0tMU0RzbHJUcmxxUWc2NnFwN0tDQjdKeTg2NkdjSU91TWdPeTJuT3V3bSt5Y3ZPeUxuT3VDbU95YWxEOGc0b2FTSU91TWdPeTJuQ0RycXFuc29JSHNuYlFnNjZ5MDdKZUg3SjI0NnJDQTdKcVVQd290SU95V3RPdVdwQ0RzbmJUc25LRHJvWndnN0l1ZzZyT2c3WldZN0l1YzY0S1k3SnFVUHlEaWhwSWc3SXVnNnJPZ0lPeWR0T3ljb091bHZDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LS2lvcUNnb2pJeUExTGlBbmUrdXFoZXlDckgwZ0t5Qjc2NnFGN0lLc2ZTY2c3Sk93N0tlQUlPeVZpdXE0c0FvS0l5TWpJTzJWbk95ZWtPeVd0Q0R0a29Ec2xyVHNrN0RxdUxBS0N1MlZuT3lla095V3RDRHJxb1hzZ3F6cnBid2c3WktBN0phMDdJU2NJT3VQbWV5Q3JDRHRtSlh0ZzV6cm9ad2c3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ3JzbUlncENpMGc3SjIwN0o2UUlPMlptT3UyaU95ZGhDRHJzSnZzbFpqc2xyVHNtcFFnNG9hU0lPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUUtMU0RyZ3JUc25id2c3TG0wNjVPYzZyQ1M3SjIwSU9xeXNPeWduT3VRb0NEc21JanNvSlhzbmJUc2w1RHNtcFFnNG9hU0lPdUN0T3lkdk95ZGdDRHN1YlRyazV6cXNKSWc2NEtZNnJDQTY0cVVJT3VDb095ZHRPeVhrT3lhbEFvS0l5TWpJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclRzazdEcXVMQWc3SmEwNjZDazdKcTRJT3F5dmV5YXNBb0tKM3ZycW9Yc2dxeDk2ckNBSUh2cnFvWHNncXg5N1pXMDdJU2NKeUR0bUpYdGc1enJvWnpycDR3ZzdaS0E3SmEwN0tTWTY0K0VJT3VObENEc3VwRHNvN3pzbHJ6dGxaanFzb3dnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0o2VTdKV2hJT3UyZ095aHNleWN2T3VobkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVSU9LR2tpRHNucFRzbGFIc25iUWc2N2FBN0tHeDdaVzA3SVNjSU9xMXJPdW5wTzJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFFLQ2lvcUtnb0tJeU1nTmk0ZzdaR2M2cml3SU8yR3RleWR2QW9LSXlNaklPdVFtT3lXdE95YWxDQW9XQ2tnNG9hU0lPdVB2T3lhbENBb1R5a0tDdXVxcU91d2xPeWR2Q0R0bVpUcnFiVHNuWmdnN0tLQjdKMkFJT3F6dGVxd2hPeWRoQ0RxczZEcm9LVHRsYlFnSit1UW1PeVd0T3lhbENmcmlwUWc2NnFvNjVHUUlDZnJqN3pzbXBRbjY2R2NJTzJHdGV5ZHZPMlZ0T3lFbkNEc2phanNvN3pzaExqc21wUXVDZ29xS2lvS0NpTWpJRGN1SU91Q29PeW5uTUszN0l1YzZyQ0V3cmZzaUt2c25wQWc3WkdjNnJpd0NncnJncURzcDV6Q3QreUxuT3F3aE1LMzY3S0k3Wmk0NjRxVUlPeVZoT3VlbUNEdG1KWHNpNTNzbkx6cm9ad2c3WWExN0oyODdaVzA3SVNjSU95TnFPeWFsQzRLQ2lNakl5RHJncURzcDV6Q3QreUxuT3F3aE1LMzZyaXc2ckNFQ2dwOElPMlZyZXVxcVNCOElPMllsZXlMblNCOElPeVlpT3lMbkNCOENud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdLZkNEcmdxRHNwNXdnZkNEcXVMRHJzN2dnWUZsWldWa3VUVTB1UkVSZ0lDOGc3S2VuNnJLTUlHQk5UUzVFUkdBZ2ZDQXlNREkxTGpBeExqQXhMQ0F5TlM0d01TNHdNU0I4Q253ZzdJdWM2ckNFSUh3ZzZyaXc2N080SUdCSVNEcE5UVHBUVTJBZ0x5RHNwNmZxc293Z1lFaElPazFOWUNBbzdKaWs3S0NFTCt5WXBPMmJoQ0RzbFlnZzdKU0FLU0I4SURFME9qTXdPakV4TENBeE16b3pNQ0I4Q253ZzZyaXc2ckNFSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRWZsbFpXVmt1VFUwdVJFUmdJQzhnN0tlbjZyS01JR0JaV1ZsWkxrMU5Ma1JFZmsxTkxrUkVZQ0I4SURJd01qVXVNREV1TURGK01qQXlOUzR3TVM0ek1Td2dNakF5TlM0d01TNHdNWDR3TVM0ek1TQjhDbndnNjRLZzdLZWNJQ3NnN0l1YzZyQ0VJSHdnWUZsWldWa3VUVTB1UkVRZ1NFZzZUVTFnSUh3Z01qQXlOUzR3TVM0d01TQXhORG96TUNCOENud2c3SnFVN0oyOElId2dZRmxaV1ZrdVRVMHVSRVFvN0pxVTdKMjhLV0FnNG9DVUlPeWJsQy90bVpRdjdJaVlMK3VxcVMvcXVJZ3Y3WWFnTCt5ZHZDQjhJREl3TWpVdU1ERXVNREVvN0lpWUtTQjhDZ29xS3V5TG5PcXdoQ0RzbUlqc21iZ3FLam9nN0lLczdKcXA3SjZRNnJDQUlPeW5nZXlna1NEcXM2RHJwYlRyaXBRZzY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSUdEc21LVHNvSVF2N0ppazdadUVJRWc2VFUxZzdKMkVJT3lOcU91UGhDRHJqN3pzbXBRdUN1eVlpQ2tnN0ppazdadUVJREU2TURBS0NpTWpJeURyckxqc25xVWc3SWFOSU95WHNPeWJsT3lkdkFvSzY2eTQ3SjZsSU95VmlPeVhrT3lFbk91S2xDQXFLdXlibE1LMzdKMjhJT3lWbnV5ZG1DQXc3SjJFSU91NXZPcXpvQ29xSU95TnFPeWFsQzRLQ3V5WWlDa0tMU0F5TURJMjY0V0VJREE0N0p1VUlEQTE3SjI4SU95ZWhldUxpT3VMcEM0ZzRvYVNJREl3TWpicmhZUWdPT3libENBMTdKMjhJT3llaGV1TGlPdUxwQzRLQ2lNakl5RHNnNEhyaklBZzdJdWM2ckNFSUNqcmhianN0cHpzbXFrcENncDhJT3loc09xeHRDQjhJTzJSbk9xNHNDQjhDbnd0TFMwdExTMThMUzB0TFMwdGZBcDhJRFl3N0xTSUlPdXZ1T3VuakNCOElPdXdxZXE0aUNEc29JUWdmQXA4SURZdzY3YUVJT3V2dU91bmpDQjhJRTdydG9RZzdLQ0VJSHdLZkNBeU5PeUxuT3F3aENEcnI3anJwNHdnZkNCTzdJdWM2ckNFSU95Z2hDQjhDbndnTXpEc25id2c2Nis0NjZlTUlId2dUdXlkdkNEc29JUWdmQXA4SURFeTZyQ2M3SnVVSU91dnVPdW5qQ0I4SUU3cXNKenNtNVFnN0tDRUlId0tmQ0F4TXVxd25PeWJsQ0RzbmJUc2c0RWdmQ0JPNjRXRUlPeWdoQ0I4Q2dyc21JZ3BJT3V3cWVxNGlDRHNvSVFzSURYcnRvUWc3S0NFTENBeTdJdWM2ckNFSU95Z2hDd2dNK3lkdkNEc29JUXNJRGJxc0p6c201UWc3S0NFTENBeTY0V0VJT3lnaEFvS0l5TWpJT3VuaU9xd2tNSzM2cml3NnJDRUlPdW5qT3VqakFvS1lFUXRUbUFvVHV5ZHZDRHJncWpzbll3cElDOGdZRVF0TUdBbzdKaWs2NHFZSU91bmlPcXdrQ2tnTHlCZ1JDdE9ZQ2hPN0oyOElPcXl2ZXF6dkNrSzdKaUlLU0JFTFRjc0lFUXRNU3dnUkMwd0xDQkVLekVLQ2lNakl5RHJzb2p0bUxnZzdaR2M2cml3SUNqdGxaanNuYlR0bElqc25MenJvWndnNnJXczY3YUVLUW9LZkNEdGxhM3JxcWtnZkNEdG1KWHNpNTBnZkNEc21JanNpNXdnZkFwOExTMHRMUzB0ZkMwdExTMHRMWHd0TFMwdExTMThDbndnN0tDRTdabVU2N0tJN1ppNElId2c3WldZN0oyMDdaU0lJT3Exck91MmhDQjhJREF5TFRFeU16UXROVFkzT0N3Z01ERXdMVEV5TXpRdE5UWTNPQ0I4Q253ZzdMbTA2NU9jNjdLSTdaaTRJSHdnTk95ZWtPdW1yT3lVcVNEdGxaanNuYlR0bElnZ2ZDQXhNak0wTFRVMk56Z3RPVEF4TWkwek5EVTJJSHdLZkNEcXM0VHNvb3pyc29qdG1MZ2dmQ0R0bFpqc25iVHRsSWdnNnJXczY3YUVJSHdnTVRJekxUUTFOaTAzT0Rrd01USWdmQXA4SU95anZPdXZ2T3VUc2V1aG5ldXlpTzJZdUNCOElPeVZuaUEyN0o2UTY2YXNMZXVTcENBMzdKNlE2NmFzSUh3Z01USXpORFUyTFRFeU16UTFOamNnZkFwOElPeUNyT3lYaGV5ZWtPdVRzZXVobmV1eWlPMll1Q0I4SURFdzdKNlE2NmFzSU8yVm1PeWR0TzJVaUNCOElEQXhMVEl6TkMwMU5qYzRPU0I4Q2dvakl5TWc3Sk93NjZtMElPeVZpQ0Rya0pqcmlwUWc3WkdjNnJpd0Nnb3RJT3VDb095bm5PeVhrQ0R0bFpqc25iVHRsSWpDdCt1NWwrcTRpRG9nNHAyTUlESXdNalV0TURFdE1ERXNJREF4THpBeENpMGc3SXVjNnJDRTdKZVFJT3lZcE95Z2hDL3NtS1R0bTRRNklPS2RqQ0RzbUtUc29JUWdNZXlMbkNBcUtPdUxxQ3dnN0lLczdKcXA3SjZRNnJDQUlPeW5nZXlna1NEcXM2RHJwYlRyaXBRZzY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSU95WWlPeVp1Q2txQ2dvcUtpb0tDaU1qSURndUlPMk1uZXlYaFNqcmk2VHNuYlRzbHJ6cm9aenF0N2dwQ2dydGpKM3NsNFVnNjZ5NDZyV3M2NHFVSUNvcTdKZXQ3WldnS2lvbzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdkNucXM3d2dLaXJzbktEdG1KVXFLaWp0aHJYcnM3UXY3WXlRNjR1b0tleVhrQ0RybExEcm5id2c2Nnk0N0xLMDZyQ0FJT3VMck91ZHZPeWFsQzRnN1lPQTdKMjA3WXVBN0oyRUlPdUxwT3VUck95ZGhDRHJsWkFnNjdDWTY1T2M3SXVjSU95VmlPdUN0Q2pyczdqcnJMZ3A2cm1NN0tlQUlPcXdtZXlkdENEcnM3VHFzNkFzSU91enVPdXN1Q0RycDZYcm5iM3NuWVFnNjR1MDdKV0U3Slc4SU8yVnRPeWFsQzRLQ2lNakl5QXc2NHVvNnJPRUlPS0FsQ0R0aXJqcnBxenFzYkRydG9EdGhMQWc2N1NRN0pxVUNncnRqSjNzbDRYc25iUWc3SUtzN0pxcDdKNlE3SjJZSU95V3RPdVdwQ0R0bG9ucmo1a2c2NUtrN0plUUlPdWNxT3VLbE95bmdDRHJxTHpzb0lBZzdZeU03SldGN1pXMDdKcVVMZ29LTFNEdGxvbnJqNW5zbllRZ0tpcnFzSURyb1p6cnA0bnFzYkRyZ3BnZzdZeVE2NHVvN0oyRUlPeWFsT3ExckNvcUtPeWR0TzJEaU1LMzdJS3Q3S0Njd3Jmcm9aenF0N2pzbFlUc200UEN0K3lpaGV1ampDa2c0b2FTSUNvcTdZeVE2NHVvN1ppVktpb2dLT3Vzdk95V3RPdTBrT3lhbENrS0xTRHFzckRxczd6Q3QreURnZTJEbk91bHZDQXFLdTJHdGV1enRPdW5qQ29xSUNqc21ZVHJvNHpDdCt5THBPMk1xQ2tnNG9hU0lDb3E3SldJNjRLMDdaaVZLaW9nS095VmpPdWdwT3lrbU95YWxDa0tDaU1qSXlEdGc0RHNuYlR0aTRBZzRvQ1VJT3lucCt5ZGdDRHJxb1hzZ3F6cXRhd0tDaTBnNjZxRjdJS3M3WmlWN0p5ODY2R2NJT3VCbmV1Q3RPeWFsQzRnN0tLRjZyS3c3SmEwNjYrNHdyZnJwNGpzdWFqdGtaenJwYndnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQ0FvZnV5YWxDQXZJSDdyaTZRZ0x5Qis2cm1NN0pxVVB5RGluWXdwTGdvdElESitOT3lXdE95Z2lPdWhuQ0RzcDZmcXM2QWc3SW05NnJLTUxpRHRsWnpzbnBEc2xyVEN0K3lJbU95TG5leWRoQ0RxdUxqcXNvd2c3SXlUN0tlQUlPeVZpdXlWaE95YWxDNEtMU0RzbFlqcmdyUW82N080NjZ5NEtTRHJwNlhybmIzc25ZUWc3SnFVN0pXOTdaVzBMQ0FxS3UyRGdPeWR0TzJMZ091bmpDRHJ0SkRyajRRZzY2eTA3SXFvSU8yTW5leVhoZXlkdU95bmdDb3FJT3lWak9xeWpDRHRsYlRzbXBRdUlPeWJrT3V6dU95ZHRDQW43SldNNjZhOHdyZnRtWlhzbmJnbjdMS1k2NSs4SU91bmlleVhzTzJWbU91cHRDRHJzN2pyckxqc25ZUWc2cmU4NnJHdzY2R2NJT3Exck95eXRPMlpsTzJWdE95YWxDNEtDbndnN0oyMDY2Q0g2cktNSU91bmtPcXpvQ0I4SU95ZHRPdWdoK3F5akNCOENud3RMUzE4TFMwdGZBcDhJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnFzNkFnNjRLWTZyQ0E3SXVjNnJLZzdKYTA3SnFVUHlCOElPeWdnT3llcFNEc2xZZ2c3WldjSU91Q3RPeWFxU0I4Q253ZzdKV002NmE4SUh3ZzZyS3c3S0NjSU95WmhPdWpqQ0I4Q253ZzdLQ1Y2NmVRSU95Q3JleWduTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhnZkNEcmpiRHNuYlR0aExBZzdJS3Q3S0NjSUh3S0NpTWpJeURzbFlqcmdyUW82N080NjZ5NEtTRGlnSlFnN1pXMDdKcVU3TEswQ2dvdElDb3E3WXlRNjR1bzdaaVZLaXJzbllBZ0ozN3RsYURxdVl6c21wUS9KK3VobkNEcnJMenNsclRzbXBRdUlPdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3ljaE8yWG1DanNncTNzb0p6Q3QrMkRpTzJIdENEcms3RXA3SjJBSU9xeXNPcXp2T3VsdkNEcnFMenNvSUFnNnJLOTZyT2c3WlcwN0pxVUxnb3RJQ29xN0pXSTY0SzA3WmlWS2lyc25ZQWc3SUtzN0l1azdKMkVJT3lFbk95SW9PMlZ0T3lhbEM0S0xTRHJwNGpzdWFqdGtaenJwYndnN0kybzdKcVVMaURzaUt2c25wREN0K3loc09xeHRDanNuYlRzZzRIQ3QreWR0TzJWbU1LMzdKMjA2NEswSU91VHNTbnNuWUFnNnJlNDY0eUE2NkdjSU91UmtPcXpvQ3dnN0p1UTY2eTQ3SmVRSU95WGh1dUtsQ0Rzb0pYcnM3VEN0K3lnaU95d3FNSzM3SmV3NjUyOTdMS1k2Nlc4SU95bmdPeVd0T3VDdE95bmdDRHNsWXJzbFlUc21wUXVDZ29qSXlNZzY3S0U3WXE4SU9LQWxDRHNsWWpyZ3JRZzY2eTQ2NmVsN0oyMElPeWdsZTJWdE95YWxBb0tmQ0RyczdqcnJManNuYlFnN0oyMDY2Q0g2NHVrSUh3ZzY3S0U3WXE4SUh3S2ZDMHRMWHd0TFMxOENud2c2ckt3NnJPOHdyZnNnNEh0ZzV6cnBid2c3WWExNjdPMElId2dXKzJabGV5ZHVGMGdmQXA4SUNkKzdaV2c2cm1NN0pxVVB5ZnJvWndnNjZ5ODdKMk1JSHdnVyt5VmhPdUxpT3lZcEYwZ3dyY2dXK3VFcEYwZ2ZBcDhJT3lEZ2UyWnFTRHNoSnpzaUtBZ0t5RHNtS1RycGJqc3FyM3NuYlFnN0l1azdLQ2NJT3VQbWV5ZWtTQjhJRnZzdDZqc2hveGRJTUszSUZ0NzY0K1o3SjZSZlYwZ2ZBb0tMU0FuN0xlbzdJYU1KK3VLbENBcUt1dVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ29xSU95TnFPeWFsQ0FvN0ppSU9pQmI3TGVvN0lhTVhjSzNXK3lDcmV5Z25GMHBMaUFuNjR1cjZyaXdJTUszSU91UG1leWVrU2Zzc3Bqcm43d2c3S2VkN0oyMElPeVZpQ0RycDU3cmlwUWc3S0d3N1pXcDdKMjA2NEtZSU91THFPdVBoU0FuN0xlbzdJYU1KK3VLbENEc2s3RHNwNEFnN0pXSzdKV0U3SnFVTGdvdElPdXloTzJLdk95ZG1DRHJqNW5zbnBFZzdKMjA2NmFFN0oyQUlPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRoQ0RxdDdqcmpJRHJvWndnN0lLMDY2Q2s3SnFVTGdvS0l5TWpJTzJHdGV5bm5DRHNtSWpzaTV3S0Npb3E3WXlRNjR1bzdaaVZJT0tBbENEc25iVHRnNGdxS2dvdElPMkRnT3lkdE8yTGdEb2c3S0NBN0o2bElPeVZpQ0R0bFp3ZzY0SzA3SnFwQ2kwZzdKV0k2NEswT2lEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhnN0o2RjY2Q2w3WldjSU91Q3RPeWFxZXlkdENEc2dxenJuYnpzb0xqc21wUXVDaTBnNjdLRTdZcThPaURzbFlUcmk0anNtS1Fnd3JjZzY0U2tDZ29xS3UyTWtPdUxxTzJZbFNEaWdKUWc3SUt0N0tDY0lDanNuSVR0bDVncEtpb0tMU0R0ZzREc25iVHRpNEE2SU91TnNPeWR0TzJFc0NEc2dxM3NvSndLTFNEc2xZanJnclE2SU95Q3JleWduTzJWbU91cHRDRHJpNlRzaTV3ZzdJSzA2NmEwSU95SW1DRHNsNGJzbHJUc21wUXVJT3lDcmV5Z25PMlZvT3E1ak95YWxEOEtMU0Ryc29UdGlydzZJT3lWaE91TGlPeVlwQ0RDdHlEcmhLUUtDaW9xNjQrWjdKNlI3WmlWSU9LQWxDRHNoSnpzaUtBZ0t5RHJqNW5zbnBFZzY3S0U3WXE4S2lvS0xTRHRnNERzbmJUdGk0QTZJT3E0c09xNHNDRHNsN0Rxc3JBZzdaVzA3S0NjQ2kwZzdKV0k2NEswT2lEc2hLRHRnNTN0bFp3ZzZyaXc2cml3N0oyWUlPeVhzT3F5c095ZGhDRHJnWXJzbHJUc21wUXVDaTBnNjdLRTdZcThPaURzdDZqc2hvd2d3cmNnN0pldzZyS3dJTzJWdE95Z25Bb0tLaXJzbFlqcmdyVHRtSlVnNG9DVUlPeVpoT3VqakNEdGhyWHJzN1FxS2dvdElPMkRnT3lkdE8yTGdEb2c2ckt3N0tDY0lPeVpoT3VqakFvdElPeVZpT3VDdERvZzZyS3c3S0NjNnJDQUlPeWdsZXlEZ1NEc3NwanJwcXpya0pEc2xyVHNtcFF1Q2kwZzY3S0U3WXE4T2lEdG1aWHNuYmdLQ2lvcUtnb0tJeURzbUlqc21iZ2c2cmVjN0xtWkNncnNtNURzdVprbzY0cWw2NCtad3JmcXVJM3NvSlhDdCt5NmtPeWp2T3lXdkNucnM3VHJpNlFnN0ppSTdKbTQ2ckNBSU91TmxDRHJxb1h0bVpYdGxad2c3THVrNjY2azY0dUk3THlBN0oyMDdJV1k3SjJFSU91bmpPdVRuT3VLbENEcXNyM3NtckRzbUlqc21wUXVDZ29qSXlEc21JanNtYmdnTVM0ZzdJaVk2NCtaN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzY1Q1k2NHFVSU9xeXZleWFzQW9LSXlNaklPeUVuT3U1aE95S3BDRHNvb1hybzR3c0lPcTRzT3F3aENEcnA0enJvNHdLQ3V5SW1PdVBtZTJZbGV5Y3ZPdWhuQ0RzazdEcnFiUWc3S084N0phMEtPeWloZXVqakNEc2hKenJ1WVRzaXFRc0lPcTRzT3F3aENEcms3RXA2Nlc4SU9xd2xleWhzTzJWb0NEc2lKZ2c3SjZJNnJPZ0xDQW43S0tGNjZPTUoreVpnQ0FuNjZlTTY2T01KK3lkbUNEcmlaanNsWm5zaXFUcnBid2c3S0NWN1ptVjdaNklJT3lnaE91THJPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1FvdElFOVBUeURzaEp6cnVZVHNpcVFnN0tLRjY2T01JT3lWaU91Q3RDRGlnSlFnTUREc201UWdNRERzbmJ6cnRvRHRoTEFnN0lTYzY3bUU3SXFrNnJDQUlPeWloZXVqak91UHZPeWFsQzRnN0o2UTdJUzQ3WldjSU91Q3RPeWFxZXlkaENEc2xZenJvS1RyazV6cm9LVHNtcFF1Q2kwZzdKNlE3SUt3SU95aHNPMmFqQ0RxdUxEcXNJVHNuYlFnNnJPbklPdW5qT3Vqak91UHZPeWFsQzRLQ3V1THFDd2dLaXJzbzd6cXVMRHNvSUhzbkx6cm9ad2c3S0tGNjZPTTZyQ0FJT3V3bU91enRldVFtT3VLbENEc29KenRrb2dxS3V5WGtPdUtsQ0FuN0tLRjY2T002NCs4N0pxVUordWx2Q0RzazdEc3A0QWc3SldLN0pXRTdKcVVMZ29LN0ppSUtRb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPeWloZXVqak91UHZPeWFsQ0RpaHBJZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnNjRHZDY0S1k3SnFVQ2dvakl5TWc3SUtzN0pxcDdKNlE3SmVRNnJLTUlPdXZ1T3k1bU91S2xDRHNtSUh0bHFYc25ZUWc3SldNNjZDazdLU0VJT3VWakFvS0tPeWp2T3lhbENEcmo1bnNncXdnT2lEc2w3RHNzclFzSU8yVnRPeW5nQ3dnN0tDQjdKcXBJT3VUc1NrS0N1eUltT3VQbWUyWWxleWN2T3VobkNEc2s3RHJxYlFnN0oyNDZyTzhJT3EwZ09xemhPdWx2Q0RycW9YdG1aWHRsWmpxc293ZzdJU2s2NnFGN1pXWTZyT2dMQ0FuN0lLczdKcXA3SjZRN0oyWUlPMldpZXVQbWV5WGtDRHJsTERybmJ6c21LVHJpcFFnNnJLdzZyTzhKK3Vkdk91S2xDRHNvSkRzbllRZzdKV002NkNrN0tTRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUN0T3lqdk95RXVPeWFsQzRLTFNEcmpJRHN0cHpzbllRZzZyQ0k3SldFN1lPQTY2bTBJT3lia091ZW1DRHJqSURzdHB6c25iUWc3WlcwN0tlQTY0Kzg3SnFVTGlEc21LVHJpcGdnNjRLZzdLZWM2cm1NN0tlQTdKMllJT3lkdE95ZWtPdWx2Q0RzbllEdGxvbnNsNUFnNjRLMDdKVzhJTzJWdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBBZzdKV0k3SXVzSUNqc2lKanJqNW50bUpVcENnb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3SXVjN0lxazdZV2M3SjIwSU95ZWtPdVBtZXljdk91aG5DRHNzcGpycHF6dGxaenJpNlRyaXBRZzdLQ1FLaXJzbllRZzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LN0ppSUtRb3RJT3lkdE95Z25PdTJnTzJFc0NEdG1ZM3F1TGpyajVucmk1anNuWmdnNnJDYzdKMjQ3S0NWNjdPMElPeWR0T3lhcVNEcmdyVHNsNjNzbmJRZzZyaXc2NkdkNjQrODdKcVVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUNnb2pJeURzbUlqc21iZ2dNaTRnNnJLOTdKYTA2Nlc4SU95TnFPdVBoQ0Rya0pqcmlwUWc2cks5N0pxd0NncnRpcm5zb0pVZzdJT0I3Wm1wN0plUTdJU2NJT3lnbk8yVm5PeWdnZXljdk91aG5DQW43SXVjNjRLWTdKcVVQeXdnN0lXbzY0S1k3SnFVUHljZzdKMlk2Nnk0N1ppVklPeVd0T3V2dU91bHZDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c2NmVsNjUyOTdKMkVJTzJabk95YXFlMlZ0T3lFbkNEc3A0anJyTGp0bGFBZzY1V01DZ29uN0l1YzY0S1k3SnFVUHljc0lDZnNoYWpyZ3Bqc21wUS9KeUR0bUpYdGc1enNuWmdnNnJLOTdKYTA2Nlc4SU8yWm5PeWFxZTJWdE95RW5DRHNncXpzbXFuc25wRHNuWmdnNjR1NTdabXA3SXFrNjUrczdKdUE3SjJFSU95a2hPeWR2Q0RzaUpnZzdKNkk3SmEwN0pxVUxnb0s3SmlJS1FvdElPMlpqZXE0dU91UG1ldUxtQ3dnVDA5UElPdUxwT3VGZ095WXBPeUZxT3VDbU95YWxEOEtMU0RzdHFuc29JVHRsWmpybjZ3ZzdZNjQ3SjJZN0tDUUlPcXdnT3lMbk91Q21PeWFsRDhLQ2lNakl5RHNncXpzbXFuc25wRHNuWmdnN0lPQjdabXA3SjJFSU95MmxPeWdsZTJWb0NEcmxZd0tDdXVxaGUyWmxlMlZuQ0Rzb0pYcnM3VHFzSUFnN0plRzdKYTA3SVNjSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzcDRIc29KRWc3WXlRNjR1bzdaV1k2cktNSU8yVnRPeVZ2Q0R0bGFBZzY1V01JT3F5dmV5V3RPdWhuQ0Rzb0pYc3BKSHRsWmpxc293ZzdLZUk2Nnk0N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dyc21JZ3BDaTBnN0xtMDY1T2M2Nlc4SU91d20reWN2T3lGcU91Q21PeWFsRDhnNjVPeDY2R2Q3WldZNjZtMElPeTZrT3lMbk91d3NTRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SUtzN0pxcDdKNlE3SjJZSU95RW9PeWRtT3F3Z0NEdGxZVHNtcFR0bGFBZzY1V01DZ3JzaEtUcnJManNvYkRzZ3F6c3NwanJuN3dnN0lLczdKcXA3SjZRN0oyWUlPeUVvT3lkbU91bHZDRHF1TERyaklEdGxiVHNsYndnN1pXZ0lPdVZqQ0Rxc3Izc2xyVHJvWndnN0tDVjdLU1I3WldZNnJLTUlPeW5pT3VzdU8yVnRPeWFsQzRLQ3V5WWlDa0tMU0RzbmJUcnNvZ2c2NHVzN0plUUlPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsWmpycWJUc2hKd2c3SmE4NjZlSTY0S1lJT3Vuak95aHNlMlZtT3lGcU91Q21PeWFsRDhLQ2lNaklPeVlpT3ladUNBekxpRHJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkVJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3Q2dyc2dxenNtcW5zbnBEc2w1RHFzb3dnNjZxRjdabVY3WldZNnJLTUlPdTJnT3lnbGV5Z2dleWR1Q0RyZ3JUc21xbnNuWVFnN0pXTTY2Q2s3S1NZN0pXOElPMlZvQ0RybFl6cmlwUWc2N2FBN0tDVjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqcmo0UWc3S0tMN0pXRTdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BPdWx2Q0Rzb0pYc3NZWHNnNEVnN0pPNElPeUltQ0RzbDRic25ZUWc2NVdNQ2dycnRvRHNvSlh0bUpYc25MenJvWndnN0kybzdKVzhJT3lDck95YXFleWVrT3lYa09xeWpDRHNnNEh0bWFuc25ZUWc2NnFGN1ptVjdaV1k2cktNSU95ZHVPeW5nT3lMbk8yQ3JDRHNpSmdnN0o2STdKYTA3SnFVTGlBcUt1eVR1Q0RzaUpnZzdKZUc2NHFVSU95ZHRPeWNvT3VsdkNEdGxhanF1NWdnN0pXSTY0SzA3WlcwN0tPODdJUzQ3SnFVTGlvcUNncnNtSWdwQ2kwZzdLZUE2cmlJN0oyQUlPcXdnT3llaGUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGlEc3NxM3Nob3pyaFlUc25ZUWc3SnlFN1pXY0lPeUVuT3U1aE95S3BPdUtsQ0RzbFlUc3A0RWc3S1NBNjdtRUlPeWtrZXlkdE95WGtPeWFsQzRLTFNEcXM3WHJyTFRzbTVEc25ZQWc3WnVFN0p1UTZyaUk3SjJFSU91enRPdUN2Q0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95ZHZPdTJnQ0RxdUxEcmlxWHJwNHdnN0pPNElPeUltQ0RzbDRic25ZUWc2NVdNQ2dycnRvRHNvSlh0bUpYc25MenJvWndnN0kybzdKVzhJT3lDck95YXFleWVrT3F3Z0NEc2xyVHJscVFnNnJpdzY0cWw3SjJFSU95VHVDRHNpSmdnN0plRzY0cVU3S2VBSU91cWhlMlpsZTJWbU9xeWpDRHNuYmpzcDREdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0N1eVlpQ2tLTFNEc29KRHFzb0FnNnJpdzZyQ0VJT3VQbWV5VmlDRHNoSnpydVlUc2lxVHJwYndnN0oyMDdKcXA3WldnSU95SW1DRHNsNGJzbHJUc21wUXVDaTBnN0l1ZzY3YUU3S2FkSU8yWmxleWR1T3VRbU9xNHNDRHNvSVRxdVl6c3A0QWc3SWFoNnJpSTZyTzhJT3F5c095Z25PdWx2Q0R0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNncXpzbXFuc25wQWc3SVNnN1lPZDdKMllJT3F5c09xenZPdWx2Q0RzbFlqcmdyVHRsYUFnNjVXTUNncnJrSmpyajR6cnByUWc3SWlZSU95WGh1dUtsQ0RzaEtEdGc1M3NuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMlZtT3F5akNEc2xZenJvS1RzbXBRdUNncnNtSWdwQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNncXpzbXFuc25wQWc3SldJN0l1c0lDanJ0b0Rzb0pYdG1KVXBDZ29uN0tDVjY3TzBJT3lJbU95bmtTRHNsWWpyZ3JRbklPdVRzZXlkbUNEcnI3enFzSkR0bFp3ZzdJT0I3Wm1wN0plUTdJU2NJQ29xN0tDVjY3TzA2ckNBSU91enRPMll1T3VRbk91THBPdUtsQ0Rzb0pBcUt1eWRoQ0RydG9Ec29KWHRtSlhzbkx6cm9ad2c3SldNNjZDa0lPeUNyT3lhcWV5ZWtPdWx2Q0RzbFlqc2k2enRsWmpxc293ZzdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNncnNtSWdwQ2kwZzdJT0I2NHUwN0oyMElPdUJuZXVDbU91cHRDRHNvSVRyckxqcXNJRHJqNFFnN1ptTjZyaTQ2NCtaNjR1WTdKMllJT3lnbGV1enRPdWx2Q0Ryczd3ZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEdG1ZM3F1TGpyajVucmk1anNuWmdnN0tDVjY3TzA2ckNBSU9xNHNPdWhuZXVRbU95bmdDRHNsWXJzbFlUc21wUXVDZ29qSXlEc21JanNtYmdnTkM0ZzdLQ2M3WktJSU95YXFleVd0T3VLbENEcnNKVHF2cmpzcDRBZzdKV0s2cml3Q2dvbjZyQ0U2ckt3N1pXWTZyT2dJT3lKck95YXRDRHJwNUFuSU95YmtPeTVtZXV6dE91THBDQXFLdTJabE91cHRPeWRtQ0RxdUxEcmlxWHJxb1hDdCt1eWhPMkt2T3VxaGVxenZPeWRtQ0RzbXFuc2xyUWc3SjI4N0xtWUtpcnFzSUFnN0pxdzdJU2c3SjIwN0plUTdKcVVMZ3JxdUxEcmlxWHJxb1hzbDVBZzdKT3c3SjI0SU91THFPeVd0Q2pyczREcXNyMHNJT3luZ095Z2xTd2c2NU94NjZHZElPdVRzU25ycGJ3ZzdKV0k2NEswSU91c3VPcTFyT3lYa095RW5DRHJpNlRycGJnZzY2ZVE2NkdjSU91d2xPcSt1T3VwdENEc2dxenNtcW5zbnBEcXNJQWc2NHVrNjZXNElPcTRzT3VLcGV5Y3ZPdWhuQ0RzbUtUdGxiVHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDdXlZaUNrZ0orcTJqTzJWbkNEcnM0RHFzcjBuSU9xNHNPdUtwZXlkbUNEc2xZanJnclFnNjZ5NDZyV3NDaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVm1PdXB0Q0Ryc0pUcXY0QWc3SWlZSU95ZWlPeVd0T3lhbENBb1dDa0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUlDaFBLUW9LSXlNZzdKaUk3Sm00SURVdUlPeUxuT3lLcE8yRm5DRHJqNW5zbnBIcXM3d2c2NHVrNjZXNElPdVBtZXlDckNEc2s3RHNwNEFnN0pXSzZyaXdDZ3JyckxqcXRhenJwYndnN0pXRTY2eTA2NmFzSU91bnBPdUJoT3VmdmVxeWpDRHJpNlRyazZ6c2xyVHJqNFFnS2lyc2k2VHNvSndnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NLaXJycGJ3ZzdKT3c2Nm0wSU95ZW1PdXF1K3VRbkNEcnJManF0YXpzbUlqc21wUXVDZ3JzbUlncElPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJwYndnSit5MmxPcXdnQ0RzcDREc29KVW43WldZNjRxVUlPeUxuT3lLcE8yRm5PeVhrT3lFbkNBbzdKMjA3S0NFd3Jmc2xwSHJqNFFnNnJpdzY0cWw3SjIwSU95VmhPdUxtQ2tLTFNEcmk2VHJwYmdnN0lLczY1Nk03SmVRNnJLTUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJwYndnNjRTWTZyS283S084N0lTNDdKcVVJQ2hZSU9LQWxDRHNsNGJyaXBRZ0ordUVtT3E0c09xNHNDY2c2cml3NjRxbDdKMkVJT3lWbE95TG5Da0tMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXMElPeWp2T3lFdU95YWxDQW9UeWtLJwpESVI9IiRIT01FL0xpYnJhcnkvQXBwbGljYXRpb24gU3VwcG9ydC9DbGF1ZGVCcmlkZ2UiCnB1dCgpIHsgcHJpbnRmICVzICIkMSIgfCBiYXNlNjQgLUQgPiAiJDIiOyB9CiMg7J20IC5jb21tYW5k6rCAIOuPhOuKlCDthLDrr7jrhJAg7LC966eMIOqzqOudvCDri6vripTri6QodHR5IOunpOy5rSkuIGJhc2jqsIAg64Gd64KYIO2DreydtCBpZGxl65CcIDHstIgg65Kk7JeQIOuLq+yVhAojICLtlITroZzshLjsiqQg7Iuk7ZaJIOykkSIg6rK96rOg66W8IO2UvO2VnOuLpCDigJQgZGlzb3du7Jy866GcIOyKpO2BrOumve2KuOqwgCBleGl07ZW064+EIOuLq+q4sCDsnpHsl4XsnYAg7IK07JWE64Ko64qU64ukLiAo66elIOyLpOq4sCDqsoDspp0g7ZWE7JqUKQpNWVRUWT0iJChwcyAtbyB0dHk9IC1wICQkIDI+L2Rldi9udWxsIHwgdHIgLWQgIiAiKSIKY2xvc2VfdGVybWluYWwoKSB7CiAgWyAteiAiJE1ZVFRZIiBdICYmIHJldHVybgogICggc2xlZXAgMQogICAgL3Vzci9iaW4vb3Nhc2NyaXB0ID4vZGV2L251bGwgMj4mMSA8PE9TQQp0ZWxsIGFwcGxpY2F0aW9uICJUZXJtaW5hbCIKICByZXBlYXQgd2l0aCB3IGluIHdpbmRvd3MKICAgIHRyeQogICAgICByZXBlYXQgd2l0aCB0IGluIHRhYnMgb2YgdwogICAgICAgIGlmIHR0eSBvZiB0IGlzICIvZGV2LyRNWVRUWSIgdGhlbiBjbG9zZSB3IHNhdmluZyBubwogICAgICBlbmQgcmVwZWF0CiAgICBlbmQgdHJ5CiAgZW5kIHJlcGVhdAplbmQgdGVsbApPU0EKICApICYgZGlzb3duIDI+L2Rldi9udWxsIHx8IHRydWUKfQojIOyViOuCtOuKlCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukIOKAlCDthLDrr7jrhJDsnYAg7ISk7LmYwrfsoJDqsoDrp4wg7ZWY6rOgIOyKpOyKpOuhnCDri6vtnozri6QuCmZpbmlzaCgpIHsgY2xvc2VfdGVybWluYWw7IGV4aXQgIiQxIjsgfQplY2hvICLtgbTroZzrk5wg7Luk64Sl7YSw66W8IOyEpOy5mO2VmOqzoCDsnojslrTsmpTigKYg7J6g7IucIO2bhCDsnbQg7LC97J2AIOyekOuPmeycvOuhnCDri6vtmIDsmpQuIgpta2RpciAtcCAiJERJUi9zY3JpcHRzIiB8fCB7IGVjaG8gIu2PtOuNlCDsg53shLEg7Iuk7YyoOiAkRElSIjsgZmluaXNoIDE7IH0KcHV0ICIkQjY0X0JSSURHRSIgICAiJERJUi9zY3JpcHRzL2NsYXVkZS1icmlkZ2UuanMiCnB1dCAiJEI2NF9XQVRDSEVSIiAgIiRESVIvc2NyaXB0cy9icmlkZ2Utd2F0Y2hlci5qcyIKcHV0ICIkQjY0X0VYQU1QTEVTIiAiJERJUi9yZWNvbW1lbmQtZXhhbXBsZXMubWQiCnB1dCAiJEI2NF9HVUlERSIgICAgIiRESVIvdXgtd3JpdGluZy5tZCIKZWNobyAi4pyFIO2MjOydvCDshKTsuZg6ICRESVIiCiMgR1VJ7JeQ7IScIOyXsCBUZXJtaW5hbOydgCBQQVRI6rCAIOyigeydhCDsiJgg7J6I7Ja0IO2dlO2VnCDshKTsuZgg6rK966Gc66W8IOuztO2DoOuLpApleHBvcnQgUEFUSD0iJEhPTUUvLmxvY2FsL2Jpbjovb3B0L2hvbWVicmV3L2JpbjovdXNyL2xvY2FsL2JpbjokUEFUSCIKIyBub2Rl6rCAIOyXhuycvOuptCDqsJDsi5zsnpAoPW5vZGUpIOyekOyytOqwgCDrqrsg64+M7JWEIO2UjOufrOq3uOyduOyXkCDslYzrprQg67Cp67KV7J20IOyXhuuLpCDihpIg7J20IOqyveyasOunjCDrhKTsnbTti7DruIwg7Yyd7JeF7Jy866GcIOyViOuCtO2VnOuLpAppZiAhIGNvbW1hbmQgLXYgbm9kZSA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICBvc2FzY3JpcHQgLWUgJ2Rpc3BsYXkgZGlhbG9nICLsnbQgTWFj7JeQIE5vZGUuanPqsIAg7JeG7Ja07JqULiBb7ZmV7J24XeydhCDriITrpbTrqbQg64uk7Jq066Gc65OcIO2OmOydtOyngOqwgCDsl7TroKTsmpQuIE5vZGUuanMoTFRTKeulvCDshKTsuZjtlZwg65KkIOydtCDshKTsuZgg7YyM7J287J2EIOuLpOyLnCDsi6TtlontlbQg7KO87IS47JqULiIgd2l0aCB0aXRsZSAi7YG066Gc65OcIOy7pOuEpe2EsCDigJQgTm9kZS5qcyDtlYTsmpQiIGJ1dHRvbnMgeyLtmZXsnbgifSBkZWZhdWx0IGJ1dHRvbiAxIHdpdGggaWNvbiBjYXV0aW9uIGdpdmluZyB1cCBhZnRlciAxODAnID4vZGV2L251bGwgMj4mMQogIG9wZW4gImh0dHBzOi8vbm9kZWpzLm9yZy9rby9kb3dubG9hZCIgMj4vZGV2L251bGwKICBmaW5pc2ggMApmaQpOT0RFX0JJTj0iJChjb21tYW5kIC12IG5vZGUpIgplY2hvICLinIUgTm9kZS5qczogJChub2RlIC0tdmVyc2lvbikiCiMg6rCQ7Iuc7J6QIGxhdW5jaGQg65Ox66GdICjroZzqt7jsnbgg7J6Q64+Z7Iuc7J6RICsg7KeA6riIIOq4sOuPmSkuIFBBVEjrpbwgcGxpc3Tsl5Ag6rWz7ZiAIOuEo+uKlOuLpCDigJQgbGF1bmNoZCDquLDrs7ggUEFUSOyXlCBjbGF1ZGXqsIAg7JeG64ukLgpQTElTVD0iJEhPTUUvTGlicmFyeS9MYXVuY2hBZ2VudHMvY29tLmNsYXVkZWJyaWRnZS53YXRjaGVyLnBsaXN0Igpta2RpciAtcCAiJEhPTUUvTGlicmFyeS9MYXVuY2hBZ2VudHMiClNBRkVfUEFUSD0iJHtQQVRILy8mLyZhbXA7fSIKY2F0ID4gIiRQTElTVCIgPDxQTElTVEVPRgo8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCI/Pgo8IURPQ1RZUEUgcGxpc3QgUFVCTElDICItLy9BcHBsZS8vRFREIFBMSVNUIDEuMC8vRU4iICJodHRwOi8vd3d3LmFwcGxlLmNvbS9EVERzL1Byb3BlcnR5TGlzdC0xLjAuZHRkIj4KPHBsaXN0IHZlcnNpb249IjEuMCI+CjxkaWN0PgogIDxrZXk+TGFiZWw8L2tleT48c3RyaW5nPmNvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlcjwvc3RyaW5nPgogIDxrZXk+UHJvZ3JhbUFyZ3VtZW50czwva2V5PgogIDxhcnJheT4KICAgIDxzdHJpbmc+JE5PREVfQklOPC9zdHJpbmc+CiAgICA8c3RyaW5nPiRESVIvc2NyaXB0cy9icmlkZ2Utd2F0Y2hlci5qczwvc3RyaW5nPgogIDwvYXJyYXk+CiAgPGtleT5FbnZpcm9ubWVudFZhcmlhYmxlczwva2V5PgogIDxkaWN0PjxrZXk+UEFUSDwva2V5PjxzdHJpbmc+JFNBRkVfUEFUSDwvc3RyaW5nPjwvZGljdD4KICA8a2V5PlJ1bkF0TG9hZDwva2V5Pjx0cnVlLz4KICA8a2V5PktlZXBBbGl2ZTwva2V5PjxkaWN0PjxrZXk+U3VjY2Vzc2Z1bEV4aXQ8L2tleT48ZmFsc2UvPjwvZGljdD4KPC9kaWN0Pgo8L3BsaXN0PgpQTElTVEVPRgpsYXVuY2hjdGwgYm9vdG91dCAiZ3VpLyQoaWQgLXUpL2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlciIgMj4vZGV2L251bGwKbGF1bmNoY3RsIGJvb3RzdHJhcCAiZ3VpLyQoaWQgLXUpIiAiJFBMSVNUIiAyPi9kZXYvbnVsbCB8fCBsYXVuY2hjdGwgbG9hZCAtdyAiJFBMSVNUIiAyPi9kZXYvbnVsbAojIGNsYXVkZSDsnKDrrLTCt+uhnOq3uOyduCDsl6zrtoDripQg7Jes6riw7IScIOyVjOumrOyngCDslYrripTri6Qg4oCUIOqwkOyLnOyekOqwgCDqt7gg7IOB7YOc66W8IO2UjOufrOq3uOyduOyXkCDsoITri6ztlbQKIyDqs4TsoJUg7ZmU66m07J20ICLshKTsuZgg7ZWE7JqUIC8g66Gc6re47J24IO2VhOyalCAvIOykgOu5hCDsmYTro4wi66GcIOuFuOy2nO2VnOuLpCjthLDrr7jrhJDsnbQg7LGE64SQ7J20IOyVhOuLmCkuCiMg7ISk7LmYwrfsoJDqsoAg64GdIOKGkiDssL3snYQg7Iqk7Iqk66GcIOuLq+uKlOuLpC4KZmluaXNoIDAKUEsBAh4DFAAACAAAAAAAACE3ywJ/kwIAf5MCABsAAAAAAAAAAAAAAO2BAAAAAO2BtOuhnOuTnC3su6TrhKXthLAuY29tbWFuZFBLBQYAAAAAAQABAEkAAAC4kwIAAAA=";
// ===== INSTALLER_MAC:END =====

// 다리 심장박동 — 플러그인이 떠 있는 동안 5초마다 생존 신호를 보낸다.
// 플러그인/피그마가 닫혀 박동이 30초 끊기면 다리가 claude와 함께 스스로 꺼진다 (claude-bridge.js /heartbeat).
// 다리가 꺼져 있으면 그냥 실패 — 심장박동이 다리를 켜지는 않는다 (켜기는 ensureBridgeFromGesture 담당).
function sendHeartbeat() {
  postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/heartbeat', {}, 3000).catch(() => { /* 다리 꺼짐 — 무시 */ });
}
sendHeartbeat();
// 박동과 함께 다리 상태도 주기적으로 갱신한다 — 안 하면 백그라운드에서 다리가 꺼지거나 켜져도
// 버튼 라벨이 옛 상태로 남는다(화면 진입·버튼 클릭 때만 조회했음). /health는 로컬 호출이라 비용 무시 가능.
setInterval(() => { sendHeartbeat(); refreshBridgeStatus(true); }, 5000);

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
        message: '수정이 필요한 항목이 없어요.'
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
        ? '변경됐어요.'
        : `${changedNodeIds.size}건이 변경됐어요.`;
    } else if (changedNodeIds.size > 0) {
      message = `${changedNodeIds.size}건이 변경됐어요. ${skippedCount}건은 검토 후 텍스트가 바뀌었거나 삭제되어 적용하지 못했어요.`;
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
          .map((g: any) => ({
            name: String((g && g.name) || ''),
            texts: (g && Array.isArray(g.texts) ? g.texts : []).map((t: any) => String(t || '').trim()).filter(Boolean),
            own: !!(g && g.own), // '이 프레임 문구' 표시 — 결과 화면도 미리보기와 같게 보이게 되돌려 준다
            role: (g && g.role) ? String(g.role) : undefined, // '버튼' 영역이면 버튼 규칙으로
          }))
          .filter((g: { texts: string[] }) => g.texts.length)
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
      if (await popupRecommendFlow(msg.model)) return;
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
      if (!bh.alive) { postRecommendFallback(text, ''); return; }
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
      const suggestions = refineButtonSuggestions(
        await refineAiSuggestions(await fetchAiSuggestions(text, msg.model, msg.role)),
        msg.role
      );
      figma.ui.postMessage({ type: 'hide-loading' });
      // forceAi([AI 추천 더 받기])면 기존 결과 아래에 덧붙이고, 아니면 새로 표시
      figma.ui.postMessage({ type: 'recommend-result', original: text, suggestions, appendAi: !!msg.forceAi });
    } catch (e) {
      figma.ui.postMessage({ type: 'hide-loading' });
      if (msg.forceAi) figma.ui.postMessage({ type: 'show-toast', message: errStr(e) });
      else postRecommendFallback(text, errStr(e), undefined, true); // AI 실패 → 폴백 + 재시도 버튼
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
    const convoId = (msg as any).convoId ? String((msg as any).convoId) : '';
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
      const data = await res.json().catch(() => ({} as any));
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
    } catch (e) {
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
    figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem, account: h.account, needConfirm: needsAccountConfirm(h) });
    return;
  }
  // 클로드 로그인 창 열기 — [🟠 클로드 로그인 필요] 버튼이 호출. 다리가 claude 터미널을 대신 열어준다
  if (msg.type === "OPEN_CLAUDE_LOGIN") {
    // 로그인 창을 여는 건 다리다. 계정 화면은 비용 때문에 다리를 안 켜두므로, 여기서 로그인 직전에 다리를 확실히 깨운다.
    // (안 그러면 "다리 꺼짐?" 오류가 난다 — 사용자는 로그인 버튼을 눌렀을 뿐인데.)
    const switchAccount = !!(msg as any).switchAccount;
    async function tryOpenLogin(): Promise<{ ok: boolean; data: any }> {
      try {
        const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/open-login', { switchAccount }, 5000);
        const data = await res.json().catch(() => ({} as any));
        return { ok: res.ok, data };
      } catch (_e) { return { ok: false, data: null }; }
    }
    let r = await tryOpenLogin();
    if (!r.ok && !r.data) {
      // 다리가 꺼져 있었다 — 감시자로 깨우고(claudebridge:// 보조), 뜰 때까지 기다렸다 다시 시도한다.
      // 감시자까지 없으면(=이 PC에 아직 아무것도 설치 안 됨) 오래 기다려도 다리는 안 뜬다 →
      // 12초 헛스피너 대신 짧게만 기다리고 곧장 '설치 필요'로 넘겨 다운로드 안내를 띄운다.
      let watcherWoke = false;
      figma.ui.postMessage({ type: 'show-toast', message: '클로드를 연결하는 중이에요 — 잠시 후 로그인 창이 열려요.' });
      try { await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000); watcherWoke = true; }
      catch (_e) { try { figma.openExternal('claudebridge://start'); } catch (_e2) { /* 둘 다 실패 — 아래 재시도가 알려준다 */ } }
      // 감시자가 응답했으면 다리 기동을 최대 12초 기다린다. 감시자도 없으면(새 PC) 프로토콜 보조만 믿고 3초 뒤 포기 → 설치 안내.
      const tries = watcherWoke ? 8 : 3;
      const gap = watcherWoke ? 1500 : 1000;
      for (let i = 0; i < tries && (!r.ok && !r.data); i++) {
        await new Promise((res) => setTimeout(res, gap));
        if ((await bridgeHealth()).alive) r = await tryOpenLogin();
      }
    }
    // 계정 전환은 '로그아웃 + 브라우저 로그인 화면'으로 끝난다(다리 mode='logged-out') — 로그인을
    // 기다리는 상태가 아니므로 확인했던 계정도 비운다(새 계정으로 로그인하면 다시 확인받게).
    if (r.ok && r.data && (r.data.mode === 'logged-out' || r.data.mode === 'browser-switch')) {
      confirmedClaudeAccount = null;
      figma.clientStorage.setAsync(CONFIRMED_ACCOUNT_KEY, '').catch(() => { /* 저장 실패는 무시 */ });
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
    try { await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/shutdown', {}, 3000); } catch (_e) { /* 이미 꺼졌으면 무시 */ }
    await new Promise((r) => setTimeout(r, 1200)); // 옛 다리가 스스로 종료할 시간
    try { await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000); } catch (e) {
      try { figma.openExternal('claudebridge://start'); } catch (_e2) { /* 보조 경로도 실패 — 아래 상태 확인이 알려준다 */ }
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
    } else if (h.problem === 'bridge-old') {
      // 재시작했는데도 옛 코드 = 감시자가 다른 폴더(설치본 등)의 다리를 켜고 있다 — 경로를 알려준다
      figma.ui.postMessage({ type: 'show-toast', message: '아직 옛 버전이 연결돼요. 이 폴더에서 실행 중이에요: ' + (h.dir || '경로 불명') + ' — 이 폴더를 최신 코드로 업데이트해 주세요.' });
    } else {
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
    try { figma.currentPage.selection = []; } catch (_e) { /* 무시 */ }
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
    try { t = await collectSelectedText(); } catch (_e) { /* 선택 없음 등 */ }
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
    async function tryLogout(): Promise<{ ok: boolean; error?: string } | null> {
      try {
        const res = await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/claude-logout', {}, 10000);
        const d = await res.json().catch(() => ({} as any));
        return { ok: res.ok && d && d.ok, error: d && d.error };
      } catch (_e) { return null; }
    }
    let r = await tryLogout();
    if (r === null) {
      // 다리가 꺼져 있었다 — 깨우고 재시도
      try { await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000); } catch (_e) { /* 감시자도 없으면 아래에서 실패 보고 */ }
      for (let i = 0; i < 6 && r === null; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        if ((await bridgeHealth()).alive) r = await tryLogout();
      }
    }
    if (r && r.ok) {
      confirmedClaudeAccount = null; // 확인했던 계정도 무효화 — 다시 로그인하면 새로 확인받는다
      try { await figma.clientStorage.setAsync(CONFIRMED_ACCOUNT_KEY, ''); } catch (_e) { /* 무시 */ }
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
    let removed: string[] = [];
    try {
      const res = await postJsonWithTimeout(WATCHER_URL + '/uninstall', {}, 6000);
      if (res.ok) {
        watcherReached = true; // 감시자가 자기 제거를 수행함(자동시작·설치 삭제). 감시자는 곧 스스로 종료
        const d = await res.json().catch(() => ({} as any));
        if (Array.isArray(d && d.removed)) removed = d.removed;
      }
      // 404 등(구버전 감시자엔 /uninstall 없음) → watcherReached=false로 두고 아래 안내에 반영
    } catch (_e) {
      // 감시자가 이미 꺼져 있음 = 되돌릴 자동시작이 안 떠 있는 것 → 정상(플러그인 기억만 지우면 됨)
    }
    // 구버전 감시자(/uninstall 없음)는 위에서 404라 못 지웠다 — 최소한 /shutdown으로 꺼서 이 세션에선 '새 PC'가 되게 한다.
    // (자동시작 등록은 플러그인 fetch로 못 지워 재부팅/재로그인 때 되살아날 수 있음 — 완전 제거는 최신 커넥터로 갱신 후 초기화)
    if (!watcherReached) {
      try { await postJsonWithTimeout(WATCHER_URL + '/shutdown', {}, 2000); } catch (_e) { /* 감시자 자체가 없음 — 정상 */ }
    }
    // 감시자 없이 다리만 떠 있을 수도 있으니 직접 한 번 더 끈다 (best-effort)
    try { await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/shutdown', {}, 2000); } catch (_e) { /* 이미 꺼짐 */ }
    // 플러그인 기억(확인한 계정)은 감시자 성패와 무관하게 항상 지운다
    confirmedClaudeAccount = null;
    try { await figma.clientStorage.setAsync(CONFIRMED_ACCOUNT_KEY, ''); } catch (_e) { /* 무시 */ }
    // 감시자(/uninstall 응답 후 자기 종료 ~0.45초)·다리(/shutdown 후 ~0.2초)가 실제로 죽을 때까지 잠깐 기다린다.
    // 이래야 UI의 다음 계정조회가 '계정 없음'을 받아 진짜 새 PC 화면으로 떨어진다(살아있으면 계정이 잡혀 확인 팝업이 뜬다).
    await new Promise((r) => setTimeout(r, 900));
    figma.ui.postMessage({ type: 'reset-result', ok: true, watcherReached, removed });
    return;
  }
  if (msg.type === "CHECK_ACCOUNT") {
    await confirmedAccountLoaded; // 저장된 확인 계정을 읽은 뒤 답해야 UI가 첫 화면을 옳게 정한다
    let account: string | null = null;
    let claudeInstalled: boolean | null = null;
    let source = 'none';
    let watcherOld = false;
    // ① 감시자 /account (비용 0). 단, 옛 감시자(v2)는 이 경로가 없어 404를 준다 — 그건 '답 못 함'이지 '계정 없음'이 아니다.
    try {
      const res = await fetchWithTimeout(WATCHER_URL + '/account', 3000);
      if (res.ok) {
        const d = await res.json().catch(() => ({} as any));
        if (d && d.ok === true && ('account' in d)) {
          account = d.account || null;
          claudeInstalled = (typeof d.claude === 'boolean') ? d.claude : null;
          source = 'watcher'; // v3 감시자가 확정적으로 답함(계정이 null이어도 '로그인 없음'으로 확정)
        } else {
          watcherOld = true; // 응답은 하는데 /account 형식이 아님 = 구버전
        }
      } else {
        watcherOld = true; // 404 등 = 구버전 감시자(경로 없음)
      }
    } catch (_e) { /* 감시자 꺼짐 — 아래 다리 폴백으로 */ }
    // ② 다리에도 물어본다 — (a)감시자가 답을 못 했거나(구버전·꺼짐), (b)감시자는 '계정 없음'이라는데
    //    감시자 캐시(30초)가 낡아서일 수 있는 경우. 다리는 로그인 시 캐시를 비우므로 더 최신이다.
    //    이게 없으면 로그인 직후에도 최대 30초간 '로그인 안 됨'으로 보인다(로그인 화면에 계속 머무름).
    if (!account) {
      try {
        const h = await bridgeHealth();
        if (h.alive && h.account) { account = h.account; claudeInstalled = true; source = 'bridge'; }
      } catch (_e2) { /* 둘 다 없으면 계정 모름 — UI가 '확인 불가'로 안내 */ }
    }
    figma.ui.postMessage({ type: 'account-info', account, claudeInstalled, source, watcherOld, confirmed: confirmedClaudeAccount });
    return;
  }
  // 계정 확인 — UI의 [이 계정 사용] 버튼이 호출. 확인된 계정만 AI 추천·번역에 쓴다
  if (msg.type === "CONFIRM_ACCOUNT") {
    const acct = (msg as any).account ? String((msg as any).account) : '';
    if (acct) {
      confirmedClaudeAccount = acct;
      try { await figma.clientStorage.setAsync(CONFIRMED_ACCOUNT_KEY, acct); } catch (_e) { /* 저장 실패해도 세션 중엔 유효 */ }
      figma.ui.postMessage({ type: 'show-toast', message: acct + ' 계정으로 쓸게요 — 이제 추천받기를 누르면 클로드가 답해요.' });
      refreshBridgeStatus();
    }
    return;
  }
  // 대화로 만들기 최근 대화 목록 — UI가 목록을 통째로 저장/복원한다 (병합 로직은 UI 담당)
  if (msg.type === "LOAD_COMPOSE_HISTORY") {
    let list: unknown[] = [];
    try {
      const raw = await figma.clientStorage.getAsync(COMPOSE_HISTORY_KEY);
      if (Array.isArray(raw)) list = raw;
    } catch (_e) { /* 저장 이력 없음 등 — 빈 목록 */ }
    figma.ui.postMessage({ type: 'compose-history', list });
    return;
  }
  if (msg.type === "SAVE_COMPOSE_HISTORY") {
    const list = Array.isArray((msg as any).list) ? (msg as any).list : [];
    try { await figma.clientStorage.setAsync(COMPOSE_HISTORY_KEY, list); } catch (_e) { /* 저장 실패해도 이 세션 메모리엔 남아 있음 */ }
    return;
  }
  // 클로드 다리 끄기 — [🟢 클로드 켜짐] 버튼을 다시 누르면 호출 (다리의 자기 종료 API)
  if (msg.type === "STOP_BRIDGE") {
    try { await postJsonWithTimeout(CLAUDE_BRIDGE_URL + '/shutdown', {}, 3000); } catch (_e) { /* 이미 꺼져 있으면 무시 */ }
    // 다리는 응답 후 스스로 종료(약 200ms) — 잠깐 기다렸다 실제로 꺼졌는지 확인해 회신
    await new Promise((r) => setTimeout(r, 700));
    let h = await bridgeHealth();
    if (h.alive) { await new Promise((r) => setTimeout(r, 800)); h = await bridgeHealth(); }
    figma.ui.postMessage({ type: 'bridge-status', alive: h.alive, ready: h.ready, model: h.model, problem: h.problem, account: h.account, needConfirm: needsAccountConfirm(h), stopped: !h.alive });
    return;
  }
  // 클로드다리 설치 파일 요청 — UI가 base64를 받아 다운로드로 내려준다 (새 PC 첫 설정용).
  // 맥이면 .command를 zip으로(다운로드가 실행 권한을 못 날라서), 윈도우면 .bat을 그대로.
  if (msg.type === "GET_INSTALLER") {
    if ((msg as any).mac) {
      figma.ui.postMessage({ type: 'installer-file', b64: INSTALLER_MAC_ZIP_B64, name: '클로드-커넥터.zip', mime: 'application/zip' });
    } else {
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
    } catch (e) {
      console.log('[BRIDGE] 감시자 깨우기 실패(감시자 꺼짐?) — 프로토콜 보조 경로 시도:', errStr(e));
      try { figma.openExternal('claudebridge://start'); } catch (e2) { console.log('[BRIDGE] openExternal 실패:', errStr(e2)); }
    }
    return;
  }
};
