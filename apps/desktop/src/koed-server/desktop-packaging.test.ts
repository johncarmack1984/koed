import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".."
);
const desktopRoot = resolve(repoRoot, "apps/desktop");

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

describe("Koed Desktop packaging", () => {
  it("declares workspace packages required at packaged runtime", () => {
    const pkg = readJson<{ dependencies?: Record<string, string> }>(
      resolve(desktopRoot, "package.json")
    );
    const deps = pkg.dependencies ?? {};

    for (const required of [
      "@koed/api",
      "@koed/core",
      "@koed/db",
      "@koed/koed-server",
      "@koed/mcp-server",
      "@koed/shared",
      "@koed/worker"
    ]) {
      expect(deps[required], `${required} must ship with Desktop`).toBe(
        "workspace:*"
      );
    }
  });

  it("stages resources required by bundled koed-server", () => {
    const script = readFileSync(
      resolve(repoRoot, "scripts/package-desktop-resources.mjs"),
      "utf8"
    );

    for (const required of [
      "koed-app-root",
      "koed-server",
      "mcp-server",
      "api",
      "worker",
      "explorer",
      "apps/embedding-service",
      "docker-compose.yml",
      ".env.example"
    ]) {
      expect(script).toContain(required);
    }
  });

  it("keeps node runner and server files unpacked for packaged execution", () => {
    const script = readFileSync(
      resolve(repoRoot, "scripts/package-desktop-resources.mjs"),
      "utf8"
    );

    for (const unpacked of [
      "dist-electron/koed-server/**",
      "koed-app-root/packages/koed-server/dist/**",
      "koed-app-root/packages/mcp-server/dist/**",
      "koed-app-root/apps/api/dist/**",
      "koed-app-root/apps/worker/dist/**",
      "koed-app-root/apps/explorer/dist/**",
      "koed-app-root/apps/embedding-service/**",
      "koed-app-root/scripts/**"
    ]) {
      expect(script).toContain(unpacked);
    }
  });
});
