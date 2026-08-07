/**
 * 직무 문자열 단일 규칙 + AI 게이트 (2026-08-06).
 *
 * 🔴 **자소서와 면접이 같은 규칙을 써야 한다.** 규칙이 갈리면 같은 카드인데
 * 자소서는 금융 직무로, 면접은 개발 직무로 잡히는 상태가 된다.
 * 면접 쪽 fork 판정 회귀는 `interview-prep/interview-context-builder.spec.ts`.
 */
import { BadRequestException } from '@nestjs/common';
import {
  assertJobTextPresent,
  JOB_TITLE_REQUIRED_CODE,
  resolveJobText,
  type JobTextSource,
} from './job-text';

describe('resolveJobText — jobTitle 이 1순위', () => {
  it.each<[JobTextSource, string | null]>([
    // 🔴 dev DB 실제 조합 — 사용자들이 jobCategory 를 **업종**으로 쓴다.
    //    `금융` 을 우선하면 백엔드 지원자가 재무 직무로 잡힌다.
    [{ jobCategory: '금융', jobTitle: '백엔드 개발자' }, '백엔드 개발자'],
    [{ jobCategory: '금융,영업', jobTitle: '백엔드 개발자' }, '백엔드 개발자'],
    [{ jobCategory: '기획·PM,IT개발', jobTitle: 'IOS 개발자' }, 'IOS 개발자'],
    // jobTitle 이 없으면 태그로 내려간다
    [{ jobCategory: 'IT개발', jobTitle: null }, 'IT개발'],
    [{ jobCategory: 'IT개발', jobTitle: '   ' }, 'IT개발'],
    [{ jobCategory: 'IT개발' }, 'IT개발'], // jobTitle 키 자체가 없어도
    // 둘 다 없음
    [{ jobCategory: null, jobTitle: null }, null],
    [{ jobCategory: '  ', jobTitle: '  ' }, null],
  ])('%o → %s', (app, expected) => {
    expect(resolveJobText(app)).toBe(expected);
  });
});

describe('assertJobTextPresent — AI 게이트', () => {
  it.each<JobTextSource>([
    { jobCategory: null, jobTitle: null },
    { jobCategory: '   ', jobTitle: '   ' },
    { jobCategory: null },
  ])('직무 없음(%o) → BadRequest', (app) => {
    expect(() => assertJobTextPresent(app)).toThrow(BadRequestException);
    expect(() => assertJobTextPresent(app)).toThrow('지원 직무를 먼저 입력');
  });

  it.each<JobTextSource>([
    { jobCategory: null, jobTitle: '백엔드 개발자' },
    { jobCategory: 'IT개발', jobTitle: null },
    { jobCategory: 'IT개발', jobTitle: '백엔드 개발자' },
  ])('한쪽만 있어도 통과(%o)', (app) => {
    expect(() => assertJobTextPresent(app)).not.toThrow();
  });

  /**
   * 🔴 프론트가 **이 payload 모양에 의존한다** — `code` 를 보고 토스트 대신
   * 직무 입력 모달을 띄우고, `applicationId` 로 어느 카드를 고칠지 정한다.
   * 모양이 바뀌면 사용자는 "실패했어요" 만 보고 뭘 해야 할지 모른다.
   */
  it('🔴 응답 payload 에 code · applicationId · message 가 실린다', () => {
    try {
      assertJobTextPresent({ id: 'app-1', jobCategory: null, jobTitle: null });
      throw new Error('막지 못했다');
    } catch (e) {
      const res = (e as BadRequestException).getResponse();
      expect(res).toMatchObject({
        code: JOB_TITLE_REQUIRED_CODE,
        applicationId: 'app-1',
      });
      expect((res as { message: string }).message).toContain(
        '지원 직무를 먼저 입력',
      );
      // 프론트 인터셉터가 `err.message` 로도 읽을 수 있어야 한다
      expect((e as BadRequestException).message).toContain(
        '지원 직무를 먼저 입력',
      );
    }
  });

  it('🔴 게이트 판정은 resolveJobText 와 완전히 같다', () => {
    // 규칙이 갈리면 "화면엔 직무가 보이는데 저장은 막히는" 상태가 생긴다
    const cases: JobTextSource[] = [
      { jobCategory: null, jobTitle: null },
      { jobCategory: '  ', jobTitle: null },
      { jobCategory: 'IT개발', jobTitle: null },
      { jobCategory: null, jobTitle: '백엔드' },
      { jobCategory: '금융', jobTitle: '백엔드 개발자' },
    ];
    for (const c of cases) {
      const blocked = (() => {
        try {
          assertJobTextPresent(c);
          return false;
        } catch {
          return true;
        }
      })();
      expect(blocked).toBe(resolveJobText(c) === null);
    }
  });
});
