import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import { createHash } from 'crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { AuthService, KakaoUser } from './auth.service';
import { User } from '../users/user.entity';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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

    it('동시 가입 race (unique violation) → 다른 요청의 user를 findOne으로 반환', async () => {
      const existing = makeUser({ kakaoId: 'kakao-race' });
      userRepo.findOne
        .mockResolvedValueOnce(null) // 첫 findOne — 아직 INSERT 안 됨
        .mockResolvedValueOnce(existing); // 두 번째 findOne — 다른 요청이 먼저 INSERT 완료
      userRepo.create.mockReturnValue(existing);

      const uniqueErr = new QueryFailedError('insert', [], new Error('dup'));
      (
        uniqueErr as QueryFailedError & { driverError?: { code?: string } }
      ).driverError = { code: '23505' };
      userRepo.save.mockRejectedValue(uniqueErr);

      const result = await service.findOrCreateKakaoUser({
        kakaoId: 'kakao-race',
        nickname: '경쟁자',
        email: null,
      });

      expect(result.isNew).toBe(false); // race 해소 시 isNew=false
      expect(result.user).toEqual(existing);
    });

    it('unique violation 외 다른 save 에러 → 원본 에러 전파', async () => {
      userRepo.findOne.mockResolvedValue(null);
      userRepo.create.mockReturnValue(makeUser());
      const otherErr = new QueryFailedError('insert', [], new Error('other'));
      userRepo.save.mockRejectedValue(otherErr);

      await expect(
        service.findOrCreateKakaoUser({
          kakaoId: 'kakao-x',
          nickname: 'x',
          email: null,
        }),
      ).rejects.toThrow(QueryFailedError);
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

    it('userRepo.update로 SHA-256 hash 저장 (평문 X) — LRR P1T1 M-2', async () => {
      const user = makeUser();
      jwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-token-plain');
      userRepo.update.mockResolvedValue({} as any);

      await service.issueTokens(user);

      expect(userRepo.update).toHaveBeenCalledWith(user.id, {
        refreshToken: sha256('refresh-token-plain'),
      });
      // 평문 절대 저장 X
      expect(userRepo.update).not.toHaveBeenCalledWith(user.id, {
        refreshToken: 'refresh-token-plain',
      });
    });

    it('{ accessToken, refreshToken } 형태로 반환 (refresh는 평문 — 브라우저 cookie 보관)', async () => {
      const user = makeUser();
      jwtService.sign
        .mockReturnValueOnce('at-123')
        .mockReturnValueOnce('rt-456');
      userRepo.update.mockResolvedValue({} as any);

      const result = await service.issueTokens(user);

      expect(result).toEqual({ accessToken: 'at-123', refreshToken: 'rt-456' });
    });
  });

  // ── refreshTokens (rotation) ──────────────────────────
  describe('refreshTokens', () => {
    it('새 access·refresh 둘 다 발급 + DB hash 갱신 — LRR P1T1 M-1', async () => {
      const user = makeUser();
      userRepo.findOne.mockResolvedValue(user);
      jwtService.sign
        .mockReturnValueOnce('new-access')
        .mockReturnValueOnce('new-refresh-plain');
      userRepo.update.mockResolvedValue({} as any);

      const result = await service.refreshTokens('user-uuid-1');

      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
      });
      // 새 access + 새 refresh 둘 다 반환
      expect(result).toEqual({
        accessToken: 'new-access',
        refreshToken: 'new-refresh-plain',
      });
      // DB에 새 refresh의 hash로 갱신 (rotation)
      expect(userRepo.update).toHaveBeenCalledWith(user.id, {
        refreshToken: sha256('new-refresh-plain'),
      });
    });

    it('rotation 효과: 같은 사용자 2회 호출 → 매번 다른 hash 저장', async () => {
      const user = makeUser();
      userRepo.findOne.mockResolvedValue(user);
      jwtService.sign
        .mockReturnValueOnce('a1')
        .mockReturnValueOnce('r1')
        .mockReturnValueOnce('a2')
        .mockReturnValueOnce('r2');
      userRepo.update.mockResolvedValue({} as any);

      await service.refreshTokens('user-uuid-1');
      await service.refreshTokens('user-uuid-1');

      expect(userRepo.update).toHaveBeenNthCalledWith(1, user.id, {
        refreshToken: sha256('r1'),
      });
      expect(userRepo.update).toHaveBeenNthCalledWith(2, user.id, {
        refreshToken: sha256('r2'),
      });
    });

    it('존재하지 않는 userId → UnauthorizedException (500이 아닌 401로 변환)', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.refreshTokens('nonexistent')).rejects.toThrow(
        UnauthorizedException,
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
