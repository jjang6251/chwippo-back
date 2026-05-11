import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MyinfoController } from './myinfo.controller';
import { MyinfoItemsController } from './myinfo-items.controller';
import { ExamSchedulesController } from './exam-schedules.controller';
import { MyinfoService } from './myinfo.service';
import { ExamSchedulesService } from './exam-schedules.service';
import { UserProfile } from './entities/user-profile.entity';
import { LanguageCert } from './entities/language-cert.entity';
import { Cert } from './entities/cert.entity';
import { Award } from './entities/award.entity';
import { Experience } from './entities/experience.entity';
import { Coverletter } from './entities/coverletter.entity';
import { CoverletterCustom } from './entities/coverletter-custom.entity';
import { Document } from './entities/document.entity';
import { ExamSchedule } from './entities/exam-schedule.entity';
import { Education } from './entities/education.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserProfile,
      LanguageCert,
      Cert,
      Award,
      Experience,
      Coverletter,
      CoverletterCustom,
      Document,
      ExamSchedule,
      Education,
    ]),
  ],
  controllers: [
    MyinfoController,
    MyinfoItemsController,
    ExamSchedulesController,
  ],
  providers: [MyinfoService, ExamSchedulesService],
})
export class MyinfoModule {}
