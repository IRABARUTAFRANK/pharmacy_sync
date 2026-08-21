// Shared localStorage "backend" linking admin and branch portals

export type BranchStatus = "pending" | "approved" | "otp_sent" | "active" | "locked" | "denied";

export interface BranchRecord {
  id: string;
  applicationCode?: string;
  pharmacyName: string;
  phone: string;
  email: string;
  location: string;
  submittedAt: string;
  status: BranchStatus;
  otp?: string;
  otpExpiresAt?: string;
  branchId?: string;
  branchCode?: string;
  activationCode?: string;
  failedLogins: number;
  lockedAt?: string;
  calledAt?: string;
  deniedReason?: string;
}

export interface TicketRecord {
  id: string;
  branchId: string;
  branchName: string;
  subject: string;
  message: string;
  priority: "low" | "medium" | "high";
  status: "open" | "in_progress" | "resolved";
  submittedAt: string;
}

const BRANCHES_KEY = "psync_branches";
const TICKETS_KEY = "psync_tickets";

function seedIfEmpty() {
  if (!localStorage.getItem(BRANCHES_KEY)) {
    const seed: BranchRecord[] = [
      {
        id: "BR-001",
        pharmacyName: "Kisumu Lake Side Pharmacy",
        phone: "+254 712 345 678",
        email: "kisumu.lakeside@pharmaco.ke",
        location: "Kisumu, Kondele Market, Shop 14",
        submittedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        status: "active",
        branchCode: "PSYNC-KSM-001",
        activationCode: "ACT-7X9K2M",
        failedLogins: 1,
        calledAt: new Date(Date.now() - 3 * 86400000 + 3600000).toISOString(),
      },
      {
        id: "BR-002",
        pharmacyName: "Eldoret Highlands Pharmacy",
        phone: "+254 733 987 654",
        email: "eldoret.hl@pharmaco.ke",
        location: "Eldoret, Uganda Road, Opp. Total Petrol",
        submittedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        status: "locked",
        branchCode: "PSYNC-ELD-002",
        activationCode: "ACT-4P2NRQ",
        failedLogins: 7,
        lockedAt: new Date(Date.now() - 86400000).toISOString(),
        calledAt: new Date(Date.now() - 5 * 86400000 + 3600000).toISOString(),
      },
      {
        id: "BR-003",
        pharmacyName: "Nairobi Central Pharmacy",
        phone: "+254 722 111 222",
        email: "nairobi.central@pharmaco.ke",
        location: "Nairobi CBD, Tom Mboya St, Ground Floor",
        submittedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
        status: "pending",
        failedLogins: 0,
      },
      {
        id: "BR-004",
        pharmacyName: "Mombasa Coast Branch",
        phone: "+254 741 555 666",
        email: "coast.branch@pharmaco.ke",
        location: "Mombasa, Nyali Bridge Road",
        submittedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        status: "pending",
        failedLogins: 0,
      },
    ];
    localStorage.setItem(BRANCHES_KEY, JSON.stringify(seed));
  }
  if (!localStorage.getItem(TICKETS_KEY)) {
    const seed: TicketRecord[] = [
      {
        id: "TKT-001",
        branchId: "BR-001",
        branchName: "Kisumu Lake Side Pharmacy",
        subject: "Cannot generate monthly stock report",
        message:
          "When we click Generate Monthly Report the page freezes. This started after the Aug 18 update. We need this urgently for our compliance submission.",
        priority: "high",
        status: "open",
        submittedAt: new Date(Date.now() - 6 * 3600000).toISOString(),
      },
      {
        id: "TKT-002",
        branchId: "BR-001",
        branchName: "Kisumu Lake Side Pharmacy",
        subject: "Invoice numbering reset to 1",
        message:
          "Our invoice sequence jumped back to INV-0001 after a system update. Customers are confused.",
        priority: "medium",
        status: "in_progress",
        submittedAt: new Date(Date.now() - 20 * 3600000).toISOString(),
      },
    ];
    localStorage.setItem(TICKETS_KEY, JSON.stringify(seed));
  }
}

export function getBranches(): BranchRecord[] {
  seedIfEmpty();
  return JSON.parse(localStorage.getItem(BRANCHES_KEY) || "[]");
}

export function saveBranches(branches: BranchRecord[]): void {
  localStorage.setItem(BRANCHES_KEY, JSON.stringify(branches));
}

export function getTickets(): TicketRecord[] {
  seedIfEmpty();
  return JSON.parse(localStorage.getItem(TICKETS_KEY) || "[]");
}

export function saveTickets(tickets: TicketRecord[]): void {
  localStorage.setItem(TICKETS_KEY, JSON.stringify(tickets));
}

export function nextBranchId(): string {
  const branches = getBranches();
  const nums = branches.map((b) => parseInt(b.id.split("-")[1] || "0", 10));
  const max = nums.length ? Math.max(...nums) : 0;
  return `BR-${String(max + 1).padStart(3, "0")}`;
}

export function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function generateBranchCode(location: string, id: string): string {
  const loc = location.split(",")[0].slice(0, 3).toUpperCase().replace(/\s/g, "");
  const num = id.split("-")[1];
  return `PSYNC-${loc}-${num}`;
}

export function generateActivationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "ACT-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
