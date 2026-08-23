import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { requestBranchOtp, verifyBranchOtp, type BranchAccess } from "../lib/auth"
import { errorMessage as errorText } from "../lib/supabase"

// Pharmacy registration and the super-admin console live in a separately
// deployed app (the "Super Admin Portal" project in this repo), so these are
// real external links rather than in-app routes. Locally that app serves on
// port 8444 while this dashboard serves on 8443; set VITE_ADMIN_PORTAL_URL to
// point at the deployed origin in any other environment.
const ADMIN_PORTAL_URL = (
  import.meta.env.VITE_ADMIN_PORTAL_URL ?? `${window.location.protocol}//${window.location.hostname}:8444`
).replace(/\/+$/, "")
const REGISTER_URL = `${ADMIN_PORTAL_URL}/#branch`
const SUPER_ADMIN_URL = `${ADMIN_PORTAL_URL}/#admin`

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RESEND_SECONDS = 30

const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches

// ─── Small shared pieces ──────────────────────────────────────────────────────

/** Fades + lifts its children in the first time they scroll into view. */
function Reveal({ children, delay = 0, style }: { children: ReactNode; delay?: number; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(prefersReducedMotion)

  useEffect(() => {
    if (shown) return
    const node = ref.current
    if (!node || typeof IntersectionObserver === "undefined") { setShown(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setShown(true); observer.disconnect() }
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [shown])

  return <div ref={ref} style={{
    opacity: shown ? 1 : 0,
    transform: shown ? "none" : "translateY(22px)",
    transition: `opacity .55s cubic-bezier(.22,.61,.36,1) ${delay}ms, transform .55s cubic-bezier(.22,.61,.36,1) ${delay}ms`,
    ...style,
  }}>{children}</div>
}

function Logo({ size = 34, subtitle = true }: { size?: number; subtitle?: boolean }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    <div style={{
      width: size, height: size, borderRadius: size * 0.28, flexShrink: 0,
      background: "linear-gradient(140deg, var(--primary), var(--accent))",
      color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Sans', sans-serif", fontWeight: 800, fontSize: size * 0.4,
      boxShadow: "0 6px 18px rgba(30,138,74,.28)",
    }}>Rx</div>
    <div style={{ lineHeight: 1.15 }}>
      <div style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 700, fontSize: 15, color: "var(--ink)", letterSpacing: "-0.01em" }}>PharmSync</div>
      {subtitle && <div style={{ fontSize: 10, color: "var(--ink-muted)", fontWeight: 500 }}>The Pharmacy Sync</div>}
    </div>
  </div>
}

const primaryButtonStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
  padding: "12px 22px", borderRadius: "var(--radius)", border: 0,
  background: "linear-gradient(140deg, var(--primary), var(--accent))", color: "#fff",
  font: "inherit", fontWeight: 700, fontSize: 14, cursor: "pointer",
  boxShadow: "0 10px 24px rgba(30,138,74,.26)",
  transition: "transform .18s ease, box-shadow .18s ease, opacity .18s ease",
}

const ghostButtonStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
  padding: "12px 20px", borderRadius: "var(--radius)",
  border: "1px solid var(--border-strong)", background: "var(--surface)", color: "var(--ink-mid)",
  font: "inherit", fontWeight: 600, fontSize: 14, cursor: "pointer", textDecoration: "none",
  transition: "transform .18s ease, border-color .18s ease, background .18s ease",
}

function lift(event: { currentTarget: HTMLElement }, on: boolean) {
  event.currentTarget.style.transform = on ? "translateY(-2px)" : "none"
}

// ─── Feature copy ─────────────────────────────────────────────────────────────
// Honest status labels: "Live" = the screen exists and reads the pharmacy
// database today; "In build" = the schema and workflow are designed and the
// screen is still being connected.

interface Feature { icon: string; title: string; body: string; live: boolean }

