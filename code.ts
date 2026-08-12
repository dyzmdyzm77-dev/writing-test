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
const BRIDGE_MIN_V = 38;
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
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21saw0KWjJVcENpOHZJT3k4bk91UmtPdXB0Q0R0bEl6cm42enF0N2pzbmJqc25aZ2dXK3kybE95eW5PdXdtK3E0c0YzcXNJQWdSMlZ0YVc1cElPMkNwQ0RzbDRic25iVHJqNFFnN1lHMDY2R2M2NU9jNjZHY0lFRkpJT3kybE95eW5PeWRoQ0Ryc0p2cmlwVHJpNlF1Q2k4dkNpOHZJT3lHamV1UGhDRHNoS1RxczRRNklPMkJ0T3Vobk91VG5PdWx2Q0RzbXBUc3NxM3JwNGpyaTZRZzdJT0k2NkdjSU95TG5PdVBtZTJWbU91cHRDQXpNSDQwTU95MGlPcXdnQ0RxdDdqcmc2VWc2NEtnN0pXRTZyQ0U2NHVrTGdvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0NpOHZJQ0FnNnJDQTdKMjA2NU9jSyt5WWlPeUxuQ2d4TVRIcXNiUXA2NHFVSU95eXF5RHJxWlRzaTV6c3A0RHJvWndnN1pXY0lPdXlpT3VuakNEc25iM3QNCm5venJpNlF1SU95ZHRPMmJoQ0RzbXBUc3NxM3NuWUFnNjZ5NDZyV3M2NmVNSU91enRPdUN0T3V2Z091aG5DRHJ1YURycGJUcmk2UXVDaTh2SU95RXVPeUZtT3lkZ0NBek1PdXlpQ0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3WlcwSU91TWdPMlpsT3F3Z0NEcnJMVHRsWnp0bm9nZzZyaTQ3SmEwN0tlQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaTh2Q2k4dklPeWdoT3lnbkRvZzdKMjBJRkJEN0plUUlFTnNZWFZrWlNCRGIyUmw2ckNBSU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0NjQrOElPeWVpT3lkaENEcXNvTWdLR05zWVhWa1pTQXRMWFpsY25OcGIyNGc3Snk4NjZHY0lPMlpsZXlkdUNrS0x5OGc3S084N0oyWU9pRHNncXpzbXFucm40bnNuWUFnNnJDQjdKNlFJTzJCdE91aG5PdVRuQ0RxdGF6cmo0VWc3WldjNjQrRTdKZVE3SVNjSU95d3FPcXdrT3VRbk91THBDNEtDbU52Ym5OMElHaDBkSEFnUFNCeVpYRjFhWEpsS0Nkb2RIUndKeWs3Q21OdmJuTjBJR1p6SUQwZ2NtVnhkV2x5WlNnblpuTW5LVHNLDQpZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdA0KWTNka0p5azdDblJ5ZVNCN0lHWnpMbTFyWkdseVUzbHVZeWhGVFZCVVdWOURWMFFzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsSUgwcE95QjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJyTFRzaTV3Z0tpOGdmUXBqYjI1emRDQkRURUZWUkVWZlJVNVdJRDBnVDJKcVpXTjBMbUZ6YzJsbmJpaDdmU3dnY0hKdlkyVnpjeTVsYm5Zc0lIc0tJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcENpQWdRMHhCVlVSRlgwTlBSRVZmUkVsVFFVSk1SVjlPVDA1RlUxTkZUbFJKUVV4ZlZGSkJSa1pKUXpvZ0p6RW5MQ0F2THlEdGhMUWc3SnFVN0pXOUlPdVRzU0RydG9EcXNJQWc3Wmk0N0xhY0lPdUJsQW9nSUVSSlUwRkNURVZmVkVWTVJVMUZWRkpaT2lBbk1TY3NDbjBwT3dvS0x5OGc3SWlvNnJtQUlPeUxwTzJXaVNqcXNKRHNpNXpzbnBBZzdJcWsNCjdZK3c3SjJBSUhOMFpHbHZJR2xuYm05eVpTbnNsNURzaEp6cmo0UWc2Nnk0N0tDYzY2VzhJT3kybE95Z2dlMlZvQ0RzaUpnZzdKNkk2cktNSU95OW1PeUdsQ0Ryb1p6cXQ3anJwYndnN1l5TTdKMjg3SmVRNjQrRUlPdUNxT3E0dE91THBDNEtMeThnN0p5RTdMbVlPaURzbm9Uc2k1d2c3WSswNjQyVTdKMllJR05zWVhWa1pTMWljbWxrWjJVdWJHOW5JQ2pzbklqcmo0VHNtckFnSlZSRlRWQWxMQ0RycDZVZ0pGUk5VRVJKVWlrdUlESk5RaURyaEpqc25MenJxYlFnTG05c1pPdWhuQ0R0bFp3ZzdJUzQ2NHlBNjZlTUlPdXp0T3EwZ0M0S1kyOXVjM1FnVEU5SFgwWkpURVVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExteHZaeWNwT3dwamIyNXpkQ0JmYjNKcFoweHZaeUE5SUdOdmJuTnZiR1V1Ykc5bkxtSnBibVFvWTI5dWMyOXNaU2s3Q21OdmJuTnZiR1V1Ykc5bklEMGdablZ1WTNScGIyNGdLQ2tnZXdvZ0lHTnZibk4wSUdGeVozTWdQU0JCY25KaGVTNXdjbTkwDQpiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bg0KYVdaNUtHRXBLU2t1YW05cGJpZ25JQ2NwSUNzZ0oxeHVKenNLSUNBZ0lHWnpMbUZ3Y0dWdVpFWnBiR1ZUZVc1aktFeFBSMTlHU1V4RkxDQnNhVzVsS1RzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHRqSXpzbmJ3ZzY2R2M2cmU0SU95THBPMk1xTzJWdE91UGhDRHJpNlRycHF6cmlwUWc2ck9FN0lhTklDb3ZJSDBLZlRzS0NtTnZibk4wSUZCUFVsUWdQU0JPZFcxaVpYSW9jSEp2WTJWemN5NWxibll1UWxKSlJFZEZYMUJQVWxRcElIeDhJREV4T0RnNE95QXZMeUJDVWtsRVIwVmZVRTlTVk91S2xDRHRoWXpzaXFUdGlyanNtcWtnS08yUGlleUdqT3lYbENBeE1UZzRPQ0RxczZEc29KVXBDaTh2SU91THBPdW1yQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0F2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDNGc3TDJVNjVPYzY2VzhJSEIxYkd6Q3QrdXp0ZXlDck8yVnRPdVBoQ0FxS3V5ZHRPdXZ1Q0RybHFBZzdKNkk2NHFVSU91THBPdW1yT3VLbENEc21Kc2c3TDJVNjVPY0lPcTN1T3VNZ091aG5Db3ENCjY1MjhDaTh2SU9xN2tPdUxwQ0Rzdkp6cXVMQWc3S0NFN0plVUlPeURpQ0RyajVuc25wSHNuYlFnN0pXSUlPdUNtT3lZcU91THBDanRoTERycjdqcmhKRHNuYlFnNjV5bzY0cVVJT3VUc1NrdUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEc25iUWc2ckNTN0p5ODY2R2NJT3Exck91eWhPeWdoT3lkaENEcXNKRHNwNER0bGJRZzdKNnM3SXVjN0o2UjdJdWM3WUtvNjR1a0xnb3ZMeURyajVuc25wSHNuYlFnNjdDVTY0Q002NHFVSU95SW1PeWdsZXlkaENEdGxaanJxYlFnN0oyMElPeUlxK3lla091bHZDRHNtS3pycHF6cXM2QWdZMjlrWlM1MGMreWRtQ0JDVWtsRVIwVmZUVWxPWDFicmo0UWc2ckNaN0oyMElPeVlyT3Vtc091THBDNEtZMjl1YzNRZ1FsSkpSRWRGWDFZZ1BTQXpPRHNLTHk4ZzZyaXc2N080SU91cXFPdU51QzRnN0pxVTdMS3RLTzJVak91ZnJPcTN1T3lkdUNuc25iUWdiVzlrWld6c25ZUWc3S2VBN0tDVjdaV1k2Nm0wSU9xM3VDRHNtcFRzc3EzcnA0d2c2cmU0SU91cXFPdU51T3VobkNEc3NwanJwcXp0DQpsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPYw0KSUNoeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUWc0b0NVSUdKMWFXeGtMV2RzYjNOellYSjVMbXB6N0ptQUlPcXdtZXlkZ0NEdGpJenNoSndwSU9LVWdPS1VnQXBtZFc1amRHbHZiaUJzYjJGa1JYaGhiWEJzWlhNb0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzFrSUQwZ1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNzSUNkeVpXTnZiVzFsYm1RdFpYaGhiWEJzWlhNdWJXUW5LU3dnSjNWMFpqZ25LVHNLSUNBZ0lHTnZibk4wSUhObFkwbGtlQ0E5SUcxa0xuTmxZWEpqYUNndlhpTWpJT3kybE95eW5DRHNtSWpzaTV4Y2N5b2tMMjBwT3dvZ0lDQWdhV1lnS0hObFkwbGtlQ0E5UFQwZ0xURXBJSEpsZEhWeWJpQmJYVHNLSUNBZ0lHTnZibk4wSUdWNFlXMXdiR1Z6SUQwZ1cxMDdDaUFnSUNCc1pYUWdZM1Z5SUQwZ2JuVnNiRHNLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjbUYzSUc5bUlHMWtMbk5zYVdObEtITmxZMGxrZUNrdWMzQnNhWFFvSjF4dUp5a3ANCklIc0tJQ0FnSUNBZ1kyOXVjM1FnYkdsdVpTQTlJSEpoZHk1eVpYQnNZV05sS0M5Y2N5c2tMeXdnSnljcE93b2dJQ0FnSUNCamIyNXpkQ0JvSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYaU1qSTF4ekt5Z3VLejhwWEhNcUpDOHBPd29nSUNBZ0lDQnBaaUFvYUNrZ2V5QmpkWElnUFNCN0lHbHVjSFYwT2lCb1d6RmRMQ0J6ZFdkblpYTjBhVzl1Y3pvZ1cxMGdmVHNnWlhoaGJYQnNaWE11Y0hWemFDaGpkWElwT3lCamIyNTBhVzUxWlRzZ2ZRb2dJQ0FnSUNCamIyNXpkQ0JpSUQwZ2JHbHVaUzV0WVhSamFDZ3ZYbHh6S2kxY2N5c29MaXMvS1Z4ektpUXZLVHNLSUNBZ0lDQWdhV1lnS0dJZ0ppWWdZM1Z5S1NCamRYSXVjM1ZuWjJWemRHbHZibk11Y0hWemFDaGlXekZkTG5Od2JHbDBLQ2NnTHlBbktTNXFiMmx1S0NjZ0p5a3BPd29nSUNBZ2ZRb2dJQ0FnY21WMGRYSnVJR1Y0WVcxd2JHVnpMbVpwYkhSbGNpZ29aU2tnUFQ0Z1pTNXpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ2dQaUF3S1RzS0lDQjlJR05oZEdOb0lDaGxLU0I3DQpDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpdw0KSU9xem9PeTVxQ0FySU95V3RPeUluQ0RyczREcXNyMGk3SjIwSU91UW5PdUxwQzRnN0pldDdaV2dJT3UyaE91bXJDRGlnSlFLTHk4ZzdZRzA2NkdjNjVPY0lEMGc2Nnk0N0o2bElPdUxwT3VUck9xNHNDanNzTDNzblpncExDRHNtcW5zbHJRZzdZYTE3SjI4d3JmcnA1N3N0cVRyc3BVZ1BTQmpiMlJsTG5SeklISmxabWx1WlVGcFUzVm5aMlZ6ZEdsdmJuTWc3WnVFN0xLWTY2YXNLT3E0c09xemhPeWdnU2t1Q21OdmJuTjBJRk5VV1V4RlgxSlZURVZUSUQwZ1d3b2dJQ2N4TGlEdGxiVHNtcFRzc3JRNklPdXFxT3VUb0NEcnJManF0YXpyaXBRZzdaVzA3SnFVN0xLMDY2R2NMaUFvNjdPMDY0T0Y2NHVJNjR1azRvYVM2N08wNjRLMDdKcVVLU2NzQ2lBZ0p6SXVJT3VLcGV1UG1leWdnU0RycDVEdGxaanF1TEE2SU91UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDd2dmdXlYaUNEcnVienF1TEFvNjdDVTY0Q003SmVJN0phMDdKcVU0b2FTNjdDVTZyK283SmEwN0pxVUtTNGc2NHVvTENEc29vWHJvNHpDdCt1bmpPdWoNCmpNSzM3SmV3N0xLMHdyZnRsYlRzcDREQ3QrcTRzT3VobmNLMzY0VzU3SjJNSU91VHNTRHNpNXpzaXFUdGhaenNuYlFnN0tPODdMSzA3SjI0SU9xeXNPcXp2T3VLbENEc2lKanJqNW50bUpVZzdKeWc3S2VBS095WHNPeXl0T3VQdk95YWxDd2c2NFc1N0oyTTY0Kzg3SnFVS1M0bkxBb2dJQ2N6TGlEcXVJM3NvSlhzb0lFZzY2ZVE3WldZNnJpd09pQWlmdTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVJaURyaklEc2k2QWdJbjd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWlJT3Exck95aHNDRHNtckRzaEtBdUlPdUxxQ3dnN0tDVjdMR0Y3SU9CSU91MmlPcXdnTUszN0oyODY3YUFJT3E0c091S3BTRHNvSnp0bFp6Q3QrdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3F5c09xenZNSzM3S0NWNjdPMElPdXp0TzJZdUNEc2xZanNpNnpzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJlaUM0bkxBb2dJQ2MwTGlEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phME9pQis3WldZN0l1YzZyS2c3SmEwDQo3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cA0KTGljc0NpQWdKell1SU8yUm5PcTRzRG9nNjVDWTdKYTA3SnFVNG9hUzY0Kzg3SnFVTGljc0NpQWdKemN1SU95a2hDRHF0YXpzb2JBNklPeWJrT3V6dU95ZHRDRHRsWndnN0tTRTdKMjA2Nm0wSU95MmxPeXluT3VQaENEcnNKanJrNXpzaTV3ZzdaV2NJT3lraE91aG5DNGc3SjZFN0oyWTY2R2NJT3lraE95ZGhDRHJpcGpycHF6c3A0QWc3SldLNjRxVTY0dWtMaURyaTZnc0lPeVhyT3VmckNEcnJManNucVhzbllRZzdaV1k2NEtZN0oyWUlPcTRqZXlnbGUyWWxTRHJyTGpzbnFYc25MenJvWndnN1pXcDdMT1FJT3VObENEcXNJVHFzckR0bGJUc3A0VHJpNlRycWJRZzdLU0VJT3lJbU91bHZDRHNwSVRzbmJUcmlwUWc2cktEN0oyQUlPMlptT3lZZ1M0bkxBb2dJQ2M0TGlEdGpKM3NsNFVvNjR1azdKMjA3SmE4NjZHYzZyZTRLU0Ryc29UdGlydzZJT3F5c09xenZDRHRoclhyczdUcmlwUWdXKzJabGV5ZHVGMHNJT3lZaUMvc2xZVHJpNGpzbUtRZzdZeVE2NHVvN0oyQUlGdnNsWVRyaTRqc21LUmRMMXZyaEtSZExDRHINCmo1bnNucEVnN0p5ZzY0K0U2NHFVSUZ2c3Q2anNob3hkTDF0NzY0K1o3SjZSZlYwdUlDTHN0NmpzaG93aTY0cVVJT3VQbWV5ZWtTRHJzb1R0aXJ6cXM3d2c3S2VkN0oyOElPdVZqT3VuakNEc2s3RHFzNkFnSXV1THErcTRzTUszNjQrWjdKNlJJdXl5bU91ZnZDRHNwNTBnN0pXSUlPdW5udXVLbENEc29iRHRsYW5DdCt1THFPdVBoU0FpN0xlbzdJYU1JdXVLbENEcXVJanNwNEF1Snl3S0lDQW5PUzRnN0oyMDY2YUV3cmZzb0lUdG1aVHJzb2p0bUxqQ3QrdW5pT3lLcE8yQ3VleWRnQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzBMaURzZ3F6cm5venNuWVFnNjdhQTY2VzhJT3VWa0NEcmk1anNuWVFnNjdhWjdKZXM2NCtFSU95aWkrdUxwQzRuTEFvZ0lDY3hNQzRnN0tDYzdaS0lJT3lhcWV5V3RDRHNuS0RzcDRBNklPeWVoZXVncGV5WGtDRHNrN0RzbmJnZzZyaXc2NHFsN0lTeElPdXFoZXlDckNqcnM0RHFzcjBzSU95bmdPeWdsU3dnNjVPeDY2R2RMQ0R0bGJUc29Kd2c2NU94S2V1S2xDRHRtWlRycWJUc25aZ2c2cml3DQo2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqcw0KaUpqcmo1bnRtSlhDdCtxeXZleVd0TUszNjdhQTdLQ1Y3WmlWSU8yWGlPeWFxU0RzdklEc25iVHNpcVFwN0oyWUlPdUptT3lWbWV5S3BPcXdnQ0RzbktEc2k2VHJrSnpyaTZRdUNpOHZJTzJNak95ZHZPeWR0Q0RzbDRic25MenJxYlFvN0lTazdMbVk2N080SU9xMXJPdXloT3lnaENEcms3RXBJT3U1aUNEcnJManNucERzbDdRZzRvQ1VJT3lhbE95VnZldW5qT3ljdk91aG5DRHJqNW5zbnBFb1ptRnBiQzF6YjJaMEtTNEtablZ1WTNScGIyNGdiRzloWkVkMWFXUmxLQ2tnZXdvZ0lIUnllU0I3Q2lBZ0lDQmpiMjV6ZENCdFpDQTlJR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9YMTlrYVhKdVlXMWxMQ0FuTGk0bkxDQW5kWGd0ZDNKcGRHbHVaeTV0WkNjcExDQW5kWFJtT0NjcExuUnlhVzBvS1RzS0lDQWdJSEpsZEhWeWJpQnRaQzVzWlc1bmRHZ2dQaUF4TURBZ1B5QnRaQ0E2SUNjbk93b2dJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2lxVHQNCmc0RHNuYndnNnJDQTdKMjA2NU9jSU91aG5PdVRuQ0RzaTZUdGpLZ2dLT3lhbE95VnZldW5qT3ljdk91aG5DRHNwNFR0bG9rcE9pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQnlaWFIxY200Z0p5YzdDaUFnZlFwOUNtTnZibk4wSUVkVlNVUkZJRDBnYkc5aFpFZDFhV1JsS0NrN0NncG1kVzVqZEdsdmJpQnBibk4wY25WamRHbHZiazFsYzNOaFoyVW9LU0I3Q2lBZ1kyOXVjM1FnWm1WM1UyaHZkQ0E5SUVWWVFVMVFURVZUTG0xaGNDZ29aWGdwSUQwK0lDZEpibkIxZERvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtHVjRMbWx1Y0hWMEtTQXJJQ2RjYms5MWRIQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExuTjFaMmRsYzNScGIyNXpLU2t1YW05cGJpZ25YRzRuS1RzS0lDQnlaWFIxY200Z0tBb2dJQ0FnSit5bmdPcTRpT3UyZ08yRXNDRHJoSWpyaXBRZzdKZVE3SXFrN0p1UUtGTXRNU3dnNjdPMDdKV0k3WnFNN0lLc0tleWRtQ0R0bFp6cXRhM3NsclFnVlZnZ1YzSnBkR2x1WnlEc29JVHJyTGpxDQpzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91TA0KcEM0Z0p5QXJDaUFnSUNBbjdLR3c2ckcwSU8yUm5PMlloQ2pzbmJUc2c0SEN0K3lkdE8yVm1NSzM3SjIwNjRLMHdyZnN0SWpxczd6Q3QrdXZ1T3Vuak1LMzY3YUE3WVN3d3JmcXVZenNwNEFnNjVPeEtleWRnQ0Rzb0pYc3NZVWc3S0NWNjdPMDY0dWtJT0tBbENEcnVienFzYkRyZ3BnZzY0dWs2Nlc0SU95aHNPcXh0T3ljdk91aG5DRHJzSlRxdnJqc3A0QWc2NmVJNjUyOEtDSTE3WnFNSU95ZHRPeURnU0xzbllRZ0lqWHRtb3dpNjZHY0lPeWtoT3lkdE91cHRDRHNtS1RyaTdVcExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc2w1QWc3SmVHNjRxVUlPcTFyT3l5dENEc29KWHJzN1FvN0tDRTdabVU2N0tJN1ppNHdyZFZVa3pDdCtxNGlPeVZvY0szN0l1YzZyQ0VJT3VUc1Nuc21ZQWc3WlcwNnJLd0lPdXdxZXV5bGNLMzdLQ0k3TENvS095ZXJPeUVwT3lnbGNLMzY2eTQ3SjJZN0xLWXdyZnNucXpzaTV6cmo0UWc2NU94S2V1bHZDRHNwNERzbHJUcmdyUWc2N2FaN0oyMDY0cVVJT3F5Zyt5ZGdDRHNvSWpyaklBZzZyaUkNCjdLZUFJT0tBbENEc2xZVHJpcFFnNnJDUzdKMjA2NTI4NjQrRUxDRHF0N2pybjdUcms2L3RsYlRyajRRZzdKT3c3S2VBSU91bmlPdWR2QzVjYmljZ0t3b2dJQ0FnSnpQcXNKd2c3S0NjN0pXSTdKMkFJT3lFbk91aG5DRHNvSkhxdDd6c25iUWc2NHVzNjUyODdKVzhJTzJWbk91THBDRGlnSlFnN1pXWTY0S1k2NHFVSU95YmtPdXN1Q0RxdGF6c29iRHJwYndnN0p5ZzdLZUE3WldjSU95MW5PeUdqQ0RyaTZUcms2enF1TEFzSU8yVm1PdUNtT3VLbENEcnJManNucVVnNnJXczdLR3c2Nlc4SU95ZXJPcTFyT3lFc2UyVm5DRHJqSURzbFlnc0lDY2dLd29nSUNBZ0orcTN1T3Vtck9xem9DRHNvSUhzbHJUcmo0UWc3WldZNjRLWTY0cVVJT3F6dk9xd2tPMlZuQ0RzbnF6cXRhenNoTEU2SU95a2tldXp0U0R0a1p6dG1JVHNuWVFnNjQyYzdKYTA2NEswNnJPZ0xDRHNvSlhyczdRZzdJaWM3SVNjNjZXOElPeUNyT3lhcWV5ZWtPcXdnQ0RzbFl6c2xZVHNsYndnN1pXZ0lPcXlnK3UyZ08yRXNPdWhuQ0RzbnF6c29iRHNwNEh0DQpsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZw0KSUNBZ0oreVZoT3VlbUNEc21JanNpNXpyazZUc25ZQWc3WldjSU95a2hPeW5uT3VtckNEc3RaenNob3dnNnJXUTdLQ1Y3SjIwSU91bmp1eW5nT3VuakNEcXQ3anFzYlFnN1lha0tPMlZ0T3lhbE95eXRNSzM2cks5N0phMEtleWRtQ0RxdFpEcnM3anNuYlRzcDRBZzdJYU02cmU1N0lTeDdKMllJT3Exa091enVPeWR0Q0RzbFlUcmk0anJpNlFnNG9DVUlPeVhyT3VmckNEcnJManNucVhzcDV6cnBxd2c3SjZGNjZDbDdKMkFJT3VwbE95TG5PeW5nQ0RyaTZqc25JVHJvWndnNjR1azdJdWNJT3lFcE9xemhPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURyc0xEc2w3VHJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoY0szN0wyVTY1T2M3WTZjN0lxa0lPcTRpT3luZ0RwY2JpY2dLd29nSUNBZ0oxdDdJblJsZUhRaU9pQWk3S0NjN0pXSUlPdXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2cNCkl1dXN0T3lYaCt5ZGhDRHNtWndnNjdDVTZyK282NHFVN0tlQUlPMlZuT3ExcmV5V3RDRHRsWndnNjZ5NDdKNmxJbjBzSUM0dUxsMWNibHh1SnlBckNpQWdJQ0FuVyt5S3BPMkRnT3lkdkNEcXQ1enN1WmxkWEc0bklDc2dVMVJaVEVWZlVsVk1SVk1nS3lBblhHNWNiaWNnS3dvZ0lDQWdLRWRWU1VSRklEOGdKMXZzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jSU95Z2hPdXN1Q0FvZFhndGQzSnBkR2x1Wnk1dFpDa2c0b0NVSU95Y2hDRHF0NXpzdVpuc25aZ2c2cmU4NnJHdzdKbUFJT3lZaU95WnVDRHNpNXpyZ3BqcnBxenNtS1F1SU8yS3VlMmVpQ0RzbUlqc21iZ2c2cmVjN0xtWktPeUltT3VQbWUyWWxjSzM2cks5N0phMHdyZnJ0b0Rzb0pYdG1KWHNuWVFnN0p5ZzdLZUE3WlcwN0pXOElPMlZtT3VLbENEc2c0SHRtYWtwN0oyRUlPcTN1T3VNZ091aG5DRHJsTERycGJUcXM2QXNJT3lhbE95VnZlcXp2Q0Rzb0lUcnJManNuYlFnNjR1azY2VzA2Nm0wSU95Z2hPdXN1T3lkaENEcmxMRHJwYmpyaTZSZFhHNG5JQ3NnDQpSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cA0KYm1WQ2RXWWdQU0FuSnpzZ0lDQWdJQ0FnSUNBdkx5QnpkR1J2ZFhRZzdLU0VJT3V5aE8yTnZBcHNaWFFnZDJGcGRHVnlJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDOHZJTzJZaE95ZXJDRHRoTFRzblpnZ2V5QnlaWE52YkhabExDQnlaV3BsWTNRc0lIUnBiV1Z5SUgwS2JHVjBJSEYxWlhWbElEMGdVSEp2YldselpTNXlaWE52YkhabEtDazdJQzh2SU95YWxPeXlyU0RzcDRIcm9LenRtWlFnS091UG1leUxuQ0RzbXBUc3NxM3NuWUFnN0lpYzdJU2M2NHlBNjZHY0tRcHNaWFFnZEhWeWJuTWdQU0F3T3dwc1pYUWdkMkZ5YldWa1ZYQWdQU0JtWVd4elpUc0tiR1YwSUdOMWNuSmxiblJOYjJSbGJDQTlJRU5NUVZWRVJWOU5UMFJGVERzZ0x5OGc3S2VBNnJpSUlPeUV1T3lGbU95ZHRDRHJyTHpxczZBZzdKNkk2NHFVSU91cXFPdU51Q0FvN0pxVTdMS3Q3SjIwSU91THBPdWx1Q0RycXFqcmpianNuWVFnN0tlQTdLQ1Y3WldZNjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFcENpOHZJT3lMbk95ZWtTRHNpNXdnUTJ4aGRXUmwNCklFTnZaR1VvWTJ4aGRXUmxJRU5NU1NucXNJQWc3Sk80SU95SW1DRHNub2pyaXBUc3A0QWc3S0NRNnJLQUlPS0FsQ0RzbDRic25MenJxYlFnTDJobFlXeDBhT3VobkNEc2xZenJvS1FnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZuT3VMcEM0S0x5OGdiblZzYkQzdG1aWHNuYmdnN0tTUkxDQW5iMnNuUGV5Q3JPeWFxU0Rxc0lEcmlxVXNJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzlZMnhoZFdSbElPdXFoZXVndVNEc2w0YnNuWXdzQ2k4dklDZGpiR0YxWkdVdGJHOW5iM1YwSnoxamJHRjFaR1hyaXBRZzdKNkk3S2VBNjZlTUlPdWhuT3EzdU95ZHVDRHNoTGpzaFpnZzY2ZU02Nk9NSUNqdGhMUWc3SXVrN1l5b0lPeUxuQ0Rxc0pEc3A0QXNJT3lFc2VxenRTRHRoTFRzbmJRZzdKaWs2Nm0wSU95ZWtPdVBtU0R0bGJUc29Kd3BDaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzDQpucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWg0KN0oyQUlPcXl2ZXVobk91aG5DRHNucUh0bm9qcnI0RHJvWndnN0tTUjY2YTlJTzJSbk8yWWhPeWRoQ0RzazdUcmk2UUtZMjl1YzNRZ1RFOUhTVTVmUjFWSlJFVWdQU0FuN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lkdU95ZHRDRHRsWVRzbXBUdGxiVHNtcFFvN0pXSUlPdVFrT3F4c091Q21DRHJwNHpybzR3cElPS0FsQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGMGc2N0tFN1lxODdKMkVJT3VJaE91bHRPdXB0Q0Ryb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3lYdE95V3RPdVRuT3VncE95YWxDNG5Pd292THlEc2k2VHN1S0h0bFp3ZzY2eTQ2cldzNjVPa09pQWlSbUZwYkdWa0lIUnZJR0YxZEdobGJuUnBZMkYwWlRvZ1QwRjFkR2dnYzJWemMybHZiaUJsZUhCcGNtVmtJR0Z1WkNCamIzVnNaQ0J1YjNRZ1ltVWdjbVZtY21WemFHVmtJaWpycDR6cm80d3BMQW92THlBaVRtOTBJR3h2WjJkbFpDQnBiaURDdHlCUWJHVmhjMlVnY25WdUlDOXNiMmRwYmlJbzY2KzQ2NkdjNnJlNDdKMjQNCktTRGlnSlFnNjVHWUlPdUxwQ0RzbnFIdG5vanFzb3dnNjRTVDdaNk02NHVrQ21aMWJtTjBhVzl1SUdselFYVjBhRVZ5Y205eUtITXBJSHNLSUNCeVpYUjFjbTRnTDJGMWRHaGxiblJwWTJGMGZHOWhkWFJvZkdGd2FTQnJaWGw4Ykc5bklEOXBibnhzYjJkblpXUjhjMlZ6YzJsdmJpQmxlSEJwY21Wa0wya3VkR1Z6ZENoVGRISnBibWNvY3lrcE93cDlDaTh2SU95Q3JPeWFxU0R0bFp6cmo0UWc3TFNJNnJPOElPcXdrT3luZ0NEaWdKUWc2NkdjNnJlNDdKMjQ3SjJBSU91cGdPeXBvZTJWbk91TnNDQWk2NDJVSU91cXV5RHNrN1RyaTZRaTY0cVVJT3F5dmV5YXNDNGc2NkdjNnJlNDdKMjRJT3Vuak91ampPeVpnQ0Rzb2JEc3VaanFzSUFnNjR1czY1Mjg3SVNjSU91VXNPdWhuQ0RzbnFIcmlwVHJpNlF1Q2k4dklPeUxwT3k0b1NneU1ESTJMVEE0TENEdG1venNncXdnN0plVTdZU3c3WlNFNjUyODdKMjA3S2FJSU95aWpPeUVuU2s2SUNKWmIzVW5kbVVnYUdsMElIbHZkWElnYVc1a2FYWnBaSFZoYkNCemNHVnVaQ0JzDQphVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6cw0KbnBEc2w1RHFzb3dnN1pXYzY0K0U2Nlc4SU95WXJPdWdwQ0RyaTZ6cm5ienFzNkFnN0pxVTdMS3Q3WldZNnJPZ0xDRHNsWVRyaTRqcnFiUWdXL0NmbjZBZzdZRzA2NkdjNjVPY0lPMlZuT3VQaENEc3RJanFzN3hkSU91eWhPMkt2T3lkaENEcmlJenJuNndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxiUWc3S084N0lTNDdKcVVMaWM3Q2k4dklDZnRsWnpyajRRbjY2R2NJT3V0aWV1YXNlcTN1T3Vtck91cHRDRHNsWWdnNjVDYzY0dWtJT0tBbENEc25xRHF1WkFnNjZxdzY2YTBJT3VWakNEcmdwanJpcFFnY21GMFpTQnNhVzFwZE95ZHRPdUNtQ0RyckxqcnA2VWc2cmk0N0oyMElPeTBpT3F6dk9xNWpPeW5nQ0RzbnFIc2xZUUtMeThnN0plSjY1cXg3WldZNnJLTUlDTHJpNlRycGJnZzZyT0U3S0NWN0p5ODY2R2NJT3Vobk9xM3VPeWR1TzJWbU91ZHZDTHFzNkFnN0pXSTY0SzA3WldZNnJLTUlPdVFuT3VMcEM0ZzdLZUE3TGFjd3Jmc2dxenNtcW5ybjRrZzdJT0I3WldjSU91c3VPcTENCnJPdW5qQ0Rzb29IdG1JRHNoSndnNjdPNDY0dWtDbVoxYm1OMGFXOXVJR2x6VEdsdGFYUkZjbkp2Y2loektTQjdDaUFnY21WMGRYSnVJQzl6Y0dWdVpDQnNhVzFwZEh4MWMyRm5aUzFqY21Wa2FYUnpmSFZ6WVdkbElHeHBiV2wwSUNoeVpXRmphR1ZrZkdWNFkyVmxaR1ZrS1M5cExuUmxjM1FvVTNSeWFXNW5LSE1wS1RzS2ZRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU8yWmxleWR1Q0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOejY2VzhJT3lkdmV5V3RBb3ZMeUF2YUdWaGJIUm82NkdjSU91RnVPeTJuTzJWbk91THBDQW83WlNNNjUrczZyZTQ3SjI0N0oyMElDTHJpSVRxdGF3ZzZyT0U3S0NWN0p5ODY2R2NJT3lUc091S2xDRHNwSkhzbmJqc3A0QWlJTzJSbk95TG5DRGlnSlFnNnJPMTdKcXBJRkJEN0plUTdJU2NJT3VDcU95ZG1DRHFzNFRzb0pVZzdKaWs3SUtzN0pxcElPdXdxZXluDQpnQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMA0KSU95ZHRDRHFzSkxxczd3ZzdZeU03SjI4N0oyWUlPcXpoT3lnbGV5ZHRDRHNsclRxdUl2cmdwenJpNlFLYkdWMElITmxjM05wYjI1QlkyTnZkVzUwSUQwZ2JuVnNiRHNLWm5WdVkzUnBiMjRnWTJ4aGRXUmxRV05qYjNWdWRDZ3BJSHNLSUNCcFppQW9SR0YwWlM1dWIzY29LU0F0SUdGalkyOTFiblJEWVdOb1pTNWhkQ0E4SURNd01EQXdLU0J5WlhSMWNtNGdZV05qYjNWdWRFTmhZMmhsTG1WdFlXbHNPd29nSUd4bGRDQmxiV0ZwYkNBOUlHNTFiR3c3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aHdZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlM1cWMyOXVKeWtzSUNkMWRHWTRKeWtwT3dvZ0lDQWdaVzFoYVd3Z1BTQW9haUFtSmlCcUxtOWhkWFJvUVdOamIzVnVkQ0FtSmlCcUxtOWhkWFJvUVdOamIzVnVkQzVsYldGcGJFRmtaSEpsYzNNcElIeDhJRzUxYkd3N0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2cNCjY2R2M2cmU0N0oyNElPeWR0T3VncFNEc2w0YnNuWXdnNjVPeElPS0FsQ0J1ZFd4c0lPeWNvT3luZ0NBcUx5QjlDaUFnWVdOamIzVnVkRU5oWTJobElEMGdleUJoZERvZ1JHRjBaUzV1YjNjb0tTd2daVzFoYVd3Z2ZUc0tJQ0J5WlhSMWNtNGdaVzFoYVd3N0NuMEtablZ1WTNScGIyNGdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1NCN0NpQWdZMjl1YzNRZ2NISnZZbVVnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3ljdExYWmxjbk5wYjI0blhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXSUgwcE93b2dJR3hsZENCdmRYUWdQU0FuSnpzS0lDQndjbTlpWlM1emRHUnZkWFF1YjI0b0oyUmhkR0VuTENBb1pDa2dQVDRnZXlCdmRYUWdLejBnWkM1MGIxTjBjbWx1WnlncE95QjlLVHNLSUNCd2NtOWlaUzV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzdJSDBwT3dvZ0lIQnliMkpsTG05dUtDZGpiRzl6DQpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVA0KWldNNklDY25JSDA3Q2dvdkx5RGlsSURpbElBZzdaU002NStzNnJlNDdKMjRJT3lEbmV5aHRDRHFzSkRzcDRBbzdJdXM3SjZsNjdDVjY0K1pLU0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQUtMeThnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3VXb0NEc25vanJpcFFnNjQrWjdKV0lJR052WkdVdWRIUHFzSUFnTmV5MGlPdW5pT3VMcENCUVQxTlVJQzlvWldGeWRHSmxZWFRycGJ3ZzY3TzA2NEs0NjR1a0xnb3ZMeUR0bFp3ZzY3S0k3SjIwNjUyODY0K0VJT3V3bSt5ZGdDRHJrcVFnTXpEc3RJanFzSVFnNjRHSzZyaXc2Nm0wSU8yVWpPdWZyT3EzdU95ZHVDanJtSkRyaXBRZzdaUzg2cmU0NjZlSUtleWR0Q0RyaTZ2dG5vd2c2cktESU9LQWxDRHRnYlRyb1p6cms1enF1WXpzcDRBZzY0Mnc2NmFzNnJPZ0lPcXdtZXlkdENEcXVyenNwNFRyaTZRdUNpOHYNCklPeVZoT3luZ1NEdGxad2c2N0tJNjQrRUlPdXF1eURyc0p2c2xaanNuTHpycWJRbzY0dWs2NmFzNjZlTUlPdW92T3lnZ0NEc3ZLQWc3SU9CN1lPY0xDRHNucERyajVuc2k1enNucEVnNjVPeEtTRHFzNFRzaG8wZzY0eUE2cml3N1pXYzY0dWtMZ3BqYjI1emRDQklSVUZTVkVKRlFWUmZSRVZCUkY5TlV5QTlJRE13TURBd093cHNaWFFnYkdGemRFSmxZWFFnUFNBd093cHpaWFJKYm5SbGNuWmhiQ2dvS1NBOVBpQjdDaUFnYVdZZ0tHeGhjM1JDWldGMElDWW1JRVJoZEdVdWJtOTNLQ2tnTFNCc1lYTjBRbVZoZENBK0lFaEZRVkpVUWtWQlZGOUVSVUZFWDAxVEtTQjdDaUFnSUNBdkx5QXFLdXVobk9xM3VPeWR1Q0RzcEpIc25iVHJxYlFnN0pXSUlPcTZ2T3luaE91THBDb3FJQ2d5TURJMkxUQTRMQ0JDVWtsRVIwVmZWajB6TnlrNklHVjRhWFFnN1pXNDY1T2s2NStzNnJDQUlHdHBiR3hNYjJkcGJsQnliMlBxdVl6c3A0QWc2N2FBNjZXMDY2K0E2NkdjQ2lBZ0lDQXZMeURzbDZ6cXVMRHNoSndnNnJxODdLZUE2Nm0wDQpJT3U0ak91ZHZPeWFzT3lnZ095WGtPeUVuQ0Ryb1p6cXQ3anNuYmp0bFpqcmpaZ2c3SUtzNjU2TTdKMllJT3k5bk91d3NTRHRqNnp0aXJqcXNJQWc2NHVyN1ppQUlDSnNiMk5oYkdodmMzVHNsNURzaEp3ZzdKZXc2ckt3N0oyRUlPcXhzT3UyZ08yV2lPeUt0ZXVMaU91THBDTHFzSUFLSUNBZ0lDOHZJT3VjcU9xeHNPdUNtQ3dnNjZHYzZyZTQ3SjI0SU95d3ZleWR0Q0RzaG96cnBxd2c3SmVHN0oyMElPdXN0TzJhcU9xd2dDRHJrSnpyaTZRbzdJdWs3TGloSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmpzbllRZzY0dXI3SldFSU91UmxDRHNzWVFnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3VucE91eWlDRHNuYlRybnF6cmk2UXBMZ29nSUNBZ0x5OGc2NkdjNnJlNDdKMjQ3SjJBSU91NGpPdWR2T3lhc095Z2dPeVhrT3lFbkNEc2dxenJub3pzbmJRZzdLZUU3WmFKN1pXWTY0cVVJT3lkdk95ZHRPdWR2Q0R0bEl6cm42enF0N2pzbmJqc25iUWc2NWFnSU95ZWlPeWRoQ0R0bFlUc21wVHFzSUFnN0plRzY0dWtMaURyckxUdA0KbFp3ZzY0eUE2cml3SU95Y2hPMlhtT3lkZ0FvZ0lDQWdMeThnYkc5bmFXNVFjbTlqVkdsdFpYSW9NekRydG9RcDZyQ0FJT3VuaWV1S2xPdUxwQ0RpZ0pRZzZyZTRJTzJEZ095ZHRPdW91T3F3Z0NEcm9aenF0N2pzbmJqc25ZUWc3S0NWNjZhczdaV1k2Nm0wSU91THBPeWRqQ0Rzb0pEcXNvRHNsNURzaEp3ZzdLQ1Y3SU9CN0tDQjdKeTg2NkdjSU9xNnZPeW5oT3VMcEM0S0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJNcElIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lMck95ZXBldXdsZXVQbWV5ZGdDRHJnWXJxc3J6c3A0RHJwNHdnNjZHYzZyZTQ3SjI0N0oyMElPeW5oTzJXaVNEc3BKSHNuYlRybmJ3ZzZyaXc2NHVrNjZhOTY0dUk2NHVrSUNqcm9aenF0N2pzbmJnZzY0R2Q2NEtZNjZtMElPeWdsZXVtck91UXFldUxpT3VMcENrdUp5azdDaUFnSUNBZ0lISmxkSFZ5YmpzS0lDQWdJSDBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0bEl6cm42enF0N2pzbmJnZzdJdXMNCjdKNmw2N0NWNjQrWklPdUJpdXE1Z0NEaWdKUWc3WlM4NnJlNDY2ZUlMKzJVak91ZnJPcTN1T3lkdU95ZHRDRHJpNnZ0bm93ZzZyS0Q3Snk4NjZHY0lPdXp0T3F6b0NEcXNKbnNuYlFnNnJxODdLZVI2NHVJNjR1a0xpY3BPd29nSUNBZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3lBdkx5QmxlR2wwSU8yVnVPdVRwT3Vmck9xd2dDQnJhV3hzVUhKdlkreWN2T3VobkNCamJHRjFaR1VnN1lxNDY2YXM2Nlc4SU95Z2xldW1yTzJWbk91THBBb2dJSDBLZlN3Z05UQXdNQ2s3Q2dvdkx5RHFzNFRzb0pVZzdLQ0U3Wm1ZSU91VmpDRHNsNnpyaXBRZzdKdTVJT3Vobk9xM3VPeVZoT3liZ3lEc283enNob3dnNG9DVUlPdWhuT3EzdU95VmhPeWJneUR0bTRRZ0tpcnJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKeTg2NkdjSU95d3FleW5nQ29xN1pXYzY0dWtLT3lMcE95NG9Ub2dZMnhoZFdSbExtRnBMMnh2WjJsdUtTNEtMeThnN0lxNTdKMjRJTzJabE91cHRPeWRtQ0RzbTVEc25ianNuWUFnNjdpTTY1Mjg3SnF3N0tDQTdKZVFJT3VDDQpxT3lkZ0NEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZHRPdXZnT3VobkN3ZzdLQ0U3Wm1ZN0oyQUlPeWR0T3F4dUNEc3A0RHNtckRyaXBRZzZyS0Q3SmVRN0lTY0lPeUxuT3lla2UyVm5PdUxwQzRLWTI5dWMzUWdWMFZDWDB4UFIwOVZWRjlWVWt3Z1BTQW5hSFIwY0hNNkx5OWpiR0YxWkdVdVlXa3ZiRzluYjNWMEp6c0tMeThnNjZHYzZyZTQ3SldFN0p1RDdKMjBJT3U0ak91ZHZPeWFzT3lnZ095WGtPeUVuQ0Rzc3BqcnBxenJrS0FnN0l1YzZyQ0VJT0tBbENEcmhJanJyTFFnN0tlbjdKeTg2Nm0wSU95RXVPeUZtT3lkdENEcmdxanNuWUFnN0xHRUlPdWhuT3EzdU95ZHVDRHRtWlRycWJUc25iUWc3SmUwNjZDa0lPeUt1ZXlkdUNEdG1aVHJxYlRzbmJRZzY1eXM2NHVrQ21OdmJuTjBJRXhQUjA5VlZGOVRSVlJVVEVWZlRWTWdQU0F6TlRBd093b3ZMeUJWVWt6c25ZUWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VobkNEc2w3RHJpNlF1SUhkcGJqTXk3SjJBSUhKMWJtUnNiRE15SU9LQWxDQmpiV1RycGJ3Zw0KN0pXSUlPcXhzT3k1bU91dmdPdWhuQ0JWVWt6c25aZ2dZQ1pnNnJDQUlPeWVtT3Vtck95bmdDRHNsWXJyaXBUcmk2UXVDaTh2SUNoQ1VrOVhVMFZTSU8yWm1PcXl2ZXV6Z095SW1PdUtsQ0Rzb0lqcmpJQWc3Sk93N0tlQUlPeVZpdXVLbE91THBDRGlnSlFnN0pXRTY1NllJT3lqdk95RW5leWRtQ0RzdlpUcms1d2c2N2FaN0plczY0U2o2cml3SU91c3VPeWduQ2tLWm5WdVkzUnBiMjRnYjNCbGJsVnliRWx1UkdWbVlYVnNkRUp5YjNkelpYSW9kWEpzS1NCN0NpQWdkSEo1SUhzS0lDQWdJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQnpjR0YzYmlnbmNuVnVaR3hzTXpJbkxDQmJKM1Z5YkM1a2JHd3NSbWxzWlZCeWIzUnZZMjlzU0dGdVpHeGxjaWNzSUhWeWJGMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0IzYVc1a2IzZHpTR2xrWlRvZ2RISjFaU0I5S1M1MWJuSmxaaWdwT3dvZ0lDQWdaV3h6WlNCemNHRjNiaWduYjNCbGJpY3NJRnQxY214ZExDQjdJSE4wWkdsdk9pQW4NCmFXZHViM0psSnlCOUtTNTFibkpsWmlncE93b2dJQ0FnY21WMGRYSnVJSFJ5ZFdVN0NpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVjBkWEp1SUdaaGJITmxPeUI5Q24wS0NpOHZJT0thb08rNGp5RHJvWnpxdDdqc25iZ2c2cks5NjZHYzdKZVE3SVNjSUNvcVFsSlBWMU5GVXV1bHZDRHFzYlRyazV6cnBxenJxYlFnN0pXSUlPdVFuT3VMcENvcUlDZ3lNREkyTFRBNElPeUxwT3k0b1NBeTdacU02NkdjSU8yWmxleWdsU2s2Q2k4dklDQWdRbEpQVjFORlV1dWx2Q0RzaEtUc29KWHRsWmpycWJRbzY0SzA3SnFwN0oyMElPdXN0T3lYaCt5ZHRPdVRvQ3dnN0pXRTY2eTA2cktENjQrRUlPeVZpQ0R0bFpqcmlwUWdibTh0YjNEc25iVHNsclRyajRRcElHTnNZWFZrWlNCRFRFbnFzSUFnNjdpTTY1Mjg3SnF3N0tDQUlPMlZ1T3VUbk95WXBPMlVoT3VsdkFvdkx5QWdJTzJQck9xNHNPMlZtT3F6b0NBcUtpTHNuYmpzcHAwZzdMMlU2NU9jNjZXOElFTnNZWFZrWlNCRGIyUmw3SmVRSU91Mm1leVhyT3VFbyt5Y3ZPeUV1T3lhDQpsQ0lnNjdDcDdJdWQ3Snk4NjZHY0lPdXdsT3VBa091THBDb3FMaURyaTZUcnBxenJpcFFnNjZHYzZyZTQ3SjI0SU8yVWhPdWhuT3lFdU95S3BPdWx2QW92THlBZ0lPeUlxT3F5cU95RW5DQnpkR1JwYmlEc2w0YnNuYlFnNjUyRTdKcXc2NitBNjZHY0lPdTJtZXlYck91RW8reWRoQ0RxczdQc25iUWc3SmVHN0phMElPdWhuT3EzdU95ZHVPeWR0Q0RzbFlUc21JZ2c2N2FJNnJDQTY0cWw3WlcwN0tlRTY0dWtMZ292THlBZ0lDaHNiMk5oYkdodmMzUWdURWxUVkVWTzdKMjBJT3VXb0NEc25vanJpcFFnNnJLRDY2ZU1JT3V6dE9xem9DRHNucERyajVrZzdJaVk2NkM1N0oyMElPeWNvT3luZ091UW5PdUxwT3F6b0NEdGpKRHJpNmp0bG9qcmpaZ2c2cktNSU95WXBPeW5oT3lkdE95WGlPdUxwQzRwQ2k4dklDQWc0b2FTSU9xM3VPdWVtT3lFbkNBaTdZT3RJREhxc0p3Z0t5RHFzNFRzb0pVZzdJU2c3WU9kSU8yWmxPdXB0Q0xzbllBZzdKMjBJRU5NU2V1aG5DRHJ0b2pxc0lEcmlxWHRsWmpyaTZRNklPMlZuQ0R0ZzYzcw0Kbkx6cm9ad2c3SjZIN0o2UTY2bTBJRU5NU2V5ZG1DRHNsN1RxdUxEcnBid2c2NmVKN0pXRTdKVzhDaTh2SUNBZzdaV1k2ck9nTENEcnA0bnNuTHpycWJRZzdMMlU2NU9jSU91Mm1leVhyT3VFbytxNHNPcXdnQ0Rya0p6cmk2UXVJT3Vobk9xM3VPeVZoT3liZyt5ZGhDRHJsTERyb1p3ZzdKZTA2Nm0wSU8yRHJleWR0Q0F5NnJDYzZyQ0FJT3VRbk91THBDNEtMeThnSUNEcXNyRHJvYUFvN0lLczdKcXA3SjZRSU9xeXNPeWdsU2s2SUNvcTdZT3RJREhxc0p3Z0t5RHNpcm5zbmJnZzdabVU2Nm0wS2lyc25ZUWc3Sk93NnJPZ0xDRHFzNFRzb0pVZzdLQ0U3Wm1ZN0oyQUlPcTN1Q0R0bVpUcnFiVHNuWmdnVytxemhPeWdsU0Rzb0lUdG1aaGRJT3V5aE8yS3ZPeWN2T3VobkNEdGxaenJpNlF1Q2k4dklDQWc3SUt0N0tDYzY1Q2NJT3lMbk91UGhPdVRwRG9nZDNKcGRHVk9iMjl3UW5KdmQzTmxjaUF2SUc5d1pXNVZjbXhKYmtSbFptRjFiSFJDY205M2MyVnlJQzhnWW5WcGJHUk1iMmR2ZFhSRGFHRnBibFZ5YkNBbzY3TzENCjZyV3M2NHFVSUdkcGRDRHRub2pzaXFUdGhxRHJwcXdwTGdvdkx5RGlsSURpbElBZzY2R2M2cmU0N0oyNDdKMkFJRU5NU2Vxd2dDRHF1TERyczdnZzY3aU02NTI4N0pxdzdLQ0E2Nlc4SU95bmdleWdrU0RzbDdUcXNvd2c3WldjNjR1a0lDZ3lNREkyTFRBNExDQkNVa2xFUjBWZlZqMHpNQ2tnNHBTQTRwU0FDaTh2SU95YXNPdW1yT3F3Z0NCQ1VrOVhVMFZTNjZXOElPcXdnT3Vobk95eGhPcXhzT3VDbUNEc3NMM3NuWVFnNnJPbzY1MjhJT3lYck91S2xDRHNpNXpyajRUcmlwUWdLaXJzb0lUcnRvQWc3SXVrN1l5bzdaVzA3SVNjSU91UW1PdVBqT3VndU91THBDb3FMaURyZ3FqcXVMUWc2cldRN1p1SU9nb3ZMeUFnSU9LUm9DQkNVazlYVTBWU0lPMlZ1T3VUcE91ZnJPdWhuQ0JWVWt6c25ZUWc2N0NiN0p5ODY2bTBJR050Wk9xd2dDQmdKbURzbDVEc2hKd2c3SjZZNjUyODY2aTU2NHFVNjR1a0lPS0draUJqYkdsbGJuUmZhV1FnN0lhTTdJdWtLQ0xzbnBqcnFydnJrSndnVDBGMWRHZ2c3SnFVN0xLdElpa3VDaTh2DQpJQ0FnNHBHaElFSlNUMWRUUlZMcnBid2dibTh0YjNEc25MenJvWndnNjZlSjZyT2dJSE4wWkc5MWRPeWRtQ0JWVWt6c25ZUWc3SnF3NjZhczZyQ0FJT3lYdE91cHRDQXFLdXlLdWV5ZHVDRHJrcVFnN0oyNDdLYWQ3TDJVNjVPYzY2VzhJT3UybWV5WHJPdUVvK3ljdk91ZHZPdUtsQ0R0bVpUcnFiUXFLdXlkdEFvdkx5QWdJQ0FnSU91Y3JPdUxwQ2pzaTZUc3VLRWc3SXVnNnJPZ09pQWk3SjIwNjUrd0lPcXhzQ0RzbDRic2w0anJpcFRyamJBZzZyQ1I3SjZRNnJpd0lPeVpuQ0RzZzUzcXNxZ2lLU0RpZ0pRZzdKNlE2NCtaSU95SW1PdWd1ZXlkdENEcXVhanNwNFRyaTZRdUNpOHZJQ0FnNHBHaUlPeUxuTzJCck91bXZ5RHNzTDNzbkx6cm9ad2c3SmUwNjZDazY2bTBJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNtckRycHF6cXNJQWc2ck9vNjUyODdKVzhJTzJWdE95RW5DQXFLdXE0c091enVDRHJ1SXpybmJ6c21yRHNvSURxc0lBZzdKV0U2NHVNSU8yQnJPdWhyTUszN0plajdLZUE2ckNBSU95WHRPdW1zT3VMcENvcQ0KQ2k4dklDQWdJQ0FnS095THBPeTRvU0RzaTZEcXM2QTZJQ0xzbVp3ZzdZR3M2NkdzN0p5ODY2R2NJT3lYdE91Z3BDSXNJQ0xxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBNjZHY0lPMlZtT3Vkdk91TGlPcTVqQ0lwTGlEcXNvenJpNlRxc0lBZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPcXdnQ0RzaTV6dGdhenJwcjhLTHk4Z0lDQWdJQ0RzbmJqc25wRHJwYndnNjZ5MDdJdWM3WldZNjZtMEtPeUN2T3lFc1NEc25ianRoTERyaExjZzdJdWs3TGloS1NEc25ienJzSmdnN0xDOTdKMjBJT3VXb0NEc2lybnNuYmdnN1ptVTY2bTA3SjIwSU9xM3VPdU1nT3Vobk91THBDNEtMeThnNnJlNDY1Nlk3SVNjSUNvcVFsSlBWMU5GVXV1bHZDRHFzYlRyazV6cnBxenNwNEFnN0pXSzY0cVU2NHVrS2lvZzRvQ1VJR05zWVhWa1pTQkRURW5xc0lBZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUcXM2QWdiRzlqWVd4b2IzTjA2NkdjSU9xeXNPcXp2T3VsdkNEc25wRHJqNWtLTHk4ZzdJaVk2NkM1N1pXYzY0dWsNCktPeTlsT3VUbkNEcnRwbnNsNnpyaEtQcXVMQWc3SmVHN0oyTUtTNGc2ck9FN0tDVklPeWdoTzJabU95ZGdDRHNpcm5zbmJnZzdabVU2Nm0wSU8yVm1PdUxxQ0JiNnJPRTdLQ1ZJT3lnaE8yWm1GMGc2N0tFN1lxODdKeTg2NkdjSU8yVm5PdUxwQzRLTHk4Z0tpcnNuYlFnNnJLOTY2R2M3SmVRSUZWU1RDRHFzSURxczdYQ3QreWtrZXF3aENEc2lxVHRnYXpycHIzdGlyakN0K3U0ak91ZHZPeWFzT3lnZ0NEc3A0RHNvSlhzbllRZzY0dWs3SXVjSU91RW8reW5nQ0RycDVBZzZyS0RMaW9xQ2dvdkx5RGlsSURpbElBZ1FsSlBWMU5GVWlEcXNJRHJvWnpzc1lUcXVMRHJpcFFnN0tDYzZyR3c2NUNRNjR1a0lDZ3lNREkyTFRBNExDQkNVa2xFUjBWZlZqMHlOU2tnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FDaTh2SU95WWlPeWdoT3lYbENCQ1VrOVhVMFZTSU8yWm1PcXl2ZXV6Z095SW1PeVhrQ0Rzbm9Uc2k1d2c3SXFrN1lHczY2YTk3WXE0NjZXOElPcTlndXlWDQpoQ0JEVEVucXNJQWc3S1NBSUdGMWRHaHZjbWw2WlNCVlVrenNuWVFnN0pxdzY2YXM2ckNBSU91d20reVZoT3lFbkNEc2w3VHNsNGpyaTZRdUNpOHZJT3VxcWV5Z2dleWRnQ0R0bFpqcmdwanJ2NURzbmJUc2w0anJpNlFnNG9DVUlPcXpoT3lnbFNEc29JVHRtWmpzbXFuc25MenJvWndnVlZKTTdKMkVJR05zWVhWa1pTNWhhUzlzYjJkdmRYUS9jbVYwZFhKdVZHODk0b0NtNjZHY0lPeWVyT3lla2V5RXNlMlZ0QW92THlEc2lybnNuYmdnN1ptVTY2bTA3SjJFSU9xeHRPdUVpT3Vic09xem9DRHFzNFRzb0pVZzdJU2c3WU9kSU8yWmxPdXB0T3lYa0NEc3A0SHRsb25zaTV6dGdxVHF1TEF1SU9xM3VDRHNucXpzbnBIc2hMSHNuWVFnN1krUTZyaXc3WldZN0o2UUtPeUNyT3lhcWV5ZWtDRHFzckRzb0pVcElPMlZ1T3VUcE91ZnJPdUtsQW92THlEcnFxbnNvSUhzbmJRZzdKZUc3SmEwN0tHTTZyT2dMQ0FxS3V1Q3FPcXlxQ0Rya1pEcnFiUWc3SmlrN1o2STY2Q2tJT3Vobk9xM3VPeWR1T3lkaENEcnA1M3FzSURybktqcg0KcHJEcmk2UXFLam9LTHk4Z0lDQkRURW5xc0lBZ1ZWSk03SjJFSU91VXNPeVl0TzJSbkNEc2w0YnNuYlFnNjRTWTZyaXc2Nm0wSUdOdFpPcXdnQ0JnSm1Ec2w1RHNoSndnVlZKTTdKMkVJT3llbU91ZHZDRHJzb1Ryb0tRbzdKeUk2NCtFN0pxd0tTQmpiR2xsYm5SZmFXUWc2ckNaN0oyQUlPdVNwT3lxdlFvdkx5QWdJT3VucE9xd25PdXpnT3lJbU9xd2dDRHNncXpybmJ6c3A0RHFzNkFzSU91NGpPdWR2T3lhc095Z2dPeVhsQ0FpN0o2WTY2cTc2NUNjSUU5QmRYUm9JT3lhbE95eXJTREN0eUJqYkdsbGJuUmZhV1FnNjZlazZyQ2M2N09BN0lpWTZyQ0FJT3VJaE91ZHZldVFtT3lYaU95S3RldUxpT3VMcENMcXNJQWc2NXlzNjR1a0xnb3ZMeUFnSU95THJPMlZtT3VwdENEcnVJenJuYnpzbXJEc29JRHFzSUFnN0pXRTdKaUlJT3lWaUNEc2w3VHJwckRyaTZRbzdJdWs3TGloSURJd01qWXRNRGc2SUVOTVNTRHRsSVRyb1p6c2hManNpcVRyaXBRZzY0eUE2cml3SU95a2tleWR1T3VOc0NEc3NMM3NuYlFnN0pXSUlPdWMNCnVDa3VDaTh2SU95ZHRPeWduQ0JDVWs5WFUwVlM2Nlc4SU9xeHRPdVRuT3Vtck95bmdDRHNsWXJyaXBUcmk2UWc0b2FTSUdOc1lYVmtaU0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc3A0SHNvSkVnN0pldzY0dWtLRU5NU1NEcXVMRHJzN2dnNjQrWjdKNlJLUzRLTHk4Z0tpcnNuYlFnNnJLOTY2R2M3SmVRSUZWU1RDRHFzSURxczdYQ3QreWtrZXF3aENEc2lxVHRnYXpycHIzdGlyanJwYndnNjR1azdJdWNJT3VFbyt5bmdDRHJwNUFnNnJLRExpb3FJT3F6aE95Z2xTRHNvSVR0bVpqc25ZQWc3SXE1N0oyNElPMlpsT3VwdENEdGxaanJpNmdnVytxemhPeWdsU0Rzb0lUdG1aaGRJT3V5aE8yS3ZPeWN2T3VobkM0S0NpOHZJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJnZzdaU0U2NkdjN0lTNDdJcWtJQ2hqYkdGMVpHVWdZWFYwYUNCc2IyZHBiaUF0TFdOc1lYVmtaV0ZwS1NEaWdKUWdMMjl3Wlc0dGJHOW5hVzdzbmJRZzdJT2Q3SVN4d3JmcXRJRHJwcXd1Q2k4dklPdTRqT3VkDQp2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPdXp0T3VDdE95a2hDRHJsWXpxdVl6c3A0QWc3SWlvN0phMDdJU2NJT3VNZ09xNHNPMlZtT3VMcE9xd2dDd2c3Sm1FNjZPTTY1Q1k2Nm0wSU95S3BPeUtwT3VobkNEcmdaM3JncHpyaTZRdUNteGxkQ0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPd3BzWlhRZ2JHOW5hVzVRY205alZHbHRaWElnUFNCdWRXeHNPd3BzWlhRZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNBd095QXZMeURydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeUxuT3lla1NEc2k1enFzSUVnNG9DVUlPeWVyTzJCdE91bXJleWR0Q0FuN0o2czdJdWM2NCtFSit5ZHVPeW5nQ0FuN0o2UTY0K1o3Sm1FNjZPTUlPeUxwTzJNcUNmc25ianNwNEFnNnJXczY3YUU3WldjNjR1a0NpOHZJT3lkdE91eWlDRHJvWnpxdDdqc25ianNsNURzaEp3ZzY3aU02NTI4N0pxdzdLQ0FJT3l3dmV5ZGhDRHNpNlRzb0p6cm9ad2c2NTJFN0p1ZzY0cVU2ckNBSU9LQWxDRHRoTERycjdqcg0KaEpBZzdZKzA2N0N4N0oyQUlPeWR0T3F5akNCbVlXeHpaZXlkdkNEcmxZenJwNHdnN0pPMDY0dWtDaTh2SUNqc2k1enFzSVRycDR6c25MenJvWndnN1l5UTY0dW83WldZNjZtMElPeWdsZXlEZ1NEc25xenRnYlRycHEzc2w1RHJqNFFnWTIxa0lPeXd2ZXlkdENEdGlvRHNsclRyZ3Bqc21LanJpNlFwQ214bGRDQnNiMmRwYmxkcGJtUnZkMDl3Wlc1bFpDQTlJR1poYkhObE93cG1kVzVqZEdsdmJpQnJhV3hzVEc5bmFXNVFjbTlqS0NrZ2V3b2dJR2xtSUNoc2IyZHBibEJ5YjJOVWFXMWxjaWtnZXlCamJHVmhjbFJwYldWdmRYUW9iRzluYVc1UWNtOWpWR2x0WlhJcE95QnNiMmRwYmxCeWIyTlVhVzFsY2lBOUlHNTFiR3c3SUgwS0lDQnBaaUFvSVd4dloybHVVSEp2WXlrZ2NtVjBkWEp1T3dvZ0lHTnZibk4wSUhBZ1BTQnNiMmRwYmxCeWIyTTdDaUFnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNLSUNCMGNua2dld29nSUNBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzS0lDQWcNCklDQWdjM0JoZDI1VGVXNWpLQ2QwWVhOcmEybHNiQ2NzSUZzbkwxQkpSQ2NzSUZOMGNtbHVaeWh3TG5CcFpDa3NJQ2N2VkNjc0lDY3ZSaWRkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnlCOUtUc0tJQ0FnSUgwZ1pXeHpaU0I3Q2lBZ0lDQWdJSFJ5ZVNCN0lIQnliMk5sYzNNdWEybHNiQ2d0Y0M1d2FXUXNJQ2RUU1VkVVJWSk5KeWs3SUgwZ1kyRjBZMmdnS0Y5bE1pa2dleUJ3TG10cGJHd29LVHNnZlFvZ0lDQWdmUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91c3RPeUxuQ0FxTHlCOUNuMEtDaTh2SU8yRXRDRHJqNFRzcEpFZzdZRzA2NkdjNjVPY0lPMlVoT3Vobk95RXVPeUtwT3F3Z0NEc283M3NsNGpzbllRZzY1V003SjJZSU95THBPMk1xQ0RycVpUc2k1enNwNEFnNG9DVUlISjFibFIxY203c25iUWc3SjIwSU91cGxPeUxuT3luZ095ZHZDRHJsWXpycDR3Z01lMmFqQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U3WldjNjR1a0NtTnZibk4wSUZORlUxTkpUMDVmUkVsRlJDQTlJQ2Z0Z2JUcm9aenJrNXdnDQo3SVM0N0lXWTdKMjBJT3lpaGV1ampPdVFrT3lXdE95YWxDNG5Pd3BzWlhRZ2MyaDFkSFJwYm1kRWIzZHVJRDBnWm1Gc2MyVTdJQzh2SUM5emFIVjBaRzkzYmlEc3A0VHRsb2tnN0tTUklPS0FsQ0RzbnF6c2k1enJqNFRyb1p3ZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91bXJPeW5nQ0RzbFlycXNvd2c3WkdjN0l1Y0Nnb3ZMeUJ5WldGemIyN3NuWVFnN0tPODY2bTBJQ2Zzblpqcmo0VHNvSUVnN0tLRjY2T01KeWpxczRUc29KVWc3S0NFN1ptWXdyZnJvWnpxdDdqc2xZVHNtNE1nNjVPeEtTRGlnSlFnN0tlRTdaYUpJT3lra2V5ZHRPdU5tQ0R0aExUc25ZUWc2cmU0SU91cGxPeUxuT3luZ091aG5DRHJnWjNyZ3JUc2hKd0tMeThnY25WdVZIVnlidXlkbUNCVFJWTlRTVTlPWDBSSlJVUWc3SjZRNjQrWklPeWVyT3lMbk91UGhPcXdnQ0RzbUpzZzdKNlE2cktwN0thZDY2cUY3Snk4NjZHY0lPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcnBxenNwNEFnN0pXSzZyS01JTzJWbk91THBDNEtMeThnS095VmlDRHF0N2pybjZ6cg0KcWJRZzZyT0U3S0NWSU95Z2hPMlptQ0RzcDRIdG00UWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuYlFnNjdhQTdabWM3WlcwSUUxQldGOVVWVkpPVStxNWpPeW5nQ0RxczRUc2hvMGc3Sk93N0oyMDY0cVVJT3V5aE9xM3VDRGlnSlFnTWpBeU5pMHdOeURycHF6cnQ3RHNsNURzaEp3ZzdabVY3SjI0S1FwbWRXNWpkR2x2YmlCcmFXeHNVSEp2WXloeVpXRnpiMjRwSUhzS0lDQnBaaUFvY0hKdll5a2dld29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZDNhVzR6TWljcElIc0tJQ0FnSUNBZ0lDQXZMeUJ6YUdWc2JEcDBjblZsNjZHY0lPdWRoT3liak95RW5DQndjbTlqN0oyQUlHTnRaQ0RxdTQzcmpiRHF1TEFnNG9DVUlDOVU2NkdjSU8yS3VPdW1yT3ludUNEc283M3NsNnpzbGJ3ZzdLZUU3S2VjSUdOc1lYVmtaZXF3Z0NEcXM2RHNsWVRyb1p3ZzdKV0lJT3VDcU91S2xPdUxwQW9nSUNBZ0lDQWdJQzh2SUNqcXM2RHNsWVFnWTJ4aGRXUmw2ckNBSU95RXBPeTUNCm1DRHRqSXpzbmJ6c25ZUWc2Nnk4NnJPZ0lPeWVpT3ljdk91cHRDRHRnYlRyb1p6cms1d2c3Sld4SU95WGhldU5zT3lkdE8yS3VPcXdnQ0FpN0lLczdKcXBJT3lra1NMc25MenJvWndnNjZlSjdaNllLUW9nSUNBZ0lDQWdJSE53WVhkdVUzbHVZeWduZEdGemEydHBiR3duTENCYkp5OVFTVVFuTENCVGRISnBibWNvY0hKdll5NXdhV1FwTENBbkwxUW5MQ0FuTDBZblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3Q2lBZ0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lDQWdMeThnYldGalQxTXY2NmFzNjRpRjdJcWtPaUJ6YUdWc2JEcDBjblZsNjUyOElIQnliMlBzbmJRZ2MyZ2c2cnVONjQydzZyaXc3SjI4SU95SW1DRHNub2pzbll3ZzRvQ1VJSE4wWVhKMFVISnZZK3lkbUNCa1pYUmhZMmhsWk91aG5DRHJwNHpyazZBS0lDQWdJQ0FnSUNBdkx5RHRsSVRyb1p6c2hManNpcVFnNnJlNDY2TzVLQzF3YVdRcDdKMkVJTzJHdGV5bnVPdWhuQ0Rzb0pYcnBxenRsWnpyaTZRZ0tIUmhjMnRyYVd4c0lDOVVJT3VNDQpnT3lka1NrS0lDQWdJQ0FnSUNCMGNua2dleUJ3Y205alpYTnpMbXRwYkd3b0xYQnliMk11Y0dsa0xDQW5VMGxIVkVWU1RTY3BPeUI5SUdOaGRHTm9JQ2hmWlRJcElIc2djSEp2WXk1cmFXeHNLQ2s3SUgwS0lDQWdJQ0FnZlFvZ0lDQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c2NnkwN0l1Y0lDb3ZJSDBLSUNCOUNpQWdjSEp2WXlBOUlHNTFiR3c3Q2lBZ2QyRnliV1ZrVlhBZ1BTQm1ZV3h6WlRzS0lDQnBaaUFvZDJGcGRHVnlLU0I3SUdOc1pXRnlWR2x0Wlc5MWRDaDNZV2wwWlhJdWRHbHRaWElwT3lCM1lXbDBaWEl1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWh5WldGemIyNGdmSHdnVTBWVFUwbFBUbDlFU1VWRUtTazdJSGRoYVhSbGNpQTlJRzUxYkd3N0lIMEtmUW9LWm5WdVkzUnBiMjRnYzNSaGNuUlFjbTlqS0NrZ2V3b2dJR3RwYkd4UWNtOWpLQ2s3Q2lBZ2JHbHVaVUoxWmlBOUlDY25Pd29nSUhSMWNtNXpJRDBnTURzS0lDQXZMeURzbmJRZzdJUzQ3SVdZN0oyMElPeVd0T3VLa0NEcXM0VHNvSlhzblpnZw0KN0o2RjdKNmw2cmFNN0p5ODY2R2NJT3VQaE91S2xPeW5nQ0RxdUxEcm9aMGc0b0NVSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbmJRZzY3Q1U2NENNN0plSTY0cVU3S2VBSU91NWhPcTFrTzJWbU91S2xDRHF1TERzcElBS0lDQnpaWE56YVc5dVFXTmpiM1Z1ZENBOUlHTnNZWFZrWlVGalkyOTFiblFvS1RzS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RzaTV6cmo1a2c3S1NSNG9DbUlDanJxcWpyamJnNklDY2dLeUJqZFhKeVpXNTBUVzlrWld3Z0t5QW5LU2NwT3dvZ0lHTnZibk4wSUhSb2FYTlFjbTlqSUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbkxYQW5MQ0FuTFMxdGIyUmxiQ2NzSUdOMWNuSmxiblJOYjJSbGJDd2dKeTB0YVc1d2RYUXRabTl5YldGMEp5d2dKM04wY21WaGJTMXFjMjl1Snl3Z0p5MHRiM1YwY0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzSUNjdExYWmxjbUp2YzJVblhTd2dld29nSUNBZ2MyaGxiR3c2SUhSeWRXVXMNCklHTjNaRG9nUlUxUVZGbGZRMWRFTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzQ2lBZ0lDQmtaWFJoWTJobFpEb2djSEp2WTJWemN5NXdiR0YwWm05eWJTQWhQVDBnSjNkcGJqTXlKeXdnTHk4Z1VFOVRTVmc2SU95ZWtPcTRzQ0R0bElUcm9aenNoTGpzaXFRZzZyZTQ2Nk81SU95RG5leUVzU0RpZ0pRZ2EybHNiRkJ5YjJQc25iUWc2cmU0NjZPNTdLZTRJT3lnbGV1bXJPMlZvQ0RzaUpnZzdKNkk2cktNQ2lBZ2ZTazdDaUFnY0hKdll5QTlJSFJvYVhOUWNtOWpPd29nSUhCeWIyTXVjM1JrYjNWMExtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc0tJQ0FnSUd4cGJtVkNkV1lnS3owZ1pDNTBiMU4wY21sdVp5Z25kWFJtT0NjcE93b2dJQ0FnYkdWMElHbGtlRHNLSUNBZ0lIZG9hV3hsSUNnb2FXUjRJRDBnYkdsdVpVSjFaaTVwYm1SbGVFOW1LQ2RjYmljcEtTQWhQVDBnTFRFcElIc0tJQ0FnSUNBZ1kyOXVjM1FnYkdsdVpTQTlJR3hwYm1WQ2RXWXVjMnhwWTJVb01Dd2dhV1I0S1M1MGNtbHRLQ2s3Q2lBZ0lDQWdJR3hwDQpibVZDZFdZZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0dsa2VDQXJJREVwT3dvZ0lDQWdJQ0JwWmlBb0lXeHBibVVwSUdOdmJuUnBiblZsT3dvZ0lDQWdJQ0JzWlhRZ1pYWWdQU0J1ZFd4c093b2dJQ0FnSUNCMGNua2dleUJsZGlBOUlFcFRUMDR1Y0dGeWMyVW9iR2x1WlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUdOdmJuUnBiblZsT3lCOUNpQWdJQ0FnSUdsbUlDaGxkaUFtSmlCbGRpNTBlWEJsSUQwOVBTQW5jbVZ6ZFd4MEp5QW1KaUIzWVdsMFpYSXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emRDQjNJRDBnZDJGcGRHVnlPd29nSUNBZ0lDQWdJSGRoYVhSbGNpQTlJRzUxYkd3N0NpQWdJQ0FnSUNBZ1kyeGxZWEpVYVcxbGIzVjBLSGN1ZEdsdFpYSXBPd29nSUNBZ0lDQWdJR2xtSUNobGRpNXBjMTlsY25KdmNpa2dld29nSUNBZ0lDQWdJQ0FnWTI5dWMzUWdjbUYzSUQwZ1UzUnlhVzVuS0dWMkxuSmxjM1ZzZENCOGZDQmxkaTV6ZFdKMGVYQmxJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlNREFwT3dvZ0lDQWdJQ0FnSUNBZw0KTHk4ZzdaV2M2NCtFSU95MGlPcXp2T3VsdkNEcnFMenNvSUFnNjdPNDY0dWtJT0tBbENEcm9aenF0N2pzbmJnZzdKaWs2NldZSU95Z2xlcTNuT3lMbmV5ZHRDRHJoSlBzbHJUc2hKd29iRzluSUQ5cGJpRHJrN0VwSU91c3VPcTFyT3F3Z0NEcnNKVHJnSXpycWJRZzdJSzg3WUtzSU95SW1DRHNub2pyaTZRS0lDQWdJQ0FnSUNBZ0lHbG1JQ2hwYzB4cGJXbDBSWEp5YjNJb2NtRjNLU2tnZXdvZ0lDQWdJQ0FnSUNBZ0lDQmpiR0YxWkdWVGRHRjBkWE1nUFNBblkyeGhkV1JsTFd4cGJXbDBKenNnTHk4Z0wyaGxZV3gwYU91aG5DRHNsWXpycHJ3ZzRvYVNJT3V5aE8yS3ZPeWR0Q0JiN1pXYzY0K0VJT3kwaU9xenZGM3JvWndnNjdDVTY0Q002ck9nSU9xemhPeWdsU0Rzb0lUdG1aanNuWVFnN0pXSTY0SzBDaUFnSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRnYlRyb1p6cms1d2c3SUtzN0pxcElPMlZuT3VQaENEc3RJanFzN3dnNnJDUTdLZUFPaWNzSUhKaGR5azdDaUFnSUNBZ0lDQWcNCklDQWdJSGN1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWhNU1UxSlZGOUhWVWxFUlNrcE93b2dJQ0FnSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2hwYzBGMWRHaEZjbkp2Y2loeVlYY3BLU0I3Q2lBZ0lDQWdJQ0FnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNkamJHRjFaR1V0Ykc5bmIzVjBKenNnTHk4Z0wyaGxZV3gwYU91aG5DRHRsSXpybjZ6cXQ3anNuYmpzbDVBZzdKV002NmE4SU9LR2tpRHJzb1R0aXJ6c25iUWdXK3Vobk9xM3VPeWR1Q0R0bFlUc21wUmQ2NkdjSU91d2xPdUFuQW9nSUNBZ0lDQWdJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WUcwNjZHYzY1T2NJT3Vobk9xM3VPeWR1Q0RycDR6cm80d2c2ckNRN0tlQU9pY3NJSEpoZHlrN0NpQWdJQ0FnSUNBZ0lDQWdJSGN1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWhNVDBkSlRsOUhWVWxFUlNrcE93b2dJQ0FnSUNBZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ0lDQWdJQ0FnZHk1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0NmdGdiVHJvWnpyDQprNXdnN0ppazY2V1lPaUFuSUNzZ2NtRjNLU2s3Q2lBZ0lDQWdJQ0FnSUNCOUNpQWdJQ0FnSUNBZ2ZTQmxiSE5sSUhzS0lDQWdJQ0FnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNkdmF5YzdJQzh2SU95RXNlcXp0U0E5SU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0SU91THBDRHNvSlhzZzRFZzRvQ1VJT3lXdE91V3BDQndjbTlpYkdWdDdKMjA2NU9nSU8yVnRPeWduQ0FvN0o2czY2R2M2cmU0N0oyNEwreWVyT3lFcE95NW1DRHJzN1hxdDRBcENpQWdJQ0FnSUNBZ0lDQjNMbkpsYzI5c2RtVW9VM1J5YVc1bktHVjJMbkpsYzNWc2RDQjhmQ0FuSnlrcE93b2dJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ2ZRb2dJQ0FnZlFvZ0lIMHBPd29nSUhCeWIyTXVjM1JrWlhKeUxtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJSE1nUFNCa0xuUnZVM1J5YVc1bktDZDFkR1k0SnlrdWRISnBiU2dwT3dvZ0lDQWdhV1lnS0hNZ0ppWWdJWE11YVc1amJIVmtaWE1vSjBSbGNISmxZMkYwYVc5dVYyRnlibWx1WnljcA0KS1NCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGdZMnhoZFdSbElITjBaR1Z5Y2pvbkxDQnpMbk5zYVdObEtEQXNJREl3TUNrcE93b2dJSDBwT3dvZ0lIQnliMk11YjI0b0oyTnNiM05sSnl3Z0tHTnZaR1VwSUQwK0lIc0tJQ0FnSUM4dklPeWR0T3V2dUNEc2c0Z2c3SVM0N0lXWTdKeTg2NkdjSU9xMWtPeXl0T3VRbkNEcmtxUWc3SmliSU95RXVPeUZtT3lkdENEcmk2dnRub3dnNnJHdzY2bTBJT3VzdE95TG5DQW82NnFvNjQyNElPeWdoTzJabUNEc2k1d2c3SU9JSU95RXVPeUZtT3lkaENEc283M3NuYlRzcDRBZzdKV0s2cktNS1FvZ0lDQWdhV1lnS0hCeWIyTWdJVDA5SUhSb2FYTlFjbTlqS1NCeVpYUjFjbTQ3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0Rzb29Ycm80d2dLR052WkdVZ0p5QXJJR052WkdVZ0t5QW5LU0RpZ0pRZzY0dWs3SjJNSU95YWxPeXlyU0RybFl3ZzY0dWs3SXVjSU95TG5PdVBtZTJWcWV1TGlPdUxwQzRuS1RzS0lDQWcNCklHdHBiR3hRY205aktDazdDaUFnZlNrN0NuMEtDbVoxYm1OMGFXOXVJSE5sYm1SVWRYSnVLSFJsZUhRcElIc0tJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvS0hKbGMyOXNkbVVzSUhKbGFtVmpkQ2tnUFQ0Z2V3b2dJQ0FnYVdZZ0tDRndjbTlqS1NCeVpYUjFjbTRnY21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkdENEc2w0YnNsclRzbXBRdUp5a3BPd29nSUNBZ2FXWWdLSGRoYVhSbGNpa2djbVYwZFhKdUlISmxhbVZqZENodVpYY2dSWEp5YjNJb0oreVZudXlFb0NEc21wVHNzcTNzbmJRZzdLZUU3WmFKSU95a2tleWR0T3lYa095YWxDNG5LU2s3Q2lBZ0lDQmpiMjV6ZENCMGFXMWxjaUE5SUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZUzBJT3lMbk9xd2hDRHN0SWpxczd3ZzRvQ1VJT3lFdU95Rm1PeWRoQ0RzbnF6c2k1enNucEh0bGFucmk0anJpNlF1SnlrN0NpQWdJQ0FnSUM4dklPeUxuT3F3DQpoQ0RzdElqcXM3enJpcFFnSit5RXVPeUZtQ0Rzb29Ycm80d243Sm1BSU9xMXJPdTJoT3VRbU91S2xDRHNvSndnNjZtVTdJdWM3S2VBNjZHY0lPdUJuZXVDdU91THBDRGlnSlFnYTJsc2JGQnliMlBzblpnZzdJUzQ3SVdZSU95aWhldWpqQ0J5WldwbFkzVHFzSUFLSUNBZ0lDQWdMeThnY25WdVZIVnlidXlkbUNEc25wRHJqNWtnN0o2czdJdWM2NCtFNjZXOElPdTJnT3VsdE91cHRDRHNsWWdnNjVDWTZyaXdJT3VWak91c3VDanJpcERycHJBZzdZUzA3SjJFSU91UmtDRHJzb2dnNjQrTTY2bTBJTzJVak91ZnJPcTN1T3lkdUNBeE16RHN0SWdnN0tDYzdaV2M3SjJFSU91RW1PcTR0T3VMcENrS0lDQWdJQ0FnYVdZZ0tIZGhhWFJsY2lrZ2V3b2dJQ0FnSUNBZ0lHTnZibk4wSUhjZ1BTQjNZV2wwWlhJN0lIZGhhWFJsY2lBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnZHk1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0NmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyMElPdUVpT3VzdENEc21LVHJucGdnNnJHNDY2Q2tJT3lhbE95eQ0KcmV5ZGhDRHNwSkhyaTZqdGxvanNsclRzbXBRZzRvQ1VJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMaWNwS1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0JyYVd4c1VISnZZeWdwT3dvZ0lDQWdmU3dnVkZWU1RsOVVTVTFGVDFWVVgwMVRLVHNLSUNBZ0lIZGhhWFJsY2lBOUlIc2djbVZ6YjJ4MlpTd2djbVZxWldOMExDQjBhVzFsY2lCOU93b2dJQ0FnY0hKdll5NXpkR1JwYmk1M2NtbDBaU2hLVTA5T0xuTjBjbWx1WjJsbWVTaDdJSFI1Y0dVNklDZDFjMlZ5Snl3Z2JXVnpjMkZuWlRvZ2V5QnliMnhsT2lBbmRYTmxjaWNzSUdOdmJuUmxiblE2SUhSbGVIUWdmU0I5S1NBcklDZGNiaWNzSUNkMWRHWTRKeWs3Q2lBZ2ZTazdDbjBLQ2k4dklPcXdtZXlkZ0NEcnJManF0YXpycGJ3ZzY2cUhJT3V5aU95bnVDRHJyTHZyaXBUc3A0QWc2cml3N0phMUlPS0FsQ0RzbnF6c21wVHNzcTNzbmJUcnFiUWdJdXlkdE95Z2hPcXp2Q0RyaTZUcnBiZ2c3SU9JSU95Z25PeVZpQ0xzbllRZzdKcVU2cldzN1pXYzY0dWsNCkNpOHZJQ2pzbFlnZzZyZTQ2NStzNjZtMElPMkJ0T3Vobk91VG5PcXdnQ0RzaExIc2k2VHRsWmpxc293ZzZyQ1o3SjJBSU91THRleWRoQ0RybUpBZzY0SzA3SVNjSUZ0QlNTRHN0cFRzc3B3ZzY0MlVJT3V3bStxNHNGM3FzSUFnNjZ5MDdKMlk2Nis0N1pXMDdLZUU2NHVrS1FwamIyNXpkQ0JoYzJ0bFpFTnZkVzUwSUQwZ2JtVjNJRTFoY0NncE93b0tMeThnN0lTNDdJV1lJT3lrZ091NWhDanNpNXpyajVrcjdLZUE3SXVjNjZ5NElPeWp2T3llaFNucnBid2c2N08wN0o2bDdaV2NJT3VTcENEdGxad2c3WVMwSU95THBPMldpU0RpZ0pRZzY2cW82NU9nSU8yWXVPeTJuT3lkZ0NCeGRXVjFaZXVobkNEc3A0SHJvS3p0bVpRdUNpOHZJRzF2WkdWczdKMkVJT3lqdk91cHRDRHF0N2dnNjZxbzY0MjQ2NkdjSUNqcmk2VHJwYlRycWJRZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NrdUlPMlZuQ0RycXFqcmpianNuWVFnNnJPRTdJYU5JT3lUc091cHRDRHNucXpzaTV6c25wSHNuWUFnN0xXYzdMU0lJREh0bW96cnY1QXVDaTh2DQpJSEpsY0dGeWMyVTllM0JoY25ObExDQm1iM0p0WVhSRVpYTmpmZXVsdkNEc283enJxYlFnN1l5TTdJdXg2cm1NN0tlQUlPeWR0Q0RzbnFFZzdKV0k3SmVRN0lTY0lPeXltT3Vtck8yVm1PcXpvQ0I3Y21GM0xDQndZWEp6WldSOTY2VzhJT3VQak91Z3BPeWtnT3VMcERvS0x5OGc3WmlWN0l1ZElPeWR0TzJEaUNEc2k1d2c2ckNaN0oyQUlPeUV1T3lGbU95WGtDQWk3WmlWN0l1ZDY0eUE2NkdjSU91THBPeUxuQ0xycGJ3ZzdKcVU2cldzN1pXWTY0cVVJT3llck95YWxPeXlyU0R0aExUc25ZUWdLaXJxc0puc25ZQWc3WUdRSU95ZW9TRHNsWWpzbDVEc2hKd3FLaURydHBuc25ianJpNlF1Q2k4dklPdXpoT3VQaENEc25xSHNuTHpyb1p3ZzY3bTg2Nm0wSUNoaEtTRHNncXpzbmJUc2w1QWc2NHVrNjZXNElPeWFsT3l5clNEdGhMVHNuYlFnNjRHODdKYTBJQ2Zyc0tucXVJZ2c2NHUxSit5ZHRDRHJncWpzblpnZzY0dTE3SjIwSU91UW1PcXpvQ2pyZ3JUc21xa2c3SmlrN0plOEtTd0tMeThnS0dJcElFMUJXRjlVVlZKTw0KVXlEcXNyM3FzNFRzbDVEc2hKd2c3SVM0N0lXWTdKMjBJT3llck95TG5PeWVrZXVQdkNBbjY3Q3A2cmlJSU91THRTZnNuYlFnN0plRzY0cVVJT3lEaUNEc2hManNoWmpzbmJRZzY0SzA3SnFwN0oyRUlPeW5nT3lXdE91Q3ZDRHNpSmdnN0o2STY0dWtJQ2d5TURJMkxUQTNJT3Vtck91M3NPeVhrT3lFbkNEdG1aWHNuYmdwTGdwamIyNXpkQ0JTUlZCQlVsTkZYMEpCUkNBOUlDaDJLU0E5UGlCMklEMDlJRzUxYkd3Z2ZId2dLRUZ5Y21GNUxtbHpRWEp5WVhrb2Rpa2dKaVlnZGk1c1pXNW5kR2dnUFQwOUlEQXBPd3BtZFc1amRHbHZiaUJ5ZFc1VWRYSnVLR0oxYVd4a1FYTnJMQ0J0YjJSbGJDd2djbVZ3WVhKelpTa2dld29nSUdOdmJuTjBJR3B2WWlBOUlIRjFaWFZsTG5Sb1pXNG9ZWE41Ym1NZ0tDa2dQVDRnZXdvZ0lDQWdZMjl1YzNRZ2FtOWlVM1JoY25RZ1BTQkVZWFJsTG01dmR5Z3BPeUF2THlEc2k1enFzSVFnN0ppSTdJS3dJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3S3E5SU95Z25PMlZuQ2d4TXpEc3RJZ3ANCjdKMkVJT3VFbU9xNHVDRHNucXpzaTV6cmo0VHJpcFFnN1krczZyaXc3WldjNjR1a0NpQWdJQ0JwWmlBb2JXOWtaV3dnSmlZZ1FVeE1UMWRGUkY5TlQwUkZURk11YVc1a1pYaFBaaWh0YjJSbGJDa2dJVDA5SUMweElDWW1JRzF2WkdWc0lDRTlQU0JqZFhKeVpXNTBUVzlrWld3cElIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3VxcU91TnVDRHJzNERxc3IwNklDY2dLeUJqZFhKeVpXNTBUVzlrWld3Z0t5QW5JT0tHa2lBbklDc2diVzlrWld3cE93b2dJQ0FnSUNCamRYSnlaVzUwVFc5a1pXd2dQU0J0YjJSbGJEc0tJQ0FnSUNBZ2MzUmhjblJRY205aktDazdJQzh2SU95RGlDRHJxcWpyamJqcm9ad2c3SVM0N0lXWUlPeWVyT3lMbk95ZWtTQW82NHVrN0oyTUlPeWJqT3V3amV5WGhleVhrT3lFbkNEc3A0RHNpNXpyckxnZzdKNnM3S084N0o2RktRb2dJQ0FnZlFvZ0lDQWdhV1lnS0hSMWNtNXpJRDQ5SUUxQldGOVVWVkpPVXlCOGZDQWhjSEp2WXlrZ2MzUmhjblJRY205aktDazdDaUFnDQpJQ0JwWmlBb0lYZGhjbTFsWkZWd0tTQjdDaUFnSUNBZ0lHTnZibk4wSUhRd0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lDQWdZWGRoYVhRZ2MyVnVaRlIxY200b2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa3BPd29nSUNBZ0lDQjNZWEp0WldSVmNDQTlJSFJ5ZFdVN0NpQWdJQ0FnSUhSMWNtNXpLeXM3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2hManNoWmdnN0tTQTY3bUVJT3laaE91ampDQW9KeUFySUNnb1JHRjBaUzV1YjNjb0tTQXRJSFF3S1NBdklERXdNREFwTG5SdlJtbDRaV1FvTVNrZ0t5QW5jeWtnNG9DVUlPeWR0TzJiaENEc21wVHNzcTNzbllBZzY3bW82NTI4N0pxVUxpY3BPd29nSUNBZ2ZRb2dJQ0FnZEhWeWJuTXJLenNLSUNBZ0lHTnZibk4wSUdGemF5QTlJR0oxYVd4a1FYTnJLQ2s3SUM4dklPeWVyT3lMbk91UGhDRHJsWXdnNnJDWjdKMkFJT3luaU91c3VPeWRoQ0RyaTZUc2k1d2c3Sk8wNjR1a0lDaGhjMnRsWkVOdmRXNTBJT3lkdE95a2tTRHNwcDNxc0lBZw0KNjdDcDdLZUFLUW9nSUNBZ2JHVjBJSEpoZHpzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUhKaGR5QTlJR0YzWVdsMElITmxibVJVZFhKdUtHRnpheWs3Q2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQWdJQzh2SU8yRXRDRHJqNFRzcEpFZzdZRzA2NkdjNjVPY0lPMlVoT3Vobk95RXVPeUtwT3F3Z0NEc283M3NuWUFnNnJLOTdKcXdLRk5GVTFOSlQwNWZSRWxGUkNrZ01lMmFqQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0VJT0tBbENEc2dxenNtcW5zbnBEc2w1RHFzcEFnN0l1azdZeW82NkdjSU95VmlDRHJzN1RzbmJUcXNvd3VDaUFnSUNBZ0lDOHZJT3lMbk9xd2hDRHN0SWpxczd6Q3QrdWhuT3EzdU95ZHVDRHJwNHpybzR6Q3QrMkJ0T3Vobk91VG5DRHNtS1RycFpqQ3QreWRtT3VQaE95Z2dTRHNvb1hybzR3bzZyT0U3S0NWSU95Z2hPMlptQy9yb1p6cXQ3anNsWVRzbTRNc0lHdHBiR3hRY205aktISmxZWE52YmlrcDY0cVVDaUFnSUNBZ0lDOHZJT3lnbkNEcnFaVHNpNXpzcDREcXNJQWc2NVN3NjZHY0lPeWUNCmlPeVd0Q0RzbDZ6cXVMQWc3SldJSU9xeHVPdW1zT3VMcEM0ZzdLS0Y2Nk9NSU95YWxPeXlyU0RzcEpIc25iVHFzYkRyZ3BnZzdJdWM2ckNFSU95WWlPeUNzT3lkdENEc2xyenJwNGdnN0pXSUlPdUNxT3lWbU95Y3ZPdXB0Q0Rya0pqc2dyVHJwcXpzcDRBZzdKV0s2NHFVNjR1a0xnb2dJQ0FnSUNCcFppQW9jMmgxZEhScGJtZEViM2R1SUh4OElDRW9aU0FtSmlCbExtMWxjM05oWjJVZ1BUMDlJRk5GVTFOSlQwNWZSRWxGUkNrZ2ZId2dSR0YwWlM1dWIzY29LU0F0SUdwdllsTjBZWEowSUQ0Z05EQXdNREFwSUhSb2NtOTNJR1U3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2hManNoWmpzbmJRZzdZUzBJT3VQaE95a2tTRHJnWXJxdVlBZzRvQ1VJT3llck95TG5PdVBtU0R0bTRRZ01lMmFqQ0RzbnF6c2k1enJqNFR0bGFucmk0anJpNlF1SnlrN0NpQWdJQ0FnSUhOMFlYSjBVSEp2WXlncE93b2dJQ0FnSUNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhwYm5OMGNuVmpkR2x2YmsxbGMzTmhaMlVvDQpLU2s3Q2lBZ0lDQWdJSGRoY20xbFpGVndJRDBnZEhKMVpUc0tJQ0FnSUNBZ2RIVnlibk1nUFNBeU95QXZMeURzbTR6cnNJM3NsNFVnTVNBcklPeWR0T3V5aUNEdGhMUWdLSE4wWVhKMFVISnZZK3lkdENBdzdKeTg2NkdjSU95MGlPcTRzTzJabENrS0lDQWdJQ0FnY21GM0lEMGdZWGRoYVhRZ2MyVnVaRlIxY200b1lYTnJLVHNLSUNBZ0lIMEtJQ0FnSUdsbUlDZ2hjbVZ3WVhKelpTa2djbVYwZFhKdUlISmhkenNLSUNBZ0lHeGxkQ0J3WVhKelpXUWdQU0J5WlhCaGNuTmxMbkJoY25ObEtISmhkeWs3Q2lBZ0lDQXZMeUR0bUpYc2k1MGc3SjIwN1lPSTdKMjA2Nm0wSU9xd21leWRnQ0RzaExqc2haakN0K3F3bWV5ZGdDRHNucUhzbDVEc2hKd2c2ck9uN0o2bElPeWVyT3lhbE95eXJTRGlnSlFnN0oyMElPMkV0T3lkdENEc283M3NuTHpycWJRZzdJT0lJT3lFdU95Rm1PeWRnQ0FuNjdDcDZyaUlJT3VMdFNmc25ZUWc2NnF3NjUyOENpQWdJQ0F2THlEc3A0RHNsclRyZ3J3ZzdJaVlJT3llaU95Y3ZPdXZnT3VobkNEcw0KaExqc2haZ2c3SUtzNjZlZElPeWVyT3lMbk91UGhPdUtsQ0R0bFpqc3A0QWc3SldLNnJPZ0lPcTN1T3VNZ091aG5DRHNpNlR0aktqc2k1enRncWpyaTZRbzdZeU03SXV4SU95THBPMk1xT3VobkNEcXQ0RHFzckFwTGdvZ0lDQWdhV1lnS0ZKRlVFRlNVMFZmUWtGRUtIQmhjbk5sWkNrZ0ppWWdSR0YwWlM1dWIzY29LU0F0SUdwdllsTjBZWEowSUR3Z056QXdNREFwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1qT3lMc1NEc2k2VHRqS2dnNG9DVUlPMllsZXlMblNEc25xenNtcFRzc3EwNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTXpBd0tTazdDaUFnSUNBZ0lIUjFjbTV6S3lzN0NpQWdJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lDQWdjbUYzSUQwZ1lYZGhhWFFnYzJWdVpGUjFjbTRvSit1d3FlcTRpQ0RyaTdYc25iUWc3SnFVNnJXczdaV2NJTzJZbGV5TG5leVhrQ0RzbHJUcXVJdnJncXpyaTZRdUlPdXdxZXE0aUNEcmk3WHRsWndnNjRLMDdKcXA3SjJFSU95RXBPdXENCmhjSzM3SUtzNnJPOHdyZnN2WlRyazV6dGpwenNpcVFnN0plRzdKMjBJT3lWaE91ZW1DQktVMDlPN0p5ODY2R2M2NmVNSU91THBPeUxuQ0RzdHB6cm9LWHRsWmpybmJ3NklDY2dLeUJ5WlhCaGNuTmxMbVp2Y20xaGRFUmxjMk1wT3dvZ0lDQWdJQ0FnSUhCaGNuTmxaQ0E5SUhKbGNHRnljMlV1Y0dGeWMyVW9jbUYzS1RzS0lDQWdJQ0FnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0o2czdKcVU3TEt0SU95THBPMk1xQ0RpZ0pRZzdKV0U2NTZZN0plUTdJU2NJTzJNak95THNTRHNpNlR0aktqcm9ad2c3TEtZNjZhc0lDb3ZJSDBLSUNBZ0lIMEtJQ0FnSUdsbUlDaFNSVkJCVWxORlgwSkJSQ2h3WVhKelpXUXBLU0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZeU03SXV4SU95THBPMk1xQ0FvN0o2czdKcVU3TEt0SU8yYmhPeVhrT3VQaENrNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTXpBd0tTazdDaUFnSUNCeVpYUjFjbTRnZXlCeVlYY3NJSEJoY25ObFpEb2dVa1ZRUVZKVFJWOUNRVVFvDQpjR0Z5YzJWa0tTQS9JRzUxYkd3Z09pQndZWEp6WldRZ2ZUc0tJQ0I5S1RzS0lDQXZMeUR0bFp3ZzdKcVU3TEt0N0oyMElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUc25Zd2c3SnFVN0xLdDdKMjBJT3lkdE95V3RPeW5nT3VQaE91aG5TRHRnWkRyaXBRZzdaV3Q3SU9CSU95RXNlcXp0ZXljdk91aG5DRHNvSlhycHF3S0lDQnhkV1YxWlNBOUlHcHZZaTVqWVhSamFDZ29LU0E5UGlCN2ZTazdDaUFnY21WMGRYSnVJR3B2WWpzS2ZRb0tMeThnNjdLRTdZcThJT3Vkdk91eXFDRHF0NXpzdVprZzRvQ1VJTzJVak91ZnJPcTN1T3lkdU95ZHRDQW42N0tFN1lxODdKMkVJT3F6cU91ZWtPdUxwQ2ZxczZBZzdKV002NkNrN0tTRUlPdVZqT3VuakNEc2xybnJpcFRyaTZRdUNpOHZJT3V5aE8yS3ZDRHJyTGpxdGF6cmlwUWc2Nnk0N0o2bDdKMjBJT3lWaE91TGlPdWR2Q0RyajVuc25wRWc3SjIwNjZhRTdKMjA3SmEwN0lTY0xDRHNuYlFnN0tlQTdJdWM2ckNBSU95WGh1eWN2T3VwdENEcnJManNucVh0bUpVZzY0eUE3SldJN0oyMA0KSU95RW51eVhyQ0RyZ3Bqc21LanJpNlF1Q21OdmJuTjBJRUpWVkZSUFRsOVNWVXhGSUQwS0lDQW43SjIwSU91c3VPcTFyT3VLbENBcUt1dXloTzJLdkNEcm5ienJzcWdxS3V5ZHRPdUxwQzRnNjZ5NDdKNmw3SjIwSU95VmhPdUxpT3VkdkNEcmo1bnNucEVnN0oyMDY2YUU3SjIwNjYrQTY2R2NPaURycDRqc3VhanRrWnpDdCt1c3ZPeWRqTzJSbk1LMzdLS0Y2ckt3N0phMDY2KzRLSDdzbXBRdmZ1dUxwQzkrNnJtTTdKcVVLU0RxdUlqc3A0QXNJQ2NnS3dvZ0lDZnJrSmpyajRUcm9aMGc3S2VuN0oyQUlPdVBtZXlla1NEcnFvWHNncXdvN0tDQTdKNmx3cmZzZ3Ezc29KekN0K3lYc09xeXNDRHRsYlRzb0p3ZzY1T3hLZXVobkN3ZzdZYTE2N08wN0lTeElPdUxxT3lkdkNEcnNvVHRpcnpzbmJUcnFiUWdJdTJabGV5ZHVDSXVJQ2NnS3dvZ0lDY2k3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3ZzdKT3c2ck9nTENEdG1aVHJxYlFnNnJpdzY0cWw2NnFGS091emdPcXkNCnZjSzM3WlcwN0tDY0lPdVRzU25zbllBZzZyZTQ2NHlBNjZHY0lPdVJsT3VMcEM1Y2JpYzdDZ292THlEcnJManF0YXdnN0xhVTdMS2NJTzJFdENBb2NtOXNaVDBuNjdLRTdZcThKK3lkdE91cHRDRHJzb1R0aXJ3ZzZyZWM3TG1aN0oyRUlPeVd1ZXVLbE91THBDa0tablZ1WTNScGIyNGdZWE5yUTJ4aGRXUmxLSFJsZUhRc0lHMXZaR1ZzTENCeVpYQmhjbk5sTENCeWIyeGxLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdld29nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2gwWlhoMEtTQjhmQ0F3S1NBcklERTdDaUFnSUNCaGMydGxaRU52ZFc1MExuTmxkQ2gwWlhoMExDQmhkSFJsYlhCMEtUc0tJQ0FnSUdsbUlDaGhjMnRsWkVOdmRXNTBMbk5wZW1VZ1BpQXlNREFwSUdGemEyVmtRMjkxYm5RdVkyeGxZWElvS1RzZ0x5OGc2NnkwN1pXYzdaNklJT3lNayt5ZHRPeW5nQ0RzbFlycXNvd0tJQ0FnSUdOdmJuTjBJSEoxYkdVZ1BTQnliMnhsSUQwOVBTQW42N0tFDQo3WXE4SnlBL0lFSlZWRlJQVGw5U1ZVeEZJRG9nSnljN0NpQWdJQ0J5WlhSMWNtNGdjblZzWlNBcklDaGhkSFJsYlhCMElENGdNUW9nSUNBZ0lDQS9JQ2Zxc0puc25ZQWc2Nnk0NnJXczY2VzhJT3VMcE95TG5DRHNtcFRzc3EzdGxaenJpNlF1SU95ZHRDRHNoTGpzaFpqc2w1RHNoSndnN0oyMDdLQ0U3SmVRSU95Z25PeVZpTzJXaU91Tm1DRHFzb1ByazZUcXM3d2c2cks1N0xtWTdLZUFJT3lWaXV1S2xDd2c2cldzN0tHdzY0S1lJT3lXdE8yY21PcXdnQ0R0bVpYc2k2VHRub2dnNjR1azY2VzRJT3lEaU91aG5PeWF0Q0RyaklEc2xZZ2dNK3F3bk91bHZDRHF0NXpzdVpucmpJRHJvWndnU2xOUFRpRHJzTERzbDdUcm9aenJwNHc2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLUW9nSUNBZ0lDQTZJQ2ZyaTZUc25Zd2dWVWtnNjZ5NDZyV3M3SjJZSU91TWdPeVZpQ0F6NnJDYzY2VzhJT3Ezbk95NW1ldU1nT3VobkNCS1UwOU9JT3V3c095WHRPdWhuT3VuakRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNQ0KS0hSbGVIUXBLVHNLSUNCOUxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0NuMEtDaTh2SU91eWlPeVhyU0R0aExRZzRvQ1VJT3F3bWV5ZGdDRHNoTGpzaFpqc25ZUWc3Sk93NjVDWUxDRHNuYlRyc29nZzdZUzA2NmVNSU95MmxPeXluQ0R0bUpYc2k1MG9TbE5QVGlEcnNMRHNsN1FwSU91TWdPeUxvQ0Ryc29qc2w2MGc3WmlWN0l1ZEtFcFRUMDRnNnJDZDdMSzBLZXlkaENEc21wVHF0YXp0bFp6cmk2UUtablZ1WTNScGIyNGdZWE5yVkhKaGJuTnNZWFJsS0hSbGVIUXNJRzF2WkdWc0xDQnlaWEJoY25ObEtTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z0tBb2dJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnNjdLSTdKZXRJT3lla2V5WGhleWR0T3VMcENBbzY2eTQ2cldzSU91THBPdVRyT3E0c0NEc2xZVHJpNWdnNG9DVUlPdU1nT3lWaUNBejZyQ2NJT3Ezbk95NW1leWRnQ0RzbmJUcnNvZ2c3WVMwN0plUUlPeWdnZXlhcWUyVm1PeW5nQ0RzbFlycmlwVHJpNlFwTGlBbklDc0tJQ0FnSUNmcmk2VHMNCm5Zd2dWVWtnNjZ5NDZyV3M2ckNBSU8yVm5PcTFyZXlXdE91cHRDRHNucERzbDdEc2lxVHJuNnpzbXJRZzdKaUI3SmEwNjZHY0xDRHNtSUhzbHJUcnFiUWc3SjZRN0pldzdJcWs2NStzN0pxMElPMlZuT3ExcmV5V3RPdWhuQ0Ryc29qc2w2M3RsWmpybmJ3dUlDY2dLd29nSUNBZ0oxVkpJT3VzdU9xMXJPdUxwT3lhdENEcXNJVHFzckR0bFp3ZzdaR2M3WmlFN0oyRUlPeVRzT3F6b0N3ZzdKMjA2NmFFd3Jmc2lLdnNucERDdCt1bmlPeUtwTzJDdWNLMzdaU002NkNJN0oyMDdJcWs3Wm1BNjQyVTY0cVVJT3EzdU91TWdPdWhuQ0RyczdUc29iVHRsWnpyaTZRdUlDY2dLd29nSUNBZ0oreWJrT3VzdU95ZG1DRHNwSVFnN0lpWTY2VzhJT3EzdU91TWdPdWhuQ0RzbktEc3A0RHRsWnpyaTZRZzRvQ1VJT3lia091c3VPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPdXlpT3lYcmV1UGhDRHRsWndnN0tTRTY2R2NMQ0RzcElUcnNKVHF2NGpzbllRZzdKNkU3SjJZNjZHY0lPeTJsT3F3Z08yVm1PeW5nQ0RzbFlycmlwVHJpNlF1DQpJQ2NnS3dvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1VnNnJpSTdLZUFPaUFuSUNzS0lDQWdJQ2Q3SW5SeVlXNXpiR0YwWldRaU9pQWk2N0tJN0pldDY2eTRJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKa2FYSmxZM1JwYjI0aU9pQWlhMi9paHBKbGJpRHJtSkRyaXBRZ1pXN2locEpyYnlKOU9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29kR1Y0ZENrS0lDQXBMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdDbjBLQ2k4dklPdU1nTzJabE8yWWxTRHJyTGpxdGF3ZzdLQ2M3SjZSSU8yRXRDRGlnSlFnN0lLczdKcXA3SjZRNnJDQUlPeURnZTJacWV5ZGhDRHNoS1RycW9YdGxaanJxYlFnNjZlbDY1Mjk3SmVRSU91bm51dUtsQ0RyckxqcXRhenJwYndnNjZlTTY1T2s3SmEwN0tTQTY0dWtMZ292THlCdFpYTnpZV2RsY3pvZ1czdHliMnhsT2lkMWMyVnlKM3duWVhOeg0KYVhOMFlXNTBKeXdnZEdWNGRIMWRJT3lnaE95eXRDRHJqSUR0bVpUcnBid2c2NmVrNjdLSUlPdXdtK3VLbE91THBDanJpNlRycHF6cmlwUWc2NnkwN0lPQjdZT2NJT0tBbEFvdkx5RHNtNHpyc0kzc2w0VWc3S2VBN0l1YzY2eTQ3SjJZSUNMc21wVHNzcTNyazZUc25ZQWc3SVNjNjZHY0lPdXN0T3EwZ0NJZzdLQ0U3S0NjNjZXOElPeW5nTzJDcE9xNHNDRHNuSVR0bGJRZzY0eUE3Wm1VSU91bnBldWR2ZXlkaENEdGhMUWc3SldJN0plUUlPdXF2ZXVWaFNEc2k2UHJpcFRyaTZRcExncG1kVzVqZEdsdmJpQmhjMnREYjIxd2IzTmxLRzFsYzNOaFoyVnpMQ0J0YjJSbGJDd2djbVZ3WVhKelpTa2dld29nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJSFJ5WVc1elkzSnBjSFFnUFNBb2JXVnpjMkZuWlhNZ2ZId2dXMTBwTG0xaGNDZ29iU2tnUFQ0S0lDQWdJQ0FnS0cwdWNtOXNaU0E5UFQwZ0oyRnpjMmx6ZEdGdWRDY2dQeUFuN0phMDdJdWM3SXFrN1lTMDdZcTRPaUFuSURvZ0oreUMNCnJPeWFxZXlla0RvZ0p5a2dLeUJUZEhKcGJtY29iUzUwWlhoMElIeDhJQ2NuS1M1emJHbGpaU2d3TENBeE5UQXdLUW9nSUNBZ0tTNXFiMmx1S0NkY2JpY3BPd29nSUNBZ2NtVjBkWEp1SUNnS0lDQWdJQ0FnSit5ZHRPdXlpQ0RzbXBUc3NxM3NuWUFnSXV1TWdPMlpsTzJZbFNEcnJManF0YXdnN0tDYzdKNlJJdXlkdE91THBDQW82cml3N0tHMElPdXN1T3ExckNEcmk2VHJrNnpxdUxBZzdKV0U2NHVZSU9LQWxDRHNsWVRybnBnZzY0eUE3Wm1VNnJDQUlPeWR0T3V5aUNEdGhMVHNuWmdnN0tDRTdMSzBJT3VucGV1ZHZleWR0T3VMcENrdUlDY2dLd29nSUNBZ0lDQW43SUtzN0pxcDdKNlE2ckNBSU8yWmxPdXB0Q0RzZzRIdG1hbkN0K3VucGV1ZHZleWRoQ0RzaEtUcnFvWHRsWmpycWJRc0lPeUtwTzJEZ095ZHZDRHF0NXpzdVpucXM3d2c3SmlJN0l1Y0lPMkdwT3lYa0NEcnA1N3JpcFFnVlVrZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2NmVsDQo2NTI5N0oyMElPdTJnT3loc2UyVm1PdXB0Q0R0anJqdGxaanFzb3dnNjVDWTY2eTg3SmEwNjUyOE9pRHNsclRybHFRZzdabVU2Nm0wd3JmcXVMRHJpcVhzblpnZzY2eTQ2cldzN0oyNDdLZUFMQ0RyazZUc2xyVHFzSWdnN0o2UTY2YXM2NHFVSU95V3RPdVVsT3lkdU95bmdDanRqSjNzbDRVZzdZT0E3SjIwN1l1QUwrdXp1T3VzdUMvcnNvVHRpcndzSU8yR29PeUtwTzJLdUN3ZzY3bUlJTzJabE91cHRDRHNsWWpyZ3JRc0lPdXdzT3VFaUNEcms3RXBMQ0RzbHJUcmxxUWc3SU9CN1ptcDdKMjQ3S2VBS095RXNlcXp0U0R0aHJYcnM3UXY3SmlrNjZXWUwrMlpsZXlkdUNEc21wVHNzcTB2N0pXSTY0SzBLU0Rxc0puc25ZQWc2cktETGlEcXZLMGc3WldFN0pxVTdaV2NJT3F5Zyt1bmpDRHFzNmpybmJ3ZzdaV2NJT3V5aU95WGtDRHN0WnpyaklBZ011cXduT3E1ak95bmdDd2c3S2VuNnJLTUxpRHNuYlRybFl3Z2MzVm5aMlZ6ZEdsdmJuUHJpcFFnNjdtSUlPdXdzT3lYdEM1Y2JpY2dLd29nSUNBZ0lDQW5MU0Rxc0pEcw0KbmJRZzdKYTA2NHFRSU95Z2xldVBoQ0RzbUtUcnFiUWc2Nnk3NnJpdzY2ZU1JTzJWbU95bmdDRHJwNGpybmJ3ZzRvQ1VJT3F3Z095Z2xleWRoQ0RzaExqc21yRHFzNkFnN0xTSTdKV0lJSE4xWjJkbGMzUnBiMjV6NjZXOElPMlZxT3E3bUNEcmdyVHJxYlRzaEp3c0lISmxjR3g1N0plUUlPcXdnT3lnbGV5ZGhDRHJzSjN0bm9qcXM2QWc2NnkwN0plSDdKMkVJT3lWak91Z3BPeWp2T3VwdENEcmpaUWc2NmVlN0xhY0lPeUltQ0Rzbm9qcmlwVHNwNEFnN1pXY0lPdXN1T3llcGV5Y3ZPdWhuQ0RyamFmcnRwbnNsNnpybmJ3bzdKaUlPaUFpN1ptVjdKMjRJTzJNbmV5WGhleWR0T3Vkdk9xem9DRHFzSURzb0pYdGxvanNsclRzbXBRZzRvQ1VJTzJHb095S3BPMkt1T3Vkdk91cHRDRHNsWXpyb0tUc283enNoTGpzbXBRaUtTNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEcnJManF0YXpycGJ3ZzdLQ2M3SldJN1pXZ0lPdVZrQ0RzaEp6cm9ad2c3S0NSNnJlODdKMjBJT3VMcE91bHVDQXlmalBxc0p3dUlPcXdnU0Rzb0p6c2xZanMNCmw1UWc3Sm1jSU9xM3VPdWdoK3F5akNEc2pienJpcFRzcDRBZzdKMjA3SnlnNjZXOElPdTJtZXlkdU91THBDNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEc2dxenNtcW5zbnBEcXNJQWc3SmE0NnJpSjdaV1k3S2VBSU95Vml1eWRnQ0RxdGF6c3NyUWc3S0NWNjdPMEtPeWdoTzJabE91eWlPMll1TUszVlZKTXdyZnF1SWpzbGFIQ3QrMmFuK3lJbUNEcms3RXA2Nlc4SU95bmdPeVd0T3VDdENEcmhLUHNwNEFnNjZlSTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPMmJoT3lHalNEc21wVHNzcTBvSXV1TmxDRHNwNmZxc293aUxDQWk2N0tFN1lxODdKcXA3Snk4NjZHY0lpRHJrN0VwN0oyMDY2bTBJT3luZ2V5Z2hDRHNvSnpzbFlqc25ZUWc2cmU0SU91d3FlMldwZXljdk91aG5DRHFzNkRzczVBZzY0dWs3SXVjSU95Z25PeVZpTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdJQ0FuNjR1MTdKMkFJT3V3bU91VG5PeUxuQ0JLVTA5T0lPcXduZXl5dENEdGxaanJncGpycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzDQptclRDdCt5RXBPdXFoU0RxdUlqc3A0QTZJQ2NnS3dvZ0lDQWdJQ0FuZXlKeVpYQnNlU0k2SUNMcmpJRHRtWlFnN0oyUjY0dTFJTzJWbk91UmtDRHJyTGpzbnFVZ0tPMlZ0T3lhbE95eXRDa2lMQ0FpYzNWbloyVnpkR2x2Ym5NaU9pQmJleUowWlhoMElqb2dJdXVzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0R0bFp3ZzY2eTQ3SjZsSW4xZGZWeHVYRzRuSUNzS0lDQWdJQ0FnSjF2cmpJRHRtWlJkWEc0bklDc2dkSEpoYm5OamNtbHdkQW9nSUNBZ0tUc0tJQ0I5TENCdGIyUmxiQ3dnY21Wd1lYSnpaU2s3Q24wS0NpOHZJTzJVaE91Z2lPeWVoT3V6aENqdGxaanNuSVFnN1pTRTY2Q0k3SjZFSU91c3R1eWRqQ2tnN0xhVTdMS2NJTzJFdENEaWdKUWc3WldjSU8yWmxPdXB0T3lkaENEdGxaanNuSVFnN1pTRTY2Q0k3SjZFSU91THFPeWNoT3VobkNEcmdwanJpS0FnNjdPMDY0SzA2ck9nTEFvdkx5QXFLdTJVaE91Z2lPeWVoT3VuaU91THBDRHJsTERyb1p3cQ0KS2lEcmpJRHNsWWpzbllRZzY3Q2I2NHFVNjR1a0xpRHRsWndnN0pxVTdMS3Q3SmVRSU91THBDRHNpNlRzbHJRZzY3TzA2NEswNjRxVUlPcXlnK3lkdENEdGxiWHNpNnc2Q2k4dklPMlVoT3VnaU95ZWhDRHNpSmpycDR6dGdid2c3SnFVN0xLdDdKMkVJT3lxdk9xd25PdXB0Q0RxdDdqcnA0enRnYndnNjRxUTY2Q2s3S2VBNnJPZ0tPcXdnU0ExZmpFdzdMU0lLU0RxdGF6cmo0VWc3SUtzN0pxcDY1K0o2NCtFSU9xM3VPdW5qTzJCdkNEcmdwanFzSVRyaTZRdUNpOHZJR2R5YjNWd2N6b2dXM3R1WVcxbExDQjBaWGgwY3pwYlhYMWRJQ2p0bVpUcnFiUWc3SnlFNG9hUzdKV0U2NTZZSU95SW5Da3VDbVoxYm1OMGFXOXVJR0Z6YTBkeWIzVndjeWhuY205MWNITXNJRzF2WkdWc0xDQnlaWEJoY25ObExDQnRiM0psS1NCN0NpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnZXdvZ0lDQWdMeThnNjdLRTdZcThJT3lZZ2V5WHJleWRnQ0FvNjdLRTdZcThLZXljdk91aG5DRHNzSTNzbHJRZzY3TzA2NEs0NjR1a0lPS0ENCmxDRHJzb1R0aXJ3ZzY2eTQ2cldzNjRxVUlPdXN1T3llcGV5ZHRDRHNsWVRyaTRqcm5id2c2NCtaN0o2UklPeWR0T3VtaE95ZHRPdWR2Q0RxdDV6c3VabnNuYlFnNjR1azY2VzA2NHVrQ2lBZ0lDQmpiMjV6ZENCc2FYTjBJRDBnS0dkeWIzVndjeUI4ZkNCYlhTa3ViV0Z3S0NobkxDQnBLU0E5UGdvZ0lDQWdJQ0FuV3ljZ0t5QW9hU0FySURFcElDc2dKMTBnSnlBcklGTjBjbWx1Wnlnb1p5QW1KaUJuTG01aGJXVXBJSHg4SUNnbjZyZTQ2Nk81SnlBcklDaHBJQ3NnTVNrcEtTQXJJQ2huSUNZbUlHY3VjbTlzWlNBOVBUMGdKK3V5aE8yS3ZDY2dQeUFuSUNqcnNvVHRpcndwSnlBNklDY25LU0FySUNkY2JpY2dLd29nSUNBZ0lDQW9aeUFtSmlCQmNuSmhlUzVwYzBGeWNtRjVLR2N1ZEdWNGRITXBJRDhnWnk1MFpYaDBjeUE2SUZ0ZEtTNXRZWEFvS0hRcElEMCtJQ2NnSUMwZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtGTjBjbWx1WnloMElIeDhJQ2NuS1NrcExtcHZhVzRvSjF4dUp5a0tJQ0FnSUNrdWFtOXBiaWduDQpYRzRuS1RzS0lDQWdJR052Ym5OMElHaGhjMEowYmlBOUlDaG5jbTkxY0hNZ2ZId2dXMTBwTG5OdmJXVW9LR2NwSUQwK0lHY2dKaVlnWnk1eWIyeGxJRDA5UFNBbjY3S0U3WXE4SnlrN0NpQWdJQ0JqYjI1emRDQnJaWGtnUFNBblozSnZkWEJ6SnlBcklDaG5jbTkxY0hNZ2ZId2dXMTBwTG0xaGNDZ29aeWtnUFQ0Z0tHY2dKaVlnWnk1MFpYaDBjeUEvSUdjdWRHVjRkSE11YW05cGJpZ25KeWtnT2lBbkp5a3BMbXB2YVc0b0p5Y3BPd29nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2hyWlhrcElIeDhJREFwSUNzZ01Uc0tJQ0FnSUdGemEyVmtRMjkxYm5RdWMyVjBLR3RsZVN3Z1lYUjBaVzF3ZENrN0NpQWdJQ0JwWmlBb1lYTnJaV1JEYjNWdWRDNXphWHBsSUQ0Z01qQXdLU0JoYzJ0bFpFTnZkVzUwTG1Oc1pXRnlLQ2s3Q2lBZ0lDQmpiMjV6ZENCaFoyRnBiaUE5SUcxdmNtVWdmSHdnWVhSMFpXMXdkQ0ErSURFS0lDQWdJQ0FnUHlBbjdKMjBJTzJabE91cHRPeWRnQ0RzbmJRZw0KN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3V2dUNEcmk2VHJwSmpyaTZRdUlPeVZudXlFbkNEcmdyZ2c2NHlBN0pXSTZyTzhJT3lXdE8yY21NSzM2cldzN0tHdzZyQ0FJTzJabGV5THBPMmVpQ0RyaTZUcnBiZ2c3SU9JSU91TWdPeVZpT3VuakNEcmdyVHJuYnd1WEc0bkNpQWdJQ0FnSURvZ0p5YzdDaUFnSUNCeVpYUjFjbTRnS0FvZ0lDQWdJQ0JoWjJGcGJpQXJDaUFnSUNBZ0lDZnNuYlRyc29nZzdKcVU3TEt0N0oyQUlDTHRtWlRycWJUc25ZUWc3WldZN0p5RUlPMlVoT3VnaU95ZWhPdXpoT3VobkNEcmdwanJpS0FnNjR1azY1T3M2cml3SXV1THBDNGc3SldFNjU2WTY0cVVJTzJWbkNEdG1aVHJxYlRzblpnZzY2eTQ2cldzNjZXOElPMlZtT3ljaENEdGxJVHJvSWpzbm9RbzdKaUI3SmV0S1NEcmk2anNuSVRyb1p3ZzY2eTI3SjJBSU9xeWcreWR0T3VMcEM1Y2JpY2dLd29nSUNBZ0lDQW5LaXJzbUlIc2w2M3JwNGpyaTZRZzY1U3c2NkdjS2lvZzY0eUE3SldJN0oyRUlPdUN0T3VkdkNEaWdKUWc3SmlCN0pldDdKMkUNCklPeUVuT3VobkNEdGxhbnN1Wmpxc2JEcmdwZ2c3SWljN0lTYzY2VzhJT3V3bE9xK3VPeW5nQ0RycDRqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSnkwZzZyQ0JJT3lZZ2V5WHJleVhrQ0RyaklEc2xZZ2dNdXF3bkM0ZzZyZTRJT3lZZ2V5WHJleWR0Q0RzbDZ6cm42d2c3S1NFN0oyMDY2bTBJT3VNZ095VmlPdVBoQ0FxS3Vxd21leWRnQ0RzcElRZzdJaVlLaXJyb1p3bzdLU0U2N0NVNnIrSUlGeGNidXljdk91aG5DRHF0YXpydG9Rc0lPeWtoQ0RzaUp6c2hKd2c3SnlnN0tlQUtTNWNiaWNnS3dvZ0lDQWdJQ0FuTFNEc21JSHNsNjNzblpnZzdKZXQ3WldnS08yRGdPeWR0TzJMZ01LMzdKV0k2NEswd3JmcnNvVHRpcndnNjVPeEtlcXp2Q0RzbTVEcnJManNuWmdnN0tDVjY3TzB3cmZzb2JEcXNiUW83SWlyN0o2UXdyZnJqSURzZzRIQ3QreWhzT3F4dENuc25ZQWc3SnlnN0tlQTdaV1k2ck9nTENEc2w0YnJpcFFnN0tDVjY3TzA2Nlc4SU95bmdPeVd0T3VDdE95bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnDQo2ck9nN0xtZ0lPcXlqQ0RzbDRicmlwUWc3SmlCN0pldDdKMjA2Nm0wSU91TWdPeVZpQ0F4NnJDYzY2ZU1JT3VDdE9xeHNPdUNtQ0RydVlnZzY3Q3c3SmUwNjZHY0lPdVJrT3lXdE91UGhDRHJrSnpyaTZRZzRvQ1VJT3lXdGV5bmdPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRnQ0RxdDdqcmpJRHJvWndnNjVHVTY0dWtMbHh1SnlBckNpQWdJQ0FnSUNob1lYTkNkRzRnUHlBbkxTQW82N0tFN1lxOEtleWN2T3VobkNEdGtaenNpNXpya0p3ZzdKaUI3SmV0N0oyQUlDY2dLeUJDVlZSVVQwNWZVbFZNUlNBNklDY25LU0FyQ2lBZ0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzZyQ2Q3TEswSU8yVm1PdUNtT3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUxwT3lhdE1LMzdJU2s2NnFGd3Jmc3ZaVHJrNXp0anB6c2lxUWc2cmlJN0tlQU9seHVKeUFyQ2lBZw0KSUNBZ0lDZDdJbWR5YjNWd2N5STZJRnQ3SW01aGJXVWlPaUFpN0ppQjdKZXRJT3lkdE91bWhDanNub1hyb0tYcXM3d2c2NCtaN0oyOEtTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2NHlBN0pXSUlPdXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2dJdXlkdE95Y29DRHRsWndnNjZ5NDdKNmxJbjFkZlYxOVhHNG5JQ3NLSUNBZ0lDQWdKK3lZZ2V5WHJleWRnQ0Rzbm9Ycm9LVWc3SWljN0lTY3dyZnFzSnpzaUpqcnBid2c2cmU0NjR5QTY2R2NJT3luZ08yQ3FPdUxwQzVjYmx4dUp5QXJDaUFnSUNBZ0lDZGI3SmlCN0pldDY3T0VJT3VzdU9xMXJGMWNiaWNnS3lCc2FYTjBDaUFnSUNBcE93b2dJSDBzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLVHNLZlFvS0x5OGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RzblpIcmk3WHNsNURzaEp3Z1czdHVZVzFsTENCemRXZG5aWE4wYVc5dWN6cGJlM1JsZUhRc0lISmxZWE52Ym4xZGZWMGc3TGFVN0xhY0NtWjENCmJtTjBhVzl1SUhCaGNuTmxSM0p2ZFhCektISmhkeWtnZXdvZ0lHeGxkQ0J6SUQwZ1UzUnlhVzVuS0hKaGR5a3VkSEpwYlNncExuSmxjR3hoWTJVb0wxNWdZR0FvUHpwcWMyOXVLVDljY3lvdmFTd2dKeWNwTG5KbGNHeGhZMlVvTDF4ekttQmdZQ1F2YVN3Z0p5Y3BPd29nSUdOdmJuTjBJRzBnUFNCekxtMWhkR05vS0M5Y2UxdGNjMXhUWFNwY2ZTOHBPd29nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYnlBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3Q2lBZ0lDQmpiMjV6ZENCaGNuSWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHOGdKaVlnYnk1bmNtOTFjSE1wSUQ4Z2J5NW5jbTkxY0hNZ09pQmJYVHNLSUNBZ0lHTnZibk4wSUdkeWIzVndjeUE5SUdGeWNpNXRZWEFvS0djcElEMCtJQ2g3Q2lBZ0lDQWdJRzVoYldVNklGTjBjbWx1Wnlnb1p5QW1KaUJuTG01aGJXVXBJSHg4SUNjbktTNTBjbWx0S0Nrc0NpQWdJQ0FnSUhOMVoyZGxjM1JwYjI1ek9pQkJjbkpoZVM1cGMwRnljbUY1DQpLR2NnSmlZZ1p5NXpkV2RuWlhOMGFXOXVjeWtLSUNBZ0lDQWdJQ0EvSUdjdWMzVm5aMlZ6ZEdsdmJuTUtJQ0FnSUNBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIUjVjR1Z2WmlCNElEMDlQU0FuYzNSeWFXNW5Kd29nSUNBZ0lDQWdJQ0FnSUNBZ0lEOGdleUIwWlhoME9pQjRMblJ5YVcwb0tTd2djbVZoYzI5dU9pQW5KeUI5Q2lBZ0lDQWdJQ0FnSUNBZ0lDQWdPaUI3SUhSbGVIUTZJRk4wY21sdVp5Z29lQ0FtSmlCNExuUmxlSFFwSUh4OElDY25LUzUwY21sdEtDa3NJSEpsWVhOdmJqb2dVM1J5YVc1bktDaDRJQ1ltSUhndWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1FvZ0lDQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaDRLU0E5UGlCNExuUmxlSFFwQ2lBZ0lDQWdJQ0FnT2lCYlhTd0tJQ0FnSUgwcEtUc0tJQ0FnSUM4dklPeWR0T3VtaE95aHNPeXdxQ0RzbDRicXM2QWc3S0NjN0pXSTY0K0VJT3lYaHV1S2xDRHF1NDNyamJEcXVMRHJwNHdnN0ptVTdKeTg2Nm0wSU8yWWxleUxuU0RzbmJUdA0KZzRqcm9ad2c2N080NjR1a0tPcXdtZXlkZ0NEc2hManNoWmpzbDVBZzdKNnM3SnFVN0xLdEtRb2dJQ0FnY21WMGRYSnVJR2R5YjNWd2N5NXpiMjFsS0NobktTQTlQaUJuTG5OMVoyZGxjM1JwYjI1ekxteGxibWQwYUNrZ1B5Qm5jbTkxY0hNZ09pQnVkV3hzT3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3Q2lBZ0lDQnlaWFIxY200Z2JuVnNiRHNLSUNCOUNuMEtDaTh2SU8yTW5leVhoU0RzaExqdGlyZ2c3TGFVN0xLY0lPMkV0Q0RpZ0pRZzdaV2NJTzJNbmV5WGhleWRtQ0RxdGF6c2hMSHNtcFRzaG93bzdKZXQ3WldnSyt1c3VPcTFyQ25ycGJ3ZzdaV2NJT3V5aU95WGtDRHJzN1RyZ3JUcXM2QXNDaTh2SU95YWxPeUdqT3V6aENEcmdySHFzSnpxc0lBZzdKV0U2NHVJNjUyOElDb3E3Sm1FN0lTeDY1Q2NJTzJNbmV5WGhTRHNoTGp0aXJnbzdMeUE3SjIwN0lxa0tTQXlmalBxc0p3cUt1dWx2Q0R0aHJYc25MenJvWndnNjdDYjY0cVU2NHVrTGdvdkx5RHRnNERzbmJUdGk0REN0K3lWaU91Q3RNSzM2N0tFN1lxODdKMjANCklPMlZuQ0RycXJqc25MenJvWndnN0oyODZyU0E2NCs4N0pXOElPMlZtT3V2Z091aG5DanJsTERyb1p3ZzY3MlI3SldFSU95aHNPMlZxZTJWbU91cHRDRHNsclRxdUl2cmdwenJpNlFwSU95RXVPMkt1Q0RyaTZqc25JVHJvWndnN0tDYzdKV0k3WldZNnJLTUlPMlZuT3VMcEM0S0x5OGdaV3hsYldWdWRITTZJRnQ3Y205c1pTd2dkR1Y0ZEgxZElDanRtWlRycWJRZzdKeUU0b2FTN0pXRTY1NllJT3lJbkNrdUNpOHZJRzF2Y21VOWRISjFaU2hiN0x5QTdKMjA3SXFrSU91TmxDRHJzSnZxdUxCZEtldXB0Q0RzbmJRZzdJUzQ3SVdZN0plUTdJU2NJT3lkdE91dnVDRHJncmdnN0lTNDdZcTQ3Sm1BSU9xeXVleTVtT3luZ0NEc2xZcnJpcFFnN0lPSUlPeUV1TzJLdU91bHZDRHNtcFRxdGF6dGxaenJpNlF1Q21aMWJtTjBhVzl1SUdGemExQnZjSFZ3S0dWc1pXMWxiblJ6TENCdGIyUmxiQ3dnY21Wd1lYSnpaU3dnYlc5eVpTa2dld29nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJSEp2DQpiR1Z6SUQwZ0tHVnNaVzFsYm5SeklIeDhJRnRkS1M1dFlYQW9LR1VwSUQwK0lGTjBjbWx1Wnlnb1pTQW1KaUJsTG5KdmJHVXBJSHg4SUNjbktTa3VhbTlwYmlnbkxDQW5LVHNLSUNBZ0lHTnZibk4wSUd4cGMzUWdQU0FvWld4bGJXVnVkSE1nZkh3Z1cxMHBMbTFoY0Nnb1pTd2dhU2tnUFQ0S0lDQWdJQ0FnS0drZ0t5QXhLU0FySUNjdUlGc25JQ3NnVTNSeWFXNW5LQ2hsSUNZbUlHVXVjbTlzWlNrZ2ZId2dKeWNwSUNzZ0oxMGdKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLRk4wY21sdVp5Z29aU0FtSmlCbExuUmxlSFFwSUh4OElDY25LU2tLSUNBZ0lDa3VhbTlwYmlnblhHNG5LVHNLSUNBZ0lDOHZJT3F3bWV5ZGdDRHRqSjNzbDRYc25ZUWc2NnFISU91eWlPeW51Q0Ryckx2cmlwVHNwNEFnNnJpdzdKYTFJT0tBbENEc25xenNtcFRzc3Ezc25iVHJxYlFnSXV5ZHRPeWdoT3F6dkNEcmk2VHJwYmdnN0lTNDdZcTRJdXVsdkNEc21wVHF0YXp0bFp6cmk2UUtJQ0FnSUM4dklDaGhjMnREYkdGMVpHWHNtWUFnNnJDWg0KN0oyQUlPeWR0T3ljb0RvZzdKV0lJT3EzdU91ZnJPdXB0Q0R0Z2JUcm9aenJrNXpxc0lBZzZyQ1o3SjJBSU95RXVPMkt1T3VsdkNEcm1KQWc2NEswN0lTY0lGdnN2SURzbmJUc2lxUWc2NDJVSU91d20rcTRzRjNxc0lBZzY2eTA3SjJZNjYrNDdaVzA3S2VFNjR1a0tRb2dJQ0FnWTI5dWMzUWdhMlY1SUQwZ0ozQnZjSFZ3QVNjZ0t5QW9aV3hsYldWdWRITWdmSHdnVzEwcExtMWhjQ2dvWlNrZ1BUNGdVM1J5YVc1bktDaGxJQ1ltSUdVdWRHVjRkQ2tnZkh3Z0p5Y3BLUzVxYjJsdUtDY0JKeWs3Q2lBZ0lDQmpiMjV6ZENCaGRIUmxiWEIwSUQwZ0tHRnphMlZrUTI5MWJuUXVaMlYwS0d0bGVTa2dmSHdnTUNrZ0t5QXhPd29nSUNBZ1lYTnJaV1JEYjNWdWRDNXpaWFFvYTJWNUxDQmhkSFJsYlhCMEtUc0tJQ0FnSUdsbUlDaGhjMnRsWkVOdmRXNTBMbk5wZW1VZ1BpQXlNREFwSUdGemEyVmtRMjkxYm5RdVkyeGxZWElvS1RzZ0x5OGc2NnkwN1pXYzdaNklJT3lNayt5ZHRPeW5nQ0RzbFlycXNvd0tJQ0FnSUdOdmJuTjANCklHRm5ZV2x1SUQwZ2JXOXlaU0I4ZkNCaGRIUmxiWEIwSUQ0Z01Rb2dJQ0FnSUNBL0lDZnNuYlFnN1l5ZDdKZUY3SjJBSU95ZHRDRHNoTGpzaFpqc2w1RHNoSndnN0oyMDY2KzRJT3VMcE91a21PdUxwQzRnN0pXZTdJU2NJT3lnbk95VmlPMlZuQ0RzaExqdGlyanJrNlRxczd3Z0tpcnNvSkhxdDd6Q3QreVd0TzJjbU9xd2dDRHRtWlhzaTZUdG5vZ2c2NHVrNjZXNElPeURpQ0RzaExqdGlyZ3FLdXVuakNEcmdyVHJuYndvNnJDWjdKMkFJT3lFdU8yS3VDRHJzSmpyczdVZzZyaUk3S2VBS1M1Y2JpY0tJQ0FnSUNBZ09pQW5KenNLSUNBZ0lISmxkSFZ5YmlBb0NpQWdJQ0FnSUdGbllXbHVJQ3NLSUNBZ0lDQWdKK3lkdE91eWlDRHNtcFRzc3Ezc25ZQWdJdTJNbmV5WGhTanJpNlRzbmJUc2xyenJvWnpxdDdncElPeUV1TzJLdUNEcmk2VHJrNnpxdUxBaTY0dWtMaURzbFlUcm5wanJpcFFnN1pXY0lPMk1uZXlYaGV5ZGhDRHNuSVRpaHBMc2xZVHJucGpyb1p3ZzY0S1k3SmUwN1pXY0lPcTFyT3lFc2V5YWxPeUdqT3VUDQpwT3lkdE91THBDanNoSnpyb1p3ZzY2eTA2clNBN1pXY0lPdXpoT3F3bkNEcnJManF0YXpxc0lBZzdKV0U2NHVJNjR1a0tTNGdKeUFyQ2lBZ0lDQWdJQ2ZzbXBUc2hvenJwYndnNjRLeDZyQ2M2NkdjSU9xem9PeTVtT3luZ0NEcnA1RHFzNkFzSUNvcTdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdk95ZHRDRHNoSnpyb1p3ZzdKMjg2clNBNjVDY0lDTHNtWVRzaExIcmtKd2c3WXlkN0plRklPeUV1TzJLdUNJZ01uNHo2ckNjS2lycnBid2c3S0NjN0pXSTdaV1k2NTI4TGlEcXNJRWc3SVM0N1lxNDY0cVVJT3lFbk91aG5DRHJpNlRycGJnZzdLQ1I2cmU4N0oyMDdKYTA3Slc4SU8yVm5PdUxwQzVjYmljZ0t3b2dJQ0FnSUNBbjZyQ0JJT3lFdU8yS3VPdUtsQ0Rzbm9Ycm9LWHFzN3dnS2lycXNKbnNuWUFnN0pldDdaV2d3cmZxc0puc25ZQWc2ckNjN0lpWXdyZnFzSm5zbllBZzdJaWM3SVNjS2lyc25aZ2c3SnFVN0lhTTY2VzhJT3VxcU91UmtDRHRqNnp0bGFqdGxaenJpNlF1SU95RXVPMkt1Q0RzbFlqcw0KbDVEc2hKd2c3WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZPeWRnQ0R0bFp3ZzY2cTQ3Snk4NjZHY0lPdW5udXlWaE91V3FPeVd0T3lndU95VnZDRHRsWnpyaTZRbzdKaUlPaURyczdqcnJManNuYlFnSW43dGxhRHF1WXpzbXBRL0l1dXB0Q0Ryc29UdGlyenNuWUFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBwTGx4dUp5QXJDaUFnSUNBZ0lDZGI3WXlkN0plRklPdXN1T3l5dENEcXQ1enN1WmtnNG9DVUlPeWNoQ0RzaXFUdGc0RHNuYndnNnJDQTdKMjA2NU9jN0oyWUlDSTRMaUR0akozc2w0VWlJT3lFdWV5Rm1PeWRoQ0RybExEcnBianJpNlJkWEc0bklDc0tJQ0FnSUNBZ0p5MGc3WU9BN0oyMDdZdUFPaURzcDZmc25ZQWc2NnFGN0lLczZyV3NLREorTk95V3RPeWdpQ2tzSU95aWhlcXlzT3lXdE91dnVNSzM2NmVJN0xtbzdaR2NJT3lYaHV5ZHRDaCs3SnFVTDM3cmk2UXZmdXE1ak95YWxEOGc2cmlJN0tlQUtTNGc2N0NZNjVPYzdJdWNJT3lWaU91Q3RDanJzN2pyckxncElPdW5wZXVkdmV5ZGhDRHMNCm1wVHNsYjN0bGJRZzdZT0E3SjIwN1l1QTY2ZU1JT3Uwa091UGhDRHJyTFRzaXFnZzdZeWQ3SmVGN0oyNDdLZUFJT3lWak9xeWpDRHRsWmpybmJ3dUlPeWJrT3V6dU95ZHRDQWk3SldNNjZhOEwrMlpsZXlkdUNMc3NwanJuN3dnNjZlSjdKZXc3WldZNjZtMElPdXp1T3VzdU95ZGhDRHF0N3pxc2JEcm9ad2c2cldzN0xLMDdabVU3WldZNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU95VmlPdUN0Q2pyczdqcnJMZ3BPaUR0bGJUc21wVHNzclF1SU8yTWtPdUxxT3lkdENEdGxZVHNtcFR0bFpqcnFiUWdJbjd0bGFEcXVZenNtcFEvSXV1aG5DRHJyTHZxczZBc0lPdVFtT3VQak91bXRDRHNpSmdnN0plRzY0cVVJT3ljaE8yWG1DanNncTNzb0p6Q3QrMkRpTzJIdENEcms3RXA3SjJBSU9xeXNPcXp2T3VsdkNEcnFMenNvSUFnNnJLOTZyT2c3WldjNjR1a0xpRHFzckRxczd6Q3QreURnZTJEbkNEdGhyWHJzN1RycWJRZzdJU2M3SWlnN1ppVjdKeTg2NkdjSU95VmpPdW1zT3VMcEM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RyDQpzb1R0aXJ3NklPdXp1T3VzdU95ZHRDQWlmdTJWb09xNWpPeWFsRDhpNjZtMElGdnNsWVRyaTRqc21LUmRMMXZyaEtSZExDRHJzN2pyckxqc25iUWc3SU9CN1ptcDdKMkVJT3lFbk95SW9PMlZtT3F6b0NEc25iUWc2N0tFN1lxODdKMjBJT3lMcE95Z25DRHJqNW5zbnBIc25iVHJxYlFnNjQrWjdKNlJJT3VQbWV5Q3JDanNncTNzb0p3djdLQ0E3SjZsTCt5WHNPcXlzQ0R0bGJUc29Kd2c2NU94S1N3ZzdZYTE2N08wSU8yTW5leVhoZXlkbUNEcmk2anNuYndnNjdLRTdZcTg3SjIwNjZtMElDTHRtWlhzbmJnaUxpQWk3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3c0lDTHJpNnZxdUxEQ3QrdVBtZXlla1NJZzdLR3c3WldwSU9xNGlPeW5nQzRnN1ptVTY2bTBJT3E0c091S3BldXFoU2pyczREcXNyM0N0KzJWdE95Z25DRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWlRyaTZRdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN0p1UTY2eTQ3SjJZSU95Z2xldXp0TUszN0tHdw0KNnJHMEtPeUlxK3lla01LMzdKMjA3SU9CTCt5ZHRPMlZtTUszNjR5QTdJT0JLZXlkZ0NEc25LRHNwNER0bFpqcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNnJDZDdMSzBJTzJWbU91Q21PdW5qQ0RzdHB6cm9LWHRsWnpyaTZRdUlPdW5pTzJCck91THBPeWF0TUszN0lTazY2cUZ3cmZzdlpUcms1enRqcHpzaXFRZzZyaUk3S2VBT2x4dUp5QXJDaUFnSUNBZ0lDZDdJbk5sZEhNaU9pQmJleUp5WldGemIyNGlPaUFpN0oyMElPeUV1TzJLdU95ZG1DRHJzS250bHFYc25ZUWc3WldjNnJXdDdKYTBJTzJWbkNEcnJManNucVhzbkx6cm9ad2lMQ0FpWld4bGJXVnVkSE1pT2lCYmV5SnliMnhsSWpvZ0l1eVhyZTJWb0NJc0lDSjBaWGgwSWpvZ0l1dXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraWZTd2cNCkxpNHVYWDBzSUM0dUxsMTlYRzRuSUNzS0lDQWdJQ0FnSit5WHJlMlZvT3lkZ0NEc25vWHJvS1VnN0lpYzdJU2M2NHlBNjZHY09pQW5JQ3NnY205c1pYTWdLeUFuWEc1Y2JpY2dLd29nSUNBZ0lDQW5XKzJNbmV5WGhTRHNtcFRzaG94ZFhHNG5JQ3NnYkdsemRBb2dJQ0FnS1RzS0lDQjlMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdDbjBLQ2k4dklPMk1uZXlYaFNEc25aSHJpN1hzbDVEc2hKd2dlM05sZEhNNklGdDdjbVZoYzI5dUxDQmxiR1Z0Wlc1MGN6cGJlM0p2YkdVc2RHVjRkSDFkZlYxOUlPeTJsT3kybkNBbzdMMlU2NU9jN1k2YzdJcWt3cmZzbFo3cmtxUWc3SjZoNjR1MElPMlhpT3lhcVNrS1puVnVZM1JwYjI0Z2NHRnljMlZRYjNCMWNDaHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqDQphQ2d2WEh0YlhITmNVMTBxWEgwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzhnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ1kyOXVjM1FnYzJWMGMwbHVJRDBnUVhKeVlYa3VhWE5CY25KaGVTaHZJQ1ltSUc4dWMyVjBjeWtnUHlCdkxuTmxkSE1nT2lCYlhUc0tJQ0FnSUdOdmJuTjBJSE5sZEhNZ1BTQnpaWFJ6U1c0S0lDQWdJQ0FnTG0xaGNDZ29jM1FwSUQwK0lDaDdDaUFnSUNBZ0lDQWdjbVZoYzI5dU9pQlRkSEpwYm1jb0tITjBJQ1ltSUhOMExuSmxZWE52YmlrZ2ZId2dKeWNwTG5SeWFXMG9LU3dLSUNBZ0lDQWdJQ0JsYkdWdFpXNTBjem9nUVhKeVlYa3VhWE5CY25KaGVTaHpkQ0FtSmlCemRDNWxiR1Z0Wlc1MGN5a0tJQ0FnSUNBZ0lDQWdJRDhnYzNRdVpXeGxiV1Z1ZEhNS0lDQWdJQ0FnSUNBZ0lDQWdJQ0F1YldGd0tDaGxiQ2tnUFQ0Z0tIc2djbTlzWlRvZ1UzUnlhVzVuS0NobGJDQW1KaUJsYkM1eWIyeGxLU0I4ZkNBbkp5a3VkSEpwYlNncA0KTENCMFpYaDBPaUJUZEhKcGJtY29LR1ZzSUNZbUlHVnNMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlNrcENpQWdJQ0FnSUNBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvWld3cElEMCtJR1ZzTG5SbGVIUXBDaUFnSUNBZ0lDQWdJQ0E2SUZ0ZExBb2dJQ0FnSUNCOUtTa0tJQ0FnSUNBZ0xtWnBiSFJsY2lnb2MzUXBJRDArSUhOMExtVnNaVzFsYm5SekxteGxibWQwYUNrN0NpQWdJQ0J5WlhSMWNtNGdjMlYwY3k1c1pXNW5kR2dnUHlCelpYUnpJRG9nYm5Wc2JEc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V3b2dJQ0FnY21WMGRYSnVJRzUxYkd3N0NpQWdmUXA5Q2dvdkx5RHJqSUR0bVpUdG1KVWc3S0NjN0o2UklPeWRrZXVMdGV5WGtPeUVuQ0I3Y21Wd2JIa3NJSE4xWjJkbGMzUnBiMjV6VzExOUlPeTJsT3kybkNBbzdMMlU2NU9jN1k2YzdJcWt3cmZzbFo3cmtxUWc3SjZoNjR1MElPMlhpT3lhcVNrS1puVnVZM1JwYjI0Z2NHRnljMlZEYjIxd2IzTmxLSEpoZHlrZ2V3b2dJR3hsZENCeklEMGdVM1J5YVc1bktISmgNCmR5a3VkSEpwYlNncExuSmxjR3hoWTJVb0wxNWdZR0FvUHpwcWMyOXVLVDljY3lvdmFTd2dKeWNwTG5KbGNHeGhZMlVvTDF4ekttQmdZQ1F2YVN3Z0p5Y3BPd29nSUdOdmJuTjBJRzBnUFNCekxtMWhkR05vS0M5Y2UxdGNjMXhUWFNwY2ZTOHBPd29nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNLSUNCMGNua2dld29nSUNBZ1kyOXVjM1FnYnlBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3Q2lBZ0lDQmpiMjV6ZENCeVpYQnNlU0E5SUZOMGNtbHVaeWdvYnlBbUppQnZMbkpsY0d4NUtTQjhmQ0FuSnlrdWRISnBiU2dwT3dvZ0lDQWdZMjl1YzNRZ2MzVm5aMlZ6ZEdsdmJuTWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHOGdKaVlnYnk1emRXZG5aWE4wYVc5dWN5a0tJQ0FnSUNBZ1B5QnZMbk4xWjJkbGMzUnBiMjV6Q2lBZ0lDQWdJQ0FnSUNBdWJXRndLQ2g0S1NBOVBpQW9leUIwWlhoME9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1MFpYaDBLU0I4ZkNBbkp5a3VkSEpwYlNncExDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2VDQW1KaUI0DQpMbkpsWVhOdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa0tJQ0FnSUNBZ0lDQWdJQzVtYVd4MFpYSW9LSGdwSUQwK0lIZ3VkR1Y0ZENrS0lDQWdJQ0FnT2lCYlhUc0tJQ0FnSUdsbUlDaHlaWEJzZVNCOGZDQnpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ3BJSEpsZEhWeWJpQjdJSEpsY0d4NUxDQnpkV2RuWlhOMGFXOXVjeUI5T3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUc1MWJHdzdDbjBLQ2k4dklPdXlpT3lYclNEc25aSHJpN1hzbDVEc2hKd2dlM1J5WVc1emJHRjBaV1FzSUdScGNtVmpkR2x2Ym4wZzdMYVU3TGFjSUNqc3ZaVHJrNXp0anB6c2lxVEN0K3lWbnV1U3BDRHNucUhyaTdRZzdaZUk3SnFwS1FwbWRXNWpkR2x2YmlCd1lYSnpaVlJ5WVc1emJHRjBaU2h5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObA0KS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3dvZ0lDQWdZMjl1YzNRZ2RISmhibk5zWVhSbFpDQTlJRk4wY21sdVp5Z29ieUFtSmlCdkxuUnlZVzV6YkdGMFpXUXBJSHg4SUNjbktTNTBjbWx0S0NrN0NpQWdJQ0JwWmlBb2RISmhibk5zWVhSbFpDa2djbVYwZFhKdUlIc2dkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1T2lCVGRISnBibWNvS0c4Z0ppWWdieTVrYVhKbFkzUnBiMjRwSUh4OElDY25LUzUwY21sdEtDa2dmVHNLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc2xZVHJucGpyb1p3Z0tpOGdmUW9nSUhKbGRIVnliaUJ1ZFd4c093cDlDZ292THlEc25aSHJpN1hzbDVEc2hKd2dlM1JsZUhRc0lISmxZWE52Ym4wZzY3Q3c3SmUwSU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnMNCmxaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa0tablZ1WTNScGIyNGdjR0Z5YzJWVGRXZG5aWE4wYVc5dWN5aHlZWGNwSUhzS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhGdGJYSE5jVTEwcVhGMHZLVHNLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUdGeWNpQTlJRXBUVDA0dWNHRnljMlVvY3lrN0NpQWdJQ0JwWmlBb1FYSnlZWGt1YVhOQmNuSmhlU2hoY25JcEtTQjdDaUFnSUNBZ0lISmxkSFZ5YmlCaGNuSUtJQ0FnSUNBZ0lDQXViV0Z3S0NoNEtTQTlQaUFvZXlCMFpYaDBPaUJUZEhKcGJtY29LSGdnSmlZZ2VDNTBaWGgwS1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQ0J5WldGemIyNDZJRk4wY21sdVp5Z29lQ0FtSmlCNExuSmxZWE52YmlrZ2ZId2dKeWNwDQpMblJ5YVcwb0tTQjlLU2tLSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOVBpQjRMblJsZUhRcE93b2dJQ0FnZlFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUZ0ZE93cDlDZ292THlEcm9aenF0N2pzbmJnZzdaV0U3SnFVd3JmdGxaenJqNFFnN0xTSTZyTzhJT3lEZ2UyRG5PeWR2Q0RybFl3Z0wyaGxZV3gwYUNEc29iRHRtb3pxc0lBZzdKaWs2Nm0wSU91U3BPeVhrT3lFbkNEc200enJzSTNzbDRYc25ZUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRPdXp1T3VMcENBb016RHN0SWpzbDVBZ01ldXlpT3VuakNrdUNpOHZJT3lFc2VxenRlMlZtT3VwdENEcXNyRHFzN3dnN1pXNDY1T2s2NStzNnJDQUlHTnNZWFZrWlZOMFlYUjFjejBuYjJzbjY2R2NJT3VRbU91UGpPdW1yT3V2Z091aG5Dd2c3SjZzNjZHYzZyZTQ3SjI0SU8yYmhDRHJzb1R0aXJ6c25iUWc3S0NBN0tDSTY2R2NJUENmbjZMc25MenJvWndnNjdPMTZyZUE3WldjNjR1a0xnb3ZMeUFvN1pTTQ0KNjUrczZyZTQ3SjI0N0oyMElPdWhuT3EzdU95ZHVDRHNzTDNzbllRZzdKZXdJT3VTcENEc283enF1TERzb0lIc25MenJvWndnTDJobFlXeDBhT3VsdkNEc29iRHRtb3p0bFpqcmlwUWc2cktENnJPOElPeW5uZXlkaENEc25iVHJvNnpyaTZRcENpOHZJTzJWbk91UGhDRHN0SWpxczd6cmo0UWc2ckNaN0oyQUlPcXl2ZXVobk91aG5DRHJzN1hxdDREc2k1enRncWpyaTZRZzRvQ1VJT3EwZ091bXJPeWVrT3F3Z0NEdGxaenJqNFRycGJ3ZzdKaXM2NkNrN0tPODZyR3c2NEtZSU8yVm5PdVBoT3F3Z0NEc3RJanF1TER0bVpUcmtKanJxYlFLTHk4ZzdJS3M3SnFwN0o2UTZyQ0FJT3lWaE91c3RPcXlnK3VQaENEc2xZZ2c2NGlNNjUrczY0K0VJT3V5aE8yS3ZPeWR0Q0R3bjUraTdKeTg2NkdjSU91UGpPeVZoT3lZcU91THBDNGc3WldjNjQrRTdKZVFJT3F4dU91bXNDRHRtTGpzdHB6c25ZQWc2ckd3N0tDSTY1Q1k2NitBNjZHY0lPeUNyT3lhcWV1ZmlleWRnQ0RzbFlnZzY0S1k2ckNFNjR1a0NpOHZJT3F6aE95Z2xleWQNCnRDQXFLdXV3bHV5WGtPeUVuQ29xSU91d2xPdUFrQ0Rxc29Qc25ZUWc3SldNN0pXRTdMR0k2NHVrSUNneU1ESTJMVEE0TENCQ1VrbEVSMFZmVmoweU5pa3VDaTh2SU8yRXNPdXZ1T3VFa095ZHRPdUNtQ0RydUl6cm5ienNtckRzb0lEc2w1RHNoSndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxaanJxYlFnN0o2UTZyS3A3S2FkNjZxRklPMk1qT3lkdk95ZGdDRHJzSlRyZ0l6c3A0RHJwNHdzSU95ZHRPdXZ1Q0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaUW92THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SmliSU9xemhPeWdsU0Rzbm9Yc25xWHF0b3pzbllRZzZyZTQ2NHlBNjZHY0lPeVR0T3VMcENEaWhwSWc3SU9JSU9xemhPeWdsZXlYa0NEc2dxenNtcW5ybjRuc25iUWc2NEtvN0pXRUlPeWVpT3lXdE91UGhDQWk3WldjNjQrRUlPeTBpT3F6dkNMcXNJQUtMeThnNnJPRTdJYU5JT3VDbU95WXFPdUxwQ2d5TURJMkxUQTRJT3lMcE95NG9TRHNpNkRxDQpzNkE2SUNMc2c0Z2c2ck9FN0tDVjdKeTg2NkdjSU91aG5PcTN1T3lkdU8yV2lPdUtsT3VOc0NEc21ad2c2cmU0SU9xemhPeWdsU0RzZ3F6c21xbnJuNG5zbllRZzY2cTdJT3lUc091RGtDSXBMZ292THlEdGxJenJuNnpxdDdqc25ianNuWVFnNnJHdzdMbWNJT3Vobk9xM3VPeWR1TUszNjZHYzZyZTQ3SldFN0p1REtDOXZjR1Z1TFd4dloybHV3cmN2WTJ4aGRXUmxMV3h2WjI5MWRDbnNuWUFnYTJsc2JGQnliMlBzbkx6cm9ad2c3SVM0N0lXWTdKMkVJT3V5aE91Z3BPeUVuQ0RzbmJRZzY2eTQ3S0NjNnJDQUNpOHZJT3lYaHV5WGlPdUtsT3VOc0N3ZzY3Q1c3SmVRN0lTY0lPdXdsT3ErdU91cHRDRHJpNlRycHF6cXNJQWc3SldNSU91d3FldXlsZXlkdENEc2w0YnNsNGpyaTZRdUlPcTN1T3VlbU95RW5DQXZhR1ZoYkhSb0lPeWhzTzJhak91bmlPdUxwQ0R0akl6c25ienNuWmdnNnJPRTdLQ1Y2ck84SU91NWhPcTFrTzJWbk91THBDNEtMeThnNjdtRTdKcXBJREFvN1l5TTdKMjg2NmVNSU95ZHZlcXpvQ3dnWTJ4aA0KZFdSbFFXTmpiM1Z1ZE95ZG1DQXpNT3kwaUNEc3VwRHNpNXpycGJ3ZzZyZTQ2NHlBNjZHY0lPeVR0T3VMcENEaWdKUWdMbU5zWVhWa1pTNXFjMjl1N0oyMElPeTdwT3lFbkNEcnA2VHJzb2dnN0oyOTdLZUFJT3lWaXV1S2xPdUxwQ2t1Q2k4dklPcXpoT3lnbFNEc25vanNuWXdnNG9hU0lPeVhodXlkakNqcm9aenF0N2pzbFlUc200TXBJT3V3cWUyV3BleWRnQ0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a09pRHRqSXpzbmJ6c25ZUWc2NDJ1N0phMDdKT3c2NHFVSU95SW5PcXdoQ0RzbnFEcXVaQWc2NnE3SU95ZHZldUtsQ0Rxc29QcXM3d0tMeThnNnJXczY3YUU2NUNZN0tlQUlPeVZpdXlWaENEdGw1c2c3SjZzN0l1YzdKNlI3SjJFSU91MmdPdWx0T3F6b0N3ZzZyZTRJT3V3cWUyV3BleWRnQ0RzbmJqc3BwMGc3SmlrNjZXWUlPcXl2ZXVobkNocGMwRjFkR2hGY25KdmNpbnFzSUFnN0oyMDY2KzRJT3l5bU91bXJPMlZuT3VMcEM0S1puVnVZM1JwYjI0Z2NtVnpkR0Z5ZEVsbVFXTmpiM1Z1ZEVOb1lXNW4NClpXUW9LU0I3Q2lBZ2FXWWdLQ0Z3Y205aklIeDhJSGRoYVhSbGNpa2djbVYwZFhKdU95QWdJQ0FnSUNBZ0lDOHZJT3lFdU95Rm1DRHNsNGJzbll3bzY0dWs3SjJNSU8yRXRPeWR0Q0RzZzRqcm9ad2c3SXVjNjQrWktTQXZJTzJFdENEc3A0VHRsb2tnN0tTUjdKMjA2Nm0wSU91THBPeWRqQ0Rzb2JEdG1venNsNURzaEp3S0lDQmpiMjV6ZENCdWIzY2dQU0JqYkdGMVpHVkJZMk52ZFc1MEtDazdDaUFnYVdZZ0tDRnViM2NnZkh3Z2JtOTNJRDA5UFNCelpYTnphVzl1UVdOamIzVnVkQ2tnY21WMGRYSnVPd29nSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHFzNFRzb0pYc25iUWc2N0NVNjRDTTdKZUk3SmEwN0pxVUlDZ25JQ3NnS0hObGMzTnBiMjVCWTJOdmRXNTBJSHg4SUNmc2w0YnNuWXduS1NBcklDY2c0b2FTSUNjZ0t5QnViM2NnS3lBbktTRGlnSlFnN0ppYklPcXpoT3lnbFNEc2hManNoWmpzbllRZzY3S0U2NmFzNnJPZ0lPeURpQ0RxczRUc29KWHNuTHpyb1p3ZzY0dWs3SXVjSU95TG5PeWVrZTJWDQpxZXVMaU91THBDNG5LVHNLSUNBdkx5RHNuWmpyajRUc29JRWc3S0tGNjZPTUtISmxZWE52YmlEc3A0RHNvSlVwSU9LQWxDQlRSVk5UU1U5T1gwUkpSVVRyb1p3ZzY0R2Q2NEswNjZtMElPeWVrT3VQbVNEc25xenNpNXpyajRUcXNJQWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuWVFnNjVDWTdJSzA2NmF3NjR1a0NpQWdhMmxzYkZCeWIyTW9KK3F6aE95Z2xleWR0Q0Ryc0pUcmdJenNsclRzaEp3ZzdJUzQ3SVdZN0oyRUlPeURpT3VobkNEc2k1enNucEh0bG9qc2xyVHNtcFFnNG9DVUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3BPd29nSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0lDOHZJTzJWbk91UGhNSzM2NkdjNnJlNDdKMjRJT3lEZ2UyRG5PdUtsQ0RxczRUc29KWHJwNGpyaTZRZzY0dWs2NlcwNjR1a0lPS0FsQ0RzZzRnZzZyT0U3S0NWN0p5ODY2R2NJT3VMcE95TG5DRHRqSkRzb0pYdGxaanFzb3dLSUNCelpYTnphVzl1UVdOamIzVnVkQ0E5SUc1dmR6c0tmUW9LYkdWMA0KSUd4aGMzUkJkWFJvVW1WMGNubEJkQ0E5SURBN0NtWjFibU4wYVc5dUlISmxkSEo1UVhWMGFFbG1UbVZsWkdWa0tDa2dld29nSUdsbUlDaGpiR0YxWkdWVGRHRjBkWE1nSVQwOUlDZGpiR0YxWkdVdGJHOW5iM1YwSnlBbUppQmpiR0YxWkdWVGRHRjBkWE1nSVQwOUlDZGpiR0YxWkdVdGJHbHRhWFFuS1NCeVpYUjFjbTQ3Q2lBZ2FXWWdLSGRoYVhSbGNpQjhmQ0JFWVhSbExtNXZkeWdwSUMwZ2JHRnpkRUYxZEdoU1pYUnllVUYwSUR3Z016QXdNREFwSUhKbGRIVnlianNnTHk4ZzdLZUU3WmFKSU95a2tTRHRoTFFnNjdDcDdaVzBJT3E0aU95bmdDQXJJRE13N0xTSUlPcXdoT3F5cVFvZ0lHeGhjM1JCZFhSb1VtVjBjbmxCZENBOUlFUmhkR1V1Ym05M0tDazdDaUFnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHNucXp0bVpYc25iZ2c3SXVjNjQrRTRvQ21KeWs3Q2lBZ2NuVnVWSFZ5Ymlnb0tTQTlQaUFuNjZHYzZyZTQ3SjI0SU8yWmxleWR1T3lhcWV5ZHRPdUxwQzRnSWs5TEl1dWQNCnZPcXpvT3VuakNEcmk3WHRsWmpybmJ3dUp5a3VkR2hsYmlnS0lDQWdJQ2dwSUQwK0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryb1p6cXQ3anNuYmdnN1ptVjdKMjQ2NUNvSU9LQWxDRHNvSlhzZzRFZzdJT0I3WU9jNjZHY0lPdXp0ZXEzZ0M0bktTd0tJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKV0U3S2VCSU91aG5PcTN1T3lkdUNEc2xZZ2c2NUNvT2ljc0lGTjBjbWx1WnlobExtMWxjM05oWjJVcExuTnNhV05sS0RBc0lEZ3dLU2tLSUNBcE93cDlDZ292THlEc2k2VHRqS2dnN0oyUjY0dTE3SjJFSU95Q3JPdWVqT3lhcVNEc2xZanJnclRyb1p3ZzY3T0E3Wm1ZSU9LQWxDRHNtNURzbmJnbzY2R2M2cmU0N0oyNEwreUVwT3k1bUNuc25iUWc3WXlNN0pXRjY1Q2NJT3F5dmV5YXNPeVhsQ0RxdDdnZzdKV0k2NEswNjZXOExDRHNsWVRyaTRqcnFiUWc3S0NSNjVHUTdKYTBLK3lia091c3VPeWRoQ0RyczdUcmdyanJpNlFLWm5WdVkzUnBiMjRnWm5KcFpXNWtiSGxGDQpjbkp2Y2lobExDQndjbVZtYVhncElIc0tJQ0JwWmlBb1pTQW1KaUJsTG0xbGMzTmhaMlVnUFQwOUlFeFBSMGxPWDBkVlNVUkZLU0J5WlhSMWNtNGdleUJsY25KdmNqb2dURTlIU1U1ZlIxVkpSRVVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0Ykc5bmIzVjBKeUI5T3dvZ0lHbG1JQ2hsSUNZbUlHVXViV1Z6YzJGblpTQTlQVDBnVEVsTlNWUmZSMVZKUkVVcElISmxkSFZ5YmlCN0lHVnljbTl5T2lCTVNVMUpWRjlIVlVsRVJTd2djSEp2WW14bGJUb2dKMk5zWVhWa1pTMXNhVzFwZENjZ2ZUc0tJQ0JwWmlBb1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBblkyeGhkV1JsTFcxcGMzTnBibWNuS1NCN0NpQWdJQ0J5WlhSMWNtNGdleUJsY25KdmNqb2dKK3lkdENCUVEreVhrQ0JEYkdGMVpHVWdRMjlrWlNoamJHRjFaR1VwNnJDQUlPeUVwT3k1bU91UHZDRHNub2pzcDRBZzdKV0s3SldFN0pxVUlPS0FsQ0RzaEtUc3VaanRsWmpxczZBZzY2R2M2cmU0N0oyNDdaV2NJT3VTcENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95ag0Kdk95RXVPeWFsQzRuTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuSUgwN0NpQWdmUW9nSUhKbGRIVnliaUI3SUdWeWNtOXlPaUJ3Y21WbWFYZ2dLeUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQeUJsTG0xbGMzTmhaMlVnT2lCVGRISnBibWNvWlNrcElIMDdDbjBLQ21aMWJtTjBhVzl1SUhKbFlXUkNiMlI1S0hKbGNTa2dld29nSUhKbGRIVnliaUJ1WlhjZ1VISnZiV2x6WlNnb2NtVnpiMngyWlNrZ1BUNGdld29nSUNBZ2JHVjBJR0p2WkhrZ1BTQW5KenNLSUNBZ0lISmxjUzV2YmlnblpHRjBZU2NzSUNoaktTQTlQaUI3SUdKdlpIa2dLejBnWXpzZ2ZTazdDaUFnSUNCeVpYRXViMjRvSjJWdVpDY3NJQ2dwSUQwK0lIc0tJQ0FnSUNBZ2RISjVJSHNnY21WemIyeDJaU2hLVTA5T0xuQmhjbk5sS0dKdlpIa3BLVHNnZlNCallYUmphQ0FvWDJVcElIc2djbVZ6YjJ4MlpTaDdmU2s3SUgwS0lDQWdJSDBwT3dvZ0lIMHBPd3A5Q2dwamIyNXpkQ0JEVDFKVFgwaEZRVVJGVWxNZ1BTQjdDaUFnSjBGalkyVnoNCmN5MURiMjUwY205c0xVRnNiRzkzTFU5eWFXZHBiaWM2SUNjcUp5d0tJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFRXVjBhRzlrY3ljNklDZEhSVlFzSUZCUFUxUXNJRTlRVkVsUFRsTW5MQW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MUlaV0ZrWlhKekp6b2dKME52Ym5SbGJuUXRWSGx3WlNjc0NuMDdDbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3b2dJSEpsY3k1M2NtbDBaVWhsWVdRb2MzUmhkSFZ6TENCUFltcGxZM1F1WVhOemFXZHVLSHNnSjBOdmJuUmxiblF0Vkhsd1pTYzZJQ2RoY0hCc2FXTmhkR2x2Ymk5cWMyOXVPeUJqYUdGeWMyVjBQWFYwWmkwNEp5QjlMQ0JEVDFKVFgwaEZRVVJGVWxNcEtUc0tJQ0J5WlhNdVpXNWtLRXBUVDA0dWMzUnlhVzVuYVdaNUtHOWlhaWtwT3dwOUNncGpiMjV6ZENCelpYSjJaWElnUFNCb2RIUndMbU55WldGMFpWTmxjblpsY2loaGMzbHVZeUFvY21WeExDQnlaWE1wSUQwK0lIc0tJQ0JwWmlBb2NtVnhMbTFsDQpkR2h2WkNBOVBUMGdKMDlRVkVsUFRsTW5LU0I3SUhKbGN5NTNjbWwwWlVobFlXUW9NakEwTENCRFQxSlRYMGhGUVVSRlVsTXBPeUJ5WlhSMWNtNGdjbVZ6TG1WdVpDZ3BPeUI5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZEhSVlFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YUdWaGJIUm9KeWtnZXdvZ0lDQWdjbVZ6ZEdGeWRFbG1RV05qYjNWdWRFTm9ZVzVuWldRb0tUc2dMeThnNjdDVzdKZVE3SVNjSU9xemhPeWdsZXlkaENEcnNKVHF2Nmpzbkx6cnFiUWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuWVFnNjZpODdLQ0FJT3V5aE91bXNPdUxwQ0FvN0pXRTY1NllJT3liak91d2pleVhoZXlkdENEc21Kc2c2ck9FN0tDVjdKeTg2NkdjSU91UGpPeW5nQ0RzbFlycXNvd3BDaUFnSUNCeVpYUnllVUYxZEdoSlprNWxaV1JsWkNncE95QXZMeURyb1p6cXQ3anNuYmdnN1pXRTdKcVVJT3lEZ2UyRG5PdXB0Q0RzbnF6dG1aWHNuYmdnN0l1YzY0K0VJT0tBbENEc25xenJvWnpxdDdqc25ianNuYlFnNjRHZA0KNjRLczdKeTg2Nm0wSU91THBPeWRqQ0Rzb2JEdG1venJ0b0R0aExBZ2NISnZZbXhsYmV5ZHRDRHRrb0RycHJEcmk2UUtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdDaUFnSUNBZ0lHOXJPaUIwY25WbExDQmxibWRwYm1VNklDZGpiR0YxWkdVbkxDQjJPaUJDVWtsRVIwVmZWaXdnWkdseU9pQmZYMlJwY201aGJXVXNJQzh2SUhiQ3QyUnBjam9nNnJXczY3S0U3S0NFTCt5WGlldWFzZTJWbkNEc2dxenJzN2pzbmJRZzY1YWdJT3llaU91S2xPeW5nQ0RzcDRUcmk2anNtcWtLSUNBZ0lDQWdiVzlrWld3NklHTjFjbkpsYm5STmIyUmxiQ3dnYlc5a1pXeHpPaUJCVEV4UFYwVkVYMDFQUkVWTVV5d2daWGhoYlhCc1pYTTZJRVZZUVUxUVRFVlRMbXhsYm1kMGFDd2daM1ZwWkdVNklFZFZTVVJGTG14bGJtZDBhQ3dnY21WaFpIazZJSGRoY20xbFpGVndMQW9nSUNBZ0lDQndjbTlpYkdWdE9pQW9ZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQW5iMnNuSUh4OElHTnNZWFZrWlZOMFlYUjFjeUE5UFQwZ2JuVnMNCmJDa2dQeUJ1ZFd4c0lEb2dZMnhoZFdSbFUzUmhkSFZ6TEFvZ0lDQWdJQ0JoWTJOdmRXNTBPaUJqYkdGMVpHVkJZMk52ZFc1MEtDa3NDaUFnSUNBZ0lITmxjblpsWkRvZ2MzUmhkSE11YzJWeWRtVmtMQ0JzWVhOMFFYUTZJSE4wWVhSekxteGhjM1JCZEN3Z2JHRnpkRlJsZUhRNklITjBZWFJ6TG14aGMzUlVaWGgwTENCc1lYTjBVMlZqT2lCemRHRjBjeTVzWVhOMFUyVmpMQW9nSUNBZ2ZTazdDaUFnZlFvZ0lDOHZJTzJVak91ZnJPcTN1T3lkdUNEc2k2enNucVhyc0pYcmo1a2c0b0NVSU91Qml1cTRzT3VwdENEc25JUWc2ckNRN0l1Y0lPMkRnT3lkdE91b3VPcXdnQ0RyaTZUcnBxenJwYndnNjRHSTY0dWtDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMmhsWVhKMFltVmhkQ2NwSUhzS0lDQWdJR3hoYzNSQ1pXRjBJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPd29nDQpJSDBLSUNBdkx5RHJvWnpxdDdqc25iZ2c0b0NVSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGM0N0MXZ3bjVTUlhTRHJzb1R0aXJ6c25iUWc3Wmk0N0xhYzdaV2M2NHVrTGdvZ0lDOHZJT3E0c091enVDanJ1SXpybmJ6c21yRHNvSUFnN0tlQjdaYUpLVG9nWUdOc1lYVmtaU0JoZFhSb0lHeHZaMmx1SUMwdFkyeGhkV1JsWVdsZzY2VzhJT3lJcU95ZGdDRHRsSVRyb1p6c2hManNpcVRyb1p3ZzdJdWs3WmFKSU9LQWxDRHJxWlRyaWJRZzdKZUc3SjIwSU9xenAreWVwU0RydUl6cm5ienNtckRzb0lEcnBid2c3SmUwNnJPZ0xBb2dJQzh2SUNBZ2JHOWpZV3hvYjNOMElPeUltT3lMb0NEdGo2enRpcmpyb1p3ZzZyS3c2ck84NjZXOElPeWVrT3VQbVNEc2lKanJvTG50bFp6cmk2UW83SXVrN0xpaE9pRHRsNlRyazV6cnBxenNpcVRzbDVEc2hKenJqNFFnNjdpTTY1Mjg3SnF3N0tDQUlPeVh0T3VtdkNBcklFeEpVMVJGVGlEdG1aWHNuYmdzSURJdw0KTWpZdE1EY3BMZ29nSUM4dklDQWc3WVN3NjYrNDY0U1E3SjIwSU8yWmxPdXB0T3lYa0NEc29JVHRtSUFnN0pXSUlPdWNyT3VMcEM0ZzY3aU02NTI4N0pxdzdLQ0FJT3Vobk9xM3VPeWR1T3VuakNEdGxaanJxYlFnNjRHZExnb2dJQzh2SU8yUHRPdXdzU2p0aExEcnI3anJoSkFwT2lEc25wRHJqNWtnN0ptRTY2T002ckNBSU91bmllMmVqQ0R0bVpqcXNyMG82N2lNNjUyODdKcXc3S0NBNnJDQUlHeHZZMkZzYUc5emRPeVhrQ0RycXJzZzY0dS83SldFSU95OWxPdVRuT3F3Z0NEcnM3VHNuYlRyaXBRZzZySzk3SnF3S2V5WGtPeUVuQW9nSUM4dklDQWc2NkdjNnJlNDdKMjRJT3VNZ09xNHNDRHNwSkVnNjdLRTdZcTg3SjJFSU91WWtDRHJpSVRycGJUcnFiUXNJT3k5bE91VG5PdWx2Q0RydHBuc2w2enJoS1BzbllRZzdJaVlJT3llaU91S2xDRHRoTERycjdqcmhKQWc2N0NwN0l1ZDdKeTg2NkdjSU95Z2hPMlptTzJWbk91THBDNEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTENCmNtd2dQVDA5SUNjdmIzQmxiaTFzYjJkcGJpY3BJSHNLSUNBZ0lHTnZibk4wSUdKdlpIa2dQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3dvZ0lDQWdZMjl1YzNRZ2MzZHBkR05vVFc5a1pTQTlJQ0VoS0dKdlpIa2dKaVlnWW05a2VTNXpkMmwwWTJoQlkyTnZkVzUwS1RzZ0x5OGc2ck9FN0tDVklPeWdoTzJabUNBOUlPeUxuTzJCck91bXZ5RHNzTDNzbkx6cm9ad2c3SmUwN0phMElPcXpoT3lnbGV5ZGhDRHFzNkRycGJ3ZzdJaVlJT3llaU9xeWpBb2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ0x5OGdZMnhoZFdSbDZyQ0FJT3lYaHV5Y3ZPdXB0Q0RzbDZ6cXVMRHNoSndnNjRHSzY0cVU2NHVrTGlCemFHVnNiRHAwY25WbDY1MjhJR05zWVhWa1plcXdnQ0RzbDRic2xyVHJqNFFnN0lXNDdKMkFJT3lnbGV5RGdTRHNpNlR0bG9ucmo3d0tJQ0FnSUNBZ0x5OGdjM0JoZDI3c25aZ2dKMlZ5Y205eUorcXdnQ0RzbFlnZzY1eW82ck9nTENEc21JanNvSVRzbDVRZzZyZTQ2NHlBNjZHY0lHOXJPblJ5ZFdYcnBid2c2NCtNDQo2NkNrN0tTczY0dWtJT0tBbEFvZ0lDQWdJQ0F2THlEdGxJenJuNnpxdDdqc25ianNuWUFnSXV1NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUc2w0anNsclRzbXBRaTY1Mjg2ck9nSU8yVm1PdUtsT3VOc0NEc2k2VHNvSnpyb1p6cmlwUWc3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHJuS2pyaXBRZzdJT0I3WU9jNnJDQUlPdVFrT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLSUNBZ0lDQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjJOc1lYVmtaUzF0YVhOemFXNW5KeWtnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeExDQjdDaUFnSUNBZ0lDQWdJQ0JsY25KdmNqb2dKK3lkdENCUVEreVhrQ0JEYkdGMVpHVWdRMjlrWmVxd2dDRHNsNGJzbHJUc21wUWc0b0NVSU8yRXNPdXZ1T3VFa095WGtPeUVuQ0JqYkdGMVpHVWdMUzEyWlhKemFXOXVJT3lkdENEcmtKanJpcFRzcDRBZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNG5MQW9nSUNBZ0lDQWdJQ0FnY0hKdllteGxiVG9nSjJOcw0KWVhWa1pTMXRhWE56YVc1bkp5d0tJQ0FnSUNBZ0lDQjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQXZMeURzcDRUdGxva2c3S1NSN0oyNDY0MndJT3VZa0NEcmlJenJvSURyaTZRZzRvQ1VJT3lia095NW1leWRnQ0FpNjdpTTY1Mjg3SnF3N0tDQTY2R2NJT3VMcE95TG5DRHNsN1RxdUxBaTY0dWtMaUR0aExEcnI3anJoSkRzbllBZ0tpcnNzTDNzbllRZzdKV0U2NnkwNnJLRDY0K0VJT3VxdXlEcm5ZVHNtNkRzbllRZzY1V002NmVNS2lvdUNpQWdJQ0FnSUM4dklPeVlpT3lnaE95WGxDQW5OakRzdElnZzY0U1k2cktNSU91TWdPcTRzQ0RzcEpIc25iVHJxYlFnN1lTdzY2KzQ2NFNRSit5ZHRPeVhpT3VLbE91TnNDd2c2NkdjNnJlNDdKMjRJTzJabE91cHRPeWRoQ0RzbmIzcXNiRHJncGdnN0o2ZzZybVFJT3VVdENEc25id2c3WldZNjR1a0lPdUxwT3lMbkNEcmlJVHJwYmdLSUNBZ0lDQWdMeThnN0tDVjdJT0I3S0NCN0oyNElPcXl2ZXlhc095WGtPdVBoQ0JqYldRZzdMQzk3SjIwSU8yS2dPeVd0T3VDbU95WmxPdUwNCnBDZ3lNREkyTFRBNElPeUxwT3k0b1NEc2k2RHFzNkE2SUNMdGhMRHJyN2pyaEpBZzdabVU2Nm0wN0oyQUlPeVpuQ0RybHFBZzZyQ1I3SjZRNnJpd0lpa3VDaUFnSUNBZ0lDOHZJT3lkdE95Z25DRHNtckRycHF6cXNJQWc3TEM5N0oyRUlPeW5nZXlna1NEc2w3VHFzNkFnN0lTeDZyTzFJT3lYck91MmdDaHNiMmRwYmxkcGJtUnZkMDl3Wlc1bFpDbnJwYndnN0pXRTY0dUk2cm1NTENEc2k1enFzSVRzbmJRZzdKV0U2NHVJNjUyOElPcTN1Q0RzZ3F6c2k2VHJvWndnN1l5UTY0dW83WldjNjR1a0xnb2dJQ0FnSUNCamIyNXpkQ0J6ZEdGc1pTQTlJR3h2WjJsdVVISnZZeUFtSmlBaGJHOW5hVzVYYVc1a2IzZFBjR1Z1WldRZ0ppWWdLRVJoZEdVdWJtOTNLQ2tnTFNCc2IyZHBibE4wWVhKMFpXUkJkQ0ErSURJd01EQXdLVHNLSUNBZ0lDQWdhV1lnS0d4dloybHVVSEp2WXlBbUppQnpkR0ZzWlNrZ2V3b2dJQ0FnSUNBZ0lHdHBiR3hNYjJkcGJsQnliMk1vS1RzS0lDQWdJQ0FnSUNCcFppQW9JVzl3Wlc1TWIyZHBibFJsDQpjbTFwYm1Gc0tDa3BJSHNLSUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeExDQjdJR1Z5Y205eU9pQW43SjIwSUU5VDdKZVE3SVNnSU95ZWtPdVBtZXljdk91aG5DRHJxcnNnN0plMDdKYTA3SnFVSU9LQWxDRHRoTERycjdqcmhKRHNsNURzaEp3Z1kyeGhkV1JsSU95THBPMldpU0R0bTRRZ0wyeHZaMmx1SU8yVnRDRHNvN3pzaExqc21wUXVKeUI5S1RzS0lDQWdJQ0FnSUNCOUNpQWdJQ0FnSUNBZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDaHlaV0Z6YjI0ZzdLZUE3S0NWS1NEaWdKUWc3S2VFN1phSklPeWtrU0R0aExUc25ZUWdVMFZUVTBsUFRsOUVTVVZFNjZHY0lPdUJuZXVDdE91cHRDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtc091THBBb2dJQ0FnSUNBZ0lHdHBiR3hRY205aktDZnJvWnpxdDdqc25ianNuWVFnN0tlRTdaYUo3WldZNjRxVUlPeWtrZXlkdE91ZHZDRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bw0KN1phSTdKYTA3SnFVSU9LQWxDRHJvWnpxdDdqc25iZ2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcE93b2dJQ0FnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEdGo3VHJzTEVnNG9DVUlPMkVzT3V2dU91RWtDRHJzS25zaTUzc25MenJvWndnN0tDRTdabVlMaWNwT3dvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQW5kR1Z5YldsdVlXd25JSDBwT3dvZ0lDQWdJQ0I5Q2lBZ0lDQWdJQzh2SU91d3FlcTRpQ0RzaTV6c25wSHRsWndnNjZHYzZyZTQ3SjI0N0oyMElPeUN0T3lWaENEc25vanNuTHpycWJRZzdJYVE2NHlBN0tlQUlPeVZpdXVLbE91THBDRGlnSlFnN0tPOTdKMjA2Nm0wSU95Q3JPeWFxZXlla09xd2dDRHJzN1RxczZBZzdKNkk2NHFVSU8yRHJleWRtQ0Rzdlp6cnNMRWc3WStzN1lxNDZyQ0ENCkNpQWdJQ0FnSUM4dklPdUxxKzJZZ0NBaWJHOWpZV3hvYjNOMDdKZVE3SVNjSU95WHNPcXlzT3lkaENEcXNiRHJ0b0R0bG9qc2lyWHJpNGpyaTZRaTZyQ0FJT3Vjck91THBDZ3lNREkyTFRBNElPeUxwT3k0b1NEc2k2RHFzNkFwTGdvZ0lDQWdJQ0JwWmlBb2JHOW5hVzVRY205aklDWW1JRVJoZEdVdWJtOTNLQ2tnTFNCc2IyZHBibE4wWVhKMFpXUkJkQ0E4SURFMU1EQXdLU0I3Q2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHNzTDNzbmJRZzdKMjA2Nis0SU95WHRPdWdwQ0Rzbm9qc2xyVHNtcFFnNG9DVUlPeURpT3VobkNEc2w3VHNwNEFnN0pXSzZyT2dJT3EzdUNEc3NMM3NuWVFnN0pPdzdJUzQ3SnFVTGljcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCdGIyUmxPaUFuWVd4eVpXRmtlUzF2Y0dWdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lDOHZJT3lWDQpudXlFb0NEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjQ3SjIwSU91TWdPcTRzQ0RzcEpIc25iVHJxYlFnN0tDUjZyT2dJT3lEaU91aG5DRHNsN0RyaTZRZ0tPeXd2ZXlkaENEcmk2dnNsWmpxc2JEcmdwZ2c2NHVrN0l1Y0lPdUloT3VsdUNEcXNyM3NtckFwQ2lBZ0lDQWdJR3h2WjJsdVUzUmhjblJsWkVGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lDQWdiRzluYVc1WGFXNWtiM2RQY0dWdVpXUWdQU0JtWVd4elpUc2dMeThnN0oyMDY3S0lJT3lMbk91UGhPeWRtQ0Rzc0wwZzdKZTA2cml3SU95RXNlcXp0U0RzbDZ6cnRvQWc0b0NVSU95VmhPdWVtT3lYa095RW5DRHNoTGpzbXJUcmk2UUtJQ0FnSUNBZ0x5OGdRbEpQVjFORlV1dUtsQ0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a0lPS0FsQ0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHFzNkFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHNucERyajVrZzdJaVk2NkM1N1pXYzY0dWtDaUFnSUNBZw0KSUM4dklDanNuSVFnSit1aG5PcTN1T3lkdU95ZGdDQkRURW5xc0lBZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzcDRIc29KRWc3SmUwNnJLTUlPMlZuT3VMcENjZzdLTzg3SVNkSU9LQWxDRHFzSURyb1p6c3NZVHJxYlFnN0wyVTY1T2NJT3UybWV5WHJPdUVvK3E0c0NEdG1aVHJxYlRzbmJRZzY1eXM2NHVrS1M0S0lDQWdJQ0FnTHk4Z0tpcnFzNFRzb0pVZzdLQ0U3Wm1ZN0oyQUlPeWJ1U0Ryb1p6cXQ3anNsWVRzbTRQc25ZUWc2Nmk4N0tDQUlPeVhzT3VMcENvcUtESXdNall0TURnc0lFSlNTVVJIUlY5V1BUTXhLVG9nNjdpTTY1Mjg3SnF3N0tDQTdKZVFJT3lFdU95Rm1PeWR0Q0RyZ3Fqc2xZUWc3SjZJN0p5ODY2bTBDaUFnSUNBZ0lDOHZJR0YxZEdodmNtbDZaZXF3Z0NEcXM0VHNvSlhzbllRZzY2eTc3S2VBSU95Vml1cXpvQ0RzaXJuc25iZ2c3Wm1VNjZtMDY2ZU1JT3VkaE95YXRPdUxwQ2dpN0lxNTdKMjRJTzJabE91cHRDRHJwNURxczZBZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95Y3ZPdWgNCm5DRHFzSURxczZBZzdJdTI2NHVrSWlEc21wVHF0YXdwTGdvZ0lDQWdJQ0F2THlEc2hManNoWmpzbllRZzdLZUE3SnEwSU91U3BDRHNsN1RycWJRZzY2R2M2cmU0N0oyNElPMlpsT3VwdE91MmdPMkVzQ0RyZ3Bqc21LanJpNlFnNG9DVUlGVlNUT3lkaENEcXNJRHFzN1h0bFpqc3A0RHJqNFFvN0xLMDdKMjA2NHVkSU95THBPMk1xQ2tzSUVKU1QxZFRSVkxycGJ3ZzZyQ0E2NkdjN0xHRTdLZUE2NCtFQ2lBZ0lDQWdJQzh2SUNqc3ZaVHJrNXdnNjdhWjdKZXM2NFNqNnJpd0lPeWNvT3V3bkNrc0lPdTRqT3Vkdk95YXNPeWdnT3VsdkNEcXM2RHJwYlRzcDREcmo0UW82cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnQ0RzbFlUcmk1Z3BJT3lWaXV1S2xDRHNuS0RzbmJ6dGxad2c2N0NwNjdLVkxnb2dJQ0FnSUNBdkx5RHJ0b0RzbnBIc21xazZJT3U0ak91ZHZPeWFzT3lnZ095ZG1DQmpiR0YxWkdVZzdKdTVJT3Vobk9xM3VPeWR1T3VQaENEdGtvRHJwckRyaTZRZzRvQ1VJT3F6aE95Z2xleWRoQ0Ryc0pUcXZyanJvS1RyDQppcFFnN0oyWTY0K0U3Sm1BSU91d3FlMldwZXlkdENEcXNKbnNsWVFnN0lpWTdKcXBMZ29nSUNBZ0lDQmpiMjV6ZENCemRHRnlkRXh2WjJsdUlEMGdLQ2tnUFQ0Z2V3b2dJQ0FnSUNBZ0lHTnZibk4wSUhSb2FYTk1iMmRwYmlBOUlITndZWGR1S0NkamJHRjFaR1VuTENCYkoyRjFkR2duTENBbmJHOW5hVzRuTENBbkxTMWpiR0YxWkdWaGFTZGRMQ0I3Q2lBZ0lDQWdJQ0FnSUNCemFHVnNiRG9nZEhKMVpTd2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbExBb2dJQ0FnSUNBZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzSUM4dklHdHBiR3hNYjJkcGJsQnliMlBzblpnZzZyZTQ2Nk81SUd0cGJHenNtcWtnS0d0cGJHeFFjbTlqNnJPOElPdVBtZXlkdkNEdGpLanRoTFFwQ2lBZ0lDQWdJQ0FnZlNrN0NpQWdJQ0FnSUNBZ2JHOW5hVzVRY205aklEMGdkR2hwYzB4dloybHVPd29nSUNBZw0KSUNBZ0lHeHZaMmx1VjJsdVpHOTNUM0JsYm1Wa0lEMGdkSEoxWlRzZ0x5OGdRMHhKNnJDQUlPeVhyT3VLbENEcXNiUWc2clNBN0xDdzdaV2dJT3lJbUNEc2w0YnNuTHpyaTRnZzdKZTA2NmF3SU9xeWcreWN2T3VobkNEcnM3anJpNlFnS095ZXJPMkJ0T3VtcmV5WGtDRHRoTERycjdqcmhKQWc2N0NwN0tlQUtRb2dJQ0FnSUNBZ0lIUm9hWE5NYjJkcGJpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR2xtSUNoc2IyZHBibEJ5YjJNZ1BUMDlJSFJvYVhOTWIyZHBiaWtnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNnZlNrN0NpQWdJQ0FnSUNBZ2RHaHBjMHh2WjJsdUxtOXVLQ2RqYkc5elpTY3NJQ2hqYjJSbEtTQTlQaUI3Q2lBZ0lDQWdJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpJQ0U5UFNCMGFHbHpURzluYVc0cElISmxkSFZ5YmpzS0lDQWdJQ0FnSUNBZ0lHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0NpQWdJQ0FnSUNBZ0lDQnBaaUFvYkc5bmFXNVFjbTlqVkdsdFpYSXBJSHNnWTJ4bFlYSlVhVzFsYjNWMEtHeHYNCloybHVVSEp2WTFScGJXVnlLVHNnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J1ZFd4c095QjlDaUFnSUNBZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQU0F3T3lBdkx5RHNnNGdnNnJPRTdLQ1Y3SjI4SU95SW1DRHNub2pzbkx6cmk0Z2c2NHVrN0oyTUlDOW9aV0ZzZEdnZzY1V01JT3VMcE95TG5DRHNuYjNxdUxBS0lDQWdJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeWdpT3l3cUNEc29vWHJvNHdnS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93b2dJQ0FnSUNBZ0lDQWdMeThnN0lLczY1Nk03SjIwSU91aG5PcTN1T3lkdU8yVm9DRHNpNXpxc0lUcmo0UWc3SmVHN0oyMElPcXpwK3V3bE91aG5DRHNpNlR0aktqcm9ad2c2NEdkNjRLczY0dWtJRDBnWTJ4aGRXUmw2ckNBSU95WGh1cXhzT3VDbUNEc2k2VHRsb25zbmJRZzdKV0lJT3VRbkNEcXNvTXVDaUFnSUNBZ0lDQWdJQ0F2THlEc25aSHJpN1hzbllBZzdKMjA2Nis0DQpJT3V6dE91RGlPeWN2T3VMaUNEc2c0SHRnNXpycGJ3ZzY0dWs3SXVjSU95ZXJPeUVuQ0F2YUdWaGJIUm82NkdjSU95VmpPdW1zT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSU91TWdPcTRzQ0R0bVpUcnFiVHNuWVFnN0l1azdZeW82NkdjSU91d2xPcSt2T3VMcENrdUNpQWdJQ0FnSUNBZ0lDQnBaaUFvWTI5a1pTQWhQVDBnTUNBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQQ0ExTURBd0tTQjdDaUFnSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25ianNuYlFnN0thSjdJdWNJT3lMcE8yTXFPdWhuQ0RyZ1ozcmdxZ2c0b0NVSUVOc1lYVmtaU0JEYjJSbElPeUVwT3k1bUNEc2c0SHRnNXpycGJ3ZzY0dWs3SXVjSU95Z2tPcXlnTzJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJQ0FnSUNBZ0lDQWdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1RzS0lDQWdJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ0lDQjlLVHNLSUNBZ0lDQWdJQ0F2THlBeg0KTU91MmhDRGlnSlFnN0oyMElPMlVoT3Vobk95RXVPeUtwT3F3Z0NEc283M3NuTHpycWJRZzY3aU02NTI4N0pxdzdLQ0FJT3k5bk91d3NleWR0Q0Rxc0lnZ2JHOWpZV3hvYjNOMElPMlByTzJLdU91UGhDRHJpNnZ0bUlBZ0oreVhzT3F5c095ZGhDRHFzYkRydG9EdGxvanNpclhyaTRqcmk2UW42ckNBSU91Y3JPdUxwQzRLSUNBZ0lDQWdJQ0F2THlEc21JanNvSVFnTVREcnRvVHNuWUFnN0tlbjdKV0U3SVNjTENEcm9aenF0N2pzbmJqdGxaanJpNlFnN0o2ZzZybVFJT3VMcE91bHVDRHNuYnpzbllRZzdaV1k2Nm0wSU8yRHJleWR0Q0RyckxUdG1xanFzSUFnNjVDUTY0dWtLREl3TWpZdE1EZ2c3SXVrN0xpaElPeUxvT3F6b0NrdUNpQWdJQ0FnSUNBZ2JHOW5hVzVRY205alZHbHRaWElnUFNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhzZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0F6TU91MmhDRHFzcjNxczd3ZzRvQ1VJT3VNZ09xNHNDRHRsSVRyb1p6c2hManNpcVFnN0tDVjY2YXMNCkxpY3BPeUJyYVd4c1RHOW5hVzVRY205aktDazdJSDBzSURFNE1EQXdNREFwT3dvZ0lDQWdJQ0I5T3dvZ0lDQWdJQ0F2THlBcUt1cXpoT3lnbFNEc29JVHRtWmdnUFNEcm9aenF0N2pzbFlUc200TWdLeURydUl6cm5ienNtckRzb0lEc2w1QWc2NkdjNnJlNDdKMjRJTzJabE91cHRDb3FJQ2d5TURJMkxUQTRMQ0JDVWtsRVIwVmZWajB6Tml3ZzdJS3M3SnFwN0o2UUlPcXlzT3lnbFNrdUNpQWdJQ0FnSUM4dklPeUt1ZXlkdUNEdG1aVHJxYlRzbmJRZzY1eW82NHFVSU9xM3ZPdXp1Q0RzbTVEc25ianNuWUFnSXV1NGpPdWR2T3lhc095Z2dPeVhrQ0RzbUpzZzZyT0U3S0NWN0oyMElPdWhuT3EzdU95ZHVPdVB2Q0Rzbm9qcmk2UWk2NHFVSU9xeWcreWR0T3V2Z091aG5Dd2c3S0NFN1ptWTdKMllJT3l5cXlEcmo1bnNucEhzbllBS0lDQWdJQ0FnTHk4ZzY2R2M2cmU0N0oyNDdKMjBJT3lWaE91TGlPdWR2Q0FxS3V1aG5PcTN1T3lWaE95Ymd5b3E3SjIwN0phMDdKVzhJT3VubnV1THBDNGc2cmU0NjU2WTdJU2NJT3lYDQpyT3E0c095RW5PdUtsQ0Ryb1p6cXQ3anNuYmpzbllRZzdJdWM3SjZSN1pXWTdLZUFJT3lWaXV1S2xPdUxwRG9LSUNBZ0lDQWdMeThnSUNEaWthQWdRMHhKSU91aG5PcTN1T3lWaE95Ymd5aGpiR0YxWkdVZ1lYVjBhQ0JzYjJkdmRYUXBJT0tBbENEc21Kc2c3SjZRNnJLcDdLYWQ2NnFGd3Jmc2hManNoWmdnN1krUTZyaXdDaUFnSUNBZ0lDOHZJQ0FnNHBHaElPdTRqT3Vkdk95YXNPeWdnQ0RzbTdrZzY2R2M2cmU0N0pXRTdKdURJT3lYdE9xNHNDRGlnSlFnWTJ4aGRXUmxMbUZwTDJ4dloyOTFkT3lkZ0NEcm9aenF0N2pzbFlUc200TWc3WnVFSUNvcTY2R2M2cmU0N0oyNElPMlpsT3VwdE95Y3ZPdWhuQ0Rzc0tuc3A0QXFLdTJWbk91THBDanRnNjBnTWVxd25Da0tJQ0FnSUNBZ0x5OGc2NkdjNnJlNDdKV0U3SnVEN0oyMElPdUJuZXVDbU91cHRDRHFzNmZyc0pUcm9ad2dRMHhKSU91aG5PcTN1T3lkdU9xNWpPeW5nQ0RzbmJUc2xyVHNoSndnN0l1YzdKNlI3WldjNjR1a0lPS0FsQ0RzaExqc2haanNuYlFnNjdtRQ0KN0p1TTdLZUVJT3VTcE91ZHZDRHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPeVZoT3VMaU91ZHZBb2dJQ0FnSUNBdkx5RHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKMjBJT3VDbU95WXFPdUxwQzRnN1lHMDY2YXRJTzJWbkNEcnNvanNuTHpyb1p3Z0l1dWhuT3EzdU95VmhPeWJneURpaHBJZzdJT0lJT3F6aE95Z2xTRHJvWnpxdDdqc25iZ2k3SjIwSU91Qm5ldUNuT3VMcEM0S0lDQWdJQ0FnYVdZZ0tITjNhWFJqYUUxdlpHVXBJSHNLSUNBZ0lDQWdJQ0JyYVd4c1RHOW5hVzVRY205aktDazdJQzh2SU91TWdPcTRzQ0RzcEpIc25iZ2c3SmliSU91aG5PcTN1T3lkdUNEc29JanNzS2pxc0lBZzdKNkk3Snk4NjZtMElPeWdrZXVLbE91THBBb2dJQ0FnSUNBZ0lHTnZibk4wSUd4dklEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25ZWFYwYUNjc0lDZHNiMmR2ZFhRblhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc0tJQ0FnSUNBZ0lDQnMNCmJ5NXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJQzhxSUdOc1lYVmtaU0RzbDRic25Zd2c2NU94SU9LQWxDRHNsWVRybnBnZzdKdTVJT3Vobk9xM3VPeVZoT3liZyt5ZGdDRHF0N2pyaklEcm9ad2c3S2VFN1phSklDb3ZJSDBwT3dvZ0lDQWdJQ0FnSUd4dkxtOXVLQ2RqYkc5elpTY3NJQ2hqYjJSbEtTQTlQaUI3Q2lBZ0lDQWdJQ0FnSUNCcmFXeHNVSEp2WXlnbjZyT0U3S0NWN0oyRUlPdXdsT3ErdU91Z3BPcXpvQ0Ryb1p6cXQ3anNsWVRzbTRQdGxiVHNoSndnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQzRuS1RzZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDQW83SjZRNjQrWklPeWVyT3lMbk91UGhDRHJzS25zcDRBcENpQWdJQ0FnSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPeUF2THlEcmk2VHNuWXdnN0tHdzdacU03SmVRN0lTY0lDZnFzNFRzb0pVZzdKZUc3SjJNSit5Y3ZPdWhuQ0RzbmIzdG5vanFzb3dLSUNBZ0lDQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxDQpiR3c3SUM4dklPeURnZTJEbkNEc25xenRqSkRzb0pVS0lDQWdJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RxczRUc29KVWc3S0NFN1ptWUlPS0FsQ0JEVEVrZzY2R2M2cmU0N0pXRTdKdURJQ2hqYjJSbElDY2dLeUJqYjJSbElDc2dKeWtuS1RzS0lDQWdJQ0FnSUNCOUtUc0tJQ0FnSUNBZ0lDQmpiMjV6ZENCdmNHVnVaV1FnUFNCdmNHVnVWWEpzU1c1RVpXWmhkV3gwUW5KdmQzTmxjaWhYUlVKZlRFOUhUMVZVWDFWU1RDazdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU9xemhPeWdsU0Rzb0lUdG1aZ2c0b0NVSU95YnVTRHJvWnpxdDdqc2xZVHNtNFBzbllRZzdKZTA3SmVJN0phMDdKcVVKd29nSUNBZ0lDQWdJQ0FnS3lBb2IzQmxibVZrSUQ4Z0p5Y2dPaUFuSUNqcnVJenJuYnpzbXJEc29JQWc3SmUwNnJpd0lPeUxwTzJNcUNEaWdKUWdKeUFySUZkRlFsOU1UMGRQVlZSZlZWSk1JQ3NnSnlEcm9ad2c3S2VCN0tDUklPeWdrZXlHamUyVnRDRHNvN3pzaExqcw0KbXBRcEp5a2dLeUFuTGljcE93b2dJQ0FnSUNBZ0lDOHZJQ29xNjZHYzZyZTQ3SldFN0p1RDY2ZU1JTzJWbU9xem9DRHJnWjNyZ3JUcnFiUWc3SldJSU91UW5PdUxwQ29xSUNneU1ESTJMVEE0TENCQ1VrbEVSMFZmVmowek9DazZJT3Vobk9xM3VPeVZoT3liZ3lEdG1aVHJxYlRzbDVEc2hKd2c3SnU1SU91aG5PcTN1T3lkdU95ZGhDRHRsYlRyajRRS0lDQWdJQ0FnSUNBdkx5QkRURWtnVDBGMWRHanFzSUFnN0l1YzdKNlI2NUNZN0tlQUlPeVZpdXlWaENEdGxJenJuNnpxdDdqc25ianNuWUFnN0pldzZyS3c2NUNZN0tlQUlPeVZpdXVLbE91THBDNGc3SUtzN0pxcDdKNlE2NHFVSUNMcm9aenF0N2pzbmJqdGxvanJpcFRyamJBZzdKbWNJT3lWaUNEcmtKanJnNUFpNnJDQUlPdVFtT3F6b0N3S0lDQWdJQ0FnSUNBdkx5RHNtSnNnN1lPdDdKMjBJT3VDcU95VmhDRHNub2pzbkx6cnFiUWc3S085N0oyQUlPMlByTzJLdU91aG5DRHN2Wnpyc0xIc25iUWc2ckNBN0lTY0lDSnNiMk5oYkdodmMzVHNsNURzaEp3ZzdKZXcNCjZyS3c3SjJFSU9xeHNPdTJnTzJXaU95S3RldUxpT3VMcENMcXVZenNwNEFnNjV5czY0dWtLT3lMcE95NG9Ta3VDaUFnSUNBZ0lDQWdMeThnNnJlNDY1Nlk3SVNjSU91aG5PcTN1T3lWaE95YmcreWR0Q0Rzc3BqcnBxenJrS0FnN0l1YzZyQ0U3SjJFSU95a2dDRHJrcVFnS2lwRFRFa2c2NkdjNnJlNDdKMjQ2cm1NN0tlQUlPeWR0T3lXdE95RW5DRHNpNXpzbnBIdGxaenJpNlFxS2lEaWdKUWc3SVM0N0lXWTdKMjBJT3U1aE95YmpPeW5oQ0Rya3FUcm5id0tJQ0FnSUNBZ0lDQXZMeURzaXJuc25iZ2c3Wm1VNjZtMDdKMjBJT3lWaE91TGlPdWR2Q0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA3SjIwSU91Q21PeVlxT3VMcEM0ZzdZT3Q3SjJBSURMcXNKd282NkdjNnJlNDdKV0U3SnVESU95VmlPdUN0Q0FySU91aG5PcTN1T3lkdUNuc3A0RHJwNHdnN1lHMDY2YXRJTzJWbkNEcnNvanNuTHpyb1p3ZzY0R2Q2NEtjNjR1a0xnb2dJQ0FnSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V5QnBaaUFvSVd4dloybHVVSEp2DQpZeWtnYzNSaGNuUk1iMmRwYmlncE95QjlMQ0JNVDBkUFZWUmZVMFZVVkV4RlgwMVRLVHNLSUNBZ0lDQWdJQ0JzYjJkcGJsTjBZWEowWldSQmRDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJRzF2WkdVNklDZGljbTkzYzJWeUxYTjNhWFJqYUNjZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ0x5OGc2NmVNNjZPTUlPeWVyT3Vobk9xM3VPeWR1Q0RpZ0pRZzZyQ1o3SjJBSU9xemhPeWdsZXlkdE91ZHZDRHNoTGpzaFpqc25ZUWc3S2VBN0pxdzdLZUFJT3lWaXVxem9DRHF0N2pyaklEcm9ad2c3SmV3NjR1a0tPdTVvT3VsdE91THBDa0tJQ0FnSUNBZ2MzUmhjblJNYjJkcGJpZ3BPd29nSUNBZ0lDQXZMeURyZ3FIc25ZQWc3SjZGN0o2bDZyYU03SjJFSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NHlBNnJpd0lPeUV1T3lGbU95ZGdDRHJzb1RycHJEcmk2UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdKMk1JT3lhbE95eQ0KcmV5ZHRDRHNnNGdnN0lTNDdJV1lLT3lEaUNEc25vWHNucVhxdG93cDdKeTg2NkdjSU95TG5PeWVrZTJWbU9xeWpDNEtJQ0FnSUNBZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDaHlaV0Z6YjI0ZzdLZUE3S0NWS1NEaWdKUWdVMFZUVTBsUFRsOUVTVVZFNjZHY0lPdUJuZXVDdE91cHRDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3VncEFvZ0lDQWdJQ0F2THlEc25xenJvWnpxdDdqc25iZ2c2NUtrN0plUTY0K0VJRTFCV0Y5VVZWSk9VK3E1ak95bmdDRHNtSnNnNnJPRTdLQ1Y3Snk4NjZHY0lPeXltT3Vtck91UW1PdUtsQ0Ryc29UcXQ3anFzSUFnNjVDYzY0dWtJQ2d5TURJMkxUQTNJT3Vtck91M3NPeVhrT3lFbkNEdG1aWHNuYmdwQ2lBZ0lDQWdJR3RwYkd4UWNtOWpLQ2Zyb1p6cXQ3anNuYmpzbllRZzdLZUU3WmFKN1pXWTY0cVVJT3lra2V5ZHRPdWR2Q0RzbXBUc3NxM3NuWVFnN0tTUjY0dW83WmFJN0phMDdKcVVJT0tBbENEcm9aenENCnQ3anNuYmdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3BPd29nSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPd29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFbklDc2dLSE4zYVhSamFFMXZaR1VnUHlBbklDanFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDRHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPdWNxT3VwdENEcXQ3Z2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjNzbkx6cm9ad2c2NHVrNjZXNElPcXpoT3lnbGV5ZGhDRHFzNkRycGJ3ZzdJaVlJT3llaU95V3RPeWFsQ2tuSURvZ0p5Y3BJQ3NnSnlEaWdKUWc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeWVrT3VQbVNEc2w3RHFzckRya0tucmk0anJpNlF1SnlrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQnpkMmwwWTJoTmIyUmxJRDhnDQpKMkp5YjNkelpYSXRjM2RwZEdOb0p5QTZJQ2RpY205M2MyVnlKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2daWEp5YjNJNklDZnJvWnpxdDdqc25iZ2c3TEM5N0oyRUlPdXF1eURzbDdUc2w0anNsclRzbXBRNklDY2dLeUJsTG0xbGMzTmhaMlVnZlNrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SUNqdGhMRHJyN2pyaEpBZzdZKzA2N0N4SU9xMXJPMlloT3UyZ0NEaWdKUWc2N2lNNjUyODdKcXc3S0NBSU95ZWtPdVBtU0RzbVlUcm80enFzSUFnN0pXSUlPdVFtT3VLbENEdG1aanFzcjBnN0tDRTdKcXBLUW9nSUdaMWJtTjBhVzl1SUc5d1pXNU1iMmRwYmxSbGNtMXBibUZzS0NrZ2V3b2dJQ0FnZXdvZ0lDQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ0lDQWdJQzh2SUhOMFlYSjA2ckNBSU95RGlDRHN2WmpzaHBRZzdMQzk3SjJFSU91bmpPdVRvT3VMcENBbzY0dWs2NmFzN0oyWQ0KSU95SXFPeWRnQ0Rzdlpqc2hwVHFzN3dnNjZ5MDZyU0E3WldZNnJLTUlPeUNyT3lhcWV5ZWtPeVhrT3F5akNEcnM3VHNub1FwTGdvZ0lDQWdJQ0FnSUM4dklPeWR0T3lXdE95RW5DQlFiM2RsY2xOb1pXeHNLQzV3Y3pFcDdKMjBJRFhzdElnZzY1S2tJT3EzdUNEc3NMM3NsNUFnN0plVTdZU3c2Nlc4SU91enRPdUN0Q0F4NjdLSUtPcTFyT3VQaFNEcXM0VHNvSlVwN0oyRUlPeWVrT3VQbVNEc2hLRHRnNTN0bFpqcXM2QXNDaUFnSUNBZ0lDQWdMeThnN0xDOTdKMkVJT3kxbk95R2pPMlpsTzJWdENEc2dxenNtcW5zbnBBZzY0aUk3SmVVSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianJwNHdnNjRLbzZyS01JTzJWbk91THBDNGc3TEM5N0oyRUlPdXF1eURzc0w3c25MenJxYlFnN0pXRTY2eTA2cktENjQrRUlPeVZpQ0R0bFp6cmk2UUtJQ0FnSUNBZ0lDQXZMeUFvNjR1azY2VzRJT3l3dlNEc21LVHNub1hyb0tVZzY3Q3A3S2VBSU9LQWxDRHF0N2dnNnJLOTdKcXdJT3VwbE91SnRPcXdnQ0RyczdUc25iVHINCmlwUWc3TEdFNjZHY0lPdUNxT3F6b0NEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFxQ2t1Q2lBZ0lDQWdJQ0FnTHk4ZzdLTzg3SjJZT2lCamJHRjFaR1hxc0lBZzdMMlk3SWFVSU95Z25PdXFxZXlkaENEcnNKVHF2cmpycWJRZ1FYQndRV04wYVhaaGRHVXZSbWx1WkZkcGJtUnZkK3F3Z0NEcnFyc2c3TEMrN0oyRUlPeUltQ0Rzbm9qc25Zd2c0b0NVSU95Y2lPdVBoT3lhc0NEc2k2VHF1TERzbDVEc2hKd2c3Wm1WN0oyNElPMlZoT3lhbEM0S0lDQWdJQ0FnSUNCamIyNXpkQ0J3Y3pFZ1BTQndZWFJvTG1wdmFXNG9iM011ZEcxd1pHbHlLQ2tzSUNkamJHRjFaR1V0WW5KcFpHZGxMV3h2WjJsdUxuQnpNU2NwT3dvZ0lDQWdJQ0FnSUdaekxuZHlhWFJsUm1sc1pWTjVibU1vY0hNeExDQmJDaUFnSUNBZ0lDQWdJQ0FuVTNSaGNuUXRVMnhsWlhBZ0xWTmxZMjl1WkhNZ05TY3NDaUFnSUNBZ0lDQWdJQ0FuSkhkeklEMGdUbVYzTFU5aWFtVmpkQ0F0UTI5dFQySnFaV04wDQpJRmRUWTNKcGNIUXVVMmhsYkd3bkxBb2dJQ0FnSUNBZ0lDQWdJbWxtSUNna2QzTXVRWEJ3UVdOMGFYWmhkR1VvSjJOc1lYVmtaUzFzYjJkcGJpY3BLU0I3SWl3S0lDQWdJQ0FnSUNBZ0lDSWdJQ1IzY3k1VFpXNWtTMlY1Y3lnbmZpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lGTjBZWEowTFZOc1pXVndJQzFUWldOdmJtUnpJREluTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdRV1JrTFZSNWNHVWdMVTVoYldWemNHRmpaU0JWSUMxT1lXMWxJRmNnTFUxbGJXSmxja1JsWm1sdWFYUnBiMjRnSjF0RWJHeEpiWEJ2Y25Rb1hDSjFjMlZ5TXpJdVpHeHNYQ0lwWFNCd2RXSnNhV01nYzNSaGRHbGpJR1Y0ZEdWeWJpQlRlWE4wWlcwdVNXNTBVSFJ5SUVacGJtUlhhVzVrYjNjb2MzUnlhVzVuSUdNc0lITjBjbWx1WnlCMEtUc2dXMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUdKdmIyd2dVMmh2ZDFkcGJtUnZkeWhUZVhOMFpXMHVTVzUwVUhSeUlHZ3NJR2x1ZENCdQ0KS1Rzbklpd0tJQ0FnSUNBZ0lDQWdJQ0lnSUNSb0lEMGdXMVV1VjEwNk9rWnBibVJYYVc1a2IzY29XMDUxYkd4VGRISnBibWRkT2pwV1lXeDFaU3dnSjJOc1lYVmtaUzFzYjJkcGJpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lHbG1JQ2drYUNBdGJtVWdXMU41YzNSbGJTNUpiblJRZEhKZE9qcGFaWEp2S1NCN0lGdDJiMmxrWFZ0VkxsZGRPanBUYUc5M1YybHVaRzkzS0NSb0xDQTJLU0I5Snl3Z0x5OGdOaUE5SUZOWFgwMUpUa2xOU1ZwRkNpQWdJQ0FnSUNBZ0lDQW5mU2NzQ2lBZ0lDQWdJQ0FnWFM1cWIybHVLQ2RjY2x4dUp5a2dLeUFuWEhKY2JpY3BPd29nSUNBZ0lDQWdJR052Ym5OMElHSmhkQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdGJHOW5hVzR1WW1GMEp5azdDaUFnSUNBZ0lDQWdabk11ZDNKcGRHVkdhV3hsVTNsdVl5aGlZWFFzSUNkQVpXTm9ieUJ2Wm1aY2NseHVKeUFyQ2lBZ0lDQWdJQ0FnSUNBbmMzUmhjblFnSW1Oc1lYVmtaUzFzYjJkcGJpSWcNClkyMWtJQzlySUdOc1lYVmtaU0F2Ykc5bmFXNWNjbHh1SnlBckNpQWdJQ0FnSUNBZ0lDQW5jRzkzWlhKemFHVnNiQ0F0VG05UWNtOW1hV3hsSUMxRmVHVmpkWFJwYjI1UWIyeHBZM2tnUW5sd1lYTnpJQzFHYVd4bElDSW5JQ3NnY0hNeElDc2dKeUpjY2x4dUp5azdDaUFnSUNBZ0lDQWdjM0JoZDI0b0oyTnRaQ2NzSUZzbkwyTW5MQ0JpWVhSZExDQjdJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd2djM1JrYVc4NklDZHBaMjV2Y21VbkxDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNLSUNBZ0lDQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBblpHRnlkMmx1SnlrZ2V3b2dJQ0FnSUNBZ0lDOHZJSEIwZVNobGVIQmxZM1FwNjZHY0lPdXp0T3VDdUNEdGdxVHNsNUFnN1lHMDY2R2M2NU9jSUZSVlNlcXdnQ0RyckxUcnNKanNuWkhzbmJnZzZyS0Q3SjIwSU95THBPeTRvU0R0bVpYc25ianJrS2dvTWpBeU5pMHdOeXdnN0oyODY3Q1lJRnh5d3JkcmFYUjBlU0RzdlpUcms1d2c2NnFvDQo2NUdRS1NEaWdKUUtJQ0FnSUNBZ0lDQXZMeURzbktEc25ienRsWndnN0o2UTY0K1o3Wm1VSU9xeXZldWhuT3VLbENCVGVYTjBaVzBnUlhabGJuUno3SjJZSU95bmhPeW5uQ0R0Z3FRZzdKNkY2NkNsTGlEc29KSHF0N3pzaExFZzZyYU03WldjN0oyMElPeWVpT3ljdk91cHRDQTI3TFNJSU91U3BDRHNsNVR0aExEcXNJQWc3SjZRNjQrWklPeWVoZXVncGV1UHZBb2dJQ0FnSUNBZ0lDOHZJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbmJRZzdJU2c3WU9kNjVDWTZyT2dMQ0RxdG96dGxaenNuYlFnN0plRzdKeTg2Nm0wSUd0bGVYTjBjbTlyWlNEc3BJVHJwNHdnN0tHdzdKcXA3WjZJSU95THBPMk1xTzJWdENEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFuT3VMcENobVlXbHNMWE52Wm5RcExnb2dJQ0FnSUNBZ0lDOHZJT3lYbE8yRXNDRHNwNEhzb0lUc2w1QWdWR1Z5YldsdVlXenNuWVFnNjR1azdJdWNJT3lWbnV5Y3ZPdWhuQ0Rxc0lEc29ManNtWUFnNjR1aw0KNjZXNElPeVZzZXlYa0NEdGdxVHFzSUFnNjVPazdKYTA2ckNBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpQWdJQ0FnSUNBZ2MzQmhkMjRvSjI5ellYTmpjbWx3ZENjc0lGc0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWkc4Z2MyTnlhWEIwSUNKamJHRjFaR1VnTDJ4dloybHVJaWNzQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHRmpkR2wyWVhSbEp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZGtaV3hoZVNBMkp5d0tJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnWVdOMGFYWmhkR1VuTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjJSbGJHRjVJREF1TXljc0NpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBbmRHVnNiQ0JoY0hCc2FXTmhkR2x2YmlBaVUzbHpkR1Z0SUVWMlpXNTBjeUlnZEc4Z2EyVjUNCmMzUnliMnRsSUhKbGRIVnliaWNzQ2lBZ0lDQWdJQ0FnSUNBdkx5RHNsNVR0aExEcXNJQWc3SXVrN0tDYzY2R2NJT3VUcE95V3RPcXdoQ0Rxc3Izc21yRHNsNURycDR3ZzdKZXM2cml3SU91UGhPdUxyQ2pxdG96dGxad2c3SmVHN0p5ODY2bTBJT3ljaE95WGtPeUVuQ0RzcEpIcmk2Z3BJT0tBbENEdGhMRHJyN2pyaEpEc25ZUWc3TG1ZN0p1TUlPdTRqT3Vkdk95YXNPeWdnT3VuakNEcmdxanF1TFRyaTZRS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0F4TGpVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJ6WlhRZ2JXbHVhV0YwZFhKcGVtVmtJRzltSUdaeWIyNTBJSGRwYm1SdmR5QjBieUIwY25WbEp5d0tJQ0FnSUNBZ0lDQmRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJQ0FnZlNCbGJITmxJSHNLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdabUZzYzJVN0lDOHZJT3luZ095YmtDRHNsWWdnN1pXWTY0cVVJRTlUDQpDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2NtVjBkWEp1SUhSeWRXVTdDaUFnSUNCOUNpQWdmUW9nSUM4dklPMkJ0T3Vobk91VG5DRHFzNFRzb0pVZzY2R2M2cmU0N0pXRTdKdURJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3Wm1JN0oyWUlGdnJvWnpxdDdqc2xZVHNtNE5kSU91eWhPMkt2T3lkdENEdG1ManN0cHd1SUdOc1lYVmtaU0JoZFhSb0lHeHZaMjkxZE95Y3ZPdWhuQ0JEVEVrZzY2R2M2cmU0N0oyNDdKMkVJTzJWdE95Z25PMlZuT3VMcEM0S0lDQXZMeUFvN0oyMElGQkQ3SjJZSU95Z2dPeWVwZXVRbkNEc25wRHFzcW5zcHAzcnFvWHNuWVFnN0tlQTdKcTA2NHVrSU9LQWxDRHJpNlRzaTV3ZzdKT3c2NkNrNjZtMElPeWVyT3Vobk9xM3VPeWR1Q0R0bFlUc21wUXVLU0Ryb1p6cXQ3anNsWVRzbTRNZzdadUU3SmVVSU95RXVPeUZtTUszNnJPRTdLQ1Y3THFRN0l1YzY2VzhJT3lnbGV1bXJPMlZuT3VMcEM0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdg0KWTJ4aGRXUmxMV3h2WjI5MWRDY3BJSHNLSUNBZ0lHTnZibk4wSUd4dklEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25ZWFYwYUNjc0lDZHNiMmR2ZFhRblhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc0tJQ0FnSUd4bGRDQmxjbklnUFNBbkp6c0tJQ0FnSUd4dkxuTjBaR1Z5Y2k1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0lHVnljaUFyUFNCa0xuUnZVM1J5YVc1bktDazdJSDBwT3dvZ0lDQWdiRzh1YjI0b0oyVnljbTl5Snl3Z0tHVXBJRDArSUhzZ2FuTnZiaWh5WlhNc0lEVXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lHVnljbTl5T2lBbjY2R2M2cmU0N0pXRTdKdURJT3lMcE8yV2lTRHNpNlR0aktnNklDY2dLeUJsTG0xbGMzTmhaMlVnZlNrN0lIMHBPd29nSUNBZ2JHOHViMjRvSjJOc2IzTmxKeXdnS0dOdlpHVXBJRDArSUhzS0lDQWdJQ0FnYTJsc2JGQnliMk1vSit1aG5PcTN1T3lWaE95YmcrMlZ0T3lFbkNEc21wVHMNCnNxM3NuWVFnN0tTUjY0dW83WmFJN0phMDdKcVVMaWNwT3lBdkx5RHNuWmpyajRUc29JRWc3S0tGNjZPTUlPS0FsQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95RXVPeUZtT3lkaENEcmtKanNnclRycHF6cnFiUWc3SldJSU91UXFBb2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QWdJQ0FnSUNBZ0x5OGc2NHVrN0oyTUlDOWhZMk52ZFc1MHdyY3ZhR1ZoYkhSbzdKZVE3SVNjSU9xemhPeWdsZXlkaENEc2c0anJvWndvUGV5WGh1eWRqT3ljdk91aG5Da2c3SjI5NnJLTUNpQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0lDQWdJQ0FnSUNBdkx5RHNnNEh0ZzV3ZzdKNnM3WXlRN0tDVktPdUxwT3lkakNEdGhMVHNsNURzaEp3ZzY2KzQ2NkdjNnJlNDdKMjRJT3F3a095bmdDa0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNsWVRzbTRNZ0tHTnZaR1VnSnlBcklHTnZaR1VnS3lBbktTY3BPd29nSUNBZ0lDQnBaaUFvDQpjbVZ6TG1obFlXUmxjbk5UWlc1MEtTQnlaWFIxY200N0lDOHZJR1Z5Y205eUlPMlZ1T3VUcE91ZnJPcXdnQ0RzbmJUcnI3Z2c3SjJSNjR1MTdaYUk3Snk4NjZtMElPeWtrZXV6dFNEcnNLbnNwNEFLSUNBZ0lDQWdhV1lnS0dOdlpHVWdQVDA5SURBcElHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdDaUFnSUNBZ0lHVnNjMlVnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUdWeWNtOXlPaUFvWlhKeUxuUnlhVzBvS1M1emJHbGpaU2d3TENBeE5UQXBLU0I4ZkNBb0oreWloZXVqakNEc3ZaVHJrNXdnSnlBcklHTnZaR1VwSUgwcE93b2dJQ0FnZlNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lDOHZJT3lla09xNHNDRHNvb1hybzR3ZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNCVFZFOVFYMEpTU1VSSFJTL3RsWmp0aXJqcnVZVHRpcmpxc0lBZzdaaTQ3TGFjN1pXYzY0dWtJQ2pyb1p6c3U2enNsNURzaEp6cnA0d2c3S0NSNnJlOElPcXdnT3VLcGUyVm1PdUxpQ0RzbFlqcw0Kb0lRcENpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dld29nSUNBZ2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlNCOUtUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvb1hybzR3ZzdKcVU3TEt0SU91d20reWRqQ0RpZ0pRZzY0dWs2NmFzNjZXOElPdUJsZXVMaU91THBDNG5LVHNLSUNBZ0lITm9kWFIwYVc1blJHOTNiaUE5SUhSeWRXVTdDaUFnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJREl3TUNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5eVpXTnZiVzFsYm1RbktTQjdDaUFnSUNCamIyNXpkQ0I3SUhSbGVIUXNJRzF2WkdWc0xDQnliMnhsSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXANCk93b2dJQ0FnYVdZZ0tDRjBaWGgwSUh4OElDRlRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BLU0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TUN3Z2V5Qmxjbkp2Y2pvZ0oreTJsT3l5bk91d20reWRoQ0RyckxqcXRhenFzSUFnNjdtRTdKYTBJT3llaU95S3RldUxpT3VMcEM0bklIMHBPd29nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdMYVU3TEtjSU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnl3Z2NtOXNaU0EvSUNkYkp5QXJJSEp2YkdVZ0t5QW5YU2NnT2lBbkp5d2diVzlrWld3Z1B5QW5LT3VxcU91TnVEb2dKeUFySUcxdlpHVnNJQ3NnSnlrbklEb2dKeWNwT3dvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnWTI5dWMzUWdjaUE5SUdGM1lXbDBJR0Z6YTBOc1lYVmtaU2hUZEhKcGJtY29kR1Y0ZENrdWRISnBiU2dwDQpMQ0J0YjJSbGJDd2dleUJ3WVhKelpUb2djR0Z5YzJWVGRXZG5aWE4wYVc5dWN5d2dabTl5YldGMFJHVnpZem9nSjF0N0luUmxlSFFpT2lBaTY2eTQ2cldzSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBaWZTd2dMaTR1WFNjZ2ZTd2djbTlzWlNrN0NpQWdJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ2NpNXdZWEp6WldRZ2ZId2dXMTA3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c2xZZ2dKeUFySUhOMQ0KWjJkbGMzUnBiMjV6TG14bGJtZDBhQ0FySUNmcXNKd2dLQ2NnS3lCelpXTWdLeUFuY3lrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0F6TUNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJSE4xWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93b2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUNmdGdiVHINCm9aenJrNXdnN1ppNDdMYWNJT3lMcE8yTXFEb2dKeWtwT3dvZ0lDQWdmUW9nSUgwS0lDQXZMeUR0bElUcm9JanNub1RyczRRZzdMYVU3TEtjSU9LQWxDRHRsWndnN1ptVTY2bTA3SjJFSU8yVm1PeWNoQ0R0bElUcm9JanNub1FvN0ppQjdKZXRLU0RyaTZqc25JVHJvWndnNjRLWTY0aWdJT3V3bStxem9Dd2c3SmlCN0pldDY2ZUk2NHVrSU91VXNPdWhuQ0RyaklEc2xZanNuWVFnNjRLNDY0dWtMZ29nSUM4dklPeVlnZXlYclNEc2lKanJwNHp0Z2J3ZzdKcVU3TEt0N0oyRUlPeXF2T3F3bk95bmdDRHNsWXJyaXBRZzZyS0Q3SjIwSU8yVnRleUxyQ0FvNjRxUTY2Q2s3S2VBNnJPZ0lPeUNyT3lhcWV1ZmlldVBoQ0RxdDdqcnA0enRnYndnNjRLWTZyQ0U2NHVrS1M0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0xXZHliM1Z3Y3ljcElIc0tJQ0FnSUdOdmJuTjBJSHNnWjNKdmRYQnpMQ0J0YjJSbGJDd2diVzl5WlNCOUlEMGdZWGRoDQphWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0dkeWIzVndjeWtLSUNBZ0lDQWdQeUJuY205MWNITUtJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tHY3BJRDArSUNoN0NpQWdJQ0FnSUNBZ0lDQWdJRzVoYldVNklGTjBjbWx1Wnlnb1p5QW1KaUJuTG01aGJXVXBJSHg4SUNjbktTNTBjbWx0S0Nrc0NpQWdJQ0FnSUNBZ0lDQWdJSFJsZUhSek9pQW9aeUFtSmlCQmNuSmhlUzVwYzBGeWNtRjVLR2N1ZEdWNGRITXBJRDhnWnk1MFpYaDBjeUE2SUZ0ZEtTNXRZWEFvS0hRcElEMCtJRk4wY21sdVp5aDBJSHg4SUNjbktTNTBjbWx0S0NrcExtWnBiSFJsY2loQ2IyOXNaV0Z1S1N3S0lDQWdJQ0FnSUNBZ0lDQWdjbTlzWlRvZ0tHY2dKaVlnWnk1eWIyeGxLU0EvSUZOMGNtbHVaeWhuTG5KdmJHVXBJRG9nZFc1a1pXWnBibVZrTEFvZ0lDQWdJQ0FnSUNBZ2ZTa3BDaUFnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2huS1NBOVBpQm5MblJsZUhSekxteGxibWQwYUNrSw0KSUNBZ0lDQWdPaUJiWFRzS0lDQWdJR2xtSUNoc2FYTjBMbXhsYm1kMGFDQThJRElwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW43SmlCN0pldDdKMjBJT3UyZ095aHNlMlZxZXVMaU91THBDNG5JSDBwT3dvZ0lDQWdZMjl1YzNRZ2MzUmhjblJsWkNBOUlFUmhkR1V1Ym05M0tDazdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNFNjZDSTdKNkU2N09FSU95MmxPeXluQ0RzbXBUc3NxMDZJT3lZZ2V5WHJTQW5JQ3NnYkdsemRDNXNaVzVuZEdnZ0t5QW42ckNjSnlBcklDaHRiM0psSUQ4Z0p5QW82NDJVSU91d20rcTRzQ2tuSURvZ0p5Y3BMQ0J0YjJSbGJDQS9JQ2NvNjZxbzY0MjRPaUFuSUNzZ2JXOWtaV3dnS3lBbktTY2dPaUFuSnlrN0NpQWdJQ0IwY25rZ2V3b2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclIzSnZkWEJ6S0d4cGMzUXNJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlVkeWIzVndjeXdnWm05eWJXRjBSR1Z6WXpvZ0ozc2kNClozSnZkWEJ6SWpvZ1czc2libUZ0WlNJNklDTHNtSUhzbDYwZzdKMjA2NmFFSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcmpJRHNsWWdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOVhYMWRmU2NnZlN3Z0lTRnRiM0psS1RzS0lDQWdJQ0FnWTI5dWMzUWdiM1YwSUQwZ2NpNXdZWEp6WldRN0NpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnZkWFFwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0NpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRsSVRyb0lqc25vVHJzNFFnN0tDYzdKV0lJQ2NnS3lCdmRYUXVjbVZrZFdObEtDaHVMQ0JuS1NBOVBpQnVJQ3NnWnk1emRXZG5aWE4wDQphVzl1Y3k1c1pXNW5kR2dzSURBcElDc2dKK3F3bkNBdklPeVlnZXlYclNBbklDc2diM1YwTG14bGJtZDBhQ0FySUNmcXNKd2dLQ2NnS3lCelpXTWdLeUFuY3lrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlDZGI3WlNFNjZDSTdKNkU2N09FWFNBbklDc2dVM1J5YVc1bktDaHNhWE4wV3pCZElDWW1JR3hwYzNSYk1GMHVkR1Y0ZEhOYk1GMHBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlOQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHZHliM1Z3Y3pvZ2IzVjBMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2Wnlnbg0KVzJKeWFXUm5aVjBnN1pTRTY2Q0k3SjZFNjdPRUlPeTJsT3l5bkNEc2k2VHRqS2c2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5LU2s3Q2lBZ0lDQjlDaUFnZlFvZ0lDOHZJTzJNbmV5WGhTRHNtcFRzaG96cnM0UWc3TGFVN0xLY0lPS0FsQ0R0bFp3ZzdZeWQ3SmVGN0oyWUlPcTFyT3lFc2V5YWxPeUdqQ2pzbDYzdGxhQXI2Nnk0NnJXc0tldWx2Q0R0bFp3ZzY3S0k3SmVRSU91d20reVZoQ0RzbDYzdGxhRHJzNFRyb1p3ZzY0dWs2NU9zNjRxVTY0dWtMZ29nSUM4dklPeWFsT3lHak91bHZDRHRsYWpxdTVnZzY3TzA2NEswN0pXOElPMkRnT3lkdE8yTGdPeWR0Q0RyczdqcnJMZ2c2NmVsNjUyOTdKMkVJT3l3dU95aHNPMlZvQ0RzaUpnZzdKNkk2NHVrS095YWxPeUdqT3V6aENEcXNKenJzNFFnN0pxVTdMS3Q2ck84N0oyWUlPeXdxT3lkdENrdUNpQWcNCmFXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNKbFkyOXRiV1Z1WkMxd2IzQjFjQ2NwSUhzS0lDQWdJR052Ym5OMElIc2daV3hsYldWdWRITXNJRzF2WkdWc0xDQnRiM0psSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ1kyOXVjM1FnYkdsemRDQTlJRUZ5Y21GNUxtbHpRWEp5WVhrb1pXeGxiV1Z1ZEhNcElEOGdaV3hsYldWdWRITXVabWxzZEdWeUtDaGxLU0E5UGlCbElDWW1JRk4wY21sdVp5aGxMblJsZUhRZ2ZId2dKeWNwTG5SeWFXMG9LU2tnT2lCYlhUc0tJQ0FnSUdsbUlDaHNhWE4wTG14bGJtZDBhQ0E4SURJcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuN1l5ZDdKZUZJT3lhbE95R2pPcXdnQ0RydG9Ec29iSHRsYW5yaTRqcmk2UXVKeUI5S1RzS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPd29nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNDQpuZXlYaFNEc3RwVHNzcHdnN0pxVTdMS3RPaURzbXBUc2hvd2dKeUFySUd4cGMzUXViR1Z1WjNSb0lDc2dKK3F3bkNjZ0t5QW9iVzl5WlNBL0lDY2dLT3VObENEcnNKdnF1TEFwSnlBNklDY25LU3dnYlc5a1pXd2dQeUFuS091cXFPdU51RG9nSnlBcklHMXZaR1ZzSUNzZ0p5a25JRG9nSnljcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ1kyOXVjM1FnY2lBOUlHRjNZV2wwSUdGemExQnZjSFZ3S0d4cGMzUXNJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlZCdmNIVndMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXV3cWUyV3BTRHRsWndnNjZ5NDdKNmxJaXdnSW1Wc1pXMWxiblJ6SWpvZ1czc2ljbTlzWlNJNklDTHNsNjN0bGFBaUxDQWlkR1Y0ZENJNklDTHJyTGpxdGF3aWZTd2dMaTR1WFgwc0lDNHVMbDE5SnlCOUxDQWhJVzF2Y21VcE93b2dJQ0FnSUNCamIyNXpkQ0J6WlhSeklEMGdjaTV3WVhKelpXUTdDaUFnSUNBZ0lHTnZibk4wSUhObFl5QTlJQ2dvUkdGMA0KWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzS0lDQWdJQ0FnYVdZZ0tDRnpaWFJ6S1NCN0NpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJSHNnWlhKeWIzSTZJQ2Z0Z2JUcm9aenJrNXdnN0oyUjY0dTE3SjJFSU8yVnRPeUVuZTJWbU95bmdDRHJxcnZ0bG9qc2xyVHNtcFF1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlkN0plRklPeUV1TzJLdUNBbklDc2djMlYwY3k1c1pXNW5kR2dnS3lBbjZyQ2NJQ2duSUNzZ2MyVmpJQ3NnSjNNcEp5azdDaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQW5XKzJNbmV5WGhWMGdKeUFySUZOMGNtbHVaeWdvYkdsemRGc3dYU0FtSmlCc2FYTjANCld6QmRMblJsZUhRcElIeDhJQ2NuS1M1emJHbGpaU2d3TENBeU5DazdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhObGRITXNJR1Z1WjJsdVpUb2dKMk5zWVhWa1pTY2dmU2s3Q2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpKM3NsNFVnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lDZnRnYlRyb1p6cms1d2c3Wmk0N0xhY0lPeUxwTzJNcURvZ0p5a3BPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5RHJqSUR0bVpUdG1KVWc2Nnk0NnJXc0lPeWduT3lla1NEaWdKUWc3SU9CN1ptcDdKMkVJT3lFcE91cWhlMlZtT3VwdENEcnJManF0YXpycGJ3ZzY2ZU02NU9rN0phMDdLU0E2NHVrSUNqc3RwVHNzcHpxczd3ZzZyQ1o3SjJBSU95RXVPeUZtQ3dnDQo2NHlBN1ptVTY0cVVJT3VucENEc21wVHNzcTNzbDVBZzdZYTE3S2U0NjZHY0lPeUxwT3VtdkNrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdlkyOXRjRzl6WlNjcElIc0tJQ0FnSUdOdmJuTjBJSHNnYldWemMyRm5aWE1zSUcxdlpHVnNJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlFRnljbUY1TG1selFYSnlZWGtvYldWemMyRm5aWE1wSUQ4Z2JXVnpjMkZuWlhNdVptbHNkR1Z5S0NodEtTQTlQaUJ0SUNZbUlGTjBjbWx1WnlodExuUmxlSFFnZkh3Z0p5Y3BMblJ5YVcwb0tTa2dPaUJiWFRzS0lDQWdJR2xtSUNnaGJHbHpkQzVzWlc1bmRHZ3BJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREF3TENCN0lHVnljbTl5T2lBbjY0eUE3Wm1VSU91Q3RPeWFxZXlkdENEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjbw0KS1RzS0lDQWdJR052Ym5OMElHeGhjM1JWYzJWeUlEMGdXeTR1TG14cGMzUmRMbkpsZG1WeWMyVW9LUzVtYVc1a0tDaHRLU0E5UGlCdExuSnZiR1VnSVQwOUlDZGhjM05wYzNSaGJuUW5LVHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c25wRWc2NHlBN1ptVUlPeWFsT3l5clRvbkxDQlRkSEpwYm1jb0tHeGhjM1JWYzJWeUlDWW1JR3hoYzNSVmMyVnlMblJsZUhRcElIeDhJQ2NuS1M1emJHbGpaU2d3TENBMU1Da3VjbVZ3YkdGalpTZ3ZYRzR2Wnl3Z0p5QW5LU0FySUNmaWdLWWdLT3VNZ08yWmxDQW5JQ3NnYkdsemRDNXNaVzVuZEdnZ0t5QW42ckNjS1NjcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ0x5OGc2NHlBN1ptVTZyQ0FJT3E0dU95V3RPeW5nT3VwdENEc3RaenF0N3dnTVRMcXNKenJwNHdnS08yVWhPdWhyTzJVaE8yS3VDRHRqNjNzbzd3ZzY3Q3A3S2VBS1FvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUTI5dGNHOXpaU2hzYVhOMExuTnNhV05sS0MweE1pa3MNCklHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVU52YlhCdmMyVXNJR1p2Y20xaGRFUmxjMk02SUNkN0luSmxjR3g1SWpvZ0l1dU1nTzJabENEc25aSHJpN1VnN1pXYzY1R1FJT3VzdU95ZXBTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2Nnk0NnJXc0lpd2dJbkpsWVhOdmJpSTZJQ0xzbmJUc25LQWlmU3dnTGk0dVhYMG5JSDBwT3dvZ0lDQWdJQ0JqYjI1emRDQnZkWFFnUFNCeUxuQmhjbk5sWkRzS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3dvZ0lDQWdJQ0JwWmlBb0lXOTFkQ2tnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0NpQWdJQ0FnSUgwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrDQpaMlZkSU95Z25PeWVrU0RzblpIcmk3VWdLQ2NnS3lCelpXTWdLeUFuY3l3ZzdLQ2M3SldJSUNjZ0t5QnZkWFF1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUNzZ0orcXduQ2tuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWdvYkdGemRGVnpaWElnSmlZZ2JHRnpkRlZ6WlhJdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djbVZ3YkhrNklHOTFkQzV5WlhCc2VTd2djM1ZuWjJWemRHbHZibk02SUc5MWRDNXpkV2RuWlhOMGFXOXVjeXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzSw0KSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeWVrU0RzaTZUdGpLZzZKeXdnWlM1dFpYTnpZV2RsS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdDaUFnSUNCOUNpQWdmUW9nSUM4dklPdXlpT3lYclNEaWdKUWc3WldjNnJXdDdKYTBJT0tHbENEc21JSHNsclFnN0o2UTY0K1pJQ2pzdHBUc3NwenFzN3dnNnJDWjdKMkFJT3lFdU95Rm1DRHNncXpzbXFrcENpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzUnlZVzV6YkdGMFpTY3BJSHNLSUNBZ0lHTnZibk4wSUhzZ2RHVjRkQ3dnYlc5a1pXd2dmU0E5SUdGM1lXbDBJSEpsWVdSQ2IyUjVLSEpsY1NrN0NpQWdJQ0JwWmlBb0lYUmxlSFFnZkh3Z0lWTjBjbWx1WnloMFpYaDBLUzUwY21sdEtDa3BJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2cNCk5EQXdMQ0I3SUdWeWNtOXlPaUFuNjdLSTdKZXQ3WldnSU91c3VPcTFyT3F3Z0NEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdKcVU3TEt0T2ljc0lGTjBjbWx1WnloMFpYaDBLUzV6YkdsalpTZ3dMQ0ExTUNrdWNtVndiR0ZqWlNndlhHNHZaeXdnSnlBbktTQXJJQ2ZpZ0tZbktUc0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lHTnZibk4wSUhJZ1BTQmhkMkZwZENCaGMydFVjbUZ1YzJ4aGRHVW9VM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFZISmhibk5zWVhSbExDQm1iM0p0WVhSRVpYTmpPaUFuZXlKMGNtRnVjMnhoZEdWa0lqb2dJdXV5aU95WHJldXN1Q0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpTENBaVpHbHlaV04wYVc5dUlqb2dJbXR2NG9hU1pXNGc2NWlRNjRxVUlHVnU0b2FTDQphMjhpZlNjZ2ZTazdDaUFnSUNBZ0lHTnZibk4wSUc5MWRDQTlJSEl1Y0dGeWMyVmtPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzY3S0k3SmV0SU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNtWVRybzR3Z0tDY2dLeUJ6WldNZ0t5QW5jeXdnSnlBcklDaHZkWFF1WkdseVpXTjBhVzl1SUh4OElDYy9KeWtnS3lBbktTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVA0KZEhKcGJtY29KMnR2TFV0U0p5azdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2dkSEpoYm5Oc1lYUmxaRG9nYjNWMExuUnlZVzV6YkdGMFpXUXNJR1JwY21WamRHbHZiam9nYjNWMExtUnBjbVZqZEdsdmJpd2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzaTZUdGpLZzZKeXdnWlM1dFpYTnpZV2RsS1RzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURJc0lHWnlhV1Z1Wkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHJzb2pzbDYwZzdJdWs3WXlvT2lBbktTazdDaUFnSUNCOUNpQWdmUW9nSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBMExDQjcNCklHVnljbTl5T2lBblRtOTBJR1p2ZFc1a0p5QjlLVHNLZlNrN0Nnb3ZMeURzbmJUcnI3Z2c2NHVrNjZhczZyQ0FJT3VXb0NEc25vanJpcFRyamJBZzY1aVFJT3k4bk9xNHNPcXdnQ0RyazZUc2xyVHNtS1RycWJRbzdLQ2M3SXFrN0xLWUlPeWVrT3VQbVNEc3ZKenF1TEFnN0tTUjY3TzFJT3VUc1NrZzdLR3c3SnFwN1o2SUlPeWloZXVqakNEaWdKUWc2NCtNNjQyWUlPdUxwT3Vtck91S2xDRHF0N2pyaklEcm9ad2c3SnlnN0tlQUNuTmxjblpsY2k1dmJpZ25aWEp5YjNJbkxDQW9aU2tnUFQ0Z2V3b2dJR2xtSUNobElDWW1JR1V1WTI5a1pTQTlQVDBnSjBWQlJFUlNTVTVWVTBVbktTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SjIwNjYrNElPeThuT3lndUNEc25vanNsclRzbXBRbzdZK3M3WXE0SUNjZ0t5QlFUMUpVSUNzZ0p5RHNncXpzbXFrZzdLU1JLU0RpZ0pRZzdKMjBJT3lkdU95S3BPMkV0T3lLcE91S2xDRHNvb1hybzR6dGxhbnJpNGpyaTZRdUp5azdDaUFnSUNCd2NtOWpaWE56DQpMbVY0YVhRb01DazdDaUFnZlFvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaEp6cnNvUWc3SmlrNjZXWU9pY3NJR1VnSmlZZ1pTNXRaWE56WVdkbEtUc0tJQ0J3Y205alpYTnpMbVY0YVhRb01TazdDbjBwT3dvdkx5RHNsclRybHFRZzZySzk2NkdjNjZHY0lPeWp2ZXVUb0Nqc2k2enNucVhyc0pYcmo1a2c2NEdLNnJtQUxDQkRkSEpzSzBNc0lDOXphSFYwWkc5M2Jpd2c3SmlrNjZXWUtTQmpiR0YxWkdVZzdKNlE3SXVkN0oyRUlPdUNxT3E0c095bmdDRHNsWXJyaXBUcmk2UUtjSEp2WTJWemN5NXZiaWduWlhocGRDY3NJQ2dwSUQwK0lIc2dhMmxzYkZCeWIyTW9LVHNnYTJsc2JFeHZaMmx1VUhKdll5Z3BPeUI5S1RzS2NISnZZMlZ6Y3k1dmJpZ25VMGxIU1U1VUp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwS1RzS2NISnZZMlZ6Y3k1dmJpZ25VMGxIVkVWU1RTY3NJQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1NrN0NncHpaWEoyWlhJdWJHbHpkR1Z1S0ZCUFVsUXNJQ2N4TWpjdQ0KTUM0d0xqRW5MQ0FvS1NBOVBpQjdDaUFnWTI5dWMyOXNaUzVzYjJjb0orS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQ2NwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2NnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rzdkp6c3A1QWc0b0NVSUdoMGRIQTZMeTlzYjJOaGJHaHZjM1E2SnlBcklGQlBVbFFwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2NnNjZxbzY0MjRPaUFuSUNzZ1EweEJWVVJGWDAxUFJFVk1JQ3NnSnlEQ3R5RHNtSWpzaTV3Z0p5QXJJRVZZUVUxUVRFVlRMbXhsYm1kMGFDQXJJQ2Zxc2JRZzdKNmw3TENwSnlrN0NpQWdZMjl1YzI5c1pTNXNiMmNvSnlEc25iUWc3TEM5N0oyRUlPeThuT3VSbENEcmo1bnNsWWdnN1pTODZyZTQNCjY2ZUlJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHRnYlRyb1p6cms1enJvWndnN0xhVTdMS2M3WldwNjR1STY0dWtMaWNwT3dvZ0lHTnZibk52YkdVdWJHOW5LQ2ZpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBbktUc0tJQ0JqYUdWamEwTnNZWFZrWlVGMllXbHNZV0pzWlNncE95QXZMeUJEYkdGMVpHVWdRMjlrWlNEc2dxenNtcWtnNnJDQTY0cWxJT3lYck91MmdDRHNvSkRxc29BZ0tPMlVqT3Vmck9xM3VPeWR1Q0RzbFlqcmdyVHNtcWtwQ2lBZ0x5OGc2Nis0NjZhc0lPeUxuT3VQbVNBcklPeW5nT3lMbk91c3VDRHNvN3pzbm9VZzRvQ1VJT3l5cXlEc3RwVHNzcHpydG9EdGhMQWc2N21nNjZXMDZyS01DaUFnWVhOclEyeGhkV1JsDQpLQ2ZzbTR6cnNJM3NsNFU2SUNMc29JRHNucVVnNjVDWTdKZUk3SXExNjR1STY0dWtJaWNwTG5Sb1pXNG9DaUFnSUNBb0tTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeVpoT3VqakNEaWdKUWc3TGFVN0xLY0lPeWtnT3U1aENEcmdaMHVKeWtzQ2lBZ0lDQW9aU2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3liak91d2pleVhoU0RzaTZUdGpLZ2dLT3l5cXlEc21wVHNzcTBnNjVXTUlPeWVyT3lMbk91UGhDazZKeXdnWlM1dFpYTnpZV2RsS1FvZ0lDazdDbjBwT3dvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJRzFoWTA5VElPdVRzZXlYa095RW5DQW5iRzlqWVd4b2IzTjBKK3F3Z0NBNk9qSHJvWndnNjZpODdLQ0FJTzJWdE95RW5ldVFtT3VLbE91TnNBb3ZMeUR0bEx6cXQ3anJwNGdvUld4bFkzUnliMjRwSUdabGRHTm82NHFVSUdOMWNtenFzN3dnNjR1czY2YXNJRWxRZGpUcg0Kb1p3ZzdKNlE2NCtaSU8yUHRPdXdzZTJWbU95bmdDRHNsWXJzbFlRc0lFbFFkalRycDR3ZzY1T2o2NDJZSU91THBPdW1yT3lYa0NEc2w3RHFzckRzbmJRZzZyR3c2N2FBNjQrOENpOHZJT3kybE95eW5NSzM3WmVzN0lxazdMSzA3WUdzNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxvanJpNlFvN0l1azdMaWhJREl3TWpZdE1EY3BMaURxc0puc25ZQWc3SnFVN0xLdElPMlZ1T3VUcE91ZnJPdWx2Q0JKVUhZMklPdWpxTzJVaE91d3NleVhrT3VQaENEc2xybnJpcFRyaTZRdUNtTnZibk4wSUhObGNuWmxjallnUFNCb2RIUndMbU55WldGMFpWTmxjblpsY2loelpYSjJaWEl1YkdsemRHVnVaWEp6S0NkeVpYRjFaWE4wSnlsYk1GMHBPd3B6WlhKMlpYSTJMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZ1NWQjJOaWc2T2pFcElPdW1yT3lLcUNEc2c1M3JuclVnNG9DVUlFbFFkalRycDR3ZzdJS3M3SnFwT2ljc0lHVWdKaVlnWlM1dFpYTnpZV2RsS1NrN0NuTmwNCmNuWmxjall1YkdsemRHVnVLRkJQVWxRc0lDYzZPakVuS1RzSw0KOjpFWEFNUExFUzo6DQpJeURyckxqcXRhd2c3TGFVN0xLY0lPeVlpT3lMbkFvS0l1dXN1T3ExckNEc3RwVHNzcHpyc0p2cXVMQWk2ckNBSU95Q3JPeWFxZTJWbU91S2xDRHNtSWpzaTV3ZzY2cW83SjJNN0o2RjY0dUk2NHVrTGlBcUt1eWR0Q0R0akl6c25ienNuWVFnN0lpWTdLQ1Y3WldjSU91U3BDRHRoTERycjdqcmhKRHNsNURzaEp3Z1lHNXdiU0J5ZFc0Z1luVnBiR1JnNjZXOElPeUxwTzJXaWUyVm1PcXpvQ3dnUm1sbmJXSHNsNURzaEp3ZzdaU002NStzNnJlNDdKMjQ3SjJFSU91THBPeUxuQ0RzaTZUdGxvbnRsWmpycWJRZzY3Q1k3SmlCNjVDcDY0dUk2NHVrTGlvcUNnb2pJeURzbnBIc2hMRWc2N0NwNjdLVkNnb3RJT3lZaU95TG5DRHRsWmpyZ3BqcmlwUWdLaXBnSXlNaklPeWJrT3V6dUdBcUtpRHRsWndnN0tTRTZyTzhMQ0RxdDdnZzdKV0U2NTZZSUNvcVlDMGc3TGFVN0xLYzdKV0lZQ29xSU95WHJPdWZyQ0Rxc0p6cm9ad2c3SjIwNjZTRTdLZVI2NHVJNjR1a0xnb3RJT3kybE95eW5PeVZpQ0RzbFlqc2w1RHNoSndnS2lycw0KcElUc25ZUWc2N0NVNnI2NDZyT2dJT3lMdHV5Y3ZPdXB0Q0JnSUM4Z1lDQW83SldlNjVLa0lPcXp0ZXV3c1NEdGo2enRsYWdnN0lxczY1Nlk3SXVjS1NvcUlPdWhuQ0R0a1p6c2k1enRsWmpzaExqc21wUXVJTzJVak91ZnJPcTN1T3lkdU95WGtPeUVuQ0Rya1pBZzdLU0U2NkdjSU91enRPeVhyT3lua2V1TGlPdUxwQzRLTFNEc2dxenNtcW5zbnBEcXNJQWc3SjZGNjZDbDdaV2NJT3VzdU9xMXJPcXdnQ0JnN0p1UTY3TzRZT3F6dkNBbzZyTzE2N0N4d3JmcnJManNucVhydG9EdG1MZ2c2NnkwN0l1YzdaV1k2ck9nS1NEcXNKbnFzYkRyZ3Bnc0lPeUVuT3VobkNEdGo2enRsYWp0bFpqcnFiUWc2cmU0SU95MmxPeXluT3lWaU91VHBPeWRoQ0RyczdUc2w2enNwSTNyaTRqcmk2UXVDaTBnNjZlazdMbXQ3WldnSU91VmpDQXFLdXVuaU95S3BPMkN1ZXVRbkNEc25iVHJwb1FvN1ptTlhDcnJqNWtwTENEc2lLdnNucEFvN0tDRTdabVU2N0tJN1ppNHdyY2k3Sm00SURMcnFvVWlJT3VUc1NucmlwUWc2NnkwN0l1Y0tpcnQNCmxhbnJpNGpyaTZRZzRvQ1VJT3lkdE91bWhNSzM3SWlZNjUrSndyZnJzb2p0bUxqcnA0d2c2NHVrNjZXNElPdXN1T3Exck91UGhDRHFzSm5zbllBZzdKaUk3SXVjNjZHY0lPeWVvZTJZZ095YWxDNGc2NHVvTENEc3RwVHNzcHpzbFlqc2w1QWc3S0NCN0phMDY1R1VJT3lkdE91bWhNSzM3SWlyN0o2UTY0cVVJT3EzdU91TWdPdWhuQ0RyZ3Bqc21LVHJpNGdnN0l1azdLQ2NJT3F3a3V5WGtDRHJwNTdxc293ZzZyT2c3TE9RSU95VHNPeUV1T3lhbEM0S0xTRHNvSnpycXFrb1lDTWpZQ25xczd3Z1lDTWpJMkFzSUdBdFlDRHF1TER0bUxqcmlwUWc3WmlWN0l1ZDdKMjA2NHVJSU91d2xPcSt1T3luZ0NEcnA0anNoTGpzbXBRdUNnb2pJeURzaXFUdGc0RHNuYndnN0p1UTdMbVpJQ2pzc0xqcXM2QWc0b0NVSU95ZWtPeUV1TzJWbkNEcmdyVHNtcW5zbllBZ2RYZ3RkM0pwZEdsdVp5NXRaQ0Rxc0lEc25iVHJrNXdwQ2dvdElPMlZ0T3lhbE95eXRDd2c2N2FBNjVPYzY1K3M3SnEwSU95aWhlcXlzQ2hnZnV5ZWlPeVd0T3lhDQpsR0FnWUg3cmo3enNtcFJnSUdCKzdKZUc3SmEwN0pxVVlDQmdmdTJWdENEc283enNoTGpzbXBSZ0tRb3RJRExyaTZnZzZyV3M3S0d3T2lBcUt1eXlxeURzcElROTdJT0I3Wm1wSU95RXBPdXFoU0RpaHBJZzY1R1k3S2U0SU95a2hEM3JpNlRzbll3ZzdaYUo2NCtaS2lvbzZyS3c3S0NWN0oyQUlHQis3WldnNnJtTTdKcVVQMkFzSU8yV2lldVBtU0RzbktEcmo0VHJpcFFnWUg3dGxiUWc3S084N0lTNDdKcVVZQ2tLTFNEcmlxWHJqNW5zb0lFZzY2ZVE3WldZNnJpd0tPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ2tzSU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBbzdKZUc3SmEwN0pxVTRvYVNmdTJWbU91cHRDRHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDa0tMU0RzdXBEc283enNscnp0bFp3ZzZySzk3SmEwS0g3c2k1enFzcURzbHJUc21wUS80b2FTZnUyVm9PcTVqT3lhbEQ4cExDRHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNDanNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2M0b2FTN0o2VQ0KN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrS0xTRHFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NBbzdLQ0U3SWFoNG9hUzY3TzA2NEswNjR1a0tTd2c2N2FBN0tDVklPeURnZTJacWV1UGhDRHJsTEhybExIdGxaanNwNEFnN0pXSzZyS01LQ0xzc0w3cXVMQWc3SXVrN1l5b0l1S2RqQ0FpN0xDKzdKMkVJT3lJbUNEc2w0YnNsclRzbXBRaTRweUZLUW9LSXlNZzdMYVU3TEtjSU95WWlPeUxuQW9LSXlNaklPeW5oTzJXaWUyVm1PdU5tQ0RzbnBIc2w0WHNuYlFnN0o2STdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3S2VFN1phSklPeWtrZXlkdUNEcmdyVHNsNjNzbmJRZzdKNkk3SmEwN0pxVUxpQXZJT3lkdE95V3RPeUVuQ0RzcDRUdGxvbnRsYURxdVl6c21wUS9DZ29qSXlNZzZyTzE3SnlnSU95YWxPeXlyZXlkaENEc3Q2anNob3p0bFpqcnFiUWc3SnFVN0xLdElPdUN0T3lYcmV5ZHRDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTNxT3lHak8yVm1PeUwNCm5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc3Q2anNob3p0bGFBZzZySzk3SnF3SU95YWxPeXlyU0RyZ3JUc2w2M3JqNFFnN0lLdDdLQ2M2NCs4N0pxVUxpQXZJT3F6dGV5Y29DRHNtcFRzc3Ezc25ZUWc3TGVvN0lhTTdaV2c2cm1NN0pxVVB3b0tJeU1qSU9xNHNPcTRzT3VsdkNEc3NMN3NwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WldZN0lTNDdKcVVMZ290SU9xNHNPcTRzT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlXdE95YWxDNGdMeUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXWTZyaXdJT3lnaE95WGtPdUtsQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxBb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0tlQTZyaUlJT3V5DQpoT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WlcwSU95anZPeUV1T3lhbEM0Z0x5RHNnNTNzc3JRZzdKMjQ3S2FkN0oyRUlPeVRzT3VncE91cHRDRHN0WnpzaTZBZzY3S0U3S0NFN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRLQ2lNakl5RHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4S0xTRHJqSURzdHB3ZzY2cXA3S0NCN0oyMElPdXN0T3lYaCt5ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhLTFNEc2k2RHFzNkFnN0oyMDdKeWc2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0o2VQ0KN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDaTBnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxnb0tJeU1qSU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c3Sm00SURMcnFvWHNsNURxc293ZzZyYU03WldjSU95Q3JleWduQ0RzbFl6cnByenRocUhzbllRZzdLQ0U3SWFoN1pXZzZybU03SnFVUHdvdElPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdE91Z3BPcXpvQ0R0bGJUc21wUXVJQzhnN1ptTkt1dVBtU2d3TVRBdE1USXpOQzAxTmpjNEtTRHJpNWdnN0ptNElETHJxb1hzbDVEcXNvd2c2N08wNjRLODZybU03SnFVUHdvdElPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnNjR1WUlPeVp1Q0F5NjZxRjdKZVE2cktNSU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN2T3E1ak95YWxEOEtMU0RxdG96dGxad2cNCjdJS3Q3S0NjSU95VmpPdW12TzJHb2V5ZGhDRHRtWTBxNjQrWktEQXhNQzB4TWpNMExUVTJOemdwSU91TG1DRHNtYmdnTXV1cWhleVhrT3F5akNEcnM3VHJncnpxdVl6c21wUS9DZ29qSXlNaklPMlpsZXlkdU1LMzZyS3c3S0NWSU8yTW5leVhoUW9LSXlNaklPeWdsZXVua0NEc2dxM3NvSnp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95Q3JleWduT3VRbkNEcmpiRHNuYlR0aExEcmlwUWc2N08xNnJXczdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEcmtKanJqNHpycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc29KWHJwNUFnN0lLdDdLQ2M3WldnNnJtTTdKcVVQd29LSXlNaklPdXpnT3F5dmV5Q3JPMlZyZXlkdENEc29JRHNucVhya0pqc3A0QWc3SldLN0pXWTdJcTE2NHVJNjR1a0xpRHJncGpxc0lEc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKV0U3S2VCSU95Z2dPeWVwZTJWbU95bmdDRHNsWXJzbllBZzY0SzA3SnFwN0oyMElPeWVpT3lXDQp0T3lhbEM0Z0x5RHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4S0NpTWpJeURyb1p6cXQ3anNsWVRzbTRNZzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3Vobk9xM3VPeVZoT3liZysyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbGJIc25ZUWc3S0tGNjZPTTdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3lWc2V5ZGhDRHNvb1hybzR6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nN1pXY0lPdXlpQ0RyczREcXNyM3RsWmpycWJRZzY0dWs3SXVjSU91emdPcXl2ZTJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzY0dWs3SXVjSU91d2xPcS9nQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6aE95R2plMlZvT3E1ak95YWxEOEtDaU1qSXlEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpya0tucmk0anJpNlF1SU95MGlPcTRzTzJabE8yVg0KbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpyajd6c21wUXVJQzhnN0xTSTZyaXc3Wm1VN1pXZzZybU03SnFVUHdvS0l5TWpJeURzbDVEcm42ekN0K3lMcE8yTXFBb0tJeU1qSU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU91RXBPMkt1T3liak8yQnJPeVhrQ0RzbDdEcXNyRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzbDdEcXNyQWc3SU9CN1lPYzY2VzhJTzJabGV5ZHVPMlZtT3F6b0NEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPdXduT3lEbmUyV2lPeUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNuYnpzaTV6c29JSHMNCm5iZ2c3SmlrNjZXWTZyQ0FJT3lEbmVxeXZPeVd0T3lhbEM0Z0x5RHNucURzaTV3ZzdadUVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZoT3lkdE91VWxDRHJtSkRyaXBRZzY3bUU2N0NBNjdLSTdaaTQ2ckNBSU95ZHZPeTVtTzJWbU95bmdDRHNsWXJzaXJYcmk0anJpNlF1Q2kwZzdKV0U3SjIwNjVTVUlPdVlrT3VLbENEcnVZVHJzSURyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwM3Jzb2p0bUxqcXNJQWc3SjI4N0xtWTdaV1k3S2VBSU95Vml1eUt0ZXVMaU91THBDNEtMU0RzbmJqc3BwM3Jzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeTBpT3F6dk91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0oyNDdLYWQ2N0tJDQo3Wmk0NjZXOElPeWVyT3V3bk95R29lMlZtT3lMcmV5TG5PeVlwQzRLTFNEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95bmdPdUNyT3lXdE95YWxDNGdMeURzbmJqc3BwM3Jzb2p0bUxqcnBid2c2NHVrN0l1Y0lPdXdtK3lWaENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzbHJUc21wUXVJQzhnNjR1azY2VzRJT3F5Z095RGlleVd0T3VobkNEcmk2VHNpNXdnN0xDKzdKV0U2N08wN0lTNDdKcVVMZ29LSXlNaklPeWdsZXV6dE91bHZDRHJ0b2pybjZ6c21LVHNwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNvSlhyczdUcnBid2c2N2FJNjUrczdKaXNJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHRqSXpzbmJ3Zw0KN0plRjY2R2M2NU9jN0plUUlPeUxwTzJNcU8yV2lPeUt0ZXVMaU91THBDNEtMU0R0akl6c25ienNuWVFnN0ppczY2YXM3S2VBSU91cXUrMldpT3lXdE95YWxDNGdMeURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3S0NRNnJLQUlPeWtrZXllaGV1TGlPdUxwQzRnN0oyMDdKcXA3SmVRSU91MmlPMk91T3lkaENEcms1enJvS1FnN0tPRTdJYWg3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEc2hKenJ1WVRzaXFUcnBid2c3S0NRNnJLQTdaV1k2ck9nSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSkRxc29Ec25iUWc2NEdkNjRLWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bFlUc2lKZ2c3SjZGNjZDbElPMlZyZXVxcWV5ZWhldUxpT3VMcEM0S0xTRHF2SzBnN0o2RjY2Q2w3WlcwN0pXOElPMlZtT3VLbENEdGxhM3JxcW5zbmJUc2w1RHNtcFF1Q2dvakl5TWpJT3Eyak8yVm5NSzM3SVNrN0tDVkNnb2oNCkl5TWc3TG0wNjZtVTY1MjhJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0lxMTY0dUk2NHVrTGlEc2hLVHNvSlhzbDVEc2hKd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc3ViVHJxWlRybmJ3ZzZyYU03WldjN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3TG0wNjZtVTY1MjhJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWak91bXZDRHF0b3p0bFp6c25iUWc2ckd3NjdhQTY1Q1k3SmEwSU95VmpPdW12T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEc2xZenJwcndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU91cHRDRHNob3pzaTUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdJU2s3S0NWN0plUTdJU2NJT3lWak91bXZPeWRoQ0Rzdkp3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Y2hPeTVtQ0Rzb0pYcnM3UWc3SjIwN0pxcDdKZVFJT3VQDQptZXlkbU8yVm1PeW5nQ0RzbFlyc2xZUWc3SjI4NjdhQUlPcTRzT3VLcGV5ZHRDRHNvSnp0bFp6cmtLbnJpNGpyaTZRdUNpMGc3SnlFN0xtWUlPeWdsZXV6dE91bHZDRHRsNGpzbXFudGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3SnlFN0xtWUlPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHNtWVRybzR6Q3QreW5oTzJXaVFvS0l5TWpJT3lnZ095ZXBldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNvSURzbnFYdGxvanNsclRzbXBRdUNnb2pJeU1nNjdPQTZySzk3SUtzN1pXdDdKMjBJT3lnZ2V5YXFldVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzNERxc3IwZzY0SzA3SnFwN0oyRUlPeWdnZXlhcWUyV2lPeVd0T3lhbEM0S0NpTWpJeURzb0lUc2hxSHNuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3V6dE91RGlPeVd0T3lhbEM0S0NpTWpJeURyazdIcg0Kb1ozc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdVRzZXVobmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWc3SUt0N0tDYzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeUNyZXlnbk8yV2lPeVd0T3lhbEM0S0NpTWpJeUR0Z2JUcnByM3JzN1RyazV6c2w1QWc2N08xN0lLczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0ZXlDck8yV2lPeVd0T3lhbEM0S0NpTWpJeURzbXBUc3NxM3NuWVFnN0xLWTY2YXNJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKcVU3TEt0N0oyRUlPeXltT3Vtck8yVm1PcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPeVZpT3VDdE1LMzdKeWc2NCtFQ2dvakl5TWc3SU9JNjZHYzdKcTBJT3V5aE95Z2hPeWR0Q0RzdHB6c2k1enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlPeVhoZXVOc095ZHRPMksNCnVDRHRtNFFnN0oyMDdKcXBJT3F3Z091S3BlMlZxZXVMaU91THBDNEtMU0RzZzRnZzY3S0U3S0NFN0oyMElPdUNtT3labE95V3RPeWFsQzRnTHlEc2w0WHJqYkRzbmJUdGlyanRsWmpycWJRZzdJT0lJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3SjIwN0pxcDdKMkVJT3ljaE8yVnRDRHNsYjNxdElBZzY0K1o3SjJZNnJDQUlPMlZoT3lhbE8yVnFldUxpT3VMcEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNpNXpzbnBIdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbnFYc2k1enFzSVFnNjYrNDdJS3M3SnFwN0p5ODY2R2NJT3lla091UG1TRHJvWnpxdDdqc2xZVHNtNE1nNjVDWTdKZUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPeVlwT3VlcSt1UG1leVZpQ0RzZ3F6c21xbnRsWmpzcDRBZzdKV0s3SldFSU91aG5PcTN1T3lWDQpoT3liZyt1UWtPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1RzbFlqc25ZUWc3SnlFN1pXMElPdTVoT3V3Z091eWlPMll1T3VsdkNEcnM0RHFzcjN0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEc2xZanNvSVR0bFp3ZzdJS3M3SnFwN0oyRUlPeWNoTzJWdENEcnVZVHJzSURyc29qdG1ManJwYndnNjdDVTZyK1VJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc2N08wN0pXSUlPeUVuT3U1aE95S3BBb0tJeU1qSU9xeXZldTVoT3VsdkNEcXNKenNpNXp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzZySzk2N21FNjZXOElPeUxuT3lla2UyVm9PcTVqT3lhbEQ4S0NpTWpJeURxc3IzcnVZVHJwYndnN1pXMDdLQ2M3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU9xeXZldTVoT3VsdkNEdGxiVHNvSnp0bGFEcXVZenNtcFEvQ2dvakl5TWc2cml3NnJpdzZyQ0FJT3lZcE8yVWhPdWR2T3lkdUNEc2c0SHRnNXpzbm9Ycg0KaTRqcmk2UXVJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbllRZzdabVY3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3E0c09xNHNPcXdnQ0RyaEtUdGlyanNtNHp0Z2F6c2w1QWc3SmV3NnJLdzY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJpdzZyaXc3SjJZSU95WHNPcXlzQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbUlIc2c0SHNuWVFnNjdhSTY1K3M3SmlrNjRxVUlPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0ppQjdJT0I3SjJFSU91MmlPdWZyT3lZcE9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3kzcU95R2pPMlZtT3lMcENEcXNyM3NtckFnN0l1ZzdMS3Q3WldZN0l1Z0lPdUMNCnRPeWFxZXlkZ0NEc29JRHNucVhya0pqc3A0QWc3SldLN0lxMTY0dUk2NHVrTGdvdElPeTNxT3lHak8yVm1PdXB0Q0RzaTZEc3NxM3RsWndnNjRLMDdKcXA3SjIwSU95Z2dPeWVwZXVRbU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9DaTBnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9JQzhnN0xlbzdJYU03WldZNjZtMElPeWVoZXVncGUyVm5DRHJnclRzbXFuc25iUWc3SUtzNjUyODdLQzQ3SnFVTGdvS0l5TWpJeURxc0lEc25iVHJrNXdnN0ppSTdJdWNJQ2gxZUMxM2NtbDBhVzVuTG0xazdKZVE3SVNjSU95WXJ1cTVnQ0RpZ0pRZzZyZWM3TG1aN0p5ODY2R2NJT3lla091UG1lMlpsQ0RycXJzZzdaV1k2NHFVSU91c3VPeWVwU0RzbnF6cXRhenNoTEVnN0lLczY2R0FLUW9LSXlNaklPeWVrT3VQbWV5d3FPdWx2Q0Rxc0lEc3A0RHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB3b3RJT3lla091UG1leXdxT3F3DQpnQ0Rzbm9qcmdwanNtcFEvQ2dvakl5TWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdWx2Q0RzbHJ6cnA0anNsS2tnNjRLMDZyT2dJT3F6aE95TG5PdUNtT3lhbEQ4S0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTTY0cVVJT3lXdk91bmlPeWR1T3F3Z095YWxEOEtDaU1qSXlEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvY2c2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1Q2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUhJT3F3Z095bmdDRHJpNlRzaTV3ZzdabVY3SjI0N1pXZzZyS003SnFVTGdvS0l5TWpJT3k1dE91VG5PdWx2Q0R0bGJUc3A0RHRsWmpzaTV6cXNxRHNsclRzbXBRL0NpMGc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOEtDaU1qSXlEc2k1enNucEh0bFpqc2k1enJpcFFnNjdhRTdKZVE2cktNSURVc01EQXc3SnVRN0oyRUlPdVRuT3VncE95YWxDNEtMU0RzaTV6c25wSHRsWmpycWJRZ05Td3dNRERzbTVEcw0KbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUxnb3RJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFF1Q2dvakl5TWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVMZ290SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQzRLQ2lNakl5RHF1SWpzbmJ6cXVZenNwNEFnNjYrNDY0S3BJT3lMbkNEc2w3RHNzclFnN0xLWTY2YXM2NUNwNjR1STY0dWtMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUNxZXUyZ08yVm1PeUxuT3E0c0NEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUF2SU8yYmhPdTJpT3F5c095Z25DRHF1SWpzbGFIc25ZUWc2NEswN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lna09xeWdDRHF1TERxc0lUc2w1RHJpcFFnN0lTYzY3bUUNCjdJcWtJT3lkdE95YXFleWR0Q0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95TG9PdTJoT3ltblNEdG1aWHNuYmdnN0tDRTdKZVE2NHFVSU95R29lcTRpQ0Ryc0k4ZzZyS3c3S0NjNnJDQUlPdTJpT3F3Z08yVnFldUxpT3VMcEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU91emdPcXl2U0RzaTV3ZzdMcVE3SXVjNjdDeElPeWVyT3luZ09xNGlleWRnQ0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtDaU1qSXlEc2c0SHJpN1FnN1pLSTdLZUlJTzJXcGV5RGdleWRoQ0RzDQpuSVR0bGJRZzdZYTE3Wm1VSU91Q3RPeWFxZXlkdENEcmhibnNuWXpya0tucmk0anJpNlF1Q2kwZzY0MlVJT3lpaSt5ZGdDRHNnNEhyaTdUc25ZUWc3SnlFN1pXMElPMkd0ZTJabENEcmdyVHNtcW5zbllBZzY0VzU3SjJNNjQrODdKcVVMZ29LSXlNaklPcXpvT3F3bmV1TG1PeWRtQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkZ0NEcXVMRHJvWjBnNnJTQTY2YXM2NUNwNjR1STY0dWtMZ290SU95ZHRPeWduT3UyZ08yRXNDRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWR0Q0RxdUxEcm9aM3JqN3pzbXBRdUNnb2pJeU1nN0xLdDdJYU02NFdFN0oyQUlPeUVuT3U1aE95S3BDRHFzSURzbm9Yc25iUWc2N2FJNnJDQTdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzc3Ezc2hvenJoWVRzbllRZzdKeUU3WldjSU95RW5PdTVoT3lLcE91S2xDRHNsWVRzcDRFZzdLU0E2N21FSU95a2tleWR0T3lYa095YQ0KbEM0S0NpTWpJeU1nNnJPRTdLQ1Z3cmZzbm9Ycm9LVUtDaU1qSXlEc2xZVHNuYlRybEpRZzY1aVE2NHFVSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWR0T3lEZ1NEc25wanJxcnNnN0o2RjY2Q2w3WldZN0plc0lPcXpoT3lnbGV5ZHRDRHNucURxdUlnZzdMS1k2NmFzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWVtT3VxdXlEc25vWHJvS1h0bGJUc2hKd2c2ck9FN0tDVjdKMjBJT3llb09xeXZPeVd0T3lhbEM0Z0x5RHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzdKNnM3SVNrN0tDVjdaV1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25iVHJyN2dnN0lLczdKcXBJT3lra2V5ZHVDRHNsWVRzbmJUcmxKVHNub1hyaTRqcmk2UXVDaTBnN0oyMDY2KzRJT3lUc09xem9DRHNub2pyaXBRZzdKV0U3SjIwNjVTVTdKaUk3SnFVTGlBdklPdUxwT3VsdUNEc2xZVHNuYlRybEpUcnBid2c3SjZGNjZDbDdaVzANCklPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2dxenNtcW50bGFBZzdJaVlJT3lYaHV1S2xDRHJ1WVRyc0lEcnNvanRtTGpzbm9Ycmk0anJpNlF1SU95WWdldXN1Q3dnN0lpcjdKNlFMQ0R0aXJuc2lKanJyTGpzbnBEcnBid2c3WStzN1pXbzdaV1k3SmVzSURqc25wQWc3SjIwN0lPQklPeWVoZXVncGUyVm1PeUxyZXlMbk95WXBDNEtMU0RzbUlIcnJMZ3NJT3lJcSt5ZWtDd2c3WXE1N0lpWTY2eTQ3SjZRNjZXOElPMlByTzJWcU8yVnRDQTQ3SjZRSU95ZHRPeURnU0Rzbm9Ycm9LWHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3llaGV1Z3BTRHFzSURyaXFYdGxad2c2cmlBN0o2UUlPeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnN0o2RjY2Q2w3WldnSU95SW1DRHNub2pyaXBRZzZyaUE3SjZRSU95SW1PdWx2Q0RyaEpqc2w0anNsclRzbXBRdUlDOGc2NEswN0pxcDdKMkVJT3loc09xNGlDRHNwSVRzbDZ3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEdGpJenNuYnpDdCtxeXNPeWduTUszDQo2cml3N1lPQUNnb2pJeU1nN1l5TTdKMjhJT3lhcWV1ZmlleWR0Q0RzdElqcXM3enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlERXdUVUlnN0oyMDdaV1k3SjJZSU8yTWpPeWR2T3VuakNEc2w0WHJvWnpyazV3ZzZyQ0E2NHFsN1pXcDY0dUk2NHVrTGdvdElERXdUVUlnN0oyMDdaV1lJTzJNak95ZHZPdW5qQ0RzbUt6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHRqSXpzbmJ3ZzdKcXA2NStKN0oyRUlPMlpsZXlkdU8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0dWs3SnEwNjZHYzY1T2M2ckNBSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyaTZUc21yVHJvWnpyazV6cnBid2c2NmVJN0xPazdKYTA3SnFVTGdvS0l5TWpJT3F5c095Z25PeVhrQ0RzaTZUdGpLanRsWmpzbUlEc2lyWHJpNGpyaTZRdUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SXVjNnJpd0lPdXdsT3VlamV1TGlPdUxwQzRLTFNEcXNyRHNvSnp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPcXlzT3lnbkNEcw0KaUpqcmk2anNuWVFnN1ptVjdKMjQ3WldZNnJPZ0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WldZN0plc0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xenRlcXdoT3lkaENEdG1aWHJzN1R0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BDRHNwSURydVlRZzdLU1I3SjZGNjR1STY0dWtMZ290SU95a2dPdTVoTzJWbU9xem9DRHNub2pyaXBRZzZyaXc2NHFsN0oyMDdKZVE3SnFVTGlBdklPeWhzT3E0aU91bmpDRHF1TERyaTZUcm9LUWc3S084N0lTNDdKcVVMZ29LSXlNaklPdVRzZXVoblNEcXNJRHJpcVh0bFp3ZzdMV2M2NHlBSU9xd25PeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHMNCmlyWHJpNGpyaTZRdUNpMGc2NDJVSU91VHNldWhuZTJWbU91Z3BPdXB0Q0RxdUxEc29iUWc3Wld0NjZxcDdKMkVJT3lDcmV5Z25PMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3kybE9xd2dDa0tDaU1qSXlEc3RwenJqNWtnN0pxVTdMS3Q3SjIwSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3TGFjNjQrWklPeWFsT3l5cmV5ZGhDRHNvSkhzaUpqdGxvanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cks5NjdtRUlPeURnZTJEbk91bHZDRHRtWlhzbmJqdGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU9xeXZldTVoQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnDQo3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPeWdoTzJabU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHNtYmpzdHB3ZzY2cW82NU9jNjZHY0lPdXdsT3EvZ09xNWpPeWFsRDhLQ2lNakl5RHJzS25yckxnZzdKaUk3Slc5N0oyMElPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnNLbnJyTGdnN0ppSTdKVzk3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEcnVZVHJzSURyc29qdG1MZ2dOZTJhakNEc21LVHJwWmpyb1p3ZzZyT0U3S0NWN0oyMElPeWVvT3E0aUNEc3NwanJwcXpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJRFh0bW93ZzdKNlk2NnE3SU95ZWhldWdwZTJWdE95RW5DRHFzNFRzb0pYc25iUWc3SjZnNnJLODdKYTA3SnFVTGlBdklPdTVoT3V3Z091eWlPMll1T3VsdkNEc25xenNoS1Rzb0pYdGxaanJxYlFnNjR1azdJdWNJT3lkdE95YQ0KcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3SUNqc2w0YnNsclRzbXBRZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUXBDZ29qSXlNZzY3TzQ3SjI0SU95ZHVPeW1uZXlkaENEdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0Ryczdqc25iZ2c3SjI0N0thZDdKMkVJTzJWbU91cHRDRHJxcWpyazZBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95ZHRPdXBsT3lkdkNEc25ianNwcDBnN0tDRTdKZVE2NHFVSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lkdE91cGxPeWR2Q0RzbmJqc3BwM3NuWVFnNjZlSTdMbVk2Nm0wSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3kvb08yUHNPeWRnQ0Ryb1p6cXQ3anMNCm5iZ2c3WnVFN0plUTY2ZU1JT3lDck95YXFTRHFzSURyaXFYdGxhbnJpNGpyaTZRdUNpMGc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeS9vTzJQc095ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnI3anNoTEhyaFlUc25wRHJpcFFnNjdPMDdaaTQ3SjZRSU91UG1leWRtQ0RzbDRic25iUWc2ckt3N0tDYzdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnNjdPMDdaaTQ3SjZRNnJDQUlPdVBtZXlkbU8yVm1PdXB0Q0Rxc3JEc29KenRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxJVHJvWnp0bFlUc25ZUWc2NU94NjZHZDdaV1k3S2VBSU95Vml1eWN2T3VwdENEc25iVHNtcW5zbmJRZzdLQ2M3WldjNjVDcDY0dUk2NHVrTGdvdElPMlVoT3Vobk8yVmhPeWRoQ0RyazdIcm9aM3RsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbGJFZzY3S0U3S0NFN0oyMElPdUNydXlWaENEc25ienJ0b0FnNnJpdzY0cWw3SjIwDQpJT3lnbk8yVm5PdVFxZXVMaU91THBDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXWTY2bTBJT3VxcU91VG9DRHF1TERyaXFYc25ZUWc3Sk80SU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzY3aVU2Nk9vN1lpczdJcWs2ckNBSU9xNnZPeWd1Q0Rzbm9qc2xyUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMZ290SU91NGxPdWpxTzJJck95S3BPdWx2Q0Rzdkp6cnFiUWc2cml3NnJpdzY2VzhJT3lYc09xeXNPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU91NWhPeURnU0RzbDdEcm5iM3NzcGpxc0lBZzY1T3g2NkdkNjVDWTdLZUFJT3lWaXV5Vm1PeUt0ZXVMaU91THBDNEtMU0RydVlUc2c0RWc3SmV3NjUyOTdMS1k2Nlc4SU91VHNldWhuZTJWbU91cHRDRHF1TFRxdUludGxhQWc2NVdNSU91NW9PdWx0T3F5akNEc2w3RHJuYjNyazV6cnByUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzdHB6c25vVWc3TG0wNjVPYzZyQ0FJT3VUc2V1aA0KbmV1UW1PeW5nQ0RzbFlyc2xZUWc3SUtzN0pxcDdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0xhYzdKNkZJT3k1dE91VG5PdWx2Q0RyazdIcm9aM3RsWmpycWJRZzY3Q1U2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3SUNqc21ZVHJvNHdnN0pXSTY0SzBLUW9LSXlNaklPMmFqT3lia09xd2dPeWVoZXlkdENEc21ZVHJvNHpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNnJDQTdKNkY3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEc21JanNsYjNzbmJRZzdMZW83SWFNNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95WWlPeVZ2ZXlkaENEc3Q2anNob3p0bG9qc2xyVHNtcFF1Q2dvakl5TWc2Nnk0N0oyWTZyQ0FJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdJaWM3TENvN0tDQjdKeTg2NkdjSU91THRldXpnT3VUbk91bXJPcXlvT3lLdGV1TGlPdUxwQzRLTFNEcnJManNuWmpycGJ3ZzdLQ1I3SWlZN1phSTdKYTANCjdKcVVMaUF2SU95SW5PeUVuT3VNZ091aG5DRHJpN1hyczREcms1enJwclRxc296c21wUXVDZ29qSXlNZzdJU2s3S0NWN0oyMElPeTBpT3E0c08yWmxPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNoS1Rzb0pYc25ZUWc3TFNJNnJpdzdabVU3WmFJN0phMDdKcVVMZ29LSXlNaklPdTVoT3V3Z091eWlPMll1T3F3Z0NEcnM0RHFzcjNya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJT3V3bE9xL3FPeVd0T3lhbEM0S0NpTWpJeURzbmJqc3BwM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdU95bW5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1qSU95NmtPeWp2T3lXdk8yVm5DRHFzcjNzbHJRZ0tPeW5pT3VzdUNEc25xenF0YXpzaExFcENnb2pJeU1nN0phNDdLQ2NJT3V3cWV1c3VPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Ryc0tucnJMZ2c2NEtnN0tlYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SmEwDQo2NWFrSU91d3FldXlsZXljdk91aG5DRHNuYmpzcHAzdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SjI0N0thZElPdXdxZXV5bGV5ZGhDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPcXlzT3lnbk8yVm1PeUxwQ0RzdWJUcms1enJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rxc3JEc29KenRsYUFnN0xtMDY1T2M2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0p1UTdaV1k3SXVjNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsWmpzaExqc21wUXVDaTBnN0p1UTdaV1k2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWp2T3lHak91bHZDRHNsWXpxczZBZzZyT0U3SXVnNnJDQTdKcVVQd290SU95anZPeUdqT3VsdkNEc2xZenFzNkFnN0o2STY0S1k3SnFVUHdvS0l5TWpJeURycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQW9LSXlNaklPcTRzT3F3aENEcg0KcDR6cm80enJvWndnN0oyMDdKcXA3SjIwSU95a2tleW5nT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzbmJUc21xa2c2cml3NnJDRTdKMjBJT3VCbmV1Q21PeUVuQ0RzcDREcXVJanNuWUFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SnFwNjUrSklPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0lEc25xWHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lnZ095ZXBlMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVDZ29qSXlNZzdZYTE3SXVnSU95WXBPdWxtT3VobkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXWTdKaUE3SXExNjR1STY0dWtMZ290SU8yR3RleUxvT3lkdENEc201RHRtWnp0bFpqc3A0QWc3SldLN0pXRUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWcNCjZyYU03WldjSU91MmdPeWhzZXljdk91aG5DRHNvSkhxdDd6c25iUWc2ckd3NjdhQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SmEwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHF0b3p0bFp6c25ZUWc3SnFVN0xLdDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc3SU9CN1ptcElPeVZpT3VDdENBb011dUxxQ0RxdGF6c29iQXBDZ29qSXlNZzdKNkY2NkNsN1pXWTdJdWdJT3lqdk95R2pPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc2NHVrN0l1Y0lPMlpsZXlkdUNEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0tPODdJYU02Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3VMcE95TG5DRHRtWlhzbmJqdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWFsT3l5cmUyVm1PeUxvQ0R0anBqc25iVHNwNERycGJ3ZzdMQys3SjJFSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdZNlk3SjIwN0tlQTY2VzhJT3l3DQp2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95anZPeUdqT3VsdkNEdG1aWHNuYmp0bFpqcXNiRHJncGdnN1ptSTdKeTg2NkdjSU95ZHRPdVBtZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjQrWjdKMjg3WldjSU95YWxPeXlyZXlkdENEc3NwanJwcXdnN0tTUjdKNkY2NHVJNjR1a0xpRHNucURzaTV3ZzdadUVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc2ckNaN0oyQUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanFzNkFnN0o2STdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYlRyc3FUdGlyanFzSUFnN0tLRjY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdE91eXBPMkt1T3F3Z0NEcmdaM3JncXpzbHJUc21wUXVDZ29qSXlNZzdZT0k3WWUwSU95TG5DRHJxcWpyazZBZzY0Mnc3SjIwN1lTdzZyQ0FJT3lDcmV5Z25PdVFtT3Vwc0NEcnM3WHF0YXp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0Sw0KTFNEdGc0anRoN1R0bFpqcnFiUWc2NnFvNjVPZ0lPdU5zT3lkdE8yRXNPcXdnQ0RzZ3Ezc29KenJrSmpxczZBZzY0dWs3SXVjSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95Z2xldW5rQ0R0ZzRqdGg3VHRsYURxdVl6c21wUS9DZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeURnZTJacVNEc2xZanJnclFwQ2dvakl5TWc2N2FBN0o2c0lPeWtrU0Ryc0tucnJManNucERxc0lBZzZyQ1E3S2VBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91MmdPeWVyQ0RzcEpIc2w1QWc2N0NwNjZ5NDdKNlE2ckNBSU95ZWlPeVhpT3lXdE95YWxDNGdMeURzbUlIc2c0SHNuWVFnN1ptVjdKMjQ3WlcwSU91enRPeUV1T3lhbEM0S0NpTWpJeURxc3IzcnVZUWc3WlcwN0tDY0lPcTJqTzJWbk95ZHRDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZySzk2N21FSU8yVnRPeWduQ0RxdG96dGxaenNuYlFnN1pXRTdKcVU3WlcwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHNtcFRzc3EzdGxiUWcNCjdLTzg3SVM0N0pxVUxnb0tJeU1qSU8yWmxPeWVyQ0Rxc0pEc3A0RHF1TEFnNjdDdzdZU3c2NmFzNnJDQUlPdTJnT3loc2UyVnFldUxpT3VMcEM0S0xTRHRtWlRzbnF3ZzZyQ1E3S2VBNnJpd0lPdXdzTzJFc091bXJPcXdnQ0RzbHJ6cnA0Z2c3SmVHN0phMDdKcVVMaUF2SU91d3NPMkVzT3Vtck91bHZDRHF0WkRzc3JUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHN0cFhzbGIwZ0t5RHF1STNzb0pVZzdLQ0U3Wm1ZSUNqcmtaQWc2Nnk0N0o2bElPS0draURxdUkzc29KWHRtSlVnN1pXY0lPdXN1T3llcFNrS0NpTWpJeURycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0RyDQpzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRtSnp0ZzUwZzdKZUc3SjIwSU9xd2dPeWVoZTJWb09xNWpPeWFsRDhnN0tlQTZyaUlJT3lMb095eXJlMlZtT3luZ0NEc2xZcnNuTHpycWJRZzdKdXc3THUwSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzcDREcXVJZ2c3SXVnN0xLdDdaV1k2Nm0wSU95YnNPeTd0Q0R0bUp6dGc1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0wrZzdZK3dJT3lYaHV5ZHRDRHFzckRzb0p6dGxhRHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1Q0RzdjZEdGo3RHNuWVFnNjdDYjdKMkVJT3lJbUNEc2w0YnNsclRzbXBRdUNpMGc3TCtnN1krdzdKMkVJT3V3bSt5Y3ZPdXB0Q0RyalpRZzdLQ0E2NkMwN1pXWTZyS01JT3F5c095Z25PMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95VmpPdW12Q0RzbDRic25iUWc3SXVjN0o2UjdaV2c2cm1NN0pxVQ0KUHlEc2xZenJwcnpzbllRZzdMeWM3S2VBSU95Vml1eWN2T3VwdENEc3BKSHNtcFR0bFp3ZzdJYU03SXVkN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU95VmpPdW12T3lkaENEc3ZKenJxYlFnN0tTUjdKcVU3WldjSU95R2pPeUxuZXlkaENEcnNKVHJvWndnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0o2UTY0K1o3SjIwN0xLMDY2VzhJT3VUc2V1aG5lMlZtT3luZ0NEc2xZcnFzNkFnNjRTWTdKYTA2ckNJNnJtTTdKcVVQeURyazdIcm9aM3RsWmpzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc25wRHJqNW5zbmJUc3NyVHJwYndnNjVPeDY2R2Q3WldZNjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJzN2dnNnJPRTdKVzk3SjJZSU95Y29PeWR2TzJWbkNEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3lkdk91d21PcTBnT3Vtck95ZWtPdWgNCm5DRHF0b3p0bFp6cnM0RHFzcjNzbllRZzdaV1k3SXVrSU95SW1DRHNsNGJzbHJUc21wUXVJT3lkdk91d21DRHF0SURycHF6c25wRHJvWndnNnJhTTdaV2NJT3V6Z09xeXZleWRoQ0RzbTVEdGxaanNpNlFnNnJLOTdKcXdJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla0NEcXRvenRsWnpzbllRZzdLZUE3S0NWN1pXMElPeWp2T3lMb0NEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVm5DRHJrcVFnN0oyODY3Q1lJT3EwZ091bXJPeWVrT3VobkNEcnM0RHFzcjN0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLTFNEcmk2VHJwYmdnN0lLczY1Nk03SjJFSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcm9ad2c3S2VBN0tDVjdaV1k2Nm0wSU91emdPcXl2ZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ289DQo6OkdVSURFOjoNCkl5QlZXQ0JYY21sMGFXNW5JT3F3Z095ZHRPdVRuQTBLRFFvakl5QXhMaUR0bGJUc21wVHNzclFOQ2cwSzdLQ2M3WktJSU95VmlPeWRtQ0RycXFqcms2QWc2Nnk0NnJXczY0cVVJQ2Z0bGJUc21wVHNzclFuNjZHY0lPeU5xT3lhbEM0TkN1eWR2T3EwZ095RXNTRHNub2pyaXBRZzdJS3M3SnFwN0o2UUlPcXl2ZTJYbU95ZGhDRHJwNHpyazZRZzdJaVlJT3llaU91UGhPdWhuU0FxS3V5RGdlMlpxU3dnNjZlbDY1Mjk3SjJFSU91MmlPdXN1TzJWbU9xem9DRHJxcWpyazZBZzY2eTQ2cldzN0plUUlPMlZ0T3lhbE95eXRPdWx2Q0Rzb0lIc21xbnRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHJzN1RyZzRYcmk0anJpNlFnNG9hU0lPdXp0T3VDdk9xeWpPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ01pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzQTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSU95MW5PdU1nTzJWbkNBcUt1dUtwZXVQbWUyWWxTRHJyTGpzbnFVcUt1eWRoQ0RzamFqc283enNoTGpzDQptcFF1SU95SW1PdVBtZTJZbFNEcnJManNucVhzbllBZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TVMzc2lKanJqNW50bUpVdDY2eTQ3SjZsN0oyRUxleU5xT3VQaEMzcmtKanJpcFF0NnJLOTdKcXdLZXlYa0NEdGxiVHJpN250bGFBZzY1V002NmVNSU95VHNPdUtsQ0Rxc293ZzdLS0w3SldFN0pxVUxnMEtEUW9qSXlNZzY1Q1E3SmEwN0pxVUlPS0draUR0bG9qc2xyVHNtcFFOQ2cwSzdKaUlLUTBLTFNEc2hLVHNvSlhya0pEc2xyVHNtcFFnNG9hU0lPeUVwT3lnbGUyV2lPeVd0T3lhbEEwS0RRb2pJeU1nSjM3c2w0Z25JT3U1dk9xNHNBMEtEUXJzbUlncERRb3RJT3V3bE91QWpPeVhpT3lXdE95YWxDRGlocElnNjdDVTZyK283SmEwN0pxVURRb05DaU1qSXlEcmo1bnNncXdnNjdDVTZyK1U3Sk93NnJpd0RRb05DdXlZaUNrTkNpMGc2NGFTN0pXRTdLR003SmEwN0pxVUlPS0draURzbUt6cm5wRHNsclRzbXBRTkNnMEtLaW9xRFFvTkNpTWpJRE11SU9xNGpleWdsZXlnZ1NEcnA1RHRsWmpxdUxBTg0KQ2cwSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEcnRvRHNvSlhzb0lFZzdMdWs2NjZrNjR1STdMeUE3SjIwN0lXWTdKMkVJT3kxbk91TWdPMlZuQ0RzcElUc25iVHFzNkFnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXlkaENEc2phanNvN3pzaExqc21wUXVEUXJydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVE10NjdhQTdLQ1Y3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzamFqc21wUXVEUW9OQ3V5WWlDQTZJT3lWaUNEcmo3enNtcFFzSU95WGh1eVd0T3lhbENBb1dDa2c0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSXlEc2w0YnNsclRzbXBRZzRvYVNJT3llaU95V3RPeWFsQTBLRFFyc21JZ3BEUW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxaanF1TEFnN0tDRTdKZVE2NHFVSU9xd2dPeWVoZTJWb0NEc2lKZ2cNCjdKZUc3SmEwN0pxVUlPS0draURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXMDdKVzhJT3F3Z095ZWhlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVURRb05DaU1qSXlEc2w1RHJuNndnNjZtVTdJdWM3S2VBRFFvTkN1eVhrT3VmckNEc2c0SHRtYW5zbDVEc2hKenJqNFFnSXUyVnRPcXlzQ0Ryc0tucnNwVWk3SjJFSU91b3ZPeWdnQ0RzbFl6cm9LVHNvN3pyaXBRZzZyaU43S0NWN1ppVklPcTFyT3loc091aG5DRHNqYWpzbXBRdURRb05DdXlZaUNrTkNpMGc3S2VBNnJpSUlPdXloT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0ZzRvYVNJT3lWc2V5ZGhDRHNsNFhyamJEc25iVHRpcmp0bGJUc283enNoTGpzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeTFuT3lMDQpvQ0Ryc29Uc29JVHNuYlFnN1pXRTdKcVU3WlcwN0pxVUxnMEtEUW82T2pvZ2RHbHdJTzJNbmV5WGhTRHJzb1R0aXJ6c25ZQWdXemd1SU8yTW5leVhoVjBnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbEEwSzdZeWQ3SmVGS091THBPeWR0T3lXdk91aG5PcTN1Q2tnNjdLRTdZcThJT3VzdU9xMXJPdUtsQ0RzbFlUcm5wZ2dLaW80TGlEdGpKM3NsNFVxS2lEc2hMbnNoWmdnNnJlYzdMbVo3SjJFSU91VXNPdWR2T3lhbENEaWdKUWc3WWExNjdPMDY0cVVJRnZ0bVpYc25iaGRMQ0RzbUlndjdKV0U2NHVJN0ppa0lPMk1rT3VMcU95ZGdDQmI3SldFNjR1STdKaWtYY0szVyt1RXBGMHNJT3VQbWV5ZWtTRHNuS0RyajRUcmlwUWdXK3kzcU95R2pGM0N0MXZyajVuc25wRmRMaUFpN0xlbzdJYU1JdXVLbENEcmo1bnNucEVnNjdLRTdZcTg2ck84SU95bm5leWR2Q0RybFl6cnA0d2c3Sk93NnJPZ0xDQWk2NHVyNnJpd0lNSzNJT3VQbWV5ZWtTTHNzcGpybjd3ZzdLZWQ3SjIwSU95VmlDRHJwNTdyaXBRZzdLR3c3WldwN0oyQQ0KSU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFvNk9qb05DZzBLSXlNaklPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzdKaUlLUTBLTFNEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzRvYVNJT3lWdmVxMGdPeVhrQ0RyajVuc25aanRsWmpycWJRZzY2cW83SjZFN0tlQTdKdVE2cmlJN0oyRUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvakl5TWc3WmljN1lPZElPdU1nT3lEZ1NEc2xZanJnclFOQ2cwS0tpcnNoSnpydVlUc2lxVHJpcFFnN0pPNElPeUltQ0Rzbm9qc3A0RHJwNHdzSU8yS3VleWdsU0R0bUp6dGc1M3NuWUFnNjdDYjdKMkVJT3lJbUNEc2w0YnNuWVFnNjVXTUlPS0draURxdUkzc29KWHRtSlVnNjZ5NDdKNmwNCjdKeTg2NkdjSU95TnFPeWFsQzRxS2cwSzdJS3M3SnFwN0o2UTY0cVVJT3VzdU9xMXJPdWx2Q0Rxdkx6cXZMenRub2dnN0oyOTdLZUFJT3lWaXVxem9DRHRtNUhzbHJUcnM3VHF1TEFvN0lxazdMcVVLU0RybFl6cnJManNsNUFzSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzazdEcnFiUWc3S0NjN1pLSUlPeWdoT3l5dE91bHZDRHNrN2dnN0lpWUlPeVhodXVMcE9xem9DRHNtS1R0bGJUdGxaanF1TEFnN0ltczdKdU03SnFVTGcwS0RRcnNtSWdwRFFvdElPcXpoT3lpakNEcXNKenNoS1FnN1ppYzdZT2Q3SjJBSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnTkM0MUpTRHF1SWpycHF3ZzdaaWM3WU9kNjZlTUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ05DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0QTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSUNkKzdJdWM2cktnN0phMDdKcVVQeWNzSUNmc2k1enJncGpzbXBRL0p5d2dKMzdxdTVnbklPcXdtZXlkDQpnQ0Rxczd6cmo0VHRsWndnNnJLOTdKYTA2Nlc4SU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFyc3RaenJqSUR0bFp3ZzdMcVE3S084N0phODdaV1k2ck9nSU95NW5PcTN2TzJWbkNEcnA1RHRpS3pycGJ3ZzdKT3c2NHFVSU9xeWpDRHNvb3ZzbFlUc21wUXVEUXJxc3Izc2xyVHJpcFFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNaTNxc3Izc2xyVHJwYnd0N0kybzY0K0VMZXVRbU91S2xDM3FzcjNzbXJBcDdKZVFJTzJWdE91THVlMlZvQ0RybFl6cnA0d2c3STJvN0pxVUxnMEtEUW9qSXlNZzY0K1o3SUtzN0plUTdJU2NJQ2QrN0l1Y0p5RHJ1YnpxdUxBTkNnMEs3SmlJS1EwS0xTRHN1YlRyazV6cnBid2c3WlcwN0tlQTdaV1k3SXVjNnJLZzdKYTA3SnFVUHlEaWhwSWc3TG0wNjVPYzY2VzhJTzJWdE95bmdPMlZvT3E1ak95YWxEOE5DaTBnN0l1YzdKNlI3WldZN0l1YzY0cVVJT3UyaE95WGtPcXlqQ0ExTERBd01PeWJrT3lkaENEcms1enJvS1RzbXBRdUlPS0draURzaTV6c25wSHRsWmpycWJRZw0KTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnMEtEUW9qSXlNZ0orcXpoT3lMbk91THBDY2c0b2FTSUNmc25vanJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKNlE2NCtaN0xDbzY2VzhJT3F3Z095bmdPcXpvQ0RxczRUc2k1enJncGpzbXBRL0lPS0draURzbnBEcmo1bnNzS2pxc0lBZzdKNkk2NEtZN0pxVVB3MEtMU0RycDZUcmk2d2c2N08wN1plWTY2T01JT3lXdk91bmlPeVVxU0RyZ3JUcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdUtsQ0RzbHJ6cnA0anNuYmpxc0lEc21wUS9JQ29vNjR1bzdJaWNJT3k1bU8yWm1PeWR0Q0RzbFlUcmk0anJuYndnNjZ5NDdKNmw3SjJFSU95RGlPdWhuQ0RzazdRZzdJS3M2NkdBN0ppSTdKcVVLU29OQ2cwS0l5TWpJQ2ZzbDZ6c3JZanJpNlFuSU9LR2tpQW43Wm1WN0oyNDdaV1k2NHVrTENEcnJMdnJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUg2ckNBN0tlQUlPdUwNCnBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVJT0tHa2lEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvZnFzSURzcDRBZzY0dWs3SXVjSU8yWmxleWR1TzJWb09xeWpPeWFsQzROQ2cwS0l5TWpJQ2ZxdTVnbklPS0draUFuN0plUTZyS01KdzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1PcTdtQ0RyZ3FEc2xZVHFzSURxczZBZzdKNkk3SmEwN0pxVUxpRGlocElnN1ptTjZyaTQ2NCtaNjR1WTdKZVE2cktNSU91Q29PeVZoT3F3Z09xem9DRHNub2pzbHJUc21wUXVEUW9OQ2lNakl5RHFzcjNzbHJUcnBid2c2N3FRN0oyRUlPdVZqQ0RzbHJUc2c0bnRsWndnNnJLOTdKcXdEUW9OQ3V5Q3JPeWFxZXlla095ZG1DRHNvSlhyczdUcnBid2c2N0NiNjRxVUlPeW5pT3VzdU95WGtPeUVuQ0RxdUxEcXM0VHNvSUhzbkx6cm9ad2dKMzdzaTV3bjY2VzhJT3U2a095ZGhDRHJsWXdnNjZ5NDdKNmw3SjIwSU95V3RPeURpZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLS2lydGpJenNsWVh0DQpsWmpxczZBZzdJdTI3SjJBSU95Z2xldXp0T3VsdkNBbjdLTzg3SmEwSit1aG5DRHNqYWpzaEp3ZzY2eTQ3SjZsN0oyRUlPeURpT3VocmVxeWpDRHNqYWpyczdUc2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNsclRybHFRZzY2cXA3S0NCN0p5ODY2R2NJT3VNZ095Mm5PdXdtK3ljdk95TG5PdUNtT3lhbEQ4ZzRvYVNJT3VNZ095Mm5DRHJxcW5zb0lIc25iUWc2NnkwN0plSDdKMjQ2ckNBN0pxVVB3MEtMU0RzbHJUcmxxUWc3SjIwN0p5ZzY2R2NJT3lMb09xem9PMlZtT3lMbk91Q21PeWFsRDhnNG9hU0lPeUxvT3F6b0NEc25iVHNuS0RycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lFdU95YWxDNE5DZzBLS2lvcURRb05DaU1qSURVdUlDZDc2NnFGN0lLc2ZTQXJJSHZycW9Yc2dxeDlKeURzazdEc3A0QWc3SldLNnJpd0RRb05DaU1qSXlEdGxaenNucERzbHJRZzdaS0E3SmEwN0pPdzZyaXdEUW9OQ3UyVm5PeWVrT3lXdENEcnFvWHNncXpycGJ3ZzdaS0E3SmEwN0lTY0lPdVBtZXlDckNEdG1KWHRnNXpyb1p3Zw0KN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdKMjA3SjZRSU8yWm1PdTJpT3lkaENEcnNKdnNsWmpzbHJUc21wUWc0b2FTSU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRTkNpMGc2NEswN0oyOElPeTV0T3VUbk9xd2t1eWR0Q0Rxc3JEc29KenJrS0FnN0ppSTdLQ1Y3SjIwN0plUTdKcVVJT0tHa2lEcmdyVHNuYnpzbllBZzdMbTA2NU9jNnJDU0lPdUNtT3F3Z091S2xDRHJncURzbmJUc2w1RHNtcFFOQ2cwS0l5TWpJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclRzazdEcXVMQWc3SmEwNjZDazdKcTRJT3F5dmV5YXNBMEtEUW9uZSt1cWhleUNySDNxc0lBZ2UrdXFoZXlDckgzdGxiVHNoSnduSU8yWWxlMkRuT3Vobk91bmpDRHRrb0RzbHJUc3BKanJqNFFnNjQyVUlPeTZrT3lqdk95V3ZPMlZtT3F5akNEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2NJT3Exck91bnBPMlZtT3luZ0NEcnFydnQNCmxvanNsclRzbXBRZzRvYVNJT3llbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3ZzZyV3M2NmVrN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEEwS0RRb3FLaW9OQ2cwS0l5TWdOaTRnN1pHYzZyaXdJTzJHdGV5ZHZBMEtEUW9qSXlNZzY1Q1k3SmEwN0pxVUlDaFlLU0RpaHBJZzY0Kzg3SnFVSUNoUEtRMEtEUXJycXFqcnNKVHNuYndnN1ptVTY2bTA3SjJZSU95aWdleWRnQ0RxczdYcXNJVHNuWVFnNnJPZzY2Q2s3WlcwSUNmcmtKanNsclRzbXBRbjY0cVVJT3VxcU91UmtDQW42NCs4N0pxVUordWhuQ0R0aHJYc25ienRsYlRzaEp3ZzdJMm83S084N0lTNDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ055NGc2NEtnN0tlY3dyZnNpNXpxc0lUQ3QreUlxK3lla0NEdGtaenF1TEFOQ2cwSzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt1eWlPMll1T3VLbENEc2xZVHJucGdnN1ppVjdJdWQ3Snk4NjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc21wUXVEUW9OQ2lNakl5RHJncURzcDV6Q3QreUxuT3F3aE1LMzZyaXc2ckNFDQpEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzY0S2c3S2VjSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRVlDQXZJT3lucCtxeWpDQmdUVTB1UkVSZ0lId2dNakF5TlM0d01TNHdNU3dnTWpVdU1ERXVNREVnZkEwS2ZDRHNpNXpxc0lRZ2ZDRHF1TERyczdnZ1lFaElPazFOT2xOVFlDQXZJT3lucCtxeWpDQmdTRWc2VFUxZ0lDanNtS1Rzb0lRdjdKaWs3WnVFSU95VmlDRHNsSUFwSUh3Z01UUTZNekE2TVRFc0lERXpPak13SUh3TkNud2c2cml3NnJDRUlId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVmbGxaV1ZrdVRVMHVSRVJnSUM4ZzdLZW42cktNSUdCWldWbFpMazFOTGtSRWZrMU5Ma1JFWUNCOElESXdNalV1TURFdU1ERitNakF5TlM0d01TNHpNU3dnTWpBeU5TNHdNUzR3TVg0d01TNHpNU0I4RFFwOElPdUNvT3lubkNBcklPeUxuT3F3aENCOElHQlpXVmxaTGsxTkxrUkVJRWhJT2sxTllDQjhJREl3TWpVdQ0KTURFdU1ERWdNVFE2TXpBZ2ZBMEtmQ0RzbXBUc25id2dmQ0JnV1ZsWldTNU5UUzVFUkNqc21wVHNuYndwWUNEaWdKUWc3SnVVTCsyWmxDL3NpSmd2NjZxcEwrcTRpQy90aHFBdjdKMjhJSHdnTWpBeU5TNHdNUzR3TVNqc2lKZ3BJSHdOQ2cwS0tpcnNpNXpxc0lRZzdKaUk3Sm00S2lvNklPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDQmc3SmlrN0tDRUwreVlwTzJiaENCSU9rMU5ZT3lkaENEc2phanJqNFFnNjQrODdKcVVMZzBLN0ppSUtTRHNtS1R0bTRRZ01Ub3dNQTBLRFFvakl5TWc2Nnk0N0o2bElPeUdqU0RzbDdEc201VHNuYndOQ2cwSzY2eTQ3SjZsSU95VmlPeVhrT3lFbk91S2xDQXFLdXlibE1LMzdKMjhJT3lWbnV5ZG1DQXc3SjJFSU91NXZPcXpvQ29xSU95TnFPeWFsQzROQ2cwSzdKaUlLUTBLTFNBeU1ESTI2NFdFSURBNDdKdVVJREExN0oyOElPeWVoZXVMaU91THBDNGc0b2FTSURJd01qYnJoWVFnT095YmxDQTENCjdKMjhJT3llaGV1TGlPdUxwQzROQ2cwS0l5TWpJT3lEZ2V1TWdDRHNpNXpxc0lRZ0tPdUZ1T3kybk95YXFTa05DZzBLZkNEc29iRHFzYlFnZkNEdGtaenF1TEFnZkEwS2ZDMHRMUzB0TFh3dExTMHRMUzE4RFFwOElEWXc3TFNJSU91dnVPdW5qQ0I4SU91d3FlcTRpQ0Rzb0lRZ2ZBMEtmQ0EyTU91MmhDRHJyN2pycDR3Z2ZDQk82N2FFSU95Z2hDQjhEUXA4SURJMDdJdWM2ckNFSU91dnVPdW5qQ0I4SUU3c2k1enFzSVFnN0tDRUlId05DbndnTXpEc25id2c2Nis0NjZlTUlId2dUdXlkdkNEc29JUWdmQTBLZkNBeE11cXduT3libENEcnI3anJwNHdnZkNCTzZyQ2M3SnVVSU95Z2hDQjhEUXA4SURFeTZyQ2M3SnVVSU95ZHRPeURnU0I4SUU3cmhZUWc3S0NFSUh3TkNnMEs3SmlJS1NEcnNLbnF1SWdnN0tDRUxDQTE2N2FFSU95Z2hDd2dNdXlMbk9xd2hDRHNvSVFzSURQc25id2c3S0NFTENBMjZyQ2M3SnVVSU95Z2hDd2dNdXVGaENEc29JUU5DZzBLSXlNaklPdW5pT3F3a01LMzZyaXc2ckNFSU91bmpPdWpqQTBLDQpEUXBnUkMxT1lDaE83SjI4SU91Q3FPeWRqQ2tnTHlCZ1JDMHdZQ2pzbUtUcmlwZ2c2NmVJNnJDUUtTQXZJR0JFSzA1Z0tFN3NuYndnNnJLOTZyTzhLUTBLN0ppSUtTQkVMVGNzSUVRdE1Td2dSQzB3TENCRUt6RU5DZzBLSXlNaklPdXlpTzJZdUNEdGtaenF1TEFnS08yVm1PeWR0TzJVaU95Y3ZPdWhuQ0RxdGF6cnRvUXBEUW9OQ253ZzdaV3Q2NnFwSUh3ZzdaaVY3SXVkSUh3ZzdKaUk3SXVjSUh3TkNud3RMUzB0TFMxOExTMHRMUzB0ZkMwdExTMHRMWHdOQ253ZzdLQ0U3Wm1VNjdLSTdaaTRJSHdnN1pXWTdKMjA3WlNJSU9xMXJPdTJoQ0I4SURBeUxURXlNelF0TlRZM09Dd2dNREV3TFRFeU16UXROVFkzT0NCOERRcDhJT3k1dE91VG5PdXlpTzJZdUNCOElEVHNucERycHF6c2xLa2c3WldZN0oyMDdaU0lJSHdnTVRJek5DMDFOamM0TFRrd01USXRNelExTmlCOERRcDhJT3F6aE95aWpPdXlpTzJZdUNCOElPMlZtT3lkdE8yVWlDRHF0YXpydG9RZ2ZDQXhNak10TkRVMkxUYzRPVEF4TWlCOERRcDhJT3lqdk91dg0Kdk91VHNldWhuZXV5aU8yWXVDQjhJT3lWbmlBMjdKNlE2NmFzTGV1U3BDQTM3SjZRNjZhc0lId2dNVEl6TkRVMkxURXlNelExTmpjZ2ZBMEtmQ0RzZ3F6c2w0WHNucERyazdIcm9aM3Jzb2p0bUxnZ2ZDQXhNT3lla091bXJDRHRsWmpzbmJUdGxJZ2dmQ0F3TVMweU16UXROVFkzT0RrZ2ZBMEtEUW9qSXlNZzdKT3c2Nm0wSU95VmlDRHJrSmpyaXBRZzdaR2M2cml3RFFvTkNpMGc2NEtnN0tlYzdKZVFJTzJWbU95ZHRPMlVpTUszNjdtWDZyaUlPaURpbll3Z01qQXlOUzB3TVMwd01Td2dNREV2TURFTkNpMGc3SXVjNnJDRTdKZVFJT3lZcE95Z2hDL3NtS1R0bTRRNklPS2RqQ0RzbUtUc29JUWdNZXlMbkNBcUtPdUxxQ3dnN0lLczdKcXA3SjZRNnJDQUlPeW5nZXlna1NEcXM2RHJwYlRyaXBRZzY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSU95WWlPeVp1Q2txRFFvTkNpb3FLZzBLRFFvakl5QTRMaUR0akozc2w0VW82NHVrN0oyMDdKYTg2NkdjNnJlNEtRMEtEUXJ0akozc2w0VWc2Nnk0NnJXczY0cVUNCklDb3E3SmV0N1pXZ0tpb283WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZDbnFzN3dnS2lyc25LRHRtSlVxS2lqdGhyWHJzN1F2N1l5UTY0dW9LZXlYa0NEcmxMRHJuYndnNjZ5NDdMSzA2ckNBSU91THJPdWR2T3lhbEM0ZzdZT0E3SjIwN1l1QTdKMkVJT3VMcE91VHJPeWRoQ0RybFpBZzY3Q1k2NU9jN0l1Y0lPeVZpT3VDdENqcnM3anJyTGdwNnJtTTdLZUFJT3F3bWV5ZHRDRHJzN1RxczZBc0lPdXp1T3VzdUNEcnA2WHJuYjNzbllRZzY0dTA3SldFN0pXOElPMlZ0T3lhbEM0TkNnMEtJeU1qSUREcmk2anFzNFFnNG9DVUlPMkt1T3Vtck9xeHNPdTJnTzJFc0NEcnRKRHNtcFFOQ2cwSzdZeWQ3SmVGN0oyMElPeUNyT3lhcWV5ZWtPeWRtQ0RzbHJUcmxxUWc3WmFKNjQrWklPdVNwT3lYa0NEcm5LanJpcFRzcDRBZzY2aTg3S0NBSU8yTWpPeVZoZTJWdE95YWxDNE5DZzBLTFNEdGxvbnJqNW5zbllRZ0tpcnFzSURyb1p6cnA0bnFzYkRyZ3BnZzdZeVE2NHVvN0oyRUlPeWFsT3ExckNvcUtPeWR0TzJEDQppTUszN0lLdDdLQ2N3cmZyb1p6cXQ3anNsWVRzbTRQQ3QreWloZXVqakNrZzRvYVNJQ29xN1l5UTY0dW83WmlWS2lvZ0tPdXN2T3lXdE91MGtPeWFsQ2tOQ2kwZzZyS3c2ck84d3Jmc2c0SHRnNXpycGJ3Z0tpcnRoclhyczdUcnA0d3FLaUFvN0ptRTY2T013cmZzaTZUdGpLZ3BJT0tHa2lBcUt1eVZpT3VDdE8yWWxTb3FJQ2pzbFl6cm9LVHNwSmpzbXBRcERRb05DaU1qSXlEdGc0RHNuYlR0aTRBZzRvQ1VJT3lucCt5ZGdDRHJxb1hzZ3F6cXRhd05DZzBLTFNEcnFvWHNncXp0bUpYc25MenJvWndnNjRHZDY0SzA3SnFVTGlEc29vWHFzckRzbHJUcnI3akN0K3VuaU95NXFPMlJuT3VsdkNEc2s3RHNwNEFnN0pXSzdKV0U3SnFVSUNoKzdKcVVJQzhnZnV1THBDQXZJSDdxdVl6c21wUS9JT0tkakNrdURRb3RJREorTk95V3RPeWdpT3VobkNEc3A2ZnFzNkFnN0ltOTZyS01MaUR0bFp6c25wRHNsclRDdCt5SW1PeUxuZXlkaENEcXVManFzb3dnN0l5VDdLZUFJT3lWaXV5VmhPeWFsQzROQ2kwZzdKV0k2NEswS091eg0KdU91c3VDa2c2NmVsNjUyOTdKMkVJT3lhbE95VnZlMlZ0Q3dnS2lydGc0RHNuYlR0aTREcnA0d2c2N1NRNjQrRUlPdXN0T3lLcUNEdGpKM3NsNFhzbmJqc3A0QXFLaURzbFl6cXNvd2c3WlcwN0pxVUxpRHNtNURyczdqc25iUWdKK3lWak91bXZNSzM3Wm1WN0oyNEoreXltT3VmdkNEcnA0bnNsN0R0bFpqcnFiUWc2N080NjZ5NDdKMkVJT3Ezdk9xeHNPdWhuQ0RxdGF6c3NyVHRtWlR0bGJUc21wUXVEUW9OQ253ZzdKMjA2NkNINnJLTUlPdW5rT3F6b0NCOElPeWR0T3VnaCtxeWpDQjhEUXA4TFMwdGZDMHRMWHdOQ253ZzdLQ0E3SjZsN1pXWTdLZUFJT3lWaXVxem9DRHJncGpxc0lEc2k1enFzcURzbHJUc21wUS9JSHdnN0tDQTdKNmxJT3lWaUNEdGxad2c2NEswN0pxcElId05DbndnN0pXTTY2YThJSHdnNnJLdzdLQ2NJT3laaE91ampDQjhEUXA4SU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JSHdnNjQydzdKMjA3WVN3SU95Q3JleWduQ0I4RFFvTkNpTWpJeURzbFlqcmdyUW8NCjY3TzQ2Nnk0S1NEaWdKUWc3WlcwN0pxVTdMSzBEUW9OQ2kwZ0tpcnRqSkRyaTZqdG1KVXFLdXlkZ0NBbmZ1MlZvT3E1ak95YWxEOG42NkdjSU91c3ZPeVd0T3lhbEM0ZzY1Q1k2NCtNNjZhMElPeUltQ0RzbDRicmlwUWc3SnlFN1plWUtPeUNyZXlnbk1LMzdZT0k3WWUwSU91VHNTbnNuWUFnNnJLdzZyTzg2Nlc4SU91b3ZPeWdnQ0Rxc3IzcXM2RHRsYlRzbXBRdURRb3RJQ29xN0pXSTY0SzA3WmlWS2lyc25ZQWc3SUtzN0l1azdKMkVJT3lFbk95SW9PMlZ0T3lhbEM0TkNpMGc2NmVJN0xtbzdaR2M2Nlc4SU95TnFPeWFsQzRnN0lpcjdKNlF3cmZzb2JEcXNiUW83SjIwN0lPQndyZnNuYlR0bFpqQ3QreWR0T3VDdENEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaRHFzNkFzSU95YmtPdXN1T3lYa0NEc2w0YnJpcFFnN0tDVjY3TzB3cmZzb0lqc3NLakN0K3lYc091ZHZleXltT3VsdkNEc3A0RHNsclRyZ3JUc3A0QWc3SldLN0pXRTdKcVVMZzBLRFFvakl5TWc2N0tFN1lxOElPS0FsQ0RzbFlqcmdyUWc2Nnk0DQo2NmVsN0oyMElPeWdsZTJWdE95YWxBMEtEUXA4SU91enVPdXN1T3lkdENEc25iVHJvSWZyaTZRZ2ZDRHJzb1R0aXJ3Z2ZBMEtmQzB0TFh3dExTMThEUXA4SU9xeXNPcXp2TUszN0lPQjdZT2M2Nlc4SU8yR3RldXp0Q0I4SUZ2dG1aWHNuYmhkSUh3TkNud2dKMzd0bGFEcXVZenNtcFEvSit1aG5DRHJyTHpzbll3Z2ZDQmI3SldFNjR1STdKaWtYU0RDdHlCYjY0U2tYU0I4RFFwOElPeURnZTJacVNEc2hKenNpS0FnS3lEc21LVHJwYmpzcXIzc25iUWc3SXVrN0tDY0lPdVBtZXlla1NCOElGdnN0NmpzaG94ZElNSzNJRnQ3NjQrWjdKNlJmVjBnZkEwS0RRb3RJQ2ZzdDZqc2hvd242NHFVSUNvcTY0K1o3SjZSSU91eWhPMkt2T3F6dkNEc3A1M3NuYndnNjVXTTY2ZU1LaW9nN0kybzdKcVVJQ2pzbUlnNklGdnN0NmpzaG94ZHdyZGI3SUt0N0tDY1hTa3VJQ2ZyaTZ2cXVMQWd3cmNnNjQrWjdKNlJKK3l5bU91ZnZDRHNwNTNzbmJRZzdKV0lJT3VubnV1S2xDRHNvYkR0bGFuc25iVHJncGdnNjR1bzY0K0ZJQ2ZzdDZqcw0KaG93bjY0cVVJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW90SU91eWhPMkt2T3lkbUNEcmo1bnNucEVnN0oyMDY2YUU3SjJBSU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGhDRHF0N2pyaklEcm9ad2c3SUswNjZDazdKcVVMZzBLRFFvakl5TWc3WWExN0tlY0lPeVlpT3lMbkEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdKMjA3WU9JS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURzb0lEc25xVWc3SldJSU8yVm5DRHJnclRzbXFrTkNpMGc3SldJNjRLME9pRHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4ZzdKNkY2NkNsN1pXY0lPdUN0T3lhcWV5ZHRDRHNncXpybmJ6c29ManNtcFF1RFFvdElPdXloTzJLdkRvZzdKV0U2NHVJN0ppa0lNSzNJT3VFcEEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdJS3Q3S0NjSUNqc25JVHRsNWdwS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURyamJEc25iVHRoTEFnN0lLdDdLQ2NEUW90SU95VmlPdUMNCnREb2c3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0RzZ3JUcnByUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzdJS3Q3S0NjN1pXZzZybU03SnFVUHcwS0xTRHJzb1R0aXJ3NklPeVZoT3VMaU95WXBDREN0eURyaEtRTkNnMEtLaXJyajVuc25wSHRtSlVnNG9DVUlPeUVuT3lJb0NBcklPdVBtZXlla1NEcnNvVHRpcndxS2cwS0xTRHRnNERzbmJUdGk0QTZJT3E0c09xNHNDRHNsN0Rxc3JBZzdaVzA3S0NjRFFvdElPeVZpT3VDdERvZzdJU2c3WU9kN1pXY0lPcTRzT3E0c095ZG1DRHNsN0Rxc3JEc25ZUWc2NEdLN0phMDdKcVVMZzBLTFNEcnNvVHRpcnc2SU95M3FPeUdqQ0RDdHlEc2w3RHFzckFnN1pXMDdLQ2NEUW9OQ2lvcTdKV0k2NEswN1ppVklPS0FsQ0RzbVlUcm80d2c3WWExNjdPMEtpb05DaTBnN1lPQTdKMjA3WXVBT2lEcXNyRHNvSndnN0ptRTY2T01EUW90SU95VmlPdUN0RG9nNnJLdzdLQ2M2ckNBSU95Z2xleURnU0Rzc3BqcnBxenJrSkRzbHJUc21wUXVEUW90SU91eWhPMkt2RG9nN1ptVjdKMjREUW9ODQpDaW9xS2cwS0RRb2pJT3lZaU95WnVDRHF0NXpzdVprTkNnMEs3SnVRN0xtWktPdUtwZXVQbWNLMzZyaU43S0NWd3Jmc3VwRHNvN3pzbHJ3cDY3TzA2NHVrSU95WWlPeVp1T3F3Z0NEcmpaUWc2NnFGN1ptVjdaV2NJT3k3cE91dXBPdUxpT3k4Z095ZHRPeUZtT3lkaENEcnA0enJrNXpyaXBRZzZySzk3SnF3N0ppSTdKcVVMZzBLRFFvakl5RHNtSWpzbWJnZ01TNGc3SWlZNjQrWjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqcmo0UWc2NUNZNjRxVUlPcXl2ZXlhc0EwS0RRb2pJeU1nN0lTYzY3bUU3SXFrSU95aWhldWpqQ3dnNnJpdzZyQ0VJT3Vuak91ampBMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWp2T3lXdENqc29vWHJvNHdnN0lTYzY3bUU3SXFrTENEcXVMRHFzSVFnNjVPeEtldWx2Q0Rxc0pYc29iRHRsYUFnN0lpWUlPeWVpT3F6b0N3Z0oreWloZXVqakNmc21ZQWdKK3Vuak91ampDZnNuWmdnNjRtWTdKV1o3SXFrNjZXOElPeWdsZTJabGUyZWlDRHNvSVRyaTZ6dGxhQWc3SWlZSU95ZQ0KaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNCUFQwOGc3SVNjNjdtRTdJcWtJT3lpaGV1ampDRHNsWWpyZ3JRZzRvQ1VJREF3N0p1VUlEQXc3SjI4NjdhQTdZU3dJT3lFbk91NWhPeUtwT3F3Z0NEc29vWHJvNHpyajd6c21wUXVJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWVFnN0pXTTY2Q2s2NU9jNjZDazdKcVVMZzBLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZzBLRFFycmk2Z3NJQ29xN0tPODZyaXc3S0NCN0p5ODY2R2NJT3lpaGV1ampPcXdnQ0Ryc0pqcnM3WHJrSmpyaXBRZzdLQ2M3WktJS2lyc2w1RHJpcFFnSit5aWhldWpqT3VQdk95YWxDZnJwYndnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURzb29Ycm80enJqN3pzbXBRZzRvYVNJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxBMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKZVENCjZyS01JT3V2dU95NW1PdUtsQ0RzbUlIdGxxWHNuWVFnN0pXTTY2Q2s3S1NFSU91VmpBMEtEUW9vN0tPODdKcVVJT3VQbWV5Q3JDQTZJT3lYc095eXRDd2c3WlcwN0tlQUxDRHNvSUhzbXFrZzY1T3hLUTBLRFFyc2lKanJqNW50bUpYc25MenJvWndnN0pPdzY2bTBJT3lkdU9xenZDRHF0SURxczRUcnBid2c2NnFGN1ptVjdaV1k2cktNSU95RXBPdXFoZTJWbU9xem9Dd2dKK3lDck95YXFleWVrT3lkbUNEdGxvbnJqNW5zbDVBZzY1U3c2NTI4N0ppazY0cVVJT3F5c09xenZDZnJuYnpyaXBRZzdLQ1E3SjJFSU95VmpPdWdwT3lraENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95WXBPdUttT3E1ak95bmdDRHJnclRzcDRBZzdKV0s3Snk4NjZtMElPeVhzT3l5dE91UHZPeWFsQzRnN1p1RTY3YUk2ckt3N0tDY0lPcTRpT3lWb2V5ZGhDRHJnclRzbzd6c2hManNtcFF1RFFvdElPdU1nT3kybk95ZGhDRHFzSWpzbFlUdGc0RHJxYlFnN0p1UTY1NllJT3VNZ095Mm5PeWR0Q0R0bGJUc3A0RHJqN3pzDQptcFF1SU95WXBPdUttQ0RyZ3FEc3A1enF1WXpzcDREc25aZ2c3SjIwN0o2UTY2VzhJT3lkZ08yV2lleVhrQ0RyZ3JUc2xid2c3WlcwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UUlPeVZpT3lMckNBbzdJaVk2NCtaN1ppVktRMEtEUW9uN0tDVjY3TzBJT3lJbU95bmtTRHNsWWpyZ3JRbklPdVRzZXlkbUNEcnI3enFzSkR0bFp3ZzdJT0I3Wm1wN0plUTdJU2NJQ29xN0l1YzdJcWs3WVdjN0oyMElPeWVrT3VQbWV5Y3ZPdWhuQ0Rzc3BqcnBxenRsWnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc3SWlZNjQrWjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeWR0T3lnbk91MmdPMkVzQ0R0bVkzcXVManJqNW5yaTVqc25aZ2c2ckNjN0oyNDdLQ1Y2N08wSU95ZHRPeWFxU0RyZ3JUc2w2M3NuYlFnNnJpdzY2R2Q2NCs4N0pxVURRb3RJT3VObENEc29vdnNuWUFnN0lPQjY0dTA3SjJFSU95Yw0KaE8yVnRDRHRoclh0bVpRZzY0SzA3SnFwN0oyQUlPdUZ1ZXlkak91UHZPeWFsQTBLRFFvakl5RHNtSWpzbWJnZ01pNGc2cks5N0phMDY2VzhJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3RFFvTkN1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKMllJT3VucGV1ZHZleWRoQ0R0bVp6c21xbnRsYlRzaEp3ZzdLZUk2Nnk0N1pXZ0lPdVZqQTBLRFFvbjdJdWM2NEtZN0pxVVB5Y3NJQ2ZzaGFqcmdwanNtcFEvSnlEdG1KWHRnNXpzblpnZzZySzk3SmEwNjZXOElPMlpuT3lhcWUyVnRPeUVuQ0RzZ3F6c21xbnNucERzblpnZzY0dTU3Wm1wN0lxazY1K3M3SnVBN0oyRUlPeWtoT3lkdkNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1Dd2cNClQwOVBJT3VMcE91RmdPeVlwT3lGcU91Q21PeWFsRDhOQ2kwZzdMYXA3S0NFN1pXWTY1K3NJTzJPdU95ZG1PeWdrQ0Rxc0lEc2k1enJncGpzbXBRL0RRb05DaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SU9CN1ptcDdKMkVJT3kybE95Z2xlMlZvQ0RybFl3TkNnMEs2NnFGN1ptVjdaV2NJT3lnbGV1enRPcXdnQ0RzbDRic2xyVHNoSndnN0lLczdKcXA3SjZRN0plUTZyS01JT3luZ2V5Z2tTRHRqSkRyaTZqdGxaanFzb3dnN1pXMDdKVzhJTzJWb0NEcmxZd2c2cks5N0phMDY2R2NJT3lnbGV5a2tlMlZtT3F5akNEc3A0anJyTGp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzY3Q2I3Snk4N0lXbzY0S1k3SnFVUHlEcms3SHJvWjN0bFpqcnFiUWc3THFRN0l1YzY3Q3hJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla095ZG1DRHNoS0RzblpqcXNJQWc3WldFN0pxVTdaV2dJT3VWakEwS0RRcnNoS1RyDQpyTGpzb2JEc2dxenNzcGpybjd3ZzdJS3M3SnFwN0o2UTdKMllJT3lFb095ZG1PdWx2Q0RxdUxEcmpJRHRsYlRzbGJ3ZzdaV2dJT3VWakNEcXNyM3NsclRyb1p3ZzdLQ1Y3S1NSN1pXWTZyS01JT3luaU91c3VPMlZ0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNuYlRyc29nZzY0dXM3SmVRSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxaanJxYlRzaEp3ZzdKYTg2NmVJNjRLWUlPdW5qT3loc2UyVm1PeUZxT3VDbU95YWxEOE5DZzBLSXlNZzdKaUk3Sm00SURNdUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPdVFtT3VLbENEcXNyM3NtckFOQ2cwSzdJS3M3SnFwN0o2UTdKZVE2cktNSU91cWhlMlpsZTJWbU9xeWpDRHJ0b0Rzb0pYc29JSHNuYmdnNjRLMDdKcXA3SjJFSU95VmpPdWdwT3lrbU95VnZDRHRsYUFnNjVXTTY0cVVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3lpaSt5VmhPeWFsQzROQ2cwS0l5TWpJT3lFbk91NWhPeUtwT3VsdkNEc29KWHNzWVhzZzRFZw0KN0pPNElPeUltQ0RzbDRic25ZUWc2NVdNRFFvTkN1dTJnT3lnbGUyWWxleWN2T3VobkNEc2phanNsYndnN0lLczdKcXA3SjZRN0plUTZyS01JT3lEZ2UyWnFleWRoQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN0l1YzdZS3NJT3lJbUNEc25vanNsclRzbXBRdUlDb3E3Sk80SU95SW1DRHNsNGJyaXBRZzdKMjA3SnlnNjZXOElPMlZxT3E3bUNEc2xZanJnclR0bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RzcDREcXVJanNuWUFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJT3l5cmV5R2pPdUZoT3lkaENEc25JVHRsWndnN0lTYzY3bUU3SXFrNjRxVUlPeVZoT3luZ1NEc3BJRHJ1WVFnN0tTUjdKMjA3SmVRN0pxVUxnMEtMU0RxczdYcnJMVHNtNURzbllBZzdadUU3SnVRNnJpSTdKMkVJT3V6dE91Q3ZDRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzY3YUE3S0NWN1ppVjdKeTgNCjY2R2NJT3lOcU95VnZDRHNncXpzbXFuc25wRHFzSUFnN0phMDY1YWtJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3lYaHV1S2xPeW5nQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95RW9PMkRuZXlkbUNEcXNyRHFzN3pycGJ3ZzdKV0k2NEswN1pXZ0lPdVZqQTBLRFFycmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHNoS0R0ZzUzc25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyVm1PcXlqQ0RzbFl6cm9LVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdaV2NJT3V5DQppQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtDRHNsWWpzaTZ3Z0tPdTJnT3lnbGUyWWxTa05DZzBLSit5Z2xldXp0Q0RzaUpqc3A1RWc3SldJNjRLMEp5RHJrN0hzblpnZzY2Kzg2ckNRN1pXY0lPeURnZTJacWV5WGtPeUVuQ0FxS3V5Z2xldXp0T3F3Z0NEcnM3VHRtTGpya0p6cmk2VHJpcFFnN0tDUUtpcnNuWVFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lEZ2V1THRPeWR0Q0RyZ1ozcmdwanJxYlFnN0tDRTY2eTQ2ckNBNjQrRUlPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1RycGJ3ZzY3TzhJT3lJbUNEc2w0YnNsclRzbXBRdURRb3RJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHNvSlhyczdUcXNJQWc2cml3NjZHZDY1Q1k3S2VBSU95Vg0KaXV5VmhPeWFsQzROQ2cwS0l5TWc3SmlJN0ptNElEUXVJT3lnbk8yU2lDRHNtcW5zbHJUcmlwUWc2N0NVNnI2NDdLZUFJT3lWaXVxNHNBMEtEUW9uNnJDRTZyS3c3WldZNnJPZ0lPeUpyT3lhdENEcnA1QW5JT3lia095NW1ldXp0T3VMcENBcUt1MlpsT3VwdE95ZG1DRHF1TERyaXFYcnFvWEN0K3V5aE8yS3ZPdXFoZXF6dk95ZG1DRHNtcW5zbHJRZzdKMjg3TG1ZS2lycXNJQWc3SnF3N0lTZzdKMjA3SmVRN0pxVUxnMEs2cml3NjRxbDY2cUY3SmVRSU95VHNPeWR1Q0RyaTZqc2xyUW82N09BNnJLOUxDRHNwNERzb0pVc0lPdVRzZXVoblNEcms3RXA2Nlc4SU95VmlPdUN0Q0RyckxqcXRhenNsNURzaEp3ZzY0dWs2Nlc0SU91bmtPdWhuQ0Ryc0pUcXZyanJxYlFnN0lLczdKcXA3SjZRNnJDQUlPdUxwT3VsdUNEcXVMRHJpcVhzbkx6cm9ad2c3SmlrN1pXMDdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrZ0orcTJqTzJWbkNEcnM0RHFzcjBuSU9xNHNPdUtwZXlkbUNEc2xZanJnclFnNjZ5NDZyV3MNCkRRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N0NVNnIrQUlPeUltQ0Rzbm9qc2xyVHNtcFFnS0ZncERRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N09BNnJLOTdaV2dJT3lJbUNEc25vanNsclRzbXBRZ0tFOHBEUW9OQ2lNaklPeVlpT3ladUNBMUxpRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F3ZzdKT3c3S2VBSU95Vml1cTRzQTBLRFFycnJManF0YXpycGJ3ZzdKV0U2NnkwNjZhc0lPdW5wT3VCaE91ZnZlcXlqQ0RyaTZUcms2enNsclRyajRRZ0tpcnNpNlRzb0p3ZzdJdWM3SXFrN1lXY0lPdVBtZXlla2VxenZDRHJpNlRycGJnZzY0K1o3SUtzS2lycnBid2c3Sk93NjZtMElPeWVtT3VxdSt1UW5DRHJyTGpxdGF6c21JanNtcFF1RFFvTkN1eVlpQ2tnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3llDQprT3VsdkNBbjdMYVU2ckNBSU95bmdPeWdsU2Z0bFpqcmlwUWc3SXVjN0lxazdZV2M3SmVRN0lTY0lDanNuYlRzb0lUQ3QreVdrZXVQaENEcXVMRHJpcVhzbmJRZzdKV0U2NHVZS1EwS0xTRHJpNlRycGJnZzdJS3M2NTZNN0plUTZyS01JT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERycGJ3ZzY0U1k2cktvN0tPODdJUzQ3SnFVSUNoWUlPS0FsQ0RzbDRicmlwUWdKK3VFbU9xNHNPcTRzQ2NnNnJpdzY0cWw3SjJFSU95VmxPeUxuQ2tOQ2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZ0Q0Rzbzd6c2hManNtcFFnS0U4cERRbz0NCjo6TEFVTkNIRVI6Og0KLy80bkFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCQ0FISUFhUUJrQUdjQVpRQWdBR3dBWVFCMUFHNEFZd0JvQUdVQWNnQWdBQlFnSUFEb3NzU3N4THdnQUNUQkZjZ2dBQkRJZ0t3Z0FNVFdJQURrc3F5NUlBRGt3b25WQ2dBbkFDQUFZd0JzQUdFQWRRQmtBR1VBWWdCeUFHa0FaQUJuQUdVQU9nQXZBQzhBSUFBRTFWeTRvTkZjejNUSElBQjB4eUFBRE5OOHgwVEhJQUNBdlhpNTVMSWdBQ2dBOGJSZHVEb0FJQUJ1QUhBQWJRQWdBR2tBYmdCekFIUUFZUUJzQUd3QUlBQVF0cFN5SUFBaUFIVFFYTGpjdENBQTVNNGxzVERSSWdBZ0FDVEJXTTRnQUF6VGZNY3BBQzRBQ2dBbkFDQUFWTHNBckNBQVlMNDR5Q0FBaU1jOHgzUzZJQUJjMVNBQWlMelF4U0FBV05XWXNDbkZJQUJJeGJTd1dOWGdyQ3dBSUFEa3NpQUFBTWxFdmhpMGRMb2dBT1N5ckxsOHVTQUFQY3dnQU1iRmRNY2dBT1RDaWRWYzFlU3lMZ0FLQUZNQVpRQjBBQ0FBWmdCekFHOEFJQUE5QUNBQVF3QnlBR1VBWVFCMEFHVUFUd0JpQUdvQVpRQmpBSFFBS0FBaUFGTUENCll3QnlBR2tBY0FCMEFHa0FiZ0JuQUM0QVJnQnBBR3dBWlFCVEFIa0Fjd0IwQUdVQWJRQlBBR0lBYWdCbEFHTUFkQUFpQUNrQUNnQlRBR1VBZEFBZ0FITUFhQUFnQUQwQUlBQkRBSElBWlFCaEFIUUFaUUJQQUdJQWFnQmxBR01BZEFBb0FDSUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGTUFhQUJsQUd3QWJBQWlBQ2tBQ2dCa0FHa0FjZ0FnQUQwQUlBQm1BSE1BYndBdUFFY0FaUUIwQUZBQVlRQnlBR1VBYmdCMEFFWUFid0JzQUdRQVpRQnlBRTRBWVFCdEFHVUFLQUJYQUZNQVl3QnlBR2tBY0FCMEFDNEFVd0JqQUhJQWFRQndBSFFBUmdCMUFHd0FiQUJPQUdFQWJRQmxBQ2tBQ2dCekFHZ0FMZ0JEQUhVQWNnQnlBR1VBYmdCMEFFUUFhUUJ5QUdVQVl3QjBBRzhBY2dCNUFDQUFQUUFnQUdRQWFRQnlBQW9BQ2dBbkFDQUFNUUF2QURJQUtRQWdBRTRBYndCa0FHVUFMZ0JxQUhNQUlBQVF5SUNzSUFBVUlDQUF4c1U4eDNTNklBRGtzclRHWExqY3RDQUFtTk4weDhESmZMa2dBUFRGdE1VQXllU3lDZ0JKQUdZQUlBQnpBR2dBDQpMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQUlBQjNBR2dBWlFCeUFHVUFJQUJ1QUc4QVpBQmxBQ0lBTEFBZ0FEQUFMQUFnQUZRQWNnQjFBR1VBS1FBZ0FEd0FQZ0FnQURBQUlBQlVBR2dBWlFCdUFBb0FJQUFnQUVrQVpnQWdBRTBBY3dCbkFFSUFid0I0QUNnQUlnQk9BRzhBWkFCbEFDNEFhZ0J6QUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aTRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSWdCYkFGWFdlTWRkQUVUSElBQUVzblM1ZExvZ0FPU3l0TVpjdU55MElBQ1kwM1RId01rQXJDQUE5TVc5dWNpeTVMSXVBQ0FBSk1GWXpueTVJQURJdVZ6T0lBQ2t0Q3dBSUFBTTFleTMrSzE0eDlERkhNRWdBSFRRWExqY3RDQUFoTHk4MGtUSElBRGtzdHpDSUFBTXN1eTNJQUQ4eURqQmxNWXVBQ0lBTEFBZ0FGOEFDZ0FnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQQ0KSUFCMkFHSUFUd0JMQUVNQVlRQnVBR01BWlFCc0FDQUFLd0FnQUhZQVlnQkZBSGdBWXdCc0FHRUFiUUJoQUhRQWFRQnZBRzRBTEFBZ0FDSUFkTkJjdU55MElBRGtzcXk1SUFBa3dSWElJQUFvQURFQUx3QXlBQ2tBSUFBVUlDQUFUZ0J2QUdRQVpRQXVBR29BY3dBaUFDa0FJQUE5QUNBQWRnQmlBRThBU3dBZ0FGUUFhQUJsQUc0QUNnQWdBQ0FBSUFBZ0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCb0FIUUFkQUJ3QUhNQU9nQXZBQzhBYmdCdkFHUUFaUUJxQUhNQUxnQnZBSElBWndBdkFHc0Fid0F2QUdRQWJ3QjNBRzRBYkFCdkFHRUFaQUFpQUFvQUlBQWdBRVVBYmdCa0FDQUFTUUJtQUFvQUlBQWdBRmNBVXdCakFISUFhUUJ3QUhRQUxnQlJBSFVBYVFCMEFBb0FSUUJ1QUdRQUlBQkpBR1lBQ2dBS0FDY0FJQUF5QUM4QU1nQXBBQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDQUFFTWlBckNBQUZDQWdBTWJGUE1kMHVpQUFKTUZZenJjQVhMajRyWGpISUFBcHZKVzhSTWNnQUVqRnRMQmMxZVN5Q2dCSkFHWUENCklBQnpBR2dBTGdCU0FIVUFiZ0FvQUNJQVl3QnRBR1FBSUFBdkFHTUFJQUIzQUdnQVpRQnlBR1VBSUFCakFHd0FZUUIxQUdRQVpRQWlBQ3dBSUFBd0FDd0FJQUJVQUhJQWRRQmxBQ2tBSUFBOEFENEFJQUF3QUNBQVZBQm9BR1VBYmdBS0FDQUFJQUJOQUhNQVp3QkNBRzhBZUFBZ0FDSUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUFDc0lBQWt3VmpPL0xNZ0FJakh3TWtnQUVyRlJNV1V4aUFBS0FBUXRwU3lJQUJRQUVFQVZBQklBTkRGSUFER3hiVEZsTVlwQUM0QUlnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCMkFHSUFRd0J5QUV3QVpnQWdBQ1lBSUFCZkFBb0FJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0F3MGZpN0VMSFF4UnpCSUFCRXhaaTNmTGtnQUNUQldNNjNBRnk0K0sxNHgxelZJQUNrdEN3QUlBQjAwRnk0M0xRZ0FJUzh2TkpFeHlBQTVMTGN3aUFBRExMc3R5QUEvTWc0d1pUR09nQWlBQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBSmdBZ0FIWUFZZ0JEQUhJQVRBQm1BQ0FBDQpKZ0FnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWlBQ0FBSUFCdUFIQUFiUUFnQUdrQWJnQnpBSFFBWVFCc0FHd0FJQUF0QUdjQUlBQkFBR0VBYmdCMEFHZ0FjZ0J2QUhBQWFRQmpBQzBBWVFCcEFDOEFZd0JzQUdFQWRRQmtBR1VBTFFCakFHOEFaQUJsQUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFJQUFnQUdNQWJBQmhBSFVBWkFCbEFDQUFiQUJ2QUdjQWFRQnVBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQVZkWjR4eUFBS2J5VnZEb0FJQUF3MGZpN0VMSFF4UnpCSUFCakFHd0FZUUIxQUdRQVpRQWdBQzBBTFFCMkFHVUFjZ0J6QUdrQWJ3QnVBQ0FBZE1jZ0FJUzhCTWhFeHlBQW5NMGx1RmpWZExvZ0FBREpSTDRnQUVUR3pMaUZ4OGl5NUxJdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQQ0KWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDSUFLQUNzd0tuR3liZEF4eUFBZE1jZ0FGQUFRd0RReFNBQVhMajRyWGpISExRZ0FIVFFYTGpjdENBQWJLM0ZzeUFBWE5YRXM5REZITUVnQUNqTUVLd3B0TWl5NUxJdUFDa0FJZ0FzQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBSFlBWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BRElBTHdBeUFDa0FJQUFVSUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQ0lBQ2dBZ0FDQUFWd0JUQUdNQWNnQnBBSEFBZEFBdUFGRUFkUUJwQUhRQUNnQkZBRzRBWkFBZ0FFa0FaZ0FLQUFvQUp3QWdBQURKUkw0Z0FFVEd6TGdnQUJRZ0lBRGtzcXk1ZkxrZ0FEM01JQURHeFhUSElBRGt3b25WSUFBb0FBelY3TGY0clhqSGRNY2dBT2VzSUFDUXg5bXpJQUFRck1ESktRQUtBSE1BYUFBdUFGSUFkUUJ1QUNBQUlnQmpBRzBBWkFBZ0FDOEFZd0FnQUc0QWJ3QmtBR1VBSUFCekFHTUENCmNnQnBBSEFBZEFCekFGd0FZd0JzQUdFQWRRQmtBR1VBTFFCaUFISUFhUUJrQUdjQVpRQXVBR29BY3dBaUFDd0FJQUF3QUN3QUlBQkdBR0VBYkFCekFHVUFDZ0E9DQo6OldBVENIRVI6Og0KTHk4ZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzRvQ1VJTzJWcmV5RGdTRHJscUFnN0o2STY0cVVJT3kwaU95R2pPMllsU0RzaEp6cnNvUWdLR3h2WTJGc2FHOXpkRG94TVRnNE9Ta05DaTh2SU9LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBMEtMeThnN0ptY0lPMlZoT3lhbE8yVm5PcXdnRG9nN1pTODZyZTQ2NmVJNnJDQUlPMlVqT3Vmck9xM3VPeWR1T3lkbUNCamJHRjFaR1ZpY21sa1oyVTZMeThnN0plMDZyaXdLSGRwYm1SdmR5NXZjR1Z1TDJsbWNtRnRaUzl2Y0dWdVJYaDBaWEp1WVd3cDY2VzgNCkRRb3ZMeURzb0lUcnRvQWc3SWFNNjZhc0lPeVhodXlkdENEcnA0bnJpcFFnNjdLRTdLQ0U3SjIwSU95ZWlPdUxwQzRnWm1WMFkyanJpcFFnNjZxN0lPdW5pZXljdk91dmdPdWhuQ3dnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKRHNpNXpzbnBEc2w1RHFzb3dOQ2k4dklGQlBVMVFnTDNkaGEyVWc2Nlc4SU91enRPdUN0T3VwdENEcXNKRHNpNXpzbnBEcXNJQWc2NHVrNjZhc0tHTnNZWFZrWlMxaWNtbGtaMlV1YW5NcDY2VzhJT3VNZ095TG9DRHN2S0RyaTZRdURRb3ZMdzBLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQTBLTHk4ZzY2bVU2NnFvNjZhc0lINHhOVTFDNjUyOElPdWhuT3EzdU95ZHVDRHNpNXdnN0o2UTY0K1pJT3lMbk95ZWtleWN2T3VoDQpuQ0RzZzRIc2k1d2c3THljNjVHczY0K0VJT3UyZ091THRDRHNsNGJyaTZRZ0tPdVRzZXVoblRvZ2JuQnRJSEoxYmlCaWRXbHNaQ2t1RFFvdkx5RHJpNlRycHF6cmlwUWc3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTRzT3VwdENEc283M3NwNERycDR3bzdaU002NStzNnJlNDdKMjQ2ck84SU95RG5leUNyQ0RyajVucXVMRHRtWlFwTENEcXNKRHNpNXpzbnBEcmlwUWc2ck9FN0lhTklPdUNxT3lWaENEcmk2VHNuWXdnNnJtbzdKcXc2cml3NjZXOElPdXdtK3VLbE91THBDNE5DZzBLWTI5dWMzUWdhSFIwY0NBOUlISmxjWFZwY21Vb0oyaDBkSEFuS1RzTkNtTnZibk4wSUhCaGRHZ2dQU0J5WlhGMWFYSmxLQ2R3WVhSb0p5azdEUXBqYjI1emRDQm1jeUE5SUhKbGNYVnBjbVVvSjJaekp5azdEUXBqYjI1emRDQnZjeUE5SUhKbGNYVnBjbVVvSjI5ekp5azdEUXBqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNOQ2cwS1kyOXVjM1FnVUU5Uw0KVkNBOUlERXhPRGc1T3cwS1kyOXVjM1FnVWs5UFZDQTlJSEJoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNjdUxpY3BPeUF2THlEc29JRHNucVhzaG93ZzY2T283WXE0SU9LQWxDRHJpNlRycHF6cXNJQWdjbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrNjZXOElPeXd2dXVLbENEcXVMRHNwSUFOQ2cwS1kyOXVjM1FnUTA5U1UxOUlSVUZFUlZKVElEMGdldzBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUM0pwWjJsdUp6b2dKeW9uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFNHVmhaR1Z5Y3ljNklDZERiMjUwWlc1MExWUjVjR1VuTEEwS2ZUc05DbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3MEtJQ0J5WlhNdWQzSnBkR1ZJWldGa0tITjBZWFIxY3l3Z1QySnFaV04wTG1GemMybG5iaWg3SUNkRGIyNTANClpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2dZMmhoY25ObGREMTFkR1l0T0NjZ2ZTd2dRMDlTVTE5SVJVRkVSVkpUS1NrN0RRb2dJSEpsY3k1bGJtUW9TbE5QVGk1emRISnBibWRwWm5rb2IySnFLU2s3RFFwOURRb05DaTh2SUdOc1lYVmtaU0JEVEVucXNJQWc3SjZJNjRxVTdLZUFJT0tBbENEc2w0YnNuTHpycWJRZ0wzZGhhMlVnN0oyUjY0dTE3SmVRSU95THBPeVd0Q0R0bEl6cm42enF0N2pzbmJqc25iUWc3SldJNjRLMDdaV2dJT3lJbUNEc25vanFzb3dnN1pXYzY0dWtEUW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPeWR2ZXE0c0NEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpJQ2pyaTZUcnBxenNuWmdnWTJ4aGRXUmxRV05qYjNWdWRPeVpnQ0Rxc0puc25ZQWc3TGFjN0xLWUtTNE5DaTh2SU8yTWpPeWR2T3lkdENEdGdiUWc3SWlZSU95ZWlPeVd0Q0F6DQpNT3kwaUNEc3VwRHNpNXd1SU95ZXJPdWhuT3EzdU95ZHVPMlZtT3VwdENCRFRFbnFzSUFnN1l5TTdKMjg3SjJFSU9xd3NleUxvTzJWbU91dmdPdWhuQ0RzbnBEcmo1a2c2N0NZN0ppQjY1Q2M2NHVrTGcwS0x5OGc3THFRN0l1Y0lEWHN0SWdnNG9DVUlPdWhuT3EzdU95ZHVDRHNwNEh0bTRRZzdJT0lJT3F6aE95Z2xleWR0Q0RxczZmcnNKVHJvWndnN0o2aDdaaUE3Slc4SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTA3SmVRN0lTY0lPMlppT3ljdk91aG5DRHJoSmpzbHJUcXNJVHJpNlFvTXpEc3RJanJxYlFnNjRTSTY2eTBJT3VLcHV5ZGpDa05DbXhsZENCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQXdMQ0JsYldGcGJEb2diblZzYkNCOU93MEtablZ1WTNScGIyNGdZMnhoZFdSbFFXTmpiM1Z1ZENncElIc05DaUFnYVdZZ0tFUmhkR1V1Ym05M0tDa2dMU0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQQ0ExTURBd0tTQnlaWFIxY200Z1lXTmpiM1Z1ZEVOaFkyaGxMbVZ0WVdscw0KT3cwS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJR29nUFNCS1UwOU9MbkJoY25ObEtHWnpMbkpsWVdSR2FXeGxVM2x1WXlod1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuTG1Oc1lYVmtaUzVxYzI5dUp5a3NJQ2QxZEdZNEp5a3BPdzBLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJvWnpxdDdqc25iZ2c3SjIwNjZDbElPeVhodXlkakNEcms3RWc0b0NVSUc1MWJHd2dLaThnZlEwS0lDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUJFWVhSbExtNXZkeWdwTENCbGJXRnBiQ0I5T3cwS0lDQnlaWFIxY200Z1pXMWhhV3c3RFFwOURRb05DbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzTkNpQWdZMjl1YzNRZ1ptbHVaR1Z5SUQwZ2NISnZZMlZ6Y3k1d2JHRjANClptOXliU0E5UFQwZ0ozZHBiak15SnlBL0lDZDNhR1Z5WlNjZ09pQW5kMmhwWTJnbk93MEtJQ0IwY25rZ2V5QnlaWFIxY200Z2MzQmhkMjVUZVc1aktHWnBibVJsY2l3Z1d5ZGpiR0YxWkdVblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY3NJSE5vWld4c09pQjBjblZsSUgwcExuTjBZWFIxY3lBOVBUMGdNRHNnZlNCallYUmphQ0FvWDJVcElIc2djbVYwZFhKdUlHWmhiSE5sT3lCOURRcDlEUW9OQ214bGRDQjNZV3RwYm1jZ1BTQm1ZV3h6WlRzZ0x5OGc3SmV3N1lPQUlPdXdxZXluZ0NEaWdKUWc2NHVrNjZhczY0cVVJT3lXdE95d3FPMlV2Q0JGUVVSRVVrbE9WVk5GNjZHY0lPeWtrZXV6dFNEc29KWHJwcXp0bFpqc3A0RHJwNHdnN1pTRTY2R2M3SVM0N0lxa0lPdUNyZXU1aE91bHZDRHNwSVRzbmJqcmk2UU5DbVoxYm1OMGFXOXVJSGRoYTJWQ2NtbGtaMlVvS1NCN0RRb2dJR2xtSUNoM1lXdHBibWNwSUhKbGRIVnlianNOQ2lBZ2QyRnJhVzVuSUQwZ2RISjFaVHNOQ2lBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5DQpQaUI3SUhkaGEybHVaeUE5SUdaaGJITmxPeUI5TENBMU1EQXdLVHNOQ2lBZ2JHVjBJSEJ5YjJNN0RRb2dJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdEUW9nSUNBZ0x5OGdWMmx1Wkc5M2N6b2dZMjFrd3JkMlluTWc2cks5N0p5Z0lPeVhodXlkdENCdWIyUmw2Nlc4SU95bmdleWdrU3dnZDJsdVpHOTNjMGhwWkdVb1ExSkZRVlJGWDA1UFgxZEpUa1JQVnlucm9ad2c3SXFrN1krd0lPS0FsQTBLSUNBZ0lDOHZJT3l3dlNEc2w0YnJpcFFnN0lpbzdKMkFJT3k5bU95R2xPeWR0Q0RycDR6cms2VHNsclRzcDREcXM2QWc2NHVrNjZhczdKMllJT3lla095TG5TaGpiR0YxWkdVcDY0K0VJT3EzdUNEc3ZaanNocFRzbllRZzY2eTg2NkNrNjdDYjdKV0VJT3lXdE91V3BDRHNzTDNyajRRZzdKV0lJT3Vjck91THBDNE5DaUFnSUNBdkx5QmtaWFJoWTJobFpPdUtsQ0RzazdEc3A0QWc3SldLNjRxVTY0dWtLR1JsZEdGamFHVmtLM2RwYm1SdmQzTklhV1JsSU95aHNPMlZxZXlkZ0NEcw0Kdlpqc2hwUWc3TEM5N0oyMElPdUZ1T3kybk91UXFDRGlnSlFnN0l1azdMaWhLUzROQ2lBZ0lDQXZMeUJYYVc1a2IzZHo3SmVRN0lTZ0lHUmxkR0ZqYUdWa0lPeVhodXlkdE91UGhDRHJ0b0RycXFnbzZyQ1E3SXVjN0o2UUtlcXdnQ0Rzbzczc2xyVHJqNFFnN0o2UTdJdWQ3SjJBSU95Q3RPeVZoT3VDcU91S2xPdUxwQzROQ2lBZ0lDQndjbTlqSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3RFFvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzRFFvZ0lDQWdmU2s3RFFvZ0lIMGdaV3h6WlNCN0RRb2dJQ0FnTHk4Z2JXRmpUMU12NjZhczY0aUY3SXFrT2lEcXNKRHNpNXpzbnBEcnBid2c2NTJFN0pxMElHNXZaR1VnN0l1azdaYUpJTzJNak95ZHZPdWhuQ0RzcDRIc29KRWc3SXFrN1krd0lDaHNZWFZ1WTJoa0lPMloNCm1PcXl2ZXlYbENCUVFWUkk2ckNBSU91NWlPeVZ2ZTJWb0NEc2lKZ2c3SjZJN0phMElPeWdpT3VNZ09xeXZldWhuQ0RzZ3F6c21xa3BEUW9nSUNBZ2NISnZZeUE5SUhOd1lYZHVLSEJ5YjJObGMzTXVaWGhsWTFCaGRHZ3NJRnR3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBblkyeGhkV1JsTFdKeWFXUm5aUzVxY3ljcFhTd2dldzBLSUNBZ0lDQWdZM2RrT2lCU1QwOVVMQ0JrWlhSaFkyaGxaRG9nZEhKMVpTd2djM1JrYVc4NklDZHBaMjV2Y21VbkxBMEtJQ0FnSUgwcE93MEtJQ0I5RFFvZ0lIQnliMk11ZFc1eVpXWW9LVHNnTHk4ZzZyQ1E3SXVjN0o2UUlPeWR0T3V5cE8yS3VDRHJvNmp0bElUc2w1RHNoSndnNjdhRTY2YXNJQ2pxc0pEc2k1enNucEFnN0tLRjY2T002Nlc4SU91bmlleW5nQ0RzbFlycXNvd3BEUXA5RFFvTkNpOHZJT3lkdENCUVErdWx2Q0FuN0lTazdMbVlJT3lnaENqc2c0Z2dVRU1wSnlEc2c0SHRnNXpyb1p3ZzY1Q1k2NCtNNjZhdzY0dWtJT0tBbENEdGxJenJuNnpxdDdqc25iZ2dXK3kwDQppT3E0c08yWmxGMGc2N0tFN1lxOEtGQlBVMVFnTDNWdWFXNXpkR0ZzYkNuc25iUWc2N2FBNjZXNDY0dWtMZzBLTHk4Z2NtVm5hWE4wWlhJdGNISnZkRzlqYjJ3dWFuUHFzSUFnN0lTazdMbVk3WldjSU9xeWcreWRoQ0RxdDdqcmpJRHJvWndnNjVDWTY0K002NmF3NjR1a09pRHFzSkRzaTV6c25wQWc3SjZRNjQrWjdJdWM3SjZSSUNzZ0tPeWVpT3ljdk91cHRDa2c3SVNrN0xtWUlPMlB0T3VObEM0TkNpOHZJT0thb08rNGp5RHJzSmpyazV6c2k1d2dTRlJVVUNEc25aSHJpN1hzbllRZzY2aTg3S0NBSU91enRPdUN1Q0Rya3FRZzdaaTQ3TGFjN1pXZ0lPcXlneURpZ0pRZ2JXRmpUMU1nYkdGMWJtTm9ZM1JzSUdKdmIzUnZkWFRzbmJRZzdKMjBJTzJVaE91aG5PeUV1T3lLcE91bHZDRHNwb25zaTV3ZzdLS0Y2Nk9NN0l1YzdZS3NJT3lJbUNEc25vanJpNlF1RFFvdkx5QWdJQ0RxdDdqcm5wanNoSndnN1l5TTdKMjhLSEJzYVhOMHdyZnNoS1RzdVpnZzdZKzA2NDJVS2V5ZGhDQnNZWFZ1WTJoamRHenJzN1RyaTZRZw0KNjZpODdLQ0FJT3luZ095YXRPdUxwQ0RpZ0pRZ1ltOXZkRzkxZE95ZHRDRHNtckRycHF6cnBid2c3S085N0plczY0K0VJT3lla091UG1leUxuT3lla2V5ZGdDRHNuYlRycjdnZzdJS3M2NTI4N0tlRTY0dWtMZzBLWm5WdVkzUnBiMjRnZFc1cGJuTjBZV3hzVTJWc1ppZ3BJSHNOQ2lBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUZ0ZE93MEtJQ0IwY25rZ2V3MEtJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXcwS0lDQWdJQ0FnWTI5dWMzUWdURUZDUlV3Z1BTQW5ZMjl0TG1Oc1lYVmtaV0p5YVdSblpTNTNZWFJqYUdWeUp6c05DaUFnSUNBZ0lHTnZibk4wSUhCc2FYTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua25MQ0FuVEdGMWJtTm9RV2RsYm5Sekp5d2dURUZDUlV3Z0t5QW5MbkJzYVhOMEp5azdEUW9nSUNBZ0lDQmpiMjV6ZENCcGJuTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua24NCkxDQW5RWEJ3YkdsallYUnBiMjRnVTNWd2NHOXlkQ2NzSUNkRGJHRjFaR1ZDY21sa1oyVW5LVHNOQ2lBZ0lDQWdJSFJ5ZVNCN0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktIQnNhWE4wS1NrZ2V5Qm1jeTUxYm14cGJtdFRlVzVqS0hCc2FYTjBLVHNnY21WdGIzWmxaQzV3ZFhOb0tIQnNhWE4wS1RzZ2ZTQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLR2x1YzNRcEtTQjdJR1p6TG5KdFUzbHVZeWhwYm5OMExDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTd2dabTl5WTJVNklIUnlkV1VnZlNrN0lISmxiVzkyWldRdWNIVnphQ2hwYm5OMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DaUFnSUNBZ0lIUnllU0I3SUhOd1lYZHVVM2x1WXlnbmJHRjFibU5vWTNSc0p5d2dXeWRpYjI5MGIzVjBKeXdnSjJkMWFTOG5JQ3NnY0hKdlkyVnpjeTVuWlhSMWFXUW9LU0FySUNjdkp5QXJJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3DQpJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUNBZ2RISjVJSHNnYzNCaGQyNVRlVzVqS0Nkc1lYVnVZMmhqZEd3bkxDQmJKM0psYlc5MlpTY3NJRXhCUWtWTVhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lIMGdaV3h6WlNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXcwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2R5WldjbkxDQmJKMlJsYkdWMFpTY3NJQ2RJUzBOVlhGeFRiMlowZDJGeVpWeGNUV2xqY205emIyWjBYRnhYYVc1a2IzZHpYRnhEZFhKeVpXNTBWbVZ5YzJsdmJseGNVblZ1Snl3Z0p5OTJKeXdnSjBOc1lYVmtaVUp5YVdSblpWZGhkR05vWlhJbkxDQW5MMlluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNnbjdKNlE2NCtaN0l1YzdKNlJLRU5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWElwSnlrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwSw0KSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KMk5zWVhWa1pXSnlhV1JuWlRvdkx5RHJrN0hyb1owbktUc2dmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnSUNCMGNua2dldzBLSUNBZ0lDQWdJQ0JqYjI1emRDQnBibk4wSUQwZ2NHRjBhQzVxYjJsdUtIQnliMk5sYzNNdVpXNTJMa3hQUTBGTVFWQlFSRUZVUVNCOGZDQndZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBblFYQndSR0YwWVNjc0lDZE1iMk5oYkNjcExDQW5RMnhoZFdSbFFuSnBaR2RsSnlrN0RRb2dJQ0FnSUNBZ0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWcNCmZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlEwS0lDQWdJQ0FnZlNCallYUmphQ0FvWDJVcElIdDlEUW9nSUNBZ2ZRMEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUJtWVdsc0xYTnZablFnNG9DVUlPdXF1eURzcDREc21yUWc2cktNSU95ZWlPeVd0T3VQaENEdGxJenJuNnpxdDdqc25iZ2c3S3E5SU9xNHNPeVd0U0RzZ3Ezc29KenJpcFFnN0oyMDY2KzRJT3VCbmV1Q3JPdUxwQ0FxTHlCOURRb2dJSEpsZEhWeWJpQnlaVzF2ZG1Wa093MEtmUTBLRFFvdkx5RHJpNlRycHF3b01URTRPRGdwNnJDQUlPdVdvQ0Rzbm9qc25MenJxYlFnNjRHSTY0dWtJT0tBbENEc3RJanF1TER0bVpRZzdJdWNJT3VDcU95ZGdDRHNoTGpzaFpnZzdLQ1Y2NmFzSUNqc2w0YnNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeUxwTzJNcUNrTkNtWjFibU4wYVc5dUlITm9kWFJrYjNkdVFuSnBaR2RsS0NrZ2V3MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJSElnUFNCb2RIUndMbkpsY1hWbGMzUW9leUJvYjNOME9pQW5NVEkzDQpMakF1TUM0eEp5d2djRzl5ZERvZ01URTRPRGdzSUhCaGRHZzZJQ2N2YzJoMWRHUnZkMjRuTENCdFpYUm9iMlE2SUNkUVQxTlVKeXdnZEdsdFpXOTFkRG9nTVRVd01DQjlMQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3ZlNrN0RRb2dJQ0FnY2k1dmJpZ25kR2x0Wlc5MWRDY3NJQ2dwSUQwK0lIc2dkSEo1SUhzZ2NpNWtaWE4wY205NUtDazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZTQjlLVHNOQ2lBZ0lDQnlMbVZ1WkNncE93MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DbjBOQ2cwS1kyOXVjM1FnYzJWeWRtVnlJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvS0hKbGNTd2djbVZ6S1NBOVBpQjdEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblQxQlVTVTlPVXljcElIc2djbVZ6TG5keWFYUmxTR1ZoWkNneU1EUXNJRU5QVWxOZlNFVkJSRVZTVXlrN0lISmxkSFZ5YmlCeVpYTXVaVzVrS0NrN0lIME5DaUFnYVdZZ0tISmxjUzUxY213Z1BUMDlJQ2N2YUdWaA0KYkhSb0p5a2dldzBLSUNBZ0lDOHZJSFk2SU9xd2tPeUxuT3lla0NEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENEcXRhenJzb1Rzb0lRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU9xemhPeUdqU0RyajR6cXM2QWc3SjZJNjRxVTdLZUFJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsWmpyaXBRZzdKcXA2NCtFRFFvZ0lDQWdMeThnS0hZeUlEMGc3TEM5SU95SXFPcTVnQ0RzaUpqc29KWHRqSkFzSUhZeklEMGdMMkZqWTI5MWJuUWc3TGFVNnJDQTdZeVFMQ0IyTkNBOUlDOTFibWx1YzNSaGJHd2c3TGFVNnJDQTdZeVFLUTBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCM1lYUmphR1Z5T2lCMGNuVmxMQ0IyT2lBMElIMHBPdzBLSUNCOURRb2dJQzh2SU95ZHRDQlFRK3lYa0NEcm9aenF0N2pzbmJqcmtKd2c3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRGlnSlFnN1pTTTY1K3M2cmU0N0oyNElPeXlxeUR0bVpUcnFiVEN0KzJaaU95ZHRDQWk2NGlFNnJXc0lPcXpoT3lnbGV5Y3ZPdWgNCm5DRHNrN0RyaXBUc3A0QWlJT3V6dE95WHJPeWp2T3VLbENEcmpiQWc3Sk8wNjR1a0xnMEtJQ0F2THlEcXNKRHNpNXpzbnBEcXNJQWc2NHUxN1pXWTY0cVVJT3lkdE95Y29Eb2c2NHVrNjZhczY2VzhJT3k4bk91cHRDRHNtNHpyc0kzc2w0WHNuTHpyb1p3ZzdZRzA2NkdjNjVPYzZyQ0FJT3lMcE95Z25DRHRtTGpzdHB6cmo3d2c2cldzNjQrRklPeUNyT3lhcWV1ZmlleWR0Q0RyZ3BqcXNJVHJpNlF1RFFvZ0lDOHZJT3F3a095TG5PeWVrT3VLbENEdGpJenNuYnpycDR3ZzdKMjk3Snk4NjYrQTY2R2NJT3lDck95YXFldWZpU0F3SU1LM0lPdU1nT3E0c0NBd0lPS0FsQ0Rxc29EdGhxRHJwNHdnN0pPdzY0cVVJT3lDck91ZWpPeVhrT3F5akNEcnVZVHNtcW5zbllRZzY2eTg2NmFzN0tlQUlPeVZpdXVLbE91THBDNE5DaUFnTHk4ZzdLTzg3SjJZT2lEc2w2enF1TEFnNnJPRTdLQ1Y3SjIwSU91enRPeVhyT3VQaENEc25vWHNucVhxdG96c25iUWc2NmVNNjZPTTY1Q1E3SjJFSU95SW1DRHNub2pyaTZRbzdKeWc3WnFvDQo3SVN4N0oyQUlPeUxwT3lnbkNEdG1ManN0cHdnNjVXTTY2ZU1JT3lWakNEc2lKZ2c3SjZJN0oyTUlPS0FsQ0RyaTZUcnBxd2dMMmhsWVd4MGFPeWRtQ0J3Y205aWJHVnRJT3l3dU9xem9Da3VEUW9nSUdsbUlDaHlaWEV1ZFhKc0lEMDlQU0FuTDJGalkyOTFiblFuS1NCN0RRb2dJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJR0ZqWTI5MWJuUTZJR05zWVhWa1pVRmpZMjkxYm5Rb0tTd2dZMnhoZFdSbE9pQm9ZWE5EYkdGMVpHVW9LU0I5S1RzTkNpQWdmUTBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2ZDJGclpTY3BJSHNOQ2lBZ0lDQnBaaUFvSVdoaGMwTnNZWFZrWlNncEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dabUZzYzJVc0lIQnliMkpzWlcwNklDZGpiR0YxWkdVdGJXbHpjMmx1WnljZ2ZTazdEUW9nSUNBZ2QyRnJaVUp5YVdSblpTZ3BPdzBLSUNBZ0lISmxkSFZ5YmlCcQ0KYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0IzWVd0cGJtYzZJSFJ5ZFdVZ2ZTazdEUW9nSUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dldzBLSUNBZ0lHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdEUW9nSUNBZ2NtVjBkWEp1T3cwS0lDQjlEUW9nSUM4dklPeTBpT3E0c08yWmxDRGlnSlFnN0oyMElGQkQ2Nlc4SUNmc2c0Z2dVRU1uSU95RGdlMkRuT3VobkNEcmtKanJqNHpycHJEcmk2UWdLTzJVak91ZnJPcTN1T3lkdUNCYjdMU0k2cml3N1ptVVhTRHJzb1R0aXJ3cExnMEtJQ0F2THlEc25aSHJpN1hzbllRZzY2aTg3S0NBSU8yZG1PdWdwT3V6dE91Q3VDRHJrcVFnN0tDVjY2YXM3WldjNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc3BvbnMNCmk1d2c3S085N0plczY0K0VJTzJhak95TG9PeWRnQ0RyajRUc3NLbnRsWnpyaTZRdURRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OTFibWx1YzNSaGJHd25LU0I3RFFvZ0lDQWdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2djR3hoZEdadmNtMDZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdmU2s3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdEUW9nSUNBZ0lDQnphSFYwWkc5M2JrSnlhV1JuWlNncE93MEtJQ0FnSUNBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUhWdWFXNXpkR0ZzYkZObGJHWW9LVHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYmQyRjBZMmhsY2wwZzdMU0k2cml3N1ptVUtIVnVhVzV6ZEdGc2JDa2c0b0NVSU95Z25PcXhzRG9uTENCeVpXMXZkbVZrTG1wdmFXNG9KeXdnSnlrZ2ZId2dKeWpzbDRic25Zd3BKeWs3RFFvZ0lDQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSEJ5YjJObGMzTXVaWGhwDQpkQ2d3S1N3Z01qQXdLVHNOQ2lBZ0lDQjlMQ0F5TlRBcE93MEtJQ0FnSUhKbGRIVnlianNOQ2lBZ2ZRMEtJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFF3TkN3Z2V5Qmxjbkp2Y2pvZ0owNXZkQ0JtYjNWdVpDY2dmU2s3RFFwOUtUc05DZzBLTHk4ZzdKMjA2Nis0SU91V29DRHNub2pzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lpaGV1ampDQW83SjZRNjQrWklPeUxuT3lla1NBcklHNXdiU0JpZFdsc1pDRHNwSkhyczdVZzdJdWs3WmFKSU91TWdPdTVoQ2tOQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXcwS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2NISnZZMlZ6Y3k1bGVHbDBLREFwT3cwS0lDQndjbTlqWlhOekxtVjRhWFFvTVNrN0RRcDlLVHNOQ25ObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3NJQ2dwSUQwK0lIc05DaUFnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHRnYlRyb1p6cms1d2c2NHVrNjZhcw0KSU9xd2tPeUxuT3lla0NEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93MEtmU2s3RFFvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJQ2RzYjJOaGJHaHZjM1FuNnJDQUlEbzZNZXVobkNEcnFMenNvSUFnN1pXMDdJU2Q2NUNZNjRxVUlPMlptT3F5dmV5WGtPeUVuQTBLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlFbFFkalRyb1p3ZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDRHJpNlRycHF3ZzZybW83SnF3NnJpd3dyZnFzNFRzb0pVZzdLR3c3WnFNNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJqWmdnNjZ5NDdLQ2NJT3VNZ095ZGtTanJpNlRycHF6c21ZQWc2NCtaN0oyOEtTNE5DbU52Ym5OMElITmxjblpsY2pZZ1BTQm9kSFJ3TG1OeVpXRjBaVk5sY25abGNpaHpaWEoyWlhJdWJHbHpkR1Z1WlhKektDZHlaWEYxWlhOMEp5bGJNRjBwT3cwS2MyVnlkbVZ5Tmk1dmJpZ24NClpYSnliM0luTENBb0tTQTlQaUI3ZlNrN0lDOHZJRG82TWV5ZGhDRHJxcnNnN0o2aDdKV0U2NCtFS0VWQlJFUlNTVTVWVTBYQ3QwbFFkallnN0plRzdKMk1LU0JKVUhZMDY2ZU03Snk4NjZHY0lPcXpoT3lHalNEcmo1bnNucEVOQ25ObGNuWmxjall1YkdsemRHVnVLRkJQVWxRc0lDYzZPakVuS1RzTkNnPT0NCjo6V1NJTEVOVDo6DQpKeUJEYkdGMVpHVWdRbkpwWkdkbElIZGhkR05vWlhJZ2MybHNaVzUwSUd4aGRXNWphR1Z5SUNodWJ5QjNhVzVrYjNjcElDMGdjbVZuYVhOMFpYSmxaQ0IwYnlCeWRXNGdZWFFnYkc5bmFXNEtVMlYwSUdaemJ5QTlJRU55WldGMFpVOWlhbVZqZENnaVUyTnlhWEIwYVc1bkxrWnBiR1ZUZVhOMFpXMVBZbXBsWTNRaUtRcFRaWFFnYzJnZ1BTQkRjbVZoZEdWUFltcGxZM1FvSWxkVFkzSnBjSFF1VTJobGJHd2lLUXBrYVhJZ1BTQm1jMjh1UjJWMFVHRnlaVzUwUm05c1pHVnlUbUZ0WlNoWFUyTnlhWEIwTGxOamNtbHdkRVoxYkd4T1lXMWxLUXB6YUM1RGRYSnlaVzUwUkdseVpXTjBiM0o1SUQwZ1pHbHlDbk5vTGxKMWJpQWlZMjFrSUM5aklHNXZaR1VnYzJOeWFYQjBjMXhpY21sa1oyVXRkMkYwWTJobGNpNXFjeUlzSURBc0lFWmhiSE5sQ2c9PQ0KOjpFTkQ6Og0K";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAACO4guNk4MCAJODAgAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBb3ZMeURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBS0x5OGc3SUtzN0pxcDY3S1ZPaUR0ajRuc2c0SHNpNXpzbDVRZzZyQ1E3SXVjN0o2UTZyQ0FJT3lla091UG1leWN2T3VobkNEc3ZLRHJpNlFnS095SW1PdVBtU0RzaTV6c25wSHNuWUFnYm5CdElISjFiaUJpY21sa1oyVXBDaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdUNpOHZDaTh2SU95R2pldVBoQ0RzaEtUcXM0UTZJTzJCdE91aG5PdVRuT3VsdkNEc21wVHNzcTNycDRqcmk2UWc3SU9JNjZHY0lPeUxuT3VQbWUyVm1PdXB0Q0F6TUg0ME1PeTBpT3F3Z0NEcXQ3anJnNlVnNjRLZzdKV0U2ckNFNjR1a0xnb3ZMeURpaHBJZzY0dWs2NmFzNjZXOElPeThwQ0RybFl3ZzdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZGhDRHRsWmpyZ3BnZzdKZTA3SmEwSU95RGdleUxuQ0RyaklEcXVMRHNpNXp0Z3FUcXM2QW9jM1J5WldGdExXcHpiMjRnNjR5QTdabVVJT3VxcU91VG5Da3NDaTh2SUNBZzZyQ0E3SjIwNjVPY0sreVlpT3lMbkNneE1USHFzYlFwNjRxVUlPeXlxeURycVpUc2k1enNwNERyb1p3ZzdaV2NJT3V5aU91bmpDRHNuYjN0bm96cmk2UXVJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2Nnk0NnJXczY2ZU1JT3V6dE91Q3RPdXZnT3VobkNEcnVhRHJwYlRyaTZRdUNpOHZJT3lFdU95Rm1PeWRnQ0F6TU91eWlDRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdaVzBJT3VNZ08yWmxPcXdnQ0RyckxUdGxaenRub2dnNnJpNDdKYTA3S2VBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdUNpOHZDaTh2SU95Z2hPeWduRG9nN0oyMElGQkQ3SmVRSUVOc1lYVmtaU0JEYjJSbDZyQ0FJT3lFcE95NW1NSzM2NkdjNnJlNDdKMjQ2NCs4SU95ZWlPeWRoQ0Rxc29NZ0tHTnNZWFZrWlNBdExYWmxjbk5wYjI0ZzdKeTg2NkdjSU8yWmxleWR1Q2tLTHk4ZzdLTzg3SjJZT2lEc2dxenNtcW5ybjRuc25ZQWc2ckNCN0o2UUlPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFuT3VMcEM0S0NtTnZibk4wSUdoMGRIQWdQU0J5WlhGMWFYSmxLQ2RvZEhSd0p5azdDbU52Ym5OMElHWnpJRDBnY21WeGRXbHlaU2duWm5NbktUc0tZMjl1YzNRZ2IzTWdQU0J5WlhGMWFYSmxLQ2R2Y3ljcE93cGpiMjV6ZENCd1lYUm9JRDBnY21WeGRXbHlaU2duY0dGMGFDY3BPd3BqYjI1emRDQjdJSE53WVhkdUxDQnpjR0YzYmxONWJtTWdmU0E5SUhKbGNYVnBjbVVvSjJOb2FXeGtYM0J5YjJObGMzTW5LVHNLQ2k4dklPMkJ0T3Vobk91VG5PdWx2Q0RydVlnZzdZKzA2NDJVN0plUTdJU2NJT3lMcE8yV2lTRGlnSlFnN0tDQTdKNmw3SWFNN0plUTdJU2NJT3lMcE8yV2llMlZtT3VwdENEdGxJVHJvWnpzb0ozdGlyZ2c2NmVsNjUyOUtFTk1RVlZFUlM1dFpDRHJrN0VwN0oyRUNpOHZJT3VucENEdGhMUWc3S2VLN0phMDdLQzQ3SVNjSURRMTdMU0lMKzJFdE9xNWpPeW5nQ0RyaXBEcm9LVHNwNFRyaTZRZ0tPdTVpQ0R0ajdUcmpaUWdLeURydG9EcXNJRHF1TERyaXFVZzdMQ282NHVvN0oyMDY2bTBJSDR6N0xTSUwrMkV0Q2t1Q21OdmJuTjBJRVZOVUZSWlgwTlhSQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3Q25SeWVTQjdJR1p6TG0xclpHbHlVM2x1WXloRlRWQlVXVjlEVjBRc0lIc2djbVZqZFhKemFYWmxPaUIwY25WbElIMHBPeUI5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlFwamIyNXpkQ0JEVEVGVlJFVmZSVTVXSUQwZ1QySnFaV04wTG1GemMybG5iaWg3ZlN3Z2NISnZZMlZ6Y3k1bGJuWXNJSHNLSUNCTlFWaGZWRWhKVGt0SlRrZGZWRTlMUlU1VE9pQW5NQ2NzSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNnNTNxc0lFZzY2cW82NU9jSU91QmxDQW83S2VuN0oyQUlPdXN1T3Exck95WGxDRHJ0b2p0bFlUc21wUXBDaUFnUTB4QlZVUkZYME5QUkVWZlJFbFRRVUpNUlY5T1QwNUZVMU5GVGxSSlFVeGZWRkpCUmtaSlF6b2dKekVuTENBdkx5RHRoTFFnN0pxVTdKVzlJT3VUc1NEcnRvRHFzSUFnN1ppNDdMYWNJT3VCbEFvZ0lFUkpVMEZDVEVWZlZFVk1SVTFGVkZKWk9pQW5NU2NzQ24wcE93b0tMeThnN0lpbzZybUFJT3lMcE8yV2lTanFzSkRzaTV6c25wQWc3SXFrN1krdzdKMkFJSE4wWkdsdklHbG5ibTl5WlNuc2w1RHNoSnpyajRRZzY2eTQ3S0NjNjZXOElPeTJsT3lnZ2UyVm9DRHNpSmdnN0o2STZyS01JT3k5bU95R2xDRHJvWnpxdDdqcnBid2c3WXlNN0oyODdKZVE2NCtFSU91Q3FPcTR0T3VMcEM0S0x5OGc3SnlFN0xtWU9pRHNub1RzaTV3ZzdZKzA2NDJVN0oyWUlHTnNZWFZrWlMxaWNtbGtaMlV1Ykc5bklDanNuSWpyajRUc21yQWdKVlJGVFZBbExDRHJwNlVnSkZSTlVFUkpVaWt1SURKTlFpRHJoSmpzbkx6cnFiUWdMbTlzWk91aG5DRHRsWndnN0lTNDY0eUE2NmVNSU91enRPcTBnQzRLWTI5dWMzUWdURTlIWDBaSlRFVWdQU0J3WVhSb0xtcHZhVzRvYjNNdWRHMXdaR2x5S0Nrc0lDZGpiR0YxWkdVdFluSnBaR2RsTG14dlp5Y3BPd3BqYjI1emRDQmZiM0pwWjB4dlp5QTlJR052Ym5OdmJHVXViRzluTG1KcGJtUW9ZMjl1YzI5c1pTazdDbU52Ym5OdmJHVXViRzluSUQwZ1puVnVZM1JwYjI0Z0tDa2dld29nSUdOdmJuTjBJR0Z5WjNNZ1BTQkJjbkpoZVM1d2NtOTBiM1I1Y0dVdWMyeHBZMlV1WTJGc2JDaGhjbWQxYldWdWRITXBPd29nSUY5dmNtbG5URzluTG1Gd2NHeDVLRzUxYkd3c0lHRnlaM01wT3dvZ0lIUnllU0I3Q2lBZ0lDQjBjbmtnZXdvZ0lDQWdJQ0JwWmlBb1puTXVaWGhwYzNSelUzbHVZeWhNVDBkZlJrbE1SU2tnSmlZZ1puTXVjM1JoZEZONWJtTW9URTlIWDBaSlRFVXBMbk5wZW1VZ1BpQXlJQ29nTVRBeU5DQXFJREV3TWpRcElHWnpMbkpsYm1GdFpWTjVibU1vVEU5SFgwWkpURVVzSUV4UFIxOUdTVXhGSUNzZ0p5NXZiR1FuS1RzS0lDQWdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJTzJhak95Z2hDRHNpNlR0aktqcmlwUWc2NnkwN0l1Y0lDb3ZJSDBLSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0FuV3ljZ0t5QnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxVM1J5YVc1bktDZHJieTFMVWljcElDc2dKMTBnSnlBckNpQWdJQ0FnSUdGeVozTXViV0Z3S0NoaEtTQTlQaUFvZEhsd1pXOW1JR0VnUFQwOUlDZHpkSEpwYm1jbklEOGdZU0E2SUVwVFQwNHVjM1J5YVc1bmFXWjVLR0VwS1NrdWFtOXBiaWduSUNjcElDc2dKMXh1SnpzS0lDQWdJR1p6TG1Gd2NHVnVaRVpwYkdWVGVXNWpLRXhQUjE5R1NVeEZMQ0JzYVc1bEtUc0tJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUR0akl6c25id2c2NkdjNnJlNElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUcnBxenJpcFFnNnJPRTdJYU5JQ292SUgwS2ZUc0tDbU52Ym5OMElGQlBVbFFnUFNCT2RXMWlaWElvY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDFCUFVsUXBJSHg4SURFeE9EZzRPeUF2THlCQ1VrbEVSMFZmVUU5U1ZPdUtsQ0R0aFl6c2lxVHRpcmpzbXFrZ0tPMlBpZXlHak95WGxDQXhNVGc0T0NEcXM2RHNvSlVwQ2k4dklPdUxwT3VtckNEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENBdmFHVmhiSFJvNjZHY0lPdUZ1T3kybk8yVm5PdUxwQzRnN0wyVTY1T2M2Nlc4SUhCMWJHekN0K3V6dGV5Q3JPMlZ0T3VQaENBcUt1eWR0T3V2dUNEcmxxQWc3SjZJNjRxVUlPdUxwT3Vtck91S2xDRHNtSnNnN0wyVTY1T2NJT3EzdU91TWdPdWhuQ29xNjUyOENpOHZJT3E3a091THBDRHN2SnpxdUxBZzdLQ0U3SmVVSU95RGlDRHJqNW5zbnBIc25iUWc3SldJSU91Q21PeVlxT3VMcENqdGhMRHJyN2pyaEpEc25iUWc2NXlvNjRxVUlPdVRzU2t1SU8yVWpPdWZyT3EzdU95ZHVPeWR0Q0RzbmJRZzZyQ1M3Snk4NjZHY0lPcTFyT3V5aE95Z2hPeWRoQ0Rxc0pEc3A0RHRsYlFnN0o2czdJdWM3SjZSN0l1YzdZS282NHVrTGdvdkx5RHJqNW5zbnBIc25iUWc2N0NVNjRDTTY0cVVJT3lJbU95Z2xleWRoQ0R0bFpqcnFiUWc3SjIwSU95SXEreWVrT3VsdkNEc21LenJwcXpxczZBZ1kyOWtaUzUwYyt5ZG1DQkNVa2xFUjBWZlRVbE9YMWJyajRRZzZyQ1o3SjIwSU95WXJPdW1zT3VMcEM0S1kyOXVjM1FnUWxKSlJFZEZYMVlnUFNBek9Ec0tMeThnNnJpdzY3TzRJT3VxcU91TnVDNGc3SnFVN0xLdEtPMlVqT3Vmck9xM3VPeWR1Q25zbmJRZ2JXOWtaV3pzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3EzdUNEc21wVHNzcTNycDR3ZzZyZTRJT3VxcU91TnVPdWhuQ0Rzc3BqcnBxenRsWnpyaTZRdUNpOHZJR2hoYVd0MVBldTVvT3VtaEMvcXNJRHJzcnpzbTRBc0lITnZibTVsZEQzc3BKSHFzSVFzSUc5d2RYTTk2cml3NjdPNEtPeTFuT3F6b08yU2lPeW5pQ3dnN0tHdzZyaUlJT3VLa091bXZDa0tZMjl1YzNRZ1EweEJWVVJGWDAxUFJFVk1JRDBnY0hKdlkyVnpjeTVsYm5ZdVFsSkpSRWRGWDAxUFJFVk1JSHg4SUNkdmNIVnpKenNLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdDbU52Ym5OMElGUlZVazVmVkVsTlJVOVZWRjlOVXlBOUlEa3dNREF3T3lBZ0lDOHZJT3lhbE95eXJTQXg2ckcwSU95Z25PMlZuT3lMbk9xd2hBcGpiMjV6ZENCTlFWaGZWRlZTVGxNZ1BTQXpNRHNnSUNBZ0lDQWdJQ0FnSUNBdkx5RHNuYlRycDR6dGdid2c3Sk93NjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFZ0tPdU1nTzJabENEcmlJVHNvSUVnNjdDcDdLZUFLUW9LTHk4ZzRwU0E0cFNBSU95WWlPeUxuQ0RzZ3F6c29JUWc2NkdjNjVPY0lDaHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FnNG9DVUlHSjFhV3hrTFdkc2IzTnpZWEo1TG1wejdKbUFJT3F3bWV5ZGdDRHRqSXpzaEp3cElPS1VnT0tVZ0FwbWRXNWpkR2x2YmlCc2IyRmtSWGhoYlhCc1pYTW9LU0I3Q2lBZ2RISjVJSHNLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZHlaV052YlcxbGJtUXRaWGhoYlhCc1pYTXViV1FuS1N3Z0ozVjBaamduS1RzS0lDQWdJR052Ym5OMElITmxZMGxrZUNBOUlHMWtMbk5sWVhKamFDZ3ZYaU1qSU95MmxPeXluQ0RzbUlqc2k1eGNjeW9rTDIwcE93b2dJQ0FnYVdZZ0tITmxZMGxrZUNBOVBUMGdMVEVwSUhKbGRIVnliaUJiWFRzS0lDQWdJR052Ym5OMElHVjRZVzF3YkdWeklEMGdXMTA3Q2lBZ0lDQnNaWFFnWTNWeUlEMGdiblZzYkRzS0lDQWdJR1p2Y2lBb1kyOXVjM1FnY21GM0lHOW1JRzFrTG5Oc2FXTmxLSE5sWTBsa2VDa3VjM0JzYVhRb0oxeHVKeWtwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlISmhkeTV5WlhCc1lXTmxLQzljY3lza0x5d2dKeWNwT3dvZ0lDQWdJQ0JqYjI1emRDQm9JRDBnYkdsdVpTNXRZWFJqYUNndlhpTWpJMXh6S3lndUt6OHBYSE1xSkM4cE93b2dJQ0FnSUNCcFppQW9hQ2tnZXlCamRYSWdQU0I3SUdsdWNIVjBPaUJvV3pGZExDQnpkV2RuWlhOMGFXOXVjem9nVzEwZ2ZUc2daWGhoYlhCc1pYTXVjSFZ6YUNoamRYSXBPeUJqYjI1MGFXNTFaVHNnZlFvZ0lDQWdJQ0JqYjI1emRDQmlJRDBnYkdsdVpTNXRZWFJqYUNndlhseHpLaTFjY3lzb0xpcy9LVnh6S2lRdktUc0tJQ0FnSUNBZ2FXWWdLR0lnSmlZZ1kzVnlLU0JqZFhJdWMzVm5aMlZ6ZEdsdmJuTXVjSFZ6YUNoaVd6RmRMbk53YkdsMEtDY2dMeUFuS1M1cWIybHVLQ2NnSnlrcE93b2dJQ0FnZlFvZ0lDQWdjbVYwZFhKdUlHVjRZVzF3YkdWekxtWnBiSFJsY2lnb1pTa2dQVDRnWlM1emRXZG5aWE4wYVc5dWN5NXNaVzVuZEdnZ1BpQXdLVHNLSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SmlJN0l1Y0lPeUNyT3lnaENEcm9aenJrNXdnN0l1azdZeW9JQ2pzbDRic25iUWc3S2VFN1phSktUb25MQ0JsTG0xbGMzTmhaMlVwT3dvZ0lDQWdjbVYwZFhKdUlGdGRPd29nSUgwS2ZRb0tMeThnNHBTQTRwU0FJT3luZ095TG5PdXN1Q0FvN0lTYzY3S0VJSEpsWTI5dGJXVnVaT3laZ0NEcXNKbnNuWUFnNnJlYzdMbVpJT0tBbENEcnNKVHF2cmpycWJRZzZyZTQ3S3E5NjQrRUlPMlZxT3E3bUNrZzRwU0E0cFNBQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFQ2k4dklPeWp2Q0Rzbm9UcnJMVHJvWndnN0ppazdaVzA3WlcwSURQcXNKd2c3S0NjN0pXSTdKMjBJT3lnaE91MmdDQWk3WkdjNnJpd0lPcXpvT3k1cUNBcklPeVd0T3lJbkNEcnM0RHFzcjBpN0oyMElPdVFuT3VMcEM0ZzdKZXQ3WldnSU91MmhPdW1yQ0RpZ0pRS0x5OGc3WUcwNjZHYzY1T2NJRDBnNjZ5NDdKNmxJT3VMcE91VHJPcTRzQ2pzc0wzc25aZ3BMQ0RzbXFuc2xyUWc3WWExN0oyOHdyZnJwNTdzdHFUcnNwVWdQU0JqYjJSbExuUnpJSEpsWm1sdVpVRnBVM1ZuWjJWemRHbHZibk1nN1p1RTdMS1k2NmFzS09xNHNPcXpoT3lnZ1NrdUNtTnZibk4wSUZOVVdVeEZYMUpWVEVWVElEMGdXd29nSUNjeExpRHRsYlRzbXBUc3NyUTZJT3VxcU91VG9DRHJyTGpxdGF6cmlwUWc3WlcwN0pxVTdMSzA2NkdjTGlBbzY3TzA2NE9GNjR1STY0dWs0b2FTNjdPMDY0SzA3SnFVS1Njc0NpQWdKekl1SU91S3BldVBtZXlnZ1NEcnA1RHRsWmpxdUxBNklPdVFrT3lXdE95YWxPS0drdTJXaU95V3RPeWFsQ3dnZnV5WGlDRHJ1YnpxdUxBbzY3Q1U2NENNN0plSTdKYTA3SnFVNG9hUzY3Q1U2citvN0phMDdKcVVLUzRnNjR1b0xDRHNvb1hybzR6Q3QrdW5qT3Vqak1LMzdKZXc3TEswd3JmdGxiVHNwNERDdCtxNHNPdWhuY0szNjRXNTdKMk1JT3VUc1NEc2k1enNpcVR0aFp6c25iUWc3S084N0xLMDdKMjRJT3F5c09xenZPdUtsQ0RzaUpqcmo1bnRtSlVnN0p5ZzdLZUFLT3lYc095eXRPdVB2T3lhbEN3ZzY0VzU3SjJNNjQrODdKcVVLUzRuTEFvZ0lDY3pMaURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3T2lBaWZ1MlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlpRHJqSURzaTZBZ0luN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRaUlPcTFyT3loc0NEc21yRHNoS0F1SU91THFDd2c3S0NWN0xHRjdJT0JJT3UyaU9xd2dNSzM3SjI4NjdhQUlPcTRzT3VLcFNEc29KenRsWnpDdCt1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPcXlzT3F6dk1LMzdLQ1Y2N08wSU91enRPMll1Q0RzbFlqc2k2enNuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMmVpQzRuTEFvZ0lDYzBMaURzdXBEc283enNscnp0bFp3ZzZySzk3SmEwT2lCKzdaV1k3SXVjNnJLZzdKYTA3SnFVUCtLR2tuN3RsYURxdVl6c21wUS9MQ0RxczRUc2k1enJpNlRpaHBMc25vanJpNlFzSU95WHJPeXRpT3VMcE9LR2t1MlpsZXlkdU8yVm1PdUxwQ3dnNnJ1WTRvYVM3SmVRNnJLTUxpQis3SXVjSU91NXZPcTRzT3F3Z0NEc2xyVHNnNG50bFpqcnFiUWc3WXlNN0pXRjdaV1k2NkNrNjRxVUlPeWdsZXV6dE91bHZDRHNvN3pzbHJUcm9ad2c2Nnk0N0o2bDdKMkVJT3VMcE95TG5DRHNrN1RyaTZRdUp5d0tJQ0FuTlM0ZzY2cUY3SUtzSyt1cWhleUNyQ0RxdUlqc3A0QTZJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclFnNjQrWjdJS3M2NkdjS095ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVTRvYVM3SjIwN0o2UTY2VzhJT3VQak91Z3BPdXdtK3lWbU95V3RPeWFsQ2tzSU95MW5PeUdqTzJWbkNCNzY2cUY3SUtzZmVxd2dDQjc2NnFGN0lLc2ZlMlZ0T3lFbkNEdG1KWHRnNXpyb1p3bzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5PS0drdXllbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3cExpY3NDaUFnSnpZdUlPMlJuT3E0c0RvZzY1Q1k3SmEwN0pxVTRvYVM2NCs4N0pxVUxpY3NDaUFnSnpjdUlPeWtoQ0RxdGF6c29iQTZJT3lia091enVPeWR0Q0R0bFp3ZzdLU0U3SjIwNjZtMElPeTJsT3l5bk91UGhDRHJzSmpyazV6c2k1d2c3WldjSU95a2hPdWhuQzRnN0o2RTdKMlk2NkdjSU95a2hPeWRoQ0RyaXBqcnBxenNwNEFnN0pXSzY0cVU2NHVrTGlEcmk2Z3NJT3lYck91ZnJDRHJyTGpzbnFYc25ZUWc3WldZNjRLWTdKMllJT3E0amV5Z2xlMllsU0Ryckxqc25xWHNuTHpyb1p3ZzdaV3A3TE9RSU91TmxDRHFzSVRxc3JEdGxiVHNwNFRyaTZUcnFiUWc3S1NFSU95SW1PdWx2Q0RzcElUc25iVHJpcFFnNnJLRDdKMkFJTzJabU95WWdTNG5MQW9nSUNjNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1NEcnNvVHRpcnc2SU9xeXNPcXp2Q0R0aHJYcnM3VHJpcFFnVysyWmxleWR1RjBzSU95WWlDL3NsWVRyaTRqc21LUWc3WXlRNjR1bzdKMkFJRnZzbFlUcmk0anNtS1JkTDF2cmhLUmRMQ0RyajVuc25wRWc3SnlnNjQrRTY0cVVJRnZzdDZqc2hveGRMMXQ3NjQrWjdKNlJmVjB1SUNMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ0RzazdEcXM2QWdJdXVMcStxNHNNSzM2NCtaN0o2Ukl1eXltT3VmdkNEc3A1MGc3SldJSU91bm51dUtsQ0Rzb2JEdGxhbkN0K3VMcU91UGhTQWk3TGVvN0lhTUl1dUtsQ0RxdUlqc3A0QXVKeXdLSUNBbk9TNGc3SjIwNjZhRXdyZnNvSVR0bVpUcnNvanRtTGpDdCt1bmlPeUtwTzJDdWV5ZGdDRHF0N2pyaklEcm9ad2c2N08wN0tHMExpRHNncXpybm96c25ZUWc2N2FBNjZXOElPdVZrQ0RyaTVqc25ZUWc2N2FaN0plczY0K0VJT3lpaSt1THBDNG5MQW9nSUNjeE1DNGc3S0NjN1pLSUlPeWFxZXlXdENEc25LRHNwNEE2SU95ZWhldWdwZXlYa0NEc2s3RHNuYmdnNnJpdzY0cWw3SVN4SU91cWhleUNyQ2pyczREcXNyMHNJT3luZ095Z2xTd2c2NU94NjZHZExDRHRsYlRzb0p3ZzY1T3hLZXVLbENEdG1aVHJxYlRzblpnZzZyaXc2NHFsNjZxRndyZnJzb1R0aXJ6cnFvWHNuYndnNnJDQTY0cWw3SVN4N0oyMElPdUdrdXljdk91dmdPdWhuQ0RzaWF6c21yUWc2NmVRNjZHY0lPdXdsT3ErdU95bmdDRHNsWXJyaXBUcmk2UXVJT3lMbk95S3BPMkZuQ0RyajVuc25wSHFzN3dnNjR1azY2VzRJT3VQbWV5Q3JPdWx2Q0RzZzRqcm9ad2c2NmVNNjVPazdLZUFJT3lWaXV1S2xPdUxwQzRuTEFwZExtcHZhVzRvSjF4dUp5azdDZ3BqYjI1emRDQkZXRUZOVUV4RlV5QTlJR3h2WVdSRmVHRnRjR3hsY3lncE93b0tMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBb3ZMeUJUVkZsTVJWOVNWVXhGVXlBeE1PeWtoQ0RzbXBUc2xiM3JwNHpzbkx6cm9aenJpcFFnN0ppSTdKbTRJREYrTXlqc2lKanJqNW50bUpYQ3QrcXl2ZXlXdE1LMzY3YUE3S0NWN1ppVklPMlhpT3lhcVNEc3ZJRHNuYlRzaXFRcDdKMllJT3VKbU95Vm1leUtwT3F3Z0NEc25LRHNpNlRya0p6cmk2UXVDaTh2SU8yTWpPeWR2T3lkdENEc2w0YnNuTHpycWJRbzdJU2s3TG1ZNjdPNElPcTFyT3V5aE95Z2hDRHJrN0VwSU91NWlDRHJyTGpzbnBEc2w3UWc0b0NVSU95YWxPeVZ2ZXVuak95Y3ZPdWhuQ0RyajVuc25wRW9abUZwYkMxemIyWjBLUzRLWm5WdVkzUnBiMjRnYkc5aFpFZDFhV1JsS0NrZ2V3b2dJSFJ5ZVNCN0NpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuZFhndGQzSnBkR2x1Wnk1dFpDY3BMQ0FuZFhSbU9DY3BMblJ5YVcwb0tUc0tJQ0FnSUhKbGRIVnliaUJ0WkM1c1pXNW5kR2dnUGlBeE1EQWdQeUJ0WkNBNklDY25Pd29nSUgwZ1kyRjBZMmdnS0dVcElIc0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3Vobk91VG5DRHNpNlR0aktnZ0tPeWFsT3lWdmV1bmpPeWN2T3VobkNEc3A0VHRsb2twT2ljc0lHVXViV1Z6YzJGblpTazdDaUFnSUNCeVpYUjFjbTRnSnljN0NpQWdmUXA5Q21OdmJuTjBJRWRWU1VSRklEMGdiRzloWkVkMWFXUmxLQ2s3Q2dwbWRXNWpkR2x2YmlCcGJuTjBjblZqZEdsdmJrMWxjM05oWjJVb0tTQjdDaUFnWTI5dWMzUWdabVYzVTJodmRDQTlJRVZZUVUxUVRFVlRMbTFoY0Nnb1pYZ3BJRDArSUNkSmJuQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExtbHVjSFYwS1NBcklDZGNiazkxZEhCMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG5OMVoyZGxjM1JwYjI1ektTa3VhbTlwYmlnblhHNG5LVHNLSUNCeVpYUjFjbTRnS0FvZ0lDQWdKK3luZ09xNGlPdTJnTzJFc0NEcmhJanJpcFFnN0plUTdJcWs3SnVRS0ZNdE1Td2c2N08wN0pXSTdacU03SUtzS2V5ZG1DRHRsWnpxdGEzc2xyUWdWVmdnVjNKcGRHbHVaeURzb0lUcnJManFzSURyb1p3ZzdKMjg3WldjNjR1a0xpQW5JQ3NLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBbjdKcVU3TEt0NjVPazdKMkFJT3lFbk91aG5DRHJyTFRxdElEdGxad2c2N09FNnJDY0lPdXN1T3Exck91THBDRGlnSlFnN0oyMDdLQ0VJT3VzdU9xMXJPdWx2Q0Rzc0xqc29iRHRsWmpzcDRBZzY2ZUk2NTI4TGx4dUp5QXJDaUFnSUNBbjdKdVE2NTZZSU95ZG1PdXZ1T3laZ0NEcnFxanJrNkFnN0tDVjY3TzBLT3lkdE91bWhNSzM3SWlyN0o2UXdyZnNvYkRxc2JUQ3QrdU1nT3lEZ1NucnBid2c3SnlnN0tlQTdaV1k2ck9nTENEcXNJRWc3S0NjN0pXSTdKMkFJT3lia091enVPcXp2T3VQaENEc2hKenJvWnpzbVlEcmo0UWc2NHVzNjUyODdKVzhJTzJWbk91THBDNGdKeUFyQ2lBZ0lDQW43S0d3NnJHMElPMlJuTzJZaENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzB3cmZzdElqcXM3ekN0K3V2dU91bmpNSzM2N2FBN1lTd3dyZnF1WXpzcDRBZzY1T3hLZXlkZ0NEc29KWHNzWVVnN0tDVjY3TzA2NHVrSU9LQWxDRHJ1Ynpxc2JEcmdwZ2c2NHVrNjZXNElPeWhzT3F4dE95Y3ZPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhLQ0kxN1pxTUlPeWR0T3lEZ1NMc25ZUWdJalh0bW93aTY2R2NJT3lraE95ZHRPdXB0Q0RzbUtUcmk3VXBMaUFuSUNzS0lDQWdJQ2ZzbTVEcnJManNsNUFnN0plRzY0cVVJT3Exck95eXRDRHNvSlhyczdRbzdLQ0U3Wm1VNjdLSTdaaTR3cmRWVWt6Q3QrcTRpT3lWb2NLMzdJdWM2ckNFSU91VHNTbnNtWUFnN1pXMDZyS3dJT3V3cWV1eWxjSzM3S0NJN0xDb0tPeWVyT3lFcE95Z2xjSzM2Nnk0N0oyWTdMS1l3cmZzbnF6c2k1enJqNFFnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjdhWjdKMjA2NHFVSU9xeWcreWRnQ0Rzb0lqcmpJQWc2cmlJN0tlQUlPS0FsQ0RzbFlUcmlwUWc2ckNTN0oyMDY1Mjg2NCtFTENEcXQ3anJuN1RyazYvdGxiVHJqNFFnN0pPdzdLZUFJT3VuaU91ZHZDNWNiaWNnS3dvZ0lDQWdKelBxc0p3ZzdLQ2M3SldJN0oyQUlPeUVuT3VobkNEc29KSHF0N3pzbmJRZzY0dXM2NTI4N0pXOElPMlZuT3VMcENEaWdKUWc3WldZNjRLWTY0cVVJT3lia091c3VDRHF0YXpzb2JEcnBid2c3SnlnN0tlQTdaV2NJT3kxbk95R2pDRHJpNlRyazZ6cXVMQXNJTzJWbU91Q21PdUtsQ0Ryckxqc25xVWc2cldzN0tHdzY2VzhJT3llck9xMXJPeUVzZTJWbkNEcmpJRHNsWWdzSUNjZ0t3b2dJQ0FnSitxM3VPdW1yT3F6b0NEc29JSHNsclRyajRRZzdaV1k2NEtZNjRxVUlPcXp2T3F3a08yVm5DRHNucXpxdGF6c2hMRTZJT3lra2V1enRTRHRrWnp0bUlUc25ZUWc2NDJjN0phMDY0SzA2ck9nTENEc29KWHJzN1FnN0lpYzdJU2M2Nlc4SU95Q3JPeWFxZXlla09xd2dDRHNsWXpzbFlUc2xid2c3WldnSU9xeWcrdTJnTzJFc091aG5DRHNucXpzb2JEc3A0SHRsYUFnNnJLRExpQW5JQ3NLSUNBZ0lDZnNtNURyckxqc25iUWc3WlcwNnJLd0lPdXdxZXV5bGV5ZGhDRHJpN1RxczZBZzdKNkk3SjJFSU91VmpPdW5qQ0FpN0phMDY1YTc2cktNSU8yVm1PdXB0Q0RyaTZUc2k1d2c2NUNjNjR1a0l1dWx2Q0RzbFo3c2hManNtckRyaXBRZzZyaU43S0NWN1ppVklPeWVyT3Exck95RXNleWRoQ0R0bFpqcm5id2c0b0NVSU95YmtPdXN1T3lYa0NEdGxiVHFzckRzc1lYc25iUWc3SmVHN0p5ODY2bTBJT3Vuak91VHBPeVd0Q0RydHBuc25iVHNwNEFnNjZlSTY1MjhMaUFuSUNzS0lDQWdJQ2Z0a1p6cXVMREN0K3lhcWV5V3RPdW5qQ0RxczZEc3VaanFzNkFnN0phMDdJaWM3SjJFSU91d2xPcSt2Q0Rzb0pYcmo0VHNuWmdnN0tDYzdKV0k3SjJFSURQcXNKd2c2NHFZN0phMDY0YVQ3S2VBSU91bmlPdWR2Q0RpZ0pRZzZyZTQ2ckcwSU95Q3JPeWFxZXlla095WGtPcXlqQ0RzdHBUc3NwenNuYlFnN0pXRTY0dUk2NTI4SU9xMWtPeWdsZXljdk91aG5DRHJzN1RzbmJqcmk2UXVJQ2NnS3dvZ0lDQWdKK3lWaE91ZW1DRHNtSWpzaTV6cms2VHNuWUFnN1pXY0lPeWtoT3lubk91bXJDRHN0WnpzaG93ZzZyV1E3S0NWN0oyMElPdW5qdXluZ091bmpDRHF0N2pxc2JRZzdZYWtLTzJWdE95YWxPeXl0TUszNnJLOTdKYTBLZXlkbUNEcXRaRHJzN2pzbmJUc3A0QWc3SWFNNnJlNTdJU3g3SjJZSU9xMWtPdXp1T3lkdENEc2xZVHJpNGpyaTZRZzRvQ1VJT3lYck91ZnJDRHJyTGpzbnFYc3A1enJwcXdnN0o2RjY2Q2w3SjJBSU91cGxPeUxuT3luZ0NEcmk2anNuSVRyb1p3ZzY0dWs3SXVjSU95RXBPcXpoTzJWbU91ZHZDNWNiaWNnS3dvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcnNMRHNsN1RycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaGNLMzdMMlU2NU9jN1k2YzdJcWtJT3E0aU95bmdEcGNiaWNnS3dvZ0lDQWdKMXQ3SW5SbGVIUWlPaUFpN0tDYzdKV0lJT3VzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV1c3RPeVhoK3lkaENEc21ad2c2N0NVNnIrbzY0cVU3S2VBSU8yVm5PcTFyZXlXdENEdGxad2c2Nnk0N0o2bEluMHNJQzR1TGwxY2JseHVKeUFyQ2lBZ0lDQW5XK3lLcE8yRGdPeWR2Q0RxdDV6c3VabGRYRzRuSUNzZ1UxUlpURVZmVWxWTVJWTWdLeUFuWEc1Y2JpY2dLd29nSUNBZ0tFZFZTVVJGSUQ4Z0oxdnNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2NJT3lnaE91c3VDQW9kWGd0ZDNKcGRHbHVaeTV0WkNrZzRvQ1VJT3ljaENEcXQ1enN1Wm5zblpnZzZyZTg2ckd3N0ptQUlPeVlpT3ladUNEc2k1enJncGpycHF6c21LUXVJTzJLdWUyZWlDRHNtSWpzbWJnZzZyZWM3TG1aS095SW1PdVBtZTJZbGNLMzZySzk3SmEwd3JmcnRvRHNvSlh0bUpYc25ZUWc3SnlnN0tlQTdaVzA3Slc4SU8yVm1PdUtsQ0RzZzRIdG1ha3A3SjJFSU9xM3VPdU1nT3VobkNEcmxMRHJwYlRxczZBc0lPeWFsT3lWdmVxenZDRHNvSVRyckxqc25iUWc2NHVrNjZXMDY2bTBJT3lnaE91c3VPeWRoQ0RybExEcnBianJpNlJkWEc0bklDc2dSMVZKUkVVZ0t5QW5YRzVjYmljZ09pQW5KeWtnS3dvZ0lDQWdLR1psZDFOb2IzUWdQeUFuVyt5YXNPdW1yQ0RycXFuc2hvenJwcXdnN0ppSTdJdWNJT0tBbENEc25iUWc3WWFrN0oyRUlPdVVzT3VsdkNEcXNvTmRYRzRuSUNzZ1ptVjNVMmh2ZENBcklDZGNibHh1SnlBNklDY25LU0FyQ2lBZ0lDQW43S1NBNjdtRTY1Q1E3Snk4NjZtMElDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljS0lDQXBPd3A5Q2dvdkx5RGlsSURpbElBZzdJT0I3SXVjSU91TWdPcTRzQ0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnQXBzWlhRZ2NISnZZeUE5SUc1MWJHdzdJQ0FnSUNBZ0lDQWdJQzh2SU8yQnRPdWhuT3VUbkNEdGxJVHJvWnpzaExqc2lxUUtiR1YwSUd4cGJtVkNkV1lnUFNBbkp6c2dJQ0FnSUNBZ0lDQXZMeUJ6ZEdSdmRYUWc3S1NFSU91eWhPMk52QXBzWlhRZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQzh2SU8yWWhPeWVyQ0R0aExUc25aZ2dleUJ5WlhOdmJIWmxMQ0J5WldwbFkzUXNJSFJwYldWeUlIMEtiR1YwSUhGMVpYVmxJRDBnVUhKdmJXbHpaUzV5WlhOdmJIWmxLQ2s3SUM4dklPeWFsT3l5clNEc3A0SHJvS3p0bVpRZ0tPdVBtZXlMbkNEc21wVHNzcTNzbllBZzdJaWM3SVNjNjR5QTY2R2NLUXBzWlhRZ2RIVnlibk1nUFNBd093cHNaWFFnZDJGeWJXVmtWWEFnUFNCbVlXeHpaVHNLYkdWMElHTjFjbkpsYm5STmIyUmxiQ0E5SUVOTVFWVkVSVjlOVDBSRlREc2dMeThnN0tlQTZyaUlJT3lFdU95Rm1PeWR0Q0Ryckx6cXM2QWc3SjZJNjRxVUlPdXFxT3VOdUNBbzdKcVU3TEt0N0oyMElPdUxwT3VsdUNEcnFxanJqYmpzbllRZzdLZUE3S0NWN1pXWTY2bTBJT3lFdU95Rm1DRHNucXpzaTV6c25wRXBDaTh2SU95TG5PeWVrU0RzaTV3Z1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbElFTk1TU25xc0lBZzdKTzRJT3lJbUNEc25vanJpcFRzcDRBZzdLQ1E2cktBSU9LQWxDRHNsNGJzbkx6cnFiUWdMMmhsWVd4MGFPdWhuQ0RzbFl6cm9LUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeVZpT3VDdE8yVm5PdUxwQzRLTHk4Z2JuVnNiRDN0bVpYc25iZ2c3S1NSTENBbmIyc25QZXlDck95YXFTRHFzSURyaXFVc0lDZGpiR0YxWkdVdGJXbHpjMmx1WnljOVkyeGhkV1JsSU91cWhldWd1U0RzbDRic25Zd3NDaTh2SUNkamJHRjFaR1V0Ykc5bmIzVjBKejFqYkdGMVpHWHJpcFFnN0o2STdLZUE2NmVNSU91aG5PcTN1T3lkdUNEc2hManNoWmdnNjZlTTY2T01JQ2p0aExRZzdJdWs3WXlvSU95TG5DRHFzSkRzcDRBc0lPeUVzZXF6dFNEdGhMVHNuYlFnN0ppazY2bTBJT3lla091UG1TRHRsYlRzb0p3cENpOHZJQ2RqYkdGMVpHVXRiR2x0YVhRblBldWhuT3EzdU95ZHVPeWRnQ0Rya0pEc3A0RHJwNHdnN0lLczdKcXBJTzJWbk91UGhDRHN0SWpxczd3Z0tPeWhzT3k1bU9xd2dDRHNucXpyb1p6cXQ3anNuYmpzbmJRZzdKV0U2NHVJNjUyOElPMlZuT3VQaENEc25ianNnNEhDdCtxemhPeWdsU0Rzb0lUdG1aZ3BDbXhsZENCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c093b3ZMeURyb1p6cXQ3anNuYmdnNjZlTTY2T01JT3F3a095bmdDRGlnSlFnUTB4SjZyQ0FJT3VDdE91S2xDRHNtSUhzbHJRZzdKMjQ3S2FkSU95WXBPdWxtT3VsdkNEc2dxenJub3pzbmJRZzdKV003SldFNjVPazdKMkVJT3lWaU91Q3RPdWhuQ0Ryc0pUcXZyenJpNlF1Q2k4dklDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dTdKMkFJT3Vobk9xM3VPeWR1Q0RzbDRic25iVHJqNFFnN0lTeDZyTzE3WlcwN0lTY0lPeUxuT3VQbVNEc29KRHFzb0Rzbkx6cm9aenJpcFFnNjZxN0lPeWVvZXF6b0N3ZzdJdWs3S0NjSU8yRXRPeVhrT3lFbk91bmpDRHJrNXpybjZ6cmdwenJpNlFwQ2k4dklDTHJwNHpybzR3aTY2ZU03SjIwSU95VmhPdUxpT3VkdkNBaTdaV2NJT3V5aU91UGhDRHJvWnpxdDdqc25iZ2c3SldJSU8yVnFDTHJqNFFnNnJDWjdKMkFJT3F5dmV1aG5PdWhuQ0RzbnFIdG5vanJyNERyb1p3ZzdLU1I2NmE5SU8yUm5PMlloT3lkaENEc2s3VHJpNlFLWTI5dWMzUWdURTlIU1U1ZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVPeWR0Q0R0bFlUc21wVHRsYlRzbXBRbzdKV0lJT3VRa09xeHNPdUNtQ0RycDR6cm80d3BJT0tBbENCYjhKK2ZvQ0R0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0SU8yVmhPeWFsRjBnNjdLRTdZcTg3SjJFSU91SWhPdWx0T3VwdENEcm9aenF0N2pzbmJnZzdMQzk3SjJFSU95WHRPeVd0T3VUbk91Z3BPeWFsQzRuT3dvdkx5RHNpNlRzdUtIdGxad2c2Nnk0NnJXczY1T2tPaUFpUm1GcGJHVmtJSFJ2SUdGMWRHaGxiblJwWTJGMFpUb2dUMEYxZEdnZ2MyVnpjMmx2YmlCbGVIQnBjbVZrSUdGdVpDQmpiM1ZzWkNCdWIzUWdZbVVnY21WbWNtVnphR1ZrSWlqcnA0enJvNHdwTEFvdkx5QWlUbTkwSUd4dloyZGxaQ0JwYmlEQ3R5QlFiR1ZoYzJVZ2NuVnVJQzlzYjJkcGJpSW82Nis0NjZHYzZyZTQ3SjI0S1NEaWdKUWc2NUdZSU91THBDRHNucUh0bm9qcXNvd2c2NFNUN1o2TTY0dWtDbVoxYm1OMGFXOXVJR2x6UVhWMGFFVnljbTl5S0hNcElIc0tJQ0J5WlhSMWNtNGdMMkYxZEdobGJuUnBZMkYwZkc5aGRYUm9mR0Z3YVNCclpYbDhiRzluSUQ5cGJueHNiMmRuWldSOGMyVnpjMmx2YmlCbGVIQnBjbVZrTDJrdWRHVnpkQ2hUZEhKcGJtY29jeWtwT3dwOUNpOHZJT3lDck95YXFTRHRsWnpyajRRZzdMU0k2ck84SU9xd2tPeW5nQ0RpZ0pRZzY2R2M2cmU0N0oyNDdKMkFJT3VwZ095cG9lMlZuT3VOc0NBaTY0MlVJT3VxdXlEc2s3VHJpNlFpNjRxVUlPcXl2ZXlhc0M0ZzY2R2M2cmU0N0oyNElPdW5qT3Vqak95WmdDRHNvYkRzdVpqcXNJQWc2NHVzNjUyODdJU2NJT3VVc091aG5DRHNucUhyaXBUcmk2UXVDaTh2SU95THBPeTRvU2d5TURJMkxUQTRMQ0R0bW96c2dxd2c3SmVVN1lTdzdaU0U2NTI4N0oyMDdLYUlJT3lpak95RW5TazZJQ0paYjNVbmRtVWdhR2wwSUhsdmRYSWdhVzVrYVhacFpIVmhiQ0J6Y0dWdVpDQnNhVzFwZENEQ3R5QnlkVzRnTDNWellXZGxMV055WldScGRITUtMeThnZEc4Z1lYTnJJSGx2ZFhJZ1lXUnRhVzRnWm05eUlHRWdhR2xuYUdWeUlHeHBiV2wwSWlEaWdKUWc2clNBNjZhczdKNlE2ckNBSU95Q3JPdWVqT3V6aE91aG5DRHFzYmpzbHJRZzY1R1VJT3lEZ2UyVm5PeWR0T3VkdkNEdGxJenJucHdnN0lLczdKcXA2NStKN0oyMElPdUNxT3lWaE91UGhDRHFzYmpycHJEcmk2UXVDaTh2SU95ZHRDRHN2SURzbmJUc2lxVHFzSUFnN0plRzY0MllJTzJEayt5WGtDRHNtSUhzbHJRZzdKdVE2Nnk0N0oyMElPcTN1T3VNZ091aG5DRHRocURzaXFUdGlyanJqN3dnSXV5Wm5DRHNsWWdnNjVDWTY0cVU3S2VBSWlEc2xZd2c3SWlZSU95WGh1eVhpT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6c25wRHNsNURxc293ZzdaV2M2NCtFNjZXOElPeVlyT3VncENEcmk2enJuYnpxczZBZzdKcVU3TEt0N1pXWTZyT2dMQ0RzbFlUcmk0anJxYlFnVy9DZm42QWc3WUcwNjZHYzY1T2NJTzJWbk91UGhDRHN0SWpxczd4ZElPdXloTzJLdk95ZGhDRHJpSXpybjZ3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsYlFnN0tPODdJUzQ3SnFVTGljN0NpOHZJQ2Z0bFp6cmo0UW42NkdjSU91dGlldWFzZXEzdU91bXJPdXB0Q0RzbFlnZzY1Q2M2NHVrSU9LQWxDRHNucURxdVpBZzY2cXc2NmEwSU91VmpDRHJncGpyaXBRZ2NtRjBaU0JzYVcxcGRPeWR0T3VDbUNEcnJManJwNlVnNnJpNDdKMjBJT3kwaU9xenZPcTVqT3luZ0NEc25xSHNsWVFLTHk4ZzdKZUo2NXF4N1pXWTZyS01JQ0xyaTZUcnBiZ2c2ck9FN0tDVjdKeTg2NkdjSU91aG5PcTN1T3lkdU8yVm1PdWR2Q0xxczZBZzdKV0k2NEswN1pXWTZyS01JT3VRbk91THBDNGc3S2VBN0xhY3dyZnNncXpzbXFucm40a2c3SU9CN1pXY0lPdXN1T3Exck91bmpDRHNvb0h0bUlEc2hKd2c2N080NjR1a0NtWjFibU4wYVc5dUlHbHpUR2x0YVhSRmNuSnZjaWh6S1NCN0NpQWdjbVYwZFhKdUlDOXpjR1Z1WkNCc2FXMXBkSHgxYzJGblpTMWpjbVZrYVhSemZIVnpZV2RsSUd4cGJXbDBJQ2h5WldGamFHVmtmR1Y0WTJWbFpHVmtLUzlwTG5SbGMzUW9VM1J5YVc1bktITXBLVHNLZlFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56NjZXOElPeWR2ZXlXdEFvdkx5QXZhR1ZoYkhSbzY2R2NJT3VGdU95Mm5PMlZuT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSUNMcmlJVHF0YXdnNnJPRTdLQ1Y3Snk4NjZHY0lPeVRzT3VLbENEc3BKSHNuYmpzcDRBaUlPMlJuT3lMbkNEaWdKUWc2ck8xN0pxcElGQkQ3SmVRN0lTY0lPdUNxT3lkbUNEcXM0VHNvSlVnN0ppazdJS3M3SnFwSU91d3FleW5nQ2t1Q2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENqdGxJVHJvWnpzb0ozdGlyZ2c3SjIwNjZDbElPMlByTzJWcUNrZ016RHN0SWdnN0xxUTdJdWNMaURzbnF6cm9aenF0N2pzbmJqdGxaanJxYlFnUTB4SjZyQ0FJTzJNak95ZHZPeWRoQ0Rxc0xIc2k2RHRsWmpycjREcm9ad2c3SjZRNjQrWklPdXdtT3lZZ2V1UW5PdUxwQzRLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdDaTh2SU95bmdPcTRpQ0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaU0RzaExqc2haanNuYlFnN0phMDY0cVFJT3F6aE95Z2xleWN2T3VobkNEc2k1enJqNW5ya0pEcmlwVHNwNEFnS0hOMFlYSjBVSEp2WSt5WGtPeUVuQ0RxdUxEcm9aMHBMZ292THlEc2hManNoWmpzbllBZzdJdWM2NCtaN1pXZ0lPdVZqQ0Ryc0p2c25ZQWc3SjZGN0o2bDZyYU03SjJFSU9xemhPeUdqU0RzazdEcnI0RHJvWndzSU91d2x1eVhrT3lFbkNEcXM0VHNvSlhzbllRZzY3Q1U2cjY0NjZtMElPeWR0Q0Rxc0pMcXM3d2c3WXlNN0oyODdKMllJT3F6aE95Z2xleWR0Q0RzbHJUcXVJdnJncHpyaTZRS2JHVjBJSE5sYzNOcGIyNUJZMk52ZFc1MElEMGdiblZzYkRzS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzS0lDQnBaaUFvUkdGMFpTNXViM2NvS1NBdElHRmpZMjkxYm5SRFlXTm9aUzVoZENBOElETXdNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3dvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTNXFjMjl1Snlrc0lDZDFkR1k0SnlrcE93b2dJQ0FnWlcxaGFXd2dQU0FvYWlBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZENBbUppQnFMbTloZFhSb1FXTmpiM1Z1ZEM1bGJXRnBiRUZrWkhKbGMzTXBJSHg4SUc1MWJHdzdDaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nNjZHYzZyZTQ3SjI0SU95ZHRPdWdwU0RzbDRic25Zd2c2NU94SU9LQWxDQnVkV3hzSU95Y29PeW5nQ0FxTHlCOUNpQWdZV05qYjNWdWRFTmhZMmhsSUQwZ2V5QmhkRG9nUkdGMFpTNXViM2NvS1N3Z1pXMWhhV3dnZlRzS0lDQnlaWFIxY200Z1pXMWhhV3c3Q24wS1puVnVZM1JwYjI0Z1kyaGxZMnREYkdGMVpHVkJkbUZwYkdGaWJHVW9LU0I3Q2lBZ1kyOXVjM1FnY0hKdlltVWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0TFhabGNuTnBiMjRuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdJSDBwT3dvZ0lHeGxkQ0J2ZFhRZ1BTQW5KenNLSUNCd2NtOWlaUzV6ZEdSdmRYUXViMjRvSjJSaGRHRW5MQ0FvWkNrZ1BUNGdleUJ2ZFhRZ0t6MGdaQzUwYjFOMGNtbHVaeWdwT3lCOUtUc0tJQ0J3Y205aVpTNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljN0lIMHBPd29nSUhCeWIySmxMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW9ZMjlrWlNBOVBUMGdNQ0FtSmlBdlhHUXJYQzVjWkNzdkxuUmxjM1FvYjNWMEtTa2dQeUFuYjJzbklEb2dKMk5zWVhWa1pTMXRhWE56YVc1bkp6c0tJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTQkRiR0YxWkdVZ1EyOWtaU0Rzb0pEcXNvQTZJQ2NnS3lCamJHRjFaR1ZUZEdGMGRYTWdLeUFvYjNWMElEOGdKeUFvSnlBcklHOTFkQzUwY21sdEtDa2dLeUFuS1NjZ09pQW5KeWtwT3dvZ0lIMHBPd3A5Q2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQXBqYjI1emRDQnpkR0YwY3lBOUlIc2djMlZ5ZG1Wa09pQXdMQ0JzWVhOMFFYUTZJQ2NuTENCc1lYTjBWR1Y0ZERvZ0p5Y3NJR3hoYzNSVFpXTTZJQ2NuSUgwN0Nnb3ZMeURpbElEaWxJQWc3WlNNNjUrczZyZTQ3SjI0SU95RG5leWh0Q0Rxc0pEc3A0QW83SXVzN0o2bDY3Q1Y2NCtaS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFLTHk4ZzdaU002NStzNnJlNDdKMjQ3SjIwSU91V29DRHNub2pyaXBRZzY0K1o3SldJSUdOdlpHVXVkSFBxc0lBZ05leTBpT3VuaU91THBDQlFUMU5VSUM5b1pXRnlkR0psWVhUcnBid2c2N08wNjRLNDY0dWtMZ292THlEdGxad2c2N0tJN0oyMDY1Mjg2NCtFSU91d20reWRnQ0Rya3FRZ016RHN0SWpxc0lRZzY0R0s2cml3NjZtMElPMlVqT3Vmck9xM3VPeWR1Q2pybUpEcmlwUWc3WlM4NnJlNDY2ZUlLZXlkdENEcmk2dnRub3dnNnJLRElPS0FsQ0R0Z2JUcm9aenJrNXpxdVl6c3A0QWc2NDJ3NjZhczZyT2dJT3F3bWV5ZHRDRHF1cnpzcDRUcmk2UXVDaTh2SU95VmhPeW5nU0R0bFp3ZzY3S0k2NCtFSU91cXV5RHJzSnZzbFpqc25MenJxYlFvNjR1azY2YXM2NmVNSU91b3ZPeWdnQ0RzdktBZzdJT0I3WU9jTENEc25wRHJqNW5zaTV6c25wRWc2NU94S1NEcXM0VHNobzBnNjR5QTZyaXc3WldjNjR1a0xncGpiMjV6ZENCSVJVRlNWRUpGUVZSZlJFVkJSRjlOVXlBOUlETXdNREF3T3dwc1pYUWdiR0Z6ZEVKbFlYUWdQU0F3T3dwelpYUkpiblJsY25aaGJDZ29LU0E5UGlCN0NpQWdhV1lnS0d4aGMzUkNaV0YwSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JzWVhOMFFtVmhkQ0ErSUVoRlFWSlVRa1ZCVkY5RVJVRkVYMDFUS1NCN0NpQWdJQ0F2THlBcUt1dWhuT3EzdU95ZHVDRHNwSkhzbmJUcnFiUWc3SldJSU9xNnZPeW5oT3VMcENvcUlDZ3lNREkyTFRBNExDQkNVa2xFUjBWZlZqMHpOeWs2SUdWNGFYUWc3Wlc0NjVPazY1K3M2ckNBSUd0cGJHeE1iMmRwYmxCeWIyUHF1WXpzcDRBZzY3YUE2NlcwNjYrQTY2R2NDaUFnSUNBdkx5RHNsNnpxdUxEc2hKd2c2cnE4N0tlQTY2bTBJT3U0ak91ZHZPeWFzT3lnZ095WGtPeUVuQ0Ryb1p6cXQ3anNuYmp0bFpqcmpaZ2c3SUtzNjU2TTdKMllJT3k5bk91d3NTRHRqNnp0aXJqcXNJQWc2NHVyN1ppQUlDSnNiMk5oYkdodmMzVHNsNURzaEp3ZzdKZXc2ckt3N0oyRUlPcXhzT3UyZ08yV2lPeUt0ZXVMaU91THBDTHFzSUFLSUNBZ0lDOHZJT3VjcU9xeHNPdUNtQ3dnNjZHYzZyZTQ3SjI0SU95d3ZleWR0Q0RzaG96cnBxd2c3SmVHN0oyMElPdXN0TzJhcU9xd2dDRHJrSnpyaTZRbzdJdWs3TGloSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmpzbllRZzY0dXI3SldFSU91UmxDRHNzWVFnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3VucE91eWlDRHNuYlRybnF6cmk2UXBMZ29nSUNBZ0x5OGc2NkdjNnJlNDdKMjQ3SjJBSU91NGpPdWR2T3lhc095Z2dPeVhrT3lFbkNEc2dxenJub3pzbmJRZzdLZUU3WmFKN1pXWTY0cVVJT3lkdk95ZHRPdWR2Q0R0bEl6cm42enF0N2pzbmJqc25iUWc2NWFnSU95ZWlPeWRoQ0R0bFlUc21wVHFzSUFnN0plRzY0dWtMaURyckxUdGxad2c2NHlBNnJpd0lPeWNoTzJYbU95ZGdBb2dJQ0FnTHk4Z2JHOW5hVzVRY205alZHbHRaWElvTXpEcnRvUXA2ckNBSU91bmlldUtsT3VMcENEaWdKUWc2cmU0SU8yRGdPeWR0T3VvdU9xd2dDRHJvWnpxdDdqc25ianNuWVFnN0tDVjY2YXM3WldZNjZtMElPdUxwT3lkakNEc29KRHFzb0RzbDVEc2hKd2c3S0NWN0lPQjdLQ0I3Snk4NjZHY0lPcTZ2T3luaE91THBDNEtJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTXBJSHNLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95THJPeWVwZXV3bGV1UG1leWRnQ0RyZ1lycXNyenNwNERycDR3ZzY2R2M2cmU0N0oyNDdKMjBJT3luaE8yV2lTRHNwSkhzbmJUcm5id2c2cml3NjR1azY2YTk2NHVJNjR1a0lDanJvWnpxdDdqc25iZ2c2NEdkNjRLWTY2bTBJT3lnbGV1bXJPdVFxZXVMaU91THBDa3VKeWs3Q2lBZ0lDQWdJSEpsZEhWeWJqc0tJQ0FnSUgwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJenJuNnpxdDdqc25iZ2c3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTVnQ0RpZ0pRZzdaUzg2cmU0NjZlSUwrMlVqT3Vmck9xM3VPeWR1T3lkdENEcmk2dnRub3dnNnJLRDdKeTg2NkdjSU91enRPcXpvQ0Rxc0puc25iUWc2cnE4N0tlUjY0dUk2NHVrTGljcE93b2dJQ0FnY0hKdlkyVnpjeTVsZUdsMEtEQXBPeUF2THlCbGVHbDBJTzJWdU91VHBPdWZyT3F3Z0NCcmFXeHNVSEp2WSt5Y3ZPdWhuQ0JqYkdGMVpHVWc3WXE0NjZhczY2VzhJT3lnbGV1bXJPMlZuT3VMcEFvZ0lIMEtmU3dnTlRBd01DazdDZ292THlEcXM0VHNvSlVnN0tDRTdabVlJT3VWakNEc2w2enJpcFFnN0p1NUlPdWhuT3EzdU95VmhPeWJneURzbzd6c2hvd2c0b0NVSU91aG5PcTN1T3lWaE95Ymd5RHRtNFFnS2lycm9aenF0N2pzbmJnZzdabVU2Nm0wN0p5ODY2R2NJT3l3cWV5bmdDb3E3WldjNjR1a0tPeUxwT3k0b1RvZ1kyeGhkV1JsTG1GcEwyeHZaMmx1S1M0S0x5OGc3SXE1N0oyNElPMlpsT3VwdE95ZG1DRHNtNURzbmJqc25ZQWc2N2lNNjUyODdKcXc3S0NBN0plUUlPdUNxT3lkZ0NEc21Kc2c2ck9FN0tDVklPeUV1T3lGbU95ZHRPdXZnT3VobkN3ZzdLQ0U3Wm1ZN0oyQUlPeWR0T3F4dUNEc3A0RHNtckRyaXBRZzZyS0Q3SmVRN0lTY0lPeUxuT3lla2UyVm5PdUxwQzRLWTI5dWMzUWdWMFZDWDB4UFIwOVZWRjlWVWt3Z1BTQW5hSFIwY0hNNkx5OWpiR0YxWkdVdVlXa3ZiRzluYjNWMEp6c0tMeThnNjZHYzZyZTQ3SldFN0p1RDdKMjBJT3U0ak91ZHZPeWFzT3lnZ095WGtPeUVuQ0Rzc3BqcnBxenJrS0FnN0l1YzZyQ0VJT0tBbENEcmhJanJyTFFnN0tlbjdKeTg2Nm0wSU95RXVPeUZtT3lkdENEcmdxanNuWUFnN0xHRUlPdWhuT3EzdU95ZHVDRHRtWlRycWJUc25iUWc3SmUwNjZDa0lPeUt1ZXlkdUNEdG1aVHJxYlRzbmJRZzY1eXM2NHVrQ21OdmJuTjBJRXhQUjA5VlZGOVRSVlJVVEVWZlRWTWdQU0F6TlRBd093b3ZMeUJWVWt6c25ZUWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VobkNEc2w3RHJpNlF1SUhkcGJqTXk3SjJBSUhKMWJtUnNiRE15SU9LQWxDQmpiV1RycGJ3ZzdKV0lJT3F4c095NW1PdXZnT3VobkNCVlVrenNuWmdnWUNaZzZyQ0FJT3llbU91bXJPeW5nQ0RzbFlycmlwVHJpNlF1Q2k4dklDaENVazlYVTBWU0lPMlptT3F5dmV1emdPeUltT3VLbENEc29JanJqSUFnN0pPdzdLZUFJT3lWaXV1S2xPdUxwQ0RpZ0pRZzdKV0U2NTZZSU95anZPeUVuZXlkbUNEc3ZaVHJrNXdnNjdhWjdKZXM2NFNqNnJpd0lPdXN1T3lnbkNrS1puVnVZM1JwYjI0Z2IzQmxibFZ5YkVsdVJHVm1ZWFZzZEVKeWIzZHpaWElvZFhKc0tTQjdDaUFnZEhKNUlIc0tJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0J6Y0dGM2JpZ25jblZ1Wkd4c016SW5MQ0JiSjNWeWJDNWtiR3dzUm1sc1pWQnliM1J2WTI5c1NHRnVaR3hsY2ljc0lIVnliRjBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtTNTFibkpsWmlncE93b2dJQ0FnWld4elpTQnpjR0YzYmlnbmIzQmxiaWNzSUZ0MWNteGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1M1MWJuSmxaaWdwT3dvZ0lDQWdjbVYwZFhKdUlIUnlkV1U3Q2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnY21WMGRYSnVJR1poYkhObE95QjlDbjBLQ2k4dklPS2FvTys0anlEcm9aenF0N2pzbmJnZzZySzk2NkdjN0plUTdJU2NJQ29xUWxKUFYxTkZVdXVsdkNEcXNiVHJrNXpycHF6cnFiUWc3SldJSU91UW5PdUxwQ29xSUNneU1ESTJMVEE0SU95THBPeTRvU0F5N1pxTTY2R2NJTzJabGV5Z2xTazZDaTh2SUNBZ1FsSlBWMU5GVXV1bHZDRHNoS1Rzb0pYdGxaanJxYlFvNjRLMDdKcXA3SjIwSU91c3RPeVhoK3lkdE91VG9Dd2c3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHRsWmpyaXBRZ2JtOHRiM0RzbmJUc2xyVHJqNFFwSUdOc1lYVmtaU0JEVEVucXNJQWc2N2lNNjUyODdKcXc3S0NBSU8yVnVPdVRuT3lZcE8yVWhPdWx2QW92THlBZ0lPMlByT3E0c08yVm1PcXpvQ0FxS2lMc25ianNwcDBnN0wyVTY1T2M2Nlc4SUVOc1lYVmtaU0JEYjJSbDdKZVFJT3UybWV5WHJPdUVvK3ljdk95RXVPeWFsQ0lnNjdDcDdJdWQ3Snk4NjZHY0lPdXdsT3VBa091THBDb3FMaURyaTZUcnBxenJpcFFnNjZHYzZyZTQ3SjI0SU8yVWhPdWhuT3lFdU95S3BPdWx2QW92THlBZ0lPeUlxT3F5cU95RW5DQnpkR1JwYmlEc2w0YnNuYlFnNjUyRTdKcXc2NitBNjZHY0lPdTJtZXlYck91RW8reWRoQ0RxczdQc25iUWc3SmVHN0phMElPdWhuT3EzdU95ZHVPeWR0Q0RzbFlUc21JZ2c2N2FJNnJDQTY0cWw3WlcwN0tlRTY0dWtMZ292THlBZ0lDaHNiMk5oYkdodmMzUWdURWxUVkVWTzdKMjBJT3VXb0NEc25vanJpcFFnNnJLRDY2ZU1JT3V6dE9xem9DRHNucERyajVrZzdJaVk2NkM1N0oyMElPeWNvT3luZ091UW5PdUxwT3F6b0NEdGpKRHJpNmp0bG9qcmpaZ2c2cktNSU95WXBPeW5oT3lkdE95WGlPdUxwQzRwQ2k4dklDQWc0b2FTSU9xM3VPdWVtT3lFbkNBaTdZT3RJREhxc0p3Z0t5RHFzNFRzb0pVZzdJU2c3WU9kSU8yWmxPdXB0Q0xzbllBZzdKMjBJRU5NU2V1aG5DRHJ0b2pxc0lEcmlxWHRsWmpyaTZRNklPMlZuQ0R0ZzYzc25MenJvWndnN0o2SDdKNlE2Nm0wSUVOTVNleWRtQ0RzbDdUcXVMRHJwYndnNjZlSjdKV0U3Slc4Q2k4dklDQWc3WldZNnJPZ0xDRHJwNG5zbkx6cnFiUWc3TDJVNjVPY0lPdTJtZXlYck91RW8rcTRzT3F3Z0NEcmtKenJpNlF1SU91aG5PcTN1T3lWaE95YmcreWRoQ0RybExEcm9ad2c3SmUwNjZtMElPMkRyZXlkdENBeTZyQ2M2ckNBSU91UW5PdUxwQzRLTHk4Z0lDRHFzckRyb2FBbzdJS3M3SnFwN0o2UUlPcXlzT3lnbFNrNklDb3E3WU90SURIcXNKd2dLeURzaXJuc25iZ2c3Wm1VNjZtMEtpcnNuWVFnN0pPdzZyT2dMQ0RxczRUc29KVWc3S0NFN1ptWTdKMkFJT3EzdUNEdG1aVHJxYlRzblpnZ1crcXpoT3lnbFNEc29JVHRtWmhkSU91eWhPMkt2T3ljdk91aG5DRHRsWnpyaTZRdUNpOHZJQ0FnN0lLdDdLQ2M2NUNjSU95TG5PdVBoT3VUcERvZ2QzSnBkR1ZPYjI5d1FuSnZkM05sY2lBdklHOXdaVzVWY214SmJrUmxabUYxYkhSQ2NtOTNjMlZ5SUM4Z1luVnBiR1JNYjJkdmRYUkRhR0ZwYmxWeWJDQW82N08xNnJXczY0cVVJR2RwZENEdG5vanNpcVR0aHFEcnBxd3BMZ292THlEaWxJRGlsSUFnNjZHYzZyZTQ3SjI0N0oyQUlFTk1TZXF3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2VzhJT3luZ2V5Z2tTRHNsN1Rxc293ZzdaV2M2NHVrSUNneU1ESTJMVEE0TENCQ1VrbEVSMFZmVmowek1Da2c0cFNBNHBTQUNpOHZJT3lhc091bXJPcXdnQ0JDVWs5WFUwVlM2Nlc4SU9xd2dPdWhuT3l4aE9xeHNPdUNtQ0Rzc0wzc25ZUWc2ck9vNjUyOElPeVhyT3VLbENEc2k1enJqNFRyaXBRZ0tpcnNvSVRydG9BZzdJdWs3WXlvN1pXMDdJU2NJT3VRbU91UGpPdWd1T3VMcENvcUxpRHJncWpxdUxRZzZyV1E3WnVJT2dvdkx5QWdJT0tSb0NCQ1VrOVhVMFZTSU8yVnVPdVRwT3Vmck91aG5DQlZVa3pzbllRZzY3Q2I3Snk4NjZtMElHTnRaT3F3Z0NCZ0ptRHNsNURzaEp3ZzdKNlk2NTI4NjZpNTY0cVU2NHVrSU9LR2tpQmpiR2xsYm5SZmFXUWc3SWFNN0l1a0tDTHNucGpycXJ2cmtKd2dUMEYxZEdnZzdKcVU3TEt0SWlrdUNpOHZJQ0FnNHBHaElFSlNUMWRUUlZMcnBid2dibTh0YjNEc25MenJvWndnNjZlSjZyT2dJSE4wWkc5MWRPeWRtQ0JWVWt6c25ZUWc3SnF3NjZhczZyQ0FJT3lYdE91cHRDQXFLdXlLdWV5ZHVDRHJrcVFnN0oyNDdLYWQ3TDJVNjVPYzY2VzhJT3UybWV5WHJPdUVvK3ljdk91ZHZPdUtsQ0R0bVpUcnFiUXFLdXlkdEFvdkx5QWdJQ0FnSU91Y3JPdUxwQ2pzaTZUc3VLRWc3SXVnNnJPZ09pQWk3SjIwNjUrd0lPcXhzQ0RzbDRic2w0anJpcFRyamJBZzZyQ1I3SjZRNnJpd0lPeVpuQ0RzZzUzcXNxZ2lLU0RpZ0pRZzdKNlE2NCtaSU95SW1PdWd1ZXlkdENEcXVhanNwNFRyaTZRdUNpOHZJQ0FnNHBHaUlPeUxuTzJCck91bXZ5RHNzTDNzbkx6cm9ad2c3SmUwNjZDazY2bTBJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNtckRycHF6cXNJQWc2ck9vNjUyODdKVzhJTzJWdE95RW5DQXFLdXE0c091enVDRHJ1SXpybmJ6c21yRHNvSURxc0lBZzdKV0U2NHVNSU8yQnJPdWhyTUszN0plajdLZUE2ckNBSU95WHRPdW1zT3VMcENvcUNpOHZJQ0FnSUNBZ0tPeUxwT3k0b1NEc2k2RHFzNkE2SUNMc21ad2c3WUdzNjZHczdKeTg2NkdjSU95WHRPdWdwQ0lzSUNMcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTY2R2NJTzJWbU91ZHZPdUxpT3E1akNJcExpRHFzb3pyaTZUcXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3F3Z0NEc2k1enRnYXpycHI4S0x5OGdJQ0FnSUNEc25ianNucERycGJ3ZzY2eTA3SXVjN1pXWTY2bTBLT3lDdk95RXNTRHNuYmp0aExEcmhMY2c3SXVrN0xpaEtTRHNuYnpyc0pnZzdMQzk3SjIwSU91V29DRHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPcTN1T3VNZ091aG5PdUxwQzRLTHk4ZzZyZTQ2NTZZN0lTY0lDb3FRbEpQVjFORlV1dWx2Q0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a0tpb2c0b0NVSUdOc1lYVmtaU0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHFzNkFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHNucERyajVrS0x5OGc3SWlZNjZDNTdaV2M2NHVrS095OWxPdVRuQ0RydHBuc2w2enJoS1BxdUxBZzdKZUc3SjJNS1M0ZzZyT0U3S0NWSU95Z2hPMlptT3lkZ0NEc2lybnNuYmdnN1ptVTY2bTBJTzJWbU91THFDQmI2ck9FN0tDVklPeWdoTzJabUYwZzY3S0U3WXE4N0p5ODY2R2NJTzJWbk91THBDNEtMeThnS2lyc25iUWc2cks5NjZHYzdKZVFJRlZTVENEcXNJRHFzN1hDdCt5a2tlcXdoQ0RzaXFUdGdhenJwcjN0aXJqQ3QrdTRqT3Vkdk95YXNPeWdnQ0RzcDREc29KWHNuWVFnNjR1azdJdWNJT3VFbyt5bmdDRHJwNUFnNnJLRExpb3FDZ292THlEaWxJRGlsSUFnUWxKUFYxTkZVaURxc0lEcm9aenNzWVRxdUxEcmlwUWc3S0NjNnJHdzY1Q1E2NHVrSUNneU1ESTJMVEE0TENCQ1VrbEVSMFZmVmoweU5Ta2c0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQUNpOHZJT3lZaU95Z2hPeVhsQ0JDVWs5WFUwVlNJTzJabU9xeXZldXpnT3lJbU95WGtDRHNub1RzaTV3ZzdJcWs3WUdzNjZhOTdZcTQ2Nlc4SU9xOWd1eVZoQ0JEVEVucXNJQWc3S1NBSUdGMWRHaHZjbWw2WlNCVlVrenNuWVFnN0pxdzY2YXM2ckNBSU91d20reVZoT3lFbkNEc2w3VHNsNGpyaTZRdUNpOHZJT3VxcWV5Z2dleWRnQ0R0bFpqcmdwanJ2NURzbmJUc2w0anJpNlFnNG9DVUlPcXpoT3lnbFNEc29JVHRtWmpzbXFuc25MenJvWndnVlZKTTdKMkVJR05zWVhWa1pTNWhhUzlzYjJkdmRYUS9jbVYwZFhKdVZHODk0b0NtNjZHY0lPeWVyT3lla2V5RXNlMlZ0QW92THlEc2lybnNuYmdnN1ptVTY2bTA3SjJFSU9xeHRPdUVpT3Vic09xem9DRHFzNFRzb0pVZzdJU2c3WU9kSU8yWmxPdXB0T3lYa0NEc3A0SHRsb25zaTV6dGdxVHF1TEF1SU9xM3VDRHNucXpzbnBIc2hMSHNuWVFnN1krUTZyaXc3WldZN0o2UUtPeUNyT3lhcWV5ZWtDRHFzckRzb0pVcElPMlZ1T3VUcE91ZnJPdUtsQW92THlEcnFxbnNvSUhzbmJRZzdKZUc3SmEwN0tHTTZyT2dMQ0FxS3V1Q3FPcXlxQ0Rya1pEcnFiUWc3SmlrN1o2STY2Q2tJT3Vobk9xM3VPeWR1T3lkaENEcnA1M3FzSURybktqcnByRHJpNlFxS2pvS0x5OGdJQ0JEVEVucXNJQWdWVkpNN0oyRUlPdVVzT3lZdE8yUm5DRHNsNGJzbmJRZzY0U1k2cml3NjZtMElHTnRaT3F3Z0NCZ0ptRHNsNURzaEp3Z1ZWSk03SjJFSU95ZW1PdWR2Q0Ryc29Ucm9LUW83SnlJNjQrRTdKcXdLU0JqYkdsbGJuUmZhV1FnNnJDWjdKMkFJT3VTcE95cXZRb3ZMeUFnSU91bnBPcXduT3V6Z095SW1PcXdnQ0RzZ3F6cm5ienNwNERxczZBc0lPdTRqT3Vkdk95YXNPeWdnT3lYbENBaTdKNlk2NnE3NjVDY0lFOUJkWFJvSU95YWxPeXlyU0RDdHlCamJHbGxiblJmYVdRZzY2ZWs2ckNjNjdPQTdJaVk2ckNBSU91SWhPdWR2ZXVRbU95WGlPeUt0ZXVMaU91THBDTHFzSUFnNjV5czY0dWtMZ292THlBZ0lPeUxyTzJWbU91cHRDRHJ1SXpybmJ6c21yRHNvSURxc0lBZzdKV0U3SmlJSU95VmlDRHNsN1RycHJEcmk2UW83SXVrN0xpaElESXdNall0TURnNklFTk1TU0R0bElUcm9aenNoTGpzaXFUcmlwUWc2NHlBNnJpd0lPeWtrZXlkdU91TnNDRHNzTDNzbmJRZzdKV0lJT3VjdUNrdUNpOHZJT3lkdE95Z25DQkNVazlYVTBWUzY2VzhJT3F4dE91VG5PdW1yT3luZ0NEc2xZcnJpcFRyaTZRZzRvYVNJR05zWVhWa1pTQkRURW5xc0lBZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzcDRIc29KRWc3SmV3NjR1a0tFTk1TU0RxdUxEcnM3Z2c2NCtaN0o2UktTNEtMeThnS2lyc25iUWc2cks5NjZHYzdKZVFJRlZTVENEcXNJRHFzN1hDdCt5a2tlcXdoQ0RzaXFUdGdhenJwcjN0aXJqcnBid2c2NHVrN0l1Y0lPdUVvK3luZ0NEcnA1QWc2cktETGlvcUlPcXpoT3lnbFNEc29JVHRtWmpzbllBZzdJcTU3SjI0SU8yWmxPdXB0Q0R0bFpqcmk2Z2dXK3F6aE95Z2xTRHNvSVR0bVpoZElPdXloTzJLdk95Y3ZPdWhuQzRLQ2k4dklPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmdnN1pTRTY2R2M3SVM0N0lxa0lDaGpiR0YxWkdVZ1lYVjBhQ0JzYjJkcGJpQXRMV05zWVhWa1pXRnBLU0RpZ0pRZ0wyOXdaVzR0Ykc5bmFXN3NuYlFnN0lPZDdJU3h3cmZxdElEcnBxd3VDaTh2SU91NGpPdWR2T3lhc095Z2dPcXdnQ0JzYjJOaGJHaHZjM1Ryb1p3ZzZyS3c2ck84NjZXOElPdXp0T3VDdE95a2hDRHJsWXpxdVl6c3A0QWc3SWlvN0phMDdJU2NJT3VNZ09xNHNPMlZtT3VMcE9xd2dDd2c3Sm1FNjZPTTY1Q1k2Nm0wSU95S3BPeUtwT3VobkNEcmdaM3JncHpyaTZRdUNteGxkQ0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPd3BzWlhRZ2JHOW5hVzVRY205alZHbHRaWElnUFNCdWRXeHNPd3BzWlhRZ2JHOW5hVzVUZEdGeWRHVmtRWFFnUFNBd095QXZMeURydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNElPeUxuT3lla1NEc2k1enFzSUVnNG9DVUlPeWVyTzJCdE91bXJleWR0Q0FuN0o2czdJdWM2NCtFSit5ZHVPeW5nQ0FuN0o2UTY0K1o3Sm1FNjZPTUlPeUxwTzJNcUNmc25ianNwNEFnNnJXczY3YUU3WldjNjR1a0NpOHZJT3lkdE91eWlDRHJvWnpxdDdqc25ianNsNURzaEp3ZzY3aU02NTI4N0pxdzdLQ0FJT3l3dmV5ZGhDRHNpNlRzb0p6cm9ad2c2NTJFN0p1ZzY0cVU2ckNBSU9LQWxDRHRoTERycjdqcmhKQWc3WSswNjdDeDdKMkFJT3lkdE9xeWpDQm1ZV3h6WmV5ZHZDRHJsWXpycDR3ZzdKTzA2NHVrQ2k4dklDanNpNXpxc0lUcnA0enNuTHpyb1p3ZzdZeVE2NHVvN1pXWTY2bTBJT3lnbGV5RGdTRHNucXp0Z2JUcnBxM3NsNURyajRRZ1kyMWtJT3l3dmV5ZHRDRHRpb0RzbHJUcmdwanNtS2pyaTZRcENteGxkQ0JzYjJkcGJsZHBibVJ2ZDA5d1pXNWxaQ0E5SUdaaGJITmxPd3BtZFc1amRHbHZiaUJyYVd4c1RHOW5hVzVRY205aktDa2dld29nSUdsbUlDaHNiMmRwYmxCeWIyTlVhVzFsY2lrZ2V5QmpiR1ZoY2xScGJXVnZkWFFvYkc5bmFXNVFjbTlqVkdsdFpYSXBPeUJzYjJkcGJsQnliMk5VYVcxbGNpQTlJRzUxYkd3N0lIMEtJQ0JwWmlBb0lXeHZaMmx1VUhKdll5a2djbVYwZFhKdU93b2dJR052Ym5OMElIQWdQU0JzYjJkcGJsQnliMk03Q2lBZ2JHOW5hVzVRY205aklEMGdiblZzYkRzS0lDQjBjbmtnZXdvZ0lDQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnUFQwOUlDZDNhVzR6TWljcElIc0tJQ0FnSUNBZ2MzQmhkMjVUZVc1aktDZDBZWE5yYTJsc2JDY3NJRnNuTDFCSlJDY3NJRk4wY21sdVp5aHdMbkJwWkNrc0lDY3ZWQ2NzSUNjdlJpZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzS0lDQWdJSDBnWld4elpTQjdDaUFnSUNBZ0lIUnllU0I3SUhCeWIyTmxjM011YTJsc2JDZ3RjQzV3YVdRc0lDZFRTVWRVUlZKTkp5azdJSDBnWTJGMFkyZ2dLRjlsTWlrZ2V5QndMbXRwYkd3b0tUc2dmUW9nSUNBZ2ZRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3VzdE95TG5DQXFMeUI5Q24wS0NpOHZJTzJFdENEcmo0VHNwSkVnN1lHMDY2R2M2NU9jSU8yVWhPdWhuT3lFdU95S3BPcXdnQ0Rzbzczc2w0anNuWVFnNjVXTTdKMllJT3lMcE8yTXFDRHJxWlRzaTV6c3A0QWc0b0NVSUhKMWJsUjFjbTdzbmJRZzdKMjBJT3VwbE95TG5PeW5nT3lkdkNEcmxZenJwNHdnTWUyYWpDRHNucERyajVrZzdKNnM3SXVjNjQrRTdaV2M2NHVrQ21OdmJuTjBJRk5GVTFOSlQwNWZSRWxGUkNBOUlDZnRnYlRyb1p6cms1d2c3SVM0N0lXWTdKMjBJT3lpaGV1ampPdVFrT3lXdE95YWxDNG5Pd3BzWlhRZ2MyaDFkSFJwYm1kRWIzZHVJRDBnWm1Gc2MyVTdJQzh2SUM5emFIVjBaRzkzYmlEc3A0VHRsb2tnN0tTUklPS0FsQ0RzbnF6c2k1enJqNFRyb1p3ZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91bXJPeW5nQ0RzbFlycXNvd2c3WkdjN0l1Y0Nnb3ZMeUJ5WldGemIyN3NuWVFnN0tPODY2bTBJQ2Zzblpqcmo0VHNvSUVnN0tLRjY2T01KeWpxczRUc29KVWc3S0NFN1ptWXdyZnJvWnpxdDdqc2xZVHNtNE1nNjVPeEtTRGlnSlFnN0tlRTdaYUpJT3lra2V5ZHRPdU5tQ0R0aExUc25ZUWc2cmU0SU91cGxPeUxuT3luZ091aG5DRHJnWjNyZ3JUc2hKd0tMeThnY25WdVZIVnlidXlkbUNCVFJWTlRTVTlPWDBSSlJVUWc3SjZRNjQrWklPeWVyT3lMbk91UGhPcXdnQ0RzbUpzZzdKNlE2cktwN0thZDY2cUY3Snk4NjZHY0lPeUV1T3lGbU95ZGhDRHJrSmpzZ3JUcnBxenNwNEFnN0pXSzZyS01JTzJWbk91THBDNEtMeThnS095VmlDRHF0N2pybjZ6cnFiUWc2ck9FN0tDVklPeWdoTzJabUNEc3A0SHRtNFFnN0ppYklPcXpoT3lnbFNEc2hManNoWmpzbmJRZzY3YUE3Wm1jN1pXMElFMUJXRjlVVlZKT1UrcTVqT3luZ0NEcXM0VHNobzBnN0pPdzdKMjA2NHFVSU91eWhPcTN1Q0RpZ0pRZ01qQXlOaTB3TnlEcnBxenJ0N0RzbDVEc2hKd2c3Wm1WN0oyNEtRcG1kVzVqZEdsdmJpQnJhV3hzVUhKdll5aHlaV0Z6YjI0cElIc0tJQ0JwWmlBb2NISnZZeWtnZXdvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNLSUNBZ0lDQWdJQ0F2THlCemFHVnNiRHAwY25WbDY2R2NJT3VkaE95YmpPeUVuQ0J3Y205ajdKMkFJR050WkNEcXU0M3JqYkRxdUxBZzRvQ1VJQzlVNjZHY0lPMkt1T3Vtck95bnVDRHNvNzNzbDZ6c2xid2c3S2VFN0tlY0lHTnNZWFZrWmVxd2dDRHFzNkRzbFlUcm9ad2c3SldJSU91Q3FPdUtsT3VMcEFvZ0lDQWdJQ0FnSUM4dklDanFzNkRzbFlRZ1kyeGhkV1JsNnJDQUlPeUVwT3k1bUNEdGpJenNuYnpzbllRZzY2eTg2ck9nSU95ZWlPeWN2T3VwdENEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU9xd2dDQWk3SUtzN0pxcElPeWtrU0xzbkx6cm9ad2c2NmVKN1o2WUtRb2dJQ0FnSUNBZ0lITndZWGR1VTNsdVl5Z25kR0Z6YTJ0cGJHd25MQ0JiSnk5UVNVUW5MQ0JUZEhKcGJtY29jSEp2WXk1d2FXUXBMQ0FuTDFRbkxDQW5MMFluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdDaUFnSUNBZ0lIMGdaV3h6WlNCN0NpQWdJQ0FnSUNBZ0x5OGdiV0ZqVDFNdjY2YXM2NGlGN0lxa09pQnphR1ZzYkRwMGNuVmw2NTI4SUhCeWIyUHNuYlFnYzJnZzZydU42NDJ3NnJpdzdKMjhJT3lJbUNEc25vanNuWXdnNG9DVUlITjBZWEowVUhKdlkreWRtQ0JrWlhSaFkyaGxaT3VobkNEcnA0enJrNkFLSUNBZ0lDQWdJQ0F2THlEdGxJVHJvWnpzaExqc2lxUWc2cmU0NjZPNUtDMXdhV1FwN0oyRUlPMkd0ZXludU91aG5DRHNvSlhycHF6dGxaenJpNlFnS0hSaGMydHJhV3hzSUM5VUlPdU1nT3lka1NrS0lDQWdJQ0FnSUNCMGNua2dleUJ3Y205alpYTnpMbXRwYkd3b0xYQnliMk11Y0dsa0xDQW5VMGxIVkVWU1RTY3BPeUI5SUdOaGRHTm9JQ2hmWlRJcElIc2djSEp2WXk1cmFXeHNLQ2s3SUgwS0lDQWdJQ0FnZlFvZ0lDQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c2NnkwN0l1Y0lDb3ZJSDBLSUNCOUNpQWdjSEp2WXlBOUlHNTFiR3c3Q2lBZ2QyRnliV1ZrVlhBZ1BTQm1ZV3h6WlRzS0lDQnBaaUFvZDJGcGRHVnlLU0I3SUdOc1pXRnlWR2x0Wlc5MWRDaDNZV2wwWlhJdWRHbHRaWElwT3lCM1lXbDBaWEl1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWh5WldGemIyNGdmSHdnVTBWVFUwbFBUbDlFU1VWRUtTazdJSGRoYVhSbGNpQTlJRzUxYkd3N0lIMEtmUW9LWm5WdVkzUnBiMjRnYzNSaGNuUlFjbTlqS0NrZ2V3b2dJR3RwYkd4UWNtOWpLQ2s3Q2lBZ2JHbHVaVUoxWmlBOUlDY25Pd29nSUhSMWNtNXpJRDBnTURzS0lDQXZMeURzbmJRZzdJUzQ3SVdZN0oyMElPeVd0T3VLa0NEcXM0VHNvSlhzblpnZzdKNkY3SjZsNnJhTTdKeTg2NkdjSU91UGhPdUtsT3luZ0NEcXVMRHJvWjBnNG9DVUlPdXdsdXlYa095RW5DRHFzNFRzb0pYc25iUWc2N0NVNjRDTTdKZUk2NHFVN0tlQUlPdTVoT3Exa08yVm1PdUtsQ0RxdUxEc3BJQUtJQ0J6WlhOemFXOXVRV05qYjNWdWRDQTlJR05zWVhWa1pVRmpZMjkxYm5Rb0tUc0tJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPeUV1T3lGbUNEc2k1enJqNWtnN0tTUjRvQ21JQ2pycXFqcmpiZzZJQ2NnS3lCamRYSnlaVzUwVFc5a1pXd2dLeUFuS1NjcE93b2dJR052Ym5OMElIUm9hWE5RY205aklEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25MWEFuTENBbkxTMXRiMlJsYkNjc0lHTjFjbkpsYm5STmIyUmxiQ3dnSnkwdGFXNXdkWFF0Wm05eWJXRjBKeXdnSjNOMGNtVmhiUzFxYzI5dUp5d2dKeTB0YjNWMGNIVjBMV1p2Y20xaGRDY3NJQ2R6ZEhKbFlXMHRhbk52Ymljc0lDY3RMWFpsY21KdmMyVW5YU3dnZXdvZ0lDQWdjMmhsYkd3NklIUnlkV1VzSUdOM1pEb2dSVTFRVkZsZlExZEVMQ0JsYm5ZNklFTk1RVlZFUlY5RlRsWXNDaUFnSUNCa1pYUmhZMmhsWkRvZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBaFBUMGdKM2RwYmpNeUp5d2dMeThnVUU5VFNWZzZJT3lla09xNHNDRHRsSVRyb1p6c2hManNpcVFnNnJlNDY2TzVJT3lEbmV5RXNTRGlnSlFnYTJsc2JGQnliMlBzbmJRZzZyZTQ2Nk81N0tlNElPeWdsZXVtck8yVm9DRHNpSmdnN0o2STZyS01DaUFnZlNrN0NpQWdjSEp2WXlBOUlIUm9hWE5RY205ak93b2dJSEJ5YjJNdWMzUmtiM1YwTG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzS0lDQWdJR3hwYm1WQ2RXWWdLejBnWkM1MGIxTjBjbWx1WnlnbmRYUm1PQ2NwT3dvZ0lDQWdiR1YwSUdsa2VEc0tJQ0FnSUhkb2FXeGxJQ2dvYVdSNElEMGdiR2x1WlVKMVppNXBibVJsZUU5bUtDZGNiaWNwS1NBaFBUMGdMVEVwSUhzS0lDQWdJQ0FnWTI5dWMzUWdiR2x1WlNBOUlHeHBibVZDZFdZdWMyeHBZMlVvTUN3Z2FXUjRLUzUwY21sdEtDazdDaUFnSUNBZ0lHeHBibVZDZFdZZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0dsa2VDQXJJREVwT3dvZ0lDQWdJQ0JwWmlBb0lXeHBibVVwSUdOdmJuUnBiblZsT3dvZ0lDQWdJQ0JzWlhRZ1pYWWdQU0J1ZFd4c093b2dJQ0FnSUNCMGNua2dleUJsZGlBOUlFcFRUMDR1Y0dGeWMyVW9iR2x1WlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUdOdmJuUnBiblZsT3lCOUNpQWdJQ0FnSUdsbUlDaGxkaUFtSmlCbGRpNTBlWEJsSUQwOVBTQW5jbVZ6ZFd4MEp5QW1KaUIzWVdsMFpYSXBJSHNLSUNBZ0lDQWdJQ0JqYjI1emRDQjNJRDBnZDJGcGRHVnlPd29nSUNBZ0lDQWdJSGRoYVhSbGNpQTlJRzUxYkd3N0NpQWdJQ0FnSUNBZ1kyeGxZWEpVYVcxbGIzVjBLSGN1ZEdsdFpYSXBPd29nSUNBZ0lDQWdJR2xtSUNobGRpNXBjMTlsY25KdmNpa2dld29nSUNBZ0lDQWdJQ0FnWTI5dWMzUWdjbUYzSUQwZ1UzUnlhVzVuS0dWMkxuSmxjM1ZzZENCOGZDQmxkaTV6ZFdKMGVYQmxJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlNREFwT3dvZ0lDQWdJQ0FnSUNBZ0x5OGc3WldjNjQrRUlPeTBpT3F6dk91bHZDRHJxTHpzb0lBZzY3TzQ2NHVrSU9LQWxDRHJvWnpxdDdqc25iZ2c3SmlrNjZXWUlPeWdsZXEzbk95TG5leWR0Q0RyaEpQc2xyVHNoSndvYkc5bklEOXBiaURyazdFcElPdXN1T3Exck9xd2dDRHJzSlRyZ0l6cnFiUWc3SUs4N1lLc0lPeUltQ0Rzbm9qcmk2UUtJQ0FnSUNBZ0lDQWdJR2xtSUNocGMweHBiV2wwUlhKeWIzSW9jbUYzS1NrZ2V3b2dJQ0FnSUNBZ0lDQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW5ZMnhoZFdSbExXeHBiV2wwSnpzZ0x5OGdMMmhsWVd4MGFPdWhuQ0RzbFl6cnByd2c0b2FTSU91eWhPMkt2T3lkdENCYjdaV2M2NCtFSU95MGlPcXp2RjNyb1p3ZzY3Q1U2NENNNnJPZ0lPcXpoT3lnbFNEc29JVHRtWmpzbllRZzdKV0k2NEswQ2lBZ0lDQWdJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnN0lLczdKcXBJTzJWbk91UGhDRHN0SWpxczd3ZzZyQ1E3S2VBT2ljc0lISmhkeWs3Q2lBZ0lDQWdJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpaE1TVTFKVkY5SFZVbEVSU2twT3dvZ0lDQWdJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaHBjMEYxZEdoRmNuSnZjaWh5WVhjcEtTQjdDaUFnSUNBZ0lDQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiRzluYjNWMEp6c2dMeThnTDJobFlXeDBhT3VobkNEdGxJenJuNnpxdDdqc25ianNsNUFnN0pXTTY2YThJT0tHa2lEcnNvVHRpcnpzbmJRZ1crdWhuT3EzdU95ZHVDRHRsWVRzbXBSZDY2R2NJT3V3bE91QW5Bb2dJQ0FnSUNBZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBT2ljc0lISmhkeWs3Q2lBZ0lDQWdJQ0FnSUNBZ0lIY3VjbVZxWldOMEtHNWxkeUJGY25KdmNpaE1UMGRKVGw5SFZVbEVSU2twT3dvZ0lDQWdJQ0FnSUNBZ2ZTQmxiSE5sSUhzS0lDQWdJQ0FnSUNBZ0lDQWdkeTV5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2Z0Z2JUcm9aenJrNXdnN0ppazY2V1lPaUFuSUNzZ2NtRjNLU2s3Q2lBZ0lDQWdJQ0FnSUNCOUNpQWdJQ0FnSUNBZ2ZTQmxiSE5sSUhzS0lDQWdJQ0FnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNkdmF5YzdJQzh2SU95RXNlcXp0U0E5SU95RXBPeTVtTUszNjZHYzZyZTQ3SjI0SU91THBDRHNvSlhzZzRFZzRvQ1VJT3lXdE91V3BDQndjbTlpYkdWdDdKMjA2NU9nSU8yVnRPeWduQ0FvN0o2czY2R2M2cmU0N0oyNEwreWVyT3lFcE95NW1DRHJzN1hxdDRBcENpQWdJQ0FnSUNBZ0lDQjNMbkpsYzI5c2RtVW9VM1J5YVc1bktHVjJMbkpsYzNWc2RDQjhmQ0FuSnlrcE93b2dJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ2ZRb2dJQ0FnZlFvZ0lIMHBPd29nSUhCeWIyTXVjM1JrWlhKeUxtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc0tJQ0FnSUdOdmJuTjBJSE1nUFNCa0xuUnZVM1J5YVc1bktDZDFkR1k0SnlrdWRISnBiU2dwT3dvZ0lDQWdhV1lnS0hNZ0ppWWdJWE11YVc1amJIVmtaWE1vSjBSbGNISmxZMkYwYVc5dVYyRnlibWx1WnljcEtTQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnWTJ4aGRXUmxJSE4wWkdWeWNqb25MQ0J6TG5Oc2FXTmxLREFzSURJd01Da3BPd29nSUgwcE93b2dJSEJ5YjJNdWIyNG9KMk5zYjNObEp5d2dLR052WkdVcElEMCtJSHNLSUNBZ0lDOHZJT3lkdE91dnVDRHNnNGdnN0lTNDdJV1k3Snk4NjZHY0lPcTFrT3l5dE91UW5DRHJrcVFnN0ppYklPeUV1T3lGbU95ZHRDRHJpNnZ0bm93ZzZyR3c2Nm0wSU91c3RPeUxuQ0FvNjZxbzY0MjRJT3lnaE8yWm1DRHNpNXdnN0lPSUlPeUV1T3lGbU95ZGhDRHNvNzNzbmJUc3A0QWc3SldLNnJLTUtRb2dJQ0FnYVdZZ0tIQnliMk1nSVQwOUlIUm9hWE5RY205aktTQnlaWFIxY200N0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZRzA2NkdjNjVPY0lPeUV1T3lGbUNEc29vWHJvNHdnS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NEaWdKUWc2NHVrN0oyTUlPeWFsT3l5clNEcmxZd2c2NHVrN0l1Y0lPeUxuT3VQbWUyVnFldUxpT3VMcEM0bktUc0tJQ0FnSUd0cGJHeFFjbTlqS0NrN0NpQWdmU2s3Q24wS0NtWjFibU4wYVc5dUlITmxibVJVZFhKdUtIUmxlSFFwSUhzS0lDQnlaWFIxY200Z2JtVjNJRkJ5YjIxcGMyVW9LSEpsYzI5c2RtVXNJSEpsYW1WamRDa2dQVDRnZXdvZ0lDQWdhV1lnS0NGd2NtOWpLU0J5WlhSMWNtNGdjbVZxWldOMEtHNWxkeUJGY25KdmNpZ243WUcwNjZHYzY1T2NJT3lFdU95Rm1PeWR0Q0RzbDRic2xyVHNtcFF1SnlrcE93b2dJQ0FnYVdZZ0tIZGhhWFJsY2lrZ2NtVjBkWEp1SUhKbGFtVmpkQ2h1WlhjZ1JYSnliM0lvSit5Vm51eUVvQ0RzbXBUc3NxM3NuYlFnN0tlRTdaYUpJT3lra2V5ZHRPeVhrT3lhbEM0bktTazdDaUFnSUNCamIyNXpkQ0IwYVcxbGNpQTlJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lTMElPeUxuT3F3aENEc3RJanFzN3dnNG9DVUlPeUV1T3lGbU95ZGhDRHNucXpzaTV6c25wSHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJQzh2SU95TG5PcXdoQ0RzdElqcXM3enJpcFFnSit5RXVPeUZtQ0Rzb29Ycm80d243Sm1BSU9xMXJPdTJoT3VRbU91S2xDRHNvSndnNjZtVTdJdWM3S2VBNjZHY0lPdUJuZXVDdU91THBDRGlnSlFnYTJsc2JGQnliMlBzblpnZzdJUzQ3SVdZSU95aWhldWpqQ0J5WldwbFkzVHFzSUFLSUNBZ0lDQWdMeThnY25WdVZIVnlidXlkbUNEc25wRHJqNWtnN0o2czdJdWM2NCtFNjZXOElPdTJnT3VsdE91cHRDRHNsWWdnNjVDWTZyaXdJT3VWak91c3VDanJpcERycHJBZzdZUzA3SjJFSU91UmtDRHJzb2dnNjQrTTY2bTBJTzJVak91ZnJPcTN1T3lkdUNBeE16RHN0SWdnN0tDYzdaV2M3SjJFSU91RW1PcTR0T3VMcENrS0lDQWdJQ0FnYVdZZ0tIZGhhWFJsY2lrZ2V3b2dJQ0FnSUNBZ0lHTnZibk4wSUhjZ1BTQjNZV2wwWlhJN0lIZGhhWFJsY2lBOUlHNTFiR3c3Q2lBZ0lDQWdJQ0FnZHk1eVpXcGxZM1FvYm1WM0lFVnljbTl5S0NmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyMElPdUVpT3VzdENEc21LVHJucGdnNnJHNDY2Q2tJT3lhbE95eXJleWRoQ0RzcEpIcmk2anRsb2pzbHJUc21wUWc0b0NVSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcEtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCcmFXeHNVSEp2WXlncE93b2dJQ0FnZlN3Z1ZGVlNUbDlVU1UxRlQxVlVYMDFUS1RzS0lDQWdJSGRoYVhSbGNpQTlJSHNnY21WemIyeDJaU3dnY21WcVpXTjBMQ0IwYVcxbGNpQjlPd29nSUNBZ2NISnZZeTV6ZEdScGJpNTNjbWwwWlNoS1UwOU9Mbk4wY21sdVoybG1lU2g3SUhSNWNHVTZJQ2QxYzJWeUp5d2diV1Z6YzJGblpUb2dleUJ5YjJ4bE9pQW5kWE5sY2ljc0lHTnZiblJsYm5RNklIUmxlSFFnZlNCOUtTQXJJQ2RjYmljc0lDZDFkR1k0SnlrN0NpQWdmU2s3Q24wS0NpOHZJT3F3bWV5ZGdDRHJyTGpxdGF6cnBid2c2NnFISU91eWlPeW51Q0Ryckx2cmlwVHNwNEFnNnJpdzdKYTFJT0tBbENEc25xenNtcFRzc3Ezc25iVHJxYlFnSXV5ZHRPeWdoT3F6dkNEcmk2VHJwYmdnN0lPSUlPeWduT3lWaUNMc25ZUWc3SnFVNnJXczdaV2M2NHVrQ2k4dklDanNsWWdnNnJlNDY1K3M2Nm0wSU8yQnRPdWhuT3VUbk9xd2dDRHNoTEhzaTZUdGxaanFzb3dnNnJDWjdKMkFJT3VMdGV5ZGhDRHJtSkFnNjRLMDdJU2NJRnRCU1NEc3RwVHNzcHdnNjQyVUlPdXdtK3E0c0YzcXNJQWc2NnkwN0oyWTY2KzQ3WlcwN0tlRTY0dWtLUXBqYjI1emRDQmhjMnRsWkVOdmRXNTBJRDBnYm1WM0lFMWhjQ2dwT3dvS0x5OGc3SVM0N0lXWUlPeWtnT3U1aENqc2k1enJqNWtyN0tlQTdJdWM2Nnk0SU95anZPeWVoU25ycGJ3ZzY3TzA3SjZsN1pXY0lPdVNwQ0R0bFp3ZzdZUzBJT3lMcE8yV2lTRGlnSlFnNjZxbzY1T2dJTzJZdU95Mm5PeWRnQ0J4ZFdWMVpldWhuQ0RzcDRIcm9LenRtWlF1Q2k4dklHMXZaR1ZzN0oyRUlPeWp2T3VwdENEcXQ3Z2c2NnFvNjQyNDY2R2NJQ2pyaTZUcnBiVHJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU2t1SU8yVm5DRHJxcWpyamJqc25ZUWc2ck9FN0lhTklPeVRzT3VwdENEc25xenNpNXpzbnBIc25ZQWc3TFdjN0xTSUlESHRtb3pydjVBdUNpOHZJSEpsY0dGeWMyVTllM0JoY25ObExDQm1iM0p0WVhSRVpYTmpmZXVsdkNEc283enJxYlFnN1l5TTdJdXg2cm1NN0tlQUlPeWR0Q0RzbnFFZzdKV0k3SmVRN0lTY0lPeXltT3Vtck8yVm1PcXpvQ0I3Y21GM0xDQndZWEp6WldSOTY2VzhJT3VQak91Z3BPeWtnT3VMcERvS0x5OGc3WmlWN0l1ZElPeWR0TzJEaUNEc2k1d2c2ckNaN0oyQUlPeUV1T3lGbU95WGtDQWk3WmlWN0l1ZDY0eUE2NkdjSU91THBPeUxuQ0xycGJ3ZzdKcVU2cldzN1pXWTY0cVVJT3llck95YWxPeXlyU0R0aExUc25ZUWdLaXJxc0puc25ZQWc3WUdRSU95ZW9TRHNsWWpzbDVEc2hKd3FLaURydHBuc25ianJpNlF1Q2k4dklPdXpoT3VQaENEc25xSHNuTHpyb1p3ZzY3bTg2Nm0wSUNoaEtTRHNncXpzbmJUc2w1QWc2NHVrNjZXNElPeWFsT3l5clNEdGhMVHNuYlFnNjRHODdKYTBJQ2Zyc0tucXVJZ2c2NHUxSit5ZHRDRHJncWpzblpnZzY0dTE3SjIwSU91UW1PcXpvQ2pyZ3JUc21xa2c3SmlrN0plOEtTd0tMeThnS0dJcElFMUJXRjlVVlZKT1V5RHFzcjNxczRUc2w1RHNoSndnN0lTNDdJV1k3SjIwSU95ZXJPeUxuT3lla2V1UHZDQW42N0NwNnJpSUlPdUx0U2ZzbmJRZzdKZUc2NHFVSU95RGlDRHNoTGpzaFpqc25iUWc2NEswN0pxcDdKMkVJT3luZ095V3RPdUN2Q0RzaUpnZzdKNkk2NHVrSUNneU1ESTJMVEEzSU91bXJPdTNzT3lYa095RW5DRHRtWlhzbmJncExncGpiMjV6ZENCU1JWQkJVbE5GWDBKQlJDQTlJQ2gyS1NBOVBpQjJJRDA5SUc1MWJHd2dmSHdnS0VGeWNtRjVMbWx6UVhKeVlYa29kaWtnSmlZZ2RpNXNaVzVuZEdnZ1BUMDlJREFwT3dwbWRXNWpkR2x2YmlCeWRXNVVkWEp1S0dKMWFXeGtRWE5yTENCdGIyUmxiQ3dnY21Wd1lYSnpaU2tnZXdvZ0lHTnZibk4wSUdwdllpQTlJSEYxWlhWbExuUm9aVzRvWVhONWJtTWdLQ2tnUFQ0Z2V3b2dJQ0FnWTI5dWMzUWdhbTlpVTNSaGNuUWdQU0JFWVhSbExtNXZkeWdwT3lBdkx5RHNpNXpxc0lRZzdKaUk3SUt3SU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnN0txOUlPeWduTzJWbkNneE16RHN0SWdwN0oyRUlPdUVtT3E0dUNEc25xenNpNXpyajRUcmlwUWc3WStzNnJpdzdaV2M2NHVrQ2lBZ0lDQnBaaUFvYlc5a1pXd2dKaVlnUVV4TVQxZEZSRjlOVDBSRlRGTXVhVzVrWlhoUFppaHRiMlJsYkNrZ0lUMDlJQzB4SUNZbUlHMXZaR1ZzSUNFOVBTQmpkWEp5Wlc1MFRXOWtaV3dwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdXFxT3VOdUNEcnM0RHFzcjA2SUNjZ0t5QmpkWEp5Wlc1MFRXOWtaV3dnS3lBbklPS0draUFuSUNzZ2JXOWtaV3dwT3dvZ0lDQWdJQ0JqZFhKeVpXNTBUVzlrWld3Z1BTQnRiMlJsYkRzS0lDQWdJQ0FnYzNSaGNuUlFjbTlqS0NrN0lDOHZJT3lEaUNEcnFxanJqYmpyb1p3ZzdJUzQ3SVdZSU95ZXJPeUxuT3lla1NBbzY0dWs3SjJNSU95YmpPdXdqZXlYaGV5WGtPeUVuQ0RzcDREc2k1enJyTGdnN0o2czdLTzg3SjZGS1FvZ0lDQWdmUW9nSUNBZ2FXWWdLSFIxY201eklENDlJRTFCV0Y5VVZWSk9VeUI4ZkNBaGNISnZZeWtnYzNSaGNuUlFjbTlqS0NrN0NpQWdJQ0JwWmlBb0lYZGhjbTFsWkZWd0tTQjdDaUFnSUNBZ0lHTnZibk4wSUhRd0lEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lDQWdZWGRoYVhRZ2MyVnVaRlIxY200b2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa3BPd29nSUNBZ0lDQjNZWEp0WldSVmNDQTlJSFJ5ZFdVN0NpQWdJQ0FnSUhSMWNtNXpLeXM3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc2hManNoWmdnN0tTQTY3bUVJT3laaE91ampDQW9KeUFySUNnb1JHRjBaUzV1YjNjb0tTQXRJSFF3S1NBdklERXdNREFwTG5SdlJtbDRaV1FvTVNrZ0t5QW5jeWtnNG9DVUlPeWR0TzJiaENEc21wVHNzcTNzbllBZzY3bW82NTI4N0pxVUxpY3BPd29nSUNBZ2ZRb2dJQ0FnZEhWeWJuTXJLenNLSUNBZ0lHTnZibk4wSUdGemF5QTlJR0oxYVd4a1FYTnJLQ2s3SUM4dklPeWVyT3lMbk91UGhDRHJsWXdnNnJDWjdKMkFJT3luaU91c3VPeWRoQ0RyaTZUc2k1d2c3Sk8wNjR1a0lDaGhjMnRsWkVOdmRXNTBJT3lkdE95a2tTRHNwcDNxc0lBZzY3Q3A3S2VBS1FvZ0lDQWdiR1YwSUhKaGR6c0tJQ0FnSUhSeWVTQjdDaUFnSUNBZ0lISmhkeUE5SUdGM1lXbDBJSE5sYm1SVWRYSnVLR0Z6YXlrN0NpQWdJQ0I5SUdOaGRHTm9JQ2hsS1NCN0NpQWdJQ0FnSUM4dklPMkV0Q0RyajRUc3BKRWc3WUcwNjZHYzY1T2NJTzJVaE91aG5PeUV1T3lLcE9xd2dDRHNvNzNzbllBZzZySzk3SnF3S0ZORlUxTkpUMDVmUkVsRlJDa2dNZTJhakNEc25wRHJqNWtnN0o2czdJdWM2NCtFSU9LQWxDRHNncXpzbXFuc25wRHNsNURxc3BBZzdJdWs3WXlvNjZHY0lPeVZpQ0RyczdUc25iVHFzb3d1Q2lBZ0lDQWdJQzh2SU95TG5PcXdoQ0RzdElqcXM3ekN0K3Vobk9xM3VPeWR1Q0RycDR6cm80ekN0KzJCdE91aG5PdVRuQ0RzbUtUcnBaakN0K3lkbU91UGhPeWdnU0Rzb29Ycm80d282ck9FN0tDVklPeWdoTzJabUMvcm9aenF0N2pzbFlUc200TXNJR3RwYkd4UWNtOWpLSEpsWVhOdmJpa3A2NHFVQ2lBZ0lDQWdJQzh2SU95Z25DRHJxWlRzaTV6c3A0RHFzSUFnNjVTdzY2R2NJT3llaU95V3RDRHNsNnpxdUxBZzdKV0lJT3F4dU91bXNPdUxwQzRnN0tLRjY2T01JT3lhbE95eXJTRHNwSkhzbmJUcXNiRHJncGdnN0l1YzZyQ0VJT3lZaU95Q3NPeWR0Q0RzbHJ6cnA0Z2c3SldJSU91Q3FPeVZtT3ljdk91cHRDRHJrSmpzZ3JUcnBxenNwNEFnN0pXSzY0cVU2NHVrTGdvZ0lDQWdJQ0JwWmlBb2MyaDFkSFJwYm1kRWIzZHVJSHg4SUNFb1pTQW1KaUJsTG0xbGMzTmhaMlVnUFQwOUlGTkZVMU5KVDA1ZlJFbEZSQ2tnZkh3Z1JHRjBaUzV1YjNjb0tTQXRJR3B2WWxOMFlYSjBJRDRnTkRBd01EQXBJSFJvY205M0lHVTdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haanNuYlFnN1lTMElPdVBoT3lra1NEcmdZcnF1WUFnNG9DVUlPeWVyT3lMbk91UG1TRHRtNFFnTWUyYWpDRHNucXpzaTV6cmo0VHRsYW5yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJSE4wWVhKMFVISnZZeWdwT3dvZ0lDQWdJQ0JoZDJGcGRDQnpaVzVrVkhWeWJpaHBibk4wY25WamRHbHZiazFsYzNOaFoyVW9LU2s3Q2lBZ0lDQWdJSGRoY20xbFpGVndJRDBnZEhKMVpUc0tJQ0FnSUNBZ2RIVnlibk1nUFNBeU95QXZMeURzbTR6cnNJM3NsNFVnTVNBcklPeWR0T3V5aUNEdGhMUWdLSE4wWVhKMFVISnZZK3lkdENBdzdKeTg2NkdjSU95MGlPcTRzTzJabENrS0lDQWdJQ0FnY21GM0lEMGdZWGRoYVhRZ2MyVnVaRlIxY200b1lYTnJLVHNLSUNBZ0lIMEtJQ0FnSUdsbUlDZ2hjbVZ3WVhKelpTa2djbVYwZFhKdUlISmhkenNLSUNBZ0lHeGxkQ0J3WVhKelpXUWdQU0J5WlhCaGNuTmxMbkJoY25ObEtISmhkeWs3Q2lBZ0lDQXZMeUR0bUpYc2k1MGc3SjIwN1lPSTdKMjA2Nm0wSU9xd21leWRnQ0RzaExqc2haakN0K3F3bWV5ZGdDRHNucUhzbDVEc2hKd2c2ck9uN0o2bElPeWVyT3lhbE95eXJTRGlnSlFnN0oyMElPMkV0T3lkdENEc283M3NuTHpycWJRZzdJT0lJT3lFdU95Rm1PeWRnQ0FuNjdDcDZyaUlJT3VMdFNmc25ZUWc2NnF3NjUyOENpQWdJQ0F2THlEc3A0RHNsclRyZ3J3ZzdJaVlJT3llaU95Y3ZPdXZnT3VobkNEc2hManNoWmdnN0lLczY2ZWRJT3llck95TG5PdVBoT3VLbENEdGxaanNwNEFnN0pXSzZyT2dJT3EzdU91TWdPdWhuQ0RzaTZUdGpLanNpNXp0Z3Fqcmk2UW83WXlNN0l1eElPeUxwTzJNcU91aG5DRHF0NERxc3JBcExnb2dJQ0FnYVdZZ0tGSkZVRUZTVTBWZlFrRkVLSEJoY25ObFpDa2dKaVlnUkdGMFpTNXViM2NvS1NBdElHcHZZbE4wWVhKMElEd2dOekF3TURBcElIc0tJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNak95THNTRHNpNlR0aktnZzRvQ1VJTzJZbGV5TG5TRHNucXpzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSEpoZHlrdWMyeHBZMlVvTUN3Z016QXdLU2s3Q2lBZ0lDQWdJSFIxY201ekt5czdDaUFnSUNBZ0lIUnllU0I3Q2lBZ0lDQWdJQ0FnY21GM0lEMGdZWGRoYVhRZ2MyVnVaRlIxY200b0ordXdxZXE0aUNEcmk3WHNuYlFnN0pxVTZyV3M3WldjSU8yWWxleUxuZXlYa0NEc2xyVHF1SXZyZ3F6cmk2UXVJT3V3cWVxNGlDRHJpN1h0bFp3ZzY0SzA3SnFwN0oyRUlPeUVwT3VxaGNLMzdJS3M2ck84d3Jmc3ZaVHJrNXp0anB6c2lxUWc3SmVHN0oyMElPeVZoT3VlbUNCS1UwOU83Snk4NjZHYzY2ZU1JT3VMcE95TG5DRHN0cHpyb0tYdGxaanJuYnc2SUNjZ0t5QnlaWEJoY25ObExtWnZjbTFoZEVSbGMyTXBPd29nSUNBZ0lDQWdJSEJoY25ObFpDQTlJSEpsY0dGeWMyVXVjR0Z5YzJVb2NtRjNLVHNLSUNBZ0lDQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3SjZzN0pxVTdMS3RJT3lMcE8yTXFDRGlnSlFnN0pXRTY1Nlk3SmVRN0lTY0lPMk1qT3lMc1NEc2k2VHRqS2pyb1p3ZzdMS1k2NmFzSUNvdklIMEtJQ0FnSUgwS0lDQWdJR2xtSUNoU1JWQkJVbE5GWDBKQlJDaHdZWEp6WldRcEtTQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5TTdJdXhJT3lMcE8yTXFDQW83SjZzN0pxVTdMS3RJTzJiaE95WGtPdVBoQ2s2Snl3Z1UzUnlhVzVuS0hKaGR5a3VjMnhwWTJVb01Dd2dNekF3S1NrN0NpQWdJQ0J5WlhSMWNtNGdleUJ5WVhjc0lIQmhjbk5sWkRvZ1VrVlFRVkpUUlY5Q1FVUW9jR0Z5YzJWa0tTQS9JRzUxYkd3Z09pQndZWEp6WldRZ2ZUc0tJQ0I5S1RzS0lDQXZMeUR0bFp3ZzdKcVU3TEt0N0oyMElPeUxwTzJNcU8yVnRPdVBoQ0RyaTZUc25Zd2c3SnFVN0xLdDdKMjBJT3lkdE95V3RPeW5nT3VQaE91aG5TRHRnWkRyaXBRZzdaV3Q3SU9CSU95RXNlcXp0ZXljdk91aG5DRHNvSlhycHF3S0lDQnhkV1YxWlNBOUlHcHZZaTVqWVhSamFDZ29LU0E5UGlCN2ZTazdDaUFnY21WMGRYSnVJR3B2WWpzS2ZRb0tMeThnNjdLRTdZcThJT3Vkdk91eXFDRHF0NXpzdVprZzRvQ1VJTzJVak91ZnJPcTN1T3lkdU95ZHRDQW42N0tFN1lxODdKMkVJT3F6cU91ZWtPdUxwQ2ZxczZBZzdKV002NkNrN0tTRUlPdVZqT3VuakNEc2xybnJpcFRyaTZRdUNpOHZJT3V5aE8yS3ZDRHJyTGpxdGF6cmlwUWc2Nnk0N0o2bDdKMjBJT3lWaE91TGlPdWR2Q0RyajVuc25wRWc3SjIwNjZhRTdKMjA3SmEwN0lTY0xDRHNuYlFnN0tlQTdJdWM2ckNBSU95WGh1eWN2T3VwdENEcnJManNucVh0bUpVZzY0eUE3SldJN0oyMElPeUVudXlYckNEcmdwanNtS2pyaTZRdUNtTnZibk4wSUVKVlZGUlBUbDlTVlV4RklEMEtJQ0FuN0oyMElPdXN1T3Exck91S2xDQXFLdXV5aE8yS3ZDRHJuYnpyc3FncUt1eWR0T3VMcEM0ZzY2eTQ3SjZsN0oyMElPeVZoT3VMaU91ZHZDRHJqNW5zbnBFZzdKMjA2NmFFN0oyMDY2K0E2NkdjT2lEcnA0anN1YWp0a1p6Q3QrdXN2T3lkak8yUm5NSzM3S0tGNnJLdzdKYTA2Nis0S0g3c21wUXZmdXVMcEM5KzZybU03SnFVS1NEcXVJanNwNEFzSUNjZ0t3b2dJQ2Zya0pqcmo0VHJvWjBnN0tlbjdKMkFJT3VQbWV5ZWtTRHJxb1hzZ3F3bzdLQ0E3SjZsd3Jmc2dxM3NvSnpDdCt5WHNPcXlzQ0R0bGJUc29Kd2c2NU94S2V1aG5Dd2c3WWExNjdPMDdJU3hJT3VMcU95ZHZDRHJzb1R0aXJ6c25iVHJxYlFnSXUyWmxleWR1Q0l1SUNjZ0t3b2dJQ2NpN0xlbzdJYU1JdXVLbENEcmo1bnNucEVnNjdLRTdZcTg2ck84SU95bm5leWR2Q0RybFl6cnA0d2c3Sk93NnJPZ0xDRHRtWlRycWJRZzZyaXc2NHFsNjZxRktPdXpnT3F5dmNLMzdaVzA3S0NjSU91VHNTbnNuWUFnNnJlNDY0eUE2NkdjSU91UmxPdUxwQzVjYmljN0Nnb3ZMeURyckxqcXRhd2c3TGFVN0xLY0lPMkV0Q0FvY205c1pUMG42N0tFN1lxOEoreWR0T3VwdENEcnNvVHRpcndnNnJlYzdMbVo3SjJFSU95V3VldUtsT3VMcENrS1puVnVZM1JwYjI0Z1lYTnJRMnhoZFdSbEtIUmxlSFFzSUcxdlpHVnNMQ0J5WlhCaGNuTmxMQ0J5YjJ4bEtTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3b2dJQ0FnWTI5dWMzUWdZWFIwWlcxd2RDQTlJQ2hoYzJ0bFpFTnZkVzUwTG1kbGRDaDBaWGgwS1NCOGZDQXdLU0FySURFN0NpQWdJQ0JoYzJ0bFpFTnZkVzUwTG5ObGRDaDBaWGgwTENCaGRIUmxiWEIwS1RzS0lDQWdJR2xtSUNoaGMydGxaRU52ZFc1MExuTnBlbVVnUGlBeU1EQXBJR0Z6YTJWa1EyOTFiblF1WTJ4bFlYSW9LVHNnTHk4ZzY2eTA3WldjN1o2SUlPeU1rK3lkdE95bmdDRHNsWXJxc293S0lDQWdJR052Ym5OMElISjFiR1VnUFNCeWIyeGxJRDA5UFNBbjY3S0U3WXE4SnlBL0lFSlZWRlJQVGw5U1ZVeEZJRG9nSnljN0NpQWdJQ0J5WlhSMWNtNGdjblZzWlNBcklDaGhkSFJsYlhCMElENGdNUW9nSUNBZ0lDQS9JQ2Zxc0puc25ZQWc2Nnk0NnJXczY2VzhJT3VMcE95TG5DRHNtcFRzc3EzdGxaenJpNlF1SU95ZHRDRHNoTGpzaFpqc2w1RHNoSndnN0oyMDdLQ0U3SmVRSU95Z25PeVZpTzJXaU91Tm1DRHFzb1ByazZUcXM3d2c2cks1N0xtWTdLZUFJT3lWaXV1S2xDd2c2cldzN0tHdzY0S1lJT3lXdE8yY21PcXdnQ0R0bVpYc2k2VHRub2dnNjR1azY2VzRJT3lEaU91aG5PeWF0Q0RyaklEc2xZZ2dNK3F3bk91bHZDRHF0NXpzdVpucmpJRHJvWndnU2xOUFRpRHJzTERzbDdUcm9aenJwNHc2SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoMFpYaDBLUW9nSUNBZ0lDQTZJQ2ZyaTZUc25Zd2dWVWtnNjZ5NDZyV3M3SjJZSU91TWdPeVZpQ0F6NnJDYzY2VzhJT3Ezbk95NW1ldU1nT3VobkNCS1UwOU9JT3V3c095WHRPdWhuT3VuakRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwS1RzS0lDQjlMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdDbjBLQ2k4dklPdXlpT3lYclNEdGhMUWc0b0NVSU9xd21leWRnQ0RzaExqc2haanNuWVFnN0pPdzY1Q1lMQ0RzbmJUcnNvZ2c3WVMwNjZlTUlPeTJsT3l5bkNEdG1KWHNpNTBvU2xOUFRpRHJzTERzbDdRcElPdU1nT3lMb0NEcnNvanNsNjBnN1ppVjdJdWRLRXBUVDA0ZzZyQ2Q3TEswS2V5ZGhDRHNtcFRxdGF6dGxaenJpNlFLWm5WdVkzUnBiMjRnWVhOclZISmhibk5zWVhSbEtIUmxlSFFzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLU0I3Q2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdLQW9nSUNBZ0oreWR0T3V5aUNEc21wVHNzcTNzbllBZzY3S0k3SmV0SU95ZWtleVhoZXlkdE91THBDQW82Nnk0NnJXc0lPdUxwT3VUck9xNHNDRHNsWVRyaTVnZzRvQ1VJT3VNZ095VmlDQXo2ckNjSU9xM25PeTVtZXlkZ0NEc25iVHJzb2dnN1lTMDdKZVFJT3lnZ2V5YXFlMlZtT3luZ0NEc2xZcnJpcFRyaTZRcExpQW5JQ3NLSUNBZ0lDZnJpNlRzbll3Z1ZVa2c2Nnk0NnJXczZyQ0FJTzJWbk9xMXJleVd0T3VwdENEc25wRHNsN0RzaXFUcm42enNtclFnN0ppQjdKYTA2NkdjTENEc21JSHNsclRycWJRZzdKNlE3SmV3N0lxazY1K3M3SnEwSU8yVm5PcTFyZXlXdE91aG5DRHJzb2pzbDYzdGxaanJuYnd1SUNjZ0t3b2dJQ0FnSjFWSklPdXN1T3Exck91THBPeWF0Q0Rxc0lUcXNyRHRsWndnN1pHYzdaaUU3SjJFSU95VHNPcXpvQ3dnN0oyMDY2YUV3cmZzaUt2c25wREN0K3VuaU95S3BPMkN1Y0szN1pTTTY2Q0k3SjIwN0lxazdabUE2NDJVNjRxVUlPcTN1T3VNZ091aG5DRHJzN1Rzb2JUdGxaenJpNlF1SUNjZ0t3b2dJQ0FnSit5YmtPdXN1T3lkbUNEc3BJUWc3SWlZNjZXOElPcTN1T3VNZ091aG5DRHNuS0RzcDREdGxaenJpNlFnNG9DVUlPeWJrT3VzdU95ZHRDRHRsWndnN0tTRTdKMjA2Nm0wSU91eWlPeVhyZXVQaENEdGxad2c3S1NFNjZHY0xDRHNwSVRyc0pUcXY0anNuWVFnN0o2RTdKMlk2NkdjSU95MmxPcXdnTzJWbU95bmdDRHNsWXJyaXBUcmk2UXVJQ2NnS3dvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1VnNnJpSTdLZUFPaUFuSUNzS0lDQWdJQ2Q3SW5SeVlXNXpiR0YwWldRaU9pQWk2N0tJN0pldDY2eTRJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKa2FYSmxZM1JwYjI0aU9pQWlhMi9paHBKbGJpRHJtSkRyaXBRZ1pXN2locEpyYnlKOU9pQW5JQ3NnU2xOUFRpNXpkSEpwYm1kcFpua29kR1Y0ZENrS0lDQXBMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdDbjBLQ2k4dklPdU1nTzJabE8yWWxTRHJyTGpxdGF3ZzdLQ2M3SjZSSU8yRXRDRGlnSlFnN0lLczdKcXA3SjZRNnJDQUlPeURnZTJacWV5ZGhDRHNoS1RycW9YdGxaanJxYlFnNjZlbDY1Mjk3SmVRSU91bm51dUtsQ0RyckxqcXRhenJwYndnNjZlTTY1T2s3SmEwN0tTQTY0dWtMZ292THlCdFpYTnpZV2RsY3pvZ1czdHliMnhsT2lkMWMyVnlKM3duWVhOemFYTjBZVzUwSnl3Z2RHVjRkSDFkSU95Z2hPeXl0Q0RyaklEdG1aVHJwYndnNjZlazY3S0lJT3V3bSt1S2xPdUxwQ2pyaTZUcnBxenJpcFFnNjZ5MDdJT0I3WU9jSU9LQWxBb3ZMeURzbTR6cnNJM3NsNFVnN0tlQTdJdWM2Nnk0N0oyWUlDTHNtcFRzc3Ezcms2VHNuWUFnN0lTYzY2R2NJT3VzdE9xMGdDSWc3S0NFN0tDYzY2VzhJT3luZ08yQ3BPcTRzQ0RzbklUdGxiUWc2NHlBN1ptVUlPdW5wZXVkdmV5ZGhDRHRoTFFnN0pXSTdKZVFJT3VxdmV1VmhTRHNpNlByaXBUcmk2UXBMZ3BtZFc1amRHbHZiaUJoYzJ0RGIyMXdiM05sS0cxbGMzTmhaMlZ6TENCdGIyUmxiQ3dnY21Wd1lYSnpaU2tnZXdvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJSHNLSUNBZ0lHTnZibk4wSUhSeVlXNXpZM0pwY0hRZ1BTQW9iV1Z6YzJGblpYTWdmSHdnVzEwcExtMWhjQ2dvYlNrZ1BUNEtJQ0FnSUNBZ0tHMHVjbTlzWlNBOVBUMGdKMkZ6YzJsemRHRnVkQ2NnUHlBbjdKYTA3SXVjN0lxazdZUzA3WXE0T2lBbklEb2dKK3lDck95YXFleWVrRG9nSnlrZ0t5QlRkSEpwYm1jb2JTNTBaWGgwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0F4TlRBd0tRb2dJQ0FnS1M1cWIybHVLQ2RjYmljcE93b2dJQ0FnY21WMGRYSnVJQ2dLSUNBZ0lDQWdKK3lkdE91eWlDRHNtcFRzc3Ezc25ZQWdJdXVNZ08yWmxPMllsU0RyckxqcXRhd2c3S0NjN0o2Ukl1eWR0T3VMcENBbzZyaXc3S0cwSU91c3VPcTFyQ0RyaTZUcms2enF1TEFnN0pXRTY0dVlJT0tBbENEc2xZVHJucGdnNjR5QTdabVU2ckNBSU95ZHRPdXlpQ0R0aExUc25aZ2c3S0NFN0xLMElPdW5wZXVkdmV5ZHRPdUxwQ2t1SUNjZ0t3b2dJQ0FnSUNBbjdJS3M3SnFwN0o2UTZyQ0FJTzJabE91cHRDRHNnNEh0bWFuQ3QrdW5wZXVkdmV5ZGhDRHNoS1RycW9YdGxaanJxYlFzSU95S3BPMkRnT3lkdkNEcXQ1enN1Wm5xczd3ZzdKaUk3SXVjSU8yR3BPeVhrQ0RycDU3cmlwUWdWVWtnNjZ5NDZyV3M2Nlc4SU91bmpPdVRwT3lXdENEc29KenNsWWp0bFpqcm5id3VYRzRuSUNzS0lDQWdJQ0FnSnkwZzY2ZWw2NTI5N0oyMElPdTJnT3loc2UyVm1PdXB0Q0R0anJqdGxaanFzb3dnNjVDWTY2eTg3SmEwNjUyOE9pRHNsclRybHFRZzdabVU2Nm0wd3JmcXVMRHJpcVhzblpnZzY2eTQ2cldzN0oyNDdLZUFMQ0RyazZUc2xyVHFzSWdnN0o2UTY2YXM2NHFVSU95V3RPdVVsT3lkdU95bmdDanRqSjNzbDRVZzdZT0E3SjIwN1l1QUwrdXp1T3VzdUMvcnNvVHRpcndzSU8yR29PeUtwTzJLdUN3ZzY3bUlJTzJabE91cHRDRHNsWWpyZ3JRc0lPdXdzT3VFaUNEcms3RXBMQ0RzbHJUcmxxUWc3SU9CN1ptcDdKMjQ3S2VBS095RXNlcXp0U0R0aHJYcnM3UXY3SmlrNjZXWUwrMlpsZXlkdUNEc21wVHNzcTB2N0pXSTY0SzBLU0Rxc0puc25ZQWc2cktETGlEcXZLMGc3WldFN0pxVTdaV2NJT3F5Zyt1bmpDRHFzNmpybmJ3ZzdaV2NJT3V5aU95WGtDRHN0WnpyaklBZ011cXduT3E1ak95bmdDd2c3S2VuNnJLTUxpRHNuYlRybFl3Z2MzVm5aMlZ6ZEdsdmJuUHJpcFFnNjdtSUlPdXdzT3lYdEM1Y2JpY2dLd29nSUNBZ0lDQW5MU0Rxc0pEc25iUWc3SmEwNjRxUUlPeWdsZXVQaENEc21LVHJxYlFnNjZ5NzZyaXc2NmVNSU8yVm1PeW5nQ0RycDRqcm5id2c0b0NVSU9xd2dPeWdsZXlkaENEc2hManNtckRxczZBZzdMU0k3SldJSUhOMVoyZGxjM1JwYjI1ejY2VzhJTzJWcU9xN21DRHJnclRycWJUc2hKd3NJSEpsY0d4NTdKZVFJT3F3Z095Z2xleWRoQ0Ryc0ozdG5vanFzNkFnNjZ5MDdKZUg3SjJFSU95VmpPdWdwT3lqdk91cHRDRHJqWlFnNjZlZTdMYWNJT3lJbUNEc25vanJpcFRzcDRBZzdaV2NJT3VzdU95ZXBleWN2T3VobkNEcmphZnJ0cG5zbDZ6cm5id283SmlJT2lBaTdabVY3SjI0SU8yTW5leVhoZXlkdE91ZHZPcXpvQ0Rxc0lEc29KWHRsb2pzbHJUc21wUWc0b0NVSU8yR29PeUtwTzJLdU91ZHZPdXB0Q0RzbFl6cm9LVHNvN3pzaExqc21wUWlLUzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHJyTGpxdGF6cnBid2c3S0NjN0pXSTdaV2dJT3VWa0NEc2hKenJvWndnN0tDUjZyZTg3SjIwSU91THBPdWx1Q0F5ZmpQcXNKd3VJT3F3Z1NEc29KenNsWWpzbDVRZzdKbWNJT3EzdU91Z2grcXlqQ0RzamJ6cmlwVHNwNEFnN0oyMDdKeWc2Nlc4SU91Mm1leWR1T3VMcEM1Y2JpY2dLd29nSUNBZ0lDQW5MU0RzZ3F6c21xbnNucERxc0lBZzdKYTQ2cmlKN1pXWTdLZUFJT3lWaXV5ZGdDRHF0YXpzc3JRZzdLQ1Y2N08wS095Z2hPMlpsT3V5aU8yWXVNSzNWVkpNd3JmcXVJanNsYUhDdCsyYW4reUltQ0RyazdFcDY2VzhJT3luZ095V3RPdUN0Q0RyaEtQc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2N0SU8yYmhPeUdqU0RzbXBUc3NxMG9JdXVObENEc3A2ZnFzb3dpTENBaTY3S0U3WXE4N0pxcDdKeTg2NkdjSWlEcms3RXA3SjIwNjZtMElPeW5nZXlnaENEc29KenNsWWpzbllRZzZyZTRJT3V3cWUyV3BleWN2T3VobkNEcXM2RHNzNUFnNjR1azdJdWNJT3lnbk95VmlPMlZtT3VkdkM1Y2JpY2dLd29nSUNBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU9xd25leXl0Q0R0bFpqcmdwanJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoU0RxdUlqc3A0QTZJQ2NnS3dvZ0lDQWdJQ0FuZXlKeVpYQnNlU0k2SUNMcmpJRHRtWlFnN0oyUjY0dTFJTzJWbk91UmtDRHJyTGpzbnFVZ0tPMlZ0T3lhbE95eXRDa2lMQ0FpYzNWbloyVnpkR2x2Ym5NaU9pQmJleUowWlhoMElqb2dJdXVzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0R0bFp3ZzY2eTQ3SjZsSW4xZGZWeHVYRzRuSUNzS0lDQWdJQ0FnSjF2cmpJRHRtWlJkWEc0bklDc2dkSEpoYm5OamNtbHdkQW9nSUNBZ0tUc0tJQ0I5TENCdGIyUmxiQ3dnY21Wd1lYSnpaU2s3Q24wS0NpOHZJTzJVaE91Z2lPeWVoT3V6aENqdGxaanNuSVFnN1pTRTY2Q0k3SjZFSU91c3R1eWRqQ2tnN0xhVTdMS2NJTzJFdENEaWdKUWc3WldjSU8yWmxPdXB0T3lkaENEdGxaanNuSVFnN1pTRTY2Q0k3SjZFSU91THFPeWNoT3VobkNEcmdwanJpS0FnNjdPMDY0SzA2ck9nTEFvdkx5QXFLdTJVaE91Z2lPeWVoT3VuaU91THBDRHJsTERyb1p3cUtpRHJqSURzbFlqc25ZUWc2N0NiNjRxVTY0dWtMaUR0bFp3ZzdKcVU3TEt0N0plUUlPdUxwQ0RzaTZUc2xyUWc2N08wNjRLMDY0cVVJT3F5Zyt5ZHRDRHRsYlhzaTZ3NkNpOHZJTzJVaE91Z2lPeWVoQ0RzaUpqcnA0enRnYndnN0pxVTdMS3Q3SjJFSU95cXZPcXduT3VwdENEcXQ3anJwNHp0Z2J3ZzY0cVE2NkNrN0tlQTZyT2dLT3F3Z1NBMWZqRXc3TFNJS1NEcXRhenJqNFVnN0lLczdKcXA2NStKNjQrRUlPcTN1T3Vuak8yQnZDRHJncGpxc0lUcmk2UXVDaTh2SUdkeWIzVndjem9nVzN0dVlXMWxMQ0IwWlhoMGN6cGJYWDFkSUNqdG1aVHJxYlFnN0p5RTRvYVM3SldFNjU2WUlPeUluQ2t1Q21aMWJtTjBhVzl1SUdGemEwZHliM1Z3Y3lobmNtOTFjSE1zSUcxdlpHVnNMQ0J5WlhCaGNuTmxMQ0J0YjNKbEtTQjdDaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3b2dJQ0FnTHk4ZzY3S0U3WXE4SU95WWdleVhyZXlkZ0NBbzY3S0U3WXE4S2V5Y3ZPdWhuQ0Rzc0kzc2xyUWc2N08wNjRLNDY0dWtJT0tBbENEcnNvVHRpcndnNjZ5NDZyV3M2NHFVSU91c3VPeWVwZXlkdENEc2xZVHJpNGpybmJ3ZzY0K1o3SjZSSU95ZHRPdW1oT3lkdE91ZHZDRHF0NXpzdVpuc25iUWc2NHVrNjZXMDY0dWtDaUFnSUNCamIyNXpkQ0JzYVhOMElEMGdLR2R5YjNWd2N5QjhmQ0JiWFNrdWJXRndLQ2huTENCcEtTQTlQZ29nSUNBZ0lDQW5XeWNnS3lBb2FTQXJJREVwSUNzZ0oxMGdKeUFySUZOMGNtbHVaeWdvWnlBbUppQm5MbTVoYldVcElIeDhJQ2duNnJlNDY2TzVKeUFySUNocElDc2dNU2twS1NBcklDaG5JQ1ltSUdjdWNtOXNaU0E5UFQwZ0ordXloTzJLdkNjZ1B5QW5JQ2pyc29UdGlyd3BKeUE2SUNjbktTQXJJQ2RjYmljZ0t3b2dJQ0FnSUNBb1p5QW1KaUJCY25KaGVTNXBjMEZ5Y21GNUtHY3VkR1Y0ZEhNcElEOGdaeTUwWlhoMGN5QTZJRnRkS1M1dFlYQW9LSFFwSUQwK0lDY2dJQzBnSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0ZOMGNtbHVaeWgwSUh4OElDY25LU2twTG1wdmFXNG9KMXh1SnlrS0lDQWdJQ2t1YW05cGJpZ25YRzRuS1RzS0lDQWdJR052Ym5OMElHaGhjMEowYmlBOUlDaG5jbTkxY0hNZ2ZId2dXMTBwTG5OdmJXVW9LR2NwSUQwK0lHY2dKaVlnWnk1eWIyeGxJRDA5UFNBbjY3S0U3WXE4SnlrN0NpQWdJQ0JqYjI1emRDQnJaWGtnUFNBblozSnZkWEJ6SnlBcklDaG5jbTkxY0hNZ2ZId2dXMTBwTG0xaGNDZ29aeWtnUFQ0Z0tHY2dKaVlnWnk1MFpYaDBjeUEvSUdjdWRHVjRkSE11YW05cGJpZ25KeWtnT2lBbkp5a3BMbXB2YVc0b0p5Y3BPd29nSUNBZ1kyOXVjM1FnWVhSMFpXMXdkQ0E5SUNoaGMydGxaRU52ZFc1MExtZGxkQ2hyWlhrcElIeDhJREFwSUNzZ01Uc0tJQ0FnSUdGemEyVmtRMjkxYm5RdWMyVjBLR3RsZVN3Z1lYUjBaVzF3ZENrN0NpQWdJQ0JwWmlBb1lYTnJaV1JEYjNWdWRDNXphWHBsSUQ0Z01qQXdLU0JoYzJ0bFpFTnZkVzUwTG1Oc1pXRnlLQ2s3Q2lBZ0lDQmpiMjV6ZENCaFoyRnBiaUE5SUcxdmNtVWdmSHdnWVhSMFpXMXdkQ0ErSURFS0lDQWdJQ0FnUHlBbjdKMjBJTzJabE91cHRPeWRnQ0RzbmJRZzdJUzQ3SVdZN0plUTdJU2NJT3lkdE91dnVDRHJpNlRycEpqcmk2UXVJT3lWbnV5RW5DRHJncmdnNjR5QTdKV0k2ck84SU95V3RPMmNtTUszNnJXczdLR3c2ckNBSU8yWmxleUxwTzJlaUNEcmk2VHJwYmdnN0lPSUlPdU1nT3lWaU91bmpDRHJnclRybmJ3dVhHNG5DaUFnSUNBZ0lEb2dKeWM3Q2lBZ0lDQnlaWFIxY200Z0tBb2dJQ0FnSUNCaFoyRnBiaUFyQ2lBZ0lDQWdJQ2ZzbmJUcnNvZ2c3SnFVN0xLdDdKMkFJQ0x0bVpUcnFiVHNuWVFnN1pXWTdKeUVJTzJVaE91Z2lPeWVoT3V6aE91aG5DRHJncGpyaUtBZzY0dWs2NU9zNnJpd0l1dUxwQzRnN0pXRTY1Nlk2NHFVSU8yVm5DRHRtWlRycWJUc25aZ2c2Nnk0NnJXczY2VzhJTzJWbU95Y2hDRHRsSVRyb0lqc25vUW83SmlCN0pldEtTRHJpNmpzbklUcm9ad2c2NnkyN0oyQUlPcXlnK3lkdE91THBDNWNiaWNnS3dvZ0lDQWdJQ0FuS2lyc21JSHNsNjNycDRqcmk2UWc2NVN3NjZHY0tpb2c2NHlBN0pXSTdKMkVJT3VDdE91ZHZDRGlnSlFnN0ppQjdKZXQ3SjJFSU95RW5PdWhuQ0R0bGFuc3VaanFzYkRyZ3BnZzdJaWM3SVNjNjZXOElPdXdsT3ErdU95bmdDRHJwNGpybmJ3dVhHNG5JQ3NLSUNBZ0lDQWdKeTBnNnJDQklPeVlnZXlYcmV5WGtDRHJqSURzbFlnZ011cXduQzRnNnJlNElPeVlnZXlYcmV5ZHRDRHNsNnpybjZ3ZzdLU0U3SjIwNjZtMElPdU1nT3lWaU91UGhDQXFLdXF3bWV5ZGdDRHNwSVFnN0lpWUtpcnJvWndvN0tTRTY3Q1U2citJSUZ4Y2J1eWN2T3VobkNEcXRhenJ0b1FzSU95a2hDRHNpSnpzaEp3ZzdKeWc3S2VBS1M1Y2JpY2dLd29nSUNBZ0lDQW5MU0RzbUlIc2w2M3NuWmdnN0pldDdaV2dLTzJEZ095ZHRPMkxnTUszN0pXSTY0SzB3cmZyc29UdGlyd2c2NU94S2VxenZDRHNtNURyckxqc25aZ2c3S0NWNjdPMHdyZnNvYkRxc2JRbzdJaXI3SjZRd3JmcmpJRHNnNEhDdCt5aHNPcXh0Q25zbllBZzdKeWc3S2VBN1pXWTZyT2dMQ0RzbDRicmlwUWc3S0NWNjdPMDY2VzhJT3luZ095V3RPdUN0T3luZ0NEcnA0anJuYnd1WEc0bklDc0tJQ0FnSUNBZ0p5MGc2ck9nN0xtZ0lPcXlqQ0RzbDRicmlwUWc3SmlCN0pldDdKMjA2Nm0wSU91TWdPeVZpQ0F4NnJDYzY2ZU1JT3VDdE9xeHNPdUNtQ0RydVlnZzY3Q3c3SmUwNjZHY0lPdVJrT3lXdE91UGhDRHJrSnpyaTZRZzRvQ1VJT3lXdGV5bmdPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhMbHh1SnlBckNpQWdJQ0FnSUNjdElPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRnQ0RxdDdqcmpJRHJvWndnNjVHVTY0dWtMbHh1SnlBckNpQWdJQ0FnSUNob1lYTkNkRzRnUHlBbkxTQW82N0tFN1lxOEtleWN2T3VobkNEdGtaenNpNXpya0p3ZzdKaUI3SmV0N0oyQUlDY2dLeUJDVlZSVVQwNWZVbFZNUlNBNklDY25LU0FyQ2lBZ0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzZyQ2Q3TEswSU8yVm1PdUNtT3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUxwT3lhdE1LMzdJU2s2NnFGd3Jmc3ZaVHJrNXp0anB6c2lxUWc2cmlJN0tlQU9seHVKeUFyQ2lBZ0lDQWdJQ2Q3SW1keWIzVndjeUk2SUZ0N0ltNWhiV1VpT2lBaTdKaUI3SmV0SU95ZHRPdW1oQ2pzbm9Ycm9LWHFzN3dnNjQrWjdKMjhLU0lzSUNKemRXZG5aWE4wYVc5dWN5STZJRnQ3SW5SbGVIUWlPaUFpNjR5QTdKV0lJT3VzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0R0bFp3ZzY2eTQ3SjZsSW4xZGZWMTlYRzRuSUNzS0lDQWdJQ0FnSit5WWdleVhyZXlkZ0NEc25vWHJvS1VnN0lpYzdJU2N3cmZxc0p6c2lKanJwYndnNnJlNDY0eUE2NkdjSU95bmdPMkNxT3VMcEM1Y2JseHVKeUFyQ2lBZ0lDQWdJQ2RiN0ppQjdKZXQ2N09FSU91c3VPcTFyRjFjYmljZ0t5QnNhWE4wQ2lBZ0lDQXBPd29nSUgwc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzS2ZRb0tMeThnN1pTRTY2Q0k3SjZFNjdPRUlPeTJsT3l5bkNEc25aSHJpN1hzbDVEc2hKd2dXM3R1WVcxbExDQnpkV2RuWlhOMGFXOXVjenBiZTNSbGVIUXNJSEpsWVhOdmJuMWRmVjBnN0xhVTdMYWNDbVoxYm1OMGFXOXVJSEJoY25ObFIzSnZkWEJ6S0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdieUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCamIyNXpkQ0JoY25JZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTVuY205MWNITXBJRDhnYnk1bmNtOTFjSE1nT2lCYlhUc0tJQ0FnSUdOdmJuTjBJR2R5YjNWd2N5QTlJR0Z5Y2k1dFlYQW9LR2NwSUQwK0lDaDdDaUFnSUNBZ0lHNWhiV1U2SUZOMGNtbHVaeWdvWnlBbUppQm5MbTVoYldVcElIeDhJQ2NuS1M1MGNtbHRLQ2tzQ2lBZ0lDQWdJSE4xWjJkbGMzUnBiMjV6T2lCQmNuSmhlUzVwYzBGeWNtRjVLR2NnSmlZZ1p5NXpkV2RuWlhOMGFXOXVjeWtLSUNBZ0lDQWdJQ0EvSUdjdWMzVm5aMlZ6ZEdsdmJuTUtJQ0FnSUNBZ0lDQWdJQ0FnTG0xaGNDZ29lQ2tnUFQ0Z0tIUjVjR1Z2WmlCNElEMDlQU0FuYzNSeWFXNW5Kd29nSUNBZ0lDQWdJQ0FnSUNBZ0lEOGdleUIwWlhoME9pQjRMblJ5YVcwb0tTd2djbVZoYzI5dU9pQW5KeUI5Q2lBZ0lDQWdJQ0FnSUNBZ0lDQWdPaUI3SUhSbGVIUTZJRk4wY21sdVp5Z29lQ0FtSmlCNExuUmxlSFFwSUh4OElDY25LUzUwY21sdEtDa3NJSEpsWVhOdmJqb2dVM1J5YVc1bktDaDRJQ1ltSUhndWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1FvZ0lDQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaDRLU0E5UGlCNExuUmxlSFFwQ2lBZ0lDQWdJQ0FnT2lCYlhTd0tJQ0FnSUgwcEtUc0tJQ0FnSUM4dklPeWR0T3VtaE95aHNPeXdxQ0RzbDRicXM2QWc3S0NjN0pXSTY0K0VJT3lYaHV1S2xDRHF1NDNyamJEcXVMRHJwNHdnN0ptVTdKeTg2Nm0wSU8yWWxleUxuU0RzbmJUdGc0anJvWndnNjdPNDY0dWtLT3F3bWV5ZGdDRHNoTGpzaFpqc2w1QWc3SjZzN0pxVTdMS3RLUW9nSUNBZ2NtVjBkWEp1SUdkeWIzVndjeTV6YjIxbEtDaG5LU0E5UGlCbkxuTjFaMmRsYzNScGIyNXpMbXhsYm1kMGFDa2dQeUJuY205MWNITWdPaUJ1ZFd4c093b2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0NpQWdJQ0J5WlhSMWNtNGdiblZzYkRzS0lDQjlDbjBLQ2k4dklPMk1uZXlYaFNEc2hManRpcmdnN0xhVTdMS2NJTzJFdENEaWdKUWc3WldjSU8yTW5leVhoZXlkbUNEcXRhenNoTEhzbXBUc2hvd283SmV0N1pXZ0srdXN1T3ExckNucnBid2c3WldjSU91eWlPeVhrQ0RyczdUcmdyVHFzNkFzQ2k4dklPeWFsT3lHak91emhDRHJnckhxc0p6cXNJQWc3SldFNjR1STY1MjhJQ29xN0ptRTdJU3g2NUNjSU8yTW5leVhoU0RzaExqdGlyZ283THlBN0oyMDdJcWtLU0F5ZmpQcXNKd3FLdXVsdkNEdGhyWHNuTHpyb1p3ZzY3Q2I2NHFVNjR1a0xnb3ZMeUR0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcTg3SjIwSU8yVm5DRHJxcmpzbkx6cm9ad2c3SjI4NnJTQTY0Kzg3Slc4SU8yVm1PdXZnT3VobkNqcmxMRHJvWndnNjcyUjdKV0VJT3loc08yVnFlMlZtT3VwdENEc2xyVHF1SXZyZ3B6cmk2UXBJT3lFdU8yS3VDRHJpNmpzbklUcm9ad2c3S0NjN0pXSTdaV1k2cktNSU8yVm5PdUxwQzRLTHk4Z1pXeGxiV1Z1ZEhNNklGdDdjbTlzWlN3Z2RHVjRkSDFkSUNqdG1aVHJxYlFnN0p5RTRvYVM3SldFNjU2WUlPeUluQ2t1Q2k4dklHMXZjbVU5ZEhKMVpTaGI3THlBN0oyMDdJcWtJT3VObENEcnNKdnF1TEJkS2V1cHRDRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3V2dUNEcmdyZ2c3SVM0N1lxNDdKbUFJT3F5dWV5NW1PeW5nQ0RzbFlycmlwUWc3SU9JSU95RXVPMkt1T3VsdkNEc21wVHF0YXp0bFp6cmk2UXVDbVoxYm1OMGFXOXVJR0Z6YTFCdmNIVndLR1ZzWlcxbGJuUnpMQ0J0YjJSbGJDd2djbVZ3WVhKelpTd2diVzl5WlNrZ2V3b2dJSEpsZEhWeWJpQnlkVzVVZFhKdUtDZ3BJRDArSUhzS0lDQWdJR052Ym5OMElISnZiR1Z6SUQwZ0tHVnNaVzFsYm5SeklIeDhJRnRkS1M1dFlYQW9LR1VwSUQwK0lGTjBjbWx1Wnlnb1pTQW1KaUJsTG5KdmJHVXBJSHg4SUNjbktTa3VhbTlwYmlnbkxDQW5LVHNLSUNBZ0lHTnZibk4wSUd4cGMzUWdQU0FvWld4bGJXVnVkSE1nZkh3Z1cxMHBMbTFoY0Nnb1pTd2dhU2tnUFQ0S0lDQWdJQ0FnS0drZ0t5QXhLU0FySUNjdUlGc25JQ3NnVTNSeWFXNW5LQ2hsSUNZbUlHVXVjbTlzWlNrZ2ZId2dKeWNwSUNzZ0oxMGdKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLRk4wY21sdVp5Z29aU0FtSmlCbExuUmxlSFFwSUh4OElDY25LU2tLSUNBZ0lDa3VhbTlwYmlnblhHNG5LVHNLSUNBZ0lDOHZJT3F3bWV5ZGdDRHRqSjNzbDRYc25ZUWc2NnFISU91eWlPeW51Q0Ryckx2cmlwVHNwNEFnNnJpdzdKYTFJT0tBbENEc25xenNtcFRzc3Ezc25iVHJxYlFnSXV5ZHRPeWdoT3F6dkNEcmk2VHJwYmdnN0lTNDdZcTRJdXVsdkNEc21wVHF0YXp0bFp6cmk2UUtJQ0FnSUM4dklDaGhjMnREYkdGMVpHWHNtWUFnNnJDWjdKMkFJT3lkdE95Y29Eb2c3SldJSU9xM3VPdWZyT3VwdENEdGdiVHJvWnpyazV6cXNJQWc2ckNaN0oyQUlPeUV1TzJLdU91bHZDRHJtSkFnNjRLMDdJU2NJRnZzdklEc25iVHNpcVFnNjQyVUlPdXdtK3E0c0YzcXNJQWc2NnkwN0oyWTY2KzQ3WlcwN0tlRTY0dWtLUW9nSUNBZ1kyOXVjM1FnYTJWNUlEMGdKM0J2Y0hWd0FTY2dLeUFvWld4bGJXVnVkSE1nZkh3Z1cxMHBMbTFoY0Nnb1pTa2dQVDRnVTNSeWFXNW5LQ2hsSUNZbUlHVXVkR1Y0ZENrZ2ZId2dKeWNwS1M1cWIybHVLQ2NCSnlrN0NpQWdJQ0JqYjI1emRDQmhkSFJsYlhCMElEMGdLR0Z6YTJWa1EyOTFiblF1WjJWMEtHdGxlU2tnZkh3Z01Da2dLeUF4T3dvZ0lDQWdZWE5yWldSRGIzVnVkQzV6WlhRb2EyVjVMQ0JoZEhSbGJYQjBLVHNLSUNBZ0lHbG1JQ2hoYzJ0bFpFTnZkVzUwTG5OcGVtVWdQaUF5TURBcElHRnphMlZrUTI5MWJuUXVZMnhsWVhJb0tUc2dMeThnNjZ5MDdaV2M3WjZJSU95TWsreWR0T3luZ0NEc2xZcnFzb3dLSUNBZ0lHTnZibk4wSUdGbllXbHVJRDBnYlc5eVpTQjhmQ0JoZEhSbGJYQjBJRDRnTVFvZ0lDQWdJQ0EvSUNmc25iUWc3WXlkN0plRjdKMkFJT3lkdENEc2hManNoWmpzbDVEc2hKd2c3SjIwNjYrNElPdUxwT3VrbU91THBDNGc3SldlN0lTY0lPeWduT3lWaU8yVm5DRHNoTGp0aXJqcms2VHFzN3dnS2lyc29KSHF0N3pDdCt5V3RPMmNtT3F3Z0NEdG1aWHNpNlR0bm9nZzY0dWs2Nlc0SU95RGlDRHNoTGp0aXJncUt1dW5qQ0RyZ3JUcm5id282ckNaN0oyQUlPeUV1TzJLdUNEcnNKanJzN1VnNnJpSTdLZUFLUzVjYmljS0lDQWdJQ0FnT2lBbkp6c0tJQ0FnSUhKbGRIVnliaUFvQ2lBZ0lDQWdJR0ZuWVdsdUlDc0tJQ0FnSUNBZ0oreWR0T3V5aUNEc21wVHNzcTNzbllBZ0l1Mk1uZXlYaFNqcmk2VHNuYlRzbHJ6cm9aenF0N2dwSU95RXVPMkt1Q0RyaTZUcms2enF1TEFpNjR1a0xpRHNsWVRybnBqcmlwUWc3WldjSU8yTW5leVhoZXlkaENEc25JVGlocExzbFlUcm5wanJvWndnNjRLWTdKZTA3WldjSU9xMXJPeUVzZXlhbE95R2pPdVRwT3lkdE91THBDanNoSnpyb1p3ZzY2eTA2clNBN1pXY0lPdXpoT3F3bkNEcnJManF0YXpxc0lBZzdKV0U2NHVJNjR1a0tTNGdKeUFyQ2lBZ0lDQWdJQ2ZzbXBUc2hvenJwYndnNjRLeDZyQ2M2NkdjSU9xem9PeTVtT3luZ0NEcnA1RHFzNkFzSUNvcTdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdk95ZHRDRHNoSnpyb1p3ZzdKMjg2clNBNjVDY0lDTHNtWVRzaExIcmtKd2c3WXlkN0plRklPeUV1TzJLdUNJZ01uNHo2ckNjS2lycnBid2c3S0NjN0pXSTdaV1k2NTI4TGlEcXNJRWc3SVM0N1lxNDY0cVVJT3lFbk91aG5DRHJpNlRycGJnZzdLQ1I2cmU4N0oyMDdKYTA3Slc4SU8yVm5PdUxwQzVjYmljZ0t3b2dJQ0FnSUNBbjZyQ0JJT3lFdU8yS3VPdUtsQ0Rzbm9Ycm9LWHFzN3dnS2lycXNKbnNuWUFnN0pldDdaV2d3cmZxc0puc25ZQWc2ckNjN0lpWXdyZnFzSm5zbllBZzdJaWM3SVNjS2lyc25aZ2c3SnFVN0lhTTY2VzhJT3VxcU91UmtDRHRqNnp0bGFqdGxaenJpNlF1SU95RXVPMkt1Q0RzbFlqc2w1RHNoSndnN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2T3lkZ0NEdGxad2c2NnE0N0p5ODY2R2NJT3VubnV5VmhPdVdxT3lXdE95Z3VPeVZ2Q0R0bFp6cmk2UW83SmlJT2lEcnM3anJyTGpzbmJRZ0luN3RsYURxdVl6c21wUS9JdXVwdENEcnNvVHRpcnpzbllBZ1creVZoT3VMaU95WXBGMHZXK3VFcEYwcExseHVKeUFyQ2lBZ0lDQWdJQ2RiN1l5ZDdKZUZJT3VzdU95eXRDRHF0NXpzdVprZzRvQ1VJT3ljaENEc2lxVHRnNERzbmJ3ZzZyQ0E3SjIwNjVPYzdKMllJQ0k0TGlEdGpKM3NsNFVpSU95RXVleUZtT3lkaENEcmxMRHJwYmpyaTZSZFhHNG5JQ3NLSUNBZ0lDQWdKeTBnN1lPQTdKMjA3WXVBT2lEc3A2ZnNuWUFnNjZxRjdJS3M2cldzS0RKK05PeVd0T3lnaUNrc0lPeWloZXF5c095V3RPdXZ1TUszNjZlSTdMbW83WkdjSU95WGh1eWR0Q2grN0pxVUwzN3JpNlF2ZnVxNWpPeWFsRDhnNnJpSTdLZUFLUzRnNjdDWTY1T2M3SXVjSU95VmlPdUN0Q2pyczdqcnJMZ3BJT3VucGV1ZHZleWRoQ0RzbXBUc2xiM3RsYlFnN1lPQTdKMjA3WXVBNjZlTUlPdTBrT3VQaENEcnJMVHNpcWdnN1l5ZDdKZUY3SjI0N0tlQUlPeVZqT3F5akNEdGxaanJuYnd1SU95YmtPdXp1T3lkdENBaTdKV002NmE4TCsyWmxleWR1Q0xzc3Bqcm43d2c2NmVKN0pldzdaV1k2Nm0wSU91enVPdXN1T3lkaENEcXQ3enFzYkRyb1p3ZzZyV3M3TEswN1ptVTdaV1k2NTI4TGx4dUp5QXJDaUFnSUNBZ0lDY3RJT3lWaU91Q3RDanJzN2pyckxncE9pRHRsYlRzbXBUc3NyUXVJTzJNa091THFPeWR0Q0R0bFlUc21wVHRsWmpycWJRZ0luN3RsYURxdVl6c21wUS9JdXVobkNEcnJMdnFzNkFzSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPeWNoTzJYbUNqc2dxM3NvSnpDdCsyRGlPMkh0Q0RyazdFcDdKMkFJT3F5c09xenZPdWx2Q0RycUx6c29JQWc2cks5NnJPZzdaV2M2NHVrTGlEcXNyRHFzN3pDdCt5RGdlMkRuQ0R0aHJYcnM3VHJxYlFnN0lTYzdJaWc3WmlWN0p5ODY2R2NJT3lWak91bXNPdUxwQzVjYmljZ0t3b2dJQ0FnSUNBbkxTRHJzb1R0aXJ3NklPdXp1T3VzdU95ZHRDQWlmdTJWb09xNWpPeWFsRDhpNjZtMElGdnNsWVRyaTRqc21LUmRMMXZyaEtSZExDRHJzN2pyckxqc25iUWc3SU9CN1ptcDdKMkVJT3lFbk95SW9PMlZtT3F6b0NEc25iUWc2N0tFN1lxODdKMjBJT3lMcE95Z25DRHJqNW5zbnBIc25iVHJxYlFnNjQrWjdKNlJJT3VQbWV5Q3JDanNncTNzb0p3djdLQ0E3SjZsTCt5WHNPcXlzQ0R0bGJUc29Kd2c2NU94S1N3ZzdZYTE2N08wSU8yTW5leVhoZXlkbUNEcmk2anNuYndnNjdLRTdZcTg3SjIwNjZtMElDTHRtWlhzbmJnaUxpQWk3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3c0lDTHJpNnZxdUxEQ3QrdVBtZXlla1NJZzdLR3c3WldwSU9xNGlPeW5nQzRnN1ptVTY2bTBJT3E0c091S3BldXFoU2pyczREcXNyM0N0KzJWdE95Z25DRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWlRyaTZRdVhHNG5JQ3NLSUNBZ0lDQWdKeTBnN0p1UTY2eTQ3SjJZSU95Z2xldXp0TUszN0tHdzZyRzBLT3lJcSt5ZWtNSzM3SjIwN0lPQkwreWR0TzJWbU1LMzY0eUE3SU9CS2V5ZGdDRHNuS0RzcDREdGxaanFzNkFzSU95YmtPdXN1T3lYa0NEc2w0YnJpcFFnN0tDVjY3TzB3cmZzb0lqc3NLakN0K3lYc091ZHZleXltT3VsdkNEc3A0RHNsclRyZ3JUc3A0QWc2NmVJNjUyOExseHVKeUFyQ2lBZ0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzZyQ2Q3TEswSU8yVm1PdUNtT3VuakNEc3RwenJvS1h0bFp6cmk2UXVJT3VuaU8yQnJPdUxwT3lhdE1LMzdJU2s2NnFGd3Jmc3ZaVHJrNXp0anB6c2lxUWc2cmlJN0tlQU9seHVKeUFyQ2lBZ0lDQWdJQ2Q3SW5ObGRITWlPaUJiZXlKeVpXRnpiMjRpT2lBaTdKMjBJT3lFdU8yS3VPeWRtQ0Ryc0tudGxxWHNuWVFnN1pXYzZyV3Q3SmEwSU8yVm5DRHJyTGpzbnFYc25MenJvWndpTENBaVpXeGxiV1Z1ZEhNaU9pQmJleUp5YjJ4bElqb2dJdXlYcmUyVm9DSXNJQ0owWlhoMElqb2dJdXVzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lmU3dnTGk0dVhYMHNJQzR1TGwxOVhHNG5JQ3NLSUNBZ0lDQWdKK3lYcmUyVm9PeWRnQ0Rzbm9Ycm9LVWc3SWljN0lTYzY0eUE2NkdjT2lBbklDc2djbTlzWlhNZ0t5QW5YRzVjYmljZ0t3b2dJQ0FnSUNBblcrMk1uZXlYaFNEc21wVHNob3hkWEc0bklDc2diR2x6ZEFvZ0lDQWdLVHNLSUNCOUxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0NuMEtDaTh2SU8yTW5leVhoU0RzblpIcmk3WHNsNURzaEp3Z2UzTmxkSE02SUZ0N2NtVmhjMjl1TENCbGJHVnRaVzUwY3pwYmUzSnZiR1VzZEdWNGRIMWRmVjE5SU95MmxPeTJuQ0FvN0wyVTY1T2M3WTZjN0lxa3dyZnNsWjdya3FRZzdKNmg2NHUwSU8yWGlPeWFxU2tLWm5WdVkzUnBiMjRnY0dGeWMyVlFiM0IxY0NoeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJRzhnUFNCS1UwOU9MbkJoY25ObEtITXBPd29nSUNBZ1kyOXVjM1FnYzJWMGMwbHVJRDBnUVhKeVlYa3VhWE5CY25KaGVTaHZJQ1ltSUc4dWMyVjBjeWtnUHlCdkxuTmxkSE1nT2lCYlhUc0tJQ0FnSUdOdmJuTjBJSE5sZEhNZ1BTQnpaWFJ6U1c0S0lDQWdJQ0FnTG0xaGNDZ29jM1FwSUQwK0lDaDdDaUFnSUNBZ0lDQWdjbVZoYzI5dU9pQlRkSEpwYm1jb0tITjBJQ1ltSUhOMExuSmxZWE52YmlrZ2ZId2dKeWNwTG5SeWFXMG9LU3dLSUNBZ0lDQWdJQ0JsYkdWdFpXNTBjem9nUVhKeVlYa3VhWE5CY25KaGVTaHpkQ0FtSmlCemRDNWxiR1Z0Wlc1MGN5a0tJQ0FnSUNBZ0lDQWdJRDhnYzNRdVpXeGxiV1Z1ZEhNS0lDQWdJQ0FnSUNBZ0lDQWdJQ0F1YldGd0tDaGxiQ2tnUFQ0Z0tIc2djbTlzWlRvZ1UzUnlhVzVuS0NobGJDQW1KaUJsYkM1eWIyeGxLU0I4ZkNBbkp5a3VkSEpwYlNncExDQjBaWGgwT2lCVGRISnBibWNvS0dWc0lDWW1JR1ZzTG5SbGVIUXBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZTa3BDaUFnSUNBZ0lDQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb1pXd3BJRDArSUdWc0xuUmxlSFFwQ2lBZ0lDQWdJQ0FnSUNBNklGdGRMQW9nSUNBZ0lDQjlLU2tLSUNBZ0lDQWdMbVpwYkhSbGNpZ29jM1FwSUQwK0lITjBMbVZzWlcxbGJuUnpMbXhsYm1kMGFDazdDaUFnSUNCeVpYUjFjbTRnYzJWMGN5NXNaVzVuZEdnZ1B5QnpaWFJ6SURvZ2JuVnNiRHNLSUNCOUlHTmhkR05vSUNoZlpTa2dld29nSUNBZ2NtVjBkWEp1SUc1MWJHdzdDaUFnZlFwOUNnb3ZMeURyaklEdG1aVHRtSlVnN0tDYzdKNlJJT3lka2V1THRleVhrT3lFbkNCN2NtVndiSGtzSUhOMVoyZGxjM1JwYjI1elcxMTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa0tablZ1WTNScGIyNGdjR0Z5YzJWRGIyMXdiM05sS0hKaGR5a2dld29nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93b2dJR052Ym5OMElHMGdQU0J6TG0xaGRHTm9LQzljZTF0Y2MxeFRYU3BjZlM4cE93b2dJR2xtSUNodEtTQnpJRDBnYlZzd1hUc0tJQ0IwY25rZ2V3b2dJQ0FnWTI5dWMzUWdieUE5SUVwVFQwNHVjR0Z5YzJVb2N5azdDaUFnSUNCamIyNXpkQ0J5WlhCc2VTQTlJRk4wY21sdVp5Z29ieUFtSmlCdkxuSmxjR3g1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BPd29nSUNBZ1kyOXVjM1FnYzNWbloyVnpkR2x2Ym5NZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTV6ZFdkblpYTjBhVzl1Y3lrS0lDQWdJQ0FnUHlCdkxuTjFaMmRsYzNScGIyNXpDaUFnSUNBZ0lDQWdJQ0F1YldGd0tDaDRLU0E5UGlBb2V5QjBaWGgwT2lCVGRISnBibWNvS0hnZ0ppWWdlQzUwWlhoMEtTQjhmQ0FuSnlrdWRISnBiU2dwTENCeVpXRnpiMjQ2SUZOMGNtbHVaeWdvZUNBbUppQjRMbkpsWVhOdmJpa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa0tJQ0FnSUNBZ0lDQWdJQzVtYVd4MFpYSW9LSGdwSUQwK0lIZ3VkR1Y0ZENrS0lDQWdJQ0FnT2lCYlhUc0tJQ0FnSUdsbUlDaHlaWEJzZVNCOGZDQnpkV2RuWlhOMGFXOXVjeTVzWlc1bmRHZ3BJSEpsZEhWeWJpQjdJSEpsY0d4NUxDQnpkV2RuWlhOMGFXOXVjeUI5T3dvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUc1MWJHdzdDbjBLQ2k4dklPdXlpT3lYclNEc25aSHJpN1hzbDVEc2hKd2dlM1J5WVc1emJHRjBaV1FzSUdScGNtVmpkR2x2Ym4wZzdMYVU3TGFjSUNqc3ZaVHJrNXp0anB6c2lxVEN0K3lWbnV1U3BDRHNucUhyaTdRZzdaZUk3SnFwS1FwbWRXNWpkR2x2YmlCd1lYSnpaVlJ5WVc1emJHRjBaU2h5WVhjcElIc0tJQ0JzWlhRZ2N5QTlJRk4wY21sdVp5aHlZWGNwTG5SeWFXMG9LUzV5WlhCc1lXTmxLQzllWUdCZ0tEODZhbk52YmlrL1hITXFMMmtzSUNjbktTNXlaWEJzWVdObEtDOWNjeXBnWUdBa0wya3NJQ2NuS1RzS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYSHRiWEhOY1UxMHFYSDB2S1RzS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0NpQWdkSEo1SUhzS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93b2dJQ0FnWTI5dWMzUWdkSEpoYm5Oc1lYUmxaQ0E5SUZOMGNtbHVaeWdvYnlBbUppQnZMblJ5WVc1emJHRjBaV1FwSUh4OElDY25LUzUwY21sdEtDazdDaUFnSUNCcFppQW9kSEpoYm5Oc1lYUmxaQ2tnY21WMGRYSnVJSHNnZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dU9pQlRkSEpwYm1jb0tHOGdKaVlnYnk1a2FYSmxZM1JwYjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlRzS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNsWVRybnBqcm9ad2dLaThnZlFvZ0lISmxkSFZ5YmlCdWRXeHNPd3A5Q2dvdkx5RHNuWkhyaTdYc2w1RHNoSndnZTNSbGVIUXNJSEpsWVhOdmJuMGc2N0N3N0plMElPeTJsT3kybkNBbzdMMlU2NU9jN1k2YzdJcWt3cmZzbFo3cmtxUWc3SjZoNjR1MElPMlhpT3lhcVNrS1puVnVZM1JwYjI0Z2NHRnljMlZUZFdkblpYTjBhVzl1Y3loeVlYY3BJSHNLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc0tJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEZ0YlhITmNVMTBxWEYwdktUc0tJQ0JwWmlBb2JTa2djeUE5SUcxYk1GMDdDaUFnZEhKNUlIc0tJQ0FnSUdOdmJuTjBJR0Z5Y2lBOUlFcFRUMDR1Y0dGeWMyVW9jeWs3Q2lBZ0lDQnBaaUFvUVhKeVlYa3VhWE5CY25KaGVTaGhjbklwS1NCN0NpQWdJQ0FnSUhKbGRIVnliaUJoY25JS0lDQWdJQ0FnSUNBdWJXRndLQ2g0S1NBOVBpQW9leUIwWlhoME9pQlRkSEpwYm1jb0tIZ2dKaVlnZUM1MFpYaDBLU0I4ZkNBbkp5a3VkSEpwYlNncExDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5KbFlYTnZiaWtnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tLSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOVBpQjRMblJsZUhRcE93b2dJQ0FnZlFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5Q2lBZ2NtVjBkWEp1SUZ0ZE93cDlDZ292THlEcm9aenF0N2pzbmJnZzdaV0U3SnFVd3JmdGxaenJqNFFnN0xTSTZyTzhJT3lEZ2UyRG5PeWR2Q0RybFl3Z0wyaGxZV3gwYUNEc29iRHRtb3pxc0lBZzdKaWs2Nm0wSU91U3BPeVhrT3lFbkNEc200enJzSTNzbDRYc25ZUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRPdXp1T3VMcENBb016RHN0SWpzbDVBZ01ldXlpT3VuakNrdUNpOHZJT3lFc2VxenRlMlZtT3VwdENEcXNyRHFzN3dnN1pXNDY1T2s2NStzNnJDQUlHTnNZWFZrWlZOMFlYUjFjejBuYjJzbjY2R2NJT3VRbU91UGpPdW1yT3V2Z091aG5Dd2c3SjZzNjZHYzZyZTQ3SjI0SU8yYmhDRHJzb1R0aXJ6c25iUWc3S0NBN0tDSTY2R2NJUENmbjZMc25MenJvWndnNjdPMTZyZUE3WldjNjR1a0xnb3ZMeUFvN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc3SmV3SU91U3BDRHNvN3pxdUxEc29JSHNuTHpyb1p3Z0wyaGxZV3gwYU91bHZDRHNvYkR0bW96dGxaanJpcFFnNnJLRDZyTzhJT3lubmV5ZGhDRHNuYlRybzZ6cmk2UXBDaTh2SU8yVm5PdVBoQ0RzdElqcXM3enJqNFFnNnJDWjdKMkFJT3F5dmV1aG5PdWhuQ0RyczdYcXQ0RHNpNXp0Z3Fqcmk2UWc0b0NVSU9xMGdPdW1yT3lla09xd2dDRHRsWnpyajRUcnBid2c3SmlzNjZDazdLTzg2ckd3NjRLWUlPMlZuT3VQaE9xd2dDRHN0SWpxdUxEdG1aVHJrSmpycWJRS0x5OGc3SUtzN0pxcDdKNlE2ckNBSU95VmhPdXN0T3F5Zyt1UGhDRHNsWWdnNjRpTTY1K3M2NCtFSU91eWhPMkt2T3lkdENEd241K2k3Snk4NjZHY0lPdVBqT3lWaE95WXFPdUxwQzRnN1pXYzY0K0U3SmVRSU9xeHVPdW1zQ0R0bUxqc3RwenNuWUFnNnJHdzdLQ0k2NUNZNjYrQTY2R2NJT3lDck95YXFldWZpZXlkZ0NEc2xZZ2c2NEtZNnJDRTY0dWtDaTh2SU9xemhPeWdsZXlkdENBcUt1dXdsdXlYa095RW5Db3FJT3V3bE91QWtDRHFzb1BzbllRZzdKV003SldFN0xHSTY0dWtJQ2d5TURJMkxUQTRMQ0JDVWtsRVIwVmZWajB5TmlrdUNpOHZJTzJFc091dnVPdUVrT3lkdE91Q21DRHJ1SXpybmJ6c21yRHNvSURzbDVEc2hKd2c2NHVrNjZXNElPcXpoT3lnbGV5Y3ZPdWhuQ0Ryb1p6cXQ3anNuYmp0bFpqcnFiUWc3SjZRNnJLcDdLYWQ2NnFGSU8yTWpPeWR2T3lkZ0NEcnNKVHJnSXpzcDREcnA0d3NJT3lkdE91dnVDRHJscUFnN0o2STY0cVVJR05zWVhWa1pRb3ZMeURzaExqc2haanNuWUFnN0l1YzY0K1o3WldnSU91VmpDRHJzSnZzbllBZzdKaWJJT3F6aE95Z2xTRHNub1hzbnFYcXRvenNuWVFnNnJlNDY0eUE2NkdjSU95VHRPdUxwQ0RpaHBJZzdJT0lJT3F6aE95Z2xleVhrQ0RzZ3F6c21xbnJuNG5zbmJRZzY0S283SldFSU95ZWlPeVd0T3VQaENBaTdaV2M2NCtFSU95MGlPcXp2Q0xxc0lBS0x5OGc2ck9FN0lhTklPdUNtT3lZcU91THBDZ3lNREkyTFRBNElPeUxwT3k0b1NEc2k2RHFzNkE2SUNMc2c0Z2c2ck9FN0tDVjdKeTg2NkdjSU91aG5PcTN1T3lkdU8yV2lPdUtsT3VOc0NEc21ad2c2cmU0SU9xemhPeWdsU0RzZ3F6c21xbnJuNG5zbllRZzY2cTdJT3lUc091RGtDSXBMZ292THlEdGxJenJuNnpxdDdqc25ianNuWVFnNnJHdzdMbWNJT3Vobk9xM3VPeWR1TUszNjZHYzZyZTQ3SldFN0p1REtDOXZjR1Z1TFd4dloybHV3cmN2WTJ4aGRXUmxMV3h2WjI5MWRDbnNuWUFnYTJsc2JGQnliMlBzbkx6cm9ad2c3SVM0N0lXWTdKMkVJT3V5aE91Z3BPeUVuQ0RzbmJRZzY2eTQ3S0NjNnJDQUNpOHZJT3lYaHV5WGlPdUtsT3VOc0N3ZzY3Q1c3SmVRN0lTY0lPdXdsT3ErdU91cHRDRHJpNlRycHF6cXNJQWc3SldNSU91d3FldXlsZXlkdENEc2w0YnNsNGpyaTZRdUlPcTN1T3VlbU95RW5DQXZhR1ZoYkhSb0lPeWhzTzJhak91bmlPdUxwQ0R0akl6c25ienNuWmdnNnJPRTdLQ1Y2ck84SU91NWhPcTFrTzJWbk91THBDNEtMeThnNjdtRTdKcXBJREFvN1l5TTdKMjg2NmVNSU95ZHZlcXpvQ3dnWTJ4aGRXUmxRV05qYjNWdWRPeWRtQ0F6TU95MGlDRHN1cERzaTV6cnBid2c2cmU0NjR5QTY2R2NJT3lUdE91THBDRGlnSlFnTG1Oc1lYVmtaUzVxYzI5dTdKMjBJT3k3cE95RW5DRHJwNlRyc29nZzdKMjk3S2VBSU95Vml1dUtsT3VMcENrdUNpOHZJT3F6aE95Z2xTRHNub2pzbll3ZzRvYVNJT3lYaHV5ZGpDanJvWnpxdDdqc2xZVHNtNE1wSU91d3FlMldwZXlkZ0NEcXNiVHJrNXpycHF6c3A0QWc3SldLNjRxVTY0dWtPaUR0akl6c25ienNuWVFnNjQydTdKYTA3Sk93NjRxVUlPeUluT3F3aENEc25xRHF1WkFnNjZxN0lPeWR2ZXVLbENEcXNvUHFzN3dLTHk4ZzZyV3M2N2FFNjVDWTdLZUFJT3lWaXV5VmhDRHRsNXNnN0o2czdJdWM3SjZSN0oyRUlPdTJnT3VsdE9xem9Dd2c2cmU0SU91d3FlMldwZXlkZ0NEc25ianNwcDBnN0ppazY2V1lJT3F5dmV1aG5DaHBjMEYxZEdoRmNuSnZjaW5xc0lBZzdKMjA2Nis0SU95eW1PdW1yTzJWbk91THBDNEtablZ1WTNScGIyNGdjbVZ6ZEdGeWRFbG1RV05qYjNWdWRFTm9ZVzVuWldRb0tTQjdDaUFnYVdZZ0tDRndjbTlqSUh4OElIZGhhWFJsY2lrZ2NtVjBkWEp1T3lBZ0lDQWdJQ0FnSUM4dklPeUV1T3lGbUNEc2w0YnNuWXdvNjR1azdKMk1JTzJFdE95ZHRDRHNnNGpyb1p3ZzdJdWM2NCtaS1NBdklPMkV0Q0RzcDRUdGxva2c3S1NSN0oyMDY2bTBJT3VMcE95ZGpDRHNvYkR0bW96c2w1RHNoSndLSUNCamIyNXpkQ0J1YjNjZ1BTQmpiR0YxWkdWQlkyTnZkVzUwS0NrN0NpQWdhV1lnS0NGdWIzY2dmSHdnYm05M0lEMDlQU0J6WlhOemFXOXVRV05qYjNWdWRDa2djbVYwZFhKdU93b2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcXM0VHNvSlhzbmJRZzY3Q1U2NENNN0plSTdKYTA3SnFVSUNnbklDc2dLSE5sYzNOcGIyNUJZMk52ZFc1MElIeDhJQ2ZzbDRic25Zd25LU0FySUNjZzRvYVNJQ2NnS3lCdWIzY2dLeUFuS1NEaWdKUWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuWVFnNjdLRTY2YXM2ck9nSU95RGlDRHFzNFRzb0pYc25MenJvWndnNjR1azdJdWNJT3lMbk95ZWtlMlZxZXVMaU91THBDNG5LVHNLSUNBdkx5RHNuWmpyajRUc29JRWc3S0tGNjZPTUtISmxZWE52YmlEc3A0RHNvSlVwSU9LQWxDQlRSVk5UU1U5T1gwUkpSVVRyb1p3ZzY0R2Q2NEswNjZtMElPeWVrT3VQbVNEc25xenNpNXpyajRUcXNJQWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuWVFnNjVDWTdJSzA2NmF3NjR1a0NpQWdhMmxzYkZCeWIyTW9KK3F6aE95Z2xleWR0Q0Ryc0pUcmdJenNsclRzaEp3ZzdJUzQ3SVdZN0oyRUlPeURpT3VobkNEc2k1enNucEh0bG9qc2xyVHNtcFFnNG9DVUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3BPd29nSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0lDOHZJTzJWbk91UGhNSzM2NkdjNnJlNDdKMjRJT3lEZ2UyRG5PdUtsQ0RxczRUc29KWHJwNGpyaTZRZzY0dWs2NlcwNjR1a0lPS0FsQ0RzZzRnZzZyT0U3S0NWN0p5ODY2R2NJT3VMcE95TG5DRHRqSkRzb0pYdGxaanFzb3dLSUNCelpYTnphVzl1UVdOamIzVnVkQ0E5SUc1dmR6c0tmUW9LYkdWMElHeGhjM1JCZFhSb1VtVjBjbmxCZENBOUlEQTdDbVoxYm1OMGFXOXVJSEpsZEhKNVFYVjBhRWxtVG1WbFpHVmtLQ2tnZXdvZ0lHbG1JQ2hqYkdGMVpHVlRkR0YwZFhNZ0lUMDlJQ2RqYkdGMVpHVXRiRzluYjNWMEp5QW1KaUJqYkdGMVpHVlRkR0YwZFhNZ0lUMDlJQ2RqYkdGMVpHVXRiR2x0YVhRbktTQnlaWFIxY200N0NpQWdhV1lnS0hkaGFYUmxjaUI4ZkNCRVlYUmxMbTV2ZHlncElDMGdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEd2dNekF3TURBcElISmxkSFZ5YmpzZ0x5OGc3S2VFN1phSklPeWtrU0R0aExRZzY3Q3A3WlcwSU9xNGlPeW5nQ0FySURNdzdMU0lJT3F3aE9xeXFRb2dJR3hoYzNSQmRYUm9VbVYwY25sQmRDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0RzbnF6dG1aWHNuYmdnN0l1YzY0K0U0b0NtSnlrN0NpQWdjblZ1VkhWeWJpZ29LU0E5UGlBbjY2R2M2cmU0N0oyNElPMlpsZXlkdU95YXFleWR0T3VMcEM0Z0lrOUxJdXVkdk9xem9PdW5qQ0RyaTdYdGxaanJuYnd1SnlrdWRHaGxiaWdLSUNBZ0lDZ3BJRDArSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25iZ2c3Wm1WN0oyNDY1Q29JT0tBbENEc29KWHNnNEVnN0lPQjdZT2M2NkdjSU91enRlcTNnQzRuS1N3S0lDQWdJQ2hsS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0pXRTdLZUJJT3Vobk9xM3VPeWR1Q0RzbFlnZzY1Q29PaWNzSUZOMGNtbHVaeWhsTG0xbGMzTmhaMlVwTG5Oc2FXTmxLREFzSURnd0tTa0tJQ0FwT3dwOUNnb3ZMeURzaTZUdGpLZ2c3SjJSNjR1MTdKMkVJT3lDck91ZWpPeWFxU0RzbFlqcmdyVHJvWndnNjdPQTdabVlJT0tBbENEc201RHNuYmdvNjZHYzZyZTQ3SjI0TCt5RXBPeTVtQ25zbmJRZzdZeU03SldGNjVDY0lPcXl2ZXlhc095WGxDRHF0N2dnN0pXSTY0SzA2Nlc4TENEc2xZVHJpNGpycWJRZzdLQ1I2NUdRN0phMEsreWJrT3VzdU95ZGhDRHJzN1RyZ3Jqcmk2UUtablZ1WTNScGIyNGdabkpwWlc1a2JIbEZjbkp2Y2lobExDQndjbVZtYVhncElIc0tJQ0JwWmlBb1pTQW1KaUJsTG0xbGMzTmhaMlVnUFQwOUlFeFBSMGxPWDBkVlNVUkZLU0J5WlhSMWNtNGdleUJsY25KdmNqb2dURTlIU1U1ZlIxVkpSRVVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0Ykc5bmIzVjBKeUI5T3dvZ0lHbG1JQ2hsSUNZbUlHVXViV1Z6YzJGblpTQTlQVDBnVEVsTlNWUmZSMVZKUkVVcElISmxkSFZ5YmlCN0lHVnljbTl5T2lCTVNVMUpWRjlIVlVsRVJTd2djSEp2WW14bGJUb2dKMk5zWVhWa1pTMXNhVzFwZENjZ2ZUc0tJQ0JwWmlBb1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBblkyeGhkV1JsTFcxcGMzTnBibWNuS1NCN0NpQWdJQ0J5WlhSMWNtNGdleUJsY25KdmNqb2dKK3lkdENCUVEreVhrQ0JEYkdGMVpHVWdRMjlrWlNoamJHRjFaR1VwNnJDQUlPeUVwT3k1bU91UHZDRHNub2pzcDRBZzdKV0s3SldFN0pxVUlPS0FsQ0RzaEtUc3VaanRsWmpxczZBZzY2R2M2cmU0N0oyNDdaV2NJT3VTcENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0bkxDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXMXBjM05wYm1jbklIMDdDaUFnZlFvZ0lISmxkSFZ5YmlCN0lHVnljbTl5T2lCd2NtVm1hWGdnS3lBb1pTQW1KaUJsTG0xbGMzTmhaMlVnUHlCbExtMWxjM05oWjJVZ09pQlRkSEpwYm1jb1pTa3BJSDA3Q24wS0NtWjFibU4wYVc5dUlISmxZV1JDYjJSNUtISmxjU2tnZXdvZ0lISmxkSFZ5YmlCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpTa2dQVDRnZXdvZ0lDQWdiR1YwSUdKdlpIa2dQU0FuSnpzS0lDQWdJSEpsY1M1dmJpZ25aR0YwWVNjc0lDaGpLU0E5UGlCN0lHSnZaSGtnS3owZ1l6c2dmU2s3Q2lBZ0lDQnlaWEV1YjI0b0oyVnVaQ2NzSUNncElEMCtJSHNLSUNBZ0lDQWdkSEo1SUhzZ2NtVnpiMngyWlNoS1UwOU9MbkJoY25ObEtHSnZaSGtwS1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnY21WemIyeDJaU2g3ZlNrN0lIMEtJQ0FnSUgwcE93b2dJSDBwT3dwOUNncGpiMjV6ZENCRFQxSlRYMGhGUVVSRlVsTWdQU0I3Q2lBZ0owRmpZMlZ6Y3kxRGIyNTBjbTlzTFVGc2JHOTNMVTl5YVdkcGJpYzZJQ2NxSnl3S0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxSVpXRmtaWEp6SnpvZ0owTnZiblJsYm5RdFZIbHdaU2NzQ24wN0NtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXdvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3WlNjNklDZGhjSEJzYVdOaGRHbHZiaTlxYzI5dU95QmphR0Z5YzJWMFBYVjBaaTA0SnlCOUxDQkRUMUpUWDBoRlFVUkZVbE1wS1RzS0lDQnlaWE11Wlc1a0tFcFRUMDR1YzNSeWFXNW5hV1o1S0c5aWFpa3BPd3A5Q2dwamIyNXpkQ0J6WlhKMlpYSWdQU0JvZEhSd0xtTnlaV0YwWlZObGNuWmxjaWhoYzNsdVl5QW9jbVZ4TENCeVpYTXBJRDArSUhzS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMDlRVkVsUFRsTW5LU0I3SUhKbGN5NTNjbWwwWlVobFlXUW9NakEwTENCRFQxSlRYMGhGUVVSRlVsTXBPeUJ5WlhSMWNtNGdjbVZ6TG1WdVpDZ3BPeUI5Q2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZEhSVlFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YUdWaGJIUm9KeWtnZXdvZ0lDQWdjbVZ6ZEdGeWRFbG1RV05qYjNWdWRFTm9ZVzVuWldRb0tUc2dMeThnNjdDVzdKZVE3SVNjSU9xemhPeWdsZXlkaENEcnNKVHF2Nmpzbkx6cnFiUWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuWVFnNjZpODdLQ0FJT3V5aE91bXNPdUxwQ0FvN0pXRTY1NllJT3liak91d2pleVhoZXlkdENEc21Kc2c2ck9FN0tDVjdKeTg2NkdjSU91UGpPeW5nQ0RzbFlycXNvd3BDaUFnSUNCeVpYUnllVUYxZEdoSlprNWxaV1JsWkNncE95QXZMeURyb1p6cXQ3anNuYmdnN1pXRTdKcVVJT3lEZ2UyRG5PdXB0Q0RzbnF6dG1aWHNuYmdnN0l1YzY0K0VJT0tBbENEc25xenJvWnpxdDdqc25ianNuYlFnNjRHZDY0S3M3Snk4NjZtMElPdUxwT3lkakNEc29iRHRtb3pydG9EdGhMQWdjSEp2WW14bGJleWR0Q0R0a29EcnByRHJpNlFLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3Q2lBZ0lDQWdJRzlyT2lCMGNuVmxMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5MQ0IyT2lCQ1VrbEVSMFZmVml3Z1pHbHlPaUJmWDJScGNtNWhiV1VzSUM4dklIYkN0MlJwY2pvZzZyV3M2N0tFN0tDRUwreVhpZXVhc2UyVm5DRHNncXpyczdqc25iUWc2NWFnSU95ZWlPdUtsT3luZ0NEc3A0VHJpNmpzbXFrS0lDQWdJQ0FnYlc5a1pXdzZJR04xY25KbGJuUk5iMlJsYkN3Z2JXOWtaV3h6T2lCQlRFeFBWMFZFWDAxUFJFVk1VeXdnWlhoaGJYQnNaWE02SUVWWVFVMVFURVZUTG14bGJtZDBhQ3dnWjNWcFpHVTZJRWRWU1VSRkxteGxibWQwYUN3Z2NtVmhaSGs2SUhkaGNtMWxaRlZ3TEFvZ0lDQWdJQ0J3Y205aWJHVnRPaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuYjJzbklIeDhJR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdiblZzYkNrZ1B5QnVkV3hzSURvZ1kyeGhkV1JsVTNSaGRIVnpMQW9nSUNBZ0lDQmhZMk52ZFc1ME9pQmpiR0YxWkdWQlkyTnZkVzUwS0Nrc0NpQWdJQ0FnSUhObGNuWmxaRG9nYzNSaGRITXVjMlZ5ZG1Wa0xDQnNZWE4wUVhRNklITjBZWFJ6TG14aGMzUkJkQ3dnYkdGemRGUmxlSFE2SUhOMFlYUnpMbXhoYzNSVVpYaDBMQ0JzWVhOMFUyVmpPaUJ6ZEdGMGN5NXNZWE4wVTJWakxBb2dJQ0FnZlNrN0NpQWdmUW9nSUM4dklPMlVqT3Vmck9xM3VPeWR1Q0RzaTZ6c25xWHJzSlhyajVrZzRvQ1VJT3VCaXVxNHNPdXB0Q0RzbklRZzZyQ1E3SXVjSU8yRGdPeWR0T3VvdU9xd2dDRHJpNlRycHF6cnBid2c2NEdJNjR1a0NpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwyaGxZWEowWW1WaGRDY3BJSHNLSUNBZ0lHeGhjM1JDWldGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93b2dJSDBLSUNBdkx5RHJvWnpxdDdqc25iZ2c0b0NVSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JiOEorZm9DRHRnYlRyb1p6cms1d2c2NkdjNnJlNDdKMjRJTzJWaE95YWxGM0N0MXZ3bjVTUlhTRHJzb1R0aXJ6c25iUWc3Wmk0N0xhYzdaV2M2NHVrTGdvZ0lDOHZJT3E0c091enVDanJ1SXpybmJ6c21yRHNvSUFnN0tlQjdaYUpLVG9nWUdOc1lYVmtaU0JoZFhSb0lHeHZaMmx1SUMwdFkyeGhkV1JsWVdsZzY2VzhJT3lJcU95ZGdDRHRsSVRyb1p6c2hManNpcVRyb1p3ZzdJdWs3WmFKSU9LQWxDRHJxWlRyaWJRZzdKZUc3SjIwSU9xenAreWVwU0RydUl6cm5ienNtckRzb0lEcnBid2c3SmUwNnJPZ0xBb2dJQzh2SUNBZ2JHOWpZV3hvYjNOMElPeUltT3lMb0NEdGo2enRpcmpyb1p3ZzZyS3c2ck84NjZXOElPeWVrT3VQbVNEc2lKanJvTG50bFp6cmk2UW83SXVrN0xpaE9pRHRsNlRyazV6cnBxenNpcVRzbDVEc2hKenJqNFFnNjdpTTY1Mjg3SnF3N0tDQUlPeVh0T3VtdkNBcklFeEpVMVJGVGlEdG1aWHNuYmdzSURJd01qWXRNRGNwTGdvZ0lDOHZJQ0FnN1lTdzY2KzQ2NFNRN0oyMElPMlpsT3VwdE95WGtDRHNvSVR0bUlBZzdKV0lJT3Vjck91THBDNGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdU91bmpDRHRsWmpycWJRZzY0R2RMZ29nSUM4dklPMlB0T3V3c1NqdGhMRHJyN2pyaEpBcE9pRHNucERyajVrZzdKbUU2Nk9NNnJDQUlPdW5pZTJlakNEdG1aanFzcjBvNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJR3h2WTJGc2FHOXpkT3lYa0NEcnFyc2c2NHUvN0pXRUlPeTlsT3VUbk9xd2dDRHJzN1RzbmJUcmlwUWc2cks5N0pxd0tleVhrT3lFbkFvZ0lDOHZJQ0FnNjZHYzZyZTQ3SjI0SU91TWdPcTRzQ0RzcEpFZzY3S0U3WXE4N0oyRUlPdVlrQ0RyaUlUcnBiVHJxYlFzSU95OWxPdVRuT3VsdkNEcnRwbnNsNnpyaEtQc25ZUWc3SWlZSU95ZWlPdUtsQ0R0aExEcnI3anJoSkFnNjdDcDdJdWQ3Snk4NjZHY0lPeWdoTzJabU8yVm5PdUxwQzRLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2YjNCbGJpMXNiMmRwYmljcElIc0tJQ0FnSUdOdmJuTjBJR0p2WkhrZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPd29nSUNBZ1kyOXVjM1FnYzNkcGRHTm9UVzlrWlNBOUlDRWhLR0p2WkhrZ0ppWWdZbTlrZVM1emQybDBZMmhCWTJOdmRXNTBLVHNnTHk4ZzZyT0U3S0NWSU95Z2hPMlptQ0E5SU95TG5PMkJyT3VtdnlEc3NMM3NuTHpyb1p3ZzdKZTA3SmEwSU9xemhPeWdsZXlkaENEcXM2RHJwYndnN0lpWUlPeWVpT3F5akFvZ0lDQWdkSEo1SUhzS0lDQWdJQ0FnTHk4Z1kyeGhkV1JsNnJDQUlPeVhodXljdk91cHRDRHNsNnpxdUxEc2hKd2c2NEdLNjRxVTY0dWtMaUJ6YUdWc2JEcDBjblZsNjUyOElHTnNZWFZrWmVxd2dDRHNsNGJzbHJUcmo0UWc3SVc0N0oyQUlPeWdsZXlEZ1NEc2k2VHRsb25yajd3S0lDQWdJQ0FnTHk4Z2MzQmhkMjdzblpnZ0oyVnljbTl5Sitxd2dDRHNsWWdnNjV5bzZyT2dMQ0RzbUlqc29JVHNsNVFnNnJlNDY0eUE2NkdjSUc5ck9uUnlkV1hycGJ3ZzY0K002NkNrN0tTczY0dWtJT0tBbEFvZ0lDQWdJQ0F2THlEdGxJenJuNnpxdDdqc25ianNuWUFnSXV1NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUc2w0anNsclRzbXBRaTY1Mjg2ck9nSU8yVm1PdUtsT3VOc0NEc2k2VHNvSnpyb1p6cmlwUWc3SldFNjZ5MDZyS0Q2NCtFSU95VmlDRHJuS2pyaXBRZzdJT0I3WU9jNnJDQUlPdVFrT3VMcENqc2k2VHNvSndnN0l1ZzZyT2dLUzRLSUNBZ0lDQWdhV1lnS0dOc1lYVmtaVk4wWVhSMWN5QTlQVDBnSjJOc1lYVmtaUzF0YVhOemFXNW5KeWtnZXdvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeExDQjdDaUFnSUNBZ0lDQWdJQ0JsY25KdmNqb2dKK3lkdENCUVEreVhrQ0JEYkdGMVpHVWdRMjlrWmVxd2dDRHNsNGJzbHJUc21wUWc0b0NVSU8yRXNPdXZ1T3VFa095WGtPeUVuQ0JqYkdGMVpHVWdMUzEyWlhKemFXOXVJT3lkdENEcmtKanJpcFRzcDRBZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNG5MQW9nSUNBZ0lDQWdJQ0FnY0hKdllteGxiVG9nSjJOc1lYVmtaUzF0YVhOemFXNW5KeXdLSUNBZ0lDQWdJQ0I5S1RzS0lDQWdJQ0FnZlFvZ0lDQWdJQ0F2THlEc3A0VHRsb2tnN0tTUjdKMjQ2NDJ3SU91WWtDRHJpSXpyb0lEcmk2UWc0b0NVSU95YmtPeTVtZXlkZ0NBaTY3aU02NTI4N0pxdzdLQ0E2NkdjSU91THBPeUxuQ0RzbDdUcXVMQWk2NHVrTGlEdGhMRHJyN2pyaEpEc25ZQWdLaXJzc0wzc25ZUWc3SldFNjZ5MDZyS0Q2NCtFSU91cXV5RHJuWVRzbTZEc25ZUWc2NVdNNjZlTUtpb3VDaUFnSUNBZ0lDOHZJT3lZaU95Z2hPeVhsQ0FuTmpEc3RJZ2c2NFNZNnJLTUlPdU1nT3E0c0NEc3BKSHNuYlRycWJRZzdZU3c2Nis0NjRTUUoreWR0T3lYaU91S2xPdU5zQ3dnNjZHYzZyZTQ3SjI0SU8yWmxPdXB0T3lkaENEc25iM3FzYkRyZ3BnZzdKNmc2cm1RSU91VXRDRHNuYndnN1pXWTY0dWtJT3VMcE95TG5DRHJpSVRycGJnS0lDQWdJQ0FnTHk4ZzdLQ1Y3SU9CN0tDQjdKMjRJT3F5dmV5YXNPeVhrT3VQaENCamJXUWc3TEM5N0oyMElPMktnT3lXdE91Q21PeVpsT3VMcENneU1ESTJMVEE0SU95THBPeTRvU0RzaTZEcXM2QTZJQ0x0aExEcnI3anJoSkFnN1ptVTY2bTA3SjJBSU95Wm5DRHJscUFnNnJDUjdKNlE2cml3SWlrdUNpQWdJQ0FnSUM4dklPeWR0T3lnbkNEc21yRHJwcXpxc0lBZzdMQzk3SjJFSU95bmdleWdrU0RzbDdUcXM2QWc3SVN4NnJPMUlPeVhyT3UyZ0Noc2IyZHBibGRwYm1SdmQwOXdaVzVsWkNucnBid2c3SldFNjR1STZybU1MQ0RzaTV6cXNJVHNuYlFnN0pXRTY0dUk2NTI4SU9xM3VDRHNncXpzaTZUcm9ad2c3WXlRNjR1bzdaV2M2NHVrTGdvZ0lDQWdJQ0JqYjI1emRDQnpkR0ZzWlNBOUlHeHZaMmx1VUhKdll5QW1KaUFoYkc5bmFXNVhhVzVrYjNkUGNHVnVaV1FnSmlZZ0tFUmhkR1V1Ym05M0tDa2dMU0JzYjJkcGJsTjBZWEowWldSQmRDQStJREl3TURBd0tUc0tJQ0FnSUNBZ2FXWWdLR3h2WjJsdVVISnZZeUFtSmlCemRHRnNaU2tnZXdvZ0lDQWdJQ0FnSUd0cGJHeE1iMmRwYmxCeWIyTW9LVHNLSUNBZ0lDQWdJQ0JwWmlBb0lXOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa3BJSHNLSUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeExDQjdJR1Z5Y205eU9pQW43SjIwSUU5VDdKZVE3SVNnSU95ZWtPdVBtZXljdk91aG5DRHJxcnNnN0plMDdKYTA3SnFVSU9LQWxDRHRoTERycjdqcmhKRHNsNURzaEp3Z1kyeGhkV1JsSU95THBPMldpU0R0bTRRZ0wyeHZaMmx1SU8yVnRDRHNvN3pzaExqc21wUXVKeUI5S1RzS0lDQWdJQ0FnSUNCOUNpQWdJQ0FnSUNBZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDaHlaV0Z6YjI0ZzdLZUE3S0NWS1NEaWdKUWc3S2VFN1phSklPeWtrU0R0aExUc25ZUWdVMFZUVTBsUFRsOUVTVVZFNjZHY0lPdUJuZXVDdE91cHRDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtc091THBBb2dJQ0FnSUNBZ0lHdHBiR3hRY205aktDZnJvWnpxdDdqc25ianNuWVFnN0tlRTdaYUo3WldZNjRxVUlPeWtrZXlkdE91ZHZDRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bzdaYUk3SmEwN0pxVUlPS0FsQ0Ryb1p6cXQ3anNuYmdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxpY3BPd29nSUNBZ0lDQWdJR0ZqWTI5MWJuUkRZV05vWlM1aGRDQTlJREE3Q2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHRqN1Ryc0xFZzRvQ1VJTzJFc091dnVPdUVrQ0Ryc0tuc2k1M3NuTHpyb1p3ZzdLQ0U3Wm1ZTGljcE93b2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCdGIyUmxPaUFuZEdWeWJXbHVZV3duSUgwcE93b2dJQ0FnSUNCOUNpQWdJQ0FnSUM4dklPdXdxZXE0aUNEc2k1enNucEh0bFp3ZzY2R2M2cmU0N0oyNDdKMjBJT3lDdE95VmhDRHNub2pzbkx6cnFiUWc3SWFRNjR5QTdLZUFJT3lWaXV1S2xPdUxwQ0RpZ0pRZzdLTzk3SjIwNjZtMElPeUNyT3lhcWV5ZWtPcXdnQ0RyczdUcXM2QWc3SjZJNjRxVUlPMkRyZXlkbUNEc3ZaenJzTEVnN1krczdZcTQ2ckNBQ2lBZ0lDQWdJQzh2SU91THErMllnQ0FpYkc5allXeG9iM04wN0plUTdJU2NJT3lYc09xeXNPeWRoQ0Rxc2JEcnRvRHRsb2pzaXJYcmk0anJpNlFpNnJDQUlPdWNyT3VMcENneU1ESTJMVEE0SU95THBPeTRvU0RzaTZEcXM2QXBMZ29nSUNBZ0lDQnBaaUFvYkc5bmFXNVFjbTlqSUNZbUlFUmhkR1V1Ym05M0tDa2dMU0JzYjJkcGJsTjBZWEowWldSQmRDQThJREUxTURBd0tTQjdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEc3NMM3NuYlFnN0oyMDY2KzRJT3lYdE91Z3BDRHNub2pzbHJUc21wUWc0b0NVSU95RGlPdWhuQ0RzbDdUc3A0QWc3SldLNnJPZ0lPcTN1Q0Rzc0wzc25ZUWc3Sk93N0lTNDdKcVVMaWNwT3dvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J0YjJSbE9pQW5ZV3h5WldGa2VTMXZjR1Z1SnlCOUtUc0tJQ0FnSUNBZ2ZRb2dJQ0FnSUNCcmFXeHNURzluYVc1UWNtOWpLQ2s3SUM4dklPeVZudXlFb0NEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjQ3SjIwSU91TWdPcTRzQ0RzcEpIc25iVHJxYlFnN0tDUjZyT2dJT3lEaU91aG5DRHNsN0RyaTZRZ0tPeXd2ZXlkaENEcmk2dnNsWmpxc2JEcmdwZ2c2NHVrN0l1Y0lPdUloT3VsdUNEcXNyM3NtckFwQ2lBZ0lDQWdJR3h2WjJsdVUzUmhjblJsWkVGMElEMGdSR0YwWlM1dWIzY29LVHNLSUNBZ0lDQWdiRzluYVc1WGFXNWtiM2RQY0dWdVpXUWdQU0JtWVd4elpUc2dMeThnN0oyMDY3S0lJT3lMbk91UGhPeWRtQ0Rzc0wwZzdKZTA2cml3SU95RXNlcXp0U0RzbDZ6cnRvQWc0b0NVSU95VmhPdWVtT3lYa095RW5DRHNoTGpzbXJUcmk2UUtJQ0FnSUNBZ0x5OGdRbEpQVjFORlV1dUtsQ0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a0lPS0FsQ0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHFzNkFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHNucERyajVrZzdJaVk2NkM1N1pXYzY0dWtDaUFnSUNBZ0lDOHZJQ2pzbklRZ0ordWhuT3EzdU95ZHVPeWRnQ0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc3A0SHNvSkVnN0plMDZyS01JTzJWbk91THBDY2c3S084N0lTZElPS0FsQ0Rxc0lEcm9aenNzWVRycWJRZzdMMlU2NU9jSU91Mm1leVhyT3VFbytxNHNDRHRtWlRycWJUc25iUWc2NXlzNjR1a0tTNEtJQ0FnSUNBZ0x5OGdLaXJxczRUc29KVWc3S0NFN1ptWTdKMkFJT3lidVNEcm9aenF0N2pzbFlUc200UHNuWVFnNjZpODdLQ0FJT3lYc091THBDb3FLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVE14S1RvZzY3aU02NTI4N0pxdzdLQ0E3SmVRSU95RXVPeUZtT3lkdENEcmdxanNsWVFnN0o2STdKeTg2Nm0wQ2lBZ0lDQWdJQzh2SUdGMWRHaHZjbWw2WmVxd2dDRHFzNFRzb0pYc25ZUWc2Nnk3N0tlQUlPeVZpdXF6b0NEc2lybnNuYmdnN1ptVTY2bTA2NmVNSU91ZGhPeWF0T3VMcENnaTdJcTU3SjI0SU8yWmxPdXB0Q0RycDVEcXM2QWc2NkdjNnJlNDdKMjRJTzJabE91cHRPeWN2T3VobkNEcXNJRHFzNkFnN0l1MjY0dWtJaURzbXBUcXRhd3BMZ29nSUNBZ0lDQXZMeURzaExqc2haanNuWVFnN0tlQTdKcTBJT3VTcENEc2w3VHJxYlFnNjZHYzZyZTQ3SjI0SU8yWmxPdXB0T3UyZ08yRXNDRHJncGpzbUtqcmk2UWc0b0NVSUZWU1RPeWRoQ0Rxc0lEcXM3WHRsWmpzcDREcmo0UW83TEswN0oyMDY0dWRJT3lMcE8yTXFDa3NJRUpTVDFkVFJWTHJwYndnNnJDQTY2R2M3TEdFN0tlQTY0K0VDaUFnSUNBZ0lDOHZJQ2pzdlpUcms1d2c2N2FaN0plczY0U2o2cml3SU95Y29PdXduQ2tzSU91NGpPdWR2T3lhc095Z2dPdWx2Q0RxczZEcnBiVHNwNERyajRRbzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dDRHNsWVRyaTVncElPeVZpdXVLbENEc25LRHNuYnp0bFp3ZzY3Q3A2N0tWTGdvZ0lDQWdJQ0F2THlEcnRvRHNucEhzbXFrNklPdTRqT3Vkdk95YXNPeWdnT3lkbUNCamJHRjFaR1VnN0p1NUlPdWhuT3EzdU95ZHVPdVBoQ0R0a29EcnByRHJpNlFnNG9DVUlPcXpoT3lnbGV5ZGhDRHJzSlRxdnJqcm9LVHJpcFFnN0oyWTY0K0U3Sm1BSU91d3FlMldwZXlkdENEcXNKbnNsWVFnN0lpWTdKcXBMZ29nSUNBZ0lDQmpiMjV6ZENCemRHRnlkRXh2WjJsdUlEMGdLQ2tnUFQ0Z2V3b2dJQ0FnSUNBZ0lHTnZibk4wSUhSb2FYTk1iMmRwYmlBOUlITndZWGR1S0NkamJHRjFaR1VuTENCYkoyRjFkR2duTENBbmJHOW5hVzRuTENBbkxTMWpiR0YxWkdWaGFTZGRMQ0I3Q2lBZ0lDQWdJQ0FnSUNCemFHVnNiRG9nZEhKMVpTd2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbExBb2dJQ0FnSUNBZ0lDQWdaR1YwWVdOb1pXUTZJSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdJVDA5SUNkM2FXNHpNaWNzSUM4dklHdHBiR3hNYjJkcGJsQnliMlBzblpnZzZyZTQ2Nk81SUd0cGJHenNtcWtnS0d0cGJHeFFjbTlqNnJPOElPdVBtZXlkdkNEdGpLanRoTFFwQ2lBZ0lDQWdJQ0FnZlNrN0NpQWdJQ0FnSUNBZ2JHOW5hVzVRY205aklEMGdkR2hwYzB4dloybHVPd29nSUNBZ0lDQWdJR3h2WjJsdVYybHVaRzkzVDNCbGJtVmtJRDBnZEhKMVpUc2dMeThnUTB4SjZyQ0FJT3lYck91S2xDRHFzYlFnNnJTQTdMQ3c3WldnSU95SW1DRHNsNGJzbkx6cmk0Z2c3SmUwNjZhd0lPcXlnK3ljdk91aG5DRHJzN2pyaTZRZ0tPeWVyTzJCdE91bXJleVhrQ0R0aExEcnI3anJoSkFnNjdDcDdLZUFLUW9nSUNBZ0lDQWdJSFJvYVhOTWIyZHBiaTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdsbUlDaHNiMmRwYmxCeWIyTWdQVDA5SUhSb2FYTk1iMmRwYmlrZ2JHOW5hVzVRY205aklEMGdiblZzYkRzZ2ZTazdDaUFnSUNBZ0lDQWdkR2hwYzB4dloybHVMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0NpQWdJQ0FnSUNBZ0lDQnBaaUFvYkc5bmFXNVFjbTlqSUNFOVBTQjBhR2x6VEc5bmFXNHBJSEpsZEhWeWJqc0tJQ0FnSUNBZ0lDQWdJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdDaUFnSUNBZ0lDQWdJQ0JwWmlBb2JHOW5hVzVRY205alZHbHRaWElwSUhzZ1kyeGxZWEpVYVcxbGIzVjBLR3h2WjJsdVVISnZZMVJwYldWeUtUc2diRzluYVc1UWNtOWpWR2x0WlhJZ1BTQnVkV3hzT3lCOUNpQWdJQ0FnSUNBZ0lDQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BTQXdPeUF2THlEc2c0Z2c2ck9FN0tDVjdKMjhJT3lJbUNEc25vanNuTHpyaTRnZzY0dWs3SjJNSUM5b1pXRnNkR2dnNjVXTUlPdUxwT3lMbkNEc25iM3F1TEFLSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJ1SXpybmJ6c21yRHNvSUFnNjZHYzZyZTQ3SjI0SU95Z2lPeXdxQ0Rzb29Ycm80d2dLR052WkdVZ0p5QXJJR052WkdVZ0t5QW5LU2NwT3dvZ0lDQWdJQ0FnSUNBZ0x5OGc3SUtzNjU2TTdKMjBJT3Vobk9xM3VPeWR1TzJWb0NEc2k1enFzSVRyajRRZzdKZUc3SjIwSU9xenArdXdsT3VobkNEc2k2VHRqS2pyb1p3ZzY0R2Q2NEtzNjR1a0lEMGdZMnhoZFdSbDZyQ0FJT3lYaHVxeHNPdUNtQ0RzaTZUdGxvbnNuYlFnN0pXSUlPdVFuQ0Rxc29NdUNpQWdJQ0FnSUNBZ0lDQXZMeURzblpIcmk3WHNuWUFnN0oyMDY2KzRJT3V6dE91RGlPeWN2T3VMaUNEc2c0SHRnNXpycGJ3ZzY0dWs3SXVjSU95ZXJPeUVuQ0F2YUdWaGJIUm82NkdjSU95VmpPdW1zT3VMcENBbzdaU002NStzNnJlNDdKMjQ3SjIwSU91TWdPcTRzQ0R0bVpUcnFiVHNuWVFnN0l1azdZeW82NkdjSU91d2xPcSt2T3VMcENrdUNpQWdJQ0FnSUNBZ0lDQnBaaUFvWTI5a1pTQWhQVDBnTUNBbUppQkVZWFJsTG01dmR5Z3BJQzBnYkc5bmFXNVRkR0Z5ZEdWa1FYUWdQQ0ExTURBd0tTQjdDaUFnSUNBZ0lDQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJvWnpxdDdqc25ianNuYlFnN0thSjdJdWNJT3lMcE8yTXFPdWhuQ0RyZ1ozcmdxZ2c0b0NVSUVOc1lYVmtaU0JEYjJSbElPeUVwT3k1bUNEc2c0SHRnNXpycGJ3ZzY0dWs3SXVjSU95Z2tPcXlnTzJWcWV1TGlPdUxwQzRuS1RzS0lDQWdJQ0FnSUNBZ0lDQWdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1RzS0lDQWdJQ0FnSUNBZ0lIMEtJQ0FnSUNBZ0lDQjlLVHNLSUNBZ0lDQWdJQ0F2THlBek1PdTJoQ0RpZ0pRZzdKMjBJTzJVaE91aG5PeUV1T3lLcE9xd2dDRHNvNzNzbkx6cnFiUWc2N2lNNjUyODdKcXc3S0NBSU95OW5PdXdzZXlkdENEcXNJZ2diRzlqWVd4b2IzTjBJTzJQck8yS3VPdVBoQ0RyaTZ2dG1JQWdKK3lYc09xeXNPeWRoQ0Rxc2JEcnRvRHRsb2pzaXJYcmk0anJpNlFuNnJDQUlPdWNyT3VMcEM0S0lDQWdJQ0FnSUNBdkx5RHNtSWpzb0lRZ01URHJ0b1RzbllBZzdLZW43SldFN0lTY0xDRHJvWnpxdDdqc25ianRsWmpyaTZRZzdKNmc2cm1RSU91THBPdWx1Q0RzbmJ6c25ZUWc3WldZNjZtMElPMkRyZXlkdENEcnJMVHRtcWpxc0lBZzY1Q1E2NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Da3VDaUFnSUNBZ0lDQWdiRzluYVc1UWNtOWpWR2x0WlhJZ1BTQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIc2dZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNBek1PdTJoQ0Rxc3IzcXM3d2c0b0NVSU91TWdPcTRzQ0R0bElUcm9aenNoTGpzaXFRZzdLQ1Y2NmFzTGljcE95QnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lIMHNJREU0TURBd01EQXBPd29nSUNBZ0lDQjlPd29nSUNBZ0lDQXZMeUFxS3VxemhPeWdsU0Rzb0lUdG1aZ2dQU0Ryb1p6cXQ3anNsWVRzbTRNZ0t5RHJ1SXpybmJ6c21yRHNvSURzbDVBZzY2R2M2cmU0N0oyNElPMlpsT3VwdENvcUlDZ3lNREkyTFRBNExDQkNVa2xFUjBWZlZqMHpOaXdnN0lLczdKcXA3SjZRSU9xeXNPeWdsU2t1Q2lBZ0lDQWdJQzh2SU95S3VleWR1Q0R0bVpUcnFiVHNuYlFnNjV5bzY0cVVJT3Ezdk91enVDRHNtNURzbmJqc25ZQWdJdXU0ak91ZHZPeWFzT3lnZ095WGtDRHNtSnNnNnJPRTdLQ1Y3SjIwSU91aG5PcTN1T3lkdU91UHZDRHNub2pyaTZRaTY0cVVJT3F5Zyt5ZHRPdXZnT3VobkN3ZzdLQ0U3Wm1ZN0oyWUlPeXlxeURyajVuc25wSHNuWUFLSUNBZ0lDQWdMeThnNjZHYzZyZTQ3SjI0N0oyMElPeVZoT3VMaU91ZHZDQXFLdXVobk9xM3VPeVZoT3liZ3lvcTdKMjA3SmEwN0pXOElPdW5udXVMcEM0ZzZyZTQ2NTZZN0lTY0lPeVhyT3E0c095RW5PdUtsQ0Ryb1p6cXQ3anNuYmpzbllRZzdJdWM3SjZSN1pXWTdLZUFJT3lWaXV1S2xPdUxwRG9LSUNBZ0lDQWdMeThnSUNEaWthQWdRMHhKSU91aG5PcTN1T3lWaE95Ymd5aGpiR0YxWkdVZ1lYVjBhQ0JzYjJkdmRYUXBJT0tBbENEc21Kc2c3SjZRNnJLcDdLYWQ2NnFGd3Jmc2hManNoWmdnN1krUTZyaXdDaUFnSUNBZ0lDOHZJQ0FnNHBHaElPdTRqT3Vkdk95YXNPeWdnQ0RzbTdrZzY2R2M2cmU0N0pXRTdKdURJT3lYdE9xNHNDRGlnSlFnWTJ4aGRXUmxMbUZwTDJ4dloyOTFkT3lkZ0NEcm9aenF0N2pzbFlUc200TWc3WnVFSUNvcTY2R2M2cmU0N0oyNElPMlpsT3VwdE95Y3ZPdWhuQ0Rzc0tuc3A0QXFLdTJWbk91THBDanRnNjBnTWVxd25Da0tJQ0FnSUNBZ0x5OGc2NkdjNnJlNDdKV0U3SnVEN0oyMElPdUJuZXVDbU91cHRDRHFzNmZyc0pUcm9ad2dRMHhKSU91aG5PcTN1T3lkdU9xNWpPeW5nQ0RzbmJUc2xyVHNoSndnN0l1YzdKNlI3WldjNjR1a0lPS0FsQ0RzaExqc2haanNuYlFnNjdtRTdKdU03S2VFSU91U3BPdWR2Q0RzaXJuc25iZ2c3Wm1VNjZtMDdKMjBJT3lWaE91TGlPdWR2QW9nSUNBZ0lDQXZMeURyb1p6cXQ3anNuYmdnN1ptVTY2bTA3SjIwSU91Q21PeVlxT3VMcEM0ZzdZRzA2NmF0SU8yVm5DRHJzb2pzbkx6cm9ad2dJdXVobk9xM3VPeVZoT3liZ3lEaWhwSWc3SU9JSU9xemhPeWdsU0Ryb1p6cXQ3anNuYmdpN0oyMElPdUJuZXVDbk91THBDNEtJQ0FnSUNBZ2FXWWdLSE4zYVhSamFFMXZaR1VwSUhzS0lDQWdJQ0FnSUNCcmFXeHNURzluYVc1UWNtOWpLQ2s3SUM4dklPdU1nT3E0c0NEc3BKSHNuYmdnN0ppYklPdWhuT3EzdU95ZHVDRHNvSWpzc0tqcXNJQWc3SjZJN0p5ODY2bTBJT3lna2V1S2xPdUxwQW9nSUNBZ0lDQWdJR052Ym5OMElHeHZJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuWVhWMGFDY3NJQ2RzYjJkdmRYUW5YU3dnZXlCemFHVnNiRG9nZEhKMVpTd2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNLSUNBZ0lDQWdJQ0JzYnk1dmJpZ25aWEp5YjNJbkxDQW9LU0E5UGlCN0lDOHFJR05zWVhWa1pTRHNsNGJzbll3ZzY1T3hJT0tBbENEc2xZVHJucGdnN0p1NUlPdWhuT3EzdU95VmhPeWJnK3lkZ0NEcXQ3anJqSURyb1p3ZzdLZUU3WmFKSUNvdklIMHBPd29nSUNBZ0lDQWdJR3h2TG05dUtDZGpiRzl6WlNjc0lDaGpiMlJsS1NBOVBpQjdDaUFnSUNBZ0lDQWdJQ0JyYVd4c1VISnZZeWduNnJPRTdLQ1Y3SjJFSU91d2xPcSt1T3VncE9xem9DRHJvWnpxdDdqc2xZVHNtNFB0bGJUc2hKd2c3SnFVN0xLdDdKMkVJT3lra2V1THFPMldpT3lXdE95YWxDNG5LVHNnTHk4ZzdKMlk2NCtFN0tDQklPeWloZXVqakNBbzdKNlE2NCtaSU95ZXJPeUxuT3VQaENEcnNLbnNwNEFwQ2lBZ0lDQWdJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QXZMeURyaTZUc25Zd2c3S0d3N1pxTTdKZVE3SVNjSUNmcXM0VHNvSlVnN0plRzdKMk1KK3ljdk91aG5DRHNuYjN0bm9qcXNvd0tJQ0FnSUNBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlHNTFiR3c3SUM4dklPeURnZTJEbkNEc25xenRqSkRzb0pVS0lDQWdJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RxczRUc29KVWc3S0NFN1ptWUlPS0FsQ0JEVEVrZzY2R2M2cmU0N0pXRTdKdURJQ2hqYjJSbElDY2dLeUJqYjJSbElDc2dKeWtuS1RzS0lDQWdJQ0FnSUNCOUtUc0tJQ0FnSUNBZ0lDQmpiMjV6ZENCdmNHVnVaV1FnUFNCdmNHVnVWWEpzU1c1RVpXWmhkV3gwUW5KdmQzTmxjaWhYUlVKZlRFOUhUMVZVWDFWU1RDazdDaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU9xemhPeWdsU0Rzb0lUdG1aZ2c0b0NVSU95YnVTRHJvWnpxdDdqc2xZVHNtNFBzbllRZzdKZTA3SmVJN0phMDdKcVVKd29nSUNBZ0lDQWdJQ0FnS3lBb2IzQmxibVZrSUQ4Z0p5Y2dPaUFuSUNqcnVJenJuYnpzbXJEc29JQWc3SmUwNnJpd0lPeUxwTzJNcUNEaWdKUWdKeUFySUZkRlFsOU1UMGRQVlZSZlZWSk1JQ3NnSnlEcm9ad2c3S2VCN0tDUklPeWdrZXlHamUyVnRDRHNvN3pzaExqc21wUXBKeWtnS3lBbkxpY3BPd29nSUNBZ0lDQWdJQzh2SUNvcTY2R2M2cmU0N0pXRTdKdUQ2NmVNSU8yVm1PcXpvQ0RyZ1ozcmdyVHJxYlFnN0pXSUlPdVFuT3VMcENvcUlDZ3lNREkyTFRBNExDQkNVa2xFUjBWZlZqMHpPQ2s2SU91aG5PcTN1T3lWaE95Ymd5RHRtWlRycWJUc2w1RHNoSndnN0p1NUlPdWhuT3EzdU95ZHVPeWRoQ0R0bGJUcmo0UUtJQ0FnSUNBZ0lDQXZMeUJEVEVrZ1QwRjFkR2pxc0lBZzdJdWM3SjZSNjVDWTdLZUFJT3lWaXV5VmhDRHRsSXpybjZ6cXQ3anNuYmpzbllBZzdKZXc2ckt3NjVDWTdLZUFJT3lWaXV1S2xPdUxwQzRnN0lLczdKcXA3SjZRNjRxVUlDTHJvWnpxdDdqc25ianRsb2pyaXBUcmpiQWc3Sm1jSU95VmlDRHJrSmpyZzVBaTZyQ0FJT3VRbU9xem9Dd0tJQ0FnSUNBZ0lDQXZMeURzbUpzZzdZT3Q3SjIwSU91Q3FPeVZoQ0Rzbm9qc25MenJxYlFnN0tPOTdKMkFJTzJQck8yS3VPdWhuQ0Rzdlp6cnNMSHNuYlFnNnJDQTdJU2NJQ0pzYjJOaGJHaHZjM1RzbDVEc2hKd2c3SmV3NnJLdzdKMkVJT3F4c091MmdPMldpT3lLdGV1TGlPdUxwQ0xxdVl6c3A0QWc2NXlzNjR1a0tPeUxwT3k0b1NrdUNpQWdJQ0FnSUNBZ0x5OGc2cmU0NjU2WTdJU2NJT3Vobk9xM3VPeVZoT3liZyt5ZHRDRHNzcGpycHF6cmtLQWc3SXVjNnJDRTdKMkVJT3lrZ0NEcmtxUWdLaXBEVEVrZzY2R2M2cmU0N0oyNDZybU03S2VBSU95ZHRPeVd0T3lFbkNEc2k1enNucEh0bFp6cmk2UXFLaURpZ0pRZzdJUzQ3SVdZN0oyMElPdTVoT3liak95bmhDRHJrcVRybmJ3S0lDQWdJQ0FnSUNBdkx5RHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPeVZoT3VMaU91ZHZDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKMjBJT3VDbU95WXFPdUxwQzRnN1lPdDdKMkFJRExxc0p3bzY2R2M2cmU0N0pXRTdKdURJT3lWaU91Q3RDQXJJT3Vobk9xM3VPeWR1Q25zcDREcnA0d2c3WUcwNjZhdElPMlZuQ0Ryc29qc25MenJvWndnNjRHZDY0S2M2NHVrTGdvZ0lDQWdJQ0FnSUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnZXlCcFppQW9JV3h2WjJsdVVISnZZeWtnYzNSaGNuUk1iMmRwYmlncE95QjlMQ0JNVDBkUFZWUmZVMFZVVkV4RlgwMVRLVHNLSUNBZ0lDQWdJQ0JzYjJkcGJsTjBZWEowWldSQmRDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJRzF2WkdVNklDZGljbTkzYzJWeUxYTjNhWFJqYUNjZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ0x5OGc2NmVNNjZPTUlPeWVyT3Vobk9xM3VPeWR1Q0RpZ0pRZzZyQ1o3SjJBSU9xemhPeWdsZXlkdE91ZHZDRHNoTGpzaFpqc25ZUWc3S2VBN0pxdzdLZUFJT3lWaXVxem9DRHF0N2pyaklEcm9ad2c3SmV3NjR1a0tPdTVvT3VsdE91THBDa0tJQ0FnSUNBZ2MzUmhjblJNYjJkcGJpZ3BPd29nSUNBZ0lDQXZMeURyZ3FIc25ZQWc3SjZGN0o2bDZyYU03SjJFSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NHlBNnJpd0lPeUV1T3lGbU95ZGdDRHJzb1RycHJEcmk2UWc0b0NVSU95ZXJPdWhuT3EzdU95ZHVDRHRtNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzZzRnZzdJUzQ3SVdZS095RGlDRHNub1hzbnFYcXRvd3A3Snk4NjZHY0lPeUxuT3lla2UyVm1PcXlqQzRLSUNBZ0lDQWdMeThnN0oyWTY0K0U3S0NCSU95aWhldWpqQ2h5WldGemIyNGc3S2VBN0tDVktTRGlnSlFnVTBWVFUwbFBUbDlFU1VWRTY2R2NJT3VCbmV1Q3RPdXB0Q0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91Z3BBb2dJQ0FnSUNBdkx5RHNucXpyb1p6cXQ3anNuYmdnNjVLazdKZVE2NCtFSUUxQldGOVVWVkpPVStxNWpPeW5nQ0RzbUpzZzZyT0U3S0NWN0p5ODY2R2NJT3l5bU91bXJPdVFtT3VLbENEcnNvVHF0N2pxc0lBZzY1Q2M2NHVrSUNneU1ESTJMVEEzSU91bXJPdTNzT3lYa095RW5DRHRtWlhzbmJncENpQWdJQ0FnSUd0cGJHeFFjbTlqS0Nmcm9aenF0N2pzbmJqc25ZUWc3S2VFN1phSjdaV1k2NHFVSU95a2tleWR0T3VkdkNEc21wVHNzcTNzbllRZzdLU1I2NHVvN1phSTdKYTA3SnFVSU9LQWxDRHJvWnpxdDdqc25iZ2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGljcE93b2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd093b2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N2lNNjUyODdKcXc3S0NBSU91aG5PcTN1T3lkdUNEc2k1enNucEVuSUNzZ0tITjNhWFJqYUUxdlpHVWdQeUFuSUNqcXM0VHNvSlVnN0tDRTdabVlJT0tBbENEc2lybnNuYmdnN1ptVTY2bTA3SjIwSU91Y3FPdXB0Q0RxdDdnZzdabVU2Nm0wSU8yVm1PdUxxQ0JiNnJPRTdLQ1ZJT3lnaE8yWm1GM3NuTHpyb1p3ZzY0dWs2Nlc0SU9xemhPeWdsZXlkaENEcXM2RHJwYndnN0lpWUlPeWVpT3lXdE95YWxDa25JRG9nSnljcElDc2dKeURpZ0pRZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95ZWtPdVBtU0RzbDdEcXNyRHJrS25yaTRqcmk2UXVKeWs3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQnRiMlJsT2lCemQybDBZMmhOYjJSbElEOGdKMkp5YjNkelpYSXRjM2RwZEdOb0p5QTZJQ2RpY205M2MyVnlKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0ExTURBc0lIc2daWEp5YjNJNklDZnJvWnpxdDdqc25iZ2c3TEM5N0oyRUlPdXF1eURzbDdUc2w0anNsclRzbXBRNklDY2dLeUJsTG0xbGMzTmhaMlVnZlNrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SUNqdGhMRHJyN2pyaEpBZzdZKzA2N0N4SU9xMXJPMlloT3UyZ0NEaWdKUWc2N2lNNjUyODdKcXc3S0NBSU95ZWtPdVBtU0RzbVlUcm80enFzSUFnN0pXSUlPdVFtT3VLbENEdG1aanFzcjBnN0tDRTdKcXBLUW9nSUdaMWJtTjBhVzl1SUc5d1pXNU1iMmRwYmxSbGNtMXBibUZzS0NrZ2V3b2dJQ0FnZXdvZ0lDQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dld29nSUNBZ0lDQWdJQzh2SUhOMFlYSjA2ckNBSU95RGlDRHN2WmpzaHBRZzdMQzk3SjJFSU91bmpPdVRvT3VMcENBbzY0dWs2NmFzN0oyWUlPeUlxT3lkZ0NEc3ZaanNocFRxczd3ZzY2eTA2clNBN1pXWTZyS01JT3lDck95YXFleWVrT3lYa09xeWpDRHJzN1Rzbm9RcExnb2dJQ0FnSUNBZ0lDOHZJT3lkdE95V3RPeUVuQ0JRYjNkbGNsTm9aV3hzS0M1d2N6RXA3SjIwSURYc3RJZ2c2NUtrSU9xM3VDRHNzTDNzbDVBZzdKZVU3WVN3NjZXOElPdXp0T3VDdENBeDY3S0lLT3Exck91UGhTRHFzNFRzb0pVcDdKMkVJT3lla091UG1TRHNoS0R0ZzUzdGxaanFzNkFzQ2lBZ0lDQWdJQ0FnTHk4ZzdMQzk3SjJFSU95MW5PeUdqTzJabE8yVnRDRHNncXpzbXFuc25wQWc2NGlJN0plVUlPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmpycDR3ZzY0S282cktNSU8yVm5PdUxwQzRnN0xDOTdKMkVJT3VxdXlEc3NMN3NuTHpycWJRZzdKV0U2NnkwNnJLRDY0K0VJT3lWaUNEdGxaenJpNlFLSUNBZ0lDQWdJQ0F2THlBbzY0dWs2Nlc0SU95d3ZTRHNtS1Rzbm9Ycm9LVWc2N0NwN0tlQUlPS0FsQ0RxdDdnZzZySzk3SnF3SU91cGxPdUp0T3F3Z0NEcnM3VHNuYlRyaXBRZzdMR0U2NkdjSU91Q3FPcXpvQ0RzZ3F6c21xbnNucERxc0lBZzdKZVU3WVN3SU8yVm5DRHJzb2dnNjRpRTY2VzA2Nm0wSU91UXFDa3VDaUFnSUNBZ0lDQWdMeThnN0tPODdKMllPaUJqYkdGMVpHWHFzSUFnN0wyWTdJYVVJT3lnbk91cXFleWRoQ0Ryc0pUcXZyanJxYlFnUVhCd1FXTjBhWFpoZEdVdlJtbHVaRmRwYm1SdmQrcXdnQ0RycXJzZzdMQys3SjJFSU95SW1DRHNub2pzbll3ZzRvQ1VJT3ljaU91UGhPeWFzQ0RzaTZUcXVMRHNsNURzaEp3ZzdabVY3SjI0SU8yVmhPeWFsQzRLSUNBZ0lDQWdJQ0JqYjI1emRDQndjekVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExXeHZaMmx1TG5Cek1TY3BPd29nSUNBZ0lDQWdJR1p6TG5keWFYUmxSbWxzWlZONWJtTW9jSE14TENCYkNpQWdJQ0FnSUNBZ0lDQW5VM1JoY25RdFUyeGxaWEFnTFZObFkyOXVaSE1nTlNjc0NpQWdJQ0FnSUNBZ0lDQW5KSGR6SUQwZ1RtVjNMVTlpYW1WamRDQXRRMjl0VDJKcVpXTjBJRmRUWTNKcGNIUXVVMmhsYkd3bkxBb2dJQ0FnSUNBZ0lDQWdJbWxtSUNna2QzTXVRWEJ3UVdOMGFYWmhkR1VvSjJOc1lYVmtaUzFzYjJkcGJpY3BLU0I3SWl3S0lDQWdJQ0FnSUNBZ0lDSWdJQ1IzY3k1VFpXNWtTMlY1Y3lnbmZpY3BJaXdLSUNBZ0lDQWdJQ0FnSUNjZ0lGTjBZWEowTFZOc1pXVndJQzFUWldOdmJtUnpJREluTEFvZ0lDQWdJQ0FnSUNBZ0lpQWdRV1JrTFZSNWNHVWdMVTVoYldWemNHRmpaU0JWSUMxT1lXMWxJRmNnTFUxbGJXSmxja1JsWm1sdWFYUnBiMjRnSjF0RWJHeEpiWEJ2Y25Rb1hDSjFjMlZ5TXpJdVpHeHNYQ0lwWFNCd2RXSnNhV01nYzNSaGRHbGpJR1Y0ZEdWeWJpQlRlWE4wWlcwdVNXNTBVSFJ5SUVacGJtUlhhVzVrYjNjb2MzUnlhVzVuSUdNc0lITjBjbWx1WnlCMEtUc2dXMFJzYkVsdGNHOXlkQ2hjSW5WelpYSXpNaTVrYkd4Y0lpbGRJSEIxWW14cFl5QnpkR0YwYVdNZ1pYaDBaWEp1SUdKdmIyd2dVMmh2ZDFkcGJtUnZkeWhUZVhOMFpXMHVTVzUwVUhSeUlHZ3NJR2x1ZENCdUtUc25JaXdLSUNBZ0lDQWdJQ0FnSUNJZ0lDUm9JRDBnVzFVdVYxMDZPa1pwYm1SWGFXNWtiM2NvVzA1MWJHeFRkSEpwYm1kZE9qcFdZV3gxWlN3Z0oyTnNZWFZrWlMxc2IyZHBiaWNwSWl3S0lDQWdJQ0FnSUNBZ0lDY2dJR2xtSUNna2FDQXRibVVnVzFONWMzUmxiUzVKYm5SUWRISmRPanBhWlhKdktTQjdJRnQyYjJsa1hWdFZMbGRkT2pwVGFHOTNWMmx1Wkc5M0tDUm9MQ0EyS1NCOUp5d2dMeThnTmlBOUlGTlhYMDFKVGtsTlNWcEZDaUFnSUNBZ0lDQWdJQ0FuZlNjc0NpQWdJQ0FnSUNBZ1hTNXFiMmx1S0NkY2NseHVKeWtnS3lBblhISmNiaWNwT3dvZ0lDQWdJQ0FnSUdOdmJuTjBJR0poZENBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRiRzluYVc0dVltRjBKeWs3Q2lBZ0lDQWdJQ0FnWm5NdWQzSnBkR1ZHYVd4bFUzbHVZeWhpWVhRc0lDZEFaV05vYnlCdlptWmNjbHh1SnlBckNpQWdJQ0FnSUNBZ0lDQW5jM1JoY25RZ0ltTnNZWFZrWlMxc2IyZHBiaUlnWTIxa0lDOXJJR05zWVhWa1pTQXZiRzluYVc1Y2NseHVKeUFyQ2lBZ0lDQWdJQ0FnSUNBbmNHOTNaWEp6YUdWc2JDQXRUbTlRY205bWFXeGxJQzFGZUdWamRYUnBiMjVRYjJ4cFkza2dRbmx3WVhOeklDMUdhV3hsSUNJbklDc2djSE14SUNzZ0p5SmNjbHh1SnlrN0NpQWdJQ0FnSUNBZ2MzQmhkMjRvSjJOdFpDY3NJRnNuTDJNbkxDQmlZWFJkTENCN0lHVnVkam9nUTB4QlZVUkZYMFZPVml3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc0tJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXdvZ0lDQWdJQ0FnSUM4dklIQjBlU2hsZUhCbFkzUXA2NkdjSU91enRPdUN1Q0R0Z3FUc2w1QWc3WUcwNjZHYzY1T2NJRlJWU2Vxd2dDRHJyTFRyc0pqc25aSHNuYmdnNnJLRDdKMjBJT3lMcE95NG9TRHRtWlhzbmJqcmtLZ29NakF5Tmkwd055d2c3SjI4NjdDWUlGeHl3cmRyYVhSMGVTRHN2WlRyazV3ZzY2cW82NUdRS1NEaWdKUUtJQ0FnSUNBZ0lDQXZMeURzbktEc25ienRsWndnN0o2UTY0K1o3Wm1VSU9xeXZldWhuT3VLbENCVGVYTjBaVzBnUlhabGJuUno3SjJZSU95bmhPeW5uQ0R0Z3FRZzdKNkY2NkNsTGlEc29KSHF0N3pzaExFZzZyYU03WldjN0oyMElPeWVpT3ljdk91cHRDQTI3TFNJSU91U3BDRHNsNVR0aExEcXNJQWc3SjZRNjQrWklPeWVoZXVncGV1UHZBb2dJQ0FnSUNBZ0lDOHZJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbmJRZzdJU2c3WU9kNjVDWTZyT2dMQ0RxdG96dGxaenNuYlFnN0plRzdKeTg2Nm0wSUd0bGVYTjBjbTlyWlNEc3BJVHJwNHdnN0tHdzdKcXA3WjZJSU95THBPMk1xTzJWdENEc2dxenNtcW5zbnBEcXNJQWc3SmVVN1lTd0lPMlZuQ0Ryc29nZzY0aUU2NlcwNjZtMElPdVFuT3VMcENobVlXbHNMWE52Wm5RcExnb2dJQ0FnSUNBZ0lDOHZJT3lYbE8yRXNDRHNwNEhzb0lUc2w1QWdWR1Z5YldsdVlXenNuWVFnNjR1azdJdWNJT3lWbnV5Y3ZPdWhuQ0Rxc0lEc29ManNtWUFnNjR1azY2VzRJT3lWc2V5WGtDRHRncVRxc0lBZzY1T2s3SmEwNnJDQTY0cVVJT3F5Zyt5ZGhDRHJwNG5yaXBUcmk2UXVDaUFnSUNBZ0lDQWdjM0JoZDI0b0oyOXpZWE5qY21sd2RDY3NJRnNLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWhiQ0lnZEc4Z1pHOGdjMk55YVhCMElDSmpiR0YxWkdVZ0wyeHZaMmx1SWljc0NpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBbmRHVnNiQ0JoY0hCc2FXTmhkR2x2YmlBaVZHVnliV2x1WVd3aUlIUnZJR0ZqZEdsMllYUmxKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2RrWld4aGVTQTJKeXdLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2QwWld4c0lHRndjR3hwWTJGMGFXOXVJQ0pVWlhKdGFXNWhiQ0lnZEc4Z1lXTjBhWFpoZEdVbkxBb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURBdU15Y3NDaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5kR1ZzYkNCaGNIQnNhV05oZEdsdmJpQWlVM2x6ZEdWdElFVjJaVzUwY3lJZ2RHOGdhMlY1YzNSeWIydGxJSEpsZEhWeWJpY3NDaUFnSUNBZ0lDQWdJQ0F2THlEc2w1VHRoTERxc0lBZzdJdWs3S0NjNjZHY0lPdVRwT3lXdE9xd2hDRHFzcjNzbXJEc2w1RHJwNHdnN0plczZyaXdJT3VQaE91THJDanF0b3p0bFp3ZzdKZUc3Snk4NjZtMElPeWNoT3lYa095RW5DRHNwSkhyaTZncElPS0FsQ0R0aExEcnI3anJoSkRzbllRZzdMbVk3SnVNSU91NGpPdWR2T3lhc095Z2dPdW5qQ0RyZ3FqcXVMVHJpNlFLSUNBZ0lDQWdJQ0FnSUNjdFpTY3NJQ2RrWld4aGVTQXhMalVuTEFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QnpaWFFnYldsdWFXRjBkWEpwZW1Wa0lHOW1JR1p5YjI1MElIZHBibVJ2ZHlCMGJ5QjBjblZsSnl3S0lDQWdJQ0FnSUNCZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNLSUNBZ0lDQWdmU0JsYkhObElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z1ptRnNjMlU3SUM4dklPeW5nT3lia0NEc2xZZ2c3WldZNjRxVUlFOVRDaUFnSUNBZ0lIMEtJQ0FnSUNBZ2NtVjBkWEp1SUhSeWRXVTdDaUFnSUNCOUNpQWdmUW9nSUM4dklPMkJ0T3Vobk91VG5DRHFzNFRzb0pVZzY2R2M2cmU0N0pXRTdKdURJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3Wm1JN0oyWUlGdnJvWnpxdDdqc2xZVHNtNE5kSU91eWhPMkt2T3lkdENEdG1ManN0cHd1SUdOc1lYVmtaU0JoZFhSb0lHeHZaMjkxZE95Y3ZPdWhuQ0JEVEVrZzY2R2M2cmU0N0oyNDdKMkVJTzJWdE95Z25PMlZuT3VMcEM0S0lDQXZMeUFvN0oyMElGQkQ3SjJZSU95Z2dPeWVwZXVRbkNEc25wRHFzcW5zcHAzcnFvWHNuWVFnN0tlQTdKcTA2NHVrSU9LQWxDRHJpNlRzaTV3ZzdKT3c2NkNrNjZtMElPeWVyT3Vobk9xM3VPeWR1Q0R0bFlUc21wUXVLU0Ryb1p6cXQ3anNsWVRzbTRNZzdadUU3SmVVSU95RXVPeUZtTUszNnJPRTdLQ1Y3THFRN0l1YzY2VzhJT3lnbGV1bXJPMlZuT3VMcEM0S0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdlkyeGhkV1JsTFd4dloyOTFkQ2NwSUhzS0lDQWdJR052Ym5OMElHeHZJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuWVhWMGFDY3NJQ2RzYjJkdmRYUW5YU3dnZXlCemFHVnNiRG9nZEhKMVpTd2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNLSUNBZ0lHeGxkQ0JsY25JZ1BTQW5KenNLSUNBZ0lHeHZMbk4wWkdWeWNpNXZiaWduWkdGMFlTY3NJQ2hrS1NBOVBpQjdJR1Z5Y2lBclBTQmtMblJ2VTNSeWFXNW5LQ2s3SUgwcE93b2dJQ0FnYkc4dWIyNG9KMlZ5Y205eUp5d2dLR1VwSUQwK0lIc2dhbk52YmloeVpYTXNJRFV3TUN3Z2V5QnZhem9nWm1Gc2MyVXNJR1Z5Y205eU9pQW42NkdjNnJlNDdKV0U3SnVESU95THBPMldpU0RzaTZUdGpLZzZJQ2NnS3lCbExtMWxjM05oWjJVZ2ZTazdJSDBwT3dvZ0lDQWdiRzh1YjI0b0oyTnNiM05sSnl3Z0tHTnZaR1VwSUQwK0lIc0tJQ0FnSUNBZ2EybHNiRkJ5YjJNb0ordWhuT3EzdU95VmhPeWJnKzJWdE95RW5DRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bzdaYUk3SmEwN0pxVUxpY3BPeUF2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NSU9LQWxDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lFdU95Rm1PeWRoQ0Rya0pqc2dyVHJwcXpycWJRZzdKV0lJT3VRcUFvZ0lDQWdJQ0JoWTJOdmRXNTBRMkZqYUdVdVlYUWdQU0F3T3lBZ0lDQWdJQ0FnTHk4ZzY0dWs3SjJNSUM5aFkyTnZkVzUwd3JjdmFHVmhiSFJvN0plUTdJU2NJT3F6aE95Z2xleWRoQ0RzZzRqcm9ad29QZXlYaHV5ZGpPeWN2T3VobkNrZzdKMjk2cktNQ2lBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlHNTFiR3c3SUNBZ0lDQWdJQ0F2THlEc2c0SHRnNXdnN0o2czdZeVE3S0NWS091THBPeWRqQ0R0aExUc2w1RHNoSndnNjYrNDY2R2M2cmU0N0oyNElPcXdrT3luZ0NrS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc2xZVHNtNE1nS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NjcE93b2dJQ0FnSUNCcFppQW9jbVZ6TG1obFlXUmxjbk5UWlc1MEtTQnlaWFIxY200N0lDOHZJR1Z5Y205eUlPMlZ1T3VUcE91ZnJPcXdnQ0RzbmJUcnI3Z2c3SjJSNjR1MTdaYUk3Snk4NjZtMElPeWtrZXV6dFNEcnNLbnNwNEFLSUNBZ0lDQWdhV1lnS0dOdlpHVWdQVDA5SURBcElHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdDaUFnSUNBZ0lHVnNjMlVnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUdWeWNtOXlPaUFvWlhKeUxuUnlhVzBvS1M1emJHbGpaU2d3TENBeE5UQXBLU0I4ZkNBb0oreWloZXVqakNEc3ZaVHJrNXdnSnlBcklHTnZaR1VwSUgwcE93b2dJQ0FnZlNrN0NpQWdJQ0J5WlhSMWNtNDdDaUFnZlFvZ0lDOHZJT3lla09xNHNDRHNvb1hybzR3ZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNCVFZFOVFYMEpTU1VSSFJTL3RsWmp0aXJqcnVZVHRpcmpxc0lBZzdaaTQ3TGFjN1pXYzY0dWtJQ2pyb1p6c3U2enNsNURzaEp6cnA0d2c3S0NSNnJlOElPcXdnT3VLcGUyVm1PdUxpQ0RzbFlqc29JUXBDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM05vZFhSa2IzZHVKeWtnZXdvZ0lDQWdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTQjlLVHNLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb29Ycm80d2c3SnFVN0xLdElPdXdtK3lkakNEaWdKUWc2NHVrNjZhczY2VzhJT3VCbGV1TGlPdUxwQzRuS1RzS0lDQWdJSE5vZFhSMGFXNW5SRzkzYmlBOUlIUnlkV1U3Q2lBZ0lDQnJhV3hzVUhKdll5Z3BPd29nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdDaUFnSUNCeVpYUjFjbTQ3Q2lBZ2ZRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXlaV052YlcxbGJtUW5LU0I3Q2lBZ0lDQmpiMjV6ZENCN0lIUmxlSFFzSUcxdlpHVnNMQ0J5YjJ4bElIMGdQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3dvZ0lDQWdhV1lnS0NGMFpYaDBJSHg4SUNGVGRISnBibWNvZEdWNGRDa3VkSEpwYlNncEtTQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdNQ3dnZXlCbGNuSnZjam9nSit5MmxPeXluT3V3bSt5ZGhDRHJyTGpxdGF6cXNJQWc2N21FN0phMElPeWVpT3lLdGV1TGlPdUxwQzRuSUgwcE93b2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0xhVTdMS2NJT3lhbE95eXJUb25MQ0JUZEhKcGJtY29kR1Y0ZENrdWMyeHBZMlVvTUN3Z05UQXBMbkpsY0d4aFkyVW9MMXh1TDJjc0lDY2dKeWtnS3lBbjRvQ21KeXdnY205c1pTQS9JQ2RiSnlBcklISnZiR1VnS3lBblhTY2dPaUFuSnl3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdZMjl1YzNRZ2NpQTlJR0YzWVdsMElHRnphME5zWVhWa1pTaFRkSEpwYm1jb2RHVjRkQ2t1ZEhKcGJTZ3BMQ0J0YjJSbGJDd2dleUJ3WVhKelpUb2djR0Z5YzJWVGRXZG5aWE4wYVc5dWN5d2dabTl5YldGMFJHVnpZem9nSjF0N0luUmxlSFFpT2lBaTY2eTQ2cldzSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBaWZTd2dMaTR1WFNjZ2ZTd2djbTlzWlNrN0NpQWdJQ0FnSUdOdmJuTjBJSE4xWjJkbGMzUnBiMjV6SUQwZ2NpNXdZWEp6WldRZ2ZId2dXMTA3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGemRXZG5aWE4wYVc5dWN5NXNaVzVuZEdncElIc0tJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPd29nSUNBZ0lDQjlDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c2xZZ2dKeUFySUhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNBcklDZnFzSndnS0NjZ0t5QnpaV01nS3lBbmN5a25LVHNLSUNBZ0lDQWdjM1JoZEhNdWMyVnlkbVZrS3lzN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3dvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVkdWNGRDQTlJRk4wY21sdVp5aDBaWGgwS1M1emJHbGpaU2d3TENBek1DazdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdDaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUhOMVoyZGxjM1JwYjI1ekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPd29nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dld29nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lDZnRnYlRyb1p6cms1d2c3Wmk0N0xhY0lPeUxwTzJNcURvZ0p5a3BPd29nSUNBZ2ZRb2dJSDBLSUNBdkx5RHRsSVRyb0lqc25vVHJzNFFnN0xhVTdMS2NJT0tBbENEdGxad2c3Wm1VNjZtMDdKMkVJTzJWbU95Y2hDRHRsSVRyb0lqc25vUW83SmlCN0pldEtTRHJpNmpzbklUcm9ad2c2NEtZNjRpZ0lPdXdtK3F6b0N3ZzdKaUI3SmV0NjZlSTY0dWtJT3VVc091aG5DRHJqSURzbFlqc25ZUWc2NEs0NjR1a0xnb2dJQzh2SU95WWdleVhyU0RzaUpqcnA0enRnYndnN0pxVTdMS3Q3SjJFSU95cXZPcXduT3luZ0NEc2xZcnJpcFFnNnJLRDdKMjBJTzJWdGV5THJDQW82NHFRNjZDazdLZUE2ck9nSU95Q3JPeWFxZXVmaWV1UGhDRHF0N2pycDR6dGdid2c2NEtZNnJDRTY0dWtLUzRLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2Y21WamIyMXRaVzVrTFdkeWIzVndjeWNwSUhzS0lDQWdJR052Ym5OMElIc2daM0p2ZFhCekxDQnRiMlJsYkN3Z2JXOXlaU0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc0tJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQkJjbkpoZVM1cGMwRnljbUY1S0dkeWIzVndjeWtLSUNBZ0lDQWdQeUJuY205MWNITUtJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tHY3BJRDArSUNoN0NpQWdJQ0FnSUNBZ0lDQWdJRzVoYldVNklGTjBjbWx1Wnlnb1p5QW1KaUJuTG01aGJXVXBJSHg4SUNjbktTNTBjbWx0S0Nrc0NpQWdJQ0FnSUNBZ0lDQWdJSFJsZUhSek9pQW9aeUFtSmlCQmNuSmhlUzVwYzBGeWNtRjVLR2N1ZEdWNGRITXBJRDhnWnk1MFpYaDBjeUE2SUZ0ZEtTNXRZWEFvS0hRcElEMCtJRk4wY21sdVp5aDBJSHg4SUNjbktTNTBjbWx0S0NrcExtWnBiSFJsY2loQ2IyOXNaV0Z1S1N3S0lDQWdJQ0FnSUNBZ0lDQWdjbTlzWlRvZ0tHY2dKaVlnWnk1eWIyeGxLU0EvSUZOMGNtbHVaeWhuTG5KdmJHVXBJRG9nZFc1a1pXWnBibVZrTEFvZ0lDQWdJQ0FnSUNBZ2ZTa3BDaUFnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2huS1NBOVBpQm5MblJsZUhSekxteGxibWQwYUNrS0lDQWdJQ0FnT2lCYlhUc0tJQ0FnSUdsbUlDaHNhWE4wTG14bGJtZDBhQ0E4SURJcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuN0ppQjdKZXQ3SjIwSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRuSUgwcE93b2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3Q2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1pTRTY2Q0k3SjZFNjdPRUlPeTJsT3l5bkNEc21wVHNzcTA2SU95WWdleVhyU0FuSUNzZ2JHbHpkQzVzWlc1bmRHZ2dLeUFuNnJDY0p5QXJJQ2h0YjNKbElEOGdKeUFvNjQyVUlPdXdtK3E0c0NrbklEb2dKeWNwTENCdGIyUmxiQ0EvSUNjbzY2cW82NDI0T2lBbklDc2diVzlrWld3Z0t5QW5LU2NnT2lBbkp5azdDaUFnSUNCMGNua2dld29nSUNBZ0lDQmpiMjV6ZENCeUlEMGdZWGRoYVhRZ1lYTnJSM0p2ZFhCektHeHBjM1FzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpVZHliM1Z3Y3l3Z1ptOXliV0YwUkdWell6b2dKM3NpWjNKdmRYQnpJam9nVzNzaWJtRnRaU0k2SUNMc21JSHNsNjBnN0oyMDY2YUVJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyaklEc2xZZ2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0o5WFgxZGZTY2dmU3dnSVNGdGIzSmxLVHNLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY2k1d1lYSnpaV1E3Q2lBZ0lDQWdJR052Ym5OMElITmxZeUE5SUNnb1JHRjBaUzV1YjNjb0tTQXRJSE4wWVhKMFpXUXBJQzhnTVRBd01Da3VkRzlHYVhobFpDZ3hLVHNLSUNBZ0lDQWdhV1lnS0NGdmRYUXBJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3Q2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJVHJvSWpzbm9UcnM0UWc3S0NjN0pXSUlDY2dLeUJ2ZFhRdWNtVmtkV05sS0NodUxDQm5LU0E5UGlCdUlDc2daeTV6ZFdkblpYTjBhVzl1Y3k1c1pXNW5kR2dzSURBcElDc2dKK3F3bkNBdklPeVlnZXlYclNBbklDc2diM1YwTG14bGJtZDBhQ0FySUNmcXNKd2dLQ2NnS3lCelpXTWdLeUFuY3lrbktUc0tJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPd29nSUNBZ0lDQnpkR0YwY3k1c1lYTjBWR1Y0ZENBOUlDZGI3WlNFNjZDSTdKNkU2N09FWFNBbklDc2dVM1J5YVc1bktDaHNhWE4wV3pCZElDWW1JR3hwYzNSYk1GMHVkR1Y0ZEhOYk1GMHBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQXlOQ2s3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JUWldNZ1BTQnpaV003Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHZHliM1Z3Y3pvZ2IzVjBMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3dvZ0lDQWdmU0JqWVhSamFDQW9aU2tnZXdvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdaU0U2NkNJN0o2RTY3T0VJT3kybE95eW5DRHNpNlR0aktnNkp5d2daUzV0WlhOellXZGxLVHNLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEdG1ManN0cHdnN0l1azdZeW9PaUFuS1NrN0NpQWdJQ0I5Q2lBZ2ZRb2dJQzh2SU8yTW5leVhoU0RzbXBUc2hvenJzNFFnN0xhVTdMS2NJT0tBbENEdGxad2c3WXlkN0plRjdKMllJT3Exck95RXNleWFsT3lHakNqc2w2M3RsYUFyNjZ5NDZyV3NLZXVsdkNEdGxad2c2N0tJN0plUUlPdXdtK3lWaENEc2w2M3RsYURyczRUcm9ad2c2NHVrNjVPczY0cVU2NHVrTGdvZ0lDOHZJT3lhbE95R2pPdWx2Q0R0bGFqcXU1Z2c2N08wNjRLMDdKVzhJTzJEZ095ZHRPMkxnT3lkdENEcnM3anJyTGdnNjZlbDY1Mjk3SjJFSU95d3VPeWhzTzJWb0NEc2lKZ2c3SjZJNjR1a0tPeWFsT3lHak91emhDRHFzSnpyczRRZzdKcVU3TEt0NnJPODdKMllJT3l3cU95ZHRDa3VDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM0psWTI5dGJXVnVaQzF3YjNCMWNDY3BJSHNLSUNBZ0lHTnZibk4wSUhzZ1pXeGxiV1Z1ZEhNc0lHMXZaR1ZzTENCdGIzSmxJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlFRnljbUY1TG1selFYSnlZWGtvWld4bGJXVnVkSE1wSUQ4Z1pXeGxiV1Z1ZEhNdVptbHNkR1Z5S0NobEtTQTlQaUJsSUNZbUlGTjBjbWx1WnlobExuUmxlSFFnZkh3Z0p5Y3BMblJ5YVcwb0tTa2dPaUJiWFRzS0lDQWdJR2xtSUNoc2FYTjBMbXhsYm1kMGFDQThJRElwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW43WXlkN0plRklPeWFsT3lHak9xd2dDRHJ0b0Rzb2JIdGxhbnJpNGpyaTZRdUp5QjlLVHNLSUNBZ0lHTnZibk4wSUhOMFlYSjBaV1FnUFNCRVlYUmxMbTV2ZHlncE93b2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1uZXlYaFNEc3RwVHNzcHdnN0pxVTdMS3RPaURzbXBUc2hvd2dKeUFySUd4cGMzUXViR1Z1WjNSb0lDc2dKK3F3bkNjZ0t5QW9iVzl5WlNBL0lDY2dLT3VObENEcnNKdnF1TEFwSnlBNklDY25LU3dnYlc5a1pXd2dQeUFuS091cXFPdU51RG9nSnlBcklHMXZaR1ZzSUNzZ0p5a25JRG9nSnljcE93b2dJQ0FnZEhKNUlIc0tJQ0FnSUNBZ1kyOXVjM1FnY2lBOUlHRjNZV2wwSUdGemExQnZjSFZ3S0d4cGMzUXNJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlZCdmNIVndMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXV3cWUyV3BTRHRsWndnNjZ5NDdKNmxJaXdnSW1Wc1pXMWxiblJ6SWpvZ1czc2ljbTlzWlNJNklDTHNsNjN0bGFBaUxDQWlkR1Y0ZENJNklDTHJyTGpxdGF3aWZTd2dMaTR1WFgwc0lDNHVMbDE5SnlCOUxDQWhJVzF2Y21VcE93b2dJQ0FnSUNCamIyNXpkQ0J6WlhSeklEMGdjaTV3WVhKelpXUTdDaUFnSUNBZ0lHTnZibk4wSUhObFl5QTlJQ2dvUkdGMFpTNXViM2NvS1NBdElITjBZWEowWldRcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtUc0tJQ0FnSUNBZ2FXWWdLQ0Z6WlhSektTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzdKMlI2NHUxN0oyRUlPMlZ0T3lFbmUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUp5QjlLVHNLSUNBZ0lDQWdmUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5ZDdKZUZJT3lFdU8yS3VDQW5JQ3NnYzJWMGN5NXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3Q2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFFYUWdQU0J1WlhjZ1JHRjBaU2dwTG5SdlRHOWpZV3hsVkdsdFpWTjBjbWx1WnlnbmEyOHRTMUluS1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0FuVysyTW5leVhoVjBnSnlBcklGTjBjbWx1Wnlnb2JHbHpkRnN3WFNBbUppQnNhWE4wV3pCZExuUmxlSFFwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0F5TkNrN0NpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0NpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJSE5sZEhNc0lHVnVaMmx1WlRvZ0oyTnNZWFZrWlNjZ2ZTazdDaUFnSUNCOUlHTmhkR05vSUNobEtTQjdDaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0akozc2w0VWc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3Q2lBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCbWNtbGxibVJzZVVWeWNtOXlLR1VzSUNmdGdiVHJvWnpyazV3ZzdaaTQ3TGFjSU95THBPMk1xRG9nSnlrcE93b2dJQ0FnZlFvZ0lIMEtJQ0F2THlEcmpJRHRtWlR0bUpVZzY2eTQ2cldzSU95Z25PeWVrU0RpZ0pRZzdJT0I3Wm1wN0oyRUlPeUVwT3VxaGUyVm1PdXB0Q0RyckxqcXRhenJwYndnNjZlTTY1T2s3SmEwN0tTQTY0dWtJQ2pzdHBUc3NwenFzN3dnNnJDWjdKMkFJT3lFdU95Rm1Dd2c2NHlBN1ptVTY0cVVJT3VucENEc21wVHNzcTNzbDVBZzdZYTE3S2U0NjZHY0lPeUxwT3VtdkNrS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdlkyOXRjRzl6WlNjcElIc0tJQ0FnSUdOdmJuTjBJSHNnYldWemMyRm5aWE1zSUcxdlpHVnNJSDBnUFNCaGQyRnBkQ0J5WldGa1FtOWtlU2h5WlhFcE93b2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlFRnljbUY1TG1selFYSnlZWGtvYldWemMyRm5aWE1wSUQ4Z2JXVnpjMkZuWlhNdVptbHNkR1Z5S0NodEtTQTlQaUJ0SUNZbUlGTjBjbWx1WnlodExuUmxlSFFnZkh3Z0p5Y3BMblJ5YVcwb0tTa2dPaUJiWFRzS0lDQWdJR2xtSUNnaGJHbHpkQzVzWlc1bmRHZ3BJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOREF3TENCN0lHVnljbTl5T2lBbjY0eUE3Wm1VSU91Q3RPeWFxZXlkdENEcnVZVHNsclFnN0o2STdJcTE2NHVJNjR1a0xpY2dmU2s3Q2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc0tJQ0FnSUdOdmJuTjBJR3hoYzNSVmMyVnlJRDBnV3k0dUxteHBjM1JkTG5KbGRtVnljMlVvS1M1bWFXNWtLQ2h0S1NBOVBpQnRMbkp2YkdVZ0lUMDlJQ2RoYzNOcGMzUmhiblFuS1RzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc29KenNucEVnNjR5QTdabVVJT3lhbE95eXJUb25MQ0JUZEhKcGJtY29LR3hoYzNSVmMyVnlJQ1ltSUd4aGMzUlZjMlZ5TG5SbGVIUXBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQTFNQ2t1Y21Wd2JHRmpaU2d2WEc0dlp5d2dKeUFuS1NBcklDZmlnS1lnS091TWdPMlpsQ0FuSUNzZ2JHbHpkQzVzWlc1bmRHZ2dLeUFuNnJDY0tTY3BPd29nSUNBZ2RISjVJSHNLSUNBZ0lDQWdMeThnNjR5QTdabVU2ckNBSU9xNHVPeVd0T3luZ091cHRDRHN0WnpxdDd3Z01UTHFzSnpycDR3Z0tPMlVoT3Vock8yVWhPMkt1Q0R0ajYzc283d2c2N0NwN0tlQUtRb2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclEyOXRjRzl6WlNoc2FYTjBMbk5zYVdObEtDMHhNaWtzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpVTnZiWEJ2YzJVc0lHWnZjbTFoZEVSbGMyTTZJQ2Q3SW5KbGNHeDVJam9nSXV1TWdPMlpsQ0RzblpIcmk3VWc3WldjNjVHUUlPdXN1T3llcFNJc0lDSnpkV2RuWlhOMGFXOXVjeUk2SUZ0N0luUmxlSFFpT2lBaTY2eTQ2cldzSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBaWZTd2dMaTR1WFgwbklIMHBPd29nSUNBZ0lDQmpiMjV6ZENCdmRYUWdQU0J5TG5CaGNuTmxaRHNLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPd29nSUNBZ0lDQnBaaUFvSVc5MWRDa2dld29nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPeWRrZXVMdGV5ZGhDRHRsYlRzaEozdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpY2dmU2s3Q2lBZ0lDQWdJSDBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeWVrU0RzblpIcmk3VWdLQ2NnS3lCelpXTWdLeUFuY3l3ZzdLQ2M3SldJSUNjZ0t5QnZkWFF1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvSUNzZ0orcXduQ2tuS1RzS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdDaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93b2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWdvYkdGemRGVnpaWElnSmlZZ2JHRnpkRlZ6WlhJdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJRE13S1RzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzS0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2djbVZ3YkhrNklHOTFkQzV5WlhCc2VTd2djM1ZuWjJWemRHbHZibk02SUc5MWRDNXpkV2RuWlhOMGFXOXVjeXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lla1NEc2k2VHRqS2c2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5LU2s3Q2lBZ0lDQjlDaUFnZlFvZ0lDOHZJT3V5aU95WHJTRGlnSlFnN1pXYzZyV3Q3SmEwSU9LR2xDRHNtSUhzbHJRZzdKNlE2NCtaSUNqc3RwVHNzcHpxczd3ZzZyQ1o3SjJBSU95RXVPeUZtQ0RzZ3F6c21xa3BDaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM1J5WVc1emJHRjBaU2NwSUhzS0lDQWdJR052Ym5OMElIc2dkR1Y0ZEN3Z2JXOWtaV3dnZlNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdDaUFnSUNCcFppQW9JWFJsZUhRZ2ZId2dJVk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2twSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW42N0tJN0pldDdaV2dJT3VzdU9xMXJPcXdnQ0RydVlUc2xyUWc3SjZJN0lxMTY0dUk2NHVrTGljZ2ZTazdDaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcnNvanNsNjBnN0pxVTdMS3RPaWNzSUZOMGNtbHVaeWgwWlhoMEtTNXpiR2xqWlNnd0xDQTFNQ2t1Y21Wd2JHRmpaU2d2WEc0dlp5d2dKeUFuS1NBcklDZmlnS1luS1RzS0lDQWdJSFJ5ZVNCN0NpQWdJQ0FnSUdOdmJuTjBJSElnUFNCaGQyRnBkQ0JoYzJ0VWNtRnVjMnhoZEdVb1UzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTd2diVzlrWld3c0lIc2djR0Z5YzJVNklIQmhjbk5sVkhKaGJuTnNZWFJsTENCbWIzSnRZWFJFWlhOak9pQW5leUowY21GdWMyeGhkR1ZrSWpvZ0l1dXlpT3lYcmV1c3VDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpWkdseVpXTjBhVzl1SWpvZ0ltdHY0b2FTWlc0ZzY1aVE2NHFVSUdWdTRvYVNhMjhpZlNjZ2ZTazdDaUFnSUNBZ0lHTnZibk4wSUc5MWRDQTlJSEl1Y0dGeWMyVmtPd29nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdDaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdDaUFnSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUhzZ1pYSnliM0k2SUNmdGdiVHJvWnpyazV3ZzY3S0k3SmV0SU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdDaUFnSUNBZ0lIMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3V5aU95WHJTRHNtWVRybzR3Z0tDY2dLeUJ6WldNZ0t5QW5jeXdnSnlBcklDaHZkWFF1WkdseVpXTjBhVzl1SUh4OElDYy9KeWtnS3lBbktTY3BPd29nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3Q2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURNd0tUc0tJQ0FnSUNBZ2MzUmhkSE11YkdGemRGTmxZeUE5SUhObFl6c0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnZEhKaGJuTnNZWFJsWkRvZ2IzVjBMblJ5WVc1emJHRjBaV1FzSUdScGNtVmpkR2x2YmpvZ2IzVjBMbVJwY21WamRHbHZiaXdnWlc1bmFXNWxPaUFuWTJ4aGRXUmxKeUI5S1RzS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdXlpT3lYclNEc2k2VHRqS2c2Snl3Z1pTNXRaWE56WVdkbEtUc0tJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0Ryc29qc2w2MGc3SXVrN1l5b09pQW5LU2s3Q2lBZ0lDQjlDaUFnZlFvZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQTBMQ0I3SUdWeWNtOXlPaUFuVG05MElHWnZkVzVrSnlCOUtUc0tmU2s3Q2dvdkx5RHNuYlRycjdnZzY0dWs2NmFzNnJDQUlPdVdvQ0Rzbm9qcmlwVHJqYkFnNjVpUUlPeThuT3E0c09xd2dDRHJrNlRzbHJUc21LVHJxYlFvN0tDYzdJcWs3TEtZSU95ZWtPdVBtU0Rzdkp6cXVMQWc3S1NSNjdPMUlPdVRzU2tnN0tHdzdKcXA3WjZJSU95aWhldWpqQ0RpZ0pRZzY0K002NDJZSU91THBPdW1yT3VLbENEcXQ3anJqSURyb1p3ZzdKeWc3S2VBQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXdvZ0lHbG1JQ2hsSUNZbUlHVXVZMjlrWlNBOVBUMGdKMFZCUkVSU1NVNVZVMFVuS1NCN0NpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKMjA2Nis0SU95OG5PeWd1Q0Rzbm9qc2xyVHNtcFFvN1krczdZcTRJQ2NnS3lCUVQxSlVJQ3NnSnlEc2dxenNtcWtnN0tTUktTRGlnSlFnN0oyMElPeWR1T3lLcE8yRXRPeUtwT3VLbENEc29vWHJvNHp0bGFucmk0anJpNlF1SnlrN0NpQWdJQ0J3Y205alpYTnpMbVY0YVhRb01DazdDaUFnZlFvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaEp6cnNvUWc3SmlrNjZXWU9pY3NJR1VnSmlZZ1pTNXRaWE56WVdkbEtUc0tJQ0J3Y205alpYTnpMbVY0YVhRb01TazdDbjBwT3dvdkx5RHNsclRybHFRZzZySzk2NkdjNjZHY0lPeWp2ZXVUb0Nqc2k2enNucVhyc0pYcmo1a2c2NEdLNnJtQUxDQkRkSEpzSzBNc0lDOXphSFYwWkc5M2Jpd2c3SmlrNjZXWUtTQmpiR0YxWkdVZzdKNlE3SXVkN0oyRUlPdUNxT3E0c095bmdDRHNsWXJyaXBUcmk2UUtjSEp2WTJWemN5NXZiaWduWlhocGRDY3NJQ2dwSUQwK0lIc2dhMmxzYkZCeWIyTW9LVHNnYTJsc2JFeHZaMmx1VUhKdll5Z3BPeUI5S1RzS2NISnZZMlZ6Y3k1dmJpZ25VMGxIU1U1VUp5d2dLQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwS1RzS2NISnZZMlZ6Y3k1dmJpZ25VMGxIVkVWU1RTY3NJQ2dwSUQwK0lIQnliMk5sYzNNdVpYaHBkQ2d3S1NrN0NncHpaWEoyWlhJdWJHbHpkR1Z1S0ZCUFVsUXNJQ2N4TWpjdU1DNHdMakVuTENBb0tTQTlQaUI3Q2lBZ1kyOXVjMjlzWlM1c2IyY29KK0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0NjcE93b2dJR052Ym5OdmJHVXViRzluS0NjZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93b2dJR052Ym5OdmJHVXViRzluS0NjZzY2cW82NDI0T2lBbklDc2dRMHhCVlVSRlgwMVBSRVZNSUNzZ0p5REN0eURzbUlqc2k1d2dKeUFySUVWWVFVMVFURVZUTG14bGJtZDBhQ0FySUNmcXNiUWc3SjZsN0xDcEp5azdDaUFnWTI5dWMyOXNaUzVzYjJjb0p5RHNuYlFnN0xDOTdKMkVJT3k4bk91UmxDRHJqNW5zbFlnZzdaUzg2cmU0NjZlSUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEdGdiVHJvWnpyazV6cm9ad2c3TGFVN0xLYzdaV3A2NHVJNjR1a0xpY3BPd29nSUdOdmJuTnZiR1V1Ykc5bktDZmlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFuS1RzS0lDQmphR1ZqYTBOc1lYVmtaVUYyWVdsc1lXSnNaU2dwT3lBdkx5QkRiR0YxWkdVZ1EyOWtaU0RzZ3F6c21xa2c2ckNBNjRxbElPeVhyT3UyZ0NEc29KRHFzb0FnS08yVWpPdWZyT3EzdU95ZHVDRHNsWWpyZ3JUc21xa3BDaUFnTHk4ZzY2KzQ2NmFzSU95TG5PdVBtU0FySU95bmdPeUxuT3VzdUNEc283enNub1VnNG9DVUlPeXlxeURzdHBUc3NwenJ0b0R0aExBZzY3bWc2NlcwNnJLTUNpQWdZWE5yUTJ4aGRXUmxLQ2ZzbTR6cnNJM3NsNFU2SUNMc29JRHNucVVnNjVDWTdKZUk3SXExNjR1STY0dWtJaWNwTG5Sb1pXNG9DaUFnSUNBb0tTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeVpoT3VqakNEaWdKUWc3TGFVN0xLY0lPeWtnT3U1aENEcmdaMHVKeWtzQ2lBZ0lDQW9aU2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3liak91d2pleVhoU0RzaTZUdGpLZ2dLT3l5cXlEc21wVHNzcTBnNjVXTUlPeWVyT3lMbk91UGhDazZKeXdnWlM1dFpYTnpZV2RsS1FvZ0lDazdDbjBwT3dvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJRzFoWTA5VElPdVRzZXlYa095RW5DQW5iRzlqWVd4b2IzTjBKK3F3Z0NBNk9qSHJvWndnNjZpODdLQ0FJTzJWdE95RW5ldVFtT3VLbE91TnNBb3ZMeUR0bEx6cXQ3anJwNGdvUld4bFkzUnliMjRwSUdabGRHTm82NHFVSUdOMWNtenFzN3dnNjR1czY2YXNJRWxRZGpUcm9ad2c3SjZRNjQrWklPMlB0T3V3c2UyVm1PeW5nQ0RzbFlyc2xZUXNJRWxRZGpUcnA0d2c2NU9qNjQyWUlPdUxwT3Vtck95WGtDRHNsN0Rxc3JEc25iUWc2ckd3NjdhQTY0KzhDaTh2SU95MmxPeXluTUszN1plczdJcWs3TEswN1lHczZyQ0FJT3loc095YXFlMmVpQ0RzaTZUdGpLanRsb2pyaTZRbzdJdWs3TGloSURJd01qWXRNRGNwTGlEcXNKbnNuWUFnN0pxVTdMS3RJTzJWdU91VHBPdWZyT3VsdkNCSlVIWTJJT3VqcU8yVWhPdXdzZXlYa091UGhDRHNscm5yaXBUcmk2UXVDbU52Ym5OMElITmxjblpsY2pZZ1BTQm9kSFJ3TG1OeVpXRjBaVk5sY25abGNpaHpaWEoyWlhJdWJHbHpkR1Z1WlhKektDZHlaWEYxWlhOMEp5bGJNRjBwT3dwelpYSjJaWEkyTG05dUtDZGxjbkp2Y2ljc0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGdTVkIyTmlnNk9qRXBJT3Vtck95S3FDRHNnNTNybnJVZzRvQ1VJRWxRZGpUcnA0d2c3SUtzN0pxcE9pY3NJR1VnSmlZZ1pTNXRaWE56WVdkbEtTazdDbk5sY25abGNqWXViR2x6ZEdWdUtGQlBVbFFzSUNjNk9qRW5LVHNLJwpCNjRfV0FUQ0hFUj0nTHk4ZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzRvQ1VJTzJWcmV5RGdTRHJscUFnN0o2STY0cVVJT3kwaU95R2pPMllsU0RzaEp6cnNvUWdLR3h2WTJGc2FHOXpkRG94TVRnNE9Ta05DaTh2SU9LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdBMEtMeThnN0ptY0lPMlZoT3lhbE8yVm5PcXdnRG9nN1pTODZyZTQ2NmVJNnJDQUlPMlVqT3Vmck9xM3VPeWR1T3lkbUNCamJHRjFaR1ZpY21sa1oyVTZMeThnN0plMDZyaXdLSGRwYm1SdmR5NXZjR1Z1TDJsbWNtRnRaUzl2Y0dWdVJYaDBaWEp1WVd3cDY2VzhEUW92THlEc29JVHJ0b0FnN0lhTTY2YXNJT3lYaHV5ZHRDRHJwNG5yaXBRZzY3S0U3S0NFN0oyMElPeWVpT3VMcEM0Z1ptVjBZMmpyaXBRZzY2cTdJT3VuaWV5Y3ZPdXZnT3VobkN3ZzdaU002NStzNnJlNDdKMjQ3SjIwSU95ZHRDRHFzSkRzaTV6c25wRHNsNURxc293TkNpOHZJRkJQVTFRZ0wzZGhhMlVnNjZXOElPdXp0T3VDdE91cHRDRHFzSkRzaTV6c25wRHFzSUFnNjR1azY2YXNLR05zWVhWa1pTMWljbWxrWjJVdWFuTXA2Nlc4SU91TWdPeUxvQ0RzdktEcmk2UXVEUW92THcwS0x5OGc2NHVrNjZhczdKbUE3SjJZSU95d3FPeWR0RG9nNnJDUTdJdWM3SjZRNjRxVUlHTnNZWFZrWmV1bHZDRHJyTHpzcDRBZzdKV0s2NHFVNjR1a0tPeWVrT3lMblNEc2w0YnNuWXdwSU9LR2tpRHRnYlRyb1p6cms1d2c3Sld4SU95WGhldU5zT3lkdE8yS3VPdWx2Q0RzbFlnZzY2ZUo2ck9nTEEwS0x5OGc2Nm1VNjZxbzY2YXNJSDR4TlUxQzY1MjhJT3Vobk9xM3VPeWR1Q0RzaTV3ZzdKNlE2NCtaSU95TG5PeWVrZXljdk91aG5DRHNnNEhzaTV3ZzdMeWM2NUdzNjQrRUlPdTJnT3VMdENEc2w0YnJpNlFnS091VHNldWhuVG9nYm5CdElISjFiaUJpZFdsc1pDa3VEUW92THlEcmk2VHJwcXpyaXBRZzdJdXM3SjZsNjdDVjY0K1pJT3VCaXVxNHNPdXB0Q0Rzbzczc3A0RHJwNHdvN1pTTTY1K3M2cmU0N0oyNDZyTzhJT3lEbmV5Q3JDRHJqNW5xdUxEdG1aUXBMQ0Rxc0pEc2k1enNucERyaXBRZzZyT0U3SWFOSU91Q3FPeVZoQ0RyaTZUc25Zd2c2cm1vN0pxdzZyaXc2Nlc4SU91d20rdUtsT3VMcEM0TkNnMEtZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNOQ21OdmJuTjBJSEJoZEdnZ1BTQnlaWEYxYVhKbEtDZHdZWFJvSnlrN0RRcGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0RRcGpiMjV6ZENCdmN5QTlJSEpsY1hWcGNtVW9KMjl6SnlrN0RRcGpiMjV6ZENCN0lITndZWGR1TENCemNHRjNibE41Ym1NZ2ZTQTlJSEpsY1hWcGNtVW9KMk5vYVd4a1gzQnliMk5sYzNNbktUc05DZzBLWTI5dWMzUWdVRTlTVkNBOUlERXhPRGc1T3cwS1kyOXVjM1FnVWs5UFZDQTlJSEJoZEdndWFtOXBiaWhmWDJScGNtNWhiV1VzSUNjdUxpY3BPeUF2THlEc29JRHNucVhzaG93ZzY2T283WXE0SU9LQWxDRHJpNlRycHF6cXNJQWdjbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrNjZXOElPeXd2dXVLbENEcXVMRHNwSUFOQ2cwS1kyOXVjM1FnUTA5U1UxOUlSVUZFUlZKVElEMGdldzBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUM0pwWjJsdUp6b2dKeW9uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0VFdWMGFHOWtjeWM2SUNkSFJWUXNJRkJQVTFRc0lFOVFWRWxQVGxNbkxBMEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFNHVmhaR1Z5Y3ljNklDZERiMjUwWlc1MExWUjVjR1VuTEEwS2ZUc05DbVoxYm1OMGFXOXVJR3B6YjI0b2NtVnpMQ0J6ZEdGMGRYTXNJRzlpYWlrZ2V3MEtJQ0J5WlhNdWQzSnBkR1ZJWldGa0tITjBZWFIxY3l3Z1QySnFaV04wTG1GemMybG5iaWg3SUNkRGIyNTBaVzUwTFZSNWNHVW5PaUFuWVhCd2JHbGpZWFJwYjI0dmFuTnZianNnWTJoaGNuTmxkRDExZEdZdE9DY2dmU3dnUTA5U1UxOUlSVUZFUlZKVEtTazdEUW9nSUhKbGN5NWxibVFvU2xOUFRpNXpkSEpwYm1kcFpua29iMkpxS1NrN0RRcDlEUW9OQ2k4dklHTnNZWFZrWlNCRFRFbnFzSUFnN0o2STY0cVU3S2VBSU9LQWxDRHNsNGJzbkx6cnFiUWdMM2RoYTJVZzdKMlI2NHUxN0plUUlPeUxwT3lXdENEdGxJenJuNnpxdDdqc25ianNuYlFnN0pXSTY0SzA3WldnSU95SW1DRHNub2pxc293ZzdaV2M2NHVrRFFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJT3lkdmVxNHNDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56SUNqcmk2VHJwcXpzblpnZ1kyeGhkV1JsUVdOamIzVnVkT3laZ0NEcXNKbnNuWUFnN0xhYzdMS1lLUzROQ2k4dklPMk1qT3lkdk95ZHRDRHRnYlFnN0lpWUlPeWVpT3lXdENBek1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLTHk4ZzdMcVE3SXVjSURYc3RJZ2c0b0NVSU91aG5PcTN1T3lkdUNEc3A0SHRtNFFnN0lPSUlPcXpoT3lnbGV5ZHRDRHFzNmZyc0pUcm9ad2c3SjZoN1ppQTdKVzhJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKZVE3SVNjSU8yWmlPeWN2T3VobkNEcmhKanNsclRxc0lUcmk2UW9NekRzdElqcnFiUWc2NFNJNjZ5MElPdUtwdXlkakNrTkNteGxkQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lBd0xDQmxiV0ZwYkRvZ2JuVnNiQ0I5T3cwS1puVnVZM1JwYjI0Z1kyeGhkV1JsUVdOamIzVnVkQ2dwSUhzTkNpQWdhV1lnS0VSaGRHVXVibTkzS0NrZ0xTQmhZMk52ZFc1MFEyRmphR1V1WVhRZ1BDQTFNREF3S1NCeVpYUjFjbTRnWVdOamIzVnVkRU5oWTJobExtVnRZV2xzT3cwS0lDQnNaWFFnWlcxaGFXd2dQU0J1ZFd4c093MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJR29nUFNCS1UwOU9MbkJoY25ObEtHWnpMbkpsWVdSR2FXeGxVM2x1WXlod1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuTG1Oc1lYVmtaUzVxYzI5dUp5a3NJQ2QxZEdZNEp5a3BPdzBLSUNBZ0lHVnRZV2xzSUQwZ0tHb2dKaVlnYWk1dllYVjBhRUZqWTI5MWJuUWdKaVlnYWk1dllYVjBhRUZqWTI5MWJuUXVaVzFoYVd4QlpHUnlaWE56S1NCOGZDQnVkV3hzT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHJvWnpxdDdqc25iZ2c3SjIwNjZDbElPeVhodXlkakNEcms3RWc0b0NVSUc1MWJHd2dLaThnZlEwS0lDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUJFWVhSbExtNXZkeWdwTENCbGJXRnBiQ0I5T3cwS0lDQnlaWFIxY200Z1pXMWhhV3c3RFFwOURRb05DbVoxYm1OMGFXOXVJR2hoYzBOc1lYVmtaU2dwSUhzTkNpQWdZMjl1YzNRZ1ptbHVaR1Z5SUQwZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5QS9JQ2QzYUdWeVpTY2dPaUFuZDJocFkyZ25PdzBLSUNCMGNua2dleUJ5WlhSMWNtNGdjM0JoZDI1VGVXNWpLR1pwYm1SbGNpd2dXeWRqYkdGMVpHVW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhOb1pXeHNPaUIwY25WbElIMHBMbk4wWVhSMWN5QTlQVDBnTURzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnY21WMGRYSnVJR1poYkhObE95QjlEUXA5RFFvTkNteGxkQ0IzWVd0cGJtY2dQU0JtWVd4elpUc2dMeThnN0pldzdZT0FJT3V3cWV5bmdDRGlnSlFnNjR1azY2YXM2NHFVSU95V3RPeXdxTzJVdkNCRlFVUkVVa2xPVlZORjY2R2NJT3lra2V1enRTRHNvSlhycHF6dGxaanNwNERycDR3ZzdaU0U2NkdjN0lTNDdJcWtJT3VDcmV1NWhPdWx2Q0RzcElUc25ianJpNlFOQ21aMWJtTjBhVzl1SUhkaGEyVkNjbWxrWjJVb0tTQjdEUW9nSUdsbUlDaDNZV3RwYm1jcElISmxkSFZ5YmpzTkNpQWdkMkZyYVc1bklEMGdkSEoxWlRzTkNpQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdJSGRoYTJsdVp5QTlJR1poYkhObE95QjlMQ0ExTURBd0tUc05DaUFnYkdWMElIQnliMk03RFFvZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2dJQ0FnTHk4Z1YybHVaRzkzY3pvZ1kyMWt3cmQyWW5NZzZySzk3SnlnSU95WGh1eWR0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTd2dkMmx1Wkc5M2MwaHBaR1VvUTFKRlFWUkZYMDVQWDFkSlRrUlBWeW5yb1p3ZzdJcWs3WSt3SU9LQWxBMEtJQ0FnSUM4dklPeXd2U0RzbDRicmlwUWc3SWlvN0oyQUlPeTltT3lHbE95ZHRDRHJwNHpyazZUc2xyVHNwNERxczZBZzY0dWs2NmFzN0oyWUlPeWVrT3lMblNoamJHRjFaR1VwNjQrRUlPcTN1Q0Rzdlpqc2hwVHNuWVFnNjZ5ODY2Q2s2N0NiN0pXRUlPeVd0T3VXcENEc3NMM3JqNFFnN0pXSUlPdWNyT3VMcEM0TkNpQWdJQ0F2THlCa1pYUmhZMmhsWk91S2xDRHNrN0RzcDRBZzdKV0s2NHFVNjR1a0tHUmxkR0ZqYUdWa0szZHBibVJ2ZDNOSWFXUmxJT3loc08yVnFleWRnQ0Rzdlpqc2hwUWc3TEM5N0oyMElPdUZ1T3kybk91UXFDRGlnSlFnN0l1azdMaWhLUzROQ2lBZ0lDQXZMeUJYYVc1a2IzZHo3SmVRN0lTZ0lHUmxkR0ZqYUdWa0lPeVhodXlkdE91UGhDRHJ0b0RycXFnbzZyQ1E3SXVjN0o2UUtlcXdnQ0Rzbzczc2xyVHJqNFFnN0o2UTdJdWQ3SjJBSU95Q3RPeVZoT3VDcU91S2xPdUxwQzROQ2lBZ0lDQndjbTlqSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3RFFvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VzRFFvZ0lDQWdmU2s3RFFvZ0lIMGdaV3h6WlNCN0RRb2dJQ0FnTHk4Z2JXRmpUMU12NjZhczY0aUY3SXFrT2lEcXNKRHNpNXpzbnBEcnBid2c2NTJFN0pxMElHNXZaR1VnN0l1azdaYUpJTzJNak95ZHZPdWhuQ0RzcDRIc29KRWc3SXFrN1krd0lDaHNZWFZ1WTJoa0lPMlptT3F5dmV5WGxDQlFRVlJJNnJDQUlPdTVpT3lWdmUyVm9DRHNpSmdnN0o2STdKYTBJT3lnaU91TWdPcXl2ZXVobkNEc2dxenNtcWtwRFFvZ0lDQWdjSEp2WXlBOUlITndZWGR1S0hCeWIyTmxjM011WlhobFkxQmhkR2dzSUZ0d1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5ZMnhoZFdSbExXSnlhV1JuWlM1cWN5Y3BYU3dnZXcwS0lDQWdJQ0FnWTNka09pQlNUMDlVTENCa1pYUmhZMmhsWkRvZ2RISjFaU3dnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQTBLSUNBZ0lIMHBPdzBLSUNCOURRb2dJSEJ5YjJNdWRXNXlaV1lvS1RzZ0x5OGc2ckNRN0l1YzdKNlFJT3lkdE91eXBPMkt1Q0RybzZqdGxJVHNsNURzaEp3ZzY3YUU2NmFzSUNqcXNKRHNpNXpzbnBBZzdLS0Y2Nk9NNjZXOElPdW5pZXluZ0NEc2xZcnFzb3dwRFFwOURRb05DaTh2SU95ZHRDQlFRK3VsdkNBbjdJU2s3TG1ZSU95Z2hDanNnNGdnVUVNcEp5RHNnNEh0ZzV6cm9ad2c2NUNZNjQrTTY2YXc2NHVrSU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnVyt5MGlPcTRzTzJabEYwZzY3S0U3WXE4S0ZCUFUxUWdMM1Z1YVc1emRHRnNiQ25zbmJRZzY3YUE2Nlc0NjR1a0xnMEtMeThnY21WbmFYTjBaWEl0Y0hKdmRHOWpiMnd1YW5QcXNJQWc3SVNrN0xtWTdaV2NJT3F5Zyt5ZGhDRHF0N2pyaklEcm9ad2c2NUNZNjQrTTY2YXc2NHVrT2lEcXNKRHNpNXpzbnBBZzdKNlE2NCtaN0l1YzdKNlJJQ3NnS095ZWlPeWN2T3VwdENrZzdJU2s3TG1ZSU8yUHRPdU5sQzROQ2k4dklPS2FvTys0anlEcnNKanJrNXpzaTV3Z1NGUlVVQ0RzblpIcmk3WHNuWVFnNjZpODdLQ0FJT3V6dE91Q3VDRHJrcVFnN1ppNDdMYWM3WldnSU9xeWd5RGlnSlFnYldGalQxTWdiR0YxYm1Ob1kzUnNJR0p2YjNSdmRYVHNuYlFnN0oyMElPMlVoT3Vobk95RXVPeUtwT3VsdkNEc3BvbnNpNXdnN0tLRjY2T003SXVjN1lLc0lPeUltQ0Rzbm9qcmk2UXVEUW92THlBZ0lDRHF0N2pybnBqc2hKd2c3WXlNN0oyOEtIQnNhWE4wd3Jmc2hLVHN1WmdnN1krMDY0MlVLZXlkaENCc1lYVnVZMmhqZEd6cnM3VHJpNlFnNjZpODdLQ0FJT3luZ095YXRPdUxwQ0RpZ0pRZ1ltOXZkRzkxZE95ZHRDRHNtckRycHF6cnBid2c3S085N0plczY0K0VJT3lla091UG1leUxuT3lla2V5ZGdDRHNuYlRycjdnZzdJS3M2NTI4N0tlRTY0dWtMZzBLWm5WdVkzUnBiMjRnZFc1cGJuTjBZV3hzVTJWc1ppZ3BJSHNOQ2lBZ1kyOXVjM1FnY21WdGIzWmxaQ0E5SUZ0ZE93MEtJQ0IwY25rZ2V3MEtJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuWkdGeWQybHVKeWtnZXcwS0lDQWdJQ0FnWTI5dWMzUWdURUZDUlV3Z1BTQW5ZMjl0TG1Oc1lYVmtaV0p5YVdSblpTNTNZWFJqYUdWeUp6c05DaUFnSUNBZ0lHTnZibk4wSUhCc2FYTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua25MQ0FuVEdGMWJtTm9RV2RsYm5Sekp5d2dURUZDUlV3Z0t5QW5MbkJzYVhOMEp5azdEUW9nSUNBZ0lDQmpiMjV6ZENCcGJuTjBJRDBnY0dGMGFDNXFiMmx1S0c5ekxtaHZiV1ZrYVhJb0tTd2dKMHhwWW5KaGNua25MQ0FuUVhCd2JHbGpZWFJwYjI0Z1UzVndjRzl5ZENjc0lDZERiR0YxWkdWQ2NtbGtaMlVuS1RzTkNpQWdJQ0FnSUhSeWVTQjdJR2xtSUNobWN5NWxlR2x6ZEhOVGVXNWpLSEJzYVhOMEtTa2dleUJtY3k1MWJteHBibXRUZVc1aktIQnNhWE4wS1RzZ2NtVnRiM1psWkM1d2RYTm9LSEJzYVhOMEtUc2dmU0I5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DaUFnSUNBZ0lIUnllU0I3SUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0dsdWMzUXBLU0I3SUdaekxuSnRVM2x1WXlocGJuTjBMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU3dnWm05eVkyVTZJSFJ5ZFdVZ2ZTazdJSEpsYlc5MlpXUXVjSFZ6YUNocGJuTjBLVHNnZlNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQWdJSFJ5ZVNCN0lITndZWGR1VTNsdVl5Z25iR0YxYm1Ob1kzUnNKeXdnV3lkaWIyOTBiM1YwSnl3Z0oyZDFhUzhuSUNzZ2NISnZZMlZ6Y3k1blpYUjFhV1FvS1NBcklDY3ZKeUFySUV4QlFrVk1YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlEwS0lDQWdJQ0FnZEhKNUlIc2djM0JoZDI1VGVXNWpLQ2RzWVhWdVkyaGpkR3duTENCYkozSmxiVzkyWlNjc0lFeEJRa1ZNWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjZ2ZTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUgwZ1pXeHpaU0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dldzBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1RXbGpjbTl6YjJaMFhGeFhhVzVrYjNkelhGeERkWEp5Wlc1MFZtVnljMmx2Ymx4Y1VuVnVKeXdnSnk5Mkp5d2dKME5zWVhWa1pVSnlhV1JuWlZkaGRHTm9aWEluTENBbkwyWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lISmxiVzkyWldRdWNIVnphQ2duN0o2UTY0K1o3SXVjN0o2UktFTnNZWFZrWlVKeWFXUm5aVmRoZEdOb1pYSXBKeWs3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHlaV2NuTENCYkoyUmxiR1YwWlNjc0lDZElTME5WWEZ4VGIyWjBkMkZ5WlZ4Y1EyeGhjM05sYzF4Y1kyeGhkV1JsWW5KcFpHZGxKeXdnSnk5bUoxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5JSDBwT3lCeVpXMXZkbVZrTG5CMWMyZ29KMk5zWVhWa1pXSnlhV1JuWlRvdkx5RHJrN0hyb1owbktUc2dmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnSUNCMGNua2dldzBLSUNBZ0lDQWdJQ0JqYjI1emRDQnBibk4wSUQwZ2NHRjBhQzVxYjJsdUtIQnliMk5sYzNNdVpXNTJMa3hQUTBGTVFWQlFSRUZVUVNCOGZDQndZWFJvTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBblFYQndSR0YwWVNjc0lDZE1iMk5oYkNjcExDQW5RMnhoZFdSbFFuSnBaR2RsSnlrN0RRb2dJQ0FnSUNBZ0lHbG1JQ2htY3k1bGVHbHpkSE5UZVc1aktHbHVjM1FwS1NCN0lHWnpMbkp0VTNsdVl5aHBibk4wTENCN0lISmxZM1Z5YzJsMlpUb2dkSEoxWlN3Z1ptOXlZMlU2SUhSeWRXVWdmU2s3SUhKbGJXOTJaV1F1Y0hWemFDaHBibk4wS1RzZ2ZRMEtJQ0FnSUNBZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdmUTBLSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lCbVlXbHNMWE52Wm5RZzRvQ1VJT3VxdXlEc3A0RHNtclFnNnJLTUlPeWVpT3lXdE91UGhDRHRsSXpybjZ6cXQ3anNuYmdnN0txOUlPcTRzT3lXdFNEc2dxM3NvSnpyaXBRZzdKMjA2Nis0SU91Qm5ldUNyT3VMcENBcUx5QjlEUW9nSUhKbGRIVnliaUJ5WlcxdmRtVmtPdzBLZlEwS0RRb3ZMeURyaTZUcnBxd29NVEU0T0RncDZyQ0FJT3VXb0NEc25vanNuTHpycWJRZzY0R0k2NHVrSU9LQWxDRHN0SWpxdUxEdG1aUWc3SXVjSU91Q3FPeWRnQ0RzaExqc2haZ2c3S0NWNjZhc0lDanNsNGJzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lMcE8yTXFDa05DbVoxYm1OMGFXOXVJSE5vZFhSa2IzZHVRbkpwWkdkbEtDa2dldzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUhJZ1BTQm9kSFJ3TG5KbGNYVmxjM1FvZXlCb2IzTjBPaUFuTVRJM0xqQXVNQzR4Snl3Z2NHOXlkRG9nTVRFNE9EZ3NJSEJoZEdnNklDY3ZjMmgxZEdSdmQyNG5MQ0J0WlhSb2IyUTZJQ2RRVDFOVUp5d2dkR2x0Wlc5MWREb2dNVFV3TUNCOUxDQW9LU0E5UGlCN2ZTazdEUW9nSUNBZ2NpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnbmRHbHRaVzkxZENjc0lDZ3BJRDArSUhzZ2RISjVJSHNnY2k1a1pYTjBjbTk1S0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlNCOUtUc05DaUFnSUNCeUxtVnVaQ2dwT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNuME5DZzBLWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9LSEpsY1N3Z2NtVnpLU0E5UGlCN0RRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwTkNpQWdhV1lnS0hKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoYkhSb0p5a2dldzBLSUNBZ0lDOHZJSFk2SU9xd2tPeUxuT3lla0NEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENEcXRhenJzb1Rzb0lRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU9xemhPeUdqU0RyajR6cXM2QWc3SjZJNjRxVTdLZUFJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsWmpyaXBRZzdKcXA2NCtFRFFvZ0lDQWdMeThnS0hZeUlEMGc3TEM5SU95SXFPcTVnQ0RzaUpqc29KWHRqSkFzSUhZeklEMGdMMkZqWTI5MWJuUWc3TGFVNnJDQTdZeVFMQ0IyTkNBOUlDOTFibWx1YzNSaGJHd2c3TGFVNnJDQTdZeVFLUTBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCM1lYUmphR1Z5T2lCMGNuVmxMQ0IyT2lBMElIMHBPdzBLSUNCOURRb2dJQzh2SU95ZHRDQlFRK3lYa0NEcm9aenF0N2pzbmJqcmtKd2c3WUcwNjZHYzY1T2NJT3F6aE95Z2xTRGlnSlFnN1pTTTY1K3M2cmU0N0oyNElPeXlxeUR0bVpUcnFiVEN0KzJaaU95ZHRDQWk2NGlFNnJXc0lPcXpoT3lnbGV5Y3ZPdWhuQ0RzazdEcmlwVHNwNEFpSU91enRPeVhyT3lqdk91S2xDRHJqYkFnN0pPMDY0dWtMZzBLSUNBdkx5RHFzSkRzaTV6c25wRHFzSUFnNjR1MTdaV1k2NHFVSU95ZHRPeWNvRG9nNjR1azY2YXM2Nlc4SU95OG5PdXB0Q0RzbTR6cnNJM3NsNFhzbkx6cm9ad2c3WUcwNjZHYzY1T2M2ckNBSU95THBPeWduQ0R0bUxqc3RwenJqN3dnNnJXczY0K0ZJT3lDck95YXFldWZpZXlkdENEcmdwanFzSVRyaTZRdURRb2dJQzh2SU9xd2tPeUxuT3lla091S2xDRHRqSXpzbmJ6cnA0d2c3SjI5N0p5ODY2K0E2NkdjSU95Q3JPeWFxZXVmaVNBd0lNSzNJT3VNZ09xNHNDQXdJT0tBbENEcXNvRHRocURycDR3ZzdKT3c2NHFVSU95Q3JPdWVqT3lYa09xeWpDRHJ1WVRzbXFuc25ZUWc2Nnk4NjZhczdLZUFJT3lWaXV1S2xPdUxwQzROQ2lBZ0x5OGc3S084N0oyWU9pRHNsNnpxdUxBZzZyT0U3S0NWN0oyMElPdXp0T3lYck91UGhDRHNub1hzbnFYcXRvenNuYlFnNjZlTTY2T002NUNRN0oyRUlPeUltQ0Rzbm9qcmk2UW83SnlnN1pxbzdJU3g3SjJBSU95THBPeWduQ0R0bUxqc3Rwd2c2NVdNNjZlTUlPeVZqQ0RzaUpnZzdKNkk3SjJNSU9LQWxDRHJpNlRycHF3Z0wyaGxZV3gwYU95ZG1DQndjbTlpYkdWdElPeXd1T3F6b0NrdURRb2dJR2xtSUNoeVpYRXVkWEpzSUQwOVBTQW5MMkZqWTI5MWJuUW5LU0I3RFFvZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVc0lHRmpZMjkxYm5RNklHTnNZWFZrWlVGalkyOTFiblFvS1N3Z1kyeGhkV1JsT2lCb1lYTkRiR0YxWkdVb0tTQjlLVHNOQ2lBZ2ZRMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZkMkZyWlNjcElIc05DaUFnSUNCcFppQW9JV2hoYzBOc1lYVmtaU2dwS1NCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0YldsemMybHVaeWNnZlNrN0RRb2dJQ0FnZDJGclpVSnlhV1JuWlNncE93MEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0IzWVd0cGJtYzZJSFJ5ZFdVZ2ZTazdEUW9nSUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzTm9kWFJrYjNkdUp5a2dldzBLSUNBZ0lHcHpiMjRvY21WekxDQXlNREFzSUhzZ2IyczZJSFJ5ZFdVZ2ZTazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURJd01DazdEUW9nSUNBZ2NtVjBkWEp1T3cwS0lDQjlEUW9nSUM4dklPeTBpT3E0c08yWmxDRGlnSlFnN0oyMElGQkQ2Nlc4SUNmc2c0Z2dVRU1uSU95RGdlMkRuT3VobkNEcmtKanJqNHpycHJEcmk2UWdLTzJVak91ZnJPcTN1T3lkdUNCYjdMU0k2cml3N1ptVVhTRHJzb1R0aXJ3cExnMEtJQ0F2THlEc25aSHJpN1hzbllRZzY2aTg3S0NBSU8yZG1PdWdwT3V6dE91Q3VDRHJrcVFnN0tDVjY2YXM3WldjNjR1a0lPS0FsQ0JpYjI5MGIzVjA3SjIwSU95YXNPdW1yT3VsdkNEc3BvbnNpNXdnN0tPOTdKZXM2NCtFSU8yYWpPeUxvT3lkZ0NEcmo0VHNzS250bFp6cmk2UXVEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTkxYm1sdWMzUmhiR3duS1NCN0RRb2dJQ0FnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnY0d4aGRHWnZjbTA2SUhCeWIyTmxjM011Y0d4aGRHWnZjbTBnZlNrN0RRb2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3RFFvZ0lDQWdJQ0J6YUhWMFpHOTNia0p5YVdSblpTZ3BPdzBLSUNBZ0lDQWdZMjl1YzNRZ2NtVnRiM1psWkNBOUlIVnVhVzV6ZEdGc2JGTmxiR1lvS1RzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJkMkYwWTJobGNsMGc3TFNJNnJpdzdabVVLSFZ1YVc1emRHRnNiQ2tnNG9DVUlPeWduT3F4c0RvbkxDQnlaVzF2ZG1Wa0xtcHZhVzRvSnl3Z0p5a2dmSHdnSnlqc2w0YnNuWXdwSnlrN0RRb2dJQ0FnSUNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhCeWIyTmxjM011WlhocGRDZ3dLU3dnTWpBd0tUc05DaUFnSUNCOUxDQXlOVEFwT3cwS0lDQWdJSEpsZEhWeWJqc05DaUFnZlEwS0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEUXdOQ3dnZXlCbGNuSnZjam9nSjA1dmRDQm1iM1Z1WkNjZ2ZTazdEUXA5S1RzTkNnMEtMeThnN0oyMDY2KzRJT3VXb0NEc25vanNuTHpycWJRZzdLR3c3SnFwN1o2SUlPeWloZXVqakNBbzdKNlE2NCtaSU95TG5PeWVrU0FySUc1d2JTQmlkV2xzWkNEc3BKSHJzN1VnN0l1azdaYUpJT3VNZ091NWhDa05Dbk5sY25abGNpNXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdldzBLSUNCcFppQW9aU0FtSmlCbExtTnZaR1VnUFQwOUlDZEZRVVJFVWtsT1ZWTkZKeWtnY0hKdlkyVnpjeTVsZUdsMEtEQXBPdzBLSUNCd2NtOWpaWE56TG1WNGFYUW9NU2s3RFFwOUtUc05Dbk5sY25abGNpNXNhWE4wWlc0b1VFOVNWQ3dnSnpFeU55NHdMakF1TVNjc0lDZ3BJRDArSUhzTkNpQWdZMjl1YzI5c1pTNXNiMmNvSjF0M1lYUmphR1Z5WFNEdGdiVHJvWnpyazV3ZzY0dWs2NmFzSU9xd2tPeUxuT3lla0NEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93MEtmU2s3RFFvdkx5QkpVSFkySU91anFPMlVoT3V3c1NnNk9qRXA3SmVRNjQrRUlPMlZxT3E3bUNEcms2UHJpcFRyaTZRZzRvQ1VJQ2RzYjJOaGJHaHZjM1FuNnJDQUlEbzZNZXVobkNEcnFMenNvSUFnN1pXMDdJU2Q2NUNZNjRxVUlPMlptT3F5dmV5WGtPeUVuQTBLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlFbFFkalRyb1p3ZzdZKzA2N0N4N1pXWTdLZUFJT3lWaXV5VmhDRHJpNlRycHF3ZzZybW83SnF3NnJpd3dyZnFzNFRzb0pVZzdLR3c3WnFNNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJqWmdnNjZ5NDdLQ2NJT3VNZ095ZGtTanJpNlRycHF6c21ZQWc2NCtaN0oyOEtTNE5DbU52Ym5OMElITmxjblpsY2pZZ1BTQm9kSFJ3TG1OeVpXRjBaVk5sY25abGNpaHpaWEoyWlhJdWJHbHpkR1Z1WlhKektDZHlaWEYxWlhOMEp5bGJNRjBwT3cwS2MyVnlkbVZ5Tmk1dmJpZ25aWEp5YjNJbkxDQW9LU0E5UGlCN2ZTazdJQzh2SURvNk1leWRoQ0RycXJzZzdKNmg3SldFNjQrRUtFVkJSRVJTU1U1VlUwWEN0MGxRZGpZZzdKZUc3SjJNS1NCSlVIWTA2NmVNN0p5ODY2R2NJT3F6aE95R2pTRHJqNW5zbnBFTkNuTmxjblpsY2pZdWJHbHpkR1Z1S0ZCUFVsUXNJQ2M2T2pFbktUc05DZz09JwpCNjRfRVhBTVBMRVM9J0l5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzcElUc25ZUWc2N0NVNnI2NDZyT2dJT3lMdHV5Y3ZPdXB0Q0JnSUM4Z1lDQW83SldlNjVLa0lPcXp0ZXV3c1NEdGo2enRsYWdnN0lxczY1Nlk3SXVjS1NvcUlPdWhuQ0R0a1p6c2k1enRsWmpzaExqc21wUXVJTzJVak91ZnJPcTN1T3lkdU95WGtPeUVuQ0Rya1pBZzdLU0U2NkdjSU91enRPeVhyT3lua2V1TGlPdUxwQzRLTFNEc2dxenNtcW5zbnBEcXNJQWc3SjZGNjZDbDdaV2NJT3VzdU9xMXJPcXdnQ0JnN0p1UTY3TzRZT3F6dkNBbzZyTzE2N0N4d3JmcnJManNucVhydG9EdG1MZ2c2NnkwN0l1YzdaV1k2ck9nS1NEcXNKbnFzYkRyZ3Bnc0lPeUVuT3VobkNEdGo2enRsYWp0bFpqcnFiUWc2cmU0SU95MmxPeXluT3lWaU91VHBPeWRoQ0RyczdUc2w2enNwSTNyaTRqcmk2UXVDaTBnNjZlazdMbXQ3WldnSU91VmpDQXFLdXVuaU95S3BPMkN1ZXVRbkNEc25iVHJwb1FvN1ptTlhDcnJqNWtwTENEc2lLdnNucEFvN0tDRTdabVU2N0tJN1ppNHdyY2k3Sm00SURMcnFvVWlJT3VUc1NucmlwUWc2NnkwN0l1Y0tpcnRsYW5yaTRqcmk2UWc0b0NVSU95ZHRPdW1oTUszN0lpWTY1K0p3cmZyc29qdG1ManJwNHdnNjR1azY2VzRJT3VzdU9xMXJPdVBoQ0Rxc0puc25ZQWc3SmlJN0l1YzY2R2NJT3llb2UyWWdPeWFsQzRnNjR1b0xDRHN0cFRzc3B6c2xZanNsNUFnN0tDQjdKYTA2NUdVSU95ZHRPdW1oTUszN0lpcjdKNlE2NHFVSU9xM3VPdU1nT3VobkNEcmdwanNtS1RyaTRnZzdJdWs3S0NjSU9xd2t1eVhrQ0RycDU3cXNvd2c2ck9nN0xPUUlPeVRzT3lFdU95YWxDNEtMU0Rzb0p6cnFxa29ZQ01qWUNucXM3d2dZQ01qSTJBc0lHQXRZQ0RxdUxEdG1ManJpcFFnN1ppVjdJdWQ3SjIwNjR1SUlPdXdsT3ErdU95bmdDRHJwNGpzaExqc21wUXVDZ29qSXlEc2lxVHRnNERzbmJ3ZzdKdVE3TG1aSUNqc3NManFzNkFnNG9DVUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZQWdkWGd0ZDNKcGRHbHVaeTV0WkNEcXNJRHNuYlRyazV3cENnb3RJTzJWdE95YWxPeXl0Q3dnNjdhQTY1T2M2NStzN0pxMElPeWloZXF5c0NoZ2Z1eWVpT3lXdE95YWxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrS0xTRHFzSVRxc3JEdGxaanFzNkFnN0ltczdKcTBJT3Vua0NBbzdLQ0U3SWFoNG9hUzY3TzA2NEswNjR1a0tTd2c2N2FBN0tDVklPeURnZTJacWV1UGhDRHJsTEhybExIdGxaanNwNEFnN0pXSzZyS01LQ0xzc0w3cXVMQWc3SXVrN1l5b0l1S2RqQ0FpN0xDKzdKMkVJT3lJbUNEc2w0YnNsclRzbXBRaTRweUZLUW9LSXlNZzdMYVU3TEtjSU95WWlPeUxuQW9LSXlNaklPeW5oTzJXaWUyVm1PdU5tQ0RzbnBIc2w0WHNuYlFnN0o2STdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3S2VFN1phSklPeWtrZXlkdUNEcmdyVHNsNjNzbmJRZzdKNkk3SmEwN0pxVUxpQXZJT3lkdE95V3RPeUVuQ0RzcDRUdGxvbnRsYURxdVl6c21wUS9DZ29qSXlNZzZyTzE3SnlnSU95YWxPeXlyZXlkaENEc3Q2anNob3p0bFpqcnFiUWc3SnFVN0xLdElPdUN0T3lYcmV5ZHRDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTNxT3lHak8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHN0NmpzaG96dGxhQWc2cks5N0pxd0lPeWFsT3l5clNEcmdyVHNsNjNyajRRZzdJS3Q3S0NjNjQrODdKcVVMaUF2SU9xenRleWNvQ0RzbXBUc3NxM3NuWVFnN0xlbzdJYU03WldnNnJtTTdKcVVQd29LSXlNaklPcTRzT3E0c091bHZDRHNzTDdzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXWTdJUzQ3SnFVTGdvdElPcTRzT3E0c091bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlCUlV1eTlsT3VUbk91bHZDRHJpNlRzaTV3ZzdJcWs3THFVN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaV1k2cml3SU95Z2hPeVhrT3VLbENEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxiVHNsYndnNnJDQTdKNkY3WldnSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVN0pXaElPdTJnT3loc2V5Y3ZPdWhuQ0RxdGF6cnA2VHRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVDaTBnN0o2VTdKV2g3SjIwSU91MmdPeWhzZTJWdE95RW5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxnb0tJeU1qSU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c3Sm00SURMcnFvWHNsNURxc293ZzZyYU03WldjSU95Q3JleWduQ0RzbFl6cnByenRocUhzbllRZzdLQ0U3SWFoN1pXZzZybU03SnFVUHdvdElPcTJqTzJWbkNEc2dxM3NvSndnN0pXTTY2YTg3WWFoN0oyRUlPdXp0T3VDdE91Z3BPcXpvQ0R0bGJUc21wUXVJQzhnN1ptTkt1dVBtU2d3TVRBdE1USXpOQzAxTmpjNEtTRHJpNWdnN0ptNElETHJxb1hzbDVEcXNvd2c2N08wNjRLODZybU03SnFVUHdvdElPMlpqU3JyajVrb01ERXdMVEV5TXpRdE5UWTNPQ2tnNjR1WUlPeVp1Q0F5NjZxRjdKZVE2cktNSU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN2T3E1ak95YWxEOEtMU0RxdG96dGxad2c3SUt0N0tDY0lPeVZqT3Vtdk8yR29leWRoQ0R0bVkwcTY0K1pLREF4TUMweE1qTTBMVFUyTnpncElPdUxtQ0RzbWJnZ011dXFoZXlYa09xeWpDRHJzN1RyZ3J6cXVZenNtcFEvQ2dvakl5TWpJTzJabGV5ZHVNSzM2ckt3N0tDVklPMk1uZXlYaFFvS0l5TWpJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeUNyZXlnbk91UW5DRHJqYkRzbmJUdGhMRHJpcFFnNjdPMTZyV3M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHJrSmpyajR6cnByUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNvSlhycDVBZzdJS3Q3S0NjN1pXZzZybU03SnFVUHdvS0l5TWpJT3V6Z09xeXZleUNyTzJWcmV5ZHRDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdKV1k3SXExNjR1STY0dWtMaURyZ3BqcXNJRHNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3SldFN0tlQklPeWdnT3llcGUyVm1PeW5nQ0RzbFlyc25ZQWc2NEswN0pxcDdKMjBJT3llaU95V3RPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc25vWHJvS1h0bFp3ZzY0SzA3SnFwN0oyMElPdXFxT3VSa0NEc2dxM3NvSnpyajd6c21wUXVJQzhnN0xTSTZyaXc3Wm1VN1pXZzZybU03SnFVUHdvS0l5TWpJeURzbDVEcm42ekN0K3lMcE8yTXFBb0tJeU1qSU91RXBPMkt1T3liak8yQnJDRHNsN0Rxc3JEc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU91RXBPMkt1T3liak8yQnJPeVhrQ0RzbDdEcXNyRHRsYUFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzbDdEcXNyQWc3SU9CN1lPYzY2VzhJTzJabGV5ZHVPMlZtT3F6b0NEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJ6c2k1enNvSUhzbmJnZzdKaWs2NldZNnJDQUlPdXduT3lEbmUyV2lPeUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU95RG5lcXl2T3lXdE95YWxDNGdMeURzbnFEc2k1d2c3WnVFSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWaE95ZHRPdVVsQ0RybUpEcmlwUWc2N21FNjdDQTY3S0k3Wmk0NnJDQUlPeWR2T3k1bU8yVm1PeW5nQ0RzbFlyc2lyWHJpNGpyaTZRdUNpMGc3SldFN0oyMDY1U1VJT3VZa091S2xDRHJ1WVRyc0lEcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDNyc29qdG1ManFzSUFnN0oyODdMbVk3WldZN0tlQUlPeVZpdXlLdGV1TGlPdUxwQzRLTFNEc25ianNwcDNyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN0o2RjY2Q2w3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3kwaU9xenZPdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKMjQ3S2FkNjdLSTdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnN0plRjY2R2M2NU9jN0plUUlPeUxwTzJNcU8yV2lPeUt0ZXVMaU91THBDNEtMU0R0akl6c25ienNuWVFnN0ppczY2YXM3S2VBSU91cXUrMldpT3lXdE95YWxDNGdMeURyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3S0NRNnJLQUlPeWtrZXllaGV1TGlPdUxwQzRnN0oyMDdKcXA3SmVRSU91MmlPMk91T3lkaENEcms1enJvS1FnN0tPRTdJYWg3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEc2hKenJ1WVRzaXFUcnBid2c3S0NRNnJLQTdaV1k2ck9nSU95ZWlPeVd0T3lhbEM0Z0x5RHNvSkRxc29Ec25iUWc2NEdkNjRLWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bFlUc2lKZ2c3SjZGNjZDbElPMlZyZXVxcWV5ZWhldUxpT3VMcEM0S0xTRHF2SzBnN0o2RjY2Q2w3WlcwN0pXOElPMlZtT3VLbENEdGxhM3JxcW5zbmJUc2w1RHNtcFF1Q2dvakl5TWpJT3Eyak8yVm5NSzM3SVNrN0tDVkNnb2pJeU1nN0xtMDY2bVU2NTI4SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdJcTE2NHVJNjR1a0xpRHNoS1Rzb0pYc2w1RHNoSndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU95THJleUxuT3lZcEM0S0xTRHN1YlRycVpUcm5id2c2cmFNN1pXYzdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0xtMDY2bVU2NTI4SU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmpPdW12Q0RxdG96dGxaenNuYlFnNnJHdzY3YUE2NUNZN0phMElPeVZqT3Vtdk95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHNsWXpycHJ3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PdXB0Q0RzaG96c2k1M3NuWVFnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUlDOGc3SVNrN0tDVjdKZVE3SVNjSU95VmpPdW12T3lkaENEc3ZKd2c3S084N0lTNDdKcVVMZ29LSXlNaklPeWNoT3k1bUNEc29KWHJzN1FnN0oyMDdKcXA3SmVRSU91UG1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyb1ozc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdVRzZXVobmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWc3SUt0N0tDYzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeUNyZXlnbk8yV2lPeVd0T3lhbEM0S0NpTWpJeUR0Z2JUcnByM3JzN1RyazV6c2w1QWc2N08xN0lLczY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0ZXlDck8yV2lPeVd0T3lhbEM0S0NpTWpJeURzbXBUc3NxM3NuWVFnN0xLWTY2YXNJT3lra2V5ZWhldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdKcVU3TEt0N0oyRUlPeXltT3Vtck8yVm1PcXpvQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPeVZpT3VDdE1LMzdKeWc2NCtFQ2dvakl5TWc3SU9JNjZHYzdKcTBJT3V5aE95Z2hPeWR0Q0RzdHB6c2k1enJrSmpzbDRqc2lyWHJpNGpyaTZRdUlPeVhoZXVOc095ZHRPMkt1Q0R0bTRRZzdKMjA3SnFwSU9xd2dPdUtwZTJWcWV1TGlPdUxwQzRLTFNEc2c0Z2c2N0tFN0tDRTdKMjBJT3VDbU95WmxPeVd0T3lhbEM0Z0x5RHNsNFhyamJEc25iVHRpcmp0bFpqcnFiUWc3SU9JSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzaEp6cnVZVHNpcVFnN0oyMDdKcXA3SjJFSU95Y2hPMlZ0Q0RzbGIzcXRJQWc2NCtaN0oyWTZyQ0FJTzJWaE95YWxPMlZxZXVMaU91THBDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPeUVuT3U1aE95S3BPdWx2Q0RzaTV6c25wSHRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25xWHNpNXpxc0lRZzY2KzQ3SUtzN0pxcDdKeTg2NkdjSU95ZWtPdVBtU0Ryb1p6cXQ3anNsWVRzbTRNZzY1Q1k3SmVJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3lZcE91ZXErdVBtZXlWaUNEc2dxenNtcW50bFpqc3A0QWc3SldLN0pXRUlPdWhuT3EzdU95VmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyaTRqcmk2UXVJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbllRZzdabVY3SjI0N1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3E0c09xNHNPcXdnQ0RyaEtUdGlyanNtNHp0Z2F6c2w1QWc3SmV3NnJLdzY0KzhJT3llaU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJpdzZyaXc3SjJZSU95WHNPcXlzQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbUlIc2c0SHNuWVFnNjdhSTY1K3M3SmlrNjRxVUlPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0ppQjdJT0I3SjJFSU91MmlPdWZyT3lZcE9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3kzcU95R2pPMlZtT3lMcENEcXNyM3NtckFnN0l1ZzdMS3Q3WldZN0l1Z0lPdUN0T3lhcWV5ZGdDRHNvSURzbnFYcmtKanNwNEFnN0pXSzdJcTE2NHVJNjR1a0xnb3RJT3kzcU95R2pPMlZtT3VwdENEc2k2RHNzcTN0bFp3ZzY0SzA3SnFwN0oyMElPeWdnT3llcGV1UW1PeW5nQ0RzbFlyc2xZVHNtcFF1SUM4ZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvQ2kwZzZyYU03WldjSU95TG9PeXlyZXlkaENEc3Q2anNob3p0bGFEcXVZenNtcFEvSUM4ZzdMZW83SWFNN1pXWTY2bTBJT3llaGV1Z3BlMlZuQ0RyZ3JUc21xbnNuYlFnN0lLczY1Mjg3S0M0N0pxVUxnb0tJeU1qSXlEcXNJRHNuYlRyazV3ZzdKaUk3SXVjSUNoMWVDMTNjbWwwYVc1bkxtMWs3SmVRN0lTY0lPeVlydXE1Z0NEaWdKUWc2cmVjN0xtWjdKeTg2NkdjSU95ZWtPdVBtZTJabENEcnFyc2c3WldZNjRxVUlPdXN1T3llcFNEc25xenF0YXpzaExFZzdJS3M2NkdBS1FvS0l5TWpJT3lla091UG1leXdxT3VsdkNEcXNJRHNwNERxczZBZzZyT0U3SXVjNjRLWTdKcVVQd290SU95ZWtPdVBtZXl3cU9xd2dDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnb0tJeU1qSU95ZHRPeWVrQ0R0bVpqcnRvanNuWVFnNjdDYjdKV1k3SmEwN0pxVUxnb3RJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFF1Q2dvakl5TWc3SmlrNjRxWTdKMllJTzJBdE95bWlPcXdnQ0RxczZjZzdLS0Y2Nk9NNjQrODdKcVVMZ290SU95WXBPdUttT3lkbUNEdGdMVHNwb2pxc0lBZzZyT25JT3VCbmV1Q21PeWFsQzRLQ2lNakl5RHF1SWpzbmJ6cXVZenNwNEFnNjYrNDY0S3BJT3lMbkNEc2w3RHNzclFnN0xLWTY2YXM2NUNwNjR1STY0dWtMaUR0bTRUcnRvanFzckRzb0p3ZzZyaUk3SldoN0oyRUlPdUNxZXUyZ08yVm1PeUxuT3E0c0NEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0ppazY0cVk2cm1NN0tlQUlPdUN0T3luZ0NEc2xZcnNuTHpycWJRZzdKZXc3TEswNjQrODdKcVVMaUF2SU8yYmhPdTJpT3F5c095Z25DRHF1SWpzbGFIc25ZUWc2NEswN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lna09xeWdDRHF1TERxc0lUc2w1RHJpcFFnN0lTYzY3bUU3SXFrSU95ZHRPeWFxZXlkdENEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPeUxvT3UyaE95bW5TRHRtWlhzbmJnZzdLQ0U3SmVRNjRxVUlPeUdvZXE0aUNEcnNJOGc2ckt3N0tDYzZyQ0FJT3UyaU9xd2dPMlZxZXVMaU91THBDNEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZ29LSXlNaklPdXpnT3F5dlNEc2k1d2c3THFRN0l1YzY3Q3hJT3llck95bmdPcTRpZXlkZ0NEcnRvanFzSUR0bGFucmk0anJpNlF1Q2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLQ2lNakl5RHNnNEhyaTdRZzdaS0k3S2VJSU8yV3BleURnZXlkaENEc25JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhbEM0S0NpTWpJeU1nNnJPRTdLQ1Z3cmZzbm9Ycm9LVUtDaU1qSXlEc2xZVHNuYlRybEpRZzY1aVE2NHFVSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWR0T3lEZ1NEc25wanJxcnNnN0o2RjY2Q2w3WldZN0plc0lPcXpoT3lnbGV5ZHRDRHNucURxdUlnZzdMS1k2NmFzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0ExN1pxTUlPeWVtT3VxdXlEc25vWHJvS1h0bGJUc2hKd2c2ck9FN0tDVjdKMjBJT3llb09xeXZPeVd0T3lhbEM0Z0x5RHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzdKNnM3SVNrN0tDVjdaV1k2Nm0wSU91THBPeUxuQ0RzbmJUc21xbnRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc25iVHJyN2dnN0lLczdKcXBJT3lra2V5ZHVDRHNsWVRzbmJUcmxKVHNub1hyaTRqcmk2UXVDaTBnN0oyMDY2KzRJT3lUc09xem9DRHNub2pyaXBRZzdKV0U3SjIwNjVTVTdKaUk3SnFVTGlBdklPdUxwT3VsdUNEc2xZVHNuYlRybEpUcnBid2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNncXpzbXFudGxhQWc3SWlZSU95WGh1dUtsQ0RydVlUcnNJRHJzb2p0bUxqc25vWHJpNGpyaTZRdUlPeVlnZXVzdUN3ZzdJaXI3SjZRTENEdGlybnNpSmpyckxqc25wRHJwYndnN1krczdaV283WldZN0plc0lEanNucEFnN0oyMDdJT0JJT3llaGV1Z3BlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc21JSHJyTGdzSU95SXEreWVrQ3dnN1lxNTdJaVk2Nnk0N0o2UTY2VzhJTzJQck8yVnFPMlZ0Q0E0N0o2UUlPeWR0T3lEZ1NEc25vWHJvS1h0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95ZWhldWdwU0Rxc0lEcmlxWHRsWndnNnJpQTdKNlFJT3lJbU91bHZDRHN0SWpxczd6dGxaanNtSURzaXJYcmk0anJpNlF1Q2kwZzdKNkY2NkNsN1pXZ0lPeUltQ0Rzbm9qcmlwUWc2cmlBN0o2UUlPeUltT3VsdkNEcmhKanNsNGpzbHJUc21wUXVJQzhnNjRLMDdKcXA3SjJFSU95aHNPcTRpQ0RzcElUc2w2d2c3S084N0lTNDdKcVVMZ29LSXlNakl5RHRqSXpzbmJ6Q3QrcXlzT3lnbk1LMzZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzaUpqcmk2anNuWVFnN1ptVjdKMjQ3WldZNnJPZ0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WldZN0plc0lPeUVwT3k1bU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaVzA3SVNjSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xenRlcXdoT3lkaENEdG1aWHJzN1R0bFp3ZzY1S2tJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeUVuT3U1aE95S3BDRHNwSURydVlRZzdLU1I3SjZGNjR1STY0dWtMZ290SU95a2dPdTVoTzJWbU9xem9DRHNub2pyaXBRZzZyaXc2NHFsN0oyMDdKZVE3SnFVTGlBdklPeWhzT3E0aU91bmpDRHF1TERyaTZUcm9LUWc3S084N0lTNDdKcVVMZ29LSXlNaklPdVRzZXVoblNEcXNJRHJpcVh0bFp3ZzdMV2M2NHlBSU9xd25PeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnNjQyVUlPdVRzZXVobmUyVm1PdWdwT3VwdENEcXVMRHNvYlFnN1pXdDY2cXA3SjJFSU95Q3JleWduTzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095MmxPcXdnQ2tLQ2lNakl5RHN0cHpyajVrZzdKcVU3TEt0N0oyMElPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0xhYzY0K1pJT3lhbE95eXJleWRoQ0Rzb0pIc2lKanRsb2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1nNnJLOTY3bUVJT3lEZ2UyRG5PdWx2Q0R0bVpYc25ianRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WldZN0l1dDdJdWM3SmlrTGdvdElPcXl2ZXU1aENEc2c0SHRnNXpycGJ3ZzdabVY3SjI0N1pXZ0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3SUNqc2w0YnNsclRzbXBRZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUXBDZ29qSXlNZzY3TzQ3SjI0SU95ZHVPeW1uZXlkaENEdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNuYlRzbXFudGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0Ryczdqc25iZ2c3SjI0N0thZDdKMkVJTzJWbU91cHRDRHJxcWpyazZBZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnb0tJeU1qSU95ZHRPdXBsT3lkdkNEc25ianNwcDBnN0tDRTdKZVE2NHFVSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3lkdE91cGxPeWR2Q0RzbmJqc3BwM3NuWVFnNjZlSTdMbVk2Nm0wSU91aG5PcTN1T3lkdU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3kvb08yUHNPeWRnQ0Ryb1p6cXQ3anNuYmdnN1p1RTdKZVE2NmVNSU95Q3JPeWFxU0Rxc0lEcmlxWHRsYW5yaTRqcmk2UXVDaTBnNjZHYzZyZTQ3SjI0N1pXWTY2bTBJT3kvb08yUHNPeWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJyN2pzaExIcmhZVHNucERyaXBRZzY3TzA3Wmk0N0o2UUlPdVBtZXlkbUNEc2w0YnNuYlFnNnJLdzdLQ2M3WldnSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzY3TzA3Wmk0N0o2UTZyQ0FJT3VQbWV5ZG1PMlZtT3VwdENEcXNyRHNvSnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsSVRyb1p6dGxZVHNuWVFnNjVPeDY2R2Q3WldZN0tlQUlPeVZpdXljdk91cHRDRHNuYlRzbXFuc25iUWc3S0NjN1pXYzY1Q3A2NHVJNjR1a0xnb3RJTzJVaE91aG5PMlZoT3lkaENEcms3SHJvWjN0bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2xiRWc2N0tFN0tDRTdKMjBJT3VDcnV5VmhDRHNuYnpydG9BZzZyaXc2NHFsN0oyMElPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVobmV1UW1PeW5nQ0RzbFlyc2xZUWc3SUtzN0pxcDdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0xhYzdKNkZJT3k1dE91VG5PdWx2Q0RyazdIcm9aM3RsWmpycWJRZzY3Q1U2NkdjSU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJeURyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3SUNqc21ZVHJvNHdnN0pXSTY0SzBLUW9LSXlNaklPMmFqT3lia09xd2dPeWVoZXlkdENEc21ZVHJvNHpya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNnJDQTdKNkY3SjJFSU91bmlPeXpwT3lXdE95YWxDNEtDaU1qSXlEc21JanNsYjNzbmJRZzdMZW83SWFNNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95WWlPeVZ2ZXlkaENEc3Q2anNob3p0bG9qc2xyVHNtcFF1Q2dvakl5TWc2Nnk0N0oyWTZyQ0FJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdJaWM3TENvN0tDQjdKeTg2NkdjSU91THRldXpnT3VUbk91bXJPcXlvT3lLdGV1TGlPdUxwQzRLTFNEcnJManNuWmpycGJ3ZzdLQ1I3SWlZN1phSTdKYTA3SnFVTGlBdklPeUluT3lFbk91TWdPdWhuQ0RyaTdYcnM0RHJrNXpycHJUcXNvenNtcFF1Q2dvakl5TWc3SVNrN0tDVjdKMjBJT3kwaU9xNHNPMlpsT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzaEtUc29KWHNuWVFnN0xTSTZyaXc3Wm1VN1phSTdKYTA3SnFVTGdvS0l5TWpJT3U1aE91d2dPdXlpTzJZdU9xd2dDRHJzNERxc3IzcmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SU91d2xPcS9xT3lXdE95YWxDNEtDaU1qSXlEc25ianNwcDNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHVPeW1uZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNaklPeTZrT3lqdk95V3ZPMlZuQ0Rxc3Izc2xyUWdLT3luaU91c3VDRHNucXpxdGF6c2hMRXBDZ29qSXlNZzdKYTQ3S0NjSU91d3FldXN1TzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEcnNLbnJyTGdnNjRLZzdLZWM2Nlc4SU95RW9PMkRuZTJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nN0phMDY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RycDR6cm80enJvWndnN0oyMDdKcXA3SjIwSU95a2tleW5nT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RzbmJUc21xa2c2cml3NnJDRTdKMjBJT3VCbmV1Q21PeUVuQ0RzcDREcXVJanNuWUFnN0pPNElPeUltQ0RzbDRic2xyVHNtcFF1Q2dvakl5TWc3SnFwNjUrSklPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0lEc25xWHNsNUFnN0l1azdZeW83WmFJN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lnZ095ZXBlMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUXVDZ29qSXlNZzdZYTE3SXVnSU95WXBPdWxtT3VobkNEc21wVHNzcTNzbmJRZzdJdWs3WXlvN1pXWTdKaUE3SXExNjR1STY0dWtMZ290SU8yR3RleUxvT3lkdENEc201RHRtWnp0bFpqc3A0QWc3SldLN0pXRUlPeWFsT3l5cmV5ZGhDRHNzcGpycHF6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPdTJnT3loc2V5Y3ZPdWhuQ0Rzb0pIcXQ3enNuYlFnNnJHdzY3YUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0phMDdKcVVMaUF2SU9xMGdPdW1yT3lla095WGtPcXlqQ0RxdG96dGxaenNuWVFnN0pxVTdMS3Q3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nN0lPQjdabXBJT3lWaU91Q3RDQW9NdXVMcUNEcXRhenNvYkFwQ2dvakl5TWc3SjZGNjZDbDdaV1k3SXVnSU95anZPeUdqT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRnNjR1azdJdWNJTzJabGV5ZHVDRHJzSlRybm8zcmk0anJpNlF1Q2kwZzdLTzg3SWFNNjZXOElPeXd2dXlkaENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU91THBPeUxuQ0R0bVpYc25ianRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lhbE95eXJlMlZtT3lMb0NEdGpwanNuYlRzcDREcnBid2c3TEMrN0oyRUlPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3WTZZN0oyMDdLZUE2Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEdGc0anRoN1R0bFpqcnFiUWc2NnFvNjVPZ0lPdU5zT3lkdE8yRXNPcXdnQ0RzZ3Ezc29KenJrSmpxczZBZzY0dWs3SXVjSU91UW1PdVBqT3VtdENEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU95Z2xldW5rQ0R0ZzRqdGg3VHRsYURxdVl6c21wUS9DZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeURnZTJacVNEc2xZanJnclFwQ2dvakl5TWc2N2FBN0o2c0lPeWtrU0Ryc0tucnJManNucERxc0lBZzZyQ1E3S2VBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91MmdPeWVyQ0RzcEpIc2w1QWc2N0NwNjZ5NDdKNlE2ckNBSU95ZWlPeVhpT3lXdE95YWxDNGdMeURzbUlIc2c0SHNuWVFnN1ptVjdKMjQ3WlcwSU91enRPeUV1T3lhbEM0S0NpTWpJeURxc3IzcnVZUWc3WlcwN0tDY0lPcTJqTzJWbk95ZHRDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZySzk2N21FSU8yVnRPeWduQ0RxdG96dGxaenNuYlFnN1pXRTdKcVU3WlcwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHNtcFRzc3EzdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPMlpsT3llckNEcXNKRHNwNERxdUxBZzY3Q3c3WVN3NjZhczZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNEtMU0R0bVpUc25xd2c2ckNRN0tlQTZyaXdJT3V3c08yRXNPdW1yT3F3Z0NEc2xyenJwNGdnN0plRzdKYTA3SnFVTGlBdklPdXdzTzJFc091bXJPdWx2Q0RxdFpEc3NyVHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzdHBYc2xiMGdLeURxdUkzc29KVWc3S0NFN1ptWUlDanJrWkFnNjZ5NDdKNmxJT0tHa2lEcXVJM3NvSlh0bUpVZzdaV2NJT3VzdU95ZXBTa0tDaU1qSXlEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVUHlEc2xZenJwcnpzbllRZzdMeWM3S2VBSU95Vml1eWN2T3VwdENEc3BKSHNtcFR0bFp3ZzdJYU03SXVkN0oyRUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMZ290SU95VmpPdW12T3lkaENEc3ZKenJxYlFnN0tTUjdKcVU3WldjSU95R2pPeUxuZXlkaENEcnNKVHJvWndnNjdDYjdKMkVJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0o2UTY0K1o3SjIwN0xLMDY2VzhJT3VUc2V1aG5lMlZtT3luZ0NEc2xZcnFzNkFnNjRTWTdKYTA2ckNJNnJtTTdKcVVQeURyazdIcm9aM3RsWmpzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc25wRHJqNW5zbmJUc3NyVHJwYndnNjVPeDY2R2Q3WldZNjZtMElPMlZvT3lkdU95ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHJzN2dnNnJPRTdKVzk3SjJZSU95Y29PeWR2TzJWbkNEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3lkdk91d21PcTBnT3Vtck95ZWtPdWhuQ0RxdG96dGxaenJzNERxc3Izc25ZUWc3WldZN0l1a0lPeUltQ0RzbDRic2xyVHNtcFF1SU95ZHZPdXdtQ0RxdElEcnBxenNucERyb1p3ZzZyYU03WldjSU91emdPcXl2ZXlkaENEc201RHRsWmpzaTZRZzZySzk3SnF3SU91THBPdWx1Q0RzZ3F6cm5venNsNURxc293ZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtDRHF0b3p0bFp6c25ZUWc3S2VBN0tDVjdaVzBJT3lqdk95TG9DRHRtNFFnNjR1azdJdWNJT3lMbk91UGhPMlZ0Q0Rzbzd6c2hManNtcFF1Q2kwZzY0dWs2Nlc0SU95Q3JPdWVqT3lkaENEcnA0anNpcVR0aExBZzZyU0E2NmFzN0o2UTY2R2NJT3luZ095Z2xlMlZuQ0Rya3FRZzdKMjg2N0NZSU9xMGdPdW1yT3lla091aG5DRHJzNERxc3IzdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0xTRHJpNlRycGJnZzdJS3M2NTZNN0oyRUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJvWndnN0tlQTdLQ1Y3WldZNjZtMElPdXpnT3F5dmUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvPScKQjY0X0dVSURFPSdJeUJWV0NCWGNtbDBhVzVuSU9xd2dPeWR0T3VUbkEwS0RRb2pJeUF4TGlEdGxiVHNtcFRzc3JRTkNnMEs3S0NjN1pLSUlPeVZpT3lkbUNEcnFxanJrNkFnNjZ5NDZyV3M2NHFVSUNmdGxiVHNtcFRzc3JRbjY2R2NJT3lOcU95YWxDNE5DdXlkdk9xMGdPeUVzU0Rzbm9qcmlwUWc3SUtzN0pxcDdKNlFJT3F5dmUyWG1PeWRoQ0RycDR6cms2UWc3SWlZSU95ZWlPdVBoT3VoblNBcUt1eURnZTJacVN3ZzY2ZWw2NTI5N0oyRUlPdTJpT3VzdU8yVm1PcXpvQ0RycXFqcms2QWc2Nnk0NnJXczdKZVFJTzJWdE95YWxPeXl0T3VsdkNEc29JSHNtcW50bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RyczdUcmc0WHJpNGpyaTZRZzRvYVNJT3V6dE91Q3ZPcXlqT3lhbEEwS0RRb3FLaW9OQ2cwS0l5TWdNaTRnNjRxbDY0K1o3S0NCSU91bmtPMlZtT3E0c0EwS0RRcnNvSnp0a29nZzdKV0k3SmVRN0lTY0lPeTFuT3VNZ08yVm5DQXFLdXVLcGV1UG1lMllsU0Ryckxqc25xVXFLdXlkaENEc2phanNvN3pzaExqc21wUXVJT3lJbU91UG1lMllsU0Ryckxqc25xWHNuWUFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNUzNzaUpqcmo1bnRtSlV0NjZ5NDdKNmw3SjJFTGV5TnFPdVBoQzNya0pqcmlwUXQ2cks5N0pxd0tleVhrQ0R0bGJUcmk3bnRsYUFnNjVXTTY2ZU1JT3lUc091S2xDRHFzb3dnN0tLTDdKV0U3SnFVTGcwS0RRb2pJeU1nNjVDUTdKYTA3SnFVSU9LR2tpRHRsb2pzbHJUc21wUU5DZzBLN0ppSUtRMEtMU0RzaEtUc29KWHJrSkRzbHJUc21wUWc0b2FTSU95RXBPeWdsZTJXaU95V3RPeWFsQTBLRFFvakl5TWdKMzdzbDRnbklPdTV2T3E0c0EwS0RRcnNtSWdwRFFvdElPdXdsT3VBak95WGlPeVd0T3lhbENEaWhwSWc2N0NVNnIrbzdKYTA3SnFVRFFvTkNpTWpJeURyajVuc2dxd2c2N0NVNnIrVTdKT3c2cml3RFFvTkN1eVlpQ2tOQ2kwZzY0YVM3SldFN0tHTTdKYTA3SnFVSU9LR2tpRHNtS3pybnBEc2xyVHNtcFFOQ2cwS0tpb3FEUW9OQ2lNaklETXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFOQ2cwSzdLQ2M3WktJSU95VmlPeVhrT3lFbkNEcnRvRHNvSlhzb0lFZzdMdWs2NjZrNjR1STdMeUE3SjIwN0lXWTdKMkVJT3kxbk91TWdPMlZuQ0RzcElUc25iVHFzNkFnNnJpTjdLQ1Y3WmlWSU91c3VPeWVwZXlkaENEc2phanNvN3pzaExqc21wUXVEUXJydG9Ec29KWHRtSlVnNjZ5NDdKNmw3SjJBSUZ2c21JanNtYmdnNnJlYzdMbVpYU2dqN0ppSTdKbTRMVE10NjdhQTdLQ1Y3WmlWTGV1c3VPeWVwZXlkaEMzc2phanJqNFF0NjVDWTY0cVVMZXF5dmV5YXNDbnNsNUFnN1pXMDY0dTU3WldnSU91VmpPdW5qQ0RzamFqc21wUXVEUW9OQ3V5WWlDQTZJT3lWaUNEcmo3enNtcFFzSU95WGh1eVd0T3lhbENBb1dDa2c0b2FTSUg3dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSXlEc2w0YnNsclRzbXBRZzRvYVNJT3llaU95V3RPeWFsQTBLRFFyc21JZ3BEUW90SU91enRPMll1T3lla09xd2dDRHRsNGpybmIzdGxaanF1TEFnN0tDRTdKZVE2NHFVSU9xd2dPeWVoZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVJT0tHa2lEcnM3VHRtTGpzbnBEcXNJQWc3WmVJNjUyOTdaVzA3Slc4SU9xd2dPeWVoZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVEUW9OQ2lNakl5RHNsNURybjZ3ZzY2bVU3SXVjN0tlQURRb05DdXlYa091ZnJDRHNnNEh0bWFuc2w1RHNoSnpyajRRZ0l1MlZ0T3F5c0NEcnNLbnJzcFVpN0oyRUlPdW92T3lnZ0NEc2xZenJvS1Rzbzd6cmlwUWc2cmlON0tDVjdaaVZJT3Exck95aHNPdWhuQ0RzamFqc21wUXVEUW9OQ3V5WWlDa05DaTBnN0tlQTZyaUlJT3V5aE95Z2hPeVhrT3lFbk91S2xDRHNrN2dnN0lpWUlPeVhodXlXdE95YWxDNGc3SU9kN0xLMElPeWR1T3ltbmV5ZGhDRHNrN0Ryb0tUcnFiUWc3Sld4N0oyRUlPeTFuT3lMb0NEcnNvVHNvSVRzbkx6cm9ad2c3SmVGNjQydzdKMjA3WXE0SU8yVnRPeWp2T3lFdU95YWxDNGc0b2FTSU95VnNleWRoQ0RzbDRYcmpiRHNuYlR0aXJqdGxiVHNvN3pzaExqc21wUXVJT3lEbmV5eXRDRHNuYmpzcHAzc25ZUWc3Sk93NjZDazY2bTBJT3kxbk95TG9DRHJzb1Rzb0lUc25iUWc3WldFN0pxVTdaVzA3SnFVTGcwS0RRbzZPam9nZEdsd0lPMk1uZXlYaFNEcnNvVHRpcnpzbllBZ1d6Z3VJTzJNbmV5WGhWMGc2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQTBLN1l5ZDdKZUZLT3VMcE95ZHRPeVd2T3Vobk9xM3VDa2c2N0tFN1lxOElPdXN1T3Exck91S2xDRHNsWVRybnBnZ0tpbzRMaUR0akozc2w0VXFLaURzaExuc2haZ2c2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQ0RpZ0pRZzdZYTE2N08wNjRxVUlGdnRtWlhzbmJoZExDRHNtSWd2N0pXRTY0dUk3SmlrSU8yTWtPdUxxT3lkZ0NCYjdKV0U2NHVJN0ppa1hjSzNXK3VFcEYwc0lPdVBtZXlla1NEc25LRHJqNFRyaXBRZ1creTNxT3lHakYzQ3QxdnJqNW5zbnBGZExpQWk3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3ZzdKT3c2ck9nTENBaTY0dXI2cml3SU1LM0lPdVBtZXlla1NMc3NwanJuN3dnN0tlZDdKMjBJT3lWaUNEcnA1N3JpcFFnN0tHdzdaV3A3SjJBSU95VHNPeW5nQ0RzbFlyc2xZVHNtcFF1RFFvNk9qb05DZzBLSXlNaklPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzdKaUlLUTBLTFNEcnFxanNub1RzcDREc201RHF1SWdnN0plRzdKMjBJT3VxcU95ZWhPMkd0ZXllcGV5ZGhDRHJwNHpyazZUcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzRvYVNJT3lWdmVxMGdPeVhrQ0RyajVuc25aanRsWmpycWJRZzY2cW83SjZFN0tlQTdKdVE2cmlJN0oyRUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvakl5TWc3WmljN1lPZElPdU1nT3lEZ1NEc2xZanJnclFOQ2cwS0tpcnNoSnpydVlUc2lxVHJpcFFnN0pPNElPeUltQ0Rzbm9qc3A0RHJwNHdzSU8yS3VleWdsU0R0bUp6dGc1M3NuWUFnNjdDYjdKMkVJT3lJbUNEc2w0YnNuWVFnNjVXTUlPS0draURxdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPeU5xT3lhbEM0cUtnMEs3SUtzN0pxcDdKNlE2NHFVSU91c3VPcTFyT3VsdkNEcXZMenF2THp0bm9nZzdKMjk3S2VBSU95Vml1cXpvQ0R0bTVIc2xyVHJzN1RxdUxBbzdJcWs3THFVS1NEcmxZenJyTGpzbDVBc0lPdTJnT3lnbGUyWWxleWN2T3VobkNEc2s3RHJxYlFnN0tDYzdaS0lJT3lnaE95eXRPdWx2Q0RzazdnZzdJaVlJT3lYaHV1THBPcXpvQ0RzbUtUdGxiVHRsWmpxdUxBZzdJbXM3SnVNN0pxVUxnMEtEUXJzbUlncERRb3RJT3F6aE95aWpDRHFzSnpzaEtRZzdaaWM3WU9kN0oyQUlPdXdtK3lkaENEc2lKZ2c3SmVHN0phMDdKcVVMaURpaHBJZ05DNDFKU0RxdUlqcnBxd2c3WmljN1lPZDY2ZU1JT3V3bSt5ZGhDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb3FLaW9OQ2cwS0l5TWdOQzRnN0xxUTdLTzg3SmE4N1pXY0lPcXl2ZXlXdEEwS0RRcnNvSnp0a29nZzdKV0k3SmVRN0lTY0lDZCs3SXVjNnJLZzdKYTA3SnFVUHljc0lDZnNpNXpyZ3Bqc21wUS9KeXdnSjM3cXU1Z25JT3F3bWV5ZGdDRHFzN3pyajRUdGxad2c2cks5N0phMDY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUXJzdFp6cmpJRHRsWndnN0xxUTdLTzg3SmE4N1pXWTZyT2dJT3k1bk9xM3ZPMlZuQ0RycDVEdGlLenJwYndnN0pPdzY0cVVJT3F5akNEc29vdnNsWVRzbXBRdURRcnFzcjNzbHJUcmlwUWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1pM3FzcjNzbHJUcnBid3Q3STJvNjQrRUxldVFtT3VLbEMzcXNyM3NtckFwN0plUUlPMlZ0T3VMdWUyVm9DRHJsWXpycDR3ZzdJMm83SnFVTGcwS0RRb2pJeU1nNjQrWjdJS3M3SmVRN0lTY0lDZCs3SXVjSnlEcnVienF1TEFOQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzdaVzA3S2VBN1pXWTdJdWM2cktnN0phMDdKcVVQeURpaHBJZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4TkNpMGc3SXVjN0o2UjdaV1k3SXVjNjRxVUlPdTJoT3lYa09xeWpDQTFMREF3TU95YmtPeWRoQ0RyazV6cm9LVHNtcFF1SU9LR2tpRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzbllRZzY1T2M2NkNrN0pxVUxnMEtEUW9qSXlNZ0orcXpoT3lMbk91THBDY2c0b2FTSUNmc25vanJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKNlE2NCtaN0xDbzY2VzhJT3F3Z095bmdPcXpvQ0RxczRUc2k1enJncGpzbXBRL0lPS0draURzbnBEcmo1bnNzS2pxc0lBZzdKNkk2NEtZN0pxVVB3MEtMU0RycDZUcmk2d2c2N08wN1plWTY2T01JT3lXdk91bmlPeVVxU0RyZ3JUcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHlEaWhwSWc2NmVrNjR1c0lPdXp0TzJYbU91ampPdUtsQ0RzbHJ6cnA0anNuYmpxc0lEc21wUS9JQ29vNjR1bzdJaWNJT3k1bU8yWm1PeWR0Q0RzbFlUcmk0anJuYndnNjZ5NDdKNmw3SjJFSU95RGlPdWhuQ0RzazdRZzdJS3M2NkdBN0ppSTdKcVVLU29OQ2cwS0l5TWpJQ2ZzbDZ6c3JZanJpNlFuSU9LR2tpQW43Wm1WN0oyNDdaV1k2NHVrTENEcnJMdnJpNlFuRFFvTkN1eVlpQ2tOQ2kwZzdKV0k3S0NFN1pXY0lPcXduTzJHdGV5ZGhDRHNuSVR0bGJRZzY2cUg2ckNBN0tlQUlPdUxwT3lMbkNEc2w2enNyYVRyczd6cXNvenNtcFF1SU9LR2tpRHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2Zxc0lEc3A0QWc2NHVrN0l1Y0lPMlpsZXlkdU8yVm9PcXlqT3lhbEM0TkNnMEtJeU1qSUNmcXU1Z25JT0tHa2lBbjdKZVE2cktNSncwS0RRcnNtSWdwRFFvdElPMlpqZXE0dU91UG1ldUxtT3E3bUNEcmdxRHNsWVRxc0lEcXM2QWc3SjZJN0phMDdKcVVMaURpaHBJZzdabU42cmk0NjQrWjY0dVk3SmVRNnJLTUlPdUNvT3lWaE9xd2dPcXpvQ0Rzbm9qc2xyVHNtcFF1RFFvTkNpTWpJeURxc3Izc2xyVHJwYndnNjdxUTdKMkVJT3VWakNEc2xyVHNnNG50bFp3ZzZySzk3SnF3RFFvTkN1eUNyT3lhcWV5ZWtPeWRtQ0Rzb0pYcnM3VHJwYndnNjdDYjY0cVVJT3luaU91c3VPeVhrT3lFbkNEcXVMRHFzNFRzb0lIc25MenJvWndnSjM3c2k1d242Nlc4SU91NmtPeWRoQ0RybFl3ZzY2eTQ3SjZsN0oyMElPeVd0T3lEaWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0tpcnRqSXpzbFlYdGxaanFzNkFnN0l1MjdKMkFJT3lnbGV1enRPdWx2Q0FuN0tPODdKYTBKK3VobkNEc2phanNoSndnNjZ5NDdKNmw3SjJFSU95RGlPdWhyZXF5akNEc2phanJzN1RzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhnNG9hU0lPdU1nT3kybkNEcnFxbnNvSUhzbmJRZzY2eTA3SmVIN0oyNDZyQ0E3SnFVUHcwS0xTRHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOGc0b2FTSU95TG9PcXpvQ0RzbmJUc25LRHJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUV1T3lhbEM0TkNnMEtLaW9xRFFvTkNpTWpJRFV1SUNkNzY2cUY3SUtzZlNBcklIdnJxb1hzZ3F4OUp5RHNrN0RzcDRBZzdKV0s2cml3RFFvTkNpTWpJeUR0bFp6c25wRHNsclFnN1pLQTdKYTA3Sk93NnJpd0RRb05DdTJWbk95ZWtPeVd0Q0RycW9Yc2dxenJwYndnN1pLQTdKYTA3SVNjSU91UG1leUNyQ0R0bUpYdGc1enJvWndnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdKMjA3SjZRSU8yWm1PdTJpT3lkaENEcnNKdnNsWmpzbHJUc21wUWc0b2FTSU95ZHRPeWVrT3VsdkNEcmo0enJvS1Ryc0p2c2xaanNsclRzbXBRTkNpMGc2NEswN0oyOElPeTV0T3VUbk9xd2t1eWR0Q0Rxc3JEc29KenJrS0FnN0ppSTdLQ1Y3SjIwN0plUTdKcVVJT0tHa2lEcmdyVHNuYnpzbllBZzdMbTA2NU9jNnJDU0lPdUNtT3F3Z091S2xDRHJncURzbmJUc2w1RHNtcFFOQ2cwS0l5TWpJTzJWbk95ZWtPeVd0T3VsdkNEdGtvRHNsclRzazdEcXVMQWc3SmEwNjZDazdKcTRJT3F5dmV5YXNBMEtEUW9uZSt1cWhleUNySDNxc0lBZ2UrdXFoZXlDckgzdGxiVHNoSnduSU8yWWxlMkRuT3Vobk91bmpDRHRrb0RzbHJUc3BKanJqNFFnNjQyVUlPeTZrT3lqdk95V3ZPMlZtT3F5akNEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHNucFRzbGFFZzY3YUE3S0d4N0p5ODY2R2NJT3Exck91bnBPMlZtT3luZ0NEcnFydnRsb2pzbHJUc21wUWc0b2FTSU95ZWxPeVZvZXlkdENEcnRvRHNvYkh0bGJUc2hKd2c2cldzNjZlazdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTmk0ZzdaR2M2cml3SU8yR3RleWR2QTBLRFFvakl5TWc2NUNZN0phMDdKcVVJQ2hZS1NEaWhwSWc2NCs4N0pxVUlDaFBLUTBLRFFycnFxanJzSlRzbmJ3ZzdabVU2Nm0wN0oyWUlPeWlnZXlkZ0NEcXM3WHFzSVRzbllRZzZyT2c2NkNrN1pXMElDZnJrSmpzbHJUc21wUW42NHFVSU91cXFPdVJrQ0FuNjQrODdKcVVKK3VobkNEdGhyWHNuYnp0bGJUc2hKd2c3STJvN0tPODdJUzQ3SnFVTGcwS0RRb3FLaW9OQ2cwS0l5TWdOeTRnNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3lJcSt5ZWtDRHRrWnpxdUxBTkNnMEs2NEtnN0tlY3dyZnNpNXpxc0lUQ3QrdXlpTzJZdU91S2xDRHNsWVRybnBnZzdaaVY3SXVkN0p5ODY2R2NJTzJHdGV5ZHZPMlZ0T3lFbkNEc2phanNtcFF1RFFvTkNpTWpJeURyZ3FEc3A1ekN0K3lMbk9xd2hNSzM2cml3NnJDRURRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnNjRLZzdLZWNJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1RVMHVSRVJnSUh3Z01qQXlOUzR3TVM0d01Td2dNalV1TURFdU1ERWdmQTBLZkNEc2k1enFzSVFnZkNEcXVMRHJzN2dnWUVoSU9rMU5PbE5UWUNBdklPeW5wK3F5akNCZ1NFZzZUVTFnSUNqc21LVHNvSVF2N0ppazdadUVJT3lWaUNEc2xJQXBJSHdnTVRRNk16QTZNVEVzSURFek9qTXdJSHdOQ253ZzZyaXc2ckNFSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRWZsbFpXVmt1VFUwdVJFUmdJQzhnN0tlbjZyS01JR0JaV1ZsWkxrMU5Ma1JFZmsxTkxrUkVZQ0I4SURJd01qVXVNREV1TURGK01qQXlOUzR3TVM0ek1Td2dNakF5TlM0d01TNHdNWDR3TVM0ek1TQjhEUXA4SU91Q29PeW5uQ0FySU95TG5PcXdoQ0I4SUdCWldWbFpMazFOTGtSRUlFaElPazFOWUNCOElESXdNalV1TURFdU1ERWdNVFE2TXpBZ2ZBMEtmQ0RzbXBUc25id2dmQ0JnV1ZsWldTNU5UUzVFUkNqc21wVHNuYndwWUNEaWdKUWc3SnVVTCsyWmxDL3NpSmd2NjZxcEwrcTRpQy90aHFBdjdKMjhJSHdnTWpBeU5TNHdNUzR3TVNqc2lKZ3BJSHdOQ2cwS0tpcnNpNXpxc0lRZzdKaUk3Sm00S2lvNklPeUNyT3lhcWV5ZWtPcXdnQ0RzcDRIc29KRWc2ck9nNjZXMDY0cVVJT3V3cWV1c3VNSzM3SmlJN0pXOUlPeUxuT3F3aE95ZGdDQmc3SmlrN0tDRUwreVlwTzJiaENCSU9rMU5ZT3lkaENEc2phanJqNFFnNjQrODdKcVVMZzBLN0ppSUtTRHNtS1R0bTRRZ01Ub3dNQTBLRFFvakl5TWc2Nnk0N0o2bElPeUdqU0RzbDdEc201VHNuYndOQ2cwSzY2eTQ3SjZsSU95VmlPeVhrT3lFbk91S2xDQXFLdXlibE1LMzdKMjhJT3lWbnV5ZG1DQXc3SjJFSU91NXZPcXpvQ29xSU95TnFPeWFsQzROQ2cwSzdKaUlLUTBLTFNBeU1ESTI2NFdFSURBNDdKdVVJREExN0oyOElPeWVoZXVMaU91THBDNGc0b2FTSURJd01qYnJoWVFnT095YmxDQTE3SjI4SU95ZWhldUxpT3VMcEM0TkNnMEtJeU1qSU95RGdldU1nQ0RzaTV6cXNJUWdLT3VGdU95Mm5PeWFxU2tOQ2cwS2ZDRHNvYkRxc2JRZ2ZDRHRrWnpxdUxBZ2ZBMEtmQzB0TFMwdExYd3RMUzB0TFMxOERRcDhJRFl3N0xTSUlPdXZ1T3VuakNCOElPdXdxZXE0aUNEc29JUWdmQTBLZkNBMk1PdTJoQ0RycjdqcnA0d2dmQ0JPNjdhRUlPeWdoQ0I4RFFwOElESTA3SXVjNnJDRUlPdXZ1T3VuakNCOElFN3NpNXpxc0lRZzdLQ0VJSHdOQ253Z016RHNuYndnNjYrNDY2ZU1JSHdnVHV5ZHZDRHNvSVFnZkEwS2ZDQXhNdXF3bk95YmxDRHJyN2pycDR3Z2ZDQk82ckNjN0p1VUlPeWdoQ0I4RFFwOElERXk2ckNjN0p1VUlPeWR0T3lEZ1NCOElFN3JoWVFnN0tDRUlId05DZzBLN0ppSUtTRHJzS25xdUlnZzdLQ0VMQ0ExNjdhRUlPeWdoQ3dnTXV5TG5PcXdoQ0Rzb0lRc0lEUHNuYndnN0tDRUxDQTI2ckNjN0p1VUlPeWdoQ3dnTXV1RmhDRHNvSVFOQ2cwS0l5TWpJT3VuaU9xd2tNSzM2cml3NnJDRUlPdW5qT3VqakEwS0RRcGdSQzFPWUNoTzdKMjhJT3VDcU95ZGpDa2dMeUJnUkMwd1lDanNtS1RyaXBnZzY2ZUk2ckNRS1NBdklHQkVLMDVnS0U3c25id2c2cks5NnJPOEtRMEs3SmlJS1NCRUxUY3NJRVF0TVN3Z1JDMHdMQ0JFS3pFTkNnMEtJeU1qSU91eWlPMll1Q0R0a1p6cXVMQWdLTzJWbU95ZHRPMlVpT3ljdk91aG5DRHF0YXpydG9RcERRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnN0tDRTdabVU2N0tJN1ppNElId2c3WldZN0oyMDdaU0lJT3Exck91MmhDQjhJREF5TFRFeU16UXROVFkzT0N3Z01ERXdMVEV5TXpRdE5UWTNPQ0I4RFFwOElPeTV0T3VUbk91eWlPMll1Q0I4SURUc25wRHJwcXpzbEtrZzdaV1k3SjIwN1pTSUlId2dNVEl6TkMwMU5qYzRMVGt3TVRJdE16UTFOaUI4RFFwOElPcXpoT3lpak91eWlPMll1Q0I4SU8yVm1PeWR0TzJVaUNEcXRhenJ0b1FnZkNBeE1qTXRORFUyTFRjNE9UQXhNaUI4RFFwOElPeWp2T3V2dk91VHNldWhuZXV5aU8yWXVDQjhJT3lWbmlBMjdKNlE2NmFzTGV1U3BDQTM3SjZRNjZhc0lId2dNVEl6TkRVMkxURXlNelExTmpjZ2ZBMEtmQ0RzZ3F6c2w0WHNucERyazdIcm9aM3Jzb2p0bUxnZ2ZDQXhNT3lla091bXJDRHRsWmpzbmJUdGxJZ2dmQ0F3TVMweU16UXROVFkzT0RrZ2ZBMEtEUW9qSXlNZzdKT3c2Nm0wSU95VmlDRHJrSmpyaXBRZzdaR2M2cml3RFFvTkNpMGc2NEtnN0tlYzdKZVFJTzJWbU95ZHRPMlVpTUszNjdtWDZyaUlPaURpbll3Z01qQXlOUzB3TVMwd01Td2dNREV2TURFTkNpMGc3SXVjNnJDRTdKZVFJT3lZcE95Z2hDL3NtS1R0bTRRNklPS2RqQ0RzbUtUc29JUWdNZXlMbkNBcUtPdUxxQ3dnN0lLczdKcXA3SjZRNnJDQUlPeW5nZXlna1NEcXM2RHJwYlRyaXBRZzY3Q3A2Nnk0d3Jmc21JanNsYjBnN0l1YzZyQ0U3SjJBSU95WWlPeVp1Q2txRFFvTkNpb3FLZzBLRFFvakl5QTRMaUR0akozc2w0VW82NHVrN0oyMDdKYTg2NkdjNnJlNEtRMEtEUXJ0akozc2w0VWc2Nnk0NnJXczY0cVVJQ29xN0pldDdaV2dLaW9vN1lPQTdKMjA3WXVBd3Jmc2xZanJnclRDdCt1eWhPMkt2Q25xczd3Z0tpcnNuS0R0bUpVcUtpanRoclhyczdRdjdZeVE2NHVvS2V5WGtDRHJsTERybmJ3ZzY2eTQ3TEswNnJDQUlPdUxyT3Vkdk95YWxDNGc3WU9BN0oyMDdZdUE3SjJFSU91THBPdVRyT3lkaENEcmxaQWc2N0NZNjVPYzdJdWNJT3lWaU91Q3RDanJzN2pyckxncDZybU03S2VBSU9xd21leWR0Q0RyczdUcXM2QXNJT3V6dU91c3VDRHJwNlhybmIzc25ZUWc2NHUwN0pXRTdKVzhJTzJWdE95YWxDNE5DZzBLSXlNaklERHJpNmpxczRRZzRvQ1VJTzJLdU91bXJPcXhzT3UyZ08yRXNDRHJ0SkRzbXBRTkNnMEs3WXlkN0plRjdKMjBJT3lDck95YXFleWVrT3lkbUNEc2xyVHJscVFnN1phSjY0K1pJT3VTcE95WGtDRHJuS2pyaXBUc3A0QWc2Nmk4N0tDQUlPMk1qT3lWaGUyVnRPeWFsQzROQ2cwS0xTRHRsb25yajVuc25ZUWdLaXJxc0lEcm9aenJwNG5xc2JEcmdwZ2c3WXlRNjR1bzdKMkVJT3lhbE9xMXJDb3FLT3lkdE8yRGlNSzM3SUt0N0tDY3dyZnJvWnpxdDdqc2xZVHNtNFBDdCt5aWhldWpqQ2tnNG9hU0lDb3E3WXlRNjR1bzdaaVZLaW9nS091c3ZPeVd0T3Uwa095YWxDa05DaTBnNnJLdzZyTzh3cmZzZzRIdGc1enJwYndnS2lydGhyWHJzN1RycDR3cUtpQW83Sm1FNjZPTXdyZnNpNlR0aktncElPS0draUFxS3V5VmlPdUN0TzJZbFNvcUlDanNsWXpyb0tUc3BKanNtcFFwRFFvTkNpTWpJeUR0ZzREc25iVHRpNEFnNG9DVUlPeW5wK3lkZ0NEcnFvWHNncXpxdGF3TkNnMEtMU0RycW9Yc2dxenRtSlhzbkx6cm9ad2c2NEdkNjRLMDdKcVVMaURzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5PdWx2Q0RzazdEc3A0QWc3SldLN0pXRTdKcVVJQ2grN0pxVUlDOGdmdXVMcENBdklIN3F1WXpzbXBRL0lPS2RqQ2t1RFFvdElESitOT3lXdE95Z2lPdWhuQ0RzcDZmcXM2QWc3SW05NnJLTUxpRHRsWnpzbnBEc2xyVEN0K3lJbU95TG5leWRoQ0RxdUxqcXNvd2c3SXlUN0tlQUlPeVZpdXlWaE95YWxDNE5DaTBnN0pXSTY0SzBLT3V6dU91c3VDa2c2NmVsNjUyOTdKMkVJT3lhbE95VnZlMlZ0Q3dnS2lydGc0RHNuYlR0aTREcnA0d2c2N1NRNjQrRUlPdXN0T3lLcUNEdGpKM3NsNFhzbmJqc3A0QXFLaURzbFl6cXNvd2c3WlcwN0pxVUxpRHNtNURyczdqc25iUWdKK3lWak91bXZNSzM3Wm1WN0oyNEoreXltT3VmdkNEcnA0bnNsN0R0bFpqcnFiUWc2N080NjZ5NDdKMkVJT3Ezdk9xeHNPdWhuQ0RxdGF6c3NyVHRtWlR0bGJUc21wUXVEUW9OQ253ZzdKMjA2NkNINnJLTUlPdW5rT3F6b0NCOElPeWR0T3VnaCtxeWpDQjhEUXA4TFMwdGZDMHRMWHdOQ253ZzdLQ0E3SjZsN1pXWTdLZUFJT3lWaXVxem9DRHJncGpxc0lEc2k1enFzcURzbHJUc21wUS9JSHdnN0tDQTdKNmxJT3lWaUNEdGxad2c2NEswN0pxcElId05DbndnN0pXTTY2YThJSHdnNnJLdzdLQ2NJT3laaE91ampDQjhEUXA4SU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JSHdnNjQydzdKMjA3WVN3SU95Q3JleWduQ0I4RFFvTkNpTWpJeURzbFlqcmdyUW82N080NjZ5NEtTRGlnSlFnN1pXMDdKcVU3TEswRFFvTkNpMGdLaXJ0akpEcmk2anRtSlVxS3V5ZGdDQW5mdTJWb09xNWpPeWFsRDhuNjZHY0lPdXN2T3lXdE95YWxDNGc2NUNZNjQrTTY2YTBJT3lJbUNEc2w0YnJpcFFnN0p5RTdaZVlLT3lDcmV5Z25NSzM3WU9JN1llMElPdVRzU25zbllBZzZyS3c2ck84NjZXOElPdW92T3lnZ0NEcXNyM3FzNkR0bGJUc21wUXVEUW90SUNvcTdKV0k2NEswN1ppVktpcnNuWUFnN0lLczdJdWs3SjJFSU95RW5PeUlvTzJWdE95YWxDNE5DaTBnNjZlSTdMbW83WkdjNjZXOElPeU5xT3lhbEM0ZzdJaXI3SjZRd3Jmc29iRHFzYlFvN0oyMDdJT0J3cmZzbmJUdGxaakN0K3lkdE91Q3RDRHJrN0VwN0oyQUlPcTN1T3VNZ091aG5DRHJrWkRxczZBc0lPeWJrT3VzdU95WGtDRHNsNGJyaXBRZzdLQ1Y2N08wd3Jmc29JanNzS2pDdCt5WHNPdWR2ZXl5bU91bHZDRHNwNERzbHJUcmdyVHNwNEFnN0pXSzdKV0U3SnFVTGcwS0RRb2pJeU1nNjdLRTdZcThJT0tBbENEc2xZanJnclFnNjZ5NDY2ZWw3SjIwSU95Z2xlMlZ0T3lhbEEwS0RRcDhJT3V6dU91c3VPeWR0Q0RzbmJUcm9JZnJpNlFnZkNEcnNvVHRpcndnZkEwS2ZDMHRMWHd0TFMxOERRcDhJT3F5c09xenZNSzM3SU9CN1lPYzY2VzhJTzJHdGV1enRDQjhJRnZ0bVpYc25iaGRJSHdOQ253Z0ozN3RsYURxdVl6c21wUS9KK3VobkNEcnJMenNuWXdnZkNCYjdKV0U2NHVJN0ppa1hTREN0eUJiNjRTa1hTQjhEUXA4SU95RGdlMlpxU0RzaEp6c2lLQWdLeURzbUtUcnBianNxcjNzbmJRZzdJdWs3S0NjSU91UG1leWVrU0I4SUZ2c3Q2anNob3hkSU1LM0lGdDc2NCtaN0o2UmZWMGdmQTBLRFFvdElDZnN0NmpzaG93bjY0cVVJQ29xNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUtpb2c3STJvN0pxVUlDanNtSWc2SUZ2c3Q2anNob3hkd3JkYjdJS3Q3S0NjWFNrdUlDZnJpNnZxdUxBZ3dyY2c2NCtaN0o2UkoreXltT3VmdkNEc3A1M3NuYlFnN0pXSUlPdW5udXVLbENEc29iRHRsYW5zbmJUcmdwZ2c2NHVvNjQrRklDZnN0NmpzaG93bjY0cVVJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW90SU91eWhPMkt2T3lkbUNEcmo1bnNucEVnN0oyMDY2YUU3SjJBSU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGhDRHF0N2pyaklEcm9ad2c3SUswNjZDazdKcVVMZzBLRFFvakl5TWc3WWExN0tlY0lPeVlpT3lMbkEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdKMjA3WU9JS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURzb0lEc25xVWc3SldJSU8yVm5DRHJnclRzbXFrTkNpMGc3SldJNjRLME9pRHNvSURzbnFYdGxaanNwNEFnN0pXSzZyT2dJT3VDbU9xd2lPcTVqT3lhbEQ4ZzdKNkY2NkNsN1pXY0lPdUN0T3lhcWV5ZHRDRHNncXpybmJ6c29ManNtcFF1RFFvdElPdXloTzJLdkRvZzdKV0U2NHVJN0ppa0lNSzNJT3VFcEEwS0RRb3FLdTJNa091THFPMllsU0RpZ0pRZzdJS3Q3S0NjSUNqc25JVHRsNWdwS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURyamJEc25iVHRoTEFnN0lLdDdLQ2NEUW90SU95VmlPdUN0RG9nN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEc2dyVHJwclFnN0lpWUlPeVhodXlXdE95YWxDNGc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3MEtMU0Ryc29UdGlydzZJT3lWaE91TGlPeVlwQ0RDdHlEcmhLUU5DZzBLS2lycmo1bnNucEh0bUpVZzRvQ1VJT3lFbk95SW9DQXJJT3VQbWV5ZWtTRHJzb1R0aXJ3cUtnMEtMU0R0ZzREc25iVHRpNEE2SU9xNHNPcTRzQ0RzbDdEcXNyQWc3WlcwN0tDY0RRb3RJT3lWaU91Q3REb2c3SVNnN1lPZDdaV2NJT3E0c09xNHNPeWRtQ0RzbDdEcXNyRHNuWVFnNjRHSzdKYTA3SnFVTGcwS0xTRHJzb1R0aXJ3NklPeTNxT3lHakNEQ3R5RHNsN0Rxc3JBZzdaVzA3S0NjRFFvTkNpb3E3SldJNjRLMDdaaVZJT0tBbENEc21ZVHJvNHdnN1lhMTY3TzBLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHFzckRzb0p3ZzdKbUU2Nk9NRFFvdElPeVZpT3VDdERvZzZyS3c3S0NjNnJDQUlPeWdsZXlEZ1NEc3NwanJwcXpya0pEc2xyVHNtcFF1RFFvdElPdXloTzJLdkRvZzdabVY3SjI0RFFvTkNpb3FLZzBLRFFvaklPeVlpT3ladUNEcXQ1enN1WmtOQ2cwSzdKdVE3TG1aS091S3BldVBtY0szNnJpTjdLQ1Z3cmZzdXBEc283enNscndwNjdPMDY0dWtJT3lZaU95WnVPcXdnQ0RyalpRZzY2cUY3Wm1WN1pXY0lPeTdwT3V1cE91TGlPeThnT3lkdE95Rm1PeWRoQ0RycDR6cms1enJpcFFnNnJLOTdKcXc3SmlJN0pxVUxnMEtEUW9qSXlEc21JanNtYmdnTVM0ZzdJaVk2NCtaN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzY1Q1k2NHFVSU9xeXZleWFzQTBLRFFvakl5TWc3SVNjNjdtRTdJcWtJT3lpaGV1ampDd2c2cml3NnJDRUlPdW5qT3VqakEwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95anZPeVd0Q2pzb29Ycm80d2c3SVNjNjdtRTdJcWtMQ0RxdUxEcXNJUWc2NU94S2V1bHZDRHFzSlhzb2JEdGxhQWc3SWlZSU95ZWlPcXpvQ3dnSit5aWhldWpqQ2ZzbVlBZ0ordW5qT3VqakNmc25aZ2c2NG1ZN0pXWjdJcWs2Nlc4SU95Z2xlMlpsZTJlaUNEc29JVHJpNnp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNCUFQwOGc3SVNjNjdtRTdJcWtJT3lpaGV1ampDRHNsWWpyZ3JRZzRvQ1VJREF3N0p1VUlEQXc3SjI4NjdhQTdZU3dJT3lFbk91NWhPeUtwT3F3Z0NEc29vWHJvNHpyajd6c21wUXVJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWVFnN0pXTTY2Q2s2NU9jNjZDazdKcVVMZzBLTFNEc25wRHNnckFnN0tHdzdacU1JT3E0c09xd2hPeWR0Q0RxczZjZzY2ZU02Nk9NNjQrODdKcVVMZzBLRFFycmk2Z3NJQ29xN0tPODZyaXc3S0NCN0p5ODY2R2NJT3lpaGV1ampPcXdnQ0Ryc0pqcnM3WHJrSmpyaXBRZzdLQ2M3WktJS2lyc2w1RHJpcFFnSit5aWhldWpqT3VQdk95YWxDZnJwYndnN0pPdzdLZUFJT3lWaXV5VmhPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc21LVHJpcGpzblpnZzdZQzA3S2FJNnJDQUlPcXpweURzb29Ycm80enJqN3pzbXBRZzRvYVNJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxBMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKZVE2cktNSU91dnVPeTVtT3VLbENEc21JSHRscVhzbllRZzdKV002NkNrN0tTRUlPdVZqQTBLRFFvbzdLTzg3SnFVSU91UG1leUNyQ0E2SU95WHNPeXl0Q3dnN1pXMDdLZUFMQ0Rzb0lIc21xa2c2NU94S1EwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95ZHVPcXp2Q0RxdElEcXM0VHJwYndnNjZxRjdabVY3WldZNnJLTUlPeUVwT3VxaGUyVm1PcXpvQ3dnSit5Q3JPeWFxZXlla095ZG1DRHRsb25yajVuc2w1QWc2NVN3NjUyODdKaWs2NHFVSU9xeXNPcXp2Q2ZybmJ6cmlwUWc3S0NRN0oyRUlPeVZqT3VncE95a2hDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeVlwT3VLbU9xNWpPeW5nQ0RyZ3JUc3A0QWc3SldLN0p5ODY2bTBJT3lYc095eXRPdVB2T3lhbEM0ZzdadUU2N2FJNnJLdzdLQ2NJT3E0aU95Vm9leWRoQ0RyZ3JUc283enNoTGpzbXBRdURRb3RJT3VNZ095Mm5PeWRoQ0Rxc0lqc2xZVHRnNERycWJRZzdKdVE2NTZZSU91TWdPeTJuT3lkdENEdGxiVHNwNERyajd6c21wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXaWV5WGtDRHJnclRzbGJ3ZzdaVzA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95VmlPeUxyQ0FvN0lpWTY0K1o3WmlWS1EwS0RRb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3SXVjN0lxazdZV2M3SjIwSU95ZWtPdVBtZXljdk91aG5DRHNzcGpycHF6dGxaenJpNlRyaXBRZzdLQ1FLaXJzbllRZzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95ZHRPeWduT3UyZ08yRXNDRHRtWTNxdUxqcmo1bnJpNWpzblpnZzZyQ2M3SjI0N0tDVjY3TzBJT3lkdE95YXFTRHJnclRzbDYzc25iUWc2cml3NjZHZDY0Kzg3SnFVRFFvdElPdU5sQ0Rzb292c25ZQWc3SU9CNjR1MDdKMkVJT3ljaE8yVnRDRHRoclh0bVpRZzY0SzA3SnFwN0oyQUlPdUZ1ZXlkak91UHZPeWFsQTBLRFFvakl5RHNtSWpzbWJnZ01pNGc2cks5N0phMDY2VzhJT3lOcU91UGhDRHJrSmpyaXBRZzZySzk3SnF3RFFvTkN1Mkt1ZXlnbFNEc2c0SHRtYW5zbDVEc2hKd2c3S0NjN1pXYzdLQ0I3Snk4NjZHY0lDZnNpNXpyZ3Bqc21wUS9MQ0RzaGFqcmdwanNtcFEvSnlEc25aanJyTGp0bUpVZzdKYTA2Nis0NjZXOElPeVR1Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UTdKMllJT3VucGV1ZHZleWRoQ0R0bVp6c21xbnRsYlRzaEp3ZzdLZUk2Nnk0N1pXZ0lPdVZqQTBLRFFvbjdJdWM2NEtZN0pxVVB5Y3NJQ2ZzaGFqcmdwanNtcFEvSnlEdG1KWHRnNXpzblpnZzZySzk3SmEwNjZXOElPMlpuT3lhcWUyVnRPeUVuQ0RzZ3F6c21xbnNucERzblpnZzY0dTU3Wm1wN0lxazY1K3M3SnVBN0oyRUlPeWtoT3lkdkNEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1Dd2dUMDlQSU91THBPdUZnT3lZcE95RnFPdUNtT3lhbEQ4TkNpMGc3TGFwN0tDRTdaV1k2NStzSU8yT3VPeWRtT3lna0NEcXNJRHNpNXpyZ3Bqc21wUS9EUW9OQ2lNakl5RHNncXpzbXFuc25wRHNuWmdnN0lPQjdabXA3SjJFSU95MmxPeWdsZTJWb0NEcmxZd05DZzBLNjZxRjdabVY3WldjSU95Z2xldXp0T3F3Z0NEc2w0YnNsclRzaEp3ZzdJS3M3SnFwN0o2UTdKZVE2cktNSU95bmdleWdrU0R0akpEcmk2anRsWmpxc293ZzdaVzA3Slc4SU8yVm9DRHJsWXdnNnJLOTdKYTA2NkdjSU95Z2xleWtrZTJWbU9xeWpDRHNwNGpyckxqdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEs3SmlJS1EwS0xTRHN1YlRyazV6cnBid2c2N0NiN0p5ODdJV282NEtZN0pxVVB5RHJrN0hyb1ozdGxaanJxYlFnN0xxUTdJdWM2N0N4SU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLSXlNaklPeUNyT3lhcWV5ZWtPeWRtQ0RzaEtEc25aanFzSUFnN1pXRTdKcVU3WldnSU91VmpBMEtEUXJzaEtUcnJManNvYkRzZ3F6c3NwanJuN3dnN0lLczdKcXA3SjZRN0oyWUlPeUVvT3lkbU91bHZDRHF1TERyaklEdGxiVHNsYndnN1pXZ0lPdVZqQ0Rxc3Izc2xyVHJvWndnN0tDVjdLU1I3WldZNnJLTUlPeW5pT3VzdU8yVnRPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25iVHJzb2dnNjR1czdKZVFJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bFpqcnFiVHNoSndnN0phODY2ZUk2NEtZSU91bmpPeWhzZTJWbU95RnFPdUNtT3lhbEQ4TkNnMEtJeU1nN0ppSTdKbTRJRE11SU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU91UW1PdUtsQ0Rxc3Izc21yQU5DZzBLN0lLczdKcXA3SjZRN0plUTZyS01JT3VxaGUyWmxlMlZtT3F5akNEcnRvRHNvSlhzb0lIc25iZ2c2NEswN0pxcDdKMkVJT3lWak91Z3BPeWttT3lWdkNEdGxhQWc2NVdNNjRxVUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPeWlpK3lWaE95YWxDNE5DZzBLSXlNaklPeUVuT3U1aE95S3BPdWx2Q0Rzb0pYc3NZWHNnNEVnN0pPNElPeUltQ0RzbDRic25ZUWc2NVdNRFFvTkN1dTJnT3lnbGUyWWxleWN2T3VobkNEc2phanNsYndnN0lLczdKcXA3SjZRN0plUTZyS01JT3lEZ2UyWnFleWRoQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN0l1YzdZS3NJT3lJbUNEc25vanNsclRzbXBRdUlDb3E3Sk80SU95SW1DRHNsNGJyaXBRZzdKMjA3SnlnNjZXOElPMlZxT3E3bUNEc2xZanJnclR0bGJUc283enNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RzcDREcXVJanNuWUFnNnJDQTdKNkY3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJT3l5cmV5R2pPdUZoT3lkaENEc25JVHRsWndnN0lTYzY3bUU3SXFrNjRxVUlPeVZoT3luZ1NEc3BJRHJ1WVFnN0tTUjdKMjA3SmVRN0pxVUxnMEtMU0RxczdYcnJMVHNtNURzbllBZzdadUU3SnVRNnJpSTdKMkVJT3V6dE91Q3ZDRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0oyODY3YUFJT3E0c091S3BldW5qQ0RzazdnZzdJaVlJT3lYaHV5ZGhDRHJsWXdOQ2cwSzY3YUE3S0NWN1ppVjdKeTg2NkdjSU95TnFPeVZ2Q0RzZ3F6c21xbnNucERxc0lBZzdKYTA2NWFrSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95WGh1dUtsT3luZ0NEcnFvWHRtWlh0bFpqcXNvd2c3SjI0N0tlQTdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrTkNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGcwS0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtEUW9qSXlNZzdJS3M3SnFwN0o2UUlPeUVvTzJEbmV5ZG1DRHFzckRxczd6cnBid2c3SldJNjRLMDdaV2dJT3VWakEwS0RRcnJrSmpyajR6cnByUWc3SWlZSU95WGh1dUtsQ0RzaEtEdGc1M3NuWUFnNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3VxaGUyWmxlMlZtT3F5akNEc2xZenJvS1RzbXBRdURRb05DdXlZaUNrTkNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrTkNnMEtKK3lnbGV1enRDRHNpSmpzcDVFZzdKV0k2NEswSnlEcms3SHNuWmdnNjYrODZyQ1E3WldjSU95RGdlMlpxZXlYa095RW5DQXFLdXlnbGV1enRPcXdnQ0RyczdUdG1ManJrSnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeURnZXVMdE95ZHRDRHJnWjNyZ3BqcnFiUWc3S0NFNjZ5NDZyQ0E2NCtFSU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHJwYndnNjdPOElPeUltQ0RzbDRic2xyVHNtcFF1RFFvdElPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1Rxc0lBZzZyaXc2NkdkNjVDWTdLZUFJT3lWaXV5VmhPeWFsQzROQ2cwS0l5TWc3SmlJN0ptNElEUXVJT3lnbk8yU2lDRHNtcW5zbHJUcmlwUWc2N0NVNnI2NDdLZUFJT3lWaXVxNHNBMEtEUW9uNnJDRTZyS3c3WldZNnJPZ0lPeUpyT3lhdENEcnA1QW5JT3lia095NW1ldXp0T3VMcENBcUt1MlpsT3VwdE95ZG1DRHF1TERyaXFYcnFvWEN0K3V5aE8yS3ZPdXFoZXF6dk95ZG1DRHNtcW5zbHJRZzdKMjg3TG1ZS2lycXNJQWc3SnF3N0lTZzdKMjA3SmVRN0pxVUxnMEs2cml3NjRxbDY2cUY3SmVRSU95VHNPeWR1Q0RyaTZqc2xyUW82N09BNnJLOUxDRHNwNERzb0pVc0lPdVRzZXVoblNEcms3RXA2Nlc4SU95VmlPdUN0Q0RyckxqcXRhenNsNURzaEp3ZzY0dWs2Nlc0SU91bmtPdWhuQ0Ryc0pUcXZyanJxYlFnN0lLczdKcXA3SjZRNnJDQUlPdUxwT3VsdUNEcXVMRHJpcVhzbkx6cm9ad2c3SmlrN1pXMDdaV2dJT3lJbUNEc25vanNsclRzbXBRdURRb05DdXlZaUNrZ0orcTJqTzJWbkNEcnM0RHFzcjBuSU9xNHNPdUtwZXlkbUNEc2xZanJnclFnNjZ5NDZyV3NEUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxaanJxYlFnNjdDVTZyK0FJT3lJbUNEc25vanNsclRzbXBRZ0tGZ3BEUW90SU91THBPdWx1Q0RzZ3F6cm5venNuWVFnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091aG5DRHNwNERzb0pYdGxaanJxYlFnNjdPQTZySzk3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJT3lZaU95WnVDQTFMaURzaTV6c2lxVHRoWndnNjQrWjdKNlI2ck84SU91THBPdWx1Q0RyajVuc2dxd2c3Sk93N0tlQUlPeVZpdXE0c0EwS0RRcnJyTGpxdGF6cnBid2c3SldFNjZ5MDY2YXNJT3VucE91QmhPdWZ2ZXF5akNEcmk2VHJrNnpzbHJUcmo0UWdLaXJzaTZUc29Kd2c3SXVjN0lxazdZV2NJT3VQbWV5ZWtlcXp2Q0RyaTZUcnBiZ2c2NCtaN0lLc0tpcnJwYndnN0pPdzY2bTBJT3llbU91cXUrdVFuQ0RyckxqcXRhenNtSWpzbXBRdURRb05DdXlZaUNrZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWx2Q0FuN0xhVTZyQ0FJT3luZ095Z2xTZnRsWmpyaXBRZzdJdWM3SXFrN1lXYzdKZVE3SVNjSUNqc25iVHNvSVRDdCt5V2tldVBoQ0RxdUxEcmlxWHNuYlFnN0pXRTY0dVlLUTBLTFNEcmk2VHJwYmdnN0lLczY1Nk03SmVRNnJLTUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJwYndnNjRTWTZyS283S084N0lTNDdKcVVJQ2hZSU9LQWxDRHNsNGJyaXBRZ0ordUVtT3E0c09xNHNDY2c2cml3NjRxbDdKMkVJT3lWbE95TG5Da05DaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVnRDRHNvN3pzaExqc21wUWdLRThwRFFvPScKRElSPSIkSE9NRS9MaWJyYXJ5L0FwcGxpY2F0aW9uIFN1cHBvcnQvQ2xhdWRlQnJpZGdlIgpwdXQoKSB7IHByaW50ZiAlcyAiJDEiIHwgYmFzZTY0IC1EID4gIiQyIjsgfQojIOydtCAuY29tbWFuZOqwgCDrj4TripQg7YSw66+464SQIOywveunjCDqs6jrnbwg64ur64qU64ukKHR0eSDrp6Tsua0pLiBiYXNo6rCAIOuBneuCmCDtg63snbQgaWRsZeuQnCAx7LSIIOuSpOyXkCDri6vslYQKIyAi7ZSE66Gc7IS47IqkIOyLpO2WiSDspJEiIOqyveqzoOulvCDtlLztlZzri6Qg4oCUIGRpc293buycvOuhnCDsiqTtgazrpr3tirjqsIAgZXhpdO2VtOuPhCDri6vquLAg7J6R7JeF7J2AIOyCtOyVhOuCqOuKlOuLpC4gKOunpSDsi6TquLAg6rKA7KadIO2VhOyalCkKTVlUVFk9IiQocHMgLW8gdHR5PSAtcCAkJCAyPi9kZXYvbnVsbCB8IHRyIC1kICIgIikiCmNsb3NlX3Rlcm1pbmFsKCkgewogIFsgLXogIiRNWVRUWSIgXSAmJiByZXR1cm4KICAoIHNsZWVwIDEKICAgIC91c3IvYmluL29zYXNjcmlwdCA+L2Rldi9udWxsIDI+JjEgPDxPU0EKdGVsbCBhcHBsaWNhdGlvbiAiVGVybWluYWwiCiAgcmVwZWF0IHdpdGggdyBpbiB3aW5kb3dzCiAgICB0cnkKICAgICAgcmVwZWF0IHdpdGggdCBpbiB0YWJzIG9mIHcKICAgICAgICBpZiB0dHkgb2YgdCBpcyAiL2Rldi8kTVlUVFkiIHRoZW4gY2xvc2UgdyBzYXZpbmcgbm8KICAgICAgZW5kIHJlcGVhdAogICAgZW5kIHRyeQogIGVuZCByZXBlYXQKZW5kIHRlbGwKT1NBCiAgKSAmIGRpc293biAyPi9kZXYvbnVsbCB8fCB0cnVlCn0KIyDslYjrgrTripQg7ZSM65+s6re47J247J20IOuztOyXrOykgOuLpCDigJQg7YSw66+464SQ7J2AIOyEpOy5mMK37KCQ6rKA66eMIO2VmOqzoCDsiqTsiqTroZwg64ur7Z6M64ukLgpmaW5pc2goKSB7IGNsb3NlX3Rlcm1pbmFsOyBleGl0ICIkMSI7IH0KZWNobyAi7YG066Gc65OcIOy7pOuEpe2EsOulvCDshKTsuZjtlZjqs6Ag7J6I7Ja07JqU4oCmIOyeoOyLnCDtm4Qg7J20IOywveydgCDsnpDrj5nsnLzroZwg64ur7ZiA7JqULiIKbWtkaXIgLXAgIiRESVIvc2NyaXB0cyIgfHwgeyBlY2hvICLtj7TrjZQg7IOd7ISxIOyLpO2MqDogJERJUiI7IGZpbmlzaCAxOyB9CnB1dCAiJEI2NF9CUklER0UiICAgIiRESVIvc2NyaXB0cy9jbGF1ZGUtYnJpZGdlLmpzIgpwdXQgIiRCNjRfV0FUQ0hFUiIgICIkRElSL3NjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanMiCnB1dCAiJEI2NF9FWEFNUExFUyIgIiRESVIvcmVjb21tZW5kLWV4YW1wbGVzLm1kIgpwdXQgIiRCNjRfR1VJREUiICAgICIkRElSL3V4LXdyaXRpbmcubWQiCmVjaG8gIuKchSDtjIzsnbwg7ISk7LmYOiAkRElSIgojIEdVSeyXkOyEnCDsl7AgVGVybWluYWzsnYAgUEFUSOqwgCDsooHsnYQg7IiYIOyeiOyWtCDtnZTtlZwg7ISk7LmYIOqyveuhnOulvCDrs7Ttg6Dri6QKZXhwb3J0IFBBVEg9IiRIT01FLy5sb2NhbC9iaW46L29wdC9ob21lYnJldy9iaW46L3Vzci9sb2NhbC9iaW46JFBBVEgiCiMgbm9kZeqwgCDsl4bsnLzrqbQg6rCQ7Iuc7J6QKD1ub2RlKSDsnpDssrTqsIAg66q7IOuPjOyVhCDtlIzrn6zqt7jsnbjsl5Ag7JWM66a0IOuwqeuyleydtCDsl4bri6Qg4oaSIOydtCDqsr3smrDrp4wg64Sk7J207Yuw67iMIO2MneyXheycvOuhnCDslYjrgrTtlZzri6QKaWYgISBjb21tYW5kIC12IG5vZGUgPi9kZXYvbnVsbCAyPiYxOyB0aGVuCiAgb3Nhc2NyaXB0IC1lICdkaXNwbGF5IGRpYWxvZyAi7J20IE1hY+yXkCBOb2RlLmpz6rCAIOyXhuyWtOyalC4gW+2ZleyduF3snYQg64iE66W066m0IOuLpOyatOuhnOuTnCDtjpjsnbTsp4DqsIAg7Je066Ck7JqULiBOb2RlLmpzKExUUynrpbwg7ISk7LmY7ZWcIOuSpCDsnbQg7ISk7LmYIO2MjOydvOydhCDri6Tsi5wg7Iuk7ZaJ7ZW0IOyjvOyEuOyalC4iIHdpdGggdGl0bGUgIu2BtOuhnOuTnCDsu6TrhKXthLAg4oCUIE5vZGUuanMg7ZWE7JqUIiBidXR0b25zIHsi7ZmV7J24In0gZGVmYXVsdCBidXR0b24gMSB3aXRoIGljb24gY2F1dGlvbiBnaXZpbmcgdXAgYWZ0ZXIgMTgwJyA+L2Rldi9udWxsIDI+JjEKICBvcGVuICJodHRwczovL25vZGVqcy5vcmcva28vZG93bmxvYWQiIDI+L2Rldi9udWxsCiAgZmluaXNoIDAKZmkKTk9ERV9CSU49IiQoY29tbWFuZCAtdiBub2RlKSIKZWNobyAi4pyFIE5vZGUuanM6ICQobm9kZSAtLXZlcnNpb24pIgojIOqwkOyLnOyekCBsYXVuY2hkIOuTseuhnSAo66Gc6re47J24IOyekOuPmeyLnOyekSArIOyngOq4iCDquLDrj5kpLiBQQVRI66W8IHBsaXN07JeQIOq1s+2YgCDrhKPripTri6Qg4oCUIGxhdW5jaGQg6riw67O4IFBBVEjsl5QgY2xhdWRl6rCAIOyXhuuLpC4KUExJU1Q9IiRIT01FL0xpYnJhcnkvTGF1bmNoQWdlbnRzL2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlci5wbGlzdCIKbWtkaXIgLXAgIiRIT01FL0xpYnJhcnkvTGF1bmNoQWdlbnRzIgpTQUZFX1BBVEg9IiR7UEFUSC8vJi8mYW1wO30iCmNhdCA+ICIkUExJU1QiIDw8UExJU1RFT0YKPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPCFET0NUWVBFIHBsaXN0IFBVQkxJQyAiLS8vQXBwbGUvL0RURCBQTElTVCAxLjAvL0VOIiAiaHR0cDovL3d3dy5hcHBsZS5jb20vRFREcy9Qcm9wZXJ0eUxpc3QtMS4wLmR0ZCI+CjxwbGlzdCB2ZXJzaW9uPSIxLjAiPgo8ZGljdD4KICA8a2V5PkxhYmVsPC9rZXk+PHN0cmluZz5jb20uY2xhdWRlYnJpZGdlLndhdGNoZXI8L3N0cmluZz4KICA8a2V5PlByb2dyYW1Bcmd1bWVudHM8L2tleT4KICA8YXJyYXk+CiAgICA8c3RyaW5nPiROT0RFX0JJTjwvc3RyaW5nPgogICAgPHN0cmluZz4kRElSL3NjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanM8L3N0cmluZz4KICA8L2FycmF5PgogIDxrZXk+RW52aXJvbm1lbnRWYXJpYWJsZXM8L2tleT4KICA8ZGljdD48a2V5PlBBVEg8L2tleT48c3RyaW5nPiRTQUZFX1BBVEg8L3N0cmluZz48L2RpY3Q+CiAgPGtleT5SdW5BdExvYWQ8L2tleT48dHJ1ZS8+CiAgPGtleT5LZWVwQWxpdmU8L2tleT48ZGljdD48a2V5PlN1Y2Nlc3NmdWxFeGl0PC9rZXk+PGZhbHNlLz48L2RpY3Q+CjwvZGljdD4KPC9wbGlzdD4KUExJU1RFT0YKbGF1bmNoY3RsIGJvb3RvdXQgImd1aS8kKGlkIC11KS9jb20uY2xhdWRlYnJpZGdlLndhdGNoZXIiIDI+L2Rldi9udWxsCmxhdW5jaGN0bCBib290c3RyYXAgImd1aS8kKGlkIC11KSIgIiRQTElTVCIgMj4vZGV2L251bGwgfHwgbGF1bmNoY3RsIGxvYWQgLXcgIiRQTElTVCIgMj4vZGV2L251bGwKIyBjbGF1ZGUg7Jyg66y0wrfroZzqt7jsnbgg7Jes67aA64qUIOyXrOq4sOyEnCDslYzrpqzsp4Ag7JWK64qU64ukIOKAlCDqsJDsi5zsnpDqsIAg6re4IOyDge2DnOulvCDtlIzrn6zqt7jsnbjsl5Ag7KCE64us7ZW0CiMg6rOE7KCVIO2ZlOuptOydtCAi7ISk7LmYIO2VhOyalCAvIOuhnOq3uOyduCDtlYTsmpQgLyDspIDruYQg7JmE66OMIuuhnCDrhbjstpztlZzri6Qo7YSw66+464SQ7J20IOyxhOuEkOydtCDslYTri5gpLgojIOyEpOy5mMK37KCQ6rKAIOuBnSDihpIg7LC97J2EIOyKpOyKpOuhnCDri6vripTri6QuCmZpbmlzaCAwClBLAQIeAxQAAAgAAAAAAACO4guNk4MCAJODAgAbAAAAAAAAAAAAAADtgQAAAADtgbTroZzrk5wt7Luk64Sl7YSwLmNvbW1hbmRQSwUGAAAAAAEAAQBJAAAAzIMCAAAA";
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
