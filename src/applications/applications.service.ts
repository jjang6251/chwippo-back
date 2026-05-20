import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepChecklistItem } from './step-checklist-item.entity';
import { CreateApplicationDto } from './dto/create-application.dto';
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
  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(StepChecklistItem)
    private readonly checklistRepo: Repository<StepChecklistItem>,
    private readonly dataSource: DataSource,
  ) {}

  async findAll(userId: string) {
    return this.appRepo.find({
      where: { userId },
      relations: ['steps'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(userId: string, id: string) {
    const app = await this.appRepo.findOne({
      where: { id, userId },
      relations: ['steps'],
    });
    if (!app) throw new NotFoundException('카드를 찾을 수 없습니다.');
    app.steps.sort((a, b) => a.orderIndex - b.orderIndex);
    return app;
  }

  // relations 없이 엔티티만 로드 (update 내부용 — cascade 충돌 방지)
  private async findEntity(userId: string, id: string) {
    const app = await this.appRepo.findOne({ where: { id, userId } });
    if (!app) throw new NotFoundException('카드를 찾을 수 없습니다.');
    return app;
  }

  async create(userId: string, dto: CreateApplicationDto) {
    const status = dto.status ?? 'IN_PROGRESS';

    return this.dataSource.transaction(async (em) => {
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

      return em.findOne(Application, {
        where: { id: saved.id },
        relations: ['steps'],
      });
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

    Object.assign(app, dtoWithoutDeadline);
    // needsDetail은 (status, jobTitle)에서 파생 — 명시적으로 보내지 않으면 재계산
    if (dto.needsDetail === undefined) {
      app.needsDetail =
        app.status === 'IN_PROGRESS' && !(app.jobTitle ?? '').trim();
    }
    await this.appRepo.save(app);

    // 저장 완료 후 스텝 생성 (cascade 영향 없음)
    if (wasPlanned && becomesInProgress) {
      const existingSteps = await this.stepRepo.count({
        where: { applicationId: id },
      });
      if (existingSteps === 0) {
        await this.createDefaultSteps(this.stepRepo.manager, id, null);
      }
    }

    // dto.deadline 받으면 첫 step.scheduled_date에 저장 (호환)
    if (deadlineSent) {
      const firstStep = await this.stepRepo.findOne({
        where: { applicationId: id, orderIndex: 0 },
      });
      if (firstStep) {
        firstStep.scheduledDate = dto.deadline
          ? new Date(`${dto.deadline}T00:00:00+09:00`)
          : null;
        await this.stepRepo.save(firstStep);
      }
    }

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

      return em.findOne(Application, { where: { id }, relations: ['steps'] });
    });
  }

  async remove(userId: string, id: string) {
    const app = await this.findEntity(userId, id);
    await this.appRepo.softRemove(app);
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
