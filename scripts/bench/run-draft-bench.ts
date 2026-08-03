/**
 * 자소서 초안 모델 벤치 — **판정 기준은 하나: 자료에 없는 걸 지어내는가.**
 *
 *   npx ts-node scripts/bench/run-draft-bench.ts
 *
 * ## 왜 기준이 하나인가 (2026-08-03 CEO 결정)
 *
 * 원안은 3일짜리 풀 벤치(골든셋 50 + 교차 judge + 3축 점수)였으나, 판정 규칙에
 * 구멍이 여럿이었다 — 절대 탈락이 너무 엄격해 **둘 다 탈락 가능**, judge 점수 정의 없음,
 * 임계값 분모 불명. 그래서 **가격순으로 세우고 지어내기만 본다** 로 축소했다.
 *
 * 기준이 하나면 가중치도, judge 도, 동률권 처리도 필요 없다 — 그 구멍들이 같이 사라진다.
 *
 * ## 채점 — LLM judge 를 쓰지 않는다
 *
 * judge 를 Claude 로 두면 Claude 출력에 유리하게 채점할 위험이 있다. 그래서 **숫자만
 * 결정적으로** 센다: 결과물의 수치 중 `allowedFacts` 에 없는 것 = 지어냄.
 * 회사 단정문(8/1 사고 유형)은 자동 판정이 어려워 **사람이 볼 목록으로 출력**한다 —
 * 결과가 10건뿐이라 눈으로 확인 가능하다.
 *
 * ## 비용
 *
 * 생성 결과를 파일로 캐시한다. 채점 로직을 고쳐 다시 돌려도 **재생성 안 한다** →
 * 반복 조정이 0원. 호출마다 토큰·비용을 원장에 적고 총액을 출력한다
 * (`llm_call_logs` 는 user_id NOT NULL 이라 유저 없는 벤치 호출을 못 남긴다).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { buildCoverletterContext } from '../../src/applications/coverletter-context-builder';
import {
  MODEL_REGISTRY,
  effectivePricing,
  getModelSpec,
} from '../../src/ai/model-registry';
import { GOLDEN_SET, type GoldenCase } from './golden-set';

const OUT_DIR = join(__dirname, 'results');
const KRW = 1380;
/** 가격이 싼 순서. 이 순서대로 세워 **통과하는 첫 모델**을 고른다 */
const CANDIDATES = ['gpt-5.6-terra', 'claude-sonnet-5'];

interface CallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** 🔴 잘림 감지 — 빈 출력을 "지어내기 0건 = 통과" 로 세면 실패를 통과로 센다 */
  stopReason: string;
  /** Sonnet 5 는 프롬프트가 복잡하면 **우리가 안 켜도** 추론을 켠다 (실측 1,261 토큰) */
  thinkingTokens: number;
}

