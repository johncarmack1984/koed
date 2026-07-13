import { createHash } from "node:crypto";
import type {
  HistoricalImportRunDetail,
  HistoricalImportRunRecord,
  HistoricalImportSourceRecord,
  MemorySourceRepository
} from "@koed/db";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../server/context.js";
import {
  createHistoricalImportSourceSchema,
  historicalImportBatchSchema,
  historicalImportRunListSchema,
  historicalImportRunParamsSchema,
  historicalImportSourceParamsSchema,
  historicalImportTransitionSchema
} from "./historical-import-schemas.js";

const localProfiles = new Set(["developer", "local_personal"]);

const requireLocalImportSurface = (context: ApiRouteContext): void => {
  if (!localProfiles.has(context.config.deploymentProfile)) {
    throw Object.assign(new Error("Historical import is local-only"), {
      statusCode: 404
    });
  }
};

const safeProjectProvenance = (
  project: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    ["name", "branch", "ref", "fingerprint"]
      .filter((key) => project[key] !== undefined)
      .map((key) => [key, project[key]])
  );

const presentSource = (source: HistoricalImportSourceRecord) => {
  const safe = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        key !== "localSourcePath" &&
        key !== "redactedSourceLabel" &&
        key !== "detectedProject"
    )
  );
  return {
    ...safe,
    sourceLabel: source.redactedSourceLabel,
    detectedProject: safeProjectProvenance(source.detectedProject)
  };
};

const presentRun = (
  run: HistoricalImportRunRecord | HistoricalImportRunDetail
) => ({
  ...run,
  ...("sources" in run ? { sources: run.sources.map(presentSource) } : {})
});

const requireSource = async (
  repo: MemorySourceRepository,
  userId: string,
  sourceId: string
): Promise<HistoricalImportSourceRecord> => {
  const source = await repo.getHistoricalImportSource({ userId }, sourceId);
  if (!source) {
    throw Object.assign(new Error("Historical import source not found"), {
      statusCode: 404
    });
  }
  return source;
};

const policyProjectId = (
  source: HistoricalImportSourceRecord
): string | undefined => {
  for (const key of ["projectId", "path", "cwd"] as const) {
    const value = source.detectedProject[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
};

const requireImportPolicy = async (
  context: ApiRouteContext,
  repo: MemorySourceRepository,
  userId: string,
  source: HistoricalImportSourceRecord
) => {
  const policy = await context.capture.resolveCapturePolicyForRequest(
    repo,
    { userId },
    {
      workspaceId: policyProjectId(source),
      threadId: source.sourceSessionId
    }
  );
  if (
    policy.visibility !== "personal" ||
    policy.captureState !== "enabled" ||
    policy.paused
  ) {
    throw Object.assign(
      new Error("Historical import blocked by effective Capture Policy"),
      { statusCode: 409 }
    );
  }
  return policy;
};

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const canonicalHistoricalItemIdentity = (
  source: HistoricalImportSourceRecord,
  item: {
    sourceSequence?: number;
    sourceLineNumber?: number;
    logicalSourceId?: string;
    transportChunkIndex?: number;
    transportChunkCount?: number;
    externalItemId?: string;
    sourceEventType?: string;
    sourceRecordType: string;
    rawJson: unknown;
    metadata: Record<string, unknown>;
  }
): { sourceHash: string; idempotencyKey: string } => {
  if (
    item.logicalSourceId &&
    (item.transportChunkCount ?? 1) > 1 &&
    item.transportChunkIndex !== undefined
  ) {
    const chunkHash = hash({
      sourceHash: item.logicalSourceId,
      transportChunkIndex: item.transportChunkIndex,
      transportChunkCount: item.transportChunkCount
    });
    return { sourceHash: chunkHash, idempotencyKey: chunkHash };
  }
  const recordHash = hash(item.rawJson);
  const transcriptPosition =
    typeof item.metadata.transcriptByteOffset === "number"
      ? item.metadata.transcriptByteOffset
      : (item.sourceSequence ?? item.sourceLineNumber);
  if (transcriptPosition === undefined) {
    throw Object.assign(new Error("Transcript item position is required"), {
      statusCode: 400
    });
  }
  const itemDiscriminator =
    typeof item.metadata.transcriptItemDiscriminator === "string"
      ? item.metadata.transcriptItemDiscriminator
      : (item.externalItemId ?? item.sourceEventType ?? item.sourceRecordType);
  return {
    sourceHash: hash({ recordHash, itemDiscriminator }),
    idempotencyKey: `conversation-item:${hash({
      version: 3,
      aiClient: source.sourceKind,
      sourceSessionId: source.sourceSessionId,
      transcriptPosition,
      itemDiscriminator,
      recordHash
    })}`
  };
};

const createImportedSession = async (
  repo: MemorySourceRepository,
  userId: string,
  source: HistoricalImportSourceRecord,
  observedAt: string
) =>
  repo.createCapturedSession(
    { userId },
    {
      externalSessionId: source.sourceSessionId,
      sourceRuntime: "codex",
      captureMethod: "api",
      idempotencyKey: `historical-import-session:${userId}:${source.sourceKind}:${source.sourceSessionId}`,
      sourceHash: source.sourceFingerprint,
      sourceKind: source.sourceKind,
      sourceAdapterVersion: "codex-transcript-v1",
      sourceFingerprint: source.sourceFingerprint,
      capturedProject: source.detectedProject,
      importObservedAt: observedAt,
      metadata: {
        sourceTransport: "historical_import",
        historicalImportSourceId: source.id,
        capturedProjectProvenanceStoredSeparately: true
      }
    }
  );

type HistoricalBatchInput = ReturnType<
  typeof historicalImportBatchSchema.parse
>;

const registerCreateRunRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.post(
    "/v1/historical-imports",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const run = await context.requireRepository().createHistoricalImportRun({
        userId: user.id
      });
      return { run: presentRun(run) };
    }
  );
};

const registerListRunsRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.get(
    "/v1/historical-imports",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const query = historicalImportRunListSchema.parse(request.query);
      const runs = await context
        .requireRepository()
        .listHistoricalImportRuns({ userId: user.id }, query);
      return { runs: runs.map(presentRun) };
    }
  );
};

const registerGetRunRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.get(
    "/v1/historical-imports/:runId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const { runId } = historicalImportRunParamsSchema.parse(request.params);
      const run = await context
        .requireRepository()
        .getHistoricalImportRun({ userId: user.id }, runId);
      if (!run) {
        throw Object.assign(new Error("Historical import run not found"), {
          statusCode: 404
        });
      }
      return { run: presentRun(run) };
    }
  );
};

const registerCreateSourceRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.post(
    "/v1/historical-import-sources",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const input = createHistoricalImportSourceSchema.parse(request.body);
      const source = await context
        .requireRepository()
        .createHistoricalImportSource({ userId: user.id }, input);
      if (!source) {
        throw Object.assign(new Error("Historical import run not found"), {
          statusCode: 409
        });
      }
      return { source: presentSource(source) };
    }
  );
};

const registerRunTransitionRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.patch(
    "/v1/historical-imports/:runId",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const { runId } = historicalImportRunParamsSchema.parse(request.params);
      const input = historicalImportTransitionSchema.parse(request.body);
      const run = await context
        .requireRepository()
        .transitionHistoricalImportRun(
          { userId: user.id },
          { runId, ...input }
        );
      if (!run) {
        throw Object.assign(new Error("Historical import run state conflict"), {
          statusCode: 409
        });
      }
      return { run: presentRun(run) };
    }
  );
};

const registerSourceTransitionRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.patch(
    "/v1/historical-import-sources/:sourceId",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const { sourceId } = historicalImportSourceParamsSchema.parse(
        request.params
      );
      const input = historicalImportTransitionSchema.parse(request.body);
      const repo = context.requireRepository();
      const source = await requireSource(repo, user.id, sourceId);
      if (input.state === "eligible" || input.state === "queued") {
        await requireImportPolicy(context, repo, user.id, source);
      }
      const updated = await repo.transitionHistoricalImportSource(
        { userId: user.id },
        { sourceId, ...input }
      );
      if (!updated) {
        throw Object.assign(
          new Error("Historical import source state conflict"),
          { statusCode: 409 }
        );
      }
      return { source: presentSource(updated) };
    }
  );
};

