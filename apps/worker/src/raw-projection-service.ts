import type { MemorySourceRepository } from "@koed/db";
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

interface HistoricalBatchResult {
  decision: HistoricalAdmissionDecision;
  report: ProjectionReport;
}

export interface RawProjectionServiceConfig {
  actorLimit: number;
  batchLimit: number;
  enqueueProjectedMemoryEventProcessing(
    actor: { userId: string },
    scopes: Awaited<
      ReturnType<MemorySourceRepository["projectPendingConversationItems"]>
    >["memoryEventScopes"]
  ): Promise<unknown>;
  getHistoricalAdmissionHealth(): Promise<HistoricalAdmissionHealth>;
  recoverProjectedMemoryEventProcessing(): Promise<number>;
  historicalImport: HistoricalImportBatchConfig;
  intervalMs: number;
  logger: Logger;
  repository: MemorySourceRepository;
}

export interface RawProjectionService {
  run(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
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
      {
        ...input,
        workClass
      }
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

export const createRawProjectionService = (
  config: RawProjectionServiceConfig
): RawProjectionService => {
  let currentRun: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeHistoricalBatches = 0;

  const runOnce = async () => {
    try {
      const live = await projectActors(
        config,
        "live_capture_projection",
        { limit: config.batchLimit },
        config.actorLimit
      );
      await config.recoverProjectedMemoryEventProcessing();
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
      logHistoricalDecision(
        config.logger,
        historical.decision,
        backlog,
        historical.report
      );
      logProjectionReport(config.logger, live, historical.report);
      await logRebuildReport(config);
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
    }
  };

  const run = (): Promise<void> => {
    if (!currentRun) {
      currentRun = runOnce().finally(() => {
        currentRun = null;
      });
    }
    return currentRun;
  };

  return createRawProjectionServiceHandle(
    run,
    config.intervalMs,
    () => timer,
    (value) => {
      timer = value;
    },
    () => currentRun
  );
};

const runHistoricalBatch = async (
  config: RawProjectionServiceConfig,
  decision: HistoricalAdmissionDecision,
  start: () => void,
  finish: () => void
): Promise<HistoricalBatchResult> => {
  if (!decision.admitted) {
    return { decision, report: emptyProjectionReport() };
  }
  const lease = await config.repository.tryAcquireHistoricalProjectionLease();
  if (!lease) {
    return {
      decision: { admitted: false, reason: "concurrency_cap" },
      report: emptyProjectionReport()
    };
  }
  start();
  try {
    const report = await projectActors(
      config,
      "historical_import_backfill",
      {
        limit: config.historicalImport.maxRows,
        maxBytes: config.historicalImport.maxBytes,
        maxRuntimeMs: config.historicalImport.maxRuntimeMs
      },
      config.historicalImport.maxConcurrency
    );
    return { decision, report };
  } finally {
    finish();
    await lease.release();
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

const logRebuildReport = async (config: RawProjectionServiceConfig) => {
  const rebuild = await processRebuildActors(config);
  if (rebuild.jobs === 0) {
    return;
  }
  config.logger.info(
    {
      event: {
        name: "worker.raw_projection.semantic_rebuild.completed",
        category: "projection"
      },
      projection: { rebuildJobs: rebuild.jobs, rebuiltEvents: rebuild.events }
    },
    "semantic memory rebuild completed"
  );
};

const createRawProjectionServiceHandle = (
  run: () => Promise<void>,
  intervalMs: number,
  getTimer: () => ReturnType<typeof setInterval> | null,
  setTimer: (timer: ReturnType<typeof setInterval> | null) => void,
  getCurrentRun: () => Promise<void> | null
): RawProjectionService => ({
  run,
  start() {
    if (getTimer()) {
      return;
    }
    setTimer(setInterval(() => void run(), intervalMs));
    void run();
  },
  async stop() {
    const timer = getTimer();
    if (timer) {
      clearInterval(timer);
      setTimer(null);
    }
    await getCurrentRun();
  }
});
