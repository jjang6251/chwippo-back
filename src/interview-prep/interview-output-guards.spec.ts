/**
 * 출력 후처리 검증 spec (2026-08-07).
 *
 * 🔴 **케이스는 상상이 아니라 실측에서 가져온다.** 교차검증 2회에서 실제로 나온 오귀속
 * 짝과 위조 문장을 그대로 넣는다 — 지어낸 케이스로는 "이 정도면 잡히겠지" 를 확인할 뿐
 * 실제로 뚫렸던 것이 잡히는지는 모른다.
 */
import {
  distinctiveTokens,
  filterAttributableLogIds,
  findUnsupportedTechAssertions,
  isDuplicateFollowup,
  measureJobPostingCoverage,
} from './interview-output-guards';

describe('distinctiveTokens', () => {
  it('다른 로그에 없는 토큰만 남긴다', () => {
    const [a, b] = distinctiveTokens([
      '헬스장 회원권 상담 아르바이트',
      '토익 스터디 리더 활동',
    ]);
    expect(a.has('헬스장')).toBe(true);
    expect(b.has('토익')).toBe(true);
    expect(a.has('토익')).toBe(false);
  });

  it('🔴 공통 토큰은 판별에 안 쓴다 — 안 그러면 무관한 로그가 통과한다', () => {
    const [a] = distinctiveTokens([
      '학회 활동 경험 진행 담당',
      '동아리 활동 경험 진행 담당',
    ]);
    expect(a.has('활동')).toBe(false);
    expect(a.has('경험')).toBe(false);
    expect(a.has('학회')).toBe(true);
  });

  it('🔴 전부 공유되면 원본으로 되돌린다 — 빈 집합이면 정당한 참조까지 날아간다', () => {
    const [a] = distinctiveTokens(['같은 내용', '같은 내용']);
    expect(a.size).toBeGreaterThan(0);
  });
});

