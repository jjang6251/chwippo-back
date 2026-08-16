import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { mock, MockProxy } from 'jest-mock-extended';
import { NotFoundException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepChecklistItem } from './step-checklist-item.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { User } from '../users/user.entity';
import { InterviewPrepSession } from '../interview-prep/entities/interview-prep-session.entity';
import { LlmService } from '../ai/llm.service';
import { CompaniesService } from '../companies/companies.service';
import { DiscordNotifier } from '../common/discord-notifier';

/**
 * 면접 유도 모달 — 서버 판정 spec.
 *
 * ## 이 spec 이 지키는 것
 *
 * 판정은 **④가 스텝 단위**라는 점이 전부다. 카드 단위로 잘못 구현해도 「1차에서 뜬다」는
 * 똑같이 통과하므로, **다른 스텝 세션만 있을 때 뜨는지**(NUDGE-5)를 반드시 본다.
 * 그게 없으면 2차·3차를 통째로 놓치는 회귀가 조용히 들어온다.
 *
 * 🔴 **「이 스텝이 면접인가」는 여기서 검증하지 않는다** — 서버는 그 판정을 하지 않는다.
 * 정규식(`getStepType`)은 프론트 단일 구현이고, 백엔드에 복제하면 드리프트가 생긴다.
 * 서버가 면접 여부를 모른다는 것 자체가 설계다 (D-3 회귀 방어는 프론트 spec 에서).
 */
