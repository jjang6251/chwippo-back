import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CompanyResearchCache } from './entities/company-research-cache.entity';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { checkSafety, Violation } from './research-seed-validator';

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
  /** 안전 검사(개인정보·금지소스·크래시 타입)에 걸려 적재하지 않은 회사 수 */
  skippedUnsafe: number;
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
    private readonly discord: DiscordNotifier,
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
          `${result.skippedUser} 유저행 보존 · ${result.skippedOptOut} opt-out 보존` +
          (result.skippedUnsafe > 0
            ? ` · 🔴 ${result.skippedUnsafe} 안전검사 제외`
            : ''),
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
      skippedUnsafe: 0,
    };
    const unsafe: Violation[] = [];

    // 🔴 안전 백스톱 — CLI 게이트(`npm run verify:seed`)를 안 돌리고 올려도 여기서 막는다.
    //
    // ⚠️ 아래 조기 skip 보다 **먼저** 걸러야 한다. 제외된 회사는 그 버전으로 행이 안 생기므로
    // `already` 가 전체 이름 수에 영원히 못 미쳐, 나중에 거르면 **매 부팅마다 전량 재저장**된다.
    //
    // 회사 단위로 건너뛴다 — 1건 때문에 나머지 349건이 못 들어가면 더 나쁜 실패다
    // (opt-out·유저행도 같은 방식으로 건별 continue 하고 있다).
    const safe: ResearchSeedEntry[] = [];
    for (const entry of doc.companies) {
      const violations = checkSafety(entry);
      if (violations.length > 0) {
        result.skippedUnsafe += 1;
        unsafe.push(...violations);
        this.logger.warn(
          `pre-seed 안전검사 실패로 skip — ${entry.companyName}: ` +
            violations.map((v) => `${v.kind} ${v.detail}`).join(' | '),
        );
        continue;
      }
      safe.push(entry);
    }

    // 같은 버전이 전부 들어가 있으면 skip — 기준은 **통과한 회사**의 이름 수.
    // names.length === 0 (전량 제외) 이면 조기 return 하지 않는다 — 그러면 알림도 못 띄운다.
    const names = this.expandNames(safe);
    const already = await this.cacheRepo.count({
      where: { seedVersion: doc.version },
    });
    if (names.length > 0 && already >= names.length) {
      this.logger.log(
        `pre-seed v${doc.version} 이미 적재됨 (${already} rows)` +
          (result.skippedUnsafe > 0
            ? ` · 안전검사 제외 ${result.skippedUnsafe}개사 (재업로드 필요)`
            : ''),
      );
      return result;
    }

    for (const entry of safe) {
      const sources = this.normalizeSources(entry.sources);
      // 본 행 = isAlias false, aliases 로 만들어지는 복제 행 = isAlias true.
      const aliasSet = new Set(entry.aliases ?? []);
      for (const name of [entry.companyName, ...(entry.aliases ?? [])]) {
        const key = this.normalize(name);
        const isAlias = aliasSet.has(name);
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
          // 기존 행에도 별칭 플래그를 갱신 (재적재 시 마킹 소급 적용).
          existing.isAlias = isAlias;
          // 표시용 표기 — 별칭 행도 본명을 가리킨다 (공고 붙여넣기 회사명 정규화의 근거)
          existing.canonicalName = entry.companyName;
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
              isAlias,
              canonicalName: entry.companyName,
            }),
          );
          result.inserted += 1;
        }
      }
    }

    if (result.skippedUnsafe > 0) this.alertUnsafe(doc.version, result, unsafe);
    return result;
  }

  /**
   * 안전검사에 걸린 회사가 있으면 알린다.
   *
   * 로그만 남기면 **아무도 안 본다** — 이 검사가 걸리는 상황 자체가
   * "CLI 게이트를 안 돌리고 올렸다" 는 뜻이라, 사람이 즉시 알아야 고친다.
   * best-effort (알림 실패가 적재를 막지 않는다).
   */
  private alertUnsafe(
    version: string,
    result: SeedApplyResult,
    unsafe: Violation[],
  ): void {
    const bySeverity = unsafe.filter((v) => v.kind.startsWith('🔴'));
    void this.discord
      .notify(
        {
          title: '🔴 pre-seed 안전검사 — 일부 회사 적재 제외',
          color:
            bySeverity.length > 0 ? DISCORD_COLORS.red : DISCORD_COLORS.yellow,
          fields: [
            { name: 'seed 버전', value: version, inline: true },
            {
              name: '제외/적재',
              value: `${result.skippedUnsafe}개사 제외 · ${result.inserted + result.updated}행 적재`,
              inline: true,
            },
            {
              name: '위반',
              value: unsafe
                .slice(0, 8)
                .map((v) => `${v.company}: ${v.kind} ${v.detail}`)
                .join('\n')
                .slice(0, 900),
              inline: false,
            },
            {
              name: '조치',
              value:
                'seed 를 고치고 `npm run verify:seed` 통과 후 재업로드. ' +
                '제외된 회사는 기존 값이 그대로 남아 있다.',
              inline: false,
            },
          ],
        },
        'critical',
      )
      .catch(() => undefined);
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
