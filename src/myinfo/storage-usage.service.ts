import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Cert } from './entities/cert.entity';
import { Award } from './entities/award.entity';
import { LanguageCert } from './entities/language-cert.entity';
import { Document } from './entities/document.entity';
import { Education } from './entities/education.entity';

/**
 * 100MB 풀을 **어디가 채웠는지**. `usedBytes` 는 항상 이 값들의 합이다.
 *
 * 분해가 필요한 이유: 노트 첨부가 같은 풀에 합류한 뒤로 "용량 부족" 만 보고는
 * 내정보 증빙을 지워야 할지 노트 이미지를 지워야 할지 알 수 없다.
 *
 * `noteImageBytes` 는 필기 stroke(`strokes_size_bytes`)까지 포함한다 —
 * cap 합산 규약(`ATTACHMENT_SUM_SQL`)과 같은 경계를 쓴다.
 */
export interface StorageUsageBreakdown {
  myinfoBytes: number;
  noteImageBytes: number;
}

export interface StorageUsage {
  usedBytes: number;
  limitBytes: number;
  usedMB: number;
  limitMB: number;
  percentage: number;
  breakdown: StorageUsageBreakdown;
}

/**
 * 공부 노트 첨부(`note_attachments`) 한 사용자분 합계 — **파일 + 필기 stroke 둘 다.**
 *
 * myinfo 5테이블처럼 repo 루프에 못 섞는 이유: 이 테이블만 크기 컬럼이 둘이다
 * (`file_size_bytes` NOT NULL + `strokes_size_bytes` NULL). 지금 stroke 는 항상 NULL
 * 이지만(PR-C 보류) 처음부터 더해 둔다 — 나중에 더하기를 빠뜨리면 조용히 새는 쪽이
 * 훨씬 비싸고, 그때는 이미 사용자 데이터가 한도를 넘어 있다.
 */
const ATTACHMENT_SUM_SQL = `
  SELECT COALESCE(SUM(file_size_bytes), 0) + COALESCE(SUM(strokes_size_bytes), 0) AS total
    FROM note_attachments
`;

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
   * 사용자의 현재 사용량을 **출처별로** 계산. 쿼리·순서·manager 사용은 총량 계산과 동일하다
   * (cap 검증이 이 경로를 그대로 탄다 — 락 밖에서 읽는 경로가 생기면 안 된다).
   *
   * @param manager 트랜잭션 내에서 호출할 경우 EntityManager 전달 — 락 보호하에 일관된 값 반환
   */
  private async calculateBreakdown(
    userId: string,
    manager?: EntityManager,
  ): Promise<StorageUsageBreakdown> {
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

    let myinfoBytes = 0;
    for (const repo of repos) {
      const result = await repo
        .createQueryBuilder('e')
        .select('COALESCE(SUM(e.file_size_bytes), 0)', 'total')
        .where('e.user_id = :userId', { userId })
        .getRawOne<{ total: string }>();
      myinfoBytes += Number(result?.total ?? 0);
    }

    // 공부 노트 첨부 — 트랜잭션 안이면 **같은 manager** 로 읽어야 락이 본 값과 일치한다
    const runner: EntityManager | DataSource = manager ?? this.dataSource;
    const attachments = await runner.query<{ total: string }[]>(
      `${ATTACHMENT_SUM_SQL} WHERE user_id = $1`,
      [userId],
    );
    const noteImageBytes = Number(attachments?.[0]?.total ?? 0);

    return { myinfoBytes, noteImageBytes };
  }

  /**
   * 사용자의 현재 총 사용량 계산.
   * @param manager 트랜잭션 내에서 호출할 경우 EntityManager 전달 — 락 보호하에 일관된 값 반환
   */
  async calculateUsage(
    userId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const { myinfoBytes, noteImageBytes } = await this.calculateBreakdown(
      userId,
      manager,
    );
    return myinfoBytes + noteImageBytes;
  }

  async getUsage(userId: string): Promise<StorageUsage> {
    const breakdown = await this.calculateBreakdown(userId);
    const used = breakdown.myinfoBytes + breakdown.noteImageBytes;
    const limit = this.getLimitBytes();
    return {
      usedBytes: used,
      limitBytes: limit,
      usedMB: Math.round((used / 1024 / 1024) * 10) / 10,
      limitMB: Math.round(limit / 1024 / 1024),
      percentage: limit === 0 ? 0 : Math.round((used / limit) * 100),
      breakdown,
    };
  }

  /**
   * 사용자의 모든 파일 URL 수집 (myinfo 증빙 + 공부 노트 첨부). 탈퇴 시 R2 cascade 정리용.
   *
   * 🔴 DB 행은 FK CASCADE 가 지우지만 R2 객체는 아무도 안 지운다 — 여기 빠진 테이블은
   * 탈퇴한 사용자의 파일이 버킷에 영원히 남는다. 새 파일 테이블을 만들면 여기가 의무다.
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

    // 공부 노트 첨부 — 이미지(file_url) 와 필기 stroke(strokes_url) 는 **별개 객체**다
    const attachments = await this.dataSource.query<
      { file_url: string; strokes_url: string | null }[]
    >(`SELECT file_url, strokes_url FROM note_attachments WHERE user_id = $1`, [
      userId,
    ]);
    for (const row of attachments ?? []) {
      if (row.file_url) urls.push(row.file_url);
      if (row.strokes_url) urls.push(row.strokes_url);
    }

    return urls;
  }

  /**
   * 트랜잭션 안에서 호출. 호출자가 미리 사용자 row 락을 잡은 상태여야 race 안전.
   * 한도 초과 시 BadRequestException 던짐.
   */
  /**
   * 전역 사용량 합계 — myinfo 5테이블 + 공부 노트 첨부의 SUM.
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

    const attachments =
      await this.dataSource.query<{ total: string }[]>(ATTACHMENT_SUM_SQL);
    total += Number(attachments?.[0]?.total ?? 0);

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
          UNION ALL
          SELECT user_id::text AS user_id, file_size_bytes FROM note_attachments WHERE file_size_bytes IS NOT NULL
          UNION ALL
          SELECT user_id::text AS user_id, strokes_size_bytes FROM note_attachments WHERE strokes_size_bytes IS NOT NULL
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
