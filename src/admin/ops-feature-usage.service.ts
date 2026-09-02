import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  kstWallClockToDate,
  toKstDateString,
  getKstWeekMonday,
} from '../common/datetime';
import { tiptapTextLength } from '../common/tiptap-text-length';
import { User } from '../users/user.entity';
import { UserDailyVisit } from '../users/user-daily-visit.entity';
import {
  Application,
  type JobPosting,
} from '../applications/application.entity';
import { ApplicationStep } from '../applications/application-step.entity';
import { ApplicationCoverletter } from '../applications/application-coverletter.entity';
import { CoverletterChatMessage } from '../applications/coverletter-chat-message.entity';
import { StepNoteSheet } from '../applications/step-note-sheet.entity';
import { StepChecklistItem } from '../applications/step-checklist-item.entity';
import { DailyNote } from '../calendar/daily-note.entity';
import { StudyNote } from '../study-notes/study-note.entity';
import { StudyNoteFolder } from '../study-notes/study-note-folder.entity';
import { NoteAttachment } from '../study-notes/note-attachment.entity';
import { Activity } from '../activity/entities/activity.entity';
import { ActivityLog } from '../activity/entities/activity-log.entity';
import { ActivityReflection } from '../activity/entities/activity-reflection.entity';
import { InterviewPrepSession } from '../interview-prep/entities/interview-prep-session.entity';
import { InterviewPrepQuestion } from '../interview-prep/entities/interview-prep-question.entity';
import { Coverletter } from '../myinfo/entities/coverletter.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';

/**
 * 기능 사용 실태 — **누가 어떤 기능을 얼마나 쓰는가**.
 *
 * ## 형제 화면과 무엇이 다른가
 *
 * | | 질문 |
 * |---|---|
 * | `/ops/reach` | 가입 후 **어디까지** 갔나 (자소서 퍼널 한 줄) |
 * | `/ops/card-fields` | 카드에 **무엇을** 채우나 (카드 한 종류) |
 * | 여기 | **전 기능**을 누가 얼마나 쓰나 (기능 × 사람 매트릭스) |
 *
 * 앞의 둘은 각각 한 축만 본다. 「공부 노트는 아무도 안 쓰나」·「내정보를 채운 사람이
 * 자소서도 쓰나」 같은 질문은 두 화면 어디에도 답이 없었다.
 *
 * ## 🔴 이 화면이 답하지 **못하는** 것 — 먼저 적는다
 *
 * ① **왜**를 모른다. 「안 쓴다」가 몰라서인지 알고도 안 쓰는 건지 DB 에는 안 남는다.
 *    인터뷰·Clarity 리플레이가 여전히 짝으로 필요하다.
 * ② N 이 작다(60명 안팎). **미세한 차이는 노이즈**다 — 큰 격차만 신호로 읽는다.
 *    그래서 이 응답에는 **퍼센트가 없다**(깊이 프록시의 체크율만 예외이고 단위를 명시한다).
 * ③ **읽기만 하는 사용은 안 잡힌다.** 회사 조사 열람·공고 요건 읽기·공고 허브 탐색은
 *    행을 만들지 않는다. 여기서 0 인 기능이 「아무도 안 본다」는 뜻이 아니다.
 *
 * ## 🔴 AI 사용 통계는 여기서 만들지 않는다
 *
 * `llm_call_logs` 기반 집계는 `/ops/ai-usage` 가 이미 한다. 같은 숫자를 두 화면이
 * 각자 세면 **두 값이 갈라지는 순간 어느 쪽도 못 믿게 된다.**
 *
 * ## 개인정보
 *
 * 응답에 들어가는 것은 **id · 닉네임 · 개수 · 날짜뿐**이다. 노트 본문·메모 내용 같은
 * 사용자 콘텐츠는 집계 재료로만 쓰고 응답에 싣지 않는다 (`ops-reach` 와 같은 판단).
 * 글자수 프록시가 콘텐츠를 읽어야 하는 유일한 이유고, 읽은 값은 **숫자로만** 나간다.
 */

// ────────────────────────────────────────────────────────────────────────
// 공개 타입 — 응답 계약
// ────────────────────────────────────────────────────────────────────────

export type FeatureKey =
  | 'application_card'
  | 'calendar_schedule'
  | 'daily_note'
  | 'study_note'
  | 'study_note_folder'
  | 'note_attachment'
  | 'step_note_sheet'
  | 'step_checklist'
  | 'company_memo'
  | 'job_posting'
  | 'activity'
  | 'activity_log'
  | 'activity_reflection'
  | 'coverletter_card'
  | 'coverletter_vault'
  | 'coverletter_chat'
  | 'interview_prep'
  | 'myinfo';

/**
 * 사용자별 사용 횟수 분포.
 *
 * 🔴 **1 과 2 를 가르는 칸이 따로 있는 이유** — 「한 번 써 보고 말았다」와 「돌아왔다」는
 * 완전히 다른 사실인데 평균·합계로는 구분이 안 된다. 이 화면의 핵심 질문이 그것이다.
 */
export interface FeatureBuckets {
  /** 딱 1회 */
  one: number;
  /** 2~4회 */
  twoToFour: number;
  /** 5회 이상 */
  fivePlus: number;
}

export interface FeatureStat {
  key: FeatureKey;
  label: string;
  /** 1회 이상 쓴 인원 (관리자 제외) */
  usersEver: number;
  /**
   * 서로 다른 KST 날짜 **2일 이상** 생성 이력이 있는 인원.
   * 🔴 `null` = **잴 수 없음**(행에 생성 시각이 없는 기능). 0 이 아니다.
   */
  usersMultiDay: number | null;
  buckets: FeatureBuckets;
  /** 기능별 깊이 프록시의 **사용자 중앙값**. 쓴 사람이 0명이면 `null` */
  depthMedian: number | null;
  /** 깊이 프록시의 단위 — 기능마다 다르므로 값과 항상 같이 읽는다 */
  depthUnit: string;
  /** 최근 7일(KST, 오늘 포함) 사용 인원. `null` = 잴 수 없음 */
  usersLast7d: number | null;
  /** 날짜 축이 무엇인지 (또는 왜 없는지) — 숫자를 오독하지 않게 하는 유일한 장치 */
  dateBasis: string;
}

