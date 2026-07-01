import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SchoolAutocompleteQueryDto } from './dto/school-autocomplete-query.dto';
import { MajorAutocompleteQueryDto } from './dto/major-autocomplete-query.dto';
import { CertAutocompleteQueryDto } from './dto/cert-autocomplete-query.dto';
import { SchoolsService } from './schools.service';

@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  /**
   * 학교명 자동완성. kind (high|univ) 로 데이터 소스 분기.
   * Rate limit: 분당 60회 (typeahead 폭주 차단, W2 companies 와 동일).
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('autocomplete')
  autocompleteSchools(@Query() dto: SchoolAutocompleteQueryDto) {
    return this.schoolsService.autocompleteSchools(dto.kind, dto.q, dto.limit);
  }

  /**
   * 전공 자동완성.
   * Rate limit: 분당 60회.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('majors/autocomplete')
  autocompleteMajors(@Query() dto: MajorAutocompleteQueryDto) {
    return this.schoolsService.autocompleteMajors(dto.q, dto.limit);
  }

  /**
   * 자격증 자동완성 (~235 정적 카탈로그).
   * dropdown 항목 = { name, issuer, hasNumber, validYears, category, popularity }
   * Rate limit: 분당 60회.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('certs/autocomplete')
  autocompleteCerts(@Query() dto: CertAutocompleteQueryDto) {
    return this.schoolsService.autocompleteCerts(dto.q, dto.limit);
  }

  /**
   * 어학 자격증 자동완성 (~90 정적 카탈로그).
   * dropdown 항목 = { name, language, level?, issuer, scoreType, scoreMax?, validYears, category }
   * Rate limit: 분당 60회.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('lang-certs/autocomplete')
  autocompleteLangCerts(@Query() dto: CertAutocompleteQueryDto) {
    return this.schoolsService.autocompleteLangCerts(dto.q, dto.limit);
  }
}
