import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 회원 사용 환경(웹/앱) 판정 근거를 **UA 추측 → 로그인 경로 사실**로 교체 (2026-08-04).
 *
 * 🔴 **왜 갈아엎나 — 직전 구현이 앱 사용자를 하나도 못 잡았다.**
 *
 * `refresh_sessions.device_info`(UA)에 `chwippo-mobile-webview` 표식이 있으면 앱으로 판정했는데,
 * 그 표식은 **WebView 렌더링 감지용**이었다. 앱의 로그인은 **네이티브 카카오/Apple SDK** 로
 * 이뤄지고 그 요청은 **WebView 를 거치지 않는다** — 네이티브 HTTP 클라이언트가 보내므로
 * UA 에 우리 표식이 없다. 결과적으로 **앱 로그인이 전부 "웹" 으로 분류**됐다.
 *
 * `index.html` 의 native 감지 코드를 보고 "앱은 UA 에 표식을 박는다" 고 단정한 게 원인이다.
 * **문자열 추측이 아니라 "어느 엔드포인트로 들어왔는가" 라는 사실을 기록한다.**
 *
 * | 엔드포인트 | 판정 |
 * |---|---|
 * | `POST /auth/kakao/native` · `POST /auth/apple/native` | **앱** |
 * | `GET /auth/kakao/callback` · `POST /auth/apple/web/callback` | **웹** |
 * | `POST /auth/reviewer-login` | 스탬프 없음 — 심사용 계정이라 통계를 오염시키면 안 된다 |
 *
 * **왜 `refresh_sessions` 가 아니라 `users` 인가**
 * - 세션에 찍으면 **이미 로그인한 사용자는 최대 180일(absolute cap) 동안 안 잡힌다**
 * - `SessionCleanupCron` 이 만료 세션을 지우므로 판정이 **세션 수명에 묶인다**
 *   (60일+ 미접속자의 뱃지가 `미접속` 으로 되돌아가던 기존 한계)
 * - users 컬럼이면 조회에서 **조인이 사라져 더 빠르다**
 *
 * **백필** — 컬럼만 추가하면 기존 회원이 전부 NULL 이라 화면이 전원 `미접속` 이 된다.
 * 이미 가진 데이터로 과거를 소급해 채운다:
 *
 * | 대상 | 근거 | 확실성 |
 * |---|---|---|
 * | 앱 | `user_devices` 의 ios/android 행 | **확정** — 푸시 토큰은 설치만으로 안 생긴다 (앱 실행 + 로그인 + 알림 허용 필요) |
 * | 웹 | `refresh_sessions` 의 브라우저 UA | **확정** — 브라우저만 이런 UA 를 보낸다 |
 *
 * ⚠️ **백필로 못 채우는 경우** — 앱을 쓰지만 **알림을 거부**했고 아직 재로그인 안 한 사용자.
 * 증거가 없다. 다음 앱 로그인 때 자동으로 채워진다.
 * 🔴 그래서 **배포 직후 "앱인데 알림 미허용" 은 0 으로 보인다** (백필 근거가 푸시 토큰이라서).
 * 이걸 "전원 허용" 으로 읽으면 안 된다 — 화면에도 같은 취지를 문구로 넣었다.
 *
 * 네이티브 HTTP 클라이언트 UA(`okhttp/…`·`CFNetwork/…`)로도 백필이 가능해 보이지만,
 * **실제 값을 확인하지 않았으므로 넣지 않는다.** 확인 없이 UA 를 단정한 것이 이번 버그의 원인이다.
 */
export class AddUserPlatformLoginColumns1784900000000 implements MigrationInterface {
  name = 'AddUserPlatformLoginColumns1784900000000';

  /** 앱 WebView 표식 — 백필 시 "브라우저 UA" 를 가려내는 데만 쓴다 */
  private static readonly APP_UA_MARKER = '%chwippo-mobile-webview%';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS first_app_login_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS first_web_login_at TIMESTAMPTZ NULL
    `);

    // 백필 ① 앱 — 푸시 토큰 보유 = 앱 실행·로그인 확정
    await queryRunner.query(`
      UPDATE users u
         SET first_app_login_at = d.first_seen
        FROM (
          SELECT user_id, MIN(created_at) AS first_seen
            FROM user_devices
           WHERE platform IN ('ios', 'android')
           GROUP BY user_id
        ) d
       WHERE d.user_id = u.id
         AND u.first_app_login_at IS NULL
    `);

    // 백필 ② 웹 — 살아있는 세션 중 브라우저 UA
    await queryRunner.query(
      `
      UPDATE users u
         SET first_web_login_at = s.first_seen
        FROM (
          SELECT user_id, MIN(created_at) AS first_seen
            FROM refresh_sessions
           WHERE device_info IS NOT NULL
             AND device_info NOT ILIKE $1
           GROUP BY user_id
        ) s
       WHERE s.user_id = u.id
         AND u.first_web_login_at IS NULL
    `,
      [AddUserPlatformLoginColumns1784900000000.APP_UA_MARKER],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS first_app_login_at,
        DROP COLUMN IF EXISTS first_web_login_at
    `);
  }
}