export interface UserFeatureCell {
  count: number;
  /** 마지막 사용 시각(ISO). 날짜 축이 없는 기능은 `null` */
  lastUsedAt: string | null;
}

export interface FeatureUsageUserRow {
  userId: string;
  nickname: string;
  /** 가입 시각 (ISO) */
  joinedAt: string;
  /** 🔴 **쓴 기능만** 담는다 — 0 을 18칸 채우면 매트릭스가 0 으로 도배된다 */
  perFeature: Partial<Record<FeatureKey, UserFeatureCell>>;
}

export interface RetentionRow {
  /** 가입 주차의 월요일 (KST, YYYY-MM-DD) */
  cohortWeek: string;
  /** 그 주에 가입한 인원 (관리자 제외) */
  size: number;
  /**
   * 가입 주차의 N주 뒤(월~일)에 방문 기록이 있는 인원.
   * 🔴 `null` = **아직 그 주가 시작되지 않음**. 0("아무도 안 돌아왔다")과 전혀 다르다.
   */
  week1: number | null;
  week2: number | null;
  week3: number | null;
  week4: number | null;
}

export interface FeatureUsageResponse {
  generatedAt: string;
  /** 집계·매트릭스에서 통째로 빠진 관리자 수 — 조용히 빼면 합계가 안 맞아 보인다 */
  excludedAdmins: number;
  /** 분모 — 관리자를 뺀 전체 가입자 */
  totalUsers: number;
  features: FeatureStat[];
  users: FeatureUsageUserRow[];
  retention: RetentionRow[];
}

// ────────────────────────────────────────────────────────────────────────
// 스냅샷 — DB 가 준 원재료 (순수 집계 함수의 입력)
// ────────────────────────────────────────────────────────────────────────

/**
 * 🔴 **로딩과 집계를 나눈 이유.** 집계 규칙(KST 날짜 접기·버킷 경계·중앙값·화이트리스트)은
 * 조용히 틀리는 종류라 spec 이 유일한 방어인데, `dataSource.query` 를 mock 하면
 * *"내 픽스처로 내 전제를 검증"* 하는 꼴이 된다. 그래서 집계는 DB 를 전혀 모르는
 * 순수 함수(`buildFeatureUsage`)로 두고, **SQL 자체는 e2e 가 진짜 Postgres 로** 확인한다.
 */
export interface UsageSnapshot {
  users: {
    id: string;
    nickname: string;
    role: string;
    createdAt: Date;
  }[];
  /** `user_daily_visits` — visit_date 는 이미 KST 달력 날짜다 (jwt.strategy 가 KST 로 넣는다) */
  visits: { userId: string; visitDate: string }[];
  cards: {
    userId: string;
    createdAt: Date;
    currentStepIndex: number;
    /** 공백 제거 후 글자수. 0·null = 안 채움 */
    memoLength: number | null;
    jobPosting: JobPosting | null;
  }[];
  schedules: {
    userId: string;
    scheduledDate: Date;
    /** 장소·메모 중 하나라도 채웠나 */
    detailed: boolean;
  }[];
  dailyNotes: { userId: string; createdAt: Date; isDone: boolean }[];
  /** 🔴 `content` 는 tiptap doc JSON — 글자수 프록시 계산에만 쓰고 응답에는 안 싣는다 */
  studyNotes: {
    userId: string;
    id: string;
    folderId: string | null;
    createdAt: Date;
    content: string | null;
  }[];
  studyNoteFolders: { userId: string; id: string; createdAt: Date }[];
  noteAttachments: { userId: string; noteId: string; createdAt: Date }[];
  /** 준비 노트 시트 — `content` 도 tiptap doc JSON */
  sheets: { userId: string; createdAt: Date; content: string | null }[];
  checklistItems: { userId: string; createdAt: Date; isDone: boolean }[];
  cardCoverletters: {
    userId: string;
    createdAt: Date;
    answerLength: number | null;
  }[];
  /** 내정보 창고 자소서 — 표준 6문항 + 커스텀 항목을 **채운 것만** 1행씩 */
  vaultCoverletters: {
    userId: string;
    /** 표준 6문항은 `myinfo_coverletter.updated_at`, 커스텀 항목은 시각 컬럼이 없어 `null` */
    at: Date | null;
    length: number;
  }[];
  coverletterChats: {
    userId: string;
    createdAt: Date;
    contentLength: number;
  }[];
  activities: { userId: string; id: string; createdAt: Date }[];
  activityLogs: {
    userId: string;
    activityId: string;
    createdAt: Date;
    contentLength: number;
  }[];
  activityReflections: {
    userId: string;
    createdAt: Date;
    contentLength: number;
  }[];
  interviewSessions: { userId: string; id: string; createdAt: Date }[];
  interviewQuestions: { sessionId: string }[];
  /** 내정보 8종 — 항목 1개당 1행 (`kind` 가 그 종류) */
  myinfoItems: { userId: string; kind: MyinfoKind }[];
}

export type MyinfoKind =
  | 'education'
  | 'experience'
  | 'cert'
  | 'language_cert'
  | 'award'
  | 'document'
  | 'exam_schedule'
  | 'profile';

// ────────────────────────────────────────────────────────────────────────
// 기능군 정의
// ────────────────────────────────────────────────────────────────────────

