import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicationCoverlettersService } from './application-coverletters.service';
import {
  CreateApplicationCoverletterDto,
  UpdateApplicationCoverletterDto,
} from './dto/coverletter.dto';

interface AuthUser {
  id: string;
  role: string;
}

@Controller('applications/:id/coverletters')
export class ApplicationCoverlettersController {
  constructor(private readonly service: ApplicationCoverlettersService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) applicationId: string,
  ) {
    return this.service.list(user.id, applicationId);
  }

  // 다른 카드들에서 답변 있는 자소서 문항 (재활용 — 같은 category 먼저 정렬)
  @Get('reuse-options')
  reuseOptions(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) applicationId: string,
    @Query('category') category?: string,
  ) {
    return this.service.reuseOptions(user.id, applicationId, category);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) applicationId: string,
    @Body() dto: CreateApplicationCoverletterDto,
  ) {
    return this.service.create(user.id, applicationId, dto);
  }

  @Patch(':clId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) applicationId: string,
    @Param('clId', ParseUUIDPipe) clId: string,
    @Body() dto: UpdateApplicationCoverletterDto,
  ) {
    return this.service.update(user.id, applicationId, clId, dto);
  }

  @Delete(':clId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) applicationId: string,
    @Param('clId', ParseUUIDPipe) clId: string,
  ) {
    return this.service.remove(user.id, applicationId, clId);
  }
}
