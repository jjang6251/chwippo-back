/**
 * 직무 fork 품질 벤치 (2026-08-07).
 *
 * ## 무엇을 재는가
 *
 * fork 를 5종 → 10종으로 늘렸다. 프롬프트가 달라진 건 확인했지만, **모델이 그 지시를
 * 따르는지**는 돌려봐야 안다. 두 축이다:
 *
 * 1. 🔴 **금지선 (off-domain)** — 연구·재무·제조·경영지원·서비스 직군에
 *    CS 지식(자료구조·인덱스·TCP·프로세스/스레드)을 묻는가.
 *    이건 "덜 좋은 질문" 이 아니라 **명백한 오답**이다. 1건이라도 나오면 실패다.
 * 2. **직무 지식 커버리지 (on-domain)** — fork 가이드에 적은 단골 주제가 실제로
 *    나타나는가. 안 나오면 가이드가 장식이라는 뜻이다.
 *
 * 보조로 **공통 정형 질문 비중**도 센다 — 직무 질문 자리를 공통 질문이 다 먹으면
 * fork 를 늘린 의미가 없다.
 *
 * ## 왜 프로덕션 빌더를 그대로 쓰는가
 *
 * 프롬프트를 벤치가 따로 만들면 **실제와 다른 것을 채점**하게 된다 (골든셋의
 * `interviewType: '실무 면접'` 이 그 사례였다 — 한글이라 종류 지시가 통째로 빠진 채
 * 돌고 있었다). `buildInterviewContext` 를 그대로 호출한다.
 *
 * 실행: `OPENAI_API_KEY=... npx ts-node scripts/bench/run-jobfork-bench.ts`
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  buildInterviewContext,
  matchJobFork,
  resolveJobFork,
} from '../../src/interview-prep/interview-context-builder';
import { SESSION_JSON_SCHEMA } from '../../src/interview-prep/interview-prep-ai.service';
import {
  INTERVIEW_GOLDEN_SET,
  JOB_FORK_CASES,
  type InterviewGoldenCase,
} from './interview-golden-set';

const MODEL = 'gpt-5.6-luna';
const MAX_OUTPUT_TOKENS = 4_000;
const OUT_DIR = join(__dirname, 'results-jobfork');
const KRW = 1380;
/** gpt-5.6-luna 단가 (USD / 1M tokens) */
const PRICE = { input: 0.15, output: 0.6 };

interface Q {
  category?: string;
  question: string;
  must_prepare?: boolean;
  source_log_ids: string[];
}

/**
 * 🔴 **개발 직무가 아닌데 나오면 오답인 표현.**
 * 실제 사고가 이거였다 — `R&D·연구개발` 이 `/개발/` 에 걸려 바이오 연구원이
 * 자료구조·TCP 질문을 받았다.
 */
const CS_TERMS = [
  '자료구조',
  '해시',
  '링크드리스트',
  '이진 트리',
  '인덱스',
  '트랜잭션',
  'RDB',
  'NoSQL',
  'TCP',
  'HTTP',
  '프로세스와 스레드',
  '스레드',
  '가상메모리',
  '스케줄러',
  '캐시 무효화',
  'API 설계',
  '동시성 제어',
];

/** fork 별 "이건 나와야 한다" 는 직무 지식 키워드 (하나라도 걸리면 커버로 센다) */
const ON_DOMAIN: Record<string, string[]> = {
  finance: ['재무제표', '손익', '현금흐름', '감가상각', '금리', '환율', '리스크', '밸류에이션', '회계', '세무', '재고자산'],
  research: ['실험', '대조군', '가설', '논문', '재현', '임상', 'GMP', 'GLP', '인허가', '규제', '데이터 해석'],
  manufacturing: ['공정', '불량', '수율', '품질', '4M', '5Why', '원가', '재고', '리드타임', '안전', '교대'],
  corporate: ['근로기준법', '노동', '노무', '채용', '규정', '내부통제', '개인정보', '이해관계자', '조율', '인사'],
  service: ['고객', '응대', '클레임', '불만', '안전', '응급', '감정', 'CS', 'NPS', '서비스 품질'],
  developer: ['자료구조', '인덱스', 'TCP', '스레드', '장애', '트래픽', '설계'],
  marketer: ['ROAS', 'CPA', '전환율', '지표', '캠페인', '가설'],
  designer: ['사용자 리서치', '페르소나', '프로토타입', '의사결정', '디자인'],
  planner: ['시장', 'KPI', '지표', '비즈니스', '우선순위'],
  sales: ['고객', '실적', '목표', '거절', '제안'],
};

/** 공통 정형 질문 카테고리 — 직무 질문 자리를 얼마나 먹는지 보는 용도 */
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
      max_completion_tokens: MAX_OUTPUT_TOKENS,
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
  if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 400));
  const text = j.choices?.[0]?.message?.content ?? '';
  let questions: Q[] = [];
  try {
    questions = (JSON.parse(text) as { questions?: Q[] }).questions ?? [];
  } catch {
    /* 잘림 */
  }
  return {
    questions,
    inputTokens: j.usage?.prompt_tokens ?? 0,
    outputTokens: j.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - started,
    finish: j.choices?.[0]?.finish_reason ?? '?',
  };
}

