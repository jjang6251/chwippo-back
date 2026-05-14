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
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { AdminUsersService } from './admin-users.service';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

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
}
