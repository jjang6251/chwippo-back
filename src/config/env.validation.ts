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
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('30d'),

  KAKAO_CLIENT_ID: Joi.string().required(),
  KAKAO_CLIENT_SECRET: Joi.string().required(),
  KAKAO_REDIRECT_URI: Joi.string().required(),

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

  // OpenAI (F5+) — dev 에선 optional, prod 필수
  OPENAI_API_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  OPENAI_MODEL_LIGHT: Joi.string().default('gpt-4o-mini'),
  OPENAI_MODEL_HEAVY: Joi.string().default('gpt-4o'),
});
