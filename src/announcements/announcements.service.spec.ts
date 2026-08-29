/**
 * AnnouncementsService
 *
 * getActive — 모달 1 + 배너 1 동시 노출 (2026-08-30 kind·CTA 아크):
 * - 모달·배너 각각 활성 → 2개, **모달 먼저**
 * - 모달만 / 배너만 → 1개
 * - 하나도 없음 → []
 * - type 별 질의 각각에 창 조건(starts/ends)·created_at DESC 가 붙는가
 * - 두 질의가 **같은 시각**을 본다 (질의 사이 자정이 지나도 판정이 갈리지 않게)
 *   ※ 창 밖 실제 제외는 실 DB 가 필요 → e2e (announcements-starts-ends)
 *
 * create/update — kind 기본값 · CTA 짝 규칙:
 * - kind 생략 → 'notice' / 지정 → 그대로
 * - CTA 라벨+경로 → 저장 / 한쪽만 → 400
 * - update: 둘 다 null → 비움 / 한쪽만 null → 400
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FindOneOptions, FindOptionsWhere, Repository } from 'typeorm';
import { AnnouncementsService } from './announcements.service';
import { Announcement } from './announcement.entity';

const mockRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
});

function makeAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'uuid-1',
    title: '테스트 공지',
    body: '내용',
    type: 'banner',
    kind: 'notice',
    active: true,
    cta_label: null,
    cta_path: null,
    starts_at: null,
    ends_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** findOne 호출의 where 를 단일 조건으로 좁힌다 (배열 where 는 이 서비스가 쓰지 않는다) */
function whereOf(
  options: FindOneOptions<Announcement>,
): FindOptionsWhere<Announcement> {
  const where = options.where;
  if (!where || Array.isArray(where)) {
    throw new Error('단일 객체 where 를 기대했다');
  }
  return where;
}

