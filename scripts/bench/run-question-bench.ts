/**
 * 면접 **질문 전용** 모델 벤치 (v2) — 두 가지를 동시에 정한다.
 *
 *   npx ts-node -r dotenv/config scripts/bench/run-question-bench.ts
 *
 * 1. **모델** — v2 는 답변을 안 만든다. 그래서 기존 벤치의 판별축(답변 속 지어내기)이
 *    사라진다. 실제로 질문문 지어내기는 haiku 4 / luna 1 / 4o-mini 0 으로 **세 모델이 동률**이었다.
 *    대신 **자료 밀착도**로 가른다 — 4o-mini 를 탈락시킨 그 축이다:
 *      4o-mini "프로세스와 스레드의 차이점에 대해 설명해 주세요"  ← 검색하면 나오는 질문
 *      luna    "결제 서버에서 프로세스와 스레드의 차이가 중요해지는 상황을 설명하고…"  ← 사용자 경험에 엮음
 *    이 차이를 사람 눈이 아니라 **코드로** 센다.
 *
 * 2. **1콜 vs 2-stage** (계획 D9) — 2026-06 결정은 "2-stage 폐지, 1콜 통합" 이고
 *    이번 계획 초안은 2-stage 유지였다. 원가는 거의 같고(3.1 vs 3.2원) 지연은 1콜이 절반이다.
 *    쟁점은 **한 번에 20문항의 카테고리를 고르게 뽑는가** 뿐이므로 분포로 판정한다.
 *
 * ## 채점 (LLM judge 없음 — 전부 코드)
 *
 * | 축 | 무엇을 세나 |
 * |---|---|
 * | 자료 밀착도 | **직무 fork·coverletter_based 질문 중** 사용자 자료의 사실을 인용한 비율 |
 * | 공통 질문 커버리지 | 면접 정형 10종이 실제로 나왔는가 (강점·약점, 협업·갈등은 2개씩) |
 * | 카테고리 분포 | 고유 카테고리 수 · 최대 쏠림 비율 (1콜 판정의 핵심) |
 * | 지어내기 | 질문문의 수치 중 자료 밖 (기존 채점기 재사용) |
 * | 로그 id 위조 | 후보 풀 밖 id |
 *
 * 🔴 자료 밀착도를 **fork·coverletter_based 에만** 적용하는 이유 — `self_intro`·`closing_remark`
 * 같은 정형 질문은 자료 인용이 없는 게 정상이다. 전체에 걸면 정형 질문을 잘 낸 모델이 손해를 본다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  MODEL_REGISTRY,
  effectivePricing,
  getModelSpec,
} from '../../src/ai/model-registry';
import { buildInterviewContext } from '../../src/interview-prep/interview-context-builder';
import {
  ONECALL_HINT,
  SESSION_JSON_SCHEMA,
} from '../../src/interview-prep/interview-prep-ai.service';

/**
 * 🔴 **이 벤치가 비교 대상으로 썼던 2-stage 힌트의 고정 사본.**
 * 이 측정 결과로 1콜이 채택돼 프로덕션에서 2-stage 는 제거됐다. 여기 남기는 이유는
 * `results-question/` 의 `*__2stage-*` 캐시가 어떤 프롬프트로 나왔는지 기록하기 위해서다.
 * 프로덕션에는 더 이상 대응물이 없으므로 **동기화 대상이 아니다.**
 */
const STAGE1_HINT = `

# 이번 호출 — Stage 1 (공통 정형 질문)
- 위 "반드시 포함해야 하는 공통 질문" 을 **12-13개** 생성한다.
  self_intro 1 · motivation 1 · personality 2(강점·약점 분리) · failure 1 · collaboration 2(협업·갈등 분리) ·
  executive 1 · culture_fit 1 · company_industry 1 · aspiration 1 · reverse_question 1 · closing_remark 1
- 직무 fork (cs_tech · business_reasoning · data_metrics · trend_ai · customer_handling · performance ·
  portfolio_decision · design_process) 와 coverletter_based 는 만들지 마라 (다음 stage 에서 생성).`;

