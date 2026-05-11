import { Body, Controller, Post } from '@nestjs/common';
import { IsNumber, IsString, Max, Min } from 'class-validator';
import { FilesService } from './files.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';

class PresignedUrlDto {
  @IsString() scope: string;
  @IsString() contentType: string;
  @IsNumber() @Min(1) @Max(10 * 1024 * 1024) fileSize: number;
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
}
