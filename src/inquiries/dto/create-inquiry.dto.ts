import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

const CATEGORIES = [
  '버그 신고',
  '기능 추가 요청',
  '기능 개선',
  '알림 문의',
  '계정·개인정보',
  '사용 방법 문의',
  '기타',
] as const;

export class CreateInquiryDto {
  @IsIn(CATEGORIES)
  category: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  content: string;
}
