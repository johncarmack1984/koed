import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const drizzleDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle"
);

const readDrizzleFile = (path: string) =>
  readFile(resolve(drizzleDir, path), "utf8");

describe("historical priority migration chain", () => {
  it("keeps the Project migration before priority migrations", async () => {
    const [journalText, initialPrioritySql, upgradeSql] = await Promise.all([
      readDrizzleFile("meta/_journal.json"),
      readDrizzleFile("0010_dry_maria_hill.sql"),
      readDrizzleFile("0011_unknown_justice.sql")
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.slice(9, 12)).toEqual([
      expect.objectContaining({ idx: 9, tag: "0009_same_toxin" }),
      expect.objectContaining({ idx: 10, tag: "0010_dry_maria_hill" }),
      expect.objectContaining({ idx: 11, tag: "0011_unknown_justice" })
    ]);
    expect(initialPrioritySql).toContain(
      'ADD COLUMN "priority" integer DEFAULT 0 NOT NULL'
    );
    expect(upgradeSql).toContain('ALTER COLUMN "priority" SET DEFAULT 10');
    expect(upgradeSql).toContain(
      `SET "priority" = 10 WHERE "priority" = 0 AND "status" IN ('pending', 'active')`
    );
  });

  it("adds durable historical import state and distinct provenance timestamps", async () => {
    const [journalText, migrationSql] = await Promise.all([
      readDrizzleFile("meta/_journal.json"),
      readDrizzleFile("0012_dazzling_chimera.sql")
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries.slice(12, 15)).toEqual([
      expect.objectContaining({ idx: 12, tag: "0012_dazzling_chimera" }),
      expect.objectContaining({ idx: 13, tag: "0013_lazy_leader" }),
      expect.objectContaining({ idx: 14, tag: "0014_exotic_warbound" })
    ]);
    expect(migrationSql).toContain('CREATE TABLE "historical_import_runs"');
    expect(migrationSql).toContain('CREATE TABLE "historical_import_sources"');
    expect(migrationSql).toContain('"local_source_path" text NOT NULL');
    expect(migrationSql).toContain('"source_fingerprint" text NOT NULL');
    expect(migrationSql).toContain(
      'ADD COLUMN "import_observed_at" timestamp with time zone'
    );
    expect(migrationSql).toContain("historical_import_sources_identity_unique");
  });

  it("owner-scopes Captured Session identities without rewriting rows", async () => {
    const migrationSql = await readDrizzleFile("0014_exotic_warbound.sql");

    expect(migrationSql).toContain(
      'DROP INDEX "sessions_idempotency_key_unique"'
    );
    expect(migrationSql).toContain('"owner_user_id","idempotency_key"');
    expect(migrationSql).toContain('"owner_user_id","source_hash"');
    expect(migrationSql.toLowerCase()).not.toContain("update sessions");
  });

  it("adds owner-consistent source state before its composite foreign key", async () => {
    const migrationSql = await readDrizzleFile("0013_lazy_leader.sql");
    const uniqueConstraint = migrationSql.indexOf(
      "historical_import_runs_id_owner_unique"
    );
    const foreignKey = migrationSql.indexOf(
      "historical_import_sources_run_owner_fk"
    );

    expect(uniqueConstraint).toBeGreaterThan(-1);
    expect(foreignKey).toBeGreaterThan(uniqueConstraint);
    expect(migrationSql).toContain('ADD COLUMN "checkpoint_hash" text');
  });
});
