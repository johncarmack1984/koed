#!/usr/bin/env node
/* global console, process */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const runtimeRoot = resolve(desktopRoot, ".koed-runtime");

const run = (label, command, args) => {
  console.log(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with ${result.status ?? 1}`);
  }
};

const deploy = (filter, to) =>
  run(`Deploy ${filter}`, "pnpm", [
    "--filter",
    filter,
    "deploy",
    "--legacy",
    "--prod",
    resolve(runtimeRoot, to)
  ]);

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });

deploy("@koed/api", "api");
deploy("@koed/worker", "worker");
deploy("@koed/mcp-server", "mcp-server");
cpSync(
  resolve(repoRoot, "apps/explorer/dist"),
  resolve(runtimeRoot, "explorer-dist"),
  {
    recursive: true
  }
);

const required = [
  "api/dist/index.js",
  "api/node_modules/@koed/db/dist/index.js",
  "api/node_modules/@koed/db/drizzle/meta/_journal.json",
  "worker/dist/index.js",
  "mcp-server/dist/cli.js",
  "mcp-server/dist/capture-hook.js",
  "explorer-dist/index.html"
];
const missing = required.filter(
  (entry) => !existsSync(resolve(runtimeRoot, entry))
);
if (missing.length > 0) {
  throw new Error(`Prepared Koed runtime is missing: ${missing.join(", ")}`);
}

// `pnpm deploy --prod` leaves workspace dependency metadata in production mode.
// Restore dev install state so follow-up package/test commands do not prompt.
run("Restore workspace dependencies", "pnpm", [
  "install",
  "--config.confirmModulesPurge=false"
]);

console.log(JSON.stringify({ ok: true, runtimeRoot, required }, null, 2));
