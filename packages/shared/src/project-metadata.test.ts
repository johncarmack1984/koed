import { describe, expect, it } from "vitest";
import {
  deriveLocalProjectId,
  deriveSourceProjectId,
  normalizeGitRemoteUrl,
  remoteSetFingerprintFor,
  safeProjectMetadataForRemote,
  type ProjectMetadataV1
} from "./project-metadata.js";

describe("Project metadata helpers", () => {
  it("normalizes HTTPS Git remotes without credentials, query, or fragment", () => {
    const remote = normalizeGitRemoteUrl(
      "https://token:secret@github.com/koed-labs/koed.git?x=1#main",
      "origin"
    );

    expect(remote).toMatchObject({
      name: "origin",
      host: "github.com",
      owner: "koed-labs",
      repo: "koed",
      display: "github.com/koed-labs/koed"
    });
    expect(remote.fingerprint).toMatch(/^gr_/);
    expect(JSON.stringify(remote)).not.toMatch(/token|secret|x=1|#main/);
  });

  it("normalizes SSH scp-style Git remotes", () => {
    expect(
      normalizeGitRemoteUrl("git@github.com:koed-labs/koed.git")
    ).toMatchObject({
      host: "github.com",
      owner: "koed-labs",
      repo: "koed",
      display: "github.com/koed-labs/koed"
    });
  });

  it("derives stable source ids from remote fingerprints and package names", () => {
    const remotesA = [
      normalizeGitRemoteUrl("git@github.com:koed-labs/koed.git")
    ];
    const remotesB = [
      normalizeGitRemoteUrl("https://github.com/koed-labs/koed")
    ];
    const packageMetadata = [
      { manager: "pnpm" as const, name: "koed", relativePath: "package.json" }
    ];

    expect(remoteSetFingerprintFor(remotesA)).toBe(
      remoteSetFingerprintFor(remotesB)
    );
    expect(
      deriveSourceProjectId({
        remoteSetFingerprint: remoteSetFingerprintFor(remotesA),
        packages: packageMetadata
      })
    ).toBe(
      deriveSourceProjectId({
        remoteSetFingerprint: remoteSetFingerprintFor(remotesB),
        packages: packageMetadata
      })
    );
    expect(deriveSourceProjectId({ remoteSetFingerprint: null })).toBeNull();
  });

  it("keeps local Project ids salted and path-specific", () => {
    expect(
      deriveLocalProjectId({
        salt: "device-a",
        projectRoot: "/repo/koed",
        cwd: "/repo/koed"
      })
    ).toBe(
      deriveLocalProjectId({
        salt: "device-a",
        projectRoot: "/repo/koed",
        cwd: "/repo/koed/packages/api"
      })
    );
    expect(
      deriveLocalProjectId({
        salt: "device-a",
        projectRoot: "/repo/koed",
        cwd: "/repo/koed"
      })
    ).not.toBe(
      deriveLocalProjectId({
        salt: "device-b",
        projectRoot: "/repo/koed",
        cwd: "/repo/koed"
      })
    );
  });

  it("returns remote-safe metadata without raw local paths", () => {
    const metadata: ProjectMetadataV1 = {
      schemaVersion: 1,
      discoveredAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      localProjectId: "lp_local",
      sourceProjectId: "sp_source",
      displayName: "koed",
      path: {
        cwd: "/Users/jedd/agents/koed",
        projectRoot: "/Users/jedd/agents/koed",
        basename: "koed",
        localPathHash: "hmac_sha256:abc"
      },
      packages: []
    };

    expect(
      JSON.stringify(safeProjectMetadataForRemote(metadata))
    ).not.toContain("/Users/jedd/agents/koed");
  });
});
