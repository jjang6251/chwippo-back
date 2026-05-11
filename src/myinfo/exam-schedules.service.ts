import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import dayjs from 'dayjs';
import { ExamSchedule } from './entities/exam-schedule.entity';
import { Cert } from './entities/cert.entity';
import { LanguageCert } from './entities/language-cert.entity';
import {
  CreateExamScheduleDto,
  UpdateExamScheduleDto,
  ConvertExamToCertDto,
} from './dto/exam-schedule.dto';

@Injectable()
export class ExamSchedulesService {
  constructor(
    @InjectRepository(ExamSchedule) private examRepo: Repository<ExamSchedule>,
    @InjectRepository(Cert) private certRepo: Repository<Cert>,
    @InjectRepository(LanguageCert)
    private langCertRepo: Repository<LanguageCert>,
  ) {}

  list(userId: string) {
    return this.examRepo.find({
      where: { user_id: userId },
      order: { exam_date: 'ASC' },
    });
  }

  async create(userId: string, dto: CreateExamScheduleDto) {
    const entity = this.examRepo.create({
      user_id: userId,
      exam_type: dto.exam_type,
      cert_type: dto.cert_type ?? null,
      name: dto.name,
      exam_date: new Date(dto.exam_date),
      location: dto.location ?? null,
      memo: dto.memo ?? null,
    });
    return this.examRepo.save(entity);
  }

  async update(userId: string, id: string, dto: UpdateExamScheduleDto) {
    const entity = await this.examRepo.findOne({
      where: { id, user_id: userId },
    });
    if (!entity) throw new NotFoundException('시험 일정을 찾을 수 없습니다');

    if (dto.exam_type !== undefined) entity.exam_type = dto.exam_type;
    if (dto.cert_type !== undefined) entity.cert_type = dto.cert_type;
    if (dto.name !== undefined) entity.name = dto.name;
    if (dto.exam_date !== undefined) entity.exam_date = new Date(dto.exam_date);
    if (dto.location !== undefined) entity.location = dto.location;
    if (dto.memo !== undefined) entity.memo = dto.memo;

    return this.examRepo.save(entity);
  }

  async remove(userId: string, id: string) {
    const result = await this.examRepo.delete({ id, user_id: userId });
    if (result.affected === 0)
      throw new NotFoundException('시험 일정을 찾을 수 없습니다');
  }

  async convertToCert(userId: string, id: string, dto: ConvertExamToCertDto) {
    const exam = await this.examRepo.findOne({
      where: { id, user_id: userId },
    });
    if (!exam) throw new NotFoundException('시험 일정을 찾을 수 없습니다');

    const acquiredAt = dayjs(exam.exam_date).format('YYYY-MM-DD');

    if (exam.exam_type === 'language') {
      await this.langCertRepo.save(
        this.langCertRepo.create({
          user_id: userId,
          cert_type: exam.cert_type ?? exam.name,
          score_grade: dto.score_grade ?? '',
          acquired_at: acquiredAt,
        }),
      );
    } else {
      await this.certRepo.save(
        this.certRepo.create({
          user_id: userId,
          name: exam.name,
          acquired_at: acquiredAt,
        }),
      );
    }

    await this.examRepo.delete({ id, user_id: userId });
  }
}
