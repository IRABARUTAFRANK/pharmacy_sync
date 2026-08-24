import { useState, useEffect, useRef, type ReactNode } from "react";
import logoImg from "../assets/logo.png";
import heroImg from "../assets/stock.jpg";
import stockImg from "../assets/stock2.jpg";
import productsImg from "../assets/products.jpg";
import operationsImg from "../assets/all-in-one-pharmacy-operations.jpg";
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
};

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
function Sparkline({ color = "#0d9488" }: { color?: string }) {
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

// ─── Main Landing Page ───────────────────────────────────────────────────────
export default function MarketingHome({ onLogin }: { onLogin: () => void }) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeFeature, setActiveFeature] = useState(0);
  const [stats, setStats] = useState<PlatformStats>({ activeBranches: 0, trackedSkus: 0, cities: 0 });
  useReveal();

  useEffect(() => {
    getPlatformStats().then(setStats).catch(() => {});
  }, []);

  const features: {
    key: string; icon: ReactNode; color: string; bg: string;
    titleKey: TranslationKey; taglineKey: TranslationKey; bodyKey: TranslationKey;
    image: string; alt: string; bulletKeys: TranslationKey[]; statValue: string; statLabelKey: TranslationKey;
  }[] = [
    {
      key: "stock", icon: icons.stock, color: "#0d9488", bg: "rgba(13,148,136,0.1)",
      titleKey: "home.featureStockTitle", taglineKey: "home.featureStockTagline", bodyKey: "home.featureStockBody",
      image: stockImg, alt: "Dense pharmacy medicine shelves with organized stock",
      bulletKeys: ["home.featureStockBullet1", "home.featureStockBullet2", "home.featureStockBullet3", "home.featureStockBullet4"],
      statValue: "1,284", statLabelKey: "home.featureStockStatLabel",
    },
    {
      key: "barcode", icon: icons.barcode, color: "#1e5fa8", bg: "rgba(30,95,168,0.1)",
      titleKey: "home.featureBarcodeTitle", taglineKey: "home.featureBarcodeTagline", bodyKey: "home.featureBarcodeBody",
      image: productsImg, alt: "Pharmacist scanning medicine barcode with tablet device",
      bulletKeys: ["home.featureBarcodeBullet1", "home.featureBarcodeBullet2", "home.featureBarcodeBullet3", "home.featureBarcodeBullet4"],
      statValue: "99.8%", statLabelKey: "home.featureBarcodeStatLabel",
    },
    {
      key: "sales", icon: icons.chart, color: "#0891b2", bg: "rgba(8,145,178,0.1)",
      titleKey: "home.featureSalesTitle", taglineKey: "home.featureSalesTagline", bodyKey: "home.featureSalesBody",
      image: heroImg, alt: "Modern well-lit pharmacy interior with organized product displays",
      bulletKeys: ["home.featureSalesBullet1", "home.featureSalesBullet2", "home.featureSalesBullet3", "home.featureSalesBullet4"],
      statValue: "RWF 2.4M", statLabelKey: "home.featureSalesStatLabel",
    },
    {
      key: "ai", icon: icons.ai, color: "#7c3aed", bg: "rgba(124,58,237,0.1)",
      titleKey: "home.featureAiTitle", taglineKey: "home.featureAiTagline", bodyKey: "home.featureAiBody",
      image: operationsImg, alt: "Pharmacy operations showing digital consultation and drone delivery coordination",
      bulletKeys: ["home.featureAiBullet1", "home.featureAiBullet2", "home.featureAiBullet3", "home.featureAiBullet4"],
      statValue: "34%", statLabelKey: "home.featureAiStatLabel",
    },
    {
      key: "distribution", icon: icons.truck, color: "#059669", bg: "rgba(5,150,105,0.1)",
      titleKey: "home.featureDistributionTitle", taglineKey: "home.featureDistributionTagline", bodyKey: "home.featureDistributionBody",
      image: operationsImg, alt: "Pharmacy distribution and delivery network coordination across branches",
      bulletKeys: ["home.featureDistributionBullet1", "home.featureDistributionBullet2", "home.featureDistributionBullet3", "home.featureDistributionBullet4"],
      statValue: "48 hrs", statLabelKey: "home.featureDistributionStatLabel",
    },
  ];

  const current = features[activeFeature];

  const realityBullets: [TranslationKey, string][] = [
    ["home.realityBullet1", "#0d9488"],
    ["home.realityBullet2", "#1e5fa8"],
    ["home.realityBullet3", "#7c3aed"],
    ["home.realityBullet4", "#059669"],
  ];

  const howSteps: { n: string; icon: ReactNode; color: string; bg: string; titleKey: TranslationKey; bodyKey: TranslationKey; badgeKey?: TranslationKey }[] = [
    { n: "01", icon: icons.stock, color: "#0d9488", bg: "rgba(13,148,136,0.1)", titleKey: "home.howStep1Title", bodyKey: "home.howStep1Body" },
    { n: "02", icon: icons.phone, color: "#1e5fa8", bg: "rgba(30,95,168,0.1)", titleKey: "home.howStep2Title", bodyKey: "home.howStep2Body", badgeKey: "home.howStep2Badge" },
    { n: "03", icon: icons.key, color: "#7c3aed", bg: "rgba(124,58,237,0.1)", titleKey: "home.howStep3Title", bodyKey: "home.howStep3Body" },
  ];

  const finalPoints: TranslationKey[] = ["home.finalPoint1", "home.finalPoint2", "home.finalPoint3"];
  const footerProductKeys: TranslationKey[] = [
    "home.featureStockTitle", "home.featureBarcodeTitle", "home.featureSalesTitle", "home.featureAiTitle", "home.featureDistributionTitle",
  ];
  const footerCompanyKeys: TranslationKey[] = [
    "home.footerCompanyAbout", "home.footerCompanyTerms", "home.footerCompanyPrivacy", "home.footerCompanyRura", "home.footerCompanyCouncil",
  ];

  return (
    <div style={{ background: "#f8fafb", minHeight: "100vh" }}>

      {/* ──────────────────────── HEADER ──────────────────────────────── */}
      <header className="sticky top-0 z-50 w-full"
        style={{ background: "rgba(255,255,255,0.96)", backdropFilter: "blur(16px)", borderBottom: "1px solid #e8edf4" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">

          {/* Logo */}
          <a href="#" className="flex items-center gap-3 shrink-0">
            <img src={logoImg} alt="PharmSync logo" className="w-9 h-9 object-contain" />
            <span className="text-xl font-bold tracking-tight hidden sm:block"
              style={{ fontFamily: "var(--font-display)", color: "#0f172a" }}>
              Pharm<span style={{ color: "#0d9488" }}>Sync</span>
            </span>
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
                style={{ color: "#374151", fontFamily: "var(--font-body)" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#f1f5f9")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                {label}
              </a>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-2">
            <LanguageSwitcher />
            <button type="button" onClick={onLogin} className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
              style={{ color: "#374151", fontFamily: "var(--font-display)" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#f1f5f9")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              {t("home.logIn")}
            </button>
            <a href={REGISTER_URL}
              className="btn-cta px-5 py-2.5 rounded-xl text-sm font-bold text-white shadow-md"
              style={{ fontFamily: "var(--font-display)" }}>
              {t("home.registerCta")}
            </a>
          </div>

          <div className="md:hidden flex items-center gap-2">
            <LanguageSwitcher />
            <button className="p-2 rounded-lg" onClick={() => setMenuOpen(!menuOpen)}
              style={{ color: "#374151" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#f1f5f9")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <div className="w-5 h-5">{menuOpen ? icons.close : icons.menu}</div>
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="md:hidden px-4 pb-5 pt-2 flex flex-col gap-1"
            style={{ borderTop: "1px solid #e8edf4", background: "#fff" }}>
            {([
              [t("home.navFeatures"), "#features"],
              [t("home.navHowItWorks"), "#how-it-works"],
            ] as const).map(([l, h]) => (
              <a key={h} href={h} className="py-3 text-sm font-medium"
                style={{ color: "#374151", fontFamily: "var(--font-body)" }}
                onClick={() => setMenuOpen(false)}>{l}</a>
            ))}
            <div className="flex flex-col gap-2 pt-2" style={{ borderTop: "1px solid #e8edf4" }}>
              <button type="button" onClick={() => { setMenuOpen(false); onLogin(); }}
                className="py-2.5 text-center text-sm font-semibold rounded-xl"
                style={{ color: "#374151", border: "1px solid #e2e8f0", fontFamily: "var(--font-display)" }}>
                {t("home.logIn")}
              </button>
              <a href={REGISTER_URL} onClick={() => setMenuOpen(false)}
                className="btn-cta py-2.5 text-center text-sm font-bold text-white rounded-xl"
                style={{ fontFamily: "var(--font-display)" }}>
                {t("home.registerCta")}
              </a>
            </div>
          </div>
        )}
      </header>

      {/* ──────────────────────── HERO ────────────────────────────────── */}
      <section className="relative overflow-hidden pt-10 pb-0 md:pt-16">
        {/* Subtle background gradient */}
        <div className="absolute inset-0 pointer-events-none" style={{
          background: "radial-gradient(ellipse 80% 60% at 60% 40%, rgba(13,148,136,0.07) 0%, transparent 70%)",
        }} />

        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid md:grid-cols-2 gap-10 items-center">

            {/* Copy */}
            <div className="py-6 md:py-12">
              <div className="animate-fade-up inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-sm font-semibold mb-7"
                style={{ background: "rgba(13,148,136,0.09)", color: "#0f766e", border: "1px solid rgba(13,148,136,0.18)" }}>
                <span className="live-dot" />
                <span style={{ marginLeft: 6 }}>{t("home.heroBadge")}</span>
              </div>

              <h1 className="animate-fade-up delay-100 text-4xl sm:text-5xl lg:text-[3.4rem] font-extrabold leading-[1.08] mb-6"
                style={{ fontFamily: "var(--font-display)", color: "#0f172a", letterSpacing: "-0.03em" }}>
                {t("home.heroTitleLine1")}<br />
                <span className="text-gradient">{t("home.heroTitleLine2")}</span>
              </h1>

              <p className="animate-fade-up delay-200 text-lg mb-8 max-w-md"
                style={{ color: "#4b5563", fontFamily: "var(--font-body)", lineHeight: 1.7 }}>
                {t("home.heroBody")}
              </p>

              <div className="animate-fade-up delay-300 flex flex-col sm:flex-row gap-3 mb-10">
                <a href={REGISTER_URL}
                  className="btn-cta inline-flex items-center justify-center gap-2.5 px-7 py-3.5 rounded-xl font-bold text-white shadow-lg text-base"
                  style={{ fontFamily: "var(--font-display)" }}>
                  {t("home.registerCta")}
                  <div className="w-4 h-4">{icons.arrow}</div>
                </a>
                <button type="button" onClick={onLogin}
                  className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-base transition-all"
                  style={{ color: "#374151", border: "1px solid #d1d5db", fontFamily: "var(--font-display)", background: "#fff" }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = "#0d9488")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = "#d1d5db")}>
                  {t("home.heroAlreadyRegistered")}
                </button>
              </div>

              {/* Trust stats — real counts from the database, not the design's template numbers */}
              <div className="animate-fade-up delay-400 flex items-center gap-6">
                {[
                  { n: stats.activeBranches, label: t("home.statPharmacies"), color: "#0d9488" },
                  { n: stats.trackedSkus, label: t("home.statSkus"), color: "#1e5fa8" },
                  { n: stats.cities, label: t("home.statCities"), color: "#7c3aed" },
                ].map(item => (
                  <div key={item.label}>
                    <div className="text-2xl font-extrabold stat-glow" style={{ fontFamily: "var(--font-display)", color: item.color }}>
                      <Counter to={item.n} />
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: "#9ca3af", fontFamily: "var(--font-body)" }}>{item.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Hero image with floating stats */}
            <div className="relative animate-slide-left hidden md:block pb-0">
              <div className="relative rounded-3xl overflow-hidden shadow-2xl"
                style={{ height: 480, border: "1px solid rgba(255,255,255,0.4)" }}>
                <img src={heroImg} alt="Modern pharmacy interior with well-organized shelves"
                  className="w-full h-full object-cover" />
                <div className="img-overlay-hero" />
                {/* overlay gradient bottom */}
                <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 55%, rgba(15,23,42,0.55) 100%)" }} />
                {/* overlay label */}
                <div className="absolute bottom-5 left-5 right-5">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-semibold"
                    style={{ background: "rgba(13,148,136,0.9)", color: "#fff", fontFamily: "var(--font-display)" }}>
                    <span className="live-dot" style={{ background: "#fff" }} />
                    <span style={{ marginLeft: 6 }}>{t("home.heroLiveLabel")}</span>
                  </div>
                </div>
              </div>

              {/* Floating stat bubbles */}
              <StatBubble value="1,284 SKUs" label={t("home.statSkusInStock")} color="#0d9488" delay={0}
                className="absolute -left-8 top-16 z-10" />
              <StatBubble value="RWF 842k" label={t("home.statRevenueToday")} color="#1e5fa8" delay={0.8}
                className="absolute -right-6 top-44 z-10" />
              <StatBubble value="3 expiring" label={t("home.statExpiring")} color="#b45309" delay={1.6}
                className="absolute -left-4 bottom-20 z-10" />
            </div>
          </div>
        </div>

        {/* Bottom wave */}
        <div className="w-full overflow-hidden" style={{ height: 60, marginTop: -1 }}>
          <svg viewBox="0 0 1440 60" preserveAspectRatio="none" className="w-full h-full">
            <path d="M0,30 C360,60 1080,0 1440,30 L1440,60 L0,60 Z" fill="white" />
          </svg>
        </div>
      </section>

      {/* ──────────────────── ALL-IN-ONE OPERATIONS STRIP ─────────────── */}
      <section className="py-16 md:py-20" style={{ background: "#fff" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div className="reveal-left">
              <p className="text-sm font-bold uppercase tracking-widest mb-3" style={{ color: "#0d9488", fontFamily: "var(--font-display)" }}>
                {t("home.realityEyebrow")}
              </p>
              <h2 className="text-3xl md:text-4xl font-extrabold mb-5"
                style={{ fontFamily: "var(--font-display)", color: "#0f172a", letterSpacing: "-0.02em", lineHeight: 1.15 }}>
                {t("home.realityHeading")}
              </h2>
              <p className="text-base mb-7" style={{ color: "#4b5563", fontFamily: "var(--font-body)", lineHeight: 1.75 }}>
                {t("home.realityBody")}
              </p>
              <ul className="space-y-3.5">
                {realityBullets.map(([key, color]) => (
                  <li key={key} className="flex items-center gap-3 text-sm font-medium"
                    style={{ color: "#374151", fontFamily: "var(--font-body)" }}>
                    <span className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                      style={{ background: `${color}18` }}>
                      <div className="w-3 h-3" style={{ color }}>{icons.check}</div>
                    </span>
                    {t(key)}
                  </li>
                ))}
              </ul>
            </div>

            <div className="reveal-right relative">
              <div className="rounded-3xl overflow-hidden shadow-2xl"
                style={{ border: "1px solid #e8edf4", height: 440 }}>
                <img src={operationsImg}
                  alt="Pharmacy operations: dispensary counter, doctor consultation, drone delivery, and community health post in Rwanda"
                  className="w-full h-full object-cover object-top" />
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
      <section id="features" className="py-20 md:py-28" style={{ background: "#f8fafb" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6">

          {/* Section header */}
          <div className="reveal text-center mb-14">
            <p className="text-sm font-bold uppercase tracking-widest mb-3" style={{ color: "#0d9488", fontFamily: "var(--font-display)" }}>
              {t("home.featuresEyebrow")}
            </p>
            <h2 className="text-3xl md:text-[2.6rem] font-extrabold mb-4"
              style={{ fontFamily: "var(--font-display)", color: "#0f172a", letterSpacing: "-0.025em", lineHeight: 1.15 }}>
              {t("home.featuresHeadingLine1")}<br className="hidden md:block" />
              <span className="text-gradient"> {t("home.featuresHeadingLine2")}</span>
            </h2>
            <p className="text-base max-w-xl mx-auto" style={{ color: "#6b7280", fontFamily: "var(--font-body)", lineHeight: 1.7 }}>
              {t("home.featuresSubheading")}
            </p>
          </div>

          {/* Feature tabs */}
          <div className="reveal flex flex-wrap gap-2 justify-center mb-10">
            {features.map((f, i) => (
              <button key={f.key}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
                style={{
                  background: activeFeature === i ? f.color : "#fff",
                  color: activeFeature === i ? "#fff" : "#374151",
                  border: `1.5px solid ${activeFeature === i ? f.color : "#e2e8f0"}`,
                  fontFamily: "var(--font-display)",
                  boxShadow: activeFeature === i ? `0 4px 16px ${f.color}40` : "none",
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
              style={{ minHeight: 400, border: "1px solid #e8edf4" }}>
              <img
                key={current.key}
                src={current.image}
                alt={current.alt}
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
              style={{ background: "#fff", border: "1px solid #e8edf4" }}>
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5"
                style={{ background: current.bg }}>
                <div className="w-6 h-6" style={{ color: current.color }}>{current.icon}</div>
              </div>
              <p className="text-xs font-bold uppercase tracking-widest mb-2"
                style={{ color: current.color, fontFamily: "var(--font-display)" }}>
                {t(current.taglineKey)}
              </p>
              <h3 className="text-2xl md:text-3xl font-extrabold mb-4"
                style={{ fontFamily: "var(--font-display)", color: "#0f172a", letterSpacing: "-0.02em" }}>
                {t(current.titleKey)}
              </h3>
              <p className="text-base mb-6"
                style={{ color: "#4b5563", fontFamily: "var(--font-body)", lineHeight: 1.75 }}>
                {t(current.bodyKey)}
              </p>
              <ul className="space-y-3">
                {current.bulletKeys.map(bKey => (
                  <li key={bKey} className="flex items-start gap-3 text-sm"
                    style={{ color: "#374151", fontFamily: "var(--font-body)" }}>
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

          {/* Feature mini-cards (all 5 at a glance) */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {features.map((f, i) => (
              <div key={f.key}
                className="feature-card reveal cursor-pointer rounded-2xl overflow-hidden"
                style={{ animationDelay: `${i * 0.1}s`, border: "1px solid #e8edf4" }}
                onClick={() => setActiveFeature(i)}>
                <div className="relative h-36 overflow-hidden">
                  <img src={f.image} alt={f.alt} className="w-full h-full object-cover" />
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
                <div className="p-3.5" style={{ background: "#fff" }}>
                  <div className="text-sm font-bold mb-0.5"
                    style={{ fontFamily: "var(--font-display)", color: "#0f172a" }}>{t(f.titleKey)}</div>
                  <div className="text-xs" style={{ color: "#9ca3af", fontFamily: "var(--font-body)" }}>{t(f.taglineKey)}</div>
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
              className="w-full h-full object-cover object-top" />
            {/* Dark overlay for readability */}
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, rgba(10,15,30,0.82) 0%, rgba(10,15,30,0.45) 50%, transparent 100%)" }} />

            <div className="absolute inset-0 flex items-center">
              <div className="px-8 md:px-14 max-w-xl">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold mb-5"
                  style={{ background: "rgba(13,148,136,0.85)", color: "#fff", fontFamily: "var(--font-display)" }}>
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
                  style={{ fontFamily: "var(--font-display)" }}>
                  {t("home.productsCta")}
                  <div className="w-4 h-4">{icons.arrow}</div>
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────────────── HOW IT WORKS ────────────────────────── */}
      <section id="how-it-works" className="py-20 md:py-28" style={{ background: "#f8fafb" }}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="reveal text-center mb-16">
            <p className="text-sm font-bold uppercase tracking-widest mb-3" style={{ color: "#0d9488", fontFamily: "var(--font-display)" }}>
              {t("home.howEyebrow")}
            </p>
            <h2 className="text-3xl md:text-4xl font-extrabold"
              style={{ fontFamily: "var(--font-display)", color: "#0f172a", letterSpacing: "-0.025em" }}>
              {t("home.howHeading")}
            </h2>
          </div>

          <div className="relative grid md:grid-cols-3 gap-6">
            {/* connector */}
            <div className="hidden md:block absolute top-12 left-1/6 right-1/6 h-px"
              style={{ background: "linear-gradient(90deg, #0d9488, #1e5fa8, #7c3aed)", opacity: 0.3, zIndex: 0 }} />

            {howSteps.map(({ n, icon, color, bg, titleKey, bodyKey, badgeKey }, i) => (
              <div key={n} className="reveal relative z-10 rounded-2xl p-7 flex flex-col items-center text-center"
                style={{ background: "#fff", border: "1px solid #e8edf4", animationDelay: `${i * 0.15}s` }}>
                <div className="relative w-20 h-20 rounded-2xl flex items-center justify-center mb-5 shadow-sm"
                  style={{ background: bg, border: `1px solid ${color}28` }}>
                  <div className="w-8 h-8" style={{ color }}>{icon}</div>
                  <span className="absolute -top-2.5 -right-2.5 w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold text-white shadow-md"
                    style={{ background: color, fontFamily: "var(--font-display)" }}>
                    {parseInt(n)}
                  </span>
                </div>
                <h3 className="text-lg font-bold mb-3" style={{ fontFamily: "var(--font-display)", color: "#0f172a" }}>{t(titleKey)}</h3>
                <p className="text-sm" style={{ color: "#6b7280", fontFamily: "var(--font-body)", lineHeight: 1.7 }}>{t(bodyKey)}</p>
                {badgeKey && (
                  <span className="inline-block mt-4 px-3 py-1.5 rounded-full text-xs font-semibold"
                    style={{ background: "rgba(30,95,168,0.08)", color: "#1e5fa8", fontFamily: "var(--font-body)" }}>
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
          <img src={heroImg} alt="" className="w-full h-full object-cover" aria-hidden="true" />
        </div>
        <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, rgba(13,148,136,0.3) 0%, rgba(30,95,168,0.3) 100%)" }} />

        <div className="relative max-w-3xl mx-auto px-4 sm:px-6 text-center">
          <div className="reveal w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-7"
            style={{ background: "rgba(13,148,136,0.2)", border: "1px solid rgba(13,148,136,0.3)" }}>
            <div className="w-8 h-8" style={{ color: "#2dd4bf" }}>{icons.shield}</div>
          </div>

          <h2 className="reveal text-3xl md:text-5xl font-extrabold text-white mb-5"
            style={{ fontFamily: "var(--font-display)", letterSpacing: "-0.03em", lineHeight: 1.1 }}>
            {t("home.finalHeadingLine1")}<br />
            <span style={{ color: "#2dd4bf" }}>{t("home.finalHeadingLine2")}</span>
          </h2>
          <p className="reveal delay-100 text-lg mb-10" style={{ color: "rgba(255,255,255,0.7)", fontFamily: "var(--font-body)", lineHeight: 1.7 }}>
            {t("home.finalBody")}
          </p>

          <div className="reveal delay-200">
            <a href={REGISTER_URL}
              className="btn-cta inline-flex items-center gap-3 px-9 py-4 rounded-xl font-extrabold text-white text-lg shadow-2xl mb-4"
              style={{ fontFamily: "var(--font-display)" }}>
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
                <div className="w-4 h-4" style={{ color: "#2dd4bf" }}>{icons.check}</div>
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
                <img src={logoImg} alt="PharmSync" className="w-9 h-9 object-contain" />
                <span className="text-lg font-bold" style={{ fontFamily: "var(--font-display)", color: "#f1f5f9" }}>
                  Pharm<span style={{ color: "#2dd4bf" }}>Sync</span>
                </span>
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
                  onMouseEnter={e => (e.currentTarget.style.color = "#2dd4bf")}
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
                  onMouseEnter={e => (e.currentTarget.style.color = "#2dd4bf")}
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
                style={{ background: "rgba(13,148,136,0.15)", color: "#2dd4bf", fontFamily: "var(--font-display)", border: "1px solid rgba(13,148,136,0.2)" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(13,148,136,0.25)")}
                onMouseLeave={e => (e.currentTarget.style.background = "rgba(13,148,136,0.15)")}>
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
