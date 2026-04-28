import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Inquiry } from './inquiry.entity';
import { InquiryComment } from './inquiry-comment.entity';
import { InquiriesService } from './inquiries.service';
import { InquiriesController } from './inquiries.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Inquiry, InquiryComment])],
  controllers: [InquiriesController],
  providers: [InquiriesService],
  exports: [InquiriesService],
})
export class InquiriesModule {}
