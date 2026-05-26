import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CoverletterSourceRefsService } from './coverletter-source-refs.service';
import { CreateCoverletterSourceRefDto } from './dto/coverletter-source-ref.dto';

interface AuthUser {
  id: string;
  role: string;
}

/**
 * F6 PR 1 — coverletter source_refs CRUD.
 *
 * route prefix `/coverletters/:clId/source-refs` — application context 불필요 (cl→app 체인은 service 가 IDOR 검증).
 * 별도 controller 로 분리 — `/applications/:id/coverletters` 은 ApplicationCoverlettersController.
 */
@Controller('coverletters/:clId/source-refs')
export class CoverletterSourceRefsController {
  constructor(private readonly service: CoverletterSourceRefsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param('clId', ParseUUIDPipe) clId: string,
  ) {
    return this.service.list(user.id, clId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('clId', ParseUUIDPipe) clId: string,
    @Body() dto: CreateCoverletterSourceRefDto,
  ) {
    return this.service.create(user.id, clId, dto);
  }

  @Delete(':refId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('clId', ParseUUIDPipe) clId: string,
    @Param('refId', ParseUUIDPipe) refId: string,
  ) {
    return this.service.remove(user.id, clId, refId);
  }
}
