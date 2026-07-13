import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync
} from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  extractTranscriptSessionMetadata,
  parseCodexTranscriptJsonlBatch
} from "@koed/mcp-server/codex-transcript-parser";

export type CodexHistoryIssueReason =
  | "root_unreadable"
  | "symlink_rejected"
  | "source_unreadable"
  | "missing_session_id"
  | "missing_source_event_time";

export interface CodexHistoryRoot {
  configuredPath: string;
  canonicalPath: string;
  source: "codex_home" | "configured_override";
}

export interface CodexHistoryIssue {
  sourceLabel: string;
  reason: CodexHistoryIssueReason;
}

export interface CodexHistoryCandidate {
  sourcePath: string;
  sourceRoot: string;
  sourceLabel: string;
  sourceSessionId: string;
  sourceFingerprint: string;
  sourceSizeBytes: number;
  sourceModifiedAt: string;
  sourceEventFrom: string;
  sourceEventTo: string;
  projectCwd: string | null;
}

export interface CodexHistoryDiscoveryResult {
  roots: CodexHistoryRoot[];
  candidates: CodexHistoryCandidate[];
  issues: CodexHistoryIssue[];
}

const isContainedPath = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const validateConfiguredRoot = (value: string): string => {
  if (!path.isAbsolute(value)) {
    throw new Error("Configured Codex history roots must be absolute paths");
  }
  const resolved = path.resolve(value);
  const home = path.resolve(homedir());
  if (
    resolved === path.parse(resolved).root ||
    isContainedPath(resolved, home)
  ) {
    throw new Error("Configured Codex history root is too broad");
  }
  return resolved;
};

const configuredHistoryPaths = (environment: NodeJS.ProcessEnv): string[] => {
  const configured = environment.MEMORY_CODEX_HISTORY_ROOTS?.trim();
  if (!configured) return [];
  return configured
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(validateConfiguredRoot);
};

const codexHome = (environment: NodeJS.ProcessEnv): string => {
  const configured = environment.CODEX_HOME?.trim();
  if (configured) return validateConfiguredRoot(configured);
  return path.resolve(
    environment.HOME ?? environment.USERPROFILE ?? homedir(),
    ".codex"
  );
};

const rootFromPath = (
  configuredPath: string,
  source: CodexHistoryRoot["source"],
  required: boolean
): CodexHistoryRoot | null => {
  try {
    const info = lstatSync(configuredPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("root must be a real directory");
    }
    return {
      configuredPath,
      canonicalPath: realpathSync(configuredPath),
      source
    };
  } catch (error) {
    if (!required) return null;
    throw new Error(
      `Configured Codex history root is invalid: ${configuredPath}`,
      { cause: error }
    );
  }
};

export const resolveSupportedCodexHistoryRoots = (
  environment: NodeJS.ProcessEnv = process.env
): CodexHistoryRoot[] => {
  const defaults = ["sessions", "archived_sessions"].map((name) =>
    path.resolve(codexHome(environment), name)
  );
  const overridePaths = configuredHistoryPaths(environment);
  const roots = [
    ...defaults.map((entry) => rootFromPath(entry, "codex_home", false)),
    ...overridePaths.map((entry) =>
      rootFromPath(entry, "configured_override", true)
    )
  ].filter((entry): entry is CodexHistoryRoot => Boolean(entry));
  return [...new Map(roots.map((root) => [root.canonicalPath, root])).values()];
};

const safeLabel = (filePath: string): string => `…/${path.basename(filePath)}`;

const walkRoot = (
  root: CodexHistoryRoot,
  maxFiles: number,
  issues: CodexHistoryIssue[]
): string[] => {
  const pending = [root.canonicalPath];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: Dirent<string>[];
    try {
      const info = lstatSync(directory);
      const canonicalDirectory = realpathSync(directory);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        !isContainedPath(root.canonicalPath, canonicalDirectory)
      ) {
        issues.push({
          sourceLabel: safeLabel(directory),
          reason: "symlink_rejected"
        });
        continue;
      }
      entries = readdirSync(canonicalDirectory, {
        withFileTypes: true,
        encoding: "utf8"
      });
    } catch {
      issues.push({
        sourceLabel: safeLabel(directory),
        reason: "root_unreadable"
      });
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      let info;
      try {
        info = lstatSync(candidate);
      } catch {
        issues.push({
          sourceLabel: safeLabel(candidate),
          reason: "source_unreadable"
        });
        continue;
      }
      if (info.isSymbolicLink()) {
        issues.push({
          sourceLabel: safeLabel(candidate),
          reason: "symlink_rejected"
        });
      } else if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(candidate);
      if (files.length > maxFiles)
        throw new Error("Codex history discovery file limit exceeded");
    }
  }
  return files.sort();
};