async function callAnthropic(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<CallResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const j = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${model}: ${JSON.stringify(j).slice(0, 300)}`);
  return {
    text: (j.content ?? []).map((b: any) => b.text ?? '').join(''),
    inputTokens: j.usage?.input_tokens ?? 0,
    outputTokens: j.usage?.output_tokens ?? 0,
    stopReason: j.stop_reason ?? '?',
    thinkingTokens: j.usage?.output_tokens_details?.thinking_tokens ?? 0,
  };
}

async function callOpenAI(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<CallResult> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      // 추론 모델이라 본문 외에 추론 토큰을 쓴다 — cap 이 작으면 본문 없이 400.
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const j = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${model}: ${JSON.stringify(j).slice(0, 300)}`);
  return {
    text: j.choices?.[0]?.message?.content ?? '',
    inputTokens: j.usage?.prompt_tokens ?? 0,
    outputTokens: j.usage?.completion_tokens ?? 0,
    stopReason: j.choices?.[0]?.finish_reason ?? '?',
    thinkingTokens:
      j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

// ── 채점 ────────────────────────────────────────────────────
/**
 * 결과물에서 **검증 대상 수치**를 뽑는다.
 *
 * 열거용 한 자리 숫자("3가지"·"첫 1년")까지 세면 오탐이 쏟아지므로,
 * **단위가 붙은 수치**와 **두 자리 이상**만 본다. 지어내기는 대개 구체적인
 * 성과 수치("75% 개선"·"200명 규모")로 나타난다.
 */
export function extractFigures(text: string): string[] {
  const out = new Set<string>();
  const re =
    // ⚠️ 긴 단위를 먼저 — `개` 가 앞에 있으면 `6개월` 이 `6개` 로 잘려 보고가 틀린다
    /(\d[\d,]*(?:\.\d+)?)\s*(퍼센트|개월|초당|시간|%|원|명|건|배|위|년|주|일|분|초|ms|만|억|천|kg|km|GB|TB|개)/g;
  for (const m of text.matchAll(re)) out.add(`${m[1].replace(/,/g, '')}${m[2]}`);
  // 단위 없는 두 자리 이상 숫자도 후보 (예: "850 으로 줄였다")
  for (const m of text.matchAll(/(?<![\d.])\d{2,}(?![\d.])/g)) out.add(m[0]);
  return [...out];
}

/**
 * 🔴 **파생 수치를 지어내기로 세면 안 된다.**
 *
 * 1차 실행에서 Terra 의 `35분`(=40−5)·`25%`(=85−60)를 지어내기로 잡았는데, 원문은
 * "배포 시간은 **40분에서 5분으로** 단축" 이었다. **자료에 근거한 뺄셈**이다.
 * 4건 중 2건이 오탐이었다 — 이걸 두면 "또 오탐이네" 가 되고 진짜도 같이 넘어간다.
 *
 * 그렇다고 조용히 통과시키지도 않는다. **어떤 계산으로 나왔는지 근거를 붙여** 출력한다.
 */
type Verdict =
  | { kind: 'grounded' }
  | { kind: 'derived'; why: string }
  | { kind: 'fabricated' };

/** '12만' → [12, 120000] 처럼 축약 단위를 펴서 둘 다 후보로 둔다 */
function values(s: string): number[] {
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return [];
  if (/만/.test(s)) return [n, n * 10_000];
  if (/억/.test(s)) return [n, n * 100_000_000];
  return [n];
}

export function classify(figure: string, allowed: string[]): Verdict {
  const fs = values(figure);
  if (!fs.length) return { kind: 'grounded' };
  const pool = allowed.flatMap(values);
  if (fs.some((f) => pool.includes(f))) return { kind: 'grounded' };

  // 자료 값 두 개로 만들 수 있는 정상 계산 — 차이·합·증감률·배수
  for (const a of pool) {
    for (const b of pool) {
      if (a === b) continue;
      const cands: Array<[number, string]> = [
        [Math.abs(a - b), `${a}−${b} 차이`],
        [a + b, `${a}+${b} 합`],
        [a && Math.round((Math.abs(a - b) / a) * 100), `${a}→${b} 증감률(%)`],
        [b && Math.round(a / b), `${a}÷${b} 배수`],
      ];
      for (const [v, why] of cands) {
        if (v && fs.includes(v)) return { kind: 'derived', why };
      }
    }
  }
  return { kind: 'fabricated' };
}

/**
 * 회사에 대한 **단정문** 후보. 8/1 사고가 이 형태였다 —
 * 회사 정보가 없는데 "현대오토에버의 백오피스는 …를 다룹니다" 라고 단언.
 * 헤지 표현이 있으면 제외한다 (그게 원하는 행동이므로).
 */
const HEDGE = /(라고 이해|로 알고|것으로 알|짐작|추정|가정|확인하지 못|알지 못|모르)/;
export function findCompanyClaims(text: string, company: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.includes(company) && !HEDGE.test(s))
    .filter((s) => /(입니다|합니다|한다|이다|다룹|제공|생산|개발|운영)/.test(s));
}

