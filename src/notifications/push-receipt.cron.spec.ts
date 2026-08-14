import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { PushReceiptCron } from './push-receipt.cron';
import { PushReceiptService } from './push-receipt.service';

/**
 * R4 cron — **예외를 삼키는 것이 이 클래스의 존재 이유**다.
 *
 * cron 핸들러가 던지면 unhandled rejection 으로 앱이 죽는다. 죽은 토큰 정리는 급한 일이
 * 아니고 다음 주기가 이어받으면 되므로, Expo 장애·DB 순단이 서비스를 끌고 내려가서는 안 된다.
 * 그 계약을 여기서 잠근다 (서비스 spec 은 정리 로직만 보고, "실패해도 안 죽는다" 는 안 본다).
 *
 * 시나리오: 정상 / processPending 실패 / purgeOld 실패 / 둘 다 실패 / 앞이 실패해도 뒤는 실행
 */
describe('PushReceiptCron', () => {
  const receipts = mock<PushReceiptService>();
  let cron: PushReceiptCron;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PushReceiptCron,
        { provide: PushReceiptService, useValue: receipts },
      ],
    }).compile();
    cron = moduleRef.get(PushReceiptCron);
  });

  it('정상 — 영수증 확인 후 오래된 대기열 정리까지 한 tick 에서 돈다', async () => {
    receipts.processPending.mockResolvedValue({
      checked: 3,
      processed: 3,
      removedDevices: 1,
    });
    receipts.purgeOld.mockResolvedValue(0);

    await expect(cron.tick()).resolves.toBeUndefined();

    expect(receipts.processPending).toHaveBeenCalledTimes(1);
    expect(receipts.purgeOld).toHaveBeenCalledTimes(1);
  });

  it('🔴 processPending 이 던져도 tick 은 던지지 않는다 (앱 생존)', async () => {
    receipts.processPending.mockRejectedValue(new Error('Expo 502'));
    receipts.purgeOld.mockResolvedValue(0);

    await expect(cron.tick()).resolves.toBeUndefined();
  });

  it('🔴 processPending 이 실패해도 purgeOld 는 실행된다 (두 정리는 독립)', async () => {
    receipts.processPending.mockRejectedValue(new Error('Expo 502'));
    receipts.purgeOld.mockResolvedValue(2);

    await cron.tick();

    expect(receipts.purgeOld).toHaveBeenCalledTimes(1);
  });

  it('🔴 purgeOld 가 던져도 tick 은 던지지 않는다', async () => {
    receipts.processPending.mockResolvedValue({
      checked: 0,
      processed: 0,
      removedDevices: 0,
    });
    receipts.purgeOld.mockRejectedValue(new Error('DB 순단'));

    await expect(cron.tick()).resolves.toBeUndefined();
  });

  it('🔴 둘 다 던져도 tick 은 던지지 않는다', async () => {
    receipts.processPending.mockRejectedValue(new Error('Expo 502'));
    receipts.purgeOld.mockRejectedValue(new Error('DB 순단'));

    await expect(cron.tick()).resolves.toBeUndefined();
  });
});
