import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { classifyLoginStamps, type PlatformUsage } from './user-platform';

/**
 * 도달 현황 — **가입한 사용자가 지금까지 어디까지 갔나**를 1인 1행 전수로 본다.
 *
 * ## 왜 필요한가
 *
 * 관측계획 0단계를 `/ops/users` 에서 **한 명씩 클릭해** 수행했다. 유입이 늘면 선형으로 커지고,
 * 1·2단계는 같은 관측의 **반복 실행**을 전제한다. 반복 불가능한 관측은 계획이 아니다.
 *
 * ## 🔴 `ActivationSection` 과 무엇이 다른가
 *
 * | | ActivationSection | 여기 |
 * |---|---|---|
 * | 질문 | 가입 **직후** 제대로 시작했나 | 지금까지 **어디까지** 갔나 |
 * | 기준 | 시간 한정 (당일·3일·7일) | **누적(lifetime)** |
 * | 단위 | 주차 코호트 | **1인 1행 전수** |
 *
 * 두 화면이 다른 숫자를 보이는 것은 정상이며, **그 이유를 화면에 적어야** 신뢰가 유지된다.
 * 주차별 코호트는 여기서 만들지 않는다 — 그쪽이 이미 한다.
 *
 * ## 🔴 이 화면이 답하지 못하는 것
 *
 * *"모른다"* 와 *"알지만 안 쓴다"* 를 **가르지 못한다.** DB 에는 *"자소서 탭을 눌렀지만 아무것도
 * 안 한"* 흔적이 남지 않는다 — `blocked_*` 는 AI 버튼까지 간 사람만 남긴다.
 * **Clarity 리플레이는 이 화면이 생겨도 여전히 필요하다.**
 */

/** 도달 단계 — 최상단 도달점 하나로 접는다 */
export type ReachStage =
  | 'signup' // 가입만
  | 'tour_completed' // 앱 소개 투어 마지막 장 도달
  | 'card' // 실제 카드 1개+
  | 'activity' // 활동일지 1개+
  | 'coverletter_question' // 자소서 문항 1개+
  | 'coverletter_answer' // 답변 작성 1개+
  | 'coverletter_ai'; // 자소서 AI 성공 1회+

export const REACH_STAGES: ReachStage[] = [
  'signup',
  // 🔴 카드 **앞**이다 — 가입 직후 순서가 「온보딩 → 투어 → 첫 카드」라서다.
  //    투어가 없던 시절 가입자는 `tour_completed_at` 이 NULL 이라 이 단계에서 빠진다.
  //    소급 불가한 값이라 백필하지 않는다 (추측한 값은 관측을 오염시킨다).
  'tour_completed',
  'card',
  'activity',
  'coverletter_question',
  'coverletter_answer',
  'coverletter_ai',
];

/**
 * 이탈 장면 분포 — **투어를 만났지만 끝내지 않은 사람**이 어느 장면에서 나갔나.
 *
 * 완료율 한 숫자로는 「6장 중 어디가 지루한가」를 못 본다. `tour_last_step` 이 있는 이유고,
 * 이 배열이 그 값의 유일한 소비처다. 장면 번호 오름차순.
 */
export interface TourDropOff {
  /** 장면 번호 1~6 */
  step: number;
  count: number;
}

export interface ReachRow {
  userId: string;
  nickname: string;
  /** KST 날짜 (YYYY-MM-DD) */
  signupDate: string;
  lastActiveAt: string | null;
  platform: PlatformUsage;
  /** `null` = **미확인** (스탬프 도입 전 가입 · 백필 근거 없음). "모바일" 이 아니다 */
  desktopSeenAt: string | null;
  /** 앱 소개 투어 마지막 장까지 갔는가 (`tour_completed_at` NOT NULL) */
  tourCompleted: boolean;
  /**
   * 투어를 만났지만 **안 끝낸** 사람의 마지막 장면. 끝냈거나 만난 적 없으면 `null`.
   * 🔴 완료자의 `tour_last_step`(=6)을 여기 남기면 이탈 분포에 섞인다.
   */
  tourDropOffStep: number | null;
  cards: number;
  /** 온보딩이 자동 생성한 카드 — 사용자가 만든 게 아니라 별도로 보여준다 */
  sampleCards: number;
  activityLogs: number;
  coverletterQuestions: number;
  coverletterAnswers: number;
  /** 자소서 AI 를 **눌렀는가** (차단·실패 포함) */
  aiAttempts: number;
  /** 자소서 AI 가 **성공했는가** */
  aiSuccesses: number;
  stage: ReachStage;
}

