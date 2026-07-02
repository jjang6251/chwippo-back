import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiContentReport } from './ai-content-report.entity';
import { CreateAiContentReportDto } from './dto/create-ai-content-report.dto';
import { DiscordNotifier } from '../common/discord-notifier';

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
        `🚨 **AI 콘텐츠 신고 접수**\n` +
          `- reportId: \`${saved.id}\`\n` +
          `- reporter: \`${userId}\`\n` +
          `- content: \`${dto.contentType}\`${dto.contentId ? ` (${dto.contentId})` : ''}\n` +
          `- reason: \`${dto.reason}\`\n` +
          `- detail: ${preview}`,
      )
      .catch((err) =>
        this.logger.warn(`Discord alert failed: ${(err as Error).message}`),
      );

    return saved;
  }
}
