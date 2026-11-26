import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { accountPath, normalizeEmail, openAccounts, validCode, validPassword } from "./accounts.mjs";
import { openProjectCatalog } from "./memberships.mjs";
import { matchProjectPage, projectPage } from "./project-console.mjs";
import { createStreamProvider, mediaPage } from "./media.mjs";
import { createMediaPilot, handleMediaPilot, matchPilotPage } from "./media-pilot.mjs";
import { createPaigeProjectAccess, firstProject, parseProjectStatusPath } from "./projects.mjs";
import { createPreviewDispatch, openGitHubBuilds } from "./github-builds.mjs";
import { createProductionHistory } from "./production-history.mjs";

const readAsset = (file) => readFileSync(new URL("./public/" + file, import.meta.url));
const sessionName = "__Host-paige_owner";
const sessionLifetime = 30 * 60;
const cookieFields = "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=";
const maxBodyBytes = 4096;
const accountNumberPattern = /^[1-9][0-9]{11}$/;
const accountRoutePattern = /^\/accounts\/([1-9][0-9]{11})(\/[^\r\n]*)?$/;
const dashboardPages = new Set(["/", "/overview", "/deployments", "/domains", "/activity"]);
const deploymentPage = /^\/deployments\/(?:release-[1-9]\d{0,19}-[1-9]\d{0,19}|history-[a-z0-9]{1,64}|pr-[1-9]\d{0,9}-[a-f0-9]{40}|live-[a-f0-9]{40})$/;
const releaseComparison = "/organizations/paige/projects/paige-agent-ai/environments/production/release-comparison";
const comparisonScope = { ...firstProject, environmentId: "production" };
const isDashboardPage = (path) => dashboardPages.has(path) || deploymentPage.test(path) || path === releaseComparison;
const buildEventsPath = "/api/organizations/paige/projects/paige-agent-ai/deployment-events";
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

async function readForm(request) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded" ||
      Number(request.headers["content-length"]) > maxBodyBytes) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) return null;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function throttle(maxAttempts, maxPerEmail, maxConcurrent) {
  const attempts = [];
  let active = 0;
  return async (email, run) => {
    const cutoff = Date.now() - 60_000;
    while (attempts.length && attempts[0].at <= cutoff) attempts.shift();
    if (active >= maxConcurrent || attempts.length >= maxAttempts ||
      attempts.filter((attempt) => attempt.email === email).length >= maxPerEmail) return null;
    attempts.push({ email, at: Date.now() });
    active++;
    try {
      return await run();
    } finally {
      active--;
    }
  };
}

