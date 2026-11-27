import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readRuntimeWorkloadObservation } from "../../../../owner-view/aws-accounts/workload-observation.mjs";

// Cloud's provider evidence boundary. A matching target is independent evidence of
// current health. It does not attribute an effect to an approved attempt or permit a retry.
const version = /^[1-9]\d*$/;
const commit = /^[a-f0-9]{40}$/;
const codeDigest = /^[A-Za-z0-9+/]{43}=$/;
const functionArn = /^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[a-zA-Z0-9_-]+$/;
const aliasName = /^(?![0-9]+$)[a-zA-Z0-9_-]{1,128}$/;
const scopeFields = ["organization", "project", "application", "environment"];
const unverified = reason => ({ state: "unverified", reason });

export function verifyRecoveryTarget(input, now = Date.now()) {
  const { expected, startedAt, aliasBefore, invocation, configuration, aliasAfter } = input ?? {};
  if (!expected || !functionArn.test(expected.functionArn) || typeof expected.alias !== "string" ||
      !aliasName.test(expected.alias) || typeof expected.version !== "string" ||
      !version.test(expected.version) || !commit.test(expected.commit) || !codeDigest.test(expected.codeSha256) ||
      !scopeFields.every(key => typeof expected.scope?.[key] === "string" && expected.scope[key])) {
    return unverified("invalid_target");
  }
  const started = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(now) || !Number.isFinite(started) || started > now || now - started > 30_000) {
    return unverified("stale_or_missing_observation");
  }
  const exactAlias = `${expected.functionArn}:${expected.alias}`;
  if (!aliasBefore || !aliasAfter || aliasBefore.AliasArn !== exactAlias || aliasAfter.AliasArn !== exactAlias ||
      typeof aliasBefore.RevisionId !== "string" || !aliasBefore.RevisionId ||
      aliasBefore.RevisionId !== aliasAfter.RevisionId ||
      aliasBefore.FunctionVersion !== expected.version || aliasAfter.FunctionVersion !== expected.version ||
      Object.keys(aliasBefore.RoutingConfig?.AdditionalVersionWeights ?? {}).length ||
      Object.keys(aliasAfter.RoutingConfig?.AdditionalVersionWeights ?? {}).length) {
    return unverified("alias_not_pinned");
  }
  if (configuration?.FunctionArn !== `${expected.functionArn}:${expected.version}` ||
      configuration.Version !== expected.version || configuration.State !== "Active" ||
      configuration.CodeSha256 !== expected.codeSha256) {
    return unverified("immutable_version_mismatch");
  }
  const observation = readRuntimeWorkloadObservation(invocation, expected.scope, now);
  if (observation?.state !== "healthy" || Date.parse(observation.observedAt) < started - 3_000 ||
      observation.release.version !== expected.version || observation.release.commit !== expected.commit) {
    return unverified("runtime_observation_mismatch");
  }
  return {
    state: "target_verified",
    observedAt: observation.observedAt,
    release: { version: expected.version, commit: expected.commit, codeSha256: expected.codeSha256 },
    evidenceSha256: observation.evidence.sha256
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const facts = JSON.parse(readFileSync(0, "utf8"));
  const result = verifyRecoveryTarget(facts);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.state !== "target_verified") process.exitCode = 1;
}
