import type { ReactNode } from "react";
import logoImg from "../assets/logo.png";

// Shared split-screen shell for the public auth/registration pages
// (BranchPortal.tsx and BranchAccessPage.tsx's LoginView) — photo panel on
// the left with the marketing site's visual language (Outfit/Source Sans 3,
// teal/navy palette), form card on the right. Matches MarketingHome.tsx so
// the whole "get access" journey reads as one product, not a bolt-on.

export function AuthShell({
  image, imageAlt, eyebrow, tagline, children, onBack, backLabel = "Back to PharmSync",
}: {
  image: string;
  imageAlt: string;
  eyebrow: string;
  tagline: string;
  children: ReactNode;
  onBack: () => void;
  backLabel?: string;
}) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", background: "#f8fafb" }}>
      {/* Photo panel */}
      <div className="hidden lg:block" style={{ flex: "0 0 44%", position: "relative", overflow: "hidden" }}>
        <img src={image} alt={imageAlt} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(165deg, rgba(13,148,136,.35) 0%, rgba(15,23,42,.55) 55%, rgba(15,23,42,.88) 100%)" }} />
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 48 }}>
          <a href="#" onClick={e => { e.preventDefault(); onBack(); }} className="flex items-center gap-2.5">
            <img src={logoImg} alt="PharmSync" className="w-8 h-8 object-contain" />
            <span className="text-lg font-bold" style={{ fontFamily: "var(--font-display)", color: "#fff" }}>
              Pharm<span style={{ color: "#5eead4" }}>Sync</span>
            </span>
          </a>
          <div>
            <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: "#5eead4", fontFamily: "var(--font-display)" }}>
              {eyebrow}
            </p>
            <p className="text-2xl font-extrabold" style={{ color: "#fff", fontFamily: "var(--font-display)", letterSpacing: "-0.02em", lineHeight: 1.3, maxWidth: 380 }}>
              {tagline}
            </p>
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header className="lg:hidden" style={{ padding: "18px 20px", borderBottom: "1px solid #e8edf4", background: "#fff" }}>
          <a href="#" onClick={e => { e.preventDefault(); onBack(); }} className="flex items-center gap-2.5">
            <img src={logoImg} alt="PharmSync" className="w-7 h-7 object-contain" />
            <span className="text-base font-bold" style={{ fontFamily: "var(--font-display)", color: "#0f172a" }}>
              Pharm<span style={{ color: "#0d9488" }}>Sync</span>
            </span>
          </a>
        </header>
        <div className="hidden lg:flex" style={{ justifyContent: "flex-end", padding: "20px 32px 0" }}>
          <a href="#" onClick={e => { e.preventDefault(); onBack(); }}
            className="text-sm font-semibold"
            style={{ color: "#6b7280", fontFamily: "var(--font-body)", textDecoration: "none" }}>
            ← {backLabel}
          </a>
        </div>
        <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 20px 56px" }}>
          <div style={{ width: "100%", maxWidth: 440 }}>{children}</div>
        </main>
      </div>
    </div>
  );
}

export const authCardHeading: React.CSSProperties = {
  fontFamily: "var(--font-display)", fontWeight: 800, letterSpacing: "-0.02em", color: "#0f172a",
};
export const authBody: React.CSSProperties = {
  fontFamily: "var(--font-body)", color: "#6b7280", lineHeight: 1.65,
};
export const authInput: React.CSSProperties = {
  width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid #e2e8f0",
  fontFamily: "var(--font-body)", fontSize: 14.5, color: "#0f172a", outline: "none",
  background: "#fff", transition: "border-color .15s, box-shadow .15s",
};
// Navy matches the site's primary CTA color (.btn-cta in index.css / the
// "Register Your Pharmacy" buttons on the marketing home page).
export const authPrimaryButton: React.CSSProperties = {
  width: "100%", padding: "13px 20px", borderRadius: 12, border: 0,
  background: "#1e5fa8", color: "#fff", fontFamily: "var(--font-display)",
  fontWeight: 700, fontSize: 15, cursor: "pointer", transition: "opacity .15s, transform .15s",
};
