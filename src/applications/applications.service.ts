import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { CoinService } from '../ai/coin.service';
import { CompaniesService } from '../companies/companies.service';
import { CompanyResearchService } from '../interview-prep/company-research.service';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepChecklistItem } from './step-checklist-item.entity';
import { CreateApplicationDto } from './dto/create-application.dto';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { UpdateStepsDto } from './dto/update-steps.dto';
import { UpdateStepDetailDto } from './dto/update-step-detail.dto';
import {
  CreateChecklistItemDto,
  UpdateChecklistItemDto,
} from './dto/checklist-item.dto';
import { stepsForTemplate } from './application-templates';

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);

  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(StepChecklistItem)
    private readonly checklistRepo: Repository<StepChecklistItem>,
    private readonly dataSource: DataSource,
    // PR_B1c — generateCoverletter (자소서 생성 시 회사조사 + 50 코인 차감)
    @Inject(forwardRef(() => CoinService))
    private readonly coinService: CoinService,
    @Inject(forwardRef(() => CompanyResearchService))
    private readonly companyResearch: CompanyResearchService,
    // W2 — domain inject (favicon 로딩)
    private readonly companiesService: CompaniesService,
    private readonly discord: DiscordNotifier,
  ) {}

  /** W2 — application 응답에 회사 domain inject (CompaniesService lookup, in-memory Map O(1)) */
  private withDomain<T extends Application | null | undefined>(app: T): T {
    if (!app) return app;
    app.domain = this.companiesService.getDomainByName(app.companyName);
    return app;
  }

  private withDomainAll(apps: Application[]): Application[] {
    return apps.map((a) => this.withDomain(a));
  }

  async findAll(userId: string) {
    const apps = await this.appRepo.find({
      where: { userId },
      relations: ['steps'],
      order: { createdAt: 'DESC' },
    });
    return this.withDomainAll(apps);
  }

  async findOne(userId: string, id: string) {
    const app = await this.appRepo.findOne({
      where: { id, userId },
      relations: ['steps'],
    });
    if (!app) throw new NotFoundException('카드를 찾을 수 없습니다.');
    app.steps.sort((a, b) => a.orderIndex - b.orderIndex);
    return this.withDomain(app);
  }

  // relations 없이 엔티티만 로드 (update 내부용 — cascade 충돌 방지)
  private async findEntity(userId: string, id: string) {
    const app = await this.appRepo.findOne({ where: { id, userId } });
    if (!app) throw new NotFoundException('카드를 찾을 수 없습니다.');
    return app;
  }

  async create(userId: string, dto: CreateApplicationDto) {
    const status = dto.status ?? 'IN_PROGRESS';

    return this.dataSource
      .transaction(async (em) => {
        const app = em.create(Application, {
          userId,
          companyName: dto.companyName,
          jobTitle: dto.jobTitle ?? null,
          jobCategory: dto.jobCategory ?? null,
          status,
          jobUrl: dto.jobUrl ?? null,
          needsDetail:
            dto.needsDetail ?? (status === 'IN_PROGRESS' && !dto.jobTitle),
        });
        const saved = await em.save(Application, app);

        if (status === 'IN_PROGRESS') {
          await this.createDefaultSteps(
            em,
            saved.id,
            dto.deadline,
            dto.templateId,
          );
        }

        const created = await em.findOne(Application, {
          where: { id: saved.id },
          relations: ['steps'],
        });
        return this.withDomain(created);
      })
      .then(async (result) => {
        // aha moment — 첫 실 카드 생성 시 growth 알림.
        // ⚠️ 이 create() 경로는 항상 실 카드 (샘플은 W1 가입 플로우가 별도 생성).
        // 판정은 count 의 is_sample=false 로 (샘플 카드 카운팅 제외 필수).
        // deleted_at 무관 전체 이력 기준 (삭제 후 재생성 시 재발송 방지) → withDeleted.
        try {
          const realCount = await this.appRepo.count({
            where: { userId, isSample: false },
            withDeleted: true,
          });
          if (realCount === 1) {
            void this.discord
              .notify(
                {
                  title: '🎯 첫 지원 카드 생성 (aha moment)',
                  color: DISCORD_COLORS.gold,
                  fields: [
                    { name: 'company', value: dto.companyName, inline: true },
                    { name: 'userId', value: userId, inline: true },
                  ],
                },
                'growth',
              )
              .catch(() => undefined);
          }
        } catch {
          // 집계 실패해도 카드 생성은 이미 완료 · 무시
        }
        return result;
      });
  }

  async update(userId: string, id: string, dto: UpdateApplicationDto) {
    // relations 없이 로드해야 cascade 충돌 방지
    const app = await this.findEntity(userId, id);

    const wasPlanned = app.status === 'PLANNED';
    const becomesInProgress = dto.status === 'IN_PROGRESS';
    // 데이터 모델 통합 — deadline은 application 컬럼에 저장하지 않음.
    // dto.deadline 받으면 첫 step.scheduled_date에만 저장 (호환).
    const deadlineSent = dto.deadline !== undefined;
    const dtoWithoutDeadline = { ...dto };
    delete dtoWithoutDeadline.deadline;

    // PR_B1c Phase D — 회사명/직무 변경 감지 (status='completed' 인데 회사조사 입력 변경 시 outdated 표시).
    //   동일 값 patch 는 무시 (memo·step 만 변경 시 outdated 안 됨).
    if (app.coverletterGenerationStatus === 'completed') {
      const companyChanged =
        dto.companyName !== undefined && dto.companyName !== app.companyName;
      const jobTitleChanged =
        dto.jobTitle !== undefined && dto.jobTitle !== app.jobTitle;
      const jobCategoryChanged =
        dto.jobCategory !== undefined && dto.jobCategory !== app.jobCategory;
      if (companyChanged || jobTitleChanged || jobCategoryChanged) {
        app.coverletterResearchOutdatedAt = new Date();
      }
    }

    Object.assign(app, dtoWithoutDeadline);
    // needsDetail은 (status, jobTitle)에서 파생 — 명시적으로 보내지 않으면 재계산
    if (dto.needsDetail === undefined) {
      app.needsDetail =
        app.status === 'IN_PROGRESS' && !(app.jobTitle ?? '').trim();
    }

    // 트랜잭션 wrap: app.save + (조건부) default steps 생성 + (조건부) firstStep.save 가
    // 부분 fail 시 (IN_PROGRESS 전환됐는데 step 0개 → UI 깨짐) 정합성 깨짐.
    await this.dataSource.transaction(async (em) => {
      await em.save(app);

      // 저장 완료 후 스텝 생성 (cascade 영향 없음)
      if (wasPlanned && becomesInProgress) {
        const existingSteps = await em.count(ApplicationStep, {
          where: { applicationId: id },
        });
        if (existingSteps === 0) {
          await this.createDefaultSteps(em, id, null);
        }
      }

      // dto.deadline 받으면 첫 step.scheduled_date에 저장 (호환)
      if (deadlineSent) {
        const firstStep = await em.findOne(ApplicationStep, {
          where: { applicationId: id, orderIndex: 0 },
        });
        if (firstStep) {
          firstStep.scheduledDate = dto.deadline
            ? new Date(`${dto.deadline}T00:00:00+09:00`)
            : null;
          await em.save(firstStep);
        }
      }
    });

    return this.findOne(userId, id);
  }

  async updateCurrentStep(userId: string, id: string, stepIndex: number) {
    const steps = await this.stepRepo.find({
      where: { applicationId: id },
      order: { orderIndex: 'ASC' },
    });

    // 권한 확인
    await this.findEntity(userId, id);

    if (stepIndex < 0 || stepIndex >= steps.length) {
      throw new ForbiddenException('유효하지 않은 스텝 인덱스입니다.');
    }

    const updateData: Partial<Application> = { currentStepIndex: stepIndex };
    if (stepIndex === steps.length - 1) {
      updateData.status = 'PASSED';
    }

    await this.appRepo.update(id, updateData);
    return this.findOne(userId, id);
  }

  /**
   * LRR P2T2 PR α (CRT-1 fix): step 재구성 시 체크리스트 보존.
   *
   * 기존 구현은 `em.delete(ApplicationStep, ...)`로 step row를 전부 hard-delete →
   * step-checklist-item FK가 `onDelete: 'CASCADE'`라 체크리스트도 모두 함께 삭제됐다
   * (사용자가 step 순서·이름만 바꿔도 모든 체크리스트 손실).
   *
   * 새 구현: dto step에 id가 있으면 기존 row 재사용 (update). dto에 없는 기존 step만 삭제
   * (그 step에 속한 체크리스트만 cascade로 삭제 — 의도된 동작). 신규 step은 INSERT.
   * notes·pinnedContent는 기존 row 그대로 보존.
   */
  async updateSteps(userId: string, id: string, dto: UpdateStepsDto) {
    await this.findEntity(userId, id);

    return this.dataSource.transaction(async (em) => {
      const existing = await em.find(ApplicationStep, {
        where: { applicationId: id },
      });
      const existingById = new Map(existing.map((s) => [s.id, s]));
      const incomingIds = new Set(
        dto.steps.map((s) => s.id).filter((v): v is string => Boolean(v)),
      );

      // 1. dto에 없는 기존 step → 삭제 (cascade로 그 step의 체크리스트만 함께 삭제)
      const toDelete = existing.filter((s) => !incomingIds.has(s.id));
      if (toDelete.length > 0) {
        await em.delete(
          ApplicationStep,
          toDelete.map((s) => s.id),
        );
      }

      // 2. dto step 순회 — id 있으면 update, 없으면 INSERT
      for (const s of dto.steps) {
        if (s.id && existingById.has(s.id)) {
          await em.update(ApplicationStep, s.id, {
            orderIndex: s.orderIndex,
            name: s.name,
            scheduledDate: s.scheduledDate ? new Date(s.scheduledDate) : null,
            location: s.location ?? null,
          });
        } else {
          const created = em.create(ApplicationStep, {
            applicationId: id,
            orderIndex: s.orderIndex,
            name: s.name,
            scheduledDate: s.scheduledDate ? new Date(s.scheduledDate) : null,
            location: s.location ?? null,
          });
          await em.save(ApplicationStep, created);
        }
      }

      const updated = await em.findOne(Application, {
        where: { id },
        relations: ['steps'],
      });
      return this.withDomain(updated);
    });
  }

  async remove(userId: string, id: string) {
    const app = await this.findEntity(userId, id);
    await this.appRepo.softRemove(app);
  }

  /**
   * W1 — 개별 sample 카드 숨김 (soft delete).
   * 진짜 카드 (is_sample=false) 시도 → 400 (일반 DELETE 사용).
   * 이미 deleted 카드 (findEntity 가 404) → 멱등 처리 없음 (사용자가 다시 본 적 없는 카드).
   */
  async dismissSample(userId: string, id: string) {
    const app = await this.findEntity(userId, id);
    if (!app.isSample) {
      throw new BadRequestException('진짜 카드는 일반 삭제를 사용해주세요.');
    }
    await this.appRepo.softRemove(app);
  }

  /**
   * PR_B1c — 자소서 생성 (회사조사 자동 trigger + 50 코인 차감).
   *
   * **흐름**:
   * 1. atomic UPDATE applications SET status='in_progress' WHERE id=? AND status IN ('idle','failed')
   *    affected=0 → 이미 진행 중·완료 (race 차단)
   * 2. canCharge (잔여 ≥ 50)
   *    부족 시 status='idle' 롤백
   * 3. CompanyResearchService.fetchForApplication 호출 (cache hit/miss 자동)
   *    - cache hit → LlmService 안 거침 → 수동 charge 호출
   *    - cache miss → LlmService 가 자동 charge (fixed_coin_cost=50 적용)
   * 4. 성공 → status='completed'
   * 5. 실패 → status='failed' (코인 차감 X)
   */
  async generateCoverletter(
    userId: string,
    applicationId: string,
  ): Promise<{
    status:
      | 'completed'
      | 'already_in_progress'
      | 'already_completed'
      | 'coin_insufficient'
      | 'failed';
    reason?: string;
  }> {
    // PR_B1c Phase C — lazy stuck timeout: in_progress 인데 30분 초과면 'failed' 처리.
    // 사용자가 진입할 때마다 즉시 좀비 해소. cron 은 background backup.
    await this.appRepo
      .createQueryBuilder()
      .update(Application)
      .set({ coverletterGenerationStatus: 'failed' })
      .where(
        `id = :id AND user_id = :userId AND coverletter_generation_status = 'in_progress' AND coverletter_generation_started_at < NOW() - INTERVAL '30 minutes'`,
        { id: applicationId, userId },
      )
      .execute();

    // PR_B1c Phase D — outdated 재조사 허용:
    //   atomic WHERE 의 allowed status 에 'completed' AND outdated_at not null 추가.
    //   사용자 application 의 회사명/직무 변경 후 재조사 trigger 가능.
    const updateResult = await this.appRepo
      .createQueryBuilder()
      .update(Application)
      .set({
        coverletterGenerationStatus: 'in_progress',
        coverletterGenerationStartedAt: () => 'NOW()',
      })
      .where(
        `id = :id AND user_id = :userId AND (coverletter_generation_status IN (:...allowed) OR (coverletter_generation_status = 'completed' AND coverletter_research_outdated_at IS NOT NULL))`,
        { id: applicationId, userId, allowed: ['idle', 'failed'] },
      )
      .execute();

    if (!updateResult.affected) {
      // application 없거나 이미 진행 중·완료
      const current = await this.appRepo.findOne({
        where: { id: applicationId, userId },
      });
      if (!current) throw new NotFoundException('카드를 찾을 수 없습니다.');
      if (current.coverletterGenerationStatus === 'in_progress') {
        return { status: 'already_in_progress' };
      }
      if (current.coverletterGenerationStatus === 'completed') {
        return { status: 'already_completed' };
      }
      throw new Error(
        `unexpected status: ${current.coverletterGenerationStatus}`,
      );
    }

    // 2. canCharge
    const coinCheck = await this.coinService.canCharge(
      userId,
      'company_research',
    );
    if (!coinCheck.ok) {
      // status='idle' 롤백
      await this.appRepo.update(
        { id: applicationId },
        {
          coverletterGenerationStatus: 'idle',
          coverletterGenerationStartedAt: null,
        },
      );
      return { status: 'coin_insufficient', reason: coinCheck.reason };
    }

    // 3. 회사조사 호출
    try {
      const result = await this.companyResearch.fetchForApplication(
        userId,
        applicationId,
      );

      // PR_B1c Phase B — result.status='ok' 만 정상 completed.
      // 'blocked' (moderation) / 'opt_out' (동의 안 함) → 실패 처리 + 코인 차감 X
      if (result.status !== 'ok') {
        await this.appRepo.update(
          { id: applicationId },
          { coverletterGenerationStatus: 'failed' },
        );
        throw new Error(
          result.reason ?? `회사 정보 조사 실패 (${result.status})`,
        );
      }

      // cache hit → 수동 charge (LlmService 안 거쳤음)
      if (result.isCached) {
        await this.coinService.charge(userId, 'company_research', {
          inputTokens: 0,
          outputTokens: 0,
        });
      }
      // cache miss → LlmService.call() 이 fixed_coin_cost=50 적용해 자동 charge

      // 4. 성공 — outdated_at NULL reset (재조사면 outdated 해소)
      //
      // PR_B1c CTO 검토 H1 — 좀비 in_progress 방지:
      //   여기서 UPDATE 실패하면 코인은 차감됐는데 status 가 'in_progress' 영구 잔류.
      //   사용자 무한 spinner + 재시도 차단 + 30분 cron 까지 막힘. 환불 + 'failed' 마킹.
      try {
        await this.appRepo.update(
          { id: applicationId },
          {
            coverletterGenerationStatus: 'completed',
            coverletterResearchOutdatedAt: null,
          },
        );
      } catch (completeErr) {
        this.logger.error(
          `[H1] status='completed' UPDATE 실패 — 좀비 방지: user=${userId} app=${applicationId} err=${(completeErr as Error).message}`,
        );
        // 코인 환불 (best-effort)
        await this.coinService
          .refund(userId, 'company_research', 'status=completed UPDATE 실패')
          .catch((refundErr) => {
            this.logger.error(
              `[H1] 환불 실패: user=${userId} err=${(refundErr as Error).message}`,
            );
          });
        // status='failed' 마킹 (best-effort, 실패 시 cron 이 30분 후 처리)
        await this.appRepo
          .update(
            { id: applicationId },
            { coverletterGenerationStatus: 'failed' },
          )
          .catch((failedErr) => {
            this.logger.error(
              `[H1] status='failed' UPDATE 도 실패 (cron 대기): err=${(failedErr as Error).message}`,
            );
          });
        throw completeErr;
      }
      return { status: 'completed' };
    } catch (err) {
      // 5. 실패 → status='failed' (코인 차감 X — fetchForApplication 단계 실패)
      await this.appRepo
        .update(
          { id: applicationId },
          { coverletterGenerationStatus: 'failed' },
        )
        .catch((failedErr) => {
          this.logger.error(
            `[generateCoverletter] catch 의 status='failed' UPDATE 실패: ${(failedErr as Error).message}`,
          );
        });
      throw err;
    }
  }

  private async createDefaultSteps(
    em: EntityManager,
    applicationId: string,
    deadline?: string | null,
    templateId?: string | null,
  ) {
    const steps = stepsForTemplate(templateId).map((name, i) =>
      em.create(ApplicationStep, {
        applicationId,
        orderIndex: i,
        name,
        scheduledDate: i === 0 && deadline ? new Date(deadline) : null,
      }),
    );
    await em.save(ApplicationStep, steps);
  }

  // --- Step detail (date/location) ---

  async updateStep(
    userId: string,
    appId: string,
    stepId: string,
    dto: UpdateStepDetailDto,
  ) {
    await this.findEntity(userId, appId);
    const step = await this.stepRepo.findOne({
      where: { id: stepId, applicationId: appId },
    });
    if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');

    if (dto.scheduledDate !== undefined) {
      step.scheduledDate = dto.scheduledDate
        ? new Date(dto.scheduledDate)
        : null;
    }
    if (dto.location !== undefined) {
      step.location = dto.location || null;
    }
    if (dto.notes !== undefined) {
      step.notes = dto.notes || null;
    }
    if (dto.pinnedContent !== undefined) {
      step.pinnedContent = dto.pinnedContent || null;
    }
    return this.stepRepo.save(step);
  }

  // --- Checklist CRUD ---

  async getChecklist(userId: string, appId: string, stepId: string) {
    await this.findEntity(userId, appId);
    const step = await this.stepRepo.findOne({
      where: { id: stepId, applicationId: appId },
    });
    if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');

    return this.checklistRepo.find({
      where: { stepId },
      order: { orderIndex: 'ASC', createdAt: 'ASC' },
    });
  }

  async createChecklistItem(
    userId: string,
    appId: string,
    stepId: string,
    dto: CreateChecklistItemDto,
  ) {
    await this.findEntity(userId, appId);
    const step = await this.stepRepo.findOne({
      where: { id: stepId, applicationId: appId },
    });
    if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');

    const maxOrder = await this.checklistRepo
      .createQueryBuilder('item')
      .select('MAX(item.orderIndex)', 'max')
      .where('item.stepId = :stepId', { stepId })
      .getRawOne<{ max: number | null }>();

    const item = this.checklistRepo.create({
      stepId,
      content: dto.content,
      orderIndex: dto.orderIndex ?? (maxOrder?.max ?? -1) + 1,
    });
    return this.checklistRepo.save(item);
  }

  async updateChecklistItem(
    userId: string,
    appId: string,
    stepId: string,
    itemId: string,
    dto: UpdateChecklistItemDto,
  ) {
    // LRR P2T2 PR β (HI-1): stepId가 appId 소속인지 검증 (createChecklistItem 패턴과 일치)
    await this.findEntity(userId, appId);
    const step = await this.stepRepo.findOne({
      where: { id: stepId, applicationId: appId },
    });
    if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');

    const item = await this.checklistRepo.findOne({
      where: { id: itemId, stepId },
    });
    if (!item) throw new NotFoundException('항목을 찾을 수 없습니다.');

    Object.assign(item, dto);
    return this.checklistRepo.save(item);
  }

  async deleteChecklistItem(
    userId: string,
    appId: string,
    stepId: string,
    itemId: string,
  ) {
    // LRR P2T2 PR β (HI-1): stepId가 appId 소속인지 검증
    await this.findEntity(userId, appId);
    const step = await this.stepRepo.findOne({
      where: { id: stepId, applicationId: appId },
    });
    if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');

    const item = await this.checklistRepo.findOne({
      where: { id: itemId, stepId },
    });
    if (!item) throw new NotFoundException('항목을 찾을 수 없습니다.');
    await this.checklistRepo.remove(item);
  }
}
