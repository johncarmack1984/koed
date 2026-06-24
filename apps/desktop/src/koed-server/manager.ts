import type { NodeEntrypointInvocation } from "./runtime.js";

export type DesktopCommandHandler = (args?: Record<string, unknown>) => unknown;

export interface KoedServerManagerOptions {
  repoRoot: string;
  cliPath: string;
  environment: NodeJS.ProcessEnv;
  createCliInvocation: (args: string[]) => NodeEntrypointInvocation;
  existsSync: (path: string) => boolean;
  execFile: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeout: number;
    },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => void;
  openExternal: (url: string) => Promise<unknown>;
  openPath: (path: string) => Promise<string>;
  appVersion?: string;
}

export interface KoedServerManager {
  handlers: Record<string, DesktopCommandHandler>;
  stop: () => void;
}

const missingCliPayload = () => ({
  ok: false,
  state: "not_configured",
  error:
    "koed-server build output was not found. Run pnpm --filter @koed/koed-server build."
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const appendOutputLines = (buffer: string[], chunk: Buffer | string): void => {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    buffer.push(trimmed);
  }
  while (buffer.length > 400) {
    buffer.shift();
  }
};

const withDesktopStartLog = (
  value: unknown,
  outputLines: string[]
): unknown => {
  if (typeof value !== "object" || value === null || outputLines.length === 0) {
    return value;
  }
  return {
    ...value,
    desktopStartLog: outputLines.slice(-120)
  };
};

const hasHealthyApi = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || !("api" in value)) {
    return false;
  }
  const api = (value as { api?: unknown }).api;
  return (
    typeof api === "object" &&
    api !== null &&
    "state" in api &&
    (api as { state?: unknown }).state === "healthy"
  );
};

const hasRunningDaemon = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || !("daemon" in value)) {
    return false;
  }
  const daemon = (value as { daemon?: unknown }).daemon;
  if (typeof daemon !== "object" || daemon === null) {
    return false;
  }
  const state = (daemon as { state?: unknown }).state;
  return (
    ((daemon as { running?: unknown }).running === true &&
      (daemon as { stale?: unknown }).stale !== true) ||
    state === "healthy" ||
    state === "starting"
  );
};

const extractDaemonVersion = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || !("daemon" in value)) {
    return null;
  }
  const daemon = (value as { daemon?: unknown }).daemon;
  if (typeof daemon !== "object" || daemon === null) {
    return null;
  }
  const details = (daemon as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) {
    return null;
  }
  const version = (details as { version?: unknown }).version;
  if (typeof version !== "object" || version === null) {
    return null;
  }
  const koedServer = (version as { koedServer?: unknown }).koedServer;
  return typeof koedServer === "string" && koedServer.trim()
    ? koedServer.trim()
    : null;
};

const normalizeVersion = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/^v/i, "") : null;
};

const shouldRestartDesktopManagedDaemon = (
  value: unknown,
  appVersion?: string
): boolean => {
  const current = normalizeVersion(extractDaemonVersion(value));
  const expected = normalizeVersion(appVersion);
  if (!current || !expected) {
    return false;
  }
  if (typeof value !== "object" || value === null || !("daemon" in value)) {
    return false;
  }
  const daemon = (value as { daemon?: unknown }).daemon;
  return (
    typeof daemon === "object" &&
    daemon !== null &&
    (daemon as { startedBy?: unknown }).startedBy === "desktop" &&
    current !== expected
  );
};

const extractDaemonLogPath = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || !("daemon" in value)) {
    return null;
  }
  const daemon = (value as { daemon?: unknown }).daemon;
  if (typeof daemon !== "object" || daemon === null || !("logs" in daemon)) {
    return null;
  }
  const logs = (daemon as { logs?: unknown }).logs;
  if (typeof logs !== "object" || logs === null) {
    return null;
  }
  const candidates = [
    (logs as Record<string, unknown>).supervisorError,
    (logs as Record<string, unknown>).supervisor,
    ...Object.values(logs as Record<string, unknown>)
  ];
  return (
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0
    ) ?? null
  );
};

