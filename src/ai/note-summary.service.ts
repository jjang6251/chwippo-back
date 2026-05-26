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
import { AbuserBanService } from './abuser-ban.service';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { LlmService } from './llm.service';
import { ModerationService } from './moderation.service';
import { QuotaCheckService } from './quota-check.service';

/**
 * F6 PR 2 — note-specific 한도만 본 service 에서 관리.
 * **일·월·cooldown·kill switch 는 QuotaCheckService 단일 진입점에 위임** (admin 통제 가능).
 *
 * memory `feedback_admin_quota_control` — 모든 LLM feature 는 admin 통제 가능해야 함.
 */
export const NOTE_SUMMARY_LIMITS = {
  PER_NOTE_PER_24H: 5,
  MIN_NOTE_CHARS: 50,
  MAX_INPUT_CHARS: 8000,
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
  reason?: string;
  remainingPerNote?: number;
  /** COOLDOWN 시 사용자 UI 가 카운트다운 표시용 */
  nextAvailableAt?: string;
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
    private readonly abuserBan: AbuserBanService,
    private readonly quotaCheck: QuotaCheckService,
  ) {}

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

      // 캐시 hit (force 가 아니면 LLM 호출 없이 반환)
      if (!opts.force && log.noteSummaryHash === hash && log.noteSummary) {
        return {
          status: 'cached',
          summary: log.noteSummary,
          cached: true,
        };
      }

      // 노트당 24h 한도 (note-specific, 같은 노트 N회 호출 방어. QuotaCheckService 영역 밖)
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

      // 통합 quota check (enabled·day·month·cooldown·abuser override) — admin 통제 단일 진입점
      const quota = await this.quotaCheck.checkAndPrepare(
        userId,
        'note_summary',
      );
      if (quota.blocked) {
        await this.llm.call({
          userId,
          feature: 'note_summary',
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: text,
          preBlockedStatus: 'blocked_quota',
          preBlockedReason: `${quota.code}: ${quota.reason}`,
          resourceType: 'activity_log',
          resourceId: logId,
        });
        // DAY_LIMIT 도달 시 abuser ban 트리거 (3일 연속 발동 평가, fire & forget)
        if (quota.code === 'DAY_LIMIT') {
          void this.abuserBan
            .checkAndBan(userId, 'note_summary', 1)
            .catch(() => undefined);
        }
        return {
          status: 'blocked',
          summary: null,
          cached: false,
          reason: quota.reason,
          nextAvailableAt: quota.nextAvailableAt?.toISOString(),
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
