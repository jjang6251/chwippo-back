import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Expo, { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { UserDevice } from '../devices/user-device.entity';
import { PushReceipt } from './push-receipt.entity';

export interface PushPayload {
  title: string;
  body: string;
  /** 탭 시 이동할 우리 앱 내부 경로 (예 '/board/:id') */
  deepLink?: string | null;
  /** 추가 데이터 (native 수신 핸들러 전달) */
  data?: Record<string, unknown>;
}

export interface PushSendResult {
  /** 유효 토큰으로 발송 시도한 수 */
  sent: number;
  /** DeviceNotRegistered 등으로 죽은 것으로 판명돼 정리한 토큰 수 */
  removedInvalid: number;
  /** Expo push tickets (로그 저장용) */
  tickets: ExpoPushTicket[];
}

/**
 * Expo Push Service 래퍼.
 *
 * - Expo push token 만 발송 (`ExponentPushToken[...]` 형식). 형식 아니면 skip.
 * - 100개 chunk 발송 (Expo 권장).
 * - `DeviceNotRegistered` ticket → 죽은 device 자동 삭제 (user_devices).
 * - EXPO_ACCESS_TOKEN 있으면 사용 (rate limit 완화 · 없어도 발송 됨).
 *
 * ticket 단계로는 죽은 토큰이 다 안 잡힌다 (FCM 은 대개 영수증 단계에서 알려준다).
 * 그래서 정상 ticket id 를 `push_receipts` 에 적어두고 뒤처리는 PushReceiptService 가 맡는다.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expo: Expo;

  constructor(
    @InjectRepository(UserDevice)
    private readonly deviceRepo: Repository<UserDevice>,
    @InjectRepository(PushReceipt)
    private readonly receiptRepo: Repository<PushReceipt>,
  ) {
    this.expo = new Expo(
      process.env.EXPO_ACCESS_TOKEN
        ? { accessToken: process.env.EXPO_ACCESS_TOKEN }
        : undefined,
    );
  }

  /**
   * 한 사용자의 모든 유효 device 로 발송.
   * @param deviceTokens 해당 사용자 device token 배열
   */
  async sendToTokens(
    deviceTokens: string[],
    payload: PushPayload,
  ): Promise<PushSendResult> {
    const valid = deviceTokens.filter((t) => Expo.isExpoPushToken(t));
    if (valid.length === 0) {
      return { sent: 0, removedInvalid: 0, tickets: [] };
    }

    const messages: ExpoPushMessage[] = valid.map((to) => ({
      to,
      title: payload.title,
      body: payload.body,
      sound: 'default',
      // Android 절전 기기에서 기본(normal) 은 배달이 수십 분 유예됨 (실측).
      // 마감·면접 리마인더는 시간 민감 알림이라 high 로 즉시 배달.
      priority: 'high' as const,
      data: {
        ...(payload.data ?? {}),
        ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
      },
    }));

    const tickets: ExpoPushTicket[] = [];
    const invalidTokens: string[] = [];
    const pendingReceipts: { ticketId: string; deviceToken: string }[] = [];
    const chunks = this.expo.chunkPushNotifications(messages);

    for (const chunk of chunks) {
      try {
        const chunkTickets = await this.expo.sendPushNotificationsAsync(chunk);
        chunkTickets.forEach((ticket, i) => {
          tickets.push(ticket);
          // chunk 순서 = valid 순서 (chunk 는 순차 slice)
          const token = chunk[i].to;
          if (typeof token !== 'string') return;

          if (ticket.status === 'ok') {
            // 영수증 확인 대기열 — 진짜 배달 실패는 여기서만 드러난다
            pendingReceipts.push({ ticketId: ticket.id, deviceToken: token });
          } else if (ticket.details?.error === 'DeviceNotRegistered') {
            invalidTokens.push(token);
          }
        });
      } catch (err) {
        this.logger.error(
          `Expo push chunk 발송 실패: ${(err as Error).message}`,
        );
      }
    }

    // best-effort — 대기열 저장이 실패해도 발송은 이미 끝났고 사용자에겐 영향이 없다.
    // (놓친 티켓은 죽은 토큰 정리가 한 주기 늦어질 뿐이다)
    if (pendingReceipts.length > 0) {
      try {
        await this.receiptRepo.insert(pendingReceipts);
      } catch (err) {
        this.logger.warn(
          `push ticket 저장 실패 (영수증 확인 skip): ${(err as Error).message}`,
        );
      }
    }

    let removedInvalid = 0;
    if (invalidTokens.length > 0) {
      const res = await this.deviceRepo
        .createQueryBuilder()
        .delete()
        .where('device_token IN (:...tokens)', { tokens: invalidTokens })
        .execute();
      removedInvalid = res.affected ?? 0;
      this.logger.log(
        `[PushService] 죽은 device ${removedInvalid}건 정리 (DeviceNotRegistered)`,
      );
    }

    return { sent: valid.length, removedInvalid, tickets };
  }
}
