// @Type(() => Number) 데코레이터가 Reflect metadata 를 요구 (DTO 검증 파트).
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { mock } from 'jest-mock-extended';
import { CoinService } from './coin.service';
import {
  AI_COST_COUNT_MAX,
  AI_COST_COUNT_MIN,
  AiCostQueryDto,
  MyAiCostsController,
} from './my-ai-costs.controller';

/**
 * 질문 은행 D1c — `GET /me/ai-costs` spec (2026-08-11).
 *
 * 이 API 의 목적은 **프론트가 코인 단가를 하드코딩하지 않는 것**이라, spec 도 그 축으로 짠다:
 * "DB 값이 바뀌면 응답이 따라 바뀌는가" 와 "아무 feature 나 열리지 않는가".
 *
 * 시나리오:
 *  C1 정상 — CoinService.estimateCoins 에 feature 그대로 위임 + 응답 shape
 *  C2 🔴 meta 값이 바뀌면 응답도 바뀐다 (컨트롤러에 상수가 없다는 증명)
 *  C3 charges_coins=false → estimatedCoins 0 + chargesCoins false
 *  C4 🔴 count 를 보내도 값이 같다 — countSensitive:false 가 거짓말이 아님
 *  C5 count 미전송도 동일
 *  V1 feature 화이트리스트 밖 → 검증 실패 (→ 400)
 *  V2 feature 누락 → 검증 실패
 *  V3 count 1·20 경계 → 통과 / 0·21 → 실패
 *  V4 count 소수·문자열 → 실패
 *  V5 count 생략 → 통과
 *  V6 모르는 쿼리 필드 → 실패 (forbidNonWhitelisted)
 */
describe('MyAiCostsController (D1c 예상 코인 공개 조회)', () => {
  let controller: MyAiCostsController;
  let coinService: jest.Mocked<CoinService>;

  beforeEach(async () => {
    coinService = mock<CoinService>();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MyAiCostsController],
      providers: [{ provide: CoinService, useValue: coinService }],
    }).compile();
    controller = module.get<MyAiCostsController>(MyAiCostsController);
  });

  it('C1 정상 — estimateCoins 위임 + 응답 shape', async () => {
    coinService.estimateCoins.mockResolvedValue({
      chargesCoins: true,
      estimatedCoins: 3.6,
    });

    const r = await controller.estimate({
      feature: 'interview_prep_session',
      count: 7,
    });

    expect(coinService.estimateCoins).toHaveBeenCalledWith(
      'interview_prep_session',
    );
    expect(r).toEqual({
      feature: 'interview_prep_session',
      chargesCoins: true,
      estimatedCoins: 3.6,
      countSensitive: false,
    });
  });

  it('C2 🔴 meta 값이 바뀌면 응답도 바뀐다 (컨트롤러에 하드코딩 없음)', async () => {
    coinService.estimateCoins.mockResolvedValueOnce({
      chargesCoins: true,
      estimatedCoins: 2.4,
    });
    const before = await controller.estimate({
      feature: 'interview_prep_session',
    });

    coinService.estimateCoins.mockResolvedValueOnce({
      chargesCoins: true,
      estimatedCoins: 6,
    });
    const after = await controller.estimate({
      feature: 'interview_prep_session',
    });

    expect(before.estimatedCoins).toBe(2.4);
    expect(after.estimatedCoins).toBe(6);
  });

  it('C3 우리 부담 feature → chargesCoins false · 0 코인', async () => {
    coinService.estimateCoins.mockResolvedValue({
      chargesCoins: false,
      estimatedCoins: 0,
    });
    const r = await controller.estimate({ feature: 'interview_prep_session' });
    expect(r.chargesCoins).toBe(false);
    expect(r.estimatedCoins).toBe(0);
  });

  it('C4 🔴 count 가 달라도 값이 같다 — countSensitive:false 와 일치', async () => {
    coinService.estimateCoins.mockResolvedValue({
      chargesCoins: true,
      estimatedCoins: 3.6,
    });
    const one = await controller.estimate({
      feature: 'interview_prep_session',
      count: 1,
    });
    const twenty = await controller.estimate({
      feature: 'interview_prep_session',
      count: 20,
    });
    expect(one.estimatedCoins).toBe(twenty.estimatedCoins);
    expect(one.countSensitive).toBe(false);
  });

  it('C5 count 미전송도 같은 값', async () => {
    coinService.estimateCoins.mockResolvedValue({
      chargesCoins: true,
      estimatedCoins: 3.6,
    });
    const r = await controller.estimate({ feature: 'interview_prep_session' });
    expect(r.estimatedCoins).toBe(3.6);
  });

  describe('AiCostQueryDto — 쿼리 검증층 (전역 ValidationPipe 가 400 으로 만든다)', () => {
    const check = (query: unknown) =>
      validateSync(plainToInstance(AiCostQueryDto, query), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it('V1 화이트리스트 밖 feature → 실패', () => {
      expect(check({ feature: 'coverletter_draft_v2' })).not.toHaveLength(0);
      expect(check({ feature: 'nonexistent_feature' })).not.toHaveLength(0);
    });

    it('V2 feature 누락 → 실패', () => {
      expect(check({ count: '5' })).not.toHaveLength(0);
    });

    it('V3 count 경계 — 1·20 통과 / 0·21 실패', () => {
      expect(
        check({
          feature: 'interview_prep_session',
          count: String(AI_COST_COUNT_MIN),
        }),
      ).toHaveLength(0);
      expect(
        check({
          feature: 'interview_prep_session',
          count: String(AI_COST_COUNT_MAX),
        }),
      ).toHaveLength(0);
      expect(
        check({ feature: 'interview_prep_session', count: '0' }),
      ).not.toHaveLength(0);
      expect(
        check({ feature: 'interview_prep_session', count: '21' }),
      ).not.toHaveLength(0);
    });

    it('V4 count 소수·문자열 → 실패', () => {
      expect(
        check({ feature: 'interview_prep_session', count: '1.5' }),
      ).not.toHaveLength(0);
      expect(
        check({ feature: 'interview_prep_session', count: 'seven' }),
      ).not.toHaveLength(0);
    });

    it('V5 count 생략 → 통과', () => {
      expect(check({ feature: 'interview_prep_session' })).toHaveLength(0);
    });

    it('V6 모르는 쿼리 필드 → 실패', () => {
      expect(
        check({ feature: 'interview_prep_session', userId: 'other-user' }),
      ).not.toHaveLength(0);
    });
  });
});
