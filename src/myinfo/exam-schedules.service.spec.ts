import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { Repository } from 'typeorm';
import { ExamSchedulesService } from './exam-schedules.service';
import { ExamSchedule } from './entities/exam-schedule.entity';
import { Cert } from './entities/cert.entity';
import { LanguageCert } from './entities/language-cert.entity';

describe('ExamSchedulesService', () => {
  let service: ExamSchedulesService;
  let examRepo: jest.Mocked<Repository<ExamSchedule>>;
  let certRepo: jest.Mocked<Repository<Cert>>;
  let langCertRepo: jest.Mocked<Repository<LanguageCert>>;

  const USER_ID = 'user-uuid-1';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExamSchedulesService,
        { provide: getRepositoryToken(ExamSchedule), useValue: mock<Repository<ExamSchedule>>() },
        { provide: getRepositoryToken(Cert), useValue: mock<Repository<Cert>>() },
        { provide: getRepositoryToken(LanguageCert), useValue: mock<Repository<LanguageCert>>() },
      ],
    }).compile();

    service = module.get(ExamSchedulesService);
    examRepo = module.get(getRepositoryToken(ExamSchedule));
    certRepo = module.get(getRepositoryToken(Cert));
    langCertRepo = module.get(getRepositoryToken(LanguageCert));
  });

  afterEach(() => jest.clearAllMocks());

  // ── list ──────────────────────────────────────────────
  describe('list', () => {
    it('userId 필터 + exam_date ASC 정렬', async () => {
      examRepo.find.mockResolvedValue([]);
      await service.list(USER_ID);
      expect(examRepo.find).toHaveBeenCalledWith({
        where: { user_id: USER_ID },
        order: { exam_date: 'ASC' },
      });
    });
  });

  // ── create ────────────────────────────────────────────
  describe('create', () => {
    it('user_id 자동 주입 + dto 필드 매핑 (cert_type 미지정 시 null)', async () => {
      const dto = {
        exam_type: 'cert' as const,
        name: '정보처리기사 필기',
        exam_date: '2026-06-01T09:00:00+09:00',
      };
      const created = { id: 'x1', user_id: USER_ID, ...dto } as any;
      examRepo.create.mockReturnValue(created);
      examRepo.save.mockResolvedValue(created);

      await service.create(USER_ID, dto);

      expect(examRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        user_id: USER_ID,
        exam_type: 'cert',
        cert_type: null,
        name: '정보처리기사 필기',
        location: null,
        memo: null,
      }));
    });

    it('어학(language) 시험 — cert_type 함께 저장', async () => {
      const dto = {
        exam_type: 'language' as const,
        cert_type: 'TOEIC',
        name: 'TOEIC',
        exam_date: '2026-06-15T09:00:00+09:00',
        location: '한양대',
        memo: '준비 필수',
      };
      examRepo.create.mockReturnValue({} as any);
      examRepo.save.mockResolvedValue({} as any);

      await service.create(USER_ID, dto);

      expect(examRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        user_id: USER_ID,
        exam_type: 'language',
        cert_type: 'TOEIC',
        location: '한양대',
        memo: '준비 필수',
      }));
    });
  });

  // ── update ────────────────────────────────────────────
  describe('update', () => {
    it('id+user_id 조건으로 조회 후 저장 (IDOR 방어)', async () => {
      const existing = { id: 'x1', user_id: USER_ID, name: 'TOEIC' } as any;
      examRepo.findOne.mockResolvedValue(existing);
      examRepo.save.mockResolvedValue(existing);

      await service.update(USER_ID, 'x1', { name: 'TOEIC Speaking' });

      expect(examRepo.findOne).toHaveBeenCalledWith({ where: { id: 'x1', user_id: USER_ID } });
      expect(examRepo.save).toHaveBeenCalled();
    });

    it('타인의 시험 일정 update 시도 → NotFoundException', async () => {
      examRepo.findOne.mockResolvedValue(null);
      await expect(service.update('attacker-uid', 'x1', { name: 'hack' }))
        .rejects.toThrow(NotFoundException);
    });

    it('exam_date 갱신 시 Date 객체로 변환', async () => {
      const existing = { id: 'x1', user_id: USER_ID, exam_date: new Date() } as any;
      examRepo.findOne.mockResolvedValue(existing);
      examRepo.save.mockResolvedValue(existing);

      await service.update(USER_ID, 'x1', { exam_date: '2026-07-01T10:00:00+09:00' });

      expect(existing.exam_date).toBeInstanceOf(Date);
    });
  });

  // ── remove ────────────────────────────────────────────
  describe('remove', () => {
    it('id+user_id 조건으로 delete (IDOR 방어)', async () => {
      examRepo.delete.mockResolvedValue({ affected: 1 } as any);
      await service.remove(USER_ID, 'x1');
      expect(examRepo.delete).toHaveBeenCalledWith({ id: 'x1', user_id: USER_ID });
    });

    it('타인 시험 일정 삭제 시도 → affected=0 → NotFoundException', async () => {
      examRepo.delete.mockResolvedValue({ affected: 0 } as any);
      await expect(service.remove('attacker-uid', 'x1'))
        .rejects.toThrow(NotFoundException);
    });
  });

  // ── convertToCert ─────────────────────────────────────
  describe('convertToCert', () => {
    it('language 타입 → myinfo_language_certs로 이관 (cert_type + score_grade) + 원본 삭제', async () => {
      const exam = {
        id: 'x1',
        user_id: USER_ID,
        exam_type: 'language',
        cert_type: 'TOEIC',
        name: 'TOEIC',
        exam_date: new Date('2026-05-15T09:00:00+09:00'),
      } as any;
      examRepo.findOne.mockResolvedValue(exam);
      langCertRepo.create.mockImplementation((dto) => dto as any);
      langCertRepo.save.mockResolvedValue({} as any);
      examRepo.delete.mockResolvedValue({ affected: 1 } as any);

      await service.convertToCert(USER_ID, 'x1', { score_grade: '850' });

      expect(langCertRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        user_id: USER_ID,
        cert_type: 'TOEIC',
        score_grade: '850',
      }));
      expect(langCertRepo.save).toHaveBeenCalled();
      expect(certRepo.create).not.toHaveBeenCalled();
      expect(examRepo.delete).toHaveBeenCalledWith({ id: 'x1', user_id: USER_ID });
    });

    it('cert 타입 → myinfo_certs로 이관 (name) + 원본 삭제', async () => {
      const exam = {
        id: 'x2',
        user_id: USER_ID,
        exam_type: 'cert',
        cert_type: null,
        name: '정보처리기사 필기',
        exam_date: new Date('2026-06-01T09:00:00+09:00'),
      } as any;
      examRepo.findOne.mockResolvedValue(exam);
      certRepo.create.mockImplementation((dto) => dto as any);
      certRepo.save.mockResolvedValue({} as any);
      examRepo.delete.mockResolvedValue({ affected: 1 } as any);

      await service.convertToCert(USER_ID, 'x2', {});

      expect(certRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        user_id: USER_ID,
        name: '정보처리기사 필기',
      }));
      expect(certRepo.save).toHaveBeenCalled();
      expect(langCertRepo.create).not.toHaveBeenCalled();
      expect(examRepo.delete).toHaveBeenCalledWith({ id: 'x2', user_id: USER_ID });
    });

    it('language 타입에서 cert_type이 null이면 name을 cert_type으로 사용', async () => {
      const exam = {
        id: 'x3',
        user_id: USER_ID,
        exam_type: 'language',
        cert_type: null,
        name: '기타 어학 시험',
        exam_date: new Date('2026-06-01T09:00:00+09:00'),
      } as any;
      examRepo.findOne.mockResolvedValue(exam);
      langCertRepo.create.mockImplementation((dto) => dto as any);
      langCertRepo.save.mockResolvedValue({} as any);

      await service.convertToCert(USER_ID, 'x3', { score_grade: 'B' });

      expect(langCertRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        cert_type: '기타 어학 시험',
      }));
    });

    it('타인 시험 일정 이관 시도 → NotFoundException', async () => {
      examRepo.findOne.mockResolvedValue(null);
      await expect(service.convertToCert('attacker-uid', 'x1', { score_grade: '900' }))
        .rejects.toThrow(NotFoundException);
    });

    it('cert 타입에서 score_grade 없어도 정상 이관 (자격증은 점수 선택)', async () => {
      const exam = {
        id: 'x4',
        user_id: USER_ID,
        exam_type: 'cert',
        cert_type: null,
        name: 'SQLD',
        exam_date: new Date('2026-06-01T09:00:00+09:00'),
      } as any;
      examRepo.findOne.mockResolvedValue(exam);
      certRepo.create.mockImplementation((dto) => dto as any);
      certRepo.save.mockResolvedValue({} as any);

      await service.convertToCert(USER_ID, 'x4', {});

      expect(certRepo.save).toHaveBeenCalled();
    });
  });
});
