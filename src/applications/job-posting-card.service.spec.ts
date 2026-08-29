import { NotFoundException } from '@nestjs/common';
import { mock } from 'jest-mock-extended';
import { LlmService, PROVIDER_OUTAGE_USER_MESSAGE } from '../ai/llm.service';
import { QuotaCheckService } from '../ai/quota-check.service';
import { todayKst } from '../common/datetime';
import type { Application } from './application.entity';
import type { ApplicationsService } from './applications.service';
import { JobPostingCardService, sha256 } from './job-posting-card.service';
import { PostingDraftStore } from './posting-draft.store';

/**
 * 공고 → 카드 서비스 spec — **오케스트레이션**만 본다
 * (날짜·이름 규칙은 `job-posting-card.rules.spec.ts` 가 전담).
 *
 * | 축 | 케이스 |
 * |---|---|
 * | 정상 | 카드 생성 · feature 키 `jobposting_card` · resourceType user · strict schema |
 * | 차단 | quota(+preBlocked audit 행) · 동의 미완 → CONSENT_REQUIRED · 장애 → 전용 문구 · 일반 오류 |
 * | notPosting | 카드 미생성 |
 * | 보완 질문 | 회사명 없음 → needs:'company' · 직무 여럿 → needs:'job' + 후보 · 초안은 서버 보관 |
 * | 중복 | 같은 원문 10분 내 2회 → 카드 1장 · 지워진 카드면 다시 만든다 |
 * | 동시 | 진행 4번째 → TOO_MANY_PENDING (LLM 미호출) · 끝나면 슬롯 반납 |
 * | commit | 회사명 → 파싱 없이 생성 · 직무 → 후보에서 확정 · 없는 hash → 404 · 타인 hash → 404 |
 * | pending | 본인 것만 · 초안 **본문은 안 준다** |
 * | 원문 | rawText 가 응답·저장 어디에도 없다 · LLM 에는 user 역할·코드블록으로만 간다 |
 */
