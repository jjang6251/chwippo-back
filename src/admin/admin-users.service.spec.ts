import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AdminUsersService } from './admin-users.service';
import { AdminAuditService } from './admin-audit.service';
import { User } from '../users/user.entity';
import { Application } from '../applications/application.entity';
import { Inquiry } from '../inquiries/inquiry.entity';
import { Cert } from '../myinfo/entities/cert.entity';
import { Award } from '../myinfo/entities/award.entity';
import { LanguageCert } from '../myinfo/entities/language-cert.entity';
import { Experience } from '../myinfo/entities/experience.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { Document } from '../myinfo/entities/document.entity';
import { Education } from '../myinfo/entities/education.entity';
import { StorageUsageService } from '../myinfo/storage-usage.service';

const ADMIN_ID = 'admin-uuid';
const USER_ID = 'user-uuid';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    kakaoId: 'kakao-123',
    nickname: '테스트유저',
    email: 'test@test.com',
    refreshToken: 'refresh-token-value',
    role: 'user',
    createdAt: new Date('2026-01-01'),
    lastActiveAt: new Date('2026-05-01'),
    termsAgreedAt: new Date('2026-01-01'),
    dashboardConfig: null,
    onboardedAt: null,
    suspendedAt: null,
    aiConsentAt: null,
    aiConsentVersion: null,
    onboardedCoinAt: null,
    suspendReason: null,
    suspendExpiresAt: null,
    pendingNotification: null,
    signupJobCategories: null,
    signupOtherText: null,
    sampleCardsDismissedAt: null,
    tier: 'free',
    ...overrides,
  };
}

const mockQb = {
  select: jest.fn().mockReturnThis(),
  addSelect: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  addOrderBy: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  getManyAndCount: jest.fn(),
};

const mockEntityManager = {
  findOne: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
};

const mockUserRepo = () => ({
  createQueryBuilder: jest.fn().mockReturnValue(mockQb),
  findOne: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
});

const mockAppRepo = () => ({
  find: jest.fn(),
  count: jest.fn().mockResolvedValue(0),
});

const mockCountRepo = () => ({
  count: jest.fn().mockResolvedValue(0),
});

const mockStorageUsage = {
  getUsage: jest.fn().mockResolvedValue({
    usedBytes: 0,
    limitBytes: 100 * 1024 * 1024,
    usedMB: 0,
    limitMB: 100,
    percentage: 0,
  }),
};

const mockInquiryRepo = () => ({
  find: jest.fn(),
});

const mockAuditService = {
  log: jest.fn(),
};

const mockDataSourceManager = {
  findOne: jest.fn(),
  find: jest.fn(),
};

const mockDataSource = {
  transaction: jest
    .fn()
    .mockImplementation(
      async <T>(cb: (manager: EntityManager) => Promise<T>): Promise<T> =>
        cb(mockEntityManager as unknown as EntityManager),
    ),
  manager: mockDataSourceManager,
};

