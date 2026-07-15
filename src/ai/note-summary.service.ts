import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { billableCallWhere } from './billable-call-filter';
import { createHash } from 'crypto';
import { Between, DataSource, Repository } from 'typeorm';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { AbuserBanService } from './abuser-ban.service';
import { FeatureQuotaConfig } from './entities/feature-quota-config.entity';
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
  /** 5.6.8 — admin 통제 per-note 한도. UI 의 "노트당 N/M" 표시 — limit 동적 반영 */
  perNoteLimit?: number;
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
    @InjectRepository(FeatureQuotaConfig)
    private readonly configRepo: Repository<FeatureQuotaConfig>,
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

      // 5.6.8 — 노트당 24h 한도는 admin 통제 (feature_quota_configs.per_resource_day_limit)
      // NULL 또는 row 없음 → fallback NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H (안전)
      const cfg = await this.configRepo.findOne({
        where: { feature: 'note_summary', tier: 'free' },
      });
      const perNoteLimit =
        cfg?.perResourceDayLimit ?? NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H;

      // 웨이브 A — per-note 가드는 롤링 24h 유지 (CEO 결정). 사용자 일 한도만 자정 리셋.
      const since24h = await this.quotaCheck.resolveRolling24hStart(userId);
      // 5.6.8 fix — blocked/error row 제외 (QuotaCheckService 와 동일 정책).
      const perNoteCount = await em.count(LlmCallLog, {
        where: billableCallWhere({
          userId,
          feature: 'note_summary' as const,
          resourceType: 'activity_log' as const,
          resourceId: logId,
          createdAt: Between(since24h, new Date()),
        }),
      });
      if (perNoteCount >= perNoteLimit) {
        await this.llm.call({
          userId,
          feature: 'note_summary',
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: text,
          preBlockedStatus: 'blocked_quota',
          preBlockedReason: `노트당 24시간 한도 (${perNoteLimit}회) 초과`,
          resourceType: 'activity_log',
          resourceId: logId,
        });
        return {
          status: 'blocked',
          summary: null,
          cached: false,
          reason: `이 노트는 24시간 동안 ${perNoteLimit}회 요약을 모두 사용했어요.`,
          remainingPerNote: 0,
          perNoteLimit,
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
        remainingPerNote: perNoteLimit - perNoteCount - 1,
        perNoteLimit,
      };
    });
  }

  /**
   * 5.6.8 — 노트별 현황만 조회 (mount 시 사용). LLM 호출 0.
   * - log 존재·소유 검증
   * - 24h 내 호출 횟수 + admin 통제 한도
   */
  async getStatus(
    userId: string,
    logId: string,
  ): Promise<{
    perNoteUsed: number;
    perNoteLimit: number;
    remainingPerNote: number;
  }> {
    const log = await this.logRepo.findOne({ where: { id: logId } });
    if (!log) throw new NotFoundException('노트를 찾을 수 없습니다.');
    if (log.userId !== userId)
      throw new ForbiddenException('본인 노트만 조회할 수 있어요.');

    const cfg = await this.configRepo.findOne({
      where: { feature: 'note_summary', tier: 'free' },
    });
    const perNoteLimit =
      cfg?.perResourceDayLimit ?? NOTE_SUMMARY_LIMITS.PER_NOTE_PER_24H;

    // 웨이브 A — per-note 가드는 롤링 24h 유지 (summarize 와 동일 정책)
    const since24h = await this.quotaCheck.resolveRolling24hStart(userId);
    // 5.6.8 fix — summarize 와 동일 status 필터 (ok·retry_parsing 만 카운트)
    const perNoteUsed = await this.llmLogRepo.count({
      where: billableCallWhere({
        userId,
        feature: 'note_summary' as const,
        resourceType: 'activity_log' as const,
        resourceId: logId,
        createdAt: Between(since24h, new Date()),
      }),
    });

    return {
      perNoteUsed,
      perNoteLimit,
      remainingPerNote: Math.max(0, perNoteLimit - perNoteUsed),
    };
  }
}
