/**
 * 모든 LLM provider (OpenAI·Anthropic·...) 의 공통 인터페이스.
 *
 * **설계 원칙** (ADR-025 + PR 0 risk audit):
 * - SDK 자체 retry 는 0 으로 강제 (`maxRetries: 0`) — 비용 폭증 차단
 * - parsing 실패 재시도는 LlmService 레벨에서 1회 (`callJson` 의 schema 위반 시)
 * - 응답 정규화 — provider 다른 응답 구조를 동일 `LlmProviderResponse` 로 변환
 * - structured JSON output 강제 (`callJson<T>(schema)`) — F6 면접 질문·자소서 답변 JSON 응답 필수
 */

import type { LlmProviderName } from '../entities/llm-call-log.entity';

export interface LlmProviderRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number; // PR 0 — 모든 호출 명시 (default 안 함 — token 폭증 방지)
  temperature: number;
}

/** structured JSON output 호출 시 추가 schema */
export interface LlmProviderJsonRequest extends LlmProviderRequest {
  /** JSON schema (OpenAI response_format=json_schema · Anthropic tool_use 로 변환) */
  jsonSchema: {
    name: string;
    schema: Record<string, unknown>;
  };
  /**
   * F6 PR 2 Phase 4 단계 B — web_search tool 활성화 (Anthropic 만 지원).
   * `allowedDomains` 화이트리스트 외 사이트는 검색 결과에서 제외.
   * OpenAI 는 무시 (web_search 미지원 모델 사용 시).
   */
  webSearch?: {
    allowedDomains: string[];
    maxUses: number; // 호출 1회당 web_search 최대 사용 횟수 (비용 통제)
  };
}

export interface LlmProviderResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** PR_B1 — Anthropic prompt cache write (input × 1.25 cost). 다른 provider 0 */
  cacheCreationTokens?: number;
  /** PR_B1 — Anthropic prompt cache hit (input × 0.10 cost). 다른 provider 0 */
  cacheReadTokens?: number;
  /** PR_B1 — Anthropic web_search tool 사용 횟수 ($0.01/search). 다른 provider 0 */
  webSearchCount?: number;
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';
}

export interface LlmProvider {
  readonly name: LlmProviderName;

  /** 활성화 여부 — API key 없으면 false. LlmService 가 fallback 분기 */
  readonly isAvailable: boolean;

  /** 일반 텍스트 응답 */
  complete(req: LlmProviderRequest): Promise<LlmProviderResponse>;

  /**
   * Structured JSON 응답 — schema 보장.
   * - OpenAI: `response_format: { type: 'json_schema', json_schema: ... }`
   * - Anthropic: tool_use 강제 → tool input 추출
   * - schema 위반 시 throw — LlmService 가 잡아 retry 1회 + audit row 분리
   */
  callJson<T = unknown>(
    req: LlmProviderJsonRequest,
  ): Promise<LlmProviderResponse & { json: T }>;
}

/**
 * parse 실패는 **완성된 응답을 받은 뒤** 실패하므로 provider 는 전액 과금한다.
 * 실측 usage 를 실어 보내야 audit·cost guard·quota 가 실패 비용을 볼 수 있음
 * (cost hardening 🔴1 — 없으면 실패 비용이 전 시스템에서 $0 으로 기록됨).
 */
export interface LlmFailureUsage {
  promptTokens: number;
  completionTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  webSearchCount?: number;
}

/** parsing 실패 시 throw — LlmService 가 catch 해서 retry */
export class LlmJsonParseError extends Error {
  constructor(
    public readonly provider: LlmProviderName,
    public readonly rawText: string,
    public readonly reason: string,
    /** 실측 토큰 (응답은 받았으므로 항상 존재해야 함 — provider 가 채움) */
    public readonly usage?: LlmFailureUsage,
  ) {
    super(`[${provider}] JSON parse failed: ${reason}`);
    this.name = 'LlmJsonParseError';
  }
}
