import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  NotificationsService,
  NotificationListResult,
} from './notifications.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';

interface AuthUser {
  id: string;
}

/**
 * 인앱 알림 센터.
 *   GET   /notifications           목록 (cursor 페이지네이션) + 안 읽음 카운트
 *   PATCH /notifications/read-all  전체 읽음
 *   PATCH /notifications/:id/read  단건 읽음 (IDOR 가드)
 *
 * ⚠️ read-all 라우트는 :id/read 보다 먼저 선언 (경로 충돌 방지).
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<NotificationListResult> {
    return this.service.list(user.id, query.cursor, query.type);
  }

  @Patch('read-all')
  @HttpCode(204)
  async markAllRead(@CurrentUser() user: AuthUser): Promise<void> {
    await this.service.markAllRead(user.id);
  }

  @Patch(':id/read')
  @HttpCode(204)
  async markRead(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.markRead(user.id, id);
  }
}
