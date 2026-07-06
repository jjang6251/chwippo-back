import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { AbuserBanService } from '../ai/abuser-ban.service';
import { LlmService } from '../ai/llm.service';
import { scrubPii } from '../ai/pii-scrubber';
import { QuotaCheckService } from '../ai/quota-check.service';
import { ApplicationCoverletter } from './application-coverletter.entity';
import { Application } from './application.entity';
import {
  CoverletterChatMessage,
  type CoverletterCitations,
  type CoverletterSuggestedUpdate,
} from './coverletter-chat-message.entity';
import { CoverletterSourceRef } from './coverletter-source-ref.entity';
import { CompanyResearchService } from '../interview-prep/company-research.service';
import { Coverletter } from '../myinfo/entities/coverletter.entity';
import { CoverletterCustom } from '../myinfo/entities/coverletter-custom.entity';
import { Award } from '../myinfo/entities/award.entity';
import { ActivityLog } from '../activity/entities/activity-log.entity';

/**
 * F1 자소서 풀페이지 Phase D — AI 채팅 서비스.
 *
 * 흐름:
 * 1. application 소유 검증 (IDOR)
 * 2. messages 이력 로드 (최근 6개, multi-turn truncate)
 * 3. context 빌드 (회사 조사 cache + N문항 + source_refs)
 * 4. PII 스크럽 (사용자 입력) + user message DB 저장
 * 5. LlmService.call (multi-turn, structured output)
 * 6. assistant 응답 받음 → suggestedUpdates 의 clId IDOR 검증
 * 7. assistant message DB 저장
 * 8. 응답 반환 (frontend 가 '적용' 버튼 별 mutation)
 *
 * 안전 장치:
 * - per-application max 1000 메시지 cap (오래된 것 자동 삭제)
 * - 메시지 이력 6개 truncate (multi-turn 토큰 누적 제어)
 * - PII 스크럽 후 저장 (raw PII DB 비저장)
 * - suggestedUpdates.clId IDOR 검증 (다른 user 자소서 변경 차단)
 * - moderation / consent / quota / input cap = LlmService 진입점에서 자동
 */

const MESSAGES_GET_LIMIT = 100;
const MESSAGES_HISTORY_TURN_LIMIT = 6; // multi-turn context 메시지 수 (3 turn)
const MESSAGES_PER_APP_CAP = 1000;
const USER_MESSAGE_MAX_LEN = 5000;

const SYSTEM_PROMPT = `당신은 자소서 작성을 도와주는 AI 어시스턴트입니다.

# 역할
- 사용자 자소서 N문항 의 답변 작성·수정·검토를 도와줍니다.
- 활동일지의 logs/reflections (source_refs) 를 자연스럽게 자소서 답변에 녹여냅니다.
- 회사·직무 조사 정보를 답변 맥락에 반영합니다.

# 응답 형식 (JSON) — 엄격 준수
{
  "reply": "사용자에게 짧게 보여줄 안내 (1-3문장, 어떤 문항을 어떻게 작성/수정했는지). 답변 본문 자체는 reply 에 쓰지 마라.",
  "suggestedUpdates": [
    { "clId": "<uuid>", "newAnswer": "<자소서 본문 전체 — 사용자가 textarea 에 그대로 붙여넣을 내용>" }
  ]
}

**핵심 규칙 (반드시 지킬 것):**
- **자소서 답변을 작성하면 무조건 suggestedUpdates 배열에 담아라.** reply 본문에 markdown 으로 답변을 길게 쓰지 마라.
  - ❌ 잘못: reply 에 "## Q1 ... 본문 ... ## Q2 ... 본문 ..."
  - ✅ 옳음: reply 에 "Q1~Q4 4개 문항 답변을 작성했습니다. 각 카드에서 [✓ 이 문항에 적용] 으로 반영하세요." + suggestedUpdates 에 4개 객체
- "전체 답변 생성" 명령 → suggestedUpdates 에 N개 문항 모두 포함 (N개 객체).
- "Q3 다시 써줘" → suggestedUpdates 에 Q3 1개만.
- "검수" 또는 "어떻게 생각해" 같은 질문 → reply 만, suggestedUpdates 빈 배열 또는 생략.
- clId 는 컨텍스트의 자소서 문항 ID (UUID) 만 사용. 번호·문자열 X.
- newAnswer 는 charLimit ±10% 안. 단어 잘리지 않게.
- **"추가해줘" 류 요청이라도 charLimit 초과 금지** — 현재 답변이 이미 제한에 근접·초과한 문항에 내용을 더하라는 요청이 오면, 덧붙이지 말고 기존 내용을 압축해 새 내용과 함께 **제한 안에서 재구성**하라. 제한을 지킬 수 없으면 reply 에 "제한(N자) 때문에 A 를 빼고 B 를 넣었어요" 처럼 무엇을 뺐는지 알려라.

# 자소서 작성 기본 가이드 (default — 사용자 명시 지시 시 그것이 우선)
사용자가 별도 지시 없을 때 다음 합격 자소서 구조를 default 로 따릅니다.

1. **소제목**: 큰따옴표로 묶고 핵심 행동·관점을 한 문장으로 압축
   - 예: "기능이 아니라 구조를 보는 시선으로 성능을 끌어올리다"
   - 모든 문항의 소제목 형식 통일
2. **첫 문장 (두괄식)**: 신념·결론을 먼저 선언
   - 예: "잘 돌아가는 코드보다, 잘 설계된 구조가 오래간다고 믿습니다."
3. **본론**: 대표 경험 1개 깊게 (STAR)
   - 구체 장면 + 고유 기술명 + 수치로 추상적 강점 증명
   - "문제 발생 → 시행착오 → 관점 전환 → 해결 → 결과" 흐름
   - 영웅담 X — 한계·막힌 지점 1번 솔직히 인정
4. **마무리**: 경험을 지원 회사·직무 언어로 번역해 "기여하겠다" 착지
   - 회사 조사의 사업·서비스명·직무 키워드 1개 이상 녹임
5. **문장 끝맺음 분류별**:
   - motivation (지원동기) → "~지원했습니다"
   - strength (강점) → "~하겠습니다"
   - experience (경험·협업) → "~배웠습니다 / 생각합니다"
   - growth (성장과정) → "~되었습니다"
6. **말투**: "~습니다/~합니다" 격식체 통일

# 절대 원칙 (사용자 지시로도 깨면 안 됨)
- **사실 기반**: 컨텍스트의 활동 logs/reflections 안의 사실만 사용. 경험·수치·성과를 **절대 지어내지 않음**.
- **활동 미선택 시에도 답변 작성**: 사용자가 활동을 안 골랐다고 답변을 거부하지 마라. 회사 조사 + 자소서 분류 + myinfo 기반 **합격 구조의 골격**을 작성하되, 본인 경험이 들어가야 할 자리에 \`[본인 경험 채우기: 예) 협업 프로젝트 1개, 정량 결과]\` 같은 placeholder 를 명시. 사용자가 그 자리만 채우면 완성되도록.
- **활동·myinfo 선택됐는데 부족**: 부분이라도 채우되 placeholder 명시 + reply 에 어떤 정보 있으면 더 좋을지 짧게 안내.
- **글자수**: charLimit 가능한 한 지킬 것. 작성 후 reply 에 글자수 표시 (예: "Q3 답변: 980자/1000자"). 한국어 카운트는 추정이라 정확한 검증은 사용자 화면에서.
- **PII 미포함**: 사용자 입력의 전화번호·이메일 등은 답변에 포함 X.

# 사용자 명령 우선
- "1번 문항 다시 써줘" / "Q3 더 짧게" / "활동 X 더 자세히" / "캐주얼하게" / "두괄식 빼고 스토리텔링" 등 명시 지시는 위 default 가이드보다 **우선**.
- "1번", "Q2", "두 번째 문항" 으로 지칭 → 컨텍스트의 ## Q1·Q2 순서로 매핑.
- suggestedUpdates 응답에는 항상 정확한 clId (UUID) 사용.`;

