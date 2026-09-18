import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts"
import { Btn, Card, CenterAlert, ChartTooltip, Modal, SectionHeader, StatusBadge } from "../components"
import { useTranslation } from "../lib/i18n"
import type { TranslationKey } from "../lib/i18n/en"
import { errorMessage } from "../lib/supabase"
import {
  addBranchToOrganization, assignBranchRole, createPharmacyOrganization, inviteOrganizationMember,
  listOrganizationBranches, listOrganizationPeople, listRoleChangeLog, orgBranchSummary, removeOrganizationMember,
  setPersonActive, staffOrganizationBranch, updateOrganizationDetails, changeOrganizationMemberRole,
  saveBranchDistanceMeasurement, listBranchDistanceMeasurements, deleteBranchDistanceMeasurement,
  type OrgAssignableRole, type BranchDistanceMeasurement,
  type BranchRole, type OrgBranchSummary, type OrgRole, type OrganizationBranch, type OrganizationPerson,
  type OrganizationSummary, type RoleChangeLogEntry,
} from "../lib/organization"
import { loadInventoryDataset, type InventoryRow } from "../lib/inventory"
import {
  approveStockTransfer, cancelStockTransfer, dispatchStockTransfer, listBranchStockTransfers,
  listOrganizationStockTransfers, receiveStockTransfer, rejectStockTransfer, requestStockTransfer,
  type StockTransfer, type StockTransferStatus,
} from "../lib/stockTransfers"
import {
  approveStockNeed, listBranchBatchesForVariant, listIncomingStockOffers, listStockNeedOffers, listStockNeeds,
  rejectStockNeed, requestStockFromBranch, respondToStockOffer, retryStockNeed,
  type IncomingStockOffer, type StockNeed, type StockNeedBatch, type StockNeedStatus,
} from "../lib/stockNeeds"
import { loadOrgOverview, type OverviewPeriod } from "../lib/overview"
import type { LiveAlert } from "../lib/alerts"
import L from "leaflet"
import { addBaseLayerToggle, haversineKm, OSM_ATTRIBUTION, OSM_TILE_URL, PHARMACY_ICON, toggleFullscreen } from "../lib/maps"
import { PasswordInput } from "./AuthShell"
import OverviewPage from "./OverviewPage"

