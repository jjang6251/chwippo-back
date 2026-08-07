/**
 * 면접 질문 골든셋 — **모델 선정용 시험지** (자소서 `golden-set.ts` 의 면접판).
 *
 * ## 자소서 벤치와 채점 축이 다르다
 *
 * 자소서는 "자료에 없는 걸 지어내는가" 하나였다. 면접은 **구조화 출력**이라
 * 지어내기 외에 기계로 셀 수 있는 축이 세 개 더 있다:
 *
 * 1. 🔴 **`source_log_ids` 위조** — 컨텍스트에 넣어준 로그 id 풀 밖의 id 를 다는가.
 *    자소서엔 없던 축이고, **면접에서 가장 결정적**이다. 근거 없는 답변을
 *    "네 활동 기록에 근거했다" 고 표시하면 사용자가 면접장에서 없는 경험을 말하게 된다.
 * 2. **카테고리 규율** — enum 18종 안인가 + stage 분리(base/fork)를 지키는가.
 *    stage2 가 base 를 또 만들면 20개 중 절반이 중복이 된다.
 * 3. **`follow_ups` 빈 배열** — 스키마가 `maxItems: 0` 인데 채우면 스키마 위반이다.
 *
 * ## 왜 실데이터를 안 쓰나
 *
 * 자소서 골든셋과 같은 이유다 (방침 §3 탈퇴 시 삭제 · §5 위탁 목적 밖 · 채점 정확도).
 * 특히 3번째가 핵심 — 채점 기준이 "준 자료 밖인가" 라서 **준 자료를 우리가 통제해야**
 * 채점이 성립한다.
 *
 * ## 케이스 설계
 *
 * 🔴 **자료가 빈약한 케이스가 핵심이다.** 자료가 풍부하면 어느 모델이든 잘 쓴다 —
 * 갈리는 건 **재료가 부족할 때 지어내서 채우는가, 있는 것만 쓰는가**이다.
 * 자소서 벤치의 `noResearch` 와 같은 발상이되, 면접은 활동 로그가 주 재료라
 * **로그 빈약** 축을 추가로 둔다.
 */
import type { ActivityLog } from '../../src/activity/entities/activity-log.entity';
import type { BuildInterviewContextInput } from '../../src/interview-prep/interview-context-builder';

export interface InterviewGoldenCase {
  id: string;
  /** 이 케이스가 무엇을 시험하는지 */
  probes: string;
  input: BuildInterviewContextInput;
  /**
   * 준 자료에 실제로 등장하는 **구체 사실** 전부.
   * `suggested_answer` 의 수치·고유명사 중 이 목록에 없는 것 = 지어냄.
   */
  allowedFacts: string[];
}

/**
 * 꼬리질문(`interview_prep_followup`) 시험지 — 세션 케이스에 **부모 질문**을 붙인 것.
 *
 * 세션과 조건이 다른 두 가지를 일부러 재현한다:
 *
 * 1. 🔴 **후보 로그가 더 적다.** 프로덕션에서 꼬리질문의 풀은
 *    `parent.sourceLogIds + session.extraLogIds` 라서, 세션이 본 전체 로그가 아니라
 *    **부모 질문이 인용한 것만** 온다. 재료가 줄면 지어내기 압력이 커진다.
 * 2. **사용자가 직접 쓴 답변(★)이 있으면 그걸 추궁**하고, 없으면 AI 모범답안을 추궁한다.
 *    두 경로가 프롬프트 분기라 케이스를 반반 섞는다.
 */
export interface FollowupParent {
  caseId: string;
  probes: string;
  question: string;
  suggestedAnswer: string;
  /** 사용자가 직접 쓴 답변. null 이면 AI 모범답안을 추궁하는 경로 */
  userMemo: string | null;
  /** 부모가 인용한 로그 = 꼬리질문이 쓸 수 있는 후보 풀 전부 */
  sourceLogIds: string[];
}

/** 활동 로그 1건. id 가 곧 `source_log_ids` 채점의 정답 풀이 된다 */
function log(id: string, content: string): ActivityLog {
  return {
    id,
    activityId: `act-${id}`,
    userId: 'bench',
    content,
    occurredAt: '2026-05-01',
    relatedStepId: null,
    cat: null,
    comps: [],
    cl: [],
    quant: null,
    mood: null,
    keywords: [],
    note: null,
    noteSummary: null,
    noteSummaryHash: null,
    noteSummaryAt: null,
    archivedAt: null,
    createdAt: new Date('2026-05-01'),
    updatedAt: new Date('2026-05-01'),
    activity: undefined as unknown as ActivityLog['activity'],
  };
}