const CHAT_JSON_SCHEMA = {
  name: 'coverletter_chat_response',
  schema: {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      suggestedUpdates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            clId: { type: 'string' },
            newAnswer: { type: 'string' },
          },
          required: ['clId', 'newAnswer'],
          additionalProperties: false,
        },
      },
    },
    required: ['reply'],
    additionalProperties: false,
  },
};

/** 자소서 소재 (myinfo coverletter) 6 카테고리 키. custom 항목은 'custom:<uuid>' 형태. */
export type MyinfoFieldKey =
  | 'personality'
  | 'background'
  | 'job_competency'
  | 'own_strength'
  | 'collaboration'
  | 'challenge'
  | `custom:${string}`;

export interface ChatSendDto {
  /** 사용자 새 메시지 (5000자 cap) */
  userMessage: string;
  /** (옵션) 사용자가 사이드에서 선택한 source_log_ids — 채팅 컨텍스트에 추가 */
  selectedLogIds?: string[];
  /** (옵션) myinfo 자소서 소재 6 카테고리 또는 custom:<uuid> — prompt 에 inject */
  selectedMyinfoFieldKeys?: MyinfoFieldKey[];
  /** (옵션) myinfo 수상 ID — prompt 에 # 수상 내역 블록 */
  selectedAwardIds?: string[];
}

/**
 * AI 응답 결과 상태 — frontend 가 토스트·UI 분기 시 ⚠️ string match 대신 enum 사용.
 *
 * - ok: 정상 응답 (suggestedUpdates 유무는 별개)
 * - truncated: maxOutputTokens cap 도달로 JSON 잘림. reply 일부만 전달, suggestedUpdates 누락 가능
 * - blocked_consent: AI 사용 동의 안 됨 → LLM 미호출
 * - blocked_quota: 일·월·cooldown 한도 초과 → LLM 미호출
 * - blocked_moderation: OpenAI moderation flagged → LLM 미호출
 * - error: provider 5xx · timeout · network · 알 수 없는 오류
 * - fallback_ok: 1차 provider 실패 후 다른 provider 로 retry 성공 (Phase D 도입 후)
 */
export type ChatAssistantStatus =
  | 'ok'
  | 'truncated'
  | 'blocked_consent'
  | 'blocked_quota'
  | 'blocked_moderation'
  | 'error'
  | 'fallback_ok';

