import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicationsService } from './applications.service';
import {
  CommitFromPostingDto,
  CreateFromPostingDto,
  UpdatePostingMetaDto,
} from './dto/job-posting-card.dto';
import { JobPostingCardService } from './job-posting-card.service';

interface AuthUser {
  id: string;
  role: string;
}

/**
 * 공고 붙여넣기 → 카드 (대장 21).
 *
 *   POST  /applications/from-posting          원문 → 파싱 → 카드 (또는 보완 질문 봉투)
 *   POST  /applications/from-posting/commit   보완 답변(회사명·직무) → 카드 (LLM 미호출)
 *   GET   /applications/from-posting/pending  보완 대기 초안 (새로고침 복원)
 *   PATCH /applications/:id/posting-meta      「좋아요」·[확인]·인라인 수정 기록
 *
 * ## 🔴 라우트 순서 — 이 컨트롤러가 `ApplicationsController` **앞**에 등록돼야 한다
 *
 * `ApplicationsController` 에 `@Get(':id')` 가 있어서, 뒤에 등록되면
 * `GET /applications/from-posting/pending` 이 `:id = 'from-posting'` 으로 먼저 잡히고
 * `ParseUUIDPipe` 가 400 을 던진다. Nest 는 **모듈의 `controllers` 배열 순서**로 라우트를
 * 등록하므로 순서가 곧 계약이다 (`applications.module.ts` 주석 + E2E 가 지킨다).
 *
 * ## 남용 상한 — 사용자 체감 제한이 아니다
 *
 * 분당 10회. 사람이 공고를 읽고 붙여넣는 속도로는 절대 안 닿고(동시 3장이 상한),
 * 스크립트는 여기서 멈춘다. 진짜 한도는 admin `feature_quota_configs`(일 200) 이며
 * 그쪽은 **끄는 스위치**(enabled)도 겸한다.
 */
@Controller('applications')
export class JobPostingCardController {
  constructor(
    private readonly service: JobPostingCardService,
    private readonly applications: ApplicationsService,
  ) {}

  @Post('from-posting')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateFromPostingDto) {
    return this.service.parseAndCreate(user.id, dto);
  }

  @Post('from-posting/commit')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  commit(@CurrentUser() user: AuthUser, @Body() dto: CommitFromPostingDto) {
    return this.service.commitDraft(user.id, dto);
  }

  @Get('from-posting/pending')
  pending(@CurrentUser() user: AuthUser) {
    return this.service.listPending(user.id);
  }

  @Patch(':id/posting-meta')
  updatePostingMeta(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePostingMetaDto,
  ) {
    return this.applications.updatePostingMeta(user.id, id, dto);
  }
}