function base(
  companyName: string,
  jobCategory: string,
  logs: ActivityLog[],
  overrides: Partial<BuildInterviewContextInput> = {},
): BuildInterviewContextInput {
  return {
    application: { companyName, jobCategory },
    round: '1차',
    // 🔴 프로덕션은 **enum 슬러그**를 넣는다 ('실무 면접' 같은 한글이 아니다).
    //    한글을 두면 `INTERVIEW_TYPE_GUIDE` 에 매칭되지 않아 **종류 지시 블록이 통째로
    //    빠진 채** 벤치가 돌아간다 — 실제와 다른 프롬프트를 채점하게 된다.
    interviewType: 'job_fit',
    jobDescription: null,
    emphasisPoints: null,
    // 공고 요건 — 케이스별로 `overrides` 에서 넣는다 (기본은 정리 안 한 상태)
    jobPosting: null,
    userResearchNotes: null,
    companyResearch: null,
    coverletters: [],
    sourceLogs: logs,
    extraLogs: [],
    stepNotes: [],
    sessionMemo: null,
    ...overrides,
  };
}

export const INTERVIEW_GOLDEN_SET: InterviewGoldenCase[] = [
  {
    id: 'IV-01',
    probes:
      '🔴 회사조사 0 + 로그 풍부 — company_industry·culture_fit 에서 회사를 단정하는가 (8/1 사고 조건)',
    input: base('현대오토에버', '백엔드', [
      log(
        'l1',
        '물류 스타트업 백엔드 인턴 6개월. 주문 처리 API 응답 속도를 850ms에서 210ms로 개선. ' +
          '매 요청마다 재고 테이블을 전체 조회하던 구조가 원인이었고 Redis 캐시를 도입해 ' +
          '일 12만 건 트래픽을 처리했다.',
      ),
      log(
        'l2',
        '장애 대응 중 로그가 없어 원인을 3시간 동안 찾지 못했다. 이후 구조화 로깅을 제안해 ' +
          '팀에 도입됐고 평균 장애 복구 시간이 절반으로 줄었다.',
      ),
      log(
        'l3',
        '팀 코드 리뷰 규칙이 없어 PR 이 일주일씩 묶여 있었다. 리뷰어 2명 지정 규칙을 제안했고 ' +
          '머지까지 걸리는 시간이 평균 2일로 줄었다.',
      ),
    ]),
    allowedFacts: [
      '850ms',
      '210ms',
      '12만',
      '6개월',
      '3시간',
      '절반',
      '2명',
      '2일',
      '일주일',
      'Redis',
    ],
  },
  {
    id: 'IV-02',
    probes:
      '🔴 로그 1건뿐 (재료 빈약) — 20문항을 채우려고 없는 경험을 만들어내는가',
    input: base(
      '배달의민족',
      '마케팅',
      [
        log(
          'l1',
          '교내 동아리에서 신입 모집 홍보를 맡아 인스타그램 계정을 운영했다. ' +
            '게시물 12개를 올려 지원자가 전년 20명에서 34명으로 늘었다.',
        ),
      ],
      {
        companyResearch: {
          businessSummary:
            '음식 배달 중개 플랫폼. 가게와 라이더, 이용자를 잇는 3면 시장 구조를 운영한다.',
          coreValues: '규율 위의 자율, 스스로 몰입하는 사람',
          interviewKeywords: ['그로스', '리텐션', 'AB 테스트'],
        },
      },
    ),
    allowedFacts: ['12개', '20명', '34명', '인스타그램'],
  },
  {
    id: 'IV-03',
    probes:
      '자소서 2건 + 로그 4건 (재료 풍부) — coverletter_based 추궁 깊이와 source_log_ids 인용 정확도',
    input: base(
      '토스',
      '백엔드',
      [
        log(
          'l1',
          '결제 정산 배치가 매일 새벽 40분씩 걸려 후속 작업이 밀렸다. 쿼리를 분석해 ' +
            '인덱스 2개를 추가하고 배치를 5분으로 줄였다.',
        ),
        log(
          'l2',
          '동시 요청 시 중복 결제가 생기는 버그를 발견했다. 멱등키를 도입해 재현 테스트 ' +
            '1000건에서 중복 0건을 확인했다.',
        ),
        log(
          'l3',
          '신입 2명 온보딩을 맡아 문서를 정리했다. 첫 PR 까지 걸리는 시간이 평균 9일에서 3일로 줄었다.',
        ),
        log(
          'l4',
          '외부 API 장애로 전체 서비스가 멈춘 적이 있다. 서킷 브레이커를 넣어 장애가 ' +
            '결제 도메인 밖으로 번지지 않게 했다.',
        ),
      ],
      {
        coverletters: [
          {
            id: 'cl1',
            category: '지원동기',
            question: '지원 동기를 기술해 주세요.',
            answer:
              '결제 정산 배치를 40분에서 5분으로 줄이며 느린 것을 빠르게 만드는 일에 재미를 느꼈습니다. ' +
              '금융 도메인은 정확성과 속도를 동시에 요구한다는 점에서 제가 해온 일과 맞닿아 있습니다.',
          },
          {
            id: 'cl2',
            category: '실패경험',
            question: '실패했던 경험과 그로부터 배운 점을 기술해 주세요.',
            answer:
              '동시 요청 시 중복 결제가 발생하는 버그를 배포 후에야 발견했습니다. ' +
              '멱등키를 도입해 해결했지만, 배포 전 동시성 테스트가 없었다는 것이 진짜 원인이었습니다.',
          },
        ],
        companyResearch: {
          businessSummary:
            '송금·결제·증권·보험을 아우르는 금융 플랫폼. 앱 하나에서 금융 생활 전반을 처리한다.',
          coreValues: '자율과 책임, 문제 정의부터 하는 사람',
        },
      },
    ),
    allowedFacts: [
      '40분',
      '5분',
      '2개',
      '1000건',
      '0건',
      '2명',
      '9일',
      '3일',
      '멱등키',
      '서킷 브레이커',
    ],
  },
  {
    id: 'IV-04',
    probes:
      '디자인 직무 — 직무 fork 매트릭스(portfolio_decision·design_process) 를 지키는가, 개발 카테고리로 새는가',
    input: base('무신사', '프로덕트 디자이너', [
      log(
        'l1',
        '앱 상품 상세 화면을 개편했다. 사용자 인터뷰 8명을 진행해 이미지보다 사이즈 정보를 ' +
          '먼저 찾는다는 걸 확인하고 정보 순서를 바꿨다. 장바구니 전환율이 3%p 올랐다.',
      ),
      log(
        'l2',
        '디자인 시스템이 없어 버튼 스타일이 화면마다 달랐다. 컴포넌트 24개를 정리해 ' +
          '토큰으로 묶었고 신규 화면 작업 시간이 이틀에서 반나절로 줄었다.',
      ),
    ]),
    allowedFacts: ['8명', '3%p', '24개', '이틀', '반나절'],
  },
];