export interface ChatResult {
  userMessage: CoverletterChatMessage;
  assistantMessage: CoverletterChatMessage;
  assistantStatus: ChatAssistantStatus;
  /** error/blocked/truncated 시 사용자에게 보여줄 사유 (한국어) */
  assistantStatusReason?: string;
}

@Injectable()
export class CoverletterChatService {
  private readonly logger = new Logger(CoverletterChatService.name);

  constructor(
    @InjectRepository(Application)
    private readonly appRepo: Repository<Application>,
    @InjectRepository(ApplicationCoverletter)
    private readonly clRepo: Repository<ApplicationCoverletter>,
    @InjectRepository(CoverletterSourceRef)
    private readonly refRepo: Repository<CoverletterSourceRef>,
    @InjectRepository(CoverletterChatMessage)
    private readonly msgRepo: Repository<CoverletterChatMessage>,
    @InjectRepository(Coverletter)
    private readonly myinfoCoverletterRepo: Repository<Coverletter>,
    @InjectRepository(CoverletterCustom)
    private readonly myinfoCustomRepo: Repository<CoverletterCustom>,
    @InjectRepository(Award)
    private readonly awardRepo: Repository<Award>,
    @InjectRepository(ActivityLog)
    private readonly activityLogRepo: Repository<ActivityLog>,
    private readonly llm: LlmService,
    private readonly quotaCheck: QuotaCheckService,
    private readonly abuserBan: AbuserBanService,
    @Inject(forwardRef(() => CompanyResearchService))
    private readonly research: CompanyResearchService,
  ) {}

  /** application 소유 검증 (IDOR 차단). 모든 method 의 진입점. */
  private async assertOwn(
    userId: string,
    applicationId: string,
  ): Promise<Application> {
    const app = await this.appRepo.findOne({
      where: { id: applicationId, userId },
    });
    if (!app) throw new NotFoundException('지원 카드를 찾을 수 없습니다.');
    return app;
  }

  // A1 (2026-07-06) — assertGenerationCompleted 가드 제거.
  //   3경로 개편: 회사조사는 옵션 부가물 — 조사 없이도 chat 허용 (컨텍스트는
  //   getCachedForApplication 이 null 허용이라 조사 미완 시 회사 섹션만 빠짐).

  /** 메시지 이력 — 최근 N개 (default 100), ASC 정렬 */
  async listMessages(
    userId: string,
    applicationId: string,
  ): Promise<CoverletterChatMessage[]> {
    await this.assertOwn(userId, applicationId);
    return this.msgRepo.find({
      where: { applicationId },
      order: { createdAt: 'ASC' },
      take: MESSAGES_GET_LIMIT,
    });
  }

  /** 전체 삭제 — 사용자 권리 */
  async deleteMessages(userId: string, applicationId: string): Promise<void> {
    await this.assertOwn(userId, applicationId);
    await this.msgRepo.delete({ applicationId });
  }

