import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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
    @InjectDataSource() private readonly dataSource: DataSource,
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

  /**
   * 시험 일정을 자격증으로 이관 (LRR P1T2 H-1 보수).
   * - 트랜잭션 + pessimistic_write 락으로 동시 호출 race 차단 (중복 cert 생성 방지)
   * - cert 생성 + exam 삭제가 원자적 (중간 실패 시 전체 rollback)
   */
  async convertToCert(userId: string, id: string, dto: ConvertExamToCertDto) {
    await this.dataSource.transaction(async (manager) => {
      const exam = await manager.findOne(ExamSchedule, {
        where: { id, user_id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!exam) throw new NotFoundException('시험 일정을 찾을 수 없습니다');

      const acquiredAt = dayjs(exam.exam_date).format('YYYY-MM-DD');

      if (exam.exam_type === 'language') {
        await manager.save(
          LanguageCert,
          manager.create(LanguageCert, {
            user_id: userId,
            cert_type: exam.cert_type ?? exam.name,
            score_grade: dto.score_grade ?? '',
            acquired_at: acquiredAt,
          }),
        );
      } else {
        await manager.save(
          Cert,
          manager.create(Cert, {
            user_id: userId,
            name: exam.name,
            acquired_at: acquiredAt,
          }),
        );
      }

      await manager.delete(ExamSchedule, { id, user_id: userId });
    });
  }
}