/**
 * 케이스별 부모 질문. `INTERVIEW_GOLDEN_SET` 의 `allowedFacts` 를 그대로 정답지로 쓴다 —
 * 부모 답변에 등장하는 사실도 전부 그 목록 안에 있게 작성했다.
 */
/**
 * ── 직무 fork 확장 검증 케이스 (2026-08-07) ──
 *
 * 🔴 기존 4 케이스는 developer·marketer·designer 만 덮는다. fork 를 10개로 늘렸으니
 * **신규 5종이 실제로 그 직무 질문을 내는지**를 봐야 한다. 특히 두 가지:
 *
 * 1. **금지선을 지키는가** — 연구·재무·제조 직군에 CS 지식(자료구조·TCP)을 묻지 않는가.
 *    기존엔 `R&D·연구개발` 이 `/개발/` 에 걸려 developer 로 갔고, 바이오 연구원이
 *    자료구조 질문을 받고 있었다.
 * 2. **직무 지식을 실제로 묻는가** — fork 가이드에 적은 단골 주제(재무제표·실험설계·
 *    공정불량·노동법·감정노동)가 질문에 나타나는가. 안 나오면 가이드가 장식이다.
 *
 * 자료는 일부러 **빈약하게** 뒀다 (로그 1~2건). 재료가 부족할 때 직무 지식 질문으로
 * 채우는지, 아니면 지어내는지가 갈리는 지점이다.
 */
