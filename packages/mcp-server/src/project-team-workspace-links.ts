import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProjectTeamWorkspaceLink {
  projectRoot: string;
  teamWorkspaceId: string;
  backendId: string | null;
  localProjectId: string | null;
  sourceProjectId: string | null;
  projectDisplayName: string | null;
}

interface ProjectMetadataRecord {
  localProjectId: string;
  sourceProjectId: string | null;
  path: {
    cwd: string;
    projectRoot: string | null;
  };
}

const configRoot = (env: NodeJS.ProcessEnv): string =>
  env.KOED_HOME?.trim() || path.join(os.homedir(), ".koed");

const linkConfigPath = (env: NodeJS.ProcessEnv): string =>
  path.resolve(
    env.KOED_PROJECT_TEAM_WORKSPACE_LINKS_PATH?.trim() ||
      path.join(configRoot(env), "config", "project-team-workspaces.json")
  );

const projectMetadataPath = (env: NodeJS.ProcessEnv): string =>
  path.resolve(
    env.KOED_PROJECT_METADATA_PATH?.trim() ||
      path.join(configRoot(env), "config", "projects.json")
  );

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const teamMemoryDogfoodEnabled = (
  env: NodeJS.ProcessEnv = process.env
): boolean =>
  env.KOED_TEAM_MEMORY_DOGFOOD?.trim() === "1" ||
  env.KOED_TEAM_MEMORY_DOGFOOD?.trim().toLowerCase() === "true";

const readProjectMetadataForRoot = (
  projectRoot: string,
  env: NodeJS.ProcessEnv
): ProjectMetadataRecord | null => {
  const configPath = projectMetadataPath(env);
  if (!fs.existsSync(configPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    projects?: Array<Partial<ProjectMetadataRecord>>;
  };
  const normalizedProjectRoot = path.resolve(projectRoot);
  const project = parsed.projects?.find((candidate) => {
    const cwd =
      typeof candidate.path?.cwd === "string"
        ? path.resolve(candidate.path.cwd)
        : null;
    const root =
      typeof candidate.path?.projectRoot === "string"
        ? path.resolve(candidate.path.projectRoot)
        : null;
    return cwd === normalizedProjectRoot || root === normalizedProjectRoot;
  });
  if (!project || typeof project.localProjectId !== "string") return null;
  return {
    localProjectId: project.localProjectId,
    sourceProjectId:
      typeof project.sourceProjectId === "string"
        ? project.sourceProjectId
        : null,
    path: {
      cwd:
        typeof project.path?.cwd === "string"
          ? project.path.cwd
          : normalizedProjectRoot,
      projectRoot:
        typeof project.path?.projectRoot === "string"
          ? project.path.projectRoot
          : null
    }
  };
};

const normalizeLink = (
  candidate: Partial<ProjectTeamWorkspaceLink>,
  fallbackProjectRoot: string
): ProjectTeamWorkspaceLink | null => {
  if (!uuidPattern.test(candidate.teamWorkspaceId ?? "")) return null;
  return {
    projectRoot:
      typeof candidate.projectRoot === "string"
        ? path.resolve(candidate.projectRoot)
        : fallbackProjectRoot,
    teamWorkspaceId: candidate.teamWorkspaceId!,
    backendId:
      typeof candidate.backendId === "string" ? candidate.backendId : null,
    localProjectId:
      typeof candidate.localProjectId === "string"
        ? candidate.localProjectId
        : null,
    sourceProjectId:
      typeof candidate.sourceProjectId === "string"
        ? candidate.sourceProjectId
        : null,
    projectDisplayName:
      typeof candidate.projectDisplayName === "string"
        ? candidate.projectDisplayName
        : null
  };
};

export const resolveProjectTeamWorkspaceLink = (
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): ProjectTeamWorkspaceLink | null => {
  const configPath = linkConfigPath(env);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    links?: Array<Partial<ProjectTeamWorkspaceLink>>;
  };
  const normalizedProjectRoot = path.resolve(projectRoot);
  const project = readProjectMetadataForRoot(normalizedProjectRoot, env);
  const link = parsed.links
    ?.map((candidate) => normalizeLink(candidate, normalizedProjectRoot))
    .find((candidate): candidate is ProjectTeamWorkspaceLink => {
      if (!candidate) return false;
      if (candidate.projectRoot === normalizedProjectRoot) return true;
      if (
        project?.localProjectId &&
        candidate.localProjectId === project.localProjectId
      ) {
        return true;
      }
      return Boolean(
        project?.sourceProjectId &&
        candidate.sourceProjectId === project.sourceProjectId
      );
    });
  return link ?? null;
};
