import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AnnouncementType = 'banner' | 'modal';

/**
 * 공지의 「종류」 — `type`(배너/모달 = **어떻게 보이나**)과 축이 다르다 (**무슨 소식인가**).
 *
 * 새 기능 소개가 점검 공지와 같은 회색 카드로 나가면 읽히지 않는다. 프론트가 이 값으로
 * 아이콘·색을 가른다. 값을 늘릴 땐 프론트 매핑을 같이 늘려야 한다 (모르는 값은 notice 취급).
 */
export const ANNOUNCEMENT_KINDS = [
  'feature',
  'improvement',
  'fix',
  'notice',
] as const;

export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

/**
 * CTA 경로 허용 형식 — 슬래시 하나로 시작 + 공백 없음.
 *
 * 🔴 `//evil.com` 을 막는 게 이 정규식의 핵심이다. 브라우저는 `//host` 를 프로토콜 상대
 * URL(= 외부 이동)로 읽는데 「/로 시작」 검사만 하면 통과한다. 그래서 첫 글자 뒤에
 * `(?!\/)` 를 둔다. `http:`·`javascript:` 는 첫 글자에서 이미 걸린다.
 *
 * ⚠️ JS 의 `$` 는 끝의 개행 하나 앞에서도 매칭된다 → DTO 에서 **trim 을 먼저** 걸어
 * `/foo\n` 같은 값이 들어오지 못하게 한다.
 */
export const CTA_PATH_PATTERN = /^\/(?!\/)[^\s]*$/;

@Entity('announcements')
export class Announcement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', length: 10 })
  type: AnnouncementType;

  @Column({ type: 'varchar', length: 16, default: 'notice' })
  kind: AnnouncementKind;

  @Column({ default: false })
  active: boolean;

  /**
   * 「지금 해보기」 버튼 — 라벨과 경로는 **항상 짝**이다 (한쪽만 있으면 400).
   * 경로는 앱 내부 경로만 받는다 (`/board?add=posting`). 외부 URL·`//host` 는 거른다.
   */
  @Column({ type: 'varchar', length: 30, nullable: true })
  cta_label: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  cta_path: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  starts_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  ends_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
