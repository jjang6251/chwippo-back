import { JobPostingCardController } from './job-posting-card.controller';

/**
 * 컨트롤러 **설정**만 본다 — 로직은 `job-posting-card.service.spec.ts`,
 * 실제 차단·라우팅 동작은 e2e 몫이다.
 *
 * e2e 는 케이스마다 스로틀 카운터를 비우므로(그러지 않으면 10회에서 막힌다) **한도 값 자체**는
 * 거기서 지켜지지 않는다. 여기가 그 값을 잠그는 자리다.
 */
describe('JobPostingCardController — 남용 상한·라우트 등록 순서', () => {
  it('🔴 파싱 엔드포인트에 10회/분 @Throttle 이 걸려 있다', () => {
    const method = JobPostingCardController.prototype.create;
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', method)).toBe(60_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', method)).toBe(10);
  });

  it('commit 에도 같은 한도 — 초안만 있으면 무한히 카드를 찍을 수 있다', () => {
    const method = JobPostingCardController.prototype.commit;
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', method)).toBe(60_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', method)).toBe(10);
  });

  it('복원 조회(pending)·확인 기록(posting-meta)에는 한도를 걸지 않는다 — 읽기·멱등이다', () => {
    expect(
      Reflect.getMetadata(
        'THROTTLER:LIMITdefault',
        JobPostingCardController.prototype.pending,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        'THROTTLER:LIMITdefault',
        JobPostingCardController.prototype.updatePostingMeta,
      ),
    ).toBeUndefined();
  });

  /**
   * ⚠️ **라우트 등록 순서는 여기서 못 본다.**
   *
   * `ApplicationsModule` 을 import 하면 전 의존 그래프(jose 등 ESM 포함)가 딸려와
   * 단위 jest 변환 설정에 걸린다. 순서 계약(`JobPostingCardController` 가
   * `ApplicationsController` 보다 먼저)은 **실제 요청**으로 확인하는 편이 어차피 강하다 —
   * `test/applications-from-posting.e2e-spec.ts` 의 E2 케이스가 그 자리다
   * (`GET /applications/from-posting/pending` 이 200 인가, ParseUUIDPipe 400 인가).
   */
});
