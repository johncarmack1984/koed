import {
  startKoedServerDaemon,
  type KoedServerDaemonStartOptions,
  type KoedServerDaemonStartResult
} from "./start.js";
import { stopKoedServer, type KoedServerStopOptions } from "./stop.js";

export interface KoedServerRestartResult extends KoedServerDaemonStartResult {
  stoppedPids: number[];
  missingPids: number[];
}

export interface KoedServerRestartOptions
  extends KoedServerDaemonStartOptions, KoedServerStopOptions {
  waitForExitMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultCheckPid = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPidsToExit = async (
  pids: number[],
  {
    checkPid = defaultCheckPid,
    waitForExitMs = 10_000,
    pollIntervalMs = 250,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  }: Pick<
    KoedServerRestartOptions,
    "checkPid" | "waitForExitMs" | "pollIntervalMs" | "sleep"
  >
): Promise<number[]> => {
  const uniquePids = [...new Set(pids)].filter((pid) => pid > 0);
  const deadline = Date.now() + waitForExitMs;
  let running = uniquePids.filter(checkPid);
  while (running.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    running = uniquePids.filter(checkPid);
  }
  return running;
};

export const restartKoedServer = async (
  options: KoedServerRestartOptions = {}
): Promise<KoedServerRestartResult> => {
  const stop = stopKoedServer(options);
  if (!stop.ok) {
    return {
      ok: false,
      state: "needs_attention",
      koedHome: stop.koedHome,
      message: stop.message,
      stoppedPids: stop.stoppedPids,
      missingPids: stop.missingPids
    };
  }

  const stillRunning = await waitForPidsToExit(stop.stoppedPids, options);
  if (stillRunning.length > 0) {
    return {
      ok: false,
      state: "needs_attention",
      koedHome: stop.koedHome,
      message: "Timed out waiting for koed-server processes to stop.",
      stoppedPids: stop.stoppedPids,
      missingPids: stop.missingPids
    };
  }

  const start = await startKoedServerDaemon({ ...options, force: true });
  return {
    ...start,
    stoppedPids: stop.stoppedPids,
    missingPids: stop.missingPids
  };
};
