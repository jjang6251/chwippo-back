import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `announcements.kind` · `cta_label` · `cta_path` — 공지의 종류와 「지금 해보기」 버튼.
 *
 * ## `type` 이 있는데 왜 `kind` 를 또 두나
 *
 * `type`(banner/modal)은 **어떻게 보이나**이고, `kind`는 **무슨 소식인가**다. 지금은 축이
 * 하나뿐이라 새 기능 소개가 점검 공지와 똑같은 회색 카드로 나가고, 사용자는 「또 점검이구나」
 * 하고 닫는다. 종류를 나눠야 프론트가 아이콘·색을 가를 수 있다.
 *
 * ## CTA 를 라벨/경로 두 칸으로 쪼갠 이유
 *
 * 「확인」밖에 없는 공지는 소개한 기능으로 가는 길을 사용자가 직접 찾아야 한다. 경로를 함께
 * 주면 공지가 곧 진입점이 된다. 🔴 **앱 내부 경로만** 저장한다 — 외부 URL 을 넣을 수 있으면
 * 관리자 계정 하나가 전체 사용자에게 열리는 리다이렉트 통로가 된다 (검증은 DTO 정규식).
 * 라벨 30자는 버튼 한 줄, 경로 200자는 쿼리스트링 포함 여유값이다.
 *
 * ## 파괴적 변경 아님
 *
 * `kind` 는 DEFAULT 'notice' 라 기존 행이 전부 그 값으로 채워진다(백필 SQL 불필요 — 지금까지의
 * 공지는 전부 시스템 알림이라 의미도 맞다). CTA 2개는 nullable ADD. 롤백해도 공지 노출은
 * 그대로라 2단계 릴리즈 대상이 아니다.
 */
export class AddAnnouncementKindAndCta1787300000000 implements MigrationInterface {
  name = 'AddAnnouncementKindAndCta1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE announcements
        ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'notice'
    `);

    await queryRunner.query(`
      ALTER TABLE announcements
        ADD COLUMN IF NOT EXISTS cta_label VARCHAR(30)
    `);

    await queryRunner.query(`
      ALTER TABLE announcements
        ADD COLUMN IF NOT EXISTS cta_path VARCHAR(200)
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN announcements.kind IS
        '공지 종류 — feature | improvement | fix | notice. type(배너/모달 = 표시 방식)과 다른 축'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN announcements.cta_label IS
        '「지금 해보기」 버튼 라벨 ≤30자 · cta_path 와 항상 짝 (둘 다 있거나 둘 다 NULL)'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN announcements.cta_path IS
        'CTA 이동 경로 — 앱 내부 경로만(/로 시작, // 금지) ≤200자 · cta_label 과 항상 짝'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE announcements
        DROP COLUMN IF EXISTS cta_path
    `);

    await queryRunner.query(`
      ALTER TABLE announcements
        DROP COLUMN IF EXISTS cta_label
    `);

    await queryRunner.query(`
      ALTER TABLE announcements
        DROP COLUMN IF EXISTS kind
    `);
  }
}
