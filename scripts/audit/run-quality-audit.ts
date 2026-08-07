/**
 * 면접 질문·답변 품질 감사 하니스 (2026-08-07).
 *
 * ## 기존 벤치와 무엇이 다른가
 *
 * `scripts/bench/*` 는 **모델 선정용**이라 OpenAI 를 직접 호출한다 (래퍼를 빼고 모델만 격리).
 * 이건 **출시된 기능의 품질 감사**라 반대로 **프로덕션 경로를 그대로 탄다**:
 *
 * - `NestFactory.createApplicationContext` 로 DI 컨테이너만 띄운다 (HTTP 서버 없이)
 * - `InterviewPrepAiService` → `LlmService` → provider — PII 스크럽·재시도·응답 검증 포함
 * - 모델은 `feature_model_config` **DB 값**을 읽는다 (코드 기본값이 아니라)
 * - 질문을 **DB 에 저장**하고 `InterviewPrepQuestionsService` 로 **다시 읽어** 검사한다
 *   → 생성뿐 아니라 저장·응답 매핑까지 한 번에 본다 (오늘 `category` 누락이 그 구간이었다)
 * - `llm_call_logs` 에 토큰·비용이 남으므로 **실측 비용**을 리포트에 담을 수 있다
 *
 * 대신 **코인·쿼터가 실제로 소모**된다. 그래서 전용 벤치 유저를 쓴다.
 *
 * 실행: `npx ts-node scripts/audit/run-quality-audit.ts`
 */
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../../src/app.module';
import { InterviewPrepAiService } from '../../src/interview-prep/interview-prep-ai.service';
import { InterviewPrepQuestionsService } from '../../src/interview-prep/interview-prep-questions.service';
import { AUDIT_CASES, type AuditCase } from './fixtures';

/** 전용 벤치 유저 — CEO 계정의 코인·데이터를 건드리지 않는다 */
const BENCH_USER_ID = '00000000-0000-4000-8000-0000000a0d17';
const BENCH_NICKNAME = '품질감사봇';
const OUT_DIR = join(__dirname, 'results');
const KRW = 1380;

/** 케이스당 답변을 만들 질문 수 (앞에서부터) */
const ANSWERS_PER_CASE = 5;

interface CaseResult {
  caseId: string;
  probes: string;
  companyName: string;
  jobTitle: string;
  jobCategory: string;
  interviewType: string;
  sessionId: string;
  coverletters: AuditCase['coverletters'];
  logs: string[];
  allowedFacts: string[];
  jobPostingSummary: string | null;
  /** 공고 요건 **줄 단위** — 커버리지 측정용 (요약 한 덩어리로는 셀 수 없다) */
  jobPostingRequirements: string[];
  /**
   * 시딩한 활동 로그의 **실제 id** — `logs` 와 같은 순서.
   *
   * 🔴 이게 없으면 `sourceLogIds` 가 **어느 로그를 가리키는지 알 수 없다.** 처음엔
   * "앞에서 N개를 참조했다고 치고" 대조했는데, 그건 측정이 아니라 인공물이었다
   * (실제로 맞게 단 참조까지 불일치로 나왔다).
   */
  logIds: string[];
  /**
   * 🔴 boolean 만 담았더니 **그 축의 판정이 불가능**했다 (2026-08-07 교차검증 지적).
   * "조사 자료를 인용하는가 / 자료 밖으로 나가는가" 를 보려면 대조군이 있어야 한다.
   * 6케이스 중 유일하게 조사가 있는 케이스였는데 그 probe 가 통째로 무효였다.
   */
  companyResearch: Record<string, unknown> | null;
  questions: Array<{
    id: string;
    no: number;
    category: string | null;
    mustPrepare: boolean;
    text: string;
    sourceLogIds: string[];
    answer: string | null;
    /** 자료 부족 사유 (v2.2) — 담지 않으면 "0건" 이 "안 쓰였다" 로 잘못 읽힌다 */
    materialGap: string | null;
    followups: Array<{ text: string; basis: string | null }>;
  }>;
  error?: string;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const startedAt = new Date();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const ds = app.get(DataSource);
  const ai = app.get(InterviewPrepAiService);
  const questionsService = app.get(InterviewPrepQuestionsService);

