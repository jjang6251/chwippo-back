import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CompaniesService } from '../companies/companies.service';
import {
  buildCompanyNameIndex,
  hasCompanyName,
  normalizeCompanyName,
} from './utils/company-name-match';
import { JOB_CATEGORIES } from '../users/signup-job-categories.const';
import { APPLICATION_TEMPLATE_IDS } from '../applications/application-templates';

/**
 * 카드 입력 실태 — **사용자가 카드에 무엇을 실제로 채우는가**.
 *
 * ## 🔴 이 화면이 생긴 이유 — 로컬 DB 로 재던 것이 무효였다
 *
 * 2026-08-25 이전에는 이 질문을 **로컬 dev DB 를 뒤져서** 답했다. 그런데 로컬 카드 110장 중
 * 99장이 **CEO 본인이 테스트하며 만든 임의 입력**이었다. 「직무 표기가 5가지로 갈린다」
 * 「82% 가 채운다」 같은 진단이 전부 **한 사람의 타이핑 습관**이었던 셈이라, 사용자 행동
 * 근거로는 성립하지 않는다.
 *
 * 아래 쿼리의 `u.role <> 'admin'` 한 줄이 그 결함을 그대로 없앤다. 운영에서 돌리면 CEO 계정이
 * 자동으로 빠지고 진짜 사용자 카드만 남는다. **관측은 운영에서, admin 표면을 통해서 한다**
 * (운영 DB 직접 SQL 은 금지).
 *
 * ## 제외 규칙 3종 — `OpsReachService` 와 정확히 같다
 *
 * | 제외 | 안 빼면 |
 * |---|---|
 * | `u.role <> 'admin'` | **CEO 본인 카드**가 섞여 위 실수를 그대로 재생산한다 |
 * | `is_sample = false` | 🔴 온보딩 샘플은 `jobCategory` 는 채우고 `jobTitle` 은 **안 채운다** (`users.service.ts`). 안 빼면 **직군 채움률은 부풀고 직무 채움률은 깎여** 정반대 결론이 나온다 |
 * | `deleted_at IS NULL` | 지운 카드가 현재 실태로 잡힌다 |
 *
 * ## 🔴 이 화면이 답하지 못하는 것
 *
 * **「안 적는다」와 「적으려다 말았다」를 가르지 못한다.** DB 에는 포기한 흔적이 안 남는다 —
 * 직군 칩을 눌렀다 지운 사람과 아예 안 본 사람이 똑같이 `NULL` 로 보인다.
 * 그 축은 **Clarity 리플레이가 필요하고, 이 지표가 생겨도 대체되지 않는다.**
 *
 * ## % 를 만들지 않는다
 *
 * 분자·분모만 돌려주고 표기는 프론트가 정한다 (`OpsReachService` 와 같은 규칙).
 * 분모가 작을 때 % 가 혼자 돌아다니면 과대해석을 부른다.
 */

/** 직군 값이 **어느 사전에서 왔는가** — 한 컬럼에 여러 어휘가 섞여 있는지 본다 */
export type CategoryVocab =
  /** 현재 온보딩 21개 목록 (`JOB_CATEGORIES`) 에 있는 값 */
  | 'known'
  /** 목록엔 없지만 **다른 카드에서도 쓰인** 값 — 사용자가 직접 적었고 재사용된 어휘 */
  | 'freeform_repeated'
  /** 딱 한 장에서만 쓰인 자유 입력 */
  | 'freeform_once';

export interface FieldFill {
  /** 값이 있는(공백 제외) 카드 수 */
  filled: number;
}

export interface CategoryVocabBucket {
  vocab: CategoryVocab;
  /** 이 갈래에 속한 **서로 다른 값**의 개수 */
  distinctValues: number;
  /** 이 갈래가 붙은 카드 수 */
  cards: number;
}

export interface JobTitleVariantGroup {
  /** 한 사용자가 **같은 직무를 다르게 적은** 표기들 (`백엔드` · `백엔드 개발자`) */
  variants: string[];
}

export interface OpsCardFieldsResponse {
  /** 분모 — 실사용자가 직접 만든 카드 */
  cards: number;
  /** 그 카드를 가진 사용자 수 (가입자 전체가 아니다) */
  users: number;
  /** 조용히 빼면 합계가 안 맞아 보이므로 명시한다 */
  excluded: { adminCards: number; sampleCards: number };

