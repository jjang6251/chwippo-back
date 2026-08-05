/**
 * 데스크탑 웹 스탬프 beacon e2e — `POST /users/me/desktop-seen`.
 *
 * 🔴 **여기서만 증명할 수 있는 것이 있다.** 단위 spec 은 QueryBuilder mock 위에서 돌아
 * *"`IS NULL` 을 WHERE 에 넣었다"* 까지만 확인한다. **그 SQL 이 실제로 최초 시각을 보존하는지**는
 * 진짜 DB 에 두 번 쏴 봐야 안다 — 이 파일이 그 몫이다.
 *
 * 이 값은 관측 화면에서 **자소서 도달 지표의 분모**가 된다. 최초 시각이 덮어써지면
 * "언제부터 데스크탑을 썼나" 가 매 접속마다 오늘로 밀려 코호트 분석이 무의미해진다.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { createTestApp } from './helpers/bootstrap';
import { bearer, signInAsUser } from './helpers/auth';
import { cleanAllTestUsers } from './helpers/db';
import { User } from '../src/users/user.entity';

describe('데스크탑 웹 스탬프 beacon (e2e)', () => {
  let app: INestApplication<App>;

  const stampOf = async (userId: string): Promise<Date | null> => {
    const row = await app
      .get(DataSource)
      .getRepository(User)
      .findOne({ where: { id: userId } });
    return row?.firstDesktopWebSeenAt ?? null;
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await cleanAllTestUsers(app);
    await app.close();
  });

  afterEach(async () => {
    await cleanAllTestUsers(app);
  });

  it('미인증 → 401', () =>
    request(app.getHttpServer()).post('/users/me/desktop-seen').expect(401));

  it('인증 → 204 + 스탬프가 실제로 찍힌다', async () => {
    const { user, accessToken } = await signInAsUser(app);
    expect(await stampOf(user.id)).toBeNull();

    const res = await request(app.getHttpServer())
      .post('/users/me/desktop-seen')
      .set(bearer(accessToken))
      .expect(204);
    expect(res.text).toBe('');

    expect(await stampOf(user.id)).toBeInstanceOf(Date);
  });

  // 🔴 mock 으로는 못 잡는 회귀 — 실제 SQL 이 최초 시각을 보존하는가
  it('두 번 호출해도 최초 시각이 바뀌지 않는다 (멱등)', async () => {
    const { user, accessToken } = await signInAsUser(app);

    await request(app.getHttpServer())
      .post('/users/me/desktop-seen')
      .set(bearer(accessToken))
      .expect(204);
    const first = await stampOf(user.id);

    // now() 가 확실히 달라지도록 간격을 둔다 (같은 ms 면 덮어써도 통과해 버린다)
    await new Promise((r) => setTimeout(r, 50));

    await request(app.getHttpServer())
      .post('/users/me/desktop-seen')
      .set(bearer(accessToken))
      .expect(204);

    expect((await stampOf(user.id))?.getTime()).toBe(first?.getTime());
  });

  // 탭을 여러 개 동시에 열면 실제로 일어나는 상황 — 읽고-쓰기였다면 여기서 갈린다
  it('동시 호출 5회에도 시각이 하나로 남는다', async () => {
    const { user, accessToken } = await signInAsUser(app);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post('/users/me/desktop-seen')
          .set(bearer(accessToken))
          .expect(204),
      ),
    );

    expect(await stampOf(user.id)).toBeInstanceOf(Date);
  });

  it('다른 사용자의 스탬프에는 영향이 없다', async () => {
    const a = await signInAsUser(app, { kakaoIdSuffix: 'desk-a' });
    const b = await signInAsUser(app, { kakaoIdSuffix: 'desk-b' });

    await request(app.getHttpServer())
      .post('/users/me/desktop-seen')
      .set(bearer(a.accessToken))
      .expect(204);

    expect(await stampOf(a.user.id)).toBeInstanceOf(Date);
    expect(await stampOf(b.user.id)).toBeNull();
  });
});
