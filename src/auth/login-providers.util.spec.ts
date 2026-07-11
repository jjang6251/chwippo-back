import { deriveLoginProviders } from './login-providers.util';

/**
 * loginProviders 파생 — 설정 "로그인 방식" 표시·탈퇴 문구의 근거 배열.
 * raw kakaoId·appleSub 는 노출하지 않고 이 배열만 응답에 실린다.
 */
describe('deriveLoginProviders', () => {
  it('kakao 단독 → [kakao]', () => {
    expect(deriveLoginProviders({ kakaoId: '12345', appleSub: null })).toEqual([
      'kakao',
    ]);
  });

  it('apple 단독 → [apple]', () => {
    expect(
      deriveLoginProviders({ kakaoId: null, appleSub: 'sub-abc' }),
    ).toEqual(['apple']);
  });

  it('병합 계정 (둘 다) → [kakao, apple] 순서 고정', () => {
    expect(
      deriveLoginProviders({ kakaoId: '12345', appleSub: 'sub-abc' }),
    ).toEqual(['kakao', 'apple']);
  });

  it('둘 다 없음 (이론상) → 빈 배열', () => {
    expect(deriveLoginProviders({ kakaoId: null, appleSub: null })).toEqual([]);
  });
});
