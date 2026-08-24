import { supabase } from "./supabase"

// Real support tickets (public.support_tickets), replacing the
// localStorage-only mock that used to back AdminPortal.tsx's Tickets tab
// and HelpPage.tsx's ticket list.

export type TicketStatus = "open" | "in_progress" | "resolved" | "closed"
export type TicketPriority = "low" | "medium" | "high"

function raise(error: { message: string } | null): never {
  throw new Error(error?.message ?? "The support ticket service could not complete this request.")
}

export async function submitSupportTicket(subject: string, description: string, priority: TicketPriority = "medium"): Promise<string> {
  const { data, error } = await supabase.rpc("submit_support_ticket", {
    p_subject: subject,
    p_description: description,
    p_priority: priority,
  })
  if (error) raise(error)
  return data as string
}

export interface MyTicketRow {
  id: string
  subject: string
  description: string | null
  status: TicketStatus
  priority: TicketPriority
  created_at: string
}

export async function listMySupportTickets(): Promise<MyTicketRow[]> {
  const { data, error } = await supabase.rpc("list_my_support_tickets")
  if (error) raise(error)
  return (data ?? []) as MyTicketRow[]
}

export interface AdminTicketRow extends MyTicketRow {
  branch_id: string
  branch_name: string
  raised_by_name: string
}

export async function adminListSupportTickets(): Promise<AdminTicketRow[]> {
  const { data, error } = await supabase.rpc("admin_list_support_tickets")
  if (error) raise(error)
  return (data ?? []) as AdminTicketRow[]
}

export async function adminUpdateTicketStatus(ticketId: string, status: TicketStatus): Promise<void> {
  const { error } = await supabase.rpc("admin_update_ticket_status", { p_ticket_id: ticketId, p_status: status })
  if (error) raise(error)
}
