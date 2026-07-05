import { Controller, Get, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ActivationService, ActivationResponse } from './activation.service';

/**
 * A8 — GET /admin/activation: 주차 코호트 4층 지표 + funnel + 브리핑 상관.
 * 5분 캐시는 service 담당.
 */
@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class ActivationController {
  constructor(private readonly activationService: ActivationService) {}

  @Get('activation')
  getActivation(): Promise<ActivationResponse> {
    return this.activationService.getActivation();
  }
}
