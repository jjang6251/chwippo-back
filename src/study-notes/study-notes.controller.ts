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
} from '@nestjs/common';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../common/decorators/current-user.decorator';
import {
  CreateStudyNoteFolderDto,
  UpdateStudyNoteFolderDto,
} from './dto/study-note-folder.dto';
import { CreateStudyNoteDto, UpdateStudyNoteDto } from './dto/study-note.dto';
import { StudyNoteFoldersService } from './study-note-folders.service';
import { StudyNotesService } from './study-notes.service';

/**
 * 공부 노트 허브 — 노트·폴더·「회사 준비」 목록을 한 프리픽스 아래 둔다.
 *
 * 🔴 **선언 순서가 곧 매칭 순서다.** `folders`·`hub` 같은 정적 경로는 반드시
 * `:id` 보다 **위에** 있어야 한다. 아래로 내려가면 `/study-notes/folders` 가
 * `:id` 에 먹혀 (ParseUUIDPipe 때문에) 400 으로 떨어진다.
 *
 * 전 라우트 JWT 필수(전역 가드) + 서비스가 `user_id` 로 다시 잠근다.
 */
@Controller('study-notes')
export class StudyNotesController {
  constructor(
    private readonly notes: StudyNotesService,
    private readonly folders: StudyNoteFoldersService,
  ) {}

  // ── 폴더 (정적 경로 — :id 보다 위) ──

  @Get('folders')
  listFolders(@CurrentUser() user: CurrentUserPayload) {
    return this.folders.list(user.id);
  }

  @Post('folders')
  createFolder(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateStudyNoteFolderDto,
  ) {
    return this.folders.create(user.id, dto);
  }

  @Patch('folders/:folderId')
  updateFolder(
    @CurrentUser() user: CurrentUserPayload,
    @Param('folderId', ParseUUIDPipe) folderId: string,
    @Body() dto: UpdateStudyNoteFolderDto,
  ) {
    return this.folders.update(user.id, folderId, dto);
  }

  @Delete('folders/:folderId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeFolder(
    @CurrentUser() user: CurrentUserPayload,
    @Param('folderId', ParseUUIDPipe) folderId: string,
  ) {
    return this.folders.remove(user.id, folderId);
  }

  // ── 허브의 「회사 준비」 (정적 경로 — :id 보다 위) ──

  @Get('hub/prep')
  hubPrep(@CurrentUser() user: CurrentUserPayload) {
    return this.notes.hubPrep(user.id);
  }

  // ── 노트 ──

  @Get()
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.notes.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateStudyNoteDto,
  ) {
    return this.notes.create(user.id, dto);
  }

  @Get(':id')
  get(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notes.get(user.id, id);
  }

  @Get(':id/backlinks')
  backlinks(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notes.backlinks(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudyNoteDto,
  ) {
    return this.notes.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notes.remove(user.id, id);
  }
}
