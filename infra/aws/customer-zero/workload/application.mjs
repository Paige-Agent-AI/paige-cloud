import { readFileSync } from "node:fs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { inspectWorkload } from "./service.mjs";

const {
  CLOUD_WORKLOAD_BUCKET: bucket, CLOUD_WORKLOAD_VERSION: dataVersion,
  CLOUD_WORKLOAD_ORGANIZATION: organization, CLOUD_WORKLOAD_PROJECT: project,
  CLOUD_WORKLOAD_APPLICATION: application, CLOUD_WORKLOAD_ENVIRONMENT: environment
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

export const handler = inspectWorkload({
  scope, release, dataVersion,
  async readObject() {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: requestedVersion }));
    return { version: result.VersionId, size: result.ContentLength, text: () => result.Body.transformToString() };
  }
});
