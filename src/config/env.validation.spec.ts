/**
 * env.validation (Joi schema) 단위 테스트
 *
 * 시나리오:
 * - production 모드: R2_* 5개 + 공통 required → 누락 시 fail
 * - development 모드: R2_*는 optional, 공통 required는 동일하게 fail
 * - 양쪽 모드 공통 required: JWT/DB/KAKAO
 * - default 값: PORT, NODE_ENV, DB_PORT, JWT_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN, FRONTEND_URL, MAX_STORAGE_PER_USER_MB
 * - invalid: NODE_ENV='staging', MAX_STORAGE_PER_USER_MB=0·-5
 * - allow-empty: ADMIN_EMAIL, ADMIN_KAKAO_ID, DB_PASSWORD
 */
import { envValidationSchema } from './env.validation';

/** 공통 required(JWT·DB·KAKAO·APPLE_BUNDLE_ID)만 채운 최소 dev env */
const minimalDevEnv: Record<string, string> = {
  NODE_ENV: 'development',
  DB_HOST: 'localhost',
  DB_USERNAME: 'postgres',
  DB_DATABASE: 'chwippo',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  KAKAO_CLIENT_ID: 'kakao-id',
  KAKAO_CLIENT_SECRET: 'kakao-secret',
  KAKAO_REDIRECT_URI: 'http://localhost:3000/auth/kakao/callback',
  // Apple SIWA — 네이티브 로그인 필수 (env.validation 에 required 등록)
  APPLE_BUNDLE_ID: 'com.chwippo.app',
};

/** prod env = minimal + R2_* + FRONTEND_URL (prod required) */
const minimalProdEnv: Record<string, string> = {
  ...minimalDevEnv,
  NODE_ENV: 'production',
  FRONTEND_URL: 'https://example.com',
  R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
  R2_BUCKET: 'bucket',
  R2_PUBLIC_URL: 'https://files.example.com',
  OPENAI_API_KEY: 'sk-test-key',
};

function validate(env: Record<string, unknown>) {
  return envValidationSchema.validate(env, { abortEarly: false });
}

function errorKeys(err: unknown): string[] {
  if (
    !err ||
    typeof err !== 'object' ||
    !('details' in err) ||
    !Array.isArray((err as { details: unknown[] }).details)
  ) {
    return [];
  }
  return (err as { details: { path: (string | number)[] }[] }).details.map(
    (d) => String(d.path[0]),
  );
}

