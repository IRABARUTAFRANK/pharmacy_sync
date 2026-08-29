// Natural-language business analyst for this branch: predictions, trend
// analysis, sales forecasting, and general data interpretation, answered by
// Claude with a fixed set of read-only, branch-scoped SQL tools -- never a
// raw/arbitrary query. Claude decides which tool(s) a question needs and
// synthesizes the numbers into a plain-language answer; it never invents a
// number itself, and forecasting is real linear-regression math computed in
// Postgres (ai_sales_forecast), not something the model extrapolates.
//
// Security: this function never touches the service-role key. Every tool
// call runs through a Supabase client scoped to the CALLER's own JWT, so the
// exact same current_branch_id() scoping and assert_owner_or_manager() role
// gate every other RPC in this app already relies on apply here too -- an
// owner/manager can only ever see their own branch's data, and a seller is
// rejected before any tool ever runs. No new auth mechanism.
//
// Deploy with (from the project root, after `supabase login` and
// `supabase link --project-ref <ref>`):
//   supabase functions deploy ai-analyst
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically by the Edge
// Function runtime -- only the Anthropic key needs to be set by hand.

import { createClient } from "jsr:@supabase/supabase-js@2"
import Anthropic from "npm:@anthropic-ai/sdk@0.70"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
}

// One tool per RPC in the SQL migration below. Descriptions are deliberately
// detailed -- they're the only thing telling Claude when each tool applies,
// and a vague description here is a wrong-tool-choice bug waiting to happen,
// not a cosmetic issue.
const TOOLS: Anthropic.Tool[] = [
  {
    name: "branch_snapshot",
    description: "A quick 'state of the business right now' overview: today's/week-to-date/month-to-date revenue, active product count, out-of-stock/low-stock/expiring-soon counts, pending product requests, unread alerts. Takes no arguments. Good first call for a broad or vague question, or anything asking 'how are we doing'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sales_trend",
    description: "Revenue, tax, insurance-covered amount, patient-paid amount, and transaction count over a date range, bucketed by day, week, or month. Use for trend questions ('how have sales moved', 'which days are busiest') and as the raw series behind a forecast question if sales_forecast's fixed horizon doesn't fit.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Start date, YYYY-MM-DD, inclusive." },
        to_date: { type: "string", description: "End date, YYYY-MM-DD, inclusive." },
        bucket: { type: "string", enum: ["day", "week", "month"], description: "Default day." },
      },
      required: ["from_date", "to_date"],
      additionalProperties: false,
    },
  },
  {
    name: "top_products",
    description: "Ranks products by revenue or quantity sold over a date range, ascending or descending -- so this answers BOTH 'best sellers' (desc) and 'worst/slowest sellers' (asc) questions.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "YYYY-MM-DD" },
        to_date: { type: "string", description: "YYYY-MM-DD" },
        metric: { type: "string", enum: ["revenue", "quantity"], description: "Default revenue." },
        direction: { type: "string", enum: ["asc", "desc"], description: "desc = top sellers, asc = worst sellers. Default desc." },
        limit: { type: "integer", description: "1-50, default 10." },
      },
      required: ["from_date", "to_date"],
      additionalProperties: false,
    },
  },
  {
    name: "category_breakdown",
    description: "Revenue and quantity sold per product category over a date range. Use for 'which category sells best' or margin/mix questions.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "YYYY-MM-DD" },
        to_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["from_date", "to_date"],
      additionalProperties: false,
    },
  },
  {
    name: "stock_status",
    description: "Current stock levels for this branch's products, optionally filtered to only out-of-stock, low-stock (below its reorder point), expiring within 60 days, or already-expired items. Use for restocking/expiry questions.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["low", "out", "expiring", "expired", "all"], description: "Default all." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sales_forecast",
    description: "A real statistical projection (linear regression over daily sales history, not a guess) of future demand and revenue. Pass EITHER a product_id, OR a category_id, OR neither (whole-branch forecast) -- never both. Use for any 'predict'/'forecast'/'how much will we sell'/'when will we run out' question. If a product or category name was given in the question rather than an id, look it up first (e.g. via top_products or category_breakdown) before calling this.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "UUID of a specific product to forecast. Omit for a category or branch-wide forecast." },
        category_id: { type: "string", description: "UUID of a specific category to forecast. Omit for a product or branch-wide forecast." },
        days_history: { type: "integer", description: "How many past days of sales to base the trend on. 7-730, default 90." },
        horizon_days: { type: "integer", description: "How many days into the future to project. 1-365, default 30." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "insurance_summary",
    description: "Per-insurance-provider claim totals over a date range: claim count, total claimed, amount actually paid out, and amount still pending. Use for insurance/reimbursement questions.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "YYYY-MM-DD" },
        to_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["from_date", "to_date"],
      additionalProperties: false,
    },
  },
  {
    name: "seller_performance",
    description: "Per-staff-member transaction count and revenue over a date range. Use for 'who sold the most' or staff performance questions.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "YYYY-MM-DD" },
        to_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["from_date", "to_date"],
      additionalProperties: false,
    },
  },
  {
    name: "patient_summary",
    description: "Patient activity over a date range: how many patients were served, how many were new, how many were repeat visits, and the single highest-spending patient. Use for patient/customer questions.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "YYYY-MM-DD" },
        to_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["from_date", "to_date"],
      additionalProperties: false,
    },
  },
]

