-- Fix: batch_recalls and stock_adjustments have RLS policies but were never
-- granted to `authenticated`, so PostgREST has been returning permission-denied
-- for both regardless of the policy. Run this once against the live project.
-- Both policies are select-only, so this grant matches that scope exactly.

grant select on public.batch_recalls, public.stock_adjustments to authenticated;
