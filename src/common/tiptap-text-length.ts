/**
 * tiptap doc JSON 문자열의 **본문 글자수** — 프론트 카운터와 같은 단위.
 *
 * 🔴 **왜 필요한가 (2026-09-02 실사고).** 노트 본문은 `JSON.stringify(tiptap doc)` 로
 * 저장되는데, 화면 카운터(tiptap `CharacterCount`)가 세는 건 **본문 텍스트 글자수**다.
 * 두 값에 같은 100,000 을 적용하면 단위가 어긋난다 — 헤딩·표·인용이 많은 문서는
 * 구조 JSON 이 텍스트의 두 배를 넘어, 화면에 「56,281 / 100,000」 이 떠 있는데 서버는
 * 400 을 돌려준다. 사용자는 여유가 있다고 보면서 저장을 못 한다.
 *
 * 🔴 **절대 throw 하지 않는다.** 본문은 사용자가 붙여넣은 것까지 들어오는 자유 입력이고,
 * 이 함수는 검증 경로 한복판에서 돈다 — 깨진 JSON 하나로 500 이 되면 안 된다.
 * tiptap doc 으로 읽히지 않는 입력(legacy 평문 노트 포함)은 **원문 문자열 길이**로
 * 판정한다 = 이 결함 이전과 같은 기준이라 회귀가 없다.
 */

/** 파싱한 JSON 을 순회할 때의 안전 상한 — 악의적 초深 중첩이 스택을 먹지 않게 반복문으로 돈다 */
const MAX_VISITED_NODES = 200_000;

function isTiptapDoc(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (value as Record<string, unknown>).type === 'doc';
}

/**
 * 본문 글자수. tiptap doc 이면 모든 text 노드 길이의 합, 아니면 원문 길이(방어 폴백).
 *
 * 이미지처럼 글자가 0자인 노드는 세지 않는다 — 프론트 `CharacterCount`(textSize) 는
 * leaf 하나를 1자로 치므로 **여기가 아주 조금 더 관대하다**. 상한 판정에서 관대한 쪽으로
 * 틀리는 건 안전하다 (화면 카운터가 막은 것을 서버가 뒤늦게 거절하는 일이 없다).
 */
export function tiptapTextLength(content: string): number {
  if (!content) return 0;

  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return content.length;
  }
  if (!isTiptapDoc(root)) return content.length;

  let total = 0;
  let visited = 0;
  const stack: unknown[] = [root];

  while (stack.length > 0 && visited < MAX_VISITED_NODES) {
    const node = stack.pop();
    visited += 1;
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      continue;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.text === 'string') total += obj.text.length;

    // tiptap 노드의 자식은 `content` 배열뿐이다 — attrs·marks 안까지 뒤지면
    // 사용자 텍스트가 아닌 값(이미지 alt 등)까지 글자수로 세게 된다.
    const children = obj.content;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
  }

  // 상한까지 돌고도 노드가 남았다 = 정상 노트가 아니다. 원문 길이로 넘겨 방어선에 맡긴다.
  return stack.length > 0 ? content.length : total;
}
