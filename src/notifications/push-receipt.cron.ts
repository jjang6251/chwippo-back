import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PushReceiptService } from './push-receipt.service';

/**
 * R4 — push 영수증 확인 cron. 15분 간격.
 *
 * 15분인 이유는 영수증이 발송 직후엔 준비되지 않기 때문이다 (서비스가 15분 지난
 * 티켓만 고른다). 죽은 토큰 정리는 급한 일이 아니라 주기를 더 촘촘히 할 이유가 없다.
 *
 * 오래된 대기열 정리도 같은 tick 에서 한다 — 대기열은 발송 건수만큼만 쌓이는
 * 작은 테이블이라 매 주기 DELETE 한 번이 별도 스케줄을 두는 것보다 싸다.
 *
 * 예외는 전부 여기서 삼킨다. cron 이 던지면 앱이 죽고, 정리 실패는 다음 주기가 이어받는다.
 */
@Injectable()
export class PushReceiptCron {
  private readonly logger = new Logger(PushReceiptCron.name);

  constructor(private readonly receipts: PushReceiptService) {}

  @Cron('*/15 * * * *', { timeZone: 'Asia/Seoul' })
  async tick(): Promise<void> {
    try {
      const result = await this.receipts.processPending();
      if (result.checked > 0) {
        this.logger.log(
          `[PushReceiptCron] 영수증 확인 ${result.checked}건 · 마감 ${result.processed}건 · device 정리 ${result.removedDevices}건`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[PushReceiptCron] 영수증 확인 실패 (다음 주기 재시도): ${(err as Error).message}`,
      );
    }

    try {
      await this.receipts.purgeOld();
    } catch (err) {
      this.logger.error(
        `[PushReceiptCron] 대기열 정리 실패: ${(err as Error).message}`,
      );
    }
  }
}
