import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { FindOperator, Repository } from 'typeorm';
import { ForbiddenException } from '@nestjs/common';
import { UserDevice } from './user-device.entity';
import { UserDevicesService } from './user-devices.service';
import { DiscordNotifier } from '../common/discord-notifier';
import type { RegisterDeviceDto } from './dto/register-device.dto';

/**
 * UserDevicesService spec.
 *
 * 시나리오:
 *   1) registerDevice — 신규 · 같은 사용자 재등록 (upsert) · 다른 사용자 재사용 (기기 이전)
 *   2) app_version 갱신 · lastActiveAt 갱신
 *   3) 최근 활동 device 5+ 시 Discord alert (fair-use) · 죽은 행 제외 · 하루 1회 억제
 *   4) removeDevice — 정상 · 없음 (no-op) · 다른 사용자 (ForbiddenException · IDOR)
 *   5) listMyDevices — lastActiveAt DESC 정렬
 *
 * ⚠️ 알람 억제 Map 은 **모듈 레벨**이라 테스트 간에도 살아남는다.
 * 알람 경로를 타는 케이스는 서로 다른 userId 를 쓴다 (앞 테스트가 뒤를 억제하지 않도록).
 */
describe('UserDevicesService', () => {
  let service: UserDevicesService;
  let repo: jest.Mocked<Repository<UserDevice>>;
  let discord: jest.Mocked<DiscordNotifier>;

  const baseDto: RegisterDeviceDto = {
    deviceToken: 'token-1234567890',
    platform: 'ios',
    appVersion: '1.0.0',
  };

  beforeEach(async () => {
    const mockRepo = mock<Repository<UserDevice>>();
    mockRepo.create.mockImplementation((data) => data as UserDevice);
    mockRepo.save.mockImplementation(async (entity) => ({
      ...(entity as UserDevice),
      id: 'device-uuid-1',
      createdAt: new Date('2026-07-02'),
    }));

    const mockDiscord = mock<DiscordNotifier>();
    mockDiscord.notify.mockResolvedValue('sent');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserDevicesService,
        { provide: getRepositoryToken(UserDevice), useValue: mockRepo },
        { provide: DiscordNotifier, useValue: mockDiscord },
      ],
    }).compile();

    service = module.get(UserDevicesService);
    repo = module.get(getRepositoryToken(UserDevice));
    discord = module.get(DiscordNotifier);
  });

  afterEach(() => jest.clearAllMocks());

  describe('registerDevice', () => {
    it('신규 token → INSERT · userId · platform · appVersion 저장', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      repo.count.mockResolvedValueOnce(1);

      await service.registerDevice('user-1', baseDto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          deviceToken: 'token-1234567890',
          platform: 'ios',
          appVersion: '1.0.0',
        }),
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('같은 사용자 재등록 → lastActiveAt · appVersion 갱신 (idempotent)', async () => {
      const existing = {
        id: 'existing-1',
        userId: 'user-1',
        deviceToken: 'token-1234567890',
        platform: 'ios',
        appVersion: '0.9.0',
        lastActiveAt: new Date('2026-06-01'),
      } as UserDevice;
      repo.findOne.mockResolvedValueOnce(existing);

      await service.registerDevice('user-1', {
        ...baseDto,
        appVersion: '2.0.0',
      });

      expect(repo.remove).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'existing-1',
          userId: 'user-1',
          appVersion: '2.0.0',
        }),
      );
    });

    it('다른 사용자 → 이전 record 삭제 후 신규 INSERT (기기 이전)', async () => {
      const previous = {
        id: 'prev-1',
        userId: 'user-old',
        deviceToken: 'token-1234567890',
      } as UserDevice;
      repo.findOne.mockResolvedValueOnce(previous);
      repo.count.mockResolvedValueOnce(1);

      await service.registerDevice('user-new', baseDto);

      expect(repo.remove).toHaveBeenCalledWith(previous);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-new' }),
      );
    });

    it('appVersion 없이 재등록 → 기존 appVersion 유지', async () => {
      const existing = {
        id: 'e-1',
        userId: 'user-1',
        deviceToken: 'token-1234567890',
        platform: 'ios',
        appVersion: '1.0.0',
        lastActiveAt: new Date(),
      } as UserDevice;
      repo.findOne.mockResolvedValueOnce(existing);

      await service.registerDevice('user-1', {
        deviceToken: 'token-1234567890',
        platform: 'ios',
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ appVersion: '1.0.0' }),
      );
    });

    it('활성 device 5+ → Discord alert 발송 (ops 채널 · fair-use)', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      repo.count.mockResolvedValueOnce(5);

      await service.registerDevice('user-alert-5', baseDto);
      await new Promise((r) => setImmediate(r));

      expect(discord.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: '⚠️ Multi-device alert' }),
        'ops',
      );
    });

    it('활성 device 4 → Discord alert 미발송', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      repo.count.mockResolvedValueOnce(4);

      await service.registerDevice('user-alert-4', baseDto);
      await new Promise((r) => setImmediate(r));

      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('활성 4 + 죽은(31일 전) 3 → 카운트는 활성만 · alert 미발송', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      // count 는 lastActiveAt >= cutoff 조건이 붙으므로 죽은 3행은 애초에 안 세진다
      repo.count.mockResolvedValueOnce(4);

      await service.registerDevice('user-dead-rows', baseDto);
      await new Promise((r) => setImmediate(r));

      const where = repo.count.mock.calls[0][0]?.where as {
        userId: string;
        lastActiveAt: FindOperator<Date>;
      };
      expect(where.userId).toBe('user-dead-rows');
      // 30일 전 cutoff 이상만 카운트 (죽은 행 제외)
      const cutoff = where.lastActiveAt.value;
      const daysAgo = (Date.now() - cutoff.getTime()) / 86_400_000;
      expect(daysAgo).toBeCloseTo(30, 1);
      expect(discord.notify).not.toHaveBeenCalled();
    });

    it('같은 유저 연속 등록 → alert 1회만 (하루 1회 억제)', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.count.mockResolvedValue(6);

      await service.registerDevice('user-suppress', baseDto);
      await service.registerDevice('user-suppress', baseDto);
      await service.registerDevice('user-suppress', baseDto);
      await new Promise((r) => setImmediate(r));

      expect(discord.notify).toHaveBeenCalledTimes(1);
    });

    it('하루 지난 뒤 재등록 → alert 다시 1회', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.count.mockResolvedValue(6);
      const t0 = new Date('2026-08-13T10:00:00Z').getTime();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);

      await service.registerDevice('user-cooldown', baseDto);
      nowSpy.mockReturnValue(t0 + 25 * 60 * 60 * 1000); // 25시간 뒤
      await service.registerDevice('user-cooldown', baseDto);
      await new Promise((r) => setImmediate(r));

      expect(discord.notify).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
    });

    it('Discord alert 실패해도 register 는 정상 성공', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      repo.count.mockResolvedValueOnce(10);
      discord.notify.mockRejectedValueOnce(new Error('webhook down'));

      await expect(
        service.registerDevice('user-alert-fail', baseDto),
      ).resolves.toBeTruthy();
    });
  });

  describe('listMyDevices', () => {
    it('user 본인 device 목록 · lastActiveAt DESC', async () => {
      const devices = [
        { id: 'd1', userId: 'user-1' } as UserDevice,
        { id: 'd2', userId: 'user-1' } as UserDevice,
      ];
      repo.find.mockResolvedValue(devices);

      const result = await service.listMyDevices('user-1');

      expect(repo.find).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        order: { lastActiveAt: 'DESC' },
      });
      expect(result).toBe(devices);
    });

    it('device 없는 user → 빈 배열', async () => {
      repo.find.mockResolvedValue([]);
      const result = await service.listMyDevices('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('removeDevice', () => {
    it('본인 device 삭제 → repo.remove 호출', async () => {
      const device = {
        id: 'd1',
        userId: 'user-1',
        deviceToken: 'my-token',
      } as UserDevice;
      repo.findOne.mockResolvedValue(device);

      await service.removeDevice('user-1', 'my-token');

      expect(repo.remove).toHaveBeenCalledWith(device);
    });

    it('존재하지 않는 token → no-op (idempotent · throw X)', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.removeDevice('user-1', 'ghost'),
      ).resolves.toBeUndefined();
      expect(repo.remove).not.toHaveBeenCalled();
    });

    it('다른 사용자 token → ForbiddenException (IDOR 방어)', async () => {
      const device = {
        id: 'd1',
        userId: 'user-other',
        deviceToken: 'stolen-token',
      } as UserDevice;
      repo.findOne.mockResolvedValue(device);

      await expect(
        service.removeDevice('user-1', 'stolen-token'),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });
});
