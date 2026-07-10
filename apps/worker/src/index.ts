import {
  createDbPool,
  createMemorySourceRepository,
  waitForCurrentDbMigrations,
  type MemorySourceRepository
} from "@koed/db";
import { createEmbeddingWorkflow } from "./embedding-workflow.js";
import { loadWorkerEnv, resolveWorkerEnv } from "./env-config.js";
import {
  createEnvelopeEncryptionProviderFromEnvironment,
  lcmCompactQueueName,
  lcmEmbedQueueName,
  memoryEmbedQueueName,
  type KoedWorkClass,
  workerQueueNames
} from "@koed/shared";
import {
  createWorkerJobWorkflow,
  type EmbeddingQueueJobData
} from "./job-workflows.js";
import {
  createWorkerQueueProducer,
  createWorkerQueueRuntime
} from "./queue.js";
import { createWorkerLogger } from "./logging.js";
import { createRawProjectionService } from "./raw-projection-service.js";
import { createHistoricalAdmissionHealth } from "./historical-admission-health.js";
import { createProjectionJobScheduler } from "./projection-job-scheduler.js";

loadWorkerEnv();

const workerEnv = resolveWorkerEnv();
const logger = createWorkerLogger({
  nodeEnv: workerEnv.nodeEnv,
  logLevel: workerEnv.logLevel,
  logDestination: workerEnv.logDestination
});

const pool = workerEnv.databaseUrl
  ? createDbPool({ connectionString: workerEnv.databaseUrl })
  : null;
if (pool) {
  await waitForCurrentDbMigrations(pool);
}
const repository = pool
  ? createMemorySourceRepository(pool, {
      envelopeEncryptionProvider:
        createEnvelopeEncryptionProviderFromEnvironment()
    })
  : null;
const requireRepository = (): MemorySourceRepository => {
  if (!repository) {
    throw new Error("DATABASE_URL is required for worker business logic");
  }
  return repository;
};

const isTransientError = (error: unknown): boolean =>
  error instanceof TypeError ||
  (typeof error === "object" &&
    error !== null &&
    "transient" in error &&
    error.transient === true);

const embeddingWorkflow = createEmbeddingWorkflow({
  env: workerEnv,
  repository: requireRepository
});

const queueProducerOptions = {
  backend: workerEnv.queueBackend,
  redisUrl: workerEnv.redisUrl,
  pool
};

const memoryEmbedQueue = createWorkerQueueProducer<EmbeddingQueueJobData>(
  memoryEmbedQueueName,
  queueProducerOptions
);
const compactionQueue = createWorkerQueueProducer<{
  userId: string;
  visibility: "personal";
  workClass: KoedWorkClass;
}>(lcmCompactQueueName, queueProducerOptions);
const lcmEmbedQueue = createWorkerQueueProducer<EmbeddingQueueJobData>(
  lcmEmbedQueueName,
  queueProducerOptions
);

const handleJob = createWorkerJobWorkflow({
  embeddingWorkflow,
  lcmEmbedQueue,
  repository: requireRepository
});

const queueRuntime = createWorkerQueueRuntime({
  backend: workerEnv.queueBackend,
  redisUrl: workerEnv.redisUrl,
  pool,
  logger,
  lcmEmbedQueue,
  handleJob,
  isTransientError
});

logger.info(
  {
    event: {
      name: "worker.started",
      category: "lifecycle"
    },
    queueBackend: workerEnv.queueBackend,
    queues: workerQueueNames
  },
  "worker listening on queues"
);

const rawProjectionService = repository
  ? createRawProjectionService({
      actorLimit: workerEnv.rawProjectionActorLimit,
      batchLimit: workerEnv.rawProjectionBatchLimit,
      enqueueProjectedMemoryEventProcessing: createProjectionJobScheduler({
        embeddingQueue: memoryEmbedQueue,
        compactionQueue
      }),
      getHistoricalAdmissionHealth: createHistoricalAdmissionHealth({
        apiReadyUrl: workerEnv.historicalImportApiReadyUrl,
        apiReadyTimeoutMs: workerEnv.historicalImportApiReadyTimeoutMs,
        embeddingQueue: memoryEmbedQueue,
        repository
      }),
      historicalImport: workerEnv.historicalImport,
      intervalMs: workerEnv.rawProjectionIntervalMs,
      logger,
      repository
    })
  : null;
rawProjectionService?.start();

const shutdown = async () => {
  logger.info(
    {
      event: {
        name: "worker.shutting_down",
        category: "lifecycle"
      }
    },
    "worker shutting down"
  );
  rawProjectionService?.stop();
  await queueRuntime.close();
  await Promise.all([memoryEmbedQueue.close(), compactionQueue.close()]);
  await pool?.end();
  logger.info(
    {
      event: {
        name: "worker.stopped",
        category: "lifecycle"
      }
    },
    "worker stopped"
  );
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
