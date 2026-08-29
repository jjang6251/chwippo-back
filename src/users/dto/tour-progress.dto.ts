import { IsBoolean, IsInt, Max, Min } from 'class-validator';

/**
 * 앱 소개 투어 진행 기록 DTO — `POST /users/me/tour`.
 *
 * 투어가 **끝나는 순간에만 한 번** 온다 (마지막 장 CTA · 건너뛰기). 장면을 넘길 때마다
 * 보내지 않는다 — 그건 6배의 쓰기를 만들면서 답은 「마지막 장면」 하나뿐이라 같다.
 *
 * 🔴 **다시 보기(`?replay=1`)는 이 엔드포인트를 부르지 않는다.** 재생일 뿐이라
 * 「처음 만난 시각」도 「이탈 장면」도 오염시키면 안 된다. 서버에 그 분기가 없는 이유가
 * 이것이다 — 프론트가 아예 호출하지 않는다.
 */
export class TourProgressDto {
  /**
   * 마지막으로 본 장면 (1~7). 범위 밖은 400 — 관측값이라도 아무 숫자나 받지 않는다.
   *
   * 🔴 **프론트 `TOUR_SCENE_COUNT` 와 같은 계약이다** (v2 에서 6 → 7 로 늘었다).
   * 장면을 더하거나 빼면 여기부터 고친다 — 상한이 낮으면 마지막 장 완료가 통째로 400 이 되고,
   * 그 실패는 fire-and-forget 이라 **화면에 아무 표시도 없이** 관측만 비어버린다.
   */
  @IsInt()
  @Min(1)
  @Max(7)
  lastStep: number;

  /** 마지막 장까지 도달했는가. `false` = 건너뛰기 */
  @IsBoolean()
  completed: boolean;
}
