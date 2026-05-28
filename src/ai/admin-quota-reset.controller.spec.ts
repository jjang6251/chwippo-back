import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminQuotaResetController } from './admin-quota-reset.controller';

/**
 * F6 PR 2 Phase 5.6.9 — admin-quota-reset 권한 가드 검증.
 */
describe('AdminQuotaResetController', () => {
  const reflector = new Reflector();

  it('10) controller 레벨 RolesGuard + @Roles("admin") 적용', () => {
    const guards = Reflect.getMetadata('__guards__', AdminQuotaResetController);
    expect(guards).toBeDefined();
    expect(
      guards.some((g: unknown) => g === RolesGuard || g instanceof RolesGuard),
    ).toBe(true);
    const roles = reflector.get<string[]>(ROLES_KEY, AdminQuotaResetController);
    expect(roles).toEqual(['admin']);
  });

  it('11) reset method 가 class 레벨 @Roles("admin") 상속', () => {
    const ctorRoles = reflector.get<string[]>(
      ROLES_KEY,
      AdminQuotaResetController,
    );
    const methodRoles = reflector.get<string[]>(
      ROLES_KEY,
      AdminQuotaResetController.prototype.reset,
    );
    const effective = methodRoles ?? ctorRoles;
    expect(effective).toEqual(['admin']);
  });
});
