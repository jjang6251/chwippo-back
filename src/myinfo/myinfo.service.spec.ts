import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { MyinfoService } from './myinfo.service';
import { UserProfile } from './entities/user-profile.entity';
import { LanguageCert } from './entities/language-cert.entity';
import { Cert } from './entities/cert.entity';
import { Award } from './entities/award.entity';
import { Experience } from './entities/experience.entity';
import { Coverletter } from './entities/coverletter.entity';
import { CoverletterCustom } from './entities/coverletter-custom.entity';
import { Document } from './entities/document.entity';
import { Education } from './entities/education.entity';

describe('MyinfoService', () => {
  let service: MyinfoService;
  let profileRepo: jest.Mocked<Repository<UserProfile>>;
  let langCertRepo: jest.Mocked<Repository<LanguageCert>>;
  let certRepo: jest.Mocked<Repository<Cert>>;
  let awardRepo: jest.Mocked<Repository<Award>>;
  let expRepo: jest.Mocked<Repository<Experience>>;
  let coverRepo: jest.Mocked<Repository<Coverletter>>;
  let documentRepo: jest.Mocked<Repository<Document>>;
  let coverCustomRepo: jest.Mocked<Repository<CoverletterCustom>>;
  let educationRepo: jest.Mocked<Repository<Education>>;

  const USER_ID = 'user-uuid-1';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MyinfoService,
        { provide: getRepositoryToken(UserProfile), useValue: mock<Repository<UserProfile>>() },
        { provide: getRepositoryToken(LanguageCert), useValue: mock<Repository<LanguageCert>>() },
        { provide: getRepositoryToken(Cert), useValue: mock<Repository<Cert>>() },
        { provide: getRepositoryToken(Award), useValue: mock<Repository<Award>>() },
        { provide: getRepositoryToken(Experience), useValue: mock<Repository<Experience>>() },
        { provide: getRepositoryToken(Coverletter), useValue: mock<Repository<Coverletter>>() },
        { provide: getRepositoryToken(Document), useValue: mock<Repository<Document>>() },
        { provide: getRepositoryToken(CoverletterCustom), useValue: mock<Repository<CoverletterCustom>>() },
        { provide: getRepositoryToken(Education), useValue: mock<Repository<Education>>() },
      ],
    }).compile();

    service = module.get<MyinfoService>(MyinfoService);
    profileRepo = module.get(getRepositoryToken(UserProfile));
    langCertRepo = module.get(getRepositoryToken(LanguageCert));
    certRepo = module.get(getRepositoryToken(Cert));
    awardRepo = module.get(getRepositoryToken(Award));
    expRepo = module.get(getRepositoryToken(Experience));
    coverRepo = module.get(getRepositoryToken(Coverletter));
    documentRepo = module.get(getRepositoryToken(Document));
    coverCustomRepo = module.get(getRepositoryToken(CoverletterCustom));
    educationRepo = module.get(getRepositoryToken(Education));
  });

  afterEach(() => jest.clearAllMocks());

  // ── getProfile ─────────────────────────────────────────
  describe('getProfile', () => {
    it('프로필 존재 → 기존 프로필 반환 (create/save 미호출)', async () => {
      const existing = { user_id: USER_ID, name: '홍길동' } as UserProfile;
      profileRepo.findOne.mockResolvedValue(existing);

      const result = await service.getProfile(USER_ID);

      expect(result).toEqual(existing);
      expect(profileRepo.save).not.toHaveBeenCalled();
    });

    it('프로필 없음 → create + save로 새 프로필 생성 반환', async () => {
      const fresh = { user_id: USER_ID } as UserProfile;
      profileRepo.findOne
        .mockResolvedValueOnce(null)  // 최초 조회
        .mockResolvedValue(fresh);    // save 후 getProfile 재조회
      profileRepo.create.mockReturnValue(fresh);
      profileRepo.save.mockResolvedValue(fresh);

      const result = await service.getProfile(USER_ID);

      expect(profileRepo.create).toHaveBeenCalledWith({ user_id: USER_ID });
      expect(profileRepo.save).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });
  });

  // ── updateProfile ──────────────────────────────────────
  describe('updateProfile', () => {
    it('upsert 호출 시 user_id 포함 + user_id를 conflict 키로 사용', async () => {
      const profile = { user_id: USER_ID, name: '홍길동' } as UserProfile;
      profileRepo.upsert.mockResolvedValue({} as any);
      profileRepo.findOne.mockResolvedValue(profile);
      profileRepo.create.mockReturnValue(profile);
      profileRepo.save.mockResolvedValue(profile);

      await service.updateProfile(USER_ID, { name: '홍길동' });

      expect(profileRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: USER_ID, name: '홍길동' }),
        ['user_id'],
      );
    });

    it('upsert 후 getProfile로 최신 데이터 반환', async () => {
      const profile = { user_id: USER_ID } as UserProfile;
      profileRepo.upsert.mockResolvedValue({} as any);
      profileRepo.findOne.mockResolvedValue(profile);

      const result = await service.updateProfile(USER_ID, {});

      expect(profileRepo.findOne).toHaveBeenCalledWith({ where: { user_id: USER_ID } });
      expect(result).toBeDefined();
    });
  });

  // ── LanguageCert CRUD ──────────────────────────────────
  describe('LanguageCert CRUD', () => {
    it('getLangCerts → user_id 조건, acquired_at DESC 정렬', async () => {
      langCertRepo.find.mockResolvedValue([]);
      await service.getLangCerts(USER_ID);

      expect(langCertRepo.find).toHaveBeenCalledWith({
        where: { user_id: USER_ID },
        order: { acquired_at: 'DESC' },
      });
    });

    it('createLangCert → create + save, user_id 포함', async () => {
      const cert = { id: 'lc-1', user_id: USER_ID, cert_type: 'TOEIC' } as LanguageCert;
      langCertRepo.create.mockReturnValue(cert);
      langCertRepo.save.mockResolvedValue(cert);

      await service.createLangCert(USER_ID, { cert_type: 'TOEIC' });

      expect(langCertRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: USER_ID, cert_type: 'TOEIC' }),
      );
      expect(langCertRepo.save).toHaveBeenCalled();
    });

    it('updateLangCert → { id, user_id } 조건으로 update (IDOR: 다른 유저 항목 silently no-op)', async () => {
      const cert = { id: 'lc-1', user_id: USER_ID } as LanguageCert;
      langCertRepo.update.mockResolvedValue({} as any);
      langCertRepo.findOne.mockResolvedValue(cert);

      await service.updateLangCert(USER_ID, 'lc-1', { score_grade: '900' });

      expect(langCertRepo.update).toHaveBeenCalledWith(
        { id: 'lc-1', user_id: USER_ID },
        { score_grade: '900' },
      );
    });

    it('deleteLangCert → { id, user_id } 조건으로 delete (IDOR: 다른 유저 항목 silently no-op)', async () => {
      langCertRepo.delete.mockResolvedValue({} as any);

      await service.deleteLangCert('other-user', 'lc-1');

      expect(langCertRepo.delete).toHaveBeenCalledWith({ id: 'lc-1', user_id: 'other-user' });
    });
  });

  // ── Cert CRUD ──────────────────────────────────────────
  describe('Cert CRUD', () => {
    it('getCerts → user_id 조건, acquired_at DESC 정렬', async () => {
      certRepo.find.mockResolvedValue([]);
      await service.getCerts(USER_ID);
      expect(certRepo.find).toHaveBeenCalledWith({
        where: { user_id: USER_ID },
        order: { acquired_at: 'DESC' },
      });
    });

    it('updateCert → { id, user_id } 조건 (IDOR silently no-op)', async () => {
      certRepo.update.mockResolvedValue({} as any);
      certRepo.findOne.mockResolvedValue(null);

      await service.updateCert('other-user', 'cert-1', { name: 'SQLD' });

      expect(certRepo.update).toHaveBeenCalledWith(
        { id: 'cert-1', user_id: 'other-user' },
        { name: 'SQLD' },
      );
    });
  });

  // ── Award CRUD ─────────────────────────────────────────
  describe('Award CRUD', () => {
    it('getAwards → user_id 조건, awarded_at DESC 정렬', async () => {
      awardRepo.find.mockResolvedValue([]);
      await service.getAwards(USER_ID);
      expect(awardRepo.find).toHaveBeenCalledWith({
        where: { user_id: USER_ID },
        order: { awarded_at: 'DESC' },
      });
    });

    it('deleteAward → { id, user_id } 조건', async () => {
      awardRepo.delete.mockResolvedValue({} as any);
      await service.deleteAward(USER_ID, 'award-1');
      expect(awardRepo.delete).toHaveBeenCalledWith({ id: 'award-1', user_id: USER_ID });
    });
  });

  // ── Experience CRUD ────────────────────────────────────
  describe('Experience CRUD', () => {
    it('getExperiences → start_at DESC 정렬', async () => {
      expRepo.find.mockResolvedValue([]);
      await service.getExperiences(USER_ID);
      expect(expRepo.find).toHaveBeenCalledWith({
        where: { user_id: USER_ID },
        order: { start_at: 'DESC' },
      });
    });
  });

  // ── Education CRUD ────────────────────────────────────
  describe('Education CRUD', () => {
    it('getEducations → userId 필터 + start_at DESC 정렬', async () => {
      educationRepo.find.mockResolvedValue([]);
      await service.getEducations(USER_ID);
      expect(educationRepo.find).toHaveBeenCalledWith({
        where: { user_id: USER_ID },
        order: { start_at: 'DESC' },
      });
    });

    it('createEducation → dto에 user_id 자동 주입', async () => {
      const dto = { school_name: '서울대학교', degree: '대학교 (학사)' };
      const created = { id: 'edu-1', ...dto, user_id: USER_ID } as Education;
      educationRepo.create.mockReturnValue(created);
      educationRepo.save.mockResolvedValue(created);

      await service.createEducation(USER_ID, dto);

      expect(educationRepo.create).toHaveBeenCalledWith({ ...dto, user_id: USER_ID });
      expect(educationRepo.save).toHaveBeenCalledWith(created);
    });

    it('updateEducation → id + user_id 조건으로 update (IDOR 방어)', async () => {
      const dto = { major: '컴퓨터공학' };
      await service.updateEducation(USER_ID, 'edu-1', dto);
      expect(educationRepo.update).toHaveBeenCalledWith(
        { id: 'edu-1', user_id: USER_ID },
        dto,
      );
    });

    it('updateEducation → 갱신 후 본인 row만 조회해 반환', async () => {
      const updated = { id: 'edu-1', school_name: '서울대', user_id: USER_ID } as Education;
      educationRepo.findOne.mockResolvedValue(updated);
      const result = await service.updateEducation(USER_ID, 'edu-1', {});
      expect(educationRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'edu-1', user_id: USER_ID },
      });
      expect(result).toEqual(updated);
    });

    it('deleteEducation → id + user_id 조건으로 delete (IDOR 방어)', async () => {
      await service.deleteEducation(USER_ID, 'edu-1');
      expect(educationRepo.delete).toHaveBeenCalledWith({ id: 'edu-1', user_id: USER_ID });
    });

    it('타인 학력 update 시도 → user_id 조건으로 막힘 (where 조건 검증)', async () => {
      await service.updateEducation('attacker-uid', 'edu-1', { school_name: 'hack' });
      // 공격자 userId가 들어가지만 where 조건에 user_id 포함되어 row 매칭 안 됨
      expect(educationRepo.update).toHaveBeenCalledWith(
        { id: 'edu-1', user_id: 'attacker-uid' },
        { school_name: 'hack' },
      );
    });
  });

  // ── Coverletter ────────────────────────────────────────
  describe('getCoverletter', () => {
    it('coverletter 없으면 { user_id } 기본값 + custom 빈 배열 반환', async () => {
      coverRepo.findOne.mockResolvedValue(null);
      coverCustomRepo.find.mockResolvedValue([]);

      const result = await service.getCoverletter(USER_ID);

      expect(result.coverletter).toEqual({ user_id: USER_ID });
      expect(result.custom).toEqual([]);
    });

    it('custom 항목은 order_index ASC로 조회', async () => {
      coverRepo.findOne.mockResolvedValue({ user_id: USER_ID } as Coverletter);
      coverCustomRepo.find.mockResolvedValue([]);

      await service.getCoverletter(USER_ID);

      expect(coverCustomRepo.find).toHaveBeenCalledWith({
        where: { user_id: USER_ID },
        order: { order_index: 'ASC' },
      });
    });
  });

  describe('updateCoverletter', () => {
    it('upsert 호출 후 findOne으로 최신 데이터 반환', async () => {
      const cl = { user_id: USER_ID } as Coverletter;
      coverRepo.upsert.mockResolvedValue({} as any);
      coverRepo.findOne.mockResolvedValue(cl);

      const result = await service.updateCoverletter(USER_ID, { personality_strength: '성실함' });

      expect(coverRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: USER_ID }),
        ['user_id'],
      );
      expect(result).toEqual(cl);
    });
  });

  // ── CoverletterCustom ──────────────────────────────────
  describe('CoverletterCustom CRUD', () => {
    it('createCustomItem → label, order_index, content 빈 문자열로 생성', async () => {
      const item = { id: 'cc-1', user_id: USER_ID, label: '해외 경험', order_index: 0, content: '' } as CoverletterCustom;
      coverCustomRepo.create.mockReturnValue(item);
      coverCustomRepo.save.mockResolvedValue(item);

      await service.createCustomItem(USER_ID, '해외 경험', 0);

      expect(coverCustomRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: USER_ID, label: '해외 경험', order_index: 0, content: '' }),
      );
    });

    it('updateCustomItem → { id, user_id } 조건 (IDOR silently no-op)', async () => {
      coverCustomRepo.update.mockResolvedValue({} as any);
      coverCustomRepo.findOne.mockResolvedValue(null);

      await service.updateCustomItem('other-user', 'cc-1', { content: '수정' });

      expect(coverCustomRepo.update).toHaveBeenCalledWith(
        { id: 'cc-1', user_id: 'other-user' },
        { content: '수정' },
      );
    });

    it('deleteCustomItem → { id, user_id } 조건', async () => {
      coverCustomRepo.delete.mockResolvedValue({} as any);
      await service.deleteCustomItem(USER_ID, 'cc-1');
      expect(coverCustomRepo.delete).toHaveBeenCalledWith({ id: 'cc-1', user_id: USER_ID });
    });
  });

  // ── Documents ──────────────────────────────────────────
  describe('Documents', () => {
    it('getDocuments → user_id 조건, created_at DESC 정렬', async () => {
      documentRepo.find.mockResolvedValue([]);
      await service.getDocuments(USER_ID);
      expect(documentRepo.find).toHaveBeenCalledWith({
        where: { user_id: USER_ID },
        order: { created_at: 'DESC' },
      });
    });

    it('createDocument → title, category, file_url, user_id 포함', async () => {
      const doc = { id: 'doc-1', user_id: USER_ID } as Document;
      documentRepo.create.mockReturnValue(doc);
      documentRepo.save.mockResolvedValue(doc);

      await service.createDocument(USER_ID, {
        title: '성적증명서',
        category: '학교서류',
        file_url: 'https://s3.example.com/file.pdf',
      });

      expect(documentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: USER_ID,
          title: '성적증명서',
          file_url: 'https://s3.example.com/file.pdf',
        }),
      );
    });

    it('deleteDocument → { id, user_id } 조건 (IDOR silently no-op)', async () => {
      documentRepo.delete.mockResolvedValue({} as any);
      await service.deleteDocument('other-user', 'doc-1');
      expect(documentRepo.delete).toHaveBeenCalledWith({ id: 'doc-1', user_id: 'other-user' });
    });
  });
});
