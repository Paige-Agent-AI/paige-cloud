const base = "/api/cloud/auth";
const find = selector => document.querySelector(selector);
const status = find("[data-account-status]");
const failure = find("[data-account-error]") || status;
const credentials = find('[data-account-form="credentials"]');
const profile = find('[data-account-form="profile"]');
const workspace = find("[data-workspace]");
const links = find("[data-account-links]");
const sessionUpdates = typeof BroadcastChannel === "function" ? new BroadcastChannel("paige-cloud-session") : null;

const screens = {
  "/sign-in": {
    title: "Sign in", action: "Sign in", path: "/sign-in", password: "current-password",
    links: [["Forgot password?", "/recover"], ["Create an account", "/signup"]]
  },
  "/signup": {
    title: "Create your account", intro: "Registration is open to approved prelaunch evaluators.",
    action: "Send verification code", path: "/sign-up", password: "new-password",
    links: [["Already have an account? Sign in", "/sign-in"]]
  },
  "/verify-email": {
    title: "Verify your email", intro: "Enter the six-digit code sent to your email address.",
    action: "Verify email", path: "/verify-email", code: true,
    links: [["Back to sign in", "/sign-in"]]
  },
  "/recover": {
    title: "Recover your account", intro: "Enter the email address associated with your account.",
    action: "Send reset code", path: "/recover", links: [["Back to sign in", "/sign-in"]]
  },
  "/reset-password": {
    title: "Reset your password", intro: "Enter the code you received and choose a new password.",
    action: "Reset password", path: "/reset-password", password: "new-password", code: true,
    links: [["Request another reset code", "/recover"]]
  }
};

const errors = {
  invalid_credentials: "Check your email address and password, then try again.",
  registration_unavailable: "This email address is outside the evaluator group.",
  email_already_registered: "An account already exists for this address. Sign in or verify your email.",
  invalid_code: "Check the six-digit code and try again.",
  expired_code: "That code has expired. Request a new one.",
  invalid_password: "Check the password requirements and try again.",
  invalid_email: "Enter a valid email address.",
  invalid_name: "Enter a name with no more than 120 characters.",
  organization_exists: "Your first organization already exists. Reload the workspace to see it.",
  try_again_later: "Too many attempts. Wait a minute, then try again."
};

async function requestJson(url, method, body) {
  const response = await fetch(url, {
    method, credentials: "same-origin", cache: "no-store",
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });
  const result = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(errors[result?.error] ?? "PAIGE Cloud account access is temporarily unavailable. Try again.");
    error.status = response.status;
    error.code = result?.error;
    throw error;
  }
  return result;
}

function request(path, method = "GET", body) {
  return requestJson(base + path, method, body);
}

function showError(error) {
  failure.textContent = error.message;
  failure.hidden = false;
}

async function run(button, operation, isCurrent = () => true) {
  button.disabled = true;
  failure.textContent = "";
  if (failure !== status) failure.hidden = true;
  status.textContent = "Working…";
  try {
    await operation();
    if (isCurrent() && status.textContent === "Working…") status.textContent = "";
  } catch (error) {
    if (isCurrent()) {
      if (error.status === 401 && (workspace || (profile && !profile.hidden))) location.replace("/sign-in");
      else {
        if (failure !== status) status.textContent = "";
        showError(error);
      }
    }
  } finally {
    button.disabled = false;
  }
}

