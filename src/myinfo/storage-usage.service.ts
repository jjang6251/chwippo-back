import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Cert } from './entities/cert.entity';
import { Award } from './entities/award.entity';
import { LanguageCert } from './entities/language-cert.entity';
import { Document } from './entities/document.entity';
import { Education } from './entities/education.entity';

export interface StorageUsage {
  usedBytes: number;
  limitBytes: number;
  usedMB: number;
  limitMB: number;
  percentage: number;
}

@Injectable()
export class StorageUsageService {
  constructor(
    @InjectRepository(Cert) private readonly certRepo: Repository<Cert>,
    @InjectRepository(Award) private readonly awardRepo: Repository<Award>,
    @InjectRepository(LanguageCert)
    private readonly langCertRepo: Repository<LanguageCert>,
    @InjectRepository(Document) private readonly docRepo: Repository<Document>,
    @InjectRepository(Education)
    private readonly eduRepo: Repository<Education>,
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  getLimitBytes(): number {
    const mb = Number(this.config.get<number>('MAX_STORAGE_PER_USER_MB', 100));
    return mb * 1024 * 1024;
  }

  /**
   * 사용자의 현재 총 사용량 계산.
   * @param manager 트랜잭션 내에서 호출할 경우 EntityManager 전달 — 락 보호하에 일관된 값 반환
   */
  async calculateUsage(
    userId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const repos = manager
      ? [
          manager.getRepository(Cert),
          manager.getRepository(Award),
          manager.getRepository(LanguageCert),
          manager.getRepository(Document),
          manager.getRepository(Education),
        ]
      : [
          this.certRepo,
          this.awardRepo,
          this.langCertRepo,
          this.docRepo,
          this.eduRepo,
        ];

    let total = 0;
    for (const repo of repos) {
      const result = await repo
        .createQueryBuilder('e')
        .select('COALESCE(SUM(e.file_size_bytes), 0)', 'total')
        .where('e.user_id = :userId', { userId })
        .getRawOne<{ total: string }>();
      total += Number(result?.total ?? 0);
    }
    return total;
  }

  async getUsage(userId: string): Promise<StorageUsage> {
    const used = await this.calculateUsage(userId);
    const limit = this.getLimitBytes();
    return {
      usedBytes: used,
      limitBytes: limit,
      usedMB: Math.round((used / 1024 / 1024) * 10) / 10,
      limitMB: Math.round(limit / 1024 / 1024),
      percentage: limit === 0 ? 0 : Math.round((used / limit) * 100),
    };
  }

  /**
   * 사용자의 모든 myinfo 파일 URL 수집. 탈퇴 시 R2 cascade 정리용.
   */
  async collectAllFileUrls(userId: string): Promise<string[]> {
    const repos = [
      this.certRepo,
      this.awardRepo,
      this.langCertRepo,
      this.docRepo,
      this.eduRepo,
    ];
    const urls: string[] = [];
    for (const repo of repos) {
      const rows = await repo
        .createQueryBuilder('e')
        .select('e.file_url', 'file_url')
        .where('e.user_id = :userId AND e.file_url IS NOT NULL', { userId })
        .getRawMany<{ file_url: string }>();
      for (const row of rows) {
        if (row.file_url) urls.push(row.file_url);
      }
    }
    return urls;
  }

  /**
   * 트랜잭션 안에서 호출. 호출자가 미리 사용자 row 락을 잡은 상태여야 race 안전.
   * 한도 초과 시 BadRequestException 던짐.
   */
  /**
   * 전역 사용량 합계 — 5개 테이블 모두의 SUM(file_size_bytes).
   * admin 대시보드용. user_id 필터 없음.
   */
  async getGlobalUsage(): Promise<number> {
    const repos = [
      this.certRepo,
      this.awardRepo,
      this.langCertRepo,
      this.docRepo,
      this.eduRepo,
    ];
    let total = 0;
    for (const repo of repos) {
      const result = await repo
        .createQueryBuilder('e')
        .select('COALESCE(SUM(e.file_size_bytes), 0)', 'total')
        .getRawOne<{ total: string }>();
      total += Number(result?.total ?? 0);
    }
    return total;
  }

  /**
   * 사용자별 SUM이 cap * 0.95 이상인 사용자 수.
   * 단일 raw 쿼리로 N+1 회피.
   */
  async getNearCapUserCount(): Promise<number> {
    const threshold = Math.floor(this.getLimitBytes() * 0.95);
    // 일부 테이블의 user_id 컬럼 타입이 varchar로 남아있을 수 있어 ::text로 통일
    const result = await this.dataSource.query<{ count: string }[]>(
      `
      SELECT COUNT(*)::int AS count FROM (
        SELECT user_id, SUM(file_size_bytes) AS total
        FROM (
          SELECT user_id::text AS user_id, file_size_bytes FROM myinfo_certs WHERE file_size_bytes IS NOT NULL
          UNION ALL
          SELECT user_id::text AS user_id, file_size_bytes FROM myinfo_awards WHERE file_size_bytes IS NOT NULL
          UNION ALL
          SELECT user_id::text AS user_id, file_size_bytes FROM myinfo_language_certs WHERE file_size_bytes IS NOT NULL
          UNION ALL
          SELECT user_id::text AS user_id, file_size_bytes FROM myinfo_documents WHERE file_size_bytes IS NOT NULL
          UNION ALL
          SELECT user_id::text AS user_id, file_size_bytes FROM myinfo_educations WHERE file_size_bytes IS NOT NULL
        ) all_files
        GROUP BY user_id
        HAVING SUM(file_size_bytes) >= $1
      ) near_cap
      `,
      [threshold],
    );
    return Number(result?.[0]?.count ?? 0);
  }

  async assertWithinLimit(
    userId: string,
    additionalBytes: number,
    manager: EntityManager,
  ): Promise<void> {
    const used = await this.calculateUsage(userId, manager);
    const limit = this.getLimitBytes();
    if (used + additionalBytes > limit) {
      const usedMB = Math.round(used / 1024 / 1024);
      const limitMB = Math.round(limit / 1024 / 1024);
      throw new BadRequestException(
        `저장 공간이 부족합니다 (현재 ${usedMB}MB / ${limitMB}MB).`,
      );
    }
  }
}
