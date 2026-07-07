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
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../common/decorators/current-user.decorator';
import { NoteSummaryService } from '../ai/note-summary.service';
import { ActivityLogService } from './activity-log.service';
import { CreateActivityLogDto } from './dto/create-activity-log.dto';
import { QuickCreateActivityLogDto } from './dto/quick-create-activity-log.dto';
import { UpdateActivityLogDto } from './dto/update-activity-log.dto';
import { SummarizeNoteDto } from './dto/summarize-note.dto';

@Controller()
export class ActivityLogController {
  constructor(
    private readonly service: ActivityLogService,
    private readonly noteSummary: NoteSummaryService,
  ) {}

  @Get('activities/:activityId/logs')
  findAll(
    @CurrentUser() user: CurrentUserPayload,
    @Param('activityId', ParseUUIDPipe) activityId: string,
  ) {
    return this.service.findAllForActivity(user.id, activityId);
  }

  @Post('activities/:activityId/logs')
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Body() dto: CreateActivityLogDto,
  ) {
    return this.service.create(user.id, activityId, dto);
  }

  /** activity-redesign — 퀵캡처 (활동 미지정 → 기본함 · isRest 멱등) */
  @Post('activity-logs')
  quickCreate(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: QuickCreateActivityLogDto,
  ) {
    return this.service.quickCreate(user.id, dto);
  }

  /** activity-redesign — 유저 전체 날짜 타임라인 (keyset cursor) */
  @Get('activity-logs')
  timeline(
    @CurrentUser() user: CurrentUserPayload,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.timeline(user.id, cursor);
  }

  @Patch('activity-logs/:logId')
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('logId', ParseUUIDPipe) logId: string,
    @Body() dto: UpdateActivityLogDto,
  ) {
    return this.service.update(user.id, logId, dto);
  }

  @Delete('activity-logs/:logId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('logId', ParseUUIDPipe) logId: string,
  ) {
    return this.service.remove(user.id, logId);
  }

  @Post('activity-logs/:logId/archive')
  @HttpCode(HttpStatus.OK)
  archiveLog(
    @CurrentUser() user: CurrentUserPayload,
    @Param('logId', ParseUUIDPipe) logId: string,
  ) {
    return this.service.archiveLog(user.id, logId);
  }

  @Post('activity-logs/:logId/unarchive')
  @HttpCode(HttpStatus.OK)
  unarchiveLog(
    @CurrentUser() user: CurrentUserPayload,
    @Param('logId', ParseUUIDPipe) logId: string,
  ) {
    return this.service.unarchiveLog(user.id, logId);
  }

  @Post('activity-logs/:logId/summarize')
  @HttpCode(HttpStatus.OK)
  summarize(
    @CurrentUser() user: CurrentUserPayload,
    @Param('logId', ParseUUIDPipe) logId: string,
    @Body() dto: SummarizeNoteDto,
  ) {
    return this.noteSummary.summarize(user.id, logId, { force: dto.force });
  }

  /**
   * 5.6.8 — 노트별 요약 잔여 횟수 조회 (mount 시 항상 표시용).
   * summarize 호출 안 했어도 perNoteUsed/perNoteLimit 알려줌.
   */
  @Get('activity-logs/:logId/summarize-status')
  summarizeStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param('logId', ParseUUIDPipe) logId: string,
  ) {
    return this.noteSummary.getStatus(user.id, logId);
  }
}
