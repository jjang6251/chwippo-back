import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Inquiry } from './inquiry.entity';
import { CreateInquiryDto } from './dto/create-inquiry.dto';

@Injectable()
export class InquiriesService {
  constructor(@InjectRepository(Inquiry) private repo: Repository<Inquiry>) {}

  async create(userId: string, dto: CreateInquiryDto): Promise<Inquiry> {
    const inquiry = this.repo.create({ ...dto, user_id: userId });
    return this.repo.save(inquiry);
  }

  async findAll(opts?: { status?: string; page?: number; limit?: number }) {
    const qb = this.repo.createQueryBuilder('i').orderBy('i.created_at', 'DESC');
    if (opts?.status) qb.where('i.status = :status', { status: opts.status });
    const limit = opts?.limit ?? 20;
    const page = opts?.page ?? 1;
    qb.skip((page - 1) * limit).take(limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit };
  }

  async updateStatus(id: string, status: string, adminReply?: string): Promise<Inquiry> {
    const inquiry = await this.repo.findOneByOrFail({ id });
    inquiry.status = status;
    if (adminReply !== undefined) {
      inquiry.admin_reply = adminReply;
      inquiry.replied_at = new Date();
    }
    return this.repo.save(inquiry);
  }

  async countPending(): Promise<number> {
    return this.repo.countBy({ status: 'PENDING' });
  }
}
