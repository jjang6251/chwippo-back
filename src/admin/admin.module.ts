import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditLog } from './admin-audit-log.entity';
import { AlertHistory } from './entities/alert-history.entity';
import { AlertThresholds } from './entities/alert-thresholds.entity';
import { AlertThresholdsController } from './alert-thresholds.controller';
import { AlertThresholdsService } from './alert-thresholds.service';
import { ThresholdCheckService } from './threshold-check.service';
import { LlmCallLog } from '../ai/entities/llm-call-log.entity';
import { AiModule } from '../ai/ai.module';
import { User } from '../users/user.entity';
import { Application } from '../applications/application.entity';
import { Inquiry } from '../inquiries/inquiry.entity';
import { UsersModule } from '../users/users.module';
import { InquiriesModule } from '../inquiries/inquiries.module';
import { MyinfoModule } from '../myinfo/myinfo.module';
import { Cert } from '../myinfo/entities/cert.entity';
import { Award } from '../myinfo/entities/award.entity';
import { LanguageCert } from '../myinfo/entities/language-cert.entity';
import { Experience } from '../myinfo/entities/experience.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { Document } from '../myinfo/entities/document.entity';
import { Education } from '../myinfo/entities/education.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AdminAuditLog,
      AlertThresholds,
      AlertHistory,
      LlmCallLog,
      User,
      Application,
      Inquiry,
      Cert,
      Award,
      LanguageCert,
      Experience,
      CoverletterCustom,
      Document,
      Education,
    ]),
    UsersModule,
    InquiriesModule,
    MyinfoModule,
    // F6 PR 2 Phase 5.4 — DiscordNotifier 공유 (abuser-ban 과 같은 webhook URL)
    forwardRef(() => AiModule),
  ],
  controllers: [
    AdminController,
    AdminUsersController,
    AlertThresholdsController,
  ],
  providers: [
    AdminService,
    AdminUsersService,
    AdminAuditService,
    AlertThresholdsService,
    ThresholdCheckService,
  ],
  exports: [AdminAuditService, AlertThresholdsService, ThresholdCheckService],
})
export class AdminModule {}
