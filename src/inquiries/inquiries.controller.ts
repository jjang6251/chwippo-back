import { Body, Controller, Post } from '@nestjs/common';
import { InquiriesService } from './inquiries.service';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

interface AuthUser { id: string }

@Controller('inquiries')
export class InquiriesController {
  constructor(private readonly inquiriesService: InquiriesService) {}

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateInquiryDto) {
    return this.inquiriesService.create(user.id, dto);
  }
}
