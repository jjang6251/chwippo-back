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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  CreateStepNoteSheetDto,
  UpdateStepNoteSheetDto,
} from './dto/step-note-sheet.dto';
import { StepNoteSheetsService } from './step-note-sheets.service';

interface AuthUser {
  id: string;
  role: string;
}

/**
 * 준비 노트 다중 시트 — 기존 체크리스트와 같은 프리픽스 아래에 둔다
 * (`applications/:id/steps/:stepId/...`). 소유권 체인이 URL 에 그대로 드러나야
 * 서비스가 3-hop 을 빠짐없이 검증한다.
 */
@Controller('applications/:id/steps/:stepId/note-sheets')
export class StepNoteSheetsController {
  constructor(private readonly service: StepNoteSheetsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
  ) {
    return this.service.list(user.id, id, stepId);
  }

  /**
   * 201 = 새로 만들었다 / 200 = `ifEmpty` 가드에 걸려 **기존 첫 시트를 그대로 돌려줬다**.
   * 프론트는 이 차이로 "승격이 방금 일어났는지" 를 알 수 있고, 200 이면 재시도를 멈춘다.
   */
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: CreateStepNoteSheetDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { sheet, created } = await this.service.create(
      user.id,
      id,
      stepId,
      dto,
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return sheet;
  }

  @Patch(':sheetId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Param('sheetId', ParseUUIDPipe) sheetId: string,
    @Body() dto: UpdateStepNoteSheetDto,
  ) {
    return this.service.update(user.id, id, stepId, sheetId, dto);
  }

  @Delete(':sheetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Param('sheetId', ParseUUIDPipe) sheetId: string,
  ) {
    return this.service.remove(user.id, id, stepId, sheetId);
  }
}
