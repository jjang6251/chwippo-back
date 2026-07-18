import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Notification } from './notification.entity';
import type { NotificationType } from './notification.types';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  deepLink?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface NotificationListResult {
  items: Notification[];
  /** 다음 페이지 커서 (마지막 항목 createdAt ISO) · null = 끝 */
  nextCursor: string | null;
  unreadCount: number;
}

const PAGE_SIZE = 20;

/**
 * 인앱 알림 센터 — 목록·읽음·생성.
 * 생성은 cron/admin 이 push 와 함께 호출 (manager 인자로 같은 TX 동참 가능).
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
  ) {}

  /**
   * 최신순 목록 (cursor 페이지네이션) + 안 읽음 카운트.
   * @param cursor 이전 페이지 마지막 항목 createdAt ISO (미지정 = 첫 페이지)
   * @param type 유형 필터 (미지정 = 전체). 커서 페이지네이션과 조합 시 서버에서 필터 적용.
   *
   * unreadCount 는 type 필터와 무관하게 항상 전체 미읽음 — 헤더 종 배지 의미(전체 안 읽음) 보존.
   */
  async list(
    userId: string,
    cursor?: string,
    type?: NotificationType,
  ): Promise<NotificationListResult> {
    const qb = this.repo
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId })
      .orderBy('n.created_at', 'DESC')
      .take(PAGE_SIZE + 1);

    if (type) {
      qb.andWhere('n.type = :type', { type });
    }

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!isNaN(cursorDate.getTime())) {
        qb.andWhere('n.created_at < :cursor', { cursor: cursorDate });
      }
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > PAGE_SIZE;
    const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore
      ? items[items.length - 1].createdAt.toISOString()
      : null;

    // 필터와 무관하게 전체 미읽음 (종 배지 의미 유지)
    const unreadCount = await this.unreadCount(userId);

    return { items, nextCursor, unreadCount };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.repo.count({ where: { userId, read: false } });
  }

  /** 단건 읽음 처리 — 다른 사용자 것이면 Forbidden (IDOR), 없으면 404 */
  async markRead(userId: string, id: string): Promise<void> {
    const notification = await this.repo.findOne({ where: { id } });
    if (!notification) {
      throw new NotFoundException('알림을 찾을 수 없습니다.');
    }
    if (notification.userId !== userId) {
      throw new ForbiddenException('다른 사용자의 알림입니다.');
    }
    if (notification.read) return; // idempotent
    notification.read = true;
    await this.repo.save(notification);
  }

  /** 본인 안 읽음 전부 읽음 처리 */
  async markAllRead(userId: string): Promise<void> {
    await this.repo.update({ userId, read: false }, { read: true });
  }

  /**
   * 알림 생성 (cron/admin 내부 호출).
   * manager 전달 시 그 TX 안에서 insert (발송 원자성).
   */
  async create(
    input: CreateNotificationInput,
    manager?: EntityManager,
  ): Promise<Notification> {
    const repo = manager ? manager.getRepository(Notification) : this.repo;
    const notification = repo.create({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      deepLink: input.deepLink ?? null,
      payload: input.payload ?? null,
      read: false,
    });
    return repo.save(notification);
  }
}
