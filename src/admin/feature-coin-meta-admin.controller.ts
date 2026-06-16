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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { FeatureCoinMetaAdminService } from './feature-coin-meta-admin.service';
import { UpdateFeatureCoinMetaDto } from './dto/update-feature-coin-meta.dto';
import { getAuditCtx } from './utils/audit-ctx';

/**
 * PR_B2 Phase 3 — feature_coin_meta 매트릭스 수정 endpoint.
 *
 * route 충돌 사전 검증 ✅ — `/admin/feature-coin-meta/*` 신규 path.
 */
@Controller('admin/feature-coin-meta')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class FeatureCoinMetaAdminController {
  constructor(private readonly service: FeatureCoinMetaAdminService) {}

  @Get()
  listAll() {
    return this.service.listAll();
  }

  @Get(':feature')
  getOne(@Param('feature') feature: string) {
    return this.service.getOne(feature);
  }

  @Patch(':feature')
  update(
    @CurrentUser() admin: { id: string },
    @Param('feature') feature: string,
    @Body() dto: UpdateFeatureCoinMetaDto,
    @Req() req: Request,
  ) {
    return this.service.updateFeatureCoinMeta(
      admin.id,
      feature,
      dto,
      getAuditCtx(req),
    );
  }
}
