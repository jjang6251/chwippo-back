/**
 * AdminAnnouncementsController — 공지 CRUD 시 audit log 호출 검증
 *
 * 시나리오:
 * - create → publish_announcement audit (title·type·active detail)
 * - update → update_announcement audit (changed keys detail)
 * - remove → delete_announcement audit (empty detail)
 */
import { Test } from '@nestjs/testing';
import { AdminAnnouncementsController } from './admin-announcements.controller';
import { AnnouncementsService } from './announcements.service';
import { AdminAuditService } from '../admin/admin-audit.service';

describe('AdminAnnouncementsController — audit 호출', () => {
  let controller: AdminAnnouncementsController;
  const service = {
    findAll: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const auditService = { log: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [AdminAnnouncementsController],
      providers: [
        { provide: AnnouncementsService, useValue: service },
        { provide: AdminAuditService, useValue: auditService },
      ],
    }).compile();
    controller = module.get(AdminAnnouncementsController);
  });

  describe('create', () => {
    it("publish 후 auditService.log('publish_announcement') 호출", async () => {
      service.create.mockResolvedValue({ id: 'a1', title: '점검 안내' });
      const dto = {
        title: '점검 안내',
        body: '내일 03시 점검',
        type: 'banner' as const,
        active: true,
      };
      await controller.create({ id: 'admin-1' }, dto);
      expect(service.create).toHaveBeenCalledWith(dto);
      expect(auditService.log).toHaveBeenCalledWith(
        'admin-1',
        'publish_announcement',
        'announcement',
        'a1',
        { title: '점검 안내', type: 'banner', active: true },
      );
    });
  });

  describe('update', () => {
    it("update 후 auditService.log('update_announcement') 호출 + changed keys", async () => {
      service.update.mockResolvedValue({ id: 'a1' });
      await controller.update({ id: 'admin-1' }, 'a1', {
        active: false,
        title: '갱신',
      });
      expect(auditService.log).toHaveBeenCalledWith(
        'admin-1',
        'update_announcement',
        'announcement',
        'a1',
        { changed: expect.arrayContaining(['active', 'title']) as unknown },
      );
    });
  });

  describe('remove', () => {
    it("delete 후 auditService.log('delete_announcement') 호출", async () => {
      service.remove.mockResolvedValue(undefined);
      await controller.remove({ id: 'admin-1' }, 'a1');
      expect(service.remove).toHaveBeenCalledWith('a1');
      expect(auditService.log).toHaveBeenCalledWith(
        'admin-1',
        'delete_announcement',
        'announcement',
        'a1',
        {},
      );
    });
  });
});
