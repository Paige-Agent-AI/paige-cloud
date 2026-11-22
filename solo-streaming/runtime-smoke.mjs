import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const dir = await mkdtemp(join(tmpdir(), "paige-stream-"));
const cert = join(dir, "tls.crt");
const key = join(dir, "tls.key");
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), alg: "RS256", use: "sig", kid: "ci" };
const fixtures = ["verify-alpha", "verify-beta"];
const issuer = "https://127.0.0.1:8443";
const resource = "https://media.example.test/v1/stream-events";
const base = "http://127.0.0.1:8080";
const context = "/v1/stream-events";
const mount = "type=bind,source=" + dir + ",target=/tls,readonly";
const publisherProcesses = new Set();
let container;
let issuerServer;

const quiet = { stdio: "ignore" };

async function eventually(check, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await delay(400);
  }
  throw new Error(label);
}

async function access(workspace) {
  return new SignJWT({ client_id: "ci-paige-agent-ai", scope: "streams:read streams:host", paige_workspace_id: workspace })
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "ci" })
    .setIssuer(issuer).setAudience(resource).setSubject("ci").setJti(workspace).setIssuedAt()
    .setExpirationTime("3m").sign(privateKey);
}

function api(path, auth, options = {}) {
  const headers = { ...options.headers };
  if (auth) headers.Authorization = "Bearer " + auth;
  return fetch(base + path, { ...options, headers, signal: AbortSignal.timeout(5000) });
}

async function expect(response, status, label) {
  assert.equal((await response).status, status, label);
}

async function prepare(workspace) {
  const token = await access(workspace);
  const res = await api(context, token, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "runtime-smoke-key-0001" },
    body: JSON.stringify({ title: workspace }),
  });
  assert.equal(res.status, 201, "OAuth-authenticated event creation");
  const event = await res.json();
  const path = context + "/" + event.id;
  const keys = await api(path + "/encoder", token, { method: "POST" });
  assert.equal(keys.status, 200, "OBS key issue");
  const encoder = await keys.json();
  return { token, path, encoder, id: event.id };
}

function encode(owner, targetId, duration, color) {
  const path = owner.encoder.streamKey.replace(owner.id, targetId);
  const child = spawn("docker", ["run", "--rm", "--network", "host", "--cpus", "0.75", "--memory", "384m",
    "--entrypoint", "ffmpeg", "paige-solo-streaming",
    "-hide_banner", "-loglevel", "error", "-nostdin", "-filter_threads", "1", "-re", "-f", "lavfi", "-i",
    "color=" + color + ":s=320x180:r=15", "-re", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", String(duration), "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-f", "flv", owner.encoder.server + "/" + path,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  publisherProcesses.add(child);
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4096); });
  child.once("exit", () => publisherProcesses.delete(child));
  return once(child, "close").then(([code]) => {
    if (code !== 0 && targetId === owner.id) {
      const safe = diagnostics.replace(/rtmps?:\/\/\S+/gi, "[RTMPS URL]").replace(/[a-f0-9]{64}/gi, "[redacted]");
      console.log("Test encoder exit", code, safe.slice(-1000));
    }
    return code;
  });
}

async function checkHls(own) {
  const basePath = own.path + "/hls/";
  const res = await api(basePath + "index.m3u8", own.token);
  if (!res.ok) return false;
  const list = (await res.text()).split(/\r?\n/).find((line) => /^[a-zA-Z0-9_-]+\.m3u8$/.test(line));
  if (!list) return false;
  const media = await api(basePath + list, own.token);
  if (!media.ok) return false;
  const segment = (await media.text()).split(/\r?\n/).find((line) => /^[a-zA-Z0-9_-]+\.mp4$/.test(line));
  if (!segment) return false;
  const bytes = await api(basePath + segment, own.token);
  return bytes.ok && (await bytes.arrayBuffer()).byteLength > 400;
}

