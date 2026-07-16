import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as jose from 'jose';
import { AppleTokenService } from './apple-token.service';

/**
 * AppleTokenService spec.
 *
 * SIWA client_secret(ES256 JWT) 서명 · authorization code 교환 · refresh_token revoke 헬퍼.
 * global fetch 는 jest.fn() 으로, jose(SignJWT·importPKCS8) 는 mock.
 *
 * ⚠️ jose v6 는 ESM 전용 → jest(CommonJS) 런타임에서 로드 불가(require 시 SyntaxError).
 *    따라서 전 spec 이 jose 를 mock 한다. "실제 ES256 서명·검증"은 이 unit 범위 밖(E2E).
 *    대신 우리 코드가 SignJWT 빌더에 넘기는 header/claim(alg·kid·iss·sub·aud·exp·iat)을
 *    캡처해 client_secret 구조를 검증한다.
 *
 * 검증할 경우의 수:
 *   [isConfigured]
 *     - TEAM·KEY·PRIVATE 모두 존재 → true (정상)
 *     - TEAM / KEY / PRIVATE 각각 하나라도 없음 → false (경계)
 *   [signClientSecret] (exchangeCode/revoke 통해 간접)
 *     - header alg=ES256 · kid=KEY_ID (정상)
 *     - iss=TEAM_ID · sub=clientId · aud=https://appleid.apple.com · exp=5m · iat 설정 (정상)
 *     - env 의 \n 리터럴 → 실제 개행 복원 후 importPKCS8(pem, 'ES256') (경계)
 *     - clientId 별로 sub 달라짐 (BUNDLE vs SERVICES) (경계)
 *   [exchangeCode]
 *     - fetch 200 + refresh_token → 반환 (정상)
 *     - body: grant_type=authorization_code · client_id · client_secret · code (구조)
 *     - redirectUri 전달 시 body 에 redirect_uri 포함 / 미전달 시 미포함 (경계)
 *     - fetch 비200(400) → null (실패)
 *     - fetch throw(네트워크) → null (실패)
 *     - 200 이지만 refresh_token 없음 → null (경계)
 *     - AbortSignal 이 fetch 에 전달됨 (timeout 배선)
 *   [revoke]
 *     - fetch 200 → true (정상)
 *     - body: token · token_type_hint=refresh_token · client_id · client_secret (구조)
 *     - fetch 비200(400) → false (실패)
 *     - fetch throw → false (실패)
 */

// ── jose mock: SignJWT 빌더 호출을 mockSignRecord 에 캡처 ──
// (변수명 mock* 접두사 — jest.mock factory 의 out-of-scope 참조 허용 규칙)
const mockSignedClientSecret = 'signed.client.secret.jwt';

interface MockSignRecord {
  header?: Record<string, unknown>;
  issuer?: string;
  subject?: string;
  audience?: string | string[];
  expirationTime?: string | number | Date;
  issuedAtCalled: boolean;
  signKey?: unknown;
}

const mockSignRecord: MockSignRecord = { issuedAtCalled: false };

jest.mock('jose', () => {
  class MockSignJWT {
    setProtectedHeader(header: Record<string, unknown>) {
      mockSignRecord.header = header;
      return this;
    }
    setIssuer(issuer: string) {
      mockSignRecord.issuer = issuer;
      return this;
    }
    setIssuedAt() {
      mockSignRecord.issuedAtCalled = true;
      return this;
    }
    setExpirationTime(exp: string | number | Date) {
      mockSignRecord.expirationTime = exp;
      return this;
    }
    setSubject(subject: string) {
      mockSignRecord.subject = subject;
      return this;
    }
    setAudience(audience: string | string[]) {
      mockSignRecord.audience = audience;
      return this;
    }
    async sign(key: unknown) {
      mockSignRecord.signKey = key;
      return mockSignedClientSecret;
    }
  }
  return {
    SignJWT: MockSignJWT,
    importPKCS8: jest.fn(),
  };
});

const mockedImportPKCS8 = jose.importPKCS8 as jest.MockedFunction<
  typeof jose.importPKCS8
>;
const mockImportedKey = 'mock-crypto-key' as unknown as Awaited<
  ReturnType<typeof jose.importPKCS8>
>;

