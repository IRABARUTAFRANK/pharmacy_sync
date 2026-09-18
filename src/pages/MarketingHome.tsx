import { useState, useEffect, useRef, type ReactNode } from "react";
import { Logo } from "../components";
import heroImg from "../assets/pharmacy_view.jpg";
import stockImg from "../assets/pharmacy_stock.jpg";
import productsImg from "../assets/products.jpg";
import operationsImg from "../assets/all-in-one-pharmacy-operations.jpg";
import videoSrc from "../assets/video-system-explained.mp4";
import { getPlatformStats, type PlatformStats } from "../lib/onboarding";
import { useTranslation, LanguageSwitcher } from "../lib/i18n";
import type { TranslationKey } from "../lib/i18n/en";

// Ported from the Figma "new home page" export (src/App.tsx there) as-is —
// same markup, classes, images and copy — with these changes: "Log in" /
// "Register Your Pharmacy" wired to real in-app navigation instead of
// placeholder hrefs, the component turned into one that takes an onLogin
// callback instead of being the app's own root, the trust-stat strip
// pulling this project's real counts instead of the design's hardcoded
// "12+ / 50k+ / 3" template numbers, and every string routed through
// useTranslation() (English / Kinyarwanda / French — see ../lib/i18n).
//
// Since then: a theme switcher (HOME_THEMES below) drives every brand accent
// on this page from one palette instead of scattered hex literals -- scoped
// entirely to this page via inline styles, deliberately never touching the
// app-wide --primary CSS variable the pharmacy dashboard and admin console
// both depend on (see index.css's own header comment on --primary being
// "the single brand colour for the whole product" -- changing it here would
// have silently reskinned the entire dashboard too). A sixth feature
// ("Multi-Branch Organizations") and a video showcase section were added to
// reflect the organization/branch-network capability built after this page
// was first ported, and copy that described unbuilt aspirational features
// (drone-assisted delivery) was corrected to what actually exists.

const REGISTER_URL = "#branch";

// ─── Intersection observer hook ──────────────────────────────────────────────
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".reveal, .reveal-left, .reveal-right");
    const io = new IntersectionObserver(
      (entries) => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add("visible"); }),
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);
}

// ─── Animated counter ─────────────────────────────────────────────────────────
function Counter({ to, suffix = "", duration = 1800 }: { to: number; suffix?: string; duration?: number }) {
  const [val, setVal] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const start = Date.now();
      const tick = () => {
        const p = Math.min((Date.now() - start) / duration, 1);
        const ease = 1 - Math.pow(1 - p, 3);
        setVal(Math.round(ease * to));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { threshold: 0.5 });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, [to, duration]);
  return <span ref={ref}>{val.toLocaleString()}{suffix}</span>;
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────
const icons = {
  stock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
      <polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/>
    </svg>
  ),
  barcode: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9V7a2 2 0 012-2h2M3 15v2a2 2 0 002 2h2m10-14h2a2 2 0 012 2v2m0 6v2a2 2 0 01-2 2h-2"/>
      <line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/>
      <line x1="13" y1="8" x2="13" y2="16"/><line x1="16" y1="8" x2="16" y2="16"/>
    </svg>
  ),
  chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
    </svg>
  ),
  truck: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/>
      <circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>
    </svg>
  ),
  org: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
      <rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  phone: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.01 1.21 2 2 0 012 .01h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/>
    </svg>
  ),
  key: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
    </svg>
  ),
  menu: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
  ),
  volumeOff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/>
      <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
    </svg>
  ),
  volumeOn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/>
      <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"/>
    </svg>
  ),
};

// ─── Home page theme system ───────────────────────────────────────────────────
// Scoped entirely to this page -- every colour below is applied via inline
// style, never through index.css's app-wide --primary variable (used by the
// pharmacy dashboard and admin console, which must not reskin themselves
// just because a visitor changed the marketing page's look). Four palettes,
// each built from health/care-appropriate hues already established
// elsewhere in this app's brand (clinical blue, wellness green, calm violet,
// warm amber) rather than arbitrary colours.
type HomeThemeId = "clinical" | "wellness" | "care" | "warmth" | "night";

interface HomeTheme {
  id: HomeThemeId;
  labelKey: TranslationKey;
  swatch: string;
  // One accent per feature card, in feature order (stock, barcode, sales, ai, distribution, organizations).
  accents: [string, string, string, string, string, string];
  gradientFrom: string;
  gradientTo: string;
  /** True only for "night" -- flips section backgrounds/text via structuralTokens() below, on top of the usual accent swap every theme does. */
  isDark?: boolean;
}

const HOME_THEMES: HomeTheme[] = [
  {
    id: "clinical", labelKey: "home.themeClinical", swatch: "#1e5fa8",
    accents: ["#1e5fa8", "#0d9488", "#0891b2", "#7c3aed", "#3b82f6", "#0369a1"],
    gradientFrom: "#1e5fa8", gradientTo: "#0d9488",
  },
  {
    id: "wellness", labelKey: "home.themeWellness", swatch: "#059669",
    accents: ["#059669", "#0d9488", "#16a34a", "#7c3aed", "#0891b2", "#15803d"],
    gradientFrom: "#059669", gradientTo: "#0d9488",
  },
  {
    id: "care", labelKey: "home.themeCare", swatch: "#7c3aed",
    accents: ["#7c3aed", "#c026d3", "#4f46e5", "#0d9488", "#1e5fa8", "#9333ea"],
    gradientFrom: "#7c3aed", gradientTo: "#4f46e5",
  },
  {
    id: "warmth", labelKey: "home.themeWarmth", swatch: "#d97706",
    accents: ["#d97706", "#dc2626", "#ea580c", "#0d9488", "#1e5fa8", "#b45309"],
    gradientFrom: "#d97706", gradientTo: "#dc2626",
  },
  {
    // Brightened/desaturated-up versions of the clinical palette's hues --
    // the plain clinical accents read fine as icon-chip fills or on white,
    // but several (the deep blues especially) drop below a comfortable
    // contrast ratio used as TEXT directly on this theme's near-black
    // backgrounds; every value here was picked to stay legible there while
    // keeping the same hue family, not just inverted.
    id: "night", labelKey: "home.themeNight", swatch: "#0f172a", isDark: true,
    accents: ["#60a5fa", "#2dd4bf", "#38bdf8", "#a78bfa", "#818cf8", "#38bdf8"],
    gradientFrom: "#60a5fa", gradientTo: "#2dd4bf",
  },
];

