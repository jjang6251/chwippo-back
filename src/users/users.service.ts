import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UpdateDashboardConfigDto } from './dto/update-dashboard-config.dto';
import { StorageUsageService } from '../myinfo/storage-usage.service';
import { FilesService } from '../files/files.service';
import { CURRENT_AI_CONSENT_VERSION } from '../ai/llm.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private repo: Repository<User>,
    private readonly storageUsage: StorageUsageService,
    private readonly filesService: FilesService,
  ) {}

  async agreeTerms(userId: string): Promise<void> {
    await this.repo.update(userId, { termsAgreedAt: new Date() });
  }

  /**
   * AI 사용 동의 — PIPA 26조 (제3자 처리 위탁 별도 동의).
   * client 가 보낸 version 이 서버 CURRENT_AI_CONSENT_VERSION 과 일치해야 저장.
   * 재호출 멱등 — timestamp 갱신.
   */
  async agreeAiConsent(userId: string, version: string): Promise<void> {
    if (version !== CURRENT_AI_CONSENT_VERSION) {
      throw new BadRequestException(
        `약관 version 불일치. 페이지를 새로고침 해주세요. (서버: ${CURRENT_AI_CONSENT_VERSION})`,
      );
    }
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    await this.repo.update(userId, {
      aiConsentAt: new Date(),
      aiConsentVersion: version,
    });
  }

  /**
   * AI 사용 동의 철회 — PIPA 26조 (동의/철회 동등 보장).
   * 철회 후 모든 AI 호출은 LlmService.checkConsent 에서 blocked_consent 로 차단.
   * 멱등 — 이미 철회된 user 재호출 OK.
   */
  async withdrawAiConsent(userId: string): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    await this.repo.update(userId, {
      aiConsentAt: null,
      aiConsentVersion: null,
    });
  }

  async markOnboarded(userId: string): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    if (!user.onboardedAt) {
      await this.repo.update(userId, { onboardedAt: new Date() });
    }
  }

  async updateNickname(userId: string, nickname: string): Promise<User> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    user.nickname = nickname;
    return this.repo.save(user);
  }

  async deleteAccount(userId: string): Promise<void> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    // 탈퇴 전 R2에 저장된 파일 URL 수집 (DB 삭제 후엔 조회 불가)
    const fileUrls = await this.storageUsage.collectAllFileUrls(userId);

    await this.repo.remove(user);

    // DB 삭제 성공 후 R2 cascade 정리 (best-effort, 실패해도 throw 안 함)
    for (const url of fileUrls) {
      await this.filesService.deleteFile(url);
    }
  }

  async countAll(): Promise<number> {
    return this.repo.count();
  }

  async countByDate(from: Date): Promise<number> {
    return this.repo
      .createQueryBuilder('u')
      .where('u.created_at >= :from', { from })
      .getCount();
  }

  private readonly DEFAULT_SECTIONS = [
    { id: 'stats', visible: true },
    { id: 'dday', visible: true },
    { id: 'todos', visible: true },
  ];

  async getDashboardConfig(
    userId: string,
  ): Promise<{ sections: { id: string; visible: boolean }[] }> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    return user.dashboardConfig ?? { sections: this.DEFAULT_SECTIONS };
  }

  async updateDashboardConfig(
    userId: string,
    dto: UpdateDashboardConfigDto,
  ): Promise<{ sections: { id: string; visible: boolean }[] }> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    if (dto.sections[0]?.id !== 'stats') {
      throw new BadRequestException('stats 섹션은 항상 첫 번째여야 합니다.');
    }

    user.dashboardConfig = { sections: dto.sections };
    const saved = await this.repo.save(user);
    return saved.dashboardConfig!;
  }
}
