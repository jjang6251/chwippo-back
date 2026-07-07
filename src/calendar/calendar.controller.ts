import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateDailyNoteDto, UpdateDailyNoteDto } from './dto/daily-note.dto';

interface AuthUser {
  id: string;
}

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get('events')
  async getEvents(
    @CurrentUser() user: AuthUser,
    @Query('year', ParseIntPipe) year: number,
    @Query('month', ParseIntPipe) month: number,
  ) {
    return this.calendarService.getMonthEvents(user.id, year, month);
  }

  /** A3 — 오늘 할 일 자동 합류: D-3 이내 스텝의 미완 체크리스트 (read-through) */
  @Get('urgent-checklist')
  async getUrgentChecklist(@CurrentUser() user: AuthUser) {
    return this.calendarService.getUrgentChecklist(user.id);
  }

  @Get('daily-notes')
  async getDailyNotes(
    @CurrentUser() user: AuthUser,
    @Query('date') date?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    // LRR P1T3 PR K L-3 — YYYY-MM-DD 형식 검증 (raw SQL 파라미터로 가나 invalid 입력 시 500 → 400으로 전환)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    for (const [name, val] of [
      ['date', date],
      ['startDate', startDate],
      ['endDate', endDate],
    ] as const) {
      if (val !== undefined && !datePattern.test(val)) {
        throw new BadRequestException(
          `${name}는 YYYY-MM-DD 형식이어야 합니다.`,
        );
      }
    }
    // LRR P1T3 PR K L-2 — 날짜 범위 31일 cap (정상 사용 월 단위에 여유, 무한 범위 부하 차단)
    if (startDate && endDate) {
      const days =
        (new Date(endDate).getTime() - new Date(startDate).getTime()) /
        86400000;
      if (days < 0) {
        throw new BadRequestException('endDate가 startDate 이전입니다.');
      }
      if (days > 31) {
        throw new BadRequestException('날짜 범위는 31일 이내여야 합니다.');
      }
    }
    return this.calendarService.getDailyNotes(user.id, {
      date,
      startDate,
      endDate,
    });
  }

  @Post('daily-notes')
  async createDailyNote(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateDailyNoteDto,
  ) {
    return this.calendarService.createDailyNote(user.id, dto);
  }

  @Patch('daily-notes/:id/carry-over')
  async carryOverDailyNote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.calendarService.carryOverDailyNote(user.id, id);
  }

  @Patch('daily-notes/:id')
  async updateDailyNote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDailyNoteDto,
  ) {
    return this.calendarService.updateDailyNote(user.id, id, dto);
  }

  @Delete('daily-notes/:id')
  async deleteDailyNote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.calendarService.deleteDailyNote(user.id, id);
  }
}
