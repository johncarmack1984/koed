import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { KoedServerPaths } from "./paths.js";
import { resolvePackagedKoedRuntimeRoot } from "./runtime-artifact-source.js";
import type { RuntimeInstallState } from "./runtime-homebrew.js";

export interface PackagedRuntimeAssetManifestEntry {
  id: string;
  platform: string;
  architecture: string;
  version: string;
  url?: string;
  packagedResourcePath?: string;
  sha256: string;
  expectedFiles: string[];
  executablePaths: Record<string, string>;
  installPath?: string;
}

export interface PackagedRuntimeAssetManifest {
  schemaVersion: 1;
  assets: PackagedRuntimeAssetManifestEntry[];
}

export interface PackagedRuntimeAssetStatus {
  id: string;
  platform: string;
  architecture: string;
  version: string;
  source: {
    type: "packaged-resource" | "url";
    path?: string;
    url?: string;
  };
  sha256: string;
  expectedFiles: string[];
  executablePaths: Record<string, string>;
  installPath: string;
  state: RuntimeInstallState;
  installed: boolean;
  sourceAvailable: boolean;
  sourceSha256?: string;
  installedSha256?: string;
  missing?: string[];
}

export interface PackagedRuntimeStatus {
  ok: boolean;
  state: RuntimeInstallState;
  provider: "packaged";
  platform: string;
  architecture: string;
  koedHome: string;
  manifestPath: string;
  packagedRuntimeRoot?: string;
  assets: PackagedRuntimeAssetStatus[];
  message: string;
  action?: string;
}

export interface PackagedRuntimeInstallResult extends PackagedRuntimeStatus {
  copiedPaths: string[];
}

export interface PackagedRuntimeDependencies {
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
  now?: () => Date;
}

const MANIFEST_FILENAME = "runtime-asset-manifest.json";
const METADATA_FILENAME = "runtime-packaged.json";

const platformKey = (platform: string): string => {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
};

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeSha256 = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Packaged runtime SHA-256 must be 64 hex characters.");
  }
  return normalized;
};

const isInside = (base: string, child: string): boolean => {
  const rel = relative(resolve(base), resolve(child));
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
};

const safeResolve = (base: string, path: string): string => {
  if (path.includes("\0")) {
    throw new Error(`Packaged runtime path contains NUL byte: ${path}`);
  }
  const resolved = resolve(base, path);
  if (!isInside(base, resolved)) {
    throw new Error(`Packaged runtime path escapes base directory: ${path}`);
  }
  return resolved;
};

const assetFiles = (entry: PackagedRuntimeAssetManifestEntry): string[] =>
  [
    ...new Set([
      ...entry.expectedFiles,
      ...Object.values(entry.executablePaths)
    ])
  ].sort();

