import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from './user.entity';
import { UserDeletionLog } from './user-deletion-log.entity';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { stepsForTemplate } from '../applications/application-templates';
import { UpdateDashboardConfigDto } from './dto/update-dashboard-config.dto';
import { SignupAnswerDto } from './dto/signup-answer.dto';
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
   * W1 — signup 1 질문 (관심 직군) 답변 저장 + 가상 회사 샘플 카드 자동 생성.
   *
   * - jobCategories=[] (건너뛰기) → 빈 array 저장 + 샘플 0개. onboardedAt = NOW
   * - jobCategories=[…] + (otherText 옵션) → 첫 3 직군 매칭 샘플 카드 생성. onboardedAt = NOW
   * - "기타" 미선택 + otherText 있음 → 400 (불일치)
   * - 이미 답변한 user 재호출 → 400 (멱등 X, 명시적 에러)
   * - 트랜잭션 — users update + applications insert 둘 다 같은 TX
   */
  async signupAnswer(userId: string, dto: SignupAnswerDto): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    if (user.signupJobCategories !== null) {
      throw new BadRequestException('이미 답변하셨어요.');
    }

    const otherText = dto.otherText?.trim() ?? '';
    const hasOther = otherText.length > 0;
    const includesOther = dto.jobCategories.includes('기타');

    if (hasOther && !includesOther) {
      throw new BadRequestException('기타 직군과 함께만 사용할 수 있습니다.');
    }

    await this.dataSource.transaction(async (em) => {
      await em.update(User, userId, {
        signupJobCategories: dto.jobCategories,
        signupOtherText: hasOther ? otherText : null,
        onboardedAt: user.onboardedAt ?? new Date(),
      });

      if (dto.jobCategories.length === 0) return;

      const picked = pickSampleCompanies(
        dto.jobCategories,
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
