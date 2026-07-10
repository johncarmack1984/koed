import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KoedServerPaths } from "./paths.js";
import {
  discoverProjectMetadata,
  forgetProjectMetadata,
  getProjectMetadataForCwd,
  listProjectMetadata
} from "./project-metadata.js";

const pathsFor = (directory: string): KoedServerPaths =>
  ({
    configDir: path.join(directory, "config"),
    projectMetadataPath: path.join(directory, "config", "projects.json")
  }) as KoedServerPaths;

const execFileFor = (repo: string) =>
  ((
    _file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void
  ) => {
    const command = args.slice(2).join(" ");
    const responses: Record<string, string> = {
      "rev-parse --show-toplevel": repo,
      "remote -v":
        "origin\thttps://token:secret@github.com/koed-labs/koed.git (fetch)\norigin\thttps://token:secret@github.com/koed-labs/koed.git (push)",
      "branch --show-current": "feature/koe-219",
      "rev-parse HEAD": "abcdef1234567890",
      "rev-parse --git-common-dir": ".git"
    };
    const response = responses[command];
    if (response === undefined) {
      callback(new Error(`unexpected git command: ${command}`), "");
      return;
    }
    callback(null, `${response}\n`);
  }) as never;

describe("Project metadata discovery", () => {
  it("discovers and stores privacy-conscious Project metadata", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-project-"));
    const repo = path.join(directory, "repo");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "koed" })
    );
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const paths = pathsFor(directory);

    const discovered = await discoverProjectMetadata(
      paths,
      { cwd: path.join(repo, "packages", "api"), aiClientSource: "codex" },
      {
        execFile: execFileFor(repo),
        randomId: () => "device-salt",
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(discovered).toMatchObject({
      ok: true,
      state: "discovered",
      project: {
        displayName: "koed",
        path: {
          projectRoot: repo,
          basename: "repo"
        },
        git: {
          branch: "feature/koe-219",
          headCommit: "abcdef1234567890"
        },
        packages: [{ manager: "pnpm", name: "koed" }]
      }
    });
    expect(discovered.project?.localProjectId).toMatch(/^lp_/);
    expect(discovered.project?.sourceProjectId).toMatch(/^sp_/);
    expect(discovered.project?.git?.remoteSetFingerprint).toMatch(/^grs_/);
    const raw = fs.readFileSync(paths.projectMetadataPath, "utf8");
    expect(raw).toContain(repo);
    expect(raw).not.toMatch(/token|secret|password|cookie|credential/i);
    expect(listProjectMetadata(paths).projects).toHaveLength(1);
    expect(getProjectMetadataForCwd(paths, repo).project?.displayName).toBe(
      "koed"
    );
    expect(
      forgetProjectMetadata(paths, discovered.project!.localProjectId).ok
    ).toBe(true);
    expect(listProjectMetadata(paths).projects).toHaveLength(0);
  });
});
