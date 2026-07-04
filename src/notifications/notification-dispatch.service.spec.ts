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
import { UserDevice } from '../devices/user-device.entity';
import { NotificationLog } from './notification-log.entity';

const NOW = new Date('2026-07-04T00:00:00Z'); // KST 09:00

describe('NotificationDispatchService', () => {
  let service: NotificationDispatchService;
  let deviceRepo: jest.Mocked<Repository<UserDevice>>;
  let logRepo: jest.Mocked<Repository<NotificationLog>>;
  let notificationsService: jest.Mocked<NotificationsService>;
  let pushService: jest.Mocked<PushService>;
  let dataSource: jest.Mocked<DataSource>;
  let manager: jest.Mocked<EntityManager>;
  let logQb: jest.Mocked<SelectQueryBuilder<NotificationLog>>;

  const grantedUser = { id: 'u1', alarmPermissionGranted: true };
  const noPermUser = { id: 'u2', alarmPermissionGranted: false };
  const content = { title: 't', body: 'b', deepLink: '/board/1' };

  beforeEach(async () => {
    deviceRepo = mock<Repository<UserDevice>>();
    logRepo = mock<Repository<NotificationLog>>();
    notificationsService = mock<NotificationsService>();
    pushService = mock<PushService>();
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
        { provide: NotificationsService, useValue: notificationsService },
        { provide: PushService, useValue: pushService },
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
});