describe('envValidationSchema', () => {
  describe('production 모드 — R2_* required', () => {
    it('완전한 prod env → 통과', () => {
      const { error } = validate(minimalProdEnv);
      expect(error).toBeUndefined();
    });

    it.each([
      'R2_ENDPOINT',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_PUBLIC_URL',
    ])('%s 누락 → fail', (key) => {
      const env = { ...minimalProdEnv };
      delete env[key];
      const { error } = validate(env);
      expect(errorKeys(error)).toContain(key);
    });

    it('R2_ENDPOINT가 URI 형식 아님 → fail', () => {
      const { error } = validate({
        ...minimalProdEnv,
        R2_ENDPOINT: 'not-a-uri',
      });
      expect(errorKeys(error)).toContain('R2_ENDPOINT');
    });

    it('R2_PUBLIC_URL이 URI 형식 아님 → fail', () => {
      const { error } = validate({
        ...minimalProdEnv,
        R2_PUBLIC_URL: 'not-a-uri',
      });
      expect(errorKeys(error)).toContain('R2_PUBLIC_URL');
    });
  });

  describe('development 모드 — R2_* optional', () => {
    it('R2_* 모두 누락이어도 통과', () => {
      const { error } = validate(minimalDevEnv);
      expect(error).toBeUndefined();
    });

    it('R2_* 일부만 있어도 통과 (optional)', () => {
      const { error } = validate({
        ...minimalDevEnv,
        R2_BUCKET: 'dev-bucket',
      });
      expect(error).toBeUndefined();
    });
  });

  describe('양쪽 모드 공통 required (JWT·DB·KAKAO)', () => {
    const required = [
      'DB_HOST',
      'DB_USERNAME',
      'DB_DATABASE',
      'JWT_SECRET',
      'JWT_REFRESH_SECRET',
      'KAKAO_CLIENT_ID',
      'KAKAO_CLIENT_SECRET',
      'KAKAO_REDIRECT_URI',
    ];

    it.each(required)('dev 모드: %s 누락 → fail', (key) => {
      const env = { ...minimalDevEnv };
      delete env[key];
      const { error } = validate(env);
      expect(errorKeys(error)).toContain(key);
    });

    it.each(required)('prod 모드: %s 누락 → fail', (key) => {
      const env = { ...minimalProdEnv };
      delete env[key];
      const { error } = validate(env);
      expect(errorKeys(error)).toContain(key);
    });

    it('.env 완전히 비어있으면 prod 모드 13개 required 모두 fail', () => {
      const { error } = validate({ NODE_ENV: 'production' });
      const keys = errorKeys(error);
      [
        ...required,
        'R2_ENDPOINT',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_BUCKET',
        'R2_PUBLIC_URL',
      ].forEach((k) => expect(keys).toContain(k));
    });
  });

  describe('default 값', () => {
    it('PORT 누락 → 3000', () => {
      const { value } = validate(minimalDevEnv);
      expect(value.PORT).toBe(3000);
    });

    it('NODE_ENV 누락 → development', () => {
      const env = { ...minimalDevEnv };
      delete env.NODE_ENV;
      const { value } = validate(env);
      expect(value.NODE_ENV).toBe('development');
    });

    it('DB_PORT 누락 → 5432', () => {
      const { value } = validate(minimalDevEnv);
      expect(value.DB_PORT).toBe(5432);
    });

    it('JWT_EXPIRES_IN 누락 → 1h', () => {
      const { value } = validate(minimalDevEnv);
      expect(value.JWT_EXPIRES_IN).toBe('1h');
    });

    it('JWT_REFRESH_EXPIRES_IN 누락 → 60d (세션 sliding 60d 정합)', () => {
      const { value } = validate(minimalDevEnv);
      expect(value.JWT_REFRESH_EXPIRES_IN).toBe('60d');
    });

    it('dev 모드: FRONTEND_URL 누락 → default http://localhost:5173', () => {
      const env = { ...minimalDevEnv };
      delete env.FRONTEND_URL;
      const { value, error } = validate(env);
      expect(error).toBeUndefined();
      expect(value.FRONTEND_URL).toBe('http://localhost:5173');
    });

    it('prod 모드: FRONTEND_URL 누락 → fail (silent localhost fallback 차단)', () => {
      const env = { ...minimalProdEnv };
      delete env.FRONTEND_URL;
      const { error } = validate(env);
      expect(errorKeys(error)).toContain('FRONTEND_URL');
    });

    it('MAX_STORAGE_PER_USER_MB 누락 → 100', () => {
      const { value } = validate(minimalDevEnv);
      expect(value.MAX_STORAGE_PER_USER_MB).toBe(100);
    });

    it("DB_SSL 누락 → 'false'", () => {
      const { value } = validate(minimalDevEnv);
      expect(value.DB_SSL).toBe('false');
    });
  });

  describe('invalid 값', () => {
    it("NODE_ENV='staging' → fail (valid: development/production/test)", () => {
      const { error } = validate({ ...minimalDevEnv, NODE_ENV: 'staging' });
      expect(errorKeys(error)).toContain('NODE_ENV');
    });

    it("DB_SSL='True'(대문자) → fail (소문자만 허용)", () => {
      const { error } = validate({ ...minimalDevEnv, DB_SSL: 'True' });
      expect(errorKeys(error)).toContain('DB_SSL');
    });

    it("DB_SSL='1' → fail (valid: 'true'|'false')", () => {
      const { error } = validate({ ...minimalDevEnv, DB_SSL: '1' });
      expect(errorKeys(error)).toContain('DB_SSL');
    });

    it('MAX_STORAGE_PER_USER_MB=0 → fail (min 1)', () => {
      const { error } = validate({
        ...minimalDevEnv,
        MAX_STORAGE_PER_USER_MB: 0,
      });
      expect(errorKeys(error)).toContain('MAX_STORAGE_PER_USER_MB');
    });

    it('MAX_STORAGE_PER_USER_MB=-5 → fail', () => {
      const { error } = validate({
        ...minimalDevEnv,
        MAX_STORAGE_PER_USER_MB: -5,
      });
      expect(errorKeys(error)).toContain('MAX_STORAGE_PER_USER_MB');
    });
  });

  describe('allow-empty optional', () => {
    it("DB_PASSWORD='' → 통과 (postgres.app은 비밀번호 없음)", () => {
      const { error } = validate({ ...minimalDevEnv, DB_PASSWORD: '' });
      expect(error).toBeUndefined();
    });

    it("ADMIN_EMAIL='' → 통과", () => {
      const { error } = validate({ ...minimalDevEnv, ADMIN_EMAIL: '' });
      expect(error).toBeUndefined();
    });

    it("ADMIN_KAKAO_ID='' → 통과", () => {
      const { error } = validate({ ...minimalDevEnv, ADMIN_KAKAO_ID: '' });
      expect(error).toBeUndefined();
    });
  });
});
