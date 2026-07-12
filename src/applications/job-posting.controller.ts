import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JobPostingService } from './job-posting.service';
import { ParseJobPostingDto, UpdateJobPostingDto } from './dto/job-posting.dto';

interface AuthUser {
  id: string;
  role: string;
}

/**
 * 공고 요건 파싱 (jobposting-parse) — 카드 단위 endpoint.
 *
 *   POST   /applications/:id/job-posting/parse — 원문 붙여넣기 → LLM 파싱 → 저장
 *   PATCH  /applications/:id/job-posting        — 사용자 수동 수정 (LLM 미경유)
 *   DELETE /applications/:id/job-posting        — 삭제 (NULL)
 *
 * 상세 조회(jobPosting 포함)는 기존 GET /applications/:id 응답에 들어간다.
 */
@Controller('applications/:id/job-posting')
export class JobPostingController {
  constructor(private readonly service: JobPostingService) {}

  @Post('parse')
  parse(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ParseJobPostingDto,
  ) {
    return this.service.parse(user.id, id, dto);
  }

  @Patch()
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobPostingDto,
  ) {
    return this.service.update(user.id, id, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(user.id, id);
  }
}
