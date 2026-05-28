import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminAuditService } from '../admin/admin-audit.service';
import { User } from '../users/user.entity';
import { UserAiQuota } from './entities/user-ai-quota.entity';

export interface ResetAiQuotaDto {
  /** undefined = 전체 사용자. UUID = 그 사용자만 */
  userId?: string;
}

export interface ResetAiQuotaResult {
  affected: number;
  scope: 'all_users' | 'single_user';
}

/**
 * F6 PR 2 Phase 5.6.9 — admin 가 사용자 AI 사용량 reset.
 *
 * **scope 2종**:
 * - `userId` 없음 → 전체 사용자 (모든 user_ai_quotas row UPDATE)
 * - `userId` 있음 → 그 사용자만 (row 있으면 UPDATE, 없으면 INSERT)
 *
 * **동작**: `quota_reset_at['*']` 에 현재 시각 저장. QuotaCheckService 가 dayUsed 계산 시
 * GREATEST(24h ago, reset_at) 적용 → reset 시각 이전 호출은 무시.
 *
 * **audit**: admin_audit_logs.action='reset_ai_quota' (targetType='user' or 'all_users').
 */
@Injectable()
export class AdminQuotaResetService {
  constructor(
    @InjectRepository(UserAiQuota)
    private readonly quotaRepo: Repository<UserAiQuota>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly audit: AdminAuditService,
  ) {}

  async reset(
    adminId: string,
    dto: ResetAiQuotaDto,
  ): Promise<ResetAiQuotaResult> {
    const nowIso = new Date().toISOString();

    if (!dto.userId) {
      // 5.6.9 fix — 전체 reset: UPDATE + INSERT 트랜잭션 wrap (all-or-nothing)
      const affected = await this.quotaRepo.manager.transaction(async (em) => {
        const updateResult = await em.query<{ user_id: string }[]>(
          `UPDATE user_ai_quotas
             SET quota_reset_at = COALESCE(quota_reset_at, '{}'::jsonb) || jsonb_build_object('*', $1::text)
           RETURNING user_id`,
          [nowIso],
        );
        const insertResult = await em.query<{ user_id: string }[]>(
          `INSERT INTO user_ai_quotas (user_id, daily_cap_override, valid_until, reason, quota_reset_at)
           SELECT u.id, NULL, NULL, 'manual_admin', jsonb_build_object('*', $1::text)
             FROM users u
            WHERE NOT EXISTS (SELECT 1 FROM user_ai_quotas q WHERE q.user_id = u.id)
           RETURNING user_id`,
          [nowIso],
        );
        return (
          (Array.isArray(updateResult) ? updateResult.length : 0) +
          (Array.isArray(insertResult) ? insertResult.length : 0)
        );
      });
      await this.audit.log(adminId, 'reset_ai_quota', 'all_users', 'all', {
        scope: 'all_users',
        affected,
        resetAt: nowIso,
      });
      return { affected, scope: 'all_users' };
    }

    // 특정 사용자 — UPSERT
    const existing = await this.quotaRepo.findOne({
      where: { userId: dto.userId },
    });
    if (existing) {
      existing.quotaResetAt = {
        ...(existing.quotaResetAt ?? {}),
        '*': nowIso,
      };
      await this.quotaRepo.save(existing);
    } else {
      // user 존재 검증 (FK 오류 방지)
      const user = await this.userRepo.findOne({
        where: { id: dto.userId },
        select: ['id'],
      });
      if (!user) {
        throw new NotFoundException(
          `사용자를 찾을 수 없습니다 (userId=${dto.userId}).`,
        );
      }
      const row = this.quotaRepo.create({
        userId: dto.userId,
        dailyCapOverride: null,
        validUntil: null,
        reason: 'manual_admin',
        quotaResetAt: { '*': nowIso },
      } as Partial<UserAiQuota>);
      await this.quotaRepo.save(row);
    }
    await this.audit.log(adminId, 'reset_ai_quota', 'user', dto.userId, {
      scope: 'single_user',
      affected: 1,
      resetAt: nowIso,
    });
    return { affected: 1, scope: 'single_user' };
  }
}