let screen;
let screenRevision = 0;
function showScreen(path, email = "", message = "", moveFocus = false) {
  screenRevision += 1;
  failure.textContent = "";
  failure.hidden = true;
  screen = screens[path] ?? screens["/sign-in"];
  document.title = screen.title + " · PAIGE Cloud";
  const heading = find("[data-account-heading]");
  heading.textContent = screen.title;
  find("[data-account-intro]").textContent = screen.intro ?? "";
  status.textContent = message;
  credentials.reset();
  const password = credentials.elements.password;
  password.required = Boolean(screen.password);
  password.disabled = !screen.password;
  password.autocomplete = screen.password || "current-password";
  password.minLength = screen.password === "new-password" ? 15 : 1;
  find("[data-password-field]").hidden = !screen.password;
  find("[data-password-note]").hidden = screen.password !== "new-password";
  credentials.elements.code.required = Boolean(screen.code);
  credentials.elements.code.disabled = !screen.code;
  find("[data-code-field]").hidden = !screen.code;
  find("[data-resend]").hidden = path !== "/verify-email";
  find("[data-account-submit]").textContent = screen.action;
  credentials.elements.email.value = email;
  links.replaceChildren(...screen.links.map(([label, href]) => {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    return link;
  }));
  credentials.hidden = false;
  if (moveFocus) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

function advance(path, email, message) {
  history.pushState(null, "", path);
  showScreen(path, email, message, true);
}

credentials?.addEventListener("submit", event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(credentials));
  const submitted = screen.path;
  const revision = screenRevision;
  const isCurrent = () => screenRevision === revision;
  run(event.submitter, async () => {
    try {
      await request(submitted, "POST", values);
    } catch (error) {
      if (isCurrent() && submitted === "/sign-in" && error.code === "verification_required") {
        advance("/verify-email", values.email, "Verify your email before signing in.");
        return;
      }
      throw error;
    }
    if (!isCurrent()) return;
    switch (submitted) {
      case "/sign-up": advance("/verify-email", values.email); break;
      case "/verify-email": advance("/sign-in", values.email, "Email verified. You can sign in now."); break;
      case "/recover": advance("/reset-password", values.email, "If this account is eligible, a code will arrive by email."); break;
      case "/reset-password":
        sessionUpdates?.postMessage("changed");
        advance("/sign-in", values.email, "Password reset. Sign in with your new password.");
        break;
      case "/sign-in":
        sessionUpdates?.postMessage("changed");
        location.replace("/mission-control");
        break;
    }
  }, isCurrent);
});

find("[data-resend]")?.addEventListener("click", event => {
  const email = credentials.elements.email;
  if (!email.reportValidity()) return;
  const revision = screenRevision;
  const isCurrent = () => screenRevision === revision;
  run(event.currentTarget, async () => {
    await request("/resend-code", "POST", { email: email.value });
    if (isCurrent()) status.textContent = "If this account is eligible, a new code will arrive by email.";
  }, isCurrent);
});

async function readAccount() {
  try {
    return await request("/account");
  } catch (error) {
    if (error.status === 401) location.replace("/sign-in");
    else showError(error);
    return null;
  }
}

const organizationControl = find("[data-active-organization]");
const projectStatus = find("[data-project-status]");
const projectRetry = find("[data-project-retry]");
const projectList = find("[data-projects]");
let projectRevision = 0;
let workspaceClosed = false;

function clearWorkspace() {
  if (!workspace) return;
  workspaceClosed = true;
  projectRevision++;
  projectList?.replaceChildren();
  const projectLink = find("[data-project-link]");
  if (projectLink) projectLink.hidden = true;
  find("[data-account-content]").hidden = true;
}

if (workspace) {
  const refreshWorkspace = () => {
    clearWorkspace();
    location.reload();
  };
  sessionUpdates?.addEventListener("message", event => {
    if (event.data === "changed" && !workspaceClosed) refreshWorkspace();
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) refreshWorkspace();
  });
}

async function readRegistryList(path) {
  const result = await requestJson(`/api/cloud/v1${path}`, "GET");
  if (!Array.isArray(result)) throw new Error("Invalid registry response");
  return result;
}

function renderProject(project, registryPath, revision) {
  const row = document.createElement("li");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const name = document.createElement("strong");
  const role = document.createElement("span");
  const message = document.createElement("p");
  const apps = document.createElement("ul");
  name.textContent = project.name;
  role.textContent = project.role;
  message.setAttribute("role", "status");
  summary.append(name, role);
  details.append(summary, message, apps);
  row.append(details);
  let loading = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loading || revision !== projectRevision) return;
    loading = true;
    apps.replaceChildren();
    message.textContent = "Loading applications…";
    try {
      const records = await readRegistryList(`${registryPath}/${encodeURIComponent(project.id)}/applications`);
      if (revision !== projectRevision) return;
      apps.replaceChildren(...records.map(app => {
        const item = document.createElement("li");
        const name = document.createElement("strong");
        const targets = document.createElement("span");
        name.textContent = app.name;
        targets.textContent = app.environments.join(" · ");
        item.append(name, targets);
        return item;
      }));
      message.textContent = records.length ? "" : "No applications registered.";
    } catch (error) {
      if (revision !== projectRevision) return;
      if (error.status === 401) location.replace("/sign-in");
      else message.textContent = error.status === 404 ? "This project is no longer available to you."
        : "Applications are unavailable. Close and reopen the project to retry.";
    } finally {
      loading = false;
    }
  });
  return row;
}

