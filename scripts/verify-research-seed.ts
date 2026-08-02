/**
 * 회사 조사 seed 검증 CLI — 조립 전 게이트.
 *
 *   npm run verify:seed -- ../data-seeds/company-research-seed-{버전}.json
 *
 * 검증 규칙 자체는 `src/interview-prep/research-seed-validator.ts` 에 있다 —
 * **부팅 적재(로더)와 같은 모듈을 공유**한다. 여기는 출력·종료 코드만 담당한다.
 *
 * 종료 코드: 0 통과 · 1 위반 · 2 사용법/파일 오류
 */
import { readFileSync } from 'fs';
import {
  verifySeedDoc,
  type Violation,
} from '../src/interview-prep/research-seed-validator';

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error(
      '사용법: npm run verify:seed -- <seed.json>',
    );
    process.exit(2);
  }

  // 경로 오타·깨진 JSON 이 스택 트레이스로 나오면 "스크립트가 고장났다" 로 읽힌다.
  // 게이트를 통과 못 한 이유가 분명해야 다음 행동이 정해진다.
  let seed: Parameters<typeof verifySeedDoc>[0];
  try {
    seed = JSON.parse(readFileSync(file, 'utf8')) as Parameters<
      typeof verifySeedDoc
    >[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      msg.includes('ENOENT')
        ? `\n❌ 파일을 못 찾았다: ${file}\n   경로를 확인할 것 (chwippo-back 에서 실행하면 seed 는 보통 ../data-seeds/...)\n`
        : `\n❌ JSON 파싱 실패: ${file}\n   ${msg}\n`,
    );
    process.exit(2);
  }

  const { violations, notices, stats } = verifySeedDoc(seed);

  console.log(`\n📦 ${file}`);
  console.log(
    `   version=${seed.version} · ttlDays=${seed.ttlDays} · 회사 ${stats['회사']} · 출처 ${stats['출처']}\n`,
  );

  if (notices.length > 0) {
    console.log(
      `ℹ️  참고 ${notices.length}건 — **위반이 아니다.** 통과 여부와 무관하며 눈으로만 확인한다.`,
    );
    for (const n of notices.slice(0, 15))
      console.log(`   ${n.company}: ${n.detail}`);
    if (notices.length > 15) console.log(`   … 외 ${notices.length - 15}건`);
    console.log();
  }

  if (stats['표시의무(위키)'] > 0) {
    console.log(
      `ℹ️  위키피디아 출처 ${stats['표시의무(위키)']}건 — CC BY-SA 라 **화면에 저작자 표시**가 필요하다.`,
    );
    console.log(
      `   구조화 사실(설립·본사·업종)은 Wikidata(CC0)로 옮기면 표시 의무가 사라진다.\n`,
    );
  }

  if (violations.length === 0) {
    console.log('✅ 위반 0건 — 조립·업로드 진행 가능\n');
    process.exit(0);
  }

  const byKind = violations.reduce<Record<string, Violation[]>>((acc, v) => {
    (acc[v.kind] ??= []).push(v);
    return acc;
  }, {});

  console.log(`❌ 위반 ${violations.length}건\n`);
  for (const [kind, list] of Object.entries(byKind).sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    console.log(`── ${kind} (${list.length}) ──`);
    for (const v of list.slice(0, 20)) console.log(`   ${v.company}: ${v.detail}`);
    if (list.length > 20) console.log(`   … 외 ${list.length - 20}건`);
    console.log();
  }

  console.log('🔴 위반을 해소하기 전에는 조립·R2 업로드를 하지 말 것.\n');
  process.exit(1);
}

main();
