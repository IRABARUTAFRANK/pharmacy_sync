import { createClient } from "@supabase/supabase-js"

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

// A second, independent client for the super-admin console (#admin) only --
// deliberately NOT the same client the branch/POS app uses (lib/supabase.ts).
//
// supabase-js persists its auth session under one fixed localStorage key per
// client, shared by every tab on the same origin. With a single shared
// client, verifying the admin OTP (supabase.auth.verifyOtp in the admin
// sign-in flow) silently REPLACED a branch user's live session everywhere --
// including a Sales tab mid-sale in another tab of the same browser. That
// tab kept rendering its last-fetched branch data (so it still looked signed
// in), but the next write went out under the super admin's identity, which
// has no public.users row -- exactly what complete_sale() reports as "Only
// an active branch user may complete a sale". signing out of the admin
// console the same way could also silently sign a branch user out entirely.
//
// A distinct storageKey gives each persona its own slot, so neither one can
// clobber the other's session just by being open in another tab.
export const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
  auth: { storageKey: "psync-admin-auth" },
})
