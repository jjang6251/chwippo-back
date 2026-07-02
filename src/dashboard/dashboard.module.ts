import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Application } from '../applications/application.entity';
import { ApplicationCoverletter } from '../applications/application-coverletter.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { ExamSchedule } from '../myinfo/entities/exam-schedule.entity';
import { DashboardService } from './dashboard.service';
import { StreakService } from './streak.service';
import { GrowthService } from './growth.service';
import { DashboardController } from './dashboard.controller';
import { CompaniesModule } from '../companies/companies.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Application,
      ApplicationCoverletter,
      ApplicationStep,
      ExamSchedule,
    ]),
    CompaniesModule,
  ],
  providers: [DashboardService, StreakService, GrowthService],
  controllers: [DashboardController],
})
export class DashboardModule {}
