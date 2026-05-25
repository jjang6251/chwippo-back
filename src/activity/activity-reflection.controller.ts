import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../common/decorators/current-user.decorator';
import { ActivityReflectionService } from './activity-reflection.service';
import {
  CreateActivityReflectionDto,
  UpdateActivityReflectionDto,
} from './dto/reflection.dto';

@Controller()
export class ActivityReflectionController {
  constructor(private readonly service: ActivityReflectionService) {}

  @Get('activities/:activityId/reflections')
  findAll(
    @CurrentUser() user: CurrentUserPayload,
    @Param('activityId', ParseUUIDPipe) activityId: string,
  ) {
    return this.service.findAllForActivity(user.id, activityId);
  }

  @Post('activities/:activityId/reflections')
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Body() dto: CreateActivityReflectionDto,
  ) {
    return this.service.create(user.id, activityId, dto);
  }

  @Patch('activity-reflections/:refId')
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('refId', ParseUUIDPipe) refId: string,
    @Body() dto: UpdateActivityReflectionDto,
  ) {
    return this.service.update(user.id, refId, dto);
  }

  @Delete('activity-reflections/:refId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('refId', ParseUUIDPipe) refId: string,
  ) {
    return this.service.remove(user.id, refId);
  }
}
