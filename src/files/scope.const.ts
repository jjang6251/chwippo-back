/**
 * 파일 업로드 scope 화이트리스트 + **scope 별 허용 MIME**.
 * presigned URL 발급 시 이 목록에 없는 scope는 거부 — path injection·권한 우회 차단.
 * 새 섹션 추가 시 여기에 추가하면 즉시 허용됨.
 *
 * ## 🔴 MIME 은 전역이 아니라 scope 마다 다르다
 *
 * 예전엔 서비스 안의 전역 3종(jpeg/png/pdf)이 모든 scope 에 똑같이 적용됐다.
 * 공부 노트 본문 이미지는 그 목록과 어긋난다 — PDF 는 본문에 그릴 수 없고,
 * webp 는 클라 압축 결과로 나온다. 한쪽에 맞춰 전역을 넓히면 다른 쪽이 같이
 * 넓어지므로(증빙 파일에 webp, 노트 본문에 pdf), 허용 목록을 scope 에 매단다.
 */

/** MIME → 저장 확장자. scope 가 허용한 MIME 만 여기서 확장자를 얻는다 */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export interface ScopeFilePolicy {
  /** 이 scope 가 허용하는 MIME. `MIME_EXTENSIONS` 에 없는 값은 확장자가 없어 실패한다 */
  readonly mimeTypes: readonly string[];
  /** 400 문구에 싣는, 사람이 읽는 형식 이름 */
  readonly label: string;
}

/** 내정보 창고 증빙 파일 — 기존 동작 그대로 (jpeg·png·pdf) */
const MYINFO_POLICY: ScopeFilePolicy = {
  mimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  label: 'PDF, JPG, PNG',
};

/**
 * 공부 노트 본문 이미지.
 *
 * | 제외 | 이유 |
 * |---|---|
 * | `application/pdf` | 본문에 그릴 수 없다 (증빙 파일과 다른 용도) |
 * | `image/svg+xml` | 스크립트 표면 — public 도메인으로 서빙되므로 열면 실행된다 |
 * | `image/gif` | 용량 (100MB 풀을 애니메이션 한 장이 먹는다) |
 */
const STUDY_NOTE_IMAGE_POLICY: ScopeFilePolicy = {
  // 프론트 `utils/imageCompress.ts` ALLOWED_IMAGE_TYPES 와 같은 값 — 한쪽만 바꾸면 발급 400
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  label: 'JPG, PNG, WEBP',
};

export const ALLOWED_SCOPES = [
  'myinfo/cert',
  'myinfo/award',
  'myinfo/language-cert',
  'myinfo/document',
  'myinfo/education',
  'study-note/image',
] as const;

export type AllowedScope = (typeof ALLOWED_SCOPES)[number];

/** scope 하나가 빠지면 컴파일이 깨진다 — 화이트리스트와 매트릭스가 어긋날 수 없다 */
export const SCOPE_FILE_POLICIES: Record<AllowedScope, ScopeFilePolicy> = {
  'myinfo/cert': MYINFO_POLICY,
  'myinfo/award': MYINFO_POLICY,
  'myinfo/language-cert': MYINFO_POLICY,
  'myinfo/document': MYINFO_POLICY,
  'myinfo/education': MYINFO_POLICY,
  'study-note/image': STUDY_NOTE_IMAGE_POLICY,
};

export function isAllowedScope(scope: string): scope is AllowedScope {
  return (ALLOWED_SCOPES as readonly string[]).includes(scope);
}

/**
 * 이 scope 에서 `contentType` 이 허용되면 저장 확장자, 아니면 `null`.
 * 허용 판정과 확장자 결정이 **한 지점**이라 둘이 어긋날 수 없다.
 */
export function resolveFileExtension(
  scope: AllowedScope,
  contentType: string,
): string | null {
  if (!SCOPE_FILE_POLICIES[scope].mimeTypes.includes(contentType)) return null;
  return MIME_EXTENSIONS[contentType] ?? null;
}

/** 400 문구용 형식 이름 ("PDF, JPG, PNG") */
export function getScopeFileLabel(scope: AllowedScope): string {
  return SCOPE_FILE_POLICIES[scope].label;
}
