import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UsersService } from '../users/users.service';
import { InquiriesService } from '../inquiries/inquiries.service';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import {
  startOfMonthKst,
  startOfKstWeek,
  startOfTodayKst,
} from '../common/datetime';

type DayRow = { date: string; count: number };

@Injectable()
export class AdminService {
  constructor(
    private readonly usersService: UsersService,
    private readonly inquiriesService: InquiriesService,
    private readonly dataSource: DataSource,
    private readonly storageUsage: StorageUsageService,
  ) {}

  async getStats() {
    // KST 기준 — 치뽀는 한국 취준생 KST-fixed app. server TZ (CI=UTC) 무관 정합성 보장.
    const startOfMonth = startOfMonthKst();
    const startOfWeek = startOfKstWeek();

    const [
      totalUsers,
      newUsersMonth,
      newUsersWeek,
      pendingInquiries,
      totalUsedBytes,
      nearCapUserCount,
    ] = await Promise.all([
      this.usersService.countAll(),
      this.usersService.countByDate(startOfMonth),
      this.usersService.countByDate(startOfWeek),
      this.inquiriesService.countPending(),
      this.storageUsage.getGlobalUsage(),
      this.storageUsage.getNearCapUserCount(),
    ]);

    const averageBytes =
      totalUsers > 0 ? Math.round(totalUsedBytes / totalUsers) : 0;

    return {
      totalUsers,
      newUsersMonth,
      newUsersWeek,
      pendingInquiries,
      globalStorage: {
        totalUsedBytes,
        averageBytes,
        nearCapUserCount,
        r2FreeLimitGB: 10,
      },
    };
  }

  async getAnalytics(days: number) {
    const q = <T>(sql: string, params?: unknown[]): Promise<T> =>
      this.dataSource.query(sql, params);
    const tz = 'Asia/Seoul';

    // 기간 시작 (days-1 일 전 KST 자정). 서버 OS TZ (운영 Railway=UTC) 무관 정합성 보장.
    // KST 는 DST 없어 하루=정확히 86,400,000ms → ms 산술 안전. SQL 필터·fillDates 버킷(KST)과 경계 일치.
    const since = new Date(
      startOfTodayKst().getTime() - (days - 1) * 24 * 60 * 60 * 1000,
    );

    const [
      signupRows,
      dauRows,
      cardRows,
      inquiryRows,
      baseCumRow,
      replyRows,
      cardsPerUserRows,
      d7Rows,
    ] = await Promise.all([
      // 일별 신규 가입
      q<DayRow[]>(
        `
        SELECT TO_CHAR(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS count
        FROM users
        WHERE created_at AT TIME ZONE $2 >= $1
        GROUP BY 1 ORDER BY 1
      `,
        [since, tz],
      ),

      // 일별 활성 사용자 (DAU) — A8: user_daily_visits 가 정확한 소스.
      // 구 last_active_at 집계는 유저당 최신일 1건만 남아 과거 DAU 과소집계 →
      // 테이블 도입(2026-07) 이전 구간은 구 방식이 자연 우세하도록 일자별 GREATEST 전환.
      q<DayRow[]>(
        `
        SELECT COALESCE(o.date, v.date) AS date,
               GREATEST(COALESCE(o.count, 0), COALESCE(v.count, 0))::int AS count
        FROM (
          SELECT TO_CHAR(last_active_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date,
                 COUNT(*)::int AS count
          FROM users
          WHERE last_active_at IS NOT NULL
            AND last_active_at AT TIME ZONE $2 >= $1
          GROUP BY 1
        ) o
        FULL OUTER JOIN (
          SELECT TO_CHAR(visit_date, 'YYYY-MM-DD') AS date,
                 COUNT(*)::int AS count
          FROM user_daily_visits
          WHERE visit_date >= ($1)::date
          GROUP BY 1
        ) v ON v.date = o.date
        ORDER BY 1
      `,
        [since, tz],
      ),

      // 일별 카드(지원) 생성 수
      q<DayRow[]>(
        `
        SELECT TO_CHAR(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS count
        FROM applications
        WHERE deleted_at IS NULL
          AND created_at AT TIME ZONE $2 >= $1
        GROUP BY 1 ORDER BY 1
      `,
        [since, tz],
      ),

      // 일별 문의 접수 수
      q<DayRow[]>(
        `
        SELECT TO_CHAR(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS count
        FROM inquiries
        WHERE created_at AT TIME ZONE $2 >= $1
        GROUP BY 1 ORDER BY 1
      `,
        [since, tz],
      ),

      // 누적 가입자 — 기간 시작 이전 총계
      q<{ count: number }[]>(
        `
        SELECT COUNT(*)::int AS count FROM users
        WHERE created_at AT TIME ZONE $2 < $1
      `,
        [since, tz],
      ),

      // 평균 첫 답변 시간 (시간)
      q<{ avg_hours: number | null }[]>(
        `
        SELECT ROUND(
          AVG(EXTRACT(EPOCH FROM (c.first_at - i.created_at)) / 3600)::numeric, 1
        )::float AS avg_hours
        FROM inquiries i
        JOIN (
          SELECT inquiry_id, MIN(created_at) AS first_at
          FROM inquiry_comments WHERE author_role = 'admin'
          GROUP BY inquiry_id
        ) c ON c.inquiry_id = i.id
      `,
        [],
      ),

      // 활성 유저당 평균 카드 수
      q<{ avg: number | null }[]>(
        `
        SELECT ROUND(AVG(cnt)::numeric, 1)::float AS avg
        FROM (
          SELECT COUNT(*)::int AS cnt
          FROM applications WHERE deleted_at IS NULL
          GROUP BY user_id
        ) t
      `,
        [],
      ),

      // D7 리텐션 (7일 이상 지난 가입자 기준)
      q<{ cohort: number; retained: number }[]>(
        `
        SELECT COUNT(*)::int AS cohort,
          COUNT(CASE WHEN last_active_at >= created_at + INTERVAL '7 days' THEN 1 END)::int AS retained
        FROM users
        WHERE created_at <= NOW() - INTERVAL '7 days'
      `,
        [],
      ),
    ]);

    // 전체 날짜 채우기 (데이터 없는 날 → 0)
    const filled = (rows: DayRow[]) => fillDates(rows, days);

    // 누적 가입자 = 기간 전 총계 + 일별 신규 누적합
    const filledSignups = filled(signupRows);
    let running = baseCumRow[0]?.count ?? 0;
    const cumulative = filledSignups.map((d) => {
      running += d.count;
      return { date: d.date, count: running };
    });

    const d7 = d7Rows[0];

    return {
      dau: filled(dauRows),
      signups: filledSignups,
      cumulative,
      cards: filled(cardRows),
      inquiries: filled(inquiryRows),
      avgReplyHours: replyRows[0]?.avg_hours ?? null,
      avgCardsPerUser: cardsPerUserRows[0]?.avg ?? null,
      d7Retention:
        d7?.cohort > 0 ? Math.round((d7.retained / d7.cohort) * 100) : null,
      d7CohortSize: d7?.cohort ?? 0,
    };
  }
}

function fillDates(rows: DayRow[], days: number): DayRow[] {
  const map = new Map(rows.map((r) => [r.date, r.count]));
  const result: DayRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    result.push({ date, count: map.get(date) ?? 0 });
  }
  return result;
}
