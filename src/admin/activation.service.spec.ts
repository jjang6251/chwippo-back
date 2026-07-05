import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { ActivationService } from './activation.service';

/**
 * A8 ActivationService spec.
 *
 * 시나리오 매트릭스:
 * - getActivation: 코호트 row 문자열 → number 변환 + 정렬 유지
 *                  funnel = 전체 코호트 합산
 *                  빈 코호트(가입자 0) → cohorts [] + funnel 0 (NaN 방지)
 *                  5분 캐시 — 2회 호출 시 쿼리 1세트만
 * - 브리핑 상관: read/미read 그룹 행동률 % 반올림
 *               표본 0 그룹 → null (0% 와 구분)
 *               브리핑 발송 자체가 없으면 receivedUserDays 0 + 둘 다 null
 * - SQL 가드(문자열 검증): is_sample=false · deleted_at IS NULL · coverletter_draft_v2 ·
 *               d7/d30 window (+5~+9 / +25~+35)
 */
describe('ActivationService', () => {
  let service: ActivationService;
  let dataSource: jest.Mocked<DataSource>;

  const COHORT_ROW = {
    week_start: '2026-06-29',
    cohort_size: '10',
    setup: '6',
    aha_beta: '3',
    aha_ai: '0',
    d7: '4',
    d30: '1',
  };
  const BRIEFING_ROWS = [
    { read: true, total: '20', acted: '13' },
    { read: false, total: '10', acted: '2' },
  ];

  beforeEach(async () => {
    dataSource = mock<DataSource>();
    // 1번째 query = 코호트, 2번째 = 브리핑 (compute 호출 순서)
    dataSource.query
      .mockResolvedValueOnce([COHORT_ROW])
      .mockResolvedValueOnce(BRIEFING_ROWS);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivationService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(ActivationService);
  });

  it('코호트 row 숫자 변환 + funnel 합산', async () => {
    const res = await service.getActivation();

    expect(res.cohorts).toEqual([
      {
        weekStart: '2026-06-29',
        cohortSize: 10,
        setup: 6,
        ahaBeta: 3,
        ahaAi: 0,
        d7: 4,
        d30: 1,
      },
    ]);
    expect(res.funnel).toEqual({ signup: 10, setup: 6, ahaBeta: 3, d7: 4 });
  });

  it('브리핑 상관 — read 65% / 미read 20% (반올림) + 수신 유저-일 합산', async () => {
    const res = await service.getActivation();

    expect(res.briefing).toEqual({
      receivedUserDays: 30,
      actedRateRead: 65,
      actedRateUnread: 20,
    });
  });

  it('빈 코호트 + 브리핑 미발송 → 0·null (NaN 없음)', async () => {
    dataSource.query.mockReset();
    dataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const res = await service.getActivation();

    expect(res.cohorts).toEqual([]);
    expect(res.funnel).toEqual({ signup: 0, setup: 0, ahaBeta: 0, d7: 0 });
    expect(res.briefing).toEqual({
      receivedUserDays: 0,
      actedRateRead: null,
      actedRateUnread: null,
    });
  });

  it('한쪽 그룹만 표본 0 → 그 그룹만 null (0% 와 구분)', async () => {
    dataSource.query.mockReset();
    dataSource.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ read: true, total: '5', acted: '0' }]);

    const res = await service.getActivation();

    expect(res.briefing.actedRateRead).toBe(0);
    expect(res.briefing.actedRateUnread).toBeNull();
  });

  it('5분 캐시 — 연속 2회 호출 시 쿼리는 1세트(2회)만', async () => {
    await service.getActivation();
    await service.getActivation();

    expect(dataSource.query).toHaveBeenCalledTimes(2); // 코호트 1 + 브리핑 1
  });

  it('SQL 가드 — 샘플 카드 제외·soft-delete 제외·draft feature·d7/d30 window', async () => {
    await service.getActivation();

    const cohortSql = dataSource.query.mock.calls[0][0];
    expect(cohortSql).toContain('is_sample = false');
    expect(cohortSql).toContain('deleted_at IS NULL');
    // 마감일 = application_steps.scheduled_date (applications 에 deadline 컬럼 없음)
    expect(cohortSql).toContain('s.scheduled_date IS NOT NULL');
    expect(cohortSql).not.toContain('a.deadline');
    expect(cohortSql).toContain("'coverletter_draft_v2'");
    expect(cohortSql).toContain('signup_date + 5 AND cu.signup_date + 9');
    expect(cohortSql).toContain('signup_date + 25 AND cu.signup_date + 35');
    expect(cohortSql).toContain("interval '72 hours'");
  });
});
