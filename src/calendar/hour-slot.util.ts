/**
 * `daily_notes.hour_slot` ↔ 'HH:mm' 변환.
 *
 * 슬롯은 **06:00 을 0 으로 둔 30분 단위 정수**다 (−12 = 00:00 · 0 = 06:00 · 35 = 23:30).
 * 캘린더 그리드가 06시부터 시작하는 화면이라 그 원점이 그대로 저장 형식이 됐다.
 *
 * 🔴 이 산술을 **두 군데에 적지 않는다.** 캘린더는 슬롯을 시각으로 풀고(표시),
 * 공고 카드는 시각을 슬롯으로 접는다(생성). 한쪽만 고치면 「09:00 에 넣었는데
 * 15:00 에 뜬다」가 되고, 그건 화면을 봐야만 드러난다.
 */

/** 슬롯 → 'HH:mm'. null 이면 시각 없는 할 일 */
export function hourSlotToTime(slot: number | null): string | null {
  if (slot === null || slot === undefined) return null;
  const minutes = 360 + slot * 30;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 'HH:mm' → 슬롯. 형식이 아니면 null (= 시각 없는 메모로 들어간다) */
export function timeToHourSlot(time: string | null): number | null {
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  const slot = (h - 6) * 2 + (m >= 30 ? 1 : 0);
  return Math.min(35, Math.max(-12, slot));
}
