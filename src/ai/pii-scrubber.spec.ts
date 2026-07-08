import { scrubJsonOutputPii, scrubOutputPii, scrubPii } from './pii-scrubber';

describe('pii-scrubber', () => {
  describe('정규식 패턴 12종', () => {
    it('한국 휴대전화 (010-1234-5678 / 01012345678 / 010 1234 5678) → [REDACTED_PHONE]', () => {
      const cases = ['010-1234-5678', '01012345678', '010 1234 5678'];
      for (const c of cases) {
        const r = scrubPii(`연락처는 ${c} 입니다`);
        expect(r.text).toContain('[REDACTED_PHONE]');
        expect(r.text).not.toContain(c);
        expect(r.hasPii).toBe(true);
        expect(r.detected['phone_kr_mobile']).toBe(1);
      }
    });

    it('한국 지역 유선 (02-123-4567) → [REDACTED_PHONE]', () => {
      const r = scrubPii('회사 02-123-4567 전화');
      expect(r.text).toContain('[REDACTED_PHONE]');
      expect(r.detected['phone_kr_landline']).toBe(1);
    });

    it('국제 전화 +82-10-1234-5678 → [REDACTED_PHONE]', () => {
      const r = scrubPii('해외 +82-10-1234-5678 입니다');
      expect(r.text).toContain('[REDACTED_PHONE]');
      expect(r.detected['phone_kr_intl']).toBe(1);
    });

    it('이메일 → [REDACTED_EMAIL]', () => {
      const r = scrubPii('연락: jjang6251@gmail.com 주세요');
      expect(r.text).toContain('[REDACTED_EMAIL]');
      expect(r.text).not.toContain('jjang6251@gmail.com');
      expect(r.detected['email']).toBe(1);
    });

    it('주민번호 (990101-1234567) → [REDACTED_RRN]', () => {
      const r = scrubPii('주민번호 990101-1234567 임');
      expect(r.text).toContain('[REDACTED_RRN]');
      expect(r.detected['rrn']).toBe(1);
    });

    it('신용카드 16자리 → [REDACTED_CARD]', () => {
      const r = scrubPii('카드 1234-5678-9012-3456');
      expect(r.text).toContain('[REDACTED_CARD]');
      expect(r.detected['credit_card']).toBe(1);
    });

    it('instagram handle (@user) → [REDACTED_SNS]', () => {
      const r = scrubPii('인스타 @jjang_dev 팔로우');
      expect(r.text).toContain('[REDACTED_SNS]');
      expect(r.text).not.toContain('@jjang_dev');
      expect(r.detected['instagram_handle']).toBe(1);
    });

    it('GitHub URL → github.com/[REDACTED_USER]', () => {
      const r = scrubPii('포폴 github.com/jjang6251 입니다');
      expect(r.text).toContain('github.com/[REDACTED_USER]');
      expect(r.text).not.toContain('jjang6251');
      expect(r.detected['github_username']).toBe(1);
    });

    it('Instagram URL → instagram.com/[REDACTED_USER]', () => {
      const r = scrubPii('instagram.com/jjang_dev 봐주세요');
      expect(r.text).toContain('instagram.com/[REDACTED_USER]');
      expect(r.detected['instagram_url']).toBe(1);
    });

    it('카카오톡 오픈채팅 URL → [REDACTED_KAKAO]', () => {
      const r = scrubPii('오픈채팅 open.kakao.com/o/abc123 들어와');
      expect(r.text).toContain('[REDACTED_KAKAO]');
      expect(r.text).not.toContain('open.kakao.com/o/abc123');
      expect(r.detected['kakao_open']).toBe(1);
    });

    it('Twitter / X URL → [REDACTED_SNS]', () => {
      const r1 = scrubPii('twitter.com/elonmusk');
      const r2 = scrubPii('x.com/elonmusk');
      expect(r1.text).toContain('[REDACTED_SNS]');
      expect(r2.text).toContain('[REDACTED_SNS]');
    });

    it('LinkedIn 개인 프로필 → linkedin.com/in/[REDACTED_USER]', () => {
      const r = scrubPii('linkedin.com/in/jjang-sw 봐주세요');
      expect(r.text).toContain('linkedin.com/in/[REDACTED_USER]');
      expect(r.text).not.toContain('jjang-sw');
      expect(r.detected['linkedin_url']).toBe(1);
    });
  });

  describe('사용자 본인 이름 블랙리스트', () => {
    it('정확히 일치하는 이름만 치환 (false positive 방지)', () => {
      const r = scrubPii('박은빈 인턴 다녀왔습니다', {
        blacklistedNames: ['박은빈'],
      });
      expect(r.text).toBe('[REDACTED_NAME] 인턴 다녀왔습니다');
      expect(r.detected['user_name']).toBe(1);
    });

    it('1글자 이름은 무시 (false positive 위험)', () => {
      const r = scrubPii('박 다녀왔습니다', { blacklistedNames: ['박'] });
      // 1글자는 skip → 그대로
      expect(r.text).toBe('박 다녀왔습니다');
      expect(r.detected['user_name']).toBeUndefined();
    });

    it('빈 blacklistedNames 또는 미지정 → 이름 치환 없음', () => {
      const r1 = scrubPii('박은빈 인턴', { blacklistedNames: [] });
      const r2 = scrubPii('박은빈 인턴');
      expect(r1.text).toBe('박은빈 인턴');
      expect(r2.text).toBe('박은빈 인턴');
    });

    it('정규식 메타문자 포함 이름도 안전하게 이스케이프', () => {
      // ".+" 같은 메타 문자가 이름에 들어와도 정확 매치만
      const r = scrubPii('test.+ 인턴 test 가 아니라', {
        blacklistedNames: ['test.+'],
      });
      expect(r.text).toContain('[REDACTED_NAME]');
      // 'test' 단독은 매치 안 됨
      expect(r.text).toContain('test 가');
    });

    it('한 텍스트에 여러 번 등장 시 모두 치환 + 카운트 정확', () => {
      const r = scrubPii('박은빈입니다. 박은빈은 인턴.', {
        blacklistedNames: ['박은빈'],
      });
      expect(r.detected['user_name']).toBe(2);
      expect(r.text).not.toContain('박은빈');
    });
  });

  describe('복합 / 엣지', () => {
    it('PII 없음 → hasPii=false', () => {
      const r = scrubPii('자소서 쓰는 중이에요');
      expect(r.hasPii).toBe(false);
      expect(r.detected).toEqual({});
    });

    it('빈 텍스트 → 안전 처리', () => {
      const r = scrubPii('');
      expect(r.text).toBe('');
      expect(r.hasPii).toBe(false);
    });

    it('한 텍스트에 여러 PII 종류 → 모두 치환 + detected에 각 패턴 카운트', () => {
      const r = scrubPii(
        '문의: jjang@gmail.com / 010-1234-5678 / github.com/jjang6251',
        { blacklistedNames: ['장성원'] },
      );
      expect(r.text).toContain('[REDACTED_EMAIL]');
      expect(r.text).toContain('[REDACTED_PHONE]');
      expect(r.text).toContain('github.com/[REDACTED_USER]');
      expect(r.detected['email']).toBe(1);
      expect(r.detected['phone_kr_mobile']).toBe(1);
      expect(r.detected['github_username']).toBe(1);
    });

    it('단순 URL (회사 도메인) 은 보존 — github/instagram/linkedin 외 일반 URL', () => {
      const r = scrubPii('회사 https://naver.com 검색');
      expect(r.text).toContain('https://naver.com');
      expect(r.hasPii).toBe(false);
    });

    it('scrubOutputPii: 응답 hallucination PII 차단', () => {
      const r = scrubOutputPii(
        '담당자 연락처는 010-9999-8888 이메일 fake@x.com 입니다',
      );
      expect(r.text).toContain('[REDACTED_PHONE]');
      expect(r.text).toContain('[REDACTED_EMAIL]');
      expect(r.hasPii).toBe(true);
    });

    it('scrubOutputPii: PII 없는 응답 → 원본 그대로', () => {
      const r = scrubOutputPii('일반 요약 텍스트 입니다');
      expect(r.text).toBe('일반 요약 텍스트 입니다');
      expect(r.hasPii).toBe(false);
    });
  });

  describe('scrubJsonOutputPii — 구조화 json 채널', () => {
    it('중첩 객체·배열 안의 문자열도 모두 스크럽 (재귀)', () => {
      const input = {
        reply: '담당자 010-9999-8888 로 연락하세요',
        suggestedUpdates: [
          { field: 'intro', target: '메일 fake@x.com 참고', note: '수정' },
          { field: 'body', target: '일반 텍스트' },
        ],
        meta: { author: { contact: 'github.com/hallucinated' } },
      };
      const r = scrubJsonOutputPii(input);
      expect(r.hasPii).toBe(true);
      expect(r.value.reply).toContain('[REDACTED_PHONE]');
      expect(r.value.reply).not.toContain('010-9999-8888');
      expect(r.value.suggestedUpdates[0].target).toContain('[REDACTED_EMAIL]');
      expect(r.value.suggestedUpdates[1].target).toBe('일반 텍스트');
      expect(r.value.meta.author.contact).toContain(
        'github.com/[REDACTED_USER]',
      );
    });

    it('PII 없으면 hasPii=false + 원본 불변 (deep copy 는 하되 값 동일)', () => {
      const input = {
        reply: '자소서 잘 쓰고 있어요',
        items: ['첫째', '둘째'],
        score: 7,
      };
      const snapshot = JSON.parse(JSON.stringify(input));
      const r = scrubJsonOutputPii(input);
      expect(r.hasPii).toBe(false);
      expect(r.value).toEqual(input);
      // 원본 변형 금지
      expect(input).toEqual(snapshot);
    });

    it('비문자열 타입(number·boolean·null·undefined) 보존', () => {
      const input = {
        n: 42,
        b: true,
        nil: null,
        undef: undefined,
        arr: [1, false, null],
      };
      const r = scrubJsonOutputPii(input);
      expect(r.hasPii).toBe(false);
      expect(r.value.n).toBe(42);
      expect(r.value.b).toBe(true);
      expect(r.value.nil).toBeNull();
      expect(r.value.undef).toBeUndefined();
      expect(r.value.arr).toEqual([1, false, null]);
    });
  });
});
