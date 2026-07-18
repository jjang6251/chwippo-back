import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListNotificationsQueryDto } from './list-notifications-query.dto';

/**
 * U23 — GET /notifications type 필터 DTO 검증.
 * 잘못된 enum → validation error(글로벌 ValidationPipe 가 400 으로 변환).
 */
function validate(input: Record<string, unknown>) {
  return validateSync(plainToInstance(ListNotificationsQueryDto, input));
}

describe('ListNotificationsQueryDto', () => {
  it('빈 query → 통과 (전체 · 첫 페이지)', () => {
    expect(validate({})).toHaveLength(0);
  });

  it.each(['briefing', 'deadline_urgent', 'admin'])(
    'type=%s → 통과',
    (type) => {
      expect(validate({ type })).toHaveLength(0);
    },
  );

  it('cursor + 유효 type → 통과', () => {
    expect(
      validate({ cursor: '2026-07-01T00:00:00.000Z', type: 'briefing' }),
    ).toHaveLength(0);
  });

  it('잘못된 type → validation error (→ 400)', () => {
    const errors = validate({ type: 'nope' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('type');
    expect(errors[0].constraints).toHaveProperty('isIn');
  });

  it('빈 문자열 type → validation error (→ 400)', () => {
    const errors = validate({ type: '' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('type');
  });
});
