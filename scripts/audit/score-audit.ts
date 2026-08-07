/**
 * 품질 감사 채점기 (2026-08-07).
 *
 * ## 🔴 이건 판정기가 아니라 **후보 추출기**다
 *
 * 이전 회차에서 내 채점은 전 축 통과였는데 독립 검증에서 심각 5건이 나왔다. 원인은
 * 채점 축이 **기계로 세기 쉬운 것에만** 걸려 있었기 때문이다 (수치 위조·id 실존 여부).
 * 사람이 봐야 하는 것을 기계가 "통과" 로 덮으면 **누락이 초록불로 보인다.**
 *
 * 그래서 이 파일의 출력은 전부 **`FLAG` (사람이 볼 것)** 이고, "문제 없음" 을 뜻하지 않는다.
 * 플래그 0건이어도 그건 "이 패턴으로는 안 걸렸다" 일 뿐이다.
 *
 * ## 축 (E1~E3 은 이번 교차검증에서 놓친 것을 메운 것)
 *
 * - **E1 `source_log_ids` 내용 일치** — 이전엔 id 실존만 봤다. 장애 로깅 질문에
 *   코드리뷰 로그가 달려 있었는데 통과했다.
 * - **E2 인과·동기 지어내기** — 이전엔 수치만 봤다. 성공 사례뿐인 자료에서
 *   없던 오판을 만들어 실패담으로 쓰는 것을 못 잡았다.
 * - **E3 답변 형식 순수성** — 1인칭 발화에 3인칭 코치 문장이 섞이는 것을 아무도 안 봤다.
 * - 기존 축(수치 위조·CS 누출·PII·인젝션·길이·중복)도 함께 돌린다.
 *
 * 실행: `npx ts-node --project tsconfig.json scripts/audit/score-audit.ts`
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { matchJobFork } from '../../src/interview-prep/interview-context-builder';
import {
  filterAttributableLogIds,
  findUnsupportedTechAssertions,
  measureJobPostingCoverage,
} from '../../src/interview-prep/interview-output-guards';

/** 하니스와 같은 규칙으로 세트별 파일을 읽는다 — `score-audit.ts B` */
const ONLY = process.argv[2]?.trim();
const IN = join(__dirname, 'results', ONLY ? `audit-${ONLY}.json` : 'audit.json');

/** 개발 직무가 아닌데 나오면 오답인 표현 */
const CS_TERMS = [
  '자료구조',
  '해시',
  '인덱스',
  '트랜잭션',
  'NoSQL',
  'TCP',
  '프로세스와 스레드',
  '스레드',
  '가상메모리',
];

/**
 * E3 — 답변 본문에 섞이면 안 되는 **3인칭 코치 화법**.
 * 1인칭 면접 발화만 있어야 한다 — 섞이면 사용자가 그것까지 외워서 면접에서 말한다.
 */
const COACH_PATTERNS = [
  /설득력이 (커집니다|높아집니다)/,
  /더하면 좋습니다/,
  /덧붙이면/,
  /답변의 (신뢰도|완성도)/,
  /질문 의도에 (더욱 )?(정확히 )?부합/,
  /실제 면접에서는/,
];

/**
 * E2 — **없던 실패·오판을 창작**했을 때 나오는 표현.
 * 자료에 실패·아쉬움이 전혀 없는데 이런 문장이 나오면 지어냈을 가능성이 높다.
 * 🔴 이것만으로 확정하지 않는다 — 자료를 읽고 판단할 후보를 좁히는 용도다.
 */
const SELF_BLAME = [
  /잘못이었다/,
  /잘못했다/,
  /소홀히/,
  /간과(했|한)/,
  /미흡했/,
  /부족했던 점(은|이)/,
  /실수(였|했)/,
];
/** 자료에 실패 서사가 있는지 판별 (있으면 위 표현이 정상일 수 있다) */
const SOURCE_FAILURE = [
  /실패/,
  /못했/,
  /어려웠/,
  /오류/,
  /폐기/,
  /문제(가|를)/,
  /항의/,
  /장애/,
];
/** 없는 인과를 만들 때 나오는 접속 표현 */
const CAUSAL = [/이를 (개선|보완)하기 위해/, /그래서 .{0,12}(했|시작했)/];

