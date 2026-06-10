import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { AdminInquiriesService } from './admin-inquiries.service';
import { AdminAuditService } from './admin-audit.service';
import { Inquiry } from '../inquiries/inquiry.entity';
import { User } from '../users/user.entity';

/**
 * PR_B2 Phase 4 — AdminInquiriesService spec 매트릭스 (~36 cases).
 *
 * 5축 — 정상 / 실패 / boundary / 보안 (admin role / IDOR) / 동시성 (row lock idempotent).
 */
const ADMIN = 'admin-uuid';
const ASSIGN_TARGET = 'admin-2-uuid';
const INQUIRY_ID = 'inq-uuid';
const CTX = { ip: '203.0.113.42', userAgent: 'UA' };

function makeInquiry(overrides: Partial<Inquiry> = {}): Inquiry {
  return {
    id: INQUIRY_ID,
    user_id: 'user-uuid',
    category: 'general',
    title: '제목',
    content: '내용',
    status: 'OPEN',
    user_unread: 0,
    admin_unread: 1,
    assignedTo: null,
    priority: 'medium' as const,
    slaDeadlineAt: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeAdmin(overrides: Partial<User> = {}): User {
  return { id: ASSIGN_TARGET, role: 'admin', ...overrides } as User;
}

describe('AdminInquiriesService', () => {
  let service: AdminInquiriesService;
  let inquiryRepo: jest.Mocked<Repository<Inquiry>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let dataSource: jest.Mocked<DataSource>;
  let manager: jest.Mocked<EntityManager>;
  let auditLog: jest.Mock;

  beforeEach(async () => {
    inquiryRepo = mock<Repository<Inquiry>>();
    userRepo = mock<Repository<User>>();
    manager = mock<EntityManager>();
    auditLog = jest.fn().mockResolvedValue(undefined);

    dataSource = mock<DataSource>();
    dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminInquiriesService,
        { provide: getRepositoryToken(Inquiry), useValue: inquiryRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: AdminAuditService, useValue: { log: auditLog } },
      ],
    }).compile();
    service = module.get(AdminInquiriesService);
  });

  // ── assignInquiry ──
  describe('assignInquiry', () => {
    it('정상 — 미할당 → admin 할당 + audit', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeInquiry()) // inquiry
        .mockResolvedValueOnce(makeAdmin()); // assignee user

      await service.assignInquiry(
        ADMIN,
        INQUIRY_ID,
        { assignedTo: ASSIGN_TARGET },
        CTX,
      );

      expect(manager.update).toHaveBeenCalledWith(
        Inquiry,
        { id: INQUIRY_ID },
        { assignedTo: ASSIGN_TARGET },
      );
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN,
        'assign_inquiry',
        'inquiry',
        INQUIRY_ID,
        expect.objectContaining({
          fromAssignedTo: null,
          toAssignedTo: ASSIGN_TARGET,
        }),
        manager,
        CTX,
      );
    });

    it('null assignedTo → unassign 처리', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeInquiry({ assignedTo: ASSIGN_TARGET }),
      );

      await service.assignInquiry(ADMIN, INQUIRY_ID, { assignedTo: null }, CTX);

      expect(manager.update).toHaveBeenCalledWith(
        Inquiry,
        { id: INQUIRY_ID },
        { assignedTo: null },
      );
      expect(auditLog).toHaveBeenCalled();
    });

    it('같은 사람 idempotent → audit X', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeInquiry({ assignedTo: ASSIGN_TARGET }),
      );

      await service.assignInquiry(
        ADMIN,
        INQUIRY_ID,
        { assignedTo: ASSIGN_TARGET },
        CTX,
      );

      expect(manager.update).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('inquiry 미존재 → NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.assignInquiry(
          ADMIN,
          'no-such',
          { assignedTo: ASSIGN_TARGET },
          CTX,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('assignedTo user 미존재 → BadRequestException', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeInquiry())
        .mockResolvedValueOnce(null);

      await expect(
        service.assignInquiry(
          ADMIN,
          INQUIRY_ID,
          { assignedTo: 'no-user' },
          CTX,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('assignedTo 가 admin 아니면 → ForbiddenException', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeInquiry())
        .mockResolvedValueOnce(makeAdmin({ role: 'user' }));

      await expect(
        service.assignInquiry(
          ADMIN,
          INQUIRY_ID,
          { assignedTo: ASSIGN_TARGET },
          CTX,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('audit ctx (IP/UA) 정확 전달', async () => {
      manager.findOne
        .mockResolvedValueOnce(makeInquiry())
        .mockResolvedValueOnce(makeAdmin());

      await service.assignInquiry(
        ADMIN,
        INQUIRY_ID,
        { assignedTo: ASSIGN_TARGET },
        CTX,
      );

      expect(auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        manager,
        CTX,
      );
    });
  });

  // ── setPriority ──
  describe('setPriority', () => {
    it('정상 priority 변경 (recalcSla 미지정) → SLA 보존 + audit', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeInquiry({ priority: 'medium' }),
      );

      await service.setPriority(ADMIN, INQUIRY_ID, { priority: 'high' }, CTX);

      expect(manager.update).toHaveBeenCalledWith(
        Inquiry,
        { id: INQUIRY_ID },
        { priority: 'high' },
      );
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN,
        'set_inquiry_priority',
        'inquiry',
        INQUIRY_ID,
        expect.objectContaining({
          fromPriority: 'medium',
          toPriority: 'high',
          recalcSla: false,
        }),
        manager,
        CTX,
      );
    });

    it('recalcSla=true + high → SLA = NOW + 4h', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeInquiry({ priority: 'medium' }),
      );

      await service.setPriority(
        ADMIN,
        INQUIRY_ID,
        { priority: 'high', recalcSla: true },
        CTX,
      );

      const updateCall = manager.update.mock.calls[0];
      const updates = updateCall[2] as Partial<Inquiry>;
      const deltaHours =
        (updates.slaDeadlineAt!.getTime() - Date.now()) / 3600000;
      expect(deltaHours).toBeGreaterThanOrEqual(3.99);
      expect(deltaHours).toBeLessThanOrEqual(4.01);
    });

    it('recalcSla=true + low → SLA = NOW + 72h', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeInquiry({ priority: 'medium' }),
      );

      await service.setPriority(
        ADMIN,
        INQUIRY_ID,
        { priority: 'low', recalcSla: true },
        CTX,
      );

      const updates = manager.update.mock.calls[0][2] as Partial<Inquiry>;
      const deltaHours =
        (updates.slaDeadlineAt!.getTime() - Date.now()) / 3600000;
      expect(deltaHours).toBeGreaterThanOrEqual(71.99);
      expect(deltaHours).toBeLessThanOrEqual(72.01);
    });

    it('같은 priority + recalcSla 미지정 → idempotent (audit X)', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeInquiry({ priority: 'medium' }),
      );

      await service.setPriority(ADMIN, INQUIRY_ID, { priority: 'medium' }, CTX);

      expect(manager.update).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('같은 priority + recalcSla=true → 변경 (SLA 갱신 의도)', async () => {
      manager.findOne.mockResolvedValueOnce(
        makeInquiry({ priority: 'medium' }),
      );

      await service.setPriority(
        ADMIN,
        INQUIRY_ID,
        { priority: 'medium', recalcSla: true },
        CTX,
      );

      expect(manager.update).toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalled();
    });

    it('inquiry 미존재 → NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(
        service.setPriority(ADMIN, INQUIRY_ID, { priority: 'high' }, CTX),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── setSla ──
  describe('setSla', () => {
    it('정상 — 미래 deadline + audit', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      manager.findOne.mockResolvedValueOnce(makeInquiry());

      await service.setSla(ADMIN, INQUIRY_ID, { deadlineAt: future }, CTX);

      expect(manager.update).toHaveBeenCalledWith(
        Inquiry,
        { id: INQUIRY_ID },
        { slaDeadlineAt: expect.any(Date) },
      );
      expect(auditLog).toHaveBeenCalledWith(
        ADMIN,
        'set_inquiry_sla',
        'inquiry',
        INQUIRY_ID,
        expect.objectContaining({
          fromSlaDeadlineAt: null,
        }),
        manager,
        CTX,
      );
    });

    it('과거 deadline → BadRequestException', async () => {
      await expect(
        service.setSla(
          ADMIN,
          INQUIRY_ID,
          { deadlineAt: '2020-01-01T00:00:00Z' },
          CTX,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('1년 초과 deadline → BadRequestException', async () => {
      const tooFar = new Date(Date.now() + 400 * 86400000).toISOString();
      await expect(
        service.setSla(ADMIN, INQUIRY_ID, { deadlineAt: tooFar }, CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('inquiry 미존재 → NotFoundException', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      const future = new Date(Date.now() + 86400000).toISOString();
      await expect(
        service.setSla(ADMIN, INQUIRY_ID, { deadlineAt: future }, CTX),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── getSlaOverdue / listAdmins / getNotificationBadges ──
  describe('getSlaOverdue', () => {
    it('overdue 쿼리 — NOW > deadline AND status != CLOSED, 정렬 asc', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([makeInquiry()]),
      };

      inquiryRepo.createQueryBuilder.mockReturnValue(qb as any);

      await service.getSlaOverdue();

      expect(qb.where).toHaveBeenCalledWith('i.sla_deadline_at IS NOT NULL');
      expect(qb.andWhere).toHaveBeenCalledWith('i.sla_deadline_at < NOW()');
      expect(qb.andWhere).toHaveBeenCalledWith('i.status != :closed', {
        closed: 'CLOSED',
      });
      expect(qb.orderBy).toHaveBeenCalledWith('i.sla_deadline_at', 'ASC');
    });
  });

  describe('listAdmins', () => {
    it('role=admin user 만 (id + nickname only)', async () => {
      userRepo.find.mockResolvedValue([
        { id: 'a1', nickname: '관리자1' } as User,
      ]);

      const r = await service.listAdmins();

      expect(userRepo.find).toHaveBeenCalledWith({
        where: { role: 'admin' },
        select: ['id', 'nickname'],
        order: { nickname: 'ASC' },
      });
      expect(r[0]).toEqual({ id: 'a1', nickname: '관리자1' });
    });
  });

  describe('getNotificationBadges', () => {
    it('4 badge count 동시 조회', async () => {
      inquiryRepo.count.mockResolvedValueOnce(10).mockResolvedValueOnce(3);
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(5),
      };

      inquiryRepo.createQueryBuilder.mockReturnValue(qb as any);

      const r = await service.getNotificationBadges();

      expect(r.inquiriesOpen).toBe(10);
      expect(r.inquiriesUnassigned).toBe(3);
      expect(r.slaOverdue).toBe(2);
      expect(r.adminUnread).toBe(5);
    });
  });
});
