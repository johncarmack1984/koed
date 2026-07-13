import path from "node:path";
import type pg from "pg";
import type {
  ActorContext,
  HistoricalImportRunDetail,
  HistoricalImportRunRecord,
  HistoricalImportSourceRecord,
  HistoricalImportState
} from "./types.js";

export interface HistoricalImportRepository {
  createHistoricalImportRun(
    actor: ActorContext
  ): Promise<HistoricalImportRunRecord>;
  listHistoricalImportRuns(
    actor: ActorContext,
    input?: { limit?: number }
  ): Promise<HistoricalImportRunRecord[]>;
  getHistoricalImportRun(
    actor: ActorContext,
    runId: string
  ): Promise<HistoricalImportRunDetail | null>;
  createHistoricalImportSource(
    actor: ActorContext,
    input: CreateHistoricalImportSourceInput
  ): Promise<HistoricalImportSourceRecord | null>;
  transitionHistoricalImportRun(
    actor: ActorContext,
    input: TransitionHistoricalImportRunInput
  ): Promise<HistoricalImportRunRecord | null>;
  transitionHistoricalImportSource(
    actor: ActorContext,
    input: TransitionHistoricalImportSourceInput
  ): Promise<HistoricalImportSourceRecord | null>;
  advanceHistoricalImportSource(
    actor: ActorContext,
    input: AdvanceHistoricalImportSourceInput
  ): Promise<HistoricalImportSourceRecord | null>;
  getHistoricalImportSource(
    actor: ActorContext,
    sourceId: string
  ): Promise<HistoricalImportSourceRecord | null>;
}

type CreateHistoricalImportSourceInput = {
  runId: string;
  aiClient: string;
  sourceKind: string;
  sourceSessionId: string;
  sourceFingerprint: string;
  localSourcePath: string;
  sourceSizeBytes?: number;
  sourceModifiedAt?: string;
  sourceEventFrom?: string;
  sourceEventTo?: string;
  discoveredRecordCount?: number;
  detectedProject?: Record<string, unknown>;
};

type TransitionHistoricalImportRunInput = {
  runId: string;
  expectedState: HistoricalImportState;
  state: HistoricalImportState;
  failureReason?: string | null;
  nextRetryAt?: string | null;
};

type TransitionHistoricalImportSourceInput = {
  sourceId: string;
  expectedState: HistoricalImportState;
  state: HistoricalImportState;
  failureReason?: string | null;
  nextRetryAt?: string | null;
};

type AdvanceHistoricalImportSourceInput = {
  sourceId: string;
  expectedCheckpointOffset: number;
  checkpointOffset: number;
  checkpointLine: number;
  sourceSizeBytes: number;
  importedRecordCount: number;
  skippedRecordCount?: number;
  malformedRecordCount?: number;
  sourceEventFrom?: string;
  sourceEventTo?: string;
};

