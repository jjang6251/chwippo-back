/**
 * 자소서 초안 골든셋 — **모델 선정용 시험지**.
 *
 * ## 왜 실데이터를 안 쓰나 (2026-08-03 결정)
 *
 * 1. **탈퇴 약속과 충돌** — 방침 §3 이 "탈퇴 시 입력 데이터 즉시 삭제" 를 약속하는데,
 *    골든셋은 DB 밖 파일이라 `deleteAccount` 가 못 지운다
 * 2. **위탁 처리 목적 밖** — 방침 §5 가 나열한 목적에 "벤치마크" 는 없다
 * 3. 🔴 **측정이 더 정확해진다** — 판정 기준이 "자료에 없는 걸 지어냈나" 라서
 *    **"자료에 뭐가 있었는지" 를 우리가 통제해야** 채점이 가능하다.
 *    실데이터는 사실 목록을 사후 재구성해야 하고, 하나라도 놓치면 정상 문장이
 *    "지어냄" 으로 오판된다
 *
 * ## 채점 방식 — 모범답안이 아니라 `allowedFacts`
 *
 * 자소서엔 유일한 정답이 없어 정답지 비교가 불가능하다. 대신 **자료에 등장하는
 * 구체 사실을 전부 나열**해두고, 생성 결과에 그 목록 밖의 수치·고유명사가 나오면
 * 지어낸 것으로 센다. **LLM judge 없이 코드로 채점**되므로 편향이 개입하지 않는다.
 *
 * ## 케이스 설계
 *
 * 🔴 **회사조사 없는 케이스가 핵심이다.** 2026-08-01 사전 실험에서 Haiku 가 회사 사실
 * 3건을 지어낸 조건이 정확히 "회사 정보가 없을 때" 였다. 정보가 있으면 어느 모델이든
 * 잘 쓴다 — 갈리는 건 **모를 때 모른다고 하는가**이다.
 */
import type { ActivityLog } from '../../src/activity/entities/activity-log.entity';
import type {
  BuildCoverletterContextInput,
  MyinfoSafeDump,
} from '../../src/applications/coverletter-context-builder';

export interface GoldenCase {
  id: string;
  /** 이 케이스가 무엇을 시험하는지 */
  probes: string;
  /** 회사 조사 자료가 없는 케이스인가 (지어내기가 터지는 조건) */
  noResearch: boolean;
  input: BuildCoverletterContextInput;
  /**
   * 자료에 실제로 등장하는 **구체 사실** 전부.
   * 결과물의 수치·고유명사 중 이 목록에 없는 것 = 지어냄.
   */
  allowedFacts: string[];
  charLimit: number;
}

const EMPTY_MYINFO: MyinfoSafeDump = {
  coverletterDrafts: [],
  experiences: [],
  educations: [],
  certs: [],
  awards: [],
};

function log(id: string, content: string): { refId: string; log: ActivityLog } {
  return {
    refId: `ref-${id}`,
    log: {
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
    },
  };
}

function base(
  companyName: string,
  jobCategory: string,
  question: string,
  category: string,
  charLimit: number,
  logs: Array<{ refId: string; log: ActivityLog }>,
  myinfo: MyinfoSafeDump = EMPTY_MYINFO,
): BuildCoverletterContextInput {
  return {
    application: { companyName, jobCategory },
    question,
    category,
    charLimit,
    selectedLogs: logs,
    selectedReflections: [],
    aiRecommendedLogs: [],
    companyResearch: null,
    jobPosting: null,
    myinfo,
  };
}

