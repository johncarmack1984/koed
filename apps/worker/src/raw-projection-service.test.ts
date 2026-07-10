import type { MemorySourceRepository } from "@koed/db";
import { describe, expect, it, vi } from "vitest";
import { createRawProjectionService } from "./raw-projection-service.js";

const batchConfig = {
  maxBytes: 1_000_000,
  maxConcurrency: 1,
  maxRows: 100,
  maxRuntimeMs: 15_000,
  maxLiveProjectionRows: 0,
  maxInteractiveQuestionRows: 0
};

const healthy = {
  apiHealthy: true,
  queueHealthy: true,
  embeddingServiceHealthy: true
};

const emptyBacklog = {
  liveProjectionRows: 0,
  historicalImportRows: 0,
  historicalImportBytes: 0,
  interactiveQuestionRows: 0
};

const projectionResult = (
  memoryEventScopes: Array<{
    eventId: string;
    visibility: "personal";
    includeInEmbedding: boolean;
    includeInLcm: boolean;
    workClass: "live_capture_projection" | "historical_import_backfill";
  }>
) => ({
  rawItemsScanned: memoryEventScopes.length,
  rawItemsProjected: memoryEventScopes.length,
  rawItemsWaitingForAgentSeal: 0,
  messagesCreated: 0,
  toolEventsCreated: 0,
  memoryEventsCreated: memoryEventScopes.length,
  tokenUsageRowsCreated: 0,
  memoryEventIds: memoryEventScopes.map((scope) => scope.eventId),
  memoryEventScopes
});

const semanticRebuildResult = (
  memoryEventScopes: Parameters<typeof projectionResult>[0]
) => ({
  jobsClaimed: 1,
  jobsCompleted: 1,
  jobsFailed: 0,
  memoryEventsCreated: memoryEventScopes.length,
  memoryEventIds: memoryEventScopes.map((scope) => scope.eventId),
  memoryEventScopes
});

const logger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
});

const serviceOptions = (repository: MemorySourceRepository) => ({
  actorLimit: 10,
  batchLimit: 100,
  embeddingDispatchKey: "qwen-v1-1024",
  enqueueLcmCompaction: vi.fn().mockResolvedValue({ id: 2 }),
  enqueueProjectedMemoryEventProcessing: vi.fn().mockResolvedValue({}),
  enqueueSourceEmbedding: vi.fn().mockResolvedValue({ id: 1 }),
  getHistoricalAdmissionHealth: vi.fn().mockResolvedValue(healthy),
  historicalImport: batchConfig,
  intervalMs: 1_000,
  logger: logger() as never,
  repository
});

const withProjectionDefaults = (repository: Record<string, unknown>) =>
  ({
    getConversationProjectionBacklog: vi.fn().mockResolvedValue(emptyBacklog),
    listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([]),
    listSourcesNeedingEmbeddings: vi.fn().mockResolvedValue([]),
    ...repository
  }) as unknown as MemorySourceRepository;

