// @Type(() => BulkQuestionItemDto) 데코레이터가 Reflect metadata 를 요구.
// Nest 앱은 부트스트랩에서 로드하지만 unit 러너는 안 하므로 여기서 선로드.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  BULK_MAX_ITEMS,
  BulkCreateQuestionsDto,
} from './bulk-create-questions.dto';
import {
  GENERATE_COUNT_MAX,
  GENERATE_COUNT_MIN,
  GenerateSessionDto,
} from './generate-session.dto';
import { PracticeQuestionDto } from './practice-question.dto';
import { UpdateQuestionDto } from './update-question.dto';

/**
 * 질문 은행 D1 — **DTO 가 막는 것**의 spec (2026-08-11).
 *
 * 구조 검증(개수·enum·타입)은 전역 `ValidationPipe` 가 service 앞에서 끝내므로
 * service spec 으로는 볼 수 없는 층이다. 여기서 직접 `validateSync` 로 확인한다.
 * (같은 규칙이 실제 HTTP 400 으로 나오는지는 e2e 가 한 번 더 본다.)
 *
 * 시나리오:
 *  V1 items 1개 → 통과
 *  V2 items 50개(경계) → 통과
 *  V3 items 51개 → 실패 (ArrayMaxSize)
 *  V4 items 0개 → 실패 (ArrayMinSize)
 *  V5 questionText 가 문자열이 아님 → 실패
 *  V6 category 화이트리스트 밖 → 실패
 *  V7 category 화이트리스트 안 → 통과
 *  V8 category 생략 → 통과 (강제 아님)
 *  V9 parentQuestionId 가 UUID 아님 → 실패
 *  V10 practice result 3종 → 통과
 *  V11 practice result 그 밖 → 실패
 *  V12 🔴 practice DTO 에 **시각 필드가 없다** (클라이언트 시각 주입 자리를 안 만든다)
 *  V13 PATCH category 화이트리스트 밖 → 실패
 *  V14 PATCH category: null → 통과 (미분류로 되돌리기)
 *
 * ── D1b (2026-08-11) ──
 *  V15 PATCH mustPrepare 불리언 → 통과 / 문자열 → 실패
 *  V16 generate count 1·20 경계 → 통과 · 0·21·소수 → 실패
 *  V17 generate count 생략 → 통과 (기본 20 은 서비스가 정한다)
 *  V18 generate category 화이트리스트 밖 → 실패
 *  V19 🔴 generate `regenerate` 는 **여전히 받아야 한다** — 지우면 옛 프론트가 400
 *  V20 generate 에 모르는 필드 → 실패 (forbidNonWhitelisted)
 */
