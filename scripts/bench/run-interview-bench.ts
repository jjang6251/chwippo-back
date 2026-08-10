/**
 * 면접 질문 모델 벤치 — **luna 가 haiku 를 대체할 수 있는가.**
 *
 *   npx ts-node -r dotenv/config scripts/bench/run-interview-bench.ts
 *
 * ## 왜 도는가 (2026-08-06)
 *
 * `interview_prep_session` 은 `claude-haiku-4-5` 를 쓴다. Claude 안에서는 이미 최저가라
 * "더 싼 Claude" 라는 선택지가 없고, 레버는 provider 교차뿐이다. 단가만 보면
 * `gpt-5.6-luna` 가 세션당 92원 → 15원(-84%) 이지만 — **luna 는 이 프로젝트에서
 * 호출 이력 0건 · 벤치 0건이다.** 스펙 시트상 terra 와 단가 외 차이가 없어
 * 근거로 쓸 수 없다. 그래서 잰다.
 *
 * ## 자소서 벤치(`run-draft-bench.ts`)와 다른 점
 *
 * 1. **구조화 출력**이라 provider 별 호출 형태를 프로덕션과 맞춰야 한다 —
 *    anthropic 은 `tool_use` 강제, openai 는 `response_format: json_schema strict`.
 *    자유 텍스트로 재면 **프로덕션에서 나는 스키마 실패를 못 본다.**
 * 2. **2-stage 순차 호출**이 프로덕션 동작이다 (stage1 base → stage2 fork).
 *    1콜만 재면 원가도 지연도 절반으로 착시가 생긴다.
 * 3. 🔴 **`source_log_ids` 위조**라는 축이 새로 있다. 자소서엔 없던 결정적 축 —
 *    준 적 없는 id 를 달면 사용자가 면접장에서 없는 경험을 말하게 된다.
 *
 * ## 채점 — LLM judge 를 쓰지 않는다
 *
 * 자소서 벤치와 같은 이유(Claude judge 가 Claude 출력에 유리할 위험). **전부 코드로**
 * 결정적으로 센다. 회사 단정문만 자동 판정이 어려워 사람이 볼 목록으로 출력한다.
 *
 * ## 비용
 *
 * 생성 결과를 파일로 캐시한다 — 채점 로직을 고쳐 다시 돌려도 재생성하지 않는다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  MODEL_REGISTRY,
  effectivePricing,
  getModelSpec,
} from '../../src/ai/model-registry';
import { buildInterviewContext } from '../../src/interview-prep/interview-context-builder';
import { INTERVIEW_CATEGORIES } from '../../src/interview-prep/interview-categories.const';
import { SESSION_JSON_SCHEMA } from '../../src/interview-prep/interview-prep-ai.service';

/**
 * 🔴 **v1 당시 프로덕션 힌트를 그대로 고정한 사본이다.** 프로덕션에서는 2026-08-06 v2 전환으로
 * 제거됐다(1콜로 통합). 여기 남겨두는 이유는 `results-interview/` 에 캐시된 측정이
 * **어떤 프롬프트로 나온 값인지** 기록으로 남기기 위해서다. 프로덕션을 따라 바꾸지 마라 —
 * 바꾸면 캐시된 결과와 스크립트가 어긋나 과거 측정을 설명하지 못한다.
 */
const STAGE1_HINT = `

# 이번 호출 — Stage 1 (Base 카테고리)
- Base 카테고리만 9-11개 생성: self_intro · motivation · personality · failure · collaboration · executive · culture_fit · company_industry · reverse_question.
- 직무 fork (cs_tech · business_reasoning · data_metrics · trend_ai · customer_handling · performance · portfolio_decision · design_process) 와 coverletter_based 는 만들지 마라 (다음 stage 에서 생성).`;

