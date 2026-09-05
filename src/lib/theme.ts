// Accent-color theming: a per-viewer display preference, not branch data —
// stored in this browser's localStorage only (same rationale as the language
// picker in lib/i18n and the Overview dashboard's widget visibility), so any
// staff member can pick their own without needing owner/manager permission.
//
// Applying a theme means overwriting the brand-tied CSS custom properties
// index.css defines on :root (see the comment above --bg there: "the
// neutrals below are tinted to match [the brand colour]") with an inline
// style on <html>, which wins over the stylesheet rule. Semantic colours
// (--positive/--negative/--warning/--info), plain text colours (--ink*), and
// the categorical chart colours (--accent-teal/--accent-violet) are
// deliberately left alone — those stay constant regardless of brand color.

export interface ThemePreset {
  id: string
  label: string
  // A solid hex for the single-color presets, or a linear-gradient(...) CSS
  // value for the "mixed" ones. Used directly as the picker swatch's own
  // background AND (via --btn-bg below) as every primary button's
  // background — the one place in the app a gradient is actually safe to
  // apply. Everywhere else that reads a theme color (link/badge text,
  // borders, the page background tint) stays a single solid hue, taken from
  // vars.primary: CSS silently drops "color: <gradient>" and "border-color:
  // <gradient>" as invalid, so those properties can never use this value.
  swatch: string
  vars: {
    primary: string
    primaryLight: string
    primaryMid: string
    primaryDark: string
    primaryOnDark: string
    accent: string
    bg: string
    bgAlt: string
    border: string
    borderStrong: string
  }
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "blue", label: "Blue", swatch: "#1e5fa8",
    vars: {
      primary: "#1e5fa8", primaryLight: "#dbeafe", primaryMid: "#60a5fa", primaryDark: "#1a4f8f", primaryOnDark: "#93c5fd",
      accent: "#3b82f6", bg: "#eaf2fb", bgAlt: "#e8eef7", border: "#d6e2f0", borderStrong: "#a9c4e2",
    },
  },
  {
    id: "green", label: "Green", swatch: "#15803d",
    vars: {
      primary: "#15803d", primaryLight: "#dcfce7", primaryMid: "#4ade80", primaryDark: "#166534", primaryOnDark: "#86efac",
      accent: "#22c55e", bg: "#eafaf1", bgAlt: "#e6f4ea", border: "#d1ead9", borderStrong: "#a7d7b8",
    },
  },
  {
    id: "purple", label: "Purple", swatch: "#7c3aed",
    vars: {
      primary: "#7c3aed", primaryLight: "#ede9fe", primaryMid: "#a78bfa", primaryDark: "#5b21b6", primaryOnDark: "#c4b5fd",
      accent: "#8b5cf6", bg: "#f3eefe", bgAlt: "#efe9fb", border: "#e0d4f7", borderStrong: "#c9b3ef",
    },
  },
  {
    id: "teal", label: "Teal", swatch: "#0d9488",
    vars: {
      primary: "#0d9488", primaryLight: "#ccfbf1", primaryMid: "#5eead4", primaryDark: "#0f766e", primaryOnDark: "#99f6e4",
      accent: "#14b8a6", bg: "#eafaf8", bgAlt: "#e3f5f2", border: "#cdeae6", borderStrong: "#9fd8d1",
    },
  },
  {
    id: "orange", label: "Orange", swatch: "#c2610a",
    vars: {
      primary: "#c2610a", primaryLight: "#ffedd5", primaryMid: "#fb923c", primaryDark: "#9a4a08", primaryOnDark: "#fdba74",
      accent: "#f97316", bg: "#fdf3ea", bgAlt: "#fbeee1", border: "#f3ddc3", borderStrong: "#e6bd8c",
    },
  },
  {
    id: "rose", label: "Rose", swatch: "#be123c",
    vars: {
      primary: "#be123c", primaryLight: "#ffe4e6", primaryMid: "#fb7185", primaryDark: "#9f1239", primaryOnDark: "#fda4af",
      accent: "#e11d48", bg: "#fdeef1", bgAlt: "#fbe7eb", border: "#f5d0d8", borderStrong: "#eba9b8",
    },
  },

  // "Mixed" (two-tone) presets: only the swatch/button background is a real
  // gradient. Every solid-color var still resolves to one hue -- the
  // gradient's dominant/first color -- so links, badges and text stay
  // legible; only buttons and the picker swatch itself show both colors.
  {
    id: "ocean", label: "Ocean", swatch: "linear-gradient(135deg, #1e5fa8, #0d9488)",
    vars: {
      primary: "#1e5fa8", primaryLight: "#dbeafe", primaryMid: "#60a5fa", primaryDark: "#1a4f8f", primaryOnDark: "#93c5fd",
      accent: "#0d9488", bg: "#eaf2fb", bgAlt: "#e8eef7", border: "#d6e2f0", borderStrong: "#a9c4e2",
    },
  },
  {
    id: "sunset", label: "Sunset", swatch: "linear-gradient(135deg, #c2610a, #be123c)",
    vars: {
      primary: "#c2610a", primaryLight: "#ffedd5", primaryMid: "#fb923c", primaryDark: "#9a4a08", primaryOnDark: "#fdba74",
      accent: "#be123c", bg: "#fdf3ea", bgAlt: "#fbeee1", border: "#f3ddc3", borderStrong: "#e6bd8c",
    },
  },
  {
    id: "berry", label: "Berry", swatch: "linear-gradient(135deg, #7c3aed, #db2777)",
    vars: {
      primary: "#7c3aed", primaryLight: "#ede9fe", primaryMid: "#a78bfa", primaryDark: "#5b21b6", primaryOnDark: "#c4b5fd",
      accent: "#db2777", bg: "#f3eefe", bgAlt: "#efe9fb", border: "#e0d4f7", borderStrong: "#c9b3ef",
    },
  },
  {
    id: "aurora", label: "Aurora", swatch: "linear-gradient(135deg, #0d9488, #7c3aed)",
    vars: {
      primary: "#0d9488", primaryLight: "#ccfbf1", primaryMid: "#5eead4", primaryDark: "#0f766e", primaryOnDark: "#99f6e4",
      accent: "#7c3aed", bg: "#eafaf8", bgAlt: "#e3f5f2", border: "#cdeae6", borderStrong: "#9fd8d1",
    },
  },
]