// 정적 테스트 키 — Node crypto 로 즉석 생성한 P-256 PKCS8 (실 운영 키 아님).
// importPKCS8 은 mock 이라 실제 파싱되지 않음 · env \n 복원 검증용 리터럴로만 사용.
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1Et/8gvyo/KvMiDV
c5w2S6RpZB87yflkzbik2qN+clChRANCAAQh2uda2P5PEFJmIZ4pZ7BkZjZ+Vif4
cZEr1zkfSnidJ1TdXn8bKhf7yEzb9XcHpsVTEfyWvBsEFC3F5nU+DOd2
-----END PRIVATE KEY-----
`;
// env 에는 개행이 \n 리터럴로 저장됨 (Railway 등) — 서비스가 실제 개행으로 복원하는지 검증.
const TEST_PRIVATE_KEY_ENV = TEST_PRIVATE_KEY_PEM.replace(/\n/g, '\\n');

const TEAM_ID = 'TEAM123456';
const KEY_ID = 'KEY7890AB';
const BUNDLE_ID = 'com.chwippo.app';
const SERVICES_ID = 'com.chwippo.web';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_AUDIENCE = 'https://appleid.apple.com';

function okJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

function setFetch(mock: jest.Mock): void {
  global.fetch = mock;
}

describe('AppleTokenService', () => {
  let service: AppleTokenService;
  let configStore: Record<string, string | undefined>;
  const originalFetch = global.fetch;

  const configService = {
    get: jest.fn((key: string) => configStore[key]),
  };

  beforeEach(async () => {
    configStore = {
      APPLE_TEAM_ID: TEAM_ID,
      APPLE_KEY_ID: KEY_ID,
      APPLE_PRIVATE_KEY: TEST_PRIVATE_KEY_ENV,
    };
    mockSignRecord.header = undefined;
    mockSignRecord.issuer = undefined;
    mockSignRecord.subject = undefined;
    mockSignRecord.audience = undefined;
    mockSignRecord.expirationTime = undefined;
    mockSignRecord.issuedAtCalled = false;
    mockSignRecord.signKey = undefined;
    mockedImportPKCS8.mockReset();
    mockedImportPKCS8.mockResolvedValue(mockImportedKey);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppleTokenService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(AppleTokenService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  // ── isConfigured ──────────────────────────────────────
  describe('isConfigured', () => {
    it('TEAM·KEY·PRIVATE 모두 설정 → true', () => {
      expect(service.isConfigured()).toBe(true);
    });

    it.each(['APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'])(
      '%s 누락 → false',
      (missingKey) => {
        configStore[missingKey] = undefined;
        expect(service.isConfigured()).toBe(false);
      },
    );

    it('빈 문자열도 미설정으로 간주 → false', () => {
      configStore.APPLE_PRIVATE_KEY = '';
      expect(service.isConfigured()).toBe(false);
    });
  });

  // ── signClientSecret (exchangeCode 통해 간접) ─────────
  describe('signClientSecret — client_secret JWT 구조', () => {
    beforeEach(() => {
      setFetch(jest.fn().mockResolvedValue(okJson({ refresh_token: 'rt' })));
    });

    it('header: alg=ES256 · kid=KEY_ID', async () => {
      await service.exchangeCode('code', BUNDLE_ID);
      expect(mockSignRecord.header).toEqual({ alg: 'ES256', kid: KEY_ID });
    });

    it('claim: iss=TEAM · sub=clientId · aud=appleid · exp=5m · iat 설정', async () => {
      await service.exchangeCode('code', BUNDLE_ID);
      expect(mockSignRecord.issuer).toBe(TEAM_ID);
      expect(mockSignRecord.subject).toBe(BUNDLE_ID);
      expect(mockSignRecord.audience).toBe(APPLE_AUDIENCE);
      expect(mockSignRecord.expirationTime).toBe('5m');
      expect(mockSignRecord.issuedAtCalled).toBe(true);
    });

    it('env \\n 리터럴 → 실제 개행 복원 후 importPKCS8(pem, ES256)', async () => {
      await service.exchangeCode('code', BUNDLE_ID);
      expect(mockedImportPKCS8).toHaveBeenCalledWith(
        TEST_PRIVATE_KEY_PEM,
        'ES256',
      );
    });

    it('clientId 별 sub 반영 — 웹(SERVICES_ID)', async () => {
      await service.exchangeCode('code', SERVICES_ID);
      expect(mockSignRecord.subject).toBe(SERVICES_ID);
    });
  });

  // ── exchangeCode ──────────────────────────────────────
  describe('exchangeCode', () => {
    it('200 + refresh_token → refresh_token 반환', async () => {
      setFetch(
        jest.fn().mockResolvedValue(okJson({ refresh_token: 'rt-abc' })),
      );
      await expect(service.exchangeCode('code', BUNDLE_ID)).resolves.toBe(
        'rt-abc',
      );
    });

    it('body: grant_type·client_id·client_secret·code + POST + AbortSignal', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(okJson({ refresh_token: 'rt' }));
      setFetch(fetchMock);

      await service.exchangeCode('the-code', BUNDLE_ID);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(APPLE_TOKEN_URL);
      expect(init.method).toBe('POST');
      expect(init.signal).toBeDefined();
      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe(BUNDLE_ID);
      expect(body.get('client_secret')).toBe(mockSignedClientSecret);
      expect(body.get('code')).toBe('the-code');
    });

    it('redirectUri 전달(웹) → body 에 redirect_uri 포함', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(okJson({ refresh_token: 'rt' }));
      setFetch(fetchMock);

      await service.exchangeCode(
        'code',
        SERVICES_ID,
        'https://chwippo.com/auth/apple/web/callback',
      );

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = new URLSearchParams(init.body as string);
      expect(body.get('redirect_uri')).toBe(
        'https://chwippo.com/auth/apple/web/callback',
      );
    });

    it('redirectUri 미전달(네이티브) → body 에 redirect_uri 없음', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue(okJson({ refresh_token: 'rt' }));
      setFetch(fetchMock);

      await service.exchangeCode('code', BUNDLE_ID);

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = new URLSearchParams(init.body as string);
      expect(body.has('redirect_uri')).toBe(false);
    });

    it('fetch 400 → null (best-effort)', async () => {
      setFetch(jest.fn().mockResolvedValue(errorResponse(400)));
      await expect(service.exchangeCode('code', BUNDLE_ID)).resolves.toBeNull();
    });

    it('fetch throw(네트워크) → null (best-effort · throw X)', async () => {
      setFetch(jest.fn().mockRejectedValue(new Error('ECONNRESET')));
      await expect(service.exchangeCode('code', BUNDLE_ID)).resolves.toBeNull();
    });

    it('200 이지만 refresh_token 없음 → null', async () => {
      setFetch(jest.fn().mockResolvedValue(okJson({ access_token: 'x' })));
      await expect(service.exchangeCode('code', BUNDLE_ID)).resolves.toBeNull();
    });
  });

  // ── revoke ────────────────────────────────────────────
  describe('revoke', () => {
    it('200 → true', async () => {
      setFetch(jest.fn().mockResolvedValue(okJson({}, 200)));
      await expect(service.revoke('rt', BUNDLE_ID)).resolves.toBe(true);
    });

    it('body: token·token_type_hint=refresh_token·client_id·client_secret', async () => {
      const fetchMock = jest.fn().mockResolvedValue(okJson({}, 200));
      setFetch(fetchMock);

      await service.revoke('rt-xyz', BUNDLE_ID);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(APPLE_REVOKE_URL);
      const body = new URLSearchParams(init.body as string);
      expect(body.get('token')).toBe('rt-xyz');
      expect(body.get('token_type_hint')).toBe('refresh_token');
      expect(body.get('client_id')).toBe(BUNDLE_ID);
      expect(body.get('client_secret')).toBe(mockSignedClientSecret);
    });

    it('비200(400) → false', async () => {
      setFetch(jest.fn().mockResolvedValue(errorResponse(400)));
      await expect(service.revoke('rt', BUNDLE_ID)).resolves.toBe(false);
    });

    it('fetch throw(타임아웃) → false (best-effort · throw X)', async () => {
      setFetch(
        jest.fn().mockRejectedValue(new Error('The operation was aborted')),
      );
      await expect(service.revoke('rt', BUNDLE_ID)).resolves.toBe(false);
    });
  });
});
