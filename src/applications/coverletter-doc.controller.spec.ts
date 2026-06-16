import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { CompanyResearchService } from '../interview-prep/company-research.service';
import { CoverletterChatService } from './coverletter-chat.service';
import { CoverletterDocController } from './coverletter-doc.controller';

/**
 * F1 자소서 풀페이지 — CoverletterDocController Phase B (research).
 *
 * 매트릭스 (정상/캐시/IDOR/opt_out/만료/quota blocked):
 * 1. GET research — cache hit (정상)
 * 2. GET research — cache miss (null)
 * 3. GET research — opt_out (별도 status)
 * 4. GET research — 다른 user IDOR (service 가 throw)
 * 5. POST research — cache hit (LLM 미호출)
 * 6. POST research — cache miss → LLM 호출 → cache upsert
 * 7. POST research — quota blocked
 * 8. POST research — LLM error → blocked
 * 9. POST research — 다른 user IDOR (service 가 throw)
 *
 * service 자체 로직은 company-research.service.spec.ts 가 검증 — 여기는 controller 의
 * routing 과 user.id 전달 정확성에 집중.
 */
describe('CoverletterDocController', () => {
  let controller: CoverletterDocController;
  let research: jest.Mocked<CompanyResearchService>;
  let chat: jest.Mocked<CoverletterChatService>;

  beforeEach(async () => {
    research = mock<CompanyResearchService>();
    chat = mock<CoverletterChatService>();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CoverletterDocController],
      providers: [
        { provide: CompanyResearchService, useValue: research },
        { provide: CoverletterChatService, useValue: chat },
      ],
    }).compile();
    controller = module.get(CoverletterDocController);
  });

  // ── GET /research ──
  describe('GET research', () => {
    it('cache hit → service 응답 그대로 반환', async () => {
      research.getCachedForApplication.mockResolvedValue({
        status: 'ok',
        research: { businessSummary: '...' },
        sources: [],
        isCached: true,
        cachedAt: new Date(),
      });
      const result = await controller.getResearch(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      expect(research.getCachedForApplication).toHaveBeenCalledWith(
        'u-1',
        'app-1',
      );
      if (!result || result.status !== 'ok') throw new Error('expected ok');
      expect(result.isCached).toBe(true);
    });

    it('cache miss → null', async () => {
      research.getCachedForApplication.mockResolvedValue(null);
      const result = await controller.getResearch(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      expect(result).toBeNull();
    });

    it('opt_out → 별도 status 반환', async () => {
      research.getCachedForApplication.mockResolvedValue({
        status: 'opt_out',
        reason: '동의 철회',
      });
      const result = await controller.getResearch(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      if (!result || result.status !== 'opt_out')
        throw new Error('expected opt_out');
      expect(result.reason).toContain('동의');
    });

    it('다른 user 의 application → service NotFoundException throw', async () => {
      research.getCachedForApplication.mockRejectedValue(
        new Error('지원 카드를 찾을 수 없습니다.'),
      );
      await expect(
        controller.getResearch({ id: 'u-2', role: 'user' }, 'app-1'),
      ).rejects.toThrow();
    });
  });

  // ── POST /research ──
  describe('POST research', () => {
    it('cache hit → LLM 미호출, service 응답 그대로', async () => {
      research.fetchForApplication.mockResolvedValue({
        status: 'ok',
        research: { businessSummary: 'cached' },
        sources: [],
        isCached: true,
        cachedAt: new Date(),
      });
      const result = await controller.fetchResearch(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      expect(research.fetchForApplication).toHaveBeenCalledWith('u-1', 'app-1');
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.isCached).toBe(true);
    });

    it('cache miss → LLM 호출 후 isCached=false 반환', async () => {
      research.fetchForApplication.mockResolvedValue({
        status: 'ok',
        research: { businessSummary: 'fresh' },
        sources: ['https://example.com'],
        isCached: false,
        cachedAt: new Date(),
      });
      const result = await controller.fetchResearch(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.isCached).toBe(false);
    });

    it('quota blocked → status=blocked + reason', async () => {
      research.fetchForApplication.mockResolvedValue({
        status: 'blocked',
        reason: '일일 한도 초과',
      });
      const result = await controller.fetchResearch(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      if (result.status !== 'blocked') throw new Error('expected blocked');
      expect(result.reason).toContain('한도');
    });

    it('LLM error → status=blocked + 사용자 메시지', async () => {
      research.fetchForApplication.mockResolvedValue({
        status: 'blocked',
        reason: '회사 조사 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
      });
      const result = await controller.fetchResearch(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      if (result.status !== 'blocked') throw new Error('expected blocked');
      expect(result.reason).toContain('오류');
    });

    it('다른 user 의 application → service NotFoundException throw', async () => {
      research.fetchForApplication.mockRejectedValue(
        new Error('지원 카드를 찾을 수 없습니다.'),
      );
      await expect(
        controller.fetchResearch({ id: 'u-2', role: 'user' }, 'app-1'),
      ).rejects.toThrow();
    });
  });

  // ── Phase D: chat ──
  describe('GET messages', () => {
    it('정상 — service.listMessages 호출', async () => {
      const msgs = [{ id: 'm-1' }] as never;
      chat.listMessages.mockResolvedValueOnce(msgs);
      const r = await controller.listMessages(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      expect(chat.listMessages).toHaveBeenCalledWith('u-1', 'app-1');
      expect(r).toEqual(msgs);
    });

    it('0개 → 빈 배열', async () => {
      chat.listMessages.mockResolvedValueOnce([]);
      const r = await controller.listMessages(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      expect(r).toEqual([]);
    });

    it('다른 user IDOR → throw', async () => {
      chat.listMessages.mockRejectedValueOnce(
        new Error('지원 카드를 찾을 수 없습니다.'),
      );
      await expect(
        controller.listMessages({ id: 'u-2', role: 'user' }, 'app-1'),
      ).rejects.toThrow();
    });
  });

  describe('POST chat', () => {
    it('정상 — service.chat 호출 + result 반환', async () => {
      chat.chat.mockResolvedValueOnce({
        userMessage: { id: 'm-u', role: 'user' } as never,
        assistantMessage: { id: 'm-a', role: 'assistant' } as never,
        assistantStatus: 'ok',
      });
      const r = await controller.sendChat(
        { id: 'u-1', role: 'user' },
        'app-1',
        { userMessage: '안녕' },
      );
      expect(chat.chat).toHaveBeenCalledWith('u-1', 'app-1', {
        userMessage: '안녕',
      });
      expect(r.userMessage.role).toBe('user');
      expect(r.assistantMessage.role).toBe('assistant');
    });

    it('selectedLogIds 전달', async () => {
      chat.chat.mockResolvedValueOnce({
        userMessage: { id: 'm-u' } as never,
        assistantMessage: { id: 'm-a' } as never,
        assistantStatus: 'ok',
      });
      await controller.sendChat({ id: 'u-1', role: 'user' }, 'app-1', {
        userMessage: 'a',
        selectedLogIds: ['log-1', 'log-2'],
      });
      expect(chat.chat).toHaveBeenCalledWith(
        'u-1',
        'app-1',
        expect.objectContaining({ selectedLogIds: ['log-1', 'log-2'] }),
      );
    });

    it('빈 메시지 → service 가 BadRequest throw', async () => {
      chat.chat.mockRejectedValueOnce(new Error('메시지를 입력해 주세요.'));
      await expect(
        controller.sendChat({ id: 'u-1', role: 'user' }, 'app-1', {
          userMessage: '',
        }),
      ).rejects.toThrow();
    });

    it('5000자 초과 → service throw', async () => {
      chat.chat.mockRejectedValueOnce(
        new Error('메시지는 5000자 이내로 작성해 주세요.'),
      );
      await expect(
        controller.sendChat({ id: 'u-1', role: 'user' }, 'app-1', {
          userMessage: 'a'.repeat(5001),
        }),
      ).rejects.toThrow();
    });

    it('다른 user IDOR → throw', async () => {
      chat.chat.mockRejectedValueOnce(
        new Error('지원 카드를 찾을 수 없습니다.'),
      );
      await expect(
        controller.sendChat({ id: 'u-2', role: 'user' }, 'app-1', {
          userMessage: 'a',
        }),
      ).rejects.toThrow();
    });

    it('quota blocked → service 가 차단 assistant 메시지 반환', async () => {
      chat.chat.mockResolvedValueOnce({
        userMessage: { id: 'm-u' } as never,
        assistantMessage: { id: 'm-a', content: '⚠️ 한도 초과' } as never,
        assistantStatus: 'blocked_quota',
      });
      const r = await controller.sendChat(
        { id: 'u-1', role: 'user' },
        'app-1',
        { userMessage: 'a' },
      );
      expect(r.assistantMessage.content).toContain('한도');
    });

    it('LLM error → service 가 에러 assistant 메시지 반환', async () => {
      chat.chat.mockResolvedValueOnce({
        userMessage: { id: 'm-u' } as never,
        assistantMessage: { id: 'm-a', content: '⚠️ AI 응답 오류' } as never,
        assistantStatus: 'error',
      });
      const r = await controller.sendChat(
        { id: 'u-1', role: 'user' },
        'app-1',
        { userMessage: 'a' },
      );
      expect(r.assistantMessage.content).toContain('오류');
    });

    it('suggestedUpdates 응답 — assistantMessage.suggestedUpdates 에 포함', async () => {
      chat.chat.mockResolvedValueOnce({
        userMessage: { id: 'm-u' } as never,
        assistantMessage: {
          id: 'm-a',
          suggestedUpdates: [{ clId: 'cl-1', newAnswer: '답변' }],
        } as never,
        assistantStatus: 'ok',
      });
      const r = await controller.sendChat(
        { id: 'u-1', role: 'user' },
        'app-1',
        { userMessage: 'a' },
      );
      expect(r.assistantMessage.suggestedUpdates).toHaveLength(1);
    });
  });

  describe('DELETE messages', () => {
    it('정상 — service.deleteMessages 호출 + { ok: true }', async () => {
      chat.deleteMessages.mockResolvedValueOnce(undefined);
      const r = await controller.deleteMessages(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      expect(chat.deleteMessages).toHaveBeenCalledWith('u-1', 'app-1');
      expect(r).toEqual({ ok: true });
    });

    it('다른 user IDOR → throw', async () => {
      chat.deleteMessages.mockRejectedValueOnce(
        new Error('지원 카드를 찾을 수 없습니다.'),
      );
      await expect(
        controller.deleteMessages({ id: 'u-2', role: 'user' }, 'app-1'),
      ).rejects.toThrow();
    });

    it('이미 비어있어도 정상 (멱등)', async () => {
      chat.deleteMessages.mockResolvedValueOnce(undefined);
      const r = await controller.deleteMessages(
        { id: 'u-1', role: 'user' },
        'app-1',
      );
      expect(r).toEqual({ ok: true });
    });
  });
});
