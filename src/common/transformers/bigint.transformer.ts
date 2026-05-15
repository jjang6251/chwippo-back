/**
 * BIGINT 컬럼을 JS Number로 변환.
 * PostgreSQL BIGINT는 TypeORM 기본 동작으로 string 반환. 10MB 파일 크기 등 우리 도메인은 Number 안전 범위(2^53) 내라 변환 OK.
 */
export const BigIntTransformer = {
  to: (v: number | null | undefined) => v,
  from: (v: string | null) => (v == null ? null : Number(v)),
};
