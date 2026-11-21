"use strict";

const get = (id) => document.getElementById(id);
const view = get("deployment-view");
const refresh = get("refresh");
const announcement = get("announcement");
const pageTitle = get("page-title");
const deploymentSearch = get("deployment-search");
const deploymentStatus = get("deployment-status");
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
  "cancelled-by-user": ["Cancelled", "warn"],
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
let previewRunData;
let previewRequest;
let previewStaleTimer;
const previewLabels = {
  queued: ["Queued", "warn"], building: ["Building", "warn"], built: ["Build passed", "good"],
  failed: ["Build failed", "bad"], cancelled: ["Cancelled", "warn"], "not-built": ["No recorded build", ""],
  unknown: ["Build status unavailable", "warn"], external: ["External PR", ""],
};

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
  get(kind + "-image").hidden = !release;
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
  const source = element("span", "row-source");
  source.append(deployment.frontendCommit ? element("code", "", deployment.frontendCommit.slice(0, 7)) : "Unverified");
  const result = element("span", "row-outcome");
  result.append(element("span", "row-result " + tone, label));
  if (Number.isSafeInteger(deployment.elapsedSeconds) && deployment.elapsedSeconds >= 0) {
    const seconds = deployment.elapsedSeconds;
    const minutes = Math.floor(seconds / 60);
    const elapsed = element("span", "row-elapsed", minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`);
    elapsed.title = "Elapsed time from queue to completion";
    result.append(elapsed);
  }
  const arrow = element("span", "chevron");
  arrow.setAttribute("aria-hidden", "true");
  summary.append(
    release, source, element("span", "row-environment", "Preview"), checkedAt, result, arrow,
  );
  const detail = element("div", "row-detail");
  if (deployment.source?.title) detail.append(element("p", "row-subject", deployment.source.title));
  const fields = element("dl", "row-fields");
  for (const [name, value, mono] of [
    ["GitHub author", deployment.source?.author],
    ["Frontend commit", deployment.frontendCommit, true],
    ["Cloud commit", deployment.cloudCommit, true],
    ["Image digest", deployment.imageDigest, true],
    ["Deployment ID", deployment.id, true],
  ]) {
    if (!value) continue;
    const pair = element("div");
    const entry = element("dd");
    entry.append(mono ? element("code", "", value) : document.createTextNode(value));
    pair.append(element("dt", "", name), entry);
    fields.append(pair);
  }
  detail.append(fields, buildRunLink(deployment.run) || element("p", "muted", "No source build is linked to this deployment."));
  row.append(summary, detail);
  return row;
}

function setHistory(deployments, stale, loading) {
  const rows = get("deployment-rows");
  const empty = get("empty");
  const available = Array.isArray(deployments);
  const query = deploymentSearch.value.trim().toLowerCase();
  const statusFilter = deploymentStatus.value;
  const matches = available ? deployments.filter((row) => {
    const status = row.status === "cancelled-by-user" ? "cancelled" : row.status;
    if (statusFilter && status !== statusFilter) return false;
    return !query || [row.id, row.release, row.event, row.frontendCommit, row.cloudCommit, row.source?.title,
      row.source?.author, "preview"].some((value) => value?.toLowerCase().includes(query));
  }) : [];
  const hasEntries = matches.length > 0;
  get("history-filters").hidden = !available || deployments.length === 0;
  get("history-source").textContent = stale ? "Last recorded Coolify history" : "Coolify · newest first";
  get("history-table").hidden = !hasEntries;
  empty.hidden = hasEntries;
  empty.textContent = loading ? "Waiting for Coolify deployment history." :
    deployments?.length ? "No deployments match these filters." :
      available ? "Coolify reported no deployments for this preview." : "Coolify deployment history is unavailable.";
  const historyKey = JSON.stringify(matches);
  if (historyKey === renderedHistory) return;
  const openIds = new Set([...rows.children].filter((row) => row.open).map((row) => row.dataset.deploymentId));
  const active = document.activeElement;
  const activeId = rows.contains(active) ? active.closest("details")?.dataset.deploymentId : null;
  const updated = matches.map((deployment) => {
    const row = deploymentRow(deployment);
    row.open = openIds.has(deployment.id);
    return row;
  });
  rows.replaceChildren(...updated);
  if (activeId) {
    const row = updated.find((item) => item.dataset.deploymentId === activeId);
    const replacement = row?.querySelector(active.matches("a") ? "a" : "summary") ??
      row?.querySelector("summary") ?? refresh;
    replacement.focus({ preventScroll: true });
  }
  renderedHistory = historyKey;
}

deploymentSearch.addEventListener("input", () => render());
deploymentStatus.addEventListener("change", () => render());

function renderProduction(production, stale, loading) {
  const checkedAt = date(production?.checkedAt);
  const [label, tone] = stale || (checkedAt && Date.now() - checkedAt.getTime() >= staleAfterMs) ? ["Stale", "warn"] :
    loading && !production ? ["Checking", ""] : healthLabels[production?.state] ?? healthLabels.unavailable;
  status("production-health", label, tone);
  const commit = get("production-commit");
  const matched = production?.identity === "matched" && /^[a-f0-9]{40}$/.test(production.frontendCommit ?? "");
  commit.hidden = !matched;
  commit.textContent = matched ? production.frontendCommit : "";

  const description = get("production-readback");
  description.textContent = production?.identity === "mismatch" ? "Domains reported different release metadata." :
    matched ? "Frontend commit reported by all domains." :
    loading && !production ? "Waiting for public endpoints." : "Production source is unavailable.";
  if (checkedAt) description.append(" Checked ", time(production.checkedAt));

  get("production-domains").replaceChildren(...productionDomainRows(production));
}

function productionDomainRows(production, stale = false) {
  return (production?.domains ?? []).map((domain) => {
    const [hostHealth] = healthLabels[domain.state] ?? healthLabels.unavailable;
    const state = Number.isInteger(domain.httpStatus) ? `${hostHealth} · HTTP ${domain.httpStatus}` : hostHealth;
    const item = element("li");
    item.append(element("span", "", domain.hostname), element("span", "muted", ` · ${stale ? "Last observed: " : ""}${state}`));
    if (production.identity === "mismatch") {
      for (const [name, commit] of [["Frontend", domain.frontendCommit], ["Hosting", domain.cloudCommit]]) {
        if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)) continue;
        const revision = element("code", "", commit.slice(0, 7));
        revision.title = commit;
        item.append(` · ${name} `, revision);
      }
    }
    return item;
  });
}

const canonicalGitHub = "https://github.com/Paige-Agent-AI/Paige-Agent-AI";

function receiptLink(path, label) {
  const link = element("a", "", label);
  link.href = canonicalGitHub + path;
  return link;
}

function renderProductionReceipts(production, stale, loading) {
  const checkedAt = date(production?.checkedAt);
  const old = stale || (checkedAt && Date.now() - checkedAt.getTime() >= staleAfterMs);
  const [label, tone] = old ? ["Stale", "warn"] : loading && !production ? ["Checking", ""]
    : healthLabels[production?.state] ?? healthLabels.unavailable;
  status("receipt-health", label, tone);
  const match = get("receipt-match");
  if (old) {
    match.textContent = production?.receiptCommit ? "The last observed release matched a recorded GitHub commit."
      : production?.frontendCommit ? "The last observed release had no matching receipt."
        : "The last production source check was unavailable.";
  } else {
    match.textContent = production?.receiptCommit ? "Production domains report a recorded GitHub commit."
      : production?.frontendCommit ? "The live release has no matching receipt."
        : loading ? "Checking production domains." : "Live production source is unavailable.";
  }
  if (checkedAt) match.append(" Checked ", time(production.checkedAt), ".");
  get("receipt-domains").replaceChildren(...productionDomainRows(production, old));

  const container = get("receipt-rows");
  const receipts = production?.receipts ?? [];
  const open = new Set([...container.querySelectorAll("details[open]")].map((row) => row.dataset.run));
  const hadRecords = !!container.querySelector("details");
  if (!receipts.length) {
    container.replaceChildren(...(loading ? [] : [element("p", "small muted", "No verified production receipts are available.")]));
    return;
  }
  container.replaceChildren(...receipts.map((receipt, index) => {
    const row = element("details", "production-receipt");
    row.dataset.run = receipt.runId + "/" + receipt.attempt;
    row.open = hadRecords ? open.has(row.dataset.run) : index === 0;
    const summary = element("summary");
    summary.append(element("strong", "", "PR #" + receipt.pullRequest),
      element("code", "", receipt.commit.slice(0, 8)), time(receipt.finishedAt, historyDateFormat));
    if (!old && receipt.commit === production.receiptCommit) {
      summary.append(element("span", "status good", "Live commit match"));
    }
    const fields = element("dl", "row-fields");
    for (const [name, value] of [
      ["GitHub commit", receiptLink("/commit/" + receipt.commit, receipt.commit)],
      ["Recorded image digest", element("code", "", receipt.image)],
      ["Coolify deployment", element("code", "", receipt.deployment)],
      ["Rollback commit", receiptLink("/commit/" + receipt.rollback.commit, receipt.rollback.commit)],
      ["Rollback target", element("code", "", receipt.rollback.image)],
      ["Rollback deployment", element("code", "", receipt.rollback.deployment)],
    ]) {
      const pair = element("div");
      const entry = element("dd");
      entry.append(value);
      pair.append(element("dt", "", name), entry);
      fields.append(pair);
    }
    const detail = element("div", "production-receipt-detail");
    detail.append(fields, receiptLink("/actions/runs/" + receipt.runId, "View GitHub workflow run"));
    row.append(summary, detail);
    return row;
  }));
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

  if (loading) messageList.push(["Checking production and preview status.", ""]);
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
  renderProduction(snapshot?.production, stale, loading);
  renderProductionReceipts(snapshot?.production, stale, loading);
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
  clearPrPreviews();
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

function clearPrPreviews() {
  previewRequest?.abort();
  previewRequest = undefined;
  previewRunData = undefined;
  clearTimeout(previewStaleTimer);
  renderPrPreviews();
}

function renderPrPreviews(loading = false) {
  const text = get("pr-preview-summary");
  const output = get("pr-preview-rows");
  if (previewRunData?.state !== "ready") {
    text.textContent = loading ? "Checking open pull requests…" : "Pull request status is unavailable.";
    output.replaceChildren();
    return;
  }
  const search = get("pr-search").value.trim().toLowerCase();
  const checkedAt = date(previewRunData.checkedAt);
  const outdated = !checkedAt || Date.now() - checkedAt.getTime() >= staleAfterMs;
  const rows = previewRunData.rows.filter((row) => !search || `${row.number} ${row.title} ${row.branch} ${row.commit}`.toLowerCase().includes(search));
  const descriptions = [`${rows.length} ${previewRunData.partial ? "of the first " : "of "}${previewRunData.rows.length} open pull requests`];
  if (previewRunData.builds !== "available") descriptions.push("GitHub build activity is unavailable");
  if (outdated) descriptions.push("Preview checks are stale. Refresh status to verify links.");
  text.textContent = descriptions.join(" · ");
  output.replaceChildren(...rows.map((row) => {
    const item = element("li");
    const source = element("div", "pr-preview-source");
    const pr = element("a", "", `#${row.number} ${row.title}`);
    pr.href = `https://github.com/Paige-Agent-AI/Paige-Agent-AI/pull/${row.number}`;
    const commit = element("code", "", row.commit.slice(0, 8));
    commit.title = row.commit;
    source.append(pr, element("span", "small muted", row.branch), commit);
    const state = element("div", "pr-preview-build");
    const [label, tone] = Object.hasOwn(previewLabels, row.build) ? previewLabels[row.build] : previewLabels.unknown;
    state.append(element("span", "status " + tone, label));
    const build = buildRunLink(row.run);
    if (build) state.append(build);
    const expected = `https://pr-${row.number}.preview.179.66.154.248.sslip.io`;
    const live = !outdated && (row.previewUrl === expected || (row.number === 3365 &&
      row.previewUrl === "https://pr-3365-56f13b6.179.66.154.248.sslip.io"));
    const preview = live ? element("a", "", "Open preview") : element("span", "small muted", "No verified URL");
    if (live) preview.href = row.previewUrl;
    item.append(source, state, preview);
    return item;
  }));
}

