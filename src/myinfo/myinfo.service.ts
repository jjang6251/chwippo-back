import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, DeepPartial, Repository } from 'typeorm';
import { UserProfile } from './entities/user-profile.entity';
import { LanguageCert } from './entities/language-cert.entity';
import { Cert } from './entities/cert.entity';
import { Award } from './entities/award.entity';
import { Experience } from './entities/experience.entity';
import { Coverletter } from './entities/coverletter.entity';
import { CoverletterCustom } from './entities/coverletter-custom.entity';
import { Document } from './entities/document.entity';
import { Education } from './entities/education.entity';
import { StorageUsageService } from './storage-usage.service';
import { FilesService } from '../files/files.service';
import { ITEM_LABELS, ITEM_LIMITS } from './limits.const';

type FileBearing = {
  file_url?: string | null;
  file_size_bytes?: number | null;
};

@Injectable()
export class MyinfoService {
  constructor(
    @InjectRepository(UserProfile) private profileRepo: Repository<UserProfile>,
    @InjectRepository(LanguageCert)
    private langCertRepo: Repository<LanguageCert>,
    @InjectRepository(Cert) private certRepo: Repository<Cert>,
    @InjectRepository(Award) private awardRepo: Repository<Award>,
    @InjectRepository(Experience) private expRepo: Repository<Experience>,
    @InjectRepository(Coverletter) private coverRepo: Repository<Coverletter>,
    @InjectRepository(Document) private documentRepo: Repository<Document>,
    @InjectRepository(CoverletterCustom)
    private coverCustomRepo: Repository<CoverletterCustom>,
    @InjectRepository(Education) private educationRepo: Repository<Education>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storageUsage: StorageUsageService,
    private readonly filesService: FilesService,
  ) {}

