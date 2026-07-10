import { describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import { createRawProjectionService } from "./raw-projection-service.js";

const batchConfig = {
  maxBytes: 1_000_000,
  maxConcurrency: 1,
  maxRows: 100,
  maxRuntimeMs: 15_000,
  maxLiveProjectionRows: 0,
  maxInteractiveQuestionRows: 0
};

const projectionResult = (
  workClass: "live_capture_projection" | "historical_import_backfill"
) => ({
  rawItemsScanned: 1,
  rawItemsProjected: 1,
  rawItemsWaitingForAgentSeal: 0,
  messagesCreated: 0,
  toolEventsCreated: 0,
  memoryEventsCreated: 1,
  tokenUsageRowsCreated: 0,
  memoryEventIds: [`${workClass}-event`],
  memoryEventScopes: [
    {
      eventId: `${workClass}-event`,
      visibility: "personal" as const,
      workClass
    }
  ]
});

const createRepository = () => ({
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
  processDueSemanticMemoryRebuilds: vi.fn(),
  projectPendingConversationItems: vi.fn((actor, input) =>
    Promise.resolve(projectionResult(input.workClass))
  ),
  tryAcquireHistoricalProjectionLease: vi.fn().mockResolvedValue({
    release: vi.fn().mockResolvedValue(undefined)
  })
});

const createService = (
  repository = createRepository(),
  health = {
    apiHealthy: true,
    queueHealthy: true,
    embeddingServiceHealthy: true
  }
) => {
  const enqueueProjectedMemoryEventProcessing = vi.fn().mockResolvedValue({});
  const recoverProjectedMemoryEventProcessing = vi.fn().mockResolvedValue(0);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = createRawProjectionService({
    actorLimit: 10,
    batchLimit: 1000,
    enqueueProjectedMemoryEventProcessing,
    getHistoricalAdmissionHealth: vi.fn().mockResolvedValue(health),
    recoverProjectedMemoryEventProcessing,
    historicalImport: batchConfig,
    intervalMs: 60_000,
    logger: logger as never,
    repository: repository as unknown as MemorySourceRepository
  });
  return {
    service,
    repository,
    enqueueProjectedMemoryEventProcessing,
    recoverProjectedMemoryEventProcessing,
    logger
  };
};

describe("raw Projection historical priority", () => {
  it("runs newly available live Projection before queued historical work", async () => {
    const {
      service,
      repository,
      enqueueProjectedMemoryEventProcessing,
      recoverProjectedMemoryEventProcessing
    } = createService();

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
    expect(
      enqueueProjectedMemoryEventProcessing.mock.invocationCallOrder[0]
    ).toBeLessThan(
      recoverProjectedMemoryEventProcessing.mock.invocationCallOrder[0]!
    );
    expect(enqueueProjectedMemoryEventProcessing.mock.calls).toEqual([
      [
        { userId: "live-user" },
        [
          {
            eventId: "live_capture_projection-event",
            visibility: "personal",
            workClass: "live_capture_projection"
          }
        ]
      ],
      [
        { userId: "historical-user" },
        [
          {
            eventId: "historical_import_backfill-event",
            visibility: "personal",
            workClass: "historical_import_backfill"
          }
        ]
      ]
    ]);
  });

  it("yields historical work at one bounded batch and resumes next run", async () => {
    const { service, repository } = createService();

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

  it("pauses historical admission while a dependency is degraded", async () => {
    const { service, repository, logger } = createService(undefined, {
      apiHealthy: false,
      queueHealthy: true,
      embeddingServiceHealthy: true
    });

    await service.run();

    expect(repository.projectPendingConversationItems).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        historicalImport: expect.objectContaining({
          admitted: false,
          reason: "api_degraded"
        })
      }),
      "historical import admission evaluated"
    );
  });

  it("honors the cross-process historical Projection lease", async () => {
    const repository = createRepository();
    repository.tryAcquireHistoricalProjectionLease.mockResolvedValueOnce(null);
    const { service, logger } = createService(repository);

    await service.run();

    expect(
      repository.projectPendingConversationItems.mock.calls.filter(
        ([, input]) => input.workClass === "historical_import_backfill"
      )
    ).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        historicalImport: expect.objectContaining({
          admitted: false,
          reason: "concurrency_cap"
        })
      }),
      "historical import admission evaluated"
    );
  });

  it("waits for active Projection before shutdown closes dependencies", async () => {
    const repository = createRepository();
    const projectionGate: {
      resolve(value: ReturnType<typeof projectionResult>): void;
    } = { resolve: () => undefined };
    repository.projectPendingConversationItems.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          projectionGate.resolve = resolve;
        })
    );
    const { service } = createService(repository);

    const running = service.run();
    await vi.waitFor(() =>
      expect(repository.projectPendingConversationItems).toHaveBeenCalled()
    );
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    projectionGate.resolve(projectionResult("live_capture_projection"));
    await Promise.all([running, stopping]);
    expect(stopped).toBe(true);
  });

  it("resumes after pressure clears on a new worker instance", async () => {
    const repository = createRepository();
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

    await createService(repository).service.run();
    await createService(repository).service.run();

    const historicalCalls =
      repository.projectPendingConversationItems.mock.calls
        .map(([, input]) => input.workClass)
        .filter((workClass) => workClass === "historical_import_backfill");
    expect(historicalCalls).toEqual(["historical_import_backfill"]);
  });
});
