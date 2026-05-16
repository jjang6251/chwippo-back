import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditLog } from './admin-audit-log.entity';

const mockRepo = () => ({
  save: jest.fn(),
  create: jest.fn(),
});

function makeLog(overrides: Partial<AdminAuditLog> = {}): AdminAuditLog {
  return {
    id: 'log-uuid',
    adminUserId: 'admin-uuid',
    action: 'suspend',
    targetType: 'user',
    targetId: 'user-uuid',
    detail: {},
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('AdminAuditService', () => {
  let service: AdminAuditService;
  let repo: jest.Mocked<Repository<AdminAuditLog>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminAuditService,
        { provide: getRepositoryToken(AdminAuditLog), useFactory: mockRepo },
      ],
    }).compile();

    service = module.get(AdminAuditService);
    repo = module.get(getRepositoryToken(AdminAuditLog));
  });

  afterEach(() => jest.clearAllMocks());

  describe('log()', () => {
    it('정상: repo.save()로 audit_log를 insert한다', async () => {
      const saved = makeLog();
      repo.save.mockResolvedValue(saved);

      await service.log('admin-uuid', 'suspend', 'user', 'user-uuid', {});

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          adminUserId: 'admin-uuid',
          action: 'suspend',
          targetType: 'user',
          targetId: 'user-uuid',
          detail: {},
        }),
      );
    });

    it('adminUserId가 null이어도 저장한다 (어드민 계정 삭제 후 소급 보존)', async () => {
      repo.save.mockResolvedValue(makeLog({ adminUserId: null }));

      await service.log(null, 'rename', 'user', 'user-uuid', {
        before: 'A',
        after: 'B',
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ adminUserId: null }),
      );
    });

    it('manager가 제공되면 manager.save()를 사용한다', async () => {
      const mockManager = {
        save: jest.fn().mockResolvedValue(makeLog()),
      } as unknown as EntityManager;

      await service.log(
        'admin-uuid',
        'delete',
        'user',
        'user-uuid',
        {},
        mockManager,
      );

      expect(mockManager.save).toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('action별 detail JSONB 구조 — rename은 before·after 포함', async () => {
      repo.save.mockResolvedValue(makeLog());

      await service.log('admin-uuid', 'rename', 'user', 'user-uuid', {
        before: '홍길동',
        after: '익명1234',
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: { before: '홍길동', after: '익명1234' },
        }),
      );
    });

    it('action별 detail JSONB 구조 — warn은 message 포함', async () => {
      repo.save.mockResolvedValue(makeLog());

      await service.log('admin-uuid', 'warn', 'user', 'user-uuid', {
        message: '부적절한 닉네임 사용',
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: { message: '부적절한 닉네임 사용' },
        }),
      );
    });

    it('repo.save 실패 (manager 없음) → throw하지 않음 (best-effort, audit 누락만)', async () => {
      repo.save.mockRejectedValue(new Error('DB 일시 장애'));

      // throw 안 함 — caller의 액션은 정상 응답 (일관성 유지)
      await expect(
        service.log('admin-uuid', 'reply_inquiry', 'inquiry', 'i1', {}),
      ).resolves.toBeUndefined();
    });

    it('manager 제공 시 save 실패 → throw (트랜잭션 안에선 같이 rollback)', async () => {
      const mockManager = {
        save: jest.fn().mockRejectedValue(new Error('DB 장애')),
      } as unknown as EntityManager;

      await expect(
        service.log('admin-uuid', 'suspend', 'user', 'u1', {}, mockManager),
      ).rejects.toThrow('DB 장애');
    });
  });
});
