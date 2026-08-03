import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G-8 런타임 이상 알람 — 임계값 2종 추가 (2026-08-03).
 *
 * **왜** — 계획서 문장이 그대로 재현됐다:
 *
 * > 이번 사고는 **사용자 신고로 발견**됐다. QA 는 커밋 전 게이트라 배포 후는 못 본다.
 * > 탐지가 없으면 "못 막은 건 영원히 모르는" 상태가 유지된다.
 *
 * 2026-08-03 자소서 채팅 새로고침 표시 버그도 **CEO 실기로 발견**됐고 QA 는 통과 상태였다.
 * 예방(QA)과 짝이 되는 탐지 체계가 필요하다.
 *
 * 이미 있는 것: 일일 비용 · 시간당 error 율 · 전일 대비 · abuser · provider 장애.
 * **없던 것 2종을 여기서 채운다:**
 *
 * | 임계값 | 무엇을 잡나 |
 * |---|---|
 * | `output_truncation_count_1h` | `finish_reason='length'` — **출력이 잘렸는데 성공으로 기록**된 호출. 사용자는 잘린 자소서를 받고 코인은 정상 차감된다 (2026-08-01 실사고 유형) |
 * | `charged_failure_count_1h` | **코인은 나갔는데 결과가 실패**한 호출. 돈만 잃는 가장 나쁜 실패라 1건도 그냥 넘기면 안 된다 |
 *
 * 기본값 근거 — 둘 다 **정상 상태에서 0 이어야 하는** 지표다 (dev 실측 0건).
 * 잘림은 순간 스파이크가 있을 수 있어 3, 차감 후 실패는 **1건도 즉시** 알린다.
 */
export class AddAiRuntimeAlertThresholds1784800000000 implements MigrationInterface {
  name = 'AddAiRuntimeAlertThresholds1784800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE alert_thresholds
        ADD COLUMN IF NOT EXISTS output_truncation_count_1h INTEGER NOT NULL DEFAULT 3,
        ADD COLUMN IF NOT EXISTS charged_failure_count_1h  INTEGER NOT NULL DEFAULT 1
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE alert_thresholds
        DROP COLUMN IF EXISTS output_truncation_count_1h,
        DROP COLUMN IF EXISTS charged_failure_count_1h
    `);
  }
}
