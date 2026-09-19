import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "./i18n"
import type { TranslationKey } from "./i18n/en"
import systemVideoSrc from "../assets/video-system-explained.mp4"

// First-run guided tour: a spotlight walkthrough of the dashboard shell.
//
// Every step points at a real element that is already on screen, found by a
// `data-tour` attribute rather than a ref, so adding or moving a step never
// means threading a ref through App.tsx. A step whose target isn't in the DOM
// is skipped automatically -- that is what makes the tour role-aware for
// free: a seller never sees the owner-only sidebar cards because those
// elements simply aren't rendered for them.
//
// The tour is modal -- everything behind it is covered, including the
// element being explained, so a click can't land on the app mid-explanation.
// It is not mandatory though: "Skip" and Escape both end it, and both count
// as done, so it never reappears on its own. It can be reopened any time
// from the account menu.

export interface TourStep {
  id: string
  /** CSS selector for the element to spotlight. Omit for a centred card. */
  target?: string
  titleKey: TranslationKey
  bodyKey: TranslationKey
  /** Preferred side of the target; falls back automatically if it won't fit. */
  prefer?: "right" | "left" | "top" | "bottom"
  /** A short video played inside a widened version of this step's card,
   *  above the title/body -- only the very first ("welcome") step uses this
   *  today. Everything else about the step (Next/Skip/progress dots) works
   *  exactly the same either way; only the card's width and its extra video
   *  element change. */
  videoSrc?: string
}

export const TOUR_STEPS: TourStep[] = [
  { id: "welcome", titleKey: "tour.welcomeTitle", bodyKey: "tour.welcomeBody", videoSrc: systemVideoSrc },
  { id: "sidebar", target: '[data-tour="sidebar"]', titleKey: "tour.sidebarTitle", bodyKey: "tour.sidebarBody", prefer: "right" },
  { id: "snapshot", target: '[data-tour="today-snapshot"]', titleKey: "tour.snapshotTitle", bodyKey: "tour.snapshotBody", prefer: "right" },
  { id: "language", target: '[data-tour="language"]', titleKey: "tour.languageTitle", bodyKey: "tour.languageBody", prefer: "right" },
  { id: "pin", target: '[data-tour="pin-sidebar"]', titleKey: "tour.pinTitle", bodyKey: "tour.pinBody", prefer: "bottom" },
  { id: "search", target: '[data-tour="search"]', titleKey: "tour.searchTitle", bodyKey: "tour.searchBody", prefer: "bottom" },
  { id: "period", target: '[data-tour="date-range"]', titleKey: "tour.periodTitle", bodyKey: "tour.periodBody", prefer: "bottom" },
  { id: "branch", target: '[data-tour="branch"]', titleKey: "tour.branchTitle", bodyKey: "tour.branchBody", prefer: "bottom" },
  { id: "connection", target: '[data-tour="connection"]', titleKey: "tour.connectionTitle", bodyKey: "tour.connectionBody", prefer: "bottom" },
  { id: "alerts", target: '[data-tour="notifications"]', titleKey: "tour.alertsTitle", bodyKey: "tour.alertsBody", prefer: "bottom" },
  { id: "account", target: '[data-tour="account"]', titleKey: "tour.accountTitle", bodyKey: "tour.accountBody", prefer: "bottom" },
  { id: "workspace", target: '[data-tour="main"]', titleKey: "tour.workspaceTitle", bodyKey: "tour.workspaceBody", prefer: "top" },
  { id: "done", titleKey: "tour.doneTitle", bodyKey: "tour.doneBody" },
]

// ── Completion state ────────────────────────────────────────────────────────
// Per user, in this browser -- the same place the theme, language and
// dashboard widget choices live. A user who signs in on a second device gets
// the tour once there too, which is the behaviour we want for a walkthrough
// of a screen whose layout they haven't seen on that device yet.
//
// The version suffix is the lever for re-running the tour for everybody after
// the shell changes materially: bump it and every user sees the new tour once.
const TOUR_VERSION = "v1"
const doneKey = (userId: string) => `psync_tour_done_${TOUR_VERSION}:${userId}`

export function hasCompletedTour(userId: string): boolean {
  try {
    return localStorage.getItem(doneKey(userId)) === "1"
  } catch {
    // Private-browsing contexts can throw on access. Treat that as "already
    // done" rather than trapping someone in a tour that can never be
    // recorded as finished and would reappear on every single page load.
    return true
  }
}

