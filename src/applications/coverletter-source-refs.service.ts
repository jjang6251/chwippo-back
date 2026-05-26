import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { ActivityReflection } from '../activity/entities/activity-reflection.entity';
import { Application } from './application.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { CoverletterSourceRef } from './coverletter-source-ref.entity';
import { CreateCoverletterSourceRefDto } from './dto/coverletter-source-ref.dto';

/**
 * F6 PR 1 — coverletter_source_refs CRUD + IDOR batch validation.
 *
 * **소유권 체인**: ref → coverletter → application → user (3-hop)
 * **source 검증**: ref.source_log_id 또는 ref.source_reflection_id 가 가리키는 row 의 userId 도 일치
 *
 * 외부 caller 가 사용하는 핵심 메서드:
 * - `assertOwnsCoverletter(userId, clId)` — cl 본인 소유 검증 (NotFound 던짐)
 * - `assertSelectedRefsBelongToUser(userId, refIds)` — IDOR batch (Critical #3, focus.md F6 PR 1)
 * - `loadRefsWithSources(refIds)` — ref + 매핑된 log/reflection 한 번에 조회 (컨텍스트 빌더 입력 생성)
 */
@Injectable()
export class CoverletterSourceRefsService {
  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationCoverletter)
    private readonly clRepo: Repository<ApplicationCoverletter>,
    @InjectRepository(CoverletterSourceRef)
    private readonly refRepo: Repository<CoverletterSourceRef>,
    @InjectRepository(ActivityLog)
    private readonly logRepo: Repository<ActivityLog>,
    @InjectRepository(ActivityReflection)
    private readonly reflRepo: Repository<ActivityReflection>,
  ) {}

  // ── IDOR 가드 ──

  /** cl → application → user 체인. 본인 소유 아니면 NotFound (정보 누출 방지 — Forbidden 보다 NotFound 우선) */
  async assertOwnsCoverletter(
    userId: string,
    coverletterId: string,
  ): Promise<ApplicationCoverletter> {
    const cl = await this.clRepo
      .createQueryBuilder('cl')
      .innerJoin('cl.application', 'app')
      .where('cl.id = :clId', { clId: coverletterId })
      .andWhere('app.user_id = :userId', { userId })
      .andWhere('app.deleted_at IS NULL')
      .getOne();
    if (!cl) throw new NotFoundException('자소서 문항을 찾을 수 없습니다.');
    return cl;
  }

  /**
   * IDOR batch validation (Critical #3).
   * selected_source_ref_ids[] 모두 (1) 본인 cl 에 속하고 (2) 본인 log/reflection 가리키는지 한 쿼리로 검증.
   * count mismatch 시 ForbiddenException (다른 사용자 ref 섞임 시도 차단).
   */
  async assertSelectedRefsBelongToUser(
    userId: string,
    coverletterId: string,
    refIds: string[],
  ): Promise<CoverletterSourceRef[]> {
    if (refIds.length === 0) return [];
    // 1차: ref 자체가 본인 cl 소속인지
    const refs = await this.refRepo
      .createQueryBuilder('ref')
      .innerJoin('ref.coverletter', 'cl')
      .innerJoin('cl.application', 'app')
      .where('ref.id IN (:...refIds)', { refIds })
      .andWhere('ref.coverletter_id = :clId', { clId: coverletterId })
      .andWhere('app.user_id = :userId', { userId })
      .getMany();

    if (refs.length !== refIds.length) {
      throw new ForbiddenException(
        '선택한 참조 중 본인의 것이 아닌 항목이 있습니다.',
      );
    }

    // 2차: ref 가 가리키는 log/reflection 도 본인 소유인지 (이중 방어)
    const logIds = refs
      .map((r) => r.sourceLogId)
      .filter((id): id is string => Boolean(id));
    const reflectionIds = refs
      .map((r) => r.sourceReflectionId)
      .filter((id): id is string => Boolean(id));

    if (logIds.length > 0) {
      const okCount = await this.logRepo.count({
        where: { id: In(logIds), userId },
      });
      if (okCount !== logIds.length) {
        throw new ForbiddenException(
          '선택한 활동 로그 중 본인의 것이 아닌 항목이 있습니다.',
        );
      }
    }
    if (reflectionIds.length > 0) {
      const okCount = await this.reflRepo.count({
        where: { id: In(reflectionIds), userId },
      });
      if (okCount !== reflectionIds.length) {
        throw new ForbiddenException(
          '선택한 회고 중 본인의 것이 아닌 항목이 있습니다.',
        );
      }
    }

    return refs;
  }

  // ── CRUD ──

  /** GET /coverletters/:clId/source-refs */
  async list(
    userId: string,
    coverletterId: string,
  ): Promise<CoverletterSourceRef[]> {
    await this.assertOwnsCoverletter(userId, coverletterId);
    return this.refRepo.find({
      where: { coverletterId },
      order: { createdAt: 'ASC' },
    });
  }

  /** POST /coverletters/:clId/source-refs — 사용자가 명시 추가 */
  async create(
    userId: string,
    coverletterId: string,
    dto: CreateCoverletterSourceRefDto,
  ): Promise<CoverletterSourceRef> {
    await this.assertOwnsCoverletter(userId, coverletterId);

    // XOR 가드 (DTO 도 검증하지만 service 단 명시)
    const hasLog = Boolean(dto.sourceLogId);
    const hasReflection = Boolean(dto.sourceReflectionId);
    if (hasLog === hasReflection) {
      throw new BadRequestException(
        'sourceLogId 또는 sourceReflectionId 중 정확히 하나만 제공해야 합니다.',
      );
    }

    // source 본인 소유 검증
    if (dto.sourceLogId) {
      const log = await this.logRepo.findOne({
        where: { id: dto.sourceLogId, userId },
      });
      if (!log) throw new NotFoundException('활동 로그를 찾을 수 없습니다.');
    }
    if (dto.sourceReflectionId) {
      const refl = await this.reflRepo.findOne({
        where: { id: dto.sourceReflectionId, userId },
      });
      if (!refl) throw new NotFoundException('회고를 찾을 수 없습니다.');
    }

    // 중복 UNIQUE — DB partial index 가 보장하지만 친절한 메시지 위해 사전 체크
    const dup = await this.refRepo.findOne({
      where: dto.sourceLogId
        ? { coverletterId, sourceLogId: dto.sourceLogId }
        : { coverletterId, sourceReflectionId: dto.sourceReflectionId! },
    });
    if (dup) {
      throw new BadRequestException('이미 추가된 참조입니다.');
    }

    const ref = this.refRepo.create({
      coverletterId,
      sourceLogId: dto.sourceLogId ?? null,
      sourceReflectionId: dto.sourceReflectionId ?? null,
      snippetText: dto.snippetText ?? null,
      partialRange: dto.partialRange ?? null,
      aiRecommended: dto.aiRecommended ?? false,
    });
    return this.refRepo.save(ref);
  }

  /** DELETE /coverletters/:clId/source-refs/:refId */
  async remove(
    userId: string,
    coverletterId: string,
    refId: string,
  ): Promise<void> {
    await this.assertOwnsCoverletter(userId, coverletterId);
    const ref = await this.refRepo.findOne({
      where: { id: refId, coverletterId },
    });
    if (!ref) throw new NotFoundException('참조를 찾을 수 없습니다.');
    await this.refRepo.delete({ id: refId });
  }

  // ── 내부 사용 (ai-draft service) ──

  /** ai-draft service 가 컨텍스트 빌더 입력 생성용으로 사용. refs 와 매핑된 log/reflection 한 번에 로드 */
  async loadRefsWithSources(refs: CoverletterSourceRef[]): Promise<{
    logs: Array<{ refId: string; log: ActivityLog }>;
    reflections: Array<{ refId: string; reflection: ActivityReflection }>;
  }> {
    const logIds = refs
      .map((r) => r.sourceLogId)
      .filter((id): id is string => Boolean(id));
    const reflectionIds = refs
      .map((r) => r.sourceReflectionId)
      .filter((id): id is string => Boolean(id));

    const [logs, reflections] = await Promise.all([
      logIds.length > 0
        ? this.logRepo.find({ where: { id: In(logIds) } })
        : Promise.resolve([] as ActivityLog[]),
      reflectionIds.length > 0
        ? this.reflRepo.find({ where: { id: In(reflectionIds) } })
        : Promise.resolve([] as ActivityReflection[]),
    ]);

    const logMap = new Map(logs.map((l) => [l.id, l]));
    const reflMap = new Map(reflections.map((r) => [r.id, r]));

    return {
      logs: refs
        .filter((r) => r.sourceLogId && logMap.has(r.sourceLogId))
        .map((r) => ({ refId: r.id, log: logMap.get(r.sourceLogId!)! })),
      reflections: refs
        .filter(
          (r) => r.sourceReflectionId && reflMap.has(r.sourceReflectionId),
        )
        .map((r) => ({
          refId: r.id,
          reflection: reflMap.get(r.sourceReflectionId!)!,
        })),
    };
  }

  /** ai-draft service 가 생성된 ref bulk insert 용 (자동 저장). aiRecommended flag 구분 */
  async bulkCreate(
    coverletterId: string,
    refs: Array<{
      sourceLogId?: string;
      sourceReflectionId?: string;
      aiRecommended: boolean;
    }>,
  ): Promise<CoverletterSourceRef[]> {
    if (refs.length === 0) return [];
    const entities = refs.map((r) =>
      this.refRepo.create({
        coverletterId,
        sourceLogId: r.sourceLogId ?? null,
        sourceReflectionId: r.sourceReflectionId ?? null,
        aiRecommended: r.aiRecommended,
      }),
    );
    // 개별 save 로 UNIQUE 충돌 시 1개씩 건너뛰기 (Promise.allSettled)
    const results = await Promise.allSettled(
      entities.map((e) => this.refRepo.save(e)),
    );
    return results
      .filter(
        (r): r is PromiseFulfilledResult<CoverletterSourceRef> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value);
  }
}
