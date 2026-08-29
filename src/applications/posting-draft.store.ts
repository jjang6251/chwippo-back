import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.provider';
import { normalizeStoredDraft, type CardDraft } from './job-posting-card.rules';

/** 보완 질문 대기 중인 초안 (새로고침 복원용) */
export interface PendingDraft {
  hash: string;
  needs: 'company' | 'job';
  draft: CardDraft;
  /** epoch ms — 10분 만료 판정 */
  savedAt: number;
}

/** 초안 보관 10분 — 회사명·직무를 고르는 데 그보다 오래 걸리면 다시 붙여넣는 게 낫다 */
export const DRAFT_TTL_MS = 10 * 60 * 1000;
/** 같은 원문 재요청 차단 창 — 새로고침·더블탭·뒤로가기가 카드를 2장 만들지 않게 */
export const DEDUP_TTL_MS = 10 * 60 * 1000;
/** 진행 중 슬롯 stale TTL — finally 누락·크래시 시 자동 회수 (LlmService in-flight 와 같은 값) */
export const SLOT_TTL_MS = 2 * 60 * 1000;
/** 사용자당 동시 진행 3장 (프론트 「생성 중 카드 ≤3」과 같은 수) */
export const MAX_PENDING_SLOTS = 3;

/**
 * 공고 초안·중복 방지·동시 진행 슬롯 보관소.
 *
 * ## 🔴 초안을 클라이언트에 돌려주지 않는 이유
 *
 * 보완 질문(회사명·직무) 뒤 카드를 만들 때 **초안 본문을 클라이언트가 되돌려 보내면**,
 * 그 사이에 무엇이든 끼워 넣을 수 있다 — 파싱하지도 않은 회사·스텝·요건을 서버가
 * 그대로 저장하게 된다. LLM 을 거치지 않은 값이 「AI 가 채운 칸」으로 관측에도 섞인다.
 * 그래서 응답에는 **해시만** 싣고, 본문은 서버가 들고 있는다.
 *
 * ## Redis 가 없으면 — 프로세스 메모리로 폴백한다 (클라이언트가 아니라)
 *
 * `LlmService` in-flight lock 과 **같은 패턴**이다. REDIS_URL 미설정(로컬 dev·CI)이나
 * Redis 런타임 오류 시 in-memory Map 으로 내려간다. 단일 레플리카 전제라 동작은 같고,
 * 위의 조작 구멍이 폴백 경로에서만 열리는 일이 없다.
 *
 * ⚠️ 멀티 레플리카 + Redis 장애가 겹치면 다른 레플리카가 초안을 못 찾아 404 가 난다.
 * 사용자는 「다시 시도」로 복구되고(원문은 프론트가 들고 있다), 그 대가로 조작 경로를 막는다.
 *
 * ## 원문(rawText)은 여기에도 없다
 *
 * 보관하는 것은 **파싱 결과**(`CardDraft`)와 원문의 sha256 뿐이다.
 */
@Injectable()
export class PostingDraftStore {
  private readonly logger = new Logger(PostingDraftStore.name);