const STORAGE_KEY = "psync_theme"
const DEFAULT_THEME_ID = "blue"

export function getSavedThemeId(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved && THEME_PRESETS.some(p => p.id === saved) ? saved : DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

function applyThemeVars(preset: ThemePreset) {
  const root = document.documentElement.style
  root.setProperty("--btn-bg", preset.swatch)
  root.setProperty("--primary", preset.vars.primary)
  root.setProperty("--primary-light", preset.vars.primaryLight)
  root.setProperty("--primary-mid", preset.vars.primaryMid)
  root.setProperty("--primary-dark", preset.vars.primaryDark)
  root.setProperty("--primary-on-dark", preset.vars.primaryOnDark)
  root.setProperty("--accent", preset.vars.accent)
  root.setProperty("--bg", preset.vars.bg)
  root.setProperty("--bg-alt", preset.vars.bgAlt)
  root.setProperty("--border", preset.vars.border)
  root.setProperty("--border-strong", preset.vars.borderStrong)
}

// Called once, synchronously, before the app renders (see main.tsx) — this
// runs ahead of first paint so a saved non-default theme never flashes blue
// before switching.
export function initTheme() {
  const preset = THEME_PRESETS.find(p => p.id === getSavedThemeId()) ?? THEME_PRESETS[0]
  applyThemeVars(preset)
}

export function setTheme(id: string) {
  const preset = THEME_PRESETS.find(p => p.id === id) ?? THEME_PRESETS[0]
  applyThemeVars(preset)
  try {
    localStorage.setItem(STORAGE_KEY, preset.id)
  } catch {
    // per-viewer convenience only; a failed write just means the choice
    // doesn't persist across reloads, not worth surfacing to the user
  }
}
