import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UsersService } from '../users/users.service';
import { ApplicationsService } from '../applications/applications.service';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { toKstDateString } from '../common/datetime';

/**
 * App Review 리뷰어 계정 자동 시딩.
 *
 * 심사관이 Guideline 5.1.1(v) 검증으로 계정을 탈퇴해도, 재로그인 시 ReviewerAuthService 의
 * **create 경로**(계정 재생성)에서만 이 시딩이 무인으로 다시 실행돼 샘플 데이터가 복구된다.
 * (found 경로는 절대 재시딩하지 않음 — 기존 데이터 이중 생성 방지.)
 *
 * 구현 원칙:
 *   - 기존 도메인 서비스 공개 메서드만 재사용 (UsersService·ApplicationsService) — raw repo write 금지,
 *     도메인 불변식(스텝 생성·currentStepIndex 가드·트랜잭션) 보존.
 *   - 날짜는 src/common/datetime KST 헬퍼 기준 (UTC 조립 금지).
 *   - best-effort: 일부 실패해도 throw 하지 않음 → 심사관 로그인이 시딩 실패로 막히지 않음.
 *     실패 시 Logger.warn + Discord ops 1줄 통지.
 *
 * ModuleRef 로 UsersService·ApplicationsService 를 런타임 조회 —
 * AuthModule↔UsersModule 순환 의존(UsersModule 이 AuthModule import)을 피하기 위해
 * @Module imports 에 두 모듈을 넣지 않고 lazy resolve 한다.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// 치뽀는 KST-fixed (한국 취준생). 표시 datetime 은 항상 +09:00 로 조립 (applications.service 관례와 정합).
const KST_OFFSET = '+09:00';

/** 오늘(KST) + days 일의 `time` 시각을 KST ISO 문자열로. 예: kstIso(3,'14:00:00') → '2026-07-24T14:00:00+09:00' */
function kstIso(days: number, time: string): string {
  const ymd = toKstDateString(new Date(Date.now() + days * DAY_MS));
  return `${ymd}T${time}${KST_OFFSET}`;
}

@Injectable()
export class ReviewerSeedService {
  private readonly logger = new Logger(ReviewerSeedService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly discord: DiscordNotifier,
  ) {}

  /**
   * 리뷰어 계정 샘플 데이터 시딩 (create 경로에서만 호출).
   *
   * best-effort — 절대 throw 하지 않음 (호출부 로그인 성공 유지).
   */
  async seedReviewerData(userId: string): Promise<void> {
    try {
      const usersService = this.moduleRef.get(UsersService, { strict: false });
      const applicationsService = this.moduleRef.get(ApplicationsService, {
        strict: false,
      });

      // 1. 약관 동의 + 온보딩 완료
      await usersService.agreeTerms(userId);
      await usersService.markOnboarded(userId);

      // 2. signup-answer 경로의 가상 샘플 카드 1장 ('백엔드 개발' → 'Cloud Tech 백엔드')
      await usersService.signupAnswer(userId, {
        jobCategories: ['백엔드 개발'],
      });

      // 3-a. 카카오 (it_dev) — 서버 개발자 · 현재 스텝 = 1차 기술면접(index 2)
      const kakao = await applicationsService.create(userId, {
        companyName: '카카오',
        templateId: 'it_dev',
        jobTitle: '서버 개발자',
        status: 'IN_PROGRESS',
      });
      if (kakao) {
        const interview = kakao.steps?.find((s) => s.orderIndex === 2);
        if (interview) {
          await applicationsService.updateStep(userId, kakao.id, interview.id, {
            scheduledDate: kstIso(3, '14:00:00'), // 오늘+3일 14:00 KST
            location: '판교 카카오 아지트',
          });
        }
        // 메모는 카드(application) 레벨 (수동 pre-load 와 동일 — 카드 상세 메모 영역에 표시)
        await applicationsService.update(userId, kakao.id, {
          memo: '기술 블로그를 자주 읽던 회사. 면접관 3명, 복장 자유라고 안내받음.',
        });
        await applicationsService.updateCurrentStep(userId, kakao.id, 2);
      }

      // 3-b. 네이버 (general) — 백엔드 개발자 · 서류 스텝(index 0) 마감 오늘+5일 18:00 KST
      const naver = await applicationsService.create(userId, {
        companyName: '네이버',
        templateId: 'general',
        jobTitle: '백엔드 개발자',
        status: 'IN_PROGRESS',
      });
      if (naver) {
        const doc = naver.steps?.find((s) => s.orderIndex === 0);
        if (doc) {
          await applicationsService.updateStep(userId, naver.id, doc.id, {
            scheduledDate: kstIso(5, '18:00:00'), // 오늘+5일 18:00 KST
          });
        }
      }

      this.logger.log(`[reviewer-seed] 시딩 완료 (userId=${userId})`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(
        `[reviewer-seed] 시딩 실패 (userId=${userId}): ${message}`,
      );
      void this.discord
        .notify(
          {
            title: '⚠️ 리뷰어 계정 시딩 실패',
            color: DISCORD_COLORS.yellow,
            fields: [
              { name: 'userId', value: userId, inline: true },
              { name: 'error', value: message.slice(0, 500), inline: false },
            ],
          },
          'ops',
        )
        .catch(() => undefined);
    }
  }
}
