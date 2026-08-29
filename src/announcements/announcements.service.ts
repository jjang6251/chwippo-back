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

/**
 * CTA 는 라벨과 경로가 **항상 짝**이어야 한다.
 *
 * 라벨만 있으면 눌러도 갈 곳이 없는 버튼이 뜨고, 경로만 있으면 버튼 자체가 안 그려져
 * 관리자가 「분명히 링크를 넣었는데」로 헤맨다. update 에서 한쪽만 `null` 로 지우는 것도
 * 같은 이유로 막는다 — 지울 땐 둘 다 `null`.
 */
function assertCtaPair(dto: {
  cta_label?: string | null;
  cta_path?: string | null;
}): void {
  const hasLabel = dto.cta_label !== undefined && dto.cta_label !== null;
  const hasPath = dto.cta_path !== undefined && dto.cta_path !== null;
  const clearsLabel = dto.cta_label === null;
  const clearsPath = dto.cta_path === null;

  if (hasLabel !== hasPath || clearsLabel !== clearsPath) {
    throw new BadRequestException('CTA 는 라벨과 경로를 함께 적어 주세요.');
  }
}

@Injectable()
export class AnnouncementsService {
  constructor(
    @InjectRepository(Announcement)
    private readonly repo: Repository<Announcement>,
  ) {}

  /**
   * 지금 띄울 공지 — **모달 최신 1개 + 배너 최신 1개**(모달 먼저).
   *
   * 하나만 내보내면 새 기능 소개 모달이 뜬 동안 점검 배너를 못 띄운다. 표시 방식이 다르면
   * 화면에서 겹치지 않으므로 type 마다 1개씩 낸다. 같은 type 이 여러 개면 최신 하나만
   * (오래된 공지가 새 공지를 가리지 않게 — 기존 동작 유지).
   *
   * `now` 를 한 번만 계산해 두 질의가 **같은 시각**을 보게 한다.
   */
  async getActive(): Promise<Announcement[]> {
    const now = new Date();
    const inWindow = {
      active: true,
      starts_at: Or(IsNull(), LessThanOrEqual(now)),
      ends_at: Or(IsNull(), MoreThanOrEqual(now)),
    };

    const [modal, banner] = await Promise.all([
      this.repo.findOne({
        where: { ...inWindow, type: 'modal' },
        order: { created_at: 'DESC' },
      }),
      this.repo.findOne({
        where: { ...inWindow, type: 'banner' },
        order: { created_at: 'DESC' },
      }),
    ]);

    return [modal, banner].filter((a): a is Announcement => a !== null);
  }

  findAll(): Promise<Announcement[]> {
    return this.repo.find({ order: { created_at: 'DESC' } });
  }

  create(dto: CreateAnnouncementDto): Promise<Announcement> {
    const starts = dto.starts_at ? new Date(dto.starts_at) : null;
    const ends = dto.ends_at ? new Date(dto.ends_at) : null;
    // LRR P2T3 PR X (MED-T3-1): starts > ends 논리 차단 (getActive가 절대 매칭 안 되는 row 방지)
    assertStartsBeforeEnds(starts, ends);
    assertCtaPair(dto);
    const entity = this.repo.create({
      ...dto,
      kind: dto.kind ?? 'notice',
      starts_at: starts,
      ends_at: ends,
    });
    return this.repo.save(entity);
  }

  async update(id: string, dto: UpdateAnnouncementDto): Promise<Announcement> {
    const announcement = await this.repo.findOne({ where: { id } });
    if (!announcement) throw new NotFoundException('공지를 찾을 수 없습니다.');

    assertCtaPair(dto);

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
