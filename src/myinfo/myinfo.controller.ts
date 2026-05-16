import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { MyinfoService } from './myinfo.service';
import { StorageUsageService } from './storage-usage.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpdateProfileDto } from './dto/profile.dto';
import {
  CreateCoverletterCustomDto,
  UpdateCoverletterCustomDto,
  UpdateCoverletterDto,
} from './dto/coverletter.dto';

interface AuthUser {
  id: string;
}

@Controller('myinfo')
export class MyinfoController {
  constructor(
    private readonly myinfoService: MyinfoService,
    private readonly storageUsage: StorageUsageService,
  ) {}

  // ── Storage Usage ─────────────────────────────────────────
  @Get('storage-usage')
  getStorageUsage(@CurrentUser() user: AuthUser) {
    return this.storageUsage.getUsage(user.id);
  }

  // ── Profile ───────────────────────────────────────────────
  @Get('profile')
  getProfile(@CurrentUser() user: AuthUser) {
    return this.myinfoService.getProfile(user.id);
  }

  @Patch('profile')
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.myinfoService.updateProfile(user.id, dto);
  }

  // ── Coverletter ───────────────────────────────────────────
  @Get('coverletter')
  getCoverletter(@CurrentUser() user: AuthUser) {
    return this.myinfoService.getCoverletter(user.id);
  }

  @Patch('coverletter')
  updateCoverletter(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateCoverletterDto,
  ) {
    return this.myinfoService.updateCoverletter(user.id, dto);
  }

  @Post('coverletter/custom')
  createCustom(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCoverletterCustomDto,
  ) {
    return this.myinfoService.createCustomItem(
      user.id,
      dto.label,
      dto.order_index ?? 0,
    );
  }

  @Patch('coverletter/custom/:id')
  updateCustom(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCoverletterCustomDto,
  ) {
    return this.myinfoService.updateCustomItem(user.id, id, dto);
  }

  @Delete('coverletter/custom/:id')
  deleteCustom(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.myinfoService.deleteCustomItem(user.id, id);
  }
}