const STAGE2_HINT = `

# 이번 호출 — Stage 2 (직무 fork + 자소서 깊이)
- Base 카테고리 (self_intro · motivation · personality · failure · collaboration · executive · culture_fit · company_industry · reverse_question) 는 Stage 1 에서 이미 생성됨. 절대 다시 만들지 마라.
- 직무 fork 카테고리 (jobCategory 기반, 카테고리 가이드 의 '직무 fork' 섹션 따름) + coverletter_based (자소서·활동 일지에서 깊이 있는 추궁) 합쳐 9-11개 생성.`;
import {
  INTERVIEW_GOLDEN_SET,
  type InterviewGoldenCase,
} from './interview-golden-set';
import { classify, extractFigures } from './run-draft-bench';

const OUT_DIR = join(__dirname, 'results-interview');
const KRW = 1380;

/** 프로덕션 `FEATURE_MATRIX.interview_prep_session.maxOutputTokens` 와 같은 값을 쓴다 */
const MAX_OUTPUT_TOKENS = 12_000;

/** 가격 싼 순서. 이 순서대로 세워 **통과하는 첫 모델**을 고른다 (자소서 벤치와 동일 규칙) */
const CANDIDATES = [
  'gpt-4o-mini', // 참고용 바닥값 — 2026-06-01 이전 기본값이었다
  'gpt-5.6-luna', // 이번 후보
  'claude-haiku-4-5-20251001', // 현재 운영 모델 = 대조군
];

/** STAGE1_HINT 가 지정하는 base 카테고리 */
const BASE_CATEGORIES = new Set([
  'self_intro',
  'motivation',
  'personality',
  'failure',
  'collaboration',
  'executive',
  'culture_fit',
  'company_industry',
  'reverse_question',
]);

interface Question {
  category?: string;
  question?: string;
  suggested_answer?: string;
  source_log_ids?: string[];
  follow_ups?: unknown[];
}

interface CallResult {
  /** 파싱된 JSON. 파싱 실패 시 null */
  json: { questions?: Question[] } | null;
  /** 파싱 실패 시 원문 (진단용) */
  raw: string;
  inputTokens: number;
  outputTokens: number;
  /** 🔴 잘림 감지 — 빈 결과를 "위반 0건 = 통과" 로 세면 실패를 통과로 센다 */
  stopReason: string;
  /** 추론 모델은 출력 예산을 본문과 나눠 쓴다 (자소서 벤치에서 Sonnet 5 가 본문 잘림) */
  thinkingTokens: number;
  latencyMs: number;
}

