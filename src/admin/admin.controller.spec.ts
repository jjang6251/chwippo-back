/**
 * AdminController — 문의 close·답변 시 audit log 호출 검증
 *
 * 시나리오:
 * - closeInquiry 호출 → InquiriesService.closeInquiry + audit log 'close_inquiry'
 * - addComment 호출 → InquiriesService.addAdminComment + audit log 'reply_inquiry' (contentLength만, 본문 평문 저장 X)
 */
import { Test } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAuditService } from './admin-audit.service';
import { InquiriesService } from '../inquiries/inquiries.service';

describe('AdminController — audit 호출', () => {
  let controller: AdminController;
  const inquiriesService = {
    addAdminComment: jest.fn(),
    closeInquiry: jest.fn(),
    findAll: jest.fn(),
    findOneAdmin: jest.fn(),
  };
  const auditService = { log: jest.fn() };
  const adminService = { getStats: jest.fn(), getAnalytics: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: adminService },
        { provide: InquiriesService, useValue: inquiriesService },
        { provide: AdminAuditService, useValue: auditService },
      ],
    }).compile();
    controller = module.get(AdminController);
  });

  describe('addComment (어드민 문의 답변)', () => {
    it("답변 작성 후 auditService.log('reply_inquiry') 호출", async () => {
      inquiriesService.addAdminComment.mockResolvedValue({ id: 'c1' });
      await controller.addComment({ id: 'admin-1' }, 'inquiry-1', {
        content: '답변입니다',
      });
      expect(inquiriesService.addAdminComment).toHaveBeenCalledWith(
        'inquiry-1',
        'admin-1',
        '답변입니다',
      );
      expect(auditService.log).toHaveBeenCalledWith(
        'admin-1',
        'reply_inquiry',
        'inquiry',
        'inquiry-1',
        { contentLength: 5 },
      );
    });

    it('audit 본문에 평문 content 저장 X (privacy)', async () => {
      inquiriesService.addAdminComment.mockResolvedValue({ id: 'c1' });
      const secret = '사용자에게만 보낼 민감한 답변';
      await controller.addComment({ id: 'admin-1' }, 'inquiry-1', {
        content: secret,
      });
      const auditCall = auditService.log.mock.calls[0] as unknown[];
      const detail = auditCall[4] as Record<string, unknown>;
      expect(detail.contentLength).toBe(secret.length);
      // content 키 자체가 없어야 함
      expect(detail).not.toHaveProperty('content');
    });
  });

  describe('closeInquiry', () => {
    it("close 후 auditService.log('close_inquiry') 호출", async () => {
      inquiriesService.closeInquiry.mockResolvedValue({
        id: 'inquiry-1',
        status: 'CLOSED',
      });
      await controller.closeInquiry({ id: 'admin-1' }, 'inquiry-1');
      expect(inquiriesService.closeInquiry).toHaveBeenCalledWith('inquiry-1');
      expect(auditService.log).toHaveBeenCalledWith(
        'admin-1',
        'close_inquiry',
        'inquiry',
        'inquiry-1',
        {},
      );
    });
  });
});
