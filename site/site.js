const nav = document.querySelector("#site-nav");
const header = document.querySelector(".nav-shell");
const menuToggle = document.querySelector(".menu-toggle");
const compact = matchMedia("(max-width: 860px)");
const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
const menus = [...nav.querySelectorAll(".nav-group")];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function closeMenus(except) {
  for (const menu of menus) if (menu !== except) menu.open = false;
}

function setMobileMenu(open) {
  menuToggle.hidden = !compact.matches;
  menuToggle.setAttribute("aria-expanded", String(open));
  nav.hidden = compact.matches && !open;
  if (!open) closeMenus();
}

menuToggle.addEventListener("click", () => setMobileMenu(nav.hidden));
compact.addEventListener("change", () => setMobileMenu(false));
setMobileMenu(false);
for (const menu of menus) {
  const summary = menu.querySelector("summary");
  const panel = menu.querySelector(".mega");
  const desktopMouse = event => !compact.matches && finePointer.matches && event.pointerType === "mouse";

  menu.addEventListener("pointerenter", event => {
    if (desktopMouse(event)) {
      closeMenus(menu);
      menu.open = true;
    }
  });
  menu.addEventListener("pointerleave", event => {
    if (desktopMouse(event) && !panel.contains(document.activeElement)) menu.open = false;
  });
  summary.addEventListener("click", event => {
    if (desktopMouse(event) && event.detail > 0) {
      event.preventDefault();
      closeMenus(menu);
      menu.open = true;
    }
  });
  menu.addEventListener("toggle", () => {
    if (menu.open) closeMenus(menu);
  });
}

nav.addEventListener("click", event => {
  const link = event.target.closest("a");
  if (!link) return;
  if (link.hash && link.pathname === location.pathname) {
    const destination = document.getElementById(link.hash.slice(1));
    if (destination) {
      destination.tabIndex = -1;
      destination.focus({ preventScroll: true });
    }
  }
  setMobileMenu(false);
});
header.addEventListener("focusout", event => {
  if (compact.matches && event.relatedTarget && !header.contains(event.relatedTarget)) setMobileMenu(false);
});
document.addEventListener("click", event => {
  if (!event.target.closest(".nav-shell")) setMobileMenu(false);
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const openMenu = menus.find(menu => menu.open);
  if (openMenu) {
    openMenu.open = false;
    openMenu.querySelector("summary").focus();
  } else if (compact.matches && !nav.hidden) {
    setMobileMenu(false);
    menuToggle.focus();
  }
});

const stages = [
  ["Inspect the scope", "PAIGE reads the application, environment, and currently serving release in this example.", "Plan the release"],
  ["Propose one change", "The plan pins Candidate B to a reviewed commit and keeps Release A as the recovery target.", "Review authorization"],
  ["Authorize the rehearsal", "The proposed change is limited to the example application. No work runs until you authorize this step.", "Authorize local rehearsal"],
  ["Execute the approved step", "The fixture starts Candidate B in an isolated environment and records what was started.", "Verify the result"],
  ["Check before promotion", "The fixture’s health check fails. Release A stays in service and the verification result is recorded.", "Evaluate the outcome"],
  ["Review what happened", "The execution record links the candidate to the failed health check and the retained rollback target.", "Review the improvement"],
  ["Keep the evidence", "The proposed improvement is to check readiness before promotion. It remains a proposal until reviewed.", "Run again"]
];
const rehearsal = document.querySelector(".rehearsal");
const positions = [...rehearsal.querySelectorAll(".steps li")];
const output = rehearsal.querySelector(".step-output");
const next = rehearsal.querySelector(".step-next");
const reset = rehearsal.querySelector(".step-reset");
const releaseResult = rehearsal.querySelector(".rehearsal-result");
let stage = -1;

function renderStage() {
  const [title, summary, button] = stages[stage] ?? [
    "Prepare a release", "Walk through a release fixture and see where authorization and verification fit.", "Start rehearsal"
  ];
  positions.forEach((position, index) => {
    if (index === stage) position.setAttribute("aria-current", "step");
    else position.removeAttribute("aria-current");
    position.toggleAttribute("data-done", index < stage);
  });
  output.querySelector(".step-title").textContent = title;
  output.querySelector(".step-copy").textContent = summary;
  next.textContent = button;
  reset.hidden = stage === -1;
  releaseResult.hidden = stage < 3;
  releaseResult.dataset.failed = String(stage >= 4);
  releaseResult.querySelector(".candidate-health").textContent = stage >= 4 ? "Health check failed" : "Starting in isolation";
  if (!reducedMotion.matches) {
    for (const animation of output.getAnimations()) animation.cancel();
    output.animate([{ opacity: 0.72, transform: "translateY(2px)" }, { opacity: 1, transform: "none" }],
      { duration: 175, easing: "ease-out" });
  }
}
next.addEventListener("click", () => {
  stage = (stage + 1) % stages.length;
  renderStage();
});
reset.addEventListener("click", () => {
  stage = -1;
  renderStage();
  next.focus();
});

const exhibitValues = {
  compute: {
    web: { runtime: "Container", event: "HTTPS request", evidence: "Serving revision and health" },
    worker: { runtime: "Persistent worker", event: "Authorized job", evidence: "Checkpoint, completion, and receipt" }
  },
  data: {
    own: { code: "200 OK", result: "Returns only the caller’s organization record." },
    foreign: { code: "404 Not Found", result: "No organization record is disclosed." }
  },
  release: {
    candidate: { image: "Candidate B", health: "Check failed", action: "Keep A serving" },
    known: { image: "Known-good A", health: "Check passed", action: "Retain as recovery target" }
  }
};
for (const exhibit of document.querySelectorAll("[data-exhibit]")) {
  const buttons = exhibit.querySelectorAll("[data-view]");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const option of buttons) option.setAttribute("aria-pressed", String(option === button));
      const section = exhibit.dataset.exhibit;
      const values = exhibitValues[section][button.dataset.view];
      for (const field of exhibit.querySelectorAll("[data-output]")) {
        field.textContent = values[field.dataset.output];
      }
      if (section === "data") {
        exhibit.querySelector(".access-readout").dataset.tone = button.dataset.view === "own" ? "allow" : "deny";
      }
    });
  }
}
