import {
  DEADLINE_POINT_OFFSETS,
  DEDUP_NOTIFICATION_TYPES,
  DEFAULT_ALARM_CONFIG,
  DEFAULT_EVENT_TOGGLES,
  classifyBriefingEventKind,
  resolveAlarmConfig,
} from './notification.types';

describe('notification.types', () => {
  it('type 단위 하루 1회 dedup 은 briefing·deadline_urgent 만 — imminent·admin 제외', () => {
    expect(DEDUP_NOTIFICATION_TYPES).toEqual(['briefing', 'deadline_urgent']);
    expect(DEDUP_NOTIFICATION_TYPES).not.toContain('imminent');
  });

  describe('DEADLINE_POINT_OFFSETS — 누적 프리셋', () => {
    it('d1 = {D-1, D-day}', () => {
      expect(DEADLINE_POINT_OFFSETS.d1.sort()).toEqual([0, 1]);
    });
    it('d3 = {D-3, D-1, D-day} (D-1 누적 포함)', () => {
      expect(DEADLINE_POINT_OFFSETS.d3.sort()).toEqual([0, 1, 3]);
      // 핵심 회귀: d3 는 D-1(offset 1) 을 포함한다
      expect(DEADLINE_POINT_OFFSETS.d3).toContain(1);
    });
    it('d7 = {D-7, D-3, D-1, D-day}', () => {
      expect(DEADLINE_POINT_OFFSETS.d7.sort((a, b) => a - b)).toEqual([
        0, 1, 3, 7,
      ]);
    });
  });

  describe('resolveAlarmConfig — 하위호환 merge', () => {
    it('null → 전부 기본값', () => {
      expect(resolveAlarmConfig(null)).toEqual(DEFAULT_ALARM_CONFIG);
    });

    it('undefined → 전부 기본값', () => {
      expect(resolveAlarmConfig(undefined)).toEqual(DEFAULT_ALARM_CONFIG);
    });

    it('구버전 config (briefingHour·eventToggles 없음) → 기본값 채움 (8시·전부 true)', () => {
      const legacy = {
        master: true,
        briefingEnabled: true,
        deadlinePoints: 'd7' as const,
        deadlineUrgentEnabled: false,
      };
      const r = resolveAlarmConfig(legacy);
      expect(r.deadlinePoints).toBe('d7'); // 기존 값 유지
      expect(r.deadlineUrgentEnabled).toBe(false); // 기존 값 유지
      expect(r.briefingHour).toBe(8); // 채움
      expect(r.eventToggles).toEqual(DEFAULT_EVENT_TOGGLES); // 채움
    });

    it('부분 eventToggles ({ interview: false }) → 나머지 유형 true 로 깊게 merge', () => {
      const r = resolveAlarmConfig({ eventToggles: { interview: false } });
      expect(r.eventToggles).toEqual({
        deadline: true,
        interview: false,
        exam: true,
        resultDate: true,
        todo: true,
      });
    });

    it('briefingHour 지정 → 유지', () => {
      expect(resolveAlarmConfig({ briefingHour: 9 }).briefingHour).toBe(9);
    });

    it('imminentEnabled 미존재 (구버전) → 기본 true 채움', () => {
      expect(
        resolveAlarmConfig({ briefingEnabled: false }).imminentEnabled,
      ).toBe(true);
      expect(DEFAULT_ALARM_CONFIG.imminentEnabled).toBe(true);
    });
  });

  describe('resolveAlarmConfig — 레거시 master:false 정규화 (select-all 모델)', () => {
    it('master:false 저장값 → 채널 3종 전부 false 강등 + master 는 true 정규화', () => {
      const r = resolveAlarmConfig({ master: false });
      expect(r.master).toBe(true);
      expect(r.briefingEnabled).toBe(false);
      expect(r.deadlineUrgentEnabled).toBe(false);
      expect(r.imminentEnabled).toBe(false);
    });

    it('master:false + 채널 명시값 공존 → 강등이 우선 (구 "차단기" 의미 보존)', () => {
      const r = resolveAlarmConfig({
        master: false,
        briefingEnabled: true,
        deadlineUrgentEnabled: true,
        imminentEnabled: true,
      });
      expect(r.briefingEnabled).toBe(false);
      expect(r.deadlineUrgentEnabled).toBe(false);
      expect(r.imminentEnabled).toBe(false);
      expect(r.master).toBe(true);
    });

    it('master:false 강등은 채널만 — 포인트·시각·eventToggles 는 유지', () => {
      const r = resolveAlarmConfig({
        master: false,
        deadlinePoints: 'd7',
        briefingHour: 10,
        eventToggles: { interview: false },
      });
      expect(r.deadlinePoints).toBe('d7');
      expect(r.briefingHour).toBe(10);
      expect(r.eventToggles.interview).toBe(false);
    });

    it('master:true → passthrough (채널 무변경)', () => {
      const r = resolveAlarmConfig({ master: true, briefingEnabled: false });
      expect(r.master).toBe(true);
      expect(r.briefingEnabled).toBe(false); // 강등 안 됨
      expect(r.deadlineUrgentEnabled).toBe(true);
      expect(r.imminentEnabled).toBe(true);
    });
  });

  describe('classifyBriefingEventKind — 이름 기반 매핑', () => {
    it('orderIndex 0 → deadline (이름 무관)', () => {
      expect(classifyBriefingEventKind(0, '서류 제출')).toBe('deadline');
      // orderIndex 0 은 이름에 결과가 있어도 deadline 우선
      expect(classifyBriefingEventKind(0, '결과 발표')).toBe('deadline');
    });
    it("이름에 '결과'·'발표' 포함 (orderIndex>0) → resultDate", () => {
      expect(classifyBriefingEventKind(3, '최종 결과')).toBe('resultDate');
      expect(classifyBriefingEventKind(2, '합격 발표')).toBe('resultDate');
    });
    it('그 외 (orderIndex>0) → interview', () => {
      expect(classifyBriefingEventKind(1, '1차 면접')).toBe('interview');
      expect(classifyBriefingEventKind(2, '코딩테스트')).toBe('interview');
    });
  });
});
