import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminAiUsageController } from './admin-ai-usage.controller';

/**
 * /admin/ai-usage 가드 검증 — memory `feedback_ai_usage_tracking_must` 의
 * "CEO admin /ai-usage 페이지에서 추적" 요건. 일반 사용자가 다른 사용자 비용 조회
 * 못 하도록 admin 역할 가드가 controller 와 각 method 모두에 걸려야 한다.
 */
describe('AdminAiUsageController — admin 권한 가드', () => {
  const reflector = new Reflector();

  it('controller 레벨 RolesGuard 가 적용돼 있다 (UseGuards)', () => {
    // @nestjs/common 이 메타데이터 key 로 저장하는 GUARDS_METADATA 상수
    const guards = Reflect.getMetadata('__guards__', AdminAiUsageController);
    expect(guards).toBeDefined();
    expect(guards.length).toBeGreaterThanOrEqual(1);
    // class·instance reference 둘 다 허용
    const hasRolesGuard = guards.some(
      (g: unknown) => g === RolesGuard || g instanceof RolesGuard,
    );
    expect(hasRolesGuard).toBe(true);
  });

  it('controller 레벨 @Roles("admin") 메타데이터 존재', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, AdminAiUsageController);
    expect(roles).toEqual(['admin']);
  });

  describe('method 레벨', () => {
    // 모든 endpoint 가 admin-only — class 레벨 @Roles 상속 보장 (override 없어야)
    const methods = [
      'overview',
      'byUser',
      'userDetail',
      'byModel',
      'byHour',
      'hallucination',
      'cacheHit',
      'monthEstimate',
    ] as const;
    it.each(methods)('%s — class 레벨 @Roles("admin") 가 적용된다', (m) => {
      const ctorRoles = reflector.get<string[]>(
        ROLES_KEY,
        AdminAiUsageController,
      );
      const methodRoles = reflector.get<string[]>(
        ROLES_KEY,
        AdminAiUsageController.prototype[m],
      );
      // 메소드 자체에 @Roles 없으면 class 레벨이 적용된다 (RolesGuard 가 fallback)
      const effective = methodRoles ?? ctorRoles;
      expect(effective).toEqual(['admin']);
    });
  });
});
