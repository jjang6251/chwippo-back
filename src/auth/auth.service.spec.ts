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
import { AdminAuditService } from '../admin/admin-audit.service';

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
  let audit: { log: jest.Mock };
  let manager: jest.Mocked<EntityManager>;
  let txSessionRepo: jest.Mocked<Repository<RefreshSession>>;
  let txTokenRepo: jest.Mocked<Repository<RefreshToken>>;
  let txUserRepo: jest.Mocked<Repository<User>>;
  let dataSource: jest.Mocked<DataSource>;

  const makeUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-uuid-1',
      kakaoId: 'kakao-123',
      nickname: '테스트유저',
      email: 'test@test.com',
      role: 'user',
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
    const mockAudit = { log: jest.fn().mockResolvedValue(undefined) };
    const mockDataSource = mock<DataSource>();
    dataSource = mockDataSource;
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
        { provide: AdminAuditService, useValue: mockAudit },
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
    audit = mockAudit;
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

      // PostgreSQL unique violation: driverError.code === '23505'
      const driverError = Object.assign(new Error('dup'), { code: '23505' });
      const uniqueErr = new QueryFailedError('insert', [], driverError);
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

    /**
     * 사용 환경 스탬프 — 어느 엔드포인트로 들어왔는지를 `users` 에 기록한다.
     * (UA 추측은 앱 사용자를 하나도 못 잡았다 — 네이티브 SDK 는 WebView 를 안 거친다.)
     */
    describe('사용 환경 스탬프', () => {
      beforeEach(() => {
        // 토큰 해시가 실제로 계산되므로 sign 반환값이 있어야 한다
        jwtService.sign.mockReturnValue('t');
      });

      it("platform='app' → first_app_login_at 을 최초 1회만 기록", async () => {
        dataSource.query.mockResolvedValue([] as never);
        await service.issueTokens(makeUser(), null, 'app');

        expect(dataSource.query).toHaveBeenCalledWith(
          expect.stringContaining('first_app_login_at'),
          expect.arrayContaining([expect.any(String)]),
        );
        // 덮어쓰기 방지 — 이미 값이 있으면 UPDATE 대상이 아니다
        expect(dataSource.query).toHaveBeenCalledWith(
          expect.stringContaining('IS NULL'),
          expect.anything(),
        );
      });

      it("platform='web' → first_web_login_at 을 기록", async () => {
        dataSource.query.mockResolvedValue([] as never);
        await service.issueTokens(makeUser(), null, 'web');
        expect(dataSource.query).toHaveBeenCalledWith(
          expect.stringContaining('first_web_login_at'),
          expect.anything(),
        );
      });

      /** reviewer-login 은 platform 을 안 넘긴다 — 심사용 계정이 통계를 오염시키면 안 된다 */
      it('platform 미지정이면 아무것도 기록하지 않는다', async () => {
        await service.issueTokens(makeUser(), null);
        expect(dataSource.query).not.toHaveBeenCalled();
      });

      /**
       * 🔴 **이 테스트가 이번 QA 에서 잡은 결함의 회귀 방어다.**
       *
       * 처음엔 스탬프를 **로그인 트랜잭션 안**에 넣었다. 그러면 이 UPDATE 하나가 실패할 때
       * **로그인 전체가 롤백돼 사용자가 못 들어온다.** 이건 운영 통계지 인증의 일부가 아니다.
       * (Postgres 는 트랜잭션 내 에러 후 후속 문장을 거부하므로 안에서 try/catch 해도 못 막는다.)
       */
      it('🔴 스탬프가 실패해도 로그인은 성공한다 (best-effort)', async () => {
        dataSource.query.mockRejectedValue(new Error('column does not exist'));
        jwtService.sign
          .mockReset()
          .mockReturnValueOnce('access-token')
          .mockReturnValueOnce('refresh-token');

        const result = await service.issueTokens(makeUser(), null, 'app');

        expect(result).toEqual({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        });
      });
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

    it('재로그인 → session_expired_notified_at 리셋', async () => {
      const user = makeUser();
      jwtService.sign.mockReturnValue('t');

      await service.issueTokens(user);

      expect(txUserRepo.update).toHaveBeenCalledWith(user.id, {
        sessionExpiredNotifiedAt: null,
      });
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

    it('② 이미 소비된 토큰 재사용 (창 30초 초과) → 세션 revoke + Discord critical + 401', async () => {
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({ used_at: new Date(Date.now() - 60_000) }), // 60초 전 소비 (창 30초 초과)
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

    /**
     * 🔴 **오탐과 진짜 탈취를 가르는 유일한 값** (2026-08-08 실사고 계기).
     *
     * 운영 앱에서 로그아웃이 반복돼 Discord `🚨 재사용 감지` 가 실제로 왔는데,
     * **알림에도 로그에도 "얼마나 묵은 토큰이었나" 가 없었다.** 6초 만에 온 것(= 창이 좁은 오탐)과
     * 6시간 만에 온 것(= 진짜 replay)이 **같은 알림으로 떠서 판정이 불가능했다.**
     *
     * 코드는 `ageMs` 를 **계산해 놓고 버리고 있었다.** 그래서 실어 보낸다.
     * 이 값이 빠지면 다시 판정 불가 상태로 돌아가므로 spec 으로 고정한다.
     */
    it('🔴 재사용 감지 알림에 경과 시간이 실린다 (오탐 판정의 유일한 근거)', async () => {
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({ used_at: new Date(Date.now() - 60_000) }), // 60초 전 소비 (창 30초 초과)
      ]);
      sessionRepo.query.mockResolvedValue([] as never);

      await expect(service.rotateTokens(base)).rejects.toThrow(
        UnauthorizedException,
      );

      const [payload] = discord.notify.mock.calls[0] as [
        { fields: Array<{ name: string; value: string }> },
      ];
      const elapsed = payload.fields.find((f) => f.name === '경과');
      expect(elapsed).toBeDefined();
      // 초 단위 + 비교 대상인 창 크기가 함께 보여야 알림만 보고 판단할 수 있다
      expect(elapsed?.value).toMatch(/60초/);
      expect(elapsed?.value).toMatch(/창 30초/);
    });

    /**
     * 🔴 **Discord 는 지나가면 끝이다.** 주석엔 audit 을 남긴다고 적혀 있었는데
     * 실제로는 기록하지 않고 있었다 — 그래서 "언제 몇 번 발동했나" 를 되짚을 수단이 없었다.
     */
    it('🔴 재사용 감지가 audit 에 남는다 (Discord 는 휘발된다)', async () => {
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({ used_at: new Date(Date.now() - 60_000) }),
      ]);
      sessionRepo.query.mockResolvedValue([] as never);

      await expect(service.rotateTokens(base)).rejects.toThrow(
        UnauthorizedException,
      );

      expect(audit.log).toHaveBeenCalledWith(
        null,
        'refresh_reuse_detected',
        'refresh_session',
        'sid-1',
        expect.objectContaining({
          userId: 'user-uuid-1',
          ageSec: 60,
          windowSeconds: 30,
        }),
      );
    });

    /**
     * 🔴 **창을 살짝 넘긴 건이 몰리면 오탐이다.** 집계 쿼리를 짜지 않고도 한눈에 보이게
     * 플래그로 남긴다 — 모바일은 네트워크 전환·백그라운드 정지·응답 유실 재시도가
     * 전부 창을 쉽게 넘긴다.
     */
    it('🔴 창을 조금 넘긴 건은 오탐 의심으로 표시된다', async () => {
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({ used_at: new Date(Date.now() - 60_000) }), // 60초 = 창의 2배
      ]);
      sessionRepo.query.mockResolvedValue([] as never);
      await expect(service.rotateTokens(base)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.log).toHaveBeenCalledWith(
        null,
        'refresh_reuse_detected',
        'refresh_session',
        'sid-1',
        expect.objectContaining({ suspectedFalsePositive: true }),
      );
    });

    it('🔴 한참 묵은 토큰은 오탐 의심이 아니다 (진짜 replay)', async () => {
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({ used_at: new Date(Date.now() - 6 * 3600_000) }), // 6시간 전
      ]);
      sessionRepo.query.mockResolvedValue([] as never);
      await expect(service.rotateTokens(base)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.log).toHaveBeenCalledWith(
        null,
        'refresh_reuse_detected',
        'refresh_session',
        'sid-1',
        expect.objectContaining({ suspectedFalsePositive: false }),
      );
    });

    it('④ 이미 소비된 토큰 재사용 (창 30초 이내) → 409 (RETRY) · revoke 아님', async () => {
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

    /**
     * 🔴 **이번 변경(5초 → 30초)의 핵심 동작.** 다른 케이스들(1초·60초·6시간)은
     * **창을 5초로 되돌려도 전부 통과한다** — 1초는 어느 창에서든 안이고 60초는 어느 창에서든 밖이다.
     * 즉 그 셋만으로는 **창이 실제로 넓어졌는지 검증되지 않는다.**
     *
     * 20초가 유일하게 두 창을 가른다: 옛 창(5초) → revoke · 새 창(30초) → 409.
     * 하이브리드 앱에서 화면 전환·백그라운드 복귀로 생기는 시차가 정확히 이 구간이라
     * **정상 사용자가 로그아웃되던 케이스**다 (ADR-071).
     */
    it('🔴 20초 — 옛 창(5초)이면 revoke, 새 창(30초)이면 409 (변경의 핵심)', async () => {
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({ used_at: new Date(Date.now() - 20_000) }),
      ]);

      await expect(service.rotateTokens(base)).rejects.toMatchObject({
        response: { code: 'RETRY' },
      });

      // 세션이 살아 있어야 한다 — revoke·알림·audit 어느 것도 발동하지 않는다
      expect(sessionRepo.query).not.toHaveBeenCalled();
      expect(discord.notify).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **audit 은 best-effort 다** — 기록 실패가 보안 조치를 막으면 안 된다.
     * `void ... .catch()` 로 방어돼 있는데 테스트가 없으면, 다음 사람이 `await` 로 바꿔도
     * 아무도 모른다. 그 순간 **audit DB 장애가 곧 로그인 세션 revoke 실패**가 된다.
     */
    it('🔴 audit 기록이 실패해도 revoke·401 은 정상 동작한다', async () => {
      audit.log.mockRejectedValueOnce(new Error('audit DB down'));
      tokenRepo.query.mockResolvedValueOnce([
        makeTokenRow({ used_at: new Date(Date.now() - 60_000) }),
      ]);
      sessionRepo.query.mockResolvedValue([] as never);

      await expect(service.rotateTokens(base)).rejects.toThrow(
        UnauthorizedException,
      );
      // 보안 조치는 그대로 수행
      expect(sessionRepo.query).toHaveBeenCalled();
      expect(discord.notify).toHaveBeenCalled();
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

  // ── rotateTokens — sid 없는 구 토큰 (재로그인 유도) ──────────
  describe('rotateTokens — sid 없는 구 토큰', () => {
    it('⑥ sid 없으면 세션 매핑 불가 → 401 (rotation·세션 생성 안 함)', async () => {
      const err = await service
        .rotateTokens({
          userId: 'user-uuid-1',
          role: 'user',
          sid: undefined,
          rawToken: 'legacy-rt',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      // DB 조회·변경·세션 생성 전부 없음 (조기 return)
      expect(tokenRepo.query).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
      expect(txSessionRepo.insert).not.toHaveBeenCalled();
      expect(txTokenRepo.insert).not.toHaveBeenCalled();
    });
  });

  // ── logout (해당 세션만 revoke) ─────────────────────────
  describe('logout', () => {
    it('rawToken 해시로 그 토큰이 속한 세션만 revoke (BOLA 스코프)', async () => {
      sessionRepo.query.mockResolvedValue([] as never);

      await service.logout('user-uuid-1', 'raw-rt');

      const [sql, params] = sessionRepo.query.mock.calls[0];
      expect(sql).toContain('UPDATE refresh_sessions SET revoked_at');
      expect(sql).toContain('user_id = $1');
      expect(sql).toContain('SELECT session_id FROM refresh_tokens');
      expect(params).toEqual(['user-uuid-1', sha256('raw-rt')]);
    });

    it('rawToken 없으면 세션 revoke 스킵 (아무 변경 없음)', async () => {
      await service.logout('user-uuid-1', null);

      expect(sessionRepo.query).not.toHaveBeenCalled();
      expect(userRepo.update).not.toHaveBeenCalled();
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

    it('유효 세션 0개 → false (user 조회 없이)', async () => {
      sessionRepo.count.mockResolvedValue(0);

      expect(await service.hasValidSession('user-uuid-1')).toBe(false);
      expect(userRepo.findOne).not.toHaveBeenCalled();
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
