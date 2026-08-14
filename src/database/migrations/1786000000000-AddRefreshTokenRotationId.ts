import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 회전 멱등성 (B안) — `refresh_tokens.rotation_id` (2026-08-15).
 *
 * ## 왜
 *
 * refresh token 은 1회용이라, 회전 요청이 **서버엔 도달해 처리됐는데 응답(새 RT 쿠키)만
 * 유실**되면 기기엔 이미 소비된 낡은 RT 만 남는다. 재시도해도 같은 것밖에 못 내고,
 * 서버는 창(30s) 안이면 409 를 주면서 쿠키는 갱신하지 않는다 —
 * **재시도가 원리적으로 성공할 수 없다.** 창을 넘기면 탈취 replay 로 판정돼 강제 로그아웃.
 *
 * 클라가 회전 요청에 `rotationId`(UUID) 를 싣고 재시도에 **같은 id 를 재사용**하면,
 * 서버는 "같은 회전의 재전송" 임을 알아보고 창 안에서 새 토큰을 다시 발급할 수 있다.
 *
 * ## 설계
 *
 * | 결정 | 이유 |
 * |---|---|
 * | 컬럼 1개 (`uuid NULL`) | 우리는 RT 를 sha256 으로만 저장한다 — 평문이 없어 "그 토큰" 을 되줄 수 없다. 대신 **새 토큰**을 발급하므로 보관할 비밀이 없다. 접수번호만 있으면 된다 |
 * | 소비된 행에 기록 | `rotation_id` = "이 행을 소비한 회전 요청의 id". 수명이 행과 같이 가므로 별도 TTL·저장소(Redis·새 테이블) 불필요 |
 * | NULL 허용 | 구버전 클라(rotationId 미전송)는 NULL 로 남고 기존 판정 경로 그대로 |
 * | 인덱스 없음 | 조회 키는 여전히 `token_hash` 하나다. `rotation_id` 는 찾은 행에서 **비교만** 한다 |
 */
export class AddRefreshTokenRotationId1786000000000 implements MigrationInterface {
  name = 'AddRefreshTokenRotationId1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN "rotation_id" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // reversible — CI 가 down→up 왕복을 검증한다. 되돌리면 멱등 재현이 꺼질 뿐
    // (모든 소비 토큰이 rotation_id 없는 상태 = 기존 409/revoke 판정)이라 데이터 손실 의미 없음.
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "rotation_id"`,
    );
  }
}
