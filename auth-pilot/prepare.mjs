import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
const pin = readFileSync(new URL("../upstream.commit", import.meta.url), "utf8").trim();
const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });
if (git("rev-parse", "HEAD").trim() !== pin) throw new Error("Wrong PAIGE source commit");
if (git("diff", "HEAD", "--", "src", "package.json", "package-lock.json", "tailwind.config.ts").trim()) {
  throw new Error("Pinned PAIGE inputs have changed");
}

// Incorporate the existing PAIGE visual components without importing onboarding,
// recovery, provider controls or the full application bootstrap.
function extract(file, start, end, marker) {
  const lines = git("show", `${pin}:src/pages/${file}.tsx`).split(/\r?\n/);
  const fragment = lines.slice(start - 1, end).join("\n");
  if (!fragment.includes(marker)) throw new Error(`Recheck the ${file} UI at the new upstream pin: ${marker}`);
  return fragment;
}

const auth = (start, end, marker) => extract("Auth", start, end, marker);
const theme = [auth(496, 500, "const platformFeatures"), auth(509, 509, "Bricolage Grotesque"),
  auth(515, 538, "const goldTheme")].join("\n");
const brand = [auth(599, 611, "Left Panel"), auth(614, 614, 'className="relative z-10"'),
  auth(632, 637, "PaigeCommandMark").replace('<Link to="/"', "<div").replace("</Link>", "</div>"),
  "</div>", auth(641, 649, "Center — Hero Message").replace('{isClientInvite ? "Your private client portal" : "Operations · Follow-ups · Follow-through"}', "Operations · Follow-ups · Follow-through"),
  auth(662, 671, "She runs your"), auth(673, 709, "features.map").replace("features.map", "platformFeatures.map")
    .replace('{isClientInvite ? `Your private workspace with ${brandName}` : "Built deliberately for founder-led Solo businesses"}', "Built deliberately for founder-led Solo businesses")].join("\n");
const heading = [auth(762, 762, 'className="space-y-2"'), auth(780, 784, "headingTitle")
  .replace("{headingTitle}", "Welcome back").replace("{headingSub}", "Sign in to your workspace")].join("\n");
const fields = [auth(834, 848, 'id="email"').replace('type="email"', 'type="email" autoComplete="username"'),
  auth(894, 898, 'htmlFor="password"'), auth(908, 929, 'id="password"').replace('id="password"', 'id="password" autoComplete="current-password"'),
  "</div>", auth(1012, 1026, 'type="submit"').replace(/^.*style=\{brandColor.*\r?\n/m, "")
    .replace("disabled={isLoading || (!isLogin && (!consentAgreements || !consentDataUsage))}", "disabled={isLoading}")
    .replace('{isLogin ? "Signing in..." : "Creating account..."}', "Signing in…")
    .replace('<>{isLogin ? "Sign In" : "Create Solo Beta account"}</>', '<>Sign In</>')]
  .join("\n").replaceAll('${isLogin ? "h-12" : "h-10"}', "h-12");
const chooser = extract("ChooseAccount", 256, 264, "Where do you want to work?")
  .replace("text-slate-500 dark:text-slate-400", "text-muted-foreground").replace("Where do you want to work?", "Your PAIGE workspace");

const frontend = fileURLToPath(new URL("./frontend/", import.meta.url));
const entry = readFileSync(join(frontend, "main.tsx"), "utf8")
  .replace("// PAIGE_AUTH_THEME", theme)
  .replace("{/* PAIGE_AUTH_BRAND */}", brand)
  .replace("{/* PAIGE_AUTH_HEADING */}", heading)
  .replace("{/* PAIGE_AUTH_FIELDS */}", fields)
  .replace("{/* PAIGE_ACCOUNT_HEADER */}", chooser);
const unsupported = entry.match(/[^\n]*(PAIGE_AUTH_|PAIGE_ACCOUNT_HEADER|isClientInvite|isLogin|brandName|signup|passwordRecovery|signInWithOAuth)[^\n]*/);
if (unsupported) {
  throw new Error(`Pilot entry contains an unsupported fragment: ${unsupported[0].trim()}`);
}

mkdirSync(join(source, "src", "pilot"), { recursive: true });
writeFileSync(join(source, "src", "pilot", "main.tsx"), entry);
copyFileSync(join(frontend, "pilot.css"), join(source, "src", "pilot", "pilot.css"));
for (const file of ["index.html", "vite.config.mjs"]) copyFileSync(join(frontend, file), join(source, `pilot-${file}`));