const FEATURES: Feature[] = [
  {
    icon: "🏥", live: true, title: "Multi-branch inventory",
    body: "Products, variants, batches and stock levels are tracked per branch. Every signed-in account is scoped to the one branch it belongs to, so a branch only ever queries its own stock.",
  },
  {
    icon: "📦", live: true, title: "Barcode-tracked receiving",
    body: "Deliveries are received with a parent-carton / child-pack model. The server derives piece counts from cartons × packs × pieces, so quantities are never trusted from the browser.",
  },
  {
    icon: "🏷️", live: true, title: "Barcode manager",
    body: "Every carton and pack created at receiving gets its own barcode, printable and searchable later from the batch it belongs to.",
  },
  {
    icon: "👥", live: true, title: "Role-based branch access",
    body: "Owner, manager, pharmacist and staff roles decide which screens a user sees. Sign-in is a code emailed to an activated account — there are no shared passwords to pass around.",
  },
  {
    icon: "⏳", live: false, title: "Low-stock & expiry alerts",
    body: "Batch expiry dates and reorder thresholds are already recorded at receiving. The alerting screen that surfaces short-dated and thin stock is being connected to that data now.",
  },
  {
    icon: "🧾", live: false, title: "Sales, POS & insurance",
    body: "Sales, receipts and insurance claim tables are modelled against the same branch-scoped stock. Those screens are still in build and show no invented figures until they are wired up.",
  },
]

const STEPS: { title: string; body: string }[] = [
  { title: "Register your pharmacy", body: "Submit your pharmacy name, phone number, email and location in the registration portal." },
  { title: "Verification call", body: "A super admin calls the number you gave to confirm the pharmacy is real before approving it." },
  { title: "Activate with a code", body: "On approval a 6-digit code is emailed to you. Entering it creates your branch and its permanent branch code." },
  { title: "Sign in here", body: "From then on, open this dashboard and sign in with that same email — a fresh code is emailed each time." },
]

// ─── Landing view ─────────────────────────────────────────────────────────────

