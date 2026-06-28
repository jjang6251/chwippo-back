/**
 * W2 — companies.json 빌드 스크립트
 *
 * 입력:
 *   1. DART OPEN API (선택) — 환경변수 DART_API_KEY 있으면 자동 ZIP 다운 + 압축 해제 + XML 파싱
 *      - API 발급: https://opendart.fss.or.kr/uss/umt/EgovMberInsertView.do
 *      - endpoint: GET /api/corpCode.xml?crtfc_key={KEY} → ZIP (CORPCODE.xml 들어있음)
 *      - schema: { corp_code, corp_name, stock_code?, modify_date }
 *      - 상장사 = stock_code 있는 것 (~4000)
 *   2. (선택) --dart-csv=path/to/dart.csv — 옛 옵션, API 못 쓸 때 수동 CSV
 *   3. src/data/company-domains.json — 수동 도메인 매핑 (top 200)
 *
 * 출력: src/data/companies.json
 *   - schema: { name: string; domain?: string; market?: 'KOSPI'|'KOSDAQ'|'KONEX'|'OTC' }[]
 *   - industry 는 corpCode.xml 에 없음 (별도 /api/company.json 호출 필요 — 4000회 rate limit 부담, 베타 단계는 생략)
 *
 * 사용:
 *   DART_API_KEY=xxx npx ts-node scripts/build-companies-json.ts
 *   또는 npx ts-node scripts/build-companies-json.ts --dart-csv=path/to/dart.csv
 *   또는 npx ts-node scripts/build-companies-json.ts          (domain 매핑만)
 *
 * **업데이트 정책** (베타):
 *   - CEO 가 분기 1회 또는 신규 회사 신고 시 수동 실행 → commit → 배포
 *   - 출시 후 = GitHub Actions cron 월 1회 PR 자동 생성 (별도 워크플로우 도입)
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

interface Company {
  name: string;
  /** DART corp_code — 8자리. 회사조사 hybrid·DART 정보 섹션에서 사용 */
  corpCode?: string;
  domain?: string;
  industry?: string;
  market?: 'KOSPI' | 'KOSDAQ' | 'KONEX' | 'OTC';
}

interface CsvRow {
  name: string;
  industry?: string;
  market?: string;
}

interface DartCorpRow {
  corp_code: string;
  corp_name: string;
  stock_code?: string;
  modify_date?: string;
}

