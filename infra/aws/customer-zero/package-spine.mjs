import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

// Read-only build input. The original PAIGE Agent AI repository remains the source owner.
const revision = "79e2f303e41662af2a8e7c3027ec4189127727d5";
const source = {
  "action-risk.ts": "942b4a296b281e7474e5fee416d11ffaa3f3e9b03f182c3d62b3dc247f32483d",
  "governedExecution.ts": "ba5362d01e7aa35bac6ee6b2fe9d88f991e79149e5ff9bdd0de913206df75b59"
};
const [, , sourceDirectory, packageDirectory] = process.argv;
if (!sourceDirectory || !packageDirectory) throw new Error("Provide the verified Spine source input and runtime package directories");
const target = join(packageDirectory, "canonical-spine");
mkdirSync(target, { recursive: true });
for (const [name, expected] of Object.entries(source)) {
  const input = readFileSync(join(sourceDirectory, name));
  if (createHash("sha256").update(input).digest("hex") !== expected) throw new Error(`Unreviewed Spine source ${name}`);
  const js = stripTypeScriptTypes(input.toString("utf8"), { mode: "strip" })
    .replace('from "../action-risk.ts"', 'from "./action-risk.mjs"');
  writeFileSync(join(target, name.replace(/\.ts$/, ".mjs")), js);
}
writeFileSync(join(target, "source.json"), JSON.stringify({ revision, source }) + "\n");
