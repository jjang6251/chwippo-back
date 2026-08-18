import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mock } from 'jest-mock-extended';
import { DeepPartial, Repository } from 'typeorm';
import { StudyNoteFolder } from './study-note-folder.entity';
import {
  FOLDER_NAME_MAX_CHARS,
  MAX_FOLDERS_PER_USER,
  StudyNoteFoldersService,
} from './study-note-folders.service';

/**
 * 공부 노트 **폴더** 서비스 spec.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 시나리오를 **먼저 나열하고** 코드를 확인했다. 정상 1축, 나머지는 전부 깨뜨리는 축이다.
 *
 * ## list
 *  L1  내 폴더만 · 이름 가나다순
 *
 * ## create
 *  C1  정상 — trim 저장 · sort_order 0 · parent null
 *  C2  이름 0자 → 400 · save 미호출
 *  C3  이름 공백만 → 400
 *  C4  이름 1자 경계 → OK
 *  C5  이름 50자 경계 → OK
 *  C6  이름 51자 → 400 · **count 조회도 안 한다** (형식 검증이 먼저)
 *  C7  앞뒤 공백 붙은 52자 → trim 후 50 → OK
 *  C8  캡 경계 49개 → OK
 *  C9  🔴 캡 경계 50개 → 400 · 문구에 숫자 50·현재 개수 · save 미호출
 *  C10 parent 지정 (부모가 최상위) → OK
 *  C11 🔴 parent 가 이미 자식 폴더 → 400 (1단 제약)
 *  C12 없는 parent → 400
 *  C13 🔴 **남의 parent** → 400 · 없는 id 와 **같은 문구** (존재 여부 누출 금지)
 *
 * ## update
 *  U1  이름 변경 (+trim)
 *  U2  parent = null 로 최상위 승격
 *  U3  미전달 필드 불변
 *  U4  이름 51자 → 400 · save 미호출
 *  U5  없는 폴더 → 404
 *  U6  🔴 남의 폴더 → 404 (조회 자체가 user_id 로 잠긴다)
 *  U7  🔴 자기 자신을 parent 로 → 400
 *  U8  🔴 자식이 있는 폴더에 parent 지정 → 400 (그 순간 3단이 된다)
 *  U9  parent 가 자식 폴더 → 400
 *
 * ## remove
 *  D1  정상 삭제
 *  D2  없는 폴더 → 404
 *  D3  🔴 남의 폴더 → 404 · remove 미호출
 *  D4  🔴 삭제는 폴더 행만 지운다 — 노트 정리는 **DB FK(SET NULL)** 몫이라
 *      서비스가 노트를 만지지 않는다 (실측은 e2e)
 * ────────────────────────────────────────────────────────────────────────
 */