const inputStyle = { width: "100%", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" as const }
const labelStyle = { fontSize: 10, fontWeight: 600, color: "var(--ink-muted)", textTransform: "uppercase" as const, letterSpacing: "0.05em", display: "block", marginBottom: 4 }

// An OrganizationBranch with its straight-line distance from the caller's
// own branch folded in -- null when either branch has no location pin set.
// See destinationBranches below for how it's computed and sorted.
type BranchWithDistance = OrganizationBranch & { distanceKm: number | null }

function formatDistance(km: number | null, t: (key: TranslationKey) => string): string {
  return km == null ? t("organization.distanceUnknown") : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`
}

// Small "see your branches on a map" visual for the Branches tab -- purely
// a bonus overview (the real payoff of setting a branch's location is the
// distance sort in destinationBranches above). Built on Leaflet +
// OpenStreetMap tiles -- free, no API key -- see src/lib/maps.ts's header.
//
// Also carries the two things org_owner/org_manager asked for beyond just
// "see the pins": a Map/Satellite layer switcher (addBaseLayerToggle, the
// same control every mainstream map product has), and a click-to-measure
// distance tool -- click one branch pin, then another, and the straight-line
// distance is drawn between them and labeled right on the map. Distance
// measurement only makes sense with 2+ pins, so it's gated on that; the
// layer switcher is useful even with a single branch. The map frames every
// located branch automatically (fitBounds), not a fixed zoom level, so it
// looks right whether the branches are a block apart or across the country.
function BranchesMiniMap({ branches, organizationId }: { branches: OrganizationBranch[]; organizationId: string }) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState<string | null>(null)
  const [tilesLoading, setTilesLoading] = useState(true)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const boundsRef = useRef<L.LatLngBounds | null>(null)
  const measuringRef = useRef(false)
  const measureStartRef = useRef<{ latlng: L.LatLng; name: string; branchId: string } | null>(null)
  const measureLineRef = useRef<L.Polyline | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [measureStep, setMeasureStep] = useState<"first" | "second">("first")
  const [measureResult, setMeasureResult] = useState<{ fromId: string; from: string; toId: string; to: string; km: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState<BranchDistanceMeasurement[]>([])
  const [savedLoading, setSavedLoading] = useState(true)
  const located = branches.filter(
    (b): b is OrganizationBranch & { latitude: number; longitude: number } => b.latitude != null && b.longitude != null,
  )
  // A stable key so the map only re-renders when WHICH branches/coordinates
  // are located actually changes, not on every unrelated re-render of this
  // page (branches is a fresh array reference most renders).
  const locatedKey = located.map(b => `${b.branchId}:${b.latitude}:${b.longitude}`).join("|")

  // The whole wrapper (toolbar included) goes fullscreen together -- see
  // toggleFullscreen()'s own comment in lib/maps.ts. Leaflet caches its
  // container's pixel size, so it needs an explicit resize nudge once the
  // fullscreen transition actually finishes.
  useEffect(() => {
    function handleChange() {
      setIsFullscreen(document.fullscreenElement === wrapperRef.current)
      window.setTimeout(() => { mapRef.current?.invalidateSize() }, 60)
    }
    document.addEventListener("fullscreenchange", handleChange)
    return () => document.removeEventListener("fullscreenchange", handleChange)
  }, [])

  const loadSaved = useCallback(async () => {
    setSavedLoading(true)
    try {
      setSaved(await listBranchDistanceMeasurements(organizationId))
    } catch {
      // Non-critical -- the map and live measuring still work without this.
    } finally {
      setSavedLoading(false)
    }
  }, [organizationId])

  useEffect(() => { void loadSaved() }, [loadSaved])

  useEffect(() => { measuringRef.current = measuring }, [measuring])

  useEffect(() => {
    if (!mapDivRef.current || located.length === 0) return
    setTilesLoading(true)
    const bounds = L.latLngBounds(located.map((b): L.LatLngTuple => [b.latitude, b.longitude]))
    const map = L.map(mapDivRef.current, { attributionControl: true, zoomSnap: 0.5, wheelPxPerZoomLevel: 90 })
    if (located.length > 1) { map.fitBounds(bounds.pad(0.25)) } else { map.setView(bounds.getCenter(), 14) }
    const streetLayer = L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map)
    streetLayer.once("load", () => setTilesLoading(false)) // fires once every currently-visible tile has actually loaded in
    addBaseLayerToggle(map, streetLayer, t("organization.mapLayerMap"), t("organization.mapLayerSatellite"))
    L.control.scale({ imperial: false }).addTo(map)
    for (const b of located) {
      const marker = L.marker([b.latitude, b.longitude], { icon: PHARMACY_ICON }).addTo(map).bindTooltip(b.name)
      marker.on("click", () => {
        if (!measuringRef.current) return
        const latlng = marker.getLatLng()
        const start = measureStartRef.current
        if (!start) {
          measureStartRef.current = { latlng, name: b.name, branchId: b.branchId }
          setMeasureStep("second")
          return
        }
        if (start.branchId === b.branchId) return
        const km = haversineKm(start.latlng.lat, start.latlng.lng, latlng.lat, latlng.lng)
        if (measureLineRef.current) map.removeLayer(measureLineRef.current)
        const line = L.polyline([start.latlng, latlng], { color: "#1e5fa8", weight: 3, dashArray: "6 6" }).addTo(map)
        line.bindTooltip(formatDistance(km, t), { permanent: true, direction: "center", className: "measure-distance-label" }).openTooltip()
        measureLineRef.current = line
        setMeasureResult({ fromId: start.branchId, from: start.name, toId: b.branchId, to: b.name, km })
        setSaveError(null)
        measureStartRef.current = null
        setMeasureStep("first")
      })
    }
    mapRef.current = map
    boundsRef.current = bounds
    return () => { map.remove(); mapRef.current = null; measureLineRef.current = null; boundsRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locatedKey])

  function fitAll() {
    if (!mapRef.current || !boundsRef.current) return
    if (located.length > 1) mapRef.current.flyToBounds(boundsRef.current.pad(0.25), { duration: 0.8 })
    else mapRef.current.flyTo(boundsRef.current.getCenter(), 14, { duration: 0.8 })
  }

  function toggleMeasure() {
    if (!measuring) {
      if (measureLineRef.current && mapRef.current) { mapRef.current.removeLayer(measureLineRef.current); measureLineRef.current = null }
      setMeasureResult(null)
      setSaveError(null)
      measureStartRef.current = null
      setMeasureStep("first")
      setMeasuring(true)
    } else {
      measureStartRef.current = null
      setMeasureStep("first")
      setMeasuring(false)
    }
  }

  async function saveMeasurement() {
    if (!measureResult) return
    setSaving(true)
    setSaveError(null)
    try {
      await saveBranchDistanceMeasurement(organizationId, measureResult.fromId, measureResult.toId, measureResult.km)
      setMeasureResult(null)
      await loadSaved()
    } catch (reason) {
      setSaveError(errorMessage(reason, t("organization.mapMeasureSaveError")))
    } finally {
      setSaving(false)
    }
  }

  async function removeSaved(id: string) {
    setSaved(prev => prev.filter(m => m.id !== id))
    try {
      await deleteBranchDistanceMeasurement(id)
    } catch {
      void loadSaved()
    }
  }

  if (located.length === 0) {
    return (
      <Card>
        <CardHeader icon="🗺️" title={t("organization.branchesMapTitle")} subtitle={t("organization.branchesMapSubtitle")} />
        <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)", textAlign: "center", padding: "16px 0" }}>{t("organization.branchesMapEmpty")}</p>
      </Card>
    )
  }

  return (
    <Card>
      <div ref={wrapperRef} style={isFullscreen ? { background: "var(--surface)", padding: 16, display: "flex", flexDirection: "column", height: "100vh", boxSizing: "border-box" } : undefined}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <CardHeader icon="🗺️" title={t("organization.branchesMapTitle")} subtitle={t("organization.branchesMapSubtitle")} />
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              title={t("organization.mapRecenter")}
              onClick={fitAll}
              style={{
                width: 26, height: 26, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                border: "1px solid var(--border)", background: "var(--surface)", color: "var(--ink-mid)", cursor: "pointer", fontSize: 13,
              }}
            >⌖</button>
            <button
              type="button"
              title={isFullscreen ? t("organization.mapExitFullscreen") : t("organization.mapFullscreen")}
              onClick={() => { setFullscreenError(null); if (wrapperRef.current) toggleFullscreen(wrapperRef.current, setFullscreenError) }}
              style={{
                width: 26, height: 26, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                border: "1px solid var(--border)", background: "var(--surface)", color: "var(--ink-mid)", cursor: "pointer", fontSize: 12,
              }}
            >{isFullscreen ? "⤡" : "⤢"}</button>
          </div>
        </div>
        {fullscreenError && <p style={{ margin: "8px 0 0", fontSize: 11, color: "#b45309" }}>{fullscreenError}</p>}
        <div className="animate-fade-in" style={{ position: "relative", width: "100%", height: isFullscreen ? "100%" : 240, flex: isFullscreen ? 1 : undefined, borderRadius: 10, overflow: "hidden", background: "var(--bg)", marginTop: 10 }}>
          <div ref={mapDivRef} style={{ width: "100%", height: "100%" }} />
          {tilesLoading && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "var(--bg)", fontSize: 12, color: "var(--ink-muted)", pointerEvents: "none" }}>
              <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--primary)", animation: "psync-spin 0.8s linear infinite" }} />
              {t("organization.mapLoadingTiles")}
            </div>
          )}
        </div>
      </div>

      {/* Below the map, not floating on top of it -- an overlay button here
          used to sit in the same corner as Leaflet's own zoom control and
          fought with it for space. */}
      {located.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <button type="button" onClick={toggleMeasure} className={`map-measure-btn-inline${measuring ? " is-active" : ""}`}>
            📏 {t("organization.mapMeasureButton")}
          </button>
          {measuring && (
            <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>
              {t(measureStep === "first" ? "organization.mapMeasureHintFirst" : "organization.mapMeasureHintSecond")}
            </span>
          )}
        </div>
      )}

      {measureResult && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
            📏 {t("organization.mapMeasureResult", { from: measureResult.from, to: measureResult.to, km: formatDistance(measureResult.km, t) })}
          </p>
          <Btn variant="secondary" small onClick={() => { if (!saving) void saveMeasurement() }}>
            💾 {saving ? t("organization.mapMeasureSaving") : t("organization.mapMeasureSave")}
          </Btn>
        </div>
      )}
      {saveError && <p style={{ margin: "6px 0 0", fontSize: 11, color: "#dc2626" }}>{saveError}</p>}

      {!savedLoading && saved.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {t("organization.mapSavedMeasurementsTitle")}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {saved.map(m => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                <span style={{ color: "var(--ink)" }}>
                  {m.branchAName} ↔ {m.branchBName}: <strong>{formatDistance(m.distanceKm, t)}</strong>
                </span>
                <button type="button" onClick={() => void removeSaved(m.id)} title={t("organization.mapMeasureDelete")}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-faint)", fontSize: 14, lineHeight: 1, padding: 2 }}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

// Matches OverviewPage's own `heroCardStyle` -- the Dashboard tab renders
// <OverviewPage> plus these two extra cards (pending approvals, branch
// leaderboard) on the same screen, so they need the identical rounded,
// border-free, soft-shadow look or the seam between the two components
// would show.
const DASHBOARD_CARD_STYLE = { borderRadius: 20, border: "none", boxShadow: "0 6px 24px rgba(17,24,39,0.07)" } as const

function CardHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: "var(--primary-light)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{icon}</div>
      <div>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>{title}</h2>
        {subtitle && <p style={{ margin: "2px 0 0", color: "var(--ink-muted)", fontSize: 12 }}>{subtitle}</p>}
      </div>
    </div>
  )
}

const ORG_ROLE_COLORS: Record<OrgRole, { c: string; bg: string }> = {
  org_owner: { c: "#7c3aed", bg: "#ede9fe" },
  org_manager: { c: "#2563eb", bg: "#dbeafe" },
}

function OrgRoleBadge({ role }: { role: OrgRole }) {
  const { t } = useTranslation()
  const colors = ORG_ROLE_COLORS[role]
  return <StatusBadge label={t(role === "org_owner" ? "organization.roleOrgOwner" : "organization.roleOrgManager")} color={colors.c} bg={colors.bg} />
}

const BRANCH_ROLE_COLORS: Record<BranchRole, { c: string; bg: string }> = {
  owner: { c: "#7c3aed", bg: "#ede9fe" },
  manager: { c: "#2563eb", bg: "#dbeafe" },
  seller: { c: "#4b5563", bg: "#f3f4f6" },
}

// The unified Members list mixes org-level people (OrgRole) and branch-level
// staff (BranchRole) in one table -- this picks the right label/color for
// whichever kind a given row is.
function PersonRoleBadge({ scope, role }: { scope: "organization" | "branch"; role: OrgRole | BranchRole }) {
  if (scope === "organization") return <OrgRoleBadge role={role as OrgRole} />
  const colors = BRANCH_ROLE_COLORS[role as BranchRole]
  const labelKey: TranslationKey = role === "owner" ? "organization.roleBranchOwner" : role === "manager" ? "organization.roleBranchManager" : "organization.roleBranchSeller"
  return <StatusBadgeWithT labelKey={labelKey} color={colors.c} bg={colors.bg} />
}

function StatusBadgeWithT({ labelKey, color, bg }: { labelKey: TranslationKey; color: string; bg: string }) {
  const { t } = useTranslation()
  return <StatusBadge label={t(labelKey)} color={color} bg={bg} />
}

const BRANCH_STATUS_COLORS: Record<string, { c: string; bg: string }> = {
  active: { c: "#16a34a", bg: "#d1fae5" },
  locked: { c: "#dc2626", bg: "#fef2f2" },
}

// A stable color per branch (by position in the org's branch list) for the
// leaderboard's color dots and, eventually, any per-branch chart series --
// same small fixed palette idea as OverviewPage's own categorical colors,
// just keyed by branch instead of product category.
const BRANCH_DOT_PALETTE = ["#1e5fa8", "#7c3aed", "#0891b2", "#059669", "#d97706", "#db2777"]
function branchDotColor(index: number): string {
  return BRANCH_DOT_PALETTE[index % BRANCH_DOT_PALETTE.length]
}

const TRANSFER_STATUS_COLORS: Record<StockTransferStatus, { c: string; bg: string }> = {
  pending: { c: "#d97706", bg: "#fef3c7" },
  approved: { c: "#2563eb", bg: "#dbeafe" },
  in_transit: { c: "#7c3aed", bg: "#ede9fe" },
  received: { c: "#16a34a", bg: "#d1fae5" },
  rejected: { c: "#dc2626", bg: "#fef2f2" },
  cancelled: { c: "#6b7280", bg: "#f3f4f6" },
}

function TransferStatusBadge({ status }: { status: StockTransferStatus }) {
  const { t } = useTranslation()
  const colors = TRANSFER_STATUS_COLORS[status]
  return <StatusBadge label={t(`organization.transferStatus_${status}` as TranslationKey)} color={colors.c} bg={colors.bg} />
}

const NEED_STATUS_COLORS: Record<StockNeedStatus, { c: string; bg: string }> = {
  open: { c: "#d97706", bg: "#fef3c7" },
  org_review: { c: "#7c3aed", bg: "#ede9fe" },
  fulfilling: { c: "#2563eb", bg: "#dbeafe" },
  fulfilled: { c: "#16a34a", bg: "#d1fae5" },
}

function NeedStatusBadge({ status }: { status: StockNeedStatus }) {
  const { t } = useTranslation()
  const colors = NEED_STATUS_COLORS[status]
  return <StatusBadge label={t(`organization.needStatus_${status}` as TranslationKey)} color={colors.c} bg={colors.bg} />
}

const OFFER_STATUS_COLORS: Record<"pending" | "accepted" | "denied", { c: string; bg: string }> = {
  pending: { c: "#d97706", bg: "#fef3c7" },
  accepted: { c: "#16a34a", bg: "#d1fae5" },
  denied: { c: "#dc2626", bg: "#fef2f2" },
}

function OfferStatusBadge({ status }: { status: "pending" | "accepted" | "denied" }) {
  const { t } = useTranslation()
  const colors = OFFER_STATUS_COLORS[status]
  return <StatusBadge label={t(`organization.offerStatus_${status}` as TranslationKey)} color={colors.c} bg={colors.bg} />
}

// Dismissed state is per-browser only (localStorage), same reasoning every
// other purely-client-side reminder in this app uses -- it's a nudge, not a
// setting that needs to sync anywhere.
function TwoFactorNudge() {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem("psync_2fa_nudge_dismissed") === "1" } catch { return false }
  })
  if (dismissed) return null
  return (
    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 12, color: "#92400e" }}>
      <span>🔐 {t("organization.twoFactorNudge")}</span>
      <button
        onClick={() => { try { localStorage.setItem("psync_2fa_nudge_dismissed", "1") } catch { /* ignore */ } setDismissed(true) }}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#92400e", lineHeight: 1, flexShrink: 0 }}
      >×</button>
    </div>
  )
}

function CreateOrganizationCard({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation()
  const [legalName, setLegalName] = useState("")
  const [tin, setTin] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!legalName.trim()) { setError(t("organization.legalNameRequired")); return }
    setBusy(true)
    setError(null)
    try {
      await createPharmacyOrganization(legalName.trim(), tin.trim() || undefined)
      onCreated()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.createError")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader icon="🏢" title={t("organization.createTitle")} subtitle={t("organization.createSubtitle")} />
      {error && <p style={{ fontSize: 12, color: "#b91c1c", margin: "0 0 10px" }}>{error}</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }}>
        <div>
          <label style={labelStyle}>{t("organization.legalNameLabel")}</label>
          <input value={legalName} onChange={e => setLegalName(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.tinLabel")}</label>
          <input value={tin} onChange={e => setTin(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.createSubmit")}</Btn>
        </div>
      </div>
    </Card>
  )
}

function AddBranchModal({ organizationId, onClose, onCreated }: {
  organizationId: string; onClose: () => void; onCreated: (branchId: string, pharmacyName: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [location, setLocation] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim()) { setError(t("organization.branchNameRequired")); return }
    setBusy(true)
    setError(null)
    try {
      const branchId = await addBranchToOrganization(organizationId, name.trim(), phone.trim(), email.trim(), location.trim())
      onCreated(branchId, name.trim())
    } catch (reason) {
      setError(errorMessage(reason, t("organization.addBranchError")))
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.addBranchTitle")} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.addBranchIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.branchNameLabel")}</label>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.branchPhoneLabel")}</label>
          <input value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.branchEmailLabel")}</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.branchLocationLabel")}</label>
          <input value={location} onChange={e => setLocation(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.addBranchSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// Shown immediately after AddBranchModal succeeds, or from the Branches tab
// for any existing branch -- staffing isn't limited to brand-new branches
// any more. `alreadyStaffed` hides the "owner" choice (the server would
// reject it anyway -- a branch may only ever have one) and defaults the
// picker straight to "manager".
function StaffBranchModal({ branchId, branchName, alreadyStaffed, onClose, onStaffed }: {
  branchId: string; branchName: string; alreadyStaffed: boolean; onClose: () => void; onStaffed: () => void
}) {
  const { t } = useTranslation()
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<"owner" | "manager" | "seller">(alreadyStaffed ? "manager" : "owner")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const roleChoices = (alreadyStaffed ? ["manager", "seller"] : ["owner", "manager", "seller"]) as Array<"owner" | "manager" | "seller">
  const ROLE_LABEL_KEYS: Record<"owner" | "manager" | "seller", TranslationKey> = {
    owner: "organization.roleBranchOwner", manager: "organization.roleBranchManager", seller: "organization.roleBranchSeller",
  }

  async function submit() {
    if (!fullName.trim()) { setError(t("organization.usersNameRequired")); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError(t("organization.usersEmailInvalid")); return }
    if (password.length < 6) { setError(t("organization.usersPasswordTooShort")); return }
    setBusy(true)
    setError(null)
    try {
      await staffOrganizationBranch(branchId, fullName.trim(), email.trim(), password, role)
      onStaffed()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.staffBranchError")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.staffBranchTitle", { name: branchName })} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.staffBranchIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.usersFullNameLabel")}</label>
          <input value={fullName} onChange={e => setFullName(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersEmailLabel")}</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersPasswordLabel")}</label>
          <PasswordInput value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersRoleLabel")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            {roleChoices.map(r => (
              <button key={r} type="button" onClick={() => setRole(r)} style={{
                flex: 1, padding: "10px", borderRadius: 8, fontFamily: "inherit", cursor: "pointer",
                border: `1.5px solid ${role === r ? "var(--primary)" : "var(--border)"}`,
                background: role === r ? "var(--primary-light)" : "var(--surface)",
                color: role === r ? "var(--primary)" : "var(--ink-mid)", fontWeight: role === r ? 700 : 500, fontSize: 12,
              }}>{t(ROLE_LABEL_KEYS[r])}</button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.skipStaffing")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.staffBranchSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

type AssignableRole = "org_manager" | "manager" | "seller"
const ASSIGNABLE_ROLES: AssignableRole[] = ["org_manager", "manager", "seller"]
const ASSIGNABLE_ROLE_LABEL_KEYS: Record<AssignableRole, TranslationKey> = {
  org_manager: "organization.roleOrgManager", manager: "organization.roleBranchManager", seller: "organization.roleBranchSeller",
}

// One assign flow for all three roles an org_owner (or org_manager, for the
// branch-scoped two) can hand out -- org_owner itself is never a choice here,
// since ownership only ever moves via the separate Transfer Ownership
// action. The org_owner/org_manager sets a real password here, same as the
// older "Staff" button (StaffBranchModal above) already does for
// manager/seller -- the new person signs in immediately with the email and
// password they were given, no separate OTP round trip. If the email
// already belongs to an existing login, there is no password to set (they
// keep the one they have); this falls back to a plain role change via the
// existing OTP-invite RPCs' "granted" branch, which already handles exactly
// that case.
// Confirmation step for any org-level role change, in both directions.
// Shows exactly what the change will mean before it happens, since
// promoting to org_manager hands someone authority over every branch, and
// moving them back down takes it away again.
function ChangeRoleModal({ member, hasOrgManager, onClose, onConfirm }: {
  member: OrganizationPerson; hasOrgManager: boolean
  onClose: () => void; onConfirm: (role: OrgAssignableRole) => void
}) {
  const { t } = useTranslation()
  const isCurrentlyOrgManager = member.scope === "organization" && member.role === "org_manager"
  const choices: OrgAssignableRole[] = isCurrentlyOrgManager
    ? ["manager", "seller"]
    : hasOrgManager ? ["manager", "seller"] : ["org_manager", "manager", "seller"]
  const [role, setRole] = useState<OrgAssignableRole>(choices[0])
  const [busy, setBusy] = useState(false)

  const labelKey: Record<OrgAssignableRole, TranslationKey> = {
    org_manager: "organization.roleOrgManager",
    manager: "organization.roleBranchManager",
    seller: "organization.roleBranchSeller",
  }

  return (
    <Modal title={t("organization.changeRoleTitle")} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: "var(--ink-mid)" }}>
          {t("organization.changeRoleIntro", {
            name: member.fullName,
            // member.role is only ever org_manager or a branch manager here
            // (canChangeRole gates the button on exactly those), but fall
            // back rather than hand t() an undefined key if that ever widens.
            role: t(labelKey[isCurrentlyOrgManager ? "org_manager" : "manager"]),
          })}
        </p>
        <div>
          <label style={labelStyle}>{t("organization.changeRoleNewRole")}</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {choices.map(r => (
              <button key={r} type="button" onClick={() => setRole(r)} style={{
                flex: 1, minWidth: 110, padding: "10px", borderRadius: 8, fontFamily: "inherit", cursor: "pointer",
                border: `1.5px solid ${role === r ? "var(--primary)" : "var(--border)"}`,
                background: role === r ? "var(--primary-light)" : "var(--surface)",
                color: role === r ? "var(--primary)" : "var(--ink-mid)", fontWeight: role === r ? 700 : 500, fontSize: 12,
              }}>{t(labelKey[r])}</button>
            ))}
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-faint)", lineHeight: 1.6 }}>
          {role === "org_manager" ? t("organization.changeRoleWarnPromote") : t("organization.changeRoleWarnDemote")}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => { setBusy(true); onConfirm(role) }}>
            {busy ? t("organization.changeRoleApplying") : t("organization.changeRoleConfirm")}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function AssignRoleModal({ organizationId, branches, onClose, onDone }: {
  organizationId: string; branches: OrganizationBranch[]; onClose: () => void
  onDone: (result: "created" | "granted" | "invited") => void
}) {
  const { t } = useTranslation()
  const [email, setEmail] = useState("")
  const [fullName, setFullName] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<AssignableRole>("org_manager")
  const [branchId, setBranchId] = useState(branches[0]?.branchId ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError(t("organization.usersEmailInvalid")); return }
    if (!fullName.trim()) { setError(t("organization.usersNameRequired")); return }
    // org_manager is an org-wide grant, not tied to any specific branch --
    // no branch choice to validate for it (see the removed picker below).
    if (role !== "org_manager" && !branchId) { setError(t("organization.assignBranchRequired")); return }
    if (password.length < 6) { setError(t("organization.usersPasswordTooShort")); return }
    setBusy(true)
    setError(null)
    const trimmedEmail = email.trim()
    const trimmedName = fullName.trim()
    try {
      // org_manager is never tied to a branch as far as the org_owner is
      // concerned (no picker is shown for it), but public.users.branch_id
      // is NOT NULL by schema, so SOMETHING has to be stamped there. The
      // Edge Function can auto-pick one itself, but only once its newer
      // version is deployed -- and a deploy is a separate manual step that
      // is easy to miss, which is exactly what produced the recurring "A
      // home branch is required" error. Sending an auto-picked branch from
      // here instead reaches the identical end state (an invisible anchor
      // branch; list_branch_staff() hides org_manager holders from every
      // roster regardless) and works against BOTH the old and new deployed
      // versions, so nothing is blocked on a redeploy.
      const anchorBranchId = role === "org_manager" ? (branches[0]?.branchId ?? null) : branchId
      await staffOrganizationBranch(anchorBranchId, trimmedName, trimmedEmail, password, role)
      onDone("created")
    } catch (reason) {
      if (errorMessage(reason, "") === "This email is already in use") {
        // Not a new person -- they already have a login (and a password) of
        // their own. Fall back to a pure role change; no password involved.
        try {
          const result = role === "org_manager"
            ? await inviteOrganizationMember(organizationId, trimmedEmail, trimmedName)
            : await assignBranchRole(organizationId, branchId, trimmedEmail, trimmedName, role)
          onDone(result)
          return
        } catch (fallbackReason) {
          setError(errorMessage(fallbackReason, t("organization.inviteMemberError")))
          setBusy(false)
          return
        }
      }
      setError(errorMessage(reason, t("organization.inviteMemberError")))
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.inviteMemberTitle")} onClose={onClose} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.inviteMemberIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.usersFullNameLabel")}</label>
          <input value={fullName} onChange={e => setFullName(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersEmailLabel")}</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersPasswordLabel")}</label>
          <PasswordInput value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} />
          <p style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ink-faint)" }}>{t("organization.assignPasswordHint")}</p>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.usersRoleLabel")}</label>
          <div style={{ display: "flex", gap: 8 }}>
            {ASSIGNABLE_ROLES.map(r => (
              <button key={r} type="button" onClick={() => setRole(r)} style={{
                flex: 1, padding: "10px", borderRadius: 8, fontFamily: "inherit", cursor: "pointer",
                border: `1.5px solid ${role === r ? "var(--primary)" : "var(--border)"}`,
                background: role === r ? "var(--primary-light)" : "var(--surface)",
                color: role === r ? "var(--primary)" : "var(--ink-mid)", fontWeight: role === r ? 700 : 500, fontSize: 12,
              }}>{t(ASSIGNABLE_ROLE_LABEL_KEYS[r])}</button>
            ))}
          </div>
        </div>
        {role === "org_manager" ? (
          <p style={{ margin: 0, fontSize: 10, color: "var(--ink-faint)" }}>{t("organization.homeBranchHint")}</p>
        ) : (
          <div>
            <label style={labelStyle}>{t("organization.assignBranchLabel")}</label>
            <select value={branchId} onChange={e => setBranchId(e.target.value)} style={inputStyle}>
              {branches.map(b => <option key={b.branchId} value={b.branchId}>{b.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.inviting") : t("organization.inviteMemberSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

function RequestTransferModal({ destinationBranches, onClose, onRequested }: {
  destinationBranches: BranchWithDistance[]; onClose: () => void; onRequested: () => void
}) {
  const { t } = useTranslation()
  const [toBranchId, setToBranchId] = useState(destinationBranches[0]?.branchId ?? "")
  const [notes, setNotes] = useState("")
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadInventoryDataset()
      .then(dataset => setRows(dataset.rows.filter(r => r.quantity_available > 0)))
      .catch(reason => setError(errorMessage(reason, t("organization.transferLoadStockError"))))
      .finally(() => setLoading(false))
  }, [t])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(r => r.name.toLowerCase().includes(needle) || r.batch_number.toLowerCase().includes(needle))
  }, [rows, search])

  function toggle(batchId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId); else next.add(batchId)
      return next
    })
  }

  async function submit() {
    if (!toBranchId) { setError(t("organization.transferDestinationRequired")); return }
    if (selected.size === 0) { setError(t("organization.transferNoBatchesSelected")); return }
    setBusy(true)
    setError(null)
    try {
      await requestStockTransfer(toBranchId, Array.from(selected), notes.trim() || undefined)
      onRequested()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.transferRequestError")))
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.requestTransferTitle")} onClose={onClose} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.requestTransferIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.destinationBranchLabel")}</label>
          <select value={toBranchId} onChange={e => setToBranchId(e.target.value)} style={inputStyle}>
            {destinationBranches.map(b => <option key={b.branchId} value={b.branchId}>{b.name} -- {formatDistance(b.distanceKm, t)}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.pickBatchesLabel")}</label>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("organization.pickBatchesSearchPlaceholder")} style={{ ...inputStyle, marginBottom: 8 }} />
          <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 7 }}>
            {loading ? <p style={{ padding: 12, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : filtered.length === 0 ? (
              <p style={{ padding: 12, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.transferNoStock")}</p>
            ) : filtered.map(row => (
              <label key={row.batch_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderBottom: "1px solid var(--bg-alt)", cursor: "pointer", fontSize: 12 }}>
                <input type="checkbox" checked={selected.has(row.batch_id)} onChange={() => toggle(row.batch_id)} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: "var(--ink)" }}>{row.name}</div>
                  <div style={{ color: "var(--ink-muted)", fontSize: 11 }}>{row.batch_number} · {row.quantity_available} {t("organization.transferUnitsAvailable")}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.transferNotesLabel")}</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.requestTransferSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// The pull side, opposite of RequestTransferModal above: "I'm short on X",
// not "I have spare X to send". No availability filter on the product
// picker -- the whole point is this branch may already be at zero of it.
// Unlike the old design, the requester picks ONE specific branch to ask --
// this is a targeted request, not a broadcast.
function RequestStockModal({ destinationBranches, onClose, onRequested }: {
  destinationBranches: BranchWithDistance[]; onClose: () => void; onRequested: () => void
}) {
  const { t } = useTranslation()
  const [targetBranchId, setTargetBranchId] = useState(destinationBranches[0]?.branchId ?? "")
  const [productVariantId, setProductVariantId] = useState("")
  const [rows, setRows] = useState<InventoryRow[]>([])
  const [quantity, setQuantity] = useState("")
  const [notes, setNotes] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadInventoryDataset()
      .then(dataset => setRows(dataset.rows))
      .catch(reason => setError(errorMessage(reason, t("organization.transferLoadStockError"))))
      .finally(() => setLoading(false))
  }, [t])

  const productOptions = useMemo(() => {
    const seen = new Set<string>()
    const options: Array<{ value: string; label: string }> = []
    for (const row of rows) {
      if (seen.has(row.variant_id)) continue
      seen.add(row.variant_id)
      options.push({ value: row.variant_id, label: [row.name, row.dosage].filter(Boolean).join(" ") })
    }
    return options
  }, [rows])

  async function submit() {
    if (!targetBranchId) { setError(t("organization.stockNeedBranchRequired")); return }
    if (!productVariantId) { setError(t("organization.stockNeedProductRequired")); return }
    const qty = Number(quantity)
    if (!Number.isFinite(qty) || qty < 1) { setError(t("organization.stockNeedQuantityInvalid")); return }
    setBusy(true)
    setError(null)
    try {
      await requestStockFromBranch(targetBranchId, productVariantId, qty, notes.trim() || undefined)
      onRequested()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.stockNeedRequestError")))
      setBusy(false)
    }
  }

  return (
    <Modal title={t("organization.requestStockTitle")} onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>{t("organization.requestStockIntro")}</p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.stockNeedBranchLabel")}</label>
          {/* Nearest first -- see destinationBranches' own comment in the
              parent component for how distance is computed and why an
              unknown one still sorts last rather than being hidden. */}
          <select value={targetBranchId} onChange={e => setTargetBranchId(e.target.value)} style={inputStyle}>
            {destinationBranches.map(b => <option key={b.branchId} value={b.branchId}>{b.name} -- {formatDistance(b.distanceKm, t)}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.stockNeedProductLabel")}</label>
          <select value={productVariantId} onChange={e => setProductVariantId(e.target.value)} style={inputStyle} disabled={loading}>
            <option value="">{loading ? t("organization.loading") : t("organization.stockNeedProductPlaceholder")}</option>
            {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>{t("organization.stockNeedQuantityLabel")}</label>
          <input type="number" min={1} value={quantity} onChange={e => setQuantity(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>{t("organization.transferNotesLabel")}</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.requestStockSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// Picks a DIFFERENT branch to ask, after the previous one declined --
// reuses the same targeted-request RPC (retryStockNeed) rather than
// starting a new request from scratch, so the whole negotiation history
// stays attached to the one original need.
function RetryOfferModal({ need, destinationBranches, onClose, onDone }: {
  need: StockNeed; destinationBranches: BranchWithDistance[]; onClose: () => void; onDone: () => void
}) {
  const { t } = useTranslation()
  const options = destinationBranches.filter(b => b.branchId !== need.requestingBranchId)
  const [targetBranchId, setTargetBranchId] = useState(options[0]?.branchId ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!targetBranchId) { setError(t("organization.stockNeedBranchRequired")); return }
    setBusy(true)
    setError(null)
    try {
      await retryStockNeed(need.id, targetBranchId)
      onDone()
    } catch (reason) {
      setError(errorMessage(reason, t("organization.stockNeedRequestError")))
      setBusy(false)
    }
  }

  const productLabel = [need.productName, need.dosage].filter(Boolean).join(" ")

  return (
    <Modal title={t("organization.retryOfferTitle")} onClose={onClose} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)" }}>
          {t("organization.retryOfferSubtitle", { product: productLabel, quantity: String(need.requestedQuantity) })}
        </p>
        {need.latestOfferBranchName && need.latestOfferDenialReason && (
          <p style={{ margin: 0, fontSize: 11, color: "#b91c1c" }}>
            {t("organization.retryOfferPreviousDenial", { name: need.latestOfferBranchName, reason: need.latestOfferDenialReason })}
          </p>
        )}
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}
        <div>
          <label style={labelStyle}>{t("organization.stockNeedBranchLabel")}</label>
          <select value={targetBranchId} onChange={e => setTargetBranchId(e.target.value)} style={inputStyle}>
            {options.map(b => <option key={b.branchId} value={b.branchId}>{b.name} -- {formatDistance(b.distanceKm, t)}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{t("organization.cancel")}</Btn>
          <Btn variant="primary" onClick={() => void submit()}>{busy ? t("organization.creating") : t("organization.requestStockSubmit")}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// The asked branch's own response: accept (choosing which of THEIR OWN
// batches to offer, via listBranchBatchesForVariant on their own branch --
// only they know their own stock) or deny with a required reason.
function RespondToOfferModal({ offer, currentBranchId, onClose, onDone }: {
  offer: IncomingStockOffer; currentBranchId: string; onClose: () => void; onDone: () => void
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<"choose" | "accept" | "deny">("choose")
  const [batches, setBatches] = useState<StockNeedBatch[]>([])
  const [batchesLoading, setBatchesLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function openAccept() {
    setMode("accept")
    setBatchesLoading(true)
    setError(null)
    listBranchBatchesForVariant(currentBranchId, offer.productVariantId)
      .then(setBatches)
      .catch(reason_ => setError(errorMessage(reason_, t("organization.stockNeedCandidatesLoadError"))))
      .finally(() => setBatchesLoading(false))
  }

  function toggleBatch(batchId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId); else next.add(batchId)
      return next
    })
  }

  async function submitAccept() {
    if (selected.size === 0) { setError(t("organization.transferNoBatchesSelected")); return }
    setBusy(true)
    setError(null)
    try {
      await respondToStockOffer(offer.id, true, undefined, Array.from(selected))
      onDone()
    } catch (reason_) {
      setError(errorMessage(reason_, t("organization.stockNeedRespondError")))
      setBusy(false)
    }
  }

  async function submitDeny() {
    if (!reason.trim()) { setError(t("organization.stockNeedReasonRequired")); return }
    setBusy(true)
    setError(null)
    try {
      await respondToStockOffer(offer.id, false, reason)
      onDone()
    } catch (reason_) {
      setError(errorMessage(reason_, t("organization.stockNeedRespondError")))
      setBusy(false)
    }
  }

  const productLabel = [offer.productName, offer.dosage].filter(Boolean).join(" ")

  return (
    <Modal title={t("organization.respondOfferTitle", { name: offer.requestingBranchName })} onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)" }}>
          {t("organization.respondOfferSubtitle", { product: productLabel, quantity: String(offer.requestedQuantity) })}
          {offer.notes ? ` — "${offer.notes}"` : ""}
        </p>
        {error && <p style={{ margin: 0, fontSize: 11, color: "#dc2626" }}>{error}</p>}

        {mode === "choose" && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Btn variant="danger" onClick={() => setMode("deny")}>{t("organization.stockNeedDecline")}</Btn>
            <Btn variant="primary" onClick={openAccept}>{t("organization.stockNeedAccept")}</Btn>
          </div>
        )}

        {mode === "accept" && (
          <>
            <div>
              <label style={labelStyle}>{t("organization.pickBatchesLabel")}</label>
              <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 7 }}>
                {batchesLoading ? <p style={{ padding: 12, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p>
                  : batches.length === 0 ? <p style={{ padding: 12, fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.transferNoStock")}</p>
                  : batches.map(b => (
                    <label key={b.stockBatchId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderBottom: "1px solid var(--bg-alt)", cursor: "pointer", fontSize: 12 }}>
                      <input type="checkbox" checked={selected.has(b.stockBatchId)} onChange={() => toggleBatch(b.stockBatchId)} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, color: "var(--ink)" }}>{b.batchNumber}</div>
                        <div style={{ color: "var(--ink-muted)", fontSize: 11 }}>{b.quantityAvailable} {t("organization.transferUnitsAvailable")}</div>
                      </div>
                    </label>
                  ))}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn variant="ghost" onClick={() => setMode("choose")}>{t("organization.cancel")}</Btn>
              <Btn variant="primary" onClick={() => void submitAccept()}>{busy ? t("organization.creating") : t("organization.stockNeedAcceptSubmit")}</Btn>
            </div>
          </>
        )}

        {mode === "deny" && (
          <>
            <div>
              <label style={labelStyle}>{t("organization.stockNeedRejectReasonLabel")}</label>
              <input value={reason} onChange={e => setReason(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn variant="ghost" onClick={() => setMode("choose")}>{t("organization.cancel")}</Btn>
              <Btn variant="danger" onClick={() => void submitDeny()}>{busy ? t("organization.creating") : t("organization.stockNeedDeclineSubmit")}</Btn>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function TransferRow({ transfer, currentBranchId, onAction }: {
  transfer: StockTransfer
  currentBranchId: string
  onAction: (action: "approve" | "reject" | "dispatch" | "receive" | "cancel", transfer: StockTransfer) => void
}) {
  const { t } = useTranslation()
  const isSender = transfer.fromBranchId === currentBranchId
  const isReceiver = transfer.toBranchId === currentBranchId
  const actions: Array<{ key: "approve" | "reject" | "dispatch" | "receive" | "cancel"; label: TranslationKey; variant: "primary" | "secondary" | "danger" }> = []
  if (transfer.status === "pending") {
    if (isReceiver) { actions.push({ key: "approve", label: "organization.transferApprove", variant: "primary" }, { key: "reject", label: "organization.transferReject", variant: "danger" }) }
    if (isSender) actions.push({ key: "cancel", label: "organization.transferCancel", variant: "danger" })
  } else if (transfer.status === "approved") {
    if (isSender) actions.push({ key: "dispatch", label: "organization.transferDispatch", variant: "primary" })
    if (isReceiver) actions.push({ key: "reject", label: "organization.transferReject", variant: "danger" })
  } else if (transfer.status === "in_transit" && isReceiver) {
    actions.push({ key: "receive", label: "organization.transferReceive", variant: "primary" })
  }

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--bg-alt)", gap: 12, flexWrap: "wrap" }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{transfer.fromBranchName} → {transfer.toBranchName}</div>
        <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
          {t("organization.transferBatchCount", { count: transfer.batchCount })}
          {transfer.requestedByName ? ` · ${transfer.requestedByName}` : ""}
          {transfer.notes ? ` · ${transfer.notes}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <TransferStatusBadge status={transfer.status} />
        {actions.map(a => (
          <Btn key={a.key} variant={a.variant} small onClick={() => onAction(a.key, transfer)}>{t(a.label)}</Btn>
        ))}
      </div>
    </div>
  )
}

