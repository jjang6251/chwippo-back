// @Type(() => EducationMinorDto) 데코레이터가 Reflect metadata 를 요구.
// Nest 앱은 부트스트랩에서 로드하지만 unit 러너는 안 하므로 여기서 선로드.
import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { CreateEducationDto, UpdateEducationDto } from './myinfo-items.dto';

/**
 * POST · PATCH /myinfo/educations 의 gpa · gpa_max DTO 검증.
 *
 * 운영 500 재현 — 프론트 폼이 `{...form}` 스프레드로 gpa='' 를 그대로 보냈고
 * 이전 DTO(@IsString @MaxLength(10))가 이를 통과시켜 numeric(4,2) 컬럼에 '' 가 INSERT,
 * Postgres 가 `invalid input syntax for type numeric: ""` 로 거부했다.
 * TrimToNull 이 ''·공백만 을 null 로 바꾸고, Matches 가 numeric(4,2) 범위 밖 값을 400 으로 거른다.
 */
type EducationDtoClass = ClassConstructor<
  CreateEducationDto | UpdateEducationDto
>;

const DTO_CLASSES: ReadonlyArray<[string, EducationDtoClass]> = [
  ['CreateEducationDto', CreateEducationDto],
  ['UpdateEducationDto', UpdateEducationDto],
];

// 필수 필드는 항상 유효값으로 채워 gpa 외 에러 노이즈를 없앤다.
const BASE = { school_name: '치뽀대학교' };

function build(
  Dto: EducationDtoClass,
  input: Record<string, unknown>,
): {
  dto: CreateEducationDto | UpdateEducationDto;
  errors: ValidationError[];
} {
  const dto = plainToInstance(Dto, { ...BASE, ...input });
  return { dto, errors: validateSync(dto) };
}

describe.each(DTO_CLASSES)('%s — gpa · gpa_max', (_name, Dto) => {
  describe('빈 값 → null (numeric INSERT 500 회귀 방어)', () => {
    it("gpa='' → 통과 + null", () => {
      const { dto, errors } = build(Dto, { gpa: '' });
      expect(errors).toHaveLength(0);
      expect(dto.gpa).toBeNull();
    });

    it('gpa=공백만 → 통과 + null', () => {
      const { dto, errors } = build(Dto, { gpa: '   ' });
      expect(errors).toHaveLength(0);
      expect(dto.gpa).toBeNull();
    });

    it("gpa_max='' → 통과 + null", () => {
      const { dto, errors } = build(Dto, { gpa_max: '' });
      expect(errors).toHaveLength(0);
      expect(dto.gpa_max).toBeNull();
    });

    it("gpa='' + gpa_max='' (실제 500 payload) → 통과 + 둘 다 null", () => {
      const { dto, errors } = build(Dto, { gpa: '', gpa_max: '' });
      expect(errors).toHaveLength(0);
      expect(dto.gpa).toBeNull();
      expect(dto.gpa_max).toBeNull();
    });
  });

  describe('앞뒤 공백 trim', () => {
    it("gpa=' 4.5 ' → 통과 + '4.5'", () => {
      const { dto, errors } = build(Dto, { gpa: ' 4.5 ' });
      expect(errors).toHaveLength(0);
      expect(dto.gpa).toBe('4.5');
    });

    it("gpa_max=' 4.5 ' → 통과 + '4.5'", () => {
      const { dto, errors } = build(Dto, { gpa_max: ' 4.5 ' });
      expect(errors).toHaveLength(0);
      expect(dto.gpa_max).toBe('4.5');
    });
  });

  describe('유효값 → 통과 + 값 유지', () => {
    // numeric(4,2) 경계 — 최대 99.99, 소수점 이하 2자리
    it.each(['4.5', '99.99', '0', '3', '4.50'])('gpa=%s', (value) => {
      const { dto, errors } = build(Dto, { gpa: value });
      expect(errors).toHaveLength(0);
      expect(dto.gpa).toBe(value);
    });

    it.each(['4.5', '99.99'])('gpa_max=%s', (value) => {
      const { dto, errors } = build(Dto, { gpa_max: value });
      expect(errors).toHaveLength(0);
      expect(dto.gpa_max).toBe(value);
    });
  });

  describe('무효값 → matches 에러 (→ 400)', () => {
    // 'abc' 비숫자 · '100' 정수부 초과 · '4.555' 소수부 초과 · '.5'·'4.' 불완전 · '-1' 음수
    it.each(['abc', '100', '4.555', '.5', '4.', '-1'])('gpa=%s', (value) => {
      const { errors } = build(Dto, { gpa: value });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('gpa');
      expect(errors[0].constraints).toHaveProperty('matches');
    });

    it.each(['abc', '100'])('gpa_max=%s', (value) => {
      const { errors } = build(Dto, { gpa_max: value });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('gpa_max');
      expect(errors[0].constraints).toHaveProperty('matches');
    });
  });

  it('gpa · gpa_max 생략 → 통과 + undefined (필드 자체가 없음)', () => {
    const { dto, errors } = build(Dto, {});
    expect(errors).toHaveLength(0);
    expect(dto.gpa).toBeUndefined();
    expect(dto.gpa_max).toBeUndefined();
  });

  // 프론트는 안 보내지만 API 는 공개 경계 — 직접 호출 클라이언트의 타입 변형 방어
  it('gpa=null (명시적 null) → 통과 + null 유지', () => {
    const { dto, errors } = build(Dto, { gpa: null });
    expect(errors).toHaveLength(0);
    expect(dto.gpa).toBeNull();
  });

  it('gpa=4.5 (JSON number, 문자열 아님) → matches 에러', () => {
    const { errors } = build(Dto, { gpa: 4.5 });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('gpa');
    expect(errors[0].constraints).toHaveProperty('matches');
  });
});
