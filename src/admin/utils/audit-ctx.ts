import type { Request } from 'express';

/**
 * PR_B2 Phase 0.3 — admin controller 의 `@Req()` 에서 audit ctx (IP + UA) 추출.
 *
 * **IP 추출 정책**:
 * - `req.ip` 사용 (Express 가 `trust proxy` 설정 따라 결정).
 * - `trust proxy` 미설정 시 = 직접 connect IP (안전, IP spoof X).
 * - `trust proxy` 설정 시 = X-Forwarded-For 헤더의 first IP. 잘못 설정 시 IP spoof 가능 → main.ts 의 설정 검증 필요.
 *
 * **UA**: `User-Agent` 헤더 그대로. 길이 cap 없음 (admin_audit_logs.user_agent TEXT 무제한).
 *
 * **PII 비저장**: IP/UA 는 운영 추적용. PII 관련 reason / memo 는 detail 에서 admin 가이드라인 명시.
 */
export function getAuditCtx(req: Request): {
  ip: string | null;
  userAgent: string | null;
} {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}
