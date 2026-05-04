import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';

export interface CalendarEvent {
  date: string;
  type: 'deadline' | 'interview';
  applicationId: string;
  companyName: string;
  stepName: string | null;
  location: string | null;
}

@Injectable()
export class CalendarService {
  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationStep)
    private readonly stepRepo: Repository<ApplicationStep>,
  ) {}

  async getMonthEvents(userId: string, year: number, month: number): Promise<CalendarEvent[]> {
    const monthStr = String(month).padStart(2, '0');
    const startDate = `${year}-${monthStr}-01`;
    // Last day of month: first day of next month minus 1
    const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    // 서류 마감 (deadline)
    const deadlines = await this.appRepo
      .createQueryBuilder('a')
      .select(['a.id AS id', 'a.company_name AS company_name', 'a.deadline AS deadline'])
      .where('a.user_id = :userId', { userId })
      .andWhere('a.deleted_at IS NULL')
      .andWhere("a.status != 'FAILED'")
      .andWhere('a.deadline >= :start', { start: startDate })
      .andWhere('a.deadline < :end', { end: nextMonth })
      .getRawMany<{ id: string; company_name: string; deadline: string }>();

    // 면접 일정 (scheduledDate in steps)
    const interviews = await this.stepRepo
      .createQueryBuilder('s')
      .innerJoin('applications', 'a', 'a.id = s.application_id AND a.user_id = :userId AND a.deleted_at IS NULL', { userId })
      .select([
        'a.id AS application_id',
        'a.company_name AS company_name',
        's.name AS step_name',
        's.location AS location',
        "TO_CHAR(s.scheduled_date AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date",
      ])
      .where('s.scheduled_date IS NOT NULL')
      .andWhere('s.scheduled_date >= :start', { start: new Date(`${year}-${monthStr}-01T00:00:00+09:00`) })
      .andWhere('s.scheduled_date < :end', { end: new Date(nextMonth + 'T00:00:00+09:00') })
      .getRawMany<{ application_id: string; company_name: string; step_name: string; location: string | null; date: string }>();

    const deadlineEvents: CalendarEvent[] = deadlines.map((d) => ({
      date: typeof d.deadline === 'string' ? d.deadline : (d.deadline as Date).toISOString().slice(0, 10),
      type: 'deadline',
      applicationId: d.id,
      companyName: d.company_name,
      stepName: null,
      location: null,
    }));

    const interviewEvents: CalendarEvent[] = interviews.map((i) => ({
      date: i.date,
      type: 'interview',
      applicationId: i.application_id,
      companyName: i.company_name,
      stepName: i.step_name,
      location: i.location,
    }));

    return [...deadlineEvents, ...interviewEvents].sort((a, b) => a.date.localeCompare(b.date));
  }
}
