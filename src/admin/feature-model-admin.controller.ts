import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import type { LlmFeature } from '../ai/entities/llm-call-log.entity';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UpdateFeatureModelDto } from './dto/update-feature-model.dto';
import { FeatureModelAdminService } from './feature-model-admin.service';
import { getAuditCtx } from './utils/audit-ctx';

/**
 * G-1 (2026-08-02) — feature 별 LLM 모델 전환 endpoint.
 *
 * route 충돌 사전 확인 ✅ — `/admin/feature-model/*` 신규 path.
 *
 * 변경은 **다음 호출부터 즉시 반영**된다 (캐시 없음). 되돌리려면 다시 고르면 되고,
 * DB 행을 지우면 env 설정으로 돌아간다.
 */
@Controller('admin/feature-model')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class FeatureModelAdminController {
  constructor(private readonly service: FeatureModelAdminService) {}

  /** 14 feature 의 현재 모델 + 선택 가능한 모델 목록(불가 사유 포함) */
  @Get()
  listAll() {
    return this.service.listAll();
  }

  @Patch(':feature')
  update(
    @CurrentUser() admin: { id: string },
    @Param('feature') feature: LlmFeature,
    @Body() dto: UpdateFeatureModelDto,
    @Req() req: Request,
  ) {
    return this.service.updateModel(admin.id, feature, dto, getAuditCtx(req));
  }
}
