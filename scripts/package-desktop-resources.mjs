#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = resolve(rootDir, "apps/desktop");
const outputDir = resolve(desktopDir, "dist-resources");
const koedAppRoot = resolve(outputDir, "koed-app-root");

const copyRequired = (from, to) => {
  if (!existsSync(from)) {
    throw new Error(`Required packaged Desktop input is missing: ${from}`);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
};

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(koedAppRoot, { recursive: true });

copyRequired(resolve(desktopDir, "dist"), resolve(outputDir, "app-dist"));
copyRequired(
  resolve(desktopDir, "dist-electron"),
  resolve(outputDir, "dist-electron")
);
copyRequired(
  resolve(desktopDir, "assets"),
  resolve(koedAppRoot, "apps/desktop/assets")
);

for (const packageName of [
  "core",
  "db",
  "koed-server",
  "mcp-server",
  "shared"
]) {
  copyRequired(
    resolve(rootDir, "packages", packageName, "dist"),
    resolve(koedAppRoot, "packages", packageName, "dist")
  );
  copyRequired(
    resolve(rootDir, "packages", packageName, "package.json"),
    resolve(koedAppRoot, "packages", packageName, "package.json")
  );
}

for (const appName of ["api", "worker", "explorer"]) {
  copyRequired(
    resolve(rootDir, "apps", appName, "dist"),
    resolve(koedAppRoot, "apps", appName, "dist")
  );
  copyRequired(
    resolve(rootDir, "apps", appName, "package.json"),
    resolve(koedAppRoot, "apps", appName, "package.json")
  );
  const envExample = resolve(rootDir, "apps", appName, ".env.example");
  if (existsSync(envExample)) {
    copyRequired(
      envExample,
      resolve(koedAppRoot, "apps", appName, ".env.example")
    );
  }
}

copyRequired(
  resolve(rootDir, "apps/embedding-service"),
  resolve(koedAppRoot, "apps/embedding-service")
);
copyRequired(resolve(rootDir, "scripts"), resolve(koedAppRoot, "scripts"));
copyRequired(
  resolve(rootDir, "docker-compose.yml"),
  resolve(koedAppRoot, "docker-compose.yml")
);
copyRequired(
  resolve(rootDir, ".env.example"),
  resolve(koedAppRoot, ".env.example")
);
copyRequired(
  resolve(rootDir, "package.json"),
  resolve(koedAppRoot, "package.json")
);

writeFileSync(
  resolve(outputDir, "electron-builder-asar-unpack.json"),
  `${JSON.stringify(
    {
      asarUnpack: [
        "dist-electron/koed-server/**",
        "koed-app-root/packages/koed-server/dist/**",
        "koed-app-root/packages/mcp-server/dist/**",
        "koed-app-root/apps/api/dist/**",
        "koed-app-root/apps/worker/dist/**",
        "koed-app-root/apps/explorer/dist/**",
        "koed-app-root/apps/embedding-service/**",
        "koed-app-root/scripts/**"
      ],
      extraResources: [
        { from: "dist-resources/app-dist", to: "app-dist" },
        { from: "dist-resources/koed-app-root", to: "koed-app-root" }
      ]
    },
    null,
    2
  )}\n`
);

console.log(`Packaged Desktop resources staged at ${outputDir}`);
