/**
 * 알림 시스템 공용 타입.
 *
 * 알림 종류 4개 (2026-07-04 CEO 확정 3종 + 2026-07-19 notification-coverage 'imminent'):
 *   - briefing: 아침 브리핑 (매일 07~10시 KST 중 사용자 선택 · 이벤트 있을 때만 · opt-out 가능)
 *   - deadline_urgent: 마감 임박 긴급 (15:00 KST · 오늘 D-day 서류 미제출 · opt-out 가능)
 *   - imminent: 2시간 전 임박 (15분 cron · 시간 있는 스텝·시험 · master+유형 토글 존중)
 *   - admin: 정지/코인/plan 등 (정지·해제만 즉시 · 나머지 브리핑 편입 · opt-out 불가)
 *
 * DB CHECK (ck_notifications_type · ck_notification_logs_type)는
 * 1784200000000-add-imminent-notification-type 마이그레이션으로 4종 허용.
 */
export type NotificationType =
  | 'briefing'
  | 'deadline_urgent'
  | 'imminent'
  | 'admin';

/**
 * type 단위 "하루 1회" dedup 대상 — admin 은 여러 번 발송 가능하므로 제외.
 * imminent 도 제외 — 하루에 이벤트별 다건 허용, per-(refId, 날짜) dedup 은
 * ImminentReminderService 가 notifications.payload.refId 로 서비스 레벨 처리.
 * (uq_notification_logs_daily_dedup 부분 인덱스도 briefing·deadline_urgent 한정)
 */
export const DEDUP_NOTIFICATION_TYPES: NotificationType[] = [
  'briefing',
  'deadline_urgent',
];

/**
 * 마감 알림 포인트 — 브리핑에 어느 D-day **부터** 포함할지 (누적 프리셋).
 *
 * PRD 명세: 알림 포인트 = {D-3, D-1, D-day}. 설정은 시작점만 고르고 그 이후는 **누적**된다.
 *   - d1: {D-1, D-day}            = "D-1만"
 *   - d3: {D-3, D-1, D-day} (기본) = "D-3부터"
 *   - d7: {D-7, D-3, D-1, D-day}   = "D-7부터"
 *
 * 예) d3 사용자는 D-3·D-1·당일 아침 브리핑을 모두 받는다 (D-1 발송이 핵심 회귀).
 */
export type DeadlinePoints = 'd1' | 'd3' | 'd7';

/** DeadlinePoints → 포함할 D-day offset 배열 (오늘=0). 누적(작은 offset 다 포함). */
export const DEADLINE_POINT_OFFSETS: Record<DeadlinePoints, number[]> = {
  d1: [0, 1],
  d3: [0, 1, 3],
  d7: [0, 1, 3, 7],
};

/** 아침 브리핑 발송 시각 (KST). 07~10시 중 선택 · 기본 8시. */
export type BriefingHour = 7 | 8 | 9 | 10;

/** 유효 브리핑 시각 목록 (@Cron 4개 · DTO IsIn 공용) */
export const BRIEFING_HOURS: BriefingHour[] = [7, 8, 9, 10];

/**
 * 브리핑 유형별 on/off (기본 전부 true).
 * 브리핑 수집 시 각 이벤트를 해당 토글로 필터.
 *   - deadline: 서류 마감 (첫 스텝 orderIndex 0)
 *   - interview: 면접·전형 스텝
 *   - exam: 시험 일정 (myinfo_exam_schedules)
 *   - resultDate: 결과·발표 스텝 (스텝명 매핑 — classifyBriefingEventKind)
 *   - todo: 오늘 미완료 할 일 (daily_notes)
 */
export interface EventToggles {
  deadline: boolean;
  interview: boolean;
  exam: boolean;
  resultDate: boolean;
  todo: boolean;
}

/**
 * users.alarm_config JSONB 스키마.
 * admin 통지는 여기 없음 (opt-out 불가).
 *
 * "전체 알림" 모델 (2026-07-19 CEO 확정 — 약관 전체동의 문법):
 *   전체 알림은 별도 상태가 아니라 채널 3종(briefing·deadlineUrgent·imminent)의
 *   select-all 파생값. 채널이 전부 ON 일 때만 ON 표시, 하나라도 꺼지면 커스텀 상태.
 */
