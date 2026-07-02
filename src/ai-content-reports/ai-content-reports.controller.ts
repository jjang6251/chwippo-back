import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiContentReportsService } from './ai-content-reports.service';
import { CreateAiContentReportDto } from './dto/create-ai-content-report.dto';

interface AuthUser {
  id: string;
}

/**
 * W2 RN — Google Play AI 콘텐츠 정책.
 *
 * POST /ai-content/report — 사용자가 AI 생성물 신고.
 * 10 req/day 스로틀 (스팸 방지).
 */
@Controller('ai-content')
export class AiContentReportsController {
  constructor(private readonly service: AiContentReportsService) {}

  @Post('report')
  @Throttle({ default: { ttl: 86_400_000, limit: 10 } })
  async report(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAiContentReportDto,
  ): Promise<{ reportId: string; status: string; createdAt: Date }> {
    const saved = await this.service.createReport(user.id, dto);
    return {
      reportId: saved.id,
      status: saved.status,
      createdAt: saved.createdAt,
    };
  }
}
