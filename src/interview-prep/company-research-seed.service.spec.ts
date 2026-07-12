import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import {
  CompanyResearchSeedService,
  ResearchSeedDoc,
} from './company-research-seed.service';
import { CompanyResearchCache } from './entities/company-research-cache.entity';

/**
 * pre-seed 부팅 자동 적재 spec — 시나리오 먼저 (memory feedback_test_principle):
 * 1. BACKUP_R2_BUCKET 미설정 → S3 호출 없이 skip
 * 2. S3 fetch 실패 → warn 만, throw 안 함 (부팅 차단 금지)
 * 3. 신규 회사 → insert (jobCategory NULL · seedVersion · expiresAt ≈ +ttlDays)
 * 4. 유저 조사 행 (seedVersion NULL) → 덮지 않음
 * 5. opt-out 행 → 덮지 않음 (seed 파일에 남아 있어도 부활 금지)
 * 6. 구버전 seed 행 → 새 버전으로 update
 * 7. aliases → 이름별 복제 row (본 행 isAlias false · 별칭 행 isAlias true)
 * 8. 동일 버전 전부 적재됨 → 조기 skip (upsert 미실행)
 * 9. ttlDays 비정상(0) → 기본 180일
 * 10. 재적재(update) 시 기존 행에도 isAlias 플래그 갱신
 */

function makeDoc(overrides: Partial<ResearchSeedDoc> = {}): ResearchSeedDoc {
  return {
    version: '2026-07',
    ttlDays: 180,
    companies: [
      {
        companyName: '크래프톤',
        research: { businessSummary: '글로벌 게임사' },
        sources: [{ url: 'https://krafton.com/news' }],
      },
    ],
    ...overrides,
  };
}