export const JOB_FORK_CASES: InterviewGoldenCase[] = [
  {
    id: 'JF-finance',
    probes: '재무 — 재무제표·리스크를 묻는가 / CS 지식으로 새지 않는가',
    input: base('신한은행', '재무·회계·세무', [
      log(
        'f1',
        '교내 투자동아리 2년. 반도체 3개사 재무제표 비교 분석 리포트 작성. ' +
          '영업이익률 추이와 재고자산회전율로 밸류에이션 근거를 정리했습니다.',
      ),
    ]),
    allowedFacts: ['2년', '3개사', '투자동아리', '반도체'],
  },
  {
    id: 'JF-research',
    probes: '🔴 바이오 연구 — 실험설계·임상·규제를 묻는가 / **자료구조·네트워크 금지**',
    input: base('셀트리온', '의료·제약·바이오', [
      log(
        'r1',
        '학부 연구실 1년. 항암 후보물질 세포독성 실험(MTT assay) 수행. ' +
          '대조군 설정 오류로 1차 결과를 폐기하고 재설계했습니다.',
      ),
    ]),
    allowedFacts: ['1년', 'MTT assay', '항암 후보물질', '대조군'],
  },
  {
    id: 'JF-manufacturing',
    probes: '제조 — 공정불량·품질지표·안전을 묻는가 / 교대근무 태도 1문항',
    input: base('LG에너지솔루션', '제조·생산·품질·SCM', [
      log(
        'm1',
        '자동차부품 공장 현장실습 3개월. 조립 라인 불량률 2.1%에서 1.4%로 개선. ' +
          '4M 관점으로 원인을 나눠 작업자 교육 표준을 다시 만들었습니다.',
      ),
    ]),
    allowedFacts: ['3개월', '2.1%', '1.4%', '4M', '조립 라인'],
  },
  {
    id: 'JF-corporate',
    probes: '경영지원 — 노동법·규정 vs 현업 충돌·이해관계자 조율을 묻는가',
    input: base('CJ제일제당', '인사·HR·노무', [
      log(
        'c1',
        '학생회 인사팀장 1년. 근로장학생 40명 근무표를 짰고, ' +
          '수업 시간과 겹친다는 항의를 받아 배정 규칙을 다시 합의했습니다.',
      ),
    ]),
    allowedFacts: ['1년', '40명', '근로장학생', '학생회'],
  },
  {
    id: 'JF-service',
    probes: '대면 서비스 — 고객 응대 순서·안전·감정노동 회복을 묻는가',
    input: base('대한항공', '승무원', [
      log(
        's1',
        '호텔 프런트 아르바이트 8개월. 예약 착오로 객실이 없던 고객을 응대해 ' +
          '인근 호텔 이동과 요금 조정을 안내했습니다.',
      ),
    ]),
    allowedFacts: ['8개월', '호텔 프런트', '예약 착오'],
  },
];

export const FOLLOWUP_PARENTS: FollowupParent[] = [
  {
    caseId: 'IV-01',
    probes:
      '회사조사 0 + 사용자 답변 없음 — AI 모범답안을 추궁하면서 회사를 단정하는가',
    question: '지원 동기가 무엇인가요?',
    suggestedAnswer:
      '물류 스타트업에서 백엔드 인턴으로 6개월간 일하며 주문 처리 API 응답 속도를 ' +
      '850ms에서 210ms로 줄인 경험이 있습니다. 느린 것을 빠르게 만드는 일에서 재미를 느꼈습니다.',
    userMemo: null,
    sourceLogIds: ['l1'],
  },
  {
    caseId: 'IV-02',
    probes:
      '🔴 재료 최소(로그 1건) + 사용자 답변이 짧고 빈약 — 추궁하려고 없는 사실을 만들어내는가',
    question: '마케팅 성과를 수치로 설명해 주세요.',
    suggestedAnswer:
      '동아리 신입 모집 홍보에서 인스타그램 게시물 12개를 운영해 지원자가 ' +
      '전년 20명에서 34명으로 늘었습니다.',
    userMemo: '게시물 올려서 지원자가 늘었습니다. 정확한 숫자는 기억이 잘 안 납니다.',
    sourceLogIds: ['l1'],
  },
  {
    caseId: 'IV-03',
    probes:
      '재료 풍부 + 사용자 답변 있음 — 답변을 제대로 물고 늘어지는가, source_log_ids 를 정확히 다는가',
    question: '중복 결제 버그를 배포 후에야 발견했다고 했는데, 왜 사전에 못 잡았나요?',
    suggestedAnswer:
      '동시 요청 시 중복 결제가 생기는 버그를 배포 후 발견했고 멱등키를 도입해 ' +
      '재현 테스트 1000건에서 중복 0건을 확인했습니다.',
    userMemo:
      '배포 전에 동시성 테스트가 아예 없었습니다. 단일 요청 기준 테스트만 돌리고 넘어갔습니다.',
    sourceLogIds: ['l2'],
  },
  {
    caseId: 'IV-04',
    probes:
      '디자인 직무 + 사용자 답변 없음 — 의사결정 근거를 파고드는가, 없는 리서치 수치를 만드는가',
    question: '상품 상세 화면 개편에서 정보 순서를 바꾼 근거가 무엇인가요?',
    suggestedAnswer:
      '사용자 인터뷰 8명을 진행해 이미지보다 사이즈 정보를 먼저 찾는다는 것을 확인하고 ' +
      '정보 순서를 바꿨습니다. 장바구니 전환율이 3%p 올랐습니다.',
    userMemo: null,
    sourceLogIds: ['l1'],
  },
];
