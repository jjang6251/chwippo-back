import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/user.entity';

/**
 * PR_B2 Phase 1 — SuspendedModal bypass 방어 (Q25 응급 보호).
 *
 * 모든 JWT 인증 endpoint 진입 시 user.suspendedAt 검증.
 * frontend modal 우회 (개발자 도구 dismiss 등) 차단.
 *
 * **lazy auto-unsuspend** — `suspend_expires_at < NOW` 면 즉시 해제 + 통과.
 *
 * **예외 endpoint** — `@AllowSuspended()` 데코레이터:
 * - POST /inquiry — 정지 user 도 문의 가능 (SuspendedModal 의 "문의하기" link)
 * - POST /auth/logout — 정지 user 도 로그아웃 가능
 * - GET /me/coin-balance / GET /me — 사용자 상태 표시 (modal 표시용)
 */
@Injectable()
export class SuspendedGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allow = this.reflector.getAllAndOverride<boolean>('allowSuspended', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allow) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: { id: string } }>();
    const userId = req.user?.id;
    if (!userId) return true; // 비로그인 — 다른 guard 가 처리

    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'suspendedAt', 'suspendExpiresAt'],
    });
    if (!user || !user.suspendedAt) return true;

    // lazy auto-unsuspend
    if (
      user.suspendExpiresAt &&
      user.suspendExpiresAt.getTime() <= Date.now()
    ) {
      await this.userRepo.update(
        { id: userId },
        { suspendedAt: null, suspendReason: null, suspendExpiresAt: null },
      );
      return true;
    }

    throw new ForbiddenException('정지된 계정입니다.');
  }
}
