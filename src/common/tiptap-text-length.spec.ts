import { tiptapTextLength } from './tiptap-text-length';

/**
 * `tiptapTextLength` 계약 — **본문 글자수** 를 세고, **어떤 입력에도 던지지 않는다**.
 *
 * 시나리오
 *  ① 빈 문자열 → 0
 *  ② tiptap doc — 중첩(heading·blockquote·table) 안의 text 까지 전부 합산
 *  ③ 구조가 많으면 JSON 길이 ≫ 텍스트 길이 (2026-09-02 사고의 형태)
 *  ④ JSON 이 아닌 legacy 평문 → 원문 길이 (이 결함 이전과 같은 기준 = 회귀 없음)
 *  ⑤ JSON 이지만 doc 이 아님(배열·숫자·문자열·다른 노드) → 원문 길이
 *  ⑥ 텍스트 0자 doc(빈 문단·이미지) → 0
 *  ⑦ attrs·marks 안의 문자열은 세지 않는다 (사용자 본문이 아니다)
 *  ⑧ text 가 문자열이 아닌 깨진 노드 → 던지지 않고 그 노드만 0
 *  ⑨ 1,000단 중첩 → 스택을 터뜨리지 않고 정확히 합산
 */

const doc = (content: unknown[]) => JSON.stringify({ type: 'doc', content });
const para = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

describe('tiptapTextLength', () => {
  it('① 빈 문자열 → 0', () => {
    expect(tiptapTextLength('')).toBe(0);
  });

  it('② 중첩 노드 안의 text 까지 전부 합산', () => {
    const content = tiptapTextLength(
      doc([
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: '제목' }], // 2
        },
        para('본문입니다'), // 5
        { type: 'blockquote', content: [para('인용')] }, // 2
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [para('셀값')], // 2
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(content).toBe(11);
  });

  it('③ 구조가 많으면 텍스트보다 JSON 이 훨씬 길다 — 판정은 텍스트로', () => {
    const raw = doc(Array.from({ length: 1_000 }, () => para('가'.repeat(56))));
    expect(tiptapTextLength(raw)).toBe(56_000);
    // 같은 노트를 JSON 길이로 재면 옛 상한(100,000)을 넘는다 = 이번 사고
    expect(raw.length).toBeGreaterThan(100_000);
  });

  it('④ JSON 이 아닌 legacy 평문 → 원문 길이 (던지지 않는다)', () => {
    const plain = '스터디 정리\n1. 자료구조\n2. 네트워크';
    expect(() => tiptapTextLength(plain)).not.toThrow();
    expect(tiptapTextLength(plain)).toBe(plain.length);
  });

  it('④-2 중간에서 잘린 JSON → 원문 길이 (던지지 않는다)', () => {
    const broken = '{"type":"doc","content":[{"type":"para';
    expect(tiptapTextLength(broken)).toBe(broken.length);
  });

  it('⑤ JSON 이지만 doc 이 아니면 원문 길이', () => {
    for (const raw of [
      '[1,2,3]',
      '42',
      '"그냥 문자열"',
      'null',
      '{"type":"paragraph"}',
    ]) {
      expect(() => tiptapTextLength(raw)).not.toThrow();
      expect(tiptapTextLength(raw)).toBe(raw.length);
    }
  });

  it('⑥ 텍스트 0자 doc(빈 문단·이미지) → 0', () => {
    expect(tiptapTextLength(doc([{ type: 'paragraph' }]))).toBe(0);
    expect(
      tiptapTextLength(
        doc([{ type: 'image', attrs: { src: 'https://cdn.example/a.png' } }]),
      ),
    ).toBe(0);
  });

  it('⑦ attrs·marks 안의 문자열은 세지 않는다', () => {
    const raw = doc([
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '링크', // 2 — 이것만 센다
            marks: [
              {
                type: 'link',
                attrs: { href: 'https://example.com/아주-긴-주소' },
              },
            ],
          },
        ],
      },
    ]);
    expect(tiptapTextLength(raw)).toBe(2);
  });

  it('⑧ text 가 문자열이 아닌 깨진 노드 → 던지지 않고 그 노드는 0', () => {
    const raw = doc([
      { type: 'paragraph', content: [{ type: 'text', text: 12345 }] },
      { type: 'paragraph', content: 'content 가 배열이 아님' },
      para('정상'),
    ]);
    expect(() => tiptapTextLength(raw)).not.toThrow();
    expect(tiptapTextLength(raw)).toBe(2);
  });

  it('⑨ 1,000단 중첩 → 스택을 터뜨리지 않고 정확히 합산', () => {
    let node: Record<string, unknown> = { type: 'text', text: '끝' };
    for (let i = 0; i < 1_000; i += 1) {
      node = { type: 'blockquote', content: [node] };
    }
    const raw = doc([node]);
    expect(() => tiptapTextLength(raw)).not.toThrow();
    expect(tiptapTextLength(raw)).toBe(1);
  });
});
