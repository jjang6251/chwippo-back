import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, Repository } from 'typeorm';
import { IsNull } from 'typeorm';
import { User } from './user.entity';
import { AdminAuditService } from '../admin/admin-audit.service';

/**
 * PR_B2 Phase 1 — 자동 unsuspend cron (매시간).
 *
 * `suspend_expires_at < NOW AND suspended_at IS NOT NULL` 인 user 일괄 해제.
 * audit `auto_unsuspend` (adminUserId=NULL — system 자동).
 *
 * lazy 도 SuspendedGuard 에서 동작 (me 호출 시 즉시 해제). cron 은 backup — guard 안 거치는 cron / external job 의 보호.
 */
@Injectable()
export class UnsuspendCron {
  private readonly logger = new Logger(UnsuspendCron.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly auditService: AdminAuditService,
  ) {}

  // 매시간 정각
  @Cron('0 * * * *', { timeZone: 'Asia/Seoul' })
  async sweep(): Promise<void> {
    const expired = await this.userRepo.find({
      where: {
        suspendedAt: Not(IsNull()),
        suspendExpiresAt: LessThan(new Date()),
      },
      select: ['id', 'suspendExpiresAt'],
    });

    if (expired.length === 0) return;

    this.logger.log(`자동 unsuspend ${expired.length}명`);

    for (const user of expired) {
      await this.userRepo.update(
        { id: user.id },
        {
          suspendedAt: null,
          suspendReason: null,
          suspendExpiresAt: null,
        },
      );
      await this.auditService.log(null, 'auto_unsuspend', 'user', user.id, {
        trigger: 'cron',
        expiredAt: user.suspendExpiresAt,
      });
    }
  }
}
