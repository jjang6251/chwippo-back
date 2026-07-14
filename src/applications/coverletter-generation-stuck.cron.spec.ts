import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { CoverletterGenerationStuckCron } from './coverletter-generation-stuck.cron';

/**
 * PR_B1c Phase C — stuck timeout cron spec.
 *
 * **검증 매트릭스**:
 * 1. started_at < NOW - 30min → 'failed' 처리
 * 2. started_at NULL (defensive) → 'failed' 처리
 * 3. status != 'in_progress' → no-op
 * 4. RETURNING id 의 row 개수 logger.log 표시
 * 5. UPDATE 실패 (DB error) → logger.error + throw 안 함
 */

describe('CoverletterGenerationStuckCron', () => {
  let cron: CoverletterGenerationStuckCron;
  let dataSource: jest.Mocked<Pick<DataSource, 'query'>>;

  beforeEach(async () => {
    dataSource = { query: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoverletterGenerationStuckCron,

        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    cron = module.get<CoverletterGenerationStuckCron>(
      CoverletterGenerationStuckCron,
    );
  });

  it('SC1) stuck row 3건 → UPDATE 호출 + logger 호출', async () => {
    // UPDATE...RETURNING 실제 형태 = [rows[], affected] 튜플 (returningRows 회귀 방어)
    dataSource.query.mockResolvedValueOnce([
      [{ id: 'app-1' }, { id: 'app-2' }, { id: 'app-3' }],
      3,
    ]);
    const logSpy = jest.spyOn(cron['logger'], 'log');

    await cron.runStuckTimeout();

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining("coverletter_generation_status = 'in_progress'"),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('3건'));
  });

  it('SC2) UPDATE WHERE 절에 started_at < NOW - 30min 포함', async () => {
    dataSource.query.mockResolvedValueOnce([]);

    await cron.runStuckTimeout();

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining("INTERVAL '30 minutes'"),
    );
  });

  it('SC3) WHERE 절에 started_at IS NULL defensive 분기 포함 (좀비 row)', async () => {
    dataSource.query.mockResolvedValueOnce([]);

    await cron.runStuckTimeout();

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('IS NULL'),
    );
  });

  it("SC4) UPDATE SET status='failed' 포함", async () => {
    dataSource.query.mockResolvedValueOnce([]);

    await cron.runStuckTimeout();

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining("SET coverletter_generation_status = 'failed'"),
    );
  });

  it('SC5) 0건 처리 → logger.log 호출 X (불필요한 noise 방지)', async () => {
    dataSource.query.mockResolvedValueOnce([]);
    const logSpy = jest.spyOn(cron['logger'], 'log');

    await cron.runStuckTimeout();

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('SC6) DB 에러 → logger.error 호출 + throw 안 함 (다음 5분 자연 retry)', async () => {
    dataSource.query.mockRejectedValueOnce(new Error('connection lost'));
    const errSpy = jest.spyOn(cron['logger'], 'error');

    await expect(cron.runStuckTimeout()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('connection lost'),
    );
  });

  it('SC7) RETURNING 결과 비배열 (예: undefined) → defensive 0건 처리', async () => {
    dataSource.query.mockResolvedValueOnce(undefined);
    const logSpy = jest.spyOn(cron['logger'], 'log');

    // 빈 array 받지 못해 length 접근 시 throw 가능 — 우리 코드는 .length 만 봄
    await expect(cron.runStuckTimeout()).resolves.toBeUndefined();
    // logger.log 호출 X (length 가 0 아니면 undefined — 접근 시 TypeError)
    expect(logSpy).not.toHaveBeenCalled();
  });
});