try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", key, "-out", cert], quiet);
  // The fixture directory and certificate must be readable by the container's non-root uid.
  execFileSync("chmod", ["755", dir], quiet);
  execFileSync("chmod", ["644", key, cert], quiet);
  issuerServer = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    if (req.url !== "/jwks") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  }).listen(8443, "127.0.0.1");
  await once(issuerServer, "listening");
  container = execFileSync("docker", ["run", "-d", "--network", "host", "--cpus", "1.5", "--memory", "512m",
    "--mount", mount, "-e", "NODE_EXTRA_CA_CERTS=/tls/tls.crt",
    "-e", "PAIGE_SOLO_OAUTH_ISSUER=" + issuer, "-e", "PAIGE_SOLO_OAUTH_JWKS_URL=" + issuer + "/jwks",
    "-e", "PAIGE_SOLO_OAUTH_RESOURCE=" + resource, "-e", "PAIGE_SOLO_OAUTH_CLIENT_ID=ci-paige-agent-ai",
    "-e", "PAIGE_SOLO_ENCODER_ORIGIN=rtmps://127.0.0.1:1936", "-e", "PAIGE_SOLO_WORKSPACES=" + fixtures.join(","),
    "paige-solo-streaming"], { encoding: "utf8" }).trim();
  await eventually(async () => (await api("/healthz")).ok, 20000, "MediaMTX never became ready");
  const [alpha, beta] = await Promise.all(fixtures.map(prepare));
  assert.notEqual(alpha.id, beta.id);
  for (const [own, other] of [[alpha, beta], [beta, alpha]]) {
    const list = await (await api(context, own.token)).json();
    assert.deepEqual(list.events.map((event) => event.id), [own.id]);
    await expect(api(other.path, own.token), 404, "cross-workspace event read");
    await expect(api(other.path + "/encoder", own.token, { method: "POST" }), 404, "cross-workspace key issuance");
    await expect(api(other.path + "/finish", own.token, { method: "POST" }), 404, "cross-workspace event finish");
    assert.notEqual(await encode(own, other.id, 3, "red"), 0, "wrong-event OBS key");
  }

  const active = Promise.all([encode(alpha, alpha.id, 25, "red"), encode(beta, beta.id, 25, "blue")]);
  await Promise.all([alpha, beta].map((event) => eventually(() => checkHls(event), 18000, "No live HLS segment")));
  for (const [own, other] of [[alpha, beta], [beta, alpha]]) {
    const detail = await (await api(own.path, own.token)).json();
    assert.equal(detail.state, "live");
    await expect(api(other.path + "/hls/index.m3u8", own.token), 404, "cross-workspace live watch");
    await expect(api(own.path + "/hls/index.m3u8"), 401, "anonymous live watch");
    await expect(api(own.path + "/finish", own.token, { method: "POST" }), 409, "in-progress stream");
  }
  console.log("Two concurrent RTMPS publishers produced isolated live HLS.");
  const exits = await active;
  for (const [own, other] of [[alpha, beta], [beta, alpha]]) {
    await eventually(async () => (await api(own.path + "/finish", own.token, { method: "POST" })).ok, 12000, "Recording did not settle");
    const detail = await (await api(own.path, own.token)).json();
    assert.equal(detail.state, "replay_ready");
    assert.ok(detail.duration >= 23 && detail.duration <= 26, "Incomplete recording: " + detail.duration);
    const file = await api(detail.replay, own.token, { headers: { range: "bytes=0-511" } });
    assert.equal(file.status, 206);
    assert.match(Buffer.from(await file.arrayBuffer()).toString("latin1"), /ftyp/);
    await expect(api(detail.replay, other.token), 404, "cross-workspace replay");
    await expect(api(detail.replay), 401, "anonymous replay");
  }
  assert.ok(exits.every((code) => code === 0 || code === 224), "Unexpected encoder interruption: " + exits.join(", "));
  console.log("Both private replays supported byte ranges; crossed credentials and media reads were denied.");
} finally {
  for (const child of publisherProcesses) child.kill();
  if (container) execFileSync("docker", ["rm", "-f", "-v", container], quiet);
  issuerServer?.close();
  await rm(dir, { recursive: true, force: true });
}
