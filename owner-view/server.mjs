import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createPaigeProjectAccess, ownerId, parseProjectStatusPath } from "./projects.mjs";

const readAsset = (file) => readFileSync(new URL("./public/" + file, import.meta.url));
const sessionName = "__Host-paige_owner";
const sessionLifetime = 30 * 60;
const cookieFields = "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=";
const maxBodyBytes = 256;
const headers = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
};
const html = "text/html; charset=utf-8";
const text = "text/plain; charset=utf-8";
const json = "application/json; charset=utf-8";

function send(response, status, type, body, extra = {}) {
  response.writeHead(status, { ...headers, "Content-Type": type, ...extra });
  response.end(body);
}

function sessionId(request) {
  return request.headers.cookie?.split(";").map((item) => item.trim())
    .map((item) => item.split("="))
    .find(([name, value]) => name === sessionName && /^[A-Za-z0-9_-]{43}$/.test(value ?? ""))?.[1];
}

async function readPassword(request) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded" ||
      Number(request.headers["content-length"]) > maxBodyBytes) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) return null;
    chunks.push(chunk);
  }
  const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if (body.size !== 1) return null;
  const password = body.get("password");
  return /^[A-Za-z0-9_-]{43}$/.test(password ?? "") ? password : null;
}

export function createOwnerServer({ origin, aliasOrigin, passwordHash, token, projectAccess, principalId = ownerId }) {
  const allowedOrigins = new Map();
  for (const value of aliasOrigin ? [origin, aliasOrigin] : [origin]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) throw new Error("Owner dashboard origins must be exact HTTPS origins.");
    allowedOrigins.set(url.host, url.origin);
  }
  if (!/^[a-f0-9]{64}$/.test(passwordHash ?? "")) throw new Error("A 32-byte owner password hash is required.");
  if (!projectAccess && !/^[\x21-\x7e]{16,512}$/.test(token ?? "")) throw new Error("A scoped Coolify read token is required.");
  const resolveRead = projectAccess ?? createPaigeProjectAccess(token);

  const expectedHash = Buffer.from(passwordHash, "hex");
  const login = readAsset("login.html").toString("utf8");
  const loginError = login.replace("<!-- LOGIN_ERROR -->",
    '<p class="notice bad" role="alert">That key did not match. Check it and try again.</p>');
  const owner = readAsset("owner.html");
  const css = readAsset("owner.css");
  const javascript = readAsset("owner.js");
  const sessions = new Map();
  const statusCache = new WeakMap();

  function getStatus(reader) {
    const entry = statusCache.get(reader) ?? { cachedAt: -Infinity };
    statusCache.set(reader, entry);
    if (Date.now() - entry.cachedAt < 3500) return Promise.resolve(entry.snapshot);
    entry.pending ??= Promise.resolve().then(reader.read).then((snapshot) => {
      entry.snapshot = snapshot;
      entry.cachedAt = Date.now();
      return snapshot;
    }).finally(() => { entry.pending = undefined; });
    return entry.pending;
  }

  async function handle(request, response) {
    const { method, url: path } = request;
    if (path === "/healthz" && method === "GET") {
      send(response, 200, text, "ok");
      return;
    }
    const requestOrigin = allowedOrigins.get(request.headers.host);
    if (!requestOrigin) {
      send(response, 421, text, "Unexpected host");
      return;
    }
    if (request.headers["x-forwarded-proto"] !== "https") {
      send(response, 308, text, "", { Location: requestOrigin + "/" });
      return;
    }
    if (method !== "GET" && method !== "POST") {
      send(response, 405, text, "Method not allowed", { Allow: "GET, POST" });
      return;
    }
    const id = sessionId(request);
    const now = Date.now();
    const session = sessions.get(id);
    const authorized = session?.origin === requestOrigin && session.expires > now;
    if (session && session.expires <= now) sessions.delete(id);
    if (method === "POST") {
      if (path !== "/session" && path !== "/sign-out") {
        send(response, 405, text, "Method not allowed", { Allow: "GET" });
        return;
      }
      if (request.headers.origin !== requestOrigin) {
        send(response, 403, text, "Origin denied");
        return;
      }
      if (path === "/sign-out") {
        if (authorized) sessions.delete(id);
        send(response, 303, text, "", { Location: "/", "Set-Cookie": sessionName + "=" + cookieFields + "0" });
        return;
      }
      const password = await readPassword(request);
      const hash = createHash("sha256").update(password ?? "").digest();
      if (!timingSafeEqual(expectedHash, hash) || !password) {
        send(response, 401, html, loginError);
        return;
      }
      if (authorized) sessions.delete(id);
      for (const [oldId, entry] of sessions) if (entry.expires <= now) sessions.delete(oldId);
      if (sessions.size >= 12) sessions.delete(sessions.keys().next().value);
      const created = randomBytes(32).toString("base64url");
      sessions.set(created, { principalId, origin: requestOrigin, expires: now + sessionLifetime * 1000 });
      send(response, 303, text, "", { Location: "/", "Set-Cookie": sessionName + "=" + created + cookieFields + sessionLifetime });
      return;
    }
    const scope = parseProjectStatusPath(path);
    if (path === "/") {
      send(response, 200, html, authorized ? owner : login);
    } else if (path === "/sign-in") {
      send(response, 200, html, login);
    } else if (path === "/assets/owner.css") {
      send(response, 200, "text/css; charset=utf-8", css);
    } else if (scope) {
      if (!authorized) {
        send(response, 401, json, '{"error":"Sign in required"}');
        return;
      }
      const reader = resolveRead(session.principalId, scope);
      if (!reader) {
        send(response, 404, json, '{"error":"Not found"}');
        return;
      }
      const snapshot = await getStatus(reader);
      if (sessions.get(id) !== session || session.expires <= Date.now()) {
        send(response, 401, json, '{"error":"Sign in required"}');
        return;
      }
      if (resolveRead(session.principalId, scope) !== reader) {
        send(response, 404, json, '{"error":"Not found"}');
        return;
      }
      send(response, 200, json, JSON.stringify(snapshot), {
        "X-Owner-Session-Expires-At": new Date(session.expires).toISOString(),
      });
    } else if (path === "/assets/owner.js" && authorized) {
      send(response, 200, "text/javascript; charset=utf-8", javascript);
    } else {
      send(response, 404, text, "Not found");
    }
  }

  return createServer({ requestTimeout: 12000, headersTimeout: 6500, maxHeaderSize: 8192 }, (request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 503, text, "Temporarily unavailable");
      else response.end();
    });
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createOwnerServer({
    origin: process.env.OWNER_VIEW_ORIGIN,
    aliasOrigin: process.env.OWNER_VIEW_ALIAS_ORIGIN,
    passwordHash: process.env.OWNER_VIEW_PASSWORD_SHA256,
    token: process.env.OWNER_VIEW_COOLIFY_TOKEN,
  }).listen(8080, "0.0.0.0", () => console.log("PAIGE Cloud owner view is ready"));
}
