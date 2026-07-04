import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { NotificationsService } from './notifications.service';
import { Notification } from './notification.entity';

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notif-1',
    userId: 'user-1',
    type: 'briefing',
    title: '제목',
    body: '본문',
    deepLink: null,
    payload: null,
    read: false,
    createdAt: new Date('2026-07-04T00:00:00Z'),
    ...overrides,
  };
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let repo: jest.Mocked<Repository<Notification>>;
  let qb: jest.Mocked<SelectQueryBuilder<Notification>>;

  beforeEach(async () => {
    repo = mock<Repository<Notification>>();
    qb = mock<SelectQueryBuilder<Notification>>();
    qb.where.mockReturnThis();
    qb.andWhere.mockReturnThis();
    qb.orderBy.mockReturnThis();
    qb.take.mockReturnThis();
    repo.createQueryBuilder.mockReturnValue(qb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Notification), useValue: repo },
      ],
    }).compile();
    service = module.get(NotificationsService);
  });

  describe('list', () => {
    it('20개 이하 → nextCursor null + unreadCount 포함', async () => {
      const rows = Array.from({ length: 5 }, (_, i) =>
        makeNotification({ id: `n${i}` }),
      );
      qb.getMany.mockResolvedValue(rows);
      repo.count.mockResolvedValue(2);

      const result = await service.list('user-1');

      expect(result.items).toHaveLength(5);
      expect(result.nextCursor).toBeNull();
      expect(result.unreadCount).toBe(2);
    });

    it('21개 (PAGE_SIZE+1) → 20개만 반환 + nextCursor = 20번째 createdAt', async () => {
      const rows = Array.from({ length: 21 }, (_, i) =>
        makeNotification({
          id: `n${i}`,
          createdAt: new Date(Date.UTC(2026, 6, 4, 0, 0, i)),
        }),
      );
      qb.getMany.mockResolvedValue(rows);
      repo.count.mockResolvedValue(0);

      const result = await service.list('user-1');

      expect(result.items).toHaveLength(20);
      expect(result.nextCursor).toBe(rows[19].createdAt.toISOString());
    });

    it('cursor 전달 → created_at < cursor andWhere 적용', async () => {
      qb.getMany.mockResolvedValue([]);
      repo.count.mockResolvedValue(0);
      const cursor = '2026-07-01T00:00:00.000Z';

      await service.list('user-1', cursor);

      expect(qb.andWhere).toHaveBeenCalledWith('n.created_at < :cursor', {
        cursor: new Date(cursor),
      });
    });

    it('잘못된 cursor → andWhere 미적용 (첫 페이지처럼)', async () => {
      qb.getMany.mockResolvedValue([]);
      repo.count.mockResolvedValue(0);

      await service.list('user-1', 'not-a-date');

      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('unreadCount', () => {
    it('read=false 조건으로 count', async () => {
      repo.count.mockResolvedValue(7);
      const n = await service.unreadCount('user-1');
      expect(n).toBe(7);
      expect(repo.count).toHaveBeenCalledWith({
        where: { userId: 'user-1', read: false },
      });
    });
  });

  describe('markRead', () => {
    it('정상 → read=true save', async () => {
      const notif = makeNotification({ read: false });
      repo.findOne.mockResolvedValue(notif);

      await service.markRead('user-1', 'notif-1');

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ read: true }),
      );
    });

    it('없는 id → NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.markRead('user-1', 'x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('다른 사용자 알림 → ForbiddenException (IDOR)', async () => {
      repo.findOne.mockResolvedValue(
        makeNotification({ userId: 'other-user' }),
      );
      await expect(service.markRead('user-1', 'notif-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('이미 read → idempotent (save 안 함)', async () => {
      repo.findOne.mockResolvedValue(makeNotification({ read: true }));
      await service.markRead('user-1', 'notif-1');
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('markAllRead', () => {
    it('본인 read=false 전부 read=true', async () => {
      await service.markAllRead('user-1');
      expect(repo.update).toHaveBeenCalledWith(
        { userId: 'user-1', read: false },
        { read: true },
      );
    });
  });

  describe('create', () => {
    it('manager 없이 → 기본 repo 사용', async () => {
      repo.create.mockImplementation((x) => x as Notification);
      repo.save.mockImplementation(async (x) => x as Notification);

      await service.create({
        userId: 'user-1',
        type: 'briefing',
        title: 't',
        body: 'b',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          deepLink: null,
          payload: null,
          read: false,
        }),
      );
    });
  });
});
