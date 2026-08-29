import { FunctionsHttpError } from "@supabase/supabase-js"
import { supabase } from "./supabase"

// Calls the ai-analyst Edge Function (supabase/functions/ai-analyst), which
// does the real work: it forwards this session's own JWT to Postgres (so
// every tool call there is scoped by current_branch_id()/assert_owner_or_
// manager() exactly like every other RPC in this app -- nothing new to trust
// here), runs Claude's tool-use loop against a fixed set of read-only SQL
// tools, and returns one plain-language answer. This file has no analysis
// logic of its own; it is purely the HTTP call.
export async function askAnalyst(question: string): Promise<string> {
  const trimmed = question.trim()
  if (!trimmed) throw new Error("Ask a question first.")
  const { data, error } = await supabase.functions.invoke<{ answer?: string; error?: string }>("ai-analyst", {
    body: { question: trimmed },
  })
  if (error) {
    // On a non-2xx response the SDK's error.message is always the generic
    // "Edge Function returned a non-2xx status code" -- the function's own
    // {error: "..."} body (e.g. "credit balance too low") only shows up on
    // error.context, a raw fetch Response that has to be read separately.
    if (error instanceof FunctionsHttpError) {
      let message: string = error.message
      try {
        const body = await error.context.json()
        if (body?.error) message = body.error
      } catch {
        // body wasn't JSON (or already consumed) -- fall back to the generic message
      }
      throw new Error(message)
    }
    throw new Error(error.message)
  }
  if (data?.error) throw new Error(data.error)
  if (!data?.answer) throw new Error("The AI analyst didn't return an answer.")
  return data.answer
}
