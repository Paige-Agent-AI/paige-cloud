import { readPinnedSettings } from "./settings.mjs";

export const inspectionContract = "paige.cloud.workload.inspect.v1";
const levels = { error: 0, warn: 1, info: 2 };

export function inspectWorkload({ scope, release, dataVersion, readObject, settingsPin, readSettings, log }) {
  return async event => {
    if (event?.operation !== inspectionContract || Object.keys(event).length !== 1) {
      return { schema: inspectionContract, state: "unsupported_operation" };
    }

    const observation = { schema: inspectionContract, scope, release, observedAt: new Date().toISOString() };
    let configuration;
    if (settingsPin) {
      try {
        configuration = await readPinnedSettings(scope, settingsPin, readSettings, AbortSignal.timeout(1500));
      } catch (error) {
        return { ...observation, state: "unavailable", check: "scoped_object",
          reason: accessDenied(error) ? "configuration_access_denied" : "configuration_unverified" };
      }
    }
    const consumed = configuration ? {
      configuration: { revision: settingsPin.revision, digest: settingsPin.digest, version: settingsPin.version }
    } : {};
    const report = (level, outcome) => {
      if (configuration && levels[level] <= levels[configuration.logLevel]) log?.(level, outcome);
    };
    const unavailable = reason => {
      report("warn", reason);
      return { ...observation, ...consumed, state: "unavailable", check: "scoped_object", reason };
    };
    try {
      const signal = configuration ? AbortSignal.timeout(configuration.requestTimeoutMs) : undefined;
      const source = await readObject(signal);
      if (source.version !== dataVersion || !Number.isInteger(source.size) || source.size < 1 || source.size > 4096) {
        return unavailable("backend_record_invalid");
      }
      const record = JSON.parse(await source.text());
      if (record.schema !== "paige.cloud.workload.config.v1" || record.ready !== true ||
          !Object.entries(scope).every(([key, value]) => record[key] === value)) {
        return unavailable("backend_record_invalid");
      }
      report("info", "backend_read_verified");
      return { ...observation, ...consumed, state: "healthy", check: "scoped_object", objectVersion: source.version };
    } catch (error) {
      if (accessDenied(error)) {
        return unavailable("backend_access_denied");
      }
      return unavailable("backend_read_unverified");
    }
  };
}

function accessDenied(error) {
  return error?.name === "AccessDenied" && error.$metadata?.httpStatusCode === 403;
}
