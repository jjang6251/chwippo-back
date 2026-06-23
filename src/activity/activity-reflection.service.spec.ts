import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { Activity } from './entities/activity.entity';
import { ActivityReflection } from './entities/activity-reflection.entity';
import {
  ActivityReflectionService,
  getISOWeekMonday,
} from './activity-reflection.service';

describe('ActivityReflectionService', () => {
  let service: ActivityReflectionService;
  let activityRepo: jest.Mocked<Repository<Activity>>;
  let refRepo: jest.Mocked<Repository<ActivityReflection>>;

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
    summaryReflection: null,
    logs: [],
    reflections: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    user: undefined as unknown as Activity['user'],
    ...overrides,
  });

  const makeRef = (
    overrides: Partial<ActivityReflection> = {},
  ): ActivityReflection => ({
    id: 'ref-1',
    activityId: 'act-1',
    userId: 'user-1',
    content: '회고',
    weekStart: '2026-05-18',
    growth: [],
    challenges: [],
    nextActions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    activity: undefined as unknown as ActivityReflection['activity'],
    ...overrides,
  });

  beforeEach(async () => {
    const mockActivityRepo = mock<Repository<Activity>>();
    const mockRefRepo = mock<Repository<ActivityReflection>>();
    // PR 1: countReflectionRefs 가 dataSource.query 로 coverletter_source_refs COUNT.
    // dev/CI DB 에 테이블 있으므로 tableExists=true 분기 + count 0 반환 simulation.
    const mockDataSource = {
      query: jest.fn().mockResolvedValue([{ exists: false, n: '0' }]),
    } as unknown as DataSource;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityReflectionService,
        { provide: getRepositoryToken(Activity), useValue: mockActivityRepo },
        {
          provide: getRepositoryToken(ActivityReflection),
          useValue: mockRefRepo,
        },
        { provide: getDataSourceToken(), useValue: mockDataSource },
      ],
    }).compile();
    service = module.get<ActivityReflectionService>(ActivityReflectionService);
    activityRepo = module.get(getRepositoryToken(Activity));
    refRepo = module.get(getRepositoryToken(ActivityReflection));
  });

  describe('getISOWeekMonday — KST 기준 (feedback_kst_local_date)', () => {
    it('월요일은 자기 자신', () => {
      const mon = new Date('2026-05-18T12:00:00Z'); // KST 21:00 월
      expect(getISOWeekMonday(mon)).toBe('2026-05-18');
    });
    it('일요일은 직전 월요일', () => {
      const sun = new Date('2026-05-24T12:00:00Z'); // KST 21:00 일
      expect(getISOWeekMonday(sun)).toBe('2026-05-18');
    });
    it('수요일은 같은 주 월요일', () => {
      const wed = new Date('2026-05-20T12:00:00Z'); // KST 21:00 수
      expect(getISOWeekMonday(wed)).toBe('2026-05-18');
    });
    // 월말 경계 — 일요일이 전월
    it('일요일이 전월 마지막 날 — 월요일은 전월', () => {
      const sun = new Date('2026-03-01T12:00:00Z'); // KST 21:00 일
      expect(getISOWeekMonday(sun)).toBe('2026-02-23');
    });
    // 연말 경계 — 일요일이 전년 12월
    it('일요일이 새해 첫주 — 월요일은 전년 12월', () => {
      const sun = new Date('2027-01-03T12:00:00Z'); // KST 21:00 일
      expect(getISOWeekMonday(sun)).toBe('2026-12-28');
    });
    // KST 자정 경계 — UTC 일 이라도 KST 월이면 KST 기준
    it('UTC 일 23:00 = KST 월 08:00 — KST 기준 월요일 처리', () => {
      const utcSun23 = new Date('2026-05-17T23:00:00Z'); // UTC 일 23:00 = KST 월 08:00
      expect(getISOWeekMonday(utcSun23)).toBe('2026-05-18');
    });
    // KST 일 23:00 = UTC 일 14:00 — KST 일이라 직전 월요일
    it('KST 일 23:00 = UTC 일 14:00 — KST 일 → 직전 월요일', () => {
      const kstSun23 = new Date('2026-05-24T14:00:00Z'); // UTC 14 = KST 23 일
      expect(getISOWeekMonday(kstSun23)).toBe('2026-05-18');
    });
    // 인자 없으면 오늘 (smoke)
    it('인자 없음 — 결과는 YYYY-MM-DD 형식', () => {
      expect(getISOWeekMonday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('create', () => {
    it('weekStart 없으면 자동 계산', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      refRepo.create.mockImplementation((d) => d as ActivityReflection);
      refRepo.save.mockImplementation(async (r) => r as ActivityReflection);
      const result = await service.create('user-1', 'act-1', {
        content: '내용',
      });
      expect(result.weekStart).toBeTruthy();
      // 자동 계산된 값은 오늘 기준 월요일
      expect(result.weekStart).toBe(getISOWeekMonday());
    });

    it('weekStart 명시 → 그대로 저장 (보정 없음)', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      refRepo.create.mockImplementation((d) => d as ActivityReflection);
      refRepo.save.mockImplementation(async (r) => r as ActivityReflection);
      const result = await service.create('user-1', 'act-1', {
        content: '내용',
        weekStart: '2026-05-19', // 화요일
      });
      expect(result.weekStart).toBe('2026-05-19');
    });

    it('growth/challenges/nextActions 배열 저장', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      refRepo.create.mockImplementation((d) => d as ActivityReflection);
      refRepo.save.mockImplementation(async (r) => r as ActivityReflection);
      const result = await service.create('user-1', 'act-1', {
        content: 'x',
        growth: ['성장1', '성장2'],
        challenges: ['도전1'],
        nextActions: ['액션1', '액션2', '액션3'],
      });
      expect(result.growth).toEqual(['성장1', '성장2']);
      expect(result.challenges).toEqual(['도전1']);
      expect(result.nextActions).toEqual(['액션1', '액션2', '액션3']);
    });

    it('같은 weekStart 에 두 reflection 생성 → 둘 다 저장', async () => {
      activityRepo.findOne.mockResolvedValue(makeActivity());
      refRepo.create.mockImplementation((d) => d as ActivityReflection);
      refRepo.save.mockImplementation(async (r) => r as ActivityReflection);
      const r1 = await service.create('user-1', 'act-1', {
        content: '회고1',
        weekStart: '2026-05-18',
      });
      const r2 = await service.create('user-1', 'act-1', {
        content: '회고2',
        weekStart: '2026-05-18',
      });
      expect(r1.content).toBe('회고1');
      expect(r2.content).toBe('회고2');
      expect(refRepo.save).toHaveBeenCalledTimes(2);
    });

    it('다른 user activity → NotFound', async () => {
      activityRepo.findOne.mockResolvedValue(null);
      await expect(
        service.create('user-1', 'x', { content: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('content 만 patch → growth/challenges/nextActions 보존', async () => {
      const ref = makeRef({
        growth: ['old'],
        challenges: ['c'],
        nextActions: ['n'],
      });
      refRepo.findOne.mockResolvedValue(ref);
      refRepo.save.mockImplementation(async (r) => r as ActivityReflection);
      const result = await service.update('user-1', 'ref-1', {
        content: '새 회고',
      });
      expect(result.content).toBe('새 회고');
      expect(result.growth).toEqual(['old']);
      expect(result.challenges).toEqual(['c']);
      expect(result.nextActions).toEqual(['n']);
    });

    it('growth 만 patch → 다른 배열 보존', async () => {
      const ref = makeRef({
        content: 'orig',
        growth: ['old'],
        challenges: ['c'],
      });
      refRepo.findOne.mockResolvedValue(ref);
      refRepo.save.mockImplementation(async (r) => r as ActivityReflection);
      const result = await service.update('user-1', 'ref-1', {
        growth: ['new1', 'new2'],
      });
      expect(result.growth).toEqual(['new1', 'new2']);
      expect(result.content).toBe('orig');
      expect(result.challenges).toEqual(['c']);
    });

    it('다른 user reflection update → NotFound', async () => {
      refRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update('user-1', 'x', { content: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove (PR 1: source_refs guard 신규)', () => {
    it('정상 삭제 — coverletter_source_refs 테이블 없거나 COUNT 0', async () => {
      refRepo.findOne.mockResolvedValue(makeRef());
      refRepo.remove.mockResolvedValue(makeRef());
      // 기본 mockDataSource 가 항상 빈 결과 → tableExists false → 통과
      await service.remove('user-1', 'ref-1');
      expect(refRepo.remove).toHaveBeenCalled();
    });

    it('다른 user reflection remove → NotFound', async () => {
      refRepo.findOne.mockResolvedValue(null);
      await expect(service.remove('user-1', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('PR 1: coverletter_source_refs.source_reflection_id 참조 ≥1 → Conflict + "자소서 N건" 메시지', async () => {
      refRepo.findOne.mockResolvedValue(makeRef());
      // DataSource mock 을 새 instance 로 교체 (이 케이스 한정)
      const queryFn = jest.fn(async (sql: string) => {
        if (sql.includes('information_schema')) return [{ exists: true }];
        if (sql.includes('source_reflection_id')) return [{ n: '3' }];
        return [];
      });
      // service 내부 dataSource 를 직접 spy 로 교체 (jest-mock-extended 한계 우회)
      const ds = (service as unknown as { dataSource: { query: jest.Mock } })
        .dataSource;
      ds.query.mockImplementation(queryFn);

      await expect(service.remove('user-1', 'ref-1')).rejects.toThrow(
        /자소서 3건/,
      );
      expect(refRepo.remove).not.toHaveBeenCalled();
    });

    it('PR 1: countReflectionRefs SQL 이 source_reflection_id 컬럼명 사용 (마이그레이션 정합성)', async () => {
      refRepo.findOne.mockResolvedValue(makeRef());
      const queryFn = jest.fn(async (sql: string) => {
        if (sql.includes('information_schema')) return [{ exists: true }];
        return [{ n: '0' }];
      });
      const ds = (service as unknown as { dataSource: { query: jest.Mock } })
        .dataSource;
      ds.query.mockImplementation(queryFn);

      await service.countReflectionRefs('refl-1');
      // SQL 에 정확한 컬럼명 포함 검증 (오타·구 컬럼명 회귀 차단)
      const calls = ds.query.mock.calls;
      const sqls = calls.map((c) => String(c[0]));
      expect(
        sqls.some(
          (s) =>
            s.includes('coverletter_source_refs') &&
            s.includes('source_reflection_id'),
        ),
      ).toBe(true);
    });
  });
});
