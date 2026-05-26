import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { InsightsService } from './insights.service';

/**
 * F6 PR 1 Phase 3c — InsightsService spec.
 *
 * 시나리오:
 * - getInsights 빈 데이터 → 빈 응답 + cached=false
 * - getInsights 두 번째 호출 (TTL 안) → cached=true (캐시 hit)
 * - invalidate → 다음 호출 cached=false
 * - strengths.byCl/byComps 카운트 변환 정확 (string → number)
 * - sources LIMIT N 적용 + 정렬
 * - heatmap/trend SQL 호출 파라미터 (userId + days/months)
 * - cross-user 격리: userId 다른 사람 호출 시 별도 캐시
 */

describe('InsightsService', () => {
  let service: InsightsService;
  let dataSource: { query: jest.Mock };

  const USER_ID = 'user-1';

  beforeEach(async () => {
    dataSource = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InsightsService,
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();
    service = module.get<InsightsService>(InsightsService);
  });

  // ── 캐시 ──

  it('첫 호출 → cached=false + DB 쿼리 4회 (strengths 2 + sources 1 + heatmap 1 + trend 1 = 5)', async () => {
    dataSource.query.mockResolvedValue([]);
    const r = await service.getInsights(USER_ID);
    expect(r.cached).toBe(false);
    // strengths(byCl) + strengths(byComps) + sources + heatmap + trend = 5
    expect(dataSource.query).toHaveBeenCalledTimes(5);
  });

  it('두 번째 호출 (TTL 안) → cached=true + DB 쿼리 추가 0', async () => {
    dataSource.query.mockResolvedValue([]);
    await service.getInsights(USER_ID);
    dataSource.query.mockClear();
    const r2 = await service.getInsights(USER_ID);
    expect(r2.cached).toBe(true);
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('invalidate(userId) → 다음 호출 cached=false + DB 쿼리 재실행', async () => {
    dataSource.query.mockResolvedValue([]);
    await service.getInsights(USER_ID);
    service.invalidate(USER_ID);
    dataSource.query.mockClear();
    const r = await service.getInsights(USER_ID);
    expect(r.cached).toBe(false);
    expect(dataSource.query).toHaveBeenCalledTimes(5);
  });

  it('cross-user 격리 — 다른 userId 호출 시 별도 cache key + DB 쿼리 새로', async () => {
    dataSource.query.mockResolvedValue([]);
    await service.getInsights(USER_ID);
    dataSource.query.mockClear();
    const r = await service.getInsights('user-other');
    expect(r.cached).toBe(false);
    expect(dataSource.query).toHaveBeenCalledTimes(5);
    // SQL 호출에 user-other 가 param 으로 전달됐는지
    const calls = dataSource.query.mock.calls;
    expect(calls.every((c) => (c[1] as unknown[]).includes('user-other'))).toBe(
      true,
    );
  });

  // ── 데이터 매핑 ──

  it('strengths.byCl + byComps — DB 결과 (count: string) 를 number 로 변환', async () => {
    // Promise.all 내부 task 들이 동시 시작 → mockResolvedValueOnce 순서 보장 못 함.
    // SQL 패턴 매칭으로 분기 (각 쿼리 식별)
    dataSource.query.mockImplementation(async (sql: string) => {
      if (sql.includes('jsonb_array_elements_text(cl)'))
        return [
          { key: 'job_competency', count: '5' },
          { key: 'collaboration', count: '3' },
        ];
      if (sql.includes('jsonb_array_elements_text(comps)'))
        return [
          { key: 'technical', count: '8' },
          { key: 'leadership', count: '4' },
        ];
      return [];
    });
    const r = await service.getInsights(USER_ID);
    expect(r.strengths.byCl).toEqual([
      { key: 'job_competency', count: 5 },
      { key: 'collaboration', count: 3 },
    ]);
    expect(r.strengths.byComps).toEqual([
      { key: 'technical', count: 8 },
      { key: 'leadership', count: 4 },
    ]);
  });

  it('sources — Date occurred_at 을 YYYY-MM-DD 로 변환 + referencedByCount 숫자', async () => {
    dataSource.query.mockImplementation(async (sql: string) => {
      if (sql.includes('coverletter_source_refs'))
        return [
          {
            log_id: 'log-A',
            content: '백엔드 인턴 PR 머지',
            occurred_at: new Date('2026-05-01'),
            ref_count: '3',
          },
        ];
      return [];
    });
    const r = await service.getInsights(USER_ID);
    expect(r.sources).toEqual([
      {
        logId: 'log-A',
        content: '백엔드 인턴 PR 머지',
        occurredAt: '2026-05-01',
        referencedByCount: 3,
      },
    ]);
  });

  it('sources SQL — LIMIT 10 + user_id 파라미터 전달', async () => {
    dataSource.query.mockResolvedValue([]);
    await service.getInsights(USER_ID);
    const sourcesCall = dataSource.query.mock.calls.find((c) =>
      String(c[0]).includes('coverletter_source_refs'),
    );
    expect(sourcesCall).toBeDefined();
    expect(sourcesCall![1]).toEqual([USER_ID, 10]);
  });

  it('heatmap SQL — 365일 + user_id 파라미터 + archived_at IS NULL 포함', async () => {
    dataSource.query.mockResolvedValue([]);
    await service.getInsights(USER_ID);
    const heatmapCall = dataSource.query.mock.calls.find((c) =>
      String(c[0]).includes('occurred_at::text'),
    );
    expect(heatmapCall).toBeDefined();
    expect(heatmapCall![1]).toEqual([USER_ID, 365]);
    expect(String(heatmapCall![0])).toContain('archived_at IS NULL');
  });

  it('trend SQL — 12개월 + user_id 파라미터', async () => {
    dataSource.query.mockResolvedValue([]);
    await service.getInsights(USER_ID);
    const trendCall = dataSource.query.mock.calls.find((c) =>
      String(c[0]).includes("date_trunc('month'"),
    );
    expect(trendCall).toBeDefined();
    expect(trendCall![1]).toEqual([USER_ID, 12]);
  });

  // ── 보안 ──

  it('모든 SQL 에 user_id WHERE 절 + archived_at IS NULL 포함 (cross-user 격리 + 보관 활동 제외)', async () => {
    dataSource.query.mockResolvedValue([]);
    await service.getInsights(USER_ID);
    for (const call of dataSource.query.mock.calls) {
      const sql = String(call[0]);
      expect(sql).toMatch(/user_id\s*=\s*\$1/);
      expect(sql).toContain('archived_at IS NULL');
    }
  });

  // ── edge ──

  it('빈 결과 — 모든 항목이 빈 배열로 반환', async () => {
    dataSource.query.mockResolvedValue([]);
    const r = await service.getInsights(USER_ID);
    expect(r.strengths.byCl).toEqual([]);
    expect(r.strengths.byComps).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.heatmap).toEqual([]);
    expect(r.trend).toEqual([]);
    expect(r.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
