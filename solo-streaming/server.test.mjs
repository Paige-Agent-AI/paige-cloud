import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { createStreamAuthorization } from "./auth.mjs";
import { openStreamEvents } from "./events.mjs";
import { streamRecording } from "./media.mjs";
import { createStreamingApi, createEncoderAuth } from "./server.mjs";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  return "http://127.0.0.1:" + server.address().port;
}

test("two authorized Solo contexts cannot cross APIs, ingest, live media or replay", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const issuer = "https://auth.example.test";
  const resource = "https://cloud.example.test/v1/stream-events";
  const clientId = "paige-agent-ai";
  async function token(workspace, scope = "streams:host streams:read", claims = {}, typ = "at+jwt") {
    return new SignJWT({ scope, client_id: clientId, paige_workspace_id: workspace, ...claims })
      .setProtectedHeader({ alg: "RS256", typ }).setIssuer(issuer).setAudience(claims.aud ?? resource)
      .setSubject("test-actor").setJti("test-token").setIssuedAt().setExpirationTime(claims.expires ?? "2m").sign(privateKey);
  }
  const auth = createStreamAuthorization({ issuer, resource, clientId, resolveKey: publicKey });
  const directory = await mkdtemp(join(tmpdir(), "paige-streams-"));
  const db = join(directory, "events.sqlite");
  const replayFile = join(directory, "replay.mp4");
  await writeFile(replayFile, "0123456789");
  let events = openStreamEvents(db);
  t.after(() => { events.dispose(); return rm(directory, { recursive: true, force: true }); });
  const calls = [];
  const live = new Set();
  const recorded = new Set();
  const media = {
    healthy: async () => true,
    online: async (id) => live.has(id),
    recording: async (id) => recorded.has(id) ? { duration: 10 } : null,
    hls: async (id, file) => { calls.push(id + "/" + file); return new Response("#EXTM3U"); },
    replay: async (id, range) => { calls.push(id + "/replay"); return streamRecording(replayFile, range); },
  };
  const api = await listen(t, createStreamingApi({
    auth, events, media, encoderOrigin: "rtmps://stream.example.test:1936", allowWorkspaces: new Set(["solo-A", "solo-B"]),
  }));
  const privateApi = await listen(t, createEncoderAuth({ events }));
  const root = api + "/v1/stream-events";
  const a = await token("solo-A");
  const b = await token("solo-B");
  const viewer = await token("solo-A", "streams:read");
  const missing = await token("solo-other");
  function call(path, bearer, options = {}) {
    const headers = { ...options.headers };
    if (bearer) headers.Authorization = "Bearer " + bearer;
    return fetch(root + path, { ...options, headers });
  }
  const post = (path, bearer) => call(path, bearer, { method: "POST" });
  const create = (bearer, title) => call("", bearer, {
    method: "POST", body: JSON.stringify({ title, workspace: "forged-header-workspace" }),
    headers: { "content-type": "application/json", "idempotency-key": "same-key-across-each-solo" },
  });
  assert.equal((await call("", null)).status, 401);
  assert.equal((await call("", missing)).status, 403);
  assert.equal((await call("", await token("solo-A", undefined, { aud: "https://other.test" }))).status, 401);
  assert.equal((await call("", await token("solo-A", undefined, { client_id: "other" }))).status, 401);
  assert.equal((await call("", await token("solo-A", undefined, { expires: "0s" }))).status, 401);
  assert.equal((await call("", await token("solo-A", undefined, {}, "JWT"))).status, 401);
  const authHint = await fetch(api + "/.well-known/oauth-protected-resource/v1/stream-events");
  assert.deepEqual((await authHint.json()).authorization_servers, [issuer]);

  assert.equal((await create(viewer, "Viewer cannot create")).status, 403);
  const savedA = await create(a, "Alpha");
  assert.equal(savedA.status, 201);
  const A = await savedA.json();
  const savedB = await create(b, "Beta");
  assert.equal(savedB.status, 201);
  const B = await savedB.json();
  assert.notEqual(A.id, B.id);
  const retry = await create(a, "Alpha");
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).id, A.id);
  assert.equal((await create(a, "Other title")).status, 409);
  assert.deepEqual((await (await call("", a)).json()).events, [A]);
  assert.deepEqual((await (await call("", b)).json()).events, [B]);
  for (const [own, other, event] of [[a, b, A], [b, a, B]]) {
    const path = "/" + event.id;
    assert.equal((await call(path, own)).status, 200);
    assert.equal((await call(path, other)).status, 404);
    assert.equal((await call(path + "/hls/index.m3u8", other)).status, 404);
    assert.equal((await call(path + "/replay.mp4", other)).status, 404);
    assert.equal((await post(path + "/encoder", other)).status, 404);
    assert.equal((await post(path + "/finish", other)).status, 404);
  }
  assert.equal((await post("/" + A.id + "/encoder", viewer)).status, 403);
  const encoder = async (event, owner) => {
    const result = await post("/" + event.id + "/encoder", owner);
    assert.equal(result.status, 200);
    return result.json();
  };
  const staleA = await encoder(A, a);
  const encoderA = await encoder(A, a);
  const encoderB = await encoder(B, b);
  const authorize = (event, credential, connection, action = "publish") => fetch(privateApi + "/authorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, protocol: "rtmp", user: "solo", path: event.id, id: connection,
      password: new URLSearchParams(credential.streamKey.split("?")[1]).get("pass") }),
  });
  const conn1 = "06fe06ab-2a70-4dac-8714-7ddc589e8a9b";
  const conn2 = "3d463743-6b41-400b-bdd5-784aeb6dcf27";
  assert.equal((await authorize(A, staleA, conn1)).status, 403);
  assert.equal((await authorize(A, encoderB, conn1)).status, 403);
  assert.equal((await authorize(B, encoderA, conn2)).status, 403);
  assert.equal((await authorize(A, encoderA, conn1, "read")).status, 403);
  assert.equal((await authorize(A, encoderA, conn1)).status, 200);
  assert.equal((await authorize(A, encoderA, conn1)).status, 200);
  assert.equal((await authorize(A, encoderA, conn2)).status, 403);
  assert.equal((await authorize(B, encoderB, conn2)).status, 200);
  assert.equal((await post("/" + A.id + "/encoder", a)).status, 409);
  assert.equal((await authorize(A, encoderA, conn1)).status, 200);

  for (const [owner, other, event] of [[a, b, A], [b, a, B]]) {
    const path = "/" + event.id;
    live.add(event.id);
    assert.equal((await (await call(path, owner)).json()).state, "live");
    assert.equal(await (await call(path + "/hls/index.m3u8", owner)).text(), "#EXTM3U");
    assert.equal((await call(path + "/hls/index.m3u8", other)).status, 404);
    assert.equal((await post(path + "/finish", owner)).status, 409);
    live.delete(event.id);
    recorded.add(event.id);
    assert.equal((await post(path + "/finish", owner)).status, 200);
    const detail = await (await call(path, owner)).json();
    assert.equal(detail.state, "replay_ready");
    assert.equal(detail.duration, 10);
    const replay = await fetch(api + detail.replay, { headers: { authorization: "Bearer " + owner, range: "bytes=1-4" } });
    assert.equal(replay.status, 206);
    assert.equal(replay.headers.get("content-range"), "bytes 1-4/10");
    assert.equal(await replay.text(), "1234");
    assert.equal((await call(path + "/replay.mp4", other)).status, 404);
    assert.equal((await call(path + "/replay.mp4", owner, { headers: { range: "bytes=90-" } })).status, 416);
  }
  assert.equal((await authorize(A, encoderA, conn1)).status, 403);
  assert.deepEqual(calls, [A.id + "/index.m3u8", A.id + "/replay", A.id + "/replay",
    B.id + "/index.m3u8", B.id + "/replay", B.id + "/replay"]);
  const restarted = openStreamEvents(db);
  try {
    assert.equal(restarted.get("solo-A", A.id).title, "Alpha");
    assert.ok(restarted.get("solo-A", A.id).closed_at);
    assert.equal(restarted.get("solo-B", A.id), undefined);
    assert.equal(restarted.admit(A.id, conn1, new URLSearchParams(encoderA.streamKey.split("?")[1]).get("pass")), undefined);
  } finally { restarted.dispose(); }
});