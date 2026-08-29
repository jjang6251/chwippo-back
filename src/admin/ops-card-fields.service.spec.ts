import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CompaniesService } from '../companies/companies.service';
import { OpsCardFieldsService } from './ops-card-fields.service';

/**
 * 🔴 **이 화면의 숫자는 제품 결정의 근거가 된다.** 「직군 칩 30개를 없앨까」
 * 「자동완성이 답인가」가 여기 나온 값으로 갈린다. 틀려도 화면은 멀쩡해 보이므로
 * 눈으로는 절대 못 잡는다 — 오염 경로를 하나씩 고정한다.
 *
 * ## 🔴 이 spec 이 검증하지 **못하는** 것 — 먼저 적는다
 *
 * `dataSource.query` 를 mock 하므로 **SQL 자체는 여기서 검증되지 않는다.**
 * 제외 3종(`role <> 'admin'` · `is_sample = false` · `deleted_at IS NULL`),
 * `FILTER` 절, `LATERAL` 조인이 맞는지는 **진짜 Postgres 에서만** 확인된다.
 * 내가 만든 픽스처로 내 SQL 전제를 검증할 수는 없다.
 *
 * 아래 케이스가 지키는 것은 **DB 가 준 행을 받은 뒤의 TS 판정 로직**이다:
 * 어휘 분류 · 표기 흔들림 · 회사명 접기 · 관측 컬럼 집계. 이 넷이 전부
 * 「사람이 보기엔 맞아 보이는데 조용히 틀리는」 종류라 spec 이 유일한 방어다.
 */

interface DetailOver {
  user_id?: string;
  job_title?: string | null;
  job_category?: string | null;
  company_name?: string;
  status?: string;
  template_id?: string | null;
  created_via?: string | null;
  /** ARRAY_AGG 결과 — 스텝이 없으면 드라이버가 null 을 준다 (빈 배열이 아니다) */
  step_names?: string[] | null;
}

function detail(over: DetailOver = {}) {
  return {
    user_id: 'u1',
    job_title: null,
    job_category: null,
    company_name: '삼성전자',
    status: 'IN_PROGRESS',
    template_id: null,
    created_via: null,
    step_names: null,
    ...over,
  };
}

/** 드라이버가 숫자를 문자열로 줄 수 있어 그대로 흉내낸다 */
function agg(over: Record<string, unknown> = {}) {
  return {
    cards: '0',
    users: '0',
    job_title: '0',
    job_category: '0',
    job_url: '0',
    memo: '0',
    at_first_step: '0',
    moved: '0',
    no_steps: '0',
    ...over,
  };
}

