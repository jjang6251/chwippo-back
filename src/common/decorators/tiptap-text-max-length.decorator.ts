import { registerDecorator, type ValidationOptions } from 'class-validator';
import { tiptapTextLength } from '../tiptap-text-length';

/**
 * 노트 본문 상한을 **본문 글자수**로 판정한다 (`@MaxLength` = JSON 문자열 길이와 다른 축).
 *
 * 화면 카운터가 세는 값과 같은 단위라, 「56,281 / 100,000」 을 보면서 저장이 400 으로
 * 막히는 일이 없다 (2026-09-02 실사고 — `tiptap-text-length.ts` 주석 참조).
 *
 * 타입 판정은 하지 않는다 — 문자열이 아니면 통과시키고 `@IsString` 에 맡긴다
 * (에러 하나에 문구 둘이 붙는 걸 막는다).
 */
export function TiptapTextMaxLength(
  limit: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'tiptapTextMaxLength',
      target: target.constructor,
      propertyName: propertyName as string,
      constraints: [limit],
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return true;
          return tiptapTextLength(value) <= limit;
        },
        defaultMessage(): string {
          return `노트는 ${limit.toLocaleString('en-US')}자까지 저장할 수 있어요.`;
        },
      },
    });
  };
}
