import {
  APPLICATION_TEMPLATES,
  APPLICATION_TEMPLATE_IDS,
  stepsForTemplate,
} from './application-templates';

describe('application-templates', () => {
  it('모든 템플릿은 "서류 제출"로 시작하고 "최종 합격"으로 끝난다', () => {
    for (const id of APPLICATION_TEMPLATE_IDS) {
      const steps = APPLICATION_TEMPLATES[id];
      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(steps[0]).toBe('서류 제출');
      expect(steps[steps.length - 1]).toBe('최종 합격');
    }
  });

  it('custom 은 general 과 동일한 스텝', () => {
    expect(APPLICATION_TEMPLATES.custom).toEqual(APPLICATION_TEMPLATES.general);
  });

  it('stepsForTemplate — 알려진 id 는 해당 스텝, 미지정·미존재는 general', () => {
    expect(stepsForTemplate('finance')).toEqual(APPLICATION_TEMPLATES.finance);
    expect(stepsForTemplate(undefined)).toEqual(APPLICATION_TEMPLATES.general);
    expect(stepsForTemplate(null)).toEqual(APPLICATION_TEMPLATES.general);
    expect(stepsForTemplate('does-not-exist')).toEqual(
      APPLICATION_TEMPLATES.general,
    );
  });
});
