import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Inquiry } from './inquiry.entity';
import { InquiryComment } from './inquiry-comment.entity';
import { CreateInquiryDto } from './dto/create-inquiry.dto';

@Injectable()
export class InquiriesService {
  constructor(
    @InjectRepository(Inquiry) private repo: Repository<Inquiry>,
    @InjectRepository(InquiryComment) private commentRepo: Repository<InquiryComment>,
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

    // 읽음 처리
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

  // ── 어드민: 전체 목록 ─────────────────────────────────
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

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit };
  }

  // ── 어드민: 상세 (읽음 처리) ─────────────────────────
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

    return { ...inquiry, comments };
  }

  // ── 어드민: 댓글 작성 → 사용자 미읽음 + 1 ──────────
  async addAdminComment(id: string, adminId: string, content: string) {
    const inquiry = await this.repo.findOneBy({ id });
    if (!inquiry) throw new NotFoundException();

    const comment = this.commentRepo.create({ inquiry_id: id, author_role: 'admin', author_id: adminId, content });
    await this.commentRepo.save(comment);
    await this.repo.increment({ id }, 'user_unread', 1);

    // 어드민이 댓글 달면 IN_PROGRESS로 자동 전환
    if (inquiry.status === 'OPEN') {
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
