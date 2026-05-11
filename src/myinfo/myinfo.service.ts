import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProfile } from './entities/user-profile.entity';
import { LanguageCert } from './entities/language-cert.entity';
import { Cert } from './entities/cert.entity';
import { Award } from './entities/award.entity';
import { Experience } from './entities/experience.entity';
import { Coverletter } from './entities/coverletter.entity';
import { CoverletterCustom } from './entities/coverletter-custom.entity';
import { Document } from './entities/document.entity';
import { Education } from './entities/education.entity';

@Injectable()
export class MyinfoService {
  constructor(
    @InjectRepository(UserProfile) private profileRepo: Repository<UserProfile>,
    @InjectRepository(LanguageCert) private langCertRepo: Repository<LanguageCert>,
    @InjectRepository(Cert) private certRepo: Repository<Cert>,
    @InjectRepository(Award) private awardRepo: Repository<Award>,
    @InjectRepository(Experience) private expRepo: Repository<Experience>,
    @InjectRepository(Coverletter) private coverRepo: Repository<Coverletter>,
    @InjectRepository(Document) private documentRepo: Repository<Document>,
    @InjectRepository(CoverletterCustom) private coverCustomRepo: Repository<CoverletterCustom>,
    @InjectRepository(Education) private educationRepo: Repository<Education>,
  ) {}

  // ── Educations ────────────────────────────────────────────
  async getEducations(userId: string) {
    return this.educationRepo.find({ where: { user_id: userId }, order: { start_at: 'DESC' } });
  }
  async createEducation(userId: string, dto: Partial<Education>) {
    return this.educationRepo.save(this.educationRepo.create({ ...dto, user_id: userId }));
  }
  async updateEducation(userId: string, id: string, dto: Partial<Education>) {
    await this.educationRepo.update({ id, user_id: userId }, dto);
    return this.educationRepo.findOne({ where: { id, user_id: userId } });
  }
  async deleteEducation(userId: string, id: string) {
    await this.educationRepo.delete({ id, user_id: userId });
  }

  // ── Profile ──────────────────────────────────────────────
  async getProfile(userId: string): Promise<UserProfile> {
    const profile = await this.profileRepo.findOne({ where: { user_id: userId } });
    if (!profile) {
      const fresh = this.profileRepo.create({ user_id: userId });
      return this.profileRepo.save(fresh);
    }
    return profile;
  }

  async updateProfile(userId: string, dto: Partial<UserProfile>): Promise<UserProfile> {
    await this.profileRepo.upsert({ ...dto, user_id: userId }, ['user_id']);
    return this.getProfile(userId);
  }

  // ── Language Certs ────────────────────────────────────────
  async getLangCerts(userId: string) {
    return this.langCertRepo.find({ where: { user_id: userId }, order: { acquired_at: 'DESC' } });
  }
  async createLangCert(userId: string, dto: Partial<LanguageCert>) {
    return this.langCertRepo.save(this.langCertRepo.create({ ...dto, user_id: userId }));
  }
  async updateLangCert(userId: string, id: string, dto: Partial<LanguageCert>) {
    await this.langCertRepo.update({ id, user_id: userId }, dto);
    return this.langCertRepo.findOne({ where: { id, user_id: userId } });
  }
  async deleteLangCert(userId: string, id: string) {
    await this.langCertRepo.delete({ id, user_id: userId });
  }

  // ── Certs ─────────────────────────────────────────────────
  async getCerts(userId: string) {
    return this.certRepo.find({ where: { user_id: userId }, order: { acquired_at: 'DESC' } });
  }
  async createCert(userId: string, dto: Partial<Cert>) {
    return this.certRepo.save(this.certRepo.create({ ...dto, user_id: userId }));
  }
  async updateCert(userId: string, id: string, dto: Partial<Cert>) {
    await this.certRepo.update({ id, user_id: userId }, dto);
    return this.certRepo.findOne({ where: { id, user_id: userId } });
  }
  async deleteCert(userId: string, id: string) {
    await this.certRepo.delete({ id, user_id: userId });
  }

  // ── Awards ────────────────────────────────────────────────
  async getAwards(userId: string) {
    return this.awardRepo.find({ where: { user_id: userId }, order: { awarded_at: 'DESC' } });
  }
  async createAward(userId: string, dto: Partial<Award>) {
    return this.awardRepo.save(this.awardRepo.create({ ...dto, user_id: userId }));
  }
  async updateAward(userId: string, id: string, dto: Partial<Award>) {
    await this.awardRepo.update({ id, user_id: userId }, dto);
    return this.awardRepo.findOne({ where: { id, user_id: userId } });
  }
  async deleteAward(userId: string, id: string) {
    await this.awardRepo.delete({ id, user_id: userId });
  }

  // ── Experiences ───────────────────────────────────────────
  async getExperiences(userId: string) {
    return this.expRepo.find({ where: { user_id: userId }, order: { start_at: 'DESC' } });
  }
  async createExperience(userId: string, dto: Partial<Experience>) {
    return this.expRepo.save(this.expRepo.create({ ...dto, user_id: userId }));
  }
  async updateExperience(userId: string, id: string, dto: Partial<Experience>) {
    await this.expRepo.update({ id, user_id: userId }, dto);
    return this.expRepo.findOne({ where: { id, user_id: userId } });
  }
  async deleteExperience(userId: string, id: string) {
    await this.expRepo.delete({ id, user_id: userId });
  }

  // ── Coverletter ───────────────────────────────────────────
  async getCoverletter(userId: string) {
    const cl = await this.coverRepo.findOne({ where: { user_id: userId } });
    const custom = await this.coverCustomRepo.find({
      where: { user_id: userId },
      order: { order_index: 'ASC' },
    });
    return { coverletter: cl ?? { user_id: userId }, custom };
  }

  async updateCoverletter(userId: string, dto: Partial<Coverletter>) {
    await this.coverRepo.upsert({ ...dto, user_id: userId }, ['user_id']);
    return this.coverRepo.findOne({ where: { user_id: userId } });
  }

  async createCustomItem(userId: string, label: string, order_index: number) {
    return this.coverCustomRepo.save(
      this.coverCustomRepo.create({ user_id: userId, label, order_index, content: '' }),
    );
  }

  async updateCustomItem(userId: string, id: string, dto: Partial<CoverletterCustom>) {
    await this.coverCustomRepo.update({ id, user_id: userId }, dto);
    return this.coverCustomRepo.findOne({ where: { id, user_id: userId } });
  }

  async deleteCustomItem(userId: string, id: string) {
    await this.coverCustomRepo.delete({ id, user_id: userId });
  }

  // ── Documents ─────────────────────────────────────────────
  async getDocuments(userId: string) {
    return this.documentRepo.find({ where: { user_id: userId }, order: { created_at: 'DESC' } });
  }

  async createDocument(userId: string, dto: { title: string; category?: string; file_url: string }) {
    return this.documentRepo.save(this.documentRepo.create({ ...dto, user_id: userId }));
  }

  async deleteDocument(userId: string, id: string) {
    await this.documentRepo.delete({ id, user_id: userId });
  }
}