  // ── 1. 벤치 유저 (idempotent) ──
  await ds.query(
    // `ck_users_identity_provider` — kakao_id 또는 apple_sub 중 하나는 있어야 한다.
    // 벤치 전용 가상 kakao_id 를 쓴다 (실제 카카오 계정과 겹치지 않는 음수 대역).
    `INSERT INTO users (id, nickname, role, tier, kakao_id, ai_consent_at, ai_consent_version)
     VALUES ($1, $2, 'user', 'free', 'bench-audit-bot', NOW(),
             (SELECT COALESCE(MAX(ai_consent_version), 'v1') FROM users WHERE ai_consent_version IS NOT NULL))
     ON CONFLICT (id) DO UPDATE SET ai_consent_at = NOW()`,
    [BENCH_USER_ID, BENCH_NICKNAME],
  );
  await ds.query(
    `INSERT INTO user_coin_balances (user_id, tier, balance, next_reset_at)
     VALUES ($1, 'free', 100000, NOW() + INTERVAL '30 days')
     ON CONFLICT (user_id) DO UPDATE SET balance = 100000`,
    [BENCH_USER_ID],
  );
  // 직전 회차 잔재 제거 — 케이스가 누적되면 비용 집계가 어긋난다
  await ds.query(
    `DELETE FROM applications WHERE user_id = $1`,
    [BENCH_USER_ID],
  );
  await ds.query(`DELETE FROM activities WHERE user_id = $1`, [BENCH_USER_ID]);

  const results: CaseResult[] = [];

  /**
   * 케이스 선택 — `npx ts-node … run-quality-audit.ts B` 처럼 접두사를 넘긴다.
   *
   * 🔴 **12개를 매번 다 돌리면 안 된다.** 케이스당 약 11원이라 전량이 ~130원이고,
   * 더 중요한 건 **A 세트로는 이제 판정이 안 된다**는 것이다 — 프롬프트가 A 의 실패
   * 문장을 실명으로 인용하고 있어 답을 본 시험이다. 판정은 B, 회귀 확인만 A 로 한다.
   * 인자 없으면 전량 (릴리즈 전 1회용).
   */
  const only = process.argv[2]?.trim();
  const cases = only
    ? AUDIT_CASES.filter((c) => c.id.startsWith(only))
    : AUDIT_CASES;
  if (cases.length === 0) {
    throw new Error(
      `"${only}" 로 시작하는 케이스가 없다. 있는 것: ${AUDIT_CASES.map((c) => c.id).join(', ')}`,
    );
  }
  console.log(
    `대상 ${cases.length}/${AUDIT_CASES.length} 케이스 — ${cases.map((c) => c.id).join(', ')}`,
  );

