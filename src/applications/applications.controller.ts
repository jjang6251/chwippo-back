import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { UpdateStepsDto } from './dto/update-steps.dto';
import { UpdateStepDetailDto } from './dto/update-step-detail.dto';
import { UpdateCurrentStepDto } from './dto/update-current-step.dto';
import {
  CreateChecklistItemDto,
  UpdateChecklistItemDto,
} from './dto/checklist-item.dto';

interface AuthUser {
  id: string;
  role: string;
}

@Controller('applications')
export class ApplicationsController {
  constructor(private readonly service: ApplicationsService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.service.findAll(user.id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateApplicationDto) {
    return this.service.create(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateApplicationDto,
  ) {
    return this.service.update(user.id, id, dto);
  }

  @Patch(':id/step')
  @HttpCode(HttpStatus.OK)
  updateCurrentStep(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCurrentStepDto,
  ) {
    return this.service.updateCurrentStep(user.id, id, dto.stepIndex);
  }

  @Put(':id/steps')
  updateSteps(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStepsDto,
  ) {
    return this.service.updateSteps(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(user.id, id);
  }

  // --- Step detail ---

  @Patch(':id/steps/:stepId')
  updateStep(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: UpdateStepDetailDto,
  ) {
    return this.service.updateStep(user.id, id, stepId, dto);
  }

  // --- Checklist ---

  @Get(':id/steps/:stepId/checklist')
  getChecklist(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
  ) {
    return this.service.getChecklist(user.id, id, stepId);
  }

  @Post(':id/steps/:stepId/checklist')
  createChecklistItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: CreateChecklistItemDto,
  ) {
    return this.service.createChecklistItem(user.id, id, stepId, dto);
  }

  @Patch(':id/steps/:stepId/checklist/:itemId')
  updateChecklistItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateChecklistItemDto,
  ) {
    return this.service.updateChecklistItem(user.id, id, stepId, itemId, dto);
  }

  @Delete(':id/steps/:stepId/checklist/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteChecklistItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.deleteChecklistItem(user.id, id, stepId, itemId);
  }
}
