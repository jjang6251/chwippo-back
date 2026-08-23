import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { mock, MockProxy } from 'jest-mock-extended';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { CompanyResearchStatusController } from './company-research-status.controller';
import { CompanyResearchStatusService } from './company-research-status.service';

/**
 * 회사 조사 현황 admin 컨트롤러 — 권한 회귀 + 내보내기 라우트 배선.
 *
 * 🔴 새 라우트(`export`)는 회사 목록을 **파일로** 내보낸다. 클래스 레벨
 *    `@Roles('admin')` 이 빠지면 로그인한 아무 사용자나 전체 수요 목록을 받는다.
 */
describe('CompanyResearchStatusController', () => {
  let controller: CompanyResearchStatusController;
  let service: MockProxy<CompanyResearchStatusService>;
  const reflector = new Reflector();

  beforeEach(async () => {
    service = mock<CompanyResearchStatusService>();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CompanyResearchStatusController],
      providers: [{ provide: CompanyResearchStatusService, useValue: service }],
    }).compile();
    controller = module.get(CompanyResearchStatusController);
  });

  it('🔴 admin 전용 — 클래스 레벨 @Roles(admin) 이 유지된다 (export 포함 전 라우트)', () => {
    const roles = reflector.get<string[]>(
      ROLES_KEY,
      CompanyResearchStatusController,
    );
    expect(roles).toEqual(['admin']);
  });

  it('export — 쿼리(검색·필터·정렬)를 그대로 서비스에 넘긴다', async () => {
    service.getExport.mockResolvedValue({
      items: [],
      total: 0,
      limit: 500,
      truncated: false,
    });
    await controller.getExport({
      search: '카카오',
      filter: 'unresearched',
      sort: 'applicants',
      order: 'desc',
    });
    expect(service.getExport).toHaveBeenCalledWith({
      search: '카카오',
      filter: 'unresearched',
      sort: 'applicants',
      order: 'desc',
    });
  });

  it('unified 는 기존대로 목록 서비스로 (회귀)', async () => {
    service.getUnified.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
    });
    await controller.getUnified({ page: 2, limit: 20 });
    expect(service.getUnified).toHaveBeenCalledWith({ page: 2, limit: 20 });
  });
});
