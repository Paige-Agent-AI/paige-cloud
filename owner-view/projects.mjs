import { readOwnerStatus, readPreviewStatus, readProductionStatus } from "./status.mjs";

export const ownerId = "cloud-owner";
const firstProject = Object.freeze({ organizationId: "paige", projectId: "paige-agent-ai" });
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

export function createProjectAccess(projects, memberships) {
  const registry = new Map();
  for (const { organizationId, projectId, readStatus, environments } of projects) {
    const key = `${organizationId}/${projectId}`;
    if (!validSlug.test(organizationId) || !validSlug.test(projectId) || registry.has(key) || typeof readStatus !== "function") {
      throw new Error("Invalid or duplicate Cloud project.");
    }
    const environmentReaders = new Map();
    for (const [id, read] of Object.entries(environments)) {
      if (!validSlug.test(id) || typeof read !== "function") throw new Error("Invalid Cloud environment.");
      environmentReaders.set(id, Object.freeze({ read }));
    }
    registry.set(key, { status: Object.freeze({ read: readStatus }), environmentReaders });
  }

  const grants = new Map();
  for (const { principalId, organizationId, projectId } of memberships) {
    const key = `${organizationId}/${projectId}`;
    if (!registry.has(key)) throw new Error("Cloud membership refers to an unknown project.");
    if (!grants.has(principalId)) grants.set(principalId, new Set());
    grants.get(principalId).add(key);
  }

  return function resolveRead(principalId, { organizationId, projectId, environmentId }) {
    const key = `${organizationId}/${projectId}`;
    if (!grants.get(principalId)?.has(key)) return undefined;
    const project = registry.get(key);
    return environmentId === undefined ? project.status : project.environmentReaders.get(environmentId);
  };
}

export function createPaigeProjectAccess(token) {
  return createProjectAccess([{
    ...firstProject,
    readStatus: () => readOwnerStatus(token),
    environments: {
      production: () => readProductionStatus(),
      "f2-preview": () => readPreviewStatus(token),
    },
  }], [{ principalId: ownerId, ...firstProject }]);
}