function tokens(s: string): Set<string> {
  return new Set(
    s
      .replace(/[^가-힣a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2),
  );
}
function overlap(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.min(A.size, B.size);
}

interface Flag {
  axis: string;
  caseId: string;
  where: string;
  detail: string;
}

function main(): void {
  const d = JSON.parse(readFileSync(IN, 'utf8')) as {
    cases: Array<Record<string, any>>;
  };
  const flags: Flag[] = [];

  for (const c of d.cases) {
    if (c.error) continue;
    const sourceText = [
      ...c.coverletters.map((x: any) => `${x.question} ${x.answer}`),
      ...c.logs,
      c.jobPostingSummary ?? '',
    ].join(' ');
    const sourceHasFailure = SOURCE_FAILURE.some((r) => r.test(sourceText));
    // 로그 id → 본문. 감사 하니스가 id 를 안 담으므로 순서로 매핑한다
    const logTexts: string[] = c.logs;

    for (const q of c.questions) {
      // ── E1. source_log_ids 내용 일치 ──
      // 일반형 질문에 로그가 전부 달리는 것도 잡는다
      if (q.sourceLogIds.length >= logTexts.length && logTexts.length > 1) {
        flags.push({
          axis: 'E1 참조 남발',
          caseId: c.caseId,
          where: `Q${q.no}`,
          detail: `로그 ${logTexts.length}개 전부 참조 — "${q.text.slice(0, 34)}…"`,
        });
      }
      /**
       * 🔴 **`E1 오귀속 의심` 을 없앴다** (2026-08-07 3회차 심사).
       *
       * 어절 겹침 비율로 보는 자체 로직이라 한국어 조사를 못 벗겼고(`리포트를` ≠ `리포트`),
       * B 세트에서 잡은 2건이 **전부 오탐**이었다 — 질문이 로그 내용 그대로였는데도
       * 겹침이 10%로 계산됐다. 같은 판정을 **G2 가 운영 코드(`filterAttributableLogIds`)로**
       * 하므로, 더 나쁜 사본을 남겨 둘 이유가 없다. 판정 로직을 두 벌 두면 갈라진다.
       */

      /**
       * ── CS 누출 (기존 축) ──
       *
       * 🔴 `jobCategory !== 'IT개발'` 로 보면 **`데이터·AI` 엔지니어가 비개발로 오판**된다
       * (B5 에서 정당한 기술 질문 5건이 전부 위반으로 잡혔다). 운영이 쓰는 fork 판정을
       * 그대로 쓴다 — 직무 판정 로직을 채점기가 따로 갖지 않는다.
       */
      if (matchJobFork(c.jobTitle) !== 'developer') {
        const hit = CS_TERMS.filter((t) => q.text.includes(t));
        if (hit.length) {
          flags.push({
            axis: 'CS 누출',
            caseId: c.caseId,
            where: `Q${q.no}`,
            detail: `${hit.join(',')} — "${q.text.slice(0, 34)}…"`,
          });
        }
      }

      const a: string = q.answer ?? '';
      if (!a || a.startsWith('⛔')) continue;

      // ── E3. 답변 형식 순수성 ──
      for (const r of COACH_PATTERNS) {
        const m = r.exec(a);
        if (m) {
          flags.push({
            axis: 'E3 코치 문장',
            caseId: c.caseId,
            where: `Q${q.no} 답변`,
            detail: `"…${a.slice(Math.max(0, m.index - 24), m.index + 26)}…"`,
          });
          break;
        }
      }

      // ── E2. 없던 실패·인과 창작 ──
      if (!sourceHasFailure) {
        for (const r of SELF_BLAME) {
          const m = r.exec(a);
          if (m) {
            flags.push({
              axis: 'E2 없던 실패 창작 의심',
              caseId: c.caseId,
              where: `Q${q.no} 답변`,
              detail: `자료에 실패 서사 없음인데 — "…${a.slice(Math.max(0, m.index - 20), m.index + 24)}…"`,
            });
            break;
          }
        }
      }
      for (const r of CAUSAL) {
        const m = r.exec(a);
        if (m) {
          flags.push({
            axis: 'E2 인과 연결 확인',
            caseId: c.caseId,
            where: `Q${q.no} 답변`,
            detail: `"…${a.slice(Math.max(0, m.index - 20), m.index + 30)}…"`,
          });
          break;
        }
      }
    }
  }

  /**
   * ── G 축: 런타임 가드가 실제로 잡는지 (2026-08-07 신설) ──
   *
   * 🔴 위 E 축들은 **패턴 매칭**이라 "이 패턴으로는 안 걸림" 을 못 가른다.
   * G 축은 운영 코드가 쓰는 **바로 그 함수**를 감사 결과에 다시 돌린다 — 두 곳이
   * 갈라지면 여기서 드러난다 (측정 로직을 복제하지 않는다).
   */
  for (const c of d.cases) {
    if (c.error) continue;
    const material = [
      ...c.coverletters.map((x: any) => `${x.question} ${x.answer}`),
      ...c.logs,
    ].join(' ');
    /**
     * 🔴 **실제 id ↔ 본문**으로 풀을 만든다. 처음엔 `L0·L1…` 가짜 id 로 만들고
     * "앞에서 N개를 참조했다고 치고" 대조했는데, 그건 측정이 아니라 인공물이었다 —
     * 맞게 단 참조까지 불일치로 세어 13건이 나왔다.
     */
    const ids: string[] = c.logIds ?? [];
    const pool: Array<{ id: string; body: string }> = c.logs.map(
      (body: string, i: number) => ({ id: ids[i] ?? `L${i}`, body }),
    );

    for (const q of c.questions) {
      // G1 — 자료에 없는 기술을 "했다" 고 단정
      for (const tok of findUnsupportedTechAssertions({
        text: q.text,
        userMaterial: material,
      })) {
        flags.push({
          axis: 'G1 자료 밖 기술 단정',
          caseId: c.caseId,
          where: `Q${q.no}`,
          detail: `"${tok}" 가 자료에 없는데 했다고 단정 — "${q.text.slice(0, 40)}…"`,
        });
      }
      const a: string = q.answer ?? '';
      if (a && !a.startsWith('⛔')) {
        for (const tok of findUnsupportedTechAssertions({
          text: a,
          userMaterial: material,
        })) {
          flags.push({
            axis: 'G1 자료 밖 기술 단정',
            caseId: c.caseId,
            where: `Q${q.no} 답변`,
            detail: `"${tok}" 가 자료에 없다`,
          });
        }
      }

      // G2 — 저장된 참조가 **런타임 필터를 통과할 내용인가**.
      //   `logIds` 가 없는 구 회차 데이터는 판정 불가라 건너뛴다 (가짜 매핑 금지)
      if (q.sourceLogIds.length > 0 && pool.length > 1 && ids.length > 0) {
        const kept = filterAttributableLogIds({
          text: [q.text, a].filter(Boolean).join(' '),
          claimedIds: q.sourceLogIds,
          pool,
        });
        if (kept.length < q.sourceLogIds.length) {
          flags.push({
            axis: 'G2 내용 일치 실패',
            caseId: c.caseId,
            where: `Q${q.no}`,
            detail: `참조 ${q.sourceLogIds.length}건 중 ${q.sourceLogIds.length - kept.length}건이 내용 불일치 — "${q.text.slice(0, 34)}…"`,
          });
        }
      }
    }

    // G3 — 공고 요건 커버리지 (측정 전용)
    const reqs: string[] = c.jobPostingRequirements ?? [];
    if (reqs.length > 0) {
      const cov = measureJobPostingCoverage(
        c.questions.map((q: any) => q.text),
        reqs,
      );
      const missed = cov.filter((r) => !r.covered);
      if (missed.length > 0) {
        flags.push({
          axis: 'G3 공고 요건 미커버',
          caseId: c.caseId,
          where: `${cov.length - missed.length}/${cov.length} 커버`,
          detail: missed.map((m) => m.requirement).join(' · '),
        });
      }
    }
  }

  // ── 출력 ──
  const byAxis = new Map<string, Flag[]>();
  for (const f of flags) {
    if (!byAxis.has(f.axis)) byAxis.set(f.axis, []);
    byAxis.get(f.axis)!.push(f);
  }
  console.log(`\n${'='.repeat(74)}`);
  console.log('품질 감사 — 사람이 볼 후보 (판정 아님)');
  console.log('='.repeat(74));
  if (flags.length === 0) {
    console.log('\n플래그 0건.');
  }
  for (const [axis, list] of [...byAxis.entries()].sort()) {
    console.log(`\n▶ ${axis} — ${list.length}건`);
    for (const f of list) {
      console.log(`   [${f.caseId} ${f.where}] ${f.detail}`);
    }
  }
  console.log(
    `\n총 ${flags.length}건. 🔴 **0건은 "문제 없음" 이 아니라 "이 패턴으로는 안 걸림" 이다.**\n` +
      `   판단이 필요한 축(자소서 이탈·엉뚱함·어투)은 사람이 읽어야 한다.`,
  );
}

main();
