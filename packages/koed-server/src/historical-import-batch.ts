import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from "node:fs";
import path from "node:path";
import {
  buildCodexTranscriptConversationItems,
  extractTranscriptSessionMetadata,
  parseCodexTranscriptJsonlBatch,
  type CodexTranscriptJsonlRecord
} from "@koed/mcp-server/codex-transcript-parser";
import type { CodexHistoryCandidate } from "./codex-history-discovery.js";
import type { HistoricalImportCoordinatorConfig } from "./historical-import-config.js";

export type HistoricalSourceReadState =
  | "ready"
  | "completed"
  | "growing"
  | "moved"
  | "deleted"
  | "truncated"
  | "mutated"
  | "unreadable"
  | "malformed";

export interface HistoricalSourceCheckpoint {
  offset: number;
  line: number;
  hash: string | null;
  observedSizeBytes: number;
}

export interface HistoricalImportSourceBatch {
  expectedCheckpointOffset: number;
  expectedCheckpointHash: string | null;
  checkpointOffset: number;
  checkpointLine: number;
  checkpointHash: string;
  sourceSizeBytes: number;
  malformedRecordCount: number;
  sourceEventFrom?: string;
  sourceEventTo?: string;
  items: Array<Record<string, unknown>>;
}

export type HistoricalSourceBatchResult =
  | {
      state: Exclude<
        HistoricalSourceReadState,
        "ready" | "completed" | "growing"
      >;
      reason: string;
    }
  | { state: "completed" }
  | { state: "ready" | "growing"; batch: HistoricalImportSourceBatch };

