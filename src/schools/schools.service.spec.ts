/**
 * SchoolsService autocomplete spec.
 *
 * cover: kind 별 데이터 분기 / prefix > contains 정렬 / limit cap / 빈 q top N /
 *        case insensitive / trim / max limit 20 / 전공 검색 / 결과 형태
 */
import { Test, TestingModule } from '@nestjs/testing';
import { SchoolsService } from './schools.service';

describe('SchoolsService', () => {
  let service: SchoolsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SchoolsService],
    }).compile();
    service = module.get(SchoolsService);
  });

  describe('autocompleteSchools', () => {
    it('kind=high — 고등학교 데이터에서만 검색', () => {
      const res = service.autocompleteSchools('high', '가락', 5);
      expect(res.length).toBeGreaterThan(0);
      expect(
        res.every(
          (r) => r.name.includes('고등학교') || r.name.includes('가락'),
        ),
      ).toBe(true);
      expect(res[0].name).toContain('가락');
    });

    it('kind=univ — 대학교 데이터에서만 검색', () => {
      const res = service.autocompleteSchools('univ', '서울대', 5);
      expect(res.some((r) => r.name === '서울대학교')).toBe(true);
    });

    it('prefix 매칭이 contains 보다 앞 순위', () => {
      const res = service.autocompleteSchools('univ', '서울', 10);
      const idxSeoul = res.findIndex((r) => r.name === '서울대학교');
      const idxNotPrefix = res.findIndex(
        (r) => r.name.includes('서울') && !r.name.startsWith('서울'),
      );
      if (idxSeoul >= 0 && idxNotPrefix >= 0) {
        expect(idxSeoul).toBeLessThan(idxNotPrefix);
      }
    });

    it('빈 q — 이름 순 상위 limit 반환', () => {
      const res = service.autocompleteSchools('univ', '', 5);
      expect(res.length).toBe(5);
    });

    it('undefined q — 빈 q 와 동일 동작', () => {
      const res = service.autocompleteSchools('univ', undefined, 3);
      expect(res.length).toBe(3);
    });

    it('limit 미지정 → default 10', () => {
      const res = service.autocompleteSchools('univ', '', undefined);
      expect(res.length).toBe(10);
    });

    it('limit 초과 (25) → cap 20 (service 내부)', () => {
      // controller DTO 는 20 max 이지만 service 는 방어적으로 cap
      const res = service.autocompleteSchools('univ', '', 25);
      expect(res.length).toBeLessThanOrEqual(20);
    });

    it('결과 shape — name·region 필수, address(high)·meta(univ) 옵셔널', () => {
      const high = service.autocompleteSchools('high', '', 1);
      expect(high[0]).toHaveProperty('name');
      expect(high[0]).toHaveProperty('region');
      // 고등학교 = NEIS address 있음
      expect(high[0].address).toBeDefined();

      const univ = service.autocompleteSchools('univ', '', 1);
      expect(univ[0]).toHaveProperty('name');
      expect(univ[0]).toHaveProperty('region');
      // 대학교 = meta 에 kind 담김
      expect(univ[0].meta).toBeDefined();
    });

    it('결과 없음 → 빈 배열', () => {
      const res = service.autocompleteSchools(
        'univ',
        'ZZZZ존재하지않는학교ZZZZ',
        10,
      );
      expect(res).toEqual([]);
    });

    it('case-insensitive (영문)', () => {
      const res = service.autocompleteSchools('univ', 'kaist', 5);
      expect(res.some((r) => r.name.toUpperCase() === 'KAIST')).toBe(true);
    });
  });

  describe('autocompleteCerts', () => {
    it('q 있음 — prefix > contains + popularity 순', () => {
      const res = service.autocompleteCerts('정보', 10);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].name.includes('정보')).toBe(true);
      // 정보처리기사 (popularity 100) 가 상위
      expect(res[0].name).toBe('정보처리기사');
    });

    it('빈 q → popularity 최상위 (자주 쓰는 자격증) 반환', () => {
      const res = service.autocompleteCerts('', 5);
      expect(res.length).toBe(5);
      // popularity 순 정렬 확인
      for (let i = 1; i < res.length; i++) {
        expect(res[i - 1].popularity).toBeGreaterThanOrEqual(res[i].popularity);
      }
    });

    it('결과에 issuer / hasNumber / validYears / category 포함', () => {
      const res = service.autocompleteCerts('정보처리기사', 1);
      expect(res[0].issuer).toBe('한국산업인력공단');
      expect(res[0].hasNumber).toBe(true);
      expect(res[0].validYears).toBeNull();
      expect(res[0].category).toBe('IT');
    });

    it('CCNA — validYears 3 (유효기간 있는 자격증)', () => {
      const res = service.autocompleteCerts('CCNA', 3);
      const ccna = res.find((c) => c.name === 'CCNA');
      expect(ccna?.validYears).toBe(3);
    });

    it('limit 초과 (25) → cap 20', () => {
      const res = service.autocompleteCerts('', 25);
      expect(res.length).toBeLessThanOrEqual(20);
    });

    it('결과 없음 → 빈 배열', () => {
      const res = service.autocompleteCerts('ZZZ존재하지않는자격증ZZZ', 10);
      expect(res).toEqual([]);
    });

    it('case-insensitive (영문)', () => {
      const res = service.autocompleteCerts('sqld', 3);
      expect(res.some((c) => c.name.startsWith('SQLD'))).toBe(true);
    });
  });

  describe('autocompleteLangCerts', () => {
    it('빈 q → TOEIC (popularity 100) 최상위', () => {
      const res = service.autocompleteLangCerts('', 3);
      expect(res[0].name).toBe('TOEIC');
    });

    it('JLPT — 자격증 명 하나 + grades 배열 (N1~N5)', () => {
      const res = service.autocompleteLangCerts('JLPT', 5);
      const jlpt = res.find((r) => r.name === 'JLPT');
      expect(jlpt).toBeDefined();
      expect(jlpt?.grades).toEqual(['N1', 'N2', 'N3', 'N4', 'N5']);
      expect(jlpt?.scoreType).toBe('grade');
    });

    it('TOEIC — scoreType number + scoreMax 990', () => {
      const toeic = service
        .autocompleteLangCerts('TOEIC', 5)
        .find((r) => r.name === 'TOEIC');
      expect(toeic?.scoreType).toBe('number');
      expect(toeic?.scoreMax).toBe(990);
      expect(toeic?.grades).toBeUndefined();
    });

    it('OPIc (영어) — grades 11개 등급', () => {
      const opic = service
        .autocompleteLangCerts('OPIc', 5)
        .find((r) => r.name === 'OPIc (영어)');
      expect(opic?.grades?.length).toBe(11);
      expect(opic?.grades).toContain('AL');
      expect(opic?.grades).toContain('IH');
      expect(opic?.grades).toContain('NL');
    });

    it('HSK — grades 6급 · language=chinese', () => {
      const hsk = service
        .autocompleteLangCerts('HSK', 5)
        .find((r) => r.name === 'HSK');
      expect(hsk?.language).toBe('chinese');
      expect(hsk?.grades).toEqual(['1급', '2급', '3급', '4급', '5급', '6급']);
    });

    it('결과 없음 → 빈 배열', () => {
      const res = service.autocompleteLangCerts('ZZZ어학ZZZ', 10);
      expect(res).toEqual([]);
    });
  });

  describe('findCertByName / findLangCertByName (canonical lookup)', () => {
    it('정확 매칭 시 카탈로그 항목 반환', () => {
      const c = service.findCertByName('정보처리기사');
      expect(c).not.toBeNull();
      expect(c?.issuer).toBe('한국산업인력공단');
    });

    it('공백 trim 후 매칭', () => {
      const c = service.findCertByName('  정보처리기사  ');
      expect(c).not.toBeNull();
    });

    it('없는 이름 → null (자유 입력으로 저장)', () => {
      expect(service.findCertByName('임의의자격증')).toBeNull();
      expect(service.findLangCertByName('임의어학')).toBeNull();
    });

    it('LangCert JLPT canonical 조회 (grades 배열)', () => {
      const lc = service.findLangCertByName('JLPT');
      expect(lc?.language).toBe('japanese');
      expect(lc?.grades).toEqual(['N1', 'N2', 'N3', 'N4', 'N5']);
    });
  });

  describe('autocompleteMajors', () => {
    it('q 있으면 관련 전공 반환', () => {
      const res = service.autocompleteMajors('컴퓨터', 10);
      expect(res.length).toBeGreaterThan(0);
      expect(res.every((m) => m.includes('컴퓨터'))).toBe(true);
    });

    it('prefix > contains 순서', () => {
      const res = service.autocompleteMajors('컴퓨터', 10);
      const idxCompCS = res.findIndex((m) => m.startsWith('컴퓨터'));
      const idxOtherContain = res.findIndex(
        (m) => m.includes('컴퓨터') && !m.startsWith('컴퓨터'),
      );
      if (idxCompCS >= 0 && idxOtherContain >= 0) {
        expect(idxCompCS).toBeLessThan(idxOtherContain);
      }
    });

    it('빈 q → 상위 limit 반환', () => {
      const res = service.autocompleteMajors('', 5);
      expect(res.length).toBe(5);
    });

    it('limit 미지정 → default 10', () => {
      const res = service.autocompleteMajors('', undefined);
      expect(res.length).toBe(10);
    });

    it('결과 없음 → 빈 배열', () => {
      const res = service.autocompleteMajors('ZZZ존재하지않는전공ZZZ', 10);
      expect(res).toEqual([]);
    });

    it('반환 형태 = string[]', () => {
      const res = service.autocompleteMajors('경영', 3);
      expect(Array.isArray(res)).toBe(true);
      expect(typeof res[0]).toBe('string');
    });
  });
});