type RunRow = {
  id: string;
  owner_user_id: string;
  state: HistoricalImportState;
  source_count: number;
  completed_source_count: number;
  failed_source_count: number;
  skipped_source_count: number;
  discovered_record_count: number;
  imported_record_count: number;
  skipped_record_count: number;
  scanned_byte_count: string | number;
  retry_count: number;
  failure_reason: string | null;
  next_retry_at: Date | null;
  discovered_at: Date;
  eligible_at: Date | null;
  queued_at: Date | null;
  import_started_at: Date | null;
  paused_at: Date | null;
  skipped_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  last_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type SourceRow = {
  id: string;
  run_id: string;
  owner_user_id: string;
  state: HistoricalImportState;
  ai_client: string;
  source_kind: string;
  source_session_id: string;
  source_fingerprint: string;
  local_source_path: string;
  redacted_source_label: string;
  checkpoint_offset: string | number;
  checkpoint_line: number;
  source_size_bytes: string | number | null;
  source_modified_at: Date | null;
  source_event_from: Date | null;
  source_event_to: Date | null;
  discovered_record_count: number;
  imported_record_count: number;
  skipped_record_count: number;
  malformed_record_count: number;
  retry_count: number;
  failure_reason: string | null;
  next_retry_at: Date | null;
  detected_project: Record<string, unknown>;
  discovered_at: Date;
  eligible_at: Date | null;
  queued_at: Date | null;
  import_started_at: Date | null;
  paused_at: Date | null;
  skipped_at: Date | null;
  completed_at: Date | null;
  failed_at: Date | null;
  last_observed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

const mapRun = (row: RunRow): HistoricalImportRunRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  state: row.state,
  sourceCount: row.source_count,
  completedSourceCount: row.completed_source_count,
  failedSourceCount: row.failed_source_count,
  skippedSourceCount: row.skipped_source_count,
  discoveredRecordCount: row.discovered_record_count,
  importedRecordCount: row.imported_record_count,
  skippedRecordCount: row.skipped_record_count,
  scannedByteCount: Number(row.scanned_byte_count),
  retryCount: row.retry_count,
  failureReason: row.failure_reason,
  nextRetryAt: iso(row.next_retry_at),
  discoveredAt: row.discovered_at.toISOString(),
  eligibleAt: iso(row.eligible_at),
  queuedAt: iso(row.queued_at),
  importStartedAt: iso(row.import_started_at),
  pausedAt: iso(row.paused_at),
  skippedAt: iso(row.skipped_at),
  completedAt: iso(row.completed_at),
  failedAt: iso(row.failed_at),
  lastAttemptAt: iso(row.last_attempt_at),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const mapSource = (row: SourceRow): HistoricalImportSourceRecord => ({
  id: row.id,
  runId: row.run_id,
  ownerUserId: row.owner_user_id,
  state: row.state,
  aiClient: row.ai_client,
  sourceKind: row.source_kind,
  sourceSessionId: row.source_session_id,
  sourceFingerprint: row.source_fingerprint,
  localSourcePath: row.local_source_path,
  redactedSourceLabel: row.redacted_source_label,
  checkpointOffset: Number(row.checkpoint_offset),
  checkpointLine: row.checkpoint_line,
  sourceSizeBytes:
    row.source_size_bytes === null ? null : Number(row.source_size_bytes),
  sourceModifiedAt: iso(row.source_modified_at),
  sourceEventFrom: iso(row.source_event_from),
  sourceEventTo: iso(row.source_event_to),
  discoveredRecordCount: row.discovered_record_count,
  importedRecordCount: row.imported_record_count,
  skippedRecordCount: row.skipped_record_count,
  malformedRecordCount: row.malformed_record_count,
  retryCount: row.retry_count,
  failureReason: row.failure_reason,
  nextRetryAt: iso(row.next_retry_at),
  detectedProject: row.detected_project,
  discoveredAt: row.discovered_at.toISOString(),
  eligibleAt: iso(row.eligible_at),
  queuedAt: iso(row.queued_at),
  importStartedAt: iso(row.import_started_at),
  pausedAt: iso(row.paused_at),
  skippedAt: iso(row.skipped_at),
  completedAt: iso(row.completed_at),
  failedAt: iso(row.failed_at),
  lastObservedAt: iso(row.last_observed_at),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const allowedTransitions: Record<
  HistoricalImportState,
  HistoricalImportState[]
> = {
  discovered: ["eligible", "paused", "skipped", "failed"],
  eligible: ["queued", "paused", "skipped", "failed"],
  queued: ["importing", "paused", "skipped", "failed"],
  importing: ["paused", "completed", "failed"],
  paused: ["eligible", "queued", "importing", "skipped", "failed"],
  skipped: ["eligible"],
  completed: [],
  failed: ["queued", "skipped"]
};

export const validateHistoricalImportTransition = (
  from: HistoricalImportState,
  to: HistoricalImportState
): void => {
  if (!allowedTransitions[from].includes(to)) {
    throw Object.assign(
      new Error(`Invalid historical import transition: ${from} -> ${to}`),
      { statusCode: 409 }
    );
  }
};

const validateTransitionFailure = (input: {
  state: HistoricalImportState;
  failureReason?: string | null;
}): void => {
  if (input.state === "failed" && !input.failureReason?.trim()) {
    throw Object.assign(
      new Error("Failed import state requires failure reason"),
      { statusCode: 400 }
    );
  }
  if (
    input.failureReason &&
    !/^[a-z0-9_.:-]{1,128}$/.test(input.failureReason)
  ) {
    throw Object.assign(
      new Error("Import failure reason must be a safe code"),
      {
        statusCode: 400
      }
    );
  }
};

const sourceLabel = (localSourcePath: string): string => {
  const normalized = localSourcePath.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  return basename && basename !== "." ? `…/${basename}` : "…/Codex history";
};

const refreshRunCounters = async (
  pool: pg.Pool,
  ownerUserId: string,
  runId: string
): Promise<void> => {
  await pool.query(
    `
      update historical_import_runs r set
        source_count = stats.source_count,
        completed_source_count = stats.completed_source_count,
        failed_source_count = stats.failed_source_count,
        skipped_source_count = stats.skipped_source_count,
        discovered_record_count = stats.discovered_record_count,
        imported_record_count = stats.imported_record_count,
        skipped_record_count = stats.skipped_record_count,
        scanned_byte_count = stats.scanned_byte_count,
        updated_at = now()
      from (
        select count(*)::int source_count,
          count(*) filter (where state = 'completed')::int completed_source_count,
          count(*) filter (where state = 'failed')::int failed_source_count,
          count(*) filter (where state = 'skipped')::int skipped_source_count,
          coalesce(sum(discovered_record_count), 0)::int discovered_record_count,
          coalesce(sum(imported_record_count), 0)::int imported_record_count,
          coalesce(sum(skipped_record_count), 0)::int skipped_record_count,
          coalesce(sum(checkpoint_offset), 0)::bigint scanned_byte_count
        from historical_import_sources
        where run_id = $2 and owner_user_id = $1
      ) stats
      where r.id = $2 and r.owner_user_id = $1
    `,
    [ownerUserId, runId]
  );
};

const getRun = async (
  pool: pg.Pool,
  actor: ActorContext,
  runId: string
): Promise<HistoricalImportRunRecord | null> => {
  const result = await pool.query<RunRow>(
    "select * from historical_import_runs where id = $2 and owner_user_id = $1",
    [actor.userId, runId]
  );
  return result.rows[0] ? mapRun(result.rows[0]) : null;
};

const getSource = async (
  pool: pg.Pool,
  actor: ActorContext,
  sourceId: string
): Promise<HistoricalImportSourceRecord | null> => {
  const result = await pool.query<SourceRow>(
    "select * from historical_import_sources where id = $2 and owner_user_id = $1",
    [actor.userId, sourceId]
  );
  return result.rows[0] ? mapSource(result.rows[0]) : null;
};

const transitionTimestampSql = `
  eligible_at = case when $4 = 'eligible' then now() else eligible_at end,
  queued_at = case when $4 = 'queued' then now() else queued_at end,
  import_started_at = case when $4 = 'importing' then coalesce(import_started_at, now()) else import_started_at end,
  paused_at = case when $4 = 'paused' then now() else paused_at end,
  skipped_at = case when $4 = 'skipped' then now() else skipped_at end,
  completed_at = case when $4 = 'completed' then now() else completed_at end,
  failed_at = case when $4 = 'failed' then now() else failed_at end
`;

export const createHistoricalImportRepository = (
  pool: pg.Pool
): HistoricalImportRepository => ({
  async createHistoricalImportRun(actor) {
    const result = await pool.query<RunRow>(
      "insert into historical_import_runs (owner_user_id) values ($1) returning *",
      [actor.userId]
    );
    return mapRun(result.rows[0]!);
  },

  async listHistoricalImportRuns(actor, input = {}) {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const result = await pool.query<RunRow>(
      `select * from historical_import_runs
       where owner_user_id = $1 order by updated_at desc, id desc limit $2`,
      [actor.userId, limit]
    );
    return result.rows.map(mapRun);
  },

  async getHistoricalImportRun(actor, runId) {
    const run = await getRun(pool, actor, runId);
    if (!run) {
      return null;
    }
    const sources = await pool.query<SourceRow>(
      `select * from historical_import_sources
       where run_id = $2 and owner_user_id = $1 order by discovered_at, id`,
      [actor.userId, runId]
    );
    return { ...run, sources: sources.rows.map(mapSource) };
  },

  async createHistoricalImportSource(actor, input) {
    if (!(await getRun(pool, actor, input.runId))) {
      return null;
    }
    const result = await pool.query<SourceRow>(
      `insert into historical_import_sources (
         run_id, owner_user_id, ai_client, source_kind, source_session_id,
         source_fingerprint, local_source_path, redacted_source_label,
         source_size_bytes, source_modified_at, source_event_from,
         source_event_to, discovered_record_count, detected_project
       )
       select r.id, r.owner_user_id, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14
       from historical_import_runs r
       where r.id = $2 and r.owner_user_id = $1
       on conflict (owner_user_id, ai_client, source_kind, source_session_id, source_fingerprint)
       do nothing returning *`,
      [
        actor.userId,
        input.runId,
        input.aiClient,
        input.sourceKind,
        input.sourceSessionId,
        input.sourceFingerprint,
        input.localSourcePath,
        sourceLabel(input.localSourcePath),
        input.sourceSizeBytes ?? null,
        input.sourceModifiedAt ?? null,
        input.sourceEventFrom ?? null,
        input.sourceEventTo ?? null,
        input.discoveredRecordCount ?? 0,
        input.detectedProject ?? {}
      ]
    );
    const existing = result.rows[0]
      ? result.rows[0]
      : (
          await pool.query<SourceRow>(
            `select * from historical_import_sources where owner_user_id = $1
             and ai_client = $2 and source_kind = $3
             and source_session_id = $4 and source_fingerprint = $5`,
            [
              actor.userId,
              input.aiClient,
              input.sourceKind,
              input.sourceSessionId,
              input.sourceFingerprint
            ]
          )
        ).rows[0];
    const source = existing ? mapSource(existing) : null;
    if (source) {
      await refreshRunCounters(pool, actor.userId, source.runId);
    }
    return source;
  },

  async transitionHistoricalImportRun(actor, input) {
    validateHistoricalImportTransition(input.expectedState, input.state);
    validateTransitionFailure(input);
    const result = await pool.query<RunRow>(
      `update historical_import_runs set state = $4, failure_reason = $5,
         next_retry_at = $6, retry_count = retry_count +
           case when state = 'failed' and $4 = 'queued' then 1 else 0 end,
         last_attempt_at = case when $4 in ('queued', 'importing') then now() else last_attempt_at end,
         ${transitionTimestampSql}, updated_at = now()
       where owner_user_id = $1 and id = $2 and state = $3 returning *`,
      [
        actor.userId,
        input.runId,
        input.expectedState,
        input.state,
        input.failureReason ?? null,
        input.nextRetryAt ?? null
      ]
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  },

  async transitionHistoricalImportSource(actor, input) {
    validateHistoricalImportTransition(input.expectedState, input.state);
    validateTransitionFailure(input);
    const result = await pool.query<SourceRow>(
      `update historical_import_sources set state = $4, failure_reason = $5,
         next_retry_at = $6, retry_count = retry_count +
           case when state = 'failed' and $4 = 'queued' then 1 else 0 end,
         ${transitionTimestampSql}, updated_at = now()
       where owner_user_id = $1 and id = $2 and state = $3 returning *`,
      [
        actor.userId,
        input.sourceId,
        input.expectedState,
        input.state,
        input.failureReason ?? null,
        input.nextRetryAt ?? null
      ]
    );
    const source = result.rows[0] ? mapSource(result.rows[0]) : null;
    if (source) {
      await refreshRunCounters(pool, actor.userId, source.runId);
    }
    return source;
  },

  async advanceHistoricalImportSource(actor, input) {
    if (
      input.checkpointOffset < input.expectedCheckpointOffset ||
      input.sourceSizeBytes < input.checkpointOffset
    ) {
      throw Object.assign(
        new Error("Historical import checkpoint is invalid"),
        {
          statusCode: 409
        }
      );
    }
    const result = await pool.query<SourceRow>(
      `update historical_import_sources set
         state = 'importing', checkpoint_offset = $4, checkpoint_line = $5,
         source_size_bytes = $6,
         imported_record_count = imported_record_count + $7,
         skipped_record_count = skipped_record_count + $8,
         malformed_record_count = malformed_record_count + $9,
         source_event_from = coalesce(source_event_from, $10),
         source_event_to = greatest(source_event_to, $11),
         import_started_at = coalesce(import_started_at, now()),
         last_observed_at = now(), updated_at = now()
       where owner_user_id = $1 and id = $2 and checkpoint_offset = $3
         and state in ('queued', 'importing') returning *`,
      [
        actor.userId,
        input.sourceId,
        input.expectedCheckpointOffset,
        input.checkpointOffset,
        input.checkpointLine,
        input.sourceSizeBytes,
        input.importedRecordCount,
        input.skippedRecordCount ?? 0,
        input.malformedRecordCount ?? 0,
        input.sourceEventFrom ?? null,
        input.sourceEventTo ?? null
      ]
    );
    const source = result.rows[0] ? mapSource(result.rows[0]) : null;
    if (source) {
      await refreshRunCounters(pool, actor.userId, source.runId);
    }
    return source;
  },

  getHistoricalImportSource: (actor, sourceId) =>
    getSource(pool, actor, sourceId)
});
