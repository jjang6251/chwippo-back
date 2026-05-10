import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { DailyNote } from './daily-note.entity';
import { CreateDailyNoteDto, UpdateDailyNoteDto } from './dto/daily-note.dto';

export interface CalendarEvent {
  date: string;
  time: string | null;
  type: 'deadline' | 'interview' | 'exam';
  applicationId: string | null;
  stepId: string | null;
  examId: string | null;
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
    @InjectRepository(DailyNote)
    private readonly noteRepo: Repository<DailyNote>,
    @InjectRepository(ExamSchedule)
    private readonly examRepo: Repository<ExamSchedule>,
  ) {}

  async getMonthEvents(userId: string, year: number, month: number): Promise<CalendarEvent[]> {
    const monthStr = String(month).padStart(2, '0');
    const startDate = `${year}-${monthStr}-01`;
    const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    const deadlines = await this.appRepo
      .createQueryBuilder('a')
      .select(['a.id AS id', 'a.company_name AS company_name', 'a.deadline AS deadline'])
      .where('a.user_id = :userId', { userId })
      .andWhere('a.deleted_at IS NULL')
      .andWhere("a.status != 'FAILED'")
      .andWhere('a.deadline >= :start', { start: startDate })
      .andWhere('a.deadline < :end', { end: nextMonth })
      .getRawMany<{ id: string; company_name: string; deadline: string }>();

    const interviews = await this.stepRepo
      .createQueryBuilder('s')
      .innerJoin('applications', 'a', 'a.id = s.application_id AND a.user_id = :userId AND a.deleted_at IS NULL', { userId })
      .select([
        'a.id AS application_id',
        's.id AS step_id',
        'a.company_name AS company_name',
        's.name AS step_name',
        's.location AS location',
        "TO_CHAR(s.scheduled_date AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date",
        "TO_CHAR(s.scheduled_date AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS time",
      ])
      .where('s.scheduled_date IS NOT NULL')
      .andWhere('s.scheduled_date >= :start', { start: new Date(`${year}-${monthStr}-01T00:00:00+09:00`) })
      .andWhere('s.scheduled_date < :end', { end: new Date(nextMonth + 'T00:00:00+09:00') })
      .getRawMany<{ application_id: string; step_id: string; company_name: string; step_name: string; location: string | null; date: string; time: string }>();

    const exams = await this.examRepo
      .createQueryBuilder('e')
      .select([
        'e.id AS id',
        'e.name AS name',
        'e.location AS location',
        "TO_CHAR(e.exam_date AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS date",
        "TO_CHAR(e.exam_date AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS time",
      ])
      .where('e.user_id = :userId', { userId })
      .andWhere('e.exam_date >= :start', { start: new Date(`${year}-${monthStr}-01T00:00:00+09:00`) })
      .andWhere('e.exam_date < :end', { end: new Date(nextMonth + 'T00:00:00+09:00') })
      .getRawMany<{ id: string; name: string; location: string | null; date: string; time: string }>();

    const deadlineEvents: CalendarEvent[] = deadlines.map((d) => ({
      date: typeof d.deadline === 'string' ? d.deadline : (d.deadline as Date).toISOString().slice(0, 10),
      time: null,
      type: 'deadline',
      applicationId: d.id,
      stepId: null,
      examId: null,
      companyName: d.company_name,
      stepName: null,
      location: null,
    }));

    const interviewEvents: CalendarEvent[] = interviews.map((i) => ({
      date: i.date,
      time: i.time,
      type: 'interview',
      applicationId: i.application_id,
      stepId: i.step_id,
      examId: null,
      companyName: i.company_name,
      stepName: i.step_name,
      location: i.location,
    }));

    const examEvents: CalendarEvent[] = exams.map((e) => ({
      date: e.date,
      time: e.time,
      type: 'exam',
      applicationId: null,
      stepId: null,
      examId: e.id,
      companyName: e.name,
      stepName: null,
      location: e.location,
    }));

    return [...deadlineEvents, ...interviewEvents, ...examEvents].sort((a, b) => a.date.localeCompare(b.date));
  }

  async getDailyNotes(
    userId: string,
    params: { date?: string; startDate?: string; endDate?: string },
  ): Promise<DailyNote[]> {
    const qb = this.noteRepo
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId });

    if (params.date) {
      qb.andWhere('n.date = :date', { date: params.date });
    } else if (params.startDate && params.endDate) {
      qb.andWhere('n.date >= :startDate AND n.date <= :endDate', {
        startDate: params.startDate,
        endDate: params.endDate,
      });
    }

    return qb
      .orderBy('n.hour_slot', 'ASC', 'NULLS FIRST')
      .addOrderBy('n.created_at', 'ASC')
      .getMany();
  }

  async carryOverDailyNote(userId: string, id: string): Promise<DailyNote> {
    const note = await this.noteRepo.findOne({ where: { id } });
    if (!note) throw new NotFoundException();
    if (note.userId !== userId) throw new ForbiddenException();
    note.date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    return this.noteRepo.save(note);
  }

  async createDailyNote(userId: string, dto: CreateDailyNoteDto): Promise<DailyNote> {
    const note = this.noteRepo.create({ userId, ...dto });
    return this.noteRepo.save(note);
  }

  async updateDailyNote(userId: string, id: string, dto: UpdateDailyNoteDto): Promise<DailyNote> {
    const note = await this.noteRepo.findOne({ where: { id } });
    if (!note) throw new NotFoundException();
    if (note.userId !== userId) throw new ForbiddenException();
    Object.assign(note, dto);
    return this.noteRepo.save(note);
  }

  async deleteDailyNote(userId: string, id: string): Promise<void> {
    const note = await this.noteRepo.findOne({ where: { id } });
    if (!note) throw new NotFoundException();
    if (note.userId !== userId) throw new ForbiddenException();
    await this.noteRepo.remove(note);
  }
}
