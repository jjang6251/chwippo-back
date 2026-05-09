import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, ParseIntPipe } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateDailyNoteDto, UpdateDailyNoteDto } from './dto/daily-note.dto';

interface AuthUser { id: string }

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

  @Get('daily-notes')
  async getDailyNotes(
    @CurrentUser() user: AuthUser,
    @Query('date') date?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.calendarService.getDailyNotes(user.id, { date, startDate, endDate });
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
