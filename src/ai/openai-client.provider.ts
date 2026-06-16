import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export const OPENAI_CLIENT = Symbol('OPENAI_CLIENT');

/**
 * dev 환경에서 OPENAI_API_KEY 가 비어있을 수 있으므로 null 반환 가능.
 * 호출 측에서 null 체크 후 적절히 처리 (LlmService 가 status='error' 로 기록).
 */
export const openaiClientProvider: Provider = {
  provide: OPENAI_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): OpenAI | null => {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    if (!apiKey) return null;
    // PR 0 정책 — SDK transport retry 차단 (callJson retry 와 곱셈 방지).
    // ModerationService 전용 클라이언트지만 일관성 위해 동일 적용
    return new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
  },
};
