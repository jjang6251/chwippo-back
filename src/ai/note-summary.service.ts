import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Between, DataSource, Repository } from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import {
  endOfTodayKst,
  startOfMonthKst,
  startOfTodayKst,
} from '../common/datetime';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { LlmService } from './llm.service';
import { ModerationService } from './moderation.service';

export const NOTE_SUMMARY_LIMITS = {
  PER_NOTE_PER_24H: 5,
  PER_USER_PER_DAY: 30,
  PER_USER_PER_MONTH: 300,
  MIN_NOTE_CHARS: 50,
  MAX_INPUT_CHARS: 8000, // 너무 긴 노트는 잘라서 비용 통제
} as const;

const SYSTEM_PROMPT = `너는 취준생의 활동 일지를 자소서·면접 작성에 쓸 수 있도록 핵심만 추출하는 요약가다.
- 한국어 1~2문장으로 요약. 150~250자.
- 정량 지표·역할·결과 위주.
- 추측·과장 금지. 본문에 없는 내용 추가 금지.
- 마크다운·헤더·블릿 사용 금지. 한 단락의 평문만.`;

export interface SummarizeNoteOptions {
  /** true 면 캐시 무시하고 강제 재호출 (한도는 계속 적용) */
  force?: boolean;
}

export interface SummarizeNoteResult {
  status: 'ok' | 'cached' | 'blocked';
  summary: string | null;
  cached: boolean;
  /** blocked 사유 사용자 표시용 메시지 */
  reason?: string;
  /** 노트당 남은 호출 수 (24h window) */
  remainingPerNote?: number;
}

