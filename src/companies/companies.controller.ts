import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AutocompleteQueryDto } from './dto/autocomplete-query.dto';
import { CompaniesService } from './companies.service';

interface AuthUser {
  id: string;
}

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  /**
   * W2 — 회사명 자동완성.
   *
   * - q 빈 string → signup 직군 boost 회사 추천
   * - q 1+ char → ILIKE 검색 (DART + 사용자 누적)
   * - limit 11+ → 10 cap
   * - rate limit: 분당 60회 (typeahead 폭주 차단)
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('autocomplete')
  autocomplete(
    @CurrentUser() user: AuthUser,
    @Query() dto: AutocompleteQueryDto,
  ) {
    return this.companiesService.autocomplete(user.id, dto.q, dto.limit);
  }

  /**
   * W2 — DART 기반 회사 정보 (CEO·재무·공시) by 회사명.
   * 메모리 90일 캐시. 매핑되지 않은 회사명 → 404.
   * Rate limit: 분당 30회 (BoardDetail 진입 시 1회 호출).
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('details')
  details(@Query('name') name?: string) {
    const trimmed = (name ?? '').trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('name 쿼리 필수');
    }
    if (trimmed.length > 100) {
      throw new BadRequestException('name 은 100자 이하만 허용됩니다.');
    }
    return this.companiesService.getDetailsByName(trimmed);
  }
}
