import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Building2, ChevronRight, Eye, EyeOff, Loader2, Shield, TrendingUp, Zap } from "lucide-react";
import { PaigeCommandMark } from "@/components/brand/PaigeCommandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import "./pilot.css";

// PAIGE_AUTH_THEME

const signInPath = "/auth?mode=login";
const root = document.getElementById("root")!;
const authReady = root.dataset.authReady === "true";

function PasswordSignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!authReady || isLoading) return;
    setIsLoading(true);
    setError("");
    try {
      const reply = await fetch("/api/sign-in", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (reply.status === 204) {
        window.location.replace("/choose-account");
        return;
      }
      const errors: Record<number, string> = {
        401: "Check your email, password, and evaluator access.",
        403: "Paige could not confirm your access to the approved workspace.",
        409: "A pilot sign-in is already active. Sign out of that session or wait for it to expire.",
        423: "PAIGE sign-in opens after the evaluator is approved.",
      };
      setError(errors[reply.status] || "Paige sign-in is temporarily unavailable. Try again.");
    } catch {
      setError("Paige sign-in is temporarily unavailable. Try again.");
    } finally {
      setIsLoading(false);
      setPassword("");
    }
  }

  return (
    <main className="relative flex min-h-dvh text-[#F8F5EE]" style={goldTheme}>
      {/* PAIGE_AUTH_BRAND */}
      <section className="flex flex-1 flex-col px-6 sm:px-10">
        <div className="inline-flex items-center gap-2 py-5 xl:hidden">
          <PaigeCommandMark plated={false} className="h-8 w-8" />
          <span className="text-lg font-semibold" style={{ fontFamily: HEAD }}>Paige Agent</span>
        </div>
        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-[400px] space-y-8">
            {/* PAIGE_AUTH_HEADING */}
            {!authReady && <p role="status" className="rounded-xl border border-border bg-muted/50 p-4 text-sm">Sign-in opens after the evaluator and safety checks are approved.</p>}
            {error && <p role="alert" className="rounded-xl border border-amber-300/40 bg-amber-300/10 p-4 text-sm">{error}</p>}
            <form method="post" onSubmit={handleSubmit} className="space-y-5">
              <fieldset disabled={!authReady} className="space-y-5 disabled:opacity-55">
                {/* PAIGE_AUTH_FIELDS */}
              </fieldset>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}

type Workspace = { email: string; workspace: string; role: string };

function ChooseAccount() {
  const [account, setAccount] = useState<Workspace | null>(null);
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/account", { signal: controller.signal }).then(async (reply) => {
      if (reply.status === 401) window.location.replace(signInPath);
      else if (reply.ok) setAccount(await reply.json());
      else setError("Paige could not confirm your access to this workspace.");
    }).catch(() => {
      if (!controller.signal.aborted) setError("Paige could not load your workspace. Reload to try again.");
    });
    return () => controller.abort();
  }, []);

  async function signOut() {
    setLeaving(true);
    setError("");
    try {
      const reply = await fetch("/api/sign-out", { method: "POST" });
      if (reply.status === 204 || reply.status === 401) {
        sessionEnded();
        return;
      }
    } catch {
      // Leave the session in place when Supabase has not confirmed sign-out.
    }
    setError("Paige could not confirm sign-out. Try again.");
    setLeaving(false);
  }

  function sessionEnded() {
    setAccount(null);
    window.location.replace(signInPath);
  }

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:py-14" style={goldTheme}>
      <section className="mx-auto w-full max-w-xl rounded-3xl border border-border bg-card p-6 sm:p-9" aria-labelledby="account-picker-title">
        {/* PAIGE_ACCOUNT_HEADER */}
        {account && <p className="mt-2 text-sm leading-6 text-muted-foreground">Signed in as <strong className="text-foreground">{account.email}</strong>.</p>}
        {account && (
          <div className="mt-7 flex items-center gap-4 rounded-2xl border border-border bg-muted/50 p-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><Building2 aria-hidden className="h-5 w-5" /></span>
            <div><strong className="block text-base">{account.workspace}</strong><span className="text-xs capitalize text-muted-foreground">{account.role}</span></div>
          </div>
        )}
        {!account && !error && <p role="status" className="mt-7 text-sm text-muted-foreground">Loading your Paige account…</p>}
        {error && <p role="alert" className="mt-6 text-sm text-amber-200">{error}</p>}
        <Button className="mt-6 border border-border bg-muted/75" disabled={leaving} onClick={signOut}>{leaving ? "Signing out…" : "Sign out"}</Button>
      </section>
    </main>
  );
}

// Revalidate protected content when a browser restores the page after sign-out.
window.addEventListener("pageshow", (event) => {
  if (event.persisted && window.location.pathname === "/choose-account") window.location.reload();
});

createRoot(root).render(
  window.location.pathname === "/choose-account" ? <ChooseAccount /> : <PasswordSignIn />,
);
