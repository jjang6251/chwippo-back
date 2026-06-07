import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { AdminUsersService } from './admin-users.service';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';
import { GrantCoinDto } from './dto/grant-coin.dto';
import { RevokeCoinDto } from './dto/revoke-coin.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { getAuditCtx } from './utils/audit-ctx';

interface AuthUser {
  id: string;
}

class WarnUserDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(500)
  message: string;
}

@Controller('admin/users')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('suspended') suspended?: string,
  ) {
    return this.adminUsersService.findAll({
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
      search,
      role,
      suspended:
        suspended === 'true' ? true : suspended === 'false' ? false : undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.adminUsersService.findOne(id);
  }

  @Patch(':id')
  updateUser(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserDto,
  ) {
    return this.adminUsersService.updateUser(admin.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteUser(@CurrentUser() admin: AuthUser, @Param('id') id: string) {
    return this.adminUsersService.deleteUser(admin.id, id);
  }

  @Post(':id/warn')
  warnUser(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body() dto: WarnUserDto,
  ) {
    return this.adminUsersService.warnUser(admin.id, id, dto.message);
  }

  @Post(':id/export')
  exportUser(@CurrentUser() admin: AuthUser, @Param('id') id: string) {
    return this.adminUsersService.exportUser(admin.id, id);
  }

  // PR_B2 Phase 1 — 코인 grant / revoke
  @Post(':id/coins/grant')
  grantCoin(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body() dto: GrantCoinDto,
    @Req() req: Request,
  ) {
    return this.adminUsersService.grantCoin(
      admin.id,
      id,
      dto,
      getAuditCtx(req),
    );
  }

  @Post(':id/coins/revoke')
  revokeCoin(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body() dto: RevokeCoinDto,
    @Req() req: Request,
  ) {
    return this.adminUsersService.revokeCoin(
      admin.id,
      id,
      dto,
      getAuditCtx(req),
    );
  }

  // PR_B2 Phase 1 — 정지 / 해제 (Q13 + Q25)
  @Patch(':id/suspend')
  suspendUser(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Body() dto: SuspendUserDto,
    @Req() req: Request,
  ) {
    return this.adminUsersService.suspendUser(
      admin.id,
      id,
      dto,
      getAuditCtx(req),
    );
  }

  @Delete(':id/suspend')
  unsuspendUser(
    @CurrentUser() admin: AuthUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.adminUsersService.unsuspendUser(admin.id, id, getAuditCtx(req));
  }

  // PR_B2 Phase 1 — 사용자 상세 (Q6)
  @Get(':id/detail')
  getUserDetail(@Param('id') id: string) {
    return this.adminUsersService.getUserDetail(id);
  }
}
