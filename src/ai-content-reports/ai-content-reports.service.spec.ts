import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { AiContentReport } from './ai-content-report.entity';
import { AiContentReportsService } from './ai-content-reports.service';
import { DiscordNotifier } from '../common/discord-notifier';
import type { CreateAiContentReportDto } from './dto/create-ai-content-report.dto';

/**
 * AiContentReportsService spec.
 *
 * 시나리오:
 *   1) createReport 정상 (contentId 있음 / 없음 / detail 있음 / 없음)
 *   2) status default 'pending'
 *   3) reporterUserId 저장
 *   4) Discord alert 발송 여부 · 실패 시 throw X
 *   5) reason 별 저장 확인
 */
describe('AiContentReportsService', () => {
  let service: AiContentReportsService;
  let repo: jest.Mocked<Repository<AiContentReport>>;
  let discord: jest.Mocked<DiscordNotifier>;

  const baseDto: CreateAiContentReportDto = {
    contentType: 'coverletter',
    contentId: '11111111-1111-1111-1111-111111111111',
    reason: 'misinformation',
    detail: '잘못된 정보 예시',
  };

  beforeEach(async () => {
    const mockRepo = mock<Repository<AiContentReport>>();
    mockRepo.create.mockImplementation((data) => data as AiContentReport);
    mockRepo.save.mockImplementation(async (entity) => ({
      ...(entity as AiContentReport),
      id: 'report-uuid-1',
      createdAt: new Date('2026-07-02T10:00:00Z'),
    }));

    const mockDiscord = mock<DiscordNotifier>();
    mockDiscord.notify.mockResolvedValue('sent');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiContentReportsService,
        { provide: getRepositoryToken(AiContentReport), useValue: mockRepo },
        { provide: DiscordNotifier, useValue: mockDiscord },
      ],
    }).compile();

    service = module.get(AiContentReportsService);
    repo = module.get(getRepositoryToken(AiContentReport));
    discord = module.get(DiscordNotifier);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createReport', () => {
    it('정상: 모든 필드 저장 · status pending · reporterUserId 유지', async () => {
      const result = await service.createReport('user-1', baseDto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reporterUserId: 'user-1',
          contentType: 'coverletter',
          contentId: '11111111-1111-1111-1111-111111111111',
          reason: 'misinformation',
          detail: '잘못된 정보 예시',
          status: 'pending',
        }),
      );
      expect(result.id).toBe('report-uuid-1');
      expect(result.status).toBe('pending');
    });

    it('contentId 없음 → null 로 저장', async () => {
      const dto: CreateAiContentReportDto = {
        contentType: 'other',
        reason: 'harmful_content',
      };

      await service.createReport('user-1', dto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          contentId: null,
          detail: null,
        }),
      );
    });

    it('detail 없음 → null 저장 + Discord alert 에 "(상세 없음)"', async () => {
      const dto: CreateAiContentReportDto = {
        contentType: 'interview_answer',
        reason: 'privacy_violation',
      };

      await service.createReport('user-1', dto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ detail: null }),
      );
      // 비동기 fire-and-forget · queue 다음 tick 에서 실행되도록 대기
      await new Promise((r) => setImmediate(r));
      expect(discord.notify).toHaveBeenCalledWith(
        expect.stringContaining('(상세 없음)'),
      );
    });

    it('Discord alert 발송 (best-effort · 결과 무시)', async () => {
      await service.createReport('user-1', baseDto);
      await new Promise((r) => setImmediate(r));

      expect(discord.notify).toHaveBeenCalledTimes(1);
      const msg = discord.notify.mock.calls[0][0];
      expect(msg).toContain('AI 콘텐츠 신고 접수');
      expect(msg).toContain('coverletter');
      expect(msg).toContain('misinformation');
      expect(msg).toContain('user-1');
    });

    it('Discord notify 실패해도 createReport 는 정상 반환', async () => {
      discord.notify.mockRejectedValueOnce(new Error('webhook down'));

      const result = await service.createReport('user-1', baseDto);

      expect(result.id).toBe('report-uuid-1');
    });

    it('detail 500 자 초과분은 Discord 프리뷰에 120 자만 노출', async () => {
      const long = 'x'.repeat(400);
      const dto: CreateAiContentReportDto = {
        contentType: 'note_summary',
        reason: 'copyright',
        detail: long,
      };

      await service.createReport('user-1', dto);
      await new Promise((r) => setImmediate(r));

      const msg = discord.notify.mock.calls[0][0];
      expect(msg).toContain('x'.repeat(120));
      expect(msg).not.toContain('x'.repeat(121));
    });

    it('reason 별 저장 (6 enum · 모두 정상 통과)', async () => {
      const reasons: CreateAiContentReportDto['reason'][] = [
        'hate_speech',
        'misinformation',
        'privacy_violation',
        'harmful_content',
        'copyright',
        'other',
      ];

      for (const reason of reasons) {
        await service.createReport('user-1', {
          contentType: 'other',
          reason,
        });
      }

      expect(repo.save).toHaveBeenCalledTimes(6);
    });
  });
});