function HomeView({ onLogin }: { onLogin: () => void }) {
  const animate = !prefersReducedMotion()

  return <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--ink)", overflowX: "hidden" }}>

    {/* Header */}
    <header style={{
      position: "sticky", top: 0, zIndex: 20,
      background: "rgba(255,255,255,.82)", backdropFilter: "blur(10px)",
      borderBottom: "1px solid var(--border)",
    }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "12px 22px", display: "flex", alignItems: "center", gap: 14 }}>
        <Logo />
        <div style={{ flex: 1 }} />
        <a href={REGISTER_URL} target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-mid)", textDecoration: "none", padding: "8px 10px", borderRadius: 8, transition: "color .16s, background .16s" }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--primary)"; e.currentTarget.style.background = "var(--primary-light)" }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--ink-mid)"; e.currentTarget.style.background = "transparent" }}
        >Register pharmacy</a>
        <a href={SUPER_ADMIN_URL} target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-mid)", textDecoration: "none", padding: "8px 10px", borderRadius: 8, transition: "color .16s, background .16s" }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--primary)"; e.currentTarget.style.background = "var(--primary-light)" }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--ink-mid)"; e.currentTarget.style.background = "transparent" }}
        >Super admin</a>
        <button type="button" onClick={onLogin}
          style={{ ...primaryButtonStyle, padding: "9px 18px", fontSize: 13, boxShadow: "0 6px 16px rgba(30,138,74,.22)" }}
          onMouseEnter={e => lift(e, true)} onMouseLeave={e => lift(e, false)}
        >Branch login</button>
      </div>
    </header>

    {/* Hero */}
    <section style={{ position: "relative", overflow: "hidden" }}>
      <div aria-hidden="true" style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(720px 380px at 78% -8%, rgba(52,211,153,.30), transparent 62%), radial-gradient(560px 320px at 4% 12%, rgba(30,138,74,.13), transparent 60%)",
      }} />
      <div style={{
        position: "relative", maxWidth: 1100, margin: "0 auto",
        padding: "68px 22px 74px", display: "grid", gap: 46,
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", alignItems: "center",
      }}>
        <div style={animate ? { animation: "psync-rise .7s cubic-bezier(.22,.61,.36,1) both" } : undefined}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 20,
            padding: "6px 13px", borderRadius: 999, background: "var(--primary-light)",
            border: "1px solid var(--border-strong)", color: "var(--primary)", fontSize: 12, fontWeight: 700,
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: "50%", background: "var(--primary)",
              animation: animate ? "psync-pulse 1.9s ease-in-out infinite" : undefined,
            }} />
            Branch-scoped pharmacy operations
          </div>

          <h1 style={{
            margin: 0, fontFamily: "'DM Sans', sans-serif", fontWeight: 800,
            fontSize: "clamp(34px, 5.2vw, 52px)", lineHeight: 1.06, letterSpacing: "-0.03em", color: "var(--ink)",
          }}>
            Every branch on<br />
            <span style={{
              background: "linear-gradient(100deg, var(--primary), var(--primary-mid))",
              WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
            }}>one live inventory.</span>
          </h1>

          <p style={{ margin: "18px 0 0", maxWidth: 480, fontSize: 16, lineHeight: 1.62, color: "var(--ink-muted)" }}>
            PharmSync keeps stock, batches and barcodes for a pharmacy network in a single database — received once at the
            carton, counted down to the piece, and visible only to the branch it belongs to.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 30 }}>
            <button type="button" onClick={onLogin} style={primaryButtonStyle}
              onMouseEnter={e => lift(e, true)} onMouseLeave={e => lift(e, false)}
            >Branch login <span aria-hidden="true">→</span></button>
            <a href={REGISTER_URL} target="_blank" rel="noopener noreferrer" style={ghostButtonStyle}
              onMouseEnter={e => { lift(e, true); e.currentTarget.style.borderColor = "var(--primary)" }}
              onMouseLeave={e => { lift(e, false); e.currentTarget.style.borderColor = "var(--border-strong)" }}
            >Register your pharmacy <span aria-hidden="true" style={{ fontSize: 11 }}>↗</span></a>
          </div>

          <p style={{ margin: "16px 0 0", fontSize: 12.5, color: "var(--ink-muted)" }}>
            Managing the network?{" "}
            <a href={SUPER_ADMIN_URL} target="_blank" rel="noopener noreferrer"
              style={{ color: "var(--primary)", fontWeight: 700, textDecoration: "none", borderBottom: "1px solid var(--border-strong)" }}
            >Super admin sign-in ↗</a>
          </p>
        </div>

        <HeroDiagram animate={animate} />
      </div>
    </section>

    {/* Features */}
    <section id="features" style={{ background: "var(--surface)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "66px 22px 72px" }}>
        <Reveal>
          <div style={{ maxWidth: 620 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--primary)" }}>What the system does</div>
            <h2 style={{ margin: "10px 0 0", fontFamily: "'DM Sans', sans-serif", fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--ink)" }}>
              Built around how a pharmacy actually receives and sells stock
            </h2>
            <p style={{ margin: "12px 0 0", fontSize: 14.5, lineHeight: 1.62, color: "var(--ink-muted)" }}>
              Each card below says plainly whether the screen is live in this dashboard today or still being connected to the
              database. Nothing here is a mock-up figure.
            </p>
          </div>
        </Reveal>

        <div style={{ marginTop: 34, display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))" }}>
          {FEATURES.map((feature, index) => (
            <Reveal key={feature.title} delay={index * 70}>
              <article style={{
                height: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg)", padding: 22,
                transition: "transform .2s ease, box-shadow .2s ease, border-color .2s ease",
              }}
                onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.boxShadow = "0 16px 34px rgba(12,30,18,.09)"; e.currentTarget.style.borderColor = "var(--border-strong)" }}
                onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.borderColor = "var(--border)" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <span style={{
                    width: 38, height: 38, borderRadius: 11, background: "var(--primary-light)",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0,
                  }}>{feature.icon}</span>
                  <span style={{
                    marginLeft: "auto", fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase",
                    padding: "3px 9px", borderRadius: 999,
                    background: feature.live ? "var(--primary-light)" : "#fef3c7",
                    color: feature.live ? "var(--primary)" : "var(--warning)",
                    border: `1px solid ${feature.live ? "var(--border-strong)" : "#fcd34d"}`,
                  }}>{feature.live ? "Live" : "In build"}</span>
                </div>
                <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 700, color: "var(--ink)" }}>{feature.title}</h3>
                <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.6, color: "var(--ink-muted)" }}>{feature.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>

    {/* How onboarding works */}
    <section style={{ maxWidth: 1100, margin: "0 auto", padding: "66px 22px 72px" }}>
      <Reveal>
        <div style={{ maxWidth: 620 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--primary)" }}>Getting access</div>
          <h2 style={{ margin: "10px 0 0", fontFamily: "'DM Sans', sans-serif", fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--ink)" }}>
            Four steps from application to dashboard
          </h2>
        </div>
      </Reveal>

      <ol style={{ listStyle: "none", margin: "32px 0 0", padding: 0, display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
        {STEPS.map((step, index) => (
          <Reveal key={step.title} delay={index * 80}>
            <li style={{ height: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 20 }}>
              <div style={{
                width: 28, height: 28, borderRadius: 9, background: "var(--primary)", color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13, marginBottom: 12,
              }}>{index + 1}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{step.title}</div>
              <p style={{ margin: "6px 0 0", fontSize: 12.5, lineHeight: 1.58, color: "var(--ink-muted)" }}>{step.body}</p>
            </li>
          </Reveal>
        ))}
      </ol>
    </section>

    {/* Closing call to action */}
    <section style={{ padding: "0 22px 74px" }}>
      <Reveal>
        <div style={{
          maxWidth: 1056, margin: "0 auto", borderRadius: 20, padding: "44px 30px", textAlign: "center",
          background: "linear-gradient(135deg, var(--primary), var(--accent))", color: "#fff",
          boxShadow: "0 22px 48px rgba(30,138,74,.26)",
        }}>
          <h2 style={{ margin: 0, fontFamily: "'DM Sans', sans-serif", fontSize: 27, fontWeight: 800, letterSpacing: "-0.02em" }}>
            Ready to open your branch dashboard?
          </h2>
          <p style={{ margin: "12px auto 0", maxWidth: 520, fontSize: 14.5, lineHeight: 1.6, color: "rgba(255,255,255,.86)" }}>
            Already activated? Sign in with your branch email. New pharmacy? Send an application and a super admin will verify
            you by phone.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center", marginTop: 26 }}>
            <button type="button" onClick={onLogin}
              style={{ ...primaryButtonStyle, background: "#fff", color: "var(--primary)", boxShadow: "0 10px 24px rgba(6,40,20,.2)" }}
              onMouseEnter={e => lift(e, true)} onMouseLeave={e => lift(e, false)}
            >Branch login</button>
            <a href={REGISTER_URL} target="_blank" rel="noopener noreferrer"
              style={{ ...ghostButtonStyle, background: "rgba(255,255,255,.12)", borderColor: "rgba(255,255,255,.5)", color: "#fff" }}
              onMouseEnter={e => { lift(e, true); e.currentTarget.style.background = "rgba(255,255,255,.22)" }}
              onMouseLeave={e => { lift(e, false); e.currentTarget.style.background = "rgba(255,255,255,.12)" }}
            >Register your pharmacy ↗</a>
          </div>
        </div>
      </Reveal>
    </section>

    {/* Footer */}
    <footer style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}>
      <div style={{
        maxWidth: 1100, margin: "0 auto", padding: "22px", display: "flex", flexWrap: "wrap",
        alignItems: "center", gap: 14, fontSize: 12, color: "var(--ink-muted)",
      }}>
        <Logo size={28} subtitle={false} />
        <span style={{ flex: 1 }} />
        <a href={REGISTER_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--ink-muted)", textDecoration: "none" }}>Register a pharmacy</a>
        <a href={SUPER_ADMIN_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--ink-muted)", textDecoration: "none" }}>Super admin</a>
        <span>© {new Date().getFullYear()} PharmSync</span>
      </div>
    </footer>
  </div>
}

/** Schematic of the carton → pack → piece receiving model used by the app. */
function HeroDiagram({ animate }: { animate: boolean }) {
  const rows: { label: string; note: string; width: string; tone: string }[] = [
    { label: "Carton", note: "1 barcode per carton", width: "100%", tone: "var(--primary)" },
    { label: "Pack", note: "1 barcode per pack inside it", width: "72%", tone: "var(--accent)" },
    { label: "Piece", note: "counted and sold individually", width: "44%", tone: "var(--primary-mid)" },
  ]

  return <div style={animate ? { animation: "psync-rise .8s cubic-bezier(.22,.61,.36,1) .12s both" } : undefined}>
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 18,
      boxShadow: "0 26px 60px rgba(12,30,18,.12)", overflow: "hidden",
      animation: animate ? "psync-float 7s ease-in-out 1s infinite" : undefined,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-alt)" }}>
        {["#f87171", "#fbbf24", "#34d399"].map(color => (
          <span key={color} style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
        ))}
        <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 700, color: "var(--ink-mid)" }}>Stock receiving · delivery model</span>
      </div>

      <div style={{ padding: 20, display: "grid", gap: 14 }}>
        {rows.map((row, index) => (
          <div key={row.label}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{row.label}</span>
              <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>{row.note}</span>
            </div>
            <div style={{ height: 10, borderRadius: 999, background: "var(--bg-alt)", overflow: "hidden" }}>
              <div style={{
                width: row.width, height: "100%", borderRadius: 999,
                background: `linear-gradient(90deg, ${row.tone}, var(--primary-mid))`,
                transformOrigin: "left",
                animation: animate ? `psync-grow .8s cubic-bezier(.22,.61,.36,1) ${0.35 + index * 0.16}s both` : undefined,
              }} />
            </div>
          </div>
        ))}

        <div style={{
          marginTop: 4, borderRadius: "var(--radius)", border: "1px dashed var(--border-strong)",
          background: "var(--bg)", padding: "12px 14px",
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "var(--primary)",
          animation: animate ? "psync-fade .6s ease .95s both" : undefined,
        }}>
          cartons × packs × pieces = quantity_received
          <div style={{ marginTop: 5, fontFamily: "'Inter', sans-serif", fontSize: 11, color: "var(--ink-muted)" }}>
            Derived on the server at receiving, never sent from the browser.
          </div>
        </div>
      </div>
    </div>
  </div>
}

