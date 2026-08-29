/**
 * D0 수리 (2026-08-01 자소서 점검 크래시) — structured output 응답의 **필수 필드 검증**.
 *
 * **왜 필요한가**
 * provider 는 지금까지 `tool_use.input` / `JSON.parse` 결과를 그대로 `as T` 캐스팅해 반환했다.
 * 출력 토큰 한도에 걸려 응답이 잘리면 **필수 필드가 빠진 객체**가 그대로 통과해 DB 에 저장되고,
 * 프론트가 `.length` 를 읽는 순간 크래시한다. 실제로 `coverletter_feedback` 의 `suggestions`
 * 누락으로 해당 자소서 페이지가 진입할 때마다 죽었다.
 *
 * **어디서 막는가 — provider 레벨인 이유**
 * 여기서 throw 하면 `LlmService` 의 기존 재시도(`attempts < 2`)를 그대로 타고, 2회 모두 실패하면
 * `status='error'` 가 된다. **코인 차감은 `status='ok'` 경로에서만 일어나므로 자동으로 차감되지 않는다**
 * — 별도 환불 경로를 만들 필요가 없다. 그리고 caller 별로 검증을 중복 구현하지 않아도
 * `coverletter_chat`·`interview_prep_session` 등 **모든 structured output 이 함께 보호**된다.
 *
 * **검사 범위 — 의도적으로 좁다**
 * `required` 필드 존재 + `type` 일치만 본다. `minItems`/`maxItems`/`enum` 은 **일부러 검사하지 않는다** —
 * 잘림 탐지와 무관하고, 모델이 개수를 살짝 어겼을 때 기존에 통과하던 응답을 새로 실패시켜
 * 실패율만 올리기 때문이다. 이건 완전한 JSON Schema validator 가 아니라
 * **잘림·누락 탐지에 필요한 최소 검사**다.
 */

interface JsonSchemaNode {
  /** JSON Schema 는 `type: ['object', 'null']` 같은 **배열**도 허용한다 (nullable 표현) */
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  /** 검사하지 않는 키(enum·minItems·additionalProperties 등)를 그대로 통과시키기 위한 index signature */
  [key: string]: unknown;
}

/** 에러 메시지용 — 실제 값의 종류를 사람이 읽을 수 있게 */
function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** `type` 을 항상 배열로 — 문자열 하나든 `['object','null']` 이든 같은 코드로 본다 */
function typesOf(node: JsonSchemaNode): string[] {
  if (Array.isArray(node.type)) return node.type;
  return node.type ? [node.type] : [];
}

function typeMatches(
  value: unknown,
  type: string | string[] | undefined,
): boolean {
  if (!type) return true; // type 미지정 노드는 통과
  if (Array.isArray(type)) return type.some((t) => typeMatches(value, t));
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true; // 모르는 type 은 통과 (스키마 확장 대비)
  }
}

/**
 * schema 위반을 찾으면 사람이 읽을 수 있는 사유 문자열을, 없으면 `null` 을 반환한다.
 *
 * 첫 위반에서 즉시 반환한다 — 전수 수집이 목적이 아니라 **재시도 트리거**가 목적이므로
 * 하나만 찾으면 충분하다.
 */
export function findSchemaViolation(
  json: unknown,
  schema: Record<string, unknown>,
  path = '$',
): string | null {
  const node = schema as JsonSchemaNode;
  const types = typesOf(node);

  if (!typeMatches(json, node.type)) {
    return `${path}: expected ${types.join('|')}, got ${describeKind(json)}`;
  }

  /*
   * 🔴 nullable 객체 (`type: ['object','null']` + properties) 가 null 로 오면 **여기서 끝**이다.
   * 2026-08-30 실사고: 공고 카드의 날짜 객체가 이 모양인데, 아래 object 분기가 `properties` 만 보고
   * 들어가 `expected object, got null` 을 던졌다 — 날짜 없는 단계가 하나라도 있으면 실서비스 호출이
   * 전부 실패했다. E2E 는 mock provider 가 이 가드를 안 거쳐 원리적으로 못 잡았다.
   */
  if (json === null && types.includes('null')) return null;

  // object — required 존재 확인 후 각 property 재귀
  if (types.includes('object') || node.properties) {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      return `${path}: expected object, got ${describeKind(json)}`;
    }
    const obj = json as Record<string, unknown>;

    for (const key of node.required ?? []) {
      if (obj[key] === undefined) {
        return `${path}.${key}: required field missing`;
      }
    }

    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (obj[key] === undefined) continue; // required 가 아니면 없어도 됨
      const violation = findSchemaViolation(obj[key], child, `${path}.${key}`);
      if (violation) return violation;
    }
  }

  // array — 원소마다 재귀 (잘리면 마지막 원소가 불완전한 경우가 많다)
  if (types.includes('array') && node.items && Array.isArray(json)) {
    for (let i = 0; i < json.length; i++) {
      const violation = findSchemaViolation(
        json[i],
        node.items,
        `${path}[${i}]`,
      );
      if (violation) return violation;
    }
  }

  return null;
}
