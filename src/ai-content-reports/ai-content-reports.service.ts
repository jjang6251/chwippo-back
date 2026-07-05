import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiContentReport } from './ai-content-report.entity';
import { CreateAiContentReportDto } from './dto/create-ai-content-report.dto';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';

/**
 * W2 RN — Google Play AI 콘텐츠 정책 대응 서비스.
 *
 * 신고 접수 → DB 저장 → Discord 알림 (best-effort).
 * admin 처리 UI 는 후속 별도 PR.
 */
@Injectable()
export class AiContentReportsService {
  private readonly logger = new Logger(AiContentReportsService.name);

  constructor(
    @InjectRepository(AiContentReport)
    private readonly repo: Repository<AiContentReport>,
    private readonly discord: DiscordNotifier,
  ) {}

  async createReport(
    userId: string,
    dto: CreateAiContentReportDto,
  ): Promise<AiContentReport> {
    const entity = this.repo.create({
      reporterUserId: userId,
      contentType: dto.contentType,
      contentId: dto.contentId ?? null,
      reason: dto.reason,
      detail: dto.detail ?? null,
      status: 'pending',
    });

    const saved = await this.repo.save(entity);

    // Discord alert (best-effort · 신고 접수 후 admin 즉시 인지)
    const preview = dto.detail ? dto.detail.slice(0, 120) : '(상세 없음)';
    void this.discord
      .notify(
        {
          title: '🚨 AI 콘텐츠 신고 접수',
          description: preview,
          color: DISCORD_COLORS.red,
          fields: [
            {
              name: 'content',
              value: `${dto.contentType}${dto.contentId ? ` (${dto.contentId})` : ''}`,
              inline: true,
            },
            { name: 'reason', value: dto.reason, inline: true },
            { name: 'reporter', value: userId },
            { name: 'reportId', value: saved.id },
          ],
        },
        'inquiries',
      )
      .catch((err) =>
        this.logger.warn(`Discord alert failed: ${(err as Error).message}`),
      );

    return saved;
  }
}