export interface OpsReachResponse {
  rows: ReachRow[];
  /** 표에 보이는 행 수가 전체보다 적은가 (Q3 상한) */
  truncated: boolean;
  /** 롤업 분모 — 표가 잘려도 이 값은 **전체 기준** */
  totalUsers: number;
  /** 관리자 계정 제외 인원 — 조용히 빼면 합계가 안 맞아 보인다 */
  excludedAdmins: number;
  /** 단계별 도달 인원 (누적 기준). **% 는 만들지 않는다** — 표기 규칙은 프론트 공용 포매터 */
  stageCounts: Record<ReachStage, number>;
  /**
   * 투어 이탈 장면 분포 — 만났지만 안 끝낸 사람만. 장면 번호 오름차순.
   * 아무도 이탈하지 않았으면 빈 배열이다 (0 을 6칸 채우지 않는다 — 없는 건 없는 것이다).
   */
  tourDropOff: TourDropOff[];
  /** 데스크탑 웹이 확인된 사용자만의 분모·분자 (자소서 단계 해석용) */
  desktopAxis: {
    confirmed: number;
    coverletterAnswer: number;
    coverletterAi: number;
  };
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const TZ = 'Asia/Seoul';

/** 표 상한 (Q3) — 전수 표는 N 이 커지면 의미가 없어진다. 롤업은 전체 기준을 유지한다 */
export const REACH_ROW_LIMIT = 200;

/**
 * 자소서 계열 feature — 퇴역 `coverletter` 를 포함해야 이력이 안 잘린다.
 * 🔴 이 필터가 없으면 **노트요약만 쓴 사용자가 자소서 AI 도달자로 분류**된다.
 */
export const COVERLETTER_FEATURES = [
  'coverletter_draft_v2',
  'coverletter_feedback',
  'coverletter_recommend',
  'coverletter_chat',
  'coverletter',
];

interface RawRow {
  id: string;
  nickname: string;
  signup_date: string;
  last_active_at: Date | null;
  first_app_login_at: Date | null;
  first_web_login_at: Date | null;
  first_desktop_web_seen_at: Date | null;
  tour_seen_at: Date | null;
  tour_completed_at: Date | null;
  tour_last_step: number | string | null;
  cards: string;
  sample_cards: string;
  activity_logs: string;
  cl_questions: string;
  cl_answers: string;
  ai_attempts: string;
  ai_successes: string;
}

@Injectable()
export class OpsReachService {
  private cache: { data: OpsReachResponse; at: number } | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async getReach(limit = REACH_ROW_LIMIT): Promise<OpsReachResponse> {
    const capped = Math.min(
      Math.max(Math.trunc(limit) || 1, 1),
      REACH_ROW_LIMIT,
    );
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return sliceRows(this.cache.data, capped);
    }
    const data = await this.compute();
    this.cache = { data, at: Date.now() };
    return sliceRows(data, capped);
  }

  /** 테스트·수동 갱신용 — 캐시를 비운다 */
  resetCache(): void {
    this.cache = null;
  }

