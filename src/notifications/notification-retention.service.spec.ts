import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LessThan, type FindOperator } from 'typeorm';
import {
  NotificationRetentionService,
  RETENTION_DAYS,
} from './notification-retention.service';
import { Notification } from './notification.entity';
import { NotificationLog } from './notification-log.entity';

/**
 * 알림 보관 기간 정리 spec.
 *
 * 시나리오 (코드보다 먼저 나열):
 *  1. 읽은 알림은 7일 기준으로 삭제된다
 *  2. 안 읽은 알림은 30일 기준 (놓친 것을 먼저 지우지 않는다)
 *  3. 발송 로그는 90일 · 시각 컬럼이 sent_at (createdAt 아님 — 엔티티 상이)
 *  4. 삭제 건수를 집계해 반환한다 (운영 로그·관측용)
 *  5. affected 가 undefined 여도 0 으로 처리 (드라이버 편차 방어)
 *  6. 🔴 **오늘 레코드 보호** — 임계를 MIN_SAFE_DAYS 미만으로 낮추면 throw.
 *     imminent dedup 이 `notifications` 의 오늘(KST) 레코드를 조회하므로,
 *     오늘 것을 지우면 같은 알림이 15분 뒤 재발송된다
 *  7. 읽음/안읽음 조건이 서로 섞이지 않는다 (read: true / false 로 분리 호출)
 */
describe('NotificationRetentionService', () => {
  const notifDelete = jest.fn();
  const logDelete = jest.fn();
  let service: NotificationRetentionService;

  beforeEach(async () => {
    notifDelete.mockReset().mockResolvedValue({ affected: 0 });
    logDelete.mockReset().mockResolvedValue({ affected: 0 });

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationRetentionService,
        {
          provide: getRepositoryToken(Notification),
          useValue: { delete: notifDelete },
        },
        {
          provide: getRepositoryToken(NotificationLog),
          useValue: { delete: logDelete },
        },
      ],
    }).compile();
    service = moduleRef.get(NotificationRetentionService);
  });

  /** delete 호출 인자에서 cutoff Date 추출 */
  function cutoffOf(call: unknown): Date {
    const arg = call as {
      createdAt?: { value: Date };
      sentAt?: { value: Date };
    };
    const cond = arg.createdAt ?? arg.sentAt;
    return (cond as unknown as { value: Date }).value;
  }

  const NOW = new Date('2026-07-29T00:00:00.000Z');
  const daysBefore = (d: number) =>
    new Date(NOW.getTime() - d * 86_400_000).getTime();

  it('1·7. 읽은 알림 → read:true + 7일 cutoff', async () => {
    await service.purge(NOW);
    const call = notifDelete.mock.calls[0][0] as {
      read: boolean;
      createdAt: unknown;
    };
    expect(call.read).toBe(true);
    expect(cutoffOf(call).getTime()).toBe(daysBefore(RETENTION_DAYS.read));
    expect(RETENTION_DAYS.read).toBe(7);
  });

  it('2·7. 안 읽은 알림 → read:false + 30일 cutoff (더 길게)', async () => {
    await service.purge(NOW);
    const call = notifDelete.mock.calls[1][0] as {
      read: boolean;
      createdAt: unknown;
    };
    expect(call.read).toBe(false);
    expect(cutoffOf(call).getTime()).toBe(daysBefore(RETENTION_DAYS.unread));
    expect(RETENTION_DAYS.unread).toBe(30);
    // 안 읽은 쪽이 반드시 더 길어야 한다 — 놓친 알림을 먼저 지우면 안 된다
    expect(RETENTION_DAYS.unread).toBeGreaterThan(RETENTION_DAYS.read);
  });

  it('3. 발송 로그 → sentAt 기준 90일 (createdAt 아님)', async () => {
    await service.purge(NOW);
    const call = logDelete.mock.calls[0][0] as { sentAt: unknown };
    expect(call).toHaveProperty('sentAt');
    expect(call).not.toHaveProperty('createdAt');
    expect(cutoffOf(call).getTime()).toBe(daysBefore(RETENTION_DAYS.log));
    // dedup 이 참조하므로 알림보다 넉넉해야 한다
    expect(RETENTION_DAYS.log).toBeGreaterThan(RETENTION_DAYS.unread);
  });

  it('4. 삭제 건수를 집계해 반환한다', async () => {
    notifDelete
      .mockResolvedValueOnce({ affected: 12 })
      .mockResolvedValueOnce({ affected: 3 });
    logDelete.mockResolvedValueOnce({ affected: 40 });

    await expect(service.purge(NOW)).resolves.toEqual({
      readDeleted: 12,
      unreadDeleted: 3,
      logDeleted: 40,
    });
  });

  it('5. affected 가 undefined 여도 0 으로 처리', async () => {
    notifDelete.mockResolvedValue({});
    logDelete.mockResolvedValue({});
    await expect(service.purge(NOW)).resolves.toEqual({
      readDeleted: 0,
      unreadDeleted: 0,
      logDeleted: 0,
    });
  });

  it('6. 🔴 임계가 2일 미만이면 throw — 오늘 레코드 삭제 시 imminent 재발송', async () => {
    const original = RETENTION_DAYS.read;
    (RETENTION_DAYS as unknown as { read: number }).read = 1;
    try {
      await expect(service.purge(NOW)).rejects.toThrow(/notification_logs/);
      // 가드가 걸렸으면 삭제 쿼리 자체가 나가면 안 된다
      expect(notifDelete).not.toHaveBeenCalled();
    } finally {
      (RETENTION_DAYS as unknown as { read: number }).read = original;
    }
  });

  it('LessThan 연산자를 쓴다 — cutoff 당일 경계가 삭제되지 않게', async () => {
    await service.purge(NOW);
    const call = notifDelete.mock.calls[0][0] as {
      createdAt: FindOperator<Date>;
    };
    // FindOperator.type 을 직접 본다 — JSON 문자열 비교는 MoreThan 으로 바꿔도 통과해 무의미
    expect(call.createdAt.type).toBe('lessThan');
    expect(LessThan(new Date(0)).type).toBe('lessThan'); // 기준값 동일성 확인
  });
});
