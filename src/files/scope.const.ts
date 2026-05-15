/**
 * 파일 업로드 시 허용되는 scope 화이트리스트.
 * presigned URL 발급 시 이 목록에 없는 scope는 거부 — path injection·권한 우회 차단.
 * 새 섹션 추가 시 여기에 추가하면 즉시 허용됨.
 */
export const ALLOWED_SCOPES = [
  'myinfo/cert',
  'myinfo/award',
  'myinfo/language-cert',
  'myinfo/document',
  'myinfo/education',
] as const;

export type AllowedScope = (typeof ALLOWED_SCOPES)[number];

export function isAllowedScope(scope: string): scope is AllowedScope {
  return (ALLOWED_SCOPES as readonly string[]).includes(scope);
}
