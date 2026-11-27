import { createHash } from "node:crypto";

const schema = "paige.cloud.workload.settings.v1";
const fields = ["organization", "project", "application", "environment"];
const maxSize = 4096;

function validRevision(value) {
  return Number.isInteger(value) && value > 0 && value <= 2147483647;
}

function validConfiguration(value) {
  return value && Object.keys(value).length === 2 && ["error", "warn", "info"].includes(value.logLevel) &&
    Number.isInteger(value.requestTimeoutMs) && value.requestTimeoutMs >= 100 && value.requestTimeoutMs <= 30000;
}

export function settingsKey(scope) {
  if (typeof scope.organization !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(scope.organization) ||
      !fields.slice(1).every(field => typeof scope[field] === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(scope[field]))) {
    throw new Error("Invalid registered workload scope");
  }
  return `workloads/${fields.map(field => scope[field]).join("/")}/settings.json`;
}

export function encodeSettings(scope, saved) {
  const key = settingsKey(scope);
  if (!validRevision(saved?.revision) || !validConfiguration(saved.configuration) ||
      typeof saved.savedAt !== "string" || !Number.isFinite(Date.parse(saved.savedAt))) {
    throw new Error("Expected an accepted saved configuration revision");
  }
  const { logLevel, requestTimeoutMs } = saved.configuration;
  const body = Buffer.from(JSON.stringify({
    schema, scope: Object.fromEntries(fields.map(field => [field, scope[field]])),
    revision: saved.revision, configuration: { logLevel, requestTimeoutMs },
    savedAt: saved.savedAt
  }));
  return { key, body, digest: createHash("sha256").update(body).digest("hex"), revision: saved.revision };
}

export async function readPinnedSettings(scope, pin, read, signal) {
  if (!validRevision(pin.revision) || !/^[a-f0-9]{64}$/.test(pin.digest) ||
      typeof pin.version !== "string" || !pin.version || pin.version === "null") {
    throw new Error("Invalid configuration pin");
  }
  const object = await read(settingsKey(scope), pin.version, signal);
  if (object.version !== pin.version || !Number.isInteger(object.size) || object.size < 1 || object.size > maxSize) {
    throw new Error("Unexpected configuration object");
  }
  const body = Buffer.from(await object.bytes());
  if (body.length !== object.size || createHash("sha256").update(body).digest("hex") !== pin.digest) {
    throw new Error("Configuration digest mismatch");
  }
  const record = JSON.parse(body);
  if (record.schema !== schema || record.revision !== pin.revision ||
      !fields.every(field => record.scope?.[field] === scope[field]) || !validConfiguration(record.configuration)) {
    throw new Error("Configuration scope or revision mismatch");
  }
  return record.configuration;
}
