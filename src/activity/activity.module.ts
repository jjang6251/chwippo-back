import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { ApplicationStep } from '../applications/application-step.entity';
import { Activity } from './entities/activity.entity';
import { ActivityLog } from './entities/activity-log.entity';
import { ActivityReflection } from './entities/activity-reflection.entity';
import { ActivityService } from './activity.service';
import { ActivityLogService } from './activity-log.service';
import { ActivityReflectionService } from './activity-reflection.service';
import { ActivityController } from './activity.controller';
import { ActivityLogController } from './activity-log.controller';
import { ActivityReflectionController } from './activity-reflection.controller';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Activity,
      ActivityLog,
      ActivityReflection,
      ApplicationStep,
    ]),
    DashboardModule,
    forwardRef(() => AiModule),
  ],
  controllers: [
    ActivityController,
    ActivityLogController,
    ActivityReflectionController,
    InsightsController,
  ],
  providers: [
    ActivityService,
    ActivityLogService,
    ActivityReflectionService,
    InsightsService,
  ],
  exports: [
    TypeOrmModule,
    ActivityService,
    ActivityLogService,
    ActivityReflectionService,
  ],
})
export class ActivityModule {}
