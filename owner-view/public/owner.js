"use strict";

const get = (id) => document.getElementById(id);
const view = get("deployment-view");
const refresh = get("refresh");
const announcement = get("announcement");
const pageTitle = get("page-title");
const deploymentSearch = get("deployment-search");
const deploymentStatus = get("deployment-status");
const deploymentViews = document.querySelectorAll("[data-deployment-view]");
const navigation = document.querySelectorAll(".workspace-menu [data-section]");
const staleAfterMs = 120_000;
const timeZoneSelect = get("time-zone");
const timeZoneKey = "paige-cloud.time-zone";
const browserTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
let dateFormat;
let activityDateFormat;
const healthLabels = {
  healthy: ["Healthy", "good"],
  unhealthy: ["Unhealthy", "bad"],
  unavailable: ["Unknown", "warn"],
};
const deploymentLabels = {
  finished: ["Finished", "good", "ready"],
  failed: ["Failed", "bad", "failed"],
  cancelled: ["Cancelled", "warn", "cancelled"],
  canceled: ["Cancelled", "warn", "cancelled"],
  "cancelled-by-user": ["Cancelled", "warn", "cancelled"],
  queued: ["Queued", "warn", "queued"],
  in_progress: ["In progress", "warn", "in-progress"],
};
let snapshot = null;
let activeRequest = null;
let staleTimer;
let sessionTimer;
let sessionDeadline;
const sessionEvents = new BroadcastChannel("paige-owner-session");
let fetchFailed = false;
let deploymentView = "all";
let lastDeploymentKey;
let previewRunData;
let previewRequest;
let previewStaleTimer;
let previewFetchFailed = false;
const previewLabels = {
  queued: ["Queued", "warn", "queued"], building: ["Building", "warn", "in-progress"],
  built: ["Build passed", "good", "built"], failed: ["Build failed", "bad", "failed"],
  cancelled: ["Cancelled", "warn", "cancelled"], "not-built": ["No recorded build", "", "not-built"],
  unknown: ["Build status unavailable", "warn", "unknown"], external: ["External PR", "", "external"],
};

