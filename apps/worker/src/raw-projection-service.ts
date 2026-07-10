import type { Visibility } from "@koed/core";
import type { EmbeddableSourceType, MemorySourceRepository } from "@koed/db";
import {
  lcmCompactQueueName,
  memoryEmbedQueueName,
  type KoedWorkClass
} from "@koed/shared";
import type { Logger } from "pino";
import {
  decideHistoricalAdmission,
  type HistoricalAdmissionDecision,
  type HistoricalImportBatchConfig
} from "./historical-admission.js";

interface ProjectionReport {
  actors: number;
  noProgressActors: number;
  projected: number;
  scanned: number;
  waitingForAgentSeal: number;
}

interface HistoricalAdmissionHealth {
  apiHealthy: boolean;
  embeddingServiceHealthy: boolean;
  queueHealthy: boolean;
}

export interface RawProjectionServiceConfig {
  actorLimit: number;
  batchLimit: number;
  embeddingDispatchKey: string;
  enqueueLcmCompaction(
    requesterContext: { userId: string },
    visibility: Visibility,
    dispatchKey: string,
    workClass?: KoedWorkClass
  ): Promise<unknown>;
  enqueueProjectedMemoryEventProcessing(
    actor: { userId: string },
    scopes: Awaited<
      ReturnType<MemorySourceRepository["projectPendingConversationItems"]>
    >["memoryEventScopes"]
  ): Promise<unknown>;
  enqueueSourceEmbedding(
    sourceType: EmbeddableSourceType,
    sourceId: string,
    dispatchKey: string,
    workClass?: KoedWorkClass
  ): Promise<unknown>;
  getHistoricalAdmissionHealth(): Promise<HistoricalAdmissionHealth>;
  historicalImport: HistoricalImportBatchConfig;
  intervalMs: number;
  logger: Logger;
  repository: MemorySourceRepository;
}

export interface RawProjectionService {
  run(): Promise<void>;
  start(): void;
  stop(): void;
}

const emptyProjectionReport = (): ProjectionReport => ({
  actors: 0,
  noProgressActors: 0,
  projected: 0,
  scanned: 0,
  waitingForAgentSeal: 0
});

const addProjectionResult = (
  report: ProjectionReport,
  result: Awaited<
    ReturnType<MemorySourceRepository["projectPendingConversationItems"]>
  >
): void => {
  report.actors += 1;
  report.projected += result.rawItemsProjected;
  report.scanned += result.rawItemsScanned;
  report.waitingForAgentSeal += result.rawItemsWaitingForAgentSeal;
  if (result.rawItemsScanned > 0 && result.rawItemsProjected === 0) {
    report.noProgressActors += 1;
  }
};

const projectActors = async (
  config: RawProjectionServiceConfig,
  workClass: "live_capture_projection" | "historical_import_backfill",
  input: { limit: number; maxBytes?: number; maxRuntimeMs?: number },
  actorLimit: number
): Promise<ProjectionReport> => {
  const report = emptyProjectionReport();
  const actors = await config.repository.listConversationProjectionActors({
    limit: actorLimit,
    workClass
  });
  for (const actor of actors) {
    const result = await config.repository.projectPendingConversationItems(
      actor,
      { ...input, workClass }
    );
    await config.enqueueProjectedMemoryEventProcessing(
      actor,
      result.memoryEventScopes
    );
    addProjectionResult(report, result);
  }
  return report;
};

const processRebuildActors = async (
  config: RawProjectionServiceConfig
): Promise<{ jobs: number; events: number }> => {
  const actors = await config.repository.listSemanticMemoryRebuildActors({
    limit: config.actorLimit
  });
  let events = 0;
  let jobs = 0;
  for (const actor of actors) {
    const result = await config.repository.processDueSemanticMemoryRebuilds(
      actor,
      { limit: config.batchLimit }
    );
    await config.enqueueProjectedMemoryEventProcessing(
      actor,
      result.memoryEventScopes
    );
    events += result.memoryEventsCreated;
    jobs += result.jobsCompleted;
  }
  return { events, jobs };
};

const logHistoricalDecision = (
  logger: Logger,
  decision: HistoricalAdmissionDecision,
  backlog: Awaited<
    ReturnType<MemorySourceRepository["getConversationProjectionBacklog"]>
  >,
  report: ProjectionReport
): void => {
  logger.info(
    {
      event: {
        name: "worker.historical_import.admission",
        category: "projection"
      },
      historicalImport: {
        admitted: decision.admitted,
        reason: decision.admitted ? null : decision.reason,
        pendingRows: backlog.historicalImportRows,
        pendingBytes: backlog.historicalImportBytes,
        projectedRows: report.projected,
        scannedRows: report.scanned
      }
    },
    "historical import admission evaluated"
  );
};