  for (const c of cases) {
    console.log(`\n▶ ${c.id} — ${c.companyName} · ${c.jobTitle}`);
    try {
      // ── 2. 시딩 ──
      const [appRow] = (await ds.query(
        `INSERT INTO applications (user_id, company_name, job_title, job_category, status, job_posting)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5) RETURNING id`,
        [
          BENCH_USER_ID,
          c.companyName,
          c.jobTitle,
          c.jobCategory,
          c.jobPosting ? JSON.stringify(c.jobPosting) : null,
        ],
      )) as Array<{ id: string }>;
      const applicationId = appRow.id;

      const clIds: string[] = [];
      for (const cl of c.coverletters) {
        const [row] = (await ds.query(
          `INSERT INTO application_coverletters (application_id, category, question, answer, char_limit)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [applicationId, cl.category, cl.question, cl.answer, cl.charLimit],
        )) as Array<{ id: string }>;
        clIds.push(row.id);
      }

      const [act] = (await ds.query(
        `INSERT INTO activities (user_id, name) VALUES ($1, $2) RETURNING id`,
        [BENCH_USER_ID, `${c.companyName} 준비`],
      )) as Array<{ id: string }>;
      const logIds: string[] = [];
      for (const body of c.logs) {
        const [row] = (await ds.query(
          `INSERT INTO activity_logs (activity_id, user_id, content, occurred_at)
           VALUES ($1, $2, $3, '2026-05-01') RETURNING id`,
          [act.id, BENCH_USER_ID, body],
        )) as Array<{ id: string }>;
        logIds.push(row.id);
      }

      if (c.companyResearch) {
        await ds.query(
          `INSERT INTO company_research_cache
             (company_name, job_category, ai_research, sources, expires_at)
           VALUES ($1, $2, $3::jsonb, '{}', NOW() + INTERVAL '180 days')
           ON CONFLICT DO NOTHING`,
          [c.companyName, c.jobCategory, JSON.stringify(c.companyResearch)],
        );
      }

      const [sess] = (await ds.query(
        `INSERT INTO interview_prep_sessions
           (user_id, application_id, round, interview_type, coverletter_ids, extra_log_ids)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING id`,
        [
          BENCH_USER_ID,
          applicationId,
          c.round,
          c.interviewType,
          JSON.stringify(clIds),
          JSON.stringify(logIds),
        ],
      )) as Array<{ id: string }>;

      // ── 3. 질문 생성 (프로덕션 경로) ──
      const gen = await ai.generateSession(BENCH_USER_ID, sess.id);
      if (gen.status !== 'ok') {
        throw new Error(`질문 생성 blocked: ${gen.reason ?? ''}`);
      }
      const tree = await questionsService.listTreeBySession(
        BENCH_USER_ID,
        sess.id,
      );
      console.log(`   질문 ${tree.length}개`);

      // ── 4. 답변 생성 (앞 N개) ──
      const questions: CaseResult['questions'] = [];
      for (let i = 0; i < tree.length; i++) {
        const q = tree[i];
        let answer: string | null = null;
        /**
         * 🔴 **답변 생성이 질문 행을 갱신한다.** `tree` 는 답변 생성 **전** 스냅샷이라
         * `materialGap`·`sourceLogIds` 를 여기서 읽으면 **항상 답변 이전 값**이다.
         * 실제로 DB 엔 gap 11건이 있는데 리포트엔 0건으로 찍혀 "회귀" 로 오독했다.
         * 생성 결과(`r.question`)가 있으면 그걸 우선한다.
         */
        let after: typeof q | null = null;
        if (i < ANSWERS_PER_CASE) {
          const r = await ai.generateAnswer(BENCH_USER_ID, q.id);
          answer =
            r.status === 'ok'
              ? (r.question?.suggestedAnswer ?? null)
              : `⛔ ${r.reason ?? 'blocked'}`;
          if (r.status === 'ok' && r.question) after = r.question;
        }
        questions.push({
          id: q.id,
          no: i + 1,
          category: q.category,
          mustPrepare: q.mustPrepare,
          text: q.questionText,
          sourceLogIds: after?.sourceLogIds ?? q.sourceLogIds,
          materialGap: after?.materialGap ?? q.materialGap,
          answer,
          followups: [],
        });
      }
      console.log(`   답변 ${Math.min(ANSWERS_PER_CASE, tree.length)}개`);

      // ── 5. 꼬리질문 — 답변 있는 것 2개 + 답변 없는 것 1개 (3경로 비교) ──
      const followupTargets = [questions[0], questions[1], questions[tree.length - 1]].filter(
        Boolean,
      );
      for (const target of followupTargets) {
        const r = await ai.generateFollowup(BENCH_USER_ID, target.id);
        if (r.status === 'ok' && r.question) {
          target.followups.push({
            text: r.question.questionText,
            basis: r.question.followupBasis,
          });
        }
      }
      console.log(`   꼬리질문 ${followupTargets.length}개`);

      results.push({
        caseId: c.id,
        probes: c.probes,
        companyName: c.companyName,
        jobTitle: c.jobTitle,
        jobCategory: c.jobCategory,
        interviewType: c.interviewType,
        sessionId: sess.id,
        coverletters: c.coverletters,
        logs: c.logs,
        allowedFacts: c.allowedFacts,
        jobPostingSummary: c.jobPosting
          ? [
              c.jobPosting.responsibilities,
              ...c.jobPosting.requirements,
              ...c.jobPosting.preferred,
              ...c.jobPosting.qualifications,
            ]
              .filter(Boolean)
              .join(' · ')
          : null,
        // 🔴 요건을 **줄 단위로** 따로 담는다 — 위 요약은 ' · ' 로 이어 붙인 한 덩어리라
        //    "6요건 중 몇 개가 질문에 반영됐나" 를 셀 수 없다 (Kafka 0건을 못 잡은 이유)
        logIds,
        jobPostingRequirements: c.jobPosting
          ? [
              ...c.jobPosting.requirements,
              ...c.jobPosting.preferred,
              ...c.jobPosting.qualifications,
            ].filter(Boolean)
          : [],
        companyResearch: c.companyResearch,
        questions,
      });
    } catch (e) {
      console.log(`   실패: ${(e as Error).message.slice(0, 200)}`);
      results.push({
        caseId: c.id,
        probes: c.probes,
        companyName: c.companyName,
        jobTitle: c.jobTitle,
        jobCategory: c.jobCategory,
        interviewType: c.interviewType,
        sessionId: '',
        coverletters: c.coverletters,
        logs: c.logs,
        allowedFacts: c.allowedFacts,
        jobPostingSummary: null,
        jobPostingRequirements: [],
        logIds: [],
        companyResearch: c.companyResearch,
        questions: [],
        error: (e as Error).message,
      });
    }
  }

  // ── 6. 실측 비용 — llm_call_logs 에서 이번 회차만 집계 ──
  const usage = (await ds.query(
    `SELECT feature, model, COUNT(*)::int AS calls,
            SUM(prompt_tokens)::int AS in_tokens,
            SUM(completion_tokens)::int AS out_tokens,
            SUM(cost_usd)::numeric AS cost_usd
     FROM llm_call_logs
     WHERE user_id = $1 AND created_at >= $2
     GROUP BY feature, model ORDER BY 6 DESC`,
    [BENCH_USER_ID, startedAt],
  )) as Array<Record<string, unknown>>;

  const payload = {
    ranAt: startedAt.toISOString(),
    krwPerUsd: KRW,
    usage,
    cases: results,
  };
  /**
   * 🔴 **세트별로 파일을 나눈다.** 하나로 덮어쓰면 B 를 돌리는 순간 A 결과가 날아가
   * 비교가 불가능해진다 (회귀 방어용으로 남기는 의미가 사라진다).
   */
  const out = join(OUT_DIR, only ? `audit-${only}.json` : 'audit.json');
  writeFileSync(out, JSON.stringify(payload, null, 2));

  console.log(`\n${'='.repeat(70)}\n실측 사용량\n${'='.repeat(70)}`);
  for (const u of usage) {
    const usd = Number(u.cost_usd ?? 0);
    console.log(
      `${String(u.feature).padEnd(24)}${String(u.model).padEnd(16)}` +
        `${String(u.calls).padStart(3)}회  in ${String(u.in_tokens).padStart(7)}  ` +
        `out ${String(u.out_tokens).padStart(6)}  ${(usd * KRW).toFixed(1)}원`,
    );
  }
  console.log(`\n저장: ${out}`);
  await app.close();
}

void main();
