import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteUpstreamCredentialSecret,
  parseUpstreamCredentialReference,
  readUpstreamCredentialAuthorization,
  storeUpstreamCredentialSecret,
  upstreamCredentialReferenceFor
} from "./upstream-credential-store.js";

const temps: string[] = [];

const tempHome = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-upstream-secret-"));
  temps.push(root);
  return root;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("upstream credential secret store", () => {
  it("stores only an encrypted local secret behind a stable reference", () => {
    const koedHome = tempHome();

    const { reference } = storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "koed_device_1",
      secret: "plain-device-secret"
    });

    expect(reference).toBe(
      upstreamCredentialReferenceFor({
        backendId: "team-vps",
        credentialKeyId: "koed_device_1"
      })
    );
    expect(parseUpstreamCredentialReference(reference)).toEqual({
      backendId: "team-vps",
      credentialKeyId: "koed_device_1"
    });
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBe(
      "Koed-Device koed_device_1:plain-device-secret"
    );

    const storeText = readFileSync(
      resolve(koedHome, "secrets", "upstream-credentials.json"),
      "utf8"
    );
    expect(storeText).not.toContain("plain-device-secret");
    expect(storeText).toContain(reference);
    expect(
      statSync(resolve(koedHome, "secrets", "upstream-credentials.json")).mode &
        0o777
    ).toBe(0o600);
    expect(
      statSync(resolve(koedHome, "config", "local-secret-store.key")).mode &
        0o777
    ).toBe(0o600);
  });

  it("deletes stored secrets without accepting malformed references", () => {
    const koedHome = tempHome();
    const { reference } = storeUpstreamCredentialSecret(koedHome, {
      backendId: "team-vps",
      credentialKeyId: "koed_device_2",
      secret: "device-secret"
    });

    expect(deleteUpstreamCredentialSecret(koedHome, "bearer-secret")).toBe(
      false
    );
    expect(deleteUpstreamCredentialSecret(koedHome, reference)).toBe(true);
    expect(readUpstreamCredentialAuthorization(koedHome, reference)).toBeNull();
    expect(deleteUpstreamCredentialSecret(koedHome, reference)).toBe(false);
  });
});
