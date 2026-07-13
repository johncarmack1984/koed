import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createDbPool,
  createHistoricalImportRepository,
  createMemorySourceRepository,
  runDbMigrations,
  validateHistoricalImportTransition
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const fingerprint = (value: string) => value.padEnd(64, "0").slice(0, 64);

const transcriptItem = (input: {
  sessionId: string;
  transport: "hook" | "historical_import";
  path?: string;
}) => ({
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
  sourceHash: `legacy-${input.transport}`,
  idempotencyKey: `legacy-${input.transport}`,
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
    const ownerHashes = await pool.query<{ source_hash: string }>(
      `select source_hash from conversation_items
       where external_session_id = 'codex-source-session'
         and owner_user_id in ($1, $2) order by owner_user_id`,
      [owner.id, otherOwner.id]
    );
    expect(new Set(ownerHashes.rows.map((row) => row.source_hash)).size).toBe(
      2
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
        (select count(*) from team_session_share_grants where source_owner_user_id = $1)::text grants,
        (select count(*) from team_workspace_access_grants where user_id = $1)::text access`,
      [owner.id]
    );
    expect(teamArtifacts.rows[0]).toEqual({ grants: "0", access: "0" });
  });
});