export function markTourComplete(userId: string): void {
  try {
    localStorage.setItem(doneKey(userId), "1")
  } catch {
    // Not worth surfacing: the tour still completed for this session.
  }
}

// ── Geometry ────────────────────────────────────────────────────────────────

interface Box { top: number; left: number; width: number; height: number }

const PAD = 6
const CARD_W = 330
const GAP = 14

function useSpotlight(selector: string | undefined, stepIndex: number): Box | null {
  const [box, setBox] = useState<Box | null>(null)

  useLayoutEffect(() => {
    if (!selector) { setBox(null); return }
    const el = document.querySelector(selector)
    if (!(el instanceof HTMLElement)) { setBox(null); return }

    el.scrollIntoView({ block: "nearest", inline: "nearest" })

    const measure = () => {
      const r = el.getBoundingClientRect()
      setBox({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 })
    }
    measure()

    // The sidebar animates its width when it pins open, so a single measure
    // on mount lands mid-transition. Re-measure while it settles.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    observer.observe(document.body)
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    const settle = window.setTimeout(measure, 260)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
      window.clearTimeout(settle)
    }
  }, [selector, stepIndex])

  return box
}

/** Places the card beside the spotlight, falling back through the other sides. */
function placeCard(box: Box | null, prefer: TourStep["prefer"], cardH: number, cardW: number = CARD_W): { top: number; left: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const clampTop = (v: number) => Math.max(12, Math.min(v, vh - cardH - 12))
  const clampLeft = (v: number) => Math.max(12, Math.min(v, vw - cardW - 12))
  const centre = { top: clampTop(vh / 2 - cardH / 2), left: clampLeft(vw / 2 - cardW / 2) }
  if (!box) return centre

  const fits = {
    right: box.left + box.width + GAP + cardW <= vw - 12,
    left: box.left - GAP - cardW >= 12,
    bottom: box.top + box.height + GAP + cardH <= vh - 12,
    top: box.top - GAP - cardH >= 12,
  }
  const order = ([prefer, "bottom", "right", "top", "left"] as const).filter(Boolean) as Array<keyof typeof fits>
  const side = order.find(s => fits[s])

  // No side has room -- the working-area step spotlights nearly the whole
  // viewport, which leaves no margin anywhere. Previously this fell back to
  // "bottom" and placed the card below the fold, so the Next button was
  // simply not on screen and the tour looked stuck. Centre it over the
  // spotlight instead.
  if (!side) return centre

  if (side === "right") return { top: clampTop(box.top), left: box.left + box.width + GAP }
  if (side === "left") return { top: clampTop(box.top), left: box.left - GAP - cardW }
  if (side === "top") return { top: box.top - GAP - cardH, left: clampLeft(box.left) }
  return { top: box.top + box.height + GAP, left: clampLeft(box.left) }
}

// ── Component ───────────────────────────────────────────────────────────────