describe('JobPostingCardService', () => {
  const USER = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const RAW =
    '[무신사] 백엔드 개발자 채용\n접수 마감 2026-09-15 18:00\n전형: 서류 접수 → 1차 면접 → 최종 합격\n자격요건: Node.js 3년';

  let service: JobPostingCardService;
  let llm: jest.Mocked<LlmService>;
  let quota: jest.Mocked<QuotaCheckService>;
  let apps: jest.Mocked<ApplicationsService>;
  let store: PostingDraftStore;
  let appRepo: { findOne: jest.Mock };
  let userRepo: { findOne: jest.Mock };
  let researchRepo: { findOne: jest.Mock };

  /** 실측 형태의 LLM 출력 (v3 스키마) */
  const OK_JSON = {
    notPosting: false,
    companyName: '무신사',
    jobTitles: ['백엔드 개발자'],
    postingYear: 2026,
    jobUrl: null,
    deadline: { year: 2026, month: 9, day: 15, time: '18:00', weekday: null },
    deadlineKind: 'fixed',
    steps: [
      {
        name: '서류 접수',
        date: { year: 2026, month: 9, day: 15, time: '18:00', weekday: null },
        dateHint: null,
      },
      { name: '1차 면접', date: null, dateHint: '10월 초' },
      { name: '최종 합격', date: null, dateHint: null },
    ],
    responsibilities: 'API 설계',
    requirements: ['Node.js 3년'],
    preferred: [],
    techStack: ['Node.js'],
    qualifications: [],
    keywords: ['백엔드'],
  };

  const okResult = (json: unknown = OK_JSON) => ({
    status: 'ok' as const,
    text: '',
    json,
    promptTokens: 3000,
    completionTokens: 300,
    costUsd: 0.0005,
    latencyMs: 1800,
    callLogId: 'log-1',
    outputRedacted: false,
    coinCost: 0,
  });

  /** 응답으로 돌려줄 카드 — 이 spec 은 오케스트레이션만 보므로 식별 필드만 채운다 */
  const card = (id = 'card-1'): Application =>
    ({
      id,
      userId: USER,
      companyName: '무신사',
      steps: [],
    }) as unknown as Application;

  beforeEach(() => {
    llm = mock<LlmService>();
    llm.call.mockResolvedValue(okResult());

    quota = mock<QuotaCheckService>();
    quota.checkAndPrepare.mockResolvedValue({ blocked: false });

    apps = mock<ApplicationsService>();
    apps.createFromDraft.mockResolvedValue(card());

    store = new PostingDraftStore(null);
    appRepo = { findOne: jest.fn().mockResolvedValue(card()) };
    userRepo = { findOne: jest.fn().mockResolvedValue(null) };
    researchRepo = { findOne: jest.fn().mockResolvedValue(null) };

    service = new JobPostingCardService(
      appRepo as never,
      userRepo as never,
      llm,
      quota,
      store,
      apps,
      researchRepo as never,
    );
  });

  /** createFromDraft(userId, draft, opts) 의 draft */
  const createdDraft = () => apps.createFromDraft.mock.calls[0][1];

  // ── 회사명 정규화 — 「우리가 조사해 둔 회사면 그 표기로, 없으면 그대로」 (CEO 8/30) ──

  describe('회사명 정규화 (조사 캐시 canonical_name)', () => {
    it('🔴 별칭 행이 있으면 그 본명 표기로 카드를 만든다 — 「SK hynix」 → 「SK하이닉스」', async () => {
      llm.call.mockResolvedValue(
        okResult({ ...OK_JSON, companyName: 'SK hynix' }),
      );
      researchRepo.findOne.mockResolvedValue({
        id: 'r1',
        canonicalName: 'SK하이닉스',
      });
      const r = await parse();
      expect('card' in r).toBe(true);
      expect(createdDraft()?.companyName).toBe('SK하이닉스');
      // 캐시 키 규칙(소문자·trim)으로 조회한다 — 별칭 행이 그 키로 들어 있다
      expect(researchRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ companyName: 'sk hynix' }),
        }),
      );
    });

    it('행은 있는데 canonical_name 이 없으면(사용자 조사 행) 파싱값 그대로', async () => {
      llm.call.mockResolvedValue(
        okResult({ ...OK_JSON, companyName: 'SK hynix' }),
      );
      researchRepo.findOne.mockResolvedValue({ id: 'r1', canonicalName: null });
      await parse();
      expect(createdDraft()?.companyName).toBe('SK hynix');
    });

    it('조사해 둔 회사가 아니면 파싱값 그대로 (새 회사)', async () => {
      llm.call.mockResolvedValue(
        okResult({ ...OK_JSON, companyName: '동네빵집' }),
      );
      await parse();
      expect(createdDraft()?.companyName).toBe('동네빵집');
    });

    it('🔴 조회가 실패해도 카드는 만든다 — 정규화만 포기', async () => {
      llm.call.mockResolvedValue(
        okResult({ ...OK_JSON, companyName: 'SK hynix' }),
      );
      researchRepo.findOne.mockRejectedValue(new Error('db down'));
      const r = await parse();
      expect('card' in r).toBe(true);
      expect(createdDraft()?.companyName).toBe('SK hynix');
    });

    it('회사명이 없으면 조회하지 않는다 (needs company 흐름 그대로)', async () => {
      llm.call.mockResolvedValue(okResult({ ...OK_JSON, companyName: null }));
      await parse();
      expect(researchRepo.findOne).not.toHaveBeenCalled();
    });
  });

  const parse = (over: { rawText?: string; jobContext?: string } = {}) =>
    service.parseAndCreate(USER, { rawText: RAW, ...over });

  // ── 정상 ──────────────────────────────────────────────────────────────

  describe('정상', () => {
    it('카드를 만들어 봉투에 담아 돌려준다', async () => {
      const res = await parse();
      expect(res).toEqual({ card: card() });
      expect(apps.createFromDraft).toHaveBeenCalledTimes(1);
    });

    it('🔴 feature 키·resourceType·strict schema 가 계약대로다', async () => {
      await parse();
      const arg = llm.call.mock.calls[0][0];
      expect(arg.feature).toBe('jobposting_card');
      expect(arg.resourceType).toBe('user');
      expect(arg.resourceId).toBe(USER);
      expect(arg.jsonSchema?.name).toBe('jobposting_card');
    });

    it('오늘 날짜(KST)를 system 에 주입한다 — 모듈 로드 시각에 굳지 않는다', async () => {
      await parse();
      expect(llm.call.mock.calls[0][0].systemPrompt).toContain(todayKst());
    });

    it('🔴 사용자 입력은 user 역할·코드블록으로만 간다 (system 에 절대 안 섞인다)', async () => {
      await parse();
      const { systemPrompt, userPrompt } = llm.call.mock.calls[0][0];
      expect(systemPrompt).not.toContain(RAW);
      expect(userPrompt).toContain('```');
      expect(userPrompt).toContain(RAW);
    });

    it('직무 컨텍스트가 있으면 2차 파싱으로 보고 callCount 2 로 기록한다', async () => {
      await parse({ jobContext: '백엔드 개발자' });
      expect(llm.call.mock.calls[0][0].userPrompt).toContain('# 지원 직무');
      expect(apps.createFromDraft.mock.calls[0][2]).toMatchObject({
        callCount: 2,
      });
    });

    it('원문 sha256 을 카드에 남긴다 (원문 자체는 아니다)', async () => {
      await parse();
      const opts = apps.createFromDraft.mock.calls[0][2];
      expect(opts.textHash).toBe(sha256(RAW));
      expect(JSON.stringify(opts)).not.toContain('백엔드 개발자 채용');
    });

    it('프로필 희망 직무를 매칭 재료로 읽는다 (고르는 기준일 뿐)', async () => {
      userRepo.findOne.mockResolvedValue({ signupJobTitle: '개발자' });
      await parse();
      expect(userRepo.findOne).toHaveBeenCalled();
    });
  });

  // ── 차단 ──────────────────────────────────────────────────────────────

  describe('차단 봉투 — generic ERROR 로 뭉개지 않는다', () => {
    it('quota 차단이면 provider 를 안 부르고 preBlocked audit 행만 남긴다', async () => {
      quota.checkAndPrepare.mockResolvedValue({
        blocked: true,
        code: 'DAY_LIMIT',
        reason: '오늘 한도를 다 썼어요.',
      });
      const res = await parse();
      expect(res).toEqual({
        blocked: true,
        code: 'QUOTA_EXCEEDED',
        reason: '오늘 한도를 다 썼어요.',
      });
      expect(apps.createFromDraft).not.toHaveBeenCalled();
      // audit 은 남는다 — 「막혔다」도 admin 이 봐야 한다
      expect(llm.call).toHaveBeenCalledTimes(1);
      expect(llm.call.mock.calls[0][0].preBlockedStatus).toBe('blocked_quota');
      expect(llm.call.mock.calls[0][0].systemPrompt).toBe('');
    });

    it('동의 미완은 전용 코드로 — 「실패했어요」는 해결할 수 있는 길을 막다른 길로 보이게 한다', async () => {
      llm.call.mockResolvedValue({
        status: 'blocked_consent',
        text: null,
        errorMessage: 'consent',
        callLogId: 'l',
      });
      expect(await parse()).toMatchObject({ code: 'CONSENT_REQUIRED' });
    });

    it('제공사 장애는 전용 문구로 (우리 버그와 구분)', async () => {
      llm.call.mockResolvedValue({
        status: 'error',
        text: null,
        errorMessage: '503',
        callLogId: 'l',
        errorKind: 'provider_outage',
      });
      expect(await parse()).toEqual({
        blocked: true,
        code: 'ERROR',
        reason: PROVIDER_OUTAGE_USER_MESSAGE,
      });
    });

    it('🔴 provider 원문 에러는 사용자에게 노출하지 않는다 (조직 ID·빌링 상태가 섞인다)', async () => {
      llm.call.mockResolvedValue({
        status: 'error',
        text: null,
        errorMessage: 'org-abc123 billing hard limit reached',
        callLogId: 'l',
        errorKind: 'internal',
      });
      const res = await parse();
      expect(res).toMatchObject({ code: 'ERROR' });
      expect(JSON.stringify(res)).not.toContain('org-abc123');
    });
  });

  // ── notPosting ────────────────────────────────────────────────────────

  it('공고가 아니면 카드를 만들지 않는다', async () => {
    llm.call.mockResolvedValue(okResult({ ...OK_JSON, notPosting: true }));
    expect(await parse()).toEqual({ notPosting: true });
    expect(apps.createFromDraft).not.toHaveBeenCalled();
  });

  it('출력이 통째로 깨져 있어도(json undefined) 죽지 않는다', async () => {
    // 🔴 `LlmCallOk.json` 은 `json?: unknown` — status='ok' 여도 없을 수 있다 (ADR-058).
    //    기본값이 끼어들지 않도록 봉투를 직접 만든다.
    const rest = { ...okResult() };
    delete (rest as { json?: unknown }).json;
    llm.call.mockResolvedValue(rest);
    const res = await parse();
    // 회사명이 없으니 보완 질문으로 간다 — 크래시가 아니라 「물어본다」가 정답
    expect(res).toMatchObject({ needs: 'company' });
  });

  // ── 보완 질문 ─────────────────────────────────────────────────────────

  describe('보완 질문', () => {
    it('회사명이 없으면 needs:company + 초안을 **서버가** 들고 있는다', async () => {
      llm.call.mockResolvedValue(okResult({ ...OK_JSON, companyName: null }));
      const res = await parse();
      expect(res).toMatchObject({ needs: 'company', hash: sha256(RAW) });
      expect(apps.createFromDraft).not.toHaveBeenCalled();
      expect(await store.getDraft(USER, sha256(RAW))).not.toBeNull();
    });

    it('🔴 봉투에 초안 본문이 실리지 않는다 (조작 구멍)', async () => {
      llm.call.mockResolvedValue(okResult({ ...OK_JSON, companyName: null }));
      const res = await parse();
      expect(res).not.toHaveProperty('draft');
      expect(Object.keys(res).sort()).toEqual(
        ['candidates', 'companyName', 'hash', 'nearProfile', 'needs'].sort(),
      );
    });

    it('직무가 여럿이면 needs:job + 공고 표기 그대로의 후보', async () => {
      llm.call.mockResolvedValue(
        okResult({
          ...OK_JSON,
          jobTitles: ['사무영업(일반)', '사무영업(IT)', '차량(기계)'],
        }),
      );
      const res = await parse();
      expect(res).toMatchObject({
        needs: 'job',
        candidates: ['사무영업(일반)', '사무영업(IT)', '차량(기계)'],
      });
    });

    it('회사명이 먼저다 — 둘 다 없으면 회사명을 묻는다 (company_name 은 NOT NULL)', async () => {
      llm.call.mockResolvedValue(
        okResult({ ...OK_JSON, companyName: null, jobTitles: ['A', 'B'] }),
      );
      expect(await parse()).toMatchObject({ needs: 'company' });
    });
  });

  // ── 중복·동시 ─────────────────────────────────────────────────────────

  describe('중복 방지 — 새로고침 한 번에 카드가 두 장 되지 않는다', () => {
    it('같은 원문 두 번이면 카드는 한 장, 두 번째는 기존 카드를 돌려준다', async () => {
      await parse();
      llm.call.mockClear();
      const second = await parse();
      expect(second).toEqual({ card: card() });
      expect(llm.call).not.toHaveBeenCalled(); // LLM 도 안 부른다 (돈이 안 나간다)
      expect(apps.createFromDraft).toHaveBeenCalledTimes(1);
    });

    it('되돌리기로 카드를 지웠으면 다시 만든다', async () => {
      await parse();
      appRepo.findOne.mockResolvedValue(null); // soft delete 된 상태
      apps.createFromDraft.mockResolvedValue(card('card-2'));
      expect(await parse()).toEqual({ card: card('card-2') });
      expect(apps.createFromDraft).toHaveBeenCalledTimes(2);
    });

    it('다른 원문이면 각각 만든다', async () => {
      await parse();
      apps.createFromDraft.mockResolvedValue(card('card-2'));
      await parse({
        rawText: `${RAW}\n추가 문단입니다. 근무지는 성수동입니다.`,
      });
      expect(apps.createFromDraft).toHaveBeenCalledTimes(2);
    });
  });

  describe('진행 중 3장 상한', () => {
    it('4번째는 LLM 을 부르기 전에 막는다 (돈 나가는 자리 앞에서)', async () => {
      for (let i = 0; i < 3; i++) await store.acquireSlot(USER);
      llm.call.mockClear();
      expect(await parse()).toEqual({
        blocked: true,
        code: 'TOO_MANY_PENDING',
        reason: '먼저 만든 카드가 끝나면 이어서 만들어 드릴게요.',
      });
      expect(llm.call).not.toHaveBeenCalled();
    });

    it('끝나면 슬롯을 반납한다 (성공·실패 무관)', async () => {
      await parse();
      llm.call.mockRejectedValueOnce(new Error('boom'));
      await expect(
        parse({ rawText: `${RAW} 다른 공고입니다 (성수동).` }),
      ).rejects.toThrow();
      // 3장을 새로 잡을 수 있으면 앞의 두 요청이 자리를 안 물고 있다는 뜻
      expect(await store.acquireSlot(USER)).toBe(0);
      expect(await store.acquireSlot(USER)).toBe(1);
      expect(await store.acquireSlot(USER)).toBe(2);
    });
  });

  // ── commit ────────────────────────────────────────────────────────────

  describe('commitDraft — LLM 을 부르지 않는다', () => {
    const HASH = sha256(RAW);

    const seedCompanyNeed = async () => {
      llm.call.mockResolvedValue(okResult({ ...OK_JSON, companyName: null }));
      await parse();
      llm.call.mockClear();
    };

    it('회사명을 받으면 그대로 카드를 만든다 (차감 0)', async () => {
      await seedCompanyNeed();
      const res = await service.commitDraft(USER, {
        hash: HASH,
        companyName: '(주)비공개상사',
      });
      expect(res).toEqual({ card: card() });
      expect(llm.call).not.toHaveBeenCalled();
      const draft = apps.createFromDraft.mock.calls[0][1];
      expect(draft.companyName).toBe('비공개상사'); // (주) 제거
      expect(draft.companySource).toBe('typed');
    });

    it('만든 뒤 초안을 지운다 (pending 목록에서 사라진다)', async () => {
      await seedCompanyNeed();
      await service.commitDraft(USER, {
        hash: HASH,
        companyName: '비공개상사',
      });
      expect(await service.listPending(USER)).toEqual({ drafts: [] });
    });

    it('직무를 고르면 후보에서 확정한다 (공고 표기 그대로)', async () => {
      llm.call.mockResolvedValue(
        okResult({ ...OK_JSON, jobTitles: ['사무영업(일반)', '사무영업(IT)'] }),
      );
      await parse();
      const res = await service.commitDraft(USER, {
        hash: HASH,
        jobContext: '사무영업(IT)',
      });
      expect(res).toEqual({ card: card() });
      expect(apps.createFromDraft.mock.calls[0][1]).toMatchObject({
        jobTitle: '사무영업(IT)',
        jobPicked: 'chosen',
      });
    });

    it('회사명을 넣었는데 직무가 아직 여럿이면 다시 묻는다', async () => {
      llm.call.mockResolvedValue(
        okResult({
          ...OK_JSON,
          companyName: null,
          jobTitles: ['A직무', 'B직무'],
        }),
      );
      await parse();
      const res = await service.commitDraft(USER, {
        hash: HASH,
        companyName: '비공개상사',
      });
      expect(res).toMatchObject({
        needs: 'job',
        candidates: ['A직무', 'B직무'],
      });
      expect(apps.createFromDraft).not.toHaveBeenCalled();
    });

    it('없는 hash 는 404 — 「다시 붙여넣어 주세요」', async () => {
      await expect(
        service.commitDraft(USER, { hash: 'f'.repeat(64) }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('🔴 타인의 hash 로는 404 (키가 userId 를 포함한다)', async () => {
      await seedCompanyNeed();
      await expect(
        service.commitDraft(OTHER, { hash: HASH, companyName: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── pending ───────────────────────────────────────────────────────────

  describe('listPending — 새로고침 복원', () => {
    it('🔴 `{drafts: []}` 봉투에 **요약만** 담는다 (프론트 계약)', async () => {
      llm.call.mockResolvedValue(okResult({ ...OK_JSON, companyName: null }));
      await parse();

      const { drafts } = await service.listPending(USER);
      expect(drafts).toHaveLength(1);
      // 키 집합을 못 박는다 — 초안 본문이 새면 여기서 걸린다
      expect(Object.keys(drafts[0]).sort()).toEqual([
        'candidates',
        'companyName',
        'createdAt',
        'hash',
        'jobTitle',
        'needs',
      ]);
      expect(drafts[0]).toMatchObject({
        needs: 'company',
        hash: sha256(RAW),
        companyName: null,
        jobTitle: '백엔드 개발자',
        candidates: [],
      });
      expect(drafts[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('needs:job 이면 고를 후보가 실려 온다', async () => {
      llm.call.mockResolvedValue(
        okResult({ ...OK_JSON, jobTitles: ['A직무', 'B직무'] }),
      );
      await parse();
      const { drafts } = await service.listPending(USER);
      expect(drafts[0]).toMatchObject({
        needs: 'job',
        candidates: ['A직무', 'B직무'],
      });
    });

    it('본인 것만 나온다', async () => {
      llm.call.mockResolvedValue(okResult({ ...OK_JSON, companyName: null }));
      await parse();
      expect(await service.listPending(OTHER)).toEqual({ drafts: [] });
    });

    it('카드가 바로 만들어졌으면 대기 목록은 비어 있다', async () => {
      await parse();
      expect(await service.listPending(USER)).toEqual({ drafts: [] });
    });
  });

  // ── 원문 비보관 ───────────────────────────────────────────────────────

  it('🔴 원문이 응답·초안·생성 인자 어디에도 없다', async () => {
    llm.call.mockResolvedValue(okResult({ ...OK_JSON, companyName: null }));
    const res = await parse();
    expect(JSON.stringify(res)).not.toContain('Node.js 3년');

    const pending = await store.getDraft(USER, sha256(RAW));
    expect(JSON.stringify(pending)).not.toContain('접수 마감 2026-09-15');

    await service.commitDraft(USER, {
      hash: sha256(RAW),
      companyName: '무신사',
    });
    const passed = JSON.stringify(apps.createFromDraft.mock.calls[0]);
    expect(passed).not.toContain('[무신사] 백엔드 개발자 채용');
  });
});
