#!/usr/bin/env node
/* global console, process */
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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

const platformKey = () => {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return process.platform;
};

const listFiles = (root, dir = root) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return listFiles(root, path);
    return [relative(root, path).replaceAll("\\", "/")];
  });

const sha256Files = (root, files) => {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const path = resolve(root, file);
    if (statSync(path).isDirectory()) continue;
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const makeExecutableIfPresent = (path) => {
  if (existsSync(path)) chmodSync(path, 0o755);
};

const addAsset = ({ assets, id, root, version, executablePaths }) => {
  if (!existsSync(root)) return;
  const expectedFiles = listFiles(root);
  if (expectedFiles.length === 0) return;
  for (const path of Object.values(executablePaths)) {
    makeExecutableIfPresent(resolve(root, path));
  }
  assets.push({
    id,
    platform: platformKey(),
    architecture: process.arch,
    version,
    packagedResourcePath: id,
    sha256: sha256Files(root, expectedFiles),
    expectedFiles,
    executablePaths,
    installPath: id
  });
};

const copyEmbeddingServiceApp = () => {
  const source = resolve(repoRoot, "apps", "embedding-service");
  const target = resolve(runtimeRoot, "embedding-service");
  mkdirSync(target, { recursive: true });
  for (const entry of [
    "app.py",
    "auth.py",
    "env_config.py",
    "logging_config.py",
    "priority_scheduler.py",
    "runtime.py",
    "schemas.py",
    "settings.py",
    "vectors.py",
    "requirements.txt",
    "pyproject.toml"
  ]) {
    cpSync(resolve(source, entry), resolve(target, entry));
  }
};

const writeNativeManifest = () => {
  const assets = [];
  addAsset({
    assets,
    id: "postgres",
    root: resolve(runtimeRoot, "postgres"),
    version: "postgresql-17-pgvector-packaged",
    executablePaths: {
      initdb: "bin/initdb",
      pg_ctl: "bin/pg_ctl",
      psql: "bin/psql",
      pg_config: "bin/pg_config"
    }
  });
  addAsset({
    assets,
    id: "llama.cpp",
    root: resolve(runtimeRoot, "llama.cpp"),
    version: "llama-server-packaged",
    executablePaths: { llama_server: "llama-server" }
  });
  if (
    existsSync(
      resolve(runtimeRoot, "embedding-service", ".venv", "bin", "python")
    )
  ) {
    addAsset({
      assets,
      id: "embedding-service",
      root: resolve(runtimeRoot, "embedding-service"),
      version: "embedding-service-python-packaged",
      executablePaths: { python: ".venv/bin/python" }
    });
  }
  if (assets.length === 0) return [];
  writeFileSync(
    resolve(runtimeRoot, "runtime-asset-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`
  );
  return assets.map((asset) => asset.id);
};

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
copyEmbeddingServiceApp();

const nativeRuntimeSource = process.env.KOED_NATIVE_RUNTIME_SOURCE_DIR?.trim();
if (nativeRuntimeSource) {
  if (!existsSync(nativeRuntimeSource)) {
    throw new Error(
      `KOED_NATIVE_RUNTIME_SOURCE_DIR does not exist: ${nativeRuntimeSource}`
    );
  }
  cpSync(resolve(nativeRuntimeSource), runtimeRoot, {
    recursive: true,
    preserveTimestamps: true
  });
}
const nativeAssets = writeNativeManifest();

const required = [
  "api/dist/index.js",
  "api/node_modules/@koed/db/dist/index.js",
  "api/node_modules/@koed/db/drizzle/meta/_journal.json",
  "worker/dist/index.js",
  "mcp-server/dist/cli.js",
  "mcp-server/dist/capture-hook.js",
  "explorer-dist/index.html",
  "embedding-service/app.py",
  "embedding-service/requirements.txt"
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

console.log(
  JSON.stringify({ ok: true, runtimeRoot, required, nativeAssets }, null, 2)
);
