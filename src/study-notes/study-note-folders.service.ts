import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CreateStudyNoteFolderDto,
  UpdateStudyNoteFolderDto,
} from './dto/study-note-folder.dto';
import { StudyNoteFolder } from './study-note-folder.entity';

/**
 * 사용자당 폴더 상한. 시트 10장 캡과 같은 **abuse 방지** 성격이고,
 * 숫자를 문구에 실어 400 으로 되돌린다 (무엇을 줄여야 하는지 알게).
 */
export const MAX_FOLDERS_PER_USER = 50;

/** 폴더 이름 — **trim 후** 판정 */
export const FOLDER_NAME_MAX_CHARS = 50;

/**
 * 이름 정규화 + 길이 판정의 **단일 지점** (시트 이름과 같은 규약).
 * trim 을 먼저 하는 이유: 붙여넣은 이름이 공백을 달고 온다 — raw 길이로 자르면
 * 멀쩡한 50자가 막히고, raw 로 통과시키면 공백만 있는 폴더가 생긴다.
 */
function normalizeFolderName(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0 || trimmed.length > FOLDER_NAME_MAX_CHARS) {
    throw new BadRequestException(
      `폴더 이름은 공백을 뺀 1~${FOLDER_NAME_MAX_CHARS}자로 입력해 주세요.`,
    );
  }
  return trimmed;
}

/**
 * 공부 노트 **폴더** CRUD.
 *
 * ## 1단 제약은 왜 서비스에 있나
 *
 * "부모의 부모는 없다" 는 **다른 행을 봐야 판정되는 제약**이라 CHECK 로 못 쓴다.
 * 1차 UI 는 중첩 폴더를 만들 수단 자체를 주지 않지만, 컬럼이 열려 있는 이상
 * 서버가 막지 않으면 API 로 2단이 만들어지고 그때부터 화면이 트리를 못 그린다.
 *
 * ## 캡에 잠금을 안 거는 이유
 *
 * 50개 상한은 **불변식이 아니라 abuse 캡**이다. 동시 요청 둘이 51번째를 통과시켜도
 * 사용자가 볼 피해가 없다 (시트의 「마지막 1장」·「승격 멱등」은 깨지면 화면이
 * 망가져서 스텝 행을 잠갔다). 잠금 비용을 안 낸다.
 */
@Injectable()
export class StudyNoteFoldersService {
  constructor(
    @InjectRepository(StudyNoteFolder)
    private readonly folderRepo: Repository<StudyNoteFolder>,
  ) {}

  /** 허브 표시 순서 = 이름 가나다순 (1차는 정렬 UI 가 없다 — sort_order 는 2차 예약) */
  list(userId: string): Promise<StudyNoteFolder[]> {
    return this.folderRepo.find({
      where: { userId },
      order: { name: 'ASC', createdAt: 'ASC' },
    });
  }

  async create(
    userId: string,
    dto: CreateStudyNoteFolderDto,
  ): Promise<StudyNoteFolder> {
    const name = normalizeFolderName(dto.name);

    const count = await this.folderRepo.count({ where: { userId } });
    if (count >= MAX_FOLDERS_PER_USER) {
      throw new BadRequestException(
        `폴더는 ${MAX_FOLDERS_PER_USER}개까지 만들 수 있어요 (현재 ${count}개).`,
      );
    }

    const parentId = await this.resolveParentId(userId, dto.parentId ?? null);

    return this.folderRepo.save(
      this.folderRepo.create({ userId, name, parentId, sortOrder: 0 }),
    );
  }

  async update(
    userId: string,
    folderId: string,
    dto: UpdateStudyNoteFolderDto,
  ): Promise<StudyNoteFolder> {
    const folder = await this.folderRepo.findOne({
      where: { id: folderId, userId },
    });
    if (!folder) throw new NotFoundException('폴더를 찾을 수 없습니다.');

    if (dto.name !== undefined) folder.name = normalizeFolderName(dto.name);

    if (dto.parentId !== undefined) {
      if (dto.parentId === folderId) {
        throw new BadRequestException('폴더를 자기 자신 안에 넣을 수 없어요.');
      }
      // 자식이 있는 폴더를 하위로 내리면 그 순간 3단이 된다 — 부모 쪽만 봐서는 못 잡는다
      if (dto.parentId !== null) {
        const childCount = await this.folderRepo.count({
          where: { userId, parentId: folderId },
        });
        if (childCount > 0) {
          throw new BadRequestException(
            '폴더는 1단까지만 만들 수 있어요. 하위 폴더가 있는 폴더는 옮길 수 없어요.',
          );
        }
      }
      folder.parentId = await this.resolveParentId(userId, dto.parentId);
    }

    return this.folderRepo.save(folder);
  }

  /**
   * 폴더 삭제 — **소속 노트는 안 지운다.** `study_notes.folder_id` 가 `SET NULL` 이라
   * 노트는 「미분류」로 남고, 하위 폴더가 있었다면 최상위로 올라온다 (CEO 결정 4).
   */
  async remove(userId: string, folderId: string): Promise<void> {
    const folder = await this.folderRepo.findOne({
      where: { id: folderId, userId },
    });
    if (!folder) throw new NotFoundException('폴더를 찾을 수 없습니다.');

    await this.folderRepo.remove(folder);
  }

  /**
   * 부모 지정 검증 — 통과하면 그대로 돌려준다.
   *
   * 남의 폴더 id 와 없는 id 를 **같은 문구**로 되돌린다 (존재 여부를 알려 주지 않는다).
   */
  private async resolveParentId(
    userId: string,
    parentId: string | null,
  ): Promise<string | null> {
    if (parentId === null) return null;

    const parent = await this.folderRepo.findOne({
      where: { id: parentId, userId },
    });
    if (!parent) {
      throw new BadRequestException('상위 폴더를 찾을 수 없어요.');
    }
    if (parent.parentId !== null) {
      throw new BadRequestException('폴더는 1단까지만 만들 수 있어요.');
    }
    return parentId;
  }
}
