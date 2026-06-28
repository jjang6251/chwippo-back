import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Application } from '../applications/application.entity';
import { User } from '../users/user.entity';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';

/**
 * W2 — 회사명 자동완성 모듈.
 *
 * data source:
 *   - src/data/companies.json (DART JSON, in-memory load)
 *   - applications.company_name DISTINCT (사용자 누적)
 *   - users.signupJobCategories (직군 boost)
 */
@Module({
  imports: [TypeOrmModule.forFeature([Application, User])],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
