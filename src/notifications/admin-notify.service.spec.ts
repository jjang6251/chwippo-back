import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, InsertResult } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { AdminNotifyService } from './admin-notify.service';
import { PushService } from './push.service';
import { Notification } from './notification.entity';
import { User } from '../users/user.entity';
import { UserDevice } from '../devices/user-device.entity';

describe('AdminNotifyService', () => {
  let service: AdminNotifyService;
  let notificationRepo: jest.Mocked<Repository<Notification>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let deviceRepo: jest.Mocked<Repository<UserDevice>>;
  let pushService: jest.Mocked<PushService>;

  beforeEach(async () => {
    notificationRepo = mock<Repository<Notification>>();
    userRepo = mock<Repository<User>>();
    deviceRepo = mock<Repository<UserDevice>>();
    pushService = mock<PushService>();
    notificationRepo.insert.mockResolvedValue({} as InsertResult);
    pushService.sendToTokens.mockResolvedValue({
      sent: 1,
      removedInvalid: 0,
      tickets: [],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminNotifyService,
        {
          provide: getRepositoryToken(Notification),
          useValue: notificationRepo,
        },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(UserDevice), useValue: deviceRepo },
        { provide: PushService, useValue: pushService },
      ],
    }).compile();
    service = module.get(AdminNotifyService);
  });

  it('정지 통지 → admin 타입 인앱 생성 + push (권한 O)', async () => {
    userRepo.findOne.mockResolvedValue({
      id: 'u1',
      alarmPermissionGranted: true,
    } as User);
    deviceRepo.find.mockResolvedValue([
      { deviceToken: 'ExponentPushToken[x]' } as UserDevice,
    ]);

    await service.notifySuspended('u1', '이용약관 위반');

    expect(notificationRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        type: 'admin',
        deepLink: '/inquiry',
      }),
    );
    expect(pushService.sendToTokens).toHaveBeenCalled();
  });

  it('정지 사유 없음 → 일반 문구 사용', async () => {
    userRepo.findOne.mockResolvedValue({
      id: 'u1',
      alarmPermissionGranted: false,
    } as User);

    await service.notifySuspended('u1', null);

    const arg = notificationRepo.insert.mock.calls[0][0] as { body: string };
    expect(arg.body).toContain('계정이 정지');
  });

  it('권한 X → 인앱만, push 안 함', async () => {
    userRepo.findOne.mockResolvedValue({
      id: 'u1',
      alarmPermissionGranted: false,
    } as User);

    await service.notifyUnsuspended('u1');

    expect(notificationRepo.insert).toHaveBeenCalled();
    expect(pushService.sendToTokens).not.toHaveBeenCalled();
    expect(deviceRepo.find).not.toHaveBeenCalled();
  });

  it('권한 O + device 없음 → push 안 함', async () => {
    userRepo.findOne.mockResolvedValue({
      id: 'u1',
      alarmPermissionGranted: true,
    } as User);
    deviceRepo.find.mockResolvedValue([]);

    await service.notifyUnsuspended('u1');
    expect(pushService.sendToTokens).not.toHaveBeenCalled();
  });

  it('인앱 insert 실패 → 조용히 처리 (throw X)', async () => {
    notificationRepo.insert.mockRejectedValue(new Error('db down'));
    userRepo.findOne.mockResolvedValue({
      id: 'u1',
      alarmPermissionGranted: false,
    } as User);

    await expect(service.notifySuspended('u1', 'r')).resolves.toBeUndefined();
  });
});