// One row per request, from either the requester's or the org's point of
// view. What action shows, if any, depends on who's looking and where the
// negotiation currently stands:
//   * The requester, once the current ask was DENIED (status stays "open"):
//     "Try Another Branch".
//   * An org_owner/org_manager, once a branch ACCEPTED (status
//     "org_review"): "Approve" / "Reject".
//   * Once approved ("fulfilling") the linked transfer's own status is
//     shown for visibility, but advancing it (dispatch/receive) happens
//     from the regular transfer list above, not here.
function NeedRow({ need, currentBranchId, isOrgApprover, onRetry, onApprove, onReject }: {
  need: StockNeed
  currentBranchId: string
  isOrgApprover: boolean
  onRetry: (need: StockNeed) => void
  onApprove: (need: StockNeed) => void
  onReject: (need: StockNeed) => void
}) {
  const { t } = useTranslation()
  const isRequester = need.requestingBranchId === currentBranchId
  const canRetry = isRequester && need.status === "open" && need.latestOfferStatus === "denied"
  const canDecide = isOrgApprover && need.status === "org_review"

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--bg-alt)", gap: 12, flexWrap: "wrap" }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>
          {need.requestingBranchName} · {[need.productName, need.dosage].filter(Boolean).join(" ")}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
          {t("organization.stockNeedQuantity", { count: need.requestedQuantity })}
          {need.latestOfferBranchName ? ` · ${t("organization.stockNeedAsked", { name: need.latestOfferBranchName })}` : ""}
          {need.requestedByName ? ` · ${need.requestedByName}` : ""}
        </div>
        {need.latestOfferStatus === "denied" && need.latestOfferDenialReason && (
          <div style={{ fontSize: 11, color: "#b91c1c", marginTop: 2 }}>{need.latestOfferDenialReason}</div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <NeedStatusBadge status={need.status} />
        {need.latestOfferStatus && need.status !== "fulfilling" && need.status !== "fulfilled" && (
          <OfferStatusBadge status={need.latestOfferStatus} />
        )}
        {(need.status === "fulfilling" || need.status === "fulfilled") && need.transferStatus && (
          <TransferStatusBadge status={need.transferStatus as StockTransferStatus} />
        )}
        {canRetry && <Btn variant="primary" small onClick={() => onRetry(need)}>{t("organization.stockNeedRetry")}</Btn>}
        {canDecide && (
          <>
            <Btn variant="danger" small onClick={() => onReject(need)}>{t("organization.stockNeedReject")}</Btn>
            <Btn variant="primary" small onClick={() => onApprove(need)}>{t("organization.stockNeedApprove")}</Btn>
          </>
        )}
      </div>
    </div>
  )
}

