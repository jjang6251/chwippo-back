/**
 * AdminController — 문의 close·답변·조회 시 audit log 호출 검증
 *
 * 시나리오:
 * - closeInquiry 호출 → InquiriesService.closeInquiry + audit log 'close_inquiry'
 * - addComment 호출 → InquiriesService.addAdminComment + audit log 'reply_inquiry' (contentLength만, 본문 평문 저장 X)
 * - getInquiry 호출 → InquiriesService.findOneAdmin + audit log 'view_inquiry' (LRR P1T3 PR J, 단건 상세만)
 * - getInquiries(list) / getStats / getAnalytics는 audit 안 함 (정책: PII 부분 노출 + 빈도 높음 → 단건만)
 */
import { Test } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAuditService } from './admin-audit.service';
import { InquiriesService } from '../inquiries/inquiries.service';

// jose(ESM)는 jest(CJS) 런타임에서 로드 불가 — import 체인(AdminService → UsersService →
// IdentityProviderService → AppleTokenService)이 jose 에 닿으므로 mock 필수.
jest.mock('jose', () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  SignJWT: jest.fn(),
  importPKCS8: jest.fn(),
}));

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

  describe('getInquiry (LRR P1T3 PR J — 단건 read audit)', () => {
    it("상세 조회 후 auditService.log('view_inquiry') 호출", async () => {
      const inquiry = { id: 'inquiry-1', content: '문의 본문', status: 'OPEN' };
      inquiriesService.findOneAdmin.mockResolvedValue(inquiry);

      const result = await controller.getInquiry(
        { id: 'admin-1' },
        'inquiry-1',
      );

      expect(inquiriesService.findOneAdmin).toHaveBeenCalledWith('inquiry-1');
      expect(auditService.log).toHaveBeenCalledWith(
        'admin-1',
        'view_inquiry',
        'inquiry',
        'inquiry-1',
        {},
      );
      // 응답은 그대로 반환 — audit는 부수 효과
      expect(result).toEqual(inquiry);
    });

    it('audit detail에 inquiry 본문·PII 평문 저장 안 함 (privacy)', async () => {
      inquiriesService.findOneAdmin.mockResolvedValue({
        id: 'inquiry-1',
        content: '비밀 문의',
        user_email: 'private@test.com',
      });
      await controller.getInquiry({ id: 'admin-1' }, 'inquiry-1');
      const auditCall = auditService.log.mock.calls[0] as unknown[];
      const detail = auditCall[4] as Record<string, unknown>;
      // 누가 무엇을 봤는지만 추적, 본문·PII 자체는 audit에 평문 보존 X
      expect(detail).toEqual({});
    });
  });

  describe('audit 안 하는 read (정책 검증 — getStats / getAnalytics / getInquiries)', () => {
    it('getStats 호출 시 audit 미발생', async () => {
      adminService.getStats.mockResolvedValue({ total: 100 });
      await controller.getStats();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('getAnalytics 호출 시 audit 미발생', async () => {
      adminService.getAnalytics.mockResolvedValue([]);
      await controller.getAnalytics('30');
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('getInquiries(list) 호출 시 audit 미발생', async () => {
      inquiriesService.findAll.mockResolvedValue({ items: [], total: 0 });
      await controller.getInquiries('OPEN', undefined, '1', '30');
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  describe('getInquiries page/limit cap (LRR P1T3 PR K L-1)', () => {
    beforeEach(() => {
      inquiriesService.findAll.mockResolvedValue({ items: [], total: 0 });
    });

    it('limit 미지정 → 기본 30', async () => {
      await controller.getInquiries(undefined, undefined, undefined, undefined);
      expect(inquiriesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 30 }),
      );
    });

    it('limit=150 → 100으로 cap', async () => {
      await controller.getInquiries(undefined, undefined, '1', '150');
      expect(inquiriesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });

    it('limit=0 → 1로 floor (음수·0 차단)', async () => {
      await controller.getInquiries(undefined, undefined, '1', '0');
      // parseInt('0')||30 = 30 (0은 falsy라 default 적용) — 정상 동작
      expect(inquiriesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 30 }),
      );
    });

    it("limit='abc' (NaN) → 기본 30", async () => {
      await controller.getInquiries(undefined, undefined, '1', 'abc');
      expect(inquiriesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 30 }),
      );
    });

    it('page 미지정 → 1', async () => {
      await controller.getInquiries(undefined, undefined, undefined, '30');
      expect(inquiriesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1 }),
      );
    });

    it("page='0' → 1로 floor", async () => {
      await controller.getInquiries(undefined, undefined, '0', '30');
      // parseInt('0')||1 = 1 → max(1,1)=1
      expect(inquiriesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1 }),
      );
    });
  });

  // ── M-15 getAnalytics days cap·floor ─────────────────
  describe('getAnalytics days param cap·floor (M-15, AD2-4·AD2-5)', () => {
    beforeEach(() => {
      adminService.getAnalytics.mockResolvedValue({
        dailySignups: [],
        dailyApplications: [],
        weeklyRetention: { signups: 0, retained: 0, rate: 0 },
      });
    });

    it('days=200 → 90으로 cap (Math.min)', async () => {
      await controller.getAnalytics('200');
      expect(adminService.getAnalytics).toHaveBeenCalledWith(90);
    });

    it('days=3 → 7로 floor (Math.max)', async () => {
      await controller.getAnalytics('3');
      expect(adminService.getAnalytics).toHaveBeenCalledWith(7);
    });

    it('days 미지정 → 기본 30', async () => {
      await controller.getAnalytics(undefined);
      expect(adminService.getAnalytics).toHaveBeenCalledWith(30);
    });

    it("days='abc' (NaN → 0 falsy) → 기본 30 후 cap·floor", async () => {
      await controller.getAnalytics('abc');
      // parseInt('abc')=NaN || 30 → 30 → min(90, max(7, 30)) = 30
      expect(adminService.getAnalytics).toHaveBeenCalledWith(30);
    });

    it('days=90 (경계값 상한) → 90', async () => {
      await controller.getAnalytics('90');
      expect(adminService.getAnalytics).toHaveBeenCalledWith(90);
    });

    it('days=7 (경계값 하한) → 7', async () => {
      await controller.getAnalytics('7');
      expect(adminService.getAnalytics).toHaveBeenCalledWith(7);
    });
  });
});
