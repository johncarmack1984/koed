import { describe, expect, it } from "vitest";
import { restartKoedServer } from "./restart.js";

describe("restart supervisor", () => {
  it("stops existing app processes before starting the daemon again", async () => {
    const result = await restartKoedServer({
      environment: { KOED_HOME: "/tmp/koed", KOED_REPO_ROOT: "/repo" },
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          pid: 10,
          startedAt: "2026-01-01T00:00:00.000Z",
          repoRoot: "/repo",
          apiUrl: "http://localhost:3300",
          explorerUrl: "http://localhost:5174",
          services: [],
          processes: { api: 11, worker: 12 }
        }),
      rmSync: () => undefined,
      kill: () => undefined,
      collectStatus: async () =>
        ({
          ok: false,
          state: "needs_attention",
          koedHome: "/tmp/koed",
          generatedAt: "2026-01-01T00:00:00.000Z",
          daemon: {
            state: "not_configured",
            running: false,
            stale: false,
            pid: null,
            startedBy: null,
            dependencyMode: null,
            startedAt: null,
            lastHeartbeatAt: null
          },
          api: { state: "needs_attention", url: "http://localhost:3300" },
          database: { state: "starting" },
          redis: { state: "starting" },
          workerQueues: { state: "starting" },
          embeddingService: { state: "starting" },
          apiToken: { state: "not_configured", configured: false },
          mcpServer: { state: "not_configured" },
          captureHook: { state: "not_configured" },
          codex: { state: "not_configured", configured: false },
          lcmSummaryService: { state: "not_configured" },
          explorer: { state: "starting", url: "http://localhost:5174" },
          lastVerification: { state: "not_configured", checkedAt: null }
        }) as never,
      command: "/node",
      entrypoint: "/repo/packages/koed-server/dist/cli.js",
      openSync: () => 1,
      closeSync: () => undefined,
      spawn: () =>
        ({
          pid: 42,
          unref: () => undefined
        }) as never
    });

    expect(result).toMatchObject({
      ok: true,
      state: "starting",
      pid: 42,
      stoppedPids: [11, 12, 10]
    });
  });

  it("waits for stopped processes and forces a fresh daemon even while API was healthy", async () => {
    const killed: number[] = [];
    const spawned: string[][] = [];
    const result = await restartKoedServer({
      environment: { KOED_HOME: "/tmp/koed", KOED_REPO_ROOT: "/repo" },
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({
          pid: 10,
          startedAt: "2026-01-01T00:00:00.000Z",
          repoRoot: "/repo",
          apiUrl: "http://localhost:3300",
          explorerUrl: "http://localhost:5174",
          services: [],
          processes: { api: 11 }
        }),
      rmSync: () => undefined,
      kill: (pid) => {
        killed.push(pid);
      },
      checkPid: () => false,
      collectStatus: async () =>
        ({
          ok: true,
          state: "healthy",
          koedHome: "/tmp/koed",
          generatedAt: "2026-01-01T00:00:00.000Z",
          daemon: {
            state: "healthy",
            running: true,
            stale: false,
            pid: 10,
            startedBy: "cli",
            dependencyMode: "managed",
            startedAt: "2026-01-01T00:00:00.000Z",
            lastHeartbeatAt: "2026-01-01T00:00:00.000Z"
          },
          api: { state: "healthy", url: "http://localhost:3300" },
          database: { state: "healthy" },
          redis: { state: "healthy" },
          workerQueues: { state: "healthy" },
          embeddingService: { state: "healthy" },
          apiToken: { state: "healthy", configured: true },
          mcpServer: { state: "healthy" },
          captureHook: { state: "healthy" },
          codex: { state: "healthy", configured: true },
          lcmSummaryService: { state: "healthy" },
          explorer: { state: "healthy", url: "http://localhost:5174" },
          lastVerification: { state: "healthy", checkedAt: "2026-01-01T00:00:00.000Z" }
        }) as never,
      command: "/node",
      entrypoint: "/repo/packages/koed-server/dist/cli.js",
      openSync: () => 1,
      closeSync: () => undefined,
      spawn: (_command, args) => {
        spawned.push(args);
        return {
          pid: 42,
          unref: () => undefined
        } as never;
      }
    });

    expect(result).toMatchObject({ ok: true, pid: 42 });
    expect(killed).toEqual([11, 10]);
    expect(spawned).toEqual([["/repo/packages/koed-server/dist/cli.js", "start"]]);
  });
});
