import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readScope, hostScope, protectedResource } from "./auth.mjs";
import { eventId } from "./events.mjs";
import { assetName } from "./media.mjs";
import { createStreamingMcp } from "./mcp.mjs";

const base = "/v1/stream-events";
const idempotencyKey = /^[a-zA-Z0-9_-]{16,96}$/;
const connectionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const header = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const scopes = [readScope, hostScope];

function send(res, status, data, extra = {}) {
  res.writeHead(status, {
    ...header, "Content-Type": "application/json; charset=utf-8", ...extra,
  });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}

async function body(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") return null;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

function http(handler) {
  return createServer({ maxHeaderSize: 12 * 1024, headersTimeout: 5000, requestTimeout: 10000 }, (req, res) => {
    handler(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else send(res, 503, { error: "service_unavailable" });
    });
  });
}

function summary(event) {
  return { id: event.id, title: event.title, createdAt: new Date(event.created_at).toISOString(), ended: !!event.closed_at };
}

async function describe(event, media, online) {
  const recorded = !online && event.closed_at && await media.recording(event.id);
  const state = online ? "live" : recorded ? "replay_ready" : event.closed_at ? "ended" :
    event.publisher ? "awaiting_finish" : "ready";
  return { ...summary(event), state, ...(recorded ? { duration: recorded.duration } : {}) };
}

function route(url) {
  if (url === base) return { action: "collection" };
  if (!url.startsWith(base + "/")) return null;
  const [id, leaf, asset, ...rest] = url.slice(base.length + 1).split("/");
  if (!eventId.test(id) || rest.length) return null;
  if (leaf === "hls" && asset && assetName.test(asset)) return { id, action: leaf, asset };
  if (asset === undefined && [undefined, "encoder", "finish", "replay.mp4"].includes(leaf)) {
    return { id, action: leaf ?? "detail" };
  }
  return null;
}

function method(action, requestMethod) {
  if (action === "collection") return ["GET", "POST"].includes(requestMethod);
  if (action === "encoder" || action === "finish") return requestMethod === "POST";
  return requestMethod === "GET";
}

async function mediaResponse(res, upstream, type) {
  if (upstream?.status === 416) {
    return send(res, 416, { error: "invalid_range" }, { "Content-Range": upstream.headers.get("content-range") });
  }
  if (!upstream?.ok || !upstream.body) {
    await upstream?.body?.cancel();
    send(res, upstream && upstream.status >= 500 ? 503 : 404, { error: "media_unavailable" });
    return;
  }
  const headers = { ...header, "Content-Type": type };
  for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  await pipeline(Readable.fromWeb(upstream.body), res);
}

export function createStreamingApi({ auth, events, media, encoderOrigin, allowWorkspaces, mcpAuth }) {
  const resource = protectedResource(auth, scopes);
  const mcp = mcpAuth && createStreamingMcp({ auth: mcpAuth, allowWorkspaces, streams: {
    list: (workspace) => events.list(workspace).map(summary),
    async get(workspace, id) {
      const row = events.get(workspace, id);
      if (!row) return null;
      return describe(row, media, !!row.publisher && await media.online(id));
    },
  } });

  return http(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      return send(res, (await media.healthy()) ? 200 : 503, { service: "paige-solo-streaming" });
    }
    if (req.method === "GET" && req.url === resource.path) return send(res, 200, resource.metadata);
    if (mcp && await mcp(req, res, { send, body })) return;
    const path = route(req.url);
    if (!path || !method(path.action, req.method)) return send(res, 404, { error: "not_found" });
    const principal = await auth.verify(req.headers.authorization);
    if (!principal) return send(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": resource.challenge() });
    const scope = req.method === "POST" ? hostScope : readScope;
    if (!allowWorkspaces.has(principal.workspace) || !principal.scopes.has(scope)) {
      return send(res, 403, { error: "insufficient_scope" }, { "WWW-Authenticate": resource.challenge(scope, "insufficient_scope") });
    }
    const workspace = principal.workspace;
    if (path.action === "collection") {
      if (req.method === "GET") return send(res, 200, { events: events.list(workspace).map(summary) });
      const input = await body(req);
      const title = typeof input?.title === "string" && input.title.trim();
      const key = req.headers["idempotency-key"];
      if (!title || title.length > 120 || /[\u0000-\u001f\u007f]/.test(title) ||
          typeof key !== "string" || !idempotencyKey.test(key)) {
        return send(res, 400, { error: "invalid_event" });
      }
      const created = events.create(workspace, key, title);
      if (created.error) return send(res, 409, { error: created.error });
      return send(res, created.created ? 201 : 200, summary(created.event));
    }

    const row = events.get(workspace, path.id);
    if (!row) return send(res, 404, { error: "not_found" });
    if (path.action === "encoder") {
      const result = events.encoder(workspace, path.id);
      if (!result) return send(res, 409, { error: "encoder_unavailable" });
      const query = new URLSearchParams({ user: "solo", pass: result.password });
      return send(res, 200, {
        server: encoderOrigin, streamKey: path.id + "?" + query, startsBy: new Date(result.expires).toISOString(),
      });
    }

    if (path.action === "hls") {
      if (!row.publisher || row.closed_at) return send(res, 404, { error: "media_unavailable" });
      const upstream = await media.hls(path.id, path.asset);
      const fresh = events.get(workspace, path.id);
      if (!fresh || fresh.closed_at) {
        await upstream.body?.cancel();
        return send(res, 404, { error: "media_unavailable" });
      }
      return mediaResponse(res, upstream, path.asset.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" :
        path.asset.endsWith(".ts") ? "video/mp2t" : "video/mp4");
    }

    const online = !!row.publisher && await media.online(path.id);
    if (path.action === "finish") {
      if (online) return send(res, 409, { error: "stop_obs_first" });
      if (row.publisher && Date.now() < row.stops_by && !(await media.recording(path.id))) {
        return send(res, 409, { error: "broadcast_settling" });
      }
      events.close(workspace, path.id);
      return send(res, 200, summary(events.get(workspace, path.id)));
    }
    if (path.action === "replay.mp4") {
      if (online || !row.closed_at) return send(res, 404, { error: "media_unavailable" });
      return mediaResponse(res, await media.replay(path.id, req.headers.range), "video/mp4");
    }
    const streamPath = base + "/" + path.id;
    const detail = await describe(row, media, online);
    return send(res, 200, {
      ...detail,
      ...(online ? { live: streamPath + "/hls/index.m3u8" } : {}),
      ...(detail.state === "replay_ready" ? { replay: streamPath + "/replay.mp4" } : {}),
    });
  });
}

export function createEncoderAuth({ events }) {
  // This server is only reachable from MediaMTX's container loopback.
  return http(async (req, res) => {
    if (req.url !== "/authorize" || req.method !== "POST") return send(res, 404);
    const input = await body(req);
    if (input?.action !== "publish" || input.protocol !== "rtmp" || input.user !== "solo" ||
        typeof input.path !== "string" || !eventId.test(input.path) ||
        typeof input.id !== "string" || !connectionId.test(input.id) ||
        typeof input.password !== "string" || !/^[a-f0-9]{64}$/.test(input.password)) return send(res, 403);
    const deadline = events.admit(input.path, input.id, input.password);
    return deadline ? send(res, 200, { expireAt: new Date(deadline).toISOString() }) : send(res, 403);
  });
}
