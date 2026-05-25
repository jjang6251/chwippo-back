import { autoTag } from './auto-tagger';

describe('autoTag (mock 1:1)', () => {
  describe('빈 content', () => {
    it("빈 + type='other' → 전부 null/빈 배열", () => {
      const r = autoTag('', 'other');
      expect(r).toEqual({
        cat: null,
        comps: [],
        quant: null,
        keywords: [],
        cl: [],
      });
    });

    it("빈 + type='intern' → cl=['job_competency']", () => {
      const r = autoTag('', 'intern');
      expect(r.cl).toEqual(['job_competency']);
      expect(r.cat).toBeNull();
    });

    it('null/undefined safe', () => {
      const r = autoTag(undefined as unknown as string, 'intern');
      expect(r.cl).toEqual(['job_competency']);
    });
  });

  describe('cat 감지', () => {
    it("'PR 머지' → cat='develop' (PR + 머지 모두 develop 키워드)", () => {
      expect(autoTag('PR 머지 완료', 'intern').cat).toBe('develop');
    });
    it("'발표 자료 만들기' → cat='presentation'", () => {
      expect(autoTag('발표 자료 만들기', 'intern').cat).toBe('presentation');
    });
    it("'갈등 풀어내기 중재 성공' → cat='conflict_resolution'", () => {
      expect(autoTag('갈등 풀어내기 중재 성공', 'intern').cat).toBe(
        'conflict_resolution',
      );
    });
    it("'#API #리팩터링 머지' → cat='develop' + keywords", () => {
      const r = autoTag('#API #리팩터링 머지', 'intern');
      expect(r.cat).toBe('develop');
      expect(r.keywords).toEqual(['API', '리팩터링']);
    });
    it("'고객 응대 cs 처리' → cat='customer'", () => {
      expect(autoTag('고객 응대 cs 처리', 'parttime').cat).toBe('customer');
    });
  });

  describe('comps 감지', () => {
    it("'주도적으로 운영 관리' + project → comps 에 'leadership'", () => {
      const r = autoTag('주도적으로 운영 관리 진행', 'project');
      expect(r.comps).toContain('leadership');
    });
    it("'기획 디자인 콘텐츠' → comps 에 'creativity' or 'planning'", () => {
      const r = autoTag('기획 디자인 콘텐츠 제작', 'sideproject');
      expect(r.comps.length).toBeGreaterThan(0);
    });
    it("'분석 데이터 인사이트' → comps 에 'analytical'", () => {
      const r = autoTag('분석 데이터 인사이트 도출', 'intern');
      expect(r.comps).toContain('analytical');
    });
    it('comps 최대 3개', () => {
      const r = autoTag(
        '리드 발표 분석 디자인 협업 책임 적응 데이터 기획 해결',
        'project',
      );
      expect(r.comps.length).toBeLessThanOrEqual(3);
    });
  });

  describe('quant 감지', () => {
    it("'5명' → count {value:5, unit:명}", () => {
      const r = autoTag('팀원 5명 모집', 'project');
      expect(r.quant).toEqual({
        type: 'count',
        value: '5',
        unit: '명',
        metric: '',
      });
    });
    it("'200건' → count {value:200, unit:건}", () => {
      const r = autoTag('처리 200건', 'parttime');
      expect(r.quant).toEqual({
        type: 'count',
        value: '200',
        unit: '건',
        metric: '',
      });
    });
    it("'1.2 → 1.8 개선' → before-after (unit 캡처는 mock 동작 그대로 — 한글 단어 그대로 들어감)", () => {
      const r = autoTag('ROAS 1.2 → 1.8 개선', 'intern');
      expect(r.quant).toMatchObject({
        type: 'before-after',
        before: '1.2',
        after: '1.8',
      });
    });
    it("숫자 + 단위 없음 → quant=null", () => {
      expect(autoTag('123', 'other').quant).toBeNull();
    });
    it("'0% → 100% 달성' → quant=null (% 가 BA regex 단위 자리에 안 맞아 매치 실패; mock 동작 그대로)", () => {
      expect(autoTag('0% → 100% 달성', 'intern').quant).toBeNull();
    });
  });

  describe('부정 표현 (5자 lookahead)', () => {
    it("'협업 안 했다' → collaboration 미포함", () => {
      const r = autoTag('협업 안 했다', 'project');
      expect(r.comps).not.toContain('collaboration');
    });
    it("'주도 못 했다' → leadership 미포함", () => {
      const r = autoTag('주도 못 했다', 'project');
      expect(r.comps).not.toContain('leadership');
    });
    it("'주도 진행' (부정 없음) → leadership 포함", () => {
      const r = autoTag('주도 진행 완료', 'project');
      expect(r.comps).toContain('leadership');
    });
    it("'협업 정말 잘 했다' (부정 없음) → collaboration 포함", () => {
      const r = autoTag('협업 정말 잘 했다', 'project');
      expect(r.comps).toContain('collaboration');
    });
  });

  describe('우선순위 / 엣지', () => {
    it('다중 cat 매칭 시 사전 순서 첫 매칭 (develop 가 analysis 보다 앞)', () => {
      const r = autoTag('머지 인사이트', 'intern');
      expect(r.cat).toBe('develop');
    });

    it('type 값이 enum 밖 → cl=[] (안전 fallback)', () => {
      const r = autoTag('아무 텍스트', 'invalid_type' as unknown as 'intern');
      expect(r.cl).toEqual([]);
    });

    it("type='other' + 본문 → cl=[]", () => {
      expect(autoTag('기획 회의 진행', 'other').cl).toEqual([]);
    });

    it('한글·영문 혼합 매칭 — API/머지 develop', () => {
      const r = autoTag('API 리팩터 진행', 'intern');
      expect(r.cat).toBe('develop');
    });
  });
});
