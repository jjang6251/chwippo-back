/**
 * App Review 리뷰어 로그인 통합 e2e (POST /auth/reviewer-login).
 *
 * 실 HTTP → ValidationPipe → 컨트롤러 → ReviewerAuthService(실 bcrypt 대조) →
 * find-or-create → AuthService.issueTokens → refresh cookie 까지 검증.
 *
 * ⚠️ 이 엔드포인트는 분당 5회 스로틀이라 함수 검증 테스트가 429 에 걸리지 않도록
 *    각 테스트 전 ThrottlerStorage(in-memory) 를 비운다. 스로틀 설정(5/min) 자체는
 *    auth.controller.spec 에서 @Throttle 메타데이터로 결정적 검증.
 *
 * REVIEWER_EMAIL·REVIEWER_PASSWORD_HASH 는 앱 부팅 전에 process.env 로 주입.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { RedisThrottlerStorage } from '../src/common/redis-throttler.storage';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response-transform.interceptor';
import { REVIEWER_KAKAO_ID } from '../src/auth/reviewer-auth.service';
import { User } from '../src/users/user.entity';

const REVIEWER_EMAIL = 'app-reviewer@chwippo.com';
const REVIEWER_PASSWORD = 'review-me-please-1234';

async function cleanReviewerUser(app: NestExpressApplication): Promise<void> {
  const dataSource = app.get(DataSource);
  await dataSource
    .getRepository(User)
    .createQueryBuilder()
    .delete()
    .where('kakao_id = :id', { id: REVIEWER_KAKAO_ID })
    .execute();
}

describe('Reviewer login (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    // 부팅 전 env 주입 → ConfigModule 이 로드 (엔드포인트 활성 조건)
    process.env.REVIEWER_EMAIL = REVIEWER_EMAIL;
    process.env.REVIEWER_PASSWORD_HASH = bcrypt.hashSync(REVIEWER_PASSWORD, 10);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    app.set('trust proxy', 1);
    app.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        crossOriginEmbedderPolicy: false,
      }),
    );
    app.disable('x-powered-by');
    app.use(json({ limit: '256kb' }));
    app.use(urlencoded({ extended: true, limit: '256kb' }));
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: (errors) =>
          new BadRequestException(
            errors
              .map((e) =>
                e.constraints
                  ? Object.values(e.constraints).join(', ')
                  : e.property,
              )
              .join('; '),
          ),
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseTransformInterceptor());
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector));
    await app.init();
  });

  afterAll(async () => {
    await cleanReviewerUser(app);
    delete process.env.REVIEWER_EMAIL;
    delete process.env.REVIEWER_PASSWORD_HASH;
    await app.close();
  });

  afterEach(async () => {
    await cleanReviewerUser(app);
  });

  beforeEach(async () => {
    // 각 테스트마다 스로틀 카운트 리셋 (5/min 이 함수 검증을 방해하지 않도록).
    // REDIS_URL 있는 환경(CI)은 Redis 스토리지라 in-memory 내부(Map) 대신 자체 clear() 사용.
    const storage = app.get<ThrottlerStorage>(ThrottlerStorage);
    if (storage instanceof RedisThrottlerStorage) {
      await storage.clear();
    } else {
      (storage as ThrottlerStorageService).storage.clear();
    }
  });

  it('정상 자격 → 200 · accessToken · isNew · refresh_token cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD })
      .expect(200);

    // ResponseTransformInterceptor wrap
    expect(res.body).toHaveProperty('data');
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.isNew).toBe(true);
    expect(res.body.data.user.nickname).toBe('App Reviewer');
    // 민감 정보 미노출
    expect(res.body.data.user).not.toHaveProperty('kakaoId');
    expect(res.body.data).not.toHaveProperty('refreshToken');

    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
  });

  it('두 번째 로그인 → 같은 계정 (find-or-create 멱등, isNew=false)', async () => {
    const first = await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD })
      .expect(200);

    const second = await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD })
      .expect(200);

    expect(first.body.data.isNew).toBe(true);
    expect(second.body.data.isNew).toBe(false);
    expect(second.body.data.user.id).toBe(first.body.data.user.id);
  });

  it('이메일 대소문자 무시 → 정상 로그인', async () => {
    await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({
        email: REVIEWER_EMAIL.toUpperCase(),
        password: REVIEWER_PASSWORD,
      })
      .expect(200);
  });

  it('비밀번호 틀림 → 401 (단일 메시지)', async () => {
    await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({ email: REVIEWER_EMAIL, password: 'wrong-password' })
      .expect(401);
  });

  it('이메일 틀림 → 401', async () => {
    await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({ email: 'intruder@chwippo.com', password: REVIEWER_PASSWORD })
      .expect(401);
  });

  it('이메일 형식 아님 → 400 (DTO 검증)', async () => {
    await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({ email: 'not-an-email', password: REVIEWER_PASSWORD })
      .expect(400);
  });

  it('password 누락 → 400 (DTO 검증)', async () => {
    await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({ email: REVIEWER_EMAIL })
      .expect(400);
  });

  it('DTO 외 필드(whitelist 위반) → 400', async () => {
    await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({
        email: REVIEWER_EMAIL,
        password: REVIEWER_PASSWORD,
        role: 'admin',
      })
      .expect(400);
  });

  // ── 자동 시딩 (create 경로) ────────────────────────────
  interface SeededStep {
    orderIndex: number;
    name: string;
    location: string | null;
    scheduledDate: string | null;
  }
  interface SeededApp {
    companyName: string;
    currentStepIndex: number;
    memo: string | null;
    steps: SeededStep[];
  }

  async function loginAndListApps(): Promise<SeededApp[]> {
    const login = await request(app.getHttpServer())
      .post('/auth/reviewer-login')
      .send({ email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD })
      .expect(200);
    const token = login.body.data.accessToken as string;

    const apps = await request(app.getHttpServer())
      .get('/applications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return apps.body.data as SeededApp[];
  }

  it('신규 계정 로그인 → 자동 시딩 (GET /applications 3장 · 면접/서류 스텝 상세)', async () => {
    const list = await loginAndListApps();
    expect(list).toHaveLength(3);

    // 카카오 — 1차 기술면접(idx2) 상세 + 현재 스텝 2
    const kakao = list.find((a) => a.companyName === '카카오');
    expect(kakao).toBeDefined();
    expect(kakao?.currentStepIndex).toBe(2);
    const interview = kakao?.steps.find((s) => s.orderIndex === 2);
    expect(interview?.name).toBe('1차 기술면접');
    expect(interview?.location).toBe('판교 카카오 아지트');
    expect(interview?.scheduledDate).toBeTruthy();
    // 메모는 카드 레벨 (수동 pre-load 와 동일)
    expect(kakao?.memo).toContain('기술 블로그');

    // 네이버 — 서류(idx0) 마감일
    const naver = list.find((a) => a.companyName === '네이버');
    expect(naver).toBeDefined();
    const doc = naver?.steps.find((s) => s.orderIndex === 0);
    expect(doc?.scheduledDate).toBeTruthy();
  });

  it('탈퇴 후 재로그인(create 재실행) → 자동 재시딩 (다시 3장)', async () => {
    // 1차: 생성 + 시딩
    const first = await loginAndListApps();
    expect(first).toHaveLength(3);

    // 탈퇴 시뮬레이션 — 리뷰어 계정 하드 삭제 (cascade 로 카드도 삭제)
    await cleanReviewerUser(app);

    // 재로그인 = 재생성 + 재시딩 → 다시 3장
    const relogin = await loginAndListApps();
    expect(relogin).toHaveLength(3);
    expect(relogin.map((a) => a.companyName).sort()).toEqual(
      first.map((a) => a.companyName).sort(),
    );
  });
});
