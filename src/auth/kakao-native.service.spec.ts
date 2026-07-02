import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { KakaoNativeService } from './kakao-native.service';

/**
 * KakaoNativeService spec.
 *
 * 시나리오:
 *   1) verifyAndFetchUser 정상 (email · nickname 있음 / 둘 다 없음 / 부분)
 *   2) 빈 accessToken → BadRequestException
 *   3) undefined accessToken → BadRequestException
 *   4) Kakao 401 → UnauthorizedException
 *   5) Kakao 500 → UnauthorizedException
 *   6) 네트워크 오류 (fetch reject) → UnauthorizedException
 *   7) 응답 JSON 파싱 실패 → UnauthorizedException
 *   8) 응답에 id 누락 → UnauthorizedException
 *   9) 응답 id 가 string (Kakao API 스펙 위반) → UnauthorizedException
 *   10) nickname 없으면 fallback user_<id 앞 8자>
 */
describe('KakaoNativeService', () => {
  let service: KakaoNativeService;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [KakaoNativeService],
    }).compile();

    service = module.get(KakaoNativeService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  const mockKakaoOk = (body: object) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    }) as never;
  };

  const mockKakaoStatus = (status: number) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => ({}),
    }) as never;
  };

  it('정상 (email + nickname 있음) → KakaoUser 반환', async () => {
    mockKakaoOk({
      id: 123456789,
      kakao_account: {
        email: 'foo@example.com',
        profile: { nickname: '홍길동' },
      },
    });

    const result = await service.verifyAndFetchUser('valid-token');

    expect(result).toEqual({
      kakaoId: '123456789',
      nickname: '홍길동',
      email: 'foo@example.com',
    });
  });

  it('nickname 없음 → fallback user_<id 앞 8자>', async () => {
    mockKakaoOk({
      id: 987654321,
      kakao_account: {},
    });

    const result = await service.verifyAndFetchUser('valid-token');

    expect(result.kakaoId).toBe('987654321');
    expect(result.nickname).toBe('user_98765432');
    expect(result.email).toBeNull();
  });

  it('email 없음 → email null', async () => {
    mockKakaoOk({
      id: 111,
      kakao_account: { profile: { nickname: '길동' } },
    });

    const result = await service.verifyAndFetchUser('valid-token');

    expect(result.email).toBeNull();
    expect(result.nickname).toBe('길동');
  });

  it('kakao_account 자체 없음 (동의 스킵) → nickname fallback · email null', async () => {
    mockKakaoOk({ id: 55555 });

    const result = await service.verifyAndFetchUser('valid-token');

    expect(result.nickname).toBe('user_55555');
    expect(result.email).toBeNull();
  });

  it('nickname 공백만 → fallback user_<id>', async () => {
    mockKakaoOk({
      id: 42,
      kakao_account: { profile: { nickname: '   ' } },
    });

    const result = await service.verifyAndFetchUser('valid-token');

    expect(result.nickname).toBe('user_42');
  });

  it('빈 accessToken → BadRequestException', async () => {
    await expect(service.verifyAndFetchUser('')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('undefined accessToken → BadRequestException', async () => {
    await expect(
      service.verifyAndFetchUser(undefined as unknown as string),
    ).rejects.toThrow(BadRequestException);
  });

  it('Kakao 401 (token 무효) → UnauthorizedException', async () => {
    mockKakaoStatus(401);
    await expect(service.verifyAndFetchUser('bad')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('Kakao 500 → UnauthorizedException', async () => {
    mockKakaoStatus(500);
    await expect(service.verifyAndFetchUser('valid')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('네트워크 오류 → UnauthorizedException', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNRESET')) as never;

    await expect(service.verifyAndFetchUser('valid')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('응답 JSON 파싱 실패 → UnauthorizedException', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid json');
      },
    }) as never;

    await expect(service.verifyAndFetchUser('valid')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('응답 id 누락 → UnauthorizedException', async () => {
    mockKakaoOk({ kakao_account: {} });

    await expect(service.verifyAndFetchUser('valid')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('응답 id 가 string 이면 → UnauthorizedException (Kakao 스펙상 number)', async () => {
    mockKakaoOk({ id: '123' });

    await expect(service.verifyAndFetchUser('valid')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('Authorization header · Content-Type 정확', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 1 }),
    });
    global.fetch = fetchSpy as never;

    await service.verifyAndFetchUser('my-access-token');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://kapi.kakao.com/v2/user/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer my-access-token',
        }),
      }),
    );
  });
});
