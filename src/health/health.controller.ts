import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../common/decorators/public.decorator';

/**
 * Health endpoint — public, 인증 없이 호출 가능.
 * LRR Phase 3-A (INF-A2 / P1T3 M-1): DB ping 추가 — DB 죽으면 503 응답.
 * Uptime Robot·Railway healthcheck가 사용.
 *
 * - 200: `{ status: 'ok', db: 'ok', timestamp }`
 * - 503: ServiceUnavailableException
 *
 * env·버전·내부 path 등 민감 정보 노출 없음 (T3-CG1 안전 유지).
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  async check() {
    const timestamp = new Date().toISOString();
    try {
      // Postgres ping — 가장 가벼운 query
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', db: 'ok', timestamp };
    } catch (err) {
      this.logger.error(`DB health check failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException({
        status: 'degraded',
        db: 'down',
        timestamp,
      });
    }
  }
}