  /** 채팅 — 컨텍스트 빌드 + LLM 호출 + user/assistant 양쪽 save */
  async chat(
    userId: string,
    applicationId: string,
    dto: ChatSendDto,
  ): Promise<ChatResult> {
    // 1. application 소유 검증 + 회사조사 완료 가드 (PR_B1c)
    const app = await this.assertOwn(userId, applicationId);

    // 2. 사용자 입력 검증
    const trimmed = dto.userMessage?.trim() ?? '';
    if (trimmed.length === 0) {
      throw new BadRequestException('메시지를 입력해 주세요.');
    }
    if (trimmed.length > USER_MESSAGE_MAX_LEN) {
      throw new BadRequestException(
        `메시지는 ${USER_MESSAGE_MAX_LEN}자 이내로 작성해 주세요.`,
      );
    }

    // 3. selectedLogIds 검증 (IDOR — 본인 user 소유의 ActivityLog 만 허용).
    //    source_refs 안 거침 — 자소서 작성 전이라도 사이드에서 체크한 활동을 바로 prompt 에 inject.
    let selectedLogs: ActivityLog[] = [];
    if (dto.selectedLogIds?.length) {
      selectedLogs = await this.activityLogRepo.find({
        where: { userId, id: In(dto.selectedLogIds) },
        relations: ['activity'],
        order: { occurredAt: 'DESC' },
        take: 20, // prompt 절약 cap
      });
    }
    const selectedLogIds = selectedLogs.map((l) => l.id);

    // 3b. selectedMyinfoFieldKeys 검증 + 본인 myinfo 조회
    //     IDOR: Coverletter 와 CoverletterCustom 둘 다 WHERE user_id 명시
    const myinfoSelections: Array<{
      key: string;
      label: string;
      content: string;
    }> = [];
    if (dto.selectedMyinfoFieldKeys?.length) {
      const fixedKeys = dto.selectedMyinfoFieldKeys.filter(
        (k): k is Exclude<MyinfoFieldKey, `custom:${string}`> =>
          !k.startsWith('custom:'),
      );
      const customIds = dto.selectedMyinfoFieldKeys
        .filter((k) => k.startsWith('custom:'))
        .map((k) => k.slice('custom:'.length));

      if (fixedKeys.length > 0) {
        const myCl = await this.myinfoCoverletterRepo.findOne({
          where: { user_id: userId },
        });
        if (myCl) {
          const LABEL: Record<(typeof fixedKeys)[number], string> = {
            personality: '성격 장단점',
            background: '성장 배경',
            job_competency: '직무 역량·핵심 경험',
            own_strength: '나만의 강점',
            collaboration: '갈등 해결·협업 경험',
            challenge: '도전·실패 경험',
          };
          for (const k of fixedKeys) {
            const content = (myCl as unknown as Record<string, string | null>)[
              k
            ];
            if (content?.trim()) {
              myinfoSelections.push({
                key: k,
                label: LABEL[k],
                content: content.trim(),
              });
            }
          }
        }
      }
      if (customIds.length > 0) {
        const customs = await this.myinfoCustomRepo.find({
          where: { user_id: userId, id: In(customIds) },
        });
        for (const c of customs) {
          if (c.content?.trim()) {
            myinfoSelections.push({
              key: `custom:${c.id}`,
              label: c.label,
              content: c.content.trim(),
            });
          }
        }
      }
    }

    // 3c. selectedAwardIds 검증 + 본인 수상 조회 (IDOR — WHERE user_id)
    let selectedAwards: Array<{
      contest: string;
      award: string | null;
      org: string | null;
      awardedAt: string | null;
      content: string | null;
    }> = [];
    if (dto.selectedAwardIds?.length) {
      const awards = await this.awardRepo.find({
        where: { user_id: userId, id: In(dto.selectedAwardIds) },
        order: { awarded_at: 'DESC' },
        take: 20,
      });
      selectedAwards = awards.map((a) => ({
        contest: a.contest_name,
        award: a.award_name ?? null,
        org: a.org ?? null,
        awardedAt: a.awarded_at ?? null,
        content: a.content ?? null,
      }));
    }

    // 4. 메시지 이력 로드 (최근 6개 turn)
    const history = await this.msgRepo.find({
      where: { applicationId },
      order: { createdAt: 'DESC' },
      take: MESSAGES_HISTORY_TURN_LIMIT,
    });
    history.reverse(); // 시간순 (오래된 → 최근)

    // 5. cap check — 1000 초과 시 가장 오래된 것 자동 삭제 (저장 전 1자리 비움)
    await this.enforceCap(applicationId);

    // 6. 컨텍스트 빌드
    const cls = await this.clRepo.find({
      where: { applicationId },
      order: { orderIndex: 'ASC' },
    });
    const cached = await this.research
      .getCachedForApplication(userId, applicationId)
      .catch(() => null);
    const userPrompt = this.buildUserPrompt({
      app,
      cls,
      research: cached,
      history,
      selectedLogs,
      myinfoSelections,
      selectedAwards,
      userMessage: trimmed,
    });

    // 7. PII 스크럽 (저장용 — DB 에 raw PII 남기지 않음). LlmService 진입점이 system+user 양쪽 자동 스크럽
    const scrubbedForStorage = scrubPii(trimmed).text;

    // 8. user 메시지 먼저 save — citations 에 사용자 선택 컨텍스트 저장
    const userCitations: CoverletterCitations | null =
      selectedLogIds.length > 0 ? { selectedLogIds } : null;
    const userMessage = await this.msgRepo.save(
      this.msgRepo.create({
        applicationId,
        role: 'user',
        content: scrubbedForStorage,
        suggestedUpdates: null,
        citations: userCitations,
      }),
    );

    // 9. quota check
    const quota = await this.quotaCheck.checkAndPrepare(
      userId,
      'coverletter_chat',
    );
    if (quota.blocked) {
      await this.llm.call({
        userId,
        feature: 'coverletter_chat',
        systemPrompt: '',
        userPrompt: '',
        resourceType: 'coverletter_chat',
        resourceId: applicationId,
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: `${quota.code}: ${quota.reason}`,
      });
      if (quota.code === 'DAY_LIMIT') {
        void this.abuserBan
          .checkAndBan(userId, 'coverletter_chat', 1)
          .catch((err: unknown) =>
            this.logger.warn(
              `AbuserBan check 실패 (user=${userId}): ${(err as Error).message}`,
            ),
          );
      }
      const assistantBlocked = await this.msgRepo.save(
        this.msgRepo.create({
          applicationId,
          role: 'assistant',
          content: `⚠️ ${quota.reason}`,
          suggestedUpdates: null,
          citations: null,
        }),
      );
      return {
        userMessage,
        assistantMessage: assistantBlocked,
        assistantStatus: 'blocked_quota',
        assistantStatusReason: quota.reason,
      };
    }

    // 10. LLM 호출
    const result = await this.llm.call({
      userId,
      feature: 'coverletter_chat',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      jsonSchema: CHAT_JSON_SCHEMA,
      resourceType: 'coverletter_chat',
      resourceId: applicationId,
    });

    let assistantContent = '⚠️ AI 응답 생성 중 오류가 발생했어요.';
    let suggestedUpdates: CoverletterSuggestedUpdate[] | null = null;
    let assistantStatus: ChatAssistantStatus = 'error';
    let assistantStatusReason: string | undefined;

    if (result.status === 'ok' && result.json) {
      const json = result.json as {
        reply?: string;
        suggestedUpdates?: CoverletterSuggestedUpdate[];
      };
      const rawReply = json.reply?.trim();
      if (rawReply) {
        assistantContent = rawReply;
        // 1차 provider 실패 후 fallback 으로 받은 응답 → 사용자에게 라벨 표시
        assistantStatus = result.wasFallback ? 'fallback_ok' : 'ok';
        if (result.wasFallback) {
          assistantStatusReason =
            '1차 AI 일시 장애로 다른 모델로 응답했어요. 평소와 톤이 약간 다를 수 있습니다.';
        }
      }

      // 11. suggestedUpdates IDOR 검증 — clId 가 이 application 의 자식인지
      if (json.suggestedUpdates?.length) {
        const validClIds = new Set(cls.map((c) => c.id));
        suggestedUpdates = json.suggestedUpdates
          .filter((u) => validClIds.has(u.clId))
          .map((u) => ({
            clId: u.clId,
            newAnswer: typeof u.newAnswer === 'string' ? u.newAnswer : '',
          }))
          .filter((u) => u.newAnswer.length > 0);

        const rejectedCount =
          json.suggestedUpdates.length - (suggestedUpdates?.length ?? 0);
        if (rejectedCount > 0) {
          this.logger.warn(
            `suggestedUpdates IDOR — ${rejectedCount}개 clId 가 application=${applicationId} 자식 아님, 무시됨`,
          );
        }
        if (suggestedUpdates.length === 0) suggestedUpdates = null;
      }

      // truncated 감지 — output 토큰이 cap 의 95% 이상이면 JSON 잘림 가능성 ↑
      // suggestedUpdates 가 reply 안에 언급됐는데 빈 배열이면 truncated 강력 시사
      const cap = 5_000; // coverletter_chat maxOutputTokens (model-config.ts:153)
      // result.completionTokens 는 LlmService 가 반환 (provider 응답 토큰 수)
      if (assistantStatus === 'ok' && result.completionTokens >= cap * 0.95) {
        assistantStatus = 'truncated';
        assistantStatusReason =
          '답변이 길어 일부가 잘렸어요. "더 짧게" 또는 "한 문항씩" 요청해 보세요.';
      }
    } else if (result.status !== 'ok') {
      // LlmCallBlocked. status 자체로 분기 (string match 폐기)
      const errMsg = result.errorMessage;
      assistantContent = errMsg ? `⚠️ ${errMsg}` : assistantContent;
      assistantStatusReason = errMsg;
      switch (result.status) {
        case 'blocked_consent':
          assistantStatus = 'blocked_consent';
          break;
        case 'blocked_quota':
          // 이 분기는 사실 위 9번 quota check 에서 차단됐어야 하나
          // LlmService 내부 중복 check 로 떨어진 경우 (race) — 동일 처리
          assistantStatus = 'blocked_quota';
          break;
        case 'blocked_moderation':
          assistantStatus = 'blocked_moderation';
          break;
        case 'blocked_input_cap':
        case 'error':
        default:
          assistantStatus = 'error';
          break;
      }
    }
    // result.status === 'ok' 이지만 result.json 이 falsy 인 경우 — assistantStatus 'error' 유지 (fallback 메시지)

    // 12. assistant citations — AI 가 활용한 컨텍스트 (현재는 user selectedLogIds 그대로 + 회사조사 cache 여부)
    //     향후 LLM structured output 에서 정확한 citedLogIds 받을 수 있음 (자동 추출 가능 시 교체)
    const assistantCitations: CoverletterCitations | null =
      selectedLogIds.length > 0 || cached?.status === 'ok'
        ? {
            citedLogIds: selectedLogIds.length > 0 ? selectedLogIds : undefined,
            citedResearch: cached?.status === 'ok' ? true : undefined,
          }
        : null;

    // 13. assistant 메시지 save (PII 스크럽 적용 — LLM 응답에도 hallucination 가능)
    const assistantMessage = await this.msgRepo.save(
      this.msgRepo.create({
        applicationId,
        role: 'assistant',
        content: scrubPii(assistantContent).text,
        suggestedUpdates,
        citations: assistantCitations,
      }),
    );

    return {
      userMessage,
      assistantMessage,
      assistantStatus,
      assistantStatusReason,
    };
  }

