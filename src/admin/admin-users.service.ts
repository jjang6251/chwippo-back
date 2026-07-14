import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UserCoinBalance } from '../ai/entities/user-coin-balance.entity';
import { Application } from '../applications/application.entity';
import { Inquiry } from '../inquiries/inquiry.entity';
import { AdminAuditService } from './admin-audit.service';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';
import { GrantCoinDto } from './dto/grant-coin.dto';
import { RevokeCoinDto } from './dto/revoke-coin.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';
import { ForceChangeTierDto } from './dto/force-change-tier.dto';
import { TierConfig, type CoinTier } from '../ai/entities/tier-config.entity';
import { UserProfile } from '../myinfo/entities/user-profile.entity';
import { Education } from '../myinfo/entities/education.entity';
import { Experience } from '../myinfo/entities/experience.entity';
import { Cert } from '../myinfo/entities/cert.entity';
import { LanguageCert } from '../myinfo/entities/language-cert.entity';
import { Award } from '../myinfo/entities/award.entity';
import { Document } from '../myinfo/entities/document.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { AdminNotifyService } from '../notifications/admin-notify.service';
import { AdminAuditLog } from './admin-audit-log.entity';
import { DiscordNotifier } from '../common/discord-notifier';

/** PR_B2 Phase 1 — Q24 사용자 통지 의 reason 한국어 라벨 매핑 */
const GRANT_REASON_LABEL: Record<string, string> = {
  refund: '환불',
  event: '이벤트',
  bonus: '보너스',
  abuser_compensation: '어뷰저 처리 보상',
  manual: '기타 수동',
};
const REVOKE_REASON_LABEL: Record<string, string> = {
  fraud: '부정 사용',
  mistake: '잘못 지급 회수',
  abuser: '어뷰저 처벌',
  manual: '기타 수동',
};