/** DART OPEN API 에서 ZIP 다운 → CORPCODE.xml 추출 → JSON 변환 */
async function fetchDartCorps(apiKey: string): Promise<DartCorpRow[]> {
  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`;
  console.log('Fetching DART corpCode ZIP...');
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DART API HTTP ${res.status}: ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  // ZIP 안에 CORPCODE.xml 1 파일
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  const xmlEntry = entries.find((e) =>
    e.entryName.toUpperCase().includes('CORPCODE'),
  );
  if (!xmlEntry) {
    throw new Error(
      `ZIP 안에 CORPCODE.xml 없음. entries: ${entries.map((e) => e.entryName).join(', ')}`,
    );
  }
  const xml = xmlEntry.getData().toString('utf-8');

  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
    parseTagValue: false, // stock_code 등 모두 string 유지 (빈 값 = '')
    isArray: (name) => name === 'list',
  });
  const parsed = parser.parse(xml) as {
    result: { list: DartCorpRow[] };
  };
  const rows = parsed.result?.list ?? [];
  console.log(`Parsed ${rows.length} DART corp entries`);
  return rows;
}

function parseDartCsv(csvPath: string): CsvRow[] {
  // DART 상장사 CSV 표준 컬럼: 회사명, 종목코드, 업종, 시장구분 등
  // (포맷 변동 가능 — 실제 다운로드 시 컬럼 헤더 확인 후 조정)
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const nameIdx = header.findIndex(
    (h) => h.includes('회사명') || h.includes('종목명'),
  );
  const industryIdx = header.findIndex((h) => h.includes('업종'));
  const marketIdx = header.findIndex(
    (h) => h.includes('시장') || h.includes('구분'),
  );
  if (nameIdx === -1) {
    throw new Error(`DART CSV 헤더에 회사명 컬럼 없음: ${header.join(', ')}`);
  }
  return lines
    .slice(1)
    .map((line) => {
      const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      return {
        name: cols[nameIdx],
        industry: industryIdx >= 0 ? cols[industryIdx] : undefined,
        market: marketIdx >= 0 ? cols[marketIdx] : undefined,
      };
    })
    .filter((r) => r.name);
}

function normalizeMarket(
  stockCode?: string,
  market?: string,
): Company['market'] | undefined {
  // stock_code 만 보고 KOSPI/KOSDAQ 추정은 어려움 (별도 KRX 데이터 필요).
  // 베타 단계 = stock_code 있으면 일단 KOSPI 로 (조잡한 근사) — 정확한 분류는 향후 KRX 추가.
  // market 인자 (CSV 경로) 있으면 우선 사용.
  if (market) {
    if (market.includes('유가') || market.includes('KOSPI')) return 'KOSPI';
    if (market.includes('코스닥') || market.includes('KOSDAQ')) return 'KOSDAQ';
    if (market.includes('코넥스') || market.includes('KONEX')) return 'KONEX';
    return 'OTC';
  }
  // DART API 만 사용 시 시장 구분 없음 — stock_code 있으면 unknown 상장사. market field 비움
  return stockCode ? undefined : undefined;
}

async function build() {
  const dataDir = path.join(__dirname, '..', 'src', 'data');
  const domainsPath = path.join(dataDir, 'company-domains.json');
  const outputPath = path.join(dataDir, 'companies.json');

  // 1. domain 매핑 load (top 200)
  const domainsRaw = JSON.parse(
    fs.readFileSync(domainsPath, 'utf-8'),
  ) as Record<string, string>;
  // 메타 필드 (_comment, _last_updated, _count) 제외
  const domains: Record<string, string> = {};
  for (const [k, v] of Object.entries(domainsRaw)) {
    if (!k.startsWith('_')) domains[k] = v;
  }
  console.log(`Loaded ${Object.keys(domains).length} domain mappings`);

  const companiesMap = new Map<string, Company>();

  // 2a. DART API (환경변수 우선)
  const apiKey = process.env.DART_API_KEY;
  if (apiKey) {
    const corps = await fetchDartCorps(apiKey);
    // 상장사만 (stock_code 있는 것) — 빈 element 가 obj/숫자로 parse 될 수 있어 String() 가드
    const listedRaw = corps.filter(
      (c) =>
        typeof c.stock_code === 'string' &&
        c.stock_code.trim().length > 0 &&
        typeof c.corp_name === 'string',
    );
    // 채용 안 하는 상장사 필터 (SPAC + REIT)
    const NOT_HIRING_PATTERN =
      /스팩|SPAC|리츠|REIT|기업인수목적|투자합자조합|투자조합/i;
    const listed = listedRaw.filter(
      (c) => !NOT_HIRING_PATTERN.test(c.corp_name),
    );
    console.log(
      `Filtered ${listedRaw.length} → ${listed.length} listed (제외 SPAC/REIT/조합: ${listedRaw.length - listed.length})`,
    );
    for (const c of listed) {
      // 같은 이름 중복 시 첫번째 유지
      if (companiesMap.has(c.corp_name)) continue;
      companiesMap.set(c.corp_name, {
        name: c.corp_name,
        corpCode: c.corp_code,
        domain: domains[c.corp_name],
        market: normalizeMarket(c.stock_code),
      });
    }
  } else {
    // 2b. (옵션) CSV 인자
    const dartCsvArg = process.argv.find((a) => a.startsWith('--dart-csv='));
    const dartCsvPath = dartCsvArg
      ? dartCsvArg.replace('--dart-csv=', '')
      : null;
    if (dartCsvPath && fs.existsSync(dartCsvPath)) {
      const rows = parseDartCsv(dartCsvPath);
      console.log(`Parsed ${rows.length} DART CSV entries`);
      for (const r of rows) {
        companiesMap.set(r.name, {
          name: r.name,
          domain: domains[r.name],
          industry: r.industry,
          market: normalizeMarket(undefined, r.market),
        });
      }
    } else {
      console.log(
        'No DART_API_KEY or --dart-csv — seeding from domain mappings only',
      );
    }
  }

  // 3. domain 매핑에 있지만 DART 에 없는 회사 (스타트업·외국계 등) 추가
  //    같은 domain 의 DART entry 가 있으면 corpCode 도 함께 inject (별칭 매핑)
  //    예: "네이버" (domains) ↔ "NAVER" (DART) — 둘 다 naver.com → corpCode 공유
  const domainToCorpCode = new Map<string, string>();
  for (const c of companiesMap.values()) {
    if (c.domain && c.corpCode && !domainToCorpCode.has(c.domain)) {
      domainToCorpCode.set(c.domain, c.corpCode);
    }
  }
  for (const [name, domain] of Object.entries(domains)) {
    if (!companiesMap.has(name)) {
      const corpCode = domainToCorpCode.get(domain);
      companiesMap.set(
        name,
        corpCode ? { name, corpCode, domain } : { name, domain },
      );
    }
  }

  const companies = Array.from(companiesMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name, 'ko'),
  );

  fs.writeFileSync(outputPath, JSON.stringify(companies, null, 2), 'utf-8');
  console.log(`✅ ${companies.length} companies → ${outputPath}`);
  const withDomain = companies.filter((c) => c.domain).length;
  console.log(
    `   - ${withDomain} with domain (${Math.round((withDomain / companies.length) * 100)}%)`,
  );
  const withMarket = companies.filter((c) => c.market).length;
  console.log(`   - ${withMarket} listed (with market)`);
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
