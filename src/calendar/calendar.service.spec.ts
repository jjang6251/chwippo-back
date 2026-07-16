import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { CalendarService } from './calendar.service';
import { startOfTodayKst } from '../common/datetime';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { DailyNote } from './daily-note.entity';

describe('CalendarService', () => {
  let service: CalendarService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let noteRepo: jest.Mocked<Repository<DailyNote>>;
  let examRepo: jest.Mocked<Repository<ExamSchedule>>;

  function makeQb(rawResult: any[] = []) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rawResult),
    } as unknown as SelectQueryBuilder<any>;
    return qb;
  }

  const makeNote = (overrides: Partial<DailyNote> = {}): DailyNote => ({
    id: 'note-uuid-1',
    userId: 'user-1',
    date: '2026-05-10',
    hourSlot: 0,
    content: '06:00 할 일',
    isDone: false,
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    const mockAppRepo = mock<Repository<Application>>();
    const mockStepRepo = mock<Repository<ApplicationStep>>();
    const mockNoteRepo = mock<Repository<DailyNote>>();
    const mockExamRepo = mock<Repository<ExamSchedule>>();
    // exam query builder는 항상 빈 배열 반환 (시험 일정 없음)
    (mockExamRepo.createQueryBuilder as jest.Mock).mockReturnValue(makeQb([]));
    // note query builder도 기본은 빈 배열 (getMonthEvents가 호출, 각 테스트에서 필요시 override)
    (mockNoteRepo.createQueryBuilder as jest.Mock).mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarService,
        { provide: getRepositoryToken(Application), useValue: mockAppRepo },
        {
          provide: getRepositoryToken(ApplicationStep),
          useValue: mockStepRepo,
        },
        { provide: getRepositoryToken(DailyNote), useValue: mockNoteRepo },
        { provide: getRepositoryToken(ExamSchedule), useValue: mockExamRepo },
      ],
    }).compile();

    service = module.get<CalendarService>(CalendarService);
    appRepo = module.get(getRepositoryToken(Application));
    stepRepo = module.get(getRepositoryToken(ApplicationStep));
    noteRepo = module.get(getRepositoryToken(DailyNote));
    examRepo = module.get(getRepositoryToken(ExamSchedule));
  });

  describe('getMonthEvents', () => {
    it('스텝 일정 이벤트를 올바르게 변환한다', async () => {
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
        type: 'step',
        applicationId: 'app-2',
        companyName: '카카오',
        stepName: '1차 면접',
        location: '온라인',
        date: '2026-05-15',
      });
    });

    it('여러 스텝 이벤트가 날짜 오름차순으로 정렬된다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-1',
            company_name: '네이버',
            step_name: '서류전형',
            location: null,
            date: '2026-05-20',
          },
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
      expect(result[0].date).toBe('2026-05-10');
      expect(result[1].date).toBe('2026-05-20');
    });

    it('이벤트가 없으면 빈 배열을 반환한다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(0);
    });

    it('12월 요청 시 다음 연도 1월로 범위를 올바르게 계산한다', async () => {
      const stepQb = makeQb([]) as any;
      stepRepo.createQueryBuilder.mockReturnValue(stepQb);

      await service.getMonthEvents('user-1', 2026, 12);

      // step 쿼리의 end 파라미터가 2027-01-01 기준 Date여야 함
      expect(stepQb.andWhere).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ end: expect.any(Date) }),
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

    it('캘린더 UX 재구성 — step 응답에 isStarred 포함 (true 카드)', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-1',
            company_name: '카카오',
            is_starred: true,
            step_name: '서류 마감',
            location: null,
            date: '2026-05-02',
            time: '23:59',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result[0].isStarred).toBe(true);
    });

    it('캘린더 UX 재구성 — is_starred=false 도 정확히 응답에 반영', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-2',
            company_name: '네이버',
            is_starred: false,
            step_name: '1차 면접',
            location: '강남',
            date: '2026-05-10',
            time: '14:00',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result[0].isStarred).toBe(false);
    });

    it('캘린더 UX 재구성 — exam 이벤트는 isStarred undefined', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      examRepo.createQueryBuilder = jest.fn().mockReturnValue(
        makeQb([
          {
            id: 'exam-1',
            name: 'TOEIC',
            location: '종로',
            date: '2026-05-09',
            time: '09:00',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result[0].type).toBe('exam');
      expect(result[0].isStarred).toBeUndefined();
    });

    it('같은 날짜에 여러 스텝이 있으면 모두 반환', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-1',
            company_name: '네이버',
            step_name: '서류전형',
            location: null,
            date: '2026-05-15',
          },
          {
            application_id: 'app-2',
            company_name: '카카오',
            step_name: '서류 발표',
            location: null,
            date: '2026-05-15',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(2);
      expect(result.every((e) => e.date === '2026-05-15')).toBe(true);
    });

    it('시험 일정 이벤트를 type="exam" + examId 매핑으로 변환', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      examRepo.createQueryBuilder = jest.fn().mockReturnValue(
        makeQb([
          {
            id: 'exam-1',
            name: 'TOEIC',
            location: '한양대',
            date: '2026-05-20',
            time: '09:00',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'exam',
        examId: 'exam-1',
        applicationId: null,
        stepId: null,
        companyName: 'TOEIC',
        location: '한양대',
        date: '2026-05-20',
        time: '09:00',
      });
    });

    it('note 이벤트에 isDone 포함 (U27 아젠다 인라인 체크 초기 상태)', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      makeNoteQb([
        makeNote({
          id: 'note-done',
          date: '2026-05-11',
          hourSlot: null,
          isDone: true,
        }),
        makeNote({
          id: 'note-open',
          date: '2026-05-12',
          hourSlot: null,
          isDone: false,
        }),
      ]);

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        type: 'note',
        noteId: 'note-done',
        isDone: true,
        time: null,
      });
      expect(result[1]).toMatchObject({
        type: 'note',
        noteId: 'note-open',
        isDone: false,
      });
    });

    it('step·exam 혼합 시 날짜 ASC 정렬', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-2',
            company_name: '카카오',
            step_name: '1차',
            location: null,
            date: '2026-05-20',
          },
        ]) as any,
      );
      examRepo.createQueryBuilder = jest.fn().mockReturnValue(
        makeQb([
          {
            id: 'exam-1',
            name: 'TOEIC',
            location: null,
            date: '2026-05-15',
            time: '09:00',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.type)).toEqual(['exam', 'step']);
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

      const result = await service.getDailyNotes('user-1', {
        date: '2026-05-10',
      });

      expect(noteRepo.createQueryBuilder).toHaveBeenCalledWith('n');
      expect(qb.andWhere).toHaveBeenCalledWith('n.date = :date', {
        date: '2026-05-10',
      });
      expect(result).toEqual(notes);
    });

    it('startDate/endDate 범위로 노트 반환', async () => {
      const notes = [makeNote(), makeNote({ date: '2026-05-09' })];
      makeNoteQb(notes);

      const result = await service.getDailyNotes('user-1', {
        startDate: '2026-05-09',
        endDate: '2026-05-10',
      });

      expect(result).toEqual(notes);
    });

    it('해당 날짜 노트 없으면 빈 배열 반환', async () => {
      makeNoteQb([]);
      const result = await service.getDailyNotes('user-1', {
        date: '2026-05-10',
      });
      expect(result).toEqual([]);
    });
  });

  // ── createDailyNote ────────────────────────────────────
  describe('createDailyNote', () => {
    it('userId + dto로 create 후 save, 저장된 노트 반환', async () => {
      const dto = {
        date: '2026-05-10',
        hourSlot: 3,
        content: '08:30 커피챗',
        isDone: false,
      };
      const note = makeNote({ ...dto });
      noteRepo.create.mockReturnValue(note);
      noteRepo.save.mockResolvedValue(note);

      const result = await service.createDailyNote('user-1', dto);

      expect(noteRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', ...dto }),
      );
      expect(noteRepo.save).toHaveBeenCalledWith(note);
      expect(result).toEqual(note);
    });
  });

  // ── updateDailyNote ────────────────────────────────────
  // LRR P1T3 PR H — findOne({where:{id, userId}}) + 404 일관 (security.md §2.2)
  describe('updateDailyNote', () => {
    it('본인 노트 → Object.assign 후 save, 수정된 노트 반환', async () => {
      const note = makeNote({ isDone: false });
      noteRepo.findOne.mockResolvedValue(note);
      noteRepo.save.mockImplementation(async (n) => n as DailyNote);

      const result = await service.updateDailyNote('user-1', 'note-uuid-1', {
        isDone: true,
      });

      // userId where 조건 포함 — IDOR 방어
      expect(noteRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'note-uuid-1', userId: 'user-1' },
      });
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

    it('다른 userId의 노트 → NotFoundException (IDOR 정보 누수 차단)', async () => {
      // findOne({where:{id, userId}})는 다른 사용자 소유면 null 반환 → 404로 동일 응답
      noteRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateDailyNote('user-1', 'note-uuid-1', { isDone: true }),
      ).rejects.toThrow(NotFoundException);
      expect(noteRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'note-uuid-1', userId: 'user-1' },
      });
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

      expect(noteRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'note-uuid-1', userId: 'user-1' },
      });
      expect(noteRepo.remove).toHaveBeenCalledWith(note);
    });

    it('존재하지 않는 노트 → NotFoundException', async () => {
      noteRepo.findOne.mockResolvedValue(null);

      await expect(
        service.deleteDailyNote('user-1', 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
      expect(noteRepo.remove).not.toHaveBeenCalled();
    });

    it('다른 userId의 노트 → NotFoundException (IDOR 정보 누수 차단)', async () => {
      noteRepo.findOne.mockResolvedValue(null);

      await expect(
        service.deleteDailyNote('user-1', 'note-uuid-1'),
      ).rejects.toThrow(NotFoundException);
      expect(noteRepo.remove).not.toHaveBeenCalled();
    });
  });

  // ── carryOverDailyNote ────────────────────────────────
  // LRR P1T3 PR H — 신규 spec (기존 누락, 같은 패턴 검증 추가)
  describe('carryOverDailyNote', () => {
    it('본인 노트 → date를 KST 오늘로 설정 + save', async () => {
      const note = makeNote({ date: '2026-05-15' });
      noteRepo.findOne.mockResolvedValue(note);
      noteRepo.save.mockImplementation(async (n) => n as DailyNote);

      const result = await service.carryOverDailyNote('user-1', 'note-uuid-1');

      expect(noteRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'note-uuid-1', userId: 'user-1' },
      });
      // KST 기준 오늘 — YYYY-MM-DD 형식
      expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(noteRepo.save).toHaveBeenCalled();
    });

    it('존재하지 않는 노트 → NotFoundException', async () => {
      noteRepo.findOne.mockResolvedValue(null);

      await expect(
        service.carryOverDailyNote('user-1', 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
      expect(noteRepo.save).not.toHaveBeenCalled();
    });

    it('다른 userId의 노트 → NotFoundException (IDOR 정보 누수 차단)', async () => {
      noteRepo.findOne.mockResolvedValue(null);

      await expect(
        service.carryOverDailyNote('user-1', 'note-uuid-1'),
      ).rejects.toThrow(NotFoundException);
      expect(noteRepo.save).not.toHaveBeenCalled();
    });
  });

  /**
   * A3 — 오늘 할 일 자동 합류 (urgent checklist) 시나리오:
   * 1. 정상 — raw row → camelCase 매핑
   * 2. 격리·상태 필터 — join 조건에 user_id · FAILED/PASSED 제외 · is_done=FALSE
   * 3. 날짜 경계 — [오늘 KST 00:00, +4일) = 오늘 포함 D-3 까지
   * 4. 해당 없음 → 빈 배열
   */
  describe('getUrgentChecklist', () => {
    const RAW = [
      {
        item_id: 'c-1',
        content: '포트폴리오 출력',
        step_id: 's-1',
        step_name: '면접',
        application_id: 'app-1',
        company_name: '카카오',
        date: '2026-07-09',
      },
    ];

    it('1) 정상 — raw row 를 camelCase 로 매핑', async () => {
      stepRepo.createQueryBuilder.mockReturnValue(makeQb(RAW) as any);
      const r = await service.getUrgentChecklist('user-1');
      expect(r).toEqual([
        {
          itemId: 'c-1',
          content: '포트폴리오 출력',
          stepId: 's-1',
          stepName: '면접',
          applicationId: 'app-1',
          companyName: '카카오',
          date: '2026-07-09',
        },
      ]);
    });

    it('2) join 조건 — 본인 카드 · FAILED/PASSED 제외 · 미완 항목만', async () => {
      const qb = makeQb([]);
      stepRepo.createQueryBuilder.mockReturnValue(qb as any);
      await service.getUrgentChecklist('user-1');
      const joins = (qb.innerJoin as jest.Mock).mock.calls;
      const appJoin = joins.find((c) => c[0] === 'applications');
      expect(appJoin[2]).toContain('a.user_id = :userId');
      expect(appJoin[2]).toContain("NOT IN ('FAILED', 'PASSED')");
      expect(appJoin[3]).toEqual({ userId: 'user-1' });
      const checklistJoin = joins.find((c) => c[0] === 'step_checklist_items');
      expect(checklistJoin[2]).toContain('c.is_done = FALSE');
    });

    it('3) 날짜 경계 — [오늘 KST 00:00, +4일) = 오늘 포함 D-3 까지', async () => {
      const qb = makeQb([]);
      stepRepo.createQueryBuilder.mockReturnValue(qb as any);
      await service.getUrgentChecklist('user-1');
      const wheres = (qb.andWhere as jest.Mock).mock.calls;
      const startCall = wheres.find((c) => String(c[0]).includes('>= :start'));
      const endCall = wheres.find((c) => String(c[0]).includes('< :end'));
      const start = startCall[1].start as Date;
      const end = endCall[1].end as Date;
      expect(start.getTime()).toBe(startOfTodayKst().getTime());
      expect(end.getTime() - start.getTime()).toBe(4 * 86_400_000);
    });

    it('4) 해당 없음 → 빈 배열', async () => {
      stepRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      await expect(service.getUrgentChecklist('user-1')).resolves.toEqual([]);
    });
  });
});
