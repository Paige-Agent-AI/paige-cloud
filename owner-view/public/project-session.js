const workspace = document.getElementById("main");
const remaining = Number(workspace.dataset.sessionRemaining);
const deadline = Date.now() + remaining;
const sessionEvents = new BroadcastChannel("paige-owner-session");

function hideProjects() {
  workspace.hidden = true;
  workspace.replaceChildren();
  document.title = "PAIGE Cloud";
}

function signInAgain() {
  hideProjects();
  location.replace("/sign-in");
}

document.querySelector('form[action="/sign-out"]').addEventListener("submit", () => {
  hideProjects();
  sessionEvents.postMessage("signed-out");
});
sessionEvents.addEventListener("message", (event) => {
  if (event.data === "signed-out") signInAgain();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() >= deadline) signInAgain();
});
window.addEventListener("pagehide", hideProjects);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.replace(workspace.dataset.projectHome);
});

if (Number.isFinite(remaining) && remaining > 0) {
  setTimeout(signInAgain, remaining);
  workspace.hidden = false;
} else {
  signInAgain();
}