export const sha256PackagedRuntimeFiles = (
  root: string,
  files: string[]
): string => {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const absolute = safeResolve(root, file);
    const stat = statSync(absolute);
    if (stat.isDirectory()) continue;
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const manifestPath = (paths: KoedServerPaths, root?: string): string =>
  root
    ? resolve(root, MANIFEST_FILENAME)
    : resolve(paths.cacheDir, MANIFEST_FILENAME);

const metadataPath = (paths: KoedServerPaths): string =>
  resolve(paths.cacheDir, METADATA_FILENAME);

const readManifest = (
  paths: KoedServerPaths,
  packagedRuntimeRoot?: string
): {
  manifest?: PackagedRuntimeAssetManifest;
  path: string;
  error?: string;
} => {
  const candidates = [
    packagedRuntimeRoot ? manifestPath(paths, packagedRuntimeRoot) : undefined,
    manifestPath(paths)
  ].filter((value): value is string => Boolean(value));
  const path = candidates[0] ?? manifestPath(paths);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return {
        manifest: validateManifest(JSON.parse(readFileSync(candidate, "utf8"))),
        path: candidate
      };
    } catch (error) {
      return {
        path: candidate,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return { path, error: "manifest not found" };
};

const validateManifest = (value: unknown): PackagedRuntimeAssetManifest => {
  if (!value || typeof value !== "object") {
    throw new Error("Packaged runtime manifest must be an object.");
  }
  const manifest = value as PackagedRuntimeAssetManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error(
      "Packaged runtime manifest schemaVersion 1 with assets is required."
    );
  }
  for (const asset of manifest.assets) {
    if (!asset.id || !asset.platform || !asset.architecture || !asset.version) {
      throw new Error(
        "Packaged runtime asset requires id, platform, architecture, and version."
      );
    }
    if (!trim(asset.url) && !trim(asset.packagedResourcePath)) {
      throw new Error(
        "Packaged runtime asset requires url or packagedResourcePath."
      );
    }
    normalizeSha256(asset.sha256);
    if (!Array.isArray(asset.expectedFiles)) {
      throw new Error("Packaged runtime asset expectedFiles must be an array.");
    }
    if (!asset.executablePaths || typeof asset.executablePaths !== "object") {
      throw new Error(
        "Packaged runtime asset executablePaths must be an object."
      );
    }
  }
  return manifest;
};

const matchesHost = (
  asset: PackagedRuntimeAssetManifestEntry,
  platform: string,
  architecture: string
): boolean => {
  const hostPlatform = platformKey(platform);
  return (
    (asset.platform === platform || asset.platform === hostPlatform) &&
    asset.architecture === architecture
  );
};

const installRoot = (paths: KoedServerPaths): string =>
  resolve(paths.koedHome, "runtime");

const assetInstallPath = (
  paths: KoedServerPaths,
  asset: PackagedRuntimeAssetManifestEntry
): string => safeResolve(installRoot(paths), asset.installPath ?? asset.id);

const assetSourceRoot = (
  root: string | undefined,
  asset: PackagedRuntimeAssetManifestEntry
): string | undefined =>
  root && asset.packagedResourcePath
    ? safeResolve(root, asset.packagedResourcePath)
    : undefined;

const assetStatus = (
  paths: KoedServerPaths,
  root: string | undefined,
  asset: PackagedRuntimeAssetManifestEntry
): PackagedRuntimeAssetStatus => {
  const expectedSha = normalizeSha256(asset.sha256);
  const sourceRoot = assetSourceRoot(root, asset);
  const targetRoot = assetInstallPath(paths, asset);
  const files = assetFiles(asset);
  const missingSource = sourceRoot
    ? files.filter((file) => !existsSync(safeResolve(sourceRoot, file)))
    : ["packagedResourcePath"];
  const missingInstalled = files.filter(
    (file) => !existsSync(safeResolve(targetRoot, file))
  );
  const sourceSha256 =
    sourceRoot && missingSource.length === 0
      ? sha256PackagedRuntimeFiles(sourceRoot, files)
      : undefined;
  const installedSha256 =
    missingInstalled.length === 0
      ? sha256PackagedRuntimeFiles(targetRoot, files)
      : undefined;
  const installed = installedSha256 === expectedSha;
  const mismatch =
    (sourceSha256 !== undefined && sourceSha256 !== expectedSha) ||
    (installedSha256 !== undefined && installedSha256 !== expectedSha);
  return {
    id: asset.id,
    platform: asset.platform,
    architecture: asset.architecture,
    version: asset.version,
    source: asset.packagedResourcePath
      ? { type: "packaged-resource", path: sourceRoot }
      : { type: "url", url: asset.url },
    sha256: expectedSha,
    expectedFiles: asset.expectedFiles,
    executablePaths: asset.executablePaths,
    installPath: targetRoot,
    state: installed ? "installed" : mismatch ? "incompatible" : "missing",
    installed,
    sourceAvailable: missingSource.length === 0,
    sourceSha256,
    installedSha256,
    missing: [...missingSource, ...missingInstalled]
  };
};

const statusFromAssets = (
  paths: KoedServerPaths,
  platform: string,
  architecture: string,
  manifestFile: string,
  root: string | undefined,
  assets: PackagedRuntimeAssetStatus[]
): PackagedRuntimeStatus => {
  const incompatible = assets.some((asset) => asset.state === "incompatible");
  const ok = assets.length > 0 && assets.every((asset) => asset.installed);
  const state: RuntimeInstallState = ok
    ? "installed"
    : incompatible
      ? "incompatible"
      : "missing";
  return {
    ok,
    state,
    provider: "packaged",
    platform: platformKey(platform),
    architecture,
    koedHome: paths.koedHome,
    manifestPath: manifestFile,
    packagedRuntimeRoot: root,
    assets,
    message: ok
      ? "Packaged bundled-local runtime is installed under KOED_HOME."
      : state === "incompatible"
        ? "Packaged bundled-local runtime manifest or installed assets are incompatible."
        : "Packaged bundled-local runtime assets are missing from KOED_HOME/runtime.",
    action: ok
      ? undefined
      : "Run koed-server runtime install --provider packaged --dependency-mode bundled-local --json."
  };
};

export const collectPackagedRuntimeStatus = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PackagedRuntimeDependencies = {}
): PackagedRuntimeStatus => {
  const root = resolvePackagedKoedRuntimeRoot(environment);
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const loaded = readManifest(paths, root);
  if (!loaded.manifest) {
    return {
      ok: false,
      state: "missing",
      provider: "packaged",
      platform: platformKey(platform),
      architecture,
      koedHome: paths.koedHome,
      manifestPath: loaded.path,
      packagedRuntimeRoot: root,
      assets: [],
      message: `Packaged runtime asset manifest is missing or invalid: ${loaded.error ?? "unknown error"}.`,
      action:
        "Ship runtime-asset-manifest.json with packaged runtime resources."
    };
  }
  const matching = loaded.manifest.assets.filter((asset) =>
    matchesHost(asset, platform, architecture)
  );
  if (matching.length === 0) {
    return {
      ok: false,
      state: "incompatible",
      provider: "packaged",
      platform: platformKey(platform),
      architecture,
      koedHome: paths.koedHome,
      manifestPath: loaded.path,
      packagedRuntimeRoot: root,
      assets: [],
      message: `Packaged runtime asset manifest has no assets for ${platformKey(platform)}/${architecture}.`,
      action:
        "Install Homebrew-backed runtime assets or ship matching packaged assets."
    };
  }
  return statusFromAssets(
    paths,
    platform,
    architecture,
    loaded.path,
    root,
    matching.map((asset) => assetStatus(paths, root, asset))
  );
};

