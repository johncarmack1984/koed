import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopKoedServer } from "./stop.js";

const temps: string[] = [];
const tempDir = () => {
  const path = mkdtempSync(resolve(tmpdir(), "koed-server-stop-"));
  temps.push(path);
  return path;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("stop supervisor", () => {
  it("signals app processes and the supervisor", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({
        pid: 10,
        startedAt: "2026-01-01T00:00:00.000Z",
        repoRoot: root,
        apiUrl: "http://localhost:3300",
        explorerUrl: "http://localhost:5174",
        services: [],
        processes: { api: 11, worker: 12, explorer: 13 }
      })
    );
    const killed: Array<{ pid: number; signal: string }> = [];

    const result = stopKoedServer({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      kill: (pid, signal) => {
        killed.push({ pid, signal });
      }
    });

    expect(result).toMatchObject({
      ok: true,
      stoppedPids: [11, 12, 13, 10]
    });
    expect(killed).toEqual([
      { pid: 11, signal: "SIGTERM" },
      { pid: 12, signal: "SIGTERM" },
      { pid: 13, signal: "SIGTERM" },
      { pid: 10, signal: "SIGTERM" }
    ]);
  });

  it("cleans runtime state when processes are already gone", () => {
    const root = tempDir();
    mkdirSync(resolve(root, "run"), { recursive: true });
    writeFileSync(
      resolve(root, "run/koed-server.json"),
      JSON.stringify({
        pid: 10,
        startedAt: "2026-01-01T00:00:00.000Z",
        repoRoot: root,
        apiUrl: "http://localhost:3300",
        explorerUrl: "http://localhost:5174",
        services: [],
        processes: { api: 11, worker: 12 }
      })
    );

    const result = stopKoedServer({
      environment: { KOED_HOME: root, KOED_REPO_ROOT: root },
      kill: (pid) => {
        const error = new Error(`missing ${pid}`) as Error & { code: string };
        error.code = "ESRCH";
        throw error;
      }
    });

    expect(result).toMatchObject({
      ok: true,
      stoppedPids: [],
      missingPids: [11, 12, 10]
    });
  });
});
