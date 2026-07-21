import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity';
import { UserDeletionLog } from '../users/user-deletion-log.entity';
import { RefreshSession } from './refresh-session.entity';
import { RefreshToken } from './refresh-token.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionCleanupCron } from './session-cleanup.cron';
import { AppleAuthService } from './apple-auth.service';
import { AppleS2SService } from './apple-s2s.service';
import { AppleTokenService } from './apple-token.service';
import { KakaoNativeService } from './kakao-native.service';
import { ReviewerAuthService } from './reviewer-auth.service';
import { ReviewerSeedService } from './reviewer-seed.service';
import { IdentityProviderService } from './identity-provider.service';
import { KakaoStrategy } from './strategies/kakao.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { MyinfoModule } from '../myinfo/myinfo.module';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}), // 각 메서드에서 secret 직접 주입
    TypeOrmModule.forFeature([
      User,
      UserDeletionLog,
      RefreshSession,
      RefreshToken,
    ]),
    MyinfoModule, // AppleS2SService StorageUsageService 의존
    FilesModule, // AppleS2SService FilesService 의존
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AppleAuthService,
    AppleS2SService,
    AppleTokenService,
    KakaoNativeService,
    ReviewerAuthService,
    ReviewerSeedService,
    IdentityProviderService,
    KakaoStrategy,
    JwtStrategy,
    JwtRefreshStrategy,
    SessionCleanupCron,
  ],
  exports: [AuthService, AppleAuthService, IdentityProviderService],
})
export class AuthModule {}
