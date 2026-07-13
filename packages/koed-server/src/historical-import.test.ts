import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverCodexHistory,
  presentCodexHistoryCandidate,
  resolveSupportedCodexHistoryRoots,
  type CodexHistoryCandidate
} from "./codex-history-discovery.js";
import {
  readHistoricalSourceBatch,
  reconcileHistoricalSource,
  type HistoricalSourceCheckpoint
} from "./historical-import-batch.js";
import { resolveHistoricalImportCoordinatorConfig } from "./historical-import-config.js";
import {
  historicalBatchGate,
  historicalImportStartReadiness,
  rankAutomaticHistoricalSources
} from "./historical-import-coordinator.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const tempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "koed-history-"));
  temporaryDirectories.push(directory);
  return directory;
};

const transcriptLines = (input: {
  sessionId: string;
  cwd?: string;
  timestamps: string[];
  messageSize?: number;
}): string[] => [
  JSON.stringify({
    timestamp: input.timestamps[0],
    type: "session_meta",
    payload: {
      id: input.sessionId,
      timestamp: input.timestamps[0],
      ...(input.cwd ? { cwd: input.cwd } : {})
    }
  }),
  ...input.timestamps.slice(1).map((timestamp, index) =>
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `${index}:`.padEnd(input.messageSize ?? 20, "x")
      }
    })
  )
];

