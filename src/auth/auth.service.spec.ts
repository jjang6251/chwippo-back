import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import { EntityNotFoundError, Repository } from 'typeorm';
import { AuthService, KakaoUser } from './auth.service';
import { User } from '../users/user.entity';

describe('AuthService', () => {
  let service: AuthService;
  let userRepo: jest.Mocked<Repository<User>>;
  let jwtService: jest.Mocked<JwtService>;

  const makeUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-uuid-1',
      kakaoId: 'kakao-123',
      nickname: '테스트유저',
      email: 'test@test.com',
      role: 'user',
      refreshToken: null,
      lastActiveAt: null,
      createdAt: new Date(),
      termsAgreedAt: null,
      onboardedAt: null,
      ...overrides,
    }) as User;

  beforeEach(async () => {
    const mockUserRepo = mock<Repository<User>>();
    const mockJwtService = mock<JwtService>();
    const mockConfig = mock<ConfigService>();

    // config 기본값
    mockConfig.getOrThrow.mockImplementation((key: string) => {
      if (key === 'JWT_SECRET') return 'test-jwt-secret';
      if (key === 'JWT_REFRESH_SECRET') return 'test-refresh-secret';
      return 'test-value';
    });
    mockConfig.get.mockImplementation((key: string, defaultVal?: string) => {
      if (key === 'JWT_EXPIRES_IN') return '1h';
      if (key === 'JWT_REFRESH_EXPIRES_IN') return '30d';
      return defaultVal ?? '';
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepo = module.get(getRepositoryToken(User));
    jwtService = module.get(JwtService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── findOrCreateKakaoUser ──────────────────────────────
  describe('findOrCreateKakaoUser', () => {
    const kakaoUser: KakaoUser = {
      kakaoId: 'kakao-123',
      nickname: '홍길동',
      email: 'hong@kakao.com',
    };

    it('기존 유저 → { user: existingUser, isNew: false } 반환', async () => {
      const existing = makeUser({ kakaoId: 'kakao-123' });
      userRepo.findOne.mockResolvedValue(existing);

      const result = await service.findOrCreateKakaoUser(kakaoUser);

      expect(result.user).toEqual(existing);
      expect(result.isNew).toBe(false);
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('신규 kakaoId → userRepo.create + save → { user: newUser, isNew: true }', async () => {
      const newUser = makeUser({ kakaoId: 'kakao-new' });
      userRepo.findOne.mockResolvedValue(null);
      userRepo.create.mockReturnValue(newUser);
      userRepo.save.mockResolvedValue(newUser);

      const result = await service.findOrCreateKakaoUser({
        kakaoId: 'kakao-new',
        nickname: '새유저',
        email: null,
      });

      expect(result.isNew).toBe(true);
      expect(userRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ kakaoId: 'kakao-new', nickname: '새유저' }),
      );
      expect(userRepo.save).toHaveBeenCalledTimes(1);
    });

    it('신규 유저 생성 시 kakaoId, nickname, email 필드 포함', async () => {
      const newUser = makeUser();
      userRepo.findOne.mockResolvedValue(null);
      userRepo.create.mockReturnValue(newUser);
      userRepo.save.mockResolvedValue(newUser);

      await service.findOrCreateKakaoUser(kakaoUser);

      expect(userRepo.create).toHaveBeenCalledWith({
        kakaoId: 'kakao-123',
        nickname: '홍길동',
        email: 'hong@kakao.com',
      });
    });

    it('findOne에 { where: { kakaoId } } 조건으로 조회', async () => {
      userRepo.findOne.mockResolvedValue(makeUser());
      await service.findOrCreateKakaoUser(kakaoUser);
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { kakaoId: 'kakao-123' },
      });
    });

    // ── termsAgreedAt 관련 시나리오 ──────────────────────────────
    it('신규 유저 생성 시 termsAgreedAt 를 설정하지 않음 (DB 기본값 null)', async () => {
      const newUser = makeUser({ termsAgreedAt: null });
      userRepo.findOne.mockResolvedValue(null);
      userRepo.create.mockReturnValue(newUser);
      userRepo.save.mockResolvedValue(newUser);

      const result = await service.findOrCreateKakaoUser(kakaoUser);

      // create 호출 시 termsAgreedAt 을 직접 지정하지 않아야 한다
      expect(userRepo.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ termsAgreedAt: expect.anything() }),
      );
      expect(result.user.termsAgreedAt).toBeNull();
    });

    it('약관 동의 완료 기존 유저 → termsAgreedAt 값 그대로 반환', async () => {
      const agreedAt = new Date('2025-05-14T10:00:00.000Z');
      const existing = makeUser({ termsAgreedAt: agreedAt });
      userRepo.findOne.mockResolvedValue(existing);

      const result = await service.findOrCreateKakaoUser(kakaoUser);

      expect(result.user.termsAgreedAt).toEqual(agreedAt);
      expect(result.isNew).toBe(false);
    });

    it('약관 미동의 기존 유저 (거부 후 재로그인) → termsAgreedAt=null, isNew=false', async () => {
      // 약관 거부 시 계정 삭제 없이 termsAgreedAt=null 유지
      // 재로그인 시 isNew=false 이지만 백엔드가 needs_terms=true 전달
      const existing = makeUser({ termsAgreedAt: null });
      userRepo.findOne.mockResolvedValue(existing);

      const result = await service.findOrCreateKakaoUser(kakaoUser);

      expect(result.isNew).toBe(false);
      expect(result.user.termsAgreedAt).toBeNull();
      // 컨트롤러에서 needs_terms = String(!user.termsAgreedAt) = "true" 로 직렬화됨
      expect(String(!result.user.termsAgreedAt)).toBe('true');
    });

    it('needs_terms 직렬화 검증: !termsAgreedAt → String(true/false)', () => {
      const nullUser = makeUser({ termsAgreedAt: null });
      const agreedUser = makeUser({ termsAgreedAt: new Date() });

      expect(String(!nullUser.termsAgreedAt)).toBe('true'); // needs_terms="true"
      expect(String(!agreedUser.termsAgreedAt)).toBe('false'); // needs_terms="false"
    });
  });

  // ── issueTokens ────────────────────────────────────────
  describe('issueTokens', () => {
    it('jwtService.sign 2회 호출 (accessToken, refreshToken)', async () => {
      const user = makeUser();
      jwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      userRepo.update.mockResolvedValue({} as any);

      await service.issueTokens(user);

      expect(jwtService.sign).toHaveBeenCalledTimes(2);
    });

    it('accessToken: JWT_SECRET, expiresIn: 1h 로 sign', async () => {
      const user = makeUser();
      jwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      userRepo.update.mockResolvedValue({} as any);

      await service.issueTokens(user);

      expect(jwtService.sign).toHaveBeenNthCalledWith(
        1,
        { sub: user.id, role: user.role },
        { secret: 'test-jwt-secret', expiresIn: '1h' },
      );
    });

    it('refreshToken: JWT_REFRESH_SECRET, expiresIn: 30d 로 sign', async () => {
      const user = makeUser();
      jwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      userRepo.update.mockResolvedValue({} as any);

      await service.issueTokens(user);

      expect(jwtService.sign).toHaveBeenNthCalledWith(
        2,
        { sub: user.id, role: user.role },
        { secret: 'test-refresh-secret', expiresIn: '30d' },
      );
    });

    it('userRepo.update로 refreshToken을 DB에 저장', async () => {
      const user = makeUser();
      jwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token');
      userRepo.update.mockResolvedValue({} as any);

      await service.issueTokens(user);

      expect(userRepo.update).toHaveBeenCalledWith(user.id, {
        refreshToken: 'refresh-token',
      });
    });

    it('{ accessToken, refreshToken } 형태로 반환', async () => {
      const user = makeUser();
      jwtService.sign
        .mockReturnValueOnce('at-123')
        .mockReturnValueOnce('rt-456');
      userRepo.update.mockResolvedValue({} as any);

      const result = await service.issueTokens(user);

      expect(result).toEqual({ accessToken: 'at-123', refreshToken: 'rt-456' });
    });
  });

  // ── refreshAccessToken ─────────────────────────────────
  describe('refreshAccessToken', () => {
    it('유저 조회 성공 → jwtService.sign 호출 → accessToken 문자열 반환', async () => {
      const user = makeUser();
      userRepo.findOneOrFail.mockResolvedValue(user);
      jwtService.sign.mockReturnValue('new-access-token');

      const result = await service.refreshAccessToken('user-uuid-1');

      expect(userRepo.findOneOrFail).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
      });
      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: user.id, role: user.role },
        { secret: 'test-jwt-secret', expiresIn: '1h' },
      );
      expect(result).toBe('new-access-token');
    });

    it('존재하지 않는 userId → findOneOrFail에서 EntityNotFoundError 전파', async () => {
      userRepo.findOneOrFail.mockRejectedValue(
        new EntityNotFoundError(User, {}),
      );

      await expect(service.refreshAccessToken('nonexistent')).rejects.toThrow(
        EntityNotFoundError,
      );
    });
  });

  // ── logout ─────────────────────────────────────────────
  describe('logout', () => {
    it('userRepo.update(userId, { refreshToken: null }) 호출', async () => {
      userRepo.update.mockResolvedValue({} as any);

      await service.logout('user-uuid-1');

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        refreshToken: null,
      });
    });
  });
});
