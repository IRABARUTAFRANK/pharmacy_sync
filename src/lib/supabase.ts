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

// PostgREST caps a single select at 1000 rows. Tables that aren't branch-scoped
// (products, product_variants) pass that cap as soon as a real price-list import
// lands -- a plain select silently truncates alphabetically/by id, and anything
// past the cutoff (e.g. a product named "PARODONTAX...") just disappears from
// every screen that lists the catalogue, with no error. barcodes hits the same
// wall from the other direction: it's branch-scoped, but one row per physical
// pack/carton means a single large delivery (a hundred cartons, each split
// into packs) can push a branch's own barcode count past 1000 on its own --
// seen live on a branch sitting at 4,600+ barcodes, where the newest delivery
// just silently never showed up in Barcode Manager or Live Inventory. Paged to
// exhaustion so the app always sees everything that's actually in the database.
const FETCH_ALL_PAGE_SIZE = 1000

export async function fetchAll<T>(
  table: string, columns: string, orderColumn: string,
  tune?: (query: any) => any, ascending = true,
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; ; page++) {
    let query = supabase.from(table).select(columns).order(orderColumn, { ascending }) as any
    if (tune) query = tune(query)
    const { data, error } = await query.range(page * FETCH_ALL_PAGE_SIZE, page * FETCH_ALL_PAGE_SIZE + FETCH_ALL_PAGE_SIZE - 1)
    if (error) throw error
    const batch = (data ?? []) as T[]
    rows.push(...batch)
    if (batch.length < FETCH_ALL_PAGE_SIZE) return rows
  }
}
