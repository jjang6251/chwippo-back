import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { Application } from '../applications/application.entity';
import { Inquiry } from '../inquiries/inquiry.entity';
import { AdminAuditService } from './admin-audit.service';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';
import { UserProfile } from '../myinfo/entities/user-profile.entity';
import { Education } from '../myinfo/entities/education.entity';
import { Experience } from '../myinfo/entities/experience.entity';
import { Cert } from '../myinfo/entities/cert.entity';
import { LanguageCert } from '../myinfo/entities/language-cert.entity';
import { Award } from '../myinfo/entities/award.entity';
import { Document } from '../myinfo/entities/document.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { StorageUsageService } from '../myinfo/storage-usage.service';

function escapeSearch(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function omitSensitive(user: User): Omit<User, 'refreshToken' | 'kakaoId'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { refreshToken: _r, kakaoId: _k, ...safe } = user;
  return safe;
}

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(Inquiry)
    private readonly inquiryRepo: Repository<Inquiry>,
    @InjectRepository(Cert) private readonly certRepo: Repository<Cert>,
    @InjectRepository(Award) private readonly awardRepo: Repository<Award>,
    @InjectRepository(LanguageCert)
    private readonly langCertRepo: Repository<LanguageCert>,
    @InjectRepository(Experience)
    private readonly expRepo: Repository<Experience>,
    @InjectRepository(CoverletterCustom)
    private readonly coverCustomRepo: Repository<CoverletterCustom>,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectRepository(Education)
    private readonly eduRepo: Repository<Education>,
    private readonly dataSource: DataSource,
    private readonly auditService: AdminAuditService,
    private readonly storageUsage: StorageUsageService,
  ) {}

  async findAll(query: {
    page?: number;
    limit?: number;
    search?: string;
    role?: string;
    suspended?: boolean;
  }): Promise<{ data: object[]; total: number }> {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(query.limit ?? 20, 100);

    const qb = this.userRepo
      .createQueryBuilder('u')
      .select([
        'u.id',
        'u.nickname',
        'u.email',
        'u.role',
        'u.suspendedAt',
        'u.createdAt',
        'u.lastActiveAt',
      ])
      .orderBy('u.lastActiveAt', 'DESC', 'NULLS LAST')
      .addOrderBy('u.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.search) {
      const escaped = escapeSearch(query.search);
      qb.andWhere("u.nickname ILIKE :search ESCAPE '\\'", {
        search: `%${escaped}%`,
      });
    }

    if (query.role) {
      qb.andWhere('u.role = :role', { role: query.role });
    }

    if (query.suspended === true) {
      qb.andWhere('u.suspendedAt IS NOT NULL');
    } else if (query.suspended === false) {
      qb.andWhere('u.suspendedAt IS NULL');
    }

    const [users, total] = await qb.getManyAndCount();
    return { data: users.map(omitSensitive), total };
  }

  async findOne(id: string): Promise<object> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    const [
      storage,
      applicationCount,
      cert,
      award,
      langCert,
      experience,
      coverletterCustom,
      document,
      education,
    ] = await Promise.all([
      this.storageUsage.getUsage(id),
      this.appRepo.count({ where: { userId: id, deletedAt: IsNull() } }),
      this.certRepo.count({ where: { user_id: id } }),
      this.awardRepo.count({ where: { user_id: id } }),
      this.langCertRepo.count({ where: { user_id: id } }),
      this.expRepo.count({ where: { user_id: id } }),
      this.coverCustomRepo.count({ where: { user_id: id } }),
      this.docRepo.count({ where: { user_id: id } }),
      this.eduRepo.count({ where: { user_id: id } }),
    ]);

    return {
      ...omitSensitive(user),
      stats: {
        storage,
        applicationCount,
        myinfoCount: {
          cert,
          award,
          languageCert: langCert,
          experience,
          coverletterCustom,
          document,
          education,
        },
      },
    };
  }

  async updateUser(
    adminId: string,
    userId: string,
    dto: UpdateAdminUserDto,
  ): Promise<void> {
    if (
      adminId === userId &&
      (dto.suspended !== undefined || dto.role !== undefined)
    ) {
      throw new ForbiddenException(
        '자기 자신의 정지·권한은 변경할 수 없습니다.',
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

      if (dto.suspended === true && !user.suspendedAt) {
        user.suspendedAt = new Date();
        await manager.save(User, user);
        await this.auditService.log(
          adminId,
          'suspend',
          'user',
          userId,
          {},
          manager,
        );
      }

      if (dto.suspended === false && user.suspendedAt) {
        user.suspendedAt = null;
        await manager.save(User, user);
        await this.auditService.log(
          adminId,
          'unsuspend',
          'user',
          userId,
          {},
          manager,
        );
      }

      if (dto.role !== undefined && dto.role !== user.role) {
        const action = dto.role === 'admin' ? 'grant_admin' : 'revoke_admin';
        const before = user.role;
        user.role = dto.role;
        await manager.save(User, user);
        await this.auditService.log(
          adminId,
          action,
          'user',
          userId,
          { before, after: dto.role },
          manager,
        );
      }

      if (dto.tier !== undefined && dto.tier !== user.tier) {
        const before = user.tier;
        user.tier = dto.tier;
        await manager.save(User, user);
        await this.auditService.log(
          adminId,
          'update_tier',
          'user',
          userId,
          { before, after: dto.tier },
          manager,
        );
      }

      if (dto.nickname !== undefined) {
        if (dto.nickname.trim().length === 0) {
          throw new BadRequestException('닉네임은 빈 값일 수 없습니다.');
        }
        if (dto.nickname.length > 100) {
          throw new BadRequestException('닉네임은 100자를 초과할 수 없습니다.');
        }
        if (dto.nickname !== user.nickname) {
          const before = user.nickname;
          user.nickname = dto.nickname;
          await manager.save(User, user);
          await this.auditService.log(
            adminId,
            'rename',
            'user',
            userId,
            { before, after: dto.nickname },
            manager,
          );
        }
      }
    });
  }

  async deleteUser(adminId: string, userId: string): Promise<void> {
    if (adminId === userId) {
      throw new ForbiddenException('자기 자신의 계정은 삭제할 수 없습니다.');
    }

    await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

      await this.auditService.log(
        adminId,
        'delete',
        'user',
        userId,
        {},
        manager,
      );
      await manager.remove(User, user);
    });
  }

  async warnUser(
    adminId: string,
    userId: string,
    message: string,
  ): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    await this.auditService.log(adminId, 'warn', 'user', userId, { message });
  }

  async exportUser(
    adminId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    const [
      applications,
      inquiries,
      profile,
      educations,
      experiences,
      certs,
      languageCerts,
      awards,
      documents,
      coverletters,
    ] = await Promise.all([
      this.appRepo.find({ where: { userId } }),
      this.inquiryRepo.find({ where: { user_id: userId } }),
      this.dataSource.manager.findOne(UserProfile, {
        where: { user_id: userId },
      }),
      this.dataSource.manager.find(Education, { where: { user_id: userId } }),
      this.dataSource.manager.find(Experience, { where: { user_id: userId } }),
      this.dataSource.manager.find(Cert, { where: { user_id: userId } }),
      this.dataSource.manager.find(LanguageCert, {
        where: { user_id: userId },
      }),
      this.dataSource.manager.find(Award, { where: { user_id: userId } }),
      this.dataSource.manager.find(Document, { where: { user_id: userId } }),
      this.dataSource.manager.find(CoverletterCustom, {
        where: { user_id: userId },
        order: { order_index: 'ASC' },
      }),
    ]);

    await this.auditService.log(adminId, 'export', 'user', userId, {});

    return {
      user: omitSensitive(user),
      applications,
      inquiries,
      myinfo: {
        profile,
        educations,
        experiences,
        certs,
        languageCerts,
        awards,
        documents,
        coverletters,
      },
    };
  }
}
