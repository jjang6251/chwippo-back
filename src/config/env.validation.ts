import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').default(''), // Postgres.app은 비밀번호 없음
  DB_DATABASE: Joi.string().required(),
  // 코드에서 `=== 'true'` 비교 — 오타(True/1/yes 등)가 silent false 되지 않도록 화이트리스트
  DB_SSL: Joi.string().valid('true', 'false').default('false'),

  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRES_IN: Joi.string().default('1h'),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('60d'), // 세션 sliding 60d 와 정합 필수 — 짧으면 JWT 가 세션보다 먼저 만료 (세션 지속성 웨이브 2026-07-14)

  KAKAO_CLIENT_ID: Joi.string().required(),
  KAKAO_CLIENT_SECRET: Joi.string().required(),
  KAKAO_REDIRECT_URI: Joi.string().required(),

  // Sign in with Apple.
  // BUNDLE_ID 는 identity token aud 검증에 항상 필요 → required (기존 getOrThrow 사용처와 정합).
  // 나머지는 Apple 콘솔 산출물(.p8·Key ID·Services ID)이 없는 로컬/CI 부팅이 안 깨지게 optional.
  // 미설정 시 revoke·웹 SIWA 는 스킵 (AppleTokenService.isConfigured() 가드).
  APPLE_BUNDLE_ID: Joi.string().required(),
  APPLE_TEAM_ID: Joi.string().allow('').optional(),
  APPLE_KEY_ID: Joi.string().allow('').optional(),
  APPLE_PRIVATE_KEY: Joi.string().allow('').optional(), // .p8 PEM (개행은 \n 리터럴)
  APPLE_SERVICES_ID: Joi.string().allow('').optional(), // 웹 SIWA client_id
  APPLE_WEB_REDIRECT_URI: Joi.string().allow('').optional(), // 웹 SIWA form_post 콜백 URL

  // prod에선 required (실수로 누락 시 localhost로 silent redirect 방지)
  FRONTEND_URL: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.string().default('http://localhost:5173'),
  }),

  // Cloudflare R2 (S3 호환) — 파일 업로드 인프라
  // production에선 required, dev에선 optional (자격증명 없어도 다른 기능 개발 가능하도록)
  R2_ENDPOINT: Joi.string().uri().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  R2_ACCESS_KEY_ID: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  R2_SECRET_ACCESS_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  R2_BUCKET: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  R2_PUBLIC_URL: Joi.string().uri().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  // 사용자당 저장 용량 한도 (MB 단위)
  MAX_STORAGE_PER_USER_MB: Joi.number().integer().min(1).default(100),

  ADMIN_EMAIL: Joi.string().allow('').optional(),
  ADMIN_KAKAO_ID: Joi.string().allow('').optional(),

  // App Review(App Store Guideline 2.1) 전용 리뷰어 로그인 크리덴셜.
  // 심사관은 카카오 계정을 만들 수 없어 우회 로그인 경로 필요.
  // 둘 다 설정된 경우에만 POST /auth/reviewer-login 활성 (미설정 → 404, 엔드포인트 부재처럼).
  // REVIEWER_PASSWORD_HASH = bcrypt hash (평문 비번은 DB·env 어디에도 저장 안 함).
  REVIEWER_EMAIL: Joi.string().allow('').optional(),
  REVIEWER_PASSWORD_HASH: Joi.string().allow('').optional(),

  // OpenAI (F5+) — dev 에선 optional, prod 필수
  OPENAI_API_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  OPENAI_MODEL_LIGHT: Joi.string().default('gpt-4o-mini'),
  OPENAI_MODEL_HEAVY: Joi.string().default('gpt-4o'),

  // Anthropic (PR 0 — 자소서 등 한국어 중심 feature 용)
  // dev 에선 optional (key 없으면 isAvailable=false 로 fallback). prod 도 optional —
  // OpenAI 만으로 운영 시작해도 동작. Anthropic feature 호출 시 blocked_provider_unavailable 처리
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  ANTHROPIC_MODEL_LIGHT: Joi.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_MODEL_HEAVY: Joi.string().default('claude-sonnet-4-6'),

  // PR 1 Phase 3 — AbuserBan Discord webhook (자동 ban 발동 알림). 미설정 시 ban 발동 + webhook skip
  // (채널 분리 후 fallback 용 · deprecated 예정)
  ADMIN_ALERT_WEBHOOK_URL: Joi.string().uri().allow('').optional(),

  // Discord 알람 채널 분리 (critical/inquiries/growth/ops). 미설정 시 ADMIN_ALERT_WEBHOOK_URL fallback
  DISCORD_WEBHOOK_CRITICAL: Joi.string().uri().allow('').optional(),
  DISCORD_WEBHOOK_INQUIRIES: Joi.string().uri().allow('').optional(),
  DISCORD_WEBHOOK_GROWTH: Joi.string().uri().allow('').optional(),
  DISCORD_WEBHOOK_OPS: Joi.string().uri().allow('').optional(),

  // 5xx 스파이크 알림 임계치 (10분 window · 초과 시 critical)
  HTTP_5XX_ALERT_THRESHOLD: Joi.number().integer().min(1).default(20),
});
