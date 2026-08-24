import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import en, { type TranslationKey } from "./en";
import rw from "./rw";
import fr from "./fr";

export type Lang = "en" | "rw" | "fr";

const dictionaries: Record<Lang, Record<TranslationKey, string>> = { en, rw, fr };

export const LANGUAGES: { code: Lang; label: string; nativeLabel: string }[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "rw", label: "Kinyarwanda", nativeLabel: "Ikinyarwanda" },
  { code: "fr", label: "French", nativeLabel: "Français" },
];

const STORAGE_KEY = "psync_lang";

function detectDefaultLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "rw" || saved === "fr") return saved;
  } catch {
    // localStorage can throw in some private-browsing contexts; fall through
  }
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "";
  if (nav.startsWith("rw")) return "rw";
  if (nav.startsWith("fr")) return "fr";
  return "en";
}

type Vars = Record<string, string | number>;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: TranslationKey, vars?: Vars) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectDefaultLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // per-viewer convenience only; a failed write just means the choice
      // doesn't persist across reloads, not worth surfacing to the user
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Vars) => interpolate(dictionaries[lang][key] ?? dictionaries.en[key], vars),
    [lang]
  );

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTranslation() must be used inside <I18nProvider>");
  return ctx;
}

// ─── Language switcher ─────────────────────────────────────────────────────
// One shared control, styled two ways: "pill" (compact segmented control —
// dashboard top bars, admin console) and "dark" (for the AuthShell photo
// panel / MarketingHome's translucent header, where the pill variant's
// light background wouldn't have enough contrast).

export function LanguageSwitcher({ variant = "pill" }: { variant?: "pill" | "dark" }) {
  const { lang, setLang } = useTranslation();

  const dark = variant === "dark";
  return (
    <div
      role="group"
      aria-label="Language"
      style={{
        display: "inline-flex",
        borderRadius: 8,
        padding: 2,
        gap: 2,
        background: dark ? "rgba(255,255,255,0.12)" : "#f1f5f9",
        border: dark ? "1px solid rgba(255,255,255,0.25)" : "1px solid #e2e8f0",
      }}
    >
      {LANGUAGES.map(({ code, label, nativeLabel }) => {
        const active = code === lang;
        return (
          <button
            key={code}
            type="button"
            title={label}
            onClick={() => setLang(code)}
            style={{
              padding: "4px 9px",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 11,
              fontWeight: active ? 700 : 500,
              letterSpacing: "0.02em",
              background: active ? (dark ? "rgba(255,255,255,0.95)" : "#fff") : "transparent",
              color: active ? (dark ? "#0f172a" : "#0d9488") : dark ? "rgba(255,255,255,0.85)" : "#64748b",
              boxShadow: active ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
              transition: "all 0.15s",
            }}
          >
            {code === "en" ? "EN" : code === "rw" ? "RW" : "FR"}
            <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }}>
              {nativeLabel}
            </span>
          </button>
        );
      })}
    </div>
  );
}
