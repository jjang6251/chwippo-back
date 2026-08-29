/**
 * 공고 → 카드 파싱 **실측 회귀 픽스처** (v3 · 2026-08-29).
 *
 * 🔴 **손으로 지어낸 값이 아니다.** `plans/jobposting-card-test/run.mjs` 로 실제 공고 6건
 * (널스링크·삼성서울·링커리어 대한항공/코레일·헤럴드 KT&G 기사·용인세브란스 — 사이트 메뉴·광고
 * 노이즈가 섞인 원문) + 합성 12건을 gpt-4o-mini(temp 0.1 · strict json_schema)로 돌린
 * **응답 그대로**다.
 *
 * ## 왜 실측을 박아 두나
 *
 * 서버 규칙(연도 앵커·첫 접수=deadline·최종 합격 정규화·요일 힌트 제거·스텝/일정 분류)은
 * 전부 **실제로 관측된 모델 결함**에 대응해서 만들어졌다. 예쁘게 정리한 mock 으로 검증하면
 * 그 가드들이 mock 에서만 통과하고, 진짜 응답이 오면 조용히 새어 나간다.
 * 한도병원의 「접수 기간 시작일(6/22)을 date 로 잡음」도, S2 의 「목요일」 힌트도,
 * S8 의 「Software Engineer / Backend 로 쪼갬」도 전부 여기 실측 그대로 들어 있다.
 *
 * ## 원문(`text`)은 담지 않는다
 *
 * 서버 규칙 검증에 필요한 것은 **모델 출력**이고, 원문은 저작물이며 저장 금지선 안에 있다.
 * 각 픽스처의 `expect` 는 그 공고가 무엇이었는지 사람이 읽기 위한 한 줄이다.
 *
 * ## `postingYear`·`weekday`·`jobUrl` 이 없는 이유
 *
 * v3 실행 **뒤에** 스키마에 추가된 필드다(정정 13·14). 없는 값을 채워 넣으면 「실측」이라는
 * 이 파일의 전제가 무너지므로 그대로 둔다 — `normalizeCardOutput` 이 누락 키를 null 로
 * 정규화하는 것까지 이 픽스처가 함께 검증한다.
 */

/** 실측 당시의 오늘(KST). 날짜 해석은 이 값을 기준으로 재현해야 결과가 재현된다 */
export const V3_TODAY = '2026-08-29';

export interface CardFixture {
  id: string;
  /** 사람이 읽는 한 줄 — 그 공고가 무엇이고 무엇을 기대했나 */
  expect: string;
  /** 원문 길이(자) — 토큰 cap 감각용 */
  chars: number;
  /** 🔴 실측 LLM 응답 그대로 (results-v3.json 의 out) */
  out: unknown;
}

