import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import { createHash } from 'crypto';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { AuthService, KakaoUser } from './auth.service';
import { User } from '../users/user.entity';
import { RefreshSession } from './refresh-session.entity';
import { RefreshToken } from './refresh-token.entity';
import { DiscordNotifier } from '../common/discord-notifier';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** rotateTokens 조회(refresh_tokens ⋈ refresh_sessions) row */
const makeTokenRow = (
  overrides: Partial<{
    token_id: string;
    session_id: string;
    used_at: Date | null;
    session_created_at: Date;
  }> = {},
) => ({
  token_id: 'tok-1',
  session_id: 'sid-1',
  used_at: null as Date | null,
  session_created_at: new Date(),
  ...overrides,
});

describe('AuthService', () => {
  let service: AuthService;
  let userRepo: jest.Mocked<Repository<User>>;
  let sessionRepo: jest.Mocked<Repository<RefreshSession>>;
  let tokenRepo: jest.Mocked<Repository<RefreshToken>>;
  let jwtService: jest.Mocked<JwtService>;
  let discord: { notify: jest.Mock };
  let manager: jest.Mocked<EntityManager>;
  let txSessionRepo: jest.Mocked<Repository<RefreshSession>>;
  let txTokenRepo: jest.Mocked<Repository<RefreshToken>>;
  let txUserRepo: jest.Mocked<Repository<User>>;

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
    const mockSessionRepo = mock<Repository<RefreshSession>>();
    const mockTokenRepo = mock<Repository<RefreshToken>>();
    const mockJwtService = mock<JwtService>();
    const mockConfig = mock<ConfigService>();
    const mockDiscord = { notify: jest.fn().mockResolvedValue('sent') };
    const mockDataSource = mock<DataSource>();
    manager = mock<EntityManager>();
    txSessionRepo = mock<Repository<RefreshSession>>();
    txTokenRepo = mock<Repository<RefreshToken>>();
    txUserRepo = mock<Repository<User>>();

    // manager.getRepository(X) → X 별 tx repo 반환
    manager.getRepository.mockImplementation((entity: unknown) => {
      if (entity === RefreshSession) return txSessionRepo;
      if (entity === RefreshToken) return txTokenRepo;
      return txUserRepo;
    });
    manager.query.mockResolvedValue([] as never);
    mockDataSource.transaction.mockImplementation(async (cb: unknown) =>
      (cb as (m: EntityManager) => unknown)(manager),
    );

    // config 기본값
    mockConfig.getOrThrow.mockImplementation((key: string) => {
      if (key === 'JWT_SECRET') return 'test-jwt-secret';
      if (key === 'JWT_REFRESH_SECRET') return 'test-refresh-secret';
      return 'test-value';
    });
    mockConfig.get.mockImplementation((key: string, defaultVal?: string) => {
      if (key === 'JWT_EXPIRES_IN') return '1h';
      if (key === 'JWT_REFRESH_EXPIRES_IN') return '60d';
      return defaultVal ?? '';
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: DiscordNotifier, useValue: mockDiscord },
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        {
          provide: getRepositoryToken(RefreshSession),
          useValue: mockSessionRepo,
        },
        { provide: getRepositoryToken(RefreshToken), useValue: mockTokenRepo },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepo = module.get(getRepositoryToken(User));
    sessionRepo = module.get(getRepositoryToken(RefreshSession));
    tokenRepo = module.get(getRepositoryToken(RefreshToken));
    jwtService = module.get(JwtService);
    discord = mockDiscord;
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
      const existing = makeUser({ termsAgreedAt: null });
      userRepo.findOne.mockResolvedValue(existing);

      const result = await service.findOrCreateKakaoUser(kakaoUser);

      expect(result.isNew).toBe(false);
      expect(result.user.termsAgreedAt).toBeNull();
      expect(String(!result.user.termsAgreedAt)).toBe('true');
    });

    it('needs_terms 직렬화 검증: !termsAgreedAt → String(true/false)', () => {
      const nullUser = makeUser({ termsAgreedAt: null });
      const agreedUser = makeUser({ termsAgreedAt: new Date() });

      expect(String(!nullUser.termsAgreedAt)).toBe('true');
      expect(String(!agreedUser.termsAgreedAt)).toBe('false');
    });

    // ── M-3 ADMIN_KAKAO_ID 자동 승격 ─────────────────────
    describe('ADMIN_KAKAO_ID 자동 승격 (M-3, A2-13)', () => {
      const adminId = 'kakao-admin-999';

      beforeEach(() => {
        const mockConfig = service['config'] as jest.Mocked<ConfigService>;
        mockConfig.get.mockImplementation(
          (key: string, defaultVal?: string) => {
            if (key === 'ADMIN_KAKAO_ID') return adminId;
            if (key === 'JWT_EXPIRES_IN') return '1h';
            if (key === 'JWT_REFRESH_EXPIRES_IN') return '60d';
            return defaultVal ?? '';
          },
        );
      });

      it('카카오ID === ADMIN_KAKAO_ID + role=user → admin 자동 승격 + repo.update 호출', async () => {
        const user = makeUser({ kakaoId: adminId, role: 'user' });
        userRepo.findOne.mockResolvedValue(user);

        const result = await service.findOrCreateKakaoUser({
          kakaoId: adminId,
          nickname: '관리자',
          email: 'admin@x.com',
        });

        expect(userRepo.update).toHaveBeenCalledWith(user.id, {
          role: 'admin',
        });
        expect(result.user.role).toBe('admin');
      });

      it('이미 role=admin → update 미호출 (중복 승격 방지)', async () => {
        const user = makeUser({ kakaoId: adminId, role: 'admin' });
        userRepo.findOne.mockResolvedValue(user);

        await service.findOrCreateKakaoUser({
          kakaoId: adminId,
          nickname: '관리자',
          email: null,
        });

        expect(userRepo.update).not.toHaveBeenCalled();
      });

      it('카카오ID !== ADMIN_KAKAO_ID → 승격 안 됨', async () => {
        const user = makeUser({ kakaoId: 'kakao-other', role: 'user' });
        userRepo.findOne.mockResolvedValue(user);

        const result = await service.findOrCreateKakaoUser({
          kakaoId: 'kakao-other',
          nickname: '일반',
          email: null,
        });

        expect(result.user.role).toBe('user');
        expect(userRepo.update).not.toHaveBeenCalled();
      });

      it('ADMIN_KAKAO_ID 미설정 (빈 문자열) → 승격 분기 미작동', async () => {
        const mockConfig = service['config'] as jest.Mocked<ConfigService>;
        mockConfig.get.mockImplementation(
          (key: string, defaultVal?: string) => {
            if (key === 'ADMIN_KAKAO_ID') return '';
            if (key === 'JWT_EXPIRES_IN') return '1h';
            if (key === 'JWT_REFRESH_EXPIRES_IN') return '60d';
            return defaultVal ?? '';
          },
        );

        const user = makeUser({ kakaoId: '', role: 'user' });
        userRepo.findOne.mockResolvedValue(user);

        await service.findOrCreateKakaoUser({
          kakaoId: '',
          nickname: 'x',
          email: null,
        });

        expect(userRepo.update).not.toHaveBeenCalled();
      });
    });

    it('M-4 (A2-28): <script> 포함 nickname → 그대로 저장 (sanitize는 렌더 측 책임)', async () => {
      const xss = '<script>alert(1)</script>';
      userRepo.findOne.mockResolvedValue(null);
      userRepo.create.mockImplementation((dto) => dto as User);
      userRepo.save.mockImplementation(async (u) => u as User);

      const result = await service.findOrCreateKakaoUser({
        kakaoId: 'kakao-x',
        nickname: xss,
        email: '"><img onerror=x>@a.com',
      });

      expect(result.user.nickname).toBe(xss);
      expect(result.user.email).toBe('"><img onerror=x>@a.com');
    });
  });

  // ── issueTokens (로그인 — 새 기기 세션 + 최초 토큰 발급) ────
  describe('issueTokens', () => {
    beforeEach(() => {
      txSessionRepo.insert.mockResolvedValue({} as never);
      txTokenRepo.insert.mockResolvedValue({} as never);
      txUserRepo.update.mockResolvedValue({} as never);
    });

    it('access(1h)·refresh(60d) 둘 다 발급 · refresh 에 sid claim 포함', async () => {
      const user = makeUser();
      jwtService.sign
        .mockReturnValueOnce('access-token') // #1 access
        .mockReturnValueOnce('refresh-token'); // #2 refresh

      const result = await service.issueTokens(user);

      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
      expect(jwtService.sign).toHaveBeenNthCalledWith(
        1,
        { sub: user.id, role: user.role },
        { secret: 'test-jwt-secret', expiresIn: '1h' },
      );
      expect(jwtService.sign).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          sub: user.id,
          role: user.role,
          sid: expect.any(String),
        }),
        { secret: 'test-refresh-secret', expiresIn: '60d' },
      );
    });

    it('세션 행 + 토큰 행 insert — 세션에 hash 없음 · 토큰에 SHA-256(refresh) · used_at null', async () => {
      const user = makeUser();
      jwtService.sign
        .mockReturnValueOnce('access-token')
        .mockReturnValueOnce('refresh-plain');

      await service.issueTokens(user, 'Mozilla/5.0 test-UA');

      const signedSid = (jwtService.sign.mock.calls[1][0] as { sid: string })
        .sid;
      expect(txSessionRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: signedSid, // sid claim == 세션 id
          userId: user.id,
          deviceInfo: 'Mozilla/5.0 test-UA',
          revokedAt: null,
        }),
      );
      // 세션 행엔 token_hash 없음 (토큰 패밀리 분리)
      const sessionArg = txSessionRepo.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(sessionArg.tokenHash).toBeUndefined();
      // 토큰 행: 해시 저장 · 평문 저장 X · used_at null
      expect(txTokenRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: signedSid,
          tokenHash: sha256('refresh-plain'),
          usedAt: null,
        }),
      );
      const tokenArg = txTokenRepo.insert.mock.calls[0][0] as {
        tokenHash: string;
      };
      expect(tokenArg.tokenHash).not.toBe('refresh-plain');
    });

    it('로그인마다 새 sid 발급 (session fixation 차단 CWE-384)', async () => {
      const user = makeUser();
      jwtService.sign.mockReturnValue('t');

      await service.issueTokens(user);
      await service.issueTokens(user);

      const sid1 = (jwtService.sign.mock.calls[1][0] as { sid: string }).sid;
      const sid2 = (jwtService.sign.mock.calls[3][0] as { sid: string }).sid;
      expect(sid1).not.toBe(sid2);
    });

    it('기기 상한 evict — UPDATE ... revoked_at ... LIMIT 10 실행', async () => {
      const user = makeUser();
      jwtService.sign.mockReturnValue('t');

      await service.issueTokens(user);

      const evictCall = manager.query.mock.calls.find((c) =>
        String(c[0]).includes('UPDATE refresh_sessions SET revoked_at'),
      );
      expect(evictCall).toBeDefined();
      expect(String(evictCall![0])).toContain('LIMIT $2');
      expect(evictCall![1]).toEqual([user.id, 10]);
    });

    it('재로그인 → session_expired_notified_at 리셋 · 구 refresh_token 컬럼 미기록', async () => {
      const user = makeUser();
      jwtService.sign.mockReturnValue('t');

      await service.issueTokens(user);

      expect(txUserRepo.update).toHaveBeenCalledWith(user.id, {
        sessionExpiredNotifiedAt: null,
      });
      const wroteLegacy = txUserRepo.update.mock.calls.some(
        (c) => (c[1] as Record<string, unknown>).refreshToken !== undefined,
      );
      expect(wroteLegacy).toBe(false);
    });
  });

  // ── rotateTokens (토큰 패밀리 · 재사용 감지) ────────────────
  describe('rotateTokens — sid 있는 신 토큰', () => {
    const base = {
      userId: 'user-uuid-1',
      role: 'user',
      sid: 'sid-1',
      rawToken: 'raw-rt',
    };

    it('① 미사용 토큰 정상 rotation — 원자 소비 1행 → 새 토큰 INSERT + sliding + 새 쌍', async () => {
      tokenRepo.query.mockResolvedValueOnce([makeTokenRow()]); // lookup(SELECT): rows[]
      // UPDATE ... RETURNING → TypeORM 실제 형태 [rows[], affected]
      manager.query.mockResolvedValueOnce([[{ id: 'tok-1' }], 1]); // 원자 소비 1행 (승자)
      jwtService.sign
        .mockReturnValueOnce('new-refresh') // #1 refresh
        .mockReturnValueOnce('new-access'); // #2 access

      const result = await service.rotateTokens(base);

      expect(result).toEqual({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      });
      // 조회: BOLA (user_id) + 활성 세션 (revoked_at IS NULL)
      const [lookupSql, lookupParams] = tokenRepo.query.mock.calls[0];
      expect(lookupSql).toContain('FROM refresh_tokens');
      expect(lookupSql).toContain('s.user_id = $2');
      expect(lookupSql).toContain('s.revoked_at IS NULL');
      // 심층방어 — DB 만료 세션도 조회에서 배제 (JWT exp 단독 의존 회피)
      expect(lookupSql).toContain('s.expires_at > NOW()');
      expect(lookupParams).toEqual([sha256('raw-rt'), 'user-uuid-1']);
      // jti — 발급 refresh 토큰마다 고유 (같은 세션·같은 초 발급 시 token_hash UNIQUE 충돌→500 방지)
      const refreshSignCall = jwtService.sign.mock.calls.find(
        (c) => typeof c[0] === 'object' && c[0] !== null && 'sid' in c[0],
      );
      expect(refreshSignCall?.[0]).toHaveProperty('jti');
      // 원자 소비 (used_at IS NULL 가드)
      const markSql = String(manager.query.mock.calls[0][0]);
      expect(markSql).toContain('UPDATE refresh_tokens SET used_at = NOW()');
      expect(markSql).toContain('used_at IS NULL');
      // 새 토큰 INSERT + sliding UPDATE
      const insertCall = manager.query.mock.calls.find((c) =>
        String(c[0]).includes('INSERT INTO refresh_tokens'),
      );
      expect(insertCall).toBeDefined();
      const slideCall = manager.query.mock.calls.find((c) =>
        String(c[0]).includes('expires_at = NOW() + INTERVAL'),
      );
      expect(slideCall).toBeDefined();
      // 정상 rotation = 세션 revoke·Discord 없음
      expect(sessionRepo.query).not.toHaveBeenCalled();
      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('② 이미 소비된 토큰 재사용 (5초 초과) → 세션 revoke + Discord critical + 401', async () => {
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({ used_at: new Date(Date.now() - 20_000) }), // 20초 전 소비
      ]);
      sessionRepo.query.mockResolvedValue([] as never);

      await expect(service.rotateTokens(base)).rejects.toThrow(
        UnauthorizedException,
      );
      // 세션 전체 revoke (BOLA 스코프)
      const [revokeSql, revokeParams] = sessionRepo.query.mock.calls[0];
      expect(revokeSql).toContain('UPDATE refresh_sessions SET revoked_at');
      expect(revokeSql).toContain('id = $1 AND user_id = $2');
      expect(revokeParams).toEqual(['sid-1', 'user-uuid-1']);
      expect(discord.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('재사용') }),
        'critical',
      );
      // 탈취 판정 = rotation TX 안 함
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('③ 동시 2요청 같은 토큰 → 1승자 정상 + 1패자 409 (RETRY, revoke 아님)', async () => {
      jwtService.sign.mockReturnValue('t');
      // 승자: lookup 미사용 → 원자 소비 1행
      // 패자: lookup 미사용 → 원자 소비 0행 → 재조회 최근 used_at → 409
      tokenRepo.query
        .mockResolvedValueOnce([makeTokenRow()]) // 승자 lookup(SELECT)
        .mockResolvedValueOnce([makeTokenRow()]) // 패자 lookup(SELECT)
        .mockResolvedValueOnce([{ used_at: new Date() }]); // 패자 재조회 (방금 소비)
      manager.query.mockResolvedValueOnce([[{ id: 'tok-1' }], 1]); // 승자 소비 1행
      // 패자 소비 = manager.query 기본값 [] → returningRows 0행 (loser)

      const winner = await service.rotateTokens(base);
      expect(winner).toEqual({ accessToken: 't', refreshToken: 't' });

      const err = await service.rotateTokens(base).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual({
        code: 'RETRY',
      });
      // 경합 패자는 세션 revoke·Discord 없음
      expect(sessionRepo.query).not.toHaveBeenCalled();
      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('④ 이미 소비된 토큰 재사용 (5초 이내) → 409 (RETRY) · revoke 아님', async () => {
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({ used_at: new Date(Date.now() - 1000) }), // 1초 전 소비
      ]);

      const err = await service.rotateTokens(base).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual({
        code: 'RETRY',
      });
      expect(sessionRepo.query).not.toHaveBeenCalled(); // revoke 안 함
      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('⑤ 세션 revoke 시 그 세션의 다른 토큰도 조회 0행(revoked_at 필터) → 401 · revoke 는 (id,user_id) 스코프라 타 세션 무영향', async () => {
      // 같은 세션의 또 다른 토큰 제시 — 조회 join 의 revoked_at IS NULL 로 걸러져 0행
      tokenRepo.query.mockResolvedValueOnce([]); // 세션이 revoked → 토큰 안 나옴

      await expect(
        service.rotateTokens({ ...base, rawToken: 'sibling-rt' }),
      ).rejects.toThrow(UnauthorizedException);

      // 조회 SQL 이 revoked_at IS NULL 로 revoked 세션 토큰 전부 배제함을 확인
      expect(String(tokenRepo.query.mock.calls[0][0])).toContain(
        's.revoked_at IS NULL',
      );
    });

    it('⑦ absolute cap: created_at 181일 초과 → 세션 revoke + 401 (rotation 안 함)', async () => {
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({
          session_created_at: new Date(Date.now() - 181 * 86400000),
        }),
      ]);
      sessionRepo.query.mockResolvedValue([] as never);

      await expect(service.rotateTokens(base)).rejects.toThrow(
        UnauthorizedException,
      );
      const [revokeSql, revokeParams] = sessionRepo.query.mock.calls[0];
      expect(revokeSql).toContain('UPDATE refresh_sessions SET revoked_at');
      expect(revokeParams).toEqual(['sid-1', 'user-uuid-1']);
      // cap = 탈취 아님 → rotation TX·Discord 없음
      expect(manager.query).not.toHaveBeenCalled();
      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('토큰 조회 0행 (위조·만료·타유저) → 401', async () => {
      tokenRepo.query.mockResolvedValueOnce([]);

      await expect(service.rotateTokens(base)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(sessionRepo.query).not.toHaveBeenCalled();
      expect(discord.notify).not.toHaveBeenCalled();
    });
  });

  // ── rotateTokens fallback (legacy · sid 없는 구 토큰) ──────
  describe('rotateTokens — legacy fallback 이전', () => {
    const legacyBase = {
      userId: 'user-uuid-1',
      role: 'user',
      sid: undefined,
      rawToken: 'legacy-rt',
    };

    beforeEach(() => {
      txSessionRepo.insert.mockResolvedValue({} as never);
      txTokenRepo.insert.mockResolvedValue({} as never);
      txUserRepo.update.mockResolvedValue({} as never);
    });

    it('⑥ 구 refresh_token 원자 claim 1행 → 세션+최초 토큰 생성 + 새 쌍', async () => {
      // UPDATE users ... RETURNING → 실제 형태 [rows[], affected]
      manager.query.mockResolvedValueOnce([[{ id: 'user-uuid-1' }], 1]); // 원자 claim 1행
      jwtService.sign
        .mockReturnValueOnce('mig-access') // #1 access
        .mockReturnValueOnce('mig-refresh'); // #2 refresh

      const result = await service.rotateTokens(legacyBase);

      expect(result).toEqual({
        accessToken: 'mig-access',
        refreshToken: 'mig-refresh',
      });
      // 원자 claim SQL (TOCTOU 차단): SET refresh_token=NULL WHERE id AND refresh_token RETURNING
      const claimSql = String(manager.query.mock.calls[0][0]);
      expect(claimSql).toContain('UPDATE users SET refresh_token = NULL');
      expect(claimSql).toContain('refresh_token = $2');
      expect(claimSql).toContain('RETURNING');
      expect(manager.query.mock.calls[0][1]).toEqual([
        'user-uuid-1',
        sha256('legacy-rt'),
      ]);
      // 세션 + 토큰 행 생성
      expect(txSessionRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-uuid-1', revokedAt: null }),
      );
      expect(txTokenRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ tokenHash: sha256('mig-refresh') }),
      );
      expect(txUserRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        sessionExpiredNotifiedAt: null,
      });
    });

    it('⑥ 원자 claim 0행 (불일치·null·동시 선점 TOCTOU) → 401 · 세션 생성 안 함', async () => {
      manager.query.mockResolvedValueOnce([[], 0]); // claim 0행 → tx 내부 throw → rollback

      await expect(service.rotateTokens(legacyBase)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(txSessionRepo.insert).not.toHaveBeenCalled();
      expect(txTokenRepo.insert).not.toHaveBeenCalled();
    });
  });

  // ── logout (해당 세션만 revoke) ─────────────────────────
  describe('logout', () => {
    it('rawToken 해시로 그 토큰이 속한 세션만 revoke (BOLA 스코프)', async () => {
      sessionRepo.query.mockResolvedValue([] as never);
      userRepo.update.mockResolvedValue({} as never);

      await service.logout('user-uuid-1', 'raw-rt');

      const [sql, params] = sessionRepo.query.mock.calls[0];
      expect(sql).toContain('UPDATE refresh_sessions SET revoked_at');
      expect(sql).toContain('user_id = $1');
      expect(sql).toContain('SELECT session_id FROM refresh_tokens');
      expect(params).toEqual(['user-uuid-1', sha256('raw-rt')]);
      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        refreshToken: null,
      });
    });

    it('rawToken 없으면 세션 revoke 스킵 (구 컬럼만 정리)', async () => {
      userRepo.update.mockResolvedValue({} as never);

      await service.logout('user-uuid-1', null);

      expect(sessionRepo.query).not.toHaveBeenCalled();
      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        refreshToken: null,
      });
    });
  });

  // ── hasValidSession / cron cleanup ──────────────────────
  describe('hasValidSession (푸시-세션 분리 판정)', () => {
    it('유효(만료 전·revoke 안 됨) 세션 있음 → true (user 조회 없이)', async () => {
      sessionRepo.count.mockResolvedValue(1);

      const result = await service.hasValidSession('user-uuid-1');

      expect(result).toBe(true);
      expect(userRepo.findOne).not.toHaveBeenCalled();
    });

    it('유효 세션 0 + legacy 구 컬럼 존재 → true (미이전 로그인 상태)', async () => {
      sessionRepo.count.mockResolvedValue(0);
      userRepo.findOne.mockResolvedValue(
        makeUser({ refreshToken: sha256('x') }),
      );

      expect(await service.hasValidSession('user-uuid-1')).toBe(true);
    });

    it('유효 세션 0 + legacy 컬럼도 null → false', async () => {
      sessionRepo.count.mockResolvedValue(0);
      userRepo.findOne.mockResolvedValue(makeUser({ refreshToken: null }));

      expect(await service.hasValidSession('user-uuid-1')).toBe(false);
    });
  });

  describe('deleteExpiredSessions (cron)', () => {
    it('만료 OR revoked 세션 삭제 후 삭제 수 반환 (토큰 CASCADE)', async () => {
      // DELETE ... RETURNING → 실제 형태 [rows[], affected]
      sessionRepo.query.mockResolvedValue([
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        3,
      ] as never);

      const deleted = await service.deleteExpiredSessions();

      expect(deleted).toBe(3);
      const sql = String(sessionRepo.query.mock.calls[0][0]);
      expect(sql).toContain('DELETE FROM refresh_sessions');
      expect(sql).toContain('expires_at < $1');
      expect(sql).toContain('revoked_at IS NOT NULL');
    });
  });

  describe('⑨ deleteUsedTokens (cron — 소비 토큰 7일 정리)', () => {
    it('used_at +7일 경과 토큰 삭제 후 삭제 수 반환', async () => {
      // DELETE ... RETURNING → 실제 형태 [rows[], affected]
      tokenRepo.query.mockResolvedValue([
        [{ id: 'x' }, { id: 'y' }],
        2,
      ] as never);

      const deleted = await service.deleteUsedTokens();

      expect(deleted).toBe(2);
      const [sql, params] = tokenRepo.query.mock.calls[0];
      expect(sql).toContain('DELETE FROM refresh_tokens');
      expect(sql).toContain('used_at IS NOT NULL');
      expect(sql).toContain('used_at < $1');
      // cutoff = now - 7d (근사 검증)
      const cutoff = (params as Date[])[0];
      const expected = Date.now() - 7 * 86400000;
      expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
    });
  });
});
