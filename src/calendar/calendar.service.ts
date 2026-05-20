import { Injectable, NotFoundException } from '@nestjs/common';
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
  type: 'step' | 'exam' | 'note';
  applicationId: string | null;
  stepId: string | null;
  examId: string | null;
  noteId: string | null;
  companyName: string | null;
  stepName: string | null;
  location: string | null;
  content: string | null;
}

function hourSlotToTime(slot: number | null): string | null {
  if (slot === null || slot === undefined) return null;
  const minutes = 360 + slot * 30;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

  async getMonthEvents(
    userId: string,
    year: number,
    month: number,
  ): Promise<CalendarEvent[]> {
    const monthStr = String(month).padStart(2, '0');
    const startDate = `${year}-${monthStr}-01`;
    const nextMonth =
      month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    const interviews = await this.stepRepo
      .createQueryBuilder('s')
      .innerJoin(
        'applications',
        'a',
        "a.id = s.application_id AND a.user_id = :userId AND a.deleted_at IS NULL AND a.status NOT IN ('FAILED', 'PASSED')",
        { userId },
      )
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
      .andWhere('s.scheduled_date >= :start', {
        start: new Date(`${year}-${monthStr}-01T00:00:00+09:00`),
      })
      .andWhere('s.scheduled_date < :end', {
        end: new Date(nextMonth + 'T00:00:00+09:00'),
      })
      .getRawMany<{
        application_id: string;
        step_id: string;
        company_name: string;
        step_name: string;
        location: string | null;
        date: string;
        time: string;
      }>();

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
      .andWhere('e.exam_date >= :start', {
        start: new Date(`${year}-${monthStr}-01T00:00:00+09:00`),
      })
      .andWhere('e.exam_date < :end', {
        end: new Date(nextMonth + 'T00:00:00+09:00'),
      })
      .getRawMany<{
        id: string;
        name: string;
        location: string | null;
        date: string;
        time: string;
      }>();

    const notes = await this.noteRepo
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId })
      .andWhere('n.date >= :start', { start: startDate })
      .andWhere('n.date < :end', { end: nextMonth })
      .orderBy('n.hour_slot', 'ASC', 'NULLS FIRST')
      .addOrderBy('n.created_at', 'ASC')
      .getMany();

    const stepEvents: CalendarEvent[] = interviews.map((i) => ({
      date: i.date,
      time: i.time,
      type: 'step',
      applicationId: i.application_id,
      stepId: i.step_id,
      examId: null,
      noteId: null,
      companyName: i.company_name,
      stepName: i.step_name,
      location: i.location,
      content: null,
    }));

    const examEvents: CalendarEvent[] = exams.map((e) => ({
      date: e.date,
      time: e.time,
      type: 'exam',
      applicationId: null,
      stepId: null,
      examId: e.id,
      noteId: null,
      companyName: e.name,
      stepName: null,
      location: e.location,
      content: null,
    }));

    const noteEvents: CalendarEvent[] = notes.map((n) => ({
      date: n.date,
      time: hourSlotToTime(n.hourSlot),
      type: 'note',
      applicationId: null,
      stepId: null,
      examId: null,
      noteId: n.id,
      companyName: null,
      stepName: null,
      location: null,
      content: n.content,
    }));

    return [...stepEvents, ...examEvents, ...noteEvents].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
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
    // LRR P1T3 PR H — IDOR 정보 누수 차단: userId where 조건에 포함 → 다른 사용자 일정이거나
    // 존재 안 하거나 모두 NotFound로 동일 응답 (security.md §2.2 정식 패턴)
    const note = await this.noteRepo.findOne({ where: { id, userId } });
    if (!note) throw new NotFoundException('일정을 찾을 수 없습니다.');
    note.date = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Seoul',
    });
    return this.noteRepo.save(note);
  }

  async createDailyNote(
    userId: string,
    dto: CreateDailyNoteDto,
  ): Promise<DailyNote> {
    // LRR P1T3 PR K L-5 — userId가 spread 뒤에 와야 dto에 userId가 섞여 들어와도 override됨
    // (forbidNonWhitelisted가 차단하지만 defense-in-depth)
    const note = this.noteRepo.create({ ...dto, userId });
    return this.noteRepo.save(note);
  }

  async updateDailyNote(
    userId: string,
    id: string,
    dto: UpdateDailyNoteDto,
  ): Promise<DailyNote> {
    const note = await this.noteRepo.findOne({ where: { id, userId } });
    if (!note) throw new NotFoundException('일정을 찾을 수 없습니다.');
    Object.assign(note, dto);
    return this.noteRepo.save(note);
  }

  async deleteDailyNote(userId: string, id: string): Promise<void> {
    const note = await this.noteRepo.findOne({ where: { id, userId } });
    if (!note) throw new NotFoundException('일정을 찾을 수 없습니다.');
    await this.noteRepo.remove(note);
  }
}
