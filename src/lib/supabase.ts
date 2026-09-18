import { createClient } from "@supabase/supabase-js"

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Missing Supabase configuration. Copy .env.example to .env.local and provide the project URL and publishable key.",
  )
}

// sessionStorage, not the supabase-js default of localStorage -- localStorage
// is shared by every tab of the same origin, so opening a second tab and
// signing in as a different branch's login there silently replaced the
// session in the FIRST tab too (both read the same stored token). A branch
// manager already signed in couldn't open a second tab to sign into a
// different branch without being signed out of the first one. sessionStorage
// is scoped per tab -- a new tab starts with no session (shows the sign-in
// gate) and can hold its own independent login, exactly like opening a
// second, unrelated browser tab should. The tradeoff: closing a tab now
// forgets that tab's session (reloading the SAME tab still keeps it, since
// sessionStorage survives a reload, just not a close) -- previously, closing
// and reopening a tab kept you signed in indefinitely. This mirrors
// supabaseAdmin.ts's own storageKey isolation for the same class of problem,
// just solved per-tab instead of per-persona.
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { storage: window.sessionStorage },
})

// Supabase's query/RPC errors (PostgrestError, AuthError, etc.) are plain
// objects with a `message` field -- they are NOT `instanceof Error`. Checking
// `instanceof Error` before falling back to a generic string is why real
// errors from the database were showing up as either a hardcoded fallback or,
// worse, the literal text "[object Object]" (from `String(plainObject)`).
// Every catch block that surfaces a thrown value to the user should go
// through this instead of rolling its own check.
export function errorMessage(reason: unknown, fallback = "Something went wrong."): string {
  if (reason instanceof Error) return reason.message
  if (reason && typeof reason === "object" && "message" in reason) {
    const message = (reason as { message: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }
  return fallback
}

// PostgREST caps how many rows a single unbounded `.select()` returns (the
// project's own "Max Rows" setting -- confirmed at this project's default of
// 1000 in Project Settings -> Data API) -- it does NOT raise an error when a
// query hits that cap, it just silently returns fewer rows than actually
// exist. A `.select("*")` with no `.range()`/`.limit()` on a table that
// keeps growing (barcodes especially -- one row per physical pack/box ever
// received, so a single delivery of a few hundred cartons can produce
// thousands of rows on its own) will eventually hit this and quietly show
// incomplete data with no error anywhere to explain why. Raising the
// project's Max Rows setting only moves the ceiling, it doesn't remove it --
// this fetches every row by paging through with `.range()`, so no single
// request is ever bigger than `pageSize`, and the result is always complete
// regardless of how large the table has grown, no matter what Max Rows is
// set to.
//
// pageSize (2000) is just the requested page size, not a correctness
// requirement -- if Max Rows is lower (the 1000 default), PostgREST caps
// every request's actual response to Max Rows regardless of what was asked
// for, and the loop below advances by however many rows actually came back
// each time and only stops on a genuinely empty page, so this stays
// correct -- just slower, more round trips -- at any Max Rows setting.
// Raising Max Rows to something like 5000 (Project Settings -> Data API)
// mainly buys fewer round trips, not correctness.
//
// `build` must apply the SAME stable `.order()` the caller would have used
// on an unbounded select -- range-based paging without a stable order can
// return duplicate or skipped rows, since Postgres doesn't guarantee row
// order without one. Ordering by a table's own primary key (id) is always
// safe even when it's a UUID with no natural sequence.
export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 2000,
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) throw error
    const rows = data ?? []
    // Stop only on a genuinely empty page, and advance by however many rows
    // actually came back (not by pageSize) -- if Max Rows is lower than
    // pageSize, PostgREST silently caps EVERY request to Max Rows
    // regardless of what range was asked for, so a request for 2000 rows
    // with Max Rows at 1000 comes back as exactly 1000 rows even when the
    // table holds more. Treating "got fewer than pageSize" as "reached the
    // end" would misread that as done and truncate at 1000 -- the exact bug
    // this function exists to fix. Only an empty page is a reliable signal
    // there's nothing left, whatever Max Rows actually is.
    if (rows.length === 0) return all
    all.push(...rows)
    from += rows.length
  }
}

// Spread into an .rpc() args object for any "view another branch" call
// (see App.tsx's `viewingBranch`). Omits the key entirely rather than
// sending `p_branch_id: null` -- PostgREST resolves an RPC call by which
// named parameters are PRESENT in the request body, so a present-but-null
// p_branch_id looks for a one-argument overload and 404s against a database
// that hasn't been migrated to accept it yet, where simply omitting the key
// matches the original zero-argument function every existing caller already
// relies on. Safe to spread unconditionally once every branch-scoped
// function in src/datatabase has its p_branch_id parameter deployed.
export function branchArg(branchId?: string): { p_branch_id: string } | Record<string, never> {
  return branchId ? { p_branch_id: branchId } : {}
}
