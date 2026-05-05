import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepChecklistItem } from './step-checklist-item.entity';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { UpdateStepsDto } from './dto/update-steps.dto';
import { UpdateStepDetailDto } from './dto/update-step-detail.dto';
import { CreateChecklistItemDto, UpdateChecklistItemDto } from './dto/checklist-item.dto';

const DEFAULT_STEPS = [
  '서류 제출',
  '서류 발표',
  '1차 면접',
  '1차 결과 대기',
  '2차 면접',
  '2차 결과 대기',
  '최종 합격',
];

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
      order: { deadline: 'ASC', createdAt: 'DESC' },
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
        deadline: dto.deadline ?? null,
        jobUrl: dto.jobUrl ?? null,
        needsDetail: dto.needsDetail ?? (status === 'IN_PROGRESS' && !dto.jobTitle),
      });
      const saved = await em.save(Application, app);

      if (status === 'IN_PROGRESS') {
        await this.createDefaultSteps(em, saved.id);
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

    Object.assign(app, dto);
    await this.appRepo.save(app);

    // 저장 완료 후 스텝 생성 (cascade 영향 없음)
    if (wasPlanned && becomesInProgress) {
      const existingSteps = await this.stepRepo.count({ where: { applicationId: id } });
      if (existingSteps === 0) {
        await this.createDefaultSteps(this.stepRepo.manager, id);
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

  async updateSteps(userId: string, id: string, dto: UpdateStepsDto) {
    await this.findEntity(userId, id);

    return this.dataSource.transaction(async (em) => {
      // 기존 스텝의 notes/pinnedContent 보존: id가 전달된 경우 매핑
      const notesMap = new Map<string, { notes: string | null; pinnedContent: string | null }>();
      if (dto.steps.some((s) => s.id)) {
        const existing = await em.find(ApplicationStep, { where: { applicationId: id } });
        for (const step of existing) {
          notesMap.set(step.id, { notes: step.notes, pinnedContent: step.pinnedContent });
        }
      }

      await em.delete(ApplicationStep, { applicationId: id });

      const steps = dto.steps.map((s) => {
        const preserved = s.id ? notesMap.get(s.id) : undefined;
        return em.create(ApplicationStep, {
          applicationId: id,
          orderIndex: s.orderIndex,
          name: s.name,
          scheduledDate: s.scheduledDate ? new Date(s.scheduledDate) : null,
          location: s.location ?? null,
          notes: preserved?.notes ?? null,
          pinnedContent: preserved?.pinnedContent ?? null,
        });
      });

      await em.save(ApplicationStep, steps);
      return em.findOne(Application, { where: { id }, relations: ['steps'] });
    });
  }

  async remove(userId: string, id: string) {
    const app = await this.findEntity(userId, id);
    await this.appRepo.softRemove(app);
  }

  private async createDefaultSteps(em: any, applicationId: string) {
    const steps = DEFAULT_STEPS.map((name, i) =>
      em.create(ApplicationStep, { applicationId, orderIndex: i, name }),
    );
    await em.save(ApplicationStep, steps);
  }

  // --- Step detail (date/location) ---

  async updateStep(userId: string, appId: string, stepId: string, dto: UpdateStepDetailDto) {
    await this.findEntity(userId, appId);
    const step = await this.stepRepo.findOne({ where: { id: stepId, applicationId: appId } });
    if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');

    if (dto.scheduledDate !== undefined) {
      step.scheduledDate = dto.scheduledDate ? new Date(dto.scheduledDate) : null;
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
    const step = await this.stepRepo.findOne({ where: { id: stepId, applicationId: appId } });
    if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');

    return this.checklistRepo.find({
      where: { stepId },
      order: { orderIndex: 'ASC', createdAt: 'ASC' },
    });
  }

  async createChecklistItem(userId: string, appId: string, stepId: string, dto: CreateChecklistItemDto) {
    await this.findEntity(userId, appId);
    const step = await this.stepRepo.findOne({ where: { id: stepId, applicationId: appId } });
    if (!step) throw new NotFoundException('스텝을 찾을 수 없습니다.');

    const maxOrder = await this.checklistRepo
      .createQueryBuilder('item')
      .select('MAX(item.orderIndex)', 'max')
      .where('item.stepId = :stepId', { stepId })
      .getRawOne();

    const item = this.checklistRepo.create({
      stepId,
      content: dto.content,
      orderIndex: dto.orderIndex ?? ((maxOrder?.max ?? -1) + 1),
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
    await this.findEntity(userId, appId);
    const item = await this.checklistRepo.findOne({ where: { id: itemId, stepId } });
    if (!item) throw new NotFoundException('항목을 찾을 수 없습니다.');

    Object.assign(item, dto);
    return this.checklistRepo.save(item);
  }

  async deleteChecklistItem(userId: string, appId: string, stepId: string, itemId: string) {
    await this.findEntity(userId, appId);
    const item = await this.checklistRepo.findOne({ where: { id: itemId, stepId } });
    if (!item) throw new NotFoundException('항목을 찾을 수 없습니다.');
    await this.checklistRepo.remove(item);
  }
}
