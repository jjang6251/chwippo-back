import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Application } from './application.entity';
import { ApplicationStep } from './application-step.entity';
import { StepChecklistItem } from './step-checklist-item.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ApplicationCoverlettersController } from './application-coverletters.controller';
import { ApplicationCoverlettersService } from './application-coverletters.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Application,
      ApplicationStep,
      StepChecklistItem,
      ApplicationCoverletter,
    ]),
  ],
  controllers: [ApplicationsController, ApplicationCoverlettersController],
  providers: [ApplicationsService, ApplicationCoverlettersService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
