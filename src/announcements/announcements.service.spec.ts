import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
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
    active: true,
    starts_at: null,
    ends_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('AnnouncementsService', () => {
  let service: AnnouncementsService;
  let repo: jest.Mocked<Repository<Announcement>>;

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
    it('활성 공지가 있으면 반환한다', async () => {
      const item = makeAnnouncement();
      repo.findOne.mockResolvedValue(item);
      const result = await service.getActive();
      expect(result).toBe(item);
      expect(repo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ active: true }) }),
      );
    });

    it('활성 공지가 없으면 null 반환한다', async () => {
      repo.findOne.mockResolvedValue(null);
      const result = await service.getActive();
      expect(result).toBeNull();
    });

    it('starts_at·ends_at 시간 범위 조건과 created_at DESC 정렬로 findOne을 호출한다', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.getActive();
      const callArg = repo.findOne.mock.calls[0][0] as any;
      expect(callArg.where).toHaveProperty('starts_at');
      expect(callArg.where).toHaveProperty('ends_at');
      expect(callArg.order).toEqual({ created_at: 'DESC' });
    });

    it('starts_at·ends_at이 null인 시간 제한 없는 공지도 반환한다', async () => {
      const item = makeAnnouncement({ starts_at: null, ends_at: null });
      repo.findOne.mockResolvedValue(item);
      const result = await service.getActive();
      expect(result).toBe(item);
    });

    it('활성 공지가 여러 개일 때 findOne으로 최신 1개만 반환한다', async () => {
      const latest = makeAnnouncement({ id: 'latest', created_at: new Date('2026-05-01') });
      repo.findOne.mockResolvedValue(latest);
      const result = await service.getActive();
      expect(result).toBe(latest);
      expect(repo.findOne).toHaveBeenCalledTimes(1);
      const callArg = repo.findOne.mock.calls[0][0] as any;
      expect(callArg.order).toEqual({ created_at: 'DESC' });
    });
  });

  describe('findAll', () => {
    it('전체 공지를 created_at DESC로 반환한다', async () => {
      const items = [makeAnnouncement({ id: 'a' }), makeAnnouncement({ id: 'b' })];
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
      const dto = { title: '공지', body: '내용', type: 'banner' as const, active: true, starts_at: null, ends_at: null };
      const result = await service.create(dto);
      expect(repo.create).toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(entity);
      expect(result).toBe(entity);
    });

    it('starts_at·ends_at 문자열을 Date로 변환한다', async () => {
      const entity = makeAnnouncement({ starts_at: new Date('2026-06-01T00:00:00Z') });
      repo.create.mockReturnValue(entity);
      repo.save.mockResolvedValue(entity);
      const dto = {
        title: '공지', body: '내용', type: 'banner' as const, active: false,
        starts_at: '2026-06-01T00:00:00.000Z',
        ends_at: null,
      };
      await service.create(dto);
      const createArg = repo.create.mock.calls[0][0] as Partial<Announcement>;
      expect(createArg.starts_at).toBeInstanceOf(Date);
      expect(createArg.ends_at).toBeNull();
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
      await expect(service.update('not-exist', { title: 'x' })).rejects.toThrow(NotFoundException);
    });

    it('ends_at을 null로 명시하면 null로 업데이트한다', async () => {
      const existing = makeAnnouncement({ ends_at: new Date('2026-12-31T00:00:00Z') });
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
      repo.save.mockResolvedValue({ ...existing, starts_at: new Date('2026-06-01T00:00:00Z') });
      await service.update('uuid-1', { starts_at: '2026-06-01T00:00:00.000Z' });
      const savedArg = repo.save.mock.calls[0][0] as Announcement;
      expect(savedArg.starts_at).toBeInstanceOf(Date);
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
      await expect(service.remove('not-exist')).rejects.toThrow(NotFoundException);
    });
  });
});
