import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import Expo from 'expo-server-sdk';
import { PushReceiptService, RECEIPT_MIN_AGE_MS } from './push-receipt.service';
import { PushReceipt } from './push-receipt.entity';
import { UserDevice } from '../devices/user-device.entity';

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

const NOW = new Date('2026-08-13T12:00:00Z');

function pending(ticketId: string, deviceToken: string): PushReceipt {
  return {
    id: `row-${ticketId}`,
    ticketId,
    deviceToken,
    createdAt: new Date(NOW.getTime() - 30 * 60 * 1000),
    processedAt: null,
  };
}

/**
 * PushReceiptService spec (R4).
 *
 * 시나리오:
 *   1) 영수증 DeviceNotRegistered → device 행 삭제 + processed 기록
 *   2) 영수증 ok → 삭제 없음 + processed 기록
 *   3) Expo 조회 실패 → processed 안 찍힘 (다음 주기 재시도)
 *   4) 15분 안 지난 티켓은 조회 대상 제외
 *   5) 1000개 초과 → 배치 분할 (요청당 상한 준수)
 *   6) 보관 기간 지난 대기열 정리
 */
describe('PushReceiptService', () => {
  let service: PushReceiptService;
  let receiptRepo: jest.Mocked<Repository<PushReceipt>>;
  let deviceRepo: jest.Mocked<Repository<UserDevice>>;
  let deleteQb: jest.Mocked<SelectQueryBuilder<UserDevice>>;

  beforeEach(async () => {
    receiptRepo = mock<Repository<PushReceipt>>();
    deviceRepo = mock<Repository<UserDevice>>();

    deleteQb = mock<SelectQueryBuilder<UserDevice>>();
    deleteQb.delete.mockReturnThis();
    deleteQb.where.mockReturnThis();
    deleteQb.execute.mockResolvedValue({ affected: 1, raw: [] });
    deviceRepo.createQueryBuilder.mockReturnValue(deleteQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushReceiptService,
        { provide: getRepositoryToken(PushReceipt), useValue: receiptRepo },
        { provide: getRepositoryToken(UserDevice), useValue: deviceRepo },
      ],
    }).compile();
    service = module.get(PushReceiptService);
    jest.restoreAllMocks();
  });

  describe('processPending', () => {
    it('DeviceNotRegistered 영수증 → device 삭제 + processed 기록', async () => {
      receiptRepo.find.mockResolvedValue([pending('t-1', TOKEN_A)]);
      jest
        .spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync')
        .mockResolvedValue({
          't-1': {
            status: 'error',
            message: 'not registered',
            details: { error: 'DeviceNotRegistered' },
          },
        });

      const result = await service.processPending(NOW);

      expect(deleteQb.where).toHaveBeenCalledWith(
        'device_token IN (:...tokens)',
        { tokens: [TOKEN_A] },
      );
      expect(receiptRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: expect.objectContaining({ _value: ['t-1'] }),
        }),
        { processedAt: NOW },
      );
      expect(result.removedDevices).toBe(1);
      expect(result.processed).toBe(1);
    });

    it('정상 영수증 → 삭제 없음 · processed 만 기록', async () => {
      receiptRepo.find.mockResolvedValue([
        pending('t-1', TOKEN_A),
        pending('t-2', TOKEN_B),
      ]);
      jest
        .spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync')
        .mockResolvedValue({
          't-1': { status: 'ok' },
          't-2': { status: 'ok' },
        });

      const result = await service.processPending(NOW);

      expect(deviceRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(receiptRepo.update).toHaveBeenCalledTimes(1);
      expect(result.processed).toBe(2);
      expect(result.removedDevices).toBe(0);
    });

    it('다른 에러(MessageRateExceeded)는 device 를 지우지 않는다', async () => {
      receiptRepo.find.mockResolvedValue([pending('t-1', TOKEN_A)]);
      jest
        .spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync')
        .mockResolvedValue({
          't-1': {
            status: 'error',
            message: 'rate',
            details: { error: 'MessageRateExceeded' },
          },
        });

      const result = await service.processPending(NOW);

      expect(deviceRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result.processed).toBe(1);
    });

    it('Expo 조회 실패 → processed 안 찍힘 (다음 주기 재시도)', async () => {
      receiptRepo.find.mockResolvedValue([pending('t-1', TOKEN_A)]);
      jest
        .spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync')
        .mockRejectedValue(new Error('expo down'));

      const result = await service.processPending(NOW);

      expect(receiptRepo.update).not.toHaveBeenCalled();
      expect(deviceRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result.processed).toBe(0);
      expect(result.checked).toBe(1);
    });

    it('응답에 없는 ticket 은 미처리로 남긴다 (영수증 아직 준비 전)', async () => {
      receiptRepo.find.mockResolvedValue([
        pending('t-1', TOKEN_A),
        pending('t-2', TOKEN_B),
      ]);
      jest
        .spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync')
        .mockResolvedValue({ 't-1': { status: 'ok' } });

      const result = await service.processPending(NOW);

      expect(receiptRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: expect.objectContaining({ _value: ['t-1'] }),
        }),
        { processedAt: NOW },
      );
      expect(result.processed).toBe(1);
    });

    it('15분 안 지난 티켓은 조회 대상에서 제외 (createdAt <= now-15m)', async () => {
      receiptRepo.find.mockResolvedValue([]);

      await service.processPending(NOW);

      const where = receiptRepo.find.mock.calls[0][0]?.where as {
        createdAt: { value: Date };
      };
      expect(where.createdAt.value).toEqual(
        new Date(NOW.getTime() - RECEIPT_MIN_AGE_MS),
      );
    });

    it('1000개 초과 → 배치 분할 · 요청당 1000개 이하', async () => {
      const rows = Array.from({ length: 1200 }, (_, i) =>
        pending(`t-${i}`, `token-${i}`),
      );
      receiptRepo.find.mockResolvedValue(rows);
      const getSpy = jest
        .spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync')
        .mockImplementation((ids) =>
          Promise.resolve(
            Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])),
          ),
        );

      const result = await service.processPending(NOW);

      expect(getSpy.mock.calls.length).toBeGreaterThan(1);
      getSpy.mock.calls.forEach(([ids]) =>
        expect(ids.length).toBeLessThanOrEqual(1000),
      );
      // 분할돼도 전부 마감된다
      expect(result.processed).toBe(1200);
    });

    it('미처리 티켓 없음 → Expo 호출 안 함', async () => {
      receiptRepo.find.mockResolvedValue([]);
      const getSpy = jest.spyOn(
        Expo.prototype,
        'getPushNotificationReceiptsAsync',
      );

      const result = await service.processPending(NOW);

      expect(getSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ checked: 0, processed: 0, removedDevices: 0 });
    });
  });

  describe('purgeOld', () => {
    it('7일 지난 대기열 행 삭제', async () => {
      receiptRepo.delete.mockResolvedValue({ affected: 3, raw: [] });

      const deleted = await service.purgeOld(NOW);

      const where = receiptRepo.delete.mock.calls[0][0] as {
        createdAt: { value: Date };
      };
      const daysAgo =
        (NOW.getTime() - where.createdAt.value.getTime()) / 86_400_000;
      expect(daysAgo).toBe(7);
      expect(deleted).toBe(3);
    });
  });
});
