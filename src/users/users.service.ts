import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { User } from './user.entity';
import { UserDeletionLog } from './user-deletion-log.entity';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import {
  APPLICATION_TEMPLATE_IDS,
  stepsForTemplate,
  templateForSeries,
} from '../applications/application-templates';
import { UpdateDashboardConfigDto } from './dto/update-dashboard-config.dto';
import { SignupAnswerDto } from './dto/signup-answer.dto';
import { UpdateJobProfileDto } from './dto/update-job-profile.dto';
import { TourProgressDto } from './dto/tour-progress.dto';
import { pickSampleCompanies } from './signup-job-categories.const';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { FilesService } from '../files/files.service';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { CURRENT_AI_CONSENT_VERSION } from '../ai/llm.service';
import { IdentityProviderService } from '../auth/identity-provider.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private repo: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storageUsage: StorageUsageService,
    private readonly filesService: FilesService,
    private readonly identityProvider: IdentityProviderService,
    private readonly discord: DiscordNotifier,
    @InjectRepository(UserDeletionLog)
    private readonly deletionLogRepo: Repository<UserDeletionLog>,
  ) {}

  async agreeTerms(userId: string): Promise<void> {
    await this.repo.update(userId, { termsAgreedAt: new Date() });
  }

  /**
   * AI 사용 동의 — PIPA 26조 (제3자 처리 위탁 별도 동의).
   * client 가 보낸 version 이 서버 CURRENT_AI_CONSENT_VERSION 과 일치해야 저장.
   * 재호출 멱등 — timestamp 갱신.
   */
  async agreeAiConsent(userId: string, version: string): Promise<void> {
    if (version !== CURRENT_AI_CONSENT_VERSION) {
      throw new BadRequestException(
        `약관 version 불일치. 페이지를 새로고침 해주세요. (서버: ${CURRENT_AI_CONSENT_VERSION})`,
      );
    }
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    await this.repo.update(userId, {
      aiConsentAt: new Date(),
      aiConsentVersion: version,
    });
  }

  /**
   * AI 사용 동의 철회 — PIPA 26조 (동의/철회 동등 보장).
   * 철회 후 모든 AI 호출은 LlmService.checkConsent 에서 blocked_consent 로 차단.
   * 멱등 — 이미 철회된 user 재호출 OK.
   */
  async withdrawAiConsent(userId: string): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    await this.repo.update(userId, {
      aiConsentAt: null,
      aiConsentVersion: null,
    });
  }

  async markOnboarded(userId: string): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    if (!user.onboardedAt) {
      await this.repo.update(userId, { onboardedAt: new Date() });
    }
  }

  /**
   * signup 1 질문 답변 저장 — **두 경로가 한 메서드를 쓴다**.
   *
   * | 경로 | 판별 | 만들어지는 카드 |
   * |---|---|---|
   * | 신 — 계열 1탭 | `seriesId` 있음 | 사용자가 **고른 진짜 회사**의 지원 예정(PLANNED) 카드 |
   * | 구 — 21직군 칩 | `seriesId` 없음 | 가상 회사 샘플 카드 (`is_sample = true`) |
   *
   * 🔴 **`seriesId` 가 있으면 가상 샘플을 만들지 않는다.** 진짜 회사 카드와 `Sample Corp`
   * 카드가 같이 깔리면 보드가 무엇이 진짜인지 알려주지 못한다 — 2단 보상이 샘플을 **대체**한다.
   *
   * 🔴 **새 경로도 `signup_job_categories` 에 `[]` 를 반드시 기록한다.** 「이미 답변했나」
   * 판정이 그 컬럼의 NULL 여부 하나에 걸려 있어서, 안 쓰면 새 사용자가 온보딩을 몇 번이고
   * 다시 보게 된다 (그리고 그때마다 카드가 또 생긴다).
   *
   * - 건너뛰기(`jobCategories` 미전송·`[]` · `seriesId` 없음) → 카드 0개. onboardedAt = NOW
   * - "기타" 미선택 + otherText 있음 → 400 (불일치)
   * - `seriesId` 없이 `pickedCompanies` 만 → 400 (회사 목록은 계열에서 파생된다)
   * - 이미 답변한 user 재호출 → 400 (멱등 X, 명시적 에러)
   * - 트랜잭션 — users update + applications insert 둘 다 같은 TX
   *
   * 🔴 「이미 답변했나」는 **사전 조회가 아니라 UPDATE 한 방**으로 가른다 (`claimSignupAnswer`).
   */
  async signupAnswer(userId: string, dto: SignupAnswerDto): Promise<void> {
    /* 존재 확인과 `onboardedAt` 을 읽으려고 한 번은 조회한다 — 「없는 사용자」는 400 이 아니라
       404 여야 하고, 첫 온보딩 시각은 재기록하지 않기 때문이다.
       🔴 다만 「이미 답변했나」 판정은 **여기서 하지 않는다** (아래 claim 이 원자적으로 한다). */
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    // 새 경로는 직군 칩을 안 보낸다 — 미전송을 「건너뛰기와 같은 []」로 읽는다
    const jobCategories = dto.jobCategories ?? [];
    const otherText = dto.otherText?.trim() ?? '';
    const hasOther = otherText.length > 0;
    const includesOther = jobCategories.includes('기타');

    if (hasOther && !includesOther) {
      throw new BadRequestException('기타 직군과 함께만 사용할 수 있습니다.');
    }

    const seriesId = dto.seriesId ?? null;
    const jobTitle = dto.jobTitle?.trim() || null;
    const pickedCompanies = normalizePickedCompanies(dto.pickedCompanies);

    if (!seriesId && pickedCompanies.length > 0) {
      throw new BadRequestException('계열 없이 회사만 담을 수 없어요.');
    }

    if (seriesId) {
      await this.saveSeriesAnswer(userId, user.onboardedAt, {
        jobCategories,
        seriesId,
        jobTitle,
        pickedCompanies,
        templateId: dto.templateId ?? null,
      });
      return;
    }

    await this.dataSource.transaction(async (em) => {
      await this.claimSignupAnswer(em, userId, {
        signupJobCategories: jobCategories,
        signupOtherText: hasOther ? otherText : null,
        onboardedAt: user.onboardedAt ?? new Date(),
      });

      if (jobCategories.length === 0) return;

      const picked = pickSampleCompanies(
        jobCategories,
        hasOther ? otherText : undefined,
      );

      // 카드별 deadline 분산 (+7/+14/+21일) + currentStepIndex 분산 (0/1/2)
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (let i = 0; i < picked.length; i++) {
        const { companyName, jobCategory } = picked[i];
        const deadline = new Date(today);
        deadline.setDate(deadline.getDate() + (i + 1) * 7);

        const app = em.create(Application, {
          userId,
          companyName,
          jobCategory,
          status: 'IN_PROGRESS',
          isSample: true,
          currentStepIndex: i, // 0, 1, 2
          needsDetail: false,
          // 관측 전용 — 아래 stepsForTemplate('general') 과 **같은 값**이어야 한다.
          // 샘플 카드를 빼고 세는 집계가 대부분이지만, 기록을 비워두면 나중에
          // "NULL 이 도입 이전 카드인가 샘플인가" 를 못 가른다.
          templateId: 'general',
          createdVia: 'onboarding_sample',
        });
        const saved = await em.save(Application, app);

        // 기본 4 step (general template)
        const steps = stepsForTemplate('general');
        for (let s = 0; s < steps.length; s++) {
          const step = em.create(ApplicationStep, {
            applicationId: saved.id,
            orderIndex: s,
            name: steps[s],
            scheduledDate: s === 0 ? deadline : null,
          });
          await em.save(ApplicationStep, step);
        }
      }
    });
  }

  /**
   * 온보딩 답변 **선점** — 「이미 답변했나」를 UPDATE 한 방으로 가른다.
   *
   * ## 왜 사전 조회가 아니라 이것인가
   *
   * 예전엔 `findOneBy` 로 읽어 보고 `signup_job_categories` 가 null 이면 진행했다. 읽기와
   * 쓰기 사이가 비어 있어서, 같은 사용자의 요청 두 개가 **둘 다 null 을 보고** 통과할 수
   * 있었다 (더블 탭·재시도·모바일 웹뷰의 중복 전송). 그러면 답변은 한 번인데 **온보딩 카드가
   * 두 벌** 생긴다 — 보드에 같은 회사가 두 장씩 깔린 채로 첫 화면을 만난다.
   *
   * ```sql
   * UPDATE users SET … WHERE id = $1 AND signup_job_categories IS NULL
   * ```
   *
   * 조건이 SQL 안에 있으므로 두 번째 요청은 첫 요청의 커밋을 기다렸다가 **0행**을 받는다
   * (READ COMMITTED 에서 UPDATE 는 잠긴 행을 다시 평가한다). 0행 = 이미 답변 = 400 이고,
   * 🔴 **카드를 만들기 전에** 던져야 같은 트랜잭션이 통째로 롤백된다.
   *
   * 「사용자 없음」은 여기서 400 이 되지 않는다 — 호출부가 먼저 404 로 걸러 낸다.
   */
  private async claimSignupAnswer(
    em: EntityManager,
    userId: string,
    columns: QueryDeepPartialEntity<User>,
  ): Promise<void> {
    const result = await em.update(
      User,
      { id: userId, signupJobCategories: IsNull() },
      columns,
    );
    if (!result.affected) {
      throw new BadRequestException('이미 답변하셨어요.');
    }
  }

  /**
   * 신 경로 — 계열 1탭 + 2단 보상에서 고른 회사 → **지원 예정(PLANNED) 카드**.
   *
   * ## 왜 PLANNED 인가
   *
   * 사용자는 아직 지원하지 않았다. 「조사가 준비된 회사」를 담아둔 것뿐이라 `IN_PROGRESS`
   * 로 만들면 가입 첫날 진행 중 카드 3장이 생겨 보드가 거짓말을 한다. PLANNED 는
   * 「일단 적어두기」 자리이고, 지원을 시작할 때 `StartApplicationModal` 이 나머지를 받는다.
   *
   * ## 마감일이 없다
   *
   * 우리는 이 회사들의 공고 마감을 모른다. 샘플 카드처럼 +7/+14/+21 을 지어내면 D-day·
   * 캘린더·알림이 전부 **없는 마감**을 기준으로 돈다. 스텝은 만들되 `scheduledDate` 는 전부 null.
   *
   * ## 🔴 `jobCategory` 를 채우지 않는다
   *
   * 계열 라벨(「의료·보건·복지」)을 직군 칸에 박으면 시스템 말이 저장으로 승격된다 —
   * 화면에서 직무가 비었을 때 계열을 **표시**하는 fallback 이 그 역할을 맡는다(연필).
   * 반대로 `jobTitle` 은 사람이 친 말이라 그대로 저장하고 출처를 `prefill` 로 남긴다.
   *
   * ## 템플릿은 프론트 판정을 **우선**한다
   *
   * 🔴 서버는 계열까지만 안다. 「승무원」처럼 **세밀 그룹 오버라이드**가 걸리는 직무는
   * 프론트가 사전으로 판정해 보내 주지 않으면, 사용자가 방금 본 미리보기(항공 서비스)와
   * 실제로 담긴 카드(영업·판매 계열)가 어긋난다. 그래서 아는 id 면 받고, 없거나 모르는
   * id 면 계열 폴백으로 간다 — **검증은 두 겹**이다 (DTO `IsIn` + 여기 존재 확인).
   */
  private async saveSeriesAnswer(
    userId: string,
    existingOnboardedAt: Date | null,
    answer: {
      jobCategories: string[];
      seriesId: string;
      jobTitle: string | null;
      pickedCompanies: string[];
      /** 프론트가 직무 사전으로 확정한 템플릿 — 모르는 값이면 무시하고 계열로 간다 */
      templateId: string | null;
    },
  ): Promise<void> {
    const { jobCategories, seriesId, jobTitle, pickedCompanies } = answer;
    const templateId =
      answer.templateId && isKnownTemplate(answer.templateId)
        ? answer.templateId
        : templateForSeries(seriesId);
    const steps = stepsForTemplate(templateId);

    await this.dataSource.transaction(async (em) => {
      await this.claimSignupAnswer(em, userId, {
        // 🔴 새 경로도 반드시 기록한다 — 「이미 답변했나」 판정이 이 컬럼 하나에 걸려 있다
        signupJobCategories: jobCategories,
        signupOtherText: null,
        signupSeriesId: seriesId,
        signupJobTitle: jobTitle,
        onboardedAt: existingOnboardedAt ?? new Date(),
      });

      for (const companyName of pickedCompanies) {
        const app = em.create(Application, {
          userId,
          companyName,
          jobTitle,
          // 관측 전용 — 프리필로 나갈 값이라 「사람이 친 말」임을 남긴다
          jobTitleSource: jobTitle ? 'prefill' : null,
          jobCategory: null,
          status: 'PLANNED',
          isSample: false,
          currentStepIndex: 0,
          needsDetail: false,
          templateId,
          createdVia: 'onboarding_pick',
        });
        const saved = await em.save(Application, app);

        for (let s = 0; s < steps.length; s++) {
          const step = em.create(ApplicationStep, {
            applicationId: saved.id,
            orderIndex: s,
            name: steps[s],
            // 우리는 이 공고의 마감을 모른다 — 지어내지 않는다
            scheduledDate: null,
          });
          await em.save(ApplicationStep, step);
        }
      }
    });
  }

  /**
   * W1 — "전체 숨기기": 모든 sample 카드 soft delete + sample_cards_dismissed_at = NOW.
   * 멱등 (이미 dismiss 됨 → no-op 200).
   */
  async dismissAllSampleCards(userId: string): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    if (user.sampleCardsDismissedAt) return; // 멱등

    await this.dataSource.transaction(async (em) => {
      await em.update(User, userId, { sampleCardsDismissedAt: new Date() });
      await em
        .createQueryBuilder()
        .update(Application)
        .set({ deletedAt: new Date() })
        .where('user_id = :userId', { userId })
        .andWhere('is_sample = true')
        .andWhere('deleted_at IS NULL')
        .execute();
    });
  }

  /**
   * 캘린더 UX 재구성 — 안내 배너 dismiss (멱등).
   * 배너 = "이제 캘린더가 홈이에요. 회고는 대시보드에서 볼 수 있어요."
   * 첫 방문 시 노출 · dismiss timestamp 저장 후 재노출 X.
   */
  async dismissCalendarHomeIntro(userId: string): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    if (user.calendarHomeIntroDismissedAt) return; // 멱등
    await this.repo.update(userId, {
      calendarHomeIntroDismissedAt: new Date(),
    });
  }

  /**
   * 앱 소개 투어 진행 기록 (`plans/app-tour.md`) — 투어가 **끝나는 순간 한 번**만 온다.
   *
   * | 컬럼 | 규칙 | 왜 |
   * |---|---|---|
   * | `tourSeenAt` | **첫 기록만 유지** (있으면 안 건드린다) | 「언제 처음 만났나」가 코호트 기준이다. 덮어쓰면 사라진다 |
   * | `tourLastStep` | **최신값으로 갱신** | 알고 싶은 건 「마지막으로 어디까지 갔나」다 |
   * | `tourCompletedAt` | 처음 완료한 시각만 | 두 번째 완료가 첫 완료를 지우면 깔때기가 뒤로 간다 |
   *
   * 멱등 — 다시 호출하면 `lastStep` 만 최신으로 바뀐다. 마지막 승(단일 UPDATE)이라
   * 동시 요청도 안전하고, 값 3개가 한 행이라 트랜잭션이 필요 없다.
   *
   * 🔴 **다시 보기(`?replay=1`)는 프론트가 이걸 부르지 않는다** — 서버에 분기가 없는 이유다.
   * 재생일 뿐인데 이탈 장면 분포를 오염시키면 관측이 거짓말을 한다.
   */
  async recordTour(userId: string, dto: TourProgressDto): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    const now = new Date();
    await this.repo.update(userId, {
      tourSeenAt: user.tourSeenAt ?? now,
      tourLastStep: dto.lastStep,
      ...(dto.completed
        ? { tourCompletedAt: user.tourCompletedAt ?? now }
        : {}),
    });
  }

  /**
   * 면접 유도 모달 「이 안내 다시 보지 않기」 — **전 카드 영구 차단**.
   *
   * 🔴 클라이언트가 **실패를 그냥 넘기면 안 되는** 유일한 dismiss 다.
   * 스텝 단위 노출 기록(`interview_nudge_shown_at`)은 실패해도 "한 번 더 뜨는" 정도라 안전하지만,
   * 이건 사용자가 **명시적으로 누른 약속**이라 실패 후 또 뜨면 약속 파기가 된다.
   * 그래서 프론트는 재시도 + localStorage 보조 기록으로 한 겹 더 막는다.
   */
  async dismissInterviewNudge(userId: string): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    if (user.interviewNudgeDismissedAt) return; // 멱등
    await this.repo.update(userId, {
      interviewNudgeDismissedAt: new Date(),
    });
  }

  /**
   * 데스크탑 웹 사용 스탬프 — 최초 1회만 기록.
   *
   * 프론트는 `useCoverletterReadOnly() === false` 일 때만 이걸 부른다. 즉 **자소서 게이트와
   * 같은 표현식**이 신호원이라 둘이 어긋날 수 없다. 관측 화면에서 *"모바일이라 못 쓴 것"* 과
   * *"데스크탑에서 안 쓴 것"* 을 가르는 분모가 된다.
   *
   * 🔴 **읽고-쓰지 않고 조건부 UPDATE 한 방으로 처리한다.** 형제 메서드들(`markOnboarded` 등)은
   * `findOneBy` 후 분기하지만, 여기는 **동시 요청이 흔하다** (탭 여러 개를 동시에 열면 각 탭이
   * 발사한다). 읽고-쓰기면 둘 다 NULL 을 보고 둘 다 쓴다. `IS NULL` 을 WHERE 에 넣으면
   * 두 번째는 **0행**이 되어 최초 시각이 보존된다.
   *
   * **best-effort 통계다** — 없는 사용자도 예외를 던지지 않는다 (0행). 이 호출의 실패가
   * 사용자 화면에 영향을 주면 안 된다.
   *
   * ⚠️ 클라이언트가 보내는 신호라 위조할 수 있다. 권한·과금과 무관한 운영 통계이므로
   * 위조 이득이 없어 서버 검증을 두지 않는다.
   */
  async markDesktopWebSeen(userId: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(User)
      .set({ firstDesktopWebSeenAt: () => 'now()' })
      .where('id = :userId', { userId })
      .andWhere('first_desktop_web_seen_at IS NULL')
      .execute();
  }

  /**
   * 희망 직무·계열 변경 — 온보딩 이후 **바꾸는 유일한 경로**.
   *
   * ## 부분 갱신 — 🔴 `{...dto}` 로 merge 하면 안 된다
   *
   * `ValidationPipe(transform: true)` 가 만드는 건 plain object 가 아니라 **DTO 클래스
   * 인스턴스**고, target 이 ES2022+ 라 `useDefineForClassFields` 가 켜져 있다. 즉
   * 선언만 된 필드도 **own `undefined` 프로퍼티로 실재한다** — `'jobTitle' in dto` 는
   * 안 보냈어도 `true` 고, spread 로 합치면 안 보낸 필드가 `undefined` 로 덮여
   * 「직무만 고쳤는데 계열이 지워지는」 사고가 난다. 판정은 **값이 `undefined` 인가**로만 한다.
   *
   * - 미전송(`undefined`) → 그 컬럼은 손대지 않는다
   * - `null` · 빈 문자열 · 공백만 → `null` 저장 (비우기)
   * - 둘 다 미전송 → 400 (프론트의 no-op PATCH 를 조용히 삼키지 않는다)
   * - 사용자 없음 → 404
   *
   * ## 온보딩 미완료 사용자도 허용한다
   *
   * `onboardedAt` 을 보지 않는다 — 온보딩을 **건너뛴 사람이 나중에 채우는 길**이 이
   * 엔드포인트라, 여기서 온보딩 완료를 요구하면 그 사람은 영영 못 채운다.
   * (온보딩 답변 자체를 기록하는 `signupAnswer` 와 역할이 다르다 — 이건 재작성 전용이라
   * 「이미 답변했어요」 같은 1회성 제약도 없다.)
   */
  async updateJobProfile(
    userId: string,
    dto: UpdateJobProfileDto,
  ): Promise<void> {
    const hasTitle = dto.jobTitle !== undefined;
    const hasSeries = dto.seriesId !== undefined;
    if (!hasTitle && !hasSeries) {
      throw new BadRequestException('바꿀 값이 없어요.');
    }

    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    await this.repo.update(userId, {
      ...(hasTitle ? { signupJobTitle: dto.jobTitle?.trim() || null } : {}),
      ...(hasSeries ? { signupSeriesId: dto.seriesId ?? null } : {}),
    });
  }

  async updateNickname(userId: string, nickname: string): Promise<User> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    user.nickname = nickname;
    return this.repo.save(user);
  }

  /**
   * 회원 탈퇴 — Apple Guideline 5.1.1(v) · 카카오 개인정보 처리방침 준수.
   *
   * 순서:
   *   1. 사용자 조회 (없으면 404)
   *   2. R2 파일 URL 수집 (DB 삭제 후엔 조회 불가하므로 사전 캐싱)
   *   3. 프로바이더 unlink / revoke (best-effort · 실패해도 로컬 삭제 진행)
   *      - kakaoId 있음 → Kakao unlink API 호출
   *      - appleSub 있음 → Apple revoke API 호출 (저장된 apple_refresh_token 사용)
   *   4. DB hard delete (CASCADE로 자식 테이블 · llm_call_logs 등 모두 삭제)
   *   5. R2 cascade 정리 (best-effort)
   *
   * 프로바이더 액션이 실패해도 로컬 탈퇴는 진행 = 사용자 관점 확실한 탈퇴 보장.
   * (일시 장애로 탈퇴 자체가 막히면 UX 최악.)
   */
  async deleteAccount(userId: string): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    const fileUrls = await this.storageUsage.collectAllFileUrls(userId);

    if (user.kakaoId) {
      await this.identityProvider.unlinkKakao(user.kakaoId);
    }
    if (user.appleSub) {
      await this.identityProvider.revokeApple(
        user.appleRefreshToken,
        user.appleSub,
      );
    }

    const hadKakao = !!user.kakaoId;
    const hadApple = !!user.appleSub;

    await this.repo.remove(user);

    for (const url of fileUrls) {
      await this.filesService.deleteFile(url);
    }

    const provider =
      [hadKakao && 'kakao', hadApple && 'apple'].filter(Boolean).join('+') ||
      '-';

    // 탈퇴 집계 로그 (best-effort · users hard delete 라 사후 조회 불가)
    void this.deletionLogRepo
      .insert({ provider, source: 'self' })
      .catch(() => undefined);

    void this.discord
      .notify(
        {
          title: '👋 회원 탈퇴',
          color: DISCORD_COLORS.gray,
          fields: [
            { name: '계정', value: provider, inline: true },
            { name: 'userId', value: userId, inline: true },
          ],
        },
        'growth',
      )
      .catch(() => undefined);
  }

  async countAll(): Promise<number> {
    return this.repo.count();
  }

  async countByDate(from: Date): Promise<number> {
    return this.repo
      .createQueryBuilder('u')
      .where('u.created_at >= :from', { from })
      .getCount();
  }

  private readonly DEFAULT_SECTIONS = [
    { id: 'stats', visible: true },
    // 회고=성장 페이지 Phase A — 마일스톤 (항상 표시, sparse 사용자 CTA 역할)
    { id: 'milestones', visible: true },
    // 회고=성장 페이지 Phase A — 월별 활동량 비교
    { id: 'monthly_comparison', visible: true },
    // 회고=성장 페이지 Phase A — 개인 패턴 인사이트
    { id: 'insights', visible: true },
    // W3 — Dashboard streak + status 도넛
    { id: 'activity_streak', visible: true },
    { id: 'status_doughnut', visible: true },
    // 회고=성장 페이지 Phase A — 개인 funnel
    { id: 'personal_funnel', visible: true },
    // 유지: 어제 면접 회고 유도
    { id: 'interview_review', visible: true },
  ];

  /**
   * lazy merge 대상 — 기존 사용자가 config 저장한 후 도입된 섹션.
   * config 있는 사용자에게도 자동 append (visible:true) 해야 자동 노출됨.
   * 이미 toggle off 한 경우 (visible:false 로 저장) 는 그대로 유지.
   */
  private readonly LAZY_MERGE_SECTION_IDS = [
    'activity_streak',
    'status_doughnut',
    'interview_review',
    // 회고=성장 페이지 Phase A — 신규 섹션 (기존 사용자에게도 자동 노출)
    'monthly_comparison',
    'personal_funnel',
    'milestones',
    'insights',
  ];

  /**
   * config 있는 사용자에서 이 id 는 응답 시 자동 필터링.
   * - dday·todos·today_schedule·top_applications·calendar_mini: 캘린더 UX 재구성으로 캘린더로 이관
   * - cover_letter_quick·goals: 회고=성장 재정의로 제거 (실행 도구 → 성장 지표에 집중)
   */
  private readonly DEPRECATED_SECTION_IDS = new Set([
    'dday',
    'todos',
    'today_schedule',
    'top_applications',
    'calendar_mini',
    'cover_letter_quick',
    'goals',
  ]);

  async getDashboardConfig(
    userId: string,
  ): Promise<{ sections: { id: string; visible: boolean }[] }> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    if (!user.dashboardConfig) {
      return { sections: this.DEFAULT_SECTIONS };
    }
    // 캘린더 UX 재구성 — deprecated 섹션 필터링 (dday·todos 등 캘린더로 이관됨)
    const filtered = user.dashboardConfig.sections.filter(
      (s) => !this.DEPRECATED_SECTION_IDS.has(s.id),
    );
    // W3 — lazy merge: 기존 config 에 신규 lazy-merge 섹션만 자동 append
    const existingIds = new Set(filtered.map((s) => s.id));
    const missing = this.DEFAULT_SECTIONS.filter(
      (s) =>
        this.LAZY_MERGE_SECTION_IDS.includes(s.id) && !existingIds.has(s.id),
    );
    if (missing.length === 0) return { sections: filtered };
    return { sections: [...filtered, ...missing] };
  }

  async updateDashboardConfig(
    userId: string,
    dto: UpdateDashboardConfigDto,
  ): Promise<{ sections: { id: string; visible: boolean }[] }> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    if (dto.sections[0]?.id !== 'stats') {
      throw new BadRequestException('stats 섹션은 항상 첫 번째여야 합니다.');
    }

    user.dashboardConfig = { sections: dto.sections };
    const saved = await this.repo.save(user);
    return saved.dashboardConfig!;
  }
}

