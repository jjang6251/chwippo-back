import { Inject, Injectable, Logger } from '@nestjs/common';
import type OpenAI from 'openai';
import { OPENAI_CLIENT } from './openai-client.provider';

export interface ModerationResult {
  flagged: boolean;
  /** flagged 카테고리 (없으면 빈 배열) */
  categories: string[];
  /** OpenAI 호출 자체가 실패하면 true. 운영 정책: fail-open (통과시킴) but log */
  apiFailed: boolean;
}

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(@Inject(OPENAI_CLIENT) private readonly openai: OpenAI | null) {}

  async check(text: string): Promise<ModerationResult> {
    if (!this.openai) {
      // dev 환경 OPENAI_API_KEY 미설정 시: 통과시키되 표시
      return { flagged: false, categories: [], apiFailed: true };
    }

    try {
      const result = await this.openai.moderations.create({
        model: 'omni-moderation-latest',
        input: text,
      });
      const r = result.results?.[0];
      if (!r) return { flagged: false, categories: [], apiFailed: true };

      const categories = Object.entries(r.categories ?? {})
        .filter(([, hit]) => hit === true)
        .map(([name]) => name);

      return {
        flagged: Boolean(r.flagged),
        categories,
        apiFailed: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`Moderation API failed: ${message}`);
      // fail-open: 모더레이션 API 자체 장애 시 차단하면 정상 사용자 차단됨
      return { flagged: false, categories: [], apiFailed: true };
    }
  }
}
