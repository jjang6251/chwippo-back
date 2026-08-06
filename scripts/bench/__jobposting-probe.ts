/**
 * 공고 요건(특히 자격증)이 질문에 어떻게 반영되는지 관측용 1회 프로브.
 * "요건에 있으니 갖고 있다고 단정" 하거나 "자격증 있나요" 류 무의미 질문이 나오는지 본다.
 */
import { buildInterviewContext } from '../../src/interview-prep/interview-context-builder';
import { SESSION_JSON_SCHEMA } from '../../src/interview-prep/interview-prep-ai.service';
import { INTERVIEW_GOLDEN_SET } from './interview-golden-set';

const base = INTERVIEW_GOLDEN_SET[0]; // 현대오토에버 · 백엔드 · 로그 3건

const input = {
  ...base.input,
  jobPosting: {
    responsibilities: '차량 관제 백엔드 API 개발 및 운영',
    requirements: ['Java/Spring 기반 서버 개발 경험', 'RDB 설계 경험'],
    preferred: ['MSA 경험', 'Kafka 등 메시지 큐 경험', '클라우드(AWS) 운영 경험'],
    techStack: ['Java', 'Spring Boot', 'MySQL', 'Kafka', 'AWS'],
    // 🔴 관측 대상 — 사용자 자료에는 **자격증·어학 언급이 전혀 없다**
    qualifications: ['정보처리기사', 'AWS SAA', 'TOEIC 800 이상', 'SQLD'],
    keywords: ['대용량 트래픽', '실시간 관제'],
    parsedAt: '2026-08-01T00:00:00Z',
  },
};

async function main() {
  const ctx = buildInterviewContext(input);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      max_completion_tokens: 4000,
      messages: [
        { role: 'system', content: ctx.systemPrompt },
        { role: 'user', content: ctx.userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: SESSION_JSON_SCHEMA.name, schema: SESSION_JSON_SCHEMA.schema, strict: true },
      },
    }),
  });
  const j: any = await res.json();
  const qs = JSON.parse(j.choices?.[0]?.message?.content ?? '{}').questions ?? [];
  const CERT = ['정보처리기사', 'AWS SAA', 'TOEIC', 'SQLD', '자격증', '어학'];
  console.log(`\n총 ${qs.length}문항\n${'='.repeat(74)}`);
  for (const q of qs) {
    const hit = CERT.filter((c: string) => q.question.includes(c));
    console.log(`${hit.length ? '⚠️ ' : '  '}[${q.category}] ${q.question}`);
  }
  const certQs = qs.filter((q: any) => CERT.some((c: string) => q.question.includes(c)));
  console.log(`\n자격증·어학 언급 문항: ${certQs.length} / ${qs.length}`);
  // 공고 우대사항(기술)이 질문에 반영됐는지도 같이 본다
  const TECH = ['Kafka', 'MSA', 'AWS', '대용량', '실시간'];
  const techQs = qs.filter((q: any) => TECH.some((t: string) => q.question.includes(t)));
  console.log(`공고 기술요건 반영 문항: ${techQs.length} / ${qs.length}`);
}
void main();
