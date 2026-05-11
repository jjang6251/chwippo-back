import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { InquiriesService } from './inquiries.service';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsString, MinLength, MaxLength } from 'class-validator';

interface AuthUser {
  id: string;
}

class AddCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;
}

@Controller('inquiries')
export class InquiriesController {
  constructor(private readonly inquiriesService: InquiriesService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateInquiryDto) {
    return this.inquiriesService.create(user.id, dto);
  }

  @Get()
  findMyInquiries(@CurrentUser() user: AuthUser) {
    return this.inquiriesService.findByUser(user.id);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.inquiriesService.findOneByUser(id, user.id);
  }

  @Post(':id/comments')
  addComment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddCommentDto,
  ) {
    return this.inquiriesService.addUserComment(id, user.id, dto.content);
  }
}
