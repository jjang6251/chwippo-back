import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F6 PR 2 Phase 4 단계 B — 회사 조사 캐시 + 사용자 자유 메모.
 *
 * **설계 결정**:
 * - **공유 캐시** (`UNIQUE (company_name, job_category)`) — 같은 회사를 다른 사용자가 조회해도 1번만 호출. 비용 ↓
 * - **TTL 90일** (`expires_at`) — 분기 단위 갱신. 인재상·비전 같은 안정 정보 + 분기 뉴스 모두 커버
 * - **AI 생성 요약만 저장** (`ai_research JSONB`) — 원문 직접 저장 X. 저작권 fair use 강화
 * - **출처 URL 만 저장** (`sources TEXT[]`) — 본문 X. 사용자 클릭 시 원본 이동
 * - **opt_out 컬럼** — 회사 측 삭제 요청 시 true 로 토글. cache 무효 + 영구 차단
 * - **company_name 정규화** = lowercase + trim (조회 시 동일 정규화 적용)
 *
 * **사용자 메모 분리**:
 * - `interview_prep_sessions.user_research_notes TEXT NULL` 추가
 * - AI 생성 정보는 cache 에 read-only, 사용자 자유 입력은 session 에
 * - 책임 분리 명확 (AI = 우리 책임, 메모 = 사용자 책임)
 *
 * **법적 안전장치**:
 * - 화이트리스트 도메인만 web_search (`company-research-whitelist.ts`)
 * - 잡플래닛·블라인드·Glassdoor 등 후기·연봉 사이트 전면 차단
 * - opt_out 24시간 SLA (support@chwippo.com)
 */
export class CreateCompanyResearchCache1779990000000 implements MigrationInterface {
  name = 'CreateCompanyResearchCache1779990000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE company_research_cache (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        company_name VARCHAR(120) NOT NULL,
        job_category VARCHAR(120) NULL,
        ai_research JSONB NOT NULL DEFAULT '{}'::jsonb,
        sources TEXT[] NOT NULL DEFAULT '{}',
        expires_at TIMESTAMPTZ NOT NULL,
        opt_out BOOLEAN NOT NULL DEFAULT FALSE,
        hit_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // (company, job_category) 합산 unique — job_category NULL 도 distinct
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_crc_company_job
        ON company_research_cache (company_name, COALESCE(job_category, ''))
    `);

    // 만료된 row 정리 cron 용 + opt_out 조회용
    await queryRunner.query(`
      CREATE INDEX idx_crc_expires ON company_research_cache (expires_at)
    `);

    // 회사별 hit ranking — admin 통계용
    await queryRunner.query(`
      CREATE INDEX idx_crc_hit_count
        ON company_research_cache (hit_count DESC)
        WHERE opt_out = FALSE
    `);

    // session 에 사용자 자유 메모 컬럼 — AI 정보와 분리, 사용자 책임 영역
    await queryRunner.query(`
      ALTER TABLE interview_prep_sessions
        ADD COLUMN user_research_notes TEXT NULL
    `);

    // feature_quota_configs seed — company_research × free
    // 베타 정책: 일 5회 / 월 50회 / cooldown 60s (회사 1개당 1회만 호출되니 자주 X)
    await queryRunner.query(`
      INSERT INTO feature_quota_configs
        (feature, tier, day_limit, month_limit, cooldown_seconds, enabled, updated_at)
      VALUES
        ('company_research', 'free', 5, 50, 60, TRUE, now())
      ON CONFLICT (feature, tier) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM feature_quota_configs WHERE feature = 'company_research'`,
    );
    await queryRunner.query(
      `ALTER TABLE interview_prep_sessions DROP COLUMN IF EXISTS user_research_notes`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS company_research_cache`);
  }
}