describe('AdminUsersService', () => {
  let service: AdminUsersService;
  let userRepo: jest.Mocked<Repository<User>>;

  beforeEach(async () => {
    jest.clearAllMocks();

    // 기본 qb 동작: 빈 목록 반환
    mockQb.getManyAndCount.mockResolvedValue([[], 0]);
    // dataSource.manager 기본값: myinfo 없음
    mockDataSourceManager.findOne.mockResolvedValue(null);
    mockDataSourceManager.find.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: getRepositoryToken(User), useFactory: mockUserRepo },
        { provide: getRepositoryToken(Application), useFactory: mockAppRepo },
        { provide: getRepositoryToken(Inquiry), useFactory: mockInquiryRepo },
        { provide: getRepositoryToken(Cert), useFactory: mockCountRepo },
        { provide: getRepositoryToken(Award), useFactory: mockCountRepo },
        {
          provide: getRepositoryToken(LanguageCert),
          useFactory: mockCountRepo,
        },
        { provide: getRepositoryToken(Experience), useFactory: mockCountRepo },
        {
          provide: getRepositoryToken(CoverletterCustom),
          useFactory: mockCountRepo,
        },
        { provide: getRepositoryToken(Document), useFactory: mockCountRepo },
        { provide: getRepositoryToken(Education), useFactory: mockCountRepo },
        { provide: AdminAuditService, useValue: mockAuditService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: StorageUsageService, useValue: mockStorageUsage },
      ],
    }).compile();

    service = module.get(AdminUsersService);
    userRepo = module.get(getRepositoryToken(User));
  });

  // ──────────────────────────────────────────
  // findAll
  // ──────────────────────────────────────────
  describe('findAll()', () => {
    it('정상: 기본 목록 반환 (page=1, limit=20)', async () => {
      const users = [makeUser({ id: 'a' }), makeUser({ id: 'b' })];
      mockQb.getManyAndCount.mockResolvedValue([users, 2]);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(2);
      expect(mockQb.skip).toHaveBeenCalledWith(0);
      expect(mockQb.take).toHaveBeenCalledWith(20);
    });

    it('limit > 100이면 100으로 clamp한다', async () => {
      await service.findAll({ limit: 999 });
      expect(mockQb.take).toHaveBeenCalledWith(100);
    });

    it('limit <= 100이면 그대로 사용한다', async () => {
      await service.findAll({ limit: 50 });
      expect(mockQb.take).toHaveBeenCalledWith(50);
    });

    it('page 2, limit 10이면 skip=10으로 계산한다', async () => {
      await service.findAll({ page: 2, limit: 10 });
      expect(mockQb.skip).toHaveBeenCalledWith(10);
    });

    it('page 범위 초과 시 빈 배열 반환', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[], 5]);
      const result = await service.findAll({ page: 999, limit: 20 });
      expect(result.data).toHaveLength(0);
    });

    it('검색어의 SQL 와일드카드(%, _, \\)를 이스케이프한다', async () => {
      await service.findAll({ search: '100%완료_테스트\\값' });

      const [[, params]] = mockQb.andWhere.mock.calls as [
        [string, Record<string, string>],
      ];
      // 이스케이프된 형태가 포함돼야 함
      expect(params.search).toContain('\\%완료'); // % → \%
      expect(params.search).toContain('\\_테스트'); // _ → \_
      expect(params.search).toContain('\\\\값'); // \ → \\
      // 원본 이스케이프 안 된 형태는 없어야 함 (와일드카드 앞에 \ 없는 형태)
      expect(params.search).not.toContain('100%완료'); // 원본 그대로인 부분 없음
    });

    it('검색어 없으면 andWhere를 호출하지 않는다', async () => {
      await service.findAll({});
      expect(mockQb.andWhere).not.toHaveBeenCalled();
    });

    it('lastActiveAt NULLS LAST orderBy가 포함된다', async () => {
      await service.findAll({});
      const orderCalls = mockQb.orderBy.mock.calls.concat(
        mockQb.addOrderBy.mock.calls,
      ) as [string, ...unknown[]][];
      const hasNullsLast = orderCalls.some(
        ([expr]) => typeof expr === 'string' && expr.includes('lastActiveAt'),
      );
      expect(hasNullsLast).toBe(true);
    });

    it('role 필터 지정 시 andWhere에 role 조건이 추가된다', async () => {
      await service.findAll({ role: 'admin' });
      expect(mockQb.andWhere).toHaveBeenCalledWith('u.role = :role', {
        role: 'admin',
      });
    });

    it('role 미지정 시 role andWhere 호출 안 함', async () => {
      await service.findAll({});
      const roleCalls = (
        mockQb.andWhere.mock.calls as [string, unknown?][]
      ).filter(([clause]) => clause.includes('u.role'));
      expect(roleCalls).toHaveLength(0);
    });

    it('suspended=true 시 suspendedAt IS NOT NULL 조건 추가', async () => {
      await service.findAll({ suspended: true });
      expect(mockQb.andWhere).toHaveBeenCalledWith('u.suspendedAt IS NOT NULL');
    });

    it('suspended=false 시 suspendedAt IS NULL 조건 추가', async () => {
      await service.findAll({ suspended: false });
      expect(mockQb.andWhere).toHaveBeenCalledWith('u.suspendedAt IS NULL');
    });

    it('suspended 미지정 시 suspendedAt andWhere 호출 안 함', async () => {
      await service.findAll({});
      const suspendCalls = (
        mockQb.andWhere.mock.calls as [string, unknown?][]
      ).filter(([clause]) => clause.includes('suspendedAt'));
      expect(suspendCalls).toHaveLength(0);
    });

    it('응답에 refreshToken·kakaoId가 포함되지 않는다', async () => {
      mockQb.getManyAndCount.mockResolvedValue([[makeUser()], 1]);
      const result = await service.findAll({});
      const item = result.data[0] as Record<string, unknown>;
      expect(item).not.toHaveProperty('refreshToken');
      expect(item).not.toHaveProperty('kakaoId');
    });
  });

  // ──────────────────────────────────────────
  // findOne
  // ──────────────────────────────────────────
  describe('findOne()', () => {
    it('정상: 유저 정보 반환', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());

      const result = await service.findOne(USER_ID);

      expect(result).toBeDefined();
      expect(userRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: USER_ID } }),
      );
    });

    it('없는 ID → NotFoundException', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('not-exist')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('응답에 refreshToken·kakaoId가 포함되지 않는다 (PU-S1)', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      const result = (await service.findOne(USER_ID)) as Record<
        string,
        unknown
      >;
      expect(result).not.toHaveProperty('refreshToken');
      expect(result).not.toHaveProperty('kakaoId');
    });

    it('stats 필드 포함 — storage·applicationCount·myinfoCount (PU-1)', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      const result = (await service.findOne(USER_ID)) as Record<
        string,
        unknown
      >;
      expect(result.stats).toEqual(
        expect.objectContaining({
          storage: expect.objectContaining({
            usedBytes: expect.any(Number),
            limitBytes: expect.any(Number),
            percentage: expect.any(Number),
          }),
          applicationCount: expect.any(Number),
          myinfoCount: expect.objectContaining({
            cert: expect.any(Number),
            award: expect.any(Number),
            languageCert: expect.any(Number),
            experience: expect.any(Number),
            coverletterCustom: expect.any(Number),
            document: expect.any(Number),
            education: expect.any(Number),
          }),
        }),
      );
    });

    it('storageUsage.getUsage가 user id로 호출됨 (PU-1)', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      await service.findOne(USER_ID);
      expect(mockStorageUsage.getUsage).toHaveBeenCalledWith(USER_ID);
    });
  });

  // ──────────────────────────────────────────
  // updateUser
  // ──────────────────────────────────────────
  describe('updateUser()', () => {
    describe('정지 (suspend)', () => {
      it('정상: suspendedAt 설정 + audit_log suspend 기록', async () => {
        mockEntityManager.findOne.mockResolvedValue(
          makeUser({ suspendedAt: null }),
        );
        mockEntityManager.save.mockResolvedValue(
          makeUser({ suspendedAt: new Date() }),
        );
        mockAuditService.log.mockResolvedValue(undefined);

        await service.updateUser(ADMIN_ID, USER_ID, { suspended: true });

        expect(mockEntityManager.save).toHaveBeenCalledWith(
          User,
          expect.objectContaining({ suspendedAt: expect.any(Date) }),
        );
        expect(mockAuditService.log).toHaveBeenCalledWith(
          ADMIN_ID,
          'suspend',
          'user',
          USER_ID,
          expect.anything(),
          expect.anything(),
        );
      });

      it('이미 정지 상태 → idempotent (suspendedAt 갱신 안 함)', async () => {
        const alreadySuspended = makeUser({
          suspendedAt: new Date('2026-01-01'),
        });
        mockEntityManager.findOne.mockResolvedValue(alreadySuspended);

        await service.updateUser(ADMIN_ID, USER_ID, { suspended: true });

        expect(mockEntityManager.save).not.toHaveBeenCalled();
        expect(mockAuditService.log).not.toHaveBeenCalled();
      });
    });

    describe('정지 해제 (unsuspend)', () => {
      it('정상: suspendedAt null 설정 + audit_log unsuspend 기록', async () => {
        mockEntityManager.findOne.mockResolvedValue(
          makeUser({ suspendedAt: new Date() }),
        );
        mockEntityManager.save.mockResolvedValue(
          makeUser({ suspendedAt: null }),
        );
        mockAuditService.log.mockResolvedValue(undefined);

        await service.updateUser(ADMIN_ID, USER_ID, { suspended: false });

        expect(mockEntityManager.save).toHaveBeenCalledWith(
          User,
          expect.objectContaining({ suspendedAt: null }),
        );
        expect(mockAuditService.log).toHaveBeenCalledWith(
          ADMIN_ID,
          'unsuspend',
          'user',
          USER_ID,
          expect.anything(),
          expect.anything(),
        );
      });

      it('이미 활성 상태 → idempotent (저장 안 함)', async () => {
        mockEntityManager.findOne.mockResolvedValue(
          makeUser({ suspendedAt: null }),
        );

        await service.updateUser(ADMIN_ID, USER_ID, { suspended: false });

        expect(mockEntityManager.save).not.toHaveBeenCalled();
      });
    });

    describe('권한 변경 (role)', () => {
      it('user → admin 승격: audit_log grant_admin + before·after detail', async () => {
        mockEntityManager.findOne.mockResolvedValue(makeUser({ role: 'user' }));
        mockEntityManager.save.mockResolvedValue(makeUser({ role: 'admin' }));
        mockAuditService.log.mockResolvedValue(undefined);

        await service.updateUser(ADMIN_ID, USER_ID, { role: 'admin' });

        expect(mockAuditService.log).toHaveBeenCalledWith(
          ADMIN_ID,
          'grant_admin',
          'user',
          USER_ID,
          { before: 'user', after: 'admin' },
          expect.anything(),
        );
      });

      it('admin → user 강등: audit_log revoke_admin + before·after detail', async () => {
        mockEntityManager.findOne.mockResolvedValue(
          makeUser({ role: 'admin' }),
        );
        mockEntityManager.save.mockResolvedValue(makeUser({ role: 'user' }));
        mockAuditService.log.mockResolvedValue(undefined);

        await service.updateUser(ADMIN_ID, USER_ID, { role: 'user' });

        expect(mockAuditService.log).toHaveBeenCalledWith(
          ADMIN_ID,
          'revoke_admin',
          'user',
          USER_ID,
          { before: 'admin', after: 'user' },
          expect.anything(),
        );
      });

      it('이미 같은 role이면 audit_log 기록 안 함', async () => {
        mockEntityManager.findOne.mockResolvedValue(makeUser({ role: 'user' }));

        await service.updateUser(ADMIN_ID, USER_ID, { role: 'user' });

        expect(mockAuditService.log).not.toHaveBeenCalled();
      });
    });

    describe('닉네임 변경 (rename)', () => {
      it('정상: audit_log rename + before·after detail', async () => {
        mockEntityManager.findOne.mockResolvedValue(
          makeUser({ nickname: '홍길동' }),
        );
        mockEntityManager.save.mockResolvedValue(
          makeUser({ nickname: '익명1234' }),
        );
        mockAuditService.log.mockResolvedValue(undefined);

        await service.updateUser(ADMIN_ID, USER_ID, { nickname: '익명1234' });

        expect(mockAuditService.log).toHaveBeenCalledWith(
          ADMIN_ID,
          'rename',
          'user',
          USER_ID,
          { before: '홍길동', after: '익명1234' },
          expect.anything(),
        );
      });

      it('공백만인 nickname → BadRequestException', async () => {
        mockEntityManager.findOne.mockResolvedValue(makeUser());

        await expect(
          service.updateUser(ADMIN_ID, USER_ID, { nickname: '   ' }),
        ).rejects.toThrow(BadRequestException);
      });

      it('100자 초과 nickname → BadRequestException', async () => {
        mockEntityManager.findOne.mockResolvedValue(makeUser());

        await expect(
          service.updateUser(ADMIN_ID, USER_ID, { nickname: 'a'.repeat(101) }),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('tier 변경 (PR_B2 Phase 0 — CoinTier 통일 후)', () => {
      it('free → lite 변경: audit update_tier + before·after detail', async () => {
        mockEntityManager.findOne.mockResolvedValue(makeUser({ tier: 'free' }));
        mockEntityManager.save.mockResolvedValue(makeUser({ tier: 'lite' }));
        mockAuditService.log.mockResolvedValue(undefined);

        await service.updateUser(ADMIN_ID, USER_ID, { tier: 'lite' });

        expect(mockAuditService.log).toHaveBeenCalledWith(
          ADMIN_ID,
          'update_tier',
          'user',
          USER_ID,
          { before: 'free', after: 'lite' },
          expect.anything(),
        );
      });

      it('같은 tier 재지정 (free → free) → audit 미발생', async () => {
        mockEntityManager.findOne.mockResolvedValue(makeUser({ tier: 'free' }));
        mockAuditService.log.mockResolvedValue(undefined);

        await service.updateUser(ADMIN_ID, USER_ID, { tier: 'free' });

        expect(mockAuditService.log).not.toHaveBeenCalledWith(
          expect.anything(),
          'update_tier',
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.anything(),
        );
      });

      it('lite → standard 변경: audit', async () => {
        mockEntityManager.findOne.mockResolvedValue(makeUser({ tier: 'lite' }));
        mockEntityManager.save.mockResolvedValue(
          makeUser({ tier: 'standard' }),
        );
        mockAuditService.log.mockResolvedValue(undefined);

        await service.updateUser(ADMIN_ID, USER_ID, { tier: 'standard' });

        expect(mockAuditService.log).toHaveBeenCalledWith(
          ADMIN_ID,
          'update_tier',
          'user',
          USER_ID,
          { before: 'lite', after: 'standard' },
          expect.anything(),
        );
      });
    });

    describe('셀프 보호', () => {
      it('자기 자신 정지 시도 → ForbiddenException', async () => {
        await expect(
          service.updateUser(ADMIN_ID, ADMIN_ID, { suspended: true }),
        ).rejects.toThrow(ForbiddenException);
      });

      it('자기 자신 권한 변경 시도 → ForbiddenException', async () => {
        await expect(
          service.updateUser(ADMIN_ID, ADMIN_ID, { role: 'user' }),
        ).rejects.toThrow(ForbiddenException);
      });

      it('자기 자신 닉네임 변경은 허용된다 (셀프 rename은 차단 아님)', async () => {
        mockEntityManager.findOne.mockResolvedValue(
          makeUser({ id: ADMIN_ID, nickname: '기존' }),
        );
        mockEntityManager.save.mockResolvedValue(
          makeUser({ id: ADMIN_ID, nickname: '새닉네임' }),
        );
        mockAuditService.log.mockResolvedValue(undefined);

        await expect(
          service.updateUser(ADMIN_ID, ADMIN_ID, { nickname: '새닉네임' }),
        ).resolves.not.toThrow();
      });
    });

    it('없는 userId → NotFoundException', async () => {
      mockEntityManager.findOne.mockResolvedValue(null);
      await expect(
        service.updateUser(ADMIN_ID, 'not-exist', { suspended: true }),
      ).rejects.toThrow(NotFoundException);
    });

    it('audit_log insert 실패 시 에러 전파 (트랜잭션 rollback)', async () => {
      mockEntityManager.findOne.mockResolvedValue(
        makeUser({ suspendedAt: null }),
      );
      mockEntityManager.save.mockResolvedValue(
        makeUser({ suspendedAt: new Date() }),
      );
      mockAuditService.log.mockRejectedValue(new Error('DB error'));

      await expect(
        service.updateUser(ADMIN_ID, USER_ID, { suspended: true }),
      ).rejects.toThrow('DB error');
    });
  });

  // ──────────────────────────────────────────
  // deleteUser
  // ──────────────────────────────────────────
  describe('deleteUser()', () => {
    it('정상: 유저 삭제 + audit_log delete 기록', async () => {
      mockEntityManager.findOne.mockResolvedValue(makeUser());
      mockEntityManager.remove.mockResolvedValue(makeUser());
      mockAuditService.log.mockResolvedValue(undefined);

      await service.deleteUser(ADMIN_ID, USER_ID);

      expect(mockEntityManager.remove).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ id: USER_ID }),
      );
      expect(mockAuditService.log).toHaveBeenCalledWith(
        ADMIN_ID,
        'delete',
        'user',
        USER_ID,
        expect.anything(),
        expect.anything(),
      );
    });

    it('자기 자신 삭제 시도 → ForbiddenException', async () => {
      await expect(service.deleteUser(ADMIN_ID, ADMIN_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('없는 userId → NotFoundException', async () => {
      mockEntityManager.findOne.mockResolvedValue(null);
      await expect(service.deleteUser(ADMIN_ID, 'not-exist')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('audit_log insert 실패 시 에러 전파 (트랜잭션 rollback)', async () => {
      mockEntityManager.findOne.mockResolvedValue(makeUser());
      mockEntityManager.remove.mockResolvedValue(makeUser());
      mockAuditService.log.mockRejectedValue(new Error('DB error'));

      await expect(service.deleteUser(ADMIN_ID, USER_ID)).rejects.toThrow(
        'DB error',
      );
    });
  });

  // ──────────────────────────────────────────
  // warnUser
  // ──────────────────────────────────────────
  describe('warnUser()', () => {
    it('정상: audit_log warn + message detail 기록', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      mockAuditService.log.mockResolvedValue(undefined);

      await service.warnUser(ADMIN_ID, USER_ID, '부적절한 닉네임 사용');

      expect(mockAuditService.log).toHaveBeenCalledWith(
        ADMIN_ID,
        'warn',
        'user',
        USER_ID,
        { message: '부적절한 닉네임 사용' },
      );
    });

    it('없는 userId → NotFoundException', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(
        service.warnUser(ADMIN_ID, 'not-exist', '경고'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ──────────────────────────────────────────
  // exportUser
  // ──────────────────────────────────────────
  describe('exportUser()', () => {
    let appRepo: jest.Mocked<{ find: jest.Mock }>;
    let inquiryRepo: jest.Mocked<{ find: jest.Mock }>;

    beforeEach(() => {
      appRepo = (service as unknown as { appRepo: typeof appRepo }).appRepo;
      inquiryRepo = (service as unknown as { inquiryRepo: typeof inquiryRepo })
        .inquiryRepo;
      appRepo.find.mockResolvedValue([]);
      inquiryRepo.find.mockResolvedValue([]);
    });

    it('정상: 데이터 반환 + audit_log export 기록', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await service.exportUser(ADMIN_ID, USER_ID);

      expect(result).toBeDefined();
      expect(mockAuditService.log).toHaveBeenCalledWith(
        ADMIN_ID,
        'export',
        'user',
        USER_ID,
        expect.anything(),
      );
    });

    it('없는 userId → NotFoundException', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.exportUser(ADMIN_ID, 'not-exist')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('export 결과에 refreshToken이 포함되지 않는다', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ refreshToken: 'secret-refresh' }),
      );
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await service.exportUser(ADMIN_ID, USER_ID);
      const user = (result as Record<string, Record<string, unknown>>).user;

      expect(user).not.toHaveProperty('refreshToken');
    });

    it('export 결과에 kakaoId가 포함되지 않는다', async () => {
      userRepo.findOne.mockResolvedValue(
        makeUser({ kakaoId: 'kakao-secret-123' }),
      );
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await service.exportUser(ADMIN_ID, USER_ID);
      const user = (result as Record<string, Record<string, unknown>>).user;

      expect(user).not.toHaveProperty('kakaoId');
    });

    it('export 결과에 myinfo 키가 포함된다', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await service.exportUser(ADMIN_ID, USER_ID);

      expect(result).toHaveProperty('myinfo');
      expect(result.myinfo).toMatchObject({
        profile: null,
        educations: [],
        experiences: [],
        certs: [],
        languageCerts: [],
        awards: [],
        documents: [],
        coverletters: [],
      });
    });

    it('myinfo 데이터가 있으면 결과에 포함된다', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      mockAuditService.log.mockResolvedValue(undefined);
      mockDataSourceManager.findOne.mockResolvedValue({
        user_id: USER_ID,
        name: '홍길동',
      });
      mockDataSourceManager.find
        .mockResolvedValueOnce([{ id: 'edu-1', school_name: '서울대학교' }]) // educations
        .mockResolvedValueOnce([{ id: 'exp-1', activity_name: '동아리' }]) // experiences
        .mockResolvedValue([]); // 나머지

      const result = (await service.exportUser(ADMIN_ID, USER_ID)) as Record<
        string,
        Record<string, unknown>
      >;

      expect(result.myinfo.profile).toMatchObject({ name: '홍길동' });
      expect((result.myinfo.educations as unknown[]).length).toBe(1);
      expect((result.myinfo.experiences as unknown[]).length).toBe(1);
    });

    it('applications, inquiries도 결과에 포함된다', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      mockAuditService.log.mockResolvedValue(undefined);
      appRepo.find.mockResolvedValue([
        { id: 'app-1', companyName: '카카오' },
      ] as never);
      inquiryRepo.find.mockResolvedValue([
        { id: 'inq-1', title: '문의입니다' },
      ] as never);

      const result = (await service.exportUser(ADMIN_ID, USER_ID)) as Record<
        string,
        unknown[]
      >;

      expect(result.applications).toHaveLength(1);
      expect(result.inquiries).toHaveLength(1);
    });
  });
});
