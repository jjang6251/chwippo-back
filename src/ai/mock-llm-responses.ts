/**
 * F6 PR 2 Phase 4 — Dev-only mock LLM 응답.
 *
 * **활성 조건** (LlmService 안 분기):
 * - provider.isAvailable === false (API key 미설정)
 * - AND process.env.NODE_ENV === 'development' (화이트리스트)
 *
 * **prod·test 안전장치**: production / test 환경은 mock 안 나감.
 * - prod: 키 실수로 빠져도 status='error' 그대로 (사용자에게 가짜 답변 노출 차단)
 * - test: jest spec 기대 동작 (status='error') 그대로
 *
 * **흔적**:
 * - 응답 텍스트 전체에 `[MOCK]` prefix 명시 → 화면에서 즉시 인지
 * - llm_call_logs 에 row 저장 X (mock 사용 추적 불필요, DB 오염 방지)
 * - 백엔드 console 에 `[MOCK MODE]` warn 로그
 */
import type { LlmFeature } from './entities/llm-call-log.entity';

export interface MockLlmResult {
  text: string;
  json?: unknown;
  promptTokens: number;
  completionTokens: number;
}

/**
 * feature 별 mock 응답 생성. jsonSchema 가 있으면 json 채워서 반환.
 */
export function buildMockLlmResponse(
  feature: LlmFeature,
  hasJsonSchema: boolean,
): MockLlmResult {
  const baseTokens = { promptTokens: 100, completionTokens: 200 };

  switch (feature) {
    case 'interview_prep_session':
      return {
        text: '[MOCK]',
        json: {
          questions: [
            {
              question: '[MOCK] 본인의 강점 3가지와 각각의 사례를 말해주세요.',
              suggested_answer:
                '[MOCK] 저의 강점은 분석력, 문제 해결, 협업입니다.\n\n분석력 — 인턴 시절 ROAS 1.2 → 1.8 개선 사례에서 데이터를 쪼개어 광고 채널별 효율을 비교했습니다.\n\n문제 해결 — 게시판 버그가 누적된 상황에서 로그 패턴을 분석해 race condition 을 찾아냈습니다.\n\n협업 — A/B 테스트 진행 시 디자이너·기획자와 매주 정기 미팅으로 가설을 정렬했습니다.',
              source_log_ids: [],
              follow_ups: [
                {
                  question:
                    '[MOCK] 그중에서 가장 어려웠던 사례를 한 가지 더 깊이 말씀해주세요.',
                  suggested_answer:
                    '[MOCK] 게시판 버그가 가장 어려웠습니다. 재현이 안 되는 race condition 이었고, 결국 모든 동시성 시나리오를 stress test 로 재현했습니다.',
                  source_log_ids: [],
                },
              ],
            },
            {
              question:
                '[MOCK] 지원 직무에서 본인이 가장 자신 있는 영역과 부족한 영역은?',
              suggested_answer:
                '[MOCK] 자신 있는 영역은 데이터 분석과 디버깅입니다. 부족한 영역은 대규모 시스템 설계 경험으로, 입사 후 시니어 분들의 코드 리뷰를 통해 빠르게 배우고 싶습니다.',
              source_log_ids: [],
              follow_ups: [
                {
                  question:
                    '[MOCK] 부족한 부분을 메우기 위해 지금까지 어떤 노력을 했나요?',
                  suggested_answer:
                    '[MOCK] 시스템 디자인 인터뷰 책을 1주 1챕터씩 읽고, 토이 프로젝트로 채팅 서비스 분산 설계를 직접 구현해 봤습니다.',
                  source_log_ids: [],
                },
              ],
            },
            {
              question:
                '[MOCK] 협업 중 갈등이 있었던 경험과 어떻게 해결했나요?',
              suggested_answer:
                '[MOCK] 인턴 프로젝트 중 기획자와 개발 우선순위가 충돌했을 때, 사용자 가치 기준 매트릭스를 만들어 합의했습니다.',
              source_log_ids: [],
              follow_ups: [
                {
                  question: '[MOCK] 합의 후 결과는 어땠나요?',
                  suggested_answer:
                    '[MOCK] 두 가지 핵심 기능에 집중하기로 했고, 결과적으로 사용자 retention 이 12% 개선됐습니다.',
                  source_log_ids: [],
                },
              ],
            },
            {
              question: '[MOCK] 입사 후 1년 내 이루고 싶은 목표는?',
              suggested_answer:
                '[MOCK] 첫 6개월은 팀 코드베이스에 익숙해지고 작은 기능 단위로 PR 을 자주 올리며 코드 리뷰 문화를 흡수하고, 이후 6개월은 작은 서비스 모듈 하나를 owner 로 맡고 싶습니다.',
              source_log_ids: [],
              follow_ups: [
                {
                  question: '[MOCK] 그 목표가 회사에 어떤 가치를 줄까요?',
                  suggested_answer:
                    '[MOCK] owner 로 책임지면서 의사결정 속도가 빨라지고, 회사 입장에서는 인력 운영이 효율적이 됩니다.',
                  source_log_ids: [],
                },
              ],
            },
            {
              question: '[MOCK] 마지막으로 회사에 궁금한 점이 있나요?',
              suggested_answer:
                '[MOCK] 팀의 코드 리뷰 문화가 궁금합니다. 어떤 형식으로 진행되며 신입에게 어떤 기대치를 가지는지요?',
              source_log_ids: [],
              follow_ups: [],
            },
          ],
        },
        ...baseTokens,
      };

    case 'company_research':
      return {
        text: '[MOCK]',
        json: {
          businessSummary:
            '[MOCK] AI 기술 기반 SaaS 솔루션을 제공하는 IT 기업.',
          coreValues:
            '[MOCK] 사용자 중심 사고 · 빠른 실행 · 데이터 기반 의사결정 · 협업과 책임감.',
          visionMission:
            '[MOCK] 모두가 일을 사랑하게 만드는 기술. 반복 업무에서 사람을 해방시킨다.',
          recentTrends:
            '[MOCK] 최근 1년 AI 어시스턴트 라인업 확장, 글로벌 시장 진출 가속화. 분기 매출 30% 성장.',
          financials:
            '[MOCK] 2023 매출 500억, 2024 800억, 2025 1200억 (3년 CAGR ~55%). 영업이익률 18%.',
          competitors:
            '[MOCK] 국내: 라이벌사 A, 라이벌사 B / 글로벌: 미국 X 사. 차별점은 한국어 특화 + B2B SaaS 깊이.',
          jobInsights:
            '[MOCK] 백엔드: Python/Go, AWS, MSA 경험 우대. 신입은 빠른 학습·문제 해결 능력 중점 평가.',
          interviewKeywords: [
            '[MOCK] 협업',
            '[MOCK] 문제 해결',
            '[MOCK] 데이터 기반 사고',
            '[MOCK] 사용자 가치',
          ],
        },
        ...baseTokens,
      };

    case 'interview_prep_followup':
      return {
        text: '[MOCK]',
        json: {
          question:
            '[MOCK] 그 경험에서 가장 후회되는 결정이 있다면 무엇이고, 다시 한다면 어떻게 다르게 할 건가요?',
          suggested_answer:
            '[MOCK] 가장 후회되는 건 초기에 데이터 분석 없이 가설부터 시작한 것입니다. 다시 한다면 1주 정도 사용자 행동 로그를 먼저 분석하고 가설을 세웠을 겁니다.',
          source_log_ids: [],
        },
        ...baseTokens,
      };

    case 'coverletter_draft_v2':
      return {
        text: '[MOCK] 저는 데이터 기반 의사결정과 빠른 실행력으로 비즈니스 임팩트를 만들어내는 마케터입니다.\n\n인턴 시절 인스타그램 광고 캠페인의 ROAS 가 정체된 상황에서, 채널별 효율을 쪼개어 분석해 비효율 채널 2개를 제거하고 고효율 키워드 5개에 예산을 집중시켰습니다. 결과적으로 ROAS 가 1.2 에서 1.8 로 50% 개선됐습니다.\n\n이런 분석 → 실행 → 검증 사이클을 귀사의 마케팅 팀에서 더 큰 규모로 적용해 보고 싶습니다.',
        ...baseTokens,
      };

    case 'coverletter_recommend':
      return {
        text: '[MOCK]',
        json: {
          recommendedLogIds: [],
          reason:
            '[MOCK] 후보 활동 중 직무 관련 정량 성과가 가장 명확한 로그를 추천합니다.',
        },
        ...baseTokens,
      };

    case 'coverletter_feedback':
      return {
        text: '[MOCK]',
        json: {
          strengths: [
            '[MOCK] 구체적 정량 (ROAS 1.2→1.8) 제시가 신뢰를 줍니다.',
          ],
          issues: [
            {
              kind: 'ai_tone',
              quote: '끊임없는 열정과 도전정신으로',
              advice:
                '[MOCK] AI 티가 나는 상투 표현이에요. 본인 사례의 구체 동사로 바꿔보세요.',
            },
            {
              kind: 'structure',
              quote: '저는 어릴 때부터',
              advice: '[MOCK] 두괄식이 아니에요 — 결론 문장을 맨 앞으로.',
            },
          ],
          suggestions: [
            {
              target: '끊임없는 열정과 도전정신으로',
              improved: '[MOCK] 광고 채널 7개를 2주간 직접 비교하며',
            },
          ],
          summary:
            '[MOCK] 정량 근거는 좋으나 도입부 상투 표현 정리가 필요해요.',
        },
        ...baseTokens,
      };

    case 'note_summary':
      return {
        text: '[MOCK] ROAS 1.8 달성. 인스타그램 광고 채널별 효율 분석을 통해 비효율 채널 제거 + 고효율 키워드 집중 전략으로 매출 50% 개선.',
        ...baseTokens,
      };

    case 'auto_tag':
      return {
        text: '[MOCK]',
        json: {
          cat: 'analysis',
          comps: ['analytical', 'problem_solving'],
          keywords: ['[MOCK]'],
        },
        ...baseTokens,
      };

    case 'score':
    case 'analysis':
    case 'coverletter':
    case 'interview':
    case 'interview_followup':
    default:
      // generic fallback — text-only mock
      if (hasJsonSchema) {
        return { text: '[MOCK]', json: {}, ...baseTokens };
      }
      return {
        text: `[MOCK] ${feature} 응답 — dev 환경 mock 모드. OPENAI_API_KEY 등록 시 실제 호출.`,
        ...baseTokens,
      };
  }
}