/** 깊이 프록시를 사용자 1명의 값 하나로 접는 방법 */
type DepthMode =
  /** 행별 값의 중앙값 */
  | 'median'
  /** 행별 값의 최댓값 */
  | 'max'
  /** 행별 0/1 의 비율(%) — 완료 체크율처럼 「얼마나 끝까지 갔나」 */
  | 'percent'
  /** 서로 다른 태그 수 — 내정보 「몇 종을 채웠나」 */
  | 'tagCount';

interface FeatureDef {
  key: FeatureKey;
  label: string;
  depthUnit: string;
  depthMode: DepthMode;
  /** 행마다 생성 시각이 있어 「서로 다른 날짜」를 셀 수 있는가 */
  supportsMultiDay: boolean;
  supportsLast7d: boolean;
  dateBasis: string;
}

/**
 * 🔴 **깊이 프록시는 기능마다 단위가 다르다.** 「자」와 「단계」와 「%」를 같은 열에 세로로
 * 늘어놓으면 서로 비교하고 싶어지는데, 그건 비교할 수 없는 값들이다. 그래서 단위를
 * 응답에 함께 실어 화면이 값 옆에 항상 붙이도록 한다.
 */
export const FEATURE_DEFS: FeatureDef[] = [
  {
    key: 'application_card',
    label: '지원 카드',
    depthUnit: '단계',
    depthMode: 'max',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '카드 생성 시각 (applications.created_at)',
  },
  {
    key: 'calendar_schedule',
    label: '캘린더 일정',
    depthUnit: '%',
    depthMode: 'percent',
    supportsMultiDay: true,
    supportsLast7d: false,
    dateBasis:
      '일정 날짜 (application_steps.scheduled_date) — 🔴 스텝에는 생성 시각 컬럼이 없다. ' +
      '「언제 입력했나」가 아니라 「며칠에 일정이 잡혀 있나」라, 최근 7일 지표는 만들지 않는다',
  },
  {
    key: 'daily_note',
    label: '오늘 할 일·시간 메모',
    depthUnit: '% (완료 체크)',
    depthMode: 'percent',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '메모 생성 시각 (daily_notes.created_at)',
  },
  {
    key: 'study_note',
    label: '공부 노트',
    depthUnit: '자 (본문)',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '노트 생성 시각 (study_notes.created_at)',
  },
  {
    key: 'study_note_folder',
    label: '공부 노트 폴더',
    depthUnit: '개 (폴더당 노트)',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '폴더 생성 시각 (study_note_folders.created_at)',
  },
  {
    key: 'note_attachment',
    label: '노트 첨부 (이미지·드로잉)',
    depthUnit: '개 (노트당 첨부)',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '첨부 생성 시각 (note_attachments.created_at)',
  },
  {
    key: 'step_note_sheet',
    label: '준비 노트 시트',
    depthUnit: '자 (본문)',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '시트 생성 시각 (step_note_sheets.created_at)',
  },
  {
    key: 'step_checklist',
    label: '준비 노트 체크리스트',
    depthUnit: '% (완료 체크)',
    depthMode: 'percent',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '항목 생성 시각 (step_checklist_items.created_at)',
  },
  {
    key: 'company_memo',
    label: '회사 메모',
    depthUnit: '자',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis:
      '카드 생성 시각 (applications.created_at) — 메모 전용 시각 컬럼이 없다. ' +
      '메모를 나중에 채웠다면 실제 입력일보다 이르게 잡힌다',
  },
  {
    key: 'job_posting',
    label: '공고 요건',
    depthUnit: '개 (요건 항목)',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '공고 파싱 시각 (applications.job_posting → parsedAt)',
  },
  {
    key: 'activity',
    label: '활동 (활동일지)',
    depthUnit: '개 (활동당 기록)',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '활동 생성 시각 (activities.created_at)',
  },
  {
    key: 'activity_log',
    label: '활동 기록',
    depthUnit: '자',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis:
      '기록 생성 시각 (activity_logs.created_at) — 🔴 `occurred_at` 은 사용자가 과거로 ' +
      '적을 수 있어 습관 지표로 못 쓴다 (streak 규칙과 동일)',
  },
  {
    key: 'activity_reflection',
    label: '주간 회고',
    depthUnit: '자',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '회고 생성 시각 (activity_reflections.created_at)',
  },
  {
    key: 'coverletter_card',
    label: '자소서 — 카드 문항',
    depthUnit: '자 (답변)',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '문항 생성 시각 (application_coverletters.created_at)',
  },
  {
    key: 'coverletter_vault',
    label: '자소서 — 내정보 창고',
    depthUnit: '자 (항목)',
    depthMode: 'median',
    supportsMultiDay: false,
    supportsLast7d: true,
    dateBasis:
      '표준 6문항의 최종 수정 시각 (myinfo_coverletter.updated_at) — 사용자당 1행이라 ' +
      '「서로 다른 날짜」를 셀 수 없다. 커스텀 항목에는 시각 컬럼이 아예 없다',
  },
  {
    key: 'coverletter_chat',
    label: '자소서 — AI 챗 (내 메시지)',
    depthUnit: '자',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '메시지 생성 시각 (coverletter_chat_messages.created_at)',
  },
  {
    key: 'interview_prep',
    label: '면접 준비',
    depthUnit: '개 (세션당 질문)',
    depthMode: 'median',
    supportsMultiDay: true,
    supportsLast7d: true,
    dateBasis: '세션 생성 시각 (interview_prep_sessions.created_at)',
  },
  {
    key: 'myinfo',
    label: '내정보 8종',
    depthUnit: '종 (8종 중)',
    depthMode: 'tagCount',
    supportsMultiDay: false,
    supportsLast7d: false,
    dateBasis:
      '🔴 없음 — 8종 중 증빙파일·시험일정에만 생성 시각 컬럼이 있다. 두 종만으로 날짜 ' +
      '지표를 만들면 나머지 6종을 안 센 값이 「전체」로 읽힌다',
  },
];