/** 온보딩 2단 회사 상한 — DTO `@ArrayMaxSize` 와 같은 값 */
const MAX_PICKED_COMPANIES = 6;

/**
 * 아는 템플릿 id 인가 — 🔴 `stepsForTemplate` 으로 대신할 수 없다.
 * 그건 모르는 id 에 `general` 을 **조용히** 돌려줘서 「모르는 값을 받았다」를 못 가른다.
 *
 * 키 목록으로 보는 이유: `APPLICATION_TEMPLATES[id] !== undefined` 는 프로토타입 체인까지
 * 타서 `constructor` 같은 값이 「아는 템플릿」이 된다. DTO 의 `@IsIn` 이 이미 같은 배열로
 * 막고 있어 HTTP 로는 못 오지만, 검증 계층 하나에만 기대지 않는다.
 */
function isKnownTemplate(id: string): boolean {
  return APPLICATION_TEMPLATE_IDS.indexOf(id) !== -1;
}

/**
 * 온보딩 2단에서 고른 회사명 정리 — trim · 빈 값 제거 · 중복 제거 · 상한 6.
 *
 * DTO 는 **형태**(배열인가·문자열인가·길이)만 본다. 「같은 회사를 두 번 담았다」는
 * 형태 위반이 아니라 의미 문제라 여기서 접는다 — 안 접으면 같은 회사 카드가 두 장 생기고,
 * 사용자는 자기가 두 번 눌렀다는 걸 카드가 두 장 생긴 뒤에야 안다.
 *
 * 상한은 DTO 의 `@ArrayMaxSize(6)` 과 **같은 값이지만 여기도 자른다.** DTO 를 우회하는
 * 호출부(서비스 직접 호출·미래 내부 경로)가 생겼을 때 카드 수십 장이 만들어지는 걸
 * 검증 계층 하나에만 맡기지 않는다.
 */
function normalizePickedCompanies(raw?: string[] | null): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name) continue;
    if (out.indexOf(name) !== -1) continue;
    out.push(name);
    if (out.length >= MAX_PICKED_COMPANIES) break;
  }
  return out;
}