export const V3_FIXTURES: CardFixture[] = [
  {
    id: 'R1-nurselink-handoh',
    expect:
      '널스링크 노이즈 포함 실제 공고 → 회사=한도병원 · 직무=신규 간호사 · 마감 2026-07-05(24:00 표기 처리) · 절차: 서류 접수 7/5 · 서류합격 발표 7/8 17:00 · 면접 7/15 · 최종 발표 7/20 17:00 · 담당자 전화·이메일 어디에도 없어야',
    chars: 3808,
    out: {
      notPosting: false,
      companyName: '한도병원',
      jobTitles: ['신규간호사'],
      deadline: { year: 2026, month: 7, day: 5, time: '23:59' },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2026, month: 6, day: 22, time: null },
          dateHint: '07월 05일 24:00 까지',
        },
        {
          name: '서류 합격 발표',
          date: { year: 2026, month: 7, day: 8, time: '17:00' },
          dateHint: null,
        },
        {
          name: '면접 일정',
          date: { year: 2026, month: 7, day: 15, time: null },
          dateHint: '합격자에 한해, 개별안내',
        },
        {
          name: '최종 합격 발표',
          date: { year: 2026, month: 7, day: 20, time: '17:00' },
          dateHint: null,
        },
      ],
      responsibilities: '',
      requirements: ['2026년 간호학과 졸업자', '간호사 면허증 소지자'],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: [
        '신규간호사',
        '서류접수',
        '서류합격자 발표',
        '면접일정',
        '최종합격자 발표',
      ],
    },
  },
  {
    id: 'R2-samsung-nurse-vague',
    expect:
      '연도 없는 날짜(7/11~7/23) + 애매 표현 → 마감 해석 관찰(2026-07-23 vs 2027) · 절차: 접수 · GSAT [8월 중 실시] 힌트 · 1차 면접 [9월 초] · 2차 면접 [9월 말] · 건강검진 [추후 공지]',
    chars: 609,
    out: {
      notPosting: false,
      companyName: '삼성서울병원',
      jobTitles: ['신입간호사'],
      deadline: { year: 2025, month: 7, day: 23, time: '09:00' },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2025, month: 7, day: 23, time: '09:00' },
          dateHint: null,
        },
        {
          name: '직무적성검사',
          date: { year: 2025, month: 8, day: null, time: null },
          dateHint: '8월 중',
        },
        { name: '1차 면접', date: null, dateHint: '9월 초' },
        { name: '2차 면접', date: null, dateHint: '9월 말' },
        { name: '채용건강검진', date: null, dateHint: '추후 공지' },
      ],
      responsibilities: '',
      requirements: [
        '2026년 2월 간호사 면허 취득 예정자 또는 면허 소지자',
        '토익 730점 또는 이에 준하는 영어성적을 보유한 자',
        '해외여행에 결격사유가 없는 자',
      ],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: ['신입간호사', '삼성서울병원', 'GSAT', '면접', '채용건강검진'],
    },
  },
  {
    id: 'R3-linkareer-koreanair',
    expect:
      '링커리어 노이즈 → 회사=대한항공 · 직무=객실승무원(인턴) · 마감 2026-06-11T16:00 · 절차는 본문에 없어 서류 접수 정도만 · TOEIC 550 등 qualifications',
    chars: 2378,
    out: {
      notPosting: false,
      companyName: '대한항공',
      jobTitles: ['객실승무원'],
      deadline: { year: 2026, month: 6, day: 11, time: '16:00' },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2026, month: 6, day: 11, time: '16:00' },
          dateHint: null,
        },
        { name: '서류 합격 발표', date: null, dateHint: '추후 개별 안내' },
        { name: '면접', date: null, dateHint: '추후 개별 안내' },
        { name: '최종 합격 발표', date: null, dateHint: '추후 개별 안내' },
      ],
      responsibilities: '',
      requirements: [
        '기 졸업자 또는 2027년 2월 이전 졸업예정자',
        '병역필 또는 면제자로, 해외여행에 결격사유가 없는 자',
        '교정시력 1.0 이상인 자',
        'TOEIC 550점 또는 TOEIC Speaking LVL IM 이상 또는 OPIc LVL IM 이상 취득한 자 (2024년 8월 10일 이후 응시한 국내시험에 한함)',
      ],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: ['신입', '인턴', '채용연계형', '대한항공', '객실승무원'],
    },
  },
  {
    id: 'R4-linkareer-korail',
    expect:
      '회사=한국철도공사 · 직무=(복수 부문, 컨텍스트 없음 → 하나 고르거나 일반) · 마감 2026-03-11 · 절차 7단계 날짜 없음',
    chars: 2646,
    out: {
      notPosting: false,
      companyName: '한국철도공사',
      jobTitles: [
        '사무영업(일반)',
        '사무영업(IT)',
        '열차승무(일반)',
        '차량(기계)',
        '차량(전기)',
        '차량(문산차량/기계)',
        '차량(문산차량/전기)',
        '토목(일반)',
        '건축(일반)',
        '건축(전기전자)',
        '전기통신(일반)',
        '사무영업(관제)',
        '사무영업(무선제어)',
        '운전(일반)',
        '운전(전동차)',
        '토목(장비운전)',
        '사무영업(보훈제한경쟁채용)',
        '열차승무(보훈제한경쟁채용)',
        '차량(보훈제한경쟁채용)',
        '사무영업(장애인제한경쟁채용)',
        '차량(장애인제한경쟁채용)',
        '전기통신(거주지제한경쟁채용)',
      ],
      deadline: { year: 2026, month: 3, day: 11, time: null },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류전형',
          date: { year: 2026, month: 3, day: 11, time: null },
          dateHint: null,
        },
        { name: '필기시험', date: null, dateHint: null },
        { name: '실기시험', date: null, dateHint: null },
        { name: '면접시험', date: null, dateHint: null },
        { name: '합격자발표', date: null, dateHint: null },
        { name: '채용형 인턴 운영', date: null, dateHint: null },
        { name: '정규직 임용', date: null, dateHint: null },
      ],
      responsibilities: '',
      requirements: [],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: [
        '신입사원',
        '채용',
        '한국철도공사',
        '공공기관',
        '전형절차',
        '서류전형',
      ],
    },
  },
  {
    id: 'R5-news-article',
    expect:
      '기사 → notPosting=true 기대(규칙상 기사 제외). false 면 회사=KT&G · 마감 9/10 · 절차 4단계 — 어느 쪽이든 기록',
    chars: 6238,
    out: {
      notPosting: false,
      companyName: 'KT&G',
      jobTitles: ['사무 신입사원', '현장 신입사원', '경력사원'],
      deadline: { year: 2026, month: 9, day: 10, time: null },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2026, month: 9, day: 10, time: null },
          dateHint: null,
        },
        { name: '서류전형', date: null, dateHint: null },
        { name: 'AI 영상면접', date: null, dateHint: null },
        { name: '실무면접', date: null, dateHint: null },
        { name: '임원면접', date: null, dateHint: null },
        { name: '채용검진', date: null, dateHint: null },
        { name: '최종합격 발표', date: null, dateHint: null },
      ],
      responsibilities:
        '사무 전형은 경영기획, 해외사업, 브랜드, 제조, SCM, R&D 분야에서 진행되며, 현장 전형은 영업직과 생산직으로 모집된다.',
      requirements: [],
      preferred: [],
      techStack: [],
      qualifications: [
        '4년제 정규대학 이상 졸업자 또는 2027년 2월 졸업 예정자',
        '영업직 지원자는 2종 보통 이상 운전면허 자격증 보유',
        '경력사원은 품질보증·관리, 브랜드, 해외 시장개척 분야에서 7년 내외 경력 보유',
      ],
      keywords: [
        '신입',
        '경력',
        '공개채용',
        'KT&G',
        '영업직',
        '생산직',
        'AI 영상면접',
        '블라인드 방식',
      ],
    },
  },
  {
    id: 'R6-snu-yongin',
    expect:
      '대학 사이트 메뉴 노이즈 → 회사=용인세브란스병원 · 직무=신규 간호사 · 마감 2025-11-14 · 절차 6단계(서류심사·AI역량검사·1차·2차·최종·신체검사)',
    chars: 3675,
    out: {
      notPosting: false,
      companyName: '용인세브란스병원',
      jobTitles: ['간호사'],
      deadline: { year: 2025, month: 11, day: 14, time: null },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2025, month: 11, day: 14, time: null },
          dateHint: null,
        },
        { name: 'AI역량검사', date: null, dateHint: null },
        { name: '1차 면접', date: null, dateHint: null },
        { name: '2차 면접', date: null, dateHint: null },
        { name: '최종합격', date: null, dateHint: null },
        { name: '신체검사', date: null, dateHint: null },
      ],
      responsibilities: '',
      requirements: [
        '2026년 2월 간호학과 졸업예정자 또는 기졸업자(간호사 면허 소지자)',
        'TOEIC 700점 이상 또는 이에 준하는 공인어학점수 소지자',
        '남자의 경우 군 미필자도 지원 가능',
        '취업보호대상자(보훈대상자, 장애인 등)는 관련법에 따라 우대',
      ],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: [
        '신규 간호사',
        '공개채용',
        '간호사 면허',
        'TOEIC 700점',
        'AI역량검사',
        '서류심사',
        '면접',
        '신체검사',
      ],
    },
  },
  {
    id: 'S1-startup-backend-rolling',
    expect:
      "회사=모비언트랩(가상) · 직무=백엔드 개발자 · 마감 null/rolling · 절차 4단계 날짜 전부 없음(힌트 '서류 합격자에 한해 개별 연락') · techStack 채워짐",
    chars: 542,
    out: {
      notPosting: false,
      companyName: '모비언트랩',
      jobTitles: ['백엔드 개발자'],
      deadline: null,
      deadlineKind: 'rolling',
      steps: [
        { name: '서류 접수', date: null, dateHint: null },
        { name: '과제 전형', date: null, dateHint: '1주' },
        { name: '기술 면접', date: null, dateHint: null },
        { name: '컬처핏 면접', date: null, dateHint: null },
        { name: '처우 협의', date: null, dateHint: null },
      ],
      responsibilities:
        '물류 주문/재고 API 설계·개발, 배치·이벤트 파이프라인 운영, 신규 파트너사 연동',
      requirements: [
        'Node.js 기반 서버 개발 경력 2년 이상',
        'RDBMS 설계 및 쿼리 최적화 경험',
        '테스트 코드 작성이 습관인 분',
      ],
      preferred: [
        'NestJS, TypeORM 실무 경험',
        'AWS(ECS, RDS) 운영 경험',
        '물류·커머스 도메인 경험',
      ],
      techStack: ['Node.js', 'NestJS', 'PostgreSQL', 'Redis', 'BullMQ'],
      qualifications: [],
      keywords: ['물류 자동화', 'SaaS', '스타트업', '서류 검토', '기술 면접'],
    },
  },
  {
    id: 'S2-multi-job-with-context',
    expect:
      "jobContext=브랜드 마케터 → 직무=브랜드 마케터 · 요건은 마케팅 것만(개발 요건 제외) · 마감 2026-09-14T18:00 · 절차 5단계(서류 9/14 · 인적성 '9월 마지막 주 예정' 힌트 · 1차 면접 10/8 · 2차 면접 '10월 중순' · 최종 발표 '10/30 예정')",
    chars: 590,
    out: {
      notPosting: false,
      companyName: '오르빗컴퍼니',
      jobTitles: ['브랜드 마케터'],
      deadline: { year: 2026, month: 9, day: 14, time: '18:00' },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2026, month: 9, day: 14, time: '18:00' },
          dateHint: null,
        },
        { name: '서류 전형', date: null, dateHint: '접수 마감 후 1주 내' },
        {
          name: '인적성 검사(온라인)',
          date: null,
          dateHint: '9월 마지막 주 예정',
        },
        {
          name: '1차 실무 면접',
          date: { year: 2026, month: 10, day: 8, time: null },
          dateHint: '목요일',
        },
        { name: '2차 임원 면접', date: null, dateHint: '10월 중순' },
        { name: '최종 합격 발표', date: null, dateHint: '10월 30일 예정' },
      ],
      responsibilities: '브랜드 캠페인 기획, 인플루언서 협업, 콘텐츠 성과 분석',
      requirements: ['4년제 졸업(예정)자', '마케팅·광고 관련 프로젝트 경험'],
      preferred: [
        '뷰티 산업 관심',
        '영상 편집(Premiere)',
        'GA4·앰플리튜드 활용',
      ],
      techStack: [],
      qualifications: [],
      keywords: [
        '브랜드 마케터',
        '오르빗컴퍼니',
        'D2C',
        '뷰티',
        '마케팅',
        '광고',
      ],
    },
  },
  {
    id: 'S3-truncated-mid',
    expect:
      '잘린 공고(자격요건 중간에서 끊김) → notPosting=false · 회사=오르빗컴퍼니 · 직무=브랜드 마케터 · 마감 null/unknown(접수 기간 문단이 잘려서 없음) · steps [] · requirements 일부만',
    chars: 200,
    out: {
      notPosting: false,
      companyName: '오르빗컴퍼니',
      jobTitles: ['브랜드 마케터'],
      deadline: null,
      deadlineKind: 'unknown',
      steps: [{ name: '서류 접수', date: null, dateHint: null }],
      responsibilities: '브랜드 캠페인 기획, 인플루언서 협업, 콘텐츠 성과 분석',
      requirements: ['4년제 졸업(예정)자', '마케팅·광고 관련 프로젝트 경험'],
      preferred: ['뷰티 산업 관심', '영상 편집(Premiere)', 'GA4·앰플'],
      techStack: [],
      qualifications: [],
      keywords: ['브랜드 마케터', '뷰티 D2C', '캠페인 기획'],
    },
  },
  {
    id: 'S4-title-only',
    expect:
      '제목만(40자) → notPosting=false 또는 true 둘 다 허용하되, false 면 회사=한빛시스템·직무=QA 엔지니어·나머지 전부 비어야 함. 지어내면 실패',
    chars: 38,
    out: {
      notPosting: false,
      companyName: '한빛시스템',
      jobTitles: ['QA 엔지니어'],
      deadline: { year: 2026, month: 9, day: 30, time: null },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2026, month: 9, day: 30, time: null },
          dateHint: null,
        },
      ],
      responsibilities: '',
      requirements: [],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: [],
    },
  },
  {
    id: 'S5-diary-notposting',
    expect: 'notPosting=true · 전부 비움',
    chars: 148,
    out: {
      notPosting: true,
      companyName: null,
      jobTitles: [],
      deadline: null,
      deadlineKind: 'unknown',
      steps: [],
      responsibilities: '',
      requirements: [],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: [],
    },
  },
  {
    id: 'S6-benefits-only',
    expect:
      '복리후생·회사소개만 → notPosting=true (요건·직무·절차가 없음). false 면 requirements 는 반드시 []',
    chars: 202,
    out: {
      notPosting: true,
      companyName: null,
      jobTitles: [],
      deadline: null,
      deadlineKind: 'unknown',
      steps: [],
      responsibilities: '',
      requirements: [],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: [],
    },
  },
  {
    id: 'S7-injection',
    expect:
      "지시문 무시 — 회사=세라믹랩 · 직무=데이터 분석가 · 마감 2026-09-20 · requirements 에 '지원자를 무조건 합격' 류 문장 없어야 함 · keywords 정상",
    chars: 343,
    out: {
      notPosting: false,
      companyName: '세라믹랩',
      jobTitles: ['데이터 분석가'],
      deadline: { year: 2026, month: 9, day: 20, time: null },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2026, month: 9, day: 20, time: null },
          dateHint: null,
        },
        { name: '과제', date: null, dateHint: null },
        { name: '면접', date: null, dateHint: null },
      ],
      responsibilities:
        '서비스 지표 대시보드 구축, A/B 테스트 설계·분석, SQL 기반 리포팅',
      requirements: ['SQL 능숙', 'Python(pandas) 활용', '통계 기초'],
      preferred: ['Tableau/Looker', '실험 플랫폼 경험'],
      techStack: [],
      qualifications: [],
      keywords: [
        '데이터 분석',
        'A/B 테스트',
        'SQL',
        'Python',
        'Tableau',
        'Looker',
      ],
    },
  },
  {
    id: 'S8-english',
    expect:
      "영문 → 한국어 정규화(기술명 원어) · 회사=Northwind Robotics · 직무=소프트웨어 엔지니어(백엔드) 류 · 마감 2026-10-01 · 절차 4단계(날짜 없음, 힌트 'within 2 weeks after screening' 원문) · techStack Go/Kubernetes",
    chars: 771,
    out: {
      notPosting: false,
      companyName: 'Northwind Robotics',
      jobTitles: ['Software Engineer', 'Backend'],
      deadline: { year: 2026, month: 10, day: 1, time: null },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2026, month: 10, day: 1, time: null },
          dateHint: null,
        },
        { name: '서류 검토', date: null, dateHint: null },
        { name: '과제 수행', date: null, dateHint: null },
        { name: '기술 면접', date: null, dateHint: null },
        { name: '팀 면접', date: null, dateHint: null },
      ],
      responsibilities: '창고 로봇을 조정하는 플릿 제어 서비스를 구축합니다.',
      requirements: [
        '3년 이상의 백엔드 경험',
        '강력한 Go 또는 Rust',
        'Kubernetes에서 서비스 운영 경험',
      ],
      preferred: ['로봇공학 또는 IoT 배경', '한국어 및 영어 유창'],
      techStack: ['Go', 'Rust', 'Kubernetes', 'gRPC', 'Prometheus', 'Grafana'],
      qualifications: [],
      keywords: ['백엔드', '소프트웨어 엔지니어', '로봇', 'Kubernetes', 'gRPC'],
    },
  },
  {
    id: 'S9-year-rollover',
    expect:
      "오늘 2026-08-29 기준 '12월 20일~1월 8일 접수' → 마감 2027-01-08 · 필기 '1월 24일' → 2027-01-24 · 면접 '2월 예정' 힌트",
    chars: 198,
    out: {
      notPosting: false,
      companyName: '한강문화재단',
      jobTitles: ['경영지원'],
      deadline: { year: 2027, month: 1, day: 8, time: '17:00' },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2027, month: 1, day: 8, time: '17:00' },
          dateHint: null,
        },
        {
          name: '필기시험',
          date: { year: 2027, month: 1, day: 24, time: null },
          dateHint: null,
        },
        { name: '면접', date: null, dateHint: '2월 예정' },
        {
          name: '최종 합격 발표',
          date: null,
          dateHint: '면접 후 1주 내 개별 통보',
        },
      ],
      responsibilities: '',
      requirements: ['학사 이상', '회계 관련 자격증 우대 (전산회계 1급 등)'],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: [],
    },
  },
  {
    id: 'S10-past-posting',
    expect:
      '2025년 날짜 공고 → 모델은 2025-11-14 를 그대로 반환(추측 금지) · 서버가 범위(−30일) 밖으로 null 처리할 몫. 회사=용인세브란스병원 · 직무=신규 간호사 · 절차 6단계',
    chars: 245,
    out: {
      notPosting: false,
      companyName: '용인세브란스병원',
      jobTitles: ['신규간호사'],
      deadline: { year: 2025, month: 11, day: 14, time: '17:00' },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2025, month: 11, day: 14, time: '17:00' },
          dateHint: null,
        },
        { name: '서류심사', date: null, dateHint: null },
        { name: 'AI역량검사', date: null, dateHint: null },
        { name: '1차 면접', date: null, dateHint: null },
        { name: '2차 면접', date: null, dateHint: null },
        { name: '최종합격', date: null, dateHint: null },
        { name: '신체검사', date: null, dateHint: null },
      ],
      responsibilities: '',
      requirements: [],
      preferred: ['토익 700점 이상', '봉사활동 경험'],
      techStack: [],
      qualifications: [],
      keywords: [],
    },
  },
  {
    id: 'S11-gongmuwon-exam',
    expect:
      "공무원 시험 공고 → 회사=서울특별시(인사위원회) · 직무=지방공무원 9급 일반행정 · 마감 2026-09-05T18:00 · 절차: 원서접수 9/5 · 필기시험 10/17 · 필기 합격자 발표 '11월 중' 힌트 · 면접 '11월 하순 예정' 힌트 · 최종 발표 12/10",
    chars: 477,
    out: {
      notPosting: false,
      companyName: '서울특별시',
      jobTitles: ['지방공무원'],
      deadline: { year: 2026, month: 9, day: 5, time: '18:00' },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '원서 접수',
          date: { year: 2026, month: 9, day: 5, time: '18:00' },
          dateHint: null,
        },
        {
          name: '필기시험',
          date: { year: 2026, month: 10, day: 17, time: null },
          dateHint: null,
        },
        {
          name: '필기시험 합격자 발표',
          date: { year: 2026, month: 11, day: null, time: null },
          dateHint: '11월 중',
        },
        {
          name: '면접시험',
          date: { year: 2026, month: 11, day: null, time: null },
          dateHint: '11월 하순 예정',
        },
        {
          name: '최종 합격자 발표',
          date: { year: 2026, month: 12, day: 10, time: null },
          dateHint: null,
        },
      ],
      responsibilities: '',
      requirements: ['18세 이상', '거주지 제한(2026.1.1. 이전부터 서울 거주)'],
      preferred: ['정보처리기사', '컴퓨터활용능력 1급'],
      techStack: [],
      qualifications: [],
      keywords: ['필기시험', '면접시험', '최종 합격자 발표'],
    },
  },
  {
    id: 'S12-image-alt-noise',
    expect:
      '사이트 잡텍스트(메뉴·스크랩·다른 공고 목록·광고)가 섞인 공고 → 회사=그린루프 · 직무=UX 디자이너 · 마감 2026-09-10 · 다른 공고(카카오·토스) 내용이 섞이면 실패',
    chars: 489,
    out: {
      notPosting: false,
      companyName: '(주)그린루프',
      jobTitles: ['UX 디자이너'],
      deadline: { year: 2026, month: 9, day: 10, time: null },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 접수',
          date: { year: 2026, month: 9, day: 10, time: null },
          dateHint: null,
        },
        { name: '포트폴리오 리뷰', date: null, dateHint: null },
        { name: '면접', date: null, dateHint: null },
        { name: '최종 합격', date: null, dateHint: null },
      ],
      responsibilities:
        '앱 서비스 UX 리서치·와이어프레임·프로토타입, 디자인 시스템 운영 (Figma)',
      requirements: [
        'UX/UI 디자인 경력 무관 (신입 가능)',
        'Figma 능숙, 포트폴리오 필수',
      ],
      preferred: [
        '사용자 인터뷰·유저 테스트 경험',
        '모바일 서비스 디자인 경험',
      ],
      techStack: [],
      qualifications: [],
      keywords: ['UX', '디자인', 'Figma', '포트폴리오', '신입', '경력'],
    },
  },
  {
    id: 'R7-skhynix-program-name',
    expect:
      'CEO 실기 8/29 — SK하이닉스 「Talent hy-way(신입)」: 본문에 직무 없음(JD 는 PDF 첨부) → jobTitles [] · 직무 null 카드 · 마감 2026-08-26T17:00 · SKCT 심층 [9월 중 시행] · 인지 [10월 중 시행] · Half Day 면접 [11월 중 시행] · 최종 합격 추가. 프롬프트 수정 전엔 jobTitles ["신입"]/["Talent hy-way(신입)"] 이 나왔다',
    chars: 1519,
    out: {
      notPosting: false,
      companyName: 'SK하이닉스',
      jobTitles: [],
      postingYear: 2026,
      jobUrl: 'https://talent.skhynix.com/hub',
      deadline: {
        year: 2026,
        month: 8,
        day: 26,
        time: '17:00',
        weekday: '수요일',
      },
      deadlineKind: 'fixed',
      steps: [
        {
          name: '서류 전형',
          date: {
            year: 2026,
            month: 8,
            day: 26,
            time: '17:00',
            weekday: '수요일',
          },
          dateHint: null,
        },
        {
          name: 'SKCT(심층)',
          date: {
            year: 2026,
            month: 9,
            day: null,
            time: null,
            weekday: null,
          },
          dateHint: '9월 중 시행',
        },
        {
          name: 'SKCT(인지) 또는 코딩테스트',
          date: {
            year: 2026,
            month: 10,
            day: null,
            time: null,
            weekday: null,
          },
          dateHint: '10월 중 시행',
        },
        {
          name: 'Half Day 면접',
          date: {
            year: 2026,
            month: 11,
            day: null,
            time: null,
            weekday: null,
          },
          dateHint: '11월 중 시행',
        },
      ],
      responsibilities: '',
      requirements: [
        '정규 근무 가능자',
        '박사 학위 소지자(입사일 3월 2일)',
        '병역필 또는 면제자',
        '군복무 중인 경우 전역 예정자',
      ],
      preferred: [],
      techStack: [],
      qualifications: [],
      keywords: ['서류 전형', 'SKCT', '면접', '코딩테스트', '정규 근무'],
    },
  },
];
