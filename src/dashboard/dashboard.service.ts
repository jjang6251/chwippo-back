import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(ExamSchedule)
    private readonly examRepo: Repository<ExamSchedule>,
  ) {}

  async getStats(userId: string) {
    const [inProgress, passed, failed] = await Promise.all([
      this.appRepo.count({
        where: { userId, status: 'IN_PROGRESS', deletedAt: IsNull() },
      }),
      this.appRepo.count({
        where: { userId, status: 'PASSED', deletedAt: IsNull() },
      }),
      this.appRepo.count({
        where: { userId, status: 'FAILED', deletedAt: IsNull() },
      }),
    ]);

    // 면접 본 횟수 — '면접' 스텝 중 KST 기준 날짜가 오늘 이전인 것 (모든 비삭제 카드 대상)
    const KST = 9 * 60 * 60 * 1000;
    const today = new Date(Date.now() + KST).toISOString().split('T')[0];
    const interviewsAttended = await this.stepRepo
      .createQueryBuilder('step')
      .innerJoin('step.application', 'app')
      .where('app.user_id = :userId', { userId })
      .andWhere('app.deleted_at IS NULL')
      .andWhere('step.scheduledDate IS NOT NULL')
      .andWhere(
        "(step.scheduledDate AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::DATE < :today",
        { today },
      )
      .andWhere("step.name LIKE '%면접%'")
      .getCount();

    return {
      total: inProgress + passed + failed,
      inProgress,
      interviewsAttended,
      passed,
    };
  }

  async getDdayList(userId: string) {
    // KST(UTC+9) 기준 오늘 날짜 — 프론트엔드 dayjs().startOf('day')와 동일 기준
    const KST = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + KST);
    const today = kstNow.toISOString().split('T')[0];

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

    // 면접 일정 목록 — scheduledDate(UTC)를 KST로 변환 후 날짜 비교
    const steps = await this.stepRepo
      .createQueryBuilder('step')
      .innerJoin('step.application', 'app')
      .where('app.user_id = :userId', { userId })
      .andWhere('app.status = :status', { status: 'IN_PROGRESS' })
      .andWhere('app.deleted_at IS NULL')
      .andWhere('step.scheduledDate IS NOT NULL')
      .andWhere(
        "(step.scheduledDate AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::DATE >= :today",
        { today },
      )
      .select([
        'step.id',
        'step.name',
        'step.scheduledDate',
        'step.applicationId',
        'step.pinnedContent',
      ])
      .addSelect(['app.id', 'app.companyName'])
      .getMany();

    // 시험 일정 — 오늘 이후만
    const exams = await this.examRepo
      .createQueryBuilder('e')
      .where('e.user_id = :userId', { userId })
      .andWhere(
        "(e.exam_date AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::DATE >= :today",
        { today },
      )
      .getMany();

    const todayMs = new Date(today).getTime();

    const items: {
      type: 'deadline' | 'step' | 'exam';
      applicationId?: string;
      stepId?: string;
      examId?: string;
      companyName: string;
      stepName?: string;
      date: string;
      scheduledTime?: string;
      dday: number;
      pinnedContent?: string | null;
    }[] = [];

    for (const app of apps) {
      const dateMs = new Date(app.deadline!).getTime();
      const dday = Math.round((dateMs - todayMs) / 86400000);
      items.push({
        type: 'deadline',
        applicationId: app.id,
        companyName: app.companyName,
        date: app.deadline!,
        dday,
      });
    }

    for (const step of steps) {
      const scheduledDate = new Date(step.scheduledDate!);
      // UTC → KST 변환 후 날짜/시간 추출
      const kstDate = new Date(scheduledDate.getTime() + KST);
      const dateStr = kstDate.toISOString().split('T')[0];
      const dateMs = new Date(dateStr).getTime();
      const dday = Math.round((dateMs - todayMs) / 86400000);
      const hours = kstDate.getUTCHours().toString().padStart(2, '0');
      const minutes = kstDate.getUTCMinutes().toString().padStart(2, '0');
      items.push({
        type: 'step',
        applicationId: step.applicationId,
        stepId: step.id,
        companyName:
          (step as ApplicationStep & { app_company_name?: string })
            .app_company_name ??
          step.application?.companyName ??
          '',
        stepName: step.name,
        date: dateStr,
        scheduledTime: `${hours}:${minutes}`,
        dday,
        pinnedContent: step.pinnedContent ?? null,
      });
    }

    for (const exam of exams) {
      const kstDate = new Date(exam.exam_date.getTime() + KST);
      const dateStr = kstDate.toISOString().split('T')[0];
      const dateMs = new Date(dateStr).getTime();
      const dday = Math.round((dateMs - todayMs) / 86400000);
      const hours = kstDate.getUTCHours().toString().padStart(2, '0');
      const minutes = kstDate.getUTCMinutes().toString().padStart(2, '0');
      items.push({
        type: 'exam',
        examId: exam.id,
        companyName: exam.name,
        date: dateStr,
        scheduledTime: `${hours}:${minutes}`,
        dday,
      });
    }

    return items.sort((a, b) => a.dday - b.dday).slice(0, 5);
  }

  async getYesterdayInterviews(userId: string) {
    const KST = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + KST);
    const today = kstNow.toISOString().split('T')[0];
    const yesterday = new Date(new Date(today).getTime() - 86400000)
      .toISOString()
      .split('T')[0];

    const steps = await this.stepRepo
      .createQueryBuilder('step')
      .innerJoin('step.application', 'app')
      .where('app.user_id = :userId', { userId })
      .andWhere('app.status = :status', { status: 'IN_PROGRESS' })
      .andWhere('app.deleted_at IS NULL')
      .andWhere('step.scheduledDate IS NOT NULL')
      .andWhere(
        "(step.scheduledDate AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::DATE = :yesterday",
        { yesterday },
      )
      .andWhere("step.name LIKE '%면접%'")
      .select(['step.id', 'step.name', 'step.applicationId'])
      .addSelect(['app.companyName'])
      .getMany();

    return steps.map((step) => ({
      stepId: step.id,
      stepName: step.name,
      applicationId: step.applicationId,
      companyName:
        (step as ApplicationStep & { app_company_name?: string })
          .app_company_name ??
        step.application?.companyName ??
        '',
    }));
  }
}
