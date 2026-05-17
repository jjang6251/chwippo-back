/**
 * E2E DB seed/cleanup 헬퍼 (LRR P2T1 PR P0 인프라).
 *
 * 격리 전략: 각 it() 종료 시 테스트가 생성한 데이터를 정리.
 * - cleanAllTestUsers: kakaoId가 'e2e-' prefix인 user 전수 삭제 → cascade FK로 자식 데이터 자동 정리
 * - 트랜잭션 rollback은 NestJS DI 컨테이너와 충돌해 사용 안 함
 *
 * 사용:
 *   afterEach(async () => { await cleanAllTestUsers(app); });
 */
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../../src/users/user.entity';

/**
 * e2e 헬퍼가 만든 모든 테스트 user 삭제 — cascade FK로 자식 데이터 자동 정리.
 * kakaoId LIKE 'e2e-%' 매칭.
 */
export async function cleanAllTestUsers(app: INestApplication): Promise<void> {
  const dataSource = app.get(DataSource);
  const userRepo = dataSource.getRepository(User);
  // TypeORM delete with where Like 표현 — 단순 query
  await userRepo
    .createQueryBuilder()
    .delete()
    .where("kakao_id LIKE 'e2e-%'")
    .execute();
}

/** 특정 테이블의 모든 row 삭제 (test에서 명시적 정리 필요할 때). */
export async function truncateTable(
  app: INestApplication,
  tableName: string,
): Promise<void> {
  const dataSource = app.get(DataSource);
  await dataSource.query(`TRUNCATE TABLE "${tableName}" CASCADE`);
}
