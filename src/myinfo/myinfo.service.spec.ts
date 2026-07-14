import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DataSource, EntityManager, ObjectLiteral, Repository } from 'typeorm';
import { MyinfoService } from './myinfo.service';
import { StorageUsageService } from './storage-usage.service';
import { UserProfile } from './entities/user-profile.entity';
import { LanguageCert } from './entities/language-cert.entity';
import { Cert } from './entities/cert.entity';
import { Award } from './entities/award.entity';
import { Experience } from './entities/experience.entity';
import { Coverletter } from './entities/coverletter.entity';
import { CoverletterCustom } from './entities/coverletter-custom.entity';
import { Document } from './entities/document.entity';
import { Education } from './entities/education.entity';
import { FilesService } from '../files/files.service';

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
  let storageUsage: jest.Mocked<StorageUsageService>;
  let filesService: jest.Mocked<FilesService>;
  let mockManager: jest.Mocked<EntityManager>;

  const USER_ID = 'user-uuid-1';

  beforeEach(async () => {
    profileRepo = mock<Repository<UserProfile>>();
    langCertRepo = mock<Repository<LanguageCert>>();
    certRepo = mock<Repository<Cert>>();
    awardRepo = mock<Repository<Award>>();
    expRepo = mock<Repository<Experience>>();
    coverRepo = mock<Repository<Coverletter>>();
    documentRepo = mock<Repository<Document>>();
    coverCustomRepo = mock<Repository<CoverletterCustom>>();
    educationRepo = mock<Repository<Education>>();
    storageUsage = mock<StorageUsageService>();
    filesService = mock<FilesService>();

    // 트랜잭션 내 manager가 동일한 mock repo들을 반환하도록 — 외부 mock 설정이 transaction 안에서도 그대로 적용됨
    mockManager = mock<EntityManager>();
    mockManager.query.mockResolvedValue([]);
    mockManager.getRepository.mockImplementation((entity: unknown) => {
      if (entity === Cert) return certRepo;
      if (entity === Award) return awardRepo;
      if (entity === LanguageCert) return langCertRepo;
      if (entity === Document) return documentRepo;
      if (entity === Education) return educationRepo;
      if (entity === Experience) return expRepo;
      if (entity === Coverletter) return coverRepo;
      if (entity === CoverletterCustom) return coverCustomRepo;
      return mock<Repository<ObjectLiteral>>();
    });
    storageUsage.assertWithinLimit.mockResolvedValue(undefined);

    const mockDataSource = mock<DataSource>();
    mockDataSource.transaction.mockImplementation(
      // overload: callback first
      async (...args: unknown[]) => {
        const cb = (typeof args[0] === 'function' ? args[0] : args[1]) as (
          m: EntityManager,
        ) => Promise<unknown>;
        return cb(mockManager);
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MyinfoService,
        { provide: getRepositoryToken(UserProfile), useValue: profileRepo },
        { provide: getRepositoryToken(LanguageCert), useValue: langCertRepo },
        { provide: getRepositoryToken(Cert), useValue: certRepo },
        { provide: getRepositoryToken(Award), useValue: awardRepo },
        { provide: getRepositoryToken(Experience), useValue: expRepo },
        { provide: getRepositoryToken(Coverletter), useValue: coverRepo },
        { provide: getRepositoryToken(Document), useValue: documentRepo },
        {
          provide: getRepositoryToken(CoverletterCustom),
          useValue: coverCustomRepo,
        },
        { provide: getRepositoryToken(Education), useValue: educationRepo },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: StorageUsageService, useValue: storageUsage },
        { provide: FilesService, useValue: filesService },
      ],
    }).compile();

    service = module.get<MyinfoService>(MyinfoService);
    // 기본값: count 0으로 한도 미달, save는 입력 그대로 반환, findOne은 null
    for (const repo of [
      certRepo,
      awardRepo,
      langCertRepo,
      documentRepo,
      educationRepo,
      expRepo,
      coverCustomRepo,
    ]) {
      (repo.count as jest.Mock).mockResolvedValue(0);
      (repo.save as jest.Mock).mockImplementation(async (e) => e);
      (repo.create as jest.Mock).mockImplementation((e) => e);
    }
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
        .mockResolvedValueOnce(null) // 최초 조회
        .mockResolvedValue(fresh); // save 후 getProfile 재조회
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

      expect(profileRepo.findOne).toHaveBeenCalledWith({
        where: { user_id: USER_ID },
      });
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
      const cert = {
        id: 'lc-1',
        user_id: USER_ID,
        cert_type: 'TOEIC',
      } as LanguageCert;
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

      expect(langCertRepo.delete).toHaveBeenCalledWith({
        id: 'lc-1',
        user_id: 'other-user',
      });
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
      expect(awardRepo.delete).toHaveBeenCalledWith({
        id: 'award-1',
        user_id: USER_ID,
      });
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

      expect(educationRepo.create).toHaveBeenCalledWith({
        ...dto,
        user_id: USER_ID,
      });
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
      const updated = {
        id: 'edu-1',
        school_name: '서울대',
        user_id: USER_ID,
      } as Education;
      educationRepo.findOne.mockResolvedValue(updated);
      const result = await service.updateEducation(USER_ID, 'edu-1', {});
      expect(educationRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'edu-1', user_id: USER_ID },
      });
      expect(result).toEqual(updated);
    });

    it('deleteEducation → id + user_id 조건으로 delete (IDOR 방어)', async () => {
      await service.deleteEducation(USER_ID, 'edu-1');
      expect(educationRepo.delete).toHaveBeenCalledWith({
        id: 'edu-1',
        user_id: USER_ID,
      });
    });

    it('타인 학력 update 시도 → user_id 조건으로 막힘 (where 조건 검증)', async () => {
      await service.updateEducation('attacker-uid', 'edu-1', {
        school_name: 'hack',
      });
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

      const result = await service.updateCoverletter(USER_ID, {
        personality: '성실하고 꼼꼼함',
      });

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
      const item = {
        id: 'cc-1',
        user_id: USER_ID,
        label: '해외 경험',
        order_index: 0,
        content: '',
      };
      coverCustomRepo.create.mockReturnValue(item);
      coverCustomRepo.save.mockResolvedValue(item);

      await service.createCustomItem(USER_ID, '해외 경험', 0);

      expect(coverCustomRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: USER_ID,
          label: '해외 경험',
          order_index: 0,
          content: '',
        }),
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
      expect(coverCustomRepo.delete).toHaveBeenCalledWith({
        id: 'cc-1',
        user_id: USER_ID,
      });
    });
  });

  // ── Documents ──────────────────────────────────────────
  // ── 시나리오 기반: 항목 수 한도 + storage cap + R2 cascade ──
  describe('시나리오 기반 보안·운영', () => {
    describe('항목 수 한도 (FB-11)', () => {
      it('자격증 30개 도달한 상태에서 31번째 createCert → BadRequestException', async () => {
        (certRepo.count as jest.Mock).mockResolvedValue(30);
        await expect(
          service.createCert(USER_ID, { name: '신규자격증' }),
        ).rejects.toThrow(/자격증.*최대 30개/);
        expect(certRepo.save).not.toHaveBeenCalled();
      });

      it('어학 10개 도달 → 11번째 차단', async () => {
        (langCertRepo.count as jest.Mock).mockResolvedValue(10);
        await expect(
          service.createLangCert(USER_ID, { cert_type: 'TOEIC' }),
        ).rejects.toThrow(/어학.*최대 10개/);
      });

      it('한도 미달 → 정상 INSERT (29개 → 30번째 등록 가능, E-9)', async () => {
        (certRepo.count as jest.Mock).mockResolvedValue(29);
        const result = await service.createCert(USER_ID, { name: '자격증' });
        expect(certRepo.save).toHaveBeenCalled();
        expect(result).toBeDefined();
      });
    });

    describe('storage cap (FB-6, FB-7)', () => {
      it('createCert with file_size_bytes — assertWithinLimit 호출됨', async () => {
        await service.createCert(USER_ID, {
          name: '자격증',
          file_url: 'r2://new.pdf',
          file_size_bytes: 5 * 1024 * 1024,
        });
        expect(storageUsage.assertWithinLimit).toHaveBeenCalledWith(
          USER_ID,
          5 * 1024 * 1024,
          mockManager,
        );
      });

      it('파일 없는 createCert — storage cap 검증 스킵 (H-7)', async () => {
        await service.createCert(USER_ID, { name: '자격증' });
        expect(storageUsage.assertWithinLimit).not.toHaveBeenCalled();
      });

      it('cap 초과 시 R2 파일 cleanup 후 throw (FI-3)', async () => {
        storageUsage.assertWithinLimit.mockRejectedValueOnce(
          new BadRequestException('저장 공간 부족'),
        );
        await expect(
          service.createCert(USER_ID, {
            name: 'X',
            file_url: 'r2://orphan.pdf',
            file_size_bytes: 5 * 1024 * 1024,
          }),
        ).rejects.toThrow(BadRequestException);
        expect(filesService.deleteFile).toHaveBeenCalledWith('r2://orphan.pdf');
      });
    });

    describe('R2 cascade 삭제', () => {
      it('deleteCert가 R2 파일도 함께 삭제 (H-3)', async () => {
        certRepo.findOne.mockResolvedValue({
          id: 'c-1',
          user_id: USER_ID,
          file_url: 'r2://cert.pdf',
        } as unknown as Cert);

        await service.deleteCert(USER_ID, 'c-1');

        expect(certRepo.delete).toHaveBeenCalledWith({
          id: 'c-1',
          user_id: USER_ID,
        });
        expect(filesService.deleteFile).toHaveBeenCalledWith('r2://cert.pdf');
      });

      it('파일 없는 항목 삭제 시 filesService.deleteFile 미호출', async () => {
        certRepo.findOne.mockResolvedValue({
          id: 'c-1',
          user_id: USER_ID,
          file_url: null,
        } as unknown as Cert);

        await service.deleteCert(USER_ID, 'c-1');

        expect(certRepo.delete).toHaveBeenCalled();
        expect(filesService.deleteFile).not.toHaveBeenCalled();
      });

      it('updateCert 파일 교체 시 이전 R2 파일 삭제 (H-4)', async () => {
        certRepo.findOne.mockResolvedValue({
          id: 'c-1',
          user_id: USER_ID,
          file_url: 'r2://old.pdf',
          file_size_bytes: 1024,
        } as unknown as Cert);

        await service.updateCert(USER_ID, 'c-1', {
          file_url: 'r2://new.pdf',
          file_size_bytes: 2048,
        });

        expect(filesService.deleteFile).toHaveBeenCalledWith('r2://old.pdf');
      });
    });

    // LRR P1T2 M-2: file_url ownership 검증
    describe('file_url ownership 검증 (M-2)', () => {
      it('createCert에 file_url 있으면 filesService.assertOwnFileUrl 호출', async () => {
        await service.createCert(USER_ID, {
          name: '자격증',
          file_url: 'r2://own.pdf',
          file_size_bytes: 1024,
        });
        expect(filesService.assertOwnFileUrl).toHaveBeenCalledWith(
          USER_ID,
          'r2://own.pdf',
        );
      });

      it('createCert에 file_url 없으면 assertOwnFileUrl 미호출 (skip)', async () => {
        await service.createCert(USER_ID, { name: '자격증' });
        expect(filesService.assertOwnFileUrl).not.toHaveBeenCalled();
      });

      it('assertOwnFileUrl이 ForbiddenException throw → createCert 전파 + storage cap 검증 미진입', async () => {
        filesService.assertOwnFileUrl.mockImplementationOnce(() => {
          throw new ForbiddenException(
            '본인이 업로드한 파일만 사용할 수 있습니다.',
          );
        });
        await expect(
          service.createCert(USER_ID, {
            name: '자격증',
            file_url: 'r2://other-user.pdf',
            file_size_bytes: 1024,
          }),
        ).rejects.toThrow(ForbiddenException);
        // 검증 실패 → 트랜잭션 진입 안 함 → assertWithinLimit 미호출
        expect(storageUsage.assertWithinLimit).not.toHaveBeenCalled();
      });

      it('updateCert 새 file_url → assertOwnFileUrl 호출', async () => {
        certRepo.findOne.mockResolvedValue({
          id: 'c-1',
          user_id: USER_ID,
          file_url: 'r2://old.pdf',
          file_size_bytes: 1024,
        } as unknown as Cert);

        await service.updateCert(USER_ID, 'c-1', {
          file_url: 'r2://new.pdf',
          file_size_bytes: 2048,
        });

        expect(filesService.assertOwnFileUrl).toHaveBeenCalledWith(
          USER_ID,
          'r2://new.pdf',
        );
      });

      it('updateCert에서 file_url=null (파일 제거 의도) → assertOwnFileUrl skip', async () => {
        certRepo.findOne.mockResolvedValue({
          id: 'c-1',
          user_id: USER_ID,
          file_url: 'r2://old.pdf',
          file_size_bytes: 1024,
        } as unknown as Cert);

        await service.updateCert(USER_ID, 'c-1', {
          file_url: null,
          file_size_bytes: 0,
        });

        // null은 truthy 아니라 검증 skip
        expect(filesService.assertOwnFileUrl).not.toHaveBeenCalled();
      });
    });
  });

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
      expect(documentRepo.delete).toHaveBeenCalledWith({
        id: 'doc-1',
        user_id: 'other-user',
      });
    });
  });

  // ── LRR P2T2 PR γ — affected 0 → NotFoundException 일관성 (LOW-2) ──────
  describe('affected 0 → NotFoundException (PR γ LOW-2)', () => {
    const { NotFoundException } = jest.requireActual('@nestjs/common');

    it('updateExperience: affected=0 → NotFoundException', async () => {
      expRepo.update.mockResolvedValue({ affected: 0 } as never);
      await expect(
        service.updateExperience(USER_ID, 'no-exist', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('deleteExperience: affected=0 → NotFoundException', async () => {
      expRepo.delete.mockResolvedValue({ affected: 0 } as never);
      await expect(
        service.deleteExperience(USER_ID, 'no-exist'),
      ).rejects.toThrow(NotFoundException);
    });

    it('updateCustomItem: affected=0 → NotFoundException', async () => {
      coverCustomRepo.update.mockResolvedValue({ affected: 0 } as never);
      await expect(
        service.updateCustomItem(USER_ID, 'no-exist', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('deleteCustomItem: affected=0 → NotFoundException', async () => {
      coverCustomRepo.delete.mockResolvedValue({ affected: 0 } as never);
      await expect(
        service.deleteCustomItem(USER_ID, 'no-exist'),
      ).rejects.toThrow(NotFoundException);
    });

    it('updateExperience: affected=1 → 정상 (findOne 결과 반환)', async () => {
      expRepo.update.mockResolvedValue({ affected: 1 } as never);
      expRepo.findOne.mockResolvedValue({ id: 'exp-1' } as never);
      const result = await service.updateExperience(USER_ID, 'exp-1', {});
      expect(result).toMatchObject({ id: 'exp-1' });
    });
  });

  // ── LRR P2T2 PR γ — experience createWithLocks 패턴 통일 (P1T2 L-1) ────
  describe('createExperience — createWithLocks 패턴 (PR γ L-1)', () => {
    it('트랜잭션 + 사용자 row 락 + 항목 한도 검증 흐름 사용', async () => {
      // createWithLocks가 transaction을 호출하는지 확인
      const dataSource = jest.requireActual('typeorm');
      void dataSource;

      const transactionSpy = jest.fn().mockImplementation(async (cb) => {
        const txManager = {
          query: jest.fn().mockResolvedValue([]),
          getRepository: jest.fn().mockReturnValue({
            count: jest.fn().mockResolvedValue(0),
            create: jest.fn((data) => data),
            save: jest.fn(async (data) => data),
          }),
        };
        return cb(txManager);
      });
      (
        service as unknown as { dataSource: { transaction: jest.Mock } }
      ).dataSource = { transaction: transactionSpy };

      await service.createExperience(USER_ID, { title: '인턴' } as never);

      expect(transactionSpy).toHaveBeenCalled();
    });
  });

  // ── F6 PR 1 — AI 컨텍스트 빌더용 PII-safe dump ──
  describe('getSafeDumpForAi (PR 1: ADR-019·027)', () => {
    it('모든 entity 비어있음 → 모든 섹션 빈 배열 (user-profile 자체 조회 0)', async () => {
      coverRepo.findOne.mockResolvedValue(null);
      coverCustomRepo.find.mockResolvedValue([]);
      expRepo.find.mockResolvedValue([]);
      educationRepo.find.mockResolvedValue([]);
      certRepo.find.mockResolvedValue([]);
      langCertRepo.find.mockResolvedValue([]);
      awardRepo.find.mockResolvedValue([]);

      const dump = await service.getSafeDumpForAi(USER_ID);
      expect(dump).toEqual({
        coverletterDrafts: [],
        experiences: [],
        educations: [],
        certs: [],
        awards: [],
      });
      // user-profile (PII) 은 조회 자체 0
      expect(profileRepo.findOne).not.toHaveBeenCalled();
    });

    it('coverletter 6 카테고리 모두 있음 + custom 1개 → 7개 draftItems 반환', async () => {
      coverRepo.findOne.mockResolvedValue({
        user_id: USER_ID,
        personality: '성격',
        background: '배경',
        job_competency: '역량',
        own_strength: '강점',
        collaboration: '협업',
        challenge: '도전',
        updated_at: new Date(),
      });
      coverCustomRepo.find.mockResolvedValue([
        {
          id: 'cc-1',
          user_id: USER_ID,
          label: '맞춤 항목',
          content: '맞춤 답변',
          order_index: 0,
        },
      ]);
      expRepo.find.mockResolvedValue([]);
      educationRepo.find.mockResolvedValue([]);
      certRepo.find.mockResolvedValue([]);
      langCertRepo.find.mockResolvedValue([]);
      awardRepo.find.mockResolvedValue([]);

      const dump = await service.getSafeDumpForAi(USER_ID);
      expect(dump.coverletterDrafts).toHaveLength(7);
      expect(dump.coverletterDrafts[0].question).toBe('성격 장단점');
      expect(dump.coverletterDrafts[6].question).toBe('맞춤 항목');
    });

    it('coverletter 일부 컬럼이 빈 문자열/null → 해당 항목 자동 제외 (trim 검증)', async () => {
      coverRepo.findOne.mockResolvedValue({
        user_id: USER_ID,
        personality: '   ', // 공백만
        background: '실제 내용',
        job_competency: '',
        own_strength: null as unknown as string,
        collaboration: null as unknown as string,
        challenge: null as unknown as string,
        updated_at: new Date(),
      });
      coverCustomRepo.find.mockResolvedValue([]);
      expRepo.find.mockResolvedValue([]);
      educationRepo.find.mockResolvedValue([]);
      certRepo.find.mockResolvedValue([]);
      langCertRepo.find.mockResolvedValue([]);
      awardRepo.find.mockResolvedValue([]);

      const dump = await service.getSafeDumpForAi(USER_ID);
      expect(dump.coverletterDrafts).toHaveLength(1);
      expect(dump.coverletterDrafts[0].answer).toBe('실제 내용');
    });

    it('cert + langCert 합쳐 certs 배열 (langCert.cert_type → name 매핑)', async () => {
      coverRepo.findOne.mockResolvedValue(null);
      coverCustomRepo.find.mockResolvedValue([]);
      expRepo.find.mockResolvedValue([]);
      educationRepo.find.mockResolvedValue([]);
      certRepo.find.mockResolvedValue([
        {
          user_id: USER_ID,
          name: 'AWS SAA',
        } as Cert,
      ]);
      langCertRepo.find.mockResolvedValue([
        {
          user_id: USER_ID,
          cert_type: 'TOEIC',
          score_grade: '900',
        } as LanguageCert,
      ]);
      awardRepo.find.mockResolvedValue([]);

      const dump = await service.getSafeDumpForAi(USER_ID);
      expect(dump.certs).toEqual([
        { name: 'AWS SAA', score: null },
        { name: 'TOEIC', score: '900' },
      ]);
    });

    it('award.award_name 우선, 없으면 contest_name fallback', async () => {
      coverRepo.findOne.mockResolvedValue(null);
      coverCustomRepo.find.mockResolvedValue([]);
      expRepo.find.mockResolvedValue([]);
      educationRepo.find.mockResolvedValue([]);
      certRepo.find.mockResolvedValue([]);
      langCertRepo.find.mockResolvedValue([]);
      awardRepo.find.mockResolvedValue([
        {
          user_id: USER_ID,
          award_name: '대상',
          contest_name: '해커톤',
          org: 'NIPA',
        } as Award,
        {
          user_id: USER_ID,
          award_name: null,
          contest_name: '경진대회',
          org: null,
        } as unknown as Award,
      ]);

      const dump = await service.getSafeDumpForAi(USER_ID);
      expect(dump.awards).toEqual([
        { name: '대상', org: 'NIPA' },
        { name: '경진대회', org: null },
      ]);
    });
  });
});