function date(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function formatTime(node, timestamp) {
  const compact = node.dataset.timeFormat === "compact";
  node.textContent = (compact ? activityDateFormat : dateFormat).format(timestamp);
  if (compact) {
    const timestampText = dateFormat.format(timestamp);
    const label = node.dataset.timeLabel;
    node.title = label ? label + " " + timestampText : timestampText;
    if (label) node.setAttribute("aria-label", node.title);
  }
}

function time(value, format = "full", label) {
  const timestamp = date(value);
  if (!timestamp) return document.createTextNode("Time unavailable");
  const node = document.createElement("time");
  node.dateTime = timestamp.toISOString();
  node.dataset.timeFormat = format;
  if (label) node.dataset.timeLabel = label;
  formatTime(node, timestamp);
  return node;
}

function applyTimeZone() {
  const fields = {
    timeZone: timeZoneSelect.value || browserTimeZone,
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  };
  activityDateFormat = new Intl.DateTimeFormat(undefined, fields);
  dateFormat = new Intl.DateTimeFormat(undefined, {
    ...fields, year: "numeric", second: "2-digit", timeZoneName: "short",
  });
  for (const node of document.querySelectorAll("time[data-time-format]")) {
    formatTime(node, new Date(node.dateTime));
  }
}

function initTimeZone() {
  if (browserTimeZone) {
    const location = browserTimeZone.split("/").at(-1).replaceAll("_", " ");
    timeZoneSelect.options[0].textContent = "Browser (" + location + ")";
  }
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [
    "America/Chicago", "America/Denver", "America/Los_Angeles", "Asia/Kolkata",
    "Asia/Tokyo", "Australia/Sydney", "Europe/London", "Europe/Paris",
  ];
  const existingZones = new Set(Array.from(timeZoneSelect.options, (option) => option.value));
  const groups = new Map();
  for (const zone of zones) {
    if (existingZones.has(zone)) continue;
    const [region, ...place] = zone.split("/");
    if (!groups.has(region)) {
      const group = document.createElement("optgroup");
      group.label = region;
      groups.set(region, group);
      timeZoneSelect.append(group);
    }
    const label = (place.join(" / ") || zone).replaceAll("_", " ");
    groups.get(region).append(new Option(label, zone));
  }
  try {
    timeZoneSelect.value = localStorage.getItem(timeZoneKey) ?? "";
  } catch {
    // Browser storage may be unavailable. The picker still works for this page.
  }
  if (timeZoneSelect.selectedIndex === -1) timeZoneSelect.value = "";
  applyTimeZone();
  timeZoneSelect.addEventListener("change", () => {
    applyTimeZone();
    try {
      localStorage.setItem(timeZoneKey, timeZoneSelect.value);
    } catch {
      // Keep the active selection when storage is unavailable.
    }
  });
  get("time-zone-control").hidden = false;
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
  notices.replaceChildren(...messages.map(([content, tone]) => {
    const notice = element("p", "notice " + tone);
    notice.append(...(Array.isArray(content) ? content : [content]));
    return notice;
  }));
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

function renderProductionReadback(production, stale, loading) {
  const checkedAt = date(production?.checkedAt);
  const old = stale || (checkedAt && Date.now() - checkedAt.getTime() >= staleAfterMs);
  const [label, tone] = old ? ["Stale", "warn"] : loading && !production ? ["Checking", ""]
    : healthLabels[production?.state] ?? healthLabels.unavailable;
  status("receipt-health", label, tone);
  const current = get("receipt-current");
  const liveCommit = production?.frontendCommit;
  current.replaceChildren();
  if (/^[a-f0-9]{40}$/.test(liveCommit ?? "")) {
    const commit = element("code", "", liveCommit.slice(0, 8));
    commit.title = liveCommit;
    current.append(old ? "Last seen on main " : "main ", commit);
  }
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
}

function productionEntry(receipt, production, stale) {
  const current = !stale && receipt.commit === production.receiptCommit;
  return {
    id: "release-" + receipt.runId + "-" + receipt.attempt,
    title: "PR #" + receipt.pullRequest + " · Production release",
    environment: "Production", branch: "main", commit: receipt.commit, at: receipt.finishedAt, timeLabel: "Release verified",
    status: "ready", label: current ? "Current release" : "Verified", tone: "good",
    fields: [
      ["GitHub commit", receiptLink("/commit/" + receipt.commit, receipt.commit)],
      ["Recorded image digest", element("code", "", receipt.image)],
      ["Coolify deployment", element("code", "", receipt.deployment)],
      ["Rollback commit", receiptLink("/commit/" + receipt.rollback.commit, receipt.rollback.commit)],
      ["Rollback target", element("code", "", receipt.rollback.image)],
      ["Rollback deployment", element("code", "", receipt.rollback.deployment)],
    ],
    links: [receiptLink("/pull/" + receipt.pullRequest, "View PR #" + receipt.pullRequest),
      receiptLink("/actions/runs/" + receipt.runId, "View GitHub workflow run"),
      receiptLink("/actions/runs/" + receipt.runId + "/artifacts/" + receipt.artifactId, "Download release receipt")],
    domains: current ? production.domains : [],
    search: "PR #" + receipt.pullRequest + " " + receipt.deployment,
  };
}

function historyEntry(deployment) {
  const [label, tone, state] = Object.hasOwn(deploymentLabels, deployment.status)
    ? deploymentLabels[deployment.status] : ["Unknown", "warn", "unknown"];
  return {
    id: "history-" + deployment.id, title: deployment.release || "Preview deployment",
    environment: "Preview", commit: deployment.frontendCommit, at: deployment.at, timeLabel: "Deployment recorded",
    status: state, label, tone, elapsed: deployment.elapsedSeconds,
    fields: [
      ["Release", deployment.release], ["Event", deployment.event], ["GitHub subject", deployment.source?.title],
      ["GitHub author", deployment.source?.author],
      ["Frontend commit", deployment.frontendCommit && element("code", "", deployment.frontendCommit)],
      ["Cloud commit", deployment.cloudCommit && element("code", "", deployment.cloudCommit)],
      ["Image digest", deployment.imageDigest && element("code", "", deployment.imageDigest)],
      ["Deployment ID", element("code", "", deployment.id)],
    ],
    links: [buildRunLink(deployment.run)],
    search: [deployment.id, deployment.release, deployment.event, deployment.cloudCommit,
      deployment.source?.title, deployment.source?.author].join(" "),
  };
}

function pullEntry(row, stale) {
  const expected = "https://pr-" + row.number + ".preview.179.66.154.248.sslip.io";
  const knownUrl = row.previewUrl === expected || (row.number === 3365 &&
    row.previewUrl === "https://pr-3365-56f13b6.179.66.154.248.sslip.io");
  const previewUrl = knownUrl && !stale && row.build === "built" ? row.previewUrl : undefined;
  const [label, tone, state] = previewUrl ? ["Ready", "good", "ready"] :
    Object.hasOwn(previewLabels, row.build) ? previewLabels[row.build] : previewLabels.unknown;
  const pull = receiptLink("/pull/" + row.number, "View PR #" + row.number);
  const links = [pull, buildRunLink(row.run)];
  const previewNote = previewUrl ? "Verified against this PR commit."
    : knownUrl && stale ? "Verification expired. Refresh to check the preview again."
      : row.build === "built" ? "No verified preview URL for this build." : "";
  return {
    id: "pr-" + row.number + "-" + row.commit, title: "#" + row.number + " " + row.title, environment: "Preview",
    branch: row.branch, commit: row.commit, at: row.buildCreatedAt, updatedAt: row.updatedAt, timeLabel: "Build created",
    status: state, label, tone, previewUrl, hasBuild: Boolean(row.run),
    refreshPreview: knownUrl && stale,
    fields: [
      ["Branch", row.branch], ["GitHub commit", receiptLink("/commit/" + row.commit, row.commit)],
      ["Preview", previewNote],
    ],
    links,
  };
}

function appendFields(container, entries) {
  const fields = element("dl", "row-fields");
  for (const [name, value] of entries) {
    if (!value) continue;
    const pair = element("div");
    const entry = element("dd");
    entry.append(value);
    pair.append(element("dt", "", name), entry);
    fields.append(pair);
  }
  container.append(fields);
}

function deploymentEntry(row, prView) {
  const item = element("li", "deployment-entry");
  item.dataset.entry = row.id;
  const cells = element("div", "deployment-row");
  const title = workspaceLink(deploymentPath(row), row.title, "deployment-title deployment-truncate");
  title.title = row.title;

  const result = element("span", "deployment-outcome");
  result.append(element("span", "deployment-state " + row.tone, row.label));
  if (Number.isSafeInteger(row.elapsed) && row.elapsed >= 0) {
    const minutes = Math.floor(row.elapsed / 60);
    const elapsed = minutes ? minutes + "m " + row.elapsed % 60 + "s" : row.elapsed + "s";
    result.append(element("span", "row-elapsed", elapsed));
  }
  const environment = element("span", "deployment-environment " + row.environment.toLowerCase(), row.environment);
  const source = element("span", "deployment-commit");
  const commit = row.commit ? element("code", "", row.commit.slice(0, 8)) : element("span", "empty-value", "—");
  if (row.commit) commit.title = row.commit;
  else commit.setAttribute("aria-label", "Commit unavailable");
  source.append(commit);

  const branch = element("span", "deployment-branch deployment-truncate", row.branch || "—");
  if (row.branch) branch.title = row.branch;
  else branch.setAttribute("aria-label", "Branch unavailable");
  const when = element("span", "deployment-time");
  const timestamp = row.at || (prView ? row.updatedAt : undefined);
  if (timestamp) when.append(time(timestamp, "compact", row.at ? row.timeLabel : "PR updated"));
  else when.append(element("span", "empty-value", "—"));

  const action = element("span", "deployment-action");
  if (row.previewUrl) {
    const link = element("a", "preview-action", "Open preview");
    link.href = row.previewUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.append(element("span", "sr", " (new tab)"));
    action.append(link);
  } else if (row.refreshPreview) {
    const button = element("button", "preview-action", "Recheck link");
    button.type = "button";
    button.addEventListener("click", refreshStatus);
    action.append(button);
  }

  cells.append(title, result, environment, source, branch, when, action);
  item.append(cells);
  return item;
}

function deploymentIndex(stale) {
  const previewAt = date(previewRunData?.checkedAt);
  const previewStale = previewFetchFailed || !previewAt || Date.now() - previewAt.getTime() >= staleAfterMs;
  const production = snapshot?.production;
  const productionAt = date(production?.checkedAt);
  const productionStale = stale || !productionAt || Date.now() - productionAt.getTime() >= staleAfterMs;
  const pullRows = (previewRunData?.rows ?? []).map((row) => pullEntry(row, previewStale));
  const receipts = (production?.receipts ?? []).map((receipt) => productionEntry(receipt, production, productionStale));
  const history = (snapshot?.history ?? []).map(historyEntry);
  return { previewStale, productionStale, pullRows, receipts, history, previewRows: [...pullRows.filter((row) => row.hasBuild), ...history] };
}

function renderDeployments(loading, index) {
  const output = get("deployment-rows");
  const list = get("deployment-summary");
  const empty = get("empty");
  const { previewStale, productionStale, pullRows, receipts, previewRows } = index;
  const prView = deploymentView === "pull-requests";
  const entries = prView ? pullRows : deploymentView === "production" ? receipts :
    deploymentView === "preview" ? previewRows : [...receipts, ...previewRows];
  const query = deploymentSearch.value.trim().toLowerCase();
  const statusFilter = deploymentStatus.value;
  const rows = entries
    .filter((row) => (!statusFilter || row.status === statusFilter) &&
      (!query || [row.title, row.environment, row.branch, row.commit, row.search, row.label]
        .join(" ").toLowerCase().includes(query)))
    .sort((a, b) => (date(b.at || (prView && b.updatedAt))?.getTime() ?? 0)
      - (date(a.at || (prView && a.updatedAt))?.getTime() ?? 0));
  const notes = [];
  if (deploymentView !== "production") {
    if (previewRequest || (loading && !previewRunData)) notes.push("Checking PR previews");
    else if (!previewRunData || previewFetchFailed) notes.push("PR preview status unavailable");
    else if (previewRunData.builds !== "available") notes.push("GitHub build activity unavailable");
    if (previewRunData && previewStale) notes.push("Preview links need a fresh check");
    if (previewRunData?.partial) notes.push("Showing the first " + pullRows.length + " open PRs");
    if (!prView && snapshot && !Array.isArray(snapshot.history)) notes.push("Coolify history unavailable");
  }
  const count = rows.length === entries.length ? String(rows.length) : rows.length + " of " + entries.length;
  list.textContent = [count + (prView ? " open PRs" : " deployments"), ...notes].join(" · ");
  if (prView) output.setAttribute("aria-label", "Open pull requests");
  else output.setAttribute("aria-label", "Deployments");
  empty.hidden = rows.length > 0;
  empty.textContent = loading || (previewRequest && deploymentView !== "production") ? "Checking deployment activity…"
    : entries.length ? "No results match your filters." : prView && !previewRunData ? "Open pull requests could not be loaded."
      : prView ? "There are no open pull requests." : "No deployment activity is available.";

  const key = JSON.stringify([rows, prView, productionStale, previewStale, previewRunData?.checkedAt, snapshot?.checkedAt]);
  if (key === lastDeploymentKey) return;
  lastDeploymentKey = key;
  const active = document.activeElement;
  const activeRow = output.contains(active) ? active.closest(".deployment-entry") : null;
  const activeControls = activeRow && [...activeRow.querySelectorAll("button, a")];
  const activeIndex = activeControls ? activeControls.indexOf(active) : -1;
  const items = rows.map((row) => deploymentEntry(row, prView));
  output.replaceChildren(...items);
  if (activeRow) {
    const item = items.find((entry) => entry.dataset.entry === activeRow.dataset.entry);
    const next = item?.querySelectorAll("button, a")[activeIndex];
    const replacement = next?.textContent === active.textContent ? next
      : item?.querySelector(".deployment-title") ?? deploymentSearch;
    replacement.focus({ preventScroll: true });
  }
}


function workspaceLink(path, label, className = "") {
  const link = element("a", className, label);
  link.href = accountPath + path;
  return link;
}

function deploymentPath(row) {
  return "/deployments/" + row.id;
}

function card(title) {
  const panel = element("section", "workspace-card");
  panel.append(element("h2", "", title));
  return panel;
}

function renderDetail(loading, { receipts, history, pullRows }) {
  const panel = get("detail-panel");
  const row = [...receipts, ...history, ...pullRows].find((item) => item.id === detailId);
  const key = JSON.stringify([row, snapshot?.checkedAt, previewRunData?.checkedAt, loading, !!previewRequest]);
  if (panel.dataset.renderKey === key) return;
  panel.dataset.renderKey = key;
  const back = workspaceLink("/deployments", "← Deployments", "detail-back");
  panel.replaceChildren(back);
  pageTitle.textContent = row?.title ?? "Deployment";
  document.title = pageTitle.textContent + " · PAIGE Cloud";
  if (!row) {
    panel.append(element("p", "notice", loading || previewRequest || (detailId.startsWith("pr-") && !previewRunData && !previewFetchFailed && snapshot)
      ? "Loading deployment evidence…" : "This deployment record is unavailable. Open Deployments for current records."));
    return;
  }
  const summary = card("Deployment details");
  const badges = element("div", "detail-badges");
  badges.append(element("span", "deployment-environment " + row.environment.toLowerCase(), row.environment),
    element("span", "status " + row.tone, row.label));
  summary.append(badges);
  appendFields(summary, [
    ["Branch", row.branch], ["Commit", row.commit && element("code", "", row.commit)],
    [row.timeLabel ?? "Recorded", row.at && time(row.at)],
    ["Duration", Number.isSafeInteger(row.elapsed) ? row.elapsed + " seconds" : null],
  ]);
  if (row.previewUrl) {
    const visit = element("a", "preview-action", "Open preview");
    visit.href = row.previewUrl;
    visit.target = "_blank";
    visit.rel = "noreferrer";
    summary.append(visit);
  } else if (row.refreshPreview) {
    const recheck = element("button", "preview-action", "Recheck preview link");
    recheck.addEventListener("click", refreshStatus);
    summary.append(recheck);
  }
  const evidence = card("Source and evidence");
  appendFields(evidence, row.fields);
  const links = row.links.filter(Boolean);
  if (links.length) {
    const actions = element("div", "deployment-detail-links");
    actions.append(...links);
    evidence.append(actions);
  }
  panel.append(summary, evidence);
  if (row.domains?.length) {
    const checks = card("Live domain checks");
    const list = element("ul", "production-domains");
    list.append(...productionDomainRows({ domains: row.domains }));
    checks.append(list);
    panel.append(checks);
  }
}

function renderDomains(loading, stale) {
  const panel = get("domains-panel");
  const production = snapshot?.production;
  const group = card("Production domains");
  const check = date(production?.checkedAt);
  const old = stale || (check && Date.now() - check.getTime() >= staleAfterMs);
  if (check) {
    const stamp = element("p", "muted small");
    stamp.append(old ? "Last checked " : "Checked ", time(production.checkedAt));
    group.append(stamp);
  }
  const domains = production?.domains ?? [];
  if (!domains.length) group.append(element("p", "muted", loading ? "Checking domain health…" : "Domain checks are unavailable."));
  const list = element("ul", "workspace-feed");
  for (const domain of domains) {
    const item = element("li");
    const host = element("a", "", domain.hostname);
    host.href = "https://" + domain.hostname;
    host.target = "_blank";
    host.rel = "noreferrer";
    const [label, tone] = healthLabels[domain.state] ?? healthLabels.unavailable;
    item.append(host, element("span", "status " + (old ? "warn" : tone), old ? "Last observed: " + label : label));
    if (Number.isInteger(domain.httpStatus)) item.append(element("span", "muted small", "HTTP " + domain.httpStatus));
    if (domain.frontendCommit) item.append(element("code", "", domain.frontendCommit.slice(0, 8)));
    list.append(item);
  }
  group.append(list);
  panel.replaceChildren(group);
}

function renderActivity(loading, stale, { receipts, previewRows }) {
  const panel = get("activity-panel");
  const group = card("Release and build events");
  const events = [...receipts, ...previewRows].sort((a, b) => (date(b.at)?.getTime() ?? 0) - (date(a.at)?.getTime() ?? 0));
  if (stale || previewFetchFailed) group.append(element("p", "muted small", "Showing available recorded activity."));
  if (!events.length) group.append(element("p", "muted", loading ? "Loading release activity…" : "No recorded release activity."));
  const list = element("ol", "workspace-feed");
  for (const row of events) {
    const item = element("li");
    item.append(workspaceLink(deploymentPath(row), row.title), element("span", "status " + row.tone, row.label));
    if (row.at) item.append(time(row.at, "compact"));
    list.append(item);
  }
  group.append(list);
  panel.replaceChildren(group);
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
      [fetchFailed ? "Refresh failed. " : "", "Showing the last available data from ",
        time(snapshot.checkedAt), ". Refresh to check again."],
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
  renderProductionReadback(snapshot?.production, stale, loading);
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
  if (section === "deployments") renderDeployments(loading, deploymentIndex(stale));
  if (section === "detail") renderDetail(loading, deploymentIndex(stale));
  if (section === "activity") renderActivity(loading, stale, deploymentIndex(stale));
  if (section === "domains") renderDomains(loading, stale);

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
  previewFetchFailed = false;
  clearTimeout(previewStaleTimer);
}

async function refreshPrPreviews() {
  if (!["deployments", "detail", "activity"].includes(section) || previewRequest) return;
  const request = new AbortController();
  previewRequest = request;
  let received = false;
  render();
  const timeout = setTimeout(() => request.abort(), 8000);
  try {
    const response = await fetch(accountPath + "/api/organizations/paige/projects/paige-agent-ai/environments/pr-previews/status",
      { cache: "no-store", redirect: "error", signal: request.signal });
    if (previewRequest !== request) return;
    if (response.status === 401) {
      returnToSignIn();
      return;
    }
    if (response.status === 404) previewRunData = undefined;
    if (!response.ok) return;
    const data = await response.json();
    if (previewRequest === request && data.state === "ready" && Array.isArray(data.rows)) {
      previewRunData = data;
      received = true;
      clearTimeout(previewStaleTimer);
      const checkedAt = date(data.checkedAt);
      const staleIn = checkedAt && staleAfterMs - (Date.now() - checkedAt.getTime());
      if (staleIn > 0) previewStaleTimer = setTimeout(() => render({ loading: !!activeRequest }), staleIn);
    }
  } catch {
    // Preview inventory failures do not change production readback.
  } finally {
    clearTimeout(timeout);
    if (previewRequest === request) {
      previewRequest = undefined;
      previewFetchFailed = !received;
      render({ loading: !!activeRequest });
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
  const deployments = section === "deployments" || section === "detail";
  const title = { deployments: "Deployments", detail: "Deployment", domains: "Domains", activity: "Activity" }[section] ?? "Overview";
  pageTitle.textContent = title;
  document.title = title + " · PAIGE Cloud";
  document.body.classList.toggle("workspace-deployments", deployments);
  if (deployments) {
    const pilotLabel = get("pilot-link");
    pilotLabel.textContent = "Sign-in pilot";
    pilotLabel.classList.remove("primary");
    pilotLabel.append(element("span", "sr", " (new tab)"));
  }
  for (const name of ["overview", "deployments", "detail", "domains", "activity"]) {
    get(name + "-panel").hidden = section !== name;
  }
  for (const link of navigation) {
    if (link.dataset.section === (section === "detail" ? "deployments" : section)) link.setAttribute("aria-current", "page");
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
const route = location.pathname.slice(accountPath.length);
const detailId = route.startsWith("/deployments/") ? route.split("/").at(-1) : "";
const section = detailId ? "detail" : ["/deployments", "/domains", "/activity"].includes(route) ? route.slice(1) : "overview";

initTimeZone();
showSection();
for (const button of deploymentViews) {
  button.addEventListener("click", () => {
    deploymentView = button.dataset.deploymentView;
    for (const tab of deploymentViews) tab.setAttribute("aria-pressed", String(tab === button));
    render({ loading: !!activeRequest });
  });
}
deploymentSearch.addEventListener("input", () => render({ loading: !!activeRequest }));
deploymentStatus.addEventListener("change", () => render({ loading: !!activeRequest }));
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
