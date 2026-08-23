import {
  buildCompanyNameIndex,
  findSimilarCompanyName,
  hasCompanyName,
  normalizeCompanyName,
  toJamo,
} from './company-name-match';

/**
 * 회사명 실존 판정 · 유사명 제안 spec.
 *
 * 시나리오:
 * - 정규화 (trim·대소문자)
 * - 인덱스 구조 (정규화 Set · 길이 버킷 · 빈 이름 제외)
 * - 실존 여부 (정확·표기 흔들림·없음)
 * - 유사명 (가까운 것 제안 / 먼 것 미제안 / 실존이면 계산 안 함 / 2글자 이하 미제안)
 * - 결정성 (동점이면 항상 같은 이름)
 * - 대용량 (3,798 규모에서 후보가 길이 버킷으로 좁혀지는지)
 */
describe('company-name-match', () => {
  const DART = [
    '카카오',
    '네이버',
    '토스',
    '삼성전자',
    'LG에너지솔루션',
    '한국가스공사',
    '현대자동차',
  ];
  const index = buildCompanyNameIndex(DART);

  describe('normalizeCompanyName', () => {
    it('trim + lowercase — 병합 키와 같은 규칙', () => {
      expect(normalizeCompanyName('  Kakao ')).toBe('kakao');
      expect(normalizeCompanyName('LG에너지솔루션')).toBe('lg에너지솔루션');
    });
  });

  describe('toJamo', () => {
    // 🔴 이 분해가 없으면 「까까오」→「카카오」 오타를 글자 단위 거리 2 로 읽어 놓친다.
    it('한글 음절을 초·중·종성으로 쪼갠다 (종성 없으면 2자모)', () => {
      expect(toJamo('카카오')).toBe('ㅋㅏㅋㅏㅇㅗ');
      expect(toJamo('한')).toBe('ㅎㅏㄴ');
    });

    it('한글이 아닌 문자는 그대로 통과', () => {
      expect(toJamo('lg에너지')).toBe('lgㅇㅔㄴㅓㅈㅣ');
    });

    it('「까까오」와 「카카오」의 자모 거리는 2 — 글자 거리도 2 지만 자모 길이가 6이라 상대적으로 가깝다', () => {
      expect(toJamo('까까오')).toBe('ㄲㅏㄲㅏㅇㅗ');
    });
  });

  describe('buildCompanyNameIndex', () => {
    it('정규화 이름 Set + 길이 버킷을 만든다', () => {
      expect(index.normalized.has('카카오')).toBe(true);
      expect(index.byLength.get(3)?.map((c) => c.display)).toEqual(
        expect.arrayContaining(['카카오', '네이버']),
      );
    });

    it('길이 버킷에는 그 길이의 이름만 들어간다 (전수 비교를 막는 구조)', () => {
      for (const [len, bucket] of index.byLength) {
        for (const cand of bucket) expect(cand.norm.length).toBe(len);
      }
    });

    it('빈 이름·공백뿐인 이름은 제외 — 아무거나 "유사" 로 걸리면 안 된다', () => {
      const withBlank = buildCompanyNameIndex(['카카오', '', '   ']);
      expect(withBlank.normalized.size).toBe(1);
      expect(withBlank.byLength.get(0)).toBeUndefined();
    });
  });

  describe('hasCompanyName', () => {
    it('정확히 있는 이름 → true', () => {
      expect(hasCompanyName('카카오', index)).toBe(true);
    });

    it('대소문자·앞뒤 공백만 다르면 같은 이름 → true', () => {
      expect(hasCompanyName('  lg에너지솔루션 ', index)).toBe(true);
    });

    it('목록 밖 이름 → false (오타든 비상장 실존이든 여기선 구분 안 함)', () => {
      expect(hasCompanyName('까까오', index)).toBe(false);
      expect(hasCompanyName('한솔로지스틱스', index)).toBe(false);
    });
  });

  describe('findSimilarCompanyName', () => {
    it('한 글자 오타 → 가장 가까운 실존 이름 제안', () => {
      expect(findSimilarCompanyName('까까오', index)).toBe('카카오');
      expect(findSimilarCompanyName('네이바', index)).toBe('네이버');
    });

    it('긴 이름은 편집거리 2까지 허용 (띄어쓰기·조사 오차)', () => {
      expect(findSimilarCompanyName('한국가스공산', index)).toBe(
        '한국가스공사',
      );
      expect(findSimilarCompanyName('현대 자동차', index)).toBe('현대자동차');
    });

    it('🔴 실존하는 이름이면 계산하지 않고 null — 제안이 필요 없는 행이다', () => {
      expect(findSimilarCompanyName('카카오', index)).toBeNull();
      expect(findSimilarCompanyName(' 삼성전자 ', index)).toBeNull();
    });

    it('🔴 명백히 먼 이름은 제안하지 않는다 — 엉뚱한 제안은 없느니만 못하다', () => {
      expect(findSimilarCompanyName('한솔로지스틱스', index)).toBeNull();
      expect(findSimilarCompanyName('우리동네작은회사', index)).toBeNull();
    });

    it('🔴 2글자 이하는 제안 안 함 — 한 글자만 달라도 다른 회사다 (토스↔포스)', () => {
      expect(findSimilarCompanyName('포스', index)).toBeNull();
      expect(findSimilarCompanyName('토', index)).toBeNull();
    });

    it('동점이면 항상 같은 이름 — 같은 입력에 제안이 흔들리면 안 된다', () => {
      const tie = buildCompanyNameIndex(['카가오', '가카오']);
      expect(findSimilarCompanyName('카카오', tie)).toBe('가카오');
      // 목록 순서를 뒤집어도 결과 동일
      const reversed = buildCompanyNameIndex(['가카오', '카가오']);
      expect(findSimilarCompanyName('카카오', reversed)).toBe('가카오');
    });

    it('제안은 companies.json 원본 표기 그대로 (정규화 소문자가 아님)', () => {
      expect(findSimilarCompanyName('LG에너지솔루숀', index)).toBe(
        'LG에너지솔루션',
      );
    });

    /**
     * 🔴 **가장 느슨한 임계 구간** — 자모 21개 이상이면 편집거리 4 까지 허용한다.
     * 여기가 오작동하면 「엉뚱한 제안」이 나오고, admin 이 그 제안을 믿고 **엉뚱한 회사를
     * 조사하게 된다**(이 도구를 만든 이유가 오타 회사를 걸러내는 것인데 정반대가 된다).
     * 분기 커버리지 실측에서 이 구간만 비어 있어 채웠다 (2026-08-23).
     */
    it('🔴 긴 이름(자모 21+) — 느슨한 임계에서도 오타는 잡고 남은 안 잡는다', () => {
      const long = buildCompanyNameIndex([
        '에이치디현대마린솔루션',
        '한국전력기술주식회사',
      ]);
      // 한 글자 오타(솔루션 → 솔류션)는 여전히 제안된다
      expect(findSimilarCompanyName('에이치디현대마린솔류션', long)).toBe(
        '에이치디현대마린솔루션',
      );
      // 🔴 길이가 비슷할 뿐 전혀 다른 이름은 제안하지 않는다 — 거리 4 가 남발되면 안 된다
      expect(
        findSimilarCompanyName('우리동네작은가게주식회사', long),
      ).toBeNull();
    });

    it('빈 인덱스 → null (companies.json 미로딩 환경 방어)', () => {
      expect(findSimilarCompanyName('카카오', buildCompanyNameIndex([]))).toBe(
        null,
      );
    });

    // 🔴 성능 — 3,798 규모에서 행마다 전수 비교하면 admin 표가 느려진다.
    it('대용량(3,798) — 길이 버킷 밖은 후보에서 빠진다', () => {
      const many = Array.from({ length: 3798 }, (_, i) => `회사${i}번지점`);
      const bigIndex = buildCompanyNameIndex([...many, '카카오']);
      // 길이 3 버킷엔 '카카오' 하나뿐 — 나머지 3,798개는 편집거리 계산 대상이 아니다
      expect(bigIndex.byLength.get(3)).toHaveLength(1);
      expect(findSimilarCompanyName('까까오', bigIndex)).toBe('카카오');
    });
  });
});