const readBytes = (filePath: string, start: number, length: number): Buffer => {
  const descriptor = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
};

const tailSample = (filePath: string, size: number, sampleBytes: number) => {
  const rawStart = Math.max(0, size - sampleBytes);
  const buffer = readBytes(filePath, rawStart, size - rawStart);
  if (rawStart === 0) return { buffer, start: 0 };
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) return { buffer: Buffer.alloc(0), start: size };
  return {
    buffer: buffer.subarray(newline + 1),
    start: rawStart + newline + 1
  };
};

const parseTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(
    typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const recordTimestamp = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const container of [record, record.payload, record.item]) {
    if (!container || typeof container !== "object" || Array.isArray(container))
      continue;
    const values = container as Record<string, unknown>;
    for (const key of ["timestamp", "time", "created_at", "createdAt"]) {
      const timestamp = parseTimestamp(values[key]);
      if (timestamp) return timestamp;
    }
  }
  return null;
};

const sampledRecords = (
  filePath: string,
  size: number,
  sampleBytes: number
) => {
  const head = readBytes(filePath, 0, Math.min(size, sampleBytes));
  const tail = tailSample(filePath, size, sampleBytes);
  const first = parseCodexTranscriptJsonlBatch({
    buffer: head,
    reachedEnd: size <= sampleBytes
  }).records;
  const last = parseCodexTranscriptJsonlBatch({
    buffer: tail.buffer,
    absoluteStartOffset: tail.start,
    reachedEnd: true
  }).records;
  return [...first, ...last.filter((entry) => entry.byteOffset >= head.length)];
};

const fingerprintFor = (
  sourceSessionId: string,
  firstRecord: unknown
): string =>
  createHash("sha256")
    .update(`codex\0${sourceSessionId}\0${JSON.stringify(firstRecord)}`)
    .digest("hex");

const candidateFromFile = (
  root: CodexHistoryRoot,
  filePath: string,
  sampleBytes: number
): CodexHistoryCandidate | CodexHistoryIssue => {
  try {
    const canonicalPath = realpathSync(filePath);
    if (!isContainedPath(root.canonicalPath, canonicalPath)) {
      return { sourceLabel: safeLabel(filePath), reason: "symlink_rejected" };
    }
    const info = statSync(canonicalPath);
    const records = sampledRecords(canonicalPath, info.size, sampleBytes);
    const values = records.map((entry) => entry.value);
    const context = extractTranscriptSessionMetadata(values);
    if (!context.transcriptSessionId || !values[0]) {
      return { sourceLabel: safeLabel(filePath), reason: "missing_session_id" };
    }
    const eventTimes = values
      .map(recordTimestamp)
      .filter((value): value is string => Boolean(value))
      .sort();
    if (!eventTimes[0]) {
      return {
        sourceLabel: safeLabel(filePath),
        reason: "missing_source_event_time"
      };
    }
    const cwd = context.transcriptMetadata.cwd;
    return {
      sourcePath: canonicalPath,
      sourceRoot: root.canonicalPath,
      sourceLabel: safeLabel(filePath),
      sourceSessionId: context.transcriptSessionId,
      sourceFingerprint: fingerprintFor(context.transcriptSessionId, values[0]),
      sourceSizeBytes: info.size,
      sourceModifiedAt: info.mtime.toISOString(),
      sourceEventFrom: eventTimes[0],
      sourceEventTo: eventTimes.at(-1)!,
      projectCwd: typeof cwd === "string" && cwd.trim() ? cwd : null
    };
  } catch {
    return { sourceLabel: safeLabel(filePath), reason: "source_unreadable" };
  }
};

export const discoverCodexHistory = (input: {
  environment?: NodeJS.ProcessEnv;
  maxFiles: number;
  metadataSampleBytes: number;
}): CodexHistoryDiscoveryResult => {
  const roots = resolveSupportedCodexHistoryRoots(input.environment);
  const issues: CodexHistoryIssue[] = [];
  const candidates: CodexHistoryCandidate[] = [];
  for (const root of roots) {
    for (const filePath of walkRoot(root, input.maxFiles, issues)) {
      const result = candidateFromFile(
        root,
        filePath,
        input.metadataSampleBytes
      );
      if ("reason" in result) issues.push(result);
      else candidates.push(result);
    }
  }
  return { roots, candidates, issues };
};

export const presentCodexHistoryCandidate = (
  candidate: CodexHistoryCandidate
) => ({
  sourceLabel: candidate.sourceLabel,
  sourceSessionId: candidate.sourceSessionId,
  sourceFingerprint: candidate.sourceFingerprint,
  sourceSizeBytes: candidate.sourceSizeBytes,
  sourceModifiedAt: candidate.sourceModifiedAt,
  sourceEventFrom: candidate.sourceEventFrom,
  sourceEventTo: candidate.sourceEventTo
});
