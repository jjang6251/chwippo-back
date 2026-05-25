import { Test, TestingModule } from '@nestjs/testing';
import { ModerationService } from './moderation.service';
import { OPENAI_CLIENT } from './openai-client.provider';

describe('ModerationService', () => {
  let service: ModerationService;
  let openai: { moderations: { create: jest.Mock } };

  beforeEach(async () => {
    openai = { moderations: { create: jest.fn() } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        { provide: OPENAI_CLIENT, useValue: openai },
      ],
    }).compile();
    service = module.get<ModerationService>(ModerationService);
  });

  it('flagged=true 인 카테고리들을 배열로 반환', async () => {
    openai.moderations.create.mockResolvedValue({
      results: [
        {
          flagged: true,
          categories: { hate: true, violence: false, sexual: true },
        },
      ],
    });

    const result = await service.check('험한 텍스트');

    expect(result.flagged).toBe(true);
    expect(result.categories).toEqual(expect.arrayContaining(['hate', 'sexual']));
    expect(result.categories).not.toContain('violence');
    expect(result.apiFailed).toBe(false);
  });

  it('정상 텍스트는 flagged=false', async () => {
    openai.moderations.create.mockResolvedValue({
      results: [{ flagged: false, categories: { hate: false } }],
    });

    const result = await service.check('정상 텍스트');
    expect(result.flagged).toBe(false);
    expect(result.categories).toEqual([]);
  });

  it('API 에러 시 fail-open: flagged=false + apiFailed=true', async () => {
    openai.moderations.create.mockRejectedValue(new Error('network'));

    const result = await service.check('any');
    expect(result.flagged).toBe(false);
    expect(result.apiFailed).toBe(true);
  });

  it('OPENAI_CLIENT=null 이면 호출 시도 없이 fail-open', async () => {
    const module = await Test.createTestingModule({
      providers: [
        ModerationService,
        { provide: OPENAI_CLIENT, useValue: null },
      ],
    }).compile();
    const svc = module.get<ModerationService>(ModerationService);

    const result = await svc.check('any');
    expect(result.flagged).toBe(false);
    expect(result.apiFailed).toBe(true);
  });
});