async function refreshPrPreviews() {
  if (location.pathname !== accountPath + "/deployments" || previewRequest) return;
  const request = new AbortController();
  previewRequest = request;
  previewRunData = undefined;
  clearTimeout(previewStaleTimer);
  renderPrPreviews(true);
  const timeout = setTimeout(() => request.abort(), 8000);
  try {
    const response = await fetch(accountPath + "/api/organizations/paige/projects/paige-agent-ai/environments/pr-previews/status",
      { cache: "no-store", redirect: "error", signal: request.signal });
    if (previewRequest !== request) return;
    if (response.status === 401) returnToSignIn();
    if (!response.ok) return;
    const data = await response.json();
    if (previewRequest === request && Array.isArray(data.rows)) {
      previewRunData = data;
      const checkedAt = date(data.checkedAt);
      const staleIn = checkedAt && staleAfterMs - (Date.now() - checkedAt.getTime());
      if (staleIn > 0) previewStaleTimer = setTimeout(renderPrPreviews, staleIn);
    }
  } catch {
    // Preview inventory failures do not change production readback.
  } finally {
    clearTimeout(timeout);
    if (previewRequest === request) {
      previewRequest = undefined;
      renderPrPreviews();
    }
  }
}

async function refreshStatus() {
  if (activeRequest) return;
  const request = new AbortController();
  activeRequest = request;
  const timeout = setTimeout(() => request.abort(), 12_000);
  render({ loading: true });
  announcement.textContent = "Checking production and preview health and source.";
  try {
    const response = await fetch(accountPath + "/api/organizations/paige/projects/paige-agent-ai/status",
      { cache: "no-store", redirect: "error", signal: request.signal });
    if (activeRequest !== request) return;
    if (response.status === 401) {
      returnToSignIn();
      return;
    }
    if (response.status === 404) {
      snapshot = null;
      fetchFailed = false;
      clearTimeout(staleTimer);
      clearPrPreviews();
      render();
      setNotices([["Project access is unavailable.", "warn"]]);
      announcement.textContent = "Project access is unavailable.";
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
    void refreshPrPreviews();
    clearTimeout(staleTimer);
    const staleIn = staleAfterMs - (Date.now() - date(data.checkedAt).getTime());
    if (staleIn > 0) {
      staleTimer = setTimeout(() => {
        if (!activeRequest) render();
        announcement.textContent = "The displayed deployment data is stale. Refresh to check again.";
      }, staleIn);
    }
    const productionHealth = healthLabels[data.production?.state] ?? healthLabels.unavailable;
    announcement.textContent = "Production " + productionHealth[0].toLowerCase() +
      ". Preview " + healthLabels[data.health.state][0].toLowerCase() +
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

const accountPath = location.pathname.match(/^\/accounts\/[1-9][0-9]{11}(?=\/|$)/)?.[0] ?? "";

function showSection() {
  const deployments = location.pathname === accountPath + "/deployments";
  const section = deployments ? "deployments" : "overview";
  const title = deployments ? "Deployments" : "Overview";
  pageTitle.textContent = title;
  document.title = title + " · PAIGE Cloud";
  get("page-scope").textContent = deployments ? "PAIGE Cloud Preview / f2-preview" : "PAIGE Agent AI";
  get("overview-panel").hidden = deployments;
  get("deployments-panel").hidden = !deployments;
  for (const link of navigation) {
    if (link.dataset.section === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

if (location.pathname === accountPath + "/" || location.pathname === accountPath || location.hash === "#deployments" || location.hash === "#overview") {
  const route = location.hash === "#deployments" ? "/deployments" : "/overview";
  history.replaceState(null, "", accountPath + route);
}
document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  get("main").focus();
});
showSection();
get("pr-search").addEventListener("input", () => renderPrPreviews(Boolean(previewRequest)));
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
