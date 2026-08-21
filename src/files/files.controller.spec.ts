import { FilesController } from './files.controller';

/**
 * 컨트롤러 **설정**만 본다 — 로직은 `files.service.spec.ts`, 실제 차단 동작은 운영 몫이다.
 * `@Throttle` 은 메서드에 `THROTTLER:*default` 메타데이터를 남기므로 결정적으로 검증된다
 * (auth 컨트롤러 brute-force 한도와 같은 방식).
 */
describe('FilesController — 발급 한도', () => {
  it('🔴 presigned 발급에 30회/분 @Throttle 이 걸려 있다', () => {
    const method = FilesController.prototype.getPresignedUrl;
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', method)).toBe(60_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', method)).toBe(30);
  });

  it('삭제(보상 호출)에는 한도를 걸지 않는다 — 정리가 막히면 고아가 늘어난다', () => {
    const method = FilesController.prototype.deleteOwnFile;
    expect(
      Reflect.getMetadata('THROTTLER:LIMITdefault', method),
    ).toBeUndefined();
  });
});
