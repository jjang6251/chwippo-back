import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';

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
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async findOrCreateKakaoUser(kakaoUser: KakaoUser): Promise<{ user: User; isNew: boolean }> {
    let user = await this.userRepo.findOne({ where: { kakaoId: kakaoUser.kakaoId } });
    const isNew = !user;

    if (!user) {
      user = this.userRepo.create({
        kakaoId: kakaoUser.kakaoId,
        nickname: kakaoUser.nickname,
        email: kakaoUser.email,
      });
      user = await this.userRepo.save(user);
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

    await this.userRepo.update(user.id, { refreshToken });

    return { accessToken, refreshToken };
  }

  async refreshAccessToken(userId: string): Promise<string> {
    const user = await this.userRepo.findOneOrFail({ where: { id: userId } });
    const payload = { sub: user.id, role: user.role };

    return this.jwtService.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      expiresIn: this.config.get('JWT_EXPIRES_IN', '1h'),
    });
  }

  async logout(userId: string): Promise<void> {
    await this.userRepo.update(userId, { refreshToken: null });
  }
}