const STAGE2_HINT = `

# 이번 호출 — Stage 2 (직무 fork + 자소서 깊이)
- 공통 정형 질문 (self_intro · motivation · personality · failure · collaboration · executive ·
  culture_fit · company_industry · aspiration · reverse_question · closing_remark) 은 Stage 1 에서
  이미 생성됐다. **절대 다시 만들지 마라.**
- 직무 fork 카테고리 (jobCategory 기반, 위 '직무 fork' 섹션 따름) + coverletter_based
  (자소서·활동 기록에서 깊이 있는 추궁) 합쳐 **7-8개** 생성.`;
import {
  INTERVIEW_GOLDEN_SET,
  type InterviewGoldenCase,
} from './interview-golden-set';
import { classify, extractFigures } from './run-draft-bench';
import { dedupeFigures } from './run-interview-bench';

const OUT_DIR = join(__dirname, 'results-question');
const KRW = 1380;
/** 질문만 뽑으므로 출력이 작다. 12,000 은 v1 값이라 과하다 */
const MAX_OUTPUT_TOKENS = 4_000;

const CANDIDATES = ['gpt-4o-mini', 'gpt-5.6-luna', 'gpt-5.6-terra'];

/** 자료 인용이 기대되는 카테고리 — 정형 질문은 제외한다 */
const GROUNDED_EXPECTED = new Set([
  'coverletter_based',
  'cs_tech',
  'business_reasoning',
  'data_metrics',
  'trend_ai',
  'customer_handling',
  'performance',
  'portfolio_decision',
  'design_process',
]);

/** 면접 공통 질문 10종 → 카테고리 매핑. 값은 최소 개수 */
const COMMON_REQUIRED: Array<[string, string, number]> = [
  ['자기소개', 'self_intro', 1],
  ['지원동기', 'motivation', 1],
  ['강점·약점', 'personality', 2],
  ['힘들었던 경험', 'failure', 1],
  ['협업·갈등', 'collaboration', 2],
  ['왜 우리 회사', 'company_industry', 1],
  ['입사 후 포부', 'aspiration', 1],
  ['임원·가치관', 'executive', 1],
  ['역질문', 'reverse_question', 1],
  ['마지막 할 말', 'closing_remark', 1],
];

interface Q {
  category?: string;
  question?: string;
  source_log_ids?: string[];
}
interface CallResult {
  questions: Q[];
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  thinkingTokens: number;
  latencyMs: number;
}

async function call(
  model: string,
  system: string,
  user: string,
): Promise<CallResult> {
  const started = Date.now();
  const spec = getModelSpec(model)!;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      ...(spec.supportsTemperature ? { temperature: 0.5 } : {}),
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
  if (!res.ok) throw new Error(`${model}: ${JSON.stringify(j).slice(0, 400)}`);
  const text = j.choices?.[0]?.message?.content ?? '';
  let questions: Q[] = [];
  let ok = true;
  try {
    questions = (JSON.parse(text) as { questions?: Q[] }).questions ?? [];
  } catch {
    ok = false; // 잘림 → 아래에서 ⛔
  }
  return {
    questions,
    ok,
    inputTokens: j.usage?.prompt_tokens ?? 0,
    outputTokens: j.usage?.completion_tokens ?? 0,
    stopReason: j.choices?.[0]?.finish_reason ?? '?',
    thinkingTokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    latencyMs: Date.now() - started,
  };
}