describe('filterAttributableLogIds', () => {
  /** 실측 A1 — 이 짝이 두 회차 연속 오귀속으로 나왔다 */
  const A1_POOL = [
    {
      id: 'log-review',
      body: '팀 코드 리뷰 규칙 정립. PR 템플릿 도입으로 리뷰 누락 감소.',
    },
    {
      id: 'log-redis',
      body: '주문 처리 API 응답 지연 개선 — Redis 캐시 도입으로 평균 400ms → 90ms.',
    },
    {
      id: 'log-batch',
      body: '야간 정산 배치 40분 → 5분 단축. 인덱스 추가와 쿼리 분리.',
    },
  ];

  it('🔴 실측 오귀속 — 장애 로깅 질문에 코드리뷰·Redis 로그가 달렸다 → 뗀다', () => {
    const out = filterAttributableLogIds({
      text: '장애 대응 중 로그가 없어 원인을 3시간 동안 찾지 못한 경험이 있습니다.',
      claimedIds: ['log-review', 'log-redis'],
      pool: A1_POOL,
    });
    expect(out).toEqual([]);
  });

  it('내용이 실제로 등장하면 남긴다', () => {
    const out = filterAttributableLogIds({
      text: 'Redis 캐시를 도입해 주문 처리 API 응답을 400ms 에서 90ms 로 줄였습니다.',
      claimedIds: ['log-redis'],
      pool: A1_POOL,
    });
    expect(out).toEqual(['log-redis']);
  });

  it('맞는 것만 골라 남긴다 (부분 오귀속)', () => {
    const out = filterAttributableLogIds({
      text: '야간 정산 배치를 인덱스 추가로 40분에서 5분으로 줄인 경험이 있습니다.',
      claimedIds: ['log-batch', 'log-review'],
      pool: A1_POOL,
    });
    expect(out).toEqual(['log-batch']);
  });

  /** 실측 A5 — 로그에 협업이 없는데 "협업 경험" 질문에 달렸다 */
  it('🔴 실측 오귀속 — 로그에 없는 협업 경험 질문 → 뗀다', () => {
    const out = filterAttributableLogIds({
      text: '다른 사람들과 협업하여 고객 문제를 해결했던 경험을 말씀해 주세요.',
      claimedIds: ['log-hotel'],
      pool: [
        {
          id: 'log-hotel',
          body: '호텔 프런트 아르바이트 8개월. 예약 착오 고객 응대 — 인근 호텔 이동·요금 조정 안내.',
        },
        {
          id: 'log-cafe',
          body: '카페 마감 근무 3개월. 재고 정리와 주문 마감.',
        },
      ],
    });
    expect(out).toEqual([]);
  });

  /**
   * 🔴 아래 두 개가 **임계값 자체를 고정**한다. 위 A5 케이스를 통과시키려고 1→2 로
   * 올린 것이라, 규칙을 박아두지 않으면 다음 사람이 조용히 1 로 되돌리고
   * 오귀속이 다시 새어 나온다.
   */
  it('🔴 토큰 많은 로그는 1개 일치로 부족하다 (한국어 명사는 도메인을 넘나든다)', () => {
    const out = filterAttributableLogIds({
      // '고객' **하나만** 겹친다 ('응대' 를 넣으면 2개가 돼 통과한다 — 실제로 그렇게 틀렸다)
      text: '고객과의 신뢰를 쌓는 본인만의 방법은 무엇인가요?',
      claimedIds: ['rich'],
      pool: [
        {
          id: 'rich',
          body: '호텔 프런트 아르바이트 8개월. 예약 착오 고객 응대 인근 이동 요금 조정 안내.',
        },
        { id: 'other', body: '카페 마감 근무 재고 정리 주문 처리.' },
      ],
    });
    expect(out).toEqual([]);
  });

  it('🔴 짧은 로그는 1개로 완화 — 안 그러면 한 줄 기록만 가진 사용자가 영영 못 본다', () => {
    const out = filterAttributableLogIds({
      text: '토익 스터디를 이끈 경험이 있습니다.',
      claimedIds: ['short'],
      pool: [
        { id: 'short', body: '토익 스터디' }, // 고유 토큰 2개 → 완화 대상
        { id: 'other', body: '카페 마감 근무 재고 정리 주문 처리 야간.' },
      ],
    });
    expect(out).toEqual(['short']);
  });

  /**
   * 🔴 한국어 조사 접두 일치 (2026-08-07 3회차 심사 지적).
   *
   * 완전 일치만 보면 `프로토타입` ≠ `프로토타입을` 이라 **정당한 참조가 잘렸다.**
   * B 세트 실측에서 토큰 대조 999건 중 96건(9.6%)이 이 이유로 어긋났다.
   *
   * 아래 두 개가 짝이다 — 접두를 허용하되 **너무 짧으면 안 된다.**
   */
  it('🔴 조사가 붙어도 같은 말로 본다 (프로토타입 ↔ 프로토타입을)', () => {
    const out = filterAttributableLogIds({
      text: '프로토타입을 만든 뒤 화면 구조를 어떻게 검증하셨나요?',
      claimedIds: ['design'],
      pool: [
        {
          id: 'design',
          body: '가계부 앱 화면 설계, 프로토타입 제작, 지출 흐름 정리.',
        },
        { id: 'study', body: '독서 모임 운영 및 발제 담당.' },
      ],
    });
    expect(out).toEqual(['design']);
  });

  it('🔴 2자 접두는 인정하지 않는다 — "사업" 이 "사업자" 를 먹으면 안 된다', () => {
    const out = filterAttributableLogIds({
      // 로그의 '사업'·'개발' 이 접두로 통과하면 무관한 질문이 살아남는다
      text: '사업자 등록과 개발자 채용 절차를 아시나요?',
      claimedIds: ['biz'],
      pool: [
        {
          id: 'biz',
          body: '사업 기획 인턴. 개발 일정 조율, 예산 검토, 보고 자료 작성.',
        },
        { id: 'etc', body: '카페 아르바이트 마감 근무 재고 정리.' },
      ],
    });
    expect(out).toEqual([]);
  });

  it('🔴 접두 허용이 오귀속 판정을 느슨하게 만들지 않는다 (A5 회귀)', () => {
    const out = filterAttributableLogIds({
      text: '다른 사람들과 협업하여 고객 문제를 해결했던 경험을 말씀해 주세요.',
      claimedIds: ['log-hotel'],
      pool: [
        {
          id: 'log-hotel',
          body: '호텔 프런트 아르바이트 8개월. 예약 착오 고객 응대 — 인근 호텔 이동·요금 조정 안내.',
        },
        {
          id: 'log-cafe',
          body: '카페 마감 근무 3개월. 재고 정리와 주문 마감.',
        },
      ],
    });
    expect(out).toEqual([]);
  });

  it('🔴 풀이 1개면 통과 — 비교 대상이 없어 판정 근거가 없다', () => {
    const out = filterAttributableLogIds({
      text: '전혀 다른 이야기입니다.',
      claimedIds: ['only'],
      pool: [{ id: 'only', body: '교내 투자동아리 재무제표 분석.' }],
    });
    expect(out).toEqual(['only']);
  });

  it('풀 밖 id 는 그대로 제거 (기존 hallucination 방어 유지)', () => {
    const out = filterAttributableLogIds({
      text: 'Redis 캐시 도입 경험입니다.',
      claimedIds: ['log-redis', 'log-forged'],
      pool: A1_POOL,
    });
    expect(out).toEqual(['log-redis']);
  });

  it('빈 배열은 빈 배열', () => {
    expect(
      filterAttributableLogIds({ text: 'x', claimedIds: [], pool: A1_POOL }),
    ).toEqual([]);
  });
});

