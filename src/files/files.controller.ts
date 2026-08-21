import { Body, Controller, Delete, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsNumber, IsString, IsUrl, Max, Min } from 'class-validator';
import { FilesService } from './files.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * 발급 한도 (2026-08-21 · 공부 노트 이미지 아크).
 *
 * ## 왜 거는가 — **발급받아 올리고 등록만 안 하면 용량에 안 잡힌다**
 *
 * 100MB cap 은 DB 행을 센다. 그런데 R2 PUT 은 발급만 받으면 되고 등록(`POST
 * /study-notes/:id/attachments` · myinfo mutation)은 **안 해도 그만**이다 — 그렇게 올린
 * 객체는 어느 합계에도 안 잡히고, 고아를 치우는 크론도 없다. 전역 100회/분만 걸려 있어
 * 이론상 분당 1GB 가 버킷에 쌓인다.
 *
 * ## 이건 **속도 제한이지 해결이 아니다**
 *
 * 진짜 해결은 고아 sweep 이고 그건 별개 작업이다 (잘못 만들면 멀쩡한 사용자 파일을
 * 지운다 — dry-run 관찰 기간이 필요하다). 여기서는 피해 규모만 1/3 로 줄인다.
 *
 * ## 🔴 키가 **사용자가 아니라 IP** 다
 *
 * `CfThrottlerGuard` 는 `cf-connecting-ip` 로 키를 만든다 (2026-07-24 운영 실측 — CF→Railway
 * 체인에서 `req.ip` 가 이그레스 IP 로 잡히던 문제의 처방). 그래서 같은 망을 쓰는 사람들이
 * 한도를 나눠 쓴다 — 모바일 캐리어 NAT 이 대표적이다. 30 은 그 점을 감안한 값이다:
 * 사진 30장을 1분에 넣는 정상 사용은 드물고, 여럿이 같은 IP 에서 동시에 올려도 잘 안 닿는다.
 * 사용자 단위로 걸려면 전역 guard 의 키를 바꿔야 하는데 그건 전 엔드포인트에 영향을 준다.
 */
const PRESIGN_LIMIT_PER_MIN = 30;

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
  @Throttle({ default: { ttl: 60_000, limit: PRESIGN_LIMIT_PER_MIN } })
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
