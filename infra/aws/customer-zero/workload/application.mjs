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
const s3 = new S3Client({ maxAttempts: 2 });

export const handler = inspectWorkload({
  scope, release, dataVersion,
  async readObject() {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: dataVersion }));
    return { version: result.VersionId, size: result.ContentLength, text: () => result.Body.transformToString() };
  }
});
