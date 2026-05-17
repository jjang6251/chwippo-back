/**
 * Bootstrap e2e (LRR P2T1 PR V H-18·C-2).
 *
 * main.ts에서 설정한 인프라(helmet 옵션·trust proxy)가 실제로 적용됐는지 검증.
 * 코드 수정 시 회귀 방어 — app.e2e-spec.ts에 있는 기본 helmet 헤더 외 항목.
 *
 * 검증 대상:
 * - 🔴 C-2: trust proxy 설정 (proxy chain client IP 인식 → throttle 정확도)
 * - 🟠 H-18: helmet 세부 옵션 (CSP·COEP 비활성, CORP 값, HSTS)
 */
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers/bootstrap';

describe('Bootstrap (e2e, H-18·C-2)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── C-2 trust proxy 회귀 방지 ─────────────────────────
  describe('Trust proxy (C-2)', () => {
    it("express app.get('trust proxy') === 1 (Cloudflare→Railway/EC2 1 hop)", () => {
      // main.ts에서 app.set('trust proxy', 1) 호출 — 미적용 시 모든 사용자가
      // proxy IP로 인식되어 ThrottlerGuard 카운트가 합산 → 전체 사용자 차단.
      // Nest의 app.get은 IoC 조회용 — express setting은 httpAdapter 인스턴스에서 직접.
      const express = app.getHttpAdapter().getInstance() as {
        get: (key: string) => unknown;
      };
      expect(express.get('trust proxy')).toBe(1);
    });
  });

  // ── H-18 helmet 세부 옵션 ─────────────────────────────
  describe('Helmet 옵션 (H-18)', () => {
    it('content-security-policy 헤더 부재 (API 전용이라 비활성)', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['content-security-policy']).toBeUndefined();
    });

    it('cross-origin-embedder-policy 헤더 부재 (cross-origin 리소스 허용)', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
    });

    it('cross-origin-resource-policy: cross-origin (frontend 별도 origin)', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });

    it('strict-transport-security 헤더 존재 (helmet default)', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['strict-transport-security']).toBeDefined();
    });
  });
});
