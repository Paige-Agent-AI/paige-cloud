"use strict";

import { releaseEvidence, releaseScope } from "./mission-release.mjs";

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
const productionRefreshMs = 45_000;
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", year: "numeric", hour: "numeric",
  minute: "2-digit", second: "2-digit", timeZoneName: "short",
});
const activityDateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});
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
let productionRefreshTimer;
let buildSource;
let buildClock;
let observedMainVersion;
let pendingMainRefresh = false;
let sessionTimer;
let sessionDeadline;
const sessionEvents = new BroadcastChannel("paige-owner-session");
let fetchFailed = false;
let scopeUnavailable = false;
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
    current.append(old ? "Last seen " : "Serving now ", commit);
  }
  const main = get("receipt-main");
  const mainCommit = production?.mainCommit;
  main.replaceChildren();
  if (/^[a-f0-9]{40}$/.test(mainCommit ?? "")) {
    const commit = element("code", "", mainCommit.slice(0, 8));
    commit.title = mainCommit;
    main.append(old ? "Last known main " : "GitHub main ", commit);
    if (!old && liveCommit) main.append(liveCommit === mainCommit ? " · Matches production" : " · Differs from production");
  } else if (production) main.textContent = "GitHub main unavailable";
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
  if (section === "deployments") match.append(" Production refreshes every 45 seconds while this tab is visible.");
  get("receipt-domains").replaceChildren(...productionDomainRows(production, old));
}

function observedProductionEntry(production) {
  const commit = production?.frontendCommit;
  if (production?.identity !== "matched" || production.receiptCommit || !/^[a-f0-9]{40}$/.test(commit ?? "")) return null;
  return {
    id: "live-" + commit, title: "Live production", environment: "Production", commit,
    branch: commit === production.mainCommit ? "main" : undefined,
    status: "receipt-unavailable", label: "Receipt unavailable", tone: "warn",
    pinned: true, fields: [["Observed", time(production.checkedAt)],
      ["Release receipt", "Unavailable for this commit"]],
    links: [receiptLink("/commit/" + commit, "View GitHub commit")],
    domains: production.domains,
  };
}

