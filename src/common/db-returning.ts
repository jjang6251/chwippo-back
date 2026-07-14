/**
 * TypeORM Repository/EntityManager `.query()` 의 RETURNING 결과를 rows[] 로 정규화한다.
 *
 * postgres 드라이버는 커맨드 종류에 따라 반환 형태가 다르다:
 *  - UPDATE / DELETE ... RETURNING → `[rows[], affectedCount]` 튜플
 *  - SELECT / INSERT ... RETURNING → `rows[]` 직접
 *
 * 이 차이를 모르고 UPDATE 결과에 `result.length` 로 영향 행을 판정하면
 * 튜플이라 length 가 **항상 2** → 0행일 때도 "성공"으로 오판한다
 * (예: 재진입 락이 항상 획득 성공 처리되어 무력화). 실제 사고 사례 2026-07-14.
 *
 * 이 헬퍼는 튜플이면 rows 를, 순수 배열이면 그대로 반환하므로
 * UPDATE·DELETE·INSERT·SELECT 어디에 써도 안전하다.
 */
export function returningRows(result: unknown): unknown[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as unknown[];
  }
  return Array.isArray(result) ? (result as unknown[]) : [];
}