describe("raw projection service", () => {
  it("enqueues independent jobs according to projection flags", async () => {
    const repository = withProjectionDefaults({
      listConversationProjectionActors: vi
        .fn()
        .mockResolvedValue([{ userId: "user-1" }]),
      projectPendingConversationItems: vi.fn().mockResolvedValue(
        projectionResult([
          {
            eventId: "embed-only",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: false,
            workClass: "live_capture_projection"
          },
          {
            eventId: "lcm-only",
            visibility: "personal",
            includeInEmbedding: false,
            includeInLcm: true,
            workClass: "live_capture_projection"
          },
          {
            eventId: "both",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: true,
            workClass: "live_capture_projection"
          },
          {
            eventId: "stored-only",
            visibility: "personal",
            includeInEmbedding: false,
            includeInLcm: false,
            workClass: "live_capture_projection"
          }
        ])
      ),
      listSemanticMemoryRebuildActors: vi.fn().mockResolvedValue([]),
      listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([
        {
          ownerUserId: "user-1",
          visibility: "personal",
          pendingMemoryEventIds: ["both", "lcm-only"],
          dispatchKey: "lcm-dispatch-user-1-v1"
        }
      ]),
      listSourcesNeedingEmbeddings: vi.fn().mockResolvedValue([
        { sourceType: "memory_event", sourceId: "embed-only" },
        { sourceType: "memory_event", sourceId: "both" }
      ])
    });
    const options = serviceOptions(repository);
    const service = createRawProjectionService(options);

    await service.run();

    expect(options.enqueueSourceEmbedding).toHaveBeenCalledTimes(2);
    expect(options.enqueueSourceEmbedding).toHaveBeenNthCalledWith(
      1,
      "memory_event",
      "embed-only",
      "qwen-v1-1024"
    );
    expect(options.enqueueSourceEmbedding).toHaveBeenNthCalledWith(
      2,
      "memory_event",
      "both",
      "qwen-v1-1024"
    );
    expect(options.enqueueLcmCompaction).toHaveBeenCalledOnce();
    expect(options.enqueueLcmCompaction).toHaveBeenCalledWith(
      { userId: "user-1" },
      "personal",
      "lcm-dispatch-user-1-v1"
    );
    expect(options.enqueueProjectedMemoryEventProcessing).toHaveBeenCalledWith(
      { userId: "user-1" },
      expect.arrayContaining([
        expect.objectContaining({ eventId: "stored-only" })
      ])
    );
  });

  it("rediscovers embedding after queue admission fails", async () => {
    const repository = withProjectionDefaults({
      listConversationProjectionActors: vi
        .fn()
        .mockResolvedValue([{ userId: "user-1" }]),
      projectPendingConversationItems: vi.fn().mockResolvedValue(
        projectionResult([
          {
            eventId: "event-1",
            visibility: "personal",
            includeInEmbedding: true,
            includeInLcm: true,
            workClass: "live_capture_projection"
          }
        ])
      ),
      listSemanticMemoryRebuildActors: vi.fn().mockResolvedValue([]),
      listSourcesNeedingEmbeddings: vi
        .fn()
        .mockResolvedValue([
          { sourceType: "memory_event", sourceId: "event-1" }
        ])
    });
    const options = serviceOptions(repository);
    options.enqueueSourceEmbedding
      .mockRejectedValueOnce(new Error("embedding queue unavailable"))
      .mockResolvedValueOnce({ id: 1 });
    const log = logger();
    options.logger = log as never;
    const service = createRawProjectionService(options);

    await service.run();
    await service.run();

    expect(options.enqueueSourceEmbedding).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: { name: "memory-embed" },
        resource: { type: "memory_event", id: "event-1" }
      }),
      "could not enqueue pending embedding source"
    );
  });

  it("rediscovers LCM compaction after queue admission fails", async () => {
    const rebuiltScope = {
      eventId: "rebuilt-event-1",
      visibility: "personal" as const,
      includeInEmbedding: true,
      includeInLcm: true,
      workClass: "normal_embedding_lcm" as const
    };
    const repository = withProjectionDefaults({
      listConversationProjectionActors: vi.fn().mockResolvedValue([]),
      listSemanticMemoryRebuildActors: vi
        .fn()
        .mockResolvedValue([{ userId: "user-2" }]),
      processDueSemanticMemoryRebuilds: vi
        .fn()
        .mockResolvedValue(semanticRebuildResult([rebuiltScope])),
      listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([
        {
          ownerUserId: "user-2",
          visibility: "personal",
          pendingMemoryEventIds: ["rebuilt-event-1"],
          dispatchKey: "lcm-dispatch-user-2-v1"
        }
      ])
    });
    const options = serviceOptions(repository);
    options.enqueueLcmCompaction
      .mockRejectedValueOnce(new Error("compaction queue unavailable"))
      .mockResolvedValueOnce({ id: 2 });
    const log = logger();
    options.logger = log as never;
    const service = createRawProjectionService(options);

    await service.run();
    await service.run();

    expect(options.enqueueLcmCompaction).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: { name: "lcm-compact" },
        actor: { user_id: "user-2" }
      }),
      "could not enqueue pending LCM compaction scope"
    );
  });
});

const historicalProjectionResult = (
  workClass: "live_capture_projection" | "historical_import_backfill"
) =>
  projectionResult([
    {
      eventId: `${workClass}-event`,
      visibility: "personal",
      includeInEmbedding: true,
      includeInLcm: true,
      workClass
    }
  ]);

