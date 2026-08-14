/**
 * expo-server-sdk jest mock — ESM-only 빌드(import.meta)라 ts-jest 로 transform 불가.
 * 테스트는 실제 push 발송 안 함 (Phase A) → SDK 표면만 stub.
 * jest.config moduleNameMapper 로 연결. production 은 실제 패키지 사용.
 */
export interface ExpoPushMessage {
  to: string;
  title?: string;
  body?: string;
  sound?: string;
  data?: Record<string, unknown>;
}
export interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  details?: { error?: string };
}
export interface ExpoPushReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

export default class Expo {
  static isExpoPushToken(token: unknown): boolean {
    return typeof token === 'string' && token.startsWith('ExponentPushToken[');
  }
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
    const chunks: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += 100) {
      chunks.push(messages.slice(i, i + 100));
    }
    return chunks;
  }
  async sendPushNotificationsAsync(
    messages: ExpoPushMessage[],
  ): Promise<ExpoPushTicket[]> {
    return messages.map(() => ({ status: 'ok' as const, id: 'mock-ticket' }));
  }
  /** 실제 SDK 와 같은 300개 단위 (Expo 요청 상한 1000 보다 보수적) */
  chunkPushNotificationReceiptIds(receiptIds: string[]): string[][] {
    const chunks: string[][] = [];
    for (let i = 0; i < receiptIds.length; i += 300) {
      chunks.push(receiptIds.slice(i, i + 300));
    }
    return chunks;
  }
  async getPushNotificationReceiptsAsync(
    receiptIds: string[],
  ): Promise<Record<string, ExpoPushReceipt>> {
    return Object.fromEntries(
      receiptIds.map((id) => [id, { status: 'ok' as const }]),
    );
  }
}
