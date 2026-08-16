import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpdateNicknameDto } from './dto/update-nickname.dto';
import { UpdateDashboardConfigDto } from './dto/update-dashboard-config.dto';
import { AgreeAiConsentDto } from './dto/agree-ai-consent.dto';
import { SignupAnswerDto } from './dto/signup-answer.dto';

interface AuthUser {
  id: string;
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('me/terms')
  @HttpCode(204)
  async agreeTerms(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.agreeTerms(user.id);
  }

  @Post('me/onboard')
  @HttpCode(204)
  async markOnboarded(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.markOnboarded(user.id);
  }

  /** W1 — signup 1 질문 답변 + 가상 회사 샘플 자동 생성 */
  @Post('me/signup-answer')
  @HttpCode(204)
  async signupAnswer(
    @CurrentUser() user: AuthUser,
    @Body() dto: SignupAnswerDto,
  ): Promise<void> {
    await this.usersService.signupAnswer(user.id, dto);
  }

  /** W1 — 샘플 카드 전체 숨기기 (멱등) */
  @Post('me/sample-cards/dismiss')
  @HttpCode(204)
  async dismissAllSampleCards(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.dismissAllSampleCards(user.id);
  }

  /** 캘린더 UX 재구성 — 홈=/calendar redirect 안내 배너 dismiss (멱등) */
  /**
   * 데스크탑 웹 사용 스탬프 (관측 전용) — 프론트가 자소서 게이트와 **같은 조건**일 때만 부른다.
   * 멱등: 이미 찍힌 사용자는 0행 UPDATE 로 끝난다. 프론트도 `localStorage` 로 브라우저당 1회.
   */
  @Post('me/desktop-seen')
  @HttpCode(204)
  async markDesktopWebSeen(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.markDesktopWebSeen(user.id);
  }

  @Post('me/dismiss-calendar-home-intro')
  @HttpCode(204)
  async dismissCalendarHomeIntro(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.dismissCalendarHomeIntro(user.id);
  }

  /** 면접 유도 모달 「다시 보지 않기」 — 전 카드 영구 차단 (멱등) */
  @Post('me/dismiss-interview-nudge')
  @HttpCode(204)
  async dismissInterviewNudge(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.dismissInterviewNudge(user.id);
  }

  @Post('me/ai-consent')
  @HttpCode(204)
  async agreeAiConsent(
    @CurrentUser() user: AuthUser,
    @Body() dto: AgreeAiConsentDto,
  ): Promise<void> {
    await this.usersService.agreeAiConsent(user.id, dto.version);
  }

  @Delete('me/ai-consent')
  @HttpCode(204)
  async withdrawAiConsent(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.withdrawAiConsent(user.id);
  }

  @Patch('me/nickname')
  async updateNickname(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateNicknameDto,
  ) {
    const updated = await this.usersService.updateNickname(
      user.id,
      dto.nickname,
    );
    return { nickname: updated.nickname };
  }

  @Delete('me')
  @HttpCode(204)
  async deleteAccount(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.deleteAccount(user.id);
  }

  @Get('me/dashboard-config')
  async getDashboardConfig(@CurrentUser() user: AuthUser) {
    return this.usersService.getDashboardConfig(user.id);
  }

  @Patch('me/dashboard-config')
  async updateDashboardConfig(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateDashboardConfigDto,
  ) {
    return this.usersService.updateDashboardConfig(user.id, dto);
  }
}
