import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, Repository } from 'typeorm';
import { Activity, ActivityType } from './entities/activity.entity';
import { ActivityService } from './activity.service';

const ALL_TYPES: ActivityType[] = [
  'intern',
  'club',
  'study',
  'project',
  'sideproject',
  'contest',
  'research',
  'parttime',
  'volunteer',
  'overseas',
  'bootcamp',
  'other',
];

describe('ActivityService', () => {
  let service: ActivityService;
  let repo: jest.Mocked<Repository<Activity>>;
  let dataSource: jest.Mocked<DataSource>;

  const makeActivity = (overrides: Partial<Activity> = {}): Activity => ({
    id: 'act-1',
    userId: 'user-1',
    name: 'A',
    type: 'intern',
    org: null,
    role: null,
    resultUrl: null,
    outcome: null,
    startedAt: null,
    endedAt: null,
    archivedAt: null,
    legacyExperienceId: null,
    logs: [],
    reflections: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    user: undefined as unknown as Activity['user'],
    ...overrides,
  });

  beforeEach(async () => {
    const mockRepo = mock<Repository<Activity>>();
    const mockDataSource = mock<DataSource>();
    // 기본: source_refs 테이블 모두 없음
    mockDataSource.query.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema')) return [{ exists: false }];
      return [];
    });
    // createQueryBuilder for activity_logs select → 빈 배열
    const qb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    } as unknown as ReturnType<DataSource['createQueryBuilder']>;
    mockDataSource.createQueryBuilder.mockReturnValue(qb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityService,
        { provide: getRepositoryToken(Activity), useValue: mockRepo },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<ActivityService>(ActivityService);
    repo = module.get(getRepositoryToken(Activity));
    dataSource = module.get(DataSource);
  });

  describe('create', () => {
    it('최소: name + type 만 → 저장', async () => {
      const created = makeActivity();
      repo.create.mockReturnValue(created);
      repo.save.mockResolvedValue(created);
      const result = await service.create('user-1', {
        name: 'A',
        type: 'intern',
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          name: 'A',
          type: 'intern',
          org: null,
          role: null,
          resultUrl: null,
          outcome: null,
        }),
      );
      expect(result).toBe(created);
    });

    it.each(ALL_TYPES)('type=%s 정상 저장', async (type) => {
      repo.create.mockImplementation((d) => d as Activity);
      repo.save.mockImplementation(async (d) => d as Activity);
      const result = await service.create('user-1', {
        name: `${type} 활동`,
        type,
      });
      expect(result.type).toBe(type);
    });

    it('role/resultUrl/outcome optional 채워 저장', async () => {
      repo.create.mockImplementation((d) => d as Activity);
      repo.save.mockImplementation(async (d) => d as Activity);
      const result = await service.create('user-1', {
        name: 'Side Proj',
        type: 'sideproject',
        role: 'PM',
        resultUrl: 'https://github.com/me/proj',
        outcome: '1st prize',
      });
      expect(result.role).toBe('PM');
      expect(result.resultUrl).toBe('https://github.com/me/proj');
      expect(result.outcome).toBe('1st prize');
    });

    it('startedAt > endedAt 도 service 는 그대로 저장 (UI 책임)', async () => {
      repo.create.mockImplementation((d) => d as Activity);
      repo.save.mockImplementation(async (d) => d as Activity);
      const result = await service.create('user-1', {
        name: 'X',
        type: 'other',
        startedAt: '2026-12-01',
        endedAt: '2026-01-01',
      });
      expect(result.startedAt).toBe('2026-12-01');
      expect(result.endedAt).toBe('2026-01-01');
    });
  });

  describe('findAll', () => {
    it('default: archivedAt IS NULL + logs relation 포함', async () => {
      repo.find.mockResolvedValue([makeActivity()]);
      await service.findAll('user-1', { includeArchived: false });
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', archivedAt: expect.anything() },
          relations: ['logs', 'reflections'],
        }),
      );
    });

    it('includeArchived=true → 전체', async () => {
      repo.find.mockResolvedValue([]);
      await service.findAll('user-1', { includeArchived: true });
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          relations: ['logs', 'reflections'],
        }),
      );
    });
  });

  describe('findOne / update', () => {
    it('정상 findOne', async () => {
      const found = makeActivity();
      repo.findOne.mockResolvedValue(found);
      const result = await service.findOne('user-1', 'act-1');
      expect(result).toBe(found);
      expect(repo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'act-1', userId: 'user-1' },
          relations: ['logs', 'reflections'],
        }),
      );
    });

    it('다른 user findOne → NotFound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('user-1', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('update: 단일 필드 patch', async () => {
      const existing = makeActivity({ role: '기존' });
      const updated = makeActivity({ role: '신규' });
      repo.findOne
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(updated);
      repo.save.mockResolvedValue(updated);
      const result = await service.update('user-1', 'act-1', { role: '신규' });
      expect(result.role).toBe('신규');
    });

    it('update: type 변경 가능 (snapshot — 기존 logs.cl 영향 없음은 log spec 에서 검증)', async () => {
      const existing = makeActivity({ type: 'intern' });
      const updated = makeActivity({ type: 'study' });
      repo.findOne
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(updated);
      repo.save.mockImplementation(async (a) => a as Activity);
      const result = await service.update('user-1', 'act-1', { type: 'study' });
      expect(result.type).toBe('study');
    });

    it('update: archived activity 도 name/role 등 메타 수정 OK', async () => {
      const archived = makeActivity({ archivedAt: new Date(), name: 'old' });
      const updated = makeActivity({
        archivedAt: archived.archivedAt,
        name: 'new',
      });
      repo.findOne
        .mockResolvedValueOnce(archived)
        .mockResolvedValueOnce(updated);
      repo.save.mockImplementation(async (a) => a as Activity);
      const result = await service.update('user-1', 'act-1', { name: 'new' });
      expect(result.name).toBe('new');
      expect(result.archivedAt).toBeTruthy();
    });

    it('없는 id update → NotFound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.update('user-1', 'x', { name: 'n' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('archive / unarchive', () => {
    it('archive → archivedAt 채워짐', async () => {
      const existing = makeActivity();
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockImplementation(async (a) => a as Activity);
      const r = await service.archive('user-1', 'act-1');
      expect(r.archivedAt).toBeInstanceOf(Date);
    });

    it('unarchive → archivedAt null', async () => {
      const archived = makeActivity({ archivedAt: new Date() });
      repo.findOne.mockResolvedValue(archived);
      repo.save.mockImplementation(async (a) => a as Activity);
      const r = await service.unarchive('user-1', 'act-1');
      expect(r.archivedAt).toBeNull();
    });

    it('이미 archived 인데 archive 다시 → 멱등 (timestamp 갱신)', async () => {
      const old = new Date(Date.now() - 60000);
      const archived = makeActivity({ archivedAt: old });
      repo.findOne.mockResolvedValue(archived);
      repo.save.mockImplementation(async (a) => a as Activity);
      const r = await service.archive('user-1', 'act-1');
      expect(r.archivedAt).toBeInstanceOf(Date);
      expect(r.archivedAt!.getTime()).toBeGreaterThan(old.getTime());
    });

    it('다른 user archive → NotFound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.archive('user-1', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove (hard delete + 2단 가드)', () => {
    it('F5 단계: source_refs 테이블 없음 → 정상 삭제', async () => {
      repo.findOne.mockResolvedValue(makeActivity());
      repo.delete.mockResolvedValue({ raw: [], affected: 1 });
      await service.remove('user-1', 'act-1');
      expect(repo.delete).toHaveBeenCalledWith({ id: 'act-1' });
    });

    it('가드 1 (activity-level): interview_sessions 참조 ≥1 → Conflict', async () => {
      repo.findOne.mockResolvedValue(makeActivity());
      dataSource.query.mockImplementation(async (sql: string) => {
        if (sql.includes('table_name = $1')) return [{ exists: true }];
        if (sql.includes('interview_sessions')) return [{ n: '1' }];
        return [];
      });
      await expect(service.remove('user-1', 'act-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('가드 2 (log-level): activity 의 log 가 cover ref → Conflict', async () => {
      repo.findOne.mockResolvedValue(makeActivity());
      // qb: 활동 소속 log 1개 반환
      const qb = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ id: 'log-1' }]),
      } as unknown as ReturnType<DataSource['createQueryBuilder']>;
      dataSource.createQueryBuilder.mockReturnValue(qb);
      dataSource.query.mockImplementation(async (sql: string) => {
        // tableExists: interview_sessions false, source_refs true
        if (sql.includes('table_name = $1')) {
          // activity-level 첫 호출 = interview_sessions, log-level 둘 = coverletter/interview source_refs
          // 모두 true 로 처리해도 카운트로 차단 가능
          return [{ exists: true }];
        }
        if (sql.includes('interview_sessions')) return [{ n: '0' }];
        if (sql.includes('coverletter_source_refs')) return [{ n: '1' }];
        if (sql.includes('interview_source_refs')) return [{ n: '0' }];
        return [];
      });
      await expect(service.remove('user-1', 'act-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('다른 user remove → NotFound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove('user-1', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('PR 2: activity 의 log 가 interview_prep_sessions.extra_log_ids JSONB 참조 → Conflict + ?| 쿼리 발생', async () => {
      repo.findOne.mockResolvedValue(makeActivity());
      const qb = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ id: 'log-1' }, { id: 'log-2' }]),
      } as unknown as ReturnType<DataSource['createQueryBuilder']>;
      dataSource.createQueryBuilder.mockReturnValue(qb);
      const sqls: string[] = [];
      dataSource.query.mockImplementation(async (sql: string) => {
        sqls.push(sql);
        if (sql.includes('table_name = $1')) return [{ exists: true }];
        // coverletter 0, interview_prep_sessions 1, interview_prep_questions 0 → Conflict
        if (sql.includes('coverletter_source_refs')) return [{ n: '0' }];
        if (sql.includes('interview_prep_sessions')) return [{ n: '1' }];
        if (sql.includes('interview_prep_questions')) return [{ n: '0' }];
        if (sql.includes('interview_sessions')) return [{ n: '0' }];
        return [];
      });
      await expect(service.remove('user-1', 'act-1')).rejects.toThrow(
        ConflictException,
      );
      // ?| (any-of) 연산자로 다중 log id 검색 — JSONB containment 다중
      expect(
        sqls.some(
          (s) =>
            s.includes('interview_prep_sessions') &&
            s.includes('extra_log_ids ?|'),
        ),
      ).toBe(true);
    });

    it('PR 2: interview_prep_questions.source_log_ids JSONB ?| 검색 발생', async () => {
      repo.findOne.mockResolvedValue(makeActivity());
      const qb = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ id: 'log-1' }]),
      } as unknown as ReturnType<DataSource['createQueryBuilder']>;
      dataSource.createQueryBuilder.mockReturnValue(qb);
      const sqls: string[] = [];
      dataSource.query.mockImplementation(async (sql: string) => {
        sqls.push(sql);
        if (sql.includes('table_name = $1')) return [{ exists: true }];
        return [{ n: '0' }];
      });
      await service.remove('user-1', 'act-1');
      expect(
        sqls.some(
          (s) =>
            s.includes('interview_prep_questions') &&
            s.includes('source_log_ids ?|'),
        ),
      ).toBe(true);
    });

    it('PR 2: child log 0 → JSONB 쿼리 자체 skip (불필요한 검색 안 함)', async () => {
      repo.findOne.mockResolvedValue(makeActivity());
      const qb = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      } as unknown as ReturnType<DataSource['createQueryBuilder']>;
      dataSource.createQueryBuilder.mockReturnValue(qb);
      const sqls: string[] = [];
      dataSource.query.mockImplementation(async (sql: string) => {
        sqls.push(sql);
        if (sql.includes('table_name = $1')) return [{ exists: true }];
        return [{ n: '0' }];
      });
      await service.remove('user-1', 'act-1');
      // log-level countLogRefs 자체가 호출 안 됨 (logIds 비어 있으면 0 반환)
      expect(sqls.some((s) => s.includes('source_log_ids ?|'))).toBe(false);
    });
  });
});