// ────────────────────────────────────────────────────────────────────────
// 집계 — 순수 함수
// ────────────────────────────────────────────────────────────────────────

interface UsageAcc {
  count: number;
  /** 사용한 서로 다른 KST 날짜 */
  days: Set<string>;
  lastUsedAt: Date | null;
  /** 행별 깊이 값 */
  depths: number[];
  /** `tagCount` 모드 전용 — 채운 종류 */
  tags: Set<string>;
}

function emptyAcc(): UsageAcc {
  return {
    count: 0,
    days: new Set(),
    lastUsedAt: null,
    depths: [],
    tags: new Set(),
  };
}

/** 정렬 후 가운데 — 짝수면 가운데 두 값의 평균 (소수점 1자리에서 끊어 부동소수 잡음 제거) */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw * 10) / 10;
}

/**
 * 사용 횟수 → 버킷.
 *
 * 경계는 **1 / 2~4 / 5+** 다. 0회는 애초에 `usersEver` 에 안 들어오므로 버킷에도 없다
 * (「안 쓴 사람」은 `totalUsers - usersEver` 로 읽는다 — 없는 걸 칸으로 만들지 않는다).
 */
export function bucketOf(count: number): keyof FeatureBuckets | null {
  if (count <= 0) return null;
  if (count === 1) return 'one';
  if (count <= 4) return 'twoToFour';
  return 'fivePlus';
}

function foldDepth(acc: UsageAcc, mode: DepthMode): number | null {
  if (mode === 'tagCount') return acc.tags.size === 0 ? null : acc.tags.size;
  if (acc.depths.length === 0) return null;
  if (mode === 'max') return Math.max(...acc.depths);
  if (mode === 'percent') {
    const done = acc.depths.reduce((s, v) => s + v, 0);
    return Math.round((done / acc.depths.length) * 100);
  }
  return median(acc.depths);
}

