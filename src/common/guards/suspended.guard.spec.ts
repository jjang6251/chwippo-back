import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { SuspendedGuard } from './suspended.guard';
import { User } from '../../users/user.entity';

/**
 * PR_B2 Phase 1.5 — SuspendedGuard 시나리오 매트릭스.
 *
 * Q25 SuspendedModal bypass 방어 — frontend 우회 차단.
 */
describe('SuspendedGuard', () => {
  let guard: SuspendedGuard;
  let userRepo: jest.Mocked<Repository<User>>;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    userRepo = mock<Repository<User>>();
    reflector = mock<Reflector>();
    guard = new SuspendedGuard(reflector, userRepo);
  });

  const ctx = (userId: string | undefined): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user: userId ? { id: userId } : undefined }),
      }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    }) as unknown as ExecutionContext;

  it('@AllowSuspended endpoint → 통과', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);

    const result = await guard.canActivate(ctx('u-1'));

    expect(result).toBe(true);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('비로그인 → 통과 (다른 guard 가 처리)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    const result = await guard.canActivate(ctx(undefined));

    expect(result).toBe(true);
  });

  it('user 미존재 → 통과 (race / dirty read 안전)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    userRepo.findOne.mockResolvedValue(null);

    const result = await guard.canActivate(ctx('u-1'));

    expect(result).toBe(true);
  });

  it('정지 안 됨 → 통과', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    userRepo.findOne.mockResolvedValue({
      id: 'u-1',
      suspendedAt: null,
      suspendExpiresAt: null,
    } as User);

    const result = await guard.canActivate(ctx('u-1'));

    expect(result).toBe(true);
  });

  it('영구 정지 → ForbiddenException', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    userRepo.findOne.mockResolvedValue({
      id: 'u-1',
      suspendedAt: new Date(),
      suspendExpiresAt: null,
    } as User);

    await expect(guard.canActivate(ctx('u-1'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('만료 정지 (expires < NOW) → lazy auto-unsuspend + 통과', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    userRepo.findOne.mockResolvedValue({
      id: 'u-1',
      suspendedAt: new Date('2026-01-01'),
      suspendExpiresAt: new Date('2026-05-01'), // 과거
    } as User);

    const result = await guard.canActivate(ctx('u-1'));

    expect(result).toBe(true);
    expect(userRepo.update).toHaveBeenCalledWith(
      { id: 'u-1' },
      { suspendedAt: null, suspendReason: null, suspendExpiresAt: null },
    );
  });

  it('만료 안 된 정지 (expires > NOW) → ForbiddenException', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    userRepo.findOne.mockResolvedValue({
      id: 'u-1',
      suspendedAt: new Date('2026-06-01'),
      suspendExpiresAt: new Date(Date.now() + 86400000), // 1일 후
    } as User);

    await expect(guard.canActivate(ctx('u-1'))).rejects.toThrow(
      ForbiddenException,
    );
    expect(userRepo.update).not.toHaveBeenCalled();
  });
});