function escapeSearch(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function omitSensitive(
  user: User,
): Omit<User, 'kakaoId' | 'appleSub' | 'appleEmail'> {
  /* eslint-disable @typescript-eslint/no-unused-vars -- rest 분리로 민감 필드 제거 */
  const { kakaoId: _k, appleSub: _a, appleEmail: _ae, ...safe } = user;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return safe;
}

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(Inquiry)
    private readonly inquiryRepo: Repository<Inquiry>,
    @InjectRepository(Cert) private readonly certRepo: Repository<Cert>,
    @InjectRepository(Award) private readonly awardRepo: Repository<Award>,
    @InjectRepository(LanguageCert)
    private readonly langCertRepo: Repository<LanguageCert>,
    @InjectRepository(Experience)
    private readonly expRepo: Repository<Experience>,
    @InjectRepository(CoverletterCustom)
    private readonly coverCustomRepo: Repository<CoverletterCustom>,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectRepository(Education)
    private readonly eduRepo: Repository<Education>,
    private readonly dataSource: DataSource,
    private readonly auditService: AdminAuditService,
    private readonly storageUsage: StorageUsageService,
    private readonly adminNotify: AdminNotifyService,
    private readonly discord: DiscordNotifier,
  ) {}

  async findAll(query: {
    page?: number;
    limit?: number;
    search?: string;
    role?: string;
    suspended?: boolean;
  }): Promise<{ data: object[]; total: number }> {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(query.limit ?? 20, 100);

    const qb = this.userRepo
      .createQueryBuilder('u')
      .select([
        'u.id',
        'u.nickname',
        'u.email',
        'u.role',
        'u.suspendedAt',
        'u.createdAt',
        'u.lastActiveAt',
        // W1 — admin 직군 분포 가시화
        'u.signupJobCategories',
        'u.signupOtherText',
      ])
      .orderBy('u.lastActiveAt', 'DESC', 'NULLS LAST')
      .addOrderBy('u.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.search) {
      const escaped = escapeSearch(query.search);
      qb.andWhere("u.nickname ILIKE :search ESCAPE '\\'", {
        search: `%${escaped}%`,
      });
    }

    if (query.role) {
      qb.andWhere('u.role = :role', { role: query.role });
    }

    if (query.suspended === true) {
      qb.andWhere('u.suspendedAt IS NOT NULL');
    } else if (query.suspended === false) {
      qb.andWhere('u.suspendedAt IS NULL');
    }

    const [users, total] = await qb.getManyAndCount();
    return { data: users.map(omitSensitive), total };
  }

  async findOne(id: string): Promise<object> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    const [
      storage,
      applicationCount,
      cert,
      award,
      langCert,
      experience,
      coverletterCustom,
      document,
      education,
    ] = await Promise.all([
      this.storageUsage.getUsage(id),
      this.appRepo.count({ where: { userId: id, deletedAt: IsNull() } }),
      this.certRepo.count({ where: { user_id: id } }),
      this.awardRepo.count({ where: { user_id: id } }),
      this.langCertRepo.count({ where: { user_id: id } }),
      this.expRepo.count({ where: { user_id: id } }),
      this.coverCustomRepo.count({ where: { user_id: id } }),
      this.docRepo.count({ where: { user_id: id } }),
      this.eduRepo.count({ where: { user_id: id } }),
    ]);

    return {
      ...omitSensitive(user),
      stats: {
        storage,
        applicationCount,
        myinfoCount: {
          cert,
          award,
          languageCert: langCert,
          experience,
          coverletterCustom,
          document,
          education,
        },
      },
    };
  }

  async updateUser(
    adminId: string,
    userId: string,
    dto: UpdateAdminUserDto,
  ): Promise<void> {
    if (
      adminId === userId &&
      (dto.suspended !== undefined || dto.role !== undefined)
    ) {
      throw new ForbiddenException(
        '자기 자신의 정지·권한은 변경할 수 없습니다.',
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

      if (dto.suspended === true && !user.suspendedAt) {
        user.suspendedAt = new Date();
        await manager.save(User, user);
        await this.auditService.log(
          adminId,
          'suspend',
          'user',
          userId,
          {},
          manager,
        );
      }

      if (dto.suspended === false && user.suspendedAt) {
        user.suspendedAt = null;
        await manager.save(User, user);
        await this.auditService.log(
          adminId,
          'unsuspend',
          'user',
          userId,
          {},
          manager,
        );
      }

      if (dto.role !== undefined && dto.role !== user.role) {
        const action = dto.role === 'admin' ? 'grant_admin' : 'revoke_admin';
        const before = user.role;
        user.role = dto.role;
        await manager.save(User, user);
        await this.auditService.log(
          adminId,
          action,
          'user',
          userId,
          { before, after: dto.role },
          manager,
        );
      }

      if (dto.tier !== undefined && dto.tier !== user.tier) {
        const before = user.tier;
        user.tier = dto.tier;
        await manager.save(User, user);
        await this.auditService.log(
          adminId,
          'update_tier',
          'user',
          userId,
          { before, after: dto.tier },
          manager,
        );
      }

      if (dto.nickname !== undefined) {
        if (dto.nickname.trim().length === 0) {
          throw new BadRequestException('닉네임은 빈 값일 수 없습니다.');
        }
        if (dto.nickname.length > 100) {
          throw new BadRequestException('닉네임은 100자를 초과할 수 없습니다.');
        }
        if (dto.nickname !== user.nickname) {
          const before = user.nickname;
          user.nickname = dto.nickname;
          await manager.save(User, user);
          await this.auditService.log(
            adminId,
            'rename',
            'user',
            userId,
            { before, after: dto.nickname },
            manager,
          );
        }
      }
    });
  }

  async deleteUser(adminId: string, userId: string): Promise<void> {
    if (adminId === userId) {
      throw new ForbiddenException('자기 자신의 계정은 삭제할 수 없습니다.');
    }

    await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

      await this.auditService.log(
        adminId,
        'delete',
        'user',
        userId,
        {},
        manager,
      );
      await manager.remove(User, user);
    });
  }

  async warnUser(
    adminId: string,
    userId: string,
    message: string,
  ): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    await this.auditService.log(adminId, 'warn', 'user', userId, { message });
  }

  async exportUser(
    adminId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    const [
      applications,
      inquiries,
      profile,
      educations,
      experiences,
      certs,
      languageCerts,
      awards,
      documents,
      coverletters,
    ] = await Promise.all([
      this.appRepo.find({ where: { userId } }),
      this.inquiryRepo.find({ where: { user_id: userId } }),
      this.dataSource.manager.findOne(UserProfile, {
        where: { user_id: userId },
      }),
      this.dataSource.manager.find(Education, { where: { user_id: userId } }),
      this.dataSource.manager.find(Experience, { where: { user_id: userId } }),
      this.dataSource.manager.find(Cert, { where: { user_id: userId } }),
      this.dataSource.manager.find(LanguageCert, {
        where: { user_id: userId },
      }),
      this.dataSource.manager.find(Award, { where: { user_id: userId } }),
      this.dataSource.manager.find(Document, { where: { user_id: userId } }),
      this.dataSource.manager.find(CoverletterCustom, {
        where: { user_id: userId },
        order: { order_index: 'ASC' },
      }),
    ]);

    await this.auditService.log(adminId, 'export', 'user', userId, {});

    return {
      user: omitSensitive(user),
      applications,
      inquiries,
      myinfo: {
        profile,
        educations,
        experiences,
        certs,
        languageCerts,
        awards,
        documents,
        coverletters,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // PR_B2 Phase 1 — 코인 grant/revoke + suspend/unsuspend + detail
  // 모든 액션: 같은 TX 안 (caller + pending_notification + audit). IP/UA ctx 전달
  // ─────────────────────────────────────────────────────────────────────

  /** 마지막 admin 보호 검증 (role 박탈 / suspend / delete 진입 전 사용) */
  private async assertNotLastAdmin(targetUserId: string): Promise<void> {
    const remainingAdmins = await this.userRepo.count({
      where: { role: 'admin' as never },
    });
    if (remainingAdmins <= 1) {
      throw new ForbiddenException(
        '마지막 관리자는 박탈/정지/삭제할 수 없습니다.',
      );
    }
    // findOne 으로 target 의 role 검증은 caller 가 수행
    void targetUserId;
  }

  /** PR_B2 Phase 1 — admin 코인 수동 지급. */
  async grantCoin(
    adminId: string,
    targetUserId: string,
    dto: GrantCoinDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<{ balance: number; granted: number }> {
    // 셀프 지급 허용 (CEO 확정 B안) — 1인 운영 도그푸딩 편의.
    // 차단 대신 audit selfGrant 플래그 + Discord critical 즉시 알림으로 투명성 강제.
    // 협업 admin 도입 시 재차단 여부 재결정 (revoke/suspend/role/delete 의 셀프 가드는 유지).
    const selfGrant = adminId === targetUserId;

    const result = await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: targetUserId } });
      if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

      // balance row lazy 생성 (legacy user 호환)
      let balance = await manager.findOne(UserCoinBalance, {
        where: { userId: targetUserId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!balance) {
        balance = manager.create(UserCoinBalance, {
          userId: targetUserId,
          tier: user.tier,
          balance: '0',
          nextResetAt: new Date(),
        });
        await manager.save(UserCoinBalance, balance);
      }

      const before = Number(balance.balance);
      const after = before + dto.amount;
      await manager.update(
        UserCoinBalance,
        { userId: targetUserId },
        { balance: after.toFixed(1) },
      );

      // 사용자 통지 — me 호출 시 모달 1회 (Q24)
      const grantReasonLabel = GRANT_REASON_LABEL[dto.reason] ?? dto.reason;
      const grantBody = dto.memo
        ? `${dto.amount} 코인이 지급되었습니다.\n사유: ${grantReasonLabel}\n메모: ${dto.memo}`
        : `${dto.amount} 코인이 지급되었습니다.\n사유: ${grantReasonLabel}`;
      await manager.update(
        User,
        { id: targetUserId },
        {
          pendingNotification: {
            type: 'coin_grant',
            title: '코인이 지급되었어요',
            body: grantBody,
            createdAt: new Date().toISOString(),
          },
        },
      );

      await this.auditService.log(
        adminId,
        'grant_coin',
        'user',
        targetUserId,
        {
          amount: dto.amount,
          reason: dto.reason,
          memo: dto.memo,
          balanceBefore: before,
          balanceAfter: after,
          selfGrant,
        },
        manager,
        ctx,
      );

      return { balance: after, granted: dto.amount, before, after };
    });

    // 셀프 지급 시 Discord critical 알림 — TX 커밋 후 발송 (외부 호출은 TX 밖).
    // best-effort: 발송 실패해도 지급 결과에 영향 없음.
    if (selfGrant) {
      const grantReasonLabel = GRANT_REASON_LABEL[dto.reason] ?? dto.reason;
      try {
        await this.discord.notify(
          {
            title: '🪙 admin 셀프 코인 지급',
            fields: [
              { name: 'adminId(=수령자)', value: adminId, inline: false },
              { name: 'amount', value: String(dto.amount), inline: true },
              { name: 'reason', value: grantReasonLabel, inline: true },
              {
                name: 'balance',
                value: `${result.before} → ${result.after}`,
                inline: false,
              },
            ],
          },
          'critical',
        );
      } catch (err) {
        this.logger.warn(
          `셀프 코인 지급 Discord 알림 실패 (adminId=${adminId}): ${(err as Error).message}`,
        );
      }
    }

    return { balance: result.balance, granted: result.granted };
  }

  /** PR_B2 Phase 1 — admin 코인 환수 (Q12 별도 액션, Q26 clamp 0, balance<=0 reject). */
  async revokeCoin(
    adminId: string,
    targetUserId: string,
    dto: RevokeCoinDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<{ balance: number; actualRevoked: number; requested: number }> {
    if (adminId === targetUserId) {
      throw new ForbiddenException(
        '자기 자신에게는 코인 환수를 할 수 없습니다.',
      );
    }

    return await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: targetUserId } });
      if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

      const balance = await manager.findOne(UserCoinBalance, {
        where: { userId: targetUserId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!balance) {
        throw new BadRequestException('사용자 잔여 코인 정보가 없습니다.');
      }
      const before = Number(balance.balance);
      if (before <= 0) {
        throw new BadRequestException(
          '잔여 코인이 이미 0 이하입니다. 환수할 수 없습니다.',
        );
      }
      const after = Math.max(0, before - dto.amount);
      const actualRevoked = before - after;

      await manager.update(
        UserCoinBalance,
        { userId: targetUserId },
        { balance: after.toFixed(1) },
      );

      // 사용자 통지 — me 호출 시 모달 1회 (Q24)
      const revokeReasonLabel = REVOKE_REASON_LABEL[dto.reason] ?? dto.reason;
      const revokeBody = dto.memo
        ? `${actualRevoked} 코인이 회수되었습니다.\n사유: ${revokeReasonLabel}\n메모: ${dto.memo}`
        : `${actualRevoked} 코인이 회수되었습니다.\n사유: ${revokeReasonLabel}`;
      await manager.update(
        User,
        { id: targetUserId },
        {
          pendingNotification: {
            type: 'coin_revoke',
            title: '잔여 코인이 조정되었습니다',
            body: revokeBody,
            createdAt: new Date().toISOString(),
          },
        },
      );

      await this.auditService.log(
        adminId,
        'revoke_coin',
        'user',
        targetUserId,
        {
          requested: dto.amount,
          actualRevoked,
          reason: dto.reason,
          memo: dto.memo,
          before,
          after,
        },
        manager,
        ctx,
      );

      return { balance: after, actualRevoked, requested: dto.amount };
    });
  }

  /** PR_B2 Phase 1 — admin 사용자 정지 (Q13 + Q25). */
  async suspendUser(
    adminId: string,
    targetUserId: string,
    dto: SuspendUserDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<{
    suspendedAt: Date;
    suspendReason: string;
    suspendExpiresAt: Date | null;
  }> {
    if (adminId === targetUserId) {
      throw new ForbiddenException('자기 자신은 정지할 수 없습니다.');
    }
    if (dto.expiresAt) {
      const exp = new Date(dto.expiresAt);
      if (exp.getTime() <= Date.now()) {
        throw new BadRequestException('expiresAt 은 현재 이후여야 합니다.');
      }
    }

    const { result, wasSuspended } = await this.dataSource.transaction(
      async (manager) => {
        const target = await manager.findOne(User, {
          where: { id: targetUserId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!target) throw new NotFoundException('사용자를 찾을 수 없습니다.');

        // Q25 — admin 끼리 정지 차단
        if (target.role === 'admin') {
          throw new ForbiddenException('admin 계정은 정지할 수 없습니다.');
        }

        const wasSuspended = target.suspendedAt !== null;
        const now = wasSuspended ? target.suspendedAt! : new Date();
        const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

        await manager.update(
          User,
          { id: targetUserId },
          {
            suspendedAt: now,
            suspendReason: dto.reason,
            suspendExpiresAt: expiresAt,
          },
        );

        const action = wasSuspended ? 'update_suspend_reason' : 'suspend';
        await this.auditService.log(
          adminId,
          action,
          'user',
          targetUserId,
          wasSuspended
            ? {
                before: {
                  reason: target.suspendReason,
                  expiresAt: target.suspendExpiresAt,
                },
                after: { reason: dto.reason, expiresAt },
              }
            : { reason: dto.reason, expiresAt },
          manager,
          ctx,
        );

        return {
          result: {
            suspendedAt: now,
            suspendReason: dto.reason,
            suspendExpiresAt: expiresAt,
          },
          wasSuspended,
        };
      },
    );

    // 신규 정지만 즉시 통지 (재정지·사유변경은 재발송 안 함). best-effort.
    if (!wasSuspended) {
      await this.adminNotify
        .notifySuspended(targetUserId, dto.reason)
        .catch(() => undefined);
    }

    return result;
  }

  /**
   * PR_B2 Phase 3 — admin 의 사용자 tier 강제 변경 (Q11 planExpiresAt + Q2 B applyMode).
   *
   * 정책:
   * - newTier === user.tier → no-op (audit X)
   * - applyMode='next_cycle' + downgrade → 현재 cycle 유지 + plan_expires_at 셋팅
   * - applyMode='immediate' → 즉시 변경 + balance 새 tier monthly_coin_limit reset
   * - applyMode='immediate' + upgrade → balance reset + plan_started_at=NOW
   * - planExpiresAt default = 30일 후 (Q11)
   *
   * 사용자 통지 pending_notification 자동 셋팅. audit `change_plan_with_expires` 또는 `force_plan_downgrade`.
   */
  async forceChangeTier(
    adminId: string,
    targetUserId: string,
    dto: ForceChangeTierDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<{
    tier: CoinTier;
    planExpiresAt: Date | null;
    applyMode: 'immediate' | 'next_cycle';
  }> {
    if (adminId === targetUserId) {
      throw new ForbiddenException('자기 자신의 tier 는 변경할 수 없습니다.');
    }

    return await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: targetUserId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

      const fromTier = user.tier;
      const newTier = dto.newTier;

      if (fromTier === newTier) {
        return {
          tier: fromTier,
          planExpiresAt: null,
          applyMode: dto.applyMode,
        };
      }

      const isDowngrade =
        (fromTier === 'standard' && newTier !== 'standard') ||
        (fromTier === 'lite' && newTier === 'free');

      // tier_config 의 monthly_coin_limit 조회 (immediate upgrade 시 balance reset 용)
      const newTierConfig = await manager.findOne(TierConfig, {
        where: { tier: newTier },
      });
      if (!newTierConfig) {
        throw new NotFoundException(
          `tier_config 가 없습니다: ${newTier} (admin 검수 필요)`,
        );
      }

      const balance = await manager.findOne(UserCoinBalance, {
        where: { userId: targetUserId },
        lock: { mode: 'pessimistic_write' },
      });

      const applyImmediate = dto.applyMode === 'immediate' || !isDowngrade;

      /**
       * planExpiresAt 계산:
       * - newTier='free' + immediate: NULL (무료 무기한)
       * - newTier='free' + next_cycle: balance.next_reset_at (현재 cycle 끝 → 자동 강등)
       * - newTier=lite/standard: admin 명시 또는 default 30일
       */
      let planExpiresAt: Date | null;
      if (newTier === 'free' && applyImmediate) {
        planExpiresAt = null;
      } else if (newTier === 'free' && !applyImmediate) {
        planExpiresAt =
          balance?.nextResetAt ?? new Date(Date.now() + 30 * 86400000);
      } else {
        planExpiresAt = dto.planExpiresAt
          ? new Date(dto.planExpiresAt)
          : new Date(Date.now() + 30 * 86400000);
        if (planExpiresAt.getTime() <= Date.now()) {
          throw new BadRequestException('planExpiresAt 은 미래여야 합니다.');
        }
      }

      if (applyImmediate) {
        await manager.update(User, { id: targetUserId }, { tier: newTier });
        if (balance) {
          // immediate: balance = 새 tier monthly_coin_limit 로 reset (upgrade 시 즉시 부여)
          await manager.update(
            UserCoinBalance,
            { userId: targetUserId },
            {
              tier: newTier,
              balance: newTierConfig.monthlyCoinLimit,
              planStartedAt: newTier === 'free' ? null : new Date(),
              planExpiresAt,
            },
          );
        }
      } else {
        // next_cycle downgrade: tier 그대로 + plan_expires_at 셋팅 → CoinResetCron 자동 강등
        if (balance) {
          await manager.update(
            UserCoinBalance,
            { userId: targetUserId },
            { planExpiresAt },
          );
        }
      }

      // 사용자 통지 (Q24)
      const action = isDowngrade ? 'tier_downgrade' : 'tier_upgrade';
      const title = isDowngrade
        ? 'plan 이 변경되었습니다'
        : '축하해요! tier 가 변경되었습니다';
      const body = applyImmediate
        ? `${fromTier} → ${newTier} (즉시 적용)\n사유: ${dto.reason}`
        : `${fromTier} → ${newTier} (다음 cycle 부터 적용)\n현재 cycle 끝까지 ${fromTier} tier 유지\n사유: ${dto.reason}`;
      await manager.update(
        User,
        { id: targetUserId },
        {
          pendingNotification: {
            type: action,
            title,
            body,
            createdAt: new Date().toISOString(),
          },
        },
      );

      // audit
      const auditAction = isDowngrade
        ? 'force_plan_downgrade'
        : 'change_plan_with_expires';
      await this.auditService.log(
        adminId,
        auditAction,
        'user',
        targetUserId,
        {
          fromTier,
          toTier: newTier,
          planExpiresAt,
          applyMode: dto.applyMode,
          appliedImmediately: applyImmediate,
          reason: dto.reason,
        },
        manager,
        ctx,
      );

      return { tier: newTier, planExpiresAt, applyMode: dto.applyMode };
    });
  }

  /** PR_B2 Phase 1 — 사용자 상세 (Q6 — 모든 항목 aggregate). */
  async getUserDetail(targetUserId: string): Promise<unknown> {
    const user = await this.userRepo.findOne({ where: { id: targetUserId } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    const [
      applicationCount,
      coverletterQuestionStats,
      interviewPrepCount,
      activityLogCount,
      inquiries,
      coinBalance,
      auditLogs,
    ] = await Promise.all([
      this.appRepo.count({
        where: { userId: targetUserId, deletedAt: IsNull() as never },
      }),
      // 자소서 = application_coverletters 의 user 별 (application JOIN). 작성 회사 수 + 답변 작성 문항 수
      this.dataSource.query<
        Array<{ total: string; companies: string; answered: string }>
      >(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(DISTINCT ac.application_id)::text AS companies,
           COUNT(*) FILTER (WHERE ac.answer IS NOT NULL AND TRIM(ac.answer) <> '')::text AS answered
         FROM application_coverletters ac
         INNER JOIN applications a ON a.id = ac.application_id
         WHERE a.user_id = $1 AND a.deleted_at IS NULL`,
        [targetUserId],
      ),
      this.dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::text FROM interview_prep_sessions WHERE user_id = $1`,
        [targetUserId],
      ),
      this.dataSource.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::text FROM activity_logs WHERE user_id = $1`,
        [targetUserId],
      ),
      this.inquiryRepo.find({
        where: { user_id: targetUserId },
        order: { created_at: 'DESC' },
        take: 20,
      }),
      this.dataSource.getRepository(UserCoinBalance).findOne({
        where: { userId: targetUserId },
      }),
      this.dataSource.getRepository(AdminAuditLog).find({
        where: { targetType: 'user', targetId: targetUserId },
        order: { createdAt: 'DESC' },
        take: 50,
      }),
    ]);

    const cl = coverletterQuestionStats[0] ?? {
      total: '0',
      companies: '0',
      answered: '0',
    };

    return {
      basic: omitSensitive(user),
      coinBalance: coinBalance
        ? {
            balance: parseFloat(coinBalance.balance),
            tier: coinBalance.tier,
            nextResetAt: coinBalance.nextResetAt,
            planExpiresAt: coinBalance.planExpiresAt,
          }
        : null,
      inquiries,
      auditLogs,
      activityStats: {
        applicationCount,
        coverletterQuestionTotal: parseInt(cl.total, 10),
        coverletterCompanies: parseInt(cl.companies, 10),
        coverletterAnswered: parseInt(cl.answered, 10),
        interviewPrepCount: parseInt(interviewPrepCount[0]?.count ?? '0', 10),
        activityLogCount: parseInt(activityLogCount[0]?.count ?? '0', 10),
      },
    };
  }

  /** PR_B2 Phase 1 — admin 정지 해제. */
  async unsuspendUser(
    adminId: string,
    targetUserId: string,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<{ ok: true }> {
    const didUnsuspend = await this.dataSource.transaction(async (manager) => {
      const target = await manager.findOne(User, {
        where: { id: targetUserId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!target) throw new NotFoundException('사용자를 찾을 수 없습니다.');

      // idempotent — 정지 안 됨 시 audit 미발생
      if (target.suspendedAt === null) {
        return false;
      }

      await manager.update(
        User,
        { id: targetUserId },
        {
          suspendedAt: null,
          suspendReason: null,
          suspendExpiresAt: null,
        },
      );

      await this.auditService.log(
        adminId,
        'unsuspend',
        'user',
        targetUserId,
        {
          previousReason: target.suspendReason,
          previousExpiresAt: target.suspendExpiresAt,
        },
        manager,
        ctx,
      );

      return true;
    });

    // 실제 해제된 경우만 통지 (idempotent no-op 은 제외). best-effort.
    if (didUnsuspend) {
      await this.adminNotify
        .notifyUnsuspended(targetUserId)
        .catch(() => undefined);
    }

    return { ok: true };
  }
}