async function run(
  c: InterviewGoldenCase,
  model: string,
  mode: '1call' | '2stage',
  stage: 1 | 2 | 0,
): Promise<CallResult & { cached: boolean }> {
  const file = join(
    OUT_DIR,
    `${c.id}__${mode}${stage ? `-s${stage}` : ''}__${model.replace(/[/.]/g, '-')}.json`,
  );
  if (existsSync(file)) {
    return {
      ...(JSON.parse(readFileSync(file, 'utf8')) as CallResult),
      cached: true,
    };
  }
  const ctx = buildInterviewContext(c.input);
  const hint =
    mode === '1call' ? ONECALL_HINT : stage === 1 ? STAGE1_HINT : STAGE2_HINT;
  const r = await call(model, ctx.systemPrompt + hint, ctx.userPrompt);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(r, null, 2));
  return { ...r, cached: false };
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  let spent = 0;
  const rows: Array<Record<string, number | string>> = [];

  for (const model of CANDIDATES) {
    const spec = MODEL_REGISTRY[model];
    const price = effectivePricing(spec, today);

    for (const mode of ['1call', '2stage'] as const) {
      let grounded = 0;
      let groundedTotal = 0;
      let fabricated = 0;
      let fakeIds = 0;
      let missing = 0;
      let failures = 0;
      let krw = 0;
      let ms = 0;
      let qTotal = 0;
      let maxSkew = 0;
      let catTotal = 0;

      console.log(
        `\n${'='.repeat(72)}\n■ ${spec.label} · ${mode}\n${'='.repeat(72)}`,
      );

      for (const c of INTERVIEW_GOLDEN_SET) {
        const pool = new Set(buildInterviewContext(c.input).meta.candidateLogIds);
        const stages: Array<1 | 2 | 0> = mode === '1call' ? [0] : [1, 2];
        const all: Q[] = [];
        for (const st of stages) {
          const r = await run(c, model, mode, st);
          const cost =
            ((r.inputTokens * price.input + r.outputTokens * price.output) /
              1e6) *
            KRW;
          krw += cost;
          ms += r.latencyMs;
          if (!r.cached) spent += cost;
          if (!r.ok || r.questions.length === 0) failures += 1;
          all.push(...r.questions);
        }

        // 카테고리 분포
        const counts: Record<string, number> = {};
        for (const q of all) counts[q.category ?? '?'] = (counts[q.category ?? '?'] ?? 0) + 1;
        const skew = all.length ? Math.max(...Object.values(counts)) / all.length : 0;
        maxSkew = Math.max(maxSkew, skew);
        catTotal += Object.keys(counts).length;
        qTotal += all.length;

        // 공통 질문 커버리지
        const miss = COMMON_REQUIRED.filter(
          ([, cat, need]) => (counts[cat] ?? 0) < need,
        ).map(([label]) => label);
        missing += miss.length;

        // 자료 밀착도 · 지어내기 · id 위조
        let g = 0;
        let gT = 0;
        for (const q of all) {
          const text = q.question ?? '';
          if (GROUNDED_EXPECTED.has(q.category ?? '')) {
            gT += 1;
            if (c.allowedFacts.some((f) => text.includes(f))) g += 1;
          }
          for (const f of dedupeFigures(extractFigures(text)))
            if (classify(f, c.allowedFacts).kind === 'fabricated') fabricated += 1;
          for (const id of q.source_log_ids ?? []) if (!pool.has(id)) fakeIds += 1;
        }
        grounded += g;
        groundedTotal += gT;

        console.log(
          `  ${c.id} ${c.input.application.jobCategory}: 질문 ${String(all.length).padStart(2)}개 · ` +
            `카테고리 ${Object.keys(counts).length}종 · 쏠림 ${(skew * 100).toFixed(0)}% · ` +
            `밀착 ${g}/${gT}` +
            (miss.length ? ` · 🔴 누락: ${miss.join('·')}` : ' · ✅ 공통 10종'),
        );
      }

      const n = INTERVIEW_GOLDEN_SET.length;
      rows.push({
        모델: spec.label,
        모드: mode,
        질문: (qTotal / n).toFixed(1),
        '카테고리종': (catTotal / n).toFixed(1),
        '최대쏠림%': (maxSkew * 100).toFixed(0),
        '자료밀착%': groundedTotal ? ((grounded / groundedTotal) * 100).toFixed(0) : '—',
        '공통누락': missing,
        '지어내기': fabricated,
        'id위조': fakeIds,
        '실패': failures,
        '원/세션': (krw / n).toFixed(1),
        '초': (ms / n / 1000).toFixed(0),
      });
    }
  }

  console.log(`\n${'='.repeat(72)}\n■ 판정\n`);
  const keys = Object.keys(rows[0]);
  console.log('  ' + keys.map((k) => k.padEnd(k === '모델' ? 14 : 9)).join(''));
  for (const r of rows)
    console.log(
      '  ' +
        keys.map((k) => String(r[k]).padEnd(k === '모델' ? 14 : 9)).join(''),
    );
  console.log(`\n   이번 실행 비용: ${spent.toFixed(0)}원 (캐시 제외)\n`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
