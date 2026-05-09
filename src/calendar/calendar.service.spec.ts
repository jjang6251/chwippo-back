import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { CalendarService } from './calendar.service';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { DailyNote } from './daily-note.entity';

describe('CalendarService', () => {
  let service: CalendarService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let noteRepo: jest.Mocked<Repository<DailyNote>>;

  function makeQb(rawResult: any[] = []) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rawResult),
    } as unknown as SelectQueryBuilder<any>;
    return qb;
  }

  const makeNote = (overrides: Partial<DailyNote> = {}): DailyNote =>
    ({
      id: 'note-uuid-1',
      userId: 'user-1',
      date: '2026-05-10',
      hourSlot: 0,
      content: '06:00 할 일',
      isDone: false,
      createdAt: new Date(),
      ...overrides,
    }) as DailyNote;

  beforeEach(async () => {
    const mockAppRepo = mock<Repository<Application>>();
    const mockStepRepo = mock<Repository<ApplicationStep>>();
    const mockNoteRepo = mock<Repository<DailyNote>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarService,
        { provide: getRepositoryToken(Application), useValue: mockAppRepo },
        { provide: getRepositoryToken(ApplicationStep), useValue: mockStepRepo },
        { provide: getRepositoryToken(DailyNote), useValue: mockNoteRepo },
      ],
    }).compile();

    service = module.get<CalendarService>(CalendarService);
    appRepo = module.get(getRepositoryToken(Application));
    stepRepo = module.get(getRepositoryToken(ApplicationStep));
    noteRepo = module.get(getRepositoryToken(DailyNote));
  });

  describe('getMonthEvents', () => {
    it('서류 마감 이벤트를 올바르게 변환한다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          { id: 'app-1', company_name: '네이버', deadline: '2026-05-10' },
        ]) as any,
      );
      stepRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'deadline',
        applicationId: 'app-1',
        companyName: '네이버',
        date: '2026-05-10',
        stepName: null,
        location: null,
      });
    });

    it('면접 일정 이벤트를 올바르게 변환한다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-2',
            company_name: '카카오',
            step_name: '1차 면접',
            location: '온라인',
            date: '2026-05-15',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'interview',
        applicationId: 'app-2',
        companyName: '카카오',
        stepName: '1차 면접',
        location: '온라인',
        date: '2026-05-15',
      });
    });

    it('서류+면접 이벤트가 날짜 오름차순으로 정렬된다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          { id: 'app-1', company_name: '네이버', deadline: '2026-05-20' },
        ]) as any,
      );
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-2',
            company_name: '카카오',
            step_name: '1차 면접',
            location: null,
            date: '2026-05-10',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(2);
      expect(result[0].date).toBe('2026-05-10'); // 면접이 먼저
      expect(result[1].date).toBe('2026-05-20'); // 서류 마감이 나중
    });

    it('이벤트가 없으면 빈 배열을 반환한다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(0);
    });

    it('12월 요청 시 다음 연도 1월로 범위를 올바르게 계산한다', async () => {
      const appQb = makeQb([]) as any;
      const stepQb = makeQb([]) as any;
      appRepo.createQueryBuilder.mockReturnValue(appQb);
      stepRepo.createQueryBuilder.mockReturnValue(stepQb);

      await service.getMonthEvents('user-1', 2026, 12);

      // andWhere가 end 파라미터로 2027-01-01을 사용해야 함
      expect(appQb.andWhere).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ end: '2027-01-01' }),
      );
    });

    it('면접 이벤트의 location이 null이면 null로 반환', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-1',
            company_name: '토스',
            step_name: '1차 면접',
            location: null,
            date: '2026-05-15',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result[0].location).toBeNull();
    });

    it('같은 날짜에 서류 마감과 면접이 있으면 둘 다 반환 (날짜 동일 → 원래 순서 유지)', async () => {
      appRepo.createQueryBuilder.mockReturnValue(
        makeQb([{ id: 'app-1', company_name: '네이버', deadline: '2026-05-15' }]) as any,
      );
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          { application_id: 'app-2', company_name: '카카오', step_name: '서류 발표', location: null, date: '2026-05-15' },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(2);
      expect(result.every((e) => e.date === '2026-05-15')).toBe(true);
    });
  });

  // ── getDailyNotes ──────────────────────────────────────
  function makeNoteQb(results: DailyNote[]) {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(results),
    };
    noteRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);
    return qb;
  }

  describe('getDailyNotes', () => {
    it('date 파라미터로 해당 날짜 노트 반환', async () => {
      const notes = [makeNote()];
      const qb = makeNoteQb(notes);

      const result = await service.getDailyNotes('user-1', { date: '2026-05-10' });

      expect(noteRepo.createQueryBuilder).toHaveBeenCalledWith('n');
      expect(qb.andWhere).toHaveBeenCalledWith('n.date = :date', { date: '2026-05-10' });
      expect(result).toEqual(notes);
    });

    it('startDate/endDate 범위로 노트 반환', async () => {
      const notes = [makeNote(), makeNote({ date: '2026-05-09' })];
      makeNoteQb(notes);

      const result = await service.getDailyNotes('user-1', { startDate: '2026-05-09', endDate: '2026-05-10' });

      expect(result).toEqual(notes);
    });

    it('해당 날짜 노트 없으면 빈 배열 반환', async () => {
      makeNoteQb([]);
      const result = await service.getDailyNotes('user-1', { date: '2026-05-10' });
      expect(result).toEqual([]);
    });
  });

  // ── createDailyNote ────────────────────────────────────
  describe('createDailyNote', () => {
    it('userId + dto로 create 후 save, 저장된 노트 반환', async () => {
      const dto = { date: '2026-05-10', hourSlot: 3, content: '08:30 커피챗', isDone: false };
      const note = makeNote({ ...dto });
      noteRepo.create.mockReturnValue(note);
      noteRepo.save.mockResolvedValue(note);

      const result = await service.createDailyNote('user-1', dto);

      expect(noteRepo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', ...dto }));
      expect(noteRepo.save).toHaveBeenCalledWith(note);
      expect(result).toEqual(note);
    });
  });

  // ── updateDailyNote ────────────────────────────────────
  describe('updateDailyNote', () => {
    it('본인 노트 → Object.assign 후 save, 수정된 노트 반환', async () => {
      const note = makeNote({ isDone: false });
      noteRepo.findOne.mockResolvedValue(note);
      noteRepo.save.mockImplementation(async (n) => n as DailyNote);

      const result = await service.updateDailyNote('user-1', 'note-uuid-1', { isDone: true });

      expect(noteRepo.findOne).toHaveBeenCalledWith({ where: { id: 'note-uuid-1' } });
      expect(result.isDone).toBe(true);
      expect(noteRepo.save).toHaveBeenCalled();
    });

    it('존재하지 않는 노트 → NotFoundException', async () => {
      noteRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateDailyNote('user-1', 'nonexistent', { isDone: true }),
      ).rejects.toThrow(NotFoundException);
      expect(noteRepo.save).not.toHaveBeenCalled();
    });

    it('다른 userId의 노트 → ForbiddenException (IDOR)', async () => {
      const note = makeNote({ userId: 'other-user' });
      noteRepo.findOne.mockResolvedValue(note);

      await expect(
        service.updateDailyNote('user-1', 'note-uuid-1', { isDone: true }),
      ).rejects.toThrow(ForbiddenException);
      expect(noteRepo.save).not.toHaveBeenCalled();
    });
  });

  // ── deleteDailyNote ────────────────────────────────────
  describe('deleteDailyNote', () => {
    it('본인 노트 → noteRepo.remove 호출', async () => {
      const note = makeNote();
      noteRepo.findOne.mockResolvedValue(note);
      noteRepo.remove.mockResolvedValue(note);

      await service.deleteDailyNote('user-1', 'note-uuid-1');

      expect(noteRepo.remove).toHaveBeenCalledWith(note);
    });

    it('존재하지 않는 노트 → NotFoundException', async () => {
      noteRepo.findOne.mockResolvedValue(null);

      await expect(service.deleteDailyNote('user-1', 'nonexistent')).rejects.toThrow(NotFoundException);
      expect(noteRepo.remove).not.toHaveBeenCalled();
    });

    it('다른 userId의 노트 → ForbiddenException (IDOR)', async () => {
      const note = makeNote({ userId: 'other-user' });
      noteRepo.findOne.mockResolvedValue(note);

      await expect(service.deleteDailyNote('user-1', 'note-uuid-1')).rejects.toThrow(ForbiddenException);
      expect(noteRepo.remove).not.toHaveBeenCalled();
    });
  });
});
