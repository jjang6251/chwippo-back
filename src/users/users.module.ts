import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { MyinfoModule } from '../myinfo/myinfo.module';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Application, ApplicationStep]),
    MyinfoModule,
    FilesModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
