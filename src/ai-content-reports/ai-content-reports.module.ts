import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiContentReport } from './ai-content-report.entity';
import { AiContentReportsController } from './ai-content-reports.controller';
import { AiContentReportsService } from './ai-content-reports.service';
import { DiscordNotifier } from '../common/discord-notifier';

@Module({
  imports: [TypeOrmModule.forFeature([AiContentReport])],
  controllers: [AiContentReportsController],
  providers: [AiContentReportsService, DiscordNotifier],
  exports: [AiContentReportsService],
})
export class AiContentReportsModule {}
