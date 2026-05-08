import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UpdateDashboardConfigDto } from './dto/update-dashboard-config.dto';

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private repo: Repository<User>) {}

  async agreeTerms(userId: string): Promise<void> {
    await this.repo.update(userId, { termsAgreedAt: new Date() });
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
    await this.repo.remove(user);
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

  async getDashboardConfig(userId: string): Promise<{ sections: { id: string; visible: boolean }[] }> {
    const user = await this.repo.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');
    return user.dashboardConfig ?? { sections: this.DEFAULT_SECTIONS };
  }

  async updateDashboardConfig(userId: string, dto: UpdateDashboardConfigDto): Promise<{ sections: { id: string; visible: boolean }[] }> {
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
