import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CoverletterChatService } from './coverletter-chat.service';

/**
 * F1 자소서 풀페이지 Phase D — 채팅 메시지 90일 KST 자동 cleanup cron.
 *
 * **실행 시각**: 매일 KST 03:00 (timeZone 명시 — 서버 TZ 무관)
 * **삭제 기준**: application 마지막 활동 + 90일 inactive (옵션 B)
 *   = 가장 최근 메시지 created_at < (NOW() KST - 90 days) 인 application 의 모든 메시지
 * **영향 범위**:
 *   ✓ coverletter_chat_messages 만 (application 단위)
 *   ✗ 다른 테이블 (applications / coverletters / activity_logs / llm_call_logs) — 0 건
 *   ✗ 활발한 자소서 (89일 이내 활동) — 0 건
 *   ✗ 다른 user 영향 — 0 건
 * **재시도**: cron 실패 시 다음 날 재실행 (멱등). 호출 자체가 추가 메시지 안 생성.
 */
@Injectable()
export class CoverletterChatCleanupCron {
  private readonly logger = new Logger(CoverletterChatCleanupCron.name);

  constructor(private readonly chat: CoverletterChatService) {}

  @Cron('0 0 3 * * *', { timeZone: 'Asia/Seoul' })
  async tick(): Promise<void> {
    try {
      const result = await this.chat.cleanupOldMessages();
      this.logger.log(
        `cleanup 완료 — deleted=${result.deleted}, applications=${result.applicationIds.length}`,
      );
    } catch (err) {
      this.logger.error(
        `cleanup 실패 (재시도 다음 날): ${(err as Error).message}`,
      );
    }
  }
}
