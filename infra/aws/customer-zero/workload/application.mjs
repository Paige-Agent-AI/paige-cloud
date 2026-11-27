import { readFileSync } from "node:fs";
import { addAbortSignal } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { inspectWorkload } from "./service.mjs";

const {
  CLOUD_WORKLOAD_BUCKET: bucket, CLOUD_WORKLOAD_VERSION: dataVersion,
  CLOUD_WORKLOAD_ORGANIZATION: organization, CLOUD_WORKLOAD_PROJECT: project,
  CLOUD_WORKLOAD_APPLICATION: application, CLOUD_WORKLOAD_ENVIRONMENT: environment,
  CLOUD_SETTINGS_VERSION: settingsVersion, CLOUD_SETTINGS_DIGEST: settingsDigest, CLOUD_SETTINGS_REVISION: settingsRevision
} = process.env;
const scope = { organization, project, application, environment };
const release = JSON.parse(readFileSync(new URL("./release.json", import.meta.url), "utf8"));
const key = `workloads/${organization}/${project}/${application}/${environment}/config.json`;
// The explicit private drill artifact makes one real read of a different version of the
// same object. The runtime grant continues to allow only the original pinned version.
const requestedVersion = release.candidate === "drill"
  ? `${dataVersion[0] === "A" ? "B" : "A"}${dataVersion.slice(1)}`
  : dataVersion;
const s3 = new S3Client({ maxAttempts: release.candidate === "drill" ? 1 : 2 });
const settingsPin = settingsVersion || settingsDigest || settingsRevision
  ? { version: settingsVersion, digest: settingsDigest, revision: Number(settingsRevision) }
  : undefined;

async function readVersion(objectKey, version, signal) {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey, VersionId: version }),
    { abortSignal: signal });
  if (signal && result.Body) addAbortSignal(signal, result.Body);
  return result;
}

export const handler = inspectWorkload({
  scope, release, dataVersion, settingsPin,
  log(level, outcome) {
    console[level](JSON.stringify({ operation: "workload.inspect", outcome }));
  },
  async readSettings(objectKey, version, signal) {
    const result = await readVersion(objectKey, version, signal);
    return { version: result.VersionId, size: result.ContentLength, bytes: () => result.Body.transformToByteArray() };
  },
  async readObject(signal) {
    const result = await readVersion(key, requestedVersion, signal);
    return { version: result.VersionId, size: result.ContentLength, text: () => result.Body.transformToString() };
  }
});
