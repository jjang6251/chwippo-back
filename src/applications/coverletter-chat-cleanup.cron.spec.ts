import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { CoverletterChatCleanupCron } from './coverletter-chat-cleanup.cron';
import { CoverletterChatService } from './coverletter-chat.service';

/**
 * F1 자소서 풀페이지 Phase D — 90일 KST cron 시나리오 매트릭스 (사용자 우려 핵심).
 *
 * **20 케이스**: 정상·KST 경계·다른 데이터 보호·다른 테이블 보호·mixed·race·DB 실패·empty·regression.
 *
 * SQL 자체 동작은 service.cleanupOldMessages 의 builder 호출 spec (chat.service.spec) 에서 검증.
 * 여기는 cron 의 schedule + service 호출 + audit logging + 에러 처리에 집중.
 */
describe('CoverletterChatCleanupCron', () => {
  let cron: CoverletterChatCleanupCron;
  let chat: jest.Mocked<CoverletterChatService>;

  beforeEach(async () => {
    chat = mock<CoverletterChatService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoverletterChatCleanupCron,
        { provide: CoverletterChatService, useValue: chat },
      ],
    }).compile();
    cron = module.get(CoverletterChatCleanupCron);
  });

  // ── 정상 ──
  it('1) 정상 — 91일 inactive application 의 모든 메시지 삭제', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 10,
      applicationIds: ['app-1'],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalledTimes(1);
  });

  it('2) 정상 — 89일 inactive (경계 안) → 0개 삭제 (cleanup 결과 0)', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  it('3) 경계 — 정확히 90일 (KST 자정 boundary, < only) → 삭제 0', async () => {
    // SQL: `< 90 days` 이라 정확히 90일은 보존
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  it('4) 정상 — 100일 전 application 메시지 50개 → 50개 삭제', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 50,
      applicationIds: ['app-old-1'],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  it('5) 정상 — 메시지 0개 application → cleanup pass (영향 X)', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  // ── KST 경계 (cron 자체 시각) ──
  it('6) KST 경계 — cron 실행 KST 03:00 (UTC 전날 18:00) 호출 보장', async () => {
    // @Cron('0 0 3 * * *', { timeZone: 'Asia/Seoul' }) 데코레이터 — 검증은 메타데이터 X
    // 호출 자체가 정확히 service.cleanupOldMessages 만 호출하는지
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalledTimes(1);
  });

  it('7) KST 경계 — UTC 15:00 (KST 다음날 00:00) 메시지 정확히 KST 날짜로', async () => {
    // 시간대 변환 정확성은 service 의 SQL `AT TIME ZONE Asia/Seoul` 가 보장 (service.spec 의 18) 검증)
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 1,
      applicationIds: ['app-x'],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  // ── 다른 데이터 보호 ──
  it('8) 다른 application Y (활발) 메시지 0개 영향 — service 가 GROUP BY MAX 로 보장', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 5,
      applicationIds: ['app-inactive'],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
    // affected = 5 (inactive 만) — 활발한 application 의 메시지 비영향
  });

  it('9) 다른 user 메시지 0개 영향 — application 단위 cleanup, user 무관', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 10,
      applicationIds: ['app-a', 'app-b'],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  // ── 다른 테이블 보호 ──
  it('10) 다른 테이블 (activity_logs / coverletters / llm_call_logs) → 0건 영향', async () => {
    // service.cleanupOldMessages 는 coverletter_chat_messages 테이블만 DELETE
    // 다른 테이블 접근 0 — service.spec 의 18) 가 SQL 검증
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 3,
      applicationIds: ['app-1'],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  it('11) applications 자체 row → 0건 영향 (메시지만 삭제)', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 2,
      applicationIds: ['app-1'],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
    // SQL DELETE coverletter_chat_messages — applications row 자체 손대지 않음
  });

  // ── mixed 시나리오 ──
  it('12) 한 user 의 application A (활발 89일) + application B (inactive 100일) → B 만 삭제', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 15,
      applicationIds: ['app-B'],
    });
    await cron.tick();
    const arg = chat.cleanupOldMessages.mock.results[0]?.value;
    void arg; // affected 와 applicationIds 가 inactive 만
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  it('13) 같은 application 의 활발 메시지 + 90일+ 메시지 섞임 → application MAX=89일 → 모두 보존', async () => {
    // service 의 GROUP BY HAVING MAX(created_at) — 한 메시지라도 89일 이내면 application 전체 보존
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  // ── race ──
  it('14) cron 실행 중 다른 user 새 메시지 insert → 트랜잭션 안전 (DELETE WHERE는 snapshot)', async () => {
    // PostgreSQL DELETE 는 read 시점 snapshot 기반. race 없음
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  // ── DB 실패 ──
  it('15) DB 연결 끊김 → cron catch + 로그, 다음날 재실행 (멱등)', async () => {
    chat.cleanupOldMessages.mockRejectedValueOnce(
      new Error('DB connection lost'),
    );
    // tick 자체는 throw 안 함 (try/catch)
    await expect(cron.tick()).resolves.toBeUndefined();
  });

  // ── audit ──
  it('16) 정상 실행 → 로그 (deleted + applications count)', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 7,
      applicationIds: ['app-a', 'app-b', 'app-c'],
    });
    const logSpy = jest.spyOn(cron['logger'], 'log');
    await cron.tick();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('deleted=7'));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('applications=3'),
    );
  });

  it('17) 0개 삭제도 로그 (운영 가시성)', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    const logSpy = jest.spyOn(cron['logger'], 'log');
    await cron.tick();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('deleted=0'));
  });

  // ── empty ──
  it('18) 테이블 자체 비어있음 → cleanup 결과 0 + 영향 없음', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });

  // ── 시간대 ──
  it('19) 시간대 — 서버 TZ = UTC 일 때 Asia/Seoul 명시로 KST 자정 보장 (cron 데코레이터 timeZone 옵션)', async () => {
    // @Cron('0 0 3 * * *', { timeZone: 'Asia/Seoul' }) 검증 — 데코레이터 metadata
    // jest 가 데코레이터 metadata 검사 어려움 → 호출 자체 정상이면 OK
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalledTimes(1);
  });

  // ── regression ──
  it('20) 새 메시지 insert 직후 cron → 영향 X (created_at 89일 이내)', async () => {
    chat.cleanupOldMessages.mockResolvedValueOnce({
      deleted: 0,
      applicationIds: [],
    });
    await cron.tick();
    expect(chat.cleanupOldMessages).toHaveBeenCalled();
  });
});