  /** 필드별 채움 — 「직군 칩을 없애도 되나」의 근거 */
  fields: {
    jobTitle: FieldFill;
    jobCategory: FieldFill;
    jobUrl: FieldFill;
    memo: FieldFill;
  };

  /** 직군 컬럼에 어휘가 몇 갈래로 섞여 있나 */
  categoryVocab: {
    buckets: CategoryVocabBucket[];
    /** 많이 쓰인 순 상위 값 (관측자가 눈으로 확인하는 용도) */
    top: { value: string; cards: number; vocab: CategoryVocab }[];
  };

  /**
   * 직무 표기 흔들림 — **「자동완성이 답이다」의 유일한 직접 근거**.
   * 한 사람이 같은 직무를 여러 표기로 적고 있으면 확정, 아니면 그 가설은 접는다.
   */
  jobTitleVariance: {
    usersWithJobTitle: number;
    usersWithVariants: number;
    groups: JobTitleVariantGroup[];
  };

  /** 카드를 만들고 **결과까지 기록하나** */
  status: Record<string, number>;

  /** 스텝을 **실제로 옮기나** — 모바일 노드 터치 수리(v1.22.0)의 사후 관찰 */
  stepProgress: { atFirstStep: number; moved: number; noSteps: number };

  /** 회사명이 DART 사전(`companies.json`)에 있나 — 온보딩 보상을 진짜 회사로 바꾸는 근거 */
  companyMatch: {
    distinctNames: number;
    matchedNames: number;
    /** 사전 밖 이름 상위 (오타·비상장·병원·관공서 판별용) */
    topUnmatched: { name: string; cards: number }[];
  };

  /**
   * 관측 컬럼 2종 — **2026-08-25 도입**이라 그 이전 카드는 전부 `recorded: 0` 이다.
   * 값이 쌓이기 시작하는 시점이 도입일이므로, 초기에 0 이 나오는 것은 결함이 아니다.
   */
  templateId: { recorded: number; distribution: Record<string, number> };
  createdVia: { recorded: number; distribution: Record<string, number> };

  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/** 표시용 상한 — 관측자가 눈으로 훑는 목록이라 길어지면 못 읽는다 (집계는 전수 기준) */
const TOP_LIMIT = 20;
const VARIANT_GROUP_LIMIT = 30;

interface AggRow {
  cards: string;
  users: string;
  job_title: string;
  job_category: string;
  job_url: string;
  memo: string;
  at_first_step: string;
  moved: string;
  no_steps: string;
}

interface DetailRow {
  user_id: string;
  job_title: string | null;
  job_category: string | null;
  company_name: string;
  status: string;
  template_id: string | null;
  created_via: string | null;
}

/**
 * 표기 비교용 정규화 — **공백·구두점·대소문자만** 지운다.
 *
 * 🔴 어간 추출이나 동의어 사전을 쓰지 않는다. `백엔드` 와 `서버` 를 같은 직무로 접으려면
 * 판단이 들어가고, 그 판단이 틀리면 **없는 흔들림을 만들어낸다.** 여기서 찾으려는 것은
 * "같은 말을 다르게 적었나" 이므로 표기 수준 비교로 충분하다.
 */
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[\s·・.,/()[\]{}-]/g, '');
}

/**
 * 두 표기가 **같은 직무의 다른 표기인가** — 한쪽이 다른 쪽을 포함하면 그렇다고 본다.
 * (`백엔드` ⊂ `백엔드개발자`). 서로 무관한 두 직무를 지원한 사람은 여기 안 걸린다.
 */
function isVariantOf(a: string, b: string): boolean {
  return a !== b && (a.includes(b) || b.includes(a));
}

