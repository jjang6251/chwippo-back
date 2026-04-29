import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() } as any;
    guard = new RolesGuard(reflector);
  });

  const createContext = (role?: string): ExecutionContext =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { role } : undefined }),
      }),
    }) as unknown as ExecutionContext;

  it('@Roles 미적용 시 requiredRoles가 undefined → true 반환', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(createContext('user'))).toBe(true);
  });

  it('@Roles([]) 빈 배열 → ForbiddenException ([].includes(role) = false)', () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    expect(() => guard.canActivate(createContext('user'))).toThrow(ForbiddenException);
  });

  it("requiredRoles=['admin'], user.role='admin' → true 반환", () => {
    reflector.getAllAndOverride.mockReturnValue(['admin']);
    expect(guard.canActivate(createContext('admin'))).toBe(true);
  });

  it("requiredRoles=['admin'], user.role='user' → ForbiddenException('접근 권한이 없습니다.')", () => {
    reflector.getAllAndOverride.mockReturnValue(['admin']);
    expect(() => guard.canActivate(createContext('user'))).toThrow(
      new ForbiddenException('접근 권한이 없습니다.'),
    );
  });

  it('requiredRoles=[admin], user가 undefined → ForbiddenException', () => {
    reflector.getAllAndOverride.mockReturnValue(['admin']);
    expect(() => guard.canActivate(createContext())).toThrow(ForbiddenException);
  });

  it('reflector.getAllAndOverride가 ROLES_KEY를 사용해 호출됨', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    guard.canActivate(createContext('user'));
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      ROLES_KEY,
      expect.any(Array),
    );
  });
});
