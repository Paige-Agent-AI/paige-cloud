import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { createProofServer, makeHandler } from "./server.mjs";

const sha = "a".repeat(40);
const pem = readFileSync("C:/Users/tonig/AppData/Local/Temp/opencode/g1b-test-full.pem", "utf8");

test("makeHandler preserves the exact proof manifest contract", () => {
  const handler = makeHandler({ SOURCE_SHA: sha, PROOF_RELEASE: "A" });
  const health = { status: 0, body: "" };
  const res1 = { writeHead: (s) => { health.status = s; return res1; }, end: (b) => { health.body = b; } };
  handler({ url: "/healthz", method: "GET" }, res1);
  assert.equal(health.status, 200);
  assert.equal(health.body, "ok\n");
  const release = { status: 0, body: "" };
  const res2 = { writeHead: (s) => { release.status = s; return res2; }, end: (b) => { release.body = b; } };
  handler({ url: "/release.json", method: "GET" }, res2);
  assert.equal(release.status, 200);
  assert.deepEqual(JSON.parse(release.body), { schema: 1, sourceSha: sha, release: "A", hostingProof: "standalone" });
  const missing = { status: 0 };
  const res3 = { writeHead: (s) => { missing.status = s; return res3; }, end: () => {} };
  handler({ url: "/other", method: "GET" }, res3);
  assert.equal(missing.status, 404);
  const method = { status: 0 };
  const res4 = { writeHead: (s) => { method.status = s; return res4; }, end: () => {} };
  handler({ url: "/healthz", method: "POST" }, res4);
  assert.equal(method.status, 405);
  assert.throws(() => makeHandler({ SOURCE_SHA: "not-a-sha", PROOF_RELEASE: "A" }));
  assert.throws(() => makeHandler({ SOURCE_SHA: sha, PROOF_RELEASE: "C" }));
});

test("transport selection follows the explicit TLS secret without changing the manifest", () => {
  const tls = createProofServer({ SOURCE_SHA: sha, PROOF_RELEASE: "B", PROOF_TLS_PEM: pem, PORT: "443" });
  assert.equal(tls.tls, true);
  assert.equal(tls.port, 443);
  assert.equal(tls.server.constructor.name, "Server");
  assert.equal(tls.server instanceof Object, true);
  const plain = createProofServer({ SOURCE_SHA: sha, PROOF_RELEASE: "B", PORT: "8080" });
  assert.equal(plain.tls, false);
  assert.equal(plain.port, 8080);
  assert.equal(plain.server.constructor.name, "Server");
  assert.throws(() => createProofServer({ SOURCE_SHA: sha, PROOF_RELEASE: "B", PROOF_TLS_PEM: "missing-key" }), /must contain both/);
  assert.throws(() => createProofServer({ SOURCE_SHA: sha, PROOF_RELEASE: "B", PORT: "0" }));
});