/**
 * W2 — DART API 보강 미리보기 (1회성 demo).
 *
 * 입력: 회사명 (예: "네이버", "카카오")
 * 출력: DART 4 endpoint 결과 (company / list / fnlttSinglAcnt / 최근 공시 N개)
 * 용도: AI 회사조사 vs DART 보강 비교용 시각화
 *
 * 사용: DART_API_KEY=xxx npx ts-node scripts/preview-dart-enrichment.ts "네이버"
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

interface CorpRow {
  corp_code: string;
  corp_name: string;
  stock_code?: string;
}

async function fetchCorpCodeMap(apiKey: string): Promise<Map<string, string>> {
  // companies.json build 와 동일 — corpCode XML 다운
  console.log('Loading DART corpCode...');
  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const xmlEntry = zip.getEntries().find((e) => e.entryName.toUpperCase().includes('CORPCODE'));
  if (!xmlEntry) throw new Error('CORPCODE.xml not found');
  const parser = new XMLParser({ parseTagValue: false, isArray: (n) => n === 'list' });
  const parsed = parser.parse(xmlEntry.getData().toString('utf-8')) as {
    result: { list: CorpRow[] };
  };
  const map = new Map<string, string>();
  for (const c of parsed.result.list) {
    if (
      typeof c.stock_code === 'string' &&
      c.stock_code.trim().length > 0 &&
      typeof c.corp_name === 'string'
    ) {
      map.set(c.corp_name, c.corp_code);
    }
  }
  return map;
}

async function fetchCompanyInfo(corpCode: string, apiKey: string) {
  const url = `https://opendart.fss.or.kr/api/company.json?crtfc_key=${apiKey}&corp_code=${corpCode}`;
  const res = await fetch(url);
  return await res.json();
}

async function fetchDisclosures(corpCode: string, apiKey: string) {
  // 최근 3개월
  const today = new Date();
  const bgn = new Date(today);
  bgn.setMonth(bgn.getMonth() - 3);
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bgn_de=${fmt(bgn)}&end_de=${fmt(today)}&page_count=10`;
  const res = await fetch(url);
  return await res.json();
}

async function fetchFinancials(corpCode: string, apiKey: string, year = 2025) {
  // 11011 = 1분기, 11012 = 반기, 11013 = 3분기, 11014 = 사업
  const url = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011`;
  const res = await fetch(url);
  return await res.json();
}

async function main() {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) {
    console.error('DART_API_KEY env 가 필요해요. .env 확인.');
    process.exit(1);
  }

  const targetName = process.argv[2] || '네이버';

  const corpMap = await fetchCorpCodeMap(apiKey);
  const corpCode = corpMap.get(targetName);
  if (!corpCode) {
    console.error(`"${targetName}" 매칭 corp_code 없음. 상장사 정확 회사명 확인.`);
    console.error(`예: 후보 = ${[...corpMap.keys()].filter((n) => n.includes(targetName)).slice(0, 5).join(', ')}`);
    process.exit(1);
  }
  console.log(`✅ ${targetName} → corp_code: ${corpCode}\n`);

  console.log('=== 1. 회사 개요 (company.json) ===');
  const company = await fetchCompanyInfo(corpCode, apiKey);
  console.log(JSON.stringify(company, null, 2));

  console.log('\n=== 2. 최근 3개월 공시 (list.json) ===');
  const disclosures = await fetchDisclosures(corpCode, apiKey);
  const items =
    Array.isArray((disclosures as { list?: unknown[] }).list)
      ? ((disclosures as { list: { report_nm: string; rcept_dt: string }[] }).list)
      : [];
  items.slice(0, 10).forEach((d) => {
    console.log(`- [${d.rcept_dt}] ${d.report_nm}`);
  });

  console.log('\n=== 3. 2025년 1분기 재무 (fnlttSinglAcnt.json) ===');
  const fin = await fetchFinancials(corpCode, apiKey, 2025);
  const finList =
    Array.isArray((fin as { list?: unknown[] }).list)
      ? ((fin as { list: { account_nm: string; thstrm_amount: string; sj_nm: string }[] }).list)
      : [];
  if (finList.length === 0) {
    // fallback 2024
    console.log('(2025 1분기 없음 → 2024 사업보고서)');
    const fin2024 = await fetchFinancials(corpCode, apiKey, 2024);
    const list2024 =
      Array.isArray((fin2024 as { list?: unknown[] }).list)
        ? ((fin2024 as { list: { account_nm: string; thstrm_amount: string; sj_nm: string }[] }).list)
        : [];
    list2024.slice(0, 15).forEach((f) => {
      console.log(`- ${f.sj_nm} | ${f.account_nm}: ${f.thstrm_amount}`);
    });
  } else {
    finList.slice(0, 15).forEach((f) => {
      console.log(`- ${f.sj_nm} | ${f.account_nm}: ${f.thstrm_amount}`);
    });
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