describe('findUnsupportedTechAssertions', () => {
  /** 실측 A1 — 사용자는 DB 이름을 말한 적이 없는데 단정형 + 최우선 준비로 나왔다 */
  const A1_MATERIAL =
    '물류 스타트업 백엔드 인턴 6개월. 야간 정산 배치 40분 → 5분 단축 (인덱스 2개 추가, 쿼리 분리). ' +
    '주문 API 응답 지연 개선 — Redis 캐시 도입.';

  it('🔴 실측 위조 — 자료에 없는 MySQL 을 "추가했다고 했는데" 로 단정', () => {
    const out = findUnsupportedTechAssertions({
      text: 'MySQL에서 정산 배치 처리 시간을 줄이기 위해 인덱스 2개를 추가했다고 했는데, 어떤 쿼리 패턴을 근거로 선택했나요?',
      userMaterial: A1_MATERIAL,
    });
    expect(out).toEqual(['MySQL']);
  });

  it('자료에 있는 기술을 단정하는 것은 정상 (Redis)', () => {
    const out = findUnsupportedTechAssertions({
      text: 'Redis 캐시를 도입했다고 하셨는데, 캐시 무효화는 어떻게 처리하셨나요?',
      userMaterial: A1_MATERIAL,
    });
    expect(out).toEqual([]);
  });

  it('🔴 단정이 아니면 통과 — 공고 요건을 묻는 건 면접관이 당연히 하는 일이다', () => {
    const out = findUnsupportedTechAssertions({
      text: 'Kafka 같은 메시지 큐를 다뤄 본 경험이 있으신가요? 없다면 어떻게 학습하실 계획인가요?',
      userMaterial: A1_MATERIAL,
    });
    expect(out).toEqual([]);
  });

  it('한국어 텍스트의 비기술 영문은 오탐하지 않는다', () => {
    const out = findUnsupportedTechAssertions({
      text: 'AI 도구를 활용해 UX 개선을 했다고 했는데, KPI 는 무엇이었나요?',
      userMaterial: A1_MATERIAL,
    });
    expect(out).toEqual([]);
  });

  it('여러 개면 전부 돌려준다', () => {
    const out = findUnsupportedTechAssertions({
      text: 'Amplitude 와 Figma 를 사용했다고 했는데, 어떤 지표를 보셨나요?',
      userMaterial: '동아리 앱 문의 접수·분류 담당.',
    });
    expect(out.sort()).toEqual(['Amplitude', 'Figma']);
  });
});

