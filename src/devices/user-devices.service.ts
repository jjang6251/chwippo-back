import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserDevice } from './user-device.entity';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { DiscordNotifier } from '../common/discord-notifier';

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
 *   - abuser detection: user 당 5+ device 발견 시 Discord warn (fair-use)
 *
 * 실제 push 발송 (APNs/FCM) 은 W3 별도 서비스.
 */
@Injectable()
export class UserDevicesService {
  private readonly logger = new Logger(UserDevicesService.name);
  private static readonly ABUSER_DEVICE_THRESHOLD = 5;

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

    // fair-use 경고: user 당 device 5+ (best-effort)
    const count = await this.repo.count({ where: { userId } });
    if (count >= UserDevicesService.ABUSER_DEVICE_THRESHOLD) {
      void this.discord
        .notify(
          `⚠️ **Multi-device alert**\n- userId: \`${userId}\`\n- device count: ${count}\n- 최신 platform: \`${dto.platform}\``,
        )
        .catch((err) =>
          this.logger.warn(
            `Discord multi-device alert failed: ${(err as Error).message}`,
          ),
        );
    }

    return saved;
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