describe('질문 은행 DTO 검증', () => {
  const bulk = (body: unknown) =>
    validateSync(plainToInstance(BulkCreateQuestionsDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  const item = (over: Record<string, unknown> = {}) => ({
    questionText: '자기소개 해보세요',
    ...over,
  });

  it('V1 items 1개 → 통과', () => {
    expect(bulk({ items: [item()] })).toHaveLength(0);
  });

  it('V2 items 50개 경계 → 통과', () => {
    const items = Array.from({ length: BULK_MAX_ITEMS }, () => item());
    expect(bulk({ items })).toHaveLength(0);
  });

  it('V3 items 51개 → 실패', () => {
    const items = Array.from({ length: BULK_MAX_ITEMS + 1 }, () => item());
    expect(bulk({ items }).length).toBeGreaterThan(0);
  });

  it('V4 items 0개 → 실패', () => {
    expect(bulk({ items: [] }).length).toBeGreaterThan(0);
  });

  it('V5 questionText 가 문자열이 아니면 실패', () => {
    expect(bulk({ items: [{ questionText: 123 }] }).length).toBeGreaterThan(0);
  });

  it('V6 category 화이트리스트 밖 → 실패', () => {
    // 🔴 'etc' 는 **면접 종류**의 값이지 카테고리가 아니다. 둘을 섞으면 화면이
    //    `CATEGORY_LABEL['etc']` 를 못 찾아 슬러그를 그대로 노출한다.
    expect(bulk({ items: [item({ category: 'etc' })] }).length).toBeGreaterThan(
      0,
    );
    expect(
      bulk({ items: [item({ category: '자기소개' })] }).length,
    ).toBeGreaterThan(0);
  });

  it('V7 화이트리스트 안의 category → 통과', () => {
    expect(bulk({ items: [item({ category: 'self_intro' })] })).toHaveLength(0);
  });

  it('V8 category 생략 → 통과 (분류를 강제하지 않는다)', () => {
    expect(bulk({ items: [item()] })).toHaveLength(0);
  });

  it('V9 parentQuestionId 가 UUID 가 아니면 실패', () => {
    expect(
      bulk({ items: [item({ parentQuestionId: 'not-a-uuid' })] }).length,
    ).toBeGreaterThan(0);
  });

  it.each(['good', 'soso', 'again'])('V10 practice result %s → 통과', (r) => {
    expect(
      validateSync(plainToInstance(PracticeQuestionDto, { result: r })),
    ).toHaveLength(0);
  });

  it.each(['perfect', 'GOOD', '', null, 1])(
    'V11 practice result %p → 실패',
    (r) => {
      expect(
        validateSync(plainToInstance(PracticeQuestionDto, { result: r }))
          .length,
      ).toBeGreaterThan(0);
    },
  );

  it('V12 🔴 practice 에 시각을 끼워 넣으면 400 — 클라이언트 시각이 들어올 자리가 없다', () => {
    // 전역 ValidationPipe 와 같은 옵션 (whitelist · forbidNonWhitelisted)
    const errors = validateSync(
      plainToInstance(PracticeQuestionDto, {
        result: 'good',
        lastPracticedAt: '2000-01-01T00:00:00Z',
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('lastPracticedAt');
  });

  it('V13 PATCH category 화이트리스트 밖 → 실패', () => {
    expect(
      validateSync(plainToInstance(UpdateQuestionDto, { category: 'nope' }))
        .length,
    ).toBeGreaterThan(0);
  });

  it('V14 PATCH category: null → 통과 (미분류로 되돌리기)', () => {
    expect(
      validateSync(plainToInstance(UpdateQuestionDto, { category: null })),
    ).toHaveLength(0);
  });

  it.each([true, false])('V15 PATCH mustPrepare %p → 통과', (v) => {
    expect(
      validateSync(plainToInstance(UpdateQuestionDto, { mustPrepare: v })),
    ).toHaveLength(0);
  });

  it.each(['true', 1, 'yes'])('V15b PATCH mustPrepare %p → 실패', (v) => {
    expect(
      validateSync(plainToInstance(UpdateQuestionDto, { mustPrepare: v }))
        .length,
    ).toBeGreaterThan(0);
  });

  // ── generate ──
  const gen = (body: unknown) =>
    validateSync(plainToInstance(GenerateSessionDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it.each([GENERATE_COUNT_MIN, 7, GENERATE_COUNT_MAX])(
    'V16 generate count %p → 통과',
    (c) => {
      expect(gen({ count: c })).toHaveLength(0);
    },
  );

  it.each([0, -1, GENERATE_COUNT_MAX + 1, 3.5, '5'])(
    'V16b generate count %p → 실패',
    (c) => {
      expect(gen({ count: c }).length).toBeGreaterThan(0);
    },
  );

  it('V17 generate count 생략 → 통과 (기본값은 서비스가 정한다)', () => {
    expect(gen({})).toHaveLength(0);
  });

  it('V18 generate category 화이트리스트 밖 → 실패 / 안 → 통과', () => {
    expect(gen({ category: 'etc' }).length).toBeGreaterThan(0);
    expect(gen({ category: 'failure' })).toHaveLength(0);
  });

  /**
   * 🔴 **배포 창 방어** (계획 §6.5). 옛 프론트는 `{ regenerate: boolean }` 을 **항상**
   * 보낸다. 전역 파이프가 `forbidNonWhitelisted: true` 라 이 필드를 지우면 옛 프론트의
   * 생성 요청이 통째로 400 이 된다 — 값은 무시하되 받는 자리는 남겨야 한다.
   */
  it('V19 🔴 generate regenerate 는 여전히 받는다 (옛 프론트 호환)', () => {
    expect(gen({ regenerate: true })).toHaveLength(0);
    expect(gen({ regenerate: false })).toHaveLength(0);
  });

  it('V20 generate 에 모르는 필드 → 실패', () => {
    expect(gen({ nope: 1 }).length).toBeGreaterThan(0);
  });
});
