import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PushCandidateService } from './push-candidate.service';

/**
 * W2 RN — Push 알림 후보 스캔 cron (매일 09:00 KST).
 *
 * 실제 APNs/FCM 발송은 W3 로 이관. 이 cron 은 인프라 앵커:
 * D-day 후보 발굴 · 등록 device 매핑 · 로그. 발송 SDK 붙일 훅 지점.
 */
@Injectable()
export class PushNotificationCron {
  private readonly logger = new Logger(PushNotificationCron.name);

  constructor(private readonly candidateService: PushCandidateService) {}

  @Cron('0 9 * * *', { timeZone: 'Asia/Seoul' })
  async runDaily(): Promise<void> {
    this.logger.log('[PushNotificationCron] daily scan 시작 (KST 09:00)');
    try {
      const candidates = await this.candidateService.findCandidates();
      // W3 에서 여기 이후: candidates.forEach → push_jobs INSERT → APNs/FCM 발송
      this.logger.log(
        `[PushNotificationCron] 완료 · 발송 대상 user ${candidates.length}명 · 실제 send 는 W3`,
      );
    } catch (err) {
      this.logger.error(
        `[PushNotificationCron] 실패: ${(err as Error).message}`,
      );
    }
  }
}
