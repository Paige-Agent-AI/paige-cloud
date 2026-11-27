import { readFile, writeFile } from "node:fs/promises";
import { encodeSettings } from "./settings.mjs";

const [organization, project, application, environment, expectedRevision, responsePath, snapshotPath] = process.argv.slice(2);
if (process.argv.length !== 9) {
  console.error("Usage: node stage-settings.mjs ORGANIZATION PROJECT APPLICATION ENVIRONMENT REVISION SAVED_RESPONSE SNAPSHOT");
  process.exit(1);
}

try {
  const saved = JSON.parse(await readFile(responsePath, "utf8"));
  if (String(saved?.revision) !== expectedRevision) throw new Error("Expected revision did not match saved response");
  const { key, body, digest, revision } = encodeSettings({ organization, project, application, environment }, saved);
  await writeFile(snapshotPath, body, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ key, digest, revision }));
} catch {
  console.error("Could not stage the saved configuration response in a new file");
  process.exitCode = 1;
}