const createHistoricalRepository = () => ({
  getConversationProjectionBacklog: vi.fn().mockResolvedValue({
    liveProjectionRows: 0,
    historicalImportRows: 10,
    historicalImportBytes: 1000,
    interactiveQuestionRows: 0
  }),
  listConversationProjectionActors: vi.fn(({ limit, workClass }) =>
    Promise.resolve(
      (workClass === "live_capture_projection"
        ? [{ userId: "live-user" }]
        : [{ userId: "historical-user" }, { userId: "later-user" }]
      ).slice(0, limit)
    )
  ),
  listSemanticMemoryRebuildActors: vi.fn().mockResolvedValue([]),
  listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([]),
  listSourcesNeedingEmbeddings: vi.fn().mockResolvedValue([]),
  projectPendingConversationItems: vi.fn((_actor, input) =>
    Promise.resolve(historicalProjectionResult(input.workClass))
  )
});

const createHistoricalService = (
  repository = createHistoricalRepository(),
  health = healthy
) => {
  const options = serviceOptions(
    repository as unknown as MemorySourceRepository
  );
  options.batchLimit = 1000;
  options.intervalMs = 60_000;
  options.getHistoricalAdmissionHealth = vi.fn().mockResolvedValue(health);
  const service = createRawProjectionService(options);
  return { service, repository, options };
};

describe("raw Projection historical priority", () => {
  it("runs newly available live Projection before queued historical work", async () => {
    const { service, repository, options } = createHistoricalService();

    await service.run();

    expect(repository.projectPendingConversationItems).toHaveBeenNthCalledWith(
      1,
      { userId: "live-user" },
      expect.objectContaining({ workClass: "live_capture_projection" })
    );
    expect(repository.projectPendingConversationItems).toHaveBeenNthCalledWith(
      2,
      { userId: "historical-user" },
      expect.objectContaining({ workClass: "historical_import_backfill" })
    );
    expect(options.enqueueProjectedMemoryEventProcessing.mock.calls).toEqual([
      [
        { userId: "live-user" },
        [expect.objectContaining({ workClass: "live_capture_projection" })]
      ],
      [
        { userId: "historical-user" },
        [expect.objectContaining({ workClass: "historical_import_backfill" })]
      ]
    ]);
  });

  it("yields historical work at one bounded batch and resumes next run", async () => {
    const { service, repository } = createHistoricalService();

    await service.run();
    await service.run();

    const historicalCalls =
      repository.projectPendingConversationItems.mock.calls
        .map(([, input]) => input)
        .filter((input) => input.workClass === "historical_import_backfill");
    expect(historicalCalls).toEqual([
      expect.objectContaining({
        limit: 100,
        maxBytes: 1_000_000,
        maxRuntimeMs: 15_000
      }),
      expect.objectContaining({
        limit: 100,
        maxBytes: 1_000_000,
        maxRuntimeMs: 15_000
      })
    ]);
    expect(repository.listConversationProjectionActors).toHaveBeenCalledWith({
      limit: 1,
      workClass: "historical_import_backfill"
    });
  });

  it("pauses historical admission while dependency degraded", async () => {
    const { service, repository, options } = createHistoricalService(
      undefined,
      {
        apiHealthy: false,
        queueHealthy: true,
        embeddingServiceHealthy: true
      }
    );

    await service.run();

    expect(repository.projectPendingConversationItems).toHaveBeenCalledTimes(1);
    expect(options.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        historicalImport: expect.objectContaining({
          admitted: false,
          reason: "api_degraded"
        })
      }),
      "historical import admission evaluated"
    );
  });

  it("resumes after pressure clears on new worker instance", async () => {
    const repository = createHistoricalRepository();
    repository.getConversationProjectionBacklog
      .mockResolvedValueOnce({
        liveProjectionRows: 1,
        historicalImportRows: 10,
        historicalImportBytes: 1000,
        interactiveQuestionRows: 0
      })
      .mockResolvedValueOnce({
        liveProjectionRows: 0,
        historicalImportRows: 10,
        historicalImportBytes: 1000,
        interactiveQuestionRows: 0
      });

    await createHistoricalService(repository).service.run();
    await createHistoricalService(repository).service.run();

    const historicalCalls =
      repository.projectPendingConversationItems.mock.calls
        .map(([, input]) => input.workClass)
        .filter((workClass) => workClass === "historical_import_backfill");
    expect(historicalCalls).toEqual(["historical_import_backfill"]);
  });
});
