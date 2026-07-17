import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createDbPool,
  createHistoricalImportRepository,
  createMemorySourceRepository,
  runDbMigrations,
  validateHistoricalImportTransition,
  type ConversationItemInput
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const fingerprint = (value: string) => value.padEnd(64, "0").slice(0, 64);

const transcriptItem = (input: {
  sessionId: string;
  transport: "hook" | "transcript" | "historical_import";
  path?: string;
}): ConversationItemInput => ({
  sessionId: input.sessionId,
  sourceKind: "codex",
  sourceAdapterVersion: "codex-transcript-v1",
  sourceTransport: input.transport,
  externalSessionId: "codex-source-session",
  externalThreadId: "codex-source-session",
  externalTurnId: "turn-1",
  sourceRecordType: "event_msg",
  sourceEventType: "user_message",
  sourcePath: input.path,
  sourceLineNumber: 4,
  sourceSequence: 8,
  eventTime: "2026-07-01T12:00:00.000Z",
  rawJson: {
    timestamp: "2026-07-01T12:00:00.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Durable import memory" }
  },
  rawText: "Durable import memory",
  sourceHash: "legacy-transcript-source",
  idempotencyKey: "legacy-transcript-item",
  projectionStatus: "pending",
  projectionVersion: "codex-transcript-v1",
  metadata: {
    transcriptByteOffset: 128,
    transcriptItemDiscriminator: "primary:codex_transcript_user",
    transcriptType: "user_message",
    sourceEventTimeAccuracy: "source"
  }
});

describe("historical import transitions", () => {
  it("accepts resumable transitions and rejects terminal or skipped edges", () => {
    expect(() =>
      validateHistoricalImportTransition("discovered", "eligible")
    ).not.toThrow();
    expect(() =>
      validateHistoricalImportTransition("paused", "importing")
    ).not.toThrow();
    expect(() =>
      validateHistoricalImportTransition("failed", "queued")
    ).not.toThrow();
    expect(() =>
      validateHistoricalImportTransition("completed", "queued")
    ).toThrow("Invalid historical import transition");
    expect(() =>
      validateHistoricalImportTransition("discovered", "completed")
    ).toThrow("Invalid historical import transition");
  });
});

