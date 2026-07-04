/**
 * 알림 시스템 공용 타입.
 *
 * 알림 종류 3개 (2026-07-04 CEO 확정):
 *   - briefing: 아침 브리핑 (매일 08:00 KST · 이벤트 있을 때만 · opt-out 가능)
 *   - deadline_urgent: 마감 임박 긴급 (15:00 KST · 오늘 D-day 서류 미제출 · opt-out 가능)
 *   - admin: 정지/코인/plan 등 (정지·해제만 즉시 · 나머지 브리핑 편입 · opt-out 불가)
 */
export type NotificationType = 'briefing' | 'deadline_urgent' | 'admin';

/** dedup 대상 (하루 1회) — admin 은 여러 번 발송 가능하므로 제외 */
export const DEDUP_NOTIFICATION_TYPES: NotificationType[] = [
  'briefing',
  'deadline_urgent',
];

/**
 * 마감 알림 포인트 — 브리핑에 어느 D-day 부터 포함할지.
 *   - d1: D-day, D-1 만
 *   - d3: D-day, D-1, D-3 (기본)
 *   - d7: D-day, D-1, D-3, D-7
 */
export type DeadlinePoints = 'd1' | 'd3' | 'd7';

/** DeadlinePoints → 포함할 D-day offset 배열 (오늘=0) */
export const DEADLINE_POINT_OFFSETS: Record<DeadlinePoints, number[]> = {
  d1: [0, 1],
  d3: [0, 1, 3],
  d7: [0, 1, 3, 7],
};

/**
 * users.alarm_config JSONB 스키마.
 * admin 통지는 여기 없음 (opt-out 불가).
 */
export interface AlarmConfig {
  /** 마스터 스위치 — false 면 briefing·deadline_urgent 전부 안 감 (admin 은 계속) */
  master: boolean;
  /** 아침 브리핑 on/off */
  briefingEnabled: boolean;
  /** 마감 알림 포인트 */
  deadlinePoints: DeadlinePoints;
  /** 마감 임박 긴급 (15:00) on/off */
  deadlineUrgentEnabled: boolean;
}

/** alarm_config 미설정 (NULL) 시 기본값 — 전부 켬 · D-3 부터 */
export const DEFAULT_ALARM_CONFIG: AlarmConfig = {
  master: true,
  briefingEnabled: true,
  deadlinePoints: 'd3',
  deadlineUrgentEnabled: true,
};

/** NULL/부분 config 를 default 와 merge */
export function resolveAlarmConfig(
  config: Partial<AlarmConfig> | null | undefined,
): AlarmConfig {
  return { ...DEFAULT_ALARM_CONFIG, ...(config ?? {}) };
}
