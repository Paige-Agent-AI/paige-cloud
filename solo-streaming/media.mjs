import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

export const assetName = /^[a-zA-Z0-9_-]{1,120}\.(?:m3u8|mp4|ts)$/;
const recordingName = /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{6}_[+-][0-9]{4}\.mp4$/;
const api = "http://127.0.0.1:9997";
const playback = "http://127.0.0.1:9996";

export async function streamRecording(path, range) {
  const { size } = await stat(path);
  if (!size) return null;
  const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": "bytes */" + size } });
    }
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else {
      start = Math.max(0, size - Number(match[2]));
    }
    if (end < start) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": "bytes */" + size } });
    }
    headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
  }
  headers["Content-Length"] = String(end - start + 1);
  return new Response(Readable.toWeb(createReadStream(path, { start, end })), { status: range ? 206 : 200, headers });
}

export function createMediaReader(hlsKey, recordings = "/recordings") {
  async function request(url, options = {}) {
    return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(10000) });
  }

  async function online(id) {
    const result = await request(api + "/v3/paths/get/" + id);
    if (result.status === 404) return false;
    if (!result.ok) throw new Error("Media status unavailable");
    return (await result.json()).online === true;
  }

  async function recording(id) {
    const result = await request(playback + "/list?" + new URLSearchParams({ path: id }));
    if (result.status === 404) return null;
    if (!result.ok) throw new Error("Recording status unavailable");
    const rows = await result.json();
    const row = Array.isArray(rows) && rows.length === 1 && rows[0];
    if (!row || !Number.isFinite(row.duration) || row.duration <= 0 || row.duration > 1810) return null;
    const path = join(recordings, id);
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((file) => file.isFile() && recordingName.test(file.name));
    return files.length === 1 ? { path: join(path, files[0].name), duration: row.duration } : null;
  }

  return {
    async healthy() {
      const result = await request(api + "/v3/paths/list");
      return result.ok;
    },
    online,
    recording,
    hls(id, file) {
      return request("http://127.0.0.1:8888/" + id + "/" + file, { headers: { Authorization: "Bearer " + hlsKey } });
    },
    async replay(id, range) {
      const row = await recording(id);
      return row && streamRecording(row.path, range);
    },
  };
}