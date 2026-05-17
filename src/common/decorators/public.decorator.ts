import { SetMetadata } from '@nestjs/common';

/**
 * 라우트를 인증 없이 호출 가능하게 표시.
 * JwtAuthGuard가 글로벌 적용되어 있어 기본은 모든 라우트 인증 필수 —
 * 이 데코레이터가 붙은 라우트만 우회.
 *
 * ⚠️ **신규 적용 시 의무 절차** (LRR P2T1 PR U):
 * 1. 정말 인증 없이 가능해야 하는지 확신 (대부분 No)
 * 2. PR 설명에 이유 명시 (OAuth callback·헬스체크 등)
 * 3. `company/09_security/security.md` §2.1 체크리스트의 @Public() 목록 갱신
 * 4. Code reviewer는 신규 @Public() 발견 시 위 항목 강제 확인
 *
 * 잘못 적용 시 모든 인증 우회 — 보안 critical 위험.
 *
 * **현재 적용 (2026-05-17, 5곳):**
 * - GET /auth/kakao (OAuth 시작)
 * - GET /auth/kakao/callback (OAuth callback)
 * - POST /auth/refresh (refresh cookie 자체가 인증)
 * - GET /health (Railway·Uptime Robot 헬스체크)
 * - GET /announcements/active (비로그인 랜딩에서도 공지 표시)
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