  /**
   * 🔴 **쿼리는 사용자 수와 무관하게 2회 고정**이다.
   * `UserPlatformService.getMany` 를 부르지 않고 `users` 의 스탬프 컬럼을 **같은 쿼리에서 뽑아**
   * `classifyLoginStamps` 로 접는다 — id 목록을 넘기는 배치 API 는 N 이 커지면 파라미터가 부푼다.
   */
  private async compute(): Promise<OpsReachResponse> {
    const [raw, adminRow] = await Promise.all([
      this.dataSource.query<RawRow[]>(
        `
        WITH base AS (
          SELECT u.id, u.nickname, u.created_at, u.last_active_at,
                 u.first_app_login_at, u.first_web_login_at, u.first_desktop_web_seen_at,
                 u.tour_seen_at, u.tour_completed_at, u.tour_last_step,
                 (u.created_at AT TIME ZONE $1)::date AS signup_date
            FROM users u
           WHERE u.role <> 'admin'
        ),
        cards AS (
          -- 🔴 온보딩이 자동 생성한 샘플 카드를 실제 카드와 섞으면 **온보딩 완료자 전원이
          --    "카드" 단계를 자동 통과**한다 (activation.service.ts 와 같은 규칙)
          SELECT user_id,
                 COUNT(*) FILTER (WHERE is_sample = false)::int AS cards,
                 COUNT(*) FILTER (WHERE is_sample = true)::int  AS sample_cards
            FROM applications
           WHERE deleted_at IS NULL
           GROUP BY user_id
        ),
        activity AS (
          SELECT user_id, COUNT(*)::int AS n FROM activity_logs GROUP BY user_id
        ),
        cl AS (
          -- 샘플 카드에 쓴 자소서도 **사용자가 쓴 것**이므로 is_sample 로 거르지 않는다.
          -- (카드 생성과 달리 자소서 작성은 자동으로 생기지 않는다)
          SELECT a.user_id,
                 COUNT(*)::int AS questions,
                 COUNT(*) FILTER (
                   WHERE ac.answer IS NOT NULL AND TRIM(ac.answer) <> ''
                 )::int AS answers
            FROM application_coverletters ac
            INNER JOIN applications a ON a.id = ac.application_id
           WHERE a.deleted_at IS NULL
           GROUP BY a.user_id
        ),
        ai AS (
          -- 🔴 feature 필터 없이 세면 노트요약 사용자가 자소서 AI 도달자가 된다.
          -- retry_parsing 은 1회 액션의 재시도가 별도 행으로 남으므로 시도 집계에서 뺀다.
          SELECT user_id,
                 COUNT(*)::int AS attempts,
                 COUNT(*) FILTER (WHERE status = 'ok')::int AS successes
            FROM llm_call_logs
           WHERE feature = ANY($2::varchar[])
             AND status <> 'retry_parsing'
           GROUP BY user_id
        )
        SELECT b.id, b.nickname, b.signup_date, b.last_active_at,
               b.first_app_login_at, b.first_web_login_at, b.first_desktop_web_seen_at,
               b.tour_seen_at, b.tour_completed_at, b.tour_last_step,
               COALESCE(c.cards, 0)        AS cards,
               COALESCE(c.sample_cards, 0) AS sample_cards,
               COALESCE(ac.n, 0)           AS activity_logs,
               COALESCE(cl.questions, 0)   AS cl_questions,
               COALESCE(cl.answers, 0)     AS cl_answers,
               COALESCE(ai.attempts, 0)    AS ai_attempts,
               COALESCE(ai.successes, 0)   AS ai_successes
          FROM base b
          LEFT JOIN cards    c  ON c.user_id  = b.id
          LEFT JOIN activity ac ON ac.user_id = b.id
          LEFT JOIN cl          ON cl.user_id = b.id
          LEFT JOIN ai          ON ai.user_id = b.id
         ORDER BY b.created_at DESC
        `,
        [TZ, COVERLETTER_FEATURES],
      ),
      this.dataSource.query<{ count: string }[]>(
        `SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'`,
      ),
    ]);

    const rows = raw.map(toRow);
    const stageCounts = countStages(rows);
    const desktop = rows.filter((r) => r.desktopSeenAt !== null);

    return {
      rows,
      truncated: false,
      totalUsers: rows.length,
      excludedAdmins: Number(adminRow[0]?.count ?? 0),
      stageCounts,
      tourDropOff: countTourDropOff(rows),
      desktopAxis: {
        confirmed: desktop.length,
        coverletterAnswer: desktop.filter((r) => r.coverletterAnswers > 0)
          .length,
        coverletterAi: desktop.filter((r) => r.aiSuccesses > 0).length,
      },
      generatedAt: new Date().toISOString(),
    };
  }
}

/** 표만 자른다 — 롤업·분모는 **전체 기준을 유지**한다 (Q3) */
function sliceRows(data: OpsReachResponse, limit: number): OpsReachResponse {
  if (data.rows.length <= limit) return data;
  return { ...data, rows: data.rows.slice(0, limit), truncated: true };
}

function toRow(r: RawRow): ReachRow {
  const cards = Number(r.cards);
  const activityLogs = Number(r.activity_logs);
  const coverletterQuestions = Number(r.cl_questions);
  const coverletterAnswers = Number(r.cl_answers);
  const aiSuccesses = Number(r.ai_successes);
  const tourCompleted = r.tour_completed_at !== null;
  /* 🔴 「만났지만 안 끝냄」일 때만 장면 번호를 남긴다. 완료자의 6 이 섞이면 이탈 분포가
     완료자로 가득 차서 정작 보려던 「어디서 나갔나」가 지워진다. */
  const rawStep = r.tour_last_step === null ? null : Number(r.tour_last_step);
  const tourDropOffStep =
    r.tour_seen_at !== null && !tourCompleted && rawStep !== null && rawStep > 0
      ? rawStep
      : null;

  return {
    userId: r.id,
    nickname: r.nickname,
    signupDate: String(r.signup_date).slice(0, 10),
    lastActiveAt: r.last_active_at ? r.last_active_at.toISOString() : null,
    platform: classifyLoginStamps(r.first_app_login_at, r.first_web_login_at),
    desktopSeenAt: r.first_desktop_web_seen_at
      ? r.first_desktop_web_seen_at.toISOString()
      : null,
    tourCompleted,
    tourDropOffStep,
    cards,
    sampleCards: Number(r.sample_cards),
    activityLogs,
    coverletterQuestions,
    coverletterAnswers,
    aiAttempts: Number(r.ai_attempts),
    aiSuccesses,
    stage: resolveStage({
      tourCompleted,
      cards,
      activityLogs,
      coverletterQuestions,
      coverletterAnswers,
      aiSuccesses,
    }),
  };
}

