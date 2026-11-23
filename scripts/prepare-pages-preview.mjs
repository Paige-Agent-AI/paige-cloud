import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sha = /^[a-f0-9]{40}$/;
const reserved = new Set(["_worker.js", "_routes.json", "_headers", "_redirects", "functions", ".assetsignore",
  "wrangler.toml", "wrangler.json", "wrangler.jsonc", "cloudflare.config.ts", "404.html", "healthz"]);
const maxFileBytes = 25 * 1024 * 1024;
const maxFiles = 20_000;
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; " +
  "frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

export function preparePagesPreview(directory, frontendCommit, cloudCommit) {
  assert.match(frontendCommit ?? "", sha);
  assert.match(cloudCommit ?? "", sha);
  assert.ok(lstatSync(directory).isDirectory(), "A regular static preview directory is required.");
  let files = 0;
  function inspect(folder) {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      assert.ok(!reserved.has(name.toLowerCase()) && !name.startsWith("."), "The preview contains a reserved Pages path.");
      const entry = lstatSync(path);
      if (entry.isDirectory()) {
        inspect(path);
      } else {
        assert.ok(entry.isFile(), "The preview bundle must contain regular files and directories.");
        assert.ok(entry.size <= maxFileBytes, `The preview asset ${name} exceeds 25 MiB.`);
        assert.ok(++files <= maxFiles - 2, "The preview bundle exceeds Cloudflare Pages Free's file limit.");
      }
    }
  }
  inspect(directory);
  const manifest = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
  assert.equal(manifest.frontendCommit, frontendCommit);
  assert.equal(manifest.cloudCommit, cloudCommit);
  for (const entry of ["index.html", "auth.html"]) {
    assert.match(readFileSync(join(directory, entry), "utf8"), /^<!doctype html/i);
  }
  writeFileSync(join(directory, "_headers"), `/*\n  Cache-Control: no-store\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: ${csp}\n`, { flag: "wx" });
  writeFileSync(join(directory, "healthz"), "ok\n", { flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preparePagesPreview(process.argv[2], process.env.PAIGE_PREVIEW_HEAD, process.env.GITHUB_SHA);
}
