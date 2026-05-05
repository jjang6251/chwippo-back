import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { DailyNote } from './daily-note.entity';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

@Module({
  imports: [TypeOrmModule.forFeature([Application, ApplicationStep, DailyNote])],
  controllers: [CalendarController],
  providers: [CalendarService],
})
export class CalendarModule {}
