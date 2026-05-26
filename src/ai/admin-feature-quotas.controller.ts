import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminFeatureQuotasService } from './admin-feature-quotas.service';

class UpdateFeatureQuotaDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  dayLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(100_000)
  monthLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3_600)
  cooldownSeconds?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@Controller('admin/ai-feature-quotas')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminFeatureQuotasController {
  constructor(private readonly service: AdminFeatureQuotasService) {}

  /** 전체 feature × tier 매트릭스 (admin 페이지 진입 시 한꺼번에 로드) */
  @Get()
  listAll() {
    return this.service.listAll();
  }

  @Get(':feature/:tier')
  getOne(@Param('feature') feature: string, @Param('tier') tier: string) {
    return this.service.getOne(feature, tier);
  }

  @Patch(':feature/:tier')
  update(
    @CurrentUser() admin: { id: string },
    @Param('feature') feature: string,
    @Param('tier') tier: string,
    @Body() dto: UpdateFeatureQuotaDto,
  ) {
    return this.service.update(admin.id, feature, tier, dto);
  }
}
