import { createClient } from "@supabase/supabase-js"

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Missing Supabase configuration. Copy .env.example to .env.local and provide the project URL and publishable key.",
  )
}

export const supabase = createClient(supabaseUrl, supabaseKey)

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
