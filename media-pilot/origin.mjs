import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, open, rename, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

const sharedKey = process.env.PAIGE_MEDIA_ORIGIN_KEY;
if (!/^[a-f0-9]{64}$/.test(sharedKey ?? "")) throw new Error("The media origin key is required.");
await access("/recordings", constants.W_OK);
const auth = Buffer.from("Bearer " + sharedKey);
const replayFile = "/recordings/replay.mp4";
const attemptFile = "/recordings/publish.started";
const hlsPath = /^\/hls\/([A-Za-z0-9_-]{1,120}\.(?:m3u8|mp4|m4s|ts))$/;
const media = spawn("mediamtx", ["mediamtx.yml"], { stdio: ["ignore", "inherit", "inherit"] });
let publisher;
let finalizing = false;
let failed = false;
const request = (url, timeout = 3500) => fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeout) });

const has = async (path) => stat(path).then((entry) => entry.isFile() && entry.size > 0, () => false);

function send(response, status, body = "", type = "text/plain; charset=utf-8") {
  response.writeHead(status, { "Cache-Control": "private, no-store", "Content-Type": type, "X-Content-Type-Options": "nosniff" });
  response.end(body);
}

async function replaySource() {
  const r = await request("http://127.0.0.1:9996/list?path=pilot");
  if (!r.ok) return undefined;
  const rows = await r.json();
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((item) => typeof item.start === "string" && Number.isFinite(Date.parse(item.start)) &&
    Number.isFinite(item.duration) && item.duration >= 73 && item.duration <= 80);
  if (!row) return undefined;
  const query = new URLSearchParams({ path: "pilot", start: row.start, duration: String(row.duration), format: "mp4" });
  return "http://127.0.0.1:9996/get?" + query;
}

async function finishReplay() {
  finalizing = true;
  const temp = replayFile + ".pending";
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const source = await replaySource().catch(() => undefined);
      if (!source) { await delay(1000); continue; }
      const response = await request(source, 15000);
      if (!response.ok || !response.body) throw new Error("Recording export failed.");
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { mode: 0o600 }));
      if (!(await has(temp))) throw new Error("Recording export was empty.");
      await rename(temp, replayFile);
      return;
    }
    throw new Error("No completed recording found.");
  } catch {
    failed = true;
    await unlink(temp).catch(() => {});
  } finally {
    finalizing = false;
  }
}

async function state() {
  if (await has(replayFile)) return "replay";
  if (publisher) {
    try {
      const r = await request("http://127.0.0.1:9997/v3/paths/get/pilot");
      if (r.ok && (await r.json()).ready === true) {
        const manifest = await request("http://127.0.0.1:8888/pilot/index.m3u8");
        await manifest.body?.cancel();
        if (manifest.ok) return "live";
      }
    } catch {
      return "starting";
    }
    return "starting";
  }
  if (finalizing) return "processing";
  return failed || await has(attemptFile) ? "unavailable" : "waiting";
}

async function start(response) {
  let marker;
  try {
    marker = await open(attemptFile, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    send(response, 409, "This pilot has already started.");
    return;
  }
  try { await marker.writeFile(new Date().toISOString()); } finally { await marker.close(); }
  publisher = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15",
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-t", "75",
    "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30",
    "-b:v", "600k", "-maxrate", "750k", "-bufsize", "1300k", "-c:a", "aac", "-b:a", "48k",
    "-f", "rtsp", "-rtsp_transport", "tcp", "rtsp://127.0.0.1:8554/pilot",
  ], { stdio: ["ignore", "ignore", "inherit"] });
  publisher.once("error", () => { publisher = undefined; failed = true; });
  publisher.once("exit", (code) => {
    publisher = undefined;
    if (code === 0) void finishReplay();
    else failed = true;
  });
  send(response, 202, "Broadcast starting.");
}

async function replay(request, response) {
  const entry = await stat(replayFile).catch(() => undefined);
  if (!entry?.isFile() || !entry.size) { send(response, 404); return; }
  const total = entry.size;
  const headers = { "Content-Type": "video/mp4", "Cache-Control": "private, no-store", "Accept-Ranges": "bytes" };
  let first = 0;
  let last = total - 1;
  if (request.headers.range) {
    const match = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(request.headers.range);
    if (match) {
      first = Number(match[1]);
      last = match[2] ? Math.min(last, Number(match[2])) : last;
    }
    if (!match || first > last) {
      response.writeHead(416, { ...headers, "Content-Range": "bytes */" + total });
      response.end();
      return;
    }
    headers["Content-Range"] = "bytes " + first + "-" + last + "/" + total;
  }
  response.writeHead(request.headers.range ? 206 : 200, { ...headers, "Content-Length": last - first + 1 });
  await pipeline(createReadStream(replayFile, { start: first, end: last }), response);
}

async function handle(incoming, response) {
  if (incoming.method === "GET" && incoming.url === "/healthz") {
    const r = await request("http://127.0.0.1:9997/v3/paths/list");
    send(response, r.ok ? 200 : 503, r.ok ? "ok" : "");
    return;
  }
  const header = Buffer.from(incoming.headers.authorization ?? "");
  if (header.length !== auth.length || !timingSafeEqual(header, auth)) { send(response, 401); return; }
  if (incoming.method === "POST" && incoming.url === "/start") { await start(response); return; }
  if (incoming.method !== "GET") { send(response, 404); return; }
  if (incoming.url === "/state") {
    send(response, 200, JSON.stringify({ state: await state() }), "application/json");
    return;
  }
  if (incoming.url === "/replay.mp4") { await replay(incoming, response); return; }
  const hls = hlsPath.exec(incoming.url);
  if (!hls) { send(response, 404); return; }
  const r = await request("http://127.0.0.1:8888/pilot/" + hls[1], 6500);
  if (!r.ok || !r.body) { send(response, r.ok ? 503 : r.status); return; }
  response.writeHead(200, {
    "Content-Type": hls[1].endsWith(".m3u8") ? "application/vnd.apple.mpegurl"
      : hls[1].endsWith(".ts") ? "video/mp2t" : "video/mp4",
    "Cache-Control": "private, no-store",
  });
  await pipeline(Readable.fromWeb(r.body), response);
}

const server = createServer({ headersTimeout: 5000, maxHeaderSize: 8192 }, (request, response) => {
  handle(request, response).catch(() => {
    if (!response.headersSent) send(response, 503);
    else response.destroy();
  });
});
media.once("error", () => process.exit(1));
media.once("exit", () => process.exit(1));
if (await has(attemptFile) && !(await has(replayFile))) void finishReplay();
server.listen(8080, "0.0.0.0");
