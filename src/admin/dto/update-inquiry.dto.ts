import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateInquiryDto {
  @IsIn(['PENDING', 'IN_PROGRESS', 'RESOLVED'])
  status: string;

  @IsOptional()
  @IsString()
  adminReply?: string;
}
