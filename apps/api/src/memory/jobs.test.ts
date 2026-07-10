import { describe, expect, it, vi } from "vitest";
import { createMemoryJobScheduler } from "./jobs.js";

const createQueue = () => ({
  add: vi.fn().mockResolvedValue({ id: "job-1" }),
  getJobCounts: vi.fn(),
  close: vi.fn()
});

const createScheduler = () => {
  const embeddingQueue = createQueue();
  const compactionQueue = createQueue();
  const scheduler = createMemoryJobScheduler({
    embeddingQueue,
    compactionQueue,
    log: { warn: vi.fn() }
  });
  return { scheduler, embeddingQueue, compactionQueue };
};

describe("memory job scheduler", () => {
  it("queues Memory processing with identifiers only", async () => {
    const { scheduler, embeddingQueue, compactionQueue } = createScheduler();

    await expect(
      scheduler.scheduleMemoryEventProcessing(
        {} as never,
        { userId: "user-1" },
        "event-1",
        "personal"
      )
    ).resolves.toMatchObject({
      embedding: { queued: true },
      compaction: { queued: true }
    });

    expect(embeddingQueue.add).toHaveBeenCalledWith(
      "embed-source",
      {
        sourceType: "memory_event",
        sourceId: "event-1",
        workClass: "live_capture_projection"
      },
      expect.any(Object)
    );
    expect(compactionQueue.add).toHaveBeenCalledWith(
      "compact-scope",
      {
        userId: "user-1",
        visibility: "personal",
        workClass: "live_capture_projection"
      },
      expect.any(Object)
    );
    const queuedPayloads = JSON.stringify([
      embeddingQueue.add.mock.calls[0]?.[1],
      compactionQueue.add.mock.calls[0]?.[1]
    ]);
    expect(queuedPayloads).not.toContain("content");
    expect(queuedPayloads).not.toContain("payload");
    expect(queuedPayloads).not.toContain("query");
    expect(queuedPayloads).not.toContain("answer");
  });

  it("queues projected Memory Event processing without source text", async () => {
    const { scheduler, embeddingQueue, compactionQueue } = createScheduler();
    const repository = {
      markConversationProjectionProcessingDispatched: vi
        .fn()
        .mockResolvedValue(1)
    };

    await expect(
      scheduler.scheduleProjectedMemoryEventProcessing(
        repository as never,
        { userId: "user-2" },
        [
          {
            eventId: "event-2",
            visibility: "personal",
            workClass: "live_capture_projection"
          },
          {
            eventId: "event-3",
            visibility: "personal",
            workClass: "historical_import_backfill"
          }
        ]
      )
    ).resolves.toMatchObject({
      embeddings: [{ queued: true }, { queued: true }],
      compactions: [{ queued: true }, { queued: true }]
    });

    const queuedPayloads = JSON.stringify([
      embeddingQueue.add.mock.calls.map((call) => call[1]),
      compactionQueue.add.mock.calls.map((call) => call[1])
    ]);
    expect(queuedPayloads).toContain("event-2");
    expect(queuedPayloads).toContain("event-3");
    expect(queuedPayloads).not.toContain("content");
    expect(queuedPayloads).not.toContain("payload");
    expect(queuedPayloads).not.toContain("query");
    expect(queuedPayloads).not.toContain("answer");
    expect(embeddingQueue.add.mock.calls.map((call) => call[2]?.jobId)).toEqual(
      ["projection-embed-event-2", "projection-embed-event-3"]
    );
    expect(
      compactionQueue.add.mock.calls.map((call) => call[2]?.jobId)
    ).toEqual(["projection-compact-event-2", "projection-compact-event-3"]);
    expect(
      repository.markConversationProjectionProcessingDispatched
    ).toHaveBeenCalledWith(["event-2", "event-3"]);
  });

  it("leaves projected processing pending when queue admission fails", async () => {
    const { scheduler, compactionQueue } = createScheduler();
    const repository = {
      markConversationProjectionProcessingDispatched: vi.fn()
    };
    compactionQueue.add.mockRejectedValueOnce(new Error("queue degraded"));

    const result = await scheduler.scheduleProjectedMemoryEventProcessing(
      repository as never,
      { userId: "user-3" },
      [
        {
          eventId: "event-4",
          visibility: "personal",
          workClass: "historical_import_backfill"
        }
      ]
    );

    expect(result.compactions[0]).toMatchObject({ queued: false });
    expect(
      repository.markConversationProjectionProcessingDispatched
    ).not.toHaveBeenCalled();
  });
});