const copyAsset = (
  paths: KoedServerPaths,
  root: string,
  asset: PackagedRuntimeAssetManifestEntry
): string => {
  const source = assetSourceRoot(root, asset);
  if (!source) {
    throw new Error(
      `Packaged runtime asset ${asset.id} has no packagedResourcePath.`
    );
  }
  const target = assetInstallPath(paths, asset);
  const tmpName = `.install-${asset.id.replace(/[^a-zA-Z0-9._-]/g, "_")}-${process.pid}`;
  const tmp = resolve(dirname(target), tmpName);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  rmSync(tmp, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(source, tmp, { recursive: true, preserveTimestamps: true });
  for (const executable of Object.values(asset.executablePaths)) {
    chmodSync(safeResolve(tmp, executable), 0o755);
  }
  renameSync(tmp, target);
  return target;
};

export const installPackagedRuntime = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PackagedRuntimeDependencies = {}
): PackagedRuntimeInstallResult => {
  const root = resolvePackagedKoedRuntimeRoot(environment);
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  const before = collectPackagedRuntimeStatus(paths, environment, dependencies);
  if (!root || before.assets.length === 0 || before.state === "incompatible") {
    return { ...before, copiedPaths: [] };
  }
  const copiedPaths: string[] = [];
  for (const asset of before.assets) {
    if (asset.installed) continue;
    if (!asset.sourceAvailable || asset.sourceSha256 !== asset.sha256) {
      return { ...before, copiedPaths };
    }
    const loaded = readManifest(paths, root);
    const manifestAsset = loaded.manifest?.assets.find(
      (entry) =>
        entry.id === asset.id && matchesHost(entry, platform, architecture)
    );
    if (!manifestAsset) continue;
    copiedPaths.push(copyAsset(paths, root, manifestAsset));
  }
  mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
  cpSync(manifestPath(paths, root), manifestPath(paths));
  writeFileSync(
    metadataPath(paths),
    `${JSON.stringify(
      {
        provider: "packaged",
        installedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        manifestPath: manifestPath(paths),
        packagedRuntimeRoot: root,
        copiedPaths
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return {
    ...collectPackagedRuntimeStatus(paths, environment, dependencies),
    copiedPaths
  };
};
