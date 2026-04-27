import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { UpdateStepsDto } from './dto/update-steps.dto';

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
      const saved = await em.save(app);

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
    const app = await this.findOne(userId, id);

    // PLANNED -> IN_PROGRESS 전환 시 기본 스텝 생성
    const wasPlanned = app.status === 'PLANNED';
    const becomesInProgress = dto.status === 'IN_PROGRESS';

    Object.assign(app, dto);

    if (wasPlanned && becomesInProgress) {
      const existingSteps = await this.stepRepo.count({ where: { applicationId: id } });
      if (existingSteps === 0) {
        await this.createDefaultSteps(this.dataSource.manager, id);
      }
    }

    await this.appRepo.save(app);
    return this.findOne(userId, id);
  }

  async updateCurrentStep(userId: string, id: string, stepIndex: number) {
    const app = await this.findOne(userId, id);
    const steps = app.steps.sort((a, b) => a.orderIndex - b.orderIndex);

    if (stepIndex < 0 || stepIndex >= steps.length) {
      throw new ForbiddenException('유효하지 않은 스텝 인덱스입니다.');
    }

    app.currentStepIndex = stepIndex;

    // 마지막 스텝 완료 -> PASSED
    if (stepIndex === steps.length - 1) {
      app.status = 'PASSED';
    }

    await this.appRepo.save(app);
    return app;
  }

  async updateSteps(userId: string, id: string, dto: UpdateStepsDto) {
    await this.findOne(userId, id); // 권한 확인

    return this.dataSource.transaction(async (em) => {
      await em.delete(ApplicationStep, { applicationId: id });
      const steps = dto.steps.map((s) =>
        em.create(ApplicationStep, {
          applicationId: id,
          orderIndex: s.orderIndex,
          name: s.name,
          scheduledDate: s.scheduledDate ? new Date(s.scheduledDate) : null,
          location: s.location ?? null,
        }),
      );
      await em.save(steps);
      return em.findOne(Application, { where: { id }, relations: ['steps'] });
    });
  }

  async remove(userId: string, id: string) {
    const app = await this.findOne(userId, id);
    await this.appRepo.softRemove(app);
  }

  private async createDefaultSteps(em: any, applicationId: string) {
    const steps = DEFAULT_STEPS.map((name, i) =>
      em.create(ApplicationStep, { applicationId, orderIndex: i, name }),
    );
    await em.save(steps);
  }
}
