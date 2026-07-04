import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import Expo from 'expo-server-sdk';
import { PushService } from './push.service';
import { UserDevice } from '../devices/user-device.entity';

const VALID = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const VALID2 = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

describe('PushService', () => {
  let service: PushService;
  let deviceRepo: jest.Mocked<Repository<UserDevice>>;

  beforeEach(async () => {
    deviceRepo = mock<Repository<UserDevice>>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: getRepositoryToken(UserDevice), useValue: deviceRepo },
      ],
    }).compile();
    service = module.get(PushService);
    jest.restoreAllMocks();
  });

  it('Expo 형식 아닌 토큰 전부 → sent 0 · 발송 안 함', async () => {
    const sendSpy = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync');
    const result = await service.sendToTokens(['garbage', 'fcm-token'], {
      title: 't',
      body: 'b',
    });
    expect(result.sent).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('유효 토큰 → sent = 유효 개수 · 정상 ticket', async () => {
    const result = await service.sendToTokens([VALID, VALID2, 'bad'], {
      title: 't',
      body: 'b',
      deepLink: '/board/1',
    });
    expect(result.sent).toBe(2); // bad 제외
    expect(result.removedInvalid).toBe(0);
  });

  it('DeviceNotRegistered ticket → 해당 device 삭제', async () => {
    jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockResolvedValue([
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
      ] as never);
    const deleteQb = mock<SelectQueryBuilder<UserDevice>>();
    deleteQb.delete.mockReturnThis();
    deleteQb.where.mockReturnThis();
    deleteQb.execute.mockResolvedValue({ affected: 1 });
    deviceRepo.createQueryBuilder.mockReturnValue(deleteQb);

    const result = await service.sendToTokens([VALID], {
      title: 't',
      body: 'b',
    });

    expect(result.removedInvalid).toBe(1);
    expect(deleteQb.where).toHaveBeenCalledWith(
      'device_token IN (:...tokens)',
      { tokens: [VALID] },
    );
  });

  it('Expo 발송 throw → 조용히 처리 (removedInvalid 0)', async () => {
    jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockRejectedValue(new Error('network'));
    const result = await service.sendToTokens([VALID], {
      title: 't',
      body: 'b',
    });
    expect(result.sent).toBe(1);
    expect(result.removedInvalid).toBe(0);
  });
});