// ── 실행 ────────────────────────────────────────────────────
async function runOne(
  c: GoldenCase,
  model: string,
): Promise<CallResult & { cached: boolean }> {
  const file = join(OUT_DIR, `${c.id}__${model.replace(/[/.]/g, '-')}.json`);
  if (existsSync(file)) {
    return { ...(JSON.parse(readFileSync(file, 'utf8')) as CallResult), cached: true };
  }
  const ctx = buildCoverletterContext(c.input);
  const spec = getModelSpec(model)!;
  // 출력 한도 = 본문 + **추론 몫**.
  // 🔴 1차 실행에서 Sonnet 5 가 예산 1,631 중 1,261 을 추론에 쓰고 본문이 잘렸다.
  //   추론 여유 없이 비교하면 "잘려서 진" 것을 "품질이 나빠 진" 것으로 오독한다.
  const body = c.charLimit * (spec.koreanTokensPerChar ?? 1.1);
  const maxTokens = Math.ceil(body * 1.3) + 4000;
  const r =
    spec.provider === 'anthropic'
      ? await callAnthropic(model, ctx.systemPrompt, ctx.userPrompt, maxTokens)
      : await callOpenAI(model, ctx.systemPrompt, ctx.userPrompt, maxTokens);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(r, null, 2));
  return { ...r, cached: false };
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  let totalKrw = 0;
  const summary: Array<{
    model: string;
    fabricated: number;
    claims: number;
    krw: number;
    failures: number;
  }> = [];

  for (const model of CANDIDATES) {
    const spec = MODEL_REGISTRY[model];
    const price = effectivePricing(spec, today);
    let fabricated = 0;
    let claims = 0;
    let krw = 0;
    let failures = 0;

    console.log(`\n${'='.repeat(64)}\n■ ${spec.label}  (${model})\n${'='.repeat(64)}`);

    for (const c of GOLDEN_SET) {
      const r = await runOne(c, model);
      const cost =
        ((r.inputTokens * price.input + r.outputTokens * price.output) / 1e6) *
        KRW;
      if (!r.cached) krw += cost;

      const figures = extractFigures(r.text);
      const judged = figures.map((f) => ({ f, v: classify(f, c.allowedFacts) }));
      const bad = judged.filter((x) => x.v.kind === 'fabricated');
      const derived = judged.filter((x) => x.v.kind === 'derived');
      // 🔴 잘림·빈 출력은 그 자체로 실패다. 지어낸 수치가 없다고 통과시키면
      //   "아무것도 안 쓴 모델" 이 만점을 받는다.
      const truncated = r.stopReason === 'max_tokens' || r.stopReason === 'length';
      const empty = r.text.trim().length === 0;
      const companyClaims = findCompanyClaims(
        r.text,
        c.input.application.companyName,
      );
      fabricated += bad.length;
      claims += companyClaims.length;
      if (truncated || empty) failures += 1;

      const mark = truncated || empty ? '⛔' : bad.length === 0 ? '✅' : '🔴';
      console.log(
        `\n${mark} ${c.id}  ${c.input.application.companyName} · ${r.text.length}자 ` +
          `(제한 ${c.charLimit})${r.cached ? ' [캐시]' : ''}` +
          (r.thinkingTokens ? ` · 추론 ${r.thinkingTokens}토큰` : ''),
      );
      console.log(`   ${c.probes}`);
      if (truncated || empty)
        console.log(
          `   ⛔ ${empty ? '본문 없음' : '출력 잘림'} (stop=${r.stopReason}) — 지어내기 여부와 무관하게 실패`,
        );
      if (bad.length)
        console.log(
          `   🔴 자료에 없는 수치 ${bad.length}건: ${bad.map((x) => x.f).join(' · ')}`,
        );
      if (derived.length)
        console.log(
          `   ↩︎ 파생 수치 ${derived.length}건 (근거 있음): ` +
            derived
              .map((x) => `${x.f}=${(x.v as { why: string }).why}`)
              .join(' · '),
        );
      if (companyClaims.length) {
        console.log(`   ⚠️  회사 단정문 ${companyClaims.length}건 (사람이 확인):`);
        for (const s of companyClaims.slice(0, 3))
          console.log(`      "${s.slice(0, 90)}"`);
      }
    }

    totalKrw += krw;
    summary.push({ model: spec.label, fabricated, claims, krw, failures });
  }

  console.log(`\n${'='.repeat(64)}\n■ 판정  (가격 싼 순서 — 통과하는 첫 모델 채택)\n`);
  for (const s of summary) {
    const verdict =
      s.failures > 0
        ? `⛔ 잘림·빈출력 ${s.failures}건`
        : s.fabricated === 0
          ? '✅ 통과'
          : `🔴 지어내기 ${s.fabricated}건`;
    console.log(
      `   ${s.model.padEnd(18)} ${verdict.padEnd(22)} 회사 단정문 ${s.claims}건 (사람 확인)`,
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
