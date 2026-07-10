export type LoginProvider = 'kakao' | 'apple';

/**
 * 사용자 인증 수단(kakaoId·appleSub) → 프론트 노출용 파생 배열.
 *
 * kakaoId·appleSub·appleEmail 원본은 절대 응답에 노출하지 않고 이 배열만 내려준다.
 * 병합 계정 대비 둘 다 있으면 둘 다 포함 · 순서는 kakao 먼저.
 */
export function deriveLoginProviders(user: {
  kakaoId: string | null;
  appleSub: string | null;
}): LoginProvider[] {
  const providers: LoginProvider[] = [];
  if (user.kakaoId) providers.push('kakao');
  if (user.appleSub) providers.push('apple');
  return providers;
}