describeDb("durable historical import repository", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl! });
    await runDbMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists owner-scoped restart state, checkpoints, counters, and local path", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `import-owner-${randomUUID()}@example.com`
    });
    const outsider = await repo.createUser({
      email: `import-outsider-${randomUUID()}@example.com`
    });
    const run = await repo.createHistoricalImportRun({ userId: owner.id });
    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        aiClient: "codex",
        sourceKind: "codex",
        sourceSessionId: `session-${randomUUID()}`,
        sourceFingerprint: fingerprint("a"),
        registrationFrontierOffset: 100,
        registrationPrefixHash: "1".repeat(64),
        localSourcePath: "/Users/private/.codex/sessions/private.jsonl",
        sourceSizeBytes: 100,
        discoveredRecordCount: 3,
        detectedProject: { name: "Koed", path: "/Users/private/koed" }
      }
    );
    expect(source?.redactedSourceLabel).toBe("…/private.jsonl");
    expect(
      await repo.getHistoricalImportRun({ userId: outsider.id }, run.id)
    ).toBeNull();
    expect(
      await repo.getHistoricalImportSource({ userId: outsider.id }, source!.id)
    ).toBeNull();

    await repo.transitionHistoricalImportSource(
      { userId: owner.id },
      { sourceId: source!.id, expectedState: "discovered", state: "eligible" }
    );
    await repo.transitionHistoricalImportSource(
      { userId: owner.id },
      { sourceId: source!.id, expectedState: "eligible", state: "queued" }
    );
    await repo.advanceHistoricalImportSource(
      { userId: owner.id },
      {
        sourceId: source!.id,
        expectedCheckpointOffset: 0,
        checkpointOffset: 80,
        checkpointLine: 2,
        checkpointHash: "c".repeat(64),
        sourceSizeBytes: 120,
        importedRecordCount: 2
      }
    );

    const restarted = createHistoricalImportRepository(pool);
    const resumed = await restarted.getHistoricalImportSource(
      { userId: owner.id },
      source!.id
    );
    expect(resumed).toMatchObject({
      state: "importing",
      checkpointOffset: 80,
      checkpointLine: 2,
      checkpointHash: "c".repeat(64),
      importedRecordCount: 2,
      sourceSizeBytes: 120,
      localSourcePath: "/Users/private/.codex/sessions/private.jsonl"
    });
    const detail = await repo.getHistoricalImportRun(
      { userId: owner.id },
      run.id
    );
    expect(detail).toMatchObject({
      sourceCount: 1,
      discoveredRecordCount: 3,
      importedRecordCount: 2,
      scannedByteCount: 80
    });
  });

  it("owner-scopes Captured Session identities used by import and Hook overlap", async () => {
    const repo = createMemorySourceRepository(pool);
    const firstOwner = await repo.createUser({
      email: `session-owner-a-${randomUUID()}@example.com`
    });
    const secondOwner = await repo.createUser({
      email: `session-owner-b-${randomUUID()}@example.com`
    });
    const input = {
      externalSessionId: "shared-source-session",
      idempotencyKey: "shared-session-idempotency",
      sourceHash: "shared-session-source-hash",
      sourceFingerprint: "f".repeat(64)
    };

    const first = await repo.createCapturedSession(
      { userId: firstOwner.id },
      input
    );
    const second = await repo.createCapturedSession(
      { userId: secondOwner.id },
      input
    );

    expect(second.id).not.toBe(first.id);
    expect(second.ownerUserId).toBe(secondOwner.id);
    expect(
      await repo.getCapturedSession({ userId: secondOwner.id }, first.id)
    ).toBeNull();
  });

  it("keeps immutable registration frontier, historical checkpoint, and live cursor independent", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `frontier-owner-${randomUUID()}@example.com`
    });
    const run = await repo.createHistoricalImportRun({ userId: owner.id });
    const sourceSessionId = `frontier-session-${randomUUID()}`;
    const prefixHash = "3".repeat(64);
    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        aiClient: "codex",
        sourceKind: "codex",
        sourceSessionId,
        sourceFingerprint: "4".repeat(64),
        registrationFrontierOffset: 100,
        registrationPrefixHash: prefixHash,
        localSourcePath: "/private/original.jsonl",
        sourceSizeBytes: 150
      }
    );
    await repo.transitionHistoricalImportSource(
      { userId: owner.id },
      { sourceId: source!.id, expectedState: "discovered", state: "eligible" }
    );
    await repo.transitionHistoricalImportSource(
      { userId: owner.id },
      { sourceId: source!.id, expectedState: "eligible", state: "queued" }
    );
    await repo.advanceHistoricalImportSource(
      { userId: owner.id },
      {
        sourceId: source!.id,
        expectedCheckpointOffset: 0,
        checkpointOffset: 60,
        checkpointLine: 2,
        checkpointHash: "5".repeat(64),
        sourceSizeBytes: 150,
        importedRecordCount: 2
      }
    );
    await repo.advanceLiveTranscriptCursor(
      { userId: owner.id },
      {
        sourceId: source!.id,
        expectedCursorOffset: 100,
        expectedCursorHash: prefixHash,
        cursorOffset: 150,
        cursorLine: 5,
        cursorHash: "6".repeat(64),
        sourceSizeBytes: 150
      }
    );
    const restarted = createHistoricalImportRepository(pool);
    expect(
      await restarted.getHistoricalImportSource(
        { userId: owner.id },
        source!.id
      )
    ).toMatchObject({
      registrationFrontierOffset: 100,
      registrationPrefixHash: prefixHash,
      checkpointOffset: 60,
      liveCursorOffset: 150,
      historicalImportedRanges: [
        {
          fromOffset: 0,
          toOffset: 60,
          checkpointHash: "5".repeat(64)
        }
      ]
    });
    await expect(
      repo.advanceHistoricalImportSource(
        { userId: owner.id },
        {
          sourceId: source!.id,
          expectedCheckpointOffset: 60,
          expectedCheckpointHash: "5".repeat(64),
          checkpointOffset: 110,
          checkpointLine: 4,
          checkpointHash: "7".repeat(64),
          sourceSizeBytes: 150,
          importedRecordCount: 1
        }
      )
    ).rejects.toThrow("conflict");
    await expect(
      repo.advanceLiveTranscriptCursor(
        { userId: owner.id },
        {
          sourceId: source!.id,
          expectedCursorOffset: 150,
          expectedCursorHash: "6".repeat(64),
          cursorOffset: 160,
          cursorLine: 6,
          cursorHash: "8".repeat(64),
          sourceSizeBytes: 90
        }
      )
    ).rejects.toThrow("conflict");
    expect(
      await repo.createHistoricalImportSource(
        { userId: owner.id },
        {
          runId: run.id,
          aiClient: "codex",
          sourceKind: "codex",
          sourceSessionId,
          sourceFingerprint: "9".repeat(64),
          registrationFrontierOffset: 100,
          registrationPrefixHash: "a".repeat(64),
          localSourcePath: "/private/mutated.jsonl",
          sourceSizeBytes: 160
        }
      )
    ).toBeNull();
    const newSource = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        aiClient: "codex",
        sourceKind: "codex",
        sourceSessionId: `new-${randomUUID()}`,
        sourceFingerprint: "b".repeat(64),
        registrationFrontierOffset: 0,
        registrationPrefixHash:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        localSourcePath: "/private/new.jsonl",
        sourceSizeBytes: 0
      }
    );
    expect(newSource).toMatchObject({
      registrationFrontierOffset: 0,
      checkpointOffset: 0,
      liveCursorOffset: 0,
      rawIngested: true
    });
  });

  it("converges import and Hook Captured Sessions by owner and source session", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `session-convergence-${randomUUID()}@example.com`
    });

    for (const importFirst of [true, false]) {
      const externalSessionId = `converged-${randomUUID()}`;
      const importedInput = {
        externalSessionId,
        captureMethod: "api" as const,
        idempotencyKey: `historical-${randomUUID()}`,
        sourceFingerprint: fingerprint("import"),
        importObservedAt: "2026-07-02T00:00:00.000Z"
      };
      const hookInput = {
        externalSessionId,
        captureMethod: "hook" as const,
        idempotencyKey: `hook-${randomUUID()}`,
        codexTranscriptPath: `/private/${externalSessionId}.jsonl`
      };
      const first = await repo.createCapturedSession(
        { userId: owner.id },
        importFirst ? importedInput : hookInput
      );
      const second = await repo.createCapturedSession(
        { userId: owner.id },
        importFirst ? hookInput : importedInput
      );
      const watched = await repo.createCapturedSession(
        { userId: owner.id },
        {
          externalSessionId,
          captureMethod: "api",
          idempotencyKey: `watcher-${randomUUID()}`,
          codexTranscriptPath: `/private/${externalSessionId}.jsonl`,
          metadata: { sourceTransport: "transcript" }
        }
      );

      expect(second.id).toBe(first.id);
      expect(watched.id).toBe(first.id);
      expect(second.importObservedAt).toBe("2026-07-02T00:00:00.000Z");
      const stored = await pool.query<{
        codex_transcript_path: string | null;
      }>("select codex_transcript_path from sessions where id = $1", [
        second.id
      ]);
      expect(stored.rows[0]?.codex_transcript_path).toBe(
        `/private/${externalSessionId}.jsonl`
      );
    }
  });

  it("reuses a legacy transcript canonical identity through its compatibility alias", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `legacy-identity-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: "codex-source-session",
        idempotencyKey: `session-${randomUUID()}`
      }
    );
    const legacyKey = `legacy-${randomUUID()}`;
    const currentKey = `conversation-item:${randomUUID()}`;
    const legacy = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...transcriptItem({ sessionId: session.id, transport: "hook" }),
            idempotencyKey: legacyKey
          }
        ]
      }
    );
    const current = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...transcriptItem({ sessionId: session.id, transport: "hook" }),
            idempotencyKey: currentKey,
            legacyIdempotencyKeys: [legacyKey]
          }
        ]
      }
    );

    expect(current[0]?.id).toBe(legacy[0]?.id);
  });

  it("excludes inactive Captured Sessions from Projection admission backlog", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `inactive-backlog-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: "codex-source-session",
        idempotencyKey: `session-${randomUUID()}`
      }
    );
    const before = await repo.getConversationProjectionBacklog();
    await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [transcriptItem({ sessionId: session.id, transport: "hook" })]
      }
    );
    const active = await repo.getConversationProjectionBacklog();
    expect(active.liveProjectionRows).toBe(before.liveProjectionRows + 1);

    await pool.query(
      "update sessions set invalidated_at = now() where id = $1",
      [session.id]
    );
    const inactive = await repo.getConversationProjectionBacklog();
    expect(inactive.liveProjectionRows).toBe(before.liveProjectionRows);
  });

  it("commits policy-gated batches and checkpoints atomically under retry", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `batch-owner-${randomUUID()}@example.com`
    });
    const run = await repo.createHistoricalImportRun({ userId: owner.id });
    const source = await repo.createHistoricalImportSource(
      { userId: owner.id },
      {
        runId: run.id,
        aiClient: "codex",
        sourceKind: "codex",
        sourceSessionId: `batch-session-${randomUUID()}`,
        sourceFingerprint: "d".repeat(64),
        registrationFrontierOffset: 100,
        registrationPrefixHash: "e".repeat(64),
        localSourcePath: "/Users/private/.codex/sessions/batch.jsonl",
        sourceSizeBytes: 100,
        detectedProject: {
          name: "Koed",
          path: "/Users/private/koed",
          branch: "audit"
        }
      }
    );
    for (const [expectedState, state] of [
      ["discovered", "eligible"],
      ["eligible", "queued"]
    ] as const) {
      expect(
        await repo.transitionHistoricalImportRun(
          { userId: owner.id },
          { runId: run.id, expectedState, state }
        )
      ).not.toBeNull();
      expect(
        await repo.transitionHistoricalImportSource(
          { userId: owner.id },
          { sourceId: source!.id, expectedState, state }
        )
      ).not.toBeNull();
    }

    expect(
      await repo.transitionHistoricalImportRun(
        { userId: owner.id },
        { runId: run.id, expectedState: "queued", state: "importing" }
      )
    ).not.toBeNull();
    expect(
      await repo.transitionHistoricalImportSource(
        { userId: owner.id },
        { sourceId: source!.id, expectedState: "queued", state: "importing" }
      )
    ).not.toBeNull();
    expect(
      await repo.transitionHistoricalImportRun(
        { userId: owner.id },
        { runId: run.id, expectedState: "importing", state: "completed" }
      )
    ).toBeNull();
    expect(
      await repo.transitionHistoricalImportSource(
        { userId: owner.id },
        {
          sourceId: source!.id,
          expectedState: "importing",
          state: "completed"
        }
      )
    ).toBeNull();

    await repo.upsertCapturePolicy(
      { userId: owner.id },
      {
        targetType: "global",
        captureState: "disabled",
        visibility: "personal"
      }
    );
    const batch = {
      sourceId: source!.id,
      expectedCheckpointOffset: 0,
      checkpointOffset: 100,
      checkpointLine: 1,
      checkpointHash: "e".repeat(64),
      sourceSizeBytes: 100,
      sourceEventFrom: "2026-07-01T12:00:00.000Z",
      sourceEventTo: "2026-07-01T12:00:00.000Z",
      items: [
        {
          ...transcriptItem({
            sessionId: randomUUID(),
            transport: "historical_import" as const
          }),
          sessionId: undefined
        }
      ]
    };
    await expect(
      repo.ingestHistoricalImportBatch({ userId: owner.id }, batch)
    ).rejects.toThrow("Capture Policy");
    expect(
      await repo.getHistoricalImportSource({ userId: owner.id }, source!.id)
    ).toMatchObject({ checkpointOffset: 0, importedRecordCount: 0 });

    await repo.upsertCapturePolicy(
      { userId: owner.id },
      {
        targetType: "global",
        captureState: "enabled",
        visibility: "personal"
      }
    );
    const policyWriter = await pool.connect();
    await policyWriter.query("begin");
    await policyWriter.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`capture-policy:${owner.id}`]
    );
    await policyWriter.query(
      `update capture_policies set capture_state = 'disabled', updated_at = now()
       where owner_user_id = $1 and target_type = 'global'`,
      [owner.id]
    );
    const policyRaceBatch = repo.ingestHistoricalImportBatch(
      { userId: owner.id },
      batch
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await policyWriter.query("commit");
    policyWriter.release();
    await expect(policyRaceBatch).rejects.toThrow("Capture Policy");
    await repo.upsertCapturePolicy(
      { userId: owner.id },
      {
        targetType: "global",
        captureState: "enabled",
        visibility: "personal"
      }
    );

    const [first, retry] = await Promise.all([
      repo.ingestHistoricalImportBatch({ userId: owner.id }, batch),
      repo.ingestHistoricalImportBatch({ userId: owner.id }, batch)
    ]);
    expect([first.replayed, retry.replayed].sort()).toEqual([false, true]);
    const stored = await pool.query<{
      source_path: string | null;
      captured_project: Record<string, unknown>;
    }>(
      `select source_path, captured_project from conversation_items
       where owner_user_id = $1 and external_session_id = $2`,
      [owner.id, source!.sourceSessionId]
    );
    expect(stored.rows).toEqual([
      {
        source_path: null,
        captured_project: { name: "Koed", branch: "audit" }
      }
    ]);
    const artifacts = await pool.query<{ shares: string; access: string }>(
      `select
        (select count(*) from team_session_share_grants where owner_user_id = $1)::text shares,
        (select count(*) from team_workspace_access_grants where user_id = $1)::text access`,
      [owner.id]
    );
    expect(artifacts.rows[0]).toEqual({ shares: "0", access: "0" });
    expect(
      await repo.getHistoricalImportSource({ userId: owner.id }, source!.id)
    ).toMatchObject({
      checkpointOffset: 100,
      checkpointHash: "e".repeat(64),
      importedRecordCount: 1
    });
    expect(
      await repo.transitionHistoricalImportSource(
        { userId: owner.id },
        {
          sourceId: source!.id,
          expectedState: "importing",
          state: "completed"
        }
      )
    ).toBeNull();
    expect(
      await repo.getHistoricalImportSource({ userId: owner.id }, source!.id)
    ).toMatchObject({
      rawIngested: true,
      rawIngestedRecordCount: 1,
      semanticReady: false,
      lcmComplete: true
    });
    expect(
      await repo.transitionHistoricalImportRun(
        { userId: owner.id },
        { runId: run.id, expectedState: "importing", state: "completed" }
      )
    ).toBeNull();
    await expect(
      repo.ingestHistoricalImportBatch({ userId: owner.id }, batch)
    ).resolves.toMatchObject({ replayed: true, items: [] });
  });

  it("deduplicates hook/import transport and promotes live Projection without changing captured Project provenance", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `dedup-owner-${randomUUID()}@example.com`
    });
    const session = await repo.createCapturedSession(
      { userId: owner.id },
      {
        externalSessionId: "codex-source-session",
        sourceRuntime: "codex",
        captureMethod: "api",
        idempotencyKey: `session-${randomUUID()}`,
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceFingerprint: fingerprint("b"),
        capturedProject: { name: "Captured", path: "/private/captured" },
        importObservedAt: "2026-07-02T00:00:00.000Z"
      }
    );
    const imported = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...transcriptItem({
              sessionId: session.id,
              transport: "historical_import"
            }),
            sourceFingerprint: fingerprint("b"),
            capturedProject: { name: "Captured", path: "/private/captured" },
            importObservedAt: "2026-07-02T00:00:00.000Z"
          }
        ]
      }
    );
    const watched = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          transcriptItem({
            sessionId: session.id,
            transport: "transcript",
            path: "/watched/local/path.jsonl"
          })
        ]
      }
    );
    expect(watched[0]?.id).toBe(imported[0]?.id);
    const watcherPromoted = await pool.query<{
      projection_work_class: string;
    }>("select projection_work_class from conversation_items where id = $1", [
      imported[0]?.id
    ]);
    expect(watcherPromoted.rows[0]?.projection_work_class).toBe(
      "live_capture_projection"
    );

    const live = await repo.createConversationItems(
      { userId: owner.id },
      {
        items: [
          {
            ...transcriptItem({
              sessionId: session.id,
              transport: "hook",
              path: "/different/local/path.jsonl"
            }),
            capturedProject: { name: "Later detection" }
          }
        ]
      }
    );
    expect(live[0]?.id).toBe(imported[0]?.id);
    const otherOwner = await repo.createUser({
      email: `dedup-other-${randomUUID()}@example.com`
    });
    const otherSession = await repo.createCapturedSession(
      { userId: otherOwner.id },
      {
        externalSessionId: "codex-source-session",
        idempotencyKey: `other-session-${randomUUID()}`
      }
    );
    const otherItem = await repo.createConversationItems(
      { userId: otherOwner.id },
      {
        items: [
          transcriptItem({ sessionId: otherSession.id, transport: "hook" })
        ]
      }
    );
    expect(otherItem[0]?.id).not.toBe(imported[0]?.id);

    const observations = await pool.query<{ source_transport: string }>(
      `select source_transport
       from conversation_item_observations
       where owner_user_id = $1 and conversation_item_id = $2
       order by source_transport`,
      [owner.id, imported[0]?.id]
    );
    expect(observations.rows.map((row) => row.source_transport)).toEqual([
      "historical_import",
      "hook",
      "transcript"
    ]);

    const raw = await pool.query<{
      count: string;
      source_transport: string;
      projection_work_class: string;
      captured_project: Record<string, unknown>;
      import_observed_at: Date | null;
      event_time: Date | null;
      observed_at: Date;
      projected_at: Date | null;
    }>(
      `select count(*) over ()::text count, source_transport,
         projection_work_class, captured_project, import_observed_at,
         event_time, observed_at, projected_at
       from conversation_items where owner_user_id = $1
         and external_session_id = 'codex-source-session'`,
      [owner.id]
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]).toMatchObject({
      count: "1",
      source_transport: "hook",
      projection_work_class: "live_capture_projection",
      captured_project: { name: "Captured", path: "/private/captured" }
    });
    expect(raw.rows[0]?.import_observed_at?.toISOString()).toBe(
      "2026-07-02T00:00:00.000Z"
    );
    expect(raw.rows[0]?.event_time?.getTime()).not.toBe(
      raw.rows[0]?.observed_at.getTime()
    );
    await repo.projectPendingConversationItems(
      { userId: owner.id },
      { workClass: "live_capture_projection", limit: 10 }
    );
    const projected = await pool.query<{ count: string }>(
      "select count(*)::text count from memory_events where owner_user_id = $1",
      [owner.id]
    );
    expect(projected.rows[0]?.count).toBe("1");
    const teamArtifacts = await pool.query<{ grants: string; access: string }>(
      `select
        (select count(*) from team_session_share_grants where owner_user_id = $1)::text grants,
        (select count(*) from team_workspace_access_grants where user_id = $1)::text access`,
      [owner.id]
    );
    expect(teamArtifacts.rows[0]).toEqual({ grants: "0", access: "0" });
  });

  it("converges Hook-first, watcher-first, and historical-first item observations with immutable provenance", async () => {
    const repo = createMemorySourceRepository(pool);
    const owner = await repo.createUser({
      email: `transport-order-${randomUUID()}@example.com`
    });
    for (const order of [
      ["hook", "transcript", "historical_import"],
      ["transcript", "historical_import", "hook"],
      ["historical_import", "hook", "transcript"]
    ] as const) {
      const externalSessionId = `transport-${randomUUID()}`;
      const session = await repo.createCapturedSession(
        { userId: owner.id },
        {
          externalSessionId,
          idempotencyKey: `session-${externalSessionId}`
        }
      );
      const canonicalKey = `conversation-item:${randomUUID()}`;
      const ids: string[] = [];
      for (const transport of order) {
        const [item] = await repo.createConversationItems(
          { userId: owner.id },
          {
            items: [
              {
                ...transcriptItem({
                  sessionId: session.id,
                  transport,
                  path:
                    transport === "historical_import"
                      ? undefined
                      : `/private/${transport}.jsonl`
                }),
                externalSessionId,
                externalThreadId: externalSessionId,
                idempotencyKey: canonicalKey,
                metadata: {
                  transcriptByteOffset: 128,
                  transcriptItemDiscriminator: "primary:codex_transcript_user",
                  ...(transport === "hook"
                    ? { observedViaHook: true }
                    : transport === "transcript"
                      ? { observedViaTranscript: true }
                      : { observedViaHistoricalImport: true })
                }
              }
            ]
          }
        );
        ids.push(item!.id);
      }
      expect(new Set(ids).size).toBe(1);
      const observations = await pool.query<{ source_transport: string }>(
        `select source_transport from conversation_item_observations
         where conversation_item_id = $1 order by source_transport`,
        [ids[0]]
      );
      expect(observations.rows.map((row) => row.source_transport)).toEqual([
        "historical_import",
        "hook",
        "transcript"
      ]);
    }
  });
});
