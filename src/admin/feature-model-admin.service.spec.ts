import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { FeatureModelConfig } from '../ai/entities/feature-model-config.entity';
import { MODEL_REGISTRY } from '../ai/model-registry';
import { AdminAuditService } from './admin-audit.service';
import { FeatureModelAdminService } from './feature-model-admin.service';

/**
 * G-1 — 모델 전환은 **재배포 관문이 없다.** 잘못 누르면 즉시 반영되므로
 * 저장 시 검증이 유일한 방어선이다.
 *
 * 검증 3종: ① 화이트리스트 ② 출력 한도 ③ 스트리밍 요구
 * (스키마 strict 호환은 `model-registry.spec` 이 **빌드 시점에** 강제 — 런타임 중복 X)
 */
describe('FeatureModelAdminService', () => {
  let repo: { find: jest.Mock };
  let manager: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let audit: { log: jest.Mock };
  let service: FeatureModelAdminService;

  const HAIKU = 'claude-haiku-4-5-20251001';
  const ADMIN = 'admin-1';

  beforeEach(() => {
    repo = { find: jest.fn().mockResolvedValue([]) };
    manager = {
      findOne: jest.fn().mockResolvedValue({
        feature: 'coverletter_feedback',
        provider: 'anthropic',
        model: HAIKU,
        updatedBy: null,
      }),
      create: jest.fn((_e, v) => v),
      save: jest.fn(async (_e, v) => v),
    };
    audit = { log: jest.fn() };

    service = new FeatureModelAdminService(
      repo as unknown as Repository<FeatureModelConfig>,
      {
        transaction: (cb: (m: typeof manager) => unknown) => cb(manager),
      } as unknown as DataSource,
      { get: () => undefined } as unknown as ConfigService,
      audit as unknown as AdminAuditService,
    );
  });

  describe('① 화이트리스트', () => {
    it('레지스트리 밖 모델은 400', async () => {
      await expect(
        service.updateModel(ADMIN, 'coverletter_feedback', {
          model: 'gpt-9-ultra',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('별칭으로 보내도 정식 id 로 저장된다', async () => {
      const r = await service.updateModel(ADMIN, 'coverletter_feedback', {
        model: 'claude-haiku-4-5',
      });
      expect(r.model).toBe(HAIKU);
    });
  });

  describe('② 출력 한도', () => {
    /**
     * 🔴 feature cap 이 모델 상한을 넘으면 **호출 시 API 400** 이 난다.
     * 저장 시점에 막지 않으면 관리자는 "저장은 됐는데 기능이 죽는" 상태를 만든다.
     */
    it('feature cap 이 모델 상한을 넘으면 400 + 사유에 숫자 포함', async () => {
      const SMALL = 'test-only-small-output';
      MODEL_REGISTRY[SMALL] = {
        ...MODEL_REGISTRY[HAIKU],
        maxOutputTokens: 100, // coverletter_feedback 은 6,000 필요
      };
      try {
        await expect(
          service.updateModel(ADMIN, 'coverletter_feedback', { model: SMALL }),
        ).rejects.toThrow(/출력 한도 초과/);
      } finally {
        delete MODEL_REGISTRY[SMALL];
      }
    });

    it('상한 안이면 통과', async () => {
      await expect(
        service.updateModel(ADMIN, 'coverletter_feedback', { model: HAIKU }),
      ).resolves.toBeDefined();
    });
  });

  describe('③ 스트리밍 요구', () => {
    /**
     * 🔴 `coverletter_chat` 은 `callStream` 을 쓴다. 스트리밍 미지원 모델로 바꾸면
     * 기능이 통째로 죽는다. "경고만 하고 허용" 은 안 된다 — 무시하면 사용자가 즉시
     * 깨진 화면을 본다.
     */
    it('스트리밍 필수 feature 를 미지원 모델로 바꾸면 400', async () => {
      manager.findOne.mockResolvedValue({
        feature: 'coverletter_chat',
        provider: 'anthropic',
        model: HAIKU,
        updatedBy: null,
      });

      await expect(
        service.updateModel(ADMIN, 'coverletter_chat', {
          model: 'gpt-4o-mini', // supportsStreaming: false
        }),
      ).rejects.toThrow(/실시간 응답/);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('스트리밍이 필요 없는 feature 는 같은 모델로 바꿔도 통과', async () => {
      await expect(
        service.updateModel(ADMIN, 'coverletter_feedback', {
          model: 'gpt-4o-mini',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('저장 · audit', () => {
    it('provider 를 모델에서 파생한다 (클라이언트가 안 보냄 → 불일치 불가)', async () => {
      const r = await service.updateModel(ADMIN, 'coverletter_feedback', {
        model: 'gpt-4o-mini',
      });
      expect(r.provider).toBe('openai');
      expect(r.model).toBe('gpt-4o-mini');
      expect(r.updatedBy).toBe(ADMIN);
    });

    it('before/after 를 audit 에 남긴다 (같은 트랜잭션)', async () => {
      await service.updateModel(ADMIN, 'coverletter_feedback', {
        model: 'gpt-4o-mini',
      });

      expect(audit.log).toHaveBeenCalledTimes(1);
      const [adminId, action, targetType, targetId, detail, mgr] =
        audit.log.mock.calls[0];
      expect(adminId).toBe(ADMIN);
      expect(action).toBe('update_feature_model');
      expect(targetType).toBe('feature_model_config');
      expect(targetId).toBe('coverletter_feedback');
      expect(detail.before).toEqual({ provider: 'anthropic', model: HAIKU });
      expect(detail.after).toEqual({
        provider: 'openai',
        model: 'gpt-4o-mini',
      });
      expect(mgr).toBe(manager); // 트랜잭션 매니저 전달 — 실패 시 함께 롤백
    });

    it('동시 수정 방어 — 비관적 락으로 행을 잠근다', async () => {
      await service.updateModel(ADMIN, 'coverletter_feedback', {
        model: 'gpt-4o-mini',
      });
      expect(manager.findOne).toHaveBeenCalledWith(
        FeatureModelConfig,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('행이 없으면 400 (마이그레이션 누락 상태)', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.updateModel(ADMIN, 'coverletter_feedback', { model: HAIKU }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listAll — 화면이 판단 근거를 갖게', () => {
    beforeEach(() => {
      repo.find.mockResolvedValue([
        {
          feature: 'coverletter_chat',
          provider: 'anthropic',
          model: HAIKU,
          updatedBy: null,
          updatedAt: new Date('2026-08-02T00:00:00Z'),
        },
      ]);
    });

    it('원가 배수를 함께 준다 (anchor $1/M 대비)', async () => {
      const [row] = await service.listAll();
      expect(row.costMultiplier).toBe(1); // Haiku input $1 = anchor
      const sonnet = row.selectable.find((m) => m.id === 'claude-sonnet-4-6')!;
      expect(sonnet.costMultiplier).toBe(3); // $3/M
    });

    /** 못 고르는 모델을 목록에서 지우지 않고 **이유와 함께** 준다 — 화면이 회색 처리 + 사유 표시 */
    it('선택 불가 모델은 사유를 준다 (숨기지 않음)', async () => {
      const [row] = await service.listAll();
      const blocked = row.selectable.find((m) => m.id === 'gpt-4o-mini')!;
      expect(blocked.blockedReason).toMatch(/실시간 응답/);

      const ok = row.selectable.find((m) => m.id === HAIKU)!;
      expect(ok.blockedReason).toBeNull();
    });

    it('스트리밍 요구 여부를 노출한다', async () => {
      const [row] = await service.listAll();
      expect(row.requiresStreaming).toBe(true);
    });

    /**
     * 🔴 DB 에 레지스트리 밖 모델이 남아 있는 상태 — 레지스트리에서 모델을 **제거**하면
     * 생긴다. 화면이 터지지 않고 "(미등록)" 으로 드러나야 관리자가 고칠 수 있다.
     */
    it('레지스트리 밖 모델이 DB 에 있으면 (미등록) 으로 표시하고 단가는 0', async () => {
      repo.find.mockResolvedValue([
        {
          feature: 'coverletter_chat',
          provider: 'anthropic',
          model: 'gpt-9-ultra',
          updatedBy: null,
          updatedAt: null,
        },
      ]);

      const [row] = await service.listAll();

      expect(row.label).toBe('gpt-9-ultra (미등록)');
      expect(row.costMultiplier).toBe(0);
      expect(row.inputUsd).toBe(0);
      // updatedAt 이 없어도 null 로 정규화 (화면이 undefined 를 그리지 않게)
      expect(row.updatedAt).toBeNull();
      // 선택지는 정상적으로 제공돼야 고칠 수 있다
      expect(row.selectable.length).toBeGreaterThan(0);
    });
  });
});
