/**
 * 고등학교 데이터 dump 스크립트 (NEIS 교육정보개방 API)
 *
 * 입력:
 *   - 환경변수 NEIS_API_KEY — 발급: https://open.neis.go.kr/portal/guide/actKeyPage.do
 *   - endpoint: GET https://open.neis.go.kr/hub/schoolInfo?KEY&Type=json&SCHUL_KND_SC_NM=고등학교&pIndex&pSize
 *
 * 출력: src/data/schools-high.json
 *   - schema: { name: string; region: string; address?: string; code?: string }[]
 *   - region = LCTN_SC_NM (시도교육청, "서울특별시" 등) — 동명 학교 구분용
 *   - name 동일 학교 dedup (SCHUL_CODE 기준)
 *
 * 사용:
 *   NEIS_API_KEY=xxx npx ts-node scripts/build-schools-high.ts
 *
 * 업데이트 정책:
 *   - 학교는 신설·폐교가 드물어 반기~연 1회 CEO 수동 실행
 *   - 트래픽: pSize=1000 × 3~4 페이지 = 4 회 호출. NEIS 일 1000회 무료 한도 여유
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface HighSchool {
  name: string;
  region: string;
  address?: string;
  code?: string;
}

interface NeisSchoolRow {
  SD_SCHUL_CODE: string;
  SCHUL_NM: string;
  LCTN_SC_NM: string;
  ORG_RDNMA?: string;
  SCHUL_KND_SC_NM: string;
}

interface NeisResponse {
  schoolInfo?: Array<
    | { head: Array<{ list_total_count?: number } | { RESULT?: { CODE: string; MESSAGE: string } }> }
    | { row: NeisSchoolRow[] }
  >;
  RESULT?: { CODE: string; MESSAGE: string };
}

const NEIS_ENDPOINT = 'https://open.neis.go.kr/hub/schoolInfo';
const PAGE_SIZE = 1000;

async function fetchPage(key: string, page: number): Promise<{ rows: NeisSchoolRow[]; total: number }> {
  const url = `${NEIS_ENDPOINT}?KEY=${encodeURIComponent(key)}&Type=json&pIndex=${page}&pSize=${PAGE_SIZE}&SCHUL_KND_SC_NM=${encodeURIComponent('고등학교')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NEIS HTTP ${res.status}`);
  const json = (await res.json()) as NeisResponse;

  // 응답 없음 (INFO-200 = 데이터 없음)
  if (!json.schoolInfo) {
    const code = json.RESULT?.CODE;
    if (code === 'INFO-200') return { rows: [], total: 0 };
    throw new Error(`NEIS error: ${code} ${json.RESULT?.MESSAGE ?? 'unknown'}`);
  }

  const arr = json.schoolInfo;
  const headEntry = arr.find((e) => 'head' in e) as { head: Array<{ list_total_count?: number }> } | undefined;
  const rowEntry = arr.find((e) => 'row' in e) as { row: NeisSchoolRow[] } | undefined;
  const total = headEntry?.head.find((h) => 'list_total_count' in h)?.list_total_count ?? 0;
  const rows = rowEntry?.row ?? [];
  return { rows, total };
}

async function main(): Promise<void> {
  const key = process.env.NEIS_API_KEY;
  if (!key) {
    console.error('NEIS_API_KEY env 미설정. .env 에 NEIS_API_KEY=... 넣어주세요.');
    process.exit(1);
  }

  console.log('NEIS 고등학교 dump 시작...');

  const all = new Map<string, HighSchool>();
  let page = 1;
  let total = -1;

  while (true) {
    console.log(`  page ${page} 요청...`);
    const { rows, total: t } = await fetchPage(key, page);
    if (total === -1) total = t;
    if (rows.length === 0) break;

    for (const r of rows) {
      all.set(r.SD_SCHUL_CODE, {
        name: r.SCHUL_NM,
        region: r.LCTN_SC_NM,
        address: r.ORG_RDNMA?.trim() || undefined,
        code: r.SD_SCHUL_CODE,
      });
    }

    console.log(`    → ${rows.length}개 수집 (누적 ${all.size} / 전체 ${total})`);
    if (rows.length < PAGE_SIZE) break;
    page += 1;
  }

  const list = [...all.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const outPath = path.join(process.cwd(), 'src/data/schools-high.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(list, null, 2) + '\n', 'utf8');

  console.log(`\n✅ ${list.length}개 고등학교 → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
