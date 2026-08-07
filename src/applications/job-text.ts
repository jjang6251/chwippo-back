import { BadRequestException } from '@nestjs/common';

/**
 * 지원 카드의 "직무" 를 하나의 문자열로 정하는 단일 규칙.
 *
 * 🔴 **`jobTitle` 이 1순위다.** 카드에는 직무를 적는 칸이 둘이다:
 *
 * | 컬럼 | 정체 | 예시 |
 * |---|---|---|
 * | `jobTitle` | 회사명 아래 적는 **이 지원 건의 직무명** (자유 입력) | `백엔드 개발자`, `IOS 개발자` |
 * | `jobCategory` | `AddCardModal` 의 **직군 태그 8종** (콤마 join) | `IT개발`, `금융,영업` |
 *
 * dev 실측(2026-08-06): 사용자들이 `jobCategory` 를 직무가 아니라 **업종으로 쓴다.**
 * `백엔드 개발자 / 금융` = 금융권에 지원한 개발자다. 태그를 우선하면 백엔드 지원자에게
 * 재무제표를 묻게 된다 (dev 카드 4장이 실제로 그 상태였다).
 *
 * 면접·자소서가 **같은 규칙**을 써야 한다. 한쪽만 고치면 같은 카드인데 자소서는
 * 금융 직무로, 면접은 개발 직무로 잡히는 상태가 된다.
 * 프론트 대응 규칙은 `chwippo-front/src/hooks/useRequireJobTitle.tsx` 의 `resolveJobText`.
 */
export interface JobTextSource {
  /** 직군 태그 (`AddCardModal` 8종 콤마 join). 보조 신호 */
  jobCategory: string | null;
  /** 지원 직무명 (자유 입력). 이게 1순위 */
  jobTitle?: string | null;
}

/** 프롬프트에 실을 직무 문자열. 공백만 들어있는 값은 "없음" 으로 본다. */
export function resolveJobText(app: JobTextSource): string | null {
  return app.jobTitle?.trim() || app.jobCategory?.trim() || null;
}

/** 직무 미입력 시 사용자에게 보이는 문구. 프론트 모달 문구와 톤을 맞춘다. */
export const JOB_TITLE_REQUIRED_MESSAGE =
  '지원 직무를 먼저 입력해 주세요. 직무를 알아야 그 직무에 맞는 결과를 만들 수 있어요.';

/**
 * 프론트가 **이 에러만 다르게 다루기 위한** 전용 코드.
 *
 * 프론트는 이 코드를 보면 토스트 대신 **직무 입력 모달**을 띄운다 — 사용자가 할 일이
 * 명확한 에러라 "실패했어요" 를 읽히는 것보다 그 자리에서 받는 게 낫다.
 * `applicationId` 를 함께 실어야 모달이 어느 카드를 고칠지 안다.
 *
 * quota 의 `DAY_LIMIT`·`CONSENT_REQUIRED` 와 같은 관례 (`{ code, ... }` payload).
 */
export const JOB_TITLE_REQUIRED_CODE = 'JOB_TITLE_REQUIRED';

/**
 * AI 호출 전 직무 게이트 (2026-08-06, CEO 결정).
 *
 * **왜 막나** — 직무는 자소서·면접 결과 품질을 좌우하는데 카드 작성 시 선택 항목이라
 * 자주 비어 있다 (dev 카드 12장 중 5장). 비면 "일반론" 결과가 나오고, 사용자는
 * 그게 자기 직무 얘기가 아니라는 걸 모른 채 쓴다.
 *
 * **왜 여기(서버)에도 두나** — 프론트 게이트는 devtools·직접 호출로 우회된다.
 * 프론트는 마찰을 줄이는 안내이고, 실제 경계는 여기다.
 *
 * 🔴 판정은 `resolveJobText` 와 같아야 한다 — jobCategory 만 있어도 통과시킨다.
 * 여기만 엄격하면 태그만 단 멀쩡한 카드가 막힌다.
 */
export function assertJobTextPresent(
  app: JobTextSource & { id?: string },
): void {
  if (!resolveJobText(app)) {
    throw new BadRequestException({
      code: JOB_TITLE_REQUIRED_CODE,
      message: JOB_TITLE_REQUIRED_MESSAGE,
      // 프론트 모달이 어느 카드를 고칠지 알아야 한다
      applicationId: app.id,
    });
  }
}