const reconcileLcmCompactionJobs = async (
  config: RawProjectionServiceConfig
): Promise<void> => {
  const scopes = await config.repository.listPendingLcmDispatchScopes({
    limit: config.actorLimit
  });
  const results = await Promise.allSettled(
    scopes.map((scope) =>
      config.enqueueLcmCompaction(
        { userId: scope.ownerUserId },
        scope.visibility,
        scope.dispatchKey
      )
    )
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      continue;
    }
    const scope = scopes[index];
    config.logger.warn(
      {
        event: {
          name: "worker.lcm_reconciliation.job_enqueue.failed",
          category: "queue"
        },
        queue: { name: lcmCompactQueueName },
        job: { name: "compact-scope" },
        actor: { user_id: scope?.ownerUserId },
        resource: {
          type: "compaction_scope",
          visibility: scope?.visibility,
          pendingMemoryEventIds: scope?.pendingMemoryEventIds
        },
        err: result.reason
      },
      "could not enqueue pending LCM compaction scope"
    );
  }
};

const reconcileEmbeddingJobs = async (
  config: RawProjectionServiceConfig
): Promise<void> => {
  const sources = await config.repository.listSourcesNeedingEmbeddings(
    config.batchLimit
  );
  const results = await Promise.allSettled(
    sources.map((source) =>
      config.enqueueSourceEmbedding(
        source.sourceType,
        source.sourceId,
        config.embeddingDispatchKey
      )
    )
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      continue;
    }
    const source = sources[index];
    config.logger.warn(
      {
        event: {
          name: "worker.embedding_reconciliation.job_enqueue.failed",
          category: "queue"
        },
        queue: { name: memoryEmbedQueueName },
        job: { name: "embed-source" },
        resource: { type: source?.sourceType, id: source?.sourceId },
        err: result.reason
      },
      "could not enqueue pending embedding source"
    );
  }
};

const runHistoricalBatch = async (
  config: RawProjectionServiceConfig,
  decision: HistoricalAdmissionDecision,
  start: () => void,
  finish: () => void
): Promise<ProjectionReport> => {
  if (!decision.admitted) {
    return emptyProjectionReport();
  }
  start();
  try {
    return await projectActors(
      config,
      "historical_import_backfill",
      {
        limit: config.historicalImport.maxRows,
        maxBytes: config.historicalImport.maxBytes,
        maxRuntimeMs: config.historicalImport.maxRuntimeMs
      },
      config.historicalImport.maxConcurrency
    );
  } finally {
    finish();
  }
};

const logProjectionReport = (
  logger: Logger,
  live: ProjectionReport,
  historical: ProjectionReport
): void => {
  if (live.scanned + historical.scanned === 0) {
    return;
  }
  logger.info(
    {
      event: {
        name: "worker.raw_projection.catchup.completed",
        category: "projection"
      },
      projection: { live, historical }
    },
    "raw conversation projection catch-up completed"
  );
};

const logRebuildReport = (
  logger: Logger,
  rebuild: { jobs: number; events: number }
): void => {
  if (rebuild.jobs === 0) {
    return;
  }
  logger.info(
    {
      event: {
        name: "worker.raw_projection.semantic_rebuild.completed",
        category: "projection"
      },
      projection: {
        rebuildJobs: rebuild.jobs,
        rebuiltEvents: rebuild.events
      }
    },
    "semantic memory rebuild completed"
  );
};

const createRawProjectionServiceHandle = (
  run: () => Promise<void>,
  intervalMs: number,
  getTimer: () => ReturnType<typeof setInterval> | null,
  setTimer: (timer: ReturnType<typeof setInterval> | null) => void
): RawProjectionService => ({
  run,
  start() {
    if (getTimer()) {
      return;
    }
    setTimer(setInterval(() => void run(), intervalMs));
    void run();
  },
  stop() {
    const timer = getTimer();
    if (!timer) {
      return;
    }
    clearInterval(timer);
    setTimer(null);
  }
});

export const createRawProjectionService = (
  config: RawProjectionServiceConfig
): RawProjectionService => {
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeHistoricalBatches = 0;

  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const live = await projectActors(
        config,
        "live_capture_projection",
        { limit: config.batchLimit },
        config.actorLimit
      );
      const backlog =
        await config.repository.getConversationProjectionBacklog();
      const health = await config.getHistoricalAdmissionHealth();
      const decision = decideHistoricalAdmission(
        { ...backlog, ...health, activeHistoricalBatches },
        config.historicalImport
      );
      const historical = await runHistoricalBatch(
        config,
        decision,
        () => {
          activeHistoricalBatches += 1;
        },
        () => {
          activeHistoricalBatches -= 1;
        }
      );
      const rebuild = await processRebuildActors(config);
      await reconcileEmbeddingJobs(config);
      await reconcileLcmCompactionJobs(config);
      logHistoricalDecision(config.logger, decision, backlog, historical);
      logProjectionReport(config.logger, live, historical);
      logRebuildReport(config.logger, rebuild);
    } catch (error) {
      config.logger.warn(
        {
          event: {
            name: "worker.raw_projection.catchup.failed",
            category: "projection"
          },
          err: error
        },
        "raw conversation projection catch-up failed"
      );
    } finally {
      running = false;
    }
  };

  return createRawProjectionServiceHandle(
    run,
    config.intervalMs,
    () => timer,
    (value) => {
      timer = value;
    }
  );
};
