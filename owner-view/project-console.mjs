import { normalizeEmail, validCode } from "./accounts.mjs";
import { firstProject, isProjectSlug, ownerId } from "./projects.mjs";

export const escape = (value) => String(value).replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const url = (project) => `/projects/${project.organizationId}/${project.projectId}`;
const canonical = (project) => project.organizationId === firstProject.organizationId && project.projectId === firstProject.projectId;
const activeInviteInput = '<label for="invite">Invitation code</label><input name="invite" id="invite" maxlength="43" required autocomplete="off" spellcheck="false">';
const button = (label, primary = false) => `<button type="submit"${primary ? ' class="primary"' : ""}>${label}</button>`;
const action = (value) => `<input type="hidden" name="action" value="${value}">`;

export function matchProjectPage(path) {
  if (path === "/projects" || path === "/join") return { path };
  const parts = path?.split("/") ?? [];
  const members = parts.length === 5 && parts[4] === "members";
  const registry = parts.length === 5 && parts[4] === "applications";
  const media = parts[4] === "media" && (parts.length === 5 || (parts.length === 6 && /^[a-f0-9]{20}$/.test(parts[5])));
  if ((parts.length !== 4 && !members && !media && !registry) || parts[0] || parts[1] !== "projects" ||
      !parts.slice(2, 4).every(isProjectSlug)) return undefined;
  return { path, organizationId: parts[2], projectId: parts[3], members, media, registry, streamId: media ? parts[5] : undefined };
}

