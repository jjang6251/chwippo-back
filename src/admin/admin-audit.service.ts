import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AdminAuditLog, AuditAction } from './admin-audit-log.entity';

@Injectable()
export class AdminAuditService {
  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly repo: Repository<AdminAuditLog>,
  ) {}

  async log(
    adminUserId: string | null,
    action: AuditAction,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
    manager?: EntityManager,
  ): Promise<void> {
    const entry = Object.assign(new AdminAuditLog(), {
      adminUserId,
      action,
      targetType,
      targetId,
      detail,
    });

    if (manager) {
      await manager.save(AdminAuditLog, entry);
    } else {
      await this.repo.save(entry);
    }
  }
}
