// A contextual nudge for a feature the user hasn't used yet -- deliberately a
// THIRD, different persistence model from the other two onboarding pieces:
//   - GuidedTour (lib/tour.tsx): one-time, modal, dismiss = gone forever.
//   - Getting Started checklist (lib/gettingStarted.ts): one card,
//     dismiss = gone forever (it's fine there -- the checklist itself lists
//     every task, so closing it doesn't hide any single task from view).
// A feature nudge is neither: if the user dismisses it without actually
// using the feature, the assumption is still "they don't know this exists,"
// so it comes back later instead of vanishing -- that's what was asked for.
// "Later" is a cooldown window, not literally next render, so it never nags.
//
// Whether to show one at all is always driven by real usage (a caller-
// supplied boolean from actual server data, e.g. OnboardingProgress),
// never by whether it's been dismissed alone -- dismissal only ever
// SUPPRESSES it for the cooldown, it can't PERMANENTLY silence a feature
// that's still genuinely unused.

const NUDGE_COOLDOWN_HOURS = 24

function lastShownKey(userId: string, featureKey: string): string {
  return `psync_feature_nudge_last_shown:${userId}:${featureKey}`
}

export function shouldShowFeatureNudge(userId: string, featureKey: string): boolean {
  try {
    const raw = localStorage.getItem(lastShownKey(userId, featureKey))
    if (!raw) return true
    const last = Number(raw)
    if (!Number.isFinite(last)) return true
    return Date.now() - last > NUDGE_COOLDOWN_HOURS * 60 * 60 * 1000
  } catch {
    // Storage blocked (private browsing) -- fail closed (don't show) rather
    // than nag on every single render with no way to ever suppress it.
    return false
  }
}

export function recordFeatureNudgeShown(userId: string, featureKey: string): void {
  try {
    localStorage.setItem(lastShownKey(userId, featureKey), String(Date.now()))
  } catch {
    // Not worth surfacing: it just won't respect the cooldown this session.
  }
}

// A SEPARATE, global cooldown on top of the per-feature one above -- without
// this, growing the feature list (App.tsx's FEATURE_DISCOVERY) would make
// popups more frequent in aggregate even though each individual feature
// still respects its own 24h window: dismiss #1, and #2 (never shown before,
// so its own cooldown is wide open) would be free to pop up on the very next
// page load. This caps it to at most one discovery popup overall per window,
// no matter how many features end up in the list -- adding more only widens
// what MIGHT be picked, never how often something is.
function globalLastShownKey(userId: string): string {
  return `psync_feature_nudge_global_last_shown:${userId}`
}

export function shouldShowAnyFeatureNudge(userId: string): boolean {
  try {
    const raw = localStorage.getItem(globalLastShownKey(userId))
    if (!raw) return true
    const last = Number(raw)
    if (!Number.isFinite(last)) return true
    return Date.now() - last > NUDGE_COOLDOWN_HOURS * 60 * 60 * 1000
  } catch {
    return false
  }
}

export function recordAnyFeatureNudgeShown(userId: string): void {
  try {
    localStorage.setItem(globalLastShownKey(userId), String(Date.now()))
  } catch {
    // Not worth surfacing: it just won't respect the cooldown this session.
  }
}
