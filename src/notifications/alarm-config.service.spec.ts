import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository, UpdateResult } from 'typeorm';
import { mock } from 'jest-mock-extended';
import { AlarmConfigService } from './alarm-config.service';
import { User } from '../users/user.entity';
import { DEFAULT_ALARM_CONFIG } from './notification.types';

describe('AlarmConfigService', () => {
  let service: AlarmConfigService;
  let repo: jest.Mocked<Repository<User>>;

  beforeEach(async () => {
    repo = mock<Repository<User>>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlarmConfigService,
        { provide: getRepositoryToken(User), useValue: repo },
      ],
    }).compile();
    service = module.get(AlarmConfigService);
  });

  describe('get', () => {
    it('config NULL → 기본값 반환', async () => {
      repo.findOne.mockResolvedValue({ id: 'u1', alarmConfig: null } as User);
      const config = await service.get('u1');
      expect(config).toEqual(DEFAULT_ALARM_CONFIG);
    });

    it('부분 config → 기본값과 merge', async () => {
      repo.findOne.mockResolvedValue({
        id: 'u1',
        alarmConfig: { briefingEnabled: false },
      } as unknown as User);
      const config = await service.get('u1');
      expect(config.briefingEnabled).toBe(false);
      expect(config.master).toBe(true); // 기본값 유지
      expect(config.deadlinePoints).toBe('d3');
    });

    it('없는 user → NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.get('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('부분 update → 기존과 merge 후 저장 + merged 반환', async () => {
      repo.findOne.mockResolvedValue({
        id: 'u1',
        alarmConfig: { deadlinePoints: 'd7' },
      } as unknown as User);
      repo.update.mockResolvedValue({} as UpdateResult);

      const result = await service.update('u1', { briefingEnabled: false });

      expect(result.briefingEnabled).toBe(false);
      expect(result.deadlinePoints).toBe('d7'); // 기존 유지
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'u1' },
        {
          alarmConfig: expect.objectContaining({
            briefingEnabled: false,
            deadlinePoints: 'd7',
          }),
        },
      );
    });

    it('없는 user → NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.update('nope', {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('recordPrompt', () => {
    it('promptedAt + granted 저장', async () => {
      repo.update.mockResolvedValue({ affected: 1 } as UpdateResult);
      await service.recordPrompt('u1', true);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'u1' },
        expect.objectContaining({ alarmPermissionGranted: true }),
      );
    });

    it('affected 0 (없는 user) → NotFoundException', async () => {
      repo.update.mockResolvedValue({ affected: 0 } as UpdateResult);
      await expect(service.recordPrompt('nope', true)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('syncPermission', () => {
    it('granted 상태 업데이트', async () => {
      repo.update.mockResolvedValue({} as UpdateResult);
      await service.syncPermission('u1', false);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'u1' },
        { alarmPermissionGranted: false },
      );
    });
  });
});