  /** Redis 폴백 — userId → (hash → PendingDraft) */
  private readonly memDrafts = new Map<string, Map<string, PendingDraft>>();
  /** Redis 폴백 — `${userId}:${textHash}` → { appId, at } */
  private readonly memCards = new Map<string, { appId: string; at: number }>();
  /** Redis 폴백 — `${userId}:${slot}` → 획득 시각 */
  private readonly memSlots = new Map<string, number>();

  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis | null = null,
  ) {}

  // ── 초안 ──────────────────────────────────────────────────────────────

  private draftKey(userId: string): string {
    return `posting:draft:${userId}`;
  }

  async saveDraft(
    userId: string,
    hash: string,
    needs: 'company' | 'job',
    draft: CardDraft,
    now: number = Date.now(),
  ): Promise<void> {
    const entry: PendingDraft = { hash, needs, draft, savedAt: now };
    if (this.redis) {
      try {
        await this.redis.hset(
          this.draftKey(userId),
          hash,
          JSON.stringify(entry),
        );
        await this.redis.pexpire(this.draftKey(userId), DRAFT_TTL_MS);
        return;
      } catch (err) {
        this.logger.warn(
          `초안 저장 Redis 오류 — 메모리 폴백: ${(err as Error).message}`,
        );
      }
    }
    const per = this.memDrafts.get(userId) ?? new Map<string, PendingDraft>();
    per.set(hash, entry);
    this.memDrafts.set(userId, per);
  }

  async getDraft(
    userId: string,
    hash: string,
    now: number = Date.now(),
  ): Promise<PendingDraft | null> {
    const all = await this.listPending(userId, now);
    return all.find((d) => d.hash === hash) ?? null;
  }

  /** 보완 대기 초안 목록 (만료분은 걸러서 반환 — 새로고침 후 「생성 중 카드」 복원용) */
  async listPending(
    userId: string,
    now: number = Date.now(),
  ): Promise<PendingDraft[]> {
    const fresh = (e: PendingDraft) => now - e.savedAt < DRAFT_TTL_MS;
    if (this.redis) {
      try {
        const raw = await this.redis.hgetall(this.draftKey(userId));
        const out: PendingDraft[] = [];
        for (const v of Object.values(raw ?? {})) {
          const parsed = this.parseDraft(v);
          if (parsed && fresh(parsed)) out.push(parsed);
        }
        return out.sort((a, b) => a.savedAt - b.savedAt);
      } catch (err) {
        this.logger.warn(
          `초안 조회 Redis 오류 — 메모리 폴백: ${(err as Error).message}`,
        );
      }
    }
    const per = this.memDrafts.get(userId);
    if (!per) return [];
    for (const [h, e] of per) if (!fresh(e)) per.delete(h);
    return [...per.values()].sort((a, b) => a.savedAt - b.savedAt);
  }

  async deleteDraft(userId: string, hash: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.hdel(this.draftKey(userId), hash);
        return;
      } catch (err) {
        this.logger.warn(`초안 삭제 Redis 오류: ${(err as Error).message}`);
      }
    }
    this.memDrafts.get(userId)?.delete(hash);
  }

  /** 신뢰 경계 밖(Redis 문자열) → 타입. `as` 없이 최소 형태만 확인한다 */
  private parseDraft(raw: string): PendingDraft | null {
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v !== 'object' || v === null) return null;
      const o: Record<string, unknown> = { ...v };
      if (typeof o.hash !== 'string') return null;
      if (o.needs !== 'company' && o.needs !== 'job') return null;
      if (typeof o.savedAt !== 'number') return null;
      const draft = normalizeStoredDraft(o.draft);
      if (!draft) return null;
      return { hash: o.hash, needs: o.needs, savedAt: o.savedAt, draft };
    } catch {
      return null;
    }
  }

  // ── 같은 원문 중복 방지 ────────────────────────────────────────────────

  private cardKey(userId: string, textHash: string): string {
    return `posting:card:${userId}:${textHash}`;
  }

  /**
   * 같은 원문으로 방금 만든 카드 id.
   *
   * 🔴 **클라이언트 해시 차단만으로는 안 된다** — 새로고침 한 번에 그 상태가 사라진다.
   * 「만들기」 누르고 새로고침, 다시 누르면 같은 카드가 두 장 생기는 경로가 그것이다.
   */
  async recallCard(
    userId: string,
    textHash: string,
    now: number = Date.now(),
  ): Promise<string | null> {
    if (this.redis) {
      try {
        return await this.redis.get(this.cardKey(userId, textHash));
      } catch (err) {
        this.logger.warn(
          `중복 조회 Redis 오류 — 메모리 폴백: ${(err as Error).message}`,
        );
      }
    }
    const hit = this.memCards.get(`${userId}:${textHash}`);
    if (!hit) return null;
    if (now - hit.at >= DEDUP_TTL_MS) {
      this.memCards.delete(`${userId}:${textHash}`);
      return null;
    }
    return hit.appId;
  }

  async rememberCard(
    userId: string,
    textHash: string,
    appId: string,
    now: number = Date.now(),
  ): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(
          this.cardKey(userId, textHash),
          appId,
          'PX',
          DEDUP_TTL_MS,
        );
        return;
      } catch (err) {
        this.logger.warn(
          `중복 기록 Redis 오류 — 메모리 폴백: ${(err as Error).message}`,
        );
      }
    }
    this.memCards.set(`${userId}:${textHash}`, { appId, at: now });
  }

  async forgetCard(userId: string, textHash: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(this.cardKey(userId, textHash));
        return;
      } catch {
        // TTL 로 자동 만료된다 — 실패해도 넘어간다
      }
    }
    this.memCards.delete(`${userId}:${textHash}`);
  }

  // ── 동시 진행 슬롯 ────────────────────────────────────────────────────

  private slotKey(userId: string, slot: number): string {
    return `posting:slot:${userId}:${slot}`;
  }

  /**
   * 진행 중 슬롯 획득 — `LlmService` in-flight lock 과 같은 `SET NX PX` 패턴.
   * 반환값은 슬롯 번호(해제에 필요). 3개가 다 차 있으면 null.
   */
  async acquireSlot(
    userId: string,
    now: number = Date.now(),
  ): Promise<number | null> {
    for (let i = 0; i < MAX_PENDING_SLOTS; i++) {
      if (this.redis) {
        try {
          const res = await this.redis.set(
            this.slotKey(userId, i),
            String(now),
            'PX',
            SLOT_TTL_MS,
            'NX',
          );
          if (res === 'OK') return i;
          continue;
        } catch (err) {
          this.logger.warn(
            `슬롯 획득 Redis 오류 — 메모리 폴백: ${(err as Error).message}`,
          );
          // fall through → Map 경로
        }
      }
      const k = `${userId}:${i}`;
      const at = this.memSlots.get(k);
      if (at === undefined || now - at >= SLOT_TTL_MS) {
        this.memSlots.set(k, now);
        return i;
      }
    }
    return null;
  }

  async releaseSlot(userId: string, slot: number): Promise<void> {
    this.memSlots.delete(`${userId}:${slot}`);
    if (this.redis) {
      try {
        await this.redis.del(this.slotKey(userId, slot));
      } catch {
        // PX TTL(2분)이 회수한다
      }
    }
  }
}
