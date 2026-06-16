import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, Repository } from 'typeorm';
import { AdminAuditLog } from './admin-audit-log.entity';

/**
 * PR_B2 Phase 4 — admin audit log 검색 (Q27 — 영구 보존 audit 의 admin 조회 UI 백엔드).
 *
 * 필터: action / adminId / targetId / from / to + page / limit.
 * 정렬 created_at desc + offset pagination.
 *
 * 보안:
 * - action / adminId / targetId 모두 parameterized query (SQL injection 방어)
 * - limit cap 100 (대량 export 방지)
 */
@Injectable()
export class AdminAuditLogsService {
  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly repo: Repository<AdminAuditLog>,
  ) {}

  async search(opts: {
    action?: string;
    adminId?: string;
    targetId?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    rows: AdminAuditLog[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const where: FindOptionsWhere<AdminAuditLog> = {};

    if (opts.action) where.action = opts.action as AdminAuditLog['action'];
    if (opts.adminId) where.adminUserId = opts.adminId;
    if (opts.targetId) where.targetId = opts.targetId;

    if (opts.from && opts.to) {
      where.createdAt = Between(new Date(opts.from), new Date(opts.to));
    } else if (opts.from) {
      where.createdAt = Between(new Date(opts.from), new Date('2100-01-01'));
    } else if (opts.to) {
      where.createdAt = Between(new Date('2000-01-01'), new Date(opts.to));
    }

    const [rows, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { rows, total, page, limit };
  }
}
