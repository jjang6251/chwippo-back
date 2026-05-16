import { Transform } from 'class-transformer';

/**
 * 빈 문자열을 undefined로 변환 — IsOptional 통과 + dto에서 필드 자체가 제외(=DB 변경 없음).
 * 사용자가 입력 안 한 date 필드 등에 사용.
 */
export const EmptyToUndef = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  );

/**
 * 빈 문자열을 null로 변환 — IsOptional 통과 + dto에 명시적으로 null 포함(=DB가 null로 저장됨).
 * 사용자가 파일 첨부를 명시적으로 "제거"하려는 file_url 등에 사용. 폼 file_url=''로 보내면 DB도 null로 정리.
 */
export const EmptyToNull = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (value === '' ? null : value));
