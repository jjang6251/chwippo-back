import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSuspendedAtAndAuditLogs1779200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "suspended_at" TIMESTAMP WITH TIME ZONE`,
    );

    await queryRunner.query(`
      CREATE TABLE "admin_audit_logs" (
        "id"           uuid NOT NULL DEFAULT uuid_generate_v4(),
        "admin_user_id" uuid,
        "action"       character varying NOT NULL,
        "target_type"  character varying NOT NULL,
        "target_id"    character varying NOT NULL,
        "detail"       jsonb NOT NULL DEFAULT '{}',
        "created_at"   TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_admin_audit_logs_admin_user"
          FOREIGN KEY ("admin_user_id")
          REFERENCES "users"("id")
          ON DELETE SET NULL
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_admin_audit_logs_admin" ON "admin_audit_logs" ("admin_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_admin_audit_logs_target" ON "admin_audit_logs" ("target_type", "target_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_admin_audit_logs_created" ON "admin_audit_logs" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_admin_audit_logs_created"`);
    await queryRunner.query(`DROP INDEX "idx_admin_audit_logs_target"`);
    await queryRunner.query(`DROP INDEX "idx_admin_audit_logs_admin"`);
    await queryRunner.query(`DROP TABLE "admin_audit_logs"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "suspended_at"`);
  }
}
