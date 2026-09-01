import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import {
  CreateStudyNoteDto,
  NOTE_CONTENT_MAX_CHARS,
  UpdateStudyNoteDto,
} from '../../study-notes/dto/study-note.dto';
import {
  CreateStepNoteSheetDto,
  UpdateStepNoteSheetDto,
} from '../../applications/dto/step-note-sheet.dto';

/**
 * 노트 본문 상한 2층(`@TiptapTextMaxLength` + 방어용 `@MaxLength`) DTO 검증.
 *
 * 2026-09-02 실사고 재현 — 화면 카운터에 「56,281 / 100,000」 이 떠 있는 노트가
 * JSON 문자열로는 110,000자였고, 그때의 `@MaxLength(100_000)` 이 이를 400 으로 거절했다.
 * 사용자는 여유가 있다고 보면서 저장을 못 했다.
 *
 * 시나리오 (DTO 4종 공통)
 *  ① 회귀: 텍스트 56,300자 / JSON 100,000자 초과인 구조 많은 노트 → **통과**
 *  ② 텍스트 100,001자 → 실패 + 문구 정확 일치
 *  ③ 경계: 텍스트 정확히 100,000자 → 통과
 *  ④ JSON 이 아닌 평문 150,000자 → 폴백 길이로 실패
 *  ⑤ 원문 400,001자(텍스트 0자 JSON 폭탄) → 방어 상한만 실패
 *  ⑥ content: '' → 통과
 *  ⑦ content 미전달 → 통과
 */

const MESSAGE = '노트는 100,000자까지 저장할 수 있어요.';

type NoteContentDto =
  | CreateStudyNoteDto
  | UpdateStudyNoteDto
  | CreateStepNoteSheetDto
  | UpdateStepNoteSheetDto;

interface DtoCase {
  label: string;
  Dto: ClassConstructor<NoteContentDto>;
  /** content 외 필수 필드 — 에러 노이즈를 없앤다 */
  base: Record<string, unknown>;
}

const DTOS: readonly DtoCase[] = [
  { label: 'CreateStudyNoteDto', Dto: CreateStudyNoteDto, base: {} },
  { label: 'UpdateStudyNoteDto', Dto: UpdateStudyNoteDto, base: {} },
  {
    label: 'CreateStepNoteSheetDto',
    Dto: CreateStepNoteSheetDto,
    base: { name: '준비 노트' },
  },
  { label: 'UpdateStepNoteSheetDto', Dto: UpdateStepNoteSheetDto, base: {} },
];

// ── 픽스처 ───────────────────────────────────────────────────

/**
 * 실사고 형태 — 헤딩이 섞인 구조 많은 노트.
 * 텍스트 56,300자(여유)인데 JSON 문자열은 100,000자를 넘는다.
 */
function heavyNote(): { content: string; textLength: number } {
  const line = '가'.repeat(56);
  const head = '소제목';
  const nodes: unknown[] = [];
  let textLength = 0;
  for (let i = 0; i < 1_000; i += 1) {
    if (i % 10 === 0) {
      nodes.push({
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: head }],
      });
      textLength += head.length;
    }
    nodes.push({ type: 'paragraph', content: [{ type: 'text', text: line }] });
    textLength += line.length;
  }
  return {
    content: JSON.stringify({ type: 'doc', content: nodes }),
    textLength,
  };
}

/** 텍스트 정확히 n자짜리 최소 doc — 경계 검증용 */
function exactTextDoc(chars: number): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '가'.repeat(chars) }],
      },
    ],
  });
}

/** 텍스트 0자인데 원문은 400,000자를 넘는 payload — 방어 상한 전용 */
function jsonBomb(): string {
  return JSON.stringify({
    type: 'doc',
    content: Array.from({ length: 21_000 }, () => ({ type: 'paragraph' })),
  });
}

const HEAVY = heavyNote();
const BOMB = jsonBomb();
const PLAIN_OVER = '가'.repeat(150_000);

// 픽스처가 실제로 의도한 형태인지 먼저 못 박는다 — 아니면 이 아래 판정이 전부 무의미하다
describe('픽스처 전제', () => {
  it('회귀 노트: 텍스트는 상한 아래인데 JSON 문자열은 옛 상한을 넘는다', () => {
    expect(HEAVY.textLength).toBe(56_300);
    expect(HEAVY.textLength).toBeLessThan(NOTE_CONTENT_MAX_CHARS);
    expect(HEAVY.content.length).toBeGreaterThan(NOTE_CONTENT_MAX_CHARS);
    // 방어 상한(400,000)에는 걸리지 않아야 ① 이 「텍스트 판정 덕에 통과」임을 증명한다
    expect(HEAVY.content.length).toBeLessThan(400_000);
  });

  it('JSON 폭탄: 텍스트 0자인데 원문은 400,000자 초과', () => {
    expect(BOMB.length).toBeGreaterThan(400_000);
  });
});

// ── DTO 검증 ─────────────────────────────────────────────────

function constraintKeys(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
}

function contentMessages(errors: ValidationError[]): string[] {
  return errors
    .filter((e) => e.property === 'content')
    .flatMap((e) => Object.values(e.constraints ?? {}));
}

for (const { label, Dto, base } of DTOS) {
  const check = (content?: string): Promise<ValidationError[]> =>
    validate(
      plainToInstance(
        Dto,
        content === undefined ? { ...base } : { ...base, content },
      ),
    );

  describe(`${label} — content 상한`, () => {
    it('① 회귀: 텍스트 56,300자 / JSON 100,000자 초과 구조 노트 → 통과', async () => {
      expect(await check(HEAVY.content)).toHaveLength(0);
    });

    it('② 텍스트 100,001자 → 실패 + 문구 정확 일치', async () => {
      const errors = await check(exactTextDoc(NOTE_CONTENT_MAX_CHARS + 1));
      expect(contentMessages(errors)).toEqual([MESSAGE]);
      expect(constraintKeys(errors)).toEqual(['tiptapTextMaxLength']);
    });

    it('③ 경계: 텍스트 정확히 100,000자 → 통과', async () => {
      expect(await check(exactTextDoc(NOTE_CONTENT_MAX_CHARS))).toHaveLength(0);
    });

    it('④ JSON 이 아닌 평문 150,000자 → 폴백 길이로 실패', async () => {
      const errors = await check(PLAIN_OVER);
      expect(contentMessages(errors)).toEqual([MESSAGE]);
      // 원문 150,000자는 방어 상한(400,000) 아래 — 텍스트 폴백 판정이 잡은 것이다
      expect(constraintKeys(errors)).toEqual(['tiptapTextMaxLength']);
    });

    it('⑤ 원문 400,001자 JSON 폭탄(텍스트 0자) → 방어 상한이 잡는다', async () => {
      const errors = await check(BOMB);
      expect(constraintKeys(errors)).toEqual(['maxLength']);
      expect(contentMessages(errors)).toEqual([MESSAGE]);
    });

    it("⑥ content: '' → 통과", async () => {
      expect(await check('')).toHaveLength(0);
    });

    it('⑦ content 미전달 → 통과', async () => {
      expect(await check()).toHaveLength(0);
    });
  });
}
