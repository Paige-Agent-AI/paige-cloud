import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createSupabasePilot } from "./supabase.mjs";

const gateCookie = "__Host-paige-pilot-gate";
const sessionCookie = "__Host-paige-pilot-session";
const gateDuration = 30 * 60;
const sessionDuration = 15 * 60;
const idPattern = /^[A-Za-z0-9_-]{43}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const authPath = "/auth?mode=login";
const directoryPath = "/operator/fleet/directory";
const jsonType = "application/json; charset=utf-8";
const htmlType = "text/html; charset=utf-8";
const textType = "text/plain; charset=utf-8";
const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
};

const gate = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PAIGE Cloud evaluator access</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#140c27;color:#f8f5ee;font:16px system-ui}main{width:min(24rem,calc(100vw - 4rem));padding:1.5rem}label,input,button{display:block;margin-top:1rem}input,button{box-sizing:border-box;width:100%;padding:.75rem;border-radius:.5rem;font:inherit}input{color:inherit;background:#241645;border:1px solid #84739f}button{background:#f0c86a;color:#241645;border:0;font-weight:700}p{line-height:1.5}</style><main><h1>PAIGE Cloud</h1><p>Enter your evaluator access key to open PAIGE sign-in.</p><!--ERROR--><form method="post" action="/gate" autocomplete="off"><label for="key">Evaluator access key</label><input type="password" name="key" id="key" maxlength="43" required><button type="submit">Continue</button></form></main></html>`;

function send(response, status, type = textType, body = "", extra = {}) {
  response.writeHead(status, { ...headers, "Content-Type": type, ...extra });
  response.end(body);
}

function redirect(response, location, extra) {
  send(response, 303, textType, "", { Location: location, ...extra });
}

function cookies(request) {
  return new Map((request.headers.cookie || "").split(/;\s*/).map((field) => field.split("=")));
}

function cookie(name, value, age) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
}

function evaluatorToken(reply, evaluator) {
  const token = reply?.access_token;
  if (reply?.user?.id !== evaluator.id || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/.test(token ?? "")) return null;
  try {
    // This token came directly from Supabase over TLS. The protected read also
    // validates it with Auth. Require a session ID before any scope=local logout.
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return claims.sub === evaluator.id && claims.role === "authenticated" &&
      typeof claims.session_id === "string" && uuid.test(claims.session_id) &&
      claims.session_id !== "00000000-0000-0000-0000-000000000000" ? token : null;
  } catch {
    return null;
  }
}

async function readBody(request, type) {
  if (request.headers["content-type"]?.split(";")[0] !== type || Number(request.headers["content-length"]) > 8192) return null;
  const parts = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > 8192) return null;
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}

