import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { User } from './user.entity';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { UsersService } from './users.service';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { FilesService } from '../files/files.service';
import { IdentityProviderService } from '../auth/identity-provider.service';
import type { SignupAnswerDto } from './dto/signup-answer.dto';
import { UpdateJobProfileDto } from './dto/update-job-profile.dto';
import type { JobCategory } from './signup-job-categories.const';
import { DiscordNotifier } from '../common/discord-notifier';
import { UserDeletionLog } from './user-deletion-log.entity';

// jose(ESM)는 jest(CJS) 런타임에서 로드 불가 — import 체인(IdentityProviderService →
// AppleTokenService)이 jose 에 닿으므로 mock 필수.
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  SignJWT: jest.fn(),
  importPKCS8: jest.fn(),
}));

describe('UsersService', () => {
  let service: UsersService;
  let userRepo: jest.Mocked<Repository<User>>;
  let storageUsage: jest.Mocked<StorageUsageService>;
  let filesService: jest.Mocked<FilesService>;
  let identityProvider: jest.Mocked<IdentityProviderService>;
  let dataSource: jest.Mocked<DataSource>;
  let manager: jest.Mocked<EntityManager>;

  /**
   * 온보딩 답변 UPDATE 의 **criteria 가 곧 가드**다 — 「아직 답변하지 않은 행」만 잡는다.
   * id 만으로 잡으면 중복 제출이 두 번 다 통과해 카드가 두 벌 생긴다.
   */
  const unclaimed = { id: 'user-uuid-1', signupJobCategories: IsNull() };

  const makeUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-uuid-1',
      kakaoId: 'kakao-123',
      appleSub: null,
      appleEmail: null,
      nickname: '테스트유저',
      email: null,
      role: 'user',
      lastActiveAt: null,
      createdAt: new Date(),
      ...overrides,
    }) as User;

  beforeEach(async () => {
    const mockRepo = mock<Repository<User>>();
    const mockStorage = mock<StorageUsageService>();
    const mockFiles = mock<FilesService>();
    const mockIdp = mock<IdentityProviderService>();
    mockStorage.collectAllFileUrls.mockResolvedValue([]);
    mockIdp.unlinkKakao.mockResolvedValue(true);
    mockIdp.revokeApple.mockResolvedValue(false);

    manager = mock<EntityManager>();
    manager.create.mockImplementation(
      (_target: unknown, input: unknown) => ({ ...(input as object) }) as never,
    );
    manager.save.mockImplementation(
      async (_target: unknown, input: unknown) => ({
        ...(input as object),
        id: 'app-' + Math.random().toString(36).slice(2, 8),
      }),
    );
    manager.update.mockResolvedValue({ affected: 1 } as never);

    dataSource = mock<DataSource>();
    dataSource.transaction.mockImplementation((cb: any) => cb(manager));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: DiscordNotifier,
          useValue: { notify: jest.fn().mockResolvedValue('sent') },
        },
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockRepo },
        {
          provide: getRepositoryToken(UserDeletionLog),
          useValue: { insert: jest.fn().mockResolvedValue({}) },
        },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: StorageUsageService, useValue: mockStorage },
        { provide: FilesService, useValue: mockFiles },
        { provide: IdentityProviderService, useValue: mockIdp },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    userRepo = module.get(getRepositoryToken(User));
    storageUsage = module.get(StorageUsageService);
    filesService = module.get(FilesService);
    identityProvider = module.get(IdentityProviderService);
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

  // ── updateJobProfile ───────────────────────────────────
  /**
   * 시나리오 (`plans/job-role-first.md` 묶음 3):
   *  1. 직무만 → 그 컬럼만 UPDATE 에 실린다 (계열 키는 아예 안 들어간다)
   *  2. 계열만 → 반대
   *  3. 🔴 **hostile 객체** — 안 보낸 필드가 own `undefined` 프로퍼티로 실재하는
   *     ValidationPipe 인스턴스를 그대로 재현한다. `{...dto}` merge 였다면 여기서 죽는다
   *  4. 빈 문자열·공백만 → null
   *  5. 명시적 null → null
   *  6. 둘 다 미전송 → 400 (읽기조차 안 한다)
   *  7. 사용자 없음 → 404 (UPDATE 안 함)
   */
  describe('updateJobProfile', () => {
    /** ValidationPipe(transform) 산출물 흉내 — 안 보낸 필드도 own 프로퍼티로 존재한다 */
    const asPipeOutput = (dto: Partial<UpdateJobProfileDto>) =>
      Object.assign(
        Object.create(UpdateJobProfileDto.prototype) as UpdateJobProfileDto,
        { jobTitle: undefined, seriesId: undefined },
        dto,
      );

    beforeEach(() => {
      userRepo.findOneBy.mockResolvedValue(makeUser());
      userRepo.update.mockResolvedValue({ affected: 1 } as never);
    });

    it('jobTitle 만 보내면 그 컬럼만 UPDATE 에 실린다', async () => {
      await service.updateJobProfile('user-uuid-1', {
        jobTitle: '백엔드 개발자',
      });

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        signupJobTitle: '백엔드 개발자',
      });
    });

    it('seriesId 만 보내면 그 컬럼만 UPDATE 에 실린다', async () => {
      await service.updateJobProfile('user-uuid-1', { seriesId: 'it' });

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        signupSeriesId: 'it',
      });
    });

    it('🔴 안 보낸 필드가 own undefined 프로퍼티여도 그 컬럼은 안 건드린다', async () => {
      // `'seriesId' in dto` 는 true 지만 보낸 적은 없다 — 값으로만 판정해야 한다
      const dto = asPipeOutput({ jobTitle: '간호사' });
      expect('seriesId' in dto).toBe(true);

      await service.updateJobProfile('user-uuid-1', dto);

      const patch = userRepo.update.mock.calls[0][1];
      expect(patch).toEqual({ signupJobTitle: '간호사' });
      expect('signupSeriesId' in patch).toBe(false);
    });

    it.each([
      ['빈 문자열', ''],
      ['공백만', '   '],
      ['명시적 null', null],
    ])('jobTitle %s → null 저장', async (_label, value) => {
      await service.updateJobProfile('user-uuid-1', { jobTitle: value });

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        signupJobTitle: null,
      });
    });

    it('seriesId null → 계열 풀기', async () => {
      await service.updateJobProfile('user-uuid-1', { seriesId: null });

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        signupSeriesId: null,
      });
    });

    it('둘 다 미전송 → BadRequest (조회조차 안 한다)', async () => {
      await expect(
        service.updateJobProfile('user-uuid-1', asPipeOutput({})),
      ).rejects.toThrow(new BadRequestException('바꿀 값이 없어요.'));

      expect(userRepo.findOneBy).not.toHaveBeenCalled();
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 userId → NotFoundException (UPDATE 안 함)', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.updateJobProfile('nonexistent', { jobTitle: '간호사' }),
      ).rejects.toThrow(new NotFoundException('사용자를 찾을 수 없습니다.'));

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('온보딩 미완료(onboardedAt null) 사용자도 허용한다', async () => {
      userRepo.findOneBy.mockResolvedValue(makeUser({ onboardedAt: null }));

      await service.updateJobProfile('user-uuid-1', {
        jobTitle: '지상직',
        seriesId: 'sales',
      });

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        signupJobTitle: '지상직',
        signupSeriesId: 'sales',
      });
    });
  });

  /**
   * 앱 소개 투어 진행 기록 (`plans/app-tour.md`).
   *
   * ## 시나리오 (먼저 나열하고 코드를 짰다)
   *  1. 첫 기록 → `tourSeenAt` = now · `tourLastStep` = 보낸 값
   *  2. 🔴 **`tourSeenAt` 은 이미 있으면 유지** — 덮어쓰면 「언제 처음 만났나」가 사라진다
   *  3. `completed:false` → `tourCompletedAt` 을 아예 안 쓴다 (건너뛰기)
   *  4. `completed:true` 첫 완료 → `tourCompletedAt` = now
   *  5. 🔴 **두 번째 완료가 첫 완료를 덮지 않는다** — 깔때기가 뒤로 가면 안 된다
   *  6. `tourLastStep` 은 **최신값**이다 (seenAt 과 반대 규칙)
   *  7. 사용자 없음 → 404 (UPDATE 안 함)
   */
  describe('recordTour', () => {
    beforeEach(() => {
      userRepo.update.mockResolvedValue({ affected: 1 } as never);
    });

    it('첫 기록 → seenAt·lastStep 이 실린다 (completedAt 은 없다)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ tourSeenAt: null, tourCompletedAt: null }),
      );

      await service.recordTour('user-uuid-1', {
        lastStep: 3,
        completed: false,
      });

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        tourSeenAt: expect.any(Date) as Date,
        tourLastStep: 3,
      });
      const patch = userRepo.update.mock.calls[0][1] as Partial<User>;
      expect('tourCompletedAt' in patch).toBe(false);
    });

    it('🔴 seenAt 은 첫 기록만 유지한다 (재호출이 덮지 않는다)', async () => {
      const first = new Date('2026-08-01T00:00:00Z');
      userRepo.findOneBy.mockResolvedValue(makeUser({ tourSeenAt: first }));

      await service.recordTour('user-uuid-1', { lastStep: 7, completed: true });

      const patch = userRepo.update.mock.calls[0][1] as Partial<User>;
      expect(patch.tourSeenAt).toBe(first);
    });

    it('completed:true → completedAt 이 처음으로 찍힌다', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ tourSeenAt: null, tourCompletedAt: null }),
      );

      await service.recordTour('user-uuid-1', { lastStep: 7, completed: true });

      const patch = userRepo.update.mock.calls[0][1] as Partial<User>;
      expect(patch.tourCompletedAt).toBeInstanceOf(Date);
      expect(patch.tourLastStep).toBe(7);
    });

    it('🔴 completedAt 은 한 번만 — 두 번째 완료가 첫 완료를 덮지 않는다', async () => {
      const done = new Date('2026-08-02T00:00:00Z');
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ tourSeenAt: done, tourCompletedAt: done }),
      );

      await service.recordTour('user-uuid-1', { lastStep: 7, completed: true });

      const patch = userRepo.update.mock.calls[0][1] as Partial<User>;
      expect(patch.tourCompletedAt).toBe(done);
    });

    it('lastStep 은 최신값으로 갱신된다 (seenAt 과 반대 규칙)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ tourSeenAt: new Date('2026-08-01'), tourLastStep: 2 }),
      );

      await service.recordTour('user-uuid-1', {
        lastStep: 5,
        completed: false,
      });

      const patch = userRepo.update.mock.calls[0][1] as Partial<User>;
      expect(patch.tourLastStep).toBe(5);
    });

    it('존재하지 않는 userId → NotFoundException (UPDATE 안 함)', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.recordTour('nonexistent', { lastStep: 1, completed: false }),
      ).rejects.toThrow(new NotFoundException('사용자를 찾을 수 없습니다.'));

      expect(userRepo.update).not.toHaveBeenCalled();
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

    // ── Apple Guideline 5.1.1(v) · 카카오 개인정보 처리방침 ──
    it('kakaoId 있는 유저 → Kakao unlink 호출 (Apple 5.1.1(v))', async () => {
      const user = makeUser({ kakaoId: 'kakao-999', appleSub: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);

      await service.deleteAccount('user-uuid-1');

      expect(identityProvider.unlinkKakao).toHaveBeenCalledWith('kakao-999');
      expect(identityProvider.revokeApple).not.toHaveBeenCalled();
    });

    it('appleSub 있는 유저 (kakaoId=null) → Apple revoke 호출(refresh_token 전달) · Kakao 미호출', async () => {
      const user = makeUser({
        kakaoId: null,
        appleSub: 'apple-sub-abc',
        appleRefreshToken: 'apple-rt-abc',
      });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);

      await service.deleteAccount('user-uuid-1');

      // revokeApple(appleRefreshToken, appleSub) — 저장된 refresh_token 원문 전달
      expect(identityProvider.revokeApple).toHaveBeenCalledWith(
        'apple-rt-abc',
        'apple-sub-abc',
      );
      expect(identityProvider.unlinkKakao).not.toHaveBeenCalled();
    });

    it('kakaoId + appleSub 둘 다 있음 (계정 병합 미래 대비) → 양쪽 모두 호출', async () => {
      const user = makeUser({
        kakaoId: 'kakao-1',
        appleSub: 'apple-1',
        appleRefreshToken: 'apple-rt-1',
      });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);

      await service.deleteAccount('user-uuid-1');

      expect(identityProvider.unlinkKakao).toHaveBeenCalledWith('kakao-1');
      expect(identityProvider.revokeApple).toHaveBeenCalledWith(
        'apple-rt-1',
        'apple-1',
      );
    });

    it('Kakao unlink 실패 (false 반환) → 로컬 삭제 계속 진행 (best-effort)', async () => {
      const user = makeUser({ kakaoId: 'kakao-fail', appleSub: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);
      identityProvider.unlinkKakao.mockResolvedValueOnce(false);

      await expect(
        service.deleteAccount('user-uuid-1'),
      ).resolves.toBeUndefined();
      expect(userRepo.remove).toHaveBeenCalledWith(user);
    });

    it('unlink 순서 → remove 이전 (DB 삭제 후엔 kakaoId 조회 불가)', async () => {
      const user = makeUser({ kakaoId: 'kakao-order', appleSub: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);

      await service.deleteAccount('user-uuid-1');

      const unlinkOrder = (identityProvider.unlinkKakao as jest.Mock).mock
        .invocationCallOrder[0];
      const removeOrder = (userRepo.remove as jest.Mock).mock
        .invocationCallOrder[0];
      expect(unlinkOrder).toBeLessThan(removeOrder);
    });

    it('kakaoId · appleSub 둘 다 null (극단 케이스) → unlink/revoke 미호출', async () => {
      const user = makeUser({ kakaoId: null, appleSub: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.remove.mockResolvedValue(user);

      await service.deleteAccount('user-uuid-1');

      expect(identityProvider.unlinkKakao).not.toHaveBeenCalled();
      expect(identityProvider.revokeApple).not.toHaveBeenCalled();
      expect(userRepo.remove).toHaveBeenCalled();
    });
  });

  // ── getDashboardConfig (LRR P2T1 PR O H-4) ────────────
  describe('getDashboardConfig', () => {
    it('DB dashboardConfig null → 회고=성장 DEFAULT_SECTIONS 반환 (stats · milestones · monthly_comparison · insights · streak · doughnut · funnel · interview_review)', async () => {
      const user = makeUser({ dashboardConfig: null });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');

      expect(userRepo.findOneBy).toHaveBeenCalledWith({ id: 'user-uuid-1' });
      expect(result.sections).toEqual([
        { id: 'stats', visible: true },
        { id: 'milestones', visible: true },
        { id: 'monthly_comparison', visible: true },
        { id: 'insights', visible: true },
        { id: 'activity_streak', visible: true },
        { id: 'status_doughnut', visible: true },
        { id: 'personal_funnel', visible: true },
        { id: 'interview_review', visible: true },
      ]);
    });

    it('lazy merge — 기존 config 에 신규 성장 섹션 (milestones·monthly·insights·funnel) 자동 append', async () => {
      const custom = {
        sections: [
          { id: 'stats', visible: true },
          { id: 'activity_streak', visible: true },
          { id: 'status_doughnut', visible: true },
        ],
      };
      const user = makeUser({ dashboardConfig: custom });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');
      expect(result.sections).toEqual([
        { id: 'stats', visible: true },
        { id: 'activity_streak', visible: true },
        { id: 'status_doughnut', visible: true },
        // lazy merge — DEFAULT_SECTIONS 순서로 append (milestones · monthly · insights · funnel · interview_review)
        { id: 'milestones', visible: true },
        { id: 'monthly_comparison', visible: true },
        { id: 'insights', visible: true },
        { id: 'personal_funnel', visible: true },
        { id: 'interview_review', visible: true },
      ]);
    });

    it('deprecated 섹션 자동 필터링 — 캘린더 이관 5개 (dday·todos·today_schedule·top_applications·calendar_mini) + 성장 재정의 제거 2개 (cover_letter_quick·goals)', async () => {
      const custom = {
        sections: [
          { id: 'stats', visible: true },
          { id: 'dday', visible: true }, // 필터 (캘린더 이관)
          { id: 'activity_streak', visible: true },
          { id: 'todos', visible: false }, // 필터
          { id: 'status_doughnut', visible: true },
          { id: 'today_schedule', visible: true }, // 필터
          { id: 'top_applications', visible: true }, // 필터
          { id: 'calendar_mini', visible: true }, // 필터
          { id: 'cover_letter_quick', visible: true }, // 필터 (성장 재정의)
          { id: 'goals', visible: true }, // 필터 (성장 재정의)
          { id: 'interview_review', visible: true },
        ],
      };
      const user = makeUser({ dashboardConfig: custom });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');
      expect(result.sections.map((s) => s.id)).toEqual([
        'stats',
        'activity_streak',
        'status_doughnut',
        'interview_review',
        // lazy merge 신규 섹션 (DEFAULT 순서)
        'milestones',
        'monthly_comparison',
        'insights',
        'personal_funnel',
      ]);
    });

    it('기존 config 에 성장 섹션 이미 있음 → 그대로 반환 (중복 append X)', async () => {
      const custom = {
        sections: [
          { id: 'stats', visible: true },
          { id: 'milestones', visible: true },
          { id: 'monthly_comparison', visible: true },
          { id: 'insights', visible: false }, // 사용자가 toggle off
          { id: 'activity_streak', visible: false },
          { id: 'status_doughnut', visible: true },
          { id: 'personal_funnel', visible: false },
          { id: 'interview_review', visible: true },
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

    it('orphan section ID 포함된 옛 DB row → 보존 (필터는 PATCH/프론트) + 성장 lazy merge append', async () => {
      const orphan = {
        sections: [
          { id: 'stats', visible: true },
          { id: 'myinfo_progress', visible: true }, // ← deprecated 아닌 orphan (사용자 결정 존중)
        ],
      };
      const user = makeUser({ dashboardConfig: orphan });
      userRepo.findOneBy.mockResolvedValue(user);

      const result = await service.getDashboardConfig('user-uuid-1');
      // lazy merge 순서 = DEFAULT_SECTIONS 순서 (existing 뒤에 append)
      expect(result.sections).toEqual([
        { id: 'stats', visible: true },
        { id: 'myinfo_progress', visible: true },
        { id: 'milestones', visible: true },
        { id: 'monthly_comparison', visible: true },
        { id: 'insights', visible: true },
        { id: 'activity_streak', visible: true },
        { id: 'status_doughnut', visible: true },
        { id: 'personal_funnel', visible: true },
        { id: 'interview_review', visible: true },
      ]);
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

  // ── agreeAiConsent (Phase 5 — AI 사용 동의, PIPA 26조) ────
  describe('agreeAiConsent', () => {
    it('정상: 현재 버전으로 동의 → aiConsentAt + aiConsentVersion 갱신', async () => {
      const user = makeUser({ aiConsentAt: null, aiConsentVersion: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);
      await service.agreeAiConsent('user-uuid-1', 'v1');
      expect(userRepo.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({
          aiConsentAt: expect.any(Date),
          aiConsentVersion: 'v1',
        }),
      );
    });

    it('멱등: 이미 동의된 user 재호출 — timestamp 갱신', async () => {
      const user = makeUser({
        aiConsentAt: new Date('2025-01-01'),
        aiConsentVersion: 'v1',
      });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);
      await service.agreeAiConsent('user-uuid-1', 'v1');
      expect(userRepo.update).toHaveBeenCalled();
    });

    it('wrong version → BadRequestException', async () => {
      await expect(
        service.agreeAiConsent('user-uuid-1', 'v999'),
      ).rejects.toThrow(BadRequestException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('없는 user → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.agreeAiConsent('user-unknown', 'v1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── withdrawAiConsent (Phase 5 — PIPA 26조 동등 보장) ────
  describe('withdrawAiConsent', () => {
    it('정상 철회 — aiConsentAt + aiConsentVersion 둘 다 NULL', async () => {
      const user = makeUser({
        aiConsentAt: new Date('2025-01-01'),
        aiConsentVersion: 'v1',
      });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);
      await service.withdrawAiConsent('user-uuid-1');
      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        aiConsentAt: null,
        aiConsentVersion: null,
      });
    });

    it('멱등: 이미 철회된 user 재호출 OK (예외 X)', async () => {
      const user = makeUser({ aiConsentAt: null, aiConsentVersion: null });
      userRepo.findOneBy.mockResolvedValue(user);
      userRepo.update.mockResolvedValue({} as any);
      await expect(
        service.withdrawAiConsent('user-uuid-1'),
      ).resolves.toBeUndefined();
    });

    it('없는 user → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);
      await expect(service.withdrawAiConsent('user-unknown')).rejects.toThrow(
        NotFoundException,
      );
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

  // ── W1: signupAnswer + dismissAllSampleCards ─────────────
  // signup 1 질문 (관심 직군) 답변 → 가상 회사 샘플 카드 자동 생성 + 보드 dismiss.

  describe('signupAnswer (W1)', () => {
    const cat = (c: string): JobCategory => c as JobCategory;

    const makeDto = (
      overrides: Partial<SignupAnswerDto> = {},
    ): SignupAnswerDto => ({
      jobCategories: [cat('백엔드 개발')],
      ...overrides,
    });

    function mockSavedAppId() {
      // manager.save 가 sample 카드별 unique id 반환하도록 (step insert 시 applicationId)
      let counter = 0;
      manager.save.mockImplementation(async (_t: unknown, input: unknown) => ({
        ...(input as object),
        id: `app-${++counter}`,
      }));
    }

    it('정상 1개 직군 → users.update + 카드 1개 generate + 4 step', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', makeDto());

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // User update — signupJobCategories + onboardedAt set
      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({
          signupJobCategories: ['백엔드 개발'],
          signupOtherText: null,
          onboardedAt: expect.any(Date),
        }),
      );
      // 카드 1개 (Application) + 4 step (ApplicationStep) save
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      const stepSaves = manager.save.mock.calls.filter(
        (c) => c[0] === ApplicationStep,
      );
      expect(appSaves).toHaveLength(1);
      expect(stepSaves).toHaveLength(4);
      // Application — isSample true + currentStepIndex 0 + jobCategory 박제 + companyName
      expect(appSaves[0][1]).toMatchObject({
        userId: 'user-uuid-1',
        companyName: 'Cloud Tech 백엔드',
        jobCategory: '백엔드 개발',
        status: 'IN_PROGRESS',
        isSample: true,
        currentStepIndex: 0,
      });
    });

    it('정상 3개 직군 → 카드 3개 generate (각 직군 매칭)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({
          jobCategories: [
            cat('백엔드 개발'),
            cat('UI/UX·프로덕트 디자이너'),
            cat('마케팅·광고'),
          ],
        }),
      );

      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(3);
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Cloud Tech 백엔드',
        currentStepIndex: 0,
      });
      expect(appSaves[1][1]).toMatchObject({
        companyName: 'Sunset Design UI/UX',
        currentStepIndex: 1,
      });
      expect(appSaves[2][1]).toMatchObject({
        companyName: 'Blue Marketing 퍼포먼스',
        currentStepIndex: 2,
      });
    });

    it('4개 직군 → 첫 3개만 카드 생성 (max 3)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({
          jobCategories: [
            cat('백엔드 개발'),
            cat('프론트엔드 개발'),
            cat('모바일 앱 개발'),
            cat('데이터·AI'),
          ],
        }),
      );

      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(3);
    });

    it('21개 직군 → 첫 3개만 카드 생성', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      const all21: JobCategory[] = [
        '백엔드 개발',
        '프론트엔드 개발',
        '모바일 앱 개발',
        '데이터·AI',
        'DevOps·인프라·보안',
        'UI/UX·프로덕트 디자이너',
        '그래픽·브랜드 디자이너',
        '서비스 기획·PM',
        '콘텐츠·에디터·PR',
        '마케팅·광고',
        '영업·세일즈',
        '고객서비스·CS·CX',
        '인사·HR·노무',
        '재무·회계·세무',
        '법무·CPA·컴플라이언스',
        '경영기획·전략·컨설팅',
        '금융·은행·증권·보험',
        'R&D·연구개발',
        '의료·제약·바이오',
        '제조·생산·품질·SCM',
        '기타',
      ].map((c) => cat(c));

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: all21 }),
      );

      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(3);
    });

    it('빈 array (건너뛰기) → 카드 0개 + signupJobCategories=[] 저장 + onboardedAt set', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );

      await service.signupAnswer('user-uuid-1', makeDto({ jobCategories: [] }));

      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({
          signupJobCategories: [],
          signupOtherText: null,
          onboardedAt: expect.any(Date),
        }),
      );
      // 카드·step 둘 다 0개
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(0);
    });

    it('"기타" + otherText="게임 기획" → "Sample Corp 게임 기획" 카드 + signupOtherText 저장', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: [cat('기타')], otherText: '게임 기획' }),
      );

      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({ signupOtherText: '게임 기획' }),
      );
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Sample Corp 게임 기획',
        jobCategory: '게임 기획',
      });
    });

    it('"기타" + otherText 빈 string → "Sample Corp 신입" generic + signupOtherText=null', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: [cat('기타')], otherText: '' }),
      );

      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({ signupOtherText: null }),
      );
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Sample Corp 신입',
        jobCategory: '기타',
      });
    });

    it('"기타" + otherText 공백만 → trim 후 빈 string → generic', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: [cat('기타')], otherText: '   ' }),
      );

      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({ signupOtherText: null }),
      );
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Sample Corp 신입',
      });
    });

    it('"기타" 미선택 + otherText 있음 → 400 BadRequest', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );

      await expect(
        service.signupAnswer(
          'user-uuid-1',
          makeDto({ jobCategories: [cat('백엔드 개발')], otherText: '셰프' }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    /**
     * 🔴 판정 주체가 바뀌었다 — 「미리 읽어 본 값」이 아니라 **UPDATE 가 잡은 행 수**다.
     * 그래서 이 두 테스트는 `findOneBy` 가 아니라 `affected` 로 상황을 만든다
     * (읽기 시점의 값은 판정에 쓰이지 않으므로, 그걸로 세우면 테스트가 거짓 통과한다).
     */
    it('이미 답변한 user (UPDATE 0행) → 400', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: ['백엔드 개발'] }),
      );
      manager.update.mockResolvedValue({ affected: 0 } as never);

      await expect(
        service.signupAnswer('user-uuid-1', makeDto()),
      ).rejects.toThrow(new BadRequestException('이미 답변하셨어요.'));
    });

    it('🔴 이미 답변한 user → 샘플 카드를 만들지 않는다 (400 이 저장보다 먼저)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: [] }),
      );
      manager.update.mockResolvedValue({ affected: 0 } as never);

      await expect(
        service.signupAnswer('user-uuid-1', makeDto()),
      ).rejects.toThrow(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('존재하지 않는 user → 404 NotFound', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.signupAnswer('nonexistent', makeDto()),
      ).rejects.toThrow(NotFoundException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('"기타" + otherText 미전송 (undefined) → generic, signupOtherText=null', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({ jobCategories: [cat('기타')] }), // otherText 없음
      );

      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({ signupOtherText: null }),
      );
      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves[0][1]).toMatchObject({ companyName: 'Sample Corp 신입' });
    });

    it('백엔드 + 기타(셰프) hybrid → 카드 2개 (Cloud Tech 백엔드 + Sample Corp 셰프)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({
          jobCategories: [cat('백엔드 개발'), cat('기타')],
          otherText: '셰프',
        }),
      );

      const appSaves = manager.save.mock.calls.filter(
        (c) => c[0] === Application,
      );
      expect(appSaves).toHaveLength(2);
      expect(appSaves[0][1]).toMatchObject({
        companyName: 'Cloud Tech 백엔드',
        jobCategory: '백엔드 개발',
        currentStepIndex: 0,
      });
      expect(appSaves[1][1]).toMatchObject({
        companyName: 'Sample Corp 셰프',
        jobCategory: '셰프',
        currentStepIndex: 1,
      });
    });

    it('카드 deadline 분산 — 카드별 첫 step 의 scheduledDate 가 today +7/+14/+21', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );
      mockSavedAppId();

      await service.signupAnswer(
        'user-uuid-1',
        makeDto({
          jobCategories: [
            cat('백엔드 개발'),
            cat('UI/UX·프로덕트 디자이너'),
            cat('마케팅·광고'),
          ],
        }),
      );

      // 각 카드별 첫 step (orderIndex 0) 의 scheduledDate 확인
      const firstSteps = manager.save.mock.calls
        .filter((c) => c[0] === ApplicationStep)
        .filter((c) => (c[1] as { orderIndex: number }).orderIndex === 0);
      expect(firstSteps).toHaveLength(3);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (let i = 0; i < 3; i++) {
        const sched = (firstSteps[i][1] as { scheduledDate: Date })
          .scheduledDate;
        const expectedDays = (i + 1) * 7;
        const actualDays = Math.round(
          (sched.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
        );
        expect(actualDays).toBe(expectedDays);
      }
    });
  });

  /**
   * 계열 1탭 온보딩 — `seriesId` 가 오면 **가상 샘플이 아니라 진짜 회사 PLANNED 카드**.
   *
   * ## 시나리오 (먼저 나열하고 코드를 짰다)
   *  1. 정상 — 계열+직무+회사 3개 → PLANNED 카드 3장 · 스텝 = 계열 템플릿 ·
   *     `jobTitleSource='prefill'` · `createdVia='onboarding_pick'` · `isSample=false`
   *  2. 🔴 가상 샘플을 만들지 않는다 (`Sample Corp`·`is_sample` 이 하나도 없다)
   *  3. 직무 없음 → `jobTitle`·`jobTitleSource` 둘 다 null (계열 라벨을 승격하지 않는다)
   *  4. 회사 목록 정리 — 중복·공백·빈 문자열
   *  5. 회사 7개 → 서비스는 6개까지만 (DTO 400 은 E2E 영역)
   *  6. 🔴 `seriesId` 없이 회사만 → 400
   *  7. 계열만 (회사 0) → 카드 0 · 컬럼은 저장
   *  8. 🔴 새 경로도 `signupJobCategories` 를 기록한다 (「이미 답변했나」 판정의 유일한 근거)
   *  9. 이미 답변 → 400 · 트랜잭션 미진입
   * 10. 트랜잭션 중간 실패 → 롤백 (카드도 컬럼도 안 남는다)
   * 11. 마감일을 지어내지 않는다 — 스텝 `scheduledDate` 전부 null
   * 12. 멱등 — 두 번째 호출은 400
   */
  describe('signupAnswer — 계열 1탭 (A안)', () => {
    function mockSavedAppId() {
      let counter = 0;
      manager.save.mockImplementation(async (_t: unknown, input: unknown) => ({
        ...(input as object),
        id: `app-${++counter}`,
      }));
    }

    const unanswered = () =>
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: null }),
      );

    /**
     * 이미 답변이 기록된 상태 — **UPDATE 가 0행**을 잡는다.
     * 「읽어 보니 값이 있더라」가 아니라 이게 실제 판정 경로다.
     */
    const alreadyAnswered = () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ signupJobCategories: [] }),
      );
      manager.update.mockResolvedValue({ affected: 0 } as never);
    };

    const appSaves = () =>
      manager.save.mock.calls.filter((c) => c[0] === Application);
    const stepSaves = () =>
      manager.save.mock.calls.filter((c) => c[0] === ApplicationStep);

    it('1) 계열+직무+회사 3개 → PLANNED 카드 3장 · 계열 템플릿 스텝 · prefill 출처', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'health',
        jobTitle: '간호사',
        pickedCompanies: ['삼성바이오로직스', '유한양행', '대전성모병원'],
      });

      expect(appSaves()).toHaveLength(3);
      expect(appSaves()[0][1]).toMatchObject({
        userId: 'user-uuid-1',
        companyName: '삼성바이오로직스',
        jobTitle: '간호사',
        jobTitleSource: 'prefill',
        // 🔴 계열 라벨을 직군 칸에 박지 않는다 — 표시 계층 fallback 이 그 자리다
        jobCategory: null,
        status: 'PLANNED',
        isSample: false,
        needsDetail: false,
        templateId: 'health',
        createdVia: 'onboarding_pick',
      });

      // health 템플릿 = 서류 제출 · 면접 · 신체검사 · 최종 합격 (4단계 × 카드 3장)
      expect(stepSaves()).toHaveLength(12);
      const first = stepSaves()
        .slice(0, 4)
        .map((c) => (c[1] as { name: string }).name);
      expect(first).toEqual(['서류 제출', '면접', '신체검사', '최종 합격']);
    });

    it('2) 🔴 가상 샘플 카드를 만들지 않는다 — 2단 보상이 그걸 대체한다', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'it',
        pickedCompanies: ['네이버'],
      });

      for (const call of appSaves()) {
        const app = call[1] as { companyName: string; isSample: boolean };
        expect(app.isSample).toBe(false);
        expect(app.companyName).not.toContain('Sample Corp');
      }
      expect(appSaves()).toHaveLength(1);
    });

    it('3) 직무 미전송 → jobTitle·jobTitleSource 둘 다 null (계열 라벨 승격 금지)', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'public',
        pickedCompanies: ['한국전력공사'],
      });

      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({
          signupSeriesId: 'public',
          signupJobTitle: null,
        }),
      );
      expect(appSaves()[0][1]).toMatchObject({
        jobTitle: null,
        jobTitleSource: null,
        templateId: 'public',
      });
    });

    it('4) 회사 목록 정리 — 중복·공백·빈 문자열을 걷어낸다', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'it',
        pickedCompanies: ['카카오', '  카카오  ', '', '   ', '토스'],
      });

      expect(
        appSaves().map((c) => (c[1] as { companyName: string }).companyName),
      ).toEqual(['카카오', '토스']);
    });

    it('5) 회사 7개 → 서비스는 6장까지만 만든다 (DTO 400 은 E2E 영역)', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'it',
        pickedCompanies: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      });

      expect(appSaves()).toHaveLength(6);
    });

    it('6) 🔴 seriesId 없이 회사만 → 400 · 트랜잭션 미진입', async () => {
      unanswered();

      await expect(
        service.signupAnswer('user-uuid-1', {
          jobCategories: [],
          pickedCompanies: ['카카오'],
        }),
      ).rejects.toThrow(
        new BadRequestException('계열 없이 회사만 담을 수 없어요.'),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('7) 계열만 (회사 0) → 카드 0장 · 컬럼은 저장 · onboardedAt 세팅', async () => {
      unanswered();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'marketing',
        jobTitle: '퍼포먼스 마케터',
      });

      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({
          signupSeriesId: 'marketing',
          signupJobTitle: '퍼포먼스 마케터',
          onboardedAt: expect.any(Date),
        }),
      );
      expect(appSaves()).toHaveLength(0);
    });

    it('8) 🔴 새 경로도 signupJobCategories 를 기록한다 — 안 쓰면 온보딩이 매번 다시 뜬다', async () => {
      unanswered();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'it',
      });

      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({ signupJobCategories: [] }),
      );
    });

    it('8-b) jobCategories 미전송(undefined)도 [] 로 기록된다', async () => {
      unanswered();

      await service.signupAnswer('user-uuid-1', { seriesId: 'it' });

      expect(manager.update).toHaveBeenCalledWith(
        User,
        unclaimed,
        expect.objectContaining({ signupJobCategories: [] }),
      );
    });

    /**
     * 🔴 **원자적 선점** (2026-08-29). 예전엔 「먼저 읽어 보고 null 이면 진행」이라, 같은
     * 사용자의 요청 둘이 **둘 다 null 을 보고** 통과할 수 있었다 — 답변은 한 번인데 온보딩
     * 카드가 두 벌 생겼다. 이제 조건이 UPDATE 의 WHERE 안에 있어 두 번째는 0행을 받는다.
     *
     *  9.   0행 → 400 · 카드 미생성 (400 이 저장보다 먼저 던져진다)
     *  9-b. 0행 → 트랜잭션 밖으로 예외가 나간다 = 컬럼 갱신도 함께 되감긴다
     */
    it('9) 이미 답변한 user (UPDATE 0행) → 400 · 카드 미생성', async () => {
      alreadyAnswered();

      await expect(
        service.signupAnswer('user-uuid-1', {
          jobCategories: [],
          seriesId: 'it',
          pickedCompanies: ['네이버'],
        }),
      ).rejects.toThrow(new BadRequestException('이미 답변하셨어요.'));
      // 트랜잭션에는 들어간다 (판정이 그 안에 있으므로) — 대신 아무것도 저장되지 않는다
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(appSaves()).toHaveLength(0);
      expect(stepSaves()).toHaveLength(0);
    });

    it('9-b) 🔴 0행 판정은 트랜잭션 안에서 던진다 (같은 TX 가 통째로 롤백)', async () => {
      alreadyAnswered();
      let threwInsideTx = false;
      dataSource.transaction.mockImplementation(async (cb: any) => {
        try {
          return await cb(manager);
        } catch (e) {
          // 진짜 TypeORM 은 여기서 ROLLBACK 후 다시 던진다
          threwInsideTx = true;
          throw e;
        }
      });

      await expect(
        service.signupAnswer('user-uuid-1', {
          jobCategories: [],
          seriesId: 'it',
          pickedCompanies: ['네이버'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(threwInsideTx).toBe(true);
    });

    it('10) 트랜잭션 중간 실패 → 롤백 (카드도 컬럼도 안 남는다)', async () => {
      unanswered();
      // 두 번째 카드 저장에서 터뜨린다 — 앞의 update·save 가 같은 TX 안이라 함께 되감긴다
      let saves = 0;
      manager.save.mockImplementation(async (t: unknown, input: unknown) => {
        if (t === Application && ++saves === 2) throw new Error('db down');
        return { ...(input as object), id: `app-${saves}` };
      });
      dataSource.transaction.mockImplementation(async (cb: any) => {
        // 진짜 TX 처럼 — 콜백이 던지면 그대로 전파되고 커밋되지 않는다
        return cb(manager);
      });

      await expect(
        service.signupAnswer('user-uuid-1', {
          jobCategories: [],
          seriesId: 'it',
          pickedCompanies: ['네이버', '카카오', '토스'],
        }),
      ).rejects.toThrow('db down');

      // 세 번째 카드는 시도조차 안 됐다 (루프가 끊긴다)
      expect(appSaves()).toHaveLength(2);
      // 롤백 자체는 TypeORM 이 한다 — 여기선 "예외가 TX 밖으로 나간다" 를 못 박는다
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('11) 마감일을 지어내지 않는다 — 스텝 scheduledDate 전부 null', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'finance',
        pickedCompanies: ['KB국민은행'],
      });

      expect(stepSaves().length).toBeGreaterThan(0);
      for (const call of stepSaves()) {
        expect(
          (call[1] as { scheduledDate: Date | null }).scheduledDate,
        ).toBeNull();
      }
    });

    it('12) 멱등 — 두 번째 호출은 400 (부작용 1번)', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'it',
        pickedCompanies: ['네이버'],
      });
      expect(appSaves()).toHaveLength(1);

      // 두 번째 호출 시점엔 이미 답변이 기록돼 있다 → UPDATE 가 0행
      alreadyAnswered();
      await expect(
        service.signupAnswer('user-uuid-1', {
          jobCategories: [],
          seriesId: 'it',
          pickedCompanies: ['네이버'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(appSaves()).toHaveLength(1);
    });

    /**
     * 🔴 **서버는 직무 사전이 없다.** 「승무원」의 항공 서비스 전형은 프론트가 판정해
     * 보내 줘야 재현된다 — 안 그러면 사용자가 방금 본 미리보기와 담긴 카드가 어긋난다.
     */
    it('13) 프론트가 보낸 templateId 를 쓴다 (승무원 → air_service)', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'sales',
        jobTitle: '승무원',
        templateId: 'air_service',
        pickedCompanies: ['대한항공'],
      });

      expect(appSaves()[0][1]).toMatchObject({ templateId: 'air_service' });
      expect(stepSaves().map((c) => (c[1] as { name: string }).name)).toEqual([
        '서류 제출',
        '1차 실무면접',
        '2차 임원·영어면접',
        '체력·신체검사',
        '최종 합격',
      ]);
    });

    it('13-b) templateId 미전송 → 계열 템플릿으로 폴백', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'sales',
        jobTitle: '승무원',
        pickedCompanies: ['대한항공'],
      });

      // 서버 혼자면 계열까지밖에 모른다 — 그게 폴백이고, 그래서 프론트가 보내 주는 것이다
      expect(appSaves()[0][1]).toMatchObject({ templateId: 'sales' });
      expect(stepSaves()[1][1]).toMatchObject({ name: '인적성·AI역량검사' });
    });

    it('13-c) 🔴 모르는 templateId → 조용히 계열 폴백 (general 로 새지 않는다)', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: [],
        seriesId: 'health',
        templateId: 'no_such_template',
        pickedCompanies: ['유한양행'],
      });

      expect(appSaves()[0][1]).toMatchObject({ templateId: 'health' });
      expect(stepSaves().map((c) => (c[1] as { name: string }).name)).toEqual([
        '서류 제출',
        '면접',
        '신체검사',
        '최종 합격',
      ]);
    });

    it('회귀 — seriesId 가 없으면 기존 샘플 경로가 그대로 돈다', async () => {
      unanswered();
      mockSavedAppId();

      await service.signupAnswer('user-uuid-1', {
        jobCategories: ['백엔드 개발'],
      });

      expect(appSaves()).toHaveLength(1);
      expect(appSaves()[0][1]).toMatchObject({
        companyName: 'Cloud Tech 백엔드',
        isSample: true,
        createdVia: 'onboarding_sample',
      });
    });
  });

  describe('dismissAllSampleCards (W1)', () => {
    beforeEach(() => {
      // createQueryBuilder chain mock (mass UPDATE applications)
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3 }),
      };
      manager.createQueryBuilder.mockReturnValue(qb as never);
    });

    it('정상 → users.sample_cards_dismissed_at set + applications mass soft delete', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ sampleCardsDismissedAt: null }),
      );

      await service.dismissAllSampleCards('user-uuid-1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledWith(
        User,
        'user-uuid-1',
        expect.objectContaining({ sampleCardsDismissedAt: expect.any(Date) }),
      );
      expect(manager.createQueryBuilder).toHaveBeenCalled();
    });

    it('이미 dismiss 됨 → no-op (transaction 호출 X)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ sampleCardsDismissedAt: new Date('2026-06-25') }),
      );

      await service.dismissAllSampleCards('user-uuid-1');

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 user → 404', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.dismissAllSampleCards('nonexistent'),
      ).rejects.toThrow(NotFoundException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('트랜잭션 wrap — User update + applications mass update 둘 다 같은 TX', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ sampleCardsDismissedAt: null }),
      );

      await service.dismissAllSampleCards('user-uuid-1');

      // transaction callback 안에서 manager.update + createQueryBuilder 둘 다 호출
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledTimes(1);
      expect(manager.createQueryBuilder).toHaveBeenCalledTimes(1);
    });
  });

  // ── 면접 유도 모달: dismissInterviewNudge ─────────────
  /**
   * 🔴 다른 dismiss 와 **실패 처리 방향이 반대**인 유일한 항목이다.
   * 스텝 노출 기록은 실패해도 「한 번 더 뜨는」 정도라 안전하지만, 이건 사용자가
   * **명시적으로 체크한 약속**이라 실패 후 또 뜨면 약속 파기다 (프론트가 재시도 + localStorage 로 보강).
   */
  describe('dismissInterviewNudge', () => {
    it('정상 → users.interview_nudge_dismissed_at 에 현재 시각 저장', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ interviewNudgeDismissedAt: null }),
      );

      await service.dismissInterviewNudge('user-uuid-1');

      expect(userRepo.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({
          interviewNudgeDismissedAt: expect.any(Date),
        }),
      );
    });

    it('이미 dismiss 됨 → no-op (멱등 — 시각을 덮어쓰지 않는다)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ interviewNudgeDismissedAt: new Date('2026-08-16') }),
      );

      await service.dismissInterviewNudge('user-uuid-1');

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 user → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.dismissInterviewNudge('nonexistent'),
      ).rejects.toThrow(NotFoundException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── 캘린더 UX 재구성: dismissCalendarHomeIntro ─────────────
  describe('dismissCalendarHomeIntro', () => {
    it('정상 → users.calendar_home_intro_dismissed_at 에 현재 시각 저장', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({ calendarHomeIntroDismissedAt: null }),
      );

      await service.dismissCalendarHomeIntro('user-uuid-1');

      expect(userRepo.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({
          calendarHomeIntroDismissedAt: expect.any(Date),
        }),
      );
    });

    it('이미 dismiss 됨 → no-op (update 호출 X, 멱등)', async () => {
      userRepo.findOneBy.mockResolvedValue(
        makeUser({
          calendarHomeIntroDismissedAt: new Date('2026-07-02'),
        }),
      );

      await service.dismissCalendarHomeIntro('user-uuid-1');

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 user → NotFoundException', async () => {
      userRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.dismissCalendarHomeIntro('nonexistent'),
      ).rejects.toThrow(NotFoundException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('markDesktopWebSeen', () => {
    /** UPDATE 체인 mock — 호출된 인자를 그대로 들여다볼 수 있게 각 단계를 기록한다 */
    function stubUpdateChain(affected = 1) {
      const calls = {
        where: [] as unknown[],
        andWhere: [] as unknown[],
        set: [] as unknown[],
      };
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn((v: unknown) => (calls.set.push(v), qb)),
        where: jest.fn((v: unknown) => (calls.where.push(v), qb)),
        andWhere: jest.fn((v: unknown) => (calls.andWhere.push(v), qb)),
        execute: jest.fn().mockResolvedValue({ affected }),
      };
      userRepo.createQueryBuilder.mockReturnValue(qb as never);
      return { qb, calls };
    }

    it('정상 → 조건부 UPDATE 를 1회 실행한다', async () => {
      const { qb } = stubUpdateChain();

      await service.markDesktopWebSeen('user-uuid-1');

      expect(qb.execute).toHaveBeenCalledTimes(1);
    });

    /**
     * 🔴 이 조건이 빠지면 **탭을 여러 개 열 때마다 최초 시각이 덮어써진다.**
     * 여기서 재는 건 "언제 처음 데스크탑을 썼나" 이므로 최초값 보존이 곧 지표의 정의다.
     */
    it('WHERE 에 IS NULL 가드가 있다 (재호출·동시 요청에서 최초 시각 보존)', async () => {
      const { calls } = stubUpdateChain();

      await service.markDesktopWebSeen('user-uuid-1');

      const whereSql = [...calls.where, ...calls.andWhere].join(' ');
      expect(whereSql).toContain('first_desktop_web_seen_at IS NULL');
    });

    /**
     * 🔴 읽고-쓰기(`findOneBy` → 분기 → `update`)로 바꾸면 **동시 요청 둘이 모두 NULL 을 보고
     * 둘 다 쓴다.** 형제 메서드들과 패턴이 다른 이유이므로 회귀로 고정한다.
     */
    it('읽고-쓰지 않는다 (findOneBy 미호출 · UPDATE 한 방)', async () => {
      stubUpdateChain();

      await service.markDesktopWebSeen('user-uuid-1');

      expect(userRepo.findOneBy).not.toHaveBeenCalled();
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('이미 스탬프됨 → 0행이어도 예외 없이 끝난다 (멱등)', async () => {
      stubUpdateChain(0);

      await expect(
        service.markDesktopWebSeen('user-uuid-1'),
      ).resolves.toBeUndefined();
    });

    // best-effort 통계다 — 없는 사용자에 대해서도 던지지 않는다 (형제 메서드와 의도적으로 다름)
    it('존재하지 않는 user → 예외 없이 0행', async () => {
      stubUpdateChain(0);

      await expect(
        service.markDesktopWebSeen('nonexistent'),
      ).resolves.toBeUndefined();
    });
  });
});
