import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { TodosService } from './todos.service';
import { CreateTodoDto } from './dto/create-todo.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

interface AuthUser { id: string }

@Controller('todos')
export class TodosController {
  constructor(private readonly todosService: TodosService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.todosService.findAll(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTodoDto) {
    return this.todosService.create(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTodoDto,
  ) {
    return this.todosService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.todosService.remove(user.id, id);
  }

  @Patch(':id/carry-over')
  carryOver(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.todosService.carryOver(user.id, id);
  }
}
