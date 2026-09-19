import { useState } from "react"
import { Card, CenterAlert, SectionHeader, Btn } from "../components"
import { useTranslation } from "../lib/i18n"
import { haversineKm } from "../lib/maps"
import type { OrganizationBranch, OrganizationSummary } from "../lib/organization"
import { RequestStockModal, RequestTransferModal, type BranchWithDistance } from "./StockRequestModals"

// Its own sidebar tab (App.tsx's NAV_ITEMS 'branchTransfers', shown only for
// an org_owner/org_manager -- see computeVisibleNav) rather than a couple
// of loose toolbar buttons on the Overview page: requesting a transfer or
// stock FOR whichever branch is currently open (the caller's own, or one
// reached via "View Branch") deserves a real destination, not something
// crammed next to Export/Customize. Organization > Stock Transfers keeps
// the two all-organization oversight lists; this is purely the "do
// something for THIS branch" side.
export default function BranchTransferPage({ branchId, organization, branches }: {
  branchId?: string
  organization: OrganizationSummary | null
  branches: OrganizationBranch[]
}) {
  const { t } = useTranslation()
  const [showRequestTransfer, setShowRequestTransfer] = useState(false)
  const [showRequestStock, setShowRequestStock] = useState(false)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [successSeq, setSuccessSeq] = useState(0)

  const thisBranch = branches.find(b => b.branchId === branchId) ?? null
  const thisBranchName = thisBranch?.name ?? organization?.legalName ?? ""

  // Same distance-sort as OrganizationPage.tsx's own destinationBranches --
  // duplicated rather than shared since it's a handful of lines keyed to
  // whichever branch this page is open for, not the caller's own.
  const destinationBranches: BranchWithDistance[] = branches
    .filter(b => b.branchId !== branchId)
    .map(b => ({
      ...b,
      distanceKm:
        thisBranch?.latitude != null && thisBranch?.longitude != null && b.latitude != null && b.longitude != null
          ? haversineKm(thisBranch.latitude, thisBranch.longitude, b.latitude, b.longitude)
          : null,
    }))
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SectionHeader
        title={t("branchTransferPage.title")}
        subtitle={t("branchTransferPage.subtitle", { branch: thisBranchName })}
      />
      {successMsg && <CenterAlert key={successSeq} message={successMsg} />}
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>🔁 {t("organization.requestTransferTitle")}</div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.requestTransferIntro")}</p>
        </div>
        <Btn variant="primary" small onClick={() => setShowRequestTransfer(true)}>+ {t("overviewPage.requestTransferButton")}</Btn>
      </Card>
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>📥 {t("organization.requestStockTitle")}</div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.requestStockIntro")}</p>
        </div>
        <Btn variant="primary" small onClick={() => setShowRequestStock(true)}>+ {t("overviewPage.requestStockButton")}</Btn>
      </Card>

      {showRequestTransfer && (
        <RequestTransferModal
          destinationBranches={destinationBranches}
          fromBranchId={branchId}
          onClose={() => setShowRequestTransfer(false)}
          onRequested={() => {
            setShowRequestTransfer(false)
            setSuccessMsg(t("overviewPage.transferRequestedToast"))
            setSuccessSeq(s => s + 1)
          }}
        />
      )}
      {showRequestStock && (
        <RequestStockModal
          destinationBranches={destinationBranches}
          fromBranchId={branchId}
          onClose={() => setShowRequestStock(false)}
          onRequested={() => {
            setShowRequestStock(false)
            setSuccessMsg(t("overviewPage.stockRequestedToast"))
            setSuccessSeq(s => s + 1)
          }}
        />
      )}
    </div>
  )
}