interface Row {
  id: string;
  jobCategory: string;
  fork: string;
  total: number;
  offDomain: string[];
  onDomainHits: string[];
  commonCount: number;
  jobCount: number;
  mustCount: number;
  mustCats: string[];
  costKrw: number;
  latencyMs: number;
  questions: Q[];
}

async function run(c: InterviewGoldenCase): Promise<Row> {
  const ctx = buildInterviewContext(c.input);
  const fork = resolveJobFork(c.input.application) ?? 'none';
  const r = await call(ctx.systemPrompt, ctx.userPrompt);

  const joined = r.questions.map((q) => q.question).join(' ');
  // 개발 직무가 아닌 fork 에서만 CS 용어를 위반으로 센다
  const offDomain =
    fork === 'developer'
      ? []
      : CS_TERMS.filter((t) => joined.includes(t));
  const onDomainHits = (ON_DOMAIN[fork] ?? []).filter((t) =>
    joined.includes(t),
  );
  const commonCount = r.questions.filter((q) =>
    COMMON_CATS.has(q.category ?? ''),
  ).length;

  const costUsd =
    (r.inputTokens / 1e6) * PRICE.input + (r.outputTokens / 1e6) * PRICE.output;

  const musts = r.questions.filter((q) => q.must_prepare === true);
  return {
    id: c.id,
    jobCategory: c.input.application.jobCategory ?? '(없음)',
    fork,
    total: r.questions.length,
    offDomain,
    onDomainHits,
    commonCount,
    jobCount: r.questions.length - commonCount,
    mustCount: musts.length,
    mustCats: musts.map((q) => q.category ?? '?'),
    costKrw: costUsd * KRW,
    latencyMs: r.latencyMs,
    questions: r.questions,
  };
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY 가 없습니다.');
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const cases = [...JOB_FORK_CASES, ...INTERVIEW_GOLDEN_SET];
  console.log(`\n직무 fork 벤치 — ${MODEL} · ${cases.length} 케이스\n`);

  // fork 매칭은 호출 전에 확인 (틀렸으면 돌릴 이유가 없다)
  console.log('── fork 매칭 ──');
  for (const c of cases) {
    const jc = c.input.application.jobCategory;
    console.log(
      `  ${String(matchJobFork(jc) ?? '없음').padEnd(14)}${jc ?? '(없음)'}  [${c.id}]`,
    );
  }

  const rows: Row[] = [];
  for (const c of cases) {
    process.stdout.write(`\n▶ ${c.id} (${c.input.application.jobCategory}) … `);
    try {
      const row = await run(c);
      rows.push(row);
      console.log(
        `${row.total}문항 · ${row.latencyMs}ms · ${row.costKrw.toFixed(2)}원`,
      );
    } catch (e) {
      console.log(`실패: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  console.log(`\n${'='.repeat(78)}\n결과\n${'='.repeat(78)}`);
  console.log(
    `${'케이스'.padEnd(18)}${'fork'.padEnd(15)}${'문항'.padEnd(6)}${'직무/공통'.padEnd(11)}${'금지선'.padEnd(8)}${'우선'.padEnd(7)}직무지식`,
  );
  for (const r of rows) {
    const off = r.offDomain.length === 0 ? '✅ 0' : `❌ ${r.offDomain.length}`;
    console.log(
      `${r.id.padEnd(18)}${r.fork.padEnd(15)}${String(r.total).padEnd(6)}` +
        `${`${r.jobCount}/${r.commonCount}`.padEnd(11)}${off.padEnd(8)}` +
        `${(r.mustCount >= 5 && r.mustCount <= 7 ? `✅ ${r.mustCount}` : `⚠️ ${r.mustCount}`).padEnd(7)}` +
        `${r.onDomainHits.length}종 ${r.onDomainHits.slice(0, 4).join('·')}`,
    );
  }

  const violations = rows.filter((r) => r.offDomain.length > 0);
  console.log(
    `\n금지선 위반 케이스: ${violations.length} / ${rows.length}` +
      (violations.length
        ? `\n  ${violations.map((v) => `${v.id}: ${v.offDomain.join(', ')}`).join('\n  ')}`
        : ' ✅'),
  );
  // 🔴 개수 상한은 **프롬프트로만** 눌린다 (스키마로는 못 막는다) — 실측이 유일한 확인 수단
  const outOfRange = rows.filter((r) => r.mustCount < 5 || r.mustCount > 7);
  console.log(
    `우선 표시 5~7개 준수: ${rows.length - outOfRange.length} / ${rows.length}` +
      (outOfRange.length
        ? `\n  ${outOfRange.map((v) => `${v.id}: ${v.mustCount}개`).join('\n  ')}`
        : ' ✅'),
  );
  const totalKrw = rows.reduce((a, r) => a + r.costKrw, 0);
  console.log(`총 원가: ${totalKrw.toFixed(1)}원`);

  const stamp = process.env.BENCH_STAMP ?? 'run';
  const out = join(OUT_DIR, `jobfork-${stamp}.json`);
  writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`\n저장: ${out}`);
}

void main();
