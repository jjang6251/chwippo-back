import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let userRepo: jest.Mocked<Repository<User>>;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    userRepo = module.get(getRepositoryToken(User));
  });

  afterEach(() => jest.clearAllMocks());

  // ── updateNickname ─────────────────────────────────────
  describe('updateNickname', () => {
    it('존재하는 userId → 닉네임 변경 후 저장된 유저 반환', async () => {
      const user = makeUser();
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.updateNickname('user-uuid-1', '새닉네임');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(userRepo.save).toHaveBeenCalledWith(expect.objectContaining({ nickname: '새닉네임' }));
      expect(result.nickname).toBe('새닉네임');
    });

    it('존재하지 않는 userId → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(service.updateNickname('nonexistent', '닉네임')).rejects.toThrow(
        new NotFoundException('사용자를 찾을 수 없습니다.'),
      );
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
      expect(mockQb.where).toHaveBeenCalledWith('u.created_at >= :from', { from });
    });
  });
});