const containedBy = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const hashPrefix = (filePath: string, byteCount: number): string => {
  const digest = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.alloc(Math.min(65_536, Math.max(1, byteCount)));
  let offset = 0;
  try {
    while (offset < byteCount) {
      const length = Math.min(buffer.length, byteCount - offset);
      const bytesRead = readSync(descriptor, buffer, 0, length, offset);
      if (bytesRead === 0)
        throw new Error("Source ended while hashing checkpoint");
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
};

const readWindow = (
  filePath: string,
  offset: number,
  byteCount: number
): Buffer => {
  const descriptor = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(byteCount);
    const bytesRead = readSync(descriptor, buffer, 0, byteCount, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
};

const validateSource = (
  source: CodexHistoryCandidate,
  checkpoint: HistoricalSourceCheckpoint
):
  | { path: string; size: number; growing: boolean }
  | { state: HistoricalSourceReadState; reason: string } => {
  try {
    const info = lstatSync(source.sourcePath);
    if (info.isSymbolicLink())
      return { state: "unreadable", reason: "source_symlink_rejected" };
    const canonicalPath = realpathSync(source.sourcePath);
    if (!containedBy(source.sourceRoot, canonicalPath)) {
      return { state: "unreadable", reason: "source_root_escape" };
    }
    const size = statSync(canonicalPath).size;
    if (size < checkpoint.observedSizeBytes || size < checkpoint.offset) {
      return { state: "truncated", reason: "source_truncated" };
    }
    if (
      checkpoint.offset > 0 &&
      hashPrefix(canonicalPath, checkpoint.offset) !== checkpoint.hash
    ) {
      return { state: "mutated", reason: "checkpoint_prefix_mutated" };
    }
    return {
      path: canonicalPath,
      size,
      growing: size > checkpoint.observedSizeBytes
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { state: "deleted", reason: "source_deleted" }
      : { state: "unreadable", reason: "source_unreadable" };
  }
};

type ParsedLine =
  | {
      kind: "records";
      records: CodexTranscriptJsonlRecord[];
      endOffset: number;
      lineIndex: number;
    }
  | { kind: "malformed"; endOffset: number; lineIndex: number };

const parsedLines = (
  parsed: ReturnType<typeof parseCodexTranscriptJsonlBatch>
): ParsedLine[] => {
  const recordsByLine = new Map<number, CodexTranscriptJsonlRecord[]>();
  for (const record of parsed.records) {
    const records = recordsByLine.get(record.lineIndex) ?? [];
    records.push(record);
    recordsByLine.set(record.lineIndex, records);
  }
  return [
    ...[...recordsByLine.entries()].map(([lineIndex, records]) => ({
      kind: "records" as const,
      records,
      lineIndex,
      endOffset: records[0]!.endOffset
    })),
    ...parsed.malformedLines.map((line) => ({
      kind: "malformed" as const,
      endOffset: line.endOffset,
      lineIndex: line.lineIndex
    }))
  ].sort((left, right) => left.lineIndex - right.lineIndex);
};

const itemsForLine = (
  source: CodexHistoryCandidate,
  line: Extract<ParsedLine, { kind: "records" }>
): Array<Record<string, unknown>> => {
  const values = line.records.map((record) => record.value);
  const context = extractTranscriptSessionMetadata(values);
  return buildCodexTranscriptConversationItems({
    records: values,
    sourceSessionId: source.sourceSessionId,
    sourceTransport: "historical_import",
    sourceFingerprint: source.sourceFingerprint,
    threadKind: context.threadKind,
    parentThreadId: context.parentThreadId
  });
};

const selectLines = (input: {
  source: CodexHistoryCandidate;
  lines: ParsedLine[];
  checkpoint: HistoricalSourceCheckpoint;
  config: HistoricalImportCoordinatorConfig;
  nowMs: () => number;
}) => {
  const startedAt = input.nowMs();
  const items: Array<Record<string, unknown>> = [];
  let checkpointOffset = input.checkpoint.offset;
  let checkpointLine = input.checkpoint.line;
  let malformedRecordCount = 0;
  for (const line of input.lines) {
    const lineItems =
      line.kind === "records" ? itemsForLine(input.source, line) : [];
    if (
      items.length > 0 &&
      items.length + lineItems.length > input.config.maxBatchRows
    )
      break;
    if (lineItems.length > input.config.maxBatchRows) {
      return { error: "source_line_exceeds_row_limit" as const };
    }
    items.push(...lineItems);
    if (line.kind === "malformed") malformedRecordCount += 1;
    checkpointOffset = line.endOffset;
    checkpointLine = line.lineIndex + 1;
    if (input.nowMs() - startedAt >= input.config.maxBatchRuntimeMs) break;
  }
  return { items, checkpointOffset, checkpointLine, malformedRecordCount };
};

const itemEventTimes = (items: Array<Record<string, unknown>>): string[] =>
  items
    .map((item) => item.eventTime)
    .filter((value): value is string => typeof value === "string")
    .sort();

const selectSourceWindow = (input: {
  source: CodexHistoryCandidate;
  checkpoint: HistoricalSourceCheckpoint;
  config: HistoricalImportCoordinatorConfig;
  nowMs?: () => number;
  path: string;
  size: number;
}) => {
  const byteCount = Math.min(
    input.config.maxBatchBytes,
    input.size - input.checkpoint.offset
  );
  const buffer = readWindow(input.path, input.checkpoint.offset, byteCount);
  const parsed = parseCodexTranscriptJsonlBatch({
    buffer,
    absoluteStartOffset: input.checkpoint.offset,
    lineIndexOffset: input.checkpoint.line,
    reachedEnd: input.checkpoint.offset + buffer.length === input.size
  });
  return selectLines({
    ...input,
    lines: parsedLines(parsed),
    nowMs: input.nowMs ?? Date.now
  });
};

const sourceBatch = (input: {
  checkpoint: HistoricalSourceCheckpoint;
  path: string;
  size: number;
  selected: Exclude<ReturnType<typeof selectSourceWindow>, { error: string }>;
}): HistoricalImportSourceBatch => {
  const eventTimes = itemEventTimes(input.selected.items);
  return {
    expectedCheckpointOffset: input.checkpoint.offset,
    expectedCheckpointHash: input.checkpoint.hash,
    checkpointOffset: input.selected.checkpointOffset,
    checkpointLine: input.selected.checkpointLine,
    checkpointHash: hashPrefix(input.path, input.selected.checkpointOffset),
    sourceSizeBytes: input.size,
    malformedRecordCount: input.selected.malformedRecordCount,
    ...(eventTimes[0]
      ? { sourceEventFrom: eventTimes[0], sourceEventTo: eventTimes.at(-1)! }
      : {}),
    items: input.selected.items
  };
};

export const readHistoricalSourceBatch = (input: {
  source: CodexHistoryCandidate;
  checkpoint: HistoricalSourceCheckpoint;
  config: HistoricalImportCoordinatorConfig;
  nowMs?: () => number;
}): HistoricalSourceBatchResult => {
  const validated = validateSource(input.source, input.checkpoint);
  if ("state" in validated) return validated as HistoricalSourceBatchResult;
  if (input.checkpoint.offset === validated.size) {
    return { state: "completed" };
  }
  const selected = selectSourceWindow({ ...input, ...validated });
  if (
    "error" in selected ||
    selected.checkpointOffset === input.checkpoint.offset
  ) {
    return {
      state: "malformed",
      reason: selected.error ?? "source_line_exceeds_byte_limit"
    };
  }
  const batch = sourceBatch({
    checkpoint: input.checkpoint,
    path: validated.path,
    size: validated.size,
    selected
  });
  if (selected.checkpointOffset === validated.size) {
    return { state: "ready", batch };
  }
  return { state: validated.growing ? "growing" : "ready", batch };
};

export const reconcileHistoricalSource = (
  previous: CodexHistoryCandidate,
  current: CodexHistoryCandidate[]
): { state: "ready" | "moved" | "deleted"; source?: CodexHistoryCandidate } => {
  const same = current.find(
    (candidate) => candidate.sourceFingerprint === previous.sourceFingerprint
  );
  if (!same) return { state: "deleted" };
  return same.sourcePath === previous.sourcePath
    ? { state: "ready", source: same }
    : { state: "moved", source: same };
};
