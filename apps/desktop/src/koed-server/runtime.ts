import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NodeEntrypointInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface KoedServerRuntimeLayout {
  repoRoot: string;
  cliPath: string;
  appDistDir: string;
}

export interface KoedServerRuntimeOptions {
  appIsPackaged: boolean;
  electronExecPath: string;
  platform: NodeJS.Platform;
  resourcesPath?: string;
  environment: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
}

const currentDir = dirname(fileURLToPath(import.meta.url));

export const assertPathExists = ({
  label,
  filePath,
  existsSync: pathExists = existsSync
}: {
  label: string;
  filePath: string;
  existsSync?: (path: string) => boolean;
}): string => {
  if (!pathExists(filePath)) {
    throw new Error(`${label} is missing at ${filePath}`);
  }
  return filePath;
};

export const packagedKoedAppRootName = "koed-app-root";

export const resolveDevelopmentRepoRoot = (appDir = currentDir): string =>
  resolve(appDir, "..", "..", "..");

export const resolvePackagedKoedAppRoot = (resourcesPath: string): string =>
  resolve(resourcesPath, packagedKoedAppRootName);

export const resolveKoedServerRuntimeLayout = ({
  appIsPackaged,
  appDir = currentDir,
  resourcesPath
}: {
  appIsPackaged: boolean;
  appDir?: string;
  resourcesPath?: string;
}): KoedServerRuntimeLayout => {
  const repoRoot = appIsPackaged
    ? resolvePackagedKoedAppRoot(resourcesPath ?? resolve(appDir, ".."))
    : resolveDevelopmentRepoRoot(appDir);
  return {
    repoRoot,
    cliPath: resolve(repoRoot, "packages/koed-server/dist/cli.js"),
    appDistDir: appIsPackaged
      ? resolve(resourcesPath ?? resolve(appDir, ".."), "app-dist")
      : resolve(repoRoot, "apps/desktop/dist")
  };
};

export const createKoedServerInvocationEnvironment = ({
  appIsPackaged,
  environment,
  repoRoot
}: {
  appIsPackaged: boolean;
  environment: NodeJS.ProcessEnv;
  repoRoot: string;
}): NodeJS.ProcessEnv => ({
  ...environment,
  KOED_DESKTOP_MANAGED: "1",
  ...(appIsPackaged
    ? { KOED_PACKAGED_APP_ROOT: repoRoot }
    : { KOED_REPO_ROOT: environment.KOED_REPO_ROOT ?? repoRoot })
});

export const createElectronNodeEnv = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => ({
  ...environment,
  ELECTRON_RUN_AS_NODE: "1"
});

export const resolveElectronNodeExecPath = ({
  appIsPackaged,
  electronExecPath,
  platform,
  existsSync: pathExists = existsSync
}: Pick<
  KoedServerRuntimeOptions,
  "appIsPackaged" | "electronExecPath" | "platform" | "existsSync"
>): string => {
  if (appIsPackaged && platform === "darwin") {
    const marker = ".app/Contents/MacOS/";
    const markerIndex = electronExecPath.indexOf(marker);
    if (markerIndex !== -1) {
      const bundleRoot = electronExecPath.substring(
        0,
        markerIndex + ".app".length
      );
      const appName = electronExecPath.slice(markerIndex + marker.length);
      const helperPath = `${bundleRoot}/Contents/Frameworks/${appName} Helper.app/Contents/MacOS/${appName} Helper`;
      if (pathExists(helperPath)) {
        return helperPath;
      }
    }
  }
  return electronExecPath;
};

const resolvePackagedRunnerPath = (resourcesPath?: string): string => {
  if (resourcesPath) {
    return resolve(
      resourcesPath,
      "app.asar.unpacked",
      "dist-electron",
      "koed-server",
      "node-entrypoint-runner.js"
    );
  }
  return resolve(currentDir, "node-entrypoint-runner.js");
};

export const createKoedServerCliInvocation = (
  cliPath: string,
  args: string[],
  options: KoedServerRuntimeOptions
): NodeEntrypointInvocation => {
  const explicitNodeCommand = options.environment.KOED_NODE_COMMAND?.trim();
  if (explicitNodeCommand) {
    return {
      command: explicitNodeCommand,
      args: [cliPath, ...args],
      env: options.environment
    };
  }

  const command = resolveElectronNodeExecPath(options);
  const env = createElectronNodeEnv(options.environment);

  if (options.appIsPackaged) {
    return {
      command,
      args: [
        assertPathExists({
          label: "Bundled Koed Desktop node entrypoint runner",
          filePath: resolvePackagedRunnerPath(options.resourcesPath),
          existsSync: options.existsSync
        }),
        "node-script",
        assertPathExists({
          label: "Bundled koed-server CLI",
          filePath: cliPath,
          existsSync: options.existsSync
        }),
        ...args
      ],
      env
    };
  }

  return {
    command,
    args: [cliPath, ...args],
    env
  };
};
