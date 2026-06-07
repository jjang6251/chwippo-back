import { SetMetadata } from '@nestjs/common';

/**
 * PR_B2 Phase 1 — SuspendedGuard 우회 데코레이터.
 *
 * 정지된 사용자도 접근 허용해야 하는 endpoint 에 사용:
 * - POST /inquiry (SuspendedModal 의 "문의하기" link)
 * - POST /auth/logout
 * - GET /me / GET /me/coin-balance (modal 표시용 상태 조회)
 */
export const AllowSuspended = () => SetMetadata('allowSuspended', true);