const HOME_THEME_STORAGE_KEY = "psync_home_theme";

function loadHomeTheme(): HomeThemeId {
  try {
    const saved = localStorage.getItem(HOME_THEME_STORAGE_KEY);
    if (HOME_THEMES.some(th => th.id === saved)) return saved as HomeThemeId;
  } catch {
    // private-browsing etc. -- default theme is fine
  }
  return "warmth";
}

// Appends an alpha channel to a #rrggbb literal -- every feature colour on
// this page also needs a soft tinted background (icon chips, bullet dots),
// derived from the same accent instead of a second hardcoded value that
// could drift out of sync with it.
function withAlpha(hex: string, alphaHex: string): string {
  return `${hex}${alphaHex}`;
}

// Structural surface colours (page/section backgrounds, body text, borders,
// card fills) -- separate from HOME_THEMES' brand accents above, and only
// ever has two states: light (every non-"night" theme) or dark (the "night"
// theme only). Kept as one small token set instead of scattering
// `isDark ? a : b` through every section, so the header/hero/reality/
// features/how-it-works sections (the ones actually painted light today;
// the products-showcase, final-CTA and footer sections are already dark by
// design and untouched either way) all read from the same source.
interface StructuralTokens {
  pageBg: string;
  headerBg: string;
  headerBorder: string;
  navText: string;
  navHover: string;
  sectionAltBg: string;
  cardBg: string;
  cardBorder: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textFaint: string;
}

function structuralTokens(isDark: boolean): StructuralTokens {
  if (!isDark) {
    return {
      pageBg: "#f8fafb", headerBg: "rgba(255,255,255,0.96)", headerBorder: "#e8edf4",
      navText: "#374151", navHover: "#f1f5f9", sectionAltBg: "#fff",
      cardBg: "#fff", cardBorder: "#e8edf4",
      textPrimary: "#0f172a", textSecondary: "#4b5563", textMuted: "#6b7280", textFaint: "#9ca3af",
    };
  }
  return {
    pageBg: "#0b1220", headerBg: "rgba(11,18,32,0.92)", headerBorder: "#1e293b",
    navText: "#cbd5e1", navHover: "#1e293b", sectionAltBg: "#0f172a",
    cardBg: "#111c2f", cardBorder: "#1e293b",
    textPrimary: "#f1f5f9", textSecondary: "#cbd5e1", textMuted: "#94a3b8", textFaint: "#64748b",
  };
}

