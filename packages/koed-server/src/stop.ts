import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolveKoedServerPaths } from "./paths.js";
import {
  readRuntimeState,
  removeRuntimeState,
  runtimeProcessPids
} from "./runtime-state.js";

export interface KoedServerStopResult {
  ok: boolean;
  state: "healthy" | "not_configured" | "needs_attention";
  koedHome: string;
  message: string;
  stoppedPids: number[];
  missingPids: number[];
  errors?: Array<{ pid: number; error: string }>;
}

export interface KoedServerStopOptions {
  environment?: NodeJS.ProcessEnv;
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  rmSync?: typeof rmSync;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export const stopKoedServer = ({
  environment = process.env,
  existsSync: pathExists = existsSync,
  readFileSync: readFile = readFileSync,
  rmSync: remove = rmSync,
  kill = (pid, signal) => {
    process.kill(pid, signal);
  }
}: KoedServerStopOptions = {}): KoedServerStopResult => {
  const paths = resolveKoedServerPaths(environment);
  const runtime = readRuntimeState(paths, {
    existsSync: pathExists,
    readFileSync: readFile
  });

  if (!runtime) {
    return {
      ok: true,
      state: "not_configured",
      koedHome: paths.koedHome,
      message: "No koed-server runtime state was found.",
      stoppedPids: [],
      missingPids: []
    };
  }

  const stoppedPids: number[] = [];
  const missingPids: number[] = [];
  const errors: Array<{ pid: number; error: string }> = [];
  for (const pid of runtimeProcessPids(runtime)) {
    try {
      kill(pid, "SIGTERM");
      stoppedPids.push(pid);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "ESRCH") {
        missingPids.push(pid);
      } else {
        errors.push({
          pid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  if (errors.length === 0) {
    removeRuntimeState(paths, { rmSync: remove });
  }

  return {
    ok: errors.length === 0,
    state: errors.length === 0 ? "healthy" : "needs_attention",
    koedHome: paths.koedHome,
    message:
      errors.length === 0
        ? "Koed server stop signal sent."
        : "Koed server stop encountered errors.",
    stoppedPids,
    missingPids,
    ...(errors.length > 0 ? { errors } : {})
  };
};
