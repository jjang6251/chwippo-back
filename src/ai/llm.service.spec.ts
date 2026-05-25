import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import type OpenAI from 'openai';
import { Repository } from 'typeorm';
import { LlmCallLog } from './entities/llm-call-log.entity';
import { LlmService } from './llm.service';
import { OPENAI_CLIENT } from './openai-client.provider';

type OpenAILike = Pick<OpenAI, 'chat'>;

describe('LlmService', () => {
  let service: LlmService;
  let logRepo: jest.Mocked<Repository<LlmCallLog>>;
  let openai: { chat: { completions: { create: jest.Mock } } };

  const makeLog = (
    overrides: Partial<LlmCallLog> = {},
  ): LlmCallLog =>
    ({
      id: 'log-1',
      userId: 'u-1',
      feature: 'note_summary',
      model: 'gpt-4o-mini',
      promptTokens: 0,
      completionTokens: 0,
      costUsd: '0',
      latencyMs: 0,
      status: 'ok',
      errorMessage: null,
      resourceType: null,
      resourceId: null,
      createdAt: new Date(),
      user: undefined as unknown as LlmCallLog['user'],
      ...overrides,
    }) as LlmCallLog;

  beforeEach(async () => {
    openai = {
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
    };
    const mockRepo = mock<Repository<LlmCallLog>>();
    mockRepo.create.mockImplementation((d) => d as LlmCallLog);
    mockRepo.save.mockImplementation(async (d) =>
      makeLog(d as Partial<LlmCallLog>),
    );

    const config = mock<ConfigService>();
    config.get.mockImplementation((key: string) => {
      if (key === 'OPENAI_MODEL_LIGHT') return 'gpt-4o-mini';
      if (key === 'OPENAI_MODEL_HEAVY') return 'gpt-4o';
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmService,
        { provide: OPENAI_CLIENT, useValue: openai as unknown as OpenAILike },
        { provide: getRepositoryToken(LlmCallLog), useValue: mockRepo },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<LlmService>(LlmService);
    logRepo = module.get(getRepositoryToken(LlmCallLog));
  });

  it('성공 호출: status=ok 로그 + 토큰·비용 기록', async () => {
    openai.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '요약된 내용' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    });

    const result = await service.call({
      userId: 'u-1',
      feature: 'note_summary',
      systemPrompt: 'sys',
      userPrompt: 'user',
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.text).toBe('요약된 내용');
    expect(result.promptTokens).toBe(1000);
    expect(result.completionTokens).toBe(200);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(logRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        promptTokens: 1000,
        completionTokens: 200,
      }),
    );
  });

  it('preBlockedStatus=blocked_quota → OpenAI 호출 안 함, 로그만 기록', async () => {
    const result = await service.call({
      userId: 'u-1',
      feature: 'note_summary',
      systemPrompt: 's',
      userPrompt: 'u',
      preBlockedStatus: 'blocked_quota',
      preBlockedReason: 'daily limit',
    });

    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked_quota');
    expect(logRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'blocked_quota' }),
    );
  });

  it('preBlockedStatus=blocked_moderation → 호출 안 함', async () => {
    const result = await service.call({
      userId: 'u-1',
      feature: 'note_summary',
      systemPrompt: 's',
      userPrompt: 'u',
      preBlockedStatus: 'blocked_moderation',
      preBlockedReason: 'flagged',
    });

    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked_moderation');
  });

  it('OpenAI 에러 → status=error 로그 + errorMessage', async () => {
    openai.chat.completions.create.mockRejectedValue(
      new Error('rate limit exceeded'),
    );

    const result = await service.call({
      userId: 'u-1',
      feature: 'note_summary',
      systemPrompt: 's',
      userPrompt: 'u',
    });

    expect(result.status).toBe('error');
    if (result.status === 'ok') throw new Error('not expected');
    expect(result.errorMessage).toContain('rate limit');
    expect(logRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('OPENAI_CLIENT 가 null 이면 호출 시도 안 하고 error 로 로그', async () => {
    const mockRepo = mock<Repository<LlmCallLog>>();
    mockRepo.create.mockImplementation((d) => d as LlmCallLog);
    mockRepo.save.mockImplementation(async (d) =>
      makeLog(d as Partial<LlmCallLog>),
    );
    const config = mock<ConfigService>();
    config.get.mockReturnValue('gpt-4o-mini');

    const module = await Test.createTestingModule({
      providers: [
        LlmService,
        { provide: OPENAI_CLIENT, useValue: null },
        { provide: getRepositoryToken(LlmCallLog), useValue: mockRepo },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    const svcNoKey = module.get<LlmService>(LlmService);
    const result = await svcNoKey.call({
      userId: 'u-1',
      feature: 'note_summary',
      systemPrompt: 's',
      userPrompt: 'u',
    });

    expect(result.status).toBe('error');
    if (result.status === 'ok') throw new Error('not expected');
    expect(result.errorMessage).toContain('OPENAI_API_KEY');
  });

  it('modelTier=heavy → gpt-4o 사용', async () => {
    openai.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await service.call({
      userId: 'u-1',
      feature: 'coverletter',
      modelTier: 'heavy',
      systemPrompt: 's',
      userPrompt: 'u',
    });

    expect(openai.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' }),
    );
  });

  it('응답에 usage 필드 없음 → tokens=0, cost=0 안전 처리', async () => {
    openai.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'hi' } }],
      // usage 없음
    });

    const result = await service.call({
      userId: 'u-1',
      feature: 'note_summary',
      systemPrompt: 's',
      userPrompt: 'u',
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it('응답 content 가 빈 문자열 → text="" + status=ok', async () => {
    openai.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });

    const result = await service.call({
      userId: 'u-1',
      feature: 'note_summary',
      systemPrompt: 's',
      userPrompt: 'u',
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.text).toBe('');
  });

  it('preBlockedReason 없을 때 errorMessage 가 status 값으로 fallback', async () => {
    const result = await service.call({
      userId: 'u-1',
      feature: 'note_summary',
      systemPrompt: 's',
      userPrompt: 'u',
      preBlockedStatus: 'blocked_quota',
      // preBlockedReason 미지정
    });
    expect(result.status).toBe('blocked_quota');
    if (result.status === 'ok') throw new Error('not expected');
    expect(result.errorMessage).toBe('blocked_quota');
  });
});
