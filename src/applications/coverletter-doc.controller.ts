import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyResearchService } from '../interview-prep/company-research.service';
import { CoverletterChatService } from './coverletter-chat.service';
import type { ChatSendDto } from './coverletter-chat.service';

interface AuthUser {
  id: string;
  role: string;
}

/**
 * F1 자소서 풀페이지 — application 단위 endpoint 모음 (`/applications/:appId/coverletter`).
 *
 * Phase B — 회사 조사 (재사용: CompanyResearchService 의 application 단위 메서드)
 *   GET  /research  — 캐시만 (LLM 호출 X)
 *   POST /research  — 캐시 우선, miss/expired 시 LLM fetch
 *
 * Phase D — AI 채팅 (별도 추가):
 *   GET    /messages
 *   POST   /chat
 *   DELETE /messages
 */
@Controller('applications/:appId/coverletter')
export class CoverletterDocController {
  constructor(
    private readonly research: CompanyResearchService,
    private readonly chat: CoverletterChatService,
  ) {}

  // ── Phase B: research ──
  @Get('research')
  getResearch(
    @CurrentUser() user: AuthUser,
    @Param('appId', ParseUUIDPipe) appId: string,
  ) {
    return this.research.getCachedForApplication(user.id, appId);
  }

  @Post('research')
  fetchResearch(
    @CurrentUser() user: AuthUser,
    @Param('appId', ParseUUIDPipe) appId: string,
  ) {
    return this.research.fetchForApplication(user.id, appId);
  }

  // ── Phase D: chat ──
  @Get('messages')
  listMessages(
    @CurrentUser() user: AuthUser,
    @Param('appId', ParseUUIDPipe) appId: string,
  ) {
    return this.chat.listMessages(user.id, appId);
  }

  @Post('chat')
  sendChat(
    @CurrentUser() user: AuthUser,
    @Param('appId', ParseUUIDPipe) appId: string,
    @Body() dto: ChatSendDto,
  ) {
    return this.chat.chat(user.id, appId, dto);
  }

  /**
   * Phase 4 — Streaming chat (SSE).
   * Response 형식: `event: <type>\ndata: <json>\n\n`
   * 종료 event: 'done' 또는 'error'. 받으면 client 가 connection close.
   *
   * NestJS interceptor 의 envelope 자동 wrap 는 SSE 에 적용 안 함 (res 직접 사용).
   */
  @Post('chat/stream')
  async sendChatStream(
    @CurrentUser() user: AuthUser,
    @Param('appId', ParseUUIDPipe) appId: string,
    @Body() dto: ChatSendDto,
    @Res() res: Response,
  ): Promise<void> {
    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx 등 reverse proxy buffering 방지
    res.flushHeaders();

    try {
      const stream = this.chat.chatStream(user.id, appId, dto);
      for await (const event of stream) {
        if (res.writableEnded) {
          // cost hardening 🟡6 — 클라이언트가 끊겨도 generator 를 완주(drain)시킴.
          // break 로 버리면 LlmService 의 'done' 처리(코인 차감 + audit)가 실행되지
          // 않아 provider 과금은 됐는데 기록·차감이 증발한다. 응답 write 만 생략.
          continue;
        }
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'stream failure';
      if (!res.writableEnded) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  @Delete('messages')
  async deleteMessages(
    @CurrentUser() user: AuthUser,
    @Param('appId', ParseUUIDPipe) appId: string,
  ) {
    await this.chat.deleteMessages(user.id, appId);
    return { ok: true };
  }
}
