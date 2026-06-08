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
import { TierConfigAdminService } from './tier-config-admin.service';
import { UpdateTierConfigDto } from './dto/update-tier-config.dto';
import { getAuditCtx } from './utils/audit-ctx';
import type { CoinTier } from '../ai/entities/tier-config.entity';

/**
 * PR_B2 Phase 3 — tier_configs 매트릭스 수정 endpoint (Q3 C).
 *
 * route 충돌 사전 검증 ✅ — `/admin/tier-configs/*` 신규 path (충돌 X).
 */
@Controller('admin/tier-configs')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class TierConfigAdminController {
  constructor(private readonly service: TierConfigAdminService) {}

  @Get()
  listAll() {
    return this.service.listAll();
  }

  @Get(':tier/preview')
  getPreview(@Param('tier') tier: CoinTier) {
    return this.service.getPreview(tier);
  }

  @Get(':tier')
  getOne(@Param('tier') tier: CoinTier) {
    return this.service.getOne(tier);
  }

  @Patch(':tier')
  update(
    @CurrentUser() admin: { id: string },
    @Param('tier') tier: CoinTier,
    @Body() dto: UpdateTierConfigDto,
    @Req() req: Request,
  ) {
    return this.service.updateTierConfig(admin.id, tier, dto, getAuditCtx(req));
  }
}