async function loadProjects() {
  const revision = ++projectRevision;
  const organization = organizationControl.value;
  projectList.replaceChildren();
  projectRetry.hidden = true;
  find("#projects").hidden = !organization;
  find("[data-project-link]").hidden = !organization;
  if (!organization) return;
  const path = `/organizations/${encodeURIComponent(organization)}/projects`;
  projectStatus.textContent = "Loading projects…";
  try {
    const projects = await readRegistryList(path);
    if (revision !== projectRevision) return;
    projectList.replaceChildren(...projects.map(project => renderProject(project, path, revision)));
    projectStatus.textContent = projects.length ? "" : "No projects are available in this organization.";
  } catch (error) {
    if (revision !== projectRevision) return;
    if (error.status === 401) location.replace("/sign-in");
    else {
      projectStatus.textContent = error.status === 404 ? "This organization is no longer available to you."
        : "Projects are temporarily unavailable.";
      projectRetry.hidden = error.status === 404;
    }
  }
}

function renderOrganizations(organizations) {
  const organizationList = find("[data-organizations]");
  find('[data-account-form="organization"]').hidden = organizations.length > 0;
  // The authenticated HTML and static script can be cached and rolled back independently.
  organizationList.hidden = Boolean(organizationControl);
  if (!organizationControl) {
    organizationList.replaceChildren(...organizations.map(organization => {
      const item = document.createElement("li");
      const label = document.createElement("strong");
      const role = document.createElement("span");
      label.textContent = organization.name;
      role.textContent = organization.role;
      item.append(label, role);
      return item;
    }));
    return;
  }
  organizationControl.replaceChildren(...organizations.map(organization =>
    new Option(organization.name, organization.id)));
  find("[data-organization-picker]").hidden = !organizations.length;
  void loadProjects();
}

organizationControl?.addEventListener("change", loadProjects);
projectRetry?.addEventListener("click", () => {
  const heading = find("#projects-heading");
  heading.tabIndex = -1;
  heading.focus();
  void loadProjects();
});

async function showWorkspace() {
  const account = await readAccount();
  if (!account || workspaceClosed) return;
  find("[data-account-number]").textContent = account.number;
  find("[data-account-email]").textContent = account.email;
  renderOrganizations(account.organizations);
  find("[data-account-content]").hidden = false;
  status.textContent = "";
}

find('[data-account-form="organization"]')?.addEventListener("submit", event => {
  event.preventDefault();
  const name = event.currentTarget.elements.name.value;
  run(event.submitter, async () => {
    const organization = await request("/organizations", "POST", { name });
    renderOrganizations([organization]);
    status.textContent = "Organization created.";
    find("#organizations-heading").tabIndex = -1;
    find("#organizations-heading").focus();
  });
});

async function showProfile() {
  document.title = "Account settings · PAIGE Cloud";
  find("[data-account-heading]").textContent = "Account settings";
  status.textContent = "Checking your account…";
  const account = await readAccount();
  if (!account) return;
  find("[data-profile-email]").textContent = account.email;
  profile.elements.displayName.value = account.displayName ?? "";
  profile.hidden = false;
  find("[data-workspace-link]").hidden = false;
  status.textContent = "";
}

profile?.addEventListener("submit", event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const value = await request("/account", "PATCH", { displayName: profile.elements.displayName.value });
    profile.elements.displayName.value = value.displayName ?? "";
    status.textContent = "Changes saved.";
  });
});

for (const button of document.querySelectorAll("[data-sign-out]")) {
  button.addEventListener("click", () => run(button, async () => {
    await request("/sign-out", "POST");
    clearWorkspace();
    sessionUpdates?.postMessage("changed");
    location.replace("/sign-in");
  }));
}

if (workspace) showWorkspace().catch(showError);
else if (location.pathname === "/account") showProfile().catch(showError);
else {
  showScreen(location.pathname);
  addEventListener("popstate", () => showScreen(location.pathname));
}