export function GuidedTour({ steps = TOUR_STEPS, onFinish }: { steps?: TourStep[]; onFinish: () => void }) {
  const { t } = useTranslation()

  // Drop steps whose target isn't on screen for this role/layout -- that is
  // what makes the tour role-aware for free.
  //
  // This has to run AFTER the DOM is committed, not during render: opening
  // the tour also pins the sidebar open in the same commit, so querying
  // during render would miss every element that only exists while it is
  // expanded and silently drop those steps. Resolved once, on the frame
  // after mount, and then held: recomputing mid-tour would renumber the
  // steps under the user.
  const [visible, setVisible] = useState<TourStep[] | null>(null)
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      setVisible(steps.filter(s => !s.target || document.querySelector(s.target) instanceof HTMLElement))
    })
    return () => cancelAnimationFrame(frame)
  }, [steps])

  const [index, setIndex] = useState(0)
  const step = visible?.[index]
  const box = useSpotlight(step?.target, index)
  const cardRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const [cardH, setCardH] = useState(200)

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight)
  }, [index, step?.bodyKey])

  useEffect(() => { nextRef.current?.focus() }, [index])

  const last = !!visible && index === visible.length - 1
  const next = useCallback(() => {
    if (!visible) return
    if (last) onFinish()
    else setIndex(i => Math.min(i + 1, visible.length - 1))
  }, [last, onFinish, visible])
  const back = useCallback(() => setIndex(i => Math.max(i - 1, 0)), [])

  // Escape leaves the tour and counts it as done, same as the Skip button --
  // it is caught here rather than left to bubble so it can't also close a
  // menu behind the overlay on its way out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onFinish(); return }
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next() }
      if (e.key === "ArrowLeft") { e.preventDefault(); back() }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [next, back, onFinish])

  if (!visible || !step) return null

  const cardW = step.videoSrc ? 600 : CARD_W
  const pos = placeCard(box, step.prefer, cardH, cardW)
  const shade = "rgba(15,23,42,0.62)"
  const block: React.CSSProperties = { position: "fixed", background: shade, zIndex: 4000 }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="tour-title" style={{ position: "fixed", inset: 0, zIndex: 4000 }}>
      {/* Four shades around the spotlight, plus a transparent blocker over it,
          so nothing behind the tour can be clicked -- including the element
          being explained. */}
      {box ? (
        <>
          <div style={{ ...block, top: 0, left: 0, right: 0, height: Math.max(box.top, 0) }} />
          <div style={{ ...block, top: box.top + box.height, left: 0, right: 0, bottom: 0 }} />
          <div style={{ ...block, top: box.top, left: 0, width: Math.max(box.left, 0), height: box.height }} />
          <div style={{ ...block, top: box.top, left: box.left + box.width, right: 0, height: box.height }} />
          <div style={{
            position: "fixed", top: box.top, left: box.left, width: box.width, height: box.height,
            border: "2px solid var(--primary)", borderRadius: 10, zIndex: 4001,
            boxShadow: "0 0 0 4px rgba(30,95,168,0.25)", pointerEvents: "auto",
          }} />
        </>
      ) : (
        <div style={{ ...block, inset: 0 }} />
      )}

      <div
        ref={cardRef}
        style={{
          position: "fixed", top: pos.top, left: pos.left, width: cardW, zIndex: 4002,
          background: "#fff", borderRadius: 14, padding: "18px 18px 14px",
          boxShadow: "0 18px 44px rgba(15,23,42,0.28)", fontFamily: "var(--font-body)",
          maxHeight: "calc(100vh - 24px)", overflowY: "auto", boxSizing: "border-box",
        }}
      >
        {step.videoSrc && (
          // Native controls, not the home page's silent-loop treatment --
          // this is a deliberate "watch this" moment (the user just clicked
          // Walkthrough), not ambient background motion, so it gets a real
          // player and an attempted unmuted autoplay (the click that opened
          // the tour counts as the user gesture browsers require for that;
          // if a browser still blocks it, the native controls make starting
          // it manually a one-tap fallback, never a dead end).
          <video
            src={step.videoSrc}
            controls
            autoPlay
            playsInline
            preload="none"
            className="w-full"
            style={{ borderRadius: 10, marginBottom: 14, background: "#000", aspectRatio: "16 / 9" }}
          />
        )}
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--primary)", marginBottom: 6 }}>
          {t("tour.stepCounter", { current: index + 1, total: visible.length })}
        </div>
        <h2 id="tour-title" style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "var(--ink)", fontFamily: "var(--font-display)", letterSpacing: "-0.01em" }}>
          {t(step.titleKey)}
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 12.5, lineHeight: 1.6, color: "var(--ink-mid)" }}>
          {t(step.bodyKey)}
        </p>

        <div style={{ display: "flex", gap: 4, marginTop: 16 }}>
          {visible.map((s, i) => (
            <span key={s.id} style={{
              width: i === index ? 16 : 6, height: 6, borderRadius: 3,
              background: i === index ? "var(--primary)" : i < index ? "var(--border-strong)" : "var(--border)",
              transition: "width 0.18s, background 0.18s",
            }} />
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <button onClick={onFinish} style={{
            padding: "7px 4px", border: "none", background: "none", flex: 1, textAlign: "left",
            color: "var(--ink-muted)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }}>{t("tour.skip")}</button>
          {index > 0 && (
            <button onClick={back} style={{
              padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "#fff",
              color: "var(--ink-mid)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>{t("tour.back")}</button>
          )}
          <button ref={nextRef} onClick={next} style={{
            padding: "7px 14px", borderRadius: 8, border: "none", background: "var(--primary)",
            color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
          }}>{last ? t("tour.finish") : t("tour.next")}</button>
        </div>
      </div>
    </div>
  )
}
