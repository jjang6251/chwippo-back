import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { User } from '../users/user.entity';

/**
 * Refresh token을 DB에 저장하기 전 SHA-256 hex로 해싱.
 * - DB 유출 시 active refresh token 평문 노출 방지 (ADR-021 후속, LRR P1T1 M-2)
 * - JWT 자체가 200+자 고엔트로피라 rainbow table 무력화
 */
function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface KakaoUser {
  kakaoId: string;
  nickname: string;
  email: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async findOrCreateKakaoUser(
    kakaoUser: KakaoUser,
  ): Promise<{ user: User; isNew: boolean }> {
    let user = await this.userRepo.findOne({
      where: { kakaoId: kakaoUser.kakaoId },
    });
    let isNew = !user;

    if (!user) {
      try {
        user = this.userRepo.create({
          kakaoId: kakaoUser.kakaoId,
          nickname: kakaoUser.nickname,
          email: kakaoUser.email,
        });
        user = await this.userRepo.save(user);
      } catch (err) {
        // Race condition: 동시 카카오 callback이 같은 ID로 save 시도
        // PostgreSQL unique violation code: 23505
        const isUniqueViolation =
          err instanceof QueryFailedError &&
          (
            err as QueryFailedError & {
              code?: string;
              driverError?: { code?: string };
            }
          ).driverError?.code === '23505';
        if (!isUniqueViolation) throw err;

        // 다른 요청이 먼저 INSERT 성공 → 그 user를 findOne으로 가져옴
        const existing = await this.userRepo.findOne({
          where: { kakaoId: kakaoUser.kakaoId },
        });
        if (!existing) throw err; // 정말로 사라졌으면 원본 에러 전파
        this.logger.warn(
          `findOrCreateKakaoUser race resolved (kakaoId=${kakaoUser.kakaoId})`,
        );
        user = existing;
        isNew = false;
      }
    }

    // ADMIN_KAKAO_ID 환경변수와 일치하면 자동으로 admin 승격
    // 직접 DB 쿼리 없이 첫 로그인 시점에만 적용 (이미 admin이면 스킵)
    const adminKakaoId = this.config.get<string>('ADMIN_KAKAO_ID');
    if (
      adminKakaoId &&
      user.kakaoId === adminKakaoId &&
      user.role !== 'admin'
    ) {
      await this.userRepo.update(user.id, { role: 'admin' });
      user.role = 'admin';
    }

    return { user, isNew };
  }

  async issueTokens(user: User): Promise<TokenPair> {
    const payload = { sub: user.id, role: user.role };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      expiresIn: this.config.get('JWT_EXPIRES_IN', '1h'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN', '30d'),
    });

    // DB엔 hash만 저장, 클라이언트엔 평문 JWT 반환 (browser cookie 보관)
    await this.userRepo.update(user.id, {
      refreshToken: hashRefreshToken(refreshToken),
    });

    return { accessToken, refreshToken };
  }

  /**
   * Refresh token rotation (LRR P1T1 M-1).
   * - 매 /auth/refresh 호출마다 새 access·refresh 둘 다 발급
   * - DB hash가 새 값으로 갱신됨 → 이전 refresh token 자동 무효
   * - 효과: refresh token 탈취 시 다음 정상 refresh가 탈취된 토큰 무효화
   * - User 못 찾으면(어드민이 강제 삭제 직후 cookie 보유 등) 500이 아닌 401로
   */
  async refreshTokens(userId: string): Promise<TokenPair> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.issueTokens(user);
  }

  async logout(userId: string): Promise<void> {
    await this.userRepo.update(userId, { refreshToken: null });
  }
}
