import { IsNumber, IsString, IsUrl, Max, Min } from 'class-validator';

/**
 * 첨부 한 장의 상한 — presigned 발급(`FilesService`) 과 **같은 10MB**.
 * 한쪽만 통과시키면 R2 에는 올라갔는데 등록에서 막히는 고아 파일이 생긴다.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * R2 PUT 이 끝난 뒤 보내는 등록 요청.
 *
 * `fileSizeBytes` 는 클라이언트가 말하는 값이라 **믿는 값이 아니라 청구하는 값**이다 —
 * 실제 객체 크기와 다르면 용량 합산만 어긋난다 (presigned 가 `ContentLength` 를 서명에
 * 실어 PUT 자체를 잠그므로, 여기서 거짓말해도 R2 에 더 큰 파일을 올릴 수는 없다).
 */
export class CreateNoteAttachmentDto {
  @IsString()
  @IsUrl()
  fileUrl: string;

  @IsNumber()
  @Min(1)
  @Max(MAX_ATTACHMENT_BYTES)
  fileSizeBytes: number;
}
