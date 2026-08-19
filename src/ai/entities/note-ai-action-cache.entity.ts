import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/user.entity';

/** 캐시 유효 기간 (시간). 이 창 안의 동일 입력은 LLM 미호출·무차감으로 돌려준다 */
export const NOTE_AI_CACHE_TTL_HOURS = 24;

/** audit `resource_type` 과 같은 값을 쓴다 — 캐시 행과 llm_call_logs 행이 같은 이름으로 붙는다 */
export type NoteAiResourceType = 'study_note' | 'application_step';

/**
 * 노트 AI 패널의 **입력 해시 캐시** (2026-08-19).
 *
 * ## 왜 있나 — 새로고침 방어
 *
 * 패널 대화는 서버에 저장하지 않는다(D6). 그래서 새로고침 한 번이 곧 요청 재발이고,
 * 그대로 두면 같은 결과에 코인이 두 번 나간다. 같은 입력(액션+선택+지시+히스토리)이
 * 24시간 안에 다시 오면 **LLM 을 부르지 않고 저장된 마크다운을 돌려준다**.
 *
 * 🔴 멀티턴이라 이 캐시의 역할은 제한적이다 — 히스토리가 한 턴만 달라져도 hash 가
 * 바뀌어 miss 다. 주 방어선은 프론트의 beforeunload 경고이고, 여기는 "같은 걸 한 번 더
 * 눌렀을 때" 만 잡는다.
 *
 * ## 설계
 *
 * | 결정 | 이유 |
 * |---|---|
 * | `user_id` 가 조회 키의 일부 | 남의 결과가 내 화면에 뜨면 안 된다. hash 는 본문에서 나오므로 같은 문장을 정리하면 다른 사용자와 충돌할 수 있다 |
 * | UNIQUE 없음 | 동시 요청 둘이 같은 hash 를 쓰면 행이 둘 생기지만, 읽기가 `created_at DESC` 1건이라 무해하다. UNIQUE 를 걸면 저장 실패를 삼켜야 할 경로만 늘어난다 |
 * | `resource_type`/`resource_id` 는 조회 키가 **아니다** | 같은 선택을 복사해 다른 노트에서 눌러도 결과는 같다. 두 컬럼은 관측·정리용이다 |
 * | cron 없는 lazy 삭제 | 조회할 때 만료 행을 지운다. 이 테이블은 사용자당 몇 줄 규모라 별도 스케줄러가 과하다 |
 */
@Entity('note_ai_action_cache')
@Index('idx_naac_user_hash', ['userId', 'inputHash'])
export class NoteAiActionCache {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'resource_type', type: 'varchar', length: 20 })
  resourceType: NoteAiResourceType;

  @Column({ name: 'resource_id', type: 'uuid' })
  resourceId: string;

  /** SHA256(action + selectionMd + instruction + history) — 16진 64자 */
  @Column({ name: 'input_hash', type: 'varchar', length: 64 })
  inputHash: string;

  /** 결과 마크다운 원문 (프론트가 md 파서로 렌더·삽입) */
  @Column({ name: 'result_md', type: 'text' })
  resultMd: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
