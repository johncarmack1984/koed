import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startKoedServer, startKoedServerDaemon } from "./start.js";
import type { KoedServerStatus } from "./types.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-server-start-"));
  temps.push(path);
  return path;
};

const spawnResult = () =>
  ({
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    pid: 1,
    output: []
  }) as never;

const healthyStatus = (root: string): KoedServerStatus => ({
  ok: true,
  state: "healthy",
  koedHome: root,
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
});

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("start supervisor", () => {
  it("starts a detached daemon process", async () => {
    const root = tempDir();
    const spawned: Array<{
      command: string;
      args: string[];
      options: { detached?: boolean; stdio?: unknown };
    }> = [];

    const result = await startKoedServerDaemon({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      command: "/node",
      entrypoint: "/repo/packages/koed-server/dist/cli.js",
      collectStatus: async () => ({
        ...healthyStatus(root),
        ok: false,
        state: "needs_attention",
        api: { state: "needs_attention", url: "http://localhost:3300" }
      }),
      spawn: (command, args, options) => {
        spawned.push({ command, args, options: options ?? {} });
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          unref: () => void;
        };
        child.pid = 42;
        child.unref = () => undefined;
        return child as never;
      }
    });

    expect(result).toMatchObject({
      ok: true,
      state: "starting",
      pid: 42
    });
    expect(spawned).toEqual([
      {
        command: "/node",
        args: ["/repo/packages/koed-server/dist/cli.js", "start"],
        options: expect.objectContaining({
          detached: true,
          stdio: ["ignore", expect.any(Number), expect.any(Number)]
        }) as never
      }
    ]);
  });

  it("reuses a starting daemon from runtime state", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({ pid: 99 })
    );
    const spawned: string[][] = [];

    const result = await startKoedServerDaemon({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      collectStatus: async () => ({
        ...healthyStatus(root),
        ok: false,
        state: "starting",
        api: { state: "starting", url: "http://localhost:3300" }
      }),
      checkPid: (pid) => pid === 99,
      spawn: (_command, args) => {
        spawned.push(args);
        throw new Error("spawn should not be called");
      }
    });

    expect(result).toMatchObject({
      ok: true,
      state: "starting",
      pid: 99
    });
    expect(spawned).toEqual([]);
  });

  it("removes stale runtime state before spawning a fresh daemon", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({ pid: 99 })
    );
    const removed: string[] = [];

    const result = await startKoedServerDaemon({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      command: "/node",
      entrypoint: "/repo/packages/koed-server/dist/cli.js",
      collectStatus: async () => ({
        ...healthyStatus(root),
        ok: false,
        state: "starting",
        api: { state: "starting", url: "http://localhost:3300" }
      }),
      checkPid: () => false,
      rmSync: (path) => {
        removed.push(String(path));
      },
      openSync: () => 1,
      closeSync: () => undefined,
      spawn: () =>
        ({
          pid: 42,
          unref: () => undefined
        }) as never
    });

    expect(result.pid).toBe(42);
    expect(removed).toEqual([
      resolve(root, "run/koed-server.json"),
      resolve(root, "run/koed-server.starting.lock")
    ]);
  });

  it("does not spawn another daemon while a start is locked", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(resolve(root, "run/koed-server.starting.lock"), "");
    const spawned: string[][] = [];

    const result = await startKoedServerDaemon({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      collectStatus: async () => ({
        ...healthyStatus(root),
        ok: false,
        state: "starting",
        api: { state: "starting", url: "http://localhost:3300" }
      }),
      spawn: (_command, args) => {
        spawned.push(args);
        throw new Error("spawn should not be called");
      }
    });

    expect(result).toMatchObject({
      ok: true,
      state: "starting"
    });
    expect(spawned).toEqual([]);
  });

  it("cleans stale runtime state before accepting a healthy API", async () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({ pid: 99 })
    );
    const removed: string[] = [];
    const spawned: string[][] = [];

    const result = await startKoedServerDaemon({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      collectStatus: async () => healthyStatus(root),
      checkPid: () => false,
      rmSync: (path) => {
        removed.push(String(path));
      },
      spawn: (_command, args) => {
        spawned.push(args);
        throw new Error("spawn should not be called");
      }
    });

    expect(result).toMatchObject({
      ok: true,
      state: "healthy"
    });
    expect(removed).toEqual([resolve(root, "run/koed-server.json")]);
    expect(spawned).toEqual([]);
  });

  it("starts services in order and follows logs", async () => {
    const root = tempDir();
    const commands: Array<{ command: string; args: string[] }> = [];
    const spawned: Array<{ command: string; args: string[] }> = [];

    await startKoedServer({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      timeoutMs: 1,
      pollIntervalMs: 1,
      spawnSync: (command, args) => {
        commands.push({ command, args });
        return spawnResult();
      },
      spawn: (command, args) => {
        spawned.push({ command, args });
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          kill: () => boolean;
        };
        child.pid = spawned.length;
        child.kill = () => true;
        setTimeout(() => child.emit("exit", 0), 0);
        return child as never;
      },
      collectStatus: async () => healthyStatus(root)
    });

    expect(commands.map((command) => command.args.join(" "))).toEqual([
      resolve(root, "scripts/setup-env.mjs"),
      "compose up -d --build --remove-orphans postgres redis embedding-service",
      "--filter @koed/api --filter @koed/worker --filter @koed/explorer build"
    ]);
    expect(spawned.map((entry) => entry.args.join(" "))).toEqual([
      "--filter @koed/api start",
      "--filter @koed/worker start",
      "--filter @koed/explorer exec vite preview --host 127.0.0.1 --port 5174"
    ]);
    const runtime = JSON.parse(
      readFileSync(resolve(root, "run/koed-server.json"), "utf8")
    ) as { version?: { koedServer?: unknown } };
    expect(typeof runtime.version?.koedServer).toBe("string");
    expect(runtime).toMatchObject({
      pid: process.pid,
      startedBy: "cli",
      dependencyMode: "managed",
      logs: {
        supervisor: resolve(root, "logs/koed-server.out.log"),
        supervisorError: resolve(root, "logs/koed-server.err.log")
      },
      processes: {
        api: 1,
        worker: 2,
        explorer: 3
      }
    });
  });
});
