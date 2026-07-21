import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
// jose 는 ESM 전용 · Jest 는 CommonJS · reviewer-seed→UsersService import 체인(→jose) 때문에 mock 필수
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  SignJWT: jest.fn(),
  importPKCS8: jest.fn(),
}));
import { QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/user.entity';
import { DiscordNotifier } from '../common/discord-notifier';
import {
  ReviewerAuthService,
  REVIEWER_KAKAO_ID,
} from './reviewer-auth.service';
import { ReviewerSeedService } from './reviewer-seed.service';

/**
 * ReviewerAuthService 단위 — App Review 리뷰어 로그인.
 *
 * 검증 축:
 *  - isEnabled: REVIEWER_EMAIL·REVIEWER_PASSWORD_HASH 둘 다 있어야 활성
 *  - login: 비활성(404) · 자격 불일치(401 단일 메시지) · 정상 find-or-create(멱등)
 *  - verifyCredentials: 이메일 대소문자·공백 무시 · bcrypt 대조 · 잘못된 hash → 실패로 흡수
 *  - find-or-create race: unique violation(23505) 흡수 · 그 외 에러 전파
 */
describe('ReviewerAuthService', () => {
  let service: ReviewerAuthService;
  let userRepo: jest.Mocked<Repository<User>>;
  let seedService: { seedReviewerData: jest.Mock };

  const REVIEWER_EMAIL = 'reviewer@chwippo.com';
  const PASSWORD = 'correct-horse-battery';
  const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 10);

  // config store — 테스트별로 세팅/해제 (get 이 이 store 조회)
  const configStore: Record<string, string | undefined> = {};

  function makeReviewerUser(overrides: Partial<User> = {}): User {
    return {
      id: 'u-reviewer',
      kakaoId: REVIEWER_KAKAO_ID,
      nickname: 'App Reviewer',
      email: null,
      role: 'user',
      ...overrides,
    } as User;
  }

  beforeEach(async () => {
    for (const k of Object.keys(configStore)) delete configStore[k];
    configStore.REVIEWER_EMAIL = REVIEWER_EMAIL;
    configStore.REVIEWER_PASSWORD_HASH = PASSWORD_HASH;

    const mockRepo = mock<Repository<User>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewerAuthService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
        {
          provide: DiscordNotifier,
          useValue: { notify: jest.fn().mockResolvedValue('sent') },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => configStore[key]),
          },
        },
        {
          provide: ReviewerSeedService,
          useValue: {
            seedReviewerData: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(ReviewerAuthService);
    userRepo = module.get(getRepositoryToken(User));
    seedService = module.get(ReviewerSeedService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── isEnabled ──────────────────────────────────────────
  describe('isEnabled', () => {
    it('email·hash 둘 다 설정 → true', () => {
      expect(service.isEnabled()).toBe(true);
    });

    it('email 미설정 → false', () => {
      configStore.REVIEWER_EMAIL = '';
      expect(service.isEnabled()).toBe(false);
    });

    it('hash 미설정 → false', () => {
      configStore.REVIEWER_PASSWORD_HASH = undefined;
      expect(service.isEnabled()).toBe(false);
    });

    it('둘 다 미설정 → false', () => {
      configStore.REVIEWER_EMAIL = '';
      configStore.REVIEWER_PASSWORD_HASH = '';
      expect(service.isEnabled()).toBe(false);
    });
  });

  // ─── login ──────────────────────────────────────────────
  describe('login', () => {
    it('비활성(env 미설정) → NotFoundException · 자격 검증·DB 조회 안 함', async () => {
      configStore.REVIEWER_EMAIL = '';
      configStore.REVIEWER_PASSWORD_HASH = '';

      await expect(service.login(REVIEWER_EMAIL, PASSWORD)).rejects.toThrow(
        NotFoundException,
      );
      expect(userRepo.findOne).not.toHaveBeenCalled();
    });

    it('비밀번호 불일치 → UnauthorizedException · DB 조회 안 함', async () => {
      await expect(
        service.login(REVIEWER_EMAIL, 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);
      expect(userRepo.findOne).not.toHaveBeenCalled();
    });

    it('이메일 불일치 → UnauthorizedException (비번 맞아도)', async () => {
      await expect(
        service.login('someone-else@chwippo.com', PASSWORD),
      ).rejects.toThrow(UnauthorizedException);
      expect(userRepo.findOne).not.toHaveBeenCalled();
    });

    it('실패 메시지는 이메일/비번 구분 안 함 (동일 단일 메시지)', async () => {
      const byEmail = await service
        .login('nope@chwippo.com', PASSWORD)
        .catch((e: Error) => e.message);
      const byPassword = await service
        .login(REVIEWER_EMAIL, 'nope')
        .catch((e: Error) => e.message);
      expect(byEmail).toBe(byPassword);
    });

    it('정상 · 기존 계정 있음 → 그 계정 반환 (isNew=false, 멱등)', async () => {
      const existing = makeReviewerUser({ id: 'u-existing' });
      userRepo.findOne.mockResolvedValue(existing);

      const result = await service.login(REVIEWER_EMAIL, PASSWORD);

      expect(result.isNew).toBe(false);
      expect(result.user.id).toBe('u-existing');
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { kakaoId: REVIEWER_KAKAO_ID },
      });
      expect(userRepo.save).not.toHaveBeenCalled();
      // found 경로 → 절대 재시딩 안 함 (기존 데이터 이중 생성 방지)
      expect(seedService.seedReviewerData).not.toHaveBeenCalled();
    });

    it('정상 · 계정 없음 → 생성 (isNew=true) · sentinel kakaoId · role=user', async () => {
      userRepo.findOne.mockResolvedValue(null);
      const created = makeReviewerUser({ id: 'u-new' });
      userRepo.create.mockReturnValue(created);
      userRepo.save.mockResolvedValue(created);

      const result = await service.login(REVIEWER_EMAIL, PASSWORD);

      expect(result.isNew).toBe(true);
      expect(userRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kakaoId: REVIEWER_KAKAO_ID,
          nickname: 'App Reviewer',
        }),
      );
      // role 을 명시적으로 admin 등으로 올리지 않음
      const createArg = userRepo.create.mock.calls[0][0] as Partial<User>;
      expect(createArg.role).toBeUndefined();
      // create 경로 → 신규 user id 로 자동 시딩 호출
      expect(seedService.seedReviewerData).toHaveBeenCalledWith('u-new');
    });

    it('create race (23505 → 기존 계정) → 재시딩 안 함 (found 로 귀결)', async () => {
      const raced = makeReviewerUser({ id: 'u-raced' });
      userRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(raced);
      userRepo.create.mockReturnValue(makeReviewerUser());
      const uniqueErr = new QueryFailedError('', [], new Error('duplicate'));
      (uniqueErr as unknown as { driverError: { code: string } }).driverError =
        { code: '23505' };
      userRepo.save.mockRejectedValue(uniqueErr);

      const result = await service.login(REVIEWER_EMAIL, PASSWORD);

      expect(result.isNew).toBe(false);
      expect(seedService.seedReviewerData).not.toHaveBeenCalled();
    });

    it('이메일 대소문자·앞뒤 공백 무시 → 정상 인증', async () => {
      userRepo.findOne.mockResolvedValue(makeReviewerUser());

      const result = await service.login(
        `  ${REVIEWER_EMAIL.toUpperCase()}  `,
        PASSWORD,
      );

      expect(result.user.kakaoId).toBe(REVIEWER_KAKAO_ID);
    });

    it('잘못된 hash 포맷 → throw 아님 · 인증 실패(401)', async () => {
      configStore.REVIEWER_PASSWORD_HASH = 'not-a-bcrypt-hash';

      await expect(service.login(REVIEWER_EMAIL, PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('생성 race (unique violation 23505) → 재조회로 기존 계정 반환 (isNew=false)', async () => {
      const raced = makeReviewerUser({ id: 'u-raced' });
      userRepo.findOne
        .mockResolvedValueOnce(null) // 최초 조회: 없음
        .mockResolvedValueOnce(raced); // race 후 재조회: 있음
      userRepo.create.mockReturnValue(makeReviewerUser());
      const uniqueErr = new QueryFailedError('', [], new Error('duplicate'));
      (uniqueErr as unknown as { driverError: { code: string } }).driverError =
        { code: '23505' };
      userRepo.save.mockRejectedValue(uniqueErr);

      const result = await service.login(REVIEWER_EMAIL, PASSWORD);

      expect(result.isNew).toBe(false);
      expect(result.user.id).toBe('u-raced');
    });

    it('생성 중 unique 외 에러 → 그대로 전파', async () => {
      userRepo.findOne.mockResolvedValue(null);
      userRepo.create.mockReturnValue(makeReviewerUser());
      const otherErr = new QueryFailedError('', [], new Error('fk violation'));
      (otherErr as unknown as { driverError: { code: string } }).driverError = {
        code: '23502',
      };
      userRepo.save.mockRejectedValue(otherErr);

      await expect(service.login(REVIEWER_EMAIL, PASSWORD)).rejects.toBe(
        otherErr,
      );
    });
  });
});
