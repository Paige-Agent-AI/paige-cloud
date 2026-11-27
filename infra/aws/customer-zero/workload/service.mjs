export const inspectionContract = "paige.cloud.workload.inspect.v1";

export function inspectWorkload({ scope, release, dataVersion, readObject }) {
  return async event => {
    if (event?.operation !== inspectionContract || Object.keys(event).length !== 1) {
      return { schema: inspectionContract, state: "unsupported_operation" };
    }

    const observation = { schema: inspectionContract, scope, release, observedAt: new Date().toISOString() };
    try {
      const source = await readObject();
      if (source.version !== dataVersion || !Number.isInteger(source.size) || source.size < 1 || source.size > 4096) {
        return { ...observation, state: "unavailable", check: "scoped_object" };
      }
      const record = JSON.parse(await source.text());
      if (record.schema !== "paige.cloud.workload.config.v1" || record.ready !== true ||
          !Object.entries(scope).every(([key, value]) => record[key] === value)) {
        return { ...observation, state: "unavailable", check: "scoped_object" };
      }
      return { ...observation, state: "healthy", check: "scoped_object", objectVersion: source.version };
    } catch {
      return { ...observation, state: "unavailable", check: "scoped_object" };
    }
  };
}