export interface AlarmConfig {
  /**
   * 레거시 차단기 스위치 — resolveAlarmConfig 정규화 후엔 **항상 true**.
   * (구 저장값 master=false 는 채널 전부 OFF 로 강등되어 의미 보존.
   *  발송 게이트의 master 체크는 no-op 으로 유지 — 방어적)
   */
  master: boolean;
  /** 아침 브리핑 on/off */
  briefingEnabled: boolean;
  /** 마감 알림 포인트 (누적 프리셋) */
  deadlinePoints: DeadlinePoints;
  /** 아침 브리핑 발송 시각 (KST · 07~10시) */
  briefingHour: BriefingHour;
  /** 브리핑 유형별 on/off */
  eventToggles: EventToggles;
  /** 마감 임박 긴급 (15:00) on/off */
  deadlineUrgentEnabled: boolean;
  /** 2시간 전 임박 리마인드 on/off */
  imminentEnabled: boolean;
}

/**
 * 알림 설정 부분 update 입력 — eventToggles 는 부분(일부 유형만) 허용.
 * (UpdateAlarmConfigDto 가 이 형태 · 서비스가 현재값에 깊게 merge)
 */
export type AlarmConfigUpdate = Partial<Omit<AlarmConfig, 'eventToggles'>> & {
  eventToggles?: Partial<EventToggles>;
};

/** eventToggles 기본값 — 전부 켬 */
export const DEFAULT_EVENT_TOGGLES: EventToggles = {
  deadline: true,
  interview: true,
  exam: true,
  resultDate: true,
  todo: true,
};

/** alarm_config 미설정 (NULL) 시 기본값 — 전부 켬 · D-3 부터 · 8시 */
export const DEFAULT_ALARM_CONFIG: AlarmConfig = {
  master: true,
  briefingEnabled: true,
  deadlinePoints: 'd3',
  briefingHour: 8,
  eventToggles: DEFAULT_EVENT_TOGGLES,
  deadlineUrgentEnabled: true,
  imminentEnabled: true,
};

/**
 * NULL/부분/구버전 config 를 default 와 merge (하위호환).
 *
 * - 구버전 config (briefingHour·eventToggles·imminentEnabled 없음) → 기본값 채움.
 * - 부분 eventToggles ({ interview: false }) → 나머지 유형은 true 로 채움 (깊은 merge).
 * - **레거시 정규화**: 저장값 master === false (구 "차단기" 의미 = 아무것도 안 보냄) →
 *   채널 3종(briefing·deadlineUrgent·imminent) 전부 false 로 강등하고 master 는
 *   true 로 정규화. 이후 master 는 저장상 항상 true (전체 알림 = 채널 select-all 파생).
 */
export function resolveAlarmConfig(
  config: AlarmConfigUpdate | null | undefined,
): AlarmConfig {
  const c = config ?? {};
  const resolved: AlarmConfig = {
    ...DEFAULT_ALARM_CONFIG,
    ...c,
    eventToggles: {
      ...DEFAULT_EVENT_TOGGLES,
      ...(c.eventToggles ?? {}),
    },
  };
  if (c.master === false) {
    resolved.master = true;
    resolved.briefingEnabled = false;
    resolved.deadlineUrgentEnabled = false;
    resolved.imminentEnabled = false;
  }
  return resolved;
}

/**
 * 브리핑 스텝 이벤트 유형 분류 (이름 기반 최소 매핑).
 *
 * 묶음 5(스텝 유형 분류 체계)와 **독립적으로 동작** — 그 유틸이 확정되면 여기서 교체.
 *   - orderIndex 0 → 'deadline' (서류 마감)
 *   - 이름에 '결과'·'발표' 포함 → 'resultDate'
 *   - 그 외 → 'interview'
 */
export function classifyBriefingEventKind(
  orderIndex: number,
  name: string,
): 'deadline' | 'interview' | 'resultDate' {
  if (orderIndex === 0) return 'deadline';
  if (/결과|발표/.test(name)) return 'resultDate';
  return 'interview';
}