export function shell(title, body, showDeployments, remaining, accountPath, active = "projects") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · PAIGE Cloud</title><link rel="stylesheet" href="/assets/owner.css">
<script src="/assets/project-session.js" defer></script></head>
<body class="workspace"><a class="skip-link" href="#main">Skip to main content</a>
<header><div class="topbar"><a class="brand" href="${accountPath}/projects" aria-label="PAIGE Cloud projects">
<svg viewBox="0 0 48 48" aria-hidden="true"><polygon points="21,13.6 30.5,13.6 21,34.4 11.5,34.4"/><circle cx="34.5" cy="30.5" r="5.5"/></svg>
<span>PAIGE <span class="brand-cloud">Cloud</span></span></a>
<form action="/sign-out" method="post" class="sign-out-form">${button("Sign out")}</form></div></header>
<div class="workspace-layout"><nav class="workspace-menu" aria-label="Workspace">
${showDeployments ? `<a href="${accountPath}/overview">Overview</a><a href="${accountPath}/deployments">Deployments</a>` : ""}
<a href="${accountPath}/projects"${active === "projects" ? ' aria-current="page"' : ""}>Projects</a>
${showDeployments ? `<a href="${accountPath}/domains">Domains</a><a href="${accountPath}/activity">Activity</a>
<a href="${accountPath}/projects/paige/paige-agent-ai/media"${active === "media" ? ' aria-current="page"' : ""}>Media</a>` : ""}</nav>
<main id="main" class="project-main${active === "applications" ? " registration-main" : ""}" tabindex="-1" data-session-remaining="${remaining}" data-project-home="${accountPath}/projects" hidden><h1>${escape(title)}</h1>${body}</main>
<noscript><p>Enable JavaScript to open your projects.</p></noscript></div></body></html>`;
}

function membersPanel(project, catalog, accounts, accountPath) {
  const path = accountPath + url(project) + "/members";
  const items = catalog.members(project).map(({ id }) => {
    const email = accounts.emailFor(id);
    const identity = email ? `<strong>${escape(email)}</strong>` : `<code>${escape(id)}</code>`;
    return `<li>${identity}${id === ownerId ? '<span class="muted">Owner</span>' :
      `<form method="post" action="${path}">${action("revoke")}<input type="hidden" name="member" value="${escape(id)}">${button("Revoke access")}</form>`}</li>`;
  });
  const invites = catalog.pending(project).map(({ email, expiresAt }) =>
    `<li><span><strong>${escape(email)}</strong><br><small class="muted">Expires ${new Date(expiresAt).toISOString().slice(0, 10)} UTC</small></span>
      <form method="post" action="${path}">${action("cancel-invite")}<input type="hidden" name="email" value="${escape(email)}">${button("Cancel invitation")}</form></li>`);
  return `<section class="project-panel" aria-labelledby="members"><h2 id="members">Members</h2>
  ${items.length ? `<ul class="project-list">${items.join("")}</ul>` : '<p class="muted">No members yet.</p>'}
  ${project.archived ? "" : `<form class="project-form" method="post" action="${path}">${action("invite")}
  <label for="invite-email">Invite by email</label><input type="email" name="email" id="invite-email" maxlength="254" required>
  ${button("Prepare invitation", true)}</form>`}
  ${invites.length ? `<h3>Pending invitations</h3><ul class="project-list">${invites.join("")}</ul>` : ""}</section>`;
}

function settingsPanel(project, accountPath) {
  if (canonical(project)) return "";
  const path = accountPath + url(project);
  return `<section class="project-panel" aria-labelledby="settings"><h2 id="settings">Project settings</h2>
  <form class="project-form" method="post" action="${path}">${action("rename")}
  <label for="project-name">Display name</label><input name="name" id="project-name" required maxlength="80" value="${escape(project.name)}">${button("Save name")}</form>
  <form class="project-form" method="post" action="${path}">${action(project.archived ? "restore" : "archive")}
  <p class="muted">${project.archived ? "Restoring the project returns access to its remaining members." : "Archiving hides the project from members and cancels pending invitations."}</p>
  ${button(project.archived ? "Restore project" : "Archive project")}</form></section>`;
}

function customerPanel(catalog, path) {
  const invitations = catalog.pendingCustomers().map(({ email, name, expiresAt }) =>
    `<li><span><strong>${escape(email)}</strong><br>${escape(name)}<br><small class="muted">Expires ${new Date(expiresAt).toISOString().slice(0, 10)} UTC</small></span>
      <form method="post" action="${path}">${action("cancel-customer")}<input type="hidden" name="email" value="${escape(email)}">${button("Cancel invitation")}</form></li>`);
  return `<section class="project-panel" aria-labelledby="invite-customer"><h2 id="invite-customer">Invite a customer</h2>
    <form class="project-form" method="post" action="${path}">${action("invite-customer")}
    <label for="customer-email">Customer email</label><input type="email" id="customer-email" name="email" maxlength="254" required>
    <label for="first-project">First project name</label><input id="first-project" name="name" maxlength="80" required>
    <p class="muted">PAIGE Cloud assigns the organization and project IDs when the customer signs up.</p>
    ${button("Prepare customer invitation", true)}</form>
    ${invitations.length ? `<h3>Pending customer invitations</h3><ul class="project-list">${invitations.join("")}</ul>` : ""}</section>`;
}

function registrationsPanel(project, registrations, manage, accountPath, message) {
  const base = accountPath + url(project), path = base + "/applications";
  const { environments, applications } = registrations;
  const field = (id, label, max) => `<label for="${id}">${label}</label><input id="${id}" name="${id.split("-").at(-1)}" maxlength="${max}" required>`;
  const listing = environments.map(env => `<li>
    <div><strong>${escape(env.name)}</strong> <code class="muted">${escape(env.id)}</code>
    ${applications.some(app => app.environmentId === env.id) ? `<ul class="registration-items">${applications.filter(app => app.environmentId === env.id).map(app =>
      `<li><strong>${escape(app.name)}</strong> <code>${escape(app.id)}</code> · ${app.kind === "service" ? "Service" : "Application"}</li>`).join("")}</ul>`
      : '<p class="muted">No applications or services registered.</p>'}</div></li>`).join("");
  return `<p class="muted"><a href="${accountPath}/projects">Projects</a> / <a href="${base}">${escape(project.name)}</a> / ${escape(project.organizationId)}/${escape(project.projectId)}</p>
    ${message ? `<p class="notice bad" role="alert">${message}</p>` : ""}
    <section class="project-panel" aria-labelledby="environments"><h2 id="environments">Environments</h2>
    <p class="muted">Registration saves a Cloud record only. It does not deploy an app or connect a provider.</p>
    ${listing ? `<ul class="project-list">${listing}</ul>` : '<p>No environments registered.</p>'}</section>
    ${manage ? `<section class="project-panel"><h2>Register an environment</h2>
      <form class="project-form" method="post" action="${path}">${action("environment")}
      ${field("environment-id", "Environment ID", 63)}${field("environment-name", "Environment name", 80)}
      <p class="muted">Use lowercase letters, numbers, and hyphens for IDs.</p>${button("Register environment", true)}</form></section>` : ""}
    ${manage && environments.length ? `<section class="project-panel"><h2>Register an application or service</h2>
      <form class="project-form" method="post" action="${path}">${action("register")}
      <label for="registration-environment">Environment</label><select name="environment" id="registration-environment" required>
      ${environments.map(env => `<option value="${escape(env.id)}">${escape(env.name)} (${escape(env.id)})</option>`).join("")}</select>
      <label for="registration-kind">Kind</label><select name="kind" id="registration-kind"><option value="application">Application</option><option value="service">Service</option></select>
      ${field("application-id", "Application or service ID", 63)}${field("application-name", "Display name", 80)}
      ${button("Register application or service", true)}</form></section>` : ""}`;
}

function invitationPanel(email, code, subject, message, back, backLabel) {
  const [mailbox, domain] = email.split("@");
  return `<section class="project-panel"><p>For <strong>${escape(email)}</strong>. This code expires in 48 hours.</p>
    <p><code class="account-id">${code}</code></p>
    <p><a class="primary" href="mailto:${encodeURIComponent(mailbox)}@${domain}?subject=${encodeURIComponent(subject)}&amp;body=${encodeURIComponent(message)}">Open email draft</a></p>
    <p class="muted">Send the draft to deliver the invitation.</p><p><a href="${back}">${backLabel}</a></p></section>`;
}

export function projectPage({ route, form, method, principal, origin, catalog, accounts, showDeployments, remaining, accountPath = "" }) {
  const manage = principal === ownerId;
  const page = (title, body, status = 200) => ({ status, html: shell(title, body, showDeployments, remaining, accountPath) });
  const redirect = (location) => ({ status: 303, location: accountPath + location });
  const error = (message, back, status = 400) => page("Projects",
    `<p class="notice bad" role="alert">${message}</p><p><a href="${accountPath + back}">Go back</a></p>`, status);
  const post = method === "POST";
  if (route.path === "/join") {
    if (!post) return page("Accept an invitation", `<section class="project-panel"><p class="muted">Enter the code sent to your PAIGE Cloud email address.</p>
      <form class="project-form" method="post" action="${accountPath}/join">${activeInviteInput}${button("Accept invitation", true)}</form></section>`);
    const code = form?.get("invite");
    const email = accounts.emailFor(principal);
    const joined = email && form?.size === 1 && validCode(code) && catalog.accept(principal, email, code);
    return joined ? redirect(url(joined)) : error("This invitation is unavailable for your account.", "/join");
  }
  if (post && !manage) return { status: 404 };
  if (route.path === "/projects") {
    if (post) {
      const requestedAction = form?.get("action");
      if (requestedAction === "invite-customer") {
        const email = normalizeEmail(form.get("email"));
        const name = form.get("name")?.trim();
        if (form.size !== 3 || !email || !validName(name)) return error("Enter the customer’s email and first project name.", "/projects");
        const code = accounts.issueCustomerInvitation(email, name);
        if (!code) return error("This email already has an account. Use the project’s Members page to invite them.", "/projects", 409);
        const message = `You’re invited to set up a PAIGE Cloud workspace.\n\nCreate your account at ${origin}/signup using ${email} and this invitation code:\n${code}\n\nThe code expires after 48 hours. Sign in after signup to open your first project, ${name}.`;
        return page("Customer invitation ready", invitationPanel(email, code, "Set up your PAIGE Cloud workspace", message, accountPath + "/projects", "Back to projects"));
      }
      if (requestedAction === "cancel-customer") {
        const email = normalizeEmail(form.get("email"));
        if (form.size !== 2 || !email) return error("Select a pending customer invitation.", "/projects");
        catalog.cancelCustomerInvitation(email);
        return redirect("/projects");
      }
      const organization = form?.get("organization");
      const id = form?.get("project");
      const name = form?.get("name")?.trim();
      if (form?.size !== 3 || !isProjectSlug(organization) || !isProjectSlug(id) || !validName(name)) {
        return error("Enter a display name and valid organization and project IDs.", "/projects");
      }
      return catalog.create(organization, id, name) ? redirect(url({ organizationId: organization, projectId: id }))
        : error("That project ID is already in use in this organization.", "/projects", 409);
    }
    const projects = catalog.list(principal);
    const number = accountPath.split("/").at(-1);
    return page("Projects", `${number ? `<p class="muted">Account <code>${escape(number)}</code></p>` : ""}
      <p class="project-join"><a href="${accountPath}/join">Accept an invitation</a></p>
      <section class="project-panel" aria-label="Available projects">${projects.length ?
      `<ul class="project-list">${projects.map((project) =>
        `<li><div><a href="${accountPath + url(project)}"><strong>${escape(project.name)}</strong></a><br><code class="muted">${escape(project.organizationId)}/${escape(project.projectId)}</code></div>
        ${project.archived ? '<span class="status">Archived</span>' : ""}</li>`).join("")}</ul>` :
      `<p>No projects yet. Accept an invitation to get access.</p><p class="muted">Account ID <code class="account-id">${escape(principal)}</code></p>`}</section>
      ${manage ? customerPanel(catalog, accountPath + "/projects") + `<section class="project-panel"><h2>Create a project</h2>
        <form class="project-form" method="post" action="${accountPath}/projects">
        <label for="name">Display name</label><input id="name" name="name" maxlength="80" required>
        <label for="organization">Organization ID</label><input id="organization" name="organization" required pattern="[a-z0-9][a-z0-9\u005c-]{0,62}" maxlength="63" spellcheck="false">
        <label for="project">Project ID</label><input id="project" name="project" required pattern="[a-z0-9][a-z0-9\u005c-]{0,62}" maxlength="63" spellcheck="false">
        <p class="muted">Use lowercase letters, numbers, and hyphens for IDs.</p>${button("Create project", true)}</form></section>` : ""}`);
  }

  const { organizationId, projectId } = route;
  const project = catalog.get(route);
  if (!project || (!manage && (route.members || !catalog.hasProjectRead(principal, organizationId, projectId)))) return { status: 404 };
  if (route.registry) {
    const records = catalog.registrations(principal, route);
    if (!records) return { status: 404 };
    const render = (message, status = 200) => ({ status, html: shell("Applications", registrationsPanel(project, records, manage, accountPath, message),
      showDeployments, remaining, accountPath, "applications") });
    if (!post) return render();
    const operation = form?.get("action"), id = form?.get("id"), name = form?.get("name")?.trim();
    const kind = operation === "environment" ? "environment" : form?.get("kind");
    const environmentId = form?.get("environment");
    if (!isProjectSlug(id) || !validName(name) ||
        !(operation === "environment" && form.size === 3 ||
          operation === "register" && form.size === 5 && ["application", "service"].includes(kind) && isProjectSlug(environmentId))) {
      return render("Enter a valid ID and display name, and choose an environment for an application or service.", 400);
    }
    const result = catalog.register(principal, route, { id, name, kind, environmentId });
    if (result === "unavailable") return { status: 404 };
    return result === "created" ? redirect(route.path) : render("Registration unavailable. Check for a duplicate ID, a missing environment, or the project registration limit.", 409);
  }
  if (!post && route.members) return page("Members", `<p class="muted"><a href="${accountPath}/projects">All projects</a> /
    <a href="${accountPath + url(project)}">${escape(project.name)}</a> / Members</p>` + membersPanel(project, catalog, accounts, accountPath));
  const detail = `<p class="muted"><a href="${accountPath}/projects">All projects</a> / ${escape(organizationId)}/${escape(projectId)}${project.archived ? ' · Archived' : ''}</p>
    ${!project.archived ? `<p><a href="${accountPath + url(project)}/applications">Applications and environments</a></p>` : ""}
    ${canonical(project) && catalog.hasProjectRead(principal, organizationId, projectId) ? `<p><a href="${accountPath}/deployments">View deployments</a></p>` : !project.archived ? '<p class="muted">No deployment source is connected.</p>' : ""}
    ${!project.archived && catalog.hasProjectRead(principal, organizationId, projectId) ? `<p><a href="${accountPath + url(project)}/media">Project media</a></p>` : ""}
    ${manage ? `<p><a href="${accountPath + url(project)}/members">Manage members</a></p>` : ""}`;
  if (!post) return page(project.name, detail + (manage ? settingsPanel(project, accountPath) : ""));

  const requestedAction = form?.get("action");
  const memberAction = ["invite", "cancel-invite", "revoke"].includes(requestedAction);
  if (memberAction !== route.members) return error("Select a project action.", route.path);
  switch (requestedAction) {
    case "rename": {
      const name = form.get("name")?.trim();
      if (form.size !== 2 || !validName(name)) return error("Enter a valid display name.", route.path);
      if (!catalog.rename(organizationId, projectId, name)) return error("This project’s display name is managed by PAIGE Cloud.", route.path);
      break;
    }
    case "archive":
    case "restore":
      if (form.size !== 1 || !catalog.archive(organizationId, projectId, form.get("action") === "archive")) {
        return error("This project can’t be archived or restored here.", route.path);
      }
      break;
    case "invite": {
      const email = normalizeEmail(form.get("email"));
      if (form.size !== 2 || !email || project.archived) return error("Enter an email for an active project.", route.path);
      if (accounts.isOwnerEmail(email)) return error("The Cloud owner account does not need a project invitation.", route.path);
      const code = catalog.issue(organizationId, projectId, email);
      if (!code) return error("The project is unavailable.", route.path);
      const message = `You’re invited to join ${project.name} on PAIGE Cloud.\n\nNew accounts: ${origin}/signup\nSign in: ${origin}/sign-in\nAccept invitation: ${origin}/join\n\nUse ${email} and invitation code ${code}. The code expires after 48 hours. If you just created an account, sign in and enter the same code to accept.`;
      return page("Invitation ready", invitationPanel(email, code, `PAIGE Cloud invitation to ${project.name}`, message, accountPath + route.path, "Back to members"));
    }
    case "cancel-invite": {
      const email = normalizeEmail(form.get("email"));
      if (form.size !== 2 || !email) return error("Select a pending invitation.", route.path);
      catalog.cancelInvite(organizationId, projectId, email);
      break;
    }
    case "revoke": {
      const id = form.get("member");
      if (form.size !== 2 || !isProjectSlug(id) || !catalog.revoke(organizationId, projectId, id, accounts.emailFor(id))) {
        return error("Select a member whose access can be revoked.", route.path);
      }
      break;
    }
    default:
      return error("Select a project action.", route.path);
  }
  return redirect(route.path);
}

function validName(value) {
  return value && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
}
