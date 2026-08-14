import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import Expo, { ExpoPushReceipt } from 'expo-server-sdk';
import { UserDevice } from '../devices/user-device.entity';
import { PushReceipt } from './push-receipt.entity';

/** 발송 직후엔 영수증이 아직 없다 — 이만큼 지난 티켓만 조회한다 */
export const RECEIPT_MIN_AGE_MS = 15 * 60 * 1000;

/** 대기열 보관 기간 — Expo 영수증이 약 하루면 만료되므로 그 뒤는 조회해도 답이 없다 */
export const RECEIPT_RETENTION_DAYS = 7;

/** 한 주기에 처리할 최대 티켓 수 (Expo 요청 폭주 방지 · 남으면 다음 주기가 이어받는다) */
const MAX_TICKETS_PER_RUN = 2000;

export interface ReceiptProcessResult {
  /** 영수증 조회를 시도한 티켓 수 */
  checked: number;
  /** 영수증 응답을 받아 processed 로 마감한 티켓 수 */
  processed: number;
  /** DeviceNotRegistered 로 지운 device 행 수 */
  removedDevices: number;
}

/**
 * R4 — Expo push **영수증** 단계의 죽은 토큰 정리.
 *
 * 발송 티켓만 보던 기존 정리는 iOS 쪽만 잡혔다. FCM 은 `DeviceNotRegistered` 를
 * 대개 영수증에서 주기 때문에, 앱을 지운 안드로이드 기기의 행이 계속 남아 있었다.
 * (그 시체 행이 multi-device 오탐 알람의 원인이기도 했다.)
 *
 * 흐름: 발송이 `push_receipts` 에 ticket id 를 적는다 → 이 서비스가 15분 뒤부터
 * 영수증을 조회한다 → `DeviceNotRegistered` 면 device 행 삭제 → processed 마감.
 *
 * **에러 내성**: Expo 조회가 실패한 chunk 는 `processed_at` 을 안 찍고 넘어간다.
 * 그러면 다음 주기가 같은 티켓을 다시 집어간다 (별도 재시도 로직 불필요).
 */
@Injectable()
export class PushReceiptService {
  private readonly logger = new Logger(PushReceiptService.name);
  private readonly expo: Expo;

  constructor(
    @InjectRepository(PushReceipt)
    private readonly receiptRepo: Repository<PushReceipt>,
    @InjectRepository(UserDevice)
    private readonly deviceRepo: Repository<UserDevice>,
  ) {
    this.expo = new Expo(
      process.env.EXPO_ACCESS_TOKEN
        ? { accessToken: process.env.EXPO_ACCESS_TOKEN }
        : undefined,
    );
  }

  /** 미처리 티켓의 영수증을 조회해 죽은 device 를 정리한다 */
  async processPending(now: Date = new Date()): Promise<ReceiptProcessResult> {
    const rows = await this.receiptRepo.find({
      where: {
        processedAt: IsNull(),
        createdAt: LessThanOrEqual(
          new Date(now.getTime() - RECEIPT_MIN_AGE_MS),
        ),
      },
      order: { createdAt: 'ASC' },
      take: MAX_TICKETS_PER_RUN,
    });
    if (rows.length === 0) {
      return { checked: 0, processed: 0, removedDevices: 0 };
    }

    const tokenByTicket = new Map(rows.map((r) => [r.ticketId, r.deviceToken]));
    // Expo 는 한 요청에 영수증 1000개가 상한 — SDK 헬퍼가 그보다 보수적으로 쪼갠다
    const chunks = this.expo.chunkPushNotificationReceiptIds([
      ...tokenByTicket.keys(),
    ]);

    let processed = 0;
    let removedDevices = 0;

    for (const chunk of chunks) {
      let receipts: Record<string, ExpoPushReceipt>;
      try {
        receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
      } catch (err) {
        // processed_at 을 안 찍었으므로 다음 주기가 그대로 재시도한다
        this.logger.warn(
          `Expo 영수증 조회 실패 (다음 주기 재시도): ${(err as Error).message}`,
        );
        continue;
      }

      const doneTicketIds: string[] = [];
      const deadTokens: string[] = [];
      for (const [ticketId, receipt] of Object.entries(receipts)) {
        // 응답에 없는 id = 영수증이 아직 준비 안 됨 → 미처리로 남겨 다음 주기에 다시 본다
        doneTicketIds.push(ticketId);
        if (
          receipt.status === 'error' &&
          receipt.details?.error === 'DeviceNotRegistered'
        ) {
          const token = tokenByTicket.get(ticketId);
          if (token) deadTokens.push(token);
        }
      }
      if (doneTicketIds.length === 0) continue;

      /*
        DB 변경이 둘이지만 트랜잭션으로 묶지 않는다 — 순서로 안전을 만든다.
        device 삭제 → processed 기록 순이면, 중간에 실패해도 티켓이 미처리로 남아
        다음 주기가 같은 영수증을 다시 읽고 멱등하게 마무리한다 (이미 지워진 토큰은 0건 삭제).
        반대 순서였다면 "처리됐다고 표시된 시체 행" 이 영구히 남는다.
      */
      if (deadTokens.length > 0) {
        const res = await this.deviceRepo
          .createQueryBuilder()
          .delete()
          .where('device_token IN (:...tokens)', { tokens: deadTokens })
          .execute();
        removedDevices += res.affected ?? 0;
      }
      await this.receiptRepo.update(
        { ticketId: In(doneTicketIds) },
        { processedAt: now },
      );
      processed += doneTicketIds.length;
    }

    if (removedDevices > 0) {
      this.logger.log(
        `[PushReceipt] 죽은 device ${removedDevices}건 정리 (영수증 DeviceNotRegistered)`,
      );
    }
    return { checked: rows.length, processed, removedDevices };
  }

  /**
   * 오래된 대기열 정리.
   *
   * 처리 여부를 안 가리고 created_at 기준으로 지운다. 영수증은 Expo 쪽에서 하루면
   * 사라지므로, 7일이 지나도록 미처리인 행은 앞으로도 답을 못 받는다 — 남겨두면
   * 매 주기 조회 대상만 부풀린다.
   */
  async purgeOld(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const res = await this.receiptRepo.delete({ createdAt: LessThan(cutoff) });
    return res.affected ?? 0;
  }
}
