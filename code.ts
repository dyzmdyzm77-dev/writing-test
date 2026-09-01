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
// ===== INSTALLER:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.bat을 base64로 주입) =====
const INSTALLER_B64 = "QGVjaG8gb2ZmDQpyZW0gUzEgVVggV3JpdGluZyAtIENsYXVkZSBCcmlkZ2Ugb25lLXNob3QgaW5zdGFsbGVyIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQ0Kc2V0bG9jYWwNCnNldCAiQ0JfU0VMRj0lfmYwIg0KcG93ZXJzaGVsbCAtTm9Qcm9maWxlIC1FeGVjdXRpb25Qb2xpY3kgQnlwYXNzIC1Db21tYW5kICIkdD1bSU8uRmlsZV06OlJlYWRBbGxUZXh0KCRlbnY6Q0JfU0VMRik7JGE9JzonKyc6UFM6JysnOic7JGI9JzonKyc6QlJJREdFOicrJzonOyRtPVtyZWdleF06Ok1hdGNoKCR0LCcoP3MpJytbcmVnZXhdOjpFc2NhcGUoJGEpKycoLio/KScrW3JlZ2V4XTo6RXNjYXBlKCRiKSk7aWV4KFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRTdHJpbmcoW0NvbnZlcnRdOjpGcm9tQmFzZTY0U3RyaW5nKCgkbS5Hcm91cHNbMV0uVmFsdWUgLXJlcGxhY2UgJ1teQS1aYS16MC05Ky89XScsJycpKSkpIg0KZW5kbG9jYWwNCmV4aXQgL2INCjo6UFM6Og0KSkVWeWNtOXlRV04wYVc5dVVISmxabVZ5Wlc1alpTQTlJQ2RUZEc5d0p3cEJaR1F0Vkhsd1pTQXRRWE56WlcxaWJIbE9ZVzFsSUZONWMzUmxiUzVYYVc1a2IzZHpMa1p2Y20xekNpUnphV3hsYm5RZ1BTQW9KR1Z1ZGpwRFFsOVRTVXhGVGxRZ0xXVnhJQ2N4SnlrZ0lDTWc3SjZRNjQrWklPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZeWQ3SmVGSU95RG5ldWV0UXBtZFc1amRHbHZiaUJDYjNnb0pIUmxlSFFzSUNSMGFYUnNaU3dnSkdsamIyNHBJSHNnYVdZZ0tDMXViM1FnSkhOcGJHVnVkQ2tnZXlCYmRtOXBaRjFiVTNsemRHVnRMbGRwYm1SdmQzTXVSbTl5YlhNdVRXVnpjMkZuWlVKdmVGMDZPbE5vYjNjb0pIUmxlSFFzSUNSMGFYUnNaU3dnSjA5TEp5d2dKR2xqYjI0cElIMGdmUW9rY21GM0lEMGdXMGxQTGtacGJHVmRPanBTWldGa1FXeHNWR1Y0ZENna1pXNTJPa05DWDFORlRFWXBDbVoxYm1OMGFXOXVJRkJoY25Rb0pHNWhiV1VzSUNSdVpYaDBLU0I3Q2lBZ0pHMGdQU0JiY21WblpYaGRPanBOWVhSamFDZ2sNCmNtRjNMQ0FuS0Q5ektTY2dLeUJiY21WblpYaGRPanBGYzJOaGNHVW9Kem9uS3ljNkp5c2tibUZ0WlNzbk9pY3JKem9uS1NBcklDY29MaW8vS1NjZ0t5QmJjbVZuWlhoZE9qcEZjMk5oY0dVb0p6b25LeWM2Snlza2JtVjRkQ3NuT2ljckp6b25LU2tLSUNCcFppQW9MVzV2ZENBa2JTNVRkV05qWlhOektTQjdJSFJvY205M0lDZ243SVNrN0xtWUlPMk1qT3lkdk95ZHRDRHNocERzZzRIcmtKRHNsclRzbXBRNklDY2dLeUFrYm1GdFpTa2dmUW9nSUhKbGRIVnliaUJiUTI5dWRtVnlkRjA2T2taeWIyMUNZWE5sTmpSVGRISnBibWNvS0NSdExrZHliM1Z3YzFzeFhTNVdZV3gxWlNBdGNtVndiR0ZqWlNBblcxNUJMVnBoTFhvd0xUa3JMejFkSnl3Z0p5Y3BLUXA5Q2lSa2FYSWdQU0JLYjJsdUxWQmhkR2dnSkdWdWRqcE1UME5CVEVGUVVFUkJWRUVnSjBOc1lYVmtaVUp5YVdSblpTY0tUbVYzTFVsMFpXMGdMVWwwWlcxVWVYQmxJRVJwY21WamRHOXllU0F0Um05eVkyVWdMVkJoZEdnZ0tFcHZhVzR0VUdGMGFDQWtaR2x5DQpJQ2R6WTNKcGNIUnpKeWtnZkNCUGRYUXRUblZzYkFwYlNVOHVSbWxzWlYwNk9sZHlhWFJsUVd4c1FubDBaWE1vS0VwdmFXNHRVR0YwYUNBa1pHbHlJQ2R6WTNKcGNIUnpYR05zWVhWa1pTMWljbWxrWjJVdWFuTW5LU3dnS0ZCaGNuUWdKMEpTU1VSSFJTY2dKMFZZUVUxUVRFVlRKeWtwQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdvU205cGJpMVFZWFJvSUNSa2FYSWdKM0psWTI5dGJXVnVaQzFsZUdGdGNHeGxjeTV0WkNjcExDQW9VR0Z5ZENBblJWaEJUVkJNUlZNbklDZEhWVWxFUlNjcEtRcGJTVTh1Um1sc1pWMDZPbGR5YVhSbFFXeHNRbmwwWlhNb0tFcHZhVzR0VUdGMGFDQWtaR2x5SUNkMWVDMTNjbWwwYVc1bkxtMWtKeWtzSUNoUVlYSjBJQ2RIVlVsRVJTY2dKMHhCVlU1RFNFVlNKeWtwQ2lSc1lYVnVZMmhsY2lBOUlFcHZhVzR0VUdGMGFDQWtaR2x5SUNkamJHRjFaR1V0WW5KcFpHZGxMWE5wYkdWdWRDNTJZbk1uQ2x0SlR5NUdhV3hsWFRvNlYzSnBkR1ZCYkd4Q2VYUmxjeWdrYkdGMQ0KYm1Ob1pYSXNJQ2hRWVhKMElDZE1RVlZPUTBoRlVpY2dKMWRCVkVOSVJWSW5LU2tLVzBsUExrWnBiR1ZkT2pwWGNtbDBaVUZzYkVKNWRHVnpLQ2hLYjJsdUxWQmhkR2dnSkdScGNpQW5jMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5Y3BMQ0FvVUdGeWRDQW5WMEZVUTBoRlVpY2dKMWRUU1V4RlRsUW5LU2tLSkhkMlluTWdQU0JLYjJsdUxWQmhkR2dnSkdScGNpQW5ZMnhoZFdSbExYZGhkR05vWlhJdGMybHNaVzUwTG5aaWN5Y0tXMGxQTGtacGJHVmRPanBYY21sMFpVRnNiRUo1ZEdWektDUjNkbUp6TENBb1VHRnlkQ0FuVjFOSlRFVk9WQ2NnSjBWT1JDY3BLUW9qSU9xd2tPeUxuT3lla0RvZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrU0FySU95bmdPcTRpQ0RxdUxEcmo1a2dLTzJVak91ZnJPcTN1T3lkdUNCbVpYUmphT3F3Z0NEcmk2VHJwcXpycGJ3ZzdMeWtJT3lJbUNEc25vanFzb3dnNG9DVUlPMlV2T3EzdU91bmlPcXdnQ0R0bElUcm9aenRocURzdlp3ZzdKZTA2cml3NjZXOElPdW4NCmlldUtsQ0Ryc29Uc29JUWc2NHlBN0oyUktRcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhOYVdOeWIzTnZablJjVjJsdVpHOTNjMXhEZFhKeVpXNTBWbVZ5YzJsdmJseFNkVzRuSUMxT1lXMWxJQ2REYkdGMVpHVkNjbWxrWjJWWFlYUmphR1Z5SnlBdFZtRnNkV1VnS0NkM2MyTnlhWEIwTG1WNFpTQWlKeUFySUNSM2RtSnpJQ3NnSnlJbktRcFRkR0Z5ZEMxUWNtOWpaWE56SUMxR2FXeGxVR0YwYUNBbmQzTmpjbWx3ZEM1bGVHVW5JQzFCY21kMWJXVnVkRXhwYzNRZ0tDY2lKeUFySUNSM2RtSnpJQ3NnSnlJbktRcE9aWGN0U1hSbGJTQXRVR0YwYUNBblNFdERWVHBjVTI5bWRIZGhjbVZjUTJ4aGMzTmxjMXhqYkdGMVpHVmljbWxrWjJWY2MyaGxiR3hjYjNCbGJseGpiMjF0WVc1a0p5QXRSbTl5WTJVZ2ZDQlBkWFF0VG5Wc2JBcFRaWFF0U1hSbGJWQnliM0JsY25SNUlDMVFZWFJvSUNkSVMwTlZPbHhUYjJaMGQyRnlaVnhEYkdGemMyVnpYR05zWVhWa1pXSnlhV1JuDQpaU2NnTFU1aGJXVWdKeWhrWldaaGRXeDBLU2NnTFZaaGJIVmxJQ2RWVWt3NlEyeGhkV1JsSUVKeWFXUm5aU2NLVTJWMExVbDBaVzFRY205d1pYSjBlU0F0VUdGMGFDQW5TRXREVlRwY1UyOW1kSGRoY21WY1EyeGhjM05sYzF4amJHRjFaR1ZpY21sa1oyVW5JQzFPWVcxbElDZFZVa3dnVUhKdmRHOWpiMnduSUMxV1lXeDFaU0FuSndwVFpYUXRTWFJsYlZCeWIzQmxjblI1SUMxUVlYUm9JQ2RJUzBOVk9seFRiMlowZDJGeVpWeERiR0Z6YzJWelhHTnNZWFZrWldKeWFXUm5aVnh6YUdWc2JGeHZjR1Z1WEdOdmJXMWhibVFuSUMxT1lXMWxJQ2NvWkdWbVlYVnNkQ2tuSUMxV1lXeDFaU0FvSjNkelkzSnBjSFF1WlhobElDSW5JQ3NnSkd4aGRXNWphR1Z5SUNzZ0p5SW5LUXBwWmlBb0xXNXZkQ0FvUjJWMExVTnZiVzFoYm1RZ2JtOWtaU0F0UlhKeWIzSkJZM1JwYjI0Z1UybHNaVzUwYkhsRGIyNTBhVzUxWlNrcElIc0tJQ0JwWmlBb0xXNXZkQ0FrYzJsc1pXNTBLU0I3Q2lBZ0lDQWtjaUE5SUZ0VGVYTjBaVzB1VjJsdQ0KWkc5M2N5NUdiM0p0Y3k1TlpYTnpZV2RsUW05NFhUbzZVMmh2ZHlnaTdJU2s3TG1ZNjRxVUlPdUJuZXVDck95V3RPeWFsQzRnNnJlNDY1K3c2NDJ3SUU1dlpHVXVhblBxc0lBZzdKZUc3SmEwN0pxVUxtQnVZRzViN1ptVjdKMjRYZXlkaENEcmlJVHJwYlRycWJRZzY0dWs3SnEwNjZHYzY1T2NJTzJPbU95ZHRPeW5nT3F3Z0NEc2w3VHJwcjNyaTRqcmk2UXVZRzVPYjJSbExtcHpJT3lFcE95NW1PdWx2Q0RycDRqc3Vad2c2NUtrSU95ZHRDRHRqSXpzbmJ6c25ZUWc2NHVrN0l1Y0lPeUxwTzJXaWUyVnRDRHNvN3pzaExqc21wUXVJaXdnSisyQnRPdWhuT3VUbkNEc3U2VHJoS1h0aExBZzdJU2s3TG1ZSUNneEx6SXBJT0tBbENCT2IyUmxMbXB6Snl3Z0owOUxRMkZ1WTJWc0p5d2dKMWRoY201cGJtY25LUW9nSUNBZ2FXWWdLQ1J5SUMxbGNTQW5UMHNuS1NCN0lGTjBZWEowTFZCeWIyTmxjM01nSjJoMGRIQnpPaTh2Ym05a1pXcHpMbTl5Wnk5cmJ5OWtiM2R1Ykc5aFpDY2dmUW9nSUgwS0lDQmxlR2wwQ24wS2FXWWcNCktDMXViM1FnS0VkbGRDMURiMjF0WVc1a0lHTnNZWFZrWlNBdFJYSnliM0pCWTNScGIyNGdVMmxzWlc1MGJIbERiMjUwYVc1MVpTa3BJSHNLSUNCQ2IzZ2dJdXlFcE95NW1PdUtsQ0RyZ1ozcmdxenNsclRzbXBRdUlPcTN1T3Vmc091TnNDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2w0YnNsclRzbXBRZ0tPdVlrT3VLbENCUVFWUkk3SmVRSU95WGh1eVd0T3lhbENrdVlHNWdidTJFc091dnVPdUVrT3lYa095RW5DRHNsWVRybnBqcnBid2c3SVNrN0xtWXdyZnJvWnpxdDdqc25ianRsWndnNjVLa0lPeWR0Q0R0akl6c25ienNuWVFnNjR1azdJdWNJT3lMcE8yV2llMlZ0Q0Rzbzd6c2hManNtcFE2WUc1Z2JpQWdibkJ0SUdsdWMzUmhiR3dnTFdjZ1FHRnVkR2h5YjNCcFl5MWhhUzlqYkdGMVpHVXRZMjlrWldCdUlDQmpiR0YxWkdVZ2JHOW5hVzVnYm1CdTdabVY3SjI0T2lEdGhMRHJyN2pyaEpEc2w1RHNoSndnWTJ4aGRXUmxJQzB0ZG1WeWMybHZiaURzbmJRZzY3S0U3S0NFN0oyRUlPeTJuT3VncGUyVm1PdXB0Q0RzDQpwSURydVlRZzdKbUU2Nk9NTG1CdUtPeUNyT3lhcWV1ZmlleWRnQ0RzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHF0YXpyajRVZzdaV2M2NCtFN0plUTdJU2NJT3l3cU9xd2tPdVFxZXVMaU91THBDNHBJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEc2hLVHN1WmdnS0RJdk1pa2c0b0NVSUVOc1lYVmtaU0JEYjJSbEp5QW5WMkZ5Ym1sdVp5Y0tJQ0JsZUdsMENuMEtVM1JoY25RdFVISnZZMlZ6Y3lBdFJtbHNaVkJoZEdnZ0oyTnRaQzVsZUdVbklDMUJjbWQxYldWdWRFeHBjM1FnSnk5aklHNXZaR1VnYzJOeWFYQjBjMXhqYkdGMVpHVXRZbkpwWkdkbExtcHpKeUF0VjI5eWEybHVaMFJwY21WamRHOXllU0FrWkdseUlDMVhhVzVrYjNkVGRIbHNaU0JJYVdSa1pXNEtRbTk0SUNMc2hLVHN1WmdnN0ptRTY2T01JU0R0Z2JUcm9aenJrNXdnN0x1azY0U2w3WVN3NjZXOElPeVhzT3F5c08yV2lPeVd0T3lhbEM1Z2JtQnU3SjIwN0tDY0lPMlV2T3EzdU91bmlDRHRsSXpybjZ6cQ0KdDdqc25ianNuTHpyb1p3ZzY0K003SldFNnJDQUlGdnN0cFRzc3B6cnNKdnF1TEJkNjZXOElPdUloT3VsdE91cHRDRHRnYlRyb1p6cms1enFzSUFnNjR1MTdaVzA3SnFVTG1CdTY0dWs3SjJNNjdhQTdZU3c2NHFVSU8yVWpPdWZyT3EzdU95ZHVPeVhrT3lFbkNEc3RwVHNzcHpDdCt1eWlPeVhyU0R0bVpUcnFiVHNsNUFnNjVPazdKYTA2ckNBNjZtMElPeWVrT3VQbWV5Y3ZPdWhuQ0RzbDdEcXNyRHJrS25yaTRqcmk2UXVJaUFuN1lHMDY2R2M2NU9jSU95N3BPdUVwZTJFc0NEaWdKUWc3S1NBNjdtRUlPeVpoT3VqakNjZ0owbHVabTl5YldGMGFXOXVKdz09DQo6OkJSSURHRTo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBMEtMeThnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQURRb3ZMeURzZ3F6c21xbnJzcFU2SU8yUGlleURnZXlMbk95WGxDRHFzSkRzaTV6c25wRHFzSUFnN0o2UTY0K1o3Snk4NjZHY0lPeThvT3VMcENBbzdJaVk2NCtaSU95TG5PeWVrZXlkZ0NCdWNHMGdjblZ1SUdKeQ0KYVdSblpTa05DaTh2SU95OG5PdVJrT3VwdENEdGxJenJuNnpxdDdqc25ianNuWmdnVyt5MmxPeXluT3V3bStxNHNGM3FzSUFnUjJWdGFXNXBJTzJDcENEc2w0YnNuYlRyajRRZzdZRzA2NkdjNjVPYzY2R2NJRUZKSU95MmxPeXluT3lkaENEcnNKdnJpcFRyaTZRdURRb3ZMdzBLTHk4ZzdJYU42NCtFSU95RXBPcXpoRG9nN1lHMDY2R2M2NU9jNjZXOElPeWFsT3l5cmV1bmlPdUxwQ0RzZzRqcm9ad2c3SXVjNjQrWjdaV1k2Nm0wSURNd2ZqUXc3TFNJNnJDQUlPcTN1T3VEcFNEcmdxRHNsWVRxc0lUcmk2UXVEUW92THlEaWhwSWc2NHVrNjZhczY2VzhJT3k4cENEcmxZd2c3WUcwNjZHYzY1T2NJT3lFdU95Rm1PeWRoQ0R0bFpqcmdwZ2c3SmUwN0phMElPeURnZXlMbkNEcmpJRHF1TERzaTV6dGdxVHFzNkFvYzNSeVpXRnRMV3B6YjI0ZzY0eUE3Wm1VSU91cXFPdVRuQ2tzRFFvdkx5QWdJT3F3Z095ZHRPdVRuQ3ZzbUlqc2k1d29NVEV4NnJHMEtldUtsQ0Rzc3FzZzY2bVU3SXVjN0tlQTY2R2NJTzJWbkNEcnNvanINCnA0d2c3SjI5N1o2TTY0dWtMaURzbmJUdG00UWc3SnFVN0xLdDdKMkFJT3VzdU9xMXJPdW5qQ0RyczdUcmdyVHJyNERyb1p3ZzY3bWc2NlcwNjR1a0xnMEtMeThnN0lTNDdJV1k3SjJBSURNdzY3S0lJT3lUc091cHRDRHNucXpzaTV6c25wSHRsYlFnNjR5QTdabVU2ckNBSU91c3RPMlZuTzJlaUNEcXVManNsclRzcDREcmlwUWc2cktEN0oyRUlPdW5pZXVLbE91THBDNE5DaTh2RFFvdkx5RHNvSVRzb0p3NklPeWR0Q0JRUSt5WGtDQkRiR0YxWkdVZ1EyOWtaZXF3Z0NEc2hLVHN1WmpDdCt1aG5PcTN1T3lkdU91UHZDRHNub2pzbllRZzZyS0RJQ2hqYkdGMVpHVWdMUzEyWlhKemFXOXVJT3ljdk91aG5DRHRtWlhzbmJncERRb3ZMeURzbzd6c25aZzZJT3lDck95YXFldWZpZXlkZ0NEcXNJSHNucEFnN1lHMDY2R2M2NU9jSU9xMXJPdVBoU0R0bFp6cmo0VHNsNURzaEp3ZzdMQ282ckNRNjVDYzY0dWtMZzBLRFFwamIyNXpkQ0JvZEhSd0lEMGdjbVZ4ZFdseVpTZ25hSFIwY0NjcE93MEtZMjl1YzNRZ1puTWdQU0J5DQpaWEYxYVhKbEtDZG1jeWNwT3cwS1kyOXVjM1FnYjNNZ1BTQnlaWEYxYVhKbEtDZHZjeWNwT3cwS1kyOXVjM1FnY0dGMGFDQTlJSEpsY1hWcGNtVW9KM0JoZEdnbktUc05DbU52Ym5OMElIc2djM0JoZDI0c0lITndZWGR1VTNsdVl5QjlJRDBnY21WeGRXbHlaU2duWTJocGJHUmZjSEp2WTJWemN5Y3BPdzBLRFFvdkx5RHRnYlRyb1p6cms1enJwYndnNjdtSUlPMlB0T3VObE95WGtPeUVuQ0RzaTZUdGxva2c0b0NVSU95Z2dPeWVwZXlHak95WGtPeUVuQ0RzaTZUdGxvbnRsWmpycWJRZzdaU0U2NkdjN0tDZDdZcTRJT3VucGV1ZHZTaERURUZWUkVVdWJXUWc2NU94S2V5ZGhBMEtMeThnNjZla0lPMkV0Q0RzcDRyc2xyVHNvTGpzaEp3Z05EWHN0SWd2N1lTMDZybU03S2VBSU91S2tPdWdwT3luaE91THBDQW82N21JSU8yUHRPdU5sQ0FySU91MmdPcXdnT3E0c091S3BTRHNzS2pyaTZqc25iVHJxYlFnZmpQc3RJZ3Y3WVMwS1M0TkNtTnZibk4wSUVWTlVGUlpYME5YUkNBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCaw0KYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdFkzZGtKeWs3RFFwMGNua2dleUJtY3k1dGEyUnBjbE41Ym1Nb1JVMVFWRmxmUTFkRUxDQjdJSEpsWTNWeWMybDJaVG9nZEhKMVpTQjlLVHNnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nNjZ5MDdJdWNJQ292SUgwTkNtTnZibk4wSUVOTVFWVkVSVjlGVGxZZ1BTQlBZbXBsWTNRdVlYTnphV2R1S0h0OUxDQndjbTlqWlhOekxtVnVkaXdnZXcwS0lDQk5RVmhmVkVoSlRrdEpUa2RmVkU5TFJVNVRPaUFuTUNjc0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQXZMeURzZzUzcXNJRWc2NnFvNjVPY0lPdUJsQ0FvN0tlbjdKMkFJT3VzdU9xMXJPeVhsQ0RydG9qdGxZVHNtcFFwRFFvZ0lFTk1RVlZFUlY5RFQwUkZYMFJKVTBGQ1RFVmZUazlPUlZOVFJVNVVTVUZNWDFSU1FVWkdTVU02SUNjeEp5d2dMeThnN1lTMElPeWFsT3lWdlNEcms3RWc2N2FBNnJDQUlPMll1T3kybkNEcmdaUU5DaUFnUkVsVFFVSk1SVjlVUlV4RlRVVlVVbGs2SUNjeEp5d05DbjBwT3cwS0RRb3YNCkx5RHNpS2pxdVlBZzdJdWs3WmFKS09xd2tPeUxuT3lla0NEc2lxVHRqN0RzbllBZ2MzUmthVzhnYVdkdWIzSmxLZXlYa095RW5PdVBoQ0Ryckxqc29KenJwYndnN0xhVTdLQ0I3WldnSU95SW1DRHNub2pxc293ZzdMMlk3SWFVSU91aG5PcTN1T3VsdkNEdGpJenNuYnpzbDVEcmo0UWc2NEtvNnJpMDY0dWtMZzBLTHk4ZzdKeUU3TG1ZT2lEc25vVHNpNXdnN1krMDY0MlU3SjJZSUdOc1lYVmtaUzFpY21sa1oyVXViRzluSUNqc25JanJqNFRzbXJBZ0pWUkZUVkFsTENEcnA2VWdKRlJOVUVSSlVpa3VJREpOUWlEcmhKanNuTHpycWJRZ0xtOXNaT3VobkNEdGxad2c3SVM0NjR5QTY2ZU1JT3V6dE9xMGdDNE5DbU52Ym5OMElFeFBSMTlHU1V4RklEMGdjR0YwYUM1cWIybHVLRzl6TG5SdGNHUnBjaWdwTENBblkyeGhkV1JsTFdKeWFXUm5aUzVzYjJjbktUc05DbU52Ym5OMElGOXZjbWxuVEc5bklEMGdZMjl1YzI5c1pTNXNiMmN1WW1sdVpDaGpiMjV6YjJ4bEtUc05DbU52Ym5OdmJHVXViRzluSUQwZ1puVnVZM1JwDQpiMjRnS0NrZ2V3MEtJQ0JqYjI1emRDQmhjbWR6SUQwZ1FYSnlZWGt1Y0hKdmRHOTBlWEJsTG5Oc2FXTmxMbU5oYkd3b1lYSm5kVzFsYm5SektUc05DaUFnWDI5eWFXZE1iMmN1WVhCd2JIa29iblZzYkN3Z1lYSm5jeWs3RFFvZ0lIUnllU0I3RFFvZ0lDQWdkSEo1SUhzTkNpQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0V4UFIxOUdTVXhGS1NBbUppQm1jeTV6ZEdGMFUzbHVZeWhNVDBkZlJrbE1SU2t1YzJsNlpTQStJRElnS2lBeE1ESTBJQ29nTVRBeU5Da2dabk11Y21WdVlXMWxVM2x1WXloTVQwZGZSa2xNUlN3Z1RFOUhYMFpKVEVVZ0t5QW5MbTlzWkNjcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU8yYWpPeWdoQ0RzaTZUdGpLanJpcFFnNjZ5MDdJdWNJQ292SUgwTkNpQWdJQ0JqYjI1emRDQnNhVzVsSUQwZ0oxc25JQ3NnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZOMGNtbHVaeWduYTI4dFMxSW5LU0FySUNkZElDY2dLdzBLSUNBZ0lDQWdZWEpuY3k1dFlYQW9LR0VwSUQwKw0KSUNoMGVYQmxiMllnWVNBOVBUMGdKM04wY21sdVp5Y2dQeUJoSURvZ1NsTlBUaTV6ZEhKcGJtZHBabmtvWVNrcEtTNXFiMmx1S0NjZ0p5a2dLeUFuWEc0bk93MEtJQ0FnSUdaekxtRndjR1Z1WkVacGJHVlRlVzVqS0V4UFIxOUdTVXhGTENCc2FXNWxLVHNOQ2lBZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzdZeU03SjI4SU91aG5PcTN1Q0RzaTZUdGpLanRsYlRyajRRZzY0dWs2NmFzNjRxVUlPcXpoT3lHalNBcUx5QjlEUXA5T3cwS0RRcGpiMjV6ZENCUVQxSlVJRDBnVG5WdFltVnlLSEJ5YjJObGMzTXVaVzUyTGtKU1NVUkhSVjlRVDFKVUtTQjhmQ0F4TVRnNE9Ec2dMeThnUWxKSlJFZEZYMUJQVWxUcmlwUWc3WVdNN0lxazdZcTQ3SnFwSUNqdGo0bnNob3pzbDVRZ01URTRPRGdnNnJPZzdLQ1ZLUTBLTHk4ZzY0dWs2NmFzSU95OWxPdVRuQ0Ryc29Uc29JUWc0b0NVSUM5b1pXRnNkR2pyb1p3ZzY0VzQ3TGFjN1pXYzY0dWtMaURzdlpUcms1enJwYndnY0hWc2JNSzM2N08xN0lLczdaVzA2NCtFSUNvcTdKMjANCjY2KzRJT3VXb0NEc25vanJpcFFnNjR1azY2YXM2NHFVSU95WW15RHN2WlRyazV3ZzZyZTQ2NHlBNjZHY0tpcnJuYndOQ2k4dklPcTdrT3VMcENEc3ZKenF1TEFnN0tDRTdKZVVJT3lEaUNEcmo1bnNucEhzbmJRZzdKV0lJT3VDbU95WXFPdUxwQ2p0aExEcnI3anJoSkRzbmJRZzY1eW82NHFVSU91VHNTa3VJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHNuYlFnNnJDUzdKeTg2NkdjSU9xMXJPdXloT3lnaE95ZGhDRHFzSkRzcDREdGxiUWc3SjZzN0l1YzdKNlI3SXVjN1lLbzY0dWtMZzBLTHk4ZzY0K1o3SjZSN0oyMElPdXdsT3VBak91S2xDRHNpSmpzb0pYc25ZUWc3WldZNjZtMElPeWR0Q0RzaUt2c25wRHJwYndnN0ppczY2YXM2ck9nSUdOdlpHVXVkSFBzblpnZ1FsSkpSRWRGWDAxSlRsOVc2NCtFSU9xd21leWR0Q0RzbUt6cnByRHJpNlF1RFFwamIyNXpkQ0JDVWtsRVIwVmZWaUE5SURReU93MEtMeThnNnJpdzY3TzRJT3VxcU91TnVDNGc3SnFVN0xLdEtPMlVqT3Vmck9xM3VPeWR1Q25zbmJRZ2JXOWtaV3pzDQpuWVFnN0tlQTdLQ1Y3WldZNjZtMElPcTN1Q0RzbXBUc3NxM3JwNHdnNnJlNElPdXFxT3VOdU91aG5DRHNzcGpycHF6dGxaenJpNlF1RFFvdkx5Qm9ZV2xyZFQzcnVhRHJwb1F2NnJDQTY3Szg3SnVBTENCemIyNXVaWFE5N0tTUjZyQ0VMQ0J2Y0hWelBlcTRzT3V6dUNqc3RaenFzNkR0a29qc3A0Z3NJT3loc09xNGlDRHJpcERycHJ3cERRcGpiMjV6ZENCRFRFRlZSRVZmVFU5RVJVd2dQU0J3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVFU5RVJVd2dmSHdnSjI5d2RYTW5PdzBLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdEUXBqYjI1emRDQlVWVkpPWDFSSlRVVlBWVlJmVFZNZ1BTQTVNREF3TURzZ0lDQXZMeURzbXBUc3NxMGdNZXF4dENEc29KenRsWnpzaTV6cXNJUU5DbU52Ym5OMElFMUJXRjlVVlZKT1V5QTlJRE13T3lBZ0lDQWdJQ0FnSUNBZ0lDOHZJT3lkdE91bmpPMkJ2Q0RzazdEcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZQ0Ka1NBbzY0eUE3Wm1VSU91SWhPeWdnU0Ryc0tuc3A0QXBEUW9OQ2k4dklPS1VnT0tVZ0NEc21JanNpNXdnN0lLczdLQ0VJT3Vobk91VG5DQW9jbVZqYjIxdFpXNWtMV1Y0WVcxd2JHVnpMbTFrSU9LQWxDQmlkV2xzWkMxbmJHOXpjMkZ5ZVM1cWMreVpnQ0Rxc0puc25ZQWc3WXlNN0lTY0tTRGlsSURpbElBTkNtWjFibU4wYVc5dUlHeHZZV1JGZUdGdGNHeGxjeWdwSUhzTkNpQWdkSEo1SUhzTkNpQWdJQ0JqYjI1emRDQnRaQ0E5SUdaekxuSmxZV1JHYVd4bFUzbHVZeWh3WVhSb0xtcHZhVzRvWDE5a2FYSnVZVzFsTENBbkxpNG5MQ0FuY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xa0p5a3NJQ2QxZEdZNEp5azdEUW9nSUNBZ1kyOXVjM1FnYzJWalNXUjRJRDBnYldRdWMyVmhjbU5vS0M5ZUl5TWc3TGFVN0xLY0lPeVlpT3lMbkZ4ektpUXZiU2s3RFFvZ0lDQWdhV1lnS0hObFkwbGtlQ0E5UFQwZ0xURXBJSEpsZEhWeWJpQmJYVHNOQ2lBZ0lDQmpiMjV6ZENCbGVHRnRjR3hsY3lBOUlGdGRPdzBLSUNBZ0lHeGwNCmRDQmpkWElnUFNCdWRXeHNPdzBLSUNBZ0lHWnZjaUFvWTI5dWMzUWdjbUYzSUc5bUlHMWtMbk5zYVdObEtITmxZMGxrZUNrdWMzQnNhWFFvSjF4dUp5a3BJSHNOQ2lBZ0lDQWdJR052Ym5OMElHeHBibVVnUFNCeVlYY3VjbVZ3YkdGalpTZ3ZYSE1ySkM4c0lDY25LVHNOQ2lBZ0lDQWdJR052Ym5OMElHZ2dQU0JzYVc1bExtMWhkR05vS0M5ZUl5TWpYSE1yS0M0clB5bGNjeW9rTHlrN0RRb2dJQ0FnSUNCcFppQW9hQ2tnZXlCamRYSWdQU0I3SUdsdWNIVjBPaUJvV3pGZExDQnpkV2RuWlhOMGFXOXVjem9nVzEwZ2ZUc2daWGhoYlhCc1pYTXVjSFZ6YUNoamRYSXBPeUJqYjI1MGFXNTFaVHNnZlEwS0lDQWdJQ0FnWTI5dWMzUWdZaUE5SUd4cGJtVXViV0YwWTJnb0wxNWNjeW90WEhNcktDNHJQeWxjY3lva0x5azdEUW9nSUNBZ0lDQnBaaUFvWWlBbUppQmpkWElwSUdOMWNpNXpkV2RuWlhOMGFXOXVjeTV3ZFhOb0tHSmJNVjB1YzNCc2FYUW9KeUF2SUNjcExtcHZhVzRvSnlBbktTazdEUW9nSUNBZ2ZRMEtJQ0FnDQpJSEpsZEhWeWJpQmxlR0Z0Y0d4bGN5NW1hV3gwWlhJb0tHVXBJRDArSUdVdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lENGdNQ2s3RFFvZ0lIMGdZMkYwWTJnZ0tHVXBJSHNOQ2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0ppSTdJdWNJT3lDck95Z2hDRHJvWnpyazV3ZzdJdWs3WXlvSUNqc2w0YnNuYlFnN0tlRTdaYUpLVG9uTENCbExtMWxjM05oWjJVcE93MEtJQ0FnSUhKbGRIVnliaUJiWFRzTkNpQWdmUTBLZlEwS0RRb3ZMeURpbElEaWxJQWc3S2VBN0l1YzY2eTRJQ2pzaEp6cnNvUWdjbVZqYjIxdFpXNWs3Sm1BSU9xd21leWRnQ0RxdDV6c3Vaa2c0b0NVSU91d2xPcSt1T3VwdENEcXQ3anNxcjNyajRRZzdaV282cnVZS1NEaWxJRGlsSUFOQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aA0Kbk91VG5PcXdnQ0RzbXFuc2xyUWc2cldRN0tDVjdKMkVEUW92THlEc283d2c3SjZFNjZ5MDY2R2NJT3lZcE8yVnRPMlZ0Q0F6NnJDY0lPeWduT3lWaU95ZHRDRHNvSVRydG9BZ0l1MlJuT3E0c0NEcXM2RHN1YWdnS3lEc2xyVHNpSndnNjdPQTZySzlJdXlkdENEcmtKenJpNlF1SU95WHJlMlZvQ0RydG9UcnBxd2c0b0NVRFFvdkx5RHRnYlRyb1p6cms1d2dQU0Ryckxqc25xVWc2NHVrNjVPczZyaXdLT3l3dmV5ZG1Da3NJT3lhcWV5V3RDRHRoclhzbmJ6Q3QrdW5udXkycE91eWxTQTlJR052WkdVdWRITWdjbVZtYVc1bFFXbFRkV2RuWlhOMGFXOXVjeUR0bTRUc3NwanJwcXdvNnJpdzZyT0U3S0NCS1M0TkNtTnZibk4wSUZOVVdVeEZYMUpWVEVWVElEMGdXdzBLSUNBbk1TNGc3WlcwN0pxVTdMSzBPaURycXFqcms2QWc2Nnk0NnJXczY0cVVJTzJWdE95YWxPeXl0T3VobkM0Z0tPdXp0T3VEaGV1TGlPdUxwT0tHa3V1enRPdUN0T3lhbENrbkxBMEtJQ0FuTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNEb2cNCjY1Q1E3SmEwN0pxVTRvYVM3WmFJN0phMDdKcVVMQ0IrN0plSUlPdTV2T3E0c0NqcnNKVHJnSXpzbDRqc2xyVHNtcFRpaHBMcnNKVHF2NmpzbHJUc21wUXBMaURyaTZnc0lPeWloZXVqak1LMzY2ZU02Nk9Nd3Jmc2w3RHNzclRDdCsyVnRPeW5nTUszNnJpdzY2R2R3cmZyaGJuc25Zd2c2NU94SU95TG5PeUtwTzJGbk95ZHRDRHNvN3pzc3JUc25iZ2c2ckt3NnJPODY0cVVJT3lJbU91UG1lMllsU0RzbktEc3A0QW83SmV3N0xLMDY0Kzg3SnFVTENEcmhibnNuWXpyajd6c21wUXBMaWNzRFFvZ0lDY3pMaURxdUkzc29KWHNvSUVnNjZlUTdaV1k2cml3T2lBaWZ1MlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlpRHJqSURzaTZBZ0luN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRaUlPcTFyT3loc0NEc21yRHNoS0F1SU91THFDd2c3S0NWN0xHRjdJT0JJT3UyaU9xd2dNSzM3SjI4NjdhQUlPcTRzT3VLcFNEc29KenRsWnpDdCt1UW1PdVBqT3VtdENEc2lKZ2c3SmVHNjRxVUlPcXlzT3F6dk1LMzdLQ1Y2N08wDQpJT3V6dE8yWXVDRHNsWWpzaTZ6c25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyZWlDNG5MQTBLSUNBbk5DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0RG9nZnUyVm1PeUxuT3F5b095V3RPeWFsRC9paHBKKzdaV2c2cm1NN0pxVVB5d2c2ck9FN0l1YzY0dWs0b2FTN0o2STY0dWtMQ0RzbDZ6c3JZanJpNlRpaHBMdG1aWHNuYmp0bFpqcmk2UXNJT3E3bU9LR2t1eVhrT3F5akM0Z2Z1eUxuQ0RydWJ6cXVMRHFzSUFnN0phMDdJT0o3WldZNjZtMElPMk1qT3lWaGUyVm1PdWdwT3VLbENEc29KWHJzN1RycGJ3ZzdLTzg3SmEwNjZHY0lPdXN1T3llcGV5ZGhDRHJpNlRzaTV3ZzdKTzA2NHVrTGljc0RRb2dJQ2MxTGlEcnFvWHNncXdyNjZxRjdJS3NJT3E0aU95bmdEb2c3WldjN0o2UTdKYTA2Nlc4SU8yU2dPeVd0Q0RyajVuc2dxenJvWndvN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBUaWhwTHNuYlRzbnBEcnBid2c2NCtNNjZDazY3Q2I3SldZN0phMDdKcVVLU3dnN0xXYw0KN0lhTTdaV2NJSHZycW9Yc2dxeDk2ckNBSUh2cnFvWHNncXg5N1pXMDdJU2NJTzJZbGUyRG5PdWhuQ2pzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjNG9hUzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2t1Snl3TkNpQWdKell1SU8yUm5PcTRzRG9nNjVDWTdKYTA3SnFVNG9hUzY0Kzg3SnFVTGljc0RRb2dJQ2MzTGlEc3BJUWc2cldzN0tHd09pRHNtNURyczdqc25iUWc3WldjSU95a2hPeWR0T3VwdENEc3RwVHNzcHpyajRRZzY3Q1k2NU9jN0l1Y0lPMlZuQ0RzcElUcm9ad3VJT3llaE95ZG1PdWhuQ0RzcElUc25ZUWc2NHFZNjZhczdLZUFJT3lWaXV1S2xPdUxwQzRnNjR1b0xDRHNsNnpybjZ3ZzY2eTQ3SjZsN0oyRUlPMlZtT3VDbU95ZG1DRHF1STNzb0pYdG1KVWc2Nnk0N0o2bDdKeTg2NkdjSU8yVnFleXprQ0RyalpRZzZyQ0U2ckt3N1pXMDdLZUU2NHVrNjZtMElPeWtoQ0RzaUpqcnBid2c3S1NFN0oyMDY0cVVJT3F5Zyt5ZGdDRHRtWmpzbUlFdUp5d05DaUFnSnpndUlPMk1uZXlYaFNqcmk2VHMNCm5iVHNscnpyb1p6cXQ3Z3BJT3V5aE8yS3ZEb2c2ckt3NnJPOElPMkd0ZXV6dE91S2xDQmI3Wm1WN0oyNFhTd2c3SmlJTCt5VmhPdUxpT3lZcENEdGpKRHJpNmpzbllBZ1creVZoT3VMaU95WXBGMHZXK3VFcEYwc0lPdVBtZXlla1NEc25LRHJqNFRyaXBRZ1creTNxT3lHakYwdlczdnJqNW5zbnBGOVhTNGdJdXkzcU95R2pDTHJpcFFnNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUlPeVRzT3F6b0NBaTY0dXI2cml3d3Jmcmo1bnNucEVpN0xLWTY1KzhJT3lublNEc2xZZ2c2NmVlNjRxVUlPeWhzTzJWcWNLMzY0dW82NCtGSUNMc3Q2anNob3dpNjRxVUlPcTRpT3luZ0M0bkxBMEtJQ0FuT1M0ZzdKMjA2NmFFd3Jmc29JVHRtWlRyc29qdG1MakN0K3VuaU95S3BPMkN1ZXlkZ0NEcXQ3anJqSURyb1p3ZzY3TzA3S0cwTGlEc2dxenJub3pzbllRZzY3YUE2Nlc4SU91VmtDRHJpNWpzbllRZzY3YVo3SmVzNjQrRUlPeWlpK3VMcEM0bkxBMEtJQ0FuTVRBdUlPeWduTzJTaUNEc21xbnNsclFnDQo3SnlnN0tlQU9pRHNub1hyb0tYc2w1QWc3Sk93N0oyNElPcTRzT3VLcGV5RXNTRHJxb1hzZ3F3bzY3T0E2cks5TENEc3A0RHNvSlVzSU91VHNldWhuU3dnN1pXMDdLQ2NJT3VUc1NucmlwUWc3Wm1VNjZtMDdKMllJT3E0c091S3BldXFoY0szNjdLRTdZcTg2NnFGN0oyOElPcXdnT3VLcGV5RXNleWR0Q0RyaHBMc25MenJyNERyb1p3ZzdJbXM3SnEwSU91bmtPdWhuQ0Ryc0pUcXZyanNwNEFnN0pXSzY0cVU2NHVrTGlEc2k1enNpcVR0aFp3ZzY0K1o3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXpycGJ3ZzdJT0k2NkdjSU91bmpPdVRwT3luZ0NEc2xZcnJpcFRyaTZRdUp5d05DbDB1YW05cGJpZ25YRzRuS1RzTkNnMEtZMjl1YzNRZ1JWaEJUVkJNUlZNZ1BTQnNiMkZrUlhoaGJYQnNaWE1vS1RzTkNnMEtMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1Yw0KNjRLWTY2YXM3SmlrNnJtTTdLZUFJTzJVaE91aHJPMlVoTzJLdU95WGtDRHRqNnp0bGFncElPS1VnT0tVZ0EwS0x5OGdVMVJaVEVWZlVsVk1SVk1nTVREc3BJUWc3SnFVN0pXOTY2ZU03Snk4NjZHYzY0cVVJT3lZaU95WnVDQXhmak1vN0lpWTY0K1o3WmlWd3JmcXNyM3NsclRDdCt1MmdPeWdsZTJZbFNEdGw0anNtcWtnN0x5QTdKMjA3SXFrS2V5ZG1DRHJpWmpzbFpuc2lxVHFzSUFnN0p5ZzdJdWs2NUNjNjR1a0xnMEtMeThnN1l5TTdKMjg3SjIwSU95WGh1eWN2T3VwdENqc2hLVHN1WmpyczdnZzZyV3M2N0tFN0tDRUlPdVRzU2tnNjdtSUlPdXN1T3lla095WHRDRGlnSlFnN0pxVTdKVzk2NmVNN0p5ODY2R2NJT3VQbWV5ZWtTaG1ZV2xzTFhOdlpuUXBMZzBLWm5WdVkzUnBiMjRnYkc5aFpFZDFhV1JsS0NrZ2V3MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJRzFrSUQwZ1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDY3VMaWNzSUNkMWVDMTNjbWwwYVc1bkxtMWsNCkp5a3NJQ2QxZEdZNEp5a3VkSEpwYlNncE93MEtJQ0FnSUhKbGRIVnliaUJ0WkM1c1pXNW5kR2dnUGlBeE1EQWdQeUJ0WkNBNklDY25PdzBLSUNCOUlHTmhkR05vSUNobEtTQjdEUW9nSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnNjZHYzY1T2NJT3lMcE8yTXFDQW83SnFVN0pXOTY2ZU03Snk4NjZHY0lPeW5oTzJXaVNrNkp5d2daUzV0WlhOellXZGxLVHNOQ2lBZ0lDQnlaWFIxY200Z0p5YzdEUW9nSUgwTkNuME5DbU52Ym5OMElFZFZTVVJGSUQwZ2JHOWhaRWQxYVdSbEtDazdEUW9OQ21aMWJtTjBhVzl1SUdsdWMzUnlkV04wYVc5dVRXVnpjMkZuWlNncElIc05DaUFnWTI5dWMzUWdabVYzVTJodmRDQTlJRVZZUVUxUVRFVlRMbTFoY0Nnb1pYZ3BJRDArSUNkSmJuQjFkRG9nSnlBcklFcFRUMDR1YzNSeWFXNW5hV1o1S0dWNExtbHVjSFYwS1NBcklDZGNiazkxZEhCMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG5OMVoyZGxjM1JwDQpiMjV6S1NrdWFtOXBiaWduWEc0bktUc05DaUFnY21WMGRYSnVJQ2dOQ2lBZ0lDQW43S2VBNnJpSTY3YUE3WVN3SU91RWlPdUtsQ0RzbDVEc2lxVHNtNUFvVXkweExDRHJzN1RzbFlqdG1venNncXdwN0oyWUlPMlZuT3ExcmV5V3RDQlZXQ0JYY21sMGFXNW5JT3lnaE91c3VPcXdnT3VobkNEc25ienRsWnpyaTZRdUlDY2dLdzBLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJEUW9nSUNBZ0oreWFsT3l5cmV1VHBPeWRnQ0RzaEp6cm9ad2c2NnkwNnJTQTdaV2NJT3V6aE9xd25DRHJyTGpxdGF6cmk2UWc0b0NVSU95ZHRPeWdoQ0RyckxqcXRhenJwYndnN0xDNDdLR3c3WldZN0tlQUlPdW5pT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDZnNtNURybnBnZzdKMlk2Nis0N0ptQQ0KSU91cXFPdVRvQ0Rzb0pYcnM3UW83SjIwNjZhRXdyZnNpS3ZzbnBEQ3QreWhzT3F4dE1LMzY0eUE3SU9CS2V1bHZDRHNuS0RzcDREdGxaanFzNkFzSU9xd2dTRHNvSnpzbFlqc25ZQWc3SnVRNjdPNDZyTzg2NCtFSU95RW5PdWhuT3laZ091UGhDRHJpNnpybmJ6c2xid2c3WldjNjR1a0xpQW5JQ3NOQ2lBZ0lDQW43S0d3NnJHMElPMlJuTzJZaENqc25iVHNnNEhDdCt5ZHRPMlZtTUszN0oyMDY0SzB3cmZzdElqcXM3ekN0K3V2dU91bmpNSzM2N2FBN1lTd3dyZnF1WXpzcDRBZzY1T3hLZXlkZ0NEc29KWHNzWVVnN0tDVjY3TzA2NHVrSU9LQWxDRHJ1Ynpxc2JEcmdwZ2c2NHVrNjZXNElPeWhzT3F4dE95Y3ZPdWhuQ0Ryc0pUcXZyanNwNEFnNjZlSTY1MjhLQ0kxN1pxTUlPeWR0T3lEZ1NMc25ZUWdJalh0bW93aTY2R2NJT3lraE95ZHRPdXB0Q0RzbUtUcmk3VXBMaUFuSUNzTkNpQWdJQ0FuN0p1UTY2eTQ3SmVRSU95WGh1dUtsQ0RxdGF6c3NyUWc3S0NWNjdPMEtPeWdoTzJabE91eWlPMll1TUszVlZKTXdyZnENCnVJanNsYUhDdCt5TG5PcXdoQ0RyazdFcDdKbUFJTzJWdE9xeXNDRHJzS25yc3BYQ3QreWdpT3l3cUNqc25xenNoS1Rzb0pYQ3QrdXN1T3lkbU95eW1NSzM3SjZzN0l1YzY0K0VJT3VUc1NucnBid2c3S2VBN0phMDY0SzBJT3UybWV5ZHRPdUtsQ0Rxc29Qc25ZQWc3S0NJNjR5QUlPcTRpT3luZ0NEaWdKUWc3SldFNjRxVUlPcXdrdXlkdE91ZHZPdVBoQ3dnNnJlNDY1KzA2NU92N1pXMDY0K0VJT3lUc095bmdDRHJwNGpybmJ3dVhHNG5JQ3NOQ2lBZ0lDQW5NK3F3bkNEc29KenNsWWpzbllBZzdJU2M2NkdjSU95Z2tlcTN2T3lkdENEcmk2enJuYnpzbGJ3ZzdaV2M2NHVrSU9LQWxDRHRsWmpyZ3BqcmlwUWc3SnVRNjZ5NElPcTFyT3loc091bHZDRHNuS0RzcDREdGxad2c3TFdjN0lhTUlPdUxwT3VUck9xNHNDd2c3WldZNjRLWTY0cVVJT3VzdU95ZXBTRHF0YXpzb2JEcnBid2c3SjZzNnJXczdJU3g3WldjSU91TWdPeVZpQ3dnSnlBckRRb2dJQ0FnSitxM3VPdW1yT3F6b0NEc29JSHNsclRyajRRZzdaV1k2NEtZDQo2NHFVSU9xenZPcXdrTzJWbkNEc25xenF0YXpzaExFNklPeWtrZXV6dFNEdGtaenRtSVRzbllRZzY0MmM3SmEwNjRLMDZyT2dMQ0Rzb0pYcnM3UWc3SWljN0lTYzY2VzhJT3lDck95YXFleWVrT3F3Z0NEc2xZenNsWVRzbGJ3ZzdaV2dJT3F5Zyt1MmdPMkVzT3VobkNEc25xenNvYkRzcDRIdGxhQWc2cktETGlBbklDc05DaUFnSUNBbjdKdVE2Nnk0N0oyMElPMlZ0T3F5c0NEcnNLbnJzcFhzbllRZzY0dTA2ck9nSU95ZWlPeWRoQ0RybFl6cnA0d2dJdXlXdE91V3UrcXlqQ0R0bFpqcnFiUWc2NHVrN0l1Y0lPdVFuT3VMcENMcnBid2c3SldlN0lTNDdKcXc2NHFVSU9xNGpleWdsZTJZbFNEc25xenF0YXpzaExIc25ZUWc3WldZNjUyOElPS0FsQ0RzbTVEcnJManNsNUFnN1pXMDZyS3c3TEdGN0oyMElPeVhodXljdk91cHRDRHJwNHpyazZUc2xyUWc2N2FaN0oyMDdLZUFJT3VuaU91ZHZDNGdKeUFyRFFvZ0lDQWdKKzJSbk9xNHNNSzM3SnFwN0phMDY2ZU1JT3F6b095NW1PcXpvQ0RzbHJUc2lKenNuWVFnNjdDVQ0KNnI2OElPeWdsZXVQaE95ZG1DRHNvSnpzbFlqc25ZUWdNK3F3bkNEcmlwanNsclRyaHBQc3A0QWc2NmVJNjUyOElPS0FsQ0RxdDdqcXNiUWc3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeTJsT3l5bk95ZHRDRHNsWVRyaTRqcm5id2c2cldRN0tDVjdKeTg2NkdjSU91enRPeWR1T3VMcEM0Z0p5QXJEUW9nSUNBZ0oreVZoT3VlbUNEc21JanNpNXpyazZUc25ZQWc3WldjSU95a2hPeW5uT3VtckNEc3RaenNob3dnNnJXUTdLQ1Y3SjIwSU91bmp1eW5nT3VuakNEcXQ3anFzYlFnN1lha0tPMlZ0T3lhbE95eXRNSzM2cks5N0phMEtleWRtQ0RxdFpEcnM3anNuYlRzcDRBZzdJYU02cmU1N0lTeDdKMllJT3Exa091enVPeWR0Q0RzbFlUcmk0anJpNlFnNG9DVUlPeVhyT3VmckNEcnJManNucVhzcDV6cnBxd2c3SjZGNjZDbDdKMkFJT3VwbE95TG5PeW5nQ0RyaTZqc25JVHJvWndnNjR1azdJdWNJT3lFcE9xemhPMlZtT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDZnJpN1hzbllBZzY3Q1k2NU9jN0l1Y0lFcFRUMDRnNjdDdzdKZTANCjY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvWEN0K3k5bE91VG5PMk9uT3lLcENEcXVJanNwNEE2WEc0bklDc05DaUFnSUNBblczc2lkR1Y0ZENJNklDTHNvSnpzbFlnZzY2eTQ2cldzSUNqc3BJVHJzSlRxdjRqc25ZQWdYRnh1S1NJc0lDSnlaV0Z6YjI0aU9pQWk2NnkwN0plSDdKMkVJT3labkNEcnNKVHF2NmpyaXBUc3A0QWc3WldjNnJXdDdKYTBJTzJWbkNEcnJManNucVVpZlN3Z0xpNHVYVnh1WEc0bklDc05DaUFnSUNBblcreUtwTzJEZ095ZHZDRHF0NXpzdVpsZFhHNG5JQ3NnVTFSWlRFVmZVbFZNUlZNZ0t5QW5YRzVjYmljZ0t3MEtJQ0FnSUNoSFZVbEVSU0EvSUNkYjdJcWs3WU9BN0oyOElPcXdnT3lkdE91VG5DRHNvSVRyckxnZ0tIVjRMWGR5YVhScGJtY3ViV1FwSU9LQWxDRHNuSVFnNnJlYzdMbVo3SjJZSU9xM3ZPcXhzT3laZ0NEc21JanNtYmdnN0l1YzY0S1k2NmFzN0ppa0xpRHRpcm50bm9nZzdKaUk3Sm00SU9xM25PeTVtU2pzaUpqcmo1bnRtSlhDDQp0K3F5dmV5V3RNSzM2N2FBN0tDVjdaaVY3SjJFSU95Y29PeW5nTzJWdE95VnZDRHRsWmpyaXBRZzdJT0I3Wm1wS2V5ZGhDRHF0N2pyaklEcm9ad2c2NVN3NjZXMDZyT2dMQ0RzbXBUc2xiM3FzN3dnN0tDRTY2eTQ3SjIwSU91THBPdWx0T3VwdENEc29JVHJyTGpzbllRZzY1U3c2Nlc0NjR1a1hWeHVKeUFySUVkVlNVUkZJQ3NnSjF4dVhHNG5JRG9nSnljcElDc05DaUFnSUNBb1ptVjNVMmh2ZENBL0lDZGI3SnF3NjZhc0lPdXFxZXlHak91bXJDRHNtSWpzaTV3ZzRvQ1VJT3lkdENEdGhxVHNuWVFnNjVTdzY2VzhJT3F5ZzExY2JpY2dLeUJtWlhkVGFHOTBJQ3NnSjF4dVhHNG5JRG9nSnljcElDc05DaUFnSUNBbjdLU0E2N21FNjVDUTdKeTg2Nm0wSUNKUFN5THJuYnpxczZEcnA0d2c2NHUxN1pXWTY1MjhMaWNOQ2lBZ0tUc05DbjBOQ2cwS0x5OGc0cFNBNHBTQUlPeURnZXlMbkNEcmpJRHF1TEFnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaQ0KbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJQU5DbXhsZENCd2NtOWpJRDBnYm5Wc2JEc2dJQ0FnSUNBZ0lDQWdMeThnN1lHMDY2R2M2NU9jSU8yVWhPdWhuT3lFdU95S3BBMEtiR1YwSUd4cGJtVkNkV1lnUFNBbkp6c2dJQ0FnSUNBZ0lDQXZMeUJ6ZEdSdmRYUWc3S1NFSU91eWhPMk52QTBLYkdWMElIZGhhWFJsY2lBOUlHNTFiR3c3SUNBZ0lDQWdJQ0F2THlEdG1JVHNucXdnN1lTMDdKMllJSHNnY21WemIyeDJaU3dnY21WcVpXTjBMQ0IwYVcxbGNpQjlEUXBzWlhRZ2NYVmxkV1VnUFNCUWNtOXRhWE5sTG5KbGMyOXNkbVVvS1RzZ0x5OGc3SnFVN0xLdElPeW5nZXVnck8yWmxDQW82NCtaN0l1Y0lPeWFsT3l5cmV5ZGdDRHNpSnpzaEp6cmpJRHJvWndwRFFwc1pYUWdkSFZ5Ym5NZ1BTQXdPdzBLYkdWMElIZGhjbTFsWkZWd0lEMGdabUZzYzJVN0RRcHNaWFFnWTNWeWNtVnUNCmRFMXZaR1ZzSUQwZ1EweEJWVVJGWDAxUFJFVk1PeUF2THlEc3A0RHF1SWdnN0lTNDdJV1k3SjIwSU91c3ZPcXpvQ0Rzbm9qcmlwUWc2NnFvNjQyNElDanNtcFRzc3Ezc25iUWc2NHVrNjZXNElPdXFxT3VOdU95ZGhDRHNwNERzb0pYdGxaanJxYlFnN0lTNDdJV1lJT3llck95TG5PeWVrU2tOQ2k4dklPeUxuT3lla1NEc2k1d2dRMnhoZFdSbElFTnZaR1VvWTJ4aGRXUmxJRU5NU1NucXNJQWc3Sk80SU95SW1DRHNub2pyaXBUc3A0QWc3S0NRNnJLQUlPS0FsQ0RzbDRic25MenJxYlFnTDJobFlXeDBhT3VobkNEc2xZenJvS1FnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lWaU91Q3RPMlZuT3VMcEM0TkNpOHZJRzUxYkd3OTdabVY3SjI0SU95a2tTd2dKMjlySnozc2dxenNtcWtnNnJDQTY0cWxMQ0FuWTJ4aGRXUmxMVzFwYzNOcGJtY25QV05zWVhWa1pTRHJxb1hyb0xrZzdKZUc3SjJNTEEwS0x5OGdKMk5zWVhWa1pTMXNiMmR2ZFhRblBXTnNZWFZrWmV1S2xDRHNub2pzcDREcnA0d2c2NkdjNnJlNDdKMjRJT3lFDQp1T3lGbUNEcnA0enJvNHdnS08yRXRDRHNpNlR0aktnZzdJdWNJT3F3a095bmdDd2c3SVN4NnJPMUlPMkV0T3lkdENEc21LVHJxYlFnN0o2UTY0K1pJTzJWdE95Z25Da05DaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzbnF6cm9aenF0N2pzbmJqc25iUWc3SldFNjR1STY1MjhJTzJWbk91UGhDRHNuYmpzZzRIQ3QrcXpoT3lnbFNEc29JVHRtWmdwRFFwc1pYUWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ2JuVnNiRHNOQ2k4dklPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBSU9LQWxDQkRURW5xc0lBZzY0SzA2NHFVSU95WWdleVd0Q0RzbmJqc3BwMGc3SmlrNjZXWTY2VzhJT3lDck91ZWpPeWR0Q0RzbFl6c2xZVHJrNlRzbllRZzdKV0k2NEswNjZHY0lPdXdsT3Erdk91THBDNE5DaTh2SUNoamJHRjFaR1VnTFMxMlpYSnphVzl1N0oyQUlPdWhuT3EzdU95ZHVDRHNsNGJzbmJUcg0KajRRZzdJU3g2ck8xN1pXMDdJU2NJT3lMbk91UG1TRHNvSkRxc29Ec25MenJvWnpyaXBRZzY2cTdJT3llb2Vxem9Dd2c3SXVrN0tDY0lPMkV0T3lYa095RW5PdW5qQ0RyazV6cm42enJncHpyaTZRcERRb3ZMeUFpNjZlTTY2T01JdXVuak95ZHRDRHNsWVRyaTRqcm5id2dJdTJWbkNEcnNvanJqNFFnNjZHYzZyZTQ3SjI0SU95VmlDRHRsYWdpNjQrRUlPcXdtZXlkZ0NEcXNyM3JvWnpyb1p3ZzdKNmg3WjZJNjYrQTY2R2NJT3lra2V1bXZTRHRrWnp0bUlUc25ZUWc3Sk8wNjR1a0RRcGpiMjV6ZENCTVQwZEpUbDlIVlVsRVJTQTlJQ2Z0Z2JUcm9aenJrNXdnNjZHYzZyZTQ3SjI0N0oyMElPMlZoT3lhbE8yVnRPeWFsQ2pzbFlnZzY1Q1E2ckd3NjRLWUlPdW5qT3VqakNrZzRvQ1VJRnZ3bjUrZ0lPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c3WldFN0pxVVhTRHJzb1R0aXJ6c25ZUWc2NGlFNjZXMDY2bTBJT3Vobk9xM3VPeWR1Q0Rzc0wzc25ZUWc3SmUwN0phMDY1T2M2NkNrN0pxVUxpYzdEUW92THlEc2k2VHMNCnVLSHRsWndnNjZ5NDZyV3M2NU9rT2lBaVJtRnBiR1ZrSUhSdklHRjFkR2hsYm5ScFkyRjBaVG9nVDBGMWRHZ2djMlZ6YzJsdmJpQmxlSEJwY21Wa0lHRnVaQ0JqYjNWc1pDQnViM1FnWW1VZ2NtVm1jbVZ6YUdWa0lpanJwNHpybzR3cExBMEtMeThnSWs1dmRDQnNiMmRuWldRZ2FXNGd3cmNnVUd4bFlYTmxJSEoxYmlBdmJHOW5hVzRpS091dnVPdWhuT3EzdU95ZHVDa2c0b0NVSU91Um1DRHJpNlFnN0o2aDdaNkk2cktNSU91RWsrMmVqT3VMcEEwS1puVnVZM1JwYjI0Z2FYTkJkWFJvUlhKeWIzSW9jeWtnZXcwS0lDQnlaWFIxY200Z0wyRjFkR2hsYm5ScFkyRjBmRzloZFhSb2ZHRndhU0JyWlhsOGJHOW5JRDlwYm54c2IyZG5aV1I4YzJWemMybHZiaUJsZUhCcGNtVmtMMmt1ZEdWemRDaFRkSEpwYm1jb2N5a3BPdzBLZlEwS0x5OGc3SUtzN0pxcElPMlZuT3VQaENEc3RJanFzN3dnNnJDUTdLZUFJT0tBbENEcm9aenF0N2pzbmJqc25ZQWc2Nm1BN0ttaDdaV2M2NDJ3SUNMcmpaUWc2NnE3SU95VHRPdUxwQ0xyDQppcFFnNnJLOTdKcXdMaURyb1p6cXQ3anNuYmdnNjZlTTY2T003Sm1BSU95aHNPeTVtT3F3Z0NEcmk2enJuYnpzaEp3ZzY1U3c2NkdjSU95ZW9ldUtsT3VMcEM0TkNpOHZJT3lMcE95NG9TZ3lNREkyTFRBNExDRHRtb3pzZ3F3ZzdKZVU3WVN3N1pTRTY1Mjg3SjIwN0thSUlPeWlqT3lFblNrNklDSlpiM1VuZG1VZ2FHbDBJSGx2ZFhJZ2FXNWthWFpwWkhWaGJDQnpjR1Z1WkNCc2FXMXBkQ0RDdHlCeWRXNGdMM1Z6WVdkbExXTnlaV1JwZEhNTkNpOHZJSFJ2SUdGemF5QjViM1Z5SUdGa2JXbHVJR1p2Y2lCaElHaHBaMmhsY2lCc2FXMXBkQ0lnNG9DVUlPcTBnT3Vtck95ZWtPcXdnQ0RzZ3F6cm5venJzNFRyb1p3ZzZyRzQ3SmEwSU91UmxDRHNnNEh0bFp6c25iVHJuYndnN1pTTTY1NmNJT3lDck95YXFldWZpZXlkdENEcmdxanNsWVRyajRRZzZyRzQ2NmF3NjR1a0xnMEtMeThnN0oyMElPeThnT3lkdE95S3BPcXdnQ0RzbDRicmpaZ2c3WU9UN0plUUlPeVlnZXlXdENEc201RHJyTGpzbmJRZzZyZTQ2NHlBNjZHYw0KSU8yR29PeUtwTzJLdU91UHZDQWk3Sm1jSU95VmlDRHJrSmpyaXBUc3A0QWlJT3lWakNEc2lKZ2c3SmVHN0plSTY0dWtLT3lMcE95Z25DRHNpNkRxczZBcExnMEtZMjl1YzNRZ1RFbE5TVlJmUjFWSlJFVWdQU0FuN1lHMDY2R2M2NU9jSU95Q3JPeWFxU0R0bFp6cmo0VHJwYndnNjR1a0lPeU52T3lXdE95YWxDRGlnSlFnN1pxTTdJS3NJT3F6aE95Z2xleWR0T3VwdENEcXRJRHJwcXpzbnBEc2w1RHFzb3dnN1pXYzY0K0U2Nlc4SU95WXJPdWdwQ0RyaTZ6cm5ienFzNkFnN0pxVTdMS3Q3WldZNnJPZ0xDRHNsWVRyaTRqcnFiUWdXL0NmbjZBZzdZRzA2NkdjNjVPY0lPMlZuT3VQaENEc3RJanFzN3hkSU91eWhPMkt2T3lkaENEcmlJenJuNndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxiUWc3S084N0lTNDdKcVVMaWM3RFFvdkx5QW43WldjNjQrRUordWhuQ0Rycllucm1ySHF0N2pycHF6cnFiUWc3SldJSU91UW5PdUxwQ0RpZ0pRZzdKNmc2cm1RSU91cXNPdW10Q0RybFl3ZzY0S1kNCjY0cVVJSEpoZEdVZ2JHbHRhWFRzbmJUcmdwZ2c2Nnk0NjZlbElPcTR1T3lkdENEc3RJanFzN3pxdVl6c3A0QWc3SjZoN0pXRURRb3ZMeURzbDRucm1ySHRsWmpxc293Z0l1dUxwT3VsdUNEcXM0VHNvSlhzbkx6cm9ad2c2NkdjNnJlNDdKMjQ3WldZNjUyOEl1cXpvQ0RzbFlqcmdyVHRsWmpxc293ZzY1Q2M2NHVrTGlEc3A0RHN0cHpDdCt5Q3JPeWFxZXVmaVNEc2c0SHRsWndnNjZ5NDZyV3M2NmVNSU95aWdlMllnT3lFbkNEcnM3anJpNlFOQ21aMWJtTjBhVzl1SUdselRHbHRhWFJGY25KdmNpaHpLU0I3RFFvZ0lISmxkSFZ5YmlBdmMzQmxibVFnYkdsdGFYUjhkWE5oWjJVdFkzSmxaR2wwYzN4MWMyRm5aU0JzYVcxcGRDQW9jbVZoWTJobFpIeGxlR05sWldSbFpDa3ZhUzUwWlhOMEtGTjBjbWx1WnloektTazdEUXA5RFFvdkx5RHJvWnpxdDdqc25ianJrSndnNnJPRTdLQ1ZJTzJabGV5ZHVDRGlnSlFnUTB4SjZyQ0FJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKZVFJT3E0c091aG5lMlZtT3VLbENCdllYVjBhRUZqDQpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTno2Nlc4SU95ZHZleVd0QTBLTHk4Z0wyaGxZV3gwYU91aG5DRHJoYmpzdHB6dGxaenJpNlFnS08yVWpPdWZyT3EzdU95ZHVPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFFnN0tTUjdKMjQ3S2VBSWlEdGtaenNpNXdnNG9DVUlPcXp0ZXlhcVNCUVEreVhrT3lFbkNEcmdxanNuWmdnNnJPRTdLQ1ZJT3lZcE95Q3JPeWFxU0Ryc0tuc3A0QXBMZzBLTHk4ZzdZeU03SjI4N0oyMElPMkJ0Q0RzaUpnZzdKNkk3SmEwS08yVWhPdWhuT3lnbmUyS3VDRHNuYlRyb0tVZzdZK3M3WldvS1NBek1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdEUW92THlEc3A0RHF1SWdnNjVhZ0lPeWVpT3VLbENCag0KYkdGMVpHVWc3SVM0N0lXWTdKMjBJT3lXdE91S2tDRHFzNFRzb0pYc25MenJvWndnN0l1YzY0K1o2NUNRNjRxVTdLZUFJQ2h6ZEdGeWRGQnliMlBzbDVEc2hKd2c2cml3NjZHZEtTNE5DaTh2SU95RXVPeUZtT3lkZ0NEc2k1enJqNW50bGFBZzY1V01JT3V3bSt5ZGdDRHNub1hzbnFYcXRvenNuWVFnNnJPRTdJYU5JT3lUc091dmdPdWhuQ3dnNjdDVzdKZVE3SVNjSU9xemhPeWdsZXlkaENEcnNKVHF2cmpycWJRZzdKMjBJT3F3a3VxenZDRHRqSXpzbmJ6c25aZ2c2ck9FN0tDVjdKMjBJT3lXdE9xNGkrdUNuT3VMcEEwS2JHVjBJSE5sYzNOcGIyNUJZMk52ZFc1MElEMGdiblZzYkRzTkNpOHZJT3lMcE95Z25DRHJvWnpxdDdqc25iZ2c3SmVzNjdhQTY0cVVJT3lla09xeXFleW1uZXVxaFNEdGpJenNuYnpyb1p3ZzdZeVE2NHVvN1pXYzY0dWtJT0tBbENCK0x5NWpiR0YxWkdVdWFuTnZidXlkbUNCdllYVjBhRUZqWTI5MWJuVHJpcFFnS2lycm9aenF0N2pzbFlUc200UHRsYlRyajRRZzY0S282NHFVNjR1a0tpb04NCkNpOHZJQ2pzaTZUc3VLRTZJR05zWVhWa1pTQmhkWFJvSUhOMFlYUjFjK3VLbENCc2IyZG5aV1JKYmpwbVlXeHpaZXlkdU91TnNDRHF0N2dnN1pXRTY1T2M2NHFVSU9xM3VPdU1nT3VobkNEaWhwSWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPdWhuT3EzdU95ZHVPdVFuQ0Rxc29Qc3NwanJuN3dnN1pHYzdJdWM3WmFJNjR1a0tTNE5DaTh2SU8yTWpPeWR2T3VuakNEc25iM3NuTHpycjREcm9ad2c2N21FN0pxcElEQXVJR05zWVhWa1pTQmhkWFJvSUhOMFlYUjFjK3VsdkNEcnRvRHJwYlRycWJRZzdLQ1Y3Wm1WN1pXWTdLZUE2NmVNSU8yVWhPdWhuT3lFdU95S3BPdWx2Q0RybllUc200enNsYndnN1pXMDdJU2NJT3loc08yYWpPdW5pT3VMcENEc2s3RHF1TERzbDVRZzY2eTA2cktCNjR1a0xnMEtablZ1WTNScGIyNGdhR0Z6UTJ4aGRXUmxRM0psWkdWdWRHbGhiSE1vS1NCN0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnWTI5dWMzUWdaaUE5SUhCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxKeXdnDQpKeTVqY21Wa1pXNTBhV0ZzY3k1cWMyOXVKeWs3RFFvZ0lDQWdZMjl1YzNRZ2FpQTlJRXBUVDA0dWNHRnljMlVvWm5NdWNtVmhaRVpwYkdWVGVXNWpLR1lzSUNkMWRHWTRKeWtwT3cwS0lDQWdJR2xtSUNocUlDWW1JR291WTJ4aGRXUmxRV2xQWVhWMGFDQW1KaUJxTG1Oc1lYVmtaVUZwVDJGMWRHZ3VZV05qWlhOelZHOXJaVzRwSUhKbGRIVnliaUIwY25WbE93MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUR0akl6c25id2c3SmVHN0oyTXdyZnJxcnNnN0oyOTdKMk1JT0tBbENEcnA2WHNuYlRycWJRZzdZS2s3TEswN0oyNDdKMkVJT3VuaU95Z2dDRHJzN2pyaTZRZ0tpOGdmUTBLSUNBdkx5QXFLdXVucGV5ZGdDRHNucERxc3Fuc3BwM3Jxb1hzbllRZzdZeU03SjI4N0oyMElPeVZoT3VMaU91ZHZDRHRncVRzc3JUc25ianNsNUFnNjRTajY0cVU2NHVrS2lvZ0tESXdNall0TURnZzdJdWs3TGloTENEcmk2VHJwcXdnZGpReElDOGc2ckNRN0l1YzdKNlFJSFkyS1M0TkNpQWdMeThnNjZlbDdKMllJRU5zWVhWaw0KWlNCRGIyUmw2NHFVSUg0dkxtTnNZWFZrWlM4dVkzSmxaR1Z1ZEdsaGJITXVhbk52YnV5ZGhDRHNsWVRzbUlnZzY2ZU02NU9rN0tlQUlPeVZpdXF6b0NEdGdxVHNzclRzbmJnZzdaV3Q2NnFwRFFvZ0lDOHZJQ2REYkdGMVpHVWdRMjlrWlMxamNtVmtaVzUwYVdGc2N5ZnNsNUFnN0tDQTdKNmw3WldjNjR1a0lPS0draUR0akl6c25ienJwNHdnNjdPMDY2bTBJT3VwZ095cG9lMmVpQ0Ryb1p6cXQ3anNuYmpya0p3ZzY2ZWw3SjIwSU91S21DQW42NkdjNnJlNDdKMjRJT3lWaUNEcmtLZ243SjIwSU91UW1PcXpvQ3dOQ2lBZ0x5OGc2NkdjNnJlNDdKMjRJT3VNZ09xNHNDRHRtWlRycWJUc25iUWc3SmlCN0ppQklPdVBpT3VMcENqcmlJenJuNnpyajRRZ1EweEo2ckNBSUNMc25iVHJyN2dnNjZHYzZyZTQ3SjI0NjVDb0l1eWN2T3VobkNEc3BvbnNpNXdnNjRHZDY0S1lJT3U0ak91ZHZPeWFzT3lnZ095aHNPeXdxQ0RzbFlnZzdKZTA2NmF3NjR1a0tTNE5DaUFnTHk4Z0tpcnNvYlRzbnF6cnA0d2c3Wm1WN0oyNDdaV2MNCjY0dWtLQzEzSU95WGh1eWRqQ2txS2lEaWdKUWc2N21FNjdDQTY3S0k3Wmk0SU9xd2t1eWRoQ0RzbmIzc25MenJxYlFnN1lLazdMSzA3SjI0SU95Z2tlcTN2Q0R0bDRqc21xa2c3WXlkN0plRjdKMjBJT3Vjc0NEc2lKZ2c3SjZJNjR1a0xpRHNsYjBnTXpCdGN5NE5DaUFnTHk4Z1EwSmZUazlmUzBWWlEwaEJTVTQ5TWV5ZHRPdXB0Q0R0akl6c25ienJwNHdnNjdPNDY0dWtJQ2pycXFqc25aZ2c3Wm1JN0p5ODY2R2NJQ2Zyb1p6cXQ3anNuYmdnN0plRzdKMk1KK3lkaENEc25xenRtSVR0bFpqcmlwUWc3WVdNN0lxazdZcTQ3SnFwSU9LQWxDRHRncVRzc3JUc25ianNuWUFnU0U5TlJleWRoQ0RzbFlnZzY1U3c2Nlc0NjR1a0tTNE5DaUFnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ0lUMDlJQ2RrWVhKM2FXNG5JSHg4SUhCeWIyTmxjM011Wlc1MkxrTkNYMDVQWDB0RldVTklRVWxPSUQwOVBTQW5NU2NwSUhKbGRIVnliaUJtWVd4elpUc05DaUFnZEhKNUlIc05DaUFnSUNCamIyNXpkQ0J5SUQwZ2MzQmhkMjVUDQplVzVqS0NkelpXTjFjbWwwZVNjc0lGc25abWx1WkMxblpXNWxjbWxqTFhCaGMzTjNiM0prSnl3Z0p5MXpKeXdnSjBOc1lYVmtaU0JEYjJSbExXTnlaV1JsYm5ScFlXeHpKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuTENCMGFXMWxiM1YwT2lBek1EQXdJSDBwT3cwS0lDQWdJSEpsZEhWeWJpQnlMbk4wWVhSMWN5QTlQVDBnTURzTkNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVjBkWEp1SUdaaGJITmxPeUI5SUM4dklITmxZM1Z5YVhSNTY2VzhJT3VxdXlEcnRvRHJwb1FnUFNEcm9aenF0N2pzbmJnZzdKV0lJT3VRcU95Y3ZPdWhuQ0Ryczdqcmk2UU5DbjBOQ21aMWJtTjBhVzl1SUdOc1lYVmtaVUZqWTI5MWJuUW9LU0I3RFFvZ0lHbG1JQ2hFWVhSbExtNXZkeWdwSUMwZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUR3Z016QXdNREFwSUhKbGRIVnliaUJoWTJOdmRXNTBRMkZqYUdVdVpXMWhhV3c3RFFvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnYVdZZ0tHaGhjME5zWVhWaw0KWlVOeVpXUmxiblJwWVd4ektDa3BJSHNnTHk4ZzdKNlE2cktwN0thZDY2cUY3SjIwSU95WGh1eWN2T3VwdENEcmdxanNuWUFnN0oyMDY2bVU3SjI4N0oyQUlPdXN0T3lMbk8yVm5PdUxwQTBLSUNBZ0lDQWdZMjl1YzNRZ2FpQTlJRXBUVDA0dWNHRnljMlVvWm5NdWNtVmhaRVpwYkdWVGVXNWpLSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDY3VZMnhoZFdSbExtcHpiMjRuS1N3Z0ozVjBaamduS1NrN0RRb2dJQ0FnSUNCbGJXRnBiQ0E5SUNocUlDWW1JR291YjJGMWRHaEJZMk52ZFc1MElDWW1JR291YjJGMWRHaEJZMk52ZFc1MExtVnRZV2xzUVdSa2NtVnpjeWtnZkh3Z2JuVnNiRHNOQ2lBZ0lDQjlEUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU91aG5PcTN1T3lkdUNEc25iVHJvS1VnN0plRzdKMk1JT3VUc1NEaWdKUWdiblZzYkNEc25LRHNwNEFnS2k4Z2ZRMEtJQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lCRVlYUmxMbTV2ZHlncExDQmxiV0ZwYkNCOU93MEtJQ0J5WlhSMWNtNGcNClpXMWhhV3c3RFFwOURRcG1kVzVqZEdsdmJpQmphR1ZqYTBOc1lYVmtaVUYyWVdsc1lXSnNaU2dwSUhzTkNpQWdZMjl1YzNRZ2NISnZZbVVnUFNCemNHRjNiaWduWTJ4aGRXUmxKeXdnV3ljdExYWmxjbk5wYjI0blhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXSUgwcE93MEtJQ0JzWlhRZ2IzVjBJRDBnSnljN0RRb2dJSEJ5YjJKbExuTjBaRzkxZEM1dmJpZ25aR0YwWVNjc0lDaGtLU0E5UGlCN0lHOTFkQ0FyUFNCa0xuUnZVM1J5YVc1bktDazdJSDBwT3cwS0lDQndjbTlpWlM1dmJpZ25aWEp5YjNJbkxDQW9LU0E5UGlCN0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNkamJHRjFaR1V0YldsemMybHVaeWM3SUgwcE93MEtJQ0J3Y205aVpTNXZiaWduWTJ4dmMyVW5MQ0FvWTI5a1pTa2dQVDRnZXcwS0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlDaGpiMlJsSUQwOVBTQXdJQ1ltSUM5Y1pDdGNMbHhrS3k4dWRHVnpkQ2h2ZFhRcEtTQS9JQ2R2YXljZ09pQW5ZMnhoZFdSbExXMXBjM05wDQpibWNuT3cwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCRGJHRjFaR1VnUTI5a1pTRHNvSkRxc29BNklDY2dLeUJqYkdGMVpHVlRkR0YwZFhNZ0t5QW9iM1YwSUQ4Z0p5QW9KeUFySUc5MWRDNTBjbWx0S0NrZ0t5QW5LU2NnT2lBbkp5a3BPdzBLSUNCOUtUc05DbjBOQ2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQTBLWTI5dWMzUWdjM1JoZEhNZ1BTQjdJSE5sY25abFpEb2dNQ3dnYkdGemRFRjBPaUFuSnl3Z2JHRnpkRlJsZUhRNklDY25MQ0JzWVhOMFUyVmpPaUFuSnlCOU93MEtEUW92THlEaWxJRGlsSUFnN1pTTTY1K3M2cmU0N0oyNElPeURuZXlodENEcXNKRHNwNEFvN0l1czdKNmw2N0NWNjQrWktTRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaQ0KbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFOQ2k4dklPMlVqT3Vmck9xM3VPeWR1T3lkdENEcmxxQWc3SjZJNjRxVUlPdVBtZXlWaUNCamIyUmxMblJ6NnJDQUlEWHN0SWpycDRqcmk2UWdVRTlUVkNBdmFHVmhjblJpWldGMDY2VzhJT3V6dE91Q3VPdUxwQzROQ2k4dklPMlZuQ0Ryc29qc25iVHJuYnpyajRRZzY3Q2I3SjJBSU91U3BDQXpNT3kwaU9xd2hDRHJnWXJxdUxEcnFiUWc3WlNNNjUrczZyZTQ3SjI0S091WWtPdUtsQ0R0bEx6cXQ3anJwNGdwN0oyMElPdUxxKzJlakNEcXNvTWc0b0NVSU8yQnRPdWhuT3VUbk9xNWpPeW5nQ0RyamJEcnBxenFzNkFnNnJDWjdKMjBJT3E2dk95bmhPdUxwQzROQ2k4dklPeVZoT3luZ1NEdGxad2c2N0tJNjQrRUlPdXF1eURyc0p2c2xaanNuTHpycWJRbzY0dWs2NmFzNjZlTUlPdW92T3lnZ0NEc3ZLQWc3SU9CN1lPY0xDRHNucERyajVuc2k1enNucEVnNjVPeEtTRHENCnM0VHNobzBnNjR5QTZyaXc3WldjNjR1a0xnMEtZMjl1YzNRZ1NFVkJVbFJDUlVGVVgwUkZRVVJmVFZNZ1BTQXpNREF3TURzTkNteGxkQ0JzWVhOMFFtVmhkQ0E5SURBN0RRb05DaTh2SU91QmhPcTRzQ0Rzb0lUc2w1QWdLaXJyazZQcmpaZ2c3WStzN1lxNDY2VzhJT3Vvdk95Z2dDRHJocFByaXBUcmk2UXFLaUFvTWpBeU5pMHdPQ3dnUWxKSlJFZEZYMVk5TkRJcExnMEtMeThnN0ptY09pQndjbTlqWlhOekxtVjRhWFRzblpnZ1pYaHBkQ0R0bGJqcms2VHJuNnpxc0lBZ2EybHNiRkJ5YjJQaWhwSjBZWE5yYTJsc2JPeWRoQ0RyajR6cnBxenJpcFRyamJBc0lPcTN1T3F5akNEcnFZanN0cFRycWJRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU95aWhldWpqQ0RyajRUc3BKRU5DaTh2SU95V3ZPeVd0T3UybWV5V3RDRHRqNnp0aXJqcnA0d2c2Nnk4NnJPZ0lPeWRrZXVMdGV5ZGhDRHJxcnNnN1pXWTY0cVVJT3lpZ091NWhPcXdnQ0Rya0p6cmk2UXVJT3EzdU91ZnJPdXB0Q0Rxc0pEc2k1enNucERxc0lBZzdJT0k2NkdjDQpJT3k4b0NEcmk2VHJwcXpyaXBRZ1JVRkVSRkpKVGxWVFJldWhuQTBLTHk4ZzY2eTg2NStzNjRLWTZyT2dLT3Vobk9xM3VEb2dKK3lkdE91dnVDRHN2Snpzb0xnZzdKNkk3SmEwN0pxVUp5a3NJTzJVak91ZnJPcTN1T3lkdU95WGxDQWk3SmV3NjQrWjY1Q1k3S2VBSU95Vml1eVZtT3lXdE95YWxDTHJwNHdnNjRLbzY0cVU2NHVrS095THBPeTRvU2t1RFFvdkx5RHNob3pzdkpQc25ZUWc2Nmk4N0tDQUlPdUxxK3lWaENEcmtaRHJxYlFnN0tDVjY2YXM2ckNBSU91S2tPdWdwT3VQaENEcmk2VHNuWXdnNjR1azY2YXM2ckNBSU95Z2xleURnZXlnZ2V5Y3ZPdWhuQ0RxdDdnZzdZK3M3WXE0NjZXOElPeWVvZXVLbE91THBDNE5DbVoxYm1OMGFXOXVJR2hoY21SRmVHbDBLR052WkdVcElIc05DaUFnZEhKNUlIc2djMlZ5ZG1WeUxtTnNiM05sS0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3luZ1NEc2xZZ2c2NWEwN0p5ODY2bTBJT3VzdE95TG5DQXFMeUI5RFFvZ0lIUnllU0I3SUhObGNuWmxjall1WTJ4dg0KYzJVb0tUc2dmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2dTVkIyTnV5ZGdDRHNsNGJzbllRZzdJaVlJT3llaU91THBDQXFMeUI5RFFvZ0lIQnliMk5sYzNNdVpYaHBkQ2hqYjJSbElIeDhJREFwT3cwS2ZRMEtjMlYwU1c1MFpYSjJZV3dvS0NrZ1BUNGdldzBLSUNCcFppQW9iR0Z6ZEVKbFlYUWdKaVlnUkdGMFpTNXViM2NvS1NBdElHeGhjM1JDWldGMElENGdTRVZCVWxSQ1JVRlVYMFJGUVVSZlRWTXBJSHNOQ2lBZ0lDQXZMeUFxS3V1aG5PcTN1T3lkdUNEc3BKSHNuYlRycWJRZzdKV0lJT3E2dk95bmhPdUxwQ29xSUNneU1ESTJMVEE0TENCQ1VrbEVSMFZmVmowek55azZJR1Y0YVhRZzdaVzQ2NU9rNjUrczZyQ0FJR3RwYkd4TWIyZHBibEJ5YjJQcXVZenNwNEFnNjdhQTY2VzA2NitBNjZHY0RRb2dJQ0FnTHk4ZzdKZXM2cml3N0lTY0lPcTZ2T3luZ091cHRDRHJ1SXpybmJ6c21yRHNvSURzbDVEc2hKd2c2NkdjNnJlNDdKMjQ3WldZNjQyWUlPeUNyT3Vlak95ZG1DRHN2Wnpyc0xFZzdZK3M3WXE0NnJDQUlPdUwNCnErMllnQ0FpYkc5allXeG9iM04wN0plUTdJU2NJT3lYc09xeXNPeWRoQ0Rxc2JEcnRvRHRsb2pzaXJYcmk0anJpNlFpNnJDQURRb2dJQ0FnTHk4ZzY1eW82ckd3NjRLWUxDRHJvWnpxdDdqc25iZ2c3TEM5N0oyMElPeUdqT3VtckNEc2w0YnNuYlFnNjZ5MDdacW82ckNBSU91UW5PdUxwQ2pzaTZUc3VLRWc0b0NVSU8yVWpPdWZyT3EzdU95ZHVPeWRoQ0RyaTZ2c2xZUWc2NUdVSU95eGhDRHJvWnpxdDdqc25ianRsWmpycWJRZzY2ZWs2N0tJSU95ZHRPdWVyT3VMcENrdURRb2dJQ0FnTHk4ZzY2R2M2cmU0N0oyNDdKMkFJT3U0ak91ZHZPeWFzT3lnZ095WGtPeUVuQ0RzZ3F6cm5venNuYlFnN0tlRTdaYUo3WldZNjRxVUlPeWR2T3lkdE91ZHZDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY1YWdJT3llaU95ZGhDRHRsWVRzbXBUcXNJQWc3SmVHNjR1a0xpRHJyTFR0bFp3ZzY0eUE2cml3SU95Y2hPMlhtT3lkZ0EwS0lDQWdJQzh2SUd4dloybHVVSEp2WTFScGJXVnlLRE13NjdhRUtlcXdnQ0RycDRucmlwVHJpNlFnDQo0b0NVSU9xM3VDRHRnNERzbmJUcnFManFzSUFnNjZHYzZyZTQ3SjI0N0oyRUlPeWdsZXVtck8yVm1PdXB0Q0RyaTZUc25Zd2c3S0NRNnJLQTdKZVE3SVNjSU95Z2xleURnZXlnZ2V5Y3ZPdWhuQ0RxdXJ6c3A0VHJpNlF1RFFvZ0lDQWdhV1lnS0d4dloybHVVSEp2WXlrZ2V3MEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lMck95ZXBldXdsZXVQbWV5ZGdDRHJnWXJxc3J6c3A0RHJwNHdnNjZHYzZyZTQ3SjI0N0oyMElPeW5oTzJXaVNEc3BKSHNuYlRybmJ3ZzZyaXc2NHVrNjZhOTY0dUk2NHVrSUNqcm9aenF0N2pzbmJnZzY0R2Q2NEtZNjZtMElPeWdsZXVtck91UXFldUxpT3VMcENrdUp5azdEUW9nSUNBZ0lDQnlaWFIxY200N0RRb2dJQ0FnZlEwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJenJuNnpxdDdqc25iZ2c3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTVnQ0RpZ0pRZzdaUzg2cmU0NjZlSUwrMlVqT3Vmck9xM3VPeWR1T3lkdENEcmk2dnRub3dnNnJLRA0KN0p5ODY2R2NJT3V6dE9xem9DRHFzSm5zbmJRZzZycTg3S2VSNjR1STY0dWtMaWNwT3cwS0lDQWdJR2hoY21SRmVHbDBLREFwT3lBdkx5RHRqNnp0aXJqcnBid2c2Nmk4N0tDQUlPdUdrK3F6b0NEc29vWHJvNHdnNG9DVUlHVjRhWFFnN1pXNDY1T2s2NStzNnJDQUlHdHBiR3hRY205ajdKeTg2NkdjSUdOc1lYVmtaU0R0aXJqcnBxenJwYndnN0tDVjY2YXM3WldjNjR1a0RRb2dJSDBOQ24wc0lEVXdNREFwT3cwS0RRb3ZMeURzbTdrZzY2R2M2cmU0N0pXRTdKdUQ3SjJFSU91NGpPdWR2T3lhc095Z2dPdWhuQ0RzbDZ6cmlwUWc3TDJVNjVPYzY0cVVJT3lnbk9xeHNPMldpT3VMcENBb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU5EQXBJT0tBbENEcm9aenF0N2pzbmJnZzdabVU2Nm0wN0oyMElPdVJrQ0Rxc0p3ZzY1YWc3SVNjRFFvdkx5RHNsclRyaXBBZzdLcTk3SmVRSU91aG5PcTN1T3lkdU8yVnRPeVZ2Q0R0bFpqcmlwVHNwNEFnN0pXTUlPeUltQ0RzbDRic2w0anJpNlFvN0l1azdMaWhJT3lMb09xem9Da3UNCklPeUt1ZXlkdUNEdG1aVHJxYlRzbllRZzZyRzA2NFNJNjV1dzY2Q2s2Nm0wSU95Q3JPeWFxZXlla09xd2dDRHJ1SXpybmJ6c21yRHNvSURzbDVEc2hKd05DaTh2SU95bmdleWdrU0JqYkdGMVpHVWc2NkdjNnJlNDdKV0U3SnVEN0oyRUlPMlZtT3F4c091Q21Dd2c3SXE1N0oyNElPMlpsT3VwdENEdGxaanJpNmdnVytxemhPeWdsU0Rzb0lUdG1aaGQ3SjJFSU95VHNPdXB0Q0Rya0p6cmk2UXVJQ29xN1lPdDdKMkFJTzJWcmV5RGdTQXg2ckNjNjZHY0lPeWNvT3luZ08yVm9DRHFzb011S2lvTkNnMEtMeThnNHBxZzc3aVBJT3Vobk9xM3VPeWR1Q0Rxc3Izcm9aenNsNURzaEp3Z0tpcENVazlYVTBWUzY2VzhJT3F4dE91VG5PdW1yT3VwdENEc2xZZ2c2NUNjNjR1a0tpb2dLREl3TWpZdE1EZ2c3SXVrN0xpaElETHRtb3pyb1p3ZzdabVY3S0NWS1RvTkNpOHZJQ0FnUWxKUFYxTkZVdXVsdkNEc2hLVHNvSlh0bFpqcnFiUW82NEswN0pxcDdKMjBJT3VzdE95WGgreWR0T3VUb0N3ZzdKV0U2NnkwNnJLRDY0K0VJT3lWDQppQ0R0bFpqcmlwUWdibTh0YjNEc25iVHNsclRyajRRcElHTnNZWFZrWlNCRFRFbnFzSUFnNjdpTTY1Mjg3SnF3N0tDQUlPMlZ1T3VUbk95WXBPMlVoT3VsdkEwS0x5OGdJQ0R0ajZ6cXVMRHRsWmpxczZBZ0tpb2k3SjI0N0thZElPeTlsT3VUbk91bHZDQkRiR0YxWkdVZ1EyOWtaZXlYa0NEcnRwbnNsNnpyaEtQc25MenNoTGpzbXBRaUlPdXdxZXlMbmV5Y3ZPdWhuQ0Ryc0pUcmdKRHJpNlFxS2k0ZzY0dWs2NmFzNjRxVUlPdWhuT3EzdU95ZHVDRHRsSVRyb1p6c2hManNpcVRycGJ3TkNpOHZJQ0FnN0lpbzZyS283SVNjSUhOMFpHbHVJT3lYaHV5ZHRDRHJuWVRzbXJEcnI0RHJvWndnNjdhWjdKZXM2NFNqN0oyRUlPcXpzK3lkdENEc2w0YnNsclFnNjZHYzZyZTQ3SjI0N0oyMElPeVZoT3lZaUNEcnRvanFzSURyaXFYdGxiVHNwNFRyaTZRdURRb3ZMeUFnSUNoc2IyTmhiR2h2YzNRZ1RFbFRWRVZPN0oyMElPdVdvQ0Rzbm9qcmlwUWc2cktENjZlTUlPdXp0T3F6b0NEc25wRHJqNWtnN0lpWTY2QzU3SjIwSU95Yw0Kb095bmdPdVFuT3VMcE9xem9DRHRqSkRyaTZqdGxvanJqWmdnNnJLTUlPeVlwT3luaE95ZHRPeVhpT3VMcEM0cERRb3ZMeUFnSU9LR2tpRHF0N2pybnBqc2hKd2dJdTJEclNBeDZyQ2NJQ3NnNnJPRTdLQ1ZJT3lFb08yRG5TRHRtWlRycWJRaTdKMkFJT3lkdENCRFRFbnJvWndnNjdhSTZyQ0E2NHFsN1pXWTY0dWtPaUR0bFp3ZzdZT3Q3Snk4NjZHY0lPeWVoK3lla091cHRDQkRURW5zblpnZzdKZTA2cml3NjZXOElPdW5pZXlWaE95VnZBMEtMeThnSUNEdGxaanFzNkFzSU91bmlleWN2T3VwdENEc3ZaVHJrNXdnNjdhWjdKZXM2NFNqNnJpdzZyQ0FJT3VRbk91THBDNGc2NkdjNnJlNDdKV0U3SnVEN0oyRUlPdVVzT3VobkNEc2w3VHJxYlFnN1lPdDdKMjBJRExxc0p6cXNJQWc2NUNjNjR1a0xnMEtMeThnSUNEcXNyRHJvYUFvN0lLczdKcXA3SjZRSU9xeXNPeWdsU2s2SUNvcTdZT3RJREhxc0p3Z0t5RHNpcm5zbmJnZzdabVU2Nm0wS2lyc25ZUWc3Sk93NnJPZ0xDRHFzNFRzb0pVZzdLQ0U3Wm1ZN0oyQUlPcTMNCnVDRHRtWlRycWJUc25aZ2dXK3F6aE95Z2xTRHNvSVR0bVpoZElPdXloTzJLdk95Y3ZPdWhuQ0R0bFp6cmk2UXVEUW92THlBZ0lPeUNyZXlnbk91UW5DRHNpNXpyajRUcms2UTZJSGR5YVhSbFRtOXZjRUp5YjNkelpYSWdMeUJ2Y0dWdVZYSnNTVzVFWldaaGRXeDBRbkp2ZDNObGNpQXZJR0oxYVd4a1RHOW5iM1YwUTJoaGFXNVZjbXdnS091enRlcTFyT3VLbENCbmFYUWc3WjZJN0lxazdZYWc2NmFzS1M0TkNpOHZJT0tVZ09LVWdDRHJvWnpxdDdqc25ianNuWUFnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdLZUI3S0NSSU95WHRPcXlqQ0R0bFp6cmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVE13S1NEaWxJRGlsSUFOQ2k4dklPeWFzT3Vtck9xd2dDQkNVazlYVTBWUzY2VzhJT3F3Z091aG5PeXhoT3F4c091Q21DRHNzTDNzbllRZzZyT282NTI4SU95WHJPdUtsQ0RzaTV6cmo0VHJpcFFnS2lyc29JVHJ0b0FnN0l1azdZeW83WlcwN0lTY0lPdVFtT3VQak91Z3VPdUxwQ29xDQpMaURyZ3FqcXVMUWc2cldRN1p1SU9nMEtMeThnSUNEaWthQWdRbEpQVjFORlVpRHRsYmpyazZUcm42enJvWndnVlZKTTdKMkVJT3V3bSt5Y3ZPdXB0Q0JqYldUcXNJQWdZQ1pnN0plUTdJU2NJT3llbU91ZHZPdW91ZXVLbE91THBDRGlocElnWTJ4cFpXNTBYMmxrSU95R2pPeUxwQ2dpN0o2WTY2cTc2NUNjSUU5QmRYUm9JT3lhbE95eXJTSXBMZzBLTHk4Z0lDRGlrYUVnUWxKUFYxTkZVdXVsdkNCdWJ5MXZjT3ljdk91aG5DRHJwNG5xczZBZ2MzUmtiM1YwN0oyWUlGVlNUT3lkaENEc21yRHJwcXpxc0lBZzdKZTA2Nm0wSUNvcTdJcTU3SjI0SU91U3BDRHNuYmpzcHAzc3ZaVHJrNXpycGJ3ZzY3YVo3SmVzNjRTajdKeTg2NTI4NjRxVUlPMlpsT3VwdENvcTdKMjBEUW92THlBZ0lDQWdJT3Vjck91THBDanNpNlRzdUtFZzdJdWc2ck9nT2lBaTdKMjA2NSt3SU9xeHNDRHNsNGJzbDRqcmlwVHJqYkFnNnJDUjdKNlE2cml3SU95Wm5DRHNnNTNxc3FnaUtTRGlnSlFnN0o2UTY0K1pJT3lJbU91Z3VleWR0Q0RxdWFqcw0KcDRUcmk2UXVEUW92THlBZ0lPS1JvaURzaTV6dGdhenJwcjhnN0xDOTdKeTg2NkdjSU95WHRPdWdwT3VwdENEcnVJenJuYnpzbXJEc29JRHJwYndnN0pxdzY2YXM2ckNBSU9xenFPdWR2T3lWdkNEdGxiVHNoSndnS2lycXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJT3lWaE91TGpDRHRnYXpyb2F6Q3QreVhvK3luZ09xd2dDRHNsN1RycHJEcmk2UXFLZzBLTHk4Z0lDQWdJQ0FvN0l1azdMaWhJT3lMb09xem9Eb2dJdXlabkNEdGdhenJvYXpzbkx6cm9ad2c3SmUwNjZDa0lpd2dJdXE0c091enVDRHJ1SXpybmJ6c21yRHNvSURyb1p3ZzdaV1k2NTI4NjR1STZybU1JaWt1SU9xeWpPdUxwT3F3Z0NEcXVMRHJzN2dnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJT3lMbk8yQnJPdW12dzBLTHk4Z0lDQWdJQ0RzbmJqc25wRHJwYndnNjZ5MDdJdWM3WldZNjZtMEtPeUN2T3lFc1NEc25ianRoTERyaExjZzdJdWs3TGloS1NEc25ienJzSmdnN0xDOTdKMjBJT3VXb0NEc2lybnNuYmdnN1ptVTY2bTA3SjIwSU9xM3VPdU0NCmdPdWhuT3VMcEM0TkNpOHZJT3EzdU91ZW1PeUVuQ0FxS2tKU1QxZFRSVkxycGJ3ZzZyRzA2NU9jNjZhczdLZUFJT3lWaXV1S2xPdUxwQ29xSU9LQWxDQmpiR0YxWkdVZ1EweEo2ckNBSU9xNHNPdXp1Q0RydUl6cm5ienNtckRzb0lEcnBid2c3SmUwNnJPZ0lHeHZZMkZzYUc5emRPdWhuQ0Rxc3JEcXM3enJwYndnN0o2UTY0K1pEUW92THlEc2lKanJvTG50bFp6cmk2UW83TDJVNjVPY0lPdTJtZXlYck91RW8rcTRzQ0RzbDRic25Zd3BMaURxczRUc29KVWc3S0NFN1ptWTdKMkFJT3lLdWV5ZHVDRHRtWlRycWJRZzdaV1k2NHVvSUZ2cXM0VHNvSlVnN0tDRTdabVlYU0Ryc29UdGlyenNuTHpyb1p3ZzdaV2M2NHVrTGcwS0x5OGdLaXJzbmJRZzZySzk2NkdjN0plUUlGVlNUQ0Rxc0lEcXM3WEN0K3lra2Vxd2hDRHNpcVR0Z2F6cnByM3RpcmpDdCt1NGpPdWR2T3lhc095Z2dDRHNwNERzb0pYc25ZUWc2NHVrN0l1Y0lPdUVvK3luZ0NEcnA1QWc2cktETGlvcURRb05DaTh2SU9LVWdPS1VnQ0JDVWs5WFUwVlNJT3F3DQpnT3Vobk95eGhPcTRzT3VLbENEc29KenFzYkRya0pEcmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVEkxS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFOQ2k4dklPeVlpT3lnaE95WGxDQkNVazlYVTBWU0lPMlptT3F5dmV1emdPeUltT3lYa0NEc25vVHNpNXdnN0lxazdZR3M2NmE5N1lxNDY2VzhJT3E5Z3V5VmhDQkRURW5xc0lBZzdLU0FJR0YxZEdodmNtbDZaU0JWVWt6c25ZUWc3SnF3NjZhczZyQ0FJT3V3bSt5VmhPeUVuQ0RzbDdUc2w0anJpNlF1RFFvdkx5RHJxcW5zb0lIc25ZQWc3WldZNjRLWTY3K1E3SjIwN0plSTY0dWtJT0tBbENEcXM0VHNvSlVnN0tDRTdabVk3SnFwN0p5ODY2R2NJRlZTVE95ZGhDQmpiR0YxWkdVdVlXa3ZiRzluYjNWMFAzSmxkSFZ5YmxSdlBlS0FwdXVobkNEc25xenNucEhzaExIdGxiUU5DaTh2SU95S3VleWR1Q0R0bVpUcnFiVHNuWVFnNnJHMDY0U0k2NXV3NnJPZ0lPcXpoT3lnbFNEc2hLRHRnNTBnN1ptVQ0KNjZtMDdKZVFJT3luZ2UyV2lleUxuTzJDcE9xNHNDNGc2cmU0SU95ZXJPeWVrZXlFc2V5ZGhDRHRqNURxdUxEdGxaanNucEFvN0lLczdKcXA3SjZRSU9xeXNPeWdsU2tnN1pXNDY1T2s2NStzNjRxVURRb3ZMeURycXFuc29JSHNuYlFnN0plRzdKYTA3S0dNNnJPZ0xDQXFLdXVDcU9xeXFDRHJrWkRycWJRZzdKaWs3WjZJNjZDa0lPdWhuT3EzdU95ZHVPeWRoQ0RycDUzcXNJRHJuS2pycHJEcmk2UXFLam9OQ2k4dklDQWdRMHhKNnJDQUlGVlNUT3lkaENEcmxMRHNtTFR0a1p3ZzdKZUc3SjIwSU91RW1PcTRzT3VwdENCamJXVHFzSUFnWUNaZzdKZVE3SVNjSUZWU1RPeWRoQ0RzbnBqcm5id2c2N0tFNjZDa0tPeWNpT3VQaE95YXNDa2dZMnhwWlc1MFgybGtJT3F3bWV5ZGdDRHJrcVRzcXIwTkNpOHZJQ0FnNjZlazZyQ2M2N09BN0lpWTZyQ0FJT3lDck91ZHZPeW5nT3F6b0N3ZzY3aU02NTI4N0pxdzdLQ0E3SmVVSUNMc25wanJxcnZya0p3Z1QwRjFkR2dnN0pxVTdMS3RJTUszSUdOc2FXVnVkRjlwWkNEcnA2VHENCnNKenJzNERzaUpqcXNJQWc2NGlFNjUyOTY1Q1k3SmVJN0lxMTY0dUk2NHVrSXVxd2dDRHJuS3pyaTZRdURRb3ZMeUFnSU95THJPMlZtT3VwdENEcnVJenJuYnpzbXJEc29JRHFzSUFnN0pXRTdKaUlJT3lWaUNEc2w3VHJwckRyaTZRbzdJdWs3TGloSURJd01qWXRNRGc2SUVOTVNTRHRsSVRyb1p6c2hManNpcVRyaXBRZzY0eUE2cml3SU95a2tleWR1T3VOc0NEc3NMM3NuYlFnN0pXSUlPdWN1Q2t1RFFvdkx5RHNuYlRzb0p3Z1FsSlBWMU5GVXV1bHZDRHFzYlRyazV6cnBxenNwNEFnN0pXSzY0cVU2NHVrSU9LR2tpQmpiR0YxWkdVZ1EweEo2ckNBSU9xNHNPdXp1Q0RydUl6cm5ienNtckRzb0lEcnBid2c3S2VCN0tDUklPeVhzT3VMcENoRFRFa2c2cml3NjdPNElPdVBtZXlla1NrdURRb3ZMeUFxS3V5ZHRDRHFzcjNyb1p6c2w1QWdWVkpNSU9xd2dPcXp0Y0szN0tTUjZyQ0VJT3lLcE8yQnJPdW12ZTJLdU91bHZDRHJpNlRzaTV3ZzY0U2o3S2VBSU91bmtDRHFzb011S2lvZzZyT0U3S0NWSU95Z2hPMlptT3lkDQpnQ0RzaXJuc25iZ2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjBnNjdLRTdZcTg3Snk4NjZHY0xnMEtEUW92THlEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJTzJVaE91aG5PeUV1T3lLcENBb1kyeGhkV1JsSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFTa2c0b0NVSUM5dmNHVnVMV3h2WjJsdTdKMjBJT3lEbmV5RXNjSzM2clNBNjZhc0xnMEtMeThnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJR3h2WTJGc2FHOXpkT3VobkNEcXNyRHFzN3pycGJ3ZzY3TzA2NEswN0tTRUlPdVZqT3E1ak95bmdDRHNpS2pzbHJUc2hKd2c2NHlBNnJpdzdaV1k2NHVrNnJDQUxDRHNtWVRybzR6cmtKanJxYlFnN0lxazdJcWs2NkdjSU91Qm5ldUNuT3VMcEM0TkNteGxkQ0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPdzBLYkdWMElHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2JuVnNiRHNOQ214bGRDQnNiMmRwYmxOMFlYSjBaV1JCZENBOUlEQTdJQzh2SU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqcw0KbmJnZzdJdWM3SjZSSU95TG5PcXdnU0RpZ0pRZzdKNnM3WUcwNjZhdDdKMjBJQ2ZzbnF6c2k1enJqNFFuN0oyNDdLZUFJQ2ZzbnBEcmo1bnNtWVRybzR3ZzdJdWs3WXlvSit5ZHVPeW5nQ0RxdGF6cnRvVHRsWnpyaTZRTkNpOHZJT3lkdE91eWlDRHJvWnpxdDdqc25ianNsNURzaEp3ZzY3aU02NTI4N0pxdzdLQ0FJT3l3dmV5ZGhDRHNpNlRzb0p6cm9ad2c2NTJFN0p1ZzY0cVU2ckNBSU9LQWxDRHRoTERycjdqcmhKQWc3WSswNjdDeDdKMkFJT3lkdE9xeWpDQm1ZV3h6WmV5ZHZDRHJsWXpycDR3ZzdKTzA2NHVrRFFvdkx5QW83SXVjNnJDRTY2ZU03Snk4NjZHY0lPMk1rT3VMcU8yVm1PdXB0Q0Rzb0pYc2c0RWc3SjZzN1lHMDY2YXQ3SmVRNjQrRUlHTnRaQ0Rzc0wzc25iUWc3WXFBN0phMDY0S1k3SmlvNjR1a0tRMEtiR1YwSUd4dloybHVWMmx1Wkc5M1QzQmxibVZrSUQwZ1ptRnNjMlU3RFFwbWRXNWpkR2x2YmlCcmFXeHNURzluYVc1UWNtOWpLQ2tnZXcwS0lDQnBaaUFvYkc5bmFXNVFjbTlqVkdsdFpYSXANCklIc2dZMnhsWVhKVWFXMWxiM1YwS0d4dloybHVVSEp2WTFScGJXVnlLVHNnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J1ZFd4c095QjlEUW9nSUdsbUlDZ2hiRzluYVc1UWNtOWpLU0J5WlhSMWNtNDdEUW9nSUdOdmJuTjBJSEFnUFNCc2IyZHBibEJ5YjJNN0RRb2dJR3h2WjJsdVVISnZZeUE5SUc1MWJHdzdEUW9nSUhSeWVTQjdEUW9nSUNBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzTkNpQWdJQ0FnSUM4dklIUnBiV1Z2ZFhRNklHdHBiR3hRY205ajZyTzhJT3F3bWV5ZGdDRHNuYlRzbktBZzRvQ1VJT3lpaGV1ampDRHFzcjNyb1p6c2w1RHNoSndnZEdGemEydHBiR3pzbmJRZzY2bUk3TGFVNjZtMElPdUxwT3Vtck9xd2dDRHNscnpzbHJUcnRwbnJpcFRyaTZRTkNpQWdJQ0FnSUhOd1lYZHVVM2x1WXlnbmRHRnphMnRwYkd3bkxDQmJKeTlRU1VRbkxDQlRkSEpwYm1jb2NDNXdhV1FwTENBbkwxUW5MQ0FuTDBZblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY3NJSFJwDQpiV1Z2ZFhRNklEUXdNREFzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcE93MEtJQ0FnSUgwZ1pXeHpaU0I3RFFvZ0lDQWdJQ0IwY25rZ2V5QndjbTlqWlhOekxtdHBiR3dvTFhBdWNHbGtMQ0FuVTBsSFZFVlNUU2NwT3lCOUlHTmhkR05vSUNoZlpUSXBJSHNnY0M1cmFXeHNLQ2s3SUgwTkNpQWdJQ0I5RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdXN0T3lMbkNBcUx5QjlEUXA5RFFvTkNpOHZJTzJFdENEcmo0VHNwSkVnN1lHMDY2R2M2NU9jSU8yVWhPdWhuT3lFdU95S3BPcXdnQ0Rzbzczc2w0anNuWVFnNjVXTTdKMllJT3lMcE8yTXFDRHJxWlRzaTV6c3A0QWc0b0NVSUhKMWJsUjFjbTdzbmJRZzdKMjBJT3VwbE95TG5PeW5nT3lkdkNEcmxZenJwNHdnTWUyYWpDRHNucERyajVrZzdKNnM3SXVjNjQrRTdaV2M2NHVrRFFwamIyNXpkQ0JUUlZOVFNVOU9YMFJKUlVRZ1BTQW43WUcwNjZHYzY1T2NJT3lFdU95Rm1PeWR0Q0Rzb29Ycm80enJrSkRzbHJUc21wUXVKenNOQ214bGRDQnphSFYwZEdsdQ0KWjBSdmQyNGdQU0JtWVd4elpUc2dMeThnTDNOb2RYUmtiM2R1SU95bmhPMldpU0RzcEpFZzRvQ1VJT3llck95TG5PdVBoT3VobkNEc2hManNoWmpzbllRZzY1Q1k3SUswNjZhczdLZUFJT3lWaXVxeWpDRHRrWnpzaTV3TkNnMEtMeThnY21WaGMyOXU3SjJFSU95anZPdXB0Q0FuN0oyWTY0K0U3S0NCSU95aWhldWpqQ2NvNnJPRTdLQ1ZJT3lnaE8yWm1NSzM2NkdjNnJlNDdKV0U3SnVESU91VHNTa2c0b0NVSU95bmhPMldpU0RzcEpIc25iVHJqWmdnN1lTMDdKMkVJT3EzdUNEcnFaVHNpNXpzcDREcm9ad2c2NEdkNjRLMDdJU2NEUW92THlCeWRXNVVkWEp1N0oyWUlGTkZVMU5KVDA1ZlJFbEZSQ0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95WW15RHNucERxc3Fuc3BwM3Jxb1hzbkx6cm9ad2c3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1yT3luZ0NEc2xZcnFzb3dnN1pXYzY0dWtMZzBLTHk4Z0tPeVZpQ0RxdDdqcm42enJxYlFnNnJPRTdLQ1ZJT3lnaE8yWm1DRHNwNEh0bTRRZzdKaWJJT3F6aE95Z2xTRHMNCmhManNoWmpzbmJRZzY3YUE3Wm1jN1pXMElFMUJXRjlVVlZKT1UrcTVqT3luZ0NEcXM0VHNobzBnN0pPdzdKMjA2NHFVSU91eWhPcTN1Q0RpZ0pRZ01qQXlOaTB3TnlEcnBxenJ0N0RzbDVEc2hKd2c3Wm1WN0oyNEtRMEtablZ1WTNScGIyNGdhMmxzYkZCeWIyTW9jbVZoYzI5dUtTQjdEUW9nSUdsbUlDaHdjbTlqS1NCN0RRb2dJQ0FnZEhKNUlIc05DaUFnSUNBZ0lHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2dJQ0FnSUNBZ0lDOHZJSE5vWld4c09uUnlkV1hyb1p3ZzY1MkU3SnVNN0lTY0lIQnliMlBzbllBZ1kyMWtJT3E3amV1TnNPcTRzQ0RpZ0pRZ0wxVHJvWndnN1lxNDY2YXM3S2U0SU95anZleVhyT3lWdkNEc3A0VHNwNXdnWTJ4aGRXUmw2ckNBSU9xem9PeVZoT3VobkNEc2xZZ2c2NEtvNjRxVTY0dWtEUW9nSUNBZ0lDQWdJQzh2SUNqcXM2RHNsWVFnWTJ4aGRXUmw2ckNBSU95RXBPeTVtQ0R0akl6c25ienNuWVFnNjZ5ODZyT2dJT3llaU95Y3ZPdXB0Q0R0DQpnYlRyb1p6cms1d2c3Sld4SU95WGhldU5zT3lkdE8yS3VPcXdnQ0FpN0lLczdKcXBJT3lra1NMc25MenJvWndnNjZlSjdaNllLUTBLSUNBZ0lDQWdJQ0F2THlEaW1xRHZ1SThnZEdsdFpXOTFkQ0R0bFlUc2lKZ2dLREl3TWpZdE1EZ2c3SXVrN0xpaEtUb2c3SjIwSUhOd1lYZHVVM2x1WSt1S2xDQndjbTlqWlhOekxtOXVLQ2RsZUdsMEp5bnNsNURzaEp6cmo0UWc2N2FJNjZhczY0cVU2NDJ3TEEwS0lDQWdJQ0FnSUNBdkx5RHNsWWdnN0tPOTY0cVVJR05zWVhWa1pTRHRpcmpycHF6cnBid2c2NmVNNjRLWUlIUmhjMnRyYVd4czdKMjBJT3VwaU95MmxPdXB0Q0FxS3V1THBPdW1yT3F3Z0NEc29vWHJvNHdnNjQrRTdLU1I3SmVRSU95V3ZPeVd0T3UybWV1S2xPdUxwQ29xSU9LQWxBMEtJQ0FnSUNBZ0lDQXZMeUR0ajZ6dGlyZ2dNVEU0T0Rqc25ZQWc2ck9FN0lhTklPdXN2T3F6b0NEc25aSHJpN1hzbllBZzY2cTdJTzJWbU91S2xDRHNnNEh0ZzV6cXNJQWc2NUNZN0phMExDRHNnNGdnN0oyNDdJcWs3WVMwN0lxaw0KNjRxVUlFVkJSRVJTU1U1VlUwWHJvWndnNjZ5ODY1K3M2NEtZNnJPZ0RRb2dJQ0FnSUNBZ0lDOHZJTzJVak91ZnJPcTN1T3lkdU95WGxDQWk3WUcwNjZHYzY1T2M2ckNBSU95WHNPdVBtZXVRbU95bmdDRHNsWXJzbFpqc2xyVHNtcFFpNjZlTUlPdWNyT3VMcENnME1PdTJoT3F3aENEcXQ3Z2c3SU9CN1lPYzdKaUE2NDJZSU95THBPeTRvU0RzZ3F6cm9ZQXBMZzBLSUNBZ0lDQWdJQ0J6Y0dGM2JsTjVibU1vSjNSaGMydHJhV3hzSnl3Z1d5Y3ZVRWxFSnl3Z1UzUnlhVzVuS0hCeWIyTXVjR2xrS1N3Z0p5OVVKeXdnSnk5R0oxMHNJSHNnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0IwYVcxbGIzVjBPaUEwTURBd0xDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNOQ2lBZ0lDQWdJSDBnWld4elpTQjdEUW9nSUNBZ0lDQWdJQzh2SUcxaFkwOVRMK3Vtck91SWhleUtwRG9nYzJobGJHdzZkSEoxWmV1ZHZDQndjbTlqN0oyMElITm9JT3E3amV1TnNPcTRzT3lkdkNEc2lKZ2c3SjZJN0oyTUlPS0FsQ0J6ZEdGeWRGQnkNCmIyUHNuWmdnWkdWMFlXTm9aV1Ryb1p3ZzY2ZU02NU9nRFFvZ0lDQWdJQ0FnSUM4dklPMlVoT3Vobk95RXVPeUtwQ0RxdDdqcm83a29MWEJwWkNuc25ZUWc3WWExN0tlNDY2R2NJT3lnbGV1bXJPMlZuT3VMcENBb2RHRnphMnRwYkd3Z0wxUWc2NHlBN0oyUktRMEtJQ0FnSUNBZ0lDQjBjbmtnZXlCd2NtOWpaWE56TG10cGJHd29MWEJ5YjJNdWNHbGtMQ0FuVTBsSFZFVlNUU2NwT3lCOUlHTmhkR05vSUNoZlpUSXBJSHNnY0hKdll5NXJhV3hzS0NrN0lIME5DaUFnSUNBZ0lIME5DaUFnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEcnJMVHNpNXdnS2k4Z2ZRMEtJQ0I5RFFvZ0lIQnliMk1nUFNCdWRXeHNPdzBLSUNCM1lYSnRaV1JWY0NBOUlHWmhiSE5sT3cwS0lDQnBaaUFvZDJGcGRHVnlLU0I3SUdOc1pXRnlWR2x0Wlc5MWRDaDNZV2wwWlhJdWRHbHRaWElwT3lCM1lXbDBaWEl1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWh5WldGemIyNGdmSHdnVTBWVFUwbFBUbDlFU1VWRUtTazdJSGRoYVhSbGNpQTlJRzUxDQpiR3c3SUgwTkNuME5DZzBLWm5WdVkzUnBiMjRnYzNSaGNuUlFjbTlqS0NrZ2V3MEtJQ0JyYVd4c1VISnZZeWdwT3cwS0lDQnNhVzVsUW5WbUlEMGdKeWM3RFFvZ0lIUjFjbTV6SUQwZ01Ec05DaUFnTHk4ZzdKMjBJT3lFdU95Rm1PeWR0Q0RzbHJUcmlwQWc2ck9FN0tDVjdKMllJT3llaGV5ZXBlcTJqT3ljdk91aG5DRHJqNFRyaXBUc3A0QWc2cml3NjZHZElPS0FsQ0Ryc0pic2w1RHNoSndnNnJPRTdLQ1Y3SjIwSU91d2xPdUFqT3lYaU91S2xPeW5nQ0RydVlUcXRaRHRsWmpyaXBRZzZyaXc3S1NBRFFvZ0lITmxjM05wYjI1QlkyTnZkVzUwSUQwZ1kyeGhkV1JsUVdOamIzVnVkQ2dwT3cwS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RzaTV6cmo1a2c3S1NSNG9DbUlDanJxcWpyamJnNklDY2dLeUJqZFhKeVpXNTBUVzlrWld3Z0t5QW5LU2NwT3cwS0lDQmpiMjV6ZENCMGFHbHpVSEp2WXlBOUlITndZWGR1S0NkamJHRjFaR1VuTENCYkp5MXdKeXdnSnkwdA0KYlc5a1pXd25MQ0JqZFhKeVpXNTBUVzlrWld3c0lDY3RMV2x1Y0hWMExXWnZjbTFoZENjc0lDZHpkSEpsWVcwdGFuTnZiaWNzSUNjdExXOTFkSEIxZEMxbWIzSnRZWFFuTENBbmMzUnlaV0Z0TFdwemIyNG5MQ0FuTFMxMlpYSmliM05sSjEwc0lIc05DaUFnSUNCemFHVnNiRG9nZEhKMVpTd2dZM2RrT2lCRlRWQlVXVjlEVjBRc0lHVnVkam9nUTB4QlZVUkZYMFZPVml3TkNpQWdJQ0JrWlhSaFkyaGxaRG9nY0hKdlkyVnpjeTV3YkdGMFptOXliU0FoUFQwZ0ozZHBiak15Snl3Z0x5OGdVRTlUU1ZnNklPeWVrT3E0c0NEdGxJVHJvWnpzaExqc2lxUWc2cmU0NjZPNUlPeURuZXlFc1NEaWdKUWdhMmxzYkZCeWIyUHNuYlFnNnJlNDY2TzU3S2U0SU95Z2xldW1yTzJWb0NEc2lKZ2c3SjZJNnJLTURRb2dJSDBwT3cwS0lDQndjbTlqSUQwZ2RHaHBjMUJ5YjJNN0RRb2dJSEJ5YjJNdWMzUmtiM1YwTG05dUtDZGtZWFJoSnl3Z0tHUXBJRDArSUhzTkNpQWdJQ0JzYVc1bFFuVm1JQ3M5SUdRdWRHOVRkSEpwYm1jb0ozVjANClpqZ25LVHNOQ2lBZ0lDQnNaWFFnYVdSNE93MEtJQ0FnSUhkb2FXeGxJQ2dvYVdSNElEMGdiR2x1WlVKMVppNXBibVJsZUU5bUtDZGNiaWNwS1NBaFBUMGdMVEVwSUhzTkNpQWdJQ0FnSUdOdmJuTjBJR3hwYm1VZ1BTQnNhVzVsUW5WbUxuTnNhV05sS0RBc0lHbGtlQ2t1ZEhKcGJTZ3BPdzBLSUNBZ0lDQWdiR2x1WlVKMVppQTlJR3hwYm1WQ2RXWXVjMnhwWTJVb2FXUjRJQ3NnTVNrN0RRb2dJQ0FnSUNCcFppQW9JV3hwYm1VcElHTnZiblJwYm5WbE93MEtJQ0FnSUNBZ2JHVjBJR1YySUQwZ2JuVnNiRHNOQ2lBZ0lDQWdJSFJ5ZVNCN0lHVjJJRDBnU2xOUFRpNXdZWEp6WlNoc2FXNWxLVHNnZlNCallYUmphQ0FvWDJVcElIc2dZMjl1ZEdsdWRXVTdJSDBOQ2lBZ0lDQWdJR2xtSUNobGRpQW1KaUJsZGk1MGVYQmxJRDA5UFNBbmNtVnpkV3gwSnlBbUppQjNZV2wwWlhJcElIc05DaUFnSUNBZ0lDQWdZMjl1YzNRZ2R5QTlJSGRoYVhSbGNqc05DaUFnSUNBZ0lDQWdkMkZwZEdWeUlEMGdiblZzYkRzTkNpQWdJQ0FnDQpJQ0FnWTJ4bFlYSlVhVzFsYjNWMEtIY3VkR2x0WlhJcE93MEtJQ0FnSUNBZ0lDQnBaaUFvWlhZdWFYTmZaWEp5YjNJcElIc05DaUFnSUNBZ0lDQWdJQ0JqYjI1emRDQnlZWGNnUFNCVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElHVjJMbk4xWW5SNWNHVWdmSHdnSnljcExuTnNhV05sS0RBc0lESXdNQ2s3RFFvZ0lDQWdJQ0FnSUNBZ0x5OGc3WldjNjQrRUlPeTBpT3F6dk91bHZDRHJxTHpzb0lBZzY3TzQ2NHVrSU9LQWxDRHJvWnpxdDdqc25iZ2c3SmlrNjZXWUlPeWdsZXEzbk95TG5leWR0Q0RyaEpQc2xyVHNoSndvYkc5bklEOXBiaURyazdFcElPdXN1T3Exck9xd2dDRHJzSlRyZ0l6cnFiUWc3SUs4N1lLc0lPeUltQ0Rzbm9qcmk2UU5DaUFnSUNBZ0lDQWdJQ0JwWmlBb2FYTk1hVzFwZEVWeWNtOXlLSEpoZHlrcElIc05DaUFnSUNBZ0lDQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiR2x0YVhRbk95QXZMeUF2YUdWaGJIUm82NkdjSU95VmpPdW12Q0RpaHBJZzY3S0U3WXE4N0oyMA0KSUZ2dGxaenJqNFFnN0xTSTZyTzhYZXVobkNEcnNKVHJnSXpxczZBZzZyT0U3S0NWSU95Z2hPMlptT3lkaENEc2xZanJnclFOQ2lBZ0lDQWdJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnN0lLczdKcXBJTzJWbk91UGhDRHN0SWpxczd3ZzZyQ1E3S2VBT2ljc0lISmhkeWs3RFFvZ0lDQWdJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9URWxOU1ZSZlIxVkpSRVVwS1RzTkNpQWdJQ0FnSUNBZ0lDQjlJR1ZzYzJVZ2FXWWdLR2x6UVhWMGFFVnljbTl5S0hKaGR5a3BJSHNOQ2lBZ0lDQWdJQ0FnSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNkamJHRjFaR1V0Ykc5bmIzVjBKenNnTHk4Z0wyaGxZV3gwYU91aG5DRHRsSXpybjZ6cXQ3anNuYmpzbDVBZzdKV002NmE4SU9LR2tpRHJzb1R0aXJ6c25iUWdXK3Vobk9xM3VPeWR1Q0R0bFlUc21wUmQ2NkdjSU91d2xPdUFuQTBLSUNBZ0lDQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmQNCklPMkJ0T3Vobk91VG5DRHJvWnpxdDdqc25iZ2c2NmVNNjZPTUlPcXdrT3luZ0RvbkxDQnlZWGNwT3cwS0lDQWdJQ0FnSUNBZ0lDQWdkeTV5WldwbFkzUW9ibVYzSUVWeWNtOXlLRXhQUjBsT1gwZFZTVVJGS1NrN0RRb2dJQ0FnSUNBZ0lDQWdmU0JsYkhObElIc05DaUFnSUNBZ0lDQWdJQ0FnSUhjdWNtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdZRzA2NkdjNjVPY0lPeVlwT3VsbURvZ0p5QXJJSEpoZHlrcE93MEtJQ0FnSUNBZ0lDQWdJSDBOQ2lBZ0lDQWdJQ0FnZlNCbGJITmxJSHNOQ2lBZ0lDQWdJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0FuYjJzbk95QXZMeURzaExIcXM3VWdQU0RzaEtUc3VaakN0K3Vobk9xM3VPeWR1Q0RyaTZRZzdLQ1Y3SU9CSU9LQWxDRHNsclRybHFRZ2NISnZZbXhsYmV5ZHRPdVRvQ0R0bGJUc29Kd2dLT3llck91aG5PcTN1T3lkdUMvc25xenNoS1RzdVpnZzY3TzE2cmVBS1EwS0lDQWdJQ0FnSUNBZ0lIY3VjbVZ6YjJ4MlpTaFRkSEpwYm1jb1pYWXVjbVZ6ZFd4MElIeDhJQ2NuDQpLU2s3RFFvZ0lDQWdJQ0FnSUgwTkNpQWdJQ0FnSUgwTkNpQWdJQ0I5RFFvZ0lIMHBPdzBLSUNCd2NtOWpMbk4wWkdWeWNpNXZiaWduWkdGMFlTY3NJQ2hrS1NBOVBpQjdEUW9nSUNBZ1kyOXVjM1FnY3lBOUlHUXVkRzlUZEhKcGJtY29KM1YwWmpnbktTNTBjbWx0S0NrN0RRb2dJQ0FnYVdZZ0tITWdKaVlnSVhNdWFXNWpiSFZrWlhNb0owUmxjSEpsWTJGMGFXOXVWMkZ5Ym1sdVp5Y3BLU0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZ1kyeGhkV1JsSUhOMFpHVnljam9uTENCekxuTnNhV05sS0RBc0lESXdNQ2twT3cwS0lDQjlLVHNOQ2lBZ2NISnZZeTV2YmlnblkyeHZjMlVuTENBb1kyOWtaU2tnUFQ0Z2V3MEtJQ0FnSUM4dklPeWR0T3V2dUNEc2c0Z2c3SVM0N0lXWTdKeTg2NkdjSU9xMWtPeXl0T3VRbkNEcmtxUWc3SmliSU95RXVPeUZtT3lkdENEcmk2dnRub3dnNnJHdzY2bTBJT3VzdE95TG5DQW82NnFvNjQyNElPeWdoTzJabUNEc2k1d2c3SU9JSU95RXVPeUZtT3lkaENEc283M3NuYlRzcDRBZw0KN0pXSzZyS01LUTBLSUNBZ0lHbG1JQ2h3Y205aklDRTlQU0IwYUdselVISnZZeWtnY21WMGRYSnVPdzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0Z2JUcm9aenJrNXdnN0lTNDdJV1lJT3lpaGV1ampDQW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BJT0tBbENEcmk2VHNuWXdnN0pxVTdMS3RJT3VWakNEcmk2VHNpNXdnN0l1YzY0K1o3WldwNjR1STY0dWtMaWNwT3cwS0lDQWdJR3RwYkd4UWNtOWpLQ2s3RFFvZ0lIMHBPdzBLZlEwS0RRcG1kVzVqZEdsdmJpQnpaVzVrVkhWeWJpaDBaWGgwS1NCN0RRb2dJSEpsZEhWeWJpQnVaWGNnVUhKdmJXbHpaU2dvY21WemIyeDJaU3dnY21WcVpXTjBLU0E5UGlCN0RRb2dJQ0FnYVdZZ0tDRndjbTlqS1NCeVpYUjFjbTRnY21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkdENEc2w0YnNsclRzbXBRdUp5a3BPdzBLSUNBZ0lHbG1JQ2gzWVdsMFpYSXBJSEpsZEhWeWJpQnlaV3BsWTNRb2JtVjNJRVZ5Y205eUtDZnMNCmxaN3NoS0FnN0pxVTdMS3Q3SjIwSU95bmhPMldpU0RzcEpIc25iVHNsNURzbXBRdUp5a3BPdzBLSUNBZ0lHTnZibk4wSUhScGJXVnlJRDBnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUI3RFFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZUzBJT3lMbk9xd2hDRHN0SWpxczd3ZzRvQ1VJT3lFdU95Rm1PeWRoQ0RzbnF6c2k1enNucEh0bGFucmk0anJpNlF1SnlrN0RRb2dJQ0FnSUNBdkx5RHNpNXpxc0lRZzdMU0k2ck84NjRxVUlDZnNoTGpzaFpnZzdLS0Y2Nk9NSit5WmdDRHF0YXpydG9UcmtKanJpcFFnN0tDY0lPdXBsT3lMbk95bmdPdWhuQ0RyZ1ozcmdyanJpNlFnNG9DVUlHdHBiR3hRY205ajdKMllJT3lFdU95Rm1DRHNvb1hybzR3Z2NtVnFaV04wNnJDQURRb2dJQ0FnSUNBdkx5QnlkVzVVZFhKdTdKMllJT3lla091UG1TRHNucXpzaTV6cmo0VHJwYndnNjdhQTY2VzA2Nm0wSU95VmlDRHJrSmpxdUxBZzY1V002Nnk0S091S2tPdW1zQ0R0aExUc25ZUWc2NUdRSU91eWlDRHJqNHpyDQpxYlFnN1pTTTY1K3M2cmU0N0oyNElERXpNT3kwaUNEc29KenRsWnpzbllRZzY0U1k2cmkwNjR1a0tRMEtJQ0FnSUNBZ2FXWWdLSGRoYVhSbGNpa2dldzBLSUNBZ0lDQWdJQ0JqYjI1emRDQjNJRDBnZDJGcGRHVnlPeUIzWVdsMFpYSWdQU0J1ZFd4c093MEtJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9KKzJCdE91aG5PdVRuQ0RzblpIcmk3WHNuYlFnNjRTSTY2eTBJT3lZcE91ZW1DRHFzYmpyb0tRZzdKcVU3TEt0N0oyRUlPeWtrZXVMcU8yV2lPeVd0T3lhbENEaWdKUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeWtwT3cwS0lDQWdJQ0FnZlEwS0lDQWdJQ0FnYTJsc2JGQnliMk1vS1RzTkNpQWdJQ0I5TENCVVZWSk9YMVJKVFVWUFZWUmZUVk1wT3cwS0lDQWdJSGRoYVhSbGNpQTlJSHNnY21WemIyeDJaU3dnY21WcVpXTjBMQ0IwYVcxbGNpQjlPdzBLSUNBZ0lIQnliMk11YzNSa2FXNHVkM0pwZEdVb1NsTlBUaTV6ZEhKcGJtZHBabmtvZXlCMGVYQmxPaUFuZFhObA0KY2ljc0lHMWxjM05oWjJVNklIc2djbTlzWlRvZ0ozVnpaWEluTENCamIyNTBaVzUwT2lCMFpYaDBJSDBnZlNrZ0t5QW5YRzRuTENBbmRYUm1PQ2NwT3cwS0lDQjlLVHNOQ24wTkNnMEtMeThnNnJDWjdKMkFJT3VzdU9xMXJPdWx2Q0RycW9jZzY3S0k3S2U0SU91c3UrdUtsT3luZ0NEcXVMRHNsclVnNG9DVUlPeWVyT3lhbE95eXJleWR0T3VwdENBaTdKMjA3S0NFNnJPOElPdUxwT3VsdUNEc2c0Z2c3S0NjN0pXSUl1eWRoQ0RzbXBUcXRhenRsWnpyaTZRTkNpOHZJQ2pzbFlnZzZyZTQ2NStzNjZtMElPMkJ0T3Vobk91VG5PcXdnQ0RzaExIc2k2VHRsWmpxc293ZzZyQ1o3SjJBSU91THRleWRoQ0RybUpBZzY0SzA3SVNjSUZ0QlNTRHN0cFRzc3B3ZzY0MlVJT3V3bStxNHNGM3FzSUFnNjZ5MDdKMlk2Nis0N1pXMDdLZUU2NHVrS1EwS1kyOXVjM1FnWVhOclpXUkRiM1Z1ZENBOUlHNWxkeUJOWVhBb0tUc05DZzBLTHk4ZzdJUzQ3SVdZSU95a2dPdTVoQ2pzaTV6cmo1a3I3S2VBN0l1YzY2eTRJT3lqdk95ZWhTbnINCnBid2c2N08wN0o2bDdaV2NJT3VTcENEdGxad2c3WVMwSU95THBPMldpU0RpZ0pRZzY2cW82NU9nSU8yWXVPeTJuT3lkZ0NCeGRXVjFaZXVobkNEc3A0SHJvS3p0bVpRdURRb3ZMeUJ0YjJSbGJPeWRoQ0Rzbzd6cnFiUWc2cmU0SU91cXFPdU51T3VobkNBbzY0dWs2NlcwNjZtMElPeUV1T3lGbUNEc25xenNpNXpzbnBFcExpRHRsWndnNjZxbzY0MjQ3SjJFSU9xemhPeUdqU0RzazdEcnFiUWc3SjZzN0l1YzdKNlI3SjJBSU95MW5PeTBpQ0F4N1pxTTY3K1FMZzBLTHk4Z2NtVndZWEp6WlQxN2NHRnljMlVzSUdadmNtMWhkRVJsYzJOOTY2VzhJT3lqdk91cHRDRHRqSXpzaTdIcXVZenNwNEFnN0oyMElPeWVvU0RzbFlqc2w1RHNoSndnN0xLWTY2YXM3WldZNnJPZ0lIdHlZWGNzSUhCaGNuTmxaSDNycGJ3ZzY0K002NkNrN0tTQTY0dWtPZzBLTHk4ZzdaaVY3SXVkSU95ZHRPMkRpQ0RzaTV3ZzZyQ1o3SjJBSU95RXVPeUZtT3lYa0NBaTdaaVY3SXVkNjR5QTY2R2NJT3VMcE95TG5DTHJwYndnN0pxVTZyV3M3WldZDQo2NHFVSU95ZXJPeWFsT3l5clNEdGhMVHNuWVFnS2lycXNKbnNuWUFnN1lHUUlPeWVvU0RzbFlqc2w1RHNoSndxS2lEcnRwbnNuYmpyaTZRdURRb3ZMeURyczRUcmo0UWc3SjZoN0p5ODY2R2NJT3U1dk91cHRDQW9ZU2tnN0lLczdKMjA3SmVRSU91THBPdWx1Q0RzbXBUc3NxMGc3WVMwN0oyMElPdUJ2T3lXdENBbjY3Q3A2cmlJSU91THRTZnNuYlFnNjRLbzdKMllJT3VMdGV5ZHRDRHJrSmpxczZBbzY0SzA3SnFwSU95WXBPeVh2Q2tzRFFvdkx5QW9ZaWtnVFVGWVgxUlZVazVUSU9xeXZlcXpoT3lYa095RW5DRHNoTGpzaFpqc25iUWc3SjZzN0l1YzdKNlI2NCs4SUNmcnNLbnF1SWdnNjR1MUoreWR0Q0RzbDRicmlwUWc3SU9JSU95RXVPeUZtT3lkdENEcmdyVHNtcW5zbllRZzdLZUE3SmEwNjRLOElPeUltQ0Rzbm9qcmk2UWdLREl3TWpZdE1EY2c2NmFzNjdldzdKZVE3SVNjSU8yWmxleWR1Q2t1RFFwamIyNXpkQ0JTUlZCQlVsTkZYMEpCUkNBOUlDaDJLU0E5UGlCMklEMDlJRzUxYkd3Z2ZId2dLRUZ5Y21GNQ0KTG1selFYSnlZWGtvZGlrZ0ppWWdkaTVzWlc1bmRHZ2dQVDA5SURBcE93MEtablZ1WTNScGIyNGdjblZ1VkhWeWJpaGlkV2xzWkVGemF5d2diVzlrWld3c0lISmxjR0Z5YzJVcElIc05DaUFnWTI5dWMzUWdhbTlpSUQwZ2NYVmxkV1V1ZEdobGJpaGhjM2x1WXlBb0tTQTlQaUI3RFFvZ0lDQWdZMjl1YzNRZ2FtOWlVM1JoY25RZ1BTQkVZWFJsTG01dmR5Z3BPeUF2THlEc2k1enFzSVFnN0ppSTdJS3dJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3S3E5SU95Z25PMlZuQ2d4TXpEc3RJZ3A3SjJFSU91RW1PcTR1Q0RzbnF6c2k1enJqNFRyaXBRZzdZK3M2cml3N1pXYzY0dWtEUW9nSUNBZ2FXWWdLRzF2WkdWc0lDWW1JRUZNVEU5WFJVUmZUVTlFUlV4VExtbHVaR1Y0VDJZb2JXOWtaV3dwSUNFOVBTQXRNU0FtSmlCdGIyUmxiQ0FoUFQwZ1kzVnljbVZ1ZEUxdlpHVnNLU0I3RFFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzY2cW82NDI0SU91emdPcXl2VG9nSnlBcklHTjFjbkpsYm5STmIyUmwNCmJDQXJJQ2NnNG9hU0lDY2dLeUJ0YjJSbGJDazdEUW9nSUNBZ0lDQmpkWEp5Wlc1MFRXOWtaV3dnUFNCdGIyUmxiRHNOQ2lBZ0lDQWdJSE4wWVhKMFVISnZZeWdwT3lBdkx5RHNnNGdnNjZxbzY0MjQ2NkdjSU95RXVPeUZtQ0RzbnF6c2k1enNucEVnS091THBPeWRqQ0RzbTR6cnNJM3NsNFhzbDVEc2hKd2c3S2VBN0l1YzY2eTRJT3llck95anZPeWVoU2tOQ2lBZ0lDQjlEUW9nSUNBZ2FXWWdLSFIxY201eklENDlJRTFCV0Y5VVZWSk9VeUI4ZkNBaGNISnZZeWtnYzNSaGNuUlFjbTlqS0NrN0RRb2dJQ0FnYVdZZ0tDRjNZWEp0WldSVmNDa2dldzBLSUNBZ0lDQWdZMjl1YzNRZ2REQWdQU0JFWVhSbExtNXZkeWdwT3cwS0lDQWdJQ0FnWVhkaGFYUWdjMlZ1WkZSMWNtNG9hVzV6ZEhKMVkzUnBiMjVOWlhOellXZGxLQ2twT3cwS0lDQWdJQ0FnZDJGeWJXVmtWWEFnUFNCMGNuVmxPdzBLSUNBZ0lDQWdkSFZ5Ym5Nckt6c05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haZ2c3S1NBDQo2N21FSU95WmhPdWpqQ0FvSnlBcklDZ29SR0YwWlM1dWIzY29LU0F0SUhRd0tTQXZJREV3TURBcExuUnZSbWw0WldRb01Ta2dLeUFuY3lrZzRvQ1VJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2N21vNjUyODdKcVVMaWNwT3cwS0lDQWdJSDBOQ2lBZ0lDQjBkWEp1Y3lzck93MEtJQ0FnSUdOdmJuTjBJR0Z6YXlBOUlHSjFhV3hrUVhOcktDazdJQzh2SU95ZXJPeUxuT3VQaENEcmxZd2c2ckNaN0oyQUlPeW5pT3VzdU95ZGhDRHJpNlRzaTV3ZzdKTzA2NHVrSUNoaGMydGxaRU52ZFc1MElPeWR0T3lra1NEc3BwM3FzSUFnNjdDcDdLZUFLUTBLSUNBZ0lHeGxkQ0J5WVhjN0RRb2dJQ0FnZEhKNUlIc05DaUFnSUNBZ0lISmhkeUE5SUdGM1lXbDBJSE5sYm1SVWRYSnVLR0Z6YXlrN0RRb2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3MEtJQ0FnSUNBZ0x5OGc3WVMwSU91UGhPeWtrU0R0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lqdmV5ZGdDRHFzcjNzbXJBb1UwVlRVMGxQVGw5RVNVVkVLU0F4N1pxTQ0KSU95ZWtPdVBtU0RzbnF6c2k1enJqNFFnNG9DVUlPeUNyT3lhcWV5ZWtPeVhrT3F5a0NEc2k2VHRqS2pyb1p3ZzdKV0lJT3V6dE95ZHRPcXlqQzROQ2lBZ0lDQWdJQzh2SU95TG5PcXdoQ0RzdElqcXM3ekN0K3Vobk9xM3VPeWR1Q0RycDR6cm80ekN0KzJCdE91aG5PdVRuQ0RzbUtUcnBaakN0K3lkbU91UGhPeWdnU0Rzb29Ycm80d282ck9FN0tDVklPeWdoTzJabUMvcm9aenF0N2pzbFlUc200TXNJR3RwYkd4UWNtOWpLSEpsWVhOdmJpa3A2NHFVRFFvZ0lDQWdJQ0F2THlEc29Kd2c2Nm1VN0l1YzdLZUE2ckNBSU91VXNPdWhuQ0Rzbm9qc2xyUWc3SmVzNnJpd0lPeVZpQ0Rxc2JqcnByRHJpNlF1SU95aWhldWpqQ0RzbXBUc3NxMGc3S1NSN0oyMDZyR3c2NEtZSU95TG5PcXdoQ0RzbUlqc2dyRHNuYlFnN0phODY2ZUlJT3lWaUNEcmdxanNsWmpzbkx6cnFiUWc2NUNZN0lLMDY2YXM3S2VBSU95Vml1dUtsT3VMcEM0TkNpQWdJQ0FnSUdsbUlDaHphSFYwZEdsdVowUnZkMjRnZkh3Z0lTaGxJQ1ltSUdVdWJXVnoNCmMyRm5aU0E5UFQwZ1UwVlRVMGxQVGw5RVNVVkVLU0I4ZkNCRVlYUmxMbTV2ZHlncElDMGdhbTlpVTNSaGNuUWdQaUEwTURBd01Da2dkR2h5YjNjZ1pUc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzaExqc2haanNuYlFnN1lTMElPdVBoT3lra1NEcmdZcnF1WUFnNG9DVUlPeWVyT3lMbk91UG1TRHRtNFFnTWUyYWpDRHNucXpzaTV6cmo0VHRsYW5yaTRqcmk2UXVKeWs3RFFvZ0lDQWdJQ0J6ZEdGeWRGQnliMk1vS1RzTkNpQWdJQ0FnSUdGM1lXbDBJSE5sYm1SVWRYSnVLR2x1YzNSeWRXTjBhVzl1VFdWemMyRm5aU2dwS1RzTkNpQWdJQ0FnSUhkaGNtMWxaRlZ3SUQwZ2RISjFaVHNOQ2lBZ0lDQWdJSFIxY201eklEMGdNanNnTHk4ZzdKdU02N0NON0plRklERWdLeURzbmJUcnNvZ2c3WVMwSUNoemRHRnlkRkJ5YjJQc25iUWdNT3ljdk91aG5DRHN0SWpxdUxEdG1aUXBEUW9nSUNBZ0lDQnlZWGNnUFNCaGQyRnBkQ0J6Wlc1a1ZIVnliaWhoYzJzcE93MEtJQ0FnSUgwTkNpQWdJQ0JwDQpaaUFvSVhKbGNHRnljMlVwSUhKbGRIVnliaUJ5WVhjN0RRb2dJQ0FnYkdWMElIQmhjbk5sWkNBOUlISmxjR0Z5YzJVdWNHRnljMlVvY21GM0tUc05DaUFnSUNBdkx5RHRtSlhzaTUwZzdKMjA3WU9JN0oyMDY2bTBJT3F3bWV5ZGdDRHNoTGpzaFpqQ3QrcXdtZXlkZ0NEc25xSHNsNURzaEp3ZzZyT243SjZsSU95ZXJPeWFsT3l5clNEaWdKUWc3SjIwSU8yRXRPeWR0Q0Rzbzczc25MenJxYlFnN0lPSUlPeUV1T3lGbU95ZGdDQW42N0NwNnJpSUlPdUx0U2ZzbllRZzY2cXc2NTI4RFFvZ0lDQWdMeThnN0tlQTdKYTA2NEs4SU95SW1DRHNub2pzbkx6cnI0RHJvWndnN0lTNDdJV1lJT3lDck91bm5TRHNucXpzaTV6cmo0VHJpcFFnN1pXWTdLZUFJT3lWaXVxem9DRHF0N2pyaklEcm9ad2c3SXVrN1l5bzdJdWM3WUtvNjR1a0tPMk1qT3lMc1NEc2k2VHRqS2pyb1p3ZzZyZUE2ckt3S1M0TkNpQWdJQ0JwWmlBb1VrVlFRVkpUUlY5Q1FVUW9jR0Z5YzJWa0tTQW1KaUJFWVhSbExtNXZkeWdwSUMwZ2FtOWlVM1JoY25RZw0KUENBM01EQXdNQ2tnZXcwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMk1qT3lMc1NEc2k2VHRqS2dnNG9DVUlPMllsZXlMblNEc25xenNtcFRzc3EwNkp5d2dVM1J5YVc1bktISmhkeWt1YzJ4cFkyVW9NQ3dnTXpBd0tTazdEUW9nSUNBZ0lDQjBkWEp1Y3lzck93MEtJQ0FnSUNBZ2RISjVJSHNOQ2lBZ0lDQWdJQ0FnY21GM0lEMGdZWGRoYVhRZ2MyVnVaRlIxY200b0ordXdxZXE0aUNEcmk3WHNuYlFnN0pxVTZyV3M3WldjSU8yWWxleUxuZXlYa0NEc2xyVHF1SXZyZ3F6cmk2UXVJT3V3cWVxNGlDRHJpN1h0bFp3ZzY0SzA3SnFwN0oyRUlPeUVwT3VxaGNLMzdJS3M2ck84d3Jmc3ZaVHJrNXp0anB6c2lxUWc3SmVHN0oyMElPeVZoT3VlbUNCS1UwOU83Snk4NjZHYzY2ZU1JT3VMcE95TG5DRHN0cHpyb0tYdGxaanJuYnc2SUNjZ0t5QnlaWEJoY25ObExtWnZjbTFoZEVSbGMyTXBPdzBLSUNBZ0lDQWdJQ0J3WVhKelpXUWdQU0J5WlhCaGNuTmxMbkJoY25ObEtISmhkeWs3RFFvZ0lDQWcNCklDQjlJR05oZEdOb0lDaGZaU2tnZXlBdktpRHNucXpzbXBUc3NxMGc3SXVrN1l5b0lPS0FsQ0RzbFlUcm5wanNsNURzaEp3ZzdZeU03SXV4SU95THBPMk1xT3VobkNEc3NwanJwcXdnS2k4Z2ZRMEtJQ0FnSUgwTkNpQWdJQ0JwWmlBb1VrVlFRVkpUUlY5Q1FVUW9jR0Z5YzJWa0tTa2dZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yTWpPeUxzU0RzaTZUdGpLZ2dLT3llck95YWxPeXlyU0R0bTRUc2w1RHJqNFFwT2ljc0lGTjBjbWx1WnloeVlYY3BMbk5zYVdObEtEQXNJRE13TUNrcE93MEtJQ0FnSUhKbGRIVnliaUI3SUhKaGR5d2djR0Z5YzJWa09pQlNSVkJCVWxORlgwSkJSQ2h3WVhKelpXUXBJRDhnYm5Wc2JDQTZJSEJoY25ObFpDQjlPdzBLSUNCOUtUc05DaUFnTHk4ZzdaV2NJT3lhbE95eXJleWR0Q0RzaTZUdGpLanRsYlRyajRRZzY0dWs3SjJNSU95YWxPeXlyZXlkdENEc25iVHNsclRzcDREcmo0VHJvWjBnN1lHUTY0cVVJTzJWcmV5RGdTRHNoTEhxczdYc25MenJvWndnN0tDVjY2YXNEUW9nDQpJSEYxWlhWbElEMGdhbTlpTG1OaGRHTm9LQ2dwSUQwK0lIdDlLVHNOQ2lBZ2NtVjBkWEp1SUdwdllqc05DbjBOQ2cwS0x5OGc2N0tFN1lxOElPdWR2T3V5cUNEcXQ1enN1WmtnNG9DVUlPMlVqT3Vmck9xM3VPeWR1T3lkdENBbjY3S0U3WXE4N0oyRUlPcXpxT3Vla091THBDZnFzNkFnN0pXTTY2Q2s3S1NFSU91VmpPdW5qQ0RzbHJucmlwVHJpNlF1RFFvdkx5RHJzb1R0aXJ3ZzY2eTQ2cldzNjRxVUlPdXN1T3llcGV5ZHRDRHNsWVRyaTRqcm5id2c2NCtaN0o2UklPeWR0T3VtaE95ZHRPeVd0T3lFbkN3ZzdKMjBJT3luZ095TG5PcXdnQ0RzbDRic25MenJxYlFnNjZ5NDdKNmw3WmlWSU91TWdPeVZpT3lkdENEc2hKN3NsNndnNjRLWTdKaW82NHVrTGcwS1kyOXVjM1FnUWxWVVZFOU9YMUpWVEVVZ1BRMEtJQ0FuN0oyMElPdXN1T3Exck91S2xDQXFLdXV5aE8yS3ZDRHJuYnpyc3FncUt1eWR0T3VMcEM0ZzY2eTQ3SjZsN0oyMElPeVZoT3VMaU91ZHZDRHJqNW5zbnBFZzdKMjA2NmFFN0oyMDY2K0E2NkdjT2lEcg0KcDRqc3VhanRrWnpDdCt1c3ZPeWRqTzJSbk1LMzdLS0Y2ckt3N0phMDY2KzRLSDdzbXBRdmZ1dUxwQzkrNnJtTTdKcVVLU0RxdUlqc3A0QXNJQ2NnS3cwS0lDQW42NUNZNjQrRTY2R2RJT3lucCt5ZGdDRHJqNW5zbnBFZzY2cUY3SUtzS095Z2dPeWVwY0szN0lLdDdLQ2N3cmZzbDdEcXNyQWc3WlcwN0tDY0lPdVRzU25yb1p3c0lPMkd0ZXV6dE95RXNTRHJpNmpzbmJ3ZzY3S0U3WXE4N0oyMDY2bTBJQ0x0bVpYc25iZ2lMaUFuSUNzTkNpQWdKeUxzdDZqc2hvd2k2NHFVSU91UG1leWVrU0Ryc29UdGlyenFzN3dnN0tlZDdKMjhJT3VWak91bmpDRHNrN0RxczZBc0lPMlpsT3VwdENEcXVMRHJpcVhycW9VbzY3T0E2cks5d3JmdGxiVHNvSndnNjVPeEtleWRnQ0RxdDdqcmpJRHJvWndnNjVHVTY0dWtMbHh1SnpzTkNnMEtMeThnNjZ5NDZyV3NJT3kybE95eW5DRHRoTFFnS0hKdmJHVTlKK3V5aE8yS3ZDZnNuYlRycWJRZzY3S0U3WXE4SU9xM25PeTVtZXlkaENEc2xybnJpcFRyaTZRcERRcG1kVzVqZEdsdmJpQmgNCmMydERiR0YxWkdVb2RHVjRkQ3dnYlc5a1pXd3NJSEpsY0dGeWMyVXNJSEp2YkdVcElIc05DaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3MEtJQ0FnSUdOdmJuTjBJR0YwZEdWdGNIUWdQU0FvWVhOclpXUkRiM1Z1ZEM1blpYUW9kR1Y0ZENrZ2ZId2dNQ2tnS3lBeE93MEtJQ0FnSUdGemEyVmtRMjkxYm5RdWMyVjBLSFJsZUhRc0lHRjBkR1Z0Y0hRcE93MEtJQ0FnSUdsbUlDaGhjMnRsWkVOdmRXNTBMbk5wZW1VZ1BpQXlNREFwSUdGemEyVmtRMjkxYm5RdVkyeGxZWElvS1RzZ0x5OGc2NnkwN1pXYzdaNklJT3lNayt5ZHRPeW5nQ0RzbFlycXNvd05DaUFnSUNCamIyNXpkQ0J5ZFd4bElEMGdjbTlzWlNBOVBUMGdKK3V5aE8yS3ZDY2dQeUJDVlZSVVQwNWZVbFZNUlNBNklDY25PdzBLSUNBZ0lISmxkSFZ5YmlCeWRXeGxJQ3NnS0dGMGRHVnRjSFFnUGlBeERRb2dJQ0FnSUNBL0lDZnFzSm5zbllBZzY2eTQ2cldzNjZXOElPdUxwT3lMbkNEc21wVHNzcTN0bFp6cmk2UXVJT3lkdENEc2hManNoWmpzDQpsNURzaEp3ZzdKMjA3S0NFN0plUUlPeWduT3lWaU8yV2lPdU5tQ0Rxc29Qcms2VHFzN3dnNnJLNTdMbVk3S2VBSU95Vml1dUtsQ3dnNnJXczdLR3c2NEtZSU95V3RPMmNtT3F3Z0NEdG1aWHNpNlR0bm9nZzY0dWs2Nlc0SU95RGlPdWhuT3lhdENEcmpJRHNsWWdnTStxd25PdWx2Q0RxdDV6c3VabnJqSURyb1p3Z1NsTlBUaURyc0xEc2w3VHJvWnpycDR3NklDY2dLeUJLVTA5T0xuTjBjbWx1WjJsbWVTaDBaWGgwS1EwS0lDQWdJQ0FnT2lBbjY0dWs3SjJNSUZWSklPdXN1T3Exck95ZG1DRHJqSURzbFlnZ00rcXduT3VsdkNEcXQ1enN1Wm5yaklEcm9ad2dTbE5QVGlEcnNMRHNsN1Ryb1p6cnA0dzZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtTazdEUW9nSUgwc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzTkNuME5DZzBLTHk4ZzY3S0k3SmV0SU8yRXRDRGlnSlFnNnJDWjdKMkFJT3lFdU95Rm1PeWRoQ0RzazdEcmtKZ3NJT3lkdE91eWlDRHRoTFRycDR3ZzdMYVU3TEtjSU8yWWxleUxuU2hLVTA5Tw0KSU91d3NPeVh0Q2tnNjR5QTdJdWdJT3V5aU95WHJTRHRtSlhzaTUwb1NsTlBUaURxc0ozc3NyUXA3SjJFSU95YWxPcTFyTzJWbk91THBBMEtablZ1WTNScGIyNGdZWE5yVkhKaGJuTnNZWFJsS0hSbGVIUXNJRzF2WkdWc0xDQnlaWEJoY25ObEtTQjdEUW9nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lDZ05DaUFnSUNBbjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NEcnNvanNsNjBnN0o2UjdKZUY3SjIwNjR1a0lDanJyTGpxdGF3ZzY0dWs2NU9zNnJpd0lPeVZoT3VMbUNEaWdKUWc2NHlBN0pXSUlEUHFzSndnNnJlYzdMbVo3SjJBSU95ZHRPdXlpQ0R0aExUc2w1QWc3S0NCN0pxcDdaV1k3S2VBSU95Vml1dUtsT3VMcENrdUlDY2dLdzBLSUNBZ0lDZnJpNlRzbll3Z1ZVa2c2Nnk0NnJXczZyQ0FJTzJWbk9xMXJleVd0T3VwdENEc25wRHNsN0RzaXFUcm42enNtclFnN0ppQjdKYTA2NkdjTENEc21JSHNsclRycWJRZzdKNlE3SmV3N0lxazY1K3M3SnEwSU8yVm5PcTFyZXlXdE91aG5DRHJzb2pzbDYzdGxaanINCm5id3VJQ2NnS3cwS0lDQWdJQ2RWU1NEcnJManF0YXpyaTZUc21yUWc2ckNFNnJLdzdaV2NJTzJSbk8yWWhPeWRoQ0RzazdEcXM2QXNJT3lkdE91bWhNSzM3SWlyN0o2UXdyZnJwNGpzaXFUdGdybkN0KzJVak91Z2lPeWR0T3lLcE8yWmdPdU5sT3VLbENEcXQ3anJqSURyb1p3ZzY3TzA3S0cwN1pXYzY0dWtMaUFuSUNzTkNpQWdJQ0FuN0p1UTY2eTQ3SjJZSU95a2hDRHNpSmpycGJ3ZzZyZTQ2NHlBNjZHY0lPeWNvT3luZ08yVm5PdUxwQ0RpZ0pRZzdKdVE2Nnk0N0oyMElPMlZuQ0RzcElUc25iVHJxYlFnNjdLSTdKZXQ2NCtFSU8yVm5DRHNwSVRyb1p3c0lPeWtoT3V3bE9xL2lPeWRoQ0Rzbm9Uc25aanJvWndnN0xhVTZyQ0E3WldZN0tlQUlPeVZpdXVLbE91THBDNGdKeUFyRFFvZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1VnNnJpSTdLZUFPaUFuSUNzTkNpQWdJQ0FuDQpleUowY21GdWMyeGhkR1ZrSWpvZ0l1dXlpT3lYcmV1c3VDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpWkdseVpXTjBhVzl1SWpvZ0ltdHY0b2FTWlc0ZzY1aVE2NHFVSUdWdTRvYVNhMjhpZlRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwRFFvZ0lDa3NJRzF2WkdWc0xDQnlaWEJoY25ObEtUc05DbjBOQ2cwS0x5OGc2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFZzdZUzBJT0tBbENEc2dxenNtcW5zbnBEcXNJQWc3SU9CN1ptcDdKMkVJT3lFcE91cWhlMlZtT3VwdENEcnA2WHJuYjNzbDVBZzY2ZWU2NHFVSU91c3VPcTFyT3VsdkNEcnA0enJrNlRzbHJUc3BJRHJpNlF1RFFvdkx5QnRaWE56WVdkbGN6b2dXM3R5YjJ4bE9pZDFjMlZ5SjN3bllYTnphWE4wWVc1MEp5d2dkR1Y0ZEgxZElPeWdoT3l5dENEcmpJRHRtWlRycGJ3ZzY2ZWs2N0tJSU91d20rdUtsT3VMcENqcmk2VHJwcXpyaXBRZzY2eTA3SU9CN1lPY0lPS0FsQTBLTHk4ZzdKdU02N0NON0plRklPeW5nT3lMbk91cw0KdU95ZG1DQWk3SnFVN0xLdDY1T2s3SjJBSU95RW5PdWhuQ0RyckxUcXRJQWlJT3lnaE95Z25PdWx2Q0RzcDREdGdxVHF1TEFnN0p5RTdaVzBJT3VNZ08yWmxDRHJwNlhybmIzc25ZUWc3WVMwSU95VmlPeVhrQ0RycXIzcmxZVWc3SXVqNjRxVTY0dWtLUzROQ21aMWJtTjBhVzl1SUdGemEwTnZiWEJ2YzJVb2JXVnpjMkZuWlhNc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1NCN0RRb2dJSEpsZEhWeWJpQnlkVzVVZFhKdUtDZ3BJRDArSUhzTkNpQWdJQ0JqYjI1emRDQjBjbUZ1YzJOeWFYQjBJRDBnS0cxbGMzTmhaMlZ6SUh4OElGdGRLUzV0WVhBb0tHMHBJRDArRFFvZ0lDQWdJQ0FvYlM1eWIyeGxJRDA5UFNBbllYTnphWE4wWVc1MEp5QS9JQ2ZzbHJUc2k1enNpcVR0aExUdGlyZzZJQ2NnT2lBbjdJS3M3SnFwN0o2UU9pQW5LU0FySUZOMGNtbHVaeWh0TG5SbGVIUWdmSHdnSnljcExuTnNhV05sS0RBc0lERTFNREFwRFFvZ0lDQWdLUzVxYjJsdUtDZGNiaWNwT3cwS0lDQWdJSEpsZEhWeWJpQW9EUW9nSUNBZ0lDQW4NCjdKMjA2N0tJSU95YWxPeXlyZXlkZ0NBaTY0eUE3Wm1VN1ppVklPdXN1T3ExckNEc29KenNucEVpN0oyMDY0dWtJQ2pxdUxEc29iUWc2Nnk0NnJXc0lPdUxwT3VUck9xNHNDRHNsWVRyaTVnZzRvQ1VJT3lWaE91ZW1DRHJqSUR0bVpUcXNJQWc3SjIwNjdLSUlPMkV0T3lkbUNEc29JVHNzclFnNjZlbDY1Mjk3SjIwNjR1a0tTNGdKeUFyRFFvZ0lDQWdJQ0FuN0lLczdKcXA3SjZRNnJDQUlPMlpsT3VwdENEc2c0SHRtYW5DdCt1bnBldWR2ZXlkaENEc2hLVHJxb1h0bFpqcnFiUXNJT3lLcE8yRGdPeWR2Q0RxdDV6c3VabnFzN3dnN0ppSTdJdWNJTzJHcE95WGtDRHJwNTdyaXBRZ1ZVa2c2Nnk0NnJXczY2VzhJT3Vuak91VHBPeVd0Q0Rzb0p6c2xZanRsWmpybmJ3dVhHNG5JQ3NOQ2lBZ0lDQWdJQ2N0SU91bnBldWR2ZXlkdENEcnRvRHNvYkh0bFpqcnFiUWc3WTY0N1pXWTZyS01JT3VRbU91c3ZPeVd0T3VkdkRvZzdKYTA2NWFrSU8yWmxPdXB0TUszNnJpdzY0cWw3SjJZSU91c3VPcTFyT3lkdU95bmdDd2c2NU9rDQo3SmEwNnJDSUlPeWVrT3Vtck91S2xDRHNsclRybEpUc25ianNwNEFvN1l5ZDdKZUZJTzJEZ095ZHRPMkxnQy9yczdqcnJMZ3Y2N0tFN1lxOExDRHRocURzaXFUdGlyZ3NJT3U1aUNEdG1aVHJxYlFnN0pXSTY0SzBMQ0Ryc0xEcmhJZ2c2NU94S1N3ZzdKYTA2NWFrSU95RGdlMlpxZXlkdU95bmdDanNoTEhxczdVZzdZYTE2N08wTCt5WXBPdWxtQy90bVpYc25iZ2c3SnFVN0xLdEwreVZpT3VDdENrZzZyQ1o3SjJBSU9xeWd5NGc2cnl0SU8yVmhPeWFsTzJWbkNEcXNvUHJwNHdnNnJPbzY1MjhJTzJWbkNEcnNvanNsNUFnN0xXYzY0eUFJRExxc0p6cXVZenNwNEFzSU95bnArcXlqQzRnN0oyMDY1V01JSE4xWjJkbGMzUnBiMjV6NjRxVUlPdTVpQ0Ryc0xEc2w3UXVYRzRuSUNzTkNpQWdJQ0FnSUNjdElPcXdrT3lkdENEc2xyVHJpcEFnN0tDVjY0K0VJT3lZcE91cHRDRHJyTHZxdUxEcnA0d2c3WldZN0tlQUlPdW5pT3VkdkNEaWdKUWc2ckNBN0tDVjdKMkVJT3lFdU95YXNPcXpvQ0RzdElqc2xZZ2djM1ZuWjJWeg0KZEdsdmJuUHJwYndnN1pXbzZydVlJT3VDdE91cHRPeUVuQ3dnY21Wd2JIbnNsNUFnNnJDQTdLQ1Y3SjJFSU91d25lMmVpT3F6b0NEcnJMVHNsNGZzbllRZzdKV002NkNrN0tPODY2bTBJT3VObENEcnA1N3N0cHdnN0lpWUlPeWVpT3VLbE95bmdDRHRsWndnNjZ5NDdKNmw3Snk4NjZHY0lPdU5wK3UybWV5WHJPdWR2Q2pzbUlnNklDTHRtWlhzbmJnZzdZeWQ3SmVGN0oyMDY1Mjg2ck9nSU9xd2dPeWdsZTJXaU95V3RPeWFsQ0RpZ0pRZzdZYWc3SXFrN1lxNDY1Mjg2Nm0wSU95VmpPdWdwT3lqdk95RXVPeWFsQ0lwTGx4dUp5QXJEUW9nSUNBZ0lDQW5MU0RyckxqcXRhenJwYndnN0tDYzdKV0k3WldnSU91VmtDRHNoSnpyb1p3ZzdLQ1I2cmU4N0oyMElPdUxwT3VsdUNBeWZqUHFzSnd1SU9xd2dTRHNvSnpzbFlqc2w1UWc3Sm1jSU9xM3VPdWdoK3F5akNEc2pienJpcFRzcDRBZzdKMjA3SnlnNjZXOElPdTJtZXlkdU91THBDNWNiaWNnS3cwS0lDQWdJQ0FnSnkwZzdJS3M3SnFwN0o2UTZyQ0FJT3lXdU9xNGllMlYNCm1PeW5nQ0RzbFlyc25ZQWc2cldzN0xLMElPeWdsZXV6dENqc29JVHRtWlRyc29qdG1MakN0MVZTVE1LMzZyaUk3Sldod3JmdG1wL3NpSmdnNjVPeEtldWx2Q0RzcDREc2xyVHJnclFnNjRTajdLZUFJT3VuaU91ZHZDNWNiaWNnS3cwS0lDQWdJQ0FnSnkwZzdadUU3SWFOSU95YWxPeXlyU2dpNjQyVUlPeW5wK3F5akNJc0lDTHJzb1R0aXJ6c21xbnNuTHpyb1p3aUlPdVRzU25zbmJUcnFiUWc3S2VCN0tDRUlPeWduT3lWaU95ZGhDRHF0N2dnNjdDcDdaYWw3Snk4NjZHY0lPcXpvT3l6a0NEcmk2VHNpNXdnN0tDYzdKV0k3WldZNjUyOExseHVKeUFyRFFvZ0lDQWdJQ0FuNjR1MTdKMkFJT3V3bU91VG5PeUxuQ0JLVTA5T0lPcXduZXl5dENEdGxaanJncGpycDR3ZzdMYWM2NkNsN1pXYzY0dWtMaURycDRqdGdhenJpNlRzbXJUQ3QreUVwT3VxaFNEcXVJanNwNEE2SUNjZ0t3MEtJQ0FnSUNBZ0ozc2ljbVZ3YkhraU9pQWk2NHlBN1ptVUlPeWRrZXVMdFNEdGxaenJrWkFnNjZ5NDdKNmxJQ2p0bGJUc21wVHNzclFwDQpJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FnN1pXY0lPdXN1T3llcFNKOVhYMWNibHh1SnlBckRRb2dJQ0FnSUNBblcrdU1nTzJabEYxY2JpY2dLeUIwY21GdWMyTnlhWEIwRFFvZ0lDQWdLVHNOQ2lBZ2ZTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93MEtmUTBLRFFvdkx5RHRsSVRyb0lqc25vVHJzNFFvN1pXWTdKeUVJTzJVaE91Z2lPeWVoQ0Ryckxic25Zd3BJT3kybE95eW5DRHRoTFFnNG9DVUlPMlZuQ0R0bVpUcnFiVHNuWVFnN1pXWTdKeUVJTzJVaE91Z2lPeWVoQ0RyaTZqc25JVHJvWndnNjRLWTY0aWdJT3V6dE91Q3RPcXpvQ3dOQ2k4dklDb3E3WlNFNjZDSTdKNkU2NmVJNjR1a0lPdVVzT3VobkNvcUlPdU1nT3lWaU95ZGhDRHJzSnZyaXBUcmk2UXVJTzJWbkNEc21wVHNzcTNzbDVBZzY0dWtJT3lMcE95V3RDRHJzN1RyZ3JUcmlwUWc2cktEN0oyMElPMlZ0ZXlMckRvTg0KQ2k4dklPMlVoT3VnaU95ZWhDRHNpSmpycDR6dGdid2c3SnFVN0xLdDdKMkVJT3lxdk9xd25PdXB0Q0RxdDdqcnA0enRnYndnNjRxUTY2Q2s3S2VBNnJPZ0tPcXdnU0ExZmpFdzdMU0lLU0RxdGF6cmo0VWc3SUtzN0pxcDY1K0o2NCtFSU9xM3VPdW5qTzJCdkNEcmdwanFzSVRyaTZRdURRb3ZMeUJuY205MWNITTZJRnQ3Ym1GdFpTd2dkR1Y0ZEhNNlcxMTlYU0FvN1ptVTY2bTBJT3ljaE9LR2t1eVZoT3VlbUNEc2lKd3BMZzBLWm5WdVkzUnBiMjRnWVhOclIzSnZkWEJ6S0dkeWIzVndjeXdnYlc5a1pXd3NJSEpsY0dGeWMyVXNJRzF2Y21VcElIc05DaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3MEtJQ0FnSUM4dklPdXloTzJLdkNEc21JSHNsNjNzbllBZ0tPdXloTzJLdkNuc25MenJvWndnN0xDTjdKYTBJT3V6dE91Q3VPdUxwQ0RpZ0pRZzY3S0U3WXE4SU91c3VPcTFyT3VLbENEcnJManNucVhzbmJRZzdKV0U2NHVJNjUyOElPdVBtZXlla1NEc25iVHJwb1RzbmJUcm5id2c2cmVjN0xtWjdKMjANCklPdUxwT3VsdE91THBBMEtJQ0FnSUdOdmJuTjBJR3hwYzNRZ1BTQW9aM0p2ZFhCeklIeDhJRnRkS1M1dFlYQW9LR2NzSUdrcElEMCtEUW9nSUNBZ0lDQW5XeWNnS3lBb2FTQXJJREVwSUNzZ0oxMGdKeUFySUZOMGNtbHVaeWdvWnlBbUppQm5MbTVoYldVcElIeDhJQ2duNnJlNDY2TzVKeUFySUNocElDc2dNU2twS1NBcklDaG5JQ1ltSUdjdWNtOXNaU0E5UFQwZ0ordXloTzJLdkNjZ1B5QW5JQ2pyc29UdGlyd3BKeUE2SUNjbktTQXJJQ2RjYmljZ0t3MEtJQ0FnSUNBZ0tHY2dKaVlnUVhKeVlYa3VhWE5CY25KaGVTaG5MblJsZUhSektTQS9JR2N1ZEdWNGRITWdPaUJiWFNrdWJXRndLQ2gwS1NBOVBpQW5JQ0F0SUNjZ0t5QktVMDlPTG5OMGNtbHVaMmxtZVNoVGRISnBibWNvZENCOGZDQW5KeWtwS1M1cWIybHVLQ2RjYmljcERRb2dJQ0FnS1M1cWIybHVLQ2RjYmljcE93MEtJQ0FnSUdOdmJuTjBJR2hoYzBKMGJpQTlJQ2huY205MWNITWdmSHdnVzEwcExuTnZiV1VvS0djcElEMCtJR2NnSmlZZ1p5NXliMnhsDQpJRDA5UFNBbjY3S0U3WXE4SnlrN0RRb2dJQ0FnWTI5dWMzUWdhMlY1SUQwZ0oyZHliM1Z3Y3ljZ0t5QW9aM0p2ZFhCeklIeDhJRnRkS1M1dFlYQW9LR2NwSUQwK0lDaG5JQ1ltSUdjdWRHVjRkSE1nUHlCbkxuUmxlSFJ6TG1wdmFXNG9KeWNwSURvZ0p5Y3BLUzVxYjJsdUtDY25LVHNOQ2lBZ0lDQmpiMjV6ZENCaGRIUmxiWEIwSUQwZ0tHRnphMlZrUTI5MWJuUXVaMlYwS0d0bGVTa2dmSHdnTUNrZ0t5QXhPdzBLSUNBZ0lHRnphMlZrUTI5MWJuUXVjMlYwS0d0bGVTd2dZWFIwWlcxd2RDazdEUW9nSUNBZ2FXWWdLR0Z6YTJWa1EyOTFiblF1YzJsNlpTQStJREl3TUNrZ1lYTnJaV1JEYjNWdWRDNWpiR1ZoY2lncE93MEtJQ0FnSUdOdmJuTjBJR0ZuWVdsdUlEMGdiVzl5WlNCOGZDQmhkSFJsYlhCMElENGdNUTBLSUNBZ0lDQWdQeUFuN0oyMElPMlpsT3VwdE95ZGdDRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3V2dUNEcmk2VHJwSmpyaTZRdUlPeVZudXlFbkNEcmdyZ2c2NHlBN0pXSTZyTzhJT3lXdE8yYw0KbU1LMzZyV3M3S0d3NnJDQUlPMlpsZXlMcE8yZWlDRHJpNlRycGJnZzdJT0lJT3VNZ095VmlPdW5qQ0RyZ3JUcm5id3VYRzRuRFFvZ0lDQWdJQ0E2SUNjbk93MEtJQ0FnSUhKbGRIVnliaUFvRFFvZ0lDQWdJQ0JoWjJGcGJpQXJEUW9nSUNBZ0lDQW43SjIwNjdLSUlPeWFsT3l5cmV5ZGdDQWk3Wm1VNjZtMDdKMkVJTzJWbU95Y2hDRHRsSVRyb0lqc25vVHJzNFRyb1p3ZzY0S1k2NGlnSU91THBPdVRyT3E0c0NMcmk2UXVJT3lWaE91ZW1PdUtsQ0R0bFp3ZzdabVU2Nm0wN0oyWUlPdXN1T3Exck91bHZDRHRsWmpzbklRZzdaU0U2NkNJN0o2RUtPeVlnZXlYclNrZzY0dW83SnlFNjZHY0lPdXN0dXlkZ0NEcXNvUHNuYlRyaTZRdVhHNG5JQ3NOQ2lBZ0lDQWdJQ2NxS3V5WWdleVhyZXVuaU91THBDRHJsTERyb1p3cUtpRHJqSURzbFlqc25ZUWc2NEswNjUyOElPS0FsQ0RzbUlIc2w2M3NuWVFnN0lTYzY2R2NJTzJWcWV5NW1PcXhzT3VDbUNEc2lKenNoSnpycGJ3ZzY3Q1U2cjY0N0tlQUlPdW5pT3VkdkM1Y2JpY2cNCkt3MEtJQ0FnSUNBZ0p5MGc2ckNCSU95WWdleVhyZXlYa0NEcmpJRHNsWWdnTXVxd25DNGc2cmU0SU95WWdleVhyZXlkdENEc2w2enJuNndnN0tTRTdKMjA2Nm0wSU91TWdPeVZpT3VQaENBcUt1cXdtZXlkZ0NEc3BJUWc3SWlZS2lycm9ad283S1NFNjdDVTZyK0lJRnhjYnV5Y3ZPdWhuQ0RxdGF6cnRvUXNJT3lraENEc2lKenNoSndnN0p5ZzdLZUFLUzVjYmljZ0t3MEtJQ0FnSUNBZ0p5MGc3SmlCN0pldDdKMllJT3lYcmUyVm9DanRnNERzbmJUdGk0REN0K3lWaU91Q3RNSzM2N0tFN1lxOElPdVRzU25xczd3ZzdKdVE2Nnk0N0oyWUlPeWdsZXV6dE1LMzdLR3c2ckcwS095SXEreWVrTUszNjR5QTdJT0J3cmZzb2JEcXNiUXA3SjJBSU95Y29PeW5nTzJWbU9xem9Dd2c3SmVHNjRxVUlPeWdsZXV6dE91bHZDRHNwNERzbHJUcmdyVHNwNEFnNjZlSTY1MjhMbHh1SnlBckRRb2dJQ0FnSUNBbkxTRHFzNkRzdWFBZzZyS01JT3lYaHV1S2xDRHNtSUhzbDYzc25iVHJxYlFnNjR5QTdKV0lJREhxc0p6cnA0d2c2NEswDQo2ckd3NjRLWUlPdTVpQ0Ryc0xEc2w3VHJvWndnNjVHUTdKYTA2NCtFSU91UW5PdUxwQ0RpZ0pRZzdKYTE3S2VBNjZHY0lPdXdsT3ErdU95bmdDRHJwNGpybmJ3dVhHNG5JQ3NOQ2lBZ0lDQWdJQ2N0SU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGdDRHF0N2pyaklEcm9ad2c2NUdVNjR1a0xseHVKeUFyRFFvZ0lDQWdJQ0FvYUdGelFuUnVJRDhnSnkwZ0tPdXloTzJLdkNuc25MenJvWndnN1pHYzdJdWM2NUNjSU95WWdleVhyZXlkZ0NBbklDc2dRbFZVVkU5T1gxSlZURVVnT2lBbkp5a2dLdzBLSUNBZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1hDdCt5OWxPdVRuTzJPbk95S3BDRHF1SWpzcDRBNlhHNG5JQ3NOQ2lBZ0lDQWdJQ2Q3SW1keWIzVndjeUk2SUZ0N0ltNWhiV1VpT2lBaTdKaUI3SmV0SU95ZHRPdW1oQ2pzbm9Ycg0Kb0tYcXM3d2c2NCtaN0oyOEtTSXNJQ0p6ZFdkblpYTjBhVzl1Y3lJNklGdDdJblJsZUhRaU9pQWk2NHlBN0pXSUlPdXN1T3ExckNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWljbVZoYzI5dUlqb2dJdXlkdE95Y29DRHRsWndnNjZ5NDdKNmxJbjFkZlYxOVhHNG5JQ3NOQ2lBZ0lDQWdJQ2ZzbUlIc2w2M3NuWUFnN0o2RjY2Q2xJT3lJbk95RW5NSzM2ckNjN0lpWTY2VzhJT3EzdU91TWdPdWhuQ0RzcDREdGdxanJpNlF1WEc1Y2JpY2dLdzBLSUNBZ0lDQWdKMXZzbUlIc2w2M3JzNFFnNjZ5NDZyV3NYVnh1SnlBcklHeHBjM1FOQ2lBZ0lDQXBPdzBLSUNCOUxDQnRiMlJsYkN3Z2NtVndZWEp6WlNrN0RRcDlEUW9OQ2k4dklPMlVoT3VnaU95ZWhPdXpoQ0RzdHBUc3Nwd2c3SjJSNjR1MTdKZVE3SVNjSUZ0N2JtRnRaU3dnYzNWbloyVnpkR2x2Ym5NNlczdDBaWGgwTENCeVpXRnpiMjU5WFgxZElPeTJsT3kybkEwS1puVnVZM1JwYjI0Z2NHRnljMlZIY205MWNITW9jbUYzS1NCN0RRb2dJR3hsZENCeklEMGcNClUzUnlhVzVuS0hKaGR5a3VkSEpwYlNncExuSmxjR3hoWTJVb0wxNWdZR0FvUHpwcWMyOXVLVDljY3lvdmFTd2dKeWNwTG5KbGNHeGhZMlVvTDF4ekttQmdZQ1F2YVN3Z0p5Y3BPdzBLSUNCamIyNXpkQ0J0SUQwZ2N5NXRZWFJqYUNndlhIdGJYSE5jVTEwcVhIMHZLVHNOQ2lBZ2FXWWdLRzBwSUhNZ1BTQnRXekJkT3cwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHOGdQU0JLVTA5T0xuQmhjbk5sS0hNcE93MEtJQ0FnSUdOdmJuTjBJR0Z5Y2lBOUlFRnljbUY1TG1selFYSnlZWGtvYnlBbUppQnZMbWR5YjNWd2N5a2dQeUJ2TG1keWIzVndjeUE2SUZ0ZE93MEtJQ0FnSUdOdmJuTjBJR2R5YjNWd2N5QTlJR0Z5Y2k1dFlYQW9LR2NwSUQwK0lDaDdEUW9nSUNBZ0lDQnVZVzFsT2lCVGRISnBibWNvS0djZ0ppWWdaeTV1WVcxbEtTQjhmQ0FuSnlrdWRISnBiU2dwTEEwS0lDQWdJQ0FnYzNWbloyVnpkR2x2Ym5NNklFRnljbUY1TG1selFYSnlZWGtvWnlBbUppQm5Mbk4xWjJkbGMzUnBiMjV6S1EwS0lDQWdJQ0FnDQpJQ0EvSUdjdWMzVm5aMlZ6ZEdsdmJuTU5DaUFnSUNBZ0lDQWdJQ0FnSUM1dFlYQW9LSGdwSUQwK0lDaDBlWEJsYjJZZ2VDQTlQVDBnSjNOMGNtbHVaeWNOQ2lBZ0lDQWdJQ0FnSUNBZ0lDQWdQeUI3SUhSbGVIUTZJSGd1ZEhKcGJTZ3BMQ0J5WldGemIyNDZJQ2NuSUgwTkNpQWdJQ0FnSUNBZ0lDQWdJQ0FnT2lCN0lIUmxlSFE2SUZOMGNtbHVaeWdvZUNBbUppQjRMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tzSUhKbFlYTnZiam9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VjbVZoYzI5dUtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwcEtRMEtJQ0FnSUNBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvZUNrZ1BUNGdlQzUwWlhoMEtRMEtJQ0FnSUNBZ0lDQTZJRnRkTEEwS0lDQWdJSDBwS1RzTkNpQWdJQ0F2THlEc25iVHJwb1Rzb2JEc3NLZ2c3SmVHNnJPZ0lPeWduT3lWaU91UGhDRHNsNGJyaXBRZzZydU42NDJ3NnJpdzY2ZU1JT3labE95Y3ZPdXB0Q0R0bUpYc2k1MGc3SjIwN1lPSTY2R2NJT3V6dU91THBDanFzSm5zbllBZw0KN0lTNDdJV1k3SmVRSU95ZXJPeWFsT3l5clNrTkNpQWdJQ0J5WlhSMWNtNGdaM0p2ZFhCekxuTnZiV1VvS0djcElEMCtJR2N1YzNWbloyVnpkR2x2Ym5NdWJHVnVaM1JvS1NBL0lHZHliM1Z3Y3lBNklHNTFiR3c3RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3RFFvZ0lDQWdjbVYwZFhKdUlHNTFiR3c3RFFvZ0lIME5DbjBOQ2cwS0x5OGc3WXlkN0plRklPeUV1TzJLdUNEc3RwVHNzcHdnN1lTMElPS0FsQ0R0bFp3ZzdZeWQ3SmVGN0oyWUlPcTFyT3lFc2V5YWxPeUdqQ2pzbDYzdGxhQXI2Nnk0NnJXc0tldWx2Q0R0bFp3ZzY3S0k3SmVRSU91enRPdUN0T3F6b0N3TkNpOHZJT3lhbE95R2pPdXpoQ0RyZ3JIcXNKenFzSUFnN0pXRTY0dUk2NTI4SUNvcTdKbUU3SVN4NjVDY0lPMk1uZXlYaFNEc2hManRpcmdvN0x5QTdKMjA3SXFrS1NBeWZqUHFzSndxS3V1bHZDRHRoclhzbkx6cm9ad2c2N0NiNjRxVTY0dWtMZzBLTHk4ZzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdk95ZHRDRHRsWndnNjZxNDdKeTgNCjY2R2NJT3lkdk9xMGdPdVB2T3lWdkNEdGxaanJyNERyb1p3bzY1U3c2NkdjSU91OWtleVZoQ0Rzb2JEdGxhbnRsWmpycWJRZzdKYTA2cmlMNjRLYzY0dWtLU0RzaExqdGlyZ2c2NHVvN0p5RTY2R2NJT3lnbk95VmlPMlZtT3F5akNEdGxaenJpNlF1RFFvdkx5QmxiR1Z0Wlc1MGN6b2dXM3R5YjJ4bExDQjBaWGgwZlYwZ0tPMlpsT3VwdENEc25JVGlocExzbFlUcm5wZ2c3SWljS1M0TkNpOHZJRzF2Y21VOWRISjFaU2hiN0x5QTdKMjA3SXFrSU91TmxDRHJzSnZxdUxCZEtldXB0Q0RzbmJRZzdJUzQ3SVdZN0plUTdJU2NJT3lkdE91dnVDRHJncmdnN0lTNDdZcTQ3Sm1BSU9xeXVleTVtT3luZ0NEc2xZcnJpcFFnN0lPSUlPeUV1TzJLdU91bHZDRHNtcFRxdGF6dGxaenJpNlF1RFFwbWRXNWpkR2x2YmlCaGMydFFiM0IxY0NobGJHVnRaVzUwY3l3Z2JXOWtaV3dzSUhKbGNHRnljMlVzSUcxdmNtVXBJSHNOQ2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdldzBLSUNBZ0lHTnZibk4wSUhKdmJHVnpJRDBnDQpLR1ZzWlcxbGJuUnpJSHg4SUZ0ZEtTNXRZWEFvS0dVcElEMCtJRk4wY21sdVp5Z29aU0FtSmlCbExuSnZiR1VwSUh4OElDY25LU2t1YW05cGJpZ25MQ0FuS1RzTkNpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ0tHVnNaVzFsYm5SeklIeDhJRnRkS1M1dFlYQW9LR1VzSUdrcElEMCtEUW9nSUNBZ0lDQW9hU0FySURFcElDc2dKeTRnV3ljZ0t5QlRkSEpwYm1jb0tHVWdKaVlnWlM1eWIyeGxLU0I4ZkNBbkp5a2dLeUFuWFNBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb1UzUnlhVzVuS0NobElDWW1JR1V1ZEdWNGRDa2dmSHdnSnljcEtRMEtJQ0FnSUNrdWFtOXBiaWduWEc0bktUc05DaUFnSUNBdkx5RHFzSm5zbllBZzdZeWQ3SmVGN0oyRUlPdXFoeURyc29qc3A3Z2c2Nnk3NjRxVTdLZUFJT3E0c095V3RTRGlnSlFnN0o2czdKcVU3TEt0N0oyMDY2bTBJQ0xzbmJUc29JVHFzN3dnNjR1azY2VzRJT3lFdU8yS3VDTHJwYndnN0pxVTZyV3M3WldjNjR1a0RRb2dJQ0FnTHk4Z0tHRnphME5zWVhWa1pleVpnQ0Rxc0pucw0KbllBZzdKMjA3SnlnT2lEc2xZZ2c2cmU0NjUrczY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEcXNKbnNuWUFnN0lTNDdZcTQ2Nlc4SU91WWtDRHJnclRzaEp3Z1creThnT3lkdE95S3BDRHJqWlFnNjdDYjZyaXdYZXF3Z0NEcnJMVHNuWmpycjdqdGxiVHNwNFRyaTZRcERRb2dJQ0FnWTI5dWMzUWdhMlY1SUQwZ0ozQnZjSFZ3QVNjZ0t5QW9aV3hsYldWdWRITWdmSHdnVzEwcExtMWhjQ2dvWlNrZ1BUNGdVM1J5YVc1bktDaGxJQ1ltSUdVdWRHVjRkQ2tnZkh3Z0p5Y3BLUzVxYjJsdUtDY0JKeWs3RFFvZ0lDQWdZMjl1YzNRZ1lYUjBaVzF3ZENBOUlDaGhjMnRsWkVOdmRXNTBMbWRsZENoclpYa3BJSHg4SURBcElDc2dNVHNOQ2lBZ0lDQmhjMnRsWkVOdmRXNTBMbk5sZENoclpYa3NJR0YwZEdWdGNIUXBPdzBLSUNBZ0lHbG1JQ2hoYzJ0bFpFTnZkVzUwTG5OcGVtVWdQaUF5TURBcElHRnphMlZrUTI5MWJuUXVZMnhsWVhJb0tUc2dMeThnNjZ5MDdaV2M3WjZJSU95TWsreWR0T3luZ0NEc2xZcnFzb3dOQ2lBZ0lDQmoNCmIyNXpkQ0JoWjJGcGJpQTlJRzF2Y21VZ2ZId2dZWFIwWlcxd2RDQStJREVOQ2lBZ0lDQWdJRDhnSit5ZHRDRHRqSjNzbDRYc25ZQWc3SjIwSU95RXVPeUZtT3lYa095RW5DRHNuYlRycjdnZzY0dWs2NlNZNjR1a0xpRHNsWjdzaEp3ZzdLQ2M3SldJN1pXY0lPeUV1TzJLdU91VHBPcXp2Q0FxS3V5Z2tlcTN2TUszN0phMDdaeVk2ckNBSU8yWmxleUxwTzJlaUNEcmk2VHJwYmdnN0lPSUlPeUV1TzJLdUNvcTY2ZU1JT3VDdE91ZHZDanFzSm5zbllBZzdJUzQ3WXE0SU91d21PdXp0U0RxdUlqc3A0QXBMbHh1SncwS0lDQWdJQ0FnT2lBbkp6c05DaUFnSUNCeVpYUjFjbTRnS0EwS0lDQWdJQ0FnWVdkaGFXNGdLdzBLSUNBZ0lDQWdKK3lkdE91eWlDRHNtcFRzc3Ezc25ZQWdJdTJNbmV5WGhTanJpNlRzbmJUc2xyenJvWnpxdDdncElPeUV1TzJLdUNEcmk2VHJrNnpxdUxBaTY0dWtMaURzbFlUcm5wanJpcFFnN1pXY0lPMk1uZXlYaGV5ZGhDRHNuSVRpaHBMc2xZVHJucGpyb1p3ZzY0S1k3SmUwN1pXY0lPcTFyT3lFDQpzZXlhbE95R2pPdVRwT3lkdE91THBDanNoSnpyb1p3ZzY2eTA2clNBN1pXY0lPdXpoT3F3bkNEcnJManF0YXpxc0lBZzdKV0U2NHVJNjR1a0tTNGdKeUFyRFFvZ0lDQWdJQ0FuN0pxVTdJYU02Nlc4SU91Q3NlcXduT3VobkNEcXM2RHN1WmpzcDRBZzY2ZVE2ck9nTENBcUt1MkRnT3lkdE8yTGdNSzM3SldJNjRLMHdyZnJzb1R0aXJ6c25iUWc3SVNjNjZHY0lPeWR2T3EwZ091UW5DQWk3Sm1FN0lTeDY1Q2NJTzJNbmV5WGhTRHNoTGp0aXJnaUlESitNK3F3bkNvcTY2VzhJT3lnbk95VmlPMlZtT3VkdkM0ZzZyQ0JJT3lFdU8yS3VPdUtsQ0RzaEp6cm9ad2c2NHVrNjZXNElPeWdrZXEzdk95ZHRPeVd0T3lWdkNEdGxaenJpNlF1WEc0bklDc05DaUFnSUNBZ0lDZnFzSUVnN0lTNDdZcTQ2NHFVSU95ZWhldWdwZXF6dkNBcUt1cXdtZXlkZ0NEc2w2M3RsYURDdCtxd21leWRnQ0Rxc0p6c2lKakN0K3F3bWV5ZGdDRHNpSnpzaEp3cUt1eWRtQ0RzbXBUc2hvenJwYndnNjZxbzY1R1FJTzJQck8yVnFPMlZuT3VMcEM0Zw0KN0lTNDdZcTRJT3lWaU95WGtPeUVuQ0R0ZzREc25iVHRpNERDdCt5VmlPdUN0TUszNjdLRTdZcTg3SjJBSU8yVm5DRHJxcmpzbkx6cm9ad2c2NmVlN0pXRTY1YW83SmEwN0tDNDdKVzhJTzJWbk91THBDanNtSWc2SU91enVPdXN1T3lkdENBaWZ1MlZvT3E1ak95YWxEOGk2Nm0wSU91eWhPMkt2T3lkZ0NCYjdKV0U2NHVJN0ppa1hTOWI2NFNrWFNrdVhHNG5JQ3NOQ2lBZ0lDQWdJQ2RiN1l5ZDdKZUZJT3VzdU95eXRDRHF0NXpzdVprZzRvQ1VJT3ljaENEc2lxVHRnNERzbmJ3ZzZyQ0E3SjIwNjVPYzdKMllJQ0k0TGlEdGpKM3NsNFVpSU95RXVleUZtT3lkaENEcmxMRHJwYmpyaTZSZFhHNG5JQ3NOQ2lBZ0lDQWdJQ2N0SU8yRGdPeWR0TzJMZ0RvZzdLZW43SjJBSU91cWhleUNyT3ExckNneWZqVHNsclRzb0lncExDRHNvb1hxc3JEc2xyVHJyN2pDdCt1bmlPeTVxTzJSbkNEc2w0YnNuYlFvZnV5YWxDOSs2NHVrTDM3cXVZenNtcFEvSU9xNGlPeW5nQ2t1SU91d21PdVRuT3lMbkNEc2xZanJnclFvNjdPNDY2eTQNCktTRHJwNlhybmIzc25ZUWc3SnFVN0pXOTdaVzBJTzJEZ095ZHRPMkxnT3VuakNEcnRKRHJqNFFnNjZ5MDdJcW9JTzJNbmV5WGhleWR1T3luZ0NEc2xZenFzb3dnN1pXWTY1MjhMaURzbTVEcnM3anNuYlFnSXV5VmpPdW12Qy90bVpYc25iZ2k3TEtZNjUrOElPdW5pZXlYc08yVm1PdXB0Q0RyczdqcnJManNuWVFnNnJlODZyR3c2NkdjSU9xMXJPeXl0TzJabE8yVm1PdWR2QzVjYmljZ0t3MEtJQ0FnSUNBZ0p5MGc3SldJNjRLMEtPdXp1T3VzdUNrNklPMlZ0T3lhbE95eXRDNGc3WXlRNjR1bzdKMjBJTzJWaE95YWxPMlZtT3VwdENBaWZ1MlZvT3E1ak95YWxEOGk2NkdjSU91c3UrcXpvQ3dnNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzdKeUU3WmVZS095Q3JleWduTUszN1lPSTdZZTBJT3VUc1Nuc25ZQWc2ckt3NnJPODY2VzhJT3Vvdk95Z2dDRHFzcjNxczZEdGxaenJpNlF1SU9xeXNPcXp2TUszN0lPQjdZT2NJTzJHdGV1enRPdXB0Q0RzaEp6c2lLRHRtSlhzbkx6cm9ad2c3SldNNjZhdzY0dWtMbHh1DQpKeUFyRFFvZ0lDQWdJQ0FuTFNEcnNvVHRpcnc2SU91enVPdXN1T3lkdENBaWZ1MlZvT3E1ak95YWxEOGk2Nm0wSUZ2c2xZVHJpNGpzbUtSZEwxdnJoS1JkTENEcnM3anJyTGpzbmJRZzdJT0I3Wm1wN0oyRUlPeUVuT3lJb08yVm1PcXpvQ0RzbmJRZzY3S0U3WXE4N0oyMElPeUxwT3lnbkNEcmo1bnNucEhzbmJUcnFiUWc2NCtaN0o2UklPdVBtZXlDckNqc2dxM3NvSnd2N0tDQTdKNmxMK3lYc09xeXNDRHRsYlRzb0p3ZzY1T3hLU3dnN1lhMTY3TzBJTzJNbmV5WGhleWRtQ0RyaTZqc25id2c2N0tFN1lxODdKMjA2Nm0wSUNMdG1aWHNuYmdpTGlBaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenJwNHdzSUNMcmk2dnF1TERDdCt1UG1leWVrU0lnN0tHdzdaV3BJT3E0aU95bmdDNGc3Wm1VNjZtMElPcTRzT3VLcGV1cWhTanJzNERxc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bklDc05DaUFnSUNBZ0lDY3RJT3lia091cw0KdU95ZG1DRHNvSlhyczdUQ3QreWhzT3F4dENqc2lLdnNucERDdCt5ZHRPeURnUy9zbmJUdGxaakN0K3VNZ095RGdTbnNuWUFnN0p5ZzdLZUE3WldZNnJPZ0xDRHNtNURyckxqc2w1QWc3SmVHNjRxVUlPeWdsZXV6dE1LMzdLQ0k3TENvd3Jmc2w3RHJuYjNzc3BqcnBid2c3S2VBN0phMDY0SzA3S2VBSU91bmlPdWR2QzVjYmljZ0t3MEtJQ0FnSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURxc0ozc3NyUWc3WldZNjRLWTY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvWEN0K3k5bE91VG5PMk9uT3lLcENEcXVJanNwNEE2WEc0bklDc05DaUFnSUNBZ0lDZDdJbk5sZEhNaU9pQmJleUp5WldGemIyNGlPaUFpN0oyMElPeUV1TzJLdU95ZG1DRHJzS250bHFYc25ZUWc3WldjNnJXdDdKYTBJTzJWbkNEcnJManNucVhzbkx6cm9ad2lMQ0FpWld4bGJXVnVkSE1pT2lCYmV5SnliMnhsSWpvZ0l1eVhyZTJWb0NJc0lDSjBaWGgwSWpvZ0l1dXN1T3ExckNBbzdLU0UNCjY3Q1U2citJN0oyQUlGeGNiaWtpZlN3Z0xpNHVYWDBzSUM0dUxsMTlYRzRuSUNzTkNpQWdJQ0FnSUNmc2w2M3RsYURzbllBZzdKNkY2NkNsSU95SW5PeUVuT3VNZ091aG5Eb2dKeUFySUhKdmJHVnpJQ3NnSjF4dVhHNG5JQ3NOQ2lBZ0lDQWdJQ2RiN1l5ZDdKZUZJT3lhbE95R2pGMWNiaWNnS3lCc2FYTjBEUW9nSUNBZ0tUc05DaUFnZlN3Z2JXOWtaV3dzSUhKbGNHRnljMlVwT3cwS2ZRMEtEUW92THlEdGpKM3NsNFVnN0oyUjY0dTE3SmVRN0lTY0lIdHpaWFJ6T2lCYmUzSmxZWE52Yml3Z1pXeGxiV1Z1ZEhNNlczdHliMnhsTEhSbGVIUjlYWDFkZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwRFFwbWRXNWpkR2x2YmlCd1lYSnpaVkJ2Y0hWd0tISmhkeWtnZXcwS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrDQpMMmtzSUNjbktUc05DaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4N1cxeHpYRk5kS2x4OUx5azdEUW9nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNOQ2lBZ2RISjVJSHNOQ2lBZ0lDQmpiMjV6ZENCdklEMGdTbE5QVGk1d1lYSnpaU2h6S1RzTkNpQWdJQ0JqYjI1emRDQnpaWFJ6U1c0Z1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTV6WlhSektTQS9JRzh1YzJWMGN5QTZJRnRkT3cwS0lDQWdJR052Ym5OMElITmxkSE1nUFNCelpYUnpTVzROQ2lBZ0lDQWdJQzV0WVhBb0tITjBLU0E5UGlBb2V3MEtJQ0FnSUNBZ0lDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2MzUWdKaVlnYzNRdWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQTBLSUNBZ0lDQWdJQ0JsYkdWdFpXNTBjem9nUVhKeVlYa3VhWE5CY25KaGVTaHpkQ0FtSmlCemRDNWxiR1Z0Wlc1MGN5a05DaUFnSUNBZ0lDQWdJQ0EvSUhOMExtVnNaVzFsYm5SekRRb2dJQ0FnSUNBZ0lDQWdJQ0FnSUM1dFlYQW9LR1ZzS1NBOVBpQW9leUJ5YjJ4bA0KT2lCVGRISnBibWNvS0dWc0lDWW1JR1ZzTG5KdmJHVXBJSHg4SUNjbktTNTBjbWx0S0Nrc0lIUmxlSFE2SUZOMGNtbHVaeWdvWld3Z0ppWWdaV3d1ZEdWNGRDa2dmSHdnSnljcExuUnlhVzBvS1NCOUtTa05DaUFnSUNBZ0lDQWdJQ0FnSUNBZ0xtWnBiSFJsY2lnb1pXd3BJRDArSUdWc0xuUmxlSFFwRFFvZ0lDQWdJQ0FnSUNBZ09pQmJYU3dOQ2lBZ0lDQWdJSDBwS1EwS0lDQWdJQ0FnTG1acGJIUmxjaWdvYzNRcElEMCtJSE4wTG1Wc1pXMWxiblJ6TG14bGJtZDBhQ2s3RFFvZ0lDQWdjbVYwZFhKdUlITmxkSE11YkdWdVozUm9JRDhnYzJWMGN5QTZJRzUxYkd3N0RRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0RRb2dJQ0FnY21WMGRYSnVJRzUxYkd3N0RRb2dJSDBOQ24wTkNnMEtMeThnNjR5QTdabVU3WmlWSU95Z25PeWVrU0RzblpIcmk3WHNsNURzaEp3Z2UzSmxjR3g1TENCemRXZG5aWE4wYVc5dWMxdGRmU0RzdHBUc3Rwd2dLT3k5bE91VG5PMk9uT3lLcE1LMzdKV2U2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3ANCkRRcG1kVzVqZEdsdmJpQndZWEp6WlVOdmJYQnZjMlVvY21GM0tTQjdEUW9nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93MEtJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc05DaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3cwS0lDQWdJR052Ym5OMElISmxjR3g1SUQwZ1UzUnlhVzVuS0NodklDWW1JRzh1Y21Wd2JIa3BJSHg4SUNjbktTNTBjbWx0S0NrN0RRb2dJQ0FnWTI5dWMzUWdjM1ZuWjJWemRHbHZibk1nUFNCQmNuSmhlUzVwYzBGeWNtRjVLRzhnSmlZZ2J5NXpkV2RuWlhOMGFXOXVjeWtOQ2lBZ0lDQWdJRDhnYnk1emRXZG5aWE4wYVc5dWN3MEtJQ0FnSUNBZ0lDQWdJQzV0WVhBb0tIZ3BJRDArSUNoN0lIUmxlSFE2DQpJRk4wY21sdVp5Z29lQ0FtSmlCNExuUmxlSFFwSUh4OElDY25LUzUwY21sdEtDa3NJSEpsWVhOdmJqb2dVM1J5YVc1bktDaDRJQ1ltSUhndWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1EwS0lDQWdJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tIZ3BJRDArSUhndWRHVjRkQ2tOQ2lBZ0lDQWdJRG9nVzEwN0RRb2dJQ0FnYVdZZ0tISmxjR3g1SUh4OElITjFaMmRsYzNScGIyNXpMbXhsYm1kMGFDa2djbVYwZFhKdUlIc2djbVZ3Ykhrc0lITjFaMmRsYzNScGIyNXpJSDA3RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5RFFvZ0lISmxkSFZ5YmlCdWRXeHNPdzBLZlEwS0RRb3ZMeURyc29qc2w2MGc3SjJSNjR1MTdKZVE3SVNjSUh0MGNtRnVjMnhoZEdWa0xDQmthWEpsWTNScGIyNTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa05DbVoxYm1OMGFXOXVJSEJoY25ObFZISmhibk5zWVhSbEtISmhkeWtnZXcwSw0KSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc05DaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4N1cxeHpYRk5kS2x4OUx5azdEUW9nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNOQ2lBZ2RISjVJSHNOQ2lBZ0lDQmpiMjV6ZENCdklEMGdTbE5QVGk1d1lYSnpaU2h6S1RzTkNpQWdJQ0JqYjI1emRDQjBjbUZ1YzJ4aGRHVmtJRDBnVTNSeWFXNW5LQ2h2SUNZbUlHOHVkSEpoYm5Oc1lYUmxaQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tUc05DaUFnSUNCcFppQW9kSEpoYm5Oc1lYUmxaQ2tnY21WMGRYSnVJSHNnZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dU9pQlRkSEpwYm1jb0tHOGdKaVlnYnk1a2FYSmxZM1JwYjI0cElIeDhJQ2NuS1M1MGNtbHRLQ2tnZlRzTkNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3SldFNjU2WTY2R2NJQ292SUgwTkNpQWcNCmNtVjBkWEp1SUc1MWJHdzdEUXA5RFFvTkNpOHZJT3lka2V1THRleVhrT3lFbkNCN2RHVjRkQ3dnY21WaGMyOXVmU0Ryc0xEc2w3UWc3TGFVN0xhY0lDanN2WlRyazV6dGpwenNpcVRDdCt5Vm51dVNwQ0RzbnFIcmk3UWc3WmVJN0pxcEtRMEtablZ1WTNScGIyNGdjR0Z5YzJWVGRXZG5aWE4wYVc5dWN5aHlZWGNwSUhzTkNpQWdiR1YwSUhNZ1BTQlRkSEpwYm1jb2NtRjNLUzUwY21sdEtDa3VjbVZ3YkdGalpTZ3ZYbUJnWUNnL09tcHpiMjRwUDF4ektpOXBMQ0FuSnlrdWNtVndiR0ZqWlNndlhITXFZR0JnSkM5cExDQW5KeWs3RFFvZ0lHTnZibk4wSUcwZ1BTQnpMbTFoZEdOb0tDOWNXMXRjYzF4VFhTcGNYUzhwT3cwS0lDQnBaaUFvYlNrZ2N5QTlJRzFiTUYwN0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnWTI5dWMzUWdZWEp5SUQwZ1NsTlBUaTV3WVhKelpTaHpLVHNOQ2lBZ0lDQnBaaUFvUVhKeVlYa3VhWE5CY25KaGVTaGhjbklwS1NCN0RRb2dJQ0FnSUNCeVpYUjFjbTRnWVhKeURRb2dJQ0FnSUNBZ0lDNXRZWEFvDQpLSGdwSUQwK0lDaDdJSFJsZUhRNklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5SbGVIUXBJSHg4SUNjbktTNTBjbWx0S0Nrc0lISmxZWE52YmpvZ1UzUnlhVzVuS0NoNElDWW1JSGd1Y21WaGMyOXVLU0I4ZkNBbkp5a3VkSEpwYlNncElIMHBLUTBLSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOVBpQjRMblJsZUhRcE93MEtJQ0FnSUgwTkNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3SldFNjU2WTY2R2NJQ292SUgwTkNpQWdjbVYwZFhKdUlGdGRPdzBLZlEwS0RRb3ZMeURyb1p6cXQ3anNuYmdnN1pXRTdKcVV3cmZ0bFp6cmo0UWc3TFNJNnJPOElPeURnZTJEbk95ZHZDRHJsWXdnTDJobFlXeDBhQ0Rzb2JEdG1venFzSUFnN0ppazY2bTBJT3VTcE95WGtPeUVuQ0RzbTR6cnNJM3NsNFhzbllRZzY0dWs3SXVjSU95TG5PdVBoTzJWdE91enVPdUxwQ0FvTXpEc3RJanNsNUFnTWV1eWlPdW5qQ2t1RFFvdkx5RHNoTEhxczdYdGxaanJxYlFnNnJLdzZyTzhJTzJWdU91VHBPdWZyT3F3Z0NCamJHRjFaR1ZUZEdGMA0KZFhNOUoyOXJKK3VobkNEcmtKanJqNHpycHF6cnI0RHJvWndzSU95ZXJPdWhuT3EzdU95ZHVDRHRtNFFnNjdLRTdZcTg3SjIwSU95Z2dPeWdpT3VobkNEd241K2k3Snk4NjZHY0lPdXp0ZXEzZ08yVm5PdUxwQzROQ2k4dklDanRsSXpybjZ6cXQ3anNuYmpzbmJRZzY2R2M2cmU0N0oyNElPeXd2ZXlkaENEc2w3QWc2NUtrSU95anZPcTRzT3lnZ2V5Y3ZPdWhuQ0F2YUdWaGJIUm82Nlc4SU95aHNPMmFqTzJWbU91S2xDRHFzb1Bxczd3ZzdLZWQ3SjJFSU95ZHRPdWpyT3VMcENrTkNpOHZJTzJWbk91UGhDRHN0SWpxczd6cmo0UWc2ckNaN0oyQUlPcXl2ZXVobk91aG5DRHJzN1hxdDREc2k1enRncWpyaTZRZzRvQ1VJT3EwZ091bXJPeWVrT3F3Z0NEdGxaenJqNFRycGJ3ZzdKaXM2NkNrN0tPODZyR3c2NEtZSU8yVm5PdVBoT3F3Z0NEc3RJanF1TER0bVpUcmtKanJxYlFOQ2k4dklPeUNyT3lhcWV5ZWtPcXdnQ0RzbFlUcnJMVHFzb1ByajRRZzdKV0lJT3VJak91ZnJPdVBoQ0Ryc29UdGlyenNuYlFnOEorZm91eWMNCnZPdWhuQ0RyajR6c2xZVHNtS2pyaTZRdUlPMlZuT3VQaE95WGtDRHFzYmpycHJBZzdaaTQ3TGFjN0oyQUlPcXhzT3lnaU91UW1PdXZnT3VobkNEc2dxenNtcW5ybjRuc25ZQWc3SldJSU91Q21PcXdoT3VMcEEwS0x5OGc2ck9FN0tDVjdKMjBJQ29xNjdDVzdKZVE3SVNjS2lvZzY3Q1U2NENRSU9xeWcreWRoQ0RzbFl6c2xZVHNzWWpyaTZRZ0tESXdNall0TURnc0lFSlNTVVJIUlY5V1BUSTJLUzROQ2k4dklPMkVzT3V2dU91RWtPeWR0T3VDbUNEcnVJenJuYnpzbXJEc29JRHNsNURzaEp3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsWmpycWJRZzdKNlE2cktwN0thZDY2cUZJTzJNak95ZHZPeWRnQ0Ryc0pUcmdJenNwNERycDR3c0lPeWR0T3V2dUNEcmxxQWc3SjZJNjRxVUlHTnNZWFZrWlEwS0x5OGc3SVM0N0lXWTdKMkFJT3lMbk91UG1lMlZvQ0RybFl3ZzY3Q2I3SjJBSU95WW15RHFzNFRzb0pVZzdKNkY3SjZsNnJhTTdKMkVJT3EzdU91TWdPdWhuQ0RzazdUcmk2UWc0b2FTDQpJT3lEaUNEcXM0VHNvSlhzbDVBZzdJS3M3SnFwNjUrSjdKMjBJT3VDcU95VmhDRHNub2pzbHJUcmo0UWdJdTJWbk91UGhDRHN0SWpxczd3aTZyQ0FEUW92THlEcXM0VHNobzBnNjRLWTdKaW82NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Eb2dJdXlEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NkdjNnJlNDdKMjQ3WmFJNjRxVTY0MndJT3labkNEcXQ3Z2c2ck9FN0tDVklPeUNyT3lhcWV1ZmlleWRoQ0RycXJzZzdKT3c2NE9RSWlrdURRb3ZMeUR0bEl6cm42enF0N2pzbmJqc25ZUWc2ckd3N0xtY0lPdWhuT3EzdU95ZHVNSzM2NkdjNnJlNDdKV0U3SnVES0M5dmNHVnVMV3h2WjJsdXdyY3ZZMnhoZFdSbExXeHZaMjkxZENuc25ZQWdhMmxzYkZCeWIyUHNuTHpyb1p3ZzdJUzQ3SVdZN0oyRUlPdXloT3VncE95RW5DRHNuYlFnNjZ5NDdLQ2M2ckNBRFFvdkx5RHNsNGJzbDRqcmlwVHJqYkFzSU91d2x1eVhrT3lFbkNEcnNKVHF2cmpycWJRZzY0dWs2NmFzNnJDQUlPeVZqQ0Ryc0tucnNwWHNuYlFnN0plRw0KN0plSTY0dWtMaURxdDdqcm5wanNoSndnTDJobFlXeDBhQ0Rzb2JEdG1venJwNGpyaTZRZzdZeU03SjI4N0oyWUlPcXpoT3lnbGVxenZDRHJ1WVRxdFpEdGxaenJpNlF1RFFvdkx5RHJ1WVRzbXFrZ01DanRqSXpzbmJ6cnA0d2c3SjI5NnJPZ0xDQmpiR0YxWkdWQlkyTnZkVzUwN0oyWUlETXc3TFNJSU95NmtPeUxuT3VsdkNEcXQ3anJqSURyb1p3ZzdKTzA2NHVrSU9LQWxDQXVZMnhoZFdSbExtcHpiMjdzbmJRZzdMdWs3SVNjSU91bnBPdXlpQ0RzbmIzc3A0QWc3SldLNjRxVTY0dWtLUzROQ2k4dklPcXpoT3lnbFNEc25vanNuWXdnNG9hU0lPeVhodXlkakNqcm9aenF0N2pzbFlUc200TXBJT3V3cWUyV3BleWRnQ0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a09pRHRqSXpzbmJ6c25ZUWc2NDJ1N0phMDdKT3c2NHFVSU95SW5PcXdoQ0RzbnFEcXVaQWc2NnE3SU95ZHZldUtsQ0Rxc29QcXM3d05DaTh2SU9xMXJPdTJoT3VRbU95bmdDRHNsWXJzbFlRZzdaZWJJT3llck95TG5PeWVrZXlkaENEcnRvRHINCnBiVHFzNkFzSU9xM3VDRHJzS250bHFYc25ZQWc3SjI0N0thZElPeVlwT3VsbUNEcXNyM3JvWndvYVhOQmRYUm9SWEp5YjNJcDZyQ0FJT3lkdE91dnVDRHNzcGpycHF6dGxaenJpNlF1RFFwbWRXNWpkR2x2YmlCeVpYTjBZWEowU1daQlkyTnZkVzUwUTJoaGJtZGxaQ2dwSUhzTkNpQWdhV1lnS0NGd2NtOWpJSHg4SUhkaGFYUmxjaWtnY21WMGRYSnVPeUFnSUNBZ0lDQWdJQzh2SU95RXVPeUZtQ0RzbDRic25Zd282NHVrN0oyTUlPMkV0T3lkdENEc2c0anJvWndnN0l1YzY0K1pLU0F2SU8yRXRDRHNwNFR0bG9rZzdLU1I3SjIwNjZtMElPdUxwT3lkakNEc29iRHRtb3pzbDVEc2hKd05DaUFnWTI5dWMzUWdibTkzSUQwZ1kyeGhkV1JsUVdOamIzVnVkQ2dwT3cwS0lDQnBaaUFvSVc1dmR5QjhmQ0J1YjNjZ1BUMDlJSE5sYzNOcGIyNUJZMk52ZFc1MEtTQnlaWFIxY200N0RRb2dJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcXM0VHNvSlhzbmJRZzY3Q1U2NENNN0plSTdKYTA3SnFVSUNnbklDc2dLSE5sDQpjM05wYjI1QlkyTnZkVzUwSUh4OElDZnNsNGJzbll3bktTQXJJQ2NnNG9hU0lDY2dLeUJ1YjNjZ0t5QW5LU0RpZ0pRZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2N0tFNjZhczZyT2dJT3lEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NHVrN0l1Y0lPeUxuT3lla2UyVnFldUxpT3VMcEM0bktUc05DaUFnTHk4ZzdKMlk2NCtFN0tDQklPeWloZXVqakNoeVpXRnpiMjRnN0tlQTdLQ1ZLU0RpZ0pRZ1UwVlRVMGxQVGw5RVNVVkU2NkdjSU91Qm5ldUN0T3VwdENEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1zT3VMcEEwS0lDQnJhV3hzVUhKdll5Z242ck9FN0tDVjdKMjBJT3V3bE91QWpPeVd0T3lFbkNEc2hManNoWmpzbllRZzdJT0k2NkdjSU95TG5PeWVrZTJXaU95V3RPeWFsQ0RpZ0pRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUp5azdEUW9nSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0lDOHZJTzJWbk91UA0KaE1LMzY2R2M2cmU0N0oyNElPeURnZTJEbk91S2xDRHFzNFRzb0pYcnA0anJpNlFnNjR1azY2VzA2NHVrSU9LQWxDRHNnNGdnNnJPRTdLQ1Y3Snk4NjZHY0lPdUxwT3lMbkNEdGpKRHNvSlh0bFpqcXNvd05DaUFnYzJWemMybHZia0ZqWTI5MWJuUWdQU0J1YjNjN0RRcDlEUW9OQ214bGRDQnNZWE4wUVhWMGFGSmxkSEo1UVhRZ1BTQXdPdzBLWm5WdVkzUnBiMjRnY21WMGNubEJkWFJvU1daT1pXVmtaV1FvS1NCN0RRb2dJR2xtSUNoamJHRjFaR1ZUZEdGMGRYTWdJVDA5SUNkamJHRjFaR1V0Ykc5bmIzVjBKeUFtSmlCamJHRjFaR1ZUZEdGMGRYTWdJVDA5SUNkamJHRjFaR1V0YkdsdGFYUW5LU0J5WlhSMWNtNDdEUW9nSUdsbUlDaDNZV2wwWlhJZ2ZId2dSR0YwWlM1dWIzY29LU0F0SUd4aGMzUkJkWFJvVW1WMGNubEJkQ0E4SURNd01EQXdLU0J5WlhSMWNtNDdJQzh2SU95bmhPMldpU0RzcEpFZzdZUzBJT3V3cWUyVnRDRHF1SWpzcDRBZ0t5QXpNT3kwaUNEcXNJVHFzcWtOQ2lBZ2JHRnpkRUYxZEdoU1pYUnkNCmVVRjBJRDBnUkdGMFpTNXViM2NvS1RzTkNpQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEc25xenRtWlhzbmJnZzdJdWM2NCtFNG9DbUp5azdEUW9nSUhKMWJsUjFjbTRvS0NrZ1BUNGdKK3Vobk9xM3VPeWR1Q0R0bVpYc25ianNtcW5zbmJUcmk2UXVJQ0pQU3lMcm5ienFzNkRycDR3ZzY0dTE3WldZNjUyOExpY3BMblJvWlc0b0RRb2dJQ0FnS0NrZ1BUNGdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEdG1aWHNuYmpya0tnZzRvQ1VJT3lnbGV5RGdTRHNnNEh0ZzV6cm9ad2c2N08xNnJlQUxpY3BMQTBLSUNBZ0lDaGxLU0E5UGlCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3SldFN0tlQklPdWhuT3EzdU95ZHVDRHNsWWdnNjVDb09pY3NJRk4wY21sdVp5aGxMbTFsYzNOaFoyVXBMbk5zYVdObEtEQXNJRGd3S1NrTkNpQWdLVHNOQ24wTkNnMEtMeThnN0l1azdZeW9JT3lka2V1THRleWRoQ0RzZ3F6cm5venNtcWtnN0pXSTY0SzA2NkdjDQpJT3V6Z08yWm1DRGlnSlFnN0p1UTdKMjRLT3Vobk9xM3VPeWR1Qy9zaEtUc3VaZ3A3SjIwSU8yTWpPeVZoZXVRbkNEcXNyM3NtckRzbDVRZzZyZTRJT3lWaU91Q3RPdWx2Q3dnN0pXRTY0dUk2Nm0wSU95Z2tldVJrT3lXdEN2c201RHJyTGpzbllRZzY3TzA2NEs0NjR1a0RRcG1kVzVqZEdsdmJpQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lIQnlaV1pwZUNrZ2V3MEtJQ0JwWmlBb1pTQW1KaUJsTG0xbGMzTmhaMlVnUFQwOUlFeFBSMGxPWDBkVlNVUkZLU0J5WlhSMWNtNGdleUJsY25KdmNqb2dURTlIU1U1ZlIxVkpSRVVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0Ykc5bmIzVjBKeUI5T3cwS0lDQnBaaUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQVDA5SUV4SlRVbFVYMGRWU1VSRktTQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ1RFbE5TVlJmUjFWSlJFVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiR2x0YVhRbklIMDdEUW9nSUdsbUlDaGpiR0YxWkdWVGRHRjBkWE1nUFQwOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljcA0KSUhzTkNpQWdJQ0J5WlhSMWNtNGdleUJsY25KdmNqb2dKK3lkdENCUVEreVhrQ0JEYkdGMVpHVWdRMjlrWlNoamJHRjFaR1VwNnJDQUlPeUVwT3k1bU91UHZDRHNub2pzcDRBZzdKV0s3SldFN0pxVUlPS0FsQ0RzaEtUc3VaanRsWmpxczZBZzY2R2M2cmU0N0oyNDdaV2NJT3VTcENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0bkxDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXMXBjM05wYm1jbklIMDdEUW9nSUgwTkNpQWdjbVYwZFhKdUlIc2daWEp5YjNJNklIQnlaV1pwZUNBcklDaGxJQ1ltSUdVdWJXVnpjMkZuWlNBL0lHVXViV1Z6YzJGblpTQTZJRk4wY21sdVp5aGxLU2tnZlRzTkNuME5DZzBLWm5WdVkzUnBiMjRnY21WaFpFSnZaSGtvY21WeEtTQjdEUW9nSUhKbGRIVnliaUJ1WlhjZ1VISnZiV2x6WlNnb2NtVnpiMngyWlNrZ1BUNGdldzBLSUNBZ0lHeGxkQ0JpYjJSNUlEMGdKeWM3RFFvZ0lDQWdjbVZ4TG05dUtDZGtZWFJoSnl3Z0tHTXBJRDArSUhzZ1ltOWtlU0FyUFNCak95QjkNCktUc05DaUFnSUNCeVpYRXViMjRvSjJWdVpDY3NJQ2dwSUQwK0lIc05DaUFnSUNBZ0lIUnllU0I3SUhKbGMyOXNkbVVvU2xOUFRpNXdZWEp6WlNoaWIyUjVLU2s3SUgwZ1kyRjBZMmdnS0Y5bEtTQjdJSEpsYzI5c2RtVW9lMzBwT3lCOURRb2dJQ0FnZlNrN0RRb2dJSDBwT3cwS2ZRMEtEUXBqYjI1emRDQkRUMUpUWDBoRlFVUkZVbE1nUFNCN0RRb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxUGNtbG5hVzRuT2lBbktpY3NEUW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MU5aWFJvYjJSekp6b2dKMGRGVkN3Z1VFOVRWQ3dnVDFCVVNVOU9VeWNzRFFvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFJWldGa1pYSnpKem9nSjBOdmJuUmxiblF0Vkhsd1pTY3NEUXA5T3cwS1puVnVZM1JwYjI0Z2FuTnZiaWh5WlhNc0lITjBZWFIxY3l3Z2IySnFLU0I3RFFvZ0lISmxjeTUzY21sMFpVaGxZV1FvYzNSaGRIVnpMQ0JQWW1wbFkzUXVZWE56YVdkdUtIc2dKME52Ym5SbGJuUXRWSGx3DQpaU2M2SUNkaGNIQnNhV05oZEdsdmJpOXFjMjl1T3lCamFHRnljMlYwUFhWMFppMDRKeUI5TENCRFQxSlRYMGhGUVVSRlVsTXBLVHNOQ2lBZ2NtVnpMbVZ1WkNoS1UwOU9Mbk4wY21sdVoybG1lU2h2WW1vcEtUc05DbjBOQ2cwS1kyOXVjM1FnYzJWeWRtVnlJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvWVhONWJtTWdLSEpsY1N3Z2NtVnpLU0E5UGlCN0RRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RIUlZRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmFHVmhiSFJvSnlrZ2V3MEtJQ0FnSUhKbGMzUmhjblJKWmtGalkyOTFiblJEYUdGdVoyVmtLQ2s3SUM4dklPdXdsdXlYa095RW5DRHFzNFRzb0pYc25ZUWc2N0NVNnIrbzdKeTg2Nm0wSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRQ0KSU91b3ZPeWdnQ0Ryc29UcnByRHJpNlFnS095VmhPdWVtQ0RzbTR6cnNJM3NsNFhzbmJRZzdKaWJJT3F6aE95Z2xleWN2T3VobkNEcmo0enNwNEFnN0pXSzZyS01LUTBLSUNBZ0lISmxkSEo1UVhWMGFFbG1UbVZsWkdWa0tDazdJQzh2SU91aG5PcTN1T3lkdUNEdGxZVHNtcFFnN0lPQjdZT2M2Nm0wSU95ZXJPMlpsZXlkdUNEc2k1enJqNFFnNG9DVUlPeWVyT3Vobk9xM3VPeWR1T3lkdENEcmdaM3JncXpzbkx6cnFiUWc2NHVrN0oyTUlPeWhzTzJhak91MmdPMkVzQ0J3Y205aWJHVnQ3SjIwSU8yU2dPdW1zT3VMcEEwS0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dNakF3TENCN0RRb2dJQ0FnSUNCdmF6b2dkSEoxWlN3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnl3Z2Rqb2dRbEpKUkVkRlgxWXNJR1JwY2pvZ1gxOWthWEp1WVcxbExDQXZMeUIyd3Jka2FYSTZJT3Exck91eWhPeWdoQy9zbDRucm1ySHRsWndnN0lLczY3TzQ3SjIwSU91V29DRHNub2pyaXBUc3A0QWc3S2VFNjR1bzdKcXBEUW9nSUNBZ0lDQnQNCmIyUmxiRG9nWTNWeWNtVnVkRTF2WkdWc0xDQnRiMlJsYkhNNklFRk1URTlYUlVSZlRVOUVSVXhUTENCbGVHRnRjR3hsY3pvZ1JWaEJUVkJNUlZNdWJHVnVaM1JvTENCbmRXbGtaVG9nUjFWSlJFVXViR1Z1WjNSb0xDQnlaV0ZrZVRvZ2QyRnliV1ZrVlhBc0RRb2dJQ0FnSUNCd2NtOWliR1Z0T2lBb1kyeGhkV1JsVTNSaGRIVnpJRDA5UFNBbmIyc25JSHg4SUdOc1lYVmtaVk4wWVhSMWN5QTlQVDBnYm5Wc2JDa2dQeUJ1ZFd4c0lEb2dZMnhoZFdSbFUzUmhkSFZ6TEEwS0lDQWdJQ0FnWVdOamIzVnVkRG9nWTJ4aGRXUmxRV05qYjNWdWRDZ3BMQTBLSUNBZ0lDQWdjMlZ5ZG1Wa09pQnpkR0YwY3k1elpYSjJaV1FzSUd4aGMzUkJkRG9nYzNSaGRITXViR0Z6ZEVGMExDQnNZWE4wVkdWNGREb2djM1JoZEhNdWJHRnpkRlJsZUhRc0lHeGhjM1JUWldNNklITjBZWFJ6TG14aGMzUlRaV01zRFFvZ0lDQWdmU2s3RFFvZ0lIME5DaUFnTHk4ZzdaU002NStzNnJlNDdKMjRJT3lMck95ZXBldXdsZXVQbVNEaWdKUWc2NEdLDQo2cml3NjZtMElPeWNoQ0Rxc0pEc2k1d2c3WU9BN0oyMDY2aTQ2ckNBSU91THBPdW1yT3VsdkNEcmdZanJpNlFOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDJobFlYSjBZbVZoZENjcElIc05DaUFnSUNCc1lYTjBRbVZoZENBOUlFUmhkR1V1Ym05M0tDazdEUW9nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0RRb2dJSDBOQ2lBZ0x5OGc2NkdjNnJlNDdKMjRJT0tBbENEdGxJenJuNnpxdDdqc25ianNuWmdnVy9DZm42QWc3WUcwNjZHYzY1T2NJT3Vobk9xM3VPeWR1Q0R0bFlUc21wUmR3cmRiOEorVWtWMGc2N0tFN1lxODdKMjBJTzJZdU95Mm5PMlZuT3VMcEM0TkNpQWdMeThnNnJpdzY3TzRLT3U0ak91ZHZPeWFzT3lnZ0NEc3A0SHRsb2twT2lCZ1kyeGhkV1JsSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFXRHJwYndnN0lpbzdKMkFJTzJVaE91aG5PeUV1T3lLcE91aG5DRHNpNlR0bG9rZw0KNG9DVUlPdXBsT3VKdENEc2w0YnNuYlFnNnJPbjdKNmxJT3U0ak91ZHZPeWFzT3lnZ091bHZDRHNsN1RxczZBc0RRb2dJQzh2SUNBZ2JHOWpZV3hvYjNOMElPeUltT3lMb0NEdGo2enRpcmpyb1p3ZzZyS3c2ck84NjZXOElPeWVrT3VQbVNEc2lKanJvTG50bFp6cmk2UW83SXVrN0xpaE9pRHRsNlRyazV6cnBxenNpcVRzbDVEc2hKenJqNFFnNjdpTTY1Mjg3SnF3N0tDQUlPeVh0T3VtdkNBcklFeEpVMVJGVGlEdG1aWHNuYmdzSURJd01qWXRNRGNwTGcwS0lDQXZMeUFnSU8yRXNPdXZ1T3VFa095ZHRDRHRtWlRycWJUc2w1QWc3S0NFN1ppQUlPeVZpQ0Rybkt6cmk2UXVJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJqcnA0d2c3WldZNjZtMElPdUJuUzROQ2lBZ0x5OGc3WSswNjdDeEtPMkVzT3V2dU91RWtDazZJT3lla091UG1TRHNtWVRybzR6cXNJQWc2NmVKN1o2TUlPMlptT3F5dlNqcnVJenJuYnpzbXJEc29JRHFzSUFnYkc5allXeG9iM04wN0plUUlPdXF1eURyaTcvc2xZUWc3TDJVNjVPYzZyQ0ENCklPdXp0T3lkdE91S2xDRHFzcjNzbXJBcDdKZVE3SVNjRFFvZ0lDOHZJQ0FnNjZHYzZyZTQ3SjI0SU91TWdPcTRzQ0RzcEpFZzY3S0U3WXE4N0oyRUlPdVlrQ0RyaUlUcnBiVHJxYlFzSU95OWxPdVRuT3VsdkNEcnRwbnNsNnpyaEtQc25ZUWc3SWlZSU95ZWlPdUtsQ0R0aExEcnI3anJoSkFnNjdDcDdJdWQ3Snk4NjZHY0lPeWdoTzJabU8yVm5PdUxwQzROQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDI5d1pXNHRiRzluYVc0bktTQjdEUW9nSUNBZ1kyOXVjM1FnWW05a2VTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3RFFvZ0lDQWdZMjl1YzNRZ2MzZHBkR05vVFc5a1pTQTlJQ0VoS0dKdlpIa2dKaVlnWW05a2VTNXpkMmwwWTJoQlkyTnZkVzUwS1RzZ0x5OGc2ck9FN0tDVklPeWdoTzJabUNBOUlPeUxuTzJCck91bXZ5RHNzTDNzbkx6cm9ad2c3SmUwN0phMElPcXpoT3lnbGV5ZGhDRHFzNkRycGJ3ZzdJaVlJT3llaU9xeWpBMEtJQ0FnDQpJSFJ5ZVNCN0RRb2dJQ0FnSUNBdkx5QmpiR0YxWkdYcXNJQWc3SmVHN0p5ODY2bTBJT3lYck9xNHNPeUVuQ0RyZ1lycmlwVHJpNlF1SUhOb1pXeHNPblJ5ZFdYcm5id2dZMnhoZFdSbDZyQ0FJT3lYaHV5V3RPdVBoQ0RzaGJqc25ZQWc3S0NWN0lPQklPeUxwTzJXaWV1UHZBMEtJQ0FnSUNBZ0x5OGdjM0JoZDI3c25aZ2dKMlZ5Y205eUorcXdnQ0RzbFlnZzY1eW82ck9nTENEc21JanNvSVRzbDVRZzZyZTQ2NHlBNjZHY0lHOXJPblJ5ZFdYcnBid2c2NCtNNjZDazdLU3M2NHVrSU9LQWxBMEtJQ0FnSUNBZ0x5OGc3WlNNNjUrczZyZTQ3SjI0N0oyQUlDTHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA3SmVJN0phMDdKcVVJdXVkdk9xem9DRHRsWmpyaXBUcmpiQWc3SXVrN0tDYzY2R2M2NHFVSU95VmhPdXN0T3F5Zyt1UGhDRHNsWWdnNjV5bzY0cVVJT3lEZ2UyRG5PcXdnQ0Rya0pEcmk2UW83SXVrN0tDY0lPeUxvT3F6b0NrdURRb2dJQ0FnSUNCcFppQW9ZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQW5ZMnhoZFdSbA0KTFcxcGMzTnBibWNuS1NCN0RRb2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXhMQ0I3RFFvZ0lDQWdJQ0FnSUNBZ1pYSnliM0k2SUNmc25iUWdVRVBzbDVBZ1EyeGhkV1JsSUVOdlpHWHFzSUFnN0plRzdKYTA3SnFVSU9LQWxDRHRoTERycjdqcmhKRHNsNURzaEp3Z1kyeGhkV1JsSUMwdGRtVnljMmx2YmlEc25iUWc2NUNZNjRxVTdLZUFJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2hManNtcFF1Snl3TkNpQWdJQ0FnSUNBZ0lDQndjbTlpYkdWdE9pQW5ZMnhoZFdSbExXMXBjM05wYm1jbkxBMEtJQ0FnSUNBZ0lDQjlLVHNOQ2lBZ0lDQWdJSDBOQ2lBZ0lDQWdJQzh2SU95bmhPMldpU0RzcEpIc25ianJqYkFnNjVpUUlPdUlqT3VnZ091THBDRGlnSlFnN0p1UTdMbVo3SjJBSUNMcnVJenJuYnpzbXJEc29JRHJvWndnNjR1azdJdWNJT3lYdE9xNHNDTHJpNlF1SU8yRXNPdXZ1T3VFa095ZGdDQXFLdXl3dmV5ZGhDRHNsWVRyckxUcXNvUHJqNFFnNjZxN0lPdWRoT3lib095ZGhDRHJsWXpycDR3cUtpNE4NCkNpQWdJQ0FnSUM4dklPeVlpT3lnaE95WGxDQW5OakRzdElnZzY0U1k2cktNSU91TWdPcTRzQ0RzcEpIc25iVHJxYlFnN1lTdzY2KzQ2NFNRSit5ZHRPeVhpT3VLbE91TnNDd2c2NkdjNnJlNDdKMjRJTzJabE91cHRPeWRoQ0RzbmIzcXNiRHJncGdnN0o2ZzZybVFJT3VVdENEc25id2c3WldZNjR1a0lPdUxwT3lMbkNEcmlJVHJwYmdOQ2lBZ0lDQWdJQzh2SU95Z2xleURnZXlnZ2V5ZHVDRHFzcjNzbXJEc2w1RHJqNFFnWTIxa0lPeXd2ZXlkdENEdGlvRHNsclRyZ3Bqc21aVHJpNlFvTWpBeU5pMHdPQ0RzaTZUc3VLRWc3SXVnNnJPZ09pQWk3WVN3NjYrNDY0U1FJTzJabE91cHRPeWRnQ0RzbVp3ZzY1YWdJT3F3a2V5ZWtPcTRzQ0lwTGcwS0lDQWdJQ0FnTHk4ZzdKMjA3S0NjSU95YXNPdW1yT3F3Z0NEc3NMM3NuWVFnN0tlQjdLQ1JJT3lYdE9xem9DRHNoTEhxczdVZzdKZXM2N2FBS0d4dloybHVWMmx1Wkc5M1QzQmxibVZrS2V1bHZDRHNsWVRyaTRqcXVZd3NJT3lMbk9xd2hPeWR0Q0RzbFlUcmk0anJuYndnDQo2cmU0SU95Q3JPeUxwT3VobkNEdGpKRHJpNmp0bFp6cmk2UXVEUW9nSUNBZ0lDQmpiMjV6ZENCemRHRnNaU0E5SUd4dloybHVVSEp2WXlBbUppQWhiRzluYVc1WGFXNWtiM2RQY0dWdVpXUWdKaVlnS0VSaGRHVXVibTkzS0NrZ0xTQnNiMmRwYmxOMFlYSjBaV1JCZENBK0lESXdNREF3S1RzTkNpQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdKaVlnYzNSaGJHVXBJSHNOQ2lBZ0lDQWdJQ0FnYTJsc2JFeHZaMmx1VUhKdll5Z3BPdzBLSUNBZ0lDQWdJQ0JwWmlBb0lXOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa3BJSHNOQ2lBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Td2dleUJsY25KdmNqb2dKK3lkdENCUFUreVhrT3lFb0NEc25wRHJqNW5zbkx6cm9ad2c2NnE3SU95WHRPeVd0T3lhbENEaWdKUWc3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNEc2k2VHRsb2tnN1p1RUlDOXNiMmRwYmlEdGxiUWc3S084N0lTNDdKcVVMaWNnZlNrN0RRb2dJQ0FnSUNBZ0lIME5DaUFnSUNBZw0KSUNBZ0x5OGc3SjJZNjQrRTdLQ0JJT3lpaGV1ampDaHlaV0Z6YjI0ZzdLZUE3S0NWS1NEaWdKUWc3S2VFN1phSklPeWtrU0R0aExUc25ZUWdVMFZUVTBsUFRsOUVTVVZFNjZHY0lPdUJuZXVDdE91cHRDRHNucERyajVrZzdKNnM3SXVjNjQrRTZyQ0FJT3lZbXlEcXM0VHNvSlVnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtc091THBBMEtJQ0FnSUNBZ0lDQnJhV3hzVUhKdll5Z242NkdjNnJlNDdKMjQ3SjJFSU95bmhPMldpZTJWbU91S2xDRHNwSkhzbmJUcm5id2c3SnFVN0xLdDdKMkVJT3lra2V1THFPMldpT3lXdE95YWxDRGlnSlFnNjZHYzZyZTQ3SjI0SU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5LVHNOQ2lBZ0lDQWdJQ0FnWVdOamIzVnVkRU5oWTJobExtRjBJRDBnTURzTkNpQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0R0ajdUcnNMRWc0b0NVSU8yRXNPdXZ1T3VFa0NEcnNLbnNpNTNzbkx6cm9ad2c3S0NFN1ptWUxpY3ANCk93MEtJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2JXOWtaVG9nSjNSbGNtMXBibUZzSnlCOUtUc05DaUFnSUNBZ0lIME5DaUFnSUNBZ0lDOHZJT3V3cWVxNGlDRHNpNXpzbnBIdGxad2c2NkdjNnJlNDdKMjQ3SjIwSU95Q3RPeVZoQ0Rzbm9qc25MenJxYlFnN0lhUTY0eUE3S2VBSU95Vml1dUtsT3VMcENEaWdKUWc3S085N0oyMDY2bTBJT3lDck95YXFleWVrT3F3Z0NEcnM3VHFzNkFnN0o2STY0cVVJTzJEcmV5ZG1DRHN2Wnpyc0xFZzdZK3M3WXE0NnJDQURRb2dJQ0FnSUNBdkx5RHJpNnZ0bUlBZ0lteHZZMkZzYUc5emRPeVhrT3lFbkNEc2w3RHFzckRzbllRZzZyR3c2N2FBN1phSTdJcTE2NHVJNjR1a0l1cXdnQ0Rybkt6cmk2UW9NakF5Tmkwd09DRHNpNlRzdUtFZzdJdWc2ck9nS1M0TkNpQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdKaVlnUkdGMFpTNXViM2NvS1NBdElHeHZaMmx1VTNSaGNuUmxaRUYwSUR3Z01UVXdNREFwSUhzTkNpQWdJQ0FnDQpJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHNzTDNzbmJRZzdKMjA2Nis0SU95WHRPdWdwQ0Rzbm9qc2xyVHNtcFFnNG9DVUlPeURpT3VobkNEc2w3VHNwNEFnN0pXSzZyT2dJT3EzdUNEc3NMM3NuWVFnN0pPdzdJUzQ3SnFVTGljcE93MEtJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2JXOWtaVG9nSjJGc2NtVmhaSGt0YjNCbGJpY2dmU2s3RFFvZ0lDQWdJQ0I5RFFvZ0lDQWdJQ0JyYVd4c1RHOW5hVzVRY205aktDazdJQzh2SU95Vm51eUVvQ0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNDdKMjBJT3VNZ09xNHNDRHNwSkhzbmJUcnFiUWc3S0NSNnJPZ0lPeURpT3VobkNEc2w3RHJpNlFnS095d3ZleWRoQ0RyaTZ2c2xaanFzYkRyZ3BnZzY0dWs3SXVjSU91SWhPdWx1Q0Rxc3Izc21yQXBEUW9nSUNBZ0lDQnNiMmRwYmxOMFlYSjBaV1JCZENBOUlFUmhkR1V1Ym05M0tDazdEUW9nSUNBZ0lDQnNiMmRwYmxkcA0KYm1SdmQwOXdaVzVsWkNBOUlHWmhiSE5sT3lBdkx5RHNuYlRyc29nZzdJdWM2NCtFN0oyWUlPeXd2U0RzbDdUcXVMQWc3SVN4NnJPMUlPeVhyT3UyZ0NEaWdKUWc3SldFNjU2WTdKZVE3SVNjSU95RXVPeWF0T3VMcEEwS0lDQWdJQ0FnTHk4Z1FsSlBWMU5GVXV1S2xDRHFzYlRyazV6cnBxenNwNEFnN0pXSzY0cVU2NHVrSU9LQWxDQkRURW5xc0lBZzZyaXc2N080SU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUcXM2QWdiRzlqWVd4b2IzTjA2NkdjSU9xeXNPcXp2T3VsdkNEc25wRHJqNWtnN0lpWTY2QzU3WldjNjR1a0RRb2dJQ0FnSUNBdkx5QW83SnlFSUNmcm9aenF0N2pzbmJqc25ZQWdRMHhKNnJDQUlPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJwYndnN0tlQjdLQ1JJT3lYdE9xeWpDRHRsWnpyaTZRbklPeWp2T3lFblNEaWdKUWc2ckNBNjZHYzdMR0U2Nm0wSU95OWxPdVRuQ0RydHBuc2w2enJoS1BxdUxBZzdabVU2Nm0wN0oyMElPdWNyT3VMcENrdURRb2dJQ0FnSUNBdkx5QXFLdXF6aE95Z2xTRHMNCm9JVHRtWmpzbllBZzdKdTVJT3Vobk9xM3VPeVZoT3liZyt5ZGhDRHJxTHpzb0lBZzdKZXc2NHVrS2lvb01qQXlOaTB3T0N3Z1FsSkpSRWRGWDFZOU16RXBPaURydUl6cm5ienNtckRzb0lEc2w1QWc3SVM0N0lXWTdKMjBJT3VDcU95VmhDRHNub2pzbkx6cnFiUU5DaUFnSUNBZ0lDOHZJR0YxZEdodmNtbDZaZXF3Z0NEcXM0VHNvSlhzbllRZzY2eTc3S2VBSU95Vml1cXpvQ0RzaXJuc25iZ2c3Wm1VNjZtMDY2ZU1JT3VkaE95YXRPdUxwQ2dpN0lxNTdKMjRJTzJabE91cHRDRHJwNURxczZBZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95Y3ZPdWhuQ0Rxc0lEcXM2QWc3SXUyNjR1a0lpRHNtcFRxdGF3cExnMEtJQ0FnSUNBZ0x5OGc3SVM0N0lXWTdKMkVJT3luZ095YXRDRHJrcVFnN0plMDY2bTBJT3Vobk9xM3VPeWR1Q0R0bVpUcnFiVHJ0b0R0aExBZzY0S1k3SmlvNjR1a0lPS0FsQ0JWVWt6c25ZUWc2ckNBNnJPMTdaV1k3S2VBNjQrRUtPeXl0T3lkdE91TG5TRHNpNlR0aktncExDQkNVazlYVTBWUzY2VzhJT3F3DQpnT3Vobk95eGhPeW5nT3VQaEEwS0lDQWdJQ0FnTHk4Z0tPeTlsT3VUbkNEcnRwbnNsNnpyaEtQcXVMQWc3SnlnNjdDY0tTd2c2N2lNNjUyODdKcXc3S0NBNjZXOElPcXpvT3VsdE95bmdPdVBoQ2pxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBSU95VmhPdUxtQ2tnN0pXSzY0cVVJT3ljb095ZHZPMlZuQ0Ryc0tucnNwVXVEUW9nSUNBZ0lDQXZMeURydG9Ec25wSHNtcWs2SU91NGpPdWR2T3lhc095Z2dPeWRtQ0JqYkdGMVpHVWc3SnU1SU91aG5PcTN1T3lkdU91UGhDRHRrb0RycHJEcmk2UWc0b0NVSU9xemhPeWdsZXlkaENEcnNKVHF2cmpyb0tUcmlwUWc3SjJZNjQrRTdKbUFJT3V3cWUyV3BleWR0Q0Rxc0puc2xZUWc3SWlZN0pxcExnMEtJQ0FnSUNBZ1kyOXVjM1FnYzNSaGNuUk1iMmRwYmlBOUlDZ3BJRDArSUhzTkNpQWdJQ0FnSUNBZ1kyOXVjM1FnZEdocGMweHZaMmx1SUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbllYVjBhQ2NzSUNkc2IyZHBiaWNzSUNjdExXTnNZWFZrWldGcEoxMHNJSHNOQ2lBZw0KSUNBZ0lDQWdJQ0J6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTENCemRHUnBiem9nSjJsbmJtOXlaU2NzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsTEEwS0lDQWdJQ0FnSUNBZ0lHUmxkR0ZqYUdWa09pQndjbTlqWlhOekxuQnNZWFJtYjNKdElDRTlQU0FuZDJsdU16SW5MQ0F2THlCcmFXeHNURzluYVc1UWNtOWo3SjJZSU9xM3VPdWp1U0JyYVd4czdKcXBJQ2hyYVd4c1VISnZZK3F6dkNEcmo1bnNuYndnN1l5bzdZUzBLUTBLSUNBZ0lDQWdJQ0I5S1RzTkNpQWdJQ0FnSUNBZ2JHOW5hVzVRY205aklEMGdkR2hwYzB4dloybHVPdzBLSUNBZ0lDQWdJQ0JzYjJkcGJsZHBibVJ2ZDA5d1pXNWxaQ0E5SUhSeWRXVTdJQzh2SUVOTVNlcXdnQ0RzbDZ6cmlwUWc2ckcwSU9xMGdPeXdzTzJWb0NEc2lKZ2c3SmVHN0p5ODY0dUlJT3lYdE91bXNDRHFzb1Bzbkx6cm9ad2c2N080NjR1a0lDanNucXp0Z2JUcnBxM3NsNUFnN1lTdzY2KzQ2NFNRSU91d3FleW5nQ2tOQ2lBZ0lDQWdJQ0FnZEdocGMweHYNCloybHVMbTl1S0NkbGNuSnZjaWNzSUNncElEMCtJSHNnYVdZZ0tHeHZaMmx1VUhKdll5QTlQVDBnZEdocGMweHZaMmx1S1NCc2IyZHBibEJ5YjJNZ1BTQnVkV3hzT3lCOUtUc05DaUFnSUNBZ0lDQWdkR2hwYzB4dloybHVMbTl1S0NkamJHOXpaU2NzSUNoamIyUmxLU0E5UGlCN0RRb2dJQ0FnSUNBZ0lDQWdhV1lnS0d4dloybHVVSEp2WXlBaFBUMGdkR2hwYzB4dloybHVLU0J5WlhSMWNtNDdEUW9nSUNBZ0lDQWdJQ0FnYkc5bmFXNVFjbTlqSUQwZ2JuVnNiRHNOQ2lBZ0lDQWdJQ0FnSUNCcFppQW9iRzluYVc1UWNtOWpWR2x0WlhJcElIc2dZMnhsWVhKVWFXMWxiM1YwS0d4dloybHVVSEp2WTFScGJXVnlLVHNnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J1ZFd4c095QjlEUW9nSUNBZ0lDQWdJQ0FnWVdOamIzVnVkRU5oWTJobExtRjBJRDBnTURzZ0x5OGc3SU9JSU9xemhPeWdsZXlkdkNEc2lKZ2c3SjZJN0p5ODY0dUlJT3VMcE95ZGpDQXZhR1ZoYkhSb0lPdVZqQ0RyaTZUc2k1d2c3SjI5NnJpd0RRb2dJQ0FnDQpJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJnZzdLQ0k3TENvSU95aWhldWpqQ0FvWTI5a1pTQW5JQ3NnWTI5a1pTQXJJQ2NwSnlrN0RRb2dJQ0FnSUNBZ0lDQWdMeThnN0lLczY1Nk03SjIwSU91aG5PcTN1T3lkdU8yVm9DRHNpNXpxc0lUcmo0UWc3SmVHN0oyMElPcXpwK3V3bE91aG5DRHNpNlR0aktqcm9ad2c2NEdkNjRLczY0dWtJRDBnWTJ4aGRXUmw2ckNBSU95WGh1cXhzT3VDbUNEc2k2VHRsb25zbmJRZzdKV0lJT3VRbkNEcXNvTXVEUW9nSUNBZ0lDQWdJQ0FnTHk4ZzdKMlI2NHUxN0oyQUlPeWR0T3V2dUNEcnM3VHJnNGpzbkx6cmk0Z2c3SU9CN1lPYzY2VzhJT3VMcE95TG5DRHNucXpzaEp3Z0wyaGxZV3gwYU91aG5DRHNsWXpycHJEcmk2UWdLTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJqSURxdUxBZzdabVU2Nm0wN0oyRUlPeUxwTzJNcU91aG5DRHJzSlRxdnJ6cmk2UXBMZzBLSUNBZ0lDQWdJQ0FnSUdsbUlDaGpiMlJsSUNFOQ0KUFNBd0lDWW1JRVJoZEdVdWJtOTNLQ2tnTFNCc2IyZHBibE4wWVhKMFpXUkJkQ0E4SURVd01EQXBJSHNOQ2lBZ0lDQWdJQ0FnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Ryb1p6cXQ3anNuYmpzbmJRZzdLYUo3SXVjSU95THBPMk1xT3VobkNEcmdaM3JncWdnNG9DVUlFTnNZWFZrWlNCRGIyUmxJT3lFcE95NW1DRHNnNEh0ZzV6cnBid2c2NHVrN0l1Y0lPeWdrT3F5Z08yVnFldUxpT3VMcEM0bktUc05DaUFnSUNBZ0lDQWdJQ0FnSUdOb1pXTnJRMnhoZFdSbFFYWmhhV3hoWW14bEtDazdEUW9nSUNBZ0lDQWdJQ0FnZlEwS0lDQWdJQ0FnSUNCOUtUc05DaUFnSUNBZ0lDQWdMeThnTXpEcnRvUWc0b0NVSU95ZHRDRHRsSVRyb1p6c2hManNpcVRxc0lBZzdLTzk3Snk4NjZtMElPdTRqT3Vkdk95YXNPeWdnQ0Rzdlp6cnNMSHNuYlFnNnJDSUlHeHZZMkZzYUc5emRDRHRqNnp0aXJqcmo0UWc2NHVyN1ppQUlDZnNsN0Rxc3JEc25ZUWc2ckd3NjdhQTdaYUk3SXExNjR1STY0dWtKK3F3Z0NEcm5LenINCmk2UXVEUW9nSUNBZ0lDQWdJQzh2SU95WWlPeWdoQ0F4TU91MmhPeWRnQ0RzcDZmc2xZVHNoSndzSU91aG5PcTN1T3lkdU8yVm1PdUxwQ0RzbnFEcXVaQWc2NHVrNjZXNElPeWR2T3lkaENEdGxaanJxYlFnN1lPdDdKMjBJT3VzdE8yYXFPcXdnQ0Rya0pEcmk2UW9NakF5Tmkwd09DRHNpNlRzdUtFZzdJdWc2ck9nS1M0TkNpQWdJQ0FnSUNBZ2JHOW5hVzVRY205alZHbHRaWElnUFNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhzZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0F6TU91MmhDRHFzcjNxczd3ZzRvQ1VJT3VNZ09xNHNDRHRsSVRyb1p6c2hManNpcVFnN0tDVjY2YXNMaWNwT3lCcmFXeHNURzluYVc1UWNtOWpLQ2s3SUgwc0lERTRNREF3TURBcE93MEtJQ0FnSUNBZ2ZUc05DaUFnSUNBZ0lDOHZJQ29xNnJPRTdLQ1ZJT3lnaE8yWm1DQTlJT3Vobk9xM3VPeVZoT3liZ3lBcklPdTRqT3Vkdk95YXNPeWdnT3lYa0NEcm9aenF0N2pzbmJnZzdabVU2Nm0wS2lvZ0tESXdNall0DQpNRGdzSUVKU1NVUkhSVjlXUFRNMkxDRHNncXpzbXFuc25wQWc2ckt3N0tDVktTNE5DaUFnSUNBZ0lDOHZJT3lLdWV5ZHVDRHRtWlRycWJUc25iUWc2NXlvNjRxVUlPcTN2T3V6dUNEc201RHNuYmpzbllBZ0l1dTRqT3Vkdk95YXNPeWdnT3lYa0NEc21Kc2c2ck9FN0tDVjdKMjBJT3Vobk9xM3VPeWR1T3VQdkNEc25vanJpNlFpNjRxVUlPcXlnK3lkdE91dmdPdWhuQ3dnN0tDRTdabVk3SjJZSU95eXF5RHJqNW5zbnBIc25ZQU5DaUFnSUNBZ0lDOHZJT3Vobk9xM3VPeWR1T3lkdENEc2xZVHJpNGpybmJ3Z0tpcnJvWnpxdDdqc2xZVHNtNE1xS3V5ZHRPeVd0T3lWdkNEcnA1N3JpNlF1SU9xM3VPdWVtT3lFbkNEc2w2enF1TERzaEp6cmlwUWc2NkdjNnJlNDdKMjQ3SjJFSU95TG5PeWVrZTJWbU95bmdDRHNsWXJyaXBUcmk2UTZEUW9nSUNBZ0lDQXZMeUFnSU9LUm9DQkRURWtnNjZHYzZyZTQ3SldFN0p1REtHTnNZWFZrWlNCaGRYUm9JR3h2WjI5MWRDa2c0b0NVSU95WW15RHNucERxc3Fuc3BwM3Jxb1hDdCt5RQ0KdU95Rm1DRHRqNURxdUxBTkNpQWdJQ0FnSUM4dklDQWc0cEdoSU91NGpPdWR2T3lhc095Z2dDRHNtN2tnNjZHYzZyZTQ3SldFN0p1RElPeVh0T3E0c0NEaWdKUWdZMnhoZFdSbExtRnBMMnh2WjI5MWRPeWRnQ0Ryb1p6cXQ3anNsWVRzbTRNZzdadUVJQ29xNjZHYzZyZTQ3SjI0SU8yWmxPdXB0T3ljdk91aG5DRHNzS25zcDRBcUt1MlZuT3VMcENqdGc2MGdNZXF3bkNrTkNpQWdJQ0FnSUM4dklPdWhuT3EzdU95VmhPeWJnK3lkdENEcmdaM3JncGpycWJRZzZyT242N0NVNjZHY0lFTk1TU0Ryb1p6cXQ3anNuYmpxdVl6c3A0QWc3SjIwN0phMDdJU2NJT3lMbk95ZWtlMlZuT3VMcENEaWdKUWc3SVM0N0lXWTdKMjBJT3U1aE95YmpPeW5oQ0Rya3FUcm5id2c3SXE1N0oyNElPMlpsT3VwdE95ZHRDRHNsWVRyaTRqcm5id05DaUFnSUNBZ0lDOHZJT3Vobk9xM3VPeWR1Q0R0bVpUcnFiVHNuYlFnNjRLWTdKaW82NHVrTGlEdGdiVHJwcTBnN1pXY0lPdXlpT3ljdk91aG5DQWk2NkdjNnJlNDdKV0U3SnVESU9LR2tpRHMNCmc0Z2c2ck9FN0tDVklPdWhuT3EzdU95ZHVDTHNuYlFnNjRHZDY0S2M2NHVrTGcwS0lDQWdJQ0FnYVdZZ0tITjNhWFJqYUUxdlpHVXBJSHNOQ2lBZ0lDQWdJQ0FnYTJsc2JFeHZaMmx1VUhKdll5Z3BPeUF2THlEcmpJRHF1TEFnN0tTUjdKMjRJT3lZbXlEcm9aenF0N2pzbmJnZzdLQ0k3TENvNnJDQUlPeWVpT3ljdk91cHRDRHNvSkhyaXBUcmk2UU5DaUFnSUNBZ0lDQWdZMjl1YzNRZ2JHOGdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWRoZFhSb0p5d2dKMnh2WjI5MWRDZGRMQ0I3SUhOb1pXeHNPaUIwY25WbExDQmxiblk2SUVOTVFWVkVSVjlGVGxZc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbElIMHBPdzBLSUNBZ0lDQWdJQ0JzYnk1dmJpZ25aWEp5YjNJbkxDQW9LU0E5UGlCN0lDOHFJR05zWVhWa1pTRHNsNGJzbll3ZzY1T3hJT0tBbENEc2xZVHJucGdnN0p1NUlPdWhuT3EzdU95VmhPeWJnK3lkZ0NEcXQ3anJqSURyb1p3ZzdLZUU3WmFKSUNvdklIMHBPdzBLSUNBZ0lDQWdJQ0F2THlBcUt1MkRyZXlkDQpnQ0Ryc0pqcms1enNpNXdnTWVxd25Db3FJQ2d5TURJMkxUQTRMQ0JDVWtsRVIwVmZWajAwTUN3ZzdJS3M3SnFwN0o2UUlPeWFsT3ExckNrNklPeWJ1U0Ryb1p6cXQ3anNsWVRzbTRNZzdLTzg3SWFNNjZXOElPdVVzT3VobkNEc2w3VHJxYlFOQ2lBZ0lDQWdJQ0FnTHk4ZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95ZHRDRHJrWkFnNnJDY0tPdWhuT3EzdU95VmhPeWJneURzc0tuc3A0QWc3Wm1VNjZtMElDc2dUMEYxZEdnZzdabVU2Nm0wS1NEcmxxRHNoSndnN0phMDY0cVFJT3lxdmV5WGtDRHJvWnpxdDdqc25ianRsYlRzbGJ3ZzdaV1k2NHFVN0tlQUlPeVZqQ0RzaUpnZzdKZUc2ck9nTEEwS0lDQWdJQ0FnSUNBdkx5RHNsNG5ybXJIdGxad2c3S3E5N0plUUlPdWhuT3EzdU95ZHVPMlZtT3VwdENEdGxJenJuNnpxdDdqc25ianNuWUFnN0pldzZyS3c2NUNZN0tlQUlPeVZpdXVLbE91THBDanNpNlRzdUtFZzdJdWc2ck9nSURMdG1vdzZJQ0xzbVp3ZzY1R1FJT3F3bk91Q21DRHJscUFpTENBaTY2R2M2cmU0N0oyNA0KN1phSTY0cVU2NDJ3SU95Wm5DSXBMZzBLSUNBZ0lDQWdJQ0F2THlEcXQ3anJucGpzaEp3ZzdKdTVJT3Vobk9xM3VPeVZoT3liZyt5ZGdDRHNsN1RzcDRBZzdKV0s2NHFVNjR1a0lPS0FsQ0JEVEVrZzY2R2M2cmU0N0pXRTdKdUQ2NmVNSU8yVm1PcXpvQ0Ryb1p6cXQ3anNuYmdnN0xDOUlPMlZtT3VDbU91bmpDRHJuWVRzbXJUcmk2UXVEUW9nSUNBZ0lDQWdJQzh2SUNBZ3dyY2c2N2lNNjUyODdKcXc3S0NBNnJDQUlPdWhuT3EzdU95VmhPeWJnK3VQdkNEc25vanNuTHpycWJRZzRvYVNJT3Vobk9xM3VPeWR1Q0R0bVpUcnFiVHNuYlFnNjdDVTY2R2NJT3VDbU95WXFPdUxwQTBLSUNBZ0lDQWdJQ0F2THlBZ0lNSzNJT3U0ak91ZHZPeWFzT3lnZ095WGtDRHNoTGpzaFpqc25iUWc2NEtvN0pXRUlPeWVpT3ljdk91cHRDRGlocElnN0lxNTdKMjRJTzJabE91cHRPeWR0Q0RyZ3Bqc21LanJpNlF1SU9xM3VDRHRtWlRycWJRZzdaV1k2NHVvSUZ2cXM0VHNvSlVnN0tDRTdabVlYZXljdk91aG5DRHFzNFRzb0pYc25ZUWcNCjZyT2c2Nlc0NjR1a0RRb2dJQ0FnSUNBZ0lDOHZJQ0FnSUNBbzdJcTU3SjI0SU8yWmxPdXB0T3lkaENEcXNiVHJoSWpybTdEcm9LVHJxYlFnNjdpTTY1Mjg3SnF3N0tDQTdKZVE3SVNjSUdOc1lYVmtaU0Ryb1p6cXQ3anNsWVRzbTRQc25ZUWc2Nmk4N0tDQUlPMlZ0T3lWdkNEdGxaanJpcFRyamJBc0lPcTN1T3F4dENEdGc2M3NuYlFnN1pXWTY0S1lJT3VObENEdGxZVHNtcFR0bFpqcmk2UXBEUW9nSUNBZ0lDQWdJQzh2SU91aG5PcTN1T3lkdU95ZGdDQXFLdXVobk9xM3VPeVZoT3liZyt5ZHRDRHJnWjNyZ3B3ZzY1S2tLaW9nN0l1YzdKNlI3WldjNjR1a0lPS0FsQ0RycUx6c29JQWc2NTJFN0pxdzY2bTBJT3Vobk9xM3VPeVZoT3liZyt5ZHRDRHNnNGdnN0o2UTZyS3A3S2FkNjZxRjdKMkVJT3luZ095YXVDRHNpSmdnN0o2STY0dWtMZzBLSUNBZ0lDQWdJQ0JzYnk1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGdldzBLSUNBZ0lDQWdJQ0FnSUd0cGJHeFFjbTlqS0NmcXM0VHNvSlhzbllRZzY3Q1U2cjY0DQo2NkNrNnJPZ0lPdWhuT3EzdU95VmhPeWJnKzJWdE95RW5DRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bzdaYUk3SmEwN0pxVUxpY3BPeUF2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NSUNqc25wRHJqNWtnN0o2czdJdWM2NCtFSU91d3FleW5nQ2tOQ2lBZ0lDQWdJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QXZMeURyaTZUc25Zd2c3S0d3N1pxTTdKZVE3SVNjSUNmcXM0VHNvSlVnN0plRzdKMk1KK3ljdk91aG5DRHNuYjN0bm9qcXNvd05DaUFnSUNBZ0lDQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQnVkV3hzT3lBdkx5RHNnNEh0ZzV3ZzdKNnM3WXlRN0tDVkRRb2dJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU9xemhPeWdsU0Rzb0lUdG1aZ2c0b0NVSUVOTVNTRHJvWnpxdDdqc2xZVHNtNE1nS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NEaWhwSWc2NkdjNnJlNDdKMjRJT3l3dmV5ZGhDRHNsNzNyaTRqcmk2UXVKeWs3RFFvZ0lDQWdJQ0FnSUNBZ2FXWWdLQ0ZzYjJkcA0KYmxCeWIyTXBJSE4wWVhKMFRHOW5hVzRvS1RzTkNpQWdJQ0FnSUNBZ2ZTazdEUW9nSUNBZ0lDQWdJR3h2WjJsdVUzUmhjblJsWkVGMElEMGdSR0YwWlM1dWIzY29LVHNOQ2lBZ0lDQWdJQ0FnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUhSeWRXVXNJRzF2WkdVNklDZGljbTkzYzJWeUxYTjNhWFJqYUNjZ2ZTazdEUW9nSUNBZ0lDQjlEUW9nSUNBZ0lDQXZMeURycDR6cm80d2c3SjZzNjZHYzZyZTQ3SjI0SU9LQWxDRHFzSm5zbllBZzZyT0U3S0NWN0oyMDY1MjhJT3lFdU95Rm1PeWRoQ0RzcDREc21yRHNwNEFnN0pXSzZyT2dJT3EzdU91TWdPdWhuQ0RzbDdEcmk2UW82N21nNjZXMDY0dWtLUTBLSUNBZ0lDQWdjM1JoY25STWIyZHBiaWdwT3cwS0lDQWdJQ0FnTHk4ZzY0S2g3SjJBSU95ZWhleWVwZXEyak95ZGhDRHJyTHpxczZBZzdKNkk2NHFVSU91TWdPcTRzQ0RzaExqc2haanNuWUFnNjdLRTY2YXc2NHVrSU9LQWxDRHNucXpyb1p6cXQ3anNuYmdnN1p1RUlPdUxwT3lkakNEc21wVHMNCnNxM3NuYlFnN0lPSUlPeUV1T3lGbUNqc2c0Z2c3SjZGN0o2bDZyYU1LZXljdk91aG5DRHNpNXpzbnBIdGxaanFzb3d1RFFvZ0lDQWdJQ0F2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NS0hKbFlYTnZiaURzcDREc29KVXBJT0tBbENCVFJWTlRTVTlPWDBSSlJVVHJvWndnNjRHZDY0SzA2Nm0wSU95ZWtPdVBtU0RzbnF6c2k1enJqNFRxc0lBZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2Q2tEUW9nSUNBZ0lDQXZMeURzbnF6cm9aenF0N2pzbmJnZzY1S2s3SmVRNjQrRUlFMUJXRjlVVlZKT1UrcTVqT3luZ0NEc21Kc2c2ck9FN0tDVjdKeTg2NkdjSU95eW1PdW1yT3VRbU91S2xDRHJzb1RxdDdqcXNJQWc2NUNjNjR1a0lDZ3lNREkyTFRBM0lPdW1yT3Uzc095WGtPeUVuQ0R0bVpYc25iZ3BEUW9nSUNBZ0lDQnJhV3hzVUhKdll5Z242NkdjNnJlNDdKMjQ3SjJFSU95bmhPMldpZTJWbU91S2xDRHNwSkhzbmJUcm5id2c3SnFVN0xLdDdKMkVJT3lra2V1THFPMldpT3lXdE95YWxDRGlnSlFnDQo2NkdjNnJlNDdKMjRJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0bktUc05DaUFnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFbklDc2dLSE4zYVhSamFFMXZaR1VnUHlBbklDanFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDRHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPdWNxT3VwdENEcXQ3Z2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjNzbkx6cm9ad2c2NHVrNjZXNElPcXpoT3lnbGV5ZGhDRHFzNkRycGJ3ZzdJaVlJT3llaU95V3RPeWFsQ2tuSURvZ0p5Y3BJQ3NnSnlEaWdKUWc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeWVrT3VQbVNEc2w3RHFzckRya0tucmk0anJpNlF1SnlrN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnYlc5a1pUb2djM2RwZEdObw0KVFc5a1pTQS9JQ2RpY205M2MyVnlMWE4zYVhSamFDY2dPaUFuWW5KdmQzTmxjaWNnZlNrN0RRb2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3MEtJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1EQXNJSHNnWlhKeWIzSTZJQ2Zyb1p6cXQ3anNuYmdnN0xDOTdKMkVJT3VxdXlEc2w3VHNsNGpzbHJUc21wUTZJQ2NnS3lCbExtMWxjM05oWjJVZ2ZTazdEUW9nSUNBZ2ZRMEtJQ0I5RFFvZ0lDOHZJQ2p0aExEcnI3anJoSkFnN1krMDY3Q3hJT3Exck8yWWhPdTJnQ0RpZ0pRZzY3aU02NTI4N0pxdzdLQ0FJT3lla091UG1TRHNtWVRybzR6cXNJQWc3SldJSU91UW1PdUtsQ0R0bVpqcXNyMGc3S0NFN0pxcEtRMEtJQ0JtZFc1amRHbHZiaUJ2Y0dWdVRHOW5hVzVVWlhKdGFXNWhiQ2dwSUhzTkNpQWdJQ0I3RFFvZ0lDQWdJQ0JwWmlBb2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBOVBUMGdKM2RwYmpNeUp5a2dldzBLSUNBZ0lDQWdJQ0F2THlCemRHRnlkT3F3Z0NEc2c0Z2c3TDJZN0lhVUlPeXd2ZXlkaENEcnA0enINCms2RHJpNlFnS091THBPdW1yT3lkbUNEc2lLanNuWUFnN0wyWTdJYVU2ck84SU91c3RPcTBnTzJWbU9xeWpDRHNncXpzbXFuc25wRHNsNURxc293ZzY3TzA3SjZFS1M0TkNpQWdJQ0FnSUNBZ0x5OGc3SjIwN0phMDdJU2NJRkJ2ZDJWeVUyaGxiR3dvTG5Cek1TbnNuYlFnTmV5MGlDRHJrcVFnNnJlNElPeXd2ZXlYa0NEc2w1VHRoTERycGJ3ZzY3TzA2NEswSURIcnNvZ282cldzNjQrRklPcXpoT3lnbFNuc25ZUWc3SjZRNjQrWklPeUVvTzJEbmUyVm1PcXpvQ3dOQ2lBZ0lDQWdJQ0FnTHk4ZzdMQzk3SjJFSU95MW5PeUdqTzJabE8yVnRDRHNncXpzbXFuc25wQWc2NGlJN0plVUlPdTRqT3Vkdk95YXNPeWdnQ0Ryb1p6cXQ3anNuYmpycDR3ZzY0S282cktNSU8yVm5PdUxwQzRnN0xDOTdKMkVJT3VxdXlEc3NMN3NuTHpycWJRZzdKV0U2NnkwNnJLRDY0K0VJT3lWaUNEdGxaenJpNlFOQ2lBZ0lDQWdJQ0FnTHk4Z0tPdUxwT3VsdUNEc3NMMGc3SmlrN0o2RjY2Q2xJT3V3cWV5bmdDRGlnSlFnNnJlNElPcXl2ZXlhDQpzQ0RycVpUcmliVHFzSUFnNjdPMDdKMjA2NHFVSU95eGhPdWhuQ0RyZ3FqcXM2QWc3SUtzN0pxcDdKNlE2ckNBSU95WGxPMkVzQ0R0bFp3ZzY3S0lJT3VJaE91bHRPdXB0Q0Rya0tncExnMEtJQ0FnSUNBZ0lDQXZMeURzbzd6c25aZzZJR05zWVhWa1plcXdnQ0Rzdlpqc2hwUWc3S0NjNjZxcDdKMkVJT3V3bE9xK3VPdXB0Q0JCY0hCQlkzUnBkbUYwWlM5R2FXNWtWMmx1Wkc5MzZyQ0FJT3VxdXlEc3NMN3NuWVFnN0lpWUlPeWVpT3lkakNEaWdKUWc3SnlJNjQrRTdKcXdJT3lMcE9xNHNPeVhrT3lFbkNEdG1aWHNuYmdnN1pXRTdKcVVMZzBLSUNBZ0lDQWdJQ0JqYjI1emRDQndjekVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExXeHZaMmx1TG5Cek1TY3BPdzBLSUNBZ0lDQWdJQ0JtY3k1M2NtbDBaVVpwYkdWVGVXNWpLSEJ6TVN3Z1d3MEtJQ0FnSUNBZ0lDQWdJQ2RUZEdGeWRDMVRiR1ZsY0NBdFUyVmpiMjVrY3lBMUp5d05DaUFnSUNBZ0lDQWdJQ0FuSkhkeg0KSUQwZ1RtVjNMVTlpYW1WamRDQXRRMjl0VDJKcVpXTjBJRmRUWTNKcGNIUXVVMmhsYkd3bkxBMEtJQ0FnSUNBZ0lDQWdJQ0pwWmlBb0pIZHpMa0Z3Y0VGamRHbDJZWFJsS0NkamJHRjFaR1V0Ykc5bmFXNG5LU2tnZXlJc0RRb2dJQ0FnSUNBZ0lDQWdJaUFnSkhkekxsTmxibVJMWlhsektDZCtKeWtpTEEwS0lDQWdJQ0FnSUNBZ0lDY2dJRk4wWVhKMExWTnNaV1Z3SUMxVFpXTnZibVJ6SURJbkxBMEtJQ0FnSUNBZ0lDQWdJQ0lnSUVGa1pDMVVlWEJsSUMxT1lXMWxjM0JoWTJVZ1ZTQXRUbUZ0WlNCWElDMU5aVzFpWlhKRVpXWnBibWwwYVc5dUlDZGJSR3hzU1cxd2IzSjBLRndpZFhObGNqTXlMbVJzYkZ3aUtWMGdjSFZpYkdsaklITjBZWFJwWXlCbGVIUmxjbTRnVTNsemRHVnRMa2x1ZEZCMGNpQkdhVzVrVjJsdVpHOTNLSE4wY21sdVp5QmpMQ0J6ZEhKcGJtY2dkQ2s3SUZ0RWJHeEpiWEJ2Y25Rb1hDSjFjMlZ5TXpJdVpHeHNYQ0lwWFNCd2RXSnNhV01nYzNSaGRHbGpJR1Y0ZEdWeWJpQmliMjlzSUZOb2IzZFgNCmFXNWtiM2NvVTNsemRHVnRMa2x1ZEZCMGNpQm9MQ0JwYm5RZ2JpazdKeUlzRFFvZ0lDQWdJQ0FnSUNBZ0lpQWdKR2dnUFNCYlZTNVhYVG82Um1sdVpGZHBibVJ2ZHloYlRuVnNiRk4wY21sdVoxMDZPbFpoYkhWbExDQW5ZMnhoZFdSbExXeHZaMmx1SnlraUxBMEtJQ0FnSUNBZ0lDQWdJQ2NnSUdsbUlDZ2thQ0F0Ym1VZ1cxTjVjM1JsYlM1SmJuUlFkSEpkT2pwYVpYSnZLU0I3SUZ0MmIybGtYVnRWTGxkZE9qcFRhRzkzVjJsdVpHOTNLQ1JvTENBMktTQjlKeXdnTHk4Z05pQTlJRk5YWDAxSlRrbE5TVnBGRFFvZ0lDQWdJQ0FnSUNBZ0ozMG5MQTBLSUNBZ0lDQWdJQ0JkTG1wdmFXNG9KMXh5WEc0bktTQXJJQ2RjY2x4dUp5azdEUW9nSUNBZ0lDQWdJR052Ym5OMElHSmhkQ0E5SUhCaGRHZ3VhbTlwYmlodmN5NTBiWEJrYVhJb0tTd2dKMk5zWVhWa1pTMWljbWxrWjJVdGJHOW5hVzR1WW1GMEp5azdEUW9nSUNBZ0lDQWdJR1p6TG5keWFYUmxSbWxzWlZONWJtTW9ZbUYwTENBblFHVmphRzhnYjJabVhISmNiaWNnDQpLdzBLSUNBZ0lDQWdJQ0FnSUNkemRHRnlkQ0FpWTJ4aGRXUmxMV3h2WjJsdUlpQmpiV1FnTDJzZ1kyeGhkV1JsSUM5c2IyZHBibHh5WEc0bklDc05DaUFnSUNBZ0lDQWdJQ0FuY0c5M1pYSnphR1ZzYkNBdFRtOVFjbTltYVd4bElDMUZlR1ZqZFhScGIyNVFiMnhwWTNrZ1FubHdZWE56SUMxR2FXeGxJQ0luSUNzZ2NITXhJQ3NnSnlKY2NseHVKeWs3RFFvZ0lDQWdJQ0FnSUhOd1lYZHVLQ2RqYldRbkxDQmJKeTlqSnl3Z1ltRjBYU3dnZXlCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VnZlNrN0RRb2dJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2RrWVhKM2FXNG5LU0I3RFFvZ0lDQWdJQ0FnSUM4dklIQjBlU2hsZUhCbFkzUXA2NkdjSU91enRPdUN1Q0R0Z3FUc2w1QWc3WUcwNjZHYzY1T2NJRlJWU2Vxd2dDRHJyTFRyc0pqc25aSHNuYmdnNnJLRDdKMjBJT3lMcE95NG9TRHRtWlhzbmJqcg0Ka0tnb01qQXlOaTB3Tnl3ZzdKMjg2N0NZSUZ4eXdyZHJhWFIwZVNEc3ZaVHJrNXdnNjZxbzY1R1FLU0RpZ0pRTkNpQWdJQ0FnSUNBZ0x5OGc3SnlnN0oyODdaV2NJT3lla091UG1lMlpsQ0Rxc3Izcm9aenJpcFFnVTNsemRHVnRJRVYyWlc1MGMreWRtQ0RzcDRUc3A1d2c3WUtrSU95ZWhldWdwUzRnN0tDUjZyZTg3SVN4SU9xMmpPMlZuT3lkdENEc25vanNuTHpycWJRZ051eTBpQ0Rya3FRZzdKZVU3WVN3NnJDQUlPeWVrT3VQbVNEc25vWHJvS1hyajd3TkNpQWdJQ0FnSUNBZ0x5OGdNZXV5aUNqcXRhenJqNFVnNnJPRTdLQ1ZLZXlkdENEc2hLRHRnNTNya0pqcXM2QXNJT3Eyak8yVm5PeWR0Q0RzbDRic25MenJxYlFnYTJWNWMzUnliMnRsSU95a2hPdW5qQ0Rzb2JEc21xbnRub2dnN0l1azdZeW83WlcwSU95Q3JPeWFxZXlla09xd2dDRHNsNVR0aExBZzdaV2NJT3V5aUNEcmlJVHJwYlRycWJRZzY1Q2M2NHVrS0daaGFXd3RjMjltZENrdURRb2dJQ0FnSUNBZ0lDOHZJT3lYbE8yRXNDRHNwNEhzb0lUc2w1QWcNClZHVnliV2x1WVd6c25ZUWc2NHVrN0l1Y0lPeVZudXljdk91aG5DRHFzSURzb0xqc21ZQWc2NHVrNjZXNElPeVZzZXlYa0NEdGdxVHFzSUFnNjVPazdKYTA2ckNBNjRxVUlPcXlnK3lkaENEcnA0bnJpcFRyaTZRdURRb2dJQ0FnSUNBZ0lITndZWGR1S0NkdmMyRnpZM0pwY0hRbkxDQmJEUW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbFJsY20xcGJtRnNJaUIwYnlCa2J5QnpZM0pwY0hRZ0ltTnNZWFZrWlNBdmJHOW5hVzRpSnl3TkNpQWdJQ0FnSUNBZ0lDQW5MV1VuTENBbmRHVnNiQ0JoY0hCc2FXTmhkR2x2YmlBaVZHVnliV2x1WVd3aUlIUnZJR0ZqZEdsMllYUmxKeXdOQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuWkdWc1lYa2dOaWNzRFFvZ0lDQWdJQ0FnSUNBZ0p5MWxKeXdnSjNSbGJHd2dZWEJ3YkdsallYUnBiMjRnSWxSbGNtMXBibUZzSWlCMGJ5QmhZM1JwZG1GMFpTY3NEUW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKMlJsYkdGNUlEQXVNeWNzRFFvZ0lDQWdJQ0FnDQpJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbE41YzNSbGJTQkZkbVZ1ZEhNaUlIUnZJR3RsZVhOMGNtOXJaU0J5WlhSMWNtNG5MQTBLSUNBZ0lDQWdJQ0FnSUM4dklPeVhsTzJFc09xd2dDRHNpNlRzb0p6cm9ad2c2NU9rN0phMDZyQ0VJT3F5dmV5YXNPeVhrT3VuakNEc2w2enF1TEFnNjQrRTY0dXNLT3Eyak8yVm5DRHNsNGJzbkx6cnFiUWc3SnlFN0plUTdJU2NJT3lra2V1THFDa2c0b0NVSU8yRXNPdXZ1T3VFa095ZGhDRHN1WmpzbTR3ZzY3aU02NTI4N0pxdzdLQ0E2NmVNSU91Q3FPcTR0T3VMcEEwS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0F4TGpVbkxBMEtJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnYzJWMElHMXBibWxoZEhWeWFYcGxaQ0J2WmlCbWNtOXVkQ0IzYVc1a2IzY2dkRzhnZEhKMVpTY3NEUW9nSUNBZ0lDQWdJRjBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE93MEtJQ0FnSUNBZw0KZlNCbGJITmxJSHNOQ2lBZ0lDQWdJQ0FnY21WMGRYSnVJR1poYkhObE95QXZMeURzcDREc201QWc3SldJSU8yVm1PdUtsQ0JQVXcwS0lDQWdJQ0FnZlEwS0lDQWdJQ0FnY21WMGRYSnVJSFJ5ZFdVN0RRb2dJQ0FnZlEwS0lDQjlEUW9nSUM4dklPMkJ0T3Vobk91VG5DRHFzNFRzb0pVZzY2R2M2cmU0N0pXRTdKdURJT0tBbENEdGxJenJuNnpxdDdqc25iZ2c3Wm1JN0oyWUlGdnJvWnpxdDdqc2xZVHNtNE5kSU91eWhPMkt2T3lkdENEdG1ManN0cHd1SUdOc1lYVmtaU0JoZFhSb0lHeHZaMjkxZE95Y3ZPdWhuQ0JEVEVrZzY2R2M2cmU0N0oyNDdKMkVJTzJWdE95Z25PMlZuT3VMcEM0TkNpQWdMeThnS095ZHRDQlFRK3lkbUNEc29JRHNucVhya0p3ZzdKNlE2cktwN0thZDY2cUY3SjJFSU95bmdPeWF0T3VMcENEaWdKUWc2NHVrN0l1Y0lPeVRzT3VncE91cHRDRHNucXpyb1p6cXQ3anNuYmdnN1pXRTdKcVVMaWtnNjZHYzZyZTQ3SldFN0p1RElPMmJoT3lYbENEc2hManNoWmpDdCtxemhPeWdsZXk2a095TG5PdWwNCnZDRHNvSlhycHF6dGxaenJpNlF1RFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5amJHRjFaR1V0Ykc5bmIzVjBKeWtnZXcwS0lDQWdJR052Ym5OMElHeHZJRDBnYzNCaGQyNG9KMk5zWVhWa1pTY3NJRnNuWVhWMGFDY3NJQ2RzYjJkdmRYUW5YU3dnZXlCemFHVnNiRG9nZEhKMVpTd2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQjNhVzVrYjNkelNHbGtaVG9nZEhKMVpTQjlLVHNOQ2lBZ0lDQnNaWFFnWlhKeUlEMGdKeWM3RFFvZ0lDQWdiRzh1YzNSa1pYSnlMbTl1S0Nka1lYUmhKeXdnS0dRcElEMCtJSHNnWlhKeUlDczlJR1F1ZEc5VGRISnBibWNvS1RzZ2ZTazdEUW9nSUNBZ2JHOHViMjRvSjJWeWNtOXlKeXdnS0dVcElEMCtJSHNnYW5OdmJpaHlaWE1zSURVd01Dd2dleUJ2YXpvZ1ptRnNjMlVzSUdWeWNtOXlPaUFuNjZHYzZyZTQ3SldFN0p1RElPeUxwTzJXaVNEc2k2VHRqS2c2SUNjZ0t5QmxMbTFsYzNOaFoyVWdmU2s3SUgwcE93MEtJQ0FnDQpJR3h2TG05dUtDZGpiRzl6WlNjc0lDaGpiMlJsS1NBOVBpQjdEUW9nSUNBZ0lDQnJhV3hzVUhKdll5Z242NkdjNnJlNDdKV0U3SnVEN1pXMDdJU2NJT3lhbE95eXJleWRoQ0RzcEpIcmk2anRsb2pzbHJUc21wUXVKeWs3SUM4dklPeWRtT3VQaE95Z2dTRHNvb1hybzR3ZzRvQ1VJT3lla091UG1TRHNucXpzaTV6cmo0VHFzSUFnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtck91cHRDRHNsWWdnNjVDb0RRb2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QWdJQ0FnSUNBZ0x5OGc2NHVrN0oyTUlDOWhZMk52ZFc1MHdyY3ZhR1ZoYkhSbzdKZVE3SVNjSU9xemhPeWdsZXlkaENEc2c0anJvWndvUGV5WGh1eWRqT3ljdk91aG5Da2c3SjI5NnJLTURRb2dJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c095QWdJQ0FnSUNBZ0x5OGc3SU9CN1lPY0lPeWVyTzJNa095Z2xTanJpNlRzbll3ZzdZUzA3SmVRN0lTY0lPdXZ1T3Vobk9xM3VPeWR1Q0Rxc0pEc3A0QXBEUW9nSUNBZ0lDQmpiMjV6YjJ4bA0KTG14dlp5Z25XMkp5YVdSblpWMGc3WUcwNjZHYzY1T2NJT3Vobk9xM3VPeVZoT3liZ3lBb1kyOWtaU0FuSUNzZ1kyOWtaU0FySUNjcEp5azdEUW9nSUNBZ0lDQnBaaUFvY21WekxtaGxZV1JsY25OVFpXNTBLU0J5WlhSMWNtNDdJQzh2SUdWeWNtOXlJTzJWdU91VHBPdWZyT3F3Z0NEc25iVHJyN2dnN0oyUjY0dTE3WmFJN0p5ODY2bTBJT3lra2V1enRTRHJzS25zcDRBTkNpQWdJQ0FnSUdsbUlDaGpiMlJsSUQwOVBTQXdLU0JxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxJSDBwT3cwS0lDQWdJQ0FnWld4elpTQnFjMjl1S0hKbGN5d2dOVEF3TENCN0lHOXJPaUJtWVd4elpTd2daWEp5YjNJNklDaGxjbkl1ZEhKcGJTZ3BMbk5zYVdObEtEQXNJREUxTUNrcElIeDhJQ2duN0tLRjY2T01JT3k5bE91VG5DQW5JQ3NnWTI5a1pTa2dmU2s3RFFvZ0lDQWdmU2s3RFFvZ0lDQWdjbVYwZFhKdU93MEtJQ0I5RFFvZ0lDOHZJT3lla09xNHNDRHNvb1hybzR3ZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNCVFZFOVENClgwSlNTVVJIUlMvdGxaanRpcmpydVlUdGlyanFzSUFnN1ppNDdMYWM3WldjNjR1a0lDanJvWnpzdTZ6c2w1RHNoSnpycDR3ZzdLQ1I2cmU4SU9xd2dPdUtwZTJWbU91TGlDRHNsWWpzb0lRcERRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXphSFYwWkc5M2JpY3BJSHNOQ2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPdzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb29Ycm80d2c3SnFVN0xLdElPdXdtK3lkakNEaWdKUWc2NHVrNjZhczY2VzhJT3VCbGV1TGlPdUxwQzRuS1RzTkNpQWdJQ0J6YUhWMGRHbHVaMFJ2ZDI0Z1BTQjBjblZsT3cwS0lDQWdJR3RwYkd4UWNtOWpLQ2s3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQm9ZWEprUlhocGRDZ3dLU3dnTWpBd0tUc05DaUFnSUNCeVpYUjFjbTQ3RFFvZ0lIME5DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtDQpKaUJ5WlhFdWRYSnNJRDA5UFNBbkwzSmxZMjl0YldWdVpDY3BJSHNOQ2lBZ0lDQmpiMjV6ZENCN0lIUmxlSFFzSUcxdlpHVnNMQ0J5YjJ4bElIMGdQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3cwS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmc3RwVHNzcHpyc0p2c25ZUWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc05DaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzTkNpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdMYVU3TEtjSU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnl3Z2NtOXNaU0EvSUNkYkp5QXJJSEp2YkdVZ0t5QW5YU2NnT2lBbkp5d2diVzlrWld3Z1B5QW5LT3VxcU91Tg0KdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPdzBLSUNBZ0lIUnllU0I3RFFvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUTJ4aGRXUmxLRk4wY21sdVp5aDBaWGgwS1M1MGNtbHRLQ2tzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpWTjFaMmRsYzNScGIyNXpMQ0JtYjNKdFlYUkVaWE5qT2lBblczc2lkR1Y0ZENJNklDTHJyTGpxdGF3aUxDQWljbVZoYzI5dUlqb2dJdXlkdE95Y29DSjlMQ0F1TGk1ZEp5QjlMQ0J5YjJ4bEtUc05DaUFnSUNBZ0lHTnZibk4wSUhOMVoyZGxjM1JwYjI1eklEMGdjaTV3WVhKelpXUWdmSHdnVzEwN0RRb2dJQ0FnSUNCamIyNXpkQ0J6WldNZ1BTQW9LRVJoZEdVdWJtOTNLQ2tnTFNCemRHRnlkR1ZrS1NBdklERXdNREFwTG5SdlJtbDRaV1FvTVNrN0RRb2dJQ0FnSUNCcFppQW9JWE4xWjJkbGMzUnBiMjV6TG14bGJtZDBhQ2tnZXcwS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVQNCm5DRHNuWkhyaTdYc25ZUWc3WlcwN0lTZDdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3cwS0lDQWdJQ0FnZlEwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lWaUNBbklDc2djM1ZuWjJWemRHbHZibk11YkdWdVozUm9JQ3NnSitxd25DQW9KeUFySUhObFl5QXJJQ2R6S1NjcE93MEtJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3RFFvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURNd0tUc05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdEUW9nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCemRXZG5aWE4wYVc5dWN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNOQ2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3DQpEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNOQ2lBZ0lDQjlEUW9nSUgwTkNpQWdMeThnN1pTRTY2Q0k3SjZFNjdPRUlPeTJsT3l5bkNEaWdKUWc3WldjSU8yWmxPdXB0T3lkaENEdGxaanNuSVFnN1pTRTY2Q0k3SjZFS095WWdleVhyU2tnNjR1bzdKeUU2NkdjSU91Q21PdUlvQ0Ryc0p2cXM2QXNJT3lZZ2V5WHJldW5pT3VMcENEcmxMRHJvWndnNjR5QTdKV0k3SjJFSU91Q3VPdUxwQzROQ2lBZ0x5OGc3SmlCN0pldElPeUltT3Vuak8yQnZDRHNtcFRzc3Ezc25ZUWc3S3E4NnJDYzdLZUFJT3lWaXV1S2xDRHFzb1BzbmJRZzdaVzE3SXVzSUNqcmlwRHJvS1RzcDREcXM2QWc3SUtzN0pxcDY1K0o2NCtFSU9xM3VPdW5qTzJCdkNEcmdwanFzSVRyaTZRcA0KTGcwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmNtVmpiMjF0Wlc1a0xXZHliM1Z3Y3ljcElIc05DaUFnSUNCamIyNXpkQ0I3SUdkeWIzVndjeXdnYlc5a1pXd3NJRzF2Y21VZ2ZTQTlJR0YzWVdsMElISmxZV1JDYjJSNUtISmxjU2s3RFFvZ0lDQWdZMjl1YzNRZ2JHbHpkQ0E5SUVGeWNtRjVMbWx6UVhKeVlYa29aM0p2ZFhCektRMEtJQ0FnSUNBZ1B5Qm5jbTkxY0hNTkNpQWdJQ0FnSUNBZ0lDQXViV0Z3S0NobktTQTlQaUFvZXcwS0lDQWdJQ0FnSUNBZ0lDQWdibUZ0WlRvZ1UzUnlhVzVuS0NobklDWW1JR2N1Ym1GdFpTa2dmSHdnSnljcExuUnlhVzBvS1N3TkNpQWdJQ0FnSUNBZ0lDQWdJSFJsZUhSek9pQW9aeUFtSmlCQmNuSmhlUzVwYzBGeWNtRjVLR2N1ZEdWNGRITXBJRDhnWnk1MFpYaDBjeUE2SUZ0ZEtTNXRZWEFvS0hRcElEMCtJRk4wY21sdVp5aDBJSHg4SUNjbktTNTBjbWx0S0NrcExtWnBiSFJsY2loQ2IyOXNaV0Z1S1N3TkNpQWcNCklDQWdJQ0FnSUNBZ0lISnZiR1U2SUNobklDWW1JR2N1Y205c1pTa2dQeUJUZEhKcGJtY29aeTV5YjJ4bEtTQTZJSFZ1WkdWbWFXNWxaQ3dOQ2lBZ0lDQWdJQ0FnSUNCOUtTa05DaUFnSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2huS1NBOVBpQm5MblJsZUhSekxteGxibWQwYUNrTkNpQWdJQ0FnSURvZ1cxMDdEUW9nSUNBZ2FXWWdLR3hwYzNRdWJHVnVaM1JvSUR3Z01pa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmc21JSHNsNjNzbmJRZzY3YUE3S0d4N1pXcDY0dUk2NHVrTGljZ2ZTazdEUW9nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0RRb2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPMlVoT3VnaU95ZWhPdXpoQ0RzdHBUc3Nwd2c3SnFVN0xLdE9pRHNtSUhzbDYwZ0p5QXJJR3hwYzNRdWJHVnVaM1JvSUNzZ0orcXduQ2NnS3lBb2JXOXlaU0EvSUNjZ0tPdU5sQ0Ryc0p2cXVMQXBKeUE2SUNjbktTd2diVzlrWld3Z1B5QW5LT3VxDQpxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPdzBLSUNBZ0lIUnllU0I3RFFvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUjNKdmRYQnpLR3hwYzNRc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVWR5YjNWd2N5d2dabTl5YldGMFJHVnpZem9nSjNzaVozSnZkWEJ6SWpvZ1czc2libUZ0WlNJNklDTHNtSUhzbDYwZzdKMjA2NmFFSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcmpJRHNsWWdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOVhYMWRmU2NnZlN3Z0lTRnRiM0psS1RzTkNpQWdJQ0FnSUdOdmJuTjBJRzkxZENBOUlISXVjR0Z5YzJWa093MEtJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93MEtJQ0FnSUNBZ2FXWWdLQ0Z2ZFhRcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU95ZA0Ka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0RRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WlNFNjZDSTdKNkU2N09FSU95Z25PeVZpQ0FuSUNzZ2IzVjBMbkpsWkhWalpTZ29iaXdnWnlrZ1BUNGdiaUFySUdjdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0xDQXdLU0FySUNmcXNKd2dMeURzbUlIc2w2MGdKeUFySUc5MWRDNXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqSUNzZ0ozTXBKeWs3RFFvZ0lDQWdJQ0J6ZEdGMGN5NXpaWEoyWldRckt6c05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUkJkQ0E5SUc1bGR5QkVZWFJsS0NrdWRHOU1iMk5oYkdWVWFXMWxVM1J5YVc1bktDZHJieTFMVWljcE93MEtJQ0FnSUNBZ2MzUmhkSE11YkdGemRGUmxlSFFnUFNBblcrMlVoT3VnaU95ZWhPdXpoRjBnSnlBcklGTjBjbWx1Wnlnb2JHbHpkRnN3WFNBbUppQnNhWE4wV3pCZExuUmxlSFJ6V3pCZEtTQjhmQ0FuSnlrdWMyeHBZMlVvTUN3Z01qUXANCk93MEtJQ0FnSUNBZ2MzUmhkSE11YkdGemRGTmxZeUE5SUhObFl6c05DaUFnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUdkeWIzVndjem9nYjNWMExDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPdzBLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJVHJvSWpzbm9UcnM0UWc3TGFVN0xLY0lPeUxwTzJNcURvbkxDQmxMbTFsYzNOaFoyVXBPdzBLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNRElzSUdaeWFXVnVaR3g1UlhKeWIzSW9aU3dnSisyQnRPdWhuT3VUbkNEdG1ManN0cHdnN0l1azdZeW9PaUFuS1NrN0RRb2dJQ0FnZlEwS0lDQjlEUW9nSUM4dklPMk1uZXlYaFNEc21wVHNob3pyczRRZzdMYVU3TEtjSU9LQWxDRHRsWndnN1l5ZDdKZUY3SjJZSU9xMXJPeUVzZXlhbE95R2pDanNsNjN0bGFBcjY2eTQ2cldzS2V1bHZDRHRsWndnNjdLSTdKZVFJT3V3bSt5VmhDRHNsNjN0bGFEcnM0VHJvWndnDQo2NHVrNjVPczY0cVU2NHVrTGcwS0lDQXZMeURzbXBUc2hvenJwYndnN1pXbzZydVlJT3V6dE91Q3RPeVZ2Q0R0ZzREc25iVHRpNERzbmJRZzY3TzQ2Nnk0SU91bnBldWR2ZXlkaENEc3NManNvYkR0bGFBZzdJaVlJT3llaU91THBDanNtcFRzaG96cnM0UWc2ckNjNjdPRUlPeWFsT3l5cmVxenZPeWRtQ0Rzc0tqc25iUXBMZzBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2Y21WamIyMXRaVzVrTFhCdmNIVndKeWtnZXcwS0lDQWdJR052Ym5OMElIc2daV3hsYldWdWRITXNJRzF2WkdWc0xDQnRiM0psSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPdzBLSUNBZ0lHTnZibk4wSUd4cGMzUWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHVnNaVzFsYm5SektTQS9JR1ZzWlcxbGJuUnpMbVpwYkhSbGNpZ29aU2tnUFQ0Z1pTQW1KaUJUZEhKcGJtY29aUzUwWlhoMElIeDhJQ2NuS1M1MGNtbHRLQ2twSURvZ1cxMDdEUW9nSUNBZ2FXWWdLR3hwYzNRdQ0KYkdWdVozUm9JRHdnTWlrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2Z0akozc2w0VWc3SnFVN0lhTTZyQ0FJT3UyZ095aHNlMlZxZXVMaU91THBDNG5JSDBwT3cwS0lDQWdJR052Ym5OMElITjBZWEowWldRZ1BTQkVZWFJsTG01dmR5Z3BPdzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0akozc2w0VWc3TGFVN0xLY0lPeWFsT3l5clRvZzdKcVU3SWFNSUNjZ0t5QnNhWE4wTG14bGJtZDBhQ0FySUNmcXNKd25JQ3NnS0cxdmNtVWdQeUFuSUNqcmpaUWc2N0NiNnJpd0tTY2dPaUFuSnlrc0lHMXZaR1ZzSUQ4Z0p5anJxcWpyamJnNklDY2dLeUJ0YjJSbGJDQXJJQ2NwSnlBNklDY25LVHNOQ2lBZ0lDQjBjbmtnZXcwS0lDQWdJQ0FnWTI5dWMzUWdjaUE5SUdGM1lXbDBJR0Z6YTFCdmNIVndLR3hwYzNRc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVkJ2Y0hWd0xDQm1iM0p0WVhSRVpYTmpPaUFuZXlKelpYUnpJam9nVzNzaWNtVmhjMjl1SWpvZ0l1dXcNCnFlMldwU0R0bFp3ZzY2eTQ3SjZsSWl3Z0ltVnNaVzFsYm5Seklqb2dXM3NpY205c1pTSTZJQ0xzbDYzdGxhQWlMQ0FpZEdWNGRDSTZJQ0xyckxqcXRhd2lmU3dnTGk0dVhYMHNJQzR1TGwxOUp5QjlMQ0FoSVcxdmNtVXBPdzBLSUNBZ0lDQWdZMjl1YzNRZ2MyVjBjeUE5SUhJdWNHRnljMlZrT3cwS0lDQWdJQ0FnWTI5dWMzUWdjMlZqSUQwZ0tDaEVZWFJsTG01dmR5Z3BJQzBnYzNSaGNuUmxaQ2tnTHlBeE1EQXdLUzUwYjBacGVHVmtLREVwT3cwS0lDQWdJQ0FnYVdZZ0tDRnpaWFJ6S1NCN0RRb2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdEUW9nSUNBZ0lDQjlEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1l5ZDdKZUZJT3lFdU8yS3VDQW5JQ3NnYzJWMGN5NXNaVzVuZEdnZ0t5QW42ckNjSUNnbklDc2djMlZqDQpJQ3NnSjNNcEp5azdEUW9nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3cwS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0FuVysyTW5leVhoVjBnSnlBcklGTjBjbWx1Wnlnb2JHbHpkRnN3WFNBbUppQnNhWE4wV3pCZExuUmxlSFFwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0F5TkNrN0RRb2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93MEtJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYzJWMGN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNOQ2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3RFFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZeWQ3SmVGSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93MEtJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdQ0KWkd4NVJYSnliM0lvWlN3Z0orMkJ0T3Vobk91VG5DRHRtTGpzdHB3ZzdJdWs3WXlvT2lBbktTazdEUW9nSUNBZ2ZRMEtJQ0I5RFFvZ0lDOHZJT3VNZ08yWmxPMllsU0RyckxqcXRhd2c3S0NjN0o2UklPS0FsQ0RzZzRIdG1hbnNuWVFnN0lTazY2cUY3WldZNjZtMElPdXN1T3Exck91bHZDRHJwNHpyazZUc2xyVHNwSURyaTZRZ0tPeTJsT3l5bk9xenZDRHFzSm5zbllBZzdJUzQ3SVdZTENEcmpJRHRtWlRyaXBRZzY2ZWtJT3lhbE95eXJleVhrQ0R0aHJYc3A3anJvWndnN0l1azY2YThLUTBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2WTI5dGNHOXpaU2NwSUhzTkNpQWdJQ0JqYjI1emRDQjdJRzFsYzNOaFoyVnpMQ0J0YjJSbGJDQjlJRDBnWVhkaGFYUWdjbVZoWkVKdlpIa29jbVZ4S1RzTkNpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ1FYSnlZWGt1YVhOQmNuSmhlU2h0WlhOellXZGxjeWtnUHlCdFpYTnpZV2RsY3k1bWFXeDBaWElvS0cwcElEMCsNCklHMGdKaVlnVTNSeWFXNW5LRzB1ZEdWNGRDQjhmQ0FuSnlrdWRISnBiU2dwS1NBNklGdGRPdzBLSUNBZ0lHbG1JQ2doYkdsemRDNXNaVzVuZEdncElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05EQXdMQ0I3SUdWeWNtOXlPaUFuNjR5QTdabVVJT3VDdE95YXFleWR0Q0RydVlUc2xyUWc3SjZJN0lxMTY0dUk2NHVrTGljZ2ZTazdEUW9nSUNBZ1kyOXVjM1FnYzNSaGNuUmxaQ0E5SUVSaGRHVXVibTkzS0NrN0RRb2dJQ0FnWTI5dWMzUWdiR0Z6ZEZWelpYSWdQU0JiTGk0dWJHbHpkRjB1Y21WMlpYSnpaU2dwTG1acGJtUW9LRzBwSUQwK0lHMHVjbTlzWlNBaFBUMGdKMkZ6YzJsemRHRnVkQ2NwT3cwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc29KenNucEVnNjR5QTdabVVJT3lhbE95eXJUb25MQ0JUZEhKcGJtY29LR3hoYzNSVmMyVnlJQ1ltSUd4aGMzUlZjMlZ5TG5SbGVIUXBJSHg4SUNjbktTNXpiR2xqWlNnd0xDQTFNQ2t1Y21Wd2JHRmpaU2d2WEc0dlp5d2dKeUFuS1NBcklDZmlnS1lnDQpLT3VNZ08yWmxDQW5JQ3NnYkdsemRDNXNaVzVuZEdnZ0t5QW42ckNjS1NjcE93MEtJQ0FnSUhSeWVTQjdEUW9nSUNBZ0lDQXZMeURyaklEdG1aVHFzSUFnNnJpNDdKYTA3S2VBNjZtMElPeTFuT3EzdkNBeE11cXduT3VuakNBbzdaU0U2NkdzN1pTRTdZcTRJTzJQcmV5anZDRHJzS25zcDRBcERRb2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclEyOXRjRzl6WlNoc2FYTjBMbk5zYVdObEtDMHhNaWtzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpVTnZiWEJ2YzJVc0lHWnZjbTFoZEVSbGMyTTZJQ2Q3SW5KbGNHeDVJam9nSXV1TWdPMlpsQ0RzblpIcmk3VWc3WldjNjVHUUlPdXN1T3llcFNJc0lDSnpkV2RuWlhOMGFXOXVjeUk2SUZ0N0luUmxlSFFpT2lBaTY2eTQ2cldzSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBaWZTd2dMaTR1WFgwbklIMHBPdzBLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY2k1d1lYSnpaV1E3RFFvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBb0tFUmhkR1V1Ym05Mw0KS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdEUW9nSUNBZ0lDQnBaaUFvSVc5MWRDa2dldzBLSUNBZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z2V5Qmxjbkp2Y2pvZ0orMkJ0T3Vobk91VG5DRHNuWkhyaTdYc25ZUWc3WlcwN0lTZDdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3cwS0lDQWdJQ0FnZlEwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeWduT3lla1NEc25aSHJpN1VnS0NjZ0t5QnpaV01nS3lBbmN5d2c3S0NjN0pXSUlDY2dLeUJ2ZFhRdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lDc2dKK3F3bkNrbktUc05DaUFnSUNBZ0lITjBZWFJ6TG5ObGNuWmxaQ3NyT3cwS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEVGMElEMGdibVYzSUVSaGRHVW9LUzUwYjB4dlkyRnNaVlJwYldWVGRISnBibWNvSjJ0dkxVdFNKeWs3RFFvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wVkdWNGRDQTlJRk4wY21sdVp5Z29iR0Z6ZEZWelpYSWcNCkppWWdiR0Z6ZEZWelpYSXVkR1Y0ZENrZ2ZId2dKeWNwTG5Oc2FXTmxLREFzSURNd0tUc05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdEUW9nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCeVpYQnNlVG9nYjNWMExuSmxjR3g1TENCemRXZG5aWE4wYVc5dWN6b2diM1YwTG5OMVoyZGxjM1JwYjI1ekxDQmxibWRwYm1VNklDZGpiR0YxWkdVbklIMHBPdzBLSUNBZ0lIMGdZMkYwWTJnZ0tHVXBJSHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc29KenNucEVnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNOQ2lBZ0lDQjlEUW9nSUgwTkNpQWdMeThnNjdLSTdKZXRJT0tBbENEdGxaenF0YTNzbHJRZzRvYVVJT3lZZ2V5V3RDRHNucERyajVrZ0tPeTJsT3l5DQpuT3F6dkNEcXNKbnNuWUFnN0lTNDdJV1lJT3lDck95YXFTa05DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM1J5WVc1emJHRjBaU2NwSUhzTkNpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPdzBLSUNBZ0lHbG1JQ2doZEdWNGRDQjhmQ0FoVTNSeWFXNW5LSFJsZUhRcExuUnlhVzBvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2Zyc29qc2w2M3RsYUFnNjZ5NDZyV3M2ckNBSU91NWhPeVd0Q0Rzbm9qc2lyWHJpNGpyaTZRdUp5QjlLVHNOQ2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc05DaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N0tJN0pldElPeWFsT3l5clRvbkxDQlRkSEpwYm1jb2RHVjRkQ2t1YzJ4cFkyVW9NQ3dnTlRBcExuSmxjR3hoWTJVb0wxeHVMMmNzSUNjZ0p5a2dLeUFuNG9DbQ0KSnlrN0RRb2dJQ0FnZEhKNUlIc05DaUFnSUNBZ0lHTnZibk4wSUhJZ1BTQmhkMkZwZENCaGMydFVjbUZ1YzJ4aGRHVW9VM1J5YVc1bktIUmxlSFFwTG5SeWFXMG9LU3dnYlc5a1pXd3NJSHNnY0dGeWMyVTZJSEJoY25ObFZISmhibk5zWVhSbExDQm1iM0p0WVhSRVpYTmpPaUFuZXlKMGNtRnVjMnhoZEdWa0lqb2dJdXV5aU95WHJldXN1Q0FvN0tTRTY3Q1U2citJN0oyQUlGeGNiaWtpTENBaVpHbHlaV04wYVc5dUlqb2dJbXR2NG9hU1pXNGc2NWlRNjRxVUlHVnU0b2FTYTI4aWZTY2dmU2s3RFFvZ0lDQWdJQ0JqYjI1emRDQnZkWFFnUFNCeUxuQmhjbk5sWkRzTkNpQWdJQ0FnSUdOdmJuTjBJSE5sWXlBOUlDZ29SR0YwWlM1dWIzY29LU0F0SUhOMFlYSjBaV1FwSUM4Z01UQXdNQ2t1ZEc5R2FYaGxaQ2d4S1RzTkNpQWdJQ0FnSUdsbUlDZ2hiM1YwS1NCN0RRb2dJQ0FnSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzblpIcmk3WHMNCm5ZUWc3WlcwN0lTZDdaV1k3S2VBSU91cXUrMldpT3lXdE95YWxDNG5JSDBwT3cwS0lDQWdJQ0FnZlEwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdXlpT3lYclNEc21ZVHJvNHdnS0NjZ0t5QnpaV01nS3lBbmN5d2dKeUFySUNodmRYUXVaR2x5WldOMGFXOXVJSHg4SUNjL0p5a2dLeUFuS1NjcE93MEtJQ0FnSUNBZ2MzUmhkSE11YzJWeWRtVmtLeXM3RFFvZ0lDQWdJQ0J6ZEdGMGN5NXNZWE4wUVhRZ1BTQnVaWGNnUkdGMFpTZ3BMblJ2VEc5allXeGxWR2x0WlZOMGNtbHVaeWduYTI4dFMxSW5LVHNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JVWlhoMElEMGdVM1J5YVc1bktIUmxlSFFwTG5Oc2FXTmxLREFzSURNd0tUc05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlRaV01nUFNCelpXTTdEUW9nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCMGNtRnVjMnhoZEdWa09pQnZkWFF1ZEhKaGJuTnNZWFJsWkN3Z1pHbHlaV04wYVc5dU9pQnZkWFF1WkdseVpXTjBhVzl1DQpMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3cwS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdEUW9nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzaTZUdGpLZzZJQ2NwS1RzTkNpQWdJQ0I5RFFvZ0lIME5DaUFnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURRc0lIc2daWEp5YjNJNklDZE9iM1FnWm05MWJtUW5JSDBwT3cwS2ZTazdEUW9OQ2k4dklPeWR0T3V2dUNEcmk2VHJwcXpxc0lBZzY1YWdJT3llaU91S2xPdU5zQ0RybUpBZzdMeWM2cml3NnJDQUlPdVRwT3lXdE95WXBPdXB0Q2pzb0p6c2lxVHNzcGdnN0o2UTY0K1pJT3k4bk9xNHNDRHNwSkhyczdVZzY1T3hLU0Rzb2JEc21xbnRub2dnN0tLRjY2T01JT0tBbENEcmo0enJqWmdnNjR1azY2YXM2NHFVSU9xMw0KdU91TWdPdWhuQ0RzbktEc3A0QU5Dbk5sY25abGNpNXZiaWduWlhKeWIzSW5MQ0FvWlNrZ1BUNGdldzBLSUNCcFppQW9aU0FtSmlCbExtTnZaR1VnUFQwOUlDZEZRVVJFVWtsT1ZWTkZKeWtnZXcwS0lDQWdJQzh2SU91c3ZPcXpvQ0Rzbm9qcmlwUWc3S3E5N0oyMElPeUN0T3lWaENEc25vanJpcFRzcDRBZzdaV2NJT3V5aUNEcnJMenNsclRyczdqcmk2UWc0b0NVSU95ZGtldUx0ZXlkdENEc2w0YnNuTHpycWJRZzdLS0Y2Nk9NSU91UGhPeWtrU0RzbHJ6c2xyVHJ0cG5zbllBZzdLS0E2N21FNjR1a0xnMEtJQ0FnSUM4dklPcTN1Q0RzZ3F6c2k2VHNuWVFnNjZHYzZyZTQ3SmVRSU91Q3FPcXlxT3lWdkNBaTdZK3M3WXE0NjRxVUlPeWVvZTJZZ0NEc25vanJpcFRyamJBZzdaU002NStzNnJlNDdKMjQ3SjJBSU95WHNPdVBtU0RzbFlnZzY1Q29JdXlkaENEcmk2VHNuWXpzbDVBZzY3Q1U2NkdjSU95VmpPeVZoT3V6dU91THBDNE5DaUFnSUNCamIyNXpkQ0J3Y205aVpTQTlJR2gwZEhBdWNtVnhkV1Z6ZENoN0lHaHYNCmMzUTZJQ2N4TWpjdU1DNHdMakVuTENCd2IzSjBPaUJRVDFKVUxDQndZWFJvT2lBbkwyaGxZV3gwYUNjc0lHMWxkR2h2WkRvZ0owZEZWQ2NzSUhScGJXVnZkWFE2SURJd01EQWdmU3dnS0hJcElEMCtJSHNOQ2lBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEc25iVHJyN2dnN0x5YzdLQzRJT3llaU95V3RPeWFsQ2p0ajZ6dGlyZ2dKeUFySUZCUFVsUWdLeUFuSU95Q3JPeWFxU0RzcEpFc0lPeWRrZXVMdFNBbklDc2djaTV6ZEdGMGRYTkRiMlJsSUNzZ0p5a2c0b0NVSU95ZHRDRHNuYmpzaXFUdGhMVHNpcVRyaXBRZzdLS0Y2Nk9NN1pXcDY0dUk2NHVrTGljcE93MEtJQ0FnSUNBZ2FHRnlaRVY0YVhRb01DazdEUW9nSUNBZ2ZTazdEUW9nSUNBZ1kyOXVjM1FnWkdWaFpDQTlJQ2dwSUQwK0lIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0ajZ6dGlyZ2dKeUFySUZCUFVsUWdLeUFuN0oyRUlPeWRrZXVMdFNEc2w0YnJpcFFnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3VzDQp2T3F6b0NEc25vanNsclRzbXBRZzRvQ1VJT3EzdUNEdGxJVHJvWnpzaExqc2lxVHJwYndnNjRHZDY0SzA3Slc4SU8yVnFldUxpT3VMcENqc25wSHNsNFVnNnJTQTY2YXM3SjZRN0plUTdJU2NJRzV2WkdVZzdLS0Y2Nk9NS1M0bktUc05DaUFnSUNBZ0lHaGhjbVJGZUdsMEtEQXBPdzBLSUNBZ0lIMDdEUW9nSUNBZ2NISnZZbVV1YjI0b0oyVnljbTl5Snl3Z1pHVmhaQ2s3RFFvZ0lDQWdjSEp2WW1VdWIyNG9KM1JwYldWdmRYUW5MQ0FvS1NBOVBpQjdJSFJ5ZVNCN0lIQnliMkpsTG1SbGMzUnliM2tvS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3ZlNCa1pXRmtLQ2s3SUgwcE93MEtJQ0FnSUhCeWIySmxMbVZ1WkNncE93MEtJQ0FnSUhKbGRIVnlianNOQ2lBZ2ZRMEtJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdJU2M2N0tFSU95WXBPdWxtRG9uTENCbElDWW1JR1V1YldWemMyRm5aU2s3RFFvZ0lIQnliMk5sYzNNdVpYaHBkQ2d4S1RzTkNuMHBPdzBLTHk4ZzdKYTA2NWFrSU9xeXZldWhuT3VobkNEcw0Kbzczcms2QW83SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTVnQ3dnUTNSeWJDdERMQ0F2YzJoMWRHUnZkMjRzSU95WXBPdWxtQ2tnWTJ4aGRXUmxJT3lla095TG5leWRoQ0RyZ3FqcXVMRHNwNEFnN0pXSzY0cVU2NHVrRFFwd2NtOWpaWE56TG05dUtDZGxlR2wwSnl3Z0tDa2dQVDRnZXlCcmFXeHNVSEp2WXlncE95QnJhV3hzVEc5bmFXNVFjbTlqS0NrN0lIMHBPdzBLY0hKdlkyVnpjeTV2YmlnblUwbEhTVTVVSnl3Z0tDa2dQVDRnYUdGeVpFVjRhWFFvTUNrcE93MEtjSEp2WTJWemN5NXZiaWduVTBsSFZFVlNUU2NzSUNncElEMCtJR2hoY21SRmVHbDBLREFwS1RzTkNnMEtjMlZ5ZG1WeUxteHBjM1JsYmloUVQxSlVMQ0FuTVRJM0xqQXVNQzR4Snl3Z0tDa2dQVDRnZXcwS0lDQmpiMjV6YjJ4bExteHZaeWduNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0ENCjRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBSnlrN0RRb2dJR052Ym5OdmJHVXViRzluS0NjZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEc3ZKenNwNUFnNG9DVUlHaDBkSEE2THk5c2IyTmhiR2h2YzNRNkp5QXJJRkJQVWxRcE93MEtJQ0JqYjI1emIyeGxMbXh2WnlnbklPdXFxT3VOdURvZ0p5QXJJRU5NUVZWRVJWOU5UMFJGVENBcklDY2d3cmNnN0ppSTdJdWNJQ2NnS3lCRldFRk5VRXhGVXk1c1pXNW5kR2dnS3lBbjZyRzBJT3llcGV5d3FTY3BPdzBLSUNCamIyNXpiMnhsTG14dlp5Z25JT3lkdENEc3NMM3NuWVFnN0x5YzY1R1VJT3VQbWV5VmlDRHRsTHpxdDdqcnA0Z2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPMkJ0T3Vobk91VG5PdWhuQ0RzdHBUc3NwenRsYW5yaTRqcmk2UXVKeWs3RFFvZ0lHTnZibk52YkdVdWJHOW5LQ2ZpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpDQpsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFuS1RzTkNpQWdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1RzZ0x5OGdRMnhoZFdSbElFTnZaR1VnN0lLczdKcXBJT3F3Z091S3BTRHNsNnpydG9BZzdLQ1E2cktBSUNqdGxJenJuNnpxdDdqc25iZ2c3SldJNjRLMDdKcXBLUTBLSUNBdkx5RHJyN2pycHF3ZzdJdWM2NCtaSUNzZzdLZUE3SXVjNjZ5NElPeWp2T3llaFNEaWdKUWc3TEtySU95MmxPeXluT3UyZ08yRXNDRHJ1YURycGJUcXNvd05DaUFnWVhOclEyeGhkV1JsS0Nmc200enJzSTNzbDRVNklDTHNvSURzbnFVZzY1Q1k3SmVJN0lxMTY0dUk2NHVrSWljcExuUm9aVzRvRFFvZ0lDQWdLQ2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3liak91d2pleVhoU0RzbVlUcm80d2c0b0NVSU95MmxPeXluQ0RzcElEcg0KdVlRZzY0R2RMaWNwTEEwS0lDQWdJQ2hsS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0p1TTY3Q043SmVGSU95THBPMk1xQ0FvN0xLcklPeWFsT3l5clNEcmxZd2c3SjZzN0l1YzY0K0VLVG9uTENCbExtMWxjM05oWjJVcERRb2dJQ2s3RFFwOUtUc05DaTh2SUVsUWRqWWc2Nk9vN1pTRTY3Q3hLRG82TVNuc2w1RHJqNFFnN1pXbzZydVlJT3VUbyt1S2xPdUxwQ0RpZ0pRZ2JXRmpUMU1nNjVPeDdKZVE3SVNjSUNkc2IyTmhiR2h2YzNRbjZyQ0FJRG82TWV1aG5DRHJxTHpzb0lBZzdaVzA3SVNkNjVDWTY0cVU2NDJ3RFFvdkx5RHRsTHpxdDdqcnA0Z29SV3hsWTNSeWIyNHBJR1psZEdObzY0cVVJR04xY216cXM3d2c2NHVzNjZhc0lFbFFkalRyb1p3ZzdKNlE2NCtaSU8yUHRPdXdzZTJWbU95bmdDRHNsWXJzbFlRc0lFbFFkalRycDR3ZzY1T2o2NDJZSU91THBPdW1yT3lYa0NEc2w3RHFzckRzbmJRZzZyR3c2N2FBNjQrOERRb3ZMeURzdHBUc3NwekN0KzJYck95S3BPeXl0TzJCck9xd2dDRHMNCm9iRHNtcW50bm9nZzdJdWs3WXlvN1phSTY0dWtLT3lMcE95NG9TQXlNREkyTFRBM0tTNGc2ckNaN0oyQUlPeWFsT3l5clNEdGxianJrNlRybjZ6cnBid2dTVkIyTmlEcm82anRsSVRyc0xIc2w1RHJqNFFnN0phNTY0cVU2NHVrTGcwS1kyOXVjM1FnYzJWeWRtVnlOaUE5SUdoMGRIQXVZM0psWVhSbFUyVnlkbVZ5S0hObGNuWmxjaTVzYVhOMFpXNWxjbk1vSjNKbGNYVmxjM1FuS1Zzd1hTazdEUXB6WlhKMlpYSTJMbTl1S0NkbGNuSnZjaWNzSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZ1NWQjJOaWc2T2pFcElPdW1yT3lLcUNEc2c1M3JuclVnNG9DVUlFbFFkalRycDR3ZzdJS3M3SnFwT2ljc0lHVWdKaVlnWlM1dFpYTnpZV2RsS1NrN0RRcHpaWEoyWlhJMkxteHBjM1JsYmloUVQxSlVMQ0FuT2pveEp5azdEUW89DQo6OkVYQU1QTEVTOjoNCkl5RHJyTGpxdGF3ZzdMYVU3TEtjSU95WWlPeUxuQW9LSXV1c3VPcTFyQ0RzdHBUc3NwenJzSnZxdUxBaTZyQ0FJT3lDck95YXFlMlZtT3VLbENEc21JanNpNXdnNjZxbzdKMk03SjZGNjR1STY0dWtMaUFxS3V5ZHRDRHRqSXpzbmJ6c25ZUWc3SWlZN0tDVjdaV2NJT3VTcENEdGhMRHJyN2pyaEpEc2w1RHNoSndnWUc1d2JTQnlkVzRnWW5WcGJHUmc2Nlc4SU95THBPMldpZTJWbU9xem9Dd2dSbWxuYldIc2w1RHNoSndnN1pTTTY1K3M2cmU0N0oyNDdKMkVJT3VMcE95TG5DRHNpNlR0bG9udGxaanJxYlFnNjdDWTdKaUI2NUNwNjR1STY0dWtMaW9xQ2dvakl5RHNucEhzaExFZzY3Q3A2N0tWQ2dvdElPeVlpT3lMbkNEdGxaanJncGpyaXBRZ0tpcGdJeU1qSU95YmtPdXp1R0FxS2lEdGxad2c3S1NFNnJPOExDRHF0N2dnN0pXRTY1NllJQ29xWUMwZzdMYVU3TEtjN0pXSVlDb3FJT3lYck91ZnJDRHFzSnpyb1p3ZzdKMjA2NlNFN0tlUjY0dUk2NHVrTGdvdElPeTJsT3l5bk95VmlDRHNsWWpzbDVEc2hKd2dLaXJzDQpwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydA0KbGFucmk0anJpNlFnNG9DVUlPeWR0T3VtaE1LMzdJaVk2NStKd3JmcnNvanRtTGpycDR3ZzY0dWs2Nlc0SU91c3VPcTFyT3VQaENEcXNKbnNuWUFnN0ppSTdJdWM2NkdjSU95ZW9lMllnT3lhbEM0ZzY0dW9MQ0RzdHBUc3NwenNsWWpzbDVBZzdLQ0I3SmEwNjVHVUlPeWR0T3VtaE1LMzdJaXI3SjZRNjRxVUlPcTN1T3VNZ091aG5DRHJncGpzbUtUcmk0Z2c3SXVrN0tDY0lPcXdrdXlYa0NEcnA1N3Fzb3dnNnJPZzdMT1FJT3lUc095RXVPeWFsQzRLTFNEc29KenJxcWtvWUNNallDbnFzN3dnWUNNakkyQXNJR0F0WUNEcXVMRHRtTGpyaXBRZzdaaVY3SXVkN0oyMDY0dUlJT3V3bE9xK3VPeW5nQ0RycDRqc2hManNtcFF1Q2dvakl5RHNpcVR0ZzREc25id2c3SnVRN0xtWklDanNzTGpxczZBZzRvQ1VJT3lla095RXVPMlZuQ0RyZ3JUc21xbnNuWUFnZFhndGQzSnBkR2x1Wnk1dFpDRHFzSURzbmJUcms1d3BDZ290SU8yVnRPeWFsT3l5dEN3ZzY3YUE2NU9jNjUrczdKcTBJT3lpaGVxeXNDaGdmdXllaU95V3RPeWENCmxHQWdZSDdyajd6c21wUmdJR0IrN0plRzdKYTA3SnFVWUNCZ2Z1MlZ0Q0Rzbzd6c2hManNtcFJnS1FvdElETHJpNmdnNnJXczdLR3dPaUFxS3V5eXF5RHNwSVE5N0lPQjdabXBJT3lFcE91cWhTRGlocElnNjVHWTdLZTRJT3lraEQzcmk2VHNuWXdnN1phSjY0K1pLaW9vNnJLdzdLQ1Y3SjJBSUdCKzdaV2c2cm1NN0pxVVAyQXNJTzJXaWV1UG1TRHNuS0RyajRUcmlwUWdZSDd0bGJRZzdLTzg3SVM0N0pxVVlDa0tMU0RyaXFYcmo1bnNvSUVnNjZlUTdaV1k2cml3S091UWtPeVd0T3lhbE9LR2t1MldpT3lXdE95YWxDa3NJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFvN0plRzdKYTA3SnFVNG9hU2Z1MlZtT3VwdENEdGxhQWc3SWlZSU95ZWlPeVd0T3lhbENrS0xTRHN1cERzbzd6c2xyenRsWndnNnJLOTdKYTBLSDdzaTV6cXNxRHNsclRzbXBRLzRvYVNmdTJWb09xNWpPeWFsRDhwTENEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0Nqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVDQo3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TA0Kbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzdDZqc2hvenRsYUFnNnJLOTdKcXdJT3lhbE95eXJTRHJnclRzbDYzcmo0UWc3SUt0N0tDYzY0Kzg3SnFVTGlBdklPcXp0ZXljb0NEc21wVHNzcTNzbllRZzdMZW83SWFNN1pXZzZybU03SnFVUHdvS0l5TWpJT3E0c09xNHNPdWx2Q0Rzc0w3c3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpQlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaV1k3SVM0N0pxVUxnb3RJT3E0c09xNHNPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5QlJVdXk5bE91VG5PdWx2Q0RyaTZUc2k1d2c3SXFrN0xxVTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WldZNnJpd0lPeWdoT3lYa091S2xDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEFvdElPdXp0TzJZdU95ZWtPcXdnQ0R0bDRqcm5iM3RsYlRzbGJ3ZzZyQ0E3SjZGN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3S2VBNnJpSUlPdXkNCmhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaVzBJT3lqdk95RXVPeWFsQzRnTHlEc2c1M3NzclFnN0oyNDdLYWQ3SjJFSU95VHNPdWdwT3VwdENEc3RaenNpNkFnNjdLRTdLQ0U3SjIwSU8yVmhPeWFsTzJWdE95YWxDNEtDaU1qSXlEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhLTFNEcmpJRHN0cHdnNjZxcDdLQ0I3SjIwSU91c3RPeVhoK3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOEtMU0RzaTZEcXM2QWc3SjIwN0p5ZzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SjZVDQo3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3Zw0KN0lLdDdLQ2NJT3lWak91bXZPMkdvZXlkaENEdG1ZMHE2NCtaS0RBeE1DMHhNak0wTFRVMk56Z3BJT3VMbUNEc21iZ2dNdXVxaGV5WGtPcXlqQ0RyczdUcmdyenF1WXpzbXBRL0Nnb2pJeU1qSU8yWmxleWR1TUszNnJLdzdLQ1ZJTzJNbmV5WGhRb0tJeU1qSU95Z2xldW5rQ0RzZ3Ezc29KenRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9JT3lDcmV5Z25PdVFuQ0RyamJEc25iVHRoTERyaXBRZzY3TzE2cldzN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0Rya0pqcmo0enJwclFnN0lpWUlPeVhodXlXdE95YWxDNGdMeURzb0pYcnA1QWc3SUt0N0tDYzdaV2c2cm1NN0pxVVB3b0tJeU1qSU91emdPcXl2ZXlDck8yVnJleWR0Q0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SldZN0lxMTY0dUk2NHVrTGlEcmdwanFzSURzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0pXRTdLZUJJT3lnZ095ZXBlMlZtT3luZ0NEc2xZcnNuWUFnNjRLMDdKcXA3SjIwSU95ZWlPeVcNCnRPeWFsQzRnTHlEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhLQ2lNakl5RHJvWnpxdDdqc2xZVHNtNE1nN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPdWhuT3EzdU95VmhPeWJnKzJWb09xNWpPeWFsRDhLQ2lNakl5RHNsYkhzbllRZzdLS0Y2Nk9NN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPeVZzZXlkaENEc29vWHJvNHp0bGFEcXVZenNtcFEvQ2dvakl5TWc3WldjSU91eWlDRHJzNERxc3IzdGxaanJxYlFnNjR1azdJdWNJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKZUc3SXExNjR1STY0dWtMaURxczRUc2hvM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnNjR1azdJdWNJT3V3bE9xL2dDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPcXpoT3lHamUyVm9PcTVqT3lhbEQ4S0NpTWpJeURzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJrS25yaTRqcmk2UXVJT3kwaU9xNHNPMlpsTzJWDQptT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIcw0KbmJnZzdKaWs2NldZNnJDQUlPeURuZXF5dk95V3RPeWFsQzRnTHlEc25xRHNpNXdnN1p1RUlPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95VmhPeWR0T3VVbENEcm1KRHJpcFFnNjdtRTY3Q0E2N0tJN1ppNDZyQ0FJT3lkdk95NW1PMlZtT3luZ0NEc2xZcnNpclhyaTRqcmk2UXVDaTBnN0pXRTdKMjA2NVNVSU91WWtPdUtsQ0RydVlUcnNJRHJzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAzcnNvanRtTGpxc0lBZzdKMjg3TG1ZN1pXWTdLZUFJT3lWaXV5S3RldUxpT3VMcEM0S0xTRHNuYmpzcHAzcnNvanRtTGpxc0lBZzY2ZWU3S2VBSU95Vml1eVZoT3lhbEM0Z0x5RHJpNlRzaTV3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25ianNwcDBnN0l1YzZyQ0U3SjIwSU95MGlPcXp2T3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjI0N0thZDY3S0kNCjdaaTQ2Nlc4SU95ZXJPdXduT3lHb2UyVm1PeUxyZXlMbk95WXBDNEtMU0RzbmJqc3BwMGc3SXVjNnJDRTdKMjBJT3luZ091Q3JPeVd0T3lhbEM0Z0x5RHNuYmpzcHAzcnNvanRtTGpycGJ3ZzY0dWs3SXVjSU91d20reVZoQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cktBN0lPSklPcXlzT3F6dk9xd2dDRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNsclRzbXBRdUlDOGc2NHVrNjZXNElPcXlnT3lEaWV5V3RPdWhuQ0RyaTZUc2k1d2c3TEMrN0pXRTY3TzA3SVM0N0pxVUxnb0tJeU1qSU95Z2xldXp0T3VsdkNEcnRvanJuNnpzbUtUc3A0QWc2NnE3N1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc29KWHJzN1RycGJ3ZzY3YUk2NStzN0ppc0lPeUltQ0RzbDRic2xyVHNtcFF1SUM4ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEdGpJenNuYndnDQo3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvag0KSXlNZzdMbTA2Nm1VNjUyOElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SXExNjR1STY0dWtMaURzaEtUc29KWHNsNURzaEp3ZzZyYU03WldjN0oyRUlPMlhpT3lhcWUyVm1PeUxyZXlMbk95WXBDNEtMU0RzdWJUcnFaVHJuYndnNnJhTTdaV2M3SjIwSU8yVmhPeWFsTzJWdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdMbTA2Nm1VNjUyOElPeWdrZXEzdk95ZGhDRHRsNGpzbXFudGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEcXRvenRsWnpzbmJRZzZyR3c2N2FBNjVDWTdKYTBJT3lWak91bXZPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0RzbFl6cnByd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3VwdENEc2hvenNpNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVJQzhnN0lTazdLQ1Y3SmVRN0lTY0lPeVZqT3Vtdk95ZGhDRHN2SndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3ljaE95NW1DRHNvSlhyczdRZzdKMjA3SnFwN0plUUlPdVANCm1leWRtTzJWbU95bmdDRHNsWXJzbFlRZzdKMjg2N2FBSU9xNHNPdUtwZXlkdENEc29KenRsWnpya0tucmk0anJpNlF1Q2kwZzdKeUU3TG1ZSU95Z2xldXp0T3VsdkNEdGw0anNtcW50bFpqcnFiUWc2NnFvNjVPZ0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNGdMeURzaEtUc29KWHNsNURzaEp3ZzdKeUU3TG1ZSU95Z2tlcTN2T3lkaENEdGw0anNtcW50bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc21ZVHJvNHpDdCt5bmhPMldpUW9LSXlNaklPeWdnT3llcGV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc29JRHNucVh0bG9qc2xyVHNtcFF1Q2dvakl5TWc2N09BNnJLOTdJS3M3Wld0N0oyMElPeWdnZXlhcWV1UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcnM0RHFzcjBnNjRLMDdKcXA3SjJFSU95Z2dleWFxZTJXaU95V3RPeWFsQzRLQ2lNakl5RHNvSVRzaHFIc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPdXp0T3VEaU95V3RPeWFsQzRLQ2lNakl5RHJrN0hyDQpvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8ySw0KdUNEdG00UWc3SjIwN0pxcElPcXdnT3VLcGUyVnFldUxpT3VMcEM0S0xTRHNnNGdnNjdLRTdLQ0U3SjIwSU91Q21PeVpsT3lXdE95YWxDNGdMeURzbDRYcmpiRHNuYlR0aXJqdGxaanJxYlFnN0lPSUlPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdKMjA3SnFwN0oyRUlPeWNoTzJWdENEc2xiM3F0SUFnNjQrWjdKMlk2ckNBSU8yVmhPeWFsTzJWcWV1TGlPdUxwQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc2k1enNucEh0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNucVhzaTV6cXNJUWc2Nis0N0lLczdKcXA3Snk4NjZHY0lPeWVrT3VQbVNEcm9aenF0N2pzbFlUc200TWc2NUNZN0plSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzY2R2M2cmU0N0oyNDdaV1k3SXV0N0l1YzdKaWtMZ290SU95WXBPdWVxK3VQbWV5VmlDRHNncXpzbXFudGxaanNwNEFnN0pXSzdKV0VJT3Vobk9xM3VPeVYNCmhPeWJnK3VRa095V3RPeWFsQzRnTHlEcmk2VHNpNXdnNjZHYzZyZTQ3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEcnM3VHNsWWpzbllRZzdKeUU3WlcwSU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RyczREcXNyM3RsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0RzbFlqc29JVHRsWndnN0lLczdKcXA3SjJFSU95Y2hPMlZ0Q0RydVlUcnNJRHJzb2p0bUxqcnBid2c2N0NVNnIrVUlPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzY3TzA3SldJSU95RW5PdTVoT3lLcEFvS0l5TWpJT3F5dmV1NWhPdWx2Q0Rxc0p6c2k1enRsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnNnJLOTY3bUU2Nlc4SU95TG5PeWVrZTJWb09xNWpPeWFsRDhLQ2lNakl5RHFzcjNydVlUcnBid2c3WlcwN0tDYzdaV1k3SXVjNnJLZzdJcTE2NHVJNnJtTVB3b3RJT3F5dmV1NWhPdWx2Q0R0bGJUc29KenRsYURxdVl6c21wUS9DZ29qSXlNZzZyaXc2cml3NnJDQUlPeVlwTzJVaE91ZHZPeWR1Q0RzZzRIdGc1enNub1hyDQppNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Qw0KdE95YXFleWRnQ0Rzb0lEc25xWHJrSmpzcDRBZzdKV0s3SXExNjR1STY0dWtMZ290SU95M3FPeUdqTzJWbU91cHRDRHNpNkRzc3EzdGxad2c2NEswN0pxcDdKMjBJT3lnZ095ZXBldVFtT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0NpMGc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxhRHF1WXpzbXBRL0lDOGc3TGVvN0lhTTdaV1k2Nm0wSU95ZWhldWdwZTJWbkNEcmdyVHNtcW5zbmJRZzdJS3M2NTI4N0tDNDdKcVVMZ29LSXlNakl5RHFzSURzbmJUcms1d2c3SmlJN0l1Y0lDaDFlQzEzY21sMGFXNW5MbTFrN0plUTdJU2NJT3lZcnVxNWdDRGlnSlFnNnJlYzdMbVo3Snk4NjZHY0lPeWVrT3VQbWUyWmxDRHJxcnNnN1pXWTY0cVVJT3VzdU95ZXBTRHNucXpxdGF6c2hMRWc3SUtzNjZHQUtRb0tJeU1qSU95ZWtPdVBtZXl3cU91bHZDRHFzSURzcDREcXM2QWc2ck9FN0l1YzY0S1k3SnFVUHdvdElPeWVrT3VQbWV5d3FPcXcNCmdDRHNub2pyZ3Bqc21wUS9DZ29qSXlNZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91bHZDRHNscnpycDRqc2xLa2c2NEswNnJPZ0lPcXpoT3lMbk91Q21PeWFsRDhLTFNEcnA2VHJpNndnNjdPMDdaZVk2Nk9NNjRxVUlPeVd2T3VuaU95ZHVPcXdnT3lhbEQ4S0NpTWpJeURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9jZzZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVDaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSElPcXdnT3luZ0NEcmk2VHNpNXdnN1ptVjdKMjQ3WldnNnJLTTdKcVVMZ29LSXlNaklPeTV0T3VUbk91bHZDRHRsYlRzcDREdGxaanNpNXpxc3FEc2xyVHNtcFEvQ2kwZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4S0NpTWpJeURzaTV6c25wSHRsWmpzaTV6cmlwUWc2N2FFN0plUTZyS01JRFVzTURBdzdKdVE3SjJFSU91VG5PdWdwT3lhbEM0S0xTRHNpNXpzbnBIdGxaanJxYlFnTlN3d01ERHNtNURzDQpuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRQ0KN0lxa0lPeWR0T3lhcWV5ZHRDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3S0NRNnJLQUlPcTRzT3F3aENEcmo1bnNsWWdnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3lMb091MmhPeW1uU0R0bVpYc25iZ2c3S0NFN0plUTY0cVVJT3lHb2VxNGlDRHJzSThnNnJLdzdLQ2M2ckNBSU91MmlPcXdnTzJWcWV1TGlPdUxwQzRLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGdvS0l5TWpJT3V6Z09xeXZTRHNpNXdnN0xxUTdJdWM2N0N4SU95ZXJPeW5nT3E0aWV5ZGdDRHJ0b2pxc0lEdGxhbnJpNGpyaTZRdUNpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0NpTWpJeURzZzRIcmk3UWc3WktJN0tlSUlPMldwZXlEZ2V5ZGhDRHMNCm5JVHRsYlFnN1lhMTdabVVJT3VDdE95YXFleWR0Q0RyaGJuc25ZenJrS25yaTRqcmk2UXVDaTBnNjQyVUlPeWlpK3lkZ0NEc2c0SHJpN1RzbllRZzdKeUU3WlcwSU8yR3RlMlpsQ0RyZ3JUc21xbnNuWUFnNjRXNTdKMk02NCs4N0pxVUxnb0tJeU1qSU9xem9PcXduZXVMbU95ZG1DRHFzSnpzbmJqc29KWHJzN1FnN0oyMDdKcXBJT3VDdE95WHJleWRnQ0RxdUxEcm9aMGc2clNBNjZhczY1Q3A2NHVJNjR1a0xnb3RJT3lkdE95Z25PdTJnTzJFc0NEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZHRDRHF1TERyb1ozcmo3enNtcFF1Q2dvakl5TWc3TEt0N0lhTTY0V0U3SjJBSU95RW5PdTVoT3lLcENEcXNJRHNub1hzbmJRZzY3YUk2ckNBN1pXcDY0dUk2NHVrTGdvdElPeW5nT3E0aU95ZGdDRHFzSURzbm9YdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNzcTNzaG96cmhZVHNuWVFnN0p5RTdaV2NJT3lFbk91NWhPeUtwT3VLbENEc2xZVHNwNEVnN0tTQTY3bUVJT3lra2V5ZHRPeVhrT3lhDQpsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMA0KSU95anZPeUV1T3lhbEM0S0NpTWpJeURzZ3F6c21xbnRsYUFnN0lpWUlPeVhodXVLbENEcnVZVHJzSURyc29qdG1ManNub1hyaTRqcmk2UXVJT3lZZ2V1c3VDd2c3SWlyN0o2UUxDRHRpcm5zaUpqcnJManNucERycGJ3ZzdZK3M3WldvN1pXWTdKZXNJRGpzbnBBZzdKMjA3SU9CSU95ZWhldWdwZTJWbU95THJleUxuT3lZcEM0S0xTRHNtSUhyckxnc0lPeUlxK3lla0N3ZzdZcTU3SWlZNjZ5NDdKNlE2Nlc4SU8yUHJPMlZxTzJWdENBNDdKNlFJT3lkdE95RGdTRHNub1hyb0tYdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWVoZXVncFNEcXNJRHJpcVh0bFp3ZzZyaUE3SjZRSU95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc3SjZGNjZDbDdaV2dJT3lJbUNEc25vanJpcFFnNnJpQTdKNlFJT3lJbU91bHZDRHJoSmpzbDRqc2xyVHNtcFF1SUM4ZzY0SzA3SnFwN0oyRUlPeWhzT3E0aUNEc3BJVHNsNndnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeUR0akl6c25iekN0K3F5c095Z25NSzMNCjZyaXc3WU9BQ2dvakl5TWc3WXlNN0oyOElPeWFxZXVmaWV5ZHRDRHN0SWpxczd6cmtKanNsNGpzaXJYcmk0anJpNlF1SURFd1RVSWc3SjIwN1pXWTdKMllJTzJNak95ZHZPdW5qQ0RzbDRYcm9aenJrNXdnNnJDQTY0cWw3WldwNjR1STY0dWtMZ290SURFd1RVSWc3SjIwN1pXWUlPMk1qT3lkdk91bmpDRHNtS3pycHJRZzdJaVlJT3llaU95V3RPeWFsQzRnTHlEdGpJenNuYndnN0pxcDY1K0o3SjJFSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUNnb2pJeU1nNjR1azdKcTA2NkdjNjVPYzZyQ0FJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJpNlRzbXJUcm9aenJrNXpycGJ3ZzY2ZUk3TE9rN0phMDdKcVVMZ29LSXlNaklPcXlzT3lnbk95WGtDRHNpNlR0aktqdGxaanNtSURzaXJYcmk0anJpNlF1SU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJdWM2cml3SU91d2xPdWVqZXVMaU91THBDNEtMU0Rxc3JEc29KenRsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaUF2SU9xeXNPeWduQ0RzDQppSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEcw0KaXJYcmk0anJpNlF1Q2kwZzY0MlVJT3VUc2V1aG5lMlZtT3VncE91cHRDRHF1TERzb2JRZzdaV3Q2NnFwN0oyRUlPeUNyZXlnbk8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNaklPdXp0T3lWaUNEc2hKenJ1WVRzaXFRZ0tPeTJsT3F3Z0NrS0NpTWpJeURzdHB6cmo1a2c3SnFVN0xLdDdKMjBJT3lna2V5SW1PdVFtT3lYaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzdMYWM2NCtaSU95YWxPeXlyZXlkaENEc29KSHNpSmp0bG9qc2xyVHNtcFF1SUM4ZzdKNmc3SXVjNjZlTUlPcTRzT3VMcE91Z3BDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZySzk2N21FSU95RGdlMkRuT3VsdkNEdG1aWHNuYmp0bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3F5dmV1NWhDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlDOGcNCjdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc21ianN0cHdnNjZxbzY1T2M2NkdjSU95Z2hPMlptTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc21ianN0cHdnNjZxbzY1T2M2NkdjSU91d2xPcS9nT3E1ak95YWxEOEtDaU1qSXlEcnNLbnJyTGdnN0ppSTdKVzk3SjIwSU95WmhPdWpqT3VRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Ryc0tucnJMZ2c3SmlJN0pXOTdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURydVlUcnNJRHJzb2p0bUxnZ05lMmFqQ0RzbUtUcnBaanJvWndnNnJPRTdLQ1Y3SjIwSU95ZW9PcTRpQ0Rzc3BqcnBxenJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElEWHRtb3dnN0o2WTY2cTdJT3llaGV1Z3BlMlZ0T3lFbkNEcXM0VHNvSlhzbmJRZzdKNmc2cks4N0phMDdKcVVMaUF2SU91NWhPdXdnT3V5aU8yWXVPdWx2Q0RzbnF6c2hLVHNvSlh0bFpqcnFiUWc2NHVrN0l1Y0lPeWR0T3lhDQpxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqcw0KbmJnZzdadUU3SmVRNjZlTUlPeUNyT3lhcVNEcXNJRHJpcVh0bGFucmk0anJpNlF1Q2kwZzY2R2M2cmU0N0oyNDdaV1k2Nm0wSU95L29PMlBzT3lkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURycjdqc2hMSHJoWVRzbnBEcmlwUWc2N08wN1ppNDdKNlFJT3VQbWV5ZG1DRHNsNGJzbmJRZzZyS3c3S0NjN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc2N08wN1ppNDdKNlE2ckNBSU91UG1leWRtTzJWbU91cHRDRHFzckRzb0p6dGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bElUcm9aenRsWVRzbllRZzY1T3g2NkdkN1pXWTdLZUFJT3lWaXV5Y3ZPdXB0Q0RzbmJUc21xbnNuYlFnN0tDYzdaV2M2NUNwNjR1STY0dWtMZ290SU8yVWhPdWhuTzJWaE95ZGhDRHJrN0hyb1ozdGxaanJxYlFnNjZxbzY1T2dJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNsYkVnNjdLRTdLQ0U3SjIwSU91Q3J1eVZoQ0RzbmJ6cnRvQWc2cml3NjRxbDdKMjANCklPeWduTzJWbk91UXFldUxpT3VMcEM0S0xTRHNsYkhzbllRZzdKZUY2NDJ3N0oyMDdZcTQ3WldZNjZtMElPdXFxT3VUb0NEcXVMRHJpcVhzbllRZzdKTzRJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nNjdpVTY2T283WWlzN0lxazZyQ0FJT3E2dk95Z3VDRHNub2pzbHJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xnb3RJT3U0bE91anFPMklyT3lLcE91bHZDRHN2SnpycWJRZzZyaXc2cml3NjZXOElPeVhzT3F5c08yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3U1aE95RGdTRHNsN0RybmIzc3NwanFzSUFnNjVPeDY2R2Q2NUNZN0tlQUlPeVZpdXlWbU95S3RldUxpT3VMcEM0S0xTRHJ1WVRzZzRFZzdKZXc2NTI5N0xLWTY2VzhJT3VUc2V1aG5lMlZtT3VwdENEcXVMVHF1SW50bGFBZzY1V01JT3U1b091bHRPcXlqQ0RzbDdEcm5iM3JrNXpycHJRZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHN0cHpzbm9VZzdMbTA2NU9jNnJDQUlPdVRzZXVoDQpuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMA0KN0pxVUxpQXZJT3lJbk95RW5PdU1nT3VobkNEcmk3WHJzNERyazV6cnByVHFzb3pzbXBRdUNnb2pJeU1nN0lTazdLQ1Y3SjIwSU95MGlPcTRzTzJabE91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEc2hLVHNvSlhzbllRZzdMU0k2cml3N1ptVTdaYUk3SmEwN0pxVUxnb0tJeU1qSU91NWhPdXdnT3V5aU8yWXVPcXdnQ0RyczREcXNyM3JrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2N21FNjdDQTY3S0k3Wmk0NjZXOElPdXdsT3EvcU95V3RPeWFsQzRLQ2lNakl5RHNuYmpzcHAzc25iUWc3Sm1FNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR1T3ltbmV5ZGhDRHJwNGpzczZUc2xyVHNtcFF1Q2dvakl5TWpJT3k2a095anZPeVd2TzJWbkNEcXNyM3NsclFnS095bmlPdXN1Q0RzbnF6cXRhenNoTEVwQ2dvakl5TWc3SmE0N0tDY0lPdXdxZXVzdU8yVm1PeUxuT3F5b095S3RldUxpT3E1akQ4S0xTRHJzS25yckxnZzY0S2c3S2VjNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKYTANCjY1YWtJT3V3cWV1eWxleWN2T3VobkNEc25ianNwcDN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKMjQ3S2FkSU91d3FldXlsZXlkaENEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU9xeXNPeWduTzJWbU95THBDRHN1YlRyazV6cnBid2c3SVNnN1lPZDdaVzBJT3lqdk95THJleUxuT3lZcEM0S0xTRHFzckRzb0p6dGxhQWc3TG0wNjVPYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SnVRN1pXWTdJdWM2NHFVSU95RW5PdTVoT3lLcE91bHZDRHNoS0R0ZzUzdGxaanNoTGpzbXBRdUNpMGc3SnVRN1pXWTY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95anZPeUdqT3VsdkNEc2xZenFzNkFnNnJPRTdJdWc2ckNBN0pxVVB3b3RJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc3SjZJNjRLWTdKcVVQd29LSXlNakl5RHJxb1hzZ3F3cjY2cUY3SUtzSU8yU2dPeVd0T3lUc09xNHNBb0tJeU1qSU9xNHNPcXdoQ0RyDQpwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZw0KNnJhTTdaV2NJT3UyZ095aHNleWN2T3VobkNEc29KSHF0N3pzbmJRZzZyR3c2N2FBNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Z2tlcTN2Q0RxdG96dGxaenNuYlFnN0plRzdKYTA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEcXRvenRsWnpzbllRZzdKcVU3TEt0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlNZzdJT0I3Wm1wSU95VmlPdUN0Q0FvTXV1THFDRHF0YXpzb2JBcENnb2pJeU1nN0o2RjY2Q2w3WldZN0l1Z0lPeWp2T3lHak91bHZDRHNzTDdzbllRZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0ZzY0dWs3SXVjSU8yWmxleWR1Q0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3S084N0lhTTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPdUxwT3lMbkNEdG1aWHNuYmp0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95YWxPeXlyZTJWbU95TG9DRHRqcGpzbmJUc3A0RHJwYndnN0xDKzdKMkVJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN1k2WTdKMjA3S2VBNjZXOElPeXcNCnZ1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lqdk95R2pPdWx2Q0R0bVpYc25ianRsWmpxc2JEcmdwZ2c3Wm1JN0p5ODY2R2NJT3lkdE91UG1lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NCtaN0oyODdaV2NJT3lhbE95eXJleWR0Q0Rzc3BqcnBxd2c3S1NSN0o2RjY0dUk2NHVrTGlEc25xRHNpNXdnN1p1RUlPMlpsZXlkdU8yVnRDRHNvN3pzaTYzc2k1enNtS1F1Q2kwZzZyQ1o3SjJBSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqcXM2QWc3SjZJN0phMDdKcVVMaUF2SU95ZW9PeUxuQ0R0bTRRZzdabVY3SjI0N1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc25iVHJzcVR0aXJqcXNJQWc3S0tGNjZPTTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWR0T3V5cE8yS3VPcXdnQ0RyZ1ozcmdxenNsclRzbXBRdUNnb2pJeU1nN1lPSTdZZTBJT3lMbkNEcnFxanJrNkFnNjQydzdKMjA3WVN3NnJDQUlPeUNyZXlnbk91UW1PdXBzQ0RyczdYcXRhenRsYUFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLDQpMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZw0KN0tPODdJUzQ3SnFVTGdvS0l5TWpJTzJabE95ZXJDRHFzSkRzcDREcXVMQWc2N0N3N1lTdzY2YXM2ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRLTFNEdG1aVHNucXdnNnJDUTdLZUE2cml3SU91d3NPMkVzT3Vtck9xd2dDRHNscnpycDRnZzdKZUc3SmEwN0pxVUxpQXZJT3V3c08yRXNPdW1yT3VsdkNEcXRaRHNzclR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEc3RwWHNsYjBnS3lEcXVJM3NvSlVnN0tDRTdabVlJQ2pya1pBZzY2eTQ3SjZsSU9LR2tpRHF1STNzb0pYdG1KVWc3WldjSU91c3VPeWVwU2tLQ2lNakl5RHJxcWpzbm9Uc3A0RHNtNURxdUlnZzdKZUc3SjIwSU91cXFPeWVoTzJHdGV5ZXBleWRoQ0RycDR6cms2VHF1WXpzbXBRL0lPeW5nT3E0aUNEcnNKdnNwNEFnN0pXSzdKeTg2Nm0wSU91cXFPeWVoT3luZ095YmtPcTRpT3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbGIzcXRJRHNsNUFnNjQrWjdKMlk3WldZNjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHINCnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdG1KenRnNTBnN0plRzdKMjBJT3F3Z095ZWhlMlZvT3E1ak95YWxEOGc3S2VBNnJpSUlPeUxvT3l5cmUyVm1PeW5nQ0RzbFlyc25MenJxYlFnN0p1dzdMdTBJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0S0xTRHNwNERxdUlnZzdJdWc3TEt0N1pXWTY2bTBJT3lic095N3RDRHRtSnp0ZzUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3TCtnN1krd0lPeVhodXlkdENEcXNyRHNvSnp0bGFEcXVZenNtcFEvSU95bmdPcTRpQ0Ryc0p2c3A0QWc3SldLN0p5ODY2bTBJTzJWb095ZHVDRHN2NkR0ajdEc25ZUWc2N0NiN0oyRUlPeUltQ0RzbDRic2xyVHNtcFF1Q2kwZzdMK2c3WSt3N0oyRUlPdXdtK3ljdk91cHRDRHJqWlFnN0tDQTY2QzA3WldZNnJLTUlPcXlzT3lnbk8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lWak91bXZDRHNsNGJzbmJRZzdJdWM3SjZSN1pXZzZybU03SnFVDQpQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aA0KbkNEcXRvenRsWnpyczREcXNyM3NuWVFnN1pXWTdJdWtJT3lJbUNEc2w0YnNsclRzbXBRdUlPeWR2T3V3bUNEcXRJRHJwcXpzbnBEcm9ad2c2cmFNN1pXY0lPdXpnT3F5dmV5ZGhDRHNtNUR0bFpqc2k2UWc2cks5N0pxd0lPdUxwT3VsdUNEc2dxenJub3pzbDVEcXNvd2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrQ0RxdG96dGxaenNuWVFnN0tlQTdLQ1Y3WlcwSU95anZPeUxvQ0R0bTRRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWbkNEcmtxUWc3SjI4NjdDWUlPcTBnT3Vtck95ZWtPdWhuQ0RyczREcXNyM3RsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKMkVJT3VuaU95S3BPMkVzQ0RxdElEcnBxenNucERyb1p3ZzdLZUE3S0NWN1pXWTY2bTBJT3V6Z09xeXZlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnbz0NCjo6R1VJREU6Og0KSXlCVldDQlhjbWwwYVc1bklPcXdnT3lkdE91VG5BMEtEUW9qSXlBeExpRHRsYlRzbXBUc3NyUU5DZzBLN0tDYzdaS0lJT3lWaU95ZG1DRHJxcWpyazZBZzY2eTQ2cldzNjRxVUlDZnRsYlRzbXBUc3NyUW42NkdjSU95TnFPeWFsQzROQ3V5ZHZPcTBnT3lFc1NEc25vanJpcFFnN0lLczdKcXA3SjZRSU9xeXZlMlhtT3lkaENEcnA0enJrNlFnN0lpWUlPeWVpT3VQaE91aG5TQXFLdXlEZ2UyWnFTd2c2NmVsNjUyOTdKMkVJT3UyaU91c3VPMlZtT3F6b0NEcnFxanJrNkFnNjZ5NDZyV3M3SmVRSU8yVnRPeWFsT3l5dE91bHZDRHNvSUhzbXFudGxiVHNvN3pzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEcnM3VHJnNFhyaTRqcmk2UWc0b2FTSU91enRPdUN2T3F5ak95YWxBMEtEUW9xS2lvTkNnMEtJeU1nTWk0ZzY0cWw2NCtaN0tDQklPdW5rTzJWbU9xNHNBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJT3kxbk91TWdPMlZuQ0FxS3V1S3BldVBtZTJZbFNEcnJManNucVVxS3V5ZGhDRHNqYWpzbzd6c2hManMNCm1wUXVJT3lJbU91UG1lMllsU0Ryckxqc25xWHNuWUFnVyt5WWlPeVp1Q0RxdDV6c3VabGRLQ1BzbUlqc21iZ3RNUzNzaUpqcmo1bnRtSlV0NjZ5NDdKNmw3SjJFTGV5TnFPdVBoQzNya0pqcmlwUXQ2cks5N0pxd0tleVhrQ0R0bGJUcmk3bnRsYUFnNjVXTTY2ZU1JT3lUc091S2xDRHFzb3dnN0tLTDdKV0U3SnFVTGcwS0RRb2pJeU1nNjVDUTdKYTA3SnFVSU9LR2tpRHRsb2pzbHJUc21wUU5DZzBLN0ppSUtRMEtMU0RzaEtUc29KWHJrSkRzbHJUc21wUWc0b2FTSU95RXBPeWdsZTJXaU95V3RPeWFsQTBLRFFvakl5TWdKMzdzbDRnbklPdTV2T3E0c0EwS0RRcnNtSWdwRFFvdElPdXdsT3VBak95WGlPeVd0T3lhbENEaWhwSWc2N0NVNnIrbzdKYTA3SnFVRFFvTkNpTWpJeURyajVuc2dxd2c2N0NVNnIrVTdKT3c2cml3RFFvTkN1eVlpQ2tOQ2kwZzY0YVM3SldFN0tHTTdKYTA3SnFVSU9LR2tpRHNtS3pybnBEc2xyVHNtcFFOQ2cwS0tpb3FEUW9OQ2lNaklETXVJT3E0amV5Z2xleWdnU0RycDVEdGxaanF1TEFODQpDZzBLN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RydG9Ec29KWHNvSUVnN0x1azY2Nms2NHVJN0x5QTdKMjA3SVdZN0oyRUlPeTFuT3VNZ08yVm5DRHNwSVRzbmJUcXM2QWc2cmlON0tDVjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqc283enNoTGpzbXBRdURRcnJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUTXQ2N2FBN0tDVjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNqYWpzbXBRdURRb05DdXlZaUNBNklPeVZpQ0Ryajd6c21wUXNJT3lYaHV5V3RPeWFsQ0FvV0NrZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJeURzbDRic2xyVHNtcFFnNG9hU0lPeWVpT3lXdE95YWxBMEtEUXJzbUlncERRb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bFpqcXVMQWc3S0NFN0plUTY0cVVJT3F3Z095ZWhlMlZvQ0RzaUpnZw0KN0plRzdKYTA3SnFVSU9LR2tpRHJzN1R0bUxqc25wRHFzSUFnN1plSTY1Mjk3WlcwN0pXOElPcXdnT3llaGUyVm9DRHNpSmdnN0o2STdKYTA3SnFVRFFvTkNpTWpJeURzbDVEcm42d2c2Nm1VN0l1YzdLZUFEUW9OQ3V5WGtPdWZyQ0RzZzRIdG1hbnNsNURzaEp6cmo0UWdJdTJWdE9xeXNDRHJzS25yc3BVaTdKMkVJT3Vvdk95Z2dDRHNsWXpyb0tUc283enJpcFFnNnJpTjdLQ1Y3WmlWSU9xMXJPeWhzT3VobkNEc2phanNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLZUE2cmlJSU91eWhPeWdoT3lYa095RW5PdUtsQ0RzazdnZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lPZDdMSzBJT3lkdU95bW5leWRoQ0RzazdEcm9LVHJxYlFnN0pXeDdKMkVJT3kxbk95TG9DRHJzb1Rzb0lUc25MenJvWndnN0plRjY0Mnc3SjIwN1lxNElPMlZ0T3lqdk95RXVPeWFsQzRnNG9hU0lPeVZzZXlkaENEc2w0WHJqYkRzbmJUdGlyanRsYlRzbzd6c2hManNtcFF1SU95RG5leXl0Q0RzbmJqc3BwM3NuWVFnN0pPdzY2Q2s2Nm0wSU95MW5PeUwNCm9DRHJzb1Rzb0lUc25iUWc3WldFN0pxVTdaVzA3SnFVTGcwS0RRbzZPam9nZEdsd0lPMk1uZXlYaFNEcnNvVHRpcnpzbllBZ1d6Z3VJTzJNbmV5WGhWMGc2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQTBLN1l5ZDdKZUZLT3VMcE95ZHRPeVd2T3Vobk9xM3VDa2c2N0tFN1lxOElPdXN1T3Exck91S2xDRHNsWVRybnBnZ0tpbzRMaUR0akozc2w0VXFLaURzaExuc2haZ2c2cmVjN0xtWjdKMkVJT3VVc091ZHZPeWFsQ0RpZ0pRZzdZYTE2N08wNjRxVUlGdnRtWlhzbmJoZExDRHNtSWd2N0pXRTY0dUk3SmlrSU8yTWtPdUxxT3lkZ0NCYjdKV0U2NHVJN0ppa1hjSzNXK3VFcEYwc0lPdVBtZXlla1NEc25LRHJqNFRyaXBRZ1creTNxT3lHakYzQ3QxdnJqNW5zbnBGZExpQWk3TGVvN0lhTUl1dUtsQ0RyajVuc25wRWc2N0tFN1lxODZyTzhJT3lubmV5ZHZDRHJsWXpycDR3ZzdKT3c2ck9nTENBaTY0dXI2cml3SU1LM0lPdVBtZXlla1NMc3NwanJuN3dnN0tlZDdKMjBJT3lWaUNEcnA1N3JpcFFnN0tHdzdaV3A3SjJBDQpJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW82T2pvTkNnMEtJeU1qSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLN0ppSUtRMEtMU0RycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnNG9hU0lPeVZ2ZXEwZ095WGtDRHJqNW5zblpqdGxaanJxYlFnNjZxbzdKNkU3S2VBN0p1UTZyaUk3SjJFSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdaaWM3WU9kSU91TWdPeURnU0RzbFlqcmdyUU5DZzBLS2lyc2hKenJ1WVRzaXFUcmlwUWc3Sk80SU95SW1DRHNub2pzcDREcnA0d3NJTzJLdWV5Z2xTRHRtSnp0ZzUzc25ZQWc2N0NiN0oyRUlPeUltQ0RzbDRic25ZUWc2NVdNSU9LR2tpRHF1STNzb0pYdG1KVWc2Nnk0N0o2bA0KN0p5ODY2R2NJT3lOcU95YWxDNHFLZzBLN0lLczdKcXA3SjZRNjRxVUlPdXN1T3Exck91bHZDRHF2THpxdkx6dG5vZ2c3SjI5N0tlQUlPeVZpdXF6b0NEdG01SHNsclRyczdUcXVMQW83SXFrN0xxVUtTRHJsWXpyckxqc2w1QXNJT3UyZ095Z2xlMllsZXljdk91aG5DRHNrN0RycWJRZzdLQ2M3WktJSU95Z2hPeXl0T3VsdkNEc2s3Z2c3SWlZSU95WGh1dUxwT3F6b0NEc21LVHRsYlR0bFpqcXVMQWc3SW1zN0p1TTdKcVVMZzBLRFFyc21JZ3BEUW90SU9xemhPeWlqQ0Rxc0p6c2hLUWc3WmljN1lPZDdKMkFJT3V3bSt5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlEaWhwSWdOQzQxSlNEcXVJanJwcXdnN1ppYzdZT2Q2NmVNSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTkM0ZzdMcVE3S084N0phODdaV2NJT3F5dmV5V3RBMEtEUXJzb0p6dGtvZ2c3SldJN0plUTdJU2NJQ2QrN0l1YzZyS2c3SmEwN0pxVVB5Y3NJQ2ZzaTV6cmdwanNtcFEvSnl3Z0ozN3F1NWduSU9xd21leWQNCmdDRHFzN3pyajRUdGxad2c2cks5N0phMDY2VzhJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUXJzdFp6cmpJRHRsWndnN0xxUTdLTzg3SmE4N1pXWTZyT2dJT3k1bk9xM3ZPMlZuQ0RycDVEdGlLenJwYndnN0pPdzY0cVVJT3F5akNEc29vdnNsWVRzbXBRdURRcnFzcjNzbHJUcmlwUWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1pM3FzcjNzbHJUcnBid3Q3STJvNjQrRUxldVFtT3VLbEMzcXNyM3NtckFwN0plUUlPMlZ0T3VMdWUyVm9DRHJsWXpycDR3ZzdJMm83SnFVTGcwS0RRb2pJeU1nNjQrWjdJS3M3SmVRN0lTY0lDZCs3SXVjSnlEcnVienF1TEFOQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzdaVzA3S2VBN1pXWTdJdWM2cktnN0phMDdKcVVQeURpaHBJZzdMbTA2NU9jNjZXOElPMlZ0T3luZ08yVm9PcTVqT3lhbEQ4TkNpMGc3SXVjN0o2UjdaV1k3SXVjNjRxVUlPdTJoT3lYa09xeWpDQTFMREF3TU95YmtPeWRoQ0RyazV6cm9LVHNtcFF1SU9LR2tpRHNpNXpzbnBIdGxaanJxYlFnDQpOU3d3TUREc201RHNuWVFnNjVPYzY2Q2s3SnFVTGcwS0RRb2pJeU1nSitxemhPeUxuT3VMcENjZzRvYVNJQ2Zzbm9qcmk2UW5EUW9OQ3V5WWlDa05DaTBnN0o2UTY0K1o3TENvNjZXOElPcXdnT3luZ09xem9DRHFzNFRzaTV6cmdwanNtcFEvSU9LR2tpRHNucERyajVuc3NLanFzSUFnN0o2STY0S1k3SnFVUHcwS0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTUlPeVd2T3VuaU95VXFTRHJnclRxczZBZzZyT0U3SXVjNjRLWTdKcVVQeURpaHBJZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91S2xDRHNscnpycDRqc25ianFzSURzbXBRL0lDb282NHVvN0lpY0lPeTVtTzJabU95ZHRDRHNsWVRyaTRqcm5id2c2Nnk0N0o2bDdKMkVJT3lEaU91aG5DRHNrN1FnN0lLczY2R0E3SmlJN0pxVUtTb05DZzBLSXlNaklDZnNsNnpzcllqcmk2UW5JT0tHa2lBbjdabVY3SjI0N1pXWTY0dWtMQ0Ryckx2cmk2UW5EUW9OQ3V5WWlDa05DaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSDZyQ0E3S2VBSU91TA0KcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUlPS0draURzbFlqc29JVHRsWndnNnJDYzdZYTE3SjJFSU95Y2hPMlZ0Q0RycW9mcXNJRHNwNEFnNjR1azdJdWNJTzJabGV5ZHVPMlZvT3F5ak95YWxDNE5DZzBLSXlNaklDZnF1NWduSU9LR2tpQW43SmVRNnJLTUp3MEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbU9xN21DRHJncURzbFlUcXNJRHFzNkFnN0o2STdKYTA3SnFVTGlEaWhwSWc3Wm1ONnJpNDY0K1o2NHVZN0plUTZyS01JT3VDb095VmhPcXdnT3F6b0NEc25vanNsclRzbXBRdURRb05DaU1qSXlEcXNyM3NsclRycGJ3ZzY3cVE3SjJFSU91VmpDRHNsclRzZzRudGxad2c2cks5N0pxd0RRb05DdXlDck95YXFleWVrT3lkbUNEc29KWHJzN1RycGJ3ZzY3Q2I2NHFVSU95bmlPdXN1T3lYa095RW5DRHF1TERxczRUc29JSHNuTHpyb1p3Z0ozN3NpNXduNjZXOElPdTZrT3lkaENEcmxZd2c2Nnk0N0o2bDdKMjBJT3lXdE95RGllMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtLaXJ0akl6c2xZWHQNCmxaanFzNkFnN0l1MjdKMkFJT3lnbGV1enRPdWx2Q0FuN0tPODdKYTBKK3VobkNEc2phanNoSndnNjZ5NDdKNmw3SjJFSU95RGlPdWhyZXF5akNEc2phanJzN1RzaExqc21wUXVLaW9OQ2cwSzdKaUlLUTBLTFNEc2xyVHJscVFnNjZxcDdLQ0I3Snk4NjZHY0lPdU1nT3kybk91d20reWN2T3lMbk91Q21PeWFsRDhnNG9hU0lPdU1nT3kybkNEcnFxbnNvSUhzbmJRZzY2eTA3SmVIN0oyNDZyQ0E3SnFVUHcwS0xTRHNsclRybHFRZzdKMjA3SnlnNjZHY0lPeUxvT3F6b08yVm1PeUxuT3VDbU95YWxEOGc0b2FTSU95TG9PcXpvQ0RzbmJUc25LRHJwYndnN0lTZzdZT2Q3WlcwSU95anZPeUV1T3lhbEM0TkNnMEtLaW9xRFFvTkNpTWpJRFV1SUNkNzY2cUY3SUtzZlNBcklIdnJxb1hzZ3F4OUp5RHNrN0RzcDRBZzdKV0s2cml3RFFvTkNpTWpJeUR0bFp6c25wRHNsclFnN1pLQTdKYTA3Sk93NnJpd0RRb05DdTJWbk95ZWtPeVd0Q0RycW9Yc2dxenJwYndnN1pLQTdKYTA3SVNjSU91UG1leUNyQ0R0bUpYdGc1enJvWndnDQo3Sk80SU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBRZzRvYVNJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFFOQ2kwZzY0SzA3SjI4SU95NXRPdVRuT3F3a3V5ZHRDRHFzckRzb0p6cmtLQWc3SmlJN0tDVjdKMjA3SmVRN0pxVUlPS0draURyZ3JUc25ienNuWUFnN0xtMDY1T2M2ckNTSU91Q21PcXdnT3VLbENEcmdxRHNuYlRzbDVEc21wUU5DZzBLSXlNaklPMlZuT3lla095V3RPdWx2Q0R0a29Ec2xyVHNrN0RxdUxBZzdKYTA2NkNrN0pxNElPcXl2ZXlhc0EwS0RRb25lK3VxaGV5Q3JIM3FzSUFnZSt1cWhleUNySDN0bGJUc2hKd25JTzJZbGUyRG5PdWhuT3VuakNEdGtvRHNsclRzcEpqcmo0UWc2NDJVSU95NmtPeWp2T3lXdk8yVm1PcXlqQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHY0lPcTFyT3VucE8yVm1PeW5nQ0RycXJ2dA0KbG9qc2xyVHNtcFFnNG9hU0lPeWVsT3lWb2V5ZHRDRHJ0b0Rzb2JIdGxiVHNoSndnNnJXczY2ZWs3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ05pNGc3WkdjNnJpd0lPMkd0ZXlkdkEwS0RRb2pJeU1nNjVDWTdKYTA3SnFVSUNoWUtTRGlocElnNjQrODdKcVVJQ2hQS1EwS0RRcnJxcWpyc0pUc25id2c3Wm1VNjZtMDdKMllJT3lpZ2V5ZGdDRHFzN1hxc0lUc25ZUWc2ck9nNjZDazdaVzBJQ2Zya0pqc2xyVHNtcFFuNjRxVUlPdXFxT3VSa0NBbjY0Kzg3SnFVSit1aG5DRHRoclhzbmJ6dGxiVHNoSndnN0kybzdLTzg3SVM0N0pxVUxnMEtEUW9xS2lvTkNnMEtJeU1nTnk0ZzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt5SXEreWVrQ0R0a1p6cXVMQU5DZzBLNjRLZzdLZWN3cmZzaTV6cXNJVEN0K3V5aU8yWXVPdUtsQ0RzbFlUcm5wZ2c3WmlWN0l1ZDdKeTg2NkdjSU8yR3RleWR2TzJWdE95RW5DRHNqYWpzbXBRdURRb05DaU1qSXlEcmdxRHNwNXpDdCt5TG5PcXdoTUszNnJpdzZyQ0UNCkRRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnNjRLZzdLZWNJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFWUNBdklPeW5wK3F5akNCZ1RVMHVSRVJnSUh3Z01qQXlOUzR3TVM0d01Td2dNalV1TURFdU1ERWdmQTBLZkNEc2k1enFzSVFnZkNEcXVMRHJzN2dnWUVoSU9rMU5PbE5UWUNBdklPeW5wK3F5akNCZ1NFZzZUVTFnSUNqc21LVHNvSVF2N0ppazdadUVJT3lWaUNEc2xJQXBJSHdnTVRRNk16QTZNVEVzSURFek9qTXdJSHdOQ253ZzZyaXc2ckNFSUh3ZzZyaXc2N080SUdCWldWbFpMazFOTGtSRWZsbFpXVmt1VFUwdVJFUmdJQzhnN0tlbjZyS01JR0JaV1ZsWkxrMU5Ma1JFZmsxTkxrUkVZQ0I4SURJd01qVXVNREV1TURGK01qQXlOUzR3TVM0ek1Td2dNakF5TlM0d01TNHdNWDR3TVM0ek1TQjhEUXA4SU91Q29PeW5uQ0FySU95TG5PcXdoQ0I4SUdCWldWbFpMazFOTGtSRUlFaElPazFOWUNCOElESXdNalV1DQpNREV1TURFZ01UUTZNekFnZkEwS2ZDRHNtcFRzbmJ3Z2ZDQmdXVmxaV1M1TlRTNUVSQ2pzbXBUc25id3BZQ0RpZ0pRZzdKdVVMKzJabEMvc2lKZ3Y2NnFwTCtxNGlDL3RocUF2N0oyOElId2dNakF5TlM0d01TNHdNU2pzaUpncElId05DZzBLS2lyc2k1enFzSVFnN0ppSTdKbTRLaW82SU95Q3JPeWFxZXlla09xd2dDRHNwNEhzb0pFZzZyT2c2NlcwNjRxVUlPdXdxZXVzdU1LMzdKaUk3Slc5SU95TG5PcXdoT3lkZ0NCZzdKaWs3S0NFTCt5WXBPMmJoQ0JJT2sxTllPeWRoQ0RzamFqcmo0UWc2NCs4N0pxVUxnMEs3SmlJS1NEc21LVHRtNFFnTVRvd01BMEtEUW9qSXlNZzY2eTQ3SjZsSU95R2pTRHNsN0RzbTVUc25id05DZzBLNjZ5NDdKNmxJT3lWaU95WGtPeUVuT3VLbENBcUt1eWJsTUszN0oyOElPeVZudXlkbUNBdzdKMkVJT3U1dk9xem9Db3FJT3lOcU95YWxDNE5DZzBLN0ppSUtRMEtMU0F5TURJMjY0V0VJREE0N0p1VUlEQTE3SjI4SU95ZWhldUxpT3VMcEM0ZzRvYVNJREl3TWpicmhZUWdPT3libENBMQ0KN0oyOElPeWVoZXVMaU91THBDNE5DZzBLSXlNaklPeURnZXVNZ0NEc2k1enFzSVFnS091RnVPeTJuT3lhcVNrTkNnMEtmQ0Rzb2JEcXNiUWdmQ0R0a1p6cXVMQWdmQTBLZkMwdExTMHRMWHd0TFMwdExTMThEUXA4SURZdzdMU0lJT3V2dU91bmpDQjhJT3V3cWVxNGlDRHNvSVFnZkEwS2ZDQTJNT3UyaENEcnI3anJwNHdnZkNCTzY3YUVJT3lnaENCOERRcDhJREkwN0l1YzZyQ0VJT3V2dU91bmpDQjhJRTdzaTV6cXNJUWc3S0NFSUh3TkNud2dNekRzbmJ3ZzY2KzQ2NmVNSUh3Z1R1eWR2Q0Rzb0lRZ2ZBMEtmQ0F4TXVxd25PeWJsQ0RycjdqcnA0d2dmQ0JPNnJDYzdKdVVJT3lnaENCOERRcDhJREV5NnJDYzdKdVVJT3lkdE95RGdTQjhJRTdyaFlRZzdLQ0VJSHdOQ2cwSzdKaUlLU0Ryc0tucXVJZ2c3S0NFTENBMTY3YUVJT3lnaEN3Z011eUxuT3F3aENEc29JUXNJRFBzbmJ3ZzdLQ0VMQ0EyNnJDYzdKdVVJT3lnaEN3Z011dUZoQ0Rzb0lRTkNnMEtJeU1qSU91bmlPcXdrTUszNnJpdzZyQ0VJT3Vuak91ampBMEsNCkRRcGdSQzFPWUNoTzdKMjhJT3VDcU95ZGpDa2dMeUJnUkMwd1lDanNtS1RyaXBnZzY2ZUk2ckNRS1NBdklHQkVLMDVnS0U3c25id2c2cks5NnJPOEtRMEs3SmlJS1NCRUxUY3NJRVF0TVN3Z1JDMHdMQ0JFS3pFTkNnMEtJeU1qSU91eWlPMll1Q0R0a1p6cXVMQWdLTzJWbU95ZHRPMlVpT3ljdk91aG5DRHF0YXpydG9RcERRb05DbndnN1pXdDY2cXBJSHdnN1ppVjdJdWRJSHdnN0ppSTdJdWNJSHdOQ253dExTMHRMUzE4TFMwdExTMHRmQzB0TFMwdExYd05DbndnN0tDRTdabVU2N0tJN1ppNElId2c3WldZN0oyMDdaU0lJT3Exck91MmhDQjhJREF5TFRFeU16UXROVFkzT0N3Z01ERXdMVEV5TXpRdE5UWTNPQ0I4RFFwOElPeTV0T3VUbk91eWlPMll1Q0I4SURUc25wRHJwcXpzbEtrZzdaV1k3SjIwN1pTSUlId2dNVEl6TkMwMU5qYzRMVGt3TVRJdE16UTFOaUI4RFFwOElPcXpoT3lpak91eWlPMll1Q0I4SU8yVm1PeWR0TzJVaUNEcXRhenJ0b1FnZkNBeE1qTXRORFUyTFRjNE9UQXhNaUI4RFFwOElPeWp2T3V2DQp2T3VUc2V1aG5ldXlpTzJZdUNCOElPeVZuaUEyN0o2UTY2YXNMZXVTcENBMzdKNlE2NmFzSUh3Z01USXpORFUyTFRFeU16UTFOamNnZkEwS2ZDRHNncXpzbDRYc25wRHJrN0hyb1ozcnNvanRtTGdnZkNBeE1PeWVrT3VtckNEdGxaanNuYlR0bElnZ2ZDQXdNUzB5TXpRdE5UWTNPRGtnZkEwS0RRb2pJeU1nN0pPdzY2bTBJT3lWaUNEcmtKanJpcFFnN1pHYzZyaXdEUW9OQ2kwZzY0S2c3S2VjN0plUUlPMlZtT3lkdE8yVWlNSzM2N21YNnJpSU9pRGluWXdnTWpBeU5TMHdNUzB3TVN3Z01ERXZNREVOQ2kwZzdJdWM2ckNFN0plUUlPeVlwT3lnaEMvc21LVHRtNFE2SU9LZGpDRHNtS1Rzb0lRZ01leUxuQ0FxS091THFDd2c3SUtzN0pxcDdKNlE2ckNBSU95bmdleWdrU0RxczZEcnBiVHJpcFFnNjdDcDY2eTR3cmZzbUlqc2xiMGc3SXVjNnJDRTdKMkFJT3lZaU95WnVDa3FEUW9OQ2lvcUtnMEtEUW9qSXlBNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1EwS0RRcnRqSjNzbDRVZzY2eTQ2cldzNjRxVQ0KSUNvcTdKZXQ3WldnS2lvbzdZT0E3SjIwN1l1QXdyZnNsWWpyZ3JUQ3QrdXloTzJLdkNucXM3d2dLaXJzbktEdG1KVXFLaWp0aHJYcnM3UXY3WXlRNjR1b0tleVhrQ0RybExEcm5id2c2Nnk0N0xLMDZyQ0FJT3VMck91ZHZPeWFsQzRnN1lPQTdKMjA3WXVBN0oyRUlPdUxwT3VUck95ZGhDRHJsWkFnNjdDWTY1T2M3SXVjSU95VmlPdUN0Q2pyczdqcnJMZ3A2cm1NN0tlQUlPcXdtZXlkdENEcnM3VHFzNkFzSU91enVPdXN1Q0RycDZYcm5iM3NuWVFnNjR1MDdKV0U3Slc4SU8yVnRPeWFsQzROQ2cwS0l5TWpJRERyaTZqcXM0UWc0b0NVSU8yS3VPdW1yT3F4c091MmdPMkVzQ0RydEpEc21wUU5DZzBLN1l5ZDdKZUY3SjIwSU95Q3JPeWFxZXlla095ZG1DRHNsclRybHFRZzdaYUo2NCtaSU91U3BPeVhrQ0RybktqcmlwVHNwNEFnNjZpODdLQ0FJTzJNak95VmhlMlZ0T3lhbEM0TkNnMEtMU0R0bG9ucmo1bnNuWVFnS2lycXNJRHJvWnpycDRucXNiRHJncGdnN1l5UTY0dW83SjJFSU95YWxPcTFyQ29xS095ZHRPMkQNCmlNSzM3SUt0N0tDY3dyZnJvWnpxdDdqc2xZVHNtNFBDdCt5aWhldWpqQ2tnNG9hU0lDb3E3WXlRNjR1bzdaaVZLaW9nS091c3ZPeVd0T3Uwa095YWxDa05DaTBnNnJLdzZyTzh3cmZzZzRIdGc1enJwYndnS2lydGhyWHJzN1RycDR3cUtpQW83Sm1FNjZPTXdyZnNpNlR0aktncElPS0draUFxS3V5VmlPdUN0TzJZbFNvcUlDanNsWXpyb0tUc3BKanNtcFFwRFFvTkNpTWpJeUR0ZzREc25iVHRpNEFnNG9DVUlPeW5wK3lkZ0NEcnFvWHNncXpxdGF3TkNnMEtMU0RycW9Yc2dxenRtSlhzbkx6cm9ad2c2NEdkNjRLMDdKcVVMaURzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5PdWx2Q0RzazdEc3A0QWc3SldLN0pXRTdKcVVJQ2grN0pxVUlDOGdmdXVMcENBdklIN3F1WXpzbXBRL0lPS2RqQ2t1RFFvdElESitOT3lXdE95Z2lPdWhuQ0RzcDZmcXM2QWc3SW05NnJLTUxpRHRsWnpzbnBEc2xyVEN0K3lJbU95TG5leWRoQ0RxdUxqcXNvd2c3SXlUN0tlQUlPeVZpdXlWaE95YWxDNE5DaTBnN0pXSTY0SzBLT3V6DQp1T3VzdUNrZzY2ZWw2NTI5N0oyRUlPeWFsT3lWdmUyVnRDd2dLaXJ0ZzREc25iVHRpNERycDR3ZzY3U1E2NCtFSU91c3RPeUtxQ0R0akozc2w0WHNuYmpzcDRBcUtpRHNsWXpxc293ZzdaVzA3SnFVTGlEc201RHJzN2pzbmJRZ0oreVZqT3Vtdk1LMzdabVY3SjI0Sit5eW1PdWZ2Q0RycDRuc2w3RHRsWmpycWJRZzY3TzQ2Nnk0N0oyRUlPcTN2T3F4c091aG5DRHF0YXpzc3JUdG1aVHRsYlRzbXBRdURRb05DbndnN0oyMDY2Q0g2cktNSU91bmtPcXpvQ0I4SU95ZHRPdWdoK3F5akNCOERRcDhMUzB0ZkMwdExYd05DbndnN0tDQTdKNmw3WldZN0tlQUlPeVZpdXF6b0NEcmdwanFzSURzaTV6cXNxRHNsclRzbXBRL0lId2c3S0NBN0o2bElPeVZpQ0R0bFp3ZzY0SzA3SnFwSUh3TkNud2c3SldNNjZhOElId2c2ckt3N0tDY0lPeVpoT3VqakNCOERRcDhJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lId2c2NDJ3N0oyMDdZU3dJT3lDcmV5Z25DQjhEUW9OQ2lNakl5RHNsWWpyZ3JRbw0KNjdPNDY2eTRLU0RpZ0pRZzdaVzA3SnFVN0xLMERRb05DaTBnS2lydGpKRHJpNmp0bUpVcUt1eWRnQ0FuZnUyVm9PcTVqT3lhbEQ4bjY2R2NJT3Vzdk95V3RPeWFsQzRnNjVDWTY0K002NmEwSU95SW1DRHNsNGJyaXBRZzdKeUU3WmVZS095Q3JleWduTUszN1lPSTdZZTBJT3VUc1Nuc25ZQWc2ckt3NnJPODY2VzhJT3Vvdk95Z2dDRHFzcjNxczZEdGxiVHNtcFF1RFFvdElDb3E3SldJNjRLMDdaaVZLaXJzbllBZzdJS3M3SXVrN0oyRUlPeUVuT3lJb08yVnRPeWFsQzROQ2kwZzY2ZUk3TG1vN1pHYzY2VzhJT3lOcU95YWxDNGc3SWlyN0o2UXdyZnNvYkRxc2JRbzdKMjA3SU9Cd3Jmc25iVHRsWmpDdCt5ZHRPdUN0Q0RyazdFcDdKMkFJT3EzdU91TWdPdWhuQ0Rya1pEcXM2QXNJT3lia091c3VPeVhrQ0RzbDRicmlwUWc3S0NWNjdPMHdyZnNvSWpzc0tqQ3QreVhzT3VkdmV5eW1PdWx2Q0RzcDREc2xyVHJnclRzcDRBZzdKV0s3SldFN0pxVUxnMEtEUW9qSXlNZzY3S0U3WXE4SU9LQWxDRHNsWWpyZ3JRZzY2eTQNCjY2ZWw3SjIwSU95Z2xlMlZ0T3lhbEEwS0RRcDhJT3V6dU91c3VPeWR0Q0RzbmJUcm9JZnJpNlFnZkNEcnNvVHRpcndnZkEwS2ZDMHRMWHd0TFMxOERRcDhJT3F5c09xenZNSzM3SU9CN1lPYzY2VzhJTzJHdGV1enRDQjhJRnZ0bVpYc25iaGRJSHdOQ253Z0ozN3RsYURxdVl6c21wUS9KK3VobkNEcnJMenNuWXdnZkNCYjdKV0U2NHVJN0ppa1hTREN0eUJiNjRTa1hTQjhEUXA4SU95RGdlMlpxU0RzaEp6c2lLQWdLeURzbUtUcnBianNxcjNzbmJRZzdJdWs3S0NjSU91UG1leWVrU0I4SUZ2c3Q2anNob3hkSU1LM0lGdDc2NCtaN0o2UmZWMGdmQTBLRFFvdElDZnN0NmpzaG93bjY0cVVJQ29xNjQrWjdKNlJJT3V5aE8yS3ZPcXp2Q0RzcDUzc25id2c2NVdNNjZlTUtpb2c3STJvN0pxVUlDanNtSWc2SUZ2c3Q2anNob3hkd3JkYjdJS3Q3S0NjWFNrdUlDZnJpNnZxdUxBZ3dyY2c2NCtaN0o2UkoreXltT3VmdkNEc3A1M3NuYlFnN0pXSUlPdW5udXVLbENEc29iRHRsYW5zbmJUcmdwZ2c2NHVvNjQrRklDZnN0NmpzDQpob3duNjRxVUlPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRb3RJT3V5aE8yS3ZPeWRtQ0RyajVuc25wRWc3SjIwNjZhRTdKMkFJTzJabE91cHRDRHF1TERyaXFYcnFvVW82N09BNnJLOXdyZnRsYlRzb0p3ZzY1T3hLZXlkaENEcXQ3anJqSURyb1p3ZzdJSzA2NkNrN0pxVUxnMEtEUW9qSXlNZzdZYTE3S2VjSU95WWlPeUxuQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0oyMDdZT0lLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHNvSURzbnFVZzdKV0lJTzJWbkNEcmdyVHNtcWtOQ2kwZzdKV0k2NEswT2lEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhnN0o2RjY2Q2w3WldjSU91Q3RPeWFxZXlkdENEc2dxenJuYnpzb0xqc21wUXVEUW90SU91eWhPMkt2RG9nN0pXRTY0dUk3SmlrSU1LM0lPdUVwQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0lLdDdLQ2NJQ2pzbklUdGw1Z3BLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHJqYkRzbmJUdGhMQWc3SUt0N0tDY0RRb3RJT3lWaU91Qw0KdERvZzdJS3Q3S0NjN1pXWTY2bTBJT3VMcE95TG5DRHNnclRycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnN0lLdDdLQ2M3WldnNnJtTTdKcVVQdzBLTFNEcnNvVHRpcnc2SU95VmhPdUxpT3lZcENEQ3R5RHJoS1FOQ2cwS0tpcnJqNW5zbnBIdG1KVWc0b0NVSU95RW5PeUlvQ0FySU91UG1leWVrU0Ryc29UdGlyd3FLZzBLTFNEdGc0RHNuYlR0aTRBNklPcTRzT3E0c0NEc2w3RHFzckFnN1pXMDdLQ2NEUW90SU95VmlPdUN0RG9nN0lTZzdZT2Q3WldjSU9xNHNPcTRzT3lkbUNEc2w3RHFzckRzbllRZzY0R0s3SmEwN0pxVUxnMEtMU0Ryc29UdGlydzZJT3kzcU95R2pDREN0eURzbDdEcXNyQWc3WlcwN0tDY0RRb05DaW9xN0pXSTY0SzA3WmlWSU9LQWxDRHNtWVRybzR3ZzdZYTE2N08wS2lvTkNpMGc3WU9BN0oyMDdZdUFPaURxc3JEc29Kd2c3Sm1FNjZPTURRb3RJT3lWaU91Q3REb2c2ckt3N0tDYzZyQ0FJT3lnbGV5RGdTRHNzcGpycHF6cmtKRHNsclRzbXBRdURRb3RJT3V5aE8yS3ZEb2c3Wm1WN0oyNERRb04NCkNpb3FLZzBLRFFvaklPeVlpT3ladUNEcXQ1enN1WmtOQ2cwSzdKdVE3TG1aS091S3BldVBtY0szNnJpTjdLQ1Z3cmZzdXBEc283enNscndwNjdPMDY0dWtJT3lZaU95WnVPcXdnQ0RyalpRZzY2cUY3Wm1WN1pXY0lPeTdwT3V1cE91TGlPeThnT3lkdE95Rm1PeWRoQ0RycDR6cms1enJpcFFnNnJLOTdKcXc3SmlJN0pxVUxnMEtEUW9qSXlEc21JanNtYmdnTVM0ZzdJaVk2NCtaN1ppVklPdXN1T3llcGV5ZGhDRHNqYWpyajRRZzY1Q1k2NHFVSU9xeXZleWFzQTBLRFFvakl5TWc3SVNjNjdtRTdJcWtJT3lpaGV1ampDd2c2cml3NnJDRUlPdW5qT3VqakEwS0RRcnNpSmpyajVudG1KWHNuTHpyb1p3ZzdKT3c2Nm0wSU95anZPeVd0Q2pzb29Ycm80d2c3SVNjNjdtRTdJcWtMQ0RxdUxEcXNJUWc2NU94S2V1bHZDRHFzSlhzb2JEdGxhQWc3SWlZSU95ZWlPcXpvQ3dnSit5aWhldWpqQ2ZzbVlBZ0ordW5qT3VqakNmc25aZ2c2NG1ZN0pXWjdJcWs2Nlc4SU95Z2xlMlpsZTJlaUNEc29JVHJpNnp0bGFBZzdJaVlJT3llDQppT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0JQVDA4ZzdJU2M2N21FN0lxa0lPeWloZXVqakNEc2xZanJnclFnNG9DVUlEQXc3SnVVSURBdzdKMjg2N2FBN1lTd0lPeUVuT3U1aE95S3BPcXdnQ0Rzb29Ycm80enJqN3pzbXBRdUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZUWc3SldNNjZDazY1T2M2NkNrN0pxVUxnMEtMU0RzbnBEc2dyQWc3S0d3N1pxTUlPcTRzT3F3aE95ZHRDRHFzNmNnNjZlTTY2T002NCs4N0pxVUxnMEtEUXJyaTZnc0lDb3E3S084NnJpdzdLQ0I3Snk4NjZHY0lPeWloZXVqak9xd2dDRHJzSmpyczdYcmtKanJpcFFnN0tDYzdaS0lLaXJzbDVEcmlwUWdKK3lpaGV1ampPdVB2T3lhbENmcnBid2c3Sk93N0tlQUlPeVZpdXlWaE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbUtUcmlwanNuWmdnN1lDMDdLYUk2ckNBSU9xenB5RHNvb1hybzR6cmo3enNtcFFnNG9hU0lPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEEwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0plUQ0KNnJLTUlPdXZ1T3k1bU91S2xDRHNtSUh0bHFYc25ZUWc3SldNNjZDazdLU0VJT3VWakEwS0RRb283S084N0pxVUlPdVBtZXlDckNBNklPeVhzT3l5dEN3ZzdaVzA3S2VBTENEc29JSHNtcWtnNjVPeEtRMEtEUXJzaUpqcmo1bnRtSlhzbkx6cm9ad2c3Sk93NjZtMElPeWR1T3F6dkNEcXRJRHFzNFRycGJ3ZzY2cUY3Wm1WN1pXWTZyS01JT3lFcE91cWhlMlZtT3F6b0N3Z0oreUNyT3lhcWV5ZWtPeWRtQ0R0bG9ucmo1bnNsNUFnNjVTdzY1Mjg3SmlrNjRxVUlPcXlzT3F6dkNmcm5ienJpcFFnN0tDUTdKMkVJT3lWak91Z3BPeWtoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lZcE91S21PcTVqT3luZ0NEcmdyVHNwNEFnN0pXSzdKeTg2Nm0wSU95WHNPeXl0T3VQdk95YWxDNGc3WnVFNjdhSTZyS3c3S0NjSU9xNGlPeVZvZXlkaENEcmdyVHNvN3pzaExqc21wUXVEUW90SU91TWdPeTJuT3lkaENEcXNJanNsWVR0ZzREcnFiUWc3SnVRNjU2WUlPdU1nT3kybk95ZHRDRHRsYlRzcDREcmo3enMNCm1wUXVJT3lZcE91S21DRHJncURzcDV6cXVZenNwNERzblpnZzdKMjA3SjZRNjZXOElPeWRnTzJXaWV5WGtDRHJnclRzbGJ3ZzdaVzA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95VmlPeUxyQ0FvN0lpWTY0K1o3WmlWS1EwS0RRb243S0NWNjdPMElPeUltT3lua1NEc2xZanJnclFuSU91VHNleWRtQ0Rycjd6cXNKRHRsWndnN0lPQjdabXA3SmVRN0lTY0lDb3E3SXVjN0lxazdZV2M3SjIwSU95ZWtPdVBtZXljdk91aG5DRHNzcGpycHF6dGxaenJpNlRyaXBRZzdLQ1FLaXJzbllRZzdJaVk2NCtaN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95ZHRPeWduT3UyZ08yRXNDRHRtWTNxdUxqcmo1bnJpNWpzblpnZzZyQ2M3SjI0N0tDVjY3TzBJT3lkdE95YXFTRHJnclRzbDYzc25iUWc2cml3NjZHZDY0Kzg3SnFVRFFvdElPdU5sQ0Rzb292c25ZQWc3SU9CNjR1MDdKMkVJT3ljDQpoTzJWdENEdGhyWHRtWlFnNjRLMDdKcXA3SjJBSU91RnVleWRqT3VQdk95YWxBMEtEUW9qSXlEc21JanNtYmdnTWk0ZzZySzk3SmEwNjZXOElPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdEUW9OQ3UyS3VleWdsU0RzZzRIdG1hbnNsNURzaEp3ZzdLQ2M3WldjN0tDQjdKeTg2NkdjSUNmc2k1enJncGpzbXBRL0xDRHNoYWpyZ3Bqc21wUS9KeURzblpqcnJManRtSlVnN0phMDY2KzQ2Nlc4SU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0oyWUlPdW5wZXVkdmV5ZGhDRHRtWnpzbXFudGxiVHNoSndnN0tlSTY2eTQ3WldnSU91VmpBMEtEUW9uN0l1YzY0S1k3SnFVUHljc0lDZnNoYWpyZ3Bqc21wUS9KeUR0bUpYdGc1enNuWmdnNnJLOTdKYTA2Nlc4SU8yWm5PeWFxZTJWdE95RW5DRHNncXpzbXFuc25wRHNuWmdnNjR1NTdabXA3SXFrNjUrczdKdUE3SjJFSU95a2hPeWR2Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbUN3Zw0KVDA5UElPdUxwT3VGZ095WXBPeUZxT3VDbU95YWxEOE5DaTBnN0xhcDdLQ0U3WldZNjUrc0lPMk91T3lkbU95Z2tDRHFzSURzaTV6cmdwanNtcFEvRFFvTkNpTWpJeURzZ3F6c21xbnNucERzblpnZzdJT0I3Wm1wN0oyRUlPeTJsT3lnbGUyVm9DRHJsWXdOQ2cwSzY2cUY3Wm1WN1pXY0lPeWdsZXV6dE9xd2dDRHNsNGJzbHJUc2hKd2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeW5nZXlna1NEdGpKRHJpNmp0bFpqcXNvd2c3WlcwN0pXOElPMlZvQ0RybFl3ZzZySzk3SmEwNjZHY0lPeWdsZXlra2UyVm1PcXlqQ0RzcDRqcnJManRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzdWJUcms1enJwYndnNjdDYjdKeTg3SVdvNjRLWTdKcVVQeURyazdIcm9aM3RsWmpycWJRZzdMcVE3SXVjNjdDeElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwS0l5TWpJT3lDck95YXFleWVrT3lkbUNEc2hLRHNuWmpxc0lBZzdaV0U3SnFVN1pXZ0lPdVZqQTBLRFFyc2hLVHINCnJManNvYkRzZ3F6c3NwanJuN3dnN0lLczdKcXA3SjZRN0oyWUlPeUVvT3lkbU91bHZDRHF1TERyaklEdGxiVHNsYndnN1pXZ0lPdVZqQ0Rxc3Izc2xyVHJvWndnN0tDVjdLU1I3WldZNnJLTUlPeW5pT3VzdU8yVnRPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25iVHJzb2dnNjR1czdKZVFJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bFpqcnFiVHNoSndnN0phODY2ZUk2NEtZSU91bmpPeWhzZTJWbU95RnFPdUNtT3lhbEQ4TkNnMEtJeU1nN0ppSTdKbTRJRE11SU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU91UW1PdUtsQ0Rxc3Izc21yQU5DZzBLN0lLczdKcXA3SjZRN0plUTZyS01JT3VxaGUyWmxlMlZtT3F5akNEcnRvRHNvSlhzb0lIc25iZ2c2NEswN0pxcDdKMkVJT3lWak91Z3BPeWttT3lWdkNEdGxhQWc2NVdNNjRxVUlPdTJnT3lnbGUyWWxTRHJyTGpzbnFYc25ZUWc3STJvNjQrRUlPeWlpK3lWaE95YWxDNE5DZzBLSXlNaklPeUVuT3U1aE95S3BPdWx2Q0Rzb0pYc3NZWHNnNEVnDQo3Sk80SU95SW1DRHNsNGJzbllRZzY1V01EUW9OQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeURnZTJacWV5ZGhDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3SXVjN1lLc0lPeUltQ0Rzbm9qc2xyVHNtcFF1SUNvcTdKTzRJT3lJbUNEc2w0YnJpcFFnN0oyMDdKeWc2Nlc4SU8yVnFPcTdtQ0RzbFlqcmdyVHRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNwNERxdUlqc25ZQWc2ckNBN0o2RjdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlPeXlyZXlHak91RmhPeWRoQ0RzbklUdGxad2c3SVNjNjdtRTdJcWs2NHFVSU95VmhPeW5nU0RzcElEcnVZUWc3S1NSN0oyMDdKZVE3SnFVTGcwS0xTRHFzN1hyckxUc201RHNuWUFnN1p1RTdKdVE2cmlJN0oyRUlPdXp0T3VDdkNEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SjI4NjdhQUlPcTRzT3VLcGV1bmpDRHNrN2dnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLNjdhQTdLQ1Y3WmlWN0p5OA0KNjZHY0lPeU5xT3lWdkNEc2dxenNtcW5zbnBEcXNJQWc3SmEwNjVha0lPcTRzT3VLcGV5ZGhDRHNrN2dnN0lpWUlPeVhodXVLbE95bmdDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3WldnSU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnMEtMU0RzaTZEcnRvVHNwcDBnN1ptVjdKMjQ2NUNZNnJpd0lPeWdoT3E1ak95bmdDRHNocUhxdUlqcXM3d2c2ckt3N0tDYzY2VzhJTzJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlFJT3lFb08yRG5leWRtQ0Rxc3JEcXM3enJwYndnN0pXSTY0SzA3WldnSU91VmpBMEtEUXJya0pqcmo0enJwclFnN0lpWUlPeVhodXVLbENEc2hLRHRnNTNzbllBZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU91cWhlMlpsZTJWbU9xeWpDRHNsWXpyb0tUc21wUXVEUW9OQ3V5WWlDa05DaTBnN1pXY0lPdXkNCmlDRHJzSlRxdnJqcnFiUWc3THFRN0l1YzY3Q3g3SjJBSU91THBPeUxuQ0Ryc0p2c25ZUWc3SWlZSU95WGh1eVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla0NEc2xZanNpNndnS091MmdPeWdsZTJZbFNrTkNnMEtKK3lnbGV1enRDRHNpSmpzcDVFZzdKV0k2NEswSnlEcms3SHNuWmdnNjYrODZyQ1E3WldjSU95RGdlMlpxZXlYa095RW5DQXFLdXlnbGV1enRPcXdnQ0RyczdUdG1ManJrSnpyaTZUcmlwUWc3S0NRS2lyc25ZUWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPeVZqT3VncENEc2dxenNtcW5zbnBEcnBid2c3SldJN0l1czdaV1k2cktNSU8yVm9DRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRcnNtSWdwRFFvdElPeURnZXVMdE95ZHRDRHJnWjNyZ3BqcnFiUWc3S0NFNjZ5NDZyQ0E2NCtFSU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHJwYndnNjdPOElPeUltQ0RzbDRic2xyVHNtcFF1RFFvdElPMlpqZXE0dU91UG1ldUxtT3lkbUNEc29KWHJzN1Rxc0lBZzZyaXc2NkdkNjVDWTdLZUFJT3lWDQppdXlWaE95YWxDNE5DZzBLSXlNZzdKaUk3Sm00SURRdUlPeWduTzJTaUNEc21xbnNsclRyaXBRZzY3Q1U2cjY0N0tlQUlPeVZpdXE0c0EwS0RRb242ckNFNnJLdzdaV1k2ck9nSU95SnJPeWF0Q0RycDVBbklPeWJrT3k1bWV1enRPdUxwQ0FxS3UyWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhlcXp2T3lkbUNEc21xbnNsclFnN0oyODdMbVlLaXJxc0lBZzdKcXc3SVNnN0oyMDdKZVE3SnFVTGcwSzZyaXc2NHFsNjZxRjdKZVFJT3lUc095ZHVDRHJpNmpzbHJRbzY3T0E2cks5TENEc3A0RHNvSlVzSU91VHNldWhuU0RyazdFcDY2VzhJT3lWaU91Q3RDRHJyTGpxdGF6c2w1RHNoSndnNjR1azY2VzRJT3Vua091aG5DRHJzSlRxdnJqcnFiUWc3SUtzN0pxcDdKNlE2ckNBSU91THBPdWx1Q0RxdUxEcmlxWHNuTHpyb1p3ZzdKaWs3WlcwN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tnSitxMmpPMlZuQ0RyczREcXNyMG5JT3E0c091S3BleWRtQ0RzbFlqcmdyUWc2Nnk0NnJXcw0KRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3Q1U2citBSU95SW1DRHNub2pzbHJUc21wUWdLRmdwRFFvdElPdUxwT3VsdUNEc2dxenJub3pzbllRZzY2ZUk3SXFrN1lTd0lPcTBnT3Vtck95ZWtPdWhuQ0RzcDREc29KWHRsWmpycWJRZzY3T0E2cks5N1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFnS0U4cERRb05DaU1qSU95WWlPeVp1Q0ExTGlEc2k1enNpcVR0aFp3ZzY0K1o3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXdnN0pPdzdLZUFJT3lWaXVxNHNBMEtEUXJyckxqcXRhenJwYndnN0pXRTY2eTA2NmFzSU91bnBPdUJoT3VmdmVxeWpDRHJpNlRyazZ6c2xyVHJqNFFnS2lyc2k2VHNvSndnN0l1YzdJcWs3WVdjSU91UG1leWVrZXF6dkNEcmk2VHJwYmdnNjQrWjdJS3NLaXJycGJ3ZzdKT3c2Nm0wSU95ZW1PdXF1K3VRbkNEcnJManF0YXpzbUlqc21wUXVEUW9OQ3V5WWlDa2c2NmVJN0lxazdZU3dJT3EwZ091bXJPeWUNCmtPdWx2Q0FuN0xhVTZyQ0FJT3luZ095Z2xTZnRsWmpyaXBRZzdJdWM3SXFrN1lXYzdKZVE3SVNjSUNqc25iVHNvSVRDdCt5V2tldVBoQ0RxdUxEcmlxWHNuYlFnN0pXRTY0dVlLUTBLTFNEcmk2VHJwYmdnN0lLczY1Nk03SmVRNnJLTUlPdW5pT3lLcE8yRXNDRHF0SURycHF6c25wRHJwYndnNjRTWTZyS283S084N0lTNDdKcVVJQ2hZSU9LQWxDRHNsNGJyaXBRZ0ordUVtT3E0c09xNHNDY2c2cml3NjRxbDdKMkVJT3lWbE95TG5Da05DaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVnRDRHNvN3pzaExqc21wUWdLRThwRFFvPQ0KOjpMQVVOQ0hFUjo6DQovLzRuQUNBQVF3QnNBR0VBZFFCa0FHVUFJQUJDQUhJQWFRQmtBR2NBWlFBZ0FHd0FZUUIxQUc0QVl3Qm9BR1VBY2dBZ0FCUWdJQURvc3NTc3hMd2dBQ1RCRmNnZ0FCRElnS3dnQU1UV0lBRGtzcXk1SUFEa3dvblZDZ0FuQUNBQVl3QnNBR0VBZFFCa0FHVUFZZ0J5QUdrQVpBQm5BR1VBT2dBdkFDOEFJQUFFMVZ5NG9ORmN6M1RISUFCMHh5QUFETk44eDBUSElBQ0F2WGk1NUxJZ0FDZ0E4YlJkdURvQUlBQnVBSEFBYlFBZ0FHa0FiZ0J6QUhRQVlRQnNBR3dBSUFBUXRwU3lJQUFpQUhUUVhMamN0Q0FBNU00bHNURFJJZ0FnQUNUQldNNGdBQXpUZk1jcEFDNEFDZ0FuQUNBQVZMc0FyQ0FBWUw0NHlDQUFpTWM4eDNTNklBQmMxU0FBaUx6UXhTQUFXTldZc0NuRklBQkl4YlN3V05YZ3JDd0FJQURrc2lBQUFNbEV2aGkwZExvZ0FPU3lyTGw4dVNBQVBjd2dBTWJGZE1jZ0FPVENpZFZjMWVTeUxnQUtBRk1BWlFCMEFDQUFaZ0J6QUc4QUlBQTlBQ0FBUXdCeUFHVUFZUUIwQUdVQVR3QmlBR29BWlFCakFIUUFLQUFpQUZNQQ0KWXdCeUFHa0FjQUIwQUdrQWJnQm5BQzRBUmdCcEFHd0FaUUJUQUhrQWN3QjBBR1VBYlFCUEFHSUFhZ0JsQUdNQWRBQWlBQ2tBQ2dCVEFHVUFkQUFnQUhNQWFBQWdBRDBBSUFCREFISUFaUUJoQUhRQVpRQlBBR0lBYWdCbEFHTUFkQUFvQUNJQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZNQWFBQmxBR3dBYkFBaUFDa0FDZ0JrQUdrQWNnQWdBRDBBSUFCbUFITUFid0F1QUVjQVpRQjBBRkFBWVFCeUFHVUFiZ0IwQUVZQWJ3QnNBR1FBWlFCeUFFNEFZUUJ0QUdVQUtBQlhBRk1BWXdCeUFHa0FjQUIwQUM0QVV3QmpBSElBYVFCd0FIUUFSZ0IxQUd3QWJBQk9BR0VBYlFCbEFDa0FDZ0J6QUdnQUxnQkRBSFVBY2dCeUFHVUFiZ0IwQUVRQWFRQnlBR1VBWXdCMEFHOEFjZ0I1QUNBQVBRQWdBR1FBYVFCeUFBb0FDZ0FuQUNBQU1RQXZBRElBS1FBZ0FFNEFid0JrQUdVQUxnQnFBSE1BSUFBUXlJQ3NJQUFVSUNBQXhzVTh4M1M2SUFEa3NyVEdYTGpjdENBQW1OTjB4OERKZkxrZ0FQVEZ0TVVBeWVTeUNnQkpBR1lBSUFCekFHZ0ENCkxnQlNBSFVBYmdBb0FDSUFZd0J0QUdRQUlBQXZBR01BSUFCM0FHZ0FaUUJ5QUdVQUlBQnVBRzhBWkFCbEFDSUFMQUFnQURBQUxBQWdBRlFBY2dCMUFHVUFLUUFnQUR3QVBnQWdBREFBSUFCVUFHZ0FaUUJ1QUFvQUlBQWdBRWtBWmdBZ0FFMEFjd0JuQUVJQWJ3QjRBQ2dBSWdCT0FHOEFaQUJsQUM0QWFnQnpBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpNEFJZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQjJBR0lBUXdCeUFFd0FaZ0FnQUNZQUlBQmZBQW9BSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJZ0JiQUZYV2VNZGRBRVRISUFBRXNuUzVkTG9nQU9TeXRNWmN1TnkwSUFDWTAzVEh3TWtBckNBQTlNVzl1Y2l5NUxJdUFDQUFKTUZZem55NUlBREl1VnpPSUFDa3RDd0FJQUFNMWV5MytLMTR4OURGSE1FZ0FIVFFYTGpjdENBQWhMeTgwa1RISUFEa3N0ekNJQUFNc3V5M0lBRDh5RGpCbE1ZdUFDSUFMQUFnQUY4QUNnQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBDQpJQUIyQUdJQVR3QkxBRU1BWVFCdUFHTUFaUUJzQUNBQUt3QWdBSFlBWWdCRkFIZ0FZd0JzQUdFQWJRQmhBSFFBYVFCdkFHNEFMQUFnQUNJQWROQmN1TnkwSUFEa3NxeTVJQUFrd1JYSUlBQW9BREVBTHdBeUFDa0FJQUFVSUNBQVRnQnZBR1FBWlFBdUFHb0Fjd0FpQUNrQUlBQTlBQ0FBZGdCaUFFOEFTd0FnQUZRQWFBQmxBRzRBQ2dBZ0FDQUFJQUFnQUhNQWFBQXVBRklBZFFCdUFDQUFJZ0JvQUhRQWRBQndBSE1BT2dBdkFDOEFiZ0J2QUdRQVpRQnFBSE1BTGdCdkFISUFad0F2QUdzQWJ3QXZBR1FBYndCM0FHNEFiQUJ2QUdFQVpBQWlBQW9BSUFBZ0FFVUFiZ0JrQUNBQVNRQm1BQW9BSUFBZ0FGY0FVd0JqQUhJQWFRQndBSFFBTGdCUkFIVUFhUUIwQUFvQVJRQnVBR1FBSUFCSkFHWUFDZ0FLQUNjQUlBQXlBQzhBTWdBcEFDQUFRd0JzQUdFQWRRQmtBR1VBSUFCREFHOEFaQUJsQUNBQUVNaUFyQ0FBRkNBZ0FNYkZQTWQwdWlBQUpNRll6cmNBWExqNHJYakhJQUFwdkpXOFJNY2dBRWpGdExCYzFlU3lDZ0JKQUdZQQ0KSUFCekFHZ0FMZ0JTQUhVQWJnQW9BQ0lBWXdCdEFHUUFJQUF2QUdNQUlBQjNBR2dBWlFCeUFHVUFJQUJqQUd3QVlRQjFBR1FBWlFBaUFDd0FJQUF3QUN3QUlBQlVBSElBZFFCbEFDa0FJQUE4QUQ0QUlBQXdBQ0FBVkFCb0FHVUFiZ0FLQUNBQUlBQk5BSE1BWndCQ0FHOEFlQUFnQUNJQVF3QnNBR0VBZFFCa0FHVUFJQUJEQUc4QVpBQmxBQUNzSUFBa3dWak8vTE1nQUlqSHdNa2dBRXJGUk1XVXhpQUFLQUFRdHBTeUlBQlFBRUVBVkFCSUFOREZJQURHeGJURmxNWXBBQzRBSWdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUIyQUdJQVF3QnlBRXdBWmdBZ0FDWUFJQUJmQUFvQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlnQXcwZmk3RUxIUXhSekJJQUJFeFppM2ZMa2dBQ1RCV002M0FGeTQrSzE0eDF6VklBQ2t0Q3dBSUFCMDBGeTQzTFFnQUlTOHZOSkV4eUFBNUxMY3dpQUFETExzdHlBQS9NZzR3WlRHT2dBaUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUFKZ0FnQUhZQVlnQkRBSElBVEFCbUFDQUENCkpnQWdBRjhBQ2dBZ0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBaUFDQUFJQUJ1QUhBQWJRQWdBR2tBYmdCekFIUUFZUUJzQUd3QUlBQXRBR2NBSUFCQUFHRUFiZ0IwQUdnQWNnQnZBSEFBYVFCakFDMEFZUUJwQUM4QVl3QnNBR0VBZFFCa0FHVUFMUUJqQUc4QVpBQmxBQ0lBSUFBbUFDQUFkZ0JpQUVNQWNnQk1BR1lBSUFBbUFDQUFYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUlBQWdBR01BYkFCaEFIVUFaQUJsQUNBQWJBQnZBR2NBYVFCdUFDSUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQWRnQmlBRU1BY2dCTUFHWUFJQUFtQUNBQVh3QUtBQ0FBSUFBZ0FDQUFJQUFnQUNBQUlBQWdBQ0lBVmRaNHh5QUFLYnlWdkRvQUlBQXcwZmk3RUxIUXhSekJJQUJqQUd3QVlRQjFBR1FBWlFBZ0FDMEFMUUIyQUdVQWNnQnpBR2tBYndCdUFDQUFkTWNnQUlTOEJNaEV4eUFBbk0wbHVGalZkTG9nQUFESlJMNGdBRVRHekxpRng4aXk1TEl1QUNJQUlBQW1BQ0FBZGdCaUFFTUFjZ0JNQUdZQUlBQW1BQ0FBDQpYd0FLQUNBQUlBQWdBQ0FBSUFBZ0FDQUFJQUFnQUNJQUtBQ3N3S25HeWJkQXh5QUFkTWNnQUZBQVF3RFF4U0FBWExqNHJYakhITFFnQUhUUVhMamN0Q0FBYkszRnN5QUFYTlhFczlERkhNRWdBQ2pNRUt3cHRNaXk1TEl1QUNrQUlnQXNBQ0FBWHdBS0FDQUFJQUFnQUNBQUlBQWdBQ0FBSUFBZ0FIWUFZZ0JGQUhnQVl3QnNBR0VBYlFCaEFIUUFhUUJ2QUc0QUxBQWdBQ0lBZE5CY3VOeTBJQURrc3F5NUlBQWt3UlhJSUFBb0FESUFMd0F5QUNrQUlBQVVJQ0FBUXdCc0FHRUFkUUJrQUdVQUlBQkRBRzhBWkFCbEFDSUFDZ0FnQUNBQVZ3QlRBR01BY2dCcEFIQUFkQUF1QUZFQWRRQnBBSFFBQ2dCRkFHNEFaQUFnQUVrQVpnQUtBQW9BSndBZ0FBREpSTDRnQUVUR3pMZ2dBQlFnSUFEa3NxeTVmTGtnQUQzTUlBREd4WFRISUFEa3dvblZJQUFvQUF6VjdMZjRyWGpIZE1jZ0FPZXNJQUNReDlteklBQVFyTURKS1FBS0FITUFhQUF1QUZJQWRRQnVBQ0FBSWdCakFHMEFaQUFnQUM4QVl3QWdBRzRBYndCa0FHVUFJQUJ6QUdNQQ0KY2dCcEFIQUFkQUJ6QUZ3QVl3QnNBR0VBZFFCa0FHVUFMUUJpQUhJQWFRQmtBR2NBWlFBdUFHb0Fjd0FpQUN3QUlBQXdBQ3dBSUFCR0FHRUFiQUJ6QUdVQUNnQT0NCjo6V0FUQ0hFUjo6DQpMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rxc0pEc2k1enNucEFnNG9DVUlPMlZyZXlEZ1NEcmxxQWc3SjZJNjRxVUlPeTBpT3lHak8yWWxTRHNoSnpyc29RZ0tHeHZZMkZzYUc5emREb3hNVGc0T1NrTkNpOHZJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0EwS0x5OGc3Sm1jSU8yVmhPeWFsTzJWbk9xd2dEb2c3WlM4NnJlNDY2ZUk2ckNBSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JqYkdGMVpHVmljbWxrWjJVNkx5OGc3SmUwNnJpd0tIZHBibVJ2ZHk1dmNHVnVMMmxtY21GdFpTOXZjR1Z1UlhoMFpYSnVZV3dwNjZXOA0KRFFvdkx5RHNvSVRydG9BZzdJYU02NmFzSU95WGh1eWR0Q0RycDRucmlwUWc2N0tFN0tDRTdKMjBJT3llaU91THBDNGdabVYwWTJqcmlwUWc2NnE3SU91bmlleWN2T3V2Z091aG5Dd2c3WlNNNjUrczZyZTQ3SjI0N0oyMElPeWR0Q0Rxc0pEc2k1enNucERzbDVEcXNvd05DaTh2SUZCUFUxUWdMM2RoYTJVZzY2VzhJT3V6dE91Q3RPdXB0Q0Rxc0pEc2k1enNucERxc0lBZzY0dWs2NmFzS0dOc1lYVmtaUzFpY21sa1oyVXVhbk1wNjZXOElPdU1nT3lMb0NEc3ZLRHJpNlF1RFFvdkx3MEtMeThnNjR1azY2YXM3Sm1BN0oyWUlPeXdxT3lkdERvZzZyQ1E3SXVjN0o2UTY0cVVJR05zWVhWa1pldWx2Q0Ryckx6c3A0QWc3SldLNjRxVTY0dWtLT3lla095TG5TRHNsNGJzbll3cElPS0draUR0Z2JUcm9aenJrNXdnN0pXeElPeVhoZXVOc095ZHRPMkt1T3VsdkNEc2xZZ2c2NmVKNnJPZ0xBMEtMeThnNjZtVTY2cW82NmFzSUg0eE5VMUM2NTI4SU91aG5PcTN1T3lkdUNEc2k1d2c3SjZRNjQrWklPeUxuT3lla2V5Y3ZPdWgNCm5DRHNnNEhzaTV3ZzdMeWM2NUdzNjQrRUlPdTJnT3VMdENEc2w0YnJpNlFnS091VHNldWhuVG9nYm5CdElISjFiaUJpZFdsc1pDa3VEUW92THlEcmk2VHJwcXpyaXBRZzdJdXM3SjZsNjdDVjY0K1pJT3VCaXVxNHNPdXB0Q0Rzbzczc3A0RHJwNHdvN1pTTTY1K3M2cmU0N0oyNDZyTzhJT3lEbmV5Q3JDRHJqNW5xdUxEdG1aUXBMQ0Rxc0pEc2k1enNucERyaXBRZzZyT0U3SWFOSU91Q3FPeVZoQ0RyaTZUc25Zd2c2cm1vN0pxdzZyaXc2Nlc4SU91d20rdUtsT3VMcEM0TkNnMEtZMjl1YzNRZ2FIUjBjQ0E5SUhKbGNYVnBjbVVvSjJoMGRIQW5LVHNOQ21OdmJuTjBJSEJoZEdnZ1BTQnlaWEYxYVhKbEtDZHdZWFJvSnlrN0RRcGpiMjV6ZENCbWN5QTlJSEpsY1hWcGNtVW9KMlp6SnlrN0RRcGpiMjV6ZENCdmN5QTlJSEpsY1hWcGNtVW9KMjl6SnlrN0RRcGpiMjV6ZENCN0lITndZWGR1TENCemNHRjNibE41Ym1NZ2ZTQTlJSEpsY1hWcGNtVW9KMk5vYVd4a1gzQnliMk5sYzNNbktUc05DZzBLWTI5dWMzUWdVRTlTDQpWQ0E5SURFeE9EZzVPdzBLWTI5dWMzUWdVazlQVkNBOUlIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljcE95QXZMeURzb0lEc25xWHNob3dnNjZPbzdZcTRJT0tBbENEcmk2VHJwcXpxc0lBZ2NtVmpiMjF0Wlc1a0xXVjRZVzF3YkdWekxtMWs2Nlc4SU95d3Z1dUtsQ0RxdUxEc3BJQU5DZzBLWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3MEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0U0dWaFpHVnljeWM2SUNkRGIyNTBaVzUwTFZSNWNHVW5MQTBLZlRzTkNtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXcwS0lDQnlaWE11ZDNKcGRHVklaV0ZrS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MA0KWlc1MExWUjVjR1VuT2lBbllYQndiR2xqWVhScGIyNHZhbk52YmpzZ1kyaGhjbk5sZEQxMWRHWXRPQ2NnZlN3Z1EwOVNVMTlJUlVGRVJWSlRLU2s3RFFvZ0lISmxjeTVsYm1Rb1NsTlBUaTV6ZEhKcGJtZHBabmtvYjJKcUtTazdEUXA5RFFvTkNpOHZJR05zWVhWa1pTQkRURW5xc0lBZzdKNkk2NHFVN0tlQUlPS0FsQ0RzbDRic25MenJxYlFnTDNkaGEyVWc3SjJSNjR1MTdKZVFJT3lMcE95V3RDRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzdKV0k2NEswN1pXZ0lPeUltQ0Rzbm9qcXNvd2c3WldjNjR1a0RRb3ZMeURyb1p6cXQ3anNuYmpya0p3ZzZyT0U3S0NWSU95ZHZlcTRzQ0RpZ0pRZ1EweEo2ckNBSUg0dkxtTnNZWFZrWlM1cWMyOXU3SmVRSU9xNHNPdWhuZTJWbU91S2xDQnZZWFYwYUVGalkyOTFiblF1WlcxaGFXeEJaR1J5WlhOeklDanJpNlRycHF6c25aZ2dZMnhoZFdSbFFXTmpiM1Z1ZE95WmdDRHFzSm5zbllBZzdMYWM3TEtZS1M0TkNpOHZJTzJNak95ZHZPeWR0Q0R0Z2JRZzdJaVlJT3llaU95V3RDQXoNCk1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLTHk4ZzdMcVE3SXVjSURYc3RJZ2c0b0NVSU91aG5PcTN1T3lkdUNEc3A0SHRtNFFnN0lPSUlPcXpoT3lnbGV5ZHRDRHFzNmZyc0pUcm9ad2c3SjZoN1ppQTdKVzhJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKZVE3SVNjSU8yWmlPeWN2T3VobkNEcmhKanNsclRxc0lUcmk2UW9NekRzdElqcnFiUWc2NFNJNjZ5MElPdUtwdXlkakNrTkNteGxkQ0JoWTJOdmRXNTBRMkZqYUdVZ1BTQjdJR0YwT2lBd0xDQmxiV0ZwYkRvZ2JuVnNiQ0I5T3cwS0x5OGc3SXVrN0tDY0lPdWhuT3EzdU95ZHVDRHNsNnpydG9EcmlwUWc3SjZRNnJLcDdLYWQ2NnFGSU8yTWpPeWR2T3VobkNEdGpKRHJpNmp0bFp6cmk2UWc0b0NVSUg0dkxtTnNZWFZrWlM1cWMyOXU3SjJZSUc5aGRYUm9RV05qDQpiM1Z1ZE91S2xDQXFLdXVobk9xM3VPeVZoT3liZysyVnRPdVBoQ0RyZ3FqcmlwVHJpNlFxS2cwS0x5OGdLT3lMcE95NG9Ub2dZMnhoZFdSbElHRjFkR2dnYzNSaGRIVno2NHFVSUd4dloyZGxaRWx1T21aaGJITmw3SjI0NjQyd0lPcTN1Q0R0bFlUcms1enJpcFFnNnJlNDY0eUE2NkdjSU9LR2tpRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY2R2M2cmU0N0oyNDY1Q2NJT3F5Zyt5eW1PdWZ2Q0R0a1p6c2k1enRsb2pyaTZRcExnMEtMeThnN1l5TTdKMjg2NmVNSU95ZHZleWN2T3V2Z091aG5DRHJ1WVRzbXFrZ01DNGdZMnhoZFdSbElHRjFkR2dnYzNSaGRIVno2ckNBSU95Z2xlMlpsZTJWbU95bmdPdW5qQ0R0bElUcm9aenNoTGpzaXFUcnBid2c2NTJFN0p1TTdKVzhJTzJWdE95RW5DRHNvYkR0bW96cnA0anJpNlFnN0pPdzZyaXc3SmVVSU91c3RPcXlnZXVMcEM0TkNtWjFibU4wYVc5dUlHaGhjME5zWVhWa1pVTnlaV1JsYm5ScFlXeHpLQ2tnZXcwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHWWdQU0J3WVhSbw0KTG1wdmFXNG9iM011YUc5dFpXUnBjaWdwTENBbkxtTnNZWFZrWlNjc0lDY3VZM0psWkdWdWRHbGhiSE11YW5OdmJpY3BPdzBLSUNBZ0lHTnZibk4wSUdvZ1BTQktVMDlPTG5CaGNuTmxLR1p6TG5KbFlXUkdhV3hsVTNsdVl5aG1MQ0FuZFhSbU9DY3BLVHNOQ2lBZ0lDQnBaaUFvYWlBbUppQnFMbU5zWVhWa1pVRnBUMkYxZEdnZ0ppWWdhaTVqYkdGMVpHVkJhVTloZFhSb0xtRmpZMlZ6YzFSdmEyVnVLU0J5WlhSMWNtNGdkSEoxWlRzTkNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3WXlNN0oyOElPeVhodXlkak1LMzY2cTdJT3lkdmV5ZGpDRGlnSlFnNjZlbDdKMjA2Nm0wSU8yQ3BPeXl0T3lkdU95ZGhDRHJwNGpzb0lBZzY3TzQ2NHVrSUNvdklIME5DaUFnTHk4Z0tpcnJwNlhzbllBZzdKNlE2cktwN0thZDY2cUY3SjJFSU8yTWpPeWR2T3lkdENEc2xZVHJpNGpybmJ3ZzdZS2s3TEswN0oyNDdKZVFJT3VFbyt1S2xPdUxwQ29xSUNneU1ESTJMVEE0SU95THBPeTRvU3dnNjR1azY2YXNJSFkwTVNBdklPcXcNCmtPeUxuT3lla0NCMk5pa3VEUW9nSUM4dklPdW5wZXlkbUNCRGJHRjFaR1VnUTI5a1pldUtsQ0IrTHk1amJHRjFaR1V2TG1OeVpXUmxiblJwWVd4ekxtcHpiMjdzbllRZzdKV0U3SmlJSU91bmpPdVRwT3luZ0NEc2xZcnFzNkFnN1lLazdMSzA3SjI0SU8yVnJldXFxUTBLSUNBdkx5QW5RMnhoZFdSbElFTnZaR1V0WTNKbFpHVnVkR2xoYkhNbjdKZVFJT3lnZ095ZXBlMlZuT3VMcENEaWhwSWc3WXlNN0oyODY2ZU1JT3V6dE91cHRDRHJxWURzcWFIdG5vZ2c2NkdjNnJlNDdKMjQ2NUNjSU91bnBleWR0Q0RyaXBnZ0ordWhuT3EzdU95ZHVDRHNsWWdnNjVDb0oreWR0Q0Rya0pqcXM2QXNEUW9nSUM4dklPdWhuT3EzdU95ZHVDRHJqSURxdUxBZzdabVU2Nm0wN0oyMElPeVlnZXlZZ1NEcmo0anJpNlFvNjRpTTY1K3M2NCtFSUVOTVNlcXdnQ0FpN0oyMDY2KzRJT3Vobk9xM3VPeWR1T3VRcUNMc25MenJvWndnN0thSjdJdWNJT3VCbmV1Q21DRHJ1SXpybmJ6c21yRHNvSURzb2JEc3NLZ2c3SldJSU95WHRPdW1zT3VMDQpwQ2t1RFFvZ0lDOHZJQ29xN0tHMDdKNnM2NmVNSU8yWmxleWR1TzJWbk91THBDZ3RkeURzbDRic25Zd3BLaW9nNG9DVUlPdTVoT3V3Z091eWlPMll1Q0Rxc0pMc25ZUWc3SjI5N0p5ODY2bTBJTzJDcE95eXRPeWR1Q0Rzb0pIcXQ3d2c3WmVJN0pxcElPMk1uZXlYaGV5ZHRDRHJuTEFnN0lpWUlPeWVpT3VMcEM0ZzdKVzlJRE13YlhNdURRb2dJQzh2SUVOQ1gwNVBYMHRGV1VOSVFVbE9QVEhzbmJUcnFiUWc3WXlNN0oyODY2ZU1JT3V6dU91THBDQW82NnFvN0oyWUlPMlppT3ljdk91aG5DQW42NkdjNnJlNDdKMjRJT3lYaHV5ZGpDZnNuWVFnN0o2czdaaUU3WldZNjRxVUlPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZS2s3TEswN0oyNDdKMkFJRWhQVFVYc25ZUWc3SldJSU91VXNPdWx1T3VMcENrdURRb2dJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUNFOVBTQW5aR0Z5ZDJsdUp5QjhmQ0J3Y205alpYTnpMbVZ1ZGk1RFFsOU9UMTlMUlZsRFNFRkpUaUE5UFQwZ0p6RW5LU0J5WlhSMWNtNGdabUZzYzJVNw0KRFFvZ0lIUnllU0I3RFFvZ0lDQWdZMjl1YzNRZ2NpQTlJSE53WVhkdVUzbHVZeWduYzJWamRYSnBkSGtuTENCYkoyWnBibVF0WjJWdVpYSnBZeTF3WVhOemQyOXlaQ2NzSUNjdGN5Y3NJQ2REYkdGMVpHVWdRMjlrWlMxamNtVmtaVzUwYVdGc2N5ZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZEdsdFpXOTFkRG9nTXpBd01DQjlLVHNOQ2lBZ0lDQnlaWFIxY200Z2NpNXpkR0YwZFhNZ1BUMDlJREE3RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUhKbGRIVnliaUJtWVd4elpUc2dmU0F2THlCelpXTjFjbWwwZWV1bHZDRHJxcnNnNjdhQTY2YUVJRDBnNjZHYzZyZTQ3SjI0SU95VmlDRHJrS2pzbkx6cm9ad2c2N080NjR1a0RRcDlEUXBtZFc1amRHbHZiaUJqYkdGMVpHVkJZMk52ZFc1MEtDa2dldzBLSUNCcFppQW9SR0YwWlM1dWIzY29LU0F0SUdGalkyOTFiblJEWVdOb1pTNWhkQ0E4SURVd01EQXBJSEpsZEhWeWJpQmhZMk52ZFc1MFEyRmphR1V1WlcxaGFXdzdEUW9nSUd4bGRDQmxiV0ZwYkNBOUlHNTENCmJHdzdEUW9nSUhSeWVTQjdEUW9nSUNBZ2FXWWdLR2hoYzBOc1lYVmtaVU55WldSbGJuUnBZV3h6S0NrcElIc2dMeThnN0o2UTZyS3A3S2FkNjZxRjdKMjBJT3lYaHV5Y3ZPdXB0Q0RyZ3Fqc25ZQWc3SjIwNjZtVTdKMjg3SjJBSU91c3RPeUxuTzJWbk91THBBMEtJQ0FnSUNBZ1kyOXVjM1FnYWlBOUlFcFRUMDR1Y0dGeWMyVW9abk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaHZjeTVvYjIxbFpHbHlLQ2tzSUNjdVkyeGhkV1JsTG1wemIyNG5LU3dnSjNWMFpqZ25LU2s3RFFvZ0lDQWdJQ0JsYldGcGJDQTlJQ2hxSUNZbUlHb3ViMkYxZEdoQlkyTnZkVzUwSUNZbUlHb3ViMkYxZEdoQlkyTnZkVzUwTG1WdFlXbHNRV1JrY21WemN5a2dmSHdnYm5Wc2JEc05DaUFnSUNCOURRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lDOHFJT3Vobk9xM3VPeWR1Q0RzbmJUcm9LVWc3SmVHN0oyTUlPdVRzU0RpZ0pRZ2JuVnNiQ0FxTHlCOURRb2dJR0ZqWTI5MWJuUkRZV05vWlNBOUlIc2dZWFE2SUVSaGRHVXVibTkzDQpLQ2tzSUdWdFlXbHNJSDA3RFFvZ0lISmxkSFZ5YmlCbGJXRnBiRHNOQ24wTkNnMEtablZ1WTNScGIyNGdhR0Z6UTJ4aGRXUmxLQ2tnZXcwS0lDQmpiMjV6ZENCbWFXNWtaWElnUFNCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbklEOGdKM2RvWlhKbEp5QTZJQ2QzYUdsamFDYzdEUW9nSUhSeWVTQjdJSEpsZEhWeWJpQnpjR0YzYmxONWJtTW9abWx1WkdWeUxDQmJKMk5zWVhWa1pTZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnYzJobGJHdzZJSFJ5ZFdVZ2ZTa3VjM1JoZEhWeklEMDlQU0F3T3lCOUlHTmhkR05vSUNoZlpTa2dleUJ5WlhSMWNtNGdabUZzYzJVN0lIME5DbjBOQ2cwS2JHVjBJSGRoYTJsdVp5QTlJR1poYkhObE95QXZMeURzbDdEdGc0QWc2N0NwN0tlQUlPS0FsQ0RyaTZUcnBxenJpcFFnN0phMDdMQ283WlM4SUVWQlJFUlNTVTVWVTBYcm9ad2c3S1NSNjdPMUlPeWdsZXVtck8yVm1PeW5nT3VuakNEdGxJVHJvWnpzaExqc2lxUWc2NEt0NjdtRTY2VzhJT3lraE95ZA0KdU91THBBMEtablZ1WTNScGIyNGdkMkZyWlVKeWFXUm5aU2dwSUhzTkNpQWdhV1lnS0hkaGEybHVaeWtnY21WMGRYSnVPdzBLSUNCM1lXdHBibWNnUFNCMGNuVmxPdzBLSUNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhzZ2QyRnJhVzVuSUQwZ1ptRnNjMlU3SUgwc0lEVXdNREFwT3cwS0lDQnNaWFFnY0hKdll6c05DaUFnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNOQ2lBZ0lDQXZMeUJYYVc1a2IzZHpPaUJqYldUQ3QzWmljeURxc3Izc25LQWc3SmVHN0oyMElHNXZaR1hycGJ3ZzdLZUI3S0NSTENCM2FXNWtiM2R6U0dsa1pTaERVa1ZCVkVWZlRrOWZWMGxPUkU5WEtldWhuQ0RzaXFUdGo3QWc0b0NVRFFvZ0lDQWdMeThnN0xDOUlPeVhodXVLbENEc2lLanNuWUFnN0wyWTdJYVU3SjIwSU91bmpPdVRwT3lXdE95bmdPcXpvQ0RyaTZUcnBxenNuWmdnN0o2UTdJdWRLR05zWVhWa1pTbnJqNFFnNnJlNElPeTltT3lHbE95ZGhDRHJyTHpyb0tUcnNKdnNsWVFnN0phMDY1YWsNCklPeXd2ZXVQaENEc2xZZ2c2NXlzNjR1a0xnMEtJQ0FnSUM4dklHUmxkR0ZqYUdWazY0cVVJT3lUc095bmdDRHNsWXJyaXBUcmk2UW9aR1YwWVdOb1pXUXJkMmx1Wkc5M2MwaHBaR1VnN0tHdzdaV3A3SjJBSU95OW1PeUdsQ0Rzc0wzc25iUWc2NFc0N0xhYzY1Q29JT0tBbENEc2k2VHN1S0VwTGcwS0lDQWdJQzh2SUZkcGJtUnZkM1BzbDVEc2hLQWdaR1YwWVdOb1pXUWc3SmVHN0oyMDY0K0VJT3UyZ091cXFDanFzSkRzaTV6c25wQXA2ckNBSU95anZleVd0T3VQaENEc25wRHNpNTNzbllBZzdJSzA3SldFNjRLbzY0cVU2NHVrTGcwS0lDQWdJSEJ5YjJNZ1BTQnpjR0YzYmlod2NtOWpaWE56TG1WNFpXTlFZWFJvTENCYmNHRjBhQzVxYjJsdUtGOWZaR2x5Ym1GdFpTd2dKMk5zWVhWa1pTMWljbWxrWjJVdWFuTW5LVjBzSUhzTkNpQWdJQ0FnSUdOM1pEb2dVazlQVkN3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlN3TkNpQWdJQ0I5S1RzTkNpQWdmU0JsYkhObElIc05DaUFnDQpJQ0F2THlCdFlXTlBVeS9ycHF6cmlJWHNpcVE2SU9xd2tPeUxuT3lla091bHZDRHJuWVRzbXJRZ2JtOWtaU0RzaTZUdGxva2c3WXlNN0oyODY2R2NJT3luZ2V5Z2tTRHNpcVR0ajdBZ0tHeGhkVzVqYUdRZzdabVk2cks5N0plVUlGQkJWRWpxc0lBZzY3bUk3Slc5N1pXZ0lPeUltQ0Rzbm9qc2xyUWc3S0NJNjR5QTZySzk2NkdjSU95Q3JPeWFxU2tOQ2lBZ0lDQndjbTlqSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3RFFvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUdSbGRHRmphR1ZrT2lCMGNuVmxMQ0J6ZEdScGJ6b2dKMmxuYm05eVpTY3NEUW9nSUNBZ2ZTazdEUW9nSUgwTkNpQWdjSEp2WXk1MWJuSmxaaWdwT3lBdkx5RHFzSkRzaTV6c25wQWc3SjIwNjdLazdZcTRJT3VqcU8yVWhPeVhrT3lFbkNEcnRvVHJwcXdnS09xd2tPeUxuT3lla0NEc29vWHJvNHpycGJ3ZzY2ZUo3S2VBSU95Vg0KaXVxeWpDa05DbjBOQ2cwS0x5OGc3SjIwSUZCRDY2VzhJQ2ZzaEtUc3VaZ2c3S0NFS095RGlDQlFReWtuSU95RGdlMkRuT3VobkNEcmtKanJqNHpycHJEcmk2UWc0b0NVSU8yVWpPdWZyT3EzdU95ZHVDQmI3TFNJNnJpdzdabVVYU0Ryc29UdGlyd29VRTlUVkNBdmRXNXBibk4wWVd4c0tleWR0Q0RydG9EcnBianJpNlF1RFFvdkx5QnlaV2RwYzNSbGNpMXdjbTkwYjJOdmJDNXFjK3F3Z0NEc2hLVHN1Wmp0bFp3ZzZyS0Q3SjJFSU9xM3VPdU1nT3VobkNEcmtKanJqNHpycHJEcmk2UTZJT3F3a095TG5PeWVrQ0RzbnBEcmo1bnNpNXpzbnBFZ0t5QW83SjZJN0p5ODY2bTBLU0RzaEtUc3VaZ2c3WSswNjQyVUxnMEtMeThnNHBxZzc3aVBJT3V3bU91VG5PeUxuQ0JJVkZSUUlPeWRrZXVMdGV5ZGhDRHJxTHpzb0lBZzY3TzA2NEs0SU91U3BDRHRtTGpzdHB6dGxhQWc2cktESU9LQWxDQnRZV05QVXlCc1lYVnVZMmhqZEd3Z1ltOXZkRzkxZE95ZHRDRHNuYlFnN1pTRTY2R2M3SVM0N0lxazY2VzhJT3ltaWV5TG5DRHMNCm9vWHJvNHpzaTV6dGdxd2c3SWlZSU95ZWlPdUxwQzROQ2k4dklDQWdJT3EzdU91ZW1PeUVuQ0R0akl6c25id29jR3hwYzNUQ3QreUVwT3k1bUNEdGo3VHJqWlFwN0oyRUlHeGhkVzVqYUdOMGJPdXp0T3VMcENEcnFMenNvSUFnN0tlQTdKcTA2NHVrSU9LQWxDQmliMjkwYjNWMDdKMjBJT3lhc091bXJPdWx2Q0Rzbzczc2w2enJqNFFnN0o2UTY0K1o3SXVjN0o2UjdKMkFJT3lkdE91dnVDRHNncXpybmJ6c3A0VHJpNlF1RFFwbWRXNWpkR2x2YmlCMWJtbHVjM1JoYkd4VFpXeG1LQ2tnZXcwS0lDQmpiMjV6ZENCeVpXMXZkbVZrSUQwZ1cxMDdEUW9nSUhSeWVTQjdEUW9nSUNBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNka1lYSjNhVzRuS1NCN0RRb2dJQ0FnSUNCamIyNXpkQ0JNUVVKRlRDQTlJQ2RqYjIwdVkyeGhkV1JsWW5KcFpHZGxMbmRoZEdOb1pYSW5PdzBLSUNBZ0lDQWdZMjl1YzNRZ2NHeHBjM1FnUFNCd1lYUm9MbXB2YVc0b2IzTXVhRzl0WldScGNpZ3BMQ0FuVEdsaWNtRnllU2NzDQpJQ2RNWVhWdVkyaEJaMlZ1ZEhNbkxDQk1RVUpGVENBcklDY3VjR3hwYzNRbktUc05DaUFnSUNBZ0lHTnZibk4wSUdsdWMzUWdQU0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5UR2xpY21GeWVTY3NJQ2RCY0hCc2FXTmhkR2x2YmlCVGRYQndiM0owSnl3Z0owTnNZWFZrWlVKeWFXUm5aU2NwT3cwS0lDQWdJQ0FnZEhKNUlIc2dhV1lnS0daekxtVjRhWE4wYzFONWJtTW9jR3hwYzNRcEtTQjdJR1p6TG5WdWJHbHVhMU41Ym1Nb2NHeHBjM1FwT3lCeVpXMXZkbVZrTG5CMWMyZ29jR3hwYzNRcE95QjlJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUNBZ2RISjVJSHNnYVdZZ0tHWnpMbVY0YVhOMGMxTjVibU1vYVc1emRDa3BJSHNnWm5NdWNtMVRlVzVqS0dsdWMzUXNJSHNnY21WamRYSnphWFpsT2lCMGNuVmxMQ0JtYjNKalpUb2dkSEoxWlNCOUtUc2djbVZ0YjNabFpDNXdkWE5vS0dsdWMzUXBPeUI5SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1ag0KS0Nkc1lYVnVZMmhqZEd3bkxDQmJKMkp2YjNSdmRYUW5MQ0FuWjNWcEx5Y2dLeUJ3Y205alpYTnpMbWRsZEhWcFpDZ3BJQ3NnSnk4bklDc2dURUZDUlV4ZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNnZlNCallYUmphQ0FvWDJVcElIdDlEUW9nSUNBZ0lDQjBjbmtnZXlCemNHRjNibE41Ym1Nb0oyeGhkVzVqYUdOMGJDY3NJRnNuY21WdGIzWmxKeXdnVEVGQ1JVeGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdmU0JsYkhObElHbG1JQ2h3Y205alpYTnpMbkJzWVhSbWIzSnRJRDA5UFNBbmQybHVNekluS1NCN0RRb2dJQ0FnSUNCMGNua2dleUJ6Y0dGM2JsTjVibU1vSjNKbFp5Y3NJRnNuWkdWc1pYUmxKeXdnSjBoTFExVmNYRk52Wm5SM1lYSmxYRnhOYVdOeWIzTnZablJjWEZkcGJtUnZkM05jWEVOMWNuSmxiblJXWlhKemFXOXVYRnhTZFc0bkxDQW5MM1luTENBblEyeGhkV1JsUW5KcFpHZGxWMkYwWTJobGNpY3NJQ2N2WmlkZExDQjcNCklITjBaR2x2T2lBbmFXZHViM0psSnlCOUtUc2djbVZ0YjNabFpDNXdkWE5vS0Nmc25wRHJqNW5zaTV6c25wRW9RMnhoZFdSbFFuSnBaR2RsVjJGMFkyaGxjaWtuS1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdJQ0IwY25rZ2V5QnpjR0YzYmxONWJtTW9KM0psWnljc0lGc25aR1ZzWlhSbEp5d2dKMGhMUTFWY1hGTnZablIzWVhKbFhGeERiR0Z6YzJWelhGeGpiR0YxWkdWaWNtbGtaMlVuTENBbkwyWW5YU3dnZXlCemRHUnBiem9nSjJsbmJtOXlaU2NnZlNrN0lISmxiVzkyWldRdWNIVnphQ2duWTJ4aGRXUmxZbkpwWkdkbE9pOHZJT3VUc2V1aG5TY3BPeUI5SUdOaGRHTm9JQ2hmWlNrZ2UzME5DaUFnSUNBZ0lIUnllU0I3RFFvZ0lDQWdJQ0FnSUdOdmJuTjBJR2x1YzNRZ1BTQndZWFJvTG1wdmFXNG9jSEp2WTJWemN5NWxibll1VEU5RFFVeEJVRkJFUVZSQklIeDhJSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDZEJjSEJFWVhSaEp5d2dKMHh2WTJGc0p5a3NJQ2REYkdGMVpHVkNjbWxrDQpaMlVuS1RzTkNpQWdJQ0FnSUNBZ2FXWWdLR1p6TG1WNGFYTjBjMU41Ym1Nb2FXNXpkQ2twSUhzZ1puTXVjbTFUZVc1aktHbHVjM1FzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsTENCbWIzSmpaVG9nZEhKMVpTQjlLVHNnY21WdGIzWmxaQzV3ZFhOb0tHbHVjM1FwT3lCOURRb2dJQ0FnSUNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQjlEUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSUdaaGFXd3RjMjltZENEaWdKUWc2NnE3SU95bmdPeWF0Q0Rxc293ZzdKNkk3SmEwNjQrRUlPMlVqT3Vmck9xM3VPeWR1Q0RzcXIwZzZyaXc3SmExSU95Q3JleWduT3VLbENEc25iVHJyN2dnNjRHZDY0S3M2NHVrSUNvdklIME5DaUFnY21WMGRYSnVJSEpsYlc5MlpXUTdEUXA5RFFvTkNpOHZJT3F3a095TG5PeWVrQ0RzbnBEc2k2RHNuWVFnN0lPSUlPeTlsT3VUbk91aG5DRHJpNlRzaTV3ZzY1MkU3SnEwNjR1a0lPS0FsQ0JRVDFOVUlDOXlaWE4wWVhKMElPcXdnQ0RydG9EcnBianJpNlF1RFFvdkx5RHNtWndnN1pXRQ0KN0pxVTdaV2M2ckNBS0RJd01qWXRNRGdnN0l1azdMaWhLVG9nN0lTazdMbVk2N080SU8yTWpPeWR2T3lkdENEc2c0anFzb1BzbmJUc2xyVHJqNFFnS2lyc21LVHJucGdnNjVhZ0lPeWVpT3VObUNEcXNKRHNpNXpzbnBEcXNJQWc3SmliSU95OWxPdVRuT3lkbUNEcmk2VHJwcXpycGJ3ZzZyT0U3SWFOSU95OG5PdUtsQ29xRFFvdkx5RHNnNEh0ZzV6cXNJQWc3SjZJN0plSTY0dWtLTzJNak95ZHZDQjJOREVnTHlEc3ZKenNwNERyaXBRZzY0dWs2NmFzSUhZeU1pa3VJT3lkdE91ZnJPdXB0Q0R0bEl6cm42enF0N2pzbmJqc25iUWdXK3lYaGV1TnNPeWR0TzJLdUNEdGxZVHNtcFJkNjZHY0lPdUxwT3Vtck91bHZDRHF1NURyaTZRZzdMeWM2NCtFRFFvdkx5RHN2SndnN0tPODY0cVVJT3lxdmV5ZHRDRHF0N2pyaklEcm9aenJuYndnN0ppQjdKdVE3WjZJSU95WW15RHJzb1Rzb0lUc25iVHFzNkFzSU95ZXJPeUxuT3lla2V1bmlPdUxwQ0RzbTR6cnNJM3NsNFVvNnJXczY0K0ZJT3lDck95YXFldWZpU25ycDR3ZzY0S1kNCjZyQ1U2NHVrTGcwS0x5OGc2cmU0NjU2WTdJU2NJQ0xyaTZUcnBxenJwNHdnNnJ1UTY0dWtJT3k4bk9xNHNDTHJvWndnN0pXSUlPMlNnT3Vtck91cHRDRHN2SndnN0tPODY0cVVJT3F3a095TG5PeWVrT3UyZ08yRXNDRHNnNGpyb1p3ZzY1MkU3SnEwNjR1a0xpRHFzSkRzaTV6c25wRHJpcFFnWTJ4aGRXUmw2Nlc4SU95VmlDRHJyTHpzbHJRZzY3bUU3SnFwSURBdURRb3ZMeURzaUp6c2hKd2c3S084N0oyWU9pRHNnNGdnN0oyNDdJcWs3WVMwN0lxazZyQ0FJT3Vvdk95Z2dDRHJuS2pycWJRZzdZK3M3WXE0NjZXOElPdXF1eURzbnFIcmlwVHJqYkFzSU95VmhPdWVtQ0JzYVhOMFpXNGc3SjZzN0l1YzY0K0U2ckNBSU95YXNPdW1yT3F3Z0NEcnVhRHNwNGdnNjVXTTZybU03S2VBSU9xNHNPdUxwT3VncENEc3BJRHJpNlF1RFFwbWRXNWpkR2x2YmlCeVpYTjBZWEowVTJWc1ppZ3BJSHNOQ2lBZ2RISjVJSHNOQ2lBZ0lDQnBaaUFvY0hKdlkyVnpjeTV3YkdGMFptOXliU0E5UFQwZ0ozZHBiak15SnlrZ2V3MEtJQ0FnDQpJQ0FnWTI5dWMzUWdkbUp6SUQwZ2NHRjBhQzVxYjJsdUtGSlBUMVFzSUNkamJHRjFaR1V0ZDJGMFkyaGxjaTF6YVd4bGJuUXVkbUp6SnlrN0RRb2dJQ0FnSUNCcFppQW9abk11WlhocGMzUnpVM2x1WXloMlluTXBLU0I3RFFvZ0lDQWdJQ0FnSUdOdmJuTjBJSEFnUFNCemNHRjNiaWduZDNOamNtbHdkQzVsZUdVbkxDQmJkbUp6WFN3Z2V5QmtaWFJoWTJobFpEb2dkSEoxWlN3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc05DaUFnSUNBZ0lDQWdjQzUxYm5KbFppZ3BPdzBLSUNBZ0lDQWdmU0JsYkhObElIc05DaUFnSUNBZ0lDQWdMeThnZG1KejZyQ0FJT3lYaHV5Y3ZPdXB0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTRGlnSlFnN0xDOUlPeVZpQ0RybktqcXNvd2c3WldZNjRxVUlPcTNuT3k1bWV5ZGdDRHJpNlRycHF3ZzdJcWs3WSt3NnJPOElPcXdtZXVMcENoM2FXNWtiM2R6U0dsa1pTd2daR1YwWVdOb1pXUWc2cmlJN0tlQUtRMEtJQ0FnSUNBZ0lDQmpiMjV6ZENCdw0KSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzE5ZlptbHNaVzVoYldWZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5d2dkMmx1Wkc5M2MwaHBaR1U2SUhSeWRXVWdmU2s3RFFvZ0lDQWdJQ0FnSUhBdWRXNXlaV1lvS1RzTkNpQWdJQ0FnSUgwTkNpQWdJQ0FnSUhKbGRIVnlianNOQ2lBZ0lDQjlEUW9nSUNBZ0x5OGdiV0ZqVDFNNklHeGhkVzVqYUdUcXNJQWc3SnF3NjZhczY2VzhJT3EwZ091bXJPMlZuT3VMcENEaWdKUWdhMmxqYTNOMFlYSjBJQzFyNnJDQUlPcTdrT3VMcENEc3ZKd2c3S1NBNjR1a0tPeWFzT3Vtck91bHZDRHNvNzNzbmJUcnI0RHJvWndnN0pXRTY1NllJR1Y0YVhUcXVZenNwNEFnN0pXSUlPeVlyQ0RzaUpqcmo0UWc3SjZJNjR1a0tRMEtJQ0FnSUdOdmJuTjBJSFZwWkNBOUlIQnliMk5sYzNNdVoyVjBkV2xrS0NrN0RRb2dJQ0FnWTI5dWMzUWdjaUE5SUhOd1lYZHVVM2x1WXlnbmJHRjFibU5vWTNSc0p5d2dXeWRyYVdOcmMzUmhjblFuTENBbkxXc25MQ0FuWjNWcEx5Y2cNCkt5QjFhV1FnS3lBbkwyTnZiUzVqYkdGMVpHVmljbWxrWjJVdWQyRjBZMmhsY2lkZExDQjdJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNOQ2lBZ0lDQnBaaUFvY2k1emRHRjBkWE1nSVQwOUlEQXBJSHNOQ2lBZ0lDQWdJR052Ym5OMElIQWdQU0J6Y0dGM2JpaHdjbTlqWlhOekxtVjRaV05RWVhSb0xDQmJYMTltYVd4bGJtRnRaVjBzSUhzZ1pHVjBZV05vWldRNklIUnlkV1VzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzTkNpQWdJQ0FnSUhBdWRXNXlaV1lvS1RzTkNpQWdJQ0I5RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlHWmhhV3d0YzI5bWRDRGlnSlFnNjZxN0lPdWRoT3lib095Y3ZPdXB0Q0RyaTZUc25Zd2c2NkdjNnJlNDdKMjRJT3lla091UG1leUxuT3lla2V5ZHRDRHNnclRycHJEcmk2UWdLaThnZlEwS2ZRMEtEUW92THlEcmk2VHJwcXdvTVRFNE9EZ3A2ckNBSU91V29DRHNub2pzbkx6cnFiUWc2NEdJNjR1a0lPS0FsQ0RzdElqcXVMRHRtWlFnN0l1Y0lPdUNxT3lkZ0NEc2hManNoWmdnDQo3S0NWNjZhc0lDanNsNGJzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lMcE8yTXFDa05DbVoxYm1OMGFXOXVJSE5vZFhSa2IzZHVRbkpwWkdkbEtDa2dldzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUhJZ1BTQm9kSFJ3TG5KbGNYVmxjM1FvZXlCb2IzTjBPaUFuTVRJM0xqQXVNQzR4Snl3Z2NHOXlkRG9nTVRFNE9EZ3NJSEJoZEdnNklDY3ZjMmgxZEdSdmQyNG5MQ0J0WlhSb2IyUTZJQ2RRVDFOVUp5d2dkR2x0Wlc5MWREb2dNVFV3TUNCOUxDQW9LU0E5UGlCN2ZTazdEUW9nSUNBZ2NpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnbmRHbHRaVzkxZENjc0lDZ3BJRDArSUhzZ2RISjVJSHNnY2k1a1pYTjBjbTk1S0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlNCOUtUc05DaUFnSUNCeUxtVnVaQ2dwT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNuME5DZzBLWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9LSEpsY1N3Z2NtVnpLU0E5UGlCNw0KRFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5UMUJVU1U5T1V5Y3BJSHNnY21WekxuZHlhWFJsU0dWaFpDZ3lNRFFzSUVOUFVsTmZTRVZCUkVWU1V5azdJSEpsZEhWeWJpQnlaWE11Wlc1a0tDazdJSDBOQ2lBZ2FXWWdLSEpsY1M1MWNtd2dQVDA5SUNjdmFHVmhiSFJvSnlrZ2V3MEtJQ0FnSUM4dklIWTZJT3F3a095TG5PeWVrQ0RzdlpUcms1d2c2N0tFN0tDRUlPS0FsQ0RxdGF6cnNvVHNvSVFnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3F6aE95R2pTRHJqNHpxczZBZzdKNkk2NHFVN0tlQUlPdXdsdXlYa095RW5DRHRtWlhzbmJqdGxaanJpcFFnN0pxcDY0K0VEUW9nSUNBZ0x5OGdLSFl5SUQwZzdMQzlJT3lJcU9xNWdDRHNpSmpzb0pYdGpKQXNJSFl6SUQwZ0wyRmpZMjkxYm5RZzdMYVU2ckNBN1l5UUxDQjJOQ0E5SUM5MWJtbHVjM1JoYkd3ZzdMYVU2ckNBN1l5UUxBMEtJQ0FnSUM4dklDQjJOU0E5SU9xemhPeWdsZXlkaENEc25wRHFzcW5zcHAzcnFvVWc3SnlnNjZ5MDY2R2NJTzJNa095Z2xTRGkNCmdKUWc2NkdjNnJlNDdKV0U3SnVESU91U3BDRHJncWpzbllBZzdKMjA2Nm1VN0oyODdKMkVJT3Vobk9xM3VPeWR1T3ljdk91aG5DRHNtS1R0bGJUdGxaanNwNEFnN0pXSzZyS01MQTBLSUNBZ0lDOHZJQ0IyTmlBOUlPdW5wZXlkZ0NEc25wRHFzcW5zcHAzcnFvWHNuYlFnN1lLazdMSzA3SjI0N0plUUlPeWVpT3lXdENEdGpJenNuYndnNnJLQTdJS3M2NmVNN0p5ODY2R2M2NHFVSUNmcm9aenF0N2pzbmJnZzdKV0lJT3VRcUNmc25iUWc2NUNZNjQyWUlPcXlneURyaklEc25aRXNEUW9nSUNBZ0x5OGdJSFkzSUQwZ0wzSmxjM1JoY25RZzdMYVU2ckNBSUNzZzdZK3M3WXE0SU95ZXJPeUxuT3VQaENEaWdKUWc3SmliSU9xd2tPeUxuT3lla09xd2dDRHNtSnNnNjR1azY2YXM2Nlc4SU9xemhPeUdqU0Rzdkp6cmpaZ2c2cktESU91TWdPeWRrU2tOQ2lBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2QyRjBZMmhsY2pvZ2RISjFaU3dnZGpvZ055QjlLVHNOQ2lBZ2ZRMEtJQ0F2DQpMeURzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHFzNFRzb0pVZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNEc3Nxc2c3Wm1VNjZtMHdyZnRtWWpzbmJRZ0l1dUloT3ExckNEcXM0VHNvSlhzbkx6cm9ad2c3Sk93NjRxVTdLZUFJaURyczdUc2w2enNvN3pyaXBRZzY0MndJT3lUdE91THBDNE5DaUFnTHk4ZzZyQ1E3SXVjN0o2UTZyQ0FJT3VMdGUyVm1PdUtsQ0RzbmJUc25LQTZJT3VMcE91bXJPdWx2Q0Rzdkp6cnFiUWc3SnVNNjdDTjdKZUY3Snk4NjZHY0lPMkJ0T3Vobk91VG5PcXdnQ0RzaTZUc29Kd2c3Wmk0N0xhYzY0KzhJT3Exck91UGhTRHNncXpzbXFucm40bnNuYlFnNjRLWTZyQ0U2NHVrTGcwS0lDQXZMeURxc0pEc2k1enNucERyaXBRZzdZeU03SjI4NjZlTUlPeWR2ZXljdk91dmdPdWhuQ0RzZ3F6c21xbnJuNGtnTUNEQ3R5RHJqSURxdUxBZ01DRGlnSlFnNnJLQTdZYWc2NmVNSU95VHNPdUtsQ0RzZ3F6cm5venNsNURxc293ZzY3bUU3SnFwN0oyRUlPdXN2T3Vtck95bg0KZ0NEc2xZcnJpcFRyaTZRdURRb2dJQzh2SU95anZPeWRtRG9nN0plczZyaXdJT3F6aE95Z2xleWR0Q0RyczdUc2w2enJqNFFnN0o2RjdKNmw2cmFNN0oyMElPdW5qT3Vqak91UWtPeWRoQ0RzaUpnZzdKNkk2NHVrS095Y29PMmFxT3lFc2V5ZGdDRHNpNlRzb0p3ZzdaaTQ3TGFjSU91VmpPdW5qQ0RzbFl3ZzdJaVlJT3llaU95ZGpDRGlnSlFnNjR1azY2YXNJQzlvWldGc2RHanNuWmdnY0hKdllteGxiU0Rzc0xqcXM2QXBMZzBLSUNCcFppQW9jbVZ4TG5WeWJDQTlQVDBnSnk5aFkyTnZkVzUwSnlrZ2V3MEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0JoWTJOdmRXNTBPaUJqYkdGMVpHVkJZMk52ZFc1MEtDa3NJR05zWVhWa1pUb2dhR0Z6UTJ4aGRXUmxLQ2tnZlNrN0RRb2dJSDBOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDNkaGEyVW5LU0I3RFFvZ0lDQWdhV1lnS0NGb1lYTkRiR0YxWkdVb0tTa2cNCmNtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklHWmhiSE5sTENCd2NtOWliR1Z0T2lBblkyeGhkV1JsTFcxcGMzTnBibWNuSUgwcE93MEtJQ0FnSUhkaGEyVkNjbWxrWjJVb0tUc05DaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnZDJGcmFXNW5PaUIwY25WbElIMHBPdzBLSUNCOURRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVUU5VFZDY2dKaVlnY21WeExuVnliQ0E5UFQwZ0p5OXphSFYwWkc5M2JpY3BJSHNOQ2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbElIMHBPdzBLSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2NISnZZMlZ6Y3k1bGVHbDBLREFwTENBeU1EQXBPdzBLSUNBZ0lISmxkSFZ5YmpzTkNpQWdmUTBLSUNBdkx5RHFzSkRzaTV6c25wRHJwYndnN0lPSUlPeTlsT3VUbk91aG5DRHJpNlRzaTV3ZzY1MkU3SnEwNjR1a0lPS0FsQ0RyaTZUcnBxenJwYndnNnJ1UTY0dWtJT3k4bk91UGhDRHFzNFRzDQpobzBnN0ppYklPdXloT3lnaE95ZHRDRHN2SnpzcDRnZzY1V01LT3ljaENCeVpYTjBZWEowVTJWc1ppRHNvN3pzaEowcElPeVR0T3VMcEM0TkNpQWdMeThnN0oyUjY0dTE3SjJFSU91b3ZPeWdnQ0RyczdUcmdyZ2c2NUtrSU95RGlDRHNuYmpzaXFUdGhMVHNpcVRycGJ3ZzY1MkU3SnF3NnJPZ0lPeWFzT3Vtck91S2xDRHJ1YURzcDRUcmk2UWc0b0NVSU95RGlDRHNxcjNzbllBZzdZK3M3WXE0NnJDQUlPdTVqQ0RybFl6cXVZenNwNEFnN0o2czdJdWM2NCtFN1pXYzY0dWtMZzBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2Y21WemRHRnlkQ2NwSUhzTkNpQWdJQ0JxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J5WlhOMFlYSjBhVzVuT2lCMGNuVmxMQ0IyT2lBM0lIMHBPdzBLSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V3MEtJQ0FnSUNBZ2MyaDFkR1J2ZDI1Q2NtbGtaMlVvS1RzZ0x5OGc3SmliSU95OWxPdVRuT3VobkNEcg0KbHFBZzdKNkk2NHFVSU91THBPdW1yT3VQaENEcXNKbnNuYlFnNjRLMDY2YXc2NHVrSU9LQWxDRHJpNlRzbll3ZzdKcVU3TEt0SU91VmpDRHNnNGdnNnJDUTdJdWM3SjZRNnJDQUlPeURpQ0RzdlpUcms1enJvWndnN0x5ZzY0dWtEUW9nSUNBZ0lDQnlaWE4wWVhKMFUyVnNaaWdwT3cwS0lDQWdJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ3Y205alpYTnpMbVY0YVhRb01Da3NJRE13TUNrN0RRb2dJQ0FnZlN3Z01qQXdLVHNOQ2lBZ0lDQnlaWFIxY200N0RRb2dJSDBOQ2lBZ0x5OGc3TFNJNnJpdzdabVVJT0tBbENEc25iUWdVRVBycGJ3Z0oreURpQ0JRUXljZzdJT0I3WU9jNjZHY0lPdVFtT3VQak91bXNPdUxwQ0FvN1pTTTY1K3M2cmU0N0oyNElGdnN0SWpxdUxEdG1aUmRJT3V5aE8yS3ZDa3VEUW9nSUM4dklPeWRrZXVMdGV5ZGhDRHJxTHpzb0lBZzdaMlk2NkNrNjdPMDY0SzRJT3VTcENEc29KWHJwcXp0bFp6cmk2UWc0b0NVSUdKdmIzUnZkWFRzbmJRZzdKcXc2NmFzNjZXOElPeW1pZXlMbkNEc283M3MNCmw2enJqNFFnN1pxTTdJdWc3SjJBSU91UGhPeXdxZTJWbk91THBDNE5DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM1Z1YVc1emRHRnNiQ2NwSUhzTkNpQWdJQ0JxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J3YkdGMFptOXliVG9nY0hKdlkyVnpjeTV3YkdGMFptOXliU0I5S1RzTkNpQWdJQ0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSHNOQ2lBZ0lDQWdJSE5vZFhSa2IzZHVRbkpwWkdkbEtDazdEUW9nSUNBZ0lDQmpiMjV6ZENCeVpXMXZkbVZrSUQwZ2RXNXBibk4wWVd4c1UyVnNaaWdwT3cwS0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdDNZWFJqYUdWeVhTRHN0SWpxdUxEdG1aUW9kVzVwYm5OMFlXeHNLU0RpZ0pRZzdLQ2M2ckd3T2ljc0lISmxiVzkyWldRdWFtOXBiaWduTENBbktTQjhmQ0FuS095WGh1eWRqQ2tuS1RzTkNpQWdJQ0FnSUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBMQ0F5DQpNREFwT3cwS0lDQWdJSDBzSURJMU1DazdEUW9nSUNBZ2NtVjBkWEp1T3cwS0lDQjlEUW9nSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBMExDQjdJR1Z5Y205eU9pQW5UbTkwSUdadmRXNWtKeUI5S1RzTkNuMHBPdzBLRFFvdkx5RHRqNnp0aXJqcXNJQWc3SjZoN1ppQUlPeWVpT3ljdk91cHRDRHNucURxdVpBZzZyaXc2NHVrNjZDNDY0dWtJT3VMcE95TG5DRHNpNXpyajRUdGxaanFzNkFzSU9xM3VPdWVtT3VQaENEc2xZZ2c2NUNZNjZtMElPeWhzT3lhcWUyZWlDRHNvb1hybzR3TkNpOHZJQ2pzbnBEcmo1a2c3SXVjN0o2UklDc2dibkJ0SUdKMWFXeGtJT3lra2V1enRTRHNpNlR0bG9rZzY0eUE2N21FS1M0ZzdKNnM3SXVjNjQrRTZyQ0FJTzJWaE95YWxPMlZuQ0RzbmJUc25LQTZJQzl5WlhOMFlYSjA2NHFVSU95RGlDRHNuYmpzaXFUdGhMVHNpcVRycGJ3ZzY2aTg3S0NBSU91ZGhPeWFzT3F6b0EwS0x5OGc3SmliSU95ZHVPeUtwTzJFdE95S3BPcXdnQ0RydWFEc3A0RHJyNERyb1p3c0lPeXlxeURzaTV6cg0KajRUc2w1RHNoSndnNjZ5ODY1K3M2NEtZSU91eWhPdW1yT3VwdENEc2xZVHJyTFRyajRRZzdKV0lJT3VDcU91S2xPdUxwQzROQ214bGRDQmlhVzVrVkhKcFpYTWdQU0F3T3cwS2MyVnlkbVZ5TG05dUtDZGxjbkp2Y2ljc0lDaGxLU0E5UGlCN0RRb2dJR2xtSUNobElDWW1JR1V1WTI5a1pTQTlQVDBnSjBWQlJFUlNTVTVWVTBVbklDWW1JR0pwYm1SVWNtbGxjeUE4SURZcElIc05DaUFnSUNCaWFXNWtWSEpwWlhNckt6c05DaUFnSUNCelpYUlVhVzFsYjNWMEtDZ3BJRDArSUhObGNuWmxjaTVzYVhOMFpXNG9VRTlTVkN3Z0p6RXlOeTR3TGpBdU1TY3BMQ0F4TURBd0tUc05DaUFnSUNCeVpYUjFjbTQ3RFFvZ0lIME5DaUFnYVdZZ0tHVWdKaVlnWlM1amIyUmxJRDA5UFNBblJVRkVSRkpKVGxWVFJTY3BJSEJ5YjJObGMzTXVaWGhwZENnd0tUc05DaUFnY0hKdlkyVnpjeTVsZUdsMEtERXBPdzBLZlNrN0RRcHpaWEoyWlhJdWJHbHpkR1Z1S0ZCUFVsUXNJQ2N4TWpjdU1DNHdMakVuTENBb0tTQTlQaUI3RFFvZ0lHTnYNCmJuTnZiR1V1Ykc5bktDZGJkMkYwWTJobGNsMGc3WUcwNjZHYzY1T2NJT3VMcE91bXJDRHFzSkRzaTV6c25wQWc3THljN0tlUUlPS0FsQ0JvZEhSd09pOHZiRzlqWVd4b2IzTjBPaWNnS3lCUVQxSlVLVHNOQ24wcE93MEtMeThnU1ZCMk5pRHJvNmp0bElUcnNMRW9Pam94S2V5WGtPdVBoQ0R0bGFqcXU1Z2c2NU9qNjRxVTY0dWtJT0tBbENBbmJHOWpZV3hvYjNOMEorcXdnQ0E2T2pIcm9ad2c2Nmk4N0tDQUlPMlZ0T3lFbmV1UW1PdUtsQ0R0bVpqcXNyM3NsNURzaEp3TkNpOHZJTzJVdk9xM3VPdW5pQ0JtWlhSamFPcXdnQ0JKVUhZMDY2R2NJTzJQdE91d3NlMlZtT3luZ0NEc2xZcnNsWVFnNjR1azY2YXNJT3E1cU95YXNPcTRzTUszNnJPRTdLQ1ZJT3loc08yYWpPcXdnQ0Rzb2JEc21xbnRub2dnN0l1azdZeW83WldZNjQyWUlPdXN1T3lnbkNEcmpJRHNuWkVvNjR1azY2YXM3Sm1BSU91UG1leWR2Q2t1RFFwamIyNXpkQ0J6WlhKMlpYSTJJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvYzJWeWRtVnlMbXhwDQpjM1JsYm1WeWN5Z25jbVZ4ZFdWemRDY3BXekJkS1RzTkNpOHZJRG82TWV5ZGhDRHJxcnNnN0o2aDdKV0U2NCtFS0VWQlJFUlNTVTVWVTBYQ3QwbFFkallnN0plRzdKMk1LU0JKVUhZMDY2ZU03Snk4NjZHY0lPcXpoT3lHalNEcmo1bnNucEVnNG9DVUlPdUxwT3VuakNBdmNtVnpkR0Z5ZENEc3A0SHRtNFRzbDVRZzdKaWJJT3lkdU95S3BPMkV0T3lLcE9xd2dBMEtMeThnN0pXRTdLZUJJRG82TWV5ZGhDRHJyTHpxczZBZzdKNkk3SmEwSU95eXF5RHNpNXpyajRUcXNJQWc3SXVrN1l5bzdaV2M2NHVrTGlBbmJHOWpZV3hvYjNOMEorcXdnQ0E2T2pIcm9ad2c2Nmk4N0tDQUlPMlNnT3Vtck91S2xDRHRtWmpxc3Izc2w1RHNoSndnNnJlNDY0eUE2NkdjSU91UmtPdXB0QTBLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJyNERyb1p3Z1NWQjJOT3laZ0NEcXNKbnNuWUFnN1pxZjdJaVk2NmVNN1lHOElPeWVyT3lMbk91UGhPMlZuT3VMcEM0TkNteGxkQ0JpYVc1aw0KVkhKcFpYTTJJRDBnTURzTkNuTmxjblpsY2pZdWIyNG9KMlZ5Y205eUp5d2dLR1VwSUQwK0lIc05DaUFnYVdZZ0tHVWdKaVlnWlM1amIyUmxJRDA5UFNBblJVRkVSRkpKVGxWVFJTY2dKaVlnWW1sdVpGUnlhV1Z6TmlBOElEWXBJSHNOQ2lBZ0lDQmlhVzVrVkhKcFpYTTJLeXM3RFFvZ0lDQWdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQnpaWEoyWlhJMkxteHBjM1JsYmloUVQxSlVMQ0FuT2pveEp5a3NJREV3TURBcE93MEtJQ0I5RFFwOUtUc05Dbk5sY25abGNqWXViR2x6ZEdWdUtGQlBVbFFzSUNjNk9qRW5LVHNOQ2c9PQ0KOjpXU0lMRU5UOjoNCkp5QkRiR0YxWkdVZ1FuSnBaR2RsSUhkaGRHTm9aWElnYzJsc1pXNTBJR3hoZFc1amFHVnlJQ2h1YnlCM2FXNWtiM2NwSUMwZ2NtVm5hWE4wWlhKbFpDQjBieUJ5ZFc0Z1lYUWdiRzluYVc0S1UyVjBJR1p6YnlBOUlFTnlaV0YwWlU5aWFtVmpkQ2dpVTJOeWFYQjBhVzVuTGtacGJHVlRlWE4wWlcxUFltcGxZM1FpS1FwVFpYUWdjMmdnUFNCRGNtVmhkR1ZQWW1wbFkzUW9JbGRUWTNKcGNIUXVVMmhsYkd3aUtRcGthWElnUFNCbWMyOHVSMlYwVUdGeVpXNTBSbTlzWkdWeVRtRnRaU2hYVTJOeWFYQjBMbE5qY21sd2RFWjFiR3hPWVcxbEtRcHphQzVEZFhKeVpXNTBSR2x5WldOMGIzSjVJRDBnWkdseUNuTm9MbEoxYmlBaVkyMWtJQzlqSUc1dlpHVWdjMk55YVhCMGMxeGljbWxrWjJVdGQyRjBZMmhsY2k1cWN5SXNJREFzSUVaaGJITmxDZz09DQo6OkVORDo6DQo=";
// ===== INSTALLER:END =====
// 맥용 설치 파일 — 같은 자기완결형(.command)을 zip으로 감싼 것 (zip이 실행 권한을 보존한다).
// ===== INSTALLER_MAC:BEGIN — 자동 생성 영역. 직접 수정 금지 (build-glossary.js가 클로드-커넥터.command를 zip(+x 보존)으로 주입) =====
const INSTALLER_MAC_ZIP_B64 = "UEsDBBQAAAgAAAAAAAB1ZAVJh7sCAIe7AgAbAAAA7YG066Gc65OcLey7pOuEpe2EsC5jb21tYW5kIyEvYmluL2Jhc2gKIyBTMSBVWCBXcml0aW5nIC0g7YG066Gc65OcIOy7pOuEpe2EsCBvbmUtc2hvdCBpbnN0YWxsZXIgZm9yIG1hY09TIChnZW5lcmF0ZWQgYnkgbnBtIHJ1biBidWlsZCAtIGRvIG5vdCBlZGl0KQojIOyLpO2WiTog67Cb7J2AIO2MjOydvOydhCDsmrDtgbTrpq0g4oaSIFvsl7TquLBdICjsspjsnYwg7Je066m0ICLtmZXsnbjrkJjsp4Ag7JWK7J2AIOqwnOuwnOyekCIg6rK96rOgIOKAlCBHYXRla2VlcGVyIOuVjOusuCkuCiMg7ISk7LmYwrfsoJDqsoDsnbQg64Gd64KY66m0IO2EsOuvuOuEkOydgCDsiqTsiqTroZwg64ur7Z6I6rOgLCBjbGF1ZGUg7ISk7LmYwrfroZzqt7jsnbgg7JWI64K064qUIO2UvOq3uOuniCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukLgpCNjRfQlJJREdFPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ2hEYkdGMVpHVWdRbkpwWkdkbEtTRGlnSlFnN1pTODZyZTQ2NmVJSU8yVWpPdWZyT3EzdU95ZHVPcXp2Q0JEYkdGMVpHVWdRMjlrWmV1bHZDRHNub2ZyaXBRZzY2R2M3THVzSU95THJPdTJnT3VtaE9xK3ZBMEtMeThnNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQURRb3ZMeURzZ3F6c21xbnJzcFU2SU8yUGlleURnZXlMbk95WGxDRHFzSkRzaTV6c25wRHFzSUFnN0o2UTY0K1o3Snk4NjZHY0lPeThvT3VMcENBbzdJaVk2NCtaSU95TG5PeWVrZXlkZ0NCdWNHMGdjblZ1SUdKeWFXUm5aU2tOQ2k4dklPeThuT3VSa091cHRDRHRsSXpybjZ6cXQ3anNuYmpzblpnZ1creTJsT3l5bk91d20rcTRzRjNxc0lBZ1IyVnRhVzVwSU8yQ3BDRHNsNGJzbmJUcmo0UWc3WUcwNjZHYzY1T2M2NkdjSUVGSklPeTJsT3l5bk95ZGhDRHJzSnZyaXBUcmk2UXVEUW92THcwS0x5OGc3SWFONjQrRUlPeUVwT3F6aERvZzdZRzA2NkdjNjVPYzY2VzhJT3lhbE95eXJldW5pT3VMcENEc2c0anJvWndnN0l1YzY0K1o3WldZNjZtMElETXdmalF3N0xTSTZyQ0FJT3EzdU91RHBTRHJncURzbFlUcXNJVHJpNlF1RFFvdkx5RGlocElnNjR1azY2YXM2Nlc4SU95OHBDRHJsWXdnN1lHMDY2R2M2NU9jSU95RXVPeUZtT3lkaENEdGxaanJncGdnN0plMDdKYTBJT3lEZ2V5TG5DRHJqSURxdUxEc2k1enRncVRxczZBb2MzUnlaV0Z0TFdwemIyNGc2NHlBN1ptVUlPdXFxT3VUbkNrc0RRb3ZMeUFnSU9xd2dPeWR0T3VUbkN2c21JanNpNXdvTVRFeDZyRzBLZXVLbENEc3Nxc2c2Nm1VN0l1YzdLZUE2NkdjSU8yVm5DRHJzb2pycDR3ZzdKMjk3WjZNNjR1a0xpRHNuYlR0bTRRZzdKcVU3TEt0N0oyQUlPdXN1T3Exck91bmpDRHJzN1RyZ3JUcnI0RHJvWndnNjdtZzY2VzA2NHVrTGcwS0x5OGc3SVM0N0lXWTdKMkFJRE13NjdLSUlPeVRzT3VwdENEc25xenNpNXpzbnBIdGxiUWc2NHlBN1ptVTZyQ0FJT3VzdE8yVm5PMmVpQ0RxdUxqc2xyVHNwNERyaXBRZzZyS0Q3SjJFSU91bmlldUtsT3VMcEM0TkNpOHZEUW92THlEc29JVHNvSnc2SU95ZHRDQlFRK3lYa0NCRGJHRjFaR1VnUTI5a1plcXdnQ0RzaEtUc3VaakN0K3Vobk9xM3VPeWR1T3VQdkNEc25vanNuWVFnNnJLRElDaGpiR0YxWkdVZ0xTMTJaWEp6YVc5dUlPeWN2T3VobkNEdG1aWHNuYmdwRFFvdkx5RHNvN3pzblpnNklPeUNyT3lhcWV1ZmlleWRnQ0Rxc0lIc25wQWc3WUcwNjZHYzY1T2NJT3Exck91UGhTRHRsWnpyajRUc2w1RHNoSndnN0xDbzZyQ1E2NUNjNjR1a0xnMEtEUXBqYjI1emRDQm9kSFJ3SUQwZ2NtVnhkV2x5WlNnbmFIUjBjQ2NwT3cwS1kyOXVjM1FnWm5NZ1BTQnlaWEYxYVhKbEtDZG1jeWNwT3cwS1kyOXVjM1FnYjNNZ1BTQnlaWEYxYVhKbEtDZHZjeWNwT3cwS1kyOXVjM1FnY0dGMGFDQTlJSEpsY1hWcGNtVW9KM0JoZEdnbktUc05DbU52Ym5OMElIc2djM0JoZDI0c0lITndZWGR1VTNsdVl5QjlJRDBnY21WeGRXbHlaU2duWTJocGJHUmZjSEp2WTJWemN5Y3BPdzBLRFFvdkx5RHRnYlRyb1p6cms1enJwYndnNjdtSUlPMlB0T3VObE95WGtPeUVuQ0RzaTZUdGxva2c0b0NVSU95Z2dPeWVwZXlHak95WGtPeUVuQ0RzaTZUdGxvbnRsWmpycWJRZzdaU0U2NkdjN0tDZDdZcTRJT3VucGV1ZHZTaERURUZWUkVVdWJXUWc2NU94S2V5ZGhBMEtMeThnNjZla0lPMkV0Q0RzcDRyc2xyVHNvTGpzaEp3Z05EWHN0SWd2N1lTMDZybU03S2VBSU91S2tPdWdwT3luaE91THBDQW82N21JSU8yUHRPdU5sQ0FySU91MmdPcXdnT3E0c091S3BTRHNzS2pyaTZqc25iVHJxYlFnZmpQc3RJZ3Y3WVMwS1M0TkNtTnZibk4wSUVWTlVGUlpYME5YUkNBOUlIQmhkR2d1YW05cGJpaHZjeTUwYlhCa2FYSW9LU3dnSjJOc1lYVmtaUzFpY21sa1oyVXRZM2RrSnlrN0RRcDBjbmtnZXlCbWN5NXRhMlJwY2xONWJtTW9SVTFRVkZsZlExZEVMQ0I3SUhKbFkzVnljMmwyWlRvZ2RISjFaU0I5S1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHNnTHlvZzY2eTA3SXVjSUNvdklIME5DbU52Ym5OMElFTk1RVlZFUlY5RlRsWWdQU0JQWW1wbFkzUXVZWE56YVdkdUtIdDlMQ0J3Y205alpYTnpMbVZ1ZGl3Z2V3MEtJQ0JOUVZoZlZFaEpUa3RKVGtkZlZFOUxSVTVUT2lBbk1DY3NJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0F2THlEc2c1M3FzSUVnNjZxbzY1T2NJT3VCbENBbzdLZW43SjJBSU91c3VPcTFyT3lYbENEcnRvanRsWVRzbXBRcERRb2dJRU5NUVZWRVJWOURUMFJGWDBSSlUwRkNURVZmVGs5T1JWTlRSVTVVU1VGTVgxUlNRVVpHU1VNNklDY3hKeXdnTHk4ZzdZUzBJT3lhbE95VnZTRHJrN0VnNjdhQTZyQ0FJTzJZdU95Mm5DRHJnWlFOQ2lBZ1JFbFRRVUpNUlY5VVJVeEZUVVZVVWxrNklDY3hKeXdOQ24wcE93MEtEUW92THlEc2lLanF1WUFnN0l1azdaYUpLT3F3a095TG5PeWVrQ0RzaXFUdGo3RHNuWUFnYzNSa2FXOGdhV2R1YjNKbEtleVhrT3lFbk91UGhDRHJyTGpzb0p6cnBid2c3TGFVN0tDQjdaV2dJT3lJbUNEc25vanFzb3dnN0wyWTdJYVVJT3Vobk9xM3VPdWx2Q0R0akl6c25ienNsNURyajRRZzY0S282cmkwNjR1a0xnMEtMeThnN0p5RTdMbVlPaURzbm9Uc2k1d2c3WSswNjQyVTdKMllJR05zWVhWa1pTMWljbWxrWjJVdWJHOW5JQ2pzbklqcmo0VHNtckFnSlZSRlRWQWxMQ0RycDZVZ0pGUk5VRVJKVWlrdUlESk5RaURyaEpqc25MenJxYlFnTG05c1pPdWhuQ0R0bFp3ZzdJUzQ2NHlBNjZlTUlPdXp0T3EwZ0M0TkNtTnZibk4wSUV4UFIxOUdTVXhGSUQwZ2NHRjBhQzVxYjJsdUtHOXpMblJ0Y0dScGNpZ3BMQ0FuWTJ4aGRXUmxMV0p5YVdSblpTNXNiMmNuS1RzTkNtTnZibk4wSUY5dmNtbG5URzluSUQwZ1kyOXVjMjlzWlM1c2IyY3VZbWx1WkNoamIyNXpiMnhsS1RzTkNtTnZibk52YkdVdWJHOW5JRDBnWm5WdVkzUnBiMjRnS0NrZ2V3MEtJQ0JqYjI1emRDQmhjbWR6SUQwZ1FYSnlZWGt1Y0hKdmRHOTBlWEJsTG5Oc2FXTmxMbU5oYkd3b1lYSm5kVzFsYm5SektUc05DaUFnWDI5eWFXZE1iMmN1WVhCd2JIa29iblZzYkN3Z1lYSm5jeWs3RFFvZ0lIUnllU0I3RFFvZ0lDQWdkSEo1SUhzTkNpQWdJQ0FnSUdsbUlDaG1jeTVsZUdsemRITlRlVzVqS0V4UFIxOUdTVXhGS1NBbUppQm1jeTV6ZEdGMFUzbHVZeWhNVDBkZlJrbE1SU2t1YzJsNlpTQStJRElnS2lBeE1ESTBJQ29nTVRBeU5Da2dabk11Y21WdVlXMWxVM2x1WXloTVQwZGZSa2xNUlN3Z1RFOUhYMFpKVEVVZ0t5QW5MbTlzWkNjcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSU8yYWpPeWdoQ0RzaTZUdGpLanJpcFFnNjZ5MDdJdWNJQ292SUgwTkNpQWdJQ0JqYjI1emRDQnNhVzVsSUQwZ0oxc25JQ3NnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZOMGNtbHVaeWduYTI4dFMxSW5LU0FySUNkZElDY2dLdzBLSUNBZ0lDQWdZWEpuY3k1dFlYQW9LR0VwSUQwK0lDaDBlWEJsYjJZZ1lTQTlQVDBnSjNOMGNtbHVaeWNnUHlCaElEb2dTbE5QVGk1emRISnBibWRwWm5rb1lTa3BLUzVxYjJsdUtDY2dKeWtnS3lBblhHNG5PdzBLSUNBZ0lHWnpMbUZ3Y0dWdVpFWnBiR1ZUZVc1aktFeFBSMTlHU1V4RkxDQnNhVzVsS1RzTkNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3WXlNN0oyOElPdWhuT3EzdUNEc2k2VHRqS2p0bGJUcmo0UWc2NHVrNjZhczY0cVVJT3F6aE95R2pTQXFMeUI5RFFwOU93MEtEUXBqYjI1emRDQlFUMUpVSUQwZ1RuVnRZbVZ5S0hCeWIyTmxjM011Wlc1MkxrSlNTVVJIUlY5UVQxSlVLU0I4ZkNBeE1UZzRPRHNnTHk4Z1FsSkpSRWRGWDFCUFVsVHJpcFFnN1lXTTdJcWs3WXE0N0pxcElDanRqNG5zaG96c2w1UWdNVEU0T0RnZzZyT2c3S0NWS1EwS0x5OGc2NHVrNjZhc0lPeTlsT3VUbkNEcnNvVHNvSVFnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaV2M2NHVrTGlEc3ZaVHJrNXpycGJ3Z2NIVnNiTUszNjdPMTdJS3M3WlcwNjQrRUlDb3E3SjIwNjYrNElPdVdvQ0Rzbm9qcmlwUWc2NHVrNjZhczY0cVVJT3lZbXlEc3ZaVHJrNXdnNnJlNDY0eUE2NkdjS2lycm5id05DaTh2SU9xN2tPdUxwQ0Rzdkp6cXVMQWc3S0NFN0plVUlPeURpQ0RyajVuc25wSHNuYlFnN0pXSUlPdUNtT3lZcU91THBDanRoTERycjdqcmhKRHNuYlFnNjV5bzY0cVVJT3VUc1NrdUlPMlVqT3Vmck9xM3VPeWR1T3lkdENEc25iUWc2ckNTN0p5ODY2R2NJT3Exck91eWhPeWdoT3lkaENEcXNKRHNwNER0bGJRZzdKNnM3SXVjN0o2UjdJdWM3WUtvNjR1a0xnMEtMeThnNjQrWjdKNlI3SjIwSU91d2xPdUFqT3VLbENEc2lKanNvSlhzbllRZzdaV1k2Nm0wSU95ZHRDRHNpS3ZzbnBEcnBid2c3SmlzNjZhczZyT2dJR052WkdVdWRIUHNuWmdnUWxKSlJFZEZYMDFKVGw5VzY0K0VJT3F3bWV5ZHRDRHNtS3pycHJEcmk2UXVEUXBqYjI1emRDQkNVa2xFUjBWZlZpQTlJRFF5T3cwS0x5OGc2cml3NjdPNElPdXFxT3VOdUM0ZzdKcVU3TEt0S08yVWpPdWZyT3EzdU95ZHVDbnNuYlFnYlc5a1pXenNuWVFnN0tlQTdLQ1Y3WldZNjZtMElPcTN1Q0RzbXBUc3NxM3JwNHdnNnJlNElPdXFxT3VOdU91aG5DRHNzcGpycHF6dGxaenJpNlF1RFFvdkx5Qm9ZV2xyZFQzcnVhRHJwb1F2NnJDQTY3Szg3SnVBTENCemIyNXVaWFE5N0tTUjZyQ0VMQ0J2Y0hWelBlcTRzT3V6dUNqc3RaenFzNkR0a29qc3A0Z3NJT3loc09xNGlDRHJpcERycHJ3cERRcGpiMjV6ZENCRFRFRlZSRVZmVFU5RVJVd2dQU0J3Y205alpYTnpMbVZ1ZGk1Q1VrbEVSMFZmVFU5RVJVd2dmSHdnSjI5d2RYTW5PdzBLWTI5dWMzUWdRVXhNVDFkRlJGOU5UMFJGVEZNZ1BTQmJKMmhoYVd0MUp5d2dKM052Ym01bGRDY3NJQ2R2Y0hWekoxMDdEUXBqYjI1emRDQlVWVkpPWDFSSlRVVlBWVlJmVFZNZ1BTQTVNREF3TURzZ0lDQXZMeURzbXBUc3NxMGdNZXF4dENEc29KenRsWnpzaTV6cXNJUU5DbU52Ym5OMElFMUJXRjlVVlZKT1V5QTlJRE13T3lBZ0lDQWdJQ0FnSUNBZ0lDOHZJT3lkdE91bmpPMkJ2Q0RzazdEcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTQW82NHlBN1ptVUlPdUloT3lnZ1NEcnNLbnNwNEFwRFFvTkNpOHZJT0tVZ09LVWdDRHNtSWpzaTV3ZzdJS3M3S0NFSU91aG5PdVRuQ0FvY21WamIyMXRaVzVrTFdWNFlXMXdiR1Z6TG0xa0lPS0FsQ0JpZFdsc1pDMW5iRzl6YzJGeWVTNXFjK3laZ0NEcXNKbnNuWUFnN1l5TTdJU2NLU0RpbElEaWxJQU5DbVoxYm1OMGFXOXVJR3h2WVdSRmVHRnRjR3hsY3lncElIc05DaUFnZEhKNUlIc05DaUFnSUNCamIyNXpkQ0J0WkNBOUlHWnpMbkpsWVdSR2FXeGxVM2x1WXlod1lYUm9MbXB2YVc0b1gxOWthWEp1WVcxbExDQW5MaTRuTENBbmNtVmpiMjF0Wlc1a0xXVjRZVzF3YkdWekxtMWtKeWtzSUNkMWRHWTRKeWs3RFFvZ0lDQWdZMjl1YzNRZ2MyVmpTV1I0SUQwZ2JXUXVjMlZoY21Ob0tDOWVJeU1nN0xhVTdMS2NJT3lZaU95TG5GeHpLaVF2YlNrN0RRb2dJQ0FnYVdZZ0tITmxZMGxrZUNBOVBUMGdMVEVwSUhKbGRIVnliaUJiWFRzTkNpQWdJQ0JqYjI1emRDQmxlR0Z0Y0d4bGN5QTlJRnRkT3cwS0lDQWdJR3hsZENCamRYSWdQU0J1ZFd4c093MEtJQ0FnSUdadmNpQW9ZMjl1YzNRZ2NtRjNJRzltSUcxa0xuTnNhV05sS0hObFkwbGtlQ2t1YzNCc2FYUW9KMXh1SnlrcElIc05DaUFnSUNBZ0lHTnZibk4wSUd4cGJtVWdQU0J5WVhjdWNtVndiR0ZqWlNndlhITXJKQzhzSUNjbktUc05DaUFnSUNBZ0lHTnZibk4wSUdnZ1BTQnNhVzVsTG0xaGRHTm9LQzllSXlNalhITXJLQzRyUHlsY2N5b2tMeWs3RFFvZ0lDQWdJQ0JwWmlBb2FDa2dleUJqZFhJZ1BTQjdJR2x1Y0hWME9pQm9XekZkTENCemRXZG5aWE4wYVc5dWN6b2dXMTBnZlRzZ1pYaGhiWEJzWlhNdWNIVnphQ2hqZFhJcE95QmpiMjUwYVc1MVpUc2dmUTBLSUNBZ0lDQWdZMjl1YzNRZ1lpQTlJR3hwYm1VdWJXRjBZMmdvTDE1Y2N5b3RYSE1yS0M0clB5bGNjeW9rTHlrN0RRb2dJQ0FnSUNCcFppQW9ZaUFtSmlCamRYSXBJR04xY2k1emRXZG5aWE4wYVc5dWN5NXdkWE5vS0dKYk1WMHVjM0JzYVhRb0p5QXZJQ2NwTG1wdmFXNG9KeUFuS1NrN0RRb2dJQ0FnZlEwS0lDQWdJSEpsZEhWeWJpQmxlR0Z0Y0d4bGN5NW1hV3gwWlhJb0tHVXBJRDArSUdVdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lENGdNQ2s3RFFvZ0lIMGdZMkYwWTJnZ0tHVXBJSHNOQ2lBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0ppSTdJdWNJT3lDck95Z2hDRHJvWnpyazV3ZzdJdWs3WXlvSUNqc2w0YnNuYlFnN0tlRTdaYUpLVG9uTENCbExtMWxjM05oWjJVcE93MEtJQ0FnSUhKbGRIVnliaUJiWFRzTkNpQWdmUTBLZlEwS0RRb3ZMeURpbElEaWxJQWc3S2VBN0l1YzY2eTRJQ2pzaEp6cnNvUWdjbVZqYjIxdFpXNWs3Sm1BSU9xd21leWRnQ0RxdDV6c3Vaa2c0b0NVSU91d2xPcSt1T3VwdENEcXQ3anNxcjNyajRRZzdaV282cnVZS1NEaWxJRGlsSUFOQ2k4dklPeWFxZXlXdE95bmtTaG5iRzl6YzJGeWVTNXRaQ25zbllBZzdKMjg2N2FBNjUrc0lPMlVoT3Vock8yVWhPMkt1T3lYa0NEc2xZZ2c2NFNqNjRxVTY0dWtLREl3TWpZdE1EY2c3SXVrN0xpaEtUb2c2NFNqN0p5ODY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc21xbnNsclFnNnJXUTdLQ1Y3SjJFRFFvdkx5RHNvN3dnN0o2RTY2eTA2NkdjSU95WXBPMlZ0TzJWdENBejZyQ2NJT3lnbk95VmlPeWR0Q0Rzb0lUcnRvQWdJdTJSbk9xNHNDRHFzNkRzdWFnZ0t5RHNsclRzaUp3ZzY3T0E2cks5SXV5ZHRDRHJrSnpyaTZRdUlPeVhyZTJWb0NEcnRvVHJwcXdnNG9DVURRb3ZMeUR0Z2JUcm9aenJrNXdnUFNEcnJManNucVVnNjR1azY1T3M2cml3S095d3ZleWRtQ2tzSU95YXFleVd0Q0R0aHJYc25iekN0K3VubnV5MnBPdXlsU0E5SUdOdlpHVXVkSE1nY21WbWFXNWxRV2xUZFdkblpYTjBhVzl1Y3lEdG00VHNzcGpycHF3bzZyaXc2ck9FN0tDQktTNE5DbU52Ym5OMElGTlVXVXhGWDFKVlRFVlRJRDBnV3cwS0lDQW5NUzRnN1pXMDdKcVU3TEswT2lEcnFxanJrNkFnNjZ5NDZyV3M2NHFVSU8yVnRPeWFsT3l5dE91aG5DNGdLT3V6dE91RGhldUxpT3VMcE9LR2t1dXp0T3VDdE95YWxDa25MQTBLSUNBbk1pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzRG9nNjVDUTdKYTA3SnFVNG9hUzdaYUk3SmEwN0pxVUxDQis3SmVJSU91NXZPcTRzQ2pyc0pUcmdJenNsNGpzbHJUc21wVGlocExyc0pUcXY2anNsclRzbXBRcExpRHJpNmdzSU95aWhldWpqTUszNjZlTTY2T013cmZzbDdEc3NyVEN0KzJWdE95bmdNSzM2cml3NjZHZHdyZnJoYm5zbll3ZzY1T3hJT3lMbk95S3BPMkZuT3lkdENEc283enNzclRzbmJnZzZyS3c2ck84NjRxVUlPeUltT3VQbWUyWWxTRHNuS0RzcDRBbzdKZXc3TEswNjQrODdKcVVMQ0RyaGJuc25ZenJqN3pzbXBRcExpY3NEUW9nSUNjekxpRHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdPaUFpZnUyVm9DRHNpSmdnN0plRzdKYTA3SnFVSWlEcmpJRHNpNkFnSW43dGxaanJxYlFnN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFFpSU9xMXJPeWhzQ0RzbXJEc2hLQXVJT3VMcUN3ZzdLQ1Y3TEdGN0lPQklPdTJpT3F3Z01LMzdKMjg2N2FBSU9xNHNPdUtwU0Rzb0p6dGxaekN0K3VRbU91UGpPdW10Q0RzaUpnZzdKZUc2NHFVSU9xeXNPcXp2TUszN0tDVjY3TzBJT3V6dE8yWXVDRHNsWWpzaTZ6c25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyZWlDNG5MQTBLSUNBbk5DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0RG9nZnUyVm1PeUxuT3F5b095V3RPeWFsRC9paHBKKzdaV2c2cm1NN0pxVVB5d2c2ck9FN0l1YzY0dWs0b2FTN0o2STY0dWtMQ0RzbDZ6c3JZanJpNlRpaHBMdG1aWHNuYmp0bFpqcmk2UXNJT3E3bU9LR2t1eVhrT3F5akM0Z2Z1eUxuQ0RydWJ6cXVMRHFzSUFnN0phMDdJT0o3WldZNjZtMElPMk1qT3lWaGUyVm1PdWdwT3VLbENEc29KWHJzN1RycGJ3ZzdLTzg3SmEwNjZHY0lPdXN1T3llcGV5ZGhDRHJpNlRzaTV3ZzdKTzA2NHVrTGljc0RRb2dJQ2MxTGlEcnFvWHNncXdyNjZxRjdJS3NJT3E0aU95bmdEb2c3WldjN0o2UTdKYTA2Nlc4SU8yU2dPeVd0Q0RyajVuc2dxenJvWndvN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBUaWhwTHNuYlRzbnBEcnBid2c2NCtNNjZDazY3Q2I3SldZN0phMDdKcVVLU3dnN0xXYzdJYU03WldjSUh2cnFvWHNncXg5NnJDQUlIdnJxb1hzZ3F4OTdaVzA3SVNjSU8yWWxlMkRuT3VobkNqc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHYzRvYVM3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNrdUp5d05DaUFnSnpZdUlPMlJuT3E0c0RvZzY1Q1k3SmEwN0pxVTRvYVM2NCs4N0pxVUxpY3NEUW9nSUNjM0xpRHNwSVFnNnJXczdLR3dPaURzbTVEcnM3anNuYlFnN1pXY0lPeWtoT3lkdE91cHRDRHN0cFRzc3B6cmo0UWc2N0NZNjVPYzdJdWNJTzJWbkNEc3BJVHJvWnd1SU95ZWhPeWRtT3VobkNEc3BJVHNuWVFnNjRxWTY2YXM3S2VBSU95Vml1dUtsT3VMcEM0ZzY0dW9MQ0RzbDZ6cm42d2c2Nnk0N0o2bDdKMkVJTzJWbU91Q21PeWRtQ0RxdUkzc29KWHRtSlVnNjZ5NDdKNmw3Snk4NjZHY0lPMlZxZXl6a0NEcmpaUWc2ckNFNnJLdzdaVzA3S2VFNjR1azY2bTBJT3lraENEc2lKanJwYndnN0tTRTdKMjA2NHFVSU9xeWcreWRnQ0R0bVpqc21JRXVKeXdOQ2lBZ0p6Z3VJTzJNbmV5WGhTanJpNlRzbmJUc2xyenJvWnpxdDdncElPdXloTzJLdkRvZzZyS3c2ck84SU8yR3RldXp0T3VLbENCYjdabVY3SjI0WFN3ZzdKaUlMK3lWaE91TGlPeVlwQ0R0akpEcmk2anNuWUFnVyt5VmhPdUxpT3lZcEYwdlcrdUVwRjBzSU91UG1leWVrU0RzbktEcmo0VHJpcFFnVyt5M3FPeUdqRjB2VzN2cmo1bnNucEY5WFM0Z0l1eTNxT3lHakNMcmlwUWc2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNSU95VHNPcXpvQ0FpNjR1cjZyaXd3cmZyajVuc25wRWk3TEtZNjUrOElPeW5uU0RzbFlnZzY2ZWU2NHFVSU95aHNPMlZxY0szNjR1bzY0K0ZJQ0xzdDZqc2hvd2k2NHFVSU9xNGlPeW5nQzRuTEEwS0lDQW5PUzRnN0oyMDY2YUV3cmZzb0lUdG1aVHJzb2p0bUxqQ3QrdW5pT3lLcE8yQ3VleWRnQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzBMaURzZ3F6cm5venNuWVFnNjdhQTY2VzhJT3VWa0NEcmk1anNuWVFnNjdhWjdKZXM2NCtFSU95aWkrdUxwQzRuTEEwS0lDQW5NVEF1SU95Z25PMlNpQ0RzbXFuc2xyUWc3SnlnN0tlQU9pRHNub1hyb0tYc2w1QWc3Sk93N0oyNElPcTRzT3VLcGV5RXNTRHJxb1hzZ3F3bzY3T0E2cks5TENEc3A0RHNvSlVzSU91VHNldWhuU3dnN1pXMDdLQ2NJT3VUc1NucmlwUWc3Wm1VNjZtMDdKMllJT3E0c091S3BldXFoY0szNjdLRTdZcTg2NnFGN0oyOElPcXdnT3VLcGV5RXNleWR0Q0RyaHBMc25MenJyNERyb1p3ZzdJbXM3SnEwSU91bmtPdWhuQ0Ryc0pUcXZyanNwNEFnN0pXSzY0cVU2NHVrTGlEc2k1enNpcVR0aFp3ZzY0K1o3SjZSNnJPOElPdUxwT3VsdUNEcmo1bnNncXpycGJ3ZzdJT0k2NkdjSU91bmpPdVRwT3luZ0NEc2xZcnJpcFRyaTZRdUp5d05DbDB1YW05cGJpZ25YRzRuS1RzTkNnMEtZMjl1YzNRZ1JWaEJUVkJNUlZNZ1BTQnNiMkZrUlhoaGJYQnNaWE1vS1RzTkNnMEtMeThnNHBTQTRwU0FJT3lLcE8yRGdPeWR2Q0Rxc0lEc25iVHJrNXdnN0tDRTY2eTRJT3Vobk91VG5DQW9kWGd0ZDNKcGRHbHVaeTV0WkNEaWdKUWc3SmlJN0ptNElPcTNuT3k1bVNEc2hManJ0b0FnN0l1YzY0S1k2NmFzN0ppazZybU03S2VBSU8yVWhPdWhyTzJVaE8yS3VPeVhrQ0R0ajZ6dGxhZ3BJT0tVZ09LVWdBMEtMeThnVTFSWlRFVmZVbFZNUlZNZ01URHNwSVFnN0pxVTdKVzk2NmVNN0p5ODY2R2M2NHFVSU95WWlPeVp1Q0F4ZmpNbzdJaVk2NCtaN1ppVndyZnFzcjNzbHJUQ3QrdTJnT3lnbGUyWWxTRHRsNGpzbXFrZzdMeUE3SjIwN0lxa0tleWRtQ0RyaVpqc2xabnNpcVRxc0lBZzdKeWc3SXVrNjVDYzY0dWtMZzBLTHk4ZzdZeU03SjI4N0oyMElPeVhodXljdk91cHRDanNoS1RzdVpqcnM3Z2c2cldzNjdLRTdLQ0VJT3VUc1NrZzY3bUlJT3VzdU95ZWtPeVh0Q0RpZ0pRZzdKcVU3Slc5NjZlTTdKeTg2NkdjSU91UG1leWVrU2htWVdsc0xYTnZablFwTGcwS1puVnVZM1JwYjI0Z2JHOWhaRWQxYVdSbEtDa2dldzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUcxa0lEMGdabk11Y21WaFpFWnBiR1ZUZVc1aktIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljc0lDZDFlQzEzY21sMGFXNW5MbTFrSnlrc0lDZDFkR1k0SnlrdWRISnBiU2dwT3cwS0lDQWdJSEpsZEhWeWJpQnRaQzVzWlc1bmRHZ2dQaUF4TURBZ1B5QnRaQ0E2SUNjbk93MEtJQ0I5SUdOaGRHTm9JQ2hsS1NCN0RRb2dJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPeUtwTzJEZ095ZHZDRHFzSURzbmJUcms1d2c2NkdjNjVPY0lPeUxwTzJNcUNBbzdKcVU3Slc5NjZlTTdKeTg2NkdjSU95bmhPMldpU2s2Snl3Z1pTNXRaWE56WVdkbEtUc05DaUFnSUNCeVpYUjFjbTRnSnljN0RRb2dJSDBOQ24wTkNtTnZibk4wSUVkVlNVUkZJRDBnYkc5aFpFZDFhV1JsS0NrN0RRb05DbVoxYm1OMGFXOXVJR2x1YzNSeWRXTjBhVzl1VFdWemMyRm5aU2dwSUhzTkNpQWdZMjl1YzNRZ1ptVjNVMmh2ZENBOUlFVllRVTFRVEVWVExtMWhjQ2dvWlhncElEMCtJQ2RKYm5CMWREb2dKeUFySUVwVFQwNHVjM1J5YVc1bmFXWjVLR1Y0TG1sdWNIVjBLU0FySUNkY2JrOTFkSEIxZERvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtHVjRMbk4xWjJkbGMzUnBiMjV6S1NrdWFtOXBiaWduWEc0bktUc05DaUFnY21WMGRYSnVJQ2dOQ2lBZ0lDQW43S2VBNnJpSTY3YUE3WVN3SU91RWlPdUtsQ0RzbDVEc2lxVHNtNUFvVXkweExDRHJzN1RzbFlqdG1venNncXdwN0oyWUlPMlZuT3ExcmV5V3RDQlZXQ0JYY21sMGFXNW5JT3lnaE91c3VPcXdnT3VobkNEc25ienRsWnpyaTZRdUlDY2dLdzBLSUNBZ0lDZnJnclRxc0lBZ1ZVa2c2Nnk0NnJXczY2VzhJTzJWbU91Q21PeVVxU0RyczdUcmdyVHJxYlFzSU95VmhPdWVtQ0RzaXFUdGc0RHNuYndnNnJlYzdMbVo3SmVRSU91bm51cXlqQ0RyaTZUcms2enNuWUFnNjR5QTdKV0lJRFBxc0p6cnBid2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJEUW9nSUNBZ0oreWFsT3l5cmV1VHBPeWRnQ0RzaEp6cm9ad2c2NnkwNnJTQTdaV2NJT3V6aE9xd25DRHJyTGpxdGF6cmk2UWc0b0NVSU95ZHRPeWdoQ0RyckxqcXRhenJwYndnN0xDNDdLR3c3WldZN0tlQUlPdW5pT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDZnNtNURybnBnZzdKMlk2Nis0N0ptQUlPdXFxT3VUb0NEc29KWHJzN1FvN0oyMDY2YUV3cmZzaUt2c25wREN0K3loc09xeHRNSzM2NHlBN0lPQktldWx2Q0RzbktEc3A0RHRsWmpxczZBc0lPcXdnU0Rzb0p6c2xZanNuWUFnN0p1UTY3TzQ2ck84NjQrRUlPeUVuT3Vobk95WmdPdVBoQ0RyaTZ6cm5ienNsYndnN1pXYzY0dWtMaUFuSUNzTkNpQWdJQ0FuN0tHdzZyRzBJTzJSbk8yWWhDanNuYlRzZzRIQ3QreWR0TzJWbU1LMzdKMjA2NEswd3Jmc3RJanFzN3pDdCt1dnVPdW5qTUszNjdhQTdZU3d3cmZxdVl6c3A0QWc2NU94S2V5ZGdDRHNvSlhzc1lVZzdLQ1Y2N08wNjR1a0lPS0FsQ0RydWJ6cXNiRHJncGdnNjR1azY2VzRJT3loc09xeHRPeWN2T3VobkNEcnNKVHF2cmpzcDRBZzY2ZUk2NTI4S0NJMTdacU1JT3lkdE95RGdTTHNuWVFnSWpYdG1vd2k2NkdjSU95a2hPeWR0T3VwdENEc21LVHJpN1VwTGlBbklDc05DaUFnSUNBbjdKdVE2Nnk0N0plUUlPeVhodXVLbENEcXRhenNzclFnN0tDVjY3TzBLT3lnaE8yWmxPdXlpTzJZdU1LM1ZWSk13cmZxdUlqc2xhSEN0K3lMbk9xd2hDRHJrN0VwN0ptQUlPMlZ0T3F5c0NEcnNLbnJzcFhDdCt5Z2lPeXdxQ2pzbnF6c2hLVHNvSlhDdCt1c3VPeWRtT3l5bU1LMzdKNnM3SXVjNjQrRUlPdVRzU25ycGJ3ZzdLZUE3SmEwNjRLMElPdTJtZXlkdE91S2xDRHFzb1BzbllBZzdLQ0k2NHlBSU9xNGlPeW5nQ0RpZ0pRZzdKV0U2NHFVSU9xd2t1eWR0T3Vkdk91UGhDd2c2cmU0NjUrMDY1T3Y3WlcwNjQrRUlPeVRzT3luZ0NEcnA0anJuYnd1WEc0bklDc05DaUFnSUNBbk0rcXduQ0Rzb0p6c2xZanNuWUFnN0lTYzY2R2NJT3lna2VxM3ZPeWR0Q0RyaTZ6cm5ienNsYndnN1pXYzY0dWtJT0tBbENEdGxaanJncGpyaXBRZzdKdVE2Nnk0SU9xMXJPeWhzT3VsdkNEc25LRHNwNER0bFp3ZzdMV2M3SWFNSU91THBPdVRyT3E0c0N3ZzdaV1k2NEtZNjRxVUlPdXN1T3llcFNEcXRhenNvYkRycGJ3ZzdKNnM2cldzN0lTeDdaV2NJT3VNZ095VmlDd2dKeUFyRFFvZ0lDQWdKK3EzdU91bXJPcXpvQ0Rzb0lIc2xyVHJqNFFnN1pXWTY0S1k2NHFVSU9xenZPcXdrTzJWbkNEc25xenF0YXpzaExFNklPeWtrZXV6dFNEdGtaenRtSVRzbllRZzY0MmM3SmEwNjRLMDZyT2dMQ0Rzb0pYcnM3UWc3SWljN0lTYzY2VzhJT3lDck95YXFleWVrT3F3Z0NEc2xZenNsWVRzbGJ3ZzdaV2dJT3F5Zyt1MmdPMkVzT3VobkNEc25xenNvYkRzcDRIdGxhQWc2cktETGlBbklDc05DaUFnSUNBbjdKdVE2Nnk0N0oyMElPMlZ0T3F5c0NEcnNLbnJzcFhzbllRZzY0dTA2ck9nSU95ZWlPeWRoQ0RybFl6cnA0d2dJdXlXdE91V3UrcXlqQ0R0bFpqcnFiUWc2NHVrN0l1Y0lPdVFuT3VMcENMcnBid2c3SldlN0lTNDdKcXc2NHFVSU9xNGpleWdsZTJZbFNEc25xenF0YXpzaExIc25ZUWc3WldZNjUyOElPS0FsQ0RzbTVEcnJManNsNUFnN1pXMDZyS3c3TEdGN0oyMElPeVhodXljdk91cHRDRHJwNHpyazZUc2xyUWc2N2FaN0oyMDdLZUFJT3VuaU91ZHZDNGdKeUFyRFFvZ0lDQWdKKzJSbk9xNHNNSzM3SnFwN0phMDY2ZU1JT3F6b095NW1PcXpvQ0RzbHJUc2lKenNuWVFnNjdDVTZyNjhJT3lnbGV1UGhPeWRtQ0Rzb0p6c2xZanNuWVFnTStxd25DRHJpcGpzbHJUcmhwUHNwNEFnNjZlSTY1MjhJT0tBbENEcXQ3anFzYlFnN0lLczdKcXA3SjZRN0plUTZyS01JT3kybE95eW5PeWR0Q0RzbFlUcmk0anJuYndnNnJXUTdLQ1Y3Snk4NjZHY0lPdXp0T3lkdU91THBDNGdKeUFyRFFvZ0lDQWdKK3lWaE91ZW1DRHNtSWpzaTV6cms2VHNuWUFnN1pXY0lPeWtoT3lubk91bXJDRHN0WnpzaG93ZzZyV1E3S0NWN0oyMElPdW5qdXluZ091bmpDRHF0N2pxc2JRZzdZYWtLTzJWdE95YWxPeXl0TUszNnJLOTdKYTBLZXlkbUNEcXRaRHJzN2pzbmJUc3A0QWc3SWFNNnJlNTdJU3g3SjJZSU9xMWtPdXp1T3lkdENEc2xZVHJpNGpyaTZRZzRvQ1VJT3lYck91ZnJDRHJyTGpzbnFYc3A1enJwcXdnN0o2RjY2Q2w3SjJBSU91cGxPeUxuT3luZ0NEcmk2anNuSVRyb1p3ZzY0dWs3SXVjSU95RXBPcXpoTzJWbU91ZHZDNWNiaWNnS3cwS0lDQWdJQ2ZyaTdYc25ZQWc2N0NZNjVPYzdJdWNJRXBUVDA0ZzY3Q3c3SmUwNjZlTUlPeTJuT3VncGUyVm5PdUxwQzRnNjZlSTdZR3M2NHVrN0pxMHdyZnNoS1RycW9YQ3QreTlsT3VUbk8yT25PeUtwQ0RxdUlqc3A0QTZYRzRuSUNzTkNpQWdJQ0FuVzNzaWRHVjRkQ0k2SUNMc29KenNsWWdnNjZ5NDZyV3NJQ2pzcElUcnNKVHF2NGpzbllBZ1hGeHVLU0lzSUNKeVpXRnpiMjRpT2lBaTY2eTA3SmVIN0oyRUlPeVpuQ0Ryc0pUcXY2anJpcFRzcDRBZzdaV2M2cld0N0phMElPMlZuQ0Ryckxqc25xVWlmU3dnTGk0dVhWeHVYRzRuSUNzTkNpQWdJQ0FuVyt5S3BPMkRnT3lkdkNEcXQ1enN1WmxkWEc0bklDc2dVMVJaVEVWZlVsVk1SVk1nS3lBblhHNWNiaWNnS3cwS0lDQWdJQ2hIVlVsRVJTQS9JQ2RiN0lxazdZT0E3SjI4SU9xd2dPeWR0T3VUbkNEc29JVHJyTGdnS0hWNExYZHlhWFJwYm1jdWJXUXBJT0tBbENEc25JUWc2cmVjN0xtWjdKMllJT3Ezdk9xeHNPeVpnQ0RzbUlqc21iZ2c3SXVjNjRLWTY2YXM3SmlrTGlEdGlybnRub2dnN0ppSTdKbTRJT3Ezbk95NW1TanNpSmpyajVudG1KWEN0K3F5dmV5V3RNSzM2N2FBN0tDVjdaaVY3SjJFSU95Y29PeW5nTzJWdE95VnZDRHRsWmpyaXBRZzdJT0I3Wm1wS2V5ZGhDRHF0N2pyaklEcm9ad2c2NVN3NjZXMDZyT2dMQ0RzbXBUc2xiM3FzN3dnN0tDRTY2eTQ3SjIwSU91THBPdWx0T3VwdENEc29JVHJyTGpzbllRZzY1U3c2Nlc0NjR1a1hWeHVKeUFySUVkVlNVUkZJQ3NnSjF4dVhHNG5JRG9nSnljcElDc05DaUFnSUNBb1ptVjNVMmh2ZENBL0lDZGI3SnF3NjZhc0lPdXFxZXlHak91bXJDRHNtSWpzaTV3ZzRvQ1VJT3lkdENEdGhxVHNuWVFnNjVTdzY2VzhJT3F5ZzExY2JpY2dLeUJtWlhkVGFHOTBJQ3NnSjF4dVhHNG5JRG9nSnljcElDc05DaUFnSUNBbjdLU0E2N21FNjVDUTdKeTg2Nm0wSUNKUFN5THJuYnpxczZEcnA0d2c2NHUxN1pXWTY1MjhMaWNOQ2lBZ0tUc05DbjBOQ2cwS0x5OGc0cFNBNHBTQUlPeURnZXlMbkNEcmpJRHF1TEFnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFOQ214bGRDQndjbTlqSUQwZ2JuVnNiRHNnSUNBZ0lDQWdJQ0FnTHk4ZzdZRzA2NkdjNjVPY0lPMlVoT3Vobk95RXVPeUtwQTBLYkdWMElHeHBibVZDZFdZZ1BTQW5KenNnSUNBZ0lDQWdJQ0F2THlCemRHUnZkWFFnN0tTRUlPdXloTzJOdkEwS2JHVjBJSGRoYVhSbGNpQTlJRzUxYkd3N0lDQWdJQ0FnSUNBdkx5RHRtSVRzbnF3ZzdZUzA3SjJZSUhzZ2NtVnpiMngyWlN3Z2NtVnFaV04wTENCMGFXMWxjaUI5RFFwc1pYUWdjWFZsZFdVZ1BTQlFjbTl0YVhObExuSmxjMjlzZG1Vb0tUc2dMeThnN0pxVTdMS3RJT3luZ2V1Z3JPMlpsQ0FvNjQrWjdJdWNJT3lhbE95eXJleWRnQ0RzaUp6c2hKenJqSURyb1p3cERRcHNaWFFnZEhWeWJuTWdQU0F3T3cwS2JHVjBJSGRoY20xbFpGVndJRDBnWm1Gc2MyVTdEUXBzWlhRZ1kzVnljbVZ1ZEUxdlpHVnNJRDBnUTB4QlZVUkZYMDFQUkVWTU95QXZMeURzcDREcXVJZ2c3SVM0N0lXWTdKMjBJT3Vzdk9xem9DRHNub2pyaXBRZzY2cW82NDI0SUNqc21wVHNzcTNzbmJRZzY0dWs2Nlc0SU91cXFPdU51T3lkaENEc3A0RHNvSlh0bFpqcnFiUWc3SVM0N0lXWUlPeWVyT3lMbk95ZWtTa05DaTh2SU95TG5PeWVrU0RzaTV3Z1EyeGhkV1JsSUVOdlpHVW9ZMnhoZFdSbElFTk1TU25xc0lBZzdKTzRJT3lJbUNEc25vanJpcFRzcDRBZzdLQ1E2cktBSU9LQWxDRHNsNGJzbkx6cnFiUWdMMmhsWVd4MGFPdWhuQ0RzbFl6cm9LUWc3WlNNNjUrczZyZTQ3SjI0N0oyMElPeVZpT3VDdE8yVm5PdUxwQzROQ2k4dklHNTFiR3c5N1ptVjdKMjRJT3lra1N3Z0oyOXJKejNzZ3F6c21xa2c2ckNBNjRxbExDQW5ZMnhoZFdSbExXMXBjM05wYm1jblBXTnNZWFZrWlNEcnFvWHJvTGtnN0plRzdKMk1MQTBLTHk4Z0oyTnNZWFZrWlMxc2IyZHZkWFFuUFdOc1lYVmtaZXVLbENEc25vanNwNERycDR3ZzY2R2M2cmU0N0oyNElPeUV1T3lGbUNEcnA0enJvNHdnS08yRXRDRHNpNlR0aktnZzdJdWNJT3F3a095bmdDd2c3SVN4NnJPMUlPMkV0T3lkdENEc21LVHJxYlFnN0o2UTY0K1pJTzJWdE95Z25Da05DaTh2SUNkamJHRjFaR1V0YkdsdGFYUW5QZXVobk9xM3VPeWR1T3lkZ0NEcmtKRHNwNERycDR3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2dLT3loc095NW1PcXdnQ0RzbnF6cm9aenF0N2pzbmJqc25iUWc3SldFNjR1STY1MjhJTzJWbk91UGhDRHNuYmpzZzRIQ3QrcXpoT3lnbFNEc29JVHRtWmdwRFFwc1pYUWdZMnhoZFdSbFUzUmhkSFZ6SUQwZ2JuVnNiRHNOQ2k4dklPdWhuT3EzdU95ZHVDRHJwNHpybzR3ZzZyQ1E3S2VBSU9LQWxDQkRURW5xc0lBZzY0SzA2NHFVSU95WWdleVd0Q0RzbmJqc3BwMGc3SmlrNjZXWTY2VzhJT3lDck91ZWpPeWR0Q0RzbFl6c2xZVHJrNlRzbllRZzdKV0k2NEswNjZHY0lPdXdsT3Erdk91THBDNE5DaTh2SUNoamJHRjFaR1VnTFMxMlpYSnphVzl1N0oyQUlPdWhuT3EzdU95ZHVDRHNsNGJzbmJUcmo0UWc3SVN4NnJPMTdaVzA3SVNjSU95TG5PdVBtU0Rzb0pEcXNvRHNuTHpyb1p6cmlwUWc2NnE3SU95ZW9lcXpvQ3dnN0l1azdLQ2NJTzJFdE95WGtPeUVuT3VuakNEcms1enJuNnpyZ3B6cmk2UXBEUW92THlBaTY2ZU02Nk9NSXV1bmpPeWR0Q0RzbFlUcmk0anJuYndnSXUyVm5DRHJzb2pyajRRZzY2R2M2cmU0N0oyNElPeVZpQ0R0bGFnaTY0K0VJT3F3bWV5ZGdDRHFzcjNyb1p6cm9ad2c3SjZoN1o2STY2K0E2NkdjSU95a2tldW12U0R0a1p6dG1JVHNuWVFnN0pPMDY0dWtEUXBqYjI1emRDQk1UMGRKVGw5SFZVbEVSU0E5SUNmdGdiVHJvWnpyazV3ZzY2R2M2cmU0N0oyNDdKMjBJTzJWaE95YWxPMlZ0T3lhbENqc2xZZ2c2NUNRNnJHdzY0S1lJT3Vuak91ampDa2c0b0NVSUZ2d241K2dJTzJCdE91aG5PdVRuQ0Ryb1p6cXQ3anNuYmdnN1pXRTdKcVVYU0Ryc29UdGlyenNuWVFnNjRpRTY2VzA2Nm0wSU91aG5PcTN1T3lkdUNEc3NMM3NuWVFnN0plMDdKYTA2NU9jNjZDazdKcVVMaWM3RFFvdkx5RHNpNlRzdUtIdGxad2c2Nnk0NnJXczY1T2tPaUFpUm1GcGJHVmtJSFJ2SUdGMWRHaGxiblJwWTJGMFpUb2dUMEYxZEdnZ2MyVnpjMmx2YmlCbGVIQnBjbVZrSUdGdVpDQmpiM1ZzWkNCdWIzUWdZbVVnY21WbWNtVnphR1ZrSWlqcnA0enJvNHdwTEEwS0x5OGdJazV2ZENCc2IyZG5aV1FnYVc0Z3dyY2dVR3hsWVhObElISjFiaUF2Ykc5bmFXNGlLT3V2dU91aG5PcTN1T3lkdUNrZzRvQ1VJT3VSbUNEcmk2UWc3SjZoN1o2STZyS01JT3VFaysyZWpPdUxwQTBLWm5WdVkzUnBiMjRnYVhOQmRYUm9SWEp5YjNJb2N5a2dldzBLSUNCeVpYUjFjbTRnTDJGMWRHaGxiblJwWTJGMGZHOWhkWFJvZkdGd2FTQnJaWGw4Ykc5bklEOXBibnhzYjJkblpXUjhjMlZ6YzJsdmJpQmxlSEJwY21Wa0wya3VkR1Z6ZENoVGRISnBibWNvY3lrcE93MEtmUTBLTHk4ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2c2ckNRN0tlQUlPS0FsQ0Ryb1p6cXQ3anNuYmpzbllBZzY2bUE3S21oN1pXYzY0MndJQ0xyalpRZzY2cTdJT3lUdE91THBDTHJpcFFnNnJLOTdKcXdMaURyb1p6cXQ3anNuYmdnNjZlTTY2T003Sm1BSU95aHNPeTVtT3F3Z0NEcmk2enJuYnpzaEp3ZzY1U3c2NkdjSU95ZW9ldUtsT3VMcEM0TkNpOHZJT3lMcE95NG9TZ3lNREkyTFRBNExDRHRtb3pzZ3F3ZzdKZVU3WVN3N1pTRTY1Mjg3SjIwN0thSUlPeWlqT3lFblNrNklDSlpiM1VuZG1VZ2FHbDBJSGx2ZFhJZ2FXNWthWFpwWkhWaGJDQnpjR1Z1WkNCc2FXMXBkQ0RDdHlCeWRXNGdMM1Z6WVdkbExXTnlaV1JwZEhNTkNpOHZJSFJ2SUdGemF5QjViM1Z5SUdGa2JXbHVJR1p2Y2lCaElHaHBaMmhsY2lCc2FXMXBkQ0lnNG9DVUlPcTBnT3Vtck95ZWtPcXdnQ0RzZ3F6cm5venJzNFRyb1p3ZzZyRzQ3SmEwSU91UmxDRHNnNEh0bFp6c25iVHJuYndnN1pTTTY1NmNJT3lDck95YXFldWZpZXlkdENEcmdxanNsWVRyajRRZzZyRzQ2NmF3NjR1a0xnMEtMeThnN0oyMElPeThnT3lkdE95S3BPcXdnQ0RzbDRicmpaZ2c3WU9UN0plUUlPeVlnZXlXdENEc201RHJyTGpzbmJRZzZyZTQ2NHlBNjZHY0lPMkdvT3lLcE8yS3VPdVB2Q0FpN0ptY0lPeVZpQ0Rya0pqcmlwVHNwNEFpSU95VmpDRHNpSmdnN0plRzdKZUk2NHVrS095THBPeWduQ0RzaTZEcXM2QXBMZzBLWTI5dWMzUWdURWxOU1ZSZlIxVkpSRVVnUFNBbjdZRzA2NkdjNjVPY0lPeUNyT3lhcVNEdGxaenJqNFRycGJ3ZzY0dWtJT3lOdk95V3RPeWFsQ0RpZ0pRZzdacU03SUtzSU9xemhPeWdsZXlkdE91cHRDRHF0SURycHF6c25wRHNsNURxc293ZzdaV2M2NCtFNjZXOElPeVlyT3VncENEcmk2enJuYnpxczZBZzdKcVU3TEt0N1pXWTZyT2dMQ0RzbFlUcmk0anJxYlFnVy9DZm42QWc3WUcwNjZHYzY1T2NJTzJWbk91UGhDRHN0SWpxczd4ZElPdXloTzJLdk95ZGhDRHJpSXpybjZ3ZzY0dWs2Nlc0SU9xemhPeWdsZXljdk91aG5DRHJvWnpxdDdqc25ianRsYlFnN0tPODdJUzQ3SnFVTGljN0RRb3ZMeUFuN1pXYzY0K0VKK3VobkNEcnJZbnJtckhxdDdqcnBxenJxYlFnN0pXSUlPdVFuT3VMcENEaWdKUWc3SjZnNnJtUUlPdXFzT3VtdENEcmxZd2c2NEtZNjRxVUlISmhkR1VnYkdsdGFYVHNuYlRyZ3BnZzY2eTQ2NmVsSU9xNHVPeWR0Q0RzdElqcXM3enF1WXpzcDRBZzdKNmg3SldFRFFvdkx5RHNsNG5ybXJIdGxaanFzb3dnSXV1THBPdWx1Q0RxczRUc29KWHNuTHpyb1p3ZzY2R2M2cmU0N0oyNDdaV1k2NTI4SXVxem9DRHNsWWpyZ3JUdGxaanFzb3dnNjVDYzY0dWtMaURzcDREc3RwekN0K3lDck95YXFldWZpU0RzZzRIdGxad2c2Nnk0NnJXczY2ZU1JT3lpZ2UyWWdPeUVuQ0Ryczdqcmk2UU5DbVoxYm1OMGFXOXVJR2x6VEdsdGFYUkZjbkp2Y2loektTQjdEUW9nSUhKbGRIVnliaUF2YzNCbGJtUWdiR2x0YVhSOGRYTmhaMlV0WTNKbFpHbDBjM3gxYzJGblpTQnNhVzFwZENBb2NtVmhZMmhsWkh4bGVHTmxaV1JsWkNrdmFTNTBaWE4wS0ZOMGNtbHVaeWh6S1NrN0RRcDlEUW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPMlpsZXlkdUNEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTno2Nlc4SU95ZHZleVd0QTBLTHk4Z0wyaGxZV3gwYU91aG5DRHJoYmpzdHB6dGxaenJpNlFnS08yVWpPdWZyT3EzdU95ZHVPeWR0Q0FpNjRpRTZyV3NJT3F6aE95Z2xleWN2T3VobkNEc2s3RHJpcFFnN0tTUjdKMjQ3S2VBSWlEdGtaenNpNXdnNG9DVUlPcXp0ZXlhcVNCUVEreVhrT3lFbkNEcmdxanNuWmdnNnJPRTdLQ1ZJT3lZcE95Q3JPeWFxU0Ryc0tuc3A0QXBMZzBLTHk4ZzdZeU03SjI4N0oyMElPMkJ0Q0RzaUpnZzdKNkk3SmEwS08yVWhPdWhuT3lnbmUyS3VDRHNuYlRyb0tVZzdZK3M3WldvS1NBek1PeTBpQ0RzdXBEc2k1d3VJT3llck91aG5PcTN1T3lkdU8yVm1PdXB0Q0JEVEVucXNJQWc3WXlNN0oyODdKMkVJT3F3c2V5TG9PMlZtT3V2Z091aG5DRHNucERyajVrZzY3Q1k3SmlCNjVDYzY0dWtMZzBLYkdWMElHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJREFzSUdWdFlXbHNPaUJ1ZFd4c0lIMDdEUW92THlEc3A0RHF1SWdnNjVhZ0lPeWVpT3VLbENCamJHRjFaR1VnN0lTNDdJV1k3SjIwSU95V3RPdUtrQ0RxczRUc29KWHNuTHpyb1p3ZzdJdWM2NCtaNjVDUTY0cVU3S2VBSUNoemRHRnlkRkJ5YjJQc2w1RHNoSndnNnJpdzY2R2RLUzROQ2k4dklPeUV1T3lGbU95ZGdDRHNpNXpyajVudGxhQWc2NVdNSU91d20reWRnQ0Rzbm9Yc25xWHF0b3pzbllRZzZyT0U3SWFOSU95VHNPdXZnT3VobkN3ZzY3Q1c3SmVRN0lTY0lPcXpoT3lnbGV5ZGhDRHJzSlRxdnJqcnFiUWc3SjIwSU9xd2t1cXp2Q0R0akl6c25ienNuWmdnNnJPRTdLQ1Y3SjIwSU95V3RPcTRpK3VDbk91THBBMEtiR1YwSUhObGMzTnBiMjVCWTJOdmRXNTBJRDBnYm5Wc2JEc05DaTh2SU95THBPeWduQ0Ryb1p6cXQ3anNuYmdnN0plczY3YUE2NHFVSU95ZWtPcXlxZXltbmV1cWhTRHRqSXpzbmJ6cm9ad2c3WXlRNjR1bzdaV2M2NHVrSU9LQWxDQitMeTVqYkdGMVpHVXVhbk52YnV5ZG1DQnZZWFYwYUVGalkyOTFiblRyaXBRZ0tpcnJvWnpxdDdqc2xZVHNtNFB0bGJUcmo0UWc2NEtvNjRxVTY0dWtLaW9OQ2k4dklDanNpNlRzdUtFNklHTnNZWFZrWlNCaGRYUm9JSE4wWVhSMWMrdUtsQ0JzYjJkblpXUkpianBtWVd4elpleWR1T3VOc0NEcXQ3Z2c3WldFNjVPYzY0cVVJT3EzdU91TWdPdWhuQ0RpaHBJZzdaU002NStzNnJlNDdKMjQ3SjIwSU91aG5PcTN1T3lkdU91UW5DRHFzb1Bzc3Bqcm43d2c3WkdjN0l1YzdaYUk2NHVrS1M0TkNpOHZJTzJNak95ZHZPdW5qQ0RzbmIzc25MenJyNERyb1p3ZzY3bUU3SnFwSURBdUlHTnNZWFZrWlNCaGRYUm9JSE4wWVhSMWMrdWx2Q0RydG9EcnBiVHJxYlFnN0tDVjdabVY3WldZN0tlQTY2ZU1JTzJVaE91aG5PeUV1T3lLcE91bHZDRHJuWVRzbTR6c2xid2c3WlcwN0lTY0lPeWhzTzJhak91bmlPdUxwQ0RzazdEcXVMRHNsNVFnNjZ5MDZyS0I2NHVrTGcwS1puVnVZM1JwYjI0Z2FHRnpRMnhoZFdSbFEzSmxaR1Z1ZEdsaGJITW9LU0I3RFFvZ0lIUnllU0I3RFFvZ0lDQWdZMjl1YzNRZ1ppQTlJSEJoZEdndWFtOXBiaWh2Y3k1b2IyMWxaR2x5S0Nrc0lDY3VZMnhoZFdSbEp5d2dKeTVqY21Wa1pXNTBhV0ZzY3k1cWMyOXVKeWs3RFFvZ0lDQWdZMjl1YzNRZ2FpQTlJRXBUVDA0dWNHRnljMlVvWm5NdWNtVmhaRVpwYkdWVGVXNWpLR1lzSUNkMWRHWTRKeWtwT3cwS0lDQWdJR2xtSUNocUlDWW1JR291WTJ4aGRXUmxRV2xQWVhWMGFDQW1KaUJxTG1Oc1lYVmtaVUZwVDJGMWRHZ3VZV05qWlhOelZHOXJaVzRwSUhKbGRIVnliaUIwY25WbE93MEtJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaUR0akl6c25id2c3SmVHN0oyTXdyZnJxcnNnN0oyOTdKMk1JT0tBbENEcnA2WHNuYlRycWJRZzdZS2s3TEswN0oyNDdKMkVJT3VuaU95Z2dDRHJzN2pyaTZRZ0tpOGdmUTBLSUNBdkx5QXFLdXVucGV5ZGdDRHNucERxc3Fuc3BwM3Jxb1hzbllRZzdZeU03SjI4N0oyMElPeVZoT3VMaU91ZHZDRHRncVRzc3JUc25ianNsNUFnNjRTajY0cVU2NHVrS2lvZ0tESXdNall0TURnZzdJdWs3TGloTENEcmk2VHJwcXdnZGpReElDOGc2ckNRN0l1YzdKNlFJSFkyS1M0TkNpQWdMeThnNjZlbDdKMllJRU5zWVhWa1pTQkRiMlJsNjRxVUlINHZMbU5zWVhWa1pTOHVZM0psWkdWdWRHbGhiSE11YW5OdmJ1eWRoQ0RzbFlUc21JZ2c2NmVNNjVPazdLZUFJT3lWaXVxem9DRHRncVRzc3JUc25iZ2c3Wld0NjZxcERRb2dJQzh2SUNkRGJHRjFaR1VnUTI5a1pTMWpjbVZrWlc1MGFXRnNjeWZzbDVBZzdLQ0E3SjZsN1pXYzY0dWtJT0tHa2lEdGpJenNuYnpycDR3ZzY3TzA2Nm0wSU91cGdPeXBvZTJlaUNEcm9aenF0N2pzbmJqcmtKd2c2NmVsN0oyMElPdUttQ0FuNjZHYzZyZTQ3SjI0SU95VmlDRHJrS2duN0oyMElPdVFtT3F6b0N3TkNpQWdMeThnNjZHYzZyZTQ3SjI0SU91TWdPcTRzQ0R0bVpUcnFiVHNuYlFnN0ppQjdKaUJJT3VQaU91THBDanJpSXpybjZ6cmo0UWdRMHhKNnJDQUlDTHNuYlRycjdnZzY2R2M2cmU0N0oyNDY1Q29JdXljdk91aG5DRHNwb25zaTV3ZzY0R2Q2NEtZSU91NGpPdWR2T3lhc095Z2dPeWhzT3l3cUNEc2xZZ2c3SmUwNjZhdzY0dWtLUzROQ2lBZ0x5OGdLaXJzb2JUc25xenJwNHdnN1ptVjdKMjQ3WldjNjR1a0tDMTNJT3lYaHV5ZGpDa3FLaURpZ0pRZzY3bUU2N0NBNjdLSTdaaTRJT3F3a3V5ZGhDRHNuYjNzbkx6cnFiUWc3WUtrN0xLMDdKMjRJT3lna2VxM3ZDRHRsNGpzbXFrZzdZeWQ3SmVGN0oyMElPdWNzQ0RzaUpnZzdKNkk2NHVrTGlEc2xiMGdNekJ0Y3k0TkNpQWdMeThnUTBKZlRrOWZTMFZaUTBoQlNVNDlNZXlkdE91cHRDRHRqSXpzbmJ6cnA0d2c2N080NjR1a0lDanJxcWpzblpnZzdabUk3Snk4NjZHY0lDZnJvWnpxdDdqc25iZ2c3SmVHN0oyTUoreWRoQ0RzbnF6dG1JVHRsWmpyaXBRZzdZV003SXFrN1lxNDdKcXBJT0tBbENEdGdxVHNzclRzbmJqc25ZQWdTRTlOUmV5ZGhDRHNsWWdnNjVTdzY2VzQ2NHVrS1M0TkNpQWdhV1lnS0hCeWIyTmxjM011Y0d4aGRHWnZjbTBnSVQwOUlDZGtZWEozYVc0bklIeDhJSEJ5YjJObGMzTXVaVzUyTGtOQ1gwNVBYMHRGV1VOSVFVbE9JRDA5UFNBbk1TY3BJSEpsZEhWeWJpQm1ZV3h6WlRzTkNpQWdkSEo1SUhzTkNpQWdJQ0JqYjI1emRDQnlJRDBnYzNCaGQyNVRlVzVqS0NkelpXTjFjbWwwZVNjc0lGc25abWx1WkMxblpXNWxjbWxqTFhCaGMzTjNiM0prSnl3Z0p5MXpKeXdnSjBOc1lYVmtaU0JEYjJSbExXTnlaV1JsYm5ScFlXeHpKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuTENCMGFXMWxiM1YwT2lBek1EQXdJSDBwT3cwS0lDQWdJSEpsZEhWeWJpQnlMbk4wWVhSMWN5QTlQVDBnTURzTkNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ2NtVjBkWEp1SUdaaGJITmxPeUI5SUM4dklITmxZM1Z5YVhSNTY2VzhJT3VxdXlEcnRvRHJwb1FnUFNEcm9aenF0N2pzbmJnZzdKV0lJT3VRcU95Y3ZPdWhuQ0Ryczdqcmk2UU5DbjBOQ21aMWJtTjBhVzl1SUdOc1lYVmtaVUZqWTI5MWJuUW9LU0I3RFFvZ0lHbG1JQ2hFWVhSbExtNXZkeWdwSUMwZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUR3Z016QXdNREFwSUhKbGRIVnliaUJoWTJOdmRXNTBRMkZqYUdVdVpXMWhhV3c3RFFvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnYVdZZ0tHaGhjME5zWVhWa1pVTnlaV1JsYm5ScFlXeHpLQ2twSUhzZ0x5OGc3SjZRNnJLcDdLYWQ2NnFGN0oyMElPeVhodXljdk91cHRDRHJncWpzbllBZzdKMjA2Nm1VN0oyODdKMkFJT3VzdE95TG5PMlZuT3VMcEEwS0lDQWdJQ0FnWTI5dWMzUWdhaUE5SUVwVFQwNHVjR0Z5YzJVb1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxMbXB6YjI0bktTd2dKM1YwWmpnbktTazdEUW9nSUNBZ0lDQmxiV0ZwYkNBOUlDaHFJQ1ltSUdvdWIyRjFkR2hCWTJOdmRXNTBJQ1ltSUdvdWIyRjFkR2hCWTJOdmRXNTBMbVZ0WVdsc1FXUmtjbVZ6Y3lrZ2ZId2diblZzYkRzTkNpQWdJQ0I5RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdWhuT3EzdU95ZHVDRHNuYlRyb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDRHNuS0RzcDRBZ0tpOGdmUTBLSUNCaFkyTnZkVzUwUTJGamFHVWdQU0I3SUdGME9pQkVZWFJsTG01dmR5Z3BMQ0JsYldGcGJDQjlPdzBLSUNCeVpYUjFjbTRnWlcxaGFXdzdEUXA5RFFwbWRXNWpkR2x2YmlCamFHVmphME5zWVhWa1pVRjJZV2xzWVdKc1pTZ3BJSHNOQ2lBZ1kyOXVjM1FnY0hKdlltVWdQU0J6Y0dGM2JpZ25ZMnhoZFdSbEp5d2dXeWN0TFhabGNuTnBiMjRuWFN3Z2V5QnphR1ZzYkRvZ2RISjFaU3dnWlc1Mk9pQkRURUZWUkVWZlJVNVdJSDBwT3cwS0lDQnNaWFFnYjNWMElEMGdKeWM3RFFvZ0lIQnliMkpsTG5OMFpHOTFkQzV2YmlnblpHRjBZU2NzSUNoa0tTQTlQaUI3SUc5MWRDQXJQU0JrTG5SdlUzUnlhVzVuS0NrN0lIMHBPdzBLSUNCd2NtOWlaUzV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiV2x6YzJsdVp5YzdJSDBwT3cwS0lDQndjbTlpWlM1dmJpZ25ZMnh2YzJVbkxDQW9ZMjlrWlNrZ1BUNGdldzBLSUNBZ0lHTnNZWFZrWlZOMFlYUjFjeUE5SUNoamIyUmxJRDA5UFNBd0lDWW1JQzljWkN0Y0xseGtLeTh1ZEdWemRDaHZkWFFwS1NBL0lDZHZheWNnT2lBblkyeGhkV1JsTFcxcGMzTnBibWNuT3cwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNCRGJHRjFaR1VnUTI5a1pTRHNvSkRxc29BNklDY2dLeUJqYkdGMVpHVlRkR0YwZFhNZ0t5QW9iM1YwSUQ4Z0p5QW9KeUFySUc5MWRDNTBjbWx0S0NrZ0t5QW5LU2NnT2lBbkp5a3BPdzBLSUNCOUtUc05DbjBOQ2k4dklPeXltT3VtckNEdG1JVHRtYWtnNG9DVUlDOW9aV0ZzZEdqcm9ad2c2NFc0N0xhYzdaVzBJQ0xzb0pYcnA1QWc3WUcwNjZHYzY1T2M2ckNBSU91THRlMldpT3VLbE95bmdDSWc2N0NXN0plUTdJU2NJTzJabGV5ZHVPMlZvQ0RzaUpnZzdKNkk2cktNSU8yVm5PdUxwQTBLWTI5dWMzUWdjM1JoZEhNZ1BTQjdJSE5sY25abFpEb2dNQ3dnYkdGemRFRjBPaUFuSnl3Z2JHRnpkRlJsZUhRNklDY25MQ0JzWVhOMFUyVmpPaUFuSnlCOU93MEtEUW92THlEaWxJRGlsSUFnN1pTTTY1K3M2cmU0N0oyNElPeURuZXlodENEcXNKRHNwNEFvN0l1czdKNmw2N0NWNjQrWktTRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElBTkNpOHZJTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJscUFnN0o2STY0cVVJT3VQbWV5VmlDQmpiMlJsTG5SejZyQ0FJRFhzdElqcnA0anJpNlFnVUU5VFZDQXZhR1ZoY25SaVpXRjA2Nlc4SU91enRPdUN1T3VMcEM0TkNpOHZJTzJWbkNEcnNvanNuYlRybmJ6cmo0UWc2N0NiN0oyQUlPdVNwQ0F6TU95MGlPcXdoQ0RyZ1lycXVMRHJxYlFnN1pTTTY1K3M2cmU0N0oyNEtPdVlrT3VLbENEdGxMenF0N2pycDRncDdKMjBJT3VMcSsyZWpDRHFzb01nNG9DVUlPMkJ0T3Vobk91VG5PcTVqT3luZ0NEcmpiRHJwcXpxczZBZzZyQ1o3SjIwSU9xNnZPeW5oT3VMcEM0TkNpOHZJT3lWaE95bmdTRHRsWndnNjdLSTY0K0VJT3VxdXlEcnNKdnNsWmpzbkx6cnFiUW82NHVrNjZhczY2ZU1JT3Vvdk95Z2dDRHN2S0FnN0lPQjdZT2NMQ0RzbnBEcmo1bnNpNXpzbnBFZzY1T3hLU0RxczRUc2hvMGc2NHlBNnJpdzdaV2M2NHVrTGcwS1kyOXVjM1FnU0VWQlVsUkNSVUZVWDBSRlFVUmZUVk1nUFNBek1EQXdNRHNOQ214bGRDQnNZWE4wUW1WaGRDQTlJREE3RFFvTkNpOHZJT3VCaE9xNHNDRHNvSVRzbDVBZ0tpcnJrNlByalpnZzdZK3M3WXE0NjZXOElPdW92T3lnZ0NEcmhwUHJpcFRyaTZRcUtpQW9NakF5Tmkwd09Dd2dRbEpKUkVkRlgxWTlORElwTGcwS0x5OGc3Sm1jT2lCd2NtOWpaWE56TG1WNGFYVHNuWmdnWlhocGRDRHRsYmpyazZUcm42enFzSUFnYTJsc2JGQnliMlBpaHBKMFlYTnJhMmxzYk95ZGhDRHJqNHpycHF6cmlwVHJqYkFzSU9xM3VPcXlqQ0RycVlqc3RwVHJxYlFnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lpaGV1ampDRHJqNFRzcEpFTkNpOHZJT3lXdk95V3RPdTJtZXlXdENEdGo2enRpcmpycDR3ZzY2eTg2ck9nSU95ZGtldUx0ZXlkaENEcnFyc2c3WldZNjRxVUlPeWlnT3U1aE9xd2dDRHJrSnpyaTZRdUlPcTN1T3Vmck91cHRDRHFzSkRzaTV6c25wRHFzSUFnN0lPSTY2R2NJT3k4b0NEcmk2VHJwcXpyaXBRZ1JVRkVSRkpKVGxWVFJldWhuQTBLTHk4ZzY2eTg2NStzNjRLWTZyT2dLT3Vobk9xM3VEb2dKK3lkdE91dnVDRHN2Snpzb0xnZzdKNkk3SmEwN0pxVUp5a3NJTzJVak91ZnJPcTN1T3lkdU95WGxDQWk3SmV3NjQrWjY1Q1k3S2VBSU95Vml1eVZtT3lXdE95YWxDTHJwNHdnNjRLbzY0cVU2NHVrS095THBPeTRvU2t1RFFvdkx5RHNob3pzdkpQc25ZUWc2Nmk4N0tDQUlPdUxxK3lWaENEcmtaRHJxYlFnN0tDVjY2YXM2ckNBSU91S2tPdWdwT3VQaENEcmk2VHNuWXdnNjR1azY2YXM2ckNBSU95Z2xleURnZXlnZ2V5Y3ZPdWhuQ0RxdDdnZzdZK3M3WXE0NjZXOElPeWVvZXVLbE91THBDNE5DbVoxYm1OMGFXOXVJR2hoY21SRmVHbDBLR052WkdVcElIc05DaUFnZEhKNUlIc2djMlZ5ZG1WeUxtTnNiM05sS0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3luZ1NEc2xZZ2c2NWEwN0p5ODY2bTBJT3VzdE95TG5DQXFMeUI5RFFvZ0lIUnllU0I3SUhObGNuWmxjall1WTJ4dmMyVW9LVHNnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nU1ZCMk51eWRnQ0RzbDRic25ZUWc3SWlZSU95ZWlPdUxwQ0FxTHlCOURRb2dJSEJ5YjJObGMzTXVaWGhwZENoamIyUmxJSHg4SURBcE93MEtmUTBLYzJWMFNXNTBaWEoyWVd3b0tDa2dQVDRnZXcwS0lDQnBaaUFvYkdGemRFSmxZWFFnSmlZZ1JHRjBaUzV1YjNjb0tTQXRJR3hoYzNSQ1pXRjBJRDRnU0VWQlVsUkNSVUZVWDBSRlFVUmZUVk1wSUhzTkNpQWdJQ0F2THlBcUt1dWhuT3EzdU95ZHVDRHNwSkhzbmJUcnFiUWc3SldJSU9xNnZPeW5oT3VMcENvcUlDZ3lNREkyTFRBNExDQkNVa2xFUjBWZlZqMHpOeWs2SUdWNGFYUWc3Wlc0NjVPazY1K3M2ckNBSUd0cGJHeE1iMmRwYmxCeWIyUHF1WXpzcDRBZzY3YUE2NlcwNjYrQTY2R2NEUW9nSUNBZ0x5OGc3SmVzNnJpdzdJU2NJT3E2dk95bmdPdXB0Q0RydUl6cm5ienNtckRzb0lEc2w1RHNoSndnNjZHYzZyZTQ3SjI0N1pXWTY0MllJT3lDck91ZWpPeWRtQ0Rzdlp6cnNMRWc3WStzN1lxNDZyQ0FJT3VMcSsyWWdDQWliRzlqWVd4b2IzTjA3SmVRN0lTY0lPeVhzT3F5c095ZGhDRHFzYkRydG9EdGxvanNpclhyaTRqcmk2UWk2ckNBRFFvZ0lDQWdMeThnNjV5bzZyR3c2NEtZTENEcm9aenF0N2pzbmJnZzdMQzk3SjIwSU95R2pPdW1yQ0RzbDRic25iUWc2NnkwN1pxbzZyQ0FJT3VRbk91THBDanNpNlRzdUtFZzRvQ1VJTzJVak91ZnJPcTN1T3lkdU95ZGhDRHJpNnZzbFlRZzY1R1VJT3l4aENEcm9aenF0N2pzbmJqdGxaanJxYlFnNjZlazY3S0lJT3lkdE91ZXJPdUxwQ2t1RFFvZ0lDQWdMeThnNjZHYzZyZTQ3SjI0N0oyQUlPdTRqT3Vkdk95YXNPeWdnT3lYa095RW5DRHNncXpybm96c25iUWc3S2VFN1phSjdaV1k2NHFVSU95ZHZPeWR0T3VkdkNEdGxJenJuNnpxdDdqc25ianNuYlFnNjVhZ0lPeWVpT3lkaENEdGxZVHNtcFRxc0lBZzdKZUc2NHVrTGlEcnJMVHRsWndnNjR5QTZyaXdJT3ljaE8yWG1PeWRnQTBLSUNBZ0lDOHZJR3h2WjJsdVVISnZZMVJwYldWeUtETXc2N2FFS2Vxd2dDRHJwNG5yaXBUcmk2UWc0b0NVSU9xM3VDRHRnNERzbmJUcnFManFzSUFnNjZHYzZyZTQ3SjI0N0oyRUlPeWdsZXVtck8yVm1PdXB0Q0RyaTZUc25Zd2c3S0NRNnJLQTdKZVE3SVNjSU95Z2xleURnZXlnZ2V5Y3ZPdWhuQ0RxdXJ6c3A0VHJpNlF1RFFvZ0lDQWdhV1lnS0d4dloybHVVSEp2WXlrZ2V3MEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lMck95ZXBldXdsZXVQbWV5ZGdDRHJnWXJxc3J6c3A0RHJwNHdnNjZHYzZyZTQ3SjI0N0oyMElPeW5oTzJXaVNEc3BKSHNuYlRybmJ3ZzZyaXc2NHVrNjZhOTY0dUk2NHVrSUNqcm9aenF0N2pzbmJnZzY0R2Q2NEtZNjZtMElPeWdsZXVtck91UXFldUxpT3VMcENrdUp5azdEUW9nSUNBZ0lDQnlaWFIxY200N0RRb2dJQ0FnZlEwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGxJenJuNnpxdDdqc25iZ2c3SXVzN0o2bDY3Q1Y2NCtaSU91Qml1cTVnQ0RpZ0pRZzdaUzg2cmU0NjZlSUwrMlVqT3Vmck9xM3VPeWR1T3lkdENEcmk2dnRub3dnNnJLRDdKeTg2NkdjSU91enRPcXpvQ0Rxc0puc25iUWc2cnE4N0tlUjY0dUk2NHVrTGljcE93MEtJQ0FnSUdoaGNtUkZlR2wwS0RBcE95QXZMeUR0ajZ6dGlyanJwYndnNjZpODdLQ0FJT3VHaytxem9DRHNvb1hybzR3ZzRvQ1VJR1Y0YVhRZzdaVzQ2NU9rNjUrczZyQ0FJR3RwYkd4UWNtOWo3Snk4NjZHY0lHTnNZWFZrWlNEdGlyanJwcXpycGJ3ZzdLQ1Y2NmFzN1pXYzY0dWtEUW9nSUgwTkNuMHNJRFV3TURBcE93MEtEUW92THlEc203a2c2NkdjNnJlNDdKV0U3SnVEN0oyRUlPdTRqT3Vkdk95YXNPeWdnT3VobkNEc2w2enJpcFFnN0wyVTY1T2M2NHFVSU95Z25PcXhzTzJXaU91THBDQW9NakF5Tmkwd09Dd2dRbEpKUkVkRlgxWTlOREFwSU9LQWxDRHJvWnpxdDdqc25iZ2c3Wm1VNjZtMDdKMjBJT3VSa0NEcXNKd2c2NWFnN0lTY0RRb3ZMeURzbHJUcmlwQWc3S3E5N0plUUlPdWhuT3EzdU95ZHVPMlZ0T3lWdkNEdGxaanJpcFRzcDRBZzdKV01JT3lJbUNEc2w0YnNsNGpyaTZRbzdJdWs3TGloSU95TG9PcXpvQ2t1SU95S3VleWR1Q0R0bVpUcnFiVHNuWVFnNnJHMDY0U0k2NXV3NjZDazY2bTBJT3lDck95YXFleWVrT3F3Z0NEcnVJenJuYnpzbXJEc29JRHNsNURzaEp3TkNpOHZJT3luZ2V5Z2tTQmpiR0YxWkdVZzY2R2M2cmU0N0pXRTdKdUQ3SjJFSU8yVm1PcXhzT3VDbUN3ZzdJcTU3SjI0SU8yWmxPdXB0Q0R0bFpqcmk2Z2dXK3F6aE95Z2xTRHNvSVR0bVpoZDdKMkVJT3lUc091cHRDRHJrSnpyaTZRdUlDb3E3WU90N0oyQUlPMlZyZXlEZ1NBeDZyQ2M2NkdjSU95Y29PeW5nTzJWb0NEcXNvTXVLaW9OQ2cwS0x5OGc0cHFnNzdpUElPdWhuT3EzdU95ZHVDRHFzcjNyb1p6c2w1RHNoSndnS2lwQ1VrOVhVMFZTNjZXOElPcXh0T3VUbk91bXJPdXB0Q0RzbFlnZzY1Q2M2NHVrS2lvZ0tESXdNall0TURnZzdJdWs3TGloSURMdG1venJvWndnN1ptVjdLQ1ZLVG9OQ2k4dklDQWdRbEpQVjFORlV1dWx2Q0RzaEtUc29KWHRsWmpycWJRbzY0SzA3SnFwN0oyMElPdXN0T3lYaCt5ZHRPdVRvQ3dnN0pXRTY2eTA2cktENjQrRUlPeVZpQ0R0bFpqcmlwUWdibTh0YjNEc25iVHNsclRyajRRcElHTnNZWFZrWlNCRFRFbnFzSUFnNjdpTTY1Mjg3SnF3N0tDQUlPMlZ1T3VUbk95WXBPMlVoT3VsdkEwS0x5OGdJQ0R0ajZ6cXVMRHRsWmpxczZBZ0tpb2k3SjI0N0thZElPeTlsT3VUbk91bHZDQkRiR0YxWkdVZ1EyOWtaZXlYa0NEcnRwbnNsNnpyaEtQc25MenNoTGpzbXBRaUlPdXdxZXlMbmV5Y3ZPdWhuQ0Ryc0pUcmdKRHJpNlFxS2k0ZzY0dWs2NmFzNjRxVUlPdWhuT3EzdU95ZHVDRHRsSVRyb1p6c2hManNpcVRycGJ3TkNpOHZJQ0FnN0lpbzZyS283SVNjSUhOMFpHbHVJT3lYaHV5ZHRDRHJuWVRzbXJEcnI0RHJvWndnNjdhWjdKZXM2NFNqN0oyRUlPcXpzK3lkdENEc2w0YnNsclFnNjZHYzZyZTQ3SjI0N0oyMElPeVZoT3lZaUNEcnRvanFzSURyaXFYdGxiVHNwNFRyaTZRdURRb3ZMeUFnSUNoc2IyTmhiR2h2YzNRZ1RFbFRWRVZPN0oyMElPdVdvQ0Rzbm9qcmlwUWc2cktENjZlTUlPdXp0T3F6b0NEc25wRHJqNWtnN0lpWTY2QzU3SjIwSU95Y29PeW5nT3VRbk91THBPcXpvQ0R0akpEcmk2anRsb2pyalpnZzZyS01JT3lZcE95bmhPeWR0T3lYaU91THBDNHBEUW92THlBZ0lPS0draURxdDdqcm5wanNoSndnSXUyRHJTQXg2ckNjSUNzZzZyT0U3S0NWSU95RW9PMkRuU0R0bVpUcnFiUWk3SjJBSU95ZHRDQkRURW5yb1p3ZzY3YUk2ckNBNjRxbDdaV1k2NHVrT2lEdGxad2c3WU90N0p5ODY2R2NJT3llaCt5ZWtPdXB0Q0JEVEVuc25aZ2c3SmUwNnJpdzY2VzhJT3VuaWV5VmhPeVZ2QTBLTHk4Z0lDRHRsWmpxczZBc0lPdW5pZXljdk91cHRDRHN2WlRyazV3ZzY3YVo3SmVzNjRTajZyaXc2ckNBSU91UW5PdUxwQzRnNjZHYzZyZTQ3SldFN0p1RDdKMkVJT3VVc091aG5DRHNsN1RycWJRZzdZT3Q3SjIwSURMcXNKenFzSUFnNjVDYzY0dWtMZzBLTHk4Z0lDRHFzckRyb2FBbzdJS3M3SnFwN0o2UUlPcXlzT3lnbFNrNklDb3E3WU90SURIcXNKd2dLeURzaXJuc25iZ2c3Wm1VNjZtMEtpcnNuWVFnN0pPdzZyT2dMQ0RxczRUc29KVWc3S0NFN1ptWTdKMkFJT3EzdUNEdG1aVHJxYlRzblpnZ1crcXpoT3lnbFNEc29JVHRtWmhkSU91eWhPMkt2T3ljdk91aG5DRHRsWnpyaTZRdURRb3ZMeUFnSU95Q3JleWduT3VRbkNEc2k1enJqNFRyazZRNklIZHlhWFJsVG05dmNFSnliM2R6WlhJZ0x5QnZjR1Z1VlhKc1NXNUVaV1poZFd4MFFuSnZkM05sY2lBdklHSjFhV3hrVEc5bmIzVjBRMmhoYVc1VmNtd2dLT3V6dGVxMXJPdUtsQ0JuYVhRZzdaNkk3SXFrN1lhZzY2YXNLUzROQ2k4dklPS1VnT0tVZ0NEcm9aenF0N2pzbmJqc25ZQWdRMHhKNnJDQUlPcTRzT3V6dUNEcnVJenJuYnpzbXJEc29JRHJwYndnN0tlQjdLQ1JJT3lYdE9xeWpDRHRsWnpyaTZRZ0tESXdNall0TURnc0lFSlNTVVJIUlY5V1BUTXdLU0RpbElEaWxJQU5DaTh2SU95YXNPdW1yT3F3Z0NCQ1VrOVhVMFZTNjZXOElPcXdnT3Vobk95eGhPcXhzT3VDbUNEc3NMM3NuWVFnNnJPbzY1MjhJT3lYck91S2xDRHNpNXpyajRUcmlwUWdLaXJzb0lUcnRvQWc3SXVrN1l5bzdaVzA3SVNjSU91UW1PdVBqT3VndU91THBDb3FMaURyZ3FqcXVMUWc2cldRN1p1SU9nMEtMeThnSUNEaWthQWdRbEpQVjFORlVpRHRsYmpyazZUcm42enJvWndnVlZKTTdKMkVJT3V3bSt5Y3ZPdXB0Q0JqYldUcXNJQWdZQ1pnN0plUTdJU2NJT3llbU91ZHZPdW91ZXVLbE91THBDRGlocElnWTJ4cFpXNTBYMmxrSU95R2pPeUxwQ2dpN0o2WTY2cTc2NUNjSUU5QmRYUm9JT3lhbE95eXJTSXBMZzBLTHk4Z0lDRGlrYUVnUWxKUFYxTkZVdXVsdkNCdWJ5MXZjT3ljdk91aG5DRHJwNG5xczZBZ2MzUmtiM1YwN0oyWUlGVlNUT3lkaENEc21yRHJwcXpxc0lBZzdKZTA2Nm0wSUNvcTdJcTU3SjI0SU91U3BDRHNuYmpzcHAzc3ZaVHJrNXpycGJ3ZzY3YVo3SmVzNjRTajdKeTg2NTI4NjRxVUlPMlpsT3VwdENvcTdKMjBEUW92THlBZ0lDQWdJT3Vjck91THBDanNpNlRzdUtFZzdJdWc2ck9nT2lBaTdKMjA2NSt3SU9xeHNDRHNsNGJzbDRqcmlwVHJqYkFnNnJDUjdKNlE2cml3SU95Wm5DRHNnNTNxc3FnaUtTRGlnSlFnN0o2UTY0K1pJT3lJbU91Z3VleWR0Q0RxdWFqc3A0VHJpNlF1RFFvdkx5QWdJT0tSb2lEc2k1enRnYXpycHI4ZzdMQzk3Snk4NjZHY0lPeVh0T3VncE91cHRDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKcXc2NmFzNnJDQUlPcXpxT3Vkdk95VnZDRHRsYlRzaEp3Z0tpcnF1TERyczdnZzY3aU02NTI4N0pxdzdLQ0E2ckNBSU95VmhPdUxqQ0R0Z2F6cm9hekN0K3lYbyt5bmdPcXdnQ0RzbDdUcnByRHJpNlFxS2cwS0x5OGdJQ0FnSUNBbzdJdWs3TGloSU95TG9PcXpvRG9nSXV5Wm5DRHRnYXpyb2F6c25MenJvWndnN0plMDY2Q2tJaXdnSXVxNHNPdXp1Q0RydUl6cm5ienNtckRzb0lEcm9ad2c3WldZNjUyODY0dUk2cm1NSWlrdUlPcXlqT3VMcE9xd2dDRHF1TERyczdnZzY3aU02NTI4N0pxdzdLQ0E2ckNBSU95TG5PMkJyT3VtdncwS0x5OGdJQ0FnSUNEc25ianNucERycGJ3ZzY2eTA3SXVjN1pXWTY2bTBLT3lDdk95RXNTRHNuYmp0aExEcmhMY2c3SXVrN0xpaEtTRHNuYnpyc0pnZzdMQzk3SjIwSU91V29DRHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPcTN1T3VNZ091aG5PdUxwQzROQ2k4dklPcTN1T3VlbU95RW5DQXFLa0pTVDFkVFJWTHJwYndnNnJHMDY1T2M2NmFzN0tlQUlPeVZpdXVLbE91THBDb3FJT0tBbENCamJHRjFaR1VnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA2ck9nSUd4dlkyRnNhRzl6ZE91aG5DRHFzckRxczd6cnBid2c3SjZRNjQrWkRRb3ZMeURzaUpqcm9MbnRsWnpyaTZRbzdMMlU2NU9jSU91Mm1leVhyT3VFbytxNHNDRHNsNGJzbll3cExpRHFzNFRzb0pVZzdLQ0U3Wm1ZN0oyQUlPeUt1ZXlkdUNEdG1aVHJxYlFnN1pXWTY0dW9JRnZxczRUc29KVWc3S0NFN1ptWVhTRHJzb1R0aXJ6c25MenJvWndnN1pXYzY0dWtMZzBLTHk4Z0tpcnNuYlFnNnJLOTY2R2M3SmVRSUZWU1RDRHFzSURxczdYQ3QreWtrZXF3aENEc2lxVHRnYXpycHIzdGlyakN0K3U0ak91ZHZPeWFzT3lnZ0NEc3A0RHNvSlhzbllRZzY0dWs3SXVjSU91RW8reW5nQ0RycDVBZzZyS0RMaW9xRFFvTkNpOHZJT0tVZ09LVWdDQkNVazlYVTBWU0lPcXdnT3Vobk95eGhPcTRzT3VLbENEc29KenFzYkRya0pEcmk2UWdLREl3TWpZdE1EZ3NJRUpTU1VSSFJWOVdQVEkxS1NEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFOQ2k4dklPeVlpT3lnaE95WGxDQkNVazlYVTBWU0lPMlptT3F5dmV1emdPeUltT3lYa0NEc25vVHNpNXdnN0lxazdZR3M2NmE5N1lxNDY2VzhJT3E5Z3V5VmhDQkRURW5xc0lBZzdLU0FJR0YxZEdodmNtbDZaU0JWVWt6c25ZUWc3SnF3NjZhczZyQ0FJT3V3bSt5VmhPeUVuQ0RzbDdUc2w0anJpNlF1RFFvdkx5RHJxcW5zb0lIc25ZQWc3WldZNjRLWTY3K1E3SjIwN0plSTY0dWtJT0tBbENEcXM0VHNvSlVnN0tDRTdabVk3SnFwN0p5ODY2R2NJRlZTVE95ZGhDQmpiR0YxWkdVdVlXa3ZiRzluYjNWMFAzSmxkSFZ5YmxSdlBlS0FwdXVobkNEc25xenNucEhzaExIdGxiUU5DaTh2SU95S3VleWR1Q0R0bVpUcnFiVHNuWVFnNnJHMDY0U0k2NXV3NnJPZ0lPcXpoT3lnbFNEc2hLRHRnNTBnN1ptVTY2bTA3SmVRSU95bmdlMldpZXlMbk8yQ3BPcTRzQzRnNnJlNElPeWVyT3lla2V5RXNleWRoQ0R0ajVEcXVMRHRsWmpzbnBBbzdJS3M3SnFwN0o2UUlPcXlzT3lnbFNrZzdaVzQ2NU9rNjUrczY0cVVEUW92THlEcnFxbnNvSUhzbmJRZzdKZUc3SmEwN0tHTTZyT2dMQ0FxS3V1Q3FPcXlxQ0Rya1pEcnFiUWc3SmlrN1o2STY2Q2tJT3Vobk9xM3VPeWR1T3lkaENEcnA1M3FzSURybktqcnByRHJpNlFxS2pvTkNpOHZJQ0FnUTB4SjZyQ0FJRlZTVE95ZGhDRHJsTERzbUxUdGtad2c3SmVHN0oyMElPdUVtT3E0c091cHRDQmpiV1Rxc0lBZ1lDWmc3SmVRN0lTY0lGVlNUT3lkaENEc25wanJuYndnNjdLRTY2Q2tLT3ljaU91UGhPeWFzQ2tnWTJ4cFpXNTBYMmxrSU9xd21leWRnQ0Rya3FUc3FyME5DaTh2SUNBZzY2ZWs2ckNjNjdPQTdJaVk2ckNBSU95Q3JPdWR2T3luZ09xem9Dd2c2N2lNNjUyODdKcXc3S0NBN0plVUlDTHNucGpycXJ2cmtKd2dUMEYxZEdnZzdKcVU3TEt0SU1LM0lHTnNhV1Z1ZEY5cFpDRHJwNlRxc0p6cnM0RHNpSmpxc0lBZzY0aUU2NTI5NjVDWTdKZUk3SXExNjR1STY0dWtJdXF3Z0NEcm5LenJpNlF1RFFvdkx5QWdJT3lMck8yVm1PdXB0Q0RydUl6cm5ienNtckRzb0lEcXNJQWc3SldFN0ppSUlPeVZpQ0RzbDdUcnByRHJpNlFvN0l1azdMaWhJREl3TWpZdE1EZzZJRU5NU1NEdGxJVHJvWnpzaExqc2lxVHJpcFFnNjR5QTZyaXdJT3lra2V5ZHVPdU5zQ0Rzc0wzc25iUWc3SldJSU91Y3VDa3VEUW92THlEc25iVHNvSndnUWxKUFYxTkZVdXVsdkNEcXNiVHJrNXpycHF6c3A0QWc3SldLNjRxVTY0dWtJT0tHa2lCamJHRjFaR1VnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdLZUI3S0NSSU95WHNPdUxwQ2hEVEVrZzZyaXc2N080SU91UG1leWVrU2t1RFFvdkx5QXFLdXlkdENEcXNyM3JvWnpzbDVBZ1ZWSk1JT3F3Z09xenRjSzM3S1NSNnJDRUlPeUtwTzJCck91bXZlMkt1T3VsdkNEcmk2VHNpNXdnNjRTajdLZUFJT3Vua0NEcXNvTXVLaW9nNnJPRTdLQ1ZJT3lnaE8yWm1PeWRnQ0RzaXJuc25iZ2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjBnNjdLRTdZcTg3Snk4NjZHY0xnMEtEUW92THlEcnVJenJuYnpzbXJEc29JQWc2NkdjNnJlNDdKMjRJTzJVaE91aG5PeUV1T3lLcENBb1kyeGhkV1JsSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFTa2c0b0NVSUM5dmNHVnVMV3h2WjJsdTdKMjBJT3lEbmV5RXNjSzM2clNBNjZhc0xnMEtMeThnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJR3h2WTJGc2FHOXpkT3VobkNEcXNyRHFzN3pycGJ3ZzY3TzA2NEswN0tTRUlPdVZqT3E1ak95bmdDRHNpS2pzbHJUc2hKd2c2NHlBNnJpdzdaV1k2NHVrNnJDQUxDRHNtWVRybzR6cmtKanJxYlFnN0lxazdJcWs2NkdjSU91Qm5ldUNuT3VMcEM0TkNteGxkQ0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPdzBLYkdWMElHeHZaMmx1VUhKdlkxUnBiV1Z5SUQwZ2JuVnNiRHNOQ214bGRDQnNiMmRwYmxOMFlYSjBaV1JCZENBOUlEQTdJQzh2SU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25iZ2c3SXVjN0o2UklPeUxuT3F3Z1NEaWdKUWc3SjZzN1lHMDY2YXQ3SjIwSUNmc25xenNpNXpyajRRbjdKMjQ3S2VBSUNmc25wRHJqNW5zbVlUcm80d2c3SXVrN1l5b0oreWR1T3luZ0NEcXRhenJ0b1R0bFp6cmk2UU5DaTh2SU95ZHRPdXlpQ0Ryb1p6cXQ3anNuYmpzbDVEc2hKd2c2N2lNNjUyODdKcXc3S0NBSU95d3ZleWRoQ0RzaTZUc29KenJvWndnNjUyRTdKdWc2NHFVNnJDQUlPS0FsQ0R0aExEcnI3anJoSkFnN1krMDY3Q3g3SjJBSU95ZHRPcXlqQ0JtWVd4elpleWR2Q0RybFl6cnA0d2c3Sk8wNjR1a0RRb3ZMeUFvN0l1YzZyQ0U2NmVNN0p5ODY2R2NJTzJNa091THFPMlZtT3VwdENEc29KWHNnNEVnN0o2czdZRzA2NmF0N0plUTY0K0VJR050WkNEc3NMM3NuYlFnN1lxQTdKYTA2NEtZN0ppbzY0dWtLUTBLYkdWMElHeHZaMmx1VjJsdVpHOTNUM0JsYm1Wa0lEMGdabUZzYzJVN0RRcG1kVzVqZEdsdmJpQnJhV3hzVEc5bmFXNVFjbTlqS0NrZ2V3MEtJQ0JwWmlBb2JHOW5hVzVRY205alZHbHRaWElwSUhzZ1kyeGxZWEpVYVcxbGIzVjBLR3h2WjJsdVVISnZZMVJwYldWeUtUc2diRzluYVc1UWNtOWpWR2x0WlhJZ1BTQnVkV3hzT3lCOURRb2dJR2xtSUNnaGJHOW5hVzVRY205aktTQnlaWFIxY200N0RRb2dJR052Ym5OMElIQWdQU0JzYjJkcGJsQnliMk03RFFvZ0lHeHZaMmx1VUhKdll5QTlJRzUxYkd3N0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2QzYVc0ek1pY3BJSHNOQ2lBZ0lDQWdJQzh2SUhScGJXVnZkWFE2SUd0cGJHeFFjbTlqNnJPOElPcXdtZXlkZ0NEc25iVHNuS0FnNG9DVUlPeWloZXVqakNEcXNyM3JvWnpzbDVEc2hKd2dkR0Z6YTJ0cGJHenNuYlFnNjZtSTdMYVU2Nm0wSU91THBPdW1yT3F3Z0NEc2xyenNsclRydHBucmlwVHJpNlFOQ2lBZ0lDQWdJSE53WVhkdVUzbHVZeWduZEdGemEydHBiR3duTENCYkp5OVFTVVFuTENCVGRISnBibWNvY0M1d2FXUXBMQ0FuTDFRbkxDQW5MMFluWFN3Z2V5QnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIUnBiV1Z2ZFhRNklEUXdNREFzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcE93MEtJQ0FnSUgwZ1pXeHpaU0I3RFFvZ0lDQWdJQ0IwY25rZ2V5QndjbTlqWlhOekxtdHBiR3dvTFhBdWNHbGtMQ0FuVTBsSFZFVlNUU2NwT3lCOUlHTmhkR05vSUNoZlpUSXBJSHNnY0M1cmFXeHNLQ2s3SUgwTkNpQWdJQ0I5RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdXN0T3lMbkNBcUx5QjlEUXA5RFFvTkNpOHZJTzJFdENEcmo0VHNwSkVnN1lHMDY2R2M2NU9jSU8yVWhPdWhuT3lFdU95S3BPcXdnQ0Rzbzczc2w0anNuWVFnNjVXTTdKMllJT3lMcE8yTXFDRHJxWlRzaTV6c3A0QWc0b0NVSUhKMWJsUjFjbTdzbmJRZzdKMjBJT3VwbE95TG5PeW5nT3lkdkNEcmxZenJwNHdnTWUyYWpDRHNucERyajVrZzdKNnM3SXVjNjQrRTdaV2M2NHVrRFFwamIyNXpkQ0JUUlZOVFNVOU9YMFJKUlVRZ1BTQW43WUcwNjZHYzY1T2NJT3lFdU95Rm1PeWR0Q0Rzb29Ycm80enJrSkRzbHJUc21wUXVKenNOQ214bGRDQnphSFYwZEdsdVowUnZkMjRnUFNCbVlXeHpaVHNnTHk4Z0wzTm9kWFJrYjNkdUlPeW5oTzJXaVNEc3BKRWc0b0NVSU95ZXJPeUxuT3VQaE91aG5DRHNoTGpzaFpqc25ZUWc2NUNZN0lLMDY2YXM3S2VBSU95Vml1cXlqQ0R0a1p6c2k1d05DZzBLTHk4Z2NtVmhjMjl1N0oyRUlPeWp2T3VwdENBbjdKMlk2NCtFN0tDQklPeWloZXVqakNjbzZyT0U3S0NWSU95Z2hPMlptTUszNjZHYzZyZTQ3SldFN0p1RElPdVRzU2tnNG9DVUlPeW5oTzJXaVNEc3BKSHNuYlRyalpnZzdZUzA3SjJFSU9xM3VDRHJxWlRzaTV6c3A0RHJvWndnNjRHZDY0SzA3SVNjRFFvdkx5QnlkVzVVZFhKdTdKMllJRk5GVTFOSlQwNWZSRWxGUkNEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURzbnBEcXNxbnNwcDNycW9Yc25MenJvWndnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtck95bmdDRHNsWXJxc293ZzdaV2M2NHVrTGcwS0x5OGdLT3lWaUNEcXQ3anJuNnpycWJRZzZyT0U3S0NWSU95Z2hPMlptQ0RzcDRIdG00UWc3SmliSU9xemhPeWdsU0RzaExqc2haanNuYlFnNjdhQTdabWM3WlcwSUUxQldGOVVWVkpPVStxNWpPeW5nQ0RxczRUc2hvMGc3Sk93N0oyMDY0cVVJT3V5aE9xM3VDRGlnSlFnTWpBeU5pMHdOeURycHF6cnQ3RHNsNURzaEp3ZzdabVY3SjI0S1EwS1puVnVZM1JwYjI0Z2EybHNiRkJ5YjJNb2NtVmhjMjl1S1NCN0RRb2dJR2xtSUNod2NtOWpLU0I3RFFvZ0lDQWdkSEo1SUhzTkNpQWdJQ0FnSUdsbUlDaHdjbTlqWlhOekxuQnNZWFJtYjNKdElEMDlQU0FuZDJsdU16SW5LU0I3RFFvZ0lDQWdJQ0FnSUM4dklITm9aV3hzT25SeWRXWHJvWndnNjUyRTdKdU03SVNjSUhCeWIyUHNuWUFnWTIxa0lPcTdqZXVOc09xNHNDRGlnSlFnTDFUcm9ad2c3WXE0NjZhczdLZTRJT3lqdmV5WHJPeVZ2Q0RzcDRUc3A1d2dZMnhoZFdSbDZyQ0FJT3F6b095VmhPdWhuQ0RzbFlnZzY0S282NHFVNjR1a0RRb2dJQ0FnSUNBZ0lDOHZJQ2pxczZEc2xZUWdZMnhoZFdSbDZyQ0FJT3lFcE95NW1DRHRqSXpzbmJ6c25ZUWc2Nnk4NnJPZ0lPeWVpT3ljdk91cHRDRHRnYlRyb1p6cms1d2c3Sld4SU95WGhldU5zT3lkdE8yS3VPcXdnQ0FpN0lLczdKcXBJT3lra1NMc25MenJvWndnNjZlSjdaNllLUTBLSUNBZ0lDQWdJQ0F2THlEaW1xRHZ1SThnZEdsdFpXOTFkQ0R0bFlUc2lKZ2dLREl3TWpZdE1EZ2c3SXVrN0xpaEtUb2c3SjIwSUhOd1lYZHVVM2x1WSt1S2xDQndjbTlqWlhOekxtOXVLQ2RsZUdsMEp5bnNsNURzaEp6cmo0UWc2N2FJNjZhczY0cVU2NDJ3TEEwS0lDQWdJQ0FnSUNBdkx5RHNsWWdnN0tPOTY0cVVJR05zWVhWa1pTRHRpcmpycHF6cnBid2c2NmVNNjRLWUlIUmhjMnRyYVd4czdKMjBJT3VwaU95MmxPdXB0Q0FxS3V1THBPdW1yT3F3Z0NEc29vWHJvNHdnNjQrRTdLU1I3SmVRSU95V3ZPeVd0T3UybWV1S2xPdUxwQ29xSU9LQWxBMEtJQ0FnSUNBZ0lDQXZMeUR0ajZ6dGlyZ2dNVEU0T0Rqc25ZQWc2ck9FN0lhTklPdXN2T3F6b0NEc25aSHJpN1hzbllBZzY2cTdJTzJWbU91S2xDRHNnNEh0ZzV6cXNJQWc2NUNZN0phMExDRHNnNGdnN0oyNDdJcWs3WVMwN0lxazY0cVVJRVZCUkVSU1NVNVZVMFhyb1p3ZzY2eTg2NStzNjRLWTZyT2dEUW9nSUNBZ0lDQWdJQzh2SU8yVWpPdWZyT3EzdU95ZHVPeVhsQ0FpN1lHMDY2R2M2NU9jNnJDQUlPeVhzT3VQbWV1UW1PeW5nQ0RzbFlyc2xaanNsclRzbXBRaTY2ZU1JT3Vjck91THBDZzBNT3UyaE9xd2hDRHF0N2dnN0lPQjdZT2M3SmlBNjQyWUlPeUxwT3k0b1NEc2dxenJvWUFwTGcwS0lDQWdJQ0FnSUNCemNHRjNibE41Ym1Nb0ozUmhjMnRyYVd4c0p5d2dXeWN2VUVsRUp5d2dVM1J5YVc1bktIQnliMk11Y0dsa0tTd2dKeTlVSnl3Z0p5OUdKMTBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuTENCMGFXMWxiM1YwT2lBME1EQXdMQ0IzYVc1a2IzZHpTR2xrWlRvZ2RISjFaU0I5S1RzTkNpQWdJQ0FnSUgwZ1pXeHpaU0I3RFFvZ0lDQWdJQ0FnSUM4dklHMWhZMDlUTCt1bXJPdUloZXlLcERvZ2MyaGxiR3c2ZEhKMVpldWR2Q0J3Y205ajdKMjBJSE5vSU9xN2pldU5zT3E0c095ZHZDRHNpSmdnN0o2STdKMk1JT0tBbENCemRHRnlkRkJ5YjJQc25aZ2daR1YwWVdOb1pXVHJvWndnNjZlTTY1T2dEUW9nSUNBZ0lDQWdJQzh2SU8yVWhPdWhuT3lFdU95S3BDRHF0N2pybzdrb0xYQnBaQ25zbllRZzdZYTE3S2U0NjZHY0lPeWdsZXVtck8yVm5PdUxwQ0FvZEdGemEydHBiR3dnTDFRZzY0eUE3SjJSS1EwS0lDQWdJQ0FnSUNCMGNua2dleUJ3Y205alpYTnpMbXRwYkd3b0xYQnliMk11Y0dsa0xDQW5VMGxIVkVWU1RTY3BPeUI5SUdOaGRHTm9JQ2hmWlRJcElIc2djSEp2WXk1cmFXeHNLQ2s3SUgwTkNpQWdJQ0FnSUgwTkNpQWdJQ0I5SUdOaGRHTm9JQ2hmWlNrZ2V5QXZLaURyckxUc2k1d2dLaThnZlEwS0lDQjlEUW9nSUhCeWIyTWdQU0J1ZFd4c093MEtJQ0IzWVhKdFpXUlZjQ0E5SUdaaGJITmxPdzBLSUNCcFppQW9kMkZwZEdWeUtTQjdJR05zWldGeVZHbHRaVzkxZENoM1lXbDBaWEl1ZEdsdFpYSXBPeUIzWVdsMFpYSXVjbVZxWldOMEtHNWxkeUJGY25KdmNpaHlaV0Z6YjI0Z2ZId2dVMFZUVTBsUFRsOUVTVVZFS1NrN0lIZGhhWFJsY2lBOUlHNTFiR3c3SUgwTkNuME5DZzBLWm5WdVkzUnBiMjRnYzNSaGNuUlFjbTlqS0NrZ2V3MEtJQ0JyYVd4c1VISnZZeWdwT3cwS0lDQnNhVzVsUW5WbUlEMGdKeWM3RFFvZ0lIUjFjbTV6SUQwZ01Ec05DaUFnTHk4ZzdKMjBJT3lFdU95Rm1PeWR0Q0RzbHJUcmlwQWc2ck9FN0tDVjdKMllJT3llaGV5ZXBlcTJqT3ljdk91aG5DRHJqNFRyaXBUc3A0QWc2cml3NjZHZElPS0FsQ0Ryc0pic2w1RHNoSndnNnJPRTdLQ1Y3SjIwSU91d2xPdUFqT3lYaU91S2xPeW5nQ0RydVlUcXRaRHRsWmpyaXBRZzZyaXc3S1NBRFFvZ0lITmxjM05wYjI1QlkyTnZkVzUwSUQwZ1kyeGhkV1JsUVdOamIzVnVkQ2dwT3cwS0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU95RXVPeUZtQ0RzaTV6cmo1a2c3S1NSNG9DbUlDanJxcWpyamJnNklDY2dLeUJqZFhKeVpXNTBUVzlrWld3Z0t5QW5LU2NwT3cwS0lDQmpiMjV6ZENCMGFHbHpVSEp2WXlBOUlITndZWGR1S0NkamJHRjFaR1VuTENCYkp5MXdKeXdnSnkwdGJXOWtaV3duTENCamRYSnlaVzUwVFc5a1pXd3NJQ2N0TFdsdWNIVjBMV1p2Y20xaGRDY3NJQ2R6ZEhKbFlXMHRhbk52Ymljc0lDY3RMVzkxZEhCMWRDMW1iM0p0WVhRbkxDQW5jM1J5WldGdExXcHpiMjRuTENBbkxTMTJaWEppYjNObEoxMHNJSHNOQ2lBZ0lDQnphR1ZzYkRvZ2RISjFaU3dnWTNka09pQkZUVkJVV1Y5RFYwUXNJR1Z1ZGpvZ1EweEJWVVJGWDBWT1Zpd05DaUFnSUNCa1pYUmhZMmhsWkRvZ2NISnZZMlZ6Y3k1d2JHRjBabTl5YlNBaFBUMGdKM2RwYmpNeUp5d2dMeThnVUU5VFNWZzZJT3lla09xNHNDRHRsSVRyb1p6c2hManNpcVFnNnJlNDY2TzVJT3lEbmV5RXNTRGlnSlFnYTJsc2JGQnliMlBzbmJRZzZyZTQ2Nk81N0tlNElPeWdsZXVtck8yVm9DRHNpSmdnN0o2STZyS01EUW9nSUgwcE93MEtJQ0J3Y205aklEMGdkR2hwYzFCeWIyTTdEUW9nSUhCeWIyTXVjM1JrYjNWMExtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc05DaUFnSUNCc2FXNWxRblZtSUNzOUlHUXVkRzlUZEhKcGJtY29KM1YwWmpnbktUc05DaUFnSUNCc1pYUWdhV1I0T3cwS0lDQWdJSGRvYVd4bElDZ29hV1I0SUQwZ2JHbHVaVUoxWmk1cGJtUmxlRTltS0NkY2JpY3BLU0FoUFQwZ0xURXBJSHNOQ2lBZ0lDQWdJR052Ym5OMElHeHBibVVnUFNCc2FXNWxRblZtTG5Oc2FXTmxLREFzSUdsa2VDa3VkSEpwYlNncE93MEtJQ0FnSUNBZ2JHbHVaVUoxWmlBOUlHeHBibVZDZFdZdWMyeHBZMlVvYVdSNElDc2dNU2s3RFFvZ0lDQWdJQ0JwWmlBb0lXeHBibVVwSUdOdmJuUnBiblZsT3cwS0lDQWdJQ0FnYkdWMElHVjJJRDBnYm5Wc2JEc05DaUFnSUNBZ0lIUnllU0I3SUdWMklEMGdTbE5QVGk1d1lYSnpaU2hzYVc1bEtUc2dmU0JqWVhSamFDQW9YMlVwSUhzZ1kyOXVkR2x1ZFdVN0lIME5DaUFnSUNBZ0lHbG1JQ2hsZGlBbUppQmxkaTUwZVhCbElEMDlQU0FuY21WemRXeDBKeUFtSmlCM1lXbDBaWElwSUhzTkNpQWdJQ0FnSUNBZ1kyOXVjM1FnZHlBOUlIZGhhWFJsY2pzTkNpQWdJQ0FnSUNBZ2QyRnBkR1Z5SUQwZ2JuVnNiRHNOQ2lBZ0lDQWdJQ0FnWTJ4bFlYSlVhVzFsYjNWMEtIY3VkR2x0WlhJcE93MEtJQ0FnSUNBZ0lDQnBaaUFvWlhZdWFYTmZaWEp5YjNJcElIc05DaUFnSUNBZ0lDQWdJQ0JqYjI1emRDQnlZWGNnUFNCVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElHVjJMbk4xWW5SNWNHVWdmSHdnSnljcExuTnNhV05sS0RBc0lESXdNQ2s3RFFvZ0lDQWdJQ0FnSUNBZ0x5OGc3WldjNjQrRUlPeTBpT3F6dk91bHZDRHJxTHpzb0lBZzY3TzQ2NHVrSU9LQWxDRHJvWnpxdDdqc25iZ2c3SmlrNjZXWUlPeWdsZXEzbk95TG5leWR0Q0RyaEpQc2xyVHNoSndvYkc5bklEOXBiaURyazdFcElPdXN1T3Exck9xd2dDRHJzSlRyZ0l6cnFiUWc3SUs4N1lLc0lPeUltQ0Rzbm9qcmk2UU5DaUFnSUNBZ0lDQWdJQ0JwWmlBb2FYTk1hVzFwZEVWeWNtOXlLSEpoZHlrcElIc05DaUFnSUNBZ0lDQWdJQ0FnSUdOc1lYVmtaVk4wWVhSMWN5QTlJQ2RqYkdGMVpHVXRiR2x0YVhRbk95QXZMeUF2YUdWaGJIUm82NkdjSU95VmpPdW12Q0RpaHBJZzY3S0U3WXE4N0oyMElGdnRsWnpyajRRZzdMU0k2ck84WGV1aG5DRHJzSlRyZ0l6cXM2QWc2ck9FN0tDVklPeWdoTzJabU95ZGhDRHNsWWpyZ3JRTkNpQWdJQ0FnSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzdJS3M3SnFwSU8yVm5PdVBoQ0RzdElqcXM3d2c2ckNRN0tlQU9pY3NJSEpoZHlrN0RRb2dJQ0FnSUNBZ0lDQWdJQ0IzTG5KbGFtVmpkQ2h1WlhjZ1JYSnliM0lvVEVsTlNWUmZSMVZKUkVVcEtUc05DaUFnSUNBZ0lDQWdJQ0I5SUdWc2MyVWdhV1lnS0dselFYVjBhRVZ5Y205eUtISmhkeWtwSUhzTkNpQWdJQ0FnSUNBZ0lDQWdJR05zWVhWa1pWTjBZWFIxY3lBOUlDZGpiR0YxWkdVdGJHOW5iM1YwSnpzZ0x5OGdMMmhsWVd4MGFPdWhuQ0R0bEl6cm42enF0N2pzbmJqc2w1QWc3SldNNjZhOElPS0draURyc29UdGlyenNuYlFnVyt1aG5PcTN1T3lkdUNEdGxZVHNtcFJkNjZHY0lPdXdsT3VBbkEwS0lDQWdJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yQnRPdWhuT3VUbkNEcm9aenF0N2pzbmJnZzY2ZU02Nk9NSU9xd2tPeW5nRG9uTENCeVlYY3BPdzBLSUNBZ0lDQWdJQ0FnSUNBZ2R5NXlaV3BsWTNRb2JtVjNJRVZ5Y205eUtFeFBSMGxPWDBkVlNVUkZLU2s3RFFvZ0lDQWdJQ0FnSUNBZ2ZTQmxiSE5sSUhzTkNpQWdJQ0FnSUNBZ0lDQWdJSGN1Y21WcVpXTjBLRzVsZHlCRmNuSnZjaWduN1lHMDY2R2M2NU9jSU95WXBPdWxtRG9nSnlBcklISmhkeWtwT3cwS0lDQWdJQ0FnSUNBZ0lIME5DaUFnSUNBZ0lDQWdmU0JsYkhObElIc05DaUFnSUNBZ0lDQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQW5iMnNuT3lBdkx5RHNoTEhxczdVZ1BTRHNoS1RzdVpqQ3QrdWhuT3EzdU95ZHVDRHJpNlFnN0tDVjdJT0JJT0tBbENEc2xyVHJscVFnY0hKdllteGxiZXlkdE91VG9DRHRsYlRzb0p3Z0tPeWVyT3Vobk9xM3VPeWR1Qy9zbnF6c2hLVHN1WmdnNjdPMTZyZUFLUTBLSUNBZ0lDQWdJQ0FnSUhjdWNtVnpiMngyWlNoVGRISnBibWNvWlhZdWNtVnpkV3gwSUh4OElDY25LU2s3RFFvZ0lDQWdJQ0FnSUgwTkNpQWdJQ0FnSUgwTkNpQWdJQ0I5RFFvZ0lIMHBPdzBLSUNCd2NtOWpMbk4wWkdWeWNpNXZiaWduWkdGMFlTY3NJQ2hrS1NBOVBpQjdEUW9nSUNBZ1kyOXVjM1FnY3lBOUlHUXVkRzlUZEhKcGJtY29KM1YwWmpnbktTNTBjbWx0S0NrN0RRb2dJQ0FnYVdZZ0tITWdKaVlnSVhNdWFXNWpiSFZrWlhNb0owUmxjSEpsWTJGMGFXOXVWMkZ5Ym1sdVp5Y3BLU0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZ1kyeGhkV1JsSUhOMFpHVnljam9uTENCekxuTnNhV05sS0RBc0lESXdNQ2twT3cwS0lDQjlLVHNOQ2lBZ2NISnZZeTV2YmlnblkyeHZjMlVuTENBb1kyOWtaU2tnUFQ0Z2V3MEtJQ0FnSUM4dklPeWR0T3V2dUNEc2c0Z2c3SVM0N0lXWTdKeTg2NkdjSU9xMWtPeXl0T3VRbkNEcmtxUWc3SmliSU95RXVPeUZtT3lkdENEcmk2dnRub3dnNnJHdzY2bTBJT3VzdE95TG5DQW82NnFvNjQyNElPeWdoTzJabUNEc2k1d2c3SU9JSU95RXVPeUZtT3lkaENEc283M3NuYlRzcDRBZzdKV0s2cktNS1EwS0lDQWdJR2xtSUNod2NtOWpJQ0U5UFNCMGFHbHpVSEp2WXlrZ2NtVjBkWEp1T3cwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGdiVHJvWnpyazV3ZzdJUzQ3SVdZSU95aWhldWpqQ0FvWTI5a1pTQW5JQ3NnWTI5a1pTQXJJQ2NwSU9LQWxDRHJpNlRzbll3ZzdKcVU3TEt0SU91VmpDRHJpNlRzaTV3ZzdJdWM2NCtaN1pXcDY0dUk2NHVrTGljcE93MEtJQ0FnSUd0cGJHeFFjbTlqS0NrN0RRb2dJSDBwT3cwS2ZRMEtEUXBtZFc1amRHbHZiaUJ6Wlc1a1ZIVnliaWgwWlhoMEtTQjdEUW9nSUhKbGRIVnliaUJ1WlhjZ1VISnZiV2x6WlNnb2NtVnpiMngyWlN3Z2NtVnFaV04wS1NBOVBpQjdEUW9nSUNBZ2FXWWdLQ0Z3Y205aktTQnlaWFIxY200Z2NtVnFaV04wS0c1bGR5QkZjbkp2Y2lnbjdZRzA2NkdjNjVPY0lPeUV1T3lGbU95ZHRDRHNsNGJzbHJUc21wUXVKeWtwT3cwS0lDQWdJR2xtSUNoM1lXbDBaWElwSUhKbGRIVnliaUJ5WldwbFkzUW9ibVYzSUVWeWNtOXlLQ2ZzbFo3c2hLQWc3SnFVN0xLdDdKMjBJT3luaE8yV2lTRHNwSkhzbmJUc2w1RHNtcFF1SnlrcE93MEtJQ0FnSUdOdmJuTjBJSFJwYldWeUlEMGdjMlYwVkdsdFpXOTFkQ2dvS1NBOVBpQjdEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lTMElPeUxuT3F3aENEc3RJanFzN3dnNG9DVUlPeUV1T3lGbU95ZGhDRHNucXpzaTV6c25wSHRsYW5yaTRqcmk2UXVKeWs3RFFvZ0lDQWdJQ0F2THlEc2k1enFzSVFnN0xTSTZyTzg2NHFVSUNmc2hManNoWmdnN0tLRjY2T01KK3laZ0NEcXRhenJ0b1Rya0pqcmlwUWc3S0NjSU91cGxPeUxuT3luZ091aG5DRHJnWjNyZ3Jqcmk2UWc0b0NVSUd0cGJHeFFjbTlqN0oyWUlPeUV1T3lGbUNEc29vWHJvNHdnY21WcVpXTjA2ckNBRFFvZ0lDQWdJQ0F2THlCeWRXNVVkWEp1N0oyWUlPeWVrT3VQbVNEc25xenNpNXpyajRUcnBid2c2N2FBNjZXMDY2bTBJT3lWaUNEcmtKanF1TEFnNjVXTTY2eTRLT3VLa091bXNDRHRoTFRzbllRZzY1R1FJT3V5aUNEcmo0enJxYlFnN1pTTTY1K3M2cmU0N0oyNElERXpNT3kwaUNEc29KenRsWnpzbllRZzY0U1k2cmkwNjR1a0tRMEtJQ0FnSUNBZ2FXWWdLSGRoYVhSbGNpa2dldzBLSUNBZ0lDQWdJQ0JqYjI1emRDQjNJRDBnZDJGcGRHVnlPeUIzWVdsMFpYSWdQU0J1ZFd4c093MEtJQ0FnSUNBZ0lDQjNMbkpsYW1WamRDaHVaWGNnUlhKeWIzSW9KKzJCdE91aG5PdVRuQ0RzblpIcmk3WHNuYlFnNjRTSTY2eTBJT3lZcE91ZW1DRHFzYmpyb0tRZzdKcVU3TEt0N0oyRUlPeWtrZXVMcU8yV2lPeVd0T3lhbENEaWdKUWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVKeWtwT3cwS0lDQWdJQ0FnZlEwS0lDQWdJQ0FnYTJsc2JGQnliMk1vS1RzTkNpQWdJQ0I5TENCVVZWSk9YMVJKVFVWUFZWUmZUVk1wT3cwS0lDQWdJSGRoYVhSbGNpQTlJSHNnY21WemIyeDJaU3dnY21WcVpXTjBMQ0IwYVcxbGNpQjlPdzBLSUNBZ0lIQnliMk11YzNSa2FXNHVkM0pwZEdVb1NsTlBUaTV6ZEhKcGJtZHBabmtvZXlCMGVYQmxPaUFuZFhObGNpY3NJRzFsYzNOaFoyVTZJSHNnY205c1pUb2dKM1Z6WlhJbkxDQmpiMjUwWlc1ME9pQjBaWGgwSUgwZ2ZTa2dLeUFuWEc0bkxDQW5kWFJtT0NjcE93MEtJQ0I5S1RzTkNuME5DZzBLTHk4ZzZyQ1o3SjJBSU91c3VPcTFyT3VsdkNEcnFvY2c2N0tJN0tlNElPdXN1K3VLbE95bmdDRHF1TERzbHJVZzRvQ1VJT3llck95YWxPeXlyZXlkdE91cHRDQWk3SjIwN0tDRTZyTzhJT3VMcE91bHVDRHNnNGdnN0tDYzdKV0lJdXlkaENEc21wVHF0YXp0bFp6cmk2UU5DaTh2SUNqc2xZZ2c2cmU0NjUrczY2bTBJTzJCdE91aG5PdVRuT3F3Z0NEc2hMSHNpNlR0bFpqcXNvd2c2ckNaN0oyQUlPdUx0ZXlkaENEcm1KQWc2NEswN0lTY0lGdEJTU0RzdHBUc3Nwd2c2NDJVSU91d20rcTRzRjNxc0lBZzY2eTA3SjJZNjYrNDdaVzA3S2VFNjR1a0tRMEtZMjl1YzNRZ1lYTnJaV1JEYjNWdWRDQTlJRzVsZHlCTllYQW9LVHNOQ2cwS0x5OGc3SVM0N0lXWUlPeWtnT3U1aENqc2k1enJqNWtyN0tlQTdJdWM2Nnk0SU95anZPeWVoU25ycGJ3ZzY3TzA3SjZsN1pXY0lPdVNwQ0R0bFp3ZzdZUzBJT3lMcE8yV2lTRGlnSlFnNjZxbzY1T2dJTzJZdU95Mm5PeWRnQ0J4ZFdWMVpldWhuQ0RzcDRIcm9LenRtWlF1RFFvdkx5QnRiMlJsYk95ZGhDRHNvN3pycWJRZzZyZTRJT3VxcU91TnVPdWhuQ0FvNjR1azY2VzA2Nm0wSU95RXVPeUZtQ0RzbnF6c2k1enNucEVwTGlEdGxad2c2NnFvNjQyNDdKMkVJT3F6aE95R2pTRHNrN0RycWJRZzdKNnM3SXVjN0o2UjdKMkFJT3kxbk95MGlDQXg3WnFNNjcrUUxnMEtMeThnY21Wd1lYSnpaVDE3Y0dGeWMyVXNJR1p2Y20xaGRFUmxjMk45NjZXOElPeWp2T3VwdENEdGpJenNpN0hxdVl6c3A0QWc3SjIwSU95ZW9TRHNsWWpzbDVEc2hKd2c3TEtZNjZhczdaV1k2ck9nSUh0eVlYY3NJSEJoY25ObFpIM3JwYndnNjQrTTY2Q2s3S1NBNjR1a09nMEtMeThnN1ppVjdJdWRJT3lkdE8yRGlDRHNpNXdnNnJDWjdKMkFJT3lFdU95Rm1PeVhrQ0FpN1ppVjdJdWQ2NHlBNjZHY0lPdUxwT3lMbkNMcnBid2c3SnFVNnJXczdaV1k2NHFVSU95ZXJPeWFsT3l5clNEdGhMVHNuWVFnS2lycXNKbnNuWUFnN1lHUUlPeWVvU0RzbFlqc2w1RHNoSndxS2lEcnRwbnNuYmpyaTZRdURRb3ZMeURyczRUcmo0UWc3SjZoN0p5ODY2R2NJT3U1dk91cHRDQW9ZU2tnN0lLczdKMjA3SmVRSU91THBPdWx1Q0RzbXBUc3NxMGc3WVMwN0oyMElPdUJ2T3lXdENBbjY3Q3A2cmlJSU91THRTZnNuYlFnNjRLbzdKMllJT3VMdGV5ZHRDRHJrSmpxczZBbzY0SzA3SnFwSU95WXBPeVh2Q2tzRFFvdkx5QW9ZaWtnVFVGWVgxUlZVazVUSU9xeXZlcXpoT3lYa095RW5DRHNoTGpzaFpqc25iUWc3SjZzN0l1YzdKNlI2NCs4SUNmcnNLbnF1SWdnNjR1MUoreWR0Q0RzbDRicmlwUWc3SU9JSU95RXVPeUZtT3lkdENEcmdyVHNtcW5zbllRZzdLZUE3SmEwNjRLOElPeUltQ0Rzbm9qcmk2UWdLREl3TWpZdE1EY2c2NmFzNjdldzdKZVE3SVNjSU8yWmxleWR1Q2t1RFFwamIyNXpkQ0JTUlZCQlVsTkZYMEpCUkNBOUlDaDJLU0E5UGlCMklEMDlJRzUxYkd3Z2ZId2dLRUZ5Y21GNUxtbHpRWEp5WVhrb2Rpa2dKaVlnZGk1c1pXNW5kR2dnUFQwOUlEQXBPdzBLWm5WdVkzUnBiMjRnY25WdVZIVnliaWhpZFdsc1pFRnpheXdnYlc5a1pXd3NJSEpsY0dGeWMyVXBJSHNOQ2lBZ1kyOXVjM1FnYW05aUlEMGdjWFZsZFdVdWRHaGxiaWhoYzNsdVl5QW9LU0E5UGlCN0RRb2dJQ0FnWTI5dWMzUWdhbTlpVTNSaGNuUWdQU0JFWVhSbExtNXZkeWdwT3lBdkx5RHNpNXpxc0lRZzdKaUk3SUt3SU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnN0txOUlPeWduTzJWbkNneE16RHN0SWdwN0oyRUlPdUVtT3E0dUNEc25xenNpNXpyajRUcmlwUWc3WStzNnJpdzdaV2M2NHVrRFFvZ0lDQWdhV1lnS0cxdlpHVnNJQ1ltSUVGTVRFOVhSVVJmVFU5RVJVeFRMbWx1WkdWNFQyWW9iVzlrWld3cElDRTlQU0F0TVNBbUppQnRiMlJsYkNBaFBUMGdZM1Z5Y21WdWRFMXZaR1ZzS1NCN0RRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2NnFvNjQyNElPdXpnT3F5dlRvZ0p5QXJJR04xY25KbGJuUk5iMlJsYkNBcklDY2c0b2FTSUNjZ0t5QnRiMlJsYkNrN0RRb2dJQ0FnSUNCamRYSnlaVzUwVFc5a1pXd2dQU0J0YjJSbGJEc05DaUFnSUNBZ0lITjBZWEowVUhKdll5Z3BPeUF2THlEc2c0Z2c2NnFvNjQyNDY2R2NJT3lFdU95Rm1DRHNucXpzaTV6c25wRWdLT3VMcE95ZGpDRHNtNHpyc0kzc2w0WHNsNURzaEp3ZzdLZUE3SXVjNjZ5NElPeWVyT3lqdk95ZWhTa05DaUFnSUNCOURRb2dJQ0FnYVdZZ0tIUjFjbTV6SUQ0OUlFMUJXRjlVVlZKT1V5QjhmQ0FoY0hKdll5a2djM1JoY25SUWNtOWpLQ2s3RFFvZ0lDQWdhV1lnS0NGM1lYSnRaV1JWY0NrZ2V3MEtJQ0FnSUNBZ1kyOXVjM1FnZERBZ1BTQkVZWFJsTG01dmR5Z3BPdzBLSUNBZ0lDQWdZWGRoYVhRZ2MyVnVaRlIxY200b2FXNXpkSEoxWTNScGIyNU5aWE56WVdkbEtDa3BPdzBLSUNBZ0lDQWdkMkZ5YldWa1ZYQWdQU0IwY25WbE93MEtJQ0FnSUNBZ2RIVnlibk1yS3pzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNoTGpzaFpnZzdLU0E2N21FSU95WmhPdWpqQ0FvSnlBcklDZ29SR0YwWlM1dWIzY29LU0F0SUhRd0tTQXZJREV3TURBcExuUnZSbWw0WldRb01Ta2dLeUFuY3lrZzRvQ1VJT3lkdE8yYmhDRHNtcFRzc3Ezc25ZQWc2N21vNjUyODdKcVVMaWNwT3cwS0lDQWdJSDBOQ2lBZ0lDQjBkWEp1Y3lzck93MEtJQ0FnSUdOdmJuTjBJR0Z6YXlBOUlHSjFhV3hrUVhOcktDazdJQzh2SU95ZXJPeUxuT3VQaENEcmxZd2c2ckNaN0oyQUlPeW5pT3VzdU95ZGhDRHJpNlRzaTV3ZzdKTzA2NHVrSUNoaGMydGxaRU52ZFc1MElPeWR0T3lra1NEc3BwM3FzSUFnNjdDcDdLZUFLUTBLSUNBZ0lHeGxkQ0J5WVhjN0RRb2dJQ0FnZEhKNUlIc05DaUFnSUNBZ0lISmhkeUE5SUdGM1lXbDBJSE5sYm1SVWRYSnVLR0Z6YXlrN0RRb2dJQ0FnZlNCallYUmphQ0FvWlNrZ2V3MEtJQ0FnSUNBZ0x5OGc3WVMwSU91UGhPeWtrU0R0Z2JUcm9aenJrNXdnN1pTRTY2R2M3SVM0N0lxazZyQ0FJT3lqdmV5ZGdDRHFzcjNzbXJBb1UwVlRVMGxQVGw5RVNVVkVLU0F4N1pxTUlPeWVrT3VQbVNEc25xenNpNXpyajRRZzRvQ1VJT3lDck95YXFleWVrT3lYa09xeWtDRHNpNlR0aktqcm9ad2c3SldJSU91enRPeWR0T3F5akM0TkNpQWdJQ0FnSUM4dklPeUxuT3F3aENEc3RJanFzN3pDdCt1aG5PcTN1T3lkdUNEcnA0enJvNHpDdCsyQnRPdWhuT3VUbkNEc21LVHJwWmpDdCt5ZG1PdVBoT3lnZ1NEc29vWHJvNHdvNnJPRTdLQ1ZJT3lnaE8yWm1DL3JvWnpxdDdqc2xZVHNtNE1zSUd0cGJHeFFjbTlqS0hKbFlYTnZiaWtwNjRxVURRb2dJQ0FnSUNBdkx5RHNvSndnNjZtVTdJdWM3S2VBNnJDQUlPdVVzT3VobkNEc25vanNsclFnN0plczZyaXdJT3lWaUNEcXNianJwckRyaTZRdUlPeWloZXVqakNEc21wVHNzcTBnN0tTUjdKMjA2ckd3NjRLWUlPeUxuT3F3aENEc21JanNnckRzbmJRZzdKYTg2NmVJSU95VmlDRHJncWpzbFpqc25MenJxYlFnNjVDWTdJSzA2NmFzN0tlQUlPeVZpdXVLbE91THBDNE5DaUFnSUNBZ0lHbG1JQ2h6YUhWMGRHbHVaMFJ2ZDI0Z2ZId2dJU2hsSUNZbUlHVXViV1Z6YzJGblpTQTlQVDBnVTBWVFUwbFBUbDlFU1VWRUtTQjhmQ0JFWVhSbExtNXZkeWdwSUMwZ2FtOWlVM1JoY25RZ1BpQTBNREF3TUNrZ2RHaHliM2NnWlRzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNoTGpzaFpqc25iUWc3WVMwSU91UGhPeWtrU0RyZ1lycXVZQWc0b0NVSU95ZXJPeUxuT3VQbVNEdG00UWdNZTJhakNEc25xenNpNXpyajRUdGxhbnJpNGpyaTZRdUp5azdEUW9nSUNBZ0lDQnpkR0Z5ZEZCeWIyTW9LVHNOQ2lBZ0lDQWdJR0YzWVdsMElITmxibVJVZFhKdUtHbHVjM1J5ZFdOMGFXOXVUV1Z6YzJGblpTZ3BLVHNOQ2lBZ0lDQWdJSGRoY20xbFpGVndJRDBnZEhKMVpUc05DaUFnSUNBZ0lIUjFjbTV6SUQwZ01qc2dMeThnN0p1TTY3Q043SmVGSURFZ0t5RHNuYlRyc29nZzdZUzBJQ2h6ZEdGeWRGQnliMlBzbmJRZ01PeWN2T3VobkNEc3RJanF1TER0bVpRcERRb2dJQ0FnSUNCeVlYY2dQU0JoZDJGcGRDQnpaVzVrVkhWeWJpaGhjMnNwT3cwS0lDQWdJSDBOQ2lBZ0lDQnBaaUFvSVhKbGNHRnljMlVwSUhKbGRIVnliaUJ5WVhjN0RRb2dJQ0FnYkdWMElIQmhjbk5sWkNBOUlISmxjR0Z5YzJVdWNHRnljMlVvY21GM0tUc05DaUFnSUNBdkx5RHRtSlhzaTUwZzdKMjA3WU9JN0oyMDY2bTBJT3F3bWV5ZGdDRHNoTGpzaFpqQ3QrcXdtZXlkZ0NEc25xSHNsNURzaEp3ZzZyT243SjZsSU95ZXJPeWFsT3l5clNEaWdKUWc3SjIwSU8yRXRPeWR0Q0Rzbzczc25MenJxYlFnN0lPSUlPeUV1T3lGbU95ZGdDQW42N0NwNnJpSUlPdUx0U2ZzbllRZzY2cXc2NTI4RFFvZ0lDQWdMeThnN0tlQTdKYTA2NEs4SU95SW1DRHNub2pzbkx6cnI0RHJvWndnN0lTNDdJV1lJT3lDck91bm5TRHNucXpzaTV6cmo0VHJpcFFnN1pXWTdLZUFJT3lWaXVxem9DRHF0N2pyaklEcm9ad2c3SXVrN1l5bzdJdWM3WUtvNjR1a0tPMk1qT3lMc1NEc2k2VHRqS2pyb1p3ZzZyZUE2ckt3S1M0TkNpQWdJQ0JwWmlBb1VrVlFRVkpUUlY5Q1FVUW9jR0Z5YzJWa0tTQW1KaUJFWVhSbExtNXZkeWdwSUMwZ2FtOWlVM1JoY25RZ1BDQTNNREF3TUNrZ2V3MEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNak95THNTRHNpNlR0aktnZzRvQ1VJTzJZbGV5TG5TRHNucXpzbXBUc3NxMDZKeXdnVTNSeWFXNW5LSEpoZHlrdWMyeHBZMlVvTUN3Z016QXdLU2s3RFFvZ0lDQWdJQ0IwZFhKdWN5c3JPdzBLSUNBZ0lDQWdkSEo1SUhzTkNpQWdJQ0FnSUNBZ2NtRjNJRDBnWVhkaGFYUWdjMlZ1WkZSMWNtNG9KK3V3cWVxNGlDRHJpN1hzbmJRZzdKcVU2cldzN1pXY0lPMllsZXlMbmV5WGtDRHNsclRxdUl2cmdxenJpNlF1SU91d3FlcTRpQ0RyaTdYdGxad2c2NEswN0pxcDdKMkVJT3lFcE91cWhjSzM3SUtzNnJPOHdyZnN2WlRyazV6dGpwenNpcVFnN0plRzdKMjBJT3lWaE91ZW1DQktVMDlPN0p5ODY2R2M2NmVNSU91THBPeUxuQ0RzdHB6cm9LWHRsWmpybmJ3NklDY2dLeUJ5WlhCaGNuTmxMbVp2Y20xaGRFUmxjMk1wT3cwS0lDQWdJQ0FnSUNCd1lYSnpaV1FnUFNCeVpYQmhjbk5sTG5CaGNuTmxLSEpoZHlrN0RRb2dJQ0FnSUNCOUlHTmhkR05vSUNoZlpTa2dleUF2S2lEc25xenNtcFRzc3EwZzdJdWs3WXlvSU9LQWxDRHNsWVRybnBqc2w1RHNoSndnN1l5TTdJdXhJT3lMcE8yTXFPdWhuQ0Rzc3BqcnBxd2dLaThnZlEwS0lDQWdJSDBOQ2lBZ0lDQnBaaUFvVWtWUVFWSlRSVjlDUVVRb2NHRnljMlZrS1NrZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJTzJNak95THNTRHNpNlR0aktnZ0tPeWVyT3lhbE95eXJTRHRtNFRzbDVEcmo0UXBPaWNzSUZOMGNtbHVaeWh5WVhjcExuTnNhV05sS0RBc0lETXdNQ2twT3cwS0lDQWdJSEpsZEhWeWJpQjdJSEpoZHl3Z2NHRnljMlZrT2lCU1JWQkJVbE5GWDBKQlJDaHdZWEp6WldRcElEOGdiblZzYkNBNklIQmhjbk5sWkNCOU93MEtJQ0I5S1RzTkNpQWdMeThnN1pXY0lPeWFsT3l5cmV5ZHRDRHNpNlR0aktqdGxiVHJqNFFnNjR1azdKMk1JT3lhbE95eXJleWR0Q0RzbmJUc2xyVHNwNERyajRUcm9aMGc3WUdRNjRxVUlPMlZyZXlEZ1NEc2hMSHFzN1hzbkx6cm9ad2c3S0NWNjZhc0RRb2dJSEYxWlhWbElEMGdhbTlpTG1OaGRHTm9LQ2dwSUQwK0lIdDlLVHNOQ2lBZ2NtVjBkWEp1SUdwdllqc05DbjBOQ2cwS0x5OGc2N0tFN1lxOElPdWR2T3V5cUNEcXQ1enN1WmtnNG9DVUlPMlVqT3Vmck9xM3VPeWR1T3lkdENBbjY3S0U3WXE4N0oyRUlPcXpxT3Vla091THBDZnFzNkFnN0pXTTY2Q2s3S1NFSU91VmpPdW5qQ0RzbHJucmlwVHJpNlF1RFFvdkx5RHJzb1R0aXJ3ZzY2eTQ2cldzNjRxVUlPdXN1T3llcGV5ZHRDRHNsWVRyaTRqcm5id2c2NCtaN0o2UklPeWR0T3VtaE95ZHRPeVd0T3lFbkN3ZzdKMjBJT3luZ095TG5PcXdnQ0RzbDRic25MenJxYlFnNjZ5NDdKNmw3WmlWSU91TWdPeVZpT3lkdENEc2hKN3NsNndnNjRLWTdKaW82NHVrTGcwS1kyOXVjM1FnUWxWVVZFOU9YMUpWVEVVZ1BRMEtJQ0FuN0oyMElPdXN1T3Exck91S2xDQXFLdXV5aE8yS3ZDRHJuYnpyc3FncUt1eWR0T3VMcEM0ZzY2eTQ3SjZsN0oyMElPeVZoT3VMaU91ZHZDRHJqNW5zbnBFZzdKMjA2NmFFN0oyMDY2K0E2NkdjT2lEcnA0anN1YWp0a1p6Q3QrdXN2T3lkak8yUm5NSzM3S0tGNnJLdzdKYTA2Nis0S0g3c21wUXZmdXVMcEM5KzZybU03SnFVS1NEcXVJanNwNEFzSUNjZ0t3MEtJQ0FuNjVDWTY0K0U2NkdkSU95bnAreWRnQ0RyajVuc25wRWc2NnFGN0lLc0tPeWdnT3llcGNLMzdJS3Q3S0Njd3Jmc2w3RHFzckFnN1pXMDdLQ2NJT3VUc1Nucm9ad3NJTzJHdGV1enRPeUVzU0RyaTZqc25id2c2N0tFN1lxODdKMjA2Nm0wSUNMdG1aWHNuYmdpTGlBbklDc05DaUFnSnlMc3Q2anNob3dpNjRxVUlPdVBtZXlla1NEcnNvVHRpcnpxczd3ZzdLZWQ3SjI4SU91VmpPdW5qQ0RzazdEcXM2QXNJTzJabE91cHRDRHF1TERyaXFYcnFvVW82N09BNnJLOXdyZnRsYlRzb0p3ZzY1T3hLZXlkZ0NEcXQ3anJqSURyb1p3ZzY1R1U2NHVrTGx4dUp6c05DZzBLTHk4ZzY2eTQ2cldzSU95MmxPeXluQ0R0aExRZ0tISnZiR1U5Sit1eWhPMkt2Q2ZzbmJUcnFiUWc2N0tFN1lxOElPcTNuT3k1bWV5ZGhDRHNscm5yaXBUcmk2UXBEUXBtZFc1amRHbHZiaUJoYzJ0RGJHRjFaR1VvZEdWNGRDd2diVzlrWld3c0lISmxjR0Z5YzJVc0lISnZiR1VwSUhzTkNpQWdjbVYwZFhKdUlISjFibFIxY200b0tDa2dQVDRnZXcwS0lDQWdJR052Ym5OMElHRjBkR1Z0Y0hRZ1BTQW9ZWE5yWldSRGIzVnVkQzVuWlhRb2RHVjRkQ2tnZkh3Z01Da2dLeUF4T3cwS0lDQWdJR0Z6YTJWa1EyOTFiblF1YzJWMEtIUmxlSFFzSUdGMGRHVnRjSFFwT3cwS0lDQWdJR2xtSUNoaGMydGxaRU52ZFc1MExuTnBlbVVnUGlBeU1EQXBJR0Z6YTJWa1EyOTFiblF1WTJ4bFlYSW9LVHNnTHk4ZzY2eTA3WldjN1o2SUlPeU1rK3lkdE95bmdDRHNsWXJxc293TkNpQWdJQ0JqYjI1emRDQnlkV3hsSUQwZ2NtOXNaU0E5UFQwZ0ordXloTzJLdkNjZ1B5QkNWVlJVVDA1ZlVsVk1SU0E2SUNjbk93MEtJQ0FnSUhKbGRIVnliaUJ5ZFd4bElDc2dLR0YwZEdWdGNIUWdQaUF4RFFvZ0lDQWdJQ0EvSUNmcXNKbnNuWUFnNjZ5NDZyV3M2Nlc4SU91THBPeUxuQ0RzbXBUc3NxM3RsWnpyaTZRdUlPeWR0Q0RzaExqc2haanNsNURzaEp3ZzdKMjA3S0NFN0plUUlPeWduT3lWaU8yV2lPdU5tQ0Rxc29Qcms2VHFzN3dnNnJLNTdMbVk3S2VBSU95Vml1dUtsQ3dnNnJXczdLR3c2NEtZSU95V3RPMmNtT3F3Z0NEdG1aWHNpNlR0bm9nZzY0dWs2Nlc0SU95RGlPdWhuT3lhdENEcmpJRHNsWWdnTStxd25PdWx2Q0RxdDV6c3VabnJqSURyb1p3Z1NsTlBUaURyc0xEc2w3VHJvWnpycDR3NklDY2dLeUJLVTA5T0xuTjBjbWx1WjJsbWVTaDBaWGgwS1EwS0lDQWdJQ0FnT2lBbjY0dWs3SjJNSUZWSklPdXN1T3Exck95ZG1DRHJqSURzbFlnZ00rcXduT3VsdkNEcXQ1enN1Wm5yaklEcm9ad2dTbE5QVGlEcnNMRHNsN1Ryb1p6cnA0dzZJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2gwWlhoMEtTazdEUW9nSUgwc0lHMXZaR1ZzTENCeVpYQmhjbk5sS1RzTkNuME5DZzBLTHk4ZzY3S0k3SmV0SU8yRXRDRGlnSlFnNnJDWjdKMkFJT3lFdU95Rm1PeWRoQ0RzazdEcmtKZ3NJT3lkdE91eWlDRHRoTFRycDR3ZzdMYVU3TEtjSU8yWWxleUxuU2hLVTA5T0lPdXdzT3lYdENrZzY0eUE3SXVnSU91eWlPeVhyU0R0bUpYc2k1MG9TbE5QVGlEcXNKM3NzclFwN0oyRUlPeWFsT3Exck8yVm5PdUxwQTBLWm5WdVkzUnBiMjRnWVhOclZISmhibk5zWVhSbEtIUmxlSFFzSUcxdlpHVnNMQ0J5WlhCaGNuTmxLU0I3RFFvZ0lISmxkSFZ5YmlCeWRXNVVkWEp1S0NncElEMCtJQ2dOQ2lBZ0lDQW43SjIwNjdLSUlPeWFsT3l5cmV5ZGdDRHJzb2pzbDYwZzdKNlI3SmVGN0oyMDY0dWtJQ2pyckxqcXRhd2c2NHVrNjVPczZyaXdJT3lWaE91TG1DRGlnSlFnNjR5QTdKV0lJRFBxc0p3ZzZyZWM3TG1aN0oyQUlPeWR0T3V5aUNEdGhMVHNsNUFnN0tDQjdKcXA3WldZN0tlQUlPeVZpdXVLbE91THBDa3VJQ2NnS3cwS0lDQWdJQ2ZyaTZUc25Zd2dWVWtnNjZ5NDZyV3M2ckNBSU8yVm5PcTFyZXlXdE91cHRDRHNucERzbDdEc2lxVHJuNnpzbXJRZzdKaUI3SmEwNjZHY0xDRHNtSUhzbHJUcnFiUWc3SjZRN0pldzdJcWs2NStzN0pxMElPMlZuT3ExcmV5V3RPdWhuQ0Ryc29qc2w2M3RsWmpybmJ3dUlDY2dLdzBLSUNBZ0lDZFZTU0RyckxqcXRhenJpNlRzbXJRZzZyQ0U2ckt3N1pXY0lPMlJuTzJZaE95ZGhDRHNrN0RxczZBc0lPeWR0T3VtaE1LMzdJaXI3SjZRd3JmcnA0anNpcVR0Z3JuQ3QrMlVqT3VnaU95ZHRPeUtwTzJaZ091TmxPdUtsQ0RxdDdqcmpJRHJvWndnNjdPMDdLRzA3WldjNjR1a0xpQW5JQ3NOQ2lBZ0lDQW43SnVRNjZ5NDdKMllJT3lraENEc2lKanJwYndnNnJlNDY0eUE2NkdjSU95Y29PeW5nTzJWbk91THBDRGlnSlFnN0p1UTY2eTQ3SjIwSU8yVm5DRHNwSVRzbmJUcnFiUWc2N0tJN0pldDY0K0VJTzJWbkNEc3BJVHJvWndzSU95a2hPdXdsT3EvaU95ZGhDRHNub1Rzblpqcm9ad2c3TGFVNnJDQTdaV1k3S2VBSU95Vml1dUtsT3VMcEM0Z0p5QXJEUW9nSUNBZ0ordUx0ZXlkZ0NEcnNKanJrNXpzaTV3Z1NsTlBUaURxc0ozc3NyUWc3WldZNjRLWTY2ZU1JT3kybk91Z3BlMlZuT3VMcEM0ZzY2ZUk3WUdzNjR1azdKcTB3cmZzaEtUcnFvVWc2cmlJN0tlQU9pQW5JQ3NOQ2lBZ0lDQW5leUowY21GdWMyeGhkR1ZrSWpvZ0l1dXlpT3lYcmV1c3VDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpWkdseVpXTjBhVzl1SWpvZ0ltdHY0b2FTWlc0ZzY1aVE2NHFVSUdWdTRvYVNhMjhpZlRvZ0p5QXJJRXBUVDA0dWMzUnlhVzVuYVdaNUtIUmxlSFFwRFFvZ0lDa3NJRzF2WkdWc0xDQnlaWEJoY25ObEtUc05DbjBOQ2cwS0x5OGc2NHlBN1ptVTdaaVZJT3VzdU9xMXJDRHNvSnpzbnBFZzdZUzBJT0tBbENEc2dxenNtcW5zbnBEcXNJQWc3SU9CN1ptcDdKMkVJT3lFcE91cWhlMlZtT3VwdENEcnA2WHJuYjNzbDVBZzY2ZWU2NHFVSU91c3VPcTFyT3VsdkNEcnA0enJrNlRzbHJUc3BJRHJpNlF1RFFvdkx5QnRaWE56WVdkbGN6b2dXM3R5YjJ4bE9pZDFjMlZ5SjN3bllYTnphWE4wWVc1MEp5d2dkR1Y0ZEgxZElPeWdoT3l5dENEcmpJRHRtWlRycGJ3ZzY2ZWs2N0tJSU91d20rdUtsT3VMcENqcmk2VHJwcXpyaXBRZzY2eTA3SU9CN1lPY0lPS0FsQTBLTHk4ZzdKdU02N0NON0plRklPeW5nT3lMbk91c3VPeWRtQ0FpN0pxVTdMS3Q2NU9rN0oyQUlPeUVuT3VobkNEcnJMVHF0SUFpSU95Z2hPeWduT3VsdkNEc3A0RHRncVRxdUxBZzdKeUU3WlcwSU91TWdPMlpsQ0RycDZYcm5iM3NuWVFnN1lTMElPeVZpT3lYa0NEcnFyM3JsWVVnN0l1ajY0cVU2NHVrS1M0TkNtWjFibU4wYVc5dUlHRnphME52YlhCdmMyVW9iV1Z6YzJGblpYTXNJRzF2WkdWc0xDQnlaWEJoY25ObEtTQjdEUW9nSUhKbGRIVnliaUJ5ZFc1VWRYSnVLQ2dwSUQwK0lIc05DaUFnSUNCamIyNXpkQ0IwY21GdWMyTnlhWEIwSUQwZ0tHMWxjM05oWjJWeklIeDhJRnRkS1M1dFlYQW9LRzBwSUQwK0RRb2dJQ0FnSUNBb2JTNXliMnhsSUQwOVBTQW5ZWE56YVhOMFlXNTBKeUEvSUNmc2xyVHNpNXpzaXFUdGhMVHRpcmc2SUNjZ09pQW43SUtzN0pxcDdKNlFPaUFuS1NBcklGTjBjbWx1WnlodExuUmxlSFFnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJREUxTURBcERRb2dJQ0FnS1M1cWIybHVLQ2RjYmljcE93MEtJQ0FnSUhKbGRIVnliaUFvRFFvZ0lDQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0FpNjR5QTdabVU3WmlWSU91c3VPcTFyQ0Rzb0p6c25wRWk3SjIwNjR1a0lDanF1TERzb2JRZzY2eTQ2cldzSU91THBPdVRyT3E0c0NEc2xZVHJpNWdnNG9DVUlPeVZoT3VlbUNEcmpJRHRtWlRxc0lBZzdKMjA2N0tJSU8yRXRPeWRtQ0Rzb0lUc3NyUWc2NmVsNjUyOTdKMjA2NHVrS1M0Z0p5QXJEUW9nSUNBZ0lDQW43SUtzN0pxcDdKNlE2ckNBSU8yWmxPdXB0Q0RzZzRIdG1hbkN0K3VucGV1ZHZleWRoQ0RzaEtUcnFvWHRsWmpycWJRc0lPeUtwTzJEZ095ZHZDRHF0NXpzdVpucXM3d2c3SmlJN0l1Y0lPMkdwT3lYa0NEcnA1N3JpcFFnVlVrZzY2eTQ2cldzNjZXOElPdW5qT3VUcE95V3RDRHNvSnpzbFlqdGxaanJuYnd1WEc0bklDc05DaUFnSUNBZ0lDY3RJT3VucGV1ZHZleWR0Q0RydG9Ec29iSHRsWmpycWJRZzdZNjQ3WldZNnJLTUlPdVFtT3Vzdk95V3RPdWR2RG9nN0phMDY1YWtJTzJabE91cHRNSzM2cml3NjRxbDdKMllJT3VzdU9xMXJPeWR1T3luZ0N3ZzY1T2s3SmEwNnJDSUlPeWVrT3Vtck91S2xDRHNsclRybEpUc25ianNwNEFvN1l5ZDdKZUZJTzJEZ095ZHRPMkxnQy9yczdqcnJMZ3Y2N0tFN1lxOExDRHRocURzaXFUdGlyZ3NJT3U1aUNEdG1aVHJxYlFnN0pXSTY0SzBMQ0Ryc0xEcmhJZ2c2NU94S1N3ZzdKYTA2NWFrSU95RGdlMlpxZXlkdU95bmdDanNoTEhxczdVZzdZYTE2N08wTCt5WXBPdWxtQy90bVpYc25iZ2c3SnFVN0xLdEwreVZpT3VDdENrZzZyQ1o3SjJBSU9xeWd5NGc2cnl0SU8yVmhPeWFsTzJWbkNEcXNvUHJwNHdnNnJPbzY1MjhJTzJWbkNEcnNvanNsNUFnN0xXYzY0eUFJRExxc0p6cXVZenNwNEFzSU95bnArcXlqQzRnN0oyMDY1V01JSE4xWjJkbGMzUnBiMjV6NjRxVUlPdTVpQ0Ryc0xEc2w3UXVYRzRuSUNzTkNpQWdJQ0FnSUNjdElPcXdrT3lkdENEc2xyVHJpcEFnN0tDVjY0K0VJT3lZcE91cHRDRHJyTHZxdUxEcnA0d2c3WldZN0tlQUlPdW5pT3VkdkNEaWdKUWc2ckNBN0tDVjdKMkVJT3lFdU95YXNPcXpvQ0RzdElqc2xZZ2djM1ZuWjJWemRHbHZiblBycGJ3ZzdaV282cnVZSU91Q3RPdXB0T3lFbkN3Z2NtVndiSG5zbDVBZzZyQ0E3S0NWN0oyRUlPdXduZTJlaU9xem9DRHJyTFRzbDRmc25ZUWc3SldNNjZDazdLTzg2Nm0wSU91TmxDRHJwNTdzdHB3ZzdJaVlJT3llaU91S2xPeW5nQ0R0bFp3ZzY2eTQ3SjZsN0p5ODY2R2NJT3VOcCt1Mm1leVhyT3VkdkNqc21JZzZJQ0x0bVpYc25iZ2c3WXlkN0plRjdKMjA2NTI4NnJPZ0lPcXdnT3lnbGUyV2lPeVd0T3lhbENEaWdKUWc3WWFnN0lxazdZcTQ2NTI4NjZtMElPeVZqT3VncE95anZPeUV1T3lhbENJcExseHVKeUFyRFFvZ0lDQWdJQ0FuTFNEcnJManF0YXpycGJ3ZzdLQ2M3SldJN1pXZ0lPdVZrQ0RzaEp6cm9ad2c3S0NSNnJlODdKMjBJT3VMcE91bHVDQXlmalBxc0p3dUlPcXdnU0Rzb0p6c2xZanNsNVFnN0ptY0lPcTN1T3VnaCtxeWpDRHNqYnpyaXBUc3A0QWc3SjIwN0p5ZzY2VzhJT3UybWV5ZHVPdUxwQzVjYmljZ0t3MEtJQ0FnSUNBZ0p5MGc3SUtzN0pxcDdKNlE2ckNBSU95V3VPcTRpZTJWbU95bmdDRHNsWXJzbllBZzZyV3M3TEswSU95Z2xldXp0Q2pzb0lUdG1aVHJzb2p0bUxqQ3QxVlNUTUszNnJpSTdKV2h3cmZ0bXAvc2lKZ2c2NU94S2V1bHZDRHNwNERzbHJUcmdyUWc2NFNqN0tlQUlPdW5pT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDQWdKeTBnN1p1RTdJYU5JT3lhbE95eXJTZ2k2NDJVSU95bnArcXlqQ0lzSUNMcnNvVHRpcnpzbXFuc25MenJvWndpSU91VHNTbnNuYlRycWJRZzdLZUI3S0NFSU95Z25PeVZpT3lkaENEcXQ3Z2c2N0NwN1phbDdKeTg2NkdjSU9xem9PeXprQ0RyaTZUc2k1d2c3S0NjN0pXSTdaV1k2NTI4TGx4dUp5QXJEUW9nSUNBZ0lDQW42NHUxN0oyQUlPdXdtT3VUbk95TG5DQktVMDlPSU9xd25leXl0Q0R0bFpqcmdwanJwNHdnN0xhYzY2Q2w3WldjNjR1a0xpRHJwNGp0Z2F6cmk2VHNtclRDdCt5RXBPdXFoU0RxdUlqc3A0QTZJQ2NnS3cwS0lDQWdJQ0FnSjNzaWNtVndiSGtpT2lBaTY0eUE3Wm1VSU95ZGtldUx0U0R0bFp6cmtaQWc2Nnk0N0o2bElDanRsYlRzbXBUc3NyUXBJaXdnSW5OMVoyZGxjM1JwYjI1eklqb2dXM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2dLT3lraE91d2xPcS9pT3lkZ0NCY1hHNHBJaXdnSW5KbFlYTnZiaUk2SUNMc25iVHNuS0FnN1pXY0lPdXN1T3llcFNKOVhYMWNibHh1SnlBckRRb2dJQ0FnSUNBblcrdU1nTzJabEYxY2JpY2dLeUIwY21GdWMyTnlhWEIwRFFvZ0lDQWdLVHNOQ2lBZ2ZTd2diVzlrWld3c0lISmxjR0Z5YzJVcE93MEtmUTBLRFFvdkx5RHRsSVRyb0lqc25vVHJzNFFvN1pXWTdKeUVJTzJVaE91Z2lPeWVoQ0Ryckxic25Zd3BJT3kybE95eW5DRHRoTFFnNG9DVUlPMlZuQ0R0bVpUcnFiVHNuWVFnN1pXWTdKeUVJTzJVaE91Z2lPeWVoQ0RyaTZqc25JVHJvWndnNjRLWTY0aWdJT3V6dE91Q3RPcXpvQ3dOQ2k4dklDb3E3WlNFNjZDSTdKNkU2NmVJNjR1a0lPdVVzT3VobkNvcUlPdU1nT3lWaU95ZGhDRHJzSnZyaXBUcmk2UXVJTzJWbkNEc21wVHNzcTNzbDVBZzY0dWtJT3lMcE95V3RDRHJzN1RyZ3JUcmlwUWc2cktEN0oyMElPMlZ0ZXlMckRvTkNpOHZJTzJVaE91Z2lPeWVoQ0RzaUpqcnA0enRnYndnN0pxVTdMS3Q3SjJFSU95cXZPcXduT3VwdENEcXQ3anJwNHp0Z2J3ZzY0cVE2NkNrN0tlQTZyT2dLT3F3Z1NBMWZqRXc3TFNJS1NEcXRhenJqNFVnN0lLczdKcXA2NStKNjQrRUlPcTN1T3Vuak8yQnZDRHJncGpxc0lUcmk2UXVEUW92THlCbmNtOTFjSE02SUZ0N2JtRnRaU3dnZEdWNGRITTZXMTE5WFNBbzdabVU2Nm0wSU95Y2hPS0drdXlWaE91ZW1DRHNpSndwTGcwS1puVnVZM1JwYjI0Z1lYTnJSM0p2ZFhCektHZHliM1Z3Y3l3Z2JXOWtaV3dzSUhKbGNHRnljMlVzSUcxdmNtVXBJSHNOQ2lBZ2NtVjBkWEp1SUhKMWJsUjFjbTRvS0NrZ1BUNGdldzBLSUNBZ0lDOHZJT3V5aE8yS3ZDRHNtSUhzbDYzc25ZQWdLT3V5aE8yS3ZDbnNuTHpyb1p3ZzdMQ043SmEwSU91enRPdUN1T3VMcENEaWdKUWc2N0tFN1lxOElPdXN1T3Exck91S2xDRHJyTGpzbnFYc25iUWc3SldFNjR1STY1MjhJT3VQbWV5ZWtTRHNuYlRycG9Uc25iVHJuYndnNnJlYzdMbVo3SjIwSU91THBPdWx0T3VMcEEwS0lDQWdJR052Ym5OMElHeHBjM1FnUFNBb1ozSnZkWEJ6SUh4OElGdGRLUzV0WVhBb0tHY3NJR2twSUQwK0RRb2dJQ0FnSUNBbld5Y2dLeUFvYVNBcklERXBJQ3NnSjEwZ0p5QXJJRk4wY21sdVp5Z29aeUFtSmlCbkxtNWhiV1VwSUh4OElDZ242cmU0NjZPNUp5QXJJQ2hwSUNzZ01Ta3BLU0FySUNobklDWW1JR2N1Y205c1pTQTlQVDBnSit1eWhPMkt2Q2NnUHlBbklDanJzb1R0aXJ3cEp5QTZJQ2NuS1NBcklDZGNiaWNnS3cwS0lDQWdJQ0FnS0djZ0ppWWdRWEp5WVhrdWFYTkJjbkpoZVNobkxuUmxlSFJ6S1NBL0lHY3VkR1Y0ZEhNZ09pQmJYU2t1YldGd0tDaDBLU0E5UGlBbklDQXRJQ2NnS3lCS1UwOU9Mbk4wY21sdVoybG1lU2hUZEhKcGJtY29kQ0I4ZkNBbkp5a3BLUzVxYjJsdUtDZGNiaWNwRFFvZ0lDQWdLUzVxYjJsdUtDZGNiaWNwT3cwS0lDQWdJR052Ym5OMElHaGhjMEowYmlBOUlDaG5jbTkxY0hNZ2ZId2dXMTBwTG5OdmJXVW9LR2NwSUQwK0lHY2dKaVlnWnk1eWIyeGxJRDA5UFNBbjY3S0U3WXE4SnlrN0RRb2dJQ0FnWTI5dWMzUWdhMlY1SUQwZ0oyZHliM1Z3Y3ljZ0t5QW9aM0p2ZFhCeklIeDhJRnRkS1M1dFlYQW9LR2NwSUQwK0lDaG5JQ1ltSUdjdWRHVjRkSE1nUHlCbkxuUmxlSFJ6TG1wdmFXNG9KeWNwSURvZ0p5Y3BLUzVxYjJsdUtDY25LVHNOQ2lBZ0lDQmpiMjV6ZENCaGRIUmxiWEIwSUQwZ0tHRnphMlZrUTI5MWJuUXVaMlYwS0d0bGVTa2dmSHdnTUNrZ0t5QXhPdzBLSUNBZ0lHRnphMlZrUTI5MWJuUXVjMlYwS0d0bGVTd2dZWFIwWlcxd2RDazdEUW9nSUNBZ2FXWWdLR0Z6YTJWa1EyOTFiblF1YzJsNlpTQStJREl3TUNrZ1lYTnJaV1JEYjNWdWRDNWpiR1ZoY2lncE93MEtJQ0FnSUdOdmJuTjBJR0ZuWVdsdUlEMGdiVzl5WlNCOGZDQmhkSFJsYlhCMElENGdNUTBLSUNBZ0lDQWdQeUFuN0oyMElPMlpsT3VwdE95ZGdDRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3V2dUNEcmk2VHJwSmpyaTZRdUlPeVZudXlFbkNEcmdyZ2c2NHlBN0pXSTZyTzhJT3lXdE8yY21NSzM2cldzN0tHdzZyQ0FJTzJabGV5THBPMmVpQ0RyaTZUcnBiZ2c3SU9JSU91TWdPeVZpT3VuakNEcmdyVHJuYnd1WEc0bkRRb2dJQ0FnSUNBNklDY25PdzBLSUNBZ0lISmxkSFZ5YmlBb0RRb2dJQ0FnSUNCaFoyRnBiaUFyRFFvZ0lDQWdJQ0FuN0oyMDY3S0lJT3lhbE95eXJleWRnQ0FpN1ptVTY2bTA3SjJFSU8yVm1PeWNoQ0R0bElUcm9JanNub1RyczRUcm9ad2c2NEtZNjRpZ0lPdUxwT3VUck9xNHNDTHJpNlF1SU95VmhPdWVtT3VLbENEdGxad2c3Wm1VNjZtMDdKMllJT3VzdU9xMXJPdWx2Q0R0bFpqc25JUWc3WlNFNjZDSTdKNkVLT3lZZ2V5WHJTa2c2NHVvN0p5RTY2R2NJT3VzdHV5ZGdDRHFzb1BzbmJUcmk2UXVYRzRuSUNzTkNpQWdJQ0FnSUNjcUt1eVlnZXlYcmV1bmlPdUxwQ0RybExEcm9ad3FLaURyaklEc2xZanNuWVFnNjRLMDY1MjhJT0tBbENEc21JSHNsNjNzbllRZzdJU2M2NkdjSU8yVnFleTVtT3F4c091Q21DRHNpSnpzaEp6cnBid2c2N0NVNnI2NDdLZUFJT3VuaU91ZHZDNWNiaWNnS3cwS0lDQWdJQ0FnSnkwZzZyQ0JJT3lZZ2V5WHJleVhrQ0RyaklEc2xZZ2dNdXF3bkM0ZzZyZTRJT3lZZ2V5WHJleWR0Q0RzbDZ6cm42d2c3S1NFN0oyMDY2bTBJT3VNZ095VmlPdVBoQ0FxS3Vxd21leWRnQ0RzcElRZzdJaVlLaXJyb1p3bzdLU0U2N0NVNnIrSUlGeGNidXljdk91aG5DRHF0YXpydG9Rc0lPeWtoQ0RzaUp6c2hKd2c3SnlnN0tlQUtTNWNiaWNnS3cwS0lDQWdJQ0FnSnkwZzdKaUI3SmV0N0oyWUlPeVhyZTJWb0NqdGc0RHNuYlR0aTREQ3QreVZpT3VDdE1LMzY3S0U3WXE4SU91VHNTbnFzN3dnN0p1UTY2eTQ3SjJZSU95Z2xldXp0TUszN0tHdzZyRzBLT3lJcSt5ZWtNSzM2NHlBN0lPQndyZnNvYkRxc2JRcDdKMkFJT3ljb095bmdPMlZtT3F6b0N3ZzdKZUc2NHFVSU95Z2xldXp0T3VsdkNEc3A0RHNsclRyZ3JUc3A0QWc2NmVJNjUyOExseHVKeUFyRFFvZ0lDQWdJQ0FuTFNEcXM2RHN1YUFnNnJLTUlPeVhodXVLbENEc21JSHNsNjNzbmJUcnFiUWc2NHlBN0pXSUlESHFzSnpycDR3ZzY0SzA2ckd3NjRLWUlPdTVpQ0Ryc0xEc2w3VHJvWndnNjVHUTdKYTA2NCtFSU91UW5PdUxwQ0RpZ0pRZzdKYTE3S2VBNjZHY0lPdXdsT3ErdU95bmdDRHJwNGpybmJ3dVhHNG5JQ3NOQ2lBZ0lDQWdJQ2N0SU8yWmxPdXB0Q0RxdUxEcmlxWHJxb1VvNjdPQTZySzl3cmZ0bGJUc29Kd2c2NU94S2V5ZGdDRHF0N2pyaklEcm9ad2c2NUdVNjR1a0xseHVKeUFyRFFvZ0lDQWdJQ0FvYUdGelFuUnVJRDhnSnkwZ0tPdXloTzJLdkNuc25MenJvWndnN1pHYzdJdWM2NUNjSU95WWdleVhyZXlkZ0NBbklDc2dRbFZVVkU5T1gxSlZURVVnT2lBbkp5a2dLdzBLSUNBZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1hDdCt5OWxPdVRuTzJPbk95S3BDRHF1SWpzcDRBNlhHNG5JQ3NOQ2lBZ0lDQWdJQ2Q3SW1keWIzVndjeUk2SUZ0N0ltNWhiV1VpT2lBaTdKaUI3SmV0SU95ZHRPdW1oQ2pzbm9Ycm9LWHFzN3dnNjQrWjdKMjhLU0lzSUNKemRXZG5aWE4wYVc5dWN5STZJRnQ3SW5SbGVIUWlPaUFpNjR5QTdKV0lJT3VzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0R0bFp3ZzY2eTQ3SjZsSW4xZGZWMTlYRzRuSUNzTkNpQWdJQ0FnSUNmc21JSHNsNjNzbllBZzdKNkY2NkNsSU95SW5PeUVuTUszNnJDYzdJaVk2Nlc4SU9xM3VPdU1nT3VobkNEc3A0RHRncWpyaTZRdVhHNWNiaWNnS3cwS0lDQWdJQ0FnSjF2c21JSHNsNjNyczRRZzY2eTQ2cldzWFZ4dUp5QXJJR3hwYzNRTkNpQWdJQ0FwT3cwS0lDQjlMQ0J0YjJSbGJDd2djbVZ3WVhKelpTazdEUXA5RFFvTkNpOHZJTzJVaE91Z2lPeWVoT3V6aENEc3RwVHNzcHdnN0oyUjY0dTE3SmVRN0lTY0lGdDdibUZ0WlN3Z2MzVm5aMlZ6ZEdsdmJuTTZXM3QwWlhoMExDQnlaV0Z6YjI1OVhYMWRJT3kybE95Mm5BMEtablZ1WTNScGIyNGdjR0Z5YzJWSGNtOTFjSE1vY21GM0tTQjdEUW9nSUd4bGRDQnpJRDBnVTNSeWFXNW5LSEpoZHlrdWRISnBiU2dwTG5KbGNHeGhZMlVvTDE1Z1lHQW9QenBxYzI5dUtUOWNjeW92YVN3Z0p5Y3BMbkpsY0d4aFkyVW9MMXh6S21CZ1lDUXZhU3dnSnljcE93MEtJQ0JqYjI1emRDQnRJRDBnY3k1dFlYUmphQ2d2WEh0YlhITmNVMTBxWEgwdktUc05DaUFnYVdZZ0tHMHBJSE1nUFNCdFd6QmRPdzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUc4Z1BTQktVMDlPTG5CaGNuTmxLSE1wT3cwS0lDQWdJR052Ym5OMElHRnljaUE5SUVGeWNtRjVMbWx6UVhKeVlYa29ieUFtSmlCdkxtZHliM1Z3Y3lrZ1B5QnZMbWR5YjNWd2N5QTZJRnRkT3cwS0lDQWdJR052Ym5OMElHZHliM1Z3Y3lBOUlHRnljaTV0WVhBb0tHY3BJRDArSUNoN0RRb2dJQ0FnSUNCdVlXMWxPaUJUZEhKcGJtY29LR2NnSmlZZ1p5NXVZVzFsS1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQTBLSUNBZ0lDQWdjM1ZuWjJWemRHbHZibk02SUVGeWNtRjVMbWx6UVhKeVlYa29aeUFtSmlCbkxuTjFaMmRsYzNScGIyNXpLUTBLSUNBZ0lDQWdJQ0EvSUdjdWMzVm5aMlZ6ZEdsdmJuTU5DaUFnSUNBZ0lDQWdJQ0FnSUM1dFlYQW9LSGdwSUQwK0lDaDBlWEJsYjJZZ2VDQTlQVDBnSjNOMGNtbHVaeWNOQ2lBZ0lDQWdJQ0FnSUNBZ0lDQWdQeUI3SUhSbGVIUTZJSGd1ZEhKcGJTZ3BMQ0J5WldGemIyNDZJQ2NuSUgwTkNpQWdJQ0FnSUNBZ0lDQWdJQ0FnT2lCN0lIUmxlSFE2SUZOMGNtbHVaeWdvZUNBbUppQjRMblJsZUhRcElIeDhJQ2NuS1M1MGNtbHRLQ2tzSUhKbFlYTnZiam9nVTNSeWFXNW5LQ2g0SUNZbUlIZ3VjbVZoYzI5dUtTQjhmQ0FuSnlrdWRISnBiU2dwSUgwcEtRMEtJQ0FnSUNBZ0lDQWdJQ0FnTG1acGJIUmxjaWdvZUNrZ1BUNGdlQzUwWlhoMEtRMEtJQ0FnSUNBZ0lDQTZJRnRkTEEwS0lDQWdJSDBwS1RzTkNpQWdJQ0F2THlEc25iVHJwb1Rzb2JEc3NLZ2c3SmVHNnJPZ0lPeWduT3lWaU91UGhDRHNsNGJyaXBRZzZydU42NDJ3NnJpdzY2ZU1JT3labE95Y3ZPdXB0Q0R0bUpYc2k1MGc3SjIwN1lPSTY2R2NJT3V6dU91THBDanFzSm5zbllBZzdJUzQ3SVdZN0plUUlPeWVyT3lhbE95eXJTa05DaUFnSUNCeVpYUjFjbTRnWjNKdmRYQnpMbk52YldVb0tHY3BJRDArSUdjdWMzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0tTQS9JR2R5YjNWd2N5QTZJRzUxYkd3N0RRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0RRb2dJQ0FnY21WMGRYSnVJRzUxYkd3N0RRb2dJSDBOQ24wTkNnMEtMeThnN1l5ZDdKZUZJT3lFdU8yS3VDRHN0cFRzc3B3ZzdZUzBJT0tBbENEdGxad2c3WXlkN0plRjdKMllJT3Exck95RXNleWFsT3lHakNqc2w2M3RsYUFyNjZ5NDZyV3NLZXVsdkNEdGxad2c2N0tJN0plUUlPdXp0T3VDdE9xem9Dd05DaTh2SU95YWxPeUdqT3V6aENEcmdySHFzSnpxc0lBZzdKV0U2NHVJNjUyOElDb3E3Sm1FN0lTeDY1Q2NJTzJNbmV5WGhTRHNoTGp0aXJnbzdMeUE3SjIwN0lxa0tTQXlmalBxc0p3cUt1dWx2Q0R0aHJYc25MenJvWndnNjdDYjY0cVU2NHVrTGcwS0x5OGc3WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZPeWR0Q0R0bFp3ZzY2cTQ3Snk4NjZHY0lPeWR2T3EwZ091UHZPeVZ2Q0R0bFpqcnI0RHJvWndvNjVTdzY2R2NJT3U5a2V5VmhDRHNvYkR0bGFudGxaanJxYlFnN0phMDZyaUw2NEtjNjR1a0tTRHNoTGp0aXJnZzY0dW83SnlFNjZHY0lPeWduT3lWaU8yVm1PcXlqQ0R0bFp6cmk2UXVEUW92THlCbGJHVnRaVzUwY3pvZ1czdHliMnhsTENCMFpYaDBmVjBnS08yWmxPdXB0Q0RzbklUaWhwTHNsWVRybnBnZzdJaWNLUzROQ2k4dklHMXZjbVU5ZEhKMVpTaGI3THlBN0oyMDdJcWtJT3VObENEcnNKdnF1TEJkS2V1cHRDRHNuYlFnN0lTNDdJV1k3SmVRN0lTY0lPeWR0T3V2dUNEcmdyZ2c3SVM0N1lxNDdKbUFJT3F5dWV5NW1PeW5nQ0RzbFlycmlwUWc3SU9JSU95RXVPMkt1T3VsdkNEc21wVHF0YXp0bFp6cmk2UXVEUXBtZFc1amRHbHZiaUJoYzJ0UWIzQjFjQ2hsYkdWdFpXNTBjeXdnYlc5a1pXd3NJSEpsY0dGeWMyVXNJRzF2Y21VcElIc05DaUFnY21WMGRYSnVJSEoxYmxSMWNtNG9LQ2tnUFQ0Z2V3MEtJQ0FnSUdOdmJuTjBJSEp2YkdWeklEMGdLR1ZzWlcxbGJuUnpJSHg4SUZ0ZEtTNXRZWEFvS0dVcElEMCtJRk4wY21sdVp5Z29aU0FtSmlCbExuSnZiR1VwSUh4OElDY25LU2t1YW05cGJpZ25MQ0FuS1RzTkNpQWdJQ0JqYjI1emRDQnNhWE4wSUQwZ0tHVnNaVzFsYm5SeklIeDhJRnRkS1M1dFlYQW9LR1VzSUdrcElEMCtEUW9nSUNBZ0lDQW9hU0FySURFcElDc2dKeTRnV3ljZ0t5QlRkSEpwYm1jb0tHVWdKaVlnWlM1eWIyeGxLU0I4ZkNBbkp5a2dLeUFuWFNBbklDc2dTbE5QVGk1emRISnBibWRwWm5rb1UzUnlhVzVuS0NobElDWW1JR1V1ZEdWNGRDa2dmSHdnSnljcEtRMEtJQ0FnSUNrdWFtOXBiaWduWEc0bktUc05DaUFnSUNBdkx5RHFzSm5zbllBZzdZeWQ3SmVGN0oyRUlPdXFoeURyc29qc3A3Z2c2Nnk3NjRxVTdLZUFJT3E0c095V3RTRGlnSlFnN0o2czdKcVU3TEt0N0oyMDY2bTBJQ0xzbmJUc29JVHFzN3dnNjR1azY2VzRJT3lFdU8yS3VDTHJwYndnN0pxVTZyV3M3WldjNjR1a0RRb2dJQ0FnTHk4Z0tHRnphME5zWVhWa1pleVpnQ0Rxc0puc25ZQWc3SjIwN0p5Z09pRHNsWWdnNnJlNDY1K3M2Nm0wSU8yQnRPdWhuT3VUbk9xd2dDRHFzSm5zbllBZzdJUzQ3WXE0NjZXOElPdVlrQ0RyZ3JUc2hKd2dXK3k4Z095ZHRPeUtwQ0RyalpRZzY3Q2I2cml3WGVxd2dDRHJyTFRzblpqcnI3anRsYlRzcDRUcmk2UXBEUW9nSUNBZ1kyOXVjM1FnYTJWNUlEMGdKM0J2Y0hWd0FTY2dLeUFvWld4bGJXVnVkSE1nZkh3Z1cxMHBMbTFoY0Nnb1pTa2dQVDRnVTNSeWFXNW5LQ2hsSUNZbUlHVXVkR1Y0ZENrZ2ZId2dKeWNwS1M1cWIybHVLQ2NCSnlrN0RRb2dJQ0FnWTI5dWMzUWdZWFIwWlcxd2RDQTlJQ2hoYzJ0bFpFTnZkVzUwTG1kbGRDaHJaWGtwSUh4OElEQXBJQ3NnTVRzTkNpQWdJQ0JoYzJ0bFpFTnZkVzUwTG5ObGRDaHJaWGtzSUdGMGRHVnRjSFFwT3cwS0lDQWdJR2xtSUNoaGMydGxaRU52ZFc1MExuTnBlbVVnUGlBeU1EQXBJR0Z6YTJWa1EyOTFiblF1WTJ4bFlYSW9LVHNnTHk4ZzY2eTA3WldjN1o2SUlPeU1rK3lkdE95bmdDRHNsWXJxc293TkNpQWdJQ0JqYjI1emRDQmhaMkZwYmlBOUlHMXZjbVVnZkh3Z1lYUjBaVzF3ZENBK0lERU5DaUFnSUNBZ0lEOGdKK3lkdENEdGpKM3NsNFhzbllBZzdKMjBJT3lFdU95Rm1PeVhrT3lFbkNEc25iVHJyN2dnNjR1azY2U1k2NHVrTGlEc2xaN3NoSndnN0tDYzdKV0k3WldjSU95RXVPMkt1T3VUcE9xenZDQXFLdXlna2VxM3ZNSzM3SmEwN1p5WTZyQ0FJTzJabGV5THBPMmVpQ0RyaTZUcnBiZ2c3SU9JSU95RXVPMkt1Q29xNjZlTUlPdUN0T3VkdkNqcXNKbnNuWUFnN0lTNDdZcTRJT3V3bU91enRTRHF1SWpzcDRBcExseHVKdzBLSUNBZ0lDQWdPaUFuSnpzTkNpQWdJQ0J5WlhSMWNtNGdLQTBLSUNBZ0lDQWdZV2RoYVc0Z0t3MEtJQ0FnSUNBZ0oreWR0T3V5aUNEc21wVHNzcTNzbllBZ0l1Mk1uZXlYaFNqcmk2VHNuYlRzbHJ6cm9aenF0N2dwSU95RXVPMkt1Q0RyaTZUcms2enF1TEFpNjR1a0xpRHNsWVRybnBqcmlwUWc3WldjSU8yTW5leVhoZXlkaENEc25JVGlocExzbFlUcm5wanJvWndnNjRLWTdKZTA3WldjSU9xMXJPeUVzZXlhbE95R2pPdVRwT3lkdE91THBDanNoSnpyb1p3ZzY2eTA2clNBN1pXY0lPdXpoT3F3bkNEcnJManF0YXpxc0lBZzdKV0U2NHVJNjR1a0tTNGdKeUFyRFFvZ0lDQWdJQ0FuN0pxVTdJYU02Nlc4SU91Q3NlcXduT3VobkNEcXM2RHN1WmpzcDRBZzY2ZVE2ck9nTENBcUt1MkRnT3lkdE8yTGdNSzM3SldJNjRLMHdyZnJzb1R0aXJ6c25iUWc3SVNjNjZHY0lPeWR2T3EwZ091UW5DQWk3Sm1FN0lTeDY1Q2NJTzJNbmV5WGhTRHNoTGp0aXJnaUlESitNK3F3bkNvcTY2VzhJT3lnbk95VmlPMlZtT3VkdkM0ZzZyQ0JJT3lFdU8yS3VPdUtsQ0RzaEp6cm9ad2c2NHVrNjZXNElPeWdrZXEzdk95ZHRPeVd0T3lWdkNEdGxaenJpNlF1WEc0bklDc05DaUFnSUNBZ0lDZnFzSUVnN0lTNDdZcTQ2NHFVSU95ZWhldWdwZXF6dkNBcUt1cXdtZXlkZ0NEc2w2M3RsYURDdCtxd21leWRnQ0Rxc0p6c2lKakN0K3F3bWV5ZGdDRHNpSnpzaEp3cUt1eWRtQ0RzbXBUc2hvenJwYndnNjZxbzY1R1FJTzJQck8yVnFPMlZuT3VMcEM0ZzdJUzQ3WXE0SU95VmlPeVhrT3lFbkNEdGc0RHNuYlR0aTREQ3QreVZpT3VDdE1LMzY3S0U3WXE4N0oyQUlPMlZuQ0RycXJqc25MenJvWndnNjZlZTdKV0U2NWFvN0phMDdLQzQ3Slc4SU8yVm5PdUxwQ2pzbUlnNklPdXp1T3VzdU95ZHRDQWlmdTJWb09xNWpPeWFsRDhpNjZtMElPdXloTzJLdk95ZGdDQmI3SldFNjR1STdKaWtYUzliNjRTa1hTa3VYRzRuSUNzTkNpQWdJQ0FnSUNkYjdZeWQ3SmVGSU91c3VPeXl0Q0RxdDV6c3Vaa2c0b0NVSU95Y2hDRHNpcVR0ZzREc25id2c2ckNBN0oyMDY1T2M3SjJZSUNJNExpRHRqSjNzbDRVaUlPeUV1ZXlGbU95ZGhDRHJsTERycGJqcmk2UmRYRzRuSUNzTkNpQWdJQ0FnSUNjdElPMkRnT3lkdE8yTGdEb2c3S2VuN0oyQUlPdXFoZXlDck9xMXJDZ3lmalRzbHJUc29JZ3BMQ0Rzb29YcXNyRHNsclRycjdqQ3QrdW5pT3k1cU8yUm5DRHNsNGJzbmJRb2Z1eWFsQzkrNjR1a0wzN3F1WXpzbXBRL0lPcTRpT3luZ0NrdUlPdXdtT3VUbk95TG5DRHNsWWpyZ3JRbzY3TzQ2Nnk0S1NEcnA2WHJuYjNzbllRZzdKcVU3Slc5N1pXMElPMkRnT3lkdE8yTGdPdW5qQ0RydEpEcmo0UWc2NnkwN0lxb0lPMk1uZXlYaGV5ZHVPeW5nQ0RzbFl6cXNvd2c3WldZNjUyOExpRHNtNURyczdqc25iUWdJdXlWak91bXZDL3RtWlhzbmJnaTdMS1k2NSs4SU91bmlleVhzTzJWbU91cHRDRHJzN2pyckxqc25ZUWc2cmU4NnJHdzY2R2NJT3Exck95eXRPMlpsTzJWbU91ZHZDNWNiaWNnS3cwS0lDQWdJQ0FnSnkwZzdKV0k2NEswS091enVPdXN1Q2s2SU8yVnRPeWFsT3l5dEM0ZzdZeVE2NHVvN0oyMElPMlZoT3lhbE8yVm1PdXB0Q0FpZnUyVm9PcTVqT3lhbEQ4aTY2R2NJT3VzdStxem9Dd2c2NUNZNjQrTTY2YTBJT3lJbUNEc2w0YnJpcFFnN0p5RTdaZVlLT3lDcmV5Z25NSzM3WU9JN1llMElPdVRzU25zbllBZzZyS3c2ck84NjZXOElPdW92T3lnZ0NEcXNyM3FzNkR0bFp6cmk2UXVJT3F5c09xenZNSzM3SU9CN1lPY0lPMkd0ZXV6dE91cHRDRHNoSnpzaUtEdG1KWHNuTHpyb1p3ZzdKV002NmF3NjR1a0xseHVKeUFyRFFvZ0lDQWdJQ0FuTFNEcnNvVHRpcnc2SU91enVPdXN1T3lkdENBaWZ1MlZvT3E1ak95YWxEOGk2Nm0wSUZ2c2xZVHJpNGpzbUtSZEwxdnJoS1JkTENEcnM3anJyTGpzbmJRZzdJT0I3Wm1wN0oyRUlPeUVuT3lJb08yVm1PcXpvQ0RzbmJRZzY3S0U3WXE4N0oyMElPeUxwT3lnbkNEcmo1bnNucEhzbmJUcnFiUWc2NCtaN0o2UklPdVBtZXlDckNqc2dxM3NvSnd2N0tDQTdKNmxMK3lYc09xeXNDRHRsYlRzb0p3ZzY1T3hLU3dnN1lhMTY3TzBJTzJNbmV5WGhleWRtQ0RyaTZqc25id2c2N0tFN1lxODdKMjA2Nm0wSUNMdG1aWHNuYmdpTGlBaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenJwNHdzSUNMcmk2dnF1TERDdCt1UG1leWVrU0lnN0tHdzdaV3BJT3E0aU95bmdDNGc3Wm1VNjZtMElPcTRzT3VLcGV1cWhTanJzNERxc3IzQ3QrMlZ0T3lnbkNEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaVHJpNlF1WEc0bklDc05DaUFnSUNBZ0lDY3RJT3lia091c3VPeWRtQ0Rzb0pYcnM3VEN0K3loc09xeHRDanNpS3ZzbnBEQ3QreWR0T3lEZ1Mvc25iVHRsWmpDdCt1TWdPeURnU25zbllBZzdKeWc3S2VBN1pXWTZyT2dMQ0RzbTVEcnJManNsNUFnN0plRzY0cVVJT3lnbGV1enRNSzM3S0NJN0xDb3dyZnNsN0RybmIzc3NwanJwYndnN0tlQTdKYTA2NEswN0tlQUlPdW5pT3VkdkM1Y2JpY2dLdzBLSUNBZ0lDQWdKK3VMdGV5ZGdDRHJzSmpyazV6c2k1d2dTbE5QVGlEcXNKM3NzclFnN1pXWTY0S1k2NmVNSU95Mm5PdWdwZTJWbk91THBDNGc2NmVJN1lHczY0dWs3SnEwd3Jmc2hLVHJxb1hDdCt5OWxPdVRuTzJPbk95S3BDRHF1SWpzcDRBNlhHNG5JQ3NOQ2lBZ0lDQWdJQ2Q3SW5ObGRITWlPaUJiZXlKeVpXRnpiMjRpT2lBaTdKMjBJT3lFdU8yS3VPeWRtQ0Ryc0tudGxxWHNuWVFnN1pXYzZyV3Q3SmEwSU8yVm5DRHJyTGpzbnFYc25MenJvWndpTENBaVpXeGxiV1Z1ZEhNaU9pQmJleUp5YjJ4bElqb2dJdXlYcmUyVm9DSXNJQ0owWlhoMElqb2dJdXVzdU9xMXJDQW83S1NFNjdDVTZyK0k3SjJBSUZ4Y2Jpa2lmU3dnTGk0dVhYMHNJQzR1TGwxOVhHNG5JQ3NOQ2lBZ0lDQWdJQ2ZzbDYzdGxhRHNuWUFnN0o2RjY2Q2xJT3lJbk95RW5PdU1nT3VobkRvZ0p5QXJJSEp2YkdWeklDc2dKMXh1WEc0bklDc05DaUFnSUNBZ0lDZGI3WXlkN0plRklPeWFsT3lHakYxY2JpY2dLeUJzYVhOMERRb2dJQ0FnS1RzTkNpQWdmU3dnYlc5a1pXd3NJSEpsY0dGeWMyVXBPdzBLZlEwS0RRb3ZMeUR0akozc2w0VWc3SjJSNjR1MTdKZVE3SVNjSUh0elpYUnpPaUJiZTNKbFlYTnZiaXdnWld4bGJXVnVkSE02VzN0eWIyeGxMSFJsZUhSOVhYMWRmU0RzdHBUc3Rwd2dLT3k5bE91VG5PMk9uT3lLcE1LMzdKV2U2NUtrSU95ZW9ldUx0Q0R0bDRqc21xa3BEUXBtZFc1amRHbHZiaUJ3WVhKelpWQnZjSFZ3S0hKaGR5a2dldzBLSUNCc1pYUWdjeUE5SUZOMGNtbHVaeWh5WVhjcExuUnlhVzBvS1M1eVpYQnNZV05sS0M5ZVlHQmdLRDg2YW5OdmJpay9YSE1xTDJrc0lDY25LUzV5WlhCc1lXTmxLQzljY3lwZ1lHQWtMMmtzSUNjbktUc05DaUFnWTI5dWMzUWdiU0E5SUhNdWJXRjBZMmdvTDF4N1cxeHpYRk5kS2x4OUx5azdEUW9nSUdsbUlDaHRLU0J6SUQwZ2JWc3dYVHNOQ2lBZ2RISjVJSHNOQ2lBZ0lDQmpiMjV6ZENCdklEMGdTbE5QVGk1d1lYSnpaU2h6S1RzTkNpQWdJQ0JqYjI1emRDQnpaWFJ6U1c0Z1BTQkJjbkpoZVM1cGMwRnljbUY1S0c4Z0ppWWdieTV6WlhSektTQS9JRzh1YzJWMGN5QTZJRnRkT3cwS0lDQWdJR052Ym5OMElITmxkSE1nUFNCelpYUnpTVzROQ2lBZ0lDQWdJQzV0WVhBb0tITjBLU0E5UGlBb2V3MEtJQ0FnSUNBZ0lDQnlaV0Z6YjI0NklGTjBjbWx1Wnlnb2MzUWdKaVlnYzNRdWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BMQTBLSUNBZ0lDQWdJQ0JsYkdWdFpXNTBjem9nUVhKeVlYa3VhWE5CY25KaGVTaHpkQ0FtSmlCemRDNWxiR1Z0Wlc1MGN5a05DaUFnSUNBZ0lDQWdJQ0EvSUhOMExtVnNaVzFsYm5SekRRb2dJQ0FnSUNBZ0lDQWdJQ0FnSUM1dFlYQW9LR1ZzS1NBOVBpQW9leUJ5YjJ4bE9pQlRkSEpwYm1jb0tHVnNJQ1ltSUdWc0xuSnZiR1VwSUh4OElDY25LUzUwY21sdEtDa3NJSFJsZUhRNklGTjBjbWx1Wnlnb1pXd2dKaVlnWld3dWRHVjRkQ2tnZkh3Z0p5Y3BMblJ5YVcwb0tTQjlLU2tOQ2lBZ0lDQWdJQ0FnSUNBZ0lDQWdMbVpwYkhSbGNpZ29aV3dwSUQwK0lHVnNMblJsZUhRcERRb2dJQ0FnSUNBZ0lDQWdPaUJiWFN3TkNpQWdJQ0FnSUgwcEtRMEtJQ0FnSUNBZ0xtWnBiSFJsY2lnb2MzUXBJRDArSUhOMExtVnNaVzFsYm5SekxteGxibWQwYUNrN0RRb2dJQ0FnY21WMGRYSnVJSE5sZEhNdWJHVnVaM1JvSUQ4Z2MyVjBjeUE2SUc1MWJHdzdEUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdEUW9nSUNBZ2NtVjBkWEp1SUc1MWJHdzdEUW9nSUgwTkNuME5DZzBLTHk4ZzY0eUE3Wm1VN1ppVklPeWduT3lla1NEc25aSHJpN1hzbDVEc2hKd2dlM0psY0d4NUxDQnpkV2RuWlhOMGFXOXVjMXRkZlNEc3RwVHN0cHdnS095OWxPdVRuTzJPbk95S3BNSzM3SldlNjVLa0lPeWVvZXVMdENEdGw0anNtcWtwRFFwbWRXNWpkR2x2YmlCd1lYSnpaVU52YlhCdmMyVW9jbUYzS1NCN0RRb2dJR3hsZENCeklEMGdVM1J5YVc1bktISmhkeWt1ZEhKcGJTZ3BMbkpsY0d4aFkyVW9MMTVnWUdBb1B6cHFjMjl1S1Q5Y2N5b3ZhU3dnSnljcExuSmxjR3hoWTJVb0wxeHpLbUJnWUNRdmFTd2dKeWNwT3cwS0lDQmpiMjV6ZENCdElEMGdjeTV0WVhSamFDZ3ZYSHRiWEhOY1UxMHFYSDB2S1RzTkNpQWdhV1lnS0cwcElITWdQU0J0V3pCZE93MEtJQ0IwY25rZ2V3MEtJQ0FnSUdOdmJuTjBJRzhnUFNCS1UwOU9MbkJoY25ObEtITXBPdzBLSUNBZ0lHTnZibk4wSUhKbGNHeDVJRDBnVTNSeWFXNW5LQ2h2SUNZbUlHOHVjbVZ3YkhrcElIeDhJQ2NuS1M1MGNtbHRLQ2s3RFFvZ0lDQWdZMjl1YzNRZ2MzVm5aMlZ6ZEdsdmJuTWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHOGdKaVlnYnk1emRXZG5aWE4wYVc5dWN5a05DaUFnSUNBZ0lEOGdieTV6ZFdkblpYTjBhVzl1Y3cwS0lDQWdJQ0FnSUNBZ0lDNXRZWEFvS0hncElEMCtJQ2g3SUhSbGVIUTZJRk4wY21sdVp5Z29lQ0FtSmlCNExuUmxlSFFwSUh4OElDY25LUzUwY21sdEtDa3NJSEpsWVhOdmJqb2dVM1J5YVc1bktDaDRJQ1ltSUhndWNtVmhjMjl1S1NCOGZDQW5KeWt1ZEhKcGJTZ3BJSDBwS1EwS0lDQWdJQ0FnSUNBZ0lDNW1hV3gwWlhJb0tIZ3BJRDArSUhndWRHVjRkQ2tOQ2lBZ0lDQWdJRG9nVzEwN0RRb2dJQ0FnYVdZZ0tISmxjR3g1SUh4OElITjFaMmRsYzNScGIyNXpMbXhsYm1kMGFDa2djbVYwZFhKdUlIc2djbVZ3Ykhrc0lITjFaMmRsYzNScGIyNXpJSDA3RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPeVZoT3VlbU91aG5DQXFMeUI5RFFvZ0lISmxkSFZ5YmlCdWRXeHNPdzBLZlEwS0RRb3ZMeURyc29qc2w2MGc3SjJSNjR1MTdKZVE3SVNjSUh0MGNtRnVjMnhoZEdWa0xDQmthWEpsWTNScGIyNTlJT3kybE95Mm5DQW83TDJVNjVPYzdZNmM3SXFrd3Jmc2xaN3JrcVFnN0o2aDY0dTBJTzJYaU95YXFTa05DbVoxYm1OMGFXOXVJSEJoY25ObFZISmhibk5zWVhSbEtISmhkeWtnZXcwS0lDQnNaWFFnY3lBOUlGTjBjbWx1WnloeVlYY3BMblJ5YVcwb0tTNXlaWEJzWVdObEtDOWVZR0JnS0Q4NmFuTnZiaWsvWEhNcUwya3NJQ2NuS1M1eVpYQnNZV05sS0M5Y2N5cGdZR0FrTDJrc0lDY25LVHNOQ2lBZ1kyOXVjM1FnYlNBOUlITXViV0YwWTJnb0wxeDdXMXh6WEZOZEtseDlMeWs3RFFvZ0lHbG1JQ2h0S1NCeklEMGdiVnN3WFRzTkNpQWdkSEo1SUhzTkNpQWdJQ0JqYjI1emRDQnZJRDBnU2xOUFRpNXdZWEp6WlNoektUc05DaUFnSUNCamIyNXpkQ0IwY21GdWMyeGhkR1ZrSUQwZ1UzUnlhVzVuS0NodklDWW1JRzh1ZEhKaGJuTnNZWFJsWkNrZ2ZId2dKeWNwTG5SeWFXMG9LVHNOQ2lBZ0lDQnBaaUFvZEhKaGJuTnNZWFJsWkNrZ2NtVjBkWEp1SUhzZ2RISmhibk5zWVhSbFpDd2daR2x5WldOMGFXOXVPaUJUZEhKcGJtY29LRzhnSmlZZ2J5NWthWEpsWTNScGIyNHBJSHg4SUNjbktTNTBjbWx0S0NrZ2ZUc05DaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN0pXRTY1Nlk2NkdjSUNvdklIME5DaUFnY21WMGRYSnVJRzUxYkd3N0RRcDlEUW9OQ2k4dklPeWRrZXVMdGV5WGtPeUVuQ0I3ZEdWNGRDd2djbVZoYzI5dWZTRHJzTERzbDdRZzdMYVU3TGFjSUNqc3ZaVHJrNXp0anB6c2lxVEN0K3lWbnV1U3BDRHNucUhyaTdRZzdaZUk3SnFwS1EwS1puVnVZM1JwYjI0Z2NHRnljMlZUZFdkblpYTjBhVzl1Y3loeVlYY3BJSHNOQ2lBZ2JHVjBJSE1nUFNCVGRISnBibWNvY21GM0tTNTBjbWx0S0NrdWNtVndiR0ZqWlNndlhtQmdZQ2cvT21wemIyNHBQMXh6S2k5cExDQW5KeWt1Y21Wd2JHRmpaU2d2WEhNcVlHQmdKQzlwTENBbkp5azdEUW9nSUdOdmJuTjBJRzBnUFNCekxtMWhkR05vS0M5Y1cxdGNjMXhUWFNwY1hTOHBPdzBLSUNCcFppQW9iU2tnY3lBOUlHMWJNRjA3RFFvZ0lIUnllU0I3RFFvZ0lDQWdZMjl1YzNRZ1lYSnlJRDBnU2xOUFRpNXdZWEp6WlNoektUc05DaUFnSUNCcFppQW9RWEp5WVhrdWFYTkJjbkpoZVNoaGNuSXBLU0I3RFFvZ0lDQWdJQ0J5WlhSMWNtNGdZWEp5RFFvZ0lDQWdJQ0FnSUM1dFlYQW9LSGdwSUQwK0lDaDdJSFJsZUhRNklGTjBjbWx1Wnlnb2VDQW1KaUI0TG5SbGVIUXBJSHg4SUNjbktTNTBjbWx0S0Nrc0lISmxZWE52YmpvZ1UzUnlhVzVuS0NoNElDWW1JSGd1Y21WaGMyOXVLU0I4ZkNBbkp5a3VkSEpwYlNncElIMHBLUTBLSUNBZ0lDQWdJQ0F1Wm1sc2RHVnlLQ2g0S1NBOVBpQjRMblJsZUhRcE93MEtJQ0FnSUgwTkNpQWdmU0JqWVhSamFDQW9YMlVwSUhzZ0x5b2c3SldFNjU2WTY2R2NJQ292SUgwTkNpQWdjbVYwZFhKdUlGdGRPdzBLZlEwS0RRb3ZMeURyb1p6cXQ3anNuYmdnN1pXRTdKcVV3cmZ0bFp6cmo0UWc3TFNJNnJPOElPeURnZTJEbk95ZHZDRHJsWXdnTDJobFlXeDBhQ0Rzb2JEdG1venFzSUFnN0ppazY2bTBJT3VTcE95WGtPeUVuQ0RzbTR6cnNJM3NsNFhzbllRZzY0dWs3SXVjSU95TG5PdVBoTzJWdE91enVPdUxwQ0FvTXpEc3RJanNsNUFnTWV1eWlPdW5qQ2t1RFFvdkx5RHNoTEhxczdYdGxaanJxYlFnNnJLdzZyTzhJTzJWdU91VHBPdWZyT3F3Z0NCamJHRjFaR1ZUZEdGMGRYTTlKMjlySit1aG5DRHJrSmpyajR6cnBxenJyNERyb1p3c0lPeWVyT3Vobk9xM3VPeWR1Q0R0bTRRZzY3S0U3WXE4N0oyMElPeWdnT3lnaU91aG5DRHduNStpN0p5ODY2R2NJT3V6dGVxM2dPMlZuT3VMcEM0TkNpOHZJQ2p0bEl6cm42enF0N2pzbmJqc25iUWc2NkdjNnJlNDdKMjRJT3l3dmV5ZGhDRHNsN0FnNjVLa0lPeWp2T3E0c095Z2dleWN2T3VobkNBdmFHVmhiSFJvNjZXOElPeWhzTzJhak8yVm1PdUtsQ0Rxc29QcXM3d2c3S2VkN0oyRUlPeWR0T3Vqck91THBDa05DaTh2SU8yVm5PdVBoQ0RzdElqcXM3enJqNFFnNnJDWjdKMkFJT3F5dmV1aG5PdWhuQ0RyczdYcXQ0RHNpNXp0Z3Fqcmk2UWc0b0NVSU9xMGdPdW1yT3lla09xd2dDRHRsWnpyajRUcnBid2c3SmlzNjZDazdLTzg2ckd3NjRLWUlPMlZuT3VQaE9xd2dDRHN0SWpxdUxEdG1aVHJrSmpycWJRTkNpOHZJT3lDck95YXFleWVrT3F3Z0NEc2xZVHJyTFRxc29Qcmo0UWc3SldJSU91SWpPdWZyT3VQaENEcnNvVHRpcnpzbmJRZzhKK2ZvdXljdk91aG5DRHJqNHpzbFlUc21LanJpNlF1SU8yVm5PdVBoT3lYa0NEcXNianJwckFnN1ppNDdMYWM3SjJBSU9xeHNPeWdpT3VRbU91dmdPdWhuQ0RzZ3F6c21xbnJuNG5zbllBZzdKV0lJT3VDbU9xd2hPdUxwQTBLTHk4ZzZyT0U3S0NWN0oyMElDb3E2N0NXN0plUTdJU2NLaW9nNjdDVTY0Q1FJT3F5Zyt5ZGhDRHNsWXpzbFlUc3NZanJpNlFnS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRJMktTNE5DaTh2SU8yRXNPdXZ1T3VFa095ZHRPdUNtQ0RydUl6cm5ienNtckRzb0lEc2w1RHNoSndnNjR1azY2VzRJT3F6aE95Z2xleWN2T3VobkNEcm9aenF0N2pzbmJqdGxaanJxYlFnN0o2UTZyS3A3S2FkNjZxRklPMk1qT3lkdk95ZGdDRHJzSlRyZ0l6c3A0RHJwNHdzSU95ZHRPdXZ1Q0RybHFBZzdKNkk2NHFVSUdOc1lYVmtaUTBLTHk4ZzdJUzQ3SVdZN0oyQUlPeUxuT3VQbWUyVm9DRHJsWXdnNjdDYjdKMkFJT3lZbXlEcXM0VHNvSlVnN0o2RjdKNmw2cmFNN0oyRUlPcTN1T3VNZ091aG5DRHNrN1RyaTZRZzRvYVNJT3lEaUNEcXM0VHNvSlhzbDVBZzdJS3M3SnFwNjUrSjdKMjBJT3VDcU95VmhDRHNub2pzbHJUcmo0UWdJdTJWbk91UGhDRHN0SWpxczd3aTZyQ0FEUW92THlEcXM0VHNobzBnNjRLWTdKaW82NHVrS0RJd01qWXRNRGdnN0l1azdMaWhJT3lMb09xem9Eb2dJdXlEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NkdjNnJlNDdKMjQ3WmFJNjRxVTY0MndJT3labkNEcXQ3Z2c2ck9FN0tDVklPeUNyT3lhcWV1ZmlleWRoQ0RycXJzZzdKT3c2NE9RSWlrdURRb3ZMeUR0bEl6cm42enF0N2pzbmJqc25ZUWc2ckd3N0xtY0lPdWhuT3EzdU95ZHVNSzM2NkdjNnJlNDdKV0U3SnVES0M5dmNHVnVMV3h2WjJsdXdyY3ZZMnhoZFdSbExXeHZaMjkxZENuc25ZQWdhMmxzYkZCeWIyUHNuTHpyb1p3ZzdJUzQ3SVdZN0oyRUlPdXloT3VncE95RW5DRHNuYlFnNjZ5NDdLQ2M2ckNBRFFvdkx5RHNsNGJzbDRqcmlwVHJqYkFzSU91d2x1eVhrT3lFbkNEcnNKVHF2cmpycWJRZzY0dWs2NmFzNnJDQUlPeVZqQ0Ryc0tucnNwWHNuYlFnN0plRzdKZUk2NHVrTGlEcXQ3anJucGpzaEp3Z0wyaGxZV3gwYUNEc29iRHRtb3pycDRqcmk2UWc3WXlNN0oyODdKMllJT3F6aE95Z2xlcXp2Q0RydVlUcXRaRHRsWnpyaTZRdURRb3ZMeURydVlUc21xa2dNQ2p0akl6c25ienJwNHdnN0oyOTZyT2dMQ0JqYkdGMVpHVkJZMk52ZFc1MDdKMllJRE13N0xTSUlPeTZrT3lMbk91bHZDRHF0N2pyaklEcm9ad2c3Sk8wNjR1a0lPS0FsQ0F1WTJ4aGRXUmxMbXB6YjI3c25iUWc3THVrN0lTY0lPdW5wT3V5aUNEc25iM3NwNEFnN0pXSzY0cVU2NHVrS1M0TkNpOHZJT3F6aE95Z2xTRHNub2pzbll3ZzRvYVNJT3lYaHV5ZGpDanJvWnpxdDdqc2xZVHNtNE1wSU91d3FlMldwZXlkZ0NEcXNiVHJrNXpycHF6c3A0QWc3SldLNjRxVTY0dWtPaUR0akl6c25ienNuWVFnNjQydTdKYTA3Sk93NjRxVUlPeUluT3F3aENEc25xRHF1WkFnNjZxN0lPeWR2ZXVLbENEcXNvUHFzN3dOQ2k4dklPcTFyT3UyaE91UW1PeW5nQ0RzbFlyc2xZUWc3WmViSU95ZXJPeUxuT3lla2V5ZGhDRHJ0b0RycGJUcXM2QXNJT3EzdUNEcnNLbnRscVhzbllBZzdKMjQ3S2FkSU95WXBPdWxtQ0Rxc3Izcm9ad29hWE5CZFhSb1JYSnliM0lwNnJDQUlPeWR0T3V2dUNEc3NwanJwcXp0bFp6cmk2UXVEUXBtZFc1amRHbHZiaUJ5WlhOMFlYSjBTV1pCWTJOdmRXNTBRMmhoYm1kbFpDZ3BJSHNOQ2lBZ2FXWWdLQ0Z3Y205aklIeDhJSGRoYVhSbGNpa2djbVYwZFhKdU95QWdJQ0FnSUNBZ0lDOHZJT3lFdU95Rm1DRHNsNGJzbll3bzY0dWs3SjJNSU8yRXRPeWR0Q0RzZzRqcm9ad2c3SXVjNjQrWktTQXZJTzJFdENEc3A0VHRsb2tnN0tTUjdKMjA2Nm0wSU91THBPeWRqQ0Rzb2JEdG1venNsNURzaEp3TkNpQWdZMjl1YzNRZ2JtOTNJRDBnWTJ4aGRXUmxRV05qYjNWdWRDZ3BPdzBLSUNCcFppQW9JVzV2ZHlCOGZDQnViM2NnUFQwOUlITmxjM05wYjI1QlkyTnZkVzUwS1NCeVpYUjFjbTQ3RFFvZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RxczRUc29KWHNuYlFnNjdDVTY0Q003SmVJN0phMDdKcVVJQ2duSUNzZ0tITmxjM05wYjI1QlkyTnZkVzUwSUh4OElDZnNsNGJzbll3bktTQXJJQ2NnNG9hU0lDY2dLeUJ1YjNjZ0t5QW5LU0RpZ0pRZzdKaWJJT3F6aE95Z2xTRHNoTGpzaFpqc25ZUWc2N0tFNjZhczZyT2dJT3lEaUNEcXM0VHNvSlhzbkx6cm9ad2c2NHVrN0l1Y0lPeUxuT3lla2UyVnFldUxpT3VMcEM0bktUc05DaUFnTHk4ZzdKMlk2NCtFN0tDQklPeWloZXVqakNoeVpXRnpiMjRnN0tlQTdLQ1ZLU0RpZ0pRZ1UwVlRVMGxQVGw5RVNVVkU2NkdjSU91Qm5ldUN0T3VwdENEc25wRHJqNWtnN0o2czdJdWM2NCtFNnJDQUlPeVlteURxczRUc29KVWc3SVM0N0lXWTdKMkVJT3VRbU95Q3RPdW1zT3VMcEEwS0lDQnJhV3hzVUhKdll5Z242ck9FN0tDVjdKMjBJT3V3bE91QWpPeVd0T3lFbkNEc2hManNoWmpzbllRZzdJT0k2NkdjSU95TG5PeWVrZTJXaU95V3RPeWFsQ0RpZ0pRZzY0dWs3SXVjSU95TG5PdVBoTzJWdENEc283enNoTGpzbXBRdUp5azdEUW9nSUdOc1lYVmtaVk4wWVhSMWN5QTlJRzUxYkd3N0lDOHZJTzJWbk91UGhNSzM2NkdjNnJlNDdKMjRJT3lEZ2UyRG5PdUtsQ0RxczRUc29KWHJwNGpyaTZRZzY0dWs2NlcwNjR1a0lPS0FsQ0RzZzRnZzZyT0U3S0NWN0p5ODY2R2NJT3VMcE95TG5DRHRqSkRzb0pYdGxaanFzb3dOQ2lBZ2MyVnpjMmx2YmtGalkyOTFiblFnUFNCdWIzYzdEUXA5RFFvTkNteGxkQ0JzWVhOMFFYVjBhRkpsZEhKNVFYUWdQU0F3T3cwS1puVnVZM1JwYjI0Z2NtVjBjbmxCZFhSb1NXWk9aV1ZrWldRb0tTQjdEUW9nSUdsbUlDaGpiR0YxWkdWVGRHRjBkWE1nSVQwOUlDZGpiR0YxWkdVdGJHOW5iM1YwSnlBbUppQmpiR0YxWkdWVGRHRjBkWE1nSVQwOUlDZGpiR0YxWkdVdGJHbHRhWFFuS1NCeVpYUjFjbTQ3RFFvZ0lHbG1JQ2gzWVdsMFpYSWdmSHdnUkdGMFpTNXViM2NvS1NBdElHeGhjM1JCZFhSb1VtVjBjbmxCZENBOElETXdNREF3S1NCeVpYUjFjbTQ3SUM4dklPeW5oTzJXaVNEc3BKRWc3WVMwSU91d3FlMlZ0Q0RxdUlqc3A0QWdLeUF6TU95MGlDRHFzSVRxc3FrTkNpQWdiR0Z6ZEVGMWRHaFNaWFJ5ZVVGMElEMGdSR0YwWlM1dWIzY29LVHNOQ2lBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0RzbnF6dG1aWHNuYmdnN0l1YzY0K0U0b0NtSnlrN0RRb2dJSEoxYmxSMWNtNG9LQ2tnUFQ0Z0ordWhuT3EzdU95ZHVDRHRtWlhzbmJqc21xbnNuYlRyaTZRdUlDSlBTeUxybmJ6cXM2RHJwNHdnNjR1MTdaV1k2NTI4TGljcExuUm9aVzRvRFFvZ0lDQWdLQ2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3Vobk9xM3VPeWR1Q0R0bVpYc25ianJrS2dnNG9DVUlPeWdsZXlEZ1NEc2c0SHRnNXpyb1p3ZzY3TzE2cmVBTGljcExBMEtJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKV0U3S2VCSU91aG5PcTN1T3lkdUNEc2xZZ2c2NUNvT2ljc0lGTjBjbWx1WnlobExtMWxjM05oWjJVcExuTnNhV05sS0RBc0lEZ3dLU2tOQ2lBZ0tUc05DbjBOQ2cwS0x5OGc3SXVrN1l5b0lPeWRrZXVMdGV5ZGhDRHNncXpybm96c21xa2c3SldJNjRLMDY2R2NJT3V6Z08yWm1DRGlnSlFnN0p1UTdKMjRLT3Vobk9xM3VPeWR1Qy9zaEtUc3VaZ3A3SjIwSU8yTWpPeVZoZXVRbkNEcXNyM3NtckRzbDVRZzZyZTRJT3lWaU91Q3RPdWx2Q3dnN0pXRTY0dUk2Nm0wSU95Z2tldVJrT3lXdEN2c201RHJyTGpzbllRZzY3TzA2NEs0NjR1a0RRcG1kVzVqZEdsdmJpQm1jbWxsYm1Sc2VVVnljbTl5S0dVc0lIQnlaV1pwZUNrZ2V3MEtJQ0JwWmlBb1pTQW1KaUJsTG0xbGMzTmhaMlVnUFQwOUlFeFBSMGxPWDBkVlNVUkZLU0J5WlhSMWNtNGdleUJsY25KdmNqb2dURTlIU1U1ZlIxVkpSRVVzSUhCeWIySnNaVzA2SUNkamJHRjFaR1V0Ykc5bmIzVjBKeUI5T3cwS0lDQnBaaUFvWlNBbUppQmxMbTFsYzNOaFoyVWdQVDA5SUV4SlRVbFVYMGRWU1VSRktTQnlaWFIxY200Z2V5Qmxjbkp2Y2pvZ1RFbE5TVlJmUjFWSlJFVXNJSEJ5YjJKc1pXMDZJQ2RqYkdGMVpHVXRiR2x0YVhRbklIMDdEUW9nSUdsbUlDaGpiR0YxWkdWVGRHRjBkWE1nUFQwOUlDZGpiR0YxWkdVdGJXbHpjMmx1WnljcElIc05DaUFnSUNCeVpYUjFjbTRnZXlCbGNuSnZjam9nSit5ZHRDQlFRK3lYa0NCRGJHRjFaR1VnUTI5a1pTaGpiR0YxWkdVcDZyQ0FJT3lFcE95NW1PdVB2Q0Rzbm9qc3A0QWc3SldLN0pXRTdKcVVJT0tBbENEc2hLVHN1Wmp0bFpqcXM2QWc2NkdjNnJlNDdKMjQ3WldjSU91U3BDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNG5MQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25JSDA3RFFvZ0lIME5DaUFnY21WMGRYSnVJSHNnWlhKeWIzSTZJSEJ5WldacGVDQXJJQ2hsSUNZbUlHVXViV1Z6YzJGblpTQS9JR1V1YldWemMyRm5aU0E2SUZOMGNtbHVaeWhsS1NrZ2ZUc05DbjBOQ2cwS1puVnVZM1JwYjI0Z2NtVmhaRUp2Wkhrb2NtVnhLU0I3RFFvZ0lISmxkSFZ5YmlCdVpYY2dVSEp2YldselpTZ29jbVZ6YjJ4MlpTa2dQVDRnZXcwS0lDQWdJR3hsZENCaWIyUjVJRDBnSnljN0RRb2dJQ0FnY21WeExtOXVLQ2RrWVhSaEp5d2dLR01wSUQwK0lIc2dZbTlrZVNBclBTQmpPeUI5S1RzTkNpQWdJQ0J5WlhFdWIyNG9KMlZ1WkNjc0lDZ3BJRDArSUhzTkNpQWdJQ0FnSUhSeWVTQjdJSEpsYzI5c2RtVW9TbE5QVGk1d1lYSnpaU2hpYjJSNUtTazdJSDBnWTJGMFkyZ2dLRjlsS1NCN0lISmxjMjlzZG1Vb2UzMHBPeUI5RFFvZ0lDQWdmU2s3RFFvZ0lIMHBPdzBLZlEwS0RRcGpiMjV6ZENCRFQxSlRYMGhGUVVSRlVsTWdQU0I3RFFvZ0lDZEJZMk5sYzNNdFEyOXVkSEp2YkMxQmJHeHZkeTFQY21sbmFXNG5PaUFuS2ljc0RRb2dJQ2RCWTJObGMzTXRRMjl1ZEhKdmJDMUJiR3h2ZHkxTlpYUm9iMlJ6SnpvZ0owZEZWQ3dnVUU5VFZDd2dUMUJVU1U5T1V5Y3NEUW9nSUNkQlkyTmxjM010UTI5dWRISnZiQzFCYkd4dmR5MUlaV0ZrWlhKekp6b2dKME52Ym5SbGJuUXRWSGx3WlNjc0RRcDlPdzBLWm5WdVkzUnBiMjRnYW5OdmJpaHlaWE1zSUhOMFlYUjFjeXdnYjJKcUtTQjdEUW9nSUhKbGN5NTNjbWwwWlVobFlXUW9jM1JoZEhWekxDQlBZbXBsWTNRdVlYTnphV2R1S0hzZ0owTnZiblJsYm5RdFZIbHdaU2M2SUNkaGNIQnNhV05oZEdsdmJpOXFjMjl1T3lCamFHRnljMlYwUFhWMFppMDRKeUI5TENCRFQxSlRYMGhGUVVSRlVsTXBLVHNOQ2lBZ2NtVnpMbVZ1WkNoS1UwOU9Mbk4wY21sdVoybG1lU2h2WW1vcEtUc05DbjBOQ2cwS1kyOXVjM1FnYzJWeWRtVnlJRDBnYUhSMGNDNWpjbVZoZEdWVFpYSjJaWElvWVhONWJtTWdLSEpsY1N3Z2NtVnpLU0E5UGlCN0RRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RIUlZRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdmFHVmhiSFJvSnlrZ2V3MEtJQ0FnSUhKbGMzUmhjblJKWmtGalkyOTFiblJEYUdGdVoyVmtLQ2s3SUM4dklPdXdsdXlYa095RW5DRHFzNFRzb0pYc25ZUWc2N0NVNnIrbzdKeTg2Nm0wSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRUlPdW92T3lnZ0NEcnNvVHJwckRyaTZRZ0tPeVZoT3VlbUNEc200enJzSTNzbDRYc25iUWc3SmliSU9xemhPeWdsZXljdk91aG5DRHJqNHpzcDRBZzdKV0s2cktNS1EwS0lDQWdJSEpsZEhKNVFYVjBhRWxtVG1WbFpHVmtLQ2s3SUM4dklPdWhuT3EzdU95ZHVDRHRsWVRzbXBRZzdJT0I3WU9jNjZtMElPeWVyTzJabGV5ZHVDRHNpNXpyajRRZzRvQ1VJT3llck91aG5PcTN1T3lkdU95ZHRDRHJnWjNyZ3F6c25MenJxYlFnNjR1azdKMk1JT3loc08yYWpPdTJnTzJFc0NCd2NtOWliR1Z0N0oyMElPMlNnT3Vtc091THBBMEtJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdEUW9nSUNBZ0lDQnZhem9nZEhKMVpTd2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5d2dkam9nUWxKSlJFZEZYMVlzSUdScGNqb2dYMTlrYVhKdVlXMWxMQ0F2THlCMndyZGthWEk2SU9xMXJPdXloT3lnaEMvc2w0bnJtckh0bFp3ZzdJS3M2N080N0oyMElPdVdvQ0Rzbm9qcmlwVHNwNEFnN0tlRTY0dW83SnFwRFFvZ0lDQWdJQ0J0YjJSbGJEb2dZM1Z5Y21WdWRFMXZaR1ZzTENCdGIyUmxiSE02SUVGTVRFOVhSVVJmVFU5RVJVeFRMQ0JsZUdGdGNHeGxjem9nUlZoQlRWQk1SVk11YkdWdVozUm9MQ0JuZFdsa1pUb2dSMVZKUkVVdWJHVnVaM1JvTENCeVpXRmtlVG9nZDJGeWJXVmtWWEFzRFFvZ0lDQWdJQ0J3Y205aWJHVnRPaUFvWTJ4aGRXUmxVM1JoZEhWeklEMDlQU0FuYjJzbklIeDhJR05zWVhWa1pWTjBZWFIxY3lBOVBUMGdiblZzYkNrZ1B5QnVkV3hzSURvZ1kyeGhkV1JsVTNSaGRIVnpMQTBLSUNBZ0lDQWdZV05qYjNWdWREb2dZMnhoZFdSbFFXTmpiM1Z1ZENncExBMEtJQ0FnSUNBZ2MyVnlkbVZrT2lCemRHRjBjeTV6WlhKMlpXUXNJR3hoYzNSQmREb2djM1JoZEhNdWJHRnpkRUYwTENCc1lYTjBWR1Y0ZERvZ2MzUmhkSE11YkdGemRGUmxlSFFzSUd4aGMzUlRaV002SUhOMFlYUnpMbXhoYzNSVFpXTXNEUW9nSUNBZ2ZTazdEUW9nSUgwTkNpQWdMeThnN1pTTTY1K3M2cmU0N0oyNElPeUxyT3llcGV1d2xldVBtU0RpZ0pRZzY0R0s2cml3NjZtMElPeWNoQ0Rxc0pEc2k1d2c3WU9BN0oyMDY2aTQ2ckNBSU91THBPdW1yT3VsdkNEcmdZanJpNlFOQ2lBZ2FXWWdLSEpsY1M1dFpYUm9iMlFnUFQwOUlDZFFUMU5VSnlBbUppQnlaWEV1ZFhKc0lEMDlQU0FuTDJobFlYSjBZbVZoZENjcElIc05DaUFnSUNCc1lYTjBRbVZoZENBOUlFUmhkR1V1Ym05M0tDazdEUW9nSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VnZlNrN0RRb2dJSDBOQ2lBZ0x5OGc2NkdjNnJlNDdKMjRJT0tBbENEdGxJenJuNnpxdDdqc25ianNuWmdnVy9DZm42QWc3WUcwNjZHYzY1T2NJT3Vobk9xM3VPeWR1Q0R0bFlUc21wUmR3cmRiOEorVWtWMGc2N0tFN1lxODdKMjBJTzJZdU95Mm5PMlZuT3VMcEM0TkNpQWdMeThnNnJpdzY3TzRLT3U0ak91ZHZPeWFzT3lnZ0NEc3A0SHRsb2twT2lCZ1kyeGhkV1JsSUdGMWRHZ2diRzluYVc0Z0xTMWpiR0YxWkdWaGFXRHJwYndnN0lpbzdKMkFJTzJVaE91aG5PeUV1T3lLcE91aG5DRHNpNlR0bG9rZzRvQ1VJT3VwbE91SnRDRHNsNGJzbmJRZzZyT243SjZsSU91NGpPdWR2T3lhc095Z2dPdWx2Q0RzbDdUcXM2QXNEUW9nSUM4dklDQWdiRzlqWVd4b2IzTjBJT3lJbU95TG9DRHRqNnp0aXJqcm9ad2c2ckt3NnJPODY2VzhJT3lla091UG1TRHNpSmpyb0xudGxaenJpNlFvN0l1azdMaWhPaUR0bDZUcms1enJwcXpzaXFUc2w1RHNoSnpyajRRZzY3aU02NTI4N0pxdzdLQ0FJT3lYdE91bXZDQXJJRXhKVTFSRlRpRHRtWlhzbmJnc0lESXdNall0TURjcExnMEtJQ0F2THlBZ0lPMkVzT3V2dU91RWtPeWR0Q0R0bVpUcnFiVHNsNUFnN0tDRTdaaUFJT3lWaUNEcm5LenJpNlF1SU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianJwNHdnN1pXWTY2bTBJT3VCblM0TkNpQWdMeThnN1krMDY3Q3hLTzJFc091dnVPdUVrQ2s2SU95ZWtPdVBtU0RzbVlUcm80enFzSUFnNjZlSjdaNk1JTzJabU9xeXZTanJ1SXpybmJ6c21yRHNvSURxc0lBZ2JHOWpZV3hvYjNOMDdKZVFJT3VxdXlEcmk3L3NsWVFnN0wyVTY1T2M2ckNBSU91enRPeWR0T3VLbENEcXNyM3NtckFwN0plUTdJU2NEUW9nSUM4dklDQWc2NkdjNnJlNDdKMjRJT3VNZ09xNHNDRHNwSkVnNjdLRTdZcTg3SjJFSU91WWtDRHJpSVRycGJUcnFiUXNJT3k5bE91VG5PdWx2Q0RydHBuc2w2enJoS1BzbllRZzdJaVlJT3llaU91S2xDRHRoTERycjdqcmhKQWc2N0NwN0l1ZDdKeTg2NkdjSU95Z2hPMlptTzJWbk91THBDNE5DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MMjl3Wlc0dGJHOW5hVzRuS1NCN0RRb2dJQ0FnWTI5dWMzUWdZbTlrZVNBOUlHRjNZV2wwSUhKbFlXUkNiMlI1S0hKbGNTazdEUW9nSUNBZ1kyOXVjM1FnYzNkcGRHTm9UVzlrWlNBOUlDRWhLR0p2WkhrZ0ppWWdZbTlrZVM1emQybDBZMmhCWTJOdmRXNTBLVHNnTHk4ZzZyT0U3S0NWSU95Z2hPMlptQ0E5SU95TG5PMkJyT3VtdnlEc3NMM3NuTHpyb1p3ZzdKZTA3SmEwSU9xemhPeWdsZXlkaENEcXM2RHJwYndnN0lpWUlPeWVpT3F5akEwS0lDQWdJSFJ5ZVNCN0RRb2dJQ0FnSUNBdkx5QmpiR0YxWkdYcXNJQWc3SmVHN0p5ODY2bTBJT3lYck9xNHNPeUVuQ0RyZ1lycmlwVHJpNlF1SUhOb1pXeHNPblJ5ZFdYcm5id2dZMnhoZFdSbDZyQ0FJT3lYaHV5V3RPdVBoQ0RzaGJqc25ZQWc3S0NWN0lPQklPeUxwTzJXaWV1UHZBMEtJQ0FnSUNBZ0x5OGdjM0JoZDI3c25aZ2dKMlZ5Y205eUorcXdnQ0RzbFlnZzY1eW82ck9nTENEc21JanNvSVRzbDVRZzZyZTQ2NHlBNjZHY0lHOXJPblJ5ZFdYcnBid2c2NCtNNjZDazdLU3M2NHVrSU9LQWxBMEtJQ0FnSUNBZ0x5OGc3WlNNNjUrczZyZTQ3SjI0N0oyQUlDTHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdKZTA3SmVJN0phMDdKcVVJdXVkdk9xem9DRHRsWmpyaXBUcmpiQWc3SXVrN0tDYzY2R2M2NHFVSU95VmhPdXN0T3F5Zyt1UGhDRHNsWWdnNjV5bzY0cVVJT3lEZ2UyRG5PcXdnQ0Rya0pEcmk2UW83SXVrN0tDY0lPeUxvT3F6b0NrdURRb2dJQ0FnSUNCcFppQW9ZMnhoZFdSbFUzUmhkSFZ6SUQwOVBTQW5ZMnhoZFdSbExXMXBjM05wYm1jbktTQjdEUW9nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF4TENCN0RRb2dJQ0FnSUNBZ0lDQWdaWEp5YjNJNklDZnNuYlFnVUVQc2w1QWdRMnhoZFdSbElFTnZaR1hxc0lBZzdKZUc3SmEwN0pxVUlPS0FsQ0R0aExEcnI3anJoSkRzbDVEc2hKd2dZMnhoZFdSbElDMHRkbVZ5YzJsdmJpRHNuYlFnNjVDWTY0cVU3S2VBSU8yWmxleWR1TzJWdENEc283enNoTGpzbXBRdUp5d05DaUFnSUNBZ0lDQWdJQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25MQTBLSUNBZ0lDQWdJQ0I5S1RzTkNpQWdJQ0FnSUgwTkNpQWdJQ0FnSUM4dklPeW5oTzJXaVNEc3BKSHNuYmpyamJBZzY1aVFJT3VJak91Z2dPdUxwQ0RpZ0pRZzdKdVE3TG1aN0oyQUlDTHJ1SXpybmJ6c21yRHNvSURyb1p3ZzY0dWs3SXVjSU95WHRPcTRzQ0xyaTZRdUlPMkVzT3V2dU91RWtPeWRnQ0FxS3V5d3ZleWRoQ0RzbFlUcnJMVHFzb1ByajRRZzY2cTdJT3VkaE95Ym9PeWRoQ0RybFl6cnA0d3FLaTROQ2lBZ0lDQWdJQzh2SU95WWlPeWdoT3lYbENBbk5qRHN0SWdnNjRTWTZyS01JT3VNZ09xNHNDRHNwSkhzbmJUcnFiUWc3WVN3NjYrNDY0U1FKK3lkdE95WGlPdUtsT3VOc0N3ZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95ZGhDRHNuYjNxc2JEcmdwZ2c3SjZnNnJtUUlPdVV0Q0RzbmJ3ZzdaV1k2NHVrSU91THBPeUxuQ0RyaUlUcnBiZ05DaUFnSUNBZ0lDOHZJT3lnbGV5RGdleWdnZXlkdUNEcXNyM3NtckRzbDVEcmo0UWdZMjFrSU95d3ZleWR0Q0R0aW9Ec2xyVHJncGpzbVpUcmk2UW9NakF5Tmkwd09DRHNpNlRzdUtFZzdJdWc2ck9nT2lBaTdZU3c2Nis0NjRTUUlPMlpsT3VwdE95ZGdDRHNtWndnNjVhZ0lPcXdrZXlla09xNHNDSXBMZzBLSUNBZ0lDQWdMeThnN0oyMDdLQ2NJT3lhc091bXJPcXdnQ0Rzc0wzc25ZUWc3S2VCN0tDUklPeVh0T3F6b0NEc2hMSHFzN1VnN0plczY3YUFLR3h2WjJsdVYybHVaRzkzVDNCbGJtVmtLZXVsdkNEc2xZVHJpNGpxdVl3c0lPeUxuT3F3aE95ZHRDRHNsWVRyaTRqcm5id2c2cmU0SU95Q3JPeUxwT3VobkNEdGpKRHJpNmp0bFp6cmk2UXVEUW9nSUNBZ0lDQmpiMjV6ZENCemRHRnNaU0E5SUd4dloybHVVSEp2WXlBbUppQWhiRzluYVc1WGFXNWtiM2RQY0dWdVpXUWdKaVlnS0VSaGRHVXVibTkzS0NrZ0xTQnNiMmRwYmxOMFlYSjBaV1JCZENBK0lESXdNREF3S1RzTkNpQWdJQ0FnSUdsbUlDaHNiMmRwYmxCeWIyTWdKaVlnYzNSaGJHVXBJSHNOQ2lBZ0lDQWdJQ0FnYTJsc2JFeHZaMmx1VUhKdll5Z3BPdzBLSUNBZ0lDQWdJQ0JwWmlBb0lXOXdaVzVNYjJkcGJsUmxjbTFwYm1Gc0tDa3BJSHNOQ2lBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01Td2dleUJsY25KdmNqb2dKK3lkdENCUFUreVhrT3lFb0NEc25wRHJqNW5zbkx6cm9ad2c2NnE3SU95WHRPeVd0T3lhbENEaWdKUWc3WVN3NjYrNDY0U1E3SmVRN0lTY0lHTnNZWFZrWlNEc2k2VHRsb2tnN1p1RUlDOXNiMmRwYmlEdGxiUWc3S084N0lTNDdKcVVMaWNnZlNrN0RRb2dJQ0FnSUNBZ0lIME5DaUFnSUNBZ0lDQWdMeThnN0oyWTY0K0U3S0NCSU95aWhldWpqQ2h5WldGemIyNGc3S2VBN0tDVktTRGlnSlFnN0tlRTdaYUpJT3lra1NEdGhMVHNuWVFnVTBWVFUwbFBUbDlFU1VWRTY2R2NJT3VCbmV1Q3RPdXB0Q0RzbnBEcmo1a2c3SjZzN0l1YzY0K0U2ckNBSU95WW15RHFzNFRzb0pVZzdJUzQ3SVdZN0oyRUlPdVFtT3lDdE91bXNPdUxwQTBLSUNBZ0lDQWdJQ0JyYVd4c1VISnZZeWduNjZHYzZyZTQ3SjI0N0oyRUlPeW5oTzJXaWUyVm1PdUtsQ0RzcEpIc25iVHJuYndnN0pxVTdMS3Q3SjJFSU95a2tldUxxTzJXaU95V3RPeWFsQ0RpZ0pRZzY2R2M2cmU0N0oyNElPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRuS1RzTkNpQWdJQ0FnSUNBZ1lXTmpiM1Z1ZEVOaFkyaGxMbUYwSUQwZ01Ec05DaUFnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91aG5PcTN1T3lkdUNEdGo3VHJzTEVnNG9DVUlPMkVzT3V2dU91RWtDRHJzS25zaTUzc25MenJvWndnN0tDRTdabVlMaWNwT3cwS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnYlc5a1pUb2dKM1JsY20xcGJtRnNKeUI5S1RzTkNpQWdJQ0FnSUgwTkNpQWdJQ0FnSUM4dklPdXdxZXE0aUNEc2k1enNucEh0bFp3ZzY2R2M2cmU0N0oyNDdKMjBJT3lDdE95VmhDRHNub2pzbkx6cnFiUWc3SWFRNjR5QTdLZUFJT3lWaXV1S2xPdUxwQ0RpZ0pRZzdLTzk3SjIwNjZtMElPeUNyT3lhcWV5ZWtPcXdnQ0RyczdUcXM2QWc3SjZJNjRxVUlPMkRyZXlkbUNEc3ZaenJzTEVnN1krczdZcTQ2ckNBRFFvZ0lDQWdJQ0F2THlEcmk2dnRtSUFnSW14dlkyRnNhRzl6ZE95WGtPeUVuQ0RzbDdEcXNyRHNuWVFnNnJHdzY3YUE3WmFJN0lxMTY0dUk2NHVrSXVxd2dDRHJuS3pyaTZRb01qQXlOaTB3T0NEc2k2VHN1S0VnN0l1ZzZyT2dLUzROQ2lBZ0lDQWdJR2xtSUNoc2IyZHBibEJ5YjJNZ0ppWWdSR0YwWlM1dWIzY29LU0F0SUd4dloybHVVM1JoY25SbFpFRjBJRHdnTVRVd01EQXBJSHNOQ2lBZ0lDQWdJQ0FnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDRHNzTDNzbmJRZzdKMjA2Nis0SU95WHRPdWdwQ0Rzbm9qc2xyVHNtcFFnNG9DVUlPeURpT3VobkNEc2w3VHNwNEFnN0pXSzZyT2dJT3EzdUNEc3NMM3NuWVFnN0pPdzdJUzQ3SnFVTGljcE93MEtJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lESXdNQ3dnZXlCdmF6b2dkSEoxWlN3Z2JXOWtaVG9nSjJGc2NtVmhaSGt0YjNCbGJpY2dmU2s3RFFvZ0lDQWdJQ0I5RFFvZ0lDQWdJQ0JyYVd4c1RHOW5hVzVRY205aktDazdJQzh2SU95Vm51eUVvQ0RydUl6cm5ienNtckRzb0lBZzY2R2M2cmU0N0oyNDdKMjBJT3VNZ09xNHNDRHNwSkhzbmJUcnFiUWc3S0NSNnJPZ0lPeURpT3VobkNEc2w3RHJpNlFnS095d3ZleWRoQ0RyaTZ2c2xaanFzYkRyZ3BnZzY0dWs3SXVjSU91SWhPdWx1Q0Rxc3Izc21yQXBEUW9nSUNBZ0lDQnNiMmRwYmxOMFlYSjBaV1JCZENBOUlFUmhkR1V1Ym05M0tDazdEUW9nSUNBZ0lDQnNiMmRwYmxkcGJtUnZkMDl3Wlc1bFpDQTlJR1poYkhObE95QXZMeURzbmJUcnNvZ2c3SXVjNjQrRTdKMllJT3l3dlNEc2w3VHF1TEFnN0lTeDZyTzFJT3lYck91MmdDRGlnSlFnN0pXRTY1Nlk3SmVRN0lTY0lPeUV1T3lhdE91THBBMEtJQ0FnSUNBZ0x5OGdRbEpQVjFORlV1dUtsQ0Rxc2JUcms1enJwcXpzcDRBZzdKV0s2NHFVNjR1a0lPS0FsQ0JEVEVucXNJQWc2cml3NjdPNElPdTRqT3Vkdk95YXNPeWdnT3VsdkNEc2w3VHFzNkFnYkc5allXeG9iM04wNjZHY0lPcXlzT3F6dk91bHZDRHNucERyajVrZzdJaVk2NkM1N1pXYzY0dWtEUW9nSUNBZ0lDQXZMeUFvN0p5RUlDZnJvWnpxdDdqc25ianNuWUFnUTB4SjZyQ0FJT3E0c091enVDRHJ1SXpybmJ6c21yRHNvSURycGJ3ZzdLZUI3S0NSSU95WHRPcXlqQ0R0bFp6cmk2UW5JT3lqdk95RW5TRGlnSlFnNnJDQTY2R2M3TEdFNjZtMElPeTlsT3VUbkNEcnRwbnNsNnpyaEtQcXVMQWc3Wm1VNjZtMDdKMjBJT3Vjck91THBDa3VEUW9nSUNBZ0lDQXZMeUFxS3VxemhPeWdsU0Rzb0lUdG1aanNuWUFnN0p1NUlPdWhuT3EzdU95VmhPeWJnK3lkaENEcnFMenNvSUFnN0pldzY0dWtLaW9vTWpBeU5pMHdPQ3dnUWxKSlJFZEZYMVk5TXpFcE9pRHJ1SXpybmJ6c21yRHNvSURzbDVBZzdJUzQ3SVdZN0oyMElPdUNxT3lWaENEc25vanNuTHpycWJRTkNpQWdJQ0FnSUM4dklHRjFkR2h2Y21sNlplcXdnQ0RxczRUc29KWHNuWVFnNjZ5NzdLZUFJT3lWaXVxem9DRHNpcm5zbmJnZzdabVU2Nm0wNjZlTUlPdWRoT3lhdE91THBDZ2k3SXE1N0oyNElPMlpsT3VwdENEcnA1RHFzNkFnNjZHYzZyZTQ3SjI0SU8yWmxPdXB0T3ljdk91aG5DRHFzSURxczZBZzdJdTI2NHVrSWlEc21wVHF0YXdwTGcwS0lDQWdJQ0FnTHk4ZzdJUzQ3SVdZN0oyRUlPeW5nT3lhdENEcmtxUWc3SmUwNjZtMElPdWhuT3EzdU95ZHVDRHRtWlRycWJUcnRvRHRoTEFnNjRLWTdKaW82NHVrSU9LQWxDQlZVa3pzbllRZzZyQ0E2ck8xN1pXWTdLZUE2NCtFS095eXRPeWR0T3VMblNEc2k2VHRqS2dwTENCQ1VrOVhVMFZTNjZXOElPcXdnT3Vobk95eGhPeW5nT3VQaEEwS0lDQWdJQ0FnTHk4Z0tPeTlsT3VUbkNEcnRwbnNsNnpyaEtQcXVMQWc3SnlnNjdDY0tTd2c2N2lNNjUyODdKcXc3S0NBNjZXOElPcXpvT3VsdE95bmdPdVBoQ2pxdUxEcnM3Z2c2N2lNNjUyODdKcXc3S0NBSU95VmhPdUxtQ2tnN0pXSzY0cVVJT3ljb095ZHZPMlZuQ0Ryc0tucnNwVXVEUW9nSUNBZ0lDQXZMeURydG9Ec25wSHNtcWs2SU91NGpPdWR2T3lhc095Z2dPeWRtQ0JqYkdGMVpHVWc3SnU1SU91aG5PcTN1T3lkdU91UGhDRHRrb0RycHJEcmk2UWc0b0NVSU9xemhPeWdsZXlkaENEcnNKVHF2cmpyb0tUcmlwUWc3SjJZNjQrRTdKbUFJT3V3cWUyV3BleWR0Q0Rxc0puc2xZUWc3SWlZN0pxcExnMEtJQ0FnSUNBZ1kyOXVjM1FnYzNSaGNuUk1iMmRwYmlBOUlDZ3BJRDArSUhzTkNpQWdJQ0FnSUNBZ1kyOXVjM1FnZEdocGMweHZaMmx1SUQwZ2MzQmhkMjRvSjJOc1lYVmtaU2NzSUZzbllYVjBhQ2NzSUNkc2IyZHBiaWNzSUNjdExXTnNZWFZrWldGcEoxMHNJSHNOQ2lBZ0lDQWdJQ0FnSUNCemFHVnNiRG9nZEhKMVpTd2daVzUyT2lCRFRFRlZSRVZmUlU1V0xDQnpkR1JwYnpvZ0oybG5ibTl5WlNjc0lIZHBibVJ2ZDNOSWFXUmxPaUIwY25WbExBMEtJQ0FnSUNBZ0lDQWdJR1JsZEdGamFHVmtPaUJ3Y205alpYTnpMbkJzWVhSbWIzSnRJQ0U5UFNBbmQybHVNekluTENBdkx5QnJhV3hzVEc5bmFXNVFjbTlqN0oyWUlPcTN1T3VqdVNCcmFXeHM3SnFwSUNocmFXeHNVSEp2WStxenZDRHJqNW5zbmJ3ZzdZeW83WVMwS1EwS0lDQWdJQ0FnSUNCOUtUc05DaUFnSUNBZ0lDQWdiRzluYVc1UWNtOWpJRDBnZEdocGMweHZaMmx1T3cwS0lDQWdJQ0FnSUNCc2IyZHBibGRwYm1SdmQwOXdaVzVsWkNBOUlIUnlkV1U3SUM4dklFTk1TZXF3Z0NEc2w2enJpcFFnNnJHMElPcTBnT3l3c08yVm9DRHNpSmdnN0plRzdKeTg2NHVJSU95WHRPdW1zQ0Rxc29Qc25MenJvWndnNjdPNDY0dWtJQ2pzbnF6dGdiVHJwcTNzbDVBZzdZU3c2Nis0NjRTUUlPdXdxZXluZ0NrTkNpQWdJQ0FnSUNBZ2RHaHBjMHh2WjJsdUxtOXVLQ2RsY25KdmNpY3NJQ2dwSUQwK0lIc2dhV1lnS0d4dloybHVVSEp2WXlBOVBUMGdkR2hwYzB4dloybHVLU0JzYjJkcGJsQnliMk1nUFNCdWRXeHNPeUI5S1RzTkNpQWdJQ0FnSUNBZ2RHaHBjMHh2WjJsdUxtOXVLQ2RqYkc5elpTY3NJQ2hqYjJSbEtTQTlQaUI3RFFvZ0lDQWdJQ0FnSUNBZ2FXWWdLR3h2WjJsdVVISnZZeUFoUFQwZ2RHaHBjMHh2WjJsdUtTQnlaWFIxY200N0RRb2dJQ0FnSUNBZ0lDQWdiRzluYVc1UWNtOWpJRDBnYm5Wc2JEc05DaUFnSUNBZ0lDQWdJQ0JwWmlBb2JHOW5hVzVRY205alZHbHRaWElwSUhzZ1kyeGxZWEpVYVcxbGIzVjBLR3h2WjJsdVVISnZZMVJwYldWeUtUc2diRzluYVc1UWNtOWpWR2x0WlhJZ1BTQnVkV3hzT3lCOURRb2dJQ0FnSUNBZ0lDQWdZV05qYjNWdWRFTmhZMmhsTG1GMElEMGdNRHNnTHk4ZzdJT0lJT3F6aE95Z2xleWR2Q0RzaUpnZzdKNkk3Snk4NjR1SUlPdUxwT3lkakNBdmFHVmhiSFJvSU91VmpDRHJpNlRzaTV3ZzdKMjk2cml3RFFvZ0lDQWdJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3U0ak91ZHZPeWFzT3lnZ0NEcm9aenF0N2pzbmJnZzdLQ0k3TENvSU95aWhldWpqQ0FvWTI5a1pTQW5JQ3NnWTI5a1pTQXJJQ2NwSnlrN0RRb2dJQ0FnSUNBZ0lDQWdMeThnN0lLczY1Nk03SjIwSU91aG5PcTN1T3lkdU8yVm9DRHNpNXpxc0lUcmo0UWc3SmVHN0oyMElPcXpwK3V3bE91aG5DRHNpNlR0aktqcm9ad2c2NEdkNjRLczY0dWtJRDBnWTJ4aGRXUmw2ckNBSU95WGh1cXhzT3VDbUNEc2k2VHRsb25zbmJRZzdKV0lJT3VRbkNEcXNvTXVEUW9nSUNBZ0lDQWdJQ0FnTHk4ZzdKMlI2NHUxN0oyQUlPeWR0T3V2dUNEcnM3VHJnNGpzbkx6cmk0Z2c3SU9CN1lPYzY2VzhJT3VMcE95TG5DRHNucXpzaEp3Z0wyaGxZV3gwYU91aG5DRHNsWXpycHJEcmk2UWdLTzJVak91ZnJPcTN1T3lkdU95ZHRDRHJqSURxdUxBZzdabVU2Nm0wN0oyRUlPeUxwTzJNcU91aG5DRHJzSlRxdnJ6cmk2UXBMZzBLSUNBZ0lDQWdJQ0FnSUdsbUlDaGpiMlJsSUNFOVBTQXdJQ1ltSUVSaGRHVXVibTkzS0NrZ0xTQnNiMmRwYmxOMFlYSjBaV1JCZENBOElEVXdNREFwSUhzTkNpQWdJQ0FnSUNBZ0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEcm9aenF0N2pzbmJqc25iUWc3S2FKN0l1Y0lPeUxwTzJNcU91aG5DRHJnWjNyZ3FnZzRvQ1VJRU5zWVhWa1pTQkRiMlJsSU95RXBPeTVtQ0RzZzRIdGc1enJwYndnNjR1azdJdWNJT3lna09xeWdPMlZxZXVMaU91THBDNG5LVHNOQ2lBZ0lDQWdJQ0FnSUNBZ0lHTm9aV05yUTJ4aGRXUmxRWFpoYVd4aFlteGxLQ2s3RFFvZ0lDQWdJQ0FnSUNBZ2ZRMEtJQ0FnSUNBZ0lDQjlLVHNOQ2lBZ0lDQWdJQ0FnTHk4Z016RHJ0b1FnNG9DVUlPeWR0Q0R0bElUcm9aenNoTGpzaXFUcXNJQWc3S085N0p5ODY2bTBJT3U0ak91ZHZPeWFzT3lnZ0NEc3ZaenJzTEhzbmJRZzZyQ0lJR3h2WTJGc2FHOXpkQ0R0ajZ6dGlyanJqNFFnNjR1cjdaaUFJQ2ZzbDdEcXNyRHNuWVFnNnJHdzY3YUE3WmFJN0lxMTY0dUk2NHVrSitxd2dDRHJuS3pyaTZRdURRb2dJQ0FnSUNBZ0lDOHZJT3lZaU95Z2hDQXhNT3UyaE95ZGdDRHNwNmZzbFlUc2hKd3NJT3Vobk9xM3VPeWR1TzJWbU91THBDRHNucURxdVpBZzY0dWs2Nlc0SU95ZHZPeWRoQ0R0bFpqcnFiUWc3WU90N0oyMElPdXN0TzJhcU9xd2dDRHJrSkRyaTZRb01qQXlOaTB3T0NEc2k2VHN1S0VnN0l1ZzZyT2dLUzROQ2lBZ0lDQWdJQ0FnYkc5bmFXNVFjbTlqVkdsdFpYSWdQU0J6WlhSVWFXMWxiM1YwS0NncElEMCtJSHNnWTI5dWMyOXNaUzVzYjJjb0oxdGljbWxrWjJWZElPdWhuT3EzdU95ZHVDQXpNT3UyaENEcXNyM3FzN3dnNG9DVUlPdU1nT3E0c0NEdGxJVHJvWnpzaExqc2lxUWc3S0NWNjZhc0xpY3BPeUJyYVd4c1RHOW5hVzVRY205aktDazdJSDBzSURFNE1EQXdNREFwT3cwS0lDQWdJQ0FnZlRzTkNpQWdJQ0FnSUM4dklDb3E2ck9FN0tDVklPeWdoTzJabUNBOUlPdWhuT3EzdU95VmhPeWJneUFySU91NGpPdWR2T3lhc095Z2dPeVhrQ0Ryb1p6cXQ3anNuYmdnN1ptVTY2bTBLaW9nS0RJd01qWXRNRGdzSUVKU1NVUkhSVjlXUFRNMkxDRHNncXpzbXFuc25wQWc2ckt3N0tDVktTNE5DaUFnSUNBZ0lDOHZJT3lLdWV5ZHVDRHRtWlRycWJUc25iUWc2NXlvNjRxVUlPcTN2T3V6dUNEc201RHNuYmpzbllBZ0l1dTRqT3Vkdk95YXNPeWdnT3lYa0NEc21Kc2c2ck9FN0tDVjdKMjBJT3Vobk9xM3VPeWR1T3VQdkNEc25vanJpNlFpNjRxVUlPcXlnK3lkdE91dmdPdWhuQ3dnN0tDRTdabVk3SjJZSU95eXF5RHJqNW5zbnBIc25ZQU5DaUFnSUNBZ0lDOHZJT3Vobk9xM3VPeWR1T3lkdENEc2xZVHJpNGpybmJ3Z0tpcnJvWnpxdDdqc2xZVHNtNE1xS3V5ZHRPeVd0T3lWdkNEcnA1N3JpNlF1SU9xM3VPdWVtT3lFbkNEc2w2enF1TERzaEp6cmlwUWc2NkdjNnJlNDdKMjQ3SjJFSU95TG5PeWVrZTJWbU95bmdDRHNsWXJyaXBUcmk2UTZEUW9nSUNBZ0lDQXZMeUFnSU9LUm9DQkRURWtnNjZHYzZyZTQ3SldFN0p1REtHTnNZWFZrWlNCaGRYUm9JR3h2WjI5MWRDa2c0b0NVSU95WW15RHNucERxc3Fuc3BwM3Jxb1hDdCt5RXVPeUZtQ0R0ajVEcXVMQU5DaUFnSUNBZ0lDOHZJQ0FnNHBHaElPdTRqT3Vkdk95YXNPeWdnQ0RzbTdrZzY2R2M2cmU0N0pXRTdKdURJT3lYdE9xNHNDRGlnSlFnWTJ4aGRXUmxMbUZwTDJ4dloyOTFkT3lkZ0NEcm9aenF0N2pzbFlUc200TWc3WnVFSUNvcTY2R2M2cmU0N0oyNElPMlpsT3VwdE95Y3ZPdWhuQ0Rzc0tuc3A0QXFLdTJWbk91THBDanRnNjBnTWVxd25Da05DaUFnSUNBZ0lDOHZJT3Vobk9xM3VPeVZoT3liZyt5ZHRDRHJnWjNyZ3BqcnFiUWc2ck9uNjdDVTY2R2NJRU5NU1NEcm9aenF0N2pzbmJqcXVZenNwNEFnN0oyMDdKYTA3SVNjSU95TG5PeWVrZTJWbk91THBDRGlnSlFnN0lTNDdJV1k3SjIwSU91NWhPeWJqT3luaENEcmtxVHJuYndnN0lxNTdKMjRJTzJabE91cHRPeWR0Q0RzbFlUcmk0anJuYndOQ2lBZ0lDQWdJQzh2SU91aG5PcTN1T3lkdUNEdG1aVHJxYlRzbmJRZzY0S1k3SmlvNjR1a0xpRHRnYlRycHEwZzdaV2NJT3V5aU95Y3ZPdWhuQ0FpNjZHYzZyZTQ3SldFN0p1RElPS0draURzZzRnZzZyT0U3S0NWSU91aG5PcTN1T3lkdUNMc25iUWc2NEdkNjRLYzY0dWtMZzBLSUNBZ0lDQWdhV1lnS0hOM2FYUmphRTF2WkdVcElIc05DaUFnSUNBZ0lDQWdhMmxzYkV4dloybHVVSEp2WXlncE95QXZMeURyaklEcXVMQWc3S1NSN0oyNElPeVlteURyb1p6cXQ3anNuYmdnN0tDSTdMQ282ckNBSU95ZWlPeWN2T3VwdENEc29KSHJpcFRyaTZRTkNpQWdJQ0FnSUNBZ1kyOXVjM1FnYkc4Z1BTQnpjR0YzYmlnblkyeGhkV1JsSnl3Z1d5ZGhkWFJvSnl3Z0oyeHZaMjkxZENkZExDQjdJSE5vWld4c09pQjBjblZsTENCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhkcGJtUnZkM05JYVdSbE9pQjBjblZsSUgwcE93MEtJQ0FnSUNBZ0lDQnNieTV2YmlnblpYSnliM0luTENBb0tTQTlQaUI3SUM4cUlHTnNZWFZrWlNEc2w0YnNuWXdnNjVPeElPS0FsQ0RzbFlUcm5wZ2c3SnU1SU91aG5PcTN1T3lWaE95YmcreWRnQ0RxdDdqcmpJRHJvWndnN0tlRTdaYUpJQ292SUgwcE93MEtJQ0FnSUNBZ0lDQXZMeUFxS3UyRHJleWRnQ0Ryc0pqcms1enNpNXdnTWVxd25Db3FJQ2d5TURJMkxUQTRMQ0JDVWtsRVIwVmZWajAwTUN3ZzdJS3M3SnFwN0o2UUlPeWFsT3ExckNrNklPeWJ1U0Ryb1p6cXQ3anNsWVRzbTRNZzdLTzg3SWFNNjZXOElPdVVzT3VobkNEc2w3VHJxYlFOQ2lBZ0lDQWdJQ0FnTHk4ZzY2R2M2cmU0N0oyNElPMlpsT3VwdE95ZHRDRHJrWkFnNnJDY0tPdWhuT3EzdU95VmhPeWJneURzc0tuc3A0QWc3Wm1VNjZtMElDc2dUMEYxZEdnZzdabVU2Nm0wS1NEcmxxRHNoSndnN0phMDY0cVFJT3lxdmV5WGtDRHJvWnpxdDdqc25ianRsYlRzbGJ3ZzdaV1k2NHFVN0tlQUlPeVZqQ0RzaUpnZzdKZUc2ck9nTEEwS0lDQWdJQ0FnSUNBdkx5RHNsNG5ybXJIdGxad2c3S3E5N0plUUlPdWhuT3EzdU95ZHVPMlZtT3VwdENEdGxJenJuNnpxdDdqc25ianNuWUFnN0pldzZyS3c2NUNZN0tlQUlPeVZpdXVLbE91THBDanNpNlRzdUtFZzdJdWc2ck9nSURMdG1vdzZJQ0xzbVp3ZzY1R1FJT3F3bk91Q21DRHJscUFpTENBaTY2R2M2cmU0N0oyNDdaYUk2NHFVNjQyd0lPeVpuQ0lwTGcwS0lDQWdJQ0FnSUNBdkx5RHF0N2pybnBqc2hKd2c3SnU1SU91aG5PcTN1T3lWaE95YmcreWRnQ0RzbDdUc3A0QWc3SldLNjRxVTY0dWtJT0tBbENCRFRFa2c2NkdjNnJlNDdKV0U3SnVENjZlTUlPMlZtT3F6b0NEcm9aenF0N2pzbmJnZzdMQzlJTzJWbU91Q21PdW5qQ0RybllUc21yVHJpNlF1RFFvZ0lDQWdJQ0FnSUM4dklDQWd3cmNnNjdpTTY1Mjg3SnF3N0tDQTZyQ0FJT3Vobk9xM3VPeVZoT3liZyt1UHZDRHNub2pzbkx6cnFiUWc0b2FTSU91aG5PcTN1T3lkdUNEdG1aVHJxYlRzbmJRZzY3Q1U2NkdjSU91Q21PeVlxT3VMcEEwS0lDQWdJQ0FnSUNBdkx5QWdJTUszSU91NGpPdWR2T3lhc095Z2dPeVhrQ0RzaExqc2haanNuYlFnNjRLbzdKV0VJT3llaU95Y3ZPdXB0Q0RpaHBJZzdJcTU3SjI0SU8yWmxPdXB0T3lkdENEcmdwanNtS2pyaTZRdUlPcTN1Q0R0bVpUcnFiUWc3WldZNjR1b0lGdnFzNFRzb0pVZzdLQ0U3Wm1ZWGV5Y3ZPdWhuQ0RxczRUc29KWHNuWVFnNnJPZzY2VzQ2NHVrRFFvZ0lDQWdJQ0FnSUM4dklDQWdJQ0FvN0lxNTdKMjRJTzJabE91cHRPeWRoQ0Rxc2JUcmhJanJtN0Ryb0tUcnFiUWc2N2lNNjUyODdKcXc3S0NBN0plUTdJU2NJR05zWVhWa1pTRHJvWnpxdDdqc2xZVHNtNFBzbllRZzY2aTg3S0NBSU8yVnRPeVZ2Q0R0bFpqcmlwVHJqYkFzSU9xM3VPcXh0Q0R0ZzYzc25iUWc3WldZNjRLWUlPdU5sQ0R0bFlUc21wVHRsWmpyaTZRcERRb2dJQ0FnSUNBZ0lDOHZJT3Vobk9xM3VPeWR1T3lkZ0NBcUt1dWhuT3EzdU95VmhPeWJnK3lkdENEcmdaM3JncHdnNjVLa0tpb2c3SXVjN0o2UjdaV2M2NHVrSU9LQWxDRHJxTHpzb0lBZzY1MkU3SnF3NjZtMElPdWhuT3EzdU95VmhPeWJnK3lkdENEc2c0Z2c3SjZRNnJLcDdLYWQ2NnFGN0oyRUlPeW5nT3lhdUNEc2lKZ2c3SjZJNjR1a0xnMEtJQ0FnSUNBZ0lDQnNieTV2YmlnblkyeHZjMlVuTENBb1kyOWtaU2tnUFQ0Z2V3MEtJQ0FnSUNBZ0lDQWdJR3RwYkd4UWNtOWpLQ2ZxczRUc29KWHNuWVFnNjdDVTZyNjQ2NkNrNnJPZ0lPdWhuT3EzdU95VmhPeWJnKzJWdE95RW5DRHNtcFRzc3Ezc25ZUWc3S1NSNjR1bzdaYUk3SmEwN0pxVUxpY3BPeUF2THlEc25aanJqNFRzb0lFZzdLS0Y2Nk9NSUNqc25wRHJqNWtnN0o2czdJdWM2NCtFSU91d3FleW5nQ2tOQ2lBZ0lDQWdJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QXZMeURyaTZUc25Zd2c3S0d3N1pxTTdKZVE3SVNjSUNmcXM0VHNvSlVnN0plRzdKMk1KK3ljdk91aG5DRHNuYjN0bm9qcXNvd05DaUFnSUNBZ0lDQWdJQ0JqYkdGMVpHVlRkR0YwZFhNZ1BTQnVkV3hzT3lBdkx5RHNnNEh0ZzV3ZzdKNnM3WXlRN0tDVkRRb2dJQ0FnSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU9xemhPeWdsU0Rzb0lUdG1aZ2c0b0NVSUVOTVNTRHJvWnpxdDdqc2xZVHNtNE1nS0dOdlpHVWdKeUFySUdOdlpHVWdLeUFuS1NEaWhwSWc2NkdjNnJlNDdKMjRJT3l3dmV5ZGhDRHNsNzNyaTRqcmk2UXVKeWs3RFFvZ0lDQWdJQ0FnSUNBZ2FXWWdLQ0ZzYjJkcGJsQnliMk1wSUhOMFlYSjBURzluYVc0b0tUc05DaUFnSUNBZ0lDQWdmU2s3RFFvZ0lDQWdJQ0FnSUd4dloybHVVM1JoY25SbFpFRjBJRDBnUkdGMFpTNXViM2NvS1RzTkNpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYjJzNklIUnlkV1VzSUcxdlpHVTZJQ2RpY205M2MyVnlMWE4zYVhSamFDY2dmU2s3RFFvZ0lDQWdJQ0I5RFFvZ0lDQWdJQ0F2THlEcnA0enJvNHdnN0o2czY2R2M2cmU0N0oyNElPS0FsQ0Rxc0puc25ZQWc2ck9FN0tDVjdKMjA2NTI4SU95RXVPeUZtT3lkaENEc3A0RHNtckRzcDRBZzdKV0s2ck9nSU9xM3VPdU1nT3VobkNEc2w3RHJpNlFvNjdtZzY2VzA2NHVrS1EwS0lDQWdJQ0FnYzNSaGNuUk1iMmRwYmlncE93MEtJQ0FnSUNBZ0x5OGc2NEtoN0oyQUlPeWVoZXllcGVxMmpPeWRoQ0Ryckx6cXM2QWc3SjZJNjRxVUlPdU1nT3E0c0NEc2hManNoWmpzbllBZzY3S0U2NmF3NjR1a0lPS0FsQ0RzbnF6cm9aenF0N2pzbmJnZzdadUVJT3VMcE95ZGpDRHNtcFRzc3Ezc25iUWc3SU9JSU95RXVPeUZtQ2pzZzRnZzdKNkY3SjZsNnJhTUtleWN2T3VobkNEc2k1enNucEh0bFpqcXNvd3VEUW9nSUNBZ0lDQXZMeURzblpqcmo0VHNvSUVnN0tLRjY2T01LSEpsWVhOdmJpRHNwNERzb0pVcElPS0FsQ0JUUlZOVFNVOU9YMFJKUlVUcm9ad2c2NEdkNjRLMDY2bTBJT3lla091UG1TRHNucXpzaTV6cmo0VHFzSUFnN0ppYklPcXpoT3lnbFNEc2hManNoWmpzbllRZzY1Q1k3SUswNjZDa0RRb2dJQ0FnSUNBdkx5RHNucXpyb1p6cXQ3anNuYmdnNjVLazdKZVE2NCtFSUUxQldGOVVWVkpPVStxNWpPeW5nQ0RzbUpzZzZyT0U3S0NWN0p5ODY2R2NJT3l5bU91bXJPdVFtT3VLbENEcnNvVHF0N2pxc0lBZzY1Q2M2NHVrSUNneU1ESTJMVEEzSU91bXJPdTNzT3lYa095RW5DRHRtWlhzbmJncERRb2dJQ0FnSUNCcmFXeHNVSEp2WXlnbjY2R2M2cmU0N0oyNDdKMkVJT3luaE8yV2llMlZtT3VLbENEc3BKSHNuYlRybmJ3ZzdKcVU3TEt0N0oyRUlPeWtrZXVMcU8yV2lPeVd0T3lhbENEaWdKUWc2NkdjNnJlNDdKMjRJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0bktUc05DaUFnSUNBZ0lHRmpZMjkxYm5SRFlXTm9aUzVoZENBOUlEQTdEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnNjdpTTY1Mjg3SnF3N0tDQUlPdWhuT3EzdU95ZHVDRHNpNXpzbnBFbklDc2dLSE4zYVhSamFFMXZaR1VnUHlBbklDanFzNFRzb0pVZzdLQ0U3Wm1ZSU9LQWxDRHNpcm5zbmJnZzdabVU2Nm0wN0oyMElPdWNxT3VwdENEcXQ3Z2c3Wm1VNjZtMElPMlZtT3VMcUNCYjZyT0U3S0NWSU95Z2hPMlptRjNzbkx6cm9ad2c2NHVrNjZXNElPcXpoT3lnbGV5ZGhDRHFzNkRycGJ3ZzdJaVlJT3llaU95V3RPeWFsQ2tuSURvZ0p5Y3BJQ3NnSnlEaWdKUWc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeWVrT3VQbVNEc2w3RHFzckRya0tucmk0anJpNlF1SnlrN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnYlc5a1pUb2djM2RwZEdOb1RXOWtaU0EvSUNkaWNtOTNjMlZ5TFhOM2FYUmphQ2NnT2lBblluSnZkM05sY2ljZ2ZTazdEUW9nSUNBZ2ZTQmpZWFJqYUNBb1pTa2dldzBLSUNBZ0lDQWdjbVYwZFhKdUlHcHpiMjRvY21WekxDQTFNREFzSUhzZ1pYSnliM0k2SUNmcm9aenF0N2pzbmJnZzdMQzk3SjJFSU91cXV5RHNsN1RzbDRqc2xyVHNtcFE2SUNjZ0t5QmxMbTFsYzNOaFoyVWdmU2s3RFFvZ0lDQWdmUTBLSUNCOURRb2dJQzh2SUNqdGhMRHJyN2pyaEpBZzdZKzA2N0N4SU9xMXJPMlloT3UyZ0NEaWdKUWc2N2lNNjUyODdKcXc3S0NBSU95ZWtPdVBtU0RzbVlUcm80enFzSUFnN0pXSUlPdVFtT3VLbENEdG1aanFzcjBnN0tDRTdKcXBLUTBLSUNCbWRXNWpkR2x2YmlCdmNHVnVURzluYVc1VVpYSnRhVzVoYkNncElIc05DaUFnSUNCN0RRb2dJQ0FnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXcwS0lDQWdJQ0FnSUNBdkx5QnpkR0Z5ZE9xd2dDRHNnNGdnN0wyWTdJYVVJT3l3dmV5ZGhDRHJwNHpyazZEcmk2UWdLT3VMcE91bXJPeWRtQ0RzaUtqc25ZQWc3TDJZN0lhVTZyTzhJT3VzdE9xMGdPMlZtT3F5akNEc2dxenNtcW5zbnBEc2w1RHFzb3dnNjdPMDdKNkVLUzROQ2lBZ0lDQWdJQ0FnTHk4ZzdKMjA3SmEwN0lTY0lGQnZkMlZ5VTJobGJHd29MbkJ6TVNuc25iUWdOZXkwaUNEcmtxUWc2cmU0SU95d3ZleVhrQ0RzbDVUdGhMRHJwYndnNjdPMDY0SzBJREhyc29nbzZyV3M2NCtGSU9xemhPeWdsU25zbllRZzdKNlE2NCtaSU95RW9PMkRuZTJWbU9xem9Dd05DaUFnSUNBZ0lDQWdMeThnN0xDOTdKMkVJT3kxbk95R2pPMlpsTzJWdENEc2dxenNtcW5zbnBBZzY0aUk3SmVVSU91NGpPdWR2T3lhc095Z2dDRHJvWnpxdDdqc25ianJwNHdnNjRLbzZyS01JTzJWbk91THBDNGc3TEM5N0oyRUlPdXF1eURzc0w3c25MenJxYlFnN0pXRTY2eTA2cktENjQrRUlPeVZpQ0R0bFp6cmk2UU5DaUFnSUNBZ0lDQWdMeThnS091THBPdWx1Q0Rzc0wwZzdKaWs3SjZGNjZDbElPdXdxZXluZ0NEaWdKUWc2cmU0SU9xeXZleWFzQ0RycVpUcmliVHFzSUFnNjdPMDdKMjA2NHFVSU95eGhPdWhuQ0RyZ3FqcXM2QWc3SUtzN0pxcDdKNlE2ckNBSU95WGxPMkVzQ0R0bFp3ZzY3S0lJT3VJaE91bHRPdXB0Q0Rya0tncExnMEtJQ0FnSUNBZ0lDQXZMeURzbzd6c25aZzZJR05zWVhWa1plcXdnQ0Rzdlpqc2hwUWc3S0NjNjZxcDdKMkVJT3V3bE9xK3VPdXB0Q0JCY0hCQlkzUnBkbUYwWlM5R2FXNWtWMmx1Wkc5MzZyQ0FJT3VxdXlEc3NMN3NuWVFnN0lpWUlPeWVpT3lkakNEaWdKUWc3SnlJNjQrRTdKcXdJT3lMcE9xNHNPeVhrT3lFbkNEdG1aWHNuYmdnN1pXRTdKcVVMZzBLSUNBZ0lDQWdJQ0JqYjI1emRDQndjekVnUFNCd1lYUm9MbXB2YVc0b2IzTXVkRzF3WkdseUtDa3NJQ2RqYkdGMVpHVXRZbkpwWkdkbExXeHZaMmx1TG5Cek1TY3BPdzBLSUNBZ0lDQWdJQ0JtY3k1M2NtbDBaVVpwYkdWVGVXNWpLSEJ6TVN3Z1d3MEtJQ0FnSUNBZ0lDQWdJQ2RUZEdGeWRDMVRiR1ZsY0NBdFUyVmpiMjVrY3lBMUp5d05DaUFnSUNBZ0lDQWdJQ0FuSkhkeklEMGdUbVYzTFU5aWFtVmpkQ0F0UTI5dFQySnFaV04wSUZkVFkzSnBjSFF1VTJobGJHd25MQTBLSUNBZ0lDQWdJQ0FnSUNKcFppQW9KSGR6TGtGd2NFRmpkR2wyWVhSbEtDZGpiR0YxWkdVdGJHOW5hVzRuS1NrZ2V5SXNEUW9nSUNBZ0lDQWdJQ0FnSWlBZ0pIZHpMbE5sYm1STFpYbHpLQ2QrSnlraUxBMEtJQ0FnSUNBZ0lDQWdJQ2NnSUZOMFlYSjBMVk5zWldWd0lDMVRaV052Ym1SeklESW5MQTBLSUNBZ0lDQWdJQ0FnSUNJZ0lFRmtaQzFVZVhCbElDMU9ZVzFsYzNCaFkyVWdWU0F0VG1GdFpTQlhJQzFOWlcxaVpYSkVaV1pwYm1sMGFXOXVJQ2RiUkd4c1NXMXdiM0owS0Z3aWRYTmxjak15TG1Sc2JGd2lLVjBnY0hWaWJHbGpJSE4wWVhScFl5QmxlSFJsY200Z1UzbHpkR1Z0TGtsdWRGQjBjaUJHYVc1a1YybHVaRzkzS0hOMGNtbHVaeUJqTENCemRISnBibWNnZENrN0lGdEViR3hKYlhCdmNuUW9YQ0oxYzJWeU16SXVaR3hzWENJcFhTQndkV0pzYVdNZ2MzUmhkR2xqSUdWNGRHVnliaUJpYjI5c0lGTm9iM2RYYVc1a2IzY29VM2x6ZEdWdExrbHVkRkIwY2lCb0xDQnBiblFnYmlrN0p5SXNEUW9nSUNBZ0lDQWdJQ0FnSWlBZ0pHZ2dQU0JiVlM1WFhUbzZSbWx1WkZkcGJtUnZkeWhiVG5Wc2JGTjBjbWx1WjEwNk9sWmhiSFZsTENBblkyeGhkV1JsTFd4dloybHVKeWtpTEEwS0lDQWdJQ0FnSUNBZ0lDY2dJR2xtSUNna2FDQXRibVVnVzFONWMzUmxiUzVKYm5SUWRISmRPanBhWlhKdktTQjdJRnQyYjJsa1hWdFZMbGRkT2pwVGFHOTNWMmx1Wkc5M0tDUm9MQ0EyS1NCOUp5d2dMeThnTmlBOUlGTlhYMDFKVGtsTlNWcEZEUW9nSUNBZ0lDQWdJQ0FnSjMwbkxBMEtJQ0FnSUNBZ0lDQmRMbXB2YVc0b0oxeHlYRzRuS1NBcklDZGNjbHh1SnlrN0RRb2dJQ0FnSUNBZ0lHTnZibk4wSUdKaGRDQTlJSEJoZEdndWFtOXBiaWh2Y3k1MGJYQmthWElvS1N3Z0oyTnNZWFZrWlMxaWNtbGtaMlV0Ykc5bmFXNHVZbUYwSnlrN0RRb2dJQ0FnSUNBZ0lHWnpMbmR5YVhSbFJtbHNaVk41Ym1Nb1ltRjBMQ0FuUUdWamFHOGdiMlptWEhKY2JpY2dLdzBLSUNBZ0lDQWdJQ0FnSUNkemRHRnlkQ0FpWTJ4aGRXUmxMV3h2WjJsdUlpQmpiV1FnTDJzZ1kyeGhkV1JsSUM5c2IyZHBibHh5WEc0bklDc05DaUFnSUNBZ0lDQWdJQ0FuY0c5M1pYSnphR1ZzYkNBdFRtOVFjbTltYVd4bElDMUZlR1ZqZFhScGIyNVFiMnhwWTNrZ1FubHdZWE56SUMxR2FXeGxJQ0luSUNzZ2NITXhJQ3NnSnlKY2NseHVKeWs3RFFvZ0lDQWdJQ0FnSUhOd1lYZHVLQ2RqYldRbkxDQmJKeTlqSnl3Z1ltRjBYU3dnZXlCbGJuWTZJRU5NUVZWRVJWOUZUbFlzSUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VnZlNrN0RRb2dJQ0FnSUNCOUlHVnNjMlVnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2RrWVhKM2FXNG5LU0I3RFFvZ0lDQWdJQ0FnSUM4dklIQjBlU2hsZUhCbFkzUXA2NkdjSU91enRPdUN1Q0R0Z3FUc2w1QWc3WUcwNjZHYzY1T2NJRlJWU2Vxd2dDRHJyTFRyc0pqc25aSHNuYmdnNnJLRDdKMjBJT3lMcE95NG9TRHRtWlhzbmJqcmtLZ29NakF5Tmkwd055d2c3SjI4NjdDWUlGeHl3cmRyYVhSMGVTRHN2WlRyazV3ZzY2cW82NUdRS1NEaWdKUU5DaUFnSUNBZ0lDQWdMeThnN0p5ZzdKMjg3WldjSU95ZWtPdVBtZTJabENEcXNyM3JvWnpyaXBRZ1UzbHpkR1Z0SUVWMlpXNTBjK3lkbUNEc3A0VHNwNXdnN1lLa0lPeWVoZXVncFM0ZzdLQ1I2cmU4N0lTeElPcTJqTzJWbk95ZHRDRHNub2pzbkx6cnFiUWdOdXkwaUNEcmtxUWc3SmVVN1lTdzZyQ0FJT3lla091UG1TRHNub1hyb0tYcmo3d05DaUFnSUNBZ0lDQWdMeThnTWV1eWlDanF0YXpyajRVZzZyT0U3S0NWS2V5ZHRDRHNoS0R0ZzUzcmtKanFzNkFzSU9xMmpPMlZuT3lkdENEc2w0YnNuTHpycWJRZ2EyVjVjM1J5YjJ0bElPeWtoT3VuakNEc29iRHNtcW50bm9nZzdJdWs3WXlvN1pXMElPeUNyT3lhcWV5ZWtPcXdnQ0RzbDVUdGhMQWc3WldjSU91eWlDRHJpSVRycGJUcnFiUWc2NUNjNjR1a0tHWmhhV3d0YzI5bWRDa3VEUW9nSUNBZ0lDQWdJQzh2SU95WGxPMkVzQ0RzcDRIc29JVHNsNUFnVkdWeWJXbHVZV3pzbllRZzY0dWs3SXVjSU95Vm51eWN2T3VobkNEcXNJRHNvTGpzbVlBZzY0dWs2Nlc0SU95VnNleVhrQ0R0Z3FUcXNJQWc2NU9rN0phMDZyQ0E2NHFVSU9xeWcreWRoQ0RycDRucmlwVHJpNlF1RFFvZ0lDQWdJQ0FnSUhOd1lYZHVLQ2R2YzJGelkzSnBjSFFuTENCYkRRb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0ozUmxiR3dnWVhCd2JHbGpZWFJwYjI0Z0lsUmxjbTFwYm1Gc0lpQjBieUJrYnlCelkzSnBjSFFnSW1Oc1lYVmtaU0F2Ykc5bmFXNGlKeXdOQ2lBZ0lDQWdJQ0FnSUNBbkxXVW5MQ0FuZEdWc2JDQmhjSEJzYVdOaGRHbHZiaUFpVkdWeWJXbHVZV3dpSUhSdklHRmpkR2wyWVhSbEp5d05DaUFnSUNBZ0lDQWdJQ0FuTFdVbkxDQW5aR1ZzWVhrZ05pY3NEUW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbFJsY20xcGJtRnNJaUIwYnlCaFkzUnBkbUYwWlNjc0RRb2dJQ0FnSUNBZ0lDQWdKeTFsSnl3Z0oyUmxiR0Y1SURBdU15Y3NEUW9nSUNBZ0lDQWdJQ0FnSnkxbEp5d2dKM1JsYkd3Z1lYQndiR2xqWVhScGIyNGdJbE41YzNSbGJTQkZkbVZ1ZEhNaUlIUnZJR3RsZVhOMGNtOXJaU0J5WlhSMWNtNG5MQTBLSUNBZ0lDQWdJQ0FnSUM4dklPeVhsTzJFc09xd2dDRHNpNlRzb0p6cm9ad2c2NU9rN0phMDZyQ0VJT3F5dmV5YXNPeVhrT3VuakNEc2w2enF1TEFnNjQrRTY0dXNLT3Eyak8yVm5DRHNsNGJzbkx6cnFiUWc3SnlFN0plUTdJU2NJT3lra2V1THFDa2c0b0NVSU8yRXNPdXZ1T3VFa095ZGhDRHN1WmpzbTR3ZzY3aU02NTI4N0pxdzdLQ0E2NmVNSU91Q3FPcTR0T3VMcEEwS0lDQWdJQ0FnSUNBZ0lDY3RaU2NzSUNka1pXeGhlU0F4TGpVbkxBMEtJQ0FnSUNBZ0lDQWdJQ2N0WlNjc0lDZDBaV3hzSUdGd2NHeHBZMkYwYVc5dUlDSlVaWEp0YVc1aGJDSWdkRzhnYzJWMElHMXBibWxoZEhWeWFYcGxaQ0J2WmlCbWNtOXVkQ0IzYVc1a2IzY2dkRzhnZEhKMVpTY3NEUW9nSUNBZ0lDQWdJRjBzSUhzZ2MzUmthVzg2SUNkcFoyNXZjbVVuSUgwcE93MEtJQ0FnSUNBZ2ZTQmxiSE5sSUhzTkNpQWdJQ0FnSUNBZ2NtVjBkWEp1SUdaaGJITmxPeUF2THlEc3A0RHNtNUFnN0pXSUlPMlZtT3VLbENCUFV3MEtJQ0FnSUNBZ2ZRMEtJQ0FnSUNBZ2NtVjBkWEp1SUhSeWRXVTdEUW9nSUNBZ2ZRMEtJQ0I5RFFvZ0lDOHZJTzJCdE91aG5PdVRuQ0RxczRUc29KVWc2NkdjNnJlNDdKV0U3SnVESU9LQWxDRHRsSXpybjZ6cXQ3anNuYmdnN1ptSTdKMllJRnZyb1p6cXQ3anNsWVRzbTROZElPdXloTzJLdk95ZHRDRHRtTGpzdHB3dUlHTnNZWFZrWlNCaGRYUm9JR3h2WjI5MWRPeWN2T3VobkNCRFRFa2c2NkdjNnJlNDdKMjQ3SjJFSU8yVnRPeWduTzJWbk91THBDNE5DaUFnTHk4Z0tPeWR0Q0JRUSt5ZG1DRHNvSURzbnFYcmtKd2c3SjZRNnJLcDdLYWQ2NnFGN0oyRUlPeW5nT3lhdE91THBDRGlnSlFnNjR1azdJdWNJT3lUc091Z3BPdXB0Q0RzbnF6cm9aenF0N2pzbmJnZzdaV0U3SnFVTGlrZzY2R2M2cmU0N0pXRTdKdURJTzJiaE95WGxDRHNoTGpzaFpqQ3QrcXpoT3lnbGV5NmtPeUxuT3VsdkNEc29KWHJwcXp0bFp6cmk2UXVEUW9nSUdsbUlDaHlaWEV1YldWMGFHOWtJRDA5UFNBblVFOVRWQ2NnSmlZZ2NtVnhMblZ5YkNBOVBUMGdKeTlqYkdGMVpHVXRiRzluYjNWMEp5a2dldzBLSUNBZ0lHTnZibk4wSUd4dklEMGdjM0JoZDI0b0oyTnNZWFZrWlNjc0lGc25ZWFYwYUNjc0lDZHNiMmR2ZFhRblhTd2dleUJ6YUdWc2JEb2dkSEoxWlN3Z1pXNTJPaUJEVEVGVlJFVmZSVTVXTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc05DaUFnSUNCc1pYUWdaWEp5SUQwZ0p5YzdEUW9nSUNBZ2JHOHVjM1JrWlhKeUxtOXVLQ2RrWVhSaEp5d2dLR1FwSUQwK0lIc2daWEp5SUNzOUlHUXVkRzlUZEhKcGJtY29LVHNnZlNrN0RRb2dJQ0FnYkc4dWIyNG9KMlZ5Y205eUp5d2dLR1VwSUQwK0lIc2dhbk52YmloeVpYTXNJRFV3TUN3Z2V5QnZhem9nWm1Gc2MyVXNJR1Z5Y205eU9pQW42NkdjNnJlNDdKV0U3SnVESU95THBPMldpU0RzaTZUdGpLZzZJQ2NnS3lCbExtMWxjM05oWjJVZ2ZTazdJSDBwT3cwS0lDQWdJR3h2TG05dUtDZGpiRzl6WlNjc0lDaGpiMlJsS1NBOVBpQjdEUW9nSUNBZ0lDQnJhV3hzVUhKdll5Z242NkdjNnJlNDdKV0U3SnVEN1pXMDdJU2NJT3lhbE95eXJleWRoQ0RzcEpIcmk2anRsb2pzbHJUc21wUXVKeWs3SUM4dklPeWRtT3VQaE95Z2dTRHNvb1hybzR3ZzRvQ1VJT3lla091UG1TRHNucXpzaTV6cmo0VHFzSUFnN0lTNDdJV1k3SjJFSU91UW1PeUN0T3Vtck91cHRDRHNsWWdnNjVDb0RRb2dJQ0FnSUNCaFkyTnZkVzUwUTJGamFHVXVZWFFnUFNBd095QWdJQ0FnSUNBZ0x5OGc2NHVrN0oyTUlDOWhZMk52ZFc1MHdyY3ZhR1ZoYkhSbzdKZVE3SVNjSU9xemhPeWdsZXlkaENEc2c0anJvWndvUGV5WGh1eWRqT3ljdk91aG5Da2c3SjI5NnJLTURRb2dJQ0FnSUNCamJHRjFaR1ZUZEdGMGRYTWdQU0J1ZFd4c095QWdJQ0FnSUNBZ0x5OGc3SU9CN1lPY0lPeWVyTzJNa095Z2xTanJpNlRzbll3ZzdZUzA3SmVRN0lTY0lPdXZ1T3Vobk9xM3VPeWR1Q0Rxc0pEc3A0QXBEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1lHMDY2R2M2NU9jSU91aG5PcTN1T3lWaE95Ymd5QW9ZMjlrWlNBbklDc2dZMjlrWlNBcklDY3BKeWs3RFFvZ0lDQWdJQ0JwWmlBb2NtVnpMbWhsWVdSbGNuTlRaVzUwS1NCeVpYUjFjbTQ3SUM4dklHVnljbTl5SU8yVnVPdVRwT3Vmck9xd2dDRHNuYlRycjdnZzdKMlI2NHUxN1phSTdKeTg2Nm0wSU95a2tldXp0U0Ryc0tuc3A0QU5DaUFnSUNBZ0lHbG1JQ2hqYjJSbElEMDlQU0F3S1NCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93MEtJQ0FnSUNBZ1pXeHpaU0JxYzI5dUtISmxjeXdnTlRBd0xDQjdJRzlyT2lCbVlXeHpaU3dnWlhKeWIzSTZJQ2hsY25JdWRISnBiU2dwTG5Oc2FXTmxLREFzSURFMU1Da3BJSHg4SUNnbjdLS0Y2Nk9NSU95OWxPdVRuQ0FuSUNzZ1kyOWtaU2tnZlNrN0RRb2dJQ0FnZlNrN0RRb2dJQ0FnY21WMGRYSnVPdzBLSUNCOURRb2dJQzh2SU95ZWtPcTRzQ0Rzb29Ycm80d2c0b0NVSU8yVWpPdWZyT3EzdU95ZHVDQlRWRTlRWDBKU1NVUkhSUy90bFpqdGlyanJ1WVR0aXJqcXNJQWc3Wmk0N0xhYzdaV2M2NHVrSUNqcm9aenN1NnpzbDVEc2hKenJwNHdnN0tDUjZyZThJT3F3Z091S3BlMlZtT3VMaUNEc2xZanNvSVFwRFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5emFIVjBaRzkzYmljcElIc05DaUFnSUNCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93MEtJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHNvb1hybzR3ZzdKcVU3TEt0SU91d20reWRqQ0RpZ0pRZzY0dWs2NmFzNjZXOElPdUJsZXVMaU91THBDNG5LVHNOQ2lBZ0lDQnphSFYwZEdsdVowUnZkMjRnUFNCMGNuVmxPdzBLSUNBZ0lHdHBiR3hRY205aktDazdEUW9nSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCb1lYSmtSWGhwZENnd0tTd2dNakF3S1RzTkNpQWdJQ0J5WlhSMWNtNDdEUW9nSUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzSmxZMjl0YldWdVpDY3BJSHNOQ2lBZ0lDQmpiMjV6ZENCN0lIUmxlSFFzSUcxdlpHVnNMQ0J5YjJ4bElIMGdQU0JoZDJGcGRDQnlaV0ZrUW05a2VTaHlaWEVwT3cwS0lDQWdJR2xtSUNnaGRHVjRkQ0I4ZkNBaFUzUnlhVzVuS0hSbGVIUXBMblJ5YVcwb0tTa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmc3RwVHNzcHpyc0p2c25ZUWc2Nnk0NnJXczZyQ0FJT3U1aE95V3RDRHNub2pzaXJYcmk0anJpNlF1SnlCOUtUc05DaUFnSUNCamIyNXpkQ0J6ZEdGeWRHVmtJRDBnUkdGMFpTNXViM2NvS1RzTkNpQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdMYVU3TEtjSU95YWxPeXlyVG9uTENCVGRISnBibWNvZEdWNGRDa3VjMnhwWTJVb01Dd2dOVEFwTG5KbGNHeGhZMlVvTDF4dUwyY3NJQ2NnSnlrZ0t5QW40b0NtSnl3Z2NtOXNaU0EvSUNkYkp5QXJJSEp2YkdVZ0t5QW5YU2NnT2lBbkp5d2diVzlrWld3Z1B5QW5LT3VxcU91TnVEb2dKeUFySUcxdlpHVnNJQ3NnSnlrbklEb2dKeWNwT3cwS0lDQWdJSFJ5ZVNCN0RRb2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclEyeGhkV1JsS0ZOMGNtbHVaeWgwWlhoMEtTNTBjbWx0S0Nrc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVk4xWjJkbGMzUnBiMjV6TENCbWIzSnRZWFJFWlhOak9pQW5XM3NpZEdWNGRDSTZJQ0xyckxqcXRhd2lMQ0FpY21WaGMyOXVJam9nSXV5ZHRPeWNvQ0o5TENBdUxpNWRKeUI5TENCeWIyeGxLVHNOQ2lBZ0lDQWdJR052Ym5OMElITjFaMmRsYzNScGIyNXpJRDBnY2k1d1lYSnpaV1FnZkh3Z1cxMDdEUW9nSUNBZ0lDQmpiMjV6ZENCelpXTWdQU0FvS0VSaGRHVXVibTkzS0NrZ0xTQnpkR0Z5ZEdWa0tTQXZJREV3TURBcExuUnZSbWw0WldRb01TazdEUW9nSUNBZ0lDQnBaaUFvSVhOMVoyZGxjM1JwYjI1ekxteGxibWQwYUNrZ2V3MEtJQ0FnSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnZXlCbGNuSnZjam9nSisyQnRPdWhuT3VUbkNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPdzBLSUNBZ0lDQWdmUTBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU95Z25PeVZpQ0FuSUNzZ2MzVm5aMlZ6ZEdsdmJuTXViR1Z1WjNSb0lDc2dKK3F3bkNBb0p5QXJJSE5sWXlBcklDZHpLU2NwT3cwS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdEUW9nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRE13S1RzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ6ZFdkblpYTjBhVzl1Y3l3Z1pXNW5hVzVsT2lBblkyeGhkV1JsSnlCOUtUc05DaUFnSUNCOUlHTmhkR05vSUNobEtTQjdEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN0l1azdZeW9PaWNzSUdVdWJXVnpjMkZuWlNrN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dabkpwWlc1a2JIbEZjbkp2Y2lobExDQW43WUcwNjZHYzY1T2NJTzJZdU95Mm5DRHNpNlR0aktnNklDY3BLVHNOQ2lBZ0lDQjlEUW9nSUgwTkNpQWdMeThnN1pTRTY2Q0k3SjZFNjdPRUlPeTJsT3l5bkNEaWdKUWc3WldjSU8yWmxPdXB0T3lkaENEdGxaanNuSVFnN1pTRTY2Q0k3SjZFS095WWdleVhyU2tnNjR1bzdKeUU2NkdjSU91Q21PdUlvQ0Ryc0p2cXM2QXNJT3lZZ2V5WHJldW5pT3VMcENEcmxMRHJvWndnNjR5QTdKV0k3SjJFSU91Q3VPdUxwQzROQ2lBZ0x5OGc3SmlCN0pldElPeUltT3Vuak8yQnZDRHNtcFRzc3Ezc25ZUWc3S3E4NnJDYzdLZUFJT3lWaXV1S2xDRHFzb1BzbmJRZzdaVzE3SXVzSUNqcmlwRHJvS1RzcDREcXM2QWc3SUtzN0pxcDY1K0o2NCtFSU9xM3VPdW5qTzJCdkNEcmdwanFzSVRyaTZRcExnMEtJQ0JwWmlBb2NtVnhMbTFsZEdodlpDQTlQVDBnSjFCUFUxUW5JQ1ltSUhKbGNTNTFjbXdnUFQwOUlDY3ZjbVZqYjIxdFpXNWtMV2R5YjNWd2N5Y3BJSHNOQ2lBZ0lDQmpiMjV6ZENCN0lHZHliM1Z3Y3l3Z2JXOWtaV3dzSUcxdmNtVWdmU0E5SUdGM1lXbDBJSEpsWVdSQ2IyUjVLSEpsY1NrN0RRb2dJQ0FnWTI5dWMzUWdiR2x6ZENBOUlFRnljbUY1TG1selFYSnlZWGtvWjNKdmRYQnpLUTBLSUNBZ0lDQWdQeUJuY205MWNITU5DaUFnSUNBZ0lDQWdJQ0F1YldGd0tDaG5LU0E5UGlBb2V3MEtJQ0FnSUNBZ0lDQWdJQ0FnYm1GdFpUb2dVM1J5YVc1bktDaG5JQ1ltSUdjdWJtRnRaU2tnZkh3Z0p5Y3BMblJ5YVcwb0tTd05DaUFnSUNBZ0lDQWdJQ0FnSUhSbGVIUnpPaUFvWnlBbUppQkJjbkpoZVM1cGMwRnljbUY1S0djdWRHVjRkSE1wSUQ4Z1p5NTBaWGgwY3lBNklGdGRLUzV0WVhBb0tIUXBJRDArSUZOMGNtbHVaeWgwSUh4OElDY25LUzUwY21sdEtDa3BMbVpwYkhSbGNpaENiMjlzWldGdUtTd05DaUFnSUNBZ0lDQWdJQ0FnSUhKdmJHVTZJQ2huSUNZbUlHY3VjbTlzWlNrZ1B5QlRkSEpwYm1jb1p5NXliMnhsS1NBNklIVnVaR1ZtYVc1bFpDd05DaUFnSUNBZ0lDQWdJQ0I5S1NrTkNpQWdJQ0FnSUNBZ0lDQXVabWxzZEdWeUtDaG5LU0E5UGlCbkxuUmxlSFJ6TG14bGJtZDBhQ2tOQ2lBZ0lDQWdJRG9nVzEwN0RRb2dJQ0FnYVdZZ0tHeHBjM1F1YkdWdVozUm9JRHdnTWlrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2ZzbUlIc2w2M3NuYlFnNjdhQTdLR3g3WldwNjR1STY0dWtMaWNnZlNrN0RRb2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3RFFvZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU8yVWhPdWdpT3llaE91emhDRHN0cFRzc3B3ZzdKcVU3TEt0T2lEc21JSHNsNjBnSnlBcklHeHBjM1F1YkdWdVozUm9JQ3NnSitxd25DY2dLeUFvYlc5eVpTQS9JQ2NnS091TmxDRHJzSnZxdUxBcEp5QTZJQ2NuS1N3Z2JXOWtaV3dnUHlBbktPdXFxT3VOdURvZ0p5QXJJRzF2WkdWc0lDc2dKeWtuSURvZ0p5Y3BPdzBLSUNBZ0lIUnllU0I3RFFvZ0lDQWdJQ0JqYjI1emRDQnlJRDBnWVhkaGFYUWdZWE5yUjNKdmRYQnpLR3hwYzNRc0lHMXZaR1ZzTENCN0lIQmhjbk5sT2lCd1lYSnpaVWR5YjNWd2N5d2dabTl5YldGMFJHVnpZem9nSjNzaVozSnZkWEJ6SWpvZ1czc2libUZ0WlNJNklDTHNtSUhzbDYwZzdKMjA2NmFFSWl3Z0luTjFaMmRsYzNScGIyNXpJam9nVzNzaWRHVjRkQ0k2SUNMcmpJRHNsWWdpTENBaWNtVmhjMjl1SWpvZ0l1eWR0T3ljb0NKOVhYMWRmU2NnZlN3Z0lTRnRiM0psS1RzTkNpQWdJQ0FnSUdOdmJuTjBJRzkxZENBOUlISXVjR0Z5YzJWa093MEtJQ0FnSUNBZ1kyOXVjM1FnYzJWaklEMGdLQ2hFWVhSbExtNXZkeWdwSUMwZ2MzUmhjblJsWkNrZ0x5QXhNREF3S1M1MGIwWnBlR1ZrS0RFcE93MEtJQ0FnSUNBZ2FXWWdLQ0Z2ZFhRcElISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z05UQXlMQ0I3SUdWeWNtOXlPaUFuN1lHMDY2R2M2NU9jSU95ZGtldUx0ZXlkaENEdGxiVHNoSjN0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGljZ2ZTazdEUW9nSUNBZ0lDQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnN1pTRTY2Q0k3SjZFNjdPRUlPeWduT3lWaUNBbklDc2diM1YwTG5KbFpIVmpaU2dvYml3Z1p5a2dQVDRnYmlBcklHY3VjM1ZuWjJWemRHbHZibk11YkdWdVozUm9MQ0F3S1NBcklDZnFzSndnTHlEc21JSHNsNjBnSnlBcklHOTFkQzVzWlc1bmRHZ2dLeUFuNnJDY0lDZ25JQ3NnYzJWaklDc2dKM01wSnlrN0RRb2dJQ0FnSUNCemRHRjBjeTV6WlhKMlpXUXJLenNOQ2lBZ0lDQWdJSE4wWVhSekxteGhjM1JCZENBOUlHNWxkeUJFWVhSbEtDa3VkRzlNYjJOaGJHVlVhVzFsVTNSeWFXNW5LQ2RyYnkxTFVpY3BPdzBLSUNBZ0lDQWdjM1JoZEhNdWJHRnpkRlJsZUhRZ1BTQW5XKzJVaE91Z2lPeWVoT3V6aEYwZ0p5QXJJRk4wY21sdVp5Z29iR2x6ZEZzd1hTQW1KaUJzYVhOMFd6QmRMblJsZUhSeld6QmRLU0I4ZkNBbkp5a3VjMnhwWTJVb01Dd2dNalFwT3cwS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZObFl5QTlJSE5sWXpzTkNpQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTWpBd0xDQjdJR2R5YjNWd2N6b2diM1YwTENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0R0bElUcm9JanNub1RyczRRZzdMYVU3TEtjSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93MEtJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5LU2s3RFFvZ0lDQWdmUTBLSUNCOURRb2dJQzh2SU8yTW5leVhoU0RzbXBUc2hvenJzNFFnN0xhVTdMS2NJT0tBbENEdGxad2c3WXlkN0plRjdKMllJT3Exck95RXNleWFsT3lHakNqc2w2M3RsYUFyNjZ5NDZyV3NLZXVsdkNEdGxad2c2N0tJN0plUUlPdXdtK3lWaENEc2w2M3RsYURyczRUcm9ad2c2NHVrNjVPczY0cVU2NHVrTGcwS0lDQXZMeURzbXBUc2hvenJwYndnN1pXbzZydVlJT3V6dE91Q3RPeVZ2Q0R0ZzREc25iVHRpNERzbmJRZzY3TzQ2Nnk0SU91bnBldWR2ZXlkaENEc3NManNvYkR0bGFBZzdJaVlJT3llaU91THBDanNtcFRzaG96cnM0UWc2ckNjNjdPRUlPeWFsT3l5cmVxenZPeWRtQ0Rzc0tqc25iUXBMZzBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2Y21WamIyMXRaVzVrTFhCdmNIVndKeWtnZXcwS0lDQWdJR052Ym5OMElIc2daV3hsYldWdWRITXNJRzF2WkdWc0xDQnRiM0psSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPdzBLSUNBZ0lHTnZibk4wSUd4cGMzUWdQU0JCY25KaGVTNXBjMEZ5Y21GNUtHVnNaVzFsYm5SektTQS9JR1ZzWlcxbGJuUnpMbVpwYkhSbGNpZ29aU2tnUFQ0Z1pTQW1KaUJUZEhKcGJtY29aUzUwWlhoMElIeDhJQ2NuS1M1MGNtbHRLQ2twSURvZ1cxMDdEUW9nSUNBZ2FXWWdLR3hwYzNRdWJHVnVaM1JvSUR3Z01pa2djbVYwZFhKdUlHcHpiMjRvY21WekxDQTBNREFzSUhzZ1pYSnliM0k2SUNmdGpKM3NsNFVnN0pxVTdJYU02ckNBSU91MmdPeWhzZTJWcWV1TGlPdUxwQzRuSUgwcE93MEtJQ0FnSUdOdmJuTjBJSE4wWVhKMFpXUWdQU0JFWVhSbExtNXZkeWdwT3cwS0lDQWdJR052Ym5OdmJHVXViRzluS0NkYlluSnBaR2RsWFNEdGpKM3NsNFVnN0xhVTdMS2NJT3lhbE95eXJUb2c3SnFVN0lhTUlDY2dLeUJzYVhOMExteGxibWQwYUNBcklDZnFzSnduSUNzZ0tHMXZjbVVnUHlBbklDanJqWlFnNjdDYjZyaXdLU2NnT2lBbkp5a3NJRzF2WkdWc0lEOGdKeWpycXFqcmpiZzZJQ2NnS3lCdGIyUmxiQ0FySUNjcEp5QTZJQ2NuS1RzTkNpQWdJQ0IwY25rZ2V3MEtJQ0FnSUNBZ1kyOXVjM1FnY2lBOUlHRjNZV2wwSUdGemExQnZjSFZ3S0d4cGMzUXNJRzF2WkdWc0xDQjdJSEJoY25ObE9pQndZWEp6WlZCdmNIVndMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5SnpaWFJ6SWpvZ1czc2ljbVZoYzI5dUlqb2dJdXV3cWUyV3BTRHRsWndnNjZ5NDdKNmxJaXdnSW1Wc1pXMWxiblJ6SWpvZ1czc2ljbTlzWlNJNklDTHNsNjN0bGFBaUxDQWlkR1Y0ZENJNklDTHJyTGpxdGF3aWZTd2dMaTR1WFgwc0lDNHVMbDE5SnlCOUxDQWhJVzF2Y21VcE93MEtJQ0FnSUNBZ1kyOXVjM1FnYzJWMGN5QTlJSEl1Y0dGeWMyVmtPdzBLSUNBZ0lDQWdZMjl1YzNRZ2MyVmpJRDBnS0NoRVlYUmxMbTV2ZHlncElDMGdjM1JoY25SbFpDa2dMeUF4TURBd0tTNTBiMFpwZUdWa0tERXBPdzBLSUNBZ0lDQWdhV1lnS0NGelpYUnpLU0I3RFFvZ0lDQWdJQ0FnSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTlRBeUxDQjdJR1Z5Y205eU9pQW43WUcwNjZHYzY1T2NJT3lka2V1THRleWRoQ0R0bGJUc2hKM3RsWmpzcDRBZzY2cTc3WmFJN0phMDdKcVVMaWNnZlNrN0RRb2dJQ0FnSUNCOURRb2dJQ0FnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc3WXlkN0plRklPeUV1TzJLdUNBbklDc2djMlYwY3k1c1pXNW5kR2dnS3lBbjZyQ2NJQ2duSUNzZ2MyVmpJQ3NnSjNNcEp5azdEUW9nSUNBZ0lDQnpkR0YwY3k1elpYSjJaV1FyS3pzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSQmRDQTlJRzVsZHlCRVlYUmxLQ2t1ZEc5TWIyTmhiR1ZVYVcxbFUzUnlhVzVuS0NkcmJ5MUxVaWNwT3cwS0lDQWdJQ0FnYzNSaGRITXViR0Z6ZEZSbGVIUWdQU0FuVysyTW5leVhoVjBnSnlBcklGTjBjbWx1Wnlnb2JHbHpkRnN3WFNBbUppQnNhWE4wV3pCZExuUmxlSFFwSUh4OElDY25LUzV6YkdsalpTZ3dMQ0F5TkNrN0RRb2dJQ0FnSUNCemRHRjBjeTVzWVhOMFUyVmpJRDBnYzJWak93MEtJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBeU1EQXNJSHNnYzJWMGN5d2daVzVuYVc1bE9pQW5ZMnhoZFdSbEp5QjlLVHNOQ2lBZ0lDQjlJR05oZEdOb0lDaGxLU0I3RFFvZ0lDQWdJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdZeWQ3SmVGSU95THBPMk1xRG9uTENCbExtMWxjM05oWjJVcE93MEtJQ0FnSUNBZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBMU1ESXNJR1p5YVdWdVpHeDVSWEp5YjNJb1pTd2dKKzJCdE91aG5PdVRuQ0R0bUxqc3Rwd2c3SXVrN1l5b09pQW5LU2s3RFFvZ0lDQWdmUTBLSUNCOURRb2dJQzh2SU91TWdPMlpsTzJZbFNEcnJManF0YXdnN0tDYzdKNlJJT0tBbENEc2c0SHRtYW5zbllRZzdJU2s2NnFGN1pXWTY2bTBJT3VzdU9xMXJPdWx2Q0RycDR6cms2VHNsclRzcElEcmk2UWdLT3kybE95eW5PcXp2Q0Rxc0puc25ZQWc3SVM0N0lXWUxDRHJqSUR0bVpUcmlwUWc2NmVrSU95YWxPeXlyZXlYa0NEdGhyWHNwN2pyb1p3ZzdJdWs2NmE4S1EwS0lDQnBaaUFvY21WeExtMWxkR2h2WkNBOVBUMGdKMUJQVTFRbklDWW1JSEpsY1M1MWNtd2dQVDA5SUNjdlkyOXRjRzl6WlNjcElIc05DaUFnSUNCamIyNXpkQ0I3SUcxbGMzTmhaMlZ6TENCdGIyUmxiQ0I5SUQwZ1lYZGhhWFFnY21WaFpFSnZaSGtvY21WeEtUc05DaUFnSUNCamIyNXpkQ0JzYVhOMElEMGdRWEp5WVhrdWFYTkJjbkpoZVNodFpYTnpZV2RsY3lrZ1B5QnRaWE56WVdkbGN5NW1hV3gwWlhJb0tHMHBJRDArSUcwZ0ppWWdVM1J5YVc1bktHMHVkR1Y0ZENCOGZDQW5KeWt1ZEhKcGJTZ3BLU0E2SUZ0ZE93MEtJQ0FnSUdsbUlDZ2hiR2x6ZEM1c1pXNW5kR2dwSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBd0xDQjdJR1Z5Y205eU9pQW42NHlBN1ptVUlPdUN0T3lhcWV5ZHRDRHJ1WVRzbHJRZzdKNkk3SXExNjR1STY0dWtMaWNnZlNrN0RRb2dJQ0FnWTI5dWMzUWdjM1JoY25SbFpDQTlJRVJoZEdVdWJtOTNLQ2s3RFFvZ0lDQWdZMjl1YzNRZ2JHRnpkRlZ6WlhJZ1BTQmJMaTR1YkdsemRGMHVjbVYyWlhKelpTZ3BMbVpwYm1Rb0tHMHBJRDArSUcwdWNtOXNaU0FoUFQwZ0oyRnpjMmx6ZEdGdWRDY3BPdzBLSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c25wRWc2NHlBN1ptVUlPeWFsT3l5clRvbkxDQlRkSEpwYm1jb0tHeGhjM1JWYzJWeUlDWW1JR3hoYzNSVmMyVnlMblJsZUhRcElIeDhJQ2NuS1M1emJHbGpaU2d3TENBMU1Da3VjbVZ3YkdGalpTZ3ZYRzR2Wnl3Z0p5QW5LU0FySUNmaWdLWWdLT3VNZ08yWmxDQW5JQ3NnYkdsemRDNXNaVzVuZEdnZ0t5QW42ckNjS1NjcE93MEtJQ0FnSUhSeWVTQjdEUW9nSUNBZ0lDQXZMeURyaklEdG1aVHFzSUFnNnJpNDdKYTA3S2VBNjZtMElPeTFuT3EzdkNBeE11cXduT3VuakNBbzdaU0U2NkdzN1pTRTdZcTRJTzJQcmV5anZDRHJzS25zcDRBcERRb2dJQ0FnSUNCamIyNXpkQ0J5SUQwZ1lYZGhhWFFnWVhOclEyOXRjRzl6WlNoc2FYTjBMbk5zYVdObEtDMHhNaWtzSUcxdlpHVnNMQ0I3SUhCaGNuTmxPaUJ3WVhKelpVTnZiWEJ2YzJVc0lHWnZjbTFoZEVSbGMyTTZJQ2Q3SW5KbGNHeDVJam9nSXV1TWdPMlpsQ0RzblpIcmk3VWc3WldjNjVHUUlPdXN1T3llcFNJc0lDSnpkV2RuWlhOMGFXOXVjeUk2SUZ0N0luUmxlSFFpT2lBaTY2eTQ2cldzSWl3Z0luSmxZWE52YmlJNklDTHNuYlRzbktBaWZTd2dMaTR1WFgwbklIMHBPdzBLSUNBZ0lDQWdZMjl1YzNRZ2IzVjBJRDBnY2k1d1lYSnpaV1E3RFFvZ0lDQWdJQ0JqYjI1emRDQnpaV01nUFNBb0tFUmhkR1V1Ym05M0tDa2dMU0J6ZEdGeWRHVmtLU0F2SURFd01EQXBMblJ2Um1sNFpXUW9NU2s3RFFvZ0lDQWdJQ0JwWmlBb0lXOTFkQ2tnZXcwS0lDQWdJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURVd01pd2dleUJsY25KdmNqb2dKKzJCdE91aG5PdVRuQ0RzblpIcmk3WHNuWVFnN1pXMDdJU2Q3WldZN0tlQUlPdXF1KzJXaU95V3RPeWFsQzRuSUgwcE93MEtJQ0FnSUNBZ2ZRMEtJQ0FnSUNBZ1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3lnbk95ZWtTRHNuWkhyaTdVZ0tDY2dLeUJ6WldNZ0t5QW5jeXdnN0tDYzdKV0lJQ2NnS3lCdmRYUXVjM1ZuWjJWemRHbHZibk11YkdWdVozUm9JQ3NnSitxd25Da25LVHNOQ2lBZ0lDQWdJSE4wWVhSekxuTmxjblpsWkNzck93MEtJQ0FnSUNBZ2MzUmhkSE11YkdGemRFRjBJRDBnYm1WM0lFUmhkR1VvS1M1MGIweHZZMkZzWlZScGJXVlRkSEpwYm1jb0oydHZMVXRTSnlrN0RRb2dJQ0FnSUNCemRHRjBjeTVzWVhOMFZHVjRkQ0E5SUZOMGNtbHVaeWdvYkdGemRGVnpaWElnSmlZZ2JHRnpkRlZ6WlhJdWRHVjRkQ2tnZkh3Z0p5Y3BMbk5zYVdObEtEQXNJRE13S1RzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ5WlhCc2VUb2diM1YwTG5KbGNHeDVMQ0J6ZFdkblpYTjBhVzl1Y3pvZ2IzVjBMbk4xWjJkbGMzUnBiMjV6TENCbGJtZHBibVU2SUNkamJHRjFaR1VuSUgwcE93MEtJQ0FnSUgwZ1kyRjBZMmdnS0dVcElIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0Rzb0p6c25wRWc3SXVrN1l5b09pY3NJR1V1YldWemMyRm5aU2s3RFFvZ0lDQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJRFV3TWl3Z1puSnBaVzVrYkhsRmNuSnZjaWhsTENBbjdZRzA2NkdjNjVPY0lPMll1T3kybkNEc2k2VHRqS2c2SUNjcEtUc05DaUFnSUNCOURRb2dJSDBOQ2lBZ0x5OGc2N0tJN0pldElPS0FsQ0R0bFp6cXRhM3NsclFnNG9hVUlPeVlnZXlXdENEc25wRHJqNWtnS095MmxPeXluT3F6dkNEcXNKbnNuWUFnN0lTNDdJV1lJT3lDck95YXFTa05DaUFnYVdZZ0tISmxjUzV0WlhSb2IyUWdQVDA5SUNkUVQxTlVKeUFtSmlCeVpYRXVkWEpzSUQwOVBTQW5MM1J5WVc1emJHRjBaU2NwSUhzTkNpQWdJQ0JqYjI1emRDQjdJSFJsZUhRc0lHMXZaR1ZzSUgwZ1BTQmhkMkZwZENCeVpXRmtRbTlrZVNoeVpYRXBPdzBLSUNBZ0lHbG1JQ2doZEdWNGRDQjhmQ0FoVTNSeWFXNW5LSFJsZUhRcExuUnlhVzBvS1NrZ2NtVjBkWEp1SUdwemIyNG9jbVZ6TENBME1EQXNJSHNnWlhKeWIzSTZJQ2Zyc29qc2w2M3RsYUFnNjZ5NDZyV3M2ckNBSU91NWhPeVd0Q0Rzbm9qc2lyWHJpNGpyaTZRdUp5QjlLVHNOQ2lBZ0lDQmpiMjV6ZENCemRHRnlkR1ZrSUQwZ1JHRjBaUzV1YjNjb0tUc05DaUFnSUNCamIyNXpiMnhsTG14dlp5Z25XMkp5YVdSblpWMGc2N0tJN0pldElPeWFsT3l5clRvbkxDQlRkSEpwYm1jb2RHVjRkQ2t1YzJ4cFkyVW9NQ3dnTlRBcExuSmxjR3hoWTJVb0wxeHVMMmNzSUNjZ0p5a2dLeUFuNG9DbUp5azdEUW9nSUNBZ2RISjVJSHNOQ2lBZ0lDQWdJR052Ym5OMElISWdQU0JoZDJGcGRDQmhjMnRVY21GdWMyeGhkR1VvVTNSeWFXNW5LSFJsZUhRcExuUnlhVzBvS1N3Z2JXOWtaV3dzSUhzZ2NHRnljMlU2SUhCaGNuTmxWSEpoYm5Oc1lYUmxMQ0JtYjNKdFlYUkVaWE5qT2lBbmV5SjBjbUZ1YzJ4aGRHVmtJam9nSXV1eWlPeVhyZXVzdUNBbzdLU0U2N0NVNnIrSTdKMkFJRnhjYmlraUxDQWlaR2x5WldOMGFXOXVJam9nSW10djRvYVNaVzRnNjVpUTY0cVVJR1Z1NG9hU2EyOGlmU2NnZlNrN0RRb2dJQ0FnSUNCamIyNXpkQ0J2ZFhRZ1BTQnlMbkJoY25ObFpEc05DaUFnSUNBZ0lHTnZibk4wSUhObFl5QTlJQ2dvUkdGMFpTNXViM2NvS1NBdElITjBZWEowWldRcElDOGdNVEF3TUNrdWRHOUdhWGhsWkNneEtUc05DaUFnSUNBZ0lHbG1JQ2doYjNWMEtTQjdEUW9nSUNBZ0lDQWdJSEpsZEhWeWJpQnFjMjl1S0hKbGN5d2dOVEF5TENCN0lHVnljbTl5T2lBbjdZRzA2NkdjNjVPY0lPdXlpT3lYclNEc25aSHJpN1hzbllRZzdaVzA3SVNkN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0bklIMHBPdzBLSUNBZ0lDQWdmUTBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0aWNtbGtaMlZkSU91eWlPeVhyU0RzbVlUcm80d2dLQ2NnS3lCelpXTWdLeUFuY3l3Z0p5QXJJQ2h2ZFhRdVpHbHlaV04wYVc5dUlIeDhJQ2MvSnlrZ0t5QW5LU2NwT3cwS0lDQWdJQ0FnYzNSaGRITXVjMlZ5ZG1Wa0t5czdEUW9nSUNBZ0lDQnpkR0YwY3k1c1lYTjBRWFFnUFNCdVpYY2dSR0YwWlNncExuUnZURzlqWVd4bFZHbHRaVk4wY21sdVp5Z25hMjh0UzFJbktUc05DaUFnSUNBZ0lITjBZWFJ6TG14aGMzUlVaWGgwSUQwZ1UzUnlhVzVuS0hSbGVIUXBMbk5zYVdObEtEQXNJRE13S1RzTkNpQWdJQ0FnSUhOMFlYUnpMbXhoYzNSVFpXTWdQU0J6WldNN0RRb2dJQ0FnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUIwY21GdWMyeGhkR1ZrT2lCdmRYUXVkSEpoYm5Oc1lYUmxaQ3dnWkdseVpXTjBhVzl1T2lCdmRYUXVaR2x5WldOMGFXOXVMQ0JsYm1kcGJtVTZJQ2RqYkdGMVpHVW5JSDBwT3cwS0lDQWdJSDBnWTJGMFkyZ2dLR1VwSUhzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHJzb2pzbDYwZzdJdWs3WXlvT2ljc0lHVXViV1Z6YzJGblpTazdEUW9nSUNBZ0lDQnlaWFIxY200Z2FuTnZiaWh5WlhNc0lEVXdNaXdnWm5KcFpXNWtiSGxGY25KdmNpaGxMQ0FuN1lHMDY2R2M2NU9jSU91eWlPeVhyU0RzaTZUdGpLZzZJQ2NwS1RzTkNpQWdJQ0I5RFFvZ0lIME5DaUFnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0EwTURRc0lIc2daWEp5YjNJNklDZE9iM1FnWm05MWJtUW5JSDBwT3cwS2ZTazdEUW9OQ2k4dklPeWR0T3V2dUNEcmk2VHJwcXpxc0lBZzY1YWdJT3llaU91S2xPdU5zQ0RybUpBZzdMeWM2cml3NnJDQUlPdVRwT3lXdE95WXBPdXB0Q2pzb0p6c2lxVHNzcGdnN0o2UTY0K1pJT3k4bk9xNHNDRHNwSkhyczdVZzY1T3hLU0Rzb2JEc21xbnRub2dnN0tLRjY2T01JT0tBbENEcmo0enJqWmdnNjR1azY2YXM2NHFVSU9xM3VPdU1nT3VobkNEc25LRHNwNEFOQ25ObGNuWmxjaTV2YmlnblpYSnliM0luTENBb1pTa2dQVDRnZXcwS0lDQnBaaUFvWlNBbUppQmxMbU52WkdVZ1BUMDlJQ2RGUVVSRVVrbE9WVk5GSnlrZ2V3MEtJQ0FnSUM4dklPdXN2T3F6b0NEc25vanJpcFFnN0txOTdKMjBJT3lDdE95VmhDRHNub2pyaXBUc3A0QWc3WldjSU91eWlDRHJyTHpzbHJUcnM3anJpNlFnNG9DVUlPeWRrZXVMdGV5ZHRDRHNsNGJzbkx6cnFiUWc3S0tGNjZPTUlPdVBoT3lra1NEc2xyenNsclRydHBuc25ZQWc3S0tBNjdtRTY0dWtMZzBLSUNBZ0lDOHZJT3EzdUNEc2dxenNpNlRzbllRZzY2R2M2cmU0N0plUUlPdUNxT3F5cU95VnZDQWk3WStzN1lxNDY0cVVJT3llb2UyWWdDRHNub2pyaXBUcmpiQWc3WlNNNjUrczZyZTQ3SjI0N0oyQUlPeVhzT3VQbVNEc2xZZ2c2NUNvSXV5ZGhDRHJpNlRzbll6c2w1QWc2N0NVNjZHY0lPeVZqT3lWaE91enVPdUxwQzROQ2lBZ0lDQmpiMjV6ZENCd2NtOWlaU0E5SUdoMGRIQXVjbVZ4ZFdWemRDaDdJR2h2YzNRNklDY3hNamN1TUM0d0xqRW5MQ0J3YjNKME9pQlFUMUpVTENCd1lYUm9PaUFuTDJobFlXeDBhQ2NzSUcxbGRHaHZaRG9nSjBkRlZDY3NJSFJwYldWdmRYUTZJREl3TURBZ2ZTd2dLSElwSUQwK0lIc05DaUFnSUNBZ0lHTnZibk52YkdVdWJHOW5LQ2RiWW5KcFpHZGxYU0RzbmJUcnI3Z2c3THljN0tDNElPeWVpT3lXdE95YWxDanRqNnp0aXJnZ0p5QXJJRkJQVWxRZ0t5QW5JT3lDck95YXFTRHNwSkVzSU95ZGtldUx0U0FuSUNzZ2NpNXpkR0YwZFhORGIyUmxJQ3NnSnlrZzRvQ1VJT3lkdENEc25ianNpcVR0aExUc2lxVHJpcFFnN0tLRjY2T003WldwNjR1STY0dWtMaWNwT3cwS0lDQWdJQ0FnYUdGeVpFVjRhWFFvTUNrN0RRb2dJQ0FnZlNrN0RRb2dJQ0FnWTI5dWMzUWdaR1ZoWkNBOUlDZ3BJRDArSUhzTkNpQWdJQ0FnSUdOdmJuTnZiR1V1Ykc5bktDZGJZbkpwWkdkbFhTRHRqNnp0aXJnZ0p5QXJJRkJQVWxRZ0t5QW43SjJFSU95ZGtldUx0U0RzbDRicmlwUWc3WlNFNjZHYzdJUzQ3SXFrNnJDQUlPdXN2T3F6b0NEc25vanNsclRzbXBRZzRvQ1VJT3EzdUNEdGxJVHJvWnpzaExqc2lxVHJwYndnNjRHZDY0SzA3Slc4SU8yVnFldUxpT3VMcENqc25wSHNsNFVnNnJTQTY2YXM3SjZRN0plUTdJU2NJRzV2WkdVZzdLS0Y2Nk9NS1M0bktUc05DaUFnSUNBZ0lHaGhjbVJGZUdsMEtEQXBPdzBLSUNBZ0lIMDdEUW9nSUNBZ2NISnZZbVV1YjI0b0oyVnljbTl5Snl3Z1pHVmhaQ2s3RFFvZ0lDQWdjSEp2WW1VdWIyNG9KM1JwYldWdmRYUW5MQ0FvS1NBOVBpQjdJSFJ5ZVNCN0lIQnliMkpsTG1SbGMzUnliM2tvS1RzZ2ZTQmpZWFJqYUNBb1gyVXlLU0I3ZlNCa1pXRmtLQ2s3SUgwcE93MEtJQ0FnSUhCeWIySmxMbVZ1WkNncE93MEtJQ0FnSUhKbGRIVnlianNOQ2lBZ2ZRMEtJQ0JqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdJU2M2N0tFSU95WXBPdWxtRG9uTENCbElDWW1JR1V1YldWemMyRm5aU2s3RFFvZ0lIQnliMk5sYzNNdVpYaHBkQ2d4S1RzTkNuMHBPdzBLTHk4ZzdKYTA2NWFrSU9xeXZldWhuT3VobkNEc283M3JrNkFvN0l1czdKNmw2N0NWNjQrWklPdUJpdXE1Z0N3Z1EzUnliQ3RETENBdmMyaDFkR1J2ZDI0c0lPeVlwT3VsbUNrZ1kyeGhkV1JsSU95ZWtPeUxuZXlkaENEcmdxanF1TERzcDRBZzdKV0s2NHFVNjR1a0RRcHdjbTlqWlhOekxtOXVLQ2RsZUdsMEp5d2dLQ2tnUFQ0Z2V5QnJhV3hzVUhKdll5Z3BPeUJyYVd4c1RHOW5hVzVRY205aktDazdJSDBwT3cwS2NISnZZMlZ6Y3k1dmJpZ25VMGxIU1U1VUp5d2dLQ2tnUFQ0Z2FHRnlaRVY0YVhRb01Da3BPdzBLY0hKdlkyVnpjeTV2YmlnblUwbEhWRVZTVFNjc0lDZ3BJRDArSUdoaGNtUkZlR2wwS0RBcEtUc05DZzBLYzJWeWRtVnlMbXhwYzNSbGJpaFFUMUpVTENBbk1USTNMakF1TUM0eEp5d2dLQ2tnUFQ0Z2V3MEtJQ0JqYjI1emIyeGxMbXh2WnlnbjRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0E0cFNBNHBTQTRwU0FKeWs3RFFvZ0lHTnZibk52YkdVdWJHOW5LQ2NnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rzdkp6c3A1QWc0b0NVSUdoMGRIQTZMeTlzYjJOaGJHaHZjM1E2SnlBcklGQlBVbFFwT3cwS0lDQmpiMjV6YjJ4bExteHZaeWduSU91cXFPdU51RG9nSnlBcklFTk1RVlZFUlY5TlQwUkZUQ0FySUNjZ3dyY2c3SmlJN0l1Y0lDY2dLeUJGV0VGTlVFeEZVeTVzWlc1bmRHZ2dLeUFuNnJHMElPeWVwZXl3cVNjcE93MEtJQ0JqYjI1emIyeGxMbXh2WnlnbklPeWR0Q0Rzc0wzc25ZUWc3THljNjVHVUlPdVBtZXlWaUNEdGxMenF0N2pycDRnZzdaU002NStzNnJlNDdKMjQ3SjIwSU8yQnRPdWhuT3VUbk91aG5DRHN0cFRzc3B6dGxhbnJpNGpyaTZRdUp5azdEUW9nSUdOdmJuTnZiR1V1Ykc5bktDZmlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSURpbElEaWxJRGlsSUFuS1RzTkNpQWdZMmhsWTJ0RGJHRjFaR1ZCZG1GcGJHRmliR1VvS1RzZ0x5OGdRMnhoZFdSbElFTnZaR1VnN0lLczdKcXBJT3F3Z091S3BTRHNsNnpydG9BZzdLQ1E2cktBSUNqdGxJenJuNnpxdDdqc25iZ2c3SldJNjRLMDdKcXBLUTBLSUNBdkx5RHJyN2pycHF3ZzdJdWM2NCtaSUNzZzdLZUE3SXVjNjZ5NElPeWp2T3llaFNEaWdKUWc3TEtySU95MmxPeXluT3UyZ08yRXNDRHJ1YURycGJUcXNvd05DaUFnWVhOclEyeGhkV1JsS0Nmc200enJzSTNzbDRVNklDTHNvSURzbnFVZzY1Q1k3SmVJN0lxMTY0dUk2NHVrSWljcExuUm9aVzRvRFFvZ0lDQWdLQ2tnUFQ0Z1kyOXVjMjlzWlM1c2IyY29KMXRpY21sa1oyVmRJT3liak91d2pleVhoU0RzbVlUcm80d2c0b0NVSU95MmxPeXluQ0RzcElEcnVZUWc2NEdkTGljcExBMEtJQ0FnSUNobEtTQTlQaUJqYjI1emIyeGxMbXh2WnlnblcySnlhV1JuWlYwZzdKdU02N0NON0plRklPeUxwTzJNcUNBbzdMS3JJT3lhbE95eXJTRHJsWXdnN0o2czdJdWM2NCtFS1RvbkxDQmxMbTFsYzNOaFoyVXBEUW9nSUNrN0RRcDlLVHNOQ2k4dklFbFFkallnNjZPbzdaU0U2N0N4S0RvNk1TbnNsNURyajRRZzdaV282cnVZSU91VG8rdUtsT3VMcENEaWdKUWdiV0ZqVDFNZzY1T3g3SmVRN0lTY0lDZHNiMk5oYkdodmMzUW42ckNBSURvNk1ldWhuQ0RycUx6c29JQWc3WlcwN0lTZDY1Q1k2NHFVNjQyd0RRb3ZMeUR0bEx6cXQ3anJwNGdvUld4bFkzUnliMjRwSUdabGRHTm82NHFVSUdOMWNtenFzN3dnNjR1czY2YXNJRWxRZGpUcm9ad2c3SjZRNjQrWklPMlB0T3V3c2UyVm1PeW5nQ0RzbFlyc2xZUXNJRWxRZGpUcnA0d2c2NU9qNjQyWUlPdUxwT3Vtck95WGtDRHNsN0Rxc3JEc25iUWc2ckd3NjdhQTY0KzhEUW92THlEc3RwVHNzcHpDdCsyWHJPeUtwT3l5dE8yQnJPcXdnQ0Rzb2JEc21xbnRub2dnN0l1azdZeW83WmFJNjR1a0tPeUxwT3k0b1NBeU1ESTJMVEEzS1M0ZzZyQ1o3SjJBSU95YWxPeXlyU0R0bGJqcms2VHJuNnpycGJ3Z1NWQjJOaURybzZqdGxJVHJzTEhzbDVEcmo0UWc3SmE1NjRxVTY0dWtMZzBLWTI5dWMzUWdjMlZ5ZG1WeU5pQTlJR2gwZEhBdVkzSmxZWFJsVTJWeWRtVnlLSE5sY25abGNpNXNhWE4wWlc1bGNuTW9KM0psY1hWbGMzUW5LVnN3WFNrN0RRcHpaWEoyWlhJMkxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQmpiMjV6YjJ4bExteHZaeWduVzJKeWFXUm5aVjBnU1ZCMk5pZzZPakVwSU91bXJPeUtxQ0RzZzUzcm5yVWc0b0NVSUVsUWRqVHJwNHdnN0lLczdKcXBPaWNzSUdVZ0ppWWdaUzV0WlhOellXZGxLU2s3RFFwelpYSjJaWEkyTG14cGMzUmxiaWhRVDFKVUxDQW5Pam94SnlrN0RRbz0nCkI2NF9XQVRDSEVSPSdMeThnN1lHMDY2R2M2NU9jSU91THBPdW1yQ0Rxc0pEc2k1enNucEFnNG9DVUlPMlZyZXlEZ1NEcmxxQWc3SjZJNjRxVUlPeTBpT3lHak8yWWxTRHNoSnpyc29RZ0tHeHZZMkZzYUc5emREb3hNVGc0T1NrTkNpOHZJT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ09LVWdPS1VnT0tVZ0EwS0x5OGc3Sm1jSU8yVmhPeWFsTzJWbk9xd2dEb2c3WlM4NnJlNDY2ZUk2ckNBSU8yVWpPdWZyT3EzdU95ZHVPeWRtQ0JqYkdGMVpHVmljbWxrWjJVNkx5OGc3SmUwNnJpd0tIZHBibVJ2ZHk1dmNHVnVMMmxtY21GdFpTOXZjR1Z1UlhoMFpYSnVZV3dwNjZXOERRb3ZMeURzb0lUcnRvQWc3SWFNNjZhc0lPeVhodXlkdENEcnA0bnJpcFFnNjdLRTdLQ0U3SjIwSU95ZWlPdUxwQzRnWm1WMFkyanJpcFFnNjZxN0lPdW5pZXljdk91dmdPdWhuQ3dnN1pTTTY1K3M2cmU0N0oyNDdKMjBJT3lkdENEcXNKRHNpNXpzbnBEc2w1RHFzb3dOQ2k4dklGQlBVMVFnTDNkaGEyVWc2Nlc4SU91enRPdUN0T3VwdENEcXNKRHNpNXpzbnBEcXNJQWc2NHVrNjZhc0tHTnNZWFZrWlMxaWNtbGtaMlV1YW5NcDY2VzhJT3VNZ095TG9DRHN2S0RyaTZRdURRb3ZMdzBLTHk4ZzY0dWs2NmFzN0ptQTdKMllJT3l3cU95ZHREb2c2ckNRN0l1YzdKNlE2NHFVSUdOc1lYVmtaZXVsdkNEcnJMenNwNEFnN0pXSzY0cVU2NHVrS095ZWtPeUxuU0RzbDRic25Zd3BJT0tHa2lEdGdiVHJvWnpyazV3ZzdKV3hJT3lYaGV1TnNPeWR0TzJLdU91bHZDRHNsWWdnNjZlSjZyT2dMQTBLTHk4ZzY2bVU2NnFvNjZhc0lINHhOVTFDNjUyOElPdWhuT3EzdU95ZHVDRHNpNXdnN0o2UTY0K1pJT3lMbk95ZWtleWN2T3VobkNEc2c0SHNpNXdnN0x5YzY1R3M2NCtFSU91MmdPdUx0Q0RzbDRicmk2UWdLT3VUc2V1aG5Ub2dibkJ0SUhKMWJpQmlkV2xzWkNrdURRb3ZMeURyaTZUcnBxenJpcFFnN0l1czdKNmw2N0NWNjQrWklPdUJpdXE0c091cHRDRHNvNzNzcDREcnA0d283WlNNNjUrczZyZTQ3SjI0NnJPOElPeURuZXlDckNEcmo1bnF1TER0bVpRcExDRHFzSkRzaTV6c25wRHJpcFFnNnJPRTdJYU5JT3VDcU95VmhDRHJpNlRzbll3ZzZybW83SnF3NnJpdzY2VzhJT3V3bSt1S2xPdUxwQzROQ2cwS1kyOXVjM1FnYUhSMGNDQTlJSEpsY1hWcGNtVW9KMmgwZEhBbktUc05DbU52Ym5OMElIQmhkR2dnUFNCeVpYRjFhWEpsS0Nkd1lYUm9KeWs3RFFwamIyNXpkQ0JtY3lBOUlISmxjWFZwY21Vb0oyWnpKeWs3RFFwamIyNXpkQ0J2Y3lBOUlISmxjWFZwY21Vb0oyOXpKeWs3RFFwamIyNXpkQ0I3SUhOd1lYZHVMQ0J6Y0dGM2JsTjVibU1nZlNBOUlISmxjWFZwY21Vb0oyTm9hV3hrWDNCeWIyTmxjM01uS1RzTkNnMEtZMjl1YzNRZ1VFOVNWQ0E5SURFeE9EZzVPdzBLWTI5dWMzUWdVazlQVkNBOUlIQmhkR2d1YW05cGJpaGZYMlJwY201aGJXVXNJQ2N1TGljcE95QXZMeURzb0lEc25xWHNob3dnNjZPbzdZcTRJT0tBbENEcmk2VHJwcXpxc0lBZ2NtVmpiMjF0Wlc1a0xXVjRZVzF3YkdWekxtMWs2Nlc4SU95d3Z1dUtsQ0RxdUxEc3BJQU5DZzBLWTI5dWMzUWdRMDlTVTE5SVJVRkVSVkpUSUQwZ2V3MEtJQ0FuUVdOalpYTnpMVU52Ym5SeWIyd3RRV3hzYjNjdFQzSnBaMmx1SnpvZ0p5b25MQTBLSUNBblFXTmpaWE56TFVOdmJuUnliMnd0UVd4c2IzY3RUV1YwYUc5a2N5YzZJQ2RIUlZRc0lGQlBVMVFzSUU5UVZFbFBUbE1uTEEwS0lDQW5RV05qWlhOekxVTnZiblJ5YjJ3dFFXeHNiM2N0U0dWaFpHVnljeWM2SUNkRGIyNTBaVzUwTFZSNWNHVW5MQTBLZlRzTkNtWjFibU4wYVc5dUlHcHpiMjRvY21WekxDQnpkR0YwZFhNc0lHOWlhaWtnZXcwS0lDQnlaWE11ZDNKcGRHVklaV0ZrS0hOMFlYUjFjeXdnVDJKcVpXTjBMbUZ6YzJsbmJpaDdJQ2REYjI1MFpXNTBMVlI1Y0dVbk9pQW5ZWEJ3YkdsallYUnBiMjR2YW5OdmJqc2dZMmhoY25ObGREMTFkR1l0T0NjZ2ZTd2dRMDlTVTE5SVJVRkVSVkpUS1NrN0RRb2dJSEpsY3k1bGJtUW9TbE5QVGk1emRISnBibWRwWm5rb2IySnFLU2s3RFFwOURRb05DaTh2SUdOc1lYVmtaU0JEVEVucXNJQWc3SjZJNjRxVTdLZUFJT0tBbENEc2w0YnNuTHpycWJRZ0wzZGhhMlVnN0oyUjY0dTE3SmVRSU95THBPeVd0Q0R0bEl6cm42enF0N2pzbmJqc25iUWc3SldJNjRLMDdaV2dJT3lJbUNEc25vanFzb3dnN1pXYzY0dWtEUW92THlEcm9aenF0N2pzbmJqcmtKd2c2ck9FN0tDVklPeWR2ZXE0c0NEaWdKUWdRMHhKNnJDQUlINHZMbU5zWVhWa1pTNXFjMjl1N0plUUlPcTRzT3VobmUyVm1PdUtsQ0J2WVhWMGFFRmpZMjkxYm5RdVpXMWhhV3hCWkdSeVpYTnpJQ2pyaTZUcnBxenNuWmdnWTJ4aGRXUmxRV05qYjNWdWRPeVpnQ0Rxc0puc25ZQWc3TGFjN0xLWUtTNE5DaTh2SU8yTWpPeWR2T3lkdENEdGdiUWc3SWlZSU95ZWlPeVd0Q0F6TU95MGlDRHN1cERzaTV3dUlPeWVyT3Vobk9xM3VPeWR1TzJWbU91cHRDQkRURW5xc0lBZzdZeU03SjI4N0oyRUlPcXdzZXlMb08yVm1PdXZnT3VobkNEc25wRHJqNWtnNjdDWTdKaUI2NUNjNjR1a0xnMEtMeThnN0xxUTdJdWNJRFhzdElnZzRvQ1VJT3Vobk9xM3VPeWR1Q0RzcDRIdG00UWc3SU9JSU9xemhPeWdsZXlkdENEcXM2ZnJzSlRyb1p3ZzdKNmg3WmlBN0pXOElPMlVqT3Vmck9xM3VPeWR1T3lkdENEcm9aenF0N2pzbmJnZzdabVU2Nm0wN0plUTdJU2NJTzJaaU95Y3ZPdWhuQ0RyaEpqc2xyVHFzSVRyaTZRb016RHN0SWpycWJRZzY0U0k2NnkwSU91S3B1eWRqQ2tOQ214bGRDQmhZMk52ZFc1MFEyRmphR1VnUFNCN0lHRjBPaUF3TENCbGJXRnBiRG9nYm5Wc2JDQjlPdzBLTHk4ZzdJdWs3S0NjSU91aG5PcTN1T3lkdUNEc2w2enJ0b0RyaXBRZzdKNlE2cktwN0thZDY2cUZJTzJNak95ZHZPdWhuQ0R0akpEcmk2anRsWnpyaTZRZzRvQ1VJSDR2TG1Oc1lYVmtaUzVxYzI5dTdKMllJRzloZFhSb1FXTmpiM1Z1ZE91S2xDQXFLdXVobk9xM3VPeVZoT3liZysyVnRPdVBoQ0RyZ3FqcmlwVHJpNlFxS2cwS0x5OGdLT3lMcE95NG9Ub2dZMnhoZFdSbElHRjFkR2dnYzNSaGRIVno2NHFVSUd4dloyZGxaRWx1T21aaGJITmw3SjI0NjQyd0lPcTN1Q0R0bFlUcms1enJpcFFnNnJlNDY0eUE2NkdjSU9LR2tpRHRsSXpybjZ6cXQ3anNuYmpzbmJRZzY2R2M2cmU0N0oyNDY1Q2NJT3F5Zyt5eW1PdWZ2Q0R0a1p6c2k1enRsb2pyaTZRcExnMEtMeThnN1l5TTdKMjg2NmVNSU95ZHZleWN2T3V2Z091aG5DRHJ1WVRzbXFrZ01DNGdZMnhoZFdSbElHRjFkR2dnYzNSaGRIVno2ckNBSU95Z2xlMlpsZTJWbU95bmdPdW5qQ0R0bElUcm9aenNoTGpzaXFUcnBid2c2NTJFN0p1TTdKVzhJTzJWdE95RW5DRHNvYkR0bW96cnA0anJpNlFnN0pPdzZyaXc3SmVVSU91c3RPcXlnZXVMcEM0TkNtWjFibU4wYVc5dUlHaGhjME5zWVhWa1pVTnlaV1JsYm5ScFlXeHpLQ2tnZXcwS0lDQjBjbmtnZXcwS0lDQWdJR052Ym5OMElHWWdQU0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5MbU5zWVhWa1pTY3NJQ2N1WTNKbFpHVnVkR2xoYkhNdWFuTnZiaWNwT3cwS0lDQWdJR052Ym5OMElHb2dQU0JLVTA5T0xuQmhjbk5sS0daekxuSmxZV1JHYVd4bFUzbHVZeWhtTENBbmRYUm1PQ2NwS1RzTkNpQWdJQ0JwWmlBb2FpQW1KaUJxTG1Oc1lYVmtaVUZwVDJGMWRHZ2dKaVlnYWk1amJHRjFaR1ZCYVU5aGRYUm9MbUZqWTJWemMxUnZhMlZ1S1NCeVpYUjFjbTRnZEhKMVpUc05DaUFnZlNCallYUmphQ0FvWDJVcElIc2dMeW9nN1l5TTdKMjhJT3lYaHV5ZGpNSzM2NnE3SU95ZHZleWRqQ0RpZ0pRZzY2ZWw3SjIwNjZtMElPMkNwT3l5dE95ZHVPeWRoQ0RycDRqc29JQWc2N080NjR1a0lDb3ZJSDBOQ2lBZ0x5OGdLaXJycDZYc25ZQWc3SjZRNnJLcDdLYWQ2NnFGN0oyRUlPMk1qT3lkdk95ZHRDRHNsWVRyaTRqcm5id2c3WUtrN0xLMDdKMjQ3SmVRSU91RW8rdUtsT3VMcENvcUlDZ3lNREkyTFRBNElPeUxwT3k0b1N3ZzY0dWs2NmFzSUhZME1TQXZJT3F3a095TG5PeWVrQ0IyTmlrdURRb2dJQzh2SU91bnBleWRtQ0JEYkdGMVpHVWdRMjlrWmV1S2xDQitMeTVqYkdGMVpHVXZMbU55WldSbGJuUnBZV3h6TG1wemIyN3NuWVFnN0pXRTdKaUlJT3Vuak91VHBPeW5nQ0RzbFlycXM2QWc3WUtrN0xLMDdKMjRJTzJWcmV1cXFRMEtJQ0F2THlBblEyeGhkV1JsSUVOdlpHVXRZM0psWkdWdWRHbGhiSE1uN0plUUlPeWdnT3llcGUyVm5PdUxwQ0RpaHBJZzdZeU03SjI4NjZlTUlPdXp0T3VwdENEcnFZRHNxYUh0bm9nZzY2R2M2cmU0N0oyNDY1Q2NJT3VucGV5ZHRDRHJpcGdnSit1aG5PcTN1T3lkdUNEc2xZZ2c2NUNvSit5ZHRDRHJrSmpxczZBc0RRb2dJQzh2SU91aG5PcTN1T3lkdUNEcmpJRHF1TEFnN1ptVTY2bTA3SjIwSU95WWdleVlnU0RyajRqcmk2UW82NGlNNjUrczY0K0VJRU5NU2Vxd2dDQWk3SjIwNjYrNElPdWhuT3EzdU95ZHVPdVFxQ0xzbkx6cm9ad2c3S2FKN0l1Y0lPdUJuZXVDbUNEcnVJenJuYnpzbXJEc29JRHNvYkRzc0tnZzdKV0lJT3lYdE91bXNPdUxwQ2t1RFFvZ0lDOHZJQ29xN0tHMDdKNnM2NmVNSU8yWmxleWR1TzJWbk91THBDZ3RkeURzbDRic25Zd3BLaW9nNG9DVUlPdTVoT3V3Z091eWlPMll1Q0Rxc0pMc25ZUWc3SjI5N0p5ODY2bTBJTzJDcE95eXRPeWR1Q0Rzb0pIcXQ3d2c3WmVJN0pxcElPMk1uZXlYaGV5ZHRDRHJuTEFnN0lpWUlPeWVpT3VMcEM0ZzdKVzlJRE13YlhNdURRb2dJQzh2SUVOQ1gwNVBYMHRGV1VOSVFVbE9QVEhzbmJUcnFiUWc3WXlNN0oyODY2ZU1JT3V6dU91THBDQW82NnFvN0oyWUlPMlppT3ljdk91aG5DQW42NkdjNnJlNDdKMjRJT3lYaHV5ZGpDZnNuWVFnN0o2czdaaUU3WldZNjRxVUlPMkZqT3lLcE8yS3VPeWFxU0RpZ0pRZzdZS2s3TEswN0oyNDdKMkFJRWhQVFVYc25ZUWc3SldJSU91VXNPdWx1T3VMcENrdURRb2dJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUNFOVBTQW5aR0Z5ZDJsdUp5QjhmQ0J3Y205alpYTnpMbVZ1ZGk1RFFsOU9UMTlMUlZsRFNFRkpUaUE5UFQwZ0p6RW5LU0J5WlhSMWNtNGdabUZzYzJVN0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnWTI5dWMzUWdjaUE5SUhOd1lYZHVVM2x1WXlnbmMyVmpkWEpwZEhrbkxDQmJKMlpwYm1RdFoyVnVaWEpwWXkxd1lYTnpkMjl5WkNjc0lDY3RjeWNzSUNkRGJHRjFaR1VnUTI5a1pTMWpjbVZrWlc1MGFXRnNjeWRkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnl3Z2RHbHRaVzkxZERvZ016QXdNQ0I5S1RzTkNpQWdJQ0J5WlhSMWNtNGdjaTV6ZEdGMGRYTWdQVDA5SURBN0RRb2dJSDBnWTJGMFkyZ2dLRjlsS1NCN0lISmxkSFZ5YmlCbVlXeHpaVHNnZlNBdkx5QnpaV04xY21sMGVldWx2Q0RycXJzZzY3YUE2NmFFSUQwZzY2R2M2cmU0N0oyNElPeVZpQ0Rya0tqc25MenJvWndnNjdPNDY0dWtEUXA5RFFwbWRXNWpkR2x2YmlCamJHRjFaR1ZCWTJOdmRXNTBLQ2tnZXcwS0lDQnBaaUFvUkdGMFpTNXViM2NvS1NBdElHRmpZMjkxYm5SRFlXTm9aUzVoZENBOElEVXdNREFwSUhKbGRIVnliaUJoWTJOdmRXNTBRMkZqYUdVdVpXMWhhV3c3RFFvZ0lHeGxkQ0JsYldGcGJDQTlJRzUxYkd3N0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnYVdZZ0tHaGhjME5zWVhWa1pVTnlaV1JsYm5ScFlXeHpLQ2twSUhzZ0x5OGc3SjZRNnJLcDdLYWQ2NnFGN0oyMElPeVhodXljdk91cHRDRHJncWpzbllBZzdKMjA2Nm1VN0oyODdKMkFJT3VzdE95TG5PMlZuT3VMcEEwS0lDQWdJQ0FnWTI5dWMzUWdhaUE5SUVwVFQwNHVjR0Z5YzJVb1puTXVjbVZoWkVacGJHVlRlVzVqS0hCaGRHZ3VhbTlwYmlodmN5NW9iMjFsWkdseUtDa3NJQ2N1WTJ4aGRXUmxMbXB6YjI0bktTd2dKM1YwWmpnbktTazdEUW9nSUNBZ0lDQmxiV0ZwYkNBOUlDaHFJQ1ltSUdvdWIyRjFkR2hCWTJOdmRXNTBJQ1ltSUdvdWIyRjFkR2hCWTJOdmRXNTBMbVZ0WVdsc1FXUmtjbVZ6Y3lrZ2ZId2diblZzYkRzTkNpQWdJQ0I5RFFvZ0lIMGdZMkYwWTJnZ0tGOWxLU0I3SUM4cUlPdWhuT3EzdU95ZHVDRHNuYlRyb0tVZzdKZUc3SjJNSU91VHNTRGlnSlFnYm5Wc2JDQXFMeUI5RFFvZ0lHRmpZMjkxYm5SRFlXTm9aU0E5SUhzZ1lYUTZJRVJoZEdVdWJtOTNLQ2tzSUdWdFlXbHNJSDA3RFFvZ0lISmxkSFZ5YmlCbGJXRnBiRHNOQ24wTkNnMEtablZ1WTNScGIyNGdhR0Z6UTJ4aGRXUmxLQ2tnZXcwS0lDQmpiMjV6ZENCbWFXNWtaWElnUFNCd2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbklEOGdKM2RvWlhKbEp5QTZJQ2QzYUdsamFDYzdEUW9nSUhSeWVTQjdJSEpsZEhWeWJpQnpjR0YzYmxONWJtTW9abWx1WkdWeUxDQmJKMk5zWVhWa1pTZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnYzJobGJHdzZJSFJ5ZFdVZ2ZTa3VjM1JoZEhWeklEMDlQU0F3T3lCOUlHTmhkR05vSUNoZlpTa2dleUJ5WlhSMWNtNGdabUZzYzJVN0lIME5DbjBOQ2cwS2JHVjBJSGRoYTJsdVp5QTlJR1poYkhObE95QXZMeURzbDdEdGc0QWc2N0NwN0tlQUlPS0FsQ0RyaTZUcnBxenJpcFFnN0phMDdMQ283WlM4SUVWQlJFUlNTVTVWVTBYcm9ad2c3S1NSNjdPMUlPeWdsZXVtck8yVm1PeW5nT3VuakNEdGxJVHJvWnpzaExqc2lxUWc2NEt0NjdtRTY2VzhJT3lraE95ZHVPdUxwQTBLWm5WdVkzUnBiMjRnZDJGclpVSnlhV1JuWlNncElIc05DaUFnYVdZZ0tIZGhhMmx1WnlrZ2NtVjBkWEp1T3cwS0lDQjNZV3RwYm1jZ1BTQjBjblZsT3cwS0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIc2dkMkZyYVc1bklEMGdabUZzYzJVN0lIMHNJRFV3TURBcE93MEtJQ0JzWlhRZ2NISnZZenNOQ2lBZ2FXWWdLSEJ5YjJObGMzTXVjR3hoZEdadmNtMGdQVDA5SUNkM2FXNHpNaWNwSUhzTkNpQWdJQ0F2THlCWGFXNWtiM2R6T2lCamJXVEN0M1ppY3lEcXNyM3NuS0FnN0plRzdKMjBJRzV2WkdYcnBid2c3S2VCN0tDUkxDQjNhVzVrYjNkelNHbGtaU2hEVWtWQlZFVmZUazlmVjBsT1JFOVhLZXVobkNEc2lxVHRqN0FnNG9DVURRb2dJQ0FnTHk4ZzdMQzlJT3lYaHV1S2xDRHNpS2pzbllBZzdMMlk3SWFVN0oyMElPdW5qT3VUcE95V3RPeW5nT3F6b0NEcmk2VHJwcXpzblpnZzdKNlE3SXVkS0dOc1lYVmtaU25yajRRZzZyZTRJT3k5bU95R2xPeWRoQ0Ryckx6cm9LVHJzSnZzbFlRZzdKYTA2NWFrSU95d3ZldVBoQ0RzbFlnZzY1eXM2NHVrTGcwS0lDQWdJQzh2SUdSbGRHRmphR1ZrNjRxVUlPeVRzT3luZ0NEc2xZcnJpcFRyaTZRb1pHVjBZV05vWldRcmQybHVaRzkzYzBocFpHVWc3S0d3N1pXcDdKMkFJT3k5bU95R2xDRHNzTDNzbmJRZzY0VzQ3TGFjNjVDb0lPS0FsQ0RzaTZUc3VLRXBMZzBLSUNBZ0lDOHZJRmRwYm1SdmQzUHNsNURzaEtBZ1pHVjBZV05vWldRZzdKZUc3SjIwNjQrRUlPdTJnT3VxcUNqcXNKRHNpNXpzbnBBcDZyQ0FJT3lqdmV5V3RPdVBoQ0RzbnBEc2k1M3NuWUFnN0lLMDdKV0U2NEtvNjRxVTY0dWtMZzBLSUNBZ0lIQnliMk1nUFNCemNHRjNiaWh3Y205alpYTnpMbVY0WldOUVlYUm9MQ0JiY0dGMGFDNXFiMmx1S0Y5ZlpHbHlibUZ0WlN3Z0oyTnNZWFZrWlMxaWNtbGtaMlV1YW5NbktWMHNJSHNOQ2lBZ0lDQWdJR04zWkRvZ1VrOVBWQ3dnYzNSa2FXODZJQ2RwWjI1dmNtVW5MQ0IzYVc1a2IzZHpTR2xrWlRvZ2RISjFaU3dOQ2lBZ0lDQjlLVHNOQ2lBZ2ZTQmxiSE5sSUhzTkNpQWdJQ0F2THlCdFlXTlBVeS9ycHF6cmlJWHNpcVE2SU9xd2tPeUxuT3lla091bHZDRHJuWVRzbXJRZ2JtOWtaU0RzaTZUdGxva2c3WXlNN0oyODY2R2NJT3luZ2V5Z2tTRHNpcVR0ajdBZ0tHeGhkVzVqYUdRZzdabVk2cks5N0plVUlGQkJWRWpxc0lBZzY3bUk3Slc5N1pXZ0lPeUltQ0Rzbm9qc2xyUWc3S0NJNjR5QTZySzk2NkdjSU95Q3JPeWFxU2tOQ2lBZ0lDQndjbTlqSUQwZ2MzQmhkMjRvY0hKdlkyVnpjeTVsZUdWalVHRjBhQ3dnVzNCaGRHZ3VhbTlwYmloZlgyUnBjbTVoYldVc0lDZGpiR0YxWkdVdFluSnBaR2RsTG1wekp5bGRMQ0I3RFFvZ0lDQWdJQ0JqZDJRNklGSlBUMVFzSUdSbGRHRmphR1ZrT2lCMGNuVmxMQ0J6ZEdScGJ6b2dKMmxuYm05eVpTY3NEUW9nSUNBZ2ZTazdEUW9nSUgwTkNpQWdjSEp2WXk1MWJuSmxaaWdwT3lBdkx5RHFzSkRzaTV6c25wQWc3SjIwNjdLazdZcTRJT3VqcU8yVWhPeVhrT3lFbkNEcnRvVHJwcXdnS09xd2tPeUxuT3lla0NEc29vWHJvNHpycGJ3ZzY2ZUo3S2VBSU95Vml1cXlqQ2tOQ24wTkNnMEtMeThnN0oyMElGQkQ2Nlc4SUNmc2hLVHN1WmdnN0tDRUtPeURpQ0JRUXlrbklPeURnZTJEbk91aG5DRHJrSmpyajR6cnByRHJpNlFnNG9DVUlPMlVqT3Vmck9xM3VPeWR1Q0JiN0xTSTZyaXc3Wm1VWFNEcnNvVHRpcndvVUU5VFZDQXZkVzVwYm5OMFlXeHNLZXlkdENEcnRvRHJwYmpyaTZRdURRb3ZMeUJ5WldkcGMzUmxjaTF3Y205MGIyTnZiQzVxYytxd2dDRHNoS1RzdVpqdGxad2c2cktEN0oyRUlPcTN1T3VNZ091aG5DRHJrSmpyajR6cnByRHJpNlE2SU9xd2tPeUxuT3lla0NEc25wRHJqNW5zaTV6c25wRWdLeUFvN0o2STdKeTg2Nm0wS1NEc2hLVHN1WmdnN1krMDY0MlVMZzBLTHk4ZzRwcWc3N2lQSU91d21PdVRuT3lMbkNCSVZGUlFJT3lka2V1THRleWRoQ0RycUx6c29JQWc2N08wNjRLNElPdVNwQ0R0bUxqc3RwenRsYUFnNnJLRElPS0FsQ0J0WVdOUFV5QnNZWFZ1WTJoamRHd2dZbTl2ZEc5MWRPeWR0Q0RzbmJRZzdaU0U2NkdjN0lTNDdJcWs2Nlc4SU95bWlleUxuQ0Rzb29Ycm80enNpNXp0Z3F3ZzdJaVlJT3llaU91THBDNE5DaTh2SUNBZ0lPcTN1T3VlbU95RW5DRHRqSXpzbmJ3b2NHeHBjM1RDdCt5RXBPeTVtQ0R0ajdUcmpaUXA3SjJFSUd4aGRXNWphR04wYk91enRPdUxwQ0RycUx6c29JQWc3S2VBN0pxMDY0dWtJT0tBbENCaWIyOTBiM1YwN0oyMElPeWFzT3Vtck91bHZDRHNvNzNzbDZ6cmo0UWc3SjZRNjQrWjdJdWM3SjZSN0oyQUlPeWR0T3V2dUNEc2dxenJuYnpzcDRUcmk2UXVEUXBtZFc1amRHbHZiaUIxYm1sdWMzUmhiR3hUWld4bUtDa2dldzBLSUNCamIyNXpkQ0J5WlcxdmRtVmtJRDBnVzEwN0RRb2dJSFJ5ZVNCN0RRb2dJQ0FnYVdZZ0tIQnliMk5sYzNNdWNHeGhkR1p2Y20wZ1BUMDlJQ2RrWVhKM2FXNG5LU0I3RFFvZ0lDQWdJQ0JqYjI1emRDQk1RVUpGVENBOUlDZGpiMjB1WTJ4aGRXUmxZbkpwWkdkbExuZGhkR05vWlhJbk93MEtJQ0FnSUNBZ1kyOXVjM1FnY0d4cGMzUWdQU0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5UR2xpY21GeWVTY3NJQ2RNWVhWdVkyaEJaMlZ1ZEhNbkxDQk1RVUpGVENBcklDY3VjR3hwYzNRbktUc05DaUFnSUNBZ0lHTnZibk4wSUdsdWMzUWdQU0J3WVhSb0xtcHZhVzRvYjNNdWFHOXRaV1JwY2lncExDQW5UR2xpY21GeWVTY3NJQ2RCY0hCc2FXTmhkR2x2YmlCVGRYQndiM0owSnl3Z0owTnNZWFZrWlVKeWFXUm5aU2NwT3cwS0lDQWdJQ0FnZEhKNUlIc2dhV1lnS0daekxtVjRhWE4wYzFONWJtTW9jR3hwYzNRcEtTQjdJR1p6TG5WdWJHbHVhMU41Ym1Nb2NHeHBjM1FwT3lCeVpXMXZkbVZrTG5CMWMyZ29jR3hwYzNRcE95QjlJSDBnWTJGMFkyZ2dLRjlsS1NCN2ZRMEtJQ0FnSUNBZ2RISjVJSHNnYVdZZ0tHWnpMbVY0YVhOMGMxTjVibU1vYVc1emRDa3BJSHNnWm5NdWNtMVRlVzVqS0dsdWMzUXNJSHNnY21WamRYSnphWFpsT2lCMGNuVmxMQ0JtYjNKalpUb2dkSEoxWlNCOUtUc2djbVZ0YjNabFpDNXdkWE5vS0dsdWMzUXBPeUI5SUgwZ1kyRjBZMmdnS0Y5bEtTQjdmUTBLSUNBZ0lDQWdkSEo1SUhzZ2MzQmhkMjVUZVc1aktDZHNZWFZ1WTJoamRHd25MQ0JiSjJKdmIzUnZkWFFuTENBblozVnBMeWNnS3lCd2NtOWpaWE56TG1kbGRIVnBaQ2dwSUNzZ0p5OG5JQ3NnVEVGQ1JVeGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzZ2ZTQmpZWFJqYUNBb1gyVXBJSHQ5RFFvZ0lDQWdJQ0IwY25rZ2V5QnpjR0YzYmxONWJtTW9KMnhoZFc1amFHTjBiQ2NzSUZzbmNtVnRiM1psSnl3Z1RFRkNSVXhkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnlCOUtUc2dmU0JqWVhSamFDQW9YMlVwSUh0OURRb2dJQ0FnZlNCbGJITmxJR2xtSUNod2NtOWpaWE56TG5Cc1lYUm1iM0p0SUQwOVBTQW5kMmx1TXpJbktTQjdEUW9nSUNBZ0lDQjBjbmtnZXlCemNHRjNibE41Ym1Nb0ozSmxaeWNzSUZzblpHVnNaWFJsSnl3Z0owaExRMVZjWEZOdlpuUjNZWEpsWEZ4TmFXTnliM052Wm5SY1hGZHBibVJ2ZDNOY1hFTjFjbkpsYm5SV1pYSnphVzl1WEZ4U2RXNG5MQ0FuTDNZbkxDQW5RMnhoZFdSbFFuSnBaR2RsVjJGMFkyaGxjaWNzSUNjdlppZGRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeUI5S1RzZ2NtVnRiM1psWkM1d2RYTm9LQ2ZzbnBEcmo1bnNpNXpzbnBFb1EyeGhkV1JsUW5KcFpHZGxWMkYwWTJobGNpa25LVHNnZlNCallYUmphQ0FvWDJVcElIdDlEUW9nSUNBZ0lDQjBjbmtnZXlCemNHRjNibE41Ym1Nb0ozSmxaeWNzSUZzblpHVnNaWFJsSnl3Z0owaExRMVZjWEZOdlpuUjNZWEpsWEZ4RGJHRnpjMlZ6WEZ4amJHRjFaR1ZpY21sa1oyVW5MQ0FuTDJZblhTd2dleUJ6ZEdScGJ6b2dKMmxuYm05eVpTY2dmU2s3SUhKbGJXOTJaV1F1Y0hWemFDZ25ZMnhoZFdSbFluSnBaR2RsT2k4dklPdVRzZXVoblNjcE95QjlJR05oZEdOb0lDaGZaU2tnZTMwTkNpQWdJQ0FnSUhSeWVTQjdEUW9nSUNBZ0lDQWdJR052Ym5OMElHbHVjM1FnUFNCd1lYUm9MbXB2YVc0b2NISnZZMlZ6Y3k1bGJuWXVURTlEUVV4QlVGQkVRVlJCSUh4OElIQmhkR2d1YW05cGJpaHZjeTVvYjIxbFpHbHlLQ2tzSUNkQmNIQkVZWFJoSnl3Z0oweHZZMkZzSnlrc0lDZERiR0YxWkdWQ2NtbGtaMlVuS1RzTkNpQWdJQ0FnSUNBZ2FXWWdLR1p6TG1WNGFYTjBjMU41Ym1Nb2FXNXpkQ2twSUhzZ1puTXVjbTFUZVc1aktHbHVjM1FzSUhzZ2NtVmpkWEp6YVhabE9pQjBjblZsTENCbWIzSmpaVG9nZEhKMVpTQjlLVHNnY21WdGIzWmxaQzV3ZFhOb0tHbHVjM1FwT3lCOURRb2dJQ0FnSUNCOUlHTmhkR05vSUNoZlpTa2dlMzBOQ2lBZ0lDQjlEUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSUdaaGFXd3RjMjltZENEaWdKUWc2NnE3SU95bmdPeWF0Q0Rxc293ZzdKNkk3SmEwNjQrRUlPMlVqT3Vmck9xM3VPeWR1Q0RzcXIwZzZyaXc3SmExSU95Q3JleWduT3VLbENEc25iVHJyN2dnNjRHZDY0S3M2NHVrSUNvdklIME5DaUFnY21WMGRYSnVJSEpsYlc5MlpXUTdEUXA5RFFvTkNpOHZJT3F3a095TG5PeWVrQ0RzbnBEc2k2RHNuWVFnN0lPSUlPeTlsT3VUbk91aG5DRHJpNlRzaTV3ZzY1MkU3SnEwNjR1a0lPS0FsQ0JRVDFOVUlDOXlaWE4wWVhKMElPcXdnQ0RydG9EcnBianJpNlF1RFFvdkx5RHNtWndnN1pXRTdKcVU3WldjNnJDQUtESXdNall0TURnZzdJdWs3TGloS1RvZzdJU2s3TG1ZNjdPNElPMk1qT3lkdk95ZHRDRHNnNGpxc29Qc25iVHNsclRyajRRZ0tpcnNtS1RybnBnZzY1YWdJT3llaU91Tm1DRHFzSkRzaTV6c25wRHFzSUFnN0ppYklPeTlsT3VUbk95ZG1DRHJpNlRycHF6cnBid2c2ck9FN0lhTklPeThuT3VLbENvcURRb3ZMeURzZzRIdGc1enFzSUFnN0o2STdKZUk2NHVrS08yTWpPeWR2Q0IyTkRFZ0x5RHN2SnpzcDREcmlwUWc2NHVrNjZhc0lIWXlNaWt1SU95ZHRPdWZyT3VwdENEdGxJenJuNnpxdDdqc25ianNuYlFnVyt5WGhldU5zT3lkdE8yS3VDRHRsWVRzbXBSZDY2R2NJT3VMcE91bXJPdWx2Q0RxdTVEcmk2UWc3THljNjQrRURRb3ZMeURzdkp3ZzdLTzg2NHFVSU95cXZleWR0Q0RxdDdqcmpJRHJvWnpybmJ3ZzdKaUI3SnVRN1o2SUlPeVlteURyc29Uc29JVHNuYlRxczZBc0lPeWVyT3lMbk95ZWtldW5pT3VMcENEc200enJzSTNzbDRVbzZyV3M2NCtGSU95Q3JPeWFxZXVmaVNucnA0d2c2NEtZNnJDVTY0dWtMZzBLTHk4ZzZyZTQ2NTZZN0lTY0lDTHJpNlRycHF6cnA0d2c2cnVRNjR1a0lPeThuT3E0c0NMcm9ad2c3SldJSU8yU2dPdW1yT3VwdENEc3ZKd2c3S084NjRxVUlPcXdrT3lMbk95ZWtPdTJnTzJFc0NEc2c0anJvWndnNjUyRTdKcTA2NHVrTGlEcXNKRHNpNXpzbnBEcmlwUWdZMnhoZFdSbDY2VzhJT3lWaUNEcnJMenNsclFnNjdtRTdKcXBJREF1RFFvdkx5RHNpSnpzaEp3ZzdLTzg3SjJZT2lEc2c0Z2c3SjI0N0lxazdZUzA3SXFrNnJDQUlPdW92T3lnZ0NEcm5LanJxYlFnN1krczdZcTQ2Nlc4SU91cXV5RHNucUhyaXBUcmpiQXNJT3lWaE91ZW1DQnNhWE4wWlc0ZzdKNnM3SXVjNjQrRTZyQ0FJT3lhc091bXJPcXdnQ0RydWFEc3A0Z2c2NVdNNnJtTTdLZUFJT3E0c091THBPdWdwQ0RzcElEcmk2UXVEUXBtZFc1amRHbHZiaUJ5WlhOMFlYSjBVMlZzWmlncElIc05DaUFnZEhKNUlIc05DaUFnSUNCcFppQW9jSEp2WTJWemN5NXdiR0YwWm05eWJTQTlQVDBnSjNkcGJqTXlKeWtnZXcwS0lDQWdJQ0FnWTI5dWMzUWdkbUp6SUQwZ2NHRjBhQzVxYjJsdUtGSlBUMVFzSUNkamJHRjFaR1V0ZDJGMFkyaGxjaTF6YVd4bGJuUXVkbUp6SnlrN0RRb2dJQ0FnSUNCcFppQW9abk11WlhocGMzUnpVM2x1WXloMlluTXBLU0I3RFFvZ0lDQWdJQ0FnSUdOdmJuTjBJSEFnUFNCemNHRjNiaWduZDNOamNtbHdkQzVsZUdVbkxDQmJkbUp6WFN3Z2V5QmtaWFJoWTJobFpEb2dkSEoxWlN3Z2MzUmthVzg2SUNkcFoyNXZjbVVuTENCM2FXNWtiM2R6U0dsa1pUb2dkSEoxWlNCOUtUc05DaUFnSUNBZ0lDQWdjQzUxYm5KbFppZ3BPdzBLSUNBZ0lDQWdmU0JsYkhObElIc05DaUFnSUNBZ0lDQWdMeThnZG1KejZyQ0FJT3lYaHV5Y3ZPdXB0Q0J1YjJSbDY2VzhJT3luZ2V5Z2tTRGlnSlFnN0xDOUlPeVZpQ0RybktqcXNvd2c3WldZNjRxVUlPcTNuT3k1bWV5ZGdDRHJpNlRycHF3ZzdJcWs3WSt3NnJPOElPcXdtZXVMcENoM2FXNWtiM2R6U0dsa1pTd2daR1YwWVdOb1pXUWc2cmlJN0tlQUtRMEtJQ0FnSUNBZ0lDQmpiMjV6ZENCd0lEMGdjM0JoZDI0b2NISnZZMlZ6Y3k1bGVHVmpVR0YwYUN3Z1cxOWZabWxzWlc1aGJXVmRMQ0I3SUhOMFpHbHZPaUFuYVdkdWIzSmxKeXdnZDJsdVpHOTNjMGhwWkdVNklIUnlkV1VnZlNrN0RRb2dJQ0FnSUNBZ0lIQXVkVzV5WldZb0tUc05DaUFnSUNBZ0lIME5DaUFnSUNBZ0lISmxkSFZ5YmpzTkNpQWdJQ0I5RFFvZ0lDQWdMeThnYldGalQxTTZJR3hoZFc1amFHVHFzSUFnN0pxdzY2YXM2Nlc4SU9xMGdPdW1yTzJWbk91THBDRGlnSlFnYTJsamEzTjBZWEowSUMxcjZyQ0FJT3E3a091THBDRHN2SndnN0tTQTY0dWtLT3lhc091bXJPdWx2Q0Rzbzczc25iVHJyNERyb1p3ZzdKV0U2NTZZSUdWNGFYVHF1WXpzcDRBZzdKV0lJT3lZckNEc2lKanJqNFFnN0o2STY0dWtLUTBLSUNBZ0lHTnZibk4wSUhWcFpDQTlJSEJ5YjJObGMzTXVaMlYwZFdsa0tDazdEUW9nSUNBZ1kyOXVjM1FnY2lBOUlITndZWGR1VTNsdVl5Z25iR0YxYm1Ob1kzUnNKeXdnV3lkcmFXTnJjM1JoY25RbkxDQW5MV3NuTENBblozVnBMeWNnS3lCMWFXUWdLeUFuTDJOdmJTNWpiR0YxWkdWaWNtbGtaMlV1ZDJGMFkyaGxjaWRkTENCN0lITjBaR2x2T2lBbmFXZHViM0psSnlCOUtUc05DaUFnSUNCcFppQW9jaTV6ZEdGMGRYTWdJVDA5SURBcElIc05DaUFnSUNBZ0lHTnZibk4wSUhBZ1BTQnpjR0YzYmlod2NtOWpaWE56TG1WNFpXTlFZWFJvTENCYlgxOW1hV3hsYm1GdFpWMHNJSHNnWkdWMFlXTm9aV1E2SUhSeWRXVXNJSE4wWkdsdk9pQW5hV2R1YjNKbEp5QjlLVHNOQ2lBZ0lDQWdJSEF1ZFc1eVpXWW9LVHNOQ2lBZ0lDQjlEUW9nSUgwZ1kyRjBZMmdnS0Y5bEtTQjdJQzhxSUdaaGFXd3RjMjltZENEaWdKUWc2NnE3SU91ZGhPeWJvT3ljdk91cHRDRHJpNlRzbll3ZzY2R2M2cmU0N0oyNElPeWVrT3VQbWV5TG5PeWVrZXlkdENEc2dyVHJwckRyaTZRZ0tpOGdmUTBLZlEwS0RRb3ZMeURyaTZUcnBxd29NVEU0T0RncDZyQ0FJT3VXb0NEc25vanNuTHpycWJRZzY0R0k2NHVrSU9LQWxDRHN0SWpxdUxEdG1aUWc3SXVjSU91Q3FPeWRnQ0RzaExqc2haZ2c3S0NWNjZhc0lDanNsNGJzbkx6cnFiUWc3S0d3N0pxcDdaNklJT3lMcE8yTXFDa05DbVoxYm1OMGFXOXVJSE5vZFhSa2IzZHVRbkpwWkdkbEtDa2dldzBLSUNCMGNua2dldzBLSUNBZ0lHTnZibk4wSUhJZ1BTQm9kSFJ3TG5KbGNYVmxjM1FvZXlCb2IzTjBPaUFuTVRJM0xqQXVNQzR4Snl3Z2NHOXlkRG9nTVRFNE9EZ3NJSEJoZEdnNklDY3ZjMmgxZEdSdmQyNG5MQ0J0WlhSb2IyUTZJQ2RRVDFOVUp5d2dkR2x0Wlc5MWREb2dNVFV3TUNCOUxDQW9LU0E5UGlCN2ZTazdEUW9nSUNBZ2NpNXZiaWduWlhKeWIzSW5MQ0FvS1NBOVBpQjdmU2s3RFFvZ0lDQWdjaTV2YmlnbmRHbHRaVzkxZENjc0lDZ3BJRDArSUhzZ2RISjVJSHNnY2k1a1pYTjBjbTk1S0NrN0lIMGdZMkYwWTJnZ0tGOWxLU0I3ZlNCOUtUc05DaUFnSUNCeUxtVnVaQ2dwT3cwS0lDQjlJR05oZEdOb0lDaGZaU2tnZTMwTkNuME5DZzBLWTI5dWMzUWdjMlZ5ZG1WeUlEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9LSEpsY1N3Z2NtVnpLU0E5UGlCN0RRb2dJR2xtSUNoeVpYRXViV1YwYUc5a0lEMDlQU0FuVDFCVVNVOU9VeWNwSUhzZ2NtVnpMbmR5YVhSbFNHVmhaQ2d5TURRc0lFTlBVbE5mU0VWQlJFVlNVeWs3SUhKbGRIVnliaUJ5WlhNdVpXNWtLQ2s3SUgwTkNpQWdhV1lnS0hKbGNTNTFjbXdnUFQwOUlDY3ZhR1ZoYkhSb0p5a2dldzBLSUNBZ0lDOHZJSFk2SU9xd2tPeUxuT3lla0NEc3ZaVHJrNXdnNjdLRTdLQ0VJT0tBbENEcXRhenJzb1Rzb0lRZzdaU0U2NkdjN0lTNDdJcWs2ckNBSU9xemhPeUdqU0RyajR6cXM2QWc3SjZJNjRxVTdLZUFJT3V3bHV5WGtPeUVuQ0R0bVpYc25ianRsWmpyaXBRZzdKcXA2NCtFRFFvZ0lDQWdMeThnS0hZeUlEMGc3TEM5SU95SXFPcTVnQ0RzaUpqc29KWHRqSkFzSUhZeklEMGdMMkZqWTI5MWJuUWc3TGFVNnJDQTdZeVFMQ0IyTkNBOUlDOTFibWx1YzNSaGJHd2c3TGFVNnJDQTdZeVFMQTBLSUNBZ0lDOHZJQ0IyTlNBOUlPcXpoT3lnbGV5ZGhDRHNucERxc3Fuc3BwM3Jxb1VnN0p5ZzY2eTA2NkdjSU8yTWtPeWdsU0RpZ0pRZzY2R2M2cmU0N0pXRTdKdURJT3VTcENEcmdxanNuWUFnN0oyMDY2bVU3SjI4N0oyRUlPdWhuT3EzdU95ZHVPeWN2T3VobkNEc21LVHRsYlR0bFpqc3A0QWc3SldLNnJLTUxBMEtJQ0FnSUM4dklDQjJOaUE5SU91bnBleWRnQ0RzbnBEcXNxbnNwcDNycW9Yc25iUWc3WUtrN0xLMDdKMjQ3SmVRSU95ZWlPeVd0Q0R0akl6c25id2c2cktBN0lLczY2ZU03Snk4NjZHYzY0cVVJQ2Zyb1p6cXQ3anNuYmdnN0pXSUlPdVFxQ2ZzbmJRZzY1Q1k2NDJZSU9xeWd5RHJqSURzblpFc0RRb2dJQ0FnTHk4Z0lIWTNJRDBnTDNKbGMzUmhjblFnN0xhVTZyQ0FJQ3NnN1krczdZcTRJT3llck95TG5PdVBoQ0RpZ0pRZzdKaWJJT3F3a095TG5PeWVrT3F3Z0NEc21Kc2c2NHVrNjZhczY2VzhJT3F6aE95R2pTRHN2SnpyalpnZzZyS0RJT3VNZ095ZGtTa05DaUFnSUNCeVpYUjFjbTRnYW5OdmJpaHlaWE1zSURJd01Dd2dleUJ2YXpvZ2RISjFaU3dnZDJGMFkyaGxjam9nZEhKMVpTd2dkam9nTnlCOUtUc05DaUFnZlEwS0lDQXZMeURzbmJRZ1VFUHNsNUFnNjZHYzZyZTQ3SjI0NjVDY0lPMkJ0T3Vobk91VG5DRHFzNFRzb0pVZzRvQ1VJTzJVak91ZnJPcTN1T3lkdUNEc3Nxc2c3Wm1VNjZtMHdyZnRtWWpzbmJRZ0l1dUloT3ExckNEcXM0VHNvSlhzbkx6cm9ad2c3Sk93NjRxVTdLZUFJaURyczdUc2w2enNvN3pyaXBRZzY0MndJT3lUdE91THBDNE5DaUFnTHk4ZzZyQ1E3SXVjN0o2UTZyQ0FJT3VMdGUyVm1PdUtsQ0RzbmJUc25LQTZJT3VMcE91bXJPdWx2Q0Rzdkp6cnFiUWc3SnVNNjdDTjdKZUY3Snk4NjZHY0lPMkJ0T3Vobk91VG5PcXdnQ0RzaTZUc29Kd2c3Wmk0N0xhYzY0KzhJT3Exck91UGhTRHNncXpzbXFucm40bnNuYlFnNjRLWTZyQ0U2NHVrTGcwS0lDQXZMeURxc0pEc2k1enNucERyaXBRZzdZeU03SjI4NjZlTUlPeWR2ZXljdk91dmdPdWhuQ0RzZ3F6c21xbnJuNGtnTUNEQ3R5RHJqSURxdUxBZ01DRGlnSlFnNnJLQTdZYWc2NmVNSU95VHNPdUtsQ0RzZ3F6cm5venNsNURxc293ZzY3bUU3SnFwN0oyRUlPdXN2T3Vtck95bmdDRHNsWXJyaXBUcmk2UXVEUW9nSUM4dklPeWp2T3lkbURvZzdKZXM2cml3SU9xemhPeWdsZXlkdENEcnM3VHNsNnpyajRRZzdKNkY3SjZsNnJhTTdKMjBJT3Vuak91ampPdVFrT3lkaENEc2lKZ2c3SjZJNjR1a0tPeWNvTzJhcU95RXNleWRnQ0RzaTZUc29Kd2c3Wmk0N0xhY0lPdVZqT3VuakNEc2xZd2c3SWlZSU95ZWlPeWRqQ0RpZ0pRZzY0dWs2NmFzSUM5b1pXRnNkR2pzblpnZ2NISnZZbXhsYlNEc3NManFzNkFwTGcwS0lDQnBaaUFvY21WeExuVnliQ0E5UFQwZ0p5OWhZMk52ZFc1MEp5a2dldzBLSUNBZ0lISmxkSFZ5YmlCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsTENCaFkyTnZkVzUwT2lCamJHRjFaR1ZCWTJOdmRXNTBLQ2tzSUdOc1lYVmtaVG9nYUdGelEyeGhkV1JsS0NrZ2ZTazdEUW9nSUgwTkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzZGhhMlVuS1NCN0RRb2dJQ0FnYVdZZ0tDRm9ZWE5EYkdGMVpHVW9LU2tnY21WMGRYSnVJR3B6YjI0b2NtVnpMQ0F5TURBc0lIc2diMnM2SUdaaGJITmxMQ0J3Y205aWJHVnRPaUFuWTJ4aGRXUmxMVzFwYzNOcGJtY25JSDBwT3cwS0lDQWdJSGRoYTJWQ2NtbGtaMlVvS1RzTkNpQWdJQ0J5WlhSMWNtNGdhbk52YmloeVpYTXNJREl3TUN3Z2V5QnZhem9nZEhKMVpTd2dkMkZyYVc1bk9pQjBjblZsSUgwcE93MEtJQ0I5RFFvZ0lHbG1JQ2h5WlhFdWJXVjBhRzlrSUQwOVBTQW5VRTlUVkNjZ0ppWWdjbVZ4TG5WeWJDQTlQVDBnSnk5emFIVjBaRzkzYmljcElIc05DaUFnSUNCcWMyOXVLSEpsY3l3Z01qQXdMQ0I3SUc5ck9pQjBjblZsSUgwcE93MEtJQ0FnSUhObGRGUnBiV1Z2ZFhRb0tDa2dQVDRnY0hKdlkyVnpjeTVsZUdsMEtEQXBMQ0F5TURBcE93MEtJQ0FnSUhKbGRIVnlianNOQ2lBZ2ZRMEtJQ0F2THlEcXNKRHNpNXpzbnBEcnBid2c3SU9JSU95OWxPdVRuT3VobkNEcmk2VHNpNXdnNjUyRTdKcTA2NHVrSU9LQWxDRHJpNlRycHF6cnBid2c2cnVRNjR1a0lPeThuT3VQaENEcXM0VHNobzBnN0ppYklPdXloT3lnaE95ZHRDRHN2SnpzcDRnZzY1V01LT3ljaENCeVpYTjBZWEowVTJWc1ppRHNvN3pzaEowcElPeVR0T3VMcEM0TkNpQWdMeThnN0oyUjY0dTE3SjJFSU91b3ZPeWdnQ0RyczdUcmdyZ2c2NUtrSU95RGlDRHNuYmpzaXFUdGhMVHNpcVRycGJ3ZzY1MkU3SnF3NnJPZ0lPeWFzT3Vtck91S2xDRHJ1YURzcDRUcmk2UWc0b0NVSU95RGlDRHNxcjNzbllBZzdZK3M3WXE0NnJDQUlPdTVqQ0RybFl6cXVZenNwNEFnN0o2czdJdWM2NCtFN1pXYzY0dWtMZzBLSUNCcFppQW9jbVZ4TG0xbGRHaHZaQ0E5UFQwZ0oxQlBVMVFuSUNZbUlISmxjUzUxY213Z1BUMDlJQ2N2Y21WemRHRnlkQ2NwSUhzTkNpQWdJQ0JxYzI5dUtISmxjeXdnTWpBd0xDQjdJRzlyT2lCMGNuVmxMQ0J5WlhOMFlYSjBhVzVuT2lCMGNuVmxMQ0IyT2lBM0lIMHBPdzBLSUNBZ0lITmxkRlJwYldWdmRYUW9LQ2tnUFQ0Z2V3MEtJQ0FnSUNBZ2MyaDFkR1J2ZDI1Q2NtbGtaMlVvS1RzZ0x5OGc3SmliSU95OWxPdVRuT3VobkNEcmxxQWc3SjZJNjRxVUlPdUxwT3Vtck91UGhDRHFzSm5zbmJRZzY0SzA2NmF3NjR1a0lPS0FsQ0RyaTZUc25Zd2c3SnFVN0xLdElPdVZqQ0RzZzRnZzZyQ1E3SXVjN0o2UTZyQ0FJT3lEaUNEc3ZaVHJrNXpyb1p3ZzdMeWc2NHVrRFFvZ0lDQWdJQ0J5WlhOMFlYSjBVMlZzWmlncE93MEtJQ0FnSUNBZ2MyVjBWR2x0Wlc5MWRDZ29LU0E5UGlCd2NtOWpaWE56TG1WNGFYUW9NQ2tzSURNd01DazdEUW9nSUNBZ2ZTd2dNakF3S1RzTkNpQWdJQ0J5WlhSMWNtNDdEUW9nSUgwTkNpQWdMeThnN0xTSTZyaXc3Wm1VSU9LQWxDRHNuYlFnVUVQcnBid2dKK3lEaUNCUVF5Y2c3SU9CN1lPYzY2R2NJT3VRbU91UGpPdW1zT3VMcENBbzdaU002NStzNnJlNDdKMjRJRnZzdElqcXVMRHRtWlJkSU91eWhPMkt2Q2t1RFFvZ0lDOHZJT3lka2V1THRleWRoQ0RycUx6c29JQWc3WjJZNjZDazY3TzA2NEs0SU91U3BDRHNvSlhycHF6dGxaenJpNlFnNG9DVUlHSnZiM1J2ZFhUc25iUWc3SnF3NjZhczY2VzhJT3ltaWV5TG5DRHNvNzNzbDZ6cmo0UWc3WnFNN0l1ZzdKMkFJT3VQaE95d3FlMlZuT3VMcEM0TkNpQWdhV1lnS0hKbGNTNXRaWFJvYjJRZ1BUMDlJQ2RRVDFOVUp5QW1KaUJ5WlhFdWRYSnNJRDA5UFNBbkwzVnVhVzV6ZEdGc2JDY3BJSHNOQ2lBZ0lDQnFjMjl1S0hKbGN5d2dNakF3TENCN0lHOXJPaUIwY25WbExDQndiR0YwWm05eWJUb2djSEp2WTJWemN5NXdiR0YwWm05eWJTQjlLVHNOQ2lBZ0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lIc05DaUFnSUNBZ0lITm9kWFJrYjNkdVFuSnBaR2RsS0NrN0RRb2dJQ0FnSUNCamIyNXpkQ0J5WlcxdmRtVmtJRDBnZFc1cGJuTjBZV3hzVTJWc1ppZ3BPdzBLSUNBZ0lDQWdZMjl1YzI5c1pTNXNiMmNvSjF0M1lYUmphR1Z5WFNEc3RJanF1TER0bVpRb2RXNXBibk4wWVd4c0tTRGlnSlFnN0tDYzZyR3dPaWNzSUhKbGJXOTJaV1F1YW05cGJpZ25MQ0FuS1NCOGZDQW5LT3lYaHV5ZGpDa25LVHNOQ2lBZ0lDQWdJSE5sZEZScGJXVnZkWFFvS0NrZ1BUNGdjSEp2WTJWemN5NWxlR2wwS0RBcExDQXlNREFwT3cwS0lDQWdJSDBzSURJMU1DazdEUW9nSUNBZ2NtVjBkWEp1T3cwS0lDQjlEUW9nSUhKbGRIVnliaUJxYzI5dUtISmxjeXdnTkRBMExDQjdJR1Z5Y205eU9pQW5UbTkwSUdadmRXNWtKeUI5S1RzTkNuMHBPdzBLRFFvdkx5RHRqNnp0aXJqcXNJQWc3SjZoN1ppQUlPeWVpT3ljdk91cHRDRHNucURxdVpBZzZyaXc2NHVrNjZDNDY0dWtJT3VMcE95TG5DRHNpNXpyajRUdGxaanFzNkFzSU9xM3VPdWVtT3VQaENEc2xZZ2c2NUNZNjZtMElPeWhzT3lhcWUyZWlDRHNvb1hybzR3TkNpOHZJQ2pzbnBEcmo1a2c3SXVjN0o2UklDc2dibkJ0SUdKMWFXeGtJT3lra2V1enRTRHNpNlR0bG9rZzY0eUE2N21FS1M0ZzdKNnM3SXVjNjQrRTZyQ0FJTzJWaE95YWxPMlZuQ0RzbmJUc25LQTZJQzl5WlhOMFlYSjA2NHFVSU95RGlDRHNuYmpzaXFUdGhMVHNpcVRycGJ3ZzY2aTg3S0NBSU91ZGhPeWFzT3F6b0EwS0x5OGc3SmliSU95ZHVPeUtwTzJFdE95S3BPcXdnQ0RydWFEc3A0RHJyNERyb1p3c0lPeXlxeURzaTV6cmo0VHNsNURzaEp3ZzY2eTg2NStzNjRLWUlPdXloT3Vtck91cHRDRHNsWVRyckxUcmo0UWc3SldJSU91Q3FPdUtsT3VMcEM0TkNteGxkQ0JpYVc1a1ZISnBaWE1nUFNBd093MEtjMlZ5ZG1WeUxtOXVLQ2RsY25KdmNpY3NJQ2hsS1NBOVBpQjdEUW9nSUdsbUlDaGxJQ1ltSUdVdVkyOWtaU0E5UFQwZ0owVkJSRVJTU1U1VlUwVW5JQ1ltSUdKcGJtUlVjbWxsY3lBOElEWXBJSHNOQ2lBZ0lDQmlhVzVrVkhKcFpYTXJLenNOQ2lBZ0lDQnpaWFJVYVcxbGIzVjBLQ2dwSUQwK0lITmxjblpsY2k1c2FYTjBaVzRvVUU5U1ZDd2dKekV5Tnk0d0xqQXVNU2NwTENBeE1EQXdLVHNOQ2lBZ0lDQnlaWFIxY200N0RRb2dJSDBOQ2lBZ2FXWWdLR1VnSmlZZ1pTNWpiMlJsSUQwOVBTQW5SVUZFUkZKSlRsVlRSU2NwSUhCeWIyTmxjM011WlhocGRDZ3dLVHNOQ2lBZ2NISnZZMlZ6Y3k1bGVHbDBLREVwT3cwS2ZTazdEUXB6WlhKMlpYSXViR2x6ZEdWdUtGQlBVbFFzSUNjeE1qY3VNQzR3TGpFbkxDQW9LU0E5UGlCN0RRb2dJR052Ym5OdmJHVXViRzluS0NkYmQyRjBZMmhsY2wwZzdZRzA2NkdjNjVPY0lPdUxwT3VtckNEcXNKRHNpNXpzbnBBZzdMeWM3S2VRSU9LQWxDQm9kSFJ3T2k4dmJHOWpZV3hvYjNOME9pY2dLeUJRVDFKVUtUc05DbjBwT3cwS0x5OGdTVkIyTmlEcm82anRsSVRyc0xFb09qb3hLZXlYa091UGhDRHRsYWpxdTVnZzY1T2o2NHFVNjR1a0lPS0FsQ0FuYkc5allXeG9iM04wSitxd2dDQTZPakhyb1p3ZzY2aTg3S0NBSU8yVnRPeUVuZXVRbU91S2xDRHRtWmpxc3Izc2w1RHNoSndOQ2k4dklPMlV2T3EzdU91bmlDQm1aWFJqYU9xd2dDQkpVSFkwNjZHY0lPMlB0T3V3c2UyVm1PeW5nQ0RzbFlyc2xZUWc2NHVrNjZhc0lPcTVxT3lhc09xNHNNSzM2ck9FN0tDVklPeWhzTzJhak9xd2dDRHNvYkRzbXFudG5vZ2c3SXVrN1l5bzdaV1k2NDJZSU91c3VPeWduQ0RyaklEc25aRW82NHVrNjZhczdKbUFJT3VQbWV5ZHZDa3VEUXBqYjI1emRDQnpaWEoyWlhJMklEMGdhSFIwY0M1amNtVmhkR1ZUWlhKMlpYSW9jMlZ5ZG1WeUxteHBjM1JsYm1WeWN5Z25jbVZ4ZFdWemRDY3BXekJkS1RzTkNpOHZJRG82TWV5ZGhDRHJxcnNnN0o2aDdKV0U2NCtFS0VWQlJFUlNTVTVWVTBYQ3QwbFFkallnN0plRzdKMk1LU0JKVUhZMDY2ZU03Snk4NjZHY0lPcXpoT3lHalNEcmo1bnNucEVnNG9DVUlPdUxwT3VuakNBdmNtVnpkR0Z5ZENEc3A0SHRtNFRzbDVRZzdKaWJJT3lkdU95S3BPMkV0T3lLcE9xd2dBMEtMeThnN0pXRTdLZUJJRG82TWV5ZGhDRHJyTHpxczZBZzdKNkk3SmEwSU95eXF5RHNpNXpyajRUcXNJQWc3SXVrN1l5bzdaV2M2NHVrTGlBbmJHOWpZV3hvYjNOMEorcXdnQ0E2T2pIcm9ad2c2Nmk4N0tDQUlPMlNnT3Vtck91S2xDRHRtWmpxc3Izc2w1RHNoSndnNnJlNDY0eUE2NkdjSU91UmtPdXB0QTBLTHk4ZzdaUzg2cmU0NjZlSUlHWmxkR05vNnJDQUlPeWhzT3lhcWUyZWlDRHNpNlR0aktqdGxaanJyNERyb1p3Z1NWQjJOT3laZ0NEcXNKbnNuWUFnN1pxZjdJaVk2NmVNN1lHOElPeWVyT3lMbk91UGhPMlZuT3VMcEM0TkNteGxkQ0JpYVc1a1ZISnBaWE0ySUQwZ01Ec05Dbk5sY25abGNqWXViMjRvSjJWeWNtOXlKeXdnS0dVcElEMCtJSHNOQ2lBZ2FXWWdLR1VnSmlZZ1pTNWpiMlJsSUQwOVBTQW5SVUZFUkZKSlRsVlRSU2NnSmlZZ1ltbHVaRlJ5YVdWek5pQThJRFlwSUhzTkNpQWdJQ0JpYVc1a1ZISnBaWE0yS3lzN0RRb2dJQ0FnYzJWMFZHbHRaVzkxZENnb0tTQTlQaUJ6WlhKMlpYSTJMbXhwYzNSbGJpaFFUMUpVTENBbk9qb3hKeWtzSURFd01EQXBPdzBLSUNCOURRcDlLVHNOQ25ObGNuWmxjall1YkdsemRHVnVLRkJQVWxRc0lDYzZPakVuS1RzTkNnPT0nCkI2NF9FWEFNUExFUz0nSXlEcnJManF0YXdnN0xhVTdMS2NJT3lZaU95TG5Bb0tJdXVzdU9xMXJDRHN0cFRzc3B6cnNKdnF1TEFpNnJDQUlPeUNyT3lhcWUyVm1PdUtsQ0RzbUlqc2k1d2c2NnFvN0oyTTdKNkY2NHVJNjR1a0xpQXFLdXlkdENEdGpJenNuYnpzbllRZzdJaVk3S0NWN1pXY0lPdVNwQ0R0aExEcnI3anJoSkRzbDVEc2hKd2dZRzV3YlNCeWRXNGdZblZwYkdSZzY2VzhJT3lMcE8yV2llMlZtT3F6b0N3Z1JtbG5iV0hzbDVEc2hKd2c3WlNNNjUrczZyZTQ3SjI0N0oyRUlPdUxwT3lMbkNEc2k2VHRsb250bFpqcnFiUWc2N0NZN0ppQjY1Q3A2NHVJNjR1a0xpb3FDZ29qSXlEc25wSHNoTEVnNjdDcDY3S1ZDZ290SU95WWlPeUxuQ0R0bFpqcmdwanJpcFFnS2lwZ0l5TWpJT3lia091enVHQXFLaUR0bFp3ZzdLU0U2ck84TENEcXQ3Z2c3SldFNjU2WUlDb3FZQzBnN0xhVTdMS2M3SldJWUNvcUlPeVhyT3VmckNEcXNKenJvWndnN0oyMDY2U0U3S2VSNjR1STY0dWtMZ290SU95MmxPeXluT3lWaUNEc2xZanNsNURzaEp3Z0tpcnNwSVRzbllRZzY3Q1U2cjY0NnJPZ0lPeUx0dXljdk91cHRDQmdJQzhnWUNBbzdKV2U2NUtrSU9xenRldXdzU0R0ajZ6dGxhZ2c3SXFzNjU2WTdJdWNLU29xSU91aG5DRHRrWnpzaTV6dGxaanNoTGpzbXBRdUlPMlVqT3Vmck9xM3VPeWR1T3lYa095RW5DRHJrWkFnN0tTRTY2R2NJT3V6dE95WHJPeW5rZXVMaU91THBDNEtMU0RzZ3F6c21xbnNucERxc0lBZzdKNkY2NkNsN1pXY0lPdXN1T3Exck9xd2dDQmc3SnVRNjdPNFlPcXp2Q0FvNnJPMTY3Q3h3cmZyckxqc25xWHJ0b0R0bUxnZzY2eTA3SXVjN1pXWTZyT2dLU0Rxc0pucXNiRHJncGdzSU95RW5PdWhuQ0R0ajZ6dGxhanRsWmpycWJRZzZyZTRJT3kybE95eW5PeVZpT3VUcE95ZGhDRHJzN1RzbDZ6c3BJM3JpNGpyaTZRdUNpMGc2NmVrN0xtdDdaV2dJT3VWakNBcUt1dW5pT3lLcE8yQ3VldVFuQ0RzbmJUcnBvUW83Wm1OWENycmo1a3BMQ0RzaUt2c25wQW83S0NFN1ptVTY3S0k3Wmk0d3JjaTdKbTRJRExycW9VaUlPdVRzU25yaXBRZzY2eTA3SXVjS2lydGxhbnJpNGpyaTZRZzRvQ1VJT3lkdE91bWhNSzM3SWlZNjUrSndyZnJzb2p0bUxqcnA0d2c2NHVrNjZXNElPdXN1T3Exck91UGhDRHFzSm5zbllBZzdKaUk3SXVjNjZHY0lPeWVvZTJZZ095YWxDNGc2NHVvTENEc3RwVHNzcHpzbFlqc2w1QWc3S0NCN0phMDY1R1VJT3lkdE91bWhNSzM3SWlyN0o2UTY0cVVJT3EzdU91TWdPdWhuQ0RyZ3Bqc21LVHJpNGdnN0l1azdLQ2NJT3F3a3V5WGtDRHJwNTdxc293ZzZyT2c3TE9RSU95VHNPeUV1T3lhbEM0S0xTRHNvSnpycXFrb1lDTWpZQ25xczd3Z1lDTWpJMkFzSUdBdFlDRHF1TER0bUxqcmlwUWc3WmlWN0l1ZDdKMjA2NHVJSU91d2xPcSt1T3luZ0NEcnA0anNoTGpzbXBRdUNnb2pJeURzaXFUdGc0RHNuYndnN0p1UTdMbVpJQ2pzc0xqcXM2QWc0b0NVSU95ZWtPeUV1TzJWbkNEcmdyVHNtcW5zbllBZ2RYZ3RkM0pwZEdsdVp5NXRaQ0Rxc0lEc25iVHJrNXdwQ2dvdElPMlZ0T3lhbE95eXRDd2c2N2FBNjVPYzY1K3M3SnEwSU95aWhlcXlzQ2hnZnV5ZWlPeVd0T3lhbEdBZ1lIN3JqN3pzbXBSZ0lHQis3SmVHN0phMDdKcVVZQ0JnZnUyVnRDRHNvN3pzaExqc21wUmdLUW90SURMcmk2Z2c2cldzN0tHd09pQXFLdXl5cXlEc3BJUTk3SU9CN1ptcElPeUVwT3VxaFNEaWhwSWc2NUdZN0tlNElPeWtoRDNyaTZUc25Zd2c3WmFKNjQrWktpb282ckt3N0tDVjdKMkFJR0IrN1pXZzZybU03SnFVUDJBc0lPMldpZXVQbVNEc25LRHJqNFRyaXBRZ1lIN3RsYlFnN0tPODdJUzQ3SnFVWUNrS0xTRHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdLT3VRa095V3RPeWFsT0tHa3UyV2lPeVd0T3lhbENrc0lPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQW83SmVHN0phMDdKcVU0b2FTZnUyVm1PdXB0Q0R0bGFBZzdJaVlJT3llaU95V3RPeWFsQ2tLTFNEc3VwRHNvN3pzbHJ6dGxad2c2cks5N0phMEtIN3NpNXpxc3FEc2xyVHNtcFEvNG9hU2Z1MlZvT3E1ak95YWxEOHBMQ0RycW9Yc2dxd3I2NnFGN0lLc0lPMlNnT3lXdE95VHNPcTRzQ2pzbnBUc2xhRWc2N2FBN0tHeDdKeTg2NkdjNG9hUzdKNlU3SldoN0oyMElPdTJnT3loc2UyVnRPeUVuQ2tLTFNEcXNJVHFzckR0bFpqcXM2QWc3SW1zN0pxMElPdW5rQ0FvN0tDRTdJYWg0b2FTNjdPMDY0SzA2NHVrS1N3ZzY3YUE3S0NWSU95RGdlMlpxZXVQaENEcmxMSHJsTEh0bFpqc3A0QWc3SldLNnJLTUtDTHNzTDdxdUxBZzdJdWs3WXlvSXVLZGpDQWk3TEMrN0oyRUlPeUltQ0RzbDRic2xyVHNtcFFpNHB5RktRb0tJeU1nN0xhVTdMS2NJT3lZaU95TG5Bb0tJeU1qSU95bmhPMldpZTJWbU91Tm1DRHNucEhzbDRYc25iUWc3SjZJN0lxMTY0dUk2NHVrTGlEcXM0VHNobzN0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdLZUU3WmFKSU95a2tleWR1Q0RyZ3JUc2w2M3NuYlFnN0o2STdKYTA3SnFVTGlBdklPeWR0T3lXdE95RW5DRHNwNFR0bG9udGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJPMTdKeWdJT3lhbE95eXJleWRoQ0RzdDZqc2hvenRsWmpycWJRZzdKcVU3TEt0SU91Q3RPeVhyZXlkdENEc2dxM3NvSnpya0tucmk0anJpNlF1SU95M3FPeUdqTzJWbU95TG5PcXlvT3lLdGV1TGlPcTVqRDhLTFNEc3Q2anNob3p0bGFBZzZySzk3SnF3SU95YWxPeXlyU0RyZ3JUc2w2M3JqNFFnN0lLdDdLQ2M2NCs4N0pxVUxpQXZJT3F6dGV5Y29DRHNtcFRzc3Ezc25ZUWc3TGVvN0lhTTdaV2c2cm1NN0pxVVB3b0tJeU1qSU9xNHNPcTRzT3VsdkNEc3NMN3NwNEFnNjZxNzdaYUk3SXExNjR1STY0dWtMaUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WldZN0lTNDdKcVVMZ290SU9xNHNPcTRzT3VsdkNEc3NMN3NuWVFnN0lpWUlPeVhodXlXdE95YWxDNGdMeUJSVXV5OWxPdVRuT3VsdkNEcmk2VHNpNXdnN0lxazdMcVU3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXWTZyaXdJT3lnaE95WGtPdUtsQ0Rxc0lEc25vWHRsYUFnN0lpWUlPeVhodXlXdE95YWxBb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bGJUc2xid2c2ckNBN0o2RjdaV2dJT3lJbUNEc25vanNsclRzbXBRdUNnb2pJeU1nN0tlQTZyaUlJT3V5aE95Z2hPeVhrT3lFbk91S2xDRHNrN2dnN0lpWUlPeVhodXlXdE95YWxDNGc3SU9kN0xLMElPeWR1T3ltbmV5ZGhDRHNrN0Ryb0tUcnFiUWc3Sld4N0oyRUlPeTFuT3lMb0NEcnNvVHNvSVRzbkx6cm9ad2c3SmVGNjQydzdKMjA3WXE0SU8yVnRPeWp2T3lFdU95YWxDNEtMU0RzbGJIc25ZUWc3SmVGNjQydzdKMjA3WXE0N1pXMElPeWp2T3lFdU95YWxDNGdMeURzZzUzc3NyUWc3SjI0N0thZDdKMkVJT3lUc091Z3BPdXB0Q0RzdFp6c2k2QWc2N0tFN0tDRTdKMjBJTzJWaE95YWxPMlZ0T3lhbEM0S0NpTWpJeURzbHJUcmxxUWc2NnFwN0tDQjdKeTg2NkdjSU91TWdPeTJuT3V3bSt5Y3ZPeUxuT3VDbU95YWxEOEtMU0RyaklEc3Rwd2c2NnFwN0tDQjdKMjBJT3VzdE95WGgreWR1T3F3Z095YWxEOEtDaU1qSXlEc2xyVHJscVFnN0oyMDdKeWc2NkdjSU95TG9PcXpvTzJWbU95TG5PdUNtT3lhbEQ4S0xTRHNpNkRxczZBZzdKMjA3SnlnNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKNlU3SldoSU91MmdPeWhzZXljdk91aG5DRHF0YXpycDZUdGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUNpMGc3SjZVN0pXaDdKMjBJT3UyZ095aHNlMlZ0T3lFbkNEcXRhenJwNlR0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGdvS0l5TWpJTzJaalNycmo1a29NREV3TFRFeU16UXROVFkzT0NrZzdKbTRJRExycW9Yc2w1RHFzb3dnNnJhTTdaV2NJT3lDcmV5Z25DRHNsWXpycHJ6dGhxSHNuWVFnN0tDRTdJYWg3WldnNnJtTTdKcVVQd290SU9xMmpPMlZuQ0RzZ3Ezc29Kd2c3SldNNjZhODdZYWg3SjJFSU91enRPdUN0T3VncE9xem9DRHRsYlRzbXBRdUlDOGc3Wm1OS3V1UG1TZ3dNVEF0TVRJek5DMDFOamM0S1NEcmk1Z2c3Sm00SURMcnFvWHNsNURxc293ZzY3TzA2NEs4NnJtTTdKcVVQd290SU8yWmpTcnJqNWtvTURFd0xURXlNelF0TlRZM09Da2c2NHVZSU95WnVDQXk2NnFGN0plUTZyS01JT3Eyak8yVm5DRHNncTNzb0p3ZzdKV002NmE4N1lhaDdKMkVJT3V6dE91Q3ZPcTVqT3lhbEQ4S0xTRHF0b3p0bFp3ZzdJS3Q3S0NjSU95VmpPdW12TzJHb2V5ZGhDRHRtWTBxNjQrWktEQXhNQzB4TWpNMExUVTJOemdwSU91TG1DRHNtYmdnTXV1cWhleVhrT3F5akNEcnM3VHJncnpxdVl6c21wUS9DZ29qSXlNaklPMlpsZXlkdU1LMzZyS3c3S0NWSU8yTW5leVhoUW9LSXlNaklPeWdsZXVua0NEc2dxM3NvSnp0bFpqc2k1enFzcURzaXJYcmk0anF1WXcvSU95Q3JleWduT3VRbkNEcmpiRHNuYlR0aExEcmlwUWc2N08xNnJXczdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnN0lLdDdLQ2M3WldZNjZtMElPdUxwT3lMbkNEcmtKanJqNHpycHJRZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc29KWHJwNUFnN0lLdDdLQ2M3WldnNnJtTTdKcVVQd29LSXlNaklPdXpnT3F5dmV5Q3JPMlZyZXlkdENEc29JRHNucVhya0pqc3A0QWc3SldLN0pXWTdJcTE2NHVJNjR1a0xpRHJncGpxc0lEc2k1enFzcURzaXJYcmk0anF1WXcvQ2kwZzdKV0U3S2VCSU95Z2dPeWVwZTJWbU95bmdDRHNsWXJzbllBZzY0SzA3SnFwN0oyMElPeWVpT3lXdE95YWxDNGdMeURzb0lEc25xWHRsWmpzcDRBZzdKV0s2ck9nSU91Q21PcXdpT3E1ak95YWxEOEtDaU1qSXlEcm9aenF0N2pzbFlUc200TWc3WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU91aG5PcTN1T3lWaE95YmcrMlZvT3E1ak95YWxEOEtDaU1qSXlEc2xiSHNuWVFnN0tLRjY2T003WldZN0l1YzZyS2c3SXExNjR1STZybU1Qd290SU95VnNleWRoQ0Rzb29Ycm80enRsYURxdVl6c21wUS9DZ29qSXlNZzdaV2NJT3V5aUNEcnM0RHFzcjN0bFpqcnFiUWc2NHVrN0l1Y0lPdXpnT3F5dmUyVm9DRHNpSmdnN0plRzdJcTE2NHVJNjR1a0xpRHFzNFRzaG8zdGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc3WldjSU91eWlDRHJzSlRxdnJqcnFiUWc2NHVrN0l1Y0lPdXdsT3EvZ0NEc2lKZ2c3SmVHN0phMDdKcVVMaUF2SU9xemhPeUdqZTJWb09xNWpPeWFsRDhLQ2lNakl5RHNub1hyb0tYdGxad2c2NEswN0pxcDdKMjBJT3VxcU91UmtDRHNncTNzb0p6cmtLbnJpNGpyaTZRdUlPeTBpT3E0c08yWmxPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Rzbm9Ycm9LWHRsWndnNjRLMDdKcXA3SjIwSU91cXFPdVJrQ0RzZ3Ezc29KenJqN3pzbXBRdUlDOGc3TFNJNnJpdzdabVU3WldnNnJtTTdKcVVQd29LSXlNakl5RHNsNURybjZ6Q3QreUxwTzJNcUFvS0l5TWpJT3VFcE8yS3VPeWJqTzJCckNEc2w3RHFzckRzbDVBZzdJdWs3WXlvN1phSTdJcTE2NHVJNjR1a0xpRHJpNlRzaTV3ZzdJdWM2NCtFN1pXWTdJdXQ3SXVjN0ppa0xnb3RJT3VFcE8yS3VPeWJqTzJCck95WGtDRHNsN0Rxc3JEdGxhQWc3SWlZSU95WGh1eVd0T3lhbEM0Z0x5RHNsN0Rxc3JBZzdJT0I3WU9jNjZXOElPMlpsZXlkdU8yVm1PcXpvQ0RyaTZUc2k1d2c3SXVjNjQrRTdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYnpzaTV6c29JSHNuYmdnN0ppazY2V1k2ckNBSU91d25PeURuZTJXaU95S3RldUxpT3VMcEM0ZzdKNmc3SXVjSU8yYmhDRHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEc25ienNpNXpzb0lIc25iZ2c3SmlrNjZXWTZyQ0FJT3lEbmVxeXZPeVd0T3lhbEM0Z0x5RHNucURzaTV3ZzdadUVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeVZoT3lkdE91VWxDRHJtSkRyaXBRZzY3bUU2N0NBNjdLSTdaaTQ2ckNBSU95ZHZPeTVtTzJWbU95bmdDRHNsWXJzaXJYcmk0anJpNlF1Q2kwZzdKV0U3SjIwNjVTVUlPdVlrT3VLbENEcnVZVHJzSURyc29qdG1ManFzSUFnNjZlZTdLZUFJT3lWaXV5VmhPeWFsQzRnTHlEcmk2VHNpNXdnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJqc3BwM3Jzb2p0bUxqcXNJQWc3SjI4N0xtWTdaV1k3S2VBSU95Vml1eUt0ZXVMaU91THBDNEtMU0RzbmJqc3BwM3Jzb2p0bUxqcXNJQWc2NmVlN0tlQUlPeVZpdXlWaE95YWxDNGdMeURyaTZUc2k1d2c3SjZGNjZDbDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeTBpT3F6dk91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0oyNDdLYWQ2N0tJN1ppNDY2VzhJT3llck91d25PeUdvZTJWbU95THJleUxuT3lZcEM0S0xTRHNuYmpzcHAwZzdJdWM2ckNFN0oyMElPeW5nT3VDck95V3RPeWFsQzRnTHlEc25ianNwcDNyc29qdG1ManJwYndnNjR1azdJdWNJT3V3bSt5VmhDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyS0E3SU9KSU9xeXNPcXp2T3F3Z0NEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLQTdJT0pJT3F5c09xenZPcXdnQ0RzbDRic2xyVHNtcFF1SUM4ZzY0dWs2Nlc0SU9xeWdPeURpZXlXdE91aG5DRHJpNlRzaTV3ZzdMQys3SldFNjdPMDdJUzQ3SnFVTGdvS0l5TWpJT3lnbGV1enRPdWx2Q0RydG9qcm42enNtS1RzcDRBZzY2cTc3WmFJN0lxMTY0dUk2NHVrTGlEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUxyZXlMbk95WXBDNEtMU0Rzb0pYcnM3VHJwYndnNjdhSTY1K3M3SmlzSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeUR0akl6c25id2c3SmVGNjZHYzY1T2M3SmVRSU95THBPMk1xTzJXaU95S3RldUxpT3VMcEM0S0xTRHRqSXpzbmJ6c25ZUWc3SmlzNjZhczdLZUFJT3VxdSsyV2lPeVd0T3lhbEM0Z0x5RHJpNlRzaTV3ZzdJdWM2NCtFN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2hKenJ1WVRzaXFRZzdLQ1E2cktBSU95a2tleWVoZXVMaU91THBDNGc3SjIwN0pxcDdKZVFJT3UyaU8yT3VPeWRoQ0RyazV6cm9LUWc3S09FN0lhaDdaV3A2NHVJNjR1a0xnb3RJT3luZ09xNGlPeWRnQ0RzaEp6cnVZVHNpcVRycGJ3ZzdLQ1E2cktBN1pXWTZyT2dJT3llaU95V3RPeWFsQzRnTHlEc29KRHFzb0RzbmJRZzY0R2Q2NEtZNjZtMElPdUxwT3lMbkNEc25iVHNtcW50bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHRsWVRzaUpnZzdKNkY2NkNsSU8yVnJldXFxZXllaGV1TGlPdUxwQzRLTFNEcXZLMGc3SjZGNjZDbDdaVzA3Slc4SU8yVm1PdUtsQ0R0bGEzcnFxbnNuYlRzbDVEc21wUXVDZ29qSXlNaklPcTJqTzJWbk1LMzdJU2s3S0NWQ2dvakl5TWc3TG0wNjZtVTY1MjhJT3lna2VxM3ZDRHF0b3p0bFp6c25iUWc3SmVHN0lxMTY0dUk2NHVrTGlEc2hLVHNvSlhzbDVEc2hKd2c2cmFNN1pXYzdKMkVJTzJYaU95YXFlMlZtT3lMcmV5TG5PeVlwQzRLTFNEc3ViVHJxWlRybmJ3ZzZyYU03WldjN0oyMElPMlZoT3lhbE8yVnRPeWFsQzRnTHlEc2hLVHNvSlhzbDVEc2hKd2c3TG0wNjZtVTY1MjhJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lWak91bXZDRHF0b3p0bFp6c25iUWc2ckd3NjdhQTY1Q1k3SmEwSU95VmpPdW12T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlLdGV1TGlPdUxwQzRLTFNEc2xZenJwcndnNnJhTTdaV2M3SjJFSU8yWGlPeWFxZTJWbU91cHRDRHNob3pzaTUzc25ZUWc2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1SUM4ZzdJU2s3S0NWN0plUTdJU2NJT3lWak91bXZPeWRoQ0Rzdkp3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95Y2hPeTVtQ0Rzb0pYcnM3UWc3SjIwN0pxcDdKZVFJT3VQbWV5ZG1PMlZtT3luZ0NEc2xZcnNsWVFnN0oyODY3YUFJT3E0c091S3BleWR0Q0Rzb0p6dGxaenJrS25yaTRqcmk2UXVDaTBnN0p5RTdMbVlJT3lnbGV1enRPdWx2Q0R0bDRqc21xbnRsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0Z0x5RHNoS1Rzb0pYc2w1RHNoSndnN0p5RTdMbVlJT3lna2VxM3ZPeWRoQ0R0bDRqc21xbnRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJeURzbVlUcm80ekN0K3luaE8yV2lRb0tJeU1qSU95Z2dPeWVwZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0Rzb0lEc25xWHRsb2pzbHJUc21wUXVDZ29qSXlNZzY3T0E2cks5N0lLczdaV3Q3SjIwSU95Z2dleWFxZXVRbU95WGlPeUt0ZXVMaU91THBDNEtMU0RyczREcXNyMGc2NEswN0pxcDdKMkVJT3lnZ2V5YXFlMldpT3lXdE95YWxDNEtDaU1qSXlEc29JVHNocUhzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRPdURpT3lXdE95YWxDNEtDaU1qSXlEcms3SHJvWjNzbmJRZzdKbUU2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91VHNldWhuZXlkaENEcnA0anNzNlRzbHJUc21wUXVDZ29qSXlNZzdJS3Q3S0NjNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95Q3JleWduTzJXaU95V3RPeWFsQzRLQ2lNakl5RHRnYlRycHIzcnM3VHJrNXpzbDVBZzY3TzE3SUtzNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU91enRleUNyTzJXaU95V3RPeWFsQzRLQ2lNakl5RHNtcFRzc3Ezc25ZUWc3TEtZNjZhc0lPeWtrZXllaGV1TGlPdUxwQzRnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNpNjNzaTV6c21LUXVDaTBnN0pxVTdMS3Q3SjJFSU95eW1PdW1yTzJWbU9xem9DRHNub2pzbHJUc21wUXVJQzhnN0o2ZzdJdWM2NmVNSU9xNHNPdUxwT3VncENEc283enNoTGpzbXBRdUNnb2pJeU1qSU95VmlPdUN0TUszN0p5ZzY0K0VDZ29qSXlNZzdJT0k2NkdjN0pxMElPdXloT3lnaE95ZHRDRHN0cHpzaTV6cmtKanNsNGpzaXJYcmk0anJpNlF1SU95WGhldU5zT3lkdE8yS3VDRHRtNFFnN0oyMDdKcXBJT3F3Z091S3BlMlZxZXVMaU91THBDNEtMU0RzZzRnZzY3S0U3S0NFN0oyMElPdUNtT3labE95V3RPeWFsQzRnTHlEc2w0WHJqYkRzbmJUdGlyanRsWmpycWJRZzdJT0lJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzRLQ2lNakl5RHNoSnpydVlUc2lxUWc3SjIwN0pxcDdKMkVJT3ljaE8yVnRDRHNsYjNxdElBZzY0K1o3SjJZNnJDQUlPMlZoT3lhbE8yVnFldUxpT3VMcEM0S0xTRHNsYjNxdElEc2w1QWc2NCtaN0oyWTdaV1k2Nm0wSU95RW5PdTVoT3lLcE91bHZDRHNpNXpzbnBIdGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbnFYc2k1enFzSVFnNjYrNDdJS3M3SnFwN0p5ODY2R2NJT3lla091UG1TRHJvWnpxdDdqc2xZVHNtNE1nNjVDWTdKZUk3SXExNjR1STY0dWtMaURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPeVlwT3VlcSt1UG1leVZpQ0RzZ3F6c21xbnRsWmpzcDRBZzdKV0s3SldFSU91aG5PcTN1T3lWaE95YmcrdVFrT3lXdE95YWxDNGdMeURyaTZUc2k1d2c2NkdjNnJlNDdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURyczdUc2xZanNuWVFnN0p5RTdaVzBJT3U1aE91d2dPdXlpTzJZdU91bHZDRHJzNERxc3IzdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHNsWWpzb0lUdGxad2c3SUtzN0pxcDdKMkVJT3ljaE8yVnRDRHJ1WVRyc0lEcnNvanRtTGpycGJ3ZzY3Q1U2citVSU95anZPeUV1T3lhbEM0S0NpTWpJeU1nNjdPMDdKV0lJT3lFbk91NWhPeUtwQW9LSXlNaklPcXl2ZXU1aE91bHZDRHFzSnpzaTV6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0NpMGc2cks5NjdtRTY2VzhJT3lMbk95ZWtlMlZvT3E1ak95YWxEOEtDaU1qSXlEcXNyM3J1WVRycGJ3ZzdaVzA3S0NjN1pXWTdJdWM2cktnN0lxMTY0dUk2cm1NUHdvdElPcXl2ZXU1aE91bHZDRHRsYlRzb0p6dGxhRHF1WXpzbXBRL0Nnb2pJeU1nNnJpdzZyaXc2ckNBSU95WXBPMlVoT3Vkdk95ZHVDRHNnNEh0ZzV6c25vWHJpNGpyaTZRdUlPdUVwTzJLdU95YmpPMkJyQ0RzbDdEcXNyRHNuWVFnN1ptVjdKMjQ3WldZN0l1dDdJdWM3SmlrTGdvdElPcTRzT3E0c09xd2dDRHJoS1R0aXJqc200enRnYXpzbDVBZzdKZXc2ckt3NjQrOElPeWVpT3luZ0NEc2xZcnNsWVRzbXBRdUlDOGc2cml3NnJpdzdKMllJT3lYc09xeXNDRHNnNEh0ZzV6cnBid2c3Wm1WN0oyNDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5RHNtSUhzZzRIc25ZUWc2N2FJNjUrczdKaWs2NHFVSU95a2tleWVoZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3SmlCN0lPQjdKMkVJT3UyaU91ZnJPeVlwT3F6b0NEc25vanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cmFNN1pXY0lPeUxvT3l5cmV5ZGhDRHN0NmpzaG96dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lPeTNxT3lHak8yVm1PeUxwQ0Rxc3Izc21yQWc3SXVnN0xLdDdaV1k3SXVnSU91Q3RPeWFxZXlkZ0NEc29JRHNucVhya0pqc3A0QWc3SldLN0lxMTY0dUk2NHVrTGdvdElPeTNxT3lHak8yVm1PdXB0Q0RzaTZEc3NxM3RsWndnNjRLMDdKcXA3SjIwSU95Z2dPeWVwZXVRbU95bmdDRHNsWXJzbFlUc21wUXVJQzhnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9DaTBnNnJhTTdaV2NJT3lMb095eXJleWRoQ0RzdDZqc2hvenRsYURxdVl6c21wUS9JQzhnN0xlbzdJYU03WldZNjZtMElPeWVoZXVncGUyVm5DRHJnclRzbXFuc25iUWc3SUtzNjUyODdLQzQ3SnFVTGdvS0l5TWpJeURxc0lEc25iVHJrNXdnN0ppSTdJdWNJQ2gxZUMxM2NtbDBhVzVuTG0xazdKZVE3SVNjSU95WXJ1cTVnQ0RpZ0pRZzZyZWM3TG1aN0p5ODY2R2NJT3lla091UG1lMlpsQ0RycXJzZzdaV1k2NHFVSU91c3VPeWVwU0RzbnF6cXRhenNoTEVnN0lLczY2R0FLUW9LSXlNaklPeWVrT3VQbWV5d3FPdWx2Q0Rxc0lEc3A0RHFzNkFnNnJPRTdJdWM2NEtZN0pxVVB3b3RJT3lla091UG1leXdxT3F3Z0NEc25vanJncGpzbXBRL0Nnb2pJeU1nNjZlazY0dXNJT3V6dE8yWG1PdWpqT3VsdkNEc2xyenJwNGpzbEtrZzY0SzA2ck9nSU9xemhPeUxuT3VDbU95YWxEOEtMU0RycDZUcmk2d2c2N08wN1plWTY2T002NHFVSU95V3ZPdW5pT3lkdU9xd2dPeWFsRDhLQ2lNakl5RHNsWWpzb0lUdGxad2c2ckNjN1lhMTdKMkVJT3ljaE8yVnRDRHJxb2NnNnJDQTdLZUFJT3VMcE95TG5DRHNsNnpzcmFUcnM3enFzb3pzbXBRdUNpMGc3SldJN0tDRTdaV2NJT3F3bk8yR3RleWRoQ0RzbklUdGxiUWc2NnFISU9xd2dPeW5nQ0RyaTZUc2k1d2c3Wm1WN0oyNDdaV2c2cktNN0pxVUxnb0tJeU1qSU95NXRPdVRuT3VsdkNEdGxiVHNwNER0bFpqc2k1enFzcURzbHJUc21wUS9DaTBnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWb09xNWpPeWFsRDhLQ2lNakl5RHNpNXpzbnBIdGxaanNpNXpyaXBRZzY3YUU3SmVRNnJLTUlEVXNNREF3N0p1UTdKMkVJT3VUbk91Z3BPeWFsQzRLTFNEc2k1enNucEh0bFpqcnFiUWdOU3d3TUREc201RHNuWVFnNjVPYzY2Q2s3SnFVTGdvS0l5TWpJT3lkdE95ZWtDRHRtWmpydG9qc25ZUWc2N0NiN0pXWTdKYTA3SnFVTGdvdElPeWR0T3lla091bHZDRHJqNHpyb0tUcnNKdnNsWmpzbHJUc21wUXVDZ29qSXlNZzdKaWs2NHFZN0oyWUlPMkF0T3ltaU9xd2dDRHFzNmNnN0tLRjY2T002NCs4N0pxVUxnb3RJT3lZcE91S21PeWRtQ0R0Z0xUc3BvanFzSUFnNnJPbklPdUJuZXVDbU95YWxDNEtDaU1qSXlEcXVJanNuYnpxdVl6c3A0QWc2Nis0NjRLcElPeUxuQ0RzbDdEc3NyUWc3TEtZNjZhczY1Q3A2NHVJNjR1a0xpRHRtNFRydG9qcXNyRHNvSndnNnJpSTdKV2g3SjJFSU91Q3FldTJnTzJWbU95TG5PcTRzQ0Ryc0pUcm5vM3JpNGpyaTZRdUNpMGc3SmlrNjRxWTZybU03S2VBSU91Q3RPeW5nQ0RzbFlyc25MenJxYlFnN0pldzdMSzA2NCs4N0pxVUxpQXZJTzJiaE91MmlPcXlzT3lnbkNEcXVJanNsYUhzbllRZzY0SzA3S084N0lTNDdKcVVMZ29LSXlNaklPeWdrT3F5Z0NEcXVMRHFzSVRzbDVEcmlwUWc3SVNjNjdtRTdJcWtJT3lkdE95YXFleWR0Q0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN0tDUTZyS0FJT3E0c09xd2hDRHJqNW5zbFlnZzdJU2M2N21FN0lxazY2VzhJT3lkdE95YXFlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU95TG9PdTJoT3ltblNEdG1aWHNuYmdnN0tDRTdKZVE2NHFVSU95R29lcTRpQ0Ryc0k4ZzZyS3c3S0NjNnJDQUlPdTJpT3F3Z08yVnFldUxpT3VMcEM0S0xTRHNpNkRydG9Uc3BwMGc3Wm1WN0oyNDY1Q1k2cml3SU95Z2hPcTVqT3luZ0NEc2hxSHF1SWpxczd3ZzZyS3c3S0NjNjZXOElPMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb0tJeU1qSU91emdPcXl2U0RzaTV3ZzdMcVE3SXVjNjdDeElPeWVyT3luZ09xNGlleWRnQ0RydG9qcXNJRHRsYW5yaTRqcmk2UXVDaTBnN1pXY0lPdXlpQ0Ryc0pUcXZyanJxYlFnN0xxUTdJdWM2N0N4N0oyQUlPdUxwT3lMbkNEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtDaU1qSXlEc2c0SHJpN1FnN1pLSTdLZUlJTzJXcGV5RGdleWRoQ0RzbklUdGxiUWc3WWExN1ptVUlPdUN0T3lhcWV5ZHRDRHJoYm5zbll6cmtLbnJpNGpyaTZRdUNpMGc2NDJVSU95aWkreWRnQ0RzZzRIcmk3VHNuWVFnN0p5RTdaVzBJTzJHdGUyWmxDRHJnclRzbXFuc25ZQWc2NFc1N0oyTTY0Kzg3SnFVTGdvS0l5TWpJT3F6b09xd25ldUxtT3lkbUNEcXNKenNuYmpzb0pYcnM3UWc3SjIwN0pxcElPdUN0T3lYcmV5ZGdDRHF1TERyb1owZzZyU0E2NmFzNjVDcDY0dUk2NHVrTGdvdElPeWR0T3lnbk91MmdPMkVzQ0Rxc0p6c25ianNvSlhyczdRZzdKMjA3SnFwSU91Q3RPeVhyZXlkdENEcXVMRHJvWjNyajd6c21wUXVDZ29qSXlNZzdMS3Q3SWFNNjRXRTdKMkFJT3lFbk91NWhPeUtwQ0Rxc0lEc25vWHNuYlFnNjdhSTZyQ0E3WldwNjR1STY0dWtMZ290SU95bmdPcTRpT3lkZ0NEcXNJRHNub1h0bGFBZzdJaVlJT3lYaHV5V3RPeWFsQzRnTHlEc3NxM3Nob3pyaFlUc25ZUWc3SnlFN1pXY0lPeUVuT3U1aE95S3BPdUtsQ0RzbFlUc3A0RWc3S1NBNjdtRUlPeWtrZXlkdE95WGtPeWFsQzRLQ2lNakl5TWc2ck9FN0tDVndyZnNub1hyb0tVS0NpTWpJeURzbFlUc25iVHJsSlFnNjVpUTY0cVVJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZHRPeURnU0RzbnBqcnFyc2c3SjZGNjZDbDdaV1k3SmVzSU9xemhPeWdsZXlkdENEc25xRHF1SWdnN0xLWTY2YXM2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3U1aE91d2dPdXlpTzJZdU91bHZDQTE3WnFNSU95ZW1PdXF1eURzbm9Ycm9LWHRsYlRzaEp3ZzZyT0U3S0NWN0oyMElPeWVvT3F5dk95V3RPeWFsQzRnTHlEcnVZVHJzSURyc29qdG1ManJwYndnN0o2czdJU2s3S0NWN1pXWTY2bTBJT3VMcE95TG5DRHNuYlRzbXFudGxhQWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbmJUcnI3Z2c3SUtzN0pxcElPeWtrZXlkdUNEc2xZVHNuYlRybEpUc25vWHJpNGpyaTZRdUNpMGc3SjIwNjYrNElPeVRzT3F6b0NEc25vanJpcFFnN0pXRTdKMjA2NVNVN0ppSTdKcVVMaUF2SU91THBPdWx1Q0RzbFlUc25iVHJsSlRycGJ3ZzdKNkY2NkNsN1pXMElPeWp2T3lFdU95YWxDNEtDaU1qSXlEc2dxenNtcW50bGFBZzdJaVlJT3lYaHV1S2xDRHJ1WVRyc0lEcnNvanRtTGpzbm9Ycmk0anJpNlF1SU95WWdldXN1Q3dnN0lpcjdKNlFMQ0R0aXJuc2lKanJyTGpzbnBEcnBid2c3WStzN1pXbzdaV1k3SmVzSURqc25wQWc3SjIwN0lPQklPeWVoZXVncGUyVm1PeUxyZXlMbk95WXBDNEtMU0RzbUlIcnJMZ3NJT3lJcSt5ZWtDd2c3WXE1N0lpWTY2eTQ3SjZRNjZXOElPMlByTzJWcU8yVnRDQTQ3SjZRSU95ZHRPeURnU0Rzbm9Ycm9LWHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3llaGV1Z3BTRHFzSURyaXFYdGxad2c2cmlBN0o2UUlPeUltT3VsdkNEc3RJanFzN3p0bFpqc21JRHNpclhyaTRqcmk2UXVDaTBnN0o2RjY2Q2w3WldnSU95SW1DRHNub2pyaXBRZzZyaUE3SjZRSU95SW1PdWx2Q0RyaEpqc2w0anNsclRzbXBRdUlDOGc2NEswN0pxcDdKMkVJT3loc09xNGlDRHNwSVRzbDZ3ZzdLTzg3SVM0N0pxVUxnb0tJeU1qSXlEdGpJenNuYnpDdCtxeXNPeWduTUszNnJpdzdZT0FDZ29qSXlNZzdZeU03SjI4SU95YXFldWZpZXlkdENEc3RJanFzN3pya0pqc2w0anNpclhyaTRqcmk2UXVJREV3VFVJZzdKMjA3WldZN0oyWUlPMk1qT3lkdk91bmpDRHNsNFhyb1p6cms1d2c2ckNBNjRxbDdaV3A2NHVJNjR1a0xnb3RJREV3VFVJZzdKMjA3WldZSU8yTWpPeWR2T3VuakNEc21LenJwclFnN0lpWUlPeWVpT3lXdE95YWxDNGdMeUR0akl6c25id2c3SnFwNjUrSjdKMkVJTzJabGV5ZHVPMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2NHVrN0pxMDY2R2M2NU9jNnJDQUlPeVpoT3Vqak91UW1PeVhpT3lLdGV1TGlPdUxwQzRLTFNEcmk2VHNtclRyb1p6cms1enJwYndnNjZlSTdMT2s3SmEwN0pxVUxnb0tJeU1qSU9xeXNPeWduT3lYa0NEc2k2VHRqS2p0bFpqc21JRHNpclhyaTRqcmk2UXVJT3VMcE95TG5DRHNpNXpyajRUdGxiUWc3S084N0l1YzZyaXdJT3V3bE91ZWpldUxpT3VMcEM0S0xTRHFzckRzb0p6dGxaanNwNEFnNjZxNzdaYUk3SmEwN0pxVUxpQXZJT3F5c095Z25DRHNpSmpyaTZqc25ZUWc3Wm1WN0oyNDdaV1k2ck9nSU91THBPeUxuQ0RzaTV6cmo0VHRsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lnZ095ZXBTRHFzN1hxc0lUc25iUWc2N2FBN0tHeDdaV1k3SmVzSU95RXBPeTVtTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWdnT3llcFNEcXM3WHFzSVRzbmJRZzY3YUE3S0d4N1pXMDdJU2NJT3lFcE95NW1PMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3F6dGVxd2hPeWRoQ0R0bVpYcnM3VHRsWndnNjVLa0lPdUxwT3lMbkNEc2k1enJqNFR0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU95RW5PdTVoT3lLcENEc3BJRHJ1WVFnN0tTUjdKNkY2NHVJNjR1a0xnb3RJT3lrZ091NWhPMlZtT3F6b0NEc25vanJpcFFnNnJpdzY0cWw3SjIwN0plUTdKcVVMaUF2SU95aHNPcTRpT3VuakNEcXVMRHJpNlRyb0tRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU91VHNldWhuU0Rxc0lEcmlxWHRsWndnN0xXYzY0eUFJT3F3bk95SW1PdWx2Q0RzdElqcXM3enRsWmpzbUlEc2lyWHJpNGpyaTZRdUNpMGc2NDJVSU91VHNldWhuZTJWbU91Z3BPdXB0Q0RxdUxEc29iUWc3Wld0NjZxcDdKMkVJT3lDcmV5Z25PMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWpJT3V6dE95VmlDRHNoSnpydVlUc2lxUWdLT3kybE9xd2dDa0tDaU1qSXlEc3RwenJqNWtnN0pxVTdMS3Q3SjIwSU95Z2tleUltT3VRbU95WGlPeUt0ZXVMaU91THBDNGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2k2M3NpNXpzbUtRdUNpMGc3TGFjNjQrWklPeWFsT3l5cmV5ZGhDRHNvSkhzaUpqdGxvanNsclRzbXBRdUlDOGc3SjZnN0l1YzY2ZU1JT3E0c091THBPdWdwQ0Rzbzd6c2hManNtcFF1Q2dvakl5TWc2cks5NjdtRUlPeURnZTJEbk91bHZDRHRtWlhzbmJqdGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc3SjZnN0l1Y0lPMmJoQ0RyaTZUc2k1d2c3SXVjNjQrRTdaV1k3SXV0N0l1YzdKaWtMZ290SU9xeXZldTVoQ0RzZzRIdGc1enJwYndnN1ptVjdKMjQ3WldnSU95SW1DRHNsNGJzbHJUc21wUXVJQzhnN0o2ZzdJdWNJTzJiaENEcmk2VHNpNXdnN0l1YzY0K0U3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3lnaE8yWm1PMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0RzbWJqc3Rwd2c2NnFvNjVPYzY2R2NJT3V3bE9xL2dPcTVqT3lhbEQ4S0NpTWpJeURyc0tucnJMZ2c3SmlJN0pXOTdKMjBJT3laaE91ampPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHJzS25yckxnZzdKaUk3Slc5N0oyRUlPdW5pT3l6cE95V3RPeWFsQzRLQ2lNakl5RHJ1WVRyc0lEcnNvanRtTGdnTmUyYWpDRHNtS1RycFpqcm9ad2c2ck9FN0tDVjdKMjBJT3llb09xNGlDRHNzcGpycHF6cmtKanNsNGpzaXJYcmk0anJpNlF1Q2kwZzY3bUU2N0NBNjdLSTdaaTQ2Nlc4SURYdG1vd2c3SjZZNjZxN0lPeWVoZXVncGUyVnRPeUVuQ0RxczRUc29KWHNuYlFnN0o2ZzZySzg3SmEwN0pxVUxpQXZJT3U1aE91d2dPdXlpTzJZdU91bHZDRHNucXpzaEtUc29KWHRsWmpycWJRZzY0dWs3SXVjSU95ZHRPeWFxZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHF1STNzb0pYc29JRWc2NmVRN1pXWTZyaXdJQ2pzbDRic2xyVHNtcFFnNG9hU0lIN3RsWmpycWJRZzdaV2dJT3lJbUNEc25vanNsclRzbXBRcENnb2pJeU1nNjdPNDdKMjRJT3lkdU95bW5leWRoQ0R0bFpqc3A0QWc3SldLN0p5ODY2bTBJT3lFbk91NWhPeUtwT3VsdkNEc25iVHNtcW50bGFBZzdJaVlJT3lYaHV5S3RldUxpT3VMcEM0S0xTRHJzN2pzbmJnZzdKMjQ3S2FkN0oyRUlPMlZtT3VwdENEcnFxanJrNkFnN0lTYzY3bUU3SXFrNjZXOElPeWR0T3lhcWUyVm9DRHNpSmdnN0o2STdKYTA3SnFVTGdvS0l5TWpJT3lkdE91cGxPeWR2Q0RzbmJqc3BwMGc3S0NFN0plUTY0cVVJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPeWR0T3VwbE95ZHZDRHNuYmpzcHAzc25ZUWc2NmVJN0xtWTY2bTBJT3Vobk9xM3VPeWR1TzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeS9vTzJQc095ZGdDRHJvWnpxdDdqc25iZ2c3WnVFN0plUTY2ZU1JT3lDck95YXFTRHFzSURyaXFYdGxhbnJpNGpyaTZRdUNpMGc2NkdjNnJlNDdKMjQ3WldZNjZtMElPeS9vTzJQc095ZGhDRHNrN2dnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnI3anNoTEhyaFlUc25wRHJpcFFnNjdPMDdaaTQ3SjZRSU91UG1leWRtQ0RzbDRic25iUWc2ckt3N0tDYzdaV2dJT3lJbUNEc2w0YnNpclhyaTRqcmk2UXVDaTBnNjdPMDdaaTQ3SjZRNnJDQUlPdVBtZXlkbU8yVm1PdXB0Q0Rxc3JEc29KenRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEdGxJVHJvWnp0bFlUc25ZUWc2NU94NjZHZDdaV1k3S2VBSU95Vml1eWN2T3VwdENEc25iVHNtcW5zbmJRZzdLQ2M3WldjNjVDcDY0dUk2NHVrTGdvdElPMlVoT3Vobk8yVmhPeWRoQ0RyazdIcm9aM3RsWmpycWJRZzY2cW82NU9nSU9xNHNPdUtwZXlkaENEc2s3Z2c3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeURzbGJFZzY3S0U3S0NFN0oyMElPdUNydXlWaENEc25ienJ0b0FnNnJpdzY0cWw3SjIwSU95Z25PMlZuT3VRcWV1TGlPdUxwQzRLTFNEc2xiSHNuWVFnN0plRjY0Mnc3SjIwN1lxNDdaV1k2Nm0wSU91cXFPdVRvQ0RxdUxEcmlxWHNuWVFnN0pPNElPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc2N2lVNjZPbzdZaXM3SXFrNnJDQUlPcTZ2T3lndUNEc25vanNsclFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SmVHN0lxMTY0dUk2NHVrTGdvdElPdTRsT3VqcU8ySXJPeUtwT3VsdkNEc3ZKenJxYlFnNnJpdzZyaXc2Nlc4SU95WHNPcXlzTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPdTVoT3lEZ1NEc2w3RHJuYjNzc3BqcXNJQWc2NU94NjZHZDY1Q1k3S2VBSU95Vml1eVZtT3lLdGV1TGlPdUxwQzRLTFNEcnVZVHNnNEVnN0pldzY1Mjk3TEtZNjZXOElPdVRzZXVobmUyVm1PdXB0Q0RxdUxUcXVJbnRsYUFnNjVXTUlPdTVvT3VsdE9xeWpDRHNsN0RybmIzcms1enJwclFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEc3RwenNub1VnN0xtMDY1T2M2ckNBSU91VHNldWhuZXVRbU95bmdDRHNsWXJzbFlRZzdJS3M3SnFwN1pXZ0lPeUltQ0RzbDRic2lyWHJpNGpyaTZRdUNpMGc3TGFjN0o2RklPeTV0T3VUbk91bHZDRHJrN0hyb1ozdGxaanJxYlFnNjdDVTY2R2NJT3lUdUNEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNakl5RHJpcVhyajVuc29JRWc2NmVRN1pXWTZyaXdJQ2pzbVlUcm80d2c3SldJNjRLMEtRb0tJeU1qSU8yYWpPeWJrT3F3Z095ZWhleWR0Q0RzbVlUcm80enJrSmpzbDRqc2lyWHJpNGpyaTZRdUNpMGc2ckNBN0o2RjdKMkVJT3VuaU95enBPeVd0T3lhbEM0S0NpTWpJeURzbUlqc2xiM3NuYlFnN0xlbzdJYU02NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lZaU95VnZleWRoQ0RzdDZqc2hvenRsb2pzbHJUc21wUXVDZ29qSXlNZzY2eTQ3SjJZNnJDQUlPeWdrZXlJbU91UW1PeVhpT3lLdGV1TGlPdUxwQzRnN0lpYzdMQ283S0NCN0p5ODY2R2NJT3VMdGV1emdPdVRuT3Vtck9xeW9PeUt0ZXVMaU91THBDNEtMU0Ryckxqc25aanJwYndnN0tDUjdJaVk3WmFJN0phMDdKcVVMaUF2SU95SW5PeUVuT3VNZ091aG5DRHJpN1hyczREcms1enJwclRxc296c21wUXVDZ29qSXlNZzdJU2s3S0NWN0oyMElPeTBpT3E0c08yWmxPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNoS1Rzb0pYc25ZUWc3TFNJNnJpdzdabVU3WmFJN0phMDdKcVVMZ29LSXlNaklPdTVoT3V3Z091eWlPMll1T3F3Z0NEcnM0RHFzcjNya0pqc2w0anNpclhyaTRqcmk2UXVDaTBnNjdtRTY3Q0E2N0tJN1ppNDY2VzhJT3V3bE9xL3FPeVd0T3lhbEM0S0NpTWpJeURzbmJqc3BwM3NuYlFnN0ptRTY2T002NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3lkdU95bW5leWRoQ0RycDRqc3M2VHNsclRzbXBRdUNnb2pJeU1qSU95NmtPeWp2T3lXdk8yVm5DRHFzcjNzbHJRZ0tPeW5pT3VzdUNEc25xenF0YXpzaExFcENnb2pJeU1nN0phNDdLQ2NJT3V3cWV1c3VPMlZtT3lMbk9xeW9PeUt0ZXVMaU9xNWpEOEtMU0Ryc0tucnJMZ2c2NEtnN0tlYzY2VzhJT3lFb08yRG5lMlZ0Q0Rzbzd6c2hManNtcFF1Q2dvakl5TWc3SmEwNjVha0lPdXdxZXV5bGV5Y3ZPdWhuQ0RzbmJqc3BwM3RsWmpzaTV6cXNxRHNpclhyaTRqcXVZdy9DaTBnN0oyNDdLYWRJT3V3cWV1eWxleWRoQ0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3F5c095Z25PMlZtT3lMcENEc3ViVHJrNXpycGJ3ZzdJU2c3WU9kN1pXMElPeWp2T3lMcmV5TG5PeVlwQzRLTFNEcXNyRHNvSnp0bGFBZzdMbTA2NU9jNjZXOElPeUVvTzJEbmUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzdKdVE3WldZN0l1YzY0cVVJT3lFbk91NWhPeUtwT3VsdkNEc2hLRHRnNTN0bFpqc2hManNtcFF1Q2kwZzdKdVE3WldZNjRxVUlPeUVuT3U1aE95S3BPdWx2Q0RzaEtEdGc1M3RsYlFnN0tPODdJUzQ3SnFVTGdvS0l5TWpJT3lqdk95R2pPdWx2Q0RzbFl6cXM2QWc2ck9FN0l1ZzZyQ0E3SnFVUHdvdElPeWp2T3lHak91bHZDRHNsWXpxczZBZzdKNkk2NEtZN0pxVVB3b0tJeU1qSXlEcnFvWHNncXdyNjZxRjdJS3NJTzJTZ095V3RPeVRzT3E0c0FvS0l5TWpJT3E0c09xd2hDRHJwNHpybzR6cm9ad2c3SjIwN0pxcDdKMjBJT3lra2V5bmdPdVFtT3lYaU95S3RldUxpT3VMcEM0S0xTRHNuYlRzbXFrZzZyaXc2ckNFN0oyMElPdUJuZXVDbU95RW5DRHNwNERxdUlqc25ZQWc3Sk80SU95SW1DRHNsNGJzbHJUc21wUXVDZ29qSXlNZzdKcXA2NStKSU91MmdPeWhzZXljdk91aG5DRHNvSURzbnFYc2w1QWc3SXVrN1l5bzdaYUk3SXExNjR1STY0dWtMZ290SU95Z2dPeWVwU0RxczdYcXNJVHNuYlFnNjdhQTdLR3g3WlcwN0lTY0lPeWdnT3llcGUyVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRdUNnb2pJeU1nN1lhMTdJdWdJT3lZcE91bG1PdWhuQ0RzbXBUc3NxM3NuYlFnN0l1azdZeW83WldZN0ppQTdJcTE2NHVJNjR1a0xnb3RJTzJHdGV5TG9PeWR0Q0RzbTVEdG1aenRsWmpzcDRBZzdKV0s3SldFSU95YWxPeXlyZXlkaENEc3NwanJwcXp0bFpqc3A0QWc2NnE3N1phSTdKYTA3SnFVTGlBdklPeWVvT3lMbkNEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzZyYU03WldjSU91MmdPeWhzZXljdk91aG5DRHNvSkhxdDd6c25iUWc2ckd3NjdhQTY1Q1k3SmVJN0lxMTY0dUk2NHVrTGdvdElPeWdrZXEzdkNEcXRvenRsWnpzbmJRZzdKZUc3SmEwN0pxVUxpQXZJT3EwZ091bXJPeWVrT3lYa09xeWpDRHF0b3p0bFp6c25ZUWc3SnFVN0xLdDdaVzBJT3lqdk95RXVPeWFsQzRLQ2lNakl5TWc3SU9CN1ptcElPeVZpT3VDdENBb011dUxxQ0RxdGF6c29iQXBDZ29qSXlNZzdKNkY2NkNsN1pXWTdJdWdJT3lqdk95R2pPdWx2Q0Rzc0w3c25ZUWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNGc2NHVrN0l1Y0lPMlpsZXlkdUNEcnNKVHJubzNyaTRqcmk2UXVDaTBnN0tPODdJYU02Nlc4SU95d3Z1eWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3VMcE95TG5DRHRtWlhzbmJqdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNaklPeWFsT3l5cmUyVm1PeUxvQ0R0anBqc25iVHNwNERycGJ3ZzdMQys3SjJFSU95SW1DRHNsNGJzaXJYcmk0anJpNlF1Q2kwZzdZNlk3SjIwN0tlQTY2VzhJT3l3dnV5ZGhDRHNpSmdnN0plRzdKYTA3SnFVTGlBdklPeWp2T3lHak91bHZDRHRtWlhzbmJqdGxaanFzYkRyZ3BnZzdabUk3Snk4NjZHY0lPeWR0T3VQbWUyVnRDRHNvN3pzaExqc21wUXVDZ29qSXlNZzY0K1o3SjI4N1pXY0lPeWFsT3l5cmV5ZHRDRHNzcGpycHF3ZzdLU1I3SjZGNjR1STY0dWtMaURzbnFEc2k1d2c3WnVFSU8yWmxleWR1TzJWdENEc283enNpNjNzaTV6c21LUXVDaTBnNnJDWjdKMkFJT3lhbE95eXJleWRoQ0Rzc3BqcnBxenRsWmpxczZBZzdKNkk3SmEwN0pxVUxpQXZJT3llb095TG5DRHRtNFFnN1ptVjdKMjQ3WlcwSU95anZPeUV1T3lhbEM0S0NpTWpJeURzbmJUcnNxVHRpcmpxc0lBZzdLS0Y2Nk9NNjVDWTdKZUk3SXExNjR1STY0dWtMZ290SU95ZHRPdXlwTzJLdU9xd2dDRHJnWjNyZ3F6c2xyVHNtcFF1Q2dvakl5TWc3WU9JN1llMElPeUxuQ0RycXFqcms2QWc2NDJ3N0oyMDdZU3c2ckNBSU95Q3JleWduT3VRbU91cHNDRHJzN1hxdGF6dGxhQWc3SWlZSU95WGh1eUt0ZXVMaU91THBDNEtMU0R0ZzRqdGg3VHRsWmpycWJRZzY2cW82NU9nSU91TnNPeWR0TzJFc09xd2dDRHNncTNzb0p6cmtKanFzNkFnNjR1azdJdWNJT3VRbU91UGpPdW10Q0RzaUpnZzdKZUc3SmEwN0pxVUxpQXZJT3lnbGV1bmtDRHRnNGp0aDdUdGxhRHF1WXpzbXBRL0Nnb2pJeU1qSU91enRPeVZpQ0RzaEp6cnVZVHNpcVFnS095RGdlMlpxU0RzbFlqcmdyUXBDZ29qSXlNZzY3YUE3SjZzSU95a2tTRHJzS25yckxqc25wRHFzSUFnNnJDUTdLZUE2NUNZN0plSTdJcTE2NHVJNjR1a0xnb3RJT3UyZ095ZXJDRHNwSkhzbDVBZzY3Q3A2Nnk0N0o2UTZyQ0FJT3llaU95WGlPeVd0T3lhbEM0Z0x5RHNtSUhzZzRIc25ZUWc3Wm1WN0oyNDdaVzBJT3V6dE95RXVPeWFsQzRLQ2lNakl5RHFzcjNydVlRZzdaVzA3S0NjSU9xMmpPMlZuT3lkdENEc2w0YnNpclhyaTRqcmk2UXVDaTBnNnJLOTY3bUVJTzJWdE95Z25DRHF0b3p0bFp6c25iUWc3WldFN0pxVTdaVzA3SnFVTGlBdklPcTBnT3Vtck95ZWtPeVhrT3F5akNEc21wVHNzcTN0bGJRZzdLTzg3SVM0N0pxVUxnb0tJeU1qSU8yWmxPeWVyQ0Rxc0pEc3A0RHF1TEFnNjdDdzdZU3c2NmFzNnJDQUlPdTJnT3loc2UyVnFldUxpT3VMcEM0S0xTRHRtWlRzbnF3ZzZyQ1E3S2VBNnJpd0lPdXdzTzJFc091bXJPcXdnQ0RzbHJ6cnA0Z2c3SmVHN0phMDdKcVVMaUF2SU91d3NPMkVzT3Vtck91bHZDRHF0WkRzc3JUdGxiUWc3S084N0lTNDdKcVVMZ29LSXlNakl5RHN0cFhzbGIwZ0t5RHF1STNzb0pVZzdLQ0U3Wm1ZSUNqcmtaQWc2Nnk0N0o2bElPS0draURxdUkzc29KWHRtSlVnN1pXY0lPdXN1T3llcFNrS0NpTWpJeURycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc2xiM3F0SURzbDVBZzY0K1o3SjJZN1pXWTY2bTBJT3VxcU95ZWhPeW5nT3lia09xNGlPeWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0S0NpTWpJeUR0bUp6dGc1MGc3SmVHN0oyMElPcXdnT3llaGUyVm9PcTVqT3lhbEQ4ZzdLZUE2cmlJSU95TG9PeXlyZTJWbU95bmdDRHNsWXJzbkx6cnFiUWc3SnV3N0x1MElPMlluTzJEbmV5ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRLTFNEc3A0RHF1SWdnN0l1ZzdMS3Q3WldZNjZtMElPeWJzT3k3dENEdG1KenRnNTNzbllRZzY3Q2I3SjJFSU95SW1DRHNub2pzbHJUc21wUXVDZ29qSXlNZzdMK2c3WSt3SU95WGh1eWR0Q0Rxc3JEc29KenRsYURxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPMlZvT3lkdUNEc3Y2RHRqN0RzbllRZzY3Q2I3SjJFSU95SW1DRHNsNGJzbHJUc21wUXVDaTBnN0wrZzdZK3c3SjJFSU91d20reWN2T3VwdENEcmpaUWc3S0NBNjZDMDdaV1k2cktNSU9xeXNPeWduTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ29LSXlNaklPeVZqT3VtdkNEc2w0YnNuYlFnN0l1YzdKNlI3WldnNnJtTTdKcVVQeURzbFl6cnByenNuWVFnN0x5YzdLZUFJT3lWaXV5Y3ZPdXB0Q0RzcEpIc21wVHRsWndnN0lhTTdJdWQ3SjJFSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxnb3RJT3lWak91bXZPeWRoQ0Rzdkp6cnFiUWc3S1NSN0pxVTdaV2NJT3lHak95TG5leWRoQ0Ryc0pUcm9ad2c2N0NiN0oyRUlPeUltQ0Rzbm9qc2xyVHNtcFF1Q2dvakl5TWc3SjZRNjQrWjdKMjA3TEswNjZXOElPdVRzZXVobmUyVm1PeW5nQ0RzbFlycXM2QWc2NFNZN0phMDZyQ0k2cm1NN0pxVVB5RHJrN0hyb1ozdGxaanNwNEFnN0pXSzdKeTg2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlXdE95YWxDNEtMU0RzbnBEcmo1bnNuYlRzc3JUcnBid2c2NU94NjZHZDdaV1k2Nm0wSU8yVm9PeWR1T3lkaENEcnNKdnNuWVFnN0lpWUlPeWVpT3lXdE95YWxDNEtDaU1qSXlEcnM3Z2c2ck9FN0pXOTdKMllJT3ljb095ZHZPMlZuQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeWR2T3V3bU9xMGdPdW1yT3lla091aG5DRHF0b3p0bFp6cnM0RHFzcjNzbllRZzdaV1k3SXVrSU95SW1DRHNsNGJzbHJUc21wUXVJT3lkdk91d21DRHF0SURycHF6c25wRHJvWndnNnJhTTdaV2NJT3V6Z09xeXZleWRoQ0RzbTVEdGxaanNpNlFnNnJLOTdKcXdJT3VMcE91bHVDRHNncXpybm96c2w1RHFzb3dnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla0NEcXRvenRsWnpzbllRZzdLZUE3S0NWN1pXMElPeWp2T3lMb0NEdG00UWc2NHVrN0l1Y0lPeUxuT3VQaE8yVnRDRHNvN3pzaExqc21wUXVDaTBnNjR1azY2VzRJT3lDck91ZWpPeWRoQ0RycDRqc2lxVHRoTEFnNnJTQTY2YXM3SjZRNjZHY0lPeW5nT3lnbGUyVm5DRHJrcVFnN0oyODY3Q1lJT3EwZ091bXJPeWVrT3VobkNEcnM0RHFzcjN0bGFBZzdJaVlJT3llaU95V3RPeWFsQzRLTFNEcmk2VHJwYmdnN0lLczY1Nk03SjJFSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcm9ad2c3S2VBN0tDVjdaV1k2Nm0wSU91emdPcXl2ZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZ289JwpCNjRfR1VJREU9J0l5QlZXQ0JYY21sMGFXNW5JT3F3Z095ZHRPdVRuQTBLRFFvakl5QXhMaUR0bGJUc21wVHNzclFOQ2cwSzdLQ2M3WktJSU95VmlPeWRtQ0RycXFqcms2QWc2Nnk0NnJXczY0cVVJQ2Z0bGJUc21wVHNzclFuNjZHY0lPeU5xT3lhbEM0TkN1eWR2T3EwZ095RXNTRHNub2pyaXBRZzdJS3M3SnFwN0o2UUlPcXl2ZTJYbU95ZGhDRHJwNHpyazZRZzdJaVlJT3llaU91UGhPdWhuU0FxS3V5RGdlMlpxU3dnNjZlbDY1Mjk3SjJFSU91MmlPdXN1TzJWbU9xem9DRHJxcWpyazZBZzY2eTQ2cldzN0plUUlPMlZ0T3lhbE95eXRPdWx2Q0Rzb0lIc21xbnRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHJzN1RyZzRYcmk0anJpNlFnNG9hU0lPdXp0T3VDdk9xeWpPeWFsQTBLRFFvcUtpb05DZzBLSXlNZ01pNGc2NHFsNjQrWjdLQ0JJT3Vua08yVm1PcTRzQTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSU95MW5PdU1nTzJWbkNBcUt1dUtwZXVQbWUyWWxTRHJyTGpzbnFVcUt1eWRoQ0RzamFqc283enNoTGpzbXBRdUlPeUltT3VQbWUyWWxTRHJyTGpzbnFYc25ZQWdXK3lZaU95WnVDRHF0NXpzdVpsZEtDUHNtSWpzbWJndE1TM3NpSmpyajVudG1KVXQ2Nnk0N0o2bDdKMkVMZXlOcU91UGhDM3JrSmpyaXBRdDZySzk3SnF3S2V5WGtDRHRsYlRyaTdudGxhQWc2NVdNNjZlTUlPeVRzT3VLbENEcXNvd2c3S0tMN0pXRTdKcVVMZzBLRFFvakl5TWc2NUNRN0phMDdKcVVJT0tHa2lEdGxvanNsclRzbXBRTkNnMEs3SmlJS1EwS0xTRHNoS1Rzb0pYcmtKRHNsclRzbXBRZzRvYVNJT3lFcE95Z2xlMldpT3lXdE95YWxBMEtEUW9qSXlNZ0ozN3NsNGduSU91NXZPcTRzQTBLRFFyc21JZ3BEUW90SU91d2xPdUFqT3lYaU95V3RPeWFsQ0RpaHBJZzY3Q1U2citvN0phMDdKcVVEUW9OQ2lNakl5RHJqNW5zZ3F3ZzY3Q1U2citVN0pPdzZyaXdEUW9OQ3V5WWlDa05DaTBnNjRhUzdKV0U3S0dNN0phMDdKcVVJT0tHa2lEc21LenJucERzbHJUc21wUU5DZzBLS2lvcURRb05DaU1qSURNdUlPcTRqZXlnbGV5Z2dTRHJwNUR0bFpqcXVMQU5DZzBLN0tDYzdaS0lJT3lWaU95WGtPeUVuQ0RydG9Ec29KWHNvSUVnN0x1azY2Nms2NHVJN0x5QTdKMjA3SVdZN0oyRUlPeTFuT3VNZ08yVm5DRHNwSVRzbmJUcXM2QWc2cmlON0tDVjdaaVZJT3VzdU95ZXBleWRoQ0RzamFqc283enNoTGpzbXBRdURRcnJ0b0Rzb0pYdG1KVWc2Nnk0N0o2bDdKMkFJRnZzbUlqc21iZ2c2cmVjN0xtWlhTZ2o3SmlJN0ptNExUTXQ2N2FBN0tDVjdaaVZMZXVzdU95ZXBleWRoQzNzamFqcmo0UXQ2NUNZNjRxVUxlcXl2ZXlhc0Nuc2w1QWc3WlcwNjR1NTdaV2dJT3VWak91bmpDRHNqYWpzbXBRdURRb05DdXlZaUNBNklPeVZpQ0Ryajd6c21wUXNJT3lYaHV5V3RPeWFsQ0FvV0NrZzRvYVNJSDd0bFpqcnFiUWc3WldnSU95SW1DRHNub2pzbHJUc21wUWdLRThwRFFvTkNpTWpJeURzbDRic2xyVHNtcFFnNG9hU0lPeWVpT3lXdE95YWxBMEtEUXJzbUlncERRb3RJT3V6dE8yWXVPeWVrT3F3Z0NEdGw0anJuYjN0bFpqcXVMQWc3S0NFN0plUTY0cVVJT3F3Z095ZWhlMlZvQ0RzaUpnZzdKZUc3SmEwN0pxVUlPS0draURyczdUdG1ManNucERxc0lBZzdaZUk2NTI5N1pXMDdKVzhJT3F3Z095ZWhlMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVURRb05DaU1qSXlEc2w1RHJuNndnNjZtVTdJdWM3S2VBRFFvTkN1eVhrT3VmckNEc2c0SHRtYW5zbDVEc2hKenJqNFFnSXUyVnRPcXlzQ0Ryc0tucnNwVWk3SjJFSU91b3ZPeWdnQ0RzbFl6cm9LVHNvN3pyaXBRZzZyaU43S0NWN1ppVklPcTFyT3loc091aG5DRHNqYWpzbXBRdURRb05DdXlZaUNrTkNpMGc3S2VBNnJpSUlPdXloT3lnaE95WGtPeUVuT3VLbENEc2s3Z2c3SWlZSU95WGh1eVd0T3lhbEM0ZzdJT2Q3TEswSU95ZHVPeW1uZXlkaENEc2s3RHJvS1RycWJRZzdKV3g3SjJFSU95MW5PeUxvQ0Ryc29Uc29JVHNuTHpyb1p3ZzdKZUY2NDJ3N0oyMDdZcTRJTzJWdE95anZPeUV1T3lhbEM0ZzRvYVNJT3lWc2V5ZGhDRHNsNFhyamJEc25iVHRpcmp0bGJUc283enNoTGpzbXBRdUlPeURuZXl5dENEc25ianNwcDNzbllRZzdKT3c2NkNrNjZtMElPeTFuT3lMb0NEcnNvVHNvSVRzbmJRZzdaV0U3SnFVN1pXMDdKcVVMZzBLRFFvNk9qb2dkR2x3SU8yTW5leVhoU0Ryc29UdGlyenNuWUFnV3pndUlPMk1uZXlYaFYwZzZyZWM3TG1aN0oyRUlPdVVzT3Vkdk95YWxBMEs3WXlkN0plRktPdUxwT3lkdE95V3ZPdWhuT3EzdUNrZzY3S0U3WXE4SU91c3VPcTFyT3VLbENEc2xZVHJucGdnS2lvNExpRHRqSjNzbDRVcUtpRHNoTG5zaFpnZzZyZWM3TG1aN0oyRUlPdVVzT3Vkdk95YWxDRGlnSlFnN1lhMTY3TzA2NHFVSUZ2dG1aWHNuYmhkTENEc21JZ3Y3SldFNjR1STdKaWtJTzJNa091THFPeWRnQ0JiN0pXRTY0dUk3SmlrWGNLM1crdUVwRjBzSU91UG1leWVrU0RzbktEcmo0VHJpcFFnVyt5M3FPeUdqRjNDdDF2cmo1bnNucEZkTGlBaTdMZW83SWFNSXV1S2xDRHJqNW5zbnBFZzY3S0U3WXE4NnJPOElPeW5uZXlkdkNEcmxZenJwNHdnN0pPdzZyT2dMQ0FpNjR1cjZyaXdJTUszSU91UG1leWVrU0xzc3Bqcm43d2c3S2VkN0oyMElPeVZpQ0RycDU3cmlwUWc3S0d3N1pXcDdKMkFJT3lUc095bmdDRHNsWXJzbFlUc21wUXVEUW82T2pvTkNnMEtJeU1qSU8yWW5PMkRuZXlkaENEcnNKdnNuWVFnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLN0ppSUtRMEtMU0RycXFqc25vVHNwNERzbTVEcXVJZ2c3SmVHN0oyMElPdXFxT3llaE8yR3RleWVwZXlkaENEcnA0enJrNlRxdVl6c21wUS9JT3luZ09xNGlDRHJzSnZzcDRBZzdKV0s3Snk4NjZtMElPdXFxT3llaE95bmdPeWJrT3E0aU95ZGhDRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzRnNG9hU0lPeVZ2ZXEwZ095WGtDRHJqNW5zblpqdGxaanJxYlFnNjZxbzdKNkU3S2VBN0p1UTZyaUk3SjJFSU91d20reWRoQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUW9qSXlNZzdaaWM3WU9kSU91TWdPeURnU0RzbFlqcmdyUU5DZzBLS2lyc2hKenJ1WVRzaXFUcmlwUWc3Sk80SU95SW1DRHNub2pzcDREcnA0d3NJTzJLdWV5Z2xTRHRtSnp0ZzUzc25ZQWc2N0NiN0oyRUlPeUltQ0RzbDRic25ZUWc2NVdNSU9LR2tpRHF1STNzb0pYdG1KVWc2Nnk0N0o2bDdKeTg2NkdjSU95TnFPeWFsQzRxS2cwSzdJS3M3SnFwN0o2UTY0cVVJT3VzdU9xMXJPdWx2Q0Rxdkx6cXZMenRub2dnN0oyOTdLZUFJT3lWaXVxem9DRHRtNUhzbHJUcnM3VHF1TEFvN0lxazdMcVVLU0RybFl6cnJManNsNUFzSU91MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzazdEcnFiUWc3S0NjN1pLSUlPeWdoT3l5dE91bHZDRHNrN2dnN0lpWUlPeVhodXVMcE9xem9DRHNtS1R0bGJUdGxaanF1TEFnN0ltczdKdU03SnFVTGcwS0RRcnNtSWdwRFFvdElPcXpoT3lpakNEcXNKenNoS1FnN1ppYzdZT2Q3SjJBSU91d20reWRoQ0RzaUpnZzdKZUc3SmEwN0pxVUxpRGlocElnTkM0MUpTRHF1SWpycHF3ZzdaaWM3WU9kNjZlTUlPdXdtK3lkaENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ05DNGc3THFRN0tPODdKYTg3WldjSU9xeXZleVd0QTBLRFFyc29KenRrb2dnN0pXSTdKZVE3SVNjSUNkKzdJdWM2cktnN0phMDdKcVVQeWNzSUNmc2k1enJncGpzbXBRL0p5d2dKMzdxdTVnbklPcXdtZXlkZ0NEcXM3enJqNFR0bFp3ZzZySzk3SmEwNjZXOElPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRcnN0WnpyaklEdGxad2c3THFRN0tPODdKYTg3WldZNnJPZ0lPeTVuT3Ezdk8yVm5DRHJwNUR0aUt6cnBid2c3Sk93NjRxVUlPcXlqQ0Rzb292c2xZVHNtcFF1RFFycXNyM3NsclRyaXBRZ1creVlpT3ladUNEcXQ1enN1WmxkS0NQc21JanNtYmd0TWkzcXNyM3NsclRycGJ3dDdJMm82NCtFTGV1UW1PdUtsQzNxc3Izc21yQXA3SmVRSU8yVnRPdUx1ZTJWb0NEcmxZenJwNHdnN0kybzdKcVVMZzBLRFFvakl5TWc2NCtaN0lLczdKZVE3SVNjSUNkKzdJdWNKeURydWJ6cXVMQU5DZzBLN0ppSUtRMEtMU0RzdWJUcms1enJwYndnN1pXMDdLZUE3WldZN0l1YzZyS2c3SmEwN0pxVVB5RGlocElnN0xtMDY1T2M2Nlc4SU8yVnRPeW5nTzJWb09xNWpPeWFsRDhOQ2kwZzdJdWM3SjZSN1pXWTdJdWM2NHFVSU91MmhPeVhrT3F5akNBMUxEQXdNT3lia095ZGhDRHJrNXpyb0tUc21wUXVJT0tHa2lEc2k1enNucEh0bFpqcnFiUWdOU3d3TUREc201RHNuWVFnNjVPYzY2Q2s3SnFVTGcwS0RRb2pJeU1nSitxemhPeUxuT3VMcENjZzRvYVNJQ2Zzbm9qcmk2UW5EUW9OQ3V5WWlDa05DaTBnN0o2UTY0K1o3TENvNjZXOElPcXdnT3luZ09xem9DRHFzNFRzaTV6cmdwanNtcFEvSU9LR2tpRHNucERyajVuc3NLanFzSUFnN0o2STY0S1k3SnFVUHcwS0xTRHJwNlRyaTZ3ZzY3TzA3WmVZNjZPTUlPeVd2T3VuaU95VXFTRHJnclRxczZBZzZyT0U3SXVjNjRLWTdKcVVQeURpaHBJZzY2ZWs2NHVzSU91enRPMlhtT3Vqak91S2xDRHNscnpycDRqc25ianFzSURzbXBRL0lDb282NHVvN0lpY0lPeTVtTzJabU95ZHRDRHNsWVRyaTRqcm5id2c2Nnk0N0o2bDdKMkVJT3lEaU91aG5DRHNrN1FnN0lLczY2R0E3SmlJN0pxVUtTb05DZzBLSXlNaklDZnNsNnpzcllqcmk2UW5JT0tHa2lBbjdabVY3SjI0N1pXWTY0dWtMQ0Ryckx2cmk2UW5EUW9OQ3V5WWlDa05DaTBnN0pXSTdLQ0U3WldjSU9xd25PMkd0ZXlkaENEc25JVHRsYlFnNjZxSDZyQ0E3S2VBSU91THBPeUxuQ0RzbDZ6c3JhVHJzN3pxc296c21wUXVJT0tHa2lEc2xZanNvSVR0bFp3ZzZyQ2M3WWExN0oyRUlPeWNoTzJWdENEcnFvZnFzSURzcDRBZzY0dWs3SXVjSU8yWmxleWR1TzJWb09xeWpPeWFsQzROQ2cwS0l5TWpJQ2ZxdTVnbklPS0draUFuN0plUTZyS01KdzBLRFFyc21JZ3BEUW90SU8yWmplcTR1T3VQbWV1TG1PcTdtQ0RyZ3FEc2xZVHFzSURxczZBZzdKNkk3SmEwN0pxVUxpRGlocElnN1ptTjZyaTQ2NCtaNjR1WTdKZVE2cktNSU91Q29PeVZoT3F3Z09xem9DRHNub2pzbHJUc21wUXVEUW9OQ2lNakl5RHFzcjNzbHJUcnBid2c2N3FRN0oyRUlPdVZqQ0RzbHJUc2c0bnRsWndnNnJLOTdKcXdEUW9OQ3V5Q3JPeWFxZXlla095ZG1DRHNvSlhyczdUcnBid2c2N0NiNjRxVUlPeW5pT3VzdU95WGtPeUVuQ0RxdUxEcXM0VHNvSUhzbkx6cm9ad2dKMzdzaTV3bjY2VzhJT3U2a095ZGhDRHJsWXdnNjZ5NDdKNmw3SjIwSU95V3RPeURpZTJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLS2lydGpJenNsWVh0bFpqcXM2QWc3SXUyN0oyQUlPeWdsZXV6dE91bHZDQW43S084N0phMEordWhuQ0RzamFqc2hKd2c2Nnk0N0o2bDdKMkVJT3lEaU91aHJlcXlqQ0RzamFqcnM3VHNoTGpzbXBRdUtpb05DZzBLN0ppSUtRMEtMU0RzbHJUcmxxUWc2NnFwN0tDQjdKeTg2NkdjSU91TWdPeTJuT3V3bSt5Y3ZPeUxuT3VDbU95YWxEOGc0b2FTSU91TWdPeTJuQ0RycXFuc29JSHNuYlFnNjZ5MDdKZUg3SjI0NnJDQTdKcVVQdzBLTFNEc2xyVHJscVFnN0oyMDdKeWc2NkdjSU95TG9PcXpvTzJWbU95TG5PdUNtT3lhbEQ4ZzRvYVNJT3lMb09xem9DRHNuYlRzbktEcnBid2c3SVNnN1lPZDdaVzBJT3lqdk95RXVPeWFsQzROQ2cwS0tpb3FEUW9OQ2lNaklEVXVJQ2Q3NjZxRjdJS3NmU0FySUh2cnFvWHNncXg5SnlEc2s3RHNwNEFnN0pXSzZyaXdEUW9OQ2lNakl5RHRsWnpzbnBEc2xyUWc3WktBN0phMDdKT3c2cml3RFFvTkN1MlZuT3lla095V3RDRHJxb1hzZ3F6cnBid2c3WktBN0phMDdJU2NJT3VQbWV5Q3JDRHRtSlh0ZzV6cm9ad2c3Sk80SU95SW1DRHNub2pzbHJUc21wUXVEUW9OQ3V5WWlDa05DaTBnN0oyMDdKNlFJTzJabU91MmlPeWRoQ0Ryc0p2c2xaanNsclRzbXBRZzRvYVNJT3lkdE95ZWtPdWx2Q0RyajR6cm9LVHJzSnZzbFpqc2xyVHNtcFFOQ2kwZzY0SzA3SjI4SU95NXRPdVRuT3F3a3V5ZHRDRHFzckRzb0p6cmtLQWc3SmlJN0tDVjdKMjA3SmVRN0pxVUlPS0draURyZ3JUc25ienNuWUFnN0xtMDY1T2M2ckNTSU91Q21PcXdnT3VLbENEcmdxRHNuYlRzbDVEc21wUU5DZzBLSXlNaklPMlZuT3lla095V3RPdWx2Q0R0a29Ec2xyVHNrN0RxdUxBZzdKYTA2NkNrN0pxNElPcXl2ZXlhc0EwS0RRb25lK3VxaGV5Q3JIM3FzSUFnZSt1cWhleUNySDN0bGJUc2hKd25JTzJZbGUyRG5PdWhuT3VuakNEdGtvRHNsclRzcEpqcmo0UWc2NDJVSU95NmtPeWp2T3lXdk8yVm1PcXlqQ0RzazdnZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc25wVHNsYUVnNjdhQTdLR3g3Snk4NjZHY0lPcTFyT3VucE8yVm1PeW5nQ0RycXJ2dGxvanNsclRzbXBRZzRvYVNJT3llbE95Vm9leWR0Q0RydG9Ec29iSHRsYlRzaEp3ZzZyV3M2NmVrN1pXWTdLZUFJT3VxdSsyV2lPeVd0T3lhbEEwS0RRb3FLaW9OQ2cwS0l5TWdOaTRnN1pHYzZyaXdJTzJHdGV5ZHZBMEtEUW9qSXlNZzY1Q1k3SmEwN0pxVUlDaFlLU0RpaHBJZzY0Kzg3SnFVSUNoUEtRMEtEUXJycXFqcnNKVHNuYndnN1ptVTY2bTA3SjJZSU95aWdleWRnQ0RxczdYcXNJVHNuWVFnNnJPZzY2Q2s3WlcwSUNmcmtKanNsclRzbXBRbjY0cVVJT3VxcU91UmtDQW42NCs4N0pxVUordWhuQ0R0aHJYc25ienRsYlRzaEp3ZzdJMm83S084N0lTNDdKcVVMZzBLRFFvcUtpb05DZzBLSXlNZ055NGc2NEtnN0tlY3dyZnNpNXpxc0lUQ3QreUlxK3lla0NEdGtaenF1TEFOQ2cwSzY0S2c3S2Vjd3Jmc2k1enFzSVRDdCt1eWlPMll1T3VLbENEc2xZVHJucGdnN1ppVjdJdWQ3Snk4NjZHY0lPMkd0ZXlkdk8yVnRPeUVuQ0RzamFqc21wUXVEUW9OQ2lNakl5RHJncURzcDV6Q3QreUxuT3F3aE1LMzZyaXc2ckNFRFFvTkNud2c3Wld0NjZxcElId2c3WmlWN0l1ZElId2c3SmlJN0l1Y0lId05Dbnd0TFMwdExTMThMUzB0TFMwdGZDMHRMUzB0TFh3TkNud2c2NEtnN0tlY0lId2c2cml3NjdPNElHQlpXVmxaTGsxTkxrUkVZQ0F2SU95bnArcXlqQ0JnVFUwdVJFUmdJSHdnTWpBeU5TNHdNUzR3TVN3Z01qVXVNREV1TURFZ2ZBMEtmQ0RzaTV6cXNJUWdmQ0RxdUxEcnM3Z2dZRWhJT2sxTk9sTlRZQ0F2SU95bnArcXlqQ0JnU0VnNlRVMWdJQ2pzbUtUc29JUXY3SmlrN1p1RUlPeVZpQ0RzbElBcElId2dNVFE2TXpBNk1URXNJREV6T2pNd0lId05DbndnNnJpdzZyQ0VJSHdnNnJpdzY3TzRJR0JaV1ZsWkxrMU5Ma1JFZmxsWldWa3VUVTB1UkVSZ0lDOGc3S2VuNnJLTUlHQlpXVmxaTGsxTkxrUkVmazFOTGtSRVlDQjhJREl3TWpVdU1ERXVNREYrTWpBeU5TNHdNUzR6TVN3Z01qQXlOUzR3TVM0d01YNHdNUzR6TVNCOERRcDhJT3VDb095bm5DQXJJT3lMbk9xd2hDQjhJR0JaV1ZsWkxrMU5Ma1JFSUVoSU9rMU5ZQ0I4SURJd01qVXVNREV1TURFZ01UUTZNekFnZkEwS2ZDRHNtcFRzbmJ3Z2ZDQmdXVmxaV1M1TlRTNUVSQ2pzbXBUc25id3BZQ0RpZ0pRZzdKdVVMKzJabEMvc2lKZ3Y2NnFwTCtxNGlDL3RocUF2N0oyOElId2dNakF5TlM0d01TNHdNU2pzaUpncElId05DZzBLS2lyc2k1enFzSVFnN0ppSTdKbTRLaW82SU95Q3JPeWFxZXlla09xd2dDRHNwNEhzb0pFZzZyT2c2NlcwNjRxVUlPdXdxZXVzdU1LMzdKaUk3Slc5SU95TG5PcXdoT3lkZ0NCZzdKaWs3S0NFTCt5WXBPMmJoQ0JJT2sxTllPeWRoQ0RzamFqcmo0UWc2NCs4N0pxVUxnMEs3SmlJS1NEc21LVHRtNFFnTVRvd01BMEtEUW9qSXlNZzY2eTQ3SjZsSU95R2pTRHNsN0RzbTVUc25id05DZzBLNjZ5NDdKNmxJT3lWaU95WGtPeUVuT3VLbENBcUt1eWJsTUszN0oyOElPeVZudXlkbUNBdzdKMkVJT3U1dk9xem9Db3FJT3lOcU95YWxDNE5DZzBLN0ppSUtRMEtMU0F5TURJMjY0V0VJREE0N0p1VUlEQTE3SjI4SU95ZWhldUxpT3VMcEM0ZzRvYVNJREl3TWpicmhZUWdPT3libENBMTdKMjhJT3llaGV1TGlPdUxwQzROQ2cwS0l5TWpJT3lEZ2V1TWdDRHNpNXpxc0lRZ0tPdUZ1T3kybk95YXFTa05DZzBLZkNEc29iRHFzYlFnZkNEdGtaenF1TEFnZkEwS2ZDMHRMUzB0TFh3dExTMHRMUzE4RFFwOElEWXc3TFNJSU91dnVPdW5qQ0I4SU91d3FlcTRpQ0Rzb0lRZ2ZBMEtmQ0EyTU91MmhDRHJyN2pycDR3Z2ZDQk82N2FFSU95Z2hDQjhEUXA4SURJMDdJdWM2ckNFSU91dnVPdW5qQ0I4SUU3c2k1enFzSVFnN0tDRUlId05DbndnTXpEc25id2c2Nis0NjZlTUlId2dUdXlkdkNEc29JUWdmQTBLZkNBeE11cXduT3libENEcnI3anJwNHdnZkNCTzZyQ2M3SnVVSU95Z2hDQjhEUXA4SURFeTZyQ2M3SnVVSU95ZHRPeURnU0I4SUU3cmhZUWc3S0NFSUh3TkNnMEs3SmlJS1NEcnNLbnF1SWdnN0tDRUxDQTE2N2FFSU95Z2hDd2dNdXlMbk9xd2hDRHNvSVFzSURQc25id2c3S0NFTENBMjZyQ2M3SnVVSU95Z2hDd2dNdXVGaENEc29JUU5DZzBLSXlNaklPdW5pT3F3a01LMzZyaXc2ckNFSU91bmpPdWpqQTBLRFFwZ1JDMU9ZQ2hPN0oyOElPdUNxT3lkakNrZ0x5QmdSQzB3WUNqc21LVHJpcGdnNjZlSTZyQ1FLU0F2SUdCRUswNWdLRTdzbmJ3ZzZySzk2ck84S1EwSzdKaUlLU0JFTFRjc0lFUXRNU3dnUkMwd0xDQkVLekVOQ2cwS0l5TWpJT3V5aU8yWXVDRHRrWnpxdUxBZ0tPMlZtT3lkdE8yVWlPeWN2T3VobkNEcXRhenJ0b1FwRFFvTkNud2c3Wld0NjZxcElId2c3WmlWN0l1ZElId2c3SmlJN0l1Y0lId05Dbnd0TFMwdExTMThMUzB0TFMwdGZDMHRMUzB0TFh3TkNud2c3S0NFN1ptVTY3S0k3Wmk0SUh3ZzdaV1k3SjIwN1pTSUlPcTFyT3UyaENCOElEQXlMVEV5TXpRdE5UWTNPQ3dnTURFd0xURXlNelF0TlRZM09DQjhEUXA4SU95NXRPdVRuT3V5aU8yWXVDQjhJRFRzbnBEcnBxenNsS2tnN1pXWTdKMjA3WlNJSUh3Z01USXpOQzAxTmpjNExUa3dNVEl0TXpRMU5pQjhEUXA4SU9xemhPeWlqT3V5aU8yWXVDQjhJTzJWbU95ZHRPMlVpQ0RxdGF6cnRvUWdmQ0F4TWpNdE5EVTJMVGM0T1RBeE1pQjhEUXA4SU95anZPdXZ2T3VUc2V1aG5ldXlpTzJZdUNCOElPeVZuaUEyN0o2UTY2YXNMZXVTcENBMzdKNlE2NmFzSUh3Z01USXpORFUyTFRFeU16UTFOamNnZkEwS2ZDRHNncXpzbDRYc25wRHJrN0hyb1ozcnNvanRtTGdnZkNBeE1PeWVrT3VtckNEdGxaanNuYlR0bElnZ2ZDQXdNUzB5TXpRdE5UWTNPRGtnZkEwS0RRb2pJeU1nN0pPdzY2bTBJT3lWaUNEcmtKanJpcFFnN1pHYzZyaXdEUW9OQ2kwZzY0S2c3S2VjN0plUUlPMlZtT3lkdE8yVWlNSzM2N21YNnJpSU9pRGluWXdnTWpBeU5TMHdNUzB3TVN3Z01ERXZNREVOQ2kwZzdJdWM2ckNFN0plUUlPeVlwT3lnaEMvc21LVHRtNFE2SU9LZGpDRHNtS1Rzb0lRZ01leUxuQ0FxS091THFDd2c3SUtzN0pxcDdKNlE2ckNBSU95bmdleWdrU0RxczZEcnBiVHJpcFFnNjdDcDY2eTR3cmZzbUlqc2xiMGc3SXVjNnJDRTdKMkFJT3lZaU95WnVDa3FEUW9OQ2lvcUtnMEtEUW9qSXlBNExpRHRqSjNzbDRVbzY0dWs3SjIwN0phODY2R2M2cmU0S1EwS0RRcnRqSjNzbDRVZzY2eTQ2cldzNjRxVUlDb3E3SmV0N1pXZ0tpb283WU9BN0oyMDdZdUF3cmZzbFlqcmdyVEN0K3V5aE8yS3ZDbnFzN3dnS2lyc25LRHRtSlVxS2lqdGhyWHJzN1F2N1l5UTY0dW9LZXlYa0NEcmxMRHJuYndnNjZ5NDdMSzA2ckNBSU91THJPdWR2T3lhbEM0ZzdZT0E3SjIwN1l1QTdKMkVJT3VMcE91VHJPeWRoQ0RybFpBZzY3Q1k2NU9jN0l1Y0lPeVZpT3VDdENqcnM3anJyTGdwNnJtTTdLZUFJT3F3bWV5ZHRDRHJzN1RxczZBc0lPdXp1T3VzdUNEcnA2WHJuYjNzbllRZzY0dTA3SldFN0pXOElPMlZ0T3lhbEM0TkNnMEtJeU1qSUREcmk2anFzNFFnNG9DVUlPMkt1T3Vtck9xeHNPdTJnTzJFc0NEcnRKRHNtcFFOQ2cwSzdZeWQ3SmVGN0oyMElPeUNyT3lhcWV5ZWtPeWRtQ0RzbHJUcmxxUWc3WmFKNjQrWklPdVNwT3lYa0NEcm5LanJpcFRzcDRBZzY2aTg3S0NBSU8yTWpPeVZoZTJWdE95YWxDNE5DZzBLTFNEdGxvbnJqNW5zbllRZ0tpcnFzSURyb1p6cnA0bnFzYkRyZ3BnZzdZeVE2NHVvN0oyRUlPeWFsT3ExckNvcUtPeWR0TzJEaU1LMzdJS3Q3S0Njd3Jmcm9aenF0N2pzbFlUc200UEN0K3lpaGV1ampDa2c0b2FTSUNvcTdZeVE2NHVvN1ppVktpb2dLT3Vzdk95V3RPdTBrT3lhbENrTkNpMGc2ckt3NnJPOHdyZnNnNEh0ZzV6cnBid2dLaXJ0aHJYcnM3VHJwNHdxS2lBbzdKbUU2Nk9Nd3Jmc2k2VHRqS2dwSU9LR2tpQXFLdXlWaU91Q3RPMllsU29xSUNqc2xZenJvS1RzcEpqc21wUXBEUW9OQ2lNakl5RHRnNERzbmJUdGk0QWc0b0NVSU95bnAreWRnQ0RycW9Yc2dxenF0YXdOQ2cwS0xTRHJxb1hzZ3F6dG1KWHNuTHpyb1p3ZzY0R2Q2NEswN0pxVUxpRHNvb1hxc3JEc2xyVHJyN2pDdCt1bmlPeTVxTzJSbk91bHZDRHNrN0RzcDRBZzdKV0s3SldFN0pxVUlDaCs3SnFVSUM4Z2Z1dUxwQ0F2SUg3cXVZenNtcFEvSU9LZGpDa3VEUW90SURKK05PeVd0T3lnaU91aG5DRHNwNmZxczZBZzdJbTk2cktNTGlEdGxaenNucERzbHJUQ3QreUltT3lMbmV5ZGhDRHF1TGpxc293ZzdJeVQ3S2VBSU95Vml1eVZoT3lhbEM0TkNpMGc3SldJNjRLMEtPdXp1T3VzdUNrZzY2ZWw2NTI5N0oyRUlPeWFsT3lWdmUyVnRDd2dLaXJ0ZzREc25iVHRpNERycDR3ZzY3U1E2NCtFSU91c3RPeUtxQ0R0akozc2w0WHNuYmpzcDRBcUtpRHNsWXpxc293ZzdaVzA3SnFVTGlEc201RHJzN2pzbmJRZ0oreVZqT3Vtdk1LMzdabVY3SjI0Sit5eW1PdWZ2Q0RycDRuc2w3RHRsWmpycWJRZzY3TzQ2Nnk0N0oyRUlPcTN2T3F4c091aG5DRHF0YXpzc3JUdG1aVHRsYlRzbXBRdURRb05DbndnN0oyMDY2Q0g2cktNSU91bmtPcXpvQ0I4SU95ZHRPdWdoK3F5akNCOERRcDhMUzB0ZkMwdExYd05DbndnN0tDQTdKNmw3WldZN0tlQUlPeVZpdXF6b0NEcmdwanFzSURzaTV6cXNxRHNsclRzbXBRL0lId2c3S0NBN0o2bElPeVZpQ0R0bFp3ZzY0SzA3SnFwSUh3TkNud2c3SldNNjZhOElId2c2ckt3N0tDY0lPeVpoT3VqakNCOERRcDhJT3lnbGV1bmtDRHNncTNzb0p6dGxaanNpNXpxc3FEc2lyWHJpNGpxdVl3L0lId2c2NDJ3N0oyMDdZU3dJT3lDcmV5Z25DQjhEUW9OQ2lNakl5RHNsWWpyZ3JRbzY3TzQ2Nnk0S1NEaWdKUWc3WlcwN0pxVTdMSzBEUW9OQ2kwZ0tpcnRqSkRyaTZqdG1KVXFLdXlkZ0NBbmZ1MlZvT3E1ak95YWxEOG42NkdjSU91c3ZPeVd0T3lhbEM0ZzY1Q1k2NCtNNjZhMElPeUltQ0RzbDRicmlwUWc3SnlFN1plWUtPeUNyZXlnbk1LMzdZT0k3WWUwSU91VHNTbnNuWUFnNnJLdzZyTzg2Nlc4SU91b3ZPeWdnQ0Rxc3IzcXM2RHRsYlRzbXBRdURRb3RJQ29xN0pXSTY0SzA3WmlWS2lyc25ZQWc3SUtzN0l1azdKMkVJT3lFbk95SW9PMlZ0T3lhbEM0TkNpMGc2NmVJN0xtbzdaR2M2Nlc4SU95TnFPeWFsQzRnN0lpcjdKNlF3cmZzb2JEcXNiUW83SjIwN0lPQndyZnNuYlR0bFpqQ3QreWR0T3VDdENEcms3RXA3SjJBSU9xM3VPdU1nT3VobkNEcmtaRHFzNkFzSU95YmtPdXN1T3lYa0NEc2w0YnJpcFFnN0tDVjY3TzB3cmZzb0lqc3NLakN0K3lYc091ZHZleXltT3VsdkNEc3A0RHNsclRyZ3JUc3A0QWc3SldLN0pXRTdKcVVMZzBLRFFvakl5TWc2N0tFN1lxOElPS0FsQ0RzbFlqcmdyUWc2Nnk0NjZlbDdKMjBJT3lnbGUyVnRPeWFsQTBLRFFwOElPdXp1T3VzdU95ZHRDRHNuYlRyb0lmcmk2UWdmQ0Ryc29UdGlyd2dmQTBLZkMwdExYd3RMUzE4RFFwOElPcXlzT3F6dk1LMzdJT0I3WU9jNjZXOElPMkd0ZXV6dENCOElGdnRtWlhzbmJoZElId05DbndnSjM3dGxhRHF1WXpzbXBRL0ordWhuQ0Ryckx6c25Zd2dmQ0JiN0pXRTY0dUk3SmlrWFNEQ3R5QmI2NFNrWFNCOERRcDhJT3lEZ2UyWnFTRHNoSnpzaUtBZ0t5RHNtS1RycGJqc3FyM3NuYlFnN0l1azdLQ2NJT3VQbWV5ZWtTQjhJRnZzdDZqc2hveGRJTUszSUZ0NzY0K1o3SjZSZlYwZ2ZBMEtEUW90SUNmc3Q2anNob3duNjRxVUlDb3E2NCtaN0o2UklPdXloTzJLdk9xenZDRHNwNTNzbmJ3ZzY1V002NmVNS2lvZzdJMm83SnFVSUNqc21JZzZJRnZzdDZqc2hveGR3cmRiN0lLdDdLQ2NYU2t1SUNmcmk2dnF1TEFnd3JjZzY0K1o3SjZSSit5eW1PdWZ2Q0RzcDUzc25iUWc3SldJSU91bm51dUtsQ0Rzb2JEdGxhbnNuYlRyZ3BnZzY0dW82NCtGSUNmc3Q2anNob3duNjRxVUlPeVRzT3luZ0NEc2xZcnNsWVRzbXBRdURRb3RJT3V5aE8yS3ZPeWRtQ0RyajVuc25wRWc3SjIwNjZhRTdKMkFJTzJabE91cHRDRHF1TERyaXFYcnFvVW82N09BNnJLOXdyZnRsYlRzb0p3ZzY1T3hLZXlkaENEcXQ3anJqSURyb1p3ZzdJSzA2NkNrN0pxVUxnMEtEUW9qSXlNZzdZYTE3S2VjSU95WWlPeUxuQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0oyMDdZT0lLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHNvSURzbnFVZzdKV0lJTzJWbkNEcmdyVHNtcWtOQ2kwZzdKV0k2NEswT2lEc29JRHNucVh0bFpqc3A0QWc3SldLNnJPZ0lPdUNtT3F3aU9xNWpPeWFsRDhnN0o2RjY2Q2w3WldjSU91Q3RPeWFxZXlkdENEc2dxenJuYnpzb0xqc21wUXVEUW90SU91eWhPMkt2RG9nN0pXRTY0dUk3SmlrSU1LM0lPdUVwQTBLRFFvcUt1Mk1rT3VMcU8yWWxTRGlnSlFnN0lLdDdLQ2NJQ2pzbklUdGw1Z3BLaW9OQ2kwZzdZT0E3SjIwN1l1QU9pRHJqYkRzbmJUdGhMQWc3SUt0N0tDY0RRb3RJT3lWaU91Q3REb2c3SUt0N0tDYzdaV1k2Nm0wSU91THBPeUxuQ0RzZ3JUcnByUWc3SWlZSU95WGh1eVd0T3lhbEM0ZzdJS3Q3S0NjN1pXZzZybU03SnFVUHcwS0xTRHJzb1R0aXJ3NklPeVZoT3VMaU95WXBDREN0eURyaEtRTkNnMEtLaXJyajVuc25wSHRtSlVnNG9DVUlPeUVuT3lJb0NBcklPdVBtZXlla1NEcnNvVHRpcndxS2cwS0xTRHRnNERzbmJUdGk0QTZJT3E0c09xNHNDRHNsN0Rxc3JBZzdaVzA3S0NjRFFvdElPeVZpT3VDdERvZzdJU2c3WU9kN1pXY0lPcTRzT3E0c095ZG1DRHNsN0Rxc3JEc25ZUWc2NEdLN0phMDdKcVVMZzBLTFNEcnNvVHRpcnc2SU95M3FPeUdqQ0RDdHlEc2w3RHFzckFnN1pXMDdLQ2NEUW9OQ2lvcTdKV0k2NEswN1ppVklPS0FsQ0RzbVlUcm80d2c3WWExNjdPMEtpb05DaTBnN1lPQTdKMjA3WXVBT2lEcXNyRHNvSndnN0ptRTY2T01EUW90SU95VmlPdUN0RG9nNnJLdzdLQ2M2ckNBSU95Z2xleURnU0Rzc3BqcnBxenJrSkRzbHJUc21wUXVEUW90SU91eWhPMkt2RG9nN1ptVjdKMjREUW9OQ2lvcUtnMEtEUW9qSU95WWlPeVp1Q0RxdDV6c3Vaa05DZzBLN0p1UTdMbVpLT3VLcGV1UG1jSzM2cmlON0tDVndyZnN1cERzbzd6c2xyd3A2N08wNjR1a0lPeVlpT3ladU9xd2dDRHJqWlFnNjZxRjdabVY3WldjSU95N3BPdXVwT3VMaU95OGdPeWR0T3lGbU95ZGhDRHJwNHpyazV6cmlwUWc2cks5N0pxdzdKaUk3SnFVTGcwS0RRb2pJeURzbUlqc21iZ2dNUzRnN0lpWTY0K1o3WmlWSU91c3VPeWVwZXlkaENEc2phanJqNFFnNjVDWTY0cVVJT3F5dmV5YXNBMEtEUW9qSXlNZzdJU2M2N21FN0lxa0lPeWloZXVqakN3ZzZyaXc2ckNFSU91bmpPdWpqQTBLRFFyc2lKanJqNW50bUpYc25MenJvWndnN0pPdzY2bTBJT3lqdk95V3RDanNvb1hybzR3ZzdJU2M2N21FN0lxa0xDRHF1TERxc0lRZzY1T3hLZXVsdkNEcXNKWHNvYkR0bGFBZzdJaVlJT3llaU9xem9Dd2dKK3lpaGV1ampDZnNtWUFnSit1bmpPdWpqQ2ZzblpnZzY0bVk3SldaN0lxazY2VzhJT3lnbGUyWmxlMmVpQ0Rzb0lUcmk2enRsYUFnN0lpWUlPeWVpT3lXdE95YWxDNE5DZzBLN0ppSUtRMEtMU0JQVDA4ZzdJU2M2N21FN0lxa0lPeWloZXVqakNEc2xZanJnclFnNG9DVUlEQXc3SnVVSURBdzdKMjg2N2FBN1lTd0lPeUVuT3U1aE95S3BPcXdnQ0Rzb29Ycm80enJqN3pzbXBRdUlPeWVrT3lFdU8yVm5DRHJnclRzbXFuc25ZUWc3SldNNjZDazY1T2M2NkNrN0pxVUxnMEtMU0RzbnBEc2dyQWc3S0d3N1pxTUlPcTRzT3F3aE95ZHRDRHFzNmNnNjZlTTY2T002NCs4N0pxVUxnMEtEUXJyaTZnc0lDb3E3S084NnJpdzdLQ0I3Snk4NjZHY0lPeWloZXVqak9xd2dDRHJzSmpyczdYcmtKanJpcFFnN0tDYzdaS0lLaXJzbDVEcmlwUWdKK3lpaGV1ampPdVB2T3lhbENmcnBid2c3Sk93N0tlQUlPeVZpdXlWaE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbUtUcmlwanNuWmdnN1lDMDdLYUk2ckNBSU9xenB5RHNvb1hybzR6cmo3enNtcFFnNG9hU0lPeVlwT3VLbU95ZG1DRHRnTFRzcG9qcXNJQWc2ck9uSU91Qm5ldUNtT3lhbEEwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0plUTZyS01JT3V2dU95NW1PdUtsQ0RzbUlIdGxxWHNuWVFnN0pXTTY2Q2s3S1NFSU91VmpBMEtEUW9vN0tPODdKcVVJT3VQbWV5Q3JDQTZJT3lYc095eXRDd2c3WlcwN0tlQUxDRHNvSUhzbXFrZzY1T3hLUTBLRFFyc2lKanJqNW50bUpYc25MenJvWndnN0pPdzY2bTBJT3lkdU9xenZDRHF0SURxczRUcnBid2c2NnFGN1ptVjdaV1k2cktNSU95RXBPdXFoZTJWbU9xem9Dd2dKK3lDck95YXFleWVrT3lkbUNEdGxvbnJqNW5zbDVBZzY1U3c2NTI4N0ppazY0cVVJT3F5c09xenZDZnJuYnpyaXBRZzdLQ1E3SjJFSU95VmpPdWdwT3lraENEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95WXBPdUttT3E1ak95bmdDRHJnclRzcDRBZzdKV0s3Snk4NjZtMElPeVhzT3l5dE91UHZPeWFsQzRnN1p1RTY3YUk2ckt3N0tDY0lPcTRpT3lWb2V5ZGhDRHJnclRzbzd6c2hManNtcFF1RFFvdElPdU1nT3kybk95ZGhDRHFzSWpzbFlUdGc0RHJxYlFnN0p1UTY1NllJT3VNZ095Mm5PeWR0Q0R0bGJUc3A0RHJqN3pzbXBRdUlPeVlwT3VLbUNEcmdxRHNwNXpxdVl6c3A0RHNuWmdnN0oyMDdKNlE2Nlc4SU95ZGdPMldpZXlYa0NEcmdyVHNsYndnN1pXMDdKcVVMZzBLRFFvakl5TWc3SUtzN0pxcDdKNlFJT3lWaU95THJDQW83SWlZNjQrWjdaaVZLUTBLRFFvbjdLQ1Y2N08wSU95SW1PeW5rU0RzbFlqcmdyUW5JT3VUc2V5ZG1DRHJyN3pxc0pEdGxad2c3SU9CN1ptcDdKZVE3SVNjSUNvcTdJdWM3SXFrN1lXYzdKMjBJT3lla091UG1leWN2T3VobkNEc3NwanJwcXp0bFp6cmk2VHJpcFFnN0tDUUtpcnNuWVFnN0lpWTY0K1o3WmlWN0p5ODY2R2NJT3lWak91Z3BDRHNncXpzbXFuc25wRHJwYndnN0pXSTdJdXM3WldZNnJLTUlPMlZvQ0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJT3lkdE95Z25PdTJnTzJFc0NEdG1ZM3F1TGpyajVucmk1anNuWmdnNnJDYzdKMjQ3S0NWNjdPMElPeWR0T3lhcVNEcmdyVHNsNjNzbmJRZzZyaXc2NkdkNjQrODdKcVVEUW90SU91TmxDRHNvb3ZzbllBZzdJT0I2NHUwN0oyRUlPeWNoTzJWdENEdGhyWHRtWlFnNjRLMDdKcXA3SjJBSU91RnVleWRqT3VQdk95YWxBMEtEUW9qSXlEc21JanNtYmdnTWk0ZzZySzk3SmEwNjZXOElPeU5xT3VQaENEcmtKanJpcFFnNnJLOTdKcXdEUW9OQ3UyS3VleWdsU0RzZzRIdG1hbnNsNURzaEp3ZzdLQ2M3WldjN0tDQjdKeTg2NkdjSUNmc2k1enJncGpzbXBRL0xDRHNoYWpyZ3Bqc21wUS9KeURzblpqcnJManRtSlVnN0phMDY2KzQ2Nlc4SU95VHVDRHNpSmdnN0o2STdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRN0oyWUlPdW5wZXVkdmV5ZGhDRHRtWnpzbXFudGxiVHNoSndnN0tlSTY2eTQ3WldnSU91VmpBMEtEUW9uN0l1YzY0S1k3SnFVUHljc0lDZnNoYWpyZ3Bqc21wUS9KeUR0bUpYdGc1enNuWmdnNnJLOTdKYTA2Nlc4SU8yWm5PeWFxZTJWdE95RW5DRHNncXpzbXFuc25wRHNuWmdnNjR1NTdabXA3SXFrNjUrczdKdUE3SjJFSU95a2hPeWR2Q0RzaUpnZzdKNkk3SmEwN0pxVUxnMEtEUXJzbUlncERRb3RJTzJaamVxNHVPdVBtZXVMbUN3Z1QwOVBJT3VMcE91RmdPeVlwT3lGcU91Q21PeWFsRDhOQ2kwZzdMYXA3S0NFN1pXWTY1K3NJTzJPdU95ZG1PeWdrQ0Rxc0lEc2k1enJncGpzbXBRL0RRb05DaU1qSXlEc2dxenNtcW5zbnBEc25aZ2c3SU9CN1ptcDdKMkVJT3kybE95Z2xlMlZvQ0RybFl3TkNnMEs2NnFGN1ptVjdaV2NJT3lnbGV1enRPcXdnQ0RzbDRic2xyVHNoSndnN0lLczdKcXA3SjZRN0plUTZyS01JT3luZ2V5Z2tTRHRqSkRyaTZqdGxaanFzb3dnN1pXMDdKVzhJTzJWb0NEcmxZd2c2cks5N0phMDY2R2NJT3lnbGV5a2tlMlZtT3F5akNEc3A0anJyTGp0bGFBZzdJaVlJT3llaU95V3RPeWFsQzROQ2cwSzdKaUlLUTBLTFNEc3ViVHJrNXpycGJ3ZzY3Q2I3Snk4N0lXbzY0S1k3SnFVUHlEcms3SHJvWjN0bFpqcnFiUWc3THFRN0l1YzY3Q3hJTzJZbk8yRG5leWRoQ0Ryc0p2c25ZUWc3SWlZSU95ZWlPeVd0T3lhbEM0TkNnMEtJeU1qSU95Q3JPeWFxZXlla095ZG1DRHNoS0RzblpqcXNJQWc3WldFN0pxVTdaV2dJT3VWakEwS0RRcnNoS1Ryckxqc29iRHNncXpzc3Bqcm43d2c3SUtzN0pxcDdKNlE3SjJZSU95RW9PeWRtT3VsdkNEcXVMRHJqSUR0bGJUc2xid2c3WldnSU91VmpDRHFzcjNzbHJUcm9ad2c3S0NWN0tTUjdaV1k2cktNSU95bmlPdXN1TzJWdE95YWxDNE5DZzBLN0ppSUtRMEtMU0RzbmJUcnNvZ2c2NHVzN0plUUlPeUVuT3U1aE95S3BPdWx2Q0RzbmJUc21xbnRsWmpycWJUc2hKd2c3SmE4NjZlSTY0S1lJT3Vuak95aHNlMlZtT3lGcU91Q21PeWFsRDhOQ2cwS0l5TWc3SmlJN0ptNElETXVJT3UyZ095Z2xlMllsU0Ryckxqc25xWHNuWVFnN0kybzY0K0VJT3VRbU91S2xDRHFzcjNzbXJBTkNnMEs3SUtzN0pxcDdKNlE3SmVRNnJLTUlPdXFoZTJabGUyVm1PcXlqQ0RydG9Ec29KWHNvSUhzbmJnZzY0SzA3SnFwN0oyRUlPeVZqT3VncE95a21PeVZ2Q0R0bGFBZzY1V002NHFVSU91MmdPeWdsZTJZbFNEcnJManNucVhzbllRZzdJMm82NCtFSU95aWkreVZoT3lhbEM0TkNnMEtJeU1qSU95RW5PdTVoT3lLcE91bHZDRHNvSlhzc1lYc2c0RWc3Sk80SU95SW1DRHNsNGJzbllRZzY1V01EUW9OQ3V1MmdPeWdsZTJZbGV5Y3ZPdWhuQ0RzamFqc2xid2c3SUtzN0pxcDdKNlE3SmVRNnJLTUlPeURnZTJacWV5ZGhDRHJxb1h0bVpYdGxaanFzb3dnN0oyNDdLZUE3SXVjN1lLc0lPeUltQ0Rzbm9qc2xyVHNtcFF1SUNvcTdKTzRJT3lJbUNEc2w0YnJpcFFnN0oyMDdKeWc2Nlc4SU8yVnFPcTdtQ0RzbFlqcmdyVHRsYlRzbzd6c2hManNtcFF1S2lvTkNnMEs3SmlJS1EwS0xTRHNwNERxdUlqc25ZQWc2ckNBN0o2RjdaV2dJT3lJbUNEc2w0YnNsclRzbXBRdUlPeXlyZXlHak91RmhPeWRoQ0RzbklUdGxad2c3SVNjNjdtRTdJcWs2NHFVSU95VmhPeW5nU0RzcElEcnVZUWc3S1NSN0oyMDdKZVE3SnFVTGcwS0xTRHFzN1hyckxUc201RHNuWUFnN1p1RTdKdVE2cmlJN0oyRUlPdXp0T3VDdkNEc2lKZ2c3SmVHN0phMDdKcVVMZzBLRFFvakl5TWc3SjI4NjdhQUlPcTRzT3VLcGV1bmpDRHNrN2dnN0lpWUlPeVhodXlkaENEcmxZd05DZzBLNjdhQTdLQ1Y3WmlWN0p5ODY2R2NJT3lOcU95VnZDRHNncXpzbXFuc25wRHFzSUFnN0phMDY1YWtJT3E0c091S3BleWRoQ0RzazdnZzdJaVlJT3lYaHV1S2xPeW5nQ0RycW9YdG1aWHRsWmpxc293ZzdKMjQ3S2VBN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdLQ1E2cktBSU9xNHNPcXdoQ0RyajVuc2xZZ2c3SVNjNjdtRTdJcWs2Nlc4SU95ZHRPeWFxZTJWb0NEc2lKZ2c3SmVHN0phMDdKcVVMZzBLTFNEc2k2RHJ0b1RzcHAwZzdabVY3SjI0NjVDWTZyaXdJT3lnaE9xNWpPeW5nQ0RzaHFIcXVJanFzN3dnNnJLdzdLQ2M2Nlc4SU8yVm9DRHNpSmdnN0plRzdKYTA3SnFVTGcwS0RRb2pJeU1nN0lLczdKcXA3SjZRSU95RW9PMkRuZXlkbUNEcXNyRHFzN3pycGJ3ZzdKV0k2NEswN1pXZ0lPdVZqQTBLRFFycmtKanJqNHpycHJRZzdJaVlJT3lYaHV1S2xDRHNoS0R0ZzUzc25ZQWc2N2FBN0tDVjdaaVY3Snk4NjZHY0lPdXFoZTJabGUyVm1PcXlqQ0RzbFl6cm9LVHNtcFF1RFFvTkN1eVlpQ2tOQ2kwZzdaV2NJT3V5aUNEcnNKVHF2cmpycWJRZzdMcVE3SXVjNjdDeDdKMkFJT3VMcE95TG5DRHJzSnZzbllRZzdJaVlJT3lYaHV5V3RPeWFsQzROQ2cwS0l5TWpJT3lDck95YXFleWVrQ0RzbFlqc2k2d2dLT3UyZ095Z2xlMllsU2tOQ2cwS0oreWdsZXV6dENEc2lKanNwNUVnN0pXSTY0SzBKeURyazdIc25aZ2c2Nis4NnJDUTdaV2NJT3lEZ2UyWnFleVhrT3lFbkNBcUt1eWdsZXV6dE9xd2dDRHJzN1R0bUxqcmtKenJpNlRyaXBRZzdLQ1FLaXJzbllRZzY3YUE3S0NWN1ppVjdKeTg2NkdjSU95VmpPdWdwQ0RzZ3F6c21xbnNucERycGJ3ZzdKV0k3SXVzN1pXWTZyS01JTzJWb0NEc2lKZ2c3SjZJN0phMDdKcVVMZzBLRFFyc21JZ3BEUW90SU95RGdldUx0T3lkdENEcmdaM3JncGpycWJRZzdLQ0U2Nnk0NnJDQTY0K0VJTzJaamVxNHVPdVBtZXVMbU95ZG1DRHNvSlhyczdUcnBid2c2N084SU95SW1DRHNsNGJzbHJUc21wUXVEUW90SU8yWmplcTR1T3VQbWV1TG1PeWRtQ0Rzb0pYcnM3VHFzSUFnNnJpdzY2R2Q2NUNZN0tlQUlPeVZpdXlWaE95YWxDNE5DZzBLSXlNZzdKaUk3Sm00SURRdUlPeWduTzJTaUNEc21xbnNsclRyaXBRZzY3Q1U2cjY0N0tlQUlPeVZpdXE0c0EwS0RRb242ckNFNnJLdzdaV1k2ck9nSU95SnJPeWF0Q0RycDVBbklPeWJrT3k1bWV1enRPdUxwQ0FxS3UyWmxPdXB0T3lkbUNEcXVMRHJpcVhycW9YQ3QrdXloTzJLdk91cWhlcXp2T3lkbUNEc21xbnNsclFnN0oyODdMbVlLaXJxc0lBZzdKcXc3SVNnN0oyMDdKZVE3SnFVTGcwSzZyaXc2NHFsNjZxRjdKZVFJT3lUc095ZHVDRHJpNmpzbHJRbzY3T0E2cks5TENEc3A0RHNvSlVzSU91VHNldWhuU0RyazdFcDY2VzhJT3lWaU91Q3RDRHJyTGpxdGF6c2w1RHNoSndnNjR1azY2VzRJT3Vua091aG5DRHJzSlRxdnJqcnFiUWc3SUtzN0pxcDdKNlE2ckNBSU91THBPdWx1Q0RxdUxEcmlxWHNuTHpyb1p3ZzdKaWs3WlcwN1pXZ0lPeUltQ0Rzbm9qc2xyVHNtcFF1RFFvTkN1eVlpQ2tnSitxMmpPMlZuQ0RyczREcXNyMG5JT3E0c091S3BleWRtQ0RzbFlqcmdyUWc2Nnk0NnJXc0RRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N0NVNnIrQUlPeUltQ0Rzbm9qc2xyVHNtcFFnS0ZncERRb3RJT3VMcE91bHVDRHNncXpybm96c25ZUWc2NmVJN0lxazdZU3dJT3EwZ091bXJPeWVrT3VobkNEc3A0RHNvSlh0bFpqcnFiUWc2N09BNnJLOTdaV2dJT3lJbUNEc25vanNsclRzbXBRZ0tFOHBEUW9OQ2lNaklPeVlpT3ladUNBMUxpRHNpNXpzaXFUdGhad2c2NCtaN0o2UjZyTzhJT3VMcE91bHVDRHJqNW5zZ3F3ZzdKT3c3S2VBSU95Vml1cTRzQTBLRFFycnJManF0YXpycGJ3ZzdKV0U2NnkwNjZhc0lPdW5wT3VCaE91ZnZlcXlqQ0RyaTZUcms2enNsclRyajRRZ0tpcnNpNlRzb0p3ZzdJdWM3SXFrN1lXY0lPdVBtZXlla2VxenZDRHJpNlRycGJnZzY0K1o3SUtzS2lycnBid2c3Sk93NjZtMElPeWVtT3VxdSt1UW5DRHJyTGpxdGF6c21JanNtcFF1RFFvTkN1eVlpQ2tnNjZlSTdJcWs3WVN3SU9xMGdPdW1yT3lla091bHZDQW43TGFVNnJDQUlPeW5nT3lnbFNmdGxaanJpcFFnN0l1YzdJcWs3WVdjN0plUTdJU2NJQ2pzbmJUc29JVEN0K3lXa2V1UGhDRHF1TERyaXFYc25iUWc3SldFNjR1WUtRMEtMU0RyaTZUcnBiZ2c3SUtzNjU2TTdKZVE2cktNSU91bmlPeUtwTzJFc0NEcXRJRHJwcXpzbnBEcnBid2c2NFNZNnJLbzdLTzg3SVM0N0pxVUlDaFlJT0tBbENEc2w0YnJpcFFnSit1RW1PcTRzT3E0c0NjZzZyaXc2NHFsN0oyRUlPeVZsT3lMbkNrTkNpMGc2NHVrNjZXNElPeUNyT3Vlak95ZGhDRHJwNGpzaXFUdGhMQWc2clNBNjZhczdKNlE2NkdjSU95bmdPeWdsZTJWdENEc283enNoTGpzbXBRZ0tFOHBEUW89JwpESVI9IiRIT01FL0xpYnJhcnkvQXBwbGljYXRpb24gU3VwcG9ydC9DbGF1ZGVCcmlkZ2UiCnB1dCgpIHsgcHJpbnRmICVzICIkMSIgfCBiYXNlNjQgLUQgPiAiJDIiOyB9CiMg7J20IC5jb21tYW5k6rCAIOuPhOuKlCDthLDrr7jrhJAg7LC966eMIOqzqOudvCDri6vripTri6QodHR5IOunpOy5rSkuIGJhc2jqsIAg64Gd64KYIO2DreydtCBpZGxl65CcIDHstIgg65Kk7JeQIOuLq+yVhAojICLtlITroZzshLjsiqQg7Iuk7ZaJIOykkSIg6rK96rOg66W8IO2UvO2VnOuLpCDigJQgZGlzb3du7Jy866GcIOyKpO2BrOumve2KuOqwgCBleGl07ZW064+EIOuLq+q4sCDsnpHsl4XsnYAg7IK07JWE64Ko64qU64ukLiAo66elIOyLpOq4sCDqsoDspp0g7ZWE7JqUKQpNWVRUWT0iJChwcyAtbyB0dHk9IC1wICQkIDI+L2Rldi9udWxsIHwgdHIgLWQgIiAiKSIKY2xvc2VfdGVybWluYWwoKSB7CiAgWyAteiAiJE1ZVFRZIiBdICYmIHJldHVybgogICggc2xlZXAgMQogICAgL3Vzci9iaW4vb3Nhc2NyaXB0ID4vZGV2L251bGwgMj4mMSA8PE9TQQp0ZWxsIGFwcGxpY2F0aW9uICJUZXJtaW5hbCIKICByZXBlYXQgd2l0aCB3IGluIHdpbmRvd3MKICAgIHRyeQogICAgICByZXBlYXQgd2l0aCB0IGluIHRhYnMgb2YgdwogICAgICAgIGlmIHR0eSBvZiB0IGlzICIvZGV2LyRNWVRUWSIgdGhlbiBjbG9zZSB3IHNhdmluZyBubwogICAgICBlbmQgcmVwZWF0CiAgICBlbmQgdHJ5CiAgZW5kIHJlcGVhdAplbmQgdGVsbApPU0EKICApICYgZGlzb3duIDI+L2Rldi9udWxsIHx8IHRydWUKfQojIOyViOuCtOuKlCDtlIzrn6zqt7jsnbjsnbQg67O07Jes7KSA64ukIOKAlCDthLDrr7jrhJDsnYAg7ISk7LmYwrfsoJDqsoDrp4wg7ZWY6rOgIOyKpOyKpOuhnCDri6vtnozri6QuCmZpbmlzaCgpIHsgY2xvc2VfdGVybWluYWw7IGV4aXQgIiQxIjsgfQplY2hvICLtgbTroZzrk5wg7Luk64Sl7YSw66W8IOyEpOy5mO2VmOqzoCDsnojslrTsmpTigKYg7J6g7IucIO2bhCDsnbQg7LC97J2AIOyekOuPmeycvOuhnCDri6vtmIDsmpQuIgpta2RpciAtcCAiJERJUi9zY3JpcHRzIiB8fCB7IGVjaG8gIu2PtOuNlCDsg53shLEg7Iuk7YyoOiAkRElSIjsgZmluaXNoIDE7IH0KcHV0ICIkQjY0X0JSSURHRSIgICAiJERJUi9zY3JpcHRzL2NsYXVkZS1icmlkZ2UuanMiCnB1dCAiJEI2NF9XQVRDSEVSIiAgIiRESVIvc2NyaXB0cy9icmlkZ2Utd2F0Y2hlci5qcyIKcHV0ICIkQjY0X0VYQU1QTEVTIiAiJERJUi9yZWNvbW1lbmQtZXhhbXBsZXMubWQiCnB1dCAiJEI2NF9HVUlERSIgICAgIiRESVIvdXgtd3JpdGluZy5tZCIKZWNobyAi4pyFIO2MjOydvCDshKTsuZg6ICRESVIiCiMgR1VJ7JeQ7IScIOyXsCBUZXJtaW5hbOydgCBQQVRI6rCAIOyigeydhCDsiJgg7J6I7Ja0IO2dlO2VnCDshKTsuZgg6rK966Gc66W8IOuztO2DoOuLpApleHBvcnQgUEFUSD0iJEhPTUUvLmxvY2FsL2Jpbjovb3B0L2hvbWVicmV3L2JpbjovdXNyL2xvY2FsL2JpbjokUEFUSCIKIyBub2Rl6rCAIOyXhuycvOuptCDqsJDsi5zsnpAoPW5vZGUpIOyekOyytOqwgCDrqrsg64+M7JWEIO2UjOufrOq3uOyduOyXkCDslYzrprQg67Cp67KV7J20IOyXhuuLpCDihpIg7J20IOqyveyasOunjCDrhKTsnbTti7DruIwg7Yyd7JeF7Jy866GcIOyViOuCtO2VnOuLpAppZiAhIGNvbW1hbmQgLXYgbm9kZSA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICBvc2FzY3JpcHQgLWUgJ2Rpc3BsYXkgZGlhbG9nICLsnbQgTWFj7JeQIE5vZGUuanPqsIAg7JeG7Ja07JqULiBb7ZmV7J24XeydhCDriITrpbTrqbQg64uk7Jq066Gc65OcIO2OmOydtOyngOqwgCDsl7TroKTsmpQuIE5vZGUuanMoTFRTKeulvCDshKTsuZjtlZwg65KkIOydtCDshKTsuZgg7YyM7J287J2EIOuLpOyLnCDsi6TtlontlbQg7KO87IS47JqULiIgd2l0aCB0aXRsZSAi7YG066Gc65OcIOy7pOuEpe2EsCDigJQgTm9kZS5qcyDtlYTsmpQiIGJ1dHRvbnMgeyLtmZXsnbgifSBkZWZhdWx0IGJ1dHRvbiAxIHdpdGggaWNvbiBjYXV0aW9uIGdpdmluZyB1cCBhZnRlciAxODAnID4vZGV2L251bGwgMj4mMQogIG9wZW4gImh0dHBzOi8vbm9kZWpzLm9yZy9rby9kb3dubG9hZCIgMj4vZGV2L251bGwKICBmaW5pc2ggMApmaQpOT0RFX0JJTj0iJChjb21tYW5kIC12IG5vZGUpIgplY2hvICLinIUgTm9kZS5qczogJChub2RlIC0tdmVyc2lvbikiCiMg6rCQ7Iuc7J6QIGxhdW5jaGQg65Ox66GdICjroZzqt7jsnbgg7J6Q64+Z7Iuc7J6RICsg7KeA6riIIOq4sOuPmSkuIFBBVEjrpbwgcGxpc3Tsl5Ag6rWz7ZiAIOuEo+uKlOuLpCDigJQgbGF1bmNoZCDquLDrs7ggUEFUSOyXlCBjbGF1ZGXqsIAg7JeG64ukLgpQTElTVD0iJEhPTUUvTGlicmFyeS9MYXVuY2hBZ2VudHMvY29tLmNsYXVkZWJyaWRnZS53YXRjaGVyLnBsaXN0Igpta2RpciAtcCAiJEhPTUUvTGlicmFyeS9MYXVuY2hBZ2VudHMiClNBRkVfUEFUSD0iJHtQQVRILy8mLyZhbXA7fSIKY2F0ID4gIiRQTElTVCIgPDxQTElTVEVPRgo8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCI/Pgo8IURPQ1RZUEUgcGxpc3QgUFVCTElDICItLy9BcHBsZS8vRFREIFBMSVNUIDEuMC8vRU4iICJodHRwOi8vd3d3LmFwcGxlLmNvbS9EVERzL1Byb3BlcnR5TGlzdC0xLjAuZHRkIj4KPHBsaXN0IHZlcnNpb249IjEuMCI+CjxkaWN0PgogIDxrZXk+TGFiZWw8L2tleT48c3RyaW5nPmNvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlcjwvc3RyaW5nPgogIDxrZXk+UHJvZ3JhbUFyZ3VtZW50czwva2V5PgogIDxhcnJheT4KICAgIDxzdHJpbmc+JE5PREVfQklOPC9zdHJpbmc+CiAgICA8c3RyaW5nPiRESVIvc2NyaXB0cy9icmlkZ2Utd2F0Y2hlci5qczwvc3RyaW5nPgogIDwvYXJyYXk+CiAgPGtleT5FbnZpcm9ubWVudFZhcmlhYmxlczwva2V5PgogIDxkaWN0PjxrZXk+UEFUSDwva2V5PjxzdHJpbmc+JFNBRkVfUEFUSDwvc3RyaW5nPjwvZGljdD4KICA8a2V5PlJ1bkF0TG9hZDwva2V5Pjx0cnVlLz4KICA8a2V5PktlZXBBbGl2ZTwva2V5PjxkaWN0PjxrZXk+U3VjY2Vzc2Z1bEV4aXQ8L2tleT48ZmFsc2UvPjwvZGljdD4KPC9kaWN0Pgo8L3BsaXN0PgpQTElTVEVPRgpsYXVuY2hjdGwgYm9vdG91dCAiZ3VpLyQoaWQgLXUpL2NvbS5jbGF1ZGVicmlkZ2Uud2F0Y2hlciIgMj4vZGV2L251bGwKbGF1bmNoY3RsIGJvb3RzdHJhcCAiZ3VpLyQoaWQgLXUpIiAiJFBMSVNUIiAyPi9kZXYvbnVsbCB8fCBsYXVuY2hjdGwgbG9hZCAtdyAiJFBMSVNUIiAyPi9kZXYvbnVsbAojIGNsYXVkZSDsnKDrrLTCt+uhnOq3uOyduCDsl6zrtoDripQg7Jes6riw7IScIOyVjOumrOyngCDslYrripTri6Qg4oCUIOqwkOyLnOyekOqwgCDqt7gg7IOB7YOc66W8IO2UjOufrOq3uOyduOyXkCDsoITri6ztlbQKIyDqs4TsoJUg7ZmU66m07J20ICLshKTsuZgg7ZWE7JqUIC8g66Gc6re47J24IO2VhOyalCAvIOykgOu5hCDsmYTro4wi66GcIOuFuOy2nO2VnOuLpCjthLDrr7jrhJDsnbQg7LGE64SQ7J20IOyVhOuLmCkuCiMg7ISk7LmYwrfsoJDqsoAg64GdIOKGkiDssL3snYQg7Iqk7Iqk66GcIOuLq+uKlOuLpC4KZmluaXNoIDAKUEsBAh4DFAAACAAAAAAAAHVkBUmHuwIAh7sCABsAAAAAAAAAAAAAAO2BAAAAAO2BtOuhnOuTnC3su6TrhKXthLAuY29tbWFuZFBLBQYAAAAAAQABAEkAAADAuwIAAAA=";
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
