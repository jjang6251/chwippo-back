import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Application } from '../applications/application.entity';
import { CompanyResearchCache } from '../interview-prep/entities/company-research-cache.entity';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';

/**
 * W2 — 회사명 자동완성 모듈.
 *
 * data source:
 *   - src/data/companies.json (DART JSON, in-memory load)
 *   - company_research_cache (회사 조사 시드)
 *   - applications.company_name DISTINCT (사용자 누적)
 *
 * 🔴 조사 캐시는 **엔티티만** `forFeature` 로 등록해 레포를 직접 주입한다.
 * `InterviewPrepModule` 을 import 하면 모듈 순환에 걸린다 (2026-08-08 E2E 전량 실패 전례).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Application, CompanyResearchCache])],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