  /**
   * 파일 첨부 가능 항목의 트랜잭션 INSERT.
   * 사용자 row 락 → 항목 수 한도 → storage cap → INSERT. 실패 시 R2 cleanup.
   */
  private async createWithLocks<T extends FileBearing>(opts: {
    userId: string;
    entityClass: new () => T;
    data: Partial<T>;
    limitKey: keyof typeof ITEM_LIMITS;
  }): Promise<T> {
    const { userId, entityClass, data, limitKey } = opts;
    const fileSize = data.file_size_bytes ?? 0;
    const fileUrl = data.file_url ?? null;

    // LRR P1T2 M-2: 다른 사용자 파일 URL attach 차단
    if (fileUrl) {
      this.filesService.assertOwnFileUrl(userId, fileUrl);
    }

    try {
      return await this.dataSource.transaction<T>(async (manager) => {
        // 1. 사용자 row 락 — 사용자별 mutex
        await manager.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
          userId,
        ]);

        // 2. 항목 수 한도
        const repo = manager.getRepository(entityClass);
        const count = await repo.count({ where: { user_id: userId } as never });
        const limit = ITEM_LIMITS[limitKey];
        if (count >= limit) {
          throw new BadRequestException(
            `${ITEM_LABELS[limitKey]}은(는) 최대 ${limit}개까지 등록 가능합니다.`,
          );
        }

        // 3. storage cap (파일 첨부 시만)
        if (fileSize > 0) {
          await this.storageUsage.assertWithinLimit(userId, fileSize, manager);
        }

        // 4. INSERT
        const payload = {
          ...data,
          user_id: userId,
        } as unknown as DeepPartial<T>;
        const entity = repo.create(payload);
        const saved: T = await repo.save<T>(entity);
        return saved;
      });
    } catch (err) {
      // 실패 시 R2 cleanup (이미 업로드된 파일이 있다면)
      if (fileUrl) {
        await this.filesService.deleteFile(fileUrl);
      }
      throw err;
    }
  }

  /**
   * 파일 첨부 항목 업데이트. file_url 교체 시 이전 R2 파일 삭제.
   */
  private async updateWithFileSwap<T extends FileBearing>(opts: {
    userId: string;
    id: string;
    entityClass: new () => T;
    repo: Repository<T>;
    data: Partial<T>;
  }): Promise<T | null> {
    const { userId, id, entityClass, repo, data } = opts;
    const newFileSize = data.file_size_bytes;
    const newFileUrl = data.file_url;

    // LRR P1T2 M-2: 새 파일 첨부 시 본인 prefix 검증 (null=파일 제거 의도라 skip)
    if (newFileUrl) {
      this.filesService.assertOwnFileUrl(userId, newFileUrl);
    }

    // 파일이 교체되는 경우만 트랜잭션 + cap 검증
    if (newFileUrl !== undefined && newFileSize !== undefined) {
      let oldFileUrlToCleanup: string | null = null;
      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
            userId,
          ]);

          const txRepo = manager.getRepository(entityClass);
          const existing = await txRepo.findOne({
            where: { id, user_id: userId } as never,
          });
          if (!existing) {
            throw new BadRequestException('항목을 찾을 수 없습니다.');
          }

          // 새 파일 크기 - 기존 파일 크기 = 순증가
          const oldSize = existing.file_size_bytes ?? 0;
          const delta = (newFileSize ?? 0) - oldSize;
          if (delta > 0) {
            await this.storageUsage.assertWithinLimit(userId, delta, manager);
          }

          await txRepo.update({ id, user_id: userId } as never, data as never);

          // 기존 파일이 다르면 트랜잭션 커밋 후 R2에서 삭제 (closure로 캡처)
          if (existing.file_url && existing.file_url !== newFileUrl) {
            oldFileUrlToCleanup = existing.file_url;
          }
        });
        if (oldFileUrlToCleanup) {
          await this.filesService.deleteFile(oldFileUrlToCleanup);
        }
      } catch (err) {
        // 트랜잭션 실패 시 새로 업로드된 R2 파일 cleanup
        if (newFileUrl) {
          await this.filesService.deleteFile(newFileUrl);
        }
        throw err;
      }
    } else {
      // 파일 변경 없음 — 단순 UPDATE
      await repo.update({ id, user_id: userId } as never, data as never);
    }

    return repo.findOne({ where: { id, user_id: userId } as never });
  }

  /**
   * 파일 첨부 항목 삭제. R2 파일도 함께 삭제 (best-effort).
   */
  private async deleteWithFileCleanup<T extends FileBearing>(opts: {
    userId: string;
    id: string;
    repo: Repository<T>;
  }): Promise<void> {
    const { userId, id, repo } = opts;
    const existing = await repo.findOne({
      where: { id, user_id: userId } as never,
    });
    await repo.delete({ id, user_id: userId } as never);
    if (existing && (existing as unknown as FileBearing).file_url) {
      await this.filesService.deleteFile(
        (existing as unknown as FileBearing).file_url as string,
      );
    }
  }

  // ── Educations ────────────────────────────────────────────
  async getEducations(userId: string) {
    return this.educationRepo.find({
      where: { user_id: userId },
      order: { start_at: 'DESC' },
    });
  }
  async createEducation(userId: string, dto: Partial<Education>) {
    return this.createWithLocks({
      userId,
      entityClass: Education,
      data: dto,
      limitKey: 'education',
    });
  }
  async updateEducation(userId: string, id: string, dto: Partial<Education>) {
    return this.updateWithFileSwap({
      userId,
      id,
      entityClass: Education,
      repo: this.educationRepo,
      data: dto,
    });
  }
  async deleteEducation(userId: string, id: string) {
    await this.deleteWithFileCleanup({
      userId,
      id,
      repo: this.educationRepo,
    });
  }

  // ── Profile ──────────────────────────────────────────────
  async getProfile(userId: string): Promise<UserProfile> {
    const profile = await this.profileRepo.findOne({
      where: { user_id: userId },
    });
    if (!profile) {
      const fresh = this.profileRepo.create({ user_id: userId });
      return this.profileRepo.save(fresh);
    }
    return profile;
  }

  async updateProfile(
    userId: string,
    dto: Partial<UserProfile>,
  ): Promise<UserProfile> {
    await this.profileRepo.upsert({ ...dto, user_id: userId }, ['user_id']);
    return this.getProfile(userId);
  }

  // ── Language Certs ────────────────────────────────────────
  async getLangCerts(userId: string) {
    return this.langCertRepo.find({
      where: { user_id: userId },
      order: { acquired_at: 'DESC' },
    });
  }
  async createLangCert(userId: string, dto: Partial<LanguageCert>) {
    return this.createWithLocks({
      userId,
      entityClass: LanguageCert,
      data: dto,
      limitKey: 'languageCert',
    });
  }
  async updateLangCert(userId: string, id: string, dto: Partial<LanguageCert>) {
    return this.updateWithFileSwap({
      userId,
      id,
      entityClass: LanguageCert,
      repo: this.langCertRepo,
      data: dto,
    });
  }
  async deleteLangCert(userId: string, id: string) {
    await this.deleteWithFileCleanup({
      userId,
      id,
      repo: this.langCertRepo,
    });
  }

  // ── Certs ─────────────────────────────────────────────────
  async getCerts(userId: string) {
    return this.certRepo.find({
      where: { user_id: userId },
      order: { acquired_at: 'DESC' },
    });
  }
  async createCert(userId: string, dto: Partial<Cert>) {
    return this.createWithLocks({
      userId,
      entityClass: Cert,
      data: dto,
      limitKey: 'cert',
    });
  }
  async updateCert(userId: string, id: string, dto: Partial<Cert>) {
    return this.updateWithFileSwap({
      userId,
      id,
      entityClass: Cert,
      repo: this.certRepo,
      data: dto,
    });
  }
  async deleteCert(userId: string, id: string) {
    await this.deleteWithFileCleanup({ userId, id, repo: this.certRepo });
  }

  // ── Awards ────────────────────────────────────────────────
  async getAwards(userId: string) {
    return this.awardRepo.find({
      where: { user_id: userId },
      order: { awarded_at: 'DESC' },
    });
  }
  async createAward(userId: string, dto: Partial<Award>) {
    return this.createWithLocks({
      userId,
      entityClass: Award,
      data: dto,
      limitKey: 'award',
    });
  }
  async updateAward(userId: string, id: string, dto: Partial<Award>) {
    return this.updateWithFileSwap({
      userId,
      id,
      entityClass: Award,
      repo: this.awardRepo,
      data: dto,
    });
  }
  async deleteAward(userId: string, id: string) {
    await this.deleteWithFileCleanup({ userId, id, repo: this.awardRepo });
  }

  // ── Experiences (파일 없음, 항목 수 한도만) ────────────────
  async getExperiences(userId: string) {
    return this.expRepo.find({
      where: { user_id: userId },
      order: { start_at: 'DESC' },
    });
  }
  async createExperience(userId: string, dto: Partial<Experience>) {
    // LRR P1T2 L-1 / P2T2 PR γ: createWithLocks 패턴 통일 — count+save race 차단
    // (experience는 file 필드 없음 → createWithLocks의 storage·ownership 분기 자동 skip)
    return this.createWithLocks<Experience & FileBearing>({
      userId,
      entityClass: Experience,
      data: dto,
      limitKey: 'experience',
    });
  }
  async updateExperience(userId: string, id: string, dto: Partial<Experience>) {
    const result = await this.expRepo.update({ id, user_id: userId }, dto);
    // LRR P2T2 PR γ (LOW-2): affected 0 → 404 일관성
    if (result.affected === 0) {
      throw new NotFoundException('항목을 찾을 수 없습니다.');
    }
    return this.expRepo.findOne({ where: { id, user_id: userId } });
  }
  async deleteExperience(userId: string, id: string) {
    const result = await this.expRepo.delete({ id, user_id: userId });
    if (result.affected === 0) {
      throw new NotFoundException('항목을 찾을 수 없습니다.');
    }
  }

  // ── Coverletter ───────────────────────────────────────────
  async getCoverletter(userId: string) {
    const cl = await this.coverRepo.findOne({ where: { user_id: userId } });
    const custom = await this.coverCustomRepo.find({
      where: { user_id: userId },
      order: { order_index: 'ASC' },
    });
    return { coverletter: cl ?? { user_id: userId }, custom };
  }

  async updateCoverletter(userId: string, dto: Partial<Coverletter>) {
    await this.coverRepo.upsert({ ...dto, user_id: userId }, ['user_id']);
    return this.coverRepo.findOne({ where: { user_id: userId } });
  }

  async createCustomItem(userId: string, label: string, order_index: number) {
    const count = await this.coverCustomRepo.count({
      where: { user_id: userId },
    });
    if (count >= ITEM_LIMITS.coverletterCustom) {
      throw new BadRequestException(
        `${ITEM_LABELS.coverletterCustom}은(는) 최대 ${ITEM_LIMITS.coverletterCustom}개까지 등록 가능합니다.`,
      );
    }
    return this.coverCustomRepo.save(
      this.coverCustomRepo.create({
        user_id: userId,
        label,
        order_index,
        content: '',
      }),
    );
  }

  async updateCustomItem(
    userId: string,
    id: string,
    dto: Partial<CoverletterCustom>,
  ) {
    // LRR P2T2 PR γ (LOW-2): affected 0 → 404 일관성
    const result = await this.coverCustomRepo.update(
      { id, user_id: userId },
      dto,
    );
    if (result.affected === 0) {
      throw new NotFoundException('항목을 찾을 수 없습니다.');
    }
    return this.coverCustomRepo.findOne({ where: { id, user_id: userId } });
  }

  async deleteCustomItem(userId: string, id: string) {
    const result = await this.coverCustomRepo.delete({ id, user_id: userId });
    if (result.affected === 0) {
      throw new NotFoundException('항목을 찾을 수 없습니다.');
    }
  }

  // ── Documents (file_url required) ─────────────────────────
  async getDocuments(userId: string) {
    return this.documentRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
  }

  async createDocument(
    userId: string,
    dto: {
      title: string;
      category?: string;
      file_url: string;
      file_size_bytes?: number;
    },
  ) {
    return this.createWithLocks({
      userId,
      entityClass: Document,
      data: dto,
      limitKey: 'document',
    });
  }

  async deleteDocument(userId: string, id: string) {
    await this.deleteWithFileCleanup({ userId, id, repo: this.documentRepo });
  }

  /**
   * F6 PR 1 — AI 컨텍스트 빌더용 PII-safe dump (ADR-019 + ADR-027).
   *
   * **제외**:
   * - `user-profile` (이름·전화·이메일 등 PII) — 전체 제외
   * - `documents` (R2 파일 메타만, 본문 unavailable) — 제외
   * - `exam-schedules` (시험 일정, AI 컨텍스트 가치 낮음) — 제외
   * - 모든 entity 의 `file_url`·`file_size_bytes` (파일은 별도 OCR 인프라 필요) — 자연히 제외
   *
   * **포함** (우선순위 순, ADR-019):
   * 1. coverletter (직접 입력 자소서 소재 6 카테고리 + custom)
   * 2. experiences (경력·활동)
   * 3. educations (학력)
   * 4. certs + language_certs (자격증)
   * 5. awards (수상)
   *
   * PII 제거를 1차로 entity 선택 단계에서 (이 함수), 2차로 LlmService 진입점 정규식 12종 스크럽 (이중 방어).
   */
  async getSafeDumpForAi(userId: string): Promise<{
    coverletterDrafts: Array<{
      category: string | null;
      question: string;
      answer: string;
    }>;
    experiences: Array<{
      company: string;
      role: string | null;
      period: string | null;
      summary: string | null;
    }>;
    educations: Array<{
      school: string;
      major: string | null;
      period: string | null;
    }>;
    certs: Array<{ name: string; score: string | null }>;
    awards: Array<{ name: string; org: string | null }>;
  }> {
    const [
      coverletter,
      customs,
      experiences,
      educations,
      certs,
      langCerts,
      awards,
    ] = await Promise.all([
      this.coverRepo.findOne({ where: { user_id: userId } }),
      this.coverCustomRepo.find({
        where: { user_id: userId },
        order: { order_index: 'ASC' },
      }),
      this.expRepo.find({ where: { user_id: userId } }),
      this.educationRepo.find({ where: { user_id: userId } }),
      this.certRepo.find({ where: { user_id: userId } }),
      this.langCertRepo.find({ where: { user_id: userId } }),
      this.awardRepo.find({ where: { user_id: userId } }),
    ]);

    // 자소서 소재 — 6 카테고리 표준 + custom 라벨
    const draftItems: Array<{
      category: string | null;
      question: string;
      answer: string;
    }> = [];
    if (coverletter) {
      const fixed = [
        ['personality', '성격 장단점', coverletter.personality],
        ['background', '성장 배경', coverletter.background],
        ['job_competency', '직무 역량·핵심 경험', coverletter.job_competency],
        ['own_strength', '나만의 강점', coverletter.own_strength],
        ['collaboration', '갈등 해결·협업 경험', coverletter.collaboration],
        ['challenge', '도전·실패 경험', coverletter.challenge],
      ] as const;
      for (const [cat, label, body] of fixed) {
        if (body && body.trim().length > 0) {
          draftItems.push({ category: cat, question: label, answer: body });
        }
      }
    }
    for (const c of customs) {
      if (c.content && c.content.trim().length > 0) {
        draftItems.push({
          category: 'custom',
          question: c.label,
          answer: c.content,
        });
      }
    }

    const fmtPeriod = (s: string | null, e: string | null): string | null => {
      if (!s && !e) return null;
      return `${s ?? '?'} ~ ${e ?? '진행 중'}`;
    };

    return {
      coverletterDrafts: draftItems,
      experiences: experiences.map((e) => ({
        company: e.org ?? e.activity_name,
        role: e.activity_name && e.org ? e.activity_name : null,
        period: fmtPeriod(e.start_at, e.end_at),
        summary: e.content ?? null,
      })),
      educations: educations.map((ed) => ({
        school: ed.school_name,
        major: ed.major ?? null,
        period: fmtPeriod(ed.start_at, ed.end_at),
      })),
      certs: [
        ...certs.map((c) => ({ name: c.name, score: null })),
        ...langCerts.map((l) => ({
          name: l.cert_type,
          score: l.score_grade ?? null,
        })),
      ],
      awards: awards.map((a) => ({
        name: a.award_name ?? a.contest_name,
        org: a.org ?? null,
      })),
    };
  }
}
