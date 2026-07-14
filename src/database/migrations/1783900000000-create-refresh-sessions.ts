import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 세션 지속성 웨이브 (B안 — 토큰 패밀리) — 기기별 refresh 세션 + 발급 토큰 테이블 신설.
 *
 * - `refresh_sessions` (기기 체인): id(sid, PK) · user_id(FK CASCADE) · created_at(absolute cap 기준)
 *   · expires_at(sliding 60일) · device_info · revoked_at(무효화 시각)
 * - `refresh_tokens` (발급 토큰마다 1행): id(PK) · session_id(FK CASCADE) · token_hash(SHA-256 hex, UNIQUE)
 *   · created_at · used_at(소비 시각, NULL=미사용) — 재사용=탈취 판정의 정본
 * - 인덱스: refresh_tokens(token_hash) UNIQUE · (session_id) · refresh_sessions(user_id) · (expires_at)
 *
 * `users.refresh_token` 구 컬럼은 이번 릴리즈에서 유지 (fallback 이전용) — 2차 릴리즈에서 drop.
 */
export class CreateRefreshSessions1783900000000 implements MigrationInterface {
  name = 'CreateRefreshSessions1783900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "refresh_sessions" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "device_info" varchar(255),
        "revoked_at" TIMESTAMPTZ,
        CONSTRAINT "pk_refresh_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_refresh_sessions_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_refresh_sessions_user_id"
        ON "refresh_sessions" ("user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_refresh_sessions_expires_at"
        ON "refresh_sessions" ("expires_at")
    `);

    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid NOT NULL,
        "session_id" uuid NOT NULL,
        "token_hash" varchar(64) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "used_at" TIMESTAMPTZ,
        CONSTRAINT "pk_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "uq_refresh_tokens_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "fk_refresh_tokens_session" FOREIGN KEY ("session_id")
          REFERENCES "refresh_sessions"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_refresh_tokens_session_id"
        ON "refresh_tokens" ("session_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 자식(refresh_tokens) 먼저 drop (FK) — 인덱스는 테이블과 함께 제거됨
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_refresh_tokens_session_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_tokens"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_refresh_sessions_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_refresh_sessions_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_sessions"`);
  }
}
