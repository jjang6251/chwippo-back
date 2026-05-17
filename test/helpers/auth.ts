/**
 * E2E 인증 헬퍼 (LRR P2T1 PR P0 인프라).
 *
 * 실 JwtService로 access·refresh token 발급해서 supertest 요청에 부착.
 * 통합 e2e (controller → guard → strategy → service → DB) 흐름 검증용.
 *
 * 사용:
 *   const { accessToken, user } = await signInAsUser(app, { role: 'user' });
 *   await request(app.getHttpServer())
 *     .get('/users/me/dashboard-config')
 *     .set('Authorization', `Bearer ${accessToken}`)
 *     .expect(200);
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { User } from '../../src/users/user.entity';

export interface SignedInUser {
  user: User;
  accessToken: string;
  refreshToken: string;
}

interface SignInOptions {
  role?: 'user' | 'admin';
  suspended?: boolean;
  nickname?: string;
  email?: string | null;
  termsAgreedAt?: Date | null;
  kakaoIdSuffix?: string;
}

/** 테스트 user를 DB에 생성하고 token pair 발급. afterEach에서 정리 의무. */
export async function signIn(
  app: INestApplication,
  opts: SignInOptions = {},
): Promise<SignedInUser> {
  const dataSource = app.get(DataSource);
  const jwtService = app.get(JwtService);
  const config = app.get(ConfigService);

  const userRepo = dataSource.getRepository(User);
  const kakaoId = `e2e-${opts.kakaoIdSuffix ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = userRepo.create({
    kakaoId,
    nickname: opts.nickname ?? 'e2e-tester',
    email: opts.email ?? null,
    role: opts.role ?? 'user',
    suspendedAt: opts.suspended ? new Date() : null,
    termsAgreedAt: opts.termsAgreedAt ?? new Date(),
  });
  const saved = await userRepo.save(user);

  const payload = { sub: saved.id, role: saved.role };
  const accessToken = jwtService.sign(payload, {
    secret: config.getOrThrow<string>('JWT_SECRET'),
    expiresIn: config.get('JWT_EXPIRES_IN', '1h'),
  });
  const refreshToken = jwtService.sign(payload, {
    secret: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
    expiresIn: config.get('JWT_REFRESH_EXPIRES_IN', '30d'),
  });

  await userRepo.update(saved.id, {
    refreshToken: createHash('sha256').update(refreshToken).digest('hex'),
  });

  return { user: saved, accessToken, refreshToken };
}

/** 일반 user로 sign in. */
export const signInAsUser = (app: INestApplication, opts: SignInOptions = {}) =>
  signIn(app, { role: 'user', ...opts });

/** admin user로 sign in. */
export const signInAsAdmin = (
  app: INestApplication,
  opts: SignInOptions = {},
) => signIn(app, { role: 'admin', ...opts });

/** suspended user로 sign in (token은 발급되지만 strategy에서 차단됨 — 테스트용). */
export const signInAsSuspended = (
  app: INestApplication,
  opts: SignInOptions = {},
) => signIn(app, { role: 'user', suspended: true, ...opts });

/** Authorization Bearer 헤더용 헬퍼. */
export const bearer = (token: string): { Authorization: string } => ({
  Authorization: `Bearer ${token}`,
});
