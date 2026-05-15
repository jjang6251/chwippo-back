import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

const TABLES = [
  'myinfo_certs',
  'myinfo_awards',
  'myinfo_language_certs',
  'myinfo_documents',
  'myinfo_educations',
];

export class AddFileSizeBytes1779300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.addColumn(
        table,
        new TableColumn({
          name: 'file_size_bytes',
          type: 'bigint',
          isNullable: true,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.dropColumn(table, 'file_size_bytes');
    }
  }
}
