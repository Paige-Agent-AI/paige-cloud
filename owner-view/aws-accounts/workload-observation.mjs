import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { projectWorkloadReleases } from "./workload-releases.mjs";

export const inspectionCapability = "paige.cloud.workload.inspect.v1";
export const releaseInventoryCapability = "paige.cloud.workload.releases.read.v1";
const segment = "[a-z0-9][a-z0-9-]{0,47}";
const scopePattern = new RegExp(`^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/(${segment})/(${segment})/(${segment})$`);
const unavailableReasons = new Set(["backend_access_denied", "backend_record_invalid", "backend_read_unverified",
  "configuration_access_denied", "configuration_unverified"]);

export function parseInspectionScope(value) {
  const match = scopePattern.exec(value);
  if (!match) throw new Error("Invalid configured workload inspection scope");
  const [, organization, project, application, environment] = match;
  return Object.freeze({ organization, project, application, environment });
}

export function parseInspectionRecoveryPoint(value) {
  if (!value) return null;
  const match = /^([1-9]\d*)\/([a-f0-9]{40})$/.exec(value);
  if (!match) throw new Error("Invalid configured workload recovery point");
  return Object.freeze({ version: match[1], commit: match[2] });
}

// Projects one trusted Lambda invocation into the existing Cloud observation contract.
export function readRuntimeWorkloadObservation(result, scope, now) {
  if (result?.StatusCode !== 200 || result.FunctionError ||
      typeof result.ExecutedVersion !== "string" || !/^[1-9]\d*$/.test(result.ExecutedVersion) ||
      (typeof result.Payload !== "string" && !(result.Payload instanceof Uint8Array)) ||
      !result.Payload.length || result.Payload.length > 4096) return null;
  const bytes = Buffer.from(result.Payload);
  if (bytes.length > 4096) return null;
  let observed;
  try {
    observed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (observed?.schema !== inspectionCapability) return null;
  const observationTime = Date.parse(observed.observedAt);
  const elapsed = now - observationTime;
  if (observed.check !== "scoped_object" ||
      !["healthy", "unavailable"].includes(observed.state) ||
      !Object.entries(scope).every(([key, value]) => observed.scope?.[key] === value) ||
      typeof observed.release?.commit !== "string" || !/^[a-f0-9]{40}$/.test(observed.release.commit) ||
      !["a", "b", "drill"].includes(observed.release.candidate) ||
      !Number.isFinite(elapsed) || elapsed < -3000 || elapsed > 30000 ||
      (observed.state === "healthy" && (typeof observed.objectVersion !== "string" ||
      !observed.objectVersion || observed.objectVersion === "null"))) return null;
  const observation = {
    schema: inspectionCapability,
    scope,
    state: observed.state,
    observedAt: new Date(observationTime).toISOString(),
    release: { commit: observed.release.commit, candidate: observed.release.candidate, version: result.ExecutedVersion },
    evidence: { source: "runtime_backend_read", sha256: createHash("sha256").update(bytes).digest("hex") }
  };
  if ("configuration" in observed) {
    const { revision, digest } = observed.configuration ?? {};
    if (!Number.isInteger(revision) || revision < 1 || revision > 2147483647 ||
        typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return null;
    observation.consumedConfiguration = { revision, digest };
  }
  if (observation.state === "unavailable") {
    observation.incident = {
      reason: unavailableReasons.has(observed.reason) ? observed.reason : "backend_read_unverified"
    };
  }
  return observation;
}

export function createWorkloadObservation({ scope, decide, reserve, invoke, readReleases, aliasArn, recoveryPoint, now = Date.now }) {
  const { organization, project, application, environment } = scope;
  function targetFor(organizationId, projectId, record) {
    if (organizationId === organization && projectId === project &&
        record.id === application && record.environments.includes(environment)) return environment;
    return null;
  }

  function matches(selected, records) {
    return records?.some(record => targetFor(selected.organization, selected.project, record) === selected.environment &&
      record.id === selected.application) === true;
  }

  async function admit(actor, selected, records, operation) {
    if (!matches(selected, records)) return { status: 404 };

    // The session yields the person. The active project grant yields access. The deployment
    // binding yields the exact scope. Spine receives only those server-established facts.
    const args = Object.freeze({ operation });
    const decision = decide({
      caller: { authenticated: true, userId: actor, principal: "person", tenantId: organization,
        tenantSource: "server", door: "other", access: { allowed: true } },
      capability: { id: operation, effect: "read", availability: "live" },
      approval: { autonomyLane: "off" },
      requestArgs: args
    });
    if (decision.kind !== "execute" || decision.args !== args) return { status: 403 };

    const reservation = await reserve(actor, scope);
    if (reservation === null) return { status: 404 };
    if (reservation === "limited") return { status: 429 };
    if (reservation !== "reserved") return { status: 503 };
    return { status: 200, args: decision.args };
  }

  return {
    targetFor,
    matches,
    releasesAvailable: typeof readReleases === "function",
    async listReleases(actor, selected, records) {
      if (!readReleases) return { status: 404 };
      const outcome = await admit(actor, selected, records, releaseInventoryCapability);
      if (outcome.status !== 200) return outcome;
      try {
        const inventory = projectWorkloadReleases(await readReleases(), scope, aliasArn, now());
        return inventory ? { status: 200, inventory } : { status: 503 };
      } catch {
        return { status: 503 };
      }
    },
    async inspect(actor, selected, records) {
      const outcome = await admit(actor, selected, records, inspectionCapability);
      if (outcome.status !== 200) return outcome;
      try {
        const result = await invoke(outcome.args);
        const observation = readRuntimeWorkloadObservation(result, scope, now());
        if (!observation) return { status: 503 };
        if (observation.incident?.reason === "backend_access_denied" && recoveryPoint &&
            observation.release.version !== recoveryPoint.version) {
          observation.incident.plan = {
            operation: "restore_verified_alias",
            status: "review_required",
            scope,
            fromVersion: observation.release.version,
            target: recoveryPoint,
            evidenceSha256: observation.evidence.sha256
          };
        }
        return { status: 200, observation };
      } catch {
        return { status: 503 };
      }
    }
  };
}
