import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/user.entity';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';
import { ReviewerSeedService } from './reviewer-seed.service';

/**
 * App Review(App Store Guideline 2.1) 전용 "리뷰어 로그인".
 *
 * 배경: 앱스토어 심사관은 카카오 계정을 만들 수 없어 App Review 노트에 줄
 * 이메일/비밀번호 크리덴셜 경로가 필요.
 *
 * 설계:
 *   - 자격은 REVIEWER_EMAIL + REVIEWER_PASSWORD_HASH(bcrypt) env 와만 대조.
 *     → 비밀번호 평문은 DB·env 어디에도 저장하지 않음.
 *   - 둘 다 설정된 경우에만 활성 (isEnabled). 미설정 시 login() 이 404 급 거부 →
 *     운영에 env 를 넣기 전까지 엔드포인트가 존재하지 않는 것처럼 동작.
 *   - 검증 통과 시 리뷰어 계정을 find-or-create 후 반환 → 컨트롤러가 카카오/Apple 과
 *     동일한 issueTokens·refresh 세션 경로를 재사용 (새 토큰 로직 발명 X).
 *
 * 리뷰어 계정 식별:
 *   users 테이블엔 provider 컬럼이 없고 CHECK(kakao_id IS NOT NULL OR apple_sub IS NOT NULL)
 *   제약이 있어, 최소 침습 방식으로 kakao_id 에 sentinel 값(REVIEWER_KAKAO_ID)을 저장해
 *   단일 리뷰어 계정을 식별한다. 실제 카카오 ID 는 숫자 문자열이라 sentinel 과 충돌하지 않고,
 *   kakao_id UNIQUE 제약이 리뷰어 계정을 정확히 1개로 보장 → login 멱등(두 번 = 같은 계정).
 */

/** 리뷰어 계정 sentinel — kakao_id 컬럼에 저장 (실 카카오 ID = 숫자라 충돌 없음) */
export const REVIEWER_KAKAO_ID = 'reviewer';
const REVIEWER_NICKNAME = 'App Reviewer';

@Injectable()
export class ReviewerAuthService {
  private readonly logger = new Logger(ReviewerAuthService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly config: ConfigService,
    private readonly discord: DiscordNotifier,
    private readonly reviewerSeed: ReviewerSeedService,
  ) {}

  /** REVIEWER_EMAIL·REVIEWER_PASSWORD_HASH 둘 다 설정돼 있으면 활성. */
  isEnabled(): boolean {
    return (
      !!this.config.get<string>('REVIEWER_EMAIL') &&
      !!this.config.get<string>('REVIEWER_PASSWORD_HASH')
    );
  }

  /**
   * 리뷰어 로그인 — 자격 검증 후 리뷰어 계정 find-or-create.
   *
   * @throws NotFoundException 엔드포인트 비활성(env 미설정) — 부재처럼 위장
   * @throws UnauthorizedException 이메일/비밀번호 불일치 (어느 쪽인지 미노출 · 단일 메시지)
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ user: User; isNew: boolean }> {
    if (!this.isEnabled()) {
      // env 미설정 → 엔드포인트가 없는 것처럼 (404). 존재 여부 자체를 숨김.
      throw new NotFoundException();
    }

    const ok = await this.verifyCredentials(email, password);
    if (!ok) {
      // 이메일/비번 어느 쪽이 틀렸는지 노출 금지. 실패는 로그만 (Discord 스팸·brute force 증폭 방지).
      this.logger.warn('[reviewer-login] 인증 실패');
      throw new UnauthorizedException(
        '이메일 또는 비밀번호가 올바르지 않습니다.',
      );
    }

    const result = await this.findOrCreateReviewerUser();

    // create 경로에서만 자동 시딩 (계정 탈퇴 후 재로그인 시 샘플 데이터 무인 복구).
    // found 경로는 재시딩 금지 (기존 데이터 이중 생성 방지). best-effort — 시딩 실패해도 로그인 성공.
    if (result.isNew) {
      await this.reviewerSeed.seedReviewerData(result.user.id);
    }

    this.logger.log(`[reviewer-login] 인증 성공 (userId=${result.user.id})`);
    // 성공만 운영 채널에 1줄 통지 (심사 중 소수 로그인 · best-effort). 실패는 로그로만.
    void this.discord
      .notify(
        {
          title: '🧪 리뷰어 로그인',
          color: DISCORD_COLORS.blue,
          fields: [{ name: 'userId', value: result.user.id, inline: true }],
        },
        'ops',
      )
      .catch(() => undefined);

    return result;
  }

  /**
   * 자격 대조 — 이메일(대소문자·공백 무시) + bcrypt 비밀번호.
   *
   * 이메일 불일치여도 bcrypt.compare 를 항상 수행해 타이밍 오라클(계정 열거)을 최소화.
   */
  private async verifyCredentials(
    email: string,
    password: string,
  ): Promise<boolean> {
    const expectedEmail = this.config.get<string>('REVIEWER_EMAIL') ?? '';
    const expectedHash =
      this.config.get<string>('REVIEWER_PASSWORD_HASH') ?? '';

    const emailMatches =
      email.trim().toLowerCase() === expectedEmail.trim().toLowerCase();

    let passwordMatches = false;
    try {
      passwordMatches = await bcrypt.compare(password, expectedHash);
    } catch {
      // 잘못된 hash 포맷 등 → 인증 실패로 취급 (throw X)
      passwordMatches = false;
    }

    return emailMatches && passwordMatches;
  }

  /**
   * 리뷰어 계정(kakao_id = sentinel) find-or-create.
   *
   * kakao_id UNIQUE 라 계정은 정확히 1개 · 두 번째 로그인부터는 항상 같은 계정을 반환(멱등).
   * 동시 최초 로그인 race 는 카카오/Apple 과 동일하게 unique violation(23505) 으로 흡수.
   */
  private async findOrCreateReviewerUser(): Promise<{
    user: User;
    isNew: boolean;
  }> {
    const existing = await this.userRepo.findOne({
      where: { kakaoId: REVIEWER_KAKAO_ID },
    });
    if (existing) return { user: existing, isNew: false };

    try {
      const user = await this.userRepo.save(
        this.userRepo.create({
          kakaoId: REVIEWER_KAKAO_ID,
          nickname: REVIEWER_NICKNAME,
          email: null,
          // role 은 기본 'user' — 리뷰어에게 admin 권한 부여 금지
        }),
      );
      return { user, isNew: true };
    } catch (err) {
      const isUniqueViolation =
        err instanceof QueryFailedError &&
        (
          err as QueryFailedError & {
            driverError?: { code?: string };
          }
        ).driverError?.code === '23505';
      if (!isUniqueViolation) throw err;

      const raced = await this.userRepo.findOne({
        where: { kakaoId: REVIEWER_KAKAO_ID },
      });
      if (!raced) throw err;
      this.logger.warn('findOrCreateReviewerUser race resolved');
      return { user: raced, isNew: false };
    }
  }
}
