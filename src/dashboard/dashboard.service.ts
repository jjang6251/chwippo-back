import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Application } from '../applications/application.entity';
import { ApplicationCoverletter } from '../applications/application-coverletter.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { CompaniesService } from '../companies/companies.service';

/**
 * 캘린더 UX 재구성 — Hero CTA 라벨/링크 산출용 next_action enum.
 *
 * 프론트 매핑:
 * - writing_coverletter → "자소서 이어 쓰기" → /board/:id/coverletter
 * - start_coverletter   → "자소서 시작하기" → /board/:id/coverletter
 * - review_company      → "회사 조사 확인" → /board/:id#company-research
 * - confirm_submit      → "최종 검토" → /board/:id
 * - no_action           → "카드 열기" → /board/:id (default fallback)
 */
export type NextAction =
  | 'writing_coverletter'
  | 'start_coverletter'
  | 'review_company'
  | 'confirm_submit'
  | 'no_action';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationCoverletter)
    private readonly coverletterRepo: Repository<ApplicationCoverletter>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
    @InjectRepository(ExamSchedule)
    private readonly examRepo: Repository<ExamSchedule>,
    private readonly companiesService: CompaniesService,
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

    // 스텝 일정 목록 — scheduledDate(UTC)를 KST로 변환 후 날짜 비교
    // (서류 마감도 첫 step.scheduled_date에 일원화 — 데이터 모델 통합)
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

    // 캘린더 UX 재구성 — step 대상 application 의 자소서 상태 batch 조회 (Hero CTA 산출용)
    const applicationIds = Array.from(
      new Set(steps.map((s) => s.applicationId)),
    );
    const [coverletters, appsMeta] = await Promise.all([
      applicationIds.length > 0
        ? this.coverletterRepo.find({
            where: { applicationId: In(applicationIds) },
            select: {
              id: true,
              applicationId: true,
              answer: true,
            },
          })
        : Promise.resolve([]),
      applicationIds.length > 0
        ? this.appRepo.find({
            where: { id: In(applicationIds) },
            select: {
              id: true,
              coverletterResearchOutdatedAt: true,
              jobUrl: true,
            },
          })
        : Promise.resolve([]),
    ]);

    // application 별 coverletter 그룹핑 + outdated 매핑
    const coverlettersByApp = new Map<string, ApplicationCoverletter[]>();
    for (const c of coverletters) {
      const arr = coverlettersByApp.get(c.applicationId) ?? [];
      arr.push(c);
      coverlettersByApp.set(c.applicationId, arr);
    }
    const outdatedByApp = new Map<string, boolean>();
    const jobUrlByApp = new Map<string, string | null>();
    for (const a of appsMeta) {
      outdatedByApp.set(a.id, a.coverletterResearchOutdatedAt !== null);
      jobUrlByApp.set(a.id, a.jobUrl ?? null);
    }

    const items: {
      type: 'step' | 'exam';
      applicationId?: string;
      stepId?: string;
      examId?: string;
      companyName: string;
      stepName?: string;
      date: string;
      scheduledTime?: string;
      dday: number;
      pinnedContent?: string | null;
      nextAction?: NextAction;
      progress?: { current: number; total: number };
      jobUrl?: string | null;
      domain?: string | null;
    }[] = [];

    for (const step of steps) {
      const scheduledDate = new Date(step.scheduledDate!);
      // UTC → KST 변환 후 날짜/시간 추출
      const kstDate = new Date(scheduledDate.getTime() + KST);
      const dateStr = kstDate.toISOString().split('T')[0];
      const dateMs = new Date(dateStr).getTime();
      const dday = Math.round((dateMs - todayMs) / 86400000);
      const hours = kstDate.getUTCHours().toString().padStart(2, '0');
      const minutes = kstDate.getUTCMinutes().toString().padStart(2, '0');
      const { nextAction, progress } = computeNextAction(
        step.name,
        coverlettersByApp.get(step.applicationId) ?? [],
        outdatedByApp.get(step.applicationId) ?? false,
      );

      const companyName =
        (step as ApplicationStep & { app_company_name?: string })
          .app_company_name ??
        step.application?.companyName ??
        '';
      items.push({
        type: 'step',
        applicationId: step.applicationId,
        stepId: step.id,
        companyName,
        stepName: step.name,
        date: dateStr,
        scheduledTime: `${hours}:${minutes}`,
        dday,
        pinnedContent: step.pinnedContent ?? null,
        nextAction,
        progress,
        jobUrl: jobUrlByApp.get(step.applicationId) ?? null,
        domain: this.companiesService.getDomainByName(companyName) ?? null,
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
        nextAction: 'no_action',
        domain: this.companiesService.getDomainByName(exam.name) ?? null,
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

/**
 * 캘린더 UX 재구성 — step 별 next_action + progress 산출.
 *
 * 자소서 관련 step (서류 계열) 만 4 enum 로 분기, 그 외는 no_action fallback.
 * - coverletter 문항 0개 or 비-서류 step → no_action
 * - 문항 있고 answer 0 개 → start_coverletter
 * - 일부 answer 있음 → writing_coverletter
 * - 모두 answer 있음 && research outdated → review_company
 * - 모두 answer 있음 && research 최신 → confirm_submit
 *
 * answer 완료 판정: trim() 후 length > 0
 */
export function computeNextAction(
  stepName: string,
  coverletters: ApplicationCoverletter[],
  researchOutdated: boolean,
): { nextAction: NextAction; progress?: { current: number; total: number } } {
  // 서류 계열이 아니거나 문항 자체가 없으면 fallback
  const isDocStep = /서류|공채|지원|자소서/i.test(stepName ?? '');
  if (!isDocStep || coverletters.length === 0) {
    return { nextAction: 'no_action' };
  }

  const total = coverletters.length;
  const completed = coverletters.filter(
    (c) => c.answer !== null && c.answer.trim().length > 0,
  ).length;
  const progress = { current: completed, total };

  if (completed === 0) return { nextAction: 'start_coverletter', progress };
  if (completed < total) return { nextAction: 'writing_coverletter', progress };
  // completed === total
  if (researchOutdated) return { nextAction: 'review_company', progress };
  return { nextAction: 'confirm_submit', progress };
}
