import { extractAttachmentIds, IMAGE_NODE_TYPE } from './attachment-refs';

/**
 * **첨부 참조 추출** spec.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 아래 시나리오를 **먼저 나열하고** 코드를 확인했다. 이 함수가 틀리면 사용자 이미지가
 * 지워지므로, 노리는 건 "지우면 안 되는 걸 지우게 만드는 입력" 이다.
 *
 *  R1  🔴 `null` 과 `[]` 를 구분한다 — 못 읽음 vs 참조 0개
 *  R2  이미지 1장 → id 1개
 *  R3  여러 장 → 문서 순서·중복 제거
 *  R4  image 노드 없는 본문 → `[]` (**정리 대상**)
 *  R5  content null → `[]` (빈 노트도 정상적으로 읽은 상태)
 *  R6  content 빈 문자열 → `[]`
 *  R7  🔴 깨진 JSON → `null` (호출자가 아무것도 안 지운다)
 *  R8  JSON 이지만 doc 이 아닌 값(숫자·문자열·배열) → 파싱은 됐으므로 `[]`
 *  R9  attachmentId 없는 image 노드(외부 URL 붙여넣기) → 무시
 *  R10 🔴 uuid 아닌 attachmentId → 버린다 (그대로 쿼리 인자가 되면 500)
 *  R11 중첩(표·토글·리스트 안) 이미지도 수집
 *  R12 🔴 type 이 image 가 아닌 노드의 attachmentId 는 안 센다 (엉뚱한 보존)
 *  R13 attrs 가 null·문자열 → 무해
 *  R14 대문자 uuid 도 허용 (형식만 본다)
 * ────────────────────────────────────────────────────────────────────────
 */
describe('extractAttachmentIds', () => {
  const A1 = '11111111-1111-4111-8111-111111111111';
  const A2 = '22222222-2222-4222-8222-222222222222';

  const imageNode = (attrs: unknown) => ({ type: IMAGE_NODE_TYPE, attrs });

  const doc = (...content: unknown[]) =>
    JSON.stringify({ type: 'doc', content });

  it('R1: 못 읽음(null) 과 참조 0개([]) 는 다른 값이다', () => {
    expect(extractAttachmentIds('{보나마나 깨진 값')).toBeNull();
    expect(extractAttachmentIds(doc())).toEqual([]);
  });

  it('R2: 이미지 1장 → attachmentId 1개', () => {
    expect(
      extractAttachmentIds(
        doc(imageNode({ src: 'https://cdn/x.jpg', attachmentId: A1 })),
      ),
    ).toEqual([A1]);
  });

  it('R3: 여러 장 + 같은 첨부 2회 참조 → 중복 제거', () => {
    expect(
      extractAttachmentIds(
        doc(
          imageNode({ attachmentId: A1 }),
          imageNode({ attachmentId: A2 }),
          imageNode({ attachmentId: A1 }),
        ),
      ),
    ).toEqual([A1, A2]);
  });

  it('R4: 텍스트만 있는 본문 → [] (첨부는 전부 미참조 = 정리 대상)', () => {
    expect(
      extractAttachmentIds(
        doc({
          type: 'paragraph',
          content: [{ type: 'text', text: '이미지를 다 지웠다' }],
        }),
      ),
    ).toEqual([]);
  });

  it('R5: content null → [] (빈 노트는 정상적으로 읽은 상태)', () => {
    expect(extractAttachmentIds(null)).toEqual([]);
  });

  it('R6: content 빈 문자열 → []', () => {
    expect(extractAttachmentIds('')).toEqual([]);
  });

  it.each([
    ['{"type":"doc"'],
    ['not json at all'],
    ['{"type":"doc","content":[}'],
  ])('R7: 깨진 JSON "%s" → null', (broken) => {
    expect(extractAttachmentIds(broken)).toBeNull();
  });

  it.each([['123'], ['"문자열"'], ['[]'], ['null']])(
    'R8: JSON 이지만 doc 이 아닌 값 "%s" → [] (파싱은 성공했다)',
    (value) => {
      expect(extractAttachmentIds(value)).toEqual([]);
    },
  );

  it('R9: attachmentId 없는 image 노드(외부 URL) → 무시', () => {
    expect(
      extractAttachmentIds(doc(imageNode({ src: 'https://외부/x.png' }))),
    ).toEqual([]);
  });

  it.each([['not-a-uuid'], ["' OR 1=1 --"], ['11111111-1111'], ['']])(
    'R10: uuid 아닌 attachmentId "%s" → 버린다',
    (bad) => {
      expect(
        extractAttachmentIds(doc(imageNode({ attachmentId: bad }))),
      ).toEqual([]);
    },
  );

  it('R10: 숫자·객체 attachmentId → 버린다 (타입도 본다)', () => {
    expect(extractAttachmentIds(doc(imageNode({ attachmentId: 42 })))).toEqual(
      [],
    );
    expect(
      extractAttachmentIds(doc(imageNode({ attachmentId: { id: A1 } }))),
    ).toEqual([]);
  });

  it('R11: 표·토글 안의 중첩 이미지도 수집', () => {
    const nested = doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [imageNode({ attachmentId: A1 })],
            },
          ],
        },
      ],
    });
    expect(extractAttachmentIds(nested)).toEqual([A1]);
  });

  it('R12: type 이 image 가 아닌 노드의 attachmentId 는 안 센다', () => {
    expect(
      extractAttachmentIds(
        doc({ type: 'paragraph', attrs: { attachmentId: A1 } }),
      ),
    ).toEqual([]);
  });

  it.each([[null], ['문자열'], [42]])(
    'R13: attrs 가 %p → 예외 없이 무시',
    (attrs) => {
      expect(extractAttachmentIds(doc(imageNode(attrs)))).toEqual([]);
    },
  );

  it('R14: 대문자 uuid 도 형식만 맞으면 허용', () => {
    const upper = A1.toUpperCase();
    expect(
      extractAttachmentIds(doc(imageNode({ attachmentId: upper }))),
    ).toEqual([upper]);
  });
});
