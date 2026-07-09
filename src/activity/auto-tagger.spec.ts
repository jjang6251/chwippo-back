import { autoTag } from './auto-tagger';

describe('autoTag', () => {
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
    it('숫자 + 단위 없음 → quant=null', () => {
      expect(autoTag('123', 'other').quant).toBeNull();
    });
    it("'0% → 100% 달성' → before-after (v2: 단위 붙은 BA 지원)", () => {
      expect(autoTag('0% → 100% 달성', 'intern').quant).toMatchObject({
        type: 'before-after',
        before: '0',
        after: '100',
        unit: '%',
      });
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

  /**
   * v2 (2026-07-08) — 취준 실측 검토에서 나온 시나리오.
   * 케이스 원칙: 통과용이 아니라 "취준생이 실제로 쓰는 문장"에서 버그를 잡는 목록.
   */
  describe('v2 — 취준 카테고리 (코테·면접·지원)', () => {
    it("'그리디 5문제 풀었다' → coding_test + 📊 5문제", () => {
      const r = autoTag('그리디 5문제 풀었다', null);
      expect(r.cat).toBe('coding_test');
      expect(r.quant).toEqual({
        type: 'count',
        value: '5',
        unit: '문제',
        metric: '',
      });
    });
    it("'백준 골드 문제 3개 풂' → coding_test", () => {
      expect(autoTag('백준 골드 문제 3개 풂', null).cat).toBe('coding_test');
    });
    it("'삼성 코테 봤는데 2솔' → coding_test + 📊 2솔", () => {
      const r = autoTag('삼성 코테 봤는데 2솔', null);
      expect(r.cat).toBe('coding_test');
      expect(r.quant).toMatchObject({ value: '2', unit: '솔' });
    });
    it("'토스 1차 면접 봤다. 꼬리질문에서 말림' → interview + quant 없음 (차 오탐 제거)", () => {
      const r = autoTag('토스 1차 면접 봤다. 꼬리질문에서 말림', null);
      expect(r.cat).toBe('interview');
      expect(r.quant).toBeNull();
    });
    it("'모의면접 스터디 참여' → interview (면접 substring, 동점 시 interview 우선)", () => {
      expect(autoTag('모의면접 스터디 참여', null).cat).toBe('interview');
    });
    it("'카카오 자소서 1번 문항 초안 씀' → apply", () => {
      expect(autoTag('카카오 자소서 1번 문항 초안 씀', null).cat).toBe('apply');
    });
    it("'자기소개서 제출' → apply (interview 의 1분 자기소개와 미충돌)", () => {
      expect(autoTag('자기소개서 제출', null).cat).toBe('apply');
    });
    it("'네이버 서류 합격!' → apply", () => {
      expect(autoTag('네이버 서류 합격!', null).cat).toBe('apply');
    });
  });

  describe('v2 — learning 어학·자격증·스터디 확장', () => {
    it("'토익 900 목표로 LC 풀었다' → learning", () => {
      expect(autoTag('토익 900 목표로 LC 풀었다', null).cat).toBe('learning');
    });
    it("'정처기 실기 공부 3시간' → learning + 📊 3시간", () => {
      const r = autoTag('정처기 실기 공부 3시간', null);
      expect(r.cat).toBe('learning');
      expect(r.quant).toMatchObject({ value: '3', unit: '시간' });
    });
    it("'CS 스터디에서 네트워크 발표함' → 발표 인정 (presentation)", () => {
      // 스터디(learning) 1 vs 발표(presentation) 1 — 정의 순서상 presentation 우선
      expect(autoTag('CS 스터디에서 네트워크 발표함', null).cat).toBe(
        'presentation',
      );
    });
  });

  describe('v2 — 정규식 수정', () => {
    it("'전환율 2%→5% 개선' → before-after 탐지 (v1 버그)", () => {
      expect(autoTag('전환율 2%→5% 개선', null).quant).toMatchObject({
        type: 'before-after',
        before: '2',
        after: '5',
      });
    });
    it("'응답속도 300ms → 120ms 개선' → before-after", () => {
      expect(autoTag('응답속도 300ms → 120ms 개선', null).quant).toMatchObject({
        type: 'before-after',
        before: '300',
        after: '120',
      });
    });
    it("'주 3-4회 운동' → before-after 오탐 없음 (하이픈은 화살표 아님)", () => {
      const q = autoTag('주 3-4회 운동', null).quant;
      expect(q?.type).not.toBe('before-after');
    });
    it("'spring 강의 들었다' → learning (영문 부분 문자열 pr 오탐 제거)", () => {
      expect(autoTag('spring 강의 들었다', null).cat).toBe('learning');
    });
    it("'PR 올림' → develop (단독 영문 키워드는 여전히 매칭)", () => {
      expect(autoTag('PR 올림', null).cat).toBe('develop');
    });
  });

  describe('v2 — 부정 8자 lookahead', () => {
    it("'발표 준비 못했음' → presentation 미분류 (v1: 5자 창 밖이라 오분류)", () => {
      expect(autoTag('발표 준비 못했음', null).cat).toBeNull();
    });
    it("'갈등 없이 잘 끝남' → conflict_resolution 미분류", () => {
      expect(autoTag('갈등 없이 잘 끝남', null).cat).toBeNull();
    });
    it("'발표하지 않았다' → 미분류 ('않' 추가)", () => {
      expect(autoTag('발표하지 않았다', null).cat).toBeNull();
    });
  });

  describe('v2 — cl 내용 기반 (기본함 기록에도 소재)', () => {
    it("'공모전 탈락. 그래도 도전 자체가 배움' + type 없음 → challenge", () => {
      const r = autoTag('공모전 탈락. 그래도 도전 자체가 배움', null);
      expect(r.cl).toContain('challenge');
    });
    it("'팀원들과 같이 부스 운영' + type 없음 → collaboration", () => {
      const r = autoTag('팀원들과 같이 부스 운영', null);
      expect(r.cl).toContain('collaboration');
    });
    it("'API 구현하고 배포' + type 없음 → job_competency", () => {
      const r = autoTag('API 구현하고 배포', null);
      expect(r.cl).toContain('job_competency');
    });
    it('내용 + type fallback 병합·중복 제거·최대 3', () => {
      // club fallback = [collaboration, background], 내용 = challenge + collaboration
      const r = autoTag('처음으로 팀원들과 함께 도전', 'club');
      expect(r.cl.length).toBeLessThanOrEqual(3);
      expect(new Set(r.cl).size).toBe(r.cl.length);
      expect(r.cl).toContain('challenge');
      expect(r.cl).toContain('collaboration');
    });
    it("일상 문장 '도서관 감' → cl 없음 (오탐 없음)", () => {
      expect(autoTag('도서관 감', null).cl).toEqual([]);
    });
  });
});
