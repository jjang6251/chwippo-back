import {
  checkSafety,
  findExecutiveNames,
  verifySeedDoc as verify,
} from './research-seed-validator';

/**
 * 🔴 **검증기 자체를 검증한다.**
 *
 * 이 스크립트는 seed 조립 전 유일한 자동 게이트다. 여기가 틀리면 "검사를 돌렸다" 는
 * 착각만 남고 실제로는 뚫린다 — 이 프로젝트에서 이미 세 번 반복된 패턴이다
 * (자소서 `as` 단언 · 모델 cap `expect(true).toBe(true)` · seed 수동 검수).
 *
 * 특히 **오탐**을 고정하는 이유: "또 오탐이네" 하고 넘기기 시작하면 진짜 위반도 같이
 * 넘어간다. 검증 도구의 신뢰도가 곧 탐지율이다.
 */
describe('research seed 검증기', () => {
  /** 위반 0 인 최소 seed — 테스트마다 한 군데만 망가뜨려 그 항목만 검증한다 */
  const seedWith = (sources: unknown[]) => ({
    version: 'test',
    ttlDays: 180,
    companies: [
      {
        companyName: '테스트',
        research: {
          businessSummary: 'a',
          coreValues: 'a',
          visionMission: 'a',
          recentTrends: 'a',
          financials: 'a',
          competitors: 'a',
          differentiators: 'a',
          jobInsights: 'a',
          interviewKeywords: Array.from({ length: 5 }, (_, i) => ({
            keyword: `k${i}`,
            category: 'tech',
          })),
          talentProfile: ['a'],
          companyProfile: {},
          productsAndTech: {},
        },
        sources,
      },
    ],
  });

  /**
   * 🔴 **로더와 CLI 의 강도 차이를 고정한다.**
   *
   * 로더는 안전 백스톱이지 품질 게이트가 아니다. 완비성까지 막으면 사소한 스키마 진화
   * 하나에 **정상 데이터 전체가 안 들어가는** 더 나쁜 실패가 된다.
   * 이 경계가 무너지면 부팅 적재가 조용히 전멸하므로 여기서 못 박는다.
   */
  describe('안전(로더) vs 완비성(CLI) 경계', () => {
    it('필드 누락은 안전 위반이 아니다 — 로더는 통과시킨다', () => {
      // 기존 seed 픽스처가 실제로 이런 모양이다 (businessSummary 만 있음)
      const partial = {
        companyName: '크래프톤',
        research: { businessSummary: '글로벌 게임사' },
        sources: [{ url: 'https://krafton.com' }],
      };
      expect(checkSafety(partial)).toEqual([]);
    });

    it('그 누락을 CLI 는 잡는다', () => {
      const { violations } = verify({
        version: 'v',
        ttlDays: 180,
        companies: [
          {
            companyName: '크래프톤',
            research: { businessSummary: '글로벌 게임사' },
            sources: [{ url: 'https://krafton.com' }],
          },
        ],
      });
      expect(violations.some((v) => v.detail.includes('누락'))).toBe(true);
    });

    /** 사용자에게 도달하면 되돌릴 수 없는 것 — 로더도 반드시 막아야 한다 */
    it.each([
      ['개인정보', { businessSummary: '서정진 회장은 …' }, '🔴 개인정보'],
      [
        '크래시 유발 타입',
        { businessSummary: '정상', recentTrends: ['1)', '2)'] },
        '타입',
      ],
    ])('%s 는 로더도 막는다', (_label, research, kind) => {
      const v = checkSafety({ companyName: 'X', research, sources: [] });
      expect(v.some((x) => x.kind === kind)).toBe(true);
    });

    /** talentProfile 이 문자열로 오면 프론트 `.map()` 이 죽는다 */
    it('배열이어야 할 필드가 문자열이면 로더가 막는다', () => {
      const v = checkSafety({
        companyName: 'X',
        research: { talentProfile: '도전정신' },
        sources: [],
      });
      expect(
        v.some((x) => x.detail.includes('talentProfile 가 배열이 아님')),
      ).toBe(true);
    });

    it('금지 소스는 로더도 막는다', () => {
      const v = checkSafety({
        companyName: 'X',
        research: { businessSummary: '정상' },
        sources: [{ url: 'https://www.jobkorea.co.kr/x' }],
      });
      expect(v.some((x) => x.kind === '🔴 금지소스')).toBe(true);
    });
  });

  describe('임원 실명 탐지', () => {
    it.each([
      ['서정진 회장은 2026년을 …', '서정진 회장'],
      ['정의선 회장·현대차·기아', '정의선 회장'],
      ['김영범 사장이 취임', '김영범 사장'],
      ['황철주 창업자가 설립', '황철주 창업자'],
      ['최윤범 회장 체제', '최윤범 회장'],
    ])('실명+직함을 잡는다: %s', (text, expected) => {
      expect(findExecutiveNames(text)).toContain(expected);
    });

    /**
     * 🔴 조사(`은`·`이`)가 붙는 게 한국어에선 정상이다. 후행 경계를 두면
     * `"회장은"` 을 놓쳐 **실제 위반의 절반 이상이 빠진다** (실측: 15건 중 9건 누락).
     */
    it('직함 뒤 조사가 붙어도 잡는다', () => {
      expect(findExecutiveNames('허태수 회장이 선언')).toHaveLength(1);
      expect(findExecutiveNames('홍두영 회장은')).toHaveLength(1);
    });

    describe('오탐을 내지 않는다 — 직함 앞이 이름이 아닌 경우', () => {
      it.each([
        '명예회장으로 물러났다',
        '신임 대표이사를 선임',
        '전임 사장 시절',
        '그룹 회장 직속 조직',
        '금융지주 회장',
      ])('%s', (text) => {
        expect(findExecutiveNames(text)).toEqual([]);
      });

      /**
       * 🔴 경계가 없으면 긴 단어를 잘라 먹는다 —
       * `한전기술 사장` → `전기술 사장` · `두산그룹 회장` → `산그룹 회장`
       */
      it.each([
        ['한전기술 사장', '회사명이 잘려 이름처럼 보이는 경우'],
        ['두산그룹 회장', '그룹명이 잘리는 경우'],
      ])('%s — %s', (text) => {
        expect(findExecutiveNames(text)).toEqual([]);
      });

      it('조사로 끝나는 후보는 이름이 아니다 (불굴의 창업자)', () => {
        expect(findExecutiveNames('불굴의 창업자 정신')).toEqual([]);
      });
    });
  });

  describe('금지 소스', () => {
    it('취업포털·후기 사이트를 잡는다', () => {
      const { violations } = verify(
        seedWith([{ url: 'https://www.jobplanet.co.kr/companies/1' }]),
      );
      expect(violations.some((v) => v.detail.includes('jobplanet'))).toBe(true);
    });

    /** 나무위키는 CC BY-NC-SA(비영리) — 상업 서비스에 쓸 수 없다 */
    it('라이선스 충돌 소스를 잡는다', () => {
      const { violations } = verify(
        seedWith([{ url: 'https://namu.wiki/w/test' }]),
      );
      expect(violations.some((v) => v.detail.includes('비영리'))).toBe(true);
    });

    it('정상 출처는 통과', () => {
      const { violations } = verify(
        seedWith([{ url: 'https://dart.fss.or.kr/x' }]),
      );
      expect(violations).toEqual([]);
    });

    /** 금지가 아니라 **조건부 허용** — 막지 않고 건수만 알린다 */
    it('위키피디아는 막지 않고 표시의무로 집계한다', () => {
      const { violations, stats } = verify(
        seedWith([{ url: 'https://ko.wikipedia.org/wiki/x' }]),
      );
      expect(violations).toEqual([]);
      expect(stats['표시의무(위키)']).toBe(1);
    });
  });

  /**
   * 🔴 본문 스캔은 **위반이 아니라 참고**다.
   *
   * 본문에 "잡코리아" 가 있다고 잡코리아를 출처로 쓴 게 아니다 — 실측 7건이 전부 정상이었다:
   * 원티드랩(회사 자신이 취업포털) · 다우기술(사람인HR 모회사) · 공공기관 3곳의
   * "블라인드 채용" · SOOP 의 "Catch" · 원티드랩의 "Wanted".
   *
   * 이걸 위반으로 올리면 매번 뜨고, 익숙해지면 **진짜 위반도 같이 넘어간다.**
   */
  describe('본문 언급 — 위반이 아니라 참고(notice)', () => {
    const withBody = (text: string) => {
      const s = seedWith([{ url: 'https://dart.fss.or.kr/x' }]);
      s.companies[0].research.businessSummary = text;
      return s;
    };

    it('한국어 브랜드 언급을 notice 로 올린다 (exit code 불변)', () => {
      const { violations, notices } = verify(
        withBody('잡코리아 채용공고 기준'),
      );
      expect(violations).toEqual([]); // ← 통과를 막지 않는다
      expect(notices.some((n) => n.detail.includes('잡코리아'))).toBe(true);
    });

    /**
     * 🔴 일반 영단어·동음이의어를 별칭에 넣으면 오탐이 쏟아진다.
     * `blind` → "블라인드 채용" · `catch`/`wanted` → 영문 슬로건·사명
     */
    it.each([
      ['블라인드 채용을 도입했다', '블라인드 = blind hiring'],
      ['Catch the wave 라는 슬로건', 'Catch = 일반 영단어'],
      ['we catch trends early', '소문자 catch — 대문자만 막으면 뚫린다'],
      ['Wanted: 글로벌 인재', 'Wanted = 일반 영단어'],
      ['talent wanted for the role', '소문자 wanted'],
      ['blind spot 을 줄인다', '소문자 blind'],
      ['it is indeed profitable', '소문자 indeed'],
      ['사람을 중시한다', '부분 문자열 오탐 방지'],
    ])('%s — %s → 아무것도 안 뜬다', (text) => {
      const { violations, notices } = verify(withBody(text));
      expect(violations).toEqual([]);
      expect(notices).toEqual([]);
    });

    /** 진짜 위반은 **출처 도메인**으로 잡는다 — 이쪽은 정확하다 */
    it('본문은 깨끗해도 출처가 금지 도메인이면 위반', () => {
      const s = seedWith([{ url: 'https://www.jobkorea.co.kr/company/1' }]);
      const { violations, notices } = verify(s);
      expect(violations.some((v) => v.kind === '🔴 금지소스')).toBe(true);
      expect(notices).toEqual([]);
    });
  });

  /**
   * 🔴 `findExecutiveNames` 가 맞아도 **verify() 가 그 결과를 위반으로 안 올리면 게이트는 뚫린다.**
   * 함수만 테스트하고 배선을 안 보는 건 이 프로젝트에서 반복된 실패다
   * (G-1 `validateResult` 미배선 · 자소서 런타임 검증 부재).
   */
  describe('PII — verify() 배선까지', () => {
    const withBody = (text: string) => {
      const s = seedWith([{ url: 'https://dart.fss.or.kr/x' }]);
      s.companies[0].research.businessSummary = text;
      return s;
    };

    it('임원 실명이 실제로 violations 에 올라간다', () => {
      const { violations } = verify(withBody('서정진 회장은 이렇게 말했다'));
      expect(
        violations.some(
          (v) => v.kind === '🔴 개인정보' && v.detail.includes('서정진 회장'),
        ),
      ).toBe(true);
    });

    it.each([
      ['이메일', 'ir@company.co.kr 로 문의'],
      ['전화번호', '대표번호 02-1234-5678'],
      ['주민번호 형태', '900101-1234567'],
    ])('%s 패턴을 잡는다', (label, text) => {
      const { violations } = verify(withBody(text));
      expect(
        violations.some(
          (v) => v.kind === '🔴 개인정보' && v.detail.includes(label),
        ),
      ).toBe(true);
    });

    it('평범한 본문에는 PII 위반이 없다', () => {
      const { violations } = verify(withBody('반도체를 만드는 회사다'));
      expect(violations).toEqual([]);
    });
  });

  describe('스키마·타입', () => {
    const base = {
      version: 'test',
      ttlDays: 180,
      companies: [
        {
          companyName: '테스트',
          research: {
            businessSummary: 'a',
            coreValues: 'a',
            visionMission: 'a',
            recentTrends: 'a',
            financials: 'a',
            competitors: 'a',
            differentiators: 'a',
            jobInsights: 'a',
            interviewKeywords: Array.from({ length: 5 }, (_, i) => ({
              keyword: `k${i}`,
              category: 'tech',
            })),
            talentProfile: ['a'],
            companyProfile: {},
            productsAndTech: {},
          },
          sources: [{ url: 'https://dart.fss.or.kr/x' }],
        },
      ],
    };

    it('정상 seed 는 위반 0', () => {
      expect(verify(base).violations).toEqual([]);
    });

    /**
     * ⚠️ 2026-07-08 실사고 — recentTrends 가 배열로 들어와 프론트 `.trim()` 크래시.
     * 5개사(카카오·쿠팡·토스·당근·라인)가 영향받아 v2026-07.1 로 정정했다.
     */
    it('string 이어야 할 필드가 배열이면 잡는다 (프론트 크래시 원인)', () => {
      const bad = structuredClone(base);
      (bad.companies[0].research as Record<string, unknown>).recentTrends = [
        '1)',
        '2)',
      ];
      expect(
        verify(bad).violations.some((v) => v.detail.includes('recentTrends')),
      ).toBe(true);
    });

    it('interviewKeywords 개수 범위(5~8)를 본다', () => {
      const bad = structuredClone(base);
      (bad.companies[0].research as Record<string, unknown>).interviewKeywords =
        [{ keyword: 'k', category: 'tech' }];
      expect(verify(bad).violations.some((v) => v.detail.includes('5~8'))).toBe(
        true,
      );
    });

    it('category enum 밖 값을 잡는다', () => {
      const bad = structuredClone(base);
      (
        bad.companies[0].research as { interviewKeywords: unknown[] }
      ).interviewKeywords = [{ keyword: 'k', category: 'wrong' }];
      expect(
        verify(bad).violations.some((v) => v.detail.includes('category')),
      ).toBe(true);
    });

    /** 같은 버전이면 부팅 적재가 조기 skip 되어 갱신이 조용히 무시된다 */
    it('version 누락을 잡는다', () => {
      const bad = { ...base, version: undefined };
      expect(verify(bad).violations.some((v) => v.kind === '버전 누락')).toBe(
        true,
      );
    });

    /** TTL 이 없으면 조사 결과가 만료되지 않고 영구히 남는다 */
    it('ttlDays 누락을 잡는다', () => {
      const bad = { ...base, ttlDays: undefined };
      expect(verify(bad).violations.some((v) => v.kind === 'TTL 누락')).toBe(
        true,
      );
    });

    it('research 객체 자체가 없으면 잡는다', () => {
      const bad = structuredClone(base) as { companies: unknown[] };
      bad.companies[0] = { companyName: '테스트', sources: [] };
      expect(
        verify(bad).violations.some((v) => v.detail.includes('research 객체')),
      ).toBe(true);
    });

    it('객체여야 할 필드가 배열이면 잡는다', () => {
      const bad = structuredClone(base);
      (bad.companies[0].research as Record<string, unknown>).companyProfile =
        [];
      expect(
        verify(bad).violations.some((v) =>
          v.detail.includes('companyProfile 가 객체가 아님'),
        ),
      ).toBe(true);
    });

    /** URL 이 아니면 도메인 판정 자체가 불가능하다 — 조용히 통과시키면 금지소스가 샌다 */
    it.each([
      ['URL 아닌 문자열', '잡코리아에서 봄'],
      ['url 키 없는 객체', { title: '출처' }],
      ['null', null],
    ])('출처가 %s 이면 파싱 불가로 잡는다', (_label, src) => {
      const { violations } = verify(seedWith([src]));
      expect(violations.some((v) => v.detail.includes('URL 파싱 불가'))).toBe(
        true,
      );
    });

    it('sources 가 비면 잡는다', () => {
      const bad = structuredClone(base);
      bad.companies[0].sources = [];
      expect(
        verify(bad).violations.some((v) => v.detail.includes('sources')),
      ).toBe(true);
    });
  });
});
