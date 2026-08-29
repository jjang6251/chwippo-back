/* eslint-disable no-console */
/**
 * 공고 형태별 실모델 스윕 — 운영과 같은 프롬프트(`job-posting-card.prompt.ts`) + 서버 규칙(`rules.ts`) 을
 * 실제 gpt-4o-mini 에 태워 draft 까지 만든다. HTTP·DB 는 안 탄다 (그건 sweep-http 가 한다).
 *
 * 실행: cd chwippo-back && set -a && source .env && set +a && npx ts-node -r tsconfig-paths/register scripts/posting-sweep.ts scripts/posting-sweep.fixtures.json /tmp/sweep.json
 *
 * 픽스처 30종(`posting-sweep.fixtures.json`)은 2026-08-30 스윕 그대로 — 사람인 표·상시·영문·공기업 다직무·병원·항공 인턴·
 * JD 첨부·공무원·연도 넘김·한글 시각·24:00·접수 2회차·전환형 인턴·뉴스·스팸·프롬프트 인젝션·잘림·한 줄·이모지·
 * 직무별 마감 표·학년도·전부 애매·지난 공고·헤드헌터·주식회사·8,000자·회사 둘·날짜 먼저. 프롬프트나 날짜 규칙을
 * 고치면 이걸 돌려 30줄을 눈으로 대조한다 (1회 ≈ 8만 토큰). 기대값은 각 픽스처의 `expect` 문장.
 * 🔴 이 하네스는 LlmService 의 스키마 가드를 거치지 않는다 — 가드까지 보려면 로컬 백엔드에 실제 HTTP 를 쏜다.
 */
import OpenAI from 'openai';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCardSystemPrompt, CARD_SCHEMA } from '../src/applications/job-posting-card.prompt';
import { buildDraft, normalizeCardOutput } from '../src/applications/job-posting-card.rules';
import { todayKst } from '../src/common/datetime';

const MODEL = process.env.OPENAI_MODEL_LIGHT ?? 'gpt-4o-mini';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });

interface Fixture { id: string; name: string; expect: string; text: string; jobContext?: string }

const LONG_BENEFITS = [
  '■ 복리후생',
  '- 4대 보험, 퇴직연금(DC), 종합건강검진(본인+배우자), 단체 상해보험',
  '- 자녀 학자금(고교·대학), 경조사비 및 경조 휴가, 장기근속 포상(5/10/20년)',
  '- 사내 카페테리아 3식 제공, 사내 피트니스, 심리상담(EAP), 안식휴가(3년마다 2주)',
  '- 자기계발비 연 120만원, 도서 구입비, 어학·자격증 응시료 지원, 사내 스터디 지원금',
  '- 주택자금 대출 이자 지원, 통근버스(수도권 12개 노선), 주차 지원, 임직원 할인몰',
  '- 유연근무제(코어타임 11~16시), 재택 주 2회, 리프레시 휴가, 생일 반차',
].join('\n');

function inflate(f: Fixture): Fixture {
  if (f.text !== 'LONG_PLACEHOLDER') return f;
  const head =
    '한화시스템 2026 하반기 신입·경력 채용 — 시스템 SW 개발\n\n' +
    '모집분야: 시스템 SW 개발 (임베디드/방산)\n담당업무: 레이더·통신 체계 임베디드 SW 설계 및 검증\n' +
    '자격요건: 컴퓨터/전자 전공 학사 이상, C/C++ 능숙\n우대: 방산 프로젝트 경험, RTOS, DO-178C\n\n' +
    '접수기간: 2026.09.08(월) ~ 2026.09.21(일) 23:59\n전형절차: 서류전형 → 인적성검사(10/4) → 1차 면접(10월 중순) → 2차 면접 → 최종합격(11월 말)\n\n';
  let body = '';
  while ((head + body).length < 7_800) body += LONG_BENEFITS + '\n\n■ 근무 환경\n- 판교 R&D 센터, 사내 어린이집, 통근버스\n\n';
  return { ...f, text: head + body + '\n문의: 인재개발팀 recruit@hanwha.example' };
}

async function callModel(system: string, user: string) {
  const t0 = Date.now();
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_completion_tokens: 1_000,
    temperature: 0.1,
    response_format: {
      type: 'json_schema',
      json_schema: { name: CARD_SCHEMA.name, schema: CARD_SCHEMA.schema, strict: true },
    },
  });
  const choice = res.choices[0];
  return {
    text: choice.message.content ?? '',
    finish: choice.finish_reason,
    usage: res.usage,
    ms: Date.now() - t0,
  };
}

async function run(f: Fixture, jobContext: string | null) {
  const today = todayKst();
  const ctxBlock = jobContext ? `# 지원 직무 (이 직무 요건·일정만 추출)\n${jobContext}\n\n` : '';
  const userPrompt = `${ctxBlock}# 파싱할 공고 텍스트\n\`\`\`\n${f.text}\n\`\`\``;
  const r = await callModel(buildCardSystemPrompt(today), userPrompt);
  let json: unknown = undefined;
  try {
    json = JSON.parse(r.text);
  } catch {
    /* 파싱 실패는 raw 로 남긴다 */
  }
  const out = normalizeCardOutput(json);
  const draft = buildDraft({ out, todayKst: today, jobContext, profileJobTitle: null });
  return { raw: json, out, draft, finish: r.finish, usage: r.usage, ms: r.ms };
}

(async () => {
  const [, , fixturesPath, outPath] = process.argv;
  const fixtures = (JSON.parse(readFileSync(fixturesPath, 'utf8')) as Fixture[]).map(inflate);
  const results: Record<string, unknown>[] = [];
  for (const f of fixtures) {
    const r1 = await run(f, null);
    const row: Record<string, unknown> = { id: f.id, name: f.name, expect: f.expect, chars: f.text.length, pass1: r1 };
    if (f.jobContext) row.pass2 = await run(f, f.jobContext);
    results.push(row);
    const d = r1.draft;
    console.log(
      `${f.id} | ${d.notPosting ? 'NOT_POSTING' : d.companyName ?? '(회사?)'} | job=${d.jobTitle ?? (d.jobTitles.length ? `?${d.jobTitles.length}` : '-')} | dl=${d.deadline ?? '-'}(${d.deadlineKind}) | steps=${d.steps.map((s) => `${s.name}${s.date ? '@' + s.date : s.dateHint ? '(' + s.dateHint + ')' : ''}`).join(' > ')} | extra=${d.extraDates.map((e) => `${e.label}@${e.date}`).join(',') || '-'} | ${r1.usage?.total_tokens}tok ${r1.ms}ms ${r1.finish}`,
    );
  }
  writeFileSync(outPath, JSON.stringify(results, null, 1));
})();
