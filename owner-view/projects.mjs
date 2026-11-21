import { readOwnerStatus, readPreviewStatus, readProductionStatus } from "./status.mjs";

export const ownerId = "cloud-owner";
export const firstProject = Object.freeze({ organizationId: "paige", projectId: "paige-agent-ai" });
const slug = "[a-z0-9][a-z0-9-]{0,62}";
const validSlug = new RegExp(`^${slug}$`);
const statusPath = new RegExp(
  `^/api/organizations/(?<organizationId>${slug})/projects/(?<projectId>${slug})(?:/environments/(?<environmentId>${slug}))?/status$`,
);

export function parseProjectStatusPath(path) {
  if (path === "/api/status") return firstProject;
  const match = statusPath.exec(path);
  return match?.[0] === path ? match.groups : undefined;
}

export function isProjectSlug(value) {
  return typeof value === "string" && validSlug.exec(value)?.[0] === value;
}

export function createProjectAccess(projects, hasProjectRead) {
  if (typeof hasProjectRead !== "function") throw new Error("A Cloud membership reader is required.");
  const registry = new Map();
  for (const { organizationId, projectId, readStatus, environments } of projects) {
    const key = `${organizationId}/${projectId}`;
    if (!isProjectSlug(organizationId) || !isProjectSlug(projectId) || registry.has(key) || typeof readStatus !== "function") {
      throw new Error("Invalid or duplicate Cloud project.");
    }
    const environmentReaders = new Map();
    for (const [id, read] of Object.entries(environments)) {
      if (!isProjectSlug(id) || typeof read !== "function") throw new Error("Invalid Cloud environment.");
      environmentReaders.set(id, Object.freeze({ read }));
    }
    registry.set(key, { status: Object.freeze({ read: readStatus }), environmentReaders });
  }

  return function resolveRead(principalId, { organizationId, projectId, environmentId }) {
    const key = `${organizationId}/${projectId}`;
    const project = registry.get(key);
    const reader = environmentId === undefined ? project?.status : project?.environmentReaders.get(environmentId);
    return reader && hasProjectRead(principalId, organizationId, projectId) === true ? reader : undefined;
  };
}

export function createPaigeProjectAccess(token, hasProjectRead) {
  if (!/^[\x21-\x7e]{16,512}$/.test(token ?? "")) throw new Error("A scoped Coolify read token is required.");
  return createProjectAccess([{
    ...firstProject,
    readStatus: () => readOwnerStatus(token),
    environments: {
      production: () => readProductionStatus(),
      "f2-preview": () => readPreviewStatus(token),
    },
  }], hasProjectRead);
}
