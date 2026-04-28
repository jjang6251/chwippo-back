import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMyinfoDocuments1777500000000 implements MigrationInterface {
  name = 'AddMyinfoDocuments1777500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "myinfo_documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" character varying NOT NULL,
        "title" character varying NOT NULL,
        "category" character varying,
        "file_url" character varying NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_myinfo_documents" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "myinfo_documents"`);
  }
}
