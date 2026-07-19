import {
  APP_TIMEZONE,
  endOfMonthKst,
  endOfTodayKst,
  formatKstDateTime,
  getKstWeekMonday,
  getKstWeekSunday,
  startOfMonthKst,
  startOfTodayKst,
  toKstDateString,
  todayKst,
} from './datetime';

/**
 * memory `feedback_kst_local_date` — 백엔드 quota·집계 윈도우는 모두 KST 기준.
 * 서버 OS TZ 가 UTC 든 KST 든 결과 일관. 자정·월말·연말 경계 회귀 차단.
 */
describe('common/datetime — KST-fixed 헬퍼', () => {
  it('APP_TIMEZONE = Asia/Seoul', () => {
    expect(APP_TIMEZONE).toBe('Asia/Seoul');
  });

  describe('toKstDateString', () => {
    it('UTC 정오 → KST 같은 날', () => {
      expect(toKstDateString(new Date('2026-05-25T12:00:00Z'))).toBe(
        '2026-05-25',
      );
    });
    it('UTC 일 23:00 → KST 월 (다음 날)', () => {
      expect(toKstDateString(new Date('2026-05-17T23:00:00Z'))).toBe(
        '2026-05-18',
      );
    });
    it('UTC 5/31 15:00 → KST 6/1 00:00 (월말 자정)', () => {
      expect(toKstDateString(new Date('2026-05-31T15:00:00Z'))).toBe(
        '2026-06-01',
      );
    });
    it('tz="UTC" 명시 — UTC 그대로', () => {
      expect(toKstDateString(new Date('2026-05-25T23:00:00Z'), 'UTC')).toBe(
        '2026-05-25',
      );
    });
  });

  describe('todayKst', () => {
    it('YYYY-MM-DD 형식', () => {
      expect(todayKst()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('startOfTodayKst / endOfTodayKst', () => {
    it('start 의 UTC 시각은 KST 자정 → UTC 전날 15:00', () => {
      const today = todayKst();
      const start = startOfTodayKst();
      // start 를 다시 KST 변환하면 같은 today
      expect(toKstDateString(start)).toBe(today);
      // 시·분·초 == 0 (KST 기준), UTC 로는 15:00
      expect(start.getUTCHours()).toBe(15);
      expect(start.getUTCMinutes()).toBe(0);
      expect(start.getUTCSeconds()).toBe(0);
    });

    it('end = start + 24h - 1ms', () => {
      const start = startOfTodayKst();
      const end = endOfTodayKst();
      expect(end.getTime() - start.getTime()).toBe(86_400_000 - 1);
    });

    it('end 의 KST 날짜 = 오늘 (다음날로 안 넘어감)', () => {
      const today = todayKst();
      const end = endOfTodayKst();
      expect(toKstDateString(end)).toBe(today);
    });
  });

  describe('startOfMonthKst / endOfMonthKst', () => {
    it('start = 이번 달 1일 KST 00:00', () => {
      const today = todayKst();
      const [y, m] = today.split('-');
      const start = startOfMonthKst();
      expect(toKstDateString(start)).toBe(`${y}-${m}-01`);
      expect(start.getUTCHours()).toBe(15); // KST 00:00 = UTC 전날 15:00
    });

    it('end = 다음달 1일 - 1ms (월말 경계, KST 기준)', () => {
      const end = endOfMonthKst();
      // end + 1ms = 다음 달 1일 KST 00:00 → KST 날짜가 'YYYY-MM-01' (다음 달)
      const oneMsAfter = new Date(end.getTime() + 1);
      const oneMsAfterYmd = toKstDateString(oneMsAfter);
      const [y, m] = todayKst().split('-').map(Number);
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      expect(oneMsAfterYmd).toBe(
        `${nextY}-${String(nextM).padStart(2, '0')}-01`,
      );
    });

    it('end 의 KST 날짜는 이번 달 마지막 일 (자정 직전)', () => {
      const today = todayKst();
      const [y, m] = today.split('-');
      const end = endOfMonthKst();
      const endYmd = toKstDateString(end);
      expect(endYmd.startsWith(`${y}-${m}`)).toBe(true);
    });
  });

  describe('getKstWeekMonday / getKstWeekSunday', () => {
    it('월 → 월 자신', () => {
      expect(getKstWeekMonday('2026-05-18')).toBe('2026-05-18');
    });
    it('수 → 같은 주 월', () => {
      expect(getKstWeekMonday('2026-05-20')).toBe('2026-05-18');
    });
    it('일 → 직전 월', () => {
      expect(getKstWeekMonday('2026-05-24')).toBe('2026-05-18');
    });
    it('월말 일 → 전월 월요일 (3/1 일 → 2/23 월)', () => {
      expect(getKstWeekMonday('2026-03-01')).toBe('2026-02-23');
    });
    it('연초 일 → 전년 12월 (1/3 일 → 12/28 월)', () => {
      expect(getKstWeekMonday('2027-01-03')).toBe('2026-12-28');
    });
    it('월 + 6 = 일 (Sunday)', () => {
      expect(getKstWeekSunday('2026-05-18')).toBe('2026-05-24');
    });
    it('연말 — 12/28 월 → 1/3 일', () => {
      expect(getKstWeekSunday('2026-12-28')).toBe('2027-01-03');
    });
  });

  describe('formatKstDateTime', () => {
    it('UTC 03:00 → KST 12:00', () => {
      expect(formatKstDateTime(new Date('2026-05-25T03:00:00Z'))).toBe(
        '2026-05-25 12:00:00',
      );
    });
    it('UTC 자정 → KST 09:00', () => {
      expect(formatKstDateTime(new Date('2026-05-25T00:00:00Z'))).toBe(
        '2026-05-25 09:00:00',
      );
    });
    it('KST 자정 정각 → "00:00:00" (h24 표기 회귀 방지 — Node 20 ICU 는 hour12:false 를 h24 로 해석해 "24:00:00")', () => {
      // hasKstTime(날짜만 판정)·임박 표기가 이 포맷에 의존 — 24 표기면 운영(node:20)에서
      // 날짜만 마감이 "시간 있음"으로 오판돼 15시 알림 제외 + 야간 임박 오발송
      expect(formatKstDateTime(new Date('2026-05-25T00:00:00+09:00'))).toBe(
        '2026-05-25 00:00:00',
      );
    });
    it('tz="UTC" 명시', () => {
      expect(formatKstDateTime(new Date('2026-05-25T03:00:00Z'), 'UTC')).toBe(
        '2026-05-25 03:00:00',
      );
    });
  });
});
