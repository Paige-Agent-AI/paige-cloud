import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { pathToFileURL } from "node:url";

const validSha = /^[0-9a-f]{40}$/;
const validRelease = new Set(["A", "B"]);

// The handler is unchanged: it only answers /healthz and /release.json.
// TLS is a transport decision made by the caller, not a handler concern.
export function makeHandler({ SOURCE_SHA, PROOF_RELEASE }) {
  if (typeof SOURCE_SHA !== "string" || !validSha.test(SOURCE_SHA) ||
      !validRelease.has(PROOF_RELEASE)) throw new Error("Exact proof source and release required.");
  const manifest = JSON.stringify({ schema: 1, sourceSha: SOURCE_SHA, release: PROOF_RELEASE, hostingProof: "standalone" });
  return (req, res) => {
    const responses = {
      "/healthz": ["text/plain", "ok\n"],
      "/release.json": ["application/json", manifest],
    };
    const known = Object.hasOwn(responses, req.url);
    const [type, body] = known ? responses[req.url] : ["text/plain", "Not found\n"];
    const headers = { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (req.method !== "GET") {
      res.writeHead(405, { ...headers, allow: "GET" }).end();
      return;
    }
    res.writeHead(known ? 200 : 404, headers).end(body);
  };
}

// Transport selection is explicit: HTTPS when a PEM is supplied, HTTP otherwise.
// The PEM must contain both a certificate and private key; the caller provides it
// through an approved secret mechanism, never through the image.
export function createProofServer(env = process.env) {
  const { SOURCE_SHA, PROOF_RELEASE, PROOF_TLS_PEM, PORT } = env;
  const handler = makeHandler({ SOURCE_SHA, PROOF_RELEASE });
  let port = PROOF_TLS_PEM ? 443 : 8080;
  if (PORT !== undefined) {
    const parsed = Number(PORT);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("Invalid port");
    port = parsed;
  }
  if (PROOF_TLS_PEM) {
    const pem = String(PROOF_TLS_PEM);
    if (!pem.includes("BEGIN CERTIFICATE") || !pem.includes("PRIVATE KEY")) {
      throw new Error("PROOF_TLS_PEM must contain both a certificate and private key");
    }
    return { server: createHttpsServer({ cert: pem, key: pem }, handler), port, tls: true };
  }
  return { server: createServer({ requestTimeout: 5000, headersTimeout: 4000 }, handler), port, tls: false };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { server, port, tls } = createProofServer(process.env);
  server.listen(port, "0.0.0.0", () => {
    console.log(`listening on ${tls ? "https" : "http"}://0.0.0.0:${port}`);
  });
}
