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

// 하위 프레임 목록에서 사용자가 고른 프레임을 우리가 캔버스에서 선택한 경우, 그 메아리로
// 오는 selectionchange에 selection-text를 다시 보내면 안 된다 — 보내면 입력창이 덮이고
// 고른 그룹이 [전체]로 되돌아간다(고른 순간 UI가 이미 그 그룹으로 맞춰 놨다).
let selfPickedNodeId: string | null = null;

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

    // 목록에서 우리가 골라 선택한 프레임이면 여기서 끝낸다(위의 코멘트 갱신·목록 동기화는 그대로 하고).
    const echoOfSelfPick = !!selfPickedNodeId && !!selection && selection.length === 1
      && !!selection[0] && selection[0].id === selfPickedNodeId;
    selfPickedNodeId = null; // 한 번만 무시한다 — 이후 사용자의 진짜 선택은 정상 처리
    if (echoOfSelfPick) return;

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
          figma.ui.postMessage({ type: 'selection-text', text: (t && t.trim()) ? t : '', popup: 0, groups, role, rootId: (sel0 && sel0.id) || '' });
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
      if (t && t.trim()) figma.ui.postMessage({ type: 'selection-text', text: t, groups: groups0, role: role0, rootId: (s0 && s0.id) || '', onEnter: true });
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
type FrameGroup = { name: string; texts: string[]; own?: boolean; role?: string; id?: string };
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
  const out: Array<{ name: string; texts: string[]; own: boolean; role?: string; id: string; y: number; x: number }> = [];
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
        id: String(node.id || ''), // 목록에서 이 줄을 누르면 캔버스에서 이 프레임을 선택한다
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
  const groups = out.map((g) => ({ name: g.name, texts: g.texts, own: g.own, role: g.role, id: g.id }));
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
const BRIDGE_MIN_V = 42;
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

// 설치본을 플러그인이 들고 있는 새 코드로 갱신한다 (감시자 v8의 POST /update).
// 파일이 실제로 바뀌었을 때만 true — 이미 최신이거나, 저장소에서 도는 감시자이거나, 옛 감시자(404)면 false.
// 사용자가 아무것도 안 눌러도 되는 자동 업데이트의 핵심 (설치 파일만으로 세팅한 PC엔 다른 갱신 경로가 없다).
async function pushInstallerToWatcher(): Promise<boolean> {
  if (!INSTALLER_B64) return false; // 빌드가 설치 파일을 못 심은 경우
  try {
    const res = await postJsonWithTimeout(WATCHER_URL + '/update', { installer: INSTALLER_B64 }, 20000);
    const d = await res.json();
    if (d && d.ok && d.changed && d.changed.length) {
      console.log('[BRIDGE] 설치본 자동 갱신:', d.changed.join(', '), '→ 다리 v' + d.bridgeV, '(' + d.dir + ')');
      return true;
    }
    if (d && d.reason === 'repo') console.log('[BRIDGE] 감시자가 저장소에서 실행 중 — 갱신은 npm run build가 담당');
    return false;
  } catch (_e) {
    return false; // 감시자가 꺼져 있거나 옛 버전(/update 없음) — 기존 경로(껐다 켜기)로 진행
  }
}

// 다리를 새 코드로 재시작한다 — /shutdown → 감시자 /wake → /health 폴링. 재시작 후 health를 돌려준다.
// bridge-old(구버전 다리)일 때 사용자가 버튼을 누르지 않아도 자동 업그레이드하는 데 쓴다.
async function restartBridge(): Promise<ReturnType<typeof bridgeHealth> extends Promise<infer T> ? T : never> {
  // 켜 주는 쪽(설치본)이 옛 코드면 껐다 켜도 소용없다 → **새 코드를 먼저 밀어 넣는다.**
  // 플러그인은 빌드가 심어 준 설치 파일(INSTALLER_B64)을 통째로 갖고 있으므로, 감시자에게 그대로 넘기면
  // 감시자가 섹션을 풀어 자기 폴더의 다리·감시자·예시·가이드를 갈아끼운다(감시자 v8부터, 옛 감시자는 404 → 무시).
  // 저장소에서 도는 감시자는 스스로 거절한다(reason:'repo') — 소스가 빌드 산출물로 덮이면 안 되므로.
  const pushed = await pushInstallerToWatcher();
  if (pushed) await new Promise((r) => setTimeout(r, 3500)); // 파일 교체·감시자 자기 재기동 시간
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
  // 껐다 켰는데도 옛 버전이면 **켜 주는 쪽(감시자)이 옛 코드를 켜고 있다** (2026-08 실측: 설치본 파일은 v41인데
  // 아침부터 떠 있던 감시자가 v22 다리를 계속 켰다). 다리만 다시 켜는 것으로는 영원히 안 풀리고
  // 재시작마다 워밍업(구독 사용량)만 나가므로, 감시자부터 새로 띄운 뒤 한 번 더 켠다.
  // 감시자 /restart는 v7부터 있다 — 옛 감시자는 404라 이 단계가 조용히 지나가고 버튼 안내로 남는다.
  if (h.alive && h.problem === 'bridge-old') {
    try { await postJsonWithTimeout(WATCHER_URL + '/restart', {}, 3000); } catch (_e) { /* 옛 감시자엔 없는 경로 */ }
    await new Promise((r) => setTimeout(r, 3500)); // 새 감시자가 포트를 잡을 시간(감시자 쪽 listen 재시도와 짝)
    try { await postJsonWithTimeout(WATCHER_URL + '/wake', {}, 3000); } catch (_e) { /* 아래 폴링이 알려준다 */ }
    h = await bridgeHealth();
    for (let i = 0; i < 6 && (!h.alive || h.problem === 'bridge-old'); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      h = await bridgeHealth();
    }
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
// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.zip을 base64로 주입) =====
const INSTALLER_B64 = "UEsDBBQAAAgAAAAAAABpqJqIDQQAAA0EAAAKAAAA7ISk7LmYLmJhdEBlY2hvIG9mZgpyZW0gQ2xhdWRlIGNvbm5lY3RvciBzZXR1cCAtIHJ1bnMgc2NyaXB0c1xyZWdpc3Rlci1wcm90b2NvbC5qcyBpbiB0aGlzIGZvbGRlci4KcmVtIE5vIGhpZGRlbiBwYXlsb2FkLCBubyBkb3dubG9hZC4gS2VwdCBkZWxpYmVyYXRlbHkgc2ltcGxlIHRvIGF2b2lkIGFudGl2aXJ1cyBmYWxzZSBwb3NpdGl2ZXMuCnJlbSBOb3RlczogQVNDSUkgb25seSwgYW5kIG5vIHBhcmVudGhlc2l6ZWQgaWYtYmxvY2tzIChjbWQgbWlzLXBhcnNlcyB0aGVtIHdpdGggVVRGLTggdGV4dCkuCmNkIC9kICIlfmRwMCIKCndoZXJlIG5vZGUgPm51bCAyPiYxIHx8IGdvdG8gTk9OT0RFCgpub2RlIHNjcmlwdHNccmVnaXN0ZXItcHJvdG9jb2wuanMKaWYgZXJyb3JsZXZlbCAxIGdvdG8gRkFJTEVECgp3aGVyZSBjbGF1ZGUgPm51bCAyPiYxIHx8IGdvdG8gTk9DTEFVREUKCmVjaG8uCmVjaG8gICBTZXR1cCBkb25lLiBPcGVuIHRoZSBwbHVnaW4gaW4gRmlnbWEgYW5kIHByZXNzIFtSZWNvbW1lbmRdLgplY2hvLgpwYXVzZQpleGl0IC9iIDAKCjpOT05PREUKZWNoby4KZWNobyAgIE5vZGUuanMgaXMgcmVxdWlyZWQuIEluc3RhbGwgdGhlIExUUyBidWlsZCBmcm9tIGh0dHBzOi8vbm9kZWpzLm9yZwplY2hvICAgdGhlbiBydW4gdGhpcyBmaWxlIGFnYWluLgplY2hvLgpwYXVzZQpleGl0IC9iIDEKCjpOT0NMQVVERQplY2hvLgplY2hvICAgU2V0dXAgZG9uZSwgYnV0IENsYXVkZSBDb2RlIGlzIG5vdCBpbnN0YWxsZWQgb24gdGhpcyBQQy4KZWNobyAgIFJ1biB0aGVzZSB0d28gY29tbWFuZHMgaW4gYSB0ZXJtaW5hbCwgdGhlbiByZW9wZW4gdGhlIHBsdWdpbjoKZWNoby4KZWNobyAgICAgICBucG0gaW5zdGFsbCAtZyBAYW50aHJvcGljLWFpL2NsYXVkZS1jb2RlCmVjaG8gICAgICAgY2xhdWRlIGxvZ2luCmVjaG8uCnBhdXNlCmV4aXQgL2IgMAoKOkZBSUxFRAplY2hvLgplY2hvICAgU2V0dXAgZmFpbGVkLiBQbGVhc2Ugc2hhcmUgdGhlIG1lc3NhZ2UgYWJvdmUgd2l0aCB0aGUgZGV2ZWxvcGVyLgplY2hvLgpwYXVzZQpleGl0IC9iIDEKUEsDBBQAAAgAAAAAAACyfdK3pwMAAKcDAAAOAAAA7ISk7LmYLmNvbW1hbmQjIS9iaW4vYmFzaAojIO2BtOuhnOuTnCDsu6TrhKXthLAg7ISk7LmYIOKAlCDsnbQg7Y+0642U7J2YIHNjcmlwdHMvcmVnaXN0ZXItcHJvdG9jb2wuanMg66W8IOyLpO2Wie2VoCDrv5DsnoXri4jri6QuCmNkICIkKGRpcm5hbWUgIiQwIikiCmlmICEgY29tbWFuZCAtdiBub2RlID4vZGV2L251bGwgMj4mMTsgdGhlbgogIGVjaG8gIk5vZGUuanPqsIAg7ZWE7JqU7ZW07JqUIOKAlCBodHRwczovL25vZGVqcy5vcmcg7JeQ7IScIExUU+ulvCDshKTsuZjtlZwg65KkIOuLpOyLnCDsi6TtlontlbQg7KO87IS47JqULiIKICByZWFkIC1uIDEgLXMgLXIgLXAgIuyVhOustCDtgqTrgpgg64iE66W066m0IOuLq+2YgOyalC4iOyBleGl0IDEKZmkKbm9kZSBzY3JpcHRzL3JlZ2lzdGVyLXByb3RvY29sLmpzIHx8IHsgZWNobyAi7ISk7LmY7JeQIOyLpO2MqO2WiOyWtOyalC4g7JyEIOuplOyLnOyngOulvCDqsJzrsJzsnpDsl5Dqsowg7JWM66CkIOyjvOyEuOyalC4iOyByZWFkIC1uIDEgLXMgLXI7IGV4aXQgMTsgfQppZiAhIGNvbW1hbmQgLXYgY2xhdWRlID4vZGV2L251bGwgMj4mMTsgdGhlbgogIGVjaG8gIiI7IGVjaG8gIuyEpOygleydgCDrgZ3rgqzslrTsmpQuIOuLpOunjCDsnbQgTWFj7JeQIENsYXVkZSBDb2Rl6rCAIOyXhuyWtOyalC4g7YSw66+464SQ7JeQ7IScIOyVhOuemOulvCDsi6TtlontlbQg7KO87IS47JqUOiIKICBlY2hvICIgIG5wbSBpbnN0YWxsIC1nIEBhbnRocm9waWMtYWkvY2xhdWRlLWNvZGUiOyBlY2hvICIgIGNsYXVkZSBsb2dpbiIKZWxzZQogIGVjaG8gIiI7IGVjaG8gIuykgOu5hCDrgZ0hIO2UvOq3uOuniOyXkOyEnCDtlIzrn6zqt7jsnbjsnYQg7Je06rOgIFvstpTsspzrsJvquLBd66W8IOuIhOultOuptCDrj7zsmpQuIgpmaQpyZWFkIC1uIDEgLXMgLXIgLXAgIuyVhOustCDtgqTrgpgg64iE66W066m0IOuLq+2YgOyalC4iClBLAwQUAAAIAAAAAAAASoOKMGECAABhAgAAEwAAAOydveyWtOyjvOyEuOyalC50eHTtgbTroZzrk5wg7Luk64Sl7YSwIOyEpOy5mCDrsKnrspUNCg0KW+yciOuPhOyasF0gIOyEpOy5mC5iYXQg7J2EIOuNlOu4lO2BtOumre2VmOyEuOyalC4NClvrp6VdICAgICAg7ISk7LmYLmNvbW1hbmQg66W8IOyasO2BtOumrSDihpIgW+yXtOq4sF0g7ZWY7IS47JqULiAo642U67iU7YG066at7J2AIEdhdGVrZWVwZXLqsIAg66eJ7Iq164uI64ukKQ0KDQotIE5vZGUuanPsmYAgQ2xhdWRlIENvZGXqsIAg7ZWE7JqU7ZWp64uI64ukLiDsl4bsnLzrqbQg7ISk7LmYIOykkeyXkCDslYjrgrTqsIAg64KY7Ji164uI64ukLg0KLSDsnbQg7Y+0642U66W8IOyngOyasOqxsOuCmCDsmK7quLDrqbQg7Jew6rKw7J20IOuBiuq5geuLiOuLpC4g7Jiu6rK87Jy866m0IOyEpOy5mCDtjIzsnbzsnYQg64uk7IucIOyLpO2Wie2VtCDso7zshLjsmpQuDQotIOy2lOyynMK367KI7Jet7J2AIOydtCBQQ+yXkCDroZzqt7jsnbjrkJwg67O47J24IO2BtOuhnOuTnCDqtazrj4Ug7IKs7Jqp65+J7J2EIOyUgeuLiOuLpC4NCg0K7JWI7JeQIOuToCDtjIzsnbzsnYAg66qo65GQIO2PieuylO2VnCDsiqTtgazrpr3tirjsnoXri4jri6Qo7Iio6ri0IOy9lOuTnMK364uk7Jq066Gc65OcIOyXhuydjCkuDQpQSwMEFAAACAAAAAAAAIAbJRc3SAEAN0gBABgAAABzY3JpcHRzL2NsYXVkZS1icmlkZ2UuanMvLyDtgbTroZzrk5wg64uk66asKENsYXVkZSBCcmlkZ2UpIOKAlCDtlLzqt7jrp4gg7ZSM65+s6re47J246rO8IENsYXVkZSBDb2Rl66W8IOyeh+uKlCDroZzsu6wg7Ius67aA66aE6r68DQovLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCi8vIOyCrOyaqeuylTog7Y+J7IOB7Iuc7JeUIOqwkOyLnOyekOqwgCDsnpDrj5nsnLzroZwg7Lyg64ukICjsiJjrj5kg7Iuc7J6R7J2AIG5wbSBydW4gYnJpZGdlKQ0KLy8g7Lyc65GQ66m0IO2UjOufrOq3uOyduOydmCBb7LaU7LKc67Cb6riwXeqwgCBHZW1pbmkg7YKkIOyXhuydtOuPhCDtgbTroZzrk5zroZwgQUkg7LaU7LKc7J2EIOuwm+uKlOuLpC4NCi8vDQovLyDsho3rj4Qg7ISk6rOEOiDtgbTroZzrk5zrpbwg7JqU7LKt66eI64ukIOyDiOuhnCDsi5zrj5ntlZjrqbQgMzB+NDDstIjqsIAg6re464OlIOuCoOyVhOqwhOuLpC4NCi8vIOKGkiDri6Trpqzrpbwg7LykIOuVjCDtgbTroZzrk5wg7IS47IWY7J2EIO2VmOuCmCDsl7TslrQg7IOB7IucIOuMgOq4sOyLnO2CpOqzoChzdHJlYW0tanNvbiDrjIDtmZQg66qo65OcKSwNCi8vICAg6rCA7J2065OcK+yYiOyLnCgxMTHqsbQp64qUIOyyqyDrqZTsi5zsp4DroZwg7ZWcIOuyiOunjCDsnb3tnozri6QuIOydtO2bhCDsmpTssq3snYAg66y46rWs66eMIOuztOuCtOuvgOuhnCDruaDrpbTri6QuDQovLyDshLjshZjsnYAgMzDrsogg7JOw66m0IOyerOyLnOyeke2VtCDrjIDtmZTqsIAg66y07ZWc7Z6IIOq4uOyWtOyngOuKlCDqsoPsnYQg66eJ64qU64ukLg0KLy8NCi8vIOyghOygnDog7J20IFBD7JeQIENsYXVkZSBDb2Rl6rCAIOyEpOy5mMK366Gc6re47J2464+8IOyeiOydhCDqsoMgKGNsYXVkZSAtLXZlcnNpb24g7Jy866GcIO2ZleyduCkNCi8vIOyjvOydmDog7IKs7Jqp65+J7J2AIOqwgeyekCDtgbTroZzrk5wg6rWs64+FIO2VnOuPhOyXkOyEnCDssKjqsJDrkJzri6QuDQoNCmNvbnN0IGh0dHAgPSByZXF1aXJlKCdodHRwJyk7DQpjb25zdCBmcyA9IHJlcXVpcmUoJ2ZzJyk7DQpjb25zdCBvcyA9IHJlcXVpcmUoJ29zJyk7DQpjb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpOw0KY29uc3QgeyBzcGF3biwgc3Bhd25TeW5jIH0gPSByZXF1aXJlKCdjaGlsZF9wcm9jZXNzJyk7DQoNCi8vIO2BtOuhnOuTnOulvCDruYgg7Y+0642U7JeQ7IScIOyLpO2WiSDigJQg7KCA7J6l7IaM7JeQ7IScIOyLpO2Wie2VmOuptCDtlITroZzsoJ3tirgg66el6529KENMQVVERS5tZCDrk7Ep7J2EDQovLyDrp6Qg7YS0IOyniuyWtOyguOyEnCA0Ney0iC/thLTquYzsp4Ag64qQ66Ck7KeE64ukICjruYgg7Y+0642UICsg67aA6rCA6riw64qlIOywqOuLqOydtOuptCB+M+y0iC/thLQpLg0KY29uc3QgRU1QVFlfQ1dEID0gcGF0aC5qb2luKG9zLnRtcGRpcigpLCAnY2xhdWRlLWJyaWRnZS1jd2QnKTsNCnRyeSB7IGZzLm1rZGlyU3luYyhFTVBUWV9DV0QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pOyB9IGNhdGNoIChfZSkgeyAvKiDrrLTsi5wgKi8gfQ0KY29uc3QgQ0xBVURFX0VOViA9IE9iamVjdC5hc3NpZ24oe30sIHByb2Nlc3MuZW52LCB7DQogIE1BWF9USElOS0lOR19UT0tFTlM6ICcwJywgICAgICAgICAgICAgICAgICAgIC8vIOyDneqwgSDrqqjrk5wg64GUICjsp6fsnYAg66y46rWs7JeUIOu2iO2VhOyalCkNCiAgQ0xBVURFX0NPREVfRElTQUJMRV9OT05FU1NFTlRJQUxfVFJBRkZJQzogJzEnLCAvLyDthLQg7JqU7JW9IOuTsSDrtoDqsIAg7Zi47LacIOuBlA0KICBESVNBQkxFX1RFTEVNRVRSWTogJzEnLA0KfSk7DQoNCi8vIOyIqOq5gCDsi6Ttloko6rCQ7Iuc7J6QIOyKpO2PsOydgCBzdGRpbyBpZ25vcmUp7JeQ7ISc64+EIOusuOygnOulvCDstpTsoIHtlaAg7IiYIOyeiOqyjCDsvZjshpQg66Gc6re466W8IO2MjOydvOyXkOuPhCDrgqjquLTri6QuDQovLyDsnITsuZg6IOyehOyLnCDtj7TrjZTsnZggY2xhdWRlLWJyaWRnZS5sb2cgKOyciOuPhOyasCAlVEVNUCUsIOunpSAkVE1QRElSKS4gMk1CIOuEmOycvOuptCAub2xk66GcIO2VnCDshLjrjIDrp4wg67O06rSALg0KY29uc3QgTE9HX0ZJTEUgPSBwYXRoLmpvaW4ob3MudG1wZGlyKCksICdjbGF1ZGUtYnJpZGdlLmxvZycpOw0KY29uc3QgX29yaWdMb2cgPSBjb25zb2xlLmxvZy5iaW5kKGNvbnNvbGUpOw0KY29uc29sZS5sb2cgPSBmdW5jdGlvbiAoKSB7DQogIGNvbnN0IGFyZ3MgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMpOw0KICBfb3JpZ0xvZy5hcHBseShudWxsLCBhcmdzKTsNCiAgdHJ5IHsNCiAgICB0cnkgew0KICAgICAgaWYgKGZzLmV4aXN0c1N5bmMoTE9HX0ZJTEUpICYmIGZzLnN0YXRTeW5jKExPR19GSUxFKS5zaXplID4gMiAqIDEwMjQgKiAxMDI0KSBmcy5yZW5hbWVTeW5jKExPR19GSUxFLCBMT0dfRklMRSArICcub2xkJyk7DQogICAgfSBjYXRjaCAoX2UpIHsgLyog7ZqM7KCEIOyLpO2MqOuKlCDrrLTsi5wgKi8gfQ0KICAgIGNvbnN0IGxpbmUgPSAnWycgKyBuZXcgRGF0ZSgpLnRvTG9jYWxlU3RyaW5nKCdrby1LUicpICsgJ10gJyArDQogICAgICBhcmdzLm1hcCgoYSkgPT4gKHR5cGVvZiBhID09PSAnc3RyaW5nJyA/IGEgOiBKU09OLnN0cmluZ2lmeShhKSkpLmpvaW4oJyAnKSArICdcbic7DQogICAgZnMuYXBwZW5kRmlsZVN5bmMoTE9HX0ZJTEUsIGxpbmUpOw0KICB9IGNhdGNoIChfZSkgeyAvKiDtjIzsnbwg66Gc6re4IOyLpO2MqO2VtOuPhCDri6TrpqzripQg6rOE7IaNICovIH0NCn07DQoNCmNvbnN0IFBPUlQgPSBOdW1iZXIocHJvY2Vzcy5lbnYuQlJJREdFX1BPUlQpIHx8IDExODg4OyAvLyBCUklER0VfUE9SVOuKlCDthYzsiqTtirjsmqkgKO2PieyGjOyXlCAxMTg4OCDqs6DsoJUpDQovLyDri6Trpqwg7L2U65OcIOuyhOyghCDigJQgL2hlYWx0aOuhnCDrhbjstpztlZzri6QuIOy9lOuTnOulvCBwdWxswrfrs7XsgqztlbTrj4QgKirsnbTrr7gg65agIOyeiOuKlCDri6TrpqzripQg7JibIOy9lOuTnCDqt7jrjIDroZwqKuudvA0KLy8g6ruQ64ukIOy8nOq4sCDsoITsl5Qg7IOIIOuPmeyekeydtCDslYgg64KY7Jio64ukKO2EsOuvuOuEkOydtCDrnKjripQg65OxKS4g7ZSM65+s6re47J247J20IOydtCDqsJLsnLzroZwg6rWs67KE7KCE7J2EIOqwkOyngO2VtCDsnqzsi5zsnpHsi5ztgqjri6QuDQovLyDrj5nsnpHsnbQg67CU64CM64qUIOyImOygleydhCDtlZjrqbQg7J20IOyIq+yekOulvCDsmKzrpqzqs6AgY29kZS50c+ydmCBCUklER0VfTUlOX1brj4Qg6rCZ7J20IOyYrOumsOuLpC4NCmNvbnN0IEJSSURHRV9WID0gNDI7DQovLyDquLDrs7gg66qo6424LiDsmpTssq0o7ZSM65+s6re47J24KeydtCBtb2RlbOydhCDsp4DsoJXtlZjrqbQg6re4IOyalOyyreunjCDqt7gg66qo642466GcIOyymOumrO2VnOuLpC4NCi8vIGhhaWt1Peu5oOumhC/qsIDrsrzsm4AsIHNvbm5ldD3spJHqsIQsIG9wdXM96riw67O4KOy1nOqzoO2SiOyniCwg7KGw6riIIOuKkOumvCkNCmNvbnN0IENMQVVERV9NT0RFTCA9IHByb2Nlc3MuZW52LkJSSURHRV9NT0RFTCB8fCAnb3B1cyc7DQpjb25zdCBBTExPV0VEX01PREVMUyA9IFsnaGFpa3UnLCAnc29ubmV0JywgJ29wdXMnXTsNCmNvbnN0IFRVUk5fVElNRU9VVF9NUyA9IDkwMDAwOyAgIC8vIOyalOyyrSAx6rG0IOygnO2VnOyLnOqwhA0KY29uc3QgTUFYX1RVUk5TID0gMzA7ICAgICAgICAgICAgLy8g7J2066eM7YG8IOyTsOuptCDshLjshZgg7J6s7Iuc7J6RICjrjIDtmZQg64iE7KCBIOuwqeyngCkNCg0KLy8g4pSA4pSAIOyYiOyLnCDsgqzsoIQg66Gc65OcIChyZWNvbW1lbmQtZXhhbXBsZXMubWQg4oCUIGJ1aWxkLWdsb3NzYXJ5Lmpz7JmAIOqwmeydgCDtjIzshJwpIOKUgOKUgA0KZnVuY3Rpb24gbG9hZEV4YW1wbGVzKCkgew0KICB0cnkgew0KICAgIGNvbnN0IG1kID0gZnMucmVhZEZpbGVTeW5jKHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdyZWNvbW1lbmQtZXhhbXBsZXMubWQnKSwgJ3V0ZjgnKTsNCiAgICBjb25zdCBzZWNJZHggPSBtZC5zZWFyY2goL14jIyDstpTsspwg7JiI7IucXHMqJC9tKTsNCiAgICBpZiAoc2VjSWR4ID09PSAtMSkgcmV0dXJuIFtdOw0KICAgIGNvbnN0IGV4YW1wbGVzID0gW107DQogICAgbGV0IGN1ciA9IG51bGw7DQogICAgZm9yIChjb25zdCByYXcgb2YgbWQuc2xpY2Uoc2VjSWR4KS5zcGxpdCgnXG4nKSkgew0KICAgICAgY29uc3QgbGluZSA9IHJhdy5yZXBsYWNlKC9ccyskLywgJycpOw0KICAgICAgY29uc3QgaCA9IGxpbmUubWF0Y2goL14jIyNccysoLis/KVxzKiQvKTsNCiAgICAgIGlmIChoKSB7IGN1ciA9IHsgaW5wdXQ6IGhbMV0sIHN1Z2dlc3Rpb25zOiBbXSB9OyBleGFtcGxlcy5wdXNoKGN1cik7IGNvbnRpbnVlOyB9DQogICAgICBjb25zdCBiID0gbGluZS5tYXRjaCgvXlxzKi1ccysoLis/KVxzKiQvKTsNCiAgICAgIGlmIChiICYmIGN1cikgY3VyLnN1Z2dlc3Rpb25zLnB1c2goYlsxXS5zcGxpdCgnIC8gJykuam9pbignICcpKTsNCiAgICB9DQogICAgcmV0dXJuIGV4YW1wbGVzLmZpbHRlcigoZSkgPT4gZS5zdWdnZXN0aW9ucy5sZW5ndGggPiAwKTsNCiAgfSBjYXRjaCAoZSkgew0KICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDsmIjsi5wg7IKs7KCEIOuhnOuTnCDsi6TtjKggKOyXhuydtCDsp4TtlokpOicsIGUubWVzc2FnZSk7DQogICAgcmV0dXJuIFtdOw0KICB9DQp9DQoNCi8vIOKUgOKUgCDsp4Dsi5zrrLggKOyEnOuyhCByZWNvbW1lbmTsmYAg6rCZ7J2AIOq3nOy5mSDigJQg67CU6r6466m0IOq3uOyqveuPhCDtlajqu5gpIOKUgOKUgA0KLy8g7Jqp7Ja07KeRKGdsb3NzYXJ5Lm1kKeydgCDsnbzrtoDrn6wg7ZSE66Gs7ZSE7Yq47JeQIOyViCDrhKPripTri6QoMjAyNi0wNyDsi6TsuKEpOiDrhKPsnLzrqbQg7YG066Gc65Oc6rCAIOyaqeyWtCDqtZDsoJXsnYQNCi8vIOyjvCDsnoTrrLTroZwg7Jik7ZW07ZW0IDPqsJwg7KCc7JWI7J20IOyghOu2gCAi7ZGc6riwIOqzoOy5qCArIOyWtOyInCDrs4Dqsr0i7J20IOuQnOuLpC4g7Jet7ZWgIOu2hOumrCDigJQNCi8vIO2BtOuhnOuTnCA9IOusuOyepSDri6Trk6zquLAo7LC97J2YKSwg7Jqp7Ja0IO2GteydvMK366ee7Lak67KVID0gY29kZS50cyByZWZpbmVBaVN1Z2dlc3Rpb25zIO2bhOyymOumrCjquLDqs4TsoIEpLg0KY29uc3QgU1RZTEVfUlVMRVMgPSBbDQogICcxLiDtlbTsmpTssrQ6IOuqqOuToCDrrLjqtazripQg7ZW07JqU7LK066GcLiAo67O064OF64uI64uk4oaS67O064K07JqUKScsDQogICcyLiDriqXrj5nsoIEg66eQ7ZWY6riwOiDrkJDslrTsmpTihpLtlojslrTsmpQsIH7sl4gg67m86riwKOuwlOuAjOyXiOyWtOyalOKGkuuwlOq/qOyWtOyalCkuIOuLqCwg7KKF66OMwrfrp4zro4zCt+yXsOyytMK37ZW07KeAwrfquLDroZ3Ct+uFueydjCDrk7Eg7Iuc7Iqk7YWc7J20IOyjvOyytOyduCDqsrDqs7zripQg7IiY64+Z7ZiVIOycoOyngCjsl7DssrTrj7zsmpQsIOuFueydjOuPvOyalCkuJywNCiAgJzMuIOq4jeygleyggSDrp5DtlZjquLA6ICJ+7ZWgIOyImCDsl4bslrTsmpQiIOuMgOyLoCAifu2VmOuptCDtlaAg7IiYIOyeiOyWtOyalCIg6rWs7KGwIOyasOyEoC4g64uoLCDsoJXssYXsg4Eg67aI6rCAwrfsnbzrtoAg6riw64qlIOygnO2VnMK365CY64+M66a0IOyImCDsl4bripQg6rKw6rO8wrfsoJXrs7Qg67O07Zi4IOyViOyLrOydgCDrtoDsoJXtmJXsnLzroZwg66qF7ZmV7Z6ILicsDQogICc0LiDsupDso7zslrztlZwg6rK97Ja0OiB+7ZWY7Iuc6rKg7Ja07JqUP+KGkn7tlaDquYzsmpQ/LCDqs4Tsi5zri6TihpLsnojri6QsIOyXrOytiOuLpOKGku2ZleyduO2VmOuLpCwg6ruY4oaS7JeQ6rKMLiB+7IucIOu5vOq4sOqwgCDslrTsg4ntlZjrqbQg7YyM7JWF7ZWY66Ck64qUIOygleuztOulvCDso7zslrTroZwg66y47J6l7J2EIOuLpOyLnCDsk7Tri6QuJywNCiAgJzUuIOuqheyCrCvrqoXsgqwg6riI7KeAOiDtlZzsnpDslrTrpbwg7ZKA7Ja0IOuPmeyCrOuhnCjsnbTsnpAg7ZmY67aI7J2EIOuwm+yVmOyWtOyalOKGkuydtOyekOulvCDrj4zroKTrsJvslZjslrTsmpQpLCDstZzshoztlZwge+uqheyCrH3qsIAge+uqheyCrH3tlbTshJwg7ZiV7YOc66GcKOyelOyVoSDrtoDsobHsnLzroZzihpLsnpTslaHsnbQg67aA7KGx7ZW07IScKS4nLA0KICAnNi4g7ZGc6riwOiDrkJjslrTsmpTihpLrj7zsmpQuJywNCiAgJzcuIOykhCDqtazsobA6IOybkOuzuOydtCDtlZwg7KSE7J2066m0IOy2lOyynOuPhCDrsJjrk5zsi5wg7ZWcIOykhOuhnC4g7J6E7J2Y66GcIOykhOydhCDripjrpqzsp4Ag7JWK64qU64ukLiDri6gsIOyXrOufrCDrrLjsnqXsnYQg7ZWY64KY7J2YIOq4jeygle2YlSDrrLjsnqXsnLzroZwg7ZWp7LOQIOuNlCDqsITqsrDtlbTsp4Tri6TrqbQg7KSEIOyImOulvCDspITsnbTripQg6rKD7J2AIO2ZmOyYgS4nLA0KICAnOC4g7Yyd7JeFKOuLpOydtOyWvOuhnOq3uCkg67KE7Yq8OiDqsrDqs7wg7Ya167O064qUIFvtmZXsnbhdLCDsmIgv7JWE64uI7JikIO2MkOuLqOydgCBb7JWE64uI7JikXS9b64SkXSwg64+Z7J6RIOycoOuPhOuKlCBb7Leo7IaMXS9be+uPmeyekX1dLiAi7Leo7IaMIuuKlCDrj5nsnpEg67KE7Yq86rO8IOynneydvCDrlYzrp4wg7JOw6rOgICLri6vquLDCt+uPmeyekSLsspjrn7wg7KedIOyViCDrp57ripQg7KGw7ZWpwrfri6jrj4UgIuy3qOyGjCLripQg6riI7KeALicsDQogICc5LiDsnbTrpoTCt+yghO2ZlOuyiO2YuMK366eI7Iqk7YK57J2AIOq3uOuMgOuhnCDrs7TsobQuIOyCrOuejOydhCDrtoDrpbwg65WQIOuLmOydhCDrtpnsl6zrj4Qg7KKL64ukLicsDQogICcxMC4g7KCc7ZKIIOyaqeyWtCDsnKDsp4A6IOyeheugpeyXkCDsk7Dsnbgg6riw64ql7ISxIOuqheyCrCjrs4Dqsr0sIOyngOyglSwg65Ox66GdLCDtlbTsoJwg65OxKeuKlCDtmZTrqbTsnZgg6riw64ql66qFwrfrsoTtirzrqoXsnbwg6rCA64ql7ISx7J20IOuGkuycvOuvgOuhnCDsiazsmrQg66eQ66GcIOuwlOq+uOyngCDslYrripTri6QuIOyLnOyKpO2FnCDrj5nsnpHqs7wg64uk66W4IOuPmeyCrOulvCDsg4jroZwg66eM65Ok7KeAIOyViuuKlOuLpC4nLA0KXS5qb2luKCdcbicpOw0KDQpjb25zdCBFWEFNUExFUyA9IGxvYWRFeGFtcGxlcygpOw0KDQovLyDilIDilIAg7Iqk7YOA7J28IOqwgOydtOuTnCDsoITrrLgg66Gc65OcICh1eC13cml0aW5nLm1kIOKAlCDsmIjsmbgg6rec7LmZIOyEuOu2gCDsi5zrgpjrpqzsmKTquYzsp4Ag7ZSE66Gs7ZSE7Yq47JeQIO2PrO2VqCkg4pSA4pSADQovLyBTVFlMRV9SVUxFUyAxMOykhCDsmpTslb3rp4zsnLzroZzripQg7JiI7Jm4IDF+MyjsiJjrj5ntmJXCt+qyveyWtMK367aA7KCV7ZiVIO2XiOyaqSDsvIDsnbTsiqQp7J2YIOuJmOyVmeyKpOqwgCDsnKDsi6TrkJzri6QuDQovLyDtjIzsnbzsnbQg7JeG7Jy866m0KOyEpOy5mOuzuCDqtazrsoTsoIQg65OxKSDruYgg66y47J6Q7Je0IOKAlCDsmpTslb3rp4zsnLzroZwg64+Z7J6RKGZhaWwtc29mdCkuDQpmdW5jdGlvbiBsb2FkR3VpZGUoKSB7DQogIHRyeSB7DQogICAgY29uc3QgbWQgPSBmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ3V4LXdyaXRpbmcubWQnKSwgJ3V0ZjgnKS50cmltKCk7DQogICAgcmV0dXJuIG1kLmxlbmd0aCA+IDEwMCA/IG1kIDogJyc7DQogIH0gY2F0Y2ggKGUpIHsNCiAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g7Iqk7YOA7J28IOqwgOydtOuTnCDroZzrk5wg7Iuk7YyoICjsmpTslb3rp4zsnLzroZwg7KeE7ZaJKTonLCBlLm1lc3NhZ2UpOw0KICAgIHJldHVybiAnJzsNCiAgfQ0KfQ0KY29uc3QgR1VJREUgPSBsb2FkR3VpZGUoKTsNCg0KZnVuY3Rpb24gaW5zdHJ1Y3Rpb25NZXNzYWdlKCkgew0KICBjb25zdCBmZXdTaG90ID0gRVhBTVBMRVMubWFwKChleCkgPT4gJ0lucHV0OiAnICsgSlNPTi5zdHJpbmdpZnkoZXguaW5wdXQpICsgJ1xuT3V0cHV0OiAnICsgSlNPTi5zdHJpbmdpZnkoZXguc3VnZ2VzdGlvbnMpKS5qb2luKCdcbicpOw0KICByZXR1cm4gKA0KICAgICfsp4DquIjrtoDthLAg64SI64qUIOyXkOyKpOybkChTLTEsIOuztOyViO2ajOyCrCnsnZgg7ZWc6rWt7Ja0IFVYIFdyaXRpbmcg7KCE66y46rCA66GcIOydvO2VnOuLpC4gJyArDQogICAgJ+uCtOqwgCBVSSDrrLjqtazrpbwg7ZWY64KY7JSpIOuztOuCtOuptCwg7JWE656YIOyKpO2DgOydvCDqt5zsuZnsl5Ag66ee6rKMIOuLpOuTrOydgCDrjIDslYggM+qwnOulvCDsoJzslYjtlZjrnbwuXG4nICsNCiAgICAn7JqU7LKt65Ok7J2AIOyEnOuhnCDrrLTqtIDtlZwg67OE6rCcIOusuOq1rOuLpCDigJQg7J207KCEIOusuOq1rOulvCDssLjsobDtlZjsp4Ag66eI6528LlxuJyArDQogICAgJ+ybkOuemCDsnZjrr7jsmYAg66qo65OgIOygleuztCjsnbTrpoTCt+yIq+yekMK37KGw6rG0wrfrjIDsg4Ep66W8IOycoOyngO2VmOqzoCwg6rCBIOygnOyViOydgCDsm5Drs7jqs7zrj4Qg7ISc66Gc7JmA64+EIOuLrOudvOyVvCDtlZzri6QuICcgKw0KICAgICfsobDqsbQg7ZGc7ZiEKOydtOyDgcK37J207ZWYwrfsnbTrgrTCt+y0iOqzvMK366+466eMwrfrtoDthLDCt+q5jOyngCDrk7Ep7J2AIOygleyxhSDsoJXrs7Tri6Qg4oCUIOu5vOqxsOuCmCDri6Trpbgg7KGw6rG07Jy866GcIOuwlOq+uOyngCDrp4jrnbwoIjXtmowg7J207IOBIuydhCAiNe2ajCLroZwg7KSE7J2066m0IOyYpOuLtSkuICcgKw0KICAgICfsm5DrrLjsl5Ag7JeG64qUIOq1rOyytCDsoJXrs7Qo7KCE7ZmU67KI7Zi4wrdVUkzCt+q4iOyVocK37Iuc6rCEIOuTsSnsmYAg7ZW06rKwIOuwqeuylcK37KCI7LCoKOyerOyEpOyglcK366y47J2Y7LKYwrfsnqzsi5zrj4Qg65OxKeulvCDsp4DslrTrgrQg67aZ7J2064qUIOqyg+ydgCDsoIjrjIAg6riI7KeAIOKAlCDslYTripQg6rCS7J20652864+ELCDqt7jrn7Trk6/tlbTrj4Qg7JOw7KeAIOuniOudvC5cbicgKw0KICAgICcz6rCcIOygnOyViOydgCDshJzroZwg7KCR6re87J20IOuLrOudvOyVvCDtlZzri6Qg4oCUIO2VmOuCmOuKlCDsm5DrrLgg6rWs7KGw66W8IOycoOyngO2VnCDstZzshowg64uk65Os6riwLCDtlZjrgpjripQg66y47J6lIOq1rOyhsOulvCDsnqzqtazshLHtlZwg64yA7JWILCAnICsNCiAgICAn6re466as6rOgIOyggeyWtOuPhCDtlZjrgpjripQg6rO86rCQ7ZWcIOyerOq1rOyEsTog7KSR67O1IO2RnO2YhOydhCDrjZzslrTrgrTqs6AsIOygleuztCDsiJzshJzrpbwg7IKs7Jqp7J6Q6rCAIOyVjOyVhOyVvCDtlaAg6rKD67aA7YSw66GcIOyerOyhsOynge2VoCDqsoMuICcgKw0KICAgICfsm5DrrLjsnbQg7ZW06rKwIOuwqeuyleydhCDri7Tqs6Ag7J6I7J2EIOuVjOunjCAi7Ja065a76rKMIO2VmOuptCDri6Tsi5wg65Cc64ukIuulvCDslZ7shLjsmrDripQg6riN7KCV7ZiVIOyerOq1rOyEseydhCDtlZjrnbwg4oCUIOybkOusuOyXkCDtlbTqsrDssYXsnbQg7JeG7Jy866m0IOunjOuTpOyWtCDrtpnsnbTsp4Ag66eI6528LiAnICsNCiAgICAn7ZGc6riwwrfsmqnslrTrp4wg6rOg7LmY6rOgIOyWtOyInOydhCDrsJTqvrwg7KCV64+E7J2YIOygnOyViOydhCAz6rCcIOuKmOyWtOuGk+yngCDrp4jrnbwg4oCUIOq3uOqxtCDsgqzsmqnsnpDsl5Dqsowg7LaU7LKc7J20IOyVhOuLiOudvCDqtZDsoJXsnLzroZwg67O07J2464ukLiAnICsNCiAgICAn7JWE656YIOyYiOyLnOuTpOydgCDtlZwg7KSE7Kec66asIOy1nOyGjCDqtZDsoJXsnbQg66eO7KeA66eMIOq3uOqxtCDthqQo7ZW07JqU7LK0wrfqsr3slrQp7J2YIOq1kOuzuOydtOyngCDshozqt7nshLHsnZgg6rWQ67O47J20IOyVhOuLiOuLpCDigJQg7Jes65+sIOusuOyepeynnOumrCDsnoXroKXsnYAg66mU7Iuc7KeAIOuLqOychOuhnCDri6Tsi5wg7ISk6rOE7ZWY6528LlxuJyArDQogICAgJ+uLteydgCDrsJjrk5zsi5wgSlNPTiDrsLDsl7Trp4wg7Lac66Cl7ZWc64ukLiDrp4jtgazri6TsmrTCt+yEpOuqhcK37L2U65Oc7Y6c7IqkIOq4iOyngDpcbicgKw0KICAgICdbeyJ0ZXh0IjogIuygnOyViCDrrLjqtawgKOykhOuwlOq/iOydgCBcXG4pIiwgInJlYXNvbiI6ICLrrLTsl4fsnYQg7JmcIOuwlOq/qOuKlOyngCDtlZzqta3slrQg7ZWcIOusuOyepSJ9LCAuLi5dXG5cbicgKw0KICAgICdb7Iqk7YOA7J28IOq3nOy5mV1cbicgKyBTVFlMRV9SVUxFUyArICdcblxuJyArDQogICAgKEdVSURFID8gJ1vsiqTtg4Dsnbwg6rCA7J2065OcIOyghOusuCAodXgtd3JpdGluZy5tZCkg4oCUIOychCDqt5zsuZnsnZgg6re86rGw7JmAIOyYiOyZuCDsi5zrgpjrpqzsmKQuIO2Kue2eiCDsmIjsmbgg6rec7LmZKOyImOuPme2YlcK36rK97Ja0wrfrtoDsoJXtmJXsnYQg7Jyg7KeA7ZW07JW8IO2VmOuKlCDsg4Htmakp7J2EIOq3uOuMgOuhnCDrlLDrpbTqs6AsIOyalOyVveqzvCDsoITrrLjsnbQg64uk66W066m0IOyghOusuOydhCDrlLDrpbjri6RdXG4nICsgR1VJREUgKyAnXG5cbicgOiAnJykgKw0KICAgIChmZXdTaG90ID8gJ1vsmrDrpqwg66qp7IaM66asIOyYiOyLnCDigJQg7J20IO2GpOydhCDrlLDrpbwg6rKDXVxuJyArIGZld1Nob3QgKyAnXG5cbicgOiAnJykgKw0KICAgICfspIDruYTrkJDsnLzrqbQgIk9LIuudvOqzoOunjCDri7XtlZjrnbwuJw0KICApOw0KfQ0KDQovLyDilIDilIAg7IOB7IucIOuMgOq4sCDtgbTroZzrk5wg7IS47IWYIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KbGV0IHByb2MgPSBudWxsOyAgICAgICAgICAvLyDtgbTroZzrk5wg7ZSE66Gc7IS47IqkDQpsZXQgbGluZUJ1ZiA9ICcnOyAgICAgICAgIC8vIHN0ZG91dCDspIQg67KE7Y28DQpsZXQgd2FpdGVyID0gbnVsbDsgICAgICAgIC8vIO2YhOyerCDthLTsnZggeyByZXNvbHZlLCByZWplY3QsIHRpbWVyIH0NCmxldCBxdWV1ZSA9IFByb21pc2UucmVzb2x2ZSgpOyAvLyDsmpTssq0g7KeB66Cs7ZmUICjrj5nsi5wg7JqU7LKt7J2AIOyInOyEnOuMgOuhnCkNCmxldCB0dXJucyA9IDA7DQpsZXQgd2FybWVkVXAgPSBmYWxzZTsNCmxldCBjdXJyZW50TW9kZWwgPSBDTEFVREVfTU9ERUw7IC8vIOyngOq4iCDshLjshZjsnbQg66y86rOgIOyeiOuKlCDrqqjrjbggKOyalOyyreydtCDri6Trpbgg66qo64247J2EIOyngOygle2VmOuptCDshLjshZgg7J6s7Iuc7J6RKQ0KLy8g7Iuc7J6RIOyLnCBDbGF1ZGUgQ29kZShjbGF1ZGUgQ0xJKeqwgCDsk7gg7IiYIOyeiOuKlOyngCDsoJDqsoAg4oCUIOyXhuycvOuptCAvaGVhbHRo66GcIOyVjOugpCDtlIzrn6zqt7jsnbjsnbQg7JWI64K07ZWc64ukLg0KLy8gbnVsbD3tmZXsnbgg7KSRLCAnb2snPeyCrOyaqSDqsIDriqUsICdjbGF1ZGUtbWlzc2luZyc9Y2xhdWRlIOuqheuguSDsl4bsnYwsDQovLyAnY2xhdWRlLWxvZ291dCc9Y2xhdWRl64qUIOyeiOyngOunjCDroZzqt7jsnbgg7IS47IWYIOunjOujjCAo7YS0IOyLpO2MqCDsi5wg6rCQ7KeALCDshLHqs7Ug7YS07J20IOyYpOuptCDsnpDrj5kg7ZW07KCcKQ0KLy8gJ2NsYXVkZS1saW1pdCc966Gc6re47J247J2AIOuQkOyngOunjCDsgqzsmqkg7ZWc64+EIOy0iOqzvCAo7KGw7LmY6rCAIOyerOuhnOq3uOyduOydtCDslYTri4jrnbwg7ZWc64+EIOyduOyDgcK36rOE7KCVIOyghO2ZmCkNCmxldCBjbGF1ZGVTdGF0dXMgPSBudWxsOw0KLy8g66Gc6re47J24IOunjOujjCDqsJDsp4Ag4oCUIENMSeqwgCDrgrTripQg7JiB7Ja0IOyduOymnSDsmKTrpZjrpbwg7IKs656M7J20IOyVjOyVhOuTpOydhCDslYjrgrTroZwg67CU6r6864ukLg0KLy8gKGNsYXVkZSAtLXZlcnNpb27snYAg66Gc6re47J24IOyXhuydtOuPhCDshLHqs7XtlbTshJwg7Iuc64+ZIOygkOqygOycvOuhnOuKlCDrqrsg7J6h6rOgLCDsi6TsoJwg7YS07JeQ7ISc66eMIOuTnOufrOuCnOuLpCkNCi8vICLrp4zro4wi66eM7J20IOyVhOuLiOudvCAi7ZWcIOuyiOuPhCDroZzqt7jsnbgg7JWIIO2VqCLrj4Qg6rCZ7J2AIOqyveuhnOuhnCDsnqHtnojrr4DroZwg7KSR66a9IO2RnO2YhOydhCDsk7Tri6QNCmNvbnN0IExPR0lOX0dVSURFID0gJ+2BtOuhnOuTnCDroZzqt7jsnbjsnbQg7ZWE7JqU7ZW07JqUKOyViCDrkJDqsbDrgpgg66eM66OMKSDigJQgW/Cfn6Ag7YG066Gc65OcIOuhnOq3uOyduCDtlYTsmpRdIOuyhO2KvOydhCDriITrpbTrqbQg66Gc6re47J24IOywveydhCDsl7TslrTrk5zroKTsmpQuJzsNCi8vIOyLpOy4oe2VnCDrrLjqtazrk6Q6ICJGYWlsZWQgdG8gYXV0aGVudGljYXRlOiBPQXV0aCBzZXNzaW9uIGV4cGlyZWQgYW5kIGNvdWxkIG5vdCBiZSByZWZyZXNoZWQiKOunjOujjCksDQovLyAiTm90IGxvZ2dlZCBpbiDCtyBQbGVhc2UgcnVuIC9sb2dpbiIo66+466Gc6re47J24KSDigJQg65GYIOuLpCDsnqHtnojqsowg64ST7Z6M64ukDQpmdW5jdGlvbiBpc0F1dGhFcnJvcihzKSB7DQogIHJldHVybiAvYXV0aGVudGljYXR8b2F1dGh8YXBpIGtleXxsb2cgP2lufGxvZ2dlZHxzZXNzaW9uIGV4cGlyZWQvaS50ZXN0KFN0cmluZyhzKSk7DQp9DQovLyDsgqzsmqkg7ZWc64+EIOy0iOqzvCDqsJDsp4Ag4oCUIOuhnOq3uOyduOydgCDrqYDsqaHtlZzrjbAgIuuNlCDrqrsg7JO064ukIuuKlCDqsr3smrAuIOuhnOq3uOyduCDrp4zro4zsmYAg7KGw7LmY6rCAIOuLrOudvOyEnCDrlLDroZwg7J6h64qU64ukLg0KLy8g7Iuk7LihKDIwMjYtMDgsIO2ajOyCrCDsl5TthLDtlITrnbzsnbTspogg7KKM7ISdKTogIllvdSd2ZSBoaXQgeW91ciBpbmRpdmlkdWFsIHNwZW5kIGxpbWl0IMK3IHJ1biAvdXNhZ2UtY3JlZGl0cw0KLy8gdG8gYXNrIHlvdXIgYWRtaW4gZm9yIGEgaGlnaGVyIGxpbWl0IiDigJQg6rSA66as7J6Q6rCAIOyCrOuejOuzhOuhnCDqsbjslrQg65GUIOyDge2VnOydtOudvCDtlIzrnpwg7IKs7Jqp65+J7J20IOuCqOyVhOuPhCDqsbjrprDri6QuDQovLyDsnbQg7LyA7J207Iqk6rCAIOyXhuuNmCDtg5Psl5Ag7JiB7Ja0IOybkOusuOydtCDqt7jrjIDroZwg7Yag7Iqk7Yq464+8ICLsmZwg7JWIIOuQmOuKlOyngCIg7JWMIOyImCDsl4bsl4jri6Qo7Iuk7KCcIOyLoOqzoCkuDQpjb25zdCBMSU1JVF9HVUlERSA9ICftgbTroZzrk5wg7IKs7JqpIO2VnOuPhOulvCDri6Qg7I287Ja07JqUIOKAlCDtmozsgqwg6rOE7KCV7J2066m0IOq0gOumrOyekOyXkOqyjCDtlZzrj4Trpbwg7Jis66CkIOuLrOudvOqzoCDsmpTssq3tlZjqs6AsIOyVhOuLiOuptCBb8J+foCDtgbTroZzrk5wg7ZWc64+EIOy0iOqzvF0g67KE7Yq87J2EIOuIjOufrCDri6Trpbgg6rOE7KCV7Jy866GcIOuhnOq3uOyduO2VtCDso7zshLjsmpQuJzsNCi8vICftlZzrj4Qn66GcIOutieuaseq3uOumrOuptCDslYgg65Cc64ukIOKAlCDsnqDquZAg66qw66a0IOuVjCDrgpjripQgcmF0ZSBsaW1pdOydtOuCmCDrrLjrp6Ug6ri47J20IOy0iOqzvOq5jOyngCDsnqHslYQNCi8vIOyXieuase2VmOqyjCAi64uk66W4IOqzhOygleycvOuhnCDroZzqt7jsnbjtlZjrnbwi6rOgIOyViOuCtO2VmOqyjCDrkJzri6QuIOyngOy2nMK37IKs7Jqp65+JIOyDge2VnCDrrLjqtazrp4wg7KKB7ZiA7IScIOuzuOuLpA0KZnVuY3Rpb24gaXNMaW1pdEVycm9yKHMpIHsNCiAgcmV0dXJuIC9zcGVuZCBsaW1pdHx1c2FnZS1jcmVkaXRzfHVzYWdlIGxpbWl0IChyZWFjaGVkfGV4Y2VlZGVkKS9pLnRlc3QoU3RyaW5nKHMpKTsNCn0NCi8vIOuhnOq3uOyduOuQnCDqs4TsoJUg7ZmV7J24IOKAlCBDTEnqsIAgfi8uY2xhdWRlLmpzb27sl5Ag6riw66Gd7ZWY64qUIG9hdXRoQWNjb3VudC5lbWFpbEFkZHJlc3Prpbwg7J297Ja0DQovLyAvaGVhbHRo66GcIOuFuOy2nO2VnOuLpCAo7ZSM65+s6re47J247J20ICLriITqtawg6rOE7KCV7Jy866GcIOyTsOuKlCDspJHsnbjsp4AiIO2RnOyLnCDigJQg6rO17JqpIFBD7JeQ7IScIOuCqOydmCDqs4TsoJUg7Jik7IKs7JqpIOuwqeyngCkuDQovLyDtjIzsnbzsnbQg7YG0IOyImCDsnojslrQo7ZSE66Gc7KCd7Yq4IOydtOugpSDtj6ztlagpIDMw7LSIIOy6kOyLnC4g7J6s66Gc6re47J247ZWY66m0IENMSeqwgCDtjIzsnbzsnYQg6rCx7Iug7ZWY66+A66GcIOyekOuPmSDrsJjsmIHrkJzri6QuDQpsZXQgYWNjb3VudENhY2hlID0geyBhdDogMCwgZW1haWw6IG51bGwgfTsNCi8vIOyngOq4iCDrlqAg7J6I64qUIGNsYXVkZSDshLjshZjsnbQg7Ja064qQIOqzhOygleycvOuhnCDsi5zrj5nrkJDripTsp4AgKHN0YXJ0UHJvY+yXkOyEnCDquLDroZ0pLg0KLy8g7IS47IWY7J2AIOyLnOuPme2VoCDrlYwg67Cb7J2AIOyeheyepeq2jOydhCDqs4Tsho0g7JOw66+A66GcLCDrsJbsl5DshJwg6rOE7KCV7J2EIOuwlOq+uOuptCDsnbQg6rCS6rO8IO2MjOydvOydmCDqs4TsoJXsnbQg7Ja06riL64Kc64ukDQpsZXQgc2Vzc2lvbkFjY291bnQgPSBudWxsOw0KLy8g7Iuk7KCcIOuhnOq3uOyduCDsl6zrtoDripQg7J6Q6rKp7Kad66qFIO2MjOydvOuhnCDtjJDri6jtlZzri6Qg4oCUIH4vLmNsYXVkZS5qc29u7J2YIG9hdXRoQWNjb3VudOuKlCAqKuuhnOq3uOyVhOybg+2VtOuPhCDrgqjripTri6QqKg0KLy8gKOyLpOy4oTogY2xhdWRlIGF1dGggc3RhdHVz64qUIGxvZ2dlZEluOmZhbHNl7J24642wIOq3uCDtlYTrk5zripQg6re464yA66GcIOKGkiDtlIzrn6zqt7jsnbjsnbQg66Gc6re47J2465CcIOqyg+yymOufvCDtkZzsi5ztlojri6QpLg0KLy8g7YyM7J2866eMIOydveycvOuvgOuhnCDruYTsmqkgMC4gY2xhdWRlIGF1dGggc3RhdHVz66W8IOu2gOultOuptCDsoJXtmZXtlZjsp4Drp4wg7ZSE66Gc7IS47Iqk66W8IOudhOybjOyVvCDtlbTshJwg7KGw7ZqM66eI64ukIOyTsOq4sOyXlCDrrLTqsoHri6QuDQpmdW5jdGlvbiBoYXNDbGF1ZGVDcmVkZW50aWFscygpIHsNCiAgdHJ5IHsNCiAgICBjb25zdCBmID0gcGF0aC5qb2luKG9zLmhvbWVkaXIoKSwgJy5jbGF1ZGUnLCAnLmNyZWRlbnRpYWxzLmpzb24nKTsNCiAgICBjb25zdCBqID0gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMoZiwgJ3V0ZjgnKSk7DQogICAgaWYgKGogJiYgai5jbGF1ZGVBaU9hdXRoICYmIGouY2xhdWRlQWlPYXV0aC5hY2Nlc3NUb2tlbikgcmV0dXJuIHRydWU7DQogIH0gY2F0Y2ggKF9lKSB7IC8qIO2MjOydvCDsl4bsnYzCt+uquyDsnb3snYwg4oCUIOunpeydtOuptCDtgqTssrTsnbjsnYQg66eI7KCAIOuzuOuLpCAqLyB9DQogIC8vICoq66el7J2AIOyekOqyqeymneuqheydhCDtjIzsnbzsnbQg7JWE64uI6528IO2CpOyytOyduOyXkCDrhKPripTri6QqKiAoMjAyNi0wOCDsi6TsuKEsIOuLpOumrCB2NDEgLyDqsJDsi5zsnpAgdjYpLg0KICAvLyDrp6XsnZggQ2xhdWRlIENvZGXripQgfi8uY2xhdWRlLy5jcmVkZW50aWFscy5qc29u7J2EIOyVhOyYiCDrp4zrk6Tsp4Ag7JWK6rOgIO2CpOyytOyduCDtla3rqqkNCiAgLy8gJ0NsYXVkZSBDb2RlLWNyZWRlbnRpYWxzJ+yXkCDsoIDsnqXtlZzri6Qg4oaSIO2MjOydvOunjCDrs7TrqbQg66mA7Kmh7Z6IIOuhnOq3uOyduOuQnCDrp6XsnbQg64qYICfroZzqt7jsnbgg7JWIIOuQqCfsnbQg65CY6rOgLA0KICAvLyDroZzqt7jsnbgg64yA6riwIO2ZlOuptOydtCDsmIHsmIEg64+I64ukKOuIjOufrOuPhCBDTEnqsIAgIuydtOuvuCDroZzqt7jsnbjrkKgi7Jy866GcIOymieyLnCDrgZ3rgpgg67iM65287Jqw7KCA7KGw7LCoIOyViCDsl7TrprDri6QpLg0KICAvLyAqKuyhtOyerOunjCDtmZXsnbjtlZzri6QoLXcg7JeG7J2MKSoqIOKAlCDruYTrsIDrsojtmLgg6rCS7J2EIOydveycvOuptCDtgqTssrTsnbgg7KCR6re8IO2XiOyaqSDtjJ3sl4XsnbQg65ywIOyImCDsnojri6QuIOyVvSAzMG1zLg0KICAvLyBDQl9OT19LRVlDSEFJTj0x7J2066m0IO2MjOydvOunjCDrs7jri6QgKOuqqOydmCDtmYjsnLzroZwgJ+uhnOq3uOyduCDsl4bsnYwn7J2EIOyerO2YhO2VmOuKlCDthYzsiqTtirjsmqkg4oCUIO2CpOyytOyduOydgCBIT01F7J2EIOyViCDrlLDrpbjri6QpLg0KICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicgfHwgcHJvY2Vzcy5lbnYuQ0JfTk9fS0VZQ0hBSU4gPT09ICcxJykgcmV0dXJuIGZhbHNlOw0KICB0cnkgew0KICAgIGNvbnN0IHIgPSBzcGF3blN5bmMoJ3NlY3VyaXR5JywgWydmaW5kLWdlbmVyaWMtcGFzc3dvcmQnLCAnLXMnLCAnQ2xhdWRlIENvZGUtY3JlZGVudGlhbHMnXSwgeyBzdGRpbzogJ2lnbm9yZScsIHRpbWVvdXQ6IDMwMDAgfSk7DQogICAgcmV0dXJuIHIuc3RhdHVzID09PSAwOw0KICB9IGNhdGNoIChfZSkgeyByZXR1cm4gZmFsc2U7IH0gLy8gc2VjdXJpdHnrpbwg66q7IOu2gOumhCA9IOuhnOq3uOyduCDslYgg65Co7Jy866GcIOuzuOuLpA0KfQ0KZnVuY3Rpb24gY2xhdWRlQWNjb3VudCgpIHsNCiAgaWYgKERhdGUubm93KCkgLSBhY2NvdW50Q2FjaGUuYXQgPCAzMDAwMCkgcmV0dXJuIGFjY291bnRDYWNoZS5lbWFpbDsNCiAgbGV0IGVtYWlsID0gbnVsbDsNCiAgdHJ5IHsNCiAgICBpZiAoaGFzQ2xhdWRlQ3JlZGVudGlhbHMoKSkgeyAvLyDsnpDqsqnspp3rqoXsnbQg7JeG7Jy866m0IOuCqOydgCDsnbTrqZTsnbzsnYAg66y07Iuc7ZWc64ukDQogICAgICBjb25zdCBqID0gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKG9zLmhvbWVkaXIoKSwgJy5jbGF1ZGUuanNvbicpLCAndXRmOCcpKTsNCiAgICAgIGVtYWlsID0gKGogJiYgai5vYXV0aEFjY291bnQgJiYgai5vYXV0aEFjY291bnQuZW1haWxBZGRyZXNzKSB8fCBudWxsOw0KICAgIH0NCiAgfSBjYXRjaCAoX2UpIHsgLyog66Gc6re47J24IOydtOugpSDsl4bsnYwg65OxIOKAlCBudWxsIOycoOyngCAqLyB9DQogIGFjY291bnRDYWNoZSA9IHsgYXQ6IERhdGUubm93KCksIGVtYWlsIH07DQogIHJldHVybiBlbWFpbDsNCn0NCmZ1bmN0aW9uIGNoZWNrQ2xhdWRlQXZhaWxhYmxlKCkgew0KICBjb25zdCBwcm9iZSA9IHNwYXduKCdjbGF1ZGUnLCBbJy0tdmVyc2lvbiddLCB7IHNoZWxsOiB0cnVlLCBlbnY6IENMQVVERV9FTlYgfSk7DQogIGxldCBvdXQgPSAnJzsNCiAgcHJvYmUuc3Rkb3V0Lm9uKCdkYXRhJywgKGQpID0+IHsgb3V0ICs9IGQudG9TdHJpbmcoKTsgfSk7DQogIHByb2JlLm9uKCdlcnJvcicsICgpID0+IHsgY2xhdWRlU3RhdHVzID0gJ2NsYXVkZS1taXNzaW5nJzsgfSk7DQogIHByb2JlLm9uKCdjbG9zZScsIChjb2RlKSA9PiB7DQogICAgY2xhdWRlU3RhdHVzID0gKGNvZGUgPT09IDAgJiYgL1xkK1wuXGQrLy50ZXN0KG91dCkpID8gJ29rJyA6ICdjbGF1ZGUtbWlzc2luZyc7DQogICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIENsYXVkZSBDb2RlIOygkOqygDogJyArIGNsYXVkZVN0YXR1cyArIChvdXQgPyAnICgnICsgb3V0LnRyaW0oKSArICcpJyA6ICcnKSk7DQogIH0pOw0KfQ0KLy8g7LKY66asIO2YhO2ZqSDigJQgL2hlYWx0aOuhnCDrhbjstpztlbQgIuygleunkCDtgbTroZzrk5zqsIAg64u17ZaI64qU7KeAIiDrsJbsl5DshJwg7ZmV7J247ZWgIOyImCDsnojqsowg7ZWc64ukDQpjb25zdCBzdGF0cyA9IHsgc2VydmVkOiAwLCBsYXN0QXQ6ICcnLCBsYXN0VGV4dDogJycsIGxhc3RTZWM6ICcnIH07DQoNCi8vIOKUgOKUgCDtlIzrn6zqt7jsnbgg7IOd7KG0IOqwkOyngCjsi6zsnqXrsJXrj5kpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KLy8g7ZSM65+s6re47J247J20IOuWoCDsnojripQg64+Z7JWIIGNvZGUudHPqsIAgNey0iOuniOuLpCBQT1NUIC9oZWFydGJlYXTrpbwg67O064K464ukLg0KLy8g7ZWcIOuyiOydtOudvOuPhCDrsJvsnYAg65KkIDMw7LSI6rCEIOuBiuq4sOuptCDtlIzrn6zqt7jsnbgo65iQ64qUIO2UvOq3uOuniCnsnbQg64ur7Z6MIOqygyDigJQg7YG066Gc65Oc6rmM7KeAIOuNsOumrOqzoCDqsJnsnbQg6rq87KeE64ukLg0KLy8g7JWE7KeBIO2VnCDrsojrj4Qg66q7IOuwm+yVmOycvOuptCjri6Trpqzrp4wg66i87KCAIOy8oCDsg4Htg5wsIOyekOuPmeyLnOyekSDrk7EpIOqzhOyGjSDrjIDquLDtlZzri6QuDQpjb25zdCBIRUFSVEJFQVRfREVBRF9NUyA9IDMwMDAwOw0KbGV0IGxhc3RCZWF0ID0gMDsNCg0KLy8g64GE6riwIOyghOyXkCAqKuuTo+uNmCDtj6ztirjrpbwg66i87KCAIOuGk+uKlOuLpCoqICgyMDI2LTA4LCBCUklER0VfVj00MikuDQovLyDsmZw6IHByb2Nlc3MuZXhpdOydmCBleGl0IO2VuOuTpOufrOqwgCBraWxsUHJvY+KGknRhc2traWxs7J2EIOuPjOumrOuKlOuNsCwg6re46rKMIOupiOy2lOuptCDtlITroZzshLjsiqTqsIAg7KKF66OMIOuPhOykkQ0KLy8g7Ja87Ja067aZ7Ja0IO2PrO2KuOunjCDrrLzqs6Ag7J2R64u17J2EIOuquyDtlZjripQg7KKA67mE6rCAIOuQnOuLpC4g6re465+s66m0IOqwkOyLnOyekOqwgCDsg4jroZwg7LygIOuLpOumrOuKlCBFQUREUklOVVNF66GcDQovLyDrrLzrn6zrgpjqs6Ao66Gc6re4OiAn7J2066+4IOy8nOyguCDsnojslrTsmpQnKSwg7ZSM65+s6re47J247JeUICLsl7Drj5nrkJjsp4Ag7JWK7JWY7Ja07JqUIuunjCDrgqjripTri6Qo7Iuk7LihKS4NCi8vIOyGjOy8k+ydhCDrqLzsoIAg64ur7JWEIOuRkOuptCDsoJXrpqzqsIAg64qQ66Ck64+EIOuLpOydjCDri6TrpqzqsIAg7KCV7IOB7KCB7Jy866GcIOq3uCDtj6ztirjrpbwg7J6h64qU64ukLg0KZnVuY3Rpb24gaGFyZEV4aXQoY29kZSkgew0KICB0cnkgeyBzZXJ2ZXIuY2xvc2UoKTsgfSBjYXRjaCAoX2UpIHsgLyog7JWE7KeBIOyViCDrlrTsnLzrqbQg66y07IucICovIH0NCiAgdHJ5IHsgc2VydmVyNi5jbG9zZSgpOyB9IGNhdGNoIChfZSkgeyAvKiBJUHY27J2AIOyXhuydhCDsiJgg7J6I64ukICovIH0NCiAgcHJvY2Vzcy5leGl0KGNvZGUgfHwgMCk7DQp9DQpzZXRJbnRlcnZhbCgoKSA9PiB7DQogIGlmIChsYXN0QmVhdCAmJiBEYXRlLm5vdygpIC0gbGFzdEJlYXQgPiBIRUFSVEJFQVRfREVBRF9NUykgew0KICAgIC8vICoq66Gc6re47J24IOykkeydtOuptCDslYgg6rq87KeE64ukKiogKDIwMjYtMDgsIEJSSURHRV9WPTM3KTogZXhpdCDtlbjrk6Trn6zqsIAga2lsbExvZ2luUHJvY+q5jOyngCDrtoDrpbTrr4DroZwNCiAgICAvLyDsl6zquLDshJwg6rq87KeA66m0IOu4jOudvOyasOyggOyXkOyEnCDroZzqt7jsnbjtlZjrjZgg7IKs656M7J2YIOy9nOuwsSDtj6ztirjqsIAg64ur7ZiAICJsb2NhbGhvc3Tsl5DshJwg7Jew6rKw7J2EIOqxsOu2gO2WiOyKteuLiOuLpCLqsIANCiAgICAvLyDrnKjqsbDrgpgsIOuhnOq3uOyduCDssL3snbQg7IaM66asIOyXhuydtCDrrLTtmqjqsIAg65Cc64ukKOyLpOy4oSDigJQg7ZSM65+s6re47J247J2EIOuLq+yVhCDrkZQg7LGEIOuhnOq3uOyduO2VmOuptCDrp6Trsogg7J20656s64ukKS4NCiAgICAvLyDroZzqt7jsnbjsnYAg67iM65287Jqw7KCA7JeQ7IScIOyCrOuejOydtCDsp4TtlontlZjripQg7J287J206528IO2UjOufrOq3uOyduOydtCDrlqAg7J6I7J2EIO2VhOyalOqwgCDsl4bri6QuIOustO2VnCDrjIDquLAg7JyE7ZeY7J2ADQogICAgLy8gbG9naW5Qcm9jVGltZXIoMzDrtoQp6rCAIOunieuKlOuLpCDigJQg6re4IO2DgOydtOuouOqwgCDroZzqt7jsnbjsnYQg7KCV66as7ZWY66m0IOuLpOydjCDsoJDqsoDsl5DshJwg7KCV7IOB7KCB7Jy866GcIOq6vOynhOuLpC4NCiAgICBpZiAobG9naW5Qcm9jKSB7DQogICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g7Ius7J6l67CV64+Z7J2AIOuBiuqyvOyngOunjCDroZzqt7jsnbjsnbQg7KeE7ZaJIOykkeydtOudvCDquLDri6Trpr3ri4jri6QgKOuhnOq3uOyduCDrgZ3rgpjrqbQg7KCV66as65Cp64uI64ukKS4nKTsNCiAgICAgIHJldHVybjsNCiAgICB9DQogICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIO2UjOufrOq3uOyduCDsi6zsnqXrsJXrj5kg64GK6rmAIOKAlCDtlLzqt7jrp4gv7ZSM65+s6re47J247J20IOuLq+2ejCDqsoPsnLzroZwg67O06rOgIOqwmeydtCDqurzsp5Hri4jri6QuJyk7DQogICAgaGFyZEV4aXQoMCk7IC8vIO2PrO2KuOulvCDrqLzsoIAg64aT6rOgIOyiheujjCDigJQgZXhpdCDtlbjrk6Trn6zqsIAga2lsbFByb2PsnLzroZwgY2xhdWRlIO2KuOumrOulvCDsoJXrpqztlZzri6QNCiAgfQ0KfSwgNTAwMCk7DQoNCi8vIOybuSDroZzqt7jslYTsm4PsnYQg67iM65287Jqw7KCA66GcIOyXrOuKlCDsvZTrk5zripQg7KCc6rGw7ZaI64ukICgyMDI2LTA4LCBCUklER0VfVj00MCkg4oCUIOuhnOq3uOyduCDtmZTrqbTsnbQg65GQIOqwnCDrlqDshJwNCi8vIOyWtOuKkCDsqr3sl5Ag66Gc6re47J247ZW07JW8IO2VmOuKlOyngCDslYwg7IiYIOyXhuyXiOuLpCjsi6TsuKEg7Iug6rOgKS4g7Iq57J24IO2ZlOuptOydhCDqsbTrhIjrm7DroKTrqbQg7IKs7Jqp7J6Q6rCAIOu4jOudvOyasOyggOyXkOyEnA0KLy8g7KeB7KCRIGNsYXVkZSDroZzqt7jslYTsm4PsnYQg7ZWY6rGw64KYLCDsirnsnbgg7ZmU66m0IO2VmOuLqCBb6rOE7KCVIOyghO2ZmF3snYQg7JOw66m0IOuQnOuLpC4gKirtg63snYAg7ZWt7IOBIDHqsJzroZwg7Jyg7KeA7ZWgIOqygy4qKg0KDQovLyDimqDvuI8g66Gc6re47J24IOqyveuhnOyXkOyEnCAqKkJST1dTRVLrpbwg6rG065Oc66as66m0IOyViCDrkJzri6QqKiAoMjAyNi0wOCDsi6TsuKEgMu2ajOuhnCDtmZXsoJUpOg0KLy8gICBCUk9XU0VS66W8IOyEpOygle2VmOuptCjrgrTsmqnsnbQg66y07JeH7J2065OgLCDslYTrrLTqsoPrj4Qg7JWIIO2VmOuKlCBuby1vcOydtOyWtOuPhCkgY2xhdWRlIENMSeqwgCDruIzrnbzsmrDsoIAg7ZW465Oc7Jik7ZSE66W8DQovLyAgIO2PrOq4sO2VmOqzoCAqKiLsnbjspp0g7L2U65Oc66W8IENsYXVkZSBDb2Rl7JeQIOu2meyXrOuEo+ycvOyEuOyalCIg67Cp7Iud7Jy866GcIOuwlOuAkOuLpCoqLiDri6TrpqzripQg66Gc6re47J24IO2UhOuhnOyEuOyKpOulvA0KLy8gICDsiKjqsqjshJwgc3RkaW4g7JeG7J20IOudhOyasOuvgOuhnCDrtpnsl6zrhKPsnYQg6rOz7J20IOyXhuyWtCDroZzqt7jsnbjsnbQg7JWE7JiIIOu2iOqwgOuKpe2VtOynhOuLpC4NCi8vICAgKGxvY2FsaG9zdCBMSVNURU7snbQg65agIOyeiOuKlCDqsoPrp4wg67O06rOgIOyekOuPmSDsiJjroLnsnbQg7Jyg7KeA65Cc64uk6rOgIO2MkOuLqO2WiOuNmCDqsowg7Jik7KeE7J207JeI64ukLikNCi8vICAg4oaSIOq3uOuemOyEnCAi7YOtIDHqsJwgKyDqs4TsoJUg7ISg7YOdIO2ZlOuptCLsnYAg7J20IENMSeuhnCDrtojqsIDriqXtlZjri6Q6IO2VnCDtg63snLzroZwg7J6H7J6Q66m0IENMSeydmCDsl7TquLDrpbwg66eJ7JWE7JW8DQovLyAgIO2VmOqzoCwg66eJ7Jy866m0IOy9lOuTnCDrtpnsl6zrhKPquLDqsIAg65Cc64ukLiDroZzqt7jslYTsm4PsnYQg65Sw66GcIOyXtOuptCDtg63snbQgMuqwnOqwgCDrkJzri6QuDQovLyAgIOqysOuhoCjsgqzsmqnsnpAg6rKw7KCVKTogKirtg60gMeqwnCArIOyKueyduCDtmZTrqbQqKuydhCDsk7Dqs6AsIOqzhOyglSDsoITtmZjsnYAg6re4IO2ZlOuptOydmCBb6rOE7KCVIOyghO2ZmF0g67KE7Yq87Jy866GcIO2VnOuLpC4NCi8vICAg7IKt7KCc65CcIOyLnOuPhOuTpDogd3JpdGVOb29wQnJvd3NlciAvIG9wZW5VcmxJbkRlZmF1bHRCcm93c2VyIC8gYnVpbGRMb2dvdXRDaGFpblVybCAo67O16rWs64qUIGdpdCDtnojsiqTthqDrpqwpLg0KLy8g4pSA4pSAIOuhnOq3uOyduOydgCBDTEnqsIAg6riw67O4IOu4jOudvOyasOyggOulvCDsp4HsoJEg7Je06rKMIO2VnOuLpCAoMjAyNi0wOCwgQlJJREdFX1Y9MzApIOKUgOKUgA0KLy8g7Jqw66as6rCAIEJST1dTRVLrpbwg6rCA66Gc7LGE6rGw64KYIOywveydhCDqs6jrnbwg7Jes64qUIOyLnOuPhOuKlCAqKuyghOu2gCDsi6TtjKjtlbTshJwg65CY64+M66C464ukKiouIOuCqOq4tCDqtZDtm4g6DQovLyAgIOKRoCBCUk9XU0VSIO2VuOuTpOufrOuhnCBVUkzsnYQg67Cb7Jy866m0IGNtZOqwgCBgJmDsl5DshJwg7J6Y652866i564qU64ukIOKGkiBjbGllbnRfaWQg7IaM7IukKCLsnpjrqrvrkJwgT0F1dGgg7JqU7LKtIikuDQovLyAgIOKRoSBCUk9XU0VS66W8IG5vLW9w7Jy866GcIOunieqzoCBzdGRvdXTsnZggVVJM7J2EIOyasOumrOqwgCDsl7TrqbQgKirsirnsnbgg65KkIOyduOymney9lOuTnOulvCDrtpnsl6zrhKPsnLzrnbzripQg7ZmU66m0KirsnbQNCi8vICAgICAg65ys64ukKOyLpOy4oSDsi6Dqs6A6ICLsnbTrn7Ag6rGwIOyXhuyXiOuKlOuNsCDqsJHsnpDquLAg7JmcIOyDneqyqCIpIOKAlCDsnpDrj5kg7IiY66C57J20IOq5qOynhOuLpC4NCi8vICAg4pGiIOyLnO2BrOumvyDssL3snLzroZwg7Je066Ck66m0IOu4jOudvOyasOyggOulvCDsmrDrpqzqsIAg6rOo65287JW8IO2VtOyEnCAqKuq4sOuzuCDruIzrnbzsmrDsoIDqsIAg7JWE64uMIO2BrOuhrMK37Jej7KeA6rCAIOyXtOumsOuLpCoqDQovLyAgICAgICjsi6TsuKEg7Iug6rOgOiAi7JmcIO2BrOuhrOycvOuhnCDsl7TroKQiLCAi6riw67O4IOu4jOudvOyasOyggOuhnCDtlZjrnbzri4jquYwiKS4g6rKM64uk6rCAIOq4sOuzuCDruIzrnbzsmrDsoIDqsIAg7Iuc7YGs66a/DQovLyAgICAgIOyduOyekOulvCDrrLTsi5ztlZjrqbQo7IK87ISxIOyduO2EsOuEtyDsi6TsuKEpIOydvOuwmCDssL3snbQg65agIOyKueyduCDtmZTrqbTsnbQg6re464yA66Gc64ukLg0KLy8g6re4656Y7IScICoqQlJPV1NFUuulvCDqsbTrk5zrpqzsp4Ag7JWK64qU64ukKiog4oCUIGNsYXVkZSBDTEnqsIAg6riw67O4IOu4jOudvOyasOyggOulvCDsl7Tqs6AgbG9jYWxob3N066GcIOqysOqzvOulvCDsnpDrj5kNCi8vIOyImOugue2VnOuLpCjsvZTrk5wg67aZ7Jes64Sj6riwIOyXhuydjCkuIOqzhOyglSDsoITtmZjsnYAg7Iq57J24IO2ZlOuptCDtlZjri6ggW+qzhOyglSDsoITtmZhdIOuyhO2KvOycvOuhnCDtlZzri6QuDQovLyAqKuydtCDqsr3roZzsl5AgVVJMIOqwgOqztcK37KSR6rCEIOyKpO2BrOumve2KuMK367iM65287Jqw7KCAIOyngOygleydhCDri6Tsi5wg64Sj7KeAIOunkCDqsoMuKioNCg0KLy8g4pSA4pSAIEJST1dTRVIg6rCA66Gc7LGE6riw64qUIOygnOqxsOuQkOuLpCAoMjAyNi0wOCwgQlJJREdFX1Y9MjUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KLy8g7JiI7KCE7JeUIEJST1dTRVIg7ZmY6rK967OA7IiY7JeQIOyehOyLnCDsiqTtgazrpr3tirjrpbwg6r2C7JWEIENMSeqwgCDspIAgYXV0aG9yaXplIFVSTOydhCDsmrDrpqzqsIAg67Cb7JWE7IScIOyXtOyXiOuLpC4NCi8vIOuqqeyggeydgCDtlZjrgpjrv5DsnbTsl4jri6Qg4oCUIOqzhOyglSDsoITtmZjsmqnsnLzroZwgVVJM7J2EIGNsYXVkZS5haS9sb2dvdXQ/cmV0dXJuVG894oCm66GcIOyerOyekeyEse2VtA0KLy8g7Iq57J24IO2ZlOuptOydhCDqsbTrhIjrm7Dqs6Ag6rOE7KCVIOyEoO2DnSDtmZTrqbTsl5Ag7KeB7ZaJ7Iuc7YKk6riwLiDqt7gg7J6s7J6R7ISx7J2EIO2PkOq4sO2VmOyekCjsgqzsmqnsnpAg6rKw7KCVKSDtlbjrk6Trn6zripQNCi8vIOuqqeyggeydtCDsl4bslrTsoYzqs6AsICoq64Ko6rKoIOuRkOuptCDsmKTtnojroKQg66Gc6re47J247J2EIOunneqwgOucqOumsOuLpCoqOg0KLy8gICBDTEnqsIAgVVJM7J2EIOuUsOyYtO2RnCDsl4bsnbQg64SY6riw66m0IGNtZOqwgCBgJmDsl5DshJwgVVJM7J2EIOyemOudvCDrsoTroKQo7JyI64+E7JqwKSBjbGllbnRfaWQg6rCZ7J2AIOuSpOyqvQ0KLy8gICDrp6TqsJzrs4DsiJjqsIAg7IKs65287KeA6rOgLCDruIzrnbzsmrDsoIDsl5QgIuyemOuqu+uQnCBPQXV0aCDsmpTssq0gwrcgY2xpZW50X2lkIOunpOqwnOuzgOyImOqwgCDriITrnb3rkJjsl4jsirXri4jri6Qi6rCAIOucrOuLpC4NCi8vICAg7Ius7ZWY66m0IOu4jOudvOyasOyggOqwgCDslYTsmIgg7JWIIOyXtOumsOuLpCjsi6TsuKEgMjAyNi0wODogQ0xJIO2UhOuhnOyEuOyKpOuKlCDrjIDquLAg7KSR7J24642wIOywveydtCDslYgg65y4KS4NCi8vIOydtOygnCBCUk9XU0VS66W8IOqxtOuTnOumrOyngCDslYrripTri6Qg4oaSIGNsYXVkZSBDTEnqsIAg6riw67O4IOu4jOudvOyasOyggOulvCDsp4HsoJEg7Jew64ukKENMSSDquLDrs7gg64+Z7J6RKS4NCi8vICoq7J20IOqyveuhnOyXkCBVUkwg6rCA6rO1wrfspJHqsIQg7Iqk7YGs66a97Yq466W8IOuLpOyLnCDrhKPsp4Ag66eQIOqygy4qKiDqs4TsoJUg7KCE7ZmY7J2AIOyKueyduCDtmZTrqbQg7ZWY64uoIFvqs4TsoJUg7KCE7ZmYXSDrsoTtirzsnLzroZwuDQoNCi8vIOu4jOudvOyasOyggCDroZzqt7jsnbgg7ZSE66Gc7IS47IqkIChjbGF1ZGUgYXV0aCBsb2dpbiAtLWNsYXVkZWFpKSDigJQgL29wZW4tbG9naW7snbQg7IOd7ISxwrfqtIDrpqwuDQovLyDruIzrnbzsmrDsoIDqsIAgbG9jYWxob3N066GcIOqysOqzvOulvCDrs7TrgrTspIQg65WM6rmM7KeAIOyIqOyWtOyEnCDrjIDquLDtlZjri6TqsIAsIOyZhOujjOuQmOuptCDsiqTsiqTroZwg64Gd64Kc64ukLg0KbGV0IGxvZ2luUHJvYyA9IG51bGw7DQpsZXQgbG9naW5Qcm9jVGltZXIgPSBudWxsOw0KbGV0IGxvZ2luU3RhcnRlZEF0ID0gMDsgLy8g67iM65287Jqw7KCAIOuhnOq3uOyduCDsi5zsnpEg7Iuc6rCBIOKAlCDsnqztgbTrpq3snbQgJ+yerOyLnOuPhCfsnbjsp4AgJ+yekOuPmeyZhOujjCDsi6TtjKgn7J247KeAIOq1rOu2hO2VnOuLpA0KLy8g7J2067KIIOuhnOq3uOyduOyXkOyEnCDruIzrnbzsmrDsoIAg7LC97J2EIOyLpOygnOuhnCDrnYTsm6DripTqsIAg4oCUIO2EsOuvuOuEkCDtj7TrsLHsnYAg7J206rKMIGZhbHNl7J28IOuVjOunjCDsk7Tri6QNCi8vICjsi5zqsITrp4zsnLzroZwg7YyQ64uo7ZWY66m0IOygleyDgSDsnqztgbTrpq3sl5Drj4QgY21kIOywveydtCDtioDslrTrgpjsmKjri6QpDQpsZXQgbG9naW5XaW5kb3dPcGVuZWQgPSBmYWxzZTsNCmZ1bmN0aW9uIGtpbGxMb2dpblByb2MoKSB7DQogIGlmIChsb2dpblByb2NUaW1lcikgeyBjbGVhclRpbWVvdXQobG9naW5Qcm9jVGltZXIpOyBsb2dpblByb2NUaW1lciA9IG51bGw7IH0NCiAgaWYgKCFsb2dpblByb2MpIHJldHVybjsNCiAgY29uc3QgcCA9IGxvZ2luUHJvYzsNCiAgbG9naW5Qcm9jID0gbnVsbDsNCiAgdHJ5IHsNCiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJykgew0KICAgICAgLy8gdGltZW91dDoga2lsbFByb2Pqs7wg6rCZ7J2AIOydtOycoCDigJQg7KKF66OMIOqyveuhnOyXkOyEnCB0YXNra2lsbOydtCDrqYjstpTrqbQg64uk66as6rCAIOyWvOyWtOu2meuKlOuLpA0KICAgICAgc3Bhd25TeW5jKCd0YXNra2lsbCcsIFsnL1BJRCcsIFN0cmluZyhwLnBpZCksICcvVCcsICcvRiddLCB7IHN0ZGlvOiAnaWdub3JlJywgdGltZW91dDogNDAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7DQogICAgfSBlbHNlIHsNCiAgICAgIHRyeSB7IHByb2Nlc3Mua2lsbCgtcC5waWQsICdTSUdURVJNJyk7IH0gY2F0Y2ggKF9lMikgeyBwLmtpbGwoKTsgfQ0KICAgIH0NCiAgfSBjYXRjaCAoX2UpIHsgLyog66y07IucICovIH0NCn0NCg0KLy8g7YS0IOuPhOykkSDtgbTroZzrk5wg7ZSE66Gc7IS47Iqk6rCAIOyjveyXiOydhCDrlYzsnZgg7Iuk7YyoIOuplOyLnOyngCDigJQgcnVuVHVybuydtCDsnbQg66mU7Iuc7KeA7J28IOuVjOunjCAx7ZqMIOyekOuPmSDsnqzsi5zrj4TtlZzri6QNCmNvbnN0IFNFU1NJT05fRElFRCA9ICftgbTroZzrk5wg7IS47IWY7J20IOyiheujjOuQkOyWtOyalC4nOw0KbGV0IHNodXR0aW5nRG93biA9IGZhbHNlOyAvLyAvc2h1dGRvd24g7KeE7ZaJIOykkSDigJQg7J6s7Iuc64+E66GcIOyEuOyFmOydhCDrkJjsgrTrpqzsp4Ag7JWK6rKMIO2RnOyLnA0KDQovLyByZWFzb27snYQg7KO866m0ICfsnZjrj4TsoIEg7KKF66OMJyjqs4TsoJUg7KCE7ZmYwrfroZzqt7jslYTsm4Mg65OxKSDigJQg7KeE7ZaJIOykkeydtOuNmCDthLTsnYQg6re4IOuplOyLnOyngOuhnCDrgZ3rgrTshJwNCi8vIHJ1blR1cm7snZggU0VTU0lPTl9ESUVEIOyekOuPmSDsnqzsi5zrj4TqsIAg7JibIOyekOqyqeymneuqheycvOuhnCDshLjshZjsnYQg65CY7IK066as7KeAIOyViuqyjCDtlZzri6QuDQovLyAo7JWIIOq3uOufrOuptCDqs4TsoJUg7KCE7ZmYIOynge2bhCDsmJsg6rOE7KCVIOyEuOyFmOydtCDrtoDtmZztlbQgTUFYX1RVUk5T6rmM7KeAIOqzhOyGjSDsk7DsnbTripQg67KE6re4IOKAlCAyMDI2LTA3IOumrOu3sOyXkOyEnCDtmZXsnbgpDQpmdW5jdGlvbiBraWxsUHJvYyhyZWFzb24pIHsNCiAgaWYgKHByb2MpIHsNCiAgICB0cnkgew0KICAgICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicpIHsNCiAgICAgICAgLy8gc2hlbGw6dHJ1ZeuhnCDrnYTsm4zshJwgcHJvY+ydgCBjbWQg6ruN642w6riwIOKAlCAvVOuhnCDtirjrpqzsp7gg7KO97Jes7JW8IOynhOynnCBjbGF1ZGXqsIAg6rOg7JWE66GcIOyViCDrgqjripTri6QNCiAgICAgICAgLy8gKOqzoOyVhCBjbGF1ZGXqsIAg7ISk7LmYIO2MjOydvOydhCDrrLzqs6Ag7J6I7Jy866m0IO2BtOuhnOuTnCDslbEg7JeF642w7J207Yq46rCAICLsgqzsmqkg7KSRIuycvOuhnCDrp4ntnpgpDQogICAgICAgIC8vIOKaoO+4jyB0aW1lb3V0IO2VhOyImCAoMjAyNi0wOCDsi6TsuKEpOiDsnbQgc3Bhd25TeW5j64qUIHByb2Nlc3Mub24oJ2V4aXQnKeyXkOyEnOuPhCDrtojrpqzripTrjbAsDQogICAgICAgIC8vIOyViCDso73ripQgY2xhdWRlIO2KuOumrOulvCDrp4zrgpggdGFza2tpbGzsnbQg66mI7LaU66m0ICoq64uk66as6rCAIOyiheujjCDrj4TspJHsl5Ag7Ja87Ja067aZ64qU64ukKiog4oCUDQogICAgICAgIC8vIO2PrO2KuCAxMTg4OOydgCDqs4Tsho0g66y86rOgIOydkeuLteydgCDrqrsg7ZWY64qUIOyDge2DnOqwgCDrkJjslrQsIOyDiCDsnbjsiqTthLTsiqTripQgRUFERFJJTlVTReuhnCDrrLzrn6zrgpjqs6ANCiAgICAgICAgLy8g7ZSM65+s6re47J247JeUICLtgbTroZzrk5zqsIAg7Jew64+Z65CY7KeAIOyViuyVmOyWtOyalCLrp4wg65ys64ukKDQw67aE6rCEIOq3uCDsg4Htg5zsmIDrjZgg7Iuk7LihIOyCrOuhgCkuDQogICAgICAgIHNwYXduU3luYygndGFza2tpbGwnLCBbJy9QSUQnLCBTdHJpbmcocHJvYy5waWQpLCAnL1QnLCAnL0YnXSwgeyBzdGRpbzogJ2lnbm9yZScsIHRpbWVvdXQ6IDQwMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pOw0KICAgICAgfSBlbHNlIHsNCiAgICAgICAgLy8gbWFjT1Mv66as64iF7IqkOiBzaGVsbDp0cnVl6528IHByb2PsnbQgc2gg6ruN642w6riw7J28IOyImCDsnojsnYwg4oCUIHN0YXJ0UHJvY+ydmCBkZXRhY2hlZOuhnCDrp4zrk6ANCiAgICAgICAgLy8g7ZSE66Gc7IS47IqkIOq3uOujuSgtcGlkKeydhCDthrXsp7jroZwg7KCV66as7ZWc64ukICh0YXNra2lsbCAvVCDrjIDsnZEpDQogICAgICAgIHRyeSB7IHByb2Nlc3Mua2lsbCgtcHJvYy5waWQsICdTSUdURVJNJyk7IH0gY2F0Y2ggKF9lMikgeyBwcm9jLmtpbGwoKTsgfQ0KICAgICAgfQ0KICAgIH0gY2F0Y2ggKF9lKSB7IC8qIOustOyLnCAqLyB9DQogIH0NCiAgcHJvYyA9IG51bGw7DQogIHdhcm1lZFVwID0gZmFsc2U7DQogIGlmICh3YWl0ZXIpIHsgY2xlYXJUaW1lb3V0KHdhaXRlci50aW1lcik7IHdhaXRlci5yZWplY3QobmV3IEVycm9yKHJlYXNvbiB8fCBTRVNTSU9OX0RJRUQpKTsgd2FpdGVyID0gbnVsbDsgfQ0KfQ0KDQpmdW5jdGlvbiBzdGFydFByb2MoKSB7DQogIGtpbGxQcm9jKCk7DQogIGxpbmVCdWYgPSAnJzsNCiAgdHVybnMgPSAwOw0KICAvLyDsnbQg7IS47IWY7J20IOyWtOuKkCDqs4TsoJXsnZgg7J6F7J6l6raM7Jy866GcIOuPhOuKlOyngCDquLDroZ0g4oCUIOuwluyXkOyEnCDqs4TsoJXsnbQg67CU64CM7JeI64qU7KeAIOu5hOq1kO2VmOuKlCDquLDspIANCiAgc2Vzc2lvbkFjY291bnQgPSBjbGF1ZGVBY2NvdW50KCk7DQogIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDtgbTroZzrk5wg7IS47IWYIOyLnOuPmSDspJHigKYgKOuqqOuNuDogJyArIGN1cnJlbnRNb2RlbCArICcpJyk7DQogIGNvbnN0IHRoaXNQcm9jID0gc3Bhd24oJ2NsYXVkZScsIFsnLXAnLCAnLS1tb2RlbCcsIGN1cnJlbnRNb2RlbCwgJy0taW5wdXQtZm9ybWF0JywgJ3N0cmVhbS1qc29uJywgJy0tb3V0cHV0LWZvcm1hdCcsICdzdHJlYW0tanNvbicsICctLXZlcmJvc2UnXSwgew0KICAgIHNoZWxsOiB0cnVlLCBjd2Q6IEVNUFRZX0NXRCwgZW52OiBDTEFVREVfRU5WLA0KICAgIGRldGFjaGVkOiBwcm9jZXNzLnBsYXRmb3JtICE9PSAnd2luMzInLCAvLyBQT1NJWDog7J6Q6riwIO2UhOuhnOyEuOyKpCDqt7jro7kg7IOd7ISxIOKAlCBraWxsUHJvY+ydtCDqt7jro7nsp7gg7KCV66as7ZWgIOyImCDsnojqsowNCiAgfSk7DQogIHByb2MgPSB0aGlzUHJvYzsNCiAgcHJvYy5zdGRvdXQub24oJ2RhdGEnLCAoZCkgPT4gew0KICAgIGxpbmVCdWYgKz0gZC50b1N0cmluZygndXRmOCcpOw0KICAgIGxldCBpZHg7DQogICAgd2hpbGUgKChpZHggPSBsaW5lQnVmLmluZGV4T2YoJ1xuJykpICE9PSAtMSkgew0KICAgICAgY29uc3QgbGluZSA9IGxpbmVCdWYuc2xpY2UoMCwgaWR4KS50cmltKCk7DQogICAgICBsaW5lQnVmID0gbGluZUJ1Zi5zbGljZShpZHggKyAxKTsNCiAgICAgIGlmICghbGluZSkgY29udGludWU7DQogICAgICBsZXQgZXYgPSBudWxsOw0KICAgICAgdHJ5IHsgZXYgPSBKU09OLnBhcnNlKGxpbmUpOyB9IGNhdGNoIChfZSkgeyBjb250aW51ZTsgfQ0KICAgICAgaWYgKGV2ICYmIGV2LnR5cGUgPT09ICdyZXN1bHQnICYmIHdhaXRlcikgew0KICAgICAgICBjb25zdCB3ID0gd2FpdGVyOw0KICAgICAgICB3YWl0ZXIgPSBudWxsOw0KICAgICAgICBjbGVhclRpbWVvdXQody50aW1lcik7DQogICAgICAgIGlmIChldi5pc19lcnJvcikgew0KICAgICAgICAgIGNvbnN0IHJhdyA9IFN0cmluZyhldi5yZXN1bHQgfHwgZXYuc3VidHlwZSB8fCAnJykuc2xpY2UoMCwgMjAwKTsNCiAgICAgICAgICAvLyDtlZzrj4Qg7LSI6rO866W8IOuovOyggCDrs7jri6Qg4oCUIOuhnOq3uOyduCDsmKTrpZgg7KCV6rec7Iud7J20IOuEk+yWtOyEnChsb2cgP2luIOuTsSkg66y46rWs6rCAIOuwlOuAjOuptCDsgrztgqwg7IiYIOyeiOuLpA0KICAgICAgICAgIGlmIChpc0xpbWl0RXJyb3IocmF3KSkgew0KICAgICAgICAgICAgY2xhdWRlU3RhdHVzID0gJ2NsYXVkZS1saW1pdCc7IC8vIC9oZWFsdGjroZwg7JWM66a8IOKGkiDrsoTtirzsnbQgW+2VnOuPhCDstIjqs7xd66GcIOuwlOuAjOqzoCDqs4TsoJUg7KCE7ZmY7J2EIOyViOuCtA0KICAgICAgICAgICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIO2BtOuhnOuTnCDsgqzsmqkg7ZWc64+EIOy0iOqzvCDqsJDsp4A6JywgcmF3KTsNCiAgICAgICAgICAgIHcucmVqZWN0KG5ldyBFcnJvcihMSU1JVF9HVUlERSkpOw0KICAgICAgICAgIH0gZWxzZSBpZiAoaXNBdXRoRXJyb3IocmF3KSkgew0KICAgICAgICAgICAgY2xhdWRlU3RhdHVzID0gJ2NsYXVkZS1sb2dvdXQnOyAvLyAvaGVhbHRo66GcIO2UjOufrOq3uOyduOyXkCDslYzrprwg4oaSIOuyhO2KvOydtCBb66Gc6re47J24IO2VhOyalF3roZwg67CU64CcDQogICAgICAgICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g7YG066Gc65OcIOuhnOq3uOyduCDrp4zro4wg6rCQ7KeAOicsIHJhdyk7DQogICAgICAgICAgICB3LnJlamVjdChuZXcgRXJyb3IoTE9HSU5fR1VJREUpKTsNCiAgICAgICAgICB9IGVsc2Ugew0KICAgICAgICAgICAgdy5yZWplY3QobmV3IEVycm9yKCftgbTroZzrk5wg7Jik66WYOiAnICsgcmF3KSk7DQogICAgICAgICAgfQ0KICAgICAgICB9IGVsc2Ugew0KICAgICAgICAgIGNsYXVkZVN0YXR1cyA9ICdvayc7IC8vIOyEseqztSA9IOyEpOy5mMK366Gc6re47J24IOuLpCDsoJXsg4Eg4oCUIOyWtOuWpCBwcm9ibGVt7J2065OgIO2VtOygnCAo7J6s66Gc6re47J24L+yerOyEpOy5mCDrs7Xqt4ApDQogICAgICAgICAgdy5yZXNvbHZlKFN0cmluZyhldi5yZXN1bHQgfHwgJycpKTsNCiAgICAgICAgfQ0KICAgICAgfQ0KICAgIH0NCiAgfSk7DQogIHByb2Muc3RkZXJyLm9uKCdkYXRhJywgKGQpID0+IHsNCiAgICBjb25zdCBzID0gZC50b1N0cmluZygndXRmOCcpLnRyaW0oKTsNCiAgICBpZiAocyAmJiAhcy5pbmNsdWRlcygnRGVwcmVjYXRpb25XYXJuaW5nJykpIGNvbnNvbGUubG9nKCdbYnJpZGdlXSBjbGF1ZGUgc3RkZXJyOicsIHMuc2xpY2UoMCwgMjAwKSk7DQogIH0pOw0KICBwcm9jLm9uKCdjbG9zZScsIChjb2RlKSA9PiB7DQogICAgLy8g7J2066+4IOyDiCDshLjshZjsnLzroZwg6rWQ7LK065CcIOuSpCDsmJsg7IS47IWY7J20IOuLq+2ejCDqsbDrqbQg66y07IucICjrqqjrjbgg7KCE7ZmYIOyLnCDsg4gg7IS47IWY7J2EIOyjveydtOyngCDslYrqsowpDQogICAgaWYgKHByb2MgIT09IHRoaXNQcm9jKSByZXR1cm47DQogICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIO2BtOuhnOuTnCDshLjshZgg7KKF66OMIChjb2RlICcgKyBjb2RlICsgJykg4oCUIOuLpOydjCDsmpTssq0g65WMIOuLpOyLnCDsi5zrj5ntlanri4jri6QuJyk7DQogICAga2lsbFByb2MoKTsNCiAgfSk7DQp9DQoNCmZ1bmN0aW9uIHNlbmRUdXJuKHRleHQpIHsNCiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsNCiAgICBpZiAoIXByb2MpIHJldHVybiByZWplY3QobmV3IEVycm9yKCftgbTroZzrk5wg7IS47IWY7J20IOyXhuyWtOyalC4nKSk7DQogICAgaWYgKHdhaXRlcikgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoJ+yVnuyEoCDsmpTssq3snbQg7KeE7ZaJIOykkeydtOyXkOyalC4nKSk7DQogICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsNCiAgICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDthLQg7Iuc6rCEIOy0iOqzvCDigJQg7IS47IWY7J2EIOyerOyLnOyeke2VqeuLiOuLpC4nKTsNCiAgICAgIC8vIOyLnOqwhCDstIjqs7zripQgJ+yEuOyFmCDsooXro4wn7JmAIOq1rOu2hOuQmOuKlCDsoJwg66mU7Iuc7KeA66GcIOuBneuCuOuLpCDigJQga2lsbFByb2PsnZgg7IS47IWYIOyiheujjCByZWplY3TqsIANCiAgICAgIC8vIHJ1blR1cm7snZgg7J6Q64+ZIOyerOyLnOuPhOulvCDrtoDrpbTrqbQg7JWIIOuQmOq4sCDrlYzrrLgo64qQ66awIO2EtOydhCDrkZAg67KIIOuPjOuptCDtlIzrn6zqt7jsnbggMTMw7LSIIOygnO2VnOydhCDrhJjquLTri6QpDQogICAgICBpZiAod2FpdGVyKSB7DQogICAgICAgIGNvbnN0IHcgPSB3YWl0ZXI7IHdhaXRlciA9IG51bGw7DQogICAgICAgIHcucmVqZWN0KG5ldyBFcnJvcign7YG066Gc65OcIOydkeuLteydtCDrhIjrrLQg7Jik656YIOqxuOugpCDsmpTssq3snYQg7KSR64uo7ZaI7Ja07JqUIOKAlCDri6Tsi5wg7Iuc64+E7ZW0IOyjvOyEuOyalC4nKSk7DQogICAgICB9DQogICAgICBraWxsUHJvYygpOw0KICAgIH0sIFRVUk5fVElNRU9VVF9NUyk7DQogICAgd2FpdGVyID0geyByZXNvbHZlLCByZWplY3QsIHRpbWVyIH07DQogICAgcHJvYy5zdGRpbi53cml0ZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICd1c2VyJywgbWVzc2FnZTogeyByb2xlOiAndXNlcicsIGNvbnRlbnQ6IHRleHQgfSB9KSArICdcbicsICd1dGY4Jyk7DQogIH0pOw0KfQ0KDQovLyDqsJnsnYAg66y46rWs66W8IOuqhyDrsojsp7gg66y764qU7KeAIOq4sOyWtSDigJQg7J6s7JqU7LKt7J2066m0ICLsnbTsoITqs7wg64uk66W4IOyDiCDsoJzslYgi7J2EIOyalOq1rO2VnOuLpA0KLy8gKOyViCDqt7jrn6zrqbQg7YG066Gc65Oc6rCAIOyEseyLpO2VmOqyjCDqsJnsnYAg64u17J2EIOuYkCDrgrTshJwgW0FJIOy2lOyynCDrjZQg67Cb6riwXeqwgCDrrLTsnZjrr7jtlbTsp4Tri6QpDQpjb25zdCBhc2tlZENvdW50ID0gbmV3IE1hcCgpOw0KDQovLyDshLjshZgg7KSA67mEKOyLnOuPmSvsp4Dsi5zrrLgg7KO87J6FKeulvCDrs7TsnqXtlZwg65KkIO2VnCDthLQg7Iuk7ZaJIOKAlCDrqqjrk6Ag7Zi47Lac7J2AIHF1ZXVl66GcIOyngeugrO2ZlC4NCi8vIG1vZGVs7J2EIOyjvOuptCDqt7gg66qo642466GcICjri6TrpbTrqbQg7IS47IWYIOyerOyLnOyekSkuIO2VnCDrqqjrjbjsnYQg6rOE7IaNIOyTsOuptCDsnqzsi5zsnpHsnYAg7LWc7LSIIDHtmozrv5AuDQovLyByZXBhcnNlPXtwYXJzZSwgZm9ybWF0RGVzY33rpbwg7KO866m0IO2MjOyLseq5jOyngCDsnbQg7J6hIOyViOyXkOyEnCDsspjrpqztlZjqs6Age3JhdywgcGFyc2VkfeulvCDrj4zroKTspIDri6Q6DQovLyDtmJXsi50g7J207YOIIOyLnCDqsJnsnYAg7IS47IWY7JeQICLtmJXsi53rjIDroZwg64uk7IucIuulvCDsmpTqtaztlZjripQg7J6s7JqU7LKtIO2EtOydhCAqKuqwmeydgCDtgZAg7J6hIOyViOyXkOyEnCoqIOu2meyduOuLpC4NCi8vIOuzhOuPhCDsnqHsnLzroZwg67m866m0IChhKSDsgqzsnbTsl5Ag64uk66W4IOyalOyyrSDthLTsnbQg64G87Ja0ICfrsKnquIgg64u1J+ydtCDrgqjsnZgg64u17J20IOuQmOqzoCjrgrTsmqkg7Jik7Je8KSwNCi8vIChiKSBNQVhfVFVSTlMg6rK96rOE7JeQ7IScIOyEuOyFmOydtCDsnqzsi5zsnpHrj7wgJ+uwqeq4iCDri7Un7J20IOyXhuuKlCDsg4gg7IS47IWY7J20IOuCtOyaqeydhCDsp4DslrTrgrwg7IiYIOyeiOuLpCAoMjAyNi0wNyDrpqzrt7Dsl5DshJwg7ZmV7J24KS4NCmNvbnN0IFJFUEFSU0VfQkFEID0gKHYpID0+IHYgPT0gbnVsbCB8fCAoQXJyYXkuaXNBcnJheSh2KSAmJiB2Lmxlbmd0aCA9PT0gMCk7DQpmdW5jdGlvbiBydW5UdXJuKGJ1aWxkQXNrLCBtb2RlbCwgcmVwYXJzZSkgew0KICBjb25zdCBqb2IgPSBxdWV1ZS50aGVuKGFzeW5jICgpID0+IHsNCiAgICBjb25zdCBqb2JTdGFydCA9IERhdGUubm93KCk7IC8vIOyLnOqwhCDsmIjsgrAg4oCUIO2UjOufrOq3uOyduCDsqr0g7KCc7ZWcKDEzMOy0iCnsnYQg64SY6ri4IOyerOyLnOuPhOuKlCDtj6zquLDtlZzri6QNCiAgICBpZiAobW9kZWwgJiYgQUxMT1dFRF9NT0RFTFMuaW5kZXhPZihtb2RlbCkgIT09IC0xICYmIG1vZGVsICE9PSBjdXJyZW50TW9kZWwpIHsNCiAgICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDrqqjrjbgg67OA6rK9OiAnICsgY3VycmVudE1vZGVsICsgJyDihpIgJyArIG1vZGVsKTsNCiAgICAgIGN1cnJlbnRNb2RlbCA9IG1vZGVsOw0KICAgICAgc3RhcnRQcm9jKCk7IC8vIOyDiCDrqqjrjbjroZwg7IS47IWYIOyerOyLnOyekSAo64uk7J2MIOybjOuwjeyXheyXkOyEnCDsp4Dsi5zrrLgg7J6s7KO87J6FKQ0KICAgIH0NCiAgICBpZiAodHVybnMgPj0gTUFYX1RVUk5TIHx8ICFwcm9jKSBzdGFydFByb2MoKTsNCiAgICBpZiAoIXdhcm1lZFVwKSB7DQogICAgICBjb25zdCB0MCA9IERhdGUubm93KCk7DQogICAgICBhd2FpdCBzZW5kVHVybihpbnN0cnVjdGlvbk1lc3NhZ2UoKSk7DQogICAgICB3YXJtZWRVcCA9IHRydWU7DQogICAgICB0dXJucysrOw0KICAgICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIOyEuOyFmCDspIDruYQg7JmE66OMICgnICsgKChEYXRlLm5vdygpIC0gdDApIC8gMTAwMCkudG9GaXhlZCgxKSArICdzKSDigJQg7J207ZuEIOyalOyyreydgCDruajrnbzsmpQuJyk7DQogICAgfQ0KICAgIHR1cm5zKys7DQogICAgY29uc3QgYXNrID0gYnVpbGRBc2soKTsgLy8g7J6s7Iuc64+EIOuVjCDqsJnsnYAg7KeI66y47J2EIOuLpOyLnCDsk7Tri6QgKGFza2VkQ291bnQg7J207KSRIOymneqwgCDrsKnsp4ApDQogICAgbGV0IHJhdzsNCiAgICB0cnkgew0KICAgICAgcmF3ID0gYXdhaXQgc2VuZFR1cm4oYXNrKTsNCiAgICB9IGNhdGNoIChlKSB7DQogICAgICAvLyDthLQg64+E7KSRIO2BtOuhnOuTnCDtlITroZzshLjsiqTqsIAg7KO97J2AIOqyveyasChTRVNTSU9OX0RJRUQpIDHtmowg7J6Q64+ZIOyerOyLnOuPhCDigJQg7IKs7Jqp7J6Q7JeQ6rKQIOyLpO2MqOuhnCDslYgg67O07J206rKMLg0KICAgICAgLy8g7Iuc6rCEIOy0iOqzvMK366Gc6re47J24IOunjOujjMK37YG066Gc65OcIOyYpOulmMK37J2Y64+E7KCBIOyiheujjCjqs4TsoJUg7KCE7ZmYL+uhnOq3uOyVhOybgywga2lsbFByb2MocmVhc29uKSnripQNCiAgICAgIC8vIOygnCDrqZTsi5zsp4DqsIAg65Sw66GcIOyeiOyWtCDsl6zquLAg7JWIIOqxuOumsOuLpC4g7KKF66OMIOyalOyyrSDspJHsnbTqsbDrgpgg7Iuc6rCEIOyYiOyCsOydtCDslrzrp4gg7JWIIOuCqOyVmOycvOuptCDrkJjsgrTrpqzsp4Ag7JWK64qU64ukLg0KICAgICAgaWYgKHNodXR0aW5nRG93biB8fCAhKGUgJiYgZS5tZXNzYWdlID09PSBTRVNTSU9OX0RJRUQpIHx8IERhdGUubm93KCkgLSBqb2JTdGFydCA+IDQwMDAwKSB0aHJvdyBlOw0KICAgICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIOyEuOyFmOydtCDthLQg64+E7KSRIOuBiuq5gCDigJQg7J6s7Iuc64+ZIO2bhCAx7ZqMIOyerOyLnOuPhO2VqeuLiOuLpC4nKTsNCiAgICAgIHN0YXJ0UHJvYygpOw0KICAgICAgYXdhaXQgc2VuZFR1cm4oaW5zdHJ1Y3Rpb25NZXNzYWdlKCkpOw0KICAgICAgd2FybWVkVXAgPSB0cnVlOw0KICAgICAgdHVybnMgPSAyOyAvLyDsm4zrsI3sl4UgMSArIOydtOuyiCDthLQgKHN0YXJ0UHJvY+ydtCAw7Jy866GcIOy0iOq4sO2ZlCkNCiAgICAgIHJhdyA9IGF3YWl0IHNlbmRUdXJuKGFzayk7DQogICAgfQ0KICAgIGlmICghcmVwYXJzZSkgcmV0dXJuIHJhdzsNCiAgICBsZXQgcGFyc2VkID0gcmVwYXJzZS5wYXJzZShyYXcpOw0KICAgIC8vIO2YleyLnSDsnbTtg4jsnbTrqbQg6rCZ7J2AIOyEuOyFmMK36rCZ7J2AIOyeoeyXkOyEnCDqs6fsnqUg7J6s7JqU7LKtIOKAlCDsnbQg7YS07J20IOyjveycvOuptCDsg4gg7IS47IWY7J2AICfrsKnquIgg64u1J+ydhCDrqrDrnbwNCiAgICAvLyDsp4DslrTrgrwg7IiYIOyeiOycvOuvgOuhnCDshLjshZgg7IKs66edIOyerOyLnOuPhOuKlCDtlZjsp4Ag7JWK6rOgIOq3uOuMgOuhnCDsi6TtjKjsi5ztgqjri6Qo7YyM7IuxIOyLpO2MqOuhnCDqt4DqsrApLg0KICAgIGlmIChSRVBBUlNFX0JBRChwYXJzZWQpICYmIERhdGUubm93KCkgLSBqb2JTdGFydCA8IDcwMDAwKSB7DQogICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g7YyM7IuxIOyLpO2MqCDigJQg7ZiV7IudIOyerOyalOyyrTonLCBTdHJpbmcocmF3KS5zbGljZSgwLCAzMDApKTsNCiAgICAgIHR1cm5zKys7DQogICAgICB0cnkgew0KICAgICAgICByYXcgPSBhd2FpdCBzZW5kVHVybign67Cp6riIIOuLteydtCDsmpTqtaztlZwg7ZiV7Iud7JeQIOyWtOq4i+uCrOuLpC4g67Cp6riIIOuLte2VnCDrgrTsmqnsnYQg7ISk66qFwrfsgqzqs7zCt+y9lOuTnO2OnOyKpCDsl4bsnbQg7JWE656YIEpTT07snLzroZzrp4wg64uk7IucIOy2nOugpe2VmOudvDogJyArIHJlcGFyc2UuZm9ybWF0RGVzYyk7DQogICAgICAgIHBhcnNlZCA9IHJlcGFyc2UucGFyc2UocmF3KTsNCiAgICAgIH0gY2F0Y2ggKF9lKSB7IC8qIOyerOyalOyyrSDsi6TtjKgg4oCUIOyVhOuemOyXkOyEnCDtjIzsi7Eg7Iuk7Yyo66GcIOyymOumrCAqLyB9DQogICAgfQ0KICAgIGlmIChSRVBBUlNFX0JBRChwYXJzZWQpKSBjb25zb2xlLmxvZygnW2JyaWRnZV0g7YyM7IuxIOyLpO2MqCAo7J6s7JqU7LKtIO2bhOyXkOuPhCk6JywgU3RyaW5nKHJhdykuc2xpY2UoMCwgMzAwKSk7DQogICAgcmV0dXJuIHsgcmF3LCBwYXJzZWQ6IFJFUEFSU0VfQkFEKHBhcnNlZCkgPyBudWxsIDogcGFyc2VkIH07DQogIH0pOw0KICAvLyDtlZwg7JqU7LKt7J20IOyLpO2MqO2VtOuPhCDri6TsnYwg7JqU7LKt7J20IOydtOyWtOyngOuPhOuhnSDtgZDripQg7ZWt7IOBIOyEseqzteycvOuhnCDsoJXrpqwNCiAgcXVldWUgPSBqb2IuY2F0Y2goKCkgPT4ge30pOw0KICByZXR1cm4gam9iOw0KfQ0KDQovLyDrsoTtirwg652867KoIOq3nOy5mSDigJQg7ZSM65+s6re47J247J20ICfrsoTtirzsnYQg6rOo656Q64ukJ+qzoCDslYzroKTspIQg65WM66eMIOyWueuKlOuLpC4NCi8vIOuyhO2KvCDrrLjqtazripQg66y47J6l7J20IOyVhOuLiOudvCDrj5nsnpEg7J2066aE7J207Ja07IScLCDsnbQg7KeA7Iuc6rCAIOyXhuycvOuptCDrrLjsnqXtmJUg64yA7JWI7J20IOyEnuyXrCDrgpjsmKjri6QuDQpjb25zdCBCVVRUT05fUlVMRSA9DQogICfsnbQg66y46rWs64qUICoq67KE7Yq8IOudvOuyqCoq7J2064ukLiDrrLjsnqXsnbQg7JWE64uI6528IOuPmeyekSDsnbTrpoTsnbTrr4DroZw6IOuniOy5qO2RnMK366y87J2M7ZGcwrfsooXqsrDslrTrr7gofuyalC9+64ukL37quYzsmpQpIOq4iOyngCwgJyArDQogICfrkJjrj4TroZ0g7Ken7J2AIOuPmeyekSDrqoXsgqwo7KCA7J6lwrfsgq3soJzCt+yXsOqysCDtlbTsoJwg65OxKeuhnCwg7Ya167O07ISxIOuLqOydvCDrsoTtirzsnbTrqbQgIu2ZleyduCIuICcgKw0KICAnIuy3qOyGjCLripQg64+Z7J6RIOuyhO2KvOqzvCDsp53snbwg65WM66eMIOyTsOqzoCwg7ZmU66m0IOq4sOuKpeuqhSjrs4Dqsr3Ct+2VtOygnCDrk7Ep7J2AIOq3uOuMgOuhnCDrkZTri6QuXG4nOw0KDQovLyDrrLjqtawg7LaU7LKcIO2EtCAocm9sZT0n67KE7Yq8J+ydtOuptCDrsoTtirwg6rec7LmZ7J2EIOyWueuKlOuLpCkNCmZ1bmN0aW9uIGFza0NsYXVkZSh0ZXh0LCBtb2RlbCwgcmVwYXJzZSwgcm9sZSkgew0KICByZXR1cm4gcnVuVHVybigoKSA9PiB7DQogICAgY29uc3QgYXR0ZW1wdCA9IChhc2tlZENvdW50LmdldCh0ZXh0KSB8fCAwKSArIDE7DQogICAgYXNrZWRDb3VudC5zZXQodGV4dCwgYXR0ZW1wdCk7DQogICAgaWYgKGFza2VkQ291bnQuc2l6ZSA+IDIwMCkgYXNrZWRDb3VudC5jbGVhcigpOyAvLyDrrLTtlZztnogg7IyT7J207KeAIOyViuqyjA0KICAgIGNvbnN0IHJ1bGUgPSByb2xlID09PSAn67KE7Yq8JyA/IEJVVFRPTl9SVUxFIDogJyc7DQogICAgcmV0dXJuIHJ1bGUgKyAoYXR0ZW1wdCA+IDENCiAgICAgID8gJ+qwmeydgCDrrLjqtazrpbwg64uk7IucIOyalOyyre2VnOuLpC4g7J20IOyEuOyFmOyXkOyEnCDsnbTsoITsl5Ag7KCc7JWI7ZaI642YIOqyg+uTpOqzvCDqsrnsuZjsp4Ag7JWK64qULCDqtazsobDrgpgg7Ja07ZyY6rCAIO2ZleyLpO2eiCDri6Trpbgg7IOI66Gc7Jq0IOuMgOyViCAz6rCc66W8IOq3nOy5meuMgOuhnCBKU09OIOuwsOyXtOuhnOunjDogJyArIEpTT04uc3RyaW5naWZ5KHRleHQpDQogICAgICA6ICfri6TsnYwgVUkg66y46rWs7J2YIOuMgOyViCAz6rCc66W8IOq3nOy5meuMgOuhnCBKU09OIOuwsOyXtOuhnOunjDogJyArIEpTT04uc3RyaW5naWZ5KHRleHQpKTsNCiAgfSwgbW9kZWwsIHJlcGFyc2UpOw0KfQ0KDQovLyDrsojsl60g7YS0IOKAlCDqsJnsnYAg7IS47IWY7J2EIOyTsOuQmCwg7J2067KIIO2EtOunjCDstpTsspwg7ZiV7IudKEpTT04g67Cw7Je0KSDrjIDsi6Ag67KI7JetIO2YleyLnShKU09OIOqwneyytCnsnYQg7JqU6rWs7ZWc64ukDQpmdW5jdGlvbiBhc2tUcmFuc2xhdGUodGV4dCwgbW9kZWwsIHJlcGFyc2UpIHsNCiAgcmV0dXJuIHJ1blR1cm4oKCkgPT4gKA0KICAgICfsnbTrsogg7JqU7LKt7J2AIOuyiOyXrSDsnpHsl4XsnbTri6QgKOusuOq1rCDri6Trk6zquLAg7JWE64uYIOKAlCDrjIDslYggM+qwnCDqt5zsuZnsnYAg7J2067KIIO2EtOyXkCDsoIHsmqntlZjsp4Ag7JWK64qU64ukKS4gJyArDQogICAgJ+uLpOydjCBVSSDrrLjqtazqsIAg7ZWc6rWt7Ja066m0IOyekOyXsOyKpOufrOyatCDsmIHslrTroZwsIOyYgeyWtOuptCDsnpDsl7DsiqTrn6zsmrQg7ZWc6rWt7Ja066GcIOuyiOyXre2VmOudvC4gJyArDQogICAgJ1VJIOusuOq1rOuLpOyatCDqsITqsrDtlZwg7ZGc7ZiE7J2EIOyTsOqzoCwg7J2066aEwrfsiKvsnpDCt+uniOyKpO2CucK37ZSM66CI7J207Iqk7ZmA642U64qUIOq3uOuMgOuhnCDrs7TsobTtlZzri6QuICcgKw0KICAgICfsm5DrrLjsnZgg7KSEIOyImOulvCDqt7jrjIDroZwg7Jyg7KeA7ZWc64ukIOKAlCDsm5DrrLjsnbQg7ZWcIOykhOydtOuptCDrsojsl63rj4Qg7ZWcIOykhOuhnCwg7KSE67CU6r+I7J2EIOyehOydmOuhnCDstpTqsIDtlZjsp4Ag7JWK64qU64ukLiAnICsNCiAgICAn64u17J2AIOuwmOuTnOyLnCBKU09OIOqwneyytCDtlZjrgpjrp4wg7Lac66Cl7ZWc64ukLiDrp4jtgazri6TsmrTCt+yEpOuqhSDquIjsp4A6ICcgKw0KICAgICd7InRyYW5zbGF0ZWQiOiAi67KI7Jet66y4ICjspITrsJTqv4jsnYAgXFxuKSIsICJkaXJlY3Rpb24iOiAia2/ihpJlbiDrmJDripQgZW7ihpJrbyJ9OiAnICsgSlNPTi5zdHJpbmdpZnkodGV4dCkNCiAgKSwgbW9kZWwsIHJlcGFyc2UpOw0KfQ0KDQovLyDrjIDtmZTtmJUg66y46rWsIOygnOyekSDthLQg4oCUIOyCrOyaqeyekOqwgCDsg4HtmansnYQg7ISk66qF7ZWY66m0IOunpeudveyXkCDrp57ripQg66y46rWs66W8IOunjOuTpOyWtOykgOuLpC4NCi8vIG1lc3NhZ2VzOiBbe3JvbGU6J3VzZXInfCdhc3Npc3RhbnQnLCB0ZXh0fV0g7KCE7LK0IOuMgO2ZlOulvCDrp6Trsogg67Cb64qU64ukKOuLpOumrOuKlCDrrLTsg4Htg5wg4oCUDQovLyDsm4zrsI3sl4Ug7KeA7Iuc66y47J2YICLsmpTssq3rk6TsnYAg7ISc66GcIOustOq0gCIg7KCE7KCc66W8IOyngO2CpOq4sCDsnITtlbQg64yA7ZmUIOunpeudveydhCDthLQg7JWI7JeQIOuqveuVhSDsi6PripTri6QpLg0KZnVuY3Rpb24gYXNrQ29tcG9zZShtZXNzYWdlcywgbW9kZWwsIHJlcGFyc2UpIHsNCiAgcmV0dXJuIHJ1blR1cm4oKCkgPT4gew0KICAgIGNvbnN0IHRyYW5zY3JpcHQgPSAobWVzc2FnZXMgfHwgW10pLm1hcCgobSkgPT4NCiAgICAgIChtLnJvbGUgPT09ICdhc3Npc3RhbnQnID8gJ+yWtOyLnOyKpO2EtO2KuDogJyA6ICfsgqzsmqnsnpA6ICcpICsgU3RyaW5nKG0udGV4dCB8fCAnJykuc2xpY2UoMCwgMTUwMCkNCiAgICApLmpvaW4oJ1xuJyk7DQogICAgcmV0dXJuICgNCiAgICAgICfsnbTrsogg7JqU7LKt7J2AICLrjIDtmZTtmJUg66y46rWsIOygnOyekSLsnbTri6QgKOq4sOyhtCDrrLjqtawg64uk65Os6riwIOyVhOuLmCDigJQg7JWE656YIOuMgO2ZlOqwgCDsnbTrsogg7YS07J2YIOyghOyytCDrp6Xrnb3snbTri6QpLiAnICsNCiAgICAgICfsgqzsmqnsnpDqsIAg7ZmU66m0IOyDge2ZqcK366el65297J2EIOyEpOuqhe2VmOuptCwg7Iqk7YOA7J28IOq3nOy5meqzvCDsmIjsi5wg7Yak7JeQIOunnuuKlCBVSSDrrLjqtazrpbwg66eM65Ok7Ja0IOygnOyViO2VmOudvC5cbicgKw0KICAgICAgJy0g66el65297J20IOu2gOyhse2VmOuptCDtjrjtlZjqsowg65CY66y87Ja06528OiDslrTrlqQg7ZmU66m0wrfquLDriqXsnZgg66y46rWs7J247KeALCDrk6TslrTqsIgg7J6Q66as64qUIOyWtOuUlOyduOyngCjtjJ3sl4Ug7YOA7J207YuAL+uzuOusuC/rsoTtirwsIO2GoOyKpO2KuCwg67mIIO2ZlOuptCDslYjrgrQsIOuwsOuEiCDrk7EpLCDslrTrlqQg7IOB7Zmp7J247KeAKOyEseqztSDthrXrs7Qv7Jik66WYL+2ZleyduCDsmpTssq0v7JWI64K0KSDqsJnsnYAg6rKDLiDqvK0g7ZWE7JqU7ZWcIOqyg+unjCDqs6jrnbwg7ZWcIOuyiOyXkCDstZzrjIAgMuqwnOq5jOyngCwg7Ken6rKMLiDsnbTrlYwgc3VnZ2VzdGlvbnPripQg67mIIOuwsOyXtC5cbicgKw0KICAgICAgJy0g6rCQ7J20IOyWtOuKkCDsoJXrj4Qg7Jik66m0IOusu+q4sOunjCDtlZjsp4Ag66eI6528IOKAlCDqsIDsoJXsnYQg7IS47Jqw6rOgIOy0iOyViCBzdWdnZXN0aW9uc+ulvCDtlajqu5gg64K066m07IScLCByZXBseeyXkCDqsIDsoJXsnYQg67Cd7Z6I6rOgIOustOyXh+ydhCDslYzroKTso7zrqbQg642UIOunnuy2nCDsiJgg7J6I64qU7KeAIO2VnCDrrLjsnqXsnLzroZwg642n67aZ7Jes6528KOyYiDogIu2ZleyduCDtjJ3sl4XsnbTrnbzqs6Ag6rCA7KCV7ZaI7Ja07JqUIOKAlCDthqDsiqTtirjrnbzrqbQg7JWM66Ck7KO87IS47JqUIikuXG4nICsNCiAgICAgICctIOusuOq1rOulvCDsoJzslYjtlaAg65WQIOyEnOuhnCDsoJHqt7zsnbQg64uk66W4IDJ+M+qwnC4g6rCBIOygnOyViOyXlCDsmZwg6re466CH6rKMIOyNvOuKlOyngCDsnbTsnKDrpbwg67aZ7J2464ukLlxuJyArDQogICAgICAnLSDsgqzsmqnsnpDqsIAg7Ja46riJ7ZWY7KeAIOyViuydgCDqtazssrQg7KCV67O0KOyghO2ZlOuyiO2YuMK3VVJMwrfquIjslaHCt+2an+yImCDrk7Ep66W8IOyngOyWtOuCtCDrhKPsp4Ag66eI6528LlxuJyArDQogICAgICAnLSDtm4Tsho0g7JqU7LKtKCLrjZQg7Ken6rKMIiwgIuuyhO2KvOyaqeycvOuhnCIg65OxKeydtOuptCDsp4HsoIQg7KCc7JWI7J2EIOq3uCDrsKntlqXsnLzroZwg6rOg7LOQIOuLpOyLnCDsoJzslYjtlZjrnbwuXG4nICsNCiAgICAgICfri7XsnYAg67CY65Oc7IucIEpTT04g6rCd7LK0IO2VmOuCmOunjCDstpzroKXtlZzri6QuIOuniO2BrOuLpOyatMK37ISk66qFIOq4iOyngDogJyArDQogICAgICAneyJyZXBseSI6ICLrjIDtmZQg7J2R64u1IO2VnOuRkCDrrLjsnqUgKO2VtOyalOyytCkiLCAic3VnZ2VzdGlvbnMiOiBbeyJ0ZXh0IjogIuusuOq1rCAo7KSE67CU6r+I7J2AIFxcbikiLCAicmVhc29uIjogIuydtOycoCDtlZwg66y47J6lIn1dfVxuXG4nICsNCiAgICAgICdb64yA7ZmUXVxuJyArIHRyYW5zY3JpcHQNCiAgICApOw0KICB9LCBtb2RlbCwgcmVwYXJzZSk7DQp9DQoNCi8vIO2UhOugiOyehOuzhCjtlZjsnIQg7ZSE66CI7J6EIOustuydjCkg7LaU7LKcIO2EtCDigJQg7ZWcIO2ZlOuptOydhCDtlZjsnIQg7ZSE66CI7J6EIOuLqOychOuhnCDrgpjriKAg67O064K06rOgLA0KLy8gKirtlITroIjsnoTrp4jri6Qg65Sw66GcKiog64yA7JWI7J2EIOuwm+uKlOuLpC4g7ZWcIOyalOyyreyXkCDri6Qg7Iuk7Ja0IOuztOuCtOuKlCDqsoPsnbQg7ZW17IusOg0KLy8g7ZSE66CI7J6EIOyImOunjO2BvCDsmpTssq3snYQg7Kq86rCc66m0IOq3uOunjO2BvCDripDroKTsp4Dqs6Ao6rCBIDV+MTDstIgpIOq1rOuPhSDsgqzsmqnrn4nrj4Qg6re466eM7YG8IOuCmOqwhOuLpC4NCi8vIGdyb3VwczogW3tuYW1lLCB0ZXh0czpbXX1dICjtmZTrqbQg7JyE4oaS7JWE656YIOyInCkuDQpmdW5jdGlvbiBhc2tHcm91cHMoZ3JvdXBzLCBtb2RlbCwgcmVwYXJzZSwgbW9yZSkgew0KICByZXR1cm4gcnVuVHVybigoKSA9PiB7DQogICAgLy8g67KE7Yq8IOyYgeyXreydgCAo67KE7Yq8KeycvOuhnCDssI3slrQg67O064K464ukIOKAlCDrsoTtirwg66y46rWs64qUIOusuOyepeydtCDslYTri4jrnbwg64+Z7J6RIOydtOumhOydtOudvCDqt5zsuZnsnbQg64uk66W064ukDQogICAgY29uc3QgbGlzdCA9IChncm91cHMgfHwgW10pLm1hcCgoZywgaSkgPT4NCiAgICAgICdbJyArIChpICsgMSkgKyAnXSAnICsgU3RyaW5nKChnICYmIGcubmFtZSkgfHwgKCfqt7jro7knICsgKGkgKyAxKSkpICsgKGcgJiYgZy5yb2xlID09PSAn67KE7Yq8JyA/ICcgKOuyhO2KvCknIDogJycpICsgJ1xuJyArDQogICAgICAoZyAmJiBBcnJheS5pc0FycmF5KGcudGV4dHMpID8gZy50ZXh0cyA6IFtdKS5tYXAoKHQpID0+ICcgIC0gJyArIEpTT04uc3RyaW5naWZ5KFN0cmluZyh0IHx8ICcnKSkpLmpvaW4oJ1xuJykNCiAgICApLmpvaW4oJ1xuJyk7DQogICAgY29uc3QgaGFzQnRuID0gKGdyb3VwcyB8fCBbXSkuc29tZSgoZykgPT4gZyAmJiBnLnJvbGUgPT09ICfrsoTtirwnKTsNCiAgICBjb25zdCBrZXkgPSAnZ3JvdXBzJyArIChncm91cHMgfHwgW10pLm1hcCgoZykgPT4gKGcgJiYgZy50ZXh0cyA/IGcudGV4dHMuam9pbignJykgOiAnJykpLmpvaW4oJycpOw0KICAgIGNvbnN0IGF0dGVtcHQgPSAoYXNrZWRDb3VudC5nZXQoa2V5KSB8fCAwKSArIDE7DQogICAgYXNrZWRDb3VudC5zZXQoa2V5LCBhdHRlbXB0KTsNCiAgICBpZiAoYXNrZWRDb3VudC5zaXplID4gMjAwKSBhc2tlZENvdW50LmNsZWFyKCk7DQogICAgY29uc3QgYWdhaW4gPSBtb3JlIHx8IGF0dGVtcHQgPiAxDQogICAgICA/ICfsnbQg7ZmU66m07J2AIOydtCDshLjshZjsl5DshJwg7J2066+4IOuLpOukmOuLpC4g7JWe7IScIOuCuCDrjIDslYjqs7wg7Ja07ZyYwrfqtazsobDqsIAg7ZmV7Iuk7Z6IIOuLpOuluCDsg4gg64yA7JWI66eMIOuCtOudvC5cbicNCiAgICAgIDogJyc7DQogICAgcmV0dXJuICgNCiAgICAgIGFnYWluICsNCiAgICAgICfsnbTrsogg7JqU7LKt7J2AICLtmZTrqbTsnYQg7ZWY7JyEIO2UhOugiOyehOuzhOuhnCDrgpjriKAg64uk65Os6riwIuuLpC4g7JWE656Y64qUIO2VnCDtmZTrqbTsnZgg66y46rWs66W8IO2VmOychCDtlITroIjsnoQo7JiB7JetKSDri6jsnITroZwg66y27J2AIOqyg+ydtOuLpC5cbicgKw0KICAgICAgJyoq7JiB7Jet66eI64ukIOuUsOuhnCoqIOuMgOyViOydhCDrgrTrnbwg4oCUIOyYgeyXreydhCDshJzroZwg7ZWp7LmY6rGw64KYIOyInOyEnOulvCDrsJTqvrjsp4Ag66eI6528LlxuJyArDQogICAgICAnLSDqsIEg7JiB7Jet7JeQIOuMgOyViCAy6rCcLiDqt7gg7JiB7Jet7J20IOyXrOufrCDspITsnbTrqbQg64yA7JWI64+EICoq6rCZ7J2AIOykhCDsiJgqKuuhnCjspITrsJTqv4ggXFxu7Jy866GcIOq1rOu2hCwg7KSEIOyInOyEnCDsnKDsp4ApLlxuJyArDQogICAgICAnLSDsmIHsl63snZgg7Jet7ZWgKO2DgOydtO2LgMK37JWI64K0wrfrsoTtirwg65OxKeqzvCDsm5DrrLjsnZgg7KCV67O0wrfsobDqsbQo7Iir7J6QwrfrjIDsg4HCt+yhsOqxtCnsnYAg7Jyg7KeA7ZWY6rOgLCDsl4bripQg7KCV67O066W8IOyngOyWtOuCtOyngCDrp4jrnbwuXG4nICsNCiAgICAgICctIOqzoOy5oCDqsowg7JeG64qUIOyYgeyXreydtOuptCDrjIDslYggMeqwnOunjCDrgrTqsbDrgpgg67mIIOuwsOyXtOuhnCDrkZDslrTrj4Qg65Cc64ukIOKAlCDslrXsp4DroZwg67CU6r647KeAIOuniOudvC5cbicgKw0KICAgICAgJy0g7ZmU66m0IOq4sOuKpeuqhSjrs4Dqsr3Ct+2VtOygnCDrk7Ep7J2AIOq3uOuMgOuhnCDrkZTri6QuXG4nICsNCiAgICAgIChoYXNCdG4gPyAnLSAo67KE7Yq8KeycvOuhnCDtkZzsi5zrkJwg7JiB7Jet7J2AICcgKyBCVVRUT05fUlVMRSA6ICcnKSArDQogICAgICAn64u17J2AIOuwmOuTnOyLnCBKU09OIOqwneyytCDtlZjrgpjrp4wg7Lac66Cl7ZWc64ukLiDrp4jtgazri6TsmrTCt+yEpOuqhcK37L2U65Oc7Y6c7IqkIOq4iOyngDpcbicgKw0KICAgICAgJ3siZ3JvdXBzIjogW3sibmFtZSI6ICLsmIHsl60g7J2066aEKOyeheugpeqzvCDrj5nsnbwpIiwgInN1Z2dlc3Rpb25zIjogW3sidGV4dCI6ICLrjIDslYgg66y46rWsICjspITrsJTqv4jsnYAgXFxuKSIsICJyZWFzb24iOiAi7J207JygIO2VnCDrrLjsnqUifV19XX1cbicgKw0KICAgICAgJ+yYgeyXreydgCDsnoXroKUg7Iic7IScwrfqsJzsiJjrpbwg6re464yA66GcIOyngO2CqOuLpC5cblxuJyArDQogICAgICAnW+yYgeyXreuzhCDrrLjqtaxdXG4nICsgbGlzdA0KICAgICk7DQogIH0sIG1vZGVsLCByZXBhcnNlKTsNCn0NCg0KLy8g7ZSE66CI7J6E67OEIOy2lOyynCDsnZHri7Xsl5DshJwgW3tuYW1lLCBzdWdnZXN0aW9uczpbe3RleHQsIHJlYXNvbn1dfV0g7LaU7LacDQpmdW5jdGlvbiBwYXJzZUdyb3VwcyhyYXcpIHsNCiAgbGV0IHMgPSBTdHJpbmcocmF3KS50cmltKCkucmVwbGFjZSgvXmBgYCg/Ompzb24pP1xzKi9pLCAnJykucmVwbGFjZSgvXHMqYGBgJC9pLCAnJyk7DQogIGNvbnN0IG0gPSBzLm1hdGNoKC9ce1tcc1xTXSpcfS8pOw0KICBpZiAobSkgcyA9IG1bMF07DQogIHRyeSB7DQogICAgY29uc3QgbyA9IEpTT04ucGFyc2Uocyk7DQogICAgY29uc3QgYXJyID0gQXJyYXkuaXNBcnJheShvICYmIG8uZ3JvdXBzKSA/IG8uZ3JvdXBzIDogW107DQogICAgY29uc3QgZ3JvdXBzID0gYXJyLm1hcCgoZykgPT4gKHsNCiAgICAgIG5hbWU6IFN0cmluZygoZyAmJiBnLm5hbWUpIHx8ICcnKS50cmltKCksDQogICAgICBzdWdnZXN0aW9uczogQXJyYXkuaXNBcnJheShnICYmIGcuc3VnZ2VzdGlvbnMpDQogICAgICAgID8gZy5zdWdnZXN0aW9ucw0KICAgICAgICAgICAgLm1hcCgoeCkgPT4gKHR5cGVvZiB4ID09PSAnc3RyaW5nJw0KICAgICAgICAgICAgICA/IHsgdGV4dDogeC50cmltKCksIHJlYXNvbjogJycgfQ0KICAgICAgICAgICAgICA6IHsgdGV4dDogU3RyaW5nKCh4ICYmIHgudGV4dCkgfHwgJycpLnRyaW0oKSwgcmVhc29uOiBTdHJpbmcoKHggJiYgeC5yZWFzb24pIHx8ICcnKS50cmltKCkgfSkpDQogICAgICAgICAgICAuZmlsdGVyKCh4KSA9PiB4LnRleHQpDQogICAgICAgIDogW10sDQogICAgfSkpOw0KICAgIC8vIOydtOumhOyhsOywqCDsl4bqs6Ag7KCc7JWI64+EIOyXhuuKlCDqu43rjbDquLDrp4wg7JmU7Jy866m0IO2YleyLnSDsnbTtg4jroZwg67O464ukKOqwmeydgCDshLjshZjsl5Ag7J6s7JqU7LKtKQ0KICAgIHJldHVybiBncm91cHMuc29tZSgoZykgPT4gZy5zdWdnZXN0aW9ucy5sZW5ndGgpID8gZ3JvdXBzIDogbnVsbDsNCiAgfSBjYXRjaCAoX2UpIHsNCiAgICByZXR1cm4gbnVsbDsNCiAgfQ0KfQ0KDQovLyDtjJ3sl4Ug7IS47Yq4IOy2lOyynCDthLQg4oCUIO2VnCDtjJ3sl4XsnZgg6rWs7ISx7JqU7IaMKOyXre2VoCvrrLjqtawp66W8IO2VnCDrsojsl5Ag67O064K06rOgLA0KLy8g7JqU7IaM67OEIOuCseqwnOqwgCDslYTri4jrnbwgKirsmYTshLHrkJwg7Yyd7JeFIOyEuO2KuCjsvIDsnbTsiqQpIDJ+M+qwnCoq66W8IO2GteycvOuhnCDrsJvripTri6QuDQovLyDtg4DsnbTti4DCt+yViOuCtMK367KE7Yq87J20IO2VnCDrqrjsnLzroZwg7J286rSA64+87JW8IO2VmOuvgOuhnCjrlLDroZwg672R7JWEIOyhsO2Vqe2VmOuptCDslrTquIvrgpzri6QpIOyEuO2KuCDri6jsnITroZwg7KCc7JWI7ZWY6rKMIO2VnOuLpC4NCi8vIGVsZW1lbnRzOiBbe3JvbGUsIHRleHR9XSAo7ZmU66m0IOychOKGkuyVhOuemCDsiJwpLg0KLy8gbW9yZT10cnVlKFvsvIDsnbTsiqQg642UIOuwm+q4sF0p66m0IOydtCDshLjshZjsl5DshJwg7J2066+4IOuCuCDshLjtirjsmYAg6rK57LmY7KeAIOyViuuKlCDsg4gg7IS47Yq466W8IOyalOq1rO2VnOuLpC4NCmZ1bmN0aW9uIGFza1BvcHVwKGVsZW1lbnRzLCBtb2RlbCwgcmVwYXJzZSwgbW9yZSkgew0KICByZXR1cm4gcnVuVHVybigoKSA9PiB7DQogICAgY29uc3Qgcm9sZXMgPSAoZWxlbWVudHMgfHwgW10pLm1hcCgoZSkgPT4gU3RyaW5nKChlICYmIGUucm9sZSkgfHwgJycpKS5qb2luKCcsICcpOw0KICAgIGNvbnN0IGxpc3QgPSAoZWxlbWVudHMgfHwgW10pLm1hcCgoZSwgaSkgPT4NCiAgICAgIChpICsgMSkgKyAnLiBbJyArIFN0cmluZygoZSAmJiBlLnJvbGUpIHx8ICcnKSArICddICcgKyBKU09OLnN0cmluZ2lmeShTdHJpbmcoKGUgJiYgZS50ZXh0KSB8fCAnJykpDQogICAgKS5qb2luKCdcbicpOw0KICAgIC8vIOqwmeydgCDtjJ3sl4XsnYQg66qHIOuyiOynuCDrrLvripTsp4Ag6riw7Ja1IOKAlCDsnqzsmpTssq3snbTrqbQgIuydtOyghOqzvCDri6Trpbgg7IS47Yq4IuulvCDsmpTqtaztlZzri6QNCiAgICAvLyAoYXNrQ2xhdWRl7JmAIOqwmeydgCDsnbTsnKA6IOyViCDqt7jrn6zrqbQg7YG066Gc65Oc6rCAIOqwmeydgCDshLjtirjrpbwg65iQIOuCtOyEnCBb7LyA7J207IqkIOuNlCDrsJvquLBd6rCAIOustOydmOuvuO2VtOynhOuLpCkNCiAgICBjb25zdCBrZXkgPSAncG9wdXABJyArIChlbGVtZW50cyB8fCBbXSkubWFwKChlKSA9PiBTdHJpbmcoKGUgJiYgZS50ZXh0KSB8fCAnJykpLmpvaW4oJwEnKTsNCiAgICBjb25zdCBhdHRlbXB0ID0gKGFza2VkQ291bnQuZ2V0KGtleSkgfHwgMCkgKyAxOw0KICAgIGFza2VkQ291bnQuc2V0KGtleSwgYXR0ZW1wdCk7DQogICAgaWYgKGFza2VkQ291bnQuc2l6ZSA+IDIwMCkgYXNrZWRDb3VudC5jbGVhcigpOyAvLyDrrLTtlZztnogg7IyT7J207KeAIOyViuqyjA0KICAgIGNvbnN0IGFnYWluID0gbW9yZSB8fCBhdHRlbXB0ID4gMQ0KICAgICAgPyAn7J20IO2MneyXheydgCDsnbQg7IS47IWY7JeQ7IScIOydtOuvuCDri6TrpJjri6QuIOyVnuyEnCDsoJzslYjtlZwg7IS47Yq465Ok6rO8ICoq7KCR6re8wrfslrTtnJjqsIAg7ZmV7Iuk7Z6IIOuLpOuluCDsg4gg7IS47Yq4Kirrp4wg64K06528KOqwmeydgCDshLjtirgg67CY67O1IOq4iOyngCkuXG4nDQogICAgICA6ICcnOw0KICAgIHJldHVybiAoDQogICAgICBhZ2FpbiArDQogICAgICAn7J2067KIIOyalOyyreydgCAi7Yyd7JeFKOuLpOydtOyWvOuhnOq3uCkg7IS47Yq4IOuLpOuTrOq4sCLri6QuIOyVhOuemOuKlCDtlZwg7Yyd7JeF7J2EIOychOKGkuyVhOuemOuhnCDrgpjsl7TtlZwg6rWs7ISx7JqU7IaM65Ok7J2064ukKOyEnOuhnCDrrLTqtIDtlZwg67OE6rCcIOusuOq1rOqwgCDslYTri4jri6QpLiAnICsNCiAgICAgICfsmpTshozrpbwg64Kx6rCc66GcIOqzoOy5mOyngCDrp5Dqs6AsICoq7YOA7J207YuAwrfslYjrgrTCt+uyhO2KvOydtCDshJzroZwg7J286rSA65CcICLsmYTshLHrkJwg7Yyd7JeFIOyEuO2KuCIgMn4z6rCcKirrpbwg7KCc7JWI7ZWY6528LiDqsIEg7IS47Yq464qUIOyEnOuhnCDri6Trpbgg7KCR6re87J207Ja07JW8IO2VnOuLpC5cbicgKw0KICAgICAgJ+qwgSDshLjtirjripQg7J6F66Cl6rO8ICoq6rCZ7J2AIOyXre2VoMK36rCZ7J2AIOqwnOyImMK36rCZ7J2AIOyInOyEnCoq7J2YIOyalOyGjOulvCDrqqjrkZAg7Y+s7ZWo7ZWc64ukLiDshLjtirgg7JWI7JeQ7IScIO2DgOydtO2LgMK37JWI64K0wrfrsoTtirzsnYAg7ZWcIOuquOycvOuhnCDrp57slYTrlqjslrTsoLjslbwg7ZWc64ukKOyYiDog67O466y47J20ICJ+7ZWg6rmM7JqUPyLrqbQg67KE7Yq87J2AIFvslYTri4jsmKRdL1vrhKRdKS5cbicgKw0KICAgICAgJ1vtjJ3sl4Ug66y47LK0IOq3nOy5mSDigJQg7JyEIOyKpO2DgOydvCDqsIDsnbTrk5zsnZggIjguIO2MneyXhSIg7IS57IWY7J2EIOuUsOuluOuLpF1cbicgKw0KICAgICAgJy0g7YOA7J207YuAOiDsp6fsnYAg66qF7IKs6rWsKDJ+NOyWtOygiCksIOyiheqysOyWtOuvuMK366eI7Lmo7ZGcIOyXhuydtCh+7JqUL37ri6Qvfuq5jOyalD8g6riI7KeAKS4g67CY65Oc7IucIOyViOuCtCjrs7jrrLgpIOunpeudveydhCDsmpTslb3tlbQg7YOA7J207YuA66eMIOu0kOuPhCDrrLTsiqgg7Yyd7JeF7J247KeAIOyVjOqyjCDtlZjrnbwuIOybkOuzuOydtCAi7JWM66a8L+2ZleyduCLsspjrn7wg66eJ7Jew7ZWY66m0IOuzuOusuOydhCDqt7zqsbDroZwg6rWs7LK07ZmU7ZWY6528LlxuJyArDQogICAgICAnLSDslYjrgrQo67O466y4KTog7ZW07JqU7LK0LiDtjJDri6jsnbQg7ZWE7JqU7ZWY66m0ICJ+7ZWg6rmM7JqUPyLroZwg66y76rOgLCDrkJjrj4zrprQg7IiYIOyXhuuKlCDsnITtl5go7IKt7KCcwrftg4jth7Qg65OxKeydgCDqsrDqs7zrpbwg66i87KCAIOqyveqzoO2VnOuLpC4g6rKw6rO8wrfsg4Htg5wg7Ya167O066m0IOyEnOyIoO2YleycvOuhnCDslYzrprDri6QuXG4nICsNCiAgICAgICctIOuyhO2KvDog67O466y47J20ICJ+7ZWg6rmM7JqUPyLrqbQgW+yVhOuLiOyYpF0vW+uEpF0sIOuzuOusuOydtCDsg4HtmansnYQg7ISc7Iig7ZWY6rOgIOydtCDrsoTtirzsnbQg7Iuk7KCcIOuPmeyekeydtOuptCDrj5nsnpEg64+Z7IKsKOyCreygnC/soIDsnqUv7Jew6rKwIO2VtOygnCDrk7EpLCDthrXrs7Qg7Yyd7JeF7J2YIOuLqOydvCDrsoTtirzsnbTrqbQgIu2ZleyduCIuICLst6jshowi64qUIOuPmeyekSDrsoTtirzqs7wg7Ked7J28IOuVjOunjCwgIuuLq+q4sMK364+Z7J6RIiDsobDtlakg6riI7KeALiDtmZTrqbQg6riw64ql66qFKOuzgOqyvcK37ZW07KCcIOuTsSnsnYAg6re464yA66GcIOuRlOuLpC5cbicgKw0KICAgICAgJy0g7JuQ66y47J2YIOygleuztMK37KGw6rG0KOyIq+yekMK37J207IOBL+ydtO2VmMK364yA7IOBKeydgCDsnKDsp4DtlZjqs6AsIOybkOusuOyXkCDsl4bripQg7KCV67O0wrfsoIjssKjCt+yXsOudveyymOulvCDsp4DslrTrgrTsp4Ag66eI6528LlxuJyArDQogICAgICAn64u17J2AIOuwmOuTnOyLnCBKU09OIOqwneyytCDtlZjrgpjrp4wg7Lac66Cl7ZWc64ukLiDrp4jtgazri6TsmrTCt+yEpOuqhcK37L2U65Oc7Y6c7IqkIOq4iOyngDpcbicgKw0KICAgICAgJ3sic2V0cyI6IFt7InJlYXNvbiI6ICLsnbQg7IS47Yq47J2YIOuwqe2WpeydhCDtlZzqta3slrQg7ZWcIOusuOyepeycvOuhnCIsICJlbGVtZW50cyI6IFt7InJvbGUiOiAi7Jet7ZWgIiwgInRleHQiOiAi66y46rWsICjspITrsJTqv4jsnYAgXFxuKSJ9LCAuLi5dfSwgLi4uXX1cbicgKw0KICAgICAgJ+yXre2VoOydgCDsnoXroKUg7Iic7ISc64yA66GcOiAnICsgcm9sZXMgKyAnXG5cbicgKw0KICAgICAgJ1vtjJ3sl4Ug7JqU7IaMXVxuJyArIGxpc3QNCiAgICApOw0KICB9LCBtb2RlbCwgcmVwYXJzZSk7DQp9DQoNCi8vIO2MneyXhSDsnZHri7Xsl5DshJwge3NldHM6IFt7cmVhc29uLCBlbGVtZW50czpbe3JvbGUsdGV4dH1dfV19IOy2lOy2nCAo7L2U65Oc7Y6c7IqkwrfslZ7rkqQg7J6h64u0IO2XiOyaqSkNCmZ1bmN0aW9uIHBhcnNlUG9wdXAocmF3KSB7DQogIGxldCBzID0gU3RyaW5nKHJhdykudHJpbSgpLnJlcGxhY2UoL15gYGAoPzpqc29uKT9ccyovaSwgJycpLnJlcGxhY2UoL1xzKmBgYCQvaSwgJycpOw0KICBjb25zdCBtID0gcy5tYXRjaCgvXHtbXHNcU10qXH0vKTsNCiAgaWYgKG0pIHMgPSBtWzBdOw0KICB0cnkgew0KICAgIGNvbnN0IG8gPSBKU09OLnBhcnNlKHMpOw0KICAgIGNvbnN0IHNldHNJbiA9IEFycmF5LmlzQXJyYXkobyAmJiBvLnNldHMpID8gby5zZXRzIDogW107DQogICAgY29uc3Qgc2V0cyA9IHNldHNJbg0KICAgICAgLm1hcCgoc3QpID0+ICh7DQogICAgICAgIHJlYXNvbjogU3RyaW5nKChzdCAmJiBzdC5yZWFzb24pIHx8ICcnKS50cmltKCksDQogICAgICAgIGVsZW1lbnRzOiBBcnJheS5pc0FycmF5KHN0ICYmIHN0LmVsZW1lbnRzKQ0KICAgICAgICAgID8gc3QuZWxlbWVudHMNCiAgICAgICAgICAgICAgLm1hcCgoZWwpID0+ICh7IHJvbGU6IFN0cmluZygoZWwgJiYgZWwucm9sZSkgfHwgJycpLnRyaW0oKSwgdGV4dDogU3RyaW5nKChlbCAmJiBlbC50ZXh0KSB8fCAnJykudHJpbSgpIH0pKQ0KICAgICAgICAgICAgICAuZmlsdGVyKChlbCkgPT4gZWwudGV4dCkNCiAgICAgICAgICA6IFtdLA0KICAgICAgfSkpDQogICAgICAuZmlsdGVyKChzdCkgPT4gc3QuZWxlbWVudHMubGVuZ3RoKTsNCiAgICByZXR1cm4gc2V0cy5sZW5ndGggPyBzZXRzIDogbnVsbDsNCiAgfSBjYXRjaCAoX2UpIHsNCiAgICByZXR1cm4gbnVsbDsNCiAgfQ0KfQ0KDQovLyDrjIDtmZTtmJUg7KCc7J6RIOydkeuLteyXkOyEnCB7cmVwbHksIHN1Z2dlc3Rpb25zW119IOy2lOy2nCAo7L2U65Oc7Y6c7IqkwrfslZ7rkqQg7J6h64u0IO2XiOyaqSkNCmZ1bmN0aW9uIHBhcnNlQ29tcG9zZShyYXcpIHsNCiAgbGV0IHMgPSBTdHJpbmcocmF3KS50cmltKCkucmVwbGFjZSgvXmBgYCg/Ompzb24pP1xzKi9pLCAnJykucmVwbGFjZSgvXHMqYGBgJC9pLCAnJyk7DQogIGNvbnN0IG0gPSBzLm1hdGNoKC9ce1tcc1xTXSpcfS8pOw0KICBpZiAobSkgcyA9IG1bMF07DQogIHRyeSB7DQogICAgY29uc3QgbyA9IEpTT04ucGFyc2Uocyk7DQogICAgY29uc3QgcmVwbHkgPSBTdHJpbmcoKG8gJiYgby5yZXBseSkgfHwgJycpLnRyaW0oKTsNCiAgICBjb25zdCBzdWdnZXN0aW9ucyA9IEFycmF5LmlzQXJyYXkobyAmJiBvLnN1Z2dlc3Rpb25zKQ0KICAgICAgPyBvLnN1Z2dlc3Rpb25zDQogICAgICAgICAgLm1hcCgoeCkgPT4gKHsgdGV4dDogU3RyaW5nKCh4ICYmIHgudGV4dCkgfHwgJycpLnRyaW0oKSwgcmVhc29uOiBTdHJpbmcoKHggJiYgeC5yZWFzb24pIHx8ICcnKS50cmltKCkgfSkpDQogICAgICAgICAgLmZpbHRlcigoeCkgPT4geC50ZXh0KQ0KICAgICAgOiBbXTsNCiAgICBpZiAocmVwbHkgfHwgc3VnZ2VzdGlvbnMubGVuZ3RoKSByZXR1cm4geyByZXBseSwgc3VnZ2VzdGlvbnMgfTsNCiAgfSBjYXRjaCAoX2UpIHsgLyog7JWE656Y66GcICovIH0NCiAgcmV0dXJuIG51bGw7DQp9DQoNCi8vIOuyiOyXrSDsnZHri7Xsl5DshJwge3RyYW5zbGF0ZWQsIGRpcmVjdGlvbn0g7LaU7LacICjsvZTrk5ztjpzsiqTCt+yVnuuSpCDsnqHri7Qg7ZeI7JqpKQ0KZnVuY3Rpb24gcGFyc2VUcmFuc2xhdGUocmF3KSB7DQogIGxldCBzID0gU3RyaW5nKHJhdykudHJpbSgpLnJlcGxhY2UoL15gYGAoPzpqc29uKT9ccyovaSwgJycpLnJlcGxhY2UoL1xzKmBgYCQvaSwgJycpOw0KICBjb25zdCBtID0gcy5tYXRjaCgvXHtbXHNcU10qXH0vKTsNCiAgaWYgKG0pIHMgPSBtWzBdOw0KICB0cnkgew0KICAgIGNvbnN0IG8gPSBKU09OLnBhcnNlKHMpOw0KICAgIGNvbnN0IHRyYW5zbGF0ZWQgPSBTdHJpbmcoKG8gJiYgby50cmFuc2xhdGVkKSB8fCAnJykudHJpbSgpOw0KICAgIGlmICh0cmFuc2xhdGVkKSByZXR1cm4geyB0cmFuc2xhdGVkLCBkaXJlY3Rpb246IFN0cmluZygobyAmJiBvLmRpcmVjdGlvbikgfHwgJycpLnRyaW0oKSB9Ow0KICB9IGNhdGNoIChfZSkgeyAvKiDslYTrnpjroZwgKi8gfQ0KICByZXR1cm4gbnVsbDsNCn0NCg0KLy8g7J2R64u17JeQ7IScIHt0ZXh0LCByZWFzb259IOuwsOyXtCDstpTstpwgKOy9lOuTnO2OnOyKpMK37JWe65KkIOyeoeuLtCDtl4jsmqkpDQpmdW5jdGlvbiBwYXJzZVN1Z2dlc3Rpb25zKHJhdykgew0KICBsZXQgcyA9IFN0cmluZyhyYXcpLnRyaW0oKS5yZXBsYWNlKC9eYGBgKD86anNvbik/XHMqL2ksICcnKS5yZXBsYWNlKC9ccypgYGAkL2ksICcnKTsNCiAgY29uc3QgbSA9IHMubWF0Y2goL1xbW1xzXFNdKlxdLyk7DQogIGlmIChtKSBzID0gbVswXTsNCiAgdHJ5IHsNCiAgICBjb25zdCBhcnIgPSBKU09OLnBhcnNlKHMpOw0KICAgIGlmIChBcnJheS5pc0FycmF5KGFycikpIHsNCiAgICAgIHJldHVybiBhcnINCiAgICAgICAgLm1hcCgoeCkgPT4gKHsgdGV4dDogU3RyaW5nKCh4ICYmIHgudGV4dCkgfHwgJycpLnRyaW0oKSwgcmVhc29uOiBTdHJpbmcoKHggJiYgeC5yZWFzb24pIHx8ICcnKS50cmltKCkgfSkpDQogICAgICAgIC5maWx0ZXIoKHgpID0+IHgudGV4dCk7DQogICAgfQ0KICB9IGNhdGNoIChfZSkgeyAvKiDslYTrnpjroZwgKi8gfQ0KICByZXR1cm4gW107DQp9DQoNCi8vIOuhnOq3uOyduCDtlYTsmpTCt+2VnOuPhCDstIjqs7wg7IOB7YOc7J28IOuVjCAvaGVhbHRoIOyhsO2ajOqwgCDsmKTrqbQg65Kk7JeQ7IScIOybjOuwjeyXheydhCDri6Tsi5wg7Iuc64+E7ZW067O464ukICgzMOy0iOyXkCAx67KI66eMKS4NCi8vIOyEseqzte2VmOuptCDqsrDqs7wg7ZW465Ok65+s6rCAIGNsYXVkZVN0YXR1cz0nb2sn66GcIOuQmOuPjOumrOuvgOuhnCwg7J6s66Gc6re47J24IO2bhCDrsoTtirzsnbQg7KCA7KCI66GcIPCfn6LsnLzroZwg67O16reA7ZWc64ukLg0KLy8gKO2UjOufrOq3uOyduOydtCDroZzqt7jsnbgg7LC97J2EIOyXsCDrkqQg7KO86riw7KCB7Jy866GcIC9oZWFsdGjrpbwg7KGw7ZqM7ZWY64qUIOqyg+qzvCDsp53snYQg7J2066Os64ukKQ0KLy8g7ZWc64+EIOy0iOqzvOuPhCDqsJnsnYAg6rK966Gc66GcIOuzteq3gOyLnO2CqOuLpCDigJQg6rSA66as7J6Q6rCAIO2VnOuPhOulvCDsmKzroKTso7zqsbDrgpgg7ZWc64+E6rCAIOy0iOq4sO2ZlOuQmOuptA0KLy8g7IKs7Jqp7J6Q6rCAIOyVhOustOqyg+uPhCDslYgg64iM65+s64+EIOuyhO2KvOydtCDwn5+i7Jy866GcIOuPjOyVhOyYqOuLpC4g7ZWc64+E7JeQIOqxuOumsCDtmLjstpzsnYAg6rGw7KCI65CY66+A66GcIOyCrOyaqeufieydgCDslYgg64KY6rCE64ukDQovLyDqs4TsoJXsnbQgKirrsJbsl5DshJwqKiDrsJTrgJAg6rKD7J2EIOyVjOyVhOyxiOuLpCAoMjAyNi0wOCwgQlJJREdFX1Y9MjYpLg0KLy8g7YSw66+464SQ7J2064KYIOu4jOudvOyasOyggOyXkOyEnCDri6Trpbgg6rOE7KCV7Jy866GcIOuhnOq3uOyduO2VmOuptCDsnpDqsqnspp3rqoUg7YyM7J287J2AIOuwlOuAjOyngOunjCwg7J2066+4IOuWoCDsnojripQgY2xhdWRlDQovLyDshLjshZjsnYAg7Iuc64+Z7ZWgIOuVjCDrsJvsnYAg7JibIOqzhOyglSDsnoXsnqXqtozsnYQg6re464yA66GcIOyTtOuLpCDihpIg7IOIIOqzhOygleyXkCDsgqzsmqnrn4nsnbQg64Ko7JWEIOyeiOyWtOuPhCAi7ZWc64+EIOy0iOqzvCLqsIANCi8vIOqzhOyGjSDrgpjsmKjri6QoMjAyNi0wOCDsi6TsuKEg7Iug6rOgOiAi7IOIIOqzhOygleycvOuhnCDroZzqt7jsnbjtlojripTrjbAg7JmcIOq3uCDqs4TsoJUg7IKs7Jqp65+J7J2EIOuquyDsk7Drg5AiKS4NCi8vIO2UjOufrOq3uOyduOydhCDqsbDsuZwg66Gc6re47J24wrfroZzqt7jslYTsm4MoL29wZW4tbG9naW7Cty9jbGF1ZGUtbG9nb3V0KeydgCBraWxsUHJvY+ycvOuhnCDshLjshZjsnYQg67KE66Ck7IScIOydtCDrrLjsoJzqsIANCi8vIOyXhuyXiOuKlOuNsCwg67CW7JeQ7IScIOuwlOq+uOuptCDri6TrpqzqsIAg7JWMIOuwqeuyleydtCDsl4bsl4jri6QuIOq3uOuemOyEnCAvaGVhbHRoIOyhsO2ajOuniOuLpCDtjIzsnbzsnZgg6rOE7KCV6rO8IOu5hOq1kO2VnOuLpC4NCi8vIOu5hOyaqSAwKO2MjOydvOunjCDsnb3qs6AsIGNsYXVkZUFjY291bnTsnZggMzDstIgg7LqQ7Iuc66W8IOq3uOuMgOuhnCDsk7Tri6Qg4oCUIC5jbGF1ZGUuanNvbuydtCDsu6TshJwg66ek67KIIOydveyngCDslYrripTri6QpLg0KLy8g6rOE7KCVIOyeiOydjCDihpIg7JeG7J2MKOuhnOq3uOyVhOybgykg67Cp7Zal7J2AIOqxtOuTnOumrOyngCDslYrripTri6Q6IO2MjOydvOydhCDrja7slrTsk7DripQg7Iic6rCEIOyeoOq5kCDrqrsg7J2964qUIOqyg+qzvA0KLy8g6rWs67aE65CY7KeAIOyViuyVhCDtl5sg7J6s7Iuc7J6R7J2EIOu2gOultOqzoCwg6re4IOuwqe2WpeydgCDsnbjspp0g7Jik66WYIOqyveuhnChpc0F1dGhFcnJvcinqsIAg7J2066+4IOyymOumrO2VnOuLpC4NCmZ1bmN0aW9uIHJlc3RhcnRJZkFjY291bnRDaGFuZ2VkKCkgew0KICBpZiAoIXByb2MgfHwgd2FpdGVyKSByZXR1cm47ICAgICAgICAgLy8g7IS47IWYIOyXhuydjCjri6TsnYwg7YS07J20IOyDiOuhnCDsi5zrj5kpIC8g7YS0IOynhO2WiSDspJHsnbTrqbQg64uk7J2MIOyhsO2ajOyXkOyEnA0KICBjb25zdCBub3cgPSBjbGF1ZGVBY2NvdW50KCk7DQogIGlmICghbm93IHx8IG5vdyA9PT0gc2Vzc2lvbkFjY291bnQpIHJldHVybjsNCiAgY29uc29sZS5sb2coJ1ticmlkZ2VdIOqzhOygleydtCDrsJTrgIzsl4jslrTsmpQgKCcgKyAoc2Vzc2lvbkFjY291bnQgfHwgJ+yXhuydjCcpICsgJyDihpIgJyArIG5vdyArICcpIOKAlCDsmJsg6rOE7KCVIOyEuOyFmOydhCDrsoTrpqzqs6Ag7IOIIOqzhOygleycvOuhnCDri6Tsi5wg7Iuc7J6R7ZWp64uI64ukLicpOw0KICAvLyDsnZjrj4TsoIEg7KKF66OMKHJlYXNvbiDsp4DsoJUpIOKAlCBTRVNTSU9OX0RJRUTroZwg64Gd64K066m0IOyekOuPmSDsnqzsi5zrj4TqsIAg7JibIOqzhOyglSDshLjshZjsnYQg65CY7IK066aw64ukDQogIGtpbGxQcm9jKCfqs4TsoJXsnbQg67CU64CM7Ja07IScIOyEuOyFmOydhCDsg4jroZwg7Iuc7J6R7ZaI7Ja07JqUIOKAlCDri6Tsi5wg7Iuc64+E7ZW0IOyjvOyEuOyalC4nKTsNCiAgY2xhdWRlU3RhdHVzID0gbnVsbDsgLy8g7ZWc64+EwrfroZzqt7jsnbgg7IOB7YOc64qUIOqzhOygleuniOuLpCDri6TrpbTri6Qg4oCUIOyDiCDqs4TsoJXsnLzroZwg64uk7IucIO2MkOygle2VmOqyjA0KICBzZXNzaW9uQWNjb3VudCA9IG5vdzsNCn0NCg0KbGV0IGxhc3RBdXRoUmV0cnlBdCA9IDA7DQpmdW5jdGlvbiByZXRyeUF1dGhJZk5lZWRlZCgpIHsNCiAgaWYgKGNsYXVkZVN0YXR1cyAhPT0gJ2NsYXVkZS1sb2dvdXQnICYmIGNsYXVkZVN0YXR1cyAhPT0gJ2NsYXVkZS1saW1pdCcpIHJldHVybjsNCiAgaWYgKHdhaXRlciB8fCBEYXRlLm5vdygpIC0gbGFzdEF1dGhSZXRyeUF0IDwgMzAwMDApIHJldHVybjsgLy8g7KeE7ZaJIOykkSDthLQg67Cp7ZW0IOq4iOyngCArIDMw7LSIIOqwhOqyqQ0KICBsYXN0QXV0aFJldHJ5QXQgPSBEYXRlLm5vdygpOw0KICBjb25zb2xlLmxvZygnW2JyaWRnZV0g66Gc6re47J24IOyerO2ZleyduCDsi5zrj4TigKYnKTsNCiAgcnVuVHVybigoKSA9PiAn66Gc6re47J24IO2ZleyduOyaqeydtOuLpC4gIk9LIuudvOqzoOunjCDri7XtlZjrnbwuJykudGhlbigNCiAgICAoKSA9PiBjb25zb2xlLmxvZygnW2JyaWRnZV0g66Gc6re47J24IO2ZleyduOuQqCDigJQg7KCV7IOBIOyDge2DnOuhnCDrs7Xqt4AuJyksDQogICAgKGUpID0+IGNvbnNvbGUubG9nKCdbYnJpZGdlXSDslYTsp4Eg66Gc6re47J24IOyViCDrkKg6JywgU3RyaW5nKGUubWVzc2FnZSkuc2xpY2UoMCwgODApKQ0KICApOw0KfQ0KDQovLyDsi6TtjKgg7J2R64u17J2EIOyCrOuejOyaqSDslYjrgrTroZwg67OA7ZmYIOKAlCDsm5Dsnbgo66Gc6re47J24L+yEpOy5mCnsnbQg7YyM7JWF65CcIOqyveyasOyXlCDqt7gg7JWI64K066W8LCDslYTri4jrqbQg7KCR65GQ7Ja0K+ybkOusuOydhCDrs7Trgrjri6QNCmZ1bmN0aW9uIGZyaWVuZGx5RXJyb3IoZSwgcHJlZml4KSB7DQogIGlmIChlICYmIGUubWVzc2FnZSA9PT0gTE9HSU5fR1VJREUpIHJldHVybiB7IGVycm9yOiBMT0dJTl9HVUlERSwgcHJvYmxlbTogJ2NsYXVkZS1sb2dvdXQnIH07DQogIGlmIChlICYmIGUubWVzc2FnZSA9PT0gTElNSVRfR1VJREUpIHJldHVybiB7IGVycm9yOiBMSU1JVF9HVUlERSwgcHJvYmxlbTogJ2NsYXVkZS1saW1pdCcgfTsNCiAgaWYgKGNsYXVkZVN0YXR1cyA9PT0gJ2NsYXVkZS1taXNzaW5nJykgew0KICAgIHJldHVybiB7IGVycm9yOiAn7J20IFBD7JeQIENsYXVkZSBDb2RlKGNsYXVkZSnqsIAg7ISk7LmY64+8IOyeiOyngCDslYrslYTsmpQg4oCUIOyEpOy5mO2VmOqzoCDroZzqt7jsnbjtlZwg65KkIOuLpOyLnCDsi5zrj4TtlbQg7KO87IS47JqULicsIHByb2JsZW06ICdjbGF1ZGUtbWlzc2luZycgfTsNCiAgfQ0KICByZXR1cm4geyBlcnJvcjogcHJlZml4ICsgKGUgJiYgZS5tZXNzYWdlID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKSB9Ow0KfQ0KDQpmdW5jdGlvbiByZWFkQm9keShyZXEpIHsNCiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7DQogICAgbGV0IGJvZHkgPSAnJzsNCiAgICByZXEub24oJ2RhdGEnLCAoYykgPT4geyBib2R5ICs9IGM7IH0pOw0KICAgIHJlcS5vbignZW5kJywgKCkgPT4gew0KICAgICAgdHJ5IHsgcmVzb2x2ZShKU09OLnBhcnNlKGJvZHkpKTsgfSBjYXRjaCAoX2UpIHsgcmVzb2x2ZSh7fSk7IH0NCiAgICB9KTsNCiAgfSk7DQp9DQoNCmNvbnN0IENPUlNfSEVBREVSUyA9IHsNCiAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJywNCiAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMnOiAnR0VULCBQT1NULCBPUFRJT05TJywNCiAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlJywNCn07DQpmdW5jdGlvbiBqc29uKHJlcywgc3RhdHVzLCBvYmopIHsNCiAgcmVzLndyaXRlSGVhZChzdGF0dXMsIE9iamVjdC5hc3NpZ24oeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0sIENPUlNfSEVBREVSUykpOw0KICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KG9iaikpOw0KfQ0KDQpjb25zdCBzZXJ2ZXIgPSBodHRwLmNyZWF0ZVNlcnZlcihhc3luYyAocmVxLCByZXMpID0+IHsNCiAgaWYgKHJlcS5tZXRob2QgPT09ICdPUFRJT05TJykgeyByZXMud3JpdGVIZWFkKDIwNCwgQ09SU19IRUFERVJTKTsgcmV0dXJuIHJlcy5lbmQoKTsgfQ0KICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgcmVxLnVybCA9PT0gJy9oZWFsdGgnKSB7DQogICAgcmVzdGFydElmQWNjb3VudENoYW5nZWQoKTsgLy8g67CW7JeQ7IScIOqzhOygleydhCDrsJTqv6jsnLzrqbQg7JibIOqzhOyglSDshLjshZjsnYQg66i87KCAIOuyhOumsOuLpCAo7JWE656YIOybjOuwjeyXheydtCDsmJsg6rOE7KCV7Jy866GcIOuPjOyngCDslYrqsowpDQogICAgcmV0cnlBdXRoSWZOZWVkZWQoKTsgLy8g66Gc6re47J24IO2VhOyalCDsg4Htg5zrqbQg7J6s7ZmV7J24IOyLnOuPhCDigJQg7J6s66Gc6re47J247J20IOuBneuCrOycvOuptCDri6TsnYwg7KGw7ZqM67aA7YSwIHByb2JsZW3snbQg7ZKA66aw64ukDQogICAgcmV0dXJuIGpzb24ocmVzLCAyMDAsIHsNCiAgICAgIG9rOiB0cnVlLCBlbmdpbmU6ICdjbGF1ZGUnLCB2OiBCUklER0VfViwgZGlyOiBfX2Rpcm5hbWUsIC8vIHbCt2Rpcjog6rWs67KE7KCEL+yXieuase2VnCDsgqzrs7jsnbQg65agIOyeiOuKlOyngCDsp4Tri6jsmqkNCiAgICAgIG1vZGVsOiBjdXJyZW50TW9kZWwsIG1vZGVsczogQUxMT1dFRF9NT0RFTFMsIGV4YW1wbGVzOiBFWEFNUExFUy5sZW5ndGgsIGd1aWRlOiBHVUlERS5sZW5ndGgsIHJlYWR5OiB3YXJtZWRVcCwNCiAgICAgIHByb2JsZW06IChjbGF1ZGVTdGF0dXMgPT09ICdvaycgfHwgY2xhdWRlU3RhdHVzID09PSBudWxsKSA/IG51bGwgOiBjbGF1ZGVTdGF0dXMsDQogICAgICBhY2NvdW50OiBjbGF1ZGVBY2NvdW50KCksDQogICAgICBzZXJ2ZWQ6IHN0YXRzLnNlcnZlZCwgbGFzdEF0OiBzdGF0cy5sYXN0QXQsIGxhc3RUZXh0OiBzdGF0cy5sYXN0VGV4dCwgbGFzdFNlYzogc3RhdHMubGFzdFNlYywNCiAgICB9KTsNCiAgfQ0KICAvLyDtlIzrn6zqt7jsnbgg7Ius7J6l67CV64+ZIOKAlCDrgYrquLDrqbQg7JyEIOqwkOyLnCDtg4DsnbTrqLjqsIAg64uk66as66W8IOuBiOuLpA0KICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHJlcS51cmwgPT09ICcvaGVhcnRiZWF0Jykgew0KICAgIGxhc3RCZWF0ID0gRGF0ZS5ub3coKTsNCiAgICByZXR1cm4ganNvbihyZXMsIDIwMCwgeyBvazogdHJ1ZSB9KTsNCiAgfQ0KICAvLyDroZzqt7jsnbgg4oCUIO2UjOufrOq3uOyduOydmCBb8J+foCDtgbTroZzrk5wg66Gc6re47J24IO2VhOyalF3Ct1vwn5SRXSDrsoTtirzsnbQg7Zi47Lac7ZWc64ukLg0KICAvLyDquLDrs7go67iM65287Jqw7KCAIOynge2WiSk6IGBjbGF1ZGUgYXV0aCBsb2dpbiAtLWNsYXVkZWFpYOulvCDsiKjsnYAg7ZSE66Gc7IS47Iqk66GcIOyLpO2WiSDigJQg66mU64m0IOyXhuydtCDqs6fsnqUg67iM65287Jqw7KCA66W8IOyXtOqzoCwNCiAgLy8gICBsb2NhbGhvc3Qg7IiY7IugIO2PrO2KuOuhnCDqsrDqs7zrpbwg7J6Q64+ZIOyImOugue2VnOuLpCjsi6TsuKE6IO2XpOuTnOumrOyKpOyXkOyEnOuPhCDruIzrnbzsmrDsoIAg7Je066a8ICsgTElTVEVOIO2ZleyduCwgMjAyNi0wNykuDQogIC8vICAg7YSw66+464SQ7J20IO2ZlOuptOyXkCDsoITtmIAg7JWIIOucrOuLpC4g67iM65287Jqw7KCAIOuhnOq3uOyduOunjCDtlZjrqbQg64GdLg0KICAvLyDtj7TrsLEo7YSw66+464SQKTog7J6Q64+ZIOyZhOujjOqwgCDrp4ntnowg7ZmY6rK9KOu4jOudvOyasOyggOqwgCBsb2NhbGhvc3Tsl5Ag66q7IOuLv+yVhCDsvZTrk5zqsIAg67O07J2064qUIOqyveyasCnsl5DshJwNCiAgLy8gICDroZzqt7jsnbgg64yA6riwIOykkSDrsoTtirzsnYQg65iQIOuIhOultOuptCwg7L2U65Oc66W8IOu2meyXrOuEo+ydhCDsiJgg7J6I64qUIO2EsOuvuOuEkCDrsKnsi53snLzroZwg7KCE7ZmY7ZWc64ukLg0KICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHJlcS51cmwgPT09ICcvb3Blbi1sb2dpbicpIHsNCiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEJvZHkocmVxKTsNCiAgICBjb25zdCBzd2l0Y2hNb2RlID0gISEoYm9keSAmJiBib2R5LnN3aXRjaEFjY291bnQpOyAvLyDqs4TsoJUg7KCE7ZmYID0g7Iuc7YGs66a/IOywveycvOuhnCDsl7TslrQg6rOE7KCV7J2EIOqzoOulvCDsiJgg7J6I6rKMDQogICAgdHJ5IHsNCiAgICAgIC8vIGNsYXVkZeqwgCDsl4bsnLzrqbQg7Jes6riw7IScIOuBiuuKlOuLpC4gc2hlbGw6dHJ1ZeudvCBjbGF1ZGXqsIAg7JeG7Ja064+EIOyFuOydgCDsoJXsg4Eg7Iuk7ZaJ64+8DQogICAgICAvLyBzcGF3buydmCAnZXJyb3In6rCAIOyViCDrnKjqs6AsIOyYiOyghOyXlCDqt7jrjIDroZwgb2s6dHJ1ZeulvCDrj4zroKTspKzri6Qg4oCUDQogICAgICAvLyDtlIzrn6zqt7jsnbjsnYAgIuu4jOudvOyasOyggOulvCDsl7Tsl4jslrTsmpQi65286rOgIO2VmOuKlOuNsCDsi6TsoJzroZzripQg7JWE66y06rKD64+EIOyViCDrnKjripQg7IOB7YOc6rCAIOuQkOuLpCjsi6TsoJwg7Iug6rOgKS4NCiAgICAgIGlmIChjbGF1ZGVTdGF0dXMgPT09ICdjbGF1ZGUtbWlzc2luZycpIHsNCiAgICAgICAgcmV0dXJuIGpzb24ocmVzLCA1MDEsIHsNCiAgICAgICAgICBlcnJvcjogJ+ydtCBQQ+yXkCBDbGF1ZGUgQ29kZeqwgCDsl4bslrTsmpQg4oCUIO2EsOuvuOuEkOyXkOyEnCBjbGF1ZGUgLS12ZXJzaW9uIOydtCDrkJjripTsp4Ag7ZmV7J247ZW0IOyjvOyEuOyalC4nLA0KICAgICAgICAgIHByb2JsZW06ICdjbGF1ZGUtbWlzc2luZycsDQogICAgICAgIH0pOw0KICAgICAgfQ0KICAgICAgLy8g7KeE7ZaJIOykkeyduOuNsCDrmJAg64iM66CA64ukIOKAlCDsm5DsuZnsnYAgIuu4jOudvOyasOyggOuhnCDri6Tsi5wg7Je06riwIuuLpC4g7YSw66+464SQ7J2AICoq7LC97J2EIOyVhOustOqyg+uPhCDrqrsg652E7Jug7J2EIOuVjOunjCoqLg0KICAgICAgLy8g7JiI7KCE7JeUICc2MOy0iCDrhJjqsowg64yA6riwIOykkeydtOuptCDthLDrr7jrhJAn7J207JeI64qU642wLCDroZzqt7jsnbgg7ZmU66m07J2EIOydveqxsOuCmCDsnqDquZAg65S0IOydvCDtlZjri6Qg64uk7IucIOuIhOuluA0KICAgICAgLy8g7KCV7IOB7KCB7J24IOqyveyasOyXkOuPhCBjbWQg7LC97J20IO2KgOyWtOuCmOyZlOuLpCgyMDI2LTA4IOyLpOy4oSDsi6Dqs6A6ICLthLDrr7jrhJAg7ZmU66m07J2AIOyZnCDrlqAg6rCR7J6Q6riwIikuDQogICAgICAvLyDsnbTsoJwg7Jqw66as6rCAIOywveydhCDsp4HsoJEg7Je06rOgIOyEseqztSDsl6zrtoAobG9naW5XaW5kb3dPcGVuZWQp66W8IOyVhOuLiOq5jCwg7Iuc6rCE7J20IOyVhOuLiOudvCDqt7gg7IKs7Iuk66GcIO2MkOuLqO2VnOuLpC4NCiAgICAgIGNvbnN0IHN0YWxlID0gbG9naW5Qcm9jICYmICFsb2dpbldpbmRvd09wZW5lZCAmJiAoRGF0ZS5ub3coKSAtIGxvZ2luU3RhcnRlZEF0ID4gMjAwMDApOw0KICAgICAgaWYgKGxvZ2luUHJvYyAmJiBzdGFsZSkgew0KICAgICAgICBraWxsTG9naW5Qcm9jKCk7DQogICAgICAgIGlmICghb3BlbkxvZ2luVGVybWluYWwoKSkgew0KICAgICAgICAgIHJldHVybiBqc29uKHJlcywgNTAxLCB7IGVycm9yOiAn7J20IE9T7JeQ7ISgIOyekOuPmeycvOuhnCDrqrsg7Je07Ja07JqUIOKAlCDthLDrr7jrhJDsl5DshJwgY2xhdWRlIOyLpO2WiSDtm4QgL2xvZ2luIO2VtCDso7zshLjsmpQuJyB9KTsNCiAgICAgICAgfQ0KICAgICAgICAvLyDsnZjrj4TsoIEg7KKF66OMKHJlYXNvbiDsp4DsoJUpIOKAlCDsp4Ttlokg7KSRIO2EtOydhCBTRVNTSU9OX0RJRUTroZwg64Gd64K066m0IOyekOuPmSDsnqzsi5zrj4TqsIAg7JibIOqzhOyglSDshLjshZjsnYQg65CY7IK066aw64ukDQogICAgICAgIGtpbGxQcm9jKCfroZzqt7jsnbjsnYQg7KeE7ZaJ7ZWY64qUIOykkeydtOudvCDsmpTssq3snYQg7KSR64uo7ZaI7Ja07JqUIOKAlCDroZzqt7jsnbgg7ZuEIOuLpOyLnCDsi5zrj4TtlbQg7KO87IS47JqULicpOw0KICAgICAgICBhY2NvdW50Q2FjaGUuYXQgPSAwOw0KICAgICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g66Gc6re47J24IO2PtOuwsSDigJQg7YSw66+464SQIOuwqeyLneycvOuhnCDsoITtmZguJyk7DQogICAgICAgIHJldHVybiBqc29uKHJlcywgMjAwLCB7IG9rOiB0cnVlLCBtb2RlOiAndGVybWluYWwnIH0pOw0KICAgICAgfQ0KICAgICAgLy8g67Cp6riIIOyLnOyeke2VnCDroZzqt7jsnbjsnbQg7IK07JWEIOyeiOycvOuptCDshpDrjIDsp4Ag7JWK64qU64ukIOKAlCDso73snbTrqbQg7IKs7Jqp7J6Q6rCAIOuztOqzoCDsnojripQg7YOt7J2YIOy9nOuwsSDtj6ztirjqsIANCiAgICAgIC8vIOuLq+2YgCAibG9jYWxob3N07JeQ7IScIOyXsOqysOydhCDqsbDrtoDtlojsirXri4jri6Qi6rCAIOucrOuLpCgyMDI2LTA4IOyLpOy4oSDsi6Dqs6ApLg0KICAgICAgaWYgKGxvZ2luUHJvYyAmJiBEYXRlLm5vdygpIC0gbG9naW5TdGFydGVkQXQgPCAxNTAwMCkgew0KICAgICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g66Gc6re47J24IOywveydtCDsnbTrr7gg7Je066CkIOyeiOyWtOyalCDigJQg7IOI66GcIOyXtOyngCDslYrqs6Ag6re4IOywveydhCDsk7DshLjsmpQuJyk7DQogICAgICAgIHJldHVybiBqc29uKHJlcywgMjAwLCB7IG9rOiB0cnVlLCBtb2RlOiAnYWxyZWFkeS1vcGVuJyB9KTsNCiAgICAgIH0NCiAgICAgIGtpbGxMb2dpblByb2MoKTsgLy8g7JWe7ISgIOu4jOudvOyasOyggCDroZzqt7jsnbjsnbQg64yA6riwIOykkeydtOuptCDsoJHqs6Ag7IOI66GcIOyXsOuLpCAo7LC97J2EIOuLq+yVmOqxsOuCmCDri6Tsi5wg64iE66W4IOqyveyasCkNCiAgICAgIGxvZ2luU3RhcnRlZEF0ID0gRGF0ZS5ub3coKTsNCiAgICAgIGxvZ2luV2luZG93T3BlbmVkID0gZmFsc2U7IC8vIOydtOuyiCDsi5zrj4TsnZgg7LC9IOyXtOq4sCDshLHqs7Ug7Jes67aAIOKAlCDslYTrnpjsl5DshJwg7IS47Jq064ukDQogICAgICAvLyBCUk9XU0VS64qUIOqxtOuTnOumrOyngCDslYrripTri6Qg4oCUIENMSeqwgCDquLDrs7gg67iM65287Jqw7KCA66W8IOyXtOqzoCBsb2NhbGhvc3TroZwg6rKw6rO866W8IOyekOuPmSDsiJjroLntlZzri6QNCiAgICAgIC8vICjsnIQgJ+uhnOq3uOyduOydgCBDTEnqsIAg6riw67O4IOu4jOudvOyasOyggOulvCDsp4HsoJEg7Je06rKMIO2VnOuLpCcg7KO87ISdIOKAlCDqsIDroZzssYTrqbQg7L2U65OcIOu2meyXrOuEo+q4sCDtmZTrqbTsnbQg65ys64ukKS4NCiAgICAgIC8vICoq6rOE7KCVIOyghO2ZmOydgCDsm7kg66Gc6re47JWE7JuD7J2EIOuovOyggCDsl7Dri6QqKigyMDI2LTA4LCBCUklER0VfVj0zMSk6IOu4jOudvOyasOyggOyXkCDshLjshZjsnbQg64Ko7JWEIOyeiOycvOuptA0KICAgICAgLy8gYXV0aG9yaXpl6rCAIOqzhOygleydhCDrrLvsp4Ag7JWK6rOgIOyKueyduCDtmZTrqbTrp4wg652E7Jq064ukKCLsirnsnbgg7ZmU66m0IOunkOqzoCDroZzqt7jsnbgg7ZmU66m07Jy866GcIOqwgOqzoCDsi7bri6QiIOyalOq1rCkuDQogICAgICAvLyDshLjshZjsnYQg7KeA7Jq0IOuSpCDsl7TrqbQg66Gc6re47J24IO2ZlOuptOu2gO2EsCDrgpjsmKjri6Qg4oCUIFVSTOydhCDqsIDqs7XtlZjsp4Drj4Qo7LK07J2064udIOyLpO2MqCksIEJST1dTRVLrpbwg6rCA66Gc7LGE7KeA64+EDQogICAgICAvLyAo7L2U65OcIOu2meyXrOuEo+q4sCDsnKDrsJwpLCDruIzrnbzsmrDsoIDrpbwg6rOg66W07KeA64+EKOq4sOuzuCDruIzrnbzsmrDsoIAg7JWE64uYKSDslYrripQg7Jyg7J287ZWcIOuwqeuylS4NCiAgICAgIC8vIOu2gOyekeyaqTog67iM65287Jqw7KCA7J2YIGNsYXVkZSDsm7kg66Gc6re47J2464+EIO2SgOumsOuLpCDigJQg6rOE7KCV7J2EIOuwlOq+uOugpOuKlCDsnZjrj4TsmYAg67Cp7Zal7J20IOqwmeyVhCDsiJjsmqkuDQogICAgICBjb25zdCBzdGFydExvZ2luID0gKCkgPT4gew0KICAgICAgICBjb25zdCB0aGlzTG9naW4gPSBzcGF3bignY2xhdWRlJywgWydhdXRoJywgJ2xvZ2luJywgJy0tY2xhdWRlYWknXSwgew0KICAgICAgICAgIHNoZWxsOiB0cnVlLCBlbnY6IENMQVVERV9FTlYsIHN0ZGlvOiAnaWdub3JlJywgd2luZG93c0hpZGU6IHRydWUsDQogICAgICAgICAgZGV0YWNoZWQ6IHByb2Nlc3MucGxhdGZvcm0gIT09ICd3aW4zMicsIC8vIGtpbGxMb2dpblByb2PsnZgg6re466O5IGtpbGzsmqkgKGtpbGxQcm9j6rO8IOuPmeydvCDtjKjthLQpDQogICAgICAgIH0pOw0KICAgICAgICBsb2dpblByb2MgPSB0aGlzTG9naW47DQogICAgICAgIGxvZ2luV2luZG93T3BlbmVkID0gdHJ1ZTsgLy8gQ0xJ6rCAIOyXrOuKlCDqsbQg6rSA7LCw7ZWgIOyImCDsl4bsnLzri4gg7Je066awIOqyg+ycvOuhnCDrs7jri6QgKOyerO2BtOumreyXkCDthLDrr7jrhJAg67Cp7KeAKQ0KICAgICAgICB0aGlzTG9naW4ub24oJ2Vycm9yJywgKCkgPT4geyBpZiAobG9naW5Qcm9jID09PSB0aGlzTG9naW4pIGxvZ2luUHJvYyA9IG51bGw7IH0pOw0KICAgICAgICB0aGlzTG9naW4ub24oJ2Nsb3NlJywgKGNvZGUpID0+IHsNCiAgICAgICAgICBpZiAobG9naW5Qcm9jICE9PSB0aGlzTG9naW4pIHJldHVybjsNCiAgICAgICAgICBsb2dpblByb2MgPSBudWxsOw0KICAgICAgICAgIGlmIChsb2dpblByb2NUaW1lcikgeyBjbGVhclRpbWVvdXQobG9naW5Qcm9jVGltZXIpOyBsb2dpblByb2NUaW1lciA9IG51bGw7IH0NCiAgICAgICAgICBhY2NvdW50Q2FjaGUuYXQgPSAwOyAvLyDsg4gg6rOE7KCV7J28IOyImCDsnojsnLzri4gg64uk7J2MIC9oZWFsdGgg65WMIOuLpOyLnCDsnb3quLANCiAgICAgICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g67iM65287Jqw7KCAIOuhnOq3uOyduCDsoIjssKgg7KKF66OMIChjb2RlICcgKyBjb2RlICsgJyknKTsNCiAgICAgICAgICAvLyDsgqzrnozsnbQg66Gc6re47J247ZWgIOyLnOqwhOuPhCDsl4bsnbQg6rOn67CU66GcIOyLpO2MqOuhnCDrgZ3rgqzri6QgPSBjbGF1ZGXqsIAg7JeG6rGw64KYIOyLpO2WieydtCDslYgg65CcIOqygy4NCiAgICAgICAgICAvLyDsnZHri7XsnYAg7J2066+4IOuztOuDiOycvOuLiCDsg4Htg5zrpbwg64uk7IucIOyerOyEnCAvaGVhbHRo66GcIOyVjOumsOuLpCAo7ZSM65+s6re47J247J20IOuMgOq4sCDtmZTrqbTsnYQg7Iuk7Yyo66GcIOuwlOq+vOuLpCkuDQogICAgICAgICAgaWYgKGNvZGUgIT09IDAgJiYgRGF0ZS5ub3coKSAtIGxvZ2luU3RhcnRlZEF0IDwgNTAwMCkgew0KICAgICAgICAgICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIOuhnOq3uOyduOydtCDsponsi5wg7Iuk7Yyo66GcIOuBneuCqCDigJQgQ2xhdWRlIENvZGUg7ISk7LmYIOyDge2DnOulvCDri6Tsi5wg7KCQ6rKA7ZWp64uI64ukLicpOw0KICAgICAgICAgICAgY2hlY2tDbGF1ZGVBdmFpbGFibGUoKTsNCiAgICAgICAgICB9DQogICAgICAgIH0pOw0KICAgICAgICAvLyAzMOu2hCDigJQg7J20IO2UhOuhnOyEuOyKpOqwgCDso73snLzrqbQg67iM65287Jqw7KCAIOy9nOuwseydtCDqsIggbG9jYWxob3N0IO2PrO2KuOuPhCDri6vtmIAgJ+yXsOqysOydhCDqsbDrtoDtlojsirXri4jri6Qn6rCAIOucrOuLpC4NCiAgICAgICAgLy8g7JiI7KCEIDEw67aE7J2AIOynp+yVhOyEnCwg66Gc6re47J247ZWY64ukIOyeoOq5kCDri6Trpbgg7J287J2EIO2VmOuptCDtg63snbQg66y07Zqo6rCAIOuQkOuLpCgyMDI2LTA4IOyLpOy4oSDsi6Dqs6ApLg0KICAgICAgICBsb2dpblByb2NUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4geyBjb25zb2xlLmxvZygnW2JyaWRnZV0g66Gc6re47J24IDMw67aEIOqyveqzvCDigJQg64yA6riwIO2UhOuhnOyEuOyKpCDsoJXrpqwuJyk7IGtpbGxMb2dpblByb2MoKTsgfSwgMTgwMDAwMCk7DQogICAgICB9Ow0KICAgICAgLy8gKirqs4TsoJUg7KCE7ZmYID0g66Gc6re47JWE7JuDICsg67iM65287Jqw7KCA7JeQIOuhnOq3uOyduCDtmZTrqbQqKiAoMjAyNi0wOCwgQlJJREdFX1Y9MzYsIOyCrOyaqeyekCDqsrDsoJUpLg0KICAgICAgLy8g7Iq57J24IO2ZlOuptOydtCDrnKjripQg6re867O4IOybkOyduOydgCAi67iM65287Jqw7KCA7JeQIOyYmyDqs4TsoJXsnbQg66Gc6re47J2464+8IOyeiOuLpCLripQg6rKD7J2066+A66GcLCDsoITtmZjsnZgg7LKrIOuPmeyekeydgA0KICAgICAgLy8g66Gc6re47J247J20IOyVhOuLiOudvCAqKuuhnOq3uOyVhOybgyoq7J207Ja07JW8IOunnuuLpC4g6re4656Y7IScIOyXrOq4sOyEnOuKlCDroZzqt7jsnbjsnYQg7Iuc7J6R7ZWY7KeAIOyViuuKlOuLpDoNCiAgICAgIC8vICAg4pGgIENMSSDroZzqt7jslYTsm4MoY2xhdWRlIGF1dGggbG9nb3V0KSDigJQg7JibIOyekOqyqeymneuqhcK37IS47IWYIO2PkOq4sA0KICAgICAgLy8gICDikaEg67iM65287Jqw7KCAIOybuSDroZzqt7jslYTsm4Mg7Je06riwIOKAlCBjbGF1ZGUuYWkvbG9nb3V07J2AIOuhnOq3uOyVhOybgyDtm4QgKirroZzqt7jsnbgg7ZmU66m07Jy866GcIOywqeyngCoq7ZWc64ukKO2DrSAx6rCcKQ0KICAgICAgLy8g66Gc6re47JWE7JuD7J20IOuBneuCmOuptCDqs6frsJTroZwgQ0xJIOuhnOq3uOyduOq5jOyngCDsnbTslrTshJwg7Iuc7J6R7ZWc64ukIOKAlCDshLjshZjsnbQg67mE7JuM7KeEIOuSpOudvCDsirnsnbgg7ZmU66m07J20IOyVhOuLiOudvA0KICAgICAgLy8g66Gc6re47J24IO2ZlOuptOydtCDrgpjsmKjri6QuIO2BtOumrSDtlZwg67KI7Jy866GcICLroZzqt7jslYTsm4Mg4oaSIOyDiCDqs4TsoJUg66Gc6re47J24IuydtCDrgZ3rgpzri6QuDQogICAgICBpZiAoc3dpdGNoTW9kZSkgew0KICAgICAgICBraWxsTG9naW5Qcm9jKCk7IC8vIOuMgOq4sCDspJHsnbgg7JibIOuhnOq3uOyduCDsoIjssKjqsIAg7J6I7Jy866m0IOygkeuKlOuLpA0KICAgICAgICBjb25zdCBsbyA9IHNwYXduKCdjbGF1ZGUnLCBbJ2F1dGgnLCAnbG9nb3V0J10sIHsgc2hlbGw6IHRydWUsIGVudjogQ0xBVURFX0VOViwgd2luZG93c0hpZGU6IHRydWUgfSk7DQogICAgICAgIGxvLm9uKCdlcnJvcicsICgpID0+IHsgLyogY2xhdWRlIOyXhuydjCDrk7Eg4oCUIOyVhOuemCDsm7kg66Gc6re47JWE7JuD7J2AIOq3uOuMgOuhnCDsp4TtlokgKi8gfSk7DQogICAgICAgIC8vICoq7YOt7J2AIOuwmOuTnOyLnCAx6rCcKiogKDIwMjYtMDgsIEJSSURHRV9WPTQwLCDsgqzsmqnsnpAg7JqU6rWsKTog7Ju5IOuhnOq3uOyVhOybgyDso7zshozrpbwg65Sw66GcIOyXtOuptA0KICAgICAgICAvLyDroZzqt7jsnbgg7ZmU66m07J20IOuRkCDqsJwo66Gc6re47JWE7JuDIOywqeyngCDtmZTrqbQgKyBPQXV0aCDtmZTrqbQpIOuWoOyEnCDslrTripAg7Kq97JeQIOuhnOq3uOyduO2VtOyVvCDtlZjripTsp4Ag7JWMIOyImCDsl4bqs6AsDQogICAgICAgIC8vIOyXieuase2VnCDsqr3sl5Ag66Gc6re47J247ZWY66m0IO2UjOufrOq3uOyduOydgCDsl7DqsrDrkJjsp4Ag7JWK64qU64ukKOyLpOy4oSDsi6Dqs6AgMu2ajDogIuyZnCDrkZAg6rCc64KYIOuWoCIsICLroZzqt7jsnbjtlojripTrjbAg7JmcIikuDQogICAgICAgIC8vIOq3uOuemOyEnCDsm7kg66Gc6re47JWE7JuD7J2AIOyXtOyngCDslYrripTri6Qg4oCUIENMSSDroZzqt7jslYTsm4Prp4wg7ZWY6rOgIOuhnOq3uOyduCDssL0g7ZWY64KY66eMIOudhOyatOuLpC4NCiAgICAgICAgLy8gICDCtyDruIzrnbzsmrDsoIDqsIAg66Gc6re47JWE7JuD64+8IOyeiOycvOuptCDihpIg66Gc6re47J24IO2ZlOuptOydtCDrsJTroZwg64KY7Jio64ukDQogICAgICAgIC8vICAgwrcg67iM65287Jqw7KCA7JeQIOyEuOyFmOydtCDrgqjslYQg7J6I7Jy866m0IOKGkiDsirnsnbgg7ZmU66m07J20IOuCmOyYqOuLpC4g6re4IO2ZlOuptCDtlZjri6ggW+qzhOyglSDsoITtmZhd7Jy866GcIOqzhOygleydhCDqs6Drpbjri6QNCiAgICAgICAgLy8gICAgICjsirnsnbgg7ZmU66m07J2EIOqxtOuEiOubsOugpOuptCDruIzrnbzsmrDsoIDsl5DshJwgY2xhdWRlIOuhnOq3uOyVhOybg+ydhCDrqLzsoIAg7ZW07JW8IO2VmOuKlOuNsCwg6re46rG0IO2DreydtCDtlZjrgpgg642UIO2VhOyalO2VmOuLpCkNCiAgICAgICAgLy8g66Gc6re47J247J2AICoq66Gc6re47JWE7JuD7J20IOuBneuCnCDrkqQqKiDsi5zsnpHtlZzri6Qg4oCUIOuovOyggCDrnYTsmrDrqbQg66Gc6re47JWE7JuD7J20IOyDiCDsnpDqsqnspp3rqoXsnYQg7KeA7Jq4IOyImCDsnojri6QuDQogICAgICAgIGxvLm9uKCdjbG9zZScsIChjb2RlKSA9PiB7DQogICAgICAgICAga2lsbFByb2MoJ+qzhOygleydhCDrsJTqvrjroKTqs6Ag66Gc6re47JWE7JuD7ZW07IScIOyalOyyreydhCDspJHri6jtlojslrTsmpQuJyk7IC8vIOydmOuPhOyggSDsooXro4wgKOyekOuPmSDsnqzsi5zrj4Qg67Cp7KeAKQ0KICAgICAgICAgIGFjY291bnRDYWNoZS5hdCA9IDA7IC8vIOuLpOydjCDsobDtmozsl5DshJwgJ+qzhOyglSDsl4bsnYwn7Jy866GcIOydve2eiOqyjA0KICAgICAgICAgIGNsYXVkZVN0YXR1cyA9IG51bGw7IC8vIOyDge2DnCDsnqztjJDsoJUNCiAgICAgICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g6rOE7KCVIOyghO2ZmCDigJQgQ0xJIOuhnOq3uOyVhOybgyAoY29kZSAnICsgY29kZSArICcpIOKGkiDroZzqt7jsnbgg7LC97J2EIOyXveuLiOuLpC4nKTsNCiAgICAgICAgICBpZiAoIWxvZ2luUHJvYykgc3RhcnRMb2dpbigpOw0KICAgICAgICB9KTsNCiAgICAgICAgbG9naW5TdGFydGVkQXQgPSBEYXRlLm5vdygpOw0KICAgICAgICByZXR1cm4ganNvbihyZXMsIDIwMCwgeyBvazogdHJ1ZSwgbW9kZTogJ2Jyb3dzZXItc3dpdGNoJyB9KTsNCiAgICAgIH0NCiAgICAgIC8vIOunjOujjCDsnqzroZzqt7jsnbgg4oCUIOqwmeydgCDqs4TsoJXsnbTrnbwg7IS47IWY7J2EIOyngOyasOyngCDslYrqs6Ag6re464yA66GcIOyXsOuLpCjruaDrpbTri6QpDQogICAgICBzdGFydExvZ2luKCk7DQogICAgICAvLyDrgqHsnYAg7J6F7J6l6raM7J2EIOusvOqzoCDsnojripQg64yA6riwIOyEuOyFmOydgCDrsoTrprDri6Qg4oCUIOyerOuhnOq3uOyduCDtm4Qg64uk7J2MIOyalOyyreydtCDsg4gg7IS47IWYKOyDiCDsnoXsnqXqtowp7Jy866GcIOyLnOyeke2VmOqyjC4NCiAgICAgIC8vIOydmOuPhOyggSDsooXro4wocmVhc29uIOyngOyglSkg4oCUIFNFU1NJT05fRElFROuhnCDrgZ3rgrTrqbQg7J6Q64+ZIOyerOyLnOuPhOqwgCDsmJsg6rOE7KCVIOyEuOyFmOydhCDrkJjsgrTroKQNCiAgICAgIC8vIOyerOuhnOq3uOyduCDrkqTsl5Drj4QgTUFYX1RVUk5T6rmM7KeAIOyYmyDqs4TsoJXsnLzroZwg7LKY66as65CY64qUIOuyhOq3uOqwgCDrkJzri6QgKDIwMjYtMDcg66as67ew7JeQ7IScIO2ZleyduCkNCiAgICAgIGtpbGxQcm9jKCfroZzqt7jsnbjsnYQg7KeE7ZaJ7ZWY64qUIOykkeydtOudvCDsmpTssq3snYQg7KSR64uo7ZaI7Ja07JqUIOKAlCDroZzqt7jsnbgg7ZuEIOuLpOyLnCDsi5zrj4TtlbQg7KO87IS47JqULicpOw0KICAgICAgYWNjb3VudENhY2hlLmF0ID0gMDsNCiAgICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDruIzrnbzsmrDsoIAg66Gc6re47J24IOyLnOyekScgKyAoc3dpdGNoTW9kZSA/ICcgKOqzhOyglSDsoITtmZgg4oCUIOyKueyduCDtmZTrqbTsnbQg65yo66m0IOq3uCDtmZTrqbQg7ZWY64uoIFvqs4TsoJUg7KCE7ZmYXeycvOuhnCDri6Trpbgg6rOE7KCV7J2EIOqzoOulvCDsiJgg7J6I7Ja07JqUKScgOiAnJykgKyAnIOKAlCDroZzqt7jsnbjtlZjrqbQg7J6Q64+ZIOyXsOqysOuQqeuLiOuLpC4nKTsNCiAgICAgIHJldHVybiBqc29uKHJlcywgMjAwLCB7IG9rOiB0cnVlLCBtb2RlOiBzd2l0Y2hNb2RlID8gJ2Jyb3dzZXItc3dpdGNoJyA6ICdicm93c2VyJyB9KTsNCiAgICB9IGNhdGNoIChlKSB7DQogICAgICByZXR1cm4ganNvbihyZXMsIDUwMCwgeyBlcnJvcjogJ+uhnOq3uOyduCDssL3snYQg66q7IOyXtOyXiOyWtOyalDogJyArIGUubWVzc2FnZSB9KTsNCiAgICB9DQogIH0NCiAgLy8gKO2EsOuvuOuEkCDtj7TrsLEg6rWs7ZiE67aAIOKAlCDruIzrnbzsmrDsoIAg7J6Q64+ZIOyZhOujjOqwgCDslYgg65CY64qUIO2ZmOqyvSDsoITsmqkpDQogIGZ1bmN0aW9uIG9wZW5Mb2dpblRlcm1pbmFsKCkgew0KICAgIHsNCiAgICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInKSB7DQogICAgICAgIC8vIHN0YXJ06rCAIOyDiCDsvZjshpQg7LC97J2EIOunjOuToOuLpCAo64uk66as7J2YIOyIqOydgCDsvZjshpTqs7wg66y06rSA7ZWY6rKMIOyCrOyaqeyekOyXkOqyjCDrs7TsnoQpLg0KICAgICAgICAvLyDsnbTslrTshJwgUG93ZXJTaGVsbCgucHMxKeydtCA17LSIIOuSpCDqt7gg7LC97JeQIOyXlO2EsOulvCDrs7TrgrQgMeuyiCjqtazrj4Ug6rOE7KCVKeydhCDsnpDrj5kg7ISg7YOd7ZWY6rOgLA0KICAgICAgICAvLyDssL3snYQg7LWc7IaM7ZmU7ZW0IOyCrOyaqeyekCDriIjsl5Qg67iM65287Jqw7KCAIOuhnOq3uOyduOunjCDrgqjqsowg7ZWc64ukLiDssL3snYQg66q7IOywvuycvOuptCDslYTrrLTqsoPrj4Qg7JWIIO2VnOuLpA0KICAgICAgICAvLyAo64uk66W4IOywvSDsmKTsnoXroKUg67Cp7KeAIOKAlCDqt7gg6rK97JqwIOuplOuJtOqwgCDrs7TsnbTripQg7LGE66GcIOuCqOqzoCDsgqzsmqnsnpDqsIAg7JeU7YSwIO2VnCDrsogg64iE66W066m0IOuQqCkuDQogICAgICAgIC8vIOyjvOydmDogY2xhdWRl6rCAIOy9mOyGlCDsoJzrqqnsnYQg67CU6r6466m0IEFwcEFjdGl2YXRlL0ZpbmRXaW5kb3fqsIAg66q7IOywvuydhCDsiJgg7J6I7J2MIOKAlCDsnIjrj4TsmrAg7Iuk6riw7JeQ7IScIO2ZleyduCDtlYTsmpQuDQogICAgICAgIGNvbnN0IHBzMSA9IHBhdGguam9pbihvcy50bXBkaXIoKSwgJ2NsYXVkZS1icmlkZ2UtbG9naW4ucHMxJyk7DQogICAgICAgIGZzLndyaXRlRmlsZVN5bmMocHMxLCBbDQogICAgICAgICAgJ1N0YXJ0LVNsZWVwIC1TZWNvbmRzIDUnLA0KICAgICAgICAgICckd3MgPSBOZXctT2JqZWN0IC1Db21PYmplY3QgV1NjcmlwdC5TaGVsbCcsDQogICAgICAgICAgImlmICgkd3MuQXBwQWN0aXZhdGUoJ2NsYXVkZS1sb2dpbicpKSB7IiwNCiAgICAgICAgICAiICAkd3MuU2VuZEtleXMoJ34nKSIsDQogICAgICAgICAgJyAgU3RhcnQtU2xlZXAgLVNlY29uZHMgMicsDQogICAgICAgICAgIiAgQWRkLVR5cGUgLU5hbWVzcGFjZSBVIC1OYW1lIFcgLU1lbWJlckRlZmluaXRpb24gJ1tEbGxJbXBvcnQoXCJ1c2VyMzIuZGxsXCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBTeXN0ZW0uSW50UHRyIEZpbmRXaW5kb3coc3RyaW5nIGMsIHN0cmluZyB0KTsgW0RsbEltcG9ydChcInVzZXIzMi5kbGxcIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2hvd1dpbmRvdyhTeXN0ZW0uSW50UHRyIGgsIGludCBuKTsnIiwNCiAgICAgICAgICAiICAkaCA9IFtVLlddOjpGaW5kV2luZG93KFtOdWxsU3RyaW5nXTo6VmFsdWUsICdjbGF1ZGUtbG9naW4nKSIsDQogICAgICAgICAgJyAgaWYgKCRoIC1uZSBbU3lzdGVtLkludFB0cl06Olplcm8pIHsgW3ZvaWRdW1UuV106OlNob3dXaW5kb3coJGgsIDYpIH0nLCAvLyA2ID0gU1dfTUlOSU1JWkUNCiAgICAgICAgICAnfScsDQogICAgICAgIF0uam9pbignXHJcbicpICsgJ1xyXG4nKTsNCiAgICAgICAgY29uc3QgYmF0ID0gcGF0aC5qb2luKG9zLnRtcGRpcigpLCAnY2xhdWRlLWJyaWRnZS1sb2dpbi5iYXQnKTsNCiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhiYXQsICdAZWNobyBvZmZcclxuJyArDQogICAgICAgICAgJ3N0YXJ0ICJjbGF1ZGUtbG9naW4iIGNtZCAvayBjbGF1ZGUgL2xvZ2luXHJcbicgKw0KICAgICAgICAgICdwb3dlcnNoZWxsIC1Ob1Byb2ZpbGUgLUV4ZWN1dGlvblBvbGljeSBCeXBhc3MgLUZpbGUgIicgKyBwczEgKyAnIlxyXG4nKTsNCiAgICAgICAgc3Bhd24oJ2NtZCcsIFsnL2MnLCBiYXRdLCB7IGVudjogQ0xBVURFX0VOViwgc3RkaW86ICdpZ25vcmUnLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTsNCiAgICAgIH0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2RhcndpbicpIHsNCiAgICAgICAgLy8gcHR5KGV4cGVjdCnroZwg67O064K4IO2CpOyXkCDtgbTroZzrk5wgVFVJ6rCAIOustOuwmOydkeyduCDqsoPsnbQg7Iuk7LihIO2ZleyduOuQqCgyMDI2LTA3LCDsnbzrsJggXHLCt2tpdHR5IOy9lOuTnCDrqqjrkZApIOKAlA0KICAgICAgICAvLyDsnKDsnbztlZwg7J6Q64+Z7ZmUIOqyveuhnOuKlCBTeXN0ZW0gRXZlbnRz7J2YIOynhOynnCDtgqQg7J6F66ClLiDsoJHqt7zshLEg6raM7ZWc7J20IOyeiOycvOuptCA27LSIIOuSpCDsl5TthLDqsIAg7J6Q64+ZIOyeheugpeuPvA0KICAgICAgICAvLyAx67KIKOq1rOuPhSDqs4TsoJUp7J20IOyEoO2DneuQmOqzoCwg6raM7ZWc7J20IOyXhuycvOuptCBrZXlzdHJva2Ug7KSE66eMIOyhsOyaqe2eiCDsi6TtjKjtlbQg7IKs7Jqp7J6Q6rCAIOyXlO2EsCDtlZwg67KIIOuIhOultOuptCDrkJzri6QoZmFpbC1zb2Z0KS4NCiAgICAgICAgLy8g7JeU7YSwIOyngeyghOyXkCBUZXJtaW5hbOydhCDri6Tsi5wg7JWe7Jy866GcIOqwgOyguOyZgCDri6Trpbgg7JWx7JeQIO2CpOqwgCDrk6TslrTqsIDripQg6rKD7J2EIOunieuKlOuLpC4NCiAgICAgICAgc3Bhd24oJ29zYXNjcmlwdCcsIFsNCiAgICAgICAgICAnLWUnLCAndGVsbCBhcHBsaWNhdGlvbiAiVGVybWluYWwiIHRvIGRvIHNjcmlwdCAiY2xhdWRlIC9sb2dpbiInLA0KICAgICAgICAgICctZScsICd0ZWxsIGFwcGxpY2F0aW9uICJUZXJtaW5hbCIgdG8gYWN0aXZhdGUnLA0KICAgICAgICAgICctZScsICdkZWxheSA2JywNCiAgICAgICAgICAnLWUnLCAndGVsbCBhcHBsaWNhdGlvbiAiVGVybWluYWwiIHRvIGFjdGl2YXRlJywNCiAgICAgICAgICAnLWUnLCAnZGVsYXkgMC4zJywNCiAgICAgICAgICAnLWUnLCAndGVsbCBhcHBsaWNhdGlvbiAiU3lzdGVtIEV2ZW50cyIgdG8ga2V5c3Ryb2tlIHJldHVybicsDQogICAgICAgICAgLy8g7JeU7YSw6rCAIOyLpOygnOuhnCDrk6TslrTqsIQg6rK97Jqw7JeQ66eMIOyXrOq4sCDrj4Tri6wo6raM7ZWcIOyXhuycvOuptCDsnITsl5DshJwg7KSR64uoKSDigJQg7YSw66+464SQ7J2EIOy5mOybjCDruIzrnbzsmrDsoIDrp4wg64Ko6ri064ukDQogICAgICAgICAgJy1lJywgJ2RlbGF5IDEuNScsDQogICAgICAgICAgJy1lJywgJ3RlbGwgYXBwbGljYXRpb24gIlRlcm1pbmFsIiB0byBzZXQgbWluaWF0dXJpemVkIG9mIGZyb250IHdpbmRvdyB0byB0cnVlJywNCiAgICAgICAgXSwgeyBzdGRpbzogJ2lnbm9yZScgfSk7DQogICAgICB9IGVsc2Ugew0KICAgICAgICByZXR1cm4gZmFsc2U7IC8vIOyngOybkCDslYgg7ZWY64qUIE9TDQogICAgICB9DQogICAgICByZXR1cm4gdHJ1ZTsNCiAgICB9DQogIH0NCiAgLy8g7YG066Gc65OcIOqzhOyglSDroZzqt7jslYTsm4Mg4oCUIO2UjOufrOq3uOyduCDtmYjsnZggW+uhnOq3uOyVhOybg10g67KE7Yq87J20IO2YuOy2nC4gY2xhdWRlIGF1dGggbG9nb3V07Jy866GcIENMSSDroZzqt7jsnbjsnYQg7ZW07KCc7ZWc64ukLg0KICAvLyAo7J20IFBD7J2YIOyggOyepeuQnCDsnpDqsqnspp3rqoXsnYQg7KeA7Jq064ukIOKAlCDri6Tsi5wg7JOw66Ck66m0IOyerOuhnOq3uOyduCDtlYTsmpQuKSDroZzqt7jslYTsm4Mg7ZuE7JeUIOyEuOyFmMK36rOE7KCV7LqQ7Iuc66W8IOygleumrO2VnOuLpC4NCiAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiByZXEudXJsID09PSAnL2NsYXVkZS1sb2dvdXQnKSB7DQogICAgY29uc3QgbG8gPSBzcGF3bignY2xhdWRlJywgWydhdXRoJywgJ2xvZ291dCddLCB7IHNoZWxsOiB0cnVlLCBlbnY6IENMQVVERV9FTlYsIHdpbmRvd3NIaWRlOiB0cnVlIH0pOw0KICAgIGxldCBlcnIgPSAnJzsNCiAgICBsby5zdGRlcnIub24oJ2RhdGEnLCAoZCkgPT4geyBlcnIgKz0gZC50b1N0cmluZygpOyB9KTsNCiAgICBsby5vbignZXJyb3InLCAoZSkgPT4geyBqc29uKHJlcywgNTAwLCB7IG9rOiBmYWxzZSwgZXJyb3I6ICfroZzqt7jslYTsm4Mg7Iuk7ZaJIOyLpO2MqDogJyArIGUubWVzc2FnZSB9KTsgfSk7DQogICAgbG8ub24oJ2Nsb3NlJywgKGNvZGUpID0+IHsNCiAgICAgIGtpbGxQcm9jKCfroZzqt7jslYTsm4PtlbTshJwg7JqU7LKt7J2EIOykkeuLqO2WiOyWtOyalC4nKTsgLy8g7J2Y64+E7KCBIOyiheujjCDigJQg7J6Q64+ZIOyerOyLnOuPhOqwgCDshLjshZjsnYQg65CY7IK066as66m0IOyViCDrkKgNCiAgICAgIGFjY291bnRDYWNoZS5hdCA9IDA7ICAgICAgICAvLyDri6TsnYwgL2FjY291bnTCty9oZWFsdGjsl5DshJwg6rOE7KCV7J2EIOyDiOuhnCg97JeG7J2M7Jy866GcKSDsnb3qsowNCiAgICAgIGNsYXVkZVN0YXR1cyA9IG51bGw7ICAgICAgICAvLyDsg4Htg5wg7J6s7YyQ7KCVKOuLpOydjCDthLTsl5DshJwg66+466Gc6re47J24IOqwkOyngCkNCiAgICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDtgbTroZzrk5wg66Gc6re47JWE7JuDIChjb2RlICcgKyBjb2RlICsgJyknKTsNCiAgICAgIGlmIChyZXMuaGVhZGVyc1NlbnQpIHJldHVybjsgLy8gZXJyb3Ig7ZW465Ok65+s6rCAIOydtOuvuCDsnZHri7XtlojsnLzrqbQg7KSR67O1IOuwqeyngA0KICAgICAgaWYgKGNvZGUgPT09IDApIGpzb24ocmVzLCAyMDAsIHsgb2s6IHRydWUgfSk7DQogICAgICBlbHNlIGpzb24ocmVzLCA1MDAsIHsgb2s6IGZhbHNlLCBlcnJvcjogKGVyci50cmltKCkuc2xpY2UoMCwgMTUwKSkgfHwgKCfsooXro4wg7L2U65OcICcgKyBjb2RlKSB9KTsNCiAgICB9KTsNCiAgICByZXR1cm47DQogIH0NCiAgLy8g7J6Q6riwIOyiheujjCDigJQg7ZSM65+s6re47J24IFNUT1BfQlJJREdFL+2VmO2KuOu5hO2KuOqwgCDtmLjstpztlZzri6QgKOuhnOy7rOyXkOyEnOunjCDsoJHqt7wg6rCA64ql7ZWY64uIIOyViOyghCkNCiAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiByZXEudXJsID09PSAnL3NodXRkb3duJykgew0KICAgIGpzb24ocmVzLCAyMDAsIHsgb2s6IHRydWUgfSk7DQogICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIOyiheujjCDsmpTssq0g67Cb7J2MIOKAlCDri6Trpqzrpbwg64GV64uI64ukLicpOw0KICAgIHNodXR0aW5nRG93biA9IHRydWU7DQogICAga2lsbFByb2MoKTsNCiAgICBzZXRUaW1lb3V0KCgpID0+IGhhcmRFeGl0KDApLCAyMDApOw0KICAgIHJldHVybjsNCiAgfQ0KICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHJlcS51cmwgPT09ICcvcmVjb21tZW5kJykgew0KICAgIGNvbnN0IHsgdGV4dCwgbW9kZWwsIHJvbGUgfSA9IGF3YWl0IHJlYWRCb2R5KHJlcSk7DQogICAgaWYgKCF0ZXh0IHx8ICFTdHJpbmcodGV4dCkudHJpbSgpKSByZXR1cm4ganNvbihyZXMsIDQwMCwgeyBlcnJvcjogJ+y2lOyynOuwm+ydhCDrrLjqtazqsIAg67mE7Ja0IOyeiOyKteuLiOuLpC4nIH0pOw0KICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpOw0KICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDstpTsspwg7JqU7LKtOicsIFN0cmluZyh0ZXh0KS5zbGljZSgwLCA1MCkucmVwbGFjZSgvXG4vZywgJyAnKSArICfigKYnLCByb2xlID8gJ1snICsgcm9sZSArICddJyA6ICcnLCBtb2RlbCA/ICco66qo6424OiAnICsgbW9kZWwgKyAnKScgOiAnJyk7DQogICAgdHJ5IHsNCiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhc2tDbGF1ZGUoU3RyaW5nKHRleHQpLnRyaW0oKSwgbW9kZWwsIHsgcGFyc2U6IHBhcnNlU3VnZ2VzdGlvbnMsIGZvcm1hdERlc2M6ICdbeyJ0ZXh0IjogIuusuOq1rCIsICJyZWFzb24iOiAi7J207JygIn0sIC4uLl0nIH0sIHJvbGUpOw0KICAgICAgY29uc3Qgc3VnZ2VzdGlvbnMgPSByLnBhcnNlZCB8fCBbXTsNCiAgICAgIGNvbnN0IHNlYyA9ICgoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQpIC8gMTAwMCkudG9GaXhlZCgxKTsNCiAgICAgIGlmICghc3VnZ2VzdGlvbnMubGVuZ3RoKSB7DQogICAgICAgIHJldHVybiBqc29uKHJlcywgNTAyLCB7IGVycm9yOiAn7YG066Gc65OcIOydkeuLteydhCDtlbTshJ3tlZjsp4Ag66q77ZaI7Ja07JqULicgfSk7DQogICAgICB9DQogICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g7KCc7JWIICcgKyBzdWdnZXN0aW9ucy5sZW5ndGggKyAn6rCcICgnICsgc2VjICsgJ3MpJyk7DQogICAgICBzdGF0cy5zZXJ2ZWQrKzsNCiAgICAgIHN0YXRzLmxhc3RBdCA9IG5ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCdrby1LUicpOw0KICAgICAgc3RhdHMubGFzdFRleHQgPSBTdHJpbmcodGV4dCkuc2xpY2UoMCwgMzApOw0KICAgICAgc3RhdHMubGFzdFNlYyA9IHNlYzsNCiAgICAgIHJldHVybiBqc29uKHJlcywgMjAwLCB7IHN1Z2dlc3Rpb25zLCBlbmdpbmU6ICdjbGF1ZGUnIH0pOw0KICAgIH0gY2F0Y2ggKGUpIHsNCiAgICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDsi6TtjKg6JywgZS5tZXNzYWdlKTsNCiAgICAgIHJldHVybiBqc29uKHJlcywgNTAyLCBmcmllbmRseUVycm9yKGUsICftgbTroZzrk5wg7Zi47LacIOyLpO2MqDogJykpOw0KICAgIH0NCiAgfQ0KICAvLyDtlITroIjsnoTrs4Qg7LaU7LKcIOKAlCDtlZwg7ZmU66m07J2EIO2VmOychCDtlITroIjsnoQo7JiB7JetKSDri6jsnITroZwg64KY64igIOuwm+qzoCwg7JiB7Jet66eI64ukIOuUsOuhnCDrjIDslYjsnYQg64K464ukLg0KICAvLyDsmIHsl60g7IiY66eM7YG8IOyalOyyreydhCDsqrzqsJzsp4Ag7JWK64qUIOqyg+ydtCDtlbXsi6wgKOuKkOugpOyngOqzoCDsgqzsmqnrn4nrj4Qg6re466eM7YG8IOuCmOqwhOuLpCkuDQogIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgcmVxLnVybCA9PT0gJy9yZWNvbW1lbmQtZ3JvdXBzJykgew0KICAgIGNvbnN0IHsgZ3JvdXBzLCBtb2RlbCwgbW9yZSB9ID0gYXdhaXQgcmVhZEJvZHkocmVxKTsNCiAgICBjb25zdCBsaXN0ID0gQXJyYXkuaXNBcnJheShncm91cHMpDQogICAgICA/IGdyb3Vwcw0KICAgICAgICAgIC5tYXAoKGcpID0+ICh7DQogICAgICAgICAgICBuYW1lOiBTdHJpbmcoKGcgJiYgZy5uYW1lKSB8fCAnJykudHJpbSgpLA0KICAgICAgICAgICAgdGV4dHM6IChnICYmIEFycmF5LmlzQXJyYXkoZy50ZXh0cykgPyBnLnRleHRzIDogW10pLm1hcCgodCkgPT4gU3RyaW5nKHQgfHwgJycpLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pLA0KICAgICAgICAgICAgcm9sZTogKGcgJiYgZy5yb2xlKSA/IFN0cmluZyhnLnJvbGUpIDogdW5kZWZpbmVkLA0KICAgICAgICAgIH0pKQ0KICAgICAgICAgIC5maWx0ZXIoKGcpID0+IGcudGV4dHMubGVuZ3RoKQ0KICAgICAgOiBbXTsNCiAgICBpZiAobGlzdC5sZW5ndGggPCAyKSByZXR1cm4ganNvbihyZXMsIDQwMCwgeyBlcnJvcjogJ+yYgeyXreydtCDrtoDsobHtlanri4jri6QuJyB9KTsNCiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTsNCiAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g7ZSE66CI7J6E67OEIOy2lOyynCDsmpTssq06IOyYgeyXrSAnICsgbGlzdC5sZW5ndGggKyAn6rCcJyArIChtb3JlID8gJyAo642UIOuwm+q4sCknIDogJycpLCBtb2RlbCA/ICco66qo6424OiAnICsgbW9kZWwgKyAnKScgOiAnJyk7DQogICAgdHJ5IHsNCiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhc2tHcm91cHMobGlzdCwgbW9kZWwsIHsgcGFyc2U6IHBhcnNlR3JvdXBzLCBmb3JtYXREZXNjOiAneyJncm91cHMiOiBbeyJuYW1lIjogIuyYgeyXrSDsnbTrpoQiLCAic3VnZ2VzdGlvbnMiOiBbeyJ0ZXh0IjogIuuMgOyViCIsICJyZWFzb24iOiAi7J207JygIn1dfV19JyB9LCAhIW1vcmUpOw0KICAgICAgY29uc3Qgb3V0ID0gci5wYXJzZWQ7DQogICAgICBjb25zdCBzZWMgPSAoKERhdGUubm93KCkgLSBzdGFydGVkKSAvIDEwMDApLnRvRml4ZWQoMSk7DQogICAgICBpZiAoIW91dCkgcmV0dXJuIGpzb24ocmVzLCA1MDIsIHsgZXJyb3I6ICftgbTroZzrk5wg7J2R64u17J2EIO2VtOyEne2VmOyngCDrqrvtlojslrTsmpQuJyB9KTsNCiAgICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDtlITroIjsnoTrs4Qg7KCc7JWIICcgKyBvdXQucmVkdWNlKChuLCBnKSA9PiBuICsgZy5zdWdnZXN0aW9ucy5sZW5ndGgsIDApICsgJ+qwnCAvIOyYgeyXrSAnICsgb3V0Lmxlbmd0aCArICfqsJwgKCcgKyBzZWMgKyAncyknKTsNCiAgICAgIHN0YXRzLnNlcnZlZCsrOw0KICAgICAgc3RhdHMubGFzdEF0ID0gbmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoJ2tvLUtSJyk7DQogICAgICBzdGF0cy5sYXN0VGV4dCA9ICdb7ZSE66CI7J6E67OEXSAnICsgU3RyaW5nKChsaXN0WzBdICYmIGxpc3RbMF0udGV4dHNbMF0pIHx8ICcnKS5zbGljZSgwLCAyNCk7DQogICAgICBzdGF0cy5sYXN0U2VjID0gc2VjOw0KICAgICAgcmV0dXJuIGpzb24ocmVzLCAyMDAsIHsgZ3JvdXBzOiBvdXQsIGVuZ2luZTogJ2NsYXVkZScgfSk7DQogICAgfSBjYXRjaCAoZSkgew0KICAgICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIO2UhOugiOyehOuzhCDstpTsspwg7Iuk7YyoOicsIGUubWVzc2FnZSk7DQogICAgICByZXR1cm4ganNvbihyZXMsIDUwMiwgZnJpZW5kbHlFcnJvcihlLCAn7YG066Gc65OcIO2YuOy2nCDsi6TtjKg6ICcpKTsNCiAgICB9DQogIH0NCiAgLy8g7Yyd7JeFIOyalOyGjOuzhCDstpTsspwg4oCUIO2VnCDtjJ3sl4XsnZgg6rWs7ISx7JqU7IaMKOyXre2VoCvrrLjqtawp66W8IO2VnCDrsojsl5Ag67Cb7JWEIOyXre2VoOuzhOuhnCDri6Trk6zripTri6QuDQogIC8vIOyalOyGjOulvCDtlajqu5gg67O064K07JW8IO2DgOydtO2LgOydtCDrs7jrrLgg66el65297J2EIOywuOyhsO2VoCDsiJgg7J6I64ukKOyalOyGjOuzhCDqsJzrs4Qg7JqU7LKt6rO87J2YIOywqOydtCkuDQogIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgcmVxLnVybCA9PT0gJy9yZWNvbW1lbmQtcG9wdXAnKSB7DQogICAgY29uc3QgeyBlbGVtZW50cywgbW9kZWwsIG1vcmUgfSA9IGF3YWl0IHJlYWRCb2R5KHJlcSk7DQogICAgY29uc3QgbGlzdCA9IEFycmF5LmlzQXJyYXkoZWxlbWVudHMpID8gZWxlbWVudHMuZmlsdGVyKChlKSA9PiBlICYmIFN0cmluZyhlLnRleHQgfHwgJycpLnRyaW0oKSkgOiBbXTsNCiAgICBpZiAobGlzdC5sZW5ndGggPCAyKSByZXR1cm4ganNvbihyZXMsIDQwMCwgeyBlcnJvcjogJ+2MneyXhSDsmpTshozqsIAg67aA7KGx7ZWp64uI64ukLicgfSk7DQogICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7DQogICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIO2MneyXhSDstpTsspwg7JqU7LKtOiDsmpTshowgJyArIGxpc3QubGVuZ3RoICsgJ+qwnCcgKyAobW9yZSA/ICcgKOuNlCDrsJvquLApJyA6ICcnKSwgbW9kZWwgPyAnKOuqqOuNuDogJyArIG1vZGVsICsgJyknIDogJycpOw0KICAgIHRyeSB7DQogICAgICBjb25zdCByID0gYXdhaXQgYXNrUG9wdXAobGlzdCwgbW9kZWwsIHsgcGFyc2U6IHBhcnNlUG9wdXAsIGZvcm1hdERlc2M6ICd7InNldHMiOiBbeyJyZWFzb24iOiAi67Cp7ZalIO2VnCDrrLjsnqUiLCAiZWxlbWVudHMiOiBbeyJyb2xlIjogIuyXre2VoCIsICJ0ZXh0IjogIuusuOq1rCJ9LCAuLi5dfSwgLi4uXX0nIH0sICEhbW9yZSk7DQogICAgICBjb25zdCBzZXRzID0gci5wYXJzZWQ7DQogICAgICBjb25zdCBzZWMgPSAoKERhdGUubm93KCkgLSBzdGFydGVkKSAvIDEwMDApLnRvRml4ZWQoMSk7DQogICAgICBpZiAoIXNldHMpIHsNCiAgICAgICAgcmV0dXJuIGpzb24ocmVzLCA1MDIsIHsgZXJyb3I6ICftgbTroZzrk5wg7J2R64u17J2EIO2VtOyEne2VmOyngCDrqrvtlojslrTsmpQuJyB9KTsNCiAgICAgIH0NCiAgICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDtjJ3sl4Ug7IS47Yq4ICcgKyBzZXRzLmxlbmd0aCArICfqsJwgKCcgKyBzZWMgKyAncyknKTsNCiAgICAgIHN0YXRzLnNlcnZlZCsrOw0KICAgICAgc3RhdHMubGFzdEF0ID0gbmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoJ2tvLUtSJyk7DQogICAgICBzdGF0cy5sYXN0VGV4dCA9ICdb7Yyd7JeFXSAnICsgU3RyaW5nKChsaXN0WzBdICYmIGxpc3RbMF0udGV4dCkgfHwgJycpLnNsaWNlKDAsIDI0KTsNCiAgICAgIHN0YXRzLmxhc3RTZWMgPSBzZWM7DQogICAgICByZXR1cm4ganNvbihyZXMsIDIwMCwgeyBzZXRzLCBlbmdpbmU6ICdjbGF1ZGUnIH0pOw0KICAgIH0gY2F0Y2ggKGUpIHsNCiAgICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDtjJ3sl4Ug7Iuk7YyoOicsIGUubWVzc2FnZSk7DQogICAgICByZXR1cm4ganNvbihyZXMsIDUwMiwgZnJpZW5kbHlFcnJvcihlLCAn7YG066Gc65OcIO2YuOy2nCDsi6TtjKg6ICcpKTsNCiAgICB9DQogIH0NCiAgLy8g64yA7ZmU7ZiVIOusuOq1rCDsoJzsnpEg4oCUIOyDge2ZqeydhCDshKTrqoXtlZjrqbQg66y46rWs66W8IOunjOuTpOyWtOykgOuLpCAo7LaU7LKc6rO8IOqwmeydgCDshLjshZgsIOuMgO2ZlOuKlCDrp6Qg7JqU7LKt7JeQIO2GteynuOuhnCDsi6TrprwpDQogIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgcmVxLnVybCA9PT0gJy9jb21wb3NlJykgew0KICAgIGNvbnN0IHsgbWVzc2FnZXMsIG1vZGVsIH0gPSBhd2FpdCByZWFkQm9keShyZXEpOw0KICAgIGNvbnN0IGxpc3QgPSBBcnJheS5pc0FycmF5KG1lc3NhZ2VzKSA/IG1lc3NhZ2VzLmZpbHRlcigobSkgPT4gbSAmJiBTdHJpbmcobS50ZXh0IHx8ICcnKS50cmltKCkpIDogW107DQogICAgaWYgKCFsaXN0Lmxlbmd0aCkgcmV0dXJuIGpzb24ocmVzLCA0MDAsIHsgZXJyb3I6ICfrjIDtmZQg64K07Jqp7J20IOu5hOyWtCDsnojsirXri4jri6QuJyB9KTsNCiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTsNCiAgICBjb25zdCBsYXN0VXNlciA9IFsuLi5saXN0XS5yZXZlcnNlKCkuZmluZCgobSkgPT4gbS5yb2xlICE9PSAnYXNzaXN0YW50Jyk7DQogICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIOygnOyekSDrjIDtmZQg7JqU7LKtOicsIFN0cmluZygobGFzdFVzZXIgJiYgbGFzdFVzZXIudGV4dCkgfHwgJycpLnNsaWNlKDAsIDUwKS5yZXBsYWNlKC9cbi9nLCAnICcpICsgJ+KApiAo64yA7ZmUICcgKyBsaXN0Lmxlbmd0aCArICfqsJwpJyk7DQogICAgdHJ5IHsNCiAgICAgIC8vIOuMgO2ZlOqwgCDquLjslrTsp4DrqbQg7LWc6re8IDEy6rCc66eMICjtlITroaztlITtirgg7Y+t7KO8IOuwqeyngCkNCiAgICAgIGNvbnN0IHIgPSBhd2FpdCBhc2tDb21wb3NlKGxpc3Quc2xpY2UoLTEyKSwgbW9kZWwsIHsgcGFyc2U6IHBhcnNlQ29tcG9zZSwgZm9ybWF0RGVzYzogJ3sicmVwbHkiOiAi64yA7ZmUIOydkeuLtSDtlZzrkZAg66y47J6lIiwgInN1Z2dlc3Rpb25zIjogW3sidGV4dCI6ICLrrLjqtawiLCAicmVhc29uIjogIuydtOycoCJ9LCAuLi5dfScgfSk7DQogICAgICBjb25zdCBvdXQgPSByLnBhcnNlZDsNCiAgICAgIGNvbnN0IHNlYyA9ICgoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQpIC8gMTAwMCkudG9GaXhlZCgxKTsNCiAgICAgIGlmICghb3V0KSB7DQogICAgICAgIHJldHVybiBqc29uKHJlcywgNTAyLCB7IGVycm9yOiAn7YG066Gc65OcIOydkeuLteydhCDtlbTshJ3tlZjsp4Ag66q77ZaI7Ja07JqULicgfSk7DQogICAgICB9DQogICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g7KCc7J6RIOydkeuLtSAoJyArIHNlYyArICdzLCDsoJzslYggJyArIG91dC5zdWdnZXN0aW9ucy5sZW5ndGggKyAn6rCcKScpOw0KICAgICAgc3RhdHMuc2VydmVkKys7DQogICAgICBzdGF0cy5sYXN0QXQgPSBuZXcgRGF0ZSgpLnRvTG9jYWxlVGltZVN0cmluZygna28tS1InKTsNCiAgICAgIHN0YXRzLmxhc3RUZXh0ID0gU3RyaW5nKChsYXN0VXNlciAmJiBsYXN0VXNlci50ZXh0KSB8fCAnJykuc2xpY2UoMCwgMzApOw0KICAgICAgc3RhdHMubGFzdFNlYyA9IHNlYzsNCiAgICAgIHJldHVybiBqc29uKHJlcywgMjAwLCB7IHJlcGx5OiBvdXQucmVwbHksIHN1Z2dlc3Rpb25zOiBvdXQuc3VnZ2VzdGlvbnMsIGVuZ2luZTogJ2NsYXVkZScgfSk7DQogICAgfSBjYXRjaCAoZSkgew0KICAgICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIOygnOyekSDsi6TtjKg6JywgZS5tZXNzYWdlKTsNCiAgICAgIHJldHVybiBqc29uKHJlcywgNTAyLCBmcmllbmRseUVycm9yKGUsICftgbTroZzrk5wg7Zi47LacIOyLpO2MqDogJykpOw0KICAgIH0NCiAgfQ0KICAvLyDrsojsl60g4oCUIO2VnOq1reyWtCDihpQg7JiB7Ja0IOyekOuPmSAo7LaU7LKc6rO8IOqwmeydgCDshLjshZgg7IKs7JqpKQ0KICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHJlcS51cmwgPT09ICcvdHJhbnNsYXRlJykgew0KICAgIGNvbnN0IHsgdGV4dCwgbW9kZWwgfSA9IGF3YWl0IHJlYWRCb2R5KHJlcSk7DQogICAgaWYgKCF0ZXh0IHx8ICFTdHJpbmcodGV4dCkudHJpbSgpKSByZXR1cm4ganNvbihyZXMsIDQwMCwgeyBlcnJvcjogJ+uyiOyXre2VoCDrrLjqtazqsIAg67mE7Ja0IOyeiOyKteuLiOuLpC4nIH0pOw0KICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpOw0KICAgIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDrsojsl60g7JqU7LKtOicsIFN0cmluZyh0ZXh0KS5zbGljZSgwLCA1MCkucmVwbGFjZSgvXG4vZywgJyAnKSArICfigKYnKTsNCiAgICB0cnkgew0KICAgICAgY29uc3QgciA9IGF3YWl0IGFza1RyYW5zbGF0ZShTdHJpbmcodGV4dCkudHJpbSgpLCBtb2RlbCwgeyBwYXJzZTogcGFyc2VUcmFuc2xhdGUsIGZvcm1hdERlc2M6ICd7InRyYW5zbGF0ZWQiOiAi67KI7Jet66y4ICjspITrsJTqv4jsnYAgXFxuKSIsICJkaXJlY3Rpb24iOiAia2/ihpJlbiDrmJDripQgZW7ihpJrbyJ9JyB9KTsNCiAgICAgIGNvbnN0IG91dCA9IHIucGFyc2VkOw0KICAgICAgY29uc3Qgc2VjID0gKChEYXRlLm5vdygpIC0gc3RhcnRlZCkgLyAxMDAwKS50b0ZpeGVkKDEpOw0KICAgICAgaWYgKCFvdXQpIHsNCiAgICAgICAgcmV0dXJuIGpzb24ocmVzLCA1MDIsIHsgZXJyb3I6ICftgbTroZzrk5wg67KI7JetIOydkeuLteydhCDtlbTshJ3tlZjsp4Ag66q77ZaI7Ja07JqULicgfSk7DQogICAgICB9DQogICAgICBjb25zb2xlLmxvZygnW2JyaWRnZV0g67KI7JetIOyZhOujjCAoJyArIHNlYyArICdzLCAnICsgKG91dC5kaXJlY3Rpb24gfHwgJz8nKSArICcpJyk7DQogICAgICBzdGF0cy5zZXJ2ZWQrKzsNCiAgICAgIHN0YXRzLmxhc3RBdCA9IG5ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCdrby1LUicpOw0KICAgICAgc3RhdHMubGFzdFRleHQgPSBTdHJpbmcodGV4dCkuc2xpY2UoMCwgMzApOw0KICAgICAgc3RhdHMubGFzdFNlYyA9IHNlYzsNCiAgICAgIHJldHVybiBqc29uKHJlcywgMjAwLCB7IHRyYW5zbGF0ZWQ6IG91dC50cmFuc2xhdGVkLCBkaXJlY3Rpb246IG91dC5kaXJlY3Rpb24sIGVuZ2luZTogJ2NsYXVkZScgfSk7DQogICAgfSBjYXRjaCAoZSkgew0KICAgICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIOuyiOyXrSDsi6TtjKg6JywgZS5tZXNzYWdlKTsNCiAgICAgIHJldHVybiBqc29uKHJlcywgNTAyLCBmcmllbmRseUVycm9yKGUsICftgbTroZzrk5wg67KI7JetIOyLpO2MqDogJykpOw0KICAgIH0NCiAgfQ0KICByZXR1cm4ganNvbihyZXMsIDQwNCwgeyBlcnJvcjogJ05vdCBmb3VuZCcgfSk7DQp9KTsNCg0KLy8g7J2066+4IOuLpOumrOqwgCDrlqAg7J6I64qU642wIOuYkCDsvJzquLDqsIAg65Ok7Ja07Jik66m0KOygnOyKpOyymCDsnpDrj5kg7Lyc6riwIOykkeuztSDrk7EpIOyhsOyaqe2eiCDsooXro4wg4oCUIOuPjOuNmCDri6TrpqzripQg6re464yA66GcIOycoOyngA0Kc2VydmVyLm9uKCdlcnJvcicsIChlKSA9PiB7DQogIGlmIChlICYmIGUuY29kZSA9PT0gJ0VBRERSSU5VU0UnKSB7DQogICAgLy8g66y86rOgIOyeiOuKlCDsqr3snbQg7IK07JWEIOyeiOuKlOyngCDtlZwg67KIIOusvOyWtOuzuOuLpCDigJQg7J2R64u17J20IOyXhuycvOuptCDsooXro4wg64+E7KSRIOyWvOyWtOu2meydgCDsooDruYTri6QuDQogICAgLy8g6re4IOyCrOyLpOydhCDroZzqt7jsl5Ag64Ko6rKo7JW8ICLtj6ztirjripQg7J6h7ZiAIOyeiOuKlOuNsCDtlIzrn6zqt7jsnbjsnYAg7Jew64+ZIOyViCDrkKgi7J2EIOuLpOydjOyXkCDrsJTroZwg7JWM7JWE67O464ukLg0KICAgIGNvbnN0IHByb2JlID0gaHR0cC5yZXF1ZXN0KHsgaG9zdDogJzEyNy4wLjAuMScsIHBvcnQ6IFBPUlQsIHBhdGg6ICcvaGVhbHRoJywgbWV0aG9kOiAnR0VUJywgdGltZW91dDogMjAwMCB9LCAocikgPT4gew0KICAgICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIOydtOuvuCDsvJzsoLgg7J6I7Ja07JqUKO2PrO2KuCAnICsgUE9SVCArICcg7IKs7JqpIOykkSwg7J2R64u1ICcgKyByLnN0YXR1c0NvZGUgKyAnKSDigJQg7J20IOyduOyKpO2EtOyKpOuKlCDsooXro4ztlanri4jri6QuJyk7DQogICAgICBoYXJkRXhpdCgwKTsNCiAgICB9KTsNCiAgICBjb25zdCBkZWFkID0gKCkgPT4gew0KICAgICAgY29uc29sZS5sb2coJ1ticmlkZ2VdIO2PrO2KuCAnICsgUE9SVCArICfsnYQg7J2R64u1IOyXhuuKlCDtlITroZzshLjsiqTqsIAg66y86rOgIOyeiOyWtOyalCDigJQg6re4IO2UhOuhnOyEuOyKpOulvCDrgZ3rgrTslbwg7ZWp64uI64ukKOyekeyXhSDqtIDrpqzsnpDsl5DshJwgbm9kZSDsooXro4wpLicpOw0KICAgICAgaGFyZEV4aXQoMCk7DQogICAgfTsNCiAgICBwcm9iZS5vbignZXJyb3InLCBkZWFkKTsNCiAgICBwcm9iZS5vbigndGltZW91dCcsICgpID0+IHsgdHJ5IHsgcHJvYmUuZGVzdHJveSgpOyB9IGNhdGNoIChfZTIpIHt9IGRlYWQoKTsgfSk7DQogICAgcHJvYmUuZW5kKCk7DQogICAgcmV0dXJuOw0KICB9DQogIGNvbnNvbGUubG9nKCdbYnJpZGdlXSDshJzrsoQg7Jik66WYOicsIGUgJiYgZS5tZXNzYWdlKTsNCiAgcHJvY2Vzcy5leGl0KDEpOw0KfSk7DQovLyDslrTrlqQg6rK966Gc66GcIOyjveuToCjsi6zsnqXrsJXrj5kg64GK6rmALCBDdHJsK0MsIC9zaHV0ZG93biwg7Jik66WYKSBjbGF1ZGUg7J6Q7Iud7J2EIOuCqOq4sOyngCDslYrripTri6QNCnByb2Nlc3Mub24oJ2V4aXQnLCAoKSA9PiB7IGtpbGxQcm9jKCk7IGtpbGxMb2dpblByb2MoKTsgfSk7DQpwcm9jZXNzLm9uKCdTSUdJTlQnLCAoKSA9PiBoYXJkRXhpdCgwKSk7DQpwcm9jZXNzLm9uKCdTSUdURVJNJywgKCkgPT4gaGFyZEV4aXQoMCkpOw0KDQpzZXJ2ZXIubGlzdGVuKFBPUlQsICcxMjcuMC4wLjEnLCAoKSA9PiB7DQogIGNvbnNvbGUubG9nKCfilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAnKTsNCiAgY29uc29sZS5sb2coJyDtgbTroZzrk5wg64uk66asIOy8nOynkCDigJQgaHR0cDovL2xvY2FsaG9zdDonICsgUE9SVCk7DQogIGNvbnNvbGUubG9nKCcg66qo6424OiAnICsgQ0xBVURFX01PREVMICsgJyDCtyDsmIjsi5wgJyArIEVYQU1QTEVTLmxlbmd0aCArICfqsbQg7J6l7LCpJyk7DQogIGNvbnNvbGUubG9nKCcg7J20IOywveydhCDsvJzrkZQg64+Z7JWIIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg7YG066Gc65Oc66GcIOy2lOyynO2VqeuLiOuLpC4nKTsNCiAgY29uc29sZS5sb2coJ+KUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCcpOw0KICBjaGVja0NsYXVkZUF2YWlsYWJsZSgpOyAvLyBDbGF1ZGUgQ29kZSDsgqzsmqkg6rCA64qlIOyXrOu2gCDsoJDqsoAgKO2UjOufrOq3uOyduCDslYjrgrTsmqkpDQogIC8vIOuvuOumrCDsi5zrj5kgKyDsp4Dsi5zrrLgg7KO87J6FIOKAlCDssqsg7LaU7LKc67aA7YSwIOu5oOultOqyjA0KICBhc2tDbGF1ZGUoJ+ybjOuwjeyXhTogIuyggOyepSDrkJjsl4jsirXri4jri6QiJykudGhlbigNCiAgICAoKSA9PiBjb25zb2xlLmxvZygnW2JyaWRnZV0g7JuM67CN7JeFIOyZhOujjCDigJQg7LaU7LKcIOykgOu5hCDrgZ0uJyksDQogICAgKGUpID0+IGNvbnNvbGUubG9nKCdbYnJpZGdlXSDsm4zrsI3sl4Ug7Iuk7YyoICjssqsg7JqU7LKtIOuVjCDsnqzsi5zrj4QpOicsIGUubWVzc2FnZSkNCiAgKTsNCn0pOw0KLy8gSVB2NiDro6jtlITrsLEoOjoxKeyXkOuPhCDtlajqu5gg65Oj64qU64ukIOKAlCBtYWNPUyDrk7Hsl5DshJwgJ2xvY2FsaG9zdCfqsIAgOjox66GcIOuovOyggCDtlbTshJ3rkJjripTrjbANCi8vIO2UvOq3uOuniChFbGVjdHJvbikgZmV0Y2jripQgY3VybOqzvCDri6zrpqwgSVB2NOuhnCDsnpDrj5kg7Y+067Cx7ZWY7KeAIOyViuyVhCwgSVB2NOunjCDrk6PrjZgg64uk66as7JeQIOyXsOqysOydtCDqsbDrtoDrj7wNCi8vIOy2lOyynMK37Zes7Iqk7LK07YGs6rCAIOyhsOyaqe2eiCDsi6TtjKjtlojri6Qo7Iuk7LihIDIwMjYtMDcpLiDqsJnsnYAg7JqU7LKtIO2VuOuTpOufrOulvCBJUHY2IOujqO2UhOuwseyXkOuPhCDslrnripTri6QuDQpjb25zdCBzZXJ2ZXI2ID0gaHR0cC5jcmVhdGVTZXJ2ZXIoc2VydmVyLmxpc3RlbmVycygncmVxdWVzdCcpWzBdKTsNCnNlcnZlcjYub24oJ2Vycm9yJywgKGUpID0+IGNvbnNvbGUubG9nKCdbYnJpZGdlXSBJUHY2KDo6MSkg66as7IqoIOyDneuetSDigJQgSVB2NOunjCDsgqzsmqk6JywgZSAmJiBlLm1lc3NhZ2UpKTsNCnNlcnZlcjYubGlzdGVuKFBPUlQsICc6OjEnKTsNClBLAwQUAAAIAAAAAAAAcAIIPZdRAACXUQAAGQAAAHNjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanMvLyDtgbTroZzrk5wg64uk66asIOqwkOyLnOyekCDigJQg7ZWt7IOBIOuWoCDsnojripQg7LSI7IaM7ZiVIOyEnOuyhCAobG9jYWxob3N0OjExODg5KQ0KLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQovLyDsmZwg7ZWE7JqU7ZWc6rCAOiDtlLzqt7jrp4jqsIAg7ZSM65+s6re47J247J2YIGNsYXVkZWJyaWRnZTovLyDsl7TquLAod2luZG93Lm9wZW4vaWZyYW1lL29wZW5FeHRlcm5hbCnrpbwNCi8vIOyghOu2gCDshozrpqwg7JeG7J20IOunieuKlCDrsoTsoITsnbQg7J6I64ukLiBmZXRjaOuKlCDrqrsg66eJ7Jy866+A66GcLCDtlIzrn6zqt7jsnbjsnbQg7J20IOqwkOyLnOyekOyXkOqyjA0KLy8gUE9TVCAvd2FrZSDrpbwg67O064K066m0IOqwkOyLnOyekOqwgCDri6TrpqwoY2xhdWRlLWJyaWRnZS5qcynrpbwg64yA7IugIOy8oOuLpC4NCi8vDQovLyDri6TrpqzsmYDsnZgg7LCo7J20OiDqsJDsi5zsnpDripQgY2xhdWRl66W8IOusvOyngCDslYrripTri6Qo7J6Q7IudIOyXhuydjCkg4oaSIO2BtOuhnOuTnCDslbEg7JeF642w7J207Yq466W8IOyViCDrp4nqs6AsDQovLyDrqZTrqqjrpqwgfjE1TULrnbwg66Gc6re47J24IOyLnCDsnpDrj5kg7Iuc7J6R7Jy866GcIOyDgeyLnCDsvJzrkazrj4Qg67aA64u0IOyXhuuLpCAo65Ox66GdOiBucG0gcnVuIGJ1aWxkKS4NCi8vIOuLpOumrOuKlCDsi6zsnqXrsJXrj5kg64GK6riw66m0IOyjveyngOunjCjtlIzrn6zqt7jsnbjqs7wg7IOd7IKsIOuPmeq4sO2ZlCksIOqwkOyLnOyekOuKlCDqs4Tsho0g64Ko7JWEIOuLpOydjCDquajsmrDquLDrpbwg67Cb64qU64ukLg0KDQpjb25zdCBodHRwID0gcmVxdWlyZSgnaHR0cCcpOw0KY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTsNCmNvbnN0IGZzID0gcmVxdWlyZSgnZnMnKTsNCmNvbnN0IG9zID0gcmVxdWlyZSgnb3MnKTsNCmNvbnN0IHsgc3Bhd24sIHNwYXduU3luYyB9ID0gcmVxdWlyZSgnY2hpbGRfcHJvY2VzcycpOw0KDQpjb25zdCBQT1JUID0gMTE4ODk7DQpjb25zdCBST09UID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJyk7IC8vIOyggOyepeyGjCDro6jtirgg4oCUIOuLpOumrOqwgCByZWNvbW1lbmQtZXhhbXBsZXMubWTrpbwg7LC+64qUIOq4sOykgA0KDQpjb25zdCBDT1JTX0hFQURFUlMgPSB7DQogICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsDQogICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCwgUE9TVCwgT1BUSU9OUycsDQogICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZScsDQp9Ow0KZnVuY3Rpb24ganNvbihyZXMsIHN0YXR1cywgb2JqKSB7DQogIHJlcy53cml0ZUhlYWQoc3RhdHVzLCBPYmplY3QuYXNzaWduKHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9LCBDT1JTX0hFQURFUlMpKTsNCiAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShvYmopKTsNCn0NCg0KLy8gY2xhdWRlIENMSeqwgCDsnojripTsp4Ag4oCUIOyXhuycvOuptCAvd2FrZSDsnZHri7Xsl5Ag7Iuk7Ja0IO2UjOufrOq3uOyduOydtCDslYjrgrTtlaAg7IiYIOyeiOqyjCDtlZzri6QNCi8vIOuhnOq3uOyduOuQnCDqs4TsoJUg7J296riwIOKAlCBDTEnqsIAgfi8uY2xhdWRlLmpzb27sl5Ag6riw66Gd7ZWY64qUIG9hdXRoQWNjb3VudC5lbWFpbEFkZHJlc3MgKOuLpOumrOydmCBjbGF1ZGVBY2NvdW507JmAIOqwmeydgCDstpzsspgpLg0KLy8g7YyM7J287J20IO2BtCDsiJgg7J6I7Ja0IDMw7LSIIOy6kOyLnC4g7J6s66Gc6re47J247ZWY66m0IENMSeqwgCDtjIzsnbzsnYQg6rCx7Iug7ZWY66+A66GcIOyekOuPmSDrsJjsmIHrkJzri6QuDQovLyDsupDsi5wgNey0iCDigJQg66Gc6re47J24IOynge2bhCDsg4gg6rOE7KCV7J20IOqzp+uwlOuhnCDsnqHtmIDslbwg7ZSM65+s6re47J247J20IOuhnOq3uOyduCDtmZTrqbTsl5DshJwg7ZmI7Jy866GcIOuEmOyWtOqwhOuLpCgzMOy0iOuptCDrhIjrrLQg64qm7J2MKQ0KbGV0IGFjY291bnRDYWNoZSA9IHsgYXQ6IDAsIGVtYWlsOiBudWxsIH07DQovLyDsi6TsoJwg66Gc6re47J24IOyXrOu2gOuKlCDsnpDqsqnspp3rqoUg7YyM7J2866GcIO2MkOuLqO2VnOuLpCDigJQgfi8uY2xhdWRlLmpzb27snZggb2F1dGhBY2NvdW5064qUICoq66Gc6re47JWE7JuD7ZW064+EIOuCqOuKlOuLpCoqDQovLyAo7Iuk7LihOiBjbGF1ZGUgYXV0aCBzdGF0dXPripQgbG9nZ2VkSW46ZmFsc2XsnbjrjbAg6re4IO2VhOuTnOuKlCDqt7jrjIDroZwg4oaSIO2UjOufrOq3uOyduOydtCDroZzqt7jsnbjrkJwg6rKD7LKY65+8IO2RnOyLnO2WiOuLpCkuDQovLyDtjIzsnbzrp4wg7J297Jy866+A66GcIOu5hOyaqSAwLiBjbGF1ZGUgYXV0aCBzdGF0dXPqsIAg7KCV7ZmV7ZWY7KeA66eMIO2UhOuhnOyEuOyKpOulvCDrnYTsm4zslbwg7ZW07IScIOyhsO2ajOuniOuLpCDsk7DquLDsl5Qg66y06rKB64ukLg0KZnVuY3Rpb24gaGFzQ2xhdWRlQ3JlZGVudGlhbHMoKSB7DQogIHRyeSB7DQogICAgY29uc3QgZiA9IHBhdGguam9pbihvcy5ob21lZGlyKCksICcuY2xhdWRlJywgJy5jcmVkZW50aWFscy5qc29uJyk7DQogICAgY29uc3QgaiA9IEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKGYsICd1dGY4JykpOw0KICAgIGlmIChqICYmIGouY2xhdWRlQWlPYXV0aCAmJiBqLmNsYXVkZUFpT2F1dGguYWNjZXNzVG9rZW4pIHJldHVybiB0cnVlOw0KICB9IGNhdGNoIChfZSkgeyAvKiDtjIzsnbwg7JeG7J2Mwrfrqrsg7J297J2MIOKAlCDrp6XsnbTrqbQg7YKk7LK07J247J2EIOuniOyggCDrs7jri6QgKi8gfQ0KICAvLyAqKuunpeydgCDsnpDqsqnspp3rqoXsnYQg7YyM7J287J20IOyVhOuLiOudvCDtgqTssrTsnbjsl5Ag64Sj64qU64ukKiogKDIwMjYtMDgg7Iuk7LihLCDri6TrpqwgdjQxIC8g6rCQ7Iuc7J6QIHY2KS4NCiAgLy8g66el7J2YIENsYXVkZSBDb2Rl64qUIH4vLmNsYXVkZS8uY3JlZGVudGlhbHMuanNvbuydhCDslYTsmIgg66eM65Ok7KeAIOyViuqzoCDtgqTssrTsnbgg7ZWt66qpDQogIC8vICdDbGF1ZGUgQ29kZS1jcmVkZW50aWFscyfsl5Ag7KCA7J6l7ZWc64ukIOKGkiDtjIzsnbzrp4wg67O066m0IOupgOypoe2eiCDroZzqt7jsnbjrkJwg66el7J20IOuKmCAn66Gc6re47J24IOyViCDrkKgn7J20IOuQmOqzoCwNCiAgLy8g66Gc6re47J24IOuMgOq4sCDtmZTrqbTsnbQg7JiB7JiBIOuPiOuLpCjriIzrn6zrj4QgQ0xJ6rCAICLsnbTrr7gg66Gc6re47J2465CoIuycvOuhnCDsponsi5wg64Gd64KYIOu4jOudvOyasOyggOyhsOywqCDslYgg7Je066aw64ukKS4NCiAgLy8gKirsobTsnqzrp4wg7ZmV7J247ZWc64ukKC13IOyXhuydjCkqKiDigJQg67mE67CA67KI7Zi4IOqwkuydhCDsnb3snLzrqbQg7YKk7LK07J24IOygkeq3vCDtl4jsmqkg7Yyd7JeF7J20IOucsCDsiJgg7J6I64ukLiDslb0gMzBtcy4NCiAgLy8gQ0JfTk9fS0VZQ0hBSU49MeydtOuptCDtjIzsnbzrp4wg67O464ukICjrqqjsnZgg7ZmI7Jy866GcICfroZzqt7jsnbgg7JeG7J2MJ+ydhCDsnqztmITtlZjripQg7YWM7Iqk7Yq47JqpIOKAlCDtgqTssrTsnbjsnYAgSE9NReydhCDslYgg65Sw66W464ukKS4NCiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICdkYXJ3aW4nIHx8IHByb2Nlc3MuZW52LkNCX05PX0tFWUNIQUlOID09PSAnMScpIHJldHVybiBmYWxzZTsNCiAgdHJ5IHsNCiAgICBjb25zdCByID0gc3Bhd25TeW5jKCdzZWN1cml0eScsIFsnZmluZC1nZW5lcmljLXBhc3N3b3JkJywgJy1zJywgJ0NsYXVkZSBDb2RlLWNyZWRlbnRpYWxzJ10sIHsgc3RkaW86ICdpZ25vcmUnLCB0aW1lb3V0OiAzMDAwIH0pOw0KICAgIHJldHVybiByLnN0YXR1cyA9PT0gMDsNCiAgfSBjYXRjaCAoX2UpIHsgcmV0dXJuIGZhbHNlOyB9IC8vIHNlY3VyaXR566W8IOuquyDrtoDrpoQgPSDroZzqt7jsnbgg7JWIIOuQqOycvOuhnCDrs7jri6QNCn0NCmZ1bmN0aW9uIGNsYXVkZUFjY291bnQoKSB7DQogIGlmIChEYXRlLm5vdygpIC0gYWNjb3VudENhY2hlLmF0IDwgNTAwMCkgcmV0dXJuIGFjY291bnRDYWNoZS5lbWFpbDsNCiAgbGV0IGVtYWlsID0gbnVsbDsNCiAgdHJ5IHsNCiAgICBpZiAoaGFzQ2xhdWRlQ3JlZGVudGlhbHMoKSkgeyAvLyDsnpDqsqnspp3rqoXsnbQg7JeG7Jy866m0IOuCqOydgCDsnbTrqZTsnbzsnYAg66y07Iuc7ZWc64ukDQogICAgICBjb25zdCBqID0gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKG9zLmhvbWVkaXIoKSwgJy5jbGF1ZGUuanNvbicpLCAndXRmOCcpKTsNCiAgICAgIGVtYWlsID0gKGogJiYgai5vYXV0aEFjY291bnQgJiYgai5vYXV0aEFjY291bnQuZW1haWxBZGRyZXNzKSB8fCBudWxsOw0KICAgIH0NCiAgfSBjYXRjaCAoX2UpIHsgLyog66Gc6re47J24IOydtOugpSDsl4bsnYwg65OxIOKAlCBudWxsICovIH0NCiAgYWNjb3VudENhY2hlID0geyBhdDogRGF0ZS5ub3coKSwgZW1haWwgfTsNCiAgcmV0dXJuIGVtYWlsOw0KfQ0KDQpmdW5jdGlvbiBoYXNDbGF1ZGUoKSB7DQogIGNvbnN0IGZpbmRlciA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicgPyAnd2hlcmUnIDogJ3doaWNoJzsNCiAgdHJ5IHsgcmV0dXJuIHNwYXduU3luYyhmaW5kZXIsIFsnY2xhdWRlJ10sIHsgc3RkaW86ICdpZ25vcmUnLCBzaGVsbDogdHJ1ZSB9KS5zdGF0dXMgPT09IDA7IH0gY2F0Y2ggKF9lKSB7IHJldHVybiBmYWxzZTsgfQ0KfQ0KDQpsZXQgd2FraW5nID0gZmFsc2U7IC8vIOyXsO2DgCDrsKnsp4Ag4oCUIOuLpOumrOuKlCDslrTssKjtlLwgRUFERFJJTlVTReuhnCDspJHrs7Ug7KCV66as7ZWY7KeA66eMIO2UhOuhnOyEuOyKpCDrgq3ruYTrpbwg7KSE7J2464ukDQpmdW5jdGlvbiB3YWtlQnJpZGdlKCkgew0KICBpZiAod2FraW5nKSByZXR1cm47DQogIHdha2luZyA9IHRydWU7DQogIHNldFRpbWVvdXQoKCkgPT4geyB3YWtpbmcgPSBmYWxzZTsgfSwgNTAwMCk7DQogIGxldCBwcm9jOw0KICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJykgew0KICAgIC8vIFdpbmRvd3M6IGNtZMK3dmJzIOqyveycoCDsl4bsnbQgbm9kZeulvCDsp4HsoJEsIHdpbmRvd3NIaWRlKENSRUFURV9OT19XSU5ET1cp66GcIOyKpO2PsCDigJQNCiAgICAvLyDssL0g7JeG64qUIOyIqOydgCDsvZjshpTsnbQg66eM65Ok7Ja07KeA6rOgIOuLpOumrOydmCDsnpDsi50oY2xhdWRlKeuPhCDqt7gg7L2Y7IaU7J2EIOusvOugpOuwm+yVhCDslrTrlqQg7LC964+EIOyViCDrnKzri6QuDQogICAgLy8gZGV0YWNoZWTripQg7JOw7KeAIOyViuuKlOuLpChkZXRhY2hlZCt3aW5kb3dzSGlkZSDsobDtlansnYAg7L2Y7IaUIOywveydtCDrhbjstpzrkKgg4oCUIOyLpOy4oSkuDQogICAgLy8gV2luZG93c+yXkOyEoCBkZXRhY2hlZCDsl4bsnbTrj4Qg67aA66qoKOqwkOyLnOyekCnqsIAg7KO97Ja064+EIOyekOyLneydgCDsgrTslYTrgqjripTri6QuDQogICAgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtwYXRoLmpvaW4oX19kaXJuYW1lLCAnY2xhdWRlLWJyaWRnZS5qcycpXSwgew0KICAgICAgY3dkOiBST09ULCBzdGRpbzogJ2lnbm9yZScsIHdpbmRvd3NIaWRlOiB0cnVlLA0KICAgIH0pOw0KICB9IGVsc2Ugew0KICAgIC8vIG1hY09TL+umrOuIheyKpDog6rCQ7Iuc7J6Q66W8IOudhOyatCBub2RlIOyLpO2WiSDtjIzsnbzroZwg7KeB7KCRIOyKpO2PsCAobGF1bmNoZCDtmZjqsr3sl5QgUEFUSOqwgCDruYjslb3tlaAg7IiYIOyeiOyWtCDsoIjrjIDqsr3roZwg7IKs7JqpKQ0KICAgIHByb2MgPSBzcGF3bihwcm9jZXNzLmV4ZWNQYXRoLCBbcGF0aC5qb2luKF9fZGlybmFtZSwgJ2NsYXVkZS1icmlkZ2UuanMnKV0sIHsNCiAgICAgIGN3ZDogUk9PVCwgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiAnaWdub3JlJywNCiAgICB9KTsNCiAgfQ0KICBwcm9jLnVucmVmKCk7IC8vIOqwkOyLnOyekCDsnbTrsqTtirgg66Oo7ZSE7JeQ7IScIOu2hOumrCAo6rCQ7Iuc7J6QIOyiheujjOulvCDrp4nsp4Ag7JWK6rKMKQ0KfQ0KDQovLyDsnbQgUEPrpbwgJ+yEpOy5mCDsoIQo7IOIIFBDKScg7IOB7YOc66GcIOuQmOuPjOumsOuLpCDigJQg7ZSM65+s6re47J24IFvstIjquLDtmZRdIOuyhO2KvChQT1NUIC91bmluc3RhbGwp7J20IOu2gOuluOuLpC4NCi8vIHJlZ2lzdGVyLXByb3RvY29sLmpz6rCAIOyEpOy5mO2VnCDqsoPsnYQg6re464yA66GcIOuQmOuPjOumsOuLpDog6rCQ7Iuc7J6QIOyekOuPmeyLnOyekSArICjsnojsnLzrqbQpIOyEpOy5mCDtj7TrjZQuDQovLyDimqDvuI8g67CY65Oc7IucIEhUVFAg7J2R64u17J2EIOuovOyggCDrs7Trgrgg65KkIO2YuOy2nO2VoCDqsoMg4oCUIG1hY09TIGxhdW5jaGN0bCBib290b3V07J20IOydtCDtlITroZzshLjsiqTrpbwg7KaJ7IucIOyiheujjOyLnO2CrCDsiJgg7J6I64ukLg0KLy8gICAg6re4656Y7IScIO2MjOydvChwbGlzdMK37ISk7LmYIO2PtOuNlCnsnYQgbGF1bmNoY3Rs67O064ukIOuovOyggCDsp4DsmrTri6Qg4oCUIGJvb3RvdXTsnbQg7Jqw66as66W8IOyjveyXrOuPhCDsnpDrj5nsi5zsnpHsnYAg7J2066+4IOyCrOudvOynhOuLpC4NCmZ1bmN0aW9uIHVuaW5zdGFsbFNlbGYoKSB7DQogIGNvbnN0IHJlbW92ZWQgPSBbXTsNCiAgdHJ5IHsNCiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2RhcndpbicpIHsNCiAgICAgIGNvbnN0IExBQkVMID0gJ2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlcic7DQogICAgICBjb25zdCBwbGlzdCA9IHBhdGguam9pbihvcy5ob21lZGlyKCksICdMaWJyYXJ5JywgJ0xhdW5jaEFnZW50cycsIExBQkVMICsgJy5wbGlzdCcpOw0KICAgICAgY29uc3QgaW5zdCA9IHBhdGguam9pbihvcy5ob21lZGlyKCksICdMaWJyYXJ5JywgJ0FwcGxpY2F0aW9uIFN1cHBvcnQnLCAnQ2xhdWRlQnJpZGdlJyk7DQogICAgICB0cnkgeyBpZiAoZnMuZXhpc3RzU3luYyhwbGlzdCkpIHsgZnMudW5saW5rU3luYyhwbGlzdCk7IHJlbW92ZWQucHVzaChwbGlzdCk7IH0gfSBjYXRjaCAoX2UpIHt9DQogICAgICB0cnkgeyBpZiAoZnMuZXhpc3RzU3luYyhpbnN0KSkgeyBmcy5ybVN5bmMoaW5zdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyByZW1vdmVkLnB1c2goaW5zdCk7IH0gfSBjYXRjaCAoX2UpIHt9DQogICAgICB0cnkgeyBzcGF3blN5bmMoJ2xhdW5jaGN0bCcsIFsnYm9vdG91dCcsICdndWkvJyArIHByb2Nlc3MuZ2V0dWlkKCkgKyAnLycgKyBMQUJFTF0sIHsgc3RkaW86ICdpZ25vcmUnIH0pOyB9IGNhdGNoIChfZSkge30NCiAgICAgIHRyeSB7IHNwYXduU3luYygnbGF1bmNoY3RsJywgWydyZW1vdmUnLCBMQUJFTF0sIHsgc3RkaW86ICdpZ25vcmUnIH0pOyB9IGNhdGNoIChfZSkge30NCiAgICB9IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicpIHsNCiAgICAgIHRyeSB7IHNwYXduU3luYygncmVnJywgWydkZWxldGUnLCAnSEtDVVxcU29mdHdhcmVcXE1pY3Jvc29mdFxcV2luZG93c1xcQ3VycmVudFZlcnNpb25cXFJ1bicsICcvdicsICdDbGF1ZGVCcmlkZ2VXYXRjaGVyJywgJy9mJ10sIHsgc3RkaW86ICdpZ25vcmUnIH0pOyByZW1vdmVkLnB1c2goJ+yekOuPmeyLnOyekShDbGF1ZGVCcmlkZ2VXYXRjaGVyKScpOyB9IGNhdGNoIChfZSkge30NCiAgICAgIHRyeSB7IHNwYXduU3luYygncmVnJywgWydkZWxldGUnLCAnSEtDVVxcU29mdHdhcmVcXENsYXNzZXNcXGNsYXVkZWJyaWRnZScsICcvZiddLCB7IHN0ZGlvOiAnaWdub3JlJyB9KTsgcmVtb3ZlZC5wdXNoKCdjbGF1ZGVicmlkZ2U6Ly8g65Ox66GdJyk7IH0gY2F0Y2ggKF9lKSB7fQ0KICAgICAgdHJ5IHsNCiAgICAgICAgY29uc3QgaW5zdCA9IHBhdGguam9pbihwcm9jZXNzLmVudi5MT0NBTEFQUERBVEEgfHwgcGF0aC5qb2luKG9zLmhvbWVkaXIoKSwgJ0FwcERhdGEnLCAnTG9jYWwnKSwgJ0NsYXVkZUJyaWRnZScpOw0KICAgICAgICBpZiAoZnMuZXhpc3RzU3luYyhpbnN0KSkgeyBmcy5ybVN5bmMoaW5zdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyByZW1vdmVkLnB1c2goaW5zdCk7IH0NCiAgICAgIH0gY2F0Y2ggKF9lKSB7fQ0KICAgIH0NCiAgfSBjYXRjaCAoX2UpIHsgLyogZmFpbC1zb2Z0IOKAlCDrqrsg7KeA7Jq0IOqyjCDsnojslrTrj4Qg7ZSM65+s6re47J24IOyqvSDquLDslrUg7IKt7KCc64qUIOydtOuvuCDrgZ3rgqzri6QgKi8gfQ0KICByZXR1cm4gcmVtb3ZlZDsNCn0NCg0KLy8g6rCQ7Iuc7J6QIOyekOyLoOydhCDsg4gg7L2U65Oc66GcIOuLpOyLnCDrnYTsmrTri6Qg4oCUIFBPU1QgL3Jlc3RhcnQg6rCAIOu2gOuluOuLpC4NCi8vIOyZnCDtlYTsmpTtlZzqsIAoMjAyNi0wOCDsi6TsuKEpOiDshKTsuZjrs7gg7YyM7J287J20IOyDiOqyg+ydtOyWtOuPhCAqKuyYpOuemCDrlqAg7J6I642YIOqwkOyLnOyekOqwgCDsmJsg7L2U65Oc7J2YIOuLpOumrOulvCDqs4Tsho0g7Lyc64qUKioNCi8vIOyDge2DnOqwgCDsnojsl4jri6Qo7YyM7J28IHY0MSAvIOy8nOyngOuKlCDri6TrpqwgdjIyKS4g7J2065+s66m0IO2UjOufrOq3uOyduOydtCBb7JeF642w7J207Yq4IO2VhOyalF3roZwg64uk66as66W8IOq7kOuLpCDsvJzrj4QNCi8vIOy8nCDso7zripQg7Kq97J20IOq3uOuMgOuhnOudvCDsmIHsm5Dtnogg7JibIOuyhOyghOydtOqzoCwg7J6s7Iuc7J6R66eI64ukIOybjOuwjeyXhSjqtazrj4Ug7IKs7Jqp65+JKeunjCDrgpjqsJTri6QuDQovLyDqt7jrnpjshJwgIuuLpOumrOunjCDqu5Dri6Qg7Lyc6riwIuuhnCDslYgg7ZKA66as66m0IOy8nCDso7zripQg6rCQ7Iuc7J6Q67aA7YSwIOyDiOuhnCDrnYTsmrTri6QuIOqwkOyLnOyekOuKlCBjbGF1ZGXrpbwg7JWIIOusvOyWtCDruYTsmqkgMC4NCi8vIOyInOyEnCDso7zsnZg6IOyDiCDsnbjsiqTthLTsiqTqsIAg66i87KCAIOucqOuptCDtj6ztirjrpbwg66q7IOyeoeuKlOuNsCwg7JWE656YIGxpc3RlbiDsnqzsi5zrj4TqsIAg7Jqw66as6rCAIOu5oOyniCDrlYzquYzsp4Ag6riw64uk66CkIOykgOuLpC4NCmZ1bmN0aW9uIHJlc3RhcnRTZWxmKCkgew0KICB0cnkgew0KICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInKSB7DQogICAgICBjb25zdCB2YnMgPSBwYXRoLmpvaW4oUk9PVCwgJ2NsYXVkZS13YXRjaGVyLXNpbGVudC52YnMnKTsNCiAgICAgIGlmIChmcy5leGlzdHNTeW5jKHZicykpIHsNCiAgICAgICAgY29uc3QgcCA9IHNwYXduKCd3c2NyaXB0LmV4ZScsIFt2YnNdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogJ2lnbm9yZScsIHdpbmRvd3NIaWRlOiB0cnVlIH0pOw0KICAgICAgICBwLnVucmVmKCk7DQogICAgICB9IGVsc2Ugew0KICAgICAgICAvLyB2YnPqsIAg7JeG7Jy866m0IG5vZGXrpbwg7KeB7KCRIOKAlCDssL0g7JWIIOucqOqyjCDtlZjripQg6rec7LmZ7J2AIOuLpOumrCDsiqTtj7Dqs7wg6rCZ64ukKHdpbmRvd3NIaWRlLCBkZXRhY2hlZCDquIjsp4ApDQogICAgICAgIGNvbnN0IHAgPSBzcGF3bihwcm9jZXNzLmV4ZWNQYXRoLCBbX19maWxlbmFtZV0sIHsgc3RkaW86ICdpZ25vcmUnLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTsNCiAgICAgICAgcC51bnJlZigpOw0KICAgICAgfQ0KICAgICAgcmV0dXJuOw0KICAgIH0NCiAgICAvLyBtYWNPUzogbGF1bmNoZOqwgCDsmrDrpqzrpbwg6rSA66as7ZWc64ukIOKAlCBraWNrc3RhcnQgLWvqsIAg6ruQ64ukIOy8nCDspIDri6Qo7Jqw66as66W8IOyjveydtOuvgOuhnCDslYTrnpggZXhpdOq5jOyngCDslYgg7JisIOyImOuPhCDsnojri6QpDQogICAgY29uc3QgdWlkID0gcHJvY2Vzcy5nZXR1aWQoKTsNCiAgICBjb25zdCByID0gc3Bhd25TeW5jKCdsYXVuY2hjdGwnLCBbJ2tpY2tzdGFydCcsICctaycsICdndWkvJyArIHVpZCArICcvY29tLmNsYXVkZWJyaWRnZS53YXRjaGVyJ10sIHsgc3RkaW86ICdpZ25vcmUnIH0pOw0KICAgIGlmIChyLnN0YXR1cyAhPT0gMCkgew0KICAgICAgY29uc3QgcCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtfX2ZpbGVuYW1lXSwgeyBkZXRhY2hlZDogdHJ1ZSwgc3RkaW86ICdpZ25vcmUnIH0pOw0KICAgICAgcC51bnJlZigpOw0KICAgIH0NCiAgfSBjYXRjaCAoX2UpIHsgLyogZmFpbC1zb2Z0IOKAlCDrqrsg652E7Jug7Jy866m0IOuLpOydjCDroZzqt7jsnbgg7J6Q64+Z7Iuc7J6R7J20IOyCtOumsOuLpCAqLyB9DQp9DQoNCi8vIOKUgOKUgCDshKTsuZjrs7gg7J6Q64+ZIOqwseyLoCAoUE9TVCAvdXBkYXRlKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCi8vIOyZnCDtlYTsmpTtlZzqsIAoMjAyNi0wOSk6IOyEpOy5mCDtjIzsnbzroZzrp4wg7IS47YyF7ZWcIFBD64qUIOyEpOy5mOuzuOydtCDqt7gg7Iuc7KCQIOy9lOuTnOuhnCDqtbPripTri6QuIOqwkOyLnOyekOuKlCAqKuyekOq4sCDtj7TrjZTsnZgqKg0KLy8g64uk66as66W8IOy8nOuvgOuhnCwg7ZSM65+s6re47J247J20IFvsl4XrjbDsnbTtirgg7ZWE7JqUXeulvCDqsJDsp4DtlbQg6ruQ64ukIOy8nOuPhCDrmJAg6rCZ7J2AIOyYmyDsvZTrk5zqsIAg7Jis65287Jio64ukIOKAlCDruaDsoLjrgpjqsIgg6ri47J20IOyXhuuLpC4NCi8vIOyDiCDsvZTrk5zrpbwg7Ja065SU7IScIOq1rO2VmOuCmDogKirtlIzrn6zqt7jsnbjsnbQg7J2066+4IOqwluqzoCDsnojri6QuKiog67mM65Oc6rCAIOyekOq4sOyZhOqysCDshKTsuZgg7YyM7J28KO2BtOuhnOuTnC3su6TrhKXthLAuYmF0KeydhA0KLy8gY29kZS5qc+yXkCBiYXNlNjTroZwg7Ius7Ja0IOuRkOuvgOuhnChJTlNUQUxMRVIg66eI7LukKSwg7ZSM65+s6re47J247J20IOq3uOqxuCDthrXsp7jroZwg67O064K066m0IOyXrOq4sOyEnCDshLnshZjsnYQg7ZKA7Ja0IO2MjOydvOunjCDqsIjrqbQg65Cc64ukLg0KLy8g64Sk7Yq47JuM7YGswrfsgqzsmqnsnpAg7YG066at7J20IO2VhOyalCDsl4bri6Qo7IKs64K0IO2UhOuhneyLnOuPhCDslYgg7YOE64ukKS4NCmZ1bmN0aW9uIHJlYWRCb2R5KHJlcSkgew0KICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHsNCiAgICBsZXQgcyA9ICcnOw0KICAgIHJlcS5vbignZGF0YScsIChjKSA9PiB7IHMgKz0gYzsgaWYgKHMubGVuZ3RoID4gNDAgKiAxMDI0ICogMTAyNCkgeyBzID0gJyc7IHJlcS5kZXN0cm95KCk7IH0gfSk7DQogICAgcmVxLm9uKCdlbmQnLCAoKSA9PiB7IHRyeSB7IHJlc29sdmUoSlNPTi5wYXJzZShzIHx8ICd7fScpKTsgfSBjYXRjaCAoX2UpIHsgcmVzb2x2ZSh7fSk7IH0gfSk7DQogICAgcmVxLm9uKCdlcnJvcicsICgpID0+IHJlc29sdmUoe30pKTsNCiAgfSk7DQp9DQovLyDsu6TrhKXthLAgemlw7JeQ7IScIO2MjOydvOydhCDqurzrgrjri6Qg4oCUIOustOyVley2lShzdG9yZWQp66eMIOyngOybkO2VmOuvgOuhnCDsmbjrtoAg65287J2067iM65+s66aswrd6bGli7J20IO2VhOyalCDsl4bri6QuDQovLyAo67mM65Oc7J2YIHppcEZpbGVz6rCAIHN0b3JlZOuhnOunjCDrp4zrk6Dri6QuIOyVley2leuQnCDtla3rqqnsnbQg7Jik66m0IOq3uCDtla3rqqnsnYAg6rG064SI65u064ukLikNCmZ1bmN0aW9uIHVuemlwU3RvcmVkKGJ1Zikgew0KICBjb25zdCBmaWxlcyA9IHt9Ow0KICBsZXQgaSA9IDA7DQogIHdoaWxlIChpICsgMzAgPD0gYnVmLmxlbmd0aCAmJiBidWYucmVhZFVJbnQzMkxFKGkpID09PSAweDA0MDM0YjUwKSB7DQogICAgY29uc3QgbWV0aG9kID0gYnVmLnJlYWRVSW50MTZMRShpICsgOCk7DQogICAgY29uc3Qgc2l6ZSA9IGJ1Zi5yZWFkVUludDMyTEUoaSArIDE4KTsNCiAgICBjb25zdCBuYW1lTGVuID0gYnVmLnJlYWRVSW50MTZMRShpICsgMjYpOw0KICAgIGNvbnN0IGV4dHJhTGVuID0gYnVmLnJlYWRVSW50MTZMRShpICsgMjgpOw0KICAgIGNvbnN0IG5hbWUgPSBidWYuc2xpY2UoaSArIDMwLCBpICsgMzAgKyBuYW1lTGVuKS50b1N0cmluZygndXRmOCcpOw0KICAgIGNvbnN0IHN0YXJ0ID0gaSArIDMwICsgbmFtZUxlbiArIGV4dHJhTGVuOw0KICAgIGlmIChtZXRob2QgPT09IDApIGZpbGVzW25hbWVdID0gYnVmLnNsaWNlKHN0YXJ0LCBzdGFydCArIHNpemUpOw0KICAgIGkgPSBzdGFydCArIHNpemU7DQogIH0NCiAgcmV0dXJuIGZpbGVzOw0KfQ0KLy8g7ISk7LmY67O4IO2MjOydvOydhCDsg4gg7L2U65Oc66GcIOq1kOyytO2VnOuLpC4g67CU64CQIO2MjOydvCDsnbTrpoQg66qp66Gd7J2EIOuPjOugpOykgOuLpCjqsJnsnLzrqbQg7JWIIOyTtOuLpCDigJQg66mx65OxKS4NCmZ1bmN0aW9uIGFwcGx5SW5zdGFsbGVyKGluc3RhbGxlckI2NCkgew0KICBjb25zdCB6aXAgPSBCdWZmZXIuZnJvbShTdHJpbmcoaW5zdGFsbGVyQjY0IHx8ICcnKS5yZXBsYWNlKC9bXkEtWmEtejAtOSsvPV0vZywgJycpLCAnYmFzZTY0Jyk7DQogIGNvbnN0IGYgPSB1bnppcFN0b3JlZCh6aXApOw0KICBjb25zdCBwYXJ0cyA9IFsNCiAgICB7IG5hbWU6ICfri6TrpqwnLCAgIGJ1ZjogZlsnc2NyaXB0cy9jbGF1ZGUtYnJpZGdlLmpzJ10sICBkc3Q6IHBhdGguam9pbihfX2Rpcm5hbWUsICdjbGF1ZGUtYnJpZGdlLmpzJykgfSwNCiAgICB7IG5hbWU6ICfqsJDsi5zsnpAnLCBidWY6IGZbJ3NjcmlwdHMvYnJpZGdlLXdhdGNoZXIuanMnXSwgZHN0OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnYnJpZGdlLXdhdGNoZXIuanMnKSB9LA0KICAgIHsgbmFtZTogJ+yEpOy5mCcsICAgYnVmOiBmWydzY3JpcHRzL3JlZ2lzdGVyLXByb3RvY29sLmpzJ10sIGRzdDogcGF0aC5qb2luKF9fZGlybmFtZSwgJ3JlZ2lzdGVyLXByb3RvY29sLmpzJykgfSwNCiAgICB7IG5hbWU6ICfsmIjsi5wnLCAgIGJ1ZjogZlsncmVjb21tZW5kLWV4YW1wbGVzLm1kJ10sICAgICBkc3Q6IHBhdGguam9pbihST09ULCAncmVjb21tZW5kLWV4YW1wbGVzLm1kJykgfSwNCiAgICB7IG5hbWU6ICfqsIDsnbTrk5wnLCBidWY6IGZbJ3V4LXdyaXRpbmcubWQnXSwgICAgICAgICAgICAgZHN0OiBwYXRoLmpvaW4oUk9PVCwgJ3V4LXdyaXRpbmcubWQnKSB9LA0KICBdLmZpbHRlcigocCkgPT4gcC5idWYgJiYgcC5idWYubGVuZ3RoKTsNCiAgaWYgKCFwYXJ0cy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcign7ISk7LmYIO2MjOydvOyXkOyEnCDsvZTrk5zrpbwg7LC+7KeAIOuqu+2WiOyWtOyalCcpOw0KICBjb25zdCBjaGFuZ2VkID0gW107DQogIGxldCB3YXRjaGVyQ2hhbmdlZCA9IGZhbHNlOw0KICBmb3IgKGNvbnN0IHAgb2YgcGFydHMpIHsNCiAgICBsZXQgc2FtZSA9IGZhbHNlOw0KICAgIHRyeSB7IHNhbWUgPSBmcy5leGlzdHNTeW5jKHAuZHN0KSAmJiBCdWZmZXIuY29tcGFyZShmcy5yZWFkRmlsZVN5bmMocC5kc3QpLCBwLmJ1ZikgPT09IDA7IH0gY2F0Y2ggKF9lKSB7fQ0KICAgIGlmIChzYW1lKSBjb250aW51ZTsNCiAgICBmcy5ta2RpclN5bmMocGF0aC5kaXJuYW1lKHAuZHN0KSwgeyByZWN1cnNpdmU6IHRydWUgfSk7DQogICAgZnMud3JpdGVGaWxlU3luYyhwLmRzdCwgcC5idWYpOyAvLyDrsJTsnbTtirgg6re464yA66GcIOKAlCDsnbjsvZTrlKkg67OA7ZmYIOq4iOyngA0KICAgIGNoYW5nZWQucHVzaChwLm5hbWUpOw0KICAgIGlmIChwLm5hbWUgPT09ICfqsJDsi5zsnpAnKSB3YXRjaGVyQ2hhbmdlZCA9IHRydWU7DQogIH0NCiAgY29uc3QgYnJpZGdlU3JjID0gcGFydHMuZmlsdGVyKChwKSA9PiBwLm5hbWUgPT09ICfri6TrpqwnKVswXTsNCiAgY29uc3Qgdm0gPSBicmlkZ2VTcmMgPyBicmlkZ2VTcmMuYnVmLnRvU3RyaW5nKCd1dGY4JykubWF0Y2goL2NvbnN0IEJSSURHRV9WID0gKFxkKykvKSA6IG51bGw7DQogIHJldHVybiB7IGNoYW5nZWQsIHdhdGNoZXJDaGFuZ2VkLCBicmlkZ2VWOiB2bSA/IE51bWJlcih2bVsxXSkgOiBudWxsIH07DQp9DQoNCi8vIOuLpOumrCgxMTg4OCnqsIAg65agIOyeiOycvOuptCDrgYjri6Qg4oCUIOy0iOq4sO2ZlCDsi5wg64Ko7J2AIOyEuOyFmCDsoJXrpqwgKOyXhuycvOuptCDsobDsmqntnogg7Iuk7YyoKQ0KZnVuY3Rpb24gc2h1dGRvd25CcmlkZ2UoKSB7DQogIHRyeSB7DQogICAgY29uc3QgciA9IGh0dHAucmVxdWVzdCh7IGhvc3Q6ICcxMjcuMC4wLjEnLCBwb3J0OiAxMTg4OCwgcGF0aDogJy9zaHV0ZG93bicsIG1ldGhvZDogJ1BPU1QnLCB0aW1lb3V0OiAxNTAwIH0sICgpID0+IHt9KTsNCiAgICByLm9uKCdlcnJvcicsICgpID0+IHt9KTsNCiAgICByLm9uKCd0aW1lb3V0JywgKCkgPT4geyB0cnkgeyByLmRlc3Ryb3koKTsgfSBjYXRjaCAoX2UpIHt9IH0pOw0KICAgIHIuZW5kKCk7DQogIH0gY2F0Y2ggKF9lKSB7fQ0KfQ0KDQpjb25zdCBzZXJ2ZXIgPSBodHRwLmNyZWF0ZVNlcnZlcihhc3luYyAocmVxLCByZXMpID0+IHsNCiAgaWYgKHJlcS5tZXRob2QgPT09ICdPUFRJT05TJykgeyByZXMud3JpdGVIZWFkKDIwNCwgQ09SU19IRUFERVJTKTsgcmV0dXJuIHJlcy5lbmQoKTsgfQ0KICBpZiAocmVxLnVybCA9PT0gJy9oZWFsdGgnKSB7DQogICAgLy8gdjog6rCQ7Iuc7J6QIOy9lOuTnCDrsoTsoIQg4oCUIOq1rOuyhOyghCDtlITroZzshLjsiqTqsIAg6rOE7IaNIOuPjOqzoCDsnojripTsp4Ag67CW7JeQ7IScIO2ZleyduO2VmOuKlCDsmqnrj4QNCiAgICAvLyAodjIgPSDssL0g7Iio6rmAIOyImOygle2MkCwgdjMgPSAvYWNjb3VudCDstpTqsIDtjJAsIHY0ID0gL3VuaW5zdGFsbCDstpTqsIDtjJAsDQogICAgLy8gIHY1ID0g6rOE7KCV7J2EIOyekOqyqeymneuqhSDsnKDrrLTroZwg7YyQ7KCVIOKAlCDroZzqt7jslYTsm4Mg65KkIOuCqOydgCDsnbTrqZTsnbzsnYQg66Gc6re47J247Jy866GcIOyYpO2VtO2VmOyngCDslYrqsowsDQogICAgLy8gIHY2ID0g66el7J2AIOyekOqyqeymneuqheydtCDtgqTssrTsnbjsl5Ag7J6I7Ja0IO2MjOydvCDqsoDsgqzrp4zsnLzroZzripQgJ+uhnOq3uOyduCDslYgg65CoJ+ydtCDrkJjrjZgg6rKDIOuMgOydkSwNCiAgICAvLyAgdjcgPSAvcmVzdGFydCDstpTqsIAgKyDtj6ztirgg7J6s7Iuc64+EIOKAlCDsmJsg6rCQ7Iuc7J6Q6rCAIOyYmyDri6Trpqzrpbwg6rOE7IaNIOy8nOuNmCDqsoMg64yA7J2RLA0KICAgIC8vICB2OCA9IC91cGRhdGUg7LaU6rCAIOKAlCDtlIzrn6zqt7jsnbjsnbQg65Ok6rOgIOyeiOuKlCDshKTsuZgg7YyM7J2866GcIOyEpOy5mOuzuOydhCDsiqTsiqTroZwg6rCx7IugLA0KICAgIC8vICB2OSA9IC91cGRhdGUg7J6F66Cl7J2EIGJhdCDtjpjsnbTroZzrk5zsl5DshJwgKirsu6TrhKXthLAgemlwKirsnLzroZwg6rWQ7LK0ICjrsLHsi6Ag7Jik7YOQIO2ajO2UvCkpDQogICAgcmV0dXJuIGpzb24ocmVzLCAyMDAsIHsgb2s6IHRydWUsIHdhdGNoZXI6IHRydWUsIHY6IDkgfSk7DQogIH0NCiAgLy8g7J20IFBD7JeQIOuhnOq3uOyduOuQnCDtgbTroZzrk5wg6rOE7KCVIOKAlCDtlIzrn6zqt7jsnbgg7LKrIO2ZlOuptMK37ZmI7J20ICLriITqtawg6rOE7KCV7Jy866GcIOyTsOuKlOyngCIg67O07Jes7KO864qUIOuNsCDsk7Tri6QuDQogIC8vIOqwkOyLnOyekOqwgCDri7XtlZjripQg7J207JygOiDri6Trpqzrpbwg7Lyc66m0IOybjOuwjeyXheycvOuhnCDtgbTroZzrk5zqsIAg7Iuk7KCcIO2YuOy2nOuPvCDqtazrj4Ug7IKs7Jqp65+J7J20IOuCmOqwhOuLpC4NCiAgLy8g6rCQ7Iuc7J6Q64qUIO2MjOydvOunjCDsnb3snLzrr4DroZwg7IKs7Jqp65+JIDAgwrcg64yA6riwIDAg4oCUIOqygO2GoOunjCDsk7DripQg7IKs656M7JeQ6rKMIOu5hOyaqeydhCDrrLzrpqzsp4Ag7JWK64qU64ukLg0KICAvLyDso7zsnZg6IOyXrOq4sCDqs4TsoJXsnbQg67O07Jes64+EIOyeheyepeq2jOydtCDrp4zro4zrkJDsnYQg7IiYIOyeiOuLpCjsnKDtmqjshLHsnYAg7Iuk7KCcIO2YuOy2nCDrlYzrp4wg7JWMIOyImCDsnojsnYwg4oCUIOuLpOumrCAvaGVhbHRo7J2YIHByb2JsZW0g7LC46rOgKS4NCiAgaWYgKHJlcS51cmwgPT09ICcvYWNjb3VudCcpIHsNCiAgICByZXR1cm4ganNvbihyZXMsIDIwMCwgeyBvazogdHJ1ZSwgYWNjb3VudDogY2xhdWRlQWNjb3VudCgpLCBjbGF1ZGU6IGhhc0NsYXVkZSgpIH0pOw0KICB9DQogIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgcmVxLnVybCA9PT0gJy93YWtlJykgew0KICAgIGlmICghaGFzQ2xhdWRlKCkpIHJldHVybiBqc29uKHJlcywgMjAwLCB7IG9rOiBmYWxzZSwgcHJvYmxlbTogJ2NsYXVkZS1taXNzaW5nJyB9KTsNCiAgICB3YWtlQnJpZGdlKCk7DQogICAgcmV0dXJuIGpzb24ocmVzLCAyMDAsIHsgb2s6IHRydWUsIHdha2luZzogdHJ1ZSB9KTsNCiAgfQ0KICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHJlcS51cmwgPT09ICcvc2h1dGRvd24nKSB7DQogICAganNvbihyZXMsIDIwMCwgeyBvazogdHJ1ZSB9KTsNCiAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgwKSwgMjAwKTsNCiAgICByZXR1cm47DQogIH0NCiAgLy8g6rCQ7Iuc7J6Q66W8IOyDiCDsvZTrk5zroZwg64uk7IucIOudhOyatOuLpCDigJQg64uk66as66W8IOq7kOuLpCDsvJzrj4Qg6rOE7IaNIOyYmyDrsoTsoITsnbQg7Lyc7KeIIOuVjCjsnIQgcmVzdGFydFNlbGYg7KO87ISdKSDsk7Tri6QuDQogIC8vIOydkeuLteydhCDrqLzsoIAg67O064K4IOuSpCDsg4gg7J247Iqk7YS07Iqk66W8IOudhOyasOqzoCDsmrDrpqzripQg67mg7KeE64ukIOKAlCDsg4gg7Kq97J2AIO2PrO2KuOqwgCDruYwg65WM6rmM7KeAIOyerOyLnOuPhO2VnOuLpC4NCiAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiByZXEudXJsID09PSAnL3Jlc3RhcnQnKSB7DQogICAganNvbihyZXMsIDIwMCwgeyBvazogdHJ1ZSwgcmVzdGFydGluZzogdHJ1ZSwgdjogOSB9KTsNCiAgICBzZXRUaW1lb3V0KCgpID0+IHsNCiAgICAgIHNodXRkb3duQnJpZGdlKCk7IC8vIOyYmyDsvZTrk5zroZwg65agIOyeiOuKlCDri6Trpqzrj4Qg6rCZ7J20IOuCtOumsOuLpCDigJQg64uk7J2MIOyalOyyrSDrlYwg7IOIIOqwkOyLnOyekOqwgCDsg4gg7L2U65Oc66GcIOy8oOuLpA0KICAgICAgcmVzdGFydFNlbGYoKTsNCiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAzMDApOw0KICAgIH0sIDIwMCk7DQogICAgcmV0dXJuOw0KICB9DQogIC8vIOyEpOy5mOuzuCDsnpDrj5kg6rCx7IugIOKAlCDtlIzrn6zqt7jsnbjsnbQg7J6Q6riw6rCAIOuTpOqzoCDsnojripQg7ISk7LmYIO2MjOydvChiYXNlNjQp7J2EIOuztOuCtOuptCDqt7gg7L2U65Oc66GcIOqwiOyVhOuBvOyatOuLpC4NCiAgLy8g7KCA7J6l7IaM7JeQ7IScIOuPjOqzoCDsnojsnLzrqbQg6rGw7KCI7ZWc64ukOiDshozsiqQg7Y+0642U66W8IOu5jOuTnCDsgrDstpzrrLzroZwg642u7Ja07JOw66m0IOyekeyXhSDspJHsnbgg7L2U65Oc6rCAIOuCoOyVhOqwhOuLpA0KICAvLyAo7KCA7J6l7IaMIFBD64qUIG5wbSBydW4gYnVpbGTsnZggc3luYy1pbnN0YWxsLmpz6rCAIOuLtOuLue2VnOuLpCkuDQogIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgcmVxLnVybCA9PT0gJy91cGRhdGUnKSB7DQogICAgY29uc3QgYm9keSA9IGF3YWl0IHJlYWRCb2R5KHJlcSk7DQogICAgaWYgKGZzLmV4aXN0c1N5bmMocGF0aC5qb2luKFJPT1QsICdwYWNrYWdlLmpzb24nKSkpIHsNCiAgICAgIHJldHVybiBqc29uKHJlcywgMjAwLCB7IG9rOiBmYWxzZSwgcmVhc29uOiAncmVwbycsIGRpcjogUk9PVCB9KTsNCiAgICB9DQogICAgbGV0IHI7DQogICAgdHJ5IHsgciA9IGFwcGx5SW5zdGFsbGVyKGJvZHkgJiYgYm9keS5pbnN0YWxsZXIpOyB9DQogICAgY2F0Y2ggKGUpIHsgcmV0dXJuIGpzb24ocmVzLCA1MDAsIHsgb2s6IGZhbHNlLCBlcnJvcjogZS5tZXNzYWdlIH0pOyB9DQogICAgY29uc29sZS5sb2coJ1t3YXRjaGVyXSDshKTsuZjrs7gg6rCx7IugIOKAlCDrsJTrgJAg7YyM7J28OicsIHIuY2hhbmdlZC5qb2luKCcsICcpIHx8ICco7JeG7J2MKScsICfri6TrpqwgdicgKyByLmJyaWRnZVYpOw0KICAgIGpzb24ocmVzLCAyMDAsIHsgb2s6IHRydWUsIGNoYW5nZWQ6IHIuY2hhbmdlZCwgYnJpZGdlVjogci5icmlkZ2VWLCB3YXRjaGVyQ2hhbmdlZDogci53YXRjaGVyQ2hhbmdlZCwgZGlyOiBST09UIH0pOw0KICAgIGlmICghci5jaGFuZ2VkLmxlbmd0aCkgcmV0dXJuOyAvLyDsnbTrr7gg7LWc7IugIOKAlCDrlqAg7J6I64qUIOuLpOumrOulvCDqtbPsnbQg64GK7KeAIOyViuuKlOuLpA0KICAgIHNldFRpbWVvdXQoKCkgPT4gew0KICAgICAgc2h1dGRvd25CcmlkZ2UoKTsgLy8g7JibIOy9lOuTnOuhnCDrlqAg7J6I64qUIOuLpOumrOulvCDrgrTrprDri6Qg4oCUIOuLpOydjCAvd2FrZeqwgCDsg4gg7L2U65Oc66GcIOy8oOuLpA0KICAgICAgaWYgKHIud2F0Y2hlckNoYW5nZWQpIHsgcmVzdGFydFNlbGYoKTsgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMCksIDMwMCk7IH0gLy8g7Jqw66as64+EIOyDiCDsvZTrk5zroZwNCiAgICB9LCAyMDApOw0KICAgIHJldHVybjsNCiAgfQ0KICAvLyDstIjquLDtmZQg4oCUIOydtCBQQ+ulvCAn7IOIIFBDJyDsg4Htg5zroZwg65CY64+M66aw64ukICjtlIzrn6zqt7jsnbggW+y0iOq4sO2ZlF0g67KE7Yq8KS4NCiAgLy8g7J2R64u17J2EIOuovOyggCDtnZjroKTrs7Trgrgg65KkIOygleumrO2VnOuLpCDigJQgYm9vdG91dOydtCDsmrDrpqzrpbwg7KaJ7IucIOyjveyXrOuPhCDtmozsi6DsnYAg64+E7LCp7ZWc64ukLg0KICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHJlcS51cmwgPT09ICcvdW5pbnN0YWxsJykgew0KICAgIGpzb24ocmVzLCAyMDAsIHsgb2s6IHRydWUsIHBsYXRmb3JtOiBwcm9jZXNzLnBsYXRmb3JtIH0pOw0KICAgIHNldFRpbWVvdXQoKCkgPT4gew0KICAgICAgc2h1dGRvd25CcmlkZ2UoKTsNCiAgICAgIGNvbnN0IHJlbW92ZWQgPSB1bmluc3RhbGxTZWxmKCk7DQogICAgICBjb25zb2xlLmxvZygnW3dhdGNoZXJdIOy0iOq4sO2ZlCh1bmluc3RhbGwpIOKAlCDsoJzqsbA6JywgcmVtb3ZlZC5qb2luKCcsICcpIHx8ICco7JeG7J2MKScpOw0KICAgICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMCksIDIwMCk7DQogICAgfSwgMjUwKTsNCiAgICByZXR1cm47DQogIH0NCiAgcmV0dXJuIGpzb24ocmVzLCA0MDQsIHsgZXJyb3I6ICdOb3QgZm91bmQnIH0pOw0KfSk7DQoNCi8vIO2PrO2KuOqwgCDsnqHtmIAg7J6I7Jy866m0IOyeoOq5kCDquLDri6TroLjri6Qg64uk7IucIOyLnOuPhO2VmOqzoCwg6re4656Y64+EIOyViCDrkJjrqbQg7KGw7Jqp7Z6IIOyiheujjA0KLy8gKOyekOuPmSDsi5zsnpEgKyBucG0gYnVpbGQg7KSR67O1IOyLpO2WiSDrjIDruYQpLiDsnqzsi5zrj4TqsIAg7ZWE7JqU7ZWcIOydtOycoDogL3Jlc3RhcnTripQg7IOIIOyduOyKpO2EtOyKpOulvCDrqLzsoIAg652E7Jqw6rOgDQovLyDsmJsg7J247Iqk7YS07Iqk6rCAIOu5oOyngOuvgOuhnCwg7LKrIOyLnOuPhOyXkOyEnCDrrLzrn6zrgpgg67KE66as66m0IOyVhOustOuPhCDslYgg64Ko64qU64ukLg0KbGV0IGJpbmRUcmllcyA9IDA7DQpzZXJ2ZXIub24oJ2Vycm9yJywgKGUpID0+IHsNCiAgaWYgKGUgJiYgZS5jb2RlID09PSAnRUFERFJJTlVTRScgJiYgYmluZFRyaWVzIDwgNikgew0KICAgIGJpbmRUcmllcysrOw0KICAgIHNldFRpbWVvdXQoKCkgPT4gc2VydmVyLmxpc3RlbihQT1JULCAnMTI3LjAuMC4xJyksIDEwMDApOw0KICAgIHJldHVybjsNCiAgfQ0KICBpZiAoZSAmJiBlLmNvZGUgPT09ICdFQUREUklOVVNFJykgcHJvY2Vzcy5leGl0KDApOw0KICBwcm9jZXNzLmV4aXQoMSk7DQp9KTsNCnNlcnZlci5saXN0ZW4oUE9SVCwgJzEyNy4wLjAuMScsICgpID0+IHsNCiAgY29uc29sZS5sb2coJ1t3YXRjaGVyXSDtgbTroZzrk5wg64uk66asIOqwkOyLnOyekCDsvJzsp5Ag4oCUIGh0dHA6Ly9sb2NhbGhvc3Q6JyArIFBPUlQpOw0KfSk7DQovLyBJUHY2IOujqO2UhOuwsSg6OjEp7JeQ64+EIO2VqOq7mCDrk6PripTri6Qg4oCUICdsb2NhbGhvc3Qn6rCAIDo6MeuhnCDrqLzsoIAg7ZW07ISd65CY64qUIO2ZmOqyveyXkOyEnA0KLy8g7ZS86re466eIIGZldGNo6rCAIElQdjTroZwg7Y+067Cx7ZWY7KeAIOyViuyVhCDri6Trpqwg6rmo7Jqw6riwwrfqs4TsoJUg7KGw7ZqM6rCAIOyhsOyaqe2eiCDsi6TtjKjtlZjrjZgg66y47KCcIOuMgOydkSjri6TrpqzsmYAg64+Z7J28KS4NCmNvbnN0IHNlcnZlcjYgPSBodHRwLmNyZWF0ZVNlcnZlcihzZXJ2ZXIubGlzdGVuZXJzKCdyZXF1ZXN0JylbMF0pOw0KLy8gOjox7J2EIOuquyDsnqHslYTrj4QoRUFERFJJTlVTRcK3SVB2NiDsl4bsnYwpIElQdjTrp4zsnLzroZwg6rOE7IaNIOuPmeyekSDigJQg64uk66eMIC9yZXN0YXJ0IOynge2bhOyXlCDsmJsg7J247Iqk7YS07Iqk6rCADQovLyDslYTsp4EgOjox7J2EIOusvOqzoCDsnojslrQg7LKrIOyLnOuPhOqwgCDsi6TtjKjtlZzri6QuICdsb2NhbGhvc3Qn6rCAIDo6MeuhnCDrqLzsoIAg7ZKA66as64qUIO2ZmOqyveyXkOyEnCDqt7jrjIDroZwg65GQ66m0DQovLyDtlLzqt7jrp4ggZmV0Y2jqsIAg7KGw7Jqp7Z6IIOyLpO2MqO2VmOuvgOuhnCBJUHY07JmAIOqwmeydgCDtmp/siJjrp4ztgbwg7J6s7Iuc64+E7ZWc64ukLg0KbGV0IGJpbmRUcmllczYgPSAwOw0Kc2VydmVyNi5vbignZXJyb3InLCAoZSkgPT4gew0KICBpZiAoZSAmJiBlLmNvZGUgPT09ICdFQUREUklOVVNFJyAmJiBiaW5kVHJpZXM2IDwgNikgew0KICAgIGJpbmRUcmllczYrKzsNCiAgICBzZXRUaW1lb3V0KCgpID0+IHNlcnZlcjYubGlzdGVuKFBPUlQsICc6OjEnKSwgMTAwMCk7DQogIH0NCn0pOw0Kc2VydmVyNi5saXN0ZW4oUE9SVCwgJzo6MScpOw0KUEsDBBQAAAgAAAAAAADX9Oje5RMAAOUTAAAcAAAAc2NyaXB0cy9yZWdpc3Rlci1wcm90b2NvbC5qcy8vIOydtCBQQ+ydmCDtgbTroZzrk5wg7Jew6rKw7J2EIOyekOuPmSDshKTsoJXtlZzri6QgKG5wbSBpbnN0YWxsIC8gbnBtIHJ1biBidWlsZOyXkCDtj6ztlagpLg0KLy8gMSkgY2xhdWRlYnJpZGdlOi8vIO2UhOuhnO2GoOy9nCDrk7HroZ0gKOq1rOqyveuhnCDigJQg7ZS86re466eIIOuyhOyghOyXkCDrlLDrnbwg66eJ7Z6QIOyImCDsnojslrQg67O07KGw7JqpKQ0KLy8gMikg6rCQ7Iuc7J6QKGJyaWRnZS13YXRjaGVyLCDtj6ztirggMTE4ODkpIOuhnOq3uOyduCDsnpDrj5nsi5zsnpEg65Ox66GdICsg7KeA6riIIOuwlOuhnCDquLDrj5kgKOyjvOqyveuhnCDigJQNCi8vICAgIO2UvOq3uOuniOqwgCDtlITroZzthqDsvZwg7Je06riw66W8IOunieyVhOuPhCDtlIzrn6zqt7jsnbggZmV0Y2jripQg66q7IOunieycvOuvgOuhnCDqsJDsi5zsnpDqsIAg64uk66as66W8IOuMgOyLoCDsvKDri6QpDQovLyDsg4ggUEPsl5Ag7ZSM65+s6re47J247J2EIOyEpOy5mO2VmOugpOuptCDslrTssKjtlLwgbnBt7J2EIO2VnCDrsogg64+M66Ck7JW8IO2VmOuvgOuhnCwg6re4IOyInOqwhOyXkCDshKTsoJXsnbQg64Gd64Kc64ukLg0KLy8gSEtDVeudvCDqtIDrpqzsnpAg6raM7ZWcIOu2iO2VhOyalC4g7Iuk7Yyo7ZW064+EIOu5jOuTnOuKlCDqs4Tsho0oZmFpbC1zb2Z0KS4NCmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7DQpjb25zdCB7IHNwYXduLCBzcGF3blN5bmMgfSA9IHJlcXVpcmUoJ2NoaWxkX3Byb2Nlc3MnKTsNCg0KaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nKSB7DQogIC8vIG1hY09TOiDqsJDsi5zsnpAoYnJpZGdlLXdhdGNoZXIp66W8IGxhdW5jaGQg66Gc6re47J24IOyekOuPmeyLnOyekeycvOuhnCDrk7HroZ0gKyDsponsi5wg6riw64+ZLg0KICAvLyBjbGF1ZGVicmlkZ2U6Ly8g7ZSE66Gc7Yag7L2c7J2AIOuTseuhne2VmOyngCDslYrripTri6Qg4oCUIO2UvOq3uOuniOqwgCDtlITroZzthqDsvZwg7Je06riw66W8IOyghOu2gCDrp4nripQg6rKD7J20DQogIC8vIOyLpOy4oSDtmZXsnbjrj7woQ0xBVURFLm1kKSwg7Ja07LCo7ZS8IOycoOydvO2VnCDrj5nsnpEg6rK966Gc6rCAIOqwkOyLnOyekCBmZXRjaCgxMTg4OSnsnbTrr4DroZwg6rCQ7Iuc7J6Q66eM7Jy866GcIOy2qeu2hC4NCiAgY29uc3Qgb3MgPSByZXF1aXJlKCdvcycpOw0KICBjb25zdCBmcyA9IHJlcXVpcmUoJ2ZzJyk7DQogIGNvbnN0IExBQkVMID0gJ2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlcic7DQogIGNvbnN0IGFnZW50c0RpciA9IHBhdGguam9pbihvcy5ob21lZGlyKCksICdMaWJyYXJ5JywgJ0xhdW5jaEFnZW50cycpOw0KICBjb25zdCBwbGlzdFBhdGggPSBwYXRoLmpvaW4oYWdlbnRzRGlyLCBMQUJFTCArICcucGxpc3QnKTsNCiAgY29uc3Qgd2F0Y2hlckpzID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJ2JyaWRnZS13YXRjaGVyLmpzJyk7DQogIC8vIGxhdW5jaGQg6riw67O4IFBBVEjsl5QgL3Vzci9sb2NhbC9iaW4g65Ox7J20IOyXhuyWtCDri6TrpqzqsIAgY2xhdWRl66W8IOuquyDssL7ripTri6Qg4oCUDQogIC8vIOuTseuhnSDsi5zsoJAo7IKs7Jqp7J6QIOyFuCnsnZggUEFUSOulvCBwbGlzdOyXkCDqtbPtmIAg64Sj64qU64ukLg0KICBjb25zdCBwYXRoRW52ID0gcHJvY2Vzcy5lbnYuUEFUSCB8fCAnL3Vzci9sb2NhbC9iaW46L3Vzci9iaW46L2JpbjovdXNyL3NiaW46L3NiaW4nOw0KICBjb25zdCB4bWwgPSAocykgPT4gU3RyaW5nKHMpLnJlcGxhY2UoLyYvZywgJyZhbXA7JykucmVwbGFjZSgvPC9nLCAnJmx0OycpLnJlcGxhY2UoLz4vZywgJyZndDsnKTsNCiAgY29uc3QgcGxpc3QgPSBbDQogICAgJzw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+JywNCiAgICAnPCFET0NUWVBFIHBsaXN0IFBVQkxJQyAiLS8vQXBwbGUvL0RURCBQTElTVCAxLjAvL0VOIiAiaHR0cDovL3d3dy5hcHBsZS5jb20vRFREcy9Qcm9wZXJ0eUxpc3QtMS4wLmR0ZCI+JywNCiAgICAnPHBsaXN0IHZlcnNpb249IjEuMCI+JywNCiAgICAnPGRpY3Q+JywNCiAgICAnICA8a2V5PkxhYmVsPC9rZXk+PHN0cmluZz4nICsgTEFCRUwgKyAnPC9zdHJpbmc+JywNCiAgICAnICA8a2V5PlByb2dyYW1Bcmd1bWVudHM8L2tleT4nLA0KICAgICcgIDxhcnJheT4nLA0KICAgICcgICAgPHN0cmluZz4nICsgeG1sKHByb2Nlc3MuZXhlY1BhdGgpICsgJzwvc3RyaW5nPicsDQogICAgJyAgICA8c3RyaW5nPicgKyB4bWwod2F0Y2hlckpzKSArICc8L3N0cmluZz4nLA0KICAgICcgIDwvYXJyYXk+JywNCiAgICAnICA8a2V5PkVudmlyb25tZW50VmFyaWFibGVzPC9rZXk+JywNCiAgICAnICA8ZGljdD48a2V5PlBBVEg8L2tleT48c3RyaW5nPicgKyB4bWwocGF0aEVudikgKyAnPC9zdHJpbmc+PC9kaWN0PicsDQogICAgJyAgPGtleT5SdW5BdExvYWQ8L2tleT48dHJ1ZS8+JywNCiAgICAvLyDruYTsoJXsg4Eg7KKF66OMIOyLnOyXkOunjCDsnqzsi5zrj5kg4oCUIEVBRERSSU5VU0UoZXhpdCAwKSDspJHrs7Ug6riw64+Z7J20IOustO2VnCDsnqzsi5zsnpHsnLzroZwg67KI7KeA7KeAIOyViuqyjA0KICAgICcgIDxrZXk+S2VlcEFsaXZlPC9rZXk+PGRpY3Q+PGtleT5TdWNjZXNzZnVsRXhpdDwva2V5PjxmYWxzZS8+PC9kaWN0PicsDQogICAgJzwvZGljdD4nLA0KICAgICc8L3BsaXN0PicsDQogICAgJycsDQogIF0uam9pbignXG4nKTsNCiAgdHJ5IHsNCiAgICBmcy5ta2RpclN5bmMoYWdlbnRzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTsNCiAgICBmcy53cml0ZUZpbGVTeW5jKHBsaXN0UGF0aCwgcGxpc3QpOw0KICAgIGNvbnN0IHVpZCA9IHByb2Nlc3MuZ2V0dWlkKCk7DQogICAgLy8g7J6s65Ox66GdIOuMgOu5hDog6riw7KG0IOuTseuhneydhCDrgrTrpqzqs6AoYm9vdG91dCwg7JeG7Jy866m0IOyhsOyaqe2eiCDsi6TtjKgpIOuLpOyLnCDsmKzrprDri6QuDQogICAgc3Bhd25TeW5jKCdsYXVuY2hjdGwnLCBbJ2Jvb3RvdXQnLCAnZ3VpLycgKyB1aWQgKyAnLycgKyBMQUJFTF0sIHsgc3RkaW86ICdpZ25vcmUnIH0pOw0KICAgIGNvbnN0IGJvb3QgPSBzcGF3blN5bmMoJ2xhdW5jaGN0bCcsIFsnYm9vdHN0cmFwJywgJ2d1aS8nICsgdWlkLCBwbGlzdFBhdGhdLCB7IHN0ZGlvOiAnaWdub3JlJyB9KTsNCiAgICBpZiAoYm9vdC5zdGF0dXMgIT09IDApIHNwYXduU3luYygnbGF1bmNoY3RsJywgWydsb2FkJywgJy13JywgcGxpc3RQYXRoXSwgeyBzdGRpbzogJ2lnbm9yZScgfSk7IC8vIOq1rOuyhOyghCBtYWNPUyDtj7TrsLENCiAgICBjb25zb2xlLmxvZygnW3dhdGNoZXJdIG1hY09TIOqwkOyLnOyekCDsnpDrj5nsi5zsnpEg65Ox66GdKGxhdW5jaGQpICsg6riw64+ZIOKAlCAnICsgcGxpc3RQYXRoKTsNCiAgfSBjYXRjaCAoZSkgew0KICAgIGNvbnNvbGUubG9nKCdbd2F0Y2hlcl0gbWFjT1Mg65Ox66GdIOyLpO2MqCjruYzrk5zripQg6rOE7IaNKTonLCBlLm1lc3NhZ2UpOw0KICB9DQogIHByb2Nlc3MuZXhpdCgwKTsNCn0NCg0KaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICd3aW4zMicpIHsNCiAgcHJvY2Vzcy5leGl0KDApOyAvLyBXaW5kb3dzL21hY09TIOyZuCBPUyDigJQg7KGw7Jqp7Z6IIO2GteqzvA0KfQ0KDQpjb25zdCBsYXVuY2hlciA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdjbGF1ZGUtYnJpZGdlLXNpbGVudC52YnMnKTsNCmNvbnN0IHdhdGNoZXJWYnMgPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnY2xhdWRlLXdhdGNoZXItc2lsZW50LnZicycpOw0KY29uc3QgY21kID0gJ3dzY3JpcHQuZXhlICInICsgbGF1bmNoZXIgKyAnIic7DQoNCmZ1bmN0aW9uIHJlZyhhcmdzKSB7DQogIHJldHVybiBzcGF3blN5bmMoJ3JlZycsIGFyZ3MsIHsgc3RkaW86ICdpZ25vcmUnIH0pLnN0YXR1cyA9PT0gMDsNCn0NCg0KY29uc3Qgb2sgPQ0KICByZWcoWydhZGQnLCAnSEtDVVxcU29mdHdhcmVcXENsYXNzZXNcXGNsYXVkZWJyaWRnZScsICcvdmUnLCAnL2QnLCAnVVJMOkNsYXVkZSBCcmlkZ2UnLCAnL2YnXSkgJiYNCiAgcmVnKFsnYWRkJywgJ0hLQ1VcXFNvZnR3YXJlXFxDbGFzc2VzXFxjbGF1ZGVicmlkZ2UnLCAnL3YnLCAnVVJMIFByb3RvY29sJywgJy9kJywgJycsICcvZiddKSAmJg0KICByZWcoWydhZGQnLCAnSEtDVVxcU29mdHdhcmVcXENsYXNzZXNcXGNsYXVkZWJyaWRnZVxcc2hlbGxcXG9wZW5cXGNvbW1hbmQnLCAnL3ZlJywgJy9kJywgY21kLCAnL2YnXSk7DQoNCmlmIChvaykgew0KICBjb25zb2xlLmxvZygnW3Byb3RvY29sXSBjbGF1ZGVicmlkZ2U6Ly8g65Ox66GdIOyZhOujjCDihpIgJyArIGxhdW5jaGVyKTsNCn0gZWxzZSB7DQogIGNvbnNvbGUubG9nKCdbcHJvdG9jb2xdIGNsYXVkZWJyaWRnZTovLyDrk7HroZ0g7Iuk7YyoIOKAlCDtlIzrn6zqt7jsnbjsnZggWyLtgbTroZzrk5wg7Luk64Sl7YSwIiDshKTsuZgg7YyM7J28IOuwm+q4sF3roZwg65Ox66Gd7ZWY7IS47JqULicpOw0KfQ0KDQovLyDqsJDsi5zsnpA6IOuhnOq3uOyduCDsnpDrj5nsi5zsnpEg65Ox66GdICsg7KeA6riIIOuwlOuhnCDquLDrj5kgKOydtOuvuCDrlqAg7J6I7Jy866m0IEVBRERSSU5VU0XroZwg7KGw7Jqp7Z6IIOusvOufrOuCqCkNCmNvbnN0IHdhdGNoZXJPayA9IHJlZyhbJ2FkZCcsICdIS0NVXFxTb2Z0d2FyZVxcTWljcm9zb2Z0XFxXaW5kb3dzXFxDdXJyZW50VmVyc2lvblxcUnVuJywgJy92JywgJ0NsYXVkZUJyaWRnZVdhdGNoZXInLCAnL2QnLCAnd3NjcmlwdC5leGUgIicgKyB3YXRjaGVyVmJzICsgJyInLCAnL2YnXSk7DQp0cnkgew0KICBjb25zdCBwID0gc3Bhd24oJ3dzY3JpcHQuZXhlJywgW3dhdGNoZXJWYnNdLCB7IGRldGFjaGVkOiB0cnVlLCBzdGRpbzogJ2lnbm9yZScgfSk7DQogIHAudW5yZWYoKTsNCiAgY29uc29sZS5sb2coJ1t3YXRjaGVyXSDqsJDsi5zsnpAgJyArICh3YXRjaGVyT2sgPyAn7J6Q64+Z7Iuc7J6RIOuTseuhnSArICcgOiAnJykgKyAn6riw64+ZICjtj6ztirggMTE4ODkpJyk7DQp9IGNhdGNoIChlKSB7DQogIGNvbnNvbGUubG9nKCdbd2F0Y2hlcl0g6riw64+ZIOyLpO2MqCjsnpDrj5nsi5zsnpEg65Ox66Gd7J2AICcgKyAod2F0Y2hlck9rID8gJ+uQqCcgOiAn7Iuk7YyoJykgKyAnKTonLCBlLm1lc3NhZ2UpOw0KfQ0KUEsDBBQAAAgAAAAAAACvADp/dkMAAHZDAAAVAAAAcmVjb21tZW5kLWV4YW1wbGVzLm1kIyDrrLjqtawg7LaU7LKcIOyYiOyLnAoKIuusuOq1rCDstpTsspzrsJvquLAi6rCAIOyCrOyaqe2VmOuKlCDsmIjsi5wg66qo7J2M7J6F64uI64ukLiAqKuydtCDtjIzsnbzsnYQg7IiY7KCV7ZWcIOuSpCDthLDrr7jrhJDsl5DshJwgYG5wbSBydW4gYnVpbGRg66W8IOyLpO2Wie2VmOqzoCwgRmlnbWHsl5DshJwg7ZSM65+s6re47J247J2EIOuLpOyLnCDsi6TtlontlZjrqbQg67CY7JiB65Cp64uI64ukLioqCgojIyDsnpHshLEg67Cp67KVCgotIOyYiOyLnCDtlZjrgpjripQgKipgIyMjIOybkOuzuGAqKiDtlZwg7KSE6rO8LCDqt7gg7JWE656YICoqYC0g7LaU7LKc7JWIYCoqIOyXrOufrCDqsJzroZwg7J2066SE7KeR64uI64ukLgotIOy2lOyynOyViCDslYjsl5DshJwgKirspITsnYQg67CU6r646rOgIOyLtuycvOuptCBgIC8gYCAo7JWe65KkIOqzteuwsSDtj6ztlagg7Iqs656Y7IucKSoqIOuhnCDtkZzsi5ztlZjshLjsmpQuIO2UjOufrOq3uOyduOyXkOyEnCDrkZAg7KSE66GcIOuztOyXrOynkeuLiOuLpC4KLSDsgqzsmqnsnpDqsIAg7J6F66Cl7ZWcIOusuOq1rOqwgCBg7JuQ67O4YOqzvCAo6rO167CxwrfrrLjsnqXrtoDtmLgg66y07Iuc7ZWY6rOgKSDqsJnqsbDrgpgsIOyEnOuhnCDtj6ztlajtlZjrqbQg6re4IOy2lOyynOyViOuTpOydhCDrs7Tsl6zspI3ri4jri6QuCi0g66ek7Lmt7ZWgIOuVjCAqKuuniOyKpO2CueuQnCDsnbTrpoQo7ZmNXCrrj5kpLCDsiKvsnpAo7KCE7ZmU67KI7Zi4wrci7Jm4IDLrqoUiIOuTsSnripQg66y07IucKirtlanri4jri6Qg4oCUIOydtOumhMK37IiY65+JwrfrsojtmLjrp4wg64uk66W4IOusuOq1rOuPhCDqsJnsnYAg7JiI7Iuc66GcIOyeoe2YgOyalC4g64uoLCDstpTsspzslYjsl5Ag7KCB7Ja065GUIOydtOumhMK37Iir7J6Q64qUIOq3uOuMgOuhnCDrgpjsmKTri4gg7Iuk7KCcIOqwkuyXkCDrp57qsowg6rOg7LOQIOyTsOyEuOyalC4KLSDsoJzrqqkoYCMjYCnqs7wgYCMjI2AsIGAtYCDquLDtmLjripQg7ZiV7Iud7J2064uIIOuwlOq+uOyngCDrp4jshLjsmpQuCgojIyDsiqTtg4Dsnbwg7JuQ7LmZICjssLjqs6Ag4oCUIOyekOyEuO2VnCDrgrTsmqnsnYAgdXgtd3JpdGluZy5tZCDqsIDsnbTrk5wpCgotIO2VtOyalOyytCwg67aA65Oc65+s7Jq0IOyiheqysChgfuyeiOyWtOyalGAgYH7rj7zsmpRgIGB+7JeG7Ja07JqUYCBgfu2VtCDso7zshLjsmpRgKQotIDLri6gg6rWs7KGwOiAqKuyyqyDspIQ97IOB7ZmpIOyEpOuqhSDihpIg65GY7Ke4IOykhD3ri6TsnYwg7ZaJ64+ZKioo6rKw7KCV7J2AIGB+7ZWg6rmM7JqUP2AsIO2WieuPmSDsnKDrj4TripQgYH7tlbQg7KO87IS47JqUYCkKLSDriqXrj5nsoIEg66eQ7ZWY6riwKOuQkOyWtOyalOKGku2WiOyWtOyalCksIOq4jeygleyggSDrp5DtlZjquLAo7JeG7Ja07JqU4oaSfu2VmOuptCDtlaAg7IiYIOyeiOyWtOyalCkKLSDsupDso7zslrztlZwg6rK97Ja0KH7si5zqsqDslrTsmpQ/4oaSfu2VoOq5jOyalD8pLCDrqoXsgqwr66qF7IKsIO2SgOyWtOyTsOq4sCjsnpTslaEg67aA7KGx7Jy866Gc4oaS7J6U7JWh7J20IOu2gOyhse2VtOyEnCkKLSDqsITqsrDtlZjqs6Ag7Ims7Jq0IOunkCAo7KCE7Iah4oaS67O064K064ukKSwg67aA7KCVIOyDge2ZqeuPhCDrlLHrlLHtlZjsp4Ag7JWK6rKMKCLssL7quLAg7Iuk7YyoIuKdjCAi7LC+7J2EIOyImCDsl4bslrTsmpQi4pyFKQoKIyMg7LaU7LKcIOyYiOyLnAoKIyMjIOynhO2Wie2VmOuNmCDsnpHsl4XsnbQg7J6I7Iq164uI64ukLiDqs4Tsho3tlZjsi5zqsqDsirXri4jquYw/Ci0g7KeE7ZaJIOykkeyduCDrgrTsl63snbQg7J6I7Ja07JqULiAvIOydtOyWtOyEnCDsp4TtlontlaDquYzsmpQ/CgojIyMg6rO17JygIOyalOyyreydhCDst6jshoztlZjrqbQg7JqU7LKtIOuCtOyXreydtCDsgq3soJzrkKnri4jri6QuIOy3qOyGjO2VmOyLnOqyoOyKteuLiOq5jD8KLSDst6jshoztlaAg6rK97JqwIOyalOyyrSDrgrTsl63rj4Qg7IKt7KCc64+87JqULiAvIOqzteycoCDsmpTssq3snYQg7Leo7IaM7ZWg6rmM7JqUPwoKIyMjIOq4sOq4sOulvCDssL7sp4Ag66q77ZaI7Iq164uI64ukLiBRUuy9lOuTnOulvCDri6Tsi5wg7Iqk7LqU7ZWY7IS47JqULgotIOq4sOq4sOulvCDssL7snYQg7IiYIOyXhuyWtOyalC4gLyBRUuy9lOuTnOulvCDri6Tsi5wg7Iqk7LqU7ZW0IOyjvOyEuOyalC4KCiMjIyDrs7TtmLjsnpDqsIAg7ZeI65297ZWY6riwIOyghOyXkOuKlCDqsIDsnoXtlaAg7IiYIOyXhuyWtOyalAotIOuztO2YuOyekOqwgCDtl4jrnb3tlbTslbwg6rCA7J6F7ZWgIOyImCDsnojslrTsmpQuCgojIyMg7KeA6riIIOuyhOyghOyXkOyEnOuKlCDsk7gg7IiYIOyXhuyWtOyalC4g7IOd7LK0IOyduOymneydhCDsk7DroKTrqbQg7JWx7J2EIOy1nOyLoCDrsoTsoITsnLzroZwg7JeF642w7J207Yq4IO2VtOyjvOyEuOyalC4KLSDslbHsnYQg7JeF642w7J207Yq47ZW0IOyjvOyEuOyalC4gLyDsg53ssrQg7J247Kad7J2EIOyTsOugpOuptCDstZzsi6Ag67KE7KCE7J20IO2VhOyalO2VtOyalC4KCiMjIyDslrTrlqQg66qp7KCB7Jy866GcIOuMgOy2nOuwm+ycvOyLnOuCmOyalD8KLSDrjIDstpwg66qp7KCB7J20IOustOyXh+yduOqwgOyalD8KCiMjIyDslrTrlqQg7J207Jyg66GcIOyLoOqzoO2VmOyLnOuCmOyalD8KLSDsi6Dqs6Ag7J207Jyg66W8IOyEoO2Dne2VtCDso7zshLjsmpQuCgojIyMg7J6U7JWhIOu2gOyhseycvOuhnCDqtazrp6TtlZjsp4Ag66q77ZaI7Ja07JqUCi0g7J6U7JWh7J20IOu2gOyhse2VtOyEnCDqtazrp6TtlZjsp4Ag66q77ZaI7Ja07JqULgoKIyMjIO2ZjSrrj5koMDEwLTEyMzQtNTY3OCkg7Jm4IDLrqoXsl5Dqsowg6raM7ZWcIOyCreygnCDslYzrprzthqHsnYQg7KCE7Iah7ZWg6rmM7JqUPwotIOq2jO2VnCDsgq3soJwg7JWM66a87Yah7J2EIOuztOuCtOugpOqzoCDtlbTsmpQuIC8g7ZmNKuuPmSgwMTAtMTIzNC01Njc4KSDri5gg7Jm4IDLrqoXsl5Dqsowg67O064K86rmM7JqUPwotIO2ZjSrrj5koMDEwLTEyMzQtNTY3OCkg64uYIOyZuCAy66qF7JeQ6rKMIOq2jO2VnCDsgq3soJwg7JWM66a87Yah7J2EIOuztOuCvOq5jOyalD8KLSDqtoztlZwg7IKt7KCcIOyVjOumvO2GoeydhCDtmY0q64+ZKDAxMC0xMjM0LTU2NzgpIOuLmCDsmbggMuuqheyXkOqyjCDrs7TrgrzquYzsmpQ/CgojIyMjIO2ZleyduMK36rKw7KCVIO2MneyXhQoKIyMjIOygleunkCDsgq3soJztlZjsi5zqsqDsirXri4jquYw/IOyCreygnOuQnCDrjbDsnbTthLDripQg67O16rWs7ZWgIOyImCDsl4bsirXri4jri6QuCi0g7IKt7KCc7ZWY66m0IOuLpOyLnCDrkJjrj4zrprQg7IiYIOyXhuyWtOyalC4gLyDsoJXrp5Ag7IKt7KCc7ZWg6rmM7JqUPwoKIyMjIOuzgOqyveyCrO2VreydtCDsoIDsnqXrkJjsp4Ag7JWK7JWY7Iq164uI64ukLiDrgpjqsIDsi5zqsqDsirXri4jquYw/Ci0g7JWE7KeBIOyggOyepe2VmOyngCDslYrsnYAg64K07Jqp7J20IOyeiOyWtOyalC4gLyDsoIDsnqXtlZjsp4Ag7JWK6rOgIOuCmOqwiOq5jOyalD8KCiMjIyDroZzqt7jslYTsm4Mg7ZWY7Iuc6rKg7Iq164uI6rmMPwotIOuhnOq3uOyVhOybg+2VoOq5jOyalD8KCiMjIyDslbHsnYQg7KKF66OM7ZWY7Iuc6rKg7Iq164uI6rmMPwotIOyVseydhCDsooXro4ztlaDquYzsmpQ/CgojIyMg7ZWcIOuyiCDrs4Dqsr3tlZjrqbQg64uk7IucIOuzgOqyve2VoCDsiJgg7JeG7Iq164uI64ukLiDqs4Tsho3tlZjsi5zqsqDsirXri4jquYw/Ci0g7ZWcIOuyiCDrsJTqvrjrqbQg64uk7IucIOuwlOq/gCDsiJgg7JeG7Ja07JqULiAvIOqzhOyGje2VoOq5jOyalD8KCiMjIyDsnoXroKXtlZwg64K07Jqp7J20IOuqqOuRkCDsgq3soJzrkKnri4jri6QuIOy0iOq4sO2ZlO2VmOyLnOqyoOyKteuLiOq5jD8KLSDsnoXroKXtlZwg64K07Jqp7J20IOuqqOuRkCDsgq3soJzrj7zsmpQuIC8g7LSI6riw7ZmU7ZWg6rmM7JqUPwoKIyMjIyDsl5Drn6zCt+yLpO2MqAoKIyMjIOuEpO2KuOybjO2BrCDsl7DqsrDsl5Ag7Iuk7Yyo7ZaI7Iq164uI64ukLiDri6Tsi5wg7Iuc64+E7ZWY7Iut7Iuc7JikLgotIOuEpO2KuOybjO2BrOyXkCDsl7DqsrDtlaAg7IiYIOyXhuyWtOyalC4gLyDsl7DqsrAg7IOB7YOc66W8IO2ZleyduO2VmOqzoCDri6Tsi5wg7Iuc64+E7ZW0IOyjvOyEuOyalC4KCiMjIyDsnbzsi5zsoIHsnbgg7Jik66WY6rCAIOuwnOyDne2WiOyKteuLiOuLpC4g7J6g7IucIO2bhCDri6Tsi5wg7Iuc64+E7ZW0IOyjvOyLreyLnOyYpC4KLSDsnbzsi5zsoIHsnbgg7Jik66WY6rCAIOyDneqyvOyWtOyalC4gLyDsnqDsi5wg7ZuEIOuLpOyLnCDsi5zrj4TtlbQg7KO87IS47JqULgoKIyMjIOyVhOydtOuUlCDrmJDripQg67mE67CA67KI7Zi46rCAIOydvOy5mO2VmOyngCDslYrsirXri4jri6QuCi0g7JWE7J2065SUIOuYkOuKlCDruYTrsIDrsojtmLjqsIAg66ee7KeAIOyViuyVhOyalC4gLyDri6Tsi5wg7ZmV7J247ZW0IOyjvOyEuOyalC4KCiMjIyDsnbjspp3rsojtmLjqsIAg7J287LmY7ZWY7KeAIOyViuyKteuLiOuLpC4KLSDsnbjspp3rsojtmLjqsIAg66ee7KeAIOyViuyVhOyalC4gLyDri6Tsi5wg7J6F66Cl7ZW0IOyjvOyEuOyalC4KCiMjIyDsnbjspp0g7Iuc6rCE7J20IOy0iOqzvOuQmOyXiOyKteuLiOuLpC4g7J247Kad67KI7Zi466W8IOyerOuwnOyGoe2VmOyLreyLnOyYpC4KLSDsnbjspp0g7Iuc6rCE7J20IOyngOuCrOyWtOyalC4gLyDsnbjspp3rsojtmLjrpbwg64uk7IucIOuwm+yVhCDso7zshLjsmpQuCgojIyMg6rKA7IOJIOqysOqzvOqwgCDsl4bsirXri4jri6QuCi0g6rKA7IOJIOqysOqzvOqwgCDsl4bslrTsmpQuIC8g64uk66W4IOqygOyDieyWtOuhnCDri6Tsi5wg7LC+7JWE67O07IS47JqULgoKIyMjIOygleuztOulvCDrtojrn6zsmKTsp4Ag66q77ZaI7Iq164uI64ukLiDri6Tsi5wg7Iuc64+E7ZW0IOyjvOyLreyLnOyYpC4KLSDsoJXrs7Trpbwg67aI65+s7JisIOyImCDsl4bslrTsmpQuIC8g7J6g7IucIO2bhCDri6Tsi5wg7Iuc64+E7ZW0IOyjvOyEuOyalC4KCiMjIyDtjIzsnbwg7JeF66Gc65Oc7JeQIOyLpO2MqO2WiOyKteuLiOuLpC4KLSDtjIzsnbzsnYQg7Jis66as7KeAIOuqu+2WiOyWtOyalC4gLyDri6Tsi5wg7Iuc64+E7ZW0IOyjvOyEuOyalC4KCiMjIyDshJzruYTsiqQg7KCQ6rKAIOykkeyeheuLiOuLpC4g7J207Jqp7JeQIOu2iO2OuOydhCDrk5zroKQg7KOE7Iah7ZWp64uI64ukLgotIOyngOq4iOydgCDshJzruYTsiqTrpbwg7KCQ6rKA7ZWY6rOgIOyeiOyWtOyalC4gLyDsoJDqsoDsnbQg64Gd64KY66m0IOuLpOyLnCDsnbTsmqntlaAg7IiYIOyeiOyWtOyalC4KCiMjIyDtlYTsiJgg7J6F66ClIO2VreuqqeyeheuLiOuLpC4KLSDqvK0g7J6F66Cl7ZW07JW8IO2VmOuKlCDtla3rqqnsnbTsl5DsmpQuCgojIyMjIOq2jO2VnMK37ISk7KCVCgojIyMg7Lm066mU6528IOygkeq3vCDqtoztlZzsnbQg7JeG7Iq164uI64ukLiDshKTsoJXsl5DshJwg6raM7ZWc7J2EIO2XiOyaqe2VmOyLreyLnOyYpC4KLSDsubTrqZTrnbwg6raM7ZWc7J20IO2VhOyalO2VtOyalC4gLyDshKTsoJXsl5DshJwg7Lm066mU6528IOygkeq3vOydhCDtl4jsmqntlbQg7KO87IS47JqULgoKIyMjIOyVjOumvCDqtoztlZzsnbQg6rGw67aA65CY7Ja0IOyVjOumvOydhCDrsJvsnYQg7IiYIOyXhuyKteuLiOuLpC4KLSDslYzrprwg6raM7ZWc7J2EIO2XiOyaqe2VmOuptCDshozsi53snYQg67Cb7J2EIOyImCDsnojslrTsmpQuIC8g7ISk7KCV7JeQ7IScIOyVjOumvOydhCDsvJwg7KO87IS47JqULgoKIyMjIOychOy5mCDsoJXrs7Qg7J207Jqp7JeQIOuPmeydmO2VmOyngCDslYrslYQg7J2867aAIOq4sOuKpeydtCDsoJztlZzrkKnri4jri6QuCi0g7JyE7LmYIOygleuztOulvCDtl4jsmqntlZjrqbQg66qo65OgIOq4sOuKpeydhCDsk7gg7IiYIOyeiOyWtOyalC4gLyDshKTsoJXsl5DshJwg7JyE7LmYIOygkeq3vOydhCDtl4jsmqntlbQg7KO87IS47JqULgoKIyMjIyDsmYTro4zCt+ynhO2WiQoKIyMjIOyggOyepeuQmOyXiOyKteuLiOuLpC4KLSDsoIDsnqXtlojslrTsmpQuCgojIyMg67OA6rK97IKs7ZWt7J20IOyggeyaqeuQmOyXiOyKteuLiOuLpC4KLSDrs4Dqsr0g64K07Jqp7J2EIOyggeyaqe2WiOyWtOyalC4KCiMjIyDsoITshqHsnbQg7JmE66OM65CY7JeI7Iq164uI64ukLgotIOuztOuDiOyWtOyalC4KCiMjIyDrk7HroZ3snbQg7JmE66OM65CY7JeI7Iq164uI64ukLgotIOuTseuhneydhCDrp4jss6TslrTsmpQuCgojIyMg7IKt7KCc65CY7JeI7Iq164uI64ukLgotIOyCreygnO2WiOyWtOyalC4KCiMjIyDtgbTrpr3rs7Trk5zsl5Ag67O17IKs65CY7JeI7Iq164uI64ukLgotIOuzteyCrO2WiOyWtOyalC4KCiMjIyDsmpTssq3snYQg7LKY66asIOykkeyeheuLiOuLpC4g7J6g7Iuc66eMIOq4sOuLpOugpCDso7zsi63si5zsmKQuCi0g7JqU7LKt7J2EIOyymOumrO2VmOqzoCDsnojslrTsmpQuIC8g7J6g7Iuc66eMIOq4sOuLpOugpCDso7zshLjsmpQuCgojIyMjIOyViOuCtMK37Jyg64+ECgojIyMg7IOI66Gc7Jq0IOuyhOyghOydtCDstpzsi5zrkJjsl4jsirXri4jri6QuIOyXheuNsOydtO2KuCDtm4Qg7J207JqpIOqwgOuKpe2VqeuLiOuLpC4KLSDsg4gg67KE7KCE7J20IOuCmOyZlOyWtOyalC4gLyDsl4XrjbDsnbTtirjtlZjrqbQg7IOIIOq4sOuKpeydhCDsk7gg7IiYIOyeiOyWtOyalC4KCiMjIyDshJzruYTsiqQg7J207Jqp7J2EIOychO2VtCDslb3qtIAg64+Z7J2Y6rCAIO2VhOyalO2VqeuLiOuLpC4KLSDslb3qtIDsl5Ag64+Z7J2Y7ZWY66m0IOyEnOu5hOyKpOulvCDsi5zsnpHtlaAg7IiYIOyeiOyWtOyalC4KCiMjIyDsnqXsi5zqsIQg66+47IKs7Jqp7Jy866GcIOyekOuPmSDroZzqt7jslYTsm4Mg65CY7JeI7Iq164uI64ukLiDri6Tsi5wg66Gc6re47J247ZWY7Iut7Iuc7JikLgotIOyYpOueq+uPmeyViCDsgqzsmqntlZjsp4Ag7JWK7JWEIOuhnOq3uOyVhOybg+uQkOyWtOyalC4gLyDri6Tsi5wg66Gc6re47J247ZW0IOyjvOyEuOyalC4KCiMjIyDrs7TslYjsnYQg7JyE7ZW0IOu5hOuwgOuyiO2YuOulvCDrs4Dqsr3tlbQg7KO87Iuc6riwIOuwlOuejeuLiOuLpC4KLSDslYjsoITtlZwg7IKs7Jqp7J2EIOychO2VtCDruYTrsIDrsojtmLjrpbwg67CU6r+UIOyjvOyEuOyalC4KCiMjIyMg67O07JWIIOyEnOu5hOyKpAoKIyMjIOqyveu5hOulvCDqsJzsi5ztlZjsi5zqsqDsirXri4jquYw/Ci0g6rK967mE66W8IOyLnOyeke2VoOq5jOyalD8KCiMjIyDqsr3ruYTrpbwg7ZW07KCc7ZWY7Iuc6rKg7Iq164uI6rmMPwotIOqyveu5hOulvCDtlbTsoJztlaDquYzsmpQ/CgojIyMg6riw6riw6rCAIOyYpO2UhOudvOyduCDsg4Htg5zsnoXri4jri6QuIOuEpO2KuOybjO2BrCDsl7DqsrDsnYQg7ZmV7J247ZWY7Iut7Iuc7JikLgotIOq4sOq4sOqwgCDrhKTtirjsm4ztgazsl5Ag7Jew6rKw64+8IOyeiOyngCDslYrslYTsmpQuIC8g6riw6riw7J2YIOyXsOqysCDsg4Htg5zrpbwg7ZmV7J247ZW0IOyjvOyEuOyalC4KCiMjIyDsmIHsg4HsnYQg67aI65+s7Jik64qUIOykkeyeheuLiOuLpC4g7J6g7Iuc66eMIOq4sOuLpOugpCDso7zsi63si5zsmKQuCi0g7JiB7IOB7J2EIOu2iOufrOyYpOqzoCDsnojslrTsmpQuIC8g7J6g7Iuc66eMIOq4sOuLpOugpCDso7zshLjsmpQuCgojIyMg6raM7ZWcIOyLoOyyreydhCDst6jshoztlZjsi5zqsqDsirXri4jquYw/IOy3qOyGjO2VmOyLpCDqsr3smrAg7Iug7LKt7ZWY7IugIOuCtOyaqeydgCDsoIDsnqXrkJjsp4Ag7JWK7Iq164uI64ukLgotIOy3qOyGjO2VmOuptCDsi6Dssq3tlZwg64K07Jqp7J20IOyggOyepeuQmOyngCDslYrslYTsmpQuIC8g6raM7ZWcIOyLoOyyreydhCDst6jshoztlaDquYzsmpQ/Ci0g6raM7ZWcIOyLoOyyreydhCDst6jshoztlaDquYzsmpQ/IC8g7Leo7IaM7ZWY66m0IOyeheugpe2VnCDrgrTsmqnsnbQg7IKs65287KC47JqULgoKIyMjIyDqsIDsnbTrk5wg7JiI7IucICh1eC13cml0aW5nLm1k7JeQ7IScIOyYruq5gCDigJQg6rec7LmZ7Jy866GcIOyekOuPme2ZlCDrqrsg7ZWY64qUIOusuOyepSDsnqzqtazshLEg7IKs66GAKQoKIyMjIOyekOuPmeywqOulvCDqsIDsp4Dqs6Ag6rOE7Iuc64KY7JqUPwotIOyekOuPmeywqOqwgCDsnojrgpjsmpQ/CgojIyMg66ek64usIOuztO2XmOujjOulvCDslrzrp4jslKkg64K06rOgIOqzhOyLnOuCmOyalD8KLSDrp6Tri6wg67O07ZeY66OM64qUIOyWvOuniOyduOqwgOyalD8KCiMjIyDslYjsoITtlZwg6rCc7Ya17J2EIOychO2VtCDrqocg6rCA7KeAIOuLpOyLnCDsl6zsraTrs7zqsozsmpQuCi0g7JWI7KCE7ZWcIOqwnO2GteydhCDsnITtlbQg66qHIOqwgOyngCDri6Tsi5wg7ZmV7J247ZWg6rKM7JqULgoKIyMjIOy5tOuTnOulvCDtlbTsp4DtlZjsi5zqsqDslrTsmpQ/Ci0g7Lm065Oc66W8IO2VtOyngO2VoOq5jOyalD8KCiMjIyDsi5zsnpHtlZjsi5zripQg67aE7JeQ6rKMIDUsMDAw7JuQ7J2EIOuTnOugpOyalC4KLSDsi5zsnpHtlZjrqbQgNSwwMDDsm5DsnYQg65Oc66Ck7JqULgoKIyMjIOydtOyekCDtmZjrtojsnYQg67Cb7JWY7Ja07JqULgotIOydtOyekOulvCDrj4zroKTrsJvslZjslrTsmpQuCgojIyMg7Jik64qY7J2YIO2AtOymiOqwgCDqs6cg7KKF66OM64+87JqULgotIOyYpOuKmOydmCDtgLTspojqsIAg6rOnIOuBneuCmOyalC4KCiMjIyDquIjsnbzquYzsp4Ag66+464KpIOyLnCDsl7DssrQg7LKY66as65Cp64uI64ukLiDtm4TrtojqsrDsoJwg6riI7JWh7J2EIOuCqeu2gO2VmOyLnOq4sCDrsJTrno3ri4jri6QuCi0g7Jik64qY6rmM7KeAIOuCtOyngCDslYrsnLzrqbQg7Jew7LK064+87JqULiAvIO2bhOu2iOqysOygnCDquIjslaHsnYQg64K07KO87IS47JqULgoKIyMjIOygkOqygCDquLDqsITsl5DripQg7ISc67mE7IqkIOydtOyaqeydtCDrtojqsIDtlanri4jri6QuCi0g7KCQ6rKAIOq4sOqwhCDrj5nslYgg7ISc67mE7Iqk66W8IOydtOyaqe2VoCDsiJgg7JeG7Ja07JqULgoKIyMjIOyLoOu2hOymnSDtmZXsnbgg7KCE7JeQ64qUIOyGoeq4iCDrsI8g6rKw7KCc6rCAIOu2iOqwgO2VqeuLiOuLpC4KLSDsi6DrtoTspp0g7ZmV7J2465CY6riwIOyghOq5jOyngCDshqHquIjqs7wg6rKw7KCc66W8IO2VoCDsiJgg7JeG7Ja07JqULgoKIyMjIOuzgOqyvSDsi5wg7LqQ7Iuc67CxIOyerOyngOq4ieydgCDrtojqsIDtlanri4jri6QuCi0g7ZWcIOuyiCDrsJTqvrjrqbQg7LqQ7Iuc67Cx7J2AIOuLpOyLnCDrsJvsnYQg7IiYIOyXhuyWtOyalC4KCiMjIyDsg4Hri7Qg7ZKI7KeIIO2WpeyDgeydhCDsnITtlbQg7Ya17ZmUIOuCtOyaqeydtCDrhbnsnYzrkKnri4jri6QuCi0g642UIOyii+ydgCDsg4Hri7TsnYQg7JyE7ZW0IO2Gte2ZlCDrgrTsmqnsnYAg64W57J2M64+87JqULgoKIyMjIOqzoOqwneuLmOydmCDqsJzsnbjsoJXrs7Qg7J207JqpIOuCtOyXreydgCDquLDroZ0g6rSA66as65Cp64uI64ukLgotIOydtOygnOu2gO2EsCDqsJzsnbjsoJXrs7Qg7J207JqpIOuCtOyXreydtCDquLDroZ3rj7zsmpQuCgojIyMg7LKt7IaM64WE7J2AIOyEnOu5hOyKpCDqsIDsnoXsnbQg67aI6rCA7ZWp64uI64ukLgotIOyngOq4iOydgCDqsIDsnoXtlaAg7IiYIOyXhuyWtOyalC4gLyDssq3shozrhYTsnYQg7JyE7ZWcIOyEnOu5hOyKpOuKlCDslYTsp4Eg7KSA67mEIOykkeydtOyXkOyalC4KCiMjIyMg6rOE7KCVwrfsnoXroKUKCiMjIyDslYTsnbTrlJQg65iQ64qUIOu5hOuwgOuyiO2YuOulvCA17ZqMIOydtOyDgSDsnpjrqrsg7J6F66Cl7ZWY7JesIOqzhOygleydtCDsnqDquIgg7LKY66as65CY7JeI7Iq164uI64ukLgotIOu5hOuwgOuyiO2YuOulvCA17ZqMIOyemOuquyDsnoXroKXtlbTshJwg6rOE7KCV7J20IOyeoOqyvOyWtOyalC4gLyDruYTrsIDrsojtmLjrpbwg7J6s7ISk7KCV7ZWY66m0IOuLpOyLnCDsnbTsmqntlaAg7IiYIOyeiOyWtOyalC4KCiMjIyDsnbTrr7gg7IKs7JqpIOykkeyduCDslYTsnbTrlJTsnoXri4jri6QuCi0g7J2066+4IOyTsOqzoCDsnojripQg7JWE7J2065SU7JiI7JqULiAvIOuLpOuluCDslYTsnbTrlJTrpbwg7J6F66Cl7ZW0IOyjvOyEuOyalC4KCiMjIyDsgqzsmqntlaAg7IiYIOyXhuuKlCDruYTrsIDrsojtmLjsnoXri4jri6QuIOyYgeusuCwg7Iir7J6QLCDtirnsiJjrrLjsnpDrpbwg7Y+s7ZWo7ZWY7JesIDjsnpAg7J207IOBIOyeheugpe2VmOyLreyLnOyYpC4KLSDsmIHrrLgsIOyIq+yekCwg7Yq57IiY66y47J6Q66W8IO2PrO2VqO2VtCA47J6QIOydtOyDgSDsnoXroKXtlbQg7KO87IS47JqULgoKIyMjIOyeheugpSDqsIDriqXtlZwg6riA7J6QIOyImOulvCDstIjqs7ztlZjsmIDsirXri4jri6QuCi0g7J6F66Cl7ZWgIOyImCDsnojripQg6riA7J6QIOyImOulvCDrhJjsl4jslrTsmpQuIC8g64K07Jqp7J2EIOyhsOq4iCDspITsl6wg7KO87IS47JqULgoKIyMjIyDtjIzsnbzCt+qysOygnMK36riw7YOACgojIyMg7YyM7J28IOyaqeufieydtCDstIjqs7zrkJjsl4jsirXri4jri6QuIDEwTUIg7J207ZWY7J2YIO2MjOydvOunjCDsl4XroZzrk5wg6rCA64ql7ZWp64uI64ukLgotIDEwTUIg7J207ZWYIO2MjOydvOunjCDsmKzrprQg7IiYIOyeiOyWtOyalC4gLyDtjIzsnbwg7Jqp65+J7J2EIO2ZleyduO2VtCDso7zshLjsmpQuCgojIyMg64uk7Jq066Gc65Oc6rCAIOyZhOujjOuQmOyXiOyKteuLiOuLpC4KLSDri6TsmrTroZzrk5zrpbwg66eI7LOk7Ja07JqULgoKIyMjIOqysOygnOyXkCDsi6TtjKjtlZjsmIDsirXri4jri6QuIOuLpOyLnCDsi5zrj4TtlbQg7KO87Iuc6riwIOuwlOuejeuLiOuLpC4KLSDqsrDsoJztlZjsp4Ag66q77ZaI7Ja07JqULiAvIOqysOygnCDsiJjri6jsnYQg7ZmV7J247ZWY6rOgIOuLpOyLnCDsi5zrj4TtlbQg7KO87IS47JqULgoKIyMjIOyggOyepSDqs7XqsITsnbQg67aA7KGx7ZWY7JesIOyEpOy5mO2VoCDsiJgg7JeG7Iq164uI64ukLgotIOyggOyepSDqs7XqsITsnbQg67aA7KGx7ZW07IScIOyEpOy5mO2VoCDsiJgg7JeG7Ja07JqULiAvIOqzteqwhOydhCDtmZXrs7TtlZwg65KkIOuLpOyLnCDsi5zrj4TtlbQg7KO87IS47JqULgoKIyMjIOyEnOu5hOyKpCDspIDruYQg7KSR7J6F64uI64ukLgotIOykgOu5hO2VmOqzoCDsnojripQg6riw64ql7J207JeQ7JqULiAvIOyhsOq4iOunjCDquLDri6TroKQg7KO87IS47JqULgoKIyMjIOuTseuhnSDqsIDriqXtlZwg7LWc64yAIOqwnOyImOulvCDstIjqs7ztlZjsmIDsirXri4jri6QuCi0g642UIOuTseuhne2VmOugpOuptCDquLDsobQg7ZWt66qp7J2EIOyCreygnO2VtCDso7zshLjsmpQuCgojIyMjIOuztOyViCDshJzruYTsiqQgKOy2lOqwgCkKCiMjIyDstpzrj5kg7JqU7LKt7J20IOygkeyImOuQmOyXiOyKteuLiOuLpC4g7J6g7Iuc66eMIOq4sOuLpOugpCDso7zsi63si5zsmKQuCi0g7Lac64+ZIOyalOyyreydhCDsoJHsiJjtlojslrTsmpQuIC8g7J6g7Iuc66eMIOq4sOuLpOugpCDso7zshLjsmpQuCgojIyMg6rK967mEIOyDge2DnOulvCDtmZXsnbjtlaAg7IiYIOyXhuyKteuLiOuLpC4g7J6g7IucIO2bhCDri6Tsi5wg7Iuc64+E7ZWY7Iut7Iuc7JikLgotIOqyveu5hCDsg4Htg5zrpbwg7ZmV7J247ZWgIOyImCDsl4bslrTsmpQuIC8g7J6g7IucIO2bhCDri6Tsi5wg7Iuc64+E7ZW0IOyjvOyEuOyalC4KCiMjIyDsmbjstpwg66qo65Oc66GcIOyghO2ZmO2VmOyLnOqyoOyKteuLiOq5jD8KLSDsmbjstpwg66qo65Oc66GcIOuwlOq/gOq5jOyalD8KCiMjIyDrsKnrrLgg7JiI7JW97J20IOyZhOujjOuQmOyXiOyKteuLiOuLpC4KLSDrsKnrrLgg7JiI7JW97J2EIOuniOyzpOyWtOyalC4KCiMjIyDruYTrsIDrsojtmLggNe2ajCDsmKTrpZjroZwg6rOE7KCV7J20IOyeoOq4iCDsspjrpqzrkJjsl4jsirXri4jri6QuCi0g67mE67CA67KI7Zi466W8IDXtmowg7J6Y66q7IOyeheugpe2VtOyEnCDqs4TsoJXsnbQg7J6g6rK87Ja07JqULiAvIOu5hOuwgOuyiO2YuOulvCDsnqzshKTsoJXtlZjrqbQg64uk7IucIOydtOyaqe2VoCDsiJgg7J6I7Ja07JqULgoKIyMjIyDquI3soJXsoIEg66eQ7ZWY6riwICjsl4bslrTsmpQg4oaSIH7tlZjrqbQg7ZWgIOyImCDsnojslrTsmpQpCgojIyMg67O47J24IOyduOymneydhCDtlZjsp4Ag7JWK7Jy866m0IOyEnOu5hOyKpOulvCDsnbTsmqntlaAg7IiYIOyXhuyKteuLiOuLpC4KLSDrs7jsnbgg7J247Kad7J2EIO2VmOuptCDrqqjrk6Ag7ISc67mE7Iqk66W8IOydtOyaqe2VoCDsiJgg7J6I7Ja07JqULgoKIyMjIOydtOuplOydvCDsnbjspp0g7KCE7JeQ64qUIOuhnOq3uOyduO2VoCDsiJgg7JeG7Iq164uI64ukLgotIOydtOuplOydvCDsnbjspp3snYQg66eI7LmY66m0IOuhnOq3uOyduO2VoCDsiJgg7J6I7Ja07JqULgoKIyMjIOy/oO2PsOydgCDroZzqt7jsnbgg7ZuE7JeQ66eMIOyCrOyaqSDqsIDriqXtlanri4jri6QuCi0g66Gc6re47J247ZWY66m0IOy/oO2PsOydhCDsk7gg7IiYIOyeiOyWtOyalC4KCiMjIyDrr7jshLHrhYTsnpDripQg67O07Zi47J6QIOuPmeydmCDsl4bsnbQg6rKw7KCc7ZWgIOyImCDsl4bsirXri4jri6QuCi0g67O07Zi47J6Q6rCAIOuPmeydmO2VmOuptCDqsrDsoJztlaAg7IiYIOyeiOyWtOyalC4KCiMjIyDtlITroZztlYTsnYQg65Ox66Gd7ZWY7KeAIOyViuycvOuptCDsnbTsmqnsnbQg7KCc7ZWc65Cp64uI64ukLgotIO2UhOuhnO2VhOydhCDrk7HroZ3tlZjrqbQg66qo65OgIOq4sOuKpeydhCDsk7gg7IiYIOyeiOyWtOyalC4KCiMjIyDslbEg67KE7KCE7J20IOuCruyVhCDsnbzrtoAg6riw64ql7J20IOygnO2VnOuQqeuLiOuLpC4KLSDslbHsnYQg7JeF642w7J207Yq47ZWY66m0IOuqqOuToCDquLDriqXsnYQg7JO4IOyImCDsnojslrTsmpQuCgojIyMg67iU66Oo7Yis7Iqk6rCAIOq6vOyguCDsnojslrQg6riw6riw66W8IOyXsOqysO2VoCDsiJgg7JeG7Iq164uI64ukLgotIOu4lOujqO2IrOyKpOulvCDsvJzrqbQg6riw6riw66W8IOyXsOqysO2VoCDsiJgg7J6I7Ja07JqULgoKIyMjIOu5hOyDgSDsl7Drnb3sspjqsIAg65Ox66Gd65CY7KeAIOyViuyVmOyKteuLiOuLpC4KLSDruYTsg4Eg7Jew65297LKY66W8IOuTseuhne2VmOuptCDquLTquIntlaAg65WMIOu5oOultOqyjCDsl7Drnb3rk5zrprQg7IiYIOyeiOyWtOyalC4KCiMjIyDstpzsnoUg7Lm065Oc6rCAIOuTseuhneuQmOyngCDslYrslYQg7IKs7Jqp7ZWgIOyImCDsl4bsirXri4jri6QuCi0g7Lac7J6FIOy5tOuTnOulvCDrk7HroZ3tlZjrqbQg67CU66GcIOyTuCDsiJgg7J6I7Ja07JqULgoKIyMjIyDriqXrj5nsoIEg66eQ7ZWY6riwICjsmYTro4wg7JWI64K0KQoKIyMjIO2ajOybkOqwgOyeheydtCDsmYTro4zrkJjsl4jsirXri4jri6QuCi0g6rCA7J6F7J2EIOuniOyzpOyWtOyalC4KCiMjIyDsmIjslb3snbQg7Leo7IaM65CY7JeI7Iq164uI64ukLgotIOyYiOyVveydhCDst6jshoztlojslrTsmpQuCgojIyMg66y47J2Y6rCAIOygkeyImOuQmOyXiOyKteuLiOuLpC4g7Iic7LCo7KCB7Jy866GcIOuLteuzgOuTnOumrOqyoOyKteuLiOuLpC4KLSDrrLjsnZjrpbwg7KCR7IiY7ZaI7Ja07JqULiAvIOyInOyEnOuMgOuhnCDri7Xrs4Drk5zrprTqsozsmpQuCgojIyMg7ISk7KCV7J20IOy0iOq4sO2ZlOuQmOyXiOyKteuLiOuLpC4KLSDshKTsoJXsnYQg7LSI6riw7ZmU7ZaI7Ja07JqULgoKIyMjIOu5hOuwgOuyiO2YuOqwgCDrs4Dqsr3rkJjsl4jsirXri4jri6QuCi0g67mE67CA67KI7Zi466W8IOuwlOq/qOyWtOyalC4KCiMjIyDsnbjspp3snbQg7JmE66OM65CY7JeI7Iq164uI64ukLgotIOyduOymneydhCDrp4jss6TslrTsmpQuCgojIyMjIOy6kOyjvOyWvO2VnCDqsr3slrQgKOyniOusuCDsnqzqtazshLEpCgojIyMg7Ja47KCcIOuwqeusuO2VmOyLnOqyoOyKteuLiOq5jD8KLSDrsKnrrLgg64Kg7Kec66W8IOyEoO2Dne2VtCDso7zshLjsmpQuCgojIyMg7Ja065akIOuwqeuyleycvOuhnCDsnbjspp3tlZjsi5zqsqDsirXri4jquYw/Ci0g7J247KadIOuwqeuyleydhCDshKDtg53tlbQg7KO87IS47JqULgoKIyMjIOqysOygnO2VmOyLpCDsubTrk5zrpbwg7ISg7YOd7ZW0IOyjvOyLreyLnOyYpC4KLSDqsrDsoJztlaAg7Lm065Oc66W8IOyEoO2Dne2VtCDso7zshLjsmpQuCgojIyMg7JuQ7ZWY7Iuc64qUIOyEnOu5hOyKpOulvCDshKDtg53tlZjshLjsmpQuCi0g7JuQ7ZWY64qUIOyEnOu5hOyKpOulvCDshKDtg53tlbQg7KO87IS47JqULgoKIyMjIOyjvOyGjOulvCDslYzqs6Ag6rOE7Iug6rCA7JqUPwotIOyjvOyGjOulvCDslYzqs6Ag7J6I64KY7JqUPwoKIyMjIyDrqoXsgqwr66qF7IKsIO2SgOyWtOyTsOq4sAoKIyMjIOq4sOqwhCDrp4zro4zroZwg7J207Jqp7J20IOykkeyngOuQmOyXiOyKteuLiOuLpC4KLSDsnbTsmqkg6riw6rCE7J20IOuBneuCmOyEnCDsp4DquIjsnYAg7JO4IOyImCDsl4bslrTsmpQuCgojIyMg7Jqp65+JIOu2gOyhseycvOuhnCDsoIDsnqXsl5Ag7Iuk7Yyo7ZaI7Iq164uI64ukLgotIOyggOyepSDqs7XqsITsnbQg67aA7KGx7ZW07IScIOyggOyepe2VmOyngCDrqrvtlojslrTsmpQuCgojIyMg7Ya17IugIOyYpOulmOuhnCDsmpTssq3snbQg7Iuk7Yyo7ZWY7JiA7Iq164uI64ukLgotIO2GteyLoOydtCDsm5DtmZztlZjsp4Ag7JWK7JWEIOyalOyyreydhCDsspjrpqztlZjsp4Ag66q77ZaI7Ja07JqULiAvIOyeoOyLnCDtm4Qg64uk7IucIOyLnOuPhO2VtCDso7zshLjsmpQuCgojIyMg6raM7ZWcIOu2gOyhseycvOuhnCDsoJHqt7zsnbQg6rGw67aA65CY7JeI7Iq164uI64ukLgotIOygkeq3vCDqtoztlZzsnbQg7JeG7Ja07JqULiAvIOq0gOumrOyekOyXkOqyjCDqtoztlZzsnYQg7JqU7LKt7ZW0IOyjvOyEuOyalC4KCiMjIyMg7IOB7ZmpIOyViOuCtCAoMuuLqCDqtazsobApCgojIyMg7J6F66Cl7ZWY7IugIOyjvOyGjOulvCDssL7snYQg7IiYIOyXhuyKteuLiOuLpC4g64uk7IucIO2ZleyduCDrsJTrno3ri4jri6QuCi0g7KO87IaM66W8IOywvuydhCDsiJgg7JeG7Ja07JqULiAvIOuLpOyLnCDtmZXsnbjtlbQg7KO87IS47JqULgoKIyMjIOyalOyyre2VmOyLoCDtjpjsnbTsp4Drpbwg7LC+7J2EIOyImCDsl4bsirXri4jri6QuCi0g7Y6Y7J207KeA66W8IOywvuydhCDsiJgg7JeG7Ja07JqULiAvIOyjvOyGjOulvCDtmZXsnbjtlZjqsbDrgpgg7ZmI7Jy866GcIOydtOuPme2VtCDso7zshLjsmpQuCgojIyMg64+Z7J287ZWcIOyalOyyreydtCDsspjrpqwg7KSR7J6F64uI64ukLiDsnqDsi5wg7ZuEIO2ZleyduO2VtCDso7zsi63si5zsmKQuCi0g6rCZ7J2AIOyalOyyreydhCDsspjrpqztlZjqs6Ag7J6I7Ja07JqULiAvIOyeoOyLnCDtm4Qg7ZmV7J247ZW0IOyjvOyEuOyalC4KCiMjIyDsnbTrsqTtirjqsIAg7KKF66OM65CY7JeI7Iq164uI64ukLgotIOydtOuypO2KuOqwgCDrgZ3rgqzslrTsmpQuCgojIyMg7YOI7Ye0IOyLnCDrqqjrk6Ag642w7J207YSw6rCAIOyCreygnOuQmOupsCDrs7XqtaztlaAg7IiYIOyXhuyKteuLiOuLpC4KLSDtg4jth7TtlZjrqbQg66qo65OgIOuNsOydtO2EsOqwgCDsgq3soJzrkJjqs6Ag64uk7IucIOuQmOuPjOumtCDsiJgg7JeG7Ja07JqULiAvIOygleunkCDtg4jth7TtlaDquYzsmpQ/CgojIyMjIOuztOyViCDshJzruYTsiqQgKOyDge2ZqSDslYjrgrQpCgojIyMg67aA7J6sIOykkSDrsKnrrLjsnpDqsIAg6rCQ7KeA65CY7JeI7Iq164uI64ukLgotIOu2gOyerCDspJHsl5Ag67Cp66y47J6Q6rCAIOyeiOyXiOyWtOyalC4gLyDsmIHsg4HsnYQg7ZmV7J247ZW0IOuztOyEuOyalC4KCiMjIyDqsr3ruYQg7ZW07KCcIOq2jO2VnOydtCDsl4bsirXri4jri6QuCi0g6rK967mEIO2VtOygnCDqtoztlZzsnbQg7ZWE7JqU7ZW07JqULiAvIOq0gOumrOyekOyXkOqyjCDsmpTssq3tlbQg7KO87IS47JqULgoKIyMjIO2ZlOyerCDqsJDsp4DquLAg67Cw7YSw66as6rCAIOu2gOyhse2VqeuLiOuLpC4KLSDtmZTsnqwg6rCQ7KeA6riwIOuwsO2EsOumrOqwgCDslrzrp4gg7JeG7Ja07JqULiAvIOuwsO2EsOumrOulvCDqtZDssrTtlbQg7KO87IS47JqULgoKIyMjIyDstpXslb0gKyDquI3soJUg7KCE7ZmYICjrkZAg66y47J6lIOKGkiDquI3soJXtmJUg7ZWcIOusuOyepSkKCiMjIyDrqqjsnoTsp4Dsm5DquIgg7JeG7J20IOuqqOyehO2GteyepeydhCDrp4zrk6TquYzsmpQ/IOyngOq4iCDrsJvsp4Ag7JWK7Jy866m0IOuqqOyehOyngOybkOq4iOydhCDrsJvsnYQg7IiYIOyXhuyWtOyalC4KLSDslb3qtIDsl5Ag64+Z7J2Y7ZWY66m0IOuqqOyehOyngOybkOq4iOydhCDrsJvsnYQg7IiYIOyeiOyWtOyalC4KCiMjIyDtmJztg50g7JeG7J20IOqwgOyehe2VoOq5jOyalD8g7KeA6riIIOyLoOyyre2VmOyngCDslYrsnLzrqbQg7Juw7Lu0IO2YnO2DneydhCDrsJvsnYQg7IiYIOyXhuyWtOyalC4KLSDsp4DquIgg7Iug7LKt7ZWY66m0IOybsOy7tCDtmJztg53snYQg67Cb7J2EIOyImCDsnojslrTsmpQuCgojIyMg7L+g7Y+wIOyXhuydtCDqsrDsoJztlaDquYzsmpQ/IOyngOq4iCDrsJvsp4Ag7JWK7Jy866m0IO2VoOyduCDsv6Dtj7DsnYQg67Cb7J2EIOyImCDsl4bslrTsmpQuCi0g7L+g7Y+w7J2EIOuwm+ycvOuptCDrjZQg7KCA66C07ZWY6rKMIOqysOygnO2VoCDsiJgg7J6I7Ja07JqULgoKIyMjIOyVjOumvCDsl4bsnbQg7Iuc7J6R7ZWg6rmM7JqUPyDslYzrprzsnYQg7Lyc7KeAIOyViuycvOuptCDspJHsmpTtlZwg7IaM7Iud7J2EIOuwm+ydhCDsiJgg7JeG7Ja07JqULgotIOyVjOumvOydhCDsvJzrqbQg7KSR7JqU7ZWcIOyGjOyLneydhCDrsJTroZwg67Cb7J2EIOyImCDsnojslrTsmpQuCgojIyMg7J6Q64+Z7J207LK066W8IOuTseuhne2VmOyngCDslYrqs6Ag64SY7Ja06rCI6rmM7JqUPyDrk7HroZ3tlZjsp4Ag7JWK7Jy866m0IO2VoOyduOydhCDrsJvsnYQg7IiYIOyXhuyWtOyalC4KLSDsnpDrj5nsnbTssrTrpbwg65Ox66Gd7ZWY66m0IO2VoOyduOydhCDrsJvsnYQg7IiYIOyeiOyWtOyalC4KCiMjIyDrs7gg6rOE7JW97J2YIOycoOydvO2VnCDrp4jsiqTthLAg6rSA66as7J6Q66GcIOydvOuwmOq0gOumrOyekOuhnCDqtoztlZzrs4Dqsr3snYQg7ZWY7IukIOyImCDsl4bslrTsmpQuIOydvOuwmCDqtIDrpqzsnpDroZwg6raM7ZWcIOuzgOqyveydhCDsm5DtlZjsi6Qg6rK97JqwIOuLpOuluCDsgqzrnozsl5Dqsowg66eI7Iqk7YSwIOq0gOumrOyekCDqtoztlZzsnYQg7KeA7KCV7ZW0IOyjvOyLoCDtm4Qg64uk7IucIOyLnOuPhO2VtCDso7zshLjsmpQuCi0g64uk66W4IOyCrOuejOydhCDrp4jsiqTthLAg6rSA66as7J6Q66GcIOyngOygle2VnCDrkqQg7J2867CYIOq0gOumrOyekOuhnCDrs4Dqsr3tlaAg7IiYIOyeiOyWtOyalC4KLSDri6Trpbgg7IKs656M7J2EIOuniOyKpO2EsCDqtIDrpqzsnpDroZwg7KeA7KCV7ZWY66m0IOuzgOqyve2VoCDsiJgg7J6I7Ja07JqULgpQSwMEFAAACAAAAAAAAAwWGql7OAAAezgAAA0AAAB1eC13cml0aW5nLm1kIyBVWCBXcml0aW5nIOqwgOydtOuTnA0KDQojIyAxLiDtlbTsmpTssrQNCg0K7KCc7ZKIIOyViOydmCDrqqjrk6Ag66y46rWs64qUICftlbTsmpTssrQn66GcIOyNqOyalC4NCuydvOq0gOyEsSDsnojripQg7IKs7Jqp7J6QIOqyve2XmOydhCDrp4zrk6Qg7IiYIOyeiOuPhOuhnSAqKuyDge2ZqSwg66el65297J2EIOu2iOusuO2VmOqzoCDrqqjrk6Ag66y46rWs7JeQIO2VtOyalOyytOulvCDsoIHsmqntlbTso7zshLjsmpQuKioNCg0K7JiIKQ0KLSDrs7Trg4Xri4jri6Qg4oaSIOuztOuCvOqyjOyalA0KDQoqKioNCg0KIyMgMi4g64ql64+Z7KCBIOunkO2VmOq4sA0KDQrsoJztkogg7JWI7JeQ7IScIOy1nOuMgO2VnCAqKuuKpeuPme2YlSDrrLjsnqUqKuydhCDsjajso7zshLjsmpQuIOyImOuPme2YlSDrrLjsnqXsnYAgW+yYiOyZuCDqt5zsuZldKCPsmIjsmbgtMS3siJjrj5ntmJUt66y47J6l7J2ELeyNqOuPhC3rkJjripQt6rK97JqwKeyXkCDtlbTri7ntlaAg65WM66eMIOyTsOuKlCDqsowg7KKL7JWE7JqULg0KDQojIyMg65CQ7Ja07JqUIOKGkiDtlojslrTsmpQNCg0K7JiIKQ0KLSDshKTsoJXrkJDslrTsmpQg4oaSIOyEpOygle2WiOyWtOyalA0KDQojIyMgJ37sl4gnIOu5vOq4sA0KDQrsmIgpDQotIOuwlOuAjOyXiOyWtOyalCDihpIg67CU6r+o7Ja07JqUDQoNCiMjIyDrj5nsgqwg67CU6r+U7JOw6riwDQoNCuyYiCkNCi0g64aS7JWE7KGM7Ja07JqUIOKGkiDsmKzrnpDslrTsmpQNCg0KKioqDQoNCiMjIDMuIOq4jeygleyggSDrp5DtlZjquLANCg0K7KCc7ZKIIOyViOyXkOyEnCDrtoDsoJXsoIEg7Luk666k64uI7LyA7J207IWY7J2EIOy1nOuMgO2VnCDspITsnbTqs6Ag6riN7KCV7ZiVIOusuOyepeydhCDsjajso7zshLjsmpQuDQrrtoDsoJXtmJUg66y47J6l7J2AIFvsmIjsmbgg6rec7LmZXSgj7JiI7Jm4LTMt67aA7KCV7ZiVLeusuOyepeydhC3sjajrj4Qt65CY64qULeqyveyasCnsl5Ag7ZW064u57ZWgIOuVjOunjCDsjajsmpQuDQoNCuyYiCA6IOyViCDrj7zsmpQsIOyXhuyWtOyalCAoWCkg4oaSIH7tlZjrqbQg7ZWgIOyImCDsnojslrTsmpQgKE8pDQoNCiMjIyDsl4bslrTsmpQg4oaSIOyeiOyWtOyalA0KDQrsmIgpDQotIOuztO2YuOyekOqwgCDtl4jrnb3tlZjquLAg7KCE7JeQ64qUIOqwgOyehe2VoCDsiJgg7JeG7Ja07JqUIOKGkiDrs7TtmLjsnpDqsIAg7ZeI65297ZW07JW8IOqwgOyehe2VoCDsiJgg7J6I7Ja07JqUDQoNCiMjIyDsl5Drn6wg66mU7Iuc7KeADQoNCuyXkOufrCDsg4Htmansl5DshJzrj4QgIu2VtOqysCDrsKnrspUi7J2EIOuovOyggCDslYzroKTso7zripQg6riN7KCV7ZiVIOq1rOyhsOuhnCDsjajsmpQuDQoNCuyYiCkNCi0g7KeA6riIIOuyhOyghOyXkOyEnOuKlCDsk7gg7IiYIOyXhuyWtOyalC4g7IOd7LK0IOyduOymneydhCDsk7DroKTrqbQg7JWx7J2EIOy1nOyLoCDrsoTsoITsnLzroZwg7JeF642w7J207Yq4IO2VtOyjvOyEuOyalC4g4oaSIOyVseydhCDsl4XrjbDsnbTtirjtlbTso7zshLjsmpQuIOyDneyytCDsnbjspp3snYQg7JOw66Ck66m0IOy1nOyLoCDrsoTsoITsnbQg7ZWE7JqU7ZW07JqULg0KDQo6OjogdGlwIO2MneyXhSDrsoTtirzsnYAgWzguIO2MneyXhV0g6rec7LmZ7J2EIOuUsOudvOyalA0K7Yyd7JeFKOuLpOydtOyWvOuhnOq3uCkg67KE7Yq8IOusuOq1rOuKlCDslYTrnpggKio4LiDtjJ3sl4UqKiDshLnshZgg6rec7LmZ7J2EIOuUsOudvOyalCDigJQg7Ya167O064qUIFvtmZXsnbhdLCDsmIgv7JWE64uI7JikIO2MkOuLqOydgCBb7JWE64uI7JikXcK3W+uEpF0sIOuPmeyekSDsnKDrj4TripQgW+y3qOyGjF3Ct1vrj5nsnpFdLiAi7Leo7IaMIuuKlCDrj5nsnpEg67KE7Yq86rO8IOynneydvCDrlYzrp4wg7JOw6rOgLCAi64ur6riwIMK3IOuPmeyekSLsspjrn7wg7Ked7J20IOyViCDrp57ripQg7KGw7ZWp7J2AIOyTsOyngCDslYrslYTsmpQuDQo6OjoNCg0KIyMjIO2YnO2DneydhCDrsJvsnYQg7IiYIOyXhuydhCDrlYwNCg0K7JiIKQ0KLSDrqqjsnoTsp4Dsm5DquIgg7JeG7J20IOuqqOyehO2GteyepeydhCDrp4zrk6TquYzsmpQ/IOyngOq4iCDrsJvsp4Ag7JWK7Jy866m0IOuqqOyehOyngOybkOq4iOydhCDrsJvsnYQg7IiYIOyXhuyWtOyalC4g4oaSIOyVveq0gOyXkCDrj5nsnZjtlZjrqbQg66qo7J6E7KeA7JuQ6riI7J2EIOuwm+ydhCDsiJgg7J6I7Ja07JqULg0KDQojIyMg7Zic7YOdIOuMgOyDgSDslYjrgrQNCg0KKirshJzruYTsiqTripQg7JO4IOyImCDsnojsp4Drp4wsIO2KueyglSDtmJztg53snYAg67Cb7J2EIOyImCDsl4bsnYQg65WMIOKGkiDquI3soJXtmJUg66y47J6l7Jy866GcIOyNqOyalC4qKg0K7IKs7Jqp7J6Q64qUIOusuOq1rOulvCDqvLzqvLztnogg7J297KeAIOyViuqzoCDtm5HslrTrs7TquLAo7Iqk7LqUKSDrlYzrrLjsl5AsIOu2gOygle2YleycvOuhnCDsk7DrqbQg7KCc7ZKIIOyghOyytOulvCDsk7gg7IiYIOyXhuuLpOqzoCDsmKTtlbTtlZjquLAg7Ims7JuM7JqULg0KDQrsmIgpDQotIOqzhOyijCDqsJzshKQg7Zic7YOd7J2AIOuwm+ydhCDsiJgg7JeG7Ja07JqULiDihpIgNC41JSDquIjrpqwg7Zic7YOd66eMIOuwm+ydhCDsiJgg7J6I7Ja07JqULg0KDQoqKioNCg0KIyMgNC4g7LqQ7KO87Ja87ZWcIOqyveyWtA0KDQrsoJztkogg7JWI7JeQ7IScICd+7Iuc6rKg7Ja07JqUPycsICfsi5zrgpjsmpQ/JywgJ37qu5gnIOqwmeydgCDqs7zrj4TtlZwg6rK97Ja066W8IOyTsOyngCDslYrslYTsmpQuDQrstZzrjIDtlZwg7LqQ7KO87Ja87ZWY6rOgIOy5nOq3vO2VnCDrp5DtiKzrpbwg7JOw64qUIOqyjCDsoovslYTsmpQuDQrqsr3slrTripQgW+yYiOyZuCDqt5zsuZldKCPsmIjsmbgtMi3qsr3slrTrpbwt7I2o64+ELeuQmOuKlC3qsr3smrAp7JeQIO2VtOuLue2VoCDrlYzrp4wg7I2o7JqULg0KDQojIyMg64+Z7IKs7JeQ7IScICd+7IucJyDrubzquLANCg0K7JiIKQ0KLSDsubTrk5zrpbwg7ZW07KeA7ZWY7Iuc6rKg7Ja07JqUPyDihpIg7Lm065Oc66W8IO2VtOyngO2VoOq5jOyalD8NCi0g7Iuc7J6R7ZWY7Iuc64qUIOu2hOyXkOqyjCA1LDAwMOybkOydhCDrk5zroKTsmpQuIOKGkiDsi5zsnpHtlZjrqbQgNSwwMDDsm5DsnYQg65Oc66Ck7JqULg0KDQojIyMgJ+qzhOyLnOuLpCcg4oaSICfsnojri6QnDQoNCuyYiCkNCi0g7J6Q64+Z7LCo66W8IOqwgOyngOqzoCDqs4Tsi5zrgpjsmpQ/IOKGkiDsnpDrj5nssKjqsIAg7J6I64KY7JqUPw0KLSDrp6Tri6wg67O07ZeY66OMIOyWvOuniOyUqSDrgrTqs6Ag6rOE7Iuc64KY7JqUPyDihpIg66ek64usIOuztO2XmOujjOuKlCDslrzrp4jsnbjqsIDsmpQ/ICoo64uo7IicIOy5mO2ZmOydtCDslYTri4jrnbwg66y47J6l7J2EIOyDiOuhnCDsk7Qg7IKs66GA7JiI7JqUKSoNCg0KIyMjICfsl6zsrYjri6QnIOKGkiAn7ZmV7J247ZWY64ukLCDrrLvri6QnDQoNCuyYiCkNCi0g7JWI7KCE7ZWcIOqwnO2GteydhCDsnITtlbQg66qH6rCA7KeAIOuLpOyLnCDsl6zsraTrs7zqsozsmpQuIOKGkiDslYjsoITtlZwg6rCc7Ya17J2EIOychO2VtCDrqofqsIDsp4Ag64uk7IucIO2ZleyduO2VoOqyjOyalC4NCg0KIyMjICfqu5gnIOKGkiAn7JeQ6rKMJw0KDQrsmIgpDQotIO2Zjeq4uOuPmeuLmOq7mCDrgqDslYTqsIDqs6Ag7J6I7Ja07JqULiDihpIg7ZmN6ri464+Z64uY7JeQ6rKMIOuCoOyVhOqwgOqzoCDsnojslrTsmpQuDQoNCiMjIyDqsr3slrTrpbwg67qQ7J2EIOuVjCDslrTsg4ntlZwg6rK97JqwDQoNCuyCrOyaqeyekOydmCDsoJXrs7Trpbwg67Cb64qUIOyniOusuOyXkOyEnCDquLDqs4TsoIHsnLzroZwgJ37si5wn66W8IOu6kOydhCDrlYwg66y47J6l7J20IOyWtOyDie2VoCDsiJgg7J6I7Ja07JqULg0KKirtjIzslYXtlZjqs6Ag7Iu27J2AIOygleuztOulvCAn7KO87Ja0J+uhnCDsjajshJwg66y47J6l7J2EIOyDiOuhreqyjCDsjajrs7TshLjsmpQuKioNCg0K7JiIKQ0KLSDslrTrlqQg66qp7KCB7Jy866GcIOuMgOy2nOuwm+ycvOyLnOuCmOyalD8g4oaSIOuMgOy2nCDrqqnsoIHsnbQg66y07JeH7J246rCA7JqUPw0KLSDslrTrlqQg7J207Jyg66GcIOyLoOqzoO2VmOyLnOuCmOyalD8g4oaSIOyLoOqzoCDsnbTsnKDrpbwg7ISg7YOd7ZW0IOyjvOyEuOyalC4NCg0KKioqDQoNCiMjIDUuICd766qF7IKsfSArIHvrqoXsgqx9JyDsk7Dsp4Ag7JWK6riwDQoNCiMjIyDtlZzsnpDslrQg7ZKA7Ja07JOw6riwDQoNCu2VnOyekOyWtCDrqoXsgqzrpbwg7ZKA7Ja07IScIOuPmeyCrCDtmJXtg5zroZwg7JO4IOyImCDsnojslrTsmpQuDQoNCuyYiCkNCi0g7J207J6QIO2ZmOu2iOydhCDrsJvslZjslrTsmpQg4oaSIOydtOyekOulvCDrj4zroKTrsJvslZjslrTsmpQNCi0g64K07J28IOy5tOuTnOqwkuydtCDqsrDsoJzrkKAg7JiI7KCV7J207JeQ7JqUIOKGkiDrgrTsnbzsnYAg7Lm065Oc6rCSIOuCmOqwgOuKlCDrgqDsnbTsl5DsmpQNCg0KIyMjIO2VnOyekOyWtOulvCDtkoDslrTsk7DquLAg7Ja066Ck7Jq4IOqyveyasA0KDQone+uqheyCrH3qsIAge+uqheyCrH3tlbTshJwnIO2Yle2DnOuhnOunjCDtkoDslrTspJjrj4Qg642UIOy6kOyjvOyWvO2VmOqyjCDsk7gg7IiYIOyeiOyWtOyalC4NCg0K7JiIKQ0KLSDsnpTslaEg67aA7KGx7Jy866GcIOq1rOunpO2VmOyngCDrqrvtlojslrTsmpQg4oaSIOyelOyVoeydtCDrtoDsobHtlbTshJwg6rWs66ek7ZWY7KeAIOuqu+2WiOyWtOyalA0KDQoqKioNCg0KIyMgNi4g7ZGc6riwIO2GteydvA0KDQojIyMg65CY7Ja07JqUIChYKSDihpIg64+87JqUIChPKQ0KDQrrqqjrsJTsnbwg7ZmU66m07J2YIOyigeydgCDqs7XqsITsnYQg6rOg66Ck7ZW0ICfrkJjslrTsmpQn64qUIOuqqOuRkCAn64+87JqUJ+uhnCDthrXsnbztlbTshJwg7I2o7KO87IS47JqULg0KDQoqKioNCg0KIyMgNy4g64Kg7Kecwrfsi5zqsITCt+yIq+yekCDtkZzquLANCg0K64Kg7Kecwrfsi5zqsITCt+uyiO2YuOuKlCDslYTrnpgg7ZiV7Iud7Jy866GcIO2GteydvO2VtOyEnCDsjajsmpQuDQoNCiMjIyDrgqDsp5zCt+yLnOqwhMK36riw6rCEDQoNCnwg7ZWt66qpIHwg7ZiV7IudIHwg7JiI7IucIHwNCnwtLS0tLS18LS0tLS0tfC0tLS0tLXwNCnwg64Kg7KecIHwg6riw67O4IGBZWVlZLk1NLkREYCAvIOynp+qyjCBgTU0uRERgIHwgMjAyNS4wMS4wMSwgMjUuMDEuMDEgfA0KfCDsi5zqsIQgfCDquLDrs7ggYEhIOk1NOlNTYCAvIOynp+qyjCBgSEg6TU1gICjsmKTsoIQv7Jik7ZuEIOyViCDslIApIHwgMTQ6MzA6MTEsIDEzOjMwIHwNCnwg6riw6rCEIHwg6riw67O4IGBZWVlZLk1NLkREfllZWVkuTU0uRERgIC8g7Ken6rKMIGBZWVlZLk1NLkREfk1NLkREYCB8IDIwMjUuMDEuMDF+MjAyNS4wMS4zMSwgMjAyNS4wMS4wMX4wMS4zMSB8DQp8IOuCoOynnCArIOyLnOqwhCB8IGBZWVlZLk1NLkREIEhIOk1NYCB8IDIwMjUuMDEuMDEgMTQ6MzAgfA0KfCDsmpTsnbwgfCBgWVlZWS5NTS5ERCjsmpTsnbwpYCDigJQg7JuUL+2ZlC/siJgv66qpL+q4iC/thqAv7J28IHwgMjAyNS4wMS4wMSjsiJgpIHwNCg0KKirsi5zqsIQg7JiI7Jm4Kio6IOyCrOyaqeyekOqwgCDsp4HsoJEg6rOg66W064qUIOuwqeusuMK37JiI7JW9IOyLnOqwhOydgCBg7Jik7KCEL+yYpO2bhCBIOk1NYOydhCDsjajrj4Qg64+87JqULg0K7JiIKSDsmKTtm4QgMTowMA0KDQojIyMg66y47J6lIOyGjSDsl7Dsm5TsnbwNCg0K66y47J6lIOyViOyXkOyEnOuKlCAqKuyblMK37J28IOyVnuydmCAw7J2EIOu5vOqzoCoqIOyNqOyalC4NCg0K7JiIKQ0KLSAyMDI264WEIDA47JuUIDA17J28IOyeheuLiOuLpC4g4oaSIDIwMjbrhYQgOOyblCA17J28IOyeheuLiOuLpC4NCg0KIyMjIOyDgeuMgCDsi5zqsIQgKOuFuOy2nOyaqSkNCg0KfCDsobDqsbQgfCDtkZzquLAgfA0KfC0tLS0tLXwtLS0tLS18DQp8IDYw7LSIIOuvuOunjCB8IOuwqeq4iCDsoIQgfA0KfCA2MOu2hCDrr7jrp4wgfCBO67aEIOyghCB8DQp8IDI07Iuc6rCEIOuvuOunjCB8IE7si5zqsIQg7KCEIHwNCnwgMzDsnbwg66+466eMIHwgTuydvCDsoIQgfA0KfCAxMuqwnOyblCDrr7jrp4wgfCBO6rCc7JuUIOyghCB8DQp8IDEy6rCc7JuUIOydtOyDgSB8IE7rhYQg7KCEIHwNCg0K7JiIKSDrsKnquIgg7KCELCA167aEIOyghCwgMuyLnOqwhCDsoIQsIDPsnbwg7KCELCA26rCc7JuUIOyghCwgMuuFhCDsoIQNCg0KIyMjIOuniOqwkMK36riw6rCEIOunjOujjA0KDQpgRC1OYChO7J28IOuCqOydjCkgLyBgRC0wYCjsmKTripgg66eI6rCQKSAvIGBEK05gKE7snbwg6rK96rO8KQ0K7JiIKSBELTcsIEQtMSwgRC0wLCBEKzENCg0KIyMjIOuyiO2YuCDtkZzquLAgKO2VmOydtO2UiOycvOuhnCDqtazrtoQpDQoNCnwg7ZWt66qpIHwg7ZiV7IudIHwg7JiI7IucIHwNCnwtLS0tLS18LS0tLS0tfC0tLS0tLXwNCnwg7KCE7ZmU67KI7Zi4IHwg7ZWY7J207ZSIIOq1rOu2hCB8IDAyLTEyMzQtNTY3OCwgMDEwLTEyMzQtNTY3OCB8DQp8IOy5tOuTnOuyiO2YuCB8IDTsnpDrpqzslKkg7ZWY7J207ZSIIHwgMTIzNC01Njc4LTkwMTItMzQ1NiB8DQp8IOqzhOyijOuyiO2YuCB8IO2VmOydtO2UiCDqtazrtoQgfCAxMjMtNDU2LTc4OTAxMiB8DQp8IOyjvOuvvOuTseuhneuyiO2YuCB8IOyVniA27J6Q66asLeuSpCA37J6Q66asIHwgMTIzNDU2LTEyMzQ1NjcgfA0KfCDsgqzsl4XsnpDrk7HroZ3rsojtmLggfCAxMOyekOumrCDtlZjsnbTtlIggfCAwMS0yMzQtNTY3ODkgfA0KDQojIyMg7JOw66m0IOyViCDrkJjripQg7ZGc6riwDQoNCi0g64Kg7Kec7JeQIO2VmOydtO2UiMK367mX6riIOiDinYwgMjAyNS0wMS0wMSwgMDEvMDENCi0g7Iuc6rCE7JeQIOyYpOyghC/smKTtm4Q6IOKdjCDsmKTsoIQgMeyLnCAqKOuLqCwg7IKs7Jqp7J6Q6rCAIOyngeygkSDqs6DrpbTripQg67Cp66y4wrfsmIjslb0g7Iuc6rCE7J2AIOyYiOyZuCkqDQoNCioqKg0KDQojIyA4LiDtjJ3sl4Uo64uk7J207Ja866Gc6re4KQ0KDQrtjJ3sl4Ug66y46rWs64qUICoq7Jet7ZWgKioo7YOA7J207YuAwrfslYjrgrTCt+uyhO2KvCnqs7wgKirsnKDtmJUqKijthrXrs7Qv7YyQ64uoKeyXkCDrlLDrnbwg66y47LK06rCAIOuLrOudvOyalC4g7YOA7J207YuA7J2EIOuLpOuTrOydhCDrlZAg67CY65Oc7IucIOyViOuCtCjrs7jrrLgp6rmM7KeAIOqwmeydtCDrs7Tqs6AsIOuzuOusuCDrp6Xrnb3snYQg64u07JWE7JW8IO2VtOyalC4NCg0KIyMjIDDri6jqs4Qg4oCUIO2KuOumrOqxsOu2gO2EsCDrtJDsmpQNCg0K7Yyd7JeF7J20IOyCrOyaqeyekOydmCDslrTrlqQg7ZaJ64+ZIOuSpOyXkCDrnKjripTsp4Ag66i87KCAIO2MjOyVhe2VtOyalC4NCg0KLSDtlonrj5nsnYQgKirqsIDroZzrp4nqsbDrgpgg7YyQ64uo7J2EIOyalOq1rCoqKOydtO2DiMK37IKt7KCcwrfroZzqt7jslYTsm4PCt+yiheujjCkg4oaSICoq7YyQ64uo7ZiVKiogKOusvOyWtOu0kOyalCkNCi0g6rKw6rO8wrfsg4Htg5zrpbwgKirthrXrs7Trp4wqKiAo7JmE66OMwrfsi6TtjKgpIOKGkiAqKuyViOuCtO2YlSoqICjslYzroKTspJjsmpQpDQoNCiMjIyDtg4DsnbTti4Ag4oCUIOynp+ydgCDrqoXsgqzqtawNCg0KLSDrqoXsgqztmJXsnLzroZwg64Gd64K07JqULiDsooXqsrDslrTrr7jCt+uniOy5qO2RnOulvCDsk7Dsp4Ag7JWK7JWE7JqUICh+7JqUIC8gfuuLpCAvIH7quYzsmpQ/IOKdjCkuDQotIDJ+NOyWtOygiOuhnCDsp6fqs6Ag7Im96rKMLiDtlZzsnpDslrTCt+yImOyLneydhCDquLjqsowg7IyT7KeAIOyViuyVhOyalC4NCi0g7JWI64K0KOuzuOusuCkg66el65297J2EIOyalOyVve2VtCwgKirtg4DsnbTti4Drp4wg67SQ64+EIOustOyKqCDtjJ3sl4Xsnbjsp4AqKiDslYzqsowg7ZW07JqULiDsm5Drs7jsnbQgJ+yVjOumvMK37ZmV7J24J+yymOufvCDrp4nsl7DtlZjrqbQg67O466y47J2EIOq3vOqxsOuhnCDqtazssrTtmZTtlbTsmpQuDQoNCnwg7J2066CH6rKMIOunkOqzoCB8IOydtOugh+qyjCB8DQp8LS0tfC0tLXwNCnwg7KCA7J6l7ZWY7KeAIOyViuqzoCDrgpjqsIDsi5zqsqDslrTsmpQ/IHwg7KCA7J6lIOyViCDtlZwg64K07JqpIHwNCnwg7JWM66a8IHwg6rKw7KCcIOyZhOujjCB8DQp8IOygleunkCDsgq3soJztlZjsi5zqsqDsirXri4jquYw/IHwg642w7J207YSwIOyCreygnCB8DQoNCiMjIyDslYjrgrQo67O466y4KSDigJQg7ZW07JqU7LK0DQoNCi0gKirtjJDri6jtmJUqKuydgCAnfu2VoOq5jOyalD8n66GcIOusvOyWtOyalC4g65CY64+M66a0IOyImCDsl4bripQg7JyE7ZeYKOyCreygnMK37YOI7Ye0IOuTsSnsnYAg6rKw6rO866W8IOuovOyggCDqsr3qs6DtlbTsmpQuDQotICoq7JWI64K07ZiVKirsnYAg7IKs7Iuk7J2EIOyEnOyIoO2VtOyalC4NCi0g66eI7Lmo7ZGc66W8IOyNqOyalC4g7Iir7J6QwrfsobDqsbQo7J207IOBwrfsnbTtlZjCt+ydtOuCtCDrk7Ep7J2AIOq3uOuMgOuhnCDrkZDqs6AsIOybkOusuOyXkCDsl4bripQg7KCV67O0wrfsoIjssKjCt+yXsOudveyymOulvCDsp4DslrTrgrTsp4Ag7JWK7JWE7JqULg0KDQojIyMg67KE7Yq8IOKAlCDslYjrgrQg66y466el7J20IOygle2VtOyalA0KDQp8IOuzuOusuOydtCDsnbTroIfri6QgfCDrsoTtirwgfA0KfC0tLXwtLS18DQp8IOqysOqzvMK37IOB7YOc66W8IO2GteuztCB8IFvtmZXsnbhdIHwNCnwgJ37tlaDquYzsmpQ/J+uhnCDrrLzsnYwgfCBb7JWE64uI7JikXSDCtyBb64SkXSB8DQp8IOyDge2ZqSDshJzsiKAgKyDsmKTrpbjsqr3snbQg7Iuk7KCcIOuPmeyekSB8IFvst6jshoxdIMK3IFt764+Z7J6RfV0gfA0KDQotICfst6jshown64qUICoq64+Z7J6RIOuyhO2KvOqzvCDsp53snbwg65WM66eMKiog7I2o7JqUICjsmIg6IFvst6jshoxdwrdb7IKt7KCcXSkuICfri6vquLAgwrcg64+Z7J6RJ+yymOufvCDsp53snbQg7JWIIOunnuuKlCDsobDtlansnbTrgpgg64uo64+FICfst6jshown64qUIOyTsOyngCDslYrslYTsmpQuDQotIOuyhO2KvOydmCDrj5nsnpEg7J2066aE7J2AIO2ZlOuptCDquLDriqXrqoUo67OA6rK9wrftlbTsoJwg65OxKeydhCDqt7jrjIDroZwg7IK066Ck7JqULg0KDQojIyMg7Ya17KecIOyYiOyLnA0KDQoqKu2MkOuLqO2YlSDigJQg7J207YOIKioNCi0g7YOA7J207YuAOiDsoIDsnqUg7JWIIO2VnCDrgrTsmqkNCi0g7JWI64K0OiDsoIDsnqXtlZjsp4Ag7JWK6rOgIOuCmOqwiOq5jOyalD8g7J6F66Cl7ZWcIOuCtOyaqeydtCDsgqzrnbzsoLjsmpQuDQotIOuyhO2KvDog7JWE64uI7JikIMK3IOuEpA0KDQoqKu2MkOuLqO2YlSDigJQg7IKt7KCcICjsnITtl5gpKioNCi0g7YOA7J207YuAOiDrjbDsnbTthLAg7IKt7KCcDQotIOyViOuCtDog7IKt7KCc7ZWY66m0IOuLpOyLnCDsgrTrprQg7IiYIOyXhuyWtOyalC4g7IKt7KCc7ZWg6rmM7JqUPw0KLSDrsoTtirw6IOyVhOuLiOyYpCDCtyDrhKQNCg0KKirrj5nsnpHtmJUg4oCUIOyEnOyIoCArIOuPmeyekSDrsoTtirwqKg0KLSDtg4DsnbTti4A6IOq4sOq4sCDsl7DqsrAg7ZW07KCcDQotIOyViOuCtDog7ISg7YOd7ZWcIOq4sOq4sOydmCDsl7DqsrDsnYQg64GK7Ja07JqULg0KLSDrsoTtirw6IOy3qOyGjCDCtyDsl7DqsrAg7ZW07KCcDQoNCioq7JWI64K07ZiVIOKAlCDsmYTro4wg7Ya167O0KioNCi0g7YOA7J207YuAOiDqsrDsoJwg7JmE66OMDQotIOyViOuCtDog6rKw7KCc6rCAIOygleyDgSDsspjrpqzrkJDslrTsmpQuDQotIOuyhO2KvDog7ZmV7J24DQoNCioqKg0KDQojIOyYiOyZuCDqt5zsuZkNCg0K7JuQ7LmZKOuKpeuPmcK36riN7KCVwrfsupDso7zslrwp67O064ukIOyYiOyZuOqwgCDrjZQg66qF7ZmV7ZWcIOy7pOuupOuLiOy8gOydtOyFmOydhCDrp4zrk5zripQg6rK97Jqw7JiI7JqULg0KDQojIyDsmIjsmbggMS4g7IiY64+Z7ZiVIOusuOyepeydhCDsjajrj4Qg65CY64qUIOqyveyasA0KDQojIyMg7ISc67mE7IqkIOyiheujjCwg6riw6rCEIOunjOujjA0KDQrsiJjrj5ntmJXsnLzroZwg7JOw66m0IOyjvOyWtCjsooXro4wg7ISc67mE7IqkLCDquLDqsIQg65OxKeulvCDqsJXsobDtlaAg7IiYIOyeiOqzoCwgJ+yiheujjCfsmYAgJ+unjOujjCfsnZgg64mY7JWZ7Iqk66W8IOygle2Zle2eiCDsoITri6ztlaAg7IiYIOyeiOyWtOyalC4NCg0K7JiIKQ0KLSBPT08g7ISc67mE7IqkIOyiheujjCDslYjrgrQg4oCUIDAw7JuUIDAw7J2867aA7YSwIOyEnOu5hOyKpOqwgCDsooXro4zrj7zsmpQuIOyekOyEuO2VnCDrgrTsmqnsnYQg7JWM66Ck65Oc66Ck7JqULg0KLSDsnpDsgrAg7KGw7ZqMIOq4sOqwhOydtCDqs6cg66eM66OM64+87JqULg0KDQrri6gsICoq7KO86riw7KCB7Jy866GcIOyiheujjOqwgCDrsJjrs7XrkJjripQg7KCc7ZKIKirsl5DripQgJ+yiheujjOuPvOyalCfrpbwg7JOw7KeAIOyViuyVhOyalC4NCg0K7JiIKQ0KLSDsmKTripjsnZgg7YC07KaI6rCAIOqzpyDsooXro4zrj7zsmpQg4oaSIOyYpOuKmOydmCDtgLTspojqsIAg6rOnIOuBneuCmOyalA0KDQojIyMg7IKs7Jqp7J6Q7JeQ6rKMIOuvuOy5mOuKlCDsmIHtlqXsnYQg7JWM66Ck7KSEIOuVjA0KDQoo7KO87JqUIOuPmeyCrCA6IOyXsOyytCwg7ZW07KeALCDsoIHsmqkg65OxKQ0KDQrsiJjrj5ntmJXsnLzroZwg7JOw66m0IOyduOqzvCDqtIDqs4Trpbwg66qF7ZmV7ZWY6rKMIOyEpOuqhe2VmOqzoCwgJ+yCrOyaqeyekOydmCDtlonrj5nsl5Ag65Sw65287Jik64qUIOqysOqzvCfrnbzripQg7KCQ7J2EIOyVjOugpOykhCDsiJgg7J6I7Ja07JqULg0KDQrsmIgpDQotIOyYpOuKmOq5jOyngCDrgrTsp4Ag7JWK7Jy866m0IOyXsOyytOuPvOyalC4g7ZuE67aI6rKw7KCcIOq4iOyVoeydhCDrgrTso7zshLjsmpQuDQotIOuMgOy2nOydhCDqsIjslYTtg4DrqbQg7JuQ656YIOuMgOy2nOydtCDtlbTsp4Drj7zsmpQuIOyYpOuKmCDrgqDsp5zquYzsp4DsnZgg7J207J6Q66W8IOydgO2WieyXkCDrgrTslbwg7ZW07JqULg0KDQojIyMg7IKs7Jqp7J6QIOyViOyLrCAo7IiY64+Z7ZiVKQ0KDQon7KCV67O0IOyImOynkSDslYjrgrQnIOuTseydmCDrr7zqsJDtlZwg7IOB7Zmp7JeQ7IScICoq7Iuc7Iqk7YWc7J20IOyekOuPmeycvOuhnCDsspjrpqztlZzri6TripQg7KCQKirsnYQg7IiY64+Z7ZiV7Jy866GcIOyVjOugpCDsgqzsmqnsnpDrpbwg7JWI7Ius7ZWY6rKMIO2VoCDsiJgg7J6I7Ja07JqULg0KDQrsmIgpDQotIOydtOygnOu2gO2EsCDtmY3quLjrj5nri5jsnZgg6rCc7J247KCV67O0IOydtOyaqSDrgrTsl63snbQg6riw66Gd64+87JqUDQotIOuNlCDsoovsnYAg7IOB64u07J2EIOychO2VtCDthrXtmZQg64K07Jqp7J2AIOuFueydjOuPvOyalA0KDQojIyDsmIjsmbggMi4g6rK97Ja066W8IOyNqOuPhCDrkJjripQg6rK97JqwDQoNCu2KueyglSDsg4Htmansl5DshJwg7KCc7ZWc7KCB7Jy866GcICfsi5zrgpjsmpQ/LCDshajrgpjsmpQ/JyDsnZjrrLjtmJUg7Ja066+466W8IOyTuCDsiJgg7J6I7Ja07JqULg0KDQojIyMg7IKs7Jqp7J6Q7J2YIOunpeudveydhCDtmZzsmqntlbTshJwg7KeI66y47ZWgIOuVjA0KDQon7Iuc64KY7JqUPycsICfshajrgpjsmpQ/JyDtmJXtg5zsnZgg6rK97Ja066W8IO2ZnOyaqe2VtOyEnCDsgqzsmqnsnpDsnZgg64u57Zmp7Iqk65+s7JuA7J2EIOykhOydvCDsiJgg7J6I7Ja07JqULg0KDQrsmIgpDQotIO2Zjeq4uOuPmeuLmCwgT09PIOuLpOuFgOyYpOyFqOuCmOyalD8NCi0g7Lap7KCE7ZWY65+sIO2OuOydmOygkCDqsIDsi5zrgpjsmpQ/DQoNCiMjIyDsgqzsmqnsnpDsnZgg7IOB7Zmp7J2EIOy2lOygle2VoCDrlYwNCg0K66qF7ZmV7ZWcIOygleuztOqwgCDsl4bslrTshJwg7IKs7Jqp7J6Q7JeQ6rKMIOyngeygkSDtjJDri6jtlZjqsowg7ZW07JW8IO2VoCDrlYwg6rK97Ja066GcIOygleykke2VmOqyjCDsp4jrrLjtlaAg7IiYIOyeiOyWtOyalC4NCg0K7JiIKQ0KLSDsubTrk5zrpbwg67Cb7Jy87IWo64KY7JqUPyDrk7HroZ3tlZjrqbQg7LqQ7Iuc67CxIO2YnO2DneydhCDrsJvsnYQg7IiYIOyeiOyWtOyalC4NCg0KIyMjIOyCrOyaqeyekOydmCDshKDsnZjqsIAg7ZWE7JqU7ZWgIOuVjA0KDQrshKTrrLjsobDsgqzsspjrn7wg7IKs7Jqp7J6Q7J2YIOyEoOydmOulvCDquLDrjIDtlbTslbwg7ZWgIOuVjCDqsr3slrTroZwg7KCV7KSR7ZWY6rKMIOyniOusuO2VtOyalC4NCg0K7JiIKQ0KLSDsnbTrsogg64us7JeQIOyEnOu5hOyKpOulvCDsnbTsmqntlZjrqbTshJwg7Ja866eI64KYIOunjOyhse2VmOyFqOuCmOyalD8NCg0KIyMg7JiI7Jm4IDMuIOu2gOygle2YlSDrrLjsnqXsnYQg7I2o64+EIOuQmOuKlCDqsr3smrANCg0K7IKs7Jqp7J6Q7JeQ6rKMIOuqhe2Zle2VmOqyjCDrtoDsoJXsoIHsnbgg64K07Jqp7J2EIOyVjOugpOykmOyVvCDtlaAg65WM64qUIOu2gOygle2YlSDrrLjsnqXsnYQg7I2o64+EIOyii+yVhOyalC4NCg0KIyMjIOyEnOu5hOyKpOulvCDsoJXssYXsg4Eg7JO4IOyImCDsl4bsnYQg65WMDQoNCuu2gOygle2YleycvOuhnCDsjajslbwg7IKs7Jqp7J6Q7JeQ6rKMIOyDge2ZqeydhCDrqoXtmZXtlZjqsowg7J247KeA7Iuc7YKsIOyImCDsnojslrTsmpQuICoq7JO4IOyImCDsl4bripQg7J207Jyg66W8IO2VqOq7mCDslYjrgrTtlbTso7zshLjsmpQuKioNCg0K7JiIKQ0KLSDsp4DquIjsnYAg6rCA7J6F7ZWgIOyImCDsl4bslrTsmpQuIOyyreyGjOuFhOydhCDsnITtlZwg7ISc67mE7Iqk64qUIOyVhOyngSDspIDruYQg7KSR7J207JeQ7JqULg0KLSDqs7XrrLTsm5DsnYAg7ZuE7JuQ6riI7J2EIOuztOuCvCDsiJgg7JeG7Ja07JqULg0KDQojIyMg7J2867aAIOq4sOuKpeunjCDsk7gg7IiYIOyXhuydhCDrlYwNCg0K67aA7KCV7ZiV7Jy866GcIOyNqOyVvCDsgqzsmqnsnpDqsIAg7Ja065akIOq4sOuKpeydhCDsk7gg7IiYIOyXhuuKlOyngCDrqoXtmZXtlZjqsowg7J247KeA7ZWgIOyImCDsnojslrTsmpQuDQoNCuyYiCkNCi0g7KCQ6rKAIOq4sOqwhCDrj5nslYgg7ISc67mE7Iqk66W8IOydtOyaqe2VoCDsiJgg7JeG7Ja07JqULg0KLSDsi6DrtoTspp0g7ZmV7J2465CY6riwIOyghOq5jOyngCDshqHquIjqs7wg6rKw7KCc66W8IO2VoCDsiJgg7JeG7Ja07JqULg0KDQojIyMg7IKs7Jqp7J6QIOyEoO2DneydmCDqsrDqs7zrpbwg7JWI64K07ZWgIOuVjA0KDQrrkJjrj4zrprQg7IiYIOyXhuuKlCDshKDtg53snYAg67aA7KCV7ZiV7Jy866GcIOuqhe2Zle2VmOqyjCDslYzroKTsmpQuDQoNCuyYiCkNCi0g7ZWcIOuyiCDrsJTqvrjrqbQg7LqQ7Iuc67Cx7J2AIOuLpOyLnCDrsJvsnYQg7IiYIOyXhuyWtOyalC4NCg0KIyMjIOyCrOyaqeyekCDslYjsi6wgKOu2gOygle2YlSkNCg0KJ+ygleuztCDsiJjsp5Eg7JWI64K0JyDrk7HsnZgg66+86rCQ7ZWcIOyDge2ZqeyXkOyEnCAqKuygleuztOqwgCDrs7TtmLjrkJzri6TripQg7KCQKirsnYQg67aA7KCV7ZiV7Jy866GcIOyVjOugpCDsgqzsmqnsnpDrpbwg7JWI7Ius7ZWY6rKMIO2VoCDsiJgg7J6I7Ja07JqULg0KDQrsmIgpDQotIOyDgeuLtOydtCDrgZ3rgpjrqbQg7KCE66y46rCA64+EIO2Zjeq4uOuPmeuLmOydmCDsoJXrs7Trpbwg67O8IOyImCDsl4bslrTsmpQuDQotIO2Zjeq4uOuPmeuLmOydmCDsoJXrs7TqsIAg6riw66Gd65CY7KeAIOyViuyVhOyalC4NCg0KIyMg7JiI7Jm4IDQuIOygnO2SiCDsmqnslrTripQg67CU6r647KeAIOyViuq4sA0KDQon6rCE6rKw7ZWY6rOgIOyJrOyatCDrp5AnIOybkOy5meuztOuLpCAqKu2ZlOuptOydmCDquLDriqXrqoXCt+uyhO2KvOuqheqzvOydmCDsmqnslrQg7J287LmYKirqsIAg7Jqw7ISg7J207JeQ7JqULg0K6riw64ql66qF7JeQIOyTsOyduCDri6jslrQo67OA6rK9LCDsp4DsoJUsIOuTseuhnSDrk7Ep66W8IOyViOuCtCDrrLjqtazsl5DshJwg64uk66W4IOunkOuhnCDrsJTqvrjrqbQg7IKs7Jqp7J6Q6rCAIOuLpOuluCDquLDriqXsnLzroZwg7Jik7ZW07ZWgIOyImCDsnojslrTsmpQuDQoNCuyYiCkgJ+q2jO2VnCDrs4Dqsr0nIOq4sOuKpeydmCDslYjrgrQg66y46rWsDQotIOuLpOuluCDsgqzrnozsnYQg66eI7Iqk7YSwIOq0gOumrOyekOuhnCDsp4DsoJXtlZjrqbQg67CU6r+AIOyImCDsnojslrTsmpQgKFgpDQotIOuLpOuluCDsgqzrnozsnYQg66eI7Iqk7YSwIOq0gOumrOyekOuhnCDsp4DsoJXtlZjrqbQg67OA6rK97ZWgIOyImCDsnojslrTsmpQgKE8pDQoNCiMjIOyYiOyZuCA1LiDsi5zsiqTthZwg64+Z7J6R6rO8IOuLpOuluCDrj5nsgqwg7JOw7KeAIOyViuq4sA0KDQrrrLjqtazrpbwg7JWE66y066asIOunpOuBhOufveqyjCDri6Trk6zslrTrj4QgKirsi6TsoJwg7Iuc7Iqk7YWcIOuPmeyekeqzvCDri6Trpbgg64+Z7IKsKirrpbwg7JOw66m0IOyemOuqu+uQnCDrrLjqtazsmIjsmpQuDQoNCuyYiCkg66eI7Iqk7YSwIOq0gOumrOyekOulvCAn7LaU6rCAIOyngOyglSftlZjripQg7Iuc7Iqk7YWc7JeQ7IScICjsnbTsoITCt+yWkeuPhCDquLDriqXsnbQg7JWE64uYKQ0KLSDri6Trpbgg7IKs656M7JeQ6rKMIOuniOyKpO2EsCDqtIDrpqzsnpDrpbwg64SY6rKo7KO87IS47JqUIChYIOKAlCDsl4bripQgJ+uEmOq4sOq4sCcg6riw64ql7J2EIOyVlOyLnCkNCi0g64uk66W4IOyCrOuejOydhCDrp4jsiqTthLAg6rSA66as7J6Q66GcIOyngOygle2VtCDso7zshLjsmpQgKE8pDQpQSwMEFAAACAAAAAAAAMfoXtrECgAAxAoAABgAAABjbGF1ZGUtYnJpZGdlLXNpbGVudC52YnP//icAIABDAGwAYQB1AGQAZQAgAEIAcgBpAGQAZwBlACAAbABhAHUAbgBjAGgAZQByACAAFCAgAOiyxKzEvCAAJMEVyCAAEMiArCAAxNYgAOSyrLkgAOTCidUKACcAIABjAGwAYQB1AGQAZQBiAHIAaQBkAGcAZQA6AC8ALwAgAATVXLig0VzPdMcgAHTHIAAM03zHRMcgAIC9eLnksiAAKADxtF24OgAgAG4AcABtACAAaQBuAHMAdABhAGwAbAAgABC2lLIgACIAdNBcuNy0IADkziWxMNEiACAAJMFYziAADNN8xykALgAKACcAIABUuwCsIABgvjjIIACIxzzHdLogAFzVIACIvNDFIABY1ZiwKcUgAEjFtLBY1eCsLAAgAOSyIAAAyUS+GLR0uiAA5LKsuXy5IAA9zCAAxsV0xyAA5MKJ1VzV5LIuAAoAUwBlAHQAIABmAHMAbwAgAD0AIABDAHIAZQBhAHQAZQBPAGIAagBlAGMAdAAoACIAUwBjAHIAaQBwAHQAaQBuAGcALgBGAGkAbABlAFMAeQBzAHQAZQBtAE8AYgBqAGUAYwB0ACIAKQAKAFMAZQB0ACAAcwBoACAAPQAgAEMAcgBlAGEAdABlAE8AYgBqAGUAYwB0ACgAIgBXAFMAYwByAGkAcAB0AC4AUwBoAGUAbABsACIAKQAKAGQAaQByACAAPQAgAGYAcwBvAC4ARwBlAHQAUABhAHIAZQBuAHQARgBvAGwAZABlAHIATgBhAG0AZQAoAFcAUwBjAHIAaQBwAHQALgBTAGMAcgBpAHAAdABGAHUAbABsAE4AYQBtAGUAKQAKAHMAaAAuAEMAdQByAHIAZQBuAHQARABpAHIAZQBjAHQAbwByAHkAIAA9ACAAZABpAHIACgAKACcAIAAxAC8AMgApACAATgBvAGQAZQAuAGoAcwAgABDIgKwgABQgIADGxTzHdLogAOSytMZcuNy0IACY03THwMl8uSAA9MW0xQDJ5LIKAEkAZgAgAHMAaAAuAFIAdQBuACgAIgBjAG0AZAAgAC8AYwAgAHcAaABlAHIAZQAgAG4AbwBkAGUAIgAsACAAMAAsACAAVAByAHUAZQApACAAPAA+ACAAMAAgAFQAaABlAG4ACgAgACAASQBmACAATQBzAGcAQgBvAHgAKAAiAE4AbwBkAGUALgBqAHMAAKwgACTBWM78syAAiMfAySAASsVExZTGLgAiACAAJgAgAHYAYgBDAHIATABmACAAJgAgAHYAYgBDAHIATABmACAAJgAgAF8ACgAgACAAIAAgACAAIAAgACAAIAAgACAAIAAiAFsAVdZ4x10ARMcgAASydLl0uiAA5LK0xly43LQgAJjTdMfAyQCsIAD0xb25yLLksi4AIAAkwVjOfLkgAMi5XM4gAKS0LAAgAAzV7Lf4rXjH0MUcwSAAdNBcuNy0IACEvLzSRMcgAOSy3MIgAAyy7LcgAPzIOMGUxi4AIgAsACAAXwAKACAAIAAgACAAIAAgACAAIAAgACAAIAAgAHYAYgBPAEsAQwBhAG4AYwBlAGwAIAArACAAdgBiAEUAeABjAGwAYQBtAGEAdABpAG8AbgAsACAAIgB00Fy43LQgAOSyrLkgACTBFcggACgAMQAvADIAKQAgABQgIABOAG8AZABlAC4AagBzACIAKQAgAD0AIAB2AGIATwBLACAAVABoAGUAbgAKACAAIAAgACAAcwBoAC4AUgB1AG4AIAAiAGgAdAB0AHAAcwA6AC8ALwBuAG8AZABlAGoAcwAuAG8AcgBnAC8AawBvAC8AZABvAHcAbgBsAG8AYQBkACIACgAgACAARQBuAGQAIABJAGYACgAgACAAVwBTAGMAcgBpAHAAdAAuAFEAdQBpAHQACgBFAG4AZAAgAEkAZgAKAAoAJwAgADIALwAyACkAIABDAGwAYQB1AGQAZQAgAEMAbwBkAGUAIAAQyICsIAAUICAAxsU8x3S6IAAkwVjOtwBcuPiteMcgACm8lbxExyAASMW0sFzV5LIKAEkAZgAgAHMAaAAuAFIAdQBuACgAIgBjAG0AZAAgAC8AYwAgAHcAaABlAHIAZQAgAGMAbABhAHUAZABlACIALAAgADAALAAgAFQAcgB1AGUAKQAgADwAPgAgADAAIABUAGgAZQBuAAoAIAAgAE0AcwBnAEIAbwB4ACAAIgBDAGwAYQB1AGQAZQAgAEMAbwBkAGUAAKwgACTBWM78syAAiMfAySAASsVExZTGIAAoABC2lLIgAFAAQQBUAEgA0MUgAMbFtMWUxikALgAiACAAJgAgAHYAYgBDAHIATABmACAAJgAgAHYAYgBDAHIATABmACAAJgAgAF8ACgAgACAAIAAgACAAIAAgACAAIAAiADDR+LsQsdDFHMEgAETFmLd8uSAAJMFYzrcAXLj4rXjHXNUgAKS0LAAgAHTQXLjctCAAhLy80kTHIADkstzCIAAMsuy3IAD8yDjBlMY6ACIAIAAmACAAdgBiAEMAcgBMAGYAIAAmACAAdgBiAEMAcgBMAGYAIAAmACAAXwAKACAAIAAgACAAIAAgACAAIAAgACIAIAAgAG4AcABtACAAaQBuAHMAdABhAGwAbAAgAC0AZwAgAEAAYQBuAHQAaAByAG8AcABpAGMALQBhAGkALwBjAGwAYQB1AGQAZQAtAGMAbwBkAGUAIgAgACYAIAB2AGIAQwByAEwAZgAgACYAIABfAAoAIAAgACAAIAAgACAAIAAgACAAIgAgACAAYwBsAGEAdQBkAGUAIABsAG8AZwBpAG4AIgAgACYAIAB2AGIAQwByAEwAZgAgACYAIAB2AGIAQwByAEwAZgAgACYAIABfAAoAIAAgACAAIAAgACAAIAAgACAAIgBV1njHIAApvJW8OgAgADDR+LsQsdDFHMEgAGMAbABhAHUAZABlACAALQAtAHYAZQByAHMAaQBvAG4AIAB0xyAAhLwEyETHIACczSW4WNV0uiAAAMlEviAARMbMuIXHyLLksi4AIgAgACYAIAB2AGIAQwByAEwAZgAgACYAIABfAAoAIAAgACAAIAAgACAAIAAgACAAIgAoAKzAqcbJt0DHIAB0xyAAUABDANDFIABcuPiteMcctCAAdNBcuNy0IABsrcWzIABc1cSz0MUcwSAAKMwQrCm0yLLksi4AKQAiACwAIABfAAoAIAAgACAAIAAgACAAIAAgACAAdgBiAEUAeABjAGwAYQBtAGEAdABpAG8AbgAsACAAIgB00Fy43LQgAOSyrLkgACTBFcggACgAMgAvADIAKQAgABQgIABDAGwAYQB1AGQAZQAgAEMAbwBkAGUAIgAKACAAIABXAFMAYwByAGkAcAB0AC4AUQB1AGkAdAAKAEUAbgBkACAASQBmAAoACgAnACAAAMlEviAARMbMuCAAFCAgAOSyrLl8uSAAPcwgAMbFdMcgAOTCidUgACgADNXst/iteMd0xyAA56wgAJDH2bMgABCswMkpAAoAcwBoAC4AUgB1AG4AIAAiAGMAbQBkACAALwBjACAAbgBvAGQAZQAgAHMAYwByAGkAcAB0AHMAXABjAGwAYQB1AGQAZQAtAGIAcgBpAGQAZwBlAC4AagBzACIALAAgADAALAAgAEYAYQBsAHMAZQAKAFBLAwQUAAAIAAAAAAAAqYtMNjYBAAA2AQAAGQAAAGNsYXVkZS13YXRjaGVyLXNpbGVudC52YnMnIENsYXVkZSBCcmlkZ2Ugd2F0Y2hlciBzaWxlbnQgbGF1bmNoZXIgKG5vIHdpbmRvdykgLSByZWdpc3RlcmVkIHRvIHJ1biBhdCBsb2dpbgpTZXQgZnNvID0gQ3JlYXRlT2JqZWN0KCJTY3JpcHRpbmcuRmlsZVN5c3RlbU9iamVjdCIpClNldCBzaCA9IENyZWF0ZU9iamVjdCgiV1NjcmlwdC5TaGVsbCIpCmRpciA9IGZzby5HZXRQYXJlbnRGb2xkZXJOYW1lKFdTY3JpcHQuU2NyaXB0RnVsbE5hbWUpCnNoLkN1cnJlbnREaXJlY3RvcnkgPSBkaXIKc2guUnVuICJjbWQgL2Mgbm9kZSBzY3JpcHRzXGJyaWRnZS13YXRjaGVyLmpzIiwgMCwgRmFsc2UKUEsBAh4DFAAACAAAAAAAAGmomogNBAAADQQAAAoAAAAAAAAAAAAAAKSBAAAAAOyEpOy5mC5iYXRQSwECHgMUAAAIAAAAAAAAsn3St6cDAACnAwAADgAAAAAAAAAAAAAA7YE1BAAA7ISk7LmYLmNvbW1hbmRQSwECHgMUAAAIAAAAAAAASoOKMGECAABhAgAAEwAAAAAAAAAAAAAApIEICAAA7J297Ja07KO87IS47JqULnR4dFBLAQIeAxQAAAgAAAAAAACAGyUXN0gBADdIAQAYAAAAAAAAAAAAAACkgZoKAABzY3JpcHRzL2NsYXVkZS1icmlkZ2UuanNQSwECHgMUAAAIAAAAAAAAcAIIPZdRAACXUQAAGQAAAAAAAAAAAAAApIEHUwEAc2NyaXB0cy9icmlkZ2Utd2F0Y2hlci5qc1BLAQIeAxQAAAgAAAAAAADX9Oje5RMAAOUTAAAcAAAAAAAAAAAAAACkgdWkAQBzY3JpcHRzL3JlZ2lzdGVyLXByb3RvY29sLmpzUEsBAh4DFAAACAAAAAAAAK8AOn92QwAAdkMAABUAAAAAAAAAAAAAAKSB9LgBAHJlY29tbWVuZC1leGFtcGxlcy5tZFBLAQIeAxQAAAgAAAAAAAAMFhqpezgAAHs4AAANAAAAAAAAAAAAAACkgZ38AQB1eC13cml0aW5nLm1kUEsBAh4DFAAACAAAAAAAAMfoXtrECgAAxAoAABgAAAAAAAAAAAAAAKSBQzUCAGNsYXVkZS1icmlkZ2Utc2lsZW50LnZic1BLAQIeAxQAAAgAAAAAAACpi0w2NgEAADYBAAAZAAAAAAAAAAAAAACkgT1AAgBjbGF1ZGUtd2F0Y2hlci1zaWxlbnQudmJzUEsFBgAAAAAKAAoAlwIAAKpBAgAAAA==";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "";
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

  // 하위 프레임 목록에서 한 줄을 누르면 캔버스에서 그 프레임을 선택한다.
  // (FOCUS_NODE는 TEXT만 받으므로 프레임은 여기서 처리한다)
  if (msg.type === "SELECT_FRAME") {
    try {
      const nodeId = String(msg.nodeId || "");
      if (!nodeId) return;
      const node = await figma.getNodeByIdAsync(nodeId); // dynamic-page — 동기 getNodeById 금지
      if (!node || (node as any).removed) return;
      // 이 선택의 메아리(selectionchange)로 입력창이 덮이지 않게 표시해 둔다.
      // 이미 그 노드만 선택된 상태면 메아리가 아예 안 울리므로 표시하지 않는다 —
      // 남겨 두면 나중에 사용자가 같은 노드를 직접 고를 때 그 조회를 한 번 삼킨다.
      const sel = figma.currentPage.selection;
      const already = sel.length === 1 && !!sel[0] && sel[0].id === nodeId;
      if (!already) selfPickedNodeId = nodeId;
      figma.currentPage.selection = [node as any];
      figma.viewport.scrollAndZoomIntoView([node as any]);
    } catch (e) {
      // 다른 페이지의 노드거나 이미 지워진 경우 — 선택만 실패하고 조용히 넘어간다
      selfPickedNodeId = null;
      console.error("[SELECT_FRAME] 프레임 선택 오류:", e);
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
    // 윈도우·맥 모두 같은 zip을 준다 — 안에 평범한 스크립트만 들어 있어 백신 오탐이 적다.
    // (예전엔 코드를 base64로 품은 .bat/.command를 내려줬는데 V3가 악성코드로 격리해 설치가 아예 막혔다)
    figma.ui.postMessage({ type: 'installer-file', b64: INSTALLER_B64, name: '클로드-커넥터.zip', mime: 'application/zip' });
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
