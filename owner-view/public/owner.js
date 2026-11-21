"use strict";

const get = (id) => document.getElementById(id);
const view = get("deployment-view");
const refresh = get("refresh");
const announcement = get("announcement");
const pageTitle = get("page-title");
const navigation = document.querySelectorAll(".workspace-menu [data-section]");
const staleAfterMs = 120_000;
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", year: "numeric", hour: "numeric",
  minute: "2-digit", second: "2-digit", timeZoneName: "short",
});
const historyDateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
});
const healthLabels = {
  healthy: ["Healthy", "good"],
  unhealthy: ["Unhealthy", "bad"],
  unavailable: ["Unknown", "warn"],
};
const deploymentLabels = {
  finished: ["Finished", "good"],
  failed: ["Failed", "bad"],
  cancelled: ["Cancelled", "warn"],
  canceled: ["Cancelled", "warn"],
  queued: ["Queued", "warn"],
  in_progress: ["In progress", "warn"],
};
let snapshot = null;
let activeRequest = null;
let staleTimer;
let sessionTimer;
let sessionDeadline;
const sessionEvents = new BroadcastChannel("paige-owner-session");
let fetchFailed = false;
let renderedHistory;

function date(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function time(value, format = dateFormat) {
  const timestamp = date(value);
  if (!timestamp) return document.createTextNode("Time unavailable");
  const element = document.createElement("time");
  element.dateTime = timestamp.toISOString();
  element.textContent = format.format(timestamp);
  if (format !== dateFormat) element.title = dateFormat.format(timestamp);
  return element;
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function status(id, label, tone = "") {
  const node = get(id);
  node.textContent = label;
  node.className = tone ? "status " + tone : "status";
}

function setNotices(messages) {
  const notices = get("notices");
  notices.replaceChildren(...messages.map(([message, tone]) => element("p", "notice " + tone, message)));
  notices.hidden = messages.length === 0;
}

function setIdentity(kind, release, fallback) {
  const name = kind === "current" ? "release-name" : "rollback-name";
  get(name).textContent = release?.name || fallback;
  get(kind + "-identifiers").hidden = !release;
  get("commit-" + kind).textContent = release?.cloudCommit || "";
  get("frontend-" + kind).textContent = release?.frontendCommit || "";
  get("digest-" + kind).textContent = release?.imageDigest || "";
}

function buildRunLink(value) {
  if (typeof value !== "string") return null;
  const canonical = "https://github.com/Paige-Agent-AI/paige-cloud-preview/actions/runs/";
  const id = value.match(/^\d{1,24}$/)?.[0] ??
    value.match(/^https:\/\/github\.com\/paige-agent-ai\/paige-cloud-preview\/actions\/runs\/(\d{1,24})$/i)?.[1];
  if (!id) return null;
  const link = element("a", "", "Source build in GitHub");
  link.href = canonical + id;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.append(element("span", "sr", " (new tab)"));
  return link;
}

function deploymentRow(deployment) {
  const [label, tone] = Object.hasOwn(deploymentLabels, deployment.status)
    ? deploymentLabels[deployment.status] : ["Unknown", "warn"];
  const row = document.createElement("details");
  row.dataset.deploymentId = deployment.id;
  const summary = document.createElement("summary");
  const release = element("span", "row-label", deployment.release || "Deployment");
  if (deployment.event) release.append(element("span", "row-event", deployment.event));
  const checkedAt = element("span", "row-time muted");
  checkedAt.append(time(deployment.at, historyDateFormat));
  const arrow = element("span", "chevron");
  arrow.setAttribute("aria-hidden", "true");
  summary.append(
    release, element("code", "row-id", deployment.id),
    checkedAt, element("span", "row-result " + tone, label), arrow,
  );
  const detail = element("div", "row-detail");
  detail.append(buildRunLink(deployment.run) || element("p", "", "No source build is linked to this deployment."));
  row.append(summary, detail);
  return row;
}

function setHistory(deployments, stale, loading) {
  const rows = get("deployment-rows");
  const empty = get("empty");
  const available = Array.isArray(deployments);
  const hasEntries = available && deployments.length > 0;
  get("history-source").textContent = stale ? "Last recorded Coolify history" : "Coolify · newest first";
  rows.hidden = !hasEntries;
  empty.hidden = hasEntries;
  empty.textContent = loading ? "Waiting for Coolify deployment history." :
    available ? "Coolify reported no deployments for this preview." : "Coolify deployment history is unavailable.";
  const historyKey = JSON.stringify(deployments);
  if (historyKey === renderedHistory) return;
  const openIds = new Set([...rows.children].filter((row) => row.open).map((row) => row.dataset.deploymentId));
  const active = document.activeElement;
  const activeId = rows.contains(active) ? active.closest("details")?.dataset.deploymentId : null;
  const updated = hasEntries ? deployments.map((deployment) => {
    const row = deploymentRow(deployment);
    row.open = openIds.has(deployment.id);
    return row;
  }) : [];
  rows.replaceChildren(...updated);
  if (activeId) {
    const row = updated.find((item) => item.dataset.deploymentId === activeId);
    const replacement = row?.querySelector(active.matches("a") ? "a" : "summary") ??
      row?.querySelector("summary") ?? refresh;
    replacement.focus({ preventScroll: true });
  }
  renderedHistory = historyKey;
}

function render({ loading = false, checked = false } = {}) {
  const checkedAt = date(snapshot?.checkedAt);
  const stale = Boolean(checkedAt && (fetchFailed || Date.now() - checkedAt.getTime() >= staleAfterMs));
  const health = snapshot?.health;
  const identity = snapshot?.identity;
  const current = identity === "verified" ? snapshot.current : null;
  const rollback = identity === "verified" ? snapshot.rollback : null;
  const [healthLabel, healthTone] = stale ? ["Stale", "warn"] :
    loading && !snapshot ? ["Checking", ""] : healthLabels[health?.state] ?? healthLabels.unavailable;
  const messageList = [];

  if (loading) messageList.push(["Checking preview health and deployment information.", ""]);
  if (stale) {
    messageList.push([
      (fetchFailed ? "Refresh failed. " : "") +
      "Showing the last available data from " + dateFormat.format(checkedAt) + ". Refresh to check again.",
      "warn",
    ]);
  } else if (fetchFailed) {
    messageList.push(["Deployment sources are unavailable. Refresh to try again.", "warn"]);
  }
  if (identity === "unconfirmed") {
    messageList.push(["The current release identity could not be verified against Coolify and the known deployment evidence.", "warn"]);
  } else if (identity === "unavailable") {
    messageList.push(["Release identity could not be checked because a source was unavailable.", "warn"]);
  }
  if (health?.state === "unhealthy") messageList.push([
    stale ? "The last health check reported an unhealthy preview." : "The preview health check reported an unhealthy preview.",
    "bad",
  ]);

  setNotices(messageList);
  status("health", healthLabel, healthTone);
  get("current-title").textContent = stale ? "Last observed release" : "Current release";
  setIdentity("current", current, loading && !snapshot ? "Checking" : "Unconfirmed");
  const readback = get("readback");
  readback.replaceChildren();
  if (checkedAt) {
    readback.append(stale ? "Last checked " : "Checked ", time(snapshot.checkedAt));
    if (Number.isInteger(health.httpStatus)) readback.append(" · HTTP " + health.httpStatus);
    readback.append(" · Coolify " + health.provider);
  } else {
    readback.textContent = loading ? "Waiting for provider and preview responses." : "No current readback available.";
  }

  setIdentity("rollback", rollback, loading && !snapshot ? "Checking" : "Unavailable");
  if (rollback) {
    status("rollback-state", stale ? "Previously verified" : "Verified", stale ? "warn" : "good");
    get("rollback-context").replaceChildren("Last verified here ", time(rollback.verifiedAt));
  } else {
    status("rollback-state", loading && !snapshot ? "Checking" : "Unconfirmed", loading && !snapshot ? "" : "warn");
    get("rollback-context").textContent = loading && !snapshot ? "Waiting for deployment evidence." :
      "A verified rollback target is unavailable.";
  }
  get("evidence").hidden = !rollback;
  setHistory(snapshot?.history, stale, loading && !snapshot);

  refresh.setAttribute("aria-disabled", String(loading));
  refresh.textContent = loading ? "Checking status…" : "Refresh status";
  view.setAttribute("aria-busy", String(loading));
  view.dataset.state = health?.state || "unavailable";
  view.dataset.checked = String(checked && !stale && identity === "verified");
  view.hidden = false;
}

function clearPrivateView() {
  activeRequest?.abort();
  activeRequest = null;
  clearTimeout(staleTimer);
  clearTimeout(sessionTimer);
  sessionDeadline = undefined;
  snapshot = null;
  fetchFailed = false;
  render();
  view.hidden = true;
}

function returnToSignIn() {
  clearPrivateView();
  location.replace("/sign-in");
}

function scheduleSessionExpiry(response) {
  const expiresAt = date(response.headers.get("X-Owner-Session-Expires-At"));
  const sentAt = date(response.headers.get("Date"));
  if (!expiresAt || !sentAt) throw new Error("Missing owner session deadline");
  const remaining = Math.max(0, expiresAt.getTime() - sentAt.getTime());
  clearTimeout(sessionTimer);
  sessionDeadline = Date.now() + remaining;
  sessionTimer = setTimeout(returnToSignIn, remaining);
}

async function refreshStatus() {
  if (activeRequest) return;
  const request = new AbortController();
  activeRequest = request;
  const timeout = setTimeout(() => request.abort(), 12_000);
  render({ loading: true });
  announcement.textContent = "Checking preview health and release identity.";
  try {
    const response = await fetch("/api/status", { cache: "no-store", redirect: "error", signal: request.signal });
    if (activeRequest !== request) return;
    if (response.status === 401) {
      returnToSignIn();
      return;
    }
    if (!response.ok) throw new Error("Status read failed");
    const data = await response.json();
    if (activeRequest !== request) return;
    if (!date(data?.checkedAt) || !Object.hasOwn(healthLabels, data.health?.state)) {
      throw new Error("Invalid status response");
    }
    scheduleSessionExpiry(response);
    snapshot = data;
    fetchFailed = false;
    render({ checked: true });
    clearTimeout(staleTimer);
    const staleIn = staleAfterMs - (Date.now() - date(data.checkedAt).getTime());
    if (staleIn > 0) {
      staleTimer = setTimeout(() => {
        if (!activeRequest) render();
        announcement.textContent = "The displayed deployment data is stale. Refresh to check again.";
      }, staleIn);
    }
    announcement.textContent = "Preview " + healthLabels[data.health.state][0].toLowerCase() +
      ". Release identity " + data.identity + ".";
  } catch {
    if (activeRequest !== request) return;
    fetchFailed = true;
    render();
    announcement.textContent = snapshot ? "Refresh failed. Showing the last available data." : "Deployment status is unavailable.";
  } finally {
    clearTimeout(timeout);
    if (activeRequest === request) activeRequest = null;
  }
}

function showSection(moveFocus = false) {
  const deployments = location.hash === "#deployments";
  const section = deployments ? "deployments" : "overview";
  const title = deployments ? "Deployments" : "Overview";
  pageTitle.textContent = title;
  document.title = title + " · PAIGE Cloud";
  get("overview-panel").hidden = deployments;
  get("deployments-panel").hidden = !deployments;
  for (const link of navigation) {
    if (link.dataset.section === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (moveFocus) pageTitle.focus({ preventScroll: true });
}

window.addEventListener("hashchange", (event) => {
  const hash = new URL(event.newURL).hash;
  if (hash === "#main") return;
  showSection(true);
});
document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  get("main").focus();
});
showSection();
refresh.addEventListener("click", refreshStatus);
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const value = get(button.dataset.copy).textContent;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      announcement.textContent = "Image digest copied.";
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1200);
    } catch {
      announcement.textContent = "Clipboard unavailable. Select and copy the digest manually.";
    }
  });
}
document.querySelector('form[action="/sign-out"]').addEventListener("submit", () => {
  sessionEvents.postMessage("signed-out");
});
sessionEvents.addEventListener("message", (event) => {
  if (event.data === "signed-out") returnToSignIn();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && sessionDeadline && sessionDeadline <= Date.now()) returnToSignIn();
});
window.addEventListener("pagehide", clearPrivateView);
window.addEventListener("pageshow", (event) => { if (event.persisted) refreshStatus(); });
refreshStatus();
