import { useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Logo } from "../components";

// Shared split-screen shell for the public auth/registration pages
// (BranchPortal.tsx and BranchAccessPage.tsx's LoginView) — photo panel on
// the left with the marketing site's visual language (Outfit/Source Sans 3,
// --primary blue on slate), form card on the right. Matches MarketingHome.tsx
// so the whole "get access" journey reads as one product, not a bolt-on.

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
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(165deg, rgba(30,95,168,.35) 0%, rgba(15,23,42,.55) 55%, rgba(15,23,42,.88) 100%)" }} />
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 48 }}>
          <a href="#" onClick={e => { e.preventDefault(); onBack(); }} className="flex items-center gap-2.5">
            <Logo size={36} tone="dark" />
          </a>
          <div>
            <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: "#93c5fd", fontFamily: "var(--font-display)" }}>
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
            <Logo size={30} />
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

// Shared password field with a show/hide eye toggle -- every password input
// across the auth flows (login, set password, reset password) renders through
// this instead of a bare <input type="password">, so the toggle is the same
// everywhere rather than reimplemented per form.
export function PasswordInput({
  leftIcon, style, ...inputProps
}: {
  leftIcon?: ReactNode;
  style?: React.CSSProperties;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "style">) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      {leftIcon}
      <input {...inputProps} type={visible ? "text" : "password"} style={{ ...style, paddingRight: 38 }} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        style={{
          position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
          background: "none", border: 0, cursor: "pointer", padding: 4, display: "flex", color: "#9ca3af",
        }}
      >
        {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
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
// --primary, the one action colour in the product. Reads through the token
// rather than naming the blue directly, so the button you press to sign in
// can never drift from the buttons you press once you are inside.
export const authPrimaryButton: React.CSSProperties = {
  width: "100%", padding: "13px 20px", borderRadius: 12, border: 0,
  background: "var(--primary)", color: "#fff", fontFamily: "var(--font-display)",
  fontWeight: 700, fontSize: 15, cursor: "pointer", transition: "opacity .15s, transform .15s",
};