// ── 호출 (프로덕션 provider 와 같은 형태) ──────────────────────
async function callAnthropic(
  model: string,
  system: string,
  user: string,
): Promise<CallResult> {
  const started = Date.now();
  // anthropic.provider.callJson 과 동일 — 단일 tool 정의 + tool_choice 강제
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.5,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [
        {
          name: SESSION_JSON_SCHEMA.name,
          description: `Structured output schema for ${SESSION_JSON_SCHEMA.name}`,
          input_schema: SESSION_JSON_SCHEMA.schema,
        },
      ],
      tool_choice: { type: 'tool', name: SESSION_JSON_SCHEMA.name },
    }),
  });
  const j = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${model}: ${JSON.stringify(j).slice(0, 400)}`);
  const block = (j.content ?? []).find(
    (b: any) => b.type === 'tool_use' && b.name === SESSION_JSON_SCHEMA.name,
  );
  return {
    json: block ? block.input : null,
    raw: block ? JSON.stringify(block.input) : JSON.stringify(j.content ?? []),
    inputTokens: j.usage?.input_tokens ?? 0,
    outputTokens: j.usage?.output_tokens ?? 0,
    stopReason: j.stop_reason ?? '?',
    thinkingTokens: j.usage?.output_tokens_details?.thinking_tokens ?? 0,
    latencyMs: Date.now() - started,
  };
}

async function callOpenAI(
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
      // gpt-5.6 계열은 기본값 1 외 400 — 레지스트리 선언을 그대로 따른다
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
  let json: CallResult['json'] = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null; // 잘림이면 파싱 실패 — 아래 채점에서 ⛔ 로 잡힌다
  }
  return {
    json,
    raw: text,
    inputTokens: j.usage?.prompt_tokens ?? 0,
    outputTokens: j.usage?.completion_tokens ?? 0,
    stopReason: j.choices?.[0]?.finish_reason ?? '?',
    thinkingTokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    latencyMs: Date.now() - started,
  };
}

// ── 채점 ────────────────────────────────────────────────────
/**
 * 🔴 `extractFigures` 는 **단위 붙은 수치와 두 자리 이상 맨숫자를 둘 다** 뽑는다.
 * 그래서 "80%" 하나가 `['80%', '80']` 로 나와 **지어내기 1건이 2건으로 부풀었다**
 * (1차 실행에서 Haiku 48건 중 상당수가 이 중복이었다).
 *
 * 자소서 벤치는 절대 건수(0건이냐)만 봐서 문제가 안 됐지만, 여기선 **모델 간 건수를
 * 비교**하므로 부풀림이 그대로 저울을 기울인다. 단위 있는 쪽을 남기고 같은 값의
 * 맨숫자는 버린다.
 */
export function dedupeFigures(figs: string[]): string[] {
  const withUnit = figs.filter((f) => /\D$/.test(f));
  const covered = new Set(withUnit.map((f) => f.replace(/\D+$/, '')));
  const bare = figs.filter((f) => /^\d+$/.test(f) && !covered.has(f));
  return [...new Set([...withUnit, ...bare])];
}

interface Score {
  /** 준 적 없는 활동 로그 id 를 근거로 단 건수 */
  fakeLogIds: string[];
  /** 자료에 없는 수치 (파생 계산 제외) */
  fabricated: string[];
  /** enum 밖 카테고리 */
  badCategories: string[];
  /** stage 규칙 위반 (stage1 에 fork · stage2 에 base) */
  stageViolations: string[];
  /** follow_ups 를 채운 질문 수 (스키마상 반드시 빈 배열) */
  filledFollowUps: number;
  /** 개수 8~12 위반 */
  countViolation: string | null;
  /** 회사 단정문 (사람이 확인) */
  companyClaims: string[];
  questionCount: number;
}

function scoreStage(
  r: CallResult,
  c: InterviewGoldenCase,
  candidateIds: Set<string>,
  stage: 1 | 2,
): Score {
  const qs = r.json?.questions ?? [];
  const s: Score = {
    fakeLogIds: [],
    fabricated: [],
    badCategories: [],
    stageViolations: [],
    filledFollowUps: 0,
    countViolation: null,
    companyClaims: [],
    questionCount: qs.length,
  };
  if (qs.length < 8 || qs.length > 12) {
    s.countViolation = `${qs.length}개 (허용 8~12)`;
  }

  const enumSet = new Set<string>(INTERVIEW_CATEGORIES);
  for (const q of qs) {
    // 1. source_log_ids 위조 — 준 풀 밖의 id
    for (const id of q.source_log_ids ?? []) {
      if (!candidateIds.has(id)) s.fakeLogIds.push(id);
    }
    // 2. 카테고리
    if (q.category && !enumSet.has(q.category)) s.badCategories.push(q.category);
    if (q.category && enumSet.has(q.category)) {
      const isBase = BASE_CATEGORIES.has(q.category);
      if (stage === 1 && !isBase) s.stageViolations.push(q.category);
      if (stage === 2 && isBase) s.stageViolations.push(q.category);
    }
    // 3. follow_ups 는 반드시 빈 배열
    if ((q.follow_ups ?? []).length > 0) s.filledFollowUps += 1;
    // 4. 지어낸 수치 — 답변 본문만 본다 (질문문은 자료 인용이 아님)
    for (const f of dedupeFigures(extractFigures(q.suggested_answer ?? ''))) {
      if (classify(f, c.allowedFacts).kind === 'fabricated') s.fabricated.push(f);
    }
  }
  // 5. 회사 단정문 — 회사조사가 없는 케이스에서만 의미가 있다
  if (!c.input.companyResearch) {
    const company = c.input.application.companyName;
    const hedge = /(라고 이해|로 알고|것으로 알|짐작|추정|가정|확인하지 못|알지 못|모르)/;
    for (const q of qs) {
      for (const sent of (q.suggested_answer ?? '').split(/(?<=[.!?])\s+|\n+/)) {
        const t = sent.trim();
        if (
          t.includes(company) &&
          !hedge.test(t) &&
          /(입니다|합니다|한다|이다|다룹|제공|생산|개발|운영)/.test(t)
        ) {
          s.companyClaims.push(t);
        }
      }
    }
  }
  return s;
}

// ── 실행 ────────────────────────────────────────────────────
async function runStage(
  c: InterviewGoldenCase,
  model: string,
  stage: 1 | 2,
): Promise<CallResult & { cached: boolean }> {
  const file = join(
    OUT_DIR,
    `${c.id}__s${stage}__${model.replace(/[/.]/g, '-')}.json`,
  );
  if (existsSync(file)) {
    return {
      ...(JSON.parse(readFileSync(file, 'utf8')) as CallResult),
      cached: true,
    };
  }
  const ctx = buildInterviewContext(c.input);
  const system = ctx.systemPrompt + (stage === 1 ? STAGE1_HINT : STAGE2_HINT);
  const spec = getModelSpec(model)!;
  const r =
    spec.provider === 'anthropic'
      ? await callAnthropic(model, system, ctx.userPrompt)
      : await callOpenAI(model, system, ctx.userPrompt);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(r, null, 2));
  return { ...r, cached: false };
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  let totalKrw = 0;
  const summary: Array<{
    model: string;
    fakeLogIds: number;
    fabricated: number;
    schema: number;
    failures: number;
    claims: number;
    krwPerSession: number;
    secPerSession: number;
  }> = [];

  for (const model of CANDIDATES) {
    const spec = MODEL_REGISTRY[model];
    const price = effectivePricing(spec, today);
    let fakeLogIds = 0;
    let fabricated = 0;
    let schema = 0;
    let failures = 0;
    let claims = 0;
    let krw = 0;
    let ms = 0;

    console.log(
      `\n${'='.repeat(70)}\n■ ${spec.label}  (${model})\n${'='.repeat(70)}`,
    );

    for (const c of INTERVIEW_GOLDEN_SET) {
      const ctx = buildInterviewContext(c.input);
      const candidateIds = new Set(ctx.meta.candidateLogIds);
      console.log(
        `\n▸ ${c.id}  ${c.input.application.companyName} · ${c.input.application.jobCategory}` +
          `  (후보 로그 ${candidateIds.size}건)`,
      );
      console.log(`  ${c.probes}`);

      for (const stage of [1, 2] as const) {
        const r = await runStage(c, model, stage);
        const cost =
          ((r.inputTokens * price.input + r.outputTokens * price.output) / 1e6) *
          KRW;
        // 🔴 원가·지연은 **캐시에서도 집계한다** — 저장된 토큰·지연이 실측값이라
        //   캐시를 빼면 재실행 때 판정표가 0 이 된다 (모델 비교 지표가 사라짐).
        //   "이번에 실제로 쓴 돈" 은 아래 totalKrw 가 따로 센다.
        krw += cost;
        ms += r.latencyMs;
        if (!r.cached) totalKrw += cost;

        // 🔴 잘림·파싱 실패는 그 자체로 실패다. 위반 0건이라고 통과시키면
        //   "아무것도 안 낸 모델" 이 만점을 받는다.
        const truncated =
          r.stopReason === 'max_tokens' || r.stopReason === 'length';
        const broken = r.json === null || (r.json.questions ?? []).length === 0;
        const s = scoreStage(r, c, candidateIds, stage);

        fakeLogIds += s.fakeLogIds.length;
        fabricated += s.fabricated.length;
        schema +=
          s.badCategories.length +
          s.stageViolations.length +
          s.filledFollowUps +
          (s.countViolation ? 1 : 0);
        claims += s.companyClaims.length;
        if (truncated || broken) failures += 1;

        const mark =
          truncated || broken
            ? '⛔'
            : s.fakeLogIds.length || s.fabricated.length
              ? '🔴'
              : s.badCategories.length ||
                  s.stageViolations.length ||
                  s.filledFollowUps ||
                  s.countViolation
                ? '⚠️'
                : '✅';
        console.log(
          `  ${mark} stage${stage}  질문 ${s.questionCount}개 · ` +
            `out ${r.outputTokens}토큰 · ${(r.latencyMs / 1000).toFixed(1)}초` +
            (r.thinkingTokens ? ` · 추론 ${r.thinkingTokens}` : '') +
            (r.cached ? ' [캐시]' : ''),
        );
        if (truncated || broken)
          console.log(
            `     ⛔ ${r.json === null ? 'JSON 파싱 실패' : '질문 0개'} (stop=${r.stopReason})` +
              ` — 위반 여부와 무관하게 실패`,
          );
        if (s.fakeLogIds.length)
          console.log(
            `     🔴 준 적 없는 로그 id ${s.fakeLogIds.length}건: ${[...new Set(s.fakeLogIds)].join(' · ')}`,
          );
        if (s.fabricated.length)
          console.log(
            `     🔴 자료에 없는 수치 ${s.fabricated.length}건: ${[...new Set(s.fabricated)].join(' · ')}`,
          );
        if (s.countViolation) console.log(`     ⚠️  개수 ${s.countViolation}`);
        if (s.badCategories.length)
          console.log(
            `     ⚠️  enum 밖 카테고리: ${[...new Set(s.badCategories)].join(' · ')}`,
          );
        if (s.stageViolations.length)
          console.log(
            `     ⚠️  stage${stage} 규칙 위반 ${s.stageViolations.length}건: ${[...new Set(s.stageViolations)].join(' · ')}`,
          );
        if (s.filledFollowUps)
          console.log(
            `     ⚠️  follow_ups 를 채운 질문 ${s.filledFollowUps}개 (빈 배열이어야 함)`,
          );
        if (s.companyClaims.length) {
          console.log(
            `     ⚠️  회사 단정문 ${s.companyClaims.length}건 (사람 확인):`,
          );
          for (const t of s.companyClaims.slice(0, 2))
            console.log(`        "${t.slice(0, 88)}"`);
        }
      }
    }

    const sessions = INTERVIEW_GOLDEN_SET.length;
    summary.push({
      model: spec.label,
      fakeLogIds,
      fabricated,
      schema,
      failures,
      claims,
      krwPerSession: krw / sessions,
      secPerSession: ms / sessions / 1000,
    });
  }

  console.log(
    `\n${'='.repeat(70)}\n■ 판정  (가격 싼 순서 — 통과하는 첫 모델 채택)\n`,
  );
  for (const s of summary) {
    const verdict =
      s.failures > 0
        ? `⛔ 실패 ${s.failures}`
        : s.fakeLogIds > 0
          ? `🔴 로그 id 위조 ${s.fakeLogIds}`
          : s.fabricated > 0
            ? `🔴 지어내기 ${s.fabricated}`
            : s.schema > 0
              ? `⚠️ 스키마·규율 ${s.schema}`
              : '✅ 통과';
    // 🔴 판정 한 줄만 찍으면 **먼저 걸린 축이 나머지를 가린다.** 모델 비교가 목적이므로
    //   전 축을 항상 찍는다 (Haiku 가 지어내기로 걸리면 스키마 위반이 안 보였다).
    console.log(
      `   ${s.model.padEnd(20)} ${verdict.padEnd(20)}` +
        ` 지어내기 ${String(s.fabricated).padStart(2)} ·` +
        ` 로그id ${String(s.fakeLogIds).padStart(2)} ·` +
        ` 스키마·규율 ${String(s.schema).padStart(2)} ·` +
        ` 단정문 ${String(s.claims).padStart(2)} ·` +
        ` ${s.krwPerSession.toFixed(1).padStart(5)}원 ·` +
        ` ${s.secPerSession.toFixed(0).padStart(2)}초`,
    );
  }
  console.log(`\n   이번 실행 비용: ${totalKrw.toFixed(0)}원 (캐시 제외)\n`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
