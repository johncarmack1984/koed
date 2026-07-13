import { describe, expect, it } from "vitest";
import {
  adaptCodexTranscriptV1,
  codexTranscriptRecordHash,
  type CodexTranscriptObservation
} from "../src/codex-transcript-adapter.js";
import { buildCodexTranscriptConversationItems } from "../src/codex-transcript-parser.js";

const record = {
  timestamp: "2026-07-01T12:00:00.000Z",
  type: "event_msg",
  payload: { type: "user_message", message: "Remember transport parity" }
};

const observation: CodexTranscriptObservation = {
  record,
  sourceLineNumber: 7,
  transcriptByteOffset: 512,
  startsTurn: false,
  completesTurn: false,
  sourceRecordType: "event_msg",
  sourceEventType: "user_message",
  eventTime: "2026-07-01T12:00:00.000Z",
  eventTimeAccuracy: "source",
  fallbackRawText: "Remember transport parity",
  parsedItems: [
    {
      itemDiscriminator: "primary:codex_transcript_user",
      sourceOffset: 0,
      item: {
        actor: "user",
        eventType: "codex_transcript_user",
        content: "Remember transport parity",
        metadata: { transcriptType: "user_message" }
      }
    }
  ]
};

describe("codex-transcript-v1 adapter", () => {
  it("keeps canonical identity transport and path independent", () => {
    const common = {
      observations: [observation],
      sourceSessionId: "session-1",
      threadKind: "conversation" as const
    };
    const hook = adaptCodexTranscriptV1({
      ...common,
      sourceTransport: "hook",
      localSourcePath: "/Users/alice/.codex/session.jsonl"
    })[0]!;
    const imported = adaptCodexTranscriptV1({
      ...common,
      sourceTransport: "historical_import",
      localSourcePath: "/Users/bob/moved/session.jsonl",
      sourceFingerprint: "a".repeat(64)
    })[0]!;

    expect(imported.idempotencyKey).toBe(hook.idempotencyKey);
    expect(imported.sourceHash).toBe(hook.sourceHash);
    expect(imported.sourceHash).toHaveLength(64);
    expect(imported.metadata).toMatchObject({
      transcriptItemDiscriminator: "primary:codex_transcript_user"
    });
    expect(codexTranscriptRecordHash(record)).toHaveLength(64);
    expect(imported.sourcePath).toBeUndefined();
    expect(hook.sourcePath).toBe("/Users/alice/.codex/session.jsonl");
    expect(imported.metadata).toMatchObject({
      transcriptByteOffset: 512,
      transcriptItemDiscriminator: "primary:codex_transcript_user",
      sourceFingerprint: "a".repeat(64)
    });
  });

  it("uses one parser and adapter path for Hook and historical observations", () => {
    const common = {
      records: [record],
      sourceSessionId: "session-parser-parity",
      threadKind: "conversation" as const
    };
    const hook = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "hook",
      localSourcePath: "/Users/alice/.codex/session.jsonl",
      hookEventName: "Stop"
    });
    const imported = buildCodexTranscriptConversationItems({
      ...common,
      sourceTransport: "historical_import",
      localSourcePath: "/Users/alice/.codex/session.jsonl",
      sourceFingerprint: "b".repeat(64)
    });

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      idempotencyKey: hook[0]?.idempotencyKey,
      sourceHash: hook[0]?.sourceHash,
      rawText: hook[0]?.rawText,
      sourcePath: undefined,
      metadata: {
        transcriptItemDiscriminator: "primary:codex_transcript_user",
        sourceFingerprint: "b".repeat(64)
      }
    });
  });

  it("uses item discriminator to keep multiple logical rows at one transcript position distinct", () => {
    const items = adaptCodexTranscriptV1({
      observations: [
        {
          ...observation,
          parsedItems: [
            observation.parsedItems[0]!,
            {
              itemDiscriminator: "supporting_context",
              sourceOffset: 1,
              item: {
                actor: "system",
                eventType: "codex_transcript_ide_context",
                content: "IDE context",
                metadata: { transcriptType: "ide_context" }
              }
            }
          ]
        }
      ],
      sourceSessionId: "session-1",
      sourceTransport: "historical_import",
      threadKind: "conversation"
    });

    expect(items).toHaveLength(2);
    expect(items[0]?.idempotencyKey).not.toBe(items[1]?.idempotencyKey);
    expect(items.map((item) => item.sourceSequence)).toEqual([1024, 1025]);
  });
});
