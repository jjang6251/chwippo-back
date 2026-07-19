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

    it('[실사고 재현] DTO 인스턴스의 own `undefined` 필드가 기존값을 지우지 않는다', async () => {
      // ValidationPipe 가 만든 DTO 클래스 인스턴스는 안 보낸 필드도
      // own property `undefined` 로 가짐 → spread 시 기존값 파괴 (master 소실 2026-07-19)
      repo.findOne.mockResolvedValue({
        id: 'u1',
        alarmConfig: {
          master: true,
          briefingEnabled: true,
          deadlinePoints: 'd7',
          briefingHour: 9,
          deadlineUrgentEnabled: true,
        },
      } as unknown as User);
      repo.update.mockResolvedValue({} as UpdateResult);

      const hostilePartial = {
        master: undefined,
        briefingEnabled: false,
        deadlinePoints: undefined,
        briefingHour: undefined,
        eventToggles: undefined,
        deadlineUrgentEnabled: undefined,
      };
      const result = await service.update('u1', hostilePartial);

      expect(result.master).toBe(true); // undefined 로 덮이지 않음
      expect(result.deadlinePoints).toBe('d7');
      expect(result.briefingHour).toBe(9);
      expect(result.deadlineUrgentEnabled).toBe(true);
      expect(result.briefingEnabled).toBe(false); // 실제 보낸 값만 반영
      // 저장 객체에 undefined 키 자체가 없어야 함 (JSONB 키 탈락 방지)
      const saved = repo.update.mock.calls[0][1] as {
        alarmConfig: Record<string, unknown>;
      };
      expect(Object.values(saved.alarmConfig)).not.toContain(undefined);
      expect(saved.alarmConfig.master).toBe(true);
    });

    it('[실사고 재현] eventToggles 내부 undefined 도 기존 유형을 지우지 않는다', async () => {
      repo.findOne.mockResolvedValue({
        id: 'u1',
        alarmConfig: {
          master: true,
          eventToggles: { interview: false },
        },
      } as unknown as User);
      repo.update.mockResolvedValue({} as UpdateResult);

      const result = await service.update('u1', {
        eventToggles: {
          exam: false,
          interview: undefined,
          deadline: undefined,
        },
      });

      expect(result.eventToggles.exam).toBe(false); // 보낸 값 반영
      expect(result.eventToggles.interview).toBe(false); // 기존 유지 (undefined 로 안 덮임)
      expect(result.eventToggles.deadline).toBe(true); // 기본값 유지
    });

    it('briefingHour update → 저장·반환', async () => {
      repo.findOne.mockResolvedValue({
        id: 'u1',
        alarmConfig: null,
      } as User);
      repo.update.mockResolvedValue({} as UpdateResult);

      const result = await service.update('u1', { briefingHour: 9 });

      expect(result.briefingHour).toBe(9);
    });

    it('레거시 master:false 저장값 위 update → 채널 강등된 현재값 기준 merge + master true 로 저장 (lazy 정규화)', async () => {
      repo.findOne.mockResolvedValue({
        id: 'u1',
        alarmConfig: { master: false, briefingEnabled: true },
      } as unknown as User);
      repo.update.mockResolvedValue({} as UpdateResult);

      // 전체 알림 ON (select-all) — 프론트 새 모델의 patch
      const result = await service.update('u1', {
        briefingEnabled: true,
        deadlineUrgentEnabled: true,
        imminentEnabled: true,
      });

      expect(result.master).toBe(true);
      expect(result.briefingEnabled).toBe(true);
      expect(result.deadlineUrgentEnabled).toBe(true);
      expect(result.imminentEnabled).toBe(true);
      // 저장값도 master:true 로 정규화됨 (레거시 값 잔존 X)
      const saved = repo.update.mock.calls[0][1] as {
        alarmConfig: { master: boolean };
      };
      expect(saved.alarmConfig.master).toBe(true);
    });

    it('레거시 master:false + 빈 patch → 채널 전부 false 로 강등 저장 (구 의미 보존)', async () => {
      repo.findOne.mockResolvedValue({
        id: 'u1',
        alarmConfig: { master: false },
      } as unknown as User);
      repo.update.mockResolvedValue({} as UpdateResult);

      const result = await service.update('u1', {});

      expect(result.master).toBe(true);
      expect(result.briefingEnabled).toBe(false);
      expect(result.deadlineUrgentEnabled).toBe(false);
      expect(result.imminentEnabled).toBe(false);
    });

    it('eventToggles 부분 update → 기존 유형 유지 + 나머지 기본 true', async () => {
      // 기존에 deadline=false 저장돼 있음
      repo.findOne.mockResolvedValue({
        id: 'u1',
        alarmConfig: { eventToggles: { deadline: false } },
      } as unknown as User);
      repo.update.mockResolvedValue({} as UpdateResult);

      // interview 만 끄는 부분 update
      const result = await service.update('u1', {
        eventToggles: { interview: false },
      });

      expect(result.eventToggles.deadline).toBe(false); // 기존 유지 (덮어쓰기 X)
      expect(result.eventToggles.interview).toBe(false); // 새로 반영
      expect(result.eventToggles.exam).toBe(true); // 기본
      expect(result.eventToggles.resultDate).toBe(true);
      expect(result.eventToggles.todo).toBe(true);
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