/**
 * 최상단 도달점.
 *
 * ⚠️ 실제 사용 순서는 **AI 초안 → 답변 편집**일 수 있다. "최상단 도달점" 정의라 집계는 무해하지만,
 * **단계 사이 낙차를 이탈률로 읽으면 오독**이다 — 화면에 그 취지를 적는다.
 *
 * 🔴 단조롭지 않은 사용자가 실제로 있다 (활동일지는 `/activity` 별도 메뉴라 카드 없이도 쓸 수 있다).
 * 그래서 "아래 단계를 충족했는가" 가 아니라 **위에서부터 처음 걸리는 것**으로 판정한다.
 */
export function resolveStage(v: {
  /** 투어가 없던 시절 가입자는 언제나 `false` — 백필하지 않는다 */
  tourCompleted?: boolean;
  cards: number;
  activityLogs: number;
  coverletterQuestions: number;
  coverletterAnswers: number;
  aiSuccesses: number;
}): ReachStage {
  if (v.aiSuccesses > 0) return 'coverletter_ai';
  if (v.coverletterAnswers > 0) return 'coverletter_answer';
  if (v.coverletterQuestions > 0) return 'coverletter_question';
  if (v.activityLogs > 0) return 'activity';
  if (v.cards > 0) return 'card';
  if (v.tourCompleted) return 'tour_completed';
  return 'signup';
}

/**
 * 단계별 **도달** 인원 — 각 단계를 **실제 수치로 독립 판정**한다.
 *
 * 🔴 `stage`(최상단 도달점)를 보고 "그 아래는 다 충족" 으로 세면 **틀린다.** 이 퍼널은
 * 단조롭지 않기 때문이다 — 활동일지는 `/activity` 별도 메뉴라 **카드 0 인데 활동 3** 인
 * 사용자가 실존한다. 그 사람을 "카드 도달" 로 세면 카드 단계 인원이 부풀어,
 * 정작 보려던 *"카드에서 안 넘어온다"* 는 신호가 지워진다.
 */
function countStages(rows: ReachRow[]): Record<ReachStage, number> {
  const reached: Record<ReachStage, (r: ReachRow) => boolean> = {
    signup: () => true,
    // 🔴 카드가 있다고 투어를 끝낸 것으로 세지 않는다 — 투어 없이 가입한 기존 사용자가
    //    전부 「투어 완료」로 잡혀 이 단계가 통째로 거짓이 된다
    tour_completed: (r) => r.tourCompleted,
    card: (r) => r.cards > 0,
    activity: (r) => r.activityLogs > 0,
    coverletter_question: (r) => r.coverletterQuestions > 0,
    coverletter_answer: (r) => r.coverletterAnswers > 0,
    coverletter_ai: (r) => r.aiSuccesses > 0,
  };
  return Object.fromEntries(
    REACH_STAGES.map((s) => [s, rows.filter(reached[s]).length]),
  ) as Record<ReachStage, number>;
}

/**
 * 투어 이탈 장면 분포 — **만났지만 안 끝낸 사람만**(`tourDropOffStep` 이 그 판정을 이미 했다).
 *
 * 🔴 이탈이 없는 장면은 **행 자체를 만들지 않는다.** 6칸을 0으로 채우면 화면이 「모든 장면에서
 * 이탈이 있다」는 인상을 준다 — 없는 건 없는 것이다.
 */
function countTourDropOff(rows: ReachRow[]): TourDropOff[] {
  const byStep = new Map<number, number>();
  for (const r of rows) {
    if (r.tourDropOffStep === null) continue;
    byStep.set(r.tourDropOffStep, (byStep.get(r.tourDropOffStep) ?? 0) + 1);
  }
  return [...byStep.entries()]
    .map(([step, count]) => ({ step, count }))
    .sort((a, b) => a.step - b.step);
}
