/**
 * 기능 사용 실태 e2e — `GET /admin/feature-usage`.
 *
 * 🔴 **단위 spec 은 SQL 을 아예 안 본다.** `buildFeatureUsage` 는 DB 를 모르는 순수 함수라
 * 「DB 가 준 행을 어떻게 접는가」까지만 지킨다. 정작 조용히 틀리는 쪽은 **행을 뽑는 SQL** 이다:
 *
 *  ① 온보딩 샘플 카드·soft delete 를 안 거르면 사용 인원이 통째로 부풀어난다
 *  ② 시트·체크리스트·자소서·챗은 `step → application → user` 를 **두 단계 조인**해야
 *     사용자에 붙는다. 조인이 틀려도 숫자는 그럴듯하게 나온다
 *  ③ `LENGTH(TRIM(memo))` 가 빈 문자열을 0 으로 만드는지는 진짜 Postgres 만 안다
 *  ④ 내정보 8종 UNION 의 `user_profiles` 조건 — 온보딩이 만든 **빈 프로필 행**이 걸리면
 *     전원이 「내정보를 채웠다」로 잡힌다
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsAdmin, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';
import {
  OpsFeatureUsageService,
  type FeatureKey,
  type FeatureUsageResponse,
} from '../src/admin/ops-feature-usage.service';
import { Application } from '../src/applications/application.entity';
import { ApplicationStep } from '../src/applications/application-step.entity';
import { ApplicationCoverletter } from '../src/applications/application-coverletter.entity';
import { CoverletterChatMessage } from '../src/applications/coverletter-chat-message.entity';
import { StepNoteSheet } from '../src/applications/step-note-sheet.entity';
import { StepChecklistItem } from '../src/applications/step-checklist-item.entity';
import { DailyNote } from '../src/calendar/daily-note.entity';
import { StudyNote } from '../src/study-notes/study-note.entity';
import { Education } from '../src/myinfo/entities/education.entity';
import { UserProfile } from '../src/myinfo/entities/user-profile.entity';

describe('기능 사용 실태 (e2e)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;

  const fetchUsage = async (token: string): Promise<FeatureUsageResponse> => {
    // 5분 캐시가 있어 seed 후 반드시 비운다 — 안 그러면 직전 테스트의 스냅샷을 본다
    app.get(OpsFeatureUsageService).resetCache();
    const res = await request(app.getHttpServer())
      .get('/admin/feature-usage')
      .set(bearer(token))
      .expect(200);
    // 봉투 형태를 계약으로 고정한다 (`res.body.data ?? res.body` 로 쓰면 둘 다 통과한다)
    expect(res.body).toHaveProperty('data');
    return res.body.data as FeatureUsageResponse;
  };

  /**
   * 🔴 **`features[]` 의 값에는 정확한 수를 걸지 않는다.** 이건 전수 집계라 로컬 개발 DB 에
   * 이미 쌓인 남의 행이 같이 섞인다 — 빈 CI DB 에서는 통과하고 로컬에서만 깨지는,
   * 환경에 따라 답이 달라지는 테스트가 된다. 깊이·중앙값 **산술은 단위 spec 이 지키고**,
   * 여기서는 **행이 사용자에 제대로 붙었는가**(`users[]` 매트릭스)만 본다.
   */
  const stat = (body: FeatureUsageResponse, key: FeatureKey) => {
    const f = body.features.find((x) => x.key === key);
    expect(f).toBeDefined();
    return f!;
  };

  const rowOf = (body: FeatureUsageResponse, userId: string) =>
    body.users.find((u) => u.userId === userId);

  const addCard = (
    userId: string,
    over: Partial<Application> = {},
  ): Promise<Application> => {
    const repo = ds.getRepository(Application);
    return repo.save(repo.create({ userId, companyName: '진짜회사', ...over }));
  };

  const addStep = (
    applicationId: string,
    over: Partial<ApplicationStep> = {},
  ) => {
    const repo = ds.getRepository(ApplicationStep);
    return repo.save(
      repo.create({ applicationId, orderIndex: 0, name: '서류', ...over }),
    );
  };

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    await cleanAllTestUsers(app);
  });

  describe('권한', () => {
    it('미인증 → 401', () =>
      request(app.getHttpServer()).get('/admin/feature-usage').expect(401));

    it('일반 유저 → 403', async () => {
      const { accessToken } = await signInAsUser(app);
      await request(app.getHttpServer())
        .get('/admin/feature-usage')
        .set(bearer(accessToken))
        .expect(403);
    });

    it('admin → 200 · 응답 뼈대가 온다', async () => {
      const { accessToken } = await signInAsAdmin(app);
      const body = await fetchUsage(accessToken);

      expect(Array.isArray(body.features)).toBe(true);
      expect(body.features.length).toBeGreaterThanOrEqual(15);
      expect(Array.isArray(body.users)).toBe(true);
      expect(Array.isArray(body.retention)).toBe(true);
      expect(typeof body.generatedAt).toBe('string');
    });
  });

  // 🔴 ①
  it('온보딩 샘플 카드는 카드 사용으로 안 센다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-sample' });
    await addCard(target.user.id, { isSample: true, companyName: '샘플회사' });

    const body = await fetchUsage(admin.accessToken);

    expect(
      rowOf(body, target.user.id)?.perFeature.application_card,
    ).toBeUndefined();
  });

  it('삭제된 카드는 안 센다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-deleted' });
    const card = await addCard(target.user.id);
    await ds.query(`UPDATE applications SET deleted_at = now() WHERE id = $1`, [
      card.id,
    ]);

    const body = await fetchUsage(admin.accessToken);

    expect(
      rowOf(body, target.user.id)?.perFeature.application_card,
    ).toBeUndefined();
  });

  it('실제 카드는 세고, 도달 스텝을 깊이로 쓴다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-card' });
    await addCard(target.user.id, { currentStepIndex: 2 });

    const body = await fetchUsage(admin.accessToken);

    expect(
      rowOf(body, target.user.id)?.perFeature.application_card?.count,
    ).toBe(1);
    expect(stat(body, 'application_card').usersEver).toBeGreaterThanOrEqual(1);
  });

  // 🔴 ② — 두 단계 조인이 틀려도 숫자는 그럴듯하게 나온다
  it('준비 노트 시트·체크리스트는 step → application → user 로 사용자에 붙는다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-sheet' });
    const card = await addCard(target.user.id);
    const step = await addStep(card.id);

    const sheetRepo = ds.getRepository(StepNoteSheet);
    await sheetRepo.save(
      sheetRepo.create({
        stepId: step.id,
        name: '면접 준비',
        content: JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '가'.repeat(30) }],
            },
          ],
        }),
      }),
    );
    const itemRepo = ds.getRepository(StepChecklistItem);
    await itemRepo.save([
      itemRepo.create({
        stepId: step.id,
        content: '자소서 쓰기',
        isDone: true,
      }),
      itemRepo.create({ stepId: step.id, content: '회사 조사', isDone: false }),
    ]);

    const body = await fetchUsage(admin.accessToken);
    const row = rowOf(body, target.user.id);

    expect(row?.perFeature.step_note_sheet?.count).toBe(1);
    expect(row?.perFeature.step_checklist?.count).toBe(2);
    // 깊이 값 자체는 남의 행이 섞이므로 「잴 수 있었나」만 본다 (산술은 단위 spec)
    expect(stat(body, 'step_note_sheet').depthMedian).not.toBeNull();
    expect(stat(body, 'step_checklist').depthMedian).not.toBeNull();
  });

  it('자소서 카드 문항·AI 챗도 카드를 거쳐 사용자에 붙는다 (챗은 내 메시지만)', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-cl' });
    const card = await addCard(target.user.id);

    const clRepo = ds.getRepository(ApplicationCoverletter);
    await clRepo.save(
      clRepo.create({
        applicationId: card.id,
        question: '지원 동기',
        answer: '나'.repeat(200),
      }),
    );
    const chatRepo = ds.getRepository(CoverletterChatMessage);
    await chatRepo.save([
      chatRepo.create({
        applicationId: card.id,
        role: 'user',
        content: '고쳐줘',
      }),
      chatRepo.create({
        applicationId: card.id,
        role: 'assistant',
        content: 'AI 응답은 사용 횟수가 아니다',
      }),
    ]);

    const body = await fetchUsage(admin.accessToken);
    const row = rowOf(body, target.user.id);

    expect(row?.perFeature.coverletter_card?.count).toBe(1);
    expect(row?.perFeature.coverletter_chat?.count).toBe(1); // assistant 는 제외
  });

  // 🔴 ③
  it('빈 문자열 메모는 「채웠다」로 안 센다', async () => {
    const admin = await signInAsAdmin(app);
    const blank = await signInAsUser(app, { kakaoIdSuffix: 'fu-memo-blank' });
    const filled = await signInAsUser(app, { kakaoIdSuffix: 'fu-memo-filled' });
    await addCard(blank.user.id, { memo: '   ' });
    await addCard(filled.user.id, { memo: '분위기 좋았음' });

    const body = await fetchUsage(admin.accessToken);

    expect(rowOf(body, blank.user.id)?.perFeature.company_memo).toBeUndefined();
    expect(rowOf(body, filled.user.id)?.perFeature.company_memo?.count).toBe(1);
  });

  // 🔴 ④
  it('내정보는 실제 항목만 센다 — 빈 프로필 행은 안 센다', async () => {
    const admin = await signInAsAdmin(app);
    const empty = await signInAsUser(app, {
      kakaoIdSuffix: 'fu-profile-empty',
    });
    const filled = await signInAsUser(app, {
      kakaoIdSuffix: 'fu-profile-filled',
    });

    const profileRepo = ds.getRepository(UserProfile);
    await profileRepo.save(profileRepo.create({ user_id: empty.user.id }));
    await profileRepo.save(
      profileRepo.create({ user_id: filled.user.id, name: '홍길동' }),
    );
    const eduRepo = ds.getRepository(Education);
    await eduRepo.save(
      eduRepo.create({ user_id: filled.user.id, school_name: '치뽀대학교' }),
    );

    const body = await fetchUsage(admin.accessToken);

    expect(rowOf(body, empty.user.id)?.perFeature.myinfo).toBeUndefined();
    // 프로필 1 + 학력 1 = 항목 2건 / 2종
    expect(rowOf(body, filled.user.id)?.perFeature.myinfo?.count).toBe(2);
    expect(stat(body, 'myinfo').usersMultiDay).toBeNull();
  });

  it('공부 노트 깊이는 tiptap 본문 글자수다 (DB 왕복 후에도 단위가 안 어긋난다)', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-note' });
    const noteRepo = ds.getRepository(StudyNote);
    await noteRepo.save(
      noteRepo.create({
        userId: target.user.id,
        title: '알고리즘',
        content: JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: '다'.repeat(10) }],
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '라'.repeat(90) }],
            },
          ],
        }),
      }),
    );

    const body = await fetchUsage(admin.accessToken);

    expect(rowOf(body, target.user.id)?.perFeature.study_note?.count).toBe(1);
    // 본문이 DB 를 왕복해도 tiptap 으로 읽혀 글자수가 나온다 (값 자체는 단위 spec 소관)
    expect(stat(body, 'study_note').depthMedian).not.toBeNull();
  });

  it('오늘 할 일 메모는 완료 체크율을 깊이로 쓴다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-daily' });
    const repo = ds.getRepository(DailyNote);
    await repo.save([
      repo.create({
        userId: target.user.id,
        date: '2026-09-01',
        content: '자소서 쓰기',
        isDone: true,
      }),
      repo.create({
        userId: target.user.id,
        date: '2026-09-01',
        content: '코테 풀기',
        isDone: false,
      }),
    ]);

    const body = await fetchUsage(admin.accessToken);

    expect(rowOf(body, target.user.id)?.perFeature.daily_note?.count).toBe(2);
    expect(stat(body, 'daily_note').depthMedian).not.toBeNull();
  });

  it('캘린더 일정은 날짜가 잡힌 스텝만 센다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-schedule' });
    const card = await addCard(target.user.id);
    await addStep(card.id, {
      orderIndex: 0,
      name: '서류',
      scheduledDate: null,
    });
    await addStep(card.id, {
      orderIndex: 1,
      name: '1차 면접',
      scheduledDate: new Date('2026-09-10T09:00:00+09:00'),
      location: '판교',
    });

    const body = await fetchUsage(admin.accessToken);

    expect(
      rowOf(body, target.user.id)?.perFeature.calendar_schedule?.count,
    ).toBe(1);
    // 「일정 날짜」축이라 최근 7일은 잴 수 없다 — 0 이 아니라 null 이어야 한다
    expect(stat(body, 'calendar_schedule').usersLast7d).toBeNull();
  });

  it('admin 계정은 매트릭스에 없고 제외 인원으로 보고된다', async () => {
    const admin = await signInAsAdmin(app, { kakaoIdSuffix: 'fu-admin' });
    await addCard(admin.user.id);

    const body = await fetchUsage(admin.accessToken);

    expect(body.users.some((u) => u.userId === admin.user.id)).toBe(false);
    expect(body.excludedAdmins).toBeGreaterThanOrEqual(1);
  });

  it('응답에 이메일·kakaoId·사용자 콘텐츠가 없다', async () => {
    const admin = await signInAsAdmin(app);
    const target = await signInAsUser(app, {
      kakaoIdSuffix: 'fu-pii',
      email: 'leak@test.com',
    });
    await addCard(target.user.id, { memo: '메모비밀문장' });
    const noteRepo = ds.getRepository(StudyNote);
    await noteRepo.save(
      noteRepo.create({
        userId: target.user.id,
        title: '노트제목비밀',
        content: JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '노트본문비밀' }],
            },
          ],
        }),
      }),
    );

    const body = await fetchUsage(admin.accessToken);
    const json = JSON.stringify(body);

    expect(json).not.toContain('leak@test.com');
    expect(json).not.toContain('kakao');
    expect(json).not.toContain('메모비밀문장');
    expect(json).not.toContain('노트제목비밀');
    expect(json).not.toContain('노트본문비밀');
  });

  it('refresh=1 은 캐시를 건너뛴다', async () => {
    const admin = await signInAsAdmin(app);
    await fetchUsage(admin.accessToken);

    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-refresh' });
    await addCard(target.user.id);

    // 캐시를 안 비우고 그대로 조회 → 새 사용자가 안 보인다
    const cached = await request(app.getHttpServer())
      .get('/admin/feature-usage')
      .set(bearer(admin.accessToken))
      .expect(200);
    expect(
      (cached.body.data as FeatureUsageResponse).users.some(
        (u) => u.userId === target.user.id,
      ),
    ).toBe(false);

    const fresh = await request(app.getHttpServer())
      .get('/admin/feature-usage?refresh=1')
      .set(bearer(admin.accessToken))
      .expect(200);
    expect(
      (fresh.body.data as FeatureUsageResponse).users.some(
        (u) => u.userId === target.user.id,
      ),
    ).toBe(true);
  });

  it('refresh=0 은 캐시를 뚫지 않는다 (끄려고 넣은 값이 켜는 값이 되면 안 된다)', async () => {
    const admin = await signInAsAdmin(app);
    await fetchUsage(admin.accessToken);

    const target = await signInAsUser(app, { kakaoIdSuffix: 'fu-refresh0' });
    await addCard(target.user.id);

    const res = await request(app.getHttpServer())
      .get('/admin/feature-usage?refresh=0')
      .set(bearer(admin.accessToken))
      .expect(200);

    expect(
      (res.body.data as FeatureUsageResponse).users.some(
        (u) => u.userId === target.user.id,
      ),
    ).toBe(false);
  });
});
