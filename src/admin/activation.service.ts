import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * A8 Activation 측정 (plan: ~/.claude/plans/activation-metrics.md · CEO 승인 2026-07-06)
 *
 * 주차별 가입 코호트 × 4층 지표 (product-market-review §4.3):
 * - setup   : 가입 KST 당일 첫 카드 ≥1 (is_sample 제외)
 * - ahaBeta : 가입 +72h 내 마감일 있는 카드 ≥2 (is_sample 제외) ← 베타 아하 지표
 * - ahaAi   : 가입 7일 내 AI 초안 1회 + 이후 자소서 답변 편집 (AI hide 동안 0% 예상 — 층만 준비)
 * - d7/d30  : user_daily_visits 에 가입 후 5~9일 / 25~35일 window 방문 존재
 *             (windowed retention — 정확히 7일째 하루만 보면 소표본에서 노이즈 심함)
 *
 * + 브리핑 경량 상관: 브리핑 수신일 read 여부별 당일 카드·스텝 행동률 (Q3=A안, 딥링크 클릭 추적 X)
 *
 * 모든 지표 is_sample=false · deleted_at IS NULL 강제 (W1 샘플 카드 오염 방지).
 * 5분 in-memory 캐시 (streak/growth 패턴).
 */

export interface ActivationCohortRow {
  weekStart: string; // KST 월요일 (YYYY-MM-DD)
  cohortSize: number;
  setup: number;
  ahaBeta: number;
  ahaAi: number;
  d7: number;
  d30: number;
}

export interface BriefingCorrelation {
  /** 최근 30일 브리핑 수신 유저-일 수 */
  receivedUserDays: number;
  /** read 그룹의 당일 카드·스텝 행동률 (%) — 표본 0이면 null */
  actedRateRead: number | null;
  /** 미read 그룹의 당일 행동률 (%) */
  actedRateUnread: number | null;
}

