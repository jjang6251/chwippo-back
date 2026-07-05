import { Global, Module } from '@nestjs/common';
import { DiscordNotifier } from './discord-notifier';

/**
 * DiscordNotifier 전역 제공 — 여러 모듈(auth·users·inquiries·applications·admin·ai 등)이
 * 알람 caller 라서 @Global 로 한 번만 등록. ConfigService 만 의존.
 *
 * 기존 모듈에 로컬 provider 로 등록돼 있어도 무해 (Nest 는 로컬 우선 해석).
 */
@Global()
@Module({
  providers: [DiscordNotifier],
  exports: [DiscordNotifier],
})
export class NotifierModule {}
