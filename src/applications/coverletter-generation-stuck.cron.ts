import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

/**
 * PR_B1c Phase C — 자소서 생성 stuck timeout cron.
 *
 * **목적**: backend process crash / network 끊김 / LLM hang 등으로 status='in_progress' 영구 stuck 방지.
 *   lazy timeout (generateCoverletter 진입 시) 이 1차 방어, cron 이 background backup.
 *
 * **5분마다 실행**: started_at < NOW - 30min 인 in_progress row 모두 'failed' 처리.
 *   사용자 다음 진입 시 "다시 시도하기" UI 노출. 코인 차감 X (LLM 호출 미완료).
 *
 * **defensive**: started_at NULL 인 in_progress 도 좀비로 간주 + 'failed' 처리.
 */
@Injectable()
export class CoverletterGenerationStuckCron {
  private readonly logger = new Logger(CoverletterGenerationStuckCron.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron('*/5 * * * *')
  async runStuckTimeout(): Promise<void> {
    try {
      const result: unknown = await this.dataSource.query(
        `UPDATE applications
         SET coverletter_generation_status = 'failed'
         WHERE coverletter_generation_status = 'in_progress'
           AND (
             coverletter_generation_started_at < NOW() - INTERVAL '30 minutes'
             OR coverletter_generation_started_at IS NULL
           )
         RETURNING id`,
      );
      const count = Array.isArray(result) ? result.length : 0;
      if (count > 0) {
        this.logger.log(
          `[CoverletterGenerationStuckCron] stuck timeout ${count}건 'failed' 처리`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[CoverletterGenerationStuckCron] stuck timeout 실패: ${(err as Error).message}`,
      );
    }
  }
}