export interface ActivationResponse {
  cohorts: ActivationCohortRow[];
  funnel: {
    signup: number;
    setup: number;
    ahaBeta: number;
    d7: number;
  };
  briefing: BriefingCorrelation;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const COHORT_WEEKS = 8;
const TZ = 'Asia/Seoul';

@Injectable()
export class ActivationService {
  private cache: { data: ActivationResponse; at: number } | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async getActivation(): Promise<ActivationResponse> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.data;
    }
    const data = await this.compute();
    this.cache = { data, at: Date.now() };
    return data;
  }

  private async compute(): Promise<ActivationResponse> {
    const q = <T>(sql: string, params: unknown[]): Promise<T> =>
      this.dataSource.query(sql, params);

    // 주차별 코호트 — 유저 단위 지표 달성 여부를 한 번에 판정 후 주차 집계.
    // date_trunc('week') = 월요일 시작 (ISO).
    const cohortRows = await q<
      {
        week_start: string;
        cohort_size: string;
        setup: string;
        aha_beta: string;
        aha_ai: string;
        d7: string;
        d30: string;
      }[]
    >(
      `
      WITH cohort_users AS (
        SELECT
          u.id,
          u.created_at,
          (u.created_at AT TIME ZONE $1)::date AS signup_date,
          date_trunc('week', u.created_at AT TIME ZONE $1)::date AS week_start
        FROM users u
        WHERE u.created_at >= NOW() - ($2 || ' weeks')::interval
      ),
      per_user AS (
        SELECT
          cu.week_start,
          cu.id,
          EXISTS (
            SELECT 1 FROM applications a
            WHERE a.user_id = cu.id
              AND a.is_sample = false AND a.deleted_at IS NULL
              AND (a.created_at AT TIME ZONE $1)::date = cu.signup_date
          ) AS setup,
          (
            -- 마감일은 applications 컬럼이 아니라 스텝의 scheduled_date 로 저장됨
            -- (서류 마감·면접 = step 날짜). 날짜 입력 "시점"은 이력이 없어
            -- 현재 상태 기준으로 판정.
            SELECT COUNT(*) FROM applications a
            WHERE a.user_id = cu.id
              AND a.is_sample = false AND a.deleted_at IS NULL
              AND a.created_at <= cu.created_at + interval '72 hours'
              AND EXISTS (
                SELECT 1 FROM application_steps s
                WHERE s.application_id = a.id AND s.scheduled_date IS NOT NULL
              )
          ) >= 2 AS aha_beta,
          EXISTS (
            SELECT 1
            FROM llm_call_logs l
            WHERE l.user_id = cu.id
              AND l.feature = 'coverletter_draft_v2' AND l.status = 'ok'
              AND l.created_at <= cu.created_at + interval '7 days'
              AND EXISTS (
                SELECT 1 FROM application_coverletters c
                JOIN applications a2 ON a2.id = c.application_id
                WHERE a2.user_id = cu.id AND c.updated_at > l.created_at
              )
          ) AS aha_ai,
          EXISTS (
            SELECT 1 FROM user_daily_visits v
            WHERE v.user_id = cu.id
              AND v.visit_date BETWEEN cu.signup_date + 5 AND cu.signup_date + 9
          ) AS d7,
          EXISTS (
            SELECT 1 FROM user_daily_visits v
            WHERE v.user_id = cu.id
              AND v.visit_date BETWEEN cu.signup_date + 25 AND cu.signup_date + 35
          ) AS d30
        FROM cohort_users cu
      )
      SELECT
        week_start::text AS week_start,
        COUNT(*)::text AS cohort_size,
        COUNT(*) FILTER (WHERE setup)::text AS setup,
        COUNT(*) FILTER (WHERE aha_beta)::text AS aha_beta,
        COUNT(*) FILTER (WHERE aha_ai)::text AS aha_ai,
        COUNT(*) FILTER (WHERE d7)::text AS d7,
        COUNT(*) FILTER (WHERE d30)::text AS d30
      FROM per_user
      GROUP BY week_start
      ORDER BY week_start
      `,
      [TZ, String(COHORT_WEEKS)],
    );

    const cohorts: ActivationCohortRow[] = cohortRows.map((r) => ({
      weekStart: r.week_start,
      cohortSize: Number(r.cohort_size),
      setup: Number(r.setup),
      ahaBeta: Number(r.aha_beta),
      ahaAi: Number(r.aha_ai),
      d7: Number(r.d7),
      d30: Number(r.d30),
    }));

    // funnel — 전체 코호트 합산 (주차 무관 절대 수)
    const funnel = cohorts.reduce(
      (acc, c) => ({
        signup: acc.signup + c.cohortSize,
        setup: acc.setup + c.setup,
        ahaBeta: acc.ahaBeta + c.ahaBeta,
        d7: acc.d7 + c.d7,
      }),
      { signup: 0, setup: 0, ahaBeta: 0, d7: 0 },
    );

    const briefing = await this.computeBriefingCorrelation(q);

    return {
      cohorts,
      funnel,
      briefing,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 브리핑 경량 상관 — 최근 30일, 브리핑 인앱 알림 수신 유저-일 단위로
   * read 여부 그룹별 "당일 카드 또는 스텝 updated" 행동률 비교.
   * 인과 아님 (상관) — UI 에 라벨 명시.
   */
  private async computeBriefingCorrelation(
    q: <T>(sql: string, params: unknown[]) => Promise<T>,
  ): Promise<BriefingCorrelation> {
    const rows = await q<{ read: boolean; total: string; acted: string }[]>(
      `
      WITH briefing_days AS (
        SELECT
          n.user_id,
          n.read,
          (n.created_at AT TIME ZONE $1)::date AS day
        FROM notifications n
        WHERE n.type = 'briefing'
          AND n.created_at >= NOW() - interval '30 days'
      )
      SELECT
        b.read,
        COUNT(*)::text AS total,
        COUNT(*) FILTER (
          -- 행동 proxy = applications.updated_at 당일 갱신.
          -- 스텝바 클릭·결과 처리도 카드 PATCH 라 updated_at 이 갱신됨
          -- (application_steps 에는 updated_at 컬럼 없음).
          WHERE EXISTS (
            SELECT 1 FROM applications a
            WHERE a.user_id = b.user_id AND a.deleted_at IS NULL
              AND (a.updated_at AT TIME ZONE $1)::date = b.day
          )
        )::text AS acted
      FROM briefing_days b
      GROUP BY b.read
      `,
      [TZ],
    );

    const readRow = rows.find((r) => r.read === true);
    const unreadRow = rows.find((r) => r.read === false);
    const rate = (row?: { total: string; acted: string }): number | null => {
      const total = Number(row?.total ?? 0);
      if (total === 0) return null;
      return Math.round((Number(row?.acted ?? 0) / total) * 100);
    };

    return {
      receivedUserDays:
        Number(readRow?.total ?? 0) + Number(unreadRow?.total ?? 0),
      actedRateRead: rate(readRow),
      actedRateUnread: rate(unreadRow),
    };
  }
}