export const createKoedEnvironment = (
  repoRoot: string,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => ({
  ...environment,
  KOED_REPO_ROOT: environment.KOED_REPO_ROOT ?? repoRoot
});

export const createKoedServerManager = ({
  repoRoot,
  cliPath,
  environment,
  createCliInvocation,
  existsSync,
  execFile,
  openExternal,
  openPath,
  appVersion
}: KoedServerManagerOptions): KoedServerManager => {
  const startOutputLines: string[] = [];
  void environment;

  const runJson = (args: string[], timeout = 30_000) =>
    new Promise<unknown>((resolvePromise) => {
      if (!existsSync(cliPath)) {
        resolvePromise(missingCliPayload());
        return;
      }

      const invocation = createCliInvocation([...args, "--json"]);
      execFile(
        invocation.command,
        invocation.args,
        {
          cwd: repoRoot,
          env: invocation.env,
          timeout
        },
        (error, stdout, stderr) => {
          try {
            resolvePromise(JSON.parse(stdout));
          } catch {
            resolvePromise({
              ok: false,
              state: "needs_attention",
              error:
                error?.message ??
                (stderr.trim() ||
                  stdout.trim() ||
                  "koed-server command failed."),
              stdout: stdout.trim(),
              stderr: stderr.trim()
            });
          }
        }
      );
    });

  const pollUntilReady = async () => {
    let latest: unknown = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      latest = await runJson(["status"], 10_000);
      if (hasHealthyApi(latest)) {
        return withDesktopStartLog(latest, startOutputLines);
      }
      await sleep(1_000);
    }
    return withDesktopStartLog(
      latest ?? {
        ok: false,
        state: "needs_attention",
        error: "Timed out waiting for koed-server status."
      },
      startOutputLines
    );
  };

  const start = async () => {
    const current = await runJson(["status"], 10_000);
    if (hasHealthyApi(current)) {
      if (!shouldRestartDesktopManagedDaemon(current, appVersion)) {
        return current;
      }
      const restartResult = await runJson(["restart"], 90_000);
      if (
        typeof restartResult === "object" &&
        restartResult !== null &&
        "ok" in restartResult &&
        (restartResult as { ok?: unknown }).ok === false
      ) {
        return withDesktopStartLog(restartResult, startOutputLines);
      }
      return pollUntilReady();
    }

    if (hasRunningDaemon(current)) {
      if (shouldRestartDesktopManagedDaemon(current, appVersion)) {
        const restartResult = await runJson(["restart"], 90_000);
        if (
          typeof restartResult === "object" &&
          restartResult !== null &&
          "ok" in restartResult &&
          (restartResult as { ok?: unknown }).ok === false
        ) {
          return withDesktopStartLog(restartResult, startOutputLines);
        }
      }
      return pollUntilReady();
    }

    if (!existsSync(cliPath)) {
      return missingCliPayload();
    }

    startOutputLines.length = 0;
    const invocation = createCliInvocation(["start", "--daemon", "--json"]);
    appendOutputLines(
      startOutputLines,
      `$ ${invocation.command} ${invocation.args.join(" ")}`
    );
    const startResult = await runJson(["start", "--daemon"], 45_000);
    if (
      typeof startResult === "object" &&
      startResult !== null &&
      "ok" in startResult &&
      (startResult as { ok?: unknown }).ok === false
    ) {
      return withDesktopStartLog(startResult, startOutputLines);
    }
    return pollUntilReady();
  };

  const stop = () => {
    startOutputLines.length = 0;
  };

  return {
    handlers: {
      status: async () =>
        withDesktopStartLog(await runJson(["status"]), startOutputLines),
      doctor: () => runJson(["doctor"], 45_000),
      setup_codex: () => runJson(["setup", "codex"], 120_000),
      start,
      stop_service: () => runJson(["stop"], 45_000),
      restart_service: () => runJson(["restart"], 90_000),
      open_logs: async () => {
        const current = await runJson(["status"], 10_000);
        const logPath = extractDaemonLogPath(current);
        if (!logPath) {
          return {
            ok: false,
            state: "not_configured",
            error: "koed-server log path is not available yet."
          };
        }
        const error = await openPath(logPath);
        return error ? { ok: false, error } : { ok: true, path: logPath };
      },
      open_external: async (args) => {
        const url = typeof args?.url === "string" ? args.url : "";
        if (!url) {
          return { ok: false, error: "url is required." };
        }
        await openExternal(url);
        return { ok: true };
      }
    },
    stop
  };
};
