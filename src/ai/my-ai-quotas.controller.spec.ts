import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { MyAiQuotasController } from './my-ai-quotas.controller';
import { QuotaCheckService } from './quota-check.service';

/**
 * F6 PR 2 Phase 3 — MyAiQuotasController spec.
 *
 * 시나리오:
 * - GET /me/ai-quotas → service.getMyQuotas(user.id) 위임
 * - 응답 shape (feature·enabled·dayUsed/Limit·monthUsed/Limit·cooldownSeconds·nextAvailableAt)
 * - 다른 사용자의 user.id 가 들어가도 service 로 그대로 전파 (controller 는 가드만, ID 변조는 AuthGuard 책임)
 * - 빈 결과 (config 없는 사용자) → []
 *
 * 본 controller 는 단순 위임 — IDOR 가드는 AuthGuard('jwt') 에 의존, ID strip 은 service 가 처리
 */
describe('MyAiQuotasController', () => {
  let controller: MyAiQuotasController;
  let quotaCheck: jest.Mocked<QuotaCheckService>;

  beforeEach(async () => {
    quotaCheck = mock<QuotaCheckService>();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MyAiQuotasController],
      providers: [{ provide: QuotaCheckService, useValue: quotaCheck }],
    }).compile();
    controller = module.get<MyAiQuotasController>(MyAiQuotasController);
  });

  it('정상: service.getMyQuotas(user.id) 호출 + 결과 반환', async () => {
    const fake = [
      {
        feature: 'note_summary' as const,
        enabled: true,
        dayUsed: 5,
        dayLimit: 30,
        monthUsed: 50,
        monthLimit: 300,
        cooldownSeconds: 30,
        nextAvailableAt: null,
      },
    ];
    quotaCheck.getMyQuotas.mockResolvedValue(fake);

    const r = await controller.list({ id: 'user-1' });
    expect(r).toEqual(fake);
    expect(quotaCheck.getMyQuotas).toHaveBeenCalledWith('user-1');
  });

  it('cooldown 안 호출 있음 → nextAvailableAt ISO 문자열', async () => {
    const next = new Date(Date.now() + 60_000).toISOString();
    quotaCheck.getMyQuotas.mockResolvedValue([
      {
        feature: 'coverletter_draft_v2',
        enabled: true,
        dayUsed: 1,
        dayLimit: 3,
        monthUsed: 1,
        monthLimit: 20,
        cooldownSeconds: 120,
        nextAvailableAt: next,
      },
    ]);
    const r = await controller.list({ id: 'user-1' });
    expect(r[0].nextAvailableAt).toBe(next);
  });

  it('feature 가 admin 에 의해 비활성 → enabled=false', async () => {
    quotaCheck.getMyQuotas.mockResolvedValue([
      {
        feature: 'note_summary',
        enabled: false,
        dayUsed: 0,
        dayLimit: 30,
        monthUsed: 0,
        monthLimit: 300,
        cooldownSeconds: 30,
        nextAvailableAt: null,
      },
    ]);
    const r = await controller.list({ id: 'user-1' });
    expect(r[0].enabled).toBe(false);
  });

  it('config 없는 사용자 → 빈 배열', async () => {
    quotaCheck.getMyQuotas.mockResolvedValue([]);
    const r = await controller.list({ id: 'user-new' });
    expect(r).toEqual([]);
  });

  it('서로 다른 user.id 전파 — service 에서 cross-user 격리 검증', async () => {
    quotaCheck.getMyQuotas.mockResolvedValue([]);
    await controller.list({ id: 'user-A' });
    await controller.list({ id: 'user-B' });
    expect(quotaCheck.getMyQuotas).toHaveBeenNthCalledWith(1, 'user-A');
    expect(quotaCheck.getMyQuotas).toHaveBeenNthCalledWith(2, 'user-B');
  });
});
