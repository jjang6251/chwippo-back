import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { FilesService } from '../files/files.service';

describe('UsersService', () => {
  let service: UsersService;
  let userRepo: jest.Mocked<Repository<User>>;
  let storageUsage: jest.Mocked<StorageUsageService>;
  let filesService: jest.Mocked<FilesService>;

  const makeUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-uuid-1',
      kakaoId: 'kakao-123',
      nickname: '테스트유저',
      email: null,
      role: 'user',
      refreshToken: null,
      lastActiveAt: null,
      createdAt: new Date(),
      ...overrides,
    }) as User;

  beforeEach(async () => {
    const mockRepo = mock<Repository<User>>();
    const mockStorage = mock<StorageUsageService>();
    const mockFiles = mock<FilesService>();
    mockStorage.collectAllFileUrls.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
        { provide: StorageUsageService, useValue: mockStorage },
        { provide: FilesService, useValue: mockFiles },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    userRepo = module.get(getRepositoryToken(User));
    storageUsage = module.get(StorageUsageService);
    filesService = module.get(FilesService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── agreeTerms (LRR P2T1 PR N H-3) ────────────────────
  describe('agreeTerms', () => {
    it('정상: repo.update로 termsAgreedAt 갱신', async () => {
      userRepo.update.mockResolvedValue({} as any);
      await service.agreeTerms('user-uuid-1');
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({ termsAgreedAt: expect.any(Date) }),
      );
    });

    it('이미 동의한 user (idempotent) → 정상 호출 (timestamp 새 값으로 갱신)', async () => {
      userRepo.update.mockResolvedValue({} as any);
      await service.agreeTerms('user-uuid-1');
      // NotFound 검증 없음 — 단순 update. affected row 0이어도 throw 안 함
      expect(userRepo.update).toHaveBeenCalledTimes(1);
    });

    it('존재하지 않는 userId → throw 없이 update 호출 (affected 0, race 시점 약점)', async () => {
      userRepo.update.mockResolvedValue({ affected: 0 } as any);
      await expect(service.agreeTerms('nonexistent')).resolves.toBeUndefined();
    });
  });

  // ── markOnboarded (LRR P2T1 PR N H-3) ─────────────────
  describe('markOnboarded', () => {
    it('처음 호출 (onboardedAt null) → repo.update로 onboardedAt 설정', async () => {
      const user = makeUser({ onboardedAt: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);

      await service.markOnboarded('user-uuid-1');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({ onboardedAt: expect.any(Date) }),
      );
    });

    it('이미 onboard됨 (onboardedAt 있음) → update 호출 안 함 (idempotent)', async () => {
      const user = makeUser({ onboardedAt: new Date('2026-01-01') });
      userRepo.findOneBy.mockResolvedValue(user);

      await service.markOnboarded('user-uuid-1');

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(service.markOnboarded('nonexistent')).rejects.toThrow(
        new NotFoundException('사용자를 찾을 수 없습니다.'),
      );
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── updateNickname ─────────────────────────────────────
  describe('updateNickname', () => {
    it('존재하는 userId → 닉네임 변경 후 저장된 유저 반환', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.updateNickname('user-uuid-1', '새닉네임');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ nickname: '새닉네임' }),
      );
      expect(result.nickname).toBe('새닉네임');
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.updateNickname('nonexistent', '닉네임'),
      ).rejects.toThrow(new NotFoundException('사용자를 찾을 수 없습니다.'));
      expect(userRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── deleteAccount ──────────────────────────────────────
  describe('deleteAccount', () => {
    it('존재하는 userId → repo.remove 호출 (hard delete)', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);

      await service.deleteAccount('user-uuid-1');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(userRepo.remove).toHaveBeenCalledWith(user);
    });

    it('softRemove가 아닌 remove 사용 확인', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);

      await service.deleteAccount('user-uuid-1');

      expect(userRepo.remove).toHaveBeenCalled();
      expect((userRepo as any).softRemove).not.toHaveBeenCalled();
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(service.deleteAccount('nonexistent')).rejects.toThrow(
        new NotFoundException('사용자를 찾을 수 없습니다.'),
      );
      expect(userRepo.remove).not.toHaveBeenCalled();
    });

    it('탈퇴 시 R2 파일 cascade 삭제 (E-6) — collectAllFileUrls 결과를 모두 deleteFile 호출', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);
      storageUsage.collectAllFileUrls.mockResolvedValue([
        'r2://cert-1.pdf',
        'r2://award-1.jpg',
        'r2://doc-1.pdf',
      ]);

      await service.deleteAccount('user-uuid-1');

      // DB 삭제 → R2 cascade 순서 보장 (호출 순서 검증)
      expect(storageUsage.collectAllFileUrls).toHaveBeenCalledWith(
        'user-uuid-1',
      );
      const removeOrder = (userRepo.remove as jest.Mock).mock
        .invocationCallOrder[0];
      const firstDeleteOrder = (filesService.deleteFile as jest.Mock).mock
        .invocationCallOrder[0];
      expect(removeOrder).toBeLessThan(firstDeleteOrder);
      expect(filesService.deleteFile).toHaveBeenCalledTimes(3);
      expect(filesService.deleteFile).toHaveBeenCalledWith('r2://cert-1.pdf');
      expect(filesService.deleteFile).toHaveBeenCalledWith('r2://award-1.jpg');
      expect(filesService.deleteFile).toHaveBeenCalledWith('r2://doc-1.pdf');
    });

    it('파일 없는 유저 탈퇴 시 → deleteFile 미호출', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);
      storageUsage.collectAllFileUrls.mockResolvedValue([]);

      await service.deleteAccount('user-uuid-1');

      expect(filesService.deleteFile).not.toHaveBeenCalled();
    });
  });

  // ── getDashboardConfig (LRR P2T1 PR O H-4) ────────────
  describe('getDashboardConfig', () => {
    it('DB dashboardConfig null → DEFAULT_SECTIONS (stats·dday·todos) 반환', async () => {
      const user = makeUser({ dashboardConfig: null });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(result.sections).toEqual([
        { id: 'stats', visible: true },
        { id: 'dday', visible: true },
        { id: 'todos', visible: true },
      ]);
    });

    it('기존 config 있음 → 그대로 반환', async () => {
      const custom = {
        sections: [
          { id: 'stats', visible: true },
          { id: 'cover_letter_quick', visible: true },
        ],
      };
      const user = makeUser({ dashboardConfig: custom });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');
      expect(result).toEqual(custom);
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(service.getDashboardConfig('nonexistent')).rejects.toThrow(
        new NotFoundException('사용자를 찾을 수 없습니다.'),
      );
    });

    it('orphan section ID 포함된 옛 DB row → 그대로 반환 (필터는 PATCH/프론트에서)', async () => {
      const orphan = {
        sections: [
          { id: 'stats', visible: true },
          { id: 'myinfo_progress', visible: true }, // ← deprecated
          { id: 'dday', visible: true },
        ],
      };
      const user = makeUser({ dashboardConfig: orphan });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');
      expect(result).toEqual(orphan);
    });
  });

  // ── updateDashboardConfig (LRR P2T1 PR O H-4) ─────────
  describe('updateDashboardConfig', () => {
    const validSections = [
      { id: 'stats', visible: true },
      { id: 'dday', visible: true },
      { id: 'todos', visible: false },
    ];

    it('정상 sections → 200 + DB JSONB 저장 + 응답', async () => {
      const user = makeUser({ dashboardConfig: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.updateDashboardConfig('user-uuid-1', {
        sections: validSections,
      });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          dashboardConfig: { sections: validSections },
        }),
      );
      expect(result.sections).toEqual(validSections);
    });

    it('sections[0].id !== "stats" → BadRequestException', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);

      await expect(
        service.updateDashboardConfig('user-uuid-1', {
          sections: [
            { id: 'dday', visible: true },
            { id: 'stats', visible: true },
          ],
        }),
      ).rejects.toThrow(
        new BadRequestException('stats 섹션은 항상 첫 번째여야 합니다.'),
      );
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('sections [] → BadRequestException (sections[0] undefined → stats 첫 위치 enforce 실패)', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);

      await expect(
        service.updateDashboardConfig('user-uuid-1', { sections: [] }),
      ).rejects.toThrow(BadRequestException);
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.updateDashboardConfig('nonexistent', {
          sections: validSections,
        }),
      ).rejects.toThrow(new NotFoundException('사용자를 찾을 수 없습니다.'));
      expect(userRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── countAll ───────────────────────────────────────────
  describe('countAll', () => {
    it('repo.count() 반환값을 그대로 반환', async () => {
      userRepo.count.mockResolvedValue(42);
      const result = await service.countAll();
      expect(result).toBe(42);
      expect(userRepo.count).toHaveBeenCalledTimes(1);
    });
  });

  // ── countByDate ────────────────────────────────────────
  describe('countByDate', () => {
    it('QueryBuilder getCount() 결과를 반환', async () => {
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(7),
      };
      userRepo.createQueryBuilder.mockReturnValue(mockQb as any);

      const from = new Date('2025-01-01');
      const result = await service.countByDate(from);

      expect(result).toBe(7);
      expect(mockQb.where).toHaveBeenCalledWith('u.created_at >= :from', {
        from,
      });
    });
  });
});
