/**
 * 회사 조사 pre-seed 로컬 적재 — dev DB 검증용.
 * 사용: npx ts-node -T scripts/seed-research-local.ts <seed.json 경로>
 * (운영은 부팅 자동 seed — CompanyResearchSeedService 가 R2 에서 fetch)
 */
import { readFileSync } from 'fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  CompanyResearchSeedService,
  ResearchSeedDoc,
} from '../src/interview-prep/company-research-seed.service';

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('사용법: ts-node scripts/seed-research-local.ts <seed.json>');
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(path, 'utf-8')) as ResearchSeedDoc;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const seed = app.get(CompanyResearchSeedService);
    const r = await seed.applySeed(doc);
    console.log(
      `pre-seed v${doc.version}: +${r.inserted} 신규 · ${r.updated} 갱신 · ${r.skippedUser} 유저행 보존 · ${r.skippedOptOut} opt-out 보존`,
    );
  } finally {
    await app.close();
  }
}

void main();
