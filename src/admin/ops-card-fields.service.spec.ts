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
        'jobTitleVariance',
        'status',
        'stepProgress',
        'templateId',
        'users',
      ]);
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
