import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CompanyResearchCache } from './entities/company-research-cache.entity';

/**
 * 회사 조사 pre-seed 부팅 자동 적재 (2026-07-09, CEO 결정 — S3 private + boot seed).
 *
 * 원본 = private R2(BACKUP_R2_* 재사용, 파일 버킷은 public 서빙이라 부적합)의 seed JSON.
 * 공개 레포에 조사 데이터를 커밋하지 않는 이유: ① 큐레이션 자산 유출 ② opt-out 시
 * git 이력에 영구 잔존 (24h 삭제 SLA 충돌).
 *
 * 적재 규칙 (전부 generic — job_category NULL):
 * - 같은 seed 버전이 이미 전부 적재돼 있으면 skip (부팅 비용 최소화)
 * - opt_out row 는 절대 덮지 않음 (회사 측 삭제 요청 우선 — seed 파일에 남아 있어도 부활 금지)
 * - 유저 조사로 생긴 row (seed_version IS NULL) 는 덮지 않음
 * - 그 외 (미존재 · 구버전 seed) → upsert, expiresAt = now + ttlDays
 * - aliases: 동일 회사 복수 표기 (토스=비바리퍼블리카) — 같은 research 를 각 이름 키로 복제
 * - 실패는 warn 로그만 — 부팅을 절대 차단하지 않음
 */

export interface ResearchSeedEntry {
  companyName: string;
  /** 동일 회사 복수 표기 — 같은 내용을 각 이름 키로 복제 저장 */
  aliases?: string[];
  research: Record<string, unknown>;
  sources?: Array<string | { url?: string }>;
}

export interface ResearchSeedDoc {
  version: string;
  ttlDays: number;
  companies: ResearchSeedEntry[];
}

export interface SeedApplyResult {
  inserted: number;
  updated: number;
  skippedUser: number;
  skippedOptOut: number;
}

const DEFAULT_SEED_KEY = 'research-seed/company-research-seed.json';

@Injectable()
export class CompanyResearchSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompanyResearchSeedService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly seedKey: string;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(CompanyResearchCache)
    private readonly cacheRepo: Repository<CompanyResearchCache>,
  ) {
    this.bucket = config.get('BACKUP_R2_BUCKET', '');
    this.seedKey = config.get('RESEARCH_SEED_KEY', DEFAULT_SEED_KEY);
    this.s3 = new S3Client({
      region: 'auto',
      endpoint:
        config.get('BACKUP_R2_ENDPOINT') || config.get('R2_ENDPOINT', ''),
      credentials: {
        accessKeyId:
          config.get('BACKUP_R2_ACCESS_KEY_ID') ||
          config.get('R2_ACCESS_KEY_ID', ''),
        secretAccessKey:
          config.get('BACKUP_R2_SECRET_ACCESS_KEY') ||
          config.get('R2_SECRET_ACCESS_KEY', ''),
      },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.bucket) {
      this.logger.log('pre-seed skip — BACKUP_R2_BUCKET 미설정 (로컬 dev)');
      return;
    }
    try {
      const doc = await this.fetchSeedDoc();
      if (!doc) return;
      const result = await this.applySeed(doc);
      this.logger.log(
        `pre-seed v${doc.version}: +${result.inserted} 신규 · ${result.updated} 갱신 · ` +
          `${result.skippedUser} 유저행 보존 · ${result.skippedOptOut} opt-out 보존`,
      );
    } catch (err) {
      // 부팅 차단 금지 — 다음 재시작에서 재시도
      this.logger.warn(
        `pre-seed 적재 실패 (무시하고 부팅 계속): ${String(err)}`,
      );
    }
  }

  private async fetchSeedDoc(): Promise<ResearchSeedDoc | null> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.seedKey }),
    );
    const raw = await res.Body?.transformToString('utf-8');
    if (!raw) return null;
    const doc = JSON.parse(raw) as ResearchSeedDoc;
    if (!doc.version || !Array.isArray(doc.companies)) {
      throw new Error('seed 파일 형식 불일치 (version/companies 필수)');
    }
    return doc;
  }

  /** 로컬 검증 스크립트(scripts/seed-research-local.ts)도 같은 core 를 호출 */
  async applySeed(doc: ResearchSeedDoc): Promise<SeedApplyResult> {
    const ttlDays = doc.ttlDays > 0 ? doc.ttlDays : 180;
    const result: SeedApplyResult = {
      inserted: 0,
      updated: 0,
      skippedUser: 0,
      skippedOptOut: 0,
    };

    // 같은 버전이 전부 들어가 있으면 skip
    const names = this.expandNames(doc.companies);
    const already = await this.cacheRepo.count({
      where: { seedVersion: doc.version },
    });
    if (already >= names.length) {
      this.logger.log(`pre-seed v${doc.version} 이미 적재됨 (${already} rows)`);
      return result;
    }

    for (const entry of doc.companies) {
      const sources = this.normalizeSources(entry.sources);
      for (const name of [entry.companyName, ...(entry.aliases ?? [])]) {
        const key = this.normalize(name);
        // ⚠️ TypeORM findOne 은 where 의 null 값을 조용히 무시 — 반드시 IsNull() 사용.
        // (null 로 쓰면 직군 맞춤 행이 generic 행으로 오인돼 seed 가 스킵되는 버그)
        const existing = await this.cacheRepo.findOne({
          where: { companyName: key, jobCategory: IsNull() },
        });
        if (existing?.optOut) {
          result.skippedOptOut += 1;
          continue;
        }
        if (existing && existing.seedVersion === null) {
          result.skippedUser += 1;
          continue;
        }
        const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
        if (existing) {
          existing.aiResearch = entry.research;
          existing.sources = sources;
          existing.expiresAt = expiresAt;
          existing.seedVersion = doc.version;
          await this.cacheRepo.save(existing);
          result.updated += 1;
        } else {
          await this.cacheRepo.save(
            this.cacheRepo.create({
              companyName: key,
              jobCategory: null,
              aiResearch: entry.research,
              sources,
              expiresAt,
              optOut: false,
              hitCount: 0,
              seedVersion: doc.version,
            }),
          );
          result.inserted += 1;
        }
      }
    }
    return result;
  }

  private expandNames(companies: ResearchSeedEntry[]): string[] {
    return companies.flatMap((c) => [c.companyName, ...(c.aliases ?? [])]);
  }

  /** company-research.service normalize 와 동일 규칙 (lowercase + trim) */
  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  private normalizeSources(sources: ResearchSeedEntry['sources']): string[] {
    if (!sources) return [];
    return sources
      .map((s) => (typeof s === 'string' ? s : (s.url ?? '')))
      .filter((u): u is string => u.length > 0);
  }
}