@Injectable()
export class NoteSummaryService {
  constructor(
    @InjectRepository(ActivityLog)
    private readonly logRepo: Repository<ActivityLog>,
    @InjectRepository(LlmCallLog)
    private readonly llmLogRepo: Repository<LlmCallLog>,
    private readonly llm: LlmService,
    private readonly moderation: ModerationService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * note (Tiptap JSON) 에서 plain text 추출. 50자 미만이면 거부.
   */
  static extractPlainText(note: Record<string, unknown> | null): string {
    if (!note) return '';
    const parts: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const obj = n as Record<string, unknown>;
      if (typeof obj.text === 'string') parts.push(obj.text);
      const content = obj.content;
      if (Array.isArray(content)) content.forEach(walk);
    };
    walk(note);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  private hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  // KST 기준 윈도우 (Asia/Seoul). 서버 OS TZ 와 무관하게 사용자 시간대 기준으로 일·월 한도 계산.
  // memory feedback-kst-local-date 참고.
  private startOfToday(): Date {
    return startOfTodayKst();
  }

  private startOfMonth(): Date {
    return startOfMonthKst();
  }

  private endOfToday(): Date {
    return endOfTodayKst();
  }

  async summarize(
    userId: string,
    logId: string,
    opts: SummarizeNoteOptions = {},
  ): Promise<SummarizeNoteResult> {
    return this.dataSource.transaction(async (em) => {
      const log = await em.findOne(ActivityLog, {
        where: { id: logId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!log) throw new NotFoundException('로그를 찾을 수 없습니다.');
      if (log.userId !== userId) throw new ForbiddenException();

      const text = NoteSummaryService.extractPlainText(log.note);
      if (text.length < NOTE_SUMMARY_LIMITS.MIN_NOTE_CHARS) {
        throw new BadRequestException(
          `노트가 너무 짧습니다 (${NOTE_SUMMARY_LIMITS.MIN_NOTE_CHARS}자 이상 필요).`,
        );
      }

      const hash = this.hashText(text);

      // 캐시 hit (force 가 아니면 LLM 호출 없이 반환, 로그도 없음)
      if (!opts.force && log.noteSummaryHash === hash && log.noteSummary) {
        return {
          status: 'cached',
          summary: log.noteSummary,
          cached: true,
        };
      }

      // 노트당 24h 한도
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const perNoteCount = await em.count(LlmCallLog, {
        where: {
          userId,
          feature: 'note_summary',
          resourceType: 'activity_log',
          resourceId: logId,
          createdAt: Between(since24h, new Date()),
        },
      });
      if (perNoteCount >= NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H) {
        await this.llm.call({
          userId,
          feature: 'note_summary',
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: text,
          preBlockedStatus: 'blocked_quota',
          preBlockedReason: `노트당 24시간 한도 (${NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H}회) 초과`,
          resourceType: 'activity_log',
          resourceId: logId,
        });
        return {
          status: 'blocked',
          summary: null,
          cached: false,
          reason: `이 노트는 24시간 동안 ${NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H}회 요약을 모두 사용했어요.`,
          remainingPerNote: 0,
        };
      }

      // 사용자 일·월 한도
      const dayCount = await em.count(LlmCallLog, {
        where: {
          userId,
          feature: 'note_summary',
          createdAt: Between(this.startOfToday(), this.endOfToday()),
        },
      });
      if (dayCount >= NOTE_SUMMARY_LIMITS.PER_USER_PER_DAY) {
        await this.llm.call({
          userId,
          feature: 'note_summary',
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: text,
          preBlockedStatus: 'blocked_quota',
          preBlockedReason: `일 한도 (${NOTE_SUMMARY_LIMITS.PER_USER_PER_DAY}회) 초과`,
          resourceType: 'activity_log',
          resourceId: logId,
        });
        return {
          status: 'blocked',
          summary: null,
          cached: false,
          reason: `오늘 사용 가능한 요약 횟수를 모두 사용했어요 (${NOTE_SUMMARY_LIMITS.PER_USER_PER_DAY}회).`,
        };
      }
      const monthCount = await em.count(LlmCallLog, {
        where: {
          userId,
          feature: 'note_summary',
          createdAt: Between(this.startOfMonth(), new Date()),
        },
      });
      if (monthCount >= NOTE_SUMMARY_LIMITS.PER_USER_PER_MONTH) {
        await this.llm.call({
          userId,
          feature: 'note_summary',
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: text,
          preBlockedStatus: 'blocked_quota',
          preBlockedReason: `월 한도 (${NOTE_SUMMARY_LIMITS.PER_USER_PER_MONTH}회) 초과`,
          resourceType: 'activity_log',
          resourceId: logId,
        });
        return {
          status: 'blocked',
          summary: null,
          cached: false,
          reason: `이번 달 사용 가능한 요약 횟수를 모두 사용했어요 (${NOTE_SUMMARY_LIMITS.PER_USER_PER_MONTH}회).`,
        };
      }

      // moderation
      const mod = await this.moderation.check(text);
      if (mod.flagged) {
        await this.llm.call({
          userId,
          feature: 'note_summary',
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: text,
          preBlockedStatus: 'blocked_moderation',
          preBlockedReason: `flagged: ${mod.categories.join(',')}`,
          resourceType: 'activity_log',
          resourceId: logId,
        });
        return {
          status: 'blocked',
          summary: null,
          cached: false,
          reason: '노트에 부적절한 내용이 감지되어 요약할 수 없어요.',
        };
      }

      // 실제 LLM 호출
      const input = text.slice(0, NOTE_SUMMARY_LIMITS.MAX_INPUT_CHARS);
      const result = await this.llm.call({
        userId,
        feature: 'note_summary',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: input,
        maxTokens: 320,
        temperature: 0.3,
        resourceType: 'activity_log',
        resourceId: logId,
      });

      if (result.status !== 'ok') {
        return {
          status: 'blocked',
          summary: null,
          cached: false,
          reason:
            result.status === 'error'
              ? '요약 생성에 실패했어요. 잠시 후 다시 시도해주세요.'
              : '요약을 진행할 수 없어요.',
        };
      }

      // 캐시 저장
      log.noteSummary = result.text;
      log.noteSummaryHash = hash;
      log.noteSummaryAt = new Date();
      await em.save(ActivityLog, log);

      return {
        status: 'ok',
        summary: result.text,
        cached: false,
        remainingPerNote:
          NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H - perNoteCount - 1,
      };
    });
  }
}