describe('AnnouncementsService', () => {
  let service: AnnouncementsService;
  let repo: jest.Mocked<Repository<Announcement>>;

  /** type 조건에 따라 다른 공지를 돌려주는 findOne mock */
  function mockByType(map: {
    modal: Announcement | null;
    banner: Announcement | null;
  }): void {
    repo.findOne.mockImplementation((options: FindOneOptions<Announcement>) =>
      Promise.resolve(
        whereOf(options).type === 'modal' ? map.modal : map.banner,
      ),
    );
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnnouncementsService,
        { provide: getRepositoryToken(Announcement), useFactory: mockRepo },
      ],
    }).compile();

    service = module.get(AnnouncementsService);
    repo = module.get(getRepositoryToken(Announcement));
  });

  describe('getActive', () => {
    it('모달·배너가 각각 활성이면 둘 다, 모달을 먼저 반환한다', async () => {
      const modal = makeAnnouncement({ id: 'm1', type: 'modal' });
      const banner = makeAnnouncement({ id: 'b1', type: 'banner' });
      mockByType({ modal, banner });

      const result = await service.getActive();

      expect(result).toEqual([modal, banner]);
      expect(repo.findOne).toHaveBeenCalledTimes(2);
    });

    it('모달만 활성이면 모달 1개만 반환한다', async () => {
      const modal = makeAnnouncement({ id: 'm1', type: 'modal' });
      mockByType({ modal, banner: null });

      await expect(service.getActive()).resolves.toEqual([modal]);
    });

    it('배너만 활성이면 배너 1개만 반환한다', async () => {
      const banner = makeAnnouncement({ id: 'b1', type: 'banner' });
      mockByType({ modal: null, banner });

      await expect(service.getActive()).resolves.toEqual([banner]);
    });

    it('활성 공지가 하나도 없으면 빈 배열을 반환한다', async () => {
      mockByType({ modal: null, banner: null });

      await expect(service.getActive()).resolves.toEqual([]);
    });

    it('type별 질의에 active·창 조건·created_at DESC가 모두 붙는다', async () => {
      mockByType({ modal: null, banner: null });
      await service.getActive();

      const [modalCall, bannerCall] = repo.findOne.mock.calls.map((c) => c[0]);
      expect(whereOf(modalCall).type).toBe('modal');
      expect(whereOf(bannerCall).type).toBe('banner');

      for (const call of [modalCall, bannerCall]) {
        expect(whereOf(call).active).toBe(true);
        expect(whereOf(call)).toHaveProperty('starts_at');
        expect(whereOf(call)).toHaveProperty('ends_at');
        expect(call.order).toEqual({ created_at: 'DESC' });
      }
    });

    it('두 질의가 같은 시각(now)으로 창을 판정한다', async () => {
      mockByType({ modal: null, banner: null });
      await service.getActive();

      const [modalCall, bannerCall] = repo.findOne.mock.calls.map((c) => c[0]);
      // 같은 FindOperator 인스턴스를 공유 = 질의 사이에 시계가 움직이지 않는다
      expect(whereOf(modalCall).starts_at).toBe(whereOf(bannerCall).starts_at);
      expect(whereOf(modalCall).ends_at).toBe(whereOf(bannerCall).ends_at);
    });

    it('starts_at·ends_at이 null인 시간 제한 없는 공지도 반환한다', async () => {
      const banner = makeAnnouncement({ starts_at: null, ends_at: null });
      mockByType({ modal: null, banner });

      await expect(service.getActive()).resolves.toEqual([banner]);
    });
  });

  describe('findAll', () => {
    it('전체 공지를 created_at DESC로 반환한다', async () => {
      const items = [
        makeAnnouncement({ id: 'a' }),
        makeAnnouncement({ id: 'b' }),
      ];
      repo.find.mockResolvedValue(items);
      const result = await service.findAll();
      expect(result).toEqual(items);
      expect(repo.find).toHaveBeenCalledWith({ order: { created_at: 'DESC' } });
    });

    it('공지가 없으면 빈 배열을 반환한다', async () => {
      repo.find.mockResolvedValue([]);
      const result = await service.findAll();
      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    it('dto로 공지를 생성하고 저장한다', async () => {
      const entity = makeAnnouncement();
      repo.create.mockReturnValue(entity);
      repo.save.mockResolvedValue(entity);
      const dto = {
        title: '공지',
        body: '내용',
        type: 'banner' as const,
        active: true,
        starts_at: undefined,
        ends_at: undefined,
      };
      const result = await service.create(dto);
      expect(repo.create).toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(entity);
      expect(result).toBe(entity);
    });

    it('starts_at·ends_at 문자열을 Date로 변환한다', async () => {
      const entity = makeAnnouncement({
        starts_at: new Date('2026-06-01T00:00:00Z'),
      });
      repo.create.mockReturnValue(entity);
      repo.save.mockResolvedValue(entity);
      const dto = {
        title: '공지',
        body: '내용',
        type: 'banner' as const,
        active: false,
        starts_at: '2026-06-01T00:00:00.000Z',
        ends_at: undefined,
      };
      await service.create(dto);
      const createArg = repo.create.mock.calls[0][0] as Partial<Announcement>;
      expect(createArg.starts_at).toBeInstanceOf(Date);
      expect(createArg.ends_at).toBeNull();
    });

    const baseDto = {
      title: '공지',
      body: '내용',
      type: 'banner' as const,
      active: true,
    };

    it("kind를 생략하면 'notice'로 채운다", async () => {
      const entity = makeAnnouncement();
      repo.create.mockReturnValue(entity);
      repo.save.mockResolvedValue(entity);

      await service.create(baseDto);

      const createArg = repo.create.mock.calls[0][0] as Partial<Announcement>;
      expect(createArg.kind).toBe('notice');
    });

    it('kind를 지정하면 그대로 저장한다', async () => {
      const entity = makeAnnouncement({ kind: 'feature' });
      repo.create.mockReturnValue(entity);
      repo.save.mockResolvedValue(entity);

      await service.create({ ...baseDto, kind: 'feature' });

      const createArg = repo.create.mock.calls[0][0] as Partial<Announcement>;
      expect(createArg.kind).toBe('feature');
    });

    it('CTA 라벨·경로를 함께 주면 그대로 저장한다', async () => {
      const entity = makeAnnouncement({
        cta_label: '지금 해보기',
        cta_path: '/board?add=posting',
      });
      repo.create.mockReturnValue(entity);
      repo.save.mockResolvedValue(entity);

      await service.create({
        ...baseDto,
        cta_label: '지금 해보기',
        cta_path: '/board?add=posting',
      });

      const createArg = repo.create.mock.calls[0][0] as Partial<Announcement>;
      expect(createArg.cta_label).toBe('지금 해보기');
      expect(createArg.cta_path).toBe('/board?add=posting');
    });

    // create 는 async 가 아니라 검증 실패가 **동기 throw** 로 나온다 (기존 starts/ends 검증과 동일)
    it('CTA 라벨만 주면 BadRequestException을 던지고 저장하지 않는다', () => {
      expect(() =>
        service.create({ ...baseDto, cta_label: '지금 해보기' }),
      ).toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('CTA 경로만 주면 BadRequestException을 던지고 저장하지 않는다', () => {
      expect(() => service.create({ ...baseDto, cta_path: '/board' })).toThrow(
        BadRequestException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('공지를 수정하고 반환한다', async () => {
      const existing = makeAnnouncement();
      const updated = { ...existing, title: '변경된 제목' };
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue(updated);
      const result = await service.update('uuid-1', { title: '변경된 제목' });
      expect(result.title).toBe('변경된 제목');
    });

    it('존재하지 않는 id면 NotFoundException을 던진다', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.update('not-exist', { title: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('ends_at을 null로 명시하면 null로 업데이트한다', async () => {
      const existing = makeAnnouncement({
        ends_at: new Date('2026-12-31T00:00:00Z'),
      });
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue({ ...existing, ends_at: null });
      await service.update('uuid-1', { ends_at: null });
      expect(repo.save).toHaveBeenCalled();
      const savedArg = repo.save.mock.calls[0][0] as Announcement;
      expect(savedArg.ends_at).toBeNull();
    });

    it('active를 true에서 false로 변경한다', async () => {
      const existing = makeAnnouncement({ active: true });
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue({ ...existing, active: false });
      await service.update('uuid-1', { active: false });
      const savedArg = repo.save.mock.calls[0][0] as Announcement;
      expect(savedArg.active).toBe(false);
    });

    it('active를 false에서 true로 변경한다', async () => {
      const existing = makeAnnouncement({ active: false });
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue({ ...existing, active: true });
      await service.update('uuid-1', { active: true });
      const savedArg = repo.save.mock.calls[0][0] as Announcement;
      expect(savedArg.active).toBe(true);
    });

    it('starts_at 문자열을 Date로 변환한다', async () => {
      const existing = makeAnnouncement({ starts_at: null });
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue({
        ...existing,
        starts_at: new Date('2026-06-01T00:00:00Z'),
      });
      await service.update('uuid-1', { starts_at: '2026-06-01T00:00:00.000Z' });
      const savedArg = repo.save.mock.calls[0][0] as Announcement;
      expect(savedArg.starts_at).toBeInstanceOf(Date);
    });

    it('CTA 라벨·경로를 함께 주면 저장한다', async () => {
      const existing = makeAnnouncement();
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue(existing);

      await service.update('uuid-1', {
        cta_label: '지금 해보기',
        cta_path: '/board?add=posting',
      });

      const savedArg = repo.save.mock.calls[0][0] as Announcement;
      expect(savedArg.cta_label).toBe('지금 해보기');
      expect(savedArg.cta_path).toBe('/board?add=posting');
    });

    it('CTA를 둘 다 null로 주면 비운다', async () => {
      const existing = makeAnnouncement({
        cta_label: '지금 해보기',
        cta_path: '/board',
      });
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue(existing);

      await service.update('uuid-1', { cta_label: null, cta_path: null });

      const savedArg = repo.save.mock.calls[0][0] as Announcement;
      expect(savedArg.cta_label).toBeNull();
      expect(savedArg.cta_path).toBeNull();
    });

    it('CTA 라벨만 null로 지우면 BadRequestException을 던진다 (경로 고아 방지)', async () => {
      const existing = makeAnnouncement({
        cta_label: '지금 해보기',
        cta_path: '/board',
      });
      repo.findOne.mockResolvedValue(existing);

      await expect(
        service.update('uuid-1', { cta_label: null }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('CTA 경로만 바꾸려 하면 BadRequestException을 던진다', async () => {
      const existing = makeAnnouncement();
      repo.findOne.mockResolvedValue(existing);

      await expect(
        service.update('uuid-1', { cta_path: '/board' }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('kind만 바꿔도 CTA 규칙에 걸리지 않는다', async () => {
      const existing = makeAnnouncement();
      repo.findOne.mockResolvedValue(existing);
      repo.save.mockResolvedValue({ ...existing, kind: 'feature' });

      await service.update('uuid-1', { kind: 'feature' });

      const savedArg = repo.save.mock.calls[0][0] as Announcement;
      expect(savedArg.kind).toBe('feature');
    });
  });

  describe('remove', () => {
    it('공지를 삭제한다', async () => {
      const existing = makeAnnouncement();
      repo.findOne.mockResolvedValue(existing);
      repo.remove.mockResolvedValue(existing);
      await expect(service.remove('uuid-1')).resolves.toBeUndefined();
      expect(repo.remove).toHaveBeenCalledWith(existing);
    });

    it('존재하지 않는 id면 NotFoundException을 던진다', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove('not-exist')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
