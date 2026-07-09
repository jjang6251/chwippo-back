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
  // ── cost hardening 🟡6 — SSE 스트림 drain ──
  describe('POST chat/stream — 클라이언트 끊김 drain (🟡6)', () => {
    const USER = { id: 'u-1' } as never;
    const DTO = { message: '안녕' } as never;

    function makeRes(writableEndedFrom: number) {
      let writes = 0;
      return {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        get writableEnded() {
          // writableEndedFrom 번째 write 이후부터 끊긴 것으로 시뮬레이션
          return writes >= writableEndedFrom;
        },
        write: jest.fn(() => {
          writes++;
          return true;
        }),
        end: jest.fn(),
      };
    }

    it('스트림 중간에 클라이언트 끊김 → generator 는 done 까지 완주 (차감·audit 보존)', async () => {
      const consumed: string[] = [];
      chat.chatStream.mockImplementation(async function* () {
        consumed.push('partial-1');
        yield { type: 'partial' } as never;
        consumed.push('partial-2');
        yield { type: 'partial' } as never;
        // 이 지점이 LlmService 의 charge+audit 에 해당 — 도달해야 함
        consumed.push('done');
        yield { type: 'done' } as never;
      });
      const res = makeRes(2); // 첫 이벤트(write 2회) 후 끊김

      await controller.sendChatStream(USER, 'app-1', DTO, res as never);

      // 끊긴 뒤에도 generator 가 끝까지 소비됨 (break 로 abandon 하지 않음)
      expect(consumed).toEqual(['partial-1', 'partial-2', 'done']);
      // 끊긴 후엔 write 없음 (첫 이벤트 2회뿐)
      expect(res.write).toHaveBeenCalledTimes(2);
      // 이미 ended 라 end() 재호출 없음
      expect(res.end).not.toHaveBeenCalled();
    });

    it('정상 완주 → 모든 이벤트 write + end 호출 (기존 동작 회귀)', async () => {
      chat.chatStream.mockImplementation(async function* () {
        yield { type: 'partial' } as never;
        yield { type: 'done' } as never;
      });
      const res = makeRes(Number.MAX_SAFE_INTEGER);

      await controller.sendChatStream(USER, 'app-1', DTO, res as never);

      expect(res.write).toHaveBeenCalledTimes(4); // 이벤트 2 × (event+data)
      expect(res.end).toHaveBeenCalledTimes(1);
    });
  });
});
