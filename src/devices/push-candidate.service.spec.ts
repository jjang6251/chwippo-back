import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { PushCandidateService } from './push-candidate.service';
import { UserDevice } from './user-device.entity';
import { ApplicationStep } from '../applications/application-step.entity';

/**
 * PushCandidateService spec.
 *
 * QueryBuilder mock — createQueryBuilder chain 은 fluent 이라 return this + getMany 반환 mock.
 *
 * 시나리오:
 *   1) D-0 · D-1 · D-3 각각의 스텝 → 후보 검출
 *   2) device 없는 user → skip
 *   3) 스텝 없는 날짜 → empty
 *   4) 한 user 여러 스텝 → stepCount 반영
 */
describe('PushCandidateService', () => {
  let service: PushCandidateService;
  let deviceRepo: jest.Mocked<Repository<UserDevice>>;
  let stepRepo: jest.Mocked<Repository<ApplicationStep>>;
  let qbGetMany: jest.Mock;

  beforeEach(async () => {
    const mockDeviceRepo = mock<Repository<UserDevice>>();
    const mockStepRepo = mock<Repository<ApplicationStep>>();

    qbGetMany = jest.fn().mockResolvedValue([]);
    const qb = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: qbGetMany,
    };
    mockStepRepo.createQueryBuilder.mockReturnValue(qb as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushCandidateService,
        { provide: getRepositoryToken(UserDevice), useValue: mockDeviceRepo },
        {
          provide: getRepositoryToken(ApplicationStep),
          useValue: mockStepRepo,
        },
      ],
    }).compile();

    service = module.get(PushCandidateService);
    deviceRepo = module.get(getRepositoryToken(UserDevice));
    stepRepo = module.get(getRepositoryToken(ApplicationStep));
  });

  afterEach(() => jest.clearAllMocks());

  const makeStep = (userId: string, scheduledDate: Date): ApplicationStep =>
    ({
      id: `s-${Math.random()}`,
      scheduledDate,
      application: { userId, id: 'a-1' },
    }) as ApplicationStep;

  const makeDevice = (userId: string, id: string): UserDevice =>
    ({ id, userId, deviceToken: `t-${id}` }) as UserDevice;

  it('D-0/D-1/D-3 range 3 회 조회 (각 offset 마다)', async () => {
    qbGetMany.mockResolvedValue([]);

    await service.findCandidates(new Date('2026-07-02T00:00:00Z'));

    expect(stepRepo.createQueryBuilder).toHaveBeenCalledTimes(3);
  });

  it('스텝 있는 user + device 등록 → 후보 반환', async () => {
    const step = makeStep('user-1', new Date('2026-07-02T05:00:00Z'));
    // 3회 호출 · 첫 호출만 결과 있음
    qbGetMany
      .mockResolvedValueOnce([step])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    deviceRepo.find.mockResolvedValue([makeDevice('user-1', 'd-1')]);

    const result = await service.findCandidates(
      new Date('2026-07-02T00:00:00Z'),
    );

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('user-1');
    expect(result[0].deviceIds).toEqual(['d-1']);
    expect(result[0].stepCount).toBe(1);
  });

  it('device 없는 user → 후보에서 제외', async () => {
    const step = makeStep('user-no-device', new Date());
    qbGetMany
      .mockResolvedValueOnce([step])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    deviceRepo.find.mockResolvedValue([]);

    const result = await service.findCandidates(new Date());

    expect(result).toHaveLength(0);
  });

  it('한 user 여러 스텝 → stepCount 합산', async () => {
    const s1 = makeStep('user-2', new Date('2026-07-03T05:00:00Z'));
    const s2 = makeStep('user-2', new Date('2026-07-03T06:00:00Z'));
    qbGetMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([s1, s2])
      .mockResolvedValueOnce([]);
    deviceRepo.find.mockResolvedValue([makeDevice('user-2', 'd-x')]);

    const result = await service.findCandidates(
      new Date('2026-07-02T00:00:00Z'),
    );

    expect(result).toHaveLength(1);
    expect(result[0].stepCount).toBe(2);
  });

  it('스텝 없음 → 빈 배열', async () => {
    qbGetMany.mockResolvedValue([]);

    const result = await service.findCandidates(new Date());

    expect(result).toEqual([]);
    // device 조회 불필요
    expect(deviceRepo.find).not.toHaveBeenCalled();
  });

  it('application.userId 누락된 orphan step → skip', async () => {
    const orphan = { scheduledDate: new Date() } as ApplicationStep;
    qbGetMany
      .mockResolvedValueOnce([orphan])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await service.findCandidates(new Date());

    expect(result).toEqual([]);
  });
});
