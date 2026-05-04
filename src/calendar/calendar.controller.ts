import { Controller, Get, Query, ParseIntPipe } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';

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
}
