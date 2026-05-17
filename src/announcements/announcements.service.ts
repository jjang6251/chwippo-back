import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Or,
  Repository,
} from 'typeorm';
import { Announcement } from './announcement.entity';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';

function assertStartsBeforeEnds(starts: Date | null, ends: Date | null): void {
  if (starts && ends && starts.getTime() > ends.getTime()) {
    throw new BadRequestException(
      '시작 일시가 종료 일시보다 이후일 수 없습니다.',
    );
  }
}

@Injectable()
export class AnnouncementsService {
  constructor(
    @InjectRepository(Announcement)
    private readonly repo: Repository<Announcement>,
  ) {}

  getActive(): Promise<Announcement | null> {
    const now = new Date();
    return this.repo.findOne({
      where: {
        active: true,
        starts_at: Or(IsNull(), LessThanOrEqual(now)),
        ends_at: Or(IsNull(), MoreThanOrEqual(now)),
      },
      order: { created_at: 'DESC' },
    });
  }

  findAll(): Promise<Announcement[]> {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  create(dto: CreateAnnouncementDto): Promise<Announcement> {
    const starts = dto.starts_at ? new Date(dto.starts_at) : null;
    const ends = dto.ends_at ? new Date(dto.ends_at) : null;
    // LRR P2T3 PR X (MED-T3-1): starts > ends 논리 차단 (getActive가 절대 매칭 안 되는 row 방지)
    assertStartsBeforeEnds(starts, ends);
    const entity = this.repo.create({
      ...dto,
      starts_at: starts,
      ends_at: ends,
    });
    return this.repo.save(entity);
  }

  async update(id: string, dto: UpdateAnnouncementDto): Promise<Announcement> {
    const announcement = await this.repo.findOne({ where: { id } });
    if (!announcement) throw new NotFoundException('공지를 찾을 수 없습니다.');

    const updates: Partial<Announcement> = { ...dto } as Partial<Announcement>;
    if (dto.starts_at !== undefined) {
      updates.starts_at = dto.starts_at ? new Date(dto.starts_at) : null;
    }
    if (dto.ends_at !== undefined) {
      updates.ends_at = dto.ends_at ? new Date(dto.ends_at) : null;
    }

    // LRR P2T3 PR X (MED-T3-1): patch 적용 후의 최종 starts/ends 비교
    const finalStarts = updates.starts_at ?? announcement.starts_at;
    const finalEnds = updates.ends_at ?? announcement.ends_at;
    assertStartsBeforeEnds(finalStarts, finalEnds);

    Object.assign(announcement, updates);
    return this.repo.save(announcement);
  }

  async remove(id: string): Promise<void> {
    const announcement = await this.repo.findOne({ where: { id } });
    if (!announcement) throw new NotFoundException('공지를 찾을 수 없습니다.');
    await this.repo.remove(announcement);
  }
}
