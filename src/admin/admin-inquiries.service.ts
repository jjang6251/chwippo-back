import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { Inquiry, SLA_DEFAULT_HOURS } from '../inquiries/inquiry.entity';
import { User } from '../users/user.entity';
import { AdminAuditService } from './admin-audit.service';
import { AssignInquiryDto } from './dto/assign-inquiry.dto';
import { SetPriorityDto } from './dto/set-priority.dto';
import { SetSlaDto } from './dto/set-sla.dto';

/**
 * PR_B2 Phase 4 — admin inquiry 처리 (assign / priority / SLA).
 *
 * 정책:
 * - assign: assigned_to 가 admin role 가진 user 인지 검증
 * - priority 변경 시 recalcSla=true 면 SLA deadline 도 새 priority default 로 재계산
 * - SLA 직접 set 가능 — past 거부, >1년 거부
 * - sla-overdue 조회: NOW > sla_deadline_at AND status != 'CLOSED'
 *
 * 모든 액션 TX + audit (`assign_inquiry` / `set_inquiry_priority` / `set_inquiry_sla`) + IP/UA.
 */
@Injectable()
export class AdminInquiriesService {
  constructor(
    @InjectRepository(Inquiry)
    private readonly inquiryRepo: Repository<Inquiry>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly auditService: AdminAuditService,
  ) {}

  async assignInquiry(
    adminId: string,
    inquiryId: string,
    dto: AssignInquiryDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<Inquiry> {
    return await this.dataSource.transaction(async (manager) => {
      const inquiry = await manager.findOne(Inquiry, {
        where: { id: inquiryId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!inquiry) throw new NotFoundException('문의를 찾을 수 없습니다.');

      // idempotent — same target (audit / 검증 모두 skip)
      const fromAssignedTo = inquiry.assignedTo;
      if (fromAssignedTo === dto.assignedTo) {
        return inquiry;
      }

      // null → unassign (검증 skip), 그 외 admin role 검증
      if (dto.assignedTo) {
        const assignee = await manager.findOne(User, {
          where: { id: dto.assignedTo },
        });
        if (!assignee)
          throw new BadRequestException('담당자 user 가 없습니다.');
        if (assignee.role !== 'admin') {
          throw new ForbiddenException('담당자는 admin role 이어야 합니다.');
        }
      }

      await manager.update(
        Inquiry,
        { id: inquiryId },
        { assignedTo: dto.assignedTo },
      );

      await this.auditService.log(
        adminId,
        'assign_inquiry',
        'inquiry',
        inquiryId,
        {
          fromAssignedTo,
          toAssignedTo: dto.assignedTo,
        },
        manager,
        ctx,
      );

      return { ...inquiry, assignedTo: dto.assignedTo };
    });
  }

  async setPriority(
    adminId: string,
    inquiryId: string,
    dto: SetPriorityDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<Inquiry> {
    return await this.dataSource.transaction(async (manager) => {
      const inquiry = await manager.findOne(Inquiry, {
        where: { id: inquiryId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!inquiry) throw new NotFoundException('문의를 찾을 수 없습니다.');

      if (inquiry.priority === dto.priority && !dto.recalcSla) {
        return inquiry; // idempotent
      }

      const updates: Partial<Inquiry> = { priority: dto.priority };
      let newSlaDeadline: Date | null = null;
      if (dto.recalcSla) {
        newSlaDeadline = new Date(
          Date.now() + SLA_DEFAULT_HOURS[dto.priority] * 3600 * 1000,
        );
        updates.slaDeadlineAt = newSlaDeadline;
      }

      await manager.update(Inquiry, { id: inquiryId }, updates);

      await this.auditService.log(
        adminId,
        'set_inquiry_priority',
        'inquiry',
        inquiryId,
        {
          fromPriority: inquiry.priority,
          toPriority: dto.priority,
          recalcSla: !!dto.recalcSla,
          newSlaDeadline,
        },
        manager,
        ctx,
      );

      return { ...inquiry, ...updates };
    });
  }

  async setSla(
    adminId: string,
    inquiryId: string,
    dto: SetSlaDto,
    ctx?: { ip?: string | null; userAgent?: string | null },
  ): Promise<Inquiry> {
    const deadlineAt = new Date(dto.deadlineAt);
    if (deadlineAt.getTime() <= Date.now()) {
      throw new BadRequestException('SLA deadline 은 미래여야 합니다.');
    }
    const oneYear = 365 * 86400000;
    if (deadlineAt.getTime() - Date.now() > oneYear) {
      throw new BadRequestException('SLA deadline 은 1년 이내여야 합니다.');
    }

    return await this.dataSource.transaction(async (manager) => {
      const inquiry = await manager.findOne(Inquiry, {
        where: { id: inquiryId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!inquiry) throw new NotFoundException('문의를 찾을 수 없습니다.');

      await manager.update(
        Inquiry,
        { id: inquiryId },
        { slaDeadlineAt: deadlineAt },
      );

      await this.auditService.log(
        adminId,
        'set_inquiry_sla',
        'inquiry',
        inquiryId,
        {
          fromSlaDeadlineAt: inquiry.slaDeadlineAt,
          toSlaDeadlineAt: deadlineAt,
        },
        manager,
        ctx,
      );

      return { ...inquiry, slaDeadlineAt: deadlineAt };
    });
  }

  /** sla-overdue — NOW > sla_deadline_at AND status != 'CLOSED'. 정렬 deadline asc. */
  async getSlaOverdue(): Promise<Inquiry[]> {
    return await this.inquiryRepo
      .createQueryBuilder('i')
      .where('i.sla_deadline_at IS NOT NULL')
      .andWhere('i.sla_deadline_at < NOW()')
      .andWhere('i.status != :closed', { closed: 'CLOSED' })
      .orderBy('i.sla_deadline_at', 'ASC')
      .getMany();
  }

  /** PR_B2 Phase 4 — admin role 목록 (assign dropdown 용). */
  async listAdmins(): Promise<Array<{ id: string; nickname: string }>> {
    const admins = await this.userRepo.find({
      where: { role: 'admin' },
      select: ['id', 'nickname'],
      order: { nickname: 'ASC' },
    });
    return admins.map((a) => ({ id: a.id, nickname: a.nickname }));
  }

  /** notifications/badges — 4 count (assigned/unassigned/overdue/admin_unread). O(1) 정렬 빠른 COUNT. */
  async getNotificationBadges(): Promise<{
    inquiriesOpen: number;
    inquiriesUnassigned: number;
    slaOverdue: number;
    adminUnread: number;
  }> {
    const [
      inquiriesOpen,
      inquiriesUnassigned,
      slaOverdueRows,
      adminUnreadRows,
    ] = await Promise.all([
      this.inquiryRepo.count({ where: { status: Not('CLOSED') } }),
      this.inquiryRepo.count({
        where: { status: Not('CLOSED'), assignedTo: IsNull() },
      }),
      this.inquiryRepo
        .createQueryBuilder('i')
        .where('i.sla_deadline_at IS NOT NULL')
        .andWhere('i.sla_deadline_at < NOW()')
        .andWhere('i.status != :closed', { closed: 'CLOSED' })
        .getCount(),
      this.inquiryRepo
        .createQueryBuilder('i')
        .where('i.admin_unread > 0')
        .getCount(),
    ]);
    return {
      inquiriesOpen,
      inquiriesUnassigned,
      slaOverdue: slaOverdueRows,
      adminUnread: adminUnreadRows,
    };
  }
}