// A pending ask addressed to MY branch -- shown regardless of whether I
// hold an org role, since answering "can we spare this?" is a fact only my
// own branch can supply.
function IncomingOfferRow({ offer, onRespond }: { offer: IncomingStockOffer; onRespond: (offer: IncomingStockOffer) => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--bg-alt)", gap: 12, flexWrap: "wrap" }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>
          {offer.requestingBranchName} · {[offer.productName, offer.dosage].filter(Boolean).join(" ")}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
          {t("organization.stockNeedQuantity", { count: offer.requestedQuantity })}
          {offer.notes ? ` · ${offer.notes}` : ""}
        </div>
      </div>
      <Btn variant="primary" small onClick={() => onRespond(offer)}>{t("organization.stockNeedRespond")}</Btn>
    </div>
  )
}

// Kept in sync with App.tsx's own local ORG_TABS constant, which drives the
// actual tab switcher now (see the `activeTab` prop below).
type OrgTab = "dashboard" | "transfers" | "branches" | "members" | "settings"

export default function OrganizationPage({
  currentUserId, currentBranchId, organization, myBranchOrganizationId, onOrganizationChanged, onViewBranch, activeTab, period, alerts, onViewAlerts, onGoToTransfers,
}: {
  currentUserId: string
  currentBranchId: string
  organization: OrganizationSummary | null
  // Set even without an org role, as long as the caller's own branch
  // belongs to an organization -- see getMyBranchOrganizationId()'s own
  // comment. Lets a plain branch owner/manager reach Stock Transfers (and
  // only that tab -- see App.tsx's visibleOrgTabs) to respond to a request
  // addressed to their own branch, without a real org_owner/org_manager role.
  myBranchOrganizationId: string | null
  onOrganizationChanged: () => void
  // Drills into a branch's own operational dashboard (Overview/Inventory/
  // Sales/etc.) -- this always goes through App's top-level `page` state
  // (see App.tsx), never a nested view inside this component, so the org
  // dashboard cleanly unmounts instead of stacking with the branch one.
  onViewBranch: (branch: { branchId: string; branchName: string; branchCode: string | null }) => void
  // Which of ORG_TABS is showing. Controlled by App.tsx -- while this page
  // is active, App's own sidebar IS the org-tab switcher (Dashboard/Stock
  // Transfers/Branches/Members/Settings), replacing the branch nav rather
  // than sitting alongside a second, nested tab list here. See App.tsx's
  // `orgTab` state for why this isn't owned locally.
  // The three below exist only to hand straight to <OverviewPage> for the
  // "dashboard" tab -- same values App.tsx already threads to the plain
  // sidebar Overview page, so this is the org-wide dashboard sharing the
  // exact same component and data instead of a second, duplicate one.
  period: OverviewPeriod
  alerts: LiveAlert[]
  onViewAlerts: () => void
  // Jumps the dashboard's "Pending Approvals" callout (org_manager only,
  // see the dashboard tab below) straight to the Stock Transfers tab --
  // same App.tsx-owned orgTab switch as clicking the sidebar itself.
  onGoToTransfers: () => void
  activeTab: OrgTab
}) {
  const { t } = useTranslation()
  const [branches, setBranches] = useState<OrganizationBranch[]>([])
  const [branchesLoading, setBranchesLoading] = useState(true)
  const [branchesError, setBranchesError] = useState<string | null>(null)
  const [showAddBranch, setShowAddBranch] = useState(false)
  const [staffingBranch, setStaffingBranch] = useState<{ id: string; name: string; alreadyStaffed: boolean } | null>(null)

  const [members, setMembers] = useState<OrganizationPerson[]>([])
  const [membersLoading, setMembersLoading] = useState(true)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [showInviteMember, setShowInviteMember] = useState(false)
  // Role changes go through an explicit confirmation step rather than
  // firing on the button press -- moving someone in or out of org_manager
  // changes what they can reach across every branch, which is not
  // something to do on a single stray click.
  const [changeRoleTarget, setChangeRoleTarget] = useState<OrganizationPerson | null>(null)

  const [log, setLog] = useState<RoleChangeLogEntry[]>([])
  const [logLoading, setLogLoading] = useState(true)
  const [logError, setLogError] = useState<string | null>(null)

  const [summary, setSummary] = useState<OrgBranchSummary[]>([])
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [leaderboardSortKey, setLeaderboardSortKey] = useState<"todayRevenue" | "monthToDateRevenue" | "alerts">("monthToDateRevenue")
  const [leaderboardSortAsc, setLeaderboardSortAsc] = useState(false)

  // Per-branch daily revenue, merged into one combined series for the
  // multi-branch trend chart below -- org_overview_raw()'s combined-branches
  // call doesn't tag each sale with its branch_id (see that RPC's comment),
  // so this reuses the same per-branch call the "View Branch" drill-in
  // already relies on, once per branch, rather than a new backend endpoint.
  const [branchTrend, setBranchTrend] = useState<Record<string, string | number>[]>([])
  const [branchTrendLoading, setBranchTrendLoading] = useState(true)
  const [branchTrendError, setBranchTrendError] = useState<string | null>(null)
  const [activeTrendBranches, setActiveTrendBranches] = useState<Set<string>>(new Set())

  const [myTransfers, setMyTransfers] = useState<StockTransfer[]>([])
  const [orgTransfers, setOrgTransfers] = useState<StockTransfer[]>([])
  const [transfersLoading, setTransfersLoading] = useState(true)
  const [transfersError, setTransfersError] = useState<string | null>(null)
  const [showRequestTransfer, setShowRequestTransfer] = useState(false)

  const [myNeeds, setMyNeeds] = useState<StockNeed[]>([])
  const [orgNeeds, setOrgNeeds] = useState<StockNeed[]>([])
  const [incomingOffers, setIncomingOffers] = useState<IncomingStockOffer[]>([])
  const [needsLoading, setNeedsLoading] = useState(true)
  const [needsError, setNeedsError] = useState<string | null>(null)
  const [showRequestStock, setShowRequestStock] = useState(false)
  const [retryNeedTarget, setRetryNeedTarget] = useState<StockNeed | null>(null)
  const [respondOfferTarget, setRespondOfferTarget] = useState<IncomingStockOffer | null>(null)

  const [legalName, setLegalName] = useState("")
  const [tradeName, setTradeName] = useState("")
  const [tin, setTin] = useState("")
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [successSeq, setSuccessSeq] = useState(0)
  function announce(message: string) { setSuccessMsg(message); setSuccessSeq(s => s + 1) }

  const organizationId = organization?.organizationId ?? null
  // Used ONLY for the branch list that feeds Stock Transfers' target-branch
  // pickers -- every other org-wide fetch (members, role log, branch
  // summary/trend) stays gated to the strict `organizationId` (a real
  // org_owner/org_manager role), since those RPCs require actual org
  // membership and the tabs that use them are hidden for anyone without it
  // anyway (see App.tsx's visibleOrgTabs).
  const transferOrganizationId = organizationId ?? myBranchOrganizationId
  const isOrgOwner = organization?.myRole === "org_owner"
  const isOrgManagerCaller = organization?.myRole === "org_manager"
  // Stock transfer approval is the org_manager's call specifically once one
  // exists -- the owner's role there is oversight (still sees everything
  // via notifications and this same list), not action. The owner may still
  // act while no org_manager has been appointed yet, matching
  // assert_can_approve_stock_transfer() on the backend exactly.
  const canApproveStockNeeds = isOrgManagerCaller || (isOrgOwner && !organization?.hasOrgManager)
  // Transfer destinations are every OTHER branch in the org -- a transfer
  // always moves stock away from the caller's own branch. Declared before
  // the `!organization` early return below (which also needs it) rather
  // than after, to avoid a temporal-dead-zone reference.
  //
  // Sorted nearest-first (straight-line distance from the caller's own
  // branch) once both branches have a location pin set -- see
  // src/lib/maps.ts's haversineKm(). A branch on either end without a
  // pin gets distanceKm: null and sorts to the end, never excluded -- an
  // unset location should never make a real sibling branch un-pickable, it
  // should just mean "we don't know how far away this one is." This is the
  // main real-world payoff of setting a branch's location at all: picking a
  // sensible target for a stock transfer request instead of an unsorted list.
  const myBranch = branches.find(b => b.branchId === currentBranchId)
  const destinationBranches: BranchWithDistance[] = branches
    .filter(b => b.branchId !== currentBranchId)
    .map(b => ({
      ...b,
      distanceKm:
        myBranch?.latitude != null && myBranch?.longitude != null && b.latitude != null && b.longitude != null
          ? haversineKm(myBranch.latitude, myBranch.longitude, b.latitude, b.longitude)
          : null,
    }))
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))

  useEffect(() => {
    if (organization) { setLegalName(organization.legalName); setTradeName(organization.tradeName ?? ""); setTin(organization.tin ?? "") }
  }, [organization])

  const refreshBranches = useCallback(async () => {
    if (!transferOrganizationId) return
    setBranchesLoading(true)
    setBranchesError(null)
    try {
      setBranches(await listOrganizationBranches(transferOrganizationId))
    } catch (reason) {
      setBranchesError(errorMessage(reason, t("organization.branchesLoadError")))
    } finally {
      setBranchesLoading(false)
    }
  }, [transferOrganizationId, t])

  const refreshMembers = useCallback(async () => {
    if (!organizationId) return
    setMembersLoading(true)
    setMembersError(null)
    try {
      setMembers(await listOrganizationPeople(organizationId))
    } catch (reason) {
      setMembersError(errorMessage(reason, t("organization.membersLoadError")))
    } finally {
      setMembersLoading(false)
    }
  }, [organizationId, t])

  const refreshLog = useCallback(async () => {
    if (!organizationId) return
    setLogLoading(true)
    setLogError(null)
    try {
      setLog(await listRoleChangeLog(organizationId))
    } catch (reason) {
      setLogError(errorMessage(reason, t("organization.auditLoadError")))
    } finally {
      setLogLoading(false)
    }
  }, [organizationId, t])

  const refreshSummary = useCallback(async () => {
    if (!organizationId) return
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      setSummary(await orgBranchSummary(organizationId))
    } catch (reason) {
      setSummaryError(errorMessage(reason, t("organization.dashboardLoadError")))
    } finally {
      setSummaryLoading(false)
    }
  }, [organizationId, t])

  // One loadOrgOverview() call per branch (each already scoped to a single
  // branch, the exact same call "View Branch" drill-in uses), merged into
  // one combined-by-date series -- see the branchTrend state comment above
  // for why a single combined-branches call can't produce this by itself.
  const refreshBranchTrend = useCallback(async () => {
    if (!organizationId || branches.length === 0) { setBranchTrendLoading(false); return }
    setBranchTrendLoading(true)
    setBranchTrendError(null)
    try {
      const perBranch = await Promise.all(
        branches.map(async b => ({ branch: b, data: await loadOrgOverview(period, organizationId, [b.branchId]) })),
      )
      const byLabel = new Map<string, Record<string, string | number>>()
      for (const { branch, data } of perBranch) {
        for (const point of data.revenueTrend) {
          const row = byLabel.get(point.label) ?? { label: point.label }
          row[branch.branchId] = point.revenue
          byLabel.set(point.label, row)
        }
      }
      setBranchTrend(Array.from(byLabel.values()))
    } catch (reason) {
      setBranchTrendError(errorMessage(reason, t("organization.dashboardLoadError")))
    } finally {
      setBranchTrendLoading(false)
    }
  }, [organizationId, branches, period, t])

  const refreshTransfers = useCallback(async () => {
    if (!transferOrganizationId) return
    setTransfersLoading(true)
    setTransfersError(null)
    try {
      // Same reasoning as refreshNeeds() above -- the org-wide list needs a
      // real org role; a plain branch owner/manager only ever sees their
      // own branch's transfers (sender or receiver), which needs no
      // organization id at all.
      const [mine, all] = await Promise.all([
        listBranchStockTransfers(),
        organizationId ? listOrganizationStockTransfers(organizationId) : Promise.resolve([]),
      ])
      setMyTransfers(mine)
      setOrgTransfers(all)
    } catch (reason) {
      setTransfersError(errorMessage(reason, t("organization.transferLoadError")))
    } finally {
      setTransfersLoading(false)
    }
  }, [transferOrganizationId, organizationId, t])

  const refreshNeeds = useCallback(async () => {
    if (!transferOrganizationId) return
    setNeedsLoading(true)
    setNeedsError(null)
    try {
      // The org-wide list is only for a real org_owner/org_manager
      // (list_stock_needs' own assert_org_member) -- omitted entirely for a
      // plain branch owner/manager whose branch merely belongs to an
      // organization, rather than calling it and surfacing an error for a
      // section they don't even see (isOrgOwner || isOrgManagerCaller gates
      // the "Organization Stock Requests" card itself).
      const [mine, all, incoming] = await Promise.all([
        listStockNeeds(),
        organizationId ? listStockNeeds(organizationId) : Promise.resolve([]),
        listIncomingStockOffers(),
      ])
      setMyNeeds(mine)
      setOrgNeeds(all)
      setIncomingOffers(incoming)
    } catch (reason) {
      setNeedsError(errorMessage(reason, t("organization.stockNeedLoadError")))
    } finally {
      setNeedsLoading(false)
    }
  }, [transferOrganizationId, organizationId, t])

  useEffect(() => { void refreshBranches() }, [refreshBranches])
  useEffect(() => { void refreshMembers() }, [refreshMembers])
  useEffect(() => { void refreshLog() }, [refreshLog])
  useEffect(() => { void refreshSummary() }, [refreshSummary])
  useEffect(() => { void refreshBranchTrend() }, [refreshBranchTrend])
  useEffect(() => { void refreshTransfers() }, [refreshTransfers])
  useEffect(() => { void refreshNeeds() }, [refreshNeeds])

  // Every branch starts visible on the trend chart -- click a chip to hide
  // one, same toggle-to-compare interaction as the org-portal spec's
  // reference design. Re-defaults whenever the branch roster itself changes
  // (a branch added/removed), not on every trend refresh.
  useEffect(() => {
    setActiveTrendBranches(new Set(branches.map(b => b.branchId)))
  }, [branches])

  async function handleRemoveMember(member: OrganizationPerson) {
    if (!organizationId) return
    try {
      await removeOrganizationMember(organizationId, member.userId)
      void refreshMembers()
      void refreshLog()
    } catch (reason) {
      setMembersError(errorMessage(reason, t("organization.removeMemberError")))
    }
  }

  // Offboarding: deactivate immediately blocks sign-in everywhere (branch AND
  // org level); the same button reactivates once toggled off. The RPC itself
  // enforces who may act on whom (deactivating an org_manager is owner-only;
  // an org_owner row can never be targeted) -- errors surface here rather
  // than being pre-computed client-side, keeping this simple.
  async function handleToggleActive(member: OrganizationPerson) {
    if (!organizationId) return
    try {
      await setPersonActive(organizationId, member.userId, !member.isActive)
      void refreshMembers()
    } catch (reason) {
      setMembersError(errorMessage(reason, t("organization.togglePersonActiveError")))
    }
  }

  // One-click role transfer: takes an existing branch manager straight to
  // org_manager, no re-typing their email into the generic Assign modal.
  // Goes through the exact same RPC (invite_organization_member) as that
  // modal's "email already in use" fallback -- this is just a direct,
  // discoverable front door to it. Their branch_id/role are left completely
  // untouched (see 2026-09-15_org_manager_not_tied_to_branch.sql) -- they
  // simply stop being surfaced as that branch's staff from this point on;
  // the branch itself, and all its data, is unaffected and ready for the
  // org_owner to staff with someone new whenever they choose.
  // onOrganizationChanged() refreshes App.tsx's own top-level `organization`
  // state (specifically hasOrgManager) so the acting org_owner's OWN nav
  // reacts immediately -- refreshMembers()/refreshBranches() alone only
  // update this page's local lists, not that shared state.
  async function handleChangeMemberRole(member: OrganizationPerson, newRole: OrgAssignableRole) {
    if (!organizationId) return
    try {
      await changeOrganizationMemberRole(organizationId, member.userId, newRole)
      announce(t("organization.roleChanged", { name: member.fullName }))
      setChangeRoleTarget(null)
      void refreshMembers()
      void refreshBranches()
      void refreshLog()
      onOrganizationChanged()
    } catch (reason) {
      setMembersError(errorMessage(reason, t("organization.changeRoleError")))
    }
  }

  async function handleTransferAction(action: "approve" | "reject" | "dispatch" | "receive" | "cancel", transfer: StockTransfer) {
    try {
      if (action === "approve") await approveStockTransfer(transfer.id)
      else if (action === "reject") await rejectStockTransfer(transfer.id)
      else if (action === "dispatch") await dispatchStockTransfer(transfer.id)
      else if (action === "receive") await receiveStockTransfer(transfer.id)
      else await cancelStockTransfer(transfer.id)
      void refreshTransfers()
    } catch (reason) {
      setTransfersError(errorMessage(reason, t("organization.transferActionError")))
    }
  }

  async function handleApproveNeed(need: StockNeed) {
    try {
      await approveStockNeed(need.id)
      announce(t("organization.stockNeedApproved"))
      void refreshNeeds()
      void refreshTransfers()
    } catch (reason) {
      setNeedsError(errorMessage(reason, t("organization.stockNeedApproveError")))
    }
  }

  async function handleRejectNeed(need: StockNeed) {
    try {
      await rejectStockNeed(need.id)
      announce(t("organization.stockNeedRejected"))
      void refreshNeeds()
    } catch (reason) {
      setNeedsError(errorMessage(reason, t("organization.stockNeedRejectError")))
    }
  }

  async function handleSaveSettings() {
    if (!organizationId) return
    if (!legalName.trim()) { setSettingsError(t("organization.legalNameRequired")); return }
    setSavingSettings(true)
    setSettingsError(null)
    try {
      await updateOrganizationDetails(organizationId, legalName.trim(), tradeName.trim() || undefined, tin.trim() || undefined)
      announce(t("organization.settingsSaved"))
      onOrganizationChanged()
    } catch (reason) {
      setSettingsError(errorMessage(reason, t("organization.settingsSaveError")))
    } finally {
      setSavingSettings(false)
    }
  }

  if (!organization) {
    // Two different reasons a caller can have no org_owner/org_manager role:
    // a genuine standalone branch owner (myBranchOrganizationId also null --
    // offer to found an organization), or a plain branch owner/manager whose
    // branch already belongs to one (App.tsx forces activeTab to "transfers"
    // and hides every other tab for them -- see visibleOrgTabs there).
    if (!myBranchOrganizationId) {
      return (
        <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <SectionHeader title={t("page.organization")} subtitle={t("organization.subtitle")} />
          <CreateOrganizationCard onCreated={onOrganizationChanged} />
        </div>
      )
    }
    return (
      <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <SectionHeader title={t("nav.transfers" as TranslationKey)} subtitle={t("organization.transfersSubtitle")} />
        {incomingOffers.length > 0 && (
          <Card>
            <CardHeader icon="📨" title={t("organization.stockNeedsIncomingTitle")} subtitle={t("organization.stockNeedsIncomingSubtitle")} />
            {incomingOffers.map(o => <IncomingOfferRow key={o.id} offer={o} onRespond={setRespondOfferTarget} />)}
          </Card>
        )}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
            <CardHeader icon="📥" title={t("organization.stockNeedsMineTitle")} subtitle={t("organization.stockNeedsMineSubtitle")} />
            <Btn variant="primary" small onClick={() => setShowRequestStock(true)}>+ {t("organization.requestStock")}</Btn>
          </div>
          {needsError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{needsError}</p>}
          {needsLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : myNeeds.map(n => (
            <NeedRow key={n.id} need={n} currentBranchId={currentBranchId} isOrgApprover={false} onRetry={setRetryNeedTarget} onApprove={() => undefined} onReject={() => undefined} />
          ))}
          {!needsLoading && myNeeds.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.stockNeedsEmpty")}</p>}
        </Card>
        <Card>
          <CardHeader icon="🔁" title={t("organization.transfersMineTitle")} subtitle={t("organization.transfersSubtitle")} />
          {transfersError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{transfersError}</p>}
          {transfersLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : myTransfers.map(tr => (
            <TransferRow key={tr.id} transfer={tr} currentBranchId={currentBranchId} onAction={handleTransferAction} />
          ))}
          {!transfersLoading && myTransfers.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.transfersEmpty")}</p>}
        </Card>
        <Btn variant="secondary" small onClick={() => setShowRequestTransfer(true)}>+ {t("organization.requestTransfer")}</Btn>

        {showRequestStock && (
          <RequestStockModal
            destinationBranches={destinationBranches}
            onClose={() => setShowRequestStock(false)}
            onRequested={() => { setShowRequestStock(false); announce(t("organization.stockRequested")); void refreshNeeds() }}
          />
        )}
        {retryNeedTarget && (
          <RetryOfferModal
            need={retryNeedTarget}
            destinationBranches={destinationBranches}
            onClose={() => setRetryNeedTarget(null)}
            onDone={() => { setRetryNeedTarget(null); announce(t("organization.stockRequested")); void refreshNeeds() }}
          />
        )}
        {respondOfferTarget && (
          <RespondToOfferModal
            offer={respondOfferTarget}
            currentBranchId={currentBranchId}
            onClose={() => setRespondOfferTarget(null)}
            onDone={() => { setRespondOfferTarget(null); announce(t("organization.stockNeedResolved")); void refreshNeeds() }}
          />
        )}
        {showRequestTransfer && (
          <RequestTransferModal
            destinationBranches={destinationBranches}
            onClose={() => setShowRequestTransfer(false)}
            onRequested={() => { setShowRequestTransfer(false); announce(t("organization.transferRequested")); void refreshTransfers() }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {successMsg && <CenterAlert key={successSeq} message={successMsg} tone="success" />}
      {/* The Dashboard tab renders the same rich Overview dashboard used by
          the plain sidebar Overview page (org-wide by default, with its own
          toolbar) -- this generic header would just sit above it redundantly,
          so it's skipped only for that one tab. Every other tab keeps it. */}
      {activeTab !== "dashboard" && <SectionHeader title={t("page.organization")} subtitle={t("organization.subtitle")} />}
      {isOrgOwner && <TwoFactorNudge />}

      {/* App.tsx's own sidebar IS the org-tab switcher while this page is
          active (Dashboard/Stock Transfers/Branches/Members/Settings) --
          see `activeTab` prop -- so there's no second, nested tab list here
          any more; this is just the selected tab's content. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {activeTab === "dashboard" && (
            <>
              {/* org_manager only: approving transfers is core to that role
                  (the org spec's own wording) but they can't restructure the
                  company, so their dashboard promotes what needs THEIR
                  action above the company-wide leaderboard -- an org_owner's
                  dashboard leads with the leaderboard instead (see below),
                  reading as a company-wide command center rather than a
                  to-do list. This is the visual difference between the two
                  roles' otherwise-identical dashboard tab. */}
              {isOrgManagerCaller && !transfersLoading && orgTransfers.some(tr => tr.status === "pending") && (
                <Card style={DASHBOARD_CARD_STYLE}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: "#fef3c7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>⏳</div>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>
                          {t("organization.pendingApprovalsCount", { count: orgTransfers.filter(tr => tr.status === "pending").length })}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.pendingApprovalsSubtitle")}</div>
                      </div>
                    </div>
                    <Btn variant="primary" small onClick={onGoToTransfers}>{t("organization.pendingApprovalsAction")}</Btn>
                  </div>
                </Card>
              )}

              {/* The org-wide dashboard -- same component, same data source
                  as the plain sidebar Overview page, just always given
                  `organization`+`branches` here so it defaults to "All
                  branches" combined with a picker to narrow to one. Visiting
                  one specific branch's full operational suite (not just this
                  dashboard) is the separate "View Branch" action below. */}
              <OverviewPage
                period={period}
                branchName={organization.legalName}
                alerts={alerts}
                onViewAlerts={onViewAlerts}
                organization={organization}
                branches={branches}
              />

              {/* Combined revenue trend across every branch, one line each,
                  toggleable -- the per-org-spec chart OverviewPage's own
                  single aggregate line can't show (see branchTrend state
                  comment above for why this needs its own per-branch calls).
                  Only worth showing once there's more than one branch to
                  actually compare. */}
              {branches.length > 1 && (
                <Card style={DASHBOARD_CARD_STYLE}>
                  <CardHeader icon="📈" title={t("organization.trendChartTitle")} subtitle={t("organization.trendChartSubtitle")} />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
                    {branches.map((b, i) => {
                      const active = activeTrendBranches.has(b.branchId)
                      return (
                        <button
                          key={b.branchId}
                          onClick={() => setActiveTrendBranches(prev => {
                            const next = new Set(prev)
                            if (next.has(b.branchId)) { if (next.size > 1) next.delete(b.branchId) }
                            else next.add(b.branchId)
                            return next
                          })}
                          style={{
                            display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999,
                            border: "1px solid var(--border)", background: active ? "var(--bg)" : "transparent",
                            opacity: active ? 1 : 0.4, cursor: "pointer", fontSize: 12, fontFamily: "inherit", color: "var(--ink)",
                          }}
                        >
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: branchDotColor(i), flexShrink: 0 }} />
                          {b.name}
                        </button>
                      )
                    })}
                  </div>
                  {branchTrendError && <p style={{ fontSize: 12, color: "#b91c1c" }}>{branchTrendError}</p>}
                  {branchTrendLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : (
                    <ResponsiveContainer width="100%" height={230}>
                      <AreaChart data={branchTrend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          {branches.map((b, i) => (
                            <linearGradient key={b.branchId} id={`gBranch-${b.branchId}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={branchDotColor(i)} stopOpacity={0.18} />
                              <stop offset="95%" stopColor={branchDotColor(i)} stopOpacity={0} />
                            </linearGradient>
                          ))}
                        </defs>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" />
                        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} minTickGap={16} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} tickFormatter={v => Math.round(Number(v)).toLocaleString()} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "var(--ink-mid)" }} />
                        {branches.map((b, i) => activeTrendBranches.has(b.branchId) && (
                          <Area key={b.branchId} type="monotone" dataKey={b.branchId} name={b.name} stroke={branchDotColor(i)} fill={`url(#gBranch-${b.branchId})`} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                        ))}
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </Card>
              )}

              {/* Revenue and stock-health bars, one per branch -- the same
                  `summary` rows the leaderboard table below reads, just
                  charted instead of tabulated. */}
              {!summaryLoading && summary.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <Card style={DASHBOARD_CARD_STYLE}>
                    <CardHeader icon="💰" title={t("organization.revenueByBranchTitle")} subtitle={t("organization.revenueByBranchSubtitle")} />
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={summary} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
                        <XAxis dataKey="branchName" tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} tickFormatter={v => Math.round(Number(v)).toLocaleString()} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "var(--ink-mid)" }} />
                        <Bar dataKey="todayRevenue" name={t("organization.dashboardColTodayRevenue")} fill="#4318ff" radius={[4, 4, 0, 0]} barSize={18} />
                        <Bar dataKey="monthToDateRevenue" name={t("organization.dashboardColMtdRevenue")} fill="#a78bfa" radius={[4, 4, 0, 0]} barSize={18} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Card>
                  <Card style={DASHBOARD_CARD_STYLE}>
                    <CardHeader icon="⚠️" title={t("organization.stockHealthByBranchTitle")} subtitle={t("organization.stockHealthByBranchSubtitle")} />
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={summary.map(s => ({ ...s, stockAlerts: s.outOfStockCount + s.lowStockCount }))} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
                        <XAxis dataKey="branchName" tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 11, fill: "var(--ink-muted)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: "var(--ink-mid)" }} />
                        <Bar dataKey="stockAlerts" name={t("organization.dashboardColStockAlerts")} fill="#f59e0b" radius={[4, 4, 0, 0]} barSize={18} />
                        <Bar dataKey="pendingTransfersIn" name={t("organization.dashboardColPendingIn")} fill="#0891b2" radius={[4, 4, 0, 0]} barSize={18} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Card>
                </div>
              )}

              {/* Branch Performance leaderboard -- click-through comparison
                  across the whole organization, sortable, with a color dot
                  per branch and a derived Healthy/Needs Attention badge
                  (alerts or pending inbound transfers). This is what makes
                  the org-level dashboards visually distinct from a single
                  branch's own Overview, which has no cross-branch table. */}
              <Card style={DASHBOARD_CARD_STYLE}>
                <CardHeader icon="📊" title={t("organization.dashboardBranchesTitle")} subtitle={t("organization.dashboardBranchesSubtitle")} />
                {summaryError && <p style={{ fontSize: 12, color: "#b91c1c", margin: "12px 0" }}>{summaryError}</p>}
                {summaryLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 12 }}>{t("organization.loading")}</p> : (
                  <div style={{ overflowX: "auto", marginTop: 12 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "var(--ink-muted)", borderBottom: "1px solid var(--border)" }}>
                          <th style={{ padding: "8px 10px", fontWeight: 600 }}>{t("organization.dashboardColBranch" as TranslationKey)}</th>
                          {([
                            ["todayRevenue", "dashboardColTodayRevenue"],
                            ["monthToDateRevenue", "dashboardColMtdRevenue"],
                            ["alerts", "dashboardColStockAlerts"],
                          ] as const).map(([key, labelKey]) => (
                            <th
                              key={key}
                              onClick={() => {
                                if (leaderboardSortKey === key) setLeaderboardSortAsc(a => !a)
                                else { setLeaderboardSortKey(key); setLeaderboardSortAsc(false) }
                              }}
                              style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right", cursor: "pointer", userSelect: "none", color: leaderboardSortKey === key ? "var(--primary)" : "var(--ink-muted)" }}
                            >
                              {t(labelKey as TranslationKey)}{leaderboardSortKey === key ? (leaderboardSortAsc ? " ↑" : " ↓") : ""}
                            </th>
                          ))}
                          <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>{t("organization.dashboardColPendingIn" as TranslationKey)}</th>
                          <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>{t("organization.dashboardColStatus" as TranslationKey)}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...summary]
                          .sort((a, b) => {
                            const val = (row: OrgBranchSummary) => leaderboardSortKey === "alerts"
                              ? row.outOfStockCount + row.lowStockCount
                              : row[leaderboardSortKey]
                            return leaderboardSortAsc ? val(a) - val(b) : val(b) - val(a)
                          })
                          .map(row => {
                            const branchIndex = branches.findIndex(b => b.branchId === row.branchId)
                            const branch = branches[branchIndex]
                            const alertCount = row.outOfStockCount + row.lowStockCount
                            const needsAttention = alertCount > 0 || row.pendingTransfersIn > 0
                            const attentionColors = needsAttention ? BRANCH_STATUS_COLORS.locked : BRANCH_STATUS_COLORS.active
                            return (
                              <tr
                                key={row.branchId}
                                onClick={() => branch && onViewBranch({ branchId: branch.branchId, branchName: branch.name, branchCode: branch.branchCode })}
                                style={{ borderBottom: "1px solid var(--bg-alt)", cursor: branch ? "pointer" : "default" }}
                              >
                                <td style={{ padding: "8px 10px", fontWeight: 600, color: "var(--ink)" }}>
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: branchDotColor(branchIndex < 0 ? 0 : branchIndex), flexShrink: 0 }} />
                                    {row.branchName}
                                  </span>
                                </td>
                                <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--font-mono)" }}>{row.todayRevenue.toLocaleString()}</td>
                                <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--font-mono)" }}>{row.monthToDateRevenue.toLocaleString()}</td>
                                <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--font-mono)", color: alertCount > 0 ? "var(--warning)" : "var(--ink-muted)" }}>{alertCount}</td>
                                <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "var(--font-mono)" }}>{row.pendingTransfersIn}</td>
                                <td style={{ padding: "8px 10px", textAlign: "right" }}>
                                  <StatusBadge label={t(needsAttention ? "organization.branchStatusAttention" : "organization.branchStatusHealthy")} color={attentionColors.c} bg={attentionColors.bg} />
                                </td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                    {summary.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.branchesEmpty")}</p>}
                  </div>
                )}
              </Card>
            </>
          )}

          {activeTab === "transfers" && (
            <>
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
                  <CardHeader icon="🔁" title={t("organization.transfersMineTitle")} subtitle={t("organization.transfersSubtitle")} />
                  <Btn variant="primary" small onClick={() => setShowRequestTransfer(true)}>+ {t("organization.requestTransfer")}</Btn>
                </div>
                {transfersError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{transfersError}</p>}
                {transfersLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : myTransfers.map(tr => (
                  <TransferRow key={tr.id} transfer={tr} currentBranchId={currentBranchId} onAction={handleTransferAction} />
                ))}
                {!transfersLoading && myTransfers.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.transfersEmpty")}</p>}
              </Card>

              <Card>
                <CardHeader icon="🏢" title={t("organization.transfersOrgTitle")} subtitle={t("organization.transfersOrgSubtitle")} />
                {!transfersLoading && orgTransfers.map(tr => (
                  <TransferRow key={tr.id} transfer={tr} currentBranchId={currentBranchId} onAction={handleTransferAction} />
                ))}
                {!transfersLoading && orgTransfers.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.transfersEmpty")}</p>}
              </Card>

              {/* Pull side: "I'm short on X" -- opposite direction from the
                  push cards above, and a real branch-to-branch negotiation
                  rather than an org_manager unilaterally picking a source.
                  Any owner/manager who reaches this tab can request or
                  respond; only an org_owner/org_manager (isOrgOwner ||
                  isOrgManagerCaller) gives the final approval. */}
              {incomingOffers.length > 0 && (
                <Card>
                  <CardHeader icon="📨" title={t("organization.stockNeedsIncomingTitle")} subtitle={t("organization.stockNeedsIncomingSubtitle")} />
                  {incomingOffers.map(o => (
                    <IncomingOfferRow key={o.id} offer={o} onRespond={setRespondOfferTarget} />
                  ))}
                </Card>
              )}

              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
                  <CardHeader icon="📥" title={t("organization.stockNeedsMineTitle")} subtitle={t("organization.stockNeedsMineSubtitle")} />
                  <Btn variant="primary" small onClick={() => setShowRequestStock(true)}>+ {t("organization.requestStock")}</Btn>
                </div>
                {needsError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{needsError}</p>}
                {needsLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : myNeeds.map(n => (
                  <NeedRow
                    key={n.id} need={n} currentBranchId={currentBranchId} isOrgApprover={canApproveStockNeeds}
                    onRetry={setRetryNeedTarget} onApprove={handleApproveNeed} onReject={handleRejectNeed}
                  />
                ))}
                {!needsLoading && myNeeds.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.stockNeedsEmpty")}</p>}
              </Card>

              {(isOrgOwner || isOrgManagerCaller) && (
                <Card>
                  <CardHeader icon="🧭" title={t("organization.stockNeedsOrgTitle")} subtitle={t("organization.stockNeedsOrgSubtitle")} />
                  {!needsLoading && orgNeeds.map(n => (
                    <NeedRow
                      key={n.id} need={n} currentBranchId={currentBranchId} isOrgApprover={canApproveStockNeeds}
                      onRetry={setRetryNeedTarget} onApprove={handleApproveNeed} onReject={handleRejectNeed}
                    />
                  ))}
                  {!needsLoading && orgNeeds.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.stockNeedsEmpty")}</p>}
                </Card>
              )}
            </>
          )}

          {activeTab === "branches" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>{t("organization.branchesTitle")}</h2>
                  <p style={{ margin: "2px 0 0", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.branchesSubtitle", { count: branches.length })}</p>
                </div>
                {isOrgOwner && <Btn variant="primary" small onClick={() => setShowAddBranch(true)}>+ {t("organization.addBranch")}</Btn>}
              </div>
              {!branchesLoading && <BranchesMiniMap branches={branches} organizationId={organization.organizationId} />}
              {branchesError && <p style={{ fontSize: 12, color: "#b91c1c" }}>{branchesError}</p>}
              {branchesLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
                  {branches.map((b, i) => {
                    const colors = BRANCH_STATUS_COLORS[b.status] ?? BRANCH_STATUS_COLORS.active
                    const row = summary.find(s => s.branchId === b.branchId)
                    const alertCount = row ? row.outOfStockCount + row.lowStockCount : null
                    const manager = members.find(m => m.scope === "branch" && m.branchId === b.branchId && (m.role === "owner" || m.role === "manager"))
                    return (
                      <Card key={b.branchId}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: branchDotColor(i), flexShrink: 0 }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</div>
                              <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{b.branchCode ?? b.address ?? "—"}</div>
                            </div>
                          </div>
                          <StatusBadge label={b.status} color={colors.c} bg={colors.bg} />
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
                          <div style={{ textAlign: "center", padding: "8px 6px", borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)" }}>
                            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{row ? row.todayRevenue.toLocaleString() : "—"}</div>
                            <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{t("organization.branchCardToday")}</div>
                          </div>
                          <div style={{ textAlign: "center", padding: "8px 6px", borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)" }}>
                            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{b.staffCount}</div>
                            <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{t("organization.branchCardStaff")}</div>
                          </div>
                          <div style={{ textAlign: "center", padding: "8px 6px", borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)" }}>
                            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13, color: alertCount ? "var(--warning)" : "var(--ink)" }}>{alertCount ?? "—"}</div>
                            <div style={{ fontSize: 10, color: "var(--ink-muted)", marginTop: 2 }}>{t("organization.branchCardAlerts")}</div>
                          </div>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 12, borderTop: "1px solid var(--bg-alt)" }}>
                          <div style={{ fontSize: 12, color: "var(--ink-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {manager ? manager.fullName : (b.staffCount > 0 ? t("organization.staffCountLabel", { count: b.staffCount }) : t("organization.noStaffYet"))}
                          </div>
                          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                            {(isOrgOwner || isOrgManagerCaller) && <Btn variant="primary" small onClick={() => onViewBranch({ branchId: b.branchId, branchName: b.name, branchCode: b.branchCode })}>{t("organization.viewBranch")}</Btn>}
                            {isOrgOwner && <Btn variant="secondary" small onClick={() => setStaffingBranch({ id: b.branchId, name: b.name, alreadyStaffed: b.staffCount > 0 })}>{t("organization.staffBranch")}</Btn>}
                          </div>
                        </div>
                      </Card>
                    )
                  })}
                </div>
              )}
              {!branchesLoading && branches.length === 0 && (
                <Card><p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12, margin: 0 }}>{t("organization.branchesEmpty")}</p></Card>
              )}
            </div>
          )}

          {activeTab === "members" && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
                <CardHeader icon="👥" title={t("organization.membersTitle")} subtitle={t("organization.membersSubtitle", { count: members.length })} />
                {(isOrgOwner || isOrgManagerCaller) && <Btn variant="primary" small onClick={() => setShowInviteMember(true)}>+ {t("organization.inviteMember")}</Btn>}
              </div>
              {membersError && <p style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>{membersError}</p>}
              {membersLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : members.map((m, i) => {
                const isSelf = m.userId === currentUserId
                const isTargetOwner = m.scope === "organization" && m.role === "org_owner"
                const isTargetOrgManager = m.scope === "organization" && m.role === "org_manager"
                // Matches org_set_user_active()'s own authorization exactly,
                // so a button never appears somewhere the click would just
                // error: deactivating an org_manager is owner-only;
                // branch_manager/sales_person can be toggled by either
                // org_owner or org_manager; org_owner can never be targeted.
                const canDeactivate = !isSelf && !isTargetOwner && (isOrgOwner || !isTargetOrgManager)
                const canManageOrgLevel = isOrgOwner && m.scope === "organization" && !isSelf && !isTargetOwner
                // Only a currently active branch manager, only while the
                // organization doesn't already have one (matches
                // invite_organization_member()'s own one-org_manager cap),
                // and only the org_owner can appoint one -- same authority
                // invite_organization_member() itself requires.
                // One control, both directions: promote a branch manager up to
                // org_manager, or move the current org_manager back down to a
                // branch role. Owner-only either way (org_change_member_role()
                // asserts the same), never on yourself or the owner's own row,
                // and promoting is only offered while the one-org_manager seat
                // is actually free.
                const canChangeRole = isOrgOwner && !isSelf && !isTargetOwner && m.isActive
                  && (isTargetOrgManager || (m.scope === "branch" && m.role === "manager" && !organization.hasOrgManager))
                return (
                  <div key={m.userId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: i === members.length - 1 ? "none" : "1px solid var(--bg-alt)", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>
                        {m.fullName}{isSelf ? ` (${t("organization.you")})` : ""}
                        {!m.isActive && <span style={{ marginLeft: 8, fontSize: 11, color: "#dc2626", fontWeight: 600 }}>{t("organization.inactiveLabel")}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{m.email ?? "—"}{m.branchName ? ` · ${m.branchName}` : ""}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <PersonRoleBadge scope={m.scope} role={m.role} />
                      {canChangeRole && (
                        <Btn variant="secondary" small onClick={() => setChangeRoleTarget(m)}>{t("organization.changeRole")}</Btn>
                      )}
                      {canDeactivate && (
                        <Btn variant={m.isActive ? "danger" : "secondary"} small onClick={() => void handleToggleActive(m)}>
                          {m.isActive ? t("organization.deactivate") : t("organization.reactivate")}
                        </Btn>
                      )}
                      {canManageOrgLevel && <Btn variant="danger" small onClick={() => void handleRemoveMember(m)}>{t("organization.remove")}</Btn>}
                    </div>
                  </div>
                )
              })}
              {!membersLoading && members.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.membersEmpty")}</p>}
            </Card>
          )}

          {activeTab === "settings" && (
            <>
              <Card>
                <CardHeader icon="🏢" title={organization.legalName} subtitle={organization.tradeName ?? undefined} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16, marginTop: 12 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("organization.tinLabel")}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginTop: 4 }}>{organization.tin ?? "—"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("organization.statusLabel")}</div>
                    <div style={{ marginTop: 4 }}><StatusBadge label={organization.status} color={organization.status === "active" ? "#16a34a" : "#dc2626"} bg={organization.status === "active" ? "#d1fae5" : "#fef2f2"} /></div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("organization.branchCountLabel")}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginTop: 4 }}>{organization.branchCount}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("organization.yourRoleLabel")}</div>
                    <div style={{ marginTop: 4 }}><OrgRoleBadge role={organization.myRole} /></div>
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader icon="⚙️" title={t("organization.settingsTitle")} subtitle={t("organization.settingsSubtitle")} />
                {settingsError && <p style={{ fontSize: 12, color: "#b91c1c", margin: "12px 0" }}>{settingsError}</p>}
                <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 420, marginTop: 12 }}>
                  <div>
                    <label style={labelStyle}>{t("organization.legalNameLabel")}</label>
                    <input value={legalName} onChange={e => setLegalName(e.target.value)} disabled={!isOrgOwner} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>{t("organization.tradeNameLabel")}</label>
                    <input value={tradeName} onChange={e => setTradeName(e.target.value)} disabled={!isOrgOwner} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>{t("organization.tinLabel")}</label>
                    <input value={tin} onChange={e => setTin(e.target.value)} disabled={!isOrgOwner} style={inputStyle} />
                  </div>
                  {isOrgOwner && (
                    <div>
                      <Btn variant="primary" onClick={() => void handleSaveSettings()}>{savingSettings ? t("organization.savingSettings") : t("organization.saveSettings")}</Btn>
                    </div>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader icon="📜" title={t("organization.auditTitle")} subtitle={t("organization.auditSubtitle")} />
                {logError && <p style={{ fontSize: 12, color: "#b91c1c", margin: "12px 0" }}>{logError}</p>}
                {logLoading ? <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>{t("organization.loading")}</p> : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left", color: "var(--ink-muted)", borderBottom: "1px solid var(--border)" }}>
                          {["auditWhen", "auditActor", "auditTarget", "auditChange", "auditAction"].map(k => (
                            <th key={k} style={{ padding: "8px 10px", fontWeight: 600 }}>{t(`organization.${k}` as TranslationKey)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {log.map(entry => (
                          <tr key={entry.id} style={{ borderBottom: "1px solid var(--bg-alt)" }}>
                            <td style={{ padding: "8px 10px", color: "var(--ink-muted)", whiteSpace: "nowrap" }}>{new Date(entry.createdAt).toLocaleString()}</td>
                            <td style={{ padding: "8px 10px" }}>{entry.actorEmail ?? "—"}</td>
                            <td style={{ padding: "8px 10px" }}>{entry.targetEmail ?? "—"}</td>
                            <td style={{ padding: "8px 10px" }}>{entry.oldRole ?? "—"} → {entry.newRole ?? "—"}</td>
                            <td style={{ padding: "8px 10px" }}>{entry.action}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {log.length === 0 && <p style={{ padding: 28, textAlign: "center", color: "var(--ink-muted)", fontSize: 12 }}>{t("organization.auditEmpty")}</p>}
                  </div>
                )}
              </Card>
            </>
          )}
      </div>

      {showAddBranch && (
        <AddBranchModal
          organizationId={organization.organizationId}
          onClose={() => setShowAddBranch(false)}
          onCreated={(branchId, pharmacyName) => {
            setShowAddBranch(false)
            void refreshBranches()
            onOrganizationChanged()
            setStaffingBranch({ id: branchId, name: pharmacyName, alreadyStaffed: false })
          }}
        />
      )}

      {staffingBranch && (
        <StaffBranchModal
          branchId={staffingBranch.id}
          branchName={staffingBranch.name}
          alreadyStaffed={staffingBranch.alreadyStaffed}
          onClose={() => setStaffingBranch(null)}
          onStaffed={() => { setStaffingBranch(null); announce(t("organization.staffBranchSuccess")); void refreshBranches(); void refreshLog() }}
        />
      )}

      {changeRoleTarget && (
        <ChangeRoleModal
          member={changeRoleTarget}
          hasOrgManager={Boolean(organization.hasOrgManager)}
          onClose={() => setChangeRoleTarget(null)}
          onConfirm={role => void handleChangeMemberRole(changeRoleTarget, role)}
        />
      )}

      {showInviteMember && (
        <AssignRoleModal
          organizationId={organization.organizationId}
          branches={branches}
          onClose={() => setShowInviteMember(false)}
          onDone={result => {
            setShowInviteMember(false)
            announce(
              result === "created" ? t("organization.assignCreated")
                : result === "granted" ? t("organization.inviteGranted")
                : t("organization.inviteSentPending"),
            )
            void refreshMembers()
            void refreshBranches()
            void refreshLog()
            // Any of the three roles this modal can grant (org_manager
            // included) can flip hasOrgManager or otherwise change what the
            // acting org_owner's OWN top-level nav should show -- see
            // handlePromoteToOrgManager's comment for why the local
            // refreshes above aren't enough on their own.
            onOrganizationChanged()
          }}
        />
      )}

      {showRequestTransfer && (
        <RequestTransferModal
          destinationBranches={destinationBranches}
          onClose={() => setShowRequestTransfer(false)}
          onRequested={() => { setShowRequestTransfer(false); announce(t("organization.transferRequested")); void refreshTransfers() }}
        />
      )}

      {showRequestStock && (
        <RequestStockModal
          destinationBranches={destinationBranches}
          onClose={() => setShowRequestStock(false)}
          onRequested={() => { setShowRequestStock(false); announce(t("organization.stockRequested")); void refreshNeeds() }}
        />
      )}

      {retryNeedTarget && (
        <RetryOfferModal
          need={retryNeedTarget}
          destinationBranches={destinationBranches}
          onClose={() => setRetryNeedTarget(null)}
          onDone={() => { setRetryNeedTarget(null); announce(t("organization.stockRequested")); void refreshNeeds() }}
        />
      )}

      {respondOfferTarget && (
        <RespondToOfferModal
          offer={respondOfferTarget}
          currentBranchId={currentBranchId}
          onClose={() => setRespondOfferTarget(null)}
          onDone={() => { setRespondOfferTarget(null); announce(t("organization.stockNeedResolved")); void refreshNeeds() }}
        />
      )}
    </div>
  )
}
