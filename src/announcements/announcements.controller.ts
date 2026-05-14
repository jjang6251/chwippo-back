import { Controller, Get } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';
import { Public } from '../common/decorators/public.decorator';

@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly service: AnnouncementsService) {}

  @Public()
  @Get('active')
  getActive() {
    return this.service.getActive();
  }
}
