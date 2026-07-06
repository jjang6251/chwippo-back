import { In, MoreThan } from 'typeorm';

/**
 * cost hardening 🟡1 — quota·abuser 집계용 "비용이 발생한 호출" 필터.
 *
 * F6 PR0 정책 "ok + retry_parsing + error(토큰>0)" 의 실구현:
 * parse 실패 등 토큰이 소모된 error 는 provider 가 전액 과금하므로
 * 사용자 한도에도 집계해야 실패 반복으로 비용을 태우는 어뷰징이 막힌다.
 * (🔴1 수정으로 실패 row 에 실측 토큰이 기록되기 시작하면서 유효해짐)
 *
 * ⚠️ cooldown 판정에는 쓰지 않는다 — 실패 직후엔 즉시 재시도를 허용하는 게
 * 정상 사용자 UX (기존 ok·retry_parsing 필터 유지).
 */
export function billableCallWhere<T extends Record<string, unknown>>(
  base: T,
): [
  T & { status: ReturnType<typeof In<string>> },
  T & {
    status: 'error';
    completionTokens: ReturnType<typeof MoreThan<number>>;
  },
] {
  return [
    { ...base, status: In(['ok', 'retry_parsing']) },
    { ...base, status: 'error', completionTokens: MoreThan(0) },
  ];
}
