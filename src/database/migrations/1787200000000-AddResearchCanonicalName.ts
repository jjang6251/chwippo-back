import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `company_research_cache.canonical_name` — 시드 본명의 **표시용 표기** (2026-08-30 · 대장 21 후속).
 *
 * ## 왜 필요한가 — 캐시 키는 소문자라 화면에 못 쓴다
 *
 * 공고 붙여넣기로 SK하이닉스 카드를 만들면 모델이 「SK hynix」/「SK하이닉스」를 번갈아 골랐다
 * (공고에 두 표기가 같이 있다). 조사 캐시는 `company_name`(소문자 키)으로만 찾고 별칭 행은
 * 본명을 모르기 때문에, 「SK hynix」로 온 카드는 조사가 안 붙거나 붙어도 이름이 제각각이었다.
 *
 * 이 컬럼이 있으면 **파싱된 회사명이 우리가 조사해 둔 회사(본명·별칭)에 있으면 그 표기로**,
 * 없으면 파싱된 이름 그대로 카드를 만든다 (CEO: 「있는지 검사하고 있으면 그 회사로, 없으면 새로」).
 *
 * ## 값의 출처
 *
 * 시드 적재기(`CompanyResearchSeedService`)가 본명·별칭 행 모두에 `entry.companyName` 을 넣는다.
 * 사용자가 직접 조사한 행(seed_version NULL)은 NULL 로 남는다 — 그 이름을 「표준」이라 부를 근거가 없다.
 * 기존 행은 다음 시드 적재(재배포·재시작) 때 채워진다. 백필 없음.
 *
 * ## 파괴적 변경 아님
 *
 * nullable 컬럼 ADD 하나. 롤백해도 조사 조회·카드 생성은 그대로(정규화만 꺼진다).
 */
export class AddResearchCanonicalName1787200000000 implements MigrationInterface {
  name = 'AddResearchCanonicalName1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE company_research_cache
        ADD COLUMN IF NOT EXISTS canonical_name VARCHAR(120)
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN company_research_cache.canonical_name IS
        '시드 본명의 표시용 표기 (별칭 행도 본명을 가리킴). 사용자 조사 행은 NULL. 공고 붙여넣기 회사명 정규화의 근거'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE company_research_cache
        DROP COLUMN IF EXISTS canonical_name
    `);
  }
}
