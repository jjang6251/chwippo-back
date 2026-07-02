import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AppleAuthService } from './apple-auth.service';
import { AppleS2SService } from './apple-s2s.service';
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
    TypeOrmModule.forFeature([User]),
    MyinfoModule, // AppleS2SService StorageUsageService 의존
    FilesModule, // AppleS2SService FilesService 의존
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AppleAuthService,
    AppleS2SService,
    IdentityProviderService,
    KakaoStrategy,
    JwtStrategy,
    JwtRefreshStrategy,
  ],
  exports: [AuthService, AppleAuthService, IdentityProviderService],
})
export class AuthModule {}
