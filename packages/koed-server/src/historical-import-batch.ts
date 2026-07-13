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
  | { state: "growing"; reason: "source_incomplete_tail" }
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

const parsedLines = (input: {
  parsed: ReturnType<typeof parseCodexTranscriptJsonlBatch>;
  buffer: Buffer;
  absoluteStartOffset: number;
  lineIndexOffset: number;
}): ParsedLine[] => {
  const recordsByLine = new Map<number, CodexTranscriptJsonlRecord[]>();
  for (const record of input.parsed.records) {
    const records = recordsByLine.get(record.lineIndex) ?? [];
    records.push(record);
    recordsByLine.set(record.lineIndex, records);
  }
  const malformedLines = new Set(
    input.parsed.malformedLines.map((line) => line.lineIndex)
  );
  const lines: ParsedLine[] = [];
  let cursor = 0;
  let lineIndex = input.lineIndexOffset;
  while (cursor < input.parsed.consumedBytes) {
    const newline = input.buffer.indexOf(0x0a, cursor);
    const end =
      newline >= 0 && newline < input.parsed.consumedBytes
        ? newline + 1
        : input.parsed.consumedBytes;
    const endOffset = input.absoluteStartOffset + end;
    lines.push(
      malformedLines.has(lineIndex)
        ? { kind: "malformed", endOffset, lineIndex }
        : {
            kind: "records",
            records: recordsByLine.get(lineIndex) ?? [],
            endOffset,
            lineIndex
          }
    );
    cursor = end;
    lineIndex += 1;
  }
  return lines;
};

const itemsForLines = (
  source: CodexHistoryCandidate,
  lines: ParsedLine[]
): Array<Record<string, unknown>> => {
  const values = lines.flatMap((line) =>
    line.kind === "records" ? line.records.map((record) => record.value) : []
  );
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
  const selectedLines: ParsedLine[] = [];
  let items: Array<Record<string, unknown>> = [];
  let checkpointOffset = input.checkpoint.offset;
  let checkpointLine = input.checkpoint.line;
  let malformedRecordCount = 0;
  for (const line of input.lines) {
    selectedLines.push(line);
    const nextItems =
      line.kind === "records" && line.records.length > 0
        ? itemsForLines(input.source, selectedLines)
        : items;
    const nextItemBytes = Buffer.byteLength(JSON.stringify(nextItems), "utf8");
    if (
      selectedLines.length > 1 &&
      (nextItems.length > input.config.maxBatchRows ||
        nextItemBytes > input.config.maxBatchBytes)
    ) {
      selectedLines.pop();
      break;
    }
    if (nextItems.length > input.config.maxBatchRows) {
      return { error: "source_line_exceeds_row_limit" as const };
    }
    if (nextItemBytes > input.config.maxBatchBytes) {
      return { error: "source_line_exceeds_byte_limit" as const };
    }
    items = nextItems;
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
  const reachedSourceEnd =
    input.checkpoint.offset + buffer.length === input.size;
  const parsed = parseCodexTranscriptJsonlBatch({
    buffer,
    absoluteStartOffset: input.checkpoint.offset,
    lineIndexOffset: input.checkpoint.line,
    reachedEnd: reachedSourceEnd
  });
  return {
    ...selectLines({
      ...input,
      lines: parsedLines({
        parsed,
        buffer,
        absoluteStartOffset: input.checkpoint.offset,
        lineIndexOffset: input.checkpoint.line
      }),
      nowMs: input.nowMs ?? Date.now
    }),
    incompleteAtSourceEnd: parsed.incompleteTail && reachedSourceEnd
  };
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
  if ("error" in selected) {
    return {
      state: "malformed",
      reason: selected.error ?? "source_line_exceeds_row_limit"
    };
  }
  if (selected.checkpointOffset === input.checkpoint.offset) {
    return selected.incompleteAtSourceEnd
      ? { state: "growing", reason: "source_incomplete_tail" }
      : { state: "malformed", reason: "source_line_exceeds_byte_limit" };
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
  return {
    state:
      validated.growing || selected.incompleteAtSourceEnd ? "growing" : "ready",
    batch
  };
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