  /**
   * Phase 4 — Streaming chat (SSE).
   * chat() 와 동일한 컨텍스트 빌드 + LlmService.callStream 사용.
   *
   * yield event:
   * - 'user_saved' { message } — user message DB 저장 직후. frontend optimistic placeholder 교체용
   * - 'partial' { reply, suggestedUpdates? } — chunk 도착 시 partial json
   * - 'done' { assistantMessage, assistantStatus } — final assistant DB 저장 후
   * - 'error' { reason }
   */
  async *chatStream(
    userId: string,
    applicationId: string,
    dto: ChatSendDto,
  ): AsyncGenerator<
    | { type: 'user_saved'; userMessage: CoverletterChatMessage }
    | {
        type: 'partial';
        reply?: string;
        suggestedUpdates?: CoverletterSuggestedUpdate[];
      }
    | {
        type: 'done';
        assistantMessage: CoverletterChatMessage;
        assistantStatus: ChatAssistantStatus;
        assistantStatusReason?: string;
      }
    | { type: 'error'; message: string }
  > {
    // 1-9 단계: chat() 과 동일 — 입력 검증 + context build + quota + user save
    const app = await this.assertOwn(userId, applicationId);
    // A1 — 회사조사 완료 가드 제거 (3경로: 조사 없이도 chat 허용)
    const trimmed = dto.userMessage?.trim() ?? '';
    if (trimmed.length === 0) {
      yield { type: 'error', message: '메시지를 입력해 주세요.' };
      return;
    }
    if (trimmed.length > USER_MESSAGE_MAX_LEN) {
      yield {
        type: 'error',
        message: `메시지는 ${USER_MESSAGE_MAX_LEN}자 이내로 작성해 주세요.`,
      };
      return;
    }

    // selectedLogs (본인 user 소유 ActivityLog 직접 조회)
    let selectedLogs: ActivityLog[] = [];
    if (dto.selectedLogIds?.length) {
      selectedLogs = await this.activityLogRepo.find({
        where: { userId, id: In(dto.selectedLogIds) },
        relations: ['activity'],
        order: { occurredAt: 'DESC' },
        take: 20,
      });
    }
    const selectedLogIds = selectedLogs.map((l) => l.id);

    // myinfo selections
    const myinfoSelections: Array<{
      key: string;
      label: string;
      content: string;
    }> = [];
    if (dto.selectedMyinfoFieldKeys?.length) {
      const fixedKeys = dto.selectedMyinfoFieldKeys.filter(
        (k): k is Exclude<MyinfoFieldKey, `custom:${string}`> =>
          !k.startsWith('custom:'),
      );
      const customIds = dto.selectedMyinfoFieldKeys
        .filter((k) => k.startsWith('custom:'))
        .map((k) => k.slice('custom:'.length));
      if (fixedKeys.length > 0) {
        const myCl = await this.myinfoCoverletterRepo.findOne({
          where: { user_id: userId },
        });
        if (myCl) {
          const LABEL: Record<(typeof fixedKeys)[number], string> = {
            personality: '성격 장단점',
            background: '성장 배경',
            job_competency: '직무 역량·핵심 경험',
            own_strength: '나만의 강점',
            collaboration: '갈등 해결·협업 경험',
            challenge: '도전·실패 경험',
          };
          for (const k of fixedKeys) {
            const content = (myCl as unknown as Record<string, string | null>)[
              k
            ];
            if (content?.trim()) {
              myinfoSelections.push({
                key: k,
                label: LABEL[k],
                content: content.trim(),
              });
            }
          }
        }
      }
      if (customIds.length > 0) {
        const customs = await this.myinfoCustomRepo.find({
          where: { user_id: userId, id: In(customIds) },
        });
        for (const c of customs) {
          if (c.content?.trim()) {
            myinfoSelections.push({
              key: `custom:${c.id}`,
              label: c.label,
              content: c.content.trim(),
            });
          }
        }
      }
    }

    let selectedAwards: Array<{
      contest: string;
      award: string | null;
      org: string | null;
      awardedAt: string | null;
      content: string | null;
    }> = [];
    if (dto.selectedAwardIds?.length) {
      const awards = await this.awardRepo.find({
        where: { user_id: userId, id: In(dto.selectedAwardIds) },
        order: { awarded_at: 'DESC' },
        take: 20,
      });
      selectedAwards = awards.map((a) => ({
        contest: a.contest_name,
        award: a.award_name ?? null,
        org: a.org ?? null,
        awardedAt: a.awarded_at ?? null,
        content: a.content ?? null,
      }));
    }

    const history = await this.msgRepo.find({
      where: { applicationId },
      order: { createdAt: 'DESC' },
      take: MESSAGES_HISTORY_TURN_LIMIT,
    });
    history.reverse();

    await this.enforceCap(applicationId);

    const cls = await this.clRepo.find({
      where: { applicationId },
      order: { orderIndex: 'ASC' },
    });
    const cached = await this.research
      .getCachedForApplication(userId, applicationId)
      .catch(() => null);
    const userPrompt = this.buildUserPrompt({
      app,
      cls,
      research: cached,
      history,
      selectedLogs,
      myinfoSelections,
      selectedAwards,
      userMessage: trimmed,
    });

    const scrubbedForStorage = scrubPii(trimmed).text;
    const userCitations: CoverletterCitations | null =
      selectedLogIds.length > 0 ? { selectedLogIds } : null;
    const userMessage = await this.msgRepo.save(
      this.msgRepo.create({
        applicationId,
        role: 'user',
        content: scrubbedForStorage,
        suggestedUpdates: null,
        citations: userCitations,
      }),
    );
    yield { type: 'user_saved', userMessage };

    // quota check
    const quota = await this.quotaCheck.checkAndPrepare(
      userId,
      'coverletter_chat',
    );
    if (quota.blocked) {
      await this.llm.call({
        userId,
        feature: 'coverletter_chat',
        systemPrompt: '',
        userPrompt: '',
        resourceType: 'coverletter_chat',
        resourceId: applicationId,
        preBlockedStatus: 'blocked_quota',
        preBlockedReason: `${quota.code}: ${quota.reason}`,
      });
      const assistantBlocked = await this.msgRepo.save(
        this.msgRepo.create({
          applicationId,
          role: 'assistant',
          content: `⚠️ ${quota.reason}`,
          suggestedUpdates: null,
          citations: null,
        }),
      );
      yield {
        type: 'done',
        assistantMessage: assistantBlocked,
        assistantStatus: 'blocked_quota',
        assistantStatusReason: quota.reason,
      };
      return;
    }

    // streaming
    let finalJson: {
      reply?: string;
      suggestedUpdates?: CoverletterSuggestedUpdate[];
    } | null = null;
    let errorMessage: string | null = null;
    try {
      for await (const event of this.llm.callStream<{
        reply?: string;
        suggestedUpdates?: CoverletterSuggestedUpdate[];
      }>({
        userId,
        feature: 'coverletter_chat',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        jsonSchema: CHAT_JSON_SCHEMA,
        resourceType: 'coverletter_chat',
        resourceId: applicationId,
      })) {
        if (event.type === 'partial') {
          yield {
            type: 'partial',
            reply: event.json.reply,
            suggestedUpdates: event.json.suggestedUpdates,
          };
        } else if (event.type === 'done') {
          finalJson = event.json;
        } else {
          errorMessage = event.message;
        }
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'stream unknown';
    }

    // final assistant save
    let assistantContent = '⚠️ AI 응답 생성 중 오류가 발생했어요.';
    let suggestedUpdates: CoverletterSuggestedUpdate[] | null = null;
    let assistantStatus: ChatAssistantStatus = 'error';
    let assistantStatusReason: string | undefined = errorMessage ?? undefined;

    if (finalJson) {
      const reply = finalJson.reply?.trim();
      if (reply) {
        assistantContent = reply;
        assistantStatus = 'ok';
        assistantStatusReason = undefined;
      }
      if (finalJson.suggestedUpdates?.length) {
        const validClIds = new Set(cls.map((c) => c.id));
        suggestedUpdates = finalJson.suggestedUpdates
          .filter((u) => validClIds.has(u.clId))
          .map((u) => ({
            clId: u.clId,
            newAnswer: typeof u.newAnswer === 'string' ? u.newAnswer : '',
          }))
          .filter((u) => u.newAnswer.length > 0);
        if (suggestedUpdates.length === 0) suggestedUpdates = null;
      }
    } else if (errorMessage) {
      assistantContent = `⚠️ ${errorMessage}`;
    }

    const assistantCitations: CoverletterCitations | null =
      selectedLogIds.length > 0 || cached?.status === 'ok'
        ? {
            citedLogIds: selectedLogIds.length > 0 ? selectedLogIds : undefined,
            citedResearch: cached?.status === 'ok' ? true : undefined,
          }
        : null;

    const assistantMessage = await this.msgRepo.save(
      this.msgRepo.create({
        applicationId,
        role: 'assistant',
        content: scrubPii(assistantContent).text,
        suggestedUpdates,
        citations: assistantCitations,
      }),
    );

    yield {
      type: 'done',
      assistantMessage,
      assistantStatus,
      assistantStatusReason,
    };
  }

  /** 1000 초과 시 가장 오래된 메시지부터 삭제 (저장 후 보존 cap) */
  private async enforceCap(applicationId: string): Promise<void> {
    const count = await this.msgRepo.count({ where: { applicationId } });
    if (count < MESSAGES_PER_APP_CAP) return;
    // 가장 오래된 (count - cap + 2) 개 삭제 — user/assistant 추가 2개 미리 비움
    const toDelete = count - MESSAGES_PER_APP_CAP + 2;
    const oldest = await this.msgRepo.find({
      where: { applicationId },
      order: { createdAt: 'ASC' },
      take: toDelete,
      select: ['id'],
    });
    if (oldest.length > 0) {
      await this.msgRepo.delete({ id: In(oldest.map((m) => m.id)) });
    }
  }

  /** 컨텍스트 prompt 빌드 */
  private buildUserPrompt(args: {
    app: Application;
    cls: ApplicationCoverletter[];
    research: Awaited<
      ReturnType<CompanyResearchService['getCachedForApplication']>
    > | null;
    history: CoverletterChatMessage[];
    selectedLogs: ActivityLog[];
    myinfoSelections: Array<{ key: string; label: string; content: string }>;
    selectedAwards: Array<{
      contest: string;
      award: string | null;
      org: string | null;
      awardedAt: string | null;
      content: string | null;
    }>;
    userMessage: string;
  }): string {
    const parts: string[] = [];
    parts.push(`# 회사·직무\n${args.app.companyName}`);
    if (args.app.jobCategory || args.app.jobTitle) {
      parts.push(
        `직무: ${[args.app.jobCategory, args.app.jobTitle].filter(Boolean).join(' · ')}`,
      );
    }

    if (
      args.research &&
      args.research.status === 'ok' &&
      args.research.research
    ) {
      const r = args.research.research;
      const summary: string[] = [];
      if (r.businessSummary) summary.push(`사업: ${r.businessSummary}`);
      if (r.coreValues) summary.push(`핵심가치: ${r.coreValues}`);
      if (r.recentTrends) summary.push(`최근동향: ${r.recentTrends}`);
      if (summary.length > 0) {
        parts.push(`\n# 회사 조사\n${summary.join('\n')}`);
      }
    }

    parts.push(`\n# 자소서 문항 (N=${args.cls.length})`);
    args.cls.forEach((cl, idx) => {
      // 사용자는 "1번 문항", "Q2" 식으로 지칭. AI 가 이해하도록 번호 명시.
      parts.push(
        `\n## Q${idx + 1} (clId: ${cl.id})\n- 분류: ${cl.category ?? '미지정'}\n- 글자수 제한: ${cl.charLimit ?? '없음'}\n- 질문: ${cl.question || '(미입력)'}\n- 현재 답변: ${cl.answer || '(없음)'}`,
      );
    });

    if (args.selectedLogs.length > 0) {
      parts.push(
        `\n# 사용자가 선택한 활동 일지 (N=${args.selectedLogs.length})`,
      );
      for (const log of args.selectedLogs) {
        const activityName = log.activity?.name ?? '(활동명 없음)';
        const date = log.occurredAt
          ? new Date(log.occurredAt).toISOString().slice(0, 10)
          : '';
        const meta: string[] = [];
        if (log.cat) meta.push(`카테고리:${log.cat}`);
        if (log.comps?.length) meta.push(`역량:${log.comps.join(',')}`);
        if (log.mood) meta.push(`감정:${log.mood}`);
        if (log.quant) {
          const q = log.quant as {
            type?: string;
            before?: string;
            after?: string;
            unit?: string;
            value?: string;
            metric?: string;
          };
          const unit = q.unit ?? '';
          if (q.type === 'before-after')
            meta.push(`정량:${q.before ?? ''}→${q.after ?? ''}${unit}`);
          else if (q.type === 'count')
            meta.push(
              `정량:${q.value ?? ''}${unit}${q.metric ? `(${q.metric})` : ''}`,
            );
        }
        if (log.keywords?.length) meta.push(`키워드:${log.keywords.join(',')}`);
        parts.push(
          `\n## [${activityName}] ${date}\n- ${log.content}${meta.length ? `\n- (${meta.join(' · ')})` : ''}`,
        );
      }
    }

    if (args.myinfoSelections.length > 0) {
      parts.push(`\n# 사용자 자소서 소재 (myinfo — 사용자가 정리한 본인 자료)`);
      for (const m of args.myinfoSelections) {
        // content 가 길면 prompt 절약 위해 1500자 cap
        const trimmed =
          m.content.length > 1500 ? m.content.slice(0, 1500) + '…' : m.content;
        parts.push(`\n## ${m.label}\n${trimmed}`);
      }
    }

    if (args.selectedAwards.length > 0) {
      parts.push(`\n# 사용자 수상 내역 (N=${args.selectedAwards.length})`);
      for (const aw of args.selectedAwards) {
        const meta: string[] = [];
        if (aw.award) meta.push(aw.award);
        if (aw.org) meta.push(`주관: ${aw.org}`);
        if (aw.awardedAt) meta.push(aw.awardedAt);
        const metaLine = meta.length ? `\n- ${meta.join(' · ')}` : '';
        const contentLine = aw.content ? `\n- ${aw.content}` : '';
        parts.push(`\n## 🏆 ${aw.contest}${metaLine}${contentLine}`);
      }
    }

    if (args.history.length > 0) {
      parts.push(`\n# 대화 이력 (최근 ${args.history.length} 메시지)`);
      for (const h of args.history) {
        parts.push(`[${h.role}] ${h.content}`);
      }
    }

    parts.push(`\n# 사용자 새 메시지\n${args.userMessage}`);
    return parts.join('\n');
  }

  /**
   * 90일 KST cron 자동 삭제 — application 마지막 활동 + 90일 inactive.
   *
   * **삭제 기준** (옵션 B): 자소서의 가장 최근 메시지 created_at 기준 +90일.
   *   활발한 자소서 (89일 이내 활동) = 모두 보존.
   *   90일+ inactive 자소서 = 모든 메시지 삭제.
   *
   * **시간대**: KST (Asia/Seoul) 명시 — 서버 TZ 와 무관.
   * **영향 범위**: coverletter_chat_messages 만. 다른 테이블·다른 user 무관 (application 단위).
   */
  async cleanupOldMessages(): Promise<{
    deleted: number;
    applicationIds: string[];
  }> {
    const result = await this.msgRepo
      .createQueryBuilder()
      .delete()
      .where(
        `application_id IN (
          SELECT application_id FROM coverletter_chat_messages
          GROUP BY application_id
          HAVING MAX(created_at) <
            ((NOW() AT TIME ZONE 'Asia/Seoul' - INTERVAL '90 days') AT TIME ZONE 'Asia/Seoul')
        )`,
      )
      .returning(['id', 'applicationId'])
      .execute();

    const rows =
      (result.raw as { application_id?: string; applicationId?: string }[]) ??
      [];
    const applicationIds = Array.from(
      new Set(
        rows
          .map((r) => r.applicationId ?? r.application_id ?? '')
          .filter(Boolean),
      ),
    );
    const deleted = result.affected ?? rows.length;
    if (deleted > 0) {
      this.logger.log(
        `cleanup: ${deleted} 메시지 삭제 (${applicationIds.length} application)`,
      );
    }
    return { deleted, applicationIds };
  }
}

// IDOR 가드 helper 의 LessThan 임포트는 향후 추가 메서드에서 활용 (현재 미사용이지만 향후 일자 비교 검토)
void LessThan;
void ForbiddenException;
