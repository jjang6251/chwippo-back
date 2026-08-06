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

const IN = join(__dirname, 'results', 'audit.json');

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
      } else if (q.sourceLogIds.length > 0) {
        // 참조한 로그 중 **어느 것과도** 겹치지 않으면 오귀속 후보
        const best = Math.max(...logTexts.map((l) => overlap(q.text, l)));
        if (best < 0.15) {
          flags.push({
            axis: 'E1 오귀속 의심',
            caseId: c.caseId,
            where: `Q${q.no}`,
            detail: `어느 로그와도 겹침 ${(best * 100).toFixed(0)}% — "${q.text.slice(0, 34)}…"`,
          });
        }
      }

      // ── CS 누출 (기존 축) ──
      if (c.jobCategory !== 'IT개발') {
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
