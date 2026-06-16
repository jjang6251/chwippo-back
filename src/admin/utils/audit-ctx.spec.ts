import type { Request } from 'express';
import { getAuditCtx } from './audit-ctx';

/**
 * PR_B2 Phase 0.3 — getAuditCtx 단위 검증.
 *
 * 시나리오:
 * - 정상 IP + UA 추출
 * - req.ip 없음 → null
 * - User-Agent 헤더 없음 → null
 * - 둘 다 없음 → 둘 다 null
 * - 긴 UA (4000자) → 그대로 보존 (TEXT 컬럼 무제한)
 * - 한글 UA → UTF-8 정상
 */
describe('getAuditCtx', () => {
  const makeReq = (overrides: Partial<Request>): Request =>
    ({
      ip: undefined,
      headers: {},
      ...overrides,
    }) as Request;

  it('정상: req.ip + User-Agent 추출', () => {
    const req = makeReq({
      ip: '203.0.113.42',
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' },
    });
    expect(getAuditCtx(req)).toEqual({
      ip: '203.0.113.42',
      userAgent: 'Mozilla/5.0 Chrome/120',
    });
  });

  it('req.ip undefined → ip: null', () => {
    const req = makeReq({
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    expect(getAuditCtx(req)).toEqual({
      ip: null,
      userAgent: 'Mozilla/5.0',
    });
  });

  it('User-Agent 헤더 없음 → userAgent: null', () => {
    const req = makeReq({
      ip: '10.0.0.1',
      headers: {},
    });
    expect(getAuditCtx(req)).toEqual({
      ip: '10.0.0.1',
      userAgent: null,
    });
  });

  it('둘 다 없음 → 둘 다 null', () => {
    const req = makeReq({});
    expect(getAuditCtx(req)).toEqual({
      ip: null,
      userAgent: null,
    });
  });

  it('긴 UA 4000자 → 그대로 보존 (TEXT 무제한)', () => {
    const longUa = 'X'.repeat(4000);
    const req = makeReq({
      ip: '10.0.0.2',
      headers: { 'user-agent': longUa },
    });
    expect(getAuditCtx(req).userAgent).toHaveLength(4000);
  });

  it('한글 UA → UTF-8 정상', () => {
    const koUa = '치뽀 운영자 클라이언트 1.0';
    const req = makeReq({
      ip: '10.0.0.3',
      headers: { 'user-agent': koUa },
    });
    expect(getAuditCtx(req).userAgent).toBe(koUa);
  });
});
