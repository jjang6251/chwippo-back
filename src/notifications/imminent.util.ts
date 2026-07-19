import { Repository } from 'typeorm';
import { Notification } from './notification.entity';
import {
  formatKstDateTime,
  kstDateSql,
  toKstDateString,
} from '../common/datetime';

/**
 * imminent(2시간 전) 관련 공유 유틸.
 *
 * ⚠️ ImminentReminderService 와 DeadlineUrgentService(15시 중복 해소)가 **반드시
 * 같은 판정**을 쓰도록 단일 소스로 export — 한쪽 복붙 금지. 판정이 갈리면
 * "임박이 커버한 줄 알고 15시를 건너뛰었는데 임박도 안 간" 침묵 손실 틈이 생긴다.
 */

/** 이벤트 몇 시간 전에 임박 알림을 보낼지 (Q4 — 고정 2시간) */
export const IMMINENT_LEAD_MS = 2 * 60 * 60 * 1000;

/**
 * "시간 있는" 이벤트 판정 — KST 자정 정각(=날짜만 지정 저장 관례
 * `T00:00:00+09:00`)이 아니면 true. 00:15 등 자정 이후는 시간 지정으로 간주.
 */
export function hasKstTime(eventTime: Date): boolean {
  return formatKstDateTime(eventTime).slice(11) !== '00:00:00';
}

/**
 * 오늘(KST) 이미 발송한 imminent 의 refId 집합 (userId 별).
 * notifications.payload.refId 기반 — (user, imminent, refId, 날짜) dedup 의 단일 조회.
 * imminent 발송 dedup 과 15시 마감 당일 알림의 "이미 임박 발송됨" 판정이 공유.
 */
export async function loadSentImminentRefIdsToday(
  repo: Repository<Notification>,
  userIds: string[],
  now: Date,
): Promise<Map<string, Set<string>>> {
  const byUser = new Map<string, Set<string>>();
  if (userIds.length === 0) return byUser;

  const todayKst = toKstDateString(now);
  const rows = await repo
    .createQueryBuilder('n')
    .where('n.user_id IN (:...userIds)', { userIds })
    .andWhere("n.type = 'imminent'")
    .andWhere(`${kstDateSql('n.created_at')} = :today`, {
      today: todayKst,
    })
    .select(['n.userId', 'n.payload'])
    .getMany();

  for (const row of rows) {
    const refId = (row.payload as { refId?: unknown } | null)?.refId;
    if (typeof refId !== 'string') continue;
    const set = byUser.get(row.userId) ?? new Set<string>();
    set.add(refId);
    byUser.set(row.userId, set);
  }
  return byUser;
}
