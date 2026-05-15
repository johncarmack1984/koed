export type HealthStatus = "ok" | "degraded" | "error";

export interface ServiceHealth {
  service: string;
  status: HealthStatus;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export const createHealth = (
  service: string,
  status: HealthStatus = "ok",
  details?: Record<string, unknown>
): ServiceHealth => ({
  service,
  status,
  checkedAt: new Date().toISOString(),
  ...(details ? { details } : {})
});

export const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export type MemoryMode = "codex_subscription" | "server_synthesis";

export const unsafeServerSynthesisFlag = "MEMORY_SERVER_SYNTHESIS_UNSAFE_ALLOW";

const truthyConfigValues = new Set(["1", "true", "yes", "on"]);

export const configFlagEnabled = (value: string | undefined): boolean =>
  value ? truthyConfigValues.has(value.trim().toLowerCase()) : false;

export const resolveMemoryMode = (
  environment: NodeJS.ProcessEnv = process.env
): MemoryMode => {
  if (environment.MEMORY_MODE !== "server_synthesis") {
    return "codex_subscription";
  }

  if (configFlagEnabled(environment[unsafeServerSynthesisFlag])) {
    return "server_synthesis";
  }

  throw new Error(
    [
      "MEMORY_MODE=server_synthesis is disabled by default because it can make",
      "backend-paid LLM calls. Use MEMORY_MODE=codex_subscription, or set",
      `${unsafeServerSynthesisFlag}=1 only for an explicitly approved dev/test deployment.`
    ].join(" ")
  );
};
