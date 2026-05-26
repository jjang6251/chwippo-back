/**
 * PII (개인식별정보) 스크러버 — LlmService 진입점에서 모든 prompt 에 적용.
 *
 * **설계 원칙** (PR 0 + risk audit C1·H1·H4):
 * - **법 리스크 차단**: GDPR + 개인정보보호법 26조 (제3자 처리위탁 = OpenAI/Anthropic 미국)
 * - **방향 양방향**: 입력 (사용자 prompt → LLM) + 출력 (LLM 응답 → 사용자) 모두 적용
 *   - 입력 = 본인·동료·고객 정보가 외부 LLM 으로 새 나가지 않게
 *   - 출력 = model hallucination 으로 가짜 PII 생성 시 사용자 오해 차단 (`output_redacted` flag)
 * - **한국어 이름 false positive 방지**: 일반 정규식 X — 사용자 본인 `nickname`/`realname` 만 블랙리스트 치환
 *   (예: "박은빈" 같은 일반 한글 이름은 지명·일반어와 충돌하여 정규식 부적합)
 * - **URL 보존 결정**: 자소서 portfolio·GitHub repo URL 은 의도된 정보 — 단순 URL 은 보존, **SNS handle 만 치환**
 *
 * 향후 확장:
 * - 외국 전화번호 (현재는 한국만)
 * - 사진/파일 OCR PII (out of scope)
 */

// ── 정규식 패턴 — 12개 ──

const PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  // 1. 한국 휴대전화 (010-1234-5678 · 010 1234 5678 · 01012345678)
  {
    name: 'phone_kr_mobile',
    regex: /\b01[016789][- ]?\d{3,4}[- ]?\d{4}\b/g,
    replacement: '[REDACTED_PHONE]',
  },
  // 2. 한국 지역 유선 (02-123-4567 · 031-123-4567)
  {
    name: 'phone_kr_landline',
    regex: /\b0(2|[3-6][0-5])[- ]?\d{3,4}[- ]?\d{4}\b/g,
    replacement: '[REDACTED_PHONE]',
  },
  // 3. 한국 국제 (+82-10-1234-5678)
  {
    name: 'phone_kr_intl',
    regex: /\+82[- ]?\d{1,2}[- ]?\d{3,4}[- ]?\d{4}\b/g,
    replacement: '[REDACTED_PHONE]',
  },
  // 4. 이메일
  {
    name: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]',
  },
  // 5. 주민번호 (990101-1234567)
  {
    name: 'rrn',
    regex: /\b\d{6}[- ]?[1-4]\d{6}\b/g,
    replacement: '[REDACTED_RRN]',
  },
  // 6. 신용카드 (16자리, dash 또는 space 구분)
  {
    name: 'credit_card',
    regex: /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
    replacement: '[REDACTED_CARD]',
  },
  // 7. instagram handle (@handle — 2-30자, 알파벳·숫자·_·.)
  // 단어 경계 만으로는 일반 텍스트와 충돌 — instagram.com/@ 또는 본문 "@user" 명시만 매치
  {
    name: 'instagram_handle',
    regex: /(?:^|\s)@([a-zA-Z][\w.]{2,29})\b/g,
    replacement: ' [REDACTED_SNS]',
  },
  // 8. GitHub username URL (github.com/username)
  {
    name: 'github_username',
    regex: /\bgithub\.com\/([\w-]+)(\/[\w-]*)?/g,
    replacement: 'github.com/[REDACTED_USER]',
  },
  // 9. Instagram URL
  {
    name: 'instagram_url',
    regex: /\b(?:www\.)?instagram\.com\/([\w.]+)/g,
    replacement: 'instagram.com/[REDACTED_USER]',
  },
  // 10. KakaoTalk open chat / channel (open.kakao.com/...)
  {
    name: 'kakao_open',
    regex: /\bopen\.kakao\.com\/[^\s]+/g,
    replacement: '[REDACTED_KAKAO]',
  },
  // 11. Twitter/X handle URL
  {
    name: 'twitter_url',
    regex: /\b(?:twitter|x)\.com\/(\w+)/g,
    replacement: '[REDACTED_SNS]',
  },
  // 12. LinkedIn URL (개인 프로필)
  {
    name: 'linkedin_url',
    regex: /\blinkedin\.com\/in\/[\w-]+/g,
    replacement: 'linkedin.com/in/[REDACTED_USER]',
  },
];

export interface PiiScrubberOptions {
  /** 사용자 본인 이름 (nickname·realname) — 정확히 일치하는 것만 치환 (false positive 방지) */
  blacklistedNames?: string[];
}

export interface PiiScrubResult {
  /** PII 치환 후 텍스트 */
  text: string;
  /** PII 검출 여부 (output_redacted flag 결정에 사용) */
  hasPii: boolean;
  /** 검출된 패턴별 카운트 (metric·디버깅) */
  detected: Record<string, number>;
}

/**
 * 텍스트에서 PII 정규식 + 사용자 본인 이름 블랙리스트를 스크럽.
 * 입력 prompt·응답 모두 동일 함수 적용 (양방향).
 */
export function scrubPii(
  text: string,
  opts: PiiScrubberOptions = {},
): PiiScrubResult {
  if (!text) return { text: '', hasPii: false, detected: {} };

  let scrubbed = text;
  const detected: Record<string, number> = {};

  // 1) 정규식 패턴 12종
  for (const { name, regex, replacement } of PATTERNS) {
    const matches = scrubbed.match(regex);
    if (matches && matches.length > 0) {
      detected[name] = matches.length;
      // RegExp 의 lastIndex 이슈 회피 위해 새 regex 생성
      scrubbed = scrubbed.replace(
        new RegExp(regex.source, regex.flags),
        replacement,
      );
    }
  }

  // 2) 사용자 본인 이름 블랙리스트
  if (opts.blacklistedNames && opts.blacklistedNames.length > 0) {
    for (const name of opts.blacklistedNames) {
      const trimmed = name.trim();
      if (trimmed.length < 2) continue; // 1글자는 false positive 위험
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 단어 경계 — 한글은 단어 경계 의미 약하므로 사용자 입력 그대로 매치
      const nameRegex = new RegExp(escaped, 'g');
      const matches = scrubbed.match(nameRegex);
      if (matches && matches.length > 0) {
        detected['user_name'] = (detected['user_name'] ?? 0) + matches.length;
        scrubbed = scrubbed.replace(nameRegex, '[REDACTED_NAME]');
      }
    }
  }

  return {
    text: scrubbed,
    hasPii: Object.keys(detected).length > 0,
    detected,
  };
}

/**
 * 응답 역방향 스크러버 — LLM 응답 본문에서 PII 패턴 검출 시 치환.
 * model hallucination 으로 가짜 PII 생성을 차단 (사용자가 자기 데이터로 오해 위험).
 * `output_redacted=true` flag 가 llm_call_logs 에 저장됨.
 */
export function scrubOutputPii(text: string): PiiScrubResult {
  // 사용자 이름 블랙리스트는 응답 쪽엔 불필요 (입력에서 이미 제거됨)
  return scrubPii(text);
}
