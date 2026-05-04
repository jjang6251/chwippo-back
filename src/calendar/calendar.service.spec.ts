import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { CalendarService } from './calendar.service';
import { Application } from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';

describe('CalendarService', () => {
  let service: CalendarService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;

  function makeQb(rawResult: any[] = []) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rawResult),
    } as unknown as SelectQueryBuilder<any>;
    return qb;
  }

  beforeEach(async () => {
    const mockAppRepo = mock<Repository<Application>>();
    const mockStepRepo = mock<Repository<ApplicationStep>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarService,
        { provide: getRepositoryToken(Application), useValue: mockAppRepo },
        { provide: getRepositoryToken(ApplicationStep), useValue: mockStepRepo },
      ],
    }).compile();

    service = module.get<CalendarService>(CalendarService);
    appRepo = module.get(getRepositoryToken(Application));
    stepRepo = module.get(getRepositoryToken(ApplicationStep));
  });

  describe('getMonthEvents', () => {
    it('서류 마감 이벤트를 올바르게 변환한다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          { id: 'app-1', company_name: '네이버', deadline: '2026-05-10' },
        ]) as any,
      );
      stepRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'deadline',
        applicationId: 'app-1',
        companyName: '네이버',
        date: '2026-05-10',
        stepName: null,
        location: null,
      });
    });

    it('면접 일정 이벤트를 올바르게 변환한다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-2',
            company_name: '카카오',
            step_name: '1차 면접',
            location: '온라인',
            date: '2026-05-15',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'interview',
        applicationId: 'app-2',
        companyName: '카카오',
        stepName: '1차 면접',
        location: '온라인',
        date: '2026-05-15',
      });
    });

    it('서류+면접 이벤트가 날짜 오름차순으로 정렬된다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          { id: 'app-1', company_name: '네이버', deadline: '2026-05-20' },
        ]) as any,
      );
      stepRepo.createQueryBuilder.mockReturnValue(
        makeQb([
          {
            application_id: 'app-2',
            company_name: '카카오',
            step_name: '1차 면접',
            location: null,
            date: '2026-05-10',
          },
        ]) as any,
      );

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(2);
      expect(result[0].date).toBe('2026-05-10'); // 면접이 먼저
      expect(result[1].date).toBe('2026-05-20'); // 서류 마감이 나중
    });

    it('이벤트가 없으면 빈 배열을 반환한다', async () => {
      appRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);
      stepRepo.createQueryBuilder.mockReturnValue(makeQb([]) as any);

      const result = await service.getMonthEvents('user-1', 2026, 5);

      expect(result).toHaveLength(0);
    });

    it('12월 요청 시 다음 연도 1월로 범위를 올바르게 계산한다', async () => {
      const appQb = makeQb([]) as any;
      const stepQb = makeQb([]) as any;
      appRepo.createQueryBuilder.mockReturnValue(appQb);
      stepRepo.createQueryBuilder.mockReturnValue(stepQb);

      await service.getMonthEvents('user-1', 2026, 12);

      // andWhere가 end 파라미터로 2027-01-01을 사용해야 함
      expect(appQb.andWhere).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ end: '2027-01-01' }),
      );
    });
  });
});
