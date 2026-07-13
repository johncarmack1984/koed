import { z } from "zod";
import { metadataSchema } from "./common-schemas.js";

export const historicalImportStateSchema = z.enum([
  "discovered",
  "eligible",
  "queued",
  "importing",
  "paused",
  "skipped",
  "completed",
  "failed"
]);

const boundedCounter = z.number().int().nonnegative().max(2_000_000_000);
const boundedBytes = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

const boundedText = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !hasControlCharacter(value), {
    message: "Control characters are not allowed"
  });
const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacter(value), {
    message: "Control characters are not allowed"
  });

export const historicalImportRunListSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional()
});

export const historicalImportRunParamsSchema = z.object({
  runId: z.string().uuid()
});

export const historicalImportSourceParamsSchema = z.object({
  sourceId: z.string().uuid()
});

const detectedProjectSchema = z
  .object({
    projectId: boundedText.optional(),
    name: boundedText.regex(/^[^/\\]+$/).optional(),
    path: localPath.optional(),
    cwd: localPath.optional(),
    repositoryUrl: z.string().url().max(4096).optional(),
    branch: boundedText.optional(),
    ref: boundedText.optional(),
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
  })
  .strict();

export const createHistoricalImportSourceSchema = z
  .object({
    runId: z.string().uuid(),
    aiClient: z.literal("codex"),
    sourceKind: z.literal("codex"),
    sourceSessionId: boundedText,
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    localSourcePath: localPath,
    sourceSizeBytes: boundedBytes.optional(),
    sourceModifiedAt: z.string().datetime({ offset: true }).optional(),
    sourceEventFrom: z.string().datetime({ offset: true }).optional(),
    sourceEventTo: z.string().datetime({ offset: true }).optional(),
    discoveredRecordCount: boundedCounter.optional(),
    detectedProject: detectedProjectSchema.optional()
  })
  .superRefine((value, context) => {
    if (
      value.sourceEventFrom &&
      value.sourceEventTo &&
      Date.parse(value.sourceEventFrom) > Date.parse(value.sourceEventTo)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceEventTo"],
        message: "Source event range is invalid"
      });
    }
  });

export const historicalImportTransitionSchema = z
  .object({
    expectedState: historicalImportStateSchema,
    state: historicalImportStateSchema,
    failureReason: z
      .string()
      .regex(/^[a-z0-9_.:-]{1,128}$/)
      .nullable()
      .optional(),
    nextRetryAt: z.string().datetime({ offset: true }).nullable().optional()
  })
  .superRefine((value, context) => {
    if (value.state === "failed" && !value.failureReason) {
      context.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "Failed state requires failureReason"
      });
    }
  });

const historicalConversationItemSchema = z.object({
  sessionId: z.string().uuid().optional(),
  turnId: z.string().uuid().optional(),
  externalThreadId: boundedText.optional(),
  externalTurnId: boundedText.optional(),
  externalItemId: boundedText.optional(),
  parentExternalItemId: boundedText.optional(),
  sourceRecordType: boundedText,
  sourceEventType: boundedText.optional(),
  sourceLineNumber: boundedCounter.optional(),
  sourceSequence: boundedCounter.optional(),
  eventTime: z.string().datetime({ offset: true }).optional(),
  rawJson: z.unknown(),
  rawText: z.string().max(4_000_000).optional(),
  logicalSourceId: boundedText.optional(),
  transportChunkIndex: boundedCounter.optional(),
  transportChunkCount: z.number().int().positive().max(100_000).optional(),
  transportChunkText: z.string().max(4_000_000).optional(),
  transportChunkEncoding: boundedText.optional(),
  sourceHash: boundedText,
  idempotencyKey: boundedText,
  projectionStatus: z.literal("pending").optional(),
  projectionVersion: z.literal("codex-transcript-v1").optional(),
  metadata: metadataSchema
});

export const historicalImportBatchSchema = z
  .object({
    expectedCheckpointOffset: boundedBytes,
    checkpointOffset: boundedBytes,
    checkpointLine: boundedCounter,
    sourceSizeBytes: boundedBytes,
    skippedRecordCount: boundedCounter.optional(),
    malformedRecordCount: boundedCounter.optional(),
    sourceEventFrom: z.string().datetime({ offset: true }).optional(),
    sourceEventTo: z.string().datetime({ offset: true }).optional(),
    items: z.array(historicalConversationItemSchema).min(1).max(1000)
  })
  .superRefine((value, context) => {
    if (
      value.checkpointOffset < value.expectedCheckpointOffset ||
      value.checkpointOffset > value.sourceSizeBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["checkpointOffset"],
        message: "Checkpoint must advance within current source size"
      });
    }
  });
