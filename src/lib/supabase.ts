import { createClient } from "@supabase/supabase-js"

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Missing Supabase configuration. Copy .env.example to .env.local and provide the project URL and publishable key.",
  )
}

export const supabase = createClient(supabaseUrl, supabaseKey)
