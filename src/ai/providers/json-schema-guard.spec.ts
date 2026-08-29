import { findSchemaViolation } from './json-schema-guard';

/**
 * D0 (2026-08-01 자소서 점검 크래시) — structured output 필수 필드 검증.
 *
 * **시나리오를 먼저 나열하고 코드를 짰다** (통과시키려는 테스트가 아니라 버그를 잡으려는 테스트):
 * - 정상 / required 누락(최상위·중첩) / 타입 불일치 / 빈 배열·빈 문자열 / null·undefined
 * - **검사하지 않기로 한 것**(minItems·maxItems·enum)이 정말 통과하는지 — 의도적 범위 제한이
 *   나중에 조용히 넓어지면 기존에 통과하던 응답이 새로 실패하므로 이것도 회귀로 고정한다.
 */
describe('findSchemaViolation', () => {
  // 실제 coverletter_feedback 스키마 형태 (이번 크래시가 난 그 스키마)
  const FEEDBACK_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['strengths', 'issues', 'suggestions', 'summary'],
    properties: {
      strengths: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 3,
      },
      issues: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          required: ['kind', 'quote', 'advice'],
          properties: {
            kind: { type: 'string', enum: ['ai_tone', 'structure', 'vague'] },
            quote: { type: 'string' },
            advice: { type: 'string' },
          },
        },
      },
      suggestions: {
        type: 'array',
        maxItems: 2,
        items: {
          type: 'object',
          required: ['target', 'improved'],
          properties: {
            target: { type: 'string' },
            improved: { type: 'string' },
          },
        },
      },
      summary: { type: 'string' },
    },
  };

  const valid = {
    strengths: ['구체적인 수치가 있어요'],
    issues: [
      { kind: 'vague', quote: '열심히 했습니다', advice: '수치를 넣어보세요' },
    ],
    suggestions: [{ target: '열심히', improved: '3주간' }],
    summary: '전반적으로 좋습니다',
  };

  describe('정상', () => {
    it('완전한 응답은 통과한다', () => {
      expect(findSchemaViolation(valid, FEEDBACK_SCHEMA)).toBeNull();
    });

    it('빈 배열은 정당한 값이므로 통과한다 (지적할 것 없음)', () => {
      expect(
        findSchemaViolation(
          { ...valid, issues: [], suggestions: [] },
          FEEDBACK_SCHEMA,
        ),
      ).toBeNull();
    });

    it('빈 문자열도 형식상 통과한다 (내용 판정은 validateResult 책임)', () => {
      expect(
        findSchemaViolation({ ...valid, summary: '' }, FEEDBACK_SCHEMA),
      ).toBeNull();
    });
  });

  describe('required 누락 — 이번 실사고의 직접 원인', () => {
    it('🔴 suggestions 가 통째로 빠지면 위반 (실제로 크래시를 일으킨 케이스)', () => {
      const truncated: Record<string, unknown> = { ...valid };
      delete truncated.suggestions;
      const violation = findSchemaViolation(truncated, FEEDBACK_SCHEMA);
      expect(violation).toContain('suggestions');
      expect(violation).toContain('required field missing');
    });

    it.each(['strengths', 'issues', 'summary'])(
      '%s 가 빠져도 위반으로 잡는다',
      (field) => {
        const partial: Record<string, unknown> = { ...valid };
        delete partial[field];
        expect(findSchemaViolation(partial, FEEDBACK_SCHEMA)).toContain(field);
      },
    );

    it('중첩 객체의 required 누락도 잡는다 (잘리면 마지막 원소가 불완전)', () => {
      const cut = {
        ...valid,
        issues: [{ kind: 'vague', quote: '열심히 했습니다' }], // advice 없음
      };
      const violation = findSchemaViolation(cut, FEEDBACK_SCHEMA);
      expect(violation).toContain('issues[0].advice');
    });
  });

  describe('타입 불일치', () => {
    it('배열이어야 할 필드가 문자열이면 위반', () => {
      expect(
        findSchemaViolation({ ...valid, strengths: '구체적' }, FEEDBACK_SCHEMA),
      ).toContain('expected array, got string');
    });

    it('문자열이어야 할 필드가 null 이면 위반', () => {
      expect(
        findSchemaViolation({ ...valid, summary: null }, FEEDBACK_SCHEMA),
      ).toContain('expected string, got null');
    });

    it('배열 원소가 객체가 아니면 위반', () => {
      expect(
        findSchemaViolation({ ...valid, issues: ['문자열'] }, FEEDBACK_SCHEMA),
      ).toContain('issues[0]');
    });

    it('최상위가 객체가 아니면 위반', () => {
      expect(findSchemaViolation('문자열', FEEDBACK_SCHEMA)).toContain(
        'expected object',
      );
      expect(findSchemaViolation(null, FEEDBACK_SCHEMA)).toContain(
        'expected object',
      );
      expect(findSchemaViolation([], FEEDBACK_SCHEMA)).toContain(
        'expected object',
      );
    });
  });

  describe('의도적으로 검사하지 않는 것 — 넓히면 기존 응답이 새로 실패한다', () => {
    it('minItems 위반은 통과시킨다 (strengths 는 minItems 1 인데 빈 배열)', () => {
      expect(
        findSchemaViolation({ ...valid, strengths: [] }, FEEDBACK_SCHEMA),
      ).toBeNull();
    });

    it('maxItems 위반은 통과시킨다 (suggestions maxItems 2 인데 3개)', () => {
      const over = {
        ...valid,
        suggestions: [
          { target: 'a', improved: 'A' },
          { target: 'b', improved: 'B' },
          { target: 'c', improved: 'C' },
        ],
      };
      expect(findSchemaViolation(over, FEEDBACK_SCHEMA)).toBeNull();
    });

    it('enum 밖 값은 통과시킨다 (hallucination 필터는 caller 책임)', () => {
      const bogus = {
        ...valid,
        issues: [{ kind: '없는_종류', quote: 'q', advice: 'a' }],
      };
      expect(findSchemaViolation(bogus, FEEDBACK_SCHEMA)).toBeNull();
    });

    it('스키마에 없는 추가 필드는 통과시킨다', () => {
      expect(
        findSchemaViolation({ ...valid, unexpected: 1 }, FEEDBACK_SCHEMA),
      ).toBeNull();
    });
  });

  describe('nullable — `type` 이 배열인 노드 (2026-08-30 공고 카드 실사고)', () => {
    // 공고 카드의 날짜 객체 모양 그대로 — `['object','null']` + properties
    const DATE: Record<string, unknown> = {
      type: ['object', 'null'],
      required: ['month', 'day'],
      properties: {
        month: { type: ['integer', 'null'] },
        day: { type: ['integer', 'null'] },
      },
    };
    const CARD: Record<string, unknown> = {
      type: 'object',
      required: ['deadline', 'steps'],
      properties: {
        deadline: DATE,
        steps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'date'],
            properties: { name: { type: 'string' }, date: DATE },
          },
        },
      },
    };

    it('🔴 nullable 객체가 null 이면 통과한다 — 이걸 위반으로 봐서 날짜 없는 단계가 있는 공고가 전부 실패했다', () => {
      expect(
        findSchemaViolation(
          { deadline: null, steps: [{ name: '면접', date: null }] },
          CARD,
        ),
      ).toBeNull();
    });

    it('nullable 객체가 객체로 오면 안쪽 required 를 그대로 검사한다', () => {
      expect(
        findSchemaViolation(
          { deadline: { month: 9 }, steps: [] }, // day 누락
          CARD,
        ),
      ).toContain('$.deadline.day');
    });

    it('nullable 객체에 문자열이 오면 위반이고, 메시지에 허용 타입이 전부 보인다', () => {
      expect(
        findSchemaViolation({ deadline: '9/15', steps: [] }, CARD),
      ).toContain('expected object|null, got string');
    });

    it("`['integer','null']` 같은 nullable 원시값도 null 을 통과시킨다", () => {
      expect(
        findSchemaViolation(
          { deadline: { month: null, day: null }, steps: [] },
          CARD,
        ),
      ).toBeNull();
    });

    it('배열 노드가 nullable 이어도 원소 검사는 그대로 돈다', () => {
      const schema: Record<string, unknown> = {
        type: ['array', 'null'],
        items: { type: 'string' },
      };
      expect(findSchemaViolation(null, schema)).toBeNull();
      expect(findSchemaViolation(['a', 1], schema)).toContain('$[1]');
    });
  });

  describe('경계', () => {
    it('optional 필드는 없어도 통과한다', () => {
      const schema: Record<string, unknown> = {
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' }, b: { type: 'string' } },
      };
      expect(findSchemaViolation({ a: 'x' }, schema)).toBeNull();
    });

    it('required 가 없는 스키마는 빈 객체도 통과한다', () => {
      expect(
        findSchemaViolation({}, { type: 'object', properties: {} }),
      ).toBeNull();
    });

    it('첫 위반에서 멈춘다 (전수 수집이 아니라 재시도 트리거가 목적)', () => {
      const broken = { strengths: 1, issues: 2, suggestions: 3, summary: 4 };
      const violation = findSchemaViolation(broken, FEEDBACK_SCHEMA);
      expect(violation).toContain('strengths');
      expect(violation).not.toContain('issues');
    });
  });
});
