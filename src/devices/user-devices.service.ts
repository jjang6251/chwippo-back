import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { UserDevice } from './user-device.entity';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { DiscordNotifier, DISCORD_COLORS } from '../common/discord-notifier';

/**
 * 마지막 알람 시각 (userId → epoch ms) — 같은 사용자에게 하루 1회만 알린다.
 *
 * ⚠️ 프로세스 메모리라 재시작하면 초기화된다 = 재시작 직후 한 번 더 나갈 수 있다.
 * 그걸 감수하는 이유는 (1) 이 알람이 best-effort 운영 신호일 뿐이고,
 * (2) 마이그레이션 없이 오탐 폭주를 오늘 막는 게 우선이며,
 * (3) 운영이 EC2 단일 프로세스라 인스턴스 간 불일치가 생기지 않기 때문이다.
 * 다중 인스턴스로 가면 이 억제는 무력해지므로 그때 DB·Redis 로 옮겨야 한다.
 */
const multiDeviceAlertedAt = new Map<string, number>();

/**
 * W2 RN — 사용자 device token 등록·조회·해제.
 *
 * 정책:
 *   - deviceToken UNIQUE (한 물리 device = 한 row)
 *   - upsert 로직:
 *     · 신규 → INSERT
 *     · 같은 사용자 재등록 → last_active_at · app_version 갱신 (idempotent)
 *     · 다른 사용자 재등록 → 이전 소유자 record 삭제 + 신규 INSERT
 *       (기기 재사용 · 이전 로그인 계정 다름 케이스)
 *   - abuser detection: user 당 **최근 활동** device 5+ 발견 시 Discord ops 알림 (fair-use)
 *
 * 실제 push 발송 (APNs/FCM) 은 W3 별도 서비스.
 */
@Injectable()
export class UserDevicesService {
  private readonly logger = new Logger(UserDevicesService.name);
  private static readonly ABUSER_DEVICE_THRESHOLD = 5;

  /**
   * 카운트에 넣을 "살아있는" 기준 — last_active_at 이 30일 이내.
   *
   * 세는 단위가 물리 기기가 아니라 **push 토큰 행**이라서 그렇다. 같은 폰이라도
   * 재설치·데이터 삭제·알림 권한 재설정 때마다 새 토큰 = 새 행이 생기고,
   * 그 죽은 행이 카운트를 부풀려 기기 2대짜리 계정이 임계를 넘었다 (2026-08-13 실측).
   * R4 receipt 정리가 죽은 행을 지우지만 그것도 완전하지는 않다 —
   * 앱을 지운 기기는 발송 대상이 되어야 비로소 DeviceNotRegistered 가 잡히므로
   * 발송이 없으면 시체가 계속 남는다. 그래서 시간 창으로 한 겹 더 막는다.
   */
  private static readonly ACTIVE_WINDOW_DAYS = 30;

  /** 같은 사용자 알람 억제 간격 — 하루 1회 */
  private static readonly ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

  constructor(
    @InjectRepository(UserDevice)
    private readonly repo: Repository<UserDevice>,
    private readonly discord: DiscordNotifier,
  ) {}

  async registerDevice(
    userId: string,
    dto: RegisterDeviceDto,
  ): Promise<UserDevice> {
    const existing = await this.repo.findOne({
      where: { deviceToken: dto.deviceToken },
    });

    if (existing) {
      if (existing.userId === userId) {
        existing.lastActiveAt = new Date();
        existing.appVersion = dto.appVersion ?? existing.appVersion;
        existing.platform = dto.platform;
        return this.repo.save(existing);
      }
      // 다른 소유자 → 기기 재사용 · 이전 record 제거 후 신규 INSERT
      await this.repo.remove(existing);
    }

    const device = this.repo.create({
      userId,
      deviceToken: dto.deviceToken,
      platform: dto.platform,
      appVersion: dto.appVersion ?? null,
      lastActiveAt: new Date(),
    });
    const saved = await this.repo.save(device);

    await this.alertIfTooManyActiveDevices(userId, dto.platform);

    return saved;
  }

  /**
   * fair-use 경고 (best-effort) — 최근 활동 device 5+ · 사용자당 하루 1회.
   * 진짜 장애가 아니므로 critical(삐뽀) 이 아니라 ops 채널 · 노랑으로 보낸다.
   */
  private async alertIfTooManyActiveDevices(
    userId: string,
    platform: string,
  ): Promise<void> {
    const activeSince = new Date(
      Date.now() - UserDevicesService.ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const count = await this.repo.count({
      where: { userId, lastActiveAt: MoreThanOrEqual(activeSince) },
    });
    if (count < UserDevicesService.ABUSER_DEVICE_THRESHOLD) return;

    const lastAlertedAt = multiDeviceAlertedAt.get(userId);
    if (
      lastAlertedAt !== undefined &&
      Date.now() - lastAlertedAt < UserDevicesService.ALERT_COOLDOWN_MS
    ) {
      return;
    }
    multiDeviceAlertedAt.set(userId, Date.now());

    void this.discord
      .notify(
        {
          title: '⚠️ Multi-device alert',
          color: DISCORD_COLORS.yellow,
          fields: [
            { name: 'active device count', value: String(count), inline: true },
            { name: 'platform', value: platform, inline: true },
            { name: 'userId', value: userId },
          ],
        },
        'ops',
      )
      .catch((err) =>
        this.logger.warn(
          `Discord multi-device alert failed: ${(err as Error).message}`,
        ),
      );
  }

  async listMyDevices(userId: string): Promise<UserDevice[]> {
    return this.repo.find({
      where: { userId },
      order: { lastActiveAt: 'DESC' },
    });
  }

  /**
   * device token 해제. deviceToken 이 다른 사용자 것이면 ForbiddenException (IDOR 방어).
   * 존재하지 않으면 idempotent (no-op).
   */
  async removeDevice(userId: string, deviceToken: string): Promise<void> {
    const device = await this.repo.findOne({ where: { deviceToken } });
    if (!device) return;

    if (device.userId !== userId) {
      throw new ForbiddenException(
        '다른 사용자의 device 를 해제할 수 없습니다.',
      );
    }

    await this.repo.remove(device);
  }
}
