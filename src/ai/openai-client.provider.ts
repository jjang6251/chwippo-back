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
    return new OpenAI({ apiKey });
  },
};