const validateBatchSource = (
  source: HistoricalImportSourceRecord,
  input: HistoricalBatchInput
): void => {
  if (!["queued", "importing"].includes(source.state)) {
    throw Object.assign(new Error("Historical import source is not writable"), {
      statusCode: 409
    });
  }
  if (source.checkpointOffset !== input.expectedCheckpointOffset) {
    throw Object.assign(new Error("Historical import checkpoint conflict"), {
      statusCode: 409
    });
  }
  if ((source.sourceSizeBytes ?? 0) > input.sourceSizeBytes) {
    throw Object.assign(new Error("Historical import source was truncated"), {
      statusCode: 409
    });
  }
};

const importedConversationItems = (
  source: HistoricalImportSourceRecord,
  input: HistoricalBatchInput,
  sessionId: string,
  observedAt: string
) =>
  input.items.map((item) => ({
    ...item,
    ...canonicalHistoricalItemIdentity(source, item),
    visibility: "personal" as const,
    sessionId,
    turnId: undefined,
    sourceKind: source.sourceKind,
    sourceAdapterVersion: "codex-transcript-v1",
    sourceTransport: "historical_import" as const,
    externalSessionId: source.sourceSessionId,
    sourcePath: undefined,
    importObservedAt: observedAt,
    sourceFingerprint: source.sourceFingerprint,
    capturedProject: source.detectedProject,
    projectionStatus: "pending" as const,
    projectionVersion: "codex-transcript-v1",
    metadata: {
      ...item.metadata,
      historicalImportRunId: source.runId,
      historicalImportSourceId: source.id,
      sourceFingerprint: source.sourceFingerprint
    }
  }));

const ingestHistoricalBatch = async (
  context: ApiRouteContext,
  userId: string,
  sourceId: string,
  input: HistoricalBatchInput
) => {
  const repo = context.requireRepository();
  const source = await requireSource(repo, userId, sourceId);
  if (
    input.checkpointOffset > input.expectedCheckpointOffset &&
    source.checkpointOffset === input.checkpointOffset
  ) {
    const policy = await requireImportPolicy(context, repo, userId, source);
    return { items: [], updated: source, policy, replayed: true };
  }
  validateBatchSource(source, input);
  const policy = await requireImportPolicy(context, repo, userId, source);
  const observedAt = new Date().toISOString();
  const session = await createImportedSession(repo, userId, source, observedAt);
  const items = await repo.createConversationItems(
    { userId },
    { items: importedConversationItems(source, input, session.id, observedAt) }
  );
  const updated = await repo.advanceHistoricalImportSource(
    { userId },
    {
      sourceId,
      expectedCheckpointOffset: input.expectedCheckpointOffset,
      checkpointOffset: input.checkpointOffset,
      checkpointLine: input.checkpointLine,
      sourceSizeBytes: input.sourceSizeBytes,
      importedRecordCount: items.length,
      skippedRecordCount: input.skippedRecordCount,
      malformedRecordCount: input.malformedRecordCount,
      sourceEventFrom: input.sourceEventFrom,
      sourceEventTo: input.sourceEventTo
    }
  );
  if (!updated) {
    throw Object.assign(new Error("Historical import checkpoint conflict"), {
      statusCode: 409
    });
  }
  return { items, updated, policy, replayed: false };
};

const registerBatchRoute = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.post(
    "/v1/historical-import-sources/:sourceId/batches",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      requireLocalImportSurface(context);
      const user = await context.auth.authenticate(request);
      const { sourceId } = historicalImportSourceParamsSchema.parse(
        request.params
      );
      const input = historicalImportBatchSchema.parse(request.body);
      const { items, updated, policy, replayed } = await ingestHistoricalBatch(
        context,
        user.id,
        sourceId,
        input
      );
      return {
        items: items.map((item) => ({
          ...item,
          capturedProject: safeProjectProvenance(item.capturedProject)
        })),
        source: presentSource(updated),
        policy,
        replayed
      };
    }
  );
};

export const registerHistoricalImportRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  registerCreateRunRoute(app, context);
  registerListRunsRoute(app, context);
  registerGetRunRoute(app, context);
  registerCreateSourceRoute(app, context);
  registerRunTransitionRoute(app, context);
  registerSourceTransitionRoute(app, context);
  registerBatchRoute(app, context);
};