describe('StudyNoteFoldersService', () => {
  let service: StudyNoteFoldersService;
  let folderRepo: jest.Mocked<Repository<StudyNoteFolder>>;

  const USER_ID = 'user-1';
  const FOLDER_ID = 'folder-1';
  const PARENT_ID = 'folder-parent';

  const makeFolder = (o: Partial<StudyNoteFolder> = {}): StudyNoteFolder =>
    ({
      id: FOLDER_ID,
      userId: USER_ID,
      name: 'CS',
      sortOrder: 0,
      parentId: null,
      createdAt: new Date('2026-08-18T00:00:00Z'),
      updatedAt: new Date('2026-08-18T00:00:00Z'),
      ...o,
    }) as StudyNoteFolder;

  beforeEach(async () => {
    folderRepo = mock<Repository<StudyNoteFolder>>();
    folderRepo.create.mockImplementation(
      (o?: DeepPartial<StudyNoteFolder>) => ({ ...o }) as StudyNoteFolder,
    );
    folderRepo.save.mockImplementation((o) =>
      Promise.resolve(o as StudyNoteFolder),
    );
    folderRepo.count.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudyNoteFoldersService,
        { provide: getRepositoryToken(StudyNoteFolder), useValue: folderRepo },
      ],
    }).compile();

    service = module.get(StudyNoteFoldersService);
  });

  // ── list ──

  it('L1) 내 폴더만 · 이름 가나다순', async () => {
    const rows = [makeFolder()];
    folderRepo.find.mockResolvedValue(rows);

    await expect(service.list(USER_ID)).resolves.toBe(rows);
    expect(folderRepo.find).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      order: { name: 'ASC', createdAt: 'ASC' },
    });
  });

  // ── create ──

  describe('create', () => {
    it('C1) 정상 — trim 저장 · sort_order 0 · parent null', async () => {
      const saved = await service.create(USER_ID, { name: '  CS 정리  ' });

      expect(saved.name).toBe('CS 정리');
      expect(saved.userId).toBe(USER_ID);
      expect(saved.sortOrder).toBe(0);
      expect(saved.parentId).toBeNull();
    });

    it('C2) 이름 0자 → 400 · save 미호출', async () => {
      await expect(service.create(USER_ID, { name: '' })).rejects.toThrow(
        new BadRequestException(
          `폴더 이름은 공백을 뺀 1~${FOLDER_NAME_MAX_CHARS}자로 입력해 주세요.`,
        ),
      );
      expect(folderRepo.save).not.toHaveBeenCalled();
    });

    it('C3) 이름 공백만 → 400', async () => {
      await expect(service.create(USER_ID, { name: '   ' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('C4) 이름 1자 경계 → OK', async () => {
      await expect(
        service.create(USER_ID, { name: 'A' }),
      ).resolves.toMatchObject({ name: 'A' });
    });

    it(`C5) 이름 ${FOLDER_NAME_MAX_CHARS}자 경계 → OK`, async () => {
      const name = 'ㄱ'.repeat(FOLDER_NAME_MAX_CHARS);

      await expect(service.create(USER_ID, { name })).resolves.toMatchObject({
        name,
      });
    });

    it(`C6) 이름 ${FOLDER_NAME_MAX_CHARS + 1}자 → 400 · count 조회도 안 한다`, async () => {
      await expect(
        service.create(USER_ID, {
          name: 'ㄱ'.repeat(FOLDER_NAME_MAX_CHARS + 1),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(folderRepo.count).not.toHaveBeenCalled();
    });

    it('C7) 앞뒤 공백 붙은 52자 → trim 후 50 → OK', async () => {
      const core = 'ㄱ'.repeat(FOLDER_NAME_MAX_CHARS);

      await expect(
        service.create(USER_ID, { name: ` ${core} ` }),
      ).resolves.toMatchObject({ name: core });
    });

    it(`C8) 캡 경계 ${MAX_FOLDERS_PER_USER - 1}개 → OK`, async () => {
      folderRepo.count.mockResolvedValue(MAX_FOLDERS_PER_USER - 1);

      await expect(
        service.create(USER_ID, { name: '마지막' }),
      ).resolves.toMatchObject({ name: '마지막' });
    });

    it(`C9) 🔴 캡 경계 ${MAX_FOLDERS_PER_USER}개 → 400 · 문구에 숫자 · save 미호출`, async () => {
      folderRepo.count.mockResolvedValue(MAX_FOLDERS_PER_USER);

      await expect(service.create(USER_ID, { name: '넘침' })).rejects.toThrow(
        new BadRequestException(
          `폴더는 ${MAX_FOLDERS_PER_USER}개까지 만들 수 있어요 (현재 ${MAX_FOLDERS_PER_USER}개).`,
        ),
      );
      expect(folderRepo.save).not.toHaveBeenCalled();
    });

    it('C10) parent 지정 (부모가 최상위) → OK', async () => {
      folderRepo.findOne.mockResolvedValue(
        makeFolder({ id: PARENT_ID, parentId: null }),
      );

      const saved = await service.create(USER_ID, {
        name: '하위',
        parentId: PARENT_ID,
      });

      expect(saved.parentId).toBe(PARENT_ID);
      // 부모 조회도 user_id 로 잠긴다
      expect(folderRepo.findOne).toHaveBeenCalledWith({
        where: { id: PARENT_ID, userId: USER_ID },
      });
    });

    it('C11) 🔴 parent 가 이미 자식 폴더 → 400 (1단 제약)', async () => {
      folderRepo.findOne.mockResolvedValue(
        makeFolder({ id: PARENT_ID, parentId: 'grandparent' }),
      );

      await expect(
        service.create(USER_ID, { name: '3단', parentId: PARENT_ID }),
      ).rejects.toThrow(
        new BadRequestException('폴더는 1단까지만 만들 수 있어요.'),
      );
      expect(folderRepo.save).not.toHaveBeenCalled();
    });

    it('C12·C13) 🔴 없는 parent 와 남의 parent 는 같은 문구의 400', async () => {
      // 남의 폴더든 없는 폴더든 findOne 은 똑같이 null 을 돌려준다 (user_id 가 조건에 있다)
      folderRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(USER_ID, { name: '하위', parentId: PARENT_ID }),
      ).rejects.toThrow(new BadRequestException('상위 폴더를 찾을 수 없어요.'));
    });
  });

  // ── update ──

  describe('update', () => {
    beforeEach(() => {
      folderRepo.findOne.mockResolvedValue(makeFolder());
    });

    it('U1) 이름 변경 (+trim)', async () => {
      const saved = await service.update(USER_ID, FOLDER_ID, {
        name: '  알고리즘  ',
      });

      expect(saved.name).toBe('알고리즘');
    });

    it('U2) parent = null 로 최상위 승격', async () => {
      folderRepo.findOne.mockResolvedValue(
        makeFolder({ parentId: 'old-parent' }),
      );
      folderRepo.count.mockResolvedValue(0);

      const saved = await service.update(USER_ID, FOLDER_ID, {
        parentId: null,
      });

      expect(saved.parentId).toBeNull();
    });

    it('U3) 미전달 필드 불변', async () => {
      const saved = await service.update(USER_ID, FOLDER_ID, {
        name: '이름만',
      });

      expect(saved.parentId).toBeNull();
      expect(saved.sortOrder).toBe(0);
    });

    it(`U4) 이름 ${FOLDER_NAME_MAX_CHARS + 1}자 → 400 · save 미호출`, async () => {
      await expect(
        service.update(USER_ID, FOLDER_ID, {
          name: 'ㄱ'.repeat(FOLDER_NAME_MAX_CHARS + 1),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(folderRepo.save).not.toHaveBeenCalled();
    });

    it('U5·U6) 🔴 없는 폴더 · 남의 폴더 → 404 (조회가 user_id 로 잠긴다)', async () => {
      folderRepo.findOne.mockResolvedValue(null);

      await expect(
        service.update(USER_ID, FOLDER_ID, { name: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(folderRepo.findOne).toHaveBeenCalledWith({
        where: { id: FOLDER_ID, userId: USER_ID },
      });
      expect(folderRepo.save).not.toHaveBeenCalled();
    });

    it('U7) 🔴 자기 자신을 parent 로 → 400', async () => {
      await expect(
        service.update(USER_ID, FOLDER_ID, { parentId: FOLDER_ID }),
      ).rejects.toThrow(
        new BadRequestException('폴더를 자기 자신 안에 넣을 수 없어요.'),
      );
      expect(folderRepo.save).not.toHaveBeenCalled();
    });

    it('U8) 🔴 자식이 있는 폴더에 parent 지정 → 400 (그 순간 3단이 된다)', async () => {
      folderRepo.count.mockResolvedValue(2); // 이 폴더 밑에 자식 2개

      await expect(
        service.update(USER_ID, FOLDER_ID, { parentId: PARENT_ID }),
      ).rejects.toThrow(BadRequestException);
      expect(folderRepo.count).toHaveBeenCalledWith({
        where: { userId: USER_ID, parentId: FOLDER_ID },
      });
      expect(folderRepo.save).not.toHaveBeenCalled();
    });

    it('U9) parent 가 자식 폴더 → 400', async () => {
      folderRepo.count.mockResolvedValue(0);
      folderRepo.findOne
        .mockResolvedValueOnce(makeFolder()) // 대상 폴더
        .mockResolvedValueOnce(makeFolder({ id: PARENT_ID, parentId: 'g' })); // 부모가 이미 자식

      await expect(
        service.update(USER_ID, FOLDER_ID, { parentId: PARENT_ID }),
      ).rejects.toThrow(
        new BadRequestException('폴더는 1단까지만 만들 수 있어요.'),
      );
    });
  });

  // ── remove ──

  describe('remove', () => {
    it('D1) 정상 삭제', async () => {
      const folder = makeFolder();
      folderRepo.findOne.mockResolvedValue(folder);

      await service.remove(USER_ID, FOLDER_ID);

      expect(folderRepo.remove).toHaveBeenCalledWith(folder);
    });

    it('D2·D3) 🔴 없는 폴더 · 남의 폴더 → 404 · remove 미호출', async () => {
      folderRepo.findOne.mockResolvedValue(null);

      await expect(service.remove(USER_ID, FOLDER_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(folderRepo.remove).not.toHaveBeenCalled();
    });

    it('D4) 🔴 삭제는 폴더 행만 만진다 — 노트 정리는 DB FK(SET NULL) 몫', async () => {
      folderRepo.findOne.mockResolvedValue(makeFolder());

      await service.remove(USER_ID, FOLDER_ID);

      // 서비스가 노트를 직접 UPDATE 하지 않는다 (했다면 폴더 repo 로는 불가능한 일이고,
      // 노트 repo 를 주입받지도 않았다는 게 이 서비스의 생성자에 드러나 있다)
      expect(folderRepo.update).not.toHaveBeenCalled();
      expect(folderRepo.query).not.toHaveBeenCalled();
    });
  });
});
