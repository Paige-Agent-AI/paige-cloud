import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const inspectionCapability = "paige.cloud.workload.inspect.v1";
const segment = "[a-z0-9][a-z0-9-]{0,47}";
const scopePattern = new RegExp(`^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/(${segment})/(${segment})/(${segment})$`);

export function parseInspectionScope(value) {
  const match = scopePattern.exec(value);
  if (!match) throw new Error("Invalid configured workload inspection scope");
  const [, organization, project, application, environment] = match;
  return Object.freeze({ organization, project, application, environment });
}

export function createWorkloadObservation({ scope, decide, reserve, invoke, now = Date.now }) {
  const { organization, project, application, environment } = scope;
  function targetFor(organizationId, projectId, record) {
    if (organizationId === organization && projectId === project &&
        record.id === application && record.environments.includes(environment)) return environment;
    return null;
  }

  return {
    targetFor,
    async inspect(actor, selected, records) {
      if (!records?.some(record => targetFor(selected.organization, selected.project, record) === selected.environment &&
          record.id === selected.application)) return { status: 404 };

      // The session yields the person. The active project grant yields access. The deployment
      // binding yields the exact scope. Spine receives only those server-established facts.
      const args = Object.freeze({ operation: inspectionCapability });
      const decision = decide({
        caller: { authenticated: true, userId: actor, principal: "person", tenantId: organization,
          tenantSource: "server", door: "other", access: { allowed: true } },
        capability: { id: inspectionCapability, effect: "read", availability: "live" },
        approval: { autonomyLane: "off" },
        requestArgs: args
      });
      if (decision.kind !== "execute" || decision.args !== args) return { status: 403 };

      const reservation = await reserve(actor, scope);
      if (reservation === null) return { status: 404 };
      if (reservation === "limited") return { status: 429 };
      if (reservation !== "reserved") return { status: 503 };

      try {
        const result = await invoke(decision.args);
        if (result.StatusCode !== 200 || result.FunctionError ||
            typeof result.ExecutedVersion !== "string" || !/^[1-9]\d*$/.test(result.ExecutedVersion) ||
            !result.Payload?.length || result.Payload.length > 4096) return { status: 503 };
        const bytes = Buffer.from(result.Payload);
        const observed = JSON.parse(bytes.toString("utf8"));
        const observationTime = Date.parse(observed.observedAt);
        const elapsed = now() - observationTime;
        if (observed.schema !== inspectionCapability || observed.check !== "scoped_object" ||
            !["healthy", "unavailable"].includes(observed.state) ||
            !Object.entries(scope).every(([key, value]) => observed.scope?.[key] === value) ||
            typeof observed.release?.commit !== "string" || !/^[a-f0-9]{40}$/.test(observed.release.commit) ||
            !["a", "b"].includes(observed.release.candidate) ||
            !Number.isFinite(elapsed) || elapsed < -3000 || elapsed > 30000 ||
            (observed.state === "healthy" && (typeof observed.objectVersion !== "string" ||
              !observed.objectVersion || observed.objectVersion === "null"))) return { status: 503 };
        return { status: 200, observation: {
          schema: inspectionCapability,
          scope,
          state: observed.state,
          observedAt: new Date(observationTime).toISOString(),
          release: { commit: observed.release.commit, candidate: observed.release.candidate, version: result.ExecutedVersion },
          evidence: { source: "runtime_backend_read", sha256: createHash("sha256").update(bytes).digest("hex") }
        } };
      } catch {
        return { status: 503 };
      }
    }
  };
}