describe('OpsCardFieldsService', () => {
  let service: OpsCardFieldsService;
  let query: jest.Mock;

  /** 세 쿼리(집계·상세·제외)를 순서대로 돌려준다 — `Promise.all` 순서에 맞춘다 */
  function mockDb(
    detailRows: ReturnType<typeof detail>[],
    aggOver: Record<string, unknown> = {},
    excluded = { admin_cards: '0', sample_cards: '0' },
  ) {
    query.mockReset();
    query
      .mockResolvedValueOnce([
        agg({ cards: String(detailRows.length), ...aggOver }),
      ])
      .mockResolvedValueOnce(detailRows)
      .mockResolvedValueOnce([excluded]);
  }

  beforeEach(async () => {
    query = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpsCardFieldsService,
        {
          provide: getDataSourceToken(),
          useValue: { query } as Partial<DataSource>,
        },
        {
          provide: CompaniesService,
          // 사전에 「삼성전자」만 있는 상태 — 매칭/미매칭을 가르는 최소 구성
          useValue: {
            getAllNames: () => ['삼성전자'],
          } as Partial<CompaniesService>,
        },
      ],
    }).compile();
    service = module.get(OpsCardFieldsService);
  });

  describe('분모와 제외', () => {
    it('카드 0장 → 전부 0 · 크래시 없다', async () => {
      mockDb([]);
      const r = await service.getCardFields();

      expect(r.cards).toBe(0);
      expect(r.users).toBe(0);
      expect(r.fields.jobTitle.filled).toBe(0);
      expect(r.jobTitleVariance.usersWithVariants).toBe(0);
      expect(r.companyMatch.distinctNames).toBe(0);
    });

    it('🔴 제외된 카드 수를 명시한다 — 조용히 빼면 합계가 안 맞아 보인다', async () => {
      mockDb([detail()], {}, { admin_cards: '99', sample_cards: '3' });
      const r = await service.getCardFields();

      expect(r.excluded.adminCards).toBe(99);
      expect(r.excluded.sampleCards).toBe(3);
    });

    it('숫자가 문자열로 와도 number 로 돌려준다 (pg 드라이버)', async () => {
      mockDb([detail()], { cards: '11', users: '3', job_title: '9' });
      const r = await service.getCardFields();

      expect(r.cards).toBe(11);
      expect(r.users).toBe(3);
      expect(r.fields.jobTitle.filled).toBe(9);
    });
  });

  describe('직군 어휘 — 한 컬럼에 몇 갈래가 섞여 있나', () => {
    it('🔴 콤마 직렬화를 분해해서 센다 — 통째로 세면 조합이 미지 어휘가 된다', async () => {
      mockDb([detail({ job_category: '백엔드 개발,데이터·AI' })]);
      const r = await service.getCardFields();

      const known = r.categoryVocab.buckets.find((b) => b.vocab === 'known');
      expect(known?.distinctValues).toBe(2);
      expect(r.categoryVocab.top.map((t) => t.value).sort()).toEqual(
        ['데이터·AI', '백엔드 개발'].sort(),
      );
    });

    it('21개 목록 안의 값 → known', async () => {
      mockDb([detail({ job_category: '마케팅·광고' })]);
      const r = await service.getCardFields();

      expect(r.categoryVocab.top[0]).toMatchObject({
        value: '마케팅·광고',
        vocab: 'known',
      });
    });

    it('🔴 목록 밖 + 여러 장 → freeform_repeated (목록의 구멍이다)', async () => {
      mockDb([
        detail({ user_id: 'u1', job_category: '간호사' }),
        detail({ user_id: 'u2', job_category: '간호사' }),
      ]);
      const r = await service.getCardFields();

      expect(r.categoryVocab.top[0]).toMatchObject({
        value: '간호사',
        cards: 2,
        vocab: 'freeform_repeated',
      });
    });

    it('목록 밖 + 한 장 → freeform_once (그 사람의 표현일 뿐)', async () => {
      mockDb([detail({ job_category: '크레인 기사' })]);
      const r = await service.getCardFields();

      expect(r.categoryVocab.top[0].vocab).toBe('freeform_once');
    });

    it('빈 값·공백은 어휘로 세지 않는다', async () => {
      mockDb([detail({ job_category: '  ' }), detail({ job_category: null })]);
      const r = await service.getCardFields();

      expect(r.categoryVocab.top).toHaveLength(0);
    });
  });

  describe('직무 표기 흔들림 — 「자동완성이 답이다」의 유일한 직접 근거', () => {
    it('한 사람이 백엔드 · 백엔드 개발자 → 흔들림으로 잡는다', async () => {
      mockDb([
        detail({ user_id: 'u1', job_title: '백엔드' }),
        detail({ user_id: 'u1', job_title: '백엔드 개발자' }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleVariance.usersWithVariants).toBe(1);
      expect(r.jobTitleVariance.groups[0].variants.sort()).toEqual([
        '백엔드',
        '백엔드 개발자',
      ]);
    });

    it('🔴 서로 다른 사람이 하나씩 → 흔들림이 **아니다**', async () => {
      // 이걸 뭉치면 "두 사람의 서로 다른 표현" 이 "한 사람이 흔들렸다" 로 둔갑한다.
      // 자동완성으로 해결되는 문제가 아니므로 근거가 통째로 거짓이 된다.
      mockDb([
        detail({ user_id: 'u1', job_title: '백엔드' }),
        detail({ user_id: 'u2', job_title: '백엔드 개발자' }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleVariance.usersWithJobTitle).toBe(2);
      expect(r.jobTitleVariance.usersWithVariants).toBe(0);
      expect(r.jobTitleVariance.groups).toHaveLength(0);
    });

    it('공백·구두점만 다른 표기도 잡는다', async () => {
      mockDb([
        detail({ user_id: 'u1', job_title: '백엔드개발자' }),
        detail({ user_id: 'u1', job_title: '백엔드 개발자' }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleVariance.usersWithVariants).toBe(1);
    });

    it('🔴 무관한 두 직무는 흔들림이 아니다 (여러 직무 지원자)', async () => {
      mockDb([
        detail({ user_id: 'u1', job_title: '백엔드' }),
        detail({ user_id: 'u1', job_title: '마케팅' }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleVariance.usersWithVariants).toBe(0);
    });

    it('같은 직무를 여러 장에 똑같이 적은 것은 흔들림이 아니다', async () => {
      mockDb([
        detail({ user_id: 'u1', job_title: '백엔드' }),
        detail({ user_id: 'u1', job_title: '백엔드' }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleVariance.usersWithJobTitle).toBe(1);
      expect(r.jobTitleVariance.usersWithVariants).toBe(0);
    });

    it('직무가 빈 카드는 분모(usersWithJobTitle)에서 빠진다', async () => {
      mockDb([
        detail({ user_id: 'u1', job_title: '백엔드' }),
        detail({ user_id: 'u2', job_title: '   ' }),
        detail({ user_id: 'u3', job_title: null }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleVariance.usersWithJobTitle).toBe(1);
    });
  });

  describe('직무 원문 빈도 — 사전 어휘 작업의 재료', () => {
    it('원문을 빈도순으로 세고 distinct 를 준다', async () => {
      mockDb([
        detail({ user_id: 'u1', job_title: '백엔드' }),
        detail({ user_id: 'u2', job_title: '백엔드' }),
        detail({ user_id: 'u3', job_title: '프론트엔드' }),
        detail({ user_id: 'u4', job_title: '마케팅' }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleTexts.distinct).toBe(3);
      expect(r.jobTitleTexts.top).toEqual([
        { value: '백엔드', cards: 2 },
        { value: '마케팅', cards: 1 },
        { value: '프론트엔드', cards: 1 },
      ]);
    });

    it('🔴 표기만 다른 같은 직무는 한 줄로 접히고, 대표는 최다 빈도 원문이다', async () => {
      // 안 접으면 같은 직무가 두 줄로 보여 사전 후보가 부풀고, 대표를 정규화 키
      // (`백엔드개발자`)로 두면 **아무도 안 쓰는 표기**가 사전에 올라간다.
      mockDb([
        detail({ user_id: 'u1', job_title: '백엔드 개발자' }),
        detail({ user_id: 'u2', job_title: '백엔드 개발자' }),
        detail({ user_id: 'u3', job_title: '백엔드개발자' }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleTexts.distinct).toBe(1);
      expect(r.jobTitleTexts.top).toEqual([
        { value: '백엔드 개발자', cards: 3 },
      ]);
    });

    it('빈도가 같으면 가나다 순 — DB 가 준 행 순서에 흔들리지 않는다', async () => {
      mockDb([
        detail({ user_id: 'u1', job_title: '프론트엔드' }),
        detail({ user_id: 'u2', job_title: '데이터 분석' }),
        detail({ user_id: 'u3', job_title: '마케팅' }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleTexts.top.map((t) => t.value)).toEqual([
        '데이터 분석',
        '마케팅',
        '프론트엔드',
      ]);
    });

    it('빈 값·공백만 적힌 카드는 어휘로 세지 않는다', async () => {
      mockDb([
        detail({ user_id: 'u1', job_title: null }),
        detail({ user_id: 'u2', job_title: '' }),
        detail({ user_id: 'u3', job_title: '   ' }),
      ]);
      const r = await service.getCardFields();

      expect(r.jobTitleTexts).toEqual({ distinct: 0, top: [] });
    });

    it('🔴 목록은 50 에서 자르되 distinct 는 전수다 — 상한에 닿았는지 알 수 있어야 한다', async () => {
      const rows = Array.from({ length: 51 }, (_, i) =>
        detail({
          user_id: `u${i}`,
          job_title: `직무 ${String(i + 1).padStart(2, '0')}`,
        }),
      );
      // 한 장을 더 얹어 빈도 1위를 만든다 (자르기가 빈도순으로 도는지까지 본다)
      rows.push(detail({ user_id: 'u99', job_title: '직무 01' }));
      mockDb(rows);
      const r = await service.getCardFields();

      expect(r.jobTitleTexts.distinct).toBe(51);
      expect(r.jobTitleTexts.top).toHaveLength(50);
      expect(r.jobTitleTexts.top[0]).toEqual({ value: '직무 01', cards: 2 });
    });
  });

  describe('회사명 — DART 사전이 현실을 덮나', () => {
    it('사전에 있는 이름은 matched', async () => {
      mockDb([detail({ company_name: '삼성전자' })]);
      const r = await service.getCardFields();

      expect(r.companyMatch).toMatchObject({
        distinctNames: 1,
        matchedNames: 1,
      });
      expect(r.companyMatch.topUnmatched).toHaveLength(0);
    });

    it('앞뒤 공백·대소문자만 다르면 하나로 접는다', async () => {
      mockDb([
        detail({ company_name: 'Kakao' }),
        detail({ company_name: '  kakao ' }),
      ]);
      const r = await service.getCardFields();

      expect(r.companyMatch.distinctNames).toBe(1);
      expect(r.companyMatch.topUnmatched[0].cards).toBe(2);
    });

    it('🔴 내부 공백이 다르면 **다른 이름**이다 — 시스템 공용 병합 키를 그대로 쓴다', async () => {
      // `normalizeCompanyName` 은 trim + lowercase 뿐이다. 여기서만 더 세게 접으면
      // 조사 캐시·지원 카드 병합과 숫자가 어긋난다. 이 spec 이 그 규칙을 못 박는다.
      mockDb([
        detail({ company_name: '서울대학교병원' }),
        detail({ company_name: '서울대학교 병원' }),
      ]);
      const r = await service.getCardFields();

      expect(r.companyMatch.distinctNames).toBe(2);
      // 둘 다 사전 밖이므로 「사전이 현실을 덮나」의 답은 접든 안 접든 같다
      expect(r.companyMatch.matchedNames).toBe(0);
    });

    it('사전 밖 이름을 많이 쓰인 순으로 돌려준다', async () => {
      mockDb([
        detail({ company_name: '동네병원' }),
        detail({ company_name: '구청' }),
        detail({ company_name: '구청' }),
      ]);
      const r = await service.getCardFields();

      expect(r.companyMatch.matchedNames).toBe(0);
      expect(r.companyMatch.topUnmatched[0]).toMatchObject({
        name: '구청',
        cards: 2,
      });
    });
  });

  describe('스텝 진행 · 상태', () => {
    it('스텝 없음 / 0번에 머묾 / 옮김 을 가른다', async () => {
      mockDb([detail()], { at_first_step: '5', moved: '3', no_steps: '2' });
      const r = await service.getCardFields();

      expect(r.stepProgress).toEqual({
        atFirstStep: 5,
        moved: 3,
        noSteps: 2,
      });
    });

    it('상태 분포를 센다', async () => {
      mockDb([
        detail({ status: 'IN_PROGRESS' }),
        detail({ status: 'IN_PROGRESS' }),
        detail({ status: 'FAILED' }),
      ]);
      const r = await service.getCardFields();

      expect(r.status).toEqual({ IN_PROGRESS: 2, FAILED: 1 });
    });
  });

  describe('관측 컬럼 — 2026-08-25 도입, 백필 없음', () => {
    it('🔴 NULL 은 recorded 에서 빠진다 — 도입 이전 카드는 "모른다" 다', async () => {
      mockDb([
        detail({ template_id: null, created_via: null }),
        detail({ template_id: 'it_dev', created_via: 'add_modal' }),
      ]);
      const r = await service.getCardFields();

      expect(r.templateId.recorded).toBe(1);
      expect(r.createdVia.recorded).toBe(1);
      expect(r.templateId.distribution.it_dev).toBe(1);
      expect(r.createdVia.distribution.add_modal).toBe(1);
    });

    it('🔴 한 번도 안 쓰인 템플릿도 0 으로 나온다 — 사라지면 "안 쓰인다"를 볼 수 없다', async () => {
      mockDb([detail({ template_id: 'general' })]);
      const r = await service.getCardFields();

      expect(r.templateId.distribution.general).toBe(1);
      expect(r.templateId.distribution.public).toBe(0);
      expect(r.templateId.distribution.internship).toBe(0);
    });

    it('createdVia 는 미리 채우지 않는다 — 경로는 앞으로 늘어난다', async () => {
      mockDb([detail({ created_via: 'add_modal' })]);
      const r = await service.getCardFields();

      expect(Object.keys(r.createdVia.distribution)).toEqual(['add_modal']);
    });
  });

  describe('응답 안전성', () => {
    it('🔴 응답 어디에도 사용자 식별자가 없다 — 내부에선 user_id 로 묶는다', async () => {
      // `analyzeJobTitleVariance` 는 `user_id` 로 그룹핑하므로 **행에는 식별자가 들어온다.**
      // 그게 응답으로 새어나가지 않는지는 눈으로 보증할 수 없다 — 형제 엔드포인트
      // (`company-research-status`) 가 같은 이유로 키 화이트리스트를 두고 있다.
      mockDb([
        detail({ user_id: 'secret-uuid-1', job_title: '백엔드' }),
        detail({ user_id: 'secret-uuid-1', job_title: '백엔드 개발자' }),
        detail({ user_id: 'secret-uuid-2', job_category: '간호사' }),
      ]);
      const r = await service.getCardFields();

      const dump = JSON.stringify(r);
      expect(dump).not.toContain('secret-uuid-1');
      expect(dump).not.toContain('secret-uuid-2');
      expect(dump).not.toContain('userId');
      expect(dump).not.toContain('user_id');
      // 원문 목록이 실제로 채워진 응답에서 검사했다는 것까지 못 박는다 —
      // 빈 응답이면 위 단언은 아무것도 지키지 못한 채 통과한다
      expect(r.jobTitleTexts.top.length).toBeGreaterThan(0);
    });

    it('🔴 최상위 키를 못 박는다 — 필드가 조용히 늘면 실패한다', async () => {
      mockDb([detail()]);
      const r = await service.getCardFields();

      expect(Object.keys(r).sort()).toEqual([
        'cards',
        'categoryVocab',
        'companyMatch',
        'createdVia',
        'excluded',
        'fields',
        'generatedAt',
        'jobTitleTexts',
        'jobTitleVariance',
        'status',
        'stepProgress',
        'templateId',
        'templateUsage',
        'users',
      ]);
    });
  });

  /**
   * 템플릿을 **그대로 썼나** — 「맞는 템플릿이면 쓴다」 가설의 직접 근거.
   *
   * ## 시나리오 (먼저 나열하고 코드를 짰다)
   *  1. 스텝이 템플릿과 정확히 같다 → kept
   *  2. 스텝을 추가했다 → 분모엔 들어가고 kept 는 아니다
   *  3. 스텝 **이름만** 한 글자 고쳤다 → kept 아니다 (느슨하게 접으면 질문이 흐려진다)
   *  4. 순서가 다르다 → kept 아니다
   *  5. `template_id` 가 NULL → 분모에서 빠진다 (도입 이전 카드는 판정 불가)
   *  6. 🔴 모르는 `template_id` → 분모에서 빠진다 (general 로 흘러 「그대로 썼다」가 되면 안 된다)
   *  7. 스텝이 아예 없는 카드(step_names=null) → 분모엔 들어가고 kept 아니다
   *  8. byTemplate 은 count DESC · 동률은 id 가나다
   *  9. 카드 0장 → 빈 집계 (크래시 없음)
   */
  describe('템플릿을 그대로 썼나', () => {
    const IT = [
      '서류 제출',
      '코딩테스트·과제',
      '1차 기술면접',
      '2차 컬처핏',
      '최종 합격',
    ];

    it('1) 스텝이 템플릿과 같다 → kept', async () => {
      mockDb([detail({ template_id: 'it_dev', step_names: IT })]);
      const r = await service.getCardFields();

      expect(r.templateUsage.withTemplate).toBe(1);
      expect(r.templateUsage.keptAsIs).toBe(1);
      expect(r.templateUsage.byTemplate).toEqual([
        { templateId: 'it_dev', count: 1, kept: 1 },
      ]);
    });

    it('2) 스텝을 추가했다 → 분모엔 들어가고 kept 아니다', async () => {
      mockDb([
        detail({ template_id: 'it_dev', step_names: [...IT, '레퍼런스 체크'] }),
      ]);
      const r = await service.getCardFields();

      expect(r.templateUsage.withTemplate).toBe(1);
      expect(r.templateUsage.keptAsIs).toBe(0);
    });

    it('3) 🔴 이름을 한 글자만 고쳐도 kept 아니다', async () => {
      const renamed = [...IT];
      renamed[2] = '1차 기술 면접'; // 공백 하나
      mockDb([detail({ template_id: 'it_dev', step_names: renamed })]);
      const r = await service.getCardFields();

      expect(r.templateUsage.withTemplate).toBe(1);
      expect(r.templateUsage.keptAsIs).toBe(0);
    });

    it('4) 순서가 다르면 kept 아니다', async () => {
      const swapped = [IT[0], IT[2], IT[1], IT[3], IT[4]];
      mockDb([detail({ template_id: 'it_dev', step_names: swapped })]);
      const r = await service.getCardFields();

      expect(r.templateUsage.keptAsIs).toBe(0);
    });

    it('5) template_id NULL → 분모에서 빠진다 (도입 이전 카드)', async () => {
      mockDb([detail({ template_id: null, step_names: IT })]);
      const r = await service.getCardFields();

      expect(r.templateUsage).toEqual({
        withTemplate: 0,
        keptAsIs: 0,
        byTemplate: [],
      });
    });

    it('6) 🔴 모르는 template_id 는 분모에서 뺀다 — general 로 흘러 kept 가 되면 없는 사실이 생긴다', async () => {
      mockDb([
        detail({
          template_id: 'legacy_gone',
          step_names: ['서류 제출', '1차 면접', '2차 면접', '최종 합격'],
        }),
      ]);
      const r = await service.getCardFields();

      expect(r.templateUsage.withTemplate).toBe(0);
      expect(r.templateUsage.keptAsIs).toBe(0);
    });

    it('7) 스텝이 없는 카드 → 분모엔 들어가고 kept 아니다', async () => {
      mockDb([detail({ template_id: 'general', step_names: null })]);
      const r = await service.getCardFields();

      expect(r.templateUsage.withTemplate).toBe(1);
      expect(r.templateUsage.keptAsIs).toBe(0);
    });

    it('8) byTemplate 은 count DESC · 동률은 id 가나다', async () => {
      const GENERAL = ['서류 제출', '1차 면접', '2차 면접', '최종 합격'];
      mockDb([
        detail({ template_id: 'general', step_names: GENERAL }),
        detail({ template_id: 'general', step_names: GENERAL }),
        detail({ template_id: 'public', step_names: [] }),
        detail({ template_id: 'it_dev', step_names: IT }),
      ]);
      const r = await service.getCardFields();

      expect(r.templateUsage.byTemplate).toEqual([
        { templateId: 'general', count: 2, kept: 2 },
        { templateId: 'it_dev', count: 1, kept: 1 },
        { templateId: 'public', count: 1, kept: 0 },
      ]);
      expect(r.templateUsage.withTemplate).toBe(4);
      expect(r.templateUsage.keptAsIs).toBe(3);
    });

    it('9) 카드 0장 → 빈 집계', async () => {
      mockDb([]);
      const r = await service.getCardFields();

      expect(r.templateUsage).toEqual({
        withTemplate: 0,
        keptAsIs: 0,
        byTemplate: [],
      });
    });

    /**
     * 🔴 제외 3종은 **SQL 이 하는 일**이라 여기선 검증되지 않는다 (파일 상단 주석 참조).
     * 대신 「제외된 행이 오면 어떻게 되나」가 아니라 **「오지 않는다」는 전제를 명시**해 둔다 —
     * 샘플·admin·삭제 카드는 detail 쿼리에 애초에 실리지 않으므로 이 집계에도 없다.
     */
    it('샘플·admin·삭제 카드는 detail 행 자체가 오지 않는다 (분모는 실사용자 카드뿐)', async () => {
      mockDb(
        [detail({ template_id: 'it_dev', step_names: IT })],
        {},
        {
          admin_cards: '9',
          sample_cards: '5',
        },
      );
      const r = await service.getCardFields();

      expect(r.excluded).toEqual({ adminCards: 9, sampleCards: 5 });
      expect(r.templateUsage.withTemplate).toBe(1);
    });
  });

  describe('캐시', () => {
    it('5분 안에는 DB 를 다시 치지 않는다', async () => {
      mockDb([detail()]);
      await service.getCardFields();
      const afterFirst = query.mock.calls.length;

      await service.getCardFields();
      expect(query.mock.calls.length).toBe(afterFirst);
    });

    it('🔴 force=true 는 캐시를 뚫는다 — 탈출구가 없으면 "안 변함"과 "안 읽음"이 같아진다', async () => {
      mockDb([detail()]);
      expect((await service.getCardFields()).cards).toBe(1);

      // DB 를 2장으로 바꾼다 (`mockDb` 가 호출 수를 0 으로 되돌린다)
      mockDb([detail(), detail()], { cards: '2' });

      // ① force 없이 → DB 를 안 치고 옛 값이 나온다
      expect((await service.getCardFields()).cards).toBe(1);
      expect(query).not.toHaveBeenCalled();

      // ② force 로 → DB 를 치고 새 값이 나온다
      expect((await service.getCardFields(true)).cards).toBe(2);
      expect(query).toHaveBeenCalled();
    });

    it('force 로 새로 읽은 값이 캐시에 반영된다 — 다음 조회가 옛 값으로 돌아가지 않는다', async () => {
      mockDb([detail()]);
      await service.getCardFields();

      mockDb([detail(), detail()], { cards: '2' });
      await service.getCardFields(true);

      const next = await service.getCardFields();
      expect(next.cards).toBe(2);
    });

    it('resetCache 후에는 다시 친다', async () => {
      mockDb([detail()]);
      await service.getCardFields();
      const afterFirst = query.mock.calls.length;

      service.resetCache();
      mockDb([detail()]);
      await service.getCardFields();
      expect(query.mock.calls.length).toBeGreaterThan(0);
      expect(afterFirst).toBeGreaterThan(0);
    });
  });
});
