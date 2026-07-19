// @Type(() => EventTogglesDto) 데코레이터가 Reflect metadata 를 요구.
// Nest 앱은 부트스트랩에서 로드하지만 unit 러너는 안 하므로 여기서 선로드.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidatorOptions } from 'class-validator';
import { UpdateAlarmConfigDto } from './update-alarm-config.dto';

/**
 * PATCH /me/alarm-config DTO 검증 (⑥ briefingHour · eventToggles 확장).
 * 잘못된 enum/hour·비-boolean → validation error (글로벌 ValidationPipe → 400).
 */
function validate(
  input: Record<string, unknown>,
  options: ValidatorOptions = {},
) {
  return validateSync(plainToInstance(UpdateAlarmConfigDto, input), options);
}

// 글로벌 ValidationPipe 와 동일 옵션 (whitelist·forbidNonWhitelisted)
const PIPE_OPTS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

describe('UpdateAlarmConfigDto', () => {
  it('빈 body → 통과 (아무것도 update 안 함)', () => {
    expect(validate({})).toHaveLength(0);
  });

  describe('briefingHour', () => {
    it.each([7, 8, 9, 10])('briefingHour=%s → 통과', (h) => {
      expect(validate({ briefingHour: h })).toHaveLength(0);
    });

    it.each([6, 11, 0, 24])('briefingHour=%s → error (IsIn)', (h) => {
      const errors = validate({ briefingHour: h });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('briefingHour');
      expect(errors[0].constraints).toHaveProperty('isIn');
    });
  });

  describe('imminentEnabled (채널)', () => {
    it.each([true, false])('imminentEnabled=%s → 통과', (v) => {
      expect(validate({ imminentEnabled: v })).toHaveLength(0);
    });

    it('비-boolean → error (→ 400)', () => {
      const errors = validate({ imminentEnabled: 'yes' });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('imminentEnabled');
      expect(errors[0].constraints).toHaveProperty('isBoolean');
    });
  });

  describe('deadlinePoints', () => {
    it.each(['d1', 'd3', 'd7'])('%s → 통과', (v) => {
      expect(validate({ deadlinePoints: v })).toHaveLength(0);
    });
    it('d5 → error', () => {
      const errors = validate({ deadlinePoints: 'd5' });
      expect(errors[0].property).toBe('deadlinePoints');
    });
  });

  describe('eventToggles (부분 update)', () => {
    it('일부 유형만 → 통과', () => {
      expect(validate({ eventToggles: { interview: false } })).toHaveLength(0);
    });

    it('전체 유형 → 통과', () => {
      expect(
        validate({
          eventToggles: {
            deadline: true,
            interview: false,
            exam: true,
            resultDate: false,
            todo: true,
          },
        }),
      ).toHaveLength(0);
    });

    it('비-boolean 값 → nested error', () => {
      const errors = validate({ eventToggles: { deadline: 'yes' } });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('eventToggles');
      expect(errors[0].children?.[0]?.property).toBe('deadline');
    });

    it('알 수 없는 유형 키 → forbidNonWhitelisted error', () => {
      const errors = validate({ eventToggles: { nope: true } }, PIPE_OPTS);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('eventToggles');
    });
  });

  it('알 수 없는 top-level 키 → forbidNonWhitelisted error', () => {
    const errors = validate({ foo: 1 }, PIPE_OPTS);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('foo');
  });

  it('여러 필드 동시 (부분 update 멱등) → 통과', () => {
    expect(
      validate({
        master: true,
        briefingHour: 10,
        deadlinePoints: 'd7',
        eventToggles: { todo: false },
        deadlineUrgentEnabled: false,
      }),
    ).toHaveLength(0);
  });
});
