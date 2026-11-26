import { createHash } from "node:crypto";
import { isProjectSlug } from "./projects.mjs";

const scopeKeys = ["organizationId", "projectId", "environmentId", "applicationId"];
const fields = [...scopeKeys, "id", "provider", "resourceId", "version"];
const key = (scope) => JSON.stringify(scopeKeys.map(field => scope[field]));

// Server-owned approvals only. No URL, token, or provider calls belong in this registry.
export function createBindingTargets(raw) {
  if (raw === undefined) return () => [];
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 32_768) throw new Error("Invalid provider target configuration");
  let entries;
  try { entries = JSON.parse(raw); } catch { throw new Error("Invalid provider target configuration"); }
  if (!Array.isArray(entries) || entries.length > 100) throw new Error("Invalid provider target configuration");
  const scopes = new Map(), resources = new Map();
  for (const entry of entries) {
    if (!entry || Object.keys(entry).length !== fields.length || !fields.every(f => Object.hasOwn(entry, f)) ||
        ![...scopeKeys, "id"].every(f => isProjectSlug(entry[f])) || entry.provider !== "coolify" ||
        typeof entry.resourceId !== "string" || !/^[a-z0-9]{20,32}$/.test(entry.resourceId) ||
        !Number.isSafeInteger(entry.version) || entry.version < 1) throw new Error("Invalid provider target entry");
    const scope = key(entry), resource = `${entry.provider}:${entry.resourceId}`;
    if (resources.has(resource) && resources.get(resource) !== scope) throw new Error("Provider target assigned across scopes");
    resources.set(resource, scope);
    const targets = scopes.get(scope) ?? [];
    if (targets.some(target => target.id === entry.id)) throw new Error("Duplicate provider target ID");
    targets.push(Object.freeze({ id: entry.id, provider: entry.provider, version: entry.version,
      fingerprint: createHash("sha256").update(JSON.stringify(fields.map(f => entry[f]))).digest("hex") }));
    scopes.set(scope, targets);
  }
  return scope => Object.freeze([...(scopes.get(key(scope)) ?? [])]);
}

export function bindingState(binding, targets) {
  if (!binding?.targetId) return "unbound";
  const target = targets.find(x => x.id === binding.targetId);
  return target && target.fingerprint === binding.targetFingerprint ? "bound" : "approval-unavailable";
}