describe('isDuplicateFollowup', () => {
  /** 🔴 실측 B5 — 형제 블록에 앞 꼬리가 들어 있는데도 재생산됐다 */
  it('🔴 실측 재진술 — 어절이 달라도 같은 질문으로 잡는다', () => {
    expect(
      isDuplicateFollowup(
        '배치 크기를 결정할 때 어떤 구체적인 기준을 사용하셨으며, 이 결정이 실제로 성능 향상에 어떻게 기여했는지 설명해 주세요.',
        [
          '배치 크기를 결정할 때 고려한 구체적인 기준은 무엇이었고, 그 기준이 실제로 성능 개선에 어떻게 기여했는지 말씀해 주세요.',
        ],
      ),
    ).toBe(true);
  });

  /** 🔴 실측 B2 — 부모 주제까지 이탈하며 앞 꼬리를 반복했다 */
  it('🔴 실측 재진술 — B2 Q2 ↔ Q20', () => {
    expect(
      isDuplicateFollowup(
        '이 접근 방식이 모든 상황에서 유효하다고 생각하시나요? 특히 특정 기능에 대한 문의가 많지만 실제로는 사용자 경험에 큰 영향을 미치지 않는 경우에는 어떻게 하시겠습니까?',
        [
          '이 방식이 모든 상황에서 최선의 접근이라고 생각하시나요? 만약 사용자가 자주 문의하는 항목이 실제로는 사용자 경험에 큰 영향을 미치지 않는 경우 어떻게 하시겠습니까?',
        ],
      ),
    ).toBe(true);
  });

  it('주제가 다르면 중복이 아니다', () => {
    expect(
      isDuplicateFollowup(
        '팀원과 의견이 갈렸을 때 어떻게 합의를 이끌어 내셨나요?',
        ['배치 크기를 결정할 때 고려한 기준은 무엇이었나요?'],
      ),
    ).toBe(false);
  });

  it('같은 소재라도 다른 각도면 통과시킨다 (과잉 차단 방지)', () => {
    expect(
      isDuplicateFollowup(
        '배치 처리가 실패했을 때 재처리는 어떻게 설계하시겠습니까?',
        ['배치 크기를 결정할 때 고려한 구체적인 기준은 무엇이었나요?'],
      ),
    ).toBe(false);
  });

  it.each([
    ['기존 꼬리 없음', [] as string[]],
    ['빈 문자열만', ['']],
  ])('%s → 중복 아님', (_l, existing) => {
    expect(isDuplicateFollowup('아무 질문', existing)).toBe(false);
  });

  it('빈 후보는 중복 아님 (다른 분기가 처리한다)', () => {
    expect(isDuplicateFollowup('', ['질문 하나'])).toBe(false);
  });
});

describe('measureJobPostingCoverage', () => {
  /** 실측 A1 — 공고 6요건 중 Kafka 가 0건이었다 (프롬프트에 이름까지 박았는데도) */
  const REQS = [
    'Java/Spring 서버 개발 경험',
    'RDB 설계 경험',
    '대용량 트래픽 경험',
    'Kafka 등 메시지 큐 경험',
  ];

  it('🔴 실측 — 질문에 Kafka 가 없으면 미커버로 잡힌다', () => {
    const out = measureJobPostingCoverage(
      [
        '프로세스와 스레드의 차이가 성능에 어떤 영향을 주나요?',
        '정산 데이터를 처리하는 API 에서 트랜잭션 격리 수준은?',
      ],
      REQS,
    );
    const kafka = out.find((r) => r.requirement.includes('Kafka'));
    expect(kafka?.covered).toBe(false);
    expect(out.every((r) => !r.covered)).toBe(true);
  });

  it('요건 단어가 질문에 나오면 커버로 잡는다', () => {
    const out = measureJobPostingCoverage(
      ['Kafka 로 이벤트를 다룰 때 순서 보장은 어떻게 하시겠습니까?'],
      REQS,
    );
    expect(out.find((r) => r.requirement.includes('Kafka'))?.covered).toBe(
      true,
    );
  });

  it('🔴 흔한 말로 통과되지 않는다 — "경험" 만 겹치면 미커버', () => {
    const out = measureJobPostingCoverage(
      ['본인의 경험 중 가장 어려웠던 일은 무엇인가요?'],
      REQS,
    );
    expect(out.every((r) => !r.covered)).toBe(true);
  });

  it('요건이 없으면 빈 배열', () => {
    expect(measureJobPostingCoverage(['질문'], [])).toEqual([]);
  });
});
