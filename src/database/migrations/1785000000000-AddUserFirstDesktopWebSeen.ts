import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 데스크탑 웹 사용 스탬프 — **자소서 도달 지표의 분모**를 만들기 위한 컬럼 (2026-08-06).
 *
 * ## 왜 필요한가
 *
 * 자소서 편집·AI 는 **데스크탑 웹 전용**이다 (`useCoverletterReadOnly`: 뷰포트 <1024px 또는
 * 네이티브 → 보기 전용). 그런데 관측 화면에서 *"자소서를 안 썼다"* 를 세면 **모바일이라 못 쓴 것**과
 * **데스크탑에서 안 쓴 것**이 한 숫자에 섞인다. 전자를 후자로 읽으면 제품 판단이 통째로 어긋난다.
 *
 * 기존 `first_web_login_at` 은 **웹 vs 앱**만 가른다. 모바일 웹과 데스크탑 웹은 구분하지 못한다.
 *
 * ## 🔴 UA 로 추측하지 않는다
 *
 * 2026-08-04 에 UA 문자열로 앱을 판정했다가 **앱 로그인이 전부 "웹" 으로 분류**된 적이 있다
 * (`AddUserPlatformLoginColumns` 참조). 그래서 이번에도 UA 를 쓰지 않는다.
 *
 * 대신 **게이트 자신을 신호원으로 삼는다** — 프론트 `AppShell` 이
 * `useCoverletterReadOnly() === false` 인 순간에만 beacon 을 쏜다. 판정식이 게이트와 **같은 표현식**
 * 이므로 둘이 어긋날 수가 없다. (`first_web_login_at` 처럼 "어느 엔드포인트로 들어왔는가" 라는
 * 사실을 쓸 수 없는 이유 — 웹 로그인 콜백은 카카오·애플이 보내는 요청이라 뷰포트를 실을 수 없다.)
 *
 * ## 백필 — **분자만 채울 수 있다**
 *
 * | 근거 | 확실성 |
 * |---|---|
 * | 게이트 배포 후 자소서 **답변이 저장**됨 (`updated_at`) | 높음 — 그 화면은 데스크탑에서만 편집 가능 |
 * | 게이트 배포 후 자소서 **AI 를 `ok` 로 호출** | 높음 — AI 버튼도 같은 게이트 뒤 |
 *
 * 🔴 **비대칭**: *"데스크탑에 왔는데 자소서를 안 쓴"* 사용자는 **원리적으로 소급 불가**다.
 * 즉 백필은 분자만 채우고 **분모는 못 채운다.** 배포 직후 이 컬럼이 `NULL` 인 것은
 * **"모바일"** 이 아니라 **"미확인"** 이며, 화면에도 그렇게 표기한다.
 *
 * ### 컷오프를 왜 두나
 *
 * 게이트는 **2026-07-09 09:04:46 KST** 에 운영 반영됐다 (main #125 `973fe18`, 실측).
 * **그 전에는 모바일에서도 편집이 됐으므로** 이전 답변은 데스크탑을 증명하지 못한다.
 * Vercel 빌드·전파 여유를 두고 **10:00 KST** 를 컷오프로 쓴다 — 놓치는 쪽(과소 스탬프)이
 * 잘못 찍는 쪽(과대 스탬프)보다 안전하다.
 *
 * ### 근거로 `updated_at` 을 쓸 수 있는 이유 (실측 확인)
 *
 * - 이 테이블에 **UPDATE 트리거가 없다** → raw SQL 이 값을 건드리지 않는다
 * - 이 테이블을 **일괄 UPDATE 하는 마이그레이션이 없다** → 배치 작업이 시각을 밀어 올리지 않았다
 * - 즉 `updated_at` 갱신 = **TypeORM 저장 경로가 실제로 돌았다**는 뜻이고,
 *   그 경로(편집·AI 초안·피드백 저장)는 전부 게이트 뒤에 있다
 *
 * ⚠️ 게이트는 **클라이언트 UI 제약**이지 서버 강제가 아니다. API 를 직접 부르면 모바일에서도
 * 저장할 수 있다. 실사용자가 그럴 이유가 없어 확실성을 "높음" 으로 두지만 "확정" 은 아니다.
 */
export class AddUserFirstDesktopWebSeen1785000000000 implements MigrationInterface {
  name = 'AddUserFirstDesktopWebSeen1785000000000';

  /** 게이트가 운영에 반영된 시각 + 전파 여유 (main #125 = 2026-07-09 09:04:46 KST) */
  private static readonly GATE_LIVE_AT = '2026-07-09 10:00:00+09';

  /** 자소서 계열 feature — 퇴역 `coverletter` 는 과거 행에 문자열로 남아 있어 포함해야 이력이 안 잘린다 */
  private static readonly COVERLETTER_FEATURES = [
    'coverletter_draft_v2',
    'coverletter_feedback',
    'coverletter_recommend',
    'coverletter_chat',
    'coverletter',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS first_desktop_web_seen_at TIMESTAMPTZ NULL
    `);

    // 백필 — 두 근거의 **가장 이른 시각**을 쓴다.
    // users.created_at 을 쓰면 "가입 시점에 데스크탑이었다" 는, 알 수 없는 주장을 하게 된다.
    await queryRunner.query(
      `
      UPDATE users u
         SET first_desktop_web_seen_at = e.seen_at
        FROM (
          SELECT user_id, MIN(seen_at) AS seen_at
            FROM (
              -- ① 게이트 배포 후 자소서 답변이 저장됨
              SELECT a.user_id, MIN(ac.updated_at) AS seen_at
                FROM application_coverletters ac
                INNER JOIN applications a ON a.id = ac.application_id
               WHERE ac.answer IS NOT NULL
                 AND TRIM(ac.answer) <> ''
                 AND ac.updated_at > $1::timestamptz
               GROUP BY a.user_id

              UNION ALL

              -- ② 게이트 배포 후 자소서 AI 를 성공적으로 호출
              SELECT l.user_id, MIN(l.created_at) AS seen_at
                FROM llm_call_logs l
               WHERE l.status = 'ok'
                 AND l.feature = ANY($2::varchar[])
                 AND l.created_at > $1::timestamptz
               GROUP BY l.user_id
            ) ev
           GROUP BY user_id
        ) e
       WHERE e.user_id = u.id
         AND u.first_desktop_web_seen_at IS NULL
    `,
      [
        AddUserFirstDesktopWebSeen1785000000000.GATE_LIVE_AT,
        AddUserFirstDesktopWebSeen1785000000000.COVERLETTER_FEATURES,
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS first_desktop_web_seen_at
    `);
  }
}
