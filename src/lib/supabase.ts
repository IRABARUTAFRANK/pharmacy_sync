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
