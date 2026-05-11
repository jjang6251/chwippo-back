import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { MyinfoService } from './myinfo.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  CreateLanguageCertDto,
  UpdateLanguageCertDto,
  CreateCertDto,
  UpdateCertDto,
  CreateAwardDto,
  UpdateAwardDto,
  CreateExperienceDto,
  UpdateExperienceDto,
  CreateEducationDto,
  UpdateEducationDto,
} from './dto/myinfo-items.dto';

interface AuthUser {
  id: string;
}

@Controller('myinfo')
export class MyinfoItemsController {
  constructor(private readonly myinfoService: MyinfoService) {}

  // ── Language Certs ────────────────────────────────────────
  @Get('language-certs')
  getLangCerts(@CurrentUser() user: AuthUser) {
    return this.myinfoService.getLangCerts(user.id);
  }

  @Post('language-certs')
  createLangCert(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateLanguageCertDto,
  ) {
    return this.myinfoService.createLangCert(user.id, dto);
  }

  @Patch('language-certs/:id')
  updateLangCert(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateLanguageCertDto,
  ) {
    return this.myinfoService.updateLangCert(user.id, id, dto);
  }

  @Delete('language-certs/:id')
  deleteLangCert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.myinfoService.deleteLangCert(user.id, id);
  }

  // ── Certs ─────────────────────────────────────────────────
  @Get('certs')
  getCerts(@CurrentUser() user: AuthUser) {
    return this.myinfoService.getCerts(user.id);
  }

  @Post('certs')
  createCert(@CurrentUser() user: AuthUser, @Body() dto: CreateCertDto) {
    return this.myinfoService.createCert(user.id, dto);
  }

  @Patch('certs/:id')
  updateCert(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCertDto,
  ) {
    return this.myinfoService.updateCert(user.id, id, dto);
  }

  @Delete('certs/:id')
  deleteCert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.myinfoService.deleteCert(user.id, id);
  }

  // ── Awards ────────────────────────────────────────────────
  @Get('awards')
  getAwards(@CurrentUser() user: AuthUser) {
    return this.myinfoService.getAwards(user.id);
  }

  @Post('awards')
  createAward(@CurrentUser() user: AuthUser, @Body() dto: CreateAwardDto) {
    return this.myinfoService.createAward(user.id, dto);
  }

  @Patch('awards/:id')
  updateAward(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAwardDto,
  ) {
    return this.myinfoService.updateAward(user.id, id, dto);
  }

  @Delete('awards/:id')
  deleteAward(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.myinfoService.deleteAward(user.id, id);
  }

  // ── Experiences ───────────────────────────────────────────
  @Get('experiences')
  getExperiences(@CurrentUser() user: AuthUser) {
    return this.myinfoService.getExperiences(user.id);
  }

  @Post('experiences')
  createExperience(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateExperienceDto,
  ) {
    return this.myinfoService.createExperience(user.id, dto);
  }

  @Patch('experiences/:id')
  updateExperience(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateExperienceDto,
  ) {
    return this.myinfoService.updateExperience(user.id, id, dto);
  }

  @Delete('experiences/:id')
  deleteExperience(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.myinfoService.deleteExperience(user.id, id);
  }

  // ── Educations ────────────────────────────────────────────
  @Get('educations')
  getEducations(@CurrentUser() user: AuthUser) {
    return this.myinfoService.getEducations(user.id);
  }

  @Post('educations')
  createEducation(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateEducationDto,
  ) {
    return this.myinfoService.createEducation(user.id, dto);
  }

  @Patch('educations/:id')
  updateEducation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateEducationDto,
  ) {
    return this.myinfoService.updateEducation(user.id, id, dto);
  }

  @Delete('educations/:id')
  deleteEducation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.myinfoService.deleteEducation(user.id, id);
  }

  // ── Documents ─────────────────────────────────────────────
  @Get('documents')
  getDocuments(@CurrentUser() user: AuthUser) {
    return this.myinfoService.getDocuments(user.id);
  }

  @Post('documents')
  createDocument(
    @CurrentUser() user: AuthUser,
    @Body() dto: { title: string; category?: string; file_url: string },
  ) {
    if (!dto.title?.trim())
      throw new BadRequestException('제목을 입력해주세요.');
    if (!dto.file_url) throw new BadRequestException('파일을 업로드해주세요.');
    return this.myinfoService.createDocument(user.id, dto);
  }

  @Delete('documents/:id')
  deleteDocument(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.myinfoService.deleteDocument(user.id, id);
  }
}
