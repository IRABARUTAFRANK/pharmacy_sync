import { supabase } from "./supabase"

// Backs the "Getting Started" checklist on the Overview dashboard -- the
// first, highest-leverage piece of the Slack-style "just-in-time" onboarding
// redesign (see lib/tour.tsx for the older one-shot shell tour this
// complements rather than replaces). Every item here reflects real usage
// (see get_onboarding_progress() in the schema), not a client-only "did they
// click next" flag, so it stays correct even opened from a different device.

export interface OnboardingProgress {
  receivedStock: boolean
  completedSale: boolean
  setReorderPoint: boolean
  addedPatient: boolean
  invitedStaff: boolean
  // These three aren't part of the Getting Started checklist (that stays the
  // five core "set up your branch" tasks above) -- they're extra real-usage
  // signals for App.tsx's feature-discovery popup only. See that file's
  // FEATURE_DISCOVERY list.
  usedDiscount: boolean
  createdCategory: boolean
  usedInsurance: boolean
}

export async function loadOnboardingProgress(): Promise<OnboardingProgress> {
  const { data, error } = await supabase.rpc("get_onboarding_progress")
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return {
    receivedStock: !!row?.received_stock,
    completedSale: !!row?.completed_sale,
    setReorderPoint: !!row?.set_reorder_point,
    addedPatient: !!row?.added_patient,
    invitedStaff: !!row?.invited_staff,
    usedDiscount: !!row?.used_discount,
    createdCategory: !!row?.created_category,
    usedInsurance: !!row?.used_insurance,
  }
}

// Deliberately references only the original five fields by name (not e.g.
// Object.values(progress)) -- the three feature-discovery-only signals above
// must never silently start counting toward the checklist's "X of 5 done".
export function onboardingCompletionCount(progress: OnboardingProgress): number {
  return [progress.receivedStock, progress.completedSale, progress.setReorderPoint, progress.addedPatient, progress.invitedStaff]
    .filter(Boolean).length
}

// Dismissal is per-user, in this browser -- same storage shape as
// hasCompletedTour()/markTourComplete() in lib/tour.tsx. Dismissing (or
// finishing all five items) is permanent, same "skip counts as done"
// philosophy as the tour: this should never force itself back on someone
// who closed it.
const dismissedKey = (userId: string) => `psync_onboarding_checklist_dismissed:${userId}`

export function isOnboardingChecklistDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(userId)) === "1"
  } catch {
    return true
  }
}

export function dismissOnboardingChecklist(userId: string): void {
  try {
    localStorage.setItem(dismissedKey(userId), "1")
  } catch {
    // Not worth surfacing: it still hides for this session.
  }
}
