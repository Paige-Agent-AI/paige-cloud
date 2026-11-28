const versionNumber = /^[1-9][0-9]{0,19}$/;
const codeChecksum = /^[A-Za-z0-9+/]{43}=$/;
const settingsDigest = /^[a-f0-9]{64}$/;
const scopeVariables = {
  organization: "CLOUD_WORKLOAD_ORGANIZATION",
  project: "CLOUD_WORKLOAD_PROJECT",
  application: "CLOUD_WORKLOAD_APPLICATION",
  environment: "CLOUD_WORKLOAD_ENVIRONMENT"
};

export const workloadReleaseLimit = 25;

function verifiedAlias(response, aliasArn) {
  return response?.AliasArn === aliasArn && typeof response.FunctionVersion === "string" &&
    versionNumber.test(response.FunctionVersion) &&
    typeof response.RevisionId === "string" && response.RevisionId.length > 0 &&
    Object.keys(response.RoutingConfig?.AdditionalVersionWeights ?? {}).length === 0;
}

export function projectWorkloadReleases({ versions, before, after }, scope, aliasArn, now) {
  if (!verifiedAlias(before, aliasArn) || !verifiedAlias(after, aliasArn) ||
      before.RevisionId !== after.RevisionId || before.FunctionVersion !== after.FunctionVersion ||
      !Array.isArray(versions?.Versions) || versions.Versions.length > workloadReleaseLimit) return null;
  const functionArn = aliasArn.slice(0, -":live".length);
  const rows = new Map();
  for (const record of versions.Versions) {
    if (record?.Version === "$LATEST") continue;
    const { Version: version, FunctionArn: arn, CodeSha256: codeSha256 } = record ?? {};
    const env = record?.Environment?.Variables;
    const lastModified = Date.parse(record?.LastModified);
    if (typeof version !== "string" || !versionNumber.test(version) || rows.has(version) || arn !== functionArn + ":" + version ||
        typeof codeSha256 !== "string" || !codeChecksum.test(codeSha256) || !Number.isFinite(lastModified) || lastModified > now + 5000 ||
        !Object.entries(scopeVariables).every(([key, variable]) => env?.[variable] === scope[key])) return null;

    const revision = env.CLOUD_SETTINGS_REVISION;
    const hasPin = revision !== undefined || env.CLOUD_SETTINGS_DIGEST !== undefined || env.CLOUD_SETTINGS_VERSION !== undefined;
    if (hasPin && (typeof revision !== "string" || !/^[1-9][0-9]{0,9}$/.test(revision) ||
        Number(revision) > 2147483647 || !settingsDigest.test(env.CLOUD_SETTINGS_DIGEST ?? "") ||
        typeof env.CLOUD_SETTINGS_VERSION !== "string" || !env.CLOUD_SETTINGS_VERSION || env.CLOUD_SETTINGS_VERSION === "null")) return null;
    rows.set(version, {
      version,
      lastModified: new Date(lastModified).toISOString(),
      codeSha256,
      pinnedRevision: hasPin ? Number(revision) : null
    });
  }

  const partial = typeof versions.NextMarker === "string" && versions.NextMarker.length > 0;
  const liveAliasVersion = rows.has(after.FunctionVersion) ? after.FunctionVersion : null;
  if (!liveAliasVersion && !partial) return null;
  return {
    observedAt: new Date(now).toISOString(),
    completeness: partial ? "partial" : "complete",
    liveAliasVersion,
    versions: [...rows.values()].sort((a, b) => b.version.length - a.version.length || b.version.localeCompare(a.version))
  };
}