// Compact "RWF 2.4M" / "RWF 842K" / "RWF 1,234" formatting for real revenue
// figures -- the hero bubble and the sales feature's key metric both need
// this, and a number pulled live from the database can land anywhere in
// that range depending on how much real activity has happened.
function formatCompactRwf(amount: number): string {
  if (amount >= 1_000_000) return `RWF ${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `RWF ${Math.round(amount / 1000)}K`;
  return `RWF ${Math.round(amount).toLocaleString()}`;
}

function ctaGradientStyle(theme: HomeTheme) {
  return {
    background: `linear-gradient(135deg, ${theme.gradientFrom}, ${theme.gradientFrom}, ${theme.gradientTo}, ${theme.gradientFrom})`,
    backgroundSize: "300% 300%",
  } as const;
}

function gradientTextStyle(theme: HomeTheme) {
  return {
    background: `linear-gradient(135deg, ${theme.gradientFrom}, ${theme.gradientTo})`,
    WebkitBackgroundClip: "text" as const,
    backgroundClip: "text" as const,
  };
}

function ThemeSwitcher({ active, onChange }: { active: HomeThemeId; onChange: (id: HomeThemeId) => void }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("home.themeLabel")}
      className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-xl"
      style={{ background: "#f1f5f9", border: "1px solid #e2e8f0" }}>
      {HOME_THEMES.map(th => (
        <button key={th.id} type="button" title={t(th.labelKey)} aria-label={t(th.labelKey)}
          aria-pressed={active === th.id}
          onClick={() => onChange(th.id)}
          style={{
            width: 18, height: 18, borderRadius: "50%", background: th.swatch, cursor: "pointer",
            padding: 0, boxSizing: "border-box",
            border: active === th.id ? "2px solid #0f172a" : "2px solid transparent",
            outline: active === th.id ? "2px solid #fff" : "none",
            outlineOffset: -4,
            transform: active === th.id ? "scale(1.18)" : "scale(1)",
            transition: "transform 0.15s ease, border-color 0.15s ease",
          }} />
      ))}
    </div>
  );
}

// ─── Floating stat card ───────────────────────────────────────────────────────
function StatBubble({ value, label, color, delay = 0, className = "" }: {
  value: string; label: string; color: string; delay?: number; className?: string;
}) {
  return (
    <div className={`animate-float ${className}`} style={{ animationDelay: `${delay}s` }}>
      <div className="px-4 py-3 rounded-2xl shadow-xl backdrop-blur-md"
        style={{ background: "rgba(255,255,255,0.95)", border: "1px solid rgba(255,255,255,0.6)", minWidth: 120 }}>
        <div className="text-xl font-bold" style={{ fontFamily: "var(--font-display)", color }}>{value}</div>
        <div className="text-xs mt-0.5" style={{ color: "#6b7280", fontFamily: "var(--font-body)" }}>{label}</div>
      </div>
    </div>
  );
}

// ─── Mini sparkline ───────────────────────────────────────────────────────────
function Sparkline({ color = "#1e5fa8" }: { color?: string }) {
  const pts = "0,40 20,32 40,38 60,20 80,24 100,12 120,18 140,8 160,14 180,4";
  return (
    <svg width="180" height="44" viewBox="0 0 180 44" fill="none">
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3}/>
          <stop offset="100%" stopColor={color} stopOpacity={0}/>
        </linearGradient>
      </defs>
      <polyline points={`${pts} 180,44 0,44`} fill="url(#sg)" stroke="none"/>
      <polyline className="chart-line" points={pts} stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ─── Video showcase ───────────────────────────────────────────────────────────
// Continuously-looping, muted background playback (autoplay only fires once
// this section actually scrolls into view, and the browser <video> element
// itself isn't even given a src until then -- the file is ~25MB, so a
// visitor who never scrolls this far never downloads a byte of it, and
// visitors who do scroll here aren't competing with it for hero-section
// bandwidth on first paint). A tap unmutes it in place, since the visible
// point of this specific video is to explain the system, not just to
// decorate the page -- silent looping alone would bury that.
function VideoShowcase({ theme }: { theme: HomeTheme }) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setShouldLoad(true); io.disconnect(); }
    }, { threshold: 0.25, rootMargin: "200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  function toggleSound() {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    setMuted(next);
    if (!next) void v.play().catch(() => {});
  }

  return (
    <section className="py-20 md:py-28" style={{ background: "#0b1220" }}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="reveal text-center mb-10">
          <p className="text-sm font-bold uppercase tracking-widest mb-3"
            style={{ color: theme.accents[0], fontFamily: "var(--font-display)" }}>
            {t("home.videoEyebrow")}
          </p>
          <h2 className="text-3xl md:text-4xl font-extrabold text-white mb-4"
            style={{ fontFamily: "var(--font-display)", letterSpacing: "-0.02em" }}>
            {t("home.videoHeading")}
          </h2>
          <p className="text-base max-w-xl mx-auto" style={{ color: "rgba(255,255,255,0.6)", fontFamily: "var(--font-body)", lineHeight: 1.7 }}>
            {t("home.videoBody")}
          </p>
        </div>

        <div ref={wrapRef} className="reveal relative rounded-3xl overflow-hidden shadow-2xl"
          style={{ aspectRatio: "16 / 9", background: "#000", border: `1px solid ${withAlpha(theme.accents[0], "33")}` }}>
          {shouldLoad && (
            <video
              ref={videoRef}
              src={videoSrc}
              className="w-full h-full object-cover"
              autoPlay
              loop
              muted={muted}
              playsInline
              preload="none"
            />
          )}
          <button type="button" onClick={toggleSound}
            className="absolute bottom-4 right-4 inline-flex items-center gap-2 px-3.5 py-2 rounded-full text-xs font-bold backdrop-blur-md"
            style={{ background: "rgba(15,23,42,0.75)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)", fontFamily: "var(--font-display)" }}>
            <div className="w-4 h-4">{muted ? icons.volumeOff : icons.volumeOn}</div>
            {t(muted ? "home.videoUnmute" : "home.videoMute")}
          </button>
        </div>
      </div>
    </section>
  );
}

// ─── Background bubbles ───────────────────────────────────────────────────────
// Large, soft, slowly-drifting blurred circles behind the hero copy --
// decorative only (aria-hidden, pointer-events none), theme-aware (drawn
// from the same accents as everything else so they never clash with
// whichever palette is active), and each on its own slow float/drift
// keyframe so they read as organic motion rather than a single mechanical
// pulse -- meant to evoke something closer to living, breathing motion than
// sharp geometric shapes, fitting for a healthcare product. Respects
// prefers-reduced-motion via the plain .animate-float rule this app already
// neutralizes globally (see index.css) plus its own bubble-drift keyframes
// added there.
function BackgroundBubbles({ theme }: { theme: HomeTheme }) {
  const bubbles = [
    { color: theme.accents[0], size: 420, top: "-12%", left: "-8%", duration: 22, delay: 0 },
    { color: theme.accents[1], size: 320, top: "35%", left: "78%", duration: 26, delay: 2 },
    { color: theme.accents[3], size: 260, top: "68%", left: "8%", duration: 30, delay: 4 },
  ];
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 0 }}>
      {bubbles.map((b, i) => (
        <div key={i} className="bubble-drift"
          style={{
            position: "absolute", top: b.top, left: b.left, width: b.size, height: b.size,
            borderRadius: "50%", background: b.color, opacity: 0.14, filter: "blur(60px)",
            animationDuration: `${b.duration}s`, animationDelay: `${b.delay}s`,
          }} />
      ))}
    </div>
  );
}

// ─── Main Landing Page ───────────────────────────────────────────────────────
export default function MarketingHome({ onLogin }: { onLogin: () => void }) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeFeature, setActiveFeature] = useState(0);
  const [stats, setStats] = useState<PlatformStats>({
    activeBranches: 0, trackedSkus: 0, cities: 0, revenueToday: null, expiringSoon: null,
    salesProcessed: null, forecastsGenerated: null, avgTransferHours: null, branchesMappedPct: null,
  });
  const [themeId, setThemeId] = useState<HomeThemeId>(loadHomeTheme);
  useReveal();

  useEffect(() => {
    getPlatformStats().then(setStats).catch(() => {});
  }, []);

  const theme = HOME_THEMES.find(th => th.id === themeId) ?? HOME_THEMES[0];
  const isDark = Boolean(theme.isDark);
  const tokens = structuralTokens(isDark);

  function changeTheme(id: HomeThemeId) {
    setThemeId(id);
    try { localStorage.setItem(HOME_THEME_STORAGE_KEY, id); } catch { /* per-viewer convenience only */ }
  }

  const features: {
    key: string; icon: ReactNode; color: string; bg: string;
    titleKey: TranslationKey; taglineKey: TranslationKey; bodyKey: TranslationKey;
    image: string; alt: string; bulletKeys: TranslationKey[]; statValue: string; statLabelKey: TranslationKey;
  }[] = [
    {
      key: "stock", icon: icons.stock, color: theme.accents[0], bg: withAlpha(theme.accents[0], "1a"),
      titleKey: "home.featureStockTitle", taglineKey: "home.featureStockTagline", bodyKey: "home.featureStockBody",
      image: stockImg, alt: "Dense pharmacy stockroom shelves with organized medicine boxes",
      bulletKeys: ["home.featureStockBullet1", "home.featureStockBullet2", "home.featureStockBullet3", "home.featureStockBullet4"],
      statValue: stats.trackedSkus.toLocaleString(), statLabelKey: "home.featureStockStatLabel",
    },
    {
      key: "barcode", icon: icons.barcode, color: theme.accents[1], bg: withAlpha(theme.accents[1], "1a"),
      titleKey: "home.featureBarcodeTitle", taglineKey: "home.featureBarcodeTagline", bodyKey: "home.featureBarcodeBody",
      image: productsImg, alt: "Pharmacist scanning medicine barcode with tablet device",
      bulletKeys: ["home.featureBarcodeBullet1", "home.featureBarcodeBullet2", "home.featureBarcodeBullet3", "home.featureBarcodeBullet4"],
      statValue: stats.salesProcessed != null ? stats.salesProcessed.toLocaleString() : "—", statLabelKey: "home.featureBarcodeStatLabel",
    },
    {
      key: "sales", icon: icons.chart, color: theme.accents[2], bg: withAlpha(theme.accents[2], "1a"),
      titleKey: "home.featureSalesTitle", taglineKey: "home.featureSalesTagline", bodyKey: "home.featureSalesBody",
      image: heroImg, alt: "Bright, well-organized pharmacy retail floor with shelving and price tags",
      bulletKeys: ["home.featureSalesBullet1", "home.featureSalesBullet2", "home.featureSalesBullet3", "home.featureSalesBullet4"],
      statValue: stats.revenueToday != null ? formatCompactRwf(stats.revenueToday) : "—", statLabelKey: "home.featureSalesStatLabel",
    },
    {
      key: "ai", icon: icons.ai, color: theme.accents[3], bg: withAlpha(theme.accents[3], "1a"),
      titleKey: "home.featureAiTitle", taglineKey: "home.featureAiTagline", bodyKey: "home.featureAiBody",
      image: operationsImg, alt: "Pharmacy staff reviewing stock and sales data on a dashboard",
      bulletKeys: ["home.featureAiBullet1", "home.featureAiBullet2", "home.featureAiBullet3", "home.featureAiBullet4"],
      statValue: stats.forecastsGenerated != null ? stats.forecastsGenerated.toLocaleString() : "—", statLabelKey: "home.featureAiStatLabel",
    },
    {
      key: "distribution", icon: icons.truck, color: theme.accents[4], bg: withAlpha(theme.accents[4], "1a"),
      titleKey: "home.featureDistributionTitle", taglineKey: "home.featureDistributionTagline", bodyKey: "home.featureDistributionBody",
      image: stockImg, alt: "Warehouse-style pharmacy stock ready for inter-branch transfer",
      bulletKeys: ["home.featureDistributionBullet1", "home.featureDistributionBullet2", "home.featureDistributionBullet3", "home.featureDistributionBullet4"],
      statValue: stats.avgTransferHours != null ? `${stats.avgTransferHours} hrs` : "—", statLabelKey: "home.featureDistributionStatLabel",
    },
    {
      key: "organizations", icon: icons.org, color: theme.accents[5], bg: withAlpha(theme.accents[5], "1a"),
      titleKey: "home.featureOrgTitle", taglineKey: "home.featureOrgTagline", bodyKey: "home.featureOrgBody",
      image: operationsImg, alt: "Organization-wide view of multiple pharmacy branches and staff",
      bulletKeys: ["home.featureOrgBullet1", "home.featureOrgBullet2", "home.featureOrgBullet3", "home.featureOrgBullet4"],
      statValue: stats.branchesMappedPct != null ? `${stats.branchesMappedPct}%` : "—", statLabelKey: "home.featureOrgStatLabel",
    },
  ];

  const current = features[activeFeature];

  const realityBullets: [TranslationKey, string][] = [
    ["home.realityBullet1", theme.accents[0]],
    ["home.realityBullet2", theme.accents[1]],
    ["home.realityBullet3", theme.accents[2]],
    ["home.realityBullet4", theme.accents[3]],
  ];

  const howSteps: { n: string; icon: ReactNode; color: string; bg: string; titleKey: TranslationKey; bodyKey: TranslationKey; badgeKey?: TranslationKey }[] = [
    { n: "01", icon: icons.stock, color: theme.accents[0], bg: withAlpha(theme.accents[0], "1a"), titleKey: "home.howStep1Title", bodyKey: "home.howStep1Body" },
    { n: "02", icon: icons.phone, color: theme.accents[1], bg: withAlpha(theme.accents[1], "1a"), titleKey: "home.howStep2Title", bodyKey: "home.howStep2Body", badgeKey: "home.howStep2Badge" },
    { n: "03", icon: icons.key, color: theme.accents[2], bg: withAlpha(theme.accents[2], "1a"), titleKey: "home.howStep3Title", bodyKey: "home.howStep3Body" },
  ];

  const finalPoints: TranslationKey[] = ["home.finalPoint1", "home.finalPoint2", "home.finalPoint3"];
  const footerProductKeys: TranslationKey[] = [
    "home.featureStockTitle", "home.featureBarcodeTitle", "home.featureSalesTitle",
    "home.featureAiTitle", "home.featureDistributionTitle", "home.featureOrgTitle",
  ];
  const footerCompanyKeys: TranslationKey[] = [
    "home.footerCompanyAbout", "home.footerCompanyTerms", "home.footerCompanyPrivacy", "home.footerCompanyRura", "home.footerCompanyCouncil",
  ];

  return (
    <div style={{ background: tokens.pageBg, minHeight: "100vh" }}>

      {/* ──────────────────────── HEADER ──────────────────────────────── */}
      <header className="sticky top-0 z-50 w-full"
        style={{ background: tokens.headerBg, backdropFilter: "blur(16px)", borderBottom: `1px solid ${tokens.headerBorder}` }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">

          {/* Logo */}
          <a href="#" className="flex items-center gap-3 shrink-0">
            <Logo size={36} />
          </a>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-0.5">
            {([
              [t("home.navFeatures"), "#features"],
              [t("home.navHowItWorks"), "#how-it-works"],
              [t("home.navContact"), "#footer"],
            ] as const).map(([label, href]) => (
              <a key={href} href={href}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ color: tokens.navText, fontFamily: "var(--font-body)" }}
                onMouseEnter={e => (e.currentTarget.style.background = tokens.navHover)}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                {label}
              </a>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-2">
            <ThemeSwitcher active={themeId} onChange={changeTheme} />
            <LanguageSwitcher />
            <button type="button" onClick={onLogin} className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
              style={{ color: tokens.navText, fontFamily: "var(--font-display)" }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.navHover)}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              {t("home.logIn")}
            </button>
            <a href={REGISTER_URL}
              className="btn-cta px-5 py-2.5 rounded-xl text-sm font-bold text-white shadow-md"
              style={{ fontFamily: "var(--font-display)", ...ctaGradientStyle(theme) }}>
              {t("home.registerCta")}
            </a>
          </div>

          <div className="md:hidden flex items-center gap-2">
            <ThemeSwitcher active={themeId} onChange={changeTheme} />
            <LanguageSwitcher />
            <button className="p-2 rounded-lg" onClick={() => setMenuOpen(!menuOpen)}
              style={{ color: tokens.navText }}
              onMouseEnter={e => (e.currentTarget.style.background = tokens.navHover)}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <div className="w-5 h-5">{menuOpen ? icons.close : icons.menu}</div>
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="md:hidden px-4 pb-5 pt-2 flex flex-col gap-1"
            style={{ borderTop: `1px solid ${tokens.headerBorder}`, background: tokens.cardBg }}>
            {([
              [t("home.navFeatures"), "#features"],
              [t("home.navHowItWorks"), "#how-it-works"],
            ] as const).map(([l, h]) => (
              <a key={h} href={h} className="py-3 text-sm font-medium"
                style={{ color: tokens.navText, fontFamily: "var(--font-body)" }}
                onClick={() => setMenuOpen(false)}>{l}</a>
            ))}
            <div className="flex flex-col gap-2 pt-2" style={{ borderTop: `1px solid ${tokens.headerBorder}` }}>
              <button type="button" onClick={() => { setMenuOpen(false); onLogin(); }}
                className="py-2.5 text-center text-sm font-semibold rounded-xl"
                style={{ color: tokens.navText, border: `1px solid ${tokens.cardBorder}`, fontFamily: "var(--font-display)" }}>
                {t("home.logIn")}
              </button>
              <a href={REGISTER_URL} onClick={() => setMenuOpen(false)}
                className="btn-cta py-2.5 text-center text-sm font-bold text-white rounded-xl"
                style={{ fontFamily: "var(--font-display)", ...ctaGradientStyle(theme) }}>
                {t("home.registerCta")}
              </a>
            </div>
          </div>
        )}
      </header>

      {/* ──────────────────────── HERO ────────────────────────────────── */}
      <section className="relative overflow-hidden pt-10 pb-0 md:pt-16" style={{ background: tokens.pageBg }}>
        {/* Subtle background gradient */}
        <div className="absolute inset-0 pointer-events-none" style={{
          background: `radial-gradient(ellipse 80% 60% at 60% 40%, ${withAlpha(theme.accents[0], "12")} 0%, transparent 70%)`,
        }} />
        <BackgroundBubbles theme={theme} />

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid md:grid-cols-2 gap-10 items-center">

            {/* Copy */}
            <div className="py-6 md:py-12">
              <div className="animate-fade-up inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-sm font-semibold mb-7"
                style={{ background: withAlpha(theme.accents[0], "18"), color: theme.gradientFrom, border: `1px solid ${withAlpha(theme.accents[0], "30")}` }}>
                <span className="live-dot" />
                <span style={{ marginLeft: 6 }}>{t("home.heroBadge")}</span>
              </div>

              <h1 className="animate-fade-up delay-100 text-4xl sm:text-5xl lg:text-[3.4rem] font-extrabold leading-[1.08] mb-6"
                style={{ fontFamily: "var(--font-display)", color: tokens.textPrimary, letterSpacing: "-0.03em" }}>
                {t("home.heroTitleLine1")}<br />
                <span style={gradientTextStyle(theme)}>{t("home.heroTitleLine2")}</span>
              </h1>

              <p className="animate-fade-up delay-200 text-lg mb-8 max-w-md"
                style={{ color: tokens.textSecondary, fontFamily: "var(--font-body)", lineHeight: 1.7 }}>
                {t("home.heroBody")}
              </p>

              <div className="animate-fade-up delay-300 flex flex-col sm:flex-row gap-3 mb-10">
                <a href={REGISTER_URL}
                  className="btn-cta inline-flex items-center justify-center gap-2.5 px-7 py-3.5 rounded-xl font-bold text-white shadow-lg text-base"
                  style={{ fontFamily: "var(--font-display)", ...ctaGradientStyle(theme) }}>
                  {t("home.registerCta")}
                  <div className="w-4 h-4">{icons.arrow}</div>
                </a>
                <button type="button" onClick={onLogin}
                  className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-base transition-all"
                  style={{ color: tokens.navText, border: `1px solid ${tokens.cardBorder}`, fontFamily: "var(--font-display)", background: tokens.cardBg }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = theme.gradientFrom)}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = tokens.cardBorder)}>
                  {t("home.heroAlreadyRegistered")}
                </button>
              </div>

              {/* Trust stats — real counts from the database, not the design's template numbers */}
              <div className="animate-fade-up delay-400 flex items-center gap-6">
                {[
                  { n: stats.activeBranches, label: t("home.statPharmacies"), color: theme.accents[0] },
                  { n: stats.trackedSkus, label: t("home.statSkus"), color: theme.accents[1] },
                  { n: stats.cities, label: t("home.statCities"), color: theme.accents[3] },
                ].map(item => (
                  <div key={item.label}>
                    <div className="text-2xl font-extrabold stat-glow" style={{ fontFamily: "var(--font-display)", color: item.color }}>
                      <Counter to={item.n} />
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: tokens.textFaint, fontFamily: "var(--font-body)" }}>{item.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Hero image with floating stats */}
            <div className="relative animate-slide-left hidden md:block pb-0">
              <div className="relative rounded-3xl overflow-hidden shadow-2xl"
                style={{ height: 480, border: "1px solid rgba(255,255,255,0.4)" }}>
                <img src={heroImg} alt="Bright, well-organized pharmacy retail floor" loading="eager"
                  className="w-full h-full object-cover" />
                <div className="img-overlay-hero" />
                {/* overlay gradient bottom */}
                <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 55%, rgba(15,23,42,0.55) 100%)" }} />
                {/* overlay label */}
                <div className="absolute bottom-5 left-5 right-5">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-semibold"
                    style={{ background: withAlpha(theme.gradientFrom, "e6"), color: "#fff", fontFamily: "var(--font-display)" }}>
                    <span className="live-dot" style={{ background: "#fff" }} />
                    <span style={{ marginLeft: 6 }}>{t("home.heroLiveLabel")}</span>
                  </div>
                </div>
              </div>

              {/* Floating stat bubbles -- real platform-wide numbers from
                  public_platform_stats(), not the design's placeholder
                  values; "—" only until the platform has real activity to
                  report for that particular figure (e.g. no sales yet
                  today), never a made-up fallback number. */}
              <StatBubble value={`${stats.trackedSkus.toLocaleString()} SKUs`} label={t("home.statSkusInStock")} color={theme.accents[0]} delay={0}
                className="absolute -left-8 top-16 z-10" />
              <StatBubble value={stats.revenueToday != null ? formatCompactRwf(stats.revenueToday) : "—"} label={t("home.statRevenueToday")} color={theme.accents[1]} delay={0.8}
                className="absolute -right-6 top-44 z-10" />
              <StatBubble value={stats.expiringSoon != null ? `${stats.expiringSoon.toLocaleString()} expiring` : "—"} label={t("home.statExpiring")} color="#b45309" delay={1.6}
                className="absolute -left-4 bottom-20 z-10" />
            </div>
          </div>
        </div>

        {/* Bottom wave -- fills with whatever comes next (the video showcase
            section, always dark) so it reads as a curve into it rather than
            a stray bright stripe when the "night" theme's hero is also dark. */}
        <div className="w-full overflow-hidden relative" style={{ height: 60, marginTop: -1 }}>
          <svg viewBox="0 0 1440 60" preserveAspectRatio="none" className="w-full h-full">
            <path d="M0,30 C360,60 1080,0 1440,30 L1440,60 L0,60 Z" fill="#0b1220" />
          </svg>
        </div>
      </section>

      {/* ─────────────────────── VIDEO SHOWCASE ──────────────────────── */}
      <VideoShowcase theme={theme} />

      {/* ──────────────────── ALL-IN-ONE OPERATIONS STRIP ─────────────── */}
      <section className="py-16 md:py-20" style={{ background: tokens.sectionAltBg }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div className="reveal-left">
              <p className="text-sm font-bold uppercase tracking-widest mb-3" style={{ color: theme.gradientFrom, fontFamily: "var(--font-display)" }}>
                {t("home.realityEyebrow")}
              </p>
              <h2 className="text-3xl md:text-4xl font-extrabold mb-5"
                style={{ fontFamily: "var(--font-display)", color: tokens.textPrimary, letterSpacing: "-0.02em", lineHeight: 1.15 }}>
                {t("home.realityHeading")}
              </h2>
              <p className="text-base mb-7" style={{ color: tokens.textSecondary, fontFamily: "var(--font-body)", lineHeight: 1.75 }}>
                {t("home.realityBody")}
              </p>
              <ul className="space-y-3.5">
                {realityBullets.map(([key, color]) => (
                  <li key={key} className="flex items-center gap-3 text-sm font-medium"
                    style={{ color: tokens.navText, fontFamily: "var(--font-body)" }}>
                    <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                      style={{ background: withAlpha(color, "18") }}>
                      <div className="w-3 h-3" style={{ color }}>{icons.check}</div>
                    </span>
                    {t(key)}
                  </li>
                ))}
              </ul>
            </div>

            <div className="reveal-right relative">
              <div className="rounded-3xl overflow-hidden shadow-2xl"
                style={{ border: `1px solid ${tokens.cardBorder}`, height: 440 }}>
                <img src={operationsImg}
                  alt="Multiple pharmacy branches connected under one organization dashboard"
                  className="w-full h-full object-cover object-top" loading="lazy" />
              </div>
              {/* decorative badge */}
              <div className="absolute -bottom-5 -left-5 px-5 py-4 rounded-2xl shadow-xl"
                style={{ background: "#0f172a" }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="live-dot" />
                  <span className="text-xs font-semibold ml-1.5" style={{ color: "#94a3b8", fontFamily: "var(--font-display)" }}>{t("home.realityBadgeOrg")}</span>
                </div>
                <div className="text-sm font-bold" style={{ color: "#fff", fontFamily: "var(--font-display)" }}>{t("home.realityBadgeStatus")}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────────────────── FEATURES ────────────────────────── */}
      <section id="features" className="py-20 md:py-28" style={{ background: tokens.pageBg }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6">

          {/* Section header */}
          <div className="reveal text-center mb-14">
            <p className="text-sm font-bold uppercase tracking-widest mb-3" style={{ color: theme.gradientFrom, fontFamily: "var(--font-display)" }}>
              {t("home.featuresEyebrow")}
            </p>
            <h2 className="text-3xl md:text-[2.6rem] font-extrabold mb-4"
              style={{ fontFamily: "var(--font-display)", color: tokens.textPrimary, letterSpacing: "-0.025em", lineHeight: 1.15 }}>
              {t("home.featuresHeadingLine1")}<br className="hidden md:block" />
              <span style={gradientTextStyle(theme)}> {t("home.featuresHeadingLine2")}</span>
            </h2>
            <p className="text-base max-w-xl mx-auto" style={{ color: tokens.textMuted, fontFamily: "var(--font-body)", lineHeight: 1.7 }}>
              {t("home.featuresSubheading")}
            </p>
          </div>

          {/* Feature tabs */}
          <div className="reveal flex flex-wrap gap-2 justify-center mb-10">
            {features.map((f, i) => (
              <button key={f.key}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
                style={{
                  background: activeFeature === i ? f.color : tokens.cardBg,
                  color: activeFeature === i ? "#fff" : tokens.navText,
                  border: `1.5px solid ${activeFeature === i ? f.color : tokens.cardBorder}`,
                  fontFamily: "var(--font-display)",
                  boxShadow: activeFeature === i ? `0 4px 16px ${withAlpha(f.color, "40")}` : "none",
                  transform: activeFeature === i ? "translateY(-1px)" : "none",
                }}
                onClick={() => setActiveFeature(i)}>
                <div className="w-4 h-4">{f.icon}</div>
                {t(f.titleKey)}
              </button>
            ))}
          </div>

          {/* Active feature showcase */}
          <div className="grid md:grid-cols-2 gap-8 items-stretch mb-14">
            {/* Image panel */}
            <div className="reveal-left relative rounded-3xl overflow-hidden shadow-2xl"
              style={{ minHeight: 400, border: `1px solid ${tokens.cardBorder}` }}>
              <img
                key={current.key}
                src={current.image}
                alt={current.alt}
                loading="lazy"
                className="w-full h-full object-cover animate-fade-in"
                style={{ minHeight: 400 }}
              />
              <div className="img-overlay" />
              {/* stat badge on image */}
              <div className="absolute bottom-6 left-6 right-6">
                <div className="rounded-2xl p-4 backdrop-blur-md"
                  style={{ background: "rgba(15,23,42,0.85)", border: "1px solid rgba(255,255,255,0.1)" }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold" style={{ color: "#94a3b8", fontFamily: "var(--font-display)" }}>
                      {t("home.keyMetricLabel")}
                    </span>
                    <span className="live-dot" />
                  </div>
                  <div className="flex items-end justify-between">
                    <div>
                      <div className="text-2xl font-extrabold" style={{ color: current.color, fontFamily: "var(--font-display)" }}>
                        {current.statValue}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: "#64748b", fontFamily: "var(--font-body)" }}>
                        {t(current.statLabelKey)}
                      </div>
                    </div>
                    <Sparkline color={current.color} />
                  </div>
                </div>
              </div>
            </div>

            {/* Copy panel */}
            <div className="reveal-right flex flex-col justify-center rounded-3xl p-8 md:p-10"
              style={{ background: tokens.cardBg, border: `1px solid ${tokens.cardBorder}` }}>
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5"
                style={{ background: current.bg }}>
                <div className="w-6 h-6" style={{ color: current.color }}>{current.icon}</div>
              </div>
              <p className="text-xs font-bold uppercase tracking-widest mb-2"
                style={{ color: current.color, fontFamily: "var(--font-display)" }}>
                {t(current.taglineKey)}
              </p>
              <h3 className="text-2xl md:text-3xl font-extrabold mb-4"
                style={{ fontFamily: "var(--font-display)", color: tokens.textPrimary, letterSpacing: "-0.02em" }}>
                {t(current.titleKey)}
              </h3>
              <p className="text-base mb-6"
                style={{ color: tokens.textSecondary, fontFamily: "var(--font-body)", lineHeight: 1.75 }}>
                {t(current.bodyKey)}
              </p>
              <ul className="space-y-3">
                {current.bulletKeys.map(bKey => (
                  <li key={bKey} className="flex items-start gap-3 text-sm"
                    style={{ color: tokens.navText, fontFamily: "var(--font-body)" }}>
                    <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                      style={{ background: current.bg }}>
                      <div className="w-3 h-3" style={{ color: current.color }}>{icons.check}</div>
                    </span>
                    {t(bKey)}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Feature mini-cards (all 6 at a glance) */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map((f, i) => (
              <div key={f.key}
                className="feature-card reveal cursor-pointer rounded-2xl overflow-hidden"
                style={{ animationDelay: `${i * 0.08}s`, border: `1px solid ${tokens.cardBorder}` }}
                onClick={() => setActiveFeature(i)}>
                <div className="relative h-36 overflow-hidden">
                  <img src={f.image} alt={f.alt} loading="lazy" className="w-full h-full object-cover" />
                  <div className="img-overlay" />
                  <div className="absolute top-3 left-3">
                    <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                      style={{ background: "rgba(255,255,255,0.95)" }}>
                      <div className="w-4 h-4" style={{ color: f.color }}>{f.icon}</div>
                    </div>
                  </div>
                  {activeFeature === i && (
                    <div className="absolute inset-0 rounded-2xl"
                      style={{ border: `2px solid ${f.color}`, borderRadius: "inherit" }} />
                  )}
                </div>
                <div className="p-3.5" style={{ background: tokens.cardBg }}>
                  <div className="text-sm font-bold mb-0.5"
                    style={{ fontFamily: "var(--font-display)", color: tokens.textPrimary }}>{t(f.titleKey)}</div>
                  <div className="text-xs" style={{ color: tokens.textFaint, fontFamily: "var(--font-body)" }}>{t(f.taglineKey)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────────── PRODUCTS SHOWCASE ───────────────────────── */}
      <section className="py-20" style={{ background: "#fff" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="reveal rounded-3xl overflow-hidden relative shadow-2xl" style={{ height: 440 }}>
            <img src={productsImg}
              alt="Pharmacist using digital stock management system with full pharmacy shelves visible"
              className="w-full h-full object-cover object-top" loading="lazy" />
            {/* Dark overlay for readability */}
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, rgba(10,15,30,0.82) 0%, rgba(10,15,30,0.45) 50%, transparent 100%)" }} />

            <div className="absolute inset-0 flex items-center">
              <div className="px-8 md:px-14 max-w-xl">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold mb-5"
                  style={{ background: withAlpha(theme.gradientFrom, "d9"), color: "#fff", fontFamily: "var(--font-display)" }}>
                  <span className="live-dot" style={{ background: "#fff" }} />
                  <span style={{ marginLeft: 6 }}>{t("home.productsBadge")}</span>
                </div>
                <h3 className="text-3xl md:text-4xl font-extrabold mb-4 text-white"
                  style={{ fontFamily: "var(--font-display)", letterSpacing: "-0.025em", lineHeight: 1.15 }}>
                  {t("home.productsHeading")}
                </h3>
                <p className="text-base mb-7 text-white/80" style={{ fontFamily: "var(--font-body)", lineHeight: 1.7 }}>
                  {t("home.productsBody")}
                </p>
                <a href={REGISTER_URL}
                  className="btn-cta inline-flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-white shadow-lg text-sm"
                  style={{ fontFamily: "var(--font-display)", ...ctaGradientStyle(theme) }}>
                  {t("home.productsCta")}
                  <div className="w-4 h-4">{icons.arrow}</div>
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────────────── HOW IT WORKS ────────────────────────── */}
      <section id="how-it-works" className="py-20 md:py-28" style={{ background: tokens.pageBg }}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="reveal text-center mb-16">
            <p className="text-sm font-bold uppercase tracking-widest mb-3" style={{ color: theme.gradientFrom, fontFamily: "var(--font-display)" }}>
              {t("home.howEyebrow")}
            </p>
            <h2 className="text-3xl md:text-4xl font-extrabold"
              style={{ fontFamily: "var(--font-display)", color: tokens.textPrimary, letterSpacing: "-0.025em" }}>
              {t("home.howHeading")}
            </h2>
          </div>

          <div className="relative grid md:grid-cols-3 gap-6">
            {/* connector */}
            <div className="hidden md:block absolute top-12 left-1/6 right-1/6 h-px"
              style={{ background: `linear-gradient(90deg, ${theme.accents[0]}, ${theme.accents[1]}, ${theme.accents[2]})`, opacity: 0.3, zIndex: 0 }} />

            {howSteps.map(({ n, icon, color, bg, titleKey, bodyKey, badgeKey }, i) => (
              <div key={n} className="reveal relative z-10 rounded-2xl p-7 flex flex-col items-center text-center"
                style={{ background: tokens.cardBg, border: `1px solid ${tokens.cardBorder}`, animationDelay: `${i * 0.15}s` }}>
                <div className="relative w-20 h-20 rounded-2xl flex items-center justify-center mb-5 shadow-sm"
                  style={{ background: bg, border: `1px solid ${withAlpha(color, "28")}` }}>
                  <div className="w-8 h-8" style={{ color }}>{icon}</div>
                  <span className="absolute -top-2.5 -right-2.5 w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold text-white shadow-md"
                    style={{ background: color, fontFamily: "var(--font-display)" }}>
                    {parseInt(n)}
                  </span>
                </div>
                <h3 className="text-lg font-bold mb-3" style={{ fontFamily: "var(--font-display)", color: tokens.textPrimary }}>{t(titleKey)}</h3>
                <p className="text-sm" style={{ color: tokens.textMuted, fontFamily: "var(--font-body)", lineHeight: 1.7 }}>{t(bodyKey)}</p>
                {badgeKey && (
                  <span className="inline-block mt-4 px-3 py-1.5 rounded-full text-xs font-semibold"
                    style={{ background: withAlpha(theme.accents[1], "14"), color: theme.accents[1], fontFamily: "var(--font-body)" }}>
                    {t(badgeKey)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────────────────── FINAL CTA ───────────────────────── */}
      <section id="register" className="relative overflow-hidden py-24 md:py-32"
        style={{ background: "#0f172a" }}>
        {/* background image faint */}
        <div className="absolute inset-0 opacity-20">
          <img src={heroImg} alt="" className="w-full h-full object-cover" aria-hidden="true" loading="lazy" />
        </div>
        <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${withAlpha(theme.gradientFrom, "4d")} 0%, ${withAlpha(theme.gradientTo, "4d")} 100%)` }} />

        <div className="relative max-w-3xl mx-auto px-4 sm:px-6 text-center">
          <div className="reveal w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-7"
            style={{ background: withAlpha(theme.gradientFrom, "33"), border: `1px solid ${withAlpha(theme.gradientFrom, "4d")}` }}>
            <div className="w-8 h-8" style={{ color: "var(--primary-on-dark)" }}>{icons.shield}</div>
          </div>

          <h2 className="reveal text-3xl md:text-5xl font-extrabold text-white mb-5"
            style={{ fontFamily: "var(--font-display)", letterSpacing: "-0.03em", lineHeight: 1.1 }}>
            {t("home.finalHeadingLine1")}<br />
            <span style={{ color: "var(--primary-on-dark)" }}>{t("home.finalHeadingLine2")}</span>
          </h2>
          <p className="reveal delay-100 text-lg mb-10" style={{ color: "rgba(255,255,255,0.7)", fontFamily: "var(--font-body)", lineHeight: 1.7 }}>
            {t("home.finalBody")}
          </p>

          <div className="reveal delay-200">
            <a href={REGISTER_URL}
              className="btn-cta inline-flex items-center gap-3 px-9 py-4 rounded-xl font-extrabold text-white text-lg shadow-2xl mb-4"
              style={{ fontFamily: "var(--font-display)", ...ctaGradientStyle(theme) }}>
              {t("home.registerCta")}
              <div className="w-5 h-5">{icons.arrow}</div>
            </a>
          </div>
          <p className="reveal delay-300 text-sm" style={{ color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-body)" }}>
            {t("home.finalNote")}
          </p>

          <div className="reveal delay-400 flex flex-wrap items-center justify-center gap-6 mt-10">
            {finalPoints.map(key => (
              <div key={key} className="flex items-center gap-2 text-sm"
                style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--font-body)" }}>
                <div className="w-4 h-4" style={{ color: "var(--primary-on-dark)" }}>{icons.check}</div>
                {t(key)}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─────────────────────────── FOOTER ──────────────────────────── */}
      <footer id="footer" style={{ background: "#080e1a", borderTop: "1px solid #1e293b" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14">
          <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-10 mb-12">
            {/* Brand */}
            <div>
              <div className="flex items-center gap-3 mb-4">
                <Logo size={36} tone="dark" />
              </div>
              <p className="text-sm" style={{ color: "#475569", fontFamily: "var(--font-body)", lineHeight: 1.7 }}>
                {t("home.footerTagline")}
              </p>
            </div>

            {/* Product */}
            <div>
              <h4 className="text-sm font-bold mb-4" style={{ color: "#94a3b8", fontFamily: "var(--font-display)" }}>{t("home.footerProductHeading")}</h4>
              {footerProductKeys.map(key => (
                <a key={key} href="#features"
                  className="block text-sm py-1.5 transition-colors"
                  style={{ color: "#475569", fontFamily: "var(--font-body)" }}
                  onMouseEnter={e => (e.currentTarget.style.color = "var(--primary-on-dark)")}
                  onMouseLeave={e => (e.currentTarget.style.color = "#475569")}>
                  {t(key)}
                </a>
              ))}
            </div>

            {/* Company */}
            <div>
              <h4 className="text-sm font-bold mb-4" style={{ color: "#94a3b8", fontFamily: "var(--font-display)" }}>{t("home.footerCompanyHeading")}</h4>
              {footerCompanyKeys.map(key => (
                <a key={key} href="#"
                  className="block text-sm py-1.5 transition-colors"
                  style={{ color: "#475569", fontFamily: "var(--font-body)" }}
                  onMouseEnter={e => (e.currentTarget.style.color = "var(--primary-on-dark)")}
                  onMouseLeave={e => (e.currentTarget.style.color = "#475569")}>
                  {t(key)}
                </a>
              ))}
            </div>

            {/* Contact */}
            <div>
              <h4 className="text-sm font-bold mb-4" style={{ color: "#94a3b8", fontFamily: "var(--font-display)" }}>{t("home.footerContactHeading")}</h4>
              <div className="space-y-2.5 text-sm" style={{ color: "#475569", fontFamily: "var(--font-body)" }}>
                <div>support@pharmsync.rw</div>
                <div>+250 788 000 000</div>
                <div>KG 123 St, Kigali, Rwanda</div>
              </div>
              <button type="button" onClick={onLogin}
                className="inline-block mt-5 text-sm font-bold px-4 py-2.5 rounded-xl transition-all"
                style={{ background: "rgba(30,95,168,0.15)", color: "var(--primary-on-dark)", fontFamily: "var(--font-display)", border: "1px solid rgba(30,95,168,0.2)" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(30,95,168,0.25)")}
                onMouseLeave={e => (e.currentTarget.style.background = "rgba(30,95,168,0.15)")}>
                {t("home.footerExistingBranch")}
              </button>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-8"
            style={{ borderTop: "1px solid #1e293b" }}>
            <p className="text-xs" style={{ color: "#334155", fontFamily: "var(--font-body)" }}>
              {t("home.footerCopyright", { year: new Date().getFullYear() })}
            </p>
            <p className="text-xs" style={{ color: "#1e293b", fontFamily: "var(--font-body)" }}>
              {t("home.footerRegulatory")}
            </p>
          </div>
        </div>
      </footer>

    </div>
  );
}
