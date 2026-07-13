const integerSetting = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
};

export interface HistoricalImportCoordinatorConfig {
  windowDays: number;
  firstRunSessionCap: number;
  maxBatchRows: number;
  maxBatchBytes: number;
  maxBatchRuntimeMs: number;
  maxDiscoveryFiles: number;
  metadataSampleBytes: number;
}

const automaticBounds = (environment: NodeJS.ProcessEnv) => ({
  windowDays: integerSetting(
    environment,
    "MEMORY_HISTORICAL_IMPORT_WINDOW_DAYS",
    30,
    30,
    30
  ),
  firstRunSessionCap: integerSetting(
    environment,
    "MEMORY_HISTORICAL_IMPORT_FIRST_RUN_SESSIONS",
    50,
    1,
    50
  ),
  maxDiscoveryFiles: integerSetting(
    environment,
    "MEMORY_HISTORICAL_IMPORT_DISCOVERY_FILE_LIMIT",
    10_000,
    1,
    100_000
  ),
  metadataSampleBytes: integerSetting(
    environment,
    "MEMORY_HISTORICAL_IMPORT_METADATA_SAMPLE_BYTES",
    65_536,
    4_096,
    1_048_576
  )
});

const sourceBatchBounds = (environment: NodeJS.ProcessEnv) => ({
  maxBatchRows: integerSetting(
    environment,
    "MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_ROWS",
    100,
    1,
    500
  ),
  maxBatchBytes: integerSetting(
    environment,
    "MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_BYTES",
    1_000_000,
    1_024,
    4_000_000
  ),
  maxBatchRuntimeMs: integerSetting(
    environment,
    "MEMORY_HISTORICAL_IMPORT_SOURCE_BATCH_RUNTIME_MS",
    15_000,
    100,
    60_000
  )
});

export const resolveHistoricalImportCoordinatorConfig = (
  environment: NodeJS.ProcessEnv = process.env
): HistoricalImportCoordinatorConfig => ({
  ...automaticBounds(environment),
  ...sourceBatchBounds(environment)
});
