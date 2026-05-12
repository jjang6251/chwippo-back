import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Application } from './application.entity';
import { ApplicationCoverletter } from './application-coverletter.entity';
import {
  CreateApplicationCoverletterDto,
  UpdateApplicationCoverletterDto,
} from './dto/coverletter.dto';

@Injectable()
export class ApplicationCoverlettersService {
  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationCoverletter)
    private readonly clRepo: Repository<ApplicationCoverletter>,
  ) {}

  // 카드 소유자 검증 (IDOR)
  private async assertOwnsApplication(
    userId: string,
    applicationId: string,
  ): Promise<void> {
    const app = await this.appRepo.findOne({
      where: { id: applicationId, userId },
    });
    if (!app) throw new NotFoundException('카드를 찾을 수 없습니다.');
  }

  async list(userId: string, applicationId: string) {
    await this.assertOwnsApplication(userId, applicationId);
    return this.clRepo.find({
      where: { applicationId },
      order: { orderIndex: 'ASC', createdAt: 'ASC' },
    });
  }

  async create(
    userId: string,
    applicationId: string,
    dto: CreateApplicationCoverletterDto,
  ) {
    await this.assertOwnsApplication(userId, applicationId);
    const maxRow = await this.clRepo
      .createQueryBuilder('cl')
      .select('MAX(cl.orderIndex)', 'max')
      .where('cl.applicationId = :applicationId', { applicationId })
      .getRawOne<{ max: number | null }>();
    const orderIndex = (maxRow?.max ?? -1) + 1;
    const item = this.clRepo.create({
      applicationId,
      question: dto.question,
      category: dto.category ?? null,
      answer: dto.answer ?? null,
      charLimit: dto.charLimit ?? null,
      orderIndex,
    });
    return this.clRepo.save(item);
  }

  async update(
    userId: string,
    applicationId: string,
    clId: string,
    dto: UpdateApplicationCoverletterDto,
  ) {
    await this.assertOwnsApplication(userId, applicationId);
    const item = await this.clRepo.findOne({
      where: { id: clId, applicationId },
    });
    if (!item) throw new NotFoundException('자소서 문항을 찾을 수 없습니다.');
    if (dto.question !== undefined) item.question = dto.question;
    if (dto.category !== undefined) item.category = dto.category || null;
    if (dto.answer !== undefined) item.answer = dto.answer || null;
    if (dto.charLimit !== undefined) item.charLimit = dto.charLimit ?? null;
    return this.clRepo.save(item);
  }

  async remove(userId: string, applicationId: string, clId: string) {
    await this.assertOwnsApplication(userId, applicationId);
    const item = await this.clRepo.findOne({
      where: { id: clId, applicationId },
    });
    if (!item) throw new NotFoundException('자소서 문항을 찾을 수 없습니다.');
    await this.clRepo.delete({ id: clId });
  }

  // "다른 데서 가져오기" — 이 카드를 제외한 사용자의 다른 카드들에서 답변 있는 자소서 문항
  // category가 주어지면 같은 유형을 먼저 정렬 (전체는 항상 반환 — 클라이언트가 "전체 보기" 토글)
  async reuseOptions(
    userId: string,
    excludeApplicationId: string,
    category?: string,
  ) {
    const rows = await this.clRepo
      .createQueryBuilder('cl')
      .innerJoin('cl.application', 'app')
      .where('app.user_id = :userId', { userId })
      .andWhere('app.deleted_at IS NULL')
      .andWhere('app.id <> :excludeId', { excludeId: excludeApplicationId })
      .andWhere("cl.answer IS NOT NULL AND cl.answer <> ''")
      .select([
        'cl.id',
        'cl.question',
        'cl.category',
        'cl.answer',
        'app.id',
        'app.companyName',
      ])
      .orderBy('cl.updatedAt', 'DESC')
      .getMany();

    const result = rows.map((cl) => ({
      id: cl.id,
      question: cl.question,
      category: cl.category,
      answer: cl.answer,
      applicationId: cl.application.id,
      companyName: cl.application.companyName,
    }));

    if (category) {
      result.sort((a, b) => {
        const am = a.category === category ? 0 : 1;
        const bm = b.category === category ? 0 : 1;
        return am - bm;
      });
    }
    return result;
  }
}
