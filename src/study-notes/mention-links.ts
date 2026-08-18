import { EntityManager, In } from 'typeorm';
import { StudyNote } from './study-note.entity';
import {
  StudyNoteLink,
  type StudyNoteLinkFromType,
} from './study-note-link.entity';

/** 프론트 Tiptap 확장이 쓰는 노드 이름. 이 문자열이 바뀌면 백링크가 통째로 끊긴다 */
export const MENTION_NODE_TYPE = 'studyNoteMention';

/** 파싱한 JSON 을 순회할 때의 안전 상한 — 악의적 초深 중첩이 스택을 먹지 않게 반복문으로 돈다 */
const MAX_VISITED_NODES = 200_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * tiptap doc JSON 문자열에서 **멘션 대상 노트 id** 를 뽑는다 (중복 제거·입력 순서 유지).
 *
 * 이 함수는 **절대 throw 하지 않는다.** 본문은 사용자가 붙여넣은 것까지 들어오는
 * 자유 입력이라, 깨진 JSON 하나로 노트 저장 자체가 실패하면 안 된다 —
 * 그런 본문은 "멘션 0개" 로 취급하고 저장은 통과시킨다.
 *
 * uuid 형식이 아닌 `noteId` 는 버린다. 걸러 두지 않으면 그대로 파라미터로 들어가
 * Postgres 가 `invalid input syntax for type uuid` 로 500 을 만든다 (사용자 입력이 곧 쿼리 인자다).
 */
export function extractMentionNoteIds(content: string | null): string[] {
  if (!content) return [];

  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return [];
  }

  const found = new Set<string>();
  const stack: unknown[] = [root];
  let visited = 0;

  // LIFO 라 자식을 **역순으로** 넣어야 꺼낼 때 문서 순서가 된다.
  // (순서를 맞춰 두면 링크 INSERT 도, 이 함수를 보는 테스트도 결정적이 된다.)
  const pushReversed = (values: unknown[]) => {
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i];
      if (v !== null && typeof v === 'object') stack.push(v);
    }
  };

  while (stack.length > 0 && visited < MAX_VISITED_NODES) {
    const node = stack.pop();
    visited += 1;
    if (node === null || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      pushReversed(node);
      continue;
    }

    const obj = node as Record<string, unknown>;
    if (obj.type === MENTION_NODE_TYPE) {
      const attrs = obj.attrs;
      if (attrs !== null && typeof attrs === 'object') {
        const noteId = (attrs as Record<string, unknown>).noteId;
        if (typeof noteId === 'string' && UUID_RE.test(noteId)) {
          found.add(noteId);
        }
      }
    }

    pushReversed(Object.values(obj));
  }

  return [...found];
}

export interface MentionLinkSource {
  /** 멘션을 담고 있는 문서의 id (공부 노트 id 또는 준비 노트 시트 id) */
  fromId: string;
  fromType: StudyNoteLinkFromType;
  /** 소유자 — 남의 노트를 가리키는 링크를 심지 못하게 하는 필터 기준 */
  userId: string;
}

/**
 * 본문의 멘션으로 `study_note_links` 를 **from 단위 통째 재계산** 한다.
 *
 * 🔴 반드시 **문서 저장과 같은 트랜잭션의 `EntityManager`** 를 받는다.
 * 저장은 됐는데 링크만 실패하면 백링크가 조용히 어긋나고, 사용자는 알 방법이 없다.
 * 그래서 이 함수는 실패를 삼키지 않는다 — 던지면 문서 저장까지 같이 롤백된다.
 *
 * 🔴 **소유권 필터** — 본문의 `noteId` 는 클라이언트가 보낸 값이다. 그대로 넣으면
 * 남의 노트 id 를 적어 그 사람 백링크 패널에 내 문서 라벨을 띄울 수 있다 (쓰기 IDOR).
 * 그래서 "내 노트인 id" 만 남기고, 나머지는 조용히 버린다 (400 이 아니다 —
 * 이미 삭제된 노트를 가리키는 멘션도 같은 경로로 들어오고, 그건 정상 상황인 「끊긴 링크」다).
 */
export async function syncStudyNoteLinks(
  em: EntityManager,
  source: MentionLinkSource,
  content: string | null,
): Promise<void> {
  const linkRepo = em.getRepository(StudyNoteLink);

  // 사라진 멘션까지 반영하려면 지우고 다시 넣는 수밖에 없다 (증분은 삭제를 못 본다)
  await linkRepo.delete({ fromId: source.fromId, fromType: source.fromType });

  const mentioned = extractMentionNoteIds(content);
  if (mentioned.length === 0) return;

  const owned = await em.getRepository(StudyNote).find({
    where: { id: In(mentioned), userId: source.userId },
    select: { id: true },
  });
  if (owned.length === 0) return;

  await linkRepo.insert(
    owned.map((note) => ({
      fromId: source.fromId,
      fromType: source.fromType,
      toNoteId: note.id,
    })),
  );
}
