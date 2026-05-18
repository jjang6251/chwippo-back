import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Application } from './application.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { ApplicationCoverlettersService } from './application-coverletters.service';

const USER_ID = 'user-1';
const APP_ID = 'app-1';
const CL_ID = 'cl-1';

function makeApp(overrides: Partial<Application> = {}): Application {
  return {
    id: APP_ID,
    userId: USER_ID,
    companyName: '카카오',
    ...overrides,
  } as Application;
}

function makeCoverletter(
  overrides: Partial<ApplicationCoverletter> = {},
): ApplicationCoverletter {
  return {
    id: CL_ID,
    applicationId: APP_ID,
    question: '지원 동기를 작성해 주세요',
    category: '지원동기',
    answer: '저는...',
    charLimit: 1000,
    orderIndex: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ApplicationCoverletter;
}

describe('ApplicationCoverlettersService', () => {
  let service: ApplicationCoverlettersService;
  let appRepo: jest.Mocked<Repository<Application>>;
  let clRepo: jest.Mocked<Repository<ApplicationCoverletter>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationCoverlettersService,
        {
          provide: getRepositoryToken(Application),
          useValue: mock<Repository<Application>>(),
        },
        {
          provide: getRepositoryToken(ApplicationCoverletter),
          useValue: mock<Repository<ApplicationCoverletter>>(),
        },
      ],
    }).compile();

    service = module.get(ApplicationCoverlettersService);
    appRepo = module.get(getRepositoryToken(Application));
    clRepo = module.get(getRepositoryToken(ApplicationCoverletter));
  });

  afterEach(() => jest.clearAllMocks());

  // ── 소유자 검증 (IDOR) ─────────────────────────────────
  describe('소유자 검증', () => {
    it('list — 없는 카드 또는 남의 카드면 NotFound', async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(service.list(USER_ID, APP_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(appRepo.findOne).toHaveBeenCalledWith({
        where: { id: APP_ID, userId: USER_ID },
      });
    });

    it('create — 없는 카드면 NotFound', async () => {
      appRepo.findOne.mockResolvedValue(null);
      await expect(
        service.create(USER_ID, APP_ID, { question: 'Q' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── list ───────────────────────────────────────────────
  describe('list', () => {
    it('소유자면 orderIndex ASC로 목록 반환', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      const items = [makeCoverletter()];
      clRepo.find.mockResolvedValue(items);

      const result = await service.list(USER_ID, APP_ID);

      expect(result).toBe(items);
      expect(clRepo.find).toHaveBeenCalledWith({
        where: { applicationId: APP_ID },
        order: { orderIndex: 'ASC', createdAt: 'ASC' },
      });
    });
  });

  // ── create ─────────────────────────────────────────────
  describe('create', () => {
    function mockMaxOrderQb(max: number | null) {
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ max }),
      };
      clRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<ApplicationCoverletter>,
      );
    }

    it('소유자면 생성 — orderIndex = 기존 max + 1', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      mockMaxOrderQb(2);
      clRepo.create.mockImplementation((x) => x as ApplicationCoverletter);
      clRepo.save.mockImplementation(async (x) => x as ApplicationCoverletter);

      await service.create(USER_ID, APP_ID, {
        question: '지원 동기',
        category: '지원동기',
        answer: '내용',
        charLimit: 800,
      });

      expect(clRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          applicationId: APP_ID,
          question: '지원 동기',
          category: '지원동기',
          answer: '내용',
          charLimit: 800,
          orderIndex: 3,
        }),
      );
    });

    it('문항이 0개면 orderIndex = 0', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      mockMaxOrderQb(null);
      clRepo.create.mockImplementation((x) => x as ApplicationCoverletter);
      clRepo.save.mockImplementation(async (x) => x as ApplicationCoverletter);

      await service.create(USER_ID, APP_ID, { question: 'Q' });

      expect(clRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orderIndex: 0,
          category: null,
          answer: null,
          charLimit: null,
        }),
      );
    });
  });

  // ── update ─────────────────────────────────────────────
  describe('update', () => {
    it('소유자 + 문항 존재하면 부분 업데이트', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      const item = makeCoverletter();
      clRepo.findOne.mockResolvedValue(item);
      clRepo.save.mockImplementation(async (x) => x as ApplicationCoverletter);

      await service.update(USER_ID, APP_ID, CL_ID, { answer: '수정된 답변' });

      expect(item.answer).toBe('수정된 답변');
      expect(clRepo.save).toHaveBeenCalledWith(item);
    });

    it('answer를 빈 문자열로 보내면 null로 저장', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      const item = makeCoverletter();
      clRepo.findOne.mockResolvedValue(item);
      clRepo.save.mockImplementation(async (x) => x as ApplicationCoverletter);

      await service.update(USER_ID, APP_ID, CL_ID, { answer: '' });
      expect(item.answer).toBeNull();
    });

    it('charLimit를 null로 보내면 제한 해제', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      const item = makeCoverletter();
      clRepo.findOne.mockResolvedValue(item);
      clRepo.save.mockImplementation(async (x) => x as ApplicationCoverletter);

      await service.update(USER_ID, APP_ID, CL_ID, { charLimit: null });
      expect(item.charLimit).toBeNull();
    });

    it('없는 문항이면 NotFound', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      clRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update(USER_ID, APP_ID, CL_ID, { answer: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── remove ─────────────────────────────────────────────
  describe('remove', () => {
    it('소유자 + 문항 존재하면 삭제', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      clRepo.findOne.mockResolvedValue(makeCoverletter());
      clRepo.delete.mockResolvedValue({ affected: 1, raw: [] });

      await service.remove(USER_ID, APP_ID, CL_ID);
      expect(clRepo.delete).toHaveBeenCalledWith({ id: CL_ID });
    });

    it('없는 문항이면 NotFound', async () => {
      appRepo.findOne.mockResolvedValue(makeApp());
      clRepo.findOne.mockResolvedValue(null);
      await expect(
        service.remove(USER_ID, APP_ID, CL_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── reuseOptions ───────────────────────────────────────
  describe('reuseOptions', () => {
    function mockReuseQb(rows: ApplicationCoverletter[]) {
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      clRepo.createQueryBuilder.mockReturnValue(
        qb as unknown as SelectQueryBuilder<ApplicationCoverletter>,
      );
      return qb;
    }

    it('답변 있는 다른 카드 문항을 반환, 이 카드는 제외', async () => {
      const rows = [
        {
          id: 'cl-a',
          question: 'Q1',
          category: '지원동기',
          answer: 'A1',
          application: { id: 'app-other', companyName: '네이버' },
        } as unknown as ApplicationCoverletter,
      ];
      const qb = mockReuseQb(rows);

      const result = await service.reuseOptions(USER_ID, APP_ID);

      expect(qb.andWhere).toHaveBeenCalledWith('app.id <> :excludeId', {
        excludeId: APP_ID,
      });
      expect(result).toEqual([
        {
          id: 'cl-a',
          question: 'Q1',
          category: '지원동기',
          answer: 'A1',
          applicationId: 'app-other',
          companyName: '네이버',
        },
      ]);
    });

    it('category 주어지면 같은 유형을 앞으로 정렬', async () => {
      const rows = [
        {
          id: 'cl-b',
          question: 'Q2',
          category: '성장과정·가치관',
          answer: 'A2',
          application: { id: 'app-x', companyName: 'X' },
        },
        {
          id: 'cl-a',
          question: 'Q1',
          category: '지원동기',
          answer: 'A1',
          application: { id: 'app-y', companyName: 'Y' },
        },
      ] as unknown as ApplicationCoverletter[];
      mockReuseQb(rows);

      const result = await service.reuseOptions(USER_ID, APP_ID, '지원동기');

      expect(result[0].id).toBe('cl-a'); // 같은 유형이 앞으로
      expect(result[1].id).toBe('cl-b');
    });
  });
});
