import type {
  HistoricalImportRunDetail,
  HistoricalImportRunRecord,
  HistoricalImportSourceRecord,
  MemorySourceRepository
} from "@koed/db";
import type { KoedJobQueue } from "@koed/shared";
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

export interface HistoricalImportRouteOptions {
  embeddingQueue: KoedJobQueue<unknown> | null;
  compactionQueue: KoedJobQueue<unknown> | null;
  assumeQueuesReady?: boolean;
}

export type HistoricalImportAdmission =
  | {
      admitted: true;
      pressure: {
        liveProjectionRows: number;
        interactiveQuestionRows: number;
        historicalImportRows: number;
        historicalImportBytes: number;
      };
    }
  | {
      admitted: false;
      reason:
        | "admission_unavailable"
        | "queue_degraded"
        | "embedding_service_degraded"
        | "live_projection_pressure"
        | "interactive_pressure";
      pressure?: {
        liveProjectionRows: number;
        interactiveQuestionRows: number;
        historicalImportRows: number;
        historicalImportBytes: number;
      };
    };

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

type HistoricalBatchInput = ReturnType<
  typeof historicalImportBatchSchema.parse
>;

const queueReady = async (
  queue: KoedJobQueue<unknown> | null,
  assumeReady: boolean
): Promise<boolean> => {
  if (!queue) return assumeReady;
  try {
    await queue.getJobCounts("waiting", "active");
    return true;
  } catch {
    return false;
  }
};

const historicalImportAdmission = async (
  context: ApiRouteContext,
  options: HistoricalImportRouteOptions
): Promise<HistoricalImportAdmission> => {
  const repo = context.requireRepository();
  try {
    const [backlog, embedding, embeddingQueueReady, compactionQueueReady] =
      await Promise.all([
        repo.getConversationProjectionBacklog(),
        repo.getLocalEmbeddingStatus(),
        queueReady(options.embeddingQueue, options.assumeQueuesReady ?? false),
        queueReady(options.compactionQueue, options.assumeQueuesReady ?? false)
      ]);
    const pressure = {
      liveProjectionRows: backlog.liveProjectionRows,
      interactiveQuestionRows: backlog.interactiveQuestionRows,
      historicalImportRows: backlog.historicalImportRows,
      historicalImportBytes: backlog.historicalImportBytes
    };
    if (!embeddingQueueReady || !compactionQueueReady) {
      return { admitted: false, reason: "queue_degraded", pressure };
    }
    if (!embedding.healthy) {
      return {
        admitted: false,
        reason: "embedding_service_degraded",
        pressure
      };
    }
    if (
      pressure.liveProjectionRows >
      context.config.historicalImport.maxLiveProjectionRows
    ) {
      return { admitted: false, reason: "live_projection_pressure", pressure };
    }
    if (
      pressure.interactiveQuestionRows >
      context.config.historicalImport.maxInteractiveQuestionRows
    ) {
      return { admitted: false, reason: "interactive_pressure", pressure };
    }
    return { admitted: true, pressure };
  } catch {
    return { admitted: false, reason: "admission_unavailable" };
  }
};

const requireHistoricalImportAdmission = async (
  context: ApiRouteContext,
  options: HistoricalImportRouteOptions
): Promise<void> => {
  const admission = await historicalImportAdmission(context, options);
  if (!admission.admitted) {
    throw Object.assign(new Error(admission.reason), { statusCode: 409 });
  }
};

const exactBatchReplay = (
  source: HistoricalImportSourceRecord,
  input: HistoricalBatchInput
): boolean =>
  source.checkpointOffset === input.checkpointOffset &&
  source.checkpointLine === input.checkpointLine &&
  source.checkpointHash === input.checkpointHash &&
  input.checkpointOffset > input.expectedCheckpointOffset;

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

const ingestHistoricalBatch = (
  context: ApiRouteContext,
  userId: string,
  sourceId: string,
  input: HistoricalBatchInput
) =>
  context.requireRepository().ingestHistoricalImportBatch(
    { userId },
    {
      sourceId,
      ...input,
      items: input.items.map((item) => ({
        ...item,
        sourceKind: "codex",
        sourceAdapterVersion: "codex-transcript-v1",
        sourceTransport: "historical_import"
      }))
    }
  );

const registerAdmissionRoute = (
  app: FastifyInstance,
  context: ApiRouteContext,
  options: HistoricalImportRouteOptions
): void => {
  app.get(
    "/v1/historical-import-admission",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      requireLocalImportSurface(context);
      await context.auth.authenticate(request);
      return { admission: await historicalImportAdmission(context, options) };
    }
  );
};

const registerBatchRoute = (
  app: FastifyInstance,
  context: ApiRouteContext,
  options: HistoricalImportRouteOptions
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
      const repo = context.requireRepository();
      const currentSource = await requireSource(repo, user.id, sourceId);
      if (!exactBatchReplay(currentSource, input)) {
        await requireHistoricalImportAdmission(context, options);
      }
      const { items, source, policy, replayed } = await ingestHistoricalBatch(
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
        source: presentSource(source),
        policy,
        replayed
      };
    }
  );
};

export const registerHistoricalImportRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext,
  options: HistoricalImportRouteOptions
): void => {
  registerCreateRunRoute(app, context);
  registerListRunsRoute(app, context);
  registerGetRunRoute(app, context);
  registerCreateSourceRoute(app, context);
  registerRunTransitionRoute(app, context);
  registerSourceTransitionRoute(app, context);
  registerAdmissionRoute(app, context, options);
  registerBatchRoute(app, context, options);
};