// ─── Login view ───────────────────────────────────────────────────────────────

function LoginView({ onAccess, onHome }: { onAccess: (access: BranchAccess) => void; onHome: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email")
  const [email, setEmail] = useState("")
  const [digits, setDigits] = useState(["", "", "", "", "", ""])
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  const boxes = useRef<Array<HTMLInputElement | null>>([])
  const verifying = useRef(false)
  const animate = !prefersReducedMotion()

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown(seconds => seconds - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  useEffect(() => {
    if (step === "code") boxes.current[0]?.focus()
  }, [step])

  async function sendCode(target: string, isResend: boolean) {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await requestBranchOtp(target)
      setStep("code")
      setCooldown(RESEND_SECONDS)
      setInfo(isResend ? `A new 6-digit code was sent to ${target}.` : `We emailed a 6-digit code to ${target}.`)
      if (isResend) { setDigits(["", "", "", "", "", ""]); boxes.current[0]?.focus() }
    } catch (reason) {
      setError(errorText(reason, "We could not send a sign-in code right now. Please try again."))
    } finally {
      setBusy(false)
    }
  }

  function submitEmail(event: React.FormEvent) {
    event.preventDefault()
    const target = email.trim().toLowerCase()
    if (!EMAIL_PATTERN.test(target)) { setError("Enter the email address your branch was activated with."); return }
    setEmail(target)
    void sendCode(target, false)
  }

  const verify = useCallback(async (code: string) => {
    if (verifying.current) return
    verifying.current = true
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const access = await verifyBranchOtp(email, code)
      onAccess(access)
    } catch (reason) {
      setError(errorText(reason, "That code was not accepted. Check the latest email or send a new code."))
      setDigits(["", "", "", "", "", ""])
      boxes.current[0]?.focus()
    } finally {
      verifying.current = false
      setBusy(false)
    }
  }, [email, onAccess])

  function writeDigits(next: string[]) {
    setDigits(next)
    setError(null)
    // Auto-submit as soon as all six boxes hold a digit (typed or pasted).
    if (next.every(digit => digit !== "")) void verify(next.join(""))
  }

  function changeDigit(index: number, value: string) {
    const digit = value.replace(/\D/g, "").slice(-1)
    const next = [...digits]
    next[index] = digit
    writeDigits(next)
    if (digit && index < 5) boxes.current[index + 1]?.focus()
  }

  function keyDigit(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault()
      const next = [...digits]
      next[index - 1] = ""
      setDigits(next)
      boxes.current[index - 1]?.focus()
    }
    if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); boxes.current[index - 1]?.focus() }
    if (event.key === "ArrowRight" && index < 5) { event.preventDefault(); boxes.current[index + 1]?.focus() }
  }

  function pasteDigits(event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6)
    if (!pasted) return
    event.preventDefault()
    const next = ["", "", "", "", "", ""].map((_, index) => pasted[index] ?? "")
    writeDigits(next)
    boxes.current[Math.min(pasted.length, 5)]?.focus()
  }

  const code = digits.join("")

  return <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
    <div aria-hidden="true" style={{
      position: "absolute", inset: 0, pointerEvents: "none",
      background: "radial-gradient(620px 320px at 82% -10%, rgba(52,211,153,.26), transparent 62%), radial-gradient(520px 300px at 2% 8%, rgba(30,138,74,.12), transparent 60%)",
    }} />

    <header style={{ position: "relative", padding: "16px 22px", borderBottom: "1px solid var(--border)", background: "rgba(255,255,255,.82)", backdropFilter: "blur(10px)" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center" }}>
        <Logo />
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onHome} style={{
          background: "none", border: 0, font: "inherit", fontSize: 13, fontWeight: 600,
          color: "var(--ink-muted)", cursor: "pointer", padding: "8px 10px", borderRadius: 8, transition: "color .16s, background .16s",
        }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--primary)"; e.currentTarget.style.background = "var(--primary-light)" }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--ink-muted)"; e.currentTarget.style.background = "transparent" }}
        >← Back to home</button>
      </div>
    </header>

    <main style={{ position: "relative", flex: 1, display: "grid", placeItems: "center", padding: "40px 20px 60px" }}>
      <section style={{
        width: "100%", maxWidth: 440, background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 18, padding: 30, boxShadow: "0 24px 60px rgba(12,30,18,.10)",
        animation: animate ? "psync-rise .5s cubic-bezier(.22,.61,.36,1) both" : undefined,
      }}>
        {step === "email" ? (
          <form onSubmit={submitEmail} noValidate>
            <div style={{
              width: 46, height: 46, borderRadius: 14, marginBottom: 16,
              background: "var(--primary-light)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21,
            }}>✉️</div>
            <h1 style={{ margin: 0, fontFamily: "'DM Sans', sans-serif", fontSize: 23, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--ink)" }}>
              Branch sign-in
            </h1>
            <p style={{ margin: "8px 0 22px", fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-muted)" }}>
              Enter the email your branch was activated with. We will email you a 6-digit code — there is no password to
              remember, and your branch is identified from the account itself.
            </p>

            <label htmlFor="branch-email" style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--ink-mid)", marginBottom: 6 }}>
              Branch email address
            </label>
            <input
              id="branch-email" type="email" autoComplete="email" autoFocus
              value={email} onChange={event => { setEmail(event.target.value); setError(null) }}
              placeholder="branch@yourpharmacy.com" disabled={busy}
              style={{
                width: "100%", padding: "11px 13px", border: `1px solid ${error ? "var(--negative)" : "var(--border)"}`,
                borderRadius: "var(--radius)", font: "inherit", fontSize: 14, color: "var(--ink)",
                background: busy ? "var(--bg)" : "#fff", outline: "none", transition: "border-color .16s",
              }}
            />

            {error && <Notice tone="error" animate={animate}>{error}</Notice>}

            <button type="submit" disabled={busy} style={{ ...primaryButtonStyle, width: "100%", marginTop: 18, opacity: busy ? 0.7 : 1 }}
              onMouseEnter={e => { if (!busy) lift(e, true) }} onMouseLeave={e => lift(e, false)}
            >{busy ? <><Spinner animate={animate} /> Sending code…</> : "Email me a sign-in code"}</button>

            <p style={{ margin: "18px 0 0", fontSize: 12, lineHeight: 1.6, color: "var(--ink-muted)", textAlign: "center" }}>
              No account yet?{" "}
              <a href={REGISTER_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary)", fontWeight: 700, textDecoration: "none" }}>
                Register your pharmacy ↗
              </a>
            </p>
          </form>
        ) : (
          <div>
            <div style={{
              width: 46, height: 46, borderRadius: 14, marginBottom: 16,
              background: "var(--primary-light)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21,
            }}>🔑</div>
            <h1 style={{ margin: 0, fontFamily: "'DM Sans', sans-serif", fontSize: 23, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--ink)" }}>
              Enter your code
            </h1>
            <p style={{ margin: "8px 0 22px", fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-muted)" }}>
              We sent a 6-digit code to <strong style={{ color: "var(--ink)" }}>{email}</strong>. It expires shortly, so use the
              most recent email.
            </p>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              {digits.map((digit, index) => (
                <input
                  key={index}
                  ref={element => { boxes.current[index] = element }}
                  type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={1}
                  aria-label={`Digit ${index + 1} of 6`}
                  value={digit} disabled={busy}
                  onChange={event => changeDigit(index, event.target.value)}
                  onKeyDown={event => keyDigit(index, event)}
                  onPaste={pasteDigits}
                  onFocus={event => event.currentTarget.select()}
                  style={{
                    width: "100%", minWidth: 0, height: 56, textAlign: "center",
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 600,
                    color: error ? "var(--negative)" : "var(--ink)",
                    background: error ? "#fef2f2" : digit ? "var(--primary-light)" : "var(--bg)",
                    border: `1.5px solid ${error ? "#fca5a5" : digit ? "var(--border-strong)" : "var(--border)"}`,
                    borderRadius: "var(--radius)", outline: "none",
                    transition: "background .16s, border-color .16s, color .16s",
                  }}
                />
              ))}
            </div>

            {error && <Notice tone="error" animate={animate}>{error}</Notice>}
            {!error && info && <Notice tone="info" animate={animate}>{info}</Notice>}

            <button type="button" onClick={() => void verify(code)} disabled={busy || code.length < 6}
              style={{ ...primaryButtonStyle, width: "100%", marginTop: 18, opacity: busy || code.length < 6 ? 0.6 : 1, cursor: busy || code.length < 6 ? "not-allowed" : "pointer" }}
              onMouseEnter={e => { if (!busy && code.length === 6) lift(e, true) }} onMouseLeave={e => lift(e, false)}
            >{busy ? <><Spinner animate={animate} /> Verifying…</> : "Verify & open dashboard"}</button>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 16 }}>
              <button type="button" onClick={() => { setStep("email"); setDigits(["", "", "", "", "", ""]); setError(null); setInfo(null) }} disabled={busy}
                style={linkButtonStyle}
              >← Use a different email</button>
              <button type="button" onClick={() => void sendCode(email, true)} disabled={busy || cooldown > 0}
                style={{ ...linkButtonStyle, opacity: busy || cooldown > 0 ? 0.55 : 1, cursor: busy || cooldown > 0 ? "default" : "pointer" }}
              >{cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}</button>
            </div>
          </div>
        )}
      </section>
    </main>
  </div>
}

