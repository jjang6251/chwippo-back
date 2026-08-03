import { IsIn, IsString } from 'class-validator';
import { MODEL_REGISTRY } from '../../ai/model-registry';

/**
 * G-1 — feature 의 LLM 모델 변경.
 *
 * **`provider` 를 받지 않는다.** 모델이 정해지면 provider 는 레지스트리에서 파생되므로,
 * 클라이언트가 보내면 "모델은 anthropic 인데 provider 는 openai" 같은 불일치가 가능해진다.
 * 받지 않으면 그 검증 자체가 필요 없어진다.
 *
 * 🔴 `@IsIn` 이 **레지스트리 키에서 파생**된다 — 단가·능력이 선언되지 않은 모델은
 * DTO 단계에서 막힌다. 새 모델을 쓰려면 레지스트리에 먼저 등록해야 한다.
 */
export class UpdateFeatureModelDto {
  @IsString()
  @IsIn(Object.keys(MODEL_REGISTRY), {
    message: '등록되지 않은 모델입니다. MODEL_REGISTRY 에 먼저 추가하세요.',
  })
  model: string;
}