describe('ApplicationsService — 면접 유도 모달', () => {
  let service: ApplicationsService;
  let appRepo: MockProxy<Repository<Application>>;
  let stepRepo: MockProxy<Repository<ApplicationStep>>;
  let userRepo: MockProxy<Repository<User>>;
  let sessionRepo: MockProxy<Repository<InterviewPrepSession>>;
  let clRepo: MockProxy<Repository<ApplicationCoverletter>>;

  const USER = 'user-1';
  const APP = 'app-1';
  const STEP_ID = 'step-2';

  /** 면접 스텝 2개짜리 카드 — index 1 이 「2차 면접」 */
  const steps = [
    { id: 'step-1', orderIndex: 0, interviewNudgeShownAt: null },
    { id: STEP_ID, orderIndex: 1, interviewNudgeShownAt: null },
  ] as ApplicationStep[];

  beforeEach(async () => {
    appRepo = mock<Repository<Application>>();
    stepRepo = mock<Repository<ApplicationStep>>();
    userRepo = mock<Repository<User>>();
    sessionRepo = mock<Repository<InterviewPrepSession>>();
    clRepo = mock<Repository<ApplicationCoverletter>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: getRepositoryToken(Application), useValue: appRepo },
        { provide: getRepositoryToken(ApplicationStep), useValue: stepRepo },
        {
          provide: getRepositoryToken(StepChecklistItem),
          useValue: mock<Repository<StepChecklistItem>>(),
        },
        { provide: getRepositoryToken(User), useValue: userRepo },
        {
          provide: getRepositoryToken(InterviewPrepSession),
          useValue: sessionRepo,
        },
        {
          provide: getRepositoryToken(ApplicationCoverletter),
          useValue: clRepo,
        },
        { provide: DataSource, useValue: mock<DataSource>() },
        { provide: LlmService, useValue: mock<LlmService>() },
        {
          provide: CompaniesService,
          useValue: { getDomainByName: jest.fn().mockReturnValue(undefined) },
        },
        { provide: DiscordNotifier, useValue: mock<DiscordNotifier>() },
      ],
    }).compile();

    service = module.get(ApplicationsService);

    // 공통 — 카드 소유·조회는 통과시킨다 (판정만 보는 spec)
    stepRepo.find.mockResolvedValue(steps);
    appRepo.findOne.mockResolvedValue({
      id: APP,
      userId: USER,
      steps,
      companyName: 'ㅇㅇ',
    } as unknown as Application);
    appRepo.update.mockResolvedValue({} as never);
  });

  /** 판정 4조건을 「전부 통과」로 세팅 — 각 테스트는 하나만 뒤집는다 */
  function allowAll() {
    userRepo.findOne.mockResolvedValue({
      id: USER,
      interviewNudgeDismissedAt: null,
    } as User);
    sessionRepo.count.mockResolvedValue(0);
    clRepo.count.mockResolvedValue(1); // 자소서 1건 → variant 'first';
  }

  describe('노출 판정', () => {
    it('NUDGE-1 조건 전부 통과 → show:true · variant first', async () => {
      allowAll();
      const res = await service.updateCurrentStep(USER, APP, 1);
      expect(res.interviewNudge).toEqual({ show: true, variant: 'first' });
    });

    it('NUDGE-2 이 스텝에서 이미 띄웠으면 → show:false', async () => {
      allowAll();
      stepRepo.find.mockResolvedValue([
        steps[0],
        { ...steps[1], interviewNudgeShownAt: new Date() },
      ] as ApplicationStep[]);
      const res = await service.updateCurrentStep(USER, APP, 1);
      expect(res.interviewNudge.show).toBe(false);
    });

    it('NUDGE-3 「다시 보지 않기」 후면 → show:false', async () => {
      allowAll();
      userRepo.findOne.mockResolvedValue({
        id: USER,
        interviewNudgeDismissedAt: new Date(),
      } as User);
      const res = await service.updateCurrentStep(USER, APP, 1);
      expect(res.interviewNudge.show).toBe(false);
    });

    it('NUDGE-4 이 스텝의 세션이 이미 있으면 → show:false', async () => {
      allowAll();
      // 첫 count = 이 스텝 세션 → 1건
      sessionRepo.count.mockResolvedValueOnce(1);
      const res = await service.updateCurrentStep(USER, APP, 1);
      expect(res.interviewNudge.show).toBe(false);
      // 이 스텝 기준으로 셌는지 — 카드 단위였다면 stepId 가 안 들어간다
      expect(sessionRepo.count).toHaveBeenCalledWith({
        where: { userId: USER, stepId: STEP_ID },
      });
    });

    /**
     * 🔴 **이 spec 이 이 파일의 존재 이유다.**
     * ④를 카드 단위(`where: { applicationId }`)로 잘못 구현해도 NUDGE-1~4 는 전부 통과한다.
     * 1차 세션만 있는 상태에서 2차 스텝으로 갔을 때 **뜨는지**가 유일한 판별점이다.
     */
    it('NUDGE-5 다른 스텝(1차)의 세션만 있으면 → 2차에서 여전히 뜬다', async () => {
      allowAll();
      sessionRepo.count
        .mockResolvedValueOnce(0) // 이 스텝(2차) 세션 없음
        .mockResolvedValueOnce(1); // 카드 전체로는 1건 (1차)
      const res = await service.updateCurrentStep(USER, APP, 1);
      expect(res.interviewNudge).toEqual({ show: true, variant: 'again' });
    });

    /**
     * 🔴 백필하지 않기로 한 대가를 **명시적으로 고정**한다.
     * 구 세션은 `stepId=NULL` 이라 ④에 안 걸리므로 한 번 더 뜬다. 이게 버그로 신고되면
     * 이 테스트가 「알고 남긴 것」임을 말해준다.
     */
    it('NUDGE-6 마이그레이션 이전 세션(stepId=null)만 있으면 → 뜬다 (백필 안 함의 대가)', async () => {
      allowAll();
      sessionRepo.count
        .mockResolvedValueOnce(0) // stepId 로는 안 잡힌다
        .mockResolvedValueOnce(2); // 카드에는 구 세션 2건
      const res = await service.updateCurrentStep(USER, APP, 1);
      expect(res.interviewNudge.show).toBe(true);
    });
  });

  describe('문구 분기 (variant)', () => {
    it('NUDGE-7 자소서 0건 → noCoverletter (세션 유무보다 우선)', async () => {
      allowAll();
      clRepo.count.mockResolvedValue(0);
      sessionRepo.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5); // 세션이 많아도
      const res = await service.updateCurrentStep(USER, APP, 1);
      expect(res.interviewNudge.variant).toBe('noCoverletter');
    });

    it('NUDGE-8 자소서 있고 카드 세션 0 → first', async () => {
      allowAll();
      const res = await service.updateCurrentStep(USER, APP, 1);
      expect(res.interviewNudge.variant).toBe('first');
    });

    it('NUDGE-9 자소서 있고 카드 세션 1+ → again', async () => {
      allowAll();
      sessionRepo.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      const res = await service.updateCurrentStep(USER, APP, 1);
      expect(res.interviewNudge.variant).toBe('again');
    });

    it('NUDGE-10 자소서 0건이면 세션 count 를 다시 세지 않는다 (불필요 쿼리 없음)', async () => {
      allowAll();
      clRepo.count.mockResolvedValue(0);
      await service.updateCurrentStep(USER, APP, 1);
      // ④ 판정 1회만 — variant 용 카드 count 는 안 돈다
      expect(sessionRepo.count).toHaveBeenCalledTimes(1);
    });
  });

  describe('markInterviewNudgeShown — 스텝당 1회 소진', () => {
    beforeEach(() => {
      appRepo.findOne.mockResolvedValue({
        id: APP,
        userId: USER,
      } as Application);
    });

    it('NUDGE-11 정상 → shownAt 기록', async () => {
      stepRepo.findOne.mockResolvedValue({
        id: STEP_ID,
        applicationId: APP,
        interviewNudgeShownAt: null,
      } as ApplicationStep);
      await service.markInterviewNudgeShown(USER, APP, STEP_ID);
      expect(stepRepo.update).toHaveBeenCalledWith(STEP_ID, {
        interviewNudgeShownAt: expect.any(Date) as Date,
      });
    });

    it('NUDGE-12 이미 기록됐으면 멱등 — 덮어쓰지 않는다', async () => {
      stepRepo.findOne.mockResolvedValue({
        id: STEP_ID,
        applicationId: APP,
        interviewNudgeShownAt: new Date('2026-08-01'),
      } as ApplicationStep);
      await service.markInterviewNudgeShown(USER, APP, STEP_ID);
      expect(stepRepo.update).not.toHaveBeenCalled();
    });

    it('NUDGE-13 IDOR — 타 사용자 카드면 NotFound', async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(
        service.markInterviewNudgeShown(USER, APP, STEP_ID),
      ).rejects.toThrow(NotFoundException);
      expect(stepRepo.update).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **IDOR 2겹의 두 번째 겹.** 카드 소유만 보고 `stepId` 로 바로 update 하면
     * **내 카드 id + 남의 스텝 id** 조합으로 남의 행에 도장을 찍을 수 있다.
     */
    it('NUDGE-14 IDOR — 내 카드에 속하지 않은 스텝이면 NotFound', async () => {
      stepRepo.findOne.mockResolvedValue(null); // applicationId 조건으로 못 찾음
      await expect(
        service.markInterviewNudgeShown(USER, APP, 'other-card-step'),
      ).rejects.toThrow(NotFoundException);
      expect(stepRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'other-card-step', applicationId: APP },
      });
      expect(stepRepo.update).not.toHaveBeenCalled();
    });
  });
});
