import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
  ) {}

  async getStats(userId: string) {
    const [inProgress, passed, failed] = await Promise.all([
      this.appRepo.count({ where: { userId, status: 'IN_PROGRESS', deletedAt: IsNull() } }),
      this.appRepo.count({ where: { userId, status: 'PASSED', deletedAt: IsNull() } }),
      this.appRepo.count({ where: { userId, status: 'FAILED', deletedAt: IsNull() } }),
    ]);

    // 현재 스텝에 '면접'이 포함된 IN_PROGRESS 카드 수
    const interviews = await this.appRepo
      .createQueryBuilder('app')
      .innerJoin(
        'application_steps',
        's',
        's.application_id = app.id AND s.order_index = app.current_step_index',
      )
      .where('app.user_id = :userId', { userId })
      .andWhere('app.status = :status', { status: 'IN_PROGRESS' })
      .andWhere('app.deleted_at IS NULL')
      .andWhere("s.name LIKE '%면접%'")
      .getCount();

    return { total: inProgress + passed + failed, interviews, passed };
  }

  async getDdayList(userId: string) {
    const today = new Date().toISOString().split('T')[0];

    // 서류 마감 목록
    const apps = await this.appRepo
      .createQueryBuilder('app')
      .where('app.user_id = :userId', { userId })
      .andWhere('app.status = :status', { status: 'IN_PROGRESS' })
      .andWhere('app.deleted_at IS NULL')
      .andWhere('app.deadline IS NOT NULL')
      .andWhere('app.deadline >= :today', { today })
      .select(['app.id', 'app.companyName', 'app.deadline'])
      .getMany();

    // 면접 일정 목록
    const steps = await this.stepRepo
      .createQueryBuilder('step')
      .innerJoin('step.application', 'app')
      .where('app.user_id = :userId', { userId })
      .andWhere('app.status = :status', { status: 'IN_PROGRESS' })
      .andWhere('app.deleted_at IS NULL')
      .andWhere('step.scheduledDate IS NOT NULL')
      .andWhere('CAST(step.scheduledDate AS DATE) >= :today', { today })
      .select(['step.id', 'step.name', 'step.scheduledDate', 'step.applicationId'])
      .addSelect(['app.id', 'app.companyName'])
      .getMany();

    const todayMs = new Date(today).getTime();

    const items: {
      type: 'deadline' | 'interview';
      applicationId: string;
      companyName: string;
      stepName?: string;
      date: string;
      dday: number;
    }[] = [];

    for (const app of apps) {
      const dateMs = new Date(app.deadline!).getTime();
      const dday = Math.round((dateMs - todayMs) / 86400000);
      items.push({ type: 'deadline', applicationId: app.id, companyName: app.companyName, date: app.deadline!, dday });
    }

    for (const step of steps) {
      const dateStr = new Date(step.scheduledDate!).toISOString().split('T')[0];
      const dateMs = new Date(dateStr).getTime();
      const dday = Math.round((dateMs - todayMs) / 86400000);
      items.push({
        type: 'interview',
        applicationId: step.applicationId,
        companyName: (step as any).app_company_name ?? step.application?.companyName ?? '',
        stepName: step.name,
        date: dateStr,
        dday,
      });
    }

    return items.sort((a, b) => a.dday - b.dday).slice(0, 5);
  }
}
