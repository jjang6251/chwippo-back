import { CfThrottlerGuard } from './cf-throttler.guard';

/**
 * CfThrottlerGuard.getTracker — 스로틀 키 소스 선택.
 * 시나리오: ① CF 헤더 있으면 그 값 ② 없으면 req.ip 폴백
 * ③ 클라이언트가 req.ip 와 다른 CF 헤더 위조 시도 → CF 통과분(헤더)이 채택됨
 *   (CF 가 실제로 위조를 덮어쓰는 건 인프라 계약 — 여기선 헤더 우선 로직만 검증)
 * ④ 헤더 대소문자·headers 부재 방어
 */
describe('CfThrottlerGuard.getTracker', () => {
  // protected 접근용 서브클래스
  class TestGuard extends CfThrottlerGuard {
    call(req: Record<string, unknown>) {
      return this.getTracker(req);
    }
  }
  const guard = Object.create(TestGuard.prototype) as TestGuard;

  it('① CF-Connecting-IP 있으면 그 값을 키로', async () => {
    const req = {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      ip: '172.16.0.1',
    };
    expect(await guard.call(req)).toBe('203.0.113.7');
  });

  it('② CF 헤더 없으면 req.ip 폴백 (로컬·직접 접근)', async () => {
    const req = { headers: {}, ip: '127.0.0.1' };
    expect(await guard.call(req)).toBe('127.0.0.1');
  });

  it('③ CF 헤더가 req.ip(=CF 이그레스, 변동)와 달라도 헤더 채택 — 방문자당 카운트', async () => {
    const a = {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      ip: '10.0.0.1',
    };
    const b = {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      ip: '10.0.0.2',
    };
    // 같은 방문자 → 이그레스가 달라도 동일 키
    expect(await guard.call(a)).toBe(await guard.call(b));
  });

  it('④ headers 부재 시 크래시 없이 req.ip 폴백', async () => {
    const req = { ip: '198.51.100.9' } as Record<string, unknown>;
    expect(await guard.call(req)).toBe('198.51.100.9');
  });
});
