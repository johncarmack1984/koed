import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { KoedServerPaths } from "./paths.js";
import type { KoedServerRuntimeState } from "./types.js";

export interface RuntimeStateFileDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  rmSync?: typeof rmSync;
  writeFileSync?: typeof writeFileSync;
}

export const readRuntimeState = (
  paths: KoedServerPaths,
  {
    existsSync: pathExists = existsSync,
    readFileSync: readFile = readFileSync
  }: RuntimeStateFileDeps = {}
): KoedServerRuntimeState | null => {
  if (!pathExists(paths.runtimeStatePath)) {
    return null;
  }
  try {
    return JSON.parse(
      readFile(paths.runtimeStatePath, "utf8") as string
    ) as KoedServerRuntimeState;
  } catch {
    return null;
  }
};

export const writeRuntimeState = (
  paths: KoedServerPaths,
  runtime: KoedServerRuntimeState,
  { writeFileSync: writeFile = writeFileSync }: RuntimeStateFileDeps = {}
): void => {
  writeFile(paths.runtimeStatePath, `${JSON.stringify(runtime, null, 2)}\n`, {
    mode: 0o600
  });
};

export const removeRuntimeState = (
  paths: KoedServerPaths,
  { rmSync: remove = rmSync }: RuntimeStateFileDeps = {}
): void => {
  remove(paths.runtimeStatePath, { force: true });
};

export const runtimeProcessPids = (runtime: KoedServerRuntimeState): number[] =>
  [
    runtime.processes?.api,
    runtime.processes?.worker,
    runtime.processes?.explorer,
    ...Object.entries(runtime.processes ?? {})
      .filter(([name]) => !["api", "worker", "explorer"].includes(name))
      .map(([, pid]) => pid),
    runtime.pid
  ]
    .filter(
      (pid): pid is number =>
        typeof pid === "number" && Number.isInteger(pid) && pid > 0
    )
    .filter((pid, index, values) => values.indexOf(pid) === index);
