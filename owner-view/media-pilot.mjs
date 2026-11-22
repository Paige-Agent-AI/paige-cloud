import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { shell } from "./project-console.mjs";
import { firstProject, ownerId } from "./projects.mjs";

export const pilotPath = "/projects/paige/paige-agent-ai/media/pilot";
const endpoints = new Set(["", "/state", "/start", "/replay.mp4"]);
const hlsPath = /^\/hls\/[A-Za-z0-9_-]{1,120}\.(?:m3u8|mp4|m4s|ts)$/;
const mediaTypes = new Set(["application/vnd.apple.mpegurl", "video/mp4", "video/mp2t"]);

export function matchPilotPage(path) {
  if (typeof path !== "string" || !path.startsWith(pilotPath)) return undefined;
  const suffix = path.slice(pilotPath.length);
  return endpoints.has(suffix) || hlsPath.test(suffix) ? { suffix } : undefined;
}

export function createMediaPilot({ origin, key }, request = fetch) {
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(origin ?? "") ||
      !/^[a-f0-9]{64}$/.test(key ?? "")) return undefined;
  const read = (suffix, method, range) => {
    const headers = { Authorization: "Bearer " + key };
    if (range && /^bytes=\d{1,15}-\d{0,15}$/.test(range)) headers.Range = range;
    return request(origin + suffix, { headers, method, redirect: "error", signal: AbortSignal.timeout(12000) });
  };
  return { read };
}

const types = {
  plain: "text/plain; charset=utf-8", html: "text/html; charset=utf-8", json: "application/json; charset=utf-8",
};

export async function handleMediaPilot({ pilot, route, request, response, send, accountPath, requestOrigin,
  principal, catalog, sessionCurrent, sessionExpiresAt, headers }) {
  const sendText = (status, text = "", extra = {}) => send(response, status, types.plain, text, extra);
  const allowed = () => sessionCurrent() &&
    catalog.hasProjectRead(principal, firstProject.organizationId, firstProject.projectId);
  if (!pilot || !allowed()) { sendText(404, "Not found"); return; }
  const path = accountPath + pilotPath;
  const suffix = route.suffix;

  if (request.method === "POST") {
    if (suffix !== "/start" || principal !== ownerId) { sendText(404, "Not found"); return; }
    if (request.headers.origin !== requestOrigin) { sendText(403, "Origin denied"); return; }
    const upstream = await pilot.read("/start", "POST");
    await upstream.body?.cancel();
    if (!allowed()) { sendText(404, "Not found"); return; }
    if (upstream.status !== 202 && upstream.status !== 409) { sendText(503, "Broadcast could not start."); return; }
    sendText(303, "", { Location: path });
    return;
  }

  if (suffix === "") {
    const body = '<p class="muted"><a href="' + accountPath + '/projects/paige/paige-agent-ai/media">Media</a></p>' +
      '<section class="project-panel" data-media-pilot="' + path + '">' +
      '<h2 id="pilot-state" role="status">Checking broadcast status…</h2>' +
      '<video id="pilot-video" class="media-player" controls muted playsinline hidden></video>' +
      (principal === ownerId ? '<form id="pilot-start" action="' + path + '/start" method="post" hidden>' +
        '<button type="submit" class="primary">Start 75-second test broadcast</button></form>' : '') +
      '<p><a href="' + pilotPath + '">Member watch link</a></p></section>' +
      '<script src="/assets/hls.min.js" defer></script><script src="/assets/pilot-player.js" defer></script>';
    send(response, 200, types.html, shell("Private streaming pilot", body, true,
      Math.max(0, sessionExpiresAt - Date.now()), accountPath, "media"),
    { "Content-Security-Policy": headers["Content-Security-Policy"] + "; media-src 'self' blob:" });
    return;
  }

  if (suffix === "/start") { sendText(404, "Not found"); return; }
  const upstream = await pilot.read(suffix, "GET", request.headers.range);
  if (!allowed()) { await upstream.body?.cancel(); sendText(404, "Not found"); return; }
  if (suffix === "/state") {
    const state = upstream.ok ? (await upstream.json()).state : "unavailable";
    if (!allowed()) { sendText(404, "Not found"); return; }
    send(response, 200, types.json, JSON.stringify({
      state: ["waiting", "starting", "live", "processing", "replay"].includes(state) ? state : "unavailable",
    }));
    return;
  }

  const type = upstream.headers.get("content-type");
  if (!upstream.ok || !upstream.body || !mediaTypes.has(type)) {
    await upstream.body?.cancel();
    sendText(upstream.status === 416 ? 416 : 404);
    return;
  }
  const safeHeaders = { ...headers, "Content-Type": type };
  for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const value = upstream.headers.get(name);
    if (value) safeHeaders[name] = value;
  }
  response.writeHead(upstream.status === 206 ? 206 : 200, safeHeaders);
  await pipeline(Readable.fromWeb(upstream.body), response);
}
