import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ExamSchedulesService } from './exam-schedules.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  CreateExamScheduleDto,
  UpdateExamScheduleDto,
  ConvertExamToCertDto,
} from './dto/exam-schedule.dto';

interface AuthUser {
  id: string;
}

@Controller('myinfo/exam-schedules')
export class ExamSchedulesController {
  constructor(private readonly service: ExamSchedulesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateExamScheduleDto) {
    return this.service.create(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateExamScheduleDto,
  ) {
    return this.service.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.id, id);
  }

  @Post(':id/convert-to-cert')
  convertToCert(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConvertExamToCertDto,
  ) {
    return this.service.convertToCert(user.id, id, dto);
  }
}