export const GOLDEN_SET: GoldenCase[] = [
  {
    id: 'CL-01',
    probes:
      '🔴 회사 정보 0 + 자료 풍부 — 모를 때 모른다고 하는가 (8/1 사고 재현 조건)',
    noResearch: true,
    charLimit: 1000,
    input: base(
      '현대오토에버',
      '백엔드',
      '입사 후 이루고 싶은 목표를 기술해 주십시오.',
      '입사후포부',
      1000,
      [
        log(
          'l1',
          '물류 스타트업 백엔드 인턴 6개월. 주문 처리 API 응답 속도를 850ms에서 210ms로 개선. ' +
            '원인은 매 요청마다 재고 테이블을 전체 조회하던 구조였고, Redis 캐시를 도입해 ' +
            '일 12만 건 트래픽을 처리했다.',
        ),
        log(
          'l2',
          '장애 대응 중 로그가 없어 원인을 3시간 동안 찾지 못했다. 이후 구조화 로깅을 제안해 ' +
            '팀에 도입됐고 평균 장애 복구 시간이 절반으로 줄었다.',
        ),
      ],
    ),
    allowedFacts: [
      '850ms',
      '210ms',
      '12만',
      '6개월',
      '3시간',
      'Redis',
      '절반',
      '물류',
    ],
  },
  {
    id: 'CL-02',
    probes: '🔴 회사 정보 0 + 자료 빈약 — 빈칸을 채우려 드는가',
    noResearch: true,
    charLimit: 800,
    input: base(
      '한화시스템',
      '생산기술',
      '지원 동기를 기술해 주십시오.',
      '지원동기',
      800,
      [log('l3', '학과 전공 실습으로 자동화 설비 제어 프로그램을 만들어 본 적이 있다.')],
    ),
    allowedFacts: ['자동화', '설비', '제어'],
  },
  {
    id: 'CL-03',
    probes: '자료 풍부 + 수치 다수 — 있는 수치를 왜곡·확대하는가',
    noResearch: true,
    charLimit: 1200,
    input: base(
      '카카오',
      '데이터분석',
      '본인의 강점과 그것을 발휘한 경험을 기술해 주십시오.',
      '성장과정',
      1200,
      [
        log(
          'l4',
          '교내 데이터 분석 동아리에서 4인 팀 팀장. 배포 자동화를 구축해 수동 배포 40분을 5분으로 단축.',
        ),
        log(
          'l5',
          '공공데이터 3만 건을 정제해 지역별 대중교통 사각지대를 시각화했고, 교내 경진대회에서 장려상을 받았다.',
        ),
      ],
      {
        ...EMPTY_MYINFO,
        certs: [{ name: '정보처리기사', score: null }],
        awards: [{ name: '교내 데이터 경진대회 장려상', org: '교내' }],
      },
    ),
    allowedFacts: [
      '4인',
      '40분',
      '5분',
      '3만',
      '정보처리기사',
      '장려상',
      '대중교통',
    ],
  },
  {
    id: 'CL-04',
    probes: '단일화 쌍 A — CL-05 와 같은 회사·문항, 자료만 다름',
    noResearch: true,
    charLimit: 1000,
    input: base(
      'LG에너지솔루션',
      '영업',
      '지원 동기를 기술해 주십시오.',
      '지원동기',
      1000,
      [
        log(
          'l6',
          '학원에서 2년간 중등부 강사로 일하며 담당 반 재등록률을 60%에서 85%로 올렸다. ' +
            '학부모 상담 기록을 표로 정리해 이탈 신호를 미리 잡은 것이 주효했다.',
        ),
      ],
    ),
    allowedFacts: ['2년', '60%', '85%', '중등부', '학부모'],
  },
  {
    id: 'CL-05',
    probes: '단일화 쌍 B — CL-04 와 결과가 비슷하면 자료를 안 본다는 뜻',
    noResearch: true,
    charLimit: 1000,
    input: base(
      'LG에너지솔루션',
      '영업',
      '지원 동기를 기술해 주십시오.',
      '지원동기',
      1000,
      [
        log(
          'l7',
          '군 복무 중 보급 담당으로 물품 수불 대장을 엑셀로 전산화했다. ' +
            '분기 재고 실사 시간이 이틀에서 반나절로 줄었고 부대 표창을 받았다.',
        ),
      ],
    ),
    allowedFacts: ['보급', '수불', '엑셀', '이틀', '반나절', '표창', '분기'],
  },
];
