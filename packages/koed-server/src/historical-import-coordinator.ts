import type { KoedServerStatus } from "./types.js";
import type { CodexHistoryCandidate } from "./codex-history-discovery.js";

export interface HistoricalProjectMetadata {
  name: string;
  fingerprint?: string;
}

export interface RankedHistoricalSource extends CodexHistoryCandidate {
  detectedProject: HistoricalProjectMetadata;
  projectActivityAt: string;
}

const usableProject = (
  project: HistoricalProjectMetadata | null | undefined
): HistoricalProjectMetadata =>
  project?.name.trim()
    ? {
        name: project.name.trim(),
        ...(project.fingerprint ? { fingerprint: project.fingerprint } : {})
      }
    : { name: "Unassigned" };

export const rankAutomaticHistoricalSources = (input: {
  candidates: CodexHistoryCandidate[];
  projectFor: (
    candidate: CodexHistoryCandidate
  ) => HistoricalProjectMetadata | null;
  now: Date;
  windowDays: number;
  sessionCap: number;
}): RankedHistoricalSource[] => {
  if (input.windowDays !== 30) {
    throw new Error(
      "Automatic historical import window must be exactly 30 days"
    );
  }
  if (
    !Number.isInteger(input.sessionCap) ||
    input.sessionCap < 1 ||
    input.sessionCap > 50
  ) {
    throw new Error(
      "Automatic historical import session cap must be from 1 to 50"
    );
  }
  const cutoff = input.now.getTime() - input.windowDays * 86_400_000;
  const eligible = input.candidates
    .filter((candidate) => Date.parse(candidate.sourceEventTo) >= cutoff)
    .map((candidate) => ({
      ...candidate,
      detectedProject: usableProject(input.projectFor(candidate))
    }));
  const activityByProject = new Map<string, string>();
  for (const source of eligible) {
    const key =
      source.detectedProject.fingerprint ?? source.detectedProject.name;
    const current = activityByProject.get(key);
    if (!current || source.sourceEventTo > current)
      activityByProject.set(key, source.sourceEventTo);
  }
  return eligible
    .map((source) => ({
      ...source,
      projectActivityAt: activityByProject.get(
        source.detectedProject.fingerprint ?? source.detectedProject.name
      )!
    }))
    .sort(
      (left, right) =>
        right.projectActivityAt.localeCompare(left.projectActivityAt) ||
        right.sourceEventTo.localeCompare(left.sourceEventTo) ||
        left.sourceFingerprint.localeCompare(right.sourceFingerprint)
    )
    .slice(0, input.sessionCap);
};

const healthyComponent = (component: { state: string } | undefined): boolean =>
  component?.state === "healthy";

export const historicalImportStartReadiness = (
  status: KoedServerStatus
): { ready: true } | { ready: false; reason: string } => {
  const required: Array<[string, { state: string } | undefined]> = [
    ["api", status.api],
    ["database", status.database],
    ["worker_queues", status.workerQueues],
    ["embedding_service", status.embeddingService],
    ["api_token", status.apiToken],
    ["mcp_server", status.mcpServer],
    ["capture_hook", status.captureHook],
    ["codex", status.codex],
    ["explorer", status.explorer]
  ];
  const blocked = required.find(
    ([, component]) => !healthyComponent(component)
  );
  return blocked
    ? { ready: false, reason: `${blocked[0]}_not_ready` }
    : { ready: true };
};

export interface HistoricalBatchGateInput {
  runtimeReady: boolean;
  codexSetupReady: boolean;
  captureState: "enabled" | "disabled" | "ask";
  visibility: "personal" | "team";
  paused: boolean;
  skipped: boolean;
  sourceState:
    | "ready"
    | "growing"
    | "moved"
    | "deleted"
    | "truncated"
    | "mutated"
    | "unreadable"
    | "malformed";
  backpressure?: { admitted: boolean; reason?: string };
}

export const historicalBatchGate = (
  input: HistoricalBatchGateInput
): { admitted: true } | { admitted: false; reason: string } => {
  if (!input.runtimeReady)
    return { admitted: false, reason: "runtime_not_ready" };
  if (!input.codexSetupReady)
    return { admitted: false, reason: "codex_setup_not_ready" };
  if (input.skipped) return { admitted: false, reason: "user_skipped" };
  if (input.paused) return { admitted: false, reason: "capture_paused" };
  if (input.visibility !== "personal")
    return { admitted: false, reason: "non_personal_visibility" };
  if (input.captureState !== "enabled")
    return { admitted: false, reason: `capture_${input.captureState}` };
  if (!["ready", "growing", "moved"].includes(input.sourceState)) {
    return { admitted: false, reason: `source_${input.sourceState}` };
  }
  if (!input.backpressure)
    return { admitted: false, reason: "backpressure_unavailable" };
  return input.backpressure.admitted
    ? { admitted: true }
    : {
        admitted: false,
        reason: input.backpressure.reason ?? "backpressure_blocked"
      };
};
