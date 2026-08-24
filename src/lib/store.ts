// Branch/application record shape shared between src/lib/onboarding.ts (which
// maps real Supabase rows into it) and the admin/branch-portal pages that
// display it. No mock data or localStorage here anymore -- onboarding.ts is
// the real backing store.

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
