export const inspectionContract = "paige.cloud.workload.inspect.v1";

export function inspectWorkload({ scope, release, dataVersion, readObject }) {
  return async event => {
    if (event?.operation !== inspectionContract || Object.keys(event).length !== 1) {
      return { schema: inspectionContract, state: "unsupported_operation" };
    }

    const observation = { schema: inspectionContract, scope, release, observedAt: new Date().toISOString() };
    const unavailable = reason => ({ ...observation, state: "unavailable", check: "scoped_object", reason });
    try {
      const source = await readObject();
      if (source.version !== dataVersion || !Number.isInteger(source.size) || source.size < 1 || source.size > 4096) {
        return unavailable("backend_record_invalid");
      }
      const record = JSON.parse(await source.text());
      if (record.schema !== "paige.cloud.workload.config.v1" || record.ready !== true ||
          !Object.entries(scope).every(([key, value]) => record[key] === value)) {
        return unavailable("backend_record_invalid");
      }
      return { ...observation, state: "healthy", check: "scoped_object", objectVersion: source.version };
    } catch (error) {
      if (error?.name === "AccessDenied" && error.$metadata?.httpStatusCode === 403) {
        return unavailable("backend_access_denied");
      }
      return unavailable("backend_read_unverified");
    }
  };
}
