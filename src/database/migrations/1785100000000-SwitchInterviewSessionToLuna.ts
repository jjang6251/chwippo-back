import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 면접 prep v2 — 세션 질문 생성을 GPT-5.6 Luna 로 전환 (2026-08-06).
 *
 * 벤치 근거 (`scripts/bench/run-question-bench.ts`, 36콜·264원, 골든셋 4케이스):
 *
 * | 모델·모드      | 자료 밀착 | 공통질문 누락 | 원/세션 | 초 |
 * |---------------|---------|------------|--------|----|
 * | 4o-mini · 1콜  | 16%     | 2          | 0.9원  | 8  |
 * | **luna · 1콜** | **68%** | **0**      | **2.8원** | **9** |
 * | terra · 1콜    | 57%     | 0          | 24.4원 | 12 |
 * | (기존) haiku   | —       | —          | 85.2원 | 81 |
 *
 * 🔴 판별축은 **자료 밀착도** — 질문이 사용자 자소서·활동 기록의 사실을 인용하는가.
 * 4o-mini 는 16% 로, 원가가 1/3 인데도 탈락했다 (검색하면 나오는 일반 질문을 낸다).
 * 이건 v2 에서 질문이 **유일한 산출물**이 되면서 새로 생긴 축이라, 직전 벤치
 * (답변 지어내기 기준으로 haiku→luna 를 정한 것)와는 다른 근거다.
 *
 * 🔴 **"누가 만졌나" 가 아니라 "무엇으로 설정돼 있나" 로 판단한다** — Terra 전환
 * (`1784700000000`) 과 같은 규칙이다. 이 표는 admin 이 화면에서 고치는 곳이라,
 * 무조건 덮으면 사람의 결정을 배포가 조용히 되돌린다. 그래서 **아직 이전 모델(Haiku)에
 * 있는 행만** 옮긴다. 관리자가 의도적으로 다른 모델을 고른 행은 건드리지 않는다.
 *
 * `down()` 은 대칭 — 지금 Luna 인 행만 Haiku 로 되돌린다. 이 표가 코드보다 우선하므로
 * 행만 되돌리면 즉시 Haiku 로 돌아간다 (G-1 3단 해석).
 */
export class SwitchInterviewSessionToLuna1785100000000 implements MigrationInterface {
  name = 'SwitchInterviewSessionToLuna1785100000000';

  private static readonly FEATURE = 'interview_prep_session';
  private static readonly FROM = 'claude-haiku-4-5-20251001';
  private static readonly TO = 'gpt-5.6-luna';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const c = SwitchInterviewSessionToLuna1785100000000;
    await queryRunner.query(
      `UPDATE feature_model_config
          SET provider = 'openai', model = $2, updated_at = now()
        WHERE feature = $1
          AND model = $3`,
      [c.FEATURE, c.TO, c.FROM],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const c = SwitchInterviewSessionToLuna1785100000000;
    await queryRunner.query(
      `UPDATE feature_model_config
          SET provider = 'anthropic', model = $2, updated_at = now()
        WHERE feature = $1
          AND model = $3`,
      [c.FEATURE, c.FROM, c.TO],
    );
  }
}
