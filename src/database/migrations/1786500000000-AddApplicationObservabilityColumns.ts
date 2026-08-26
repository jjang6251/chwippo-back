import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 카드 관측 컬럼 2종 — `applications.template_id` · `applications.created_via` (2026-08-25).
 *
 * ## 왜 지금 심는가 — 소급이 불가능하다
 *
 * 치뽀엔 **사용자 행동 이벤트 테이블이 없다.** `admin_audit_log` 는 운영자 액션 전용이라,
 * 도메인 테이블의 **최종 상태**만 남는다. 그래서 아래 두 질문은 지금 기록을 시작하지 않으면
 * 나중에 어떤 쿼리로도 답할 수 없다. 이미 DB 에 쌓여 있는 값(필드 채움률·직군 어휘 등)은
 * 급하지 않지만, **기록하지 않고 있는 값은 오늘이 유일한 시점**이다.
 *
 * | 컬럼 | 답하는 질문 |
 * |---|---|
 * | `template_id` | 추천 템플릿을 **그대로 썼나, 고쳤나** |
 * | `created_via` | 어느 진입점이 **잘 채워진 카드**를 만드나 |
 *
 * ### `template_id` — 여태 버려지던 값이다
 *
 * `templateId` 는 `CreateApplicationDto` 로 **이미 들어오고 있었다.** 초기 스텝을 만드는 데만
 * 쓰이고 저장되지 않아서, 「무엇으로 시작했나」를 알려면 **스텝 이름을 8종 템플릿과 문자열
 * 비교**하는 수밖에 없었다. 사용자가 스텝 이름을 한 글자만 고치면 그 추정이 무너진다.
 * 이 값은 시작 시점의 기록이라 이후 스텝을 어떻게 편집해도 안 변한다 — 그래서 비로소
 * 「무엇으로 시작해 무엇으로 끝났나」가 갈린다.
 *
 * ### `created_via` — 날짜로 가르면 안 되는 이유
 *
 * 도입 시점 기준 실제 생성 경로는 `AddCardModal` **하나뿐**이라, 오늘 당장은 정보량이 적다.
 * 값은 카드 추가 재설계가 진입점을 나눌 때 늘어난다. 그때 "개편 전후를 `created_at` 으로
 * 자르면 되지 않나" 는 통하지 않는다 — 그 방식은 **「개편 효과」와 「그 사이 유입된 사용자층
 * 변화」를 구분하지 못한다.** 두 경로가 동시에 존재할 때만 진짜 비교가 성립한다.
 *
 * ## 백필하지 않는다
 *
 * 기존 카드는 둘 다 `NULL`(= 미기록)로 남는다. 기존 카드의 스텝 이름을 보고 `template_id` 를
 * 역추정해 채워 넣을 수도 있지만, 그러면 **추측값과 실측값이 같은 컬럼에 섞여** 이 컬럼을
 * 만든 이유가 사라진다. `NULL` 은 "모른다" 라는 정확한 정보다.
 *
 * ## 파괴적 변경 아님
 *
 * nullable 컬럼 ADD 만이다. 기존 행·컬럼을 건드리지 않으므로 2단계 릴리즈 대상이 아니고,
 * 두 값 모두 **읽기 전용 관측용**이라 어떤 동작 분기에도 쓰이지 않는다 (롤백해도 기능 무영향).
 * `down` 은 넣은 것만 정확히 되돌린다 — CI 가 down→up 왕복을 검증한다.
 *
 * ## 🔴 인덱스를 만들지 않는 이유
 *
 * 두 컬럼의 유일한 소비자는 admin 집계(`OpsCardFieldsService`)이고, 그건 5분 캐시가 붙은
 * **전체 스캔 집계**라 인덱스가 도움이 안 된다. 사용자 요청 경로에서는 읽지 않는다.
 * 카드 수가 백만 단위가 되면 그때 재검토한다.
 */
export class AddApplicationObservabilityColumns1786500000000 implements MigrationInterface {
  name = 'AddApplicationObservabilityColumns1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS template_id  VARCHAR(32),
        ADD COLUMN IF NOT EXISTS created_via  VARCHAR(32)
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN applications.template_id IS
        '카드 생성 시 고른 전형 템플릿 id. 관측 전용 · NULL=미지정 또는 도입 이전 카드'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN applications.created_via IS
        '카드를 만든 화면(add_modal·onboarding_sample). 관측 전용 · NULL=도입 이전 카드'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE applications
        DROP COLUMN IF EXISTS created_via,
        DROP COLUMN IF EXISTS template_id
    `);
  }
}
