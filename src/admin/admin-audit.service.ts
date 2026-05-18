import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AdminAuditLog, AuditAction } from './admin-audit-log.entity';

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly repo: Repository<AdminAuditLog>,
  ) {}

  /**
   * Audit log insert.
   * - manager 인자 시: 같은 트랜잭션 내 insert (caller의 액션과 원자적)
   * - manager 없으면: 별도 트랜잭션. 실패해도 throw X — caller 액션과 audit 일관성 깨지지 않게 best-effort.
   *   실패 시 logger.error로 운영자가 추적 가능.
   */
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
      // 트랜잭션 안에선 throw 허용 (caller가 같이 rollback해야 일관성 유지)
      await manager.save(AdminAuditLog, entry);
      return;
    }

    // 별도 트랜잭션: 실패해도 caller 액션은 이미 commit됨 → audit 누락만 발생
    // 사용자 응답은 정상 유지 + 운영자가 로그로 추적
    try {
      await this.repo.save(entry);
    } catch (err) {
      this.logger.error(
        `AdminAuditLog insert 실패 (action=${action}, targetType=${targetType}, targetId=${targetId}, adminUserId=${adminUserId}): ${
          (err as Error).message
        }`,
      );
    }
  }
}
