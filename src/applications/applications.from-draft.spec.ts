import { BadRequestException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import type { LlmService } from '../ai/llm.service';
import { DailyNote } from '../calendar/daily-note.entity';
import type { CompaniesService } from '../companies/companies.service';
import type { DiscordNotifier } from '../common/discord-notifier';
import { Application, type PostingMeta } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { ApplicationsService } from './applications.service';
import type { CardDraft } from './job-posting-card.rules';

/**
 * `createFromDraft` · `updatePostingMeta` · `remove` · `updateStep` spec (대장 21).
 *
 * | 축 | 케이스 |
 * |---|---|
 * | 카드 | IN_PROGRESS · created_via=paste_posting · job_title_source=posting · template_id=null |
 * | 계열 | jobCategory 는 **null** (서버가 추측하지 않는다) |
 * | 스텝 | 이름·orderIndex·날짜(KST 벽시각)·dateHint |
 * | 🔴 시각 | 'YYYY-MM-DDTHH:mm' 이 **서버 TZ 와 무관하게** KST 로 저장된다 (TZ 2축) |
 * | 일정 | daily_notes 「{회사} · {단계}」 · hour_slot · 200자 컷 · noteIds/extraDates |
 * | TX | 메모 INSERT 실패 → 카드도 롤백 |
 * | 요건 | jobPosting 없으면 null · parsedAt 세팅 |
 * | 되돌리기 | soft delete + 메모 삭제 · **본인 것만** (userId 재가드) |
 * | posting-meta | reviewedAt 멱등 · editedFields 합집합 누적 · 공고 카드가 아니면 400 |
 * | updateStep | 날짜를 넣으면 힌트가 사라진다 · 날짜를 비우면 힌트는 남는다 |
 */
describe('ApplicationsService — 공고 초안으로 카드 만들기', () => {
  const USER = 'user-1';

  const draft = (over: Partial<CardDraft> = {}): CardDraft => ({
    companyName: '무신사',
    jobTitle: '백엔드 개발자',
    jobTitles: [],
    nearProfile: [],
    jobPicked: 'single',
    companySource: 'parsed',
    deadline: '2026-09-15T18:00',
    deadlineKind: 'fixed',
    jobUrl: null,
    steps: [
      { name: '서류 접수', date: '2026-09-15T18:00', dateHint: null },
      { name: '1차 면접', date: null, dateHint: '10월 초' },
      { name: '최종 합격', date: null, dateHint: null },
    ],
    extraDates: [
      { label: '서류 합격 발표', date: '2026-09-20', time: '17:00' },
      { label: '신체검사', date: '2026-12-15', time: null },
    ],
    jobPosting: {
      responsibilities: 'API 설계',
      requirements: ['Node.js 3년'],
      preferred: [],
      techStack: ['Node.js'],
      qualifications: [],
      keywords: ['백엔드'],
    },
    orderConflict: false,
    postingYear: 2026,
    notPosting: false,
    filled: ['companyName', 'jobTitle', 'deadline', 'steps', 'jobPosting'],
    ...over,
  });

  interface Captured {
    app: Partial<Application> | null;
    steps: Partial<ApplicationStep>[];
    notes: Partial<DailyNote>[];
    postingMeta: PostingMeta | null;
    deletedNotes: unknown;
    softRemoved: boolean;
  }

  const build = (opts: { failNotes?: boolean } = {}) => {
    const captured: Captured = {
      app: null,
      steps: [],
      notes: [],
      postingMeta: null,
      deletedNotes: null,
      softRemoved: false,
    };

    let noteSeq = 0;
    const em: Partial<EntityManager> = {
      create: jest.fn((_e: unknown, data: unknown) => ({
        ...(data as Record<string, unknown>),
      })) as unknown as EntityManager['create'],
      save: jest.fn(async (entity: unknown, data: unknown) => {
        if (entity === Application) {
          captured.app = { ...(data as Partial<Application>), id: 'card-1' };
          return captured.app;
        }
        if (entity === ApplicationStep) {
          captured.steps = data as Partial<ApplicationStep>[];
          return data;
        }
        if (entity === DailyNote) {
          if (opts.failNotes) throw new Error('daily_notes INSERT 실패');
          const rows = (data as Partial<DailyNote>[]).map((n) => ({
            ...n,
            id: `note-${++noteSeq}`,
          }));
          captured.notes = rows;
          return rows;
        }
        return data;
      }) as unknown as EntityManager['save'],
      update: jest.fn(async (_e: unknown, _w: unknown, patch: unknown) => {
        const p = patch as { postingMeta?: PostingMeta };
        if (p.postingMeta) captured.postingMeta = p.postingMeta;
        return { affected: 1 };
      }) as unknown as EntityManager['update'],
      findOne: jest.fn(async () => ({
        ...captured.app,
        steps: captured.steps,
      })) as unknown as EntityManager['findOne'],
      delete: jest.fn(async (_e: unknown, where: unknown) => {
        captured.deletedNotes = where;
        return { affected: 1 };
      }) as unknown as EntityManager['delete'],
      softRemove: jest.fn(async () => {
        captured.softRemoved = true;
        return {};
      }) as unknown as EntityManager['softRemove'],
    };

    const dataSource = {
      transaction: jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) =>
        cb(em as EntityManager),
      ),
    };

    const appRepo = mock<Repository<Application>>();
    appRepo.count.mockResolvedValue(5);
    const stepRepo = mock<Repository<ApplicationStep>>();
    const companies = mock<CompaniesService>();
    companies.getDomainByName.mockReturnValue(undefined);
    const discord = mock<DiscordNotifier>();
    discord.notify.mockResolvedValue('skipped_no_webhook');

    const service = new ApplicationsService(
      appRepo,
      stepRepo,
      mock<Repository<never>>() as never,
      mock<Repository<never>>() as never,
      mock<Repository<never>>() as never,
      mock<Repository<never>>() as never,
      dataSource as unknown as DataSource,
      mock<LlmService>(),
      companies,
      discord,
    );
    return { service, captured, appRepo, stepRepo, em };
  };

  // ── 카드 ──────────────────────────────────────────────────────────────

  describe('카드 본문', () => {
    it('IN_PROGRESS · paste_posting · posting 출처로 만든다', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft(), {
        textHash: 'h'.repeat(64),
        callCount: 1,
      });
      expect(captured.app).toMatchObject({
        userId: USER,
        companyName: '무신사',
        jobTitle: '백엔드 개발자',
        status: 'IN_PROGRESS',
        createdVia: 'paste_posting',
        jobTitleSource: 'posting',
        templateId: null,
      });
    });

    it('🔴 계열(jobCategory)은 null 로 둔다 — 판정 규칙이 프론트에만 있어 사본을 만들면 어긋난다', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft(), {
        textHash: 'h',
        callCount: 1,
      });
      expect(captured.app?.jobCategory).toBeNull();
    });

    it('직무를 못 찾았으면 출처도 남기지 않고 needsDetail 을 세운다', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft({ jobTitle: null }), {
        textHash: 'h',
        callCount: 1,
      });
      expect(captured.app?.jobTitleSource).toBeNull();
      expect(captured.app?.needsDetail).toBe(true);
    });

    it('회사명이 없으면 만들지 않는다 (company_name 은 NOT NULL — 호출부 계약 위반)', async () => {
      const { service } = build();
      await expect(
        service.createFromDraft(USER, draft({ companyName: null }), {
          textHash: 'h',
          callCount: 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('요건이 있으면 parsedAt 을 서버가 찍어 저장한다', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft(), {
        textHash: 'h',
        callCount: 1,
      });
      expect(captured.app?.jobPosting).toMatchObject({
        requirements: ['Node.js 3년'],
        parsedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });

    it('요건이 없으면 job_posting 은 null (자소서 배너가 「정리하기」를 제안한다)', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft({ jobPosting: null }), {
        textHash: 'h',
        callCount: 1,
      });
      expect(captured.app?.jobPosting).toBeNull();
    });
  });

  // ── 스텝 ──────────────────────────────────────────────────────────────

  describe('스텝', () => {
    it('이름·순서·힌트를 그대로 옮긴다', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft(), {
        textHash: 'h',
        callCount: 1,
      });
      expect(
        captured.steps.map((s) => [s.orderIndex, s.name, s.dateHint]),
      ).toEqual([
        [0, '서류 접수', null],
        [1, '1차 면접', '10월 초'],
        [2, '최종 합격', null],
      ]);
    });

    it('🔴 시각이 **KST 벽시각**으로 저장된다 — 서버 TZ 가 UTC 여도 9시간 안 어긋난다', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft(), {
        textHash: 'h',
        callCount: 1,
      });
      const d = captured.steps[0].scheduledDate;
      expect(d).toBeInstanceOf(Date);
      // 2026-09-15 18:00 KST = 09:00Z. `new Date('...T18:00')` 였다면 서버 TZ 를 탄다
      expect(d?.toISOString()).toBe('2026-09-15T09:00:00.000Z');
    });

    it('날짜 없는 스텝은 null 로 (지어내지 않는다)', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft(), {
        textHash: 'h',
        callCount: 1,
      });
      expect(captured.steps[1].scheduledDate).toBeNull();
    });
  });

  // ── 캘린더 일정 ───────────────────────────────────────────────────────

  describe('캘린더 일정 (daily_notes)', () => {
    it('「{회사} · {단계}」로 만들고 시각은 hour_slot 으로 접는다', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft(), {
        textHash: 'h',
        callCount: 1,
      });
      expect(captured.notes).toEqual([
        expect.objectContaining({
          userId: USER,
          date: '2026-09-20',
          hourSlot: 22, // 17:00 → (17-6)*2 = 22
          content: '무신사 · 서류 합격 발표',
        }),
        expect.objectContaining({
          date: '2026-12-15',
          hourSlot: null, // 시각 없음 → 당일 아침 브리핑만
          content: '무신사 · 신체검사',
        }),
      ]);
    });

    it('content 는 200자에서 자른다 (컬럼 상한)', async () => {
      const { service, captured } = build();
      await service.createFromDraft(
        USER,
        draft({
          companyName: '가'.repeat(100),
          extraDates: [
            { label: '나'.repeat(150), date: '2026-09-20', time: null },
          ],
        }),
        { textHash: 'h', callCount: 1 },
      );
      expect(captured.notes[0].content).toHaveLength(200);
    });

    it('🔴 만든 메모 id 를 posting_meta 에 적는다 — 되돌리기의 유일한 연결 고리다', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft(), {
        textHash: 'h'.repeat(64),
        callCount: 2,
      });
      expect(captured.postingMeta).toMatchObject({
        noteIds: ['note-1', 'note-2'],
        extraDates: [
          { label: '서류 합격 발표', date: '2026-09-20', noteId: 'note-1' },
          { label: '신체검사', date: '2026-12-15', noteId: 'note-2' },
        ],
        callCount: 2,
        textHash: 'h'.repeat(64),
        companySource: 'parsed',
        jobPicked: 'single',
        deadlineKind: 'fixed',
        reviewedAt: null,
        editedFields: [],
        orderConflict: false,
      });
    });

    it('일정이 없으면 메모도 안 만든다', async () => {
      const { service, captured } = build();
      await service.createFromDraft(USER, draft({ extraDates: [] }), {
        textHash: 'h',
        callCount: 1,
      });
      expect(captured.notes).toEqual([]);
      expect(captured.postingMeta?.noteIds).toEqual([]);
    });

    it('🔴 메모 INSERT 가 실패하면 카드도 함께 롤백된다 (반쪽 카드 금지)', async () => {
      const { service, dataSource } = (() => {
        const b = build({ failNotes: true });
        return { ...b, dataSource: null };
      })();
      void dataSource;
      await expect(
        service.createFromDraft(USER, draft(), { textHash: 'h', callCount: 1 }),
      ).rejects.toThrow('daily_notes INSERT 실패');
    });
  });

  // ── 되돌리기 ──────────────────────────────────────────────────────────

  describe('되돌리기 (soft delete)', () => {
    const cardWithNotes = (over: Partial<PostingMeta> = {}): Application =>
      ({
        id: 'card-1',
        userId: USER,
        companyName: '무신사',
        postingMeta: {
          filled: [],
          deadlineKind: 'fixed',
          jobPicked: 'single',
          companySource: 'parsed',
          editedFields: [],
          reviewedAt: null,
          callCount: 1,
          textHash: 'h',
          noteIds: ['note-1', 'note-2'],
          extraDates: [],
          orderConflict: false,
          ...over,
        },
      }) as Application;

    it('🔴 캘린더 메모도 같이 지운다 — 안 지우면 지운 카드의 발표일이 캘린더에 영영 남는다', async () => {
      const { service, appRepo, captured } = build();
      appRepo.findOne.mockResolvedValue(cardWithNotes());
      await service.remove(USER, 'card-1');
      expect(captured.deletedNotes).toMatchObject({ userId: USER });
      expect(captured.softRemoved).toBe(true);
    });

    it('🔴 삭제 WHERE 에 userId 를 다시 건다 — 조작된 메타에 남의 note id 가 섞여 있어도 본인 것만', async () => {
      const { service, appRepo, captured } = build();
      appRepo.findOne.mockResolvedValue(
        cardWithNotes({ noteIds: ['note-1', 'someone-elses-note'] }),
      );
      await service.remove(USER, 'card-1');
      expect(captured.deletedNotes).toEqual(
        expect.objectContaining({ userId: USER }),
      );
    });

    it('공고 카드가 아니면 메모 삭제를 시도하지 않는다', async () => {
      const { service, appRepo, captured, em } = build();
      appRepo.findOne.mockResolvedValue({
        id: 'card-1',
        userId: USER,
        postingMeta: null,
      } as Application);
      await service.remove(USER, 'card-1');
      expect(em.delete).not.toHaveBeenCalled();
      expect(captured.softRemoved).toBe(true);
    });
  });

  // ── posting-meta ──────────────────────────────────────────────────────

  describe('updatePostingMeta', () => {
    const base: PostingMeta = {
      filled: ['companyName'],
      deadlineKind: 'fixed',
      jobPicked: 'single',
      companySource: 'parsed',
      editedFields: ['deadline'],
      reviewedAt: null,
      callCount: 1,
      textHash: 'h',
      noteIds: [],
      extraDates: [],
      orderConflict: false,
    };

    const withMeta = (meta: PostingMeta | null) =>
      ({
        id: 'card-1',
        userId: USER,
        companyName: '무신사',
        postingMeta: meta,
        // 갱신 후 `findOne` 이 relations:['steps'] 로 다시 읽는다
        steps: [],
      }) as unknown as Application;

    it('reviewed:true 면 시각을 찍는다', async () => {
      const { service, appRepo } = build();
      appRepo.findOne.mockResolvedValue(withMeta(base));
      appRepo.update.mockResolvedValue({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      await service.updatePostingMeta(USER, 'card-1', { reviewed: true });
      const patch = appRepo.update.mock.calls[0][1] as {
        postingMeta: PostingMeta;
      };
      expect(patch.postingMeta.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('멱등 — 두 번 눌러도 첫 확인 시각을 유지한다', async () => {
      const { service, appRepo } = build();
      appRepo.findOne.mockResolvedValue(
        withMeta({ ...base, reviewedAt: '2026-08-29T01:00:00.000Z' }),
      );
      appRepo.update.mockResolvedValue({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      await service.updatePostingMeta(USER, 'card-1', { reviewed: true });
      const patch = appRepo.update.mock.calls[0][1] as {
        postingMeta: PostingMeta;
      };
      expect(patch.postingMeta.reviewedAt).toBe('2026-08-29T01:00:00.000Z');
    });

    it('🔴 editedFields 는 합집합으로 누적한다 — 덮으면 두 칸 고친 사람이 한 칸으로 집계된다', async () => {
      const { service, appRepo } = build();
      appRepo.findOne.mockResolvedValue(withMeta(base));
      appRepo.update.mockResolvedValue({
        affected: 1,
        raw: [],
        generatedMaps: [],
      });
      await service.updatePostingMeta(USER, 'card-1', {
        editedFields: ['jobTitle', 'deadline', '  '],
      });
      const patch = appRepo.update.mock.calls[0][1] as {
        postingMeta: PostingMeta;
      };
      expect(patch.postingMeta.editedFields.sort()).toEqual([
        'deadline',
        'jobTitle',
      ]);
    });

    it('공고로 만든 카드가 아니면 400', async () => {
      const { service, appRepo } = build();
      appRepo.findOne.mockResolvedValue(withMeta(null));
      await expect(
        service.updatePostingMeta(USER, 'card-1', { reviewed: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── updateStep ────────────────────────────────────────────────────────

  describe('updateStep — 날짜와 힌트는 공존하지 않는다', () => {
    const makeStep = (): ApplicationStep =>
      ({
        id: 'step-1',
        applicationId: 'card-1',
        orderIndex: 1,
        name: '1차 면접',
        scheduledDate: null,
        dateHint: '10월 초',
        location: null,
        notes: null,
        pinnedContent: null,
      }) as ApplicationStep;

    it('진짜 날짜를 넣으면 힌트가 사라진다', async () => {
      const { service, appRepo, stepRepo } = build();
      appRepo.findOne.mockResolvedValue({
        id: 'card-1',
        userId: USER,
      } as Application);
      const step = makeStep();
      stepRepo.findOne.mockResolvedValue(step);
      stepRepo.save.mockImplementation(async (s) => s as ApplicationStep);

      const saved = await service.updateStep(USER, 'card-1', 'step-1', {
        scheduledDate: '2026-10-08T00:00:00+09:00',
      });
      expect(saved.dateHint).toBeNull();
      expect(saved.scheduledDate).toBeInstanceOf(Date);
    });

    it('날짜를 비우는 편집은 힌트를 건드리지 않는다 — 원래 정보가 되살아난다', async () => {
      const { service, appRepo, stepRepo } = build();
      appRepo.findOne.mockResolvedValue({
        id: 'card-1',
        userId: USER,
      } as Application);
      stepRepo.findOne.mockResolvedValue(makeStep());
      stepRepo.save.mockImplementation(async (s) => s as ApplicationStep);

      const saved = await service.updateStep(USER, 'card-1', 'step-1', {
        scheduledDate: undefined,
      });
      expect(saved.dateHint).toBe('10월 초');
    });

    it('장소만 고치면 힌트는 그대로', async () => {
      const { service, appRepo, stepRepo } = build();
      appRepo.findOne.mockResolvedValue({
        id: 'card-1',
        userId: USER,
      } as Application);
      stepRepo.findOne.mockResolvedValue(makeStep());
      stepRepo.save.mockImplementation(async (s) => s as ApplicationStep);

      const saved = await service.updateStep(USER, 'card-1', 'step-1', {
        location: '성수동',
      });
      expect(saved.dateHint).toBe('10월 초');
    });
  });
});