/** 요건 5종 배열의 항목 수 합 — 「공고를 얼마나 자세히 붙였나」의 프록시 */
export function jobPostingDepth(posting: JobPosting | null): number {
  if (!posting) return 0;
  const arrays = [
    posting.requirements,
    posting.preferred,
    posting.techStack,
    posting.qualifications,
    posting.keywords,
  ];
  return arrays.reduce(
    (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
    0,
  );
}

/** 공고 파싱 시각 — 형식이 깨졌으면 `null` (던지지 않는다: 자유 입력에서 온 값이다) */
function jobPostingParsedAt(posting: JobPosting | null): Date | null {
  if (!posting || typeof posting.parsedAt !== 'string') return null;
  const d = new Date(posting.parsedAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 스냅샷 → 응답. **DB 를 전혀 모른다.**
 *
 * @param now 집계 기준 시각. 테스트가 실행 시각·서버 TZ 와 무관하도록 주입받는다
 *   (「시간 검증은 TZ × 실행 시각 2축」).
 */
export function buildFeatureUsage(
  snap: UsageSnapshot,
  now: Date = new Date(),
): FeatureUsageResponse {
  const admins = snap.users.filter((u) => u.role === 'admin');
  const members = snap.users
    .filter((u) => u.role !== 'admin')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  /** 🔴 관리자 제외의 **단일 관문**. 기능마다 조건을 흩어 놓으면 한 곳만 빠져도 안 들킨다 */
  const memberIds = new Set(members.map((u) => u.id));

  const acc = new Map<FeatureKey, Map<string, UsageAcc>>();
  for (const def of FEATURE_DEFS) acc.set(def.key, new Map());

  const add = (
    key: FeatureKey,
    userId: string,
    at: Date | null,
    depth: number | null,
    tag?: string,
  ) => {
    if (!memberIds.has(userId)) return;
    const byUser = acc.get(key);
    if (!byUser) return;
    let u = byUser.get(userId);
    if (!u) {
      u = emptyAcc();
      byUser.set(userId, u);
    }
    u.count += 1;
    if (at !== null && !Number.isNaN(at.getTime())) {
      u.days.add(toKstDateString(at));
      if (u.lastUsedAt === null || at.getTime() > u.lastUsedAt.getTime()) {
        u.lastUsedAt = at;
      }
    }
    if (depth !== null) u.depths.push(depth);
    if (tag !== undefined) u.tags.add(tag);
  };

  // ── 카드에서 파생되는 3군 (카드 · 회사 메모 · 공고 요건) ──
  for (const c of snap.cards) {
    add('application_card', c.userId, c.createdAt, c.currentStepIndex);
    if ((c.memoLength ?? 0) > 0) {
      add('company_memo', c.userId, c.createdAt, c.memoLength ?? 0);
    }
    if (c.jobPosting) {
      add(
        'job_posting',
        c.userId,
        jobPostingParsedAt(c.jobPosting) ?? c.createdAt,
        jobPostingDepth(c.jobPosting),
      );
    }
  }

  for (const s of snap.schedules) {
    add('calendar_schedule', s.userId, s.scheduledDate, s.detailed ? 1 : 0);
  }

  for (const n of snap.dailyNotes) {
    add('daily_note', n.userId, n.createdAt, n.isDone ? 1 : 0);
  }

  // ── 공부 노트 · 폴더 · 첨부 ──
  const notesByFolder = new Map<string, number>();
  for (const n of snap.studyNotes) {
    // 🔴 글자수는 `tiptapTextLength` — JSON 길이가 아니다. 구조 JSON 은 본문의 두 배를
    //    넘기도 해서, 그걸 「글자수」로 부르면 화면 카운터와 단위가 어긋난다.
    add('study_note', n.userId, n.createdAt, tiptapTextLength(n.content ?? ''));
    if (n.folderId !== null) {
      notesByFolder.set(n.folderId, (notesByFolder.get(n.folderId) ?? 0) + 1);
    }
  }
  for (const f of snap.studyNoteFolders) {
    add(
      'study_note_folder',
      f.userId,
      f.createdAt,
      notesByFolder.get(f.id) ?? 0,
    );
  }
  const attachmentsByNote = new Map<string, number>();
  for (const a of snap.noteAttachments) {
    attachmentsByNote.set(a.noteId, (attachmentsByNote.get(a.noteId) ?? 0) + 1);
  }
  for (const a of snap.noteAttachments) {
    add(
      'note_attachment',
      a.userId,
      a.createdAt,
      attachmentsByNote.get(a.noteId) ?? 1,
    );
  }

  for (const s of snap.sheets) {
    add(
      'step_note_sheet',
      s.userId,
      s.createdAt,
      tiptapTextLength(s.content ?? ''),
    );
  }
  for (const i of snap.checklistItems) {
    add('step_checklist', i.userId, i.createdAt, i.isDone ? 1 : 0);
  }

  // ── 자소서 3경로 ──
  for (const cl of snap.cardCoverletters) {
    add('coverletter_card', cl.userId, cl.createdAt, cl.answerLength ?? 0);
  }
  for (const v of snap.vaultCoverletters) {
    add('coverletter_vault', v.userId, v.at, v.length);
  }
  for (const m of snap.coverletterChats) {
    add('coverletter_chat', m.userId, m.createdAt, m.contentLength);
  }

  // ── 활동일지 3군 ──
  const logsByActivity = new Map<string, number>();
  for (const l of snap.activityLogs) {
    logsByActivity.set(
      l.activityId,
      (logsByActivity.get(l.activityId) ?? 0) + 1,
    );
    add('activity_log', l.userId, l.createdAt, l.contentLength);
  }
  for (const a of snap.activities) {
    add('activity', a.userId, a.createdAt, logsByActivity.get(a.id) ?? 0);
  }
  for (const r of snap.activityReflections) {
    add('activity_reflection', r.userId, r.createdAt, r.contentLength);
  }

  // ── 면접 준비 ──
  const questionsBySession = new Map<string, number>();
  for (const q of snap.interviewQuestions) {
    questionsBySession.set(
      q.sessionId,
      (questionsBySession.get(q.sessionId) ?? 0) + 1,
    );
  }
  for (const s of snap.interviewSessions) {
    add(
      'interview_prep',
      s.userId,
      s.createdAt,
      questionsBySession.get(s.id) ?? 0,
    );
  }

  // ── 내정보 8종 ──
  for (const item of snap.myinfoItems) {
    add('myinfo', item.userId, null, null, item.kind);
  }

  // ── 최근 7일 창 (오늘 포함, KST) ──
  const todayMidnightKst = kstWallClockToDate(toKstDateString(now));
  const last7dFrom = new Date(todayMidnightKst.getTime() - 6 * DAY_MS);

  const features: FeatureStat[] = FEATURE_DEFS.map((def) => {
    const byUser = acc.get(def.key) ?? new Map<string, UsageAcc>();
    const buckets: FeatureBuckets = { one: 0, twoToFour: 0, fivePlus: 0 };
    const depths: number[] = [];
    let multiDay = 0;
    let last7d = 0;

    for (const u of byUser.values()) {
      const b = bucketOf(u.count);
      if (b) buckets[b] += 1;
      const d = foldDepth(u, def.depthMode);
      if (d !== null) depths.push(d);
      if (u.days.size >= 2) multiDay += 1;
      if (
        u.lastUsedAt !== null &&
        u.lastUsedAt.getTime() >= last7dFrom.getTime()
      ) {
        last7d += 1;
      }
    }

    return {
      key: def.key,
      label: def.label,
      usersEver: byUser.size,
      usersMultiDay: def.supportsMultiDay ? multiDay : null,
      buckets,
      depthMedian: median(depths),
      depthUnit: def.depthUnit,
      usersLast7d: def.supportsLast7d ? last7d : null,
      dateBasis: def.dateBasis,
    };
  });

  const users: FeatureUsageUserRow[] = members.map((m) => {
    const perFeature: Partial<Record<FeatureKey, UserFeatureCell>> = {};
    for (const def of FEATURE_DEFS) {
      const u = acc.get(def.key)?.get(m.id);
      if (!u || u.count === 0) continue;
      perFeature[def.key] = {
        count: u.count,
        lastUsedAt: u.lastUsedAt ? u.lastUsedAt.toISOString() : null,
      };
    }
    return {
      userId: m.id,
      nickname: m.nickname,
      joinedAt: m.createdAt.toISOString(),
      perFeature,
    };
  });

  return {
    generatedAt: now.toISOString(),
    excludedAdmins: admins.length,
    totalUsers: members.length,
    features,
    users,
    retention: buildRetention(members, snap.visits, memberIds, now),
  };
}

/**
 * 가입 주차(KST 월요일)별 잔존.
 *
 * `weekN` = 가입 주차의 **N주 뒤 월~일**에 `user_daily_visits` 기록이 있는 인원.
 *
 * 🔴 **아직 오지 않은 주는 `null`.** 이번 주 가입자의 `week1` 을 0 으로 적으면
 * 「아무도 안 돌아왔다」로 읽히는데, 사실은 **그 주가 아직 시작도 안 했다**.
 * 이 화면에서 가장 비싼 오독이 그것이라 두 상태를 타입으로 갈라 놓는다.
 */
function buildRetention(
  members: { id: string; createdAt: Date }[],
  visits: { userId: string; visitDate: string }[],
  memberIds: Set<string>,
  now: Date,
): RetentionRow[] {
  const visitsByUser = new Map<string, string[]>();
  for (const v of visits) {
    if (!memberIds.has(v.userId)) continue;
    const list = visitsByUser.get(v.userId);
    if (list) list.push(v.visitDate);
    else visitsByUser.set(v.userId, [v.visitDate]);
  }

  const cohorts = new Map<string, string[]>();
  for (const m of members) {
    const week = getKstWeekMonday(toKstDateString(m.createdAt));
    const list = cohorts.get(week);
    if (list) list.push(m.id);
    else cohorts.set(week, [m.id]);
  }

  return [...cohorts.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // 최근 주차 먼저
    .map(([cohortWeek, userIds]) => {
      // KST 는 DST 가 없어 「월요일 자정 + 7N일」이 정확히 그 주의 월요일 자정이다
      const monday = kstWallClockToDate(cohortWeek);
      const weekCount = (n: number): number | null => {
        const start = new Date(monday.getTime() + n * 7 * DAY_MS);
        if (start.getTime() > now.getTime()) return null; // 아직 안 온 주
        const end = new Date(start.getTime() + 7 * DAY_MS);
        let hit = 0;
        for (const id of userIds) {
          const days = visitsByUser.get(id);
          if (!days) continue;
          const inWindow = days.some((d) => {
            const t = kstWallClockToDate(d).getTime();
            return t >= start.getTime() && t < end.getTime();
          });
          if (inWindow) hit += 1;
        }
        return hit;
      };
      return {
        cohortWeek,
        size: userIds.length,
        week1: weekCount(1),
        week2: weekCount(2),
        week3: weekCount(3),
        week4: weekCount(4),
      };
    });
}

// ────────────────────────────────────────────────────────────────────────
// 서비스 — 로딩 + 5분 캐시
// ────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class OpsFeatureUsageService {
  private cache: { data: FeatureUsageResponse; at: number } | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async getFeatureUsage(force = false): Promise<FeatureUsageResponse> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.data;
    }
    const snapshot = await this.loadSnapshot();
    const data = buildFeatureUsage(snapshot, new Date());
    this.cache = { data, at: Date.now() };
    return data;
  }

  /** 테스트·수동 갱신용 — 캐시를 비운다 */
  resetCache(): void {
    this.cache = null;
  }

  /**
   * 기능당 1쿼리. 전부 `Promise.all` 로 한 번에 나간다.
   *
   * 🔴 **관리자 제외를 여기서 하지 않는다.** `buildFeatureUsage` 의 `memberIds` 한 곳이
   * 관문이다 — 27개 쿼리에 `role <> 'admin'` 을 흩어 놓으면 하나만 빠져도 안 들킨다.
   */
  private async loadSnapshot(): Promise<UsageSnapshot> {
    const ds = this.dataSource;

    const [
      users,
      visits,
      cards,
      schedules,
      dailyNotes,
      studyNotes,
      studyNoteFolders,
      noteAttachments,
      sheets,
      checklistItems,
      cardCoverletters,
      vaultStandard,
      vaultCustom,
      coverletterChats,
      activities,
      activityLogs,
      activityReflections,
      interviewSessions,
      interviewQuestions,
      myinfoItems,
    ] = await Promise.all([
      ds
        .getRepository(User)
        .createQueryBuilder('u')
        .select('u.id', 'id')
        .addSelect('u.nickname', 'nickname')
        .addSelect('u.role', 'role')
        .addSelect('u.createdAt', 'createdAt')
        .getRawMany<UsageSnapshot['users'][number]>(),

      // 🔴 `TO_CHAR` 로 문자열을 못 박는다. `date` 컬럼을 그대로 뽑으면 드라이버가 JS `Date`
      //    를 돌려주는데(실측 2026-09-02: `value.split is not a function` 로 500), 그 `Date`
      //    는 **실행 환경 로컬 TZ 자정**이라 KST 달력 날짜와 어긋난다. 이 값은 이미 KST
      //    달력 날짜(jwt.strategy 가 KST 로 넣는다)라 문자열로 두는 게 유일하게 안전하다.
      ds
        .getRepository(UserDailyVisit)
        .createQueryBuilder('v')
        .select('v.userId', 'userId')
        .addSelect("TO_CHAR(v.visitDate, 'YYYY-MM-DD')", 'visitDate')
        .getRawMany<UsageSnapshot['visits'][number]>(),

      // 온보딩 샘플 카드는 사용자가 만든 게 아니다 (`ops-reach` 와 같은 규칙).
      // soft-delete 필터는 repository QueryBuilder 가 자동으로 붙인다.
      ds
        .getRepository(Application)
        .createQueryBuilder('app')
        .select('app.userId', 'userId')
        .addSelect('app.createdAt', 'createdAt')
        .addSelect('app.currentStepIndex', 'currentStepIndex')
        .addSelect('LENGTH(TRIM(app.memo))', 'memoLength')
        .addSelect('app.jobPosting', 'jobPosting')
        .where('app.isSample = false')
        .getRawMany<UsageSnapshot['cards'][number]>(),

      ds
        .getRepository(ApplicationStep)
        .createQueryBuilder('step')
        .innerJoin(
          Application,
          'app',
          'app.id = step.applicationId AND app.deletedAt IS NULL AND app.isSample = false',
        )
        .select('app.userId', 'userId')
        .addSelect('step.scheduledDate', 'scheduledDate')
        .addSelect(
          "(COALESCE(TRIM(step.location), '') <> '' OR COALESCE(TRIM(step.notes), '') <> '')",
          'detailed',
        )
        .where('step.scheduledDate IS NOT NULL')
        .getRawMany<UsageSnapshot['schedules'][number]>(),

      ds
        .getRepository(DailyNote)
        .createQueryBuilder('n')
        .select('n.userId', 'userId')
        .addSelect('n.createdAt', 'createdAt')
        .addSelect('n.isDone', 'isDone')
        .getRawMany<UsageSnapshot['dailyNotes'][number]>(),

      ds
        .getRepository(StudyNote)
        .createQueryBuilder('n')
        .select('n.id', 'id')
        .addSelect('n.userId', 'userId')
        .addSelect('n.folderId', 'folderId')
        .addSelect('n.createdAt', 'createdAt')
        .addSelect('n.content', 'content')
        .getRawMany<UsageSnapshot['studyNotes'][number]>(),

      ds
        .getRepository(StudyNoteFolder)
        .createQueryBuilder('f')
        .select('f.id', 'id')
        .addSelect('f.userId', 'userId')
        .addSelect('f.createdAt', 'createdAt')
        .getRawMany<UsageSnapshot['studyNoteFolders'][number]>(),

      ds
        .getRepository(NoteAttachment)
        .createQueryBuilder('a')
        .select('a.userId', 'userId')
        .addSelect('a.noteId', 'noteId')
        .addSelect('a.createdAt', 'createdAt')
        .getRawMany<UsageSnapshot['noteAttachments'][number]>(),

      // 시트·체크리스트·자소서·챗은 **샘플 카드에 붙어도 사용자가 쓴 것**이다
      // (카드 생성과 달리 자동으로 생기지 않는다 — `ops-reach` 의 자소서 판단과 같다).
      ds
        .getRepository(StepNoteSheet)
        .createQueryBuilder('sheet')
        .innerJoin(ApplicationStep, 'step', 'step.id = sheet.stepId')
        .innerJoin(
          Application,
          'app',
          'app.id = step.applicationId AND app.deletedAt IS NULL',
        )
        .select('app.userId', 'userId')
        .addSelect('sheet.createdAt', 'createdAt')
        .addSelect('sheet.content', 'content')
        .getRawMany<UsageSnapshot['sheets'][number]>(),

      ds
        .getRepository(StepChecklistItem)
        .createQueryBuilder('item')
        .innerJoin(ApplicationStep, 'step', 'step.id = item.stepId')
        .innerJoin(
          Application,
          'app',
          'app.id = step.applicationId AND app.deletedAt IS NULL',
        )
        .select('app.userId', 'userId')
        .addSelect('item.createdAt', 'createdAt')
        .addSelect('item.isDone', 'isDone')
        .getRawMany<UsageSnapshot['checklistItems'][number]>(),

      ds
        .getRepository(ApplicationCoverletter)
        .createQueryBuilder('cl')
        .innerJoin(
          Application,
          'app',
          'app.id = cl.applicationId AND app.deletedAt IS NULL',
        )
        .select('app.userId', 'userId')
        .addSelect('cl.createdAt', 'createdAt')
        .addSelect('LENGTH(TRIM(cl.answer))', 'answerLength')
        .getRawMany<UsageSnapshot['cardCoverletters'][number]>(),

      // 표준 6문항 — 채운 칸의 글자수만 6개 열로 받아 온다 (본문은 절대 안 꺼낸다)
      ds
        .getRepository(Coverletter)
        .createQueryBuilder('c')
        .select('c.user_id', 'userId')
        .addSelect('c.updated_at', 'updatedAt')
        .addSelect('LENGTH(TRIM(c.personality))', 'personality')
        .addSelect('LENGTH(TRIM(c.background))', 'background')
        .addSelect('LENGTH(TRIM(c.job_competency))', 'jobCompetency')
        .addSelect('LENGTH(TRIM(c.own_strength))', 'ownStrength')
        .addSelect('LENGTH(TRIM(c.collaboration))', 'collaboration')
        .addSelect('LENGTH(TRIM(c.challenge))', 'challenge')
        .getRawMany<VaultStandardRow>(),

      ds
        .getRepository(CoverletterCustom)
        .createQueryBuilder('cc')
        .select('cc.user_id', 'userId')
        .addSelect('LENGTH(TRIM(cc.content))', 'length')
        .getRawMany<{ userId: string; length: number | null }>(),

      // 🔴 assistant 메시지는 세지 않는다 — AI 응답까지 세면 「사용자가 몇 번 말했나」가
      //    두 배로 부풀어 사용량이 아니라 대화 길이를 재게 된다
      ds
        .getRepository(CoverletterChatMessage)
        .createQueryBuilder('m')
        .innerJoin(
          Application,
          'app',
          'app.id = m.applicationId AND app.deletedAt IS NULL',
        )
        .select('app.userId', 'userId')
        .addSelect('m.createdAt', 'createdAt')
        .addSelect('LENGTH(m.content)', 'contentLength')
        .where("m.role = 'user'")
        .getRawMany<UsageSnapshot['coverletterChats'][number]>(),

      ds
        .getRepository(Activity)
        .createQueryBuilder('a')
        .select('a.id', 'id')
        .addSelect('a.userId', 'userId')
        .addSelect('a.createdAt', 'createdAt')
        .getRawMany<UsageSnapshot['activities'][number]>(),

      ds
        .getRepository(ActivityLog)
        .createQueryBuilder('l')
        .select('l.userId', 'userId')
        .addSelect('l.activityId', 'activityId')
        .addSelect('l.createdAt', 'createdAt')
        .addSelect('LENGTH(l.content)', 'contentLength')
        .getRawMany<UsageSnapshot['activityLogs'][number]>(),

      ds
        .getRepository(ActivityReflection)
        .createQueryBuilder('r')
        .select('r.userId', 'userId')
        .addSelect('r.createdAt', 'createdAt')
        .addSelect('LENGTH(r.content)', 'contentLength')
        .getRawMany<UsageSnapshot['activityReflections'][number]>(),

      ds
        .getRepository(InterviewPrepSession)
        .createQueryBuilder('s')
        .select('s.id', 'id')
        .addSelect('s.userId', 'userId')
        .addSelect('s.createdAt', 'createdAt')
        .getRawMany<UsageSnapshot['interviewSessions'][number]>(),

      ds
        .getRepository(InterviewPrepQuestion)
        .createQueryBuilder('q')
        .select('q.sessionId', 'sessionId')
        .getRawMany<UsageSnapshot['interviewQuestions'][number]>(),

      // 🔴 여기만 raw 다. 8개 테이블을 각각 QueryBuilder 로 돌면 **한 기능에 쿼리 8개**가
      //    되고, 8벌의 같은 코드가 생겨 한 줄만 어긋나도 안 들킨다. 사용자 입력이
      //    섞이지 않는 고정 UNION 이라 인젝션 표면도 없다.
      ds.query<{ user_id: string; kind: MyinfoKind }[]>(`
        SELECT user_id, 'education'     AS kind FROM myinfo_educations
        UNION ALL SELECT user_id, 'experience'     FROM myinfo_experiences
        UNION ALL SELECT user_id, 'cert'           FROM myinfo_certs
        UNION ALL SELECT user_id, 'language_cert'  FROM myinfo_language_certs
        UNION ALL SELECT user_id, 'award'          FROM myinfo_awards
        UNION ALL SELECT user_id, 'document'       FROM myinfo_documents
        UNION ALL SELECT user_id, 'exam_schedule'  FROM myinfo_exam_schedules
        -- 프로필은 1인 1행이라 「행이 있다」로는 못 센다 (온보딩이 빈 행을 만든다).
        -- 한 칸이라도 **실제로 채운** 사람만 1건. 빈 문자열은 안 채운 것으로 본다.
        UNION ALL SELECT user_id, 'profile' FROM user_profiles
          WHERE COALESCE(
                  NULLIF(TRIM(name), ''), NULLIF(TRIM(name_hanja), ''),
                  NULLIF(TRIM(gender), ''), NULLIF(TRIM(phone), ''),
                  NULLIF(TRIM(email_personal), ''),
                  NULLIF(TRIM(military_branch), ''), NULLIF(TRIM(military_type), ''),
                  NULLIF(TRIM(military_unit), ''),
                  NULLIF(TRIM(goal_certs), ''), NULLIF(TRIM(goal_other), '')
                ) IS NOT NULL
             OR birthdate IS NOT NULL OR goal_toeic IS NOT NULL
             OR military_start IS NOT NULL OR military_end IS NOT NULL
      `),
    ]);

    return {
      users: users.map((u) => ({ ...u, createdAt: new Date(u.createdAt) })),
      visits,
      cards: cards.map((c) => ({
        ...c,
        currentStepIndex: Number(c.currentStepIndex ?? 0),
        memoLength: c.memoLength === null ? null : Number(c.memoLength),
      })),
      schedules,
      dailyNotes,
      studyNotes,
      studyNoteFolders,
      noteAttachments,
      sheets,
      checklistItems,
      cardCoverletters: cardCoverletters.map((c) => ({
        ...c,
        answerLength: c.answerLength === null ? null : Number(c.answerLength),
      })),
      vaultCoverletters: toVaultItems(vaultStandard, vaultCustom),
      coverletterChats: coverletterChats.map((m) => ({
        ...m,
        contentLength: Number(m.contentLength ?? 0),
      })),
      activities,
      activityLogs: activityLogs.map((l) => ({
        ...l,
        contentLength: Number(l.contentLength ?? 0),
      })),
      activityReflections: activityReflections.map((r) => ({
        ...r,
        contentLength: Number(r.contentLength ?? 0),
      })),
      interviewSessions,
      interviewQuestions,
      myinfoItems: myinfoItems.map((m) => ({
        userId: m.user_id,
        kind: m.kind,
      })),
    };
  }
}

interface VaultStandardRow {
  userId: string;
  updatedAt: Date;
  personality: number | null;
  background: number | null;
  jobCompetency: number | null;
  ownStrength: number | null;
  collaboration: number | null;
  challenge: number | null;
}

/**
 * 표준 6문항 + 커스텀 항목 → **채운 항목 1개당 1행**.
 *
 * 표준 6문항이 한 행에 6칸으로 들어 있어 그대로 두면 「자소서 창고를 쓴 사람」의
 * 사용 횟수가 항상 1 이 된다 — 6문항 중 1개를 채운 사람과 6개를 다 채운 사람이
 * 같은 칸에 놓인다. 칸 단위로 펼쳐야 버킷(1 / 2~4 / 5+)이 의미를 가진다.
 */
export function toVaultItems(
  standard: VaultStandardRow[],
  custom: { userId: string; length: number | null }[],
): UsageSnapshot['vaultCoverletters'] {
  const items: UsageSnapshot['vaultCoverletters'] = [];
  for (const row of standard) {
    const lengths = [
      row.personality,
      row.background,
      row.jobCompetency,
      row.ownStrength,
      row.collaboration,
      row.challenge,
    ];
    for (const raw of lengths) {
      const len = Number(raw ?? 0);
      if (len > 0) {
        items.push({
          userId: row.userId,
          at: row.updatedAt ? new Date(row.updatedAt) : null,
          length: len,
        });
      }
    }
  }
  for (const c of custom) {
    const len = Number(c.length ?? 0);
    // 커스텀 항목엔 시각 컬럼이 아예 없다 — `null` 로 남겨 「모른다」를 유지한다
    if (len > 0) items.push({ userId: c.userId, at: null, length: len });
  }
  return items;
}
