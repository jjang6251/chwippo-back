import { Body, Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpdateNicknameDto } from './dto/update-nickname.dto';
import { UpdateDashboardConfigDto } from './dto/update-dashboard-config.dto';

interface AuthUser { id: string }

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('me/terms')
  @HttpCode(204)
  async agreeTerms(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.agreeTerms(user.id);
  }

  @Patch('me/nickname')
  async updateNickname(@CurrentUser() user: AuthUser, @Body() dto: UpdateNicknameDto) {
    const updated = await this.usersService.updateNickname(user.id, dto.nickname);
    return { nickname: updated.nickname };
  }

  @Delete('me')
  @HttpCode(204)
  async deleteAccount(@CurrentUser() user: AuthUser): Promise<void> {
    await this.usersService.deleteAccount(user.id);
  }

  @Get('me/dashboard-config')
  async getDashboardConfig(@CurrentUser() user: AuthUser) {
    return this.usersService.getDashboardConfig(user.id);
  }

  @Patch('me/dashboard-config')
  async updateDashboardConfig(@CurrentUser() user: AuthUser, @Body() dto: UpdateDashboardConfigDto) {
    return this.usersService.updateDashboardConfig(user.id, dto);
  }
}
