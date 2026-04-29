import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { Inquiry } from './inquiry.entity';
import { InquiryComment } from './inquiry-comment.entity';
import { InquiriesService } from './inquiries.service';

describe('InquiriesService', () => {
  let service: InquiriesService;
  let repo: jest.Mocked<Repository<Inquiry>>;
  let commentRepo: jest.Mocked<Repository<InquiryComment>>;
  let dataSource: { query: jest.Mock };

  const makeInquiry = (overrides: Partial<Inquiry> = {}): Inquiry =>
    ({
      id: 'inq-uuid-1',
      user_id: 'user-uuid-1',
      category: '버그신고',
      title: '버그 있어요',
      content: '상세 내용입니다.',
      status: 'OPEN',
      user_unread: 0,
      admin_unread: 1,
      created_at: new Date(),
      ...overrides,
    }) as Inquiry;

  const makeComment = (overrides: Partial<InquiryComment> = {}): InquiryComment =>
    ({
      id: 'comment-uuid-1',
      inquiry_id: 'inq-uuid-1',
      author_role: 'user',
      author_id: 'user-uuid-1',
      content: '추가 질문입니다.',
      created_at: new Date(),
      ...overrides,
    }) as InquiryComment;

  beforeEach(async () => {
    const mockRepo = mock<Repository<Inquiry>>();
    const mockCommentRepo = mock<Repository<InquiryComment>>();
    const mockDataSource = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InquiriesService,
        { provide: getRepositoryToken(Inquiry), useValue: mockRepo },
        { provide: getRepositoryToken(InquiryComment), useValue: mockCommentRepo },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<InquiriesService>(InquiriesService);
    repo = module.get(getRepositoryToken(Inquiry));
    commentRepo = module.get(getRepositoryToken(InquiryComment));
    dataSource = module.get(DataSource) as any;
  });

  afterEach(() => jest.clearAllMocks());

  // ── create ─────────────────────────────────────────────
  describe('create', () => {
    it('user_id, status=OPEN, user_unread=0, admin_unread=1로 생성', async () => {
      const inquiry = makeInquiry();
      repo.create.mockReturnValue(inquiry);
      repo.save.mockResolvedValue(inquiry);

      await service.create('user-uuid-1', {
        category: '버그신고',
        title: '버그 있어요',
        content: '상세 내용입니다.',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-uuid-1',
          status: 'OPEN',
          user_unread: 0,
          admin_unread: 1,
        }),
      );
      expect(repo.save).toHaveBeenCalledWith(inquiry);
    });
  });

  // ── findByUser ─────────────────────────────────────────
  describe('findByUser', () => {
    it('QueryBuilder에 user_id 조건 포함', async () => {
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([makeInquiry()]),
      };
      repo.createQueryBuilder.mockReturnValue(mockQb as any);

      await service.findByUser('user-uuid-1');

      expect(mockQb.where).toHaveBeenCalledWith(
        'i.user_id = :userId',
        { userId: 'user-uuid-1' },
      );
    });

    it('CLOSED 문의는 CASE WHEN으로 하단 정렬 (orderBy에 CASE 포함)', async () => {
      const mockQb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      repo.createQueryBuilder.mockReturnValue(mockQb as any);

      await service.findByUser('user-uuid-1');

      const orderByCall = (mockQb.orderBy as jest.Mock).mock.calls[0];
      expect(orderByCall[0]).toContain('CLOSED');
    });
  });

  // ── findOneByUser ──────────────────────────────────────
  describe('findOneByUser', () => {
    it('id로 조회 성공 + userId 일치 → { ...inquiry, comments } 반환', async () => {
      const inquiry = makeInquiry({ user_unread: 0 });
      const comments = [makeComment()];
      repo.findOneBy.mockResolvedValue(inquiry);
      commentRepo.find.mockResolvedValue(comments);

      const result = await service.findOneByUser('inq-uuid-1', 'user-uuid-1');

      expect(result.comments).toEqual(comments);
      expect(commentRepo.find).toHaveBeenCalledWith({
        where: { inquiry_id: 'inq-uuid-1' },
        order: { created_at: 'ASC' },
      });
    });

    it('존재하지 않는 id → NotFoundException', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.findOneByUser('nonexistent', 'user-uuid-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('user_id !== userId → ForbiddenException', async () => {
      repo.findOneBy.mockResolvedValue(makeInquiry({ user_id: 'user-A' }));
      await expect(service.findOneByUser('inq-uuid-1', 'user-B')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('user_unread > 0 → repo.update(id, { user_unread: 0 }) 호출', async () => {
      repo.findOneBy.mockResolvedValue(makeInquiry({ user_unread: 3 }));
      commentRepo.find.mockResolvedValue([]);
      repo.update.mockResolvedValue({} as any);

      await service.findOneByUser('inq-uuid-1', 'user-uuid-1');

      expect(repo.update).toHaveBeenCalledWith('inq-uuid-1', { user_unread: 0 });
    });

    it('user_unread === 0 → repo.update 미호출', async () => {
      repo.findOneBy.mockResolvedValue(makeInquiry({ user_unread: 0 }));
      commentRepo.find.mockResolvedValue([]);

      await service.findOneByUser('inq-uuid-1', 'user-uuid-1');

      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  // ── addUserComment ─────────────────────────────────────
  describe('addUserComment', () => {
    it('정상 댓글 작성 → commentRepo.save + repo.increment(admin_unread +1)', async () => {
      const inquiry = makeInquiry({ status: 'OPEN' });
      const comment = makeComment();
      repo.findOneBy.mockResolvedValue(inquiry);
      commentRepo.create.mockReturnValue(comment);
      commentRepo.save.mockResolvedValue(comment);
      repo.increment.mockResolvedValue({} as any);

      await service.addUserComment('inq-uuid-1', 'user-uuid-1', '추가 질문');

      expect(commentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          inquiry_id: 'inq-uuid-1',
          author_role: 'user',
          author_id: 'user-uuid-1',
          content: '추가 질문',
        }),
      );
      expect(repo.increment).toHaveBeenCalledWith({ id: 'inq-uuid-1' }, 'admin_unread', 1);
    });

    it('CLOSED 문의 → ForbiddenException', async () => {
      repo.findOneBy.mockResolvedValue(makeInquiry({ status: 'CLOSED' }));
      await expect(
        service.addUserComment('inq-uuid-1', 'user-uuid-1', '닫힌 문의에 댓글'),
      ).rejects.toThrow(new ForbiddenException('닫힌 문의에는 댓글을 작성할 수 없어요.'));
    });

    it('다른 userId → ForbiddenException', async () => {
      repo.findOneBy.mockResolvedValue(makeInquiry({ user_id: 'user-A' }));
      await expect(
        service.addUserComment('inq-uuid-1', 'user-B', '내용'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('존재하지 않는 id → NotFoundException', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.addUserComment('nonexistent', 'user-uuid-1', '내용')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── addAdminComment ────────────────────────────────────
  describe('addAdminComment', () => {
    const setupAdmin = (status: Inquiry['status']) => {
      const inquiry = makeInquiry({ status });
      const comment = makeComment({ author_role: 'admin' });
      repo.findOneBy.mockResolvedValue(inquiry);
      commentRepo.create.mockReturnValue(comment);
      commentRepo.save.mockResolvedValue(comment);
      repo.increment.mockResolvedValue({} as any);
      repo.update.mockResolvedValue({} as any);
      return { inquiry, comment };
    };

    it('정상 댓글 작성 → commentRepo.save + repo.increment(user_unread +1)', async () => {
      setupAdmin('OPEN');
      await service.addAdminComment('inq-uuid-1', 'admin-uuid', '어드민 답변');

      expect(commentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ author_role: 'admin', author_id: 'admin-uuid' }),
      );
      expect(repo.increment).toHaveBeenCalledWith({ id: 'inq-uuid-1' }, 'user_unread', 1);
    });

    it('status=OPEN → repo.update(id, { status: IN_PROGRESS }) 호출', async () => {
      setupAdmin('OPEN');
      await service.addAdminComment('inq-uuid-1', 'admin-uuid', '답변');
      expect(repo.update).toHaveBeenCalledWith('inq-uuid-1', { status: 'IN_PROGRESS' });
    });

    it('status=IN_PROGRESS → repo.update 미호출 (상태 변경 없음)', async () => {
      setupAdmin('IN_PROGRESS');
      await service.addAdminComment('inq-uuid-1', 'admin-uuid', '추가 답변');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('status=CLOSED → repo.update 미호출 (상태 변경 없음)', async () => {
      setupAdmin('CLOSED');
      await service.addAdminComment('inq-uuid-1', 'admin-uuid', '닫힌 후 답변');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('존재하지 않는 id → NotFoundException', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.addAdminComment('nonexistent', 'admin-uuid', '답변')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── closeInquiry ───────────────────────────────────────
  describe('closeInquiry', () => {
    it('repo.update(id, { status: CLOSED }) 호출 → { ...inquiry, status: CLOSED } 반환', async () => {
      const inquiry = makeInquiry({ status: 'IN_PROGRESS' });
      repo.findOneBy.mockResolvedValue(inquiry);
      repo.update.mockResolvedValue({} as any);

      const result = await service.closeInquiry('inq-uuid-1');

      expect(repo.update).toHaveBeenCalledWith('inq-uuid-1', { status: 'CLOSED' });
      expect(result.status).toBe('CLOSED');
    });

    it('존재하지 않는 id → NotFoundException', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.closeInquiry('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── countPending ───────────────────────────────────────
  describe('countPending', () => {
    it('repo.count({ where: [OPEN, IN_PROGRESS] }) 반환값을 그대로 반환', async () => {
      repo.count.mockResolvedValue(5);
      const result = await service.countPending();
      expect(result).toBe(5);
      expect(repo.count).toHaveBeenCalledWith({
        where: [{ status: 'OPEN' }, { status: 'IN_PROGRESS' }],
      });
    });
  });
});
