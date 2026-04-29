import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Inquiry } from './inquiry.entity';
import { InquiryComment } from './inquiry-comment.entity';
import { CreateInquiryDto } from './dto/create-inquiry.dto';

@Injectable()
export class InquiriesService {
  constructor(
    @InjectRepository(Inquiry) private repo: Repository<Inquiry>,
    @InjectRepository(InquiryComment) private commentRepo: Repository<InquiryComment>,
    private dataSource: DataSource,
  ) {}

  // ── 사용자: 문의 생성 ──────────────────────────────────
  async create(userId: string, dto: CreateInquiryDto): Promise<Inquiry> {
    const inquiry = this.repo.create({ ...dto, user_id: userId, status: 'OPEN', user_unread: 0, admin_unread: 1 });
    return this.repo.save(inquiry);
  }

  // ── 사용자: 내 문의 목록 ──────────────────────────────
  async findByUser(userId: string) {
    const rows = await this.repo
      .createQueryBuilder('i')
      .where('i.user_id = :userId', { userId })
      .orderBy(`CASE WHEN i.status = 'CLOSED' THEN 1 ELSE 0 END`, 'ASC')
      .addOrderBy('i.created_at', 'DESC')
      .getMany();
    return rows;
  }

  // ── 사용자: 문의 상세 (읽음 처리) ────────────────────
  async findOneByUser(id: string, userId: string) {
    const inquiry = await this.repo.findOneBy({ id });
    if (!inquiry) throw new NotFoundException();
    if (inquiry.user_id !== userId) throw new ForbiddenException();

    const comments = await this.commentRepo.find({
      where: { inquiry_id: id },
      order: { created_at: 'ASC' },
    });

    if (inquiry.user_unread > 0) {
      await this.repo.update(id, { user_unread: 0 });
      inquiry.user_unread = 0;
    }

    return { ...inquiry, comments };
  }

  // ── 사용자: 댓글 작성 → 어드민 미읽음 + 1 ───────────
  async addUserComment(id: string, userId: string, content: string) {
    const inquiry = await this.repo.findOneBy({ id });
    if (!inquiry) throw new NotFoundException();
    if (inquiry.user_id !== userId) throw new ForbiddenException();
    if (inquiry.status === 'CLOSED') throw new ForbiddenException('닫힌 문의에는 댓글을 작성할 수 없어요.');

    const comment = this.commentRepo.create({ inquiry_id: id, author_role: 'user', author_id: userId, content });
    await this.commentRepo.save(comment);
    await this.repo.increment({ id }, 'admin_unread', 1);
    return comment;
  }

  // ── 어드민: 전체 목록 (유저 정보 포함) ───────────────
  async findAll(opts?: { status?: string; category?: string; page?: number; limit?: number }) {
    const qb = this.repo
      .createQueryBuilder('i')
      .orderBy(`CASE WHEN i.status = 'CLOSED' THEN 1 ELSE 0 END`, 'ASC')
      .addOrderBy('i.created_at', 'DESC');

    if (opts?.status) qb.andWhere('i.status = :status', { status: opts.status });
    if (opts?.category) qb.andWhere('i.category = :category', { category: opts.category });

    const limit = opts?.limit ?? 30;
    const page = opts?.page ?? 1;
    qb.skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();

    // 유저 정보 배치 조회
    const userIds = [...new Set(rows.map((i) => i.user_id).filter(Boolean))] as string[];
    let userMap = new Map<string, { nickname: string; email: string | null }>();
    if (userIds.length > 0) {
      const users: { id: string; nickname: string; email: string | null }[] =
        await this.dataSource.query(
          `SELECT id::text AS id, nickname, email FROM users WHERE id::text = ANY($1)`,
          [userIds],
        );
      userMap = new Map(users.map((u) => [u.id, u]));
    }

    const items = rows.map((i) => ({
      ...i,
      user_nickname: i.user_id ? (userMap.get(i.user_id)?.nickname ?? null) : null,
      user_email: i.user_id ? (userMap.get(i.user_id)?.email ?? null) : null,
      user_short_id: i.user_id ? i.user_id.slice(0, 8) : null,
    }));

    return { items, total, page, limit };
  }

  // ── 어드민: 상세 (유저 컨텍스트 + 읽음 처리) ─────────
  async findOneAdmin(id: string) {
    const inquiry = await this.repo.findOneBy({ id });
    if (!inquiry) throw new NotFoundException();

    const comments = await this.commentRepo.find({
      where: { inquiry_id: id },
      order: { created_at: 'ASC' },
    });

    if (inquiry.admin_unread > 0) {
      await this.repo.update(id, { admin_unread: 0 });
      inquiry.admin_unread = 0;
    }

    // 유저 컨텍스트 (탈퇴 유저면 user_id가 null)
    let userContext: Record<string, unknown> = {};
    if (inquiry.user_id) {
      const [ctx] = await this.dataSource.query(
        `SELECT u.nickname                    AS user_nickname,
                u.email                      AS user_email,
                LEFT(u.id::text, 8)          AS user_short_id,
                u.created_at                 AS user_created_at,
                (SELECT COUNT(*)::int FROM applications
                 WHERE user_id::text = $1 AND deleted_at IS NULL) AS user_card_count,
                (SELECT COUNT(*)::int FROM inquiries
                 WHERE user_id::text = $1)                         AS user_inquiry_count
         FROM users u
         WHERE u.id::text = $1`,
        [inquiry.user_id],
      );
      userContext = ctx ?? {};
    }

    return { ...inquiry, ...userContext, comments };
  }

  // ── 어드민: 댓글 작성 → 사용자 미읽음 + 1 ──────────
  async addAdminComment(id: string, adminId: string, content: string) {
    const inquiry = await this.repo.findOneBy({ id });
    if (!inquiry) throw new NotFoundException();

    const comment = this.commentRepo.create({ inquiry_id: id, author_role: 'admin', author_id: adminId, content });
    await this.commentRepo.save(comment);
    await this.repo.increment({ id }, 'user_unread', 1);

    if (inquiry.status !== 'IN_PROGRESS' && inquiry.status !== 'CLOSED') {
      await this.repo.update(id, { status: 'IN_PROGRESS' });
    }

    return comment;
  }

  // ── 어드민: 문의 닫기 ─────────────────────────────────
  async closeInquiry(id: string) {
    const inquiry = await this.repo.findOneBy({ id });
    if (!inquiry) throw new NotFoundException();
    await this.repo.update(id, { status: 'CLOSED' });
    return { ...inquiry, status: 'CLOSED' };
  }

  // ── 통계용 ───────────────────────────────────────────
  async countPending(): Promise<number> {
    return this.repo.count({ where: [{ status: 'OPEN' }, { status: 'IN_PROGRESS' }] });
  }
}
