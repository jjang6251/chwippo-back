import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import Expo, { ExpoPushTicket } from 'expo-server-sdk';
import { PushService } from './push.service';
import { UserDevice } from '../devices/user-device.entity';
import { PushReceipt } from './push-receipt.entity';

const VALID = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const VALID2 = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

describe('PushService', () => {
  let service: PushService;
  let deviceRepo: jest.Mocked<Repository<UserDevice>>;
  let receiptRepo: jest.Mocked<Repository<PushReceipt>>;

  beforeEach(async () => {
    deviceRepo = mock<Repository<UserDevice>>();
    receiptRepo = mock<Repository<PushReceipt>>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: getRepositoryToken(UserDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(PushReceipt), useValue: receiptRepo },
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

  it('발송 메시지 전부 priority high (Android 절전 배달 유예 방지)', async () => {
    const okTickets: ExpoPushTicket[] = [
      { status: 'ok', id: 'r1' },
      { status: 'ok', id: 'r2' },
    ];
    const sendSpy = jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockResolvedValue(okTickets);

    await service.sendToTokens([VALID, VALID2], { title: 't', body: 'b' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const chunk = sendSpy.mock.calls[0][0];
    expect(chunk).toHaveLength(2);
    chunk.forEach((message) => expect(message.priority).toBe('high'));
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

  it('정상 ticket → 영수증 대기열에 ticket id · token 저장 (R4)', async () => {
    jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([
      { status: 'ok', id: 'ticket-1' },
      { status: 'ok', id: 'ticket-2' },
    ]);

    await service.sendToTokens([VALID, VALID2], { title: 't', body: 'b' });

    expect(receiptRepo.insert).toHaveBeenCalledWith([
      { ticketId: 'ticket-1', deviceToken: VALID },
      { ticketId: 'ticket-2', deviceToken: VALID2 },
    ]);
  });

  it('error ticket 은 대기열에 안 넣는다 (영수증이 없으므로)', async () => {
    jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockResolvedValue([
        { status: 'error', message: 'x', details: { error: 'MessageTooBig' } },
      ]);

    await service.sendToTokens([VALID], { title: 't', body: 'b' });

    expect(receiptRepo.insert).not.toHaveBeenCalled();
  });

  it('대기열 저장 실패해도 발송은 성공 (best-effort)', async () => {
    jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]);
    receiptRepo.insert.mockRejectedValue(new Error('db down'));

    const result = await service.sendToTokens([VALID], {
      title: 't',
      body: 'b',
    });

    expect(result.sent).toBe(1);
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