const writeTranscript = (filePath: string, lines: string[]): void => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${lines.join("\n")}\n`);
};

const discover = (codexHome: string) =>
  discoverCodexHistory({
    environment: { HOME: path.dirname(codexHome), CODEX_HOME: codexHome },
    maxFiles: 100,
    metadataSampleBytes: 4096
  });

const sourceConfig = {
  windowDays: 30,
  firstRunSessionCap: 50,
  maxBatchRows: 2,
  maxBatchBytes: 700,
  maxBatchRuntimeMs: 15_000,
  maxDiscoveryFiles: 100,
  metadataSampleBytes: 4096
};

const initialCheckpoint = (size: number): HistoricalSourceCheckpoint => ({
  offset: 0,
  line: 0,
  hash: null,
  observedSizeBytes: size
});

describe("bounded Codex history discovery", () => {
  it("uses only supported roots and rejects escaping symlinks", async () => {
    const directory = await tempDirectory();
    const codexHome = path.join(directory, ".codex");
    const sessions = path.join(codexHome, "sessions", "2026", "07", "12");
    const outside = path.join(directory, "outside.jsonl");
    writeTranscript(
      outside,
      transcriptLines({
        sessionId: "outside",
        timestamps: ["2026-07-12T00:00:00Z"]
      })
    );
    mkdirSync(sessions, { recursive: true });
    symlinkSync(outside, path.join(sessions, "escape.jsonl"));
    writeTranscript(
      path.join(sessions, "inside.jsonl"),
      transcriptLines({
        sessionId: "inside",
        cwd: "/private/alice/work/secret-project",
        timestamps: ["2026-07-10T00:00:00Z", "2026-07-12T00:00:00Z"]
      })
    );

    const result = discover(codexHome);
    expect(
      result.candidates.map((candidate) => candidate.sourceSessionId)
    ).toEqual(["inside"]);
    expect(result.issues).toContainEqual({
      sourceLabel: "…/escape.jsonl",
      reason: "symlink_rejected"
    });
    expect(result.roots.map((root) => root.configuredPath)).toEqual([
      path.join(codexHome, "sessions")
    ]);
    expect(
      JSON.stringify(presentCodexHistoryCandidate(result.candidates[0]!))
    ).not.toContain("secret-project");
  });

  it("validates explicit overrides and never accepts broad roots", async () => {
    const directory = await tempDirectory();
    const override = path.join(directory, "explicit-history");
    mkdirSync(override);
    expect(
      resolveSupportedCodexHistoryRoots({
        CODEX_HOME: path.join(directory, "missing"),
        MEMORY_CODEX_HISTORY_ROOTS: override
      })
    ).toHaveLength(1);
    expect(() =>
      resolveSupportedCodexHistoryRoots({ MEMORY_CODEX_HISTORY_ROOTS: "." })
    ).toThrow("must be absolute");
    expect(() =>
      resolveSupportedCodexHistoryRoots({
        MEMORY_CODEX_HISTORY_ROOTS: path.parse(directory).root
      })
    ).toThrow("too broad");
  });

  it("reports malformed metadata and enforces discovery bounds", async () => {
    const directory = await tempDirectory();
    const codexHome = path.join(directory, ".codex");
    const sessions = path.join(codexHome, "sessions");
    writeTranscript(path.join(sessions, "broken.jsonl"), ["not-json"]);
    expect(discover(codexHome).issues).toContainEqual({
      sourceLabel: "…/broken.jsonl",
      reason: "missing_session_id"
    });
    expect(() =>
      discoverCodexHistory({
        environment: { CODEX_HOME: codexHome },
        maxFiles: 0,
        metadataSampleBytes: 4096
      })
    ).toThrow("file limit exceeded");
  });
});

describe("automatic historical selection", () => {
  const candidate = (id: string, eventTime: string): CodexHistoryCandidate => ({
    sourcePath: `/history/${id}.jsonl`,
    sourceRoot: "/history",
    sourceLabel: `…/${id}.jsonl`,
    sourceSessionId: id,
    sourceFingerprint: id.padEnd(64, "0"),
    sourceSizeBytes: 10,
    sourceModifiedAt: eventTime,
    sourceEventFrom: eventTime,
    sourceEventTo: eventTime,
    projectCwd: null
  });

  it("orders by Project activity then source event and freezes 30-day/50 bounds", () => {
    const sources = [
      candidate("a", "2026-07-01T00:00:00.000Z"),
      candidate("b", "2026-07-11T00:00:00.000Z"),
      candidate("c", "2026-07-10T00:00:00.000Z"),
      candidate("old", "2026-05-01T00:00:00.000Z")
    ];
    const ranked = rankAutomaticHistoricalSources({
      candidates: sources,
      projectFor: (source) =>
        source.sourceSessionId === "b"
          ? { name: "B", fingerprint: "project-b" }
          : source.sourceSessionId === "old"
            ? null
            : { name: "A", fingerprint: "project-a" },
      now: new Date("2026-07-13T00:00:00.000Z"),
      windowDays: 30,
      sessionCap: 50
    });
    expect(ranked.map((source) => source.sourceSessionId)).toEqual([
      "b",
      "c",
      "a"
    ]);
    expect(ranked.every((source) => source.sourceSessionId !== "old")).toBe(
      true
    );
  });

  it("keeps missing Project metadata as Unassigned", () => {
    const [ranked] = rankAutomaticHistoricalSources({
      candidates: [candidate("a", "2026-07-12T00:00:00.000Z")],
      projectFor: () => null,
      now: new Date("2026-07-13T00:00:00.000Z"),
      windowDays: 30,
      sessionCap: 50
    });
    expect(ranked?.detectedProject).toEqual({ name: "Unassigned" });
  });
});

describe("resumable source batches", () => {
  it("resumes, counts malformed rows, accepts growth, and detects truncation/mutation", async () => {
    const directory = await tempDirectory();
    const codexHome = path.join(directory, ".codex");
    const filePath = path.join(codexHome, "sessions", "source.jsonl");
    const lines = transcriptLines({
      sessionId: "restart-session",
      timestamps: [
        "2026-07-10T00:00:00Z",
        "2026-07-11T00:00:00Z",
        "2026-07-12T00:00:00Z"
      ],
      messageSize: 300
    });
    writeTranscript(filePath, [lines[0]!, "malformed", ...lines.slice(1)]);
    const source = discover(codexHome).candidates[0]!;
    const first = readHistoricalSourceBatch({
      source,
      checkpoint: initialCheckpoint(source.sourceSizeBytes),
      config: sourceConfig
    });
    expect(first.state).toBe("ready");
    if (!("batch" in first)) throw new Error("expected first batch");
    expect(first.batch.malformedRecordCount).toBe(1);
    expect(first.batch.items).not.toHaveLength(0);
    expect(
      first.batch.items.every(
        (item) =>
          item.sourceTransport === "historical_import" &&
          item.sourcePath === undefined
      )
    ).toBe(true);

    const restarted: HistoricalSourceCheckpoint = {
      offset: first.batch.checkpointOffset,
      line: first.batch.checkpointLine,
      hash: first.batch.checkpointHash,
      observedSizeBytes: first.batch.sourceSizeBytes
    };
    appendFileSync(
      filePath,
      `${transcriptLines({ sessionId: "restart-session", timestamps: ["2026-07-13T00:00:00Z", "2026-07-13T01:00:00Z"] })[1]}\n`
    );
    const grown = readHistoricalSourceBatch({
      source: { ...source, sourceSizeBytes: statSize(filePath) },
      checkpoint: restarted,
      config: sourceConfig
    });
    expect(["ready", "growing"]).toContain(grown.state);

    truncateSync(filePath, restarted.offset - 1);
    expect(
      readHistoricalSourceBatch({
        source,
        checkpoint: restarted,
        config: sourceConfig
      })
    ).toMatchObject({ state: "truncated" });

    writeTranscript(filePath, [lines[0]!, "malformed", ...lines.slice(1)]);
    const bytes = Buffer.from(requireFile(filePath));
    bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
    writeFileSync(filePath, bytes);
    expect(
      readHistoricalSourceBatch({
        source,
        checkpoint: restarted,
        config: sourceConfig
      })
    ).toMatchObject({ state: "mutated" });
  });

  it("distinguishes moved and deleted fingerprints", async () => {
    const directory = await tempDirectory();
    const source = {
      sourcePath: path.join(directory, "old.jsonl"),
      sourceRoot: directory,
      sourceLabel: "…/old.jsonl",
      sourceSessionId: "moved",
      sourceFingerprint: "f".repeat(64),
      sourceSizeBytes: 1,
      sourceModifiedAt: "2026-07-12T00:00:00Z",
      sourceEventFrom: "2026-07-12T00:00:00Z",
      sourceEventTo: "2026-07-12T00:00:00Z",
      projectCwd: null
    } satisfies CodexHistoryCandidate;
    expect(reconcileHistoricalSource(source, [])).toEqual({ state: "deleted" });
    expect(
      reconcileHistoricalSource(source, [
        { ...source, sourcePath: path.join(directory, "new.jsonl") }
      ])
    ).toMatchObject({ state: "moved" });
  });
});

const statSize = (filePath: string): number => statSync(filePath).size;
const requireFile = (filePath: string): string =>
  readFileSync(filePath, "utf8");

describe("fail-closed coordinator gates", () => {
  it("requires actual runtime/Codex readiness and KOE-320 admission", () => {
    const healthy = { state: "healthy" };
    const status = {
      api: healthy,
      database: healthy,
      workerQueues: healthy,
      embeddingService: healthy,
      apiToken: healthy,
      mcpServer: healthy,
      captureHook: healthy,
      codex: healthy,
      explorer: healthy
    } as Parameters<typeof historicalImportStartReadiness>[0];
    expect(historicalImportStartReadiness(status)).toEqual({ ready: true });
    expect(
      historicalImportStartReadiness({
        ...status,
        workerQueues: { state: "starting" }
      })
    ).toEqual({ ready: false, reason: "worker_queues_not_ready" });

    const base = {
      runtimeReady: true,
      codexSetupReady: true,
      captureState: "enabled" as const,
      visibility: "personal" as const,
      paused: false,
      skipped: false,
      sourceState: "ready" as const
    };
    expect(historicalBatchGate(base)).toEqual({
      admitted: false,
      reason: "backpressure_unavailable"
    });
    expect(
      historicalBatchGate({
        ...base,
        paused: true,
        backpressure: { admitted: true }
      })
    ).toEqual({ admitted: false, reason: "capture_paused" });
    expect(
      historicalBatchGate({
        ...base,
        skipped: true,
        backpressure: { admitted: true }
      })
    ).toEqual({ admitted: false, reason: "user_skipped" });
    expect(
      historicalBatchGate({
        ...base,
        visibility: "team",
        backpressure: { admitted: true }
      })
    ).toEqual({ admitted: false, reason: "non_personal_visibility" });
    expect(
      historicalBatchGate({
        ...base,
        backpressure: { admitted: false, reason: "live_projection_pressure" }
      })
    ).toEqual({ admitted: false, reason: "live_projection_pressure" });
  });

  it("strictly bounds coordinator configuration", () => {
    expect(resolveHistoricalImportCoordinatorConfig({})).toMatchObject({
      windowDays: 30,
      firstRunSessionCap: 50
    });
    expect(() =>
      resolveHistoricalImportCoordinatorConfig({
        MEMORY_HISTORICAL_IMPORT_WINDOW_DAYS: "31"
      })
    ).toThrow("30 to 30");
    expect(() =>
      resolveHistoricalImportCoordinatorConfig({
        MEMORY_HISTORICAL_IMPORT_FIRST_RUN_SESSIONS: "51"
      })
    ).toThrow("1 to 50");
    expect(() =>
      resolveHistoricalImportCoordinatorConfig({
        MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_ROWS: "nope"
      })
    ).toThrow("integer");
  });
});
