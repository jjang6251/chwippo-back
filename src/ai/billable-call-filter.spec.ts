import { Between, In, MoreThan } from 'typeorm';
import { billableCallWhere } from './billable-call-filter';

/**
 * cost hardening 🟡1 — billableCallWhere spec.
 *
 * 시나리오:
 * - 반환 = OR 2갈래: [0] ok·retry_parsing / [1] error + completionTokens > 0
 * - base 조건(userId·feature·createdAt)이 두 갈래 모두 보존
 * - 토큰 0 error 는 매칭 안 됨 (MoreThan(0) — 호출 전 차단·5xx 는 한도 미집계)
 */
describe('billableCallWhere', () => {
  const base = {
    userId: 'u-1',
    feature: 'coverletter_draft_v2',
    createdAt: Between(new Date('2026-07-01'), new Date('2026-07-06')),
  };

  it('OR 2갈래 — ok·retry_parsing + 토큰 소모된 error', () => {
    const where = billableCallWhere(base);
    expect(where).toHaveLength(2);
    expect(where[0].status).toEqual(In(['ok', 'retry_parsing']));
    expect(where[1].status).toBe('error');
    expect(where[1].completionTokens).toEqual(MoreThan(0));
  });

  it('base 조건이 두 갈래 모두 보존', () => {
    const where = billableCallWhere(base);
    for (const branch of where) {
      expect(branch.userId).toBe('u-1');
      expect(branch.feature).toBe('coverletter_draft_v2');
      expect(branch.createdAt).toEqual(base.createdAt);
    }
  });

  it('error 갈래는 completionTokens 조건 필수 — 토큰 0 실패는 한도 미집계 설계', () => {
    const where = billableCallWhere({ userId: 'u-1' });
    // MoreThan(0) 이 아닌 다른 조건으로 바뀌면 (예: >= 0) 호출 전 차단까지
    // 한도에 집계돼 사용자가 억울하게 잠김 — 회귀 방지 anchor
    expect(where[1].completionTokens).toEqual(MoreThan(0));
  });
});
