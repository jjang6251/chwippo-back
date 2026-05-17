import { IsInt, Min } from 'class-validator';

/**
 * PATCH /applications/:id/step body — currentStepIndex 변경.
 * LRR P2T2 PR γ (MED-2): inline @Body('stepIndex')에서 DTO class로 승격 —
 * ValidationPipe whitelist·type 변환 일관 적용 (이전엔 NaN/문자열 통과 가능).
 */
export class UpdateCurrentStepDto {
  @IsInt()
  @Min(0)
  stepIndex: number;
}
