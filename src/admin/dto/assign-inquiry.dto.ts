import { IsOptional, IsUUID } from 'class-validator';

export class AssignInquiryDto {
  /** null = 미할당 처리 (unassign) */
  @IsOptional()
  @IsUUID()
  assignedTo: string | null;
}
