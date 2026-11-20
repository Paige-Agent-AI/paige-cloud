import { lazy, Suspense } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { SiteShell } from "@/marketing/SiteShell";
import "@/marketing/home.css";

const Home = lazy(() => import("@/pages/PaigeHome"));
const About = lazy(() => import("@/pages/About"));
const Pricing = lazy(() => import("@/pages/Pricing"));
const Blog = lazy(() => import("@/pages/Blog"));
const Terms = lazy(() => import("@/pages/Terms"));
const Privacy = lazy(() => import("@/pages/Privacy"));
const SmsTerms = lazy(() => import("@/pages/SmsTerms"));

function UnavailableInPreview() {
  return (
    <SiteShell>
      <section className="pa-section" aria-labelledby="preview-unavailable">
        <div className="pa-wrap">
          <h1 id="preview-unavailable" className="pa-h2">This page is unavailable in preview</h1>
          <p className="pa-lead">The public PAIGE Cloud preview has no sign-in or customer actions.</p>
          <Link to="/" className="pa-btn pa-btn--line">Back to the PAIGE homepage</Link>
        </div>
      </section>
    </SiteShell>
  );
}

export default function PreviewApp() {
  return (
    <BrowserRouter>
      <Suspense fallback={<p role="status">Loading PAIGE…</p>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/blog" element={<Blog />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/sms-terms" element={<SmsTerms />} />
          <Route path="/premium" element={<Navigate to="/" replace />} />
          <Route path="/legacy" element={<Navigate to="/" replace />} />
          <Route path="*" element={<UnavailableInPreview />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
