import { escape, shell } from "./project-console.mjs";
import { ownerId } from "./projects.mjs";

const uid = /^[a-f0-9]{32}$/;
const playbackHost = /^customer-[a-z0-9-]+\.cloudflarestream\.com$/;
const signedToken = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function createStreamProvider({ account, token, host }, request = fetch) {
  if (!uid.test(account ?? "") || !/^[\x21-\x7e]{16,512}$/.test(token ?? "") ||
      !playbackHost.test(host ?? "")) return undefined;
  const playerOrigin = "https://" + host;
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + account + "/stream";
  async function read(path, payload) {
    const headers = { Authorization: "Bearer " + token };
    const options = { headers, signal: AbortSignal.timeout(4500), redirect: "error" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      options.method = "POST";
      options.body = JSON.stringify(payload);
    }
    const response = await request(endpoint + path, options);
    if (!response.ok) throw new Error("Stream request failed.");
    const body = await response.json();
    if (!body.success) throw new Error("Stream response could not be verified.");
    return body.result;
  }
  const videos = async (input) => {
    const result = await read("/live_inputs/" + input + "/videos");
    if (!Array.isArray(result)) throw new Error("Stream recordings are unavailable.");
    return result;
  };
  return {
    playerOrigin,
    async canRegister(input) {
      if (!uid.test(input)) return false;
      const result = await read("/live_inputs/" + input);
      if (result?.uid !== input || result.enabled === false || result.recording?.mode !== "automatic" ||
          result.recording.requireSignedURLs !== true) return false;
      return (await videos(input)).length === 0;
    },
    async firstVideo(input, registeredAt) {
      if (!uid.test(input)) throw new Error("Invalid Stream input.");
      // The registration is for a fresh input. Select its first new video even if it has since received more broadcasts.
      return (await videos(input)).filter((video) => uid.test(video?.uid ?? "") && Date.parse(video.created) >= registeredAt - 1000)
        .sort((a, b) => Date.parse(a.created) - Date.parse(b.created) || a.uid.localeCompare(b.uid))[0]?.uid;
    },
    async watch(id, sessionExpiresAt) {
      if (!uid.test(id)) throw new Error("Invalid Stream video ID.");
      const video = await read("/" + id);
      if (video?.uid !== id || video.requireSignedURLs !== true) return { state: "unavailable" };
      const state = video.status?.state === "live-inprogress" ? "live"
        : video.status?.state === "ready" && video.readyToStream === true ? "replay"
          : video.status?.state === "error" ? "unavailable" : "processing";
      if (state !== "live" && state !== "replay") return { state };
      const exp = Math.floor(sessionExpiresAt / 1000);
      if (!Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return { state: "unavailable" };
      const signed = (await read("/" + id + "/token", { exp }))?.token;
      if (typeof signed !== "string" || signed.length > 4096 || !signedToken.test(signed)) {
        throw new Error("Stream playback token could not be verified.");
      }
      return { state, url: playerOrigin + "/" + signed + "/iframe" };
    },
  };
}

const labels = {
  waiting: ["Waiting for broadcast", "Start streaming from OBS, then refresh this page."],
  processing: ["Preparing replay", "Refresh to check whether the replay is ready."],
  unavailable: ["Playback unavailable", "Refresh to check the stream again."],
  live: ["Live", ""],
  replay: ["Replay", ""],
};

export async function mediaPage({ route, form, method, principal, catalog, stream, showDeployments,
  sessionExpiresAt, accountPath, sessionCurrent }) {
  const scope = { organizationId: route.organizationId, projectId: route.projectId };
  const project = catalog.get(scope);
  const allowed = () => sessionCurrent() && catalog.hasProjectRead(principal, scope.organizationId, scope.projectId);
  const denied = { status: 404 };
  if (!project || project.archived || !allowed()) return denied;

  const projectPath = "/projects/" + scope.organizationId + "/" + scope.projectId;
  const path = accountPath + projectPath;
  const home = path + "/media";
  const breadcrumb = '<p class="muted"><a href="' + path + '">' + escape(project.name) + '</a> / <a href="' + home + '">Media</a></p>';
  const page = (title, body, status = 200, playerOrigin) => ({
    status, playerOrigin, html: shell(title, breadcrumb + body, showDeployments,
      Math.max(0, sessionExpiresAt - Date.now()), accountPath, "media"),
  });
  const error = (message, status = 400) => page("Media", '<p class="notice bad" role="alert">' + message +
    '</p><p><a href="' + home + '">Back to Media</a></p>', status);

  if (method === "POST") {
    if (principal !== ownerId || route.streamId) return denied;
    if (!stream) return error("Cloudflare Stream needs to be configured.", 503);
    const title = form?.get("title")?.trim() ?? "";
    const input = form?.get("input")?.trim() ?? "";
    if (form?.size !== 2 || !title || title.length > 80 || !uid.test(input)) {
      return error("Enter a title and the Cloudflare live input ID.");
    }
    let privateInput;
    try {
      privateInput = await stream.canRegister(input);
    } catch {
      return error("Cloudflare could not verify this input. Check its ID and try again.", 502);
    }
    if (!allowed()) return denied;
    if (!privateInput) return error("Use a fresh Cloudflare live input with automatic recording and signed playback enabled.");
    const id = catalog.registerStream(scope, title, input);
    return id ? { status: 303, location: home + "/" + id }
      : error("This live input is already registered.", 409);
  }

  if (!route.streamId) {
    const events = catalog.streams(scope);
    const rows = events.map((event) => '<li><a href="' + home + "/" + event.id + '">' + escape(event.title) +
      '</a><time datetime="' + new Date(event.createdAt).toISOString() + '">' +
      new Date(event.createdAt).toISOString().slice(0, 10) + '</time></li>').join("");
    const list = '<section class="project-panel"><h2>Livestreams and replays</h2>' +
      (rows ? '<ul class="project-list">' + rows + '</ul>' : '<p class="muted">No broadcasts are registered for this project.</p>') + '</section>';
    const setup = principal === ownerId && stream ? '<section class="project-panel"><h2>Add a livestream</h2>' +
      '<p class="muted">Create a fresh Cloudflare Stream live input for this event. Enable automatic recording and signed playback, then paste its input ID.</p>' +
      '<form method="post" action="' + home + '" class="project-form"><label for="stream-title">Event title</label>' +
      '<input id="stream-title" name="title" maxlength="80" required><label for="stream-input">Live input ID</label>' +
      '<input id="stream-input" name="input" maxlength="32" autocomplete="off" spellcheck="false" required>' +
      '<button class="primary" type="submit">Register livestream</button></form></section>'
      : principal === ownerId ? '<p class="notice">Connect a Cloudflare Stream account to register a livestream.</p>' : "";
    return page("Media", list + setup);
  }

  const event = catalog.stream(scope, route.streamId);
  if (!event) return denied;
  let playback = { state: "unavailable" };
  if (stream) {
    try {
      let id = event.videoId;
      if (!id) {
        const observed = await stream.firstVideo(event.liveInput, event.createdAt);
        if (!allowed()) return denied;
        if (observed) id = catalog.pinStreamVideo(scope, event.id, observed);
      }
      if (!allowed()) return denied;
      playback = id ? await stream.watch(id, sessionExpiresAt) : { state: "waiting" };
    } catch {
      playback = { state: "unavailable" };
    }
  }
  if (!allowed()) return denied;

  const [title, hint] = labels[playback.state] ?? labels.unavailable;
  const frame = playback.url ? '<iframe class="media-player" title="' + escape(event.title) + '" src="' + escape(playback.url) +
    '" referrerpolicy="no-referrer" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>' : "";
  const share = '<p><a href="' + projectPath + "/media/" + event.id + '">Member watch link</a> <span class="muted small">Share with signed-in project members.</span></p>';
  return page(event.title, '<section class="project-panel"><h2>' + title + '</h2>' +
    (hint ? '<p class="muted">' + hint + '</p>' : "") + frame +
    '<p><a href="' + home + "/" + event.id + '">Refresh stream</a></p>' + share + '</section>', 200,
    frame ? stream.playerOrigin : undefined);
}
