import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { FeatureModelConfig } from './entities/feature-model-config.entity';
import { ModelConfigService } from './model-config.service';

/**
 * G-1 — 모델 해석 **DB → env → 코드 기본값** 3단 폴백.
 *
 * 각 단이 아래 단을 무효화하지 않는 게 핵심이다. DB 행을 지우면 자동으로 env 로
 * 되돌아가므로 **롤백이 "행 삭제" 만으로 끝난다.** 그 성질을 여기서 고정한다.
 */
describe('ModelConfigService', () => {
  let repo: { findOne: jest.Mock };
  let service: ModelConfigService;

  /**
   * env 가 모델을 주는 현재 운영 상태.
   *
   * ⚠️ 이 spec 의 주제는 **3단 해석(DB → env → 코드 기본값)** 이지 특정 모델이 아니다.
   * 그런데 대상 feature(`coverletter_feedback`)의 env 키·기대 모델이 곳곳에 박혀 있어,
   * Phase 1 에서 그 feature 가 Terra 로 옮겨가자 5개가 한 번에 깨졌다.
   * 값을 한곳에 모아 다음 전환 때 여기만 고치게 한다.
   */
  const ENV_KEY = 'OPENAI_MODEL_COVERLETTER';
  const ENV_MODEL = 'gpt-4o'; // env 가 코드 기본값을 덮는지 보려면 **다른 값**이어야 한다
  const CODE_DEFAULT = 'gpt-5.6-terra'; // FEATURE_MATRIX.defaultModel

  const configWithEnv = {
    get: (k: string) =>
      k === ENV_KEY
        ? ENV_MODEL
        : k === 'OPENAI_MODEL_LIGHT'
          ? 'gpt-4o-mini'
          : undefined,
  } as unknown as ConfigService;

  /** env 미설정 — 코드 기본값까지 내려가는 경로 */
  const configEmpty = { get: () => undefined } as unknown as ConfigService;

  const make = (config: ConfigService) => {
    repo = { findOne: jest.fn().mockResolvedValue(null) };
    return new ModelConfigService(
      repo as unknown as Repository<FeatureModelConfig>,
      config,
    );
  };

  beforeEach(() => {
    service = make(configWithEnv);
  });

  describe('1단 — DB 행이 있으면 최우선', () => {
    it('provider·model 을 DB 값으로 덮는다', async () => {
      repo.findOne.mockResolvedValue({
        feature: 'coverletter_feedback',
        provider: 'openai',
        model: 'gpt-4o',
      });

      const cfg = await service.resolve('coverletter_feedback');

      expect(cfg.provider).toBe('openai');
      expect(cfg.model).toBe('gpt-4o');
    });

    /**
     * 🔴 admin 이 건드릴 범위를 최소로 둔다. 토큰 한도·temperature 까지 DB 로 옮기면
     * 잘못된 값 하나로 기능이 죽는 경로가 늘어나고, cap 은 `model-config.spec` 이 박제 중이다.
     */
    it('토큰 한도·temperature 는 FEATURE_MATRIX 가 계속 소유한다', async () => {
      const base = await service.resolve('coverletter_feedback');
      repo.findOne.mockResolvedValue({
        feature: 'coverletter_feedback',
        provider: 'openai',
        model: 'gpt-4o',
      });

      const overridden = await service.resolve('coverletter_feedback');

      expect(overridden.maxOutputTokens).toBe(base.maxOutputTokens);
      expect(overridden.maxInputTokens).toBe(base.maxInputTokens);
      expect(overridden.temperature).toBe(base.temperature);
    });
  });

  describe('2단 — DB 행이 없으면 env', () => {
    it('행이 없으면 env 값으로 해석한다 (마이그레이션 전·롤백 후 상태)', async () => {
      const cfg = await service.resolve('coverletter_feedback');

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { feature: 'coverletter_feedback' },
      });
      expect(cfg.model).toBe(ENV_MODEL);
      expect(cfg.provider).toBe('openai');
    });

    /**
     * 롤백 시나리오 — DB 행을 지우는 것만으로 이전 동작으로 돌아가야 한다.
     * 이게 안 되면 잘못된 설정을 되돌리려고 또 배포해야 한다.
     */
    it('행을 지우면 env 로 되돌아간다', async () => {
      repo.findOne.mockResolvedValue({
        feature: 'coverletter_feedback',
        provider: 'openai',
        model: 'gpt-4o',
      });
      expect((await service.resolve('coverletter_feedback')).model).toBe(
        'gpt-4o',
      );

      repo.findOne.mockResolvedValue(null); // 행 삭제
      expect((await service.resolve('coverletter_feedback')).model).toBe(
        ENV_MODEL,
      );
    });
  });

  describe('3단 — env 도 없으면 코드 기본값', () => {
    it('env 미설정이면 FEATURE_MATRIX 의 defaultModel', async () => {
      service = make(configEmpty);

      const cfg = await service.resolve('coverletter_feedback');
      expect(cfg.model).toBe(CODE_DEFAULT);
      expect(cfg.provider).toBe('openai');
    });
  });

  describe('DB 장애 — LLM 호출 전체가 죽으면 안 된다', () => {
    /**
     * 🔴 설정 조회 실패로 AI 기능 전체가 멈추는 건 과한 실패다.
     * env 로 계속 진행하되, 설정이 반영 안 된 상태이므로 **조용히 넘어가지는 않는다.**
     */
    it('조회 실패 시 env 폴백 + error 로그', async () => {
      const spy = jest
        .spyOn(
          (service as unknown as { logger: { error: (m: string) => void } })
            .logger,
          'error',
        )
        .mockImplementation(() => undefined);
      repo.findOne.mockRejectedValue(new Error('connection refused'));

      const cfg = await service.resolve('coverletter_feedback');

      expect(cfg.model).toBe(ENV_MODEL); // env 로 진행
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('coverletter_feedback');
    });

    it('Error 가 아닌 값이 throw 돼도 문자열로 남긴다', async () => {
      const spy = jest
        .spyOn(
          (service as unknown as { logger: { error: (m: string) => void } })
            .logger,
          'error',
        )
        .mockImplementation(() => undefined);
      repo.findOne.mockRejectedValue('connection lost'); // Error 인스턴스 아님

      const cfg = await service.resolve('coverletter_feedback');

      expect(cfg.model).toBe(ENV_MODEL);
      expect(spy.mock.calls[0][0]).toContain('connection lost');
    });
  });
});
