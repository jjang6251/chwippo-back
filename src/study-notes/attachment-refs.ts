/** 프론트 Tiptap 이미지 노드 이름. 이 문자열이 바뀌면 저장할 때마다 이미지가 지워진다 */
export const IMAGE_NODE_TYPE = 'image';

/** 본문 순회 안전 상한 — 악의적 초深 중첩이 스택을 먹지 않게 반복문으로 돈다 */
const MAX_VISITED_NODES = 200_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * tiptap doc JSON 문자열에서 **본문이 아직 가리키는 첨부 id** 를 뽑는다.
 *
 * ## 🔴 `null` 과 `[]` 는 뜻이 다르다 — 여기가 이 함수의 존재 이유다
 *
 * | 반환 | 뜻 | 호출자(reconcile) 행동 |
 * |---|---|---|
 * | `[]` | **읽었고, 가리키는 게 없다** (빈 노트·이미지를 다 지운 노트) | 그 노트의 첨부를 **전부 정리** |
 * | `[…]` | 읽었고, 이 id 들을 가리킨다 | 나머지를 정리 |
 * | `null` | **못 읽었다** (JSON 파싱 실패) | **아무것도 안 지운다** |
 *
 * `extractMentionNoteIds` 는 깨진 본문을 "멘션 0개" 로 뭉개도 안전하다 — 링크가 잠깐
 * 비는 것뿐이고 다음 저장에 복구된다. 여기서 같은 짓을 하면 **사용자 이미지를 지운다.**
 * 복구가 없는 쪽이라 "못 읽음" 을 따로 돌려주고, 호출자가 보수적으로 멈춘다.
 *
 * uuid 형식이 아닌 `attachmentId` 는 버린다 — 걸러 두지 않으면 그대로 쿼리 인자로 들어가
 * Postgres 가 `invalid input syntax for type uuid` 로 500 을 만든다 (본문은 사용자 입력이다).
 */
export function extractAttachmentIds(content: string | null): string[] | null {
  // 빈 노트는 **정상적으로 읽은** 상태다 — 가리키는 첨부가 0개인 것뿐
  if (!content) return [];

  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return null;
  }

  const found = new Set<string>();
  const stack: unknown[] = [root];
  let visited = 0;

  const pushChildren = (values: unknown[]) => {
    for (const v of values) {
      if (v !== null && typeof v === 'object') stack.push(v);
    }
  };

  while (stack.length > 0 && visited < MAX_VISITED_NODES) {
    const node = stack.pop();
    visited += 1;
    if (node === null || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      pushChildren(node);
      continue;
    }

    const obj = node as Record<string, unknown>;
    if (obj.type === IMAGE_NODE_TYPE) {
      const attrs = obj.attrs;
      if (attrs !== null && typeof attrs === 'object') {
        const attachmentId = (attrs as Record<string, unknown>).attachmentId;
        if (typeof attachmentId === 'string' && UUID_RE.test(attachmentId)) {
          found.add(attachmentId);
        }
      }
    }

    pushChildren(Object.values(obj));
  }

  return [...found];
}
