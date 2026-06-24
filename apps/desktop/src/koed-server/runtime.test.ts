import { describe, expect, it } from "vitest";
import {
  assertPathExists,
  createElectronNodeEnv,
  createKoedServerCliInvocation,
  createKoedServerInvocationEnvironment,
  resolveElectronNodeExecPath,
  resolveKoedServerRuntimeLayout,
  resolvePackagedKoedAppRoot
} from "./runtime.js";

describe("Koed Desktop Node entrypoint runtime", () => {
  it("marks Electron child processes as Node-compatible", () => {
    expect(createElectronNodeEnv({ FOO: "bar" })).toMatchObject({
      FOO: "bar",
      ELECTRON_RUN_AS_NODE: "1"
    });
  });

  it("resolves development runtime paths from the workspace", () => {
    expect(
      resolveKoedServerRuntimeLayout({
        appIsPackaged: false,
        appDir: "/repo/apps/desktop/dist-electron"
      })
    ).toEqual({
      repoRoot: "/repo",
      cliPath: "/repo/packages/koed-server/dist/cli.js",
      appDistDir: "/repo/apps/desktop/dist"
    });
  });

  it("resolves packaged runtime paths under resources without a repo checkout", () => {
    expect(
      resolvePackagedKoedAppRoot("/Applications/Koed.app/Contents/Resources")
    ).toBe("/Applications/Koed.app/Contents/Resources/koed-app-root");
    expect(
      resolveKoedServerRuntimeLayout({
        appIsPackaged: true,
        appDir:
          "/Applications/Koed.app/Contents/Resources/app.asar/dist-electron",
        resourcesPath: "/Applications/Koed.app/Contents/Resources"
      })
    ).toEqual({
      repoRoot: "/Applications/Koed.app/Contents/Resources/koed-app-root",
      cliPath:
        "/Applications/Koed.app/Contents/Resources/koed-app-root/packages/koed-server/dist/cli.js",
      appDistDir: "/Applications/Koed.app/Contents/Resources/app-dist"
    });
  });

  it("sets KOED_REPO_ROOT only for development invocations", () => {
    expect(
      createKoedServerInvocationEnvironment({
        appIsPackaged: false,
        environment: {},
        repoRoot: "/repo"
      })
    ).toMatchObject({ KOED_DESKTOP_MANAGED: "1", KOED_REPO_ROOT: "/repo" });
    expect(
      createKoedServerInvocationEnvironment({
        appIsPackaged: true,
        environment: {},
        repoRoot: "/resources/koed-app-root"
      })
    ).toEqual({
      KOED_DESKTOP_MANAGED: "1",
      KOED_PACKAGED_APP_ROOT: "/resources/koed-app-root"
    });
  });

  it("throws labeled errors for missing packaged runtime files", () => {
    expect(() =>
      assertPathExists({
        label: "Bundled koed-server CLI",
        filePath: "/missing/cli.js",
        existsSync: () => false
      })
    ).toThrow("Bundled koed-server CLI is missing at /missing/cli.js");
  });

  it("uses explicit KOED_NODE_COMMAND when configured", () => {
    const invocation = createKoedServerCliInvocation(
      "/repo/cli.js",
      ["status"],
      {
        appIsPackaged: false,
        electronExecPath: "/Applications/Koed.app/Contents/MacOS/Koed",
        platform: "darwin",
        environment: { KOED_NODE_COMMAND: "/opt/node/bin/node" }
      }
    );

    expect(invocation).toEqual({
      command: "/opt/node/bin/node",
      args: ["/repo/cli.js", "status"],
      env: { KOED_NODE_COMMAND: "/opt/node/bin/node" }
    });
  });

  it("uses Electron in explicit Node mode for development", () => {
    const invocation = createKoedServerCliInvocation(
      "/repo/packages/koed-server/dist/cli.js",
      ["doctor", "--json"],
      {
        appIsPackaged: false,
        electronExecPath: "/repo/node_modules/.bin/electron",
        platform: "darwin",
        environment: { KOED_REPO_ROOT: "/repo" }
      }
    );

    expect(invocation.command).toBe("/repo/node_modules/.bin/electron");
    expect(invocation.args).toEqual([
      "/repo/packages/koed-server/dist/cli.js",
      "doctor",
      "--json"
    ]);
    expect(invocation.env).toMatchObject({
      KOED_REPO_ROOT: "/repo",
      ELECTRON_RUN_AS_NODE: "1"
    });
  });

  it("uses the macOS Helper executable for packaged Electron node mode", () => {
    const execPath = resolveElectronNodeExecPath({
      appIsPackaged: true,
      electronExecPath: "/Applications/Koed.app/Contents/MacOS/Koed",
      platform: "darwin",
      existsSync: (path) => path.endsWith("Koed Helper")
    });

    expect(execPath).toBe(
      "/Applications/Koed.app/Contents/Frameworks/Koed Helper.app/Contents/MacOS/Koed Helper"
    );
  });

  it("wraps packaged script entrypoints with the runner", () => {
    const invocation = createKoedServerCliInvocation(
      "/app/cli.js",
      ["status"],
      {
        appIsPackaged: true,
        electronExecPath: "/Applications/Koed.app/Contents/MacOS/Koed",
        platform: "linux",
        resourcesPath: "/Applications/Koed.app/Contents/Resources",
        environment: {},
        existsSync: () => true
      }
    );

    expect(invocation.args).toEqual([
      "/Applications/Koed.app/Contents/Resources/app.asar.unpacked/dist-electron/koed-server/node-entrypoint-runner.js",
      "node-script",
      "/app/cli.js",
      "status"
    ]);
    expect(invocation.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});
