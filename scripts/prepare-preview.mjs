import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [phase, frontendCommit, cloudCommit] = process.argv.slice(2);
const fullCommit = /^[a-f0-9]{40}$/;
if (!fullCommit.test(frontendCommit) || !fullCommit.test(cloudCommit)) {
  throw new Error("Both source revisions must be full Git commit SHAs.");
}
const buildId = `${frontendCommit}-${cloudCommit}`;
const excludedInputs = ".paige-preview-excluded.json";
const environment = "cloud-preview";

function replaceOnce(source, pattern, replacement) {
  if ([...source.matchAll(pattern)].length !== 1) {
    throw new Error(`Pinned frontend build contract changed: ${pattern.source}`);
  }
  return source.replace(pattern, replacement);
}

function prepare() {
  const forbidden = new Set();
  for (const name of readdirSync(".").filter((name) => /^\.env(?:\.|$)/.test(name))) {
    for (const line of readFileSync(name, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?VITE_\w+\s*=\s*(.+)$/);
      const value = match?.[1].trim().replace(/^["']|["']$/g, "");
      if (value?.length >= 16) forbidden.add(value);
      if (value?.startsWith("https://")) forbidden.add(new URL(value).hostname);
    }
    rmSync(name);
  }
  writeFileSync(excludedInputs, JSON.stringify([...forbidden]));
  writeFileSync(".env.production", [
    "VITE_SUPABASE_URL=https://preview-backend.invalid",
    "VITE_SUPABASE_PROJECT_ID=preview-backend",
    "VITE_SUPABASE_PUBLISHABLE_KEY=preview-disabled",
    "VITE_SUPABASE_ANON_KEY=preview-disabled",
    "",
  ].join("\n"));

  let vite = readFileSync("vite.config.ts", "utf8");
  vite = replaceOnce(vite, /^const BUILD_ID = `\$\{[\s\S]*?\}[-]\$\{Date\.now\(\)\.toString\(36\)\}`;/gm,
    `const BUILD_ID = ${JSON.stringify(buildId)};`);
  vite = replaceOnce(vite, /^const CUSTOMER_UPDATE = readCustomerUpdateManifest\(\);$/gm,
    "const CUSTOMER_UPDATE = null;");
  vite = replaceOnce(vite, /^\s+auth: path.resolve\(__dirname, "auth\.html"\),\r?\n/gm, "");
  writeFileSync("vite.config.ts", vite);

  const clientPath = "src/integrations/supabase/client.ts";
  const client = readFileSync(clientPath, "utf8");
  writeFileSync(clientPath, replaceOnce(client,
    /createClient<Database>\(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, \{/g,
    "createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {\n" +
      '  global: { fetch: async () => { throw new Error("PAIGE Cloud preview has no backend access."); } },'));
}

function verify() {
  const version = JSON.parse(readFileSync("dist/version.json", "utf8"));
  if (version.buildId !== buildId || version.customerUpdate !== null) {
    throw new Error("Vite did not embed the expected preview build identity.");
  }
  for (const name of ["auth.html", "sw.js"]) {
    rmSync(join("dist", name), { force: true });
  }
  const forbidden = JSON.parse(readFileSync(excludedInputs, "utf8"));
  for (const name of readdirSync("dist", { recursive: true })) {
    if (!/\.(?:html?|[cm]?js|json|css|map|svg|webmanifest)$/i.test(name)) continue;
    const content = readFileSync(join("dist", name), "utf8");
    if (forbidden.some((value) => content.includes(value))) {
      throw new Error(`A blocked upstream build value was found in ${name}.`);
    }
  }
  writeFileSync("dist/release.json", JSON.stringify({
    schema: 1, environment, cloudCommit, frontendCommit, buildId,
  }) + "\n");
}

if (phase === "prepare") prepare();
else if (phase === "verify") verify();
else throw new Error("Usage: prepare-preview.mjs <prepare|verify> <frontend SHA> <cloud SHA>");
