import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Cloudflare 뒤에서 스로틀 키를 **방문자 실 IP**로 고정하는 가드.
 *
 * 배경 (2026-07-24 운영 실측): 기본 `ThrottlerGuard` 는 `req.ip` 로 키를 만드는데,
 * Cloudflare→Railway 체인에서 `req.ip` 가 CF 이그레스 IP(연결마다 변동)로 잡혀
 * 스로틀 키가 분산 → Redis 카운터를 공유해도 한도가 무력화됐다. `trust proxy` hop
 * 수 맞추기는 체인 길이에 의존적이라 취약.
 *
 * Cloudflare 는 항상 `CF-Connecting-IP` 에 진짜 방문자 IP 를 넣고 **클라이언트가 위조한
 * 값을 덮어쓴다** (CF 통과 시). 따라서 이 헤더를 스로틀 키로 쓰면 hop 수와 무관하게
 * 방문자당 정확히 카운트된다. CF 를 거치지 않는 경로(로컬·직접 접근)에선 헤더가 없어
 * `req.ip` 로 폴백 — 기존 동작 유지.
 */
@Injectable()
export class CfThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = (req.headers ?? {}) as Record<string, string | undefined>;
    const cfIp = headers['cf-connecting-ip'];
    return Promise.resolve(cfIp ?? (req.ip as string));
  }
}