describe('CompanyResearchSeedService', () => {
  let repo: jest.Mocked<Repository<CompanyResearchCache>>;

  async function build(bucket: string) {
    repo = mock<Repository<CompanyResearchCache>>();
    repo.create.mockImplementation((v) => v as CompanyResearchCache);
    repo.save.mockImplementation((v) =>
      Promise.resolve(v as CompanyResearchCache),
    );
    repo.count.mockResolvedValue(0);
    repo.findOne.mockResolvedValue(null);
    const module = await Test.createTestingModule({
      providers: [
        CompanyResearchSeedService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def?: string) =>
              key === 'BACKUP_R2_BUCKET' ? bucket : (def ?? ''),
          },
        },
        { provide: getRepositoryToken(CompanyResearchCache), useValue: repo },
      ],
    }).compile();
    return module.get(CompanyResearchSeedService);
  }

  it('1) bucket 미설정 → S3 fetch 없이 skip', async () => {
    const service = await build('');
    const sendSpy = jest.fn();
    (service as unknown as { s3: { send: jest.Mock } }).s3.send = sendSpy;
    await service.onApplicationBootstrap();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('2) S3 fetch 실패 → throw 안 함 (부팅 계속)', async () => {
    const service = await build('backup-bucket');
    (service as unknown as { s3: { send: jest.Mock } }).s3.send = jest
      .fn()
      .mockRejectedValue(new Error('network'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('3) 신규 회사 → insert (generic NULL · seedVersion · +ttlDays)', async () => {
    const service = await build('backup-bucket');
    const before = Date.now();
    const r = await service.applySeed(makeDoc());
    expect(r.inserted).toBe(1);
    const saved = repo.save.mock.calls[0][0] as CompanyResearchCache;
    expect(saved.companyName).toBe('크래프톤'); // normalize (한글은 lowercase 무영향)
    expect(saved.jobCategory).toBeNull();
    expect(saved.seedVersion).toBe('2026-07');
    expect(saved.isAlias).toBe(false); // 본 행 → 별칭 아님
    expect(saved.sources).toEqual(['https://krafton.com/news']);
    const ttlMs = saved.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(179 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(181 * 24 * 60 * 60 * 1000);
  });

  it('4) 유저 조사 행 (seedVersion NULL) → skip + 조회는 IsNull 연산자 사용', async () => {
    const service = await build('backup-bucket');
    repo.findOne.mockResolvedValue({
      id: 'row-user',
      seedVersion: null,
      optOut: false,
    } as CompanyResearchCache);
    const r = await service.applySeed(makeDoc());
    expect(r.skippedUser).toBe(1);
    expect(repo.save).not.toHaveBeenCalled();
    // 회귀 방지 — TypeORM 은 where 의 raw null 을 조용히 무시 (직군 행 오인 버그).
    // jobCategory 조건이 반드시 FindOperator(IsNull) 여야 한다.
    const where = repo.findOne.mock.calls[0][0].where as {
      jobCategory: unknown;
    };
    expect(where.jobCategory).toBeInstanceOf(FindOperator);
  });

  it('5) opt-out 행 → skip (부활 금지)', async () => {
    const service = await build('backup-bucket');
    repo.findOne.mockResolvedValue({
      id: 'row-optout',
      seedVersion: '2026-01',
      optOut: true,
    } as CompanyResearchCache);
    const r = await service.applySeed(makeDoc());
    expect(r.skippedOptOut).toBe(1);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('6) 구버전 seed 행 → update', async () => {
    const service = await build('backup-bucket');
    repo.findOne.mockResolvedValue({
      id: 'row-old',
      seedVersion: '2026-01',
      optOut: false,
    } as CompanyResearchCache);
    const r = await service.applySeed(makeDoc());
    expect(r.updated).toBe(1);
    const saved = repo.save.mock.calls[0][0] as CompanyResearchCache;
    expect(saved.seedVersion).toBe('2026-07');
  });

  it('7) aliases → 이름별 복제 row (본 행 isAlias false · 별칭 행 isAlias true)', async () => {
    const service = await build('backup-bucket');
    const doc = makeDoc({
      companies: [
        {
          companyName: '토스',
          aliases: ['비바리퍼블리카'],
          research: { businessSummary: '금융 슈퍼앱' },
        },
      ],
    });
    const r = await service.applySeed(doc);
    expect(r.inserted).toBe(2);
    const saved = repo.save.mock.calls.map((c) => c[0] as CompanyResearchCache);
    expect(saved.map((s) => s.companyName)).toEqual(['토스', '비바리퍼블리카']);
    // 본 행 = 별칭 아님, aliases 로 만들어진 복제 행 = 별칭.
    expect(saved.map((s) => s.isAlias)).toEqual([false, true]);
  });

  it('8) 동일 버전 전부 적재됨 → 조기 skip', async () => {
    const service = await build('backup-bucket');
    repo.count.mockResolvedValue(1); // names.length = 1
    const r = await service.applySeed(makeDoc());
    expect(r.inserted).toBe(0);
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('9) ttlDays 0 → 기본 180일', async () => {
    const service = await build('backup-bucket');
    const before = Date.now();
    await service.applySeed(makeDoc({ ttlDays: 0 }));
    const saved = repo.save.mock.calls[0][0] as CompanyResearchCache;
    const ttlMs = saved.expiresAt.getTime() - before;
    expect(ttlMs).toBeGreaterThan(179 * 24 * 60 * 60 * 1000);
  });

  it('10) 재적재(update) 시 기존 행에도 isAlias 갱신 — 별칭이면 true 소급', async () => {
    const service = await build('backup-bucket');
    // 별칭 이름으로 이미 존재하지만 플래그 미마킹(isAlias false)된 구버전 행.
    // 호출마다 새 객체를 반환 — 같은 참조를 두 번 저장하면 플래그가 덮여 검증 불가.
    repo.findOne.mockImplementation(() =>
      Promise.resolve({
        id: 'row-alias-old',
        seedVersion: '2026-01',
        optOut: false,
        isAlias: false,
      } as CompanyResearchCache),
    );
    const doc = makeDoc({
      companies: [
        {
          companyName: '토스',
          aliases: ['비바리퍼블리카'],
          research: { businessSummary: '금융 슈퍼앱' },
        },
      ],
    });
    const r = await service.applySeed(doc);
    expect(r.updated).toBe(2);
    // 본 행 → false, 별칭 행 → true 로 갱신됐는지.
    const saved = repo.save.mock.calls.map((c) => c[0] as CompanyResearchCache);
    expect(saved.map((s) => s.isAlias)).toEqual([false, true]);
  });
});
