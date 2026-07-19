import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { Notification } from './notification.entity';
import {
  IMMINENT_LEAD_MS,
  hasKstTime,
  loadSentImminentRefIdsToday,
} from './imminent.util';

/**
 * imminent 공유 유틸 — hasKstTime 은 ImminentReminderService 와
 * DeadlineUrgentService 가 **단일 함수**로 공유하는 "시간 있음" 판정.
 * 경계가 갈리면 양쪽 다 놓치는 틈이 생기므로 경계를 직접 고정한다.
 */
describe('imminent.util', () => {
  it('IMMINENT_LEAD_MS = 정확히 2시간', () => {
    expect(IMMINENT_LEAD_MS).toBe(2 * 60 * 60 * 1000);
  });

  describe('hasKstTime — 자정 정각 경계 (공유 판정)', () => {
    it('KST 00:00:00 정각 (날짜만 저장 관례) → false', () => {
      expect(hasKstTime(new Date('2026-07-04T00:00:00+09:00'))).toBe(false);
    });

    it('KST 00:15 → true (자정 이후 15분도 시간 지정)', () => {
      expect(hasKstTime(new Date('2026-07-04T00:15:00+09:00'))).toBe(true);
    });

    it('KST 00:00:01 (초 단위 지정) → true', () => {
      expect(hasKstTime(new Date('2026-07-04T00:00:01+09:00'))).toBe(true);
    });

    it('UTC 자정 ≠ KST 자정 — UTC 00:00 은 KST 09:00 이므로 true (TZ 안전)', () => {
      expect(hasKstTime(new Date('2026-07-04T00:00:00Z'))).toBe(true);
    });

    it('일반 시각 (KST 14:00) → true', () => {
      expect(hasKstTime(new Date('2026-07-04T14:00:00+09:00'))).toBe(true);
    });
  });

  describe('loadSentImminentRefIdsToday', () => {
    let repo: jest.Mocked<Repository<Notification>>;
    let qb: jest.Mocked<SelectQueryBuilder<Notification>>;

    beforeEach(() => {
      repo = mock<Repository<Notification>>();
      qb = mock<SelectQueryBuilder<Notification>>();
      ['where', 'andWhere', 'select'].forEach((m) =>
        (qb as never as Record<string, jest.Mock>)[m].mockReturnThis(),
      );
      qb.getMany.mockResolvedValue([]);
      repo.createQueryBuilder.mockReturnValue(qb);
    });

    const row = (userId: string, payload: Record<string, unknown> | null) =>
      ({ userId, payload }) as Notification;

    it('빈 userIds → 쿼리 없이 빈 Map', async () => {
      const r = await loadSentImminentRefIdsToday(repo, [], new Date());
      expect(r.size).toBe(0);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('userId 별 refId 집합으로 그룹', async () => {
      qb.getMany.mockResolvedValue([
        row('u1', { refId: 's1' }),
        row('u1', { refId: 's2' }),
        row('u2', { refId: 's1' }),
      ]);

      const r = await loadSentImminentRefIdsToday(
        repo,
        ['u1', 'u2'],
        new Date(),
      );

      expect(r.get('u1')).toEqual(new Set(['s1', 's2']));
      expect(r.get('u2')).toEqual(new Set(['s1']));
    });

    it('payload 없음·refId 비문자열 행은 무시 (방어)', async () => {
      qb.getMany.mockResolvedValue([
        row('u1', null),
        row('u1', { refId: 123 }),
        row('u1', { refId: 's1' }),
      ]);

      const r = await loadSentImminentRefIdsToday(repo, ['u1'], new Date());
      expect(r.get('u1')).toEqual(new Set(['s1']));
    });

    it("쿼리 predicate — type='imminent' + KST 날짜", async () => {
      await loadSentImminentRefIdsToday(repo, ['u1'], new Date());
      expect(qb.andWhere).toHaveBeenCalledWith("n.type = 'imminent'");
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("AT TIME ZONE 'Asia/Seoul'"),
        expect.objectContaining({ today: expect.any(String) }),
      );
    });
  });
});
