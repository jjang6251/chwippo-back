import { Body, Controller, Delete, HttpCode, Post } from '@nestjs/common';
import { IsNumber, IsString, IsUrl, Max, Min } from 'class-validator';
import { FilesService } from './files.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';

class PresignedUrlDto {
  @IsString() scope: string;
  @IsString() contentType: string;
  @IsNumber() @Min(1) @Max(10 * 1024 * 1024) fileSize: number;
}

class DeleteFileDto {
  @IsString() @IsUrl() fileUrl: string;
}

interface AuthUser {
  id: string;
}

@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('presigned-url')
  async getPresignedUrl(
    @CurrentUser() user: AuthUser,
    @Body() dto: PresignedUrlDto,
  ) {
    return this.filesService.createPresignedUrl(
      user.id,
      dto.scope,
      dto.contentType,
      dto.fileSize,
    );
  }

  /**
   * 본인이 업로드한 R2 파일 삭제.
   * 사용 사례: 프론트에서 R2 PUT 성공했지만 후속 myinfo 생성 mutation이 실패한 경우
   * (ValidationPipe 거부 등) — 클라이언트가 보상 호출로 고아 파일 cleanup.
   */
  @Delete()
  @HttpCode(204)
  async deleteOwnFile(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeleteFileDto,
  ) {
    await this.filesService.deleteOwnFile(user.id, dto.fileUrl);
  }
}