export function createOwnerServer({ origin, aliasOrigin, additionalOrigins = [],
  passwordHash, accounts, catalog, stream, mediaPilot, hlsPlayer, githubBuilds, projectAccess: resolveRead }) {
  const allowedOrigins = new Map();
  for (const value of [origin, ...(aliasOrigin ? [aliasOrigin] : []), ...additionalOrigins]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) throw new Error("Owner dashboard origins must be exact HTTPS origins.");
    allowedOrigins.set(url.host, url.origin);
  }
  if (passwordHash && !/^[a-f0-9]{64}$/.test(passwordHash)) throw new Error("Invalid owner setup key hash.");
  if (!passwordHash && !accounts.hasOwner()) throw new Error("Owner setup requires the existing owner key hash.");
  if (typeof resolveRead !== "function") throw new Error("A Cloud project access provider is required.");

  const expectedHash = passwordHash ? Buffer.from(passwordHash, "hex") : null;
  const signInPage = readAsset("login.html").toString("utf8");
  const noProjects = readAsset("no-projects.html").toString("utf8");
  const owner = readAsset("owner.html").toString("utf8");
  const missionRelease = readAsset("mission-release.mjs");
  const css = readAsset("owner.css");
  const javascript = readAsset("owner.js");
  const pilotScript = readAsset("pilot-player.js");
  const projectSession = readAsset("project-session.js");
  const sessions = new Map();
  const limitSignIn = throttle(40, 8, 2);
  const limitOwnerSignIn = throttle(8, 8, 1);
  const limitSignUp = throttle(10, 4, 1);
  const limitSetup = throttle(5, 5, 1);
  const statusCache = new WeakMap();
  const eventStreams = new Map();

  function authPage(mode, status, message = "") {
    const signIn = mode === "/session";
    const setup = mode === "/setup";
    const enrolled = accounts.hasOwner();
    const title = signIn ? "Sign in to PAIGE Cloud" : setup ? "Set up owner sign-in" : "Create your PAIGE Cloud account";
    const action = signIn ? "Sign in" : setup ? "Set up account" : "Create account";
    const description = setup ? "Use your existing owner key once to set up your email and password."
      : signIn ? "" : "Use the email address and code from your invitation.";
    const links = signIn
      ? enrolled ? '<p>New to PAIGE Cloud? <a href="/signup">Create an account</a></p>'
        : '<p><a href="/setup">Set up your owner account</a></p>'
      : '<p><a href="/sign-in">Back to sign-in</a></p>';
    return signInPage.replaceAll("{{TITLE}}", title)
      .replace("{{ACTION}}", action)
      .replace("{{MODE}}", mode)
      .replace("{{DESCRIPTION}}", description ? `<p class="muted">${description}</p>` : "")
      .replace("{{MESSAGE}}", message ? `<p class="notice ${status >= 400 ? "bad" : ""}" role="${status >= 400 ? "alert" : "status"}">${message}</p>` : "")
      .replace("{{KEY_FIELD}}", setup
        ? '<label for="owner-key">Owner key</label><input type="password" id="owner-key" name="key" required autocomplete="off" maxlength="43" spellcheck="false">'
        : signIn ? ""
          : '<label for="invitation">Invitation code</label><input type="text" id="invitation" name="invite" required autocomplete="off" autocapitalize="none" maxlength="43" spellcheck="false">')
      .replace("{{PASSWORD_HINT}}", signIn ? "" : '<p id="password-hint" class="muted">Use at least 15 characters.</p>')
      .replace("{{PASSWORD_ATTRIBUTES}}", signIn ? 'autocomplete="current-password"'
        : 'autocomplete="new-password" minlength="15" aria-describedby="password-hint"')
      .replace("{{LINKS}}", links);
  }

  function startSession(response, principalId, requestOrigin, previousId) {
    const hasAccountNumbers = catalog && typeof accounts.ensureNumberFor === "function";
    const number = hasAccountNumbers ? accounts.ensureNumberFor(principalId) : undefined;
    if (hasAccountNumbers && !accountNumberPattern.test(number ?? "")) throw new Error("Missing Cloud account number.");
    const accountPath = number ? "/accounts/" + number : "";
    const now = Date.now();
    if (previousId) sessions.delete(previousId);
    const samePrincipal = [];
    for (const [id, session] of sessions) {
      if (session.expires <= now) sessions.delete(id);
      else if (session.principalId === principalId) samePrincipal.push(id);
    }
    if (samePrincipal.length >= 6) sessions.delete(samePrincipal[0]);
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { principalId, accountPath, number, origin: requestOrigin, expires: now + sessionLifetime * 1000 });
    const home = catalog?.customerHome(principalId);
    const location = home ? `/projects/${home.organizationId}/${home.projectId}`
      : resolveRead(principalId, firstProject) ? "/overview" : catalog ? "/projects" : "/";
    send(response, 303, text, "", { Location: accountPath + location, "Set-Cookie": sessionName + "=" + id + cookieFields + sessionLifetime });
  }

  function getStatus(reader) {
    const mainVersion = githubBuilds?.mainVersion();
    const entry = statusCache.get(reader) ?? { cachedAt: -Infinity };
    statusCache.set(reader, entry);
    if (entry.mainVersion === mainVersion && Date.now() - entry.cachedAt < 3500) return Promise.resolve(entry.snapshot);
    if (entry.pending && entry.pendingVersion !== mainVersion) return entry.pending.then(() => getStatus(reader));
    entry.pendingVersion = mainVersion;
    entry.pending ??= Promise.resolve().then(reader.read).then((snapshot) => {
      entry.snapshot = snapshot;
      entry.mainVersion = mainVersion;
      entry.cachedAt = Date.now();
      return snapshot;
    }).finally(() => { entry.pending = undefined; });
    return entry.pending;
  }

  function watchGitHubBuilds(id, session, response) {
    const count = eventStreams.get(id) ?? 0;
    if (count >= 3) { send(response, 429, text, "Too many event streams"); return; }
    eventStreams.set(id, count + 1);
    response.writeHead(200, { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
    function write(data) {
      try {
        if (sessions.get(id) === session && session.expires > Date.now() && resolveRead(session.principalId, firstProject) &&
            response.write(data)) return;
      } catch {
        // Close the stream if current access cannot be established.
      }
      response.end();
    }
    // Recheck grants on each event and while the stream is idle.
    const publish = (rows) => write(`event: builds\ndata: ${JSON.stringify({ rows: rows.slice(0, 20), mainVersion: githubBuilds.mainVersion(), now: Date.now() })}\n\n`);
    const unsubscribe = githubBuilds.subscribe(publish);
    const heartbeat = setInterval(() => write(": keepalive\n\n"), 15_000).unref();
    response.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      const remaining = (eventStreams.get(id) ?? 1) - 1;
      if (remaining) eventStreams.set(id, remaining);
      else eventStreams.delete(id);
    });
    publish(githubBuilds.snapshot());
  }

  async function handle(request, response) {
    const { method } = request;
    let path = request.url;
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
    if (path === "/hooks/github-builds" && githubBuilds) {
      if (method !== "POST") { send(response, 405, text, "Method not allowed", { Allow: "POST" }); return; }
      send(response, await githubBuilds.receive(request), text, "");
      return;
    }
    const id = sessionId(request);
    const now = Date.now();
    const session = sessions.get(id);
    const authorized = session?.origin === requestOrigin && session.expires > now;
    if (session && session.expires <= now) sessions.delete(id);
    const accountPath = authorized ? session.accountPath : "";
    const numbered = path === "/accounts" || path.startsWith("/accounts/");
    if (numbered) {
      const match = accountRoutePattern.exec(path);
      if (!match || match[0] !== path || (authorized && match[1] !== session.number)) {
        send(response, 404, text, "Not found");
        return;
      }
      path = match[2] ?? "/";
      if (!(isDashboardPage(path) || matchProjectPage(path) || matchPilotPage(path) || parseProjectStatusPath(path) || path === buildEventsPath)) {
        send(response, 404, text, "Not found");
        return;
      }
      if (!authorized) {
        const signIn = method === "GET" && !parseProjectStatusPath(path) && path !== buildEventsPath && (matchPilotPage(path)?.suffix ?? "") === "";
        send(response, signIn ? 303 : 401, text, "Sign in required", signIn ? { Location: "/sign-in" } : {});
        return;
      }
    }
    if (path === buildEventsPath) {
      if (!authorized) { send(response, 401, text, "Sign in required"); return; }
      if ((accountPath && !numbered) || !resolveRead(session.principalId, firstProject)) { send(response, 404, text, "Not found"); return; }
      if (method !== "GET") { send(response, 405, text, "Method not allowed", { Allow: "GET" }); return; }
      if (!githubBuilds) { send(response, 204, text, ""); return; }
      watchGitHubBuilds(id, session, response);
      return;
    }
    const projectRoute = catalog && matchProjectPage(path);
    const pilotRoute = catalog && matchPilotPage(path);
    if (accountPath && !numbered && (isDashboardPage(path) || projectRoute || pilotRoute)) {
      if (method !== "GET") {
        send(response, 404, text, "Not found");
        return;
      }
      const target = path === "/" ? (resolveRead(session.principalId, firstProject) ? "/overview" : "/projects") : path;
      send(response, 303, text, "", { Location: accountPath + target });
      return;
    }
    if (pilotRoute) {
      if (!authorized) {
        const signIn = method === "GET" && pilotRoute.suffix === "";
        send(response, signIn ? 303 : 401, text, "Sign in required", signIn ? { Location: "/sign-in" } : {});
        return;
      }
      const sessionCurrent = () => sessions.get(id) === session && session.expires > Date.now();
      await handleMediaPilot({ pilot: mediaPilot, route: pilotRoute, request, response, send, accountPath, requestOrigin,
        principal: session.principalId, catalog, sessionCurrent, sessionExpiresAt: session.expires, headers });
      return;
    }
    if (projectRoute) {
      if (!authorized) {
        send(response, method === "GET" ? 303 : 401, text, "Sign in required", method === "GET" ? { Location: "/sign-in" } : {});
        return;
      }
      if (method === "POST" && request.headers.origin !== requestOrigin) {
        send(response, 403, text, "Origin denied");
        return;
      }
      const form = method === "POST" ? await readForm(request) : undefined;
      if (sessions.get(id) !== session || session.expires <= Date.now()) {
        send(response, 401, text, "Sign in required");
        return;
      }
      const params = { route: projectRoute, form, method, principal: session.principalId,
        origin, catalog, accounts, showDeployments: !!resolveRead(session.principalId, firstProject),
        remaining: Math.max(0, session.expires - Date.now()), accountPath };
      const sessionCurrent = () => sessions.get(id) === session && session.expires > Date.now();
      const result = projectRoute.media ? await mediaPage({ ...params, stream, mediaPilot: !!mediaPilot, sessionCurrent, sessionExpiresAt: session.expires }) : projectPage(params);
      if (projectRoute.media && !sessionCurrent()) {
        send(response, 401, text, "Sign in required");
        return;
      }
      const extra = result.location ? { Location: result.location } : {};
      if (result.playerOrigin) extra["Content-Security-Policy"] = headers["Content-Security-Policy"] + "; frame-src " + result.playerOrigin;
      send(response, result.status, result.html ? html : text,
        result.html ?? (result.status === 404 ? "Not found" : ""), extra);
      return;
    }
    if (path === "/setup" && requestOrigin !== origin && method === "GET") {
      send(response, 303, text, "", { Location: origin + "/setup" });
      return;
    }
    if ((path === "/setup" && (requestOrigin !== origin || accounts.hasOwner() || !expectedHash)) ||
        (path === "/signup" && !accounts.hasOwner())) {
      send(response, 404, text, "Not found");
      return;
    }
    if (method === "POST") {
      if (!["/session", "/sign-out", "/signup", "/setup"].includes(path)) {
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
      const signIn = path === "/session";
      const setup = path === "/setup";
      const form = await readForm(request);
      const email = normalizeEmail(form?.get("email"));
      const password = form?.get("password");
      const code = form?.get(setup ? "key" : "invite");
      if (!email || !validPassword(password) || form?.size !== (signIn ? 2 : 3)) {
        const status = signIn ? 401 : 400;
        const message = signIn ? "Email or password is incorrect." : "Check the email and use a password of at least 15 characters.";
        send(response, status, html, authPage(path, status, message));
        return;
      }
      if (setup && (!validCode(code) || !timingSafeEqual(expectedHash, createHash("sha256").update(code).digest()))) {
        send(response, 401, html, authPage(path, 401, "Check your owner key and try again."));
        return;
      }
      if (setup && password === code) {
        send(response, 400, html, authPage(path, 400, "Choose a password that differs from your owner key."));
        return;
      }
      const signup = !signIn && !setup && validCode(code);
      const customerSignup = signup && catalog?.hasCustomerInvitation(email, code);
      const projectSignup = signup && !customerSignup && catalog?.hasInvitation(email, code);
      if (!signIn && !setup && (!signup || (!customerSignup && !projectSignup && !accounts.hasInvitation(email, code)))) {
        send(response, 400, html, authPage(path, 400, "Check your invitation code and email address."));
        return;
      }
      const limit = signIn ? (accounts.isOwnerEmail(email) ? limitOwnerSignIn : limitSignIn)
        : setup ? limitSetup : limitSignUp;
      const result = await limit(setup ? "owner" : email, () =>
        signIn ? accounts.verify(email, password) : accounts.create(email, password, {
          owner: setup, code, allowProjectSignup: projectSignup, allowCustomerSignup: customerSignup,
        }));
      if (result === null) {
        send(response, 429, html, authPage(path, 429, "Try again in a minute."), { "Retry-After": "60" });
      } else if (signIn && result) {
        startSession(response, result, requestOrigin, authorized ? id : undefined);
      } else if (signIn) {
        send(response, 401, html, authPage(path, 401, "Email or password is incorrect."));
      } else if (setup && !result) {
        send(response, 409, html, authPage("/session", 409, "Owner setup is already complete. Sign in with your email and password."));
      } else if (!result) {
        send(response, 409, html, authPage(path, 409, "This invitation could not be used. Ask your project owner for help."));
      } else {
        const location = setup ? "/sign-in?setup=complete" : customerSignup ? "/sign-in?signup=workspace" : "/sign-in?signup=complete";
        send(response, 303, text, "", { Location: location });
      }
      return;
    }
    const scope = parseProjectStatusPath(path);
    if (isDashboardPage(path)) {
      if (path === releaseComparison && (!authorized || !resolveRead(session.principalId, comparisonScope))) {
        send(response, authorized ? 404 : 303, text, authorized ? "Not found" : "",
          authorized ? {} : { Location: "/sign-in" });
        return;
      }
      if (authorized && catalog && !resolveRead(session.principalId, firstProject)) {
        send(response, 303, text, "", { Location: accountPath + "/projects" });
        return;
      }
      const page = !authorized ? authPage("/session", 200)
        : resolveRead(session.principalId, firstProject) ? owner.replaceAll("{{ACCOUNT_PATH}}", accountPath)
          : noProjects.replace("{{ACCOUNT_ID}}", session.principalId);
      send(response, 200, html, page);
    } else if (["/sign-in", "/session", "/sign-in?setup=complete", "/sign-in?signup=complete", "/sign-in?signup=workspace"].includes(path)) {
      const message = {
        "/sign-in?setup=complete": "Owner setup complete. Sign in with your email and password.",
        "/sign-in?signup=complete": "Sign in with the email and password you just set. For project invitations, choose Accept an invitation in Projects.",
        "/sign-in?signup=workspace": "Sign in with the email and password you just set to open your new workspace.",
      }[path] ?? "";
      send(response, 200, html, authPage("/session", 200, message));
    } else if (path === "/signup" || path === "/setup") {
      send(response, 200, html, authPage(path, 200));
    } else if (path === "/assets/owner.css") {
      send(response, 200, "text/css; charset=utf-8", css);
    } else if (authorized && mediaPilot && (path === "/assets/pilot-player.js" || path === "/assets/hls.min.js")) {
      send(response, 200, "text/javascript; charset=utf-8", path === "/assets/pilot-player.js" ? pilotScript : hlsPlayer);
    } else if (path === "/assets/project-session.js" && catalog && authorized) {
      send(response, 200, "text/javascript; charset=utf-8", projectSession);
    } else if (scope) {
      if (!authorized) {
        send(response, 401, json, '{"error":"Sign in required"}');
        return;
      }
      const reader = resolveRead(session.principalId, scope);
      if (!reader) {
        const project = scope.environmentId === undefined &&
          catalog?.hasProjectRead(session.principalId, scope.organizationId, scope.projectId) && catalog.get(scope);
        if (project) {
          send(response, 200, json, JSON.stringify({ project, deploymentsConnected: false }));
        } else {
          send(response, 404, json, '{"error":"Not found"}');
        }
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
    } else if ((path === "/assets/owner.js" || path === "/assets/mission-release.mjs") && authorized && resolveRead(session.principalId, firstProject)) {
      send(response, 200, "text/javascript; charset=utf-8", path === "/assets/owner.js" ? javascript : missionRelease);
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
  const membershipPath = process.env.OWNER_VIEW_MEMBERSHIP_DB;
  const store = openProjectCatalog(membershipPath);
  const accounts = openAccounts(accountPath(membershipPath), membershipPath);
  const githubBuilds = process.env.OWNER_VIEW_GITHUB_BUILD_WEBHOOK_SECRET && openGitHubBuilds(
    join(dirname(membershipPath), "github-builds.sqlite"), process.env.OWNER_VIEW_GITHUB_BUILD_WEBHOOK_SECRET, Date.now,
    createPreviewDispatch(process.env.OWNER_VIEW_PREVIEW_DISPATCH_TOKEN));
  const history = createProductionHistory({
    actionsToken: process.env.OWNER_VIEW_PRODUCTION_ACTIONS_TOKEN,
    coolifyToken: process.env.OWNER_VIEW_PRODUCTION_COOLIFY_TOKEN,
    filename: join(dirname(membershipPath), "production-history.sqlite"),
  });
  const server = createOwnerServer({
    origin: process.env.OWNER_VIEW_ORIGIN,
    aliasOrigin: process.env.OWNER_VIEW_ALIAS_ORIGIN,
    additionalOrigins: (process.env.OWNER_VIEW_ADDITIONAL_ORIGINS ?? "").split(",")
      .map((value) => value.trim()).filter(Boolean),
    passwordHash: process.env.OWNER_VIEW_PASSWORD_SHA256,
    accounts,
    catalog: store,
    githubBuilds,
    mediaPilot: createMediaPilot({ origin: process.env.OWNER_VIEW_MEDIA_PILOT_ORIGIN, key: process.env.OWNER_VIEW_MEDIA_PILOT_KEY }),
    hlsPlayer: process.env.OWNER_VIEW_MEDIA_PILOT_ORIGIN &&
      readFileSync(new URL("./node_modules/hls.js/dist/hls.min.js", import.meta.url)),
    stream: createStreamProvider({
      account: process.env.OWNER_VIEW_STREAM_ACCOUNT_ID,
      token: process.env.OWNER_VIEW_STREAM_TOKEN,
      host: process.env.OWNER_VIEW_STREAM_PLAYBACK_HOST,
    }),
    projectAccess: createPaigeProjectAccess(process.env.OWNER_VIEW_COOLIFY_TOKEN, store.hasProjectRead,
      process.env.OWNER_VIEW_PREVIEW_ACTIONS_TOKEN, githubBuilds?.mainVersion, history.read, {
        previewIp: process.env.PAIGE_PREVIEW_PUBLIC_IP,
        pagesProject: process.env.PAIGE_PREVIEW_PAGES_PROJECT,
      }),
  });
  server.once("close", () => {
    accounts.close();
    store.close();
    githubBuilds?.close();
    history.close();
  });
  server.listen(8080, "0.0.0.0", () => console.log("PAIGE Cloud owner view is ready"));
}