// Maps each tool name to the RPC + argument-name translation it wraps.
// Kept as one small table rather than a switch so adding a tool later is a
// one-line addition here plus one new entry in TOOLS above.
const TOOL_RPC: Record<string, { fn: string; args: (input: any) => Record<string, unknown> }> = {
  branch_snapshot: { fn: "ai_branch_snapshot", args: () => ({}) },
  sales_trend: { fn: "ai_sales_trend", args: i => ({ p_from: i.from_date, p_to: i.to_date, p_bucket: i.bucket ?? "day" }) },
  top_products: { fn: "ai_top_products", args: i => ({ p_from: i.from_date, p_to: i.to_date, p_metric: i.metric ?? "revenue", p_direction: i.direction ?? "desc", p_limit: i.limit ?? 10 }) },
  category_breakdown: { fn: "ai_category_breakdown", args: i => ({ p_from: i.from_date, p_to: i.to_date }) },
  stock_status: { fn: "ai_stock_status", args: i => ({ p_filter: i.filter ?? "all" }) },
  sales_forecast: { fn: "ai_sales_forecast", args: i => ({ p_product_id: i.product_id ?? null, p_category_id: i.category_id ?? null, p_days_history: i.days_history ?? 90, p_horizon_days: i.horizon_days ?? 30 }) },
  insurance_summary: { fn: "ai_insurance_summary", args: i => ({ p_from: i.from_date, p_to: i.to_date }) },
  seller_performance: { fn: "ai_seller_performance", args: i => ({ p_from: i.from_date, p_to: i.to_date }) },
  patient_summary: { fn: "ai_patient_summary", args: i => ({ p_from: i.from_date, p_to: i.to_date }) },
}

const MAX_TOOL_ROUNDS = 6

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401)

  let body: { question?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: "Invalid request body" }, 400)
  }
  const question = (body.question ?? "").trim()
  if (!question) return json({ error: "A question is required" }, 400)
  if (question.length > 2000) return json({ error: "That question is too long" }, 400)

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")
  if (!anthropicKey) return json({ error: "The AI analyst is not configured yet (missing ANTHROPIC_API_KEY)." }, 500)

  // Scoped to the caller's own JWT, never the service role -- every RPC this
  // calls enforces current_branch_id()/assert_owner_or_manager() itself, so
  // this client only ever sees what that specific signed-in user already can.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError || !authData.user) return json({ error: "Not signed in" }, 401)

  const anthropic = new Anthropic({ apiKey: anthropicKey })
  const today = new Date().toISOString().slice(0, 10)

  const system = `You are the business analyst built into a pharmacy management system called PharmSync. You answer the branch owner/manager's questions about their own pharmacy's sales, stock, insurance, staff, and patients, using the tools provided -- every one of them is a real, read-only, already-branch-scoped query, and you must call a tool to get any number rather than estimate or recall one. Today's date is ${today}. Amounts are in Rwandan francs (RWF); format them with thousands separators, e.g. "RWF 45,000", never as raw numbers or with a dollar sign. When a question needs a date range and none was given, use a sensible recent default (e.g. the last 30 days) and say which range you used. If a tool call fails or returns no data, say so plainly rather than guessing a number. Keep answers concise and business-focused: lead with the direct answer, then the one or two numbers that support it; skip lengthy preamble. When asked to forecast or predict, always use the sales_forecast tool -- never extrapolate a trend yourself from sales_trend data.`

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }]

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: "claude-opus-5",
        max_tokens: 4096,
        system,
        tools: TOOLS,
        messages,
      })

      if (response.stop_reason !== "tool_use") {
        const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text
        return json({ answer: text ?? "I couldn't come up with an answer to that." })
      }

      messages.push({ role: "assistant", content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== "tool_use") continue
        const mapping = TOOL_RPC[block.name]
        if (!mapping) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Unknown tool "${block.name}".`, is_error: true })
          continue
        }
        const { data, error } = await supabase.rpc(mapping.fn, mapping.args(block.input))
        if (error) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: error.message, is_error: true })
        } else {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(data ?? []) })
        }
      }
      messages.push({ role: "user", content: toolResults })
    }

    return json({ answer: "That question needed more steps than I'm allowed to take at once -- try asking a narrower version of it." })
  } catch (reason) {
    const message = reason instanceof Anthropic.APIError ? reason.message : "The AI analyst hit an unexpected error."
    return json({ error: message }, 502)
  }
})
