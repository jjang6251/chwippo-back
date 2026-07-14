import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { mock } from 'jest-mock-extended';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { AuthService } from '../auth/auth.service';
import { UserDevice } from '../devices/user-device.entity';
import { User } from '../users/user.entity';
import { NotificationLog } from './notification-log.entity';

const NOW = new Date('2026-07-04T00:00:00Z'); // KST 09:00

describe('NotificationDispatchService', () => {
  let service: NotificationDispatchService;
  let deviceRepo: jest.Mocked<Repository<UserDevice>>;
  let logRepo: jest.Mocked<Repository<NotificationLog>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let notificationsService: jest.Mocked<NotificationsService>;
  let pushService: jest.Mocked<PushService>;
  let authService: jest.Mocked<AuthService>;
  let dataSource: jest.Mocked<DataSource>;
  let manager: jest.Mocked<EntityManager>;
  let logQb: jest.Mocked<SelectQueryBuilder<NotificationLog>>;

  const grantedUser = { id: 'u1', alarmPermissionGranted: true };
  const noPermUser = { id: 'u2', alarmPermissionGranted: false };
  const content = {
    title: 't',
    body: 'b',
    deepLink: '/board/1',
    eventCount: 3,
  };

  beforeEach(async () => {
    deviceRepo = mock<Repository<UserDevice>>();
    logRepo = mock<Repository<NotificationLog>>();
    userRepo = mock<Repository<User>>();
    notificationsService = mock<NotificationsService>();
    pushService = mock<PushService>();
    authService = mock<AuthService>();
    dataSource = mock<DataSource>();
    manager = mock<EntityManager>();

    logQb = mock<SelectQueryBuilder<NotificationLog>>();
    logQb.where.mockReturnThis();
    logQb.andWhere.mockReturnThis();
    logRepo.createQueryBuilder.mockReturnValue(logQb);

    pushService.sendToTokens.mockResolvedValue({
      sent: 1,
      removedInvalid: 0,
      tickets: [],
    });

    // 기본: 유효 세션 있음 → 실제 내용 발송
    authService.hasValidSession.mockResolvedValue(true);
    userRepo.update.mockResolvedValue({} as never);

    // manager.getRepository(NotificationLog).insert(...)
    const logInsertRepo = mock<Repository<NotificationLog>>();
    manager.getRepository.mockReturnValue(logInsertRepo);
    dataSource.transaction.mockImplementation((async (cb: any) =>
      cb(manager)) as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDispatchService,
        { provide: getRepositoryToken(UserDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(NotificationLog), useValue: logRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: PushService, useValue: pushService },
        { provide: AuthService, useValue: authService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(NotificationDispatchService);
  });

  it('오늘 이미 발송 → skip (TX·push 없음, false)', async () => {
    logQb.getCount.mockResolvedValue(1);

    const ok = await service.dispatch(grantedUser, 'briefing', content, NOW);

    expect(ok).toBe(false);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(pushService.sendToTokens).not.toHaveBeenCalled();
  });

  it('미발송 + 권한 O + device O → TX 생성 + push 발송 + true', async () => {
    logQb.getCount.mockResolvedValue(0);
    deviceRepo.find.mockResolvedValue([
      { deviceToken: 'ExponentPushToken[x]' } as UserDevice,
    ]);

    const ok = await service.dispatch(grantedUser, 'briefing', content, NOW);

    expect(ok).toBe(true);
    expect(notificationsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'briefing' }),
      manager,
    );
    expect(pushService.sendToTokens).toHaveBeenCalledWith(
      ['ExponentPushToken[x]'],
      expect.objectContaining({ title: 't', body: 'b' }),
    );
  });

  it('권한 X → 인앱 생성은 하되 push 안 함 (백업 채널)', async () => {
    logQb.getCount.mockResolvedValue(0);

    const ok = await service.dispatch(noPermUser, 'briefing', content, NOW);

    expect(ok).toBe(true);
    expect(notificationsService.create).toHaveBeenCalled();
    expect(pushService.sendToTokens).not.toHaveBeenCalled();
    expect(deviceRepo.find).not.toHaveBeenCalled();
  });

  it('권한 O + device 없음 → push 안 함', async () => {
    logQb.getCount.mockResolvedValue(0);
    deviceRepo.find.mockResolvedValue([]);

    const ok = await service.dispatch(grantedUser, 'briefing', content, NOW);

    expect(ok).toBe(true);
    expect(pushService.sendToTokens).not.toHaveBeenCalled();
  });

  it('TX throw (dedup UNIQUE 경합) → false, push 안 함', async () => {
    logQb.getCount.mockResolvedValue(0);
    dataSource.transaction.mockRejectedValue(
      new Error('duplicate key value violates unique constraint'),
    );

    const ok = await service.dispatch(grantedUser, 'briefing', content, NOW);

    expect(ok).toBe(false);
    expect(pushService.sendToTokens).not.toHaveBeenCalled();
  });

  // ── 푸시-세션 분리 (A안) ────────────────────────────────
  describe('푸시-세션 분리', () => {
    beforeEach(() => {
      logQb.getCount.mockResolvedValue(0);
      deviceRepo.find.mockResolvedValue([
        { deviceToken: 'ExponentPushToken[x]' } as UserDevice,
      ]);
    });

    it('유효 세션 있음(hasValidSession=true) → 실제 내용 그대로 발송 (단일 소스)', async () => {
      authService.hasValidSession.mockResolvedValue(true);

      await service.dispatch(grantedUser, 'briefing', content, NOW);

      expect(authService.hasValidSession).toHaveBeenCalledWith('u1', NOW);
      expect(pushService.sendToTokens).toHaveBeenCalledWith(
        ['ExponentPushToken[x]'],
        expect.objectContaining({ title: 't', body: 'b' }),
      );
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('세션 0 + 최초 감지 + 발송 성공 → 유도 1회 · deepLink /calendar · notified_at 기록', async () => {
      authService.hasValidSession.mockResolvedValue(false);
      userRepo.findOne.mockResolvedValue({
        sessionExpiredNotifiedAt: null,
      } as User);

      await service.dispatch(grantedUser, 'briefing', content, NOW);

      const payload = pushService.sendToTokens.mock.calls[0][1];
      expect(payload.title).toBe('로그인이 만료됐어요');
      expect(payload.body).toContain('다시 로그인');
      // MEDIUM: 특정 board UUID 노출 차단 — /calendar 로 마스킹
      expect(payload.deepLink).toBe('/calendar');
      expect(payload.body).not.toContain('b'); // 개인 내용 비노출
      // 발송 성공(sent>0) 후에만 notified_at 기록
      expect(userRepo.update).toHaveBeenCalledWith('u1', {
        sessionExpiredNotifiedAt: NOW,
      });
    });

    it('⑩ 세션 0 + 최초 감지 + 유도 발송 실패(throw) → notified_at 미기록 (다음에 다시 유도)', async () => {
      authService.hasValidSession.mockResolvedValue(false);
      userRepo.findOne.mockResolvedValue({
        sessionExpiredNotifiedAt: null,
      } as User);
      pushService.sendToTokens.mockRejectedValue(new Error('expo down'));

      const ok = await service.dispatch(grantedUser, 'briefing', content, NOW);

      expect(ok).toBe(true); // 인앱은 생성됨
      // 발송 실패 → anchor 기록 안 함
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('⑩ 세션 0 + 최초 감지 + 발송 결과 sent=0 → notified_at 미기록', async () => {
      authService.hasValidSession.mockResolvedValue(false);
      userRepo.findOne.mockResolvedValue({
        sessionExpiredNotifiedAt: null,
      } as User);
      pushService.sendToTokens.mockResolvedValue({
        sent: 0,
        removedInvalid: 1,
        tickets: [],
      });

      await service.dispatch(grantedUser, 'briefing', content, NOW);

      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('세션 0 + 이미 유도함(최근) → 마스킹 요약 · deepLink /calendar · 개인 내용 비노출', async () => {
      authService.hasValidSession.mockResolvedValue(false);
      userRepo.findOne.mockResolvedValue({
        sessionExpiredNotifiedAt: new Date(NOW.getTime() - 3 * 86400000),
      } as User);

      await service.dispatch(grantedUser, 'briefing', content, NOW);

      const payload = pushService.sendToTokens.mock.calls[0][1];
      expect(payload.title).toBe('오늘 확인할 일정이 있어요 🔔');
      expect(payload.body).toBe('일정 3건'); // eventCount
      expect(payload.body).not.toContain('b'); // 회사명·전형명 비노출
      expect(payload.deepLink).toBe('/calendar'); // MEDIUM: board UUID 미노출
      expect(userRepo.update).not.toHaveBeenCalled(); // 마스킹은 anchor 갱신 안 함
    });

    it('세션 0 + 유도 후 14일 경과 → 발송 중단 (push 없음, 인앱은 저장됨)', async () => {
      authService.hasValidSession.mockResolvedValue(false);
      userRepo.findOne.mockResolvedValue({
        sessionExpiredNotifiedAt: new Date(NOW.getTime() - 15 * 86400000),
      } as User);

      const ok = await service.dispatch(grantedUser, 'briefing', content, NOW);

      expect(ok).toBe(true);
      expect(notificationsService.create).toHaveBeenCalled();
      expect(pushService.sendToTokens).not.toHaveBeenCalled();
    });

    it('인앱 알림은 마스킹 여부와 무관하게 항상 원문 저장', async () => {
      authService.hasValidSession.mockResolvedValue(false);
      userRepo.findOne.mockResolvedValue({
        sessionExpiredNotifiedAt: new Date(NOW.getTime() - 3 * 86400000),
      } as User);

      await service.dispatch(grantedUser, 'briefing', content, NOW);

      expect(notificationsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 't',
          body: 'b',
          deepLink: '/board/1',
        }),
        manager,
      );
    });
  });
});
