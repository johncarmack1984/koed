import { describe, expect, it } from "vitest";
import { createKoedEnvironment, createKoedServerManager } from "./manager.js";

describe("Koed server desktop manager", () => {
  it("adds KOED_REPO_ROOT without overriding explicit values", () => {
    expect(createKoedEnvironment("/repo", {})).toMatchObject({
      KOED_REPO_ROOT: "/repo"
    });
    expect(
      createKoedEnvironment("/repo", { KOED_REPO_ROOT: "/custom" })
    ).toMatchObject({
      KOED_REPO_ROOT: "/custom"
    });
  });

  it("runs JSON koed-server commands", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/packages/koed-server/dist/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/packages/koed-server/dist/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (command, args, _options, callback) => {
        calls.push({ command, args });
        callback(null, JSON.stringify({ ok: true, state: "healthy" }), "");
      },
      openExternal: async () => undefined
    });

    await expect(manager.handlers.status!()).resolves.toMatchObject({
      ok: true,
      state: "healthy"
    });
    expect(calls[0]).toEqual({
      command: "/node",
      args: ["/repo/packages/koed-server/dist/cli.js", "status", "--json"]
    });
  });

  it("reports missing koed-server CLI as not_configured", async () => {
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/missing",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/missing", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => false,
      execFile: () => undefined,
      openExternal: async () => undefined
    });

    await expect(manager.handlers.doctor!()).resolves.toMatchObject({
      ok: false,
      state: "not_configured"
    });
    await expect(manager.handlers.start!()).resolves.toMatchObject({
      ok: false,
      state: "not_configured"
    });
  });

  it("starts koed-server as a daemon and leaves it running on quit", async () => {
    const calls: string[][] = [];
    let statusCalls = 0;
    const manager = createKoedServerManager({
      repoRoot: "/repo",
      cliPath: "/repo/cli.js",
      environment: {},
      createCliInvocation: (args) => ({
        command: "/node",
        args: ["/repo/cli.js", ...args],
        env: { KOED_REPO_ROOT: "/repo" }
      }),
      existsSync: () => true,
      execFile: (_command, args, _options, callback) => {
        calls.push(args);
        if (args.includes("start")) {
          callback(
            null,
            JSON.stringify({ ok: true, state: "starting", pid: 123 }),
            ""
          );
          return;
        }
        if (args.includes("stop")) {
          callback(null, JSON.stringify({ ok: true, state: "healthy" }), "");
          return;
        }
        if (args.includes("restart")) {
          callback(null, JSON.stringify({ ok: true, state: "starting" }), "");
          return;
        }

        statusCalls += 1;
        callback(
          null,
          JSON.stringify(
            statusCalls === 1
              ? {
                  ok: false,
                  state: "needs_attention",
                  api: { state: "needs_attention" }
                }
              : { ok: true, state: "healthy", api: { state: "healthy" } }
          ),
          ""
        );
      },
      openExternal: async () => undefined
    });

    await expect(manager.handlers.start!()).resolves.toMatchObject({
      state: "healthy"
    });
    await expect(manager.handlers.start!()).resolves.toMatchObject({
      state: "healthy"
    });
    expect(calls).toEqual([
      ["/repo/cli.js", "status", "--json"],
      ["/repo/cli.js", "start", "--daemon", "--json"],
      ["/repo/cli.js", "status", "--json"],
      ["/repo/cli.js", "status", "--json"]
    ]);

    manager.stop();
    expect(calls).toHaveLength(4);
    await expect(manager.handlers.stop_service!()).resolves.toMatchObject({
      ok: true
    });
    expect(calls.at(-1)).toEqual(["/repo/cli.js", "stop", "--json"]);
    await expect(manager.handlers.restart_service!()).resolves.toMatchObject({
      ok: true
    });
    expect(calls.at(-1)).toEqual(["/repo/cli.js", "restart", "--json"]);
  });
});
