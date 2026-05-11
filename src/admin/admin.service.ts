import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UsersService } from '../users/users.service';
import { InquiriesService } from '../inquiries/inquiries.service';

type DayRow = { date: string; count: number };

@Injectable()
export class AdminService {
  constructor(
    private readonly usersService: UsersService,
    private readonly inquiriesService: InquiriesService,
    private readonly dataSource: DataSource,
  ) {}

  async getStats() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const [totalUsers, newUsersMonth, newUsersWeek, pendingInquiries] =
      await Promise.all([
        this.usersService.countAll(),
        this.usersService.countByDate(startOfMonth),
        this.usersService.countByDate(startOfWeek),
        this.inquiriesService.countPending(),
      ]);

    return { totalUsers, newUsersMonth, newUsersWeek, pendingInquiries };
  }

  async getAnalytics(days: number) {
    const q = <T>(sql: string, params?: unknown[]): Promise<T> =>
      this.dataSource.query(sql, params);
    const tz = 'Asia/Seoul';

    // 기간 시작 (days일 전 KST 자정)
    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);

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

      // 일별 활성 사용자 (DAU)
      q<DayRow[]>(
        `
        SELECT TO_CHAR(last_active_at AT TIME ZONE $2, 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS count
        FROM users
        WHERE last_active_at IS NOT NULL
          AND last_active_at AT TIME ZONE $2 >= $1
        GROUP BY 1 ORDER BY 1
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
