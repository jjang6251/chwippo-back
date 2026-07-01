import { Injectable } from '@nestjs/common';
import type { SchoolKind } from './dto/school-autocomplete-query.dto';
import schoolsHighData from '../data/schools-high.json';
import schoolsUnivData from '../data/schools-univ.json';
import majorsData from '../data/majors.json';
import certsData from '../data/certs.json';
import langCertsData from '../data/lang-certs.json';

interface HighSchool {
  name: string;
  region: string;
  address?: string;
  code?: string;
}

interface UnivSchool {
  name: string;
  region: string;
  kind: string; // '4년제' | '전문대' | '교육대' | '사이버' | '특수'
}

export interface SchoolSuggestion {
  name: string;
  region: string;
  address?: string;
  meta?: string;
}

/**
 * 자격증 카탈로그 항목.
 * - hasNumber: 자격번호 필드 유무 (false 시 프론트에서 hide + 저장 dto 에서 확실히 제외)
 * - validYears: 유효기간 (null=평생 유효)
 * - popularity: 정렬 우선순위 (자주 쓰는 top 30 = 100+ / 하위 5~10)
 * - category: chip 표시 + 통계 분류
 */
export interface CertSuggestion {
  name: string;
  issuer: string;
  hasNumber: boolean;
  numberExample?: string;
  validYears: number | null;
  category: string;
  popularity: number;
}

/**
 * 어학 자격증 카탈로그 항목.
 * - name: 자격증 종류 (OPIc (영어) · JLPT · HSK 등 — 등급 X)
 * - grades: 등급형 자격증의 선택 가능 등급 배열 (JLPT N1~N5, HSK 1~6급, DELE A1~C2, OPIc 등급 등)
 * - scoreType: 'number' (TOEIC=990) | 'grade' (등급 select)
 * - scoreMax: number 형 score 의 만점 (TOEIC=990, IELTS=9)
 * - language: 통계용 (english, japanese, chinese, ...)
 */
export interface LangCertSuggestion {
  name: string;
  language: string;
  issuer: string;
  scoreType: 'number' | 'grade';
  scoreMax?: number;
  grades?: string[];
  scoreExample: string;
  validYears: number | null;
  category: string;
  popularity: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

@Injectable()
export class SchoolsService {
  private readonly highs: HighSchool[] = schoolsHighData;
  private readonly univs: UnivSchool[] = schoolsUnivData;
  private readonly majors: string[] = majorsData;
  private readonly certs: CertSuggestion[] = certsData;
  private readonly langCerts: LangCertSuggestion[] =
    langCertsData as LangCertSuggestion[];

  /**
   * 학교명 자동완성.
   * - q 빈값 → 이름 순 상위 limit
   * - q 있으면 prefix > contains 순으로 정렬
   */
  autocompleteSchools(
    kind: SchoolKind,
    q: string | undefined,
    limitInput: number | undefined,
  ): SchoolSuggestion[] {
    const limit = Math.min(limitInput ?? DEFAULT_LIMIT, MAX_LIMIT);
    const source = kind === 'high' ? this.highs : this.univs;
    const query = (q ?? '').trim();

    const toSuggestion = (s: HighSchool | UnivSchool): SchoolSuggestion => ({
      name: s.name,
      region: s.region,
      address: 'address' in s ? s.address : undefined,
      meta: 'kind' in s ? s.kind : undefined,
    });

    if (query.length === 0) {
      return source.slice(0, limit).map(toSuggestion);
    }

    const lower = query.toLowerCase();
    const prefix: SchoolSuggestion[] = [];
    const contains: SchoolSuggestion[] = [];

    for (const s of source) {
      const nameLower = s.name.toLowerCase();
      if (nameLower.startsWith(lower)) {
        prefix.push(toSuggestion(s));
      } else if (nameLower.includes(lower)) {
        contains.push(toSuggestion(s));
      }
      if (prefix.length + contains.length >= MAX_LIMIT * 3) break;
    }

    return [...prefix, ...contains].slice(0, limit);
  }

  /**
   * 전공 자동완성.
   */
  autocompleteMajors(
    q: string | undefined,
    limitInput: number | undefined,
  ): string[] {
    const limit = Math.min(limitInput ?? DEFAULT_LIMIT, MAX_LIMIT);
    const query = (q ?? '').trim();

    if (query.length === 0) {
      return this.majors.slice(0, limit);
    }

    const lower = query.toLowerCase();
    const prefix: string[] = [];
    const contains: string[] = [];

    for (const m of this.majors) {
      const lm = m.toLowerCase();
      if (lm.startsWith(lower)) prefix.push(m);
      else if (lm.includes(lower)) contains.push(m);
      if (prefix.length + contains.length >= MAX_LIMIT * 3) break;
    }

    return [...prefix, ...contains].slice(0, limit);
  }

  /**
   * 자격증 자동완성.
   * - 정렬 우선: popularity DESC (자주 쓰는 top 20)
   * - q 있으면 prefix > contains, 각 그룹 내 popularity DESC
   */
  autocompleteCerts(
    q: string | undefined,
    limitInput: number | undefined,
  ): CertSuggestion[] {
    const limit = Math.min(limitInput ?? DEFAULT_LIMIT, MAX_LIMIT);
    const query = (q ?? '').trim();

    if (query.length === 0) {
      return [...this.certs]
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, limit);
    }

    const lower = query.toLowerCase();
    const prefix: CertSuggestion[] = [];
    const contains: CertSuggestion[] = [];

    for (const c of this.certs) {
      const nameLower = c.name.toLowerCase();
      if (nameLower.startsWith(lower)) prefix.push(c);
      else if (nameLower.includes(lower)) contains.push(c);
    }

    // 각 그룹 내 popularity DESC
    prefix.sort((a, b) => b.popularity - a.popularity);
    contains.sort((a, b) => b.popularity - a.popularity);

    return [...prefix, ...contains].slice(0, limit);
  }

  /**
   * 어학 자격증 자동완성.
   */
  autocompleteLangCerts(
    q: string | undefined,
    limitInput: number | undefined,
  ): LangCertSuggestion[] {
    const limit = Math.min(limitInput ?? DEFAULT_LIMIT, MAX_LIMIT);
    const query = (q ?? '').trim();

    if (query.length === 0) {
      return [...this.langCerts]
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, limit);
    }

    const lower = query.toLowerCase();
    const prefix: LangCertSuggestion[] = [];
    const contains: LangCertSuggestion[] = [];

    for (const c of this.langCerts) {
      const nameLower = c.name.toLowerCase();
      if (nameLower.startsWith(lower)) prefix.push(c);
      else if (nameLower.includes(lower)) contains.push(c);
    }

    prefix.sort((a, b) => b.popularity - a.popularity);
    contains.sort((a, b) => b.popularity - a.popularity);

    return [...prefix, ...contains].slice(0, limit);
  }

  /**
   * canonical name 조회 — 자유 입력이어도 정확 매칭되면 정적 list 의 항목 반환.
   * 자소서·통계에서 name 정규화 위해 사용.
   */
  findCertByName(name: string): CertSuggestion | null {
    const t = name.trim();
    return this.certs.find((c) => c.name === t) ?? null;
  }
  findLangCertByName(name: string): LangCertSuggestion | null {
    const t = name.trim();
    return this.langCerts.find((c) => c.name === t) ?? null;
  }
}