export function createPilotServer({ origin, keyHash, evaluator, backend, index, assets, release, now = Date.now }) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin) throw new Error("Pilot requires an exact HTTPS origin");
  if (!/^[a-f0-9]{64}$/.test(keyHash ?? "")) throw new Error("Pilot access key hash required");
  const operator = evaluator?.mode === "operator";
  const protectedPath = operator ? directoryPath : "/choose-account";
  if (evaluator && (!uuid.test(evaluator.id) || !/^[^\s@]+@[^\s@]+$/.test(evaluator.email) || !backend ||
      (operator ? evaluator.tenant || evaluator.role :
        (evaluator.mode != null || !uuid.test(evaluator.tenant) || !["member", "client", "viewer"].includes(evaluator.role))))) {
    throw new Error("Pilot requires one bound platform operator or one ordinary evaluator and workspace");
  }

  const expectedHash = Buffer.from(keyHash, "hex");
  const appHtml = evaluator ? String(index).replace('data-auth-ready="false"', 'data-auth-ready="true"') : index;
  const gates = new Map();
  let session;
  let authInProgress = false;

  async function handle(request, response) {
    const { method, url: path } = request;
    if (method === "GET" && path === "/healthz") return send(response, 200, textType, "ok\n");
    if (request.headers.host !== url.host || request.headers["x-forwarded-proto"] !== "https") return send(response, 421);
    if (method === "POST" && request.headers.origin !== origin) return send(response, 403);

    const jar = cookies(request);
    const gateId = jar.get(gateCookie);
    const gateExpires = gates.get(gateId) ?? 0;
    const hasGate = gateExpires > now();
    if (session?.expiresAt <= now() && !authInProgress) session = undefined;

    if (method === "POST" && path === "/gate") {
      const fields = new URLSearchParams(await readBody(request, "application/x-www-form-urlencoded") ?? "");
      const key = fields.size === 1 ? fields.get("key") ?? "" : "";
      const computedHash = createHash("sha256").update(key).digest();
      if (!timingSafeEqual(expectedHash, computedHash) || !idPattern.test(key)) {
        return send(response, 401, htmlType, gate.replace("<!--ERROR-->", '<p role="alert">Check the evaluator key and try again.</p>'));
      }
      for (const [id, expiry] of gates) if (expiry <= now()) gates.delete(id);
      if (hasGate) return redirect(response, authPath);
      if (gates.size >= 12) return send(response, 429);
      const id = randomBytes(32).toString("base64url");
      gates.set(id, now() + gateDuration * 1000);
      return redirect(response, authPath, { "Set-Cookie": cookie(gateCookie, id, gateDuration) });
    }

    if (!hasGate) {
      if (method === "GET" && ["/", "/auth", authPath, protectedPath].includes(path)) {
        return send(response, 401, htmlType, gate);
      }
      return send(response, 401);
    }
    const current = session?.gate === gateId && session?.id === jar.get(sessionCookie) && session?.expiresAt > now() ? session : null;

    if (method === "GET" && path === "/") return redirect(response, current ? protectedPath : authPath);
    if (method === "GET" && ["/auth", authPath, protectedPath].includes(path)) {
      if (path === protectedPath && !current) return redirect(response, authPath);
      if (path !== protectedPath && current) return redirect(response, protectedPath);
      return send(response, 200, htmlType, appHtml);
    }
    if (method === "GET" && path === "/release.json") return send(response, 200, jsonType, release);
    if (method === "GET" && assets.has(path)) {
      const [type, source] = assets.get(path);
      return send(response, 200, type, source);
    }

    if (method === "POST" && path === "/api/sign-in") {
      if (!evaluator) return send(response, 423);
      const body = await readBody(request, "application/json");
      let form;
      try { form = JSON.parse(body ?? "null"); } catch { return send(response, 400); }
      if (typeof form?.email !== "string" || form.email.trim().toLowerCase() !== evaluator.email ||
          typeof form.password !== "string" || form.password.length < 6 || form.password.length > 1024) return send(response, 401);
      if (gateExpires <= now()) return send(response, 401);
      if (authInProgress || session) return send(response, 409);
      authInProgress = true;
      let token;
      try {
        const signedIn = await backend.signIn(evaluator.email, form.password);
        if (!signedIn) return send(response, 401);
        token = evaluatorToken(signedIn, evaluator);
        if (!token || !Number.isInteger(signedIn.expires_in) || signedIn.expires_in <= 15) return send(response, 403);
        const expiresAt = Math.min(now() + Math.min(sessionDuration, signedIn.expires_in - 15) * 1000, gateExpires - 5000);
        if (!await backend.account(token, evaluator)) return send(response, 403);
        const lifetime = Math.floor((expiresAt - now()) / 1000);
        if (lifetime <= 0) return send(response, 401);

        const id = randomBytes(32).toString("base64url");
        session = { id, gate: gateId, token, expiresAt };
        return send(response, 204, textType, "", { "Set-Cookie": cookie(sessionCookie, id, lifetime), Location: protectedPath });
      } finally {
        try {
          if (!session && token) await backend.signOut(token);
        } finally {
          authInProgress = false;
        }
      }
    }

    if (method === "GET" && path === "/api/account") {
      if (!current) return send(response, 401);
      if (authInProgress) return send(response, 503);
      const data = await backend.account(current.token, evaluator);
      if (session !== current || current.expiresAt <= now()) return send(response, 401);
      if (authInProgress) return send(response, 503);
      return data ? send(response, 200, jsonType, JSON.stringify(data)) : send(response, 403);
    }
    if (method === "POST" && path === "/api/sign-out") {
      if (!current) return send(response, 401);
      if (authInProgress) return send(response, 409);
      authInProgress = true;
      try {
        if (!await backend.signOut(current.token)) return send(response, 502);
        session = undefined;
        return send(response, 204, textType, "", { "Set-Cookie": cookie(sessionCookie, "", 0) });
      } finally {
        authInProgress = false;
      }
    }
    return send(response, 404);
  }

  return createServer({ requestTimeout: 12000, headersTimeout: 6500, maxHeaderSize: 8192 }, (request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 503);
      else response.end();
    });
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const env = process.env;
  const dist = new URL("./dist/", import.meta.url);
  const assets = new Map(readdirSync(new URL("assets/", dist)).map((name) => {
    const type = name.endsWith(".css") ? "text/css" : name.endsWith(".js") ? "text/javascript" : "application/octet-stream";
    return [`/assets/${name}`, [type, readFileSync(new URL(`assets/${name}`, dist))]];
  }));
  const evaluator = env.PAIGE_PILOT_AUTH_READY === "true" ? {
    id: env.PAIGE_PILOT_USER_ID, email: env.PAIGE_PILOT_USER_EMAIL?.toLowerCase(),
    mode: env.PAIGE_PILOT_ACCESS_MODE,
    tenant: env.PAIGE_PILOT_TENANT_ID, role: env.PAIGE_PILOT_TENANT_ROLE,
  } : null;
  createPilotServer({
    origin: env.PAIGE_PILOT_ORIGIN, keyHash: env.PAIGE_PILOT_KEY_SHA256, evaluator,
    backend: evaluator && createSupabasePilot(env.PAIGE_SUPABASE_PUBLISHABLE_KEY, (event) => {
      console.log(JSON.stringify({ source: "supabase", ...event }));
    }),
    index: readFileSync(new URL("index.html", dist)), assets,
    release: readFileSync(new URL("./release.json", import.meta.url)),
  }).listen(8080, "0.0.0.0");
}