const linkButtonStyle: CSSProperties = {
  background: "none", border: 0, padding: 0, font: "inherit", fontSize: 12.5, fontWeight: 600,
  color: "var(--primary)", cursor: "pointer",
}

function Notice({ tone, children, animate }: { tone: "error" | "info"; children: ReactNode; animate: boolean }) {
  const error = tone === "error"
  return <div role={error ? "alert" : "status"} style={{
    marginTop: 14, padding: "10px 12px", borderRadius: "var(--radius)",
    background: error ? "#fef2f2" : "var(--primary-light)",
    border: `1px solid ${error ? "#fecaca" : "var(--border-strong)"}`,
    color: error ? "#b91c1c" : "var(--primary)",
    fontSize: 12.5, lineHeight: 1.5,
    animation: animate ? (error ? "psync-shake .4s ease" : "psync-fade .3s ease") : undefined,
  }}>{children}</div>
}

function Spinner({ animate }: { animate: boolean }) {
  return <span aria-hidden="true" style={{
    width: 14, height: 14, borderRadius: "50%",
    border: "2px solid rgba(255,255,255,.45)", borderTopColor: "#fff",
    display: "inline-block",
    animation: animate ? "psync-spin .7s linear infinite" : undefined,
  }} />
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default function BranchAccessPage({ onAccess }: { onAccess: (access: BranchAccess) => void }) {
  const [view, setView] = useState<"home" | "login">("home")

  useEffect(() => { window.scrollTo({ top: 0, behavior: "auto" }) }, [view])

  return view === "home"
    ? <HomeView onLogin={() => setView("login")} />
    : <LoginView onAccess={onAccess} onHome={() => setView("home")} />
}
