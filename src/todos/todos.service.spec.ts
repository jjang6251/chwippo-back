import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { Todo } from './todo.entity';
import { TodosService } from './todos.service';

describe('TodosService', () => {
  let service: TodosService;
  let todoRepo: jest.Mocked<Repository<Todo>>;

  const makeTodo = (overrides: Partial<Todo> = {}): Todo => ({
    id: 'todo-uuid-1',
    user_id: 'user-uuid-1',
    content: '이력서 작성',
    date: new Date().toISOString().split('T')[0],
    is_done: false,
    created_at: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    const mockRepo = mock<Repository<Todo>>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TodosService,
        { provide: getRepositoryToken(Todo), useValue: mockRepo },
      ],
    }).compile();

    service = module.get<TodosService>(TodosService);
    todoRepo = module.get(getRepositoryToken(Todo));
  });

  afterEach(() => jest.clearAllMocks());

  // ── findAll ────────────────────────────────────────────
  describe('findAll', () => {
    it('userId + date >= yesterday 조건으로 QueryBuilder 호출', async () => {
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([makeTodo()]),
      };
      todoRepo.createQueryBuilder.mockReturnValue(mockQb as any);

      const result = await service.findAll('user-uuid-1');

      expect(mockQb.where).toHaveBeenCalledWith('todo.user_id = :userId', {
        userId: 'user-uuid-1',
      });
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        'todo.date >= :yesterday',
        expect.objectContaining({
          yesterday: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
      expect(result).toHaveLength(1);
    });

    it('date 오름차순, created_at 오름차순 정렬 적용', async () => {
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      todoRepo.createQueryBuilder.mockReturnValue(mockQb as any);

      await service.findAll('user-uuid-1');

      expect(mockQb.orderBy).toHaveBeenCalledWith('todo.date', 'ASC');
      expect(mockQb.addOrderBy).toHaveBeenCalledWith('todo.created_at', 'ASC');
    });
  });

  // ── create ─────────────────────────────────────────────
  describe('create', () => {
    it('user_id를 포함한 todo를 create 후 save', async () => {
      const todo = makeTodo();
      todoRepo.create.mockReturnValue(todo);
      todoRepo.save.mockResolvedValue(todo);

      const result = await service.create('user-uuid-1', {
        content: '이력서 작성',
        date: todo.date,
      });

      expect(todoRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '이력서 작성',
          user_id: 'user-uuid-1',
        }),
      );
      expect(todoRepo.save).toHaveBeenCalledWith(todo);
      expect(result).toEqual(todo);
    });
  });

  // ── update ─────────────────────────────────────────────
  describe('update', () => {
    it('본인 todo → Object.assign 후 save 호출', async () => {
      const todo = makeTodo({ is_done: false });
      todoRepo.findOne.mockResolvedValue(todo);
      todoRepo.save.mockImplementation(async (t) => t as Todo);

      const result = await service.update('user-uuid-1', 'todo-uuid-1', {
        is_done: true,
      });

      expect(todoRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'todo-uuid-1', user_id: 'user-uuid-1' },
      });
      expect(result.is_done).toBe(true);
      expect(todoRepo.save).toHaveBeenCalled();
    });

    it('다른 userId의 todo → NotFoundException (user_id 조건 미매칭 → null)', async () => {
      todoRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update('other-user-id', 'todo-uuid-1', { is_done: true }),
      ).rejects.toThrow(new NotFoundException('할 일을 찾을 수 없습니다.'));
    });

    it('존재하지 않는 id → NotFoundException', async () => {
      todoRepo.findOne.mockResolvedValue(null);
      await expect(
        service.update('user-uuid-1', 'nonexistent', { content: '수정' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── remove ─────────────────────────────────────────────
  describe('remove', () => {
    it('본인 todo → todoRepo.remove 호출 (hard delete)', async () => {
      const todo = makeTodo();
      todoRepo.findOne.mockResolvedValue(todo);
      todoRepo.remove.mockResolvedValue(todo);

      await service.remove('user-uuid-1', 'todo-uuid-1');

      expect(todoRepo.remove).toHaveBeenCalledWith(todo);
    });

    it('softRemove가 아닌 remove 사용 확인', async () => {
      const todo = makeTodo();
      todoRepo.findOne.mockResolvedValue(todo);
      todoRepo.remove.mockResolvedValue(todo);

      await service.remove('user-uuid-1', 'todo-uuid-1');

      expect(todoRepo.remove).toHaveBeenCalled();
      expect((todoRepo as any).softRemove).not.toHaveBeenCalled();
    });

    it('다른 userId의 todo → NotFoundException', async () => {
      todoRepo.findOne.mockResolvedValue(null);
      await expect(
        service.remove('other-user-id', 'todo-uuid-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── carryOver ──────────────────────────────────────────
  describe('carryOver', () => {
    it('date를 오늘 날짜(YYYY-MM-DD)로 업데이트 후 save', async () => {
      const todo = makeTodo({ date: '2025-01-01' });
      todoRepo.findOne.mockResolvedValue(todo);
      todoRepo.save.mockImplementation(async (t) => t as Todo);

      await service.carryOver('user-uuid-1', 'todo-uuid-1');

      const today = new Date().toISOString().split('T')[0];
      expect(todoRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ date: today }),
      );
    });

    it('date가 YYYY-MM-DD 형식으로 저장됨 (ISO string의 날짜 부분)', async () => {
      const todo = makeTodo({ date: '2020-06-15' });
      todoRepo.findOne.mockResolvedValue(todo);
      todoRepo.save.mockImplementation(async (t) => t as Todo);

      await service.carryOver('user-uuid-1', 'todo-uuid-1');

      const savedArg = (todoRepo.save as jest.Mock).mock.calls[0][0];
      expect(savedArg.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('다른 userId의 todo → NotFoundException', async () => {
      todoRepo.findOne.mockResolvedValue(null);
      await expect(
        service.carryOver('other-user-id', 'todo-uuid-1'),
      ).rejects.toThrow(new NotFoundException('할 일을 찾을 수 없습니다.'));
    });
  });
});
