/**
 * 면접 종류별 결과 차이 실측 (2026-08-07).
 *
 * ## 왜 재는가
 *
 * 종류별 프롬프트 지시를 넣고 "프롬프트가 다르다" 까지만 확인했다. **모델이 그 지시를
 * 따르는지**는 안 재봤다. 지시가 무시되면 6종이 라벨만 다른 같은 결과가 된다.
 *
 * ## 무엇을 보는가 — **같은 입력, 종류만 변경**
 *
 * 1. **공통 정형 질문 수** — 기술·PT·토론은 "3개만/2개만" 으로 줄이라고 지시했다.
 *    안 줄면 지시가 안 먹은 것이고, 20문항 중 12개가 고정이라 종류 차이가 죽는다.
 * 2. **질문 중복률** — 종류를 바꿨는데 같은 질문이 그대로 나오면 라벨만 바뀐 것이다.
 *    실무·직무를 기준으로 나머지 5종이 얼마나 겹치는지 본다.
 * 3. **카테고리 분포** — 기술은 지식 쪽, 토론은 collaboration 쪽으로 쏠려야 한다.
 *
 * 실행: `OPENAI_API_KEY=... npx ts-node scripts/bench/run-type-bench.ts`
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildInterviewContext } from '../../src/interview-prep/interview-context-builder';
import { SESSION_JSON_SCHEMA } from '../../src/interview-prep/interview-prep-ai.service';
import { INTERVIEW_TYPES } from '../../src/interview-prep/interview-types.const';
import { INTERVIEW_GOLDEN_SET } from './interview-golden-set';

const MODEL = 'gpt-5.6-luna';
const OUT_DIR = join(__dirname, 'results-type');
const KRW = 1380;
const PRICE = { input: 0.15, output: 0.6 };

/** 종류를 바꿔도 자료는 같아야 한다 — 변수를 하나만 둔다 */
const BASE = INTERVIEW_GOLDEN_SET[0]; // 현대오토에버 · 백엔드 · 로그 3건

const COMMON_CATS = new Set([
  'self_intro',
  'motivation',
  'personality',
  'failure',
  'collaboration',
  'executive',
  'culture_fit',
  'company_industry',
  'aspiration',
  'reverse_question',
  'closing_remark',
]);

interface Q {
  category?: string;
  question: string;
  must_prepare?: boolean;
  source_log_ids: string[];
}

async function call(system: string, user: string) {
  const started = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_completion_tokens: 4_000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: SESSION_JSON_SCHEMA.name,
          schema: SESSION_JSON_SCHEMA.schema,
          strict: true,
        },
      },
    }),
  });
  const j = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  let questions: Q[] = [];
  try {
    questions = (JSON.parse(j.choices?.[0]?.message?.content ?? '{}')
      .questions ?? []) as Q[];
  } catch {
    /* 잘림 */
  }
  return {
    questions,
    costKrw:
      ((j.usage?.prompt_tokens ?? 0) / 1e6) * PRICE.input * KRW +
      ((j.usage?.completion_tokens ?? 0) / 1e6) * PRICE.output * KRW,
    latencyMs: Date.now() - started,
  };
}

/**
 * 질문 유사도 — 조사·어미를 빼고 **명사 위주 토큰**으로 비교한다.
 * 문장이 조금 달라도 같은 걸 묻고 있으면 겹친 것으로 본다.
 */
function normalize(q: string): Set<string> {
  return new Set(
    q
      .replace(/[^가-힣a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2),
  );
}
function similar(a: string, b: string): boolean {
  const A = normalize(a);
  const B = normalize(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, Math.min(A.size, B.size)) >= 0.6;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 없음');
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    `\n면접 종류별 차이 — ${MODEL}\n같은 입력(${BASE.input.application.companyName}·${BASE.input.application.jobCategory}), 종류만 변경\n`,
  );

  const rows: Array<{
    type: string;
    total: number;
    common: number;
    cats: Record<string, number>;
    questions: string[];
    costKrw: number;
  }> = [];

  for (const type of INTERVIEW_TYPES) {
    const ctx = buildInterviewContext({ ...BASE.input, interviewType: type });
    process.stdout.write(`▶ ${type.padEnd(13)} … `);
    try {
      const r = await call(ctx.systemPrompt, ctx.userPrompt);
      const cats: Record<string, number> = {};
      for (const q of r.questions)
        cats[q.category ?? '?'] = (cats[q.category ?? '?'] ?? 0) + 1;
      rows.push({
        type,
        total: r.questions.length,
        common: r.questions.filter((q) => COMMON_CATS.has(q.category ?? ''))
          .length,
        cats,
        questions: r.questions.map((q) => q.question),
        costKrw: r.costKrw,
      });
      console.log(`${r.questions.length}문항 · ${r.latencyMs}ms`);
    } catch (e) {
      console.log(`실패: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  const baseRow = rows.find((r) => r.type === 'job_fit');

  console.log(`\n${'='.repeat(76)}\n결과\n${'='.repeat(76)}`);
  console.log(
    `${'종류'.padEnd(15)}${'문항'.padEnd(6)}${'공통'.padEnd(7)}${'직무'.padEnd(7)}실무·직무와 겹침`,
  );
  for (const r of rows) {
    const overlap =
      baseRow && r.type !== 'job_fit'
        ? r.questions.filter((q) =>
            baseRow.questions.some((b) => similar(q, b)),
          ).length
        : null;
    const pct =
      overlap === null ? '—' : `${Math.round((overlap / r.total) * 100)}%`;
    console.log(
      `${r.type.padEnd(15)}${String(r.total).padEnd(6)}${String(r.common).padEnd(7)}` +
        `${String(r.total - r.common).padEnd(7)}${pct}`,
    );
  }

  console.log(`\n── 카테고리 분포 ──`);
  for (const r of rows) {
    const top = Object.entries(r.cats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([c, n]) => `${c}:${n}`)
      .join(' · ');
    console.log(`${r.type.padEnd(15)}${top}`);
  }

  console.log(
    `\n총 원가: ${rows.reduce((a, r) => a + r.costKrw, 0).toFixed(1)}원`,
  );
  const out = join(OUT_DIR, `type-${process.env.BENCH_STAMP ?? 'run'}.json`);
  writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`저장: ${out}`);
}

void main();
