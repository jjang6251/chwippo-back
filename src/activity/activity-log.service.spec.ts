import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, Repository } from 'typeorm';
import { Activity } from './entities/activity.entity';
import { ActivityLog } from './entities/activity-log.entity';
import { ActivityLogService } from './activity-log.service';
import * as autoTagger from './auto-tagger';

describe('ActivityLogService', () => {
  let service: ActivityLogService;
  let activityRepo: jest.Mocked<Repository<Activity>>;
  let logRepo: jest.Mocked<Repository<ActivityLog>>;
  let dataSource: jest.Mocked<DataSource>;
  let autoTagSpy: jest.SpyInstance;

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

  const makeLog = (overrides: Partial<ActivityLog> = {}): ActivityLog => ({
    id: 'log-1',
    activityId: 'act-1',
    userId: 'user-1',
    content: '제목',
    occurredAt: '2026-05-10',
    cat: null,
    comps: [],
    cl: [],
    quant: null,
    mood: null,
    keywords: [],
    note: null,
    noteSummary: null,
    noteSummaryHash: null,
    noteSummaryAt: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    activity: undefined as unknown as ActivityLog['activity'],
    ...overrides,
  });

  beforeEach(async () => {
    autoTagSpy = jest.spyOn(autoTagger, 'autoTag');
    const mockActivityRepo = mock<Repository<Activity>>();
    const mockLogRepo = mock<Repository<ActivityLog>>();
    const mockDataSource = mock<DataSource>();
    mockDataSource.query.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema')) return [{ exists: false }];
      return [];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityLogService,
        { provide: getRepositoryToken(Activity), useValue: mockActivityRepo },
        { provide: getRepositoryToken(ActivityLog), useValue: mockLogRepo },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<ActivityLogService>(ActivityLogService);
    activityRepo = module.get(getRepositoryToken(Activity));
    logRepo = module.get(getRepositoryToken(ActivityLog));
    dataSource = module.get(DataSource);
  });

  afterEach(() => {
    autoTagSpy.mockRestore();
  });

  describe('create — autoTag merge', () => {
    it('content + occurredAt 만 → autoTag 결과로 모든 필드 fallback', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      logRepo.create.mockImplementation((d) => d as ActivityLog);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const result = await service.create('user-1', 'act-1', {
        content: '발표 자료 만들기',
        occurredAt: '2026-05-10',
      });

      expect(autoTagSpy).toHaveBeenCalledWith('발표 자료 만들기', 'intern');
      expect(result.cat).toBe('presentation');
    });

    it('사용자가 cat 명시 → autoTag 무시', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      logRepo.create.mockImplementation((d) => d as ActivityLog);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const result = await service.create('user-1', 'act-1', {
        content: '발표 자료',
        occurredAt: '2026-05-10',
        cat: 'meeting',
      });
      expect(result.cat).toBe('meeting');
    });

    it('mood 만 명시, 나머지 미명시 → autoTag fallback + mood 사용자값', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      logRepo.create.mockImplementation((d) => d as ActivityLog);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const result = await service.create('user-1', 'act-1', {
        content: '주도 운영',
        occurredAt: '2026-05-10',
        mood: 'proud',
      });
      expect(result.mood).toBe('proud');
      expect(result.comps).toContain('leadership'); // autoTag fallback
    });

    it('cl=[] 명시 → 빈 배열 저장 (autoTag fallback 무시)', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity({ type: 'intern' }));
      logRepo.create.mockImplementation((d) => d as ActivityLog);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const result = await service.create('user-1', 'act-1', {
        content: '아무 내용',
        occurredAt: '2026-05-10',
        cl: [],
      });
      // autoTag 가 cl=['job_competency'] 추천했어도 [] 가 우선
      expect(result.cl).toEqual([]);
    });

    it('cl 미명시 + type=intern → autoTag fallback cl=[job_competency]', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity({ type: 'intern' }));
      logRepo.create.mockImplementation((d) => d as ActivityLog);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const result = await service.create('user-1', 'act-1', {
        content: '아무 내용',
        occurredAt: '2026-05-10',
      });
      expect(result.cl).toEqual(['job_competency']);
    });

    it('note JSON 저장·라운드트립', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      logRepo.create.mockImplementation((d) => d as ActivityLog);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const note = { type: 'doc', content: [{ type: 'text', text: 'hi' }] };
      const result = await service.create('user-1', 'act-1', {
        content: 'x',
        occurredAt: '2026-05-10',
        note,
      });
      expect(result.note).toEqual(note);
    });

    it('userId denorm 정확', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      logRepo.create.mockImplementation((d) => d as ActivityLog);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const result = await service.create('user-1', 'act-1', {
        content: 'x',
        occurredAt: '2026-05-10',
      });
      expect(result.userId).toBe('user-1');
    });
  });

  describe('update — autoTag 미호출', () => {
    it('content patch → autoTag 미호출, 기존 cat 보존', async () => {
      const log = makeLog({ cat: 'meeting' });
      logRepo.findOne.mockResolvedValue(log);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      autoTagSpy.mockClear();
      const result = await service.update('user-1', 'log-1', {
        content: '새 내용',
      });

      expect(autoTagSpy).not.toHaveBeenCalled();
      expect(result.cat).toBe('meeting');
      expect(result.content).toBe('새 내용');
    });

    it('mood 만 patch → 다른 필드 모두 보존', async () => {
      const log = makeLog({
        cat: 'analysis',
        comps: ['analytical'],
        cl: ['job_competency'],
        keywords: ['kw'],
      });
      logRepo.findOne.mockResolvedValue(log);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const result = await service.update('user-1', 'log-1', { mood: 'proud' });
      expect(result.mood).toBe('proud');
      expect(result.cat).toBe('analysis');
      expect(result.comps).toEqual(['analytical']);
      expect(result.cl).toEqual(['job_competency']);
      expect(result.keywords).toEqual(['kw']);
    });

    it('cl=[] patch → 빈 배열로 비워짐', async () => {
      const log = makeLog({ cl: ['job_competency', 'challenge'] });
      logRepo.findOne.mockResolvedValue(log);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);
      const result = await service.update('user-1', 'log-1', { cl: [] });
      expect(result.cl).toEqual([]);
    });

    it('archived log 도 update 가능', async () => {
      const log = makeLog({ archivedAt: new Date() });
      logRepo.findOne.mockResolvedValue(log);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);
      const result = await service.update('user-1', 'log-1', {
        content: '수정',
      });
      expect(result.content).toBe('수정');
      expect(result.archivedAt).toBeInstanceOf(Date);
    });

    it('다른 user log update → NotFound', async () => {
      logRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update('user-1', 'x', { content: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    // memory `feedback_test_real_user_flows` — note patch 시 캐시 일관성 검증
    // 의도: update 는 noteSummary 자체는 **건드리지 않음**. UI 는 updatedAt > noteSummaryAt
    // 비교로 stale 라벨 표시하고, 다음 summarize 호출에서 hash 비교로 재호출 결정.
    // (서비스 단순화 — 캐시 무효는 NoteSummaryService 의 hash 비교가 단일 source of truth)
    it('note patch — noteSummary/Hash/At 는 보존됨 (다음 summarize 가 hash 로 무효 판단)', async () => {
      const before = makeLog({
        noteSummary: '이전 요약',
        noteSummaryHash: 'old-hash',
        noteSummaryAt: new Date('2026-05-25T10:00:00Z'),
      });
      logRepo.findOne.mockResolvedValue(before);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const result = await service.update('user-1', 'log-1', {
        note: { type: 'doc', content: [{ type: 'text', text: '새 본문' }] },
      });

      // note 는 바뀜
      expect(result.note).toEqual({
        type: 'doc',
        content: [{ type: 'text', text: '새 본문' }],
      });
      // noteSummary 3종 그대로 보존 — stale 판정은 UI 가 처리
      expect(result.noteSummary).toBe('이전 요약');
      expect(result.noteSummaryHash).toBe('old-hash');
      expect(result.noteSummaryAt).toEqual(new Date('2026-05-25T10:00:00Z'));
    });

    it('content + 그 외 필드만 patch, note 미명시 → noteSummary 3종 보존', async () => {
      const before = makeLog({
        noteSummary: 's',
        noteSummaryHash: 'h',
        noteSummaryAt: new Date('2026-05-25T10:00:00Z'),
      });
      logRepo.findOne.mockResolvedValue(before);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);

      const result = await service.update('user-1', 'log-1', {
        mood: 'proud',
        content: '제목 수정',
      });

      expect(result.noteSummary).toBe('s');
      expect(result.noteSummaryHash).toBe('h');
      expect(result.noteSummaryAt).toEqual(new Date('2026-05-25T10:00:00Z'));
    });
  });

  describe('create — activity ownership / archived', () => {
    it('다른 user 의 activity → NotFound', async () => {
      activityRepo.findOne.mockResolvedValue(null);
      await expect(
        service.create('user-1', 'act-x', {
          content: 'x',
          occurredAt: '2026-05-10',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('archived activity 에 로그 추가 → BadRequest', async () => {
      activityRepo.findOne.mockResolvedValue(
        makeActivity({ archivedAt: new Date() }),
      );
      await expect(
        service.create('user-1', 'act-1', {
          content: 'x',
          occurredAt: '2026-05-10',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('archive / unarchive log', () => {
    it('archiveLog → archived_at 채워짐', async () => {
      logRepo.findOne.mockResolvedValue(makeLog());
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);
      const r = await service.archiveLog('user-1', 'log-1');
      expect(r.archivedAt).toBeInstanceOf(Date);
    });
    it('unarchiveLog → archived_at null', async () => {
      logRepo.findOne.mockResolvedValue(makeLog({ archivedAt: new Date() }));
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);
      const r = await service.unarchiveLog('user-1', 'log-1');
      expect(r.archivedAt).toBeNull();
    });
    it('다른 user log archive → NotFound', async () => {
      logRepo.findOne.mockResolvedValue(null);
      await expect(service.archiveLog('user-1', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove (hard delete + source_refs guard)', () => {
    it('F5 단계 (source_refs 테이블 없음) → 정상 삭제', async () => {
      logRepo.findOne.mockResolvedValue(makeLog());
      logRepo.delete.mockResolvedValue({ raw: [], affected: 1 });
      await service.remove('user-1', 'log-1');
      expect(logRepo.delete).toHaveBeenCalledWith({ id: 'log-1' });
    });

    it('source_refs ≥1 (F6 PR 1·2 시나리오) → Conflict + 카운트 메시지 (자소서·면접 세션·면접 질문 분리)', async () => {
      logRepo.findOne.mockResolvedValue(makeLog());
      dataSource.query.mockImplementation(async (sql: string) => {
        if (sql.includes('information_schema')) return [{ exists: true }];
        if (sql.includes('coverletter_source_refs')) return [{ n: '2' }];
        if (sql.includes('interview_prep_sessions')) return [{ n: '1' }];
        if (sql.includes('interview_prep_questions')) return [{ n: '3' }];
        return [];
      });
      await expect(service.remove('user-1', 'log-1')).rejects.toThrow(
        /자소서 2건.*면접 세션 1개.*면접 질문 3개/,
      );
    });

    it('다른 user log remove → NotFound', async () => {
      logRepo.findOne.mockResolvedValue(null);
      await expect(service.remove('user-1', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('PR 1: countLogRefs 의 coverletter_source_refs SQL 이 source_log_id 컬럼명 사용 (마이그레이션 정합성)', async () => {
      logRepo.findOne.mockResolvedValue(makeLog());
      logRepo.delete.mockResolvedValue({ raw: [], affected: 1 });
      const sqls: string[] = [];
      dataSource.query.mockImplementation(async (sql: string) => {
        sqls.push(sql);
        if (sql.includes('information_schema')) return [{ exists: true }];
        return [{ n: '0' }];
      });
      await service.remove('user-1', 'log-1');
      expect(
        sqls.some(
          (s) =>
            s.includes('coverletter_source_refs') &&
            s.includes('source_log_id'),
        ),
      ).toBe(true);
      // 구 컬럼명 (단순 'log_id') 으로 coverletter 테이블 조회하면 안 됨 (회귀 차단)
      expect(
        sqls.some((s) => s.includes('coverletter_source_refs WHERE log_id')),
      ).toBe(false);
    });
  });

  describe('엣지', () => {
    it('quant {type:count, value:0, unit:명} 저장 OK', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      logRepo.create.mockImplementation((d) => d as ActivityLog);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);
      const result = await service.create('user-1', 'act-1', {
        content: 'x',
        occurredAt: '2026-05-10',
        quant: { type: 'count', value: '0', unit: '명' },
      });
      expect(result.quant).toEqual({ type: 'count', value: '0', unit: '명' });
    });

    it('occurredAt 미래 → 저장 허용', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      logRepo.create.mockImplementation((d) => d as ActivityLog);
      logRepo.save.mockImplementation(async (l) => l as ActivityLog);
      const result = await service.create('user-1', 'act-1', {
        content: 'x',
        occurredAt: '2099-01-01',
      });
      expect(result.occurredAt).toBe('2099-01-01');
    });
  });
});