function productionEntry(receipt, production, stale) {
  const current = !stale && receipt.deployment === production.receiptDeployment;
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

function productionProviderEntry(deployment, stale) {
  const [label, tone, state] = deployment.status === "finished" ? ["Finished · Receipt unavailable", "warn", "receipt-unavailable"]
    : deploymentLabels[deployment.status] ?? ["Unknown", "warn", "unknown"];
  return {
    id: "history-" + deployment.id, title: "Production rollout", environment: "Production",
    status: state, label: stale ? "Last recorded · " + label : label, tone: stale ? "warn" : tone,
    at: deployment.at, timeLabel: "Coolify activity", elapsed: deployment.elapsedSeconds,
    fields: [["Coolify deployment", element("code", "", deployment.id)], ["Release receipt", "Unavailable for this rollout"]],
    search: deployment.id,
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
  const publicIp = previewRunData?.publicIp;
  const pagesProject = previewRunData?.pagesProject;
  const expected = Number.isSafeInteger(row.number) && row.number > 0 && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(publicIp ?? "")
    ? "https://pr-" + row.number + ".preview." + publicIp + ".sslip.io" : undefined;
  const pagesUrl = Number.isSafeInteger(row.number) && row.number > 0 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(pagesProject ?? "")
    ? "https://pr-" + row.number + "." + pagesProject + ".pages.dev" : undefined;
  const knownUrl = Boolean(row.previewUrl && (row.previewUrl === expected || row.previewUrl === pagesUrl ||
    (row.number === 3365 && row.previewUrl === "https://pr-3365-56f13b6.179.66.154.248.sslip.io") ||
    (row.number === 3398 && row.previewUrl === "https://pr-3398.preview.179.66.154.248.sslip.io")));
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
  if (timestamp) when.append(time(timestamp, activityDateFormat));
  else when.append(element("span", "empty-value", "—"));
  if (when.firstChild instanceof HTMLTimeElement) {
    const stamp = when.firstChild;
    stamp.title = (row.at ? row.timeLabel : "PR updated") + " " + stamp.title;
    stamp.setAttribute("aria-label", stamp.title);
  }

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
  const receiptDeployments = new Set((production?.receipts ?? []).map((receipt) => receipt.deployment));
  const providerRows = (production?.deployments ?? []).filter((row) => !receiptDeployments.has(row.id))
    .map((row) => productionProviderEntry(row, productionStale || production.providerSource === "stale"));
  const observed = productionStale ? null : observedProductionEntry(production);
  const history = (snapshot?.history ?? []).map(historyEntry);
  return {
    previewStale, productionStale, pullRows, receipts, observed, history,
    productionRows: [...(observed ? [observed] : []), ...receipts, ...providerRows],
    previewRows: [...pullRows.filter((row) => row.hasBuild), ...history],
  };
}

function renderDeployments(loading, index) {
  const output = get("deployment-rows");
  const list = get("deployment-summary");
  const empty = get("empty");
  const { previewStale, productionStale, pullRows, productionRows, previewRows } = index;
  const prView = deploymentView === "pull-requests";
  const entries = prView ? pullRows : deploymentView === "production" ? productionRows :
    deploymentView === "preview" ? previewRows : [...productionRows, ...previewRows];
  const query = deploymentSearch.value.trim().toLowerCase();
  const statusFilter = deploymentStatus.value;
  const rows = entries
    .filter((row) => (!statusFilter || row.status === statusFilter) &&
      (!query || [row.title, row.environment, row.branch, row.commit, row.search, row.label]
        .join(" ").toLowerCase().includes(query)))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (date(b.at || (prView && b.updatedAt))?.getTime() ?? 0)
      - (date(a.at || (prView && a.updatedAt))?.getTime() ?? 0));
  const notes = [];
  if (!prView && deploymentView !== "preview" && snapshot?.production) {
    const { providerSource, receiptSource } = snapshot.production;
    if (providerSource === "stale") notes.push("Showing last recorded Coolify rollouts");
    else if (providerSource === "partial") notes.push("Showing part of Coolify production history");
    else if (providerSource !== "available") notes.push("Full Coolify production history unavailable");
    if (receiptSource === "checking") notes.push("Checking GitHub receipts");
    if (receiptSource === "unconfigured") notes.push("GitHub receipt sync not connected");
    if (["unavailable", "partial"].includes(receiptSource)) notes.push("Some GitHub receipts may be missing");
  }
  if (deploymentView !== "production") {
    if (previewRequest || (loading && !previewRunData)) notes.push("Checking PR previews");
    else if (!previewRunData || previewFetchFailed) notes.push("PR preview status unavailable");
    else if (previewRunData.builds !== "available") notes.push("GitHub build activity unavailable");
    if (previewRunData && previewStale) notes.push("Preview links need a fresh check");
    if (previewRunData?.partial) notes.push("Showing the first " + pullRows.length + " open PRs");
    if (!prView && snapshot && !Array.isArray(snapshot.history)) notes.push("Coolify history unavailable");
  }
  const records = entries.filter((row) => !row.id.startsWith("live-")).length;
  const visibleRecords = rows.filter((row) => !row.id.startsWith("live-")).length;
  if (rows.some((row) => row.id.startsWith("live-"))) notes.unshift("Live source shown separately");
  const count = visibleRecords === records ? String(records) : visibleRecords + " of " + records;
  list.textContent = [count + (prView ? " open PRs" : " deployments"), ...notes].join(" · ");
  if (prView) output.setAttribute("aria-label", "Open pull requests");
  else output.setAttribute("aria-label", "Deployments");
  empty.hidden = rows.length > 0;
  empty.textContent = loading || (previewRequest && deploymentView !== "production") ? "Checking deployment activity…"
    : entries.length ? "No results match your filters." : prView && !previewRunData ? "Open pull requests could not be loaded."
      : prView ? "There are no open pull requests." : "No deployment activity is available.";

  const key = JSON.stringify([rows, prView, productionStale, previewStale]);
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

function renderDetail(loading, { productionRows, history, pullRows }) {
  const panel = get("detail-panel");
  const row = [...productionRows, ...history, ...pullRows].find((item) => item.id === detailId);
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

function renderActivity(loading, stale, { productionRows, previewRows }) {
  const panel = get("activity-panel");
  const group = card("Release and build events");
  const events = [...productionRows, ...previewRows].filter((row) => date(row.at))
    .sort((a, b) => date(b.at).getTime() - date(a.at).getTime());
  if (stale || previewFetchFailed) group.append(element("p", "muted small", "Showing available recorded activity."));
  if (!events.length) group.append(element("p", "muted", loading ? "Loading release activity…" : "No recorded release activity."));
  const list = element("ol", "workspace-feed");
  for (const row of events) {
    const item = element("li");
    item.append(workspaceLink(deploymentPath(row), row.title), element("span", "status " + row.tone, row.label));
    if (row.at) item.append(time(row.at, activityDateFormat));
    list.append(item);
  }
  group.append(list);
  panel.replaceChildren(group);
}

function renderMission(loading) {
  const comparison = section === "comparison";
  const panel = get(comparison ? "comparison-panel" : "mission-panel");
  const evidence = releaseEvidence(snapshot?.production, { failed: fetchFailed, staleAfter: staleAfterMs });
  const state = scopeUnavailable ? "scope" : loading ? "loading" : evidence.state;
  const label = { scope: "Project access is unavailable", loading: "Checking production evidence…", stale: "Production evidence is stale",
    conflicting: "Production domains disagree on the serving revision", unavailable: "Current serving evidence is unavailable",
    verified: "Serving revision has a matching receipt", "receipt-unavailable": "Receipt unavailable for the serving revision" };
  const text = { scope: "No deployment evidence can be shown for this scope.", stale: "Refresh to recheck production; no current conclusion is shown.",
    conflicting: "No single serving revision can be verified.", unavailable: "No release conclusion can be drawn from the current readback.",
    verified: "No release receipt exception found for Production.",
    "receipt-unavailable": evidence.receiptCoverage === "limited" ? "The domains agree on the serving revision. Receipt coverage is limited; this is not a deployment failure."
      : "The domains agree on the serving revision, but no matching receipt was found. This is not a deployment failure." };
  const stamp = JSON.stringify([state, evidence, comparison ? null : snapshot?.health?.state]);
  if (panel.dataset.renderKey === stamp && !panel.hidden) return;
  panel.dataset.renderKey = stamp;
  const active = panel.contains(document.activeElement) ? document.activeElement.getAttribute("href") : null;
  panel.replaceChildren();
  panel.hidden = false;
  panel.setAttribute("aria-busy", String(loading));
  const content = element("section", "mission-card");
  content.append(element("h2", "", comparison ? "Production release evidence" : "Needs your attention"));
  const body = element("div", "mission-body");
  content.append(body);
  body.append(element("h3", "", label[state]));
  if (text[state]) body.append(element("p", "muted", text[state]));
  const evidenceLink = (path, title) => {
    const a = element("a", "mission-link", title);
    a.href = accountPath + path;
    return a;
  };
  if (state === "receipt-unavailable" && !comparison) {
    body.append(element("p", "mission-scope-note", "PAIGE Agent AI / Production"));
    body.append(evidenceLink(releaseScope + "/release-comparison", "Open release comparison"));
  }
  if (comparison && ["verified", "receipt-unavailable"].includes(state)) {
    const facts = element("dl", "mission-facts");
    for (const [name, value, identifier] of [
      ["Verified serving revision", evidence.serving, true],
      ["GitHub main · reference only", evidence.main ?? "Unavailable", !!evidence.main],
      ["Production health", healthLabels[evidence.health][0]],
      ["Release receipt", state === "verified" ? "Verified match" : "Unavailable for this revision"],
      ["Intended / authorized change", "Not evidenced by this readback"],
      ["Provider acknowledgment", "Not established by this readback"],
      ["Recovery eligibility", "Not established for Production"],
      ["Recovered state", "Not evidenced"],
    ]) {
      const fact = element("div"), term = element("dt", "", name), description = element("dd");
      description.append(identifier ? element("code", "", value) : document.createTextNode(value));
      fact.append(term, description);
      facts.append(fact);
    }
    const readAt = element("p", "small muted");
    readAt.append("Production domains · checked ", time(evidence.checkedAt));
    body.append(facts, readAt);
  }
  if (comparison && state !== "scope") body.append(evidenceLink("/deployments#production-evidence", "Open existing deployment evidence"));
  panel.append(content);
  if (!comparison && state !== "scope") {
    const coverage = element("section", "mission-card");
    coverage.append(element("h2", "", "Environment coverage"));
    const items = element("div", "mission-body");
    items.append(element("h3", "", "Production"),
      element("p", "muted", !loading && evidence.health ? healthLabels[evidence.health][0] + " · domain health" : "Current health not established"),
      element("h3", "", "F2 preview"),
      element("p", "muted", !loading && !fetchFailed && !["stale", "conflicting"].includes(state) &&
        date(snapshot?.checkedAt) && Date.now() - Date.parse(snapshot.checkedAt) < staleAfterMs &&
        Object.hasOwn(healthLabels, snapshot?.health?.state) ? healthLabels[snapshot.health.state][0] + " · preview health" : "Current health not established"));
    coverage.append(items);
    panel.append(coverage);
  }
  if (active) ([...panel.querySelectorAll("a")].find((link) => link.getAttribute("href") === active) ?? pageTitle)
    .focus({ preventScroll: true });
}

function render({ loading = false, checked = false } = {}) {
  if (section === "overview" || section === "comparison") renderMission(loading);
  if (section === "comparison") {
    refresh.setAttribute("aria-disabled", String(loading));
    refresh.textContent = loading ? "Checking status…" : "Refresh status";
    return;
  }
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
    messageList.push(["The F2 preview release identity could not be verified against Coolify and the known deployment evidence.", "warn"]);
  } else if (identity === "unavailable") {
    messageList.push(["F2 preview release identity could not be checked because a source was unavailable.", "warn"]);
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
  clearInterval(productionRefreshTimer);
  stopBuilds();
  activeRequest?.abort();
  activeRequest = null;
  pendingMainRefresh = false;
  clearTimeout(staleTimer);
  clearTimeout(sessionTimer);
  sessionDeadline = undefined;
  clearPrPreviews();
  snapshot = null;
  fetchFailed = false;
  render();
  view.hidden = true;
  get("mission-panel").hidden = true;
  get("comparison-panel").hidden = true;
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

async function refreshStatus({ background = false } = {}) {
  if (activeRequest) return;
  const request = new AbortController();
  activeRequest = request;
  const timeout = setTimeout(() => request.abort(), 12_000);
  if (!background) {
    render({ loading: true });
    announcement.textContent = "Checking production and preview health and source.";
  }
  try {
    const comparison = section === "comparison";
    const response = await fetch(accountPath + (comparison ? "/api" + releaseScope + "/status" : "/api/organizations/paige/projects/paige-agent-ai/status"),
      { cache: "no-store", redirect: "error", signal: request.signal });
    if (activeRequest !== request) return;
    if (response.status === 401) {
      returnToSignIn();
      return;
    }
    if (response.status === 404) {
      clearInterval(productionRefreshTimer);
      stopBuilds();
      pendingMainRefresh = false;
      snapshot = null;
      fetchFailed = false;
      scopeUnavailable = true;
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
    if (!date(data?.checkedAt) || !Object.hasOwn(healthLabels, comparison ? data.state : data.health?.state)) {
      throw new Error("Invalid status response");
    }
    scheduleSessionExpiry(response);
    snapshot = comparison ? { checkedAt: data.checkedAt, production: data } : data;
    fetchFailed = false;
    scopeUnavailable = false;
    render({ checked: true });
    if (!background) void refreshPrPreviews();
    clearTimeout(staleTimer);
    const productionTime = date(snapshot.production?.checkedAt)?.getTime() ?? Infinity;
    const staleIn = staleAfterMs - (Date.now() - Math.min(date(data.checkedAt).getTime(),
      ["overview", "comparison"].includes(section) ? productionTime : Infinity));
    if (staleIn > 0) {
      staleTimer = setTimeout(() => {
        if (!activeRequest) render();
        announcement.textContent = "The displayed deployment data is stale. Refresh to check again.";
      }, staleIn);
    }
    const productionHealth = healthLabels[data.production?.state] ?? healthLabels.unavailable;
    if (!background) announcement.textContent = comparison ? get("comparison-panel").querySelector("h3").textContent :
      "Production " + productionHealth[0].toLowerCase() +
      ". Preview " + healthLabels[data.health.state][0].toLowerCase() +
      ". Release identity " + data.identity + ".";
  } catch {
    if (activeRequest !== request) return;
    fetchFailed = true;
    render();
    announcement.textContent = section === "comparison" ? "Production evidence is unavailable. No current comparison is shown." :
      snapshot ? "Refresh failed. Showing the last available data." : "Deployment status is unavailable.";
  } finally {
    clearTimeout(timeout);
    if (activeRequest === request) {
      activeRequest = null;
      if (pendingMainRefresh) {
        pendingMainRefresh = false;
        void refreshStatus({ background: true });
      }
    }
  }
}

function watchProduction() {
  clearInterval(productionRefreshTimer);
  if (section !== "deployments" || document.hidden) return;
  productionRefreshTimer = setInterval(() => void refreshStatus({ background: true }), productionRefreshMs);
}

function stopBuilds() {
  buildSource?.close();
  buildSource = undefined;
  clearBuildDisplay();
}

function clearBuildDisplay() {
  clearInterval(buildClock);
  get("github-builds").hidden = true;
  get("github-build-latest").textContent = "";
  get("github-build-list").replaceChildren();
}

function buildDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function renderGitHubBuilds(rows, offset) {
  const panel = get("github-builds");
  const latest = get("github-build-latest");
  const labels = { pull: "Pull received", "main-checks": "Main CI", "pull-checks": "PR CI",
    "main-image": "Main image build", preview: "Preview build", production: "Release workflow" };
  const phaseNames = { received: "Received", queued: "Queued", running: "Running", completed: "Completed" };
  const conclusions = { success: "Passed", failure: "Failed", cancelled: "Cancelled", timed_out: "Timed out", skipped: "Skipped" };
  const dispatchLabels = { pending: "Preview queued", accepted: "Preview requested", rejected: "Preview request rejected",
    unknown: "Preview request unconfirmed", sending: "Requesting preview" };
  const recent = rows.slice(0, 10);
  const clocks = [];
  const list = recent.map((row) => {
    const title = (labels[row.kind] ?? "Build") + (row.pull ? " · PR #" + row.pull : "");
    const repo = row.kind === "preview" ? "paige-cloud-preview" : "Paige-Agent-AI";
    const link = element("a", "", title);
    link.href = `https://github.com/Paige-Agent-AI/${repo}/` + (row.run ? "actions/runs/" + row.run : "pull/" + row.pull);
    const stamp = element("span", "small muted");
    const phase = (Object.hasOwn(conclusions, row.conclusion) && conclusions[row.conclusion]) ||
      (Object.hasOwn(dispatchLabels, row.dispatch) && dispatchLabels[row.dispatch]) || phaseNames[row.phase];
    function update() {
      const until = row.finishedAt ?? Date.now() + offset;
      stamp.textContent = row.startedAt ? `${phase} · ${buildDuration(until - row.startedAt)}`
        : row.phase === "queued" && row.queuedAt ? `Queued · ${buildDuration(until - row.queuedAt)}` : phase;
    }
    update();
    if (row.phase === "running" || row.phase === "queued") clocks.push(update);
    const item = element("li");
    item.append(link);
    if (row.kind !== "production") item.append(element("code", "", row.commit.slice(0, 8)));
    item.append(stamp);
    if (row.kind === "pull") item.append(time(new Date(row.receivedAt).toISOString(), activityDateFormat));
    return { item, title, stamp };
  });
  const output = get("github-build-list");
  const activeHref = output.contains(document.activeElement) ? document.activeElement.href : undefined;
  output.replaceChildren(...list.map(({ item }) => item));
  if (activeHref) ([...output.querySelectorAll("a")].find((link) => link.href === activeHref) ?? panel.querySelector("summary")).focus({ preventScroll: true });
  panel.hidden = false;
  const selected = list[recent.findIndex((row) => row.phase === "running")] ?? list[0];
  const updateLabel = () => {
    for (const update of clocks) update();
    latest.textContent = selected ? selected.title + " · " + selected.stamp.textContent : "Waiting for events";
  };
  clearInterval(buildClock);
  updateLabel();
  if (clocks.length) buildClock = setInterval(updateLabel, 1000);
}

function watchGitHubBuilds() {
  if (section !== "deployments" || document.hidden || buildSource) return;
  const source = new EventSource(accountPath + "/api/organizations/paige/projects/paige-agent-ai/deployment-events");
  buildSource = source;
  source.addEventListener("builds", (event) => {
    const updates = JSON.parse(event.data);
    if (buildSource !== source || !Array.isArray(updates.rows)) return;
    renderGitHubBuilds(updates.rows, updates.now - Date.now());
    if (observedMainVersion !== undefined && observedMainVersion !== updates.mainVersion) {
      if (activeRequest) pendingMainRefresh = true;
      else void refreshStatus({ background: true });
    }
    observedMainVersion = updates.mainVersion;
  });
  source.addEventListener("error", () => {
    if (buildSource !== source) return;
    clearBuildDisplay();
  });
}

const accountPath = location.pathname.match(/^\/accounts\/[1-9][0-9]{11}(?=\/|$)/)?.[0] ?? "";

function showSection() {
  const deployments = section === "deployments" || section === "detail";
  const title = { comparison: "Release comparison", deployments: "Deployments", detail: "Deployment", domains: "Domains", activity: "Activity" }[section] ?? "Mission Control";
  pageTitle.textContent = title;
  document.title = title + " · PAIGE Cloud";
  document.body.classList.toggle("workspace-deployments", deployments);
  const mission = section === "overview" || section === "comparison";
  document.body.classList.toggle("workspace-mission", mission);
  get("mission-scope").hidden = !mission;
  get("mission-environment").hidden = section !== "comparison";
  get("page-scope").hidden = mission;
  get("pilot-link").hidden = section === "comparison";
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
    if (link.dataset.section === (section === "detail" || section === "comparison" ? "deployments" : section)) link.setAttribute("aria-current", "page");
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
const section = route === releaseScope + "/release-comparison" ? "comparison" :
  detailId ? "detail" : ["/deployments", "/domains", "/activity"].includes(route) ? route.slice(1) : "overview";

showSection();
if (section === "deployments" && location.hash === "#production-evidence") {
  get("production-evidence").open = true;
  deploymentView = "production";
  for (const tab of deploymentViews) tab.setAttribute("aria-pressed", String(tab.dataset.deploymentView === deploymentView));
}
const themeToggle = get("theme-toggle");
function setTheme(light) {
  document.documentElement.dataset.ownerTheme = light ? "light" : "dark";
  themeToggle.setAttribute("aria-pressed", String(light));
}
try { setTheme(localStorage.getItem("paige-owner-theme") === "light"); } catch { setTheme(false); }
themeToggle.hidden = false;
themeToggle.addEventListener("click", () => {
  const light = themeToggle.getAttribute("aria-pressed") !== "true";
  setTheme(light);
  try { localStorage.setItem("paige-owner-theme", light ? "light" : "dark"); } catch { /* preference is optional */ }
});
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
  watchProduction();
  if (document.hidden) stopBuilds();
  else watchGitHubBuilds();
  if (section === "deployments" && !document.hidden && (!snapshot || Date.now() - Date.parse(snapshot.checkedAt) >= productionRefreshMs)) {
    void refreshStatus({ background: true });
  }
});
window.addEventListener("pagehide", clearPrivateView);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    watchProduction();
    watchGitHubBuilds();
    void refreshStatus();
  }
});
watchProduction();
watchGitHubBuilds();
refreshStatus();
