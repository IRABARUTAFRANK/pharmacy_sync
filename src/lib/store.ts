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

// Same shape as BranchRecord, for the organization-first public registration
// flow (register the company -> admin verifies -> OTP -> register the first
// branch). legalName/tin replace pharmacyName; organizationId/firstBranchId
// replace branchId -- firstBranchId is specifically what distinguishes
// "OTP verified, no branch yet" from "fully done" (status alone can't,
// since it's 'active' the instant OTP verification succeeds, before any
// branch exists -- see register_first_branch() in the schema).
export interface OrganizationApplicationRecord {
  id: string;
  applicationCode?: string;
  legalName: string;
  tin?: string;
  phone: string;
  email: string;
  location: string;
  submittedAt: string;
  status: BranchStatus;
  organizationId?: string;
  firstBranchId?: string;
  branchCode?: string;
  activationCode?: string;
  calledAt?: string;
  deniedReason?: string;
}