@Injectable()
export class OpsCardFieldsService {
  private cache: { data: OpsCardFieldsResponse; at: number } | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly companies: CompaniesService,
  ) {}

  /**
   * @param force 캐시를 건너뛰고 다시 집계한다.
   *
   * 🔴 **탈출구가 없는 캐시는 「값이 안 변했다」와 「새로 안 읽었다」를 구분 불가능하게 만든다.**
   * 실제로 그랬다 — 카드를 만들고 화면을 다시 열었는데 `generatedAt` 이 글자 하나까지 같아서
   * 「배선이 끊겼나」로 읽혔다. 배선은 멀쩡했고 5분 캐시가 답한 것뿐이었다.
   *
   * 이 화면은 제품 결정의 근거라 **방금 반영된 변화를 못 봤다는 사실 자체를 모르는 상태**가
   * 가장 비싸다. 캐시는 반복 집계를 막는 값어치가 있으니 유지하되, 관리자가 명시적으로
   * 뚫을 수 있게 한다 (admin 전용 + 쿼리 2회짜리 집계라 남용 위험이 없다).
   */
  async getCardFields(force = false): Promise<OpsCardFieldsResponse> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.data;
    }
    const data = await this.compute();
    this.cache = { data, at: Date.now() };
    return data;
  }

  /** 테스트·수동 갱신용 */
  resetCache(): void {
    this.cache = null;
  }

  private async compute(): Promise<OpsCardFieldsResponse> {
    const [aggRows, detailRows, excludedRows] = await Promise.all([
      this.dataSource.query<AggRow[]>(`
        SELECT COUNT(*)::int                                        AS cards,
               COUNT(DISTINCT a.user_id)::int                       AS users,
               COUNT(*) FILTER (WHERE NULLIF(TRIM(a.job_title), '')    IS NOT NULL)::int AS job_title,
               COUNT(*) FILTER (WHERE NULLIF(TRIM(a.job_category), '') IS NOT NULL)::int AS job_category,
               COUNT(*) FILTER (WHERE NULLIF(TRIM(a.job_url), '')      IS NOT NULL)::int AS job_url,
               COUNT(*) FILTER (WHERE NULLIF(TRIM(a.memo), '')         IS NOT NULL)::int AS memo,
               -- 스텝 진행: 스텝이 아예 없는 카드(PLANNED)와 0번에 머문 카드를 가른다.
               -- 둘을 합치면 "안 옮겼다" 가 부풀어 터치 수리 효과를 못 본다.
               COUNT(*) FILTER (WHERE s.n > 0 AND a.current_step_index = 0)::int AS at_first_step,
               COUNT(*) FILTER (WHERE s.n > 0 AND a.current_step_index > 0)::int AS moved,
               COUNT(*) FILTER (WHERE COALESCE(s.n, 0) = 0)::int                 AS no_steps
          FROM applications a
          JOIN users u ON u.id = a.user_id AND u.role <> 'admin'
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS n FROM application_steps st
             WHERE st.application_id = a.id
          ) s ON TRUE
         WHERE a.deleted_at IS NULL AND a.is_sample = false
      `),
      // 어휘·표기·회사명 판정은 SQL 보다 코드가 정확하다 (포함 관계·사전 대조).
      // admin 전용 + 5분 캐시라 전 행을 끌어와도 되지만, 카드가 수만 장이 되면
      // 여기부터 손봐야 한다 (그때는 어휘 집계를 SQL GROUP BY 로 내린다).
      this.dataSource.query<DetailRow[]>(`
        SELECT a.user_id, a.job_title, a.job_category, a.company_name,
               a.status, a.template_id, a.created_via
          FROM applications a
          JOIN users u ON u.id = a.user_id AND u.role <> 'admin'
         WHERE a.deleted_at IS NULL AND a.is_sample = false
      `),
      this.dataSource.query<{ admin_cards: string; sample_cards: string }[]>(`
        SELECT COUNT(*) FILTER (WHERE u.role = 'admin')::int    AS admin_cards,
               COUNT(*) FILTER (WHERE a.is_sample = true)::int  AS sample_cards
          FROM applications a
          JOIN users u ON u.id = a.user_id
         WHERE a.deleted_at IS NULL
      `),
    ]);

    const agg = aggRows[0];
    const n = (v: string | number | undefined) => Number(v ?? 0);

    return {
      cards: n(agg?.cards),
      users: n(agg?.users),
      excluded: {
        adminCards: n(excludedRows[0]?.admin_cards),
        sampleCards: n(excludedRows[0]?.sample_cards),
      },
      fields: {
        jobTitle: { filled: n(agg?.job_title) },
        jobCategory: { filled: n(agg?.job_category) },
        jobUrl: { filled: n(agg?.job_url) },
        memo: { filled: n(agg?.memo) },
      },
      categoryVocab: this.analyzeCategoryVocab(detailRows),
      jobTitleVariance: this.analyzeJobTitleVariance(detailRows),
      status: countBy(detailRows, (r) => r.status),
      stepProgress: {
        atFirstStep: n(agg?.at_first_step),
        moved: n(agg?.moved),
        noSteps: n(agg?.no_steps),
      },
      companyMatch: this.analyzeCompanyMatch(detailRows),
      templateId: this.analyzeRecorded(
        detailRows,
        (r) => r.template_id,
        APPLICATION_TEMPLATE_IDS,
      ),
      createdVia: this.analyzeRecorded(detailRows, (r) => r.created_via),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 직군 값이 21개 목록에서 왔나, 사용자가 적은 말인가.
   *
   * 🔴 `freeform_repeated` 와 `freeform_once` 를 가르는 이유 — 둘의 뜻이 정반대다.
   * 여러 카드에서 반복되는 자유 입력은 **목록에 넣어야 할 직군**이고 (「간호사」가 계속 나오면
   * 목록의 구멍이다), 한 번만 나온 값은 그냥 그 사람의 표현이다. 뭉쳐 세면 그 신호가 사라진다.
   */
  private analyzeCategoryVocab(
    rows: DetailRow[],
  ): OpsCardFieldsResponse['categoryVocab'] {
    const known = new Set<string>(JOB_CATEGORIES);
    const perValue = new Map<string, number>();

    for (const r of rows) {
      // 직군은 다중 선택이라 콤마로 직렬화돼 저장된다 (`serializeTags`).
      // 통째로 세면 "백엔드 개발,데이터·AI" 가 하나의 미지 어휘로 잡힌다.
      for (const raw of (r.job_category ?? '').split(',')) {
        const v = raw.trim();
        if (v) perValue.set(v, (perValue.get(v) ?? 0) + 1);
      }
    }

    const classify = (value: string, cards: number): CategoryVocab =>
      known.has(value)
        ? 'known'
        : cards > 1
          ? 'freeform_repeated'
          : 'freeform_once';

    const buckets = new Map<
      CategoryVocab,
      { distinctValues: number; cards: number }
    >();
    for (const [value, cards] of perValue) {
      const vocab = classify(value, cards);
      const b = buckets.get(vocab) ?? { distinctValues: 0, cards: 0 };
      b.distinctValues += 1;
      b.cards += cards;
      buckets.set(vocab, b);
    }

    const order: CategoryVocab[] = [
      'known',
      'freeform_repeated',
      'freeform_once',
    ];
    return {
      buckets: order.map((vocab) => ({
        vocab,
        distinctValues: buckets.get(vocab)?.distinctValues ?? 0,
        cards: buckets.get(vocab)?.cards ?? 0,
      })),
      top: [...perValue.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_LIMIT)
        .map(([value, cards]) => ({
          value,
          cards,
          vocab: classify(value, cards),
        })),
    };
  }

  /**
   * 같은 사용자가 같은 직무를 여러 표기로 적었나.
   *
   * 🔴 **사용자별로 본다.** 전체를 뭉뚱그리면 「백엔드」와 「백엔드 개발자」가 서로 다른
   * 두 사람의 표현일 뿐인데도 흔들림으로 잡힌다 — 그건 자동완성으로 해결되는 문제가 아니다.
   * 한 사람 안에서 갈릴 때만 「같은 걸 다시 적다가 다르게 적었다」가 성립한다.
   *
   * userId 는 응답에 담지 않는다 — 이 화면은 "얼마나 흔들리나" 만 필요하고,
   * 개별 신원이 필요하면 `/ops/users/:id` 로 넘어간다 (`OpsReachService` 와 같은 판단).
   */
  private analyzeJobTitleVariance(
    rows: DetailRow[],
  ): OpsCardFieldsResponse['jobTitleVariance'] {
    const byUser = new Map<string, Set<string>>();
    for (const r of rows) {
      const t = (r.job_title ?? '').trim();
      if (!t) continue;
      const set = byUser.get(r.user_id) ?? new Set<string>();
      set.add(t);
      byUser.set(r.user_id, set);
    }

    const groups: JobTitleVariantGroup[] = [];
    let usersWithVariants = 0;

    for (const titles of byUser.values()) {
      const norm = [...titles].map((raw) => ({
        raw,
        key: normalizeTitle(raw),
      }));
      const used = new Set<number>();
      let found = false;

      for (let i = 0; i < norm.length; i++) {
        if (used.has(i)) continue;
        const group = [norm[i].raw];
        for (let j = i + 1; j < norm.length; j++) {
          if (used.has(j)) continue;
          if (
            norm[i].key === norm[j].key ||
            isVariantOf(norm[i].key, norm[j].key)
          ) {
            group.push(norm[j].raw);
            used.add(j);
          }
        }
        if (group.length > 1) {
          found = true;
          if (groups.length < VARIANT_GROUP_LIMIT)
            groups.push({ variants: group });
        }
      }
      if (found) usersWithVariants += 1;
    }

    return { usersWithJobTitle: byUser.size, usersWithVariants, groups };
  }

  /** 회사명이 DART 사전에 있나 — `company-research-status` 와 같은 인덱스·정규화를 쓴다 */
  private analyzeCompanyMatch(
    rows: DetailRow[],
  ): OpsCardFieldsResponse['companyMatch'] {
    const index = buildCompanyNameIndex(this.companies.getAllNames());
    const perName = new Map<string, { name: string; cards: number }>();

    for (const r of rows) {
      const name = r.company_name.trim();
      if (!name) continue;
      // 🔴 `normalizeCompanyName` = trim + lowercase **뿐이다.** 내부 공백은 안 지운다
      //    (`서울대학교병원` ≠ `서울대학교 병원`). 더 세게 접고 싶은 유혹이 있지만,
      //    이건 조사 캐시·지원 카드 병합이 쓰는 **시스템 공용 키**라 여기서만 규칙을
      //    바꾸면 이 화면 숫자만 다른 화면과 어긋난다. 표기 흔들림은 어차피 둘 다
      //    「사전 밖」으로 잡히므로 이 질문(사전이 현실을 덮나)의 답은 안 바뀐다.
      const key = normalizeCompanyName(name);
      const hit = perName.get(key);
      if (hit) hit.cards += 1;
      else perName.set(key, { name, cards: 1 });
    }

    const unmatched = [...perName.values()].filter(
      (e) => !hasCompanyName(e.name, index),
    );

    return {
      distinctNames: perName.size,
      matchedNames: perName.size - unmatched.length,
      topUnmatched: unmatched
        .sort((a, b) => b.cards - a.cards || a.name.localeCompare(b.name))
        .slice(0, TOP_LIMIT),
    };
  }

  /**
   * 관측 컬럼(`template_id`·`created_via`)의 기록 현황.
   *
   * `recorded` 를 따로 세는 이유 — 이 컬럼들은 2026-08-25 도입이라 **그 이전 카드는 전부
   * `NULL`** 이다. 분포만 보면 "아무도 안 쓴다" 로 오독되므로, **분모가 몇 장인지**를
   * 같이 준다. 백필하지 않기로 한 결정이라 `NULL` 은 "모른다" 라는 정확한 정보다.
   *
   * `expected` 를 받으면 **한 번도 안 나온 값도 0 으로 채운다** — 없는 항목이 표에서
   * 통째로 사라지면 "그 템플릿이 안 쓰인다" 를 볼 수가 없다.
   */
  private analyzeRecorded(
    rows: DetailRow[],
    pick: (r: DetailRow) => string | null,
    expected?: readonly string[],
  ): { recorded: number; distribution: Record<string, number> } {
    const distribution: Record<string, number> = {};
    for (const key of expected ?? []) distribution[key] = 0;

    let recorded = 0;
    for (const r of rows) {
      const v = pick(r);
      if (!v) continue;
      recorded += 1;
      distribution[v] = (distribution[v] ?? 0) + 1;
    }
    return { recorded, distribution };
  }
}

function countBy<T>(rows: T[], pick: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = pick(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
