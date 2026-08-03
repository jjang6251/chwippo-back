/**
 * 사용 환경 판정 — 순수 함수 spec.
 *
 * 🔴 **이 spec 은 한 번 갈아엎였다** (2026-08-04). 직전 버전은 **UA 문자열**을 검증했고
 * 14 케이스가 전부 통과했는데, **앱 사용자를 하나도 못 잡는 구현**이었다.
 *
 * 이유: 앱 로그인은 **네이티브 SDK** 로 이뤄져 WebView 를 거치지 않는다. UA 에 앱 표식이
 * 애초에 없다. 즉 **테스트가 검증한 건 "규칙대로 동작하는가" 였지 "규칙이 맞는가" 가 아니었다.**
 * 내가 만든 UA 픽스처는 실제 앱이 보내는 값이 아니라 **내가 그럴 거라 믿은 값**이었다.
 *
 * 그래서 판정 근거를 **로그인 엔드포인트라는 사실**로 바꿨다. 이 spec 은 이제 문자열이 아니라
 * "스탬프가 찍혔는가" 만 본다 — 추측이 끼어들 자리가 없다.
 *
 * 시나리오:
 * - 스탬프 유무 → app/web (Date · ISO 문자열 · null · undefined)
 * - 4분류 배타성 (합계 = 전체 보장)
 */
import { classifyLoginStamps, toSegment } from './user-platform';

const T = new Date('2026-07-20T10:00:00Z');

describe('classifyLoginStamps', () => {
  it('앱 스탬프만 있으면 app_only', () => {
    expect(toSegment(classifyLoginStamps(T, null))).toBe('app_only');
  });

  it('웹 스탬프만 있으면 web_only', () => {
    expect(toSegment(classifyLoginStamps(null, T))).toBe('web_only');
  });

  it('둘 다 있으면 both', () => {
    expect(toSegment(classifyLoginStamps(T, T))).toBe('both');
  });

  it('둘 다 없으면 none', () => {
    expect(toSegment(classifyLoginStamps(null, null))).toBe('none');
  });

  /** DB 드라이버가 문자열로 줄 수도 있다 — 값의 유무만 보므로 형태에 안 휘둘려야 한다 */
  it('ISO 문자열로 와도 동일하게 판정한다', () => {
    expect(classifyLoginStamps('2026-07-20T10:00:00Z', null)).toEqual({
      app: true,
      web: false,
    });
  });

  /** 컬럼이 아직 없는 배포 창·미조회 필드 → undefined */
  it('undefined 는 "없음" 으로 본다', () => {
    expect(classifyLoginStamps(undefined, undefined)).toEqual({
      app: false,
      web: false,
    });
  });
});

describe('toSegment — 4분류 배타성', () => {
  /**
   * 🔴 **대시보드 합계가 전체 인원과 맞으려면 4분류가 배타적이어야 한다.**
   * 하나라도 겹치면 "웹만 + 앱만 + 둘다 + 미접속 > 전체" 가 되어 화면이 거짓말을 한다.
   */
  it('가능한 조합 4가지가 각각 다른 segment 로 간다', () => {
    const segments = [
      toSegment({ app: true, web: true }),
      toSegment({ app: true, web: false }),
      toSegment({ app: false, web: true }),
      toSegment({ app: false, web: false }),
    ];
    expect(segments).toEqual(['both', 'app_only', 'web_only', 'none']);
    expect(new Set(segments).size).toBe(4);
  });
});
