import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Todo } from './todo.entity';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';

@Injectable()
export class TodosService {
  constructor(
    @InjectRepository(Todo)
    private readonly todoRepo: Repository<Todo>,
  ) {}

  async findAll(userId: string): Promise<Todo[]> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    return this.todoRepo
      .createQueryBuilder('todo')
      .where('todo.user_id = :userId', { userId })
      .andWhere('todo.date >= :yesterday', { yesterday: yesterdayStr })
      .orderBy('todo.date', 'ASC')
      .addOrderBy('todo.created_at', 'ASC')
      .getMany();
  }

  async create(userId: string, dto: CreateTodoDto): Promise<Todo> {
    const todo = this.todoRepo.create({ ...dto, user_id: userId });
    return this.todoRepo.save(todo);
  }

  async update(userId: string, id: string, dto: UpdateTodoDto): Promise<Todo> {
    const todo = await this.findOwned(userId, id);
    Object.assign(todo, dto);
    return this.todoRepo.save(todo);
  }

  async remove(userId: string, id: string): Promise<void> {
    const todo = await this.findOwned(userId, id);
    await this.todoRepo.remove(todo);
  }

  async carryOver(userId: string, id: string): Promise<Todo> {
    const todo = await this.findOwned(userId, id);
    const today = new Date().toISOString().split('T')[0];
    todo.date = today;
    return this.todoRepo.save(todo);
  }

  private async findOwned(userId: string, id: string): Promise<Todo> {
    const todo = await this.todoRepo.findOne({
      where: { id, user_id: userId },
    });
    if (!todo) throw new NotFoundException('할 일을 찾을 수 없습니다.');
    return todo;
  }
}
